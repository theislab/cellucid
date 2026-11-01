/**
 * How the genes of a dense matrix are read is weighed by cost
 * (`geneLayoutOf`), never by whether a strip fits the decoded-chunk cache:
 * a matrix chunked in gene strips (a Loom file's 64 × 64 chunks among them)
 * reads a gene's own strip even when one strip is larger than that cache,
 * unless the whole matrix's gene index fits the memory kept for gene
 * indexes; then one pass indexes every strip. Every consumer (the route,
 * the cost before the first gene, the notice, the subsample's sizing)
 * follows the same rule.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { geneLayoutOf, geneReadCost, openMatrixColumns, readsThroughRowIndex } from '../assets/js/data/anndata/matrix-access.js';
import { autoFitCount, geneIndexFit } from '../assets/js/data/anndata/subsample-plan.js';
import { transposedArray } from '../assets/js/data/anndata/views/view-nodes.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { createColumnStoreFactory } from '../assets/js/data/sparse-column-index.js';
import { geneLayoutReason } from '../assets/js/data/gene-read-plan.js';
import { dense, minimalAnnData, openStore } from './helpers/anndata-store.mjs';

const N_OBS = 400;
const N_VARS = 32;
const STRIP = 4;

function values() {
  return Float32Array.from({ length: N_OBS * N_VARS }, (_, i) => ((i * 7) % 13) * 0.5);
}

function columnOf(all, gene) {
  return Float32Array.from({ length: N_OBS }, (_, row) => all[row * N_VARS + gene]);
}

async function denseX({ chunks }) {
  const all = values();
  const tree = minimalAnnData({ nObs: N_OBS, genes: Array.from({ length: N_VARS }, (_, i) => `g${i}`), X: dense(all, [N_OBS, N_VARS], { chunks }) });
  const opened = await openStore(tree);
  return { ...opened, all, X: opened.root.get('X') };
}

const context = extra => ({
  format: ZARR_FORMAT,
  label: 'X',
  nObs: N_OBS,
  nVars: N_VARS,
  indexOptions: { storeFactory: createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }) },
  ...extra,
});

test('the layout rule: strips that fit the cache, strips whose index does not fit memory, wide strips indexed, rows', async () => {
  const { X } = await denseX({ chunks: [50, STRIP] });
  const stripBytes = N_OBS * STRIP * 4;
  const indexBytes = N_OBS * N_VARS * 4;
  const at = (decodedChunkBytes, columnIndexBytes) => geneLayoutOf(X, { nObs: N_OBS, nVars: N_VARS, decodedChunkBytes, columnIndexBytes });
  assert.equal(at(stripBytes, 0), 'dense-strips', 'a strip the cache holds');
  assert.equal(at(stripBytes - 1, indexBytes - 1), 'dense-strips', 'a strip larger than the cache, its index larger than memory');
  assert.equal(at(stripBytes - 1, indexBytes), 'dense-wide-strips', 'a strip larger than the cache, its index in memory');
  const { X: rows } = await denseX({ chunks: [50, N_VARS] });
  assert.equal(geneLayoutOf(rows, { nObs: N_OBS, nVars: N_VARS, decodedChunkBytes: N_OBS * N_VARS * 4 - 1, columnIndexBytes: 0 }), 'dense-rows',
    'chunks spanning every gene: every gene lies in every chunk');
  // Stored in one piece (an unchunked HDF5 dataset): no strip to read.
  assert.equal(geneLayoutOf({ ...X, chunks: null }, { nObs: N_OBS, nVars: N_VARS, decodedChunkBytes: 1 << 30, columnIndexBytes: 1 << 30 }), 'dense-rows');
  // The notice never calls strips rows.
  assert.equal(geneLayoutReason('dense-strips'), null);
  assert.match(geneLayoutReason('dense-wide-strips'), /strips of genes/);
});

test('a strip larger than the decoded-chunk cache is read alone when the index cannot be held: the gene reads only its strip', async () => {
  const { X, all, fetched } = await denseX({ chunks: [50, STRIP] });
  const options = context({ decodedChunkBytes: 1024, columnIndexBytes: 1024 });
  assert.equal(readsThroughRowIndex(X, options), false);
  const cost = await geneReadCost(X, { ...options, valuesOnDemand: false, retainIndicesBytes: 0 });
  assert.equal(cost.cellMajor, false, 'the first gene does not read the whole matrix');
  assert.equal(cost.layout, 'dense-strips');
  const columns = await openMatrixColumns(X, options);
  fetched.length = 0;
  const gene = 9;
  assert.deepEqual(Array.from(await columns.column(gene)), Array.from(columnOf(all, gene)));
  // Only the strip of gene 9 (genes 8-11): chunk column 2 of every row band.
  const touched = new Set(fetched.filter(key => key.startsWith('X/')).map(key => key.split(/[./]/).at(-1)));
  assert.deepEqual([...touched], ['2'], `chunks read: ${fetched.join(', ')}`);
  assert.equal(columns.residentBytes(), 0, 'no gene index is built');
});

test('the same strips go through one indexing pass when the whole index fits memory, and are named as strips', async () => {
  const { X, all } = await denseX({ chunks: [50, STRIP] });
  const options = context({ decodedChunkBytes: 1024, columnIndexBytes: N_OBS * N_VARS * 4 });
  assert.equal(readsThroughRowIndex(X, options), true);
  const cost = await geneReadCost(X, { ...options, valuesOnDemand: false, retainIndicesBytes: 0 });
  assert.equal(cost.cellMajor, true);
  assert.equal(cost.layout, 'dense-wide-strips');
  const columns = await openMatrixColumns(X, options);
  assert.deepEqual(Array.from(await columns.column(30)), Array.from(columnOf(all, 30)));
});

test('a Loom-oriented matrix (genes by cells, 64-style square chunks) is read by its cells\' gene strip', async () => {
  // Stored genes × cells, chunked [STRIP genes, 50 cells]; presented cells × genes.
  const all = values();
  const byGene = new Float32Array(N_OBS * N_VARS);
  for (let row = 0; row < N_OBS; row++) for (let gene = 0; gene < N_VARS; gene++) byGene[gene * N_OBS + row] = all[row * N_VARS + gene];
  const tree = minimalAnnData({ nObs: N_OBS, genes: Array.from({ length: N_VARS }, (_, i) => `g${i}`), X: dense(byGene, [N_VARS, N_OBS], { chunks: [STRIP, 50] }) });
  const { root, fetched } = await openStore(tree);
  const X = transposedArray(root.get('X'), { path: '/X' });
  assert.deepEqual(X.chunks, [50, STRIP]);
  const options = context({ decodedChunkBytes: 1024, columnIndexBytes: 1024 });
  assert.equal(geneLayoutOf(X, options), 'dense-strips');
  const columns = await openMatrixColumns(X, options);
  fetched.length = 0;
  assert.deepEqual(Array.from(await columns.column(17)), Array.from(columnOf(all, 17)));
  const touched = new Set(fetched.filter(key => key.startsWith('X/')).map(key => key.split(/[./]/).at(-2)));
  assert.deepEqual([...touched], ['4'], 'only the strip of genes 16-19');
});

test('a subsample is not sized for an index the strip route never builds', async () => {
  const { root } = await denseX({ chunks: [50, STRIP] });
  // The index (51 KB) exceeds the gene-index budget; one strip (6.4 KB) the cache.
  const fit = autoFitCount(root, N_OBS, { valuesOnDemand: false, decodedChunkBytes: 1024, allowanceBytes: 1 << 30, columnIndexBytes: 1024 });
  assert.equal(fit, null, 'every cell opens: genes are read by strip');
  assert.equal(geneIndexFit(root, N_OBS, N_OBS, { valuesOnDemand: false, decodedChunkBytes: 1024, allowanceBytes: 1 << 30, columnIndexBytes: 1024 }), null, 'and for every cell: no gene sample');
  // Rows: the index is the only route, and it sizes the gene sample (the map opens whole).
  const { root: rows } = await denseX({ chunks: [50, N_VARS] });
  assert.equal(autoFitCount(rows, N_OBS, { valuesOnDemand: false, decodedChunkBytes: 1024, allowanceBytes: 1 << 30, columnIndexBytes: 25_600 }), null);
  const sized = geneIndexFit(rows, N_OBS, N_OBS, { valuesOnDemand: false, decodedChunkBytes: 1024, allowanceBytes: 1 << 30, columnIndexBytes: 25_600 });
  assert.equal(sized?.limit, 'columnIndex');
  assert.ok(sized.cells < N_OBS);
});
