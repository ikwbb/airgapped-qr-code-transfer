// Reproducible CPU-only comparison. This is not a physical camera throughput test.
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { decodeImage } from '../decoder.js';
import { prepareTransfer } from '../protocol.js';
async function loadUMD(path) {
  const module = { exports: {} };
  vm.runInThisContext('(function(module,exports){' + await readFile(new URL(path, import.meta.url), 'utf8') + '\n})')(module, module.exports);
  return module.exports;
}
const context = { QRCode: await loadUMD('../vendor/qrcode.js'), jsQR: await loadUMD('../vendor/jsQR.js') };
let seed = 8831;
const bytes = Uint8Array.from({ length: 4096 }, () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed & 255; });
const t = await prepareTransfer(new File([bytes], 'test.bin'));
const text = t.dataFrame(0);
const qr = context.QRCode.create([{ data: text, mode: 'alphanumeric' }], { errorCorrectionLevel: 'M' });
const width = (qr.modules.size + 8) * 4;
const data = new Uint8ClampedArray(width * width * 4).fill(255);
for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
  const mx = Math.floor(x / 4) - 4, my = Math.floor(y / 4) - 4;
  if (mx >= 0 && my >= 0 && mx < qr.modules.size && my < qr.modules.size && qr.modules.get(my, mx)) {
    const i = (y * width + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
  }
}
const savedProcess = globalThis.process;
try { globalThis.process = undefined; await decodeImage({ data, width, height: width }); }
finally { globalThis.process = savedProcess; }
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function time(fn) {
  const times = [];
  for (let i = 0; i < 25; i++) {
    const start = performance.now(); const result = await fn();
    if (!result) throw new Error('Benchmark decode failed');
    if (i >= 5) times.push(performance.now() - start);
  }
  return Number(median(times).toFixed(2));
}
const jsqr = await time(() => context.jsQR(data, width, width, { inversionAttempts: 'dontInvert' })?.data === text);
const wasm = await time(async () => (await decodeImage({ data, width, height: width })).includes(text));
console.log(JSON.stringify({ scope: 'CPU decode only; synthetic QR, not screen-to-camera', image: `${width}x${width}`, payload_bytes: 720, samples_after_warmup: 20, jsqr_median_ms: jsqr, zbar_wasm_median_ms: wasm, median_speedup: Number((jsqr / wasm).toFixed(2)) }, null, 2));
