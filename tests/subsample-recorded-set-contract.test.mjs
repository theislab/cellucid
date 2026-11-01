/**
 * A recorded cell set (a session's `cells`, opened with `{mode: 'kept'}`)
 * opens exactly its cells on a priority-ordered file, also when its
 * specification does not give them again (`reproduced` false): a set saved
 * on a chunk step of a growth, or on another copy or version of the file.
 * Only a set that is exactly the specification's cells is read as the
 * file's first rows (`placeInFile`); any other is placed cell by cell, never
 * refused as a damaged file and never swapped for the specification's cells.
 *
 * The store is real `cellucid.prepare()` output (`fixtures/priority`), whose
 * every cell's obs name is `cell<original position>`.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { memoryStore, openZarr } from '../assets/js/formats/zarr/index.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { zippedStoreEntries } from './helpers/zarr-corpus.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'priority');

async function open(cellSubset) {
  const entries = await zippedStoreEntries(path.join(FIXTURES, 'written.zarr.zip'));
  const reader = new AnnDataReader();
  await reader.open(await openZarr(memoryStore(entries), { decodedChunkCacheBytes: 0 }), {
    format: ZARR_FORMAT, name: 'written.zarr', decodedChunkBytes: 0, cellSubset,
  });
  return reader;
}

/** The original position of each open cell, and whether the obs name read there names it. */
async function namedCells(reader) {
  const subset = reader.cellSubset;
  const positions = subset.openOrder ?? subset.kept ?? Uint32Array.from({ length: reader.nObs }, (_, i) => i);
  const names = await reader.readObsNames();
  return { positions, named: Array.from(positions).every((p, i) => names[i] === `cell${p}`) };
}

test('a recorded set its specification gives again opens as the file\'s first rows', async () => {
  const fitted = await open({ mode: 'subsample', k: 30 });
  const { spec, kept } = fitted.cellSubset;
  assert.equal(fitted.cellSubset.prefix, 30);
  const restored = await open({ mode: 'kept', spec, kept });
  assert.equal(restored.cellSubset.reproduced, true);
  assert.equal(restored.cellSubset.prefix, 30, 'the first 30 rows');
  assert.deepEqual(restored.cellSubset.kept, kept);
  assert.equal((await namedCells(restored)).named, true);
});

test('a recorded set its specification does not give opens exactly its cells, placed cell by cell', async () => {
  const fitted = await open({ mode: 'subsample', k: 30 });
  const { spec, kept } = fitted.cellSubset;
  // The same specification, other cells: one of its cells swapped for one
  // it does not keep (a chunk step's cells, another copy's), or a set with
  // none of its cells.
  const outside = Array.from({ length: 300 }, (_, i) => i).filter(p => !kept.includes(p));
  const swapped = Uint32Array.from([...kept.slice(1), outside[0]]).sort();
  const disjoint = Uint32Array.from(outside.slice(0, 30));
  for (const [label, cells] of [['one cell swapped', swapped], ['no cell shared', disjoint]]) {
    const reader = await open({ mode: 'kept', spec, kept: cells });
    const subset = reader.cellSubset;
    assert.equal(subset.reproduced, false, label);
    assert.equal(subset.prefix, null, `${label}: not read as the first rows`);
    assert.deepEqual(subset.kept, cells, `${label}: exactly the recorded cells`);
    const { positions, named } = await namedCells(reader);
    assert.equal(named, true, `${label}: each open cell's row is that cell's`);
    assert.deepEqual(Uint32Array.from(positions).sort(), cells, label);
  }
});

test('the same set read again with `reproduced` false (a page restored, a reading undone) stays its cells', async () => {
  const fitted = await open({ mode: 'subsample', k: 30 });
  const { spec, kept } = fitted.cellSubset;
  const again = await open({ mode: 'kept', spec, kept, reproduced: false });
  assert.equal(again.cellSubset.reproduced, false);
  assert.deepEqual(again.cellSubset.kept, kept);
  assert.equal((await namedCells(again)).named, true);
});
