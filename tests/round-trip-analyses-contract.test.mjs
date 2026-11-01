/**
 * Analyses on a share lowered and raised back to every cell in place read
 * genes as cheaply as on a first opening of every cell.
 *
 * Raised back in place, the open cells keep the share's first: every cell
 * opens in the share's cell order (a permutation of the file's rows), and
 * its gene index is in segments -- the share's carried, the rest in store
 * order answered in open order (`prefix-column-index.js`
 * `fileOrderedAccess`, a gene's entries mapped and put in order). Measured
 * on a 10M-cell Zarr (Chromium, every cell): differential expression 9.4 s
 * on the first opening, 35.9 s after the round trip; 1M: 1.5 s and 9.0 s,
 * and without a gene read before the round trip the run failed after
 * 3 min 50 s (a read of 8,610 genes asked every gene's column at once).
 *
 * - **A cell subset reaching the last segment is read by the run's priced
 *   route** (`getMatrixCellSubset`): the read of each gene's first rows
 *   (`_sparseColumnRows`) is for cells among the first open cells (an
 *   analysis's first pass), and only where it reads fewer rows than the
 *   gene's column (`_readsFewerColumnRows`). Two groups of every cell
 *   reach the last row: they read every gene's whole column a read through
 *   it, every gene of the read at once, unpriced.
 * - **Putting a gene's entries in order is linear in its entries**
 *   (`utils/radix-order.js`): a digit has no more values than there are
 *   keys. A fixed 16-bit digit walked 65,536 counts a pass whatever the keys
 *   (6 s of the 1M run's differential expression).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { annData, countingStore, dataFrame, dense, mapping, sparse, strings } from './helpers/anndata-store.mjs';
import { opfsOnDisk } from './helpers/opfs-on-disk.mjs';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';
import { orderByKey, sortByKeyWithValues, sortUint32 } from '../assets/js/utils/radix-order.js';
import { fileOrderedAccess, restrictedAccess } from '../assets/js/data/anndata/prefix-column-index.js';
import { runsOfPositions } from '../assets/js/data/anndata/views/cell-subset.js';

const N_OBS = 6000;
const N_VARS = 40;

/** A CSR X of `N_OBS` cells (`nVars` genes, `density` of them stored a cell) in small chunks, and its dense values (cell-major). */
function csrTree({ nVars = N_VARS, density = 0.3 } = {}) {
  const N_VARS = nVars;
  const random = createMulberry32(17);
  const values = new Float32Array(N_OBS * N_VARS);
  const data = [];
  const indices = [];
  const indptr = [0];
  for (let cell = 0; cell < N_OBS; cell++) {
    for (let gene = 0; gene < N_VARS; gene++) {
      if (random() < density) {
        const value = Math.fround(1 + random() * 9);
        values[cell * N_VARS + gene] = value;
        indices.push(gene);
        data.push(value);
      }
    }
    indptr.push(data.length);
  }
  const X = sparse({ format: 'csr', data: Float32Array.from(data), indices: Int32Array.from(indices), indptr: Int32Array.from(indptr), shape: [N_OBS, N_VARS], compressed: true });
  X.children.data.chunks = [512];
  X.children.indices.chunks = [512];
  X.children.indptr.chunks = [256];
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: N_OBS }, (_, i) => `c${i}`), { chunks: [500] }) }),
    var: dataFrame({ _index: strings(Array.from({ length: N_VARS }, (_, g) => `g${g}`)) }),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: N_OBS * 2 }, (_, i) => i), [N_OBS, 2], { chunks: [500, 2], compressed: true }) }),
    X,
  });
  return { tree, values, indptr };
}

const BLOCKS = k => ({ mode: 'subsample', method: 'blocks', k, seed: 0, blockSize: 25, strict: true });

/** A link slower than a disk, measured (an opening of every cell over it takes a cell order). */
function slowLink(latencyMs) {
  const snapshot = { measured: latencyMs > 0, latencyMs, bytesPerMs: 1000, concurrency: 6, mergeGapBytes: 0, roundTripBytes: latencyMs * 1000, readsAhead: false };
  return { readsAhead: false, mergeGapBytes: 0, roundTripBytes: snapshot.roundTripBytes, snapshot: () => snapshot, watchProtocol() {} };
}

async function reopen(root, previous, options) {
  const reader = new AnnDataReader();
  await reader.open(root, { ...options, carry: previous });
  if (previous !== null) {
    previous.releaseStore();
    previous.close();
  }
  return reader;
}

async function openCells(reader) {
  const names = await reader.readObsNames();
  return Array.from(names, name => Number(String(name).slice(1)));
}

/** A run's reads of `genes` in `cells`, `batch` genes a read, the run's genes told (as an analysis reads). */
async function run(reader, cells, batch, nVars = N_VARS) {
  const blocks = [];
  for (let first = 0; first < nVars; first += batch) {
    const genes = Array.from({ length: Math.min(batch, nVars - first) }, (_, i) => first + i);
    blocks.push([genes, await reader.getMatrixCellSubset('X', cells, genes, { runGenes: nVars - first })]);
  }
  return blocks;
}

function assertBlocks(blocks, cells, open, values, label) {
  for (const [genes, block] of blocks) {
    genes.forEach((gene, g) => {
      const expected = [];
      cells.forEach((cell, position) => {
        const value = values[open[cell] * N_VARS + gene];
        if (value !== 0) expected.push([position, value]);
      });
      const got = [];
      for (let k = block.pointers[g]; k < block.pointers[g + 1]; k++) got.push([block.cellIndex[k], block.values[k]]);
      assert.deepEqual(got, expected, `${label}: gene ${gene}`);
    });
  }
}

/** Calls of the read of each gene's first rows (`_sparseColumnRows`) while `work` runs. */
async function firstRowReads(work) {
  const original = AnnDataReader.prototype._sparseColumnRows;
  let calls = 0;
  AnnDataReader.prototype._sparseColumnRows = function counted(...args) {
    calls++;
    return original.apply(this, args);
  };
  try {
    return { result: await work(), calls };
  } finally {
    AnnDataReader.prototype._sparseColumnRows = original;
  }
}

test('a share raised back to every cell in place: two groups of every cell are read by the run\'s route, never gene by gene through the first rows', async () => {
  const { tree, values } = csrTree();
  const { store } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const options = { format: ZARR_FORMAT, name: 'atlas.zarr', decodedChunkBytes: 64 * 1024 * 1024, link: slowLink(0) };
  const share = await reopen(root, null, { ...options, cellSubset: BLOCKS(1500) });
  const before = await openCells(share);
  await share.getMatrixColumn('X', 5);
  const reader = await reopen(root, share, { ...options, cellSubset: { mode: 'all', order: { method: 'blocks', seed: 0, blockSize: 25 } } });
  const open = await openCells(reader);
  assert.deepEqual(open.slice(0, 1500), before, 'raised in place: the share\'s cells first');
  assert.notDeepEqual(open, Array.from({ length: N_OBS }, (_, i) => i), 'every cell, in the share\'s order');
  const columns = await reader._matrixColumns(reader._requireMatrixElement('X'), reader._generation, {});
  assert.ok(Array.isArray(columns.segments) && columns.segments.length > 1, 'the gene index is in segments');

  // Two groups of every cell (a differential expression), in the last
  // segment too; the last open cell not among them (a group rarely holds it).
  const groups = [];
  for (let cell = 0; cell < N_OBS - 1; cell++) if (open[cell] % 5 < 2) groups.push(cell);
  assert.ok(groups.at(-1) >= columns.segments.at(-1).start, 'the groups reach the last segment');
  const { result, calls } = await firstRowReads(() => run(reader, groups, 4));
  assertBlocks(result, groups, open, values, 'two groups');
  assert.equal(calls, 0, `${calls} genes read through their first rows for cells reaching the last row`);

  // An analysis's first pass on the first open cells (within the first
  // segment) still reads only those rows of each gene.
  const firstSegmentEnd = columns.segments[0].rows;
  const sample = groups.filter(cell => cell < firstSegmentEnd);
  const first = await firstRowReads(() => run(reader, sample, 4));
  assertBlocks(first.result, sample, open, values, 'first pass');
  assert.equal(first.calls, N_VARS, 'a first pass reads each gene\'s first rows only');
});

test('raised back with genes read for a sample of every cell: two groups of the sample are read from its rows alone', async () => {
  // The share raised back with a gene sample smaller than every cell (a
  // kept prefix whose growth is under way): only the sample's rows'
  // pointers are read, so cells among them reaching its last segment are
  // read by its columns, never by every open row's.
  const { tree, values } = csrTree();
  const { store } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const options = { format: ZARR_FORMAT, name: 'atlas.zarr', decodedChunkBytes: 64 * 1024 * 1024, link: slowLink(0) };
  const share = await reopen(root, null, { ...options, cellSubset: BLOCKS(1500) });
  await share.getMatrixColumn('X', 5);
  const reader = await reopen(root, share, { ...options, cellSubset: { mode: 'all', order: { method: 'blocks', seed: 0, blockSize: 25 }, genes: 4000 } });
  assert.equal(reader.geneSampleOf('X')?.cells, 4000, 'genes are read for the first 4,000 open cells');
  const open = await openCells(reader);
  const columns = await reader._matrixColumns(reader._requireMatrixElement('X'), reader._generation, {});
  const groups = [];
  for (let cell = 0; cell < 4000 - 1; cell++) if (open[cell] % 5 < 2) groups.push(cell);
  assert.ok(groups.at(-1) >= columns.segments.at(-1).start, 'the groups reach the sample\'s last segment');
  const { result, calls } = await firstRowReads(() => run(reader, groups, 4));
  assertBlocks(result, groups, open, values, 'two groups of the sample');
  assert.equal(calls, 0, `${calls} genes read through their first rows for cells reaching the sample's last row`);
});

test('raised back to every cell in the share\'s order, the cells past the share\'s are served by every cell\'s kept index: nothing indexed again', async t => {
  // Every cell opened in file order keeps its gene index; the share lowered
  // and raised back opens every cell in the share's order. The rows past
  // the share's are every stored row but the share's: every cell's kept
  // index serves them (`_restrictsWhole`), where a pass of their own read
  // and decoded them again (10M Zarr: 27 MB, marker genes 2.7 s → 5.3 s).
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const { tree, values } = csrTree();
  const { store, fetched } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const options = {
    format: ZARR_FORMAT,
    name: 'atlas.zarr',
    decodedChunkBytes: 64 * 1024 * 1024,
    keptIndexes: { identity: { kind: 'remote', key: 'host:atlas', version: `md5:${'0'.repeat(32)}:1` }, environment: disk.environment, tab: 'tab' },
  };
  const whole = await reopen(root, null, { ...options, cellSubset: { mode: 'all' } });
  await whole.getMatrixColumn('X', 5);
  for (let wait = 0; (await whole.geneReadPlan('X')).built !== true; wait++) {
    assert.ok(wait < 2000, 'every cell\'s index is built');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await whole.whenIndexesKept();
  const share = await reopen(root, whole, { ...options, cellSubset: BLOCKS(1500) });
  await share.getMatrixColumn('X', 5);
  await share.whenIndexesKept();
  const reader = await reopen(root, share, { ...options, cellSubset: { mode: 'all', order: { method: 'blocks', seed: 0, blockSize: 25 } } });
  const open = await openCells(reader);
  assert.notDeepEqual(open, Array.from({ length: N_OBS }, (_, i) => i), 'every cell, in the share\'s order');
  const before = fetched.length;
  for (const gene of [5, 0, N_VARS - 1]) {
    const column = await reader.getMatrixColumn('X', gene);
    for (let i = 0; i < N_OBS; i++) assert.equal(column[i], values[open[i] * N_VARS + gene], `gene ${gene}, cell ${i}`);
  }
  // Genes' entries in open order (a markers run's reads), placed by the
  // open rows' runs (a run a block of 25: fewer than a gene's entries).
  const sparse = await reader.getMatrixColumnsSparse('X', [1, 2, N_VARS - 2]);
  [1, 2, N_VARS - 2].forEach((gene, g) => {
    const expected = [];
    for (let i = 0; i < N_OBS; i++) if (values[open[i] * N_VARS + gene] !== 0) expected.push([i, values[open[i] * N_VARS + gene]]);
    assert.deepEqual(Array.from(sparse[g].indices, (cell, k) => [cell, sparse[g].values[k]]), expected, `gene ${gene}: its entries in open order`);
  });
  assert.deepEqual(fetched.slice(before).filter(key => key.startsWith('X/indices/')), [], 'no stored row is indexed again');
  await reader.whenIndexesKept();
  reader.close();
});

test('a run\'s reads of the same cells check them once: every later read compares them, never walks them again', async () => {
  // A differential expression of two groups of 10M cells reads ~1.9M cells
  // some 400 times; checked, bounded by the gene sample, by the rows read and
  // by a prefix each read, they were 8.5 of the reader's 9 s (Chromium).
  const { tree, values } = csrTree();
  const { store } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const reader = await reopen(root, null, { format: ZARR_FORMAT, name: 'atlas.zarr', decodedChunkBytes: 64 * 1024 * 1024 });
  const open = await openCells(reader);
  const groups = [];
  for (let cell = 0; cell < N_OBS; cell++) if (open[cell] % 5 < 2) groups.push(cell);
  const checkedCells = AnnDataReader.prototype._checkedCells;
  let checks = 0;
  AnnDataReader.prototype._checkedCells = function counted(...args) {
    checks++;
    return checkedCells.apply(this, args);
  };
  try {
    // Each read as the reader worker gets it: a copy of the run's cells.
    const blocks = [];
    for (let first = 0; first < N_VARS; first += 4) {
      const genes = [first, first + 1, first + 2, first + 3];
      blocks.push([genes, await reader.getMatrixCellSubset('X', Uint32Array.from(groups), genes, { runGenes: N_VARS - first })]);
    }
    assertBlocks(blocks, groups, open, values, 'two groups');
    assert.equal(checks, 1, `${N_VARS / 4} reads of the same cells checked them ${checks} times`);
    // Other cells are checked anew, and a bad one is still refused.
    await reader.getMatrixCellSubset('X', groups.slice(1), [0]);
    assert.equal(checks, 2, 'other cells are checked');
    await assert.rejects(reader.getMatrixCellSubset('X', [...groups.slice(0, -1), N_OBS], [0]), /outside/);
    await assert.rejects(reader.getMatrixCellSubset('X', [groups[0], groups[0]], [0]), /more than once|distinct|twice/i);
  } finally {
    AnnDataReader.prototype._checkedCells = checkedCells;
  }
});

test('cells past a gene sample, kept by the run\'s first read, are copied by every later read: no row view, no pointer check again', async () => {
  // Every cell open with genes read for a sample (a link the sample fits,
  // or a local file priced as one); a differential expression's two groups
  // reach past it, so the run's first read keeps every gene of their rows.
  // Each later read asked for their rows' pointers, made a row view of them
  // and walked its coverage again (10M CSR, 2M cells: 0.6 s a read, 470
  // reads: DE 4 s on the pushed tree, 180-360 s here).
  const { tree, values } = csrTree();
  const { store } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const reader = await reopen(root, null, { format: ZARR_FORMAT, name: 'atlas.zarr', decodedChunkBytes: 64 * 1024 * 1024, cellSubset: { mode: 'all', order: { method: 'blocks', seed: 0, blockSize: 25 }, genes: 4000 } });
  assert.equal(reader.geneSampleOf('X')?.cells, 4000);
  const open = await openCells(reader);
  const groups = [];
  for (let cell = 0; cell < N_OBS; cell++) if (open[cell] % 5 < 2) groups.push(cell);
  assert.ok(groups.at(-1) >= 4000, 'the groups reach past the sample');
  const counted = ['_readyRows', '_rowsOfCells', '_namedRows'];
  const originals = counted.map(name => AnnDataReader.prototype[name]);
  const calls = Object.fromEntries(counted.map(name => [name, 0]));
  counted.forEach((name, k) => {
    AnnDataReader.prototype[name] = function countedCall(...args) {
      calls[name]++;
      return originals[k].apply(this, args);
    };
  });
  try {
    const blocks = await run(reader, Uint32Array.from(groups), 4);
    assertBlocks(blocks, groups, open, values, 'two groups past the sample');
  } finally {
    counted.forEach((name, k) => { AnnDataReader.prototype[name] = originals[k]; });
  }
  for (const name of counted) assert.ok(calls[name] <= 1, `${N_VARS / 4} reads called ${name} ${calls[name]} times`);
});

test('a share\'s rows are priced at the stored chunks they lie in: groups spread through the store are read from the built index here', async () => {
  // A share's rows lie in every stored chunk: read by their rows, each
  // decodes whole stored chunks for a few kept rows. Priced at their kept
  // entries alone (161 MB priced, 750 MB read and decoded on a 10M CSR
  // file), a run took them over the gene index the share had built.
  // Many genes, few a cell: a batch's genes are few entries of the index,
  // the groups' rows lie in every stored chunk.
  const nVars = 400;
  const { tree, values, indptr } = csrTree({ nVars, density: 0.03 });
  const { store, fetched } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const reader = await reopen(root, null, { format: ZARR_FORMAT, name: 'atlas.zarr', decodedChunkBytes: 0, cellSubset: { mode: 'subsample', method: 'uniform', k: 1200, seed: 0, strict: true } });
  const open = await openCells(reader);
  await reader.getMatrixColumn('X', 5);
  for (let wait = 0; (await reader.geneReadPlan('X')).built !== true; wait++) {
    assert.ok(wait < 2000, 'the share\'s gene index is built');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const groups = [];
  for (let cell = 0; cell < open.length; cell++) if (open[cell] % 5 < 2) groups.push(cell);
  // Reading the groups by their rows is priced at the stored chunks their
  // entries lie in, each decoded whole (512 entries of a 4-byte index and a
  // 4-byte value), not at the share view's part of them.
  const touched = new Set();
  for (const cell of groups) {
    const row = open[cell];
    for (let chunk = Math.floor(indptr[row] / 512); chunk * 512 < indptr[row + 1]; chunk++) touched.add(chunk);
  }
  const rows = await reader._matrixRows(reader._requireMatrixElement('X'), null);
  const priced = rows.readCost(Uint32Array.from(groups));
  assert.ok(priced >= 0.9 * touched.size * 512 * 8, `the groups' rows priced at ${priced} bytes; their stored chunks hold ${touched.size * 512 * 8}`);
  const before = fetched.length;
  const blocks = await run(reader, groups, 4, nVars);
  for (const [genes, block] of blocks) {
    genes.forEach((gene, g) => {
      const expected = [];
      groups.forEach((cell, position) => {
        const value = values[open[cell] * nVars + gene];
        if (value !== 0) expected.push([position, value]);
      });
      const got = [];
      for (let k = block.pointers[g]; k < block.pointers[g + 1]; k++) got.push([block.cellIndex[k], block.values[k]]);
      assert.deepEqual(got, expected, `gene ${gene}`);
    });
  }
  assert.deepEqual(fetched.slice(before).filter(key => key.startsWith('X/indices/') || key.startsWith('X/data/')), [], 'no stored chunk of X is read again');
});

test('a share\'s cells kept by their rows are read in store order: each stored chunk of X once, but at a read\'s boundary', async () => {
  // A uniform share's rows lie spread through the store: read in open
  // order, each read of the run's pipeline decoded nearly every stored
  // chunk again (a 50 % share's DE groups read 7.5 GB of a 2.6 GB file).
  const { tree, values } = csrTree();
  const { store, reads } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const reader = await reopen(root, null, { format: ZARR_FORMAT, name: 'atlas.zarr', decodedChunkBytes: 0, cellSubset: { mode: 'subsample', method: 'uniform', k: 3000, seed: 0, strict: true } });
  const open = await openCells(reader);
  const groups = [];
  for (let cell = 0; cell < open.length; cell++) if (open[cell] % 5 < 2) groups.push(cell);
  // Reads a few chunks' entries at a time, as a 10M run's pipeline reads
  // a slab of a 2.6 GB file at a time.
  reader._inFlightEntries = () => 1024;
  const matrix = reader._requireMatrixElement('X');
  await reader._readyRows('X', {}, null);
  const rows = await reader._matrixRows(matrix, null);
  const before = reads.length;
  // The run keeps every gene of the groups' rows (as a long DE's first read does).
  const block = await reader._subsetInStoreOrder(matrix, rows, Uint32Array.from(groups), Array.from({ length: N_VARS }, (_, g) => g), {});
  for (let gene = 0; gene < N_VARS; gene++) {
    const expected = [];
    groups.forEach((cell, position) => {
      const value = values[open[cell] * N_VARS + gene];
      if (value !== 0) expected.push([position, value]);
    });
    const got = [];
    for (let k = block.pointers[gene]; k < block.pointers[gene + 1]; k++) got.push([block.cellIndex[k], block.values[k]]);
    assert.deepEqual(got, expected, `gene ${gene}`);
  }
  const fetched = new Map();
  for (const { key } of reads.slice(before)) if (key.startsWith('X/indices/') || key.startsWith('X/data/')) fetched.set(key, (fetched.get(key) ?? 0) + 1);
  assert.ok(fetched.size > 0, 'the rows are read');
  // Each chunk once, but one two reads of the pipeline share at their boundary.
  const twice = [...fetched].filter(([, times]) => times > 1);
  assert.ok(twice.every(([, times]) => times === 2), JSON.stringify(twice));
  const total = [...fetched.values()].reduce((sum, times) => sum + times, 0);
  assert.ok(total <= 1.25 * fetched.size, `${total} reads of ${fetched.size} stored chunks`);
});

test('a gene\'s entries put in a blocks order are placed run by run: the same entries and order a lookup of each row and a sort give, and no lookup', async () => {
  // Every stored row open in blocks of 7 rows in a shuffled order (the last
  // block short), and genes of every density: from a few entries (a lookup
  // a row and a sort) to most rows (placed by the runs).
  const nRows = 7 * 40 + 3;
  const random = createMulberry32(23);
  const blocks = Array.from({ length: Math.ceil(nRows / 7) }, (_, b) => b);
  for (let b = blocks.length - 1; b > 0; b--) {
    const other = Math.floor(random() * (b + 1));
    [blocks[b], blocks[other]] = [blocks[other], blocks[b]];
  }
  const openOrder = [];
  for (const b of blocks) for (let row = 7 * b; row < Math.min(nRows, 7 * b + 7); row++) openOrder.push(row);
  const kept = Uint32Array.from(openOrder);
  const openOf = new Int32Array(nRows);
  kept.forEach((row, open) => { openOf[row] = open; });
  const genes = [0.02, 0.1, 0.5, 0.9].map(density => {
    const rows = [];
    for (let row = 0; row < nRows; row++) if (random() < density) rows.push(row);
    return { length: nRows, indices: Uint32Array.from(rows), values: Float32Array.from(rows, row => row + 0.5) };
  });
  const access = { sparseColumn: async gene => ({ length: nRows, indices: genes[gene].indices.slice(), values: genes[gene].values.slice() }) };
  const expected = (gene, start, n) => {
    const out = [];
    genes[gene].indices.forEach((row, e) => {
      const at = openOf[row] - start;
      if (at >= 0 && at < n) out.push([at, genes[gene].values[e]]);
    });
    return out.sort((a, b) => a[0] - b[0]);
  };
  const pairs = column => Array.from(column.indices, (cell, k) => [cell, column.values[k]]);
  // Every cell's index restricted to the open rows past the first 50.
  let looked = 0;
  const positions = () => {
    looked++;
    return { table: openOf, get: row => openOf[row] };
  };
  const start = 50;
  const restricted = restrictedAccess(access, kept.subarray(start), positions, start, () => runsOfPositions(kept));
  for (let gene = 0; gene < genes.length; gene++) {
    assert.deepEqual(pairs(await restricted.sparseColumn(gene, {})), expected(gene, start, nRows - start), `restricted gene ${gene}`);
  }
  // Rows indexed in store order (row i of the index is stored row i),
  // answered in open order.
  const viewRows = Uint32Array.from(openOf);
  const ordered = fileOrderedAccess(access, viewRows);
  for (let gene = 0; gene < genes.length; gene++) {
    assert.deepEqual(pairs(await ordered.sparseColumn(gene, {})), expected(gene, 0, nRows), `store order gene ${gene}`);
  }
  // Only the sparsest gene (fewer entries than runs) looked rows up.
  assert.equal(looked, 1, 'the lookup is made for the gene with fewer entries than runs only');
});

test('ordering keys walks a few digit counts a key, never 65,536 a pass, and gives the stable order', () => {
  const random = createMulberry32(5);
  const fill = Uint32Array.prototype.fill;
  for (const n of [2, 3, 150, 1000, 70_000]) {
    for (const largest of [1, 255, 1 << 20, 2 ** 32 - 1]) {
      const keys = new Uint32Array(n);
      for (let i = 0; i < n; i++) keys[i] = Math.floor(random() * (largest + 1));
      let counted = 0;
      let passes = 0;
      Uint32Array.prototype.fill = function countedFill(...args) {
        // The digit counts are cleared once a pass.
        if (args[0] === 0 && args.length === 1) {
          counted += this.length;
          passes++;
        }
        return fill.apply(this, args);
      };
      let order;
      let sorted;
      let pairs;
      try {
        order = orderByKey(keys);
        sorted = sortUint32(keys.slice());
        pairs = sortByKeyWithValues(keys.slice(), Float32Array.from(keys, (_, i) => i));
      } finally {
        Uint32Array.prototype.fill = fill;
      }
      // The digit costing least for the keys: its counts never dwarf them
      // (no more than four a key), where a fixed 16-bit digit walked 65,536.
      assert.ok(counted <= passes * 4 * n, `${n} keys below ${largest}: ${counted} counts walked in ${passes} passes`);
      const expected = Array.from({ length: n }, (_, i) => i).sort((a, b) => keys[a] - keys[b] || a - b);
      assert.deepEqual(Array.from(order), expected, `${n} keys below ${largest}: stable order`);
      assert.deepEqual(Array.from(sorted), Array.from(keys).sort((a, b) => a - b), `${n} keys below ${largest}: sorted`);
      assert.deepEqual(Array.from(pairs.keys), expected.map(i => keys[i]), `${n} keys below ${largest}: pairs' keys sorted`);
      assert.deepEqual(Array.from(pairs.values), expected, `${n} keys below ${largest}: each value moved with its key, equal keys in order`);
    }
  }
});
