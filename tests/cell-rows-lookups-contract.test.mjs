/**
 * The lookups an open subsample's rows make in the reader worker, counted:
 * bytes held and lookups made, never wall clock.
 *
 * - **The inverse of the kept rows** (`KeptPositions`) is a table of the kept
 *   rows for a small share and an array of every row once that holds fewer
 *   bytes: every cell of a 50M-cell priority-ordered store held 1.07 GB as a
 *   table (2^27 slots of 8 bytes) and holds 200 MB as an array; its graph's
 *   first rows were read in 2.26 s, then in 0.18 s.
 * - **What they hold is counted** in the memory model's working set, as this
 *   thread's part (`CellRows` `onHeld`; the reader's `cell rows` part), and
 *   let go when the reader closes: at 50M the reader worker held 2.34 GB
 *   after collection against 0.6 GB counted.
 * - **Kept row pointers are found a run at a time** (`keptEntries`): rows in
 *   file order walk the pointers forward, no lookup at all; the rows the
 *   pointers were read for, in their own order, look each run up once
 *   (`runIndexFor`) and never again; others, one lookup a run, each through
 *   the bucket of its row (`RowPointers.indexOf`). A lookup a row by a
 *   binary search over millions of ranges took 11 s of a 5M-cell induced
 *   subgraph. The pointers are read in one pass over the rows ascending
 *   (`CellRows.ascending`), ranges a few pointers apart one: a 50% uniform
 *   share's ranges are a few, not one a row.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { annData, array, dataFrame, mapping, openReader, sparse, strings } from './helpers/anndata-store.mjs';
import { CellRows, KeptPositions, RowPointers, keptEntries, readKeptRowPointers } from '../assets/js/data/anndata/views/cell-subset.js';
import { memoryReport, resetMemoryModel } from '../assets/js/data/memory-budget.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';
import { openZarr, memoryStore } from '../assets/js/formats/zarr/index.js';
import { zarrEntries } from './helpers/anndata-store.mjs';

/** `count` distinct rows of `n`, in a random (view) order. */
function randomRows(n, count, seed) {
  const random = createMulberry32(seed);
  const rows = new Set();
  while (rows.size < count) rows.add(Math.floor(random() * n));
  return Uint32Array.from(rows);
}

test('the inverse of kept rows takes whichever form holds fewer bytes, and finds every row alike', () => {
  const n = 100_000;
  for (const [count, form] of [[500, 'table'], [5_000, 'table'], [20_000, 'array'], [100_000, 'array']]) {
    const kept = randomRows(n, count, count);
    const positions = new KeptPositions(kept, n);
    const table = new KeptPositions(kept);
    let slots = 2;
    while (slots < 2 * count) slots *= 2;
    assert.equal(positions.byteLength, Math.min(8 * slots, 4 * n), `${count} kept: the smaller form`);
    assert.equal(positions.byteLength === 4 * n ? 'array' : 'table', form);
    assert.equal(table.byteLength, 8 * slots, 'without the axis length, the table');
    const reference = new Int32Array(n).fill(-1);
    kept.forEach((row, i) => { reference[row] = i; });
    for (let row = 0; row < n; row++) {
      assert.equal(positions.get(row), reference[row]);
      if (row % 97 === 0) assert.equal(table.get(row), reference[row]);
    }
    assert.equal(positions.get(n + 3), -1, 'a row past the axis is not kept');
  }
});

test('an open subsample\'s rows tell what they hold as each lookup is made', () => {
  const n = 40_000;
  const kept = randomRows(n, 20_000, 3);
  const told = [];
  const rows = new CellRows(kept, n, { onHeld: bytes => told.push(bytes) });
  assert.deepEqual(told, [kept.byteLength], 'the kept rows, at once');
  const runs = rows.runs();
  const runBytes = runs.starts.byteLength + runs.ends.byteLength + runs.offsets.byteLength;
  rows.positions();
  assert.deepEqual(told, [kept.byteLength, kept.byteLength + runBytes, kept.byteLength + runBytes + 4 * n]);
  assert.equal(rows.byteLength, told.at(-1));
  rows.positions();
  rows.runs();
  assert.equal(told.length, 3, 'made once, told once');
});

/** A CSR `indptr` of `n` rows (row r holds r % 7 entries), as a Zarr array node. */
async function indptrNode(n) {
  const indptr = new Int32Array(n + 1);
  for (let r = 0; r < n; r++) indptr[r + 1] = indptr[r] + (r % 7);
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: n }, (_, i) => `c${i}`)) }),
    var: dataFrame({ _index: strings(['g']) }),
    obsm: mapping({}),
    X: sparse({ data: new Float32Array(indptr[n]).fill(1), indices: new Int32Array(indptr[n]), indptr, shape: [n, 7], chunks: 4096 }),
  });
  const root = await openZarr(memoryStore(zarrEntries(tree), { name: 'p.zarr' }));
  return { node: root.get('X').get('indptr'), indptr: Float64Array.from(indptr) };
}

test('kept entries are found with no pointer lookup for rows in file order, a lookup a run once for the rows the pointers were read for, one a run for others', async () => {
  const n = 60_000;
  const { node, indptr } = await indptrNode(n);
  const kept = randomRows(n, 30_000, 11);
  const rows = new CellRows(kept, n);
  const pointers = await readKeptRowPointers(node, rows, { mergeGapBytes: () => 0 });
  // Half the rows of the file, mostly a row or two apart: ranges up to three
  // pointers apart are one, so a range starts only past a gap of four rows
  // or more (about one gap in sixteen), not at every run.
  assert.ok(pointers.starts.length < rows.ascending().runs().count / 8, `${pointers.starts.length} pointer ranges for ${rows.ascending().runs().count} runs`);
  const lookups = { indexOf: 0, at: 0 };
  const { indexOf, at } = RowPointers.prototype;
  RowPointers.prototype.indexOf = function counted(row) { lookups.indexOf++; return indexOf.call(this, row); };
  RowPointers.prototype.at = function counted(row) { lookups.at++; return at.call(this, row); };
  try {
    // The rows in file order (a pass in store order, `CellRows.byRow`): a walk forward, no lookup.
    const { order, rows: inFileOrder } = rows.byRow();
    assert.equal(inFileOrder, rows.ascending(), 'the rows ascending, made once');
    for (let i = 0; i < order.length; i++) assert.equal(inFileOrder.kept[i], kept[order[i]]);
    const fileOrdered = keptEntries(pointers, inFileOrder);
    assert.deepEqual(lookups, { indexOf: 0, at: 0 }, 'rows in file order: no lookup');
    assert.deepEqual(Array.from(fileOrdered.rowPointers), Array.from(keptEntries(indptr, inFileOrder).rowPointers));
    // The rows the pointers were read for, in their own order: a lookup a run, once.
    const exact = keptEntries(indptr, rows);
    const read = keptEntries(pointers, rows);
    assert.equal(lookups.at, 0);
    assert.ok(lookups.indexOf <= rows.runs().count, `one lookup a run at most (${lookups.indexOf} for ${rows.runs().count} runs)`);
    const once = lookups.indexOf;
    const again = keptEntries(pointers, rows);
    assert.equal(lookups.indexOf, once, 'read again: no lookup');
    assert.deepEqual(Array.from(again.rowPointers), Array.from(exact.rowPointers));
    lookups.indexOf = 0;
    assert.deepEqual(Array.from(read.rowPointers), Array.from(exact.rowPointers));
    assert.deepEqual(Array.from(read.entries.starts), Array.from(exact.entries.starts));
    assert.deepEqual(Array.from(read.entries.ends), Array.from(exact.entries.ends));
    // A slab of the same rows (an induced subgraph reads them a slab at a time).
    const slab = new CellRows(kept.subarray(7_000, 19_000), n);
    const slabExact = keptEntries(indptr, slab);
    const slabRead = keptEntries(pointers, slab);
    assert.equal(lookups.at, 0);
    assert.ok(lookups.indexOf <= slab.runs().count, `one lookup a run at most (${lookups.indexOf} for ${slab.runs().count} runs)`);
    assert.deepEqual(Array.from(slabRead.rowPointers), Array.from(slabExact.rowPointers));
    assert.deepEqual(Array.from(slabRead.entries.offsets), Array.from(slabExact.entries.offsets));
    // Every pointer read is found, a row outside them refused.
    RowPointers.prototype.indexOf = indexOf;
    for (const row of kept) assert.equal(pointers.at(row), indptr[row]);
    const missing = Array.from({ length: n }, (_, r) => r).find(r => !kept.includes(r) && !kept.includes(r - 1));
    assert.throws(() => pointers.at(missing), RangeError);
  } finally {
    RowPointers.prototype.indexOf = indexOf;
    RowPointers.prototype.at = at;
  }
});

test('the reader counts its open subsample\'s rows and their lookups in the working set, and lets them go on close', async () => {
  resetMemoryModel();
  const n = 4_000;
  const k = 3;
  // A ring graph: cell c's neighbours c±1..k.
  const indptr = new Int32Array(n + 1);
  const indices = new Int32Array(n * 2 * k);
  for (let c = 0; c < n; c++) {
    const neighbours = [];
    for (let d = 1; d <= k; d++) neighbours.push((c + d) % n, (c - d + n) % n);
    neighbours.sort((a, b) => a - b).forEach((v, j) => { indices[c * 2 * k + j] = v; });
    indptr[c + 1] = (c + 1) * 2 * k;
  }
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: n }, (_, i) => `c${i}`), { chunks: [512] }), x: array(new Float32Array(n), { chunks: [512] }) }),
    var: dataFrame({ _index: strings(['g']) }),
    obsm: mapping({ X_umap: array(new Float32Array(n * 2), { shape: [n, 2], chunks: [512, 2] }) }),
    obsp: mapping({ connectivities: sparse({ data: new Float32Array(indices.length).fill(1), indices, indptr, shape: [n, n], chunks: 2048 }) }),
  });
  const { reader } = await openReader(tree);
  const parts = () => Object.entries(memoryReport().workingSet).filter(([part]) => part.startsWith('cell rows'));
  await reader.close();
  const { AnnDataReader } = await import('../assets/js/data/anndata/reader.js');
  const { ZARR_FORMAT } = await import('../assets/js/data/anndata/elements.js');
  const root = await openZarr(memoryStore(zarrEntries(tree), { name: 'ring.zarr' }));
  const subset = new AnnDataReader();
  await subset.open(root, { format: ZARR_FORMAT, name: 'ring.zarr', decodedChunkBytes: 0, cellSubset: { mode: 'subsample', method: 'uniform', fraction: 0.5, seed: 5 } });
  const opened = parts();
  assert.equal(opened.length, 1, 'one part: this reader\'s');
  assert.ok(opened[0][1] >= subset.cellSubset.kept.byteLength, 'the kept rows (and the runs the view made of them), counted at once');
  const rows = await subset.getConnectivityRows('connectivities', Uint32Array.of(0, 1, 2));
  assert.equal(rows.offsets.length, 4);
  const [[, held]] = parts();
  assert.ok(held > opened[0][1], 'the inverse made for the graph is counted');
  // Half the cells kept: the inverse is an array of every row (4 bytes a row), not a table.
  assert.equal(held - opened[0][1], 4 * n, 'the inverse, as an array of every row');
  await subset.close();
  assert.deepEqual(parts(), [], 'let go on close');
  resetMemoryModel();
});

test('the ranks a subsample was drawn from are counted with the open rows, each buffer once, and kept for the next size', async () => {
  resetMemoryModel();
  const n = 6_000;
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: n }, (_, i) => `c${i}`), { chunks: [1000] }) }),
    var: dataFrame({ _index: strings(['g']) }),
    obsm: mapping({ X_umap: array(new Float32Array(n * 2), { shape: [n, 2], chunks: [1000, 2] }) }),
  });
  const { AnnDataReader } = await import('../assets/js/data/anndata/reader.js');
  const { ZARR_FORMAT } = await import('../assets/js/data/anndata/elements.js');
  const root = await openZarr(memoryStore(zarrEntries(tree), { name: 'grow.zarr' }));
  const part = () => Object.entries(memoryReport().workingSet).filter(([name]) => name.startsWith('cell rows')).map(([, bytes]) => bytes);
  const step = new AnnDataReader();
  await step.open(root, { format: ZARR_FORMAT, name: 'grow.zarr', decodedChunkBytes: 0, cellSubset: { mode: 'subsample', method: 'uniform', k: 3000, seed: 1 } });
  // What a reader's part holds: its rows, its subset's own arrays (kept, open order), the cache.
  const heldBy = reader => {
    const buffers = new Set([...reader._subsampleCache.buffers(), ...reader._cellSubset.rows.buffers()]);
    for (const value of Object.values(reader._cellSubset)) if (ArrayBuffer.isView(value) && value.byteLength > 0) buffers.add(value.buffer);
    return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
  };
  const union = heldBy(step);
  assert.ok(step._subsampleCache.buffers().has(step._cellSubset.rows.kept.buffer), 'the open rows are the cache\'s selection');
  assert.deepEqual(part(), [union], 'counted once each');
  const last = new AnnDataReader();
  await last.open(root, { format: ZARR_FORMAT, name: 'grow.zarr', decodedChunkBytes: 0, cellSubset: { mode: 'subsample', method: 'uniform', k: 2000, seed: 1 }, carry: step });
  step.releaseStore();
  step.close();
  // Speed before memory (owner, 2026-10-30): the ranks stay for the next size
  // (no second rank pass), counted.
  assert.equal(last._subsampleCache.stats.passes, 1, 'one rank pass for both sizes');
  assert.ok(last._subsampleCache.buffers().size > 0, 'the ranks kept');
  assert.deepEqual(part(), [heldBy(last)], 'its rows, open order and ranks, counted once');
  last.close();
  assert.deepEqual(part(), []);
  resetMemoryModel();
});

test('the row pointers an open subsample\'s matrix holds are counted in the gene-index share, each buffer once', async () => {
  const n = 5_000;
  const perRow = 3;
  const indptr = Int32Array.from({ length: n + 1 }, (_, r) => r * perRow);
  const indices = Int32Array.from({ length: n * perRow }, (_, e) => e % perRow);
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: n }, (_, i) => `c${i}`), { chunks: [1000] }) }),
    var: dataFrame({ _index: strings(['g0', 'g1', 'g2']) }),
    obsm: mapping({ X_umap: array(new Float32Array(n * 2), { shape: [n, 2], chunks: [1000, 2] }) }),
    X: sparse({ data: new Float32Array(n * perRow).fill(1), indices, indptr, shape: [n, perRow], chunks: 1024 }),
  });
  const { AnnDataReader } = await import('../assets/js/data/anndata/reader.js');
  const { ZARR_FORMAT } = await import('../assets/js/data/anndata/elements.js');
  const root = await openZarr(memoryStore(zarrEntries(tree), { name: 'x.zarr' }));
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'x.zarr', decodedChunkBytes: 0, cellSubset: { mode: 'subsample', method: 'uniform', k: 2500, seed: 3 } });
  await reader.getMatrixColumn('X', 1);
  const held = reader._root.heldBuffers();
  assert.ok(held.size > 0, 'the view holds the kept rows\' pointers and what it made of them');
  const viewBytes = [...held].reduce((sum, buffer) => sum + buffer.byteLength, 0);
  assert.ok(viewBytes >= 2500 * 8, 'at least the kept rows\' pointers, 8 bytes a row');
  assert.ok(reader._rowPointerBytes() >= viewBytes, 'counted in the gene-index share');
  reader.close();
});
