import { prepareTransfer, makeSchedule, frameAt, Receiver, MAX_FILE } from './protocol.js';

const $ = id => document.getElementById(id);
const show = (id, visible = true) => { $(id).hidden = !visible; };
const write = (id, text) => { const element = $(id); if (element.textContent !== text) element.textContent = text; };
function message(id, text, error = false) { write(id, text); $(id).classList.toggle('error', error); }
function format(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / (bytes < 1048576 ? 1024 : 1048576)).toFixed(1)} ${bytes < 1048576 ? 'KiB' : 'MiB'}`;
}
let mode = 'send';
let inputMode = 'file';
let file = null, transfer = null, running = false, preparing = false, preparation = 0;
let schedule = [], cursor = 0, pass = 0, sendTimer = 0, nextDisplayAt = 0;
let encodeWorker = null, encodeGeneration = 0, encodePending = 0, displayQueue = [], displayedAt = [];
let receiver = new Receiver(), stream = null, scanning = false, cameraPending = 0;
let decodeWorker = null, detector = null, decodeBusy = false, cameraGeneration = 0;
let animation = 0, lastVideoTime = -1, lastScanAt = 0, finishPending = false, downloadUrl = null;
let lastAcceptedAt = 0, wakeLock = null, wakeLockPending = false, displayModules = [];
const scanCanvas = document.createElement('canvas');
const scanContext = scanCanvas.getContext('2d', { willReadFrequently: true });
// Start with one large target. Two codes remain available for a capable camera.

async function syncWakeLock() {
  if (!navigator.wakeLock) return;
  const needed = () => (running || scanning) && document.visibilityState === 'visible';
  if (needed()) {
    if (wakeLock || wakeLockPending) return;
    wakeLockPending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      // The camera or signal may have stopped while permission was pending.
      if (!needed()) { await lock.release(); return; }
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
    } catch { /* Optional browser capability. */ }
    finally { wakeLockPending = false; }
  } else if (wakeLock) { const lock = wakeLock; wakeLock = null; try { await lock.release(); } catch {} }
}
function selectMode(next) {
  if (!['send', 'receive'].includes(next)) throw new Error('Choose send or receive.');
  if (next === mode) return;
  if (next === 'receive') pauseSend(); else if (scanning || cameraPending) stopCamera();
  mode = next;
  for (const value of ['send', 'receive']) {
    show(value + '-panel', value === mode);
    $(value + '-tab').classList.toggle('active', value === mode);
    $(value + '-tab').setAttribute('aria-pressed', String(value === mode));
  }
}
$('send-tab').onclick = () => selectMode('send');
$('receive-tab').onclick = () => selectMode('receive');

async function chooseFile(chosen, kind = 'file') {
  if (!chosen) return;
  pauseSend();
  resetEncoder();
  const generation = ++preparation;
  transfer = null; file = null; preparing = true;
  $('send-start').disabled = true; $('density').disabled = true;
  $('dropzone').classList.add('busy');
  write('file-label', chosen.name); write('file-detail', format(chosen.size));
  message('send-message', 'Preparing and checking the file…');
  write('send-status', 'PREPARING FILE');
  show('qr-wrap', false); show('empty-code');
  write('send-size', '—'); write('send-blocks', '—'); write('send-rate', '—');
  try {
    if (chosen.size > MAX_FILE) throw new Error('Choose a file of 10 MiB or less.');
    const prepared = await prepareTransfer(chosen, Number($('density').value), kind);
    if (generation !== preparation) return;
    transfer = prepared; file = chosen; pass = 0; cursor = 0;
    schedule = makeSchedule(transfer);
    drawCode(transfer.manifest);
    fillQueue();
    write('send-size', format(chosen.size)); write('send-blocks', transfer.count.toLocaleString());
    updateCeiling();
    write('send-status', 'READY TO SEND');
    write('send-start', 'Start signal ↗');
    write('send-frame', 'Ready · file information'); write('send-loop', 'AUTO REPEAT');
    const saved = chosen.size ? Math.round((1 - transfer.meta.packedSize / chosen.size) * 100) : 0;
    message('send-message', `${saved > 0 ? `Compressed ${saved}% smaller. ` : ''}Start the receiving camera, then start the signal.`);
    write('send-note', 'The sender repeats until you pause it. Stop after the other device says “File verified”.');
  } catch (error) {
    if (generation !== preparation) return;
    transfer = null; file = null;
    message('send-message', error.message || 'The file could not be prepared.', true);
    write('send-status', 'FILE NOT READY'); write('send-start', 'Choose another file ↗');
    show('qr-wrap', false); show('empty-code');
  } finally {
    if (generation === preparation) {
      preparing = false; $('dropzone').classList.remove('busy');
      $('send-start').disabled = !transfer; $('density').disabled = false;
    }
  }
}
$('file-input').onchange = event => chooseFile(event.target.files[0]);
const dropzone = $('dropzone');
dropzone.addEventListener('dragover', event => { event.preventDefault(); dropzone.classList.add('over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', event => { event.preventDefault(); dropzone.classList.remove('over'); chooseFile(event.dataTransfer.files[0]); });
$('density').onchange = () => { if (file) chooseFile(file, inputMode); };
$('code-count').onchange = () => {
  const resume = running; pauseSend(); resetEncoder();
  if (transfer) {
    try { fillQueue(); updateCeiling(); if (resume) startSend(); }
    catch (error) { resetEncoder(); message('send-message', `Code preparation failed: ${error.message}`, true); }
  }
};
function invalidateInput() {
  pauseSend(); preparation++; resetEncoder(); transfer = null; file = null; preparing = false;
  displayModules = []; show('qr-wrap', false); show('empty-code');
  $('dropzone').classList.remove('busy'); $('density').disabled = false;
  write('send-size', '—'); write('send-blocks', '—'); write('send-rate', '—');
  write('send-status', 'READY WHEN YOU ARE'); write('send-frame', 'Waiting for content');
  const hasText = inputMode === 'text' && $('text-input').value.length > 0;
  $('send-start').disabled = !hasText; write('send-start', hasText ? 'Start text signal ↗' : 'Choose content to begin ↗');
}
function selectInput(next) {
  if (next === inputMode) return;
  inputMode = next; invalidateInput();
  show('dropzone', next === 'file'); show('text-entry', next === 'text');
  for (const kind of ['file', 'text']) {
    $(kind + '-mode').classList.toggle('active', kind === next);
    $(kind + '-mode').setAttribute('aria-pressed', String(kind === next));
  }
  message('send-message', next === 'text' ? 'Paste text, then start the signal. All languages and line breaks are preserved.' : 'Choose any document or file. Its bytes are transferred unchanged.');
  if (next === 'file' && $('file-input').files[0]) chooseFile($('file-input').files[0]);
}
$('file-mode').onclick = () => selectInput('file');
$('text-mode').onclick = () => selectInput('text');
$('text-input').oninput = () => {
  invalidateInput(); write('text-size', format(new TextEncoder().encode($('text-input').value).length));
  message('send-message', 'Ready to send this text. Start the camera on the receiving device.');
};
$('speed').oninput = () => { write('speed-value', `${$('speed').value} fps`); updateCeiling(); };
function updateCeiling() {
  if (!transfer) return;
  const useful = transfer.meta.packedSize / schedule.length * Number($('speed').value) * Number($('code-count').value);
  write('send-rate', `${format(Math.round(useful))}/s`);
  $('send-rate').title = 'Ideal compressed payload per second, after manifest and parity overhead. Actual reception is slower when frames are missed.';
}
function drawCode(text) {
  const qr = QRCode.create([{ data: text, mode: 'alphanumeric' }], { errorCorrectionLevel: 'M' });
  displayModules = [qr.modules]; renderModules();
  show('qr-wrap'); show('empty-code', false);
}
function renderModules() {
  if (!displayModules.length) return;
  // Use whole CSS pixels per module; never smooth a code between sizes.
  const stage = $('send-stage');
  const count = displayModules.length, width = stage.clientWidth - 36, height = stage.clientHeight - 110;
  const sideways = Math.min((width - 16 * (count - 1)) / count, height);
  const stacked = Math.min(width, (height - 16 * (count - 1)) / count);
  const vertical = count > 1 && stacked > sideways;
  $('qr-wrap').classList.toggle('stacked', vertical);
  show('qr-canvas-2', count > 1);
  const available = Math.max(100, count === 1 ? Math.min(width, height) : Math.max(sideways, stacked));
  for (const [index, code] of displayModules.entries()) {
    const modules = code.size, scale = Math.max(1, Math.floor(available / (modules + 8)));
    const size = (modules + 8) * scale;
    const canvas = index ? $('qr-canvas-2') : $('qr-canvas'); canvas.width = size; canvas.height = size;
    canvas.style.width = `${size}px`; canvas.style.height = `${size}px`;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, size, size); context.fillStyle = '#000';
    for (let y = 0; y < modules; y++) for (let x = 0; x < modules; x++) {
      if (code.data[y * modules + x]) context.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale);
    }
  }
}
new ResizeObserver(() => {
  if (displayModules.length && mode === 'send') renderModules();
}).observe($('send-stage'));
function resetEncoder() {
  encodeGeneration++; encodeWorker?.terminate(); encodeWorker = null;
  encodePending = 0; displayQueue = []; displayedAt = [];
}
function fillQueue() {
  if (!transfer) return;
  if (!encodeWorker) {
    const generation = encodeGeneration;
    encodeWorker = new Worker('./encode-worker.js');
    encodeWorker.onmessage = ({ data }) => {
      if (generation !== encodeGeneration || data.generation !== encodeGeneration) return;
      encodePending--;
      if (data.error) { pauseSend(); resetEncoder(); message('send-message', `Code preparation failed: ${data.error}`, true); return; }
      displayQueue.push(data);
    };
    encodeWorker.onerror = () => {
      if (generation !== encodeGeneration) return;
      pauseSend(); resetEncoder(); message('send-message', 'Code preparation could not start. Reload the app and try again.', true);
    };
  }
  // A bounded queue decouples display timing from QR mask search and encoding.
  while (displayQueue.length + encodePending < 6) {
    const texts = [], labels = [];
    for (let i = 0; i < Number($('code-count').value); i++) {
      if (cursor >= schedule.length) { pass++; cursor = 0; schedule = makeSchedule(transfer, pass); }
      const item = schedule[cursor++]; texts.push(frameAt(transfer, item));
      labels.push(item[0] === 0 ? 'File info' : item[0] === 1 ? `Block ${item[1] + 1}` : 'Repair');
    }
    encodePending++;
    encodeWorker.postMessage({ generation: encodeGeneration, texts, label: labels.join(' + '), pass: pass + 1 });
  }
}
function tickSend(now) {
  if (!running || !transfer) return;
  sendTimer = requestAnimationFrame(tickSend);
  if (now + 1 < nextDisplayAt) return;
  try {
    if (!displayQueue.length) { fillQueue(); return; }
    const frame = displayQueue.shift(); displayModules = frame.codes; renderModules();
    show('qr-wrap'); show('empty-code', false);
    write('send-frame', frame.label);
    displayedAt.push(now); while (displayedAt.length > 1 && displayedAt[0] < now - 2000) displayedAt.shift();
    const fps = displayedAt.length > 1 ? Math.round(1000 * (displayedAt.length - 1) / (now - displayedAt[0])) : 0;
    write('send-loop', `PASS ${frame.pass}${fps ? ` · ${fps} FPS` : ''}`);
    nextDisplayAt = now + 1000 / Number($('speed').value);
    fillQueue();
  } catch (error) { pauseSend(); message('send-message', `Could not display the code: ${error.message}`, true); }
}
function startSend() {
  if (!transfer || preparing || running || mode !== 'send' || document.hidden) return;
  try { fillQueue(); }
  catch (error) {
    resetEncoder(); message('send-message', `Code preparation failed: ${error.message}`, true); return;
  }
  running = true; $('density').disabled = true;
  write('send-start', 'Pause signal Ⅱ'); write('send-status', 'SIGNAL LIVE'); $('send-status').classList.add('live');
  message('send-message', 'Signal repeats automatically. Pause when the receiving device confirms the file is verified.');
  nextDisplayAt = 0; displayedAt = [];
  sendTimer = requestAnimationFrame(tickSend); syncWakeLock();
}
function pauseSend() {
  running = false; cancelAnimationFrame(sendTimer); $('density').disabled = preparing;
  $('send-status').classList.remove('live');
  if (transfer) {
    write('send-start', 'Resume signal ↗'); write('send-status', 'SIGNAL PAUSED');
    message('send-message', 'Paused. Resume to continue the same transfer.');
  }
  syncWakeLock();
}
$('send-start').onclick = async () => {
  if (running) { pauseSend(); return; }
  if (inputMode === 'text' && !transfer) {
    await chooseFile(new File([$('text-input').value], 'message.txt', { type: 'text/plain;charset=utf-8' }), 'text');
    if (inputMode !== 'text' || mode !== 'send') return;
  }
  startSend();
  if (running && window.matchMedia('(max-width: 760px)').matches) $('send-stage').scrollIntoView({ block: 'nearest' });
};
$('fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if ($('send-stage').requestFullscreen) await $('send-stage').requestFullscreen();
    else message('send-message', 'Fullscreen is unavailable in this browser. Rotate your device for a larger code.');
  } catch { message('send-message', 'Fullscreen is unavailable here. You can still scan the code.'); }
};
document.addEventListener('fullscreenchange', () => {
  const label = document.fullscreenElement ? 'Exit fullscreen' : 'Expand code to fullscreen';
  $('fullscreen').setAttribute('aria-label', label); $('fullscreen').title = label;
  renderModules();
});

async function setupDecoder(generation) {
  let nativeDetector = null;
  if (globalThis.BarcodeDetector) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) nativeDetector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch { /* Use bundled decoder. */ }
  }
  if (generation !== cameraGeneration) return;
  detector = nativeDetector;
  if (!detector) createDecodeWorker(generation);
  write('decoder-label', 'QR');
}
function createDecodeWorker(generation = cameraGeneration) {
  const worker = new Worker('./decode-worker.js', { type: 'module' });
  decodeWorker = worker;
  const isCurrent = () => generation === cameraGeneration && worker === decodeWorker;
  worker.onmessage = ({ data }) => {
    if (!isCurrent() || data.generation !== cameraGeneration) return;
    decodeBusy = false;
    if (data.error) {
      stopCamera(); message('receive-message', 'The QR decoder could not start. Use a current browser with WebAssembly enabled.', true); return;
    }
    if (scanning) for (const text of data.texts) acceptFrame(text);
  };
  worker.onerror = () => {
    if (!isCurrent()) return;
    stopCamera(); message('receive-message', 'The camera decoder could not load. Reload Beam while online, then try again.', true);
  };
}
async function startCamera() {
  if (cameraPending || scanning || receiver.verified || finishPending || mode !== 'receive' || document.hidden) return;
  if (!navigator.mediaDevices?.getUserMedia || !isSecureContext) {
    message('receive-message', 'Camera access needs HTTPS or localhost. Open the app in a browser using a secure address.', true); return;
  }
  const generation = ++cameraGeneration;
  cameraPending = generation;
  write('camera-start', 'Cancel camera request');
  message('receive-message', 'Waiting for camera access…');
  let candidate = null;
  try {
    const device = $('camera-select').value;
    candidate = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
      ...(device ? { deviceId: { exact: device } } : { facingMode: { ideal: 'environment' } }),
      width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 },
    } });
    if (generation !== cameraGeneration || mode !== 'receive' || document.hidden) { candidate.getTracks().forEach(t => t.stop()); return; }
    stream = candidate;
    $('video').srcObject = stream;
    show('video'); show('camera-empty', false);
    await $('video').play();
    if (generation !== cameraGeneration) return;
    await setupDecoder(generation);
    if (generation !== cameraGeneration) return;
    const devices = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter(d => d.kind === 'videoinput');
    if (generation !== cameraGeneration) return;
    const selectedId = stream.getVideoTracks()[0].getSettings().deviceId;
    $('camera-select').replaceChildren(...devices.map((device, i) => {
      const option = document.createElement('option'); option.value = device.deviceId; option.textContent = device.label || `Camera ${i + 1}`;
      option.selected = device.deviceId === selectedId; return option;
    }));
    show('camera-select', devices.length > 1); show('camera-label', devices.length > 1);
    stream.getVideoTracks()[0].onended = () => {
      if (generation === cameraGeneration) { stopCamera(); message('receive-message', 'The camera disconnected. Your progress is kept; reconnect it and resume.', true); }
    };
    if (stream.getVideoTracks()[0].readyState === 'ended') throw new Error('The camera disconnected. Reconnect it and try again.');
    scanning = true; decodeBusy = false; lastVideoTime = -1; lastScanAt = 0;
    write('camera-start', 'Pause camera Ⅱ'); write('camera-status', 'LOOKING FOR SIGNAL'); $('camera-status').className = 'status-label live';
    message('receive-message', receiver.meta ? 'Camera resumed. Previously received blocks are kept.' : 'Point the camera at the entire code on the sender’s screen.');
    animation = requestAnimationFrame(scan); syncWakeLock();
  } catch (error) {
    candidate?.getTracks().forEach(t => t.stop());
    if (generation !== cameraGeneration) return;
    stopCamera();
    const descriptions = {
      NotAllowedError: 'Camera permission was denied. Allow camera access in your browser settings, then try again.',
      NotFoundError: 'No camera was found. Connect a camera or open Beam on a phone.',
      NotReadableError: 'The camera is busy. Close other apps that use it, then try again.',
      OverconstrainedError: 'That camera is unavailable. Select another camera and try again.',
    };
    message('receive-message', descriptions[error.name] || `Could not start the camera: ${error.message}`, true);
  } finally {
    // An older request must not clear a newer request's pending state.
    if (cameraPending === generation) {
      cameraPending = 0; $('camera-start').disabled = receiver.verified || finishPending;
    }
  }
}
function stopCamera() {
  scanning = false; cameraPending = 0; cameraGeneration++; cancelAnimationFrame(animation); decodeBusy = false;
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  decodeWorker?.terminate(); decodeWorker = null; detector = null;
  $('video').srcObject = null; show('video', false); show('camera-empty');
  write('camera-start', receiver.meta ? 'Resume camera ↗' : 'Start camera ↗');
  $('camera-start').disabled = receiver.verified || finishPending;
  write('camera-status', receiver.meta ? 'CAMERA PAUSED' : 'CAMERA OFF'); $('camera-status').className = 'status-label';
  write('decoder-label', ''); syncWakeLock();
}
$('camera-start').onclick = () => {
  if (scanning || cameraPending) { stopCamera(); message('receive-message', 'Camera paused. Your progress is kept.'); }
  else startCamera();
};
$('camera-select').onchange = async () => { stopCamera(); await startCamera(); };
function scan(now) {
  if (!scanning) return;
  animation = requestAnimationFrame(scan);
  const video = $('video');
  if (decodeBusy || video.readyState < 2 || video.currentTime === lastVideoTime || now - lastScanAt < 8) return;
  lastVideoTime = video.currentTime; lastScanAt = now;
  if (!video.videoWidth || !video.videoHeight) return;
  decodeBusy = true;
  const generation = cameraGeneration;
  if (detector) {
    // Native detection can read the video directly, avoiding a full canvas copy.
    const nativeDetector = detector;
    Promise.resolve().then(() => {
      if (generation !== cameraGeneration || !scanning) return [];
      return nativeDetector.detect(video);
    }).then(codes => {
      if (generation !== cameraGeneration || !scanning) return;
      for (const code of codes) acceptFrame(code.rawValue);
    }).catch(() => {
      if (generation !== cameraGeneration) return;
      // Some implementations advertise QR but fail at runtime. Switch to the local worker.
      detector = null;
      try { createDecodeWorker(generation); }
      catch {
        stopCamera(); message('receive-message', 'The QR decoder could not start. Reload Beam and try again.', true);
      }
    }).finally(() => { if (generation === cameraGeneration) decodeBusy = false; });
  } else if (decodeWorker) {
    try {
      // Preserve detail for dense codes, but bound work per camera frame.
      const scale = Math.min(1, 1920 / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.round(video.videoWidth * scale), height = Math.round(video.videoHeight * scale);
      if (scanCanvas.width !== width || scanCanvas.height !== height) { scanCanvas.width = width; scanCanvas.height = height; }
      scanContext.drawImage(video, 0, 0, width, height);
      const data = scanContext.getImageData(0, 0, width, height);
      decodeWorker.postMessage({ buffer: data.data.buffer, width, height, generation }, [data.data.buffer]);
    } catch {
      stopCamera(); message('receive-message', 'The camera frame could not be read. Resume the camera to try again; your progress is kept.', true);
    }
  } else decodeBusy = false;
}
function acceptFrame(text) {
  if (finishPending || receiver.verified || typeof text !== 'string' || !/^B[12]:/.test(text)) return;
  const before = receiver.collected;
  const result = receiver.accept(text);
  if (result === 'rejected') { write('receive-note', 'A damaged frame was ignored. New repair codes will fill the gap.'); return; }
  if (result === 'foreign') { message('receive-message', 'A different transfer is in view. Resume the original signal or clear this transfer.', true); return; }
  if (result === 'waiting') { updateReceiver(); write('camera-status', 'SIGNAL FOUND'); message('receive-message', 'Signal found. Waiting for file information, which repeats automatically.'); return; }
  if (receiver.collected > before || result === 'accepted' || result === 'manifest' || result === 'complete') {
    lastAcceptedAt = Date.now(); updateReceiver();
    write('camera-status', 'RECEIVING FILE'); write('receive-activity', 'SIGNAL FOUND');
    message('receive-message', 'Keep the code in view. Missing pieces are collected automatically.');
  }
  if (receiver.complete) completeReceive();
}
function updateReceiver() {
  const r = receiver, ratio = r.count ? Math.round(100 * r.collected / r.count) : 0;
  write('receive-title', r.meta?.name || 'Waiting for a file'); write('receive-file', r.meta?.name || 'No signal yet');
  write('percent', `${ratio}%`); $('progress').value = ratio;
  write('received-count', r.count ? `${r.collected.toLocaleString()} / ${r.count.toLocaleString()} pieces` : '0 pieces collected');
  const bytes = r.receivedBytes;
  write('receive-bytes', r.meta ? format(bytes) : '—'); write('recovered', `${r.recovered} blocks`);
  const elapsed = (Date.now() - r.startedAt) / 1000;
  write('receive-rate', r.meta && elapsed > 0 ? `${format(Math.round(bytes / Math.max(1, elapsed)))}/s` : '—');
  $('clear-receive').disabled = !r.meta && r.pending.length === 0;
}
async function completeReceive() {
  finishPending = true; const completed = receiver;
  stopCamera(); $('camera-start').disabled = true;
  write('camera-status', 'VERIFYING FILE'); message('receive-message', 'All blocks received. Checking the complete file…');
  try {
    const bytes = await completed.finish();
    if (receiver !== completed) return;
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    $('download').href = downloadUrl;
    $('download').download = completed.meta.name.replace(/[\\/\u0000-\u001f]/g, '_');
    show('download'); show('verified');
    if (completed.meta.kind === 'text') {
      $('received-text').value = new TextDecoder().decode(bytes);
      show('received-text-wrap'); write('copy-text', 'Copy text');
    }
    write('camera-status', 'FILE VERIFIED'); $('camera-status').className = 'status-label success';
    $('camera-empty').querySelector('h3').textContent = 'Every piece, in place.';
    $('camera-empty').querySelector('p').textContent = 'Your file passed verification and is ready to save.';
    write('receive-activity', 'COMPLETE'); write('camera-start', 'Transfer complete ✓');
    message('receive-message', 'Your file is ready. You can stop the sender now.');
    write('receive-note', `SHA-256 verified · ${format(completed.meta.size)} · ${completed.recovered} blocks recovered with repair codes`);
    $('receive-note').title = completed.meta.sha256;
  } catch (error) {
    if (receiver !== completed) return;
    message('receive-message', error.message || 'The file did not pass verification. Clear this transfer and try again.', true);
    write('camera-status', 'VERIFICATION FAILED'); write('receive-activity', 'NOT SAVED');
    write('camera-start', 'Clear transfer to retry'); $('camera-start').disabled = true;
    write('receive-note', 'No download was created because the file did not pass verification.');
  } finally { if (receiver === completed) finishPending = false; }
}
function resetReceiver() {
  stopCamera(); receiver = new Receiver(); finishPending = false;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = null;
  $('download').removeAttribute('href'); show('download', false); show('verified', false);
  show('received-text-wrap', false); $('received-text').value = '';
  $('camera-start').disabled = false; write('camera-start', 'Start camera ↗');
  write('camera-status', 'CAMERA OFF'); write('receive-activity', 'READY TO SCAN');
  message('receive-message', 'Ready for a new file. Start the camera when the sender is ready.');
  write('receive-note', 'A download becomes available only after the complete file passes verification.'); $('receive-note').removeAttribute('title');
  $('camera-empty').querySelector('h3').textContent = 'Catch the signal.';
  $('camera-empty').querySelector('p').textContent = 'Start your camera, then aim it at the sender’s screen.';
  updateReceiver();
}
$('clear-receive').onclick = () => {
  if (receiver.collected && !receiver.verified && !confirm('Clear the pieces collected for this file?')) return;
  resetReceiver();
};
$('copy-text').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('received-text').value);
    write('copy-text', 'Copied ✓');
  } catch {
    $('received-text').focus(); $('received-text').select();
    message('receive-message', 'Text selected. Use your device’s Copy command, or save the .txt file.');
  }
};
setInterval(() => {
  if (!scanning || finishPending || !receiver.meta) return;
  updateReceiver();
  if (lastAcceptedAt && Date.now() - lastAcceptedAt > 7000) {
    write('receive-activity', 'WAITING FOR PIECES');
    message('receive-message', 'Progress is kept. Hold steady, move closer, or lower the sender’s speed.');
  }
}, 1000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (running) { pauseSend(); message('send-message', 'Signal paused because this tab was hidden. Resume when the receiver is ready.'); }
    if (scanning || cameraPending) { stopCamera(); message('receive-message', 'Camera paused while this tab was hidden. Resume to continue.'); }
  } else syncWakeLock();
});
window.addEventListener('pagehide', event => {
  if (running) pauseSend();
  if (scanning || cameraPending) stopCamera();
  // A back/forward-cache entry keeps the page and its verified download alive.
  if (!event.persisted && downloadUrl) URL.revokeObjectURL(downloadUrl);
});

// Optional browser agent interface. It exposes state and mode navigation only.
// Choosing files and granting camera access still use normal browser controls.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const tools = [
    { name: 'get_transfer_status', description: 'Read the current mode and transfer progress. Does not return file contents.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute(input) {
      if (!input || Object.keys(input).length) throw new Error('This tool takes no arguments.');
      return { mode, sending: running, scanning, blocksReceived: receiver.received, blocksTotal: receiver.count, verified: receiver.verified };
    } },
    { name: 'select_transfer_mode', description: 'Select send or receive. Switching pauses the current signal or camera and preserves received blocks.', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['send', 'receive'] } }, required: ['mode'], additionalProperties: false }, annotations: { readOnlyHint: false }, execute(input) {
      if (!input || Object.keys(input).some(k => k !== 'mode')) throw new Error('Only mode is accepted.');
      selectMode(input.mode); return { mode };
    } },
  ];
  for (const tool of tools) {
    try { Promise.resolve(document.modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch {}
  }
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}
if ('serviceWorker' in navigator && isSecureContext) {
  navigator.serviceWorker.register('./sw.js').then(registration => {
    const updateStatus = () => {
      if (registration.waiting) write('offline-state', 'Update ready · close all Beam tabs and reopen');
      else if (registration.active?.state === 'activated') write('offline-state', 'Ready to reopen offline');
    };
    const watchInstall = () => {
      registration.installing?.addEventListener('statechange', updateStatus);
      updateStatus();
    };
    registration.addEventListener('updatefound', watchInstall);
    watchInstall();
  }).catch(() => { write('offline-state', 'Keep this page open for offline use'); });
}
