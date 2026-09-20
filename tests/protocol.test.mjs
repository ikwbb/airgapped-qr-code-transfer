import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { decodeImage } from '../dist/decoder.js';
import { crc32, base45, unbase45, packet, parsePacket, prepareTransfer, Receiver, makeSchedule, frameAt, MAX_FILE } from '../dist/protocol.js';

function file(bytes, name = 'binary-test.dat') { return new File([bytes], name); }
function receiveAll(t, r = new Receiver()) {
  for (const item of makeSchedule(t)) r.accept(frameAt(t, item));
  return r;
}
test('CRC-32 and Base45 published vectors, every byte value, and invalid encoding', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(base45(new TextEncoder().encode('AB')), 'BB8');
  assert.equal(base45(new TextEncoder().encode('Hello!!')), '%69 VD92EX0');
  for (const length of [0, 1, 2, 3, 255, 256, 1024]) {
    const bytes = Uint8Array.from({ length }, (_, i) => i % 256);
    assert.deepEqual(unbase45(base45(bytes)), bytes);
  }
  for (const invalid of ['A', 'ZZ', 'ZZZ', 'ab', '00!']) assert.throws(() => unbase45(invalid));
});
test('lossless binary, empty files, exact block boundary, Unicode filenames, and compression', async () => {
  for (const bytes of [new Uint8Array(), new Uint8Array([0, 255]), randomBytes(720), randomBytes(1451), new TextEncoder().encode('廣東話日本語\n'.repeat(5000))]) {
    const t = await prepareTransfer(file(bytes, '測試📄.bin'));
    const r = receiveAll(t);
    assert.ok(r.complete);
    assert.deepEqual(await r.finish(), new Uint8Array(bytes));
    assert.equal(r.meta.name, '測試📄.bin'); assert.ok(r.verified);
  }
});
test('direct text retains Unicode, whitespace, newlines, and its text marker', async () => {
  const text = '  hello\r\n廣東話 👋\n日本語\t\n', bytes = new TextEncoder().encode(text);
  const t = await prepareTransfer(file(bytes, 'message.txt'), 720, 'text');
  const r = receiveAll(t);
  assert.equal(r.meta.kind, 'text');
  assert.equal(new TextDecoder().decode(await r.finish()), text);
  assert.equal(r.receivedBytes, r.meta.packedSize);
});
test('one erasure per group is recovered immediately from parity, with a missing first manifest', async () => {
  const bytes = randomBytes(720 * 35 + 11), t = await prepareTransfer(file(bytes));
  const r = new Receiver();
  for (let i = 0; i < t.count; i++) if (i % 8 !== 2) r.accept(t.dataFrame(i));
  // Join before metadata. Repeated manifests must never erase collected progress.
  r.accept(t.manifest);
  const before = r.received; r.accept(t.manifest); assert.equal(r.received, before);
  for (let i = 0; i < Math.ceil(t.count / 8); i++) r.accept(t.parityFrame(i));
  assert.ok(r.complete); assert.equal(r.recovered, 5);
  assert.deepEqual(await r.finish(), new Uint8Array(bytes));
});
test('lost, corrupt, shuffled, and duplicate frames recover on later passes without resetting', async () => {
  const bytes = randomBytes(140000), t = await prepareTransfer(file(bytes));
  const r = new Receiver();
  let seed = 7919;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const corrupt = text => { const p = unbase45(text.slice(3)); p[p.length - 7] ^= 16; return 'B1:' + base45(p); };
  for (let pass = 0; pass < 8 && !r.complete; pass++) {
    const frames = makeSchedule(t, pass, random);
    for (const frame of frames) {
      const roll = random();
      if (roll < .30) continue;
      const text = frameAt(t, frame);
      const before = r.received;
      r.accept(roll < .40 ? corrupt(text) : text);
      if (roll > .80) r.accept(text);
      assert.ok(r.received >= before, 'retains all good blocks across passes');
    }
  }
  assert.ok(r.complete); assert.ok(r.rejected > 0); assert.ok(r.duplicates > 0);
  assert.deepEqual(await r.finish(), new Uint8Array(bytes));
});
test('two missing blocks wait for a repeat; pause does not require a protocol reset', async () => {
  const bytes = randomBytes(720 * 16), t = await prepareTransfer(file(bytes)), r = new Receiver();
  r.accept(t.manifest);
  for (let i = 0; i < t.count; i++) if (![0, 1].includes(i)) r.accept(t.dataFrame(i));
  r.accept(t.parityFrame(0)); assert.equal(r.complete, false);
  r.accept(t.dataFrame(0)); assert.ok(r.complete); assert.equal(r.recovered, 1);
  assert.deepEqual(await r.finish(), new Uint8Array(bytes));
});
test('foreign sessions and malformed lengths cannot contaminate the active file', async () => {
  const a = await prepareTransfer(file(randomBytes(1000))), b = await prepareTransfer(file(randomBytes(1000)));
  const r = new Receiver(); r.accept(a.manifest);
  assert.equal(r.accept(b.manifest), 'foreign'); assert.equal(r.accept(b.dataFrame(0)), 'foreign');
  assert.equal(r.accept(packet(1, a.id, 0, a.count, a.blockSize, new Uint8Array(2))), 'rejected');
  const p = parsePacket(a.manifest);
  const meta = JSON.parse(new TextDecoder().decode(p.payload));
  meta.size = MAX_FILE + 1;
  assert.equal(new Receiver().accept(packet(0, a.id, 0, a.count, a.blockSize, new TextEncoder().encode(JSON.stringify(meta)))), 'rejected');
  receiveAll(a, r); assert.ok(r.complete);
});
test('final SHA-256 rejects altered payload even if its frame CRC was recomputed', async () => {
  const bytes = randomBytes(600), t = await prepareTransfer(file(bytes)), r = new Receiver();
  r.accept(t.manifest);
  const p = parsePacket(t.dataFrame(0)); p.payload[0] ^= 1;
  r.accept(packet(1, p.id, p.index, p.count, p.blockSize, p.payload));
  assert.ok(r.complete);
  await assert.rejects(r.finish(), /verification failed/); assert.equal(r.verified, false);
});
test('compressed output cannot exceed the declared original size', async () => {
  const t = await prepareTransfer(file(new TextEncoder().encode('compress me!'.repeat(2000))));
  assert.equal(t.meta.encoding, 'gzip');
  const p = parsePacket(t.manifest), meta = { ...t.meta, size: 1 };
  const r = new Receiver();
  r.accept(packet(0, p.id, 0, p.count, p.blockSize, new TextEncoder().encode(JSON.stringify(meta))));
  for (let i = 0; i < t.count; i++) r.accept(t.dataFrame(i));
  await assert.rejects(r.finish(), /exceeds the declared/); assert.equal(r.verified, false);
});
test('pre-manifest queue is bounded and large files are refused', async () => {
  const t = await prepareTransfer(file(randomBytes(720 * 100))), r = new Receiver();
  for (let i = 0; i < t.count; i++) r.accept(t.dataFrame(i));
  assert.equal(r.pending.length, 64);
  await assert.rejects(prepareTransfer({ size: MAX_FILE + 1 }), /10 MiB/);
});

// Test the actual bundled encoder and decoder on raster images, not just packet text.
const qrContext = vm.createContext({ Uint8Array, Uint8ClampedArray, ArrayBuffer, Uint32Array, Int32Array, Uint16Array, Int16Array, TextEncoder, TextDecoder, console });
vm.runInContext(await readFile(new URL('../dist/vendor/qrcode.js', import.meta.url), 'utf8'), qrContext);
vm.runInContext(await readFile(new URL('../dist/vendor/jsQR.js', import.meta.url), 'utf8'), qrContext);
function raster(text, rotate = false, damage = false) {
  const qr = qrContext.QRCode.create([{ data: text, mode: 'alphanumeric' }], { errorCorrectionLevel: 'M' });
  const scale = 4, width = (qr.modules.size + 8) * scale;
  const rgba = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < qr.modules.size; y++) for (let x = 0; x < qr.modules.size; x++) {
    if (!qr.modules.get(y, x)) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const px = (x + 4) * scale + dx, py = (y + 4) * scale + dy;
      const index = (rotate ? px * width + width - py - 1 : py * width + px) * 4;
      rgba[index] = rgba[index + 1] = rgba[index + 2] = 0;
    }
  }
  if (damage) {
    const center = Math.floor(width / 2);
    for (let y = center; y < center + 8; y++) for (let x = center; x < center + 8; x++) {
      const i = (y * width + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = 255;
    }
  }
  return { rgba, width };
}
test('real QR raster roundtrip at all densities, with rotation and small visual damage', async () => {
  for (const size of [384, 720, 1024]) {
    const t = await prepareTransfer(file(randomBytes(size * 2 + 13)), size);
    const r = new Receiver();
    for (const [i, frame] of makeSchedule(t).entries()) {
      const text = frameAt(t, frame), { rgba, width } = raster(text, i % 2 === 1, i % 3 === 0);
      const decoded = qrContext.jsQR(rgba, width, width, { inversionAttempts: 'dontInvert' });
      assert.equal(decoded?.data, text, `density ${size}, frame ${i}`);
      r.accept(decoded.data);
    }
    assert.ok(r.complete); await r.finish(); assert.ok(r.verified);
  }
});
test('production WASM decoder finds two simultaneous QR codes at every density', async () => {
  // Exercise the browser bundle's environment branch under Node, without substituting its WASM.
  const savedProcess = globalThis.process;
  try {
    globalThis.process = undefined;
    await decodeImage({ data: new Uint8ClampedArray(100 * 100 * 4).fill(255), width: 100, height: 100 });
  } finally { globalThis.process = savedProcess; }
  for (const size of [384, 720, 1024]) {
    const bytes = randomBytes(size * 3 + 15), t = await prepareTransfer(file(bytes), size), r = new Receiver();
    const frames = makeSchedule(t).map(item => frameAt(t, item));
    for (let i = 0; i < frames.length; i += 2) {
      const textA = frames[i], textB = frames[(i + 1) % frames.length];
      const a = raster(textA), b = raster(textB, true);
      const height = Math.max(a.width, b.width) + 20, width = a.width + b.width + 40;
      const data = new Uint8ClampedArray(width * height * 4).fill(255);
      for (const [img, left] of [[a, 10], [b, a.width + 30]]) for (let y = 0; y < img.width; y++) {
        data.set(img.rgba.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((y + 10) * width + left) * 4);
      }
      const decoded = await decodeImage({ data, width, height });
      assert.ok(decoded.includes(textA), `first QR at ${size} bytes`);
      assert.ok(decoded.includes(textB), `second QR at ${size} bytes`);
      for (const text of decoded) r.accept(text);
    }
    assert.deepEqual(await r.finish(), new Uint8Array(bytes));
  }
});
