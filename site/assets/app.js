// Éditeur de détourage côté navigateur.
// Tout est calculé sur l'appareil de l'utilisateur, aucune image n'est envoyée.

const WORK_MAX = 2500;   // taille max (px, côté le plus long) de travail dans l'éditeur
const STD_MAX = 1500;    // taille max du téléchargement gratuit
const UNDO_LIMIT = 20;

const $ = (s, r = document) => r.querySelector(s);
// Textes traduits : injectés dans la page par le script de construction (tools/build-i18n.mjs).
const I18N = (() => { try { return JSON.parse(document.getElementById('i18n').textContent); } catch (_) { return {}; } })();
const t = (k, v = {}) => (I18N[k] || k).replace(/\{(\w+)\}/g, (_, n) => v[n] ?? '');
const BRAND = document.documentElement.dataset.brand || 'app';
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

const isMobile = matchMedia('(pointer: coarse)').matches || (navigator.connection && navigator.connection.saveData);

/* =================== État =================== */
const S = {
  fileName: 'image',
  fullW: 0, fullH: 0,        // taille de l'original
  W: 0, H: 0,                // taille de travail
  original: null,            // canvas : original à la taille de travail
  originalData: null,        // ImageData de l'original (taille de travail)
  adjusted: null,            // canvas : original après réglages "Améliorer"
  blurred: null,             // canvas : version floutée pour le fond "flou"
  mask: null,                // canvas : masque de base (alpha = opacité du sujet)
  maskEff: null,             // canvas : masque après lissage / contour
  autoAlpha: null,           // Uint8Array : masque d'origine produit par l'IA
  subject: null,             // canvas temporaire de composition
  view: $('#view'),
  bg: { type: 'none', color: '#ffffff', grad: null, image: null },
  shadow: false,
  tool: 'pan',
  brush: { size: 40, hard: 70 },
  ghost: true,
  refine: { feather: 0, shift: 0 },
  adj: { bright: 0, contrast: 0, sat: 0, warm: 0, sharp: 0, lo: 0, hi: 255 },
  undo: [], redo: [],
  zoom: 1, tx: 0, ty: 0,
  comparing: false,
  ready: false,
  model: isMobile ? 'isnet_quint8' : 'isnet_fp16',
};

/* =================== Utilitaires =================== */
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('is-error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3000);
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
let rafPending = false;
function requestRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; render(); });
}

/* =================== Moteur IA (Web Worker) =================== */
let worker = null;
let jobId = 0;
const jobs = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') { onEngineProgress(m); return; }
    const job = jobs.get(m.id);
    if (!job) return;
    jobs.delete(m.id);
    if (m.type === 'error') job.reject(new Error(m.message)); else job.resolve(m);
  };
  worker.onerror = (e) => {
    for (const j of jobs.values()) j.reject(new Error(e.message || 'Engine error'));
    jobs.clear();
    worker = null;
  };
  return worker;
}
function runSegmentation(model) {
  const id = ++jobId;
  const rgba = new Uint8Array(S.originalData.data); // copie, transférée au worker
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    getWorker().postMessage({ id, kind: 'segment', rgba, width: S.W, height: S.H, model }, [rgba.buffer]);
  });
}
const dl = new Map();
function onEngineProgress({ key, current, total }) {
  if (key.startsWith('fetch:')) {
    dl.set(key, [current, total]);
    let c = 0, tot = 0;
    for (const [x, y] of dl.values()) { c += x; tot += y; }
    const pct = tot ? Math.round(c / tot * 100) : 0;
    setProcessing(t('js_preparing'), pct, t('js_download_once', { a: (c / 1e6).toFixed(0), b: (tot / 1e6).toFixed(0) }));
  } else if (key === 'compute:inference') {
    setProcessing(t('js_removing'), -1, t('js_analyzing'));
  } else if (key === 'compute:mask') {
    setProcessing(t('js_removing'), -1, t('js_edges'));
  }
}
function setProcessing(title, pct, sub = '') {
  $('#processing').hidden = false;
  $('#proc-title').textContent = title;
  const f = $('#proc-fill');
  if (pct < 0) { f.classList.add('indeterminate'); f.style.width = ''; }
  else { f.classList.remove('indeterminate'); f.style.width = pct + '%'; }
  $('#proc-sub').textContent = sub;
}
function hideProcessing() { $('#processing').hidden = true; }

/* =================== Chargement d'une image =================== */
async function decodeImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (_) {
    // Repli : balise <img> (certains navigateurs / formats)
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { URL.revokeObjectURL(url); }
  }
}

async function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast(t('js_not_image'), true); return; }
  let img;
  try { img = await decodeImage(file); }
  catch (_) {
    toast(t('js_cant_read'), true);
    return;
  }
  S.fileName = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
  const iw = img.width || img.naturalWidth, ih = img.height || img.naturalHeight;
  S.fullW = iw; S.fullH = ih;
  const k = Math.min(1, WORK_MAX / Math.max(iw, ih));
  S.W = Math.max(1, Math.round(iw * k));
  S.H = Math.max(1, Math.round(ih * k));

  S.original = makeCanvas(S.W, S.H);
  const octx = S.original.getContext('2d', { willReadFrequently: true });
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(img, 0, 0, S.W, S.H);
  if (img.close) img.close();
  S.originalData = octx.getImageData(0, 0, S.W, S.H);

  S.adjusted = makeCanvas(S.W, S.H);
  S.adjusted.getContext('2d').drawImage(S.original, 0, 0);
  S.blurred = null;
  S.mask = makeCanvas(S.W, S.H);
  S.maskEff = makeCanvas(S.W, S.H);
  S.subject = makeCanvas(S.W, S.H);
  S.view.width = S.W; S.view.height = S.H;
  S.undo = []; S.redo = [];
  S.autoAlpha = null;
  S.ready = false;
  resetAdjustUI();
  resetRefineUI();
  updateUndoButtons();

  openEditor();
  fitView();
  render();
  await segment(S.model);
}

async function segment(model) {
  $('[data-action=download]').disabled = true;
  setProcessing(t('js_removing'), -1, t('js_starting'));
  const t0 = performance.now();
  try {
    let res;
    try { res = await runSegmentation(model); }
    catch (first) {
      // Repli : on relance un moteur neuf une seconde fois avant d'abandonner
      console.warn('Nouvel essai après erreur du moteur :', first);
      if (worker) { worker.terminate(); worker = null; }
      dl.clear();
      res = await runSegmentation(model);
    }
    S.autoAlpha = res.alpha;
    S.model = model;
    if (S.ready) pushUndo();
    writeAlpha(S.mask, res.alpha);
    S.ready = true;
    updateMaskEff();
    $('[data-action=download]').disabled = false;
    $('#rerun-precise').hidden = model === 'isnet_fp16';
    hideProcessing();
    render();
    const s = ((performance.now() - t0) / 1000).toFixed(1);
    toast(t('js_done', { s }));
  } catch (err) {
    console.error(err);
    hideProcessing();
    toast(t('js_failed', { e: err.message }), true);
  }
}

/* =================== Masque =================== */
function writeAlpha(canvas, alpha) {
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(canvas.width, canvas.height);
  const d = id.data;
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
    d[j] = 255; d[j + 1] = 255; d[j + 2] = 255; d[j + 3] = alpha[i];
  }
  ctx.putImageData(id, 0, 0);
}
function readAlpha(canvas) {
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  const a = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j];
  return a;
}

// Flou boîte séparable sur un tableau d'octets (rapide, O(n) quel que soit le rayon).
function boxBlur(src, w, h, r) {
  if (r < 1) return src;
  const tmp = new Uint8Array(src.length), out = new Uint8Array(src.length);
  const div = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / div;
      acc += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / div;
      acc += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x];
    }
  }
  return out;
}

function refineActive() { return S.refine.feather !== 0 || S.refine.shift !== 0; }

// Recalcule le masque effectif (lissage des bords + rétrécir / élargir le contour).
function updateMaskEff() {
  if (!S.mask) return;
  if (!refineActive()) return; // on utilise directement S.mask
  const { W, H } = S;
  const scale = Math.max(W, H) / 1000; // réglages exprimés pour une image de ~1000 px
  let a = readAlpha(S.mask);
  const sh = S.refine.shift;
  if (sh !== 0) {
    const r = Math.max(1, Math.round(Math.abs(sh) * scale));
    const b = boxBlur(boxBlur(a, W, H, r), W, H, r);
    a = new Uint8Array(b.length);
    if (sh > 0) for (let i = 0; i < b.length; i++) a[i] = Math.min(255, b[i] * 2);
    else for (let i = 0; i < b.length; i++) a[i] = Math.max(0, b[i] * 2 - 255);
  }
  const f = S.refine.feather;
  if (f > 0) {
    const r = Math.max(1, Math.round(f * scale * 0.6));
    a = boxBlur(boxBlur(a, W, H, r), W, H, r);
  }
  writeAlpha(S.maskEff, a);
}
function effectiveMask() { return refineActive() ? S.maskEff : S.mask; }

/* =================== Annuler / rétablir =================== */
function pushUndo() {
  S.undo.push(readAlpha(S.mask));
  if (S.undo.length > UNDO_LIMIT) S.undo.shift();
  S.redo = [];
  updateUndoButtons();
}
function undo() {
  if (!S.undo.length) return;
  S.redo.push(readAlpha(S.mask));
  writeAlpha(S.mask, S.undo.pop());
  updateMaskEff(); updateUndoButtons(); render();
}
function redo() {
  if (!S.redo.length) return;
  S.undo.push(readAlpha(S.mask));
  writeAlpha(S.mask, S.redo.pop());
  updateMaskEff(); updateUndoButtons(); render();
}
function updateUndoButtons() {
  $('[data-action=undo]').disabled = !S.undo.length;
  $('[data-action=redo]').disabled = !S.redo.length;
}

/* =================== Composition =================== */
function getBlurred() {
  if (S.blurred) return S.blurred;
  // Flou par réduction / agrandissement successifs : rapide et compatible partout.
  const { W, H } = S;
  let src = S.adjusted;
  for (const f of [4, 4, 3]) {
    const c = makeCanvas(Math.max(1, Math.round(src.width / f)), Math.max(1, Math.round(src.height / f)));
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, c.width, c.height);
    src = c;
  }
  const out = makeCanvas(W, H);
  const o = out.getContext('2d'); o.imageSmoothingQuality = 'high';
  o.drawImage(src, 0, 0, W, H);
  S.blurred = out;
  return out;
}

function paintBackground(ctx, w, h, forceOpaque) {
  const bg = S.bg;
  if (bg.type === 'color') { ctx.fillStyle = bg.color; ctx.fillRect(0, 0, w, h); }
  else if (bg.type === 'gradient') {
    const g = ctx.createLinearGradient(0, 0, w, h);
    bg.grad.forEach((c, i) => g.addColorStop(i / (bg.grad.length - 1), c));
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  } else if (bg.type === 'image' && bg.image) {
    const im = bg.image, k = Math.max(w / im.width, h / im.height);
    const dw = im.width * k, dh = im.height * k;
    ctx.drawImage(im, (w - dw) / 2, (h - dh) / 2, dw, dh);
  } else if (bg.type === 'blur') {
    ctx.drawImage(getBlurred(), 0, 0, w, h);
  } else if (forceOpaque) {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  }
}

// Dessine le résultat final dans ctx à la taille (w, h), éventuellement recadré (crop en coordonnées de travail).
function compose(ctx, w, h, { forceOpaque = false, crop = null, ghost = false } = {}) {
  const cx = crop ? crop.x : 0, cy = crop ? crop.y : 0;
  const cw = crop ? crop.w : S.W, ch = crop ? crop.h : S.H;
  const k = w / cw;
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  paintBackground(ctx, w, h, forceOpaque);

  // Sujet = image réglée, masquée par le masque effectif
  const sub = S.subject.getContext('2d');
  sub.globalCompositeOperation = 'source-over';
  sub.clearRect(0, 0, S.W, S.H);
  sub.drawImage(effectiveMask(), 0, 0);
  sub.globalCompositeOperation = 'source-in';
  sub.drawImage(S.adjusted, 0, 0);
  sub.globalCompositeOperation = 'source-over';

  ctx.imageSmoothingQuality = 'high';
  if (ghost) {
    ctx.globalAlpha = 0.28;
    ctx.drawImage(S.adjusted, cx, cy, cw, ch, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }
  if (S.shadow) {
    const s = Math.max(w, h) / 1000;
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 28 * s;
    ctx.shadowOffsetY = 14 * s;
  }
  ctx.drawImage(S.subject, cx, cy, cw, ch, 0, 0, w, h);
  ctx.restore();
}

function render() {
  if (!S.original) return;
  const ctx = S.view.getContext('2d');
  if (S.comparing || !S.ready) {
    ctx.clearRect(0, 0, S.W, S.H);
    ctx.drawImage(S.original, 0, 0);
    return;
  }
  const ghost = S.ghost && (S.tool === 'erase' || S.tool === 'restore');
  compose(ctx, S.W, S.H, { ghost });
}

/* =================== Réglages "Améliorer" =================== */
function applyAdjustments() {
  if (!S.originalData) return;
  const a = S.adj;
  const src = S.originalData.data;
  const out = new ImageData(S.W, S.H);
  const d = out.data;
  const lo = a.lo, hi = a.hi, lvl = 255 / Math.max(1, hi - lo);
  const br = a.bright * 0.9;
  const c = a.contrast * 1.6;
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  const sat = 1 + a.sat / 100;
  const warm = a.warm * 0.35;
  // Table de correspondance tonale (niveaux + luminosité + contraste)
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    let x = (v - lo) * lvl;
    x += br;
    x = cf * (x - 128) + 128;
    lut[v] = x;
  }
  for (let i = 0; i < d.length; i += 4) {
    let r = lut[src[i]], g = lut[src[i + 1]], b = lut[src[i + 2]];
    if (sat !== 1) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
    }
    if (warm) { r += warm; b -= warm; }
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = src[i + 3];
  }
  if (a.sharp > 0) sharpen(out, a.sharp / 100 * 1.2);
  S.adjusted.getContext('2d').putImageData(out, 0, 0);
  S.blurred = null;
  requestRender();
}
// Masque flou (unsharp mask) léger, rayon 1.
function sharpen(img, amount) {
  const { width: w, height: h, data: d } = img;
  const src = new Uint8ClampedArray(d);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const k = i + ch;
        const blur = (src[k - 4] + src[k + 4] + src[k - w * 4] + src[k + w * 4] + 4 * src[k]) / 8;
        d[k] = src[k] + amount * (src[k] - blur) * 2;
      }
    }
  }
}
const applyAdjustmentsSoon = debounce(applyAdjustments, 90);

function autoEnhance() {
  const src = S.originalData.data;
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < src.length; i += 16) { // échantillonnage 1 pixel sur 4
    hist[(0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]) | 0]++; n++;
  }
  const cut = n * 0.005;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > cut) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > cut) { hi = v; break; } }
  if (hi - lo < 40) { lo = 0; hi = 255; }
  Object.assign(S.adj, { lo: Math.min(lo, 40), hi: Math.max(hi, 215), bright: 4, contrast: 8, sat: 14, sharp: 30, warm: S.adj.warm });
  syncAdjustUI();
  applyAdjustments();
  toast(t('js_enhanced'));
}
const ADJ_KEYS = { bright: 'o-bright', contrast: 'o-contrast', sat: 'o-sat', warm: 'o-warm', sharp: 'o-sharp' };
function syncAdjustUI() {
  for (const [k, o] of Object.entries(ADJ_KEYS)) { $('#' + k).value = S.adj[k]; $('#' + o).value = S.adj[k]; }
}
function resetAdjustUI() {
  Object.assign(S.adj, { bright: 0, contrast: 0, sat: 0, warm: 0, sharp: 0, lo: 0, hi: 255 });
  syncAdjustUI();
}
function resetRefineUI() {
  S.refine.feather = 0; S.refine.shift = 0;
  $('#feather').value = 0; $('#o-feather').value = 0;
  $('#shift').value = 0; $('#o-shift').value = 0;
}

/* =================== Vue : zoom et déplacement =================== */
const stage = $('#stage');
const wrap = $('#canvas-wrap');
function applyView() {
  wrap.style.width = S.W + 'px';
  wrap.style.height = S.H + 'px';
  wrap.style.transform = `translate(${S.tx}px, ${S.ty}px) scale(${S.zoom})`;
  $('#zoom-label').textContent = Math.round(S.zoom * 100) + ' %';
  updateBrushCursorSize();
}
function fitView() {
  const r = stage.getBoundingClientRect();
  const pad = r.width < 600 ? 16 : 48;
  const z = Math.min((r.width - pad * 2) / S.W, (r.height - pad * 2 - 40) / S.H, 4);
  S.zoom = Math.max(z, 0.02);
  S.tx = (r.width - S.W * S.zoom) / 2;
  S.ty = (r.height - 40 - S.H * S.zoom) / 2;
  applyView();
}
function zoomAt(factor, cx, cy) {
  const nz = clamp(S.zoom * factor, 0.02, 12);
  const f = nz / S.zoom;
  S.tx = cx - (cx - S.tx) * f;
  S.ty = cy - (cy - S.ty) * f;
  S.zoom = nz;
  applyView();
}
function stagePoint(e) {
  const r = stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function imagePoint(e) {
  const p = stagePoint(e);
  return { x: (p.x - S.tx) / S.zoom, y: (p.y - S.ty) / S.zoom };
}

/* =================== Pinceaux =================== */
// Le rayon du pinceau est exprimé en pixels d'écran : il reste visuellement constant quel que soit le zoom.
function brushRadiusImage() { return (S.brush.size / 2) / S.zoom; }

function stampOn(ctx, x, y, r, mode) {
  const hard = S.brush.hard / 100;
  ctx.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over';
  if (hard >= 0.99) {
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  } else {
    const g = ctx.createRadialGradient(x, y, r * hard, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}
function strokeSegment(a, b, mode) {
  const r = brushRadiusImage();
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const step = Math.max(1, r * 0.25);
  const n = Math.max(1, Math.ceil(dist / step));
  const targets = [S.mask.getContext('2d')];
  if (refineActive()) targets.push(S.maskEff.getContext('2d'));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
    for (const ctx of targets) stampOn(ctx, x, y, r, mode);
  }
  requestRender();
}

const cursor = $('#brush-cursor');
function updateBrushCursorSize() {
  cursor.style.width = cursor.style.height = S.brush.size + 'px';
}
function moveBrushCursor(e) {
  const p = stagePoint(e);
  cursor.style.left = p.x + 'px';
  cursor.style.top = p.y + 'px';
}

/* =================== Interactions sur la scène =================== */
const pointers = new Map();
let drag = null;     // { kind: 'pan' | 'paint', ... }
let pinch = null;
let spaceDown = false;

function effectiveTool() { return spaceDown ? 'pan' : S.tool; }

stage.addEventListener('pointerdown', (e) => {
  if (!S.original || e.target.closest('.zoom-ctrl')) return;
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, stagePoint(e));
  if (pointers.size === 2) {
    // Début d'un pincement : on annule le trait en cours
    if (drag && drag.kind === 'paint') finishStroke();
    drag = null;
    const [p1, p2] = [...pointers.values()];
    pinch = { d: Math.hypot(p2.x - p1.x, p2.y - p1.y), cx: (p1.x + p2.x) / 2, cy: (p1.y + p2.y) / 2 };
    return;
  }
  const tool = effectiveTool();
  if (tool === 'pan' || e.button === 1 || !S.ready) {
    drag = { kind: 'pan', x: e.clientX, y: e.clientY, tx: S.tx, ty: S.ty };
    stage.classList.add('is-panning');
  } else if (e.button === 0) {
    pushUndo();
    const p = imagePoint(e);
    drag = { kind: 'paint', last: p, mode: tool };
    strokeSegment(p, p, tool);
  }
});
stage.addEventListener('pointermove', (e) => {
  if (S.tool !== 'pan') moveBrushCursor(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, stagePoint(e));
  if (pinch && pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
    S.tx += cx - pinch.cx; S.ty += cy - pinch.cy;
    zoomAt(d / pinch.d, cx, cy);
    pinch = { d, cx, cy };
    return;
  }
  if (!drag) return;
  if (drag.kind === 'pan') {
    S.tx = drag.tx + (e.clientX - drag.x);
    S.ty = drag.ty + (e.clientY - drag.y);
    applyView();
  } else {
    const p = imagePoint(e);
    strokeSegment(drag.last, p, drag.mode);
    drag.last = p;
  }
});
function finishStroke() {
  if (refineActive()) updateMaskEff();
  requestRender();
}
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (drag && drag.kind === 'paint') finishStroke();
  drag = null;
  stage.classList.remove('is-panning');
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('pointerenter', () => { if (S.tool !== 'pan') cursor.hidden = false; });
stage.addEventListener('pointerleave', () => { cursor.hidden = true; });
stage.addEventListener('wheel', (e) => {
  if (!S.original) return;
  e.preventDefault();
  const p = stagePoint(e);
  if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
  } else {
    S.tx -= e.deltaX; S.ty -= e.deltaY; applyView();
  }
}, { passive: false });

function setTool(t) {
  S.tool = t;
  $$('.tool').forEach(b => {
    const on = b.dataset.tool === t;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', on);
  });
  stage.classList.toggle('tool-pan', t === 'pan');
  stage.classList.toggle('tool-brush', t !== 'pan');
  cursor.classList.toggle('restore', t === 'restore');
  if (t === 'pan') cursor.hidden = true;
  requestRender();
}

/* =================== Fonds =================== */
const COLORS = ['#ffffff', '#000000', '#f2f2f2', '#9aa1a9', '#ffd8cc', '#ffe58f', '#c9f2d7', '#c8e6ff', '#e4d4ff', '#ff5a36', '#1f6feb'];
const GRADIENTS = [
  ['#ffecd2', '#fcb69f'], ['#a1c4fd', '#c2e9fb'], ['#d4fc79', '#96e6a1'],
  ['#fbc2eb', '#a6c1ee'], ['#232526', '#414345'], ['#ff9a8b', '#ff6a88', '#ff99ac'],
];
function buildSwatches() {
  const sw = $('#swatches');
  const none = document.createElement('button');
  none.className = 'swatch swatch-none is-active';
  none.title = t('bg_transparent'); none.setAttribute('aria-label', t('bg_transparent'));
  none.onclick = () => setBg({ type: 'none' }, none);
  sw.append(none);
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch'; b.style.background = c; b.title = c; b.setAttribute('aria-label', c);
    b.onclick = () => setBg({ type: 'color', color: c }, b);
    sw.append(b);
  }
  const custom = document.createElement('label');
  custom.className = 'swatch swatch-custom'; custom.title = t('bg_custom');
  const inp = document.createElement('input'); inp.type = 'color'; inp.value = '#ff5a36'; inp.setAttribute('aria-label', t('bg_custom'));
  inp.oninput = () => setBg({ type: 'color', color: inp.value }, custom);
  custom.append(inp);
  sw.append(custom);

  const gr = $('#gradients');
  for (const g of GRADIENTS) {
    const b = document.createElement('button');
    b.className = 'swatch'; b.style.background = `linear-gradient(135deg, ${g.join(',')})`;
    b.setAttribute('aria-label', t('bg_gradients'));
    b.onclick = () => setBg({ type: 'gradient', grad: g }, b);
    gr.append(b);
  }
}
function setBg(bg, el) {
  S.bg = { ...S.bg, ...bg };
  $$('.swatch, .bg-image-row .chip').forEach(x => x.classList.remove('is-active'));
  if (el) el.classList.add('is-active');
  requestRender();
}

/* =================== Export =================== */
function subjectBBox() {
  const a = readAlpha(effectiveMask());
  const { W, H } = S;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (a[row + x] > 10) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
function exportSize(crop) {
  const cw = crop ? crop.w : S.W, ch = crop ? crop.h : S.H;
  const k = Math.min(1, STD_MAX / Math.max(cw, ch));
  return { w: Math.round(cw * k), h: Math.round(ch * k) };
}
async function download(fmt, doCrop) {
  const crop = doCrop ? subjectBBox() : null;
  const { w, h } = exportSize(crop);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  compose(ctx, w, h, { forceOpaque: fmt === 'jpg', crop });
  const mime = fmt === 'jpg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
  const blob = await new Promise(r => c.toBlob(r, mime, 0.92));
  if (!blob) { toast(t('js_export_fail'), true); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${S.fileName}-${BRAND.toLowerCase()}.${fmt}`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(t('js_downloaded', { w, h }));
}
function openDownload() {
  const m = $('#dl-modal');
  updateDlInfo();
  m.showModal();
}
function updateDlInfo() {
  const fmt = $('input[name=fmt]:checked').value;
  const crop = $('#crop').checked ? subjectBBox() : null;
  const { w, h } = exportSize(crop);
  $('#dl-std-size').textContent = `${w} × ${h} px`;
  const k = crop ? S.fullW / S.W : 1;
  $('#dl-hd-size').textContent = crop
    ? t('dl_upto', { w: Math.round(crop.w * k * 4), h: Math.round(crop.h * k * 4) })
    : t('dl_upto', { w: S.fullW * 4, h: S.fullH * 4 });
  const transparent = S.bg.type === 'none';
  $('#fmt-note').textContent = fmt === 'jpg' && transparent
    ? t('dl_jpg_note')
    : transparent ? t('dl_png_note') : '';
}

/* =================== Éditeur : ouverture / fermeture =================== */
function openEditor() {
  $('#editor').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeEditor() {
  $('#editor').hidden = true;
  document.body.style.overflow = '';
  S.original = null; S.ready = false;
  hideProcessing();
}

/* =================== Branchements UI =================== */
const fileInput = $('#file-input');
function pick() { fileInput.value = ''; fileInput.click(); }
fileInput.addEventListener('change', () => loadFile(fileInput.files[0]));

const dz = $('#dropzone');
dz.addEventListener('click', pick);
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('is-over'); }));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || !e.relatedTarget) dz.classList.remove('is-over'); }));
document.addEventListener('drop', (e) => {
  const f = e.dataTransfer && [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
  if (f) loadFile(f);
});
document.addEventListener('paste', (e) => {
  const item = e.clipboardData && [...e.clipboardData.items].find(i => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const act = b.dataset.action;
  switch (act) {
    case 'pick': pick(); break;
    case 'close': closeEditor(); break;
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'download': openDownload(); break;
    case 'zoom-in': { const r = stage.getBoundingClientRect(); zoomAt(1.25, r.width / 2, r.height / 2); break; }
    case 'zoom-out': { const r = stage.getBoundingClientRect(); zoomAt(0.8, r.width / 2, r.height / 2); break; }
    case 'zoom-fit': fitView(); break;
    case 'bg-blur': setBg({ type: 'blur' }, b); break;
    case 'auto-enhance': autoEnhance(); break;
    case 'reset-enhance': resetAdjustUI(); applyAdjustments(); break;
    case 'reset-mask':
      if (S.autoAlpha) { pushUndo(); writeAlpha(S.mask, S.autoAlpha); resetRefineUI(); render(); toast(t('js_mask_reset')); }
      break;
    case 'rerun-precise': segment('isnet_fp16'); break;
    case 'hd-info': $('#hd-modal').showModal(); break;
  }
});

// Avant / après : maintenir le bouton (souris, doigt) ou la touche « B »
const cmp = $('[data-action=compare]');
const cmpOn = (e) => { e.preventDefault(); S.comparing = true; cmp.classList.add('is-on'); render(); };
const cmpOff = () => { if (!S.comparing) return; S.comparing = false; cmp.classList.remove('is-on'); render(); };
cmp.addEventListener('pointerdown', cmpOn);
cmp.addEventListener('pointerup', cmpOff);
cmp.addEventListener('pointerleave', cmpOff);
cmp.addEventListener('pointercancel', cmpOff);

// Onglets
$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => { x.classList.toggle('is-active', x === t); x.setAttribute('aria-selected', x === t); });
  $$('.tab-pane').forEach(p => { p.hidden = p.dataset.pane !== t.dataset.tab; });
  if (t.dataset.tab === 'retouch' && S.tool === 'pan') setTool('erase');
  if (t.dataset.tab !== 'retouch' && S.tool !== 'pan') setTool('pan');
}));
$$('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

// Curseurs
function bindRange(id, outId, fn) {
  const el = $('#' + id), out = $('#' + outId);
  el.addEventListener('input', () => { out.value = el.value; fn(+el.value); });
}
bindRange('brush-size', 'o-size', v => { S.brush.size = v; updateBrushCursorSize(); });
bindRange('brush-hard', 'o-hard', v => { S.brush.hard = v; });
const refineSoon = debounce(() => { updateMaskEff(); requestRender(); }, 60);
bindRange('feather', 'o-feather', v => { S.refine.feather = v; refineSoon(); });
bindRange('shift', 'o-shift', v => { S.refine.shift = v; refineSoon(); });
for (const k of Object.keys(ADJ_KEYS)) bindRange(k, ADJ_KEYS[k], v => { S.adj[k] = v; applyAdjustmentsSoon(); });
$('#ghost').addEventListener('change', (e) => { S.ghost = e.target.checked; requestRender(); });
$('#shadow').addEventListener('change', (e) => { S.shadow = e.target.checked; requestRender(); });
$('#bg-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const im = await decodeImage(f);
    setBg({ type: 'image', image: im }, e.target.closest('.chip'));
  } catch (_) { toast(t('js_bg_fail'), true); }
  e.target.value = '';
});

// Téléchargement
$('#dl-modal').addEventListener('change', updateDlInfo);
$('#dl-std').addEventListener('click', (e) => {
  e.preventDefault();
  $('#dl-modal').close();
  download($('input[name=fmt]:checked').value, $('#crop').checked);
});
$('#dl-hd').addEventListener('click', (e) => {
  e.preventDefault();
  $('#dl-modal').close();
  $('#hd-modal').showModal();
});

// Clavier
document.addEventListener('keydown', (e) => {
  if ($('#editor').hidden || e.target.matches('input:not([type=range]):not([type=checkbox]):not([type=radio]), textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.code === 'Space' && !spaceDown) { spaceDown = true; stage.classList.add('tool-pan'); e.preventDefault(); }
  else if (e.key === 'e' || e.key === 'E') setTool('erase');
  else if (e.key === 'r' || e.key === 'R') setTool('restore');
  else if (e.key === 'h' || e.key === 'H') setTool('pan');
  else if (e.key === '[') { S.brush.size = Math.max(4, S.brush.size - 6); $('#brush-size').value = S.brush.size; $('#o-size').value = S.brush.size; updateBrushCursorSize(); }
  else if (e.key === ']') { S.brush.size = Math.min(300, S.brush.size + 6); $('#brush-size').value = S.brush.size; $('#o-size').value = S.brush.size; updateBrushCursorSize(); }
  else if ((e.key === 'b' || e.key === 'B') && !e.repeat) { S.comparing = true; cmp.classList.add('is-on'); render(); }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; stage.classList.toggle('tool-pan', S.tool === 'pan'); }
  if (e.key === 'b' || e.key === 'B') cmpOff();
});
addEventListener('resize', debounce(() => { if (S.original) fitView(); }, 150));

// Menu des langues : mémorise le choix et ouvre la page de la langue
const langSel = $('#lang');
if (langSel) langSel.addEventListener('change', () => {
  const c = langSel.value;
  try { localStorage.setItem('lang', c); } catch (_) {}
  location.href = langSel.dataset.base + (c === 'en' ? '' : c + '/');
});
try { if (!localStorage.getItem('lang') && document.documentElement.lang !== 'en') localStorage.setItem('lang', document.documentElement.lang); } catch (_) {}

buildSwatches();
setTool('pan');
$('#year').textContent = new Date().getFullYear();

// Pour les tests automatisés
window.__zf = { S, loadFile };
