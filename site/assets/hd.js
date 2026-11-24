// HD payant : achat de crédits (Stripe) et agrandissement ×4 sur le serveur.
// Ne s'active que si le serveur est configuré (/api/hd/config) ; sinon le site
// garde le message « HD bientôt ».
const API = '/api/hd/';
const KEY = 'poppix_hd_code';
const P = window.poppixHD;

/* ---------- Textes (anglais par défaut ; les autres langues sont à ajouter) ---------- */
const TXT = {
  en: {
    title: 'HD download',
    test: 'TEST MODE: no real payment. Use card 4242 4242 4242 4242.',
    have: 'You have {n} credits.', have1: 'You have 1 credit.', none: 'You have no credits yet.',
    your_code: 'Your code', copy: 'Copy', copied: 'Code copied',
    code_hint: 'Keep this code: it lets you use your credits on another device or browser.',
    make: 'Create HD image (uses 1 credit)', make_sub: '×{s} AI upscaling, up to {w} × {h} px',
    buy: 'Buy credits', pack: '{n} credits', per: '{p} per image',
    consent: 'I want access right away and I understand that I lose my 14-day right of withdrawal once I use a credit.',
    consent_needed: 'Please tick the box first.',
    secure: 'Secure payment by Stripe. Credits never expire. No subscription.',
    enter: 'I already have a code', use: 'Use', bad_code: 'Unknown code.',
    working: 'Creating your HD image… This can take up to a minute.',
    done: 'HD image downloaded ({w} × {h} px).',
    failed: 'HD failed. Your credit was not used. Please try again.',
    no_credits: 'You have no credits left.',
    paid: 'Payment received: {n} credits are ready.',
    paid_other_tab: 'You can go back to your image in the other tab.',
    pay_error: 'Payment could not start. Please try again.',
    claim_wait: 'Checking your payment…',
    not_ready: 'Open an image first.',
    from: 'From {p}', cta: 'Buy credits', badge: '1 credit',
  },
  fr: {
    title: 'Téléchargement HD',
    test: 'MODE TEST : aucun vrai paiement. Utilisez la carte 4242 4242 4242 4242.',
    have: 'Vous avez {n} crédits.', have1: 'Vous avez 1 crédit.', none: "Vous n'avez pas encore de crédits.",
    your_code: 'Votre code', copy: 'Copier', copied: 'Code copié',
    code_hint: 'Gardez ce code : il permet d’utiliser vos crédits sur un autre appareil ou navigateur.',
    make: 'Créer l’image HD (1 crédit)', make_sub: 'Agrandissement IA ×{s}, jusqu’à {w} × {h} px',
    buy: 'Acheter des crédits', pack: '{n} crédits', per: '{p} par image',
    consent: 'Je veux un accès immédiat et je comprends que je perds mon droit de rétractation de 14 jours dès que j’utilise un crédit.',
    consent_needed: 'Cochez d’abord la case.',
    secure: 'Paiement sécurisé par Stripe. Les crédits n’expirent pas. Sans abonnement.',
    enter: "J'ai déjà un code", use: 'Utiliser', bad_code: 'Code inconnu.',
    working: 'Création de votre image HD… Cela peut prendre jusqu’à une minute.',
    done: 'Image HD téléchargée ({w} × {h} px).',
    failed: 'Le HD a échoué. Votre crédit n’a pas été utilisé. Réessayez.',
    no_credits: 'Vous n’avez plus de crédits.',
    paid: 'Paiement reçu : {n} crédits sont disponibles.',
    paid_other_tab: 'Vous pouvez revenir à votre image dans l’autre onglet.',
    pay_error: 'Le paiement n’a pas pu démarrer. Réessayez.',
    claim_wait: 'Vérification de votre paiement…',
    not_ready: 'Ouvrez d’abord une image.',
    from: 'Dès {p}', cta: 'Acheter des crédits', badge: '1 crédit',
  },
};
const lang = document.documentElement.lang || 'en';
const T = { ...TXT.en, ...(TXT[lang] || {}) };
const t = (k, v = {}) => (T[k] || k).replace(/\{(\w+)\}/g, (_, n) => v[n] ?? '');
const money = (cents, cur) => new Intl.NumberFormat(lang, { style: 'currency', currency: cur.toUpperCase() }).format(cents / 100);
const toast = (m, err) => P ? P.toast(m, err) : alert(m);

const store = {
  get() { try { return localStorage.getItem(KEY) || ''; } catch (_) { return ''; } },
  set(c) { try { localStorage.setItem(KEY, c); } catch (_) {} },
};

let CFG = null;
let credits = null;
let forDownload = false;
let busy = false;

/* ---------- Appels au serveur ---------- */
async function api(path, opts) {
  const r = await fetch(API + path, opts);
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  return { ok: r.ok, status: r.status, data, res: r };
}
async function refresh() {
  const code = store.get();
  if (!code) { credits = null; return; }
  const r = await api('balance?code=' + encodeURIComponent(code)).catch(() => null);
  credits = r && r.ok ? r.data.credits : null;
}

/* ---------- Fenêtre ---------- */
const css = `
#hdx .hd-test{background:#fff4d6;color:#7a5200;border-radius:10px;padding:8px 12px;font-size:13px;margin:0 0 12px}
#hdx .hd-bal{font-weight:700;margin:4px 0}
#hdx .hd-code{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
#hdx .hd-code code{font-size:17px;letter-spacing:.08em;background:var(--paper);padding:6px 10px;border-radius:8px}
#hdx .hd-make{width:100%;display:flex;flex-direction:column;gap:2px;margin:12px 0}
#hdx .hd-make small{font-weight:400;opacity:.9}
#hdx .hd-packs{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:8px 0}
#hdx .hd-pack{display:flex;flex-direction:column;gap:2px;padding:12px;border:1.5px solid var(--line);border-radius:12px;background:var(--card);cursor:pointer;font:inherit;color:inherit;text-align:start}
#hdx .hd-pack:hover{border-color:var(--accent)}
#hdx .hd-pack strong{font-size:16px}#hdx .hd-pack span{font-size:20px;font-weight:800}#hdx .hd-pack em{font-style:normal;font-size:12px;color:var(--ink-3)}
#hdx .hd-consent{display:flex;gap:8px;align-items:flex-start;font-size:13px;color:var(--ink-2);margin:8px 0}
#hdx .hd-small{font-size:12px;color:var(--ink-3);margin:6px 0}
#hdx .hd-enter{display:flex;gap:8px;margin-top:6px}#hdx .hd-enter input{flex:1;min-width:0;padding:8px 10px;border:1.5px solid var(--line);border-radius:10px;font:inherit;text-transform:uppercase}
#hdx details{margin-top:12px}#hdx summary{cursor:pointer;font-size:14px;color:var(--ink-2)}
#hdx .hd-work{display:flex;gap:10px;align-items:center;margin:14px 0}
#hdx .hd-spin{width:20px;height:20px;border:3px solid var(--accent-soft);border-top-color:var(--accent);border-radius:50%;animation:hdspin 1s linear infinite;flex:none}
@keyframes hdspin{to{transform:rotate(360deg)}}`;

function dialog() {
  let d = document.getElementById('hdx');
  if (d) return d;
  const st = document.createElement('style'); st.textContent = css; document.head.append(st);
  d = document.createElement('dialog');
  d.className = 'modal'; d.id = 'hdx';
  d.innerHTML = `<div class="modal-card"><h2></h2><div class="hd-body"></div><button class="modal-x" aria-label="×">×</button></div>`;
  d.querySelector('.modal-x').addEventListener('click', () => { if (!busy) d.close(); });
  d.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
  document.body.append(d);
  return d;
}
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function render(msg) {
  const d = dialog();
  d.querySelector('h2').textContent = t('title');
  const code = store.get();
  const src = forDownload && P ? P.source(P.crop) : null;
  const est = src ? { w: src.canvas.width * CFG.scale, h: src.canvas.height * CFG.scale } : null;
  let h = '';
  if (CFG.test) h += `<p class="hd-test">${esc(t('test'))}</p>`;
  if (msg) h += `<p>${esc(msg)}</p>`;
  if (busy) {
    h += `<div class="hd-work"><span class="hd-spin"></span><span>${esc(t('working'))}</span></div>`;
  } else {
    h += `<p class="hd-bal">${esc(credits === 1 ? t('have1') : credits > 0 ? t('have', { n: credits }) : t('none'))}</p>`;
    if (code && credits !== null) {
      h += `<div class="hd-code"><span>${esc(t('your_code'))} :</span><code>${esc(code)}</code><button class="btn btn-ghost" data-hd="copy">${esc(t('copy'))}</button></div><p class="hd-small">${esc(t('code_hint'))}</p>`;
    }
    if (est && credits > 0) {
      h += `<button class="btn btn-primary hd-make" data-hd="make"><span>${esc(t('make'))}</span><small>${esc(t('make_sub', { s: CFG.scale, ...est }))}</small></button>`;
    }
    h += `<h3>${esc(t('buy'))}</h3><div class="hd-packs">`;
    for (const p of CFG.packs) {
      h += `<button class="hd-pack" data-hd="buy" data-pack="${esc(p.id)}"><strong>${esc(t('pack', { n: p.credits }))}</strong><span>${esc(money(p.amount, CFG.currency))}</span><em>${esc(t('per', { p: money(Math.round(p.amount / p.credits), CFG.currency) }))}</em></button>`;
    }
    h += `</div><label class="hd-consent"><input type="checkbox" id="hd-consent"> <span>${esc(t('consent'))}</span></label><p class="hd-small">${esc(t('secure'))}</p>`;
    h += `<details><summary>${esc(t('enter'))}</summary><div class="hd-enter"><input id="hd-code-in" autocomplete="off" placeholder="XXXX-XXXX-XXXX" maxlength="16"><button class="btn btn-ghost" data-hd="use">${esc(t('use'))}</button></div></details>`;
  }
  d.querySelector('.hd-body').innerHTML = h;
  if (!d.open) d.showModal();
}

async function open(download) {
  forDownload = download;
  document.getElementById('dl-modal')?.close();
  await refresh();
  render();
}

/* ---------- Achat ---------- */
async function buy(pack) {
  if (!document.getElementById('hd-consent')?.checked) { toast(t('consent_needed'), true); return; }
  // Onglet ouvert tout de suite (sinon le navigateur le bloque), pour garder l'image dans celui-ci.
  const w = window.open('', '_blank');
  const r = await api('checkout', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pack, path: location.pathname, code: store.get() }),
  }).catch(() => null);
  if (!r || !r.ok || !r.data.url) { if (w) w.close(); toast(t('pay_error'), true); return; }
  if (w) w.location.href = r.data.url; else location.href = r.data.url;
}

async function claimFromUrl() {
  const u = new URL(location.href);
  const session = u.searchParams.get('hd_session');
  if (!session) return;
  u.searchParams.delete('hd_session');
  history.replaceState(null, '', u.pathname + u.search + u.hash);
  forDownload = false;
  render(t('claim_wait'));
  const r = await api('claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session }) }).catch(() => null);
  if (!r || !r.ok) { render(t('pay_error')); return; }
  store.set(r.data.code);
  credits = r.data.credits;
  render(t('paid', { n: r.data.credits }) + (P && !P.source(false) ? ' ' + t('paid_other_tab') : ''));
}

/* ---------- Agrandissement ---------- */
const MAX_AREA = matchMedia('(pointer: coarse)').matches ? 16e6 : 60e6; // limite des canvas (iPhone : ~16,7 Mpx)
async function make() {
  const src = P && P.source(P.crop);
  if (!src) { toast(t('not_ready'), true); return; }
  const fmt = P.fmt;
  busy = true; render();
  try {
    const jpg = await new Promise(r => src.canvas.toBlob(r, 'image/jpeg', 0.95));
    const r = await fetch(API + 'upscale', { method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-hd-code': store.get() }, body: jpg });
    if (r.status === 402) { busy = false; credits = 0; render(t('no_credits')); return; }
    if (!r.ok) throw new Error(r.status);
    const left = parseInt(r.headers.get('x-hd-credits'), 10);
    let up = await createImageBitmap(await r.blob());
    // Trop grand pour l'appareil : on réduit juste ce qu'il faut
    const k = Math.min(1, Math.sqrt(MAX_AREA / (up.width * up.height)));
    if (k < 1) {
      const c = document.createElement('canvas');
      c.width = Math.round(up.width * k); c.height = Math.round(up.height * k);
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(up, 0, 0, c.width, c.height);
      up.close(); up = c;
    }
    const out = P.compose(up, src, fmt);
    const mime = fmt === 'jpg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
    const blob = await new Promise(res => out.toBlob(res, mime, 0.95));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${P.fileName}-${P.brand.toLowerCase()}-hd.${fmt}`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    busy = false;
    credits = Number.isFinite(left) ? left : credits - 1;
    render(t('done', { w: out.width, h: out.height }));
  } catch (_) {
    busy = false;
    await refresh();
    render(t('failed'));
  }
}

/* ---------- Démarrage ---------- */
async function init() {
  const r = await api('config').catch(() => null);
  if (!r || !r.ok || !r.data || !r.data.enabled) return; // HD pas encore configuré
  CFG = r.data;

  // Les textes « bientôt » deviennent de vrais prix
  const cheapest = CFG.packs.reduce((a, b) => (a.amount < b.amount ? a : b));
  const em = document.querySelector('#dl-hd em'); if (em) em.textContent = t('badge');
  document.querySelector('.plan-hd .badge')?.remove();
  const price = document.querySelector('.plan-hd .price'); if (price) price.textContent = t('from', { p: money(cheapest.amount, CFG.currency) });
  const cta = document.querySelector('.plan-hd [data-action=hd-info]'); if (cta) cta.textContent = t('cta');

  // On prend la main sur les boutons HD (phase de capture, avant le script principal)
  document.addEventListener('click', (e) => {
    const hd = e.target.closest('#dl-hd, [data-action=hd-info]');
    if (hd) { e.preventDefault(); e.stopImmediatePropagation(); open(hd.id === 'dl-hd'); return; }
    const b = e.target.closest('#hdx [data-hd]');
    if (!b || busy) return;
    const act = b.dataset.hd;
    if (act === 'buy') buy(b.dataset.pack);
    else if (act === 'make') make();
    else if (act === 'copy') { navigator.clipboard?.writeText(store.get()).then(() => toast(t('copied'))); }
    else if (act === 'use') {
      const v = document.getElementById('hd-code-in').value;
      api('balance?code=' + encodeURIComponent(v)).then(r => {
        if (!r.ok) { toast(t('bad_code'), true); return; }
        store.set(r.data.code); credits = r.data.credits; render();
      });
    }
  }, true);

  // Achat terminé dans un autre onglet : on met le solde à jour ici
  window.addEventListener('storage', async (e) => {
    if (e.key !== KEY) return;
    await refresh();
    if (document.getElementById('hdx')?.open && !busy) render();
  });

  claimFromUrl();
}
init();
