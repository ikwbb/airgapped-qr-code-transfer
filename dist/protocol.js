/* Beam protocol v1. No network or DOM access. */
export const MAX_FILE = 10 * 1024 * 1024;
export const BLOCK_SIZES = [384, 720, 1024];
export const GROUP = 8;
const ABC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const VALUES = Object.fromEntries([...ABC].map((c, i) => [c, i]));
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = table[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function base45(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) {
    let n = bytes[i] * (i + 1 < bytes.length ? 256 : 1) + (bytes[i + 1] ?? 0);
    out += ABC[n % 45] + ABC[Math.floor(n / 45) % 45];
    if (i + 1 < bytes.length) out += ABC[Math.floor(n / 2025)];
  }
  return out;
}
export function unbase45(text) {
  if (text.length % 3 === 1) throw new Error('Invalid Base45 length');
  const out = new Uint8Array(Math.floor(text.length * 2 / 3));
  let p = 0;
  for (let i = 0; i < text.length; i += 3) {
    const a = VALUES[text[i]], b = VALUES[text[i + 1]], c = VALUES[text[i + 2]];
    if (a === undefined || b === undefined || (i + 2 < text.length && c === undefined)) throw new Error('Invalid Base45 character');
    const n = a + 45 * b + (c ?? 0) * 2025;
    if (c !== undefined) {
      if (n > 65535) throw new Error('Invalid Base45 value');
      out[p++] = n >> 8; out[p++] = n & 255;
    } else {
      if (n > 255) throw new Error('Invalid Base45 value');
      out[p++] = n;
    }
  }
  return out;
}
export function packet(type, id, index, count, blockSize, payload) {
  const bytes = new Uint8Array(24 + payload.length);
  const v = new DataView(bytes.buffer);
  bytes[0] = 1; bytes[1] = type; bytes.set(id, 2);
  v.setUint32(10, index); v.setUint32(14, count); v.setUint16(18, blockSize);
  bytes.set(payload, 20); v.setUint32(bytes.length - 4, crc32(bytes.subarray(0, -4)));
  return 'B1:' + base45(bytes);
}
export function parsePacket(text) {
  if (typeof text !== 'string' || !text.startsWith('B1:') || text.length > 3200) throw new Error('Not a Beam frame');
  const bytes = unbase45(text.slice(3));
  if (bytes.length < 24) throw new Error('Truncated frame');
  const v = new DataView(bytes.buffer);
  if (v.getUint32(bytes.length - 4) !== crc32(bytes.subarray(0, -4))) throw new Error('Frame checksum mismatch');
  const type = bytes[1], count = v.getUint32(14), blockSize = v.getUint16(18), index = v.getUint32(10);
  if (bytes[0] !== 1 || type > 2 || !BLOCK_SIZES.includes(blockSize) || count < 1 || count > Math.ceil(MAX_FILE / blockSize)) throw new Error('Invalid frame header');
  if ((type === 0 && index !== 0) || (type === 1 && index >= count) || (type === 2 && index >= Math.ceil(count / GROUP))) throw new Error('Invalid frame index');
  return { type, id: bytes.slice(2, 10), key: hex(bytes.subarray(2, 10)), index, count, blockSize, payload: bytes.slice(20, -4) };
}
export const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
export async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('Open Beam over HTTPS or localhost to verify files.');
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
async function transform(bytes, stream, limit) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const parts = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new Error('Decoded data exceeds the declared file size.'); }
    parts.push(value);
  }
  const out = new Uint8Array(size); let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
export async function prepareTransfer(file, blockSize = 720, kind = 'file') {
  if (file.size > MAX_FILE) throw new Error('Choose a file of 10 MiB or less.');
  if (!BLOCK_SIZES.includes(blockSize)) throw new Error('Invalid code density.');
  const original = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256(original);
  let packed = original, encoding = 'raw';
  if (globalThis.CompressionStream && original.length > 128) {
    // An incompressible file should never become larger on the wire.
    const compressed = await transform(original, new CompressionStream('gzip'), MAX_FILE + 65536);
    if (compressed.length < original.length) { packed = compressed; encoding = 'gzip'; }
  }
  const id = crypto.getRandomValues(new Uint8Array(8));
  const count = Math.max(1, Math.ceil(packed.length / blockSize));
  const name = [...file.name].slice(0, 160).join('') || 'received-file';
  const meta = { name, size: original.length, packedSize: packed.length, encoding, sha256: hash, kind: kind === 'text' ? 'text' : 'file' };
  const manifest = packet(0, id, 0, count, blockSize, enc.encode(JSON.stringify(meta)));
  const chunks = Array.from({ length: count }, (_, i) => packed.subarray(i * blockSize, (i + 1) * blockSize));
  const parity = Array.from({ length: Math.ceil(count / GROUP) }, (_, group) => {
    const out = new Uint8Array(blockSize);
    for (let i = group * GROUP; i < Math.min(count, (group + 1) * GROUP); i++) {
      for (let j = 0; j < chunks[i].length; j++) out[j] ^= chunks[i][j];
    }
    return out;
  });
  return {
    id, meta, count, blockSize, manifest,
    dataFrame: index => packet(1, id, index, count, blockSize, chunks[index]),
    parityFrame: index => packet(2, id, index, count, blockSize, parity[index]),
  };
}

// Each pass contains all blocks and one XOR repair block per group of eight.
// Shuffling later passes avoids repeatedly missing the same block at a fixed camera rate.
export function makeSchedule(transfer, pass = 0, random = Math.random) {
  const frames = [];
  for (let i = 0; i < transfer.count; i++) {
    frames.push([1, i]);
    if ((i + 1) % GROUP === 0 || i === transfer.count - 1) frames.push([2, Math.floor(i / GROUP)]);
  }
  if (pass > 0) for (let i = frames.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1)); [frames[i], frames[j]] = [frames[j], frames[i]];
  }
  const result = [[0, 0]];
  for (let i = 0; i < frames.length; i++) {
    result.push(frames[i]);
    if ((i + 1) % 15 === 0 && i < frames.length - 1) result.push([0, 0]);
  }
  return result;
}
export function frameAt(transfer, [type, index]) {
  return type === 0 ? transfer.manifest : type === 1 ? transfer.dataFrame(index) : transfer.parityFrame(index);
}

export class Receiver {
  constructor() { this.reset(); }
  reset() {
    this.meta = null; this.key = null; this.blocks = []; this.parity = new Map(); this.pending = [];
    this.received = 0; this.receivedBytes = 0; this.recovered = 0; this.rejected = 0; this.duplicates = 0; this.foreign = 0;
    this.count = 0; this.blockSize = 0; this.startedAt = 0; this.verified = false; this.verifying = null;
  }
  get complete() { return !!this.meta && this.received === this.count; }
  accept(text) {
    let f;
    try { f = parsePacket(text); } catch { this.rejected++; return 'rejected'; }
    if (this.key && f.key !== this.key) { this.foreign++; return 'foreign'; }
    if (f.type === 0) {
      let meta;
      try {
        meta = JSON.parse(dec.decode(f.payload));
        if (!meta || typeof meta.name !== 'string' || !meta.name.length || meta.name.length > 320 || !['raw', 'gzip'].includes(meta.encoding) || !/^[0-9a-f]{64}$/.test(meta.sha256) || (meta.kind !== undefined && !['file', 'text'].includes(meta.kind))) throw 0;
        for (const n of [meta.size, meta.packedSize]) if (!Number.isSafeInteger(n) || n < 0 || n > MAX_FILE) throw 0;
        if (meta.encoding === 'raw' && meta.size !== meta.packedSize) throw 0;
        if (meta.encoding === 'gzip' && meta.packedSize === 0) throw 0;
        if (Math.max(1, Math.ceil(meta.packedSize / f.blockSize)) !== f.count) throw 0;
      } catch { this.rejected++; return 'rejected'; }
      if (this.meta) {
        if (JSON.stringify(meta) !== JSON.stringify(this.meta) || f.count !== this.count || f.blockSize !== this.blockSize) { this.rejected++; return 'rejected'; }
        this.duplicates++; return 'duplicate';
      }
      this.meta = meta; this.key = f.key; this.count = f.count; this.blockSize = f.blockSize;
      this.blocks = new Array(f.count); this.startedAt = Date.now();
      const pending = this.pending; this.pending = [];
      for (const p of pending) if (p.key === this.key) this.add(p);
      return 'manifest';
    }
    if (!this.meta) {
      // Bounded buffer permits joining mid-stream before the next manifest.
      if (!this.pending.some(p => p.key === f.key && p.type === f.type && p.index === f.index)) this.pending.push(f);
      if (this.pending.length > 64) this.pending.shift();
      return 'waiting';
    }
    return this.add(f);
  }
  expectedLength(index) { return Math.min(this.blockSize, this.meta.packedSize - index * this.blockSize); }
  add(f) {
    if (f.count !== this.count || f.blockSize !== this.blockSize || f.payload.length !== (f.type === 1 ? this.expectedLength(f.index) : this.blockSize)) { this.rejected++; return 'rejected'; }
    const group = f.type === 1 ? Math.floor(f.index / GROUP) : f.index;
    if (f.type === 1) {
      if (this.blocks[f.index]) { this.duplicates++; return 'duplicate'; }
      this.blocks[f.index] = f.payload; this.received++; this.receivedBytes += f.payload.length;
    } else {
      if (this.parity.has(group)) { this.duplicates++; return 'duplicate'; }
      this.parity.set(group, f.payload);
    }
    this.repair(group);
    return this.complete ? 'complete' : 'accepted';
  }
  repair(group) {
    const parity = this.parity.get(group);
    if (!parity) return;
    const start = group * GROUP, end = Math.min(this.count, start + GROUP);
    const missing = [];
    for (let i = start; i < end; i++) if (!this.blocks[i]) missing.push(i);
    if (missing.length !== 1) return;
    const data = parity.slice();
    for (let i = start; i < end; i++) if (this.blocks[i]) {
      for (let j = 0; j < this.blocks[i].length; j++) data[j] ^= this.blocks[i][j];
    }
    this.blocks[missing[0]] = data.slice(0, this.expectedLength(missing[0]));
    this.received++; this.receivedBytes += this.blocks[missing[0]].length; this.recovered++;
  }
  async finish() {
    if (!this.complete) throw new Error('File is still incomplete.');
    if (this.verifying) return this.verifying;
    this.verifying = this.verify();
    return this.verifying;
  }
  async verify() {
    const packed = new Uint8Array(this.meta.packedSize);
    this.blocks.forEach((b, i) => packed.set(b, i * this.blockSize));
    let bytes = packed;
    if (this.meta.encoding === 'gzip') {
      if (!globalThis.DecompressionStream) throw new Error('This browser cannot decompress the file. Use a current Chrome, Edge, Firefox, or Safari.');
      bytes = await transform(packed, new DecompressionStream('gzip'), this.meta.size);
    }
    if (bytes.length !== this.meta.size || await sha256(bytes) !== this.meta.sha256) throw new Error('File verification failed. Clear this transfer and scan again.');
    this.verified = true;
    return bytes;
  }
}
