/**
 * Edges at a share: a subsample's neighbor-graph edges never cost more than
 * every cell's, and are exactly the induced subgraph's.
 *
 * - A share's induced subgraph is read in the stored graph's order, by the
 *   cheaper of two reads (`graph-lines.js` `GraphReadPlan`): the open rows
 *   alone, or the whole graph streamed once keeping the open rows. Either
 *   read gives the edges of the induced subgraph computed here from the
 *   stored arrays, bit for bit, whatever order the cells were opened in.
 * - Its lines arrive in stored order, each column its row's rank: the edges
 *   are built in that order and placed on the open cells
 *   (`connectivity-edges.js` `relabel`), exactly as built from the cells'
 *   own lines.
 * - What it fetches: a uniform share whose rows lie in every chunk streams
 *   the graph (no more graph chunks than every cell's edges read); a small
 *   share in blocks reads only its rows' chunks.
 * - The k-NN tool's rows: a large frontier from the file reads no more than
 *   every cell's edges did, and the rows from the edges the page holds
 *   (`forwardEdgeRows`) are the file's.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { connectivityEdgeBytes, connectivityEdgesFromLines, extractConnectivityEdges, forwardEdgeRows } from '../assets/js/data/connectivity-edges.js';
import { inducedGraphLines } from '../assets/js/data/anndata/graph-lines.js';
import { CellRows } from '../assets/js/data/anndata/views/cell-subset.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { countingStore, mapping, minimalAnnData, sparse } from './helpers/anndata-store.mjs';

let seed = 0x5eed;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

/**
 * A symmetric k-NN-like graph of `n` cells as CSR: each cell joined to
 * neighbors near it in the file and, for some, to one far away (so a block
 * of cells reaches outside itself); float32 weights.
 */
function knnGraph(n) {
  const rows = Array.from({ length: n }, () => new Map());
  const join = (a, b, w) => { if (a !== b) { rows[a].set(b, w); rows[b].set(a, w); } };
  for (let a = 0; a < n; a++) {
    for (let step = 1; step <= 3; step++) join(a, (a + step) % n, Math.fround(1 / step));
    if (a % 5 === 0) join(a, Math.floor(random() * n), Math.fround(0.25 + random() / 2));
  }
  const indptr = new Int32Array(n + 1);
  const indices = [];
  const data = [];
  for (let a = 0; a < n; a++) {
    for (const [b, w] of [...rows[a]].sort((x, y) => x[0] - y[0])) {
      indices.push(b);
      data.push(w);
    }
    indptr[a + 1] = indices.length;
  }
  return { indptr, indices: Int32Array.from(indices), data: Float32Array.from(data), shape: [n, n] };
}

/** The edges of the induced subgraph on `order` (open cell i = stored row order[i]), from the stored arrays. */
function inducedEdges(graph, order) {
  const n = graph.shape[0];
  const position = new Int32Array(n).fill(-1);
  order.forEach((row, i) => { position[row] = i; });
  const indptr = new Float64Array(order.length + 1);
  const indices = [];
  const data = [];
  order.forEach((row, i) => {
    for (let e = graph.indptr[row]; e < graph.indptr[row + 1]; e++) {
      const q = position[graph.indices[e]];
      if (q >= 0) {
        indices.push(q);
        data.push(graph.data[e]);
      }
    }
    indptr[i + 1] = indices.length;
  });
  return extractConnectivityEdges({ format: 'csr', shape: [order.length, order.length], indptr, indices: Int32Array.from(indices), data: Float32Array.from(data) }, order.length);
}

function sameEdges(actual, expected, label) {
  const n = expected.nEdges;
  assert.equal(actual.nEdges, n, `${label}: edges`);
  assert.equal(actual.maxWeight, expected.maxWeight, `${label}: strongest`);
  assert.equal(actual.maxNeighbors, expected.maxNeighbors, `${label}: largest degree`);
  assert.deepEqual(actual.forwardOffsets, expected.forwardOffsets, `${label}: offsets`);
  assert.deepEqual(actual.partners.subarray(0, n), expected.partners.subarray(0, n), `${label}: partners`);
  assert.deepEqual(new Uint32Array(actual.strengths.buffer, actual.strengths.byteOffset, n),
    new Uint32Array(expected.strengths.buffer, expected.strengths.byteOffset, n), `${label}: strengths, bit for bit`);
}

const N = 6000;
const CHUNK = 512;
const GRAPH = knnGraph(N);

async function openGraph(cellSubset) {
  const tree = minimalAnnData({ nObs: N, extra: { obsp: mapping({ connectivities: sparse({ ...GRAPH, chunks: CHUNK, compressed: true }) }) } });
  const { store, fetched } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'graph.zarr', decodedChunkBytes: 0, cellSubset });
  return { reader, fetched, root };
}

const graphChunks = fetched => fetched.filter(key => key.includes('obsp/connectivities/')).length;

test('a share\'s edges are its induced subgraph\'s, bit for bit, by either read and in every opening order', async () => {
  const { reader: all, fetched: allFetched } = await openGraph({ mode: 'all' });
  const before = allFetched.length;
  sameEdges(await all.getConnectivityEdges('connectivities'), extractConnectivityEdges({ format: 'csr', ...GRAPH }, N), 'every cell');
  const everyCell = graphChunks(allFetched.slice(before));
  for (const [method, k] of [['uniform', 60], ['uniform', 600], ['uniform', 3000], ['blocks', 600], ['blocks', 3000]]) {
    const label = `${method} ${k}`;
    const { reader, fetched, root } = await openGraph({ mode: 'subsample', method, k, strict: true });
    const order = Array.from(reader.cellSubset.openOrder);
    const expected = inducedEdges(GRAPH, order);
    const mark = fetched.length;
    sameEdges(await reader.getConnectivityEdges('connectivities'), expected, label);
    // Never more graph chunks than every cell's edges read.
    assert.ok(graphChunks(fetched.slice(mark)) <= everyCell, `${label}: ${graphChunks(fetched.slice(mark))} graph chunks, every cell ${everyCell}`);
    // Both reads, whichever the reader would choose, give the same edges.
    const rows = new CellRows(Uint32Array.from(order), N);
    await root.load?.(['obsp/connectivities/*']);
    for (const plan of ['rows', 'stream']) {
      const lines = await inducedGraphLines(root.get('obsp/connectivities'), rows, { mergeGapBytes: () => 0, choose: () => plan });
      // Lines in stored order: relabeled onto the open cells unless they were opened in it.
      assert.equal(lines.relabel === null, order.every((row, i) => i === 0 || row > order[i - 1]), `${label} ${plan}: relabelled exactly when out of stored order`);
      sameEdges(await connectivityEdgesFromLines(lines, order.length), expected, `${label} by ${plan}`);
    }
  }
});

test('a uniform share whose rows lie in every chunk streams the graph; a small block share reads only its rows\' chunks', async () => {
  // Uniform half: every chunk of 512 entries (about 70 cells) holds open rows.
  const uniform = await openGraph({ mode: 'subsample', method: 'uniform', k: 3000, strict: true });
  const order = Array.from(uniform.reader.cellSubset.openOrder);
  const sorted = Uint32Array.from(order).sort();
  assert.equal(await uniform.reader._graphReadPlan({ group: uniform.root.get('obsp/connectivities'), rows: sorted, nRows: N }), 'stream');
  // Four blocks of 32 cells apart: the rows alone (one block alone is one
  // range, which both reads read the same).
  const block = await openGraph({ mode: 'subsample', method: 'blocks', k: 128, blockSize: 32, strict: true });
  const kept = Uint32Array.from(block.reader.cellSubset.openOrder).sort();
  assert.equal(await block.reader._graphReadPlan({ group: block.root.get('obsp/connectivities'), rows: kept, nRows: N }), 'rows');
  const mark = block.fetched.length;
  await block.reader.getConnectivityEdges('connectivities');
  // Graph chunks fetched: only those the kept rows' pointers and entries lie in.
  const allowed = new Set();
  for (const row of kept) {
    allowed.add(`indptr/${Math.floor(row / CHUNK)}`);
    allowed.add(`indptr/${Math.floor((row + 1) / CHUNK)}`);
    for (let e = GRAPH.indptr[row]; e < GRAPH.indptr[row + 1]; e++) {
      allowed.add(`indices/${Math.floor(e / CHUNK)}`);
      allowed.add(`data/${Math.floor(e / CHUNK)}`);
    }
  }
  for (const key of block.fetched.slice(mark)) {
    if (!key.includes('obsp/connectivities/')) continue;
    const tail = key.slice(key.indexOf('obsp/connectivities/') + 'obsp/connectivities/'.length).split('.')[0];
    assert.ok(allowed.has(tail), `a share of four blocks fetched ${key}, which holds none of its rows`);
  }
});

test('the k-NN tool\'s rows: a large frontier reads no more than every cell\'s edges, and the edges held give the same rows', async () => {
  const { reader: all, fetched: allFetched } = await openGraph({ mode: 'all' });
  let mark = allFetched.length;
  await all.getConnectivityEdges('connectivities');
  const everyCell = graphChunks(allFetched.slice(mark));
  const { reader, fetched } = await openGraph({ mode: 'subsample', method: 'uniform', k: 3000, strict: true });
  const edges = await reader.getConnectivityEdges('connectivities');
  // A frontier of every other open cell, in no order.
  const cells = Uint32Array.from({ length: 1500 }, (_, i) => (i * 7919) % 3000);
  assert.equal(new Set(cells).size, cells.length);
  mark = fetched.length;
  const fromFile = await reader.getConnectivityRows('connectivities', cells);
  assert.ok(graphChunks(fetched.slice(mark)) <= everyCell, 'a large frontier reads no more graph chunks than every cell\'s edges');
  const fromEdges = await forwardEdgeRows(edges, cells);
  assert.deepEqual(fromEdges.offsets, fromFile.offsets);
  cells.forEach((cell, i) => {
    const file = Array.from(fromFile.neighbors.subarray(fromFile.offsets[i], fromFile.offsets[i + 1])).sort((a, b) => a - b);
    const held = Array.from(fromEdges.neighbors.subarray(fromEdges.offsets[i], fromEdges.offsets[i + 1]));
    assert.deepEqual(held, file, `cell ${cell}: the same neighbours, ascending`);
  });
});

test('edges built over lines in another order are placed on the cells exactly as built from the cells\' own lines', async () => {
  for (const [n, cells, slab] of [[1, 3, 1], [200, 200, 7], [3000, 5000, 100000], [3000, 3000, 1]]) {
    const graph = knnGraph(n);
    // Line i is cell positions[i]: an injection into `cells` cells.
    const pool = Uint32Array.from({ length: cells }, (_, i) => i);
    for (let i = cells - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const positions = pool.slice(0, n);
    const own = new Int32Array(cells).fill(-1);
    positions.forEach((cell, line) => { own[cell] = line; });
    const indptr = new Float64Array(cells + 1);
    const indices = [];
    const data = [];
    for (let cell = 0; cell < cells; cell++) {
      const line = own[cell];
      if (line >= 0) {
        const entries = [];
        for (let e = graph.indptr[line]; e < graph.indptr[line + 1]; e++) entries.push([positions[graph.indices[e]], graph.data[e]]);
        for (const [c, w] of entries.sort((x, y) => x[0] - y[0])) {
          indices.push(c);
          data.push(w);
        }
      }
      indptr[cell + 1] = indices.length;
    }
    const expected = extractConnectivityEdges({ format: 'csr', shape: [cells, cells], indptr, indices: Int32Array.from(indices), data: Float32Array.from(data) }, cells);
    async function* slabs() {
      for (let start = 0; start < n; start += slab) {
        const end = Math.min(n, start + slab);
        const from = graph.indptr[start];
        yield {
          start, end,
          pointers: Float64Array.from({ length: end - start + 1 }, (_, i) => graph.indptr[start + i] - from),
          indices: graph.indices.slice(from, graph.indptr[end]),
          data: graph.data.slice(from, graph.indptr[end]),
        };
      }
    }
    // Placed in two walks (three of the four edge arrays held), or in one
    // when the four fit what every stored line's edges take to build.
    for (const wholeBuildBytes of [0, Infinity]) {
      const got = await connectivityEdgesFromLines({ nnz: graph.indices.length, float32: true, relabel: { positions, nCells: cells, wholeBuildBytes }, slabs: slabs() }, cells);
      sameEdges(got, expected, `${n} lines on ${cells} cells, ${wholeBuildBytes === 0 ? 'two walks' : 'one walk'}`);
    }
  }
  // While they are placed, three of the four edge arrays (the lines' and the
  // cells') are held, and counted so in the build's working set.
  const own = connectivityEdgeBytes({ nCells: 1e6, nnz: 2e7, float32: true });
  const placed = connectivityEdgeBytes({ nCells: 1e6, nnz: 2e7, float32: true, relabelCells: 2e6 });
  assert.equal(placed.held, 4 * (2e6 + 1) + 8 * 1e7);
  assert.ok(placed.build >= 4 * (1e6 + 1) + 12 * 1e7 + 8 * (2e6 + 1), 'three of the four edge arrays counted while the edges are placed');
  // An asymmetric graph is refused in the lines' order, as in the cells'.
  const graph = knnGraph(50);
  const data = graph.data.slice();
  data[3] *= 2;
  const lines = { nnz: data.length, float32: true, relabel: { positions: Uint32Array.from({ length: 50 }, (_, i) => 49 - i), nCells: 50 },
    slabs: (async function* () { yield { start: 0, end: 50, pointers: Float64Array.from(graph.indptr), indices: graph.indices, data }; })() };
  await assert.rejects(connectivityEdgesFromLines(lines, 50), /exactly symmetric/);
});
