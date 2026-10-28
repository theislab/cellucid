/**
 * Auto-fit at the largest sizes (`data/anndata/subsample-plan.js`): the
 * per-cell working set is what 100M 3D cells with levels of detail measured
 * (64.6 bytes a cell of physical memory, Chromium on Apple M1 Pro, plus the
 * coloured field and one continuous field with its outlier quantile), so a
 * device opens a count it can hold. On a 16 GB machine (an 8 GB allowance)
 * that is about 104M cells: 100M 3D cells built their levels of detail
 * there, 125M went into swap building them. 200M cells open whole once the
 * allowance holds 200M working sets: a 32 GB device, or 40 bytes a cell at
 * 16 GB.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { annData, dataFrame, openStore, strings } from './helpers/anndata-store.mjs';
import { CELL_WORKING_SET_BYTES, autoFitCount } from '../assets/js/data/anndata/subsample-plan.js';

const GB = 1e9;

async function rootWithoutMatrix() {
  // Only the cell count matters here: no X, so no gene index is costed.
  const tree = annData({ obs: dataFrame({ _index: strings(['c0']) }), var: dataFrame({ _index: strings(['g0']) }) });
  return (await openStore(tree)).root;
}

const fitOf = async (cells, allowanceBytes) => autoFitCount(await rootWithoutMatrix(), cells, {
  valuesOnDemand: false, decodedChunkBytes: GB, allowanceBytes, columnIndexBytes: 1e15,
});

test('the working set is the measured 77 bytes a cell', () => {
  assert.equal(CELL_WORKING_SET_BYTES, 77);
});

test('a 16 GB machine opens about 104M of 200M cells, the count measured to hold', async () => {
  const fit = await fitOf(200_000_000, 8 * GB);
  assert.deepEqual({ k: fit.k, limit: fit.limit }, { k: 103_896_103, limit: 'cells' });
  assert.ok(fit.k >= 100_000_000, '100M 3D cells built their levels of detail on a 16 GB machine');
  assert.ok(fit.k < 125_000_000, '125M went into swap building them');
});

test('200M cells open whole when the allowance holds their working sets', async () => {
  assert.equal(await fitOf(200_000_000, 16 * GB), null, 'a 32 GB device');
  // At 16 GB (an 8 GB allowance) 200M cells need 40 bytes a cell.
  assert.equal(Math.floor((8 * GB) / 200_000_000), 40);
});
