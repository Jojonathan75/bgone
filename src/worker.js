// Web Worker : le détourage IA tourne ici pour ne pas bloquer l'interface.
// Moteur : ONNX Runtime Web (MIT). Modèles : BiRefNet lite (MIT) et ISNet (Apache-2.0).
// Les fichiers des modèles sont préparés par tools/build-models.py (morceaux gzip de 4 Mo).
import * as ort from 'onnxruntime-web/wasm';

const ROOT = new URL('../', self.location.href).href;
ort.env.wasm.wasmPaths = ROOT + 'ort/';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1;

const sessions = new Map(); // nom du modèle -> { session, man }
const progress = (key, current, total) => self.postMessage({ type: 'progress', key, current, total });

async function fetchModel(name) {
  const base = `${ROOT}models/${name}/`;
  const man = await (await fetch(base + 'manifest.json')).json();
  const parts = new Array(man.parts.length);
  let loaded = 0;
  const key = `fetch:${name}`;
  progress(key, 0, man.bytes);
  // 4 téléchargements en parallèle
  let next = 0;
  async function worker() {
    while (next < man.parts.length) {
      const i = next++;
      const res = await fetch(base + man.parts[i]);
      if (!res.ok) throw new Error(`HTTP ${res.status} (${man.parts[i]})`);
      const reader = res.body.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); loaded += value.length;
        progress(key, Math.min(loaded, man.bytes), man.bytes);
      }
      parts[i] = new Blob(chunks);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  const stream = new Blob(parts).stream().pipeThrough(new DecompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return { man, bytes };
}

async function getSession(name) {
  if (sessions.has(name)) return sessions.get(name);
  const { man, bytes } = await fetchModel(name);
  progress('compute:init', 0, 1);
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  const s = { session, man };
  sessions.set(name, s);
  return s;
}

// Image RGBA (largeur x hauteur) -> tenseur NCHW float32 normalisé, à la taille du modèle.
function toTensor(rgba, width, height, man) {
  const N = man.size;
  const src = new OffscreenCanvas(width, height);
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), width, height), 0, 0);
  const dst = new OffscreenCanvas(N, N);
  const ctx = dst.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, N, N);
  const px = ctx.getImageData(0, 0, N, N).data;
  const plane = N * N, data = new Float32Array(3 * plane);
  const [m0, m1, m2] = man.mean, [s0, s1, s2] = man.std;
  for (let i = 0, j = 0; i < plane; i++, j += 4) {
    data[i] = (px[j] / 255 - m0) / s0;
    data[i + plane] = (px[j + 1] / 255 - m1) / s1;
    data[i + 2 * plane] = (px[j + 2] / 255 - m2) / s2;
  }
  return new ort.Tensor('float32', data, [1, 3, N, N]);
}

// Sortie du modèle (N x N) -> masque alpha à la taille de l'image.
function toAlpha(out, man, width, height) {
  const N = man.size, plane = N * N, d = out.data;
  const g = new Uint8ClampedArray(plane * 4);
  let lo = 0, hi = 1;
  if (man.output === 'minmax') {
    lo = Infinity; hi = -Infinity;
    for (let i = 0; i < plane; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  const span = hi - lo || 1;
  for (let i = 0, j = 0; i < plane; i++, j += 4) {
    let v = d[i];
    v = man.output === 'sigmoid' ? 1 / (1 + Math.exp(-v)) : (v - lo) / span;
    // Courbe de contraste : supprime les « fantômes » semi-transparents (ombres portées, reflets)
    if (man.curve) v = Math.min(1, Math.max(0, (v - man.curve[0]) / (man.curve[1] - man.curve[0])));
    g[j] = g[j + 1] = g[j + 2] = 255; g[j + 3] = v * 255;
  }
  const small = new OffscreenCanvas(N, N);
  small.getContext('2d').putImageData(new ImageData(g, N, N), 0, 0);
  const big = new OffscreenCanvas(width, height);
  const ctx = big.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, width, height);
  const px = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Uint8Array(width * height);
  for (let i = 0, j = 3; i < alpha.length; i++, j += 4) alpha[i] = px[j];
  return alpha;
}

self.onmessage = async (e) => {
  const { id, kind, rgba, width, height, model } = e.data;
  try {
    const { session, man } = await getSession(model);
    if (kind === 'preload') { self.postMessage({ type: 'done', id }); return; }
    progress('compute:inference', 0, 1);
    const input = toTensor(rgba, width, height, man);
    const t0 = performance.now();
    const result = await session.run({ [session.inputNames[0]]: input });
    const ms = performance.now() - t0;
    progress('compute:mask', 0, 1);
    const alpha = toAlpha(result[session.outputNames[0]], man, width, height);
    self.postMessage({ type: 'done', id, alpha, ms, threads: ort.env.wasm.numThreads }, [alpha.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err && err.message || err) });
  }
};
