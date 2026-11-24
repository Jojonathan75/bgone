// Web Worker : le détourage IA tourne ici pour ne pas bloquer l'interface.
import { segmentForeground, preload } from '@imgly/background-removal';

const publicPath = new URL('../bgdata/', self.location.href).href;

function config(model, device) {
  return {
    publicPath,
    model,
    device,
    output: { format: 'image/x-rgba8' },
    progress: (key, current, total) => self.postMessage({ type: 'progress', key, current, total }),
  };
}

async function pickDevice() {
  try {
    if (self.navigator.gpu && (await self.navigator.gpu.requestAdapter())) return 'gpu';
  } catch (_) {}
  return 'cpu';
}

self.onmessage = async (e) => {
  const { id, kind, rgba, width, height, model } = e.data;
  try {
    const device = await pickDevice();
    if (kind === 'preload') {
      await preload(config(model, device));
      self.postMessage({ type: 'done', id });
      return;
    }
    const input = new Blob([rgba], { type: `image/x-rgba8;width=${width};height=${height}` });
    const out = await segmentForeground(input, config(model, device));
    const px = new Uint8Array(await out.arrayBuffer());
    const alpha = new Uint8Array(width * height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = px[i * 4 + 3];
    self.postMessage({ type: 'done', id, alpha, device }, [alpha.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err && err.message || err) });
  }
};
