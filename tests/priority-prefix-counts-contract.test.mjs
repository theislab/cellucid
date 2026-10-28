/**
 * The prefix counts of a file in priority order (`priority-layout.js`) are
 * held to the gene they count: a count past its gene's values or its level's
 * rows refuses the file, and the rows a count read must be exactly the gene's
 * values below the level, so a damaged table never reads another gene's values
 * or drops a cell's.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { annData, countingStore, dense, mapping } from './helpers/anndata-store.mjs';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { readPrefixCounts, requirePrefixRows } from '../assets/js/data/anndata/priority-layout.js';

async function rootWith(counts, shape) {
  const tree = annData({ varm: mapping({ cellucid_prefix_counts: dense(Uint32Array.from(counts), shape, { dtype: '<u4', chunks: [shape[0], 1] }) }) });
  const { store } = countingStore(tree);
  return openZarr(store, { decodedChunkCacheBytes: 0 });
}

test('a prefix count within its gene and level is read as stored', async () => {
  // Two genes, levels [2, 4]: gene 0 holds 3 values, gene 1 holds 1.
  const root = await rootWith([1, 2, 0, 1], [2, 2]);
  const entries = [3, 1];
  assert.deepEqual(Array.from(await readPrefixCounts(root, 0, 2, {}, { levelRows: 2, entryCounts: g => entries[g] })), [1, 0]);
  assert.deepEqual(Array.from(await readPrefixCounts(root, 1, 2, {}, { levelRows: 4, entryCounts: g => entries[g] })), [2, 1]);
});

test('a prefix count past its gene\'s values or its level\'s rows refuses the file', async () => {
  const root = await rootWith([4, 0], [2, 1]);
  await assert.rejects(readPrefixCounts(root, 0, 2, {}, { levelRows: 10, entryCounts: () => 3 }), /counts 4 values of gene 0 .*damaged/);
  await assert.rejects(readPrefixCounts(root, 0, 2, {}, { levelRows: 3, entryCounts: () => 9 }), /counts 4 values of gene 0 in the first 3 rows/);
  await assert.rejects(readPrefixCounts(root, 1, 2, {}, { levelRows: 3, entryCounts: () => 9 }), /has no column 1/);
});

test('the rows a count read are exactly the gene\'s values below the level', () => {
  // Rows ascending; level 5, count 2: rows 1 and 4 below, the next (7) past it.
  requirePrefixRows(Uint32Array.of(1, 4, 7), 3, 2, 5, 0);
  requirePrefixRows(Uint32Array.of(1, 4), 2, 2, 5, 0);
  assert.throws(() => requirePrefixRows(Uint32Array.of(1, 6, 7), 3, 2, 5, 3), /gene 3 .*value 2 is at row 6/);
  assert.throws(() => requirePrefixRows(Uint32Array.of(1, 4, 4.5), 3, 2, 5, 3), /below the level too/);
});

test('a file\'s original positions are its seed\'s order, computed, the stored column\'s first rows the check', async () => {
  const { priorityPositions } = await import('../assets/js/data/anndata/priority-layout.js');
  const { rankOf } = await import('../assets/js/data/subsample.js');
  const { minimalAnnData, array, mapping } = await import('./helpers/anndata-store.mjs');
  const { AnnDataReader } = await import('../assets/js/data/anndata/reader.js');
  const { ZARR_FORMAT } = await import('../assets/js/data/anndata/elements.js');
  const n = 300;
  const seed = 11;
  const order = Uint32Array.from({ length: n }, (_, p) => p).sort((a, b) => rankOf(seed, a) - rankOf(seed, b));
  assert.deepEqual(priorityPositions(seed, n), order);
  const scalar = value => array([BigInt(value)], { dtype: '<i8', shape: [], chunks: [], attrs: { 'encoding-type': 'numeric-scalar', 'encoding-version': '0.2.0' } });
  const open = async (positions, cellSubset) => {
    const tree = minimalAnnData({
      nObs: n,
      obs: { cellucid_original_position: array(positions, { dtype: '<u4', chunks: [64] }) },
      extra: { uns: mapping({ cellucid: mapping({ priority: mapping({ seed: scalar(seed), specVersion: scalar(1), nObs: scalar(n) }) }) }) },
    });
    const { store } = countingStore(tree);
    const reader = new AnnDataReader();
    await reader.open(await openZarr(store, { decodedChunkCacheBytes: 0 }), { format: ZARR_FORMAT, name: 'p.zarr', decodedChunkBytes: 0, cellSubset });
    return reader;
  };
  const whole = await open(order, null);
  assert.deepEqual(whole.cellSubset.openOrder, order);
  whole.close();
  const prefix = await open(order, { mode: 'subsample', method: 'uniform', k: 40 });
  assert.deepEqual(prefix.cellSubset.openOrder, order.subarray(0, 40));
  prefix.close();
  // A column that is not the seed's order (rows reordered since) is never
  // misread: the file opens as one Cellucid did not write, rows as positions.
  const wrong = Uint32Array.from(order);
  [wrong[3], wrong[4]] = [wrong[4], wrong[3]];
  for (const request of [null, { mode: 'subsample', method: 'uniform', k: 40 }]) {
    const reader = await open(wrong, request);
    assert.equal(reader.cellSubset.prioritySeed, null);
    assert.match(reader.cellSubset.note, /not in its seed's order from row 4 on/);
    reader.close();
  }
});
