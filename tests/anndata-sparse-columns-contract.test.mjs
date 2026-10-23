/**
 * Gene columns as non-zero entries, cell subsets by either route, and the
 * column pointers of a CSC matrix read as the dataset opens.
 *
 * A sparse column (`getMatrixColumnsSparse`) must be the dense column read as
 * entries, bit for bit (`geneSampleOf`, what the analysis kernels compute
 * from), for every layout: CSR through the gene index, CSC with unsorted
 * rows and duplicate coordinates, dense by strip and dense through the index.
 * A cell subset must give the same block by rows and by columns.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { geneSampleOf } from '../assets/js/app/analysis/compute/gene-statistics.js';
import { readCellSubset, openMatrixColumns, openMatrixRows } from '../assets/js/data/anndata/matrix-access.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { createColumnStoreFactory, sparseColumnOf, sparseColumnOfDense } from '../assets/js/data/sparse-column-index.js';
import { ownedBuffers } from '../assets/js/data/anndata-reader-worker.js';
import { dense, mapping, minimalAnnData, openReader, openStore, sparse } from './helpers/anndata-store.mjs';
import { configureDecodePool } from '../assets/js/formats/io/decode-pool.js';
import { createNodeDecodeWorker } from './helpers/node-decode-worker.mjs';

function treeWithX(X, nObs, nVars) {
  return minimalAnnData({ nObs, genes: Array.from({ length: nVars }, (_, i) => `gene-${i}`), X });
}

/** A seeded pseudo-random matrix, mostly zeros, with exact float32 values. */
function randomCsr(nObs, nVars, seed, { duplicates = false, zeros = false } = {}) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const indptr = [0];
  const indices = [];
  const data = [];
  for (let row = 0; row < nObs; row++) {
    for (let gene = 0; gene < nVars; gene++) {
      if (next() < 0.15) {
        indices.push(gene);
        data.push(zeros && next() < 0.1 ? 0 : Math.fround(1 + Math.floor(next() * 7) * 0.5));
        if (duplicates && next() < 0.1) {
          indices.push(gene);
          data.push(Math.fround(0.25));
        }
      }
    }
    indptr.push(indices.length);
  }
  return { indptr: Int32Array.from(indptr), indices: Int32Array.from(indices), data: Float32Array.from(data) };
}

function sameSample(actual, dense, label) {
  const expected = geneSampleOf(dense, 0);
  assert.equal(actual.length, dense.length, `${label}: length`);
  assert.ok(actual.indices instanceof Uint32Array && actual.values instanceof Float32Array, `${label}: types`);
  assert.deepEqual(Array.from(actual.indices), Array.from(expected.indices), `${label}: indices`);
  assert.deepEqual(Array.from(actual.values), Array.from(expected.values), `${label}: values`);
  for (const array of [actual.indices, actual.values]) {
    assert.equal(array.byteOffset, 0, `${label}: owns its buffer`);
    assert.equal(array.byteLength, array.buffer.byteLength, `${label}: owns its whole buffer`);
  }
}

test('sparse gene columns equal the dense columns read as entries, every layout', async () => {
  const nObs = 37;
  const nVars = 11;
  const csr = randomCsr(nObs, nVars, 7, { duplicates: true, zeros: true });
  // The same matrix by gene, rows unsorted within a column (scipy allows it).
  const byGene = Array.from({ length: nVars }, () => []);
  for (let row = 0; row < nObs; row++) {
    for (let entry = csr.indptr[row]; entry < csr.indptr[row + 1]; entry++) {
      byGene[csr.indices[entry]].push([row, csr.data[entry]]);
    }
  }
  const cscIndptr = [0];
  const cscIndices = [];
  const cscData = [];
  byGene.forEach((entries, gene) => {
    const ordered = gene % 2 === 0 ? entries : [...entries].reverse();
    for (const [row, value] of ordered) {
      cscIndices.push(row);
      cscData.push(value);
    }
    cscIndptr.push(cscIndices.length);
  });
  const denseValues = new Float32Array(nObs * nVars);
  for (let row = 0; row < nObs; row++) {
    for (let entry = csr.indptr[row]; entry < csr.indptr[row + 1]; entry++) {
      const at = row * nVars + csr.indices[entry];
      denseValues[at] = Math.fround(denseValues[at] + csr.data[entry]);
    }
  }
  const layouts = {
    csr: sparse({ ...csr, shape: [nObs, nVars], chunks: 16 }),
    csc: sparse({
      format: 'csc',
      indptr: Int32Array.from(cscIndptr),
      indices: Int32Array.from(cscIndices),
      data: Float32Array.from(cscData),
      shape: [nObs, nVars],
      chunks: 16,
    }),
    'dense strips': dense(denseValues, [nObs, nVars], { chunks: [8, 2] }),
    'dense whole': dense(denseValues, [nObs, nVars]),
  };
  const genes = Array.from({ length: nVars }, (_, gene) => gene);
  for (const [name, X] of Object.entries(layouts)) {
    const { reader } = await openReader(treeWithX(X, nObs, nVars), { decodedChunkCacheBytes: name === 'dense whole' ? 0 : 64 * 1024 * 1024 });
    const columns = await reader.getMatrixColumns('X', genes);
    const sparseColumns = await reader.getMatrixColumnsSparse('X', genes);
    genes.forEach(gene => sameSample(sparseColumns[gene], columns[gene], `${name} gene ${gene}`));
    // Asked one at a time, as a view or a long run asks.
    sameSample((await reader.getMatrixColumnsSparse('X', [3]))[0], columns[3], `${name} gene 3 alone`);
  }
});

test('a sparse column sums duplicates in stored order and leaves zeros out', () => {
  const column = sparseColumnOf([1, 1, 4, 6, 6], [0.1, 0.2, 0, 2, -2], 5, 9);
  assert.deepEqual(Array.from(column.indices), [1]);
  assert.deepEqual(Array.from(column.values), [Math.fround(Math.fround(0.1) + 0.2)]);
  assert.equal(column.length, 9);
  const fromDense = sparseColumnOfDense(Float32Array.of(0, -0, 3, NaN, 0));
  assert.deepEqual(Array.from(fromDense.indices), [2, 3]);
  assert.ok(Number.isNaN(fromDense.values[1]), 'a NaN is a value, kept');
});

test('a cell subset is the same block by rows and by columns, cells in any order', async () => {
  const nObs = 53;
  const nVars = 9;
  const csr = randomCsr(nObs, nVars, 3, { duplicates: true });
  const tree = treeWithX(sparse({ ...csr, shape: [nObs, nVars], chunks: 8 }), nObs, nVars);
  const { root } = await openStore(tree);
  const context = {
    format: ZARR_FORMAT,
    label: 'X',
    nObs,
    nVars,
    decodedChunkBytes: 64 * 1024 * 1024,
    indexOptions: { storeFactory: createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }) },
  };
  const node = root.get('X');
  const columns = await openMatrixColumns(node, context);
  const rows = await openMatrixRows(node, { ...context, inFlightEntries: 16 });
  const cells = [40, 2, 17, 3, 52, 9];
  const genes = [8, 0, 4, 5];
  const options = { nObs, label: 'X', inFlightEntries: 16, readOptions: {} };
  const byRows = await rows.subset(cells, genes, {});
  const viaColumns = await readCellSubset(columns, null, cells, genes, options);
  assert.equal(viaColumns.route, 'columns');
  assert.deepEqual(Array.from(byRows.pointers), Array.from(viaColumns.block.pointers));
  assert.deepEqual(Array.from(byRows.cellIndex), Array.from(viaColumns.block.cellIndex));
  assert.deepEqual(Array.from(byRows.values), Array.from(viaColumns.block.values));
  // Each gene's entries ascend by position in the cells asked for, and equal
  // the dense columns.
  const dense = await Promise.all(genes.map(gene => columns.column(gene)));
  genes.forEach((gene, g) => {
    const actual = new Array(cells.length).fill(0);
    let previous = -1;
    for (let entry = byRows.pointers[g]; entry < byRows.pointers[g + 1]; entry++) {
      assert.ok(byRows.cellIndex[entry] > previous, 'ascending positions');
      previous = byRows.cellIndex[entry];
      actual[byRows.cellIndex[entry]] = byRows.values[entry];
    }
    assert.deepEqual(actual, cells.map(cell => dense[g][cell]), `gene ${gene}`);
  });
  // The cheaper route is taken: once the index is built, many cells by gene.
  const all = Array.from({ length: nObs }, (_, cell) => cell);
  assert.ok(rows.readCost(all) > columns.readCost(genes));
  assert.equal((await readCellSubset(columns, rows, all, genes, options)).route, 'columns');
});

test('a cell subset of a CSC matrix reads runs of genes as one range and equals the dense columns', async () => {
  const nObs = 41;
  const nVars = 13;
  const csr = randomCsr(nObs, nVars, 11, { duplicates: true, zeros: true });
  // By gene, every third gene's rows reversed (unsorted, as scipy allows).
  const byGene = Array.from({ length: nVars }, () => []);
  for (let row = 0; row < nObs; row++) {
    for (let entry = csr.indptr[row]; entry < csr.indptr[row + 1]; entry++) {
      byGene[csr.indices[entry]].push([row, csr.data[entry]]);
    }
  }
  const indptr = [0];
  const indices = [];
  const data = [];
  byGene.forEach((entries, gene) => {
    for (const [row, value] of gene % 3 === 0 ? [...entries].reverse() : entries) {
      indices.push(row);
      data.push(value);
    }
    indptr.push(indices.length);
  });
  const X = sparse({
    format: 'csc',
    indptr: Int32Array.from(indptr),
    indices: Int32Array.from(indices),
    data: Float32Array.from(data),
    shape: [nObs, nVars],
    chunks: 16,
  });
  const { reader, reads } = await openReader(treeWithX(X, nObs, nVars));
  const genes = Array.from({ length: nVars }, (_, gene) => gene);
  const columns = await reader.getMatrixColumns('X', genes);
  const selections = [
    [Array.from({ length: nObs }, (_, cell) => cell), genes],
    [[40, 2, 17, 3, 39, 9, 0, 22], [12, 0, 7, 5, 6, 1]],
    [[5], [3, 4]],
  ];
  for (const [cells, asked] of selections) {
    reads.length = 0;
    const block = await reader.getMatrixCellSubset('X', cells, asked);
    asked.forEach((gene, g) => {
      const actual = new Array(cells.length).fill(0);
      let previous = -1;
      for (let entry = block.pointers[g]; entry < block.pointers[g + 1]; entry++) {
        assert.ok(block.cellIndex[entry] > previous, `gene ${gene}: ascending positions`);
        previous = block.cellIndex[entry];
        assert.notEqual(block.values[entry], 0, `gene ${gene}: no stored zero`);
        actual[block.cellIndex[entry]] = block.values[entry];
      }
      assert.deepEqual(actual, cells.map(cell => columns[gene][cell]), `gene ${gene} in ${cells.length} cells`);
    });
    if (asked === genes) {
      // Every gene, stored one after another: one range of each array.
      assert.deepEqual(reads.filter(read => read.path === '/X/data').map(read => read.selection[0]), [[0, indices.length]]);
    }
  }
});

test('a cell subset kept on decode workers is byte for byte the one kept on the reader thread', async t => {
  // A CSC matrix of many runs: every fourth gene's rows reversed (refused by
  // the kernel, read through its checks), duplicates and stored zeros.
  const nObs = 97;
  const nVars = 40;
  const csr = randomCsr(nObs, nVars, 29, { duplicates: true, zeros: true });
  const byGene = Array.from({ length: nVars }, () => []);
  for (let row = 0; row < nObs; row++) {
    for (let entry = csr.indptr[row]; entry < csr.indptr[row + 1]; entry++) byGene[csr.indices[entry]].push([row, csr.data[entry]]);
  }
  const indptr = [0];
  const indices = [];
  const data = [];
  byGene.forEach((entries, gene) => {
    for (const [row, value] of gene % 4 === 0 ? [...entries].reverse() : entries) {
      indices.push(row);
      data.push(value);
    }
    indptr.push(indices.length);
  });
  const tree = treeWithX(sparse({
    format: 'csc', indptr: Int32Array.from(indptr), indices: Int32Array.from(indices), data: Float32Array.from(data),
    shape: [nObs, nVars], chunks: 32,
  }), nObs, nVars);
  const { root } = await openStore(tree);
  const context = { format: ZARR_FORMAT, label: 'X', nObs, nVars, decodedChunkBytes: 64 * 1024 * 1024 };
  const columns = await openMatrixColumns(root.get('X'), context);
  const genes = Array.from({ length: nVars }, (_, gene) => gene).reverse();
  const selections = [
    Array.from({ length: nObs }, (_, cell) => cell).filter(cell => cell % 3 !== 1),
    [90, 4, 33, 61, 0, 12, 7, 80],
  ];
  // Runs of about 60 entries, so the genes go out in many runs.
  const read = cells => readCellSubset(columns, null, cells, genes, { nObs, label: 'X', inFlightEntries: 240, readOptions: {} });
  t.after(() => configureDecodePool());
  for (const cells of selections) {
    configureDecodePool({ createWorker: null });
    const here = (await read(cells)).block;
    let tasks = 0;
    configureDecodePool({
      createWorker: () => {
        const worker = createNodeDecodeWorker();
        const post = worker.postMessage;
        worker.postMessage = (message, transfer) => {
          if (message.kind === 'run') tasks++;
          post(message, transfer);
        };
        return worker;
      },
      size: 2,
      minBytes: 0,
    });
    const onWorkers = (await read(cells)).block;
    assert.ok(tasks > 1, 'runs were kept on the workers');
    for (const key of ['pointers', 'cellIndex', 'values']) {
      assert.equal(onWorkers[key].constructor, here[key].constructor, key);
      assert.deepEqual(new Uint8Array(onWorkers[key].buffer, onWorkers[key].byteOffset, onWorkers[key].byteLength),
        new Uint8Array(here[key].buffer, here[key].byteOffset, here[key].byteLength), `${key}, ${cells.length} cells`);
    }
  }
});

test('a CSC matrix reads its column pointers as the dataset opens: the first gene is one round trip', async () => {
  const X = sparse({
    format: 'csc',
    data: Float32Array.of(1, 2, 3),
    indices: Int32Array.of(0, 1, 1),
    indptr: Int32Array.of(0, 1, 3),
    shape: [2, 2],
  });
  const { reader, reads } = await openReader(treeWithX(X, 2, 2));
  const pointerReads = reads.filter(read => read.path === '/X/indptr');
  assert.equal(pointerReads.length, 1, 'read while opening');
  reads.length = 0;
  assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 1)), [0, 5]);
  assert.deepEqual(reads.map(read => read.path).sort(), ['/X/data', '/X/indices']);
});

test('every typed array of a worker reply owns its whole buffer, so it is transferred', () => {
  const parent = new ArrayBuffer(64);
  const view = new Float32Array(parent, 8, 4);
  view.set([1, 2, 3, 4]);
  const whole = new Uint32Array(3);
  let computed = 0;
  const record = {
    indices: whole,
    values: view,
    get lazy() {
      computed++;
      return 1;
    },
  };
  const [owned] = ownedBuffers([record]);
  assert.notEqual(owned, record, 'a record holding a view is copied');
  assert.equal(owned.indices, whole, 'a whole-buffer array is kept as it is');
  assert.notEqual(owned.values, view);
  assert.deepEqual(Array.from(owned.values), [1, 2, 3, 4]);
  assert.equal(owned.values.byteLength, owned.values.buffer.byteLength);
  assert.equal(computed, 0, 'a lazy getter is never run');
  const untouched = { a: whole };
  assert.equal(ownedBuffers(untouched), untouched, 'nothing to copy: the same object');
});

test('switching expression matrices keeps each built gene index: switching back reads nothing', async () => {
  const nObs = 29;
  const nVars = 6;
  const x = randomCsr(nObs, nVars, 11);
  const counts = randomCsr(nObs, nVars, 12);
  const tree = minimalAnnData({
    nObs,
    genes: Array.from({ length: nVars }, (_, i) => `gene-${i}`),
    X: sparse({ ...x, shape: [nObs, nVars], chunks: 8 }),
    extra: { layers: mapping({ counts: sparse({ ...counts, shape: [nObs, nVars], chunks: 8 }) }) },
  });
  const { reader, fetched } = await openReader(tree);
  const genes = Array.from({ length: nVars }, (_, gene) => gene);
  const firstX = await reader.getMatrixColumns('X', genes);
  // Every gene of X answered: let the index finish building.
  while (reader._matrices.get('X')?.columns?.built?.() !== true) await new Promise(resolve => setImmediate(resolve));
  const layer = await reader.getMatrixColumns('layers/counts', genes);
  assert.equal(layer.length, nVars);
  while (reader._matrices.get('layers/counts')?.columns?.built?.() !== true) await new Promise(resolve => setImmediate(resolve));
  fetched.length = 0;
  const againX = await reader.getMatrixColumns('X', genes);
  assert.deepEqual(fetched.filter(key => key.startsWith('X/')), [], 'X is answered from its kept index');
  againX.forEach((column, gene) => assert.deepEqual(Array.from(column), Array.from(firstX[gene])));
  assert.deepEqual([...reader._matrices.keys()], ['layers/counts', 'X'], 'both built indexes are kept; X is read now');
  // An index still being built when another matrix is read stops instead.
  const unbuilt = minimalAnnData({
    nObs,
    genes: Array.from({ length: nVars }, (_, i) => `gene-${i}`),
    X: sparse({ ...x, shape: [nObs, nVars], chunks: 8 }),
    extra: { layers: mapping({ counts: sparse({ ...counts, shape: [nObs, nVars], chunks: 8 }) }) },
  });
  const second = await openReader(unbuilt);
  await second.reader.getMatrixColumns('X', [0]);
  await second.reader.getMatrixColumns('layers/counts', [0]);
  assert.deepEqual([...second.reader._matrices.keys()], ['layers/counts']);
});
