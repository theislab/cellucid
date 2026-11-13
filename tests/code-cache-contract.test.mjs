// The code cache (service-worker.js): a deployed page's service worker keeps
// every file whose address names its bytes and answers later visits from it.
// These contracts run the worker in a stand-in of its global scope and pin
// what it answers, what it keeps, what it refuses to keep and what it forgets.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const SOURCE = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');
const SCOPE = 'https://www.cellucid.com/';

const version = text => createHash('sha256').update(text).digest('hex').slice(0, 12);

/** A Cache Storage that keeps responses by URL, per cache name. */
function cacheStorage() {
  const caches = new Map();
  const open = name => {
    if (!caches.has(name)) caches.set(name, new Map());
    const entries = caches.get(name);
    return {
      match: async url => entries.get(url)?.clone(),
      put: async (url, response) => {
        entries.set(url, new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers }));
      },
      keys: async () => [...entries.keys()],
    };
  };
  return {
    caches,
    api: {
      open: async name => open(name),
      keys: async () => [...caches.keys()],
      delete: async name => caches.delete(name),
      match: async url => {
        for (const entries of caches.values()) if (entries.has(url)) return entries.get(url).clone();
        return undefined;
      },
    },
  };
}

/**
 * The worker of `build`, with the network answering from `files` (by URL),
 * each answer once `answering` has resolved.
 */
function startWorker({ build, storage = cacheStorage(), files = new Map(), answering = Promise.resolve() }) {
  const listeners = new Map();
  const network = [];
  const scope = {
    location: { href: `${SCOPE}service-worker.js?build=${build}` },
    registration: { scope: SCOPE },
    addEventListener: (type, listener) => listeners.set(type, listener),
    skipWaiting() {},
    clients: { claim: async () => {} },
  };
  const fetchImpl = async request => {
    const url = typeof request === 'string' ? request : request.url;
    network.push(url);
    await answering;
    if (!files.has(url)) return Object.assign(new Response('missing', { status: 404 }), {});
    const response = new Response(files.get(url), { status: 200, headers: { 'content-type': 'text/javascript' } });
    Object.defineProperty(response, 'type', { value: 'basic' });
    return response;
  };
  new Function('self', 'caches', 'fetch', 'crypto', 'URLPattern', SOURCE)(
    scope, storage.api, fetchImpl, globalThis.crypto, undefined
  );
  const dispatch = async (type, init) => {
    const waits = [];
    let responded = null;
    const event = {
      ...init,
      waitUntil: promise => waits.push(promise),
      respondWith: promise => {
        responded = promise;
      },
    };
    listeners.get(type)(event);
    const response = responded === null ? null : await responded;
    await Promise.all(waits);
    return response;
  };
  return {
    storage,
    network,
    files,
    request: url => dispatch('fetch', { request: new Request(url) }),
    activate: () => dispatch('activate', {}),
    keep: urls => dispatch('message', { data: { keep: urls } }),
  };
}

test('only files of this site whose address names their bytes are answered', async () => {
  const worker = startWorker({ build: '2026-10-29.aaaaaaaa' });
  for (const url of [
    `${SCOPE}`,
    `${SCOPE}index.html`,
    `${SCOPE}assets/img/cellucid-logo.svg`,
    `${SCOPE}assets/js/app/main.js`,
    `${SCOPE}assets/js/app/main.js?v=short`,
    `${SCOPE}assets/js/app/main.js?v=0123456789ab&x=1`,
    `${SCOPE}assets/page/main.js`,
    `${SCOPE}cellucid-web-assets.json`,
    'https://theislab.github.io/cellucid-datasets/anndata/datasets.json',
    'https://example.org/assets/js/app/main.js?v=0123456789ab',
  ]) {
    assert.equal(await worker.request(url), null, url);
  }
  assert.deepEqual(worker.network, [], 'nothing it does not answer is fetched by it');
});

test('a file is answered from this browser once kept, and kept only when its bytes are its address', async () => {
  const main = 'export const a = 1;\n';
  const url = `${SCOPE}assets/js/app/main.js?v=${version(main)}`;
  const worker = startWorker({ build: '2026-10-29.aaaaaaaa', files: new Map([[url, main]]) });
  assert.equal(await (await worker.request(url)).text(), main);
  assert.equal(await (await worker.request(url)).text(), main);
  assert.deepEqual(worker.network, [url], 'the second request is answered from the cache');

  // The CDN answers a new version's address with the previous bytes.
  const stale = `${SCOPE}assets/js/app/main.js?v=${version('export const a = 2;\n')}`;
  worker.files.set(stale, main);
  assert.equal(await (await worker.request(stale)).text(), main, 'passed on');
  assert.equal(await (await worker.request(stale)).text(), main);
  assert.deepEqual(worker.network.filter(request => request === stale).length, 2, 'never kept');

  // A bundle file is named by its content: kept as it is.
  const chunk = `${SCOPE}assets/page/chunk.ABCD2345.js`;
  const bundle = `${SCOPE}assets/workers/decode-worker.0123456789ab.js`;
  worker.files.set(chunk, 'chunk');
  worker.files.set(bundle, 'bundle');
  for (const address of [chunk, bundle]) {
    await worker.request(address);
    await worker.request(address);
    assert.equal(worker.network.filter(request => request === address).length, 1, address);
  }

  // An error is never kept.
  const missing = `${SCOPE}assets/page/chunk.ZZZZ2345.js`;
  assert.equal((await worker.request(missing)).status, 404);
  assert.equal((await worker.request(missing)).status, 404);
  assert.equal(worker.network.filter(request => request === missing).length, 2);
});

test('the files a visit loaded are kept when the page names them, all at once', async () => {
  const main = 'main';
  const url = `${SCOPE}assets/js/app/main.js?v=${version(main)}`;
  const chunk = `${SCOPE}assets/page/main.ABCDEFGH.js`;
  let answer;
  const answering = new Promise(resolve => { answer = resolve; });
  const worker = startWorker({ build: '2026-10-29.aaaaaaaa', files: new Map([[url, main], [chunk, 'entry']]), answering });
  const kept = worker.keep([url, chunk, chunk, `${SCOPE}assets/img/logo.svg`, 'https://example.org/x.js', 42, 'not a url']);
  // Every file is asked for before the first answer: a worker's event has a
  // time limit, and the files one after another take the sum of their fetches.
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(worker.network.sort(), [chunk, url].sort());
  answer();
  await kept;
  assert.deepEqual(worker.network.sort(), [chunk, url].sort(), 'each file once');
  await worker.request(url);
  await worker.request(chunk);
  assert.deepEqual(worker.network.sort(), [chunk, url].sort(), 'the next visit finds them kept');
});

test('a new build reuses what an earlier one kept and forgets all but the newest other build', async () => {
  const storage = cacheStorage();
  const shared = `${SCOPE}assets/page/chunk.SHAR2345.js`;
  const files = new Map([[shared, 'shared']]);
  for (const build of ['2026-10-01.11111111', '2026-10-15.22222222']) {
    await startWorker({ build, storage, files }).request(shared);
  }
  const current = startWorker({ build: '2026-10-29.33333333', storage, files });
  await current.activate();
  assert.deepEqual([...storage.caches.keys()].sort(), ['cellucid-code-2026-10-15.22222222']);
  assert.equal(await (await current.request(shared)).text(), 'shared');
  assert.deepEqual(current.network, [], 'a file an earlier build kept is not fetched again');
  assert.deepEqual(
    [...storage.caches.keys()].sort(),
    ['cellucid-code-2026-10-15.22222222', 'cellucid-code-2026-10-29.33333333']
  );
});

test('when this browser refuses to keep anything, the network answers', async () => {
  const main = 'main';
  const url = `${SCOPE}assets/js/app/main.js?v=${version(main)}`;
  const refusing = {
    caches: new Map(),
    api: {
      open: async () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
      keys: async () => [],
      delete: async () => false,
      match: async () => undefined,
    },
  };
  const worker = startWorker({ build: '2026-10-29.aaaaaaaa', storage: refusing, files: new Map([[url, main]]) });
  assert.equal(await (await worker.request(url)).text(), main);
});
