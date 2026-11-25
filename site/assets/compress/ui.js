// Interface des outils de compression (images et PDF).
// Le travail lourd se fait dans des Web Workers, sur l'appareil du visiteur : rien n'est envoyé.

const $ = (s, r = document) => r.querySelector(s);
const I18N = (() => { try { return JSON.parse($('#i18n').textContent); } catch (_) { return {}; } })();
const t = (k, v = {}) => (I18N[k] || k).replace(/\{(\w+)\}/g, (_, n) => v[n] ?? '');
const LANG = document.documentElement.lang || 'en';
const TOOL = document.body.dataset.tool; // 'image' ou 'pdf'
const IS_PDF = TOOL === 'pdf';

/* ---------- Petits utilitaires ---------- */
const nf1 = new Intl.NumberFormat(LANG, { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat(LANG, { maximumFractionDigits: 0 });
function fmtSize(b) {
  if (b < 1024) return `${nf0.format(b)} B`;
  if (b < 1024 * 1024) return `${nf0.format(b / 1024)} KB`;
  return `${nf1.format(b / 1024 / 1024)} MB`;
}
let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg; el.classList.toggle('is-error', isError); el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3000);
}
const EXT = { jpg: 'jpg', png: 'png', webp: 'webp', avif: 'avif', pdf: 'pdf' };
function outName(name, fmt) {
  const base = name.replace(/\.[^.]+$/, '') || 'file';
  return `${base}-min.${EXT[fmt] || 'bin'}`;
}

/* ---------- Réglages ---------- */
const settings = {
  format: 'keep', quality: 75, resize: { mode: 'none', value: 0 }, level: 'medium',
};
try { const s = JSON.parse(localStorage.getItem('compress-' + TOOL) || 'null'); if (s) Object.assign(settings, s); } catch (_) {}
const saveSettings = () => { try { localStorage.setItem('compress-' + TOOL, JSON.stringify(settings)); } catch (_) {} };

/* ---------- Moteurs (Web Workers) ---------- */
const WORKER_URL = new URL(IS_PDF ? './pdf-worker.js' : './image-worker.js', import.meta.url);
const POOL_SIZE = IS_PDF ? 1 : Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
let pool = [];
function makeWorker() {
  const w = new Worker(WORKER_URL, { type: 'module' });
  w.busy = null;
  w.onmessage = (e) => onWorkerMessage(w, e.data);
  w.onerror = (e) => { e.preventDefault(); const it = w.busy; w.busy = null; if (it) fail(it, 'failed'); pump(); };
  return w;
}
function resetPool() { pool.forEach((w) => w.terminate()); pool = []; }

/* ---------- Liste des fichiers ---------- */
let items = [];
let nextId = 1;
let generation = 0;
const list = $('#file-list');

function addFiles(files) {
  const accepted = [];
  for (const f of files) {
    const ok = IS_PDF ? (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) : (/^image\//.test(f.type) || /\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(f.name));
    if (!ok) { toast(t(IS_PDF ? 'tj_not_pdf' : 'tj_not_image', { name: f.name }), true); continue; }
    accepted.push(f);
  }
  if (!accepted.length) return;
  for (const file of accepted) {
    const it = { id: nextId++, file, status: 'waiting', gen: generation, srcUrl: IS_PDF ? null : URL.createObjectURL(file) };
    it.el = renderRow(it);
    list.appendChild(it.el);
    items.push(it);
  }
  $('#dropzone').hidden = true;
  $('#results').hidden = false;
  updateTotal();
  pump();
}

function renderRow(it) {
  const li = document.createElement('li');
  li.className = 'file-row is-waiting';
  li.innerHTML = `
    <div class="thumb">${IS_PDF ? '<span class="pdf-badge">PDF</span>' : '<img alt="" loading="lazy">'}</div>
    <div class="file-info">
      <p class="file-name"></p>
      <p class="file-meta"><span class="size-before"></span><span class="arrow" aria-hidden="true">${document.dir === 'rtl' ? '←' : '→'}</span><b class="size-after"></b><span class="gain"></span></p>
      <p class="file-note"></p>
      <div class="file-bar"><span></span></div>
    </div>
    <div class="file-actions">
      ${IS_PDF ? '' : `<button class="icon-btn btn-compare" title="${t('tj_compare')}" aria-label="${t('tj_compare')}" disabled><svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 3v18M5 6h4v12H5zM15 6h4v12h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></button>`}
      <a class="btn btn-primary btn-sm btn-dl" aria-disabled="true">${t('tj_download')}</a>
      <button class="icon-btn btn-remove" aria-label="×">×</button>
    </div>`;
  $('.file-name', li).textContent = it.file.name;
  $('.file-name', li).title = it.file.name;
  $('.size-before', li).textContent = fmtSize(it.file.size);
  $('.file-note', li).textContent = t('tj_waiting');
  if (!IS_PDF) $('.thumb img', li).src = it.srcUrl;
  $('.btn-remove', li).addEventListener('click', () => removeItem(it));
  const cmp = $('.btn-compare', li);
  if (cmp) cmp.addEventListener('click', () => openCompare(it));
  return li;
}

function setRow(it) {
  const li = it.el;
  li.className = `file-row is-${it.status}`;
  const note = $('.file-note', li), after = $('.size-after', li), gain = $('.gain', li), dl = $('.btn-dl', li), bar = $('.file-bar span', li);
  const cmp = $('.btn-compare', li);
  gain.className = 'gain';
  if (it.status === 'done') {
    const saved = it.file.size - it.blob.size;
    const pct = Math.round(saved / it.file.size * 100);
    after.textContent = fmtSize(it.blob.size);
    gain.textContent = it.kept ? '' : pct >= 0 ? `−${pct}%` : `+${-pct}%`;
    if (!it.kept && pct >= 1) gain.classList.add('is-good');
    if (!it.kept && pct < 0) gain.classList.add('is-bad');
    const notes = [];
    if (it.kept) notes.push(t('tj_kept'));
    if (it.alphaLost) notes.push(t('tj_alpha'));
    if (it.w) notes.push(`${it.w} × ${it.h} px`);
    note.textContent = notes.join(' · ');
    if (it.url) URL.revokeObjectURL(it.url);
    it.url = URL.createObjectURL(it.blob);
    dl.href = it.url;
    dl.download = it.kept ? it.file.name : outName(it.file.name, it.fmt);
    dl.removeAttribute('aria-disabled');
    if (cmp) cmp.disabled = false;
    bar.style.width = '100%';
  } else {
    after.textContent = '';
    gain.textContent = '';
    dl.removeAttribute('href');
    dl.setAttribute('aria-disabled', 'true');
    if (cmp) cmp.disabled = true;
    if (it.status === 'error') note.textContent = it.error;
    else if (it.status === 'working') note.textContent = it.progressText || t('tj_working');
    else note.textContent = t('tj_waiting');
    bar.style.width = it.status === 'working' ? `${Math.round((it.progress || 0.05) * 100)}%` : '0';
  }
}

function removeItem(it) {
  const w = pool.find((x) => x.busy === it);
  if (w) { w.terminate(); pool = pool.filter((x) => x !== w); }
  if (it.url) URL.revokeObjectURL(it.url);
  if (it.srcUrl) URL.revokeObjectURL(it.srcUrl);
  it.el.remove();
  items = items.filter((x) => x !== it);
  if (!items.length) clearAll();
  else { updateTotal(); pump(); }
}

function clearAll() {
  resetPool();
  for (const it of items) { if (it.url) URL.revokeObjectURL(it.url); if (it.srcUrl) URL.revokeObjectURL(it.srcUrl); }
  items = [];
  list.innerHTML = '';
  $('#results').hidden = true;
  $('#dropzone').hidden = false;
}

function updateTotal() {
  const done = items.filter((x) => x.status === 'done');
  const a = items.reduce((s, x) => s + x.file.size, 0);
  const b = done.reduce((s, x) => s + x.blob.size, 0) + items.filter((x) => x.status !== 'done').reduce((s, x) => s + x.file.size, 0);
  const allDone = done.length === items.length && items.length > 0;
  let txt = t('tj_total', { n: items.length, a: fmtSize(a), b: allDone ? fmtSize(b) : '…' });
  if (allDone && a > b) txt += ` · ${t('tj_saved', { pct: Math.round((a - b) / a * 100), size: fmtSize(a - b) })}`;
  $('#total').textContent = txt;
  $('[data-action="zip"]').disabled = !allDone || done.length < 2;
  $('[data-action="zip"]').hidden = items.length < 2;
}

/* ---------- File d'attente ---------- */
function pump() {
  for (;;) {
    const it = items.find((x) => x.status === 'waiting');
    if (!it) break;
    let w = pool.find((x) => !x.busy);
    if (!w) {
      if (pool.length >= POOL_SIZE) break;
      w = makeWorker(); pool.push(w);
    }
    w.busy = it;
    it.status = 'working'; it.progress = 0; it.progressText = '';
    it.gen = generation;
    setRow(it);
    if (IS_PDF) w.postMessage({ id: it.id, file: it.file, level: settings.level });
    else w.postMessage({ id: it.id, file: it.file, opts: { format: settings.format, quality: settings.quality, resize: settings.resize } });
  }
  updateTotal();
}

function onWorkerMessage(w, m) {
  const it = w.busy;
  if (!it || it.id !== m.id) return;
  if (m.stage === 'engine') { it.progressText = t('tj_engine'); setRow(it); return; }
  if (m.stage === 'work') { it.progressText = t('tj_working'); it.progress = 0.1; setRow(it); return; }
  if (m.progress != null) { it.progress = 0.1 + m.progress * 0.85; it.progressText = t('tj_page', { p: m.page, n: m.total }); setRow(it); return; }
  w.busy = null;
  if (m.ok) {
    Object.assign(it, { status: 'done', blob: m.blob, fmt: m.fmt || 'pdf', kept: m.kept, alphaLost: m.alphaLost, w: m.w, h: m.h });
    setRow(it);
  } else fail(it, m.error);
  pump();
}

function fail(it, code) {
  it.status = 'error';
  it.error = code === 'encrypted' ? t('tj_encrypted') : code === 'damaged' ? t('tj_damaged') : t('tj_error');
  setRow(it);
  updateTotal();
}

// Nouveau réglage : on relance tout ce qui est en cours ou fini.
function rerun() {
  saveSettings();
  if (!items.length) return;
  generation++;
  resetPool();
  for (const it of items) { it.status = 'waiting'; setRow(it); }
  pump();
}
let rerunTimer;
const rerunSoon = () => { clearTimeout(rerunTimer); rerunTimer = setTimeout(rerun, 350); };

/* ---------- ZIP (sans compression : les fichiers le sont déjà) ---------- */
const CRC = (() => { const tb = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; tb[n] = c >>> 0; } return tb; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
async function makeZip(entries) {
  const enc = new TextEncoder();
  const parts = []; const central = []; let offset = 0;
  const now = new Date();
  const dtime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const ddate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const used = new Set();
  for (const { name, blob } of entries) {
    let n = name, k = 1;
    while (used.has(n.toLowerCase())) n = name.replace(/(\.[^.]+)?$/, (m) => `-${k++}${m}`);
    used.add(n.toLowerCase());
    const data = new Uint8Array(await blob.arrayBuffer());
    const nameBytes = enc.encode(n);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dtime, true); lh.setUint16(12, ddate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, nameBytes, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dtime, true); ch.setUint16(14, ddate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nameBytes.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const csize = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, csize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
async function downloadZip() {
  const done = items.filter((x) => x.status === 'done');
  const zip = await makeZip(done.map((x) => ({ name: x.kept ? x.file.name : outName(x.file.name, x.fmt), blob: x.blob })));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zip);
  a.download = `${(document.documentElement.dataset.brand || 'files').toLowerCase()}-${t('tj_zip_name')}.zip`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

/* ---------- Comparaison avant / après ---------- */
function openCompare(it) {
  const dlg = $('#compare-modal');
  if (!dlg || it.status !== 'done') return;
  $('#compare-title').textContent = it.file.name;
  $('#cmp-before').src = it.srcUrl;
  $('#cmp-after').src = it.url;
  $('#cmp-tag-before').textContent = `${t('tj_before')} · ${fmtSize(it.file.size)}`;
  $('#cmp-tag-after').textContent = `${t('tj_after')} · ${fmtSize(it.blob.size)}`;
  setCompare(50);
  $('#cmp-range').value = 50;
  dlg.showModal();
}
function setCompare(v) {
  const c = $('#compare');
  c.style.setProperty('--pos', `${v}%`);
}

/* ---------- Branchements ---------- */
const fileInput = $('#file-input');
const dz = $('#dropzone');
dz.addEventListener('click', () => fileInput.click());
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
const card = $('#tool');
['dragenter', 'dragover'].forEach((ev) => card.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-over'); card.classList.add('is-over'); }));
['dragleave', 'drop'].forEach((ev) => card.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && card.contains(e.relatedTarget)) return; dz.classList.remove('is-over'); card.classList.remove('is-over'); }));
card.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]); });
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const a = b.dataset.action;
  if (a === 'add') fileInput.click();
  if (a === 'clear') clearAll();
  if (a === 'zip') downloadZip();
  if (a === 'close-compare') $('#compare-modal').close();
});
document.addEventListener('click', (e) => { const dl = e.target.closest('.btn-dl[aria-disabled]'); if (dl) e.preventDefault(); });

if (IS_PDF) {
  const r = document.querySelector(`input[name="level"][value="${settings.level}"]`);
  if (r) r.checked = true;
  document.querySelectorAll('input[name="level"]').forEach((el) => el.addEventListener('change', () => { settings.level = el.value; rerun(); }));
} else {
  const q = $('#quality'), qo = $('#q-out'), hint = $('#q-hint');
  const mode = $('#resize-mode'), val = $('#resize-value');
  const updateHint = () => {
    qo.textContent = settings.quality;
    if (settings.format === 'png') {
      const n = settings.quality >= 95 ? 0 : settings.quality >= 75 ? 256 : settings.quality >= 55 ? 128 : settings.quality >= 35 ? 64 : 32;
      hint.textContent = n ? t('tj_png_colors', { n }) : t('tj_png_lossless');
    } else hint.textContent = t('tj_lossy');
  };
  const r = document.querySelector(`input[name="fmt"][value="${settings.format}"]`);
  if (r) r.checked = true;
  q.value = settings.quality;
  mode.value = settings.resize.mode;
  val.hidden = settings.resize.mode === 'none';
  val.value = settings.resize.value || '';
  updateHint();
  document.querySelectorAll('input[name="fmt"]').forEach((el) => el.addEventListener('change', () => { settings.format = el.value; updateHint(); rerun(); }));
  q.addEventListener('input', () => { settings.quality = +q.value; updateHint(); rerunSoon(); });
  mode.addEventListener('change', () => {
    const m = mode.value;
    val.hidden = m === 'none';
    if (m === 'max') val.value = 1920;
    if (m === 'percent') val.value = 50;
    settings.resize = { mode: m, value: m === 'none' ? 0 : +val.value };
    rerun();
  });
  val.addEventListener('input', () => {
    const v = +val.value;
    if (!(v > 0)) return;
    settings.resize = { mode: mode.value, value: mode.value === 'percent' ? Math.min(100, v) : v };
    rerunSoon();
  });
  const range = $('#cmp-range');
  if (range) range.addEventListener('input', () => setCompare(range.value));
  const dlg = $('#compare-modal');
  if (dlg) dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}

// Menu des langues : même outil, autre langue
const langSel = $('#lang');
if (langSel) langSel.addEventListener('change', () => {
  const c = langSel.value;
  try { localStorage.setItem('lang', c); } catch (_) {}
  location.href = langSel.dataset.base + (c === 'en' ? '' : c + '/') + langSel.dataset.slug + '/';
});
try { if (!localStorage.getItem('lang') && LANG !== 'en') localStorage.setItem('lang', LANG); } catch (_) {}
