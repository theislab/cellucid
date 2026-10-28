/**
 * A file's priority record (`uns['cellucid']['priority']`) is verified
 * before the reader relies on it (`priority-layout.js`): its `nObs` is the
 * file's cell count, its `levels` those of that count, the stored position
 * column's first rows ascend in rank. A record that does not describe the
 * file's cells -- a file subset, sorted or written by a newer Cellucid, then
 * saved again with anndata -- is never refused and never misread: the file
 * is read as one Cellucid did not write (each row its own original position,
 * a foreign file's default sampling, the position column an ordinary field),
 * and the opening's note says why. Cellucid-python's `stored_order` and
 * cellucid-r's `.stored_order` read an object by the same rule.
 *
 * The stores are real: `cellucid.prepare()` output, read, changed and
 * written again by anndata on zarr 3 (`scripts/generate-priority-verification-fixtures.py`).
 * Every cell's obs name is `cell<original position>`.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { memoryStore, openZarr } from '../assets/js/formats/zarr/index.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { prefixLevels, readPriorityLayout } from '../assets/js/data/anndata/priority-layout.js';
import { zippedStoreEntries } from './helpers/zarr-corpus.mjs';
import { array, mapping, minimalAnnData, openStore } from './helpers/anndata-store.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'priority');
const N = 300;

async function open(name, cellSubset = null) {
  const entries = await zippedStoreEntries(path.join(FIXTURES, `${name}.zarr.zip`));
  const reader = new AnnDataReader();
  await reader.open(await openZarr(memoryStore(entries), { decodedChunkCacheBytes: 0 }), {
    format: ZARR_FORMAT, name: `${name}.zarr`, decodedChunkBytes: 0, cellSubset,
  });
  return reader;
}

/** The original position the reader names each open cell by, and the obs name it reads there. */
async function namedCells(reader) {
  const subset = reader.cellSubset;
  const positions = subset.openOrder ?? subset.kept ?? Uint32Array.from({ length: reader.nObs }, (_, i) => i);
  return { positions, names: await reader.readObsNames() };
}

const PREFIX = { mode: 'subsample', k: 40 };

test('a file as prepare() wrote it, or read and saved again whole, opens in its priority order', async () => {
  for (const [name, seed] of [['written', 7], ['resaved-seed0', 0], ['no-column', 7]]) {
    for (const request of [null, PREFIX]) {
      const reader = await open(name, request);
      const subset = reader.cellSubset;
      assert.equal(subset.prioritySeed, seed, `${name}: the record describes the file`);
      assert.equal(subset.note, null, `${name}: nothing to say`);
      if (request !== null) {
        assert.equal(subset.prefix, 40, `${name}: the default subsample is the first rows`);
        assert.equal(subset.spec.method, 'uniform');
      }
      // Every cell is named by its original position: its obs name says which.
      const { positions, names } = await namedCells(reader);
      assert.ok(Array.from(positions).every((p, i) => names[i] === `cell${p}`), `${name}: cells named by original position`);
      assert.ok(!reader.obsKeys.includes('cellucid_original_position'), `${name}: the column is not a field`);
      reader.close();
    }
  }
});

test('a record that does not describe the file is read as a file Cellucid did not write, with a note', async () => {
  const cases = [
    ['dropped', N - 1, /written for 300 cells, and the file holds 299 cells/],
    ['sorted', N, /not in its seed's order from row 2 on/],
    ['newer-spec', N, /version 2 of the subsampling specification/],
    ['column-only', N, /cellucid_original_position'\] and no priority record/],
  ];
  for (const [name, nObs, why] of cases) {
    for (const request of [null, PREFIX]) {
      const reader = await open(name, request);
      const subset = reader.cellSubset;
      assert.equal(subset.prioritySeed, null, `${name}: no priority order`);
      assert.match(subset.note ?? '', why, `${name}: the note says why`);
      assert.match(subset.note ?? '', /read in the order stored/, name);
      assert.equal(reader.cellSubset.nObs, nObs);
      if (request !== null) {
        assert.equal(subset.spec.method, 'blocks', `${name}: a foreign file's default sampling`);
        assert.equal(subset.prefix, null);
      }
      // Each row its own original position, never the record's positions.
      const { positions } = await namedCells(reader);
      const rows = request === null ? Array.from({ length: nObs }, (_, i) => i) : Array.from(subset.kept);
      assert.deepEqual([...positions].sort((a, b) => a - b), rows, `${name}: positions are file rows`);
      assert.ok(reader.obsKeys.includes('cellucid_original_position'), `${name}: the column is an ordinary field`);
      reader.close();
    }
  }
});

test('the record is checked against what it claims, piece by piece', async () => {
  const scalar = value => array([BigInt(value)], { dtype: '<i8', shape: [], chunks: [], attrs: { 'encoding-type': 'numeric-scalar', 'encoding-version': '0.2.0' } });
  const n = 50;
  const layout = async given => {
    const record = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined));
    const tree = minimalAnnData({ nObs: n, extra: { uns: mapping({ cellucid: mapping({ priority: mapping(record) }) }) } });
    return readPriorityLayout((await openStore(tree)).root, n);
  };
  const good = { seed: scalar(3), specVersion: scalar(1), nObs: scalar(n), levels: array(BigInt64Array.from(prefixLevels(n), BigInt), { dtype: '<i8' }) };
  assert.equal((await layout(good)).layout.seed, 3);
  assert.equal((await layout({ ...good, levels: undefined })).layout.seed, 3, 'levels are optional');
  const refused = [
    [{ nObs: undefined }, /records no cell count/],
    [{ nObs: scalar(n + 1) }, /written for 51 cells, and the file holds 50 cells/],
    [{ seed: scalar(-1) }, /seed is not a whole number/],
    [{ specVersion: scalar(2) }, /version 2/],
    [{ levels: array(BigInt64Array.from(prefixLevels(n + 1), BigInt), { dtype: '<i8' }) }, /levels are not those of 50 cells/],
    [{ levels: array(BigInt64Array.from(prefixLevels(n).reverse(), BigInt), { dtype: '<i8' }) }, /levels are not those of 50 cells/],
  ];
  for (const [change, why] of refused) {
    const { layout: verified, notice } = await layout({ ...good, ...change });
    assert.equal(verified, null, String(why));
    assert.match(notice, why);
  }
});

test('opening the cells again reads nothing of the position column again', async () => {
  const { countingStore } = await import('./helpers/anndata-store.mjs');
  const { priorityPositions } = await import('../assets/js/data/anndata/priority-layout.js');
  const scalar = value => array([BigInt(value)], { dtype: '<i8', shape: [], chunks: [], attrs: { 'encoding-type': 'numeric-scalar', 'encoding-version': '0.2.0' } });
  const n = 400;
  const order = priorityPositions(5, n);
  const tree = minimalAnnData({
    nObs: n,
    obs: { cellucid_original_position: array(order, { dtype: '<u4', chunks: [128] }) },
    extra: { uns: mapping({ cellucid: mapping({ priority: mapping({ seed: scalar(5), specVersion: scalar(1), nObs: scalar(n) }) }) }) },
  });
  const { store, fetched } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  let reader = new AnnDataReader();
  const recordAndColumn = () => fetched.filter(key => key.startsWith('obs/cellucid_original_position/'));
  await reader.open(root, { format: ZARR_FORMAT, name: 'p.zarr', decodedChunkBytes: 0, cellSubset: { mode: 'subsample', k: 40 } });
  // The column's first chunk only, read with the record.
  assert.deepEqual(recordAndColumn(), ['obs/cellucid_original_position/0']);
  const first = recordAndColumn().length;
  // As the reader worker opens the same store again with other cells
  // (`reopenCells`): a new reader carrying the open one's reads.
  for (const cellSubset of [{ mode: 'subsample', k: 120 }, null, { mode: 'subsample', k: 300 }]) {
    const next = new AnnDataReader();
    await next.open(root, { format: ZARR_FORMAT, name: 'p.zarr', decodedChunkBytes: 0, cellSubset, carry: reader });
    reader = next;
    // The open cells are the first rows, named by the seed's order.
    assert.deepEqual([...(reader.cellSubset.openOrder ?? [])], [...order.subarray(0, reader.nObs)]);
  }
  assert.deepEqual(recordAndColumn().slice(first), [], 'nothing of it read again');
  reader.close();
});
