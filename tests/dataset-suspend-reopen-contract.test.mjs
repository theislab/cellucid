/**
 * A dataset no longer shown keeps only what opens it again: one rule for every source (`data-source-manager.js`):
 *
 * - deactivating a source suspends the dataset it showed
 *   (`AnnDataFileSource.suspend`): its page caches are cleared, its reader
 *   worker ends with everything it held (store, gene indexes, row pointers,
 *   caches, decode workers); requests under way end as cancellations;
 * - what the dataset is stays: its cells, its identity, its metadata;
 * - its next read reopens the reader with exactly the same cells, from what
 *   this browser keeps of it before the network: a remote file's bytes the
 *   page fetched are not fetched again (the opening checks the file's
 *   version first, one request, as every opening does);
 * - another dataset opening makes every open one give back its rebuildable
 *   caches first (the reader's decoded chunks, latent hold and decode
 *   workers; the adapter's cached copies), keeping what is shown.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import './helpers/anndata-reader-in-process.mjs';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import { DataSourceManager } from '../assets/js/data/data-source-manager.js';
import { selectDataset } from './helpers/dataset-selection.mjs';
import { cancellationKind, isCancellation } from '../assets/js/utils/abort.js';

const BYTES = new Uint8Array(readFileSync(new URL('./fixtures/gene-read/cellxgene-shaped.h5ad', import.meta.url)));
const URL_OF_FILE = 'https://host.test/data/lung.h5ad';

/** A host serving the file with ranges and an ETag: every request counted. */
function host(t) {
  const original = globalThis.fetch;
  const log = { requests: 0, bytes: 0, ranges: [] };
  globalThis.fetch = async (input, init = {}) => {
    if (init.signal?.aborted) throw init.signal.reason;
    const range = new Headers(init.headers ?? {}).get('Range');
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    log.requests++;
    log.ranges.push(`${init.method ?? 'GET'} ${range}`);
    if (match !== null) log.bytes += Math.min(Number(match[2]), BYTES.length - 1) - Number(match[1]) + 1;
    const headers = { ETag: '"v1"', 'Last-Modified': 'Tue, 27 Oct 2026 10:00:00 GMT', 'Accept-Ranges': 'bytes' };
    if (match === null) return new Response(BYTES.slice(), { status: 200, headers: { ...headers, 'Content-Length': String(BYTES.length) } });
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), BYTES.length - 1);
    return new Response(BYTES.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${BYTES.length}`, 'Content-Length': String(end - start + 1) },
    });
  };
  t.after(() => { globalThis.fetch = original; });
  return log;
}

function quiet(t) {
  const { log, info, debug } = console;
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
  t.after(() => Object.assign(console, { log, info, debug }));
}

const remoteFile = () => ({ url: URL_OF_FILE, size: BYTES.length, name: 'lung.h5ad', identity: Object.freeze({ kind: 'remote', key: 'url:lung', version: 'etag:"v1"' }) });
const sub = k => ({ mode: 'subsample', method: 'blocks', k, seed: 0, blockSize: 10 });

test('a suspended dataset ends its reader, keeps what it is, and reopens the same cells from what the page keeps, fetching only its version check', async t => {
  quiet(t);
  const log = host(t);
  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  await source.loadFile(remoteFile());
  await source.reopenCells({ cellSubset: sub(100) });
  const cells = source.getCellSubset();
  const identity = source.getCellIdentity();
  const key = source.getObsFields().fields.find(field => field.kind === 'category')?.key ?? source.getObsFields().fields[0].key;
  const first = await source.getAdapter().getObsFieldData(key);
  const worker = source._loader._worker;
  assert.ok(worker !== null);

  // The bytes the reader fetched reach the page's range cache as messages
  // (`range-cache.js`, `keep`) still queued as the dataset stops being shown
  // in the same task: the channel stays open until the reader has left
  // (`endRangeCachePort`), so none is dropped.
  // A read under way when the dataset stops being shown ends as a cancellation.
  const pending = source._loader._call('getDatasetMetadata');
  source.suspend();
  const stopped = await pending.then(() => null, error => error);
  assert.ok(stopped === null || isCancellation(stopped), `a cancellation, not a failure: ${stopped}`);
  assert.equal(source._loader._worker, null, 'the reader worker ended');
  assert.ok(worker.messages.some(message => message.leave === true), 'asked to leave: what it keeps of its files is completed, then it ends');
  // What the dataset is stays.
  assert.equal(source.getCellSubset(), cells);
  assert.equal(source.getCellIdentity(), identity);
  assert.equal(source.getAdapter()._obsFieldDataCache.size, 0, 'its page caches are cleared');

  // Read again: the reader reopens with exactly the same cells, from the
  // bytes the page kept (`byte-range-cache.js`): nothing is fetched.
  const before = { requests: log.requests, bytes: log.bytes };
  const again = await source.getAdapter().getObsFieldData(key);
  assert.ok(source._loader._worker !== null, 'reopened on demand');
  assert.deepEqual(source._loader.cellSubset.kept, cells.kept, 'the same cells');
  assert.deepEqual(new Uint8Array(again.data), new Uint8Array(first.data), 'the same values');
  // One request: the opening's check of the file's version (every opening
  // checks it before any kept byte is used); the obs column, the gene names
  // and the embedding come from what the page kept.
  // That check is explicit: the file's first byte asked of the host, past
  // everything kept, under the validators it was opened with
  // (`kept-parts.js` `confirmFileVersion`), however much of it is kept.
  assert.deepEqual(log.ranges.slice(before.requests), ['GET bytes=0-0'], 'only the version check');
  const settled = { requests: log.requests };
  await source.getAdapter().getObsFieldData(key);
  assert.equal(log.requests, settled.requests, 'reads after it fetch nothing');
});

test('deactivating a source suspends the dataset it showed: one rule for every source', async () => {
  const manager = new DataSourceManager();
  const metadata = id => Object.freeze({
    id, name: id, description: '',
    stats: Object.freeze({ n_cells: 1, n_genes: 0, n_obs_fields: 0, n_categorical_fields: 0, n_continuous_fields: 0, has_connectivity: false, n_edges: null }),
    embeddings: Object.freeze({ default_dimension: 2, defaults: Object.freeze({ '2d': 'X_umap' }), items: Object.freeze({ X_umap: Object.freeze({ label: 'X_umap', dimension: 2, path: 'obsm/0/0-1', source: Object.freeze({ key: 'X_umap', columns: Object.freeze([0, 1]) }) }) }) }),
    obs_fields: Object.freeze([]),
  });
  const calls = [];
  const wrapper = type => ({
    async getMetadata(id) { return metadata(id); },
    getBaseUrl(id) { return `anndata://${id}/`; },
    getType() { return type; },
    onDeactivate() { calls.push(`${type}: onDeactivate`); },
    getAnnDataSource(id) { return { suspend: () => calls.push(`${type}: suspend ${id}`) }; },
  });
  // Every kind of source: a file from this computer, a link, a served
  // (Python or R) dataset, a notebook's own viewer.
  for (const type of ['local-user', 'link', 'remote', 'jupyter']) manager.registerSource(type, wrapper(type));
  await selectDataset(manager, 'local-user', 'a');
  await selectDataset(manager, 'link', 'b');
  await selectDataset(manager, 'remote', 'c');
  await selectDataset(manager, 'jupyter', 'd');
  assert.deepEqual(calls, [
    'local-user: onDeactivate', 'local-user: suspend a',
    'link: onDeactivate', 'link: suspend b',
    'remote: onDeactivate', 'remote: suspend c',
  ]);
});

test('another dataset opening makes the open ones give back their rebuildable caches first, keeping what is shown', async t => {
  quiet(t);
  host(t);
  const shownSource = new AnnDataFileSource();
  t.after(() => shownSource.clear());
  await shownSource.loadFile(remoteFile());
  const adapter = shownSource.getAdapter();
  adapter._cacheObsFieldData('kept-copy', { values: new Float32Array(10) });
  const released = [];
  const releaseCaches = shownSource._loader.releaseCaches.bind(shownSource._loader);
  shownSource._loader.releaseCaches = (level, reason) => {
    released.push([level, reason]);
    releaseCaches(level, reason);
  };
  const next = new AnnDataFileSource();
  t.after(() => next.clear());
  await next.loadFile(remoteFile());
  assert.deepEqual(released, [['caches', 'another dataset opens']], 'the reader gives back what it rebuilds cheaply');
  assert.equal(adapter._obsFieldDataCache.size, 0, 'the adapter\'s cached copies go');
  assert.ok(shownSource._loader._worker !== null, 'what is shown stays open');
});

/** A page's `window` for the reader client's `pagehide` listener, in place of none (node). */
function pageWindow(t) {
  const target = new EventTarget();
  const had = Object.hasOwn(globalThis, 'window');
  const previous = globalThis.window;
  globalThis.window = target;
  t.after(() => {
    if (had) globalThis.window = previous;
    else delete globalThis.window;
  });
  return {
    hide(persisted) {
      const event = new Event('pagehide');
      event.persisted = persisted;
      target.dispatchEvent(event);
    },
  };
}

test('a page put in the back/forward cache keeps its reader: the reads under way go on, nothing is stopped', async t => {
  quiet(t);
  host(t);
  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  // After the source's own clear is registered: it runs while the window is still there.
  const page = pageWindow(t);
  await source.loadFile(remoteFile());
  const worker = source._loader._worker;
  const pending = source._loader._call('getDatasetMetadata');
  // Frozen with its worker, and maybe restored as it was.
  page.hide(true);
  assert.ok(await pending, 'the read under way answers');
  assert.equal(source._loader._worker, worker, 'the same worker reads on');
  assert.ok(!worker.messages.some(message => message.leave === true), 'it was not asked to leave');
});

test('a page really left ends its reader: reads under way end as page-left cancellations, the next read reopens it', async t => {
  quiet(t);
  host(t);
  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  // After the source's own clear is registered: it runs while the window is still there.
  const page = pageWindow(t);
  await source.loadFile(remoteFile());
  await source.reopenCells({ cellSubset: sub(100) });
  const cells = source.getCellSubset();
  const worker = source._loader._worker;
  const pending = source._loader._call('getDatasetMetadata');
  page.hide(false);
  const ended = await pending.then(() => null, error => error);
  assert.ok(ended === null || cancellationKind(ended) === 'page-left', `nothing failed: ${ended}`);
  assert.ok(worker.messages.some(message => message.leave === true), 'the one way a reader worker ends: asked to leave');
  // Should the page come back after all, the next read reopens the same cells.
  const key = source.getObsFields().fields[0].key;
  assert.ok(await source.getAdapter().getObsFieldData(key));
  assert.deepEqual(source._loader.cellSubset.kept, cells.kept);
});
