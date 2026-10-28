/**
 * Subsampled reading, differentially: for stores drawn at random across the
 * layout space, every read of a subsample equals reading every cell and
 * keeping the kept rows, bit for bit, and fetches no chunk that holds no
 * kept row (a byte budget computed here from the layout alone, independently
 * of the reader).
 *
 * The space: X and a layer as CSR, CSC or dense, int32 or int64 indices and
 * pointers, chunk lengths from one row to the whole array, empty rows and
 * all-zero genes; obs with a categorical field (unused categories, missing
 * codes), a float, an integer and a nullable boolean column; a 2-D and a 3-D
 * embedding of their own chunking; a neighbour graph with self-loops; and a
 * MuData store of two modalities, one measuring only some cells, in a cell
 * order of its own. Each case is a seed; every method, a random size and a
 * random seed run on it.
 *
 * `SUBSAMPLE_SOAK=<cases>` runs that many cases (a local soak run); the
 * default is what the contract suite affords.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  annData,
  group,
  array,
  categorical,
  countingStore,
  dataFrame,
  dense,
  mapping,
  nullable,
  sparse,
  strings,
} from './helpers/anndata-store.mjs';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';
import { keptCellsOf } from '../assets/js/data/anndata/subsample-plan.js';
import { rankOf } from '../assets/js/data/subsample.js';
import { priorityOrder } from '../assets/js/data/subsample.js';
import { readSparseMatrix } from '../assets/js/data/anndata/sparse.js';
import { describeAnnDataProbes } from '../assets/js/data/data-mapping-candidates.js';

const CASES = Number(process.env.SUBSAMPLE_SOAK ?? 24);

function draw(random, low, high) {
  return low + Math.floor(random() * (high - low + 1));
}

/** A random cells × genes matrix as rows of {gene: value}, some rows and genes empty. */
function randomMatrix(random, nObs, nVars) {
  const emptyGene = draw(random, 0, nVars - 1);
  const density = random() * 0.6;
  const rows = [];
  for (let cell = 0; cell < nObs; cell++) {
    const row = new Map();
    if (random() > 0.15) {
      for (let gene = 0; gene < nVars; gene++) {
        if (gene !== emptyGene && random() < density) row.set(gene, Math.fround(1 + random() * 9));
      }
    }
    rows.push(row);
  }
  return rows;
}

/** One matrix node of a layout: CSR, CSC or dense, with random dtypes and chunks. */
function matrixNode(random, rows, nObs, nVars, layout) {
  const wide = random() < 0.4;
  const indexDtype = wide ? '<i8' : '<i4';
  const pointerDtype = random() < 0.4 ? '<i8' : '<i4';
  const toIndex = values => (wide ? values.map(BigInt) : values);
  const toPointer = values => (pointerDtype === '<i8' ? values.map(BigInt) : values);
  if (layout === 'dense') {
    const values = new Float32Array(nObs * nVars);
    rows.forEach((row, cell) => row.forEach((value, gene) => { values[cell * nVars + gene] = value; }));
    return dense(values, [nObs, nVars], { chunks: [draw(random, 1, nObs), draw(random, 1, nVars)] });
  }
  const data = [];
  const indices = [];
  const indptr = [0];
  if (layout === 'csr') {
    for (const row of rows) {
      for (const gene of [...row.keys()].sort((a, b) => a - b)) {
        indices.push(gene);
        data.push(row.get(gene));
      }
      indptr.push(data.length);
    }
  } else {
    for (let gene = 0; gene < nVars; gene++) {
      rows.forEach((row, cell) => {
        if (row.has(gene)) {
          indices.push(cell);
          data.push(row.get(gene));
        }
      });
      indptr.push(data.length);
    }
  }
  const node = sparse({
    format: layout,
    data: Float32Array.from(data),
    indices: toIndex(indices),
    indptr: toPointer(indptr),
    shape: [nObs, nVars],
    indicesDtype: indexDtype,
    indptrDtype: pointerDtype,
  });
  // Each array its own chunk length, down to one element.
  const chunk = Math.max(1, draw(random, 1, Math.max(1, data.length)));
  node.children.data.chunks = [chunk];
  node.children.indices.chunks = [Math.max(1, draw(random, 1, Math.max(1, data.length)))];
  node.children.indptr.chunks = [Math.max(1, draw(random, 1, indptr.length))];
  return node;
}

function randomGraph(random, nObs) {
  const rows = [];
  for (let cell = 0; cell < nObs; cell++) {
    const row = new Map([[cell, 1]]);
    for (let k = 0; k < 4; k++) row.set(draw(random, 0, nObs - 1), Math.fround(random()));
    rows.push(row);
  }
  return rows;
}

function graphNode(random, rows, nObs) {
  const data = [];
  const indices = [];
  const indptr = [0];
  for (const row of rows) {
    for (const column of [...row.keys()].sort((a, b) => a - b)) {
      indices.push(column);
      data.push(row.get(column));
    }
    indptr.push(data.length);
  }
  const node = sparse({ format: 'csr', data: Float32Array.from(data), indices, indptr, shape: [nObs, nObs] });
  node.children.data.chunks = [draw(random, 1, data.length)];
  node.children.indices.chunks = [draw(random, 1, data.length)];
  return node;
}

/** A random AnnData tree, and what it holds. */
function randomTree(seed) {
  const random = createMulberry32(seed);
  const nObs = draw(random, 2, 160);
  const nVars = draw(random, 1, 12);
  const layouts = ['csr', 'csc', 'dense'];
  const xLayout = layouts[draw(random, 0, 2)];
  const layerLayout = layouts[draw(random, 0, 2)];
  const cellChunk = () => [draw(random, 1, nObs)];
  const nCategories = draw(random, 1, 7);
  const codes = Int8Array.from({ length: nObs }, () => (random() < 0.1 ? -1 : draw(random, 0, Math.max(0, nCategories - 2))));
  const names = Array.from({ length: nObs }, (_, i) => `cell-${i}`);
  const obs = dataFrame({
    _index: strings(names, { chunks: cellChunk() }),
    cluster: categorical(codes, Array.from({ length: nCategories }, (_, c) => `c${c}`)),
    score: array(Float32Array.from({ length: nObs }, () => random()), { chunks: cellChunk() }),
    count: array(Int32Array.from({ length: nObs }, () => draw(random, 0, 100)), { dtype: '<i4', chunks: cellChunk() }),
    flag: nullable('nullable-boolean', Array.from({ length: nObs }, () => random() < 0.5), Array.from({ length: nObs }, () => random() < 0.2)),
  });
  obs.children.cluster.children.codes.chunks = cellChunk();
  const umap = Float32Array.from({ length: nObs * 2 }, () => (random() < 0.03 ? Number.NaN : random() * 10));
  const tree = annData({
    obs,
    var: dataFrame({ _index: strings(Array.from({ length: nVars }, (_, g) => `g${g}`)) }),
    obsm: mapping({
      X_umap: dense(umap, [nObs, 2], { chunks: [draw(random, 1, nObs), draw(random, 1, 2)] }),
      X_3d: dense(Float32Array.from({ length: nObs * 3 }, () => random()), [nObs, 3], { chunks: [draw(random, 1, nObs), 3] }),
    }),
    obsp: mapping({ connectivities: graphNode(random, randomGraph(random, nObs), nObs) }),
    X: matrixNode(random, randomMatrix(random, nObs, nVars), nObs, nVars, xLayout),
    layers: mapping({ counts: matrixNode(random, randomMatrix(random, nObs, nVars), nObs, nVars, layerLayout) }),
  });
  return { tree, nObs, nVars, random, xLayout, layerLayout };
}

async function openTree(tree, cellSubset) {
  const { store, fetched } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'case.zarr', decodedChunkBytes: 0, cellSubset });
  return { reader, fetched, root };
}

function gather(values, kept, width = 1) {
  const out = new values.constructor(kept.length * width);
  kept.forEach((p, i) => { for (let c = 0; c < width; c++) out[i * width + c] = values[p * width + c]; });
  return out;
}

function sameBits(actual, expected, label) {
  assert.equal(actual.constructor, expected.constructor, `${label}: type`);
  assert.equal(actual.length, expected.length, `${label}: length`);
  if (ArrayBuffer.isView(actual)) {
    const a = new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
    const b = new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength);
    assert.deepEqual(a, b, `${label}: bits`);
  } else {
    assert.deepEqual(actual, expected, `${label}: values`);
  }
}

/** The sparse column of a full read, placed on the kept cells. */
function keptSparse(column, positionOf, k) {
  const entries = [];
  for (let e = 0; e < column.indices.length; e++) {
    const position = positionOf.get(column.indices[e]);
    if (position !== undefined) entries.push([position, column.values[e]]);
  }
  // Open cells ascending, as every sparse column lists them.
  entries.sort((a, b) => a[0] - b[0]);
  return { length: k, indices: Uint32Array.from(entries, ([p]) => p), values: Float32Array.from(entries, ([, v]) => v) };
}

/** Chunk keys of a row-chunked array that hold a kept row, and every chunk of it. */
function chunkBudget(path, chunkRows, keptRanges) {
  const keys = new Set();
  for (const [start, end] of keptRanges) {
    for (let c = Math.floor(start / chunkRows); c <= Math.floor((end - 1) / chunkRows); c++) keys.add(c);
  }
  return { path, keys };
}

const METHODS = ['uniform', 'blocks', 'stratified', 'spatial'];

/** Uniform by brute force: every position's rank, the k lowest, ascending. */
function referenceUniform(n, k, seed) {
  return Array.from({ length: n }, (_, p) => p).sort((a, b) => rankOf(seed, a) - rankOf(seed, b)).slice(0, k).sort((a, b) => a - b);
}

/** Blocks by brute force: blocks by rank, whole until the last, cut to its first cells. */
function referenceBlocks(n, k, seed, size) {
  const blocks = Array.from({ length: Math.ceil(n / size) }, (_, j) => j).sort((a, b) => rankOf(seed, a) - rankOf(seed, b));
  const kept = [];
  for (const block of blocks) {
    for (let p = block * size; p < Math.min(n, (block + 1) * size) && kept.length < k; p++) kept.push(p);
    if (kept.length === k) break;
  }
  return kept.sort((a, b) => a - b);
}

test('subsampled reads equal a full read then a gather, and fetch only chunks of kept rows', async () => {
  for (let c = 0; c < CASES; c++) {
    const seed = 0x5eed0000 + c;
    const { tree, nObs, nVars, random, xLayout, layerLayout } = randomTree(seed);
    const full = await openTree(tree, null);
    const fullObs = {};
    for (const key of full.reader.obsKeys) fullObs[key] = await full.reader.getObsField(key);
    const fullX = await full.reader.getMatrixColumns('X', Array.from({ length: nVars }, (_, g) => g));
    const fullLayer = await full.reader.getMatrixColumnsSparse('layers/counts', Array.from({ length: nVars }, (_, g) => g));
    const fullUmap = await full.reader.readObsmColumns('X_umap', [0, 1]);
    const full3d = await full.reader.readObsmColumns('X_3d', [0, 2]);
    const fullGraph = await full.reader.getConnectivities('connectivities');

    for (const method of METHODS) {
      const k = draw(random, 1, nObs - 1);
      const request = { mode: 'subsample', method, k, seed: draw(random, 0, 0xffffffff) };
      if (method === 'stratified') {
        request.field = 'cluster';
        request.allocation = random() < 0.5 ? 'balanced' : 'proportional';
      }
      if (method === 'spatial') request.gridSize = draw(random, 1, 9);
      if (method === 'blocks') request.blockSize = draw(random, 1, nObs);
      const label = `case ${c} (n=${nObs}, X ${xLayout}, layer ${layerLayout}) ${method} k=${k}`;
      let subset;
      try {
        subset = await openTree(tree, request);
      } catch (error) {
        throw new Error(`${label}: ${error.message}`, { cause: error });
      }
      const { reader, fetched } = subset;
      const info = reader.cellSubset;
      assert.equal(reader.nObs, k, `${label}: cell count`);
      assert.equal(info.nObs, nObs);
      // The kept cells, from a reference independent of the code under test
      // for uniform and blocks (brute-force ranks); stratified and spatial
      // are held to the shared fixture (subsample-conformance.test.mjs).
      const expectedKept = method === 'uniform' ? referenceUniform(nObs, k, info.spec.seed)
        : method === 'blocks' ? referenceBlocks(nObs, k, info.spec.seed, info.spec.blockSize)
          : Array.from(await keptCellsOf(full.root, info.spec));
      assert.deepEqual(Array.from(info.kept), expectedKept, `${label}: kept cells are the specification's`);
      // Open cell i is original position openOrder[i]: the kept cells in
      // their method's priority order.
      assert.deepEqual(info.openOrder, priorityOrder(info.spec, info.kept), `${label}: opened in priority order`);
      const kept = Array.from(info.openOrder);
      const positionOf = new Map(kept.map((p, i) => [p, i]));

      // obs, every column.
      for (const key of full.reader.obsKeys) {
        const got = await reader.getObsField(key);
        const want = fullObs[key];
        if (want.dtype === 'categorical') {
          sameBits(got.codes, gather(want.codes, kept), `${label}: obs ${key} codes`);
          assert.deepEqual(got.categories, want.categories);
        } else if (ArrayBuffer.isView(want.values)) {
          sameBits(got.values, gather(want.values, kept), `${label}: obs ${key}`);
        } else {
          assert.deepEqual(got.values, kept.map(p => want.values[p]), `${label}: obs ${key}`);
          if (want.mask !== undefined) assert.deepEqual(Array.from(got.mask ?? []), kept.map(p => want.mask[p]), `${label}: obs ${key} mask`);
        }
      }
      // Embeddings.
      sameBits(await reader.readObsmColumns('X_umap', [0, 1]), gather(fullUmap, kept, 2), `${label}: X_umap`);
      sameBits(await reader.readObsmColumns('X_3d', [0, 2]), gather(full3d, kept, 2), `${label}: X_3d`);
      // Genes, dense and sparse, of X and the layer.
      const genes = Array.from({ length: nVars }, (_, g) => g);
      const gotX = await reader.getMatrixColumns('X', genes);
      gotX.forEach((column, g) => sameBits(column, gather(fullX[g], kept), `${label}: X gene ${g}`));
      const gotLayer = await reader.getMatrixColumnsSparse('layers/counts', genes);
      gotLayer.forEach((column, g) => {
        const want = keptSparse(fullLayer[g], positionOf, k);
        assert.equal(column.length, k);
        sameBits(Uint32Array.from(column.indices), want.indices, `${label}: layer gene ${g} cells`);
        sameBits(Float32Array.from(column.values), want.values, `${label}: layer gene ${g} values`);
      });
      // Rows and a cell subset of X.
      const cells = kept.map((_, i) => i).filter(() => random() < 0.5);
      const rows = await reader.getMatrixRows('X', cells);
      const fullRows = await full.reader.getMatrixRows('X', cells.map(i => kept[i]));
      rows.forEach((row, i) => {
        sameBits(row.genes, fullRows[i].genes, `${label}: X row ${cells[i]} genes`);
        sameBits(row.values, fullRows[i].values, `${label}: X row ${cells[i]} values`);
      });
      if (cells.length > 0) {
        const someGenes = genes.filter(() => random() < 0.6);
        if (someGenes.length > 0) {
          const block = await reader.getMatrixCellSubset('X', cells, someGenes);
          const fullBlock = await full.reader.getMatrixCellSubset('X', cells.map(i => kept[i]), someGenes);
          sameBits(block.cellIndex, fullBlock.cellIndex, `${label}: cell subset positions`);
          sameBits(block.values, fullBlock.values, `${label}: cell subset values`);
        }
      }
      // The neighbour graph: the induced subgraph.
      const graph = await reader.getConnectivities('connectivities');
      const want = { indptr: [0], indices: [], data: [] };
      for (const p of kept) {
        for (let e = fullGraph.indptr[p]; e < fullGraph.indptr[p + 1]; e++) {
          const q = positionOf.get(fullGraph.indices[e]);
          if (q !== undefined) {
            want.indices.push(q);
            want.data.push(fullGraph.data[e]);
          }
        }
        want.indptr.push(want.indices.length);
      }
      assert.deepEqual(Array.from(graph.indptr), want.indptr, `${label}: graph pointers`);
      assert.deepEqual(Array.from(graph.indices), want.indices, `${label}: graph indices`);
      sameBits(graph.data, Float32Array.from(want.data), `${label}: graph values`);
      assert.deepEqual(graph.shape, [k, k]);
      // How much of the open cells' graph the subgraph keeps.
      const ofKeptRows = kept.reduce((sum, p) => sum + fullGraph.indptr[p + 1] - fullGraph.indptr[p], 0);
      assert.deepEqual(reader.subsampleGraphShare('connectivities'), { kept: want.indices.length, of: ofKeptRows }, `${label}: graph share`);

      // The byte budget: row-chunked cell arrays fetched only chunks of kept rows.
      const ranges = kept.map(p => [p, p + 1]);
      const budgets = [
        chunkBudget('obs/score', tree.children.obs.children.score.chunks[0], ranges),
        chunkBudget('obs/count', tree.children.obs.children.count.chunks[0], ranges),
        // A stratified subsample reads its field's codes whole to choose the cells.
        ...(method === 'stratified' ? [] : [chunkBudget('obs/cluster/codes', tree.children.obs.children.cluster.children.codes.chunks[0], ranges)]),
        chunkBudget('obs/_index', tree.children.obs.children._index.chunks[0], ranges),
      ];
      // A spatial subsample reads its embedding whole to choose the cells.
      if (method !== 'spatial') budgets.push(chunkBudget('obsm/X_umap', tree.children.obsm.children.X_umap.chunks[0], ranges));
      // The graph: only the kept rows' entry ranges.
      const graphNode = tree.children.obsp.children.connectivities.children;
      const graphPointers = Array.from(graphNode.indptr.values, Number);
      const graphRanges = kept.map(p => [graphPointers[p], graphPointers[p + 1]]).filter(([s, e]) => e > s);
      budgets.push(chunkBudget('obsp/connectivities/indices', graphNode.indices.chunks[0], graphRanges));
      budgets.push(chunkBudget('obsp/connectivities/data', graphNode.data.chunks[0], graphRanges));
      const layer = tree.children.layers.children.counts;
      if (layerLayout === 'dense') budgets.push(chunkBudget('layers/counts', layer.chunks[0], ranges));
      if (layerLayout === 'csr') {
        const pointers = Array.from(layer.children.indptr.values, Number);
        const entryRanges = kept.map(p => [pointers[p], pointers[p + 1]]).filter(([s, e]) => e > s);
        budgets.push(chunkBudget('layers/counts/indices', layer.children.indices.chunks[0], entryRanges));
        budgets.push(chunkBudget('layers/counts/data', layer.children.data.chunks[0], entryRanges));
      }
      if (xLayout === 'dense') budgets.push(chunkBudget('X', tree.children.X.chunks[0], ranges));
      if (xLayout === 'csr') {
        const X = tree.children.X.children;
        const pointers = Array.from(X.indptr.values, Number);
        const entryRanges = kept.map(p => [pointers[p], pointers[p + 1]]).filter(([s, e]) => e > s);
        budgets.push(chunkBudget('X/indices', X.indices.chunks[0], entryRanges));
        budgets.push(chunkBudget('X/data', X.data.chunks[0], entryRanges));
      }
      for (const { path, keys } of budgets) {
        for (const key of fetched) {
          if (key.slice(0, key.lastIndexOf('/')) !== path) continue;
          const chunk = Number(key.slice(key.lastIndexOf('/') + 1).split('.')[0]);
          assert.ok(keys.has(chunk), `${label}: ${key} holds no kept row`);
        }
      }
      reader.close();
    }
    full.reader.close();
  }
});

test('a subsample of every cell, or more, opens every cell', async () => {
  const { tree, nObs } = randomTree(7);
  const { reader } = await openTree(tree, { mode: 'subsample', method: 'uniform', k: nObs, seed: 3 });
  assert.equal(reader.nObs, nObs);
  assert.equal(reader.cellSubset.kept, null);
  reader.close();
});

test('a restored subsample opens exactly the recorded cells and says whether its specification gives them again', async () => {
  const { tree, nObs } = randomTree(11);
  const first = await openTree(tree, { mode: 'subsample', method: 'uniform', k: Math.ceil(nObs / 3), seed: 9 });
  const { spec, kept } = first.reader.cellSubset;
  const again = await openTree(tree, { mode: 'kept', spec, kept });
  assert.deepEqual(again.reader.cellSubset.kept, kept);
  assert.equal(again.reader.cellSubset.reproduced, true);
  const other = Uint32Array.from(kept);
  other[0] = other[0] === 0 ? 0 : other[0] - 1;
  if (other[0] !== kept[0] && (other.length < 2 || other[0] < other[1])) {
    const drifted = await openTree(tree, { mode: 'kept', spec, kept: other });
    assert.deepEqual(drifted.reader.cellSubset.kept, other);
    assert.equal(drifted.reader.cellSubset.reproduced, false);
  }
  await assert.rejects(openTree(tree, { mode: 'kept', spec: { ...spec, nObs: nObs + 1 }, kept }), /not the dataset the session was saved on/);
});

test('the whole sparse matrix read through a subsample is the kept rows of the stored one', async () => {
  const { tree, nObs, nVars } = randomTree(21);
  tree.children.X = matrixNode(createMulberry32(5), randomMatrix(createMulberry32(6), nObs, nVars), nObs, nVars, 'csr');
  const full = await openTree(tree, null);
  const subset = await openTree(tree, { mode: 'subsample', method: 'blocks', k: Math.ceil(nObs / 2), seed: 1, blockSize: 3 });
  const kept = Array.from(subset.reader.cellSubset.openOrder);
  const whole = await readSparseMatrix(full.root.get('X'), ZARR_FORMAT, 'X', 'exact');
  // A CSR matrix of a subsample is read once its kept rows' pointers are (and only theirs).
  await subset.reader._root.readRowPointers('X');
  const part = await readSparseMatrix(subset.reader._root.get('X'), ZARR_FORMAT, 'X', 'exact');
  assert.equal(part.indptr.length, kept.length + 1);
  kept.forEach((p, i) => {
    assert.deepEqual(
      Array.from(part.indices.subarray(part.indptr[i], part.indptr[i + 1])),
      Array.from(whole.indices.subarray(whole.indptr[p], whole.indptr[p + 1]))
    );
  });
});

/** A MuData store: `rna` measures every cell (CSR), `prot` some, in an order of its own (dense or CSC). */
function randomMuData(seed) {
  const random = createMulberry32(seed);
  const nObs = draw(random, 3, 90);
  const names = Array.from({ length: nObs }, (_, i) => `cell-${i}`);
  const measured = names.map((_, i) => i).filter(() => random() < 0.7);
  if (measured.length === 0) measured.push(0);
  // The modality stores its cells shuffled.
  const order = [...measured].sort(() => random() - 0.5);
  const protRow = new Map(order.map((cell, row) => [cell, row]));
  const rnaVars = draw(random, 1, 6);
  const protVars = draw(random, 1, 4);
  const protLayout = random() < 0.5 ? 'dense' : 'csc';
  const modality = (cellNames, X, nVars, extraObs = {}) => annData({
    obs: dataFrame({ _index: strings(cellNames), ...extraObs }),
    var: dataFrame({ _index: strings(Array.from({ length: nVars }, (_, g) => `${cellNames.length}-g${g}`)) }),
    X,
  });
  const tree = {
    kind: 'group',
    attrs: { 'encoding-type': 'MuData', 'encoding-version': '0.1.0', axis: 0 },
    children: {
      obs: dataFrame({ _index: strings(names, { chunks: [draw(random, 1, nObs)] }) }),
      obsm: mapping({ X_umap: dense(Float32Array.from({ length: nObs * 2 }, () => random()), [nObs, 2], { chunks: [draw(random, 1, nObs), 2] }) }),
      mod: group({
        rna: modality(names, matrixNode(random, randomMatrix(random, nObs, rnaVars), nObs, rnaVars, 'csr'), rnaVars),
        prot: modality(order.map(cell => names[cell]), matrixNode(random, randomMatrix(random, order.length, protVars), order.length, protVars, protLayout), protVars, {
          level: array(Float32Array.from({ length: order.length }, () => random()), { chunks: [draw(random, 1, order.length)] }),
        }),
      }, { 'mod-order': ['rna', 'prot'] }),
      obsmap: group({
        rna: array(Uint32Array.from(names, (_, i) => i + 1), { dtype: '<u4' }),
        prot: array(Uint32Array.from(names, (_, i) => (protRow.has(i) ? protRow.get(i) + 1 : 0)), { dtype: '<u4' }),
      }),
    },
  };
  return { tree, nObs, rnaVars, protVars, random, protLayout };
}

test('a MuData subsample reads each modality through the kept cells, measured or not', async () => {
  const { muDataView, MUDATA_ZARR_FORMAT } = await import('../assets/js/data/anndata/views/mudata.js');
  const openMu = async (tree, cellSubset) => {
    const { store } = countingStore(tree);
    const root = muDataView(await openZarr(store, { decodedChunkCacheBytes: 0 }), { name: 'case.zarr' });
    const reader = new AnnDataReader();
    await reader.open(root, { format: MUDATA_ZARR_FORMAT, name: 'case.zarr', decodedChunkBytes: 0, cellSubset });
    return reader;
  };
  for (let c = 0; c < Math.max(6, Math.floor(CASES / 2)); c++) {
    const { tree, nObs, rnaVars, protVars, random, protLayout } = randomMuData(0x30d0 + c);
    const full = await openMu(tree, null);
    for (const method of ['uniform', 'blocks']) {
      const k = draw(random, 1, nObs - 1);
      const reader = await openMu(tree, { mode: 'subsample', method, k, seed: draw(random, 0, 1000) });
      const kept = Array.from(reader.cellSubset.openOrder);
      const label = `MuData case ${c} (prot ${protLayout}) ${method} k=${k}`;
      for (const [element, nVars] of [['mod/rna/X', rnaVars], ['mod/prot/X', protVars]]) {
        const genes = Array.from({ length: nVars }, (_, g) => g);
        const want = await full.getMatrixColumns(element, genes);
        const got = await reader.getMatrixColumns(element, genes);
        got.forEach((column, g) => sameBits(column, gather(want[g], kept), `${label}: ${element} gene ${g}`));
        const wantSparse = await full.getMatrixColumnsSparse(element, genes);
        const gotSparse = await reader.getMatrixColumnsSparse(element, genes);
        gotSparse.forEach((column, g) => {
          const dense = new Float32Array(column.length);
          column.indices.forEach((cell, e) => { dense[cell] = column.values[e]; });
          const wantDense = new Float32Array(nObs);
          wantSparse[g].indices.forEach((cell, e) => { wantDense[cell] = wantSparse[g].values[e]; });
          sameBits(dense, gather(wantDense, kept), `${label}: ${element} sparse gene ${g}`);
        });
      }
      for (const key of full.obsKeys) {
        const want = await full.getObsField(key);
        const got = await reader.getObsField(key);
        if (ArrayBuffer.isView(want.values)) sameBits(got.values, gather(want.values, kept), `${label}: obs ${key}`);
        else assert.deepEqual(got.values, kept.map(p => want.values[p]), `${label}: obs ${key}`);
      }
      reader.close();
    }
    full.close();
  }
});

/**
 * Every HDF5 layout (`scripts/generate-subsample-hdf5-fixtures.py`): X as
 * CSR, CSC or dense; every array gzip-chunked, unfiltered-chunked (read a
 * chunk's rows alone) or contiguous (read byte by byte); version 1 B-tree or
 * latest chunk indexes. Each read through a subsample equals the full read
 * then a gather.
 */
test('every HDF5 layout reads a subsample as the full read then a gather', async () => {
  const { readdir, readFile: read } = await import('node:fs/promises');
  const { openHdf5 } = await import('../assets/js/formats/hdf5/index.js');
  const { createByteReader } = await import('../assets/js/formats/io/byte-reader.js');
  const { bytesByteSource } = await import('../assets/js/formats/io/byte-source.js');
  const { H5AD_FORMAT } = await import('../assets/js/data/anndata/elements.js');
  const folder = new URL('./fixtures/subsample/', import.meta.url);
  const files = (await readdir(folder)).filter(name => name.endsWith('.h5ad')).sort();
  assert.equal(files.length, 18);
  const random = createMulberry32(0xb5);
  for (const name of files) {
    const bytes = new Uint8Array(await read(new URL(name, folder)));
    const openFile = async cellSubset => {
      const root = await openHdf5(createByteReader(bytesByteSource(bytes, { name })), { decodedChunkCacheBytes: 0 });
      const reader = new AnnDataReader();
      await reader.open(root, { format: H5AD_FORMAT, name, decodedChunkBytes: 0, cellSubset });
      return reader;
    };
    const full = await openFile(null);
    const genes = Array.from({ length: full.nVars }, (_, g) => g);
    const fullX = await full.getMatrixColumns('X', genes);
    const fullLayer = await full.getMatrixColumns('layers/counts', genes);
    const fullObs = await full.getObsField('cluster');
    const fullScore = await full.getObsField('score');
    const fullUmap = await full.readObsmColumns('X_umap', [0, 1]);
    const fullGraph = await full.getConnectivities('connectivities');
    for (const method of METHODS) {
      const request = { mode: 'subsample', method, k: draw(random, 1, 299), seed: draw(random, 0, 0xffffffff) };
      if (method === 'stratified') request.field = 'cluster';
      if (method === 'blocks') request.blockSize = draw(random, 1, 40);
      const label = `${name} ${method} k=${request.k}`;
      const reader = await openFile(request);
      const kept = Array.from(reader.cellSubset.openOrder);
      const positionOf = new Map(kept.map((p, i) => [p, i]));
      (await reader.getMatrixColumns('X', genes)).forEach((column, g) => sameBits(column, gather(fullX[g], kept), `${label}: X gene ${g}`));
      (await reader.getMatrixColumns('layers/counts', genes)).forEach((column, g) => sameBits(column, gather(fullLayer[g], kept), `${label}: layer gene ${g}`));
      sameBits((await reader.getObsField('cluster')).codes, gather(fullObs.codes, kept), `${label}: codes`);
      sameBits((await reader.getObsField('score')).values, gather(fullScore.values, kept), `${label}: score`);
      sameBits(await reader.readObsmColumns('X_umap', [0, 1]), gather(fullUmap, kept, 2), `${label}: umap`);
      const graph = await reader.getConnectivities('connectivities');
      const wantIndices = [];
      const wantPointers = [0];
      for (const p of kept) {
        for (let e = fullGraph.indptr[p]; e < fullGraph.indptr[p + 1]; e++) {
          const q = positionOf.get(fullGraph.indices[e]);
          if (q !== undefined) wantIndices.push(q);
        }
        wantPointers.push(wantIndices.length);
      }
      assert.deepEqual(Array.from(graph.indptr), wantPointers, `${label}: graph pointers`);
      assert.deepEqual(Array.from(graph.indices), wantIndices, `${label}: graph indices`);
      reader.close();
    }
    full.close();
  }
});

/**
 * Priority-ordered files (`priority-layout.js`): rows in rank order under
 * the file's seed, each row's original position in obs. A uniform subsample
 * under that seed is read as the prefix of every array — bit for bit the
 * cells the same request keeps from the file in its original order, named
 * by the same original positions, fetching only the chunks of the prefix —
 * and any other request takes the general path through the permutation.
 */
test('a priority-ordered file reads its prefix, and other requests through its order', async () => {
  const { rankOf } = await import('../assets/js/data/subsample.js');
  const { createCellIdentity, cellSetDigest } = await import('../assets/js/data/cell-identity.js');
  for (let c = 0; c < Math.max(4, Math.floor(CASES / 4)); c++) {
    const random = createMulberry32(0x9e1 + c);
    const n = draw(random, 20, 200);
    const nVars = draw(random, 1, 6);
    const seed = draw(random, 0, 0xffffffff);
    const layout = random() < 0.5 ? 'csr' : 'csc';
    const values = Array.from({ length: n }, () => Float32Array.from({ length: nVars }, () => (random() < 0.4 ? Math.fround(1 + random() * 5) : 0)));
    const score = Float32Array.from({ length: n }, () => random());
    const codes = Int8Array.from({ length: n }, () => draw(random, 0, 3));
    const umap = Float32Array.from({ length: n * 2 }, () => random());
    const byRank = Array.from({ length: n }, (_, i) => i).sort((a, b) => rankOf(seed, a) - rankOf(seed, b));
    // The writers' levels: the record is verified against them.
    const { prefixLevels } = await import('../assets/js/data/anndata/priority-layout.js');
    const levels = prefixLevels(n);
    const build = (order, priority) => {
      const rows = order.map(p => values[p]);
      const chunk = [draw(random, 1, n)];
      const obs = {
        _index: strings(order.map(p => `cell-${p}`), { chunks: chunk }),
        score: array(Float32Array.from(order, p => score[p]), { chunks: [draw(random, 1, n)] }),
        cluster: categorical(Int8Array.from(order, p => codes[p]), ['a', 'b', 'c', 'd']),
      };
      if (priority) obs.cellucid_original_position = array(Uint32Array.from(order), { dtype: '<u4', chunks: [draw(random, 1, n)] });
      const children = {
        obs: dataFrame(obs),
        var: dataFrame({ _index: strings(Array.from({ length: nVars }, (_, g) => `g${g}`)) }),
        obsm: mapping({ X_umap: dense(Float32Array.from(order.flatMap(p => [umap[2 * p], umap[2 * p + 1]])), [n, 2], { chunks: [draw(random, 1, n), 2] }) }),
        X: matrixNode(random, rows.map(row => new Map(Array.from(row, (v, g) => [g, v]).filter(([, v]) => v !== 0))), n, nVars, layout),
      };
      if (priority) {
        children.uns = mapping({ cellucid: mapping({ priority: mapping({
          seed: array([seed], { dtype: '<u8', shape: [], chunks: [] }),
          specVersion: array([1], { dtype: '<i8', shape: [], chunks: [] }),
          nObs: array([n], { dtype: '<i8', shape: [], chunks: [] }),
          levels: array(levels, { dtype: '<i8' }),
        }) }) });
        const counts = [];
        for (let g = 0; g < nVars; g++) {
          for (const level of levels) {
            let count = 0;
            for (let r = 0; r < level; r++) if (rows[r][g] !== 0) count++;
            counts.push(count);
          }
        }
        children.varm = mapping({ cellucid_prefix_counts: dense(Int32Array.from(counts), [nVars, levels.length], { dtype: '<i4', chunks: [1, levels.length] }) });
      }
      return annData(children);
    };
    const plain = build(Array.from({ length: n }, (_, i) => i), false);
    const ordered = build(byRank, true);
    for (const request of [
      { mode: 'subsample', method: 'uniform', k: draw(random, 1, n - 1) },
      { mode: 'subsample', method: 'uniform', k: draw(random, 1, n - 1), seed: (seed ^ 1) >>> 0 },
      { mode: 'subsample', method: 'stratified', k: draw(random, 4, n - 1), field: 'cluster' },
      // No method named: the file's default, uniform under its seed (a prefix).
      { mode: 'subsample', k: draw(random, 1, n - 1) },
      // Blocks named on a priority file: honoured, through the general path.
      { mode: 'subsample', method: 'blocks', k: draw(random, 1, n - 1), blockSize: draw(random, 1, 9) },
    ]) {
      const label = `priority case ${c} (${layout}) ${request.method} k=${request.k}${request.seed === undefined ? ' file seed' : ''}`;
      const reference = await openTree(plain, { ...request, method: request.method ?? 'uniform', seed: request.seed ?? seed });
      const subject = await openTree(ordered, request);
      const info = subject.reader.cellSubset;
      assert.equal(info.spec.seed, request.seed ?? seed, `${label}: the file's seed is the default`);
      assert.deepEqual(info.kept, reference.reader.cellSubset.kept, `${label}: the same cells`);
      const isPrefix = (request.method ?? 'uniform') === 'uniform' && request.seed === undefined;
      assert.equal(info.spec.method, request.method ?? 'uniform', `${label}: the file's default method`);
      assert.equal(info.prefix, isPrefix ? request.k : null, `${label}: prefix`);
      // The original positions name the cells; they are not a field.
      assert.deepEqual(subject.reader.obsKeys, reference.reader.obsKeys, `${label}: obs fields`);
      const identity = createCellIdentity({ nObs: n, kept: info.kept, openOrder: info.openOrder });
      assert.equal(identity.digest, cellSetDigest(n, reference.reader.cellSubset.kept));
      // Open cell i of the ordered file is original position openOrder[i]:
      // its values are the reference's at that cell.
      const referencePosition = new Map(Array.from(reference.reader.cellSubset.openOrder, (p, i) => [p, i]));
      const map = Array.from(identity.toOriginal(Uint32Array.from({ length: identity.n }, (_, i) => i)), p => referencePosition.get(p));
      sameBits((await subject.reader.getObsField('score')).values, gather((await reference.reader.getObsField('score')).values, map), `${label}: score`);
      sameBits(await subject.reader.readObsmColumns('X_umap', [0, 1]), gather(await reference.reader.readObsmColumns('X_umap', [0, 1]), map, 2), `${label}: umap`);
      const genes = Array.from({ length: nVars }, (_, g) => g);
      const got = await subject.reader.getMatrixColumns('X', genes);
      const want = await reference.reader.getMatrixColumns('X', genes);
      got.forEach((column, g) => sameBits(column, gather(want[g], map), `${label}: X gene ${g}`));
      if (isPrefix) {
        // Only the prefix's chunks: score's and, for CSR, X's entries [0, indptr[k]).
        const k = request.k;
        const budgets = [chunkBudget('obs/score', ordered.children.obs.children.score.chunks[0], [[0, k]])];
        if (layout === 'csr') {
          const X = ordered.children.X.children;
          const end = Number(X.indptr.values[k]);
          if (end > 0) budgets.push(chunkBudget('X/indices', X.indices.chunks[0], [[0, end]]), chunkBudget('X/data', X.data.chunks[0], [[0, end]]));
        }
        for (const { path, keys } of budgets) {
          for (const key of subject.fetched) {
            if (key.slice(0, key.lastIndexOf('/')) !== path) continue;
            assert.ok(keys.has(Number(key.slice(key.lastIndexOf('/') + 1))), `${label}: ${key} is outside the prefix`);
          }
        }
      }
      reference.reader.close();
      subject.reader.close();
    }
  }
});

test('a subsample lists its neighbour graphs as graphs on the open cells, usable in data mapping', async () => {
  // Session › Data mapping and the dataset's default graph both describe a
  // graph from its probe: one stored on every cell is read as its induced
  // subgraph on the open cells, so it must be listed at the open count, not
  // refused as "has n rows, the dataset has k cells".
  const { tree, nObs } = randomTree(5);
  const k = Math.ceil(nObs / 4);
  const { reader } = await openTree(tree, { mode: 'subsample', method: 'uniform', k, seed: 2 });
  const probes = await reader.probeMapping();
  assert.equal(probes.nObs, k);
  const graph = probes.obsp.find(probe => probe.key === 'connectivities');
  assert.deepEqual(graph.shape, [k, k]);
  assert.equal(graph.nnz, null, "the induced subgraph's entries are known once it is read");
  const [described] = describeAnnDataProbes(probes).obsp;
  assert.equal(described.usable, true, described.reason ?? '');
  assert.deepEqual((await reader.getConnectivities('connectivities')).shape, [k, k]);
  reader.close();

  const whole = await openTree(tree, null);
  const stored = (await whole.reader.probeMapping()).obsp.find(probe => probe.key === 'connectivities');
  assert.deepEqual(stored.shape, [nObs, nObs]);
  assert.equal(Number.isSafeInteger(stored.nnz), true);
  whole.reader.close();
});
