/**
 * A Zarr store on a web host fails loudly where it would otherwise read
 * wrong: a host that hides paths starting with `_` or `.` (Jekyll, GitHub
 * Pages without `.nojekyll`) is refused instead of reading anndata's
 * `obs/_index` as empty, at no round trip in sequence for a host that serves
 * everything; and a cancelled open or read leaves no unhandled rejection.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ZarrFormatError, httpStore, openZarr } from '../assets/js/formats/zarr/index.js';
import { openDatasetStore } from '../assets/js/data/anndata/open.js';
import { REMOTE_POLICY } from '../assets/js/formats/io/byte-source.js';
import { LinkMeter } from '../assets/js/formats/io/link.js';

import { virtualTime } from './helpers/virtual-time.mjs';

import { corpusEntries } from './helpers/zarr-corpus.mjs';

const HIDDEN = /(^|\/)[_.]/;

/**
 * A fetch serving `entries` as a static host, after `latencyMs`: `hides`
 * answers 404 for a key it matches (Jekyll hides `_` and `.` segments).
 * Records each request with when it started and ended. With `time`
 * (`helpers/virtual-time.mjs`) the latency and those times are on that
 * virtual clock, so they count round trips in a row whatever the load on the
 * machine; without it, on real timers (a sweep of cancels at real moments).
 */
function hostFetch(entries, { hides = null, latencyMs = 0, log = [], time = null } = {}) {
  const now = time?.now ?? (() => performance.now());
  return async (url, init = {}) => {
    const key = decodeURIComponent(new URL(url).pathname.replace(/^\/host\//, ''));
    const entry = { key, start: now(), end: null };
    log.push(entry);
    if (latencyMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = time === null ? setTimeout(resolve, latencyMs) : null;
        if (time !== null) time.sleep(latencyMs).then(resolve);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal.reason);
        }, { once: true });
      });
    }
    if (init.signal?.aborted) throw init.signal.reason;
    entry.end = now();
    const bytes = hides?.test(key) ? undefined : entries.get(key);
    if (bytes === undefined) return new Response(null, { status: 404 });
    return new Response(bytes, { status: 200 });
  };
}

for (const store of ['anndata/v2.zarr', 'anndata/v3.zarr']) {
  test(`${store}: a host hiding "_" paths is refused, not read as empty names`, async () => {
    const entries = await corpusEntries(store);
    // Dot files stay served: a v2 store needs its .zmetadata to get this far.
    const hides = store.includes('v3') ? HIDDEN : /(^|\/)_/;
    const root = await openZarr(httpStore('https://pages.test/host/', { fetch: hostFetch(entries, { hides }) }));
    await assert.rejects(root.get('obs/_index').read(), error => {
      assert.ok(error instanceof ZarrFormatError);
      assert.match(error.message, /hides paths that start with "_" or "\."/);
      assert.match(error.message, /\.nojekyll/);
      assert.match(error.message, /raw\.githubusercontent\.com|gh:/);
      return true;
    });
    // Arrays on served paths read as before.
    assert.equal((await root.get('obs/n_genes').read()).length, root.get('obs/n_genes').shape[0]);
  });
}

test('a host that serves everything costs no round trip in sequence for the check, and opening none', async () => {
  const entries = await corpusEntries('anndata/v3.zarr');
  const log = [];
  const latencyMs = 30;
  const time = virtualTime();
  // The store measures its link on the same clock, as the app's link meter does on the real one.
  const link = new LinkMeter(REMOTE_POLICY, { clock: time.now });
  const root = await openZarr(httpStore('https://host.test/host/', { fetch: hostFetch(entries, { latencyMs, log, time }), concurrency: link }));
  const opened = log.length;
  const started = time.now();
  const names = await root.get('obs/_index').read();
  const elapsed = time.now() - started;
  assert.equal(names.length, root.get('obs/_index').shape[0]);
  // Opening fetched no check; the read's check went out beside its chunk,
  // only for the hidden node it reads.
  assert.ok(log.slice(0, opened).every(entry => !/_index\/zarr\.json$/.test(entry.key)), 'opening fetches no check');
  const checks = log.filter(entry => /_index\/zarr\.json$/.test(entry.key));
  assert.deepEqual(checks.map(entry => entry.key), ['obs/_index/zarr.json']);
  const chunk = log.find(entry => entry.key.startsWith('obs/_index/c/'));
  assert.ok(checks.every(entry => entry.start <= chunk.start));
  // One round trip for the chunk, not two.
  assert.equal(elapsed, latencyMs, `the read took ${elapsed} ms at ${latencyMs} ms a request`);
});

test('a listed store (a picked folder, a ZIP) makes no such check', async () => {
  const entries = await corpusEntries('anndata/v3.zarr');
  const { memoryStore } = await import('../assets/js/formats/zarr/index.js');
  const keysAsked = [];
  const memory = memoryStore(entries);
  const store = { ...memory, get: (key, options) => { keysAsked.push(key); return memory.get(key, options); } };
  const root = await openZarr(store);
  await root.get('obs/_index').read();
  assert.ok(keysAsked.every(key => !key.endsWith('_index/zarr.json')));
});

test('cancelling remote opens and reads at any moment leaves no unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  const platformFetch = globalThis.fetch;
  try {
    for (const store of ['anndata/v2.zarr', 'anndata/v3.zarr', 'anndata/v3-sharded.zarr']) {
      const entries = await corpusEntries(store);
      const fetch = hostFetch(entries, { latencyMs: 2 });
      for (const after of [0, 1, 3, 5, 8, 12]) {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), after);
        const signal = controller.signal;
        globalThis.fetch = fetch;
        const open = openDatasetStore({ source: { url: 'https://host.test/host/', name: 'x.zarr' } },
          { decodedChunkCacheBytes: 1 << 20, signal });
        const opened = await open.catch(error => {
          assert.equal(error.name, 'AbortError');
          return null;
        });
        if (opened === null) continue;
        const reads = ['X/data', 'obs/_index', 'obsm/X_umap', 'obs/n_genes']
          .filter(path => opened.root.get(path) !== null)
          .map(path => opened.root.get(path).read(undefined, { signal }).catch(error => assert.equal(error.name, 'AbortError')));
        await Promise.all(reads);
        // A read asked for after the cancel fetches nothing and fails at once.
        await assert.rejects(opened.root.get('X/data').read(undefined, { signal: AbortSignal.abort() }), { name: 'AbortError' });
        opened.root.close();
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    globalThis.fetch = platformFetch;
  }
  assert.deepEqual(unhandled.map(error => `${error?.name}: ${error?.message}`), []);
});
