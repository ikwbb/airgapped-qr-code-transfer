const CACHE = 'beam-v2';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './protocol.js', './encode-worker.js', './decode-worker.js', './decoder.js', './vendor/qrcode.js', './vendor/zbar.mjs'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('beam-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).catch(() => {
    if (event.request.mode === 'navigate') return caches.match('./index.html');
    return Response.error();
  })));
});
