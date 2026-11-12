/**
 * A share never does more gene-index work than every cell (the owner's
 * share rule, `AnnDataReader._restrictsWhole`), counted, never timed:
 *
 * - **Spread rows holding at least the share of the entries that makes
 *   their own pass more work read through every stored row's index**,
 *   restricted to them (`restrictedAccess`): the entries indexed are every
 *   cell's, the view does no work of its own (no kept row's pointer read, no
 *   entry gathered), the matrix's reads are every cell's, and the values are the
 *   rows' own, bit for bit. A 50% uniform share of a 4M-cell file took
 *   1.4x every cell's first gene on a link faster than decoding: its pass in
 *   store order gathered each kept row's entries out of the decoded chunks.
 * - **The choice weighs the work measured on the source** (`PassRates`,
 *   `wholeIsCheaper`): the index's own work per entry, the view's, and a
 *   gene's placement in open order on either path; before any is measured,
 *   a share keeping at least two thirds of the entries. A 50% uniform
 *   share's first gene and marker genes took 1.3-1.7x on every stored row's
 *   index what they took on its own pass (Chromium, 10M cells).
 * - **Every stored row's index is kept as every cell's**: an opening of
 *   every cell later takes it, and the share takes one every cell kept.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { PassRates, restrictedAccess, wholeIsCheaper } from '../assets/js/data/anndata/prefix-column-index.js';

/** A CSR atlas whose rows a uniform share keeps throughout the store, as a Zarr tree. */
async function spreadAtlas() {
  const { annData, dataFrame, dense, mapping, sparse, strings } = await import('./helpers/anndata-store.mjs');
  // Enough rows that the first segment in open order would be a share of
  // them (`rowsInterleaved`): the rows lie spread through the store.
  const cells = 120_000;
  const genes = 40;
  const perCell = 30;
  const data = new Float32Array(cells * perCell);
  const indices = new Int32Array(cells * perCell);
  const indptr = new Int32Array(cells + 1);
  for (let cell = 0; cell < cells; cell++) {
    const row = Array.from({ length: perCell }, (_, j) => (cell * 3 + j) % genes).sort((a, b) => a - b);
    for (let j = 0; j < perCell; j++) {
      indices[cell * perCell + j] = row[j];
      data[cell * perCell + j] = 1 + ((cell * 7 + j) % 9);
    }
    indptr[cell + 1] = (cell + 1) * perCell;
  }
  const X = sparse({ format: 'csr', data, indices, indptr, shape: [cells, genes], compressed: true });
  X.children.data.chunks = [6000];
  X.children.indices.chunks = [6000];
  X.children.indptr.chunks = [10_000];
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: cells }, (_, i) => `c${i}`), { chunks: [8000] }) }),
    var: dataFrame({ _index: strings(Array.from({ length: genes }, (_, g) => `g${g}`)) }),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: cells * 2 }, (_, i) => i), [cells, 2], { chunks: [8000, 2], compressed: true }) }),
    X,
  });
  const expected = (cell, gene) => {
    for (let e = indptr[cell]; e < indptr[cell + 1]; e++) if (indices[e] === gene) return data[e];
    return 0;
  };
  return { tree, expected, nnz: cells * perCell };
}

/** Open `tree` with `cellSubset`, read genes, and count the work of the reader's gene index. */
async function geneWork(tree, cellSubset, { keptIndexes = null, genes = [5, 9, 17] } = {}) {
  const { countingStore } = await import('./helpers/anndata-store.mjs');
  const { openZarr } = await import('../assets/js/formats/zarr/index.js');
  const { AnnDataReader } = await import('../assets/js/data/anndata/reader.js');
  const { ZARR_FORMAT } = await import('../assets/js/data/anndata/elements.js');
  const counting = countingStore(tree);
  const root = await openZarr(counting.store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'spread.zarr', cellSubset, ...(keptIndexes === null ? {} : { keptIndexes }) });
  const names = await reader.readObsNames();
  const before = counting.fetched.length;
  const columns = [];
  for (const gene of genes) columns.push(await reader.getMatrixColumn('X', gene));
  const sparse = await reader.getMatrixColumnsSparse('X', genes);
  const fetched = counting.fetched.slice(before).filter(key => /^X\/(indices|data)\//.test(key));
  await reader.whenIndexesKept();
  const work = {
    names,
    columns,
    sparse,
    indexed: reader._passRates._index.entries,
    viewEntries: reader._passRates._view.entries,
    viewMs: reader._passRates._view.ms,
    chunkReads: fetched.length,
    distinctChunks: new Set(fetched).size,
    openPointers: reader._root.rowPointersOf?.('X') ?? null,
    segments: reader._matrices.get('X').columns.source?.segments?.map(segment => [segment.start, segment.rows]) ?? null,
  };
  reader.close();
  return work;
}

test('a share keeping at least two thirds of the entries reads through every stored row\'s index: every cell\'s work and reads, no view work, the rows\' own values', async () => {
  const { tree, expected, nnz } = await spreadAtlas();
  const every = await geneWork(tree, { mode: 'all', genes: 'all' });
  assert.equal(every.indexed, nnz, 'every cell indexes every entry once');
  for (const fraction of [0.7, 0.8]) {
    const share = await geneWork(tree, { mode: 'subsample', method: 'uniform', fraction, seed: 0, genes: 'all' });
    assert.equal(share.indexed, every.indexed, `a ${fraction} share indexes every cell's entries, no more`);
    assert.deepEqual([share.viewEntries, share.viewMs], [0, 0], 'its view does no work of its own');
    assert.equal(share.openPointers, null, 'its open rows\' pointers are never read');
    assert.deepEqual([share.chunkReads, share.distinctChunks], [every.chunkReads, every.distinctChunks], 'every cell\'s reads of the matrix, no more');
    assert.deepEqual(share.segments, [[0, share.names.length]], 'one segment of every open row');
    [5, 9, 17].forEach((gene, g) => {
      share.names.forEach((name, i) => assert.equal(share.columns[g][i], expected(Number(String(name).slice(1)), gene), `${fraction} gene ${gene} ${name}`));
      // The sparse column: the dense one's cells that hold a value, ascending.
      const dense = share.columns[g];
      const cells = [];
      for (let i = 0; i < dense.length; i++) if (dense[i] !== 0) cells.push(i);
      assert.deepEqual(Array.from(share.sparse[g].indices), cells, `${fraction} gene ${gene} sparse cells`);
      assert.deepEqual(Array.from(share.sparse[g].values), cells.map(i => dense[i]), `${fraction} gene ${gene} sparse values`);
    });
  }
  // Fewer: its own pass in store order, over its entries alone (its
  // entries, and the view's work), each gene placed from its own entries.
  for (const fraction of [0.2, 0.5]) {
    const small = await geneWork(tree, { mode: 'subsample', method: 'uniform', fraction, seed: 0, genes: 'all' });
    assert.ok(small.indexed < every.indexed * (fraction + 0.05), `${fraction}: ${small.indexed} entries indexed, every cell ${every.indexed}`);
    assert.equal(small.viewEntries, small.indexed, `${fraction}: measured as a pass over the view`);
    assert.notEqual(small.openPointers, null, `${fraction}: its rows' pointers are read`);
    assert.equal(small.chunkReads, small.distinctChunks, `${fraction}: each stored chunk once`);
    small.names.forEach((name, i) => assert.equal(small.columns[0][i], expected(Number(String(name).slice(1)), 5), `${fraction} ${name}`));
  }
});

test('every stored row\'s index a share builds is kept as every cell\'s: every cell takes it, and a share takes the one every cell kept', async t => {
  const { opfsOnDisk } = await import('./helpers/opfs-on-disk.mjs');
  const { tree, expected } = await spreadAtlas();
  for (const order of ['share first', 'every cell first']) {
    const disk = opfsOnDisk();
    t.after(() => disk.cleanup());
    const keptIndexes = { identity: { kind: 'remote', key: `host:${order}`, version: `md5:${'0'.repeat(32)}:1` }, environment: disk.environment };
    const share = { mode: 'subsample', method: 'uniform', fraction: 0.7, seed: 3, genes: 'all' };
    const every = { mode: 'all', genes: 'all' };
    const [first, second] = order === 'share first' ? [share, every] : [every, share];
    const built = await geneWork(tree, first, { keptIndexes });
    assert.ok(built.chunkReads > 0, `${order}: the first opening builds the index`);
    const taken = await geneWork(tree, second, { keptIndexes });
    assert.equal(taken.chunkReads, 0, `${order}: the second opening reads no byte of the index`);
    assert.equal(taken.indexed, 0, `${order}: and indexes nothing`);
    const opened = second === share ? taken : built;
    opened.names.forEach((name, i) => assert.equal(opened.columns[1][i], expected(Number(String(name).slice(1)), 9), `${order} ${name}`));
  }
});

test('the choice weighs the work measured on the source: before any is measured, at least two thirds of the entries', () => {
  // Unmeasured, an entry is one operation of each kind: the whole indexes
  // and places every entry (2), the share indexes, gathers and places its
  // own (3 each).
  const unmeasured = new PassRates();
  assert.equal(unmeasured.msPerEntry('index'), null);
  assert.equal(unmeasured.msPerEntry('placeWhole'), null);
  assert.equal(wholeIsCheaper({ keptEntries: 666, allEntries: 1000, rates: unmeasured }), false);
  assert.equal(wholeIsCheaper({ keptEntries: 667, allEntries: 1000, rates: unmeasured }), true);
  // Only the index measured: the view's work and both placements taken as the index's.
  const indexOnly = new PassRates();
  indexOnly.noteIndex({ entries: 1000, ms: 4 });
  assert.equal(indexOnly.msPerEntry('index'), 0.004);
  assert.equal(wholeIsCheaper({ keptEntries: 667, allEntries: 1000, rates: indexOnly }), true);
  assert.equal(wholeIsCheaper({ keptEntries: 500, allEntries: 1000, rates: indexOnly }), false);
  // A view whose work costs three times the index's an entry: two fifths of the entries is enough.
  const costlyView = new PassRates();
  costlyView.noteIndex({ entries: 1000, ms: 1 }, { overView: true });
  costlyView.view.note(3);
  assert.equal(costlyView.msPerEntry('view'), 0.003);
  assert.equal(wholeIsCheaper({ keptEntries: 400, allEntries: 1000, rates: costlyView }), true);
  assert.equal(wholeIsCheaper({ keptEntries: 399, allEntries: 1000, rates: costlyView }), false);
  // Placement measured on the whole (each of every stored row's entries
  // twice an index entry): the whole's placement of every entry weighs.
  const placing = new PassRates();
  placing.noteIndex({ entries: 1000, ms: 1 }, { overView: true });
  placing.view.note(1);
  placing.placing('whole').note(1000, 2);
  assert.equal(placing.msPerEntry('placeWhole'), 0.002);
  assert.equal(placing.msPerEntry('placeOwn'), null);
  // Whole 1000 × (1 + 2); share kept × (1 + 1 + 2): at 750 entries.
  assert.equal(wholeIsCheaper({ keptEntries: 750, allEntries: 1000, rates: placing }), true);
  assert.equal(wholeIsCheaper({ keptEntries: 749, allEntries: 1000, rates: placing }), false);
  // The share's own placement measured cheaper an entry: it weighs on its side.
  placing.placing('own').note(1000, 1);
  assert.equal(wholeIsCheaper({ keptEntries: 900, allEntries: 1000, rates: placing }), false);
  assert.equal(wholeIsCheaper({ keptEntries: 1000, allEntries: 1000, rates: placing }), true);
  assert.throws(() => placing.placing('neither'), TypeError);
});

test('a restricted column is the rows\' own, bit for bit: from the pass\'s column of every stored row, or from the entries once built', async () => {
  // Stored rows 0..7; the segment's open rows 0..3 are stored rows 6, 1, 4, 3 (from open row 2 on).
  const stored = Float32Array.of(0, 1.5, -0 + 0, 3, NaN, 5, 6.25, 0);
  const entries = { length: 8, indices: Uint32Array.of(1, 3, 4, 5, 6), values: Float32Array.of(1.5, 3, NaN, 5, 6.25) };
  const fileRows = Uint32Array.of(6, 1, 4, 3);
  const table = new Int32Array(8).fill(-1);
  [0, 0, 6, 1, 4, 3].forEach((row, open) => { if (open >= 2) table[row] = open; });
  let built = false;
  const whole = {
    built: () => built,
    indexing: () => false,
    column: async () => stored.slice(),
    sparseColumn: async () => entries,
  };
  const access = restrictedAccess(whole, fileRows, () => ({ table, get: row => table[row] }), 2);
  const want = [6.25, 1.5, NaN, 3];
  const same = (got, label) => {
    assert.equal(got.length, 4, label);
    want.forEach((value, i) => assert.ok(Object.is(got[i], value), `${label}: open row ${i} ${got[i]} for ${value}`));
  };
  same(await access.column(0), 'from the pass');
  built = true;
  same(await access.column(0), 'from the entries');
  const sparse = await access.sparseColumn(0);
  assert.deepEqual(Array.from(sparse.indices), [0, 1, 2, 3]);
  assert.ok(Object.is(sparse.values[2], NaN) && sparse.values[0] === 6.25 && sparse.values[3] === 3);
});

test('a restricted gene looks up only its entries on rows the segment opens: the rest are skipped by a bit, the answer the same as a lookup of each entry and a sort', async () => {
  // A 50% uniform share's markers looked up every stored row's entries in
  // the open rows' table (40 MB at 10M cells, a cache miss each): 5.2 s of
  // the reader's 11 s, traced. Half are of rows not open.
  const nStored = 20_000;
  let seed = 7;
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const order = Uint32Array.from({ length: nStored }, (_, i) => i);
  for (let i = nStored - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const open = order.subarray(0, nStored / 2);
  const start = 3000;
  const fileRows = open.subarray(start);
  const positionOf = new Map(Array.from(open, (row, at) => [row, at]));
  for (const tableForm of [false, true]) {
    let lookups = 0;
    const table = new Int32Array(nStored).fill(-1);
    open.forEach((row, at) => { table[row] = at; });
    const positions = () => (tableForm
      ? { table, get: row => table[row] }
      : { table: null, get: row => { lookups++; return positionOf.get(row) ?? -1; } });
    const genes = [];
    for (let g = 0; g < 8; g++) {
      const rows = Uint32Array.from(new Set(Array.from({ length: 3000 }, () => Math.floor(random() * nStored)))).sort();
      genes.push({ length: nStored, indices: rows, values: Float32Array.from(rows, row => row / 7 - g) });
    }
    const whole = {
      built: () => true,
      building: () => false,
      column: async () => { throw new Error('built: answered from entries'); },
      sparseColumn: async gene => genes[gene],
    };
    const access = restrictedAccess(whole, fileRows, positions, start);
    for (let g = 0; g < genes.length; g++) {
      const before = lookups;
      const got = await access.sparseColumn(g);
      const onOpen = Array.from(genes[g].indices).filter(row => (positionOf.get(row) ?? -1) >= start);
      if (!tableForm) assert.equal(lookups - before, onOpen.length, `gene ${g}: a lookup an entry on a row the segment opens, none for the rest`);
      const want = Array.from(genes[g].indices, (row, e) => [(positionOf.get(row) ?? -1) - start, genes[g].values[e]])
        .filter(([at]) => at >= 0 && at < fileRows.length)
        .sort((a, b) => a[0] - b[0]);
      assert.deepEqual(Array.from(got.indices), want.map(([at]) => at), `gene ${g} cells`);
      assert.deepEqual(Array.from(got.values), want.map(([, value]) => Math.fround(value)), `gene ${g} values`);
      const column = await access.column(g);
      const dense = new Float32Array(fileRows.length);
      for (const [at, value] of want) dense[at] = value;
      assert.deepEqual(Array.from(column), Array.from(dense), `gene ${g} column`);
    }
  }
});
