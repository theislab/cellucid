/**
 * Auto-fit (`data/anndata/subsample-plan.js`): a dataset opens whole when it
 * fits this device, and otherwise as the largest uniform subsample that
 * does, by the real costs: the per-cell working set against the memory
 * allowance, and a cell-major X's gene index (its stored values: the kept
 * cells' share of them) against the column-index budget
 * (`columnIndexResidentBytes`, what the reader budgets an index at).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { annData, dataFrame, dense, mapping, sparse, strings } from './helpers/anndata-store.mjs';
import { openStore } from './helpers/anndata-store.mjs';
import { CELL_WORKING_SET_BYTES, autoFitCount, defaultBlockSize } from '../assets/js/data/anndata/subsample-plan.js';
import { columnIndexResidentBytes } from '../assets/js/data/anndata/matrix-access.js';

async function csrRoot(nObs, nVars, perCell, chunk) {
  const indptr = Int32Array.from({ length: nObs + 1 }, (_, i) => i * perCell);
  const indices = Int32Array.from({ length: nObs * perCell }, (_, e) => e % nVars);
  const X = sparse({ data: new Float32Array(nObs * perCell).fill(1), indices, indptr, shape: [nObs, nVars], compressed: true });
  X.children.indices.chunks = [chunk];
  X.children.data.chunks = [chunk];
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: nObs }, (_, i) => `c${i}`)) }),
    var: dataFrame({ _index: strings(Array.from({ length: nVars }, (_, g) => `g${g}`)) }),
    obsm: mapping({ X_umap: dense(new Float32Array(nObs * 2), [nObs, 2], { chunks: [64, 2] }) }),
    X,
  });
  return (await openStore(tree)).root;
}

test('a dataset that fits opens whole', async () => {
  const root = await csrRoot(200, 10, 5, 100);
  assert.equal(autoFitCount(root, 200, { valuesOnDemand: true, decodedChunkBytes: 1e9, allowanceBytes: 1e9, columnIndexBytes: 1e9 }), null);
});

test('a cell-major X whose gene index does not fit opens the cells whose values fit', async () => {
  const root = await csrRoot(1000, 50, 20, 100);
  const full = columnIndexResidentBytes({ layout: 'sparse', nnz: 20000, nObs: 1000, nVars: 50, valuesOnDemand: true });
  const budget = Math.floor(full / 4);
  const fit = autoFitCount(root, 1000, { valuesOnDemand: true, decodedChunkBytes: 1e9, allowanceBytes: 1e12, columnIndexBytes: budget });
  assert.equal(fit.limit, 'columnIndex');
  assert.equal(fit.neededBytes, full);
  assert.equal(fit.budgetBytes, budget);
  // The kept cells' index fits; one more cell would not.
  const at = k => columnIndexResidentBytes({ layout: 'sparse', nnz: 20 * k, nObs: k, nVars: 50, valuesOnDemand: true });
  assert.ok(at(fit.k) <= budget);
  assert.ok(at(fit.k + 1) > budget);
});

test('cells whose working set does not fit the allowance open as many as fit', async () => {
  const root = await csrRoot(1000, 5, 1, 100);
  const fit = autoFitCount(root, 1000, { valuesOnDemand: false, decodedChunkBytes: 1e9, allowanceBytes: 300 * CELL_WORKING_SET_BYTES, columnIndexBytes: 1e12 });
  assert.deepEqual({ k: fit.k, limit: fit.limit }, { k: 300, limit: 'cells' });
});

test('a block spans about four chunks of a CSR X, in cells', async () => {
  const root = await csrRoot(1000, 50, 20, 100);
  // 100 values a chunk, 20 a cell: 5 cells a chunk, 20 a block.
  assert.equal(defaultBlockSize(root, 1000), 20);
});

test('a block of an X read byte by byte fills a fixed 64 KiB of it: the file decides it, never the link', async () => {
  // Uncompressed chunks are read in part (`partialChunks`): no chunk to align to.
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: 1000 }, (_, i) => `c${i}`)) }),
    var: dataFrame({ _index: strings(Array.from({ length: 50 }, (_, g) => `g${g}`)) }),
    X: sparse({ data: new Float32Array(20000).fill(1), indices: Int32Array.from({ length: 20000 }, (_, e) => e % 50),
      indptr: Int32Array.from({ length: 1001 }, (_, i) => i * 20), shape: [1000, 50], chunks: 100 }),
  });
  const { root } = await openStore(tree);
  assert.equal(root.get('X/indices').partialChunks, true);
  // 20 int32 indices a cell: 80 bytes, 820 cells to 64 KiB.
  assert.equal(defaultBlockSize(root, 1000), Math.ceil(65536 / 80));
  const { resolveCellSubset } = await import('../assets/js/data/anndata/subsample-plan.js');
  const request = { mode: 'subsample', method: 'blocks', k: 100, seed: 3 };
  const [a, b] = await Promise.all([
    resolveCellSubset(root, request, { valuesOnDemand: true, decodedChunkBytes: 1e9 }),
    resolveCellSubset(root, request, { valuesOnDemand: false, decodedChunkBytes: 1e9 }),
  ]);
  assert.deepEqual(a.spec, b.spec);
  assert.deepEqual(Array.from(a.kept), Array.from(b.kept));
});

test('auto-fit opens storage-aligned blocks, and every cell when they fit', async () => {
  const { resolveCellSubset } = await import('../assets/js/data/anndata/subsample-plan.js');
  const root = await csrRoot(1000, 50, 20, 100);
  const budgets = { allowanceBytes: 1e12, columnIndexBytes: 20000 };
  const remote = await resolveCellSubset(root, { mode: 'auto' }, { valuesOnDemand: true, decodedChunkBytes: 1e9, budgets });
  assert.equal(remote.spec.method, 'blocks');
  assert.equal(remote.spec.blockSize, 20);
  assert.equal(remote.kept.length, remote.autoFit.k);
  const local = await resolveCellSubset(root, { mode: 'auto' }, { valuesOnDemand: false, decodedChunkBytes: 1e9, budgets: { ...budgets, columnIndexBytes: 40000 } });
  assert.equal(local.spec.method, 'blocks');
  const whole = await resolveCellSubset(root, { mode: 'auto' }, { valuesOnDemand: true, decodedChunkBytes: 1e9, budgets: { allowanceBytes: 1e12, columnIndexBytes: 1e12 } });
  assert.equal(whole.kept, null);
});
