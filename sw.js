// Bump this version whenever a bundled asset changes. Each release stays together
// until its tabs close, so an update cannot replace a worker during a transfer.
const CACHE_PREFIX = `beam:${self.registration.scope}:`;
const CACHE = `${CACHE_PREFIX}v3`;
const HOME = new URL('./', self.registration.scope).href;
const INDEX = new URL('./index.html', HOME).href;
const ASSETS = [
  './index.html', './styles.css', './app.js', './protocol.js',
  './encode-worker.js', './decode-worker.js', './decoder.js',
  './vendor/qrcode.js', './vendor/zbar.mjs',
].map(path => new URL(path, HOME).href);

self.addEventListener('install', event => {
  // addAll is atomic: a failed download must not install a partial release.
  event.waitUntil(caches.open(CACHE).then(cache =>
    cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE)
    .map(key => caches.delete(key)))));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  url.search = ''; url.hash = '';
  const asset = url.href === HOME ? INDEX : url.href;
  // A root-hosted copy must not intercept other projects on the same origin.
  if (!ASSETS.includes(asset)) return;
  event.respondWith(caches.open(CACHE)
    .then(cache => cache.match(asset))
    .catch(() => undefined)
    .then(cached => cached || fetch(event.request)));
});
