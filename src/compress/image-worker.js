// Moteur de compression d'images (Web Worker). Tout se passe sur l'appareil du visiteur.
// Construit par tools/build-compress.mjs vers site/assets/compress/image-worker.js
// Codecs : MozJPEG, libwebp, libavif (Squoosh / jSquash, Apache-2.0), OxiPNG (MIT), UPNG.js (MIT).
import mozjpegFactory from '@jsquash/jpeg/codec/enc/mozjpeg_enc.js';
import webpFactory from '@jsquash/webp/codec/enc/webp_enc.js';
import webpSimdFactory from '@jsquash/webp/codec/enc/webp_enc_simd.js';
import avifFactory from '@jsquash/avif/codec/enc/avif_enc.js';
import { defaultOptions as JPEG_DEF } from '@jsquash/jpeg/meta.js';
import { defaultOptions as WEBP_DEF } from '@jsquash/webp/meta.js';
import { defaultOptions as AVIF_DEF } from '@jsquash/avif/meta.js';
import initOxipng, { optimise as oxiOptimise } from '@jsquash/oxipng/codec/pkg/squoosh_oxipng.js';
import { simd } from 'wasm-feature-detect';
import UPNG from 'upng-js';

const VENDOR = new URL('../../vendor/codecs-1/', import.meta.url).href;

// Chaque codec n'est téléchargé que la première fois qu'on en a besoin.
const cache = {};
function emscripten(factory, wasmFile) {
  return (cache[wasmFile] ||= (async () => {
    const mod = await WebAssembly.compileStreaming(fetch(VENDOR + wasmFile));
    return factory({
      noInitialRun: true,
      instantiateWasm: (imports, cb) => { const inst = new WebAssembly.Instance(mod, imports); cb(inst); return inst.exports; },
    });
  })());
}
const getJpeg = () => emscripten(mozjpegFactory, 'mozjpeg_enc.wasm');
const getAvif = () => emscripten(avifFactory, 'avif_enc.wasm');
const getWebp = async () => (await simd()) ? emscripten(webpSimdFactory, 'webp_enc_simd.wasm') : emscripten(webpFactory, 'webp_enc.wasm');
let oxiReady;
const getOxi = () => (oxiReady ||= initOxipng(fetch(VENDOR + 'squoosh_oxipng_bg.wasm')));

const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' };
function formatOf(type, name) {
  if (type === 'image/jpeg' || /\.jpe?g$/i.test(name)) return 'jpg';
  if (type === 'image/png' || /\.png$/i.test(name)) return 'png';
  if (type === 'image/webp' || /\.webp$/i.test(name)) return 'webp';
  if (type === 'image/avif' || /\.avif$/i.test(name)) return 'avif';
  return 'jpg'; // GIF, BMP… : on convertit en JPG par défaut
}

// Réduit l'image en plusieurs étapes de moitié : bien plus net qu'une seule réduction brutale.
function resizeTo(bitmap, w, h) {
  let src = bitmap, sw = bitmap.width, sh = bitmap.height;
  while (sw / 2 >= w && sh / 2 >= h) {
    const c = new OffscreenCanvas(Math.round(sw / 2), Math.round(sh / 2));
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, c.width, c.height);
    src = c; sw = c.width; sh = c.height;
  }
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, w, h);
  return x;
}

function targetSize(W, H, r) {
  let s = 1;
  if (r && r.mode === 'percent' && r.value > 0 && r.value < 100) s = r.value / 100;
  if (r && r.mode === 'max' && r.value > 0 && Math.max(W, H) > r.value) s = r.value / Math.max(W, H);
  return [Math.max(1, Math.round(W * s)), Math.max(1, Math.round(H * s))];
}

function hasAlpha(d) {
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}
function flatten(d, rgb = [255, 255, 255]) {
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (a < 1) {
      d[i] = d[i] * a + rgb[0] * (1 - a);
      d[i + 1] = d[i + 1] * a + rgb[1] * (1 - a);
      d[i + 2] = d[i + 2] * a + rgb[2] * (1 - a);
      d[i + 3] = 255;
    }
  }
}

// PNG : qualité >= 95 = sans perte, sinon réduction du nombre de couleurs (comme pngquant).
export function pngColors(q) {
  if (q >= 95) return 0;
  if (q >= 75) return 256;
  if (q >= 55) return 128;
  if (q >= 35) return 64;
  return 32;
}

async function encode(fmt, img, q) {
  const { data, width: w, height: h } = img;
  if (fmt === 'jpg') {
    const m = await getJpeg();
    flatten(data);
    return m.encode(data, w, h, { ...JPEG_DEF, quality: q, chroma_subsample: q >= 90 ? 1 : 2 }).buffer;
  }
  if (fmt === 'webp') {
    const m = await getWebp();
    return m.encode(data, w, h, { ...WEBP_DEF, quality: q, method: 4 }).buffer;
  }
  if (fmt === 'avif') {
    const m = await getAvif();
    // vitesse 8 : un peu moins efficace que 6 mais 3 à 4 fois plus rapide dans le navigateur
    const out = m.encode(new Uint8Array(data.buffer), w, h, { ...AVIF_DEF, quality: Math.round(q * 0.8), speed: 8 });
    if (!out) throw new Error('AVIF');
    return out.buffer;
  }
  // PNG
  const colors = pngColors(q);
  let png = UPNG.encode([data.buffer], w, h, colors);
  await getOxi();
  try { png = oxiOptimise(new Uint8Array(png), 2, false, true).buffer; } catch (_) { /* on garde la version UPNG */ }
  return png;
}

self.onmessage = async (e) => {
  const { id, file, opts } = e.data;
  try {
    const srcFmt = formatOf(file.type, file.name);
    const fmt = opts.format === 'keep' ? srcFmt : opts.format;
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const ow = bitmap.width, oh = bitmap.height;
    const [w, h] = targetSize(ow, oh, opts.resize);
    const ctx = resizeTo(bitmap, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const alphaLost = fmt === 'jpg' && hasAlpha(img.data);
    bitmap.close();
    let buf = await encode(fmt, img, opts.quality);
    let kept = false;
    // Même format, même taille et pas plus léger : on rend l'original tel quel.
    if (fmt === srcFmt && w === ow && h === oh && buf.byteLength >= file.size) {
      buf = await file.arrayBuffer();
      kept = true;
    }
    const blob = new Blob([buf], { type: MIME[fmt] });
    self.postMessage({ id, ok: true, blob, fmt, w, h, kept, alphaLost });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
