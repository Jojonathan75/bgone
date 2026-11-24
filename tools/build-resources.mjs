// Construit site/bgdata/ : fichiers du modèle IA + moteur ONNX, découpés en morceaux de 4 Mo.
// Usage : node tools/build-resources.mjs <dossier du paquet @imgly/background-removal-data>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dataPkg = process.argv[2];
const out = 'site/bgdata';
const CHUNK = 4 * 1024 * 1024;
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

function readImglyResource(key) {
  const res = JSON.parse(fs.readFileSync(path.join(dataPkg, 'dist/resources.json'), 'utf8'));
  const e = res[key];
  return Buffer.concat(e.chunks.map(c => fs.readFileSync(path.join(dataPkg, 'dist', c.hash))));
}

const ortDir = 'node_modules/onnxruntime-web/dist';
const sources = {
  '/models/isnet_fp16': { buf: readImglyResource('/models/medium'), mime: 'application/octet-stream' },
  '/models/isnet_quint8': { buf: readImglyResource('/models/small'), mime: 'application/octet-stream' },
};
for (const f of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']) {
  sources['/onnxruntime-web/' + f] = { buf: fs.readFileSync(path.join(ortDir, f)), mime: f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' };
}

const manifest = {};
for (const [key, { buf, mime }] of Object.entries(sources)) {
  const chunks = [];
  for (let o = 0; o < buf.length; o += CHUNK) {
    const part = buf.subarray(o, Math.min(o + CHUNK, buf.length));
    const name = crypto.createHash('sha256').update(part).digest('hex') + '.bin';
    fs.writeFileSync(path.join(out, name), part);
    chunks.push({ name, offsets: [o, o + part.length] });
  }
  manifest[key] = { chunks, size: buf.length, mime };
  console.log(key, (buf.length / 1e6).toFixed(1), 'Mo,', chunks.length, 'morceaux');
}
fs.writeFileSync(path.join(out, 'resources.json'), JSON.stringify(manifest, null, 1));
