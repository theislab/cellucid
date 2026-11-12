/**
 * A neighbor graph reaches its edges line by line (`graph-lines.js`),
 * from every place a graph comes from: an `obsp` CSR or CSC group read a
 * slab of lines at a time (never whole), a dense `obsp`, a Loom graph's
 * coordinate list (built in streamed passes: checked through the loompy
 * corpus, `formats-corpus-conformance`), and a MuData modality's graph
 * placed on the store's cells. Each gives exactly the edges of the graph
 * held whole; 64-bit positions are converted through their words; Seurat's
 * unit diagonal (a cell is its own neighbor in `RNA_snn`) is no edge.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { extractConnectivityEdges, connectivityEdgesFromLines } from '../assets/js/data/connectivity-edges.js';
import { denseGraphLines, gatheredGraph, heldGraphLines, inducedGraphLines, placedGraphLines, readPlacedGraphRows, sparseGraphLines } from '../assets/js/data/anndata/graph-lines.js';
import { CellRows } from '../assets/js/data/anndata/views/cell-subset.js';
import { placedGraph } from '../assets/js/data/anndata/views/modalities.js';
import { SLAB_BYTES } from '../assets/js/data/anndata/values.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { dense, group, mapping, minimalAnnData, openReader, openStore, sparse } from './helpers/anndata-store.mjs';

/** A ring of `n` cells, each joined to the next `k` on either side, weight 1/distance, as CSR. */
function ring(n, k, { diagonal = false } = {}) {
  const indptr = new Int32Array(n + 1);
  const width = 2 * k + (diagonal ? 1 : 0);
  const indices = new Int32Array(n * width);
  const data = new Float32Array(n * width);
  let at = 0;
  for (let row = 0; row < n; row++) {
    const entries = [];
    for (let step = -k; step <= k; step++) {
      if (step === 0 && !diagonal) continue;
      entries.push([(row + step + n) % n, step === 0 ? 1 : 1 / Math.abs(step)]);
    }
    entries.sort((a, b) => a[0] - b[0]);
    for (const [column, weight] of entries) {
      indices[at] = column;
      data[at] = weight;
      at++;
    }
    indptr[row + 1] = at;
  }
  return { indptr, indices, data, shape: [n, n] };
}

test('a sparse graph larger than one slab is read in slabs, and its edges are the whole graph\'s', async () => {
  // Past one slab of int32 indices and float32 weights (8 bytes an entry).
  const n = Math.ceil(SLAB_BYTES / 8 / 4) + 1000;
  const graph = ring(n, 2);
  const tree = minimalAnnData({ nObs: 1, extra: { g: sparse({ ...graph, chunks: 1 << 20 }) } });
  const { root } = await openStore(tree);
  const lines = await sparseGraphLines(root.get('g'), ZARR_FORMAT, 'Graph');
  let slabs = 0;
  let largest = 0;
  const counted = {
    ...lines,
    slabs: (async function* count() {
      for await (const slab of lines.slabs) {
        slabs++;
        largest = Math.max(largest, slab.indices.length);
        yield slab;
      }
    })(),
  };
  const streamed = await connectivityEdgesFromLines(counted, n);
  assert.ok(slabs >= 2, `${slabs} slabs`);
  assert.ok(largest * 8 <= SLAB_BYTES, 'no slab holds more than its bytes');
  const whole = extractConnectivityEdges({ format: 'csr', ...graph }, n);
  assert.equal(streamed.nEdges, whole.nEdges);
  assert.deepEqual(streamed, whole);
});

test('64-bit indices and pointers are read through their words, and a position outside the axis is refused', async () => {
  const graph = ring(30, 2);
  const tree = minimalAnnData({
    nObs: 1,
    extra: {
      g: sparse({
        ...graph,
        indices: BigInt64Array.from(graph.indices, BigInt),
        indicesDtype: '<i8',
        indptr: BigInt64Array.from(graph.indptr, BigInt),
        indptrDtype: '<i8',
        data: Float64Array.from(graph.data),
        dataDtype: '<f8',
      }),
      bad: sparse({ data: new Float32Array([1]), indices: BigInt64Array.of(2n ** 40n), indicesDtype: '<i8', indptr: new Int32Array([0, 1]), shape: [1, 1] }),
    },
  });
  const { root } = await openStore(tree);
  const gathered = await gatheredGraph(await sparseGraphLines(root.get('g'), ZARR_FORMAT, 'Graph'), 'Graph');
  assert.deepEqual(Array.from(gathered.indices), Array.from(graph.indices));
  assert.deepEqual(Array.from(gathered.indptr), Array.from(graph.indptr));
  assert.ok(gathered.data instanceof Float64Array);
  await assert.rejects(gatheredGraph(await sparseGraphLines(root.get('bad'), ZARR_FORMAT, 'Graph'), 'Graph'), /Graph index 1099511627776 is outside axis bounds \[0, 1\)/);
});

test('a dense graph is read by row slab, and gives the edges of the matrix held whole', async () => {
  const n = 12;
  const graph = ring(n, 1, { diagonal: true });
  const values = new Float32Array(n * n);
  for (let row = 0; row < n; row++) for (let at = graph.indptr[row]; at < graph.indptr[row + 1]; at++) values[row * n + graph.indices[at]] = graph.data[at];
  const tree = minimalAnnData({ nObs: 1, extra: { g: dense(values, [n, n], { chunks: [5, n] }) } });
  const { root } = await openStore(tree);
  const lines = await denseGraphLines(root.get('g'), n);
  assert.equal(lines.nnz, graph.indices.length);
  const edges = await connectivityEdgesFromLines(lines, n);
  assert.deepEqual(edges, extractConnectivityEdges({ format: 'dense', shape: [n, n], data: values }, n));
  assert.equal(edges.nEdges, n, 'a ring: one edge a cell, the diagonal left out');
});

test('a Seurat SNN graph (unit diagonal) read by the reader gives its off-diagonal edges', async () => {
  const n = 9;
  const { reader } = await openReader(minimalAnnData({ nObs: n, extra: { obsp: mapping({ RNA_snn: sparse(ring(n, 2, { diagonal: true })) }) } }));
  const edges = await reader.getConnectivityEdges('RNA_snn');
  assert.equal(edges.nEdges, n * 2);
  for (let cell = 0; cell < n; cell++) {
    const forward = Array.from(edges.partners.subarray(edges.forwardOffsets[cell], edges.forwardOffsets[cell + 1]));
    assert.ok(!forward.includes(cell), `cell ${cell} is not its own neighbour`);
  }
  // Its rows, read by cell from the file (the k-NN tool's): the diagonal left out too.
  const cells = Uint32Array.from({ length: n }, (_, i) => n - 1 - i);
  const rows = await reader.getConnectivityRows('RNA_snn', cells);
  cells.forEach((cell, i) => {
    const neighbours = Array.from(rows.neighbors.subarray(rows.offsets[i], rows.offsets[i + 1])).sort((a, b) => a - b);
    const expected = [-2, -1, 1, 2].map(step => (cell + step + n) % n).sort((a, b) => a - b);
    assert.deepEqual(neighbours, expected, `the row of cell ${cell}`);
  });
  await assert.rejects(reader.getConnectivityRows('RNA_snn', Uint32Array.of(n)), /outside the 9 open cells/);
  await assert.rejects(reader.getConnectivityRows('RNA_snn', Uint32Array.of(1, 1)), /distinct cells/);
  assert.equal(await reader.getConnectivityRows('absent', Uint32Array.of(1)), null);
});

test('the k-NN tool\'s rows are read by cell from every kind of stored graph: CSR, CSC, 64-bit, dense, chunk by chunk', async () => {
  const n = 40;
  const graph = ring(n, 3, { diagonal: true });
  const wide = { ...graph, indices: BigInt64Array.from(graph.indices, BigInt), indptr: BigInt64Array.from(graph.indptr, BigInt) };
  const values = new Float32Array(n * n);
  for (let row = 0; row < n; row++) for (let at = graph.indptr[row]; at < graph.indptr[row + 1]; at++) values[row * n + graph.indices[at]] = graph.data[at];
  // One stored zero: no neighbor, as it is no edge.
  values[0 * n + 1] = 0;
  values[1 * n + 0] = 0;
  const { reader } = await openReader(minimalAnnData({ nObs: n, extra: { obsp: mapping({
    csr: sparse({ ...graph, shape: [n, n] }),
    csc: sparse({ ...graph, shape: [n, n], format: 'csc' }),
    wide: sparse({ ...wide, shape: [n, n], indicesDtype: '<i8', indptrDtype: '<i8' }),
    dense: dense(values, [n, n], { chunks: [7, n] }),
  }) } }));
  // Scattered cells, adjacent runs and the last cell, in no order.
  const cells = Uint32Array.of(39, 0, 17, 18, 19, 5, 33);
  for (const key of ['csr', 'csc', 'wide', 'dense']) {
    const rows = await reader.getConnectivityRows(key, cells);
    cells.forEach((cell, i) => {
      const got = Array.from(rows.neighbors.subarray(rows.offsets[i], rows.offsets[i + 1])).sort((a, b) => a - b);
      let expected = [-3, -2, -1, 1, 2, 3].map(step => (cell + step + n) % n);
      if (key === 'dense' && cell <= 1) expected = expected.filter(other => other !== 1 - cell);
      assert.deepEqual(got, expected.sort((a, b) => a - b), `${key}: the row of cell ${cell}`);
    });
  }
});

test('a held graph (a subsample\'s induced subgraph) is one slab', async () => {
  const graph = ring(10, 1);
  const lines = heldGraphLines({ format: 'csr', ...graph });
  assert.deepEqual(await connectivityEdgesFromLines(lines, 10), extractConnectivityEdges({ format: 'csr', ...graph }, 10));
});

test('a MuData modality graph streams its lines and reads its rows on the store\'s cells, never building the placed arrays', async () => {
  // 40 modality rows over 52 store cells, in another order (a modality measures some cells).
  const modality = ring(40, 3);
  const tree = group({ g: sparse({ ...modality, shape: [40, 40] }) });
  const { root } = await openStore(tree);
  const nObs = 52;
  const rows = new Int32Array(nObs).fill(-1);
  const cellOfRow = new Int32Array(40);
  for (let row = 0; row < 40; row++) {
    const cell = (row * 17 + 5) % nObs;
    rows[cell] = row;
    cellOfRow[row] = cell;
  }
  const map = async () => ({ identity: false, rows });
  const placed = placedGraph(root.get('g'), map, nObs, '/obsp/rna:g');
  const options = { mergeGapBytes: () => 0, readOptions: {}, chunks: null };
  // The edges from its streamed lines equal those of the placed arrays held whole.
  const lines = await placedGraphLines(placed, nObs, options);
  assert.equal(lines.nnz, modality.indices.length);
  const streamed = await connectivityEdgesFromLines(lines, nObs);
  const fresh = placedGraph(root.get('g'), map, nObs, '/obsp/rna:g');
  const read = name => fresh.get(name).read(undefined, {});
  const [indptr, indices, data] = await Promise.all([read('indptr'), read('indices'), read('data')]);
  assert.deepEqual(streamed, extractConnectivityEdges({ format: 'csr', shape: [nObs, nObs], indptr, indices, data }, nObs));
  // Rows of store cells, in the order asked; an unmeasured cell's is empty.
  const cells = Uint32Array.of(51, 5, 0, 22, 39);
  const got = await readPlacedGraphRows(placed, cells, options);
  cells.forEach((cell, i) => {
    const row = rows[cell];
    const expected = row < 0 ? [] : [-3, -2, -1, 1, 2, 3].map(step => cellOfRow[(row + step + 40) % 40]).sort((a, b) => a - b);
    assert.deepEqual(Array.from(got.indices.subarray(got.pointers[i], got.pointers[i + 1])).sort((a, b) => a - b), expected, `cell ${cell}`);
  });
  // A subsample's induced subgraph of it streams by the same rows.
  const kept = Uint32Array.from({ length: nObs }, (_, cell) => cell).filter(cell => cell % 3 !== 1);
  let share = null;
  const induced = await inducedGraphLines(placed, new CellRows(kept, nObs), { ...options, onShare: value => { share = value; } });
  const subEdges = await connectivityEdgesFromLines(induced, kept.length);
  const positionOf = new Map(Array.from(kept, (cell, position) => [cell, position]));
  let expectedEdges = 0;
  for (let p = 0; p < kept.length; p++) {
    for (let e = indptr[kept[p]]; e < indptr[kept[p] + 1]; e++) if (positionOf.get(indices[e]) > p) expectedEdges++;
  }
  assert.equal(subEdges.nEdges, expectedEdges);
  assert.equal(share.kept, 2 * expectedEdges);
});

test('a MuData modality graph is placed on the store\'s cells from its lines, every row in column order', async () => {
  // The modality measured 4 of 6 store cells, in another order.
  const modality = ring(4, 1);
  const tree = group({ g: sparse({ ...modality, indices: BigInt64Array.from(modality.indices, BigInt), indicesDtype: '<i8' }) });
  const { root } = await openStore(tree);
  const rows = Int32Array.of(3, -1, 0, 2, -1, 1);
  const map = async () => ({ identity: false, rows });
  const placed = placedGraph(root.get('g'), map, 6, '/obsp/rna:g');
  const read = name => placed.get(name).read(undefined, {});
  const [indptr, indices, data] = await Promise.all([read('indptr'), read('indices'), read('data')]);
  // Store cell c holds modality row rows[c]; its neighbours are the store cells of that row's neighbours.
  const cellOf = row => rows.indexOf(row);
  for (let cell = 0; cell < 6; cell++) {
    const row = rows[cell];
    const got = Array.from(indices.subarray(indptr[cell], indptr[cell + 1]));
    const expected = row < 0 ? [] : Array.from(modality.indices.subarray(modality.indptr[row], modality.indptr[row + 1]), cellOf).sort((a, b) => a - b);
    assert.deepEqual(got, expected, `cell ${cell}`);
  }
  assert.equal(data.length, modality.data.length);
  const edges = extractConnectivityEdges({ format: 'csr', shape: [6, 6], indptr, indices, data }, 6);
  assert.equal(edges.nEdges, 4);
});
