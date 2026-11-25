// Moteur de compression de PDF (Web Worker). Tout se passe sur l'appareil du visiteur.
// Construit par tools/build-compress.mjs vers site/assets/compress/pdf-worker.js
// Utilise Ghostscript compilé en WebAssembly (AGPL-3.0, Artifex), comme le reste du site (AGPL).
import gsFactory from '@okathira/ghostpdl-wasm/gs.js';

const WASM = new URL('../../vendor/ghostscript-1.1.0/gs.wasm', import.meta.url).href;
let compiled;
const getModule = () => (compiled ||= WebAssembly.compileStreaming(fetch(WASM)).catch((e) => { compiled = null; throw e; }));

// Réglages par niveau : résolution des images (ppp) et facteur JPEG (QFactor : plus petit = meilleure qualité).
export const LEVELS = {
  light: { dpi: 200, q: 0.4 },
  medium: { dpi: 150, q: 0.76 },
  strong: { dpi: 100, q: 1.3 },
  raster: { dpi: 110, jpegq: 60 },
};

async function loadGs(onLine) {
  const mod = await getModule();
  const M = await gsFactory({
    noInitialRun: true,
    print: onLine, printErr: onLine,
    instantiateWasm: (imports, cb) => { WebAssembly.instantiate(mod, imports).then((inst) => cb(inst)); return {}; },
  });
  return M;
}

function imageArgs(k, dpi) {
  return [`-dDownsample${k}Images=true`, `-d${k}ImageDownsampleType=/Bicubic`, `-d${k}ImageResolution=${dpi}`, `-d${k}ImageDownsampleThreshold=1.1`,
    `-dAutoFilter${k}Images=false`, `-d${k}ImageFilter=/DCTEncode`];
}

function jpegSize(b) {
  for (let i = 2; i < b.length - 9;) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], c: b[i + 9] };
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  throw new Error('jpeg');
}

// Petit écrivain PDF : une image JPEG par page.
function jpegsToPdf(jpegs, dpi) {
  const enc = new TextEncoder();
  const parts = []; const offsets = []; let pos = 0;
  const push = (x) => { const u = typeof x === 'string' ? enc.encode(x) : x; parts.push(u); pos += u.length; };
  const obj = (n, body) => { offsets[n] = pos; push(`${n} 0 obj\n`); for (const b of body) push(b); push('\nendobj\n'); };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = jpegs.length;
  const kids = jpegs.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  obj(2, [`<< /Type /Pages /Count ${n} /Kids [${kids}] >>`]);
  jpegs.forEach((j, i) => {
    const { w, h, c } = jpegSize(j);
    const pw = (w * 72 / dpi).toFixed(2), ph = (h * 72 / dpi).toFixed(2);
    const p = 3 + i * 3;
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    obj(p, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${p + 2} 0 R >> >> /Contents ${p + 1} 0 R >>`]);
    obj(p + 1, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    obj(p + 2, [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /${c === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${j.length} >>\nstream\n`, j, '\nendstream']);
  });
  const xref = pos; const total = 3 + n * 3;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let k = 1; k < total; k++) x += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
  push(x + `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

self.onmessage = async (e) => {
  const { id, file, level } = e.data;
  const L = LEVELS[level] || LEVELS.medium;
  let total = 0; let log = '';
  const onLine = (s) => {
    log += s + '\n';
    let m = /Processing pages \d+ through (\d+)/.exec(s);
    if (m) total = +m[1];
    m = /^Page (\d+)/.exec(s);
    if (m && total) self.postMessage({ id, progress: +m[1] / total, page: +m[1], total });
  };
  try {
    self.postMessage({ id, stage: 'engine' });
    const M = await loadGs(onLine);
    M.FS.writeFile('/in.pdf', new Uint8Array(await file.arrayBuffer()));
    self.postMessage({ id, stage: 'work' });
    let blob;
    if (level === 'raster') {
      M.FS.mkdir('/out');
      const rc = M.callMain(['-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=jpeg', `-r${L.dpi}`, `-dJPEGQ=${L.jpegq}`,
        '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', '-sOutputFile=/out/p%05d.jpg', '/in.pdf']);
      const files = M.FS.readdir('/out').filter((f) => f.endsWith('.jpg')).sort();
      if (rc !== 0 || !files.length) throw new Error(errorKind(log));
      blob = jpegsToPdf(files.map((f) => M.FS.readFile('/out/' + f)), L.dpi);
    } else {
      const dict = `<< /QFactor ${L.q} /Blend 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2] >>`;
      const rc = M.callMain(['-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5', '-dPDFSETTINGS=/ebook',
        '-dDetectDuplicateImages=true', '-dCompressFonts=true', '-dSubsetFonts=true',
        '-dPassThroughJPEGImages=false', '-dPassThroughJPXImages=false',
        ...imageArgs('Color', L.dpi), ...imageArgs('Gray', L.dpi),
        '-dDownsampleMonoImages=true', `-dMonoImageResolution=${Math.max(300, L.dpi * 2)}`,
        '-sOutputFile=/out.pdf', '-c', `<< /ColorImageDict ${dict} /GrayImageDict ${dict} >> setdistillerparams`, '-f', '/in.pdf']);
      let out;
      try { out = M.FS.readFile('/out.pdf'); } catch (_) { out = null; }
      if (rc !== 0 || !out || out.length < 100) throw new Error(errorKind(log));
      blob = new Blob([out], { type: 'application/pdf' });
    }
    // Ghostscript rend parfois 0 sans avoir rien traité (PDF protégé ou illisible)
    if (/requires a password/i.test(log)) throw new Error('encrypted');
    if (!total || /No pages will be processed/.test(log)) throw new Error('damaged');
    let kept = false;
    if (blob.size >= file.size) { blob = file.slice(0, file.size, 'application/pdf'); kept = true; }
    self.postMessage({ id, ok: true, blob, kept, pages: total });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};

function errorKind(log) {
  if (/requires a password/i.test(log)) return 'encrypted';
  if (/Couldn't find trailer|Couldn't initialise|No pages will be processed|not a PDF|Unrecoverable error|syntaxerror/i.test(log)) return 'damaged';
  return 'failed';
}
