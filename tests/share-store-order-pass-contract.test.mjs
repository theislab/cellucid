/**
 * The work a spread share's first gene does before and around its one pass
 * in store order, counted: passes, lookups, sorts and lists made, never wall
 * clock. A 50 % uniform share of a 10M-cell CSR `.h5ad` read its first gene
 * in 12.55 s against every cell's 11.59 s, the same bytes: the link stood
 * idle while the reader sorted and listed the share's 5M rows several
 * times over before the pass began.
 *
 * - **The open rows in file order are made once** (`CellRows.byRow`): the
 *   order the pass answers in (`fileOrderedAccess`) and the rows it reads
 *   (`ascending`, the rows the pointers were read for) are the view's own,
 *   shared, with no row list, sort or run of the pass's own.
 * - **Pointers are read over the rows ascending**, one pass, ranges a few
 *   pointers apart one (`readKeptRowPointers`); no run of the rows in open
 *   order is placed in them until something reads the rows in open order
 *   (`RowPointers.runIndexFor`).
 * - **What the gene plan says needs no open-order matrix** when the rest is
 *   one segment in store order (`_segmentProgress`): the plan of a 50 %
 *   share listed its 5M open rows' entries in open order to price a pass
 *   that never reads them.
 * - **The kept values and their chunks are one walk** (`keptValueStats`),
 *   exact against a row-by-row count.
 * - **Pricing a read lists no piece** (`planBoxes` `pieces: false`): the
 *   boxes of pieces in source order are made as the runs are walked, the
 *   same boxes as the full plan.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CellRows, RowPointers, keptChunkShare, keptValueCount, keptValueStats, planBoxes, runsOfPositions } from '../assets/js/data/anndata/views/cell-subset.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';

/** A CSR atlas whose rows a uniform share keeps throughout the store (as `subsample-share-cost-contract`'s). */
async function spreadAtlas() {
  const { annData, dataFrame, dense, mapping, sparse, strings } = await import('./helpers/anndata-store.mjs');
  // Enough rows that the first segment in open order (a slab of the index's
  // work) would be a share of them (`rowsInterleaved`): one pass in store order instead.
  const cells = 120_000;
  const genes = 40;
  const perCell = 30;
  const data = new Float32Array(cells * perCell);
  const indices = new Int32Array(cells * perCell);
  const indptr = new Int32Array(cells + 1);
  for (let cell = 0; cell < cells; cell++) {
    const row = Array.from({ length: perCell }, (_, j) => (cell + j) % genes).sort((a, b) => a - b);
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
    obs: dataFrame({ _index: strings(Array.from({ length: cells }, (_, i) => `c${i}`), { chunks: [10_000] }) }),
    var: dataFrame({ _index: strings(Array.from({ length: genes }, (_, g) => `g${g}`)) }),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: cells * 2 }, (_, i) => i), [cells, 2], { chunks: [10_000, 2], compressed: true }) }),
    X,
  });
  const expected = (cell, gene) => {
    for (let e = indptr[cell]; e < indptr[cell + 1]; e++) if (indices[e] === gene) return data[e];
    return 0;
  };
  return { tree, expected };
}

test('a spread share\'s gene plan and first gene in store order: the open rows in file order made once and shared, no open-order matrix, no run placed in the pointers', async () => {
  const { countingStore } = await import('./helpers/anndata-store.mjs');
  const { openZarr } = await import('../assets/js/formats/zarr/index.js');
  const { AnnDataReader } = await import('../assets/js/data/anndata/reader.js');
  const { ZARR_FORMAT } = await import('../assets/js/data/anndata/elements.js');
  const { tree, expected } = await spreadAtlas();
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'spread.zarr', cellSubset: { mode: 'subsample', method: 'uniform', fraction: 0.4, seed: 0, genes: 'all' } });
  reader.createActivity = () => ({ status: 'running', expect() {}, progress() {}, finish() { this.status = 'done'; } });
  const names = await reader.readObsNames();
  const rows = reader._cellSubset.rows;
  assert.notEqual(rows._ascending, null, 'the rows ascending are made as the share opens');
  // Counted: open-order matrices made, runs placed in the pointers, and the
  // open rows put in file order (each a pass over every open row).
  const counts = { openOrderMatrices: 0, runIndexes: 0, byRow: 0, ascending: 0 };
  const { _openRowsMatrix } = AnnDataReader.prototype;
  const { runIndexFor } = RowPointers.prototype;
  const { byRow, ascending } = CellRows.prototype;
  AnnDataReader.prototype._openRowsMatrix = function counted(...args) { counts.openOrderMatrices++; return _openRowsMatrix.apply(this, args); };
  RowPointers.prototype.runIndexFor = function counted(cellRows) {
    const made = this.runIndex === null && this.forRows?.deref() === cellRows;
    if (made) counts.runIndexes++;
    return runIndexFor.call(this, cellRows);
  };
  CellRows.prototype.byRow = function counted() { if (this._byRow === null) counts.byRow++; return byRow.call(this); };
  CellRows.prototype.ascending = function counted() { if (this._ascending === null) counts.ascending++; return ascending.call(this); };
  let column;
  try {
    const plan = await reader.geneReadPlan('X');
    assert.equal(plan.progressive, null, 'one pass in store order');
    column = await reader.getMatrixColumn('X', 5);
  } finally {
    AnnDataReader.prototype._openRowsMatrix = _openRowsMatrix;
    RowPointers.prototype.runIndexFor = runIndexFor;
    CellRows.prototype.byRow = byRow;
    CellRows.prototype.ascending = ascending;
  }
  names.forEach((name, i) => assert.equal(column[i], expected(Number(String(name).slice(1)), 5), name));
  // The rows ascending were made as the share opened (its chunk share estimated over them), once.
  assert.deepEqual(counts, { openOrderMatrices: 0, runIndexes: 0, byRow: 1, ascending: 0 }, 'each made once, no open-order work');
  // The pass answers in the view's own file order: its rows are the rows ascending, shared.
  const { order, rows: inFileOrder } = rows.byRow();
  assert.equal(inFileOrder, rows.ascending());
  for (let i = 1; i < inFileOrder.kept.length; i++) assert.ok(inFileOrder.kept[i] > inFileOrder.kept[i - 1]);
  for (let i = 0; i < order.length; i += 997) assert.equal(inFileOrder.kept[i], rows.kept[order[i]]);
  // The reader counts what the rows in file order hold, beside the rows.
  assert.equal(rows.byteLength, rows.kept.byteLength + rows.runs().starts.byteLength * 2 + rows.runs().offsets.byteLength + inFileOrder.byteLength + order.byteLength + (rows._positions?.byteLength ?? 0));
  assert.ok(rows.buffers().has(order.buffer) && rows.buffers().has(inFileOrder.kept.buffer));
  // The pointers: read over the rows ascending, ranges merged across gaps of a few rows.
  const pointers = reader._root.rowPointersOf('X');
  assert.ok(pointers instanceof RowPointers);
  assert.ok(pointers.starts.length * 4 < inFileOrder.runs().count, `${pointers.starts.length} pointer ranges for ${inFileOrder.runs().count} runs of the rows ascending`);
  assert.equal(pointers.runIndex, null, 'no run of the rows in open order placed');
  // The kept values, exact.
  let values = 0;
  for (let i = 0; i < rows.kept.length; i++) values += 30;
  assert.equal(reader._cellSubset.keptValues, values);
  reader.close();
});

test('the kept values and the chunks they lie in are one walk forward over the rows ascending, exact against a row-by-row count', () => {
  const random = createMulberry32(5);
  const nRows = 20_000;
  const indptr = new Float64Array(nRows + 1);
  for (let row = 0; row < nRows; row++) indptr[row + 1] = indptr[row] + Math.floor(random() * 9);
  const nnz = indptr[nRows];
  for (const share of [0.01, 0.1, 0.5, 0.9]) {
    const kept = Uint32Array.from({ length: nRows }, (_, i) => i).filter(() => random() < share);
    // In a random (open) order, and ascending.
    const shuffled = kept.slice();
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    let exactValues = 0;
    const touched = new Set();
    for (const row of kept) {
      exactValues += indptr[row + 1] - indptr[row];
      for (let e = indptr[row]; e < indptr[row + 1]; e++) touched.add(Math.floor(e / 64));
    }
    const exactShare = touched.size / Math.ceil(nnz / 64);
    for (const rows of [kept, shuffled]) {
      assert.deepEqual(keptValueStats(indptr, rows, 64, nnz), { values: exactValues, chunkShare: exactShare }, `share ${share}`);
      assert.equal(keptValueCount(indptr, rows), exactValues);
      assert.equal(keptChunkShare(indptr, rows, 64, nnz), exactShare);
    }
    // Over some rows' pointers (`RowPointers`), walked forward: each pointer once, no lookup.
    const pointers = new RowPointers(Float64Array.of(0), Float64Array.of(nRows + 1), Float64Array.of(0), indptr);
    let lookups = 0;
    const { indexOf } = RowPointers.prototype;
    RowPointers.prototype.indexOf = function counted(row) { lookups++; return indexOf.call(this, row); };
    try {
      assert.deepEqual(keptValueStats(pointers, kept, 64, nnz), { values: exactValues, chunkShare: exactShare });
    } finally {
      RowPointers.prototype.indexOf = indexOf;
    }
    assert.equal(lookups, 0, 'a walk forward, no lookup');
  }
});

test('pricing a read of pieces in source order lists no piece and makes the same boxes as the full plan', () => {
  const random = createMulberry32(9);
  const rows = Uint32Array.from({ length: 200_000 }, (_, i) => i).filter(() => random() < 0.5);
  const runs = runsOfPositions(rows);
  const total = runs.offsets[runs.count];
  for (const [a, b] of [[0, total], [17, total - 5], [total / 4, total / 2]].map(([x, y]) => [Math.floor(x), Math.floor(y)])) {
    for (const chunkRows of [4096, null]) {
      const options = { chunkRows, rowBytes: 4, storedRowBytes: 4, mergeGapBytes: 64 };
      const full = planBoxes(runs, a, b, options);
      const lean = planBoxes(runs, a, b, { ...options, pieces: false });
      assert.equal(lean.pieceStarts, null, 'no piece listed');
      assert.deepEqual(lean.boxes, full.boxes, `[${a}, ${b}) chunk rows ${chunkRows}`);
    }
  }
  // Pieces not in source order: the full plan, sorted, as before.
  const reversed = { count: 2, starts: Float64Array.of(100, 0), ends: Float64Array.of(110, 10), offsets: Float64Array.of(0, 10, 20) };
  const lean = planBoxes(reversed, 0, 20, { chunkRows: null, rowBytes: 4, mergeGapBytes: 0, pieces: false });
  assert.deepEqual(lean.boxes.map(box => [box.start, box.end]), [[0, 10], [100, 110]]);
  assert.ok(lean.order instanceof Uint32Array);
});
