/**
 * The cell-order digest a session records (`data/cell-order-digest.js`) is
 * a function of the cells and their stored coordinates only: each cell is
 * named by its original position, its embedding values rounded to float32,
 * and the cells are summed. So the same cells of the same file digest alike
 * however they were opened -- whole, grown step by step, raised or lowered
 * by Apply, cut in place to a session's share, in priority order or as the
 * file gives them -- and the reader worker answers the digest from what it
 * summed while reading (`EmbeddingPayloads.cellOrderDigest`), reading only
 * the rows its sums do not cover.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { annData, countingStore, dataFrame, dense, mapping, strings } from './helpers/anndata-store.mjs';
import { zippedStoreEntries } from './helpers/zarr-corpus.mjs';
import { memoryStore, openZarr } from '../assets/js/formats/zarr/index.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { EmbeddingPayloads } from '../assets/js/data/embedding-payload.js';
import {
  CELL_ORDER_BLOCK_ROWS,
  CellOrderSums,
  addCellOrderSums,
  cellOrderDigest,
  cellOrderDigestOf,
} from '../assets/js/data/cell-order-digest.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import { storedObsm } from './helpers/stored-obsm.mjs';

const PRIORITY_FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'priority');

test('the digest is MurmurHash3 lanes of (original position, float32 words), summed, then finalised', () => {
  // Independent reference values (a byte-wise MurmurHash3_x86_32 in Python):
  // the cell at original position 7 with values (1.5, -2.25, 3).
  assert.deepEqual(
    addCellOrderSums({ low: 0, high: 0 }, new Float32Array([1.5, -2.25, 3]), 3, () => 7),
    { low: 2472614701, high: 112963305 },
  );
  const values = [1.5, -2.25, 3, 0, 7, -0, NaN, 1e-30, 5, 0.1, 0.2, 0.3];
  assert.equal(cellOrderDigest(new Float64Array(values), 3, new Uint32Array([0, 1, 2, 3])), '30502b9d6c160185');
  assert.equal(cellOrderDigest(new Float32Array(values), 3, new Uint32Array([10, 4, 2, 9])), '3ffd095e4f30cb78');
  assert.equal(cellOrderDigest(new Float64Array(values.slice(0, 8)), 2, new Uint32Array([0, 1, 2, 3])), '296f85d2505a0788');
  assert.equal(cellOrderDigest(new Float32Array(values.slice(0, 4)), 1, new Uint32Array([5, 6, 7, 8])), 'ea497757a7c4d82b');
  // Null originals: row i is original position i.
  assert.equal(cellOrderDigest(new Float32Array(values), 3), '30502b9d6c160185');
});

test('the digest names cells, not rows: any order, any parts, stored float64 or float32', () => {
  const random = createMulberry32(5);
  const n = 500;
  const stored = Float64Array.from({ length: n * 2 }, () => (random() - 0.5) * 40);
  const originals = Uint32Array.from({ length: n }, (_, i) => i);
  const whole = cellOrderDigest(stored, 2, originals);
  // The same cells listed in another order.
  const order = Uint32Array.from(originals).sort((a, b) => ((a * 7919) % n) - ((b * 7919) % n));
  const permuted = new Float64Array(n * 2);
  order.forEach((cell, row) => permuted.set(stored.subarray(cell * 2, cell * 2 + 2), row * 2));
  assert.equal(cellOrderDigest(permuted, 2, order), whole);
  // Rounded to float32 first: the same digest.
  assert.equal(cellOrderDigest(Float32Array.from(stored), 2, originals), whole);
  // Sums of parts add.
  const head = addCellOrderSums({ low: 0, high: 0 }, stored.subarray(0, 300), 2, row => row);
  const tail = addCellOrderSums({ low: 0, high: 0 }, stored.subarray(300), 2, row => 150 + row);
  assert.equal(cellOrderDigestOf({ low: (head.low + tail.low) >>> 0, high: (head.high + tail.high) >>> 0 }, n), whole);
  // Another cell at a position, or other values, digest differently.
  const swapped = Uint32Array.from(originals);
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.notEqual(cellOrderDigest(stored, 2, swapped), whole);
  const moved = Float64Array.from(stored);
  moved[3] += 1e-3;
  assert.notEqual(cellOrderDigest(moved, 2, originals), whole);
  // Every NaN is one NaN.
  const nanA = new Float32Array([NaN, 1]);
  const nanB = new Float32Array(2);
  new Uint32Array(nanB.buffer)[0] = 0x7f800001;
  nanB[1] = 1;
  assert.equal(cellOrderDigest(nanA, 2), cellOrderDigest(nanB, 2));
});

test('block sums: a prefix keeps its whole blocks, a reordered total keeps only the total', () => {
  const random = createMulberry32(11);
  const n = 3 * CELL_ORDER_BLOCK_ROWS + 123;
  const stored = Float32Array.from({ length: n * 3 }, () => random() * 10);
  const sums = new CellOrderSums();
  sums.add(stored.subarray(0, 5000 * 3), 3, 0, null);
  sums.add(stored.subarray(5000 * 3), 3, 5000, null);
  assert.equal(sums.digest(), cellOrderDigest(stored, 3));
  assert.throws(() => sums.add(stored.subarray(0, 3), 3, 7, null), /cannot be added/);
  const cut = sums.prefix(2 * CELL_ORDER_BLOCK_ROWS + 10);
  assert.equal(cut.covered, 2 * CELL_ORDER_BLOCK_ROWS, 'the block the cut goes through is read again');
  cut.add(stored.subarray(cut.covered * 3, (2 * CELL_ORDER_BLOCK_ROWS + 10) * 3), 3, cut.covered, null);
  assert.equal(cut.digest(), cellOrderDigest(stored.subarray(0, (2 * CELL_ORDER_BLOCK_ROWS + 10) * 3), 3));
  assert.equal(sums.prefix(n).digest(), sums.digest(), 'the whole prefix is the whole');
  const reordered = CellOrderSums.reordered(sums);
  assert.equal(reordered.digest(), sums.digest());
  assert.equal(reordered.extendable, false);
  assert.equal(reordered.prefix(10).covered, 0);
});

/** A store of `n` cells whose UMAP and PCA are float32 and float64, chunked across the digest's blocks. */
function tree(n, seed = 3) {
  const random = createMulberry32(seed);
  return annData({
    obs: dataFrame({ _index: strings(Array.from({ length: n }, (_, i) => `cell-${i}`), { chunks: [4000] }) }),
    var: dataFrame({ _index: strings(['g0', 'g1']) }),
    obsm: mapping({
      X_umap: dense(Float32Array.from({ length: n * 2 }, () => (random() - 0.5) * 30), [n, 2], { chunks: [3000, 2] }),
      X_pca: dense(Float64Array.from({ length: n * 3 }, () => (random() - 0.5) * 7), [n, 3], { chunks: [2500, 3] }),
    }),
    X: dense(new Float32Array(n * 2), [n, 2], { chunks: [5000, 2] }),
  });
}

/** Readers of one store, each later one carrying the one before, as the reader worker opens them. */
async function sharedStore(root) {
  let previous = null;
  return {
    async open(cellSubset) {
      const reader = new AnnDataReader();
      await reader.open(root, { format: ZARR_FORMAT, name: 'cells.zarr', decodedChunkBytes: 0, cellSubset, carry: previous });
      if (previous !== null) {
        previous.releaseStore();
        previous.close();
      }
      previous = reader;
      return reader;
    },
  };
}

async function openRoot(n) {
  const { store } = countingStore(tree(n));
  return openZarr(store, { decodedChunkCacheBytes: 0 });
}

/** Record the open rows each `obsm` read of `reader` asks for. */
function spyRows(reader) {
  const rows = [];
  const read = reader.readObsmColumns.bind(reader);
  reader.readObsmColumns = (key, columns, options = {}) => {
    rows.push(options.rows ?? [0, reader.nObs]);
    return read(key, columns, options);
  };
  return rows;
}

/** The digest of the open cells computed from scratch: their stored values, named by original position. */
async function referenceDigest(reader, key, columns) {
  const subset = reader.cellSubset;
  const originals = subset.openOrder ?? subset.kept ?? Uint32Array.from({ length: reader.nObs }, (_, i) => i);
  return cellOrderDigest(await reader.readObsmColumns(key, columns), columns.length, originals);
}

const N = 20_000;
const subsample = k => ({ mode: 'subsample', method: 'uniform', k, seed: 9 });

test('grown in place, step by step, digests as the same cells opened directly', async () => {
  const root = await openRoot(N);
  const opened = await sharedStore(root);
  let reader = await opened.open(subsample(2_000));
  await reader.readEmbedding('X_umap', [0, 1], true);
  let shown = 2_000;
  for (const k of [7_000, 14_321]) {
    reader = await opened.open(subsample(k));
    // The page reads the added rows of the embedding it shows, in its frame.
    await reader.readEmbedding('X_umap', [0, 1], true, { rows: [shown, k] });
    shown = k;
  }
  const rows = spyRows(reader);
  const grown = await reader.readCellOrderDigest('X_umap', [0, 1]);
  assert.deepEqual(rows, [], 'summed as the rows were read: nothing is read for the digest');
  const direct = await (await sharedStore(await openRoot(N))).open(subsample(14_321));
  assert.equal(await direct.readCellOrderDigest('X_umap', [0, 1]), grown);
  assert.equal(grown, await referenceDigest(direct, 'X_umap', [0, 1]));
  // An embedding never read in this opening is read for its digest alone.
  assert.equal(await reader.readCellOrderDigest('X_pca', [0, 1, 2]), await referenceDigest(direct, 'X_pca', [0, 1, 2]));
});

test('Apply raise and lower: the digest is the opened cells\' whatever the frame, and a cut reads under one block', async () => {
  const root = await openRoot(N);
  const opened = await sharedStore(root);
  let reader = await opened.open(subsample(15_000));
  await reader.readEmbedding('X_pca', [0, 1, 2], false);
  // Lower: cut in place to the first 5,000 open cells.
  reader = await opened.open(subsample(5_000));
  let rows = spyRows(reader);
  const lowered = await reader.readCellOrderDigest('X_pca', [0, 1, 2]);
  assert.equal(rows.length, 1);
  assert.ok(rows[0][1] === 5_000 && rows[0][1] - rows[0][0] < CELL_ORDER_BLOCK_ROWS, `read ${rows[0]}`);
  const direct = await (await sharedStore(await openRoot(N))).open(subsample(5_000));
  assert.equal(lowered, await direct.readCellOrderDigest('X_pca', [0, 1, 2]));
  // Raise again: the added rows read by the page complete the sums.
  reader = await opened.open(subsample(18_000));
  await reader.readEmbedding('X_pca', [0, 1, 2], false, { rows: [5_000, 18_000] });
  rows = spyRows(reader);
  const raised = await reader.readCellOrderDigest('X_pca', [0, 1, 2]);
  assert.deepEqual(rows, []);
  const directRaised = await (await sharedStore(await openRoot(N))).open(subsample(18_000));
  assert.equal(raised, await referenceDigest(directRaised, 'X_pca', [0, 1, 2]));
});

test('a session saved on 10 % checks against the same cells cut in place from a whole opening', async () => {
  const entries = await zippedStoreEntries(path.join(PRIORITY_FIXTURES, 'written.zarr.zip'));
  const root = await openZarr(memoryStore(entries), { decodedChunkCacheBytes: 0 });
  // Saved on a 10 % opening of the priority-ordered file: its first 30 rows.
  const saved = await (await sharedStore(root)).open({ mode: 'subsample', k: 30 });
  await saved.readEmbedding('X_umap', [0, 1], true);
  const savedDigest = await saved.readCellOrderDigest('X_umap', [0, 1]);
  // Restored in a tab where the file is open whole, its embedding shown: the
  // restore cuts in place to the session's cells (`kept`).
  const opened = await sharedStore(root);
  const whole = await opened.open(null);
  await whole.readEmbedding('X_umap', [0, 1], true);
  const cut = await opened.open({ mode: 'kept', spec: saved.cellSubset.spec, kept: saved.cellSubset.kept });
  assert.equal(cut.nObs, 30);
  assert.equal(await cut.readCellOrderDigest('X_umap', [0, 1]), savedDigest);
  // And from a 20 % opening.
  const opened20 = await sharedStore(root);
  const twenty = await opened20.open({ mode: 'subsample', k: 60 });
  await twenty.readEmbedding('X_umap', [0, 1], false);
  const cut20 = await opened20.open({ mode: 'kept', spec: saved.cellSubset.spec, kept: saved.cellSubset.kept });
  assert.equal(await cut20.readCellOrderDigest('X_umap', [0, 1]), savedDigest);
});

test('a priority-ordered file and the same cells as given digest alike', async () => {
  const entries = await zippedStoreEntries(path.join(PRIORITY_FIXTURES, 'written.zarr.zip'));
  const priority = await (await sharedStore(await openZarr(memoryStore(entries), { decodedChunkCacheBytes: 0 }))).open(null);
  const order = priority.cellSubset.openOrder;
  assert.ok(order !== null && order.some((p, i) => p !== i), 'the file stores its cells in priority order');
  const stored = await priority.readObsmColumns('X_umap', [0, 1]);
  // The same cells in their original order, as a file that records no order.
  const n = priority.nObs;
  const given = new Float32Array(n * 2);
  for (let row = 0; row < n; row++) given.set(stored.subarray(row * 2, row * 2 + 2), order[row] * 2);
  const { store } = countingStore(annData({
    obs: dataFrame({ _index: strings(Array.from({ length: n }, (_, i) => `cell${i}`)) }),
    var: dataFrame({ _index: strings(['a']) }),
    obsm: mapping({ X_umap: dense(given, [n, 2]) }),
    X: dense(new Float32Array(n), [n, 1]),
  }));
  const asGiven = await (await sharedStore(await openZarr(store, { decodedChunkCacheBytes: 0 }))).open(null);
  assert.equal(asGiven.cellSubset?.openOrder ?? null, null);
  await priority.readEmbedding('X_umap', [0, 1], true);
  assert.equal(await priority.readCellOrderDigest('X_umap', [0, 1]), await asGiven.readCellOrderDigest('X_umap', [0, 1]));
  // Their 10 % subsamples (the priority file's first rows; the given file's
  // cells of the same specification, opened in priority order) too.
  const prioritySubset = await (await sharedStore(await openZarr(memoryStore(entries), { decodedChunkCacheBytes: 0 }))).open({ mode: 'subsample', k: 30 });
  const spec = prioritySubset.cellSubset.spec;
  const givenSubset = await (await sharedStore(await openZarr(store, { decodedChunkCacheBytes: 0 }))).open({ mode: 'kept', spec: { ...spec }, kept: prioritySubset.cellSubset.kept });
  assert.equal(await prioritySubset.readCellOrderDigest('X_umap', [0, 1]), await givenSubset.readCellOrderDigest('X_umap', [0, 1]));
});

test('the same cells opened again in another order keep the total they were summed to', async () => {
  const stored = Float32Array.from({ length: 40 }, (_, i) => i * 1.25);
  const read = (key, columns, { rows = null } = {}) => {
    const [a, b] = rows ?? [0, 20];
    return Promise.resolve(stored.slice(a * 2, b * 2));
  };
  const before = new EmbeddingPayloads(read, { cellNames: async cells => cells.map(cell => `cell${cell}`), cellCount: () => 20, originals: () => null });
  await before.embedding('X_umap', [0, 1], true);
  // Open order reversed: open row i is original position 19 - i, and a
  // reader reading rows would get these cells' values in that order.
  const reversed = Uint32Array.from({ length: 20 }, (_, i) => 19 - i);
  const after = new EmbeddingPayloads(() => { throw new Error('nothing is read'); }, { cellNames: async cells => cells.map(cell => `cell${cell}`), cellCount: () => 20, originals: () => reversed });
  after.adoptCellOrderSums(before, { shared: 0, sameCells: true });
  assert.equal(await after.cellOrderDigest('X_umap', [0, 1]), await before.cellOrderDigest('X_umap', [0, 1]));
  assert.equal(await before.cellOrderDigest('X_umap', [0, 1]), cellOrderDigest(stored, 2));
});

test('through the reader worker, an .h5ad and a .zarr.zip of the same cells digest alike, as their stored values say', async t => {
  const log = console.log;
  console.log = () => {};
  t.after(() => { console.log = log; });
  const digests = [];
  for (const file of ['data-mapping-full.h5ad', 'data-mapping-full.zarr.zip']) {
    const bytes = await readFile(new URL(`./browser/fixtures/${file}`, import.meta.url));
    const source = new AnnDataFileSource();
    t.after(() => source.clear());
    await source.loadFile(new File([bytes], file));
    const adapter = source.getAdapter();
    const index = adapter.getMappingCandidates().obsm.findIndex(item => item.key === 'X_umap');
    const digest = await adapter.getCellOrderDigest(`obsm/${index}/0-1`);
    const stored = await storedObsm(new File([bytes], file), 'X_umap', [0, 1]);
    assert.equal(digest, cellOrderDigest(Float64Array.from(stored), 2), file);
    digests.push(digest);
  }
  assert.equal(digests[0], digests[1]);
});

test('after the cells grow in place, a staged binding reads through the reading now, and the digest is the cells\' ', async t => {
  const log = console.log;
  console.log = () => {};
  t.after(() => { console.log = log; });
  const { createCandidateAnnDataBinding, anndataCellOrderDigest } = await import('../assets/js/data/anndata-provider.js');
  const { anndataZarrZip } = await import('./browser/helpers/anndata-zarr-zip.mjs');
  const n = 600;
  const umap = Float32Array.from({ length: n * 2 }, (_, i) => Math.sin(i * 0.37) * 10);
  const bytes = anndataZarrZip({
    cells: n,
    genes: ['g0', 'g1'],
    X: Float32Array.from({ length: n * 2 }, (_, i) => i % 3),
    obsm: { X_umap: { data: umap, columns: 2 } },
  });
  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  await source.loadFile(new File([bytes], 'cells.zarr.zip'));
  const sub = k => ({ mode: 'subsample', method: 'uniform', k, seed: 2 });
  await source.reopenCells({ cellSubset: sub(150) });
  const url = source.getBaseUrl(source.datasetId);
  // Staged once, as the app stages a dataset; its readings change after.
  const binding = createCandidateAnnDataBinding(url, source);
  const index = source.getAdapter().getMappingCandidates().obsm.findIndex(item => item.key === 'X_umap');
  const grown = await source.reopenCells({ cellSubset: sub(300) });
  assert.ok(grown.resized !== null, 'grown in place: the adapter was replaced');
  const digest = await anndataCellOrderDigest(`${url}obsm/${index}/0-1`, {}, binding);
  const identity = source.getCellIdentity();
  const originals = identity.toOriginal(Uint32Array.from({ length: identity.n }, (_, i) => i));
  const values = new Float32Array(identity.n * 2);
  originals.forEach((p, row) => values.set([umap[p * 2], umap[p * 2 + 1]], row * 2));
  assert.equal(digest, cellOrderDigest(values, 2, originals));
});
