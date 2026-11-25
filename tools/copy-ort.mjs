// Copie le fichier WebAssembly d'ONNX Runtime dans site/ort/ (servi avec le site).
import fs from 'node:fs';
fs.mkdirSync('site/ort', { recursive: true });
for (const f of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) fs.copyFileSync(`node_modules/onnxruntime-web/dist/${f}`, `site/ort/${f}`);
console.log('ONNX Runtime copié dans site/ort/');
