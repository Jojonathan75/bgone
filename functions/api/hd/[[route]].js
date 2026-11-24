// API du HD payant (Cloudflare Pages Functions).
// Routes : GET /api/hd/config, POST /api/hd/checkout, POST /api/hd/claim,
//          GET /api/hd/balance, POST /api/hd/upscale
//
// Réglages à mettre dans Cloudflare Pages → Settings → Variables and Secrets :
//   STRIPE_SECRET_KEY    (Secret)  clé secrète Stripe, sk_test_… pour essayer, sk_live_… en vrai
//   REPLICATE_API_TOKEN  (Secret)  jeton API Replicate, r8_…
//   CODE_SECRET          (Secret)  une longue phrase au hasard, sert à fabriquer les codes d'achat
// Et dans Settings → Bindings : une base D1 liée sous le nom HD_DB (voir hd/schema.sql).
// Sans ces quatre éléments, le HD reste affiché « bientôt » sur le site.

// Packs proposés (prix en centimes d'euro)
const PACKS = {
  p10: { credits: 10, amount: 299 },
  p50: { credits: 50, amount: 999 },
  p200: { credits: 200, amount: 2499 },
};
const CURRENCY = 'eur';
const MODEL = 'nightmareai/real-esrgan'; // Real-ESRGAN, licence BSD-3
const SCALE = 4;
const MAX_UPLOAD = 10 * 1024 * 1024;     // 10 Mo
const CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const fail = (error, status) => json({ error }, status);

function enabled(env) {
  return !!(env.STRIPE_SECRET_KEY && env.REPLICATE_API_TOKEN && env.CODE_SECRET && env.HD_DB);
}

/* ---------- Codes d'achat ---------- */
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O ni 1/I
async function codeFor(secret, sessionId) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sessionId)));
  let s = '';
  for (let i = 0; i < 12; i++) s += ALPHA[sig[i] % 32];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
function normCode(c) {
  c = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 12 ? `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}` : '';
}
async function balance(env, code) {
  const row = await env.HD_DB.prepare('SELECT credits FROM codes WHERE code = ?').bind(code).first();
  return row ? row.credits : null;
}

/* ---------- Stripe ---------- */
async function stripe(env, method, path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`stripe: ${data.error && data.error.message || res.status}`);
  return data;
}

async function checkout(req, env) {
  const body = await req.json().catch(() => ({}));
  const pack = PACKS[body.pack];
  if (!pack) return fail('bad_pack', 400);
  const origin = new URL(req.url).origin;
  // Chemin de retour : la page de langue d'où vient le visiteur (/, /fr/, /ja/…)
  const path = /^\/([a-z]{2}\/)?$/.test(body.path || '') ? body.path : '/';
  const params = {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': CURRENCY,
    'line_items[0][price_data][unit_amount]': String(pack.amount),
    'line_items[0][price_data][product_data][name]': `Poppix HD · ${pack.credits} credits`,
    'metadata[pack]': body.pack,
    'metadata[credits]': String(pack.credits),
    success_url: `${origin}${path}?hd_session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}${path}`,
    locale: 'auto',
  };
  // Recharge d'un code existant : les crédits s'ajoutent au même code
  const topup = normCode(body.code);
  if (topup && (await balance(env, topup)) !== null) params['metadata[topup]'] = topup;
  const s = await stripe(env, 'POST', 'checkout/sessions', params);
  return json({ url: s.url });
}

async function claim(req, env) {
  const body = await req.json().catch(() => ({}));
  const id = String(body.session || '');
  if (!/^cs_[A-Za-z0-9_]{10,300}$/.test(id)) return fail('bad_session', 400);
  const s = await stripe(env, 'GET', `checkout/sessions/${encodeURIComponent(id)}`);
  if (s.payment_status !== 'paid') return fail('not_paid', 402);
  const credits = parseInt(s.metadata && s.metadata.credits, 10);
  if (!(credits > 0)) return fail('bad_session', 400);
  const code = (s.metadata && normCode(s.metadata.topup)) || await codeFor(env.CODE_SECRET, s.id);
  // Une seule transaction : l'achat n'est crédité qu'une fois, même si la page est rechargée.
  await env.HD_DB.batch([
    env.HD_DB.prepare('INSERT INTO codes (code, credits) VALUES (?, 0) ON CONFLICT(code) DO NOTHING').bind(code),
    env.HD_DB.prepare('INSERT INTO purchases (session_id, code, credits, amount, currency, claimed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT(session_id) DO NOTHING')
      .bind(s.id, code, credits, s.amount_total || 0, s.currency || CURRENCY, Date.now()),
    env.HD_DB.prepare('UPDATE codes SET credits = credits + ? WHERE code = ? AND (SELECT claimed FROM purchases WHERE session_id = ?) = 0').bind(credits, code, s.id),
    env.HD_DB.prepare('UPDATE purchases SET claimed = 1 WHERE session_id = ?').bind(s.id),
  ]);
  return json({ code, credits: await balance(env, code) });
}

/* ---------- Replicate ---------- */
let versionCache = null;
async function replicate(env, method, url, body, extra = {}) {
  const res = await fetch(url.startsWith('http') ? url : `https://api.replicate.com/v1/${url}`, {
    method,
    headers: { authorization: `Bearer ${env.REPLICATE_API_TOKEN}`, ...extra },
    body,
  });
  if (method === 'DELETE') return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`replicate: ${data.detail || res.status}`);
  return data;
}
async function modelVersion(env) {
  if (versionCache) return versionCache;
  const m = await replicate(env, 'GET', `models/${MODEL}`);
  versionCache = m.latest_version.id;
  return versionCache;
}

async function upscale(req, env, ctx) {
  const code = normCode(req.headers.get('x-hd-code'));
  if (!CODE_RE.test(code)) return fail('bad_code', 401);
  const type = (req.headers.get('content-type') || '').split(';')[0];
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) return fail('bad_type', 415);
  const len = +req.headers.get('content-length') || 0;
  if (len > MAX_UPLOAD) return fail('too_big', 413);
  const blob = await req.blob();
  if (!blob.size || blob.size > MAX_UPLOAD) return fail('too_big', 413);

  // On retire le crédit d'abord (opération atomique), on le rend si l'agrandissement échoue.
  const spent = await env.HD_DB.prepare('UPDATE codes SET credits = credits - 1 WHERE code = ? AND credits > 0').bind(code).run();
  if (!spent.meta || spent.meta.changes !== 1) {
    return (await balance(env, code)) === null ? fail('bad_code', 401) : fail('no_credits', 402);
  }
  const refund = () => env.HD_DB.prepare('UPDATE codes SET credits = credits + 1 WHERE code = ?').bind(code).run();

  let fileUrl = null;
  try {
    // 1. Envoi de l'image chez Replicate
    const form = new FormData();
    form.append('content', new File([blob], 'input', { type }));
    const file = await replicate(env, 'POST', 'files', form);
    fileUrl = file.urls && file.urls.get;
    // 2. Lancement de l'agrandissement (on attend jusqu'à 60 s, puis on interroge)
    let p = await replicate(env, 'POST', 'predictions', JSON.stringify({
      version: await modelVersion(env),
      input: { image: fileUrl, scale: SCALE, face_enhance: false },
    }), { 'content-type': 'application/json', prefer: 'wait=60' });
    const t0 = Date.now();
    while (['starting', 'processing'].includes(p.status) && Date.now() - t0 < 120000) {
      await new Promise(r => setTimeout(r, 2000));
      p = await replicate(env, 'GET', p.urls.get);
    }
    if (p.status !== 'succeeded') throw new Error(`replicate: ${p.status} ${p.error || ''}`);
    const out = Array.isArray(p.output) ? p.output[0] : p.output;
    const img = await fetch(out);
    if (!img.ok) throw new Error('replicate: output');
    const left = await balance(env, code);
    ctx.waitUntil(replicate(env, 'DELETE', fileUrl).catch(() => {}));
    return new Response(img.body, {
      headers: {
        'content-type': img.headers.get('content-type') || 'image/png',
        'cache-control': 'no-store',
        'x-hd-credits': String(left),
      },
    });
  } catch (e) {
    await refund();
    if (fileUrl) ctx.waitUntil(replicate(env, 'DELETE', fileUrl).catch(() => {}));
    console.error(e && e.message);
    return fail('upscale_failed', 502);
  }
}

/* ---------- Routeur ---------- */
export async function onRequest(ctx) {
  const { request: req, env } = ctx;
  const route = [].concat(ctx.params.route || []).join('/');
  const m = req.method;
  try {
    if (route === 'config' && m === 'GET') {
      if (!enabled(env)) return json({ enabled: false });
      return json({
        enabled: true,
        test: env.STRIPE_SECRET_KEY.startsWith('sk_test_'),
        currency: CURRENCY,
        scale: SCALE,
        packs: Object.entries(PACKS).map(([id, p]) => ({ id, ...p })),
      });
    }
    if (!enabled(env)) return fail('disabled', 503);
    if (route === 'checkout' && m === 'POST') return await checkout(req, env);
    if (route === 'claim' && m === 'POST') return await claim(req, env);
    if (route === 'balance' && m === 'GET') {
      const code = normCode(new URL(req.url).searchParams.get('code'));
      const c = code ? await balance(env, code) : null;
      return c === null ? fail('bad_code', 404) : json({ code, credits: c });
    }
    if (route === 'upscale' && m === 'POST') return await upscale(req, env, ctx);
    return fail('not_found', 404);
  } catch (e) {
    console.error(e && e.message);
    return fail('server_error', 500);
  }
}
