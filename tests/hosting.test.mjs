import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const workerSource = await readFile(new URL('sw.js', root), 'utf8');

function worker(scope, { stores = new Map(), failInstall = false, failReads = false } = {}) {
  const listeners = new Map(), downloaded = [], fetched = [];
  let online = true;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async addAll(requests) {
          downloaded.push(...requests);
          // Model Cache.addAll's all-or-nothing behavior, including install failure.
          if (failInstall) throw new Error('Asset download failed');
          for (const request of requests) entries.set(request.url, new Response(request.url));
        },
        async match(url) {
          if (failReads) throw new Error('Cache unavailable');
          return entries.get(url)?.clone();
        },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const self = {
    registration: { scope }, location: new URL('sw.js', scope),
    addEventListener(type, listener) { listeners.set(type, listener); },
    skipWaiting() { assert.fail('Updates must wait for existing transfer tabs to close'); },
    clients: { claim() { assert.fail('An installation must not take over an open transfer'); } },
  };
  vm.runInNewContext(workerSource, {
    self, caches, URL, Request,
    async fetch(request) {
      fetched.push(request.url);
      if (!online) throw new Error('Offline');
      return new Response(`network:${request.url}`);
    },
  });
  return {
    stores, downloaded, fetched,
    setOffline() { online = false; },
    async dispatch(type) {
      const pending = [];
      listeners.get(type)({ waitUntil(promise) { pending.push(promise); } });
      assert.ok(pending.length, `${type} must wait for its cache operation`);
      await Promise.all(pending);
    },
    request(url, { method = 'GET', mode = 'same-origin' } = {}) {
      let response;
      listeners.get('fetch')({ request: { url, method, mode }, respondWith(promise) { response = promise; } });
      return response;
    },
  };
}

for (const scope of ['https://beam.example/', 'https://beam.example/beam/']) {
  test(`root assets and offline navigation work when deployed at ${new URL(scope).pathname}`, async () => {
    const sw = worker(scope);
    await sw.dispatch('install');
    await sw.dispatch('activate');
    await stat(new URL('.nojekyll', root));
    const cached = new Set(sw.downloaded.map(request => request.url));
    for (const request of sw.downloaded) {
      assert.equal(request.cache, 'reload', 'installation bypasses stale HTTP caches');
      assert.ok(request.url.startsWith(scope));
      const relative = request.url.slice(scope.length);
      assert.ok((await stat(new URL(relative, root))).isFile(), `${relative} exists at the publish root`);
      const source = await readFile(new URL(relative, root), 'utf8');
      const refs = relative.endsWith('.html')
        ? [...source.matchAll(/(?:src|href)=["'](\.\/[^"']*)["']/g)]
        : [...source.matchAll(/(?:\bfrom\s*|\bimport\s*|\bimportScripts\(\s*|\bnew\s+Worker\(\s*)["'](\.\/[^"']+)["']/g)];
      for (const [, ref] of refs) {
        const url = new URL(ref, request.url).href;
        assert.ok(url === scope || cached.has(url), `${relative}'s ${ref} dependency is cached`);
      }
    }
    sw.setOffline();
    for (const url of [scope, `${scope}?receive`, `${scope}index.html?from=bookmark`, ...cached]) {
      const response = await sw.request(url, { mode: 'navigate' });
      assert.equal(response.status, 200);
    }
    assert.equal(sw.fetched.length, 0, 'cached pages, modules, and workers need no network');
  });
}

test('updates delete only obsolete caches belonging to their own app scope', async () => {
  const scope = 'https://beam.example/beam/';
  const stores = new Map([
    [`beam:${scope}:v1`, new Map()],
    ['beam:https://beam.example/:v1', new Map()],
    ['beam:https://beam.example/beam/other/:v1', new Map()],
    ['beam-v2', new Map()], ['other-app', new Map()],
  ]);
  const sw = worker(scope, { stores });
  await sw.dispatch('install');
  assert.ok(stores.has(`beam:${scope}:v1`), 'installing an update preserves the active cache');
  await sw.dispatch('activate');
  assert.equal(stores.has(`beam:${scope}:v1`), false);
  for (const key of ['beam:https://beam.example/:v1', 'beam:https://beam.example/beam/other/:v1', 'beam-v2', 'other-app']) {
    assert.ok(stores.has(key), `preserves ${key}`);
  }
});

test('an incomplete installation rejects without removing the working release', async () => {
  const scope = 'https://beam.example/beam/', oldCache = `beam:${scope}:v1`;
  const entries = new Map([[`${scope}index.html`, new Response('working release')]]);
  const stores = new Map([[oldCache, entries]]);
  const sw = worker(scope, { stores, failInstall: true });
  await assert.rejects(sw.dispatch('install'), /Asset download failed/);
  assert.equal(await stores.get(oldCache).get(`${scope}index.html`).text(), 'working release');
});

test('only bundled GET assets are intercepted, including on a root-hosted copy', async () => {
  for (const scope of ['https://beam.example/', 'https://beam.example/beam/']) {
    const sw = worker(scope);
    await sw.dispatch('install');
    sw.setOffline();
    for (const url of [`${scope}missing.js`, `${scope}other-project/`, 'https://other.example/app.js']) {
      assert.equal(sw.request(url, { mode: 'navigate' }), undefined);
    }
    assert.equal(sw.request(`${scope}app.js`, { method: 'POST' }), undefined);
    assert.equal(sw.fetched.length, 0);
  }
});

test('cache misses use the network without taking an asset from another release or scope', async () => {
  const scope = 'https://beam.example/beam/', url = `${scope}app.js`;
  const stores = new Map([['unrelated-cache', new Map([[url, new Response('stale module')]])]]);
  const sw = worker(scope, { stores });
  assert.equal(await (await sw.request(url)).text(), `network:${url}`);
  sw.setOffline();
  await assert.rejects(sw.request(url), /Offline/);
});

test('a browser cache read failure still permits online use', async () => {
  const scope = 'https://beam.example/beam/', url = `${scope}index.html`;
  const sw = worker(scope, { failReads: true });
  assert.equal(await (await sw.request(url)).text(), `network:${url}`);
});
