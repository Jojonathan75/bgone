// Construit les moteurs de compression (images et PDF) et copie les fichiers WebAssembly.
// Usage : npm install   puis   node tools/build-compress.mjs
// À relancer seulement si on change la version d'un codec.
import { build } from 'esbuild';
import fs from 'node:fs';

const common = { bundle: true, format: 'esm', minify: true, platform: 'browser', target: 'es2020', external: ['module', 'fs', 'path', 'url', 'crypto', 'worker_threads'], logLevel: 'warning', legalComments: 'eof' };
await build({ ...common, entryPoints: ['src/compress/image-worker.js'], outfile: 'site/assets/compress/image-worker.js' });
await build({ ...common, entryPoints: ['src/compress/pdf-worker.js'], outfile: 'site/assets/compress/pdf-worker.js' });

const copy = (from, toDir) => { fs.mkdirSync(toDir, { recursive: true }); fs.copyFileSync(from, `${toDir}/${from.split('/').pop()}`); };
const C = 'site/vendor/codecs-1';
copy('node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm', C);
copy('node_modules/@jsquash/webp/codec/enc/webp_enc.wasm', C);
copy('node_modules/@jsquash/webp/codec/enc/webp_enc_simd.wasm', C);
copy('node_modules/@jsquash/avif/codec/enc/avif_enc.wasm', C);
copy('node_modules/@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm', C);
copy('node_modules/@okathira/ghostpdl-wasm/dist/gs.wasm', 'site/vendor/ghostscript-1.1.0');
console.log('OK : moteurs de compression construits');
