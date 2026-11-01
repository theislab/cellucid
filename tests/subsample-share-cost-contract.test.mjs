/**
 * What a share of the cells costs, against a larger share and against every
 * cell (the share-cost invariant of `data/anndata/views/cell-subset.js`):
 *
 * - a share never reads more of a stored array than a larger share of the
 *   same method, nor more than every cell, counted in stored chunks (bytes)
 *   and in reads (requests), and reads exactly the cells it names;
 * - the work of placing a share's rows grows with its cells, not with a sort
 *   of them by comparator (`planBoxes`, `runsBySource`);
 * - what a share asked for will read is said before Apply when it is near the
 *   whole file (`cellShareReadShare`, `scatteredShareCost`).
 *
 * Counts, not wall clock.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { gatheredArray, planBoxes, runsOfPositions } from '../assets/js/data/anndata/views/cell-subset.js';
import { cellShareReadShare } from '../assets/js/data/anndata/subsample-plan.js';
import { subsampleBlocks, subsampleUniform, priorityOrder } from '../assets/js/data/subsample.js';
import { scatteredShareCost } from '../assets/js/app/ui/modules/subsample-control.js';
import { numericDtype } from '../assets/js/formats/store.js';

const N = 20_000;
const CHUNK = 500;

/** A chunked 1-D float array of `N` rows whose value is its row, counting the chunks and reads asked of it. */
function countedArray(chunk = CHUNK) {
  const counts = { chunks: new Set(), reads: 0, elements: 0 };
  const array = {
    kind: 'array',
    path: '/obs/score',
    attrs: {},
    attributeType: () => null,
    shape: [N],
    dtype: numericDtype('float', 8),
    chunks: [chunk],
    partialChunks: false,
    fillValue: 0,
    async storedBytes([[start, end]]) {
      return (end - start) * 8;
    },
    async read(selection) {
      const [[start, end]] = selection ?? [[0, N]];
      counts.reads++;
      counts.elements += end - start;
      for (let c = Math.floor(start / chunk); c <= Math.floor((end - 1) / chunk); c++) counts.chunks.add(c);
      return Float64Array.from({ length: end - start }, (_, i) => start + i);
    },
  };
  return { array, counts };
}

/** Read the rows `kept` (in their view order) of a counted array; returns the values and the counts. */
async function readShare(kept, chunk) {
  const { array, counts } = countedArray(chunk);
  const values = await gatheredArray(array, runsOfPositions(kept), { mergeGapBytes: () => 0 }).read();
  return { values, chunks: counts.chunks.size, reads: counts.reads, elements: counts.elements };
}

const METHODS = {
  uniform: k => priorityOrder({ method: 'uniform', seed: 7, nObs: N, k }, subsampleUniform(N, k, 7)),
  blocks: k => priorityOrder({ method: 'blocks', seed: 7, nObs: N, k, blockSize: 4 * CHUNK }, subsampleBlocks(N, k, 7, 4 * CHUNK)),
};

for (const [method, keptOf] of Object.entries(METHODS)) {
  test(`a ${method} share reads no more than a larger share, nor than every cell, and exactly its cells`, async () => {
    const whole = await readShare(Uint32Array.from({ length: N }, (_, i) => i));
    let before = null;
    for (const fraction of [0.001, 0.01, 0.1, 0.5, 1]) {
      const k = Math.round(fraction * N);
      const kept = fraction === 1 ? Uint32Array.from({ length: N }, (_, i) => i) : keptOf(k);
      const read = await readShare(kept);
      // Exactly the cells named, in view order.
      assert.equal(read.values.length, kept.length);
      for (let i = 0; i < kept.length; i++) assert.equal(read.values[i], kept[i]);
      // Bytes (stored chunks, elements decoded) and requests: never more than every cell.
      assert.ok(read.chunks <= whole.chunks, `${method} ${fraction}: ${read.chunks} chunks against ${whole.chunks}`);
      assert.ok(read.elements <= whole.elements, `${method} ${fraction}: ${read.elements} elements against ${whole.elements}`);
      assert.ok(read.reads <= Math.ceil(N / CHUNK), `${method} ${fraction}: ${read.reads} reads`);
      // Monotone in the share.
      if (before !== null) {
        assert.ok(read.chunks >= before.chunks, `${method}: ${fraction} reads ${read.chunks} chunks, the smaller share ${before.chunks}`);
        assert.ok(read.reads >= before.reads, `${method}: ${fraction} makes ${read.reads} reads, the smaller share ${before.reads}`);
      }
      before = read;
    }
  });
}

test('blocks read about their share of the chunks; a uniform share reads nearly every chunk, said before Apply', async () => {
  const k = N / 100;
  const blocks = await readShare(METHODS.blocks(k));
  const uniform = await readShare(METHODS.uniform(k));
  const chunks = N / CHUNK;
  assert.ok(blocks.chunks <= Math.ceil(chunks / 100) + 4, `blocks at 1 %: ${blocks.chunks} of ${chunks} chunks`);
  // Each 500-cell chunk holds one of 200 uniform cells with probability 1 - 0.99^500.
  const expected = cellShareReadShare([{ rows: CHUNK, bytes: N * 8 }], 0.01, 'uniform');
  assert.ok(Math.abs(uniform.chunks / chunks - expected) < 0.05, `uniform at 1 %: ${uniform.chunks} of ${chunks}, priced ${expected}`);
  assert.ok(Math.abs(cellShareReadShare([{ rows: CHUNK, bytes: N * 8 }], 0.01, 'blocks') - 0.01) < 1e-12);
  // Read byte by byte (no chunks): about the share, whatever the method.
  assert.equal(cellShareReadShare([{ rows: null, bytes: 100 }], 0.01, 'uniform'), 0.01);
  // The control says it before Apply, with what blocks read; not for blocks, a priority file's own seed, or every cell.
  const subset = { readLayout: [{ rows: CHUNK, bytes: N * 8 }], prioritySeed: null };
  const said = scatteredShareCost(subset, { method: 'uniform', seed: null, fraction: 0.01 });
  assert.ok(said !== null && said.read > 0.95 && said.cheap < 0.02 && said.alternative === 'blocks', JSON.stringify(said));
  assert.match(said.text, /^Reads about 99 % of the file for 1\.0 % of its cells; blocks read about 1 %\.$/);
  assert.equal(scatteredShareCost(subset, { method: 'blocks', seed: null, fraction: 0.01 }), null);
  assert.equal(scatteredShareCost(subset, { method: 'uniform', seed: null, fraction: 1 }), null);
  // A priority-ordered file: uniform under its own seed is its first rows;
  // another seed, and blocks of original positions, lie throughout it
  // (measured: 10 % blocks of a 10M-cell priority-ordered .h5ad read 380 MB
  // of the 385 MB every cell reads); the file's own order is offered.
  const priority = { ...subset, prioritySeed: 3 };
  assert.equal(scatteredShareCost(priority, { method: 'uniform', seed: 3, fraction: 0.01 }), null);
  assert.equal(scatteredShareCost(priority, { method: 'uniform', seed: null, fraction: 0.01 }), null);
  assert.equal(scatteredShareCost(priority, { method: 'uniform', seed: 4, fraction: 0.01 })?.alternative, 'file');
  const blocksThere = scatteredShareCost(priority, { method: 'blocks', seed: null, fraction: 0.1 });
  assert.equal(blocksThere?.alternative, 'file');
  assert.match(blocksThere.text, /this file's own order reads about 10 %\.$/);
  assert.equal(scatteredShareCost({ readLayout: [] }, { method: 'uniform', seed: null, fraction: 0.01 }), null);
});

test('a share\'s rows are placed in source order by their runs, as a comparator sort places them, ties and partial reads included', () => {
  // A uniform share in priority order (single-row runs all over), with a few
  // empty runs whose start equals a neighbour's (ties).
  const kept = METHODS.uniform(N / 10);
  const runs = runsOfPositions(kept);
  const reference = (a, b) => {
    const pieces = [];
    for (let r = 0; r < runs.count; r++) {
      const from = Math.max(a, runs.offsets[r]);
      const to = Math.min(b, runs.offsets[r + 1]);
      if (from < to) pieces.push({ start: runs.starts[r] + from - runs.offsets[r], at: from - a });
    }
    return pieces.sort((x, y) => x.start - y.start);
  };
  for (const [a, b] of [[0, kept.length], [0, 10], [100, 1_900], [kept.length - 7, kept.length], [3, 1_500]]) {
    const plan = planBoxes(runs, a, b, { chunkRows: CHUNK, rowBytes: 8, mergeGapBytes: 0 });
    const expected = reference(a, b);
    assert.equal(plan.order.length, expected.length);
    plan.order.forEach((p, o) => {
      assert.equal(plan.pieceStarts[p], expected[o].start);
      assert.equal(plan.pieceAt[p], expected[o].at);
    });
  }
  const ties = { count: 3, starts: Float64Array.of(10, 10, 4), ends: Float64Array.of(12, 10, 6), offsets: Float64Array.of(0, 2, 2, 4) };
  const plan = planBoxes(ties, 0, 4, { chunkRows: null, rowBytes: 8, mergeGapBytes: 0 });
  assert.deepEqual([...plan.order], [2, 0, 1]);
});

/**
 * A CSR `X` of 120,000 cells, 30 entries a cell in chunks of 6,000 (or, with
 * `layout` `dense`, the same values dense in chunks of 1,000 rows): rows
 * enough for the index's segments (each at least a slab of a million
 * entries, 33,334 rows; 26,215 dense), so a uniform share past a slab's rows
 * would read in segments, and is read in store order instead.
 * `expected(cell, gene)`: X's value there.
 */
async function interleavedAtlas(layout = 'csr') {
  const { annData, dataFrame, dense, mapping, sparse, strings } = await import('./helpers/anndata-store.mjs');
  const cells = 120_000;
  const genes = 40;
  const perCell = 30;
  const data = new Float32Array(cells * perCell);
  const indices = new Int32Array(cells * perCell);
  const indptr = new Int32Array(cells + 1);
  for (let cell = 0; cell < cells; cell++) {
    for (let j = 0; j < perCell; j++) {
      indices[cell * perCell + j] = (cell + j) % genes;
      data[cell * perCell + j] = 1 + ((cell * 7 + j) % 9);
    }
    indptr[cell + 1] = (cell + 1) * perCell;
  }
  // Entries sorted within each row (CSR).
  for (let cell = 0; cell < cells; cell++) {
    const row = Array.from({ length: perCell }, (_, j) => [indices[cell * perCell + j], data[cell * perCell + j]]).sort((a, b) => a[0] - b[0]);
    row.forEach(([g, v], j) => { indices[cell * perCell + j] = g; data[cell * perCell + j] = v; });
  }
  let X;
  if (layout === 'dense') {
    const values = new Float32Array(cells * genes);
    for (let cell = 0; cell < cells; cell++) for (let e = indptr[cell]; e < indptr[cell + 1]; e++) values[cell * genes + indices[e]] += data[e];
    X = dense(values, [cells, genes], { chunks: [1000, genes], compressed: true });
  } else {
    X = sparse({ format: 'csr', data, indices, indptr, shape: [cells, genes], compressed: true });
    X.children.data.chunks = [6000];
    X.children.indices.chunks = [6000];
    X.children.indptr.chunks = [10_000];
  }
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: cells }, (_, i) => `c${i}`), { chunks: [10_000] }) }),
    var: dataFrame({ _index: strings(Array.from({ length: genes }, (_, g) => `g${g}`)) }),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: cells * 2 }, (_, i) => i), [cells, 2], { chunks: [10_000, 2], compressed: true }) }),
    X,
  });
  const expected = (cell, gene) => {
    for (let e = indptr[cell]; e < indptr[cell + 1]; e++) if (indices[e] === gene) return data[e];
    return 0;
  };
  return { tree, expected, cells };
}

test('a gene of a share reads each stored chunk of the matrix once: never more than every cell, and more for a larger share only', async () => {
  const { countingStore } = await import('./helpers/anndata-store.mjs');
  const { openZarr } = await import('../assets/js/formats/zarr/index.js');
  const { AnnDataReader } = await import('../assets/js/data/anndata/reader.js');
  const { ZARR_FORMAT } = await import('../assets/js/data/anndata/elements.js');
  const { tree, expected } = await interleavedAtlas();
  const geneReads = async cellSubset => {
    const counting = countingStore(tree);
    const root = await openZarr(counting.store, { decodedChunkCacheBytes: 0 });
    const reader = new AnnDataReader();
    await reader.open(root, { format: ZARR_FORMAT, name: 'share.zarr', cellSubset });
    const names = await reader.readObsNames();
    const before = counting.fetched.length;
    const column = await reader.getMatrixColumn('X', 4);
    const fetched = counting.fetched.slice(before).filter(key => key.startsWith('X/indices/') || key.startsWith('X/data/'));
    names.forEach((name, i) => assert.equal(column[i], expected(Number(String(name).slice(1)), 4), `${JSON.stringify(cellSubset)} ${name}`));
    reader.close();
    return { chunks: fetched.length, distinct: new Set(fetched).size };
  };
  const every = await geneReads({ mode: 'all', genes: 'all' });
  let last = 0;
  for (const fraction of [0.1, 0.5, 0.9]) {
    const uniform = await geneReads({ mode: 'subsample', method: 'uniform', fraction, seed: 0, genes: 'all' });
    // Its own pass in store order decodes each chunk once; a share read
    // through every stored row's index (two thirds of the entries or more,
    // unmeasured: `_restrictsWhole`) makes every cell's reads exactly.
    if (fraction < 2 / 3) assert.equal(uniform.chunks, uniform.distinct, `a ${fraction} uniform share decodes each chunk once (${uniform.chunks} reads of ${uniform.distinct})`);
    else assert.deepEqual([uniform.chunks, uniform.distinct], [every.chunks, every.distinct], `a ${fraction} uniform share reads every cell's chunks`);
    assert.ok(uniform.chunks <= every.chunks, `a ${fraction} uniform share reads ${uniform.chunks} chunks, every cell ${every.chunks}`);
    assert.ok(uniform.chunks >= last, 'a larger share reads no fewer chunks');
    last = uniform.chunks;
  }
});

test('rows spread through the store are indexed in store order and answered in open order', async () => {
  const { rowsInterleaved, fileOrderedAccess } = await import('../assets/js/data/anndata/prefix-column-index.js');
  // Whole blocks of a store: the first segment lies in a few chunks.
  const blocks = Uint32Array.from({ length: 4000 }, (_, i) => Math.floor(i / 100) * 1000 + (i % 100));
  assert.equal(rowsInterleaved(blocks, 4000, 125, 50, 40_000), false);
  // Ascending rows (a priority-ordered file's prefix) are their own scan.
  assert.equal(rowsInterleaved(Uint32Array.from({ length: 4000 }, (_, i) => i * 10), 4000, 125, 50, 40_000), false);
  // A uniform share: the first segment reaches most chunks.
  const uniform = Uint32Array.from(subsampleUniform(40_000, 4000, 1));
  const shuffled = priorityOrder({ method: 'uniform', seed: 1, nObs: 40_000, k: 4000 }, uniform);
  assert.equal(rowsInterleaved(Uint32Array.from(shuffled), 4000, 1000, 50, 40_000), true);
  // Rows 0..3 of the access are open rows 2, 0, 3, 1.
  const viewRows = Uint32Array.of(2, 0, 3, 1);
  const access = fileOrderedAccess({
    column: async () => Float32Array.of(20, 0, 30, 10),
    sparseColumn: async () => ({ length: 4, indices: Uint32Array.of(0, 2, 3), values: Float32Array.of(20, 30, 10) }),
    built: () => true,
  }, viewRows);
  assert.deepEqual(Array.from(await access.column(0)), [0, 10, 20, 30]);
  const sparse = await access.sparseColumn(0);
  assert.deepEqual([Array.from(sparse.indices), Array.from(sparse.values)], [[1, 2, 3], [10, 20, 30]]);
  assert.equal(access.built(), true);
});

/** The matrix's stored chunks among a store's reads (not its row pointers). */
const matrixChunks = keys => keys.filter(key => key.startsWith('X/') && !key.startsWith('X/indptr/') && !key.endsWith('.zarray') && !key.endsWith('.zattrs') && !key.endsWith('zarr.json'));

/**
 * Reader options under which a matrix's genes are read through its row
 * index: a dense one whose gene strips the decoded-chunk budget would hold
 * is read as stored (no index), so the budget is made smaller than a strip.
 */
const readThroughRows = layout => (layout === 'dense' ? { decodedChunkBytes: 1_000_000 } : {});

for (const layout of ['csr', 'dense']) {
test(`${layout}: a 0.7 share's first gene is one pass, every cell's: no per-row sort or lookup, no partial picture promised, every cell's reads of the matrix`, async () => {
  const { countingStore } = await import('./helpers/anndata-store.mjs');
  const { openZarr } = await import('../assets/js/formats/zarr/index.js');
  const { AnnDataReader } = await import('../assets/js/data/anndata/reader.js');
  const { ZARR_FORMAT } = await import('../assets/js/data/anndata/elements.js');
  const { RowPointers } = await import('../assets/js/data/anndata/views/cell-subset.js');
  const { tree, expected, cells } = await interleavedAtlas(layout);
  const counting = countingStore(tree);
  const root = await openZarr(counting.store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'share.zarr', ...readThroughRows(layout), cellSubset: { mode: 'subsample', method: 'uniform', fraction: 0.7, seed: 0, genes: 'all' } });
  // Read activities, as the worker makes them: the index pass's prices its bytes.
  reader.createActivity = () => ({ status: 'running', expect() {}, progress() {}, finish() { this.status = 'done'; } });
  const names = await reader.readObsNames();
  const rows = names.length;
  // The work of the gene's plan and pass, counted: rows sorted by
  // comparison (the pass priced over the rows in open order sorted every
  // row's run: 3 s of a 50 % share of 5M cells) and row pointers looked up
  // one by one (the kept values counted a row at a time: 1.3 s there).
  const sort = Float64Array.prototype.sort;
  const indexOf = RowPointers.prototype.indexOf;
  let sorted = 0;
  let lookups = 0;
  Float64Array.prototype.sort = function countedSort(...args) { sorted += this.length; return sort.apply(this, args); };
  RowPointers.prototype.indexOf = function countedIndexOf(row) { lookups++; return indexOf.call(this, row); };
  const before = counting.fetched.length;
  let column;
  try {
    // Said before the gene: one pass, so no colours before the whole (its
    // segments in open order promised the first after a slab's rows).
    const plan = await reader.geneReadPlan('X');
    assert.equal(plan.progressive, null, `no partial picture is promised (${JSON.stringify(plan.progressive)})`);
    column = await reader.getMatrixColumn('X', 4);
  } finally {
    Float64Array.prototype.sort = sort;
    RowPointers.prototype.indexOf = indexOf;
  }
  const fetched = matrixChunks(counting.fetched.slice(before));
  names.forEach((name, i) => assert.equal(column[i], expected(Number(String(name).slice(1)), 4), name));
  assert.ok(fetched.length > 0);
  assert.ok(sorted < rows / 4, `${sorted} values sorted for ${rows} rows`);
  assert.ok(lookups < rows / 4, `${lookups} row pointer lookups for ${rows} rows`);
  // Every cell's pass (`_restrictsWhole`): exactly every cell's reads of the matrix.
  const everyCounting = countingStore(tree);
  const every = new AnnDataReader();
  await every.open(await openZarr(everyCounting.store, { decodedChunkCacheBytes: 0 }), { format: ZARR_FORMAT, name: 'share.zarr', ...readThroughRows(layout), cellSubset: { mode: 'all', genes: 'all' } });
  const everyBefore = everyCounting.fetched.length;
  await every.getMatrixColumn('X', 4);
  assert.deepEqual(fetched.slice().sort(), matrixChunks(everyCounting.fetched.slice(everyBefore)).sort(), 'every cell\'s reads of the matrix, no more');
  every.close();
  const segments = reader._matrices.get('X').columns.source.segments;
  assert.deepEqual(segments.map(segment => [segment.start, segment.rows]), [[0, rows]], 'one segment of every open row');
  assert.ok(rows > cells / 4);
  reader.close();
});

test(`${layout}: a uniform share's revisit reads no byte of its gene index: the segment in store order (or every stored row's index) is kept and taken whole`, async t => {
  const { countingStore } = await import('./helpers/anndata-store.mjs');
  const { openZarr } = await import('../assets/js/formats/zarr/index.js');
  const { AnnDataReader } = await import('../assets/js/data/anndata/reader.js');
  const { ZARR_FORMAT } = await import('../assets/js/data/anndata/elements.js');
  const { opfsOnDisk } = await import('./helpers/opfs-on-disk.mjs');
  const { tree, expected } = await interleavedAtlas(layout);
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const identity = { kind: 'remote', key: 'host:share', version: `md5:${'0'.repeat(32)}:1` };
  const visit = async (fraction, file = identity) => {
    const counting = countingStore(tree);
    const root = await openZarr(counting.store, { decodedChunkCacheBytes: 0 });
    const reader = new AnnDataReader();
    const stores = [];
    await reader.open(root, {
      format: ZARR_FORMAT,
      name: 'share.zarr',
      ...readThroughRows(layout),
      cellSubset: { mode: 'subsample', method: 'uniform', fraction, seed: 0, genes: 'all' },
      keptIndexes: { identity: file, environment: disk.environment, onStore: event => { stores.push(event.state); } },
    });
    const names = await reader.readObsNames();
    const before = counting.fetched.length;
    const column = await reader.getMatrixColumn('X', 9);
    names.forEach((name, i) => assert.equal(column[i], expected(Number(String(name).slice(1)), 9), `${fraction} ${name}`));
    // A CSR matrix's index reads its indices; a dense one's, the matrix.
    const indexReads = matrixChunks(counting.fetched.slice(before)).filter(key => layout === 'dense' || key.startsWith('X/indices/'));
    for (let wait = 0; (await reader.geneReadPlan('X')).built !== true; wait++) {
      assert.ok(wait < 2000, 'the index is built');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await reader.whenIndexesKept();
    const segments = reader._matrices.get('X').columns.source.segments.map(segment => [segment.start, segment.rows]);
    reader.close();
    return { indexReads, stores, segments, rows: names.length };
  };
  // A share of fewer than half of the entries indexes its own rows, in store order.
  const first = await visit(0.2);
  assert.ok(first.indexReads.length > 0, 'the first visit reads the index');
  assert.ok(first.stores.includes('complete'), 'its segment in store order is kept');
  const again = await visit(0.2);
  assert.deepEqual(again.indexReads, [], 'a revisit reads no byte of the index');
  assert.deepEqual(again.stores, [], 'nothing is kept again');
  // A larger share of the same seed takes the kept rows whole and indexes
  // only its new cells, again in store order.
  const larger = await visit(0.3);
  assert.deepEqual(larger.segments, [[0, first.rows], [first.rows, larger.rows - first.rows]]);
  assert.ok(larger.indexReads.length <= first.indexReads.length, `raised: ${larger.indexReads.length} index chunks, every row's ${first.indexReads.length}`);
  // A share of two thirds of the entries or more reads through the index
  // every cell builds, of every stored row (`_restrictsWhole`), kept as
  // every cell's: its revisit, and a larger share of it, read no byte of
  // the index (another file: no run of the smaller shares' rows is kept to
  // take).
  const other = { ...identity, key: 'host:large' };
  const half = await visit(0.7, other);
  assert.ok(half.indexReads.length > 0 && half.stores.includes('complete'), 'every stored row\'s index is built and kept');
  assert.deepEqual(half.segments, [[0, half.rows]]);
  const halfAgain = await visit(0.7, other);
  assert.deepEqual([halfAgain.indexReads, halfAgain.stores], [[], []], 'a revisit reads no byte of the index, keeps nothing again');
  const raised = await visit(0.85, other);
  assert.deepEqual([raised.indexReads, raised.stores, raised.segments], [[], [], [[0, raised.rows]]], 'a larger share takes every stored row\'s kept index');
});
}

/** A CSR `X` of `cells` cells in compressed chunks of `chunk` entries, `perCell` entries a cell, as a Zarr tree. */
async function chunkedAtlas({ cells = 40_000, genes = 40, perCell = 12, chunk = 600 } = {}) {
  const { annData, dataFrame, dense, mapping, sparse, strings } = await import('./helpers/anndata-store.mjs');
  const { createMulberry32 } = await import('../assets/js/app/utils/random-utils.js');
  // Values that do not compress away: a chunk's stored bytes are about its entries'.
  const random = createMulberry32(11);
  const data = new Float32Array(cells * perCell);
  const indices = new Int32Array(cells * perCell);
  const indptr = new Int32Array(cells + 1);
  for (let cell = 0; cell < cells; cell++) {
    const first = Math.floor(random() * (genes - perCell));
    for (let j = 0; j < perCell; j++) {
      indices[cell * perCell + j] = first + j;
      data[cell * perCell + j] = Math.fround(1 + random() * 99);
    }
    indptr[cell + 1] = (cell + 1) * perCell;
  }
  const X = sparse({ format: 'csr', data, indices, indptr, shape: [cells, genes], compressed: true });
  X.children.data.chunks = [chunk];
  X.children.indices.chunks = [chunk];
  X.children.indptr.chunks = [5000];
  return annData({
    obs: dataFrame({ _index: strings(Array.from({ length: cells }, (_, i) => `c${i}`), { chunks: [5000] }) }),
    var: dataFrame({ _index: strings(Array.from({ length: genes }, (_, g) => `g${g}`)) }),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: cells * 2 }, (_, i) => i), [cells, 2], { chunks: [5000, 2], compressed: true }) }),
    X,
  });
}

test('a share\'s gene sample never transfers more bytes, nor makes more requests, than every cell\'s sample in the same time, for every share and method', async () => {
  const { openZarr } = await import('../assets/js/formats/zarr/index.js');
  const { countingStore } = await import('./helpers/anndata-store.mjs');
  const { resolveCellSubset, firstGeneReadCost } = await import('../assets/js/data/anndata/subsample-plan.js');
  const cells = 40_000;
  const root = await openZarr(countingStore(await chunkedAtlas({ cells })).store, { decodedChunkCacheBytes: 0 });
  const cost = await firstGeneReadCost(root, cells, { valuesOnDemand: true, decodedChunkBytes: 1e9 });
  // A near host measured at its open (a lower bound): every cell's first
  // gene is far past the time, and the reader fetches through gaps of a few
  // chunks between scattered rows (its merge gap).
  const link = { measured: true, latencyMs: 5, loadedLatencyMs: 5, bytesPerMs: 2000, bandwidthMeasured: false, concurrency: 6, shapingConcurrency: 6, mergeGapBytes: 200_000, readsAhead: false };
  const context = { valuesOnDemand: true, decodedChunkBytes: 1e9, budgets: { allowanceBytes: 1e12, columnIndexBytes: 1e12 }, link, geneTargetMs: 500, decodeBytesPerMs: null };
  // The bytes the first gene of an opening transfers for its sample: the
  // fit's, or every open cell's rows when its first gene fits the time.
  const sampleCost = resolution => {
    if (resolution.genes?.fit?.bytes !== undefined) return { bytes: resolution.genes.fit.bytes, requests: resolution.genes.fit.requests };
    const rows = resolution.kept === null ? Uint32Array.from({ length: cells }, (_, i) => i) : Uint32Array.from(resolution.kept).sort();
    return cost(rows);
  };
  const every = await resolveCellSubset(root, { mode: 'all' }, context);
  assert.ok(every.genes !== null && every.genes.cells < cells, 'every cell: a gene sample in the time');
  const whole = sampleCost(every);
  let bound = false;
  for (const method of ['uniform', 'blocks', 'spatial']) {
    for (const fraction of [0.01, 0.05, 0.2, 0.5]) {
      const share = await resolveCellSubset(root, { mode: 'subsample', method, fraction, seed: 3 }, context);
      const { bytes, requests } = sampleCost(share);
      assert.ok(bytes <= whole.bytes, `${method} ${fraction}: its sample reads ${bytes} bytes, every cell's ${whole.bytes}`);
      assert.ok(requests <= whole.requests, `${method} ${fraction}: its sample makes ${requests} requests, every cell's ${whole.requests}`);
      // The time alone would have bought the scattered share more bytes than the whole's.
      if (method === 'uniform' && share.genes !== null) bound ||= share.genes.fit.cells < share.genes.of;
    }
  }
  assert.ok(bound, 'a scattered share\'s sample is bounded by the whole\'s bytes');
});

test('the top-up after a share\'s first gene never transfers more than every cell\'s sample in the gene time, though each step\'s cells lie in every chunk', async () => {
  const { openZarr } = await import('../assets/js/formats/zarr/index.js');
  const { countingStore } = await import('./helpers/anndata-store.mjs');
  const { AnnDataReader } = await import('../assets/js/data/anndata/reader.js');
  const { ZARR_FORMAT } = await import('../assets/js/data/anndata/elements.js');
  const { wholeSampleCost } = await import('../assets/js/data/anndata/subsample-plan.js');
  const cells = 40_000;
  const tree = await chunkedAtlas({ cells });
  // A slow host as measured at the open: every cell's first gene is far past the time.
  const snapshot = { measured: true, latencyMs: 5, loadedLatencyMs: 5, bytesPerMs: 25, bandwidthMeasured: false, concurrency: 6, shapingConcurrency: 6, mergeGapBytes: 0, roundTripBytes: 100, readsAhead: false };
  const link = { readsAhead: false, mergeGapBytes: 0, roundTripBytes: 100, snapshot: () => snapshot, watchProtocol() {} };
  const counting = countingStore(tree);
  const root = await openZarr(counting.store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'share.zarr', link, cellSubset: { mode: 'subsample', method: 'uniform', fraction: 0.5, seed: 3 } });
  const sample = reader.geneSample;
  assert.equal(sample?.fit?.limit, 'geneTime', 'a fitted sample');
  const ceiling = await wholeSampleCost(root, cells, null, { link: snapshot, targetMs: sample.fit.budgetMs, valuesOnDemand: true, decodedChunkBytes: reader._decodedChunkBytes });
  assert.ok(Number.isFinite(ceiling.bytes) && Number.isFinite(ceiling.requests), 'every cell\'s sample is bounded by the gene time too');
  // The matrix's stored bytes fetched (its pointers, indices and values).
  const xBytes = () => counting.reads.filter(read => read.key.startsWith('X/')).reduce((sum, read) => sum + read.end - read.start, 0);
  await reader.getMatrixColumn('X', 3);
  const firstGeneBytes = xBytes();
  // The page's top-up over a link measured fast after the first gene (the
  // worst case: every step asks for every open cell, the time no bound).
  let spentBytes = sample.fit.bytes;
  let spentRequests = sample.fit.requests;
  let steps = 0;
  const uncapped = await reader.geneSampleCost('X', sample.of);
  assert.ok(spentBytes + uncapped.bytes > ceiling.bytes || spentRequests + uncapped.requests > ceiling.requests,
    `without the rule the share would read ${spentBytes + uncapped.bytes} bytes in ${spentRequests + uncapped.requests} requests, every cell's ${ceiling.bytes} in ${ceiling.requests}`);
  for (;;) {
    const now = reader.geneSample;
    if (now === null) break;
    const cost = await reader.geneSampleCost('X', now.of, { geneTime: { ms: sample.fit.budgetMs, spentBytes, spentRequests } });
    assert.deepEqual(cost.ceiling, ceiling);
    if (cost.target <= now.cells) break;
    spentBytes += cost.bytes;
    spentRequests += cost.requests;
    await reader.growGeneSample('X', cost.target, { gene: 3 });
    steps++;
    assert.ok(steps < 50);
  }
  assert.ok(steps >= 1, 'the top-up read genes for more cells');
  assert.ok(spentBytes <= ceiling.bytes, `the share's sample transferred ${spentBytes} bytes in its gene time, every cell's ${ceiling.bytes}`);
  assert.ok(spentRequests <= ceiling.requests, `the share's sample made ${spentRequests} requests in its gene time, every cell's ${ceiling.requests}`);
  assert.ok(reader.geneSample !== null && reader.geneSample.cells < sample.of, 'stopped at the ceiling, short of every open cell');
  // What the store answered agrees: the pricing is of the bytes fetched.
  assert.ok(xBytes() <= ceiling.bytes, `fetched ${xBytes()} bytes of the matrix (first gene ${firstGeneBytes}), every cell's sample ${ceiling.bytes}`);
  // Every cell of the file in its own order is the whole: no ceiling.
  const whole = new AnnDataReader();
  await whole.open(await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 }), { format: ZARR_FORMAT, name: 'share.zarr', link, cellSubset: { mode: 'all' } });
  assert.equal((await whole.geneSampleCost('X', cells, { geneTime: { ms: sample.fit.budgetMs, spentBytes: 0 } })).ceiling, null);
});

test('a share\'s row runs hold 32-bit positions where every one fits, and 64-bit ones past them', async () => {
  const { runsOfPositions } = await import('../assets/js/data/anndata/views/cell-subset.js');
  const runs = runsOfPositions(Uint32Array.from([7, 3, 4, 5, 9]));
  assert.ok(runs.starts instanceof Uint32Array && runs.ends instanceof Uint32Array && runs.offsets instanceof Uint32Array);
  assert.deepEqual([runs.count, Array.from(runs.starts), Array.from(runs.ends), Array.from(runs.offsets)], [3, [7, 3, 9], [8, 6, 10], [0, 1, 4, 5]]);
  // A run ending at row 2^32 (the last row a Uint32Array names, plus one) is kept exact.
  const last = runsOfPositions(Uint32Array.from([0xfffffffe, 0xffffffff]));
  assert.ok(last.ends instanceof Float64Array);
  assert.equal(last.ends[0], 2 ** 32);
});

for (const fraction of [0.3, 0.5, 0.7]) {
test(`a ${fraction} share's gene pass holds no more than it needs: no open-order entry runs, no decoded chunks past a window, 32-bit row runs`, async () => {
  const { countingStore } = await import('./helpers/anndata-store.mjs');
  const { openZarr } = await import('../assets/js/formats/zarr/index.js');
  const { AnnDataReader } = await import('../assets/js/data/anndata/reader.js');
  const { ZARR_FORMAT } = await import('../assets/js/data/anndata/elements.js');
  const { tree, expected } = await interleavedAtlas('csr');
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  // A decoded-chunk budget far smaller than the matrix's chunks, decoded.
  await reader.open(root, { format: ZARR_FORMAT, name: 'share.zarr', decodedChunkBytes: 400_000, cellSubset: { mode: 'subsample', method: 'uniform', fraction, seed: 0, genes: 'all' } });
  // The arrays asked of the open cells' matrix in open order (each made
  // from its kept rows' entry runs in open order: 2.5M runs at 5M cells).
  const asked = [];
  const viewRoot = reader._root;
  // The view's nodes are frozen: a node of their own, the same but for `get`.
  const delegate = (target, wrapGet) => Object.defineProperty(Object.create(target), 'get', { value: wrapGet });
  const viewX = viewRoot.get('X');
  const watchedX = delegate(viewX, key => {
    asked.push(key);
    return viewX.get(key);
  });
  reader._root = delegate(viewRoot, key => (key === 'X' ? watchedX : viewRoot.get(key)));
  const names = await reader.readObsNames();
  const column = await reader.getMatrixColumn('X', 9);
  names.forEach((name, i) => assert.equal(column[i], expected(Number(String(name).slice(1)), 9), name));
  // Its own pass in store order reads its rows' pointers; the pass over
  // every stored row of a share of two thirds of the entries or more
  // (`_restrictsWhole`) reads the stored ones only.
  const whole = fraction >= 2 / 3;
  assert.equal(viewRoot.rowPointersOf('X') === null, whole, whole ? 'the open rows\' pointers are never read' : 'its row pointers are read');
  assert.deepEqual(asked.filter(key => key === 'indices' || key === 'data'), [], 'no array of the matrix in open order was made');
  reader._root = viewRoot;
  // The pass in store order kept no chunk of the matrix's entries in the
  // store's decoded chunks (a window of its own held the ones a slab shares
  // with the next).
  const keptKeys = [...reader._decodedChunks._kept.keys()];
  assert.deepEqual(keptKeys.filter(key => /X\/(indices|data)\|/.test(key)), [], `kept: ${keptKeys.slice(0, 5).join(', ')}`);
  // Its row runs are 32-bit.
  assert.ok(reader._cellSubset.rows.runs().starts instanceof Uint32Array);
  reader.close();
});
}

test('the byte reader lets the gap bytes it fetched go once nothing is fetched or waits for a while', async () => {
  const { createByteReader, SURPLUS_IDLE_MS } = await import('../assets/js/formats/io/byte-reader.js');
  const { bytesByteSource } = await import('../assets/js/formats/io/byte-source.js');
  const bytes = Uint8Array.from({ length: 50_000 }, (_, i) => (i * 7 + 3) & 0xff);
  const base = bytesByteSource(bytes, { name: 'gaps', policy: { blockBytes: 1024, mergeGapBytes: 20_000, maxRequestBytes: 1 << 20, concurrency: 4, cacheBytes: 1 << 20 } });
  const log = [];
  const source = { ...base, async read(offset, length, options = {}) { log.push([offset, length]); return base.read(offset, length, options); } };
  const reader = createByteReader(source);
  // Two reads planned together across a gap: one request, the gap kept.
  await Promise.all([reader.read(1000, 100), reader.read(9000, 100)]);
  assert.equal(log.length, 1);
  // A read inside the gap soon after is answered from it.
  assert.deepEqual(await reader.read(5000, 100), bytes.subarray(5000, 5100));
  assert.equal(log.length, 1, 'answered from the gap fetched');
  // Idle past the hold: the gap's bytes are let go, and fetched again when asked.
  await new Promise(resolve => setTimeout(resolve, SURPLUS_IDLE_MS + 100));
  assert.deepEqual(await reader.read(5000, 100), bytes.subarray(5000, 5100));
  assert.equal(log.length, 2, 'the gap was let go once idle');
});

test('the open rows\' presented indptr holds no copy of their pointers: each read makes the integers of the rows it asks for', async () => {
  const { pointerArray } = await import('../assets/js/data/anndata/views/cell-subset.js');
  const pointers = Float64Array.from({ length: 1_000_001 }, (_, i) => i * 3);
  const node = pointerArray('/X/indptr', pointers);
  // Nothing per row made with the node (a copy held the open rows' pointers a third time).
  assert.ok(Object.values(node).every(value => !ArrayBuffer.isView(value)), 'no array held by the node');
  assert.deepEqual(node.dtype, { ...node.dtype, kind: 'int', bytes: 4 });
  assert.deepEqual(Array.from(await node.read([[10, 13]])), [30, 33, 36]);
  const whole = await node.read(null);
  assert.ok(whole instanceof Int32Array && whole.length === pointers.length && whole[1_000_000] === 3_000_000);
  // Past 2^31 entries: 64-bit integers.
  const wide = pointerArray('/X/indptr', Float64Array.of(0, 2 ** 32));
  assert.equal(wide.dtype.bytes, 8);
  assert.deepEqual(Array.from(await wide.read(null)), [0n, 2n ** 32n]);
});

test('no byte is fetched twice within one read: the gap bytes a running read fetched stay until it ends, past the surplus budget and the idle second', async () => {
  const { createByteReader, SURPLUS_IDLE_MS } = await import('../assets/js/formats/io/byte-reader.js');
  const { bytesByteSource } = await import('../assets/js/formats/io/byte-source.js');
  const { ReadActivity } = await import('../assets/js/formats/io/activity.js');
  const bytes = Uint8Array.from({ length: 400_000 }, (_, i) => (i * 13 + 5) & 0xff);
  // A surplus budget smaller than one merged request: without the hold, the request is let go at once.
  const base = bytesByteSource(bytes, { name: 'heap', policy: { blockBytes: 1024, mergeGapBytes: 60_000, maxRequestBytes: 1 << 20, concurrency: 4, cacheBytes: 30_000 } });
  const log = [];
  const source = { ...base, async read(offset, length, options = {}) { log.push([offset, length]); return base.read(offset, length, options); } };
  const reader = createByteReader(source);
  const names = new ReadActivity({ label: 'names', kind: 'obs' });
  // References read across a gap holding the heap bytes they name (one request of 50 KB).
  await Promise.all([reader.read(1_000, 100, { activity: names }), reader.read(50_000, 100, { activity: names })]);
  assert.equal(log.length, 1);
  // Another read's gaps fill the surplus meanwhile, and the reader is idle past the hold.
  await Promise.all([reader.read(200_000, 100), reader.read(240_000, 100)]);
  await Promise.all([reader.read(300_000, 100), reader.read(340_000, 100)]);
  await new Promise(resolve => setTimeout(resolve, SURPLUS_IDLE_MS + 100));
  const before = log.length;
  // The heap bytes, once the references are decoded: from the request already fetched.
  assert.deepEqual(await reader.read(20_000, 5_000, { activity: names }), bytes.subarray(20_000, 25_000));
  assert.equal(log.length, before, 'nothing fetched twice within the read');
  assert.ok(reader.heldBytes() >= 49_100, `the running read's request is held and counted (${reader.heldBytes()} bytes)`);
  // Once the read ends, its request goes like any other.
  names.finish();
  await new Promise(resolve => setTimeout(resolve, SURPLUS_IDLE_MS + 100));
  assert.ok(reader.heldBytes() <= 30_000 + 4096, `let go once the read ended (${reader.heldBytes()} bytes held)`);
});

test('what running reads hold of their requests stays within the memory model\'s budget, however long the read: the oldest go first', async () => {
  const { createByteReader, configureByteReaders } = await import('../assets/js/formats/io/byte-reader.js');
  const { bytesByteSource } = await import('../assets/js/formats/io/byte-source.js');
  const { ReadActivity } = await import('../assets/js/formats/io/activity.js');
  const bytes = Uint8Array.from({ length: 1_200_000 }, (_, i) => (i * 7 + 3) & 0xff);
  // Each reader its own source (a link remembered under one name would be measured already).
  let made = 0;
  const fresh = () => {
    const base = bytesByteSource(bytes, { name: `long-read-${made++}`, policy: { blockBytes: 1024, mergeGapBytes: 60_000, maxRequestBytes: 1 << 20, concurrency: 4, cacheBytes: 30_000 } });
    const log = [];
    // Each request a round trip of a few milliseconds, as a remote host's: the gaps stay worth fetching once measured.
    return { log, reader: createByteReader({ ...base, async read(offset, length, options = {}) { log.push([offset, length]); await new Promise(resolve => setTimeout(resolve, 5)); return base.read(offset, length, options); } }) };
  };
  // An export's read, front to back: pairs of rows across a gap, each pair one merged request of ~50 KB.
  const longRead = async ({ reader }) => {
    const activity = new ReadActivity({ label: 'export', kind: 'cells' });
    let peak = 0;
    for (let at = 0; at < 1_000_000; at += 100_000) {
      await Promise.all([reader.read(at, 100, { activity }), reader.read(at + 50_000, 100, { activity })]);
      peak = Math.max(peak, reader.heldBytes());
    }
    activity.finish();
    return peak;
  };
  try {
    // Unbounded, the read held every request it made until it ended (10 of ~50 KB).
    configureByteReaders({ holdBytes: null });
    const unbounded = await longRead(fresh());
    assert.ok(unbounded >= 450_000, `without a budget the read held ${unbounded} bytes`);
    configureByteReaders({ holdBytes: () => 120_000 });
    const bounded = await longRead(fresh());
    assert.ok(bounded <= 120_000 + 50_100, `held ${bounded} bytes within a 120,000-byte budget (one request over at most)`);
    // The gap bytes a running read asks right after its request was made are still there (the newest are kept).
    const { reader, log } = fresh();
    const activity = new ReadActivity({ label: 'names', kind: 'obs' });
    await Promise.all([reader.read(1_000, 100, { activity }), reader.read(50_000, 100, { activity })]);
    const before = log.length;
    assert.deepEqual(await reader.read(20_000, 5_000, { activity }), bytes.subarray(20_000, 25_000));
    assert.equal(log.length, before, 'the newest request held answers its gap');
    activity.finish();
  } finally {
    configureByteReaders({ holdBytes: null });
  }
});
