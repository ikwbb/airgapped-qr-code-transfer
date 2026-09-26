import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8')).replace(/^import .*\n/, '');
const decoderSource = (await readFile(new URL('../decoder.js', import.meta.url), 'utf8')).replace(/^import .*\n/, '').replace('export async function', 'async function');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function cameraStream() {
  const track = { stopped: false, readyState: 'live', stop() { this.stopped = true; this.readyState = 'ended'; }, getSettings: () => ({ deviceId: 'rear' }) };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}
function harness({ media, formats, detect, wakeLock, workerFailure, receiver, confirm = () => true } = {}) {
  const elements = new Map(), workers = [], events = new Map(), frames = new Map();
  let frameId = 0, canvasReads = 0;
  const context2d = {
    fillRect() {}, drawImage() { canvasReads++; },
    getImageData: () => ({ data: new Uint8ClampedArray(16) }),
  };
  const createElement = () => ({
    hidden: false, disabled: false, value: '', textContent: '', style: {}, className: '',
    clientWidth: 900, clientHeight: 600, files: [], readyState: 2, videoWidth: 2, videoHeight: 2, currentTime: 1,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, replaceChildren() {},
    getContext: () => context2d, play: async () => {}, scrollIntoView() {},
    querySelector: () => createElement(),
  });
  const element = id => {
    if (!elements.has(id)) elements.set(id, createElement());
    return elements.get(id);
  };
  element('density').value = '720'; element('code-count').value = '1'; element('speed').value = '10';
  const document = {
    getElementById: element, createElement, hidden: false, visibilityState: 'visible',
    addEventListener(name, callback) { events.set(name, callback); },
  };
  class Worker {
    constructor(url) {
      if (workerFailure?.(url)) throw new Error('Worker unavailable');
      this.url = url; this.messages = []; this.terminated = false; workers.push(this);
    }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  }
  class Receiver {
    constructor() { this.meta = null; this.pending = []; this.received = 0; this.count = 0; this.verified = false; }
  }
  const sandbox = {
    document, navigator: { mediaDevices: { getUserMedia: media || (async () => cameraStream()), enumerateDevices: async () => [] }, wakeLock },
    window: { addEventListener(name, callback) { events.set(name, callback); }, matchMedia: () => ({ matches: false }) },
    Worker, Receiver: receiver ? class { constructor() { return receiver; } } : Receiver,
    ResizeObserver: class { observe() {} }, isSecureContext: true, confirm,
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); }, setInterval() {},
    Uint8Array, Uint8ClampedArray, TextEncoder, TextDecoder, URL, Blob, File, console,
    MAX_FILE: 10 * 1024 * 1024,
    prepareTransfer: async chosen => ({ manifest: 'B2:INFO', count: 1, meta: { packedSize: chosen.size } }),
    makeSchedule: () => [[0, 0], [1, 0]], frameAt: () => 'B2:DATA',
    QRCode: { create: () => ({ modules: { size: 21, data: new Uint8Array(441) } }) },
  };
  if (formats || detect) sandbox.BarcodeDetector = class {
    static getSupportedFormats() { return formats ? formats() : Promise.resolve(['qr_code']); }
    detect(video) { return detect ? detect(video) : Promise.resolve([]); }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  return {
    element, document, workers, events, frames,
    canvasReads: () => canvasReads,
    click: id => element(id).onclick(),
    scan() {
      const [id, callback] = frames.entries().next().value;
      frames.delete(id); callback(100);
    },
  };
}

test('a cancelled camera permission request cannot replace a newer camera', async () => {
  const first = deferred(), second = deferred(); let requests = 0;
  const app = harness({ media: () => (++requests === 1 ? first.promise : second.promise) });
  app.click('receive-tab'); app.click('camera-start');
  assert.equal(app.element('camera-start').textContent, 'Cancel camera request');
  assert.equal(app.element('camera-start').disabled, false);
  app.click('camera-start'); app.click('camera-start');
  const stale = cameraStream(), current = cameraStream();
  first.resolve(stale); await flush();
  assert.equal(stale.track.stopped, true);
  // Cancelling again still cancels the second request after the first settles.
  app.click('camera-start');
  assert.equal(app.element('camera-status').textContent, 'CAMERA OFF');
  second.resolve(current); await flush();
  assert.equal(current.track.stopped, true);
  assert.equal(app.workers.length, 0);
});

test('an old decoder setup cannot overwrite or terminate a resumed camera', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const app = harness({ formats: () => (++calls === 1 ? first.promise : second.promise) });
  app.click('receive-tab'); app.click('camera-start'); await flush();
  app.click('camera-start'); app.click('camera-start'); await flush();
  second.resolve([]); await flush();
  assert.equal(app.workers.length, 1);
  const worker = app.workers[0];
  first.resolve([]); await flush();
  assert.equal(app.workers.length, 1);
  assert.equal(worker.terminated, false);
  assert.equal(app.element('camera-start').textContent, 'Pause camera Ⅱ');
});

test('late worker errors from a paused session do not stop its replacement', async () => {
  const app = harness();
  app.click('receive-tab'); app.click('camera-start'); await flush();
  const stale = app.workers[0];
  app.click('camera-start'); app.click('camera-start'); await flush();
  stale.onerror();
  assert.equal(app.workers[1].terminated, false);
  assert.equal(app.element('camera-start').textContent, 'Pause camera Ⅱ');
});

test('hiding the page cancels pending camera access without starting a background stream', async () => {
  const request = deferred(), stream = cameraStream();
  const app = harness({ media: () => request.promise });
  app.click('receive-tab'); app.click('camera-start');
  app.document.hidden = true; app.document.visibilityState = 'hidden';
  app.events.get('visibilitychange')();
  request.resolve(stream); await flush();
  assert.equal(stream.track.stopped, true);
  assert.equal(app.workers.length, 0);
  assert.equal(app.element('camera-start').disabled, false);
});

test('wake locks are not leaked when camera access is paused before lock acquisition', async () => {
  const request = deferred(); let requests = 0, releases = 0;
  const app = harness({ wakeLock: { request() { requests++; return request.promise; } } });
  app.click('receive-tab'); app.click('camera-start'); await flush();
  app.events.get('visibilitychange')(); app.events.get('visibilitychange')();
  assert.equal(requests, 1);
  app.click('camera-start');
  request.resolve({ release: async () => { releases++; }, addEventListener() {} }); await flush();
  assert.equal(releases, 1);
});

test('native scanning reads video directly and falls back after a runtime failure', async () => {
  let input;
  const app = harness({ detect: video => { input = video; return Promise.reject(new Error('Unsupported source')); } });
  app.click('receive-tab'); app.click('camera-start'); await flush();
  app.scan(); await flush();
  assert.equal(input, app.element('video'));
  assert.equal(app.canvasReads(), 0);
  assert.equal(app.workers.length, 1);
  assert.equal(app.element('camera-start').textContent, 'Pause camera Ⅱ');
});

test('native decoder fallback failures leave a usable resume button', async () => {
  const app = harness({ detect: () => Promise.reject(new Error('Unavailable')), workerFailure: () => true });
  app.click('receive-tab'); app.click('camera-start'); await flush();
  app.scan(); await flush();
  assert.equal(app.element('camera-status').textContent, 'CAMERA OFF');
  assert.match(app.element('receive-message').textContent, /could not start/);
  assert.equal(app.element('camera-start').disabled, false);
});

test('worker creation failures can be retried without starting a broken signal', async () => {
  let fail = false;
  const app = harness({ workerFailure: () => fail });
  await app.element('file-input').onchange({ target: { files: [new File(['hello'], 'hello.txt')] } });
  assert.equal(app.element('code-count').value, '1');
  fail = true; app.element('code-count').onchange();
  assert.match(app.element('send-message').textContent, /Code preparation failed/);
  await app.click('send-start');
  assert.equal(app.frames.size, 0);
  fail = false; await app.click('send-start');
  assert.equal(app.element('send-status').textContent, 'SIGNAL LIVE');
  assert.equal(app.frames.size, 1);
});

test('pre-manifest pieces can be cleared and fountain equations advance visible progress before decoding bytes', async () => {
  let confirmations = 0;
  const receiver = {
    meta: null, pending: [], received: 0, receivedBytes: 0, collected: 0, count: 0, recovered: 0,
    accept() {
      if (!this.meta) { this.pending.push('B2:piece'); return 'waiting'; }
      this.collected++; return 'accepted';
    },
  };
  const app = harness({ receiver, confirm: () => { confirmations++; return false; } });
  app.element('clear-receive').disabled = true;
  app.click('receive-tab'); app.click('camera-start'); await flush();
  app.scan();
  const worker = app.workers[0], generation = worker.messages[0].generation;
  worker.onmessage({ data: { texts: ['B2:piece'], generation } });
  assert.equal(app.element('clear-receive').disabled, false);
  receiver.meta = { name: 'file.txt' }; receiver.count = 4; receiver.startedAt = Date.now();
  worker.onmessage({ data: { texts: ['B2:repair'], generation } });
  assert.equal(app.element('percent').textContent, '25%');
  assert.equal(app.element('received-count').textContent, '1 / 4 pieces');
  assert.equal(app.element('receive-bytes').textContent, '0 B');
  assert.equal(app.element('camera-status').textContent, 'RECEIVING FILE');
  app.click('clear-receive');
  assert.equal(confirmations, 1);
});

test('the production decoder reuses its configured QR-only scanner and accepts both protocol versions', async () => {
  const configs = [], scanners = [], scanner = { setConfig: (...args) => configs.push(args) };
  let created = 0;
  const context = vm.createContext({
    getDefaultScanner: async () => { created++; return scanner; },
    ZBarSymbolType: { ZBAR_NONE: 0, ZBAR_QRCODE: 64 }, ZBarConfigType: { ZBAR_CFG_ENABLE: 0 },
    scanImageData: async (image, used) => {
      scanners.push(used);
      return ['B1:OLD', 'B2:NEW', 'unrelated QR'].map(text => ({ decode: () => text }));
    },
  });
  vm.runInContext(decoderSource, context);
  assert.deepEqual(Array.from(await context.decodeImage({})), ['B1:OLD', 'B2:NEW']);
  await context.decodeImage({});
  assert.equal(created, 1);
  assert.deepEqual(configs, [[0, 0, 0], [64, 0, 1]]);
  assert.equal(scanners.length, 2);
  assert.ok(scanners.every(used => used === scanner));
});
