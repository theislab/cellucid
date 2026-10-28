/**
 * Openings of the reader worker that overlap (a cancelled reopen the worker
 * still completes beside the page's restore, a growth's next step asked for
 * before the last one landed): only the newest opening asked for becomes the
 * open dataset, whatever order they complete in, and one that completes all
 * the same (a read inside it that did not stop) is closed, never kept. The
 * store's decoded chunks (`decoded-chunks.js`) are held by every opening
 * reading through them and go only once the last lets go, so no open reader
 * ever reads through chunks let go.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { annData, categorical, dataFrame, dense, mapping, sparse, strings, zarrEntries } from './helpers/anndata-store.mjs';
import { createAnnDataReaderHandler } from '../assets/js/data/anndata-reader-worker.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { DecodedChunks } from '../assets/js/data/anndata/decoded-chunks.js';

const CELLS = 4000;
const GENES = 6;

/** Cell `c` is at row `c`: X_umap holds `[c, c]`, gene `g` of X is `c * GENES + g` (dense) or `c + g / 100` (CSR, where stored). */
function storeFiles({ csr = false, lastModified = 1 } = {}) {
  let X;
  if (csr) {
    const data = [];
    const indices = [];
    const indptr = [0];
    for (let c = 0; c < CELLS; c++) {
      for (let g = 0; g < GENES; g++) {
        if ((c + g) % 3 !== 0) {
          indices.push(g);
          data.push(Math.fround(c + g / 100));
        }
      }
      indptr.push(data.length);
    }
    X = sparse({ format: 'csr', data: Float32Array.from(data), indices: Int32Array.from(indices), indptr: Int32Array.from(indptr), shape: [CELLS, GENES] });
    X.children.data.chunks = [1024];
    X.children.indices.chunks = [1024];
    X.children.indptr.chunks = [256];
  } else {
    X = dense(Float32Array.from({ length: CELLS * GENES }, (_, i) => i), [CELLS, GENES], { chunks: [250, GENES], compressed: true });
  }
  const entries = zarrEntries(annData({
    obs: dataFrame({
      _index: strings(Array.from({ length: CELLS }, (_, i) => `c${i}`), { chunks: [500] }),
      cluster: categorical(Int8Array.from({ length: CELLS }, (_, i) => i % 3), ['a', 'b', 'c']),
    }),
    var: dataFrame({ _index: strings(Array.from({ length: GENES }, (_, g) => `g${g}`)) }),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: CELLS * 2 }, (_, i) => Math.floor(i / 2)), [CELLS, 2], { chunks: [250, 2], compressed: true }) }),
    X,
  }));
  return { files: new Map([...entries].map(([key, bytes]) => [key, new File([bytes], key.split('/').at(-1), { lastModified })])), rootName: 's.zarr' };
}

const subsample = k => ({ mode: 'subsample', method: 'uniform', k, seed: 7, strict: true });

/** The worker's handler, with `call(method, ...args)` (its reply's result, or its error thrown). */
function worker() {
  const handle = createAnnDataReaderHandler({ post: () => {} });
  let id = 0;
  const call = async (method, ...args) => {
    const { reply } = await handle({ id: ++id, method, args });
    if (reply.error) {
      const error = new Error(reply.error.message);
      error.name = reply.error.name ?? 'Error';
      throw error;
    }
    return reply.result;
  };
  return { handle, call, nextId: () => ++id };
}

/** The open cells, by X_umap (cell `c` holds `[c, c]`). */
async function openCells(call) {
  const umap = await call('readObsmColumns', 'X_umap', [0, 1]);
  const cells = [];
  for (let i = 0; i < umap.length / 2; i++) cells.push(umap[2 * i]);
  return cells;
}

/** Follow every decoded-chunk set: reads through one no opening holds any more fail the test. */
function followDecodedChunks(t) {
  const throughLetGo = [];
  const get = DecodedChunks.prototype.get;
  DecodedChunks.prototype.get = function (...args) {
    if (!this.held) throughLetGo.push(args[0]);
    return get.apply(this, args);
  };
  t.after(() => {
    DecodedChunks.prototype.get = get;
  });
  return throughLetGo;
}

/**
 * Hold the next `AnnDataReader.open` until `release()`, then run it as a
 * read that ignores its signal would: to the end.
 */
function holdNextOpening(t) {
  const open = AnnDataReader.prototype.open;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const begun = new Promise(resolve => { started = resolve; });
  let held = false;
  AnnDataReader.prototype.open = async function (store, options) {
    if (held) return open.call(this, store, options);
    held = true;
    started();
    await gate;
    return open.call(this, store, { ...options, signal: null });
  };
  const restore = () => {
    AnnDataReader.prototype.open = open;
  };
  t.after(restore);
  return { release, begun, restore };
}

for (const csr of [false, true]) {
  const kind = csr ? 'a CSR matrix' : 'a dense matrix';

  test(`two reopens of the same store at once: the newer is open, and its decoded chunks stay live through growth (${kind})`, async t => {
    const throughLetGo = followDecodedChunks(t);
    const { call } = worker();
    await call('open', { source: storeFiles({ csr }), cellSubset: subsample(400) });
    await openCells(call);
    await call('getMatrixColumn', 'X', 2);
    const [older, newer] = await Promise.allSettled([
      call('open', { source: storeFiles({ csr }), cellSubset: subsample(800), reopen: true }),
      call('open', { source: storeFiles({ csr }), cellSubset: subsample(1200), reopen: true }),
    ]);
    assert.equal(older.status, 'rejected', 'the older opening, superseded, is not kept');
    assert.equal(older.reason.name, 'AbortError', 'it reads as a cancellation, never a failure');
    assert.equal(newer.status, 'fulfilled');
    assert.equal(newer.value.nObs, 1200);
    let cells = await openCells(call);
    assert.equal(cells.length, 1200, 'the worker holds the newest opening');
    // Growth after the overlap: each step reads through the store's chunks.
    for (const k of [1600, 2400]) {
      const grown = await call('open', { source: storeFiles({ csr }), cellSubset: subsample(k), reopen: true });
      assert.equal(grown.nObs, k);
      cells = await openCells(call);
      assert.equal(cells.length, k);
    }
    for (const g of [0, 2, GENES - 1]) {
      const column = await call('getMatrixColumn', 'X', g);
      assert.equal(column.length, cells.length);
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const expected = csr ? ((c + g) % 3 === 0 ? 0 : Math.fround(c + g / 100)) : c * GENES + g;
        assert.equal(column[i], expected, `gene ${g} of cell ${c}`);
      }
    }
    assert.deepEqual(throughLetGo, [], 'no open reader reads through decoded chunks let go');
  });

  test(`an older opening that completes after the newer one (a read that ignored its signal) is closed, not kept (${kind})`, async t => {
    for (const sameStore of [true, false]) {
      const throughLetGo = followDecodedChunks(t);
      const { call } = worker();
      await call('open', { source: storeFiles({ csr }), cellSubset: subsample(400) });
      const before = await openCells(call);
      const { release, begun, restore } = holdNextOpening(t);
      // The older: the same store again (taken over), or a rewritten one (opened anew).
      const older = call('open', { source: storeFiles({ csr, lastModified: sameStore ? 1 : 2 }), cellSubset: subsample(2000), reopen: true });
      older.catch(() => {});
      await begun;
      const newer = await call('open', { source: storeFiles({ csr }), cellSubset: subsample(600), reopen: true });
      assert.equal(newer.nObs, 600);
      // The older completes now, its signal ignored, after the newer one.
      release();
      await assert.rejects(older, error => error.name === 'AbortError');
      const cells = await openCells(call);
      assert.equal(cells.length, 600, `the newest opening stays open (${sameStore ? 'same store' : 'store opened anew'})`);
      assert.deepEqual(cells.slice(0, 400), before, 'the newest is the uniform subsample grown from the first');
      const column = await call('getMatrixColumn', 'X', 1);
      assert.equal(column.length, 600, 'its store was not closed by the older opening');
      assert.deepEqual(throughLetGo, []);
      restore();
    }
  });
}

test('a reopen the page cancels, sent before its restore, never replaces the restore', async () => {
  const { handle, call, nextId } = worker();
  await call('open', { source: storeFiles({ csr: true }), cellSubset: subsample(600) });
  for (let delay = 0; delay < 12; delay++) {
    const id = nextId();
    const cancelled = handle({ id, method: 'open', args: [{ source: storeFiles({ csr: true }), cellSubset: subsample(3000), reopen: true }] });
    await new Promise(resolve => setTimeout(resolve, delay / 2));
    await handle({ cancel: id });
    const restored = await call('open', { source: storeFiles({ csr: true }), cellSubset: subsample(600), reopen: true });
    assert.equal(restored.nObs, 600);
    await cancelled;
    assert.equal((await openCells(call)).length, 600, `the restore stays open (cancel after ${delay / 2} ms)`);
  }
});
