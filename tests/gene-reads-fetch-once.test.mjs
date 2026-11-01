/**
 * A dataset stored cell by cell (CSR), opened as a subsample over a link
 * slower than a disk, as a person meets an atlas from a link (HLCA from
 * CELLxGENE, 2.3M cells): every stored byte is fetched at most once across
 * the opening, its growth in place to the cells asked for, and three genes,
 * the first given up for the second while its index pass runs (a person
 * picks another gene before the first has coloured).
 *
 * - The gene index pass a withdrawn gene started is kept: the next gene goes
 *   on from the slab it reached (`RowMajorColumnIndex` `_pass1`), and over a
 *   measured link a gene asked within one round trip of the withdrawal joins
 *   the pass without stopping it (its reads in flight kept).
 * - Growth indexes only the cells it adds: the gene index of the cells open
 *   before is carried (`carriedSegments`).
 * - The kept rows' pointers are asked for in one batch (every chunk they lie
 *   in at once, so the byte reader plans them together), and their read is
 *   an activity of its own.
 * - The gene sample prices the first gene of a cell-major matrix at the
 *   measured link (`geneTimeFit`): genes are read for no more of the open
 *   cells than it reads within the target, while the map opens every cell;
 *   a gene-major matrix, or a file with no link, has no sample.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { annData, countingStore, dataFrame, dense, mapping, sparse, strings } from './helpers/anndata-store.mjs';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { RowMajorColumnIndex, createColumnStoreFactory } from '../assets/js/data/sparse-column-index.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';
import { GENE_READ_TARGET_MS, firstGeneReadCost, geneTimeFit, linkReadMs } from '../assets/js/data/anndata/subsample-plan.js';
import { geneLayoutFacts, geneLayoutReason, geneReadPlanFacts, geneSampleFacts } from '../assets/js/data/gene-read-plan.js';
import { subsampleBlocks } from '../assets/js/data/subsample.js';
import { wholeGeneIndexActivity } from '../assets/js/data/anndata/prefix-column-index.js';
import { CellRows } from '../assets/js/data/anndata/views/cell-subset.js';

import { until } from './helpers/until.mjs';

const N_OBS = 6000;
const N_VARS = 40;

/** A CSR X of `N_OBS` cells in small chunks, and its dense values (cell-major) to check genes against. */
function csrTree({ layout = 'csr' } = {}) {
  const random = createMulberry32(11);
  const values = new Float32Array(N_OBS * N_VARS);
  const data = [];
  const indices = [];
  const indptr = [0];
  for (let cell = 0; cell < N_OBS; cell++) {
    for (let gene = 0; gene < N_VARS; gene++) {
      if (random() < 0.3) {
        const value = Math.fround(1 + random() * 9);
        values[cell * N_VARS + gene] = value;
        indices.push(gene);
        data.push(value);
      }
    }
    indptr.push(data.length);
  }
  let X;
  if (layout === 'csc') {
    const cData = [];
    const cIndices = [];
    const cIndptr = [0];
    for (let gene = 0; gene < N_VARS; gene++) {
      for (let cell = 0; cell < N_OBS; cell++) {
        const value = values[cell * N_VARS + gene];
        if (value !== 0) {
          cIndices.push(cell);
          cData.push(value);
        }
      }
      cIndptr.push(cData.length);
    }
    X = sparse({ format: 'csc', data: Float32Array.from(cData), indices: Int32Array.from(cIndices), indptr: Int32Array.from(cIndptr), shape: [N_OBS, N_VARS], compressed: true });
  } else {
    X = sparse({ format: 'csr', data: Float32Array.from(data), indices: Int32Array.from(indices), indptr: Int32Array.from(indptr), shape: [N_OBS, N_VARS], compressed: true });
  }
  X.children.data.chunks = [512];
  X.children.indices.chunks = [512];
  X.children.indptr.chunks = [256];
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: N_OBS }, (_, i) => `c${i}`), { chunks: [500] }) }),
    var: dataFrame({ _index: strings(Array.from({ length: N_VARS }, (_, g) => `g${g}`)) }),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: N_OBS * 2 }, (_, i) => i), [N_OBS, 2], { chunks: [500, 2], compressed: true }) }),
    X,
  });
  return { tree, values };
}

/** A link slower than a disk (values read per gene), measured: a round trip of `latencyMs`. */
function slowLink(latencyMs) {
  const snapshot = { measured: latencyMs > 0, latencyMs, bytesPerMs: 1000, concurrency: 6, mergeGapBytes: 0, roundTripBytes: latencyMs * 1000, readsAhead: false };
  return { readsAhead: false, mergeGapBytes: 0, roundTripBytes: snapshot.roundTripBytes, snapshot: () => snapshot, watchProtocol() {} };
}

const BLOCKS = k => ({ mode: 'subsample', method: 'blocks', k, seed: 0, blockSize: 25, strict: true });

/** Every byte of every stored chunk fetched more than once: `[key, start, end, times]`. */
function fetchedTwice(reads) {
  const byKey = new Map();
  for (const { key, start, end } of reads) {
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push([start, end]);
  }
  const twice = [];
  for (const [key, ranges] of byKey) {
    const events = ranges.flatMap(([start, end]) => [[start, 1], [end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let depth = 0;
    let from = 0;
    for (const [at, delta] of events) {
      if (depth > 1 && at > from) twice.push([key, from, at, depth]);
      depth += delta;
      from = at;
    }
  }
  return twice;
}

function assertGene(column, values, cells, gene, label) {
  assert.equal(column.length, cells.length, `${label}: one value a cell`);
  for (let i = 0; i < cells.length; i++) assert.equal(column[i], values[cells[i] * N_VARS + gene], `${label}: cell ${i}`);
}

/** An opening of `root`, taking over from `previous` (an opening grown in place), which then closes. */
async function reopen(root, previous, options) {
  const reader = new AnnDataReader();
  await reader.open(root, { ...options, carry: previous });
  if (previous !== null) {
    previous.releaseStore();
    previous.close();
  }
  return reader;
}

/** The open cells' original positions, in open order (`readObsNames` of `c<i>`). */
async function openCells(reader) {
  const names = await reader.readObsNames();
  return Array.from(names, name => Number(String(name).slice(1)));
}

test('every byte is fetched at most once across opening, growth and three genes, the second picked while the first indexes', async () => {
    const { tree, values } = csrTree();
    // Pause the index's matrix reads until the first gene has read a few
    // slabs, so it is given up while its pass runs.
    let xReads = 0;
    let giveUp = null;
    const { store, reads } = countingStore(tree, {
      onChunk: async key => {
        if (!key.startsWith('X/indices/')) return;
        xReads++;
        if (xReads === 6) giveUp?.();
        await new Promise(resolve => setTimeout(resolve, 1));
      },
    });
    const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
    const link = slowLink(20);
    // Decoded chunks kept for less than the matrix (HLCA's index pass decodes
    // gigabytes; the store keeps a 32nd of the memory allowance): a slab
    // read twice is fetched twice.
    const options = { format: ZARR_FORMAT, name: 'atlas.zarr', decodedChunkBytes: 64 * 1024, link };
    // The first view, then the opening grown in place to the cells asked for.
    const view = await reopen(root, null, { ...options, cellSubset: BLOCKS(1500) });
    await view.readEmbedding('X_umap', [0, 1], false);
    const reader = await reopen(root, view, { ...options, cellSubset: BLOCKS(3000) });
    await reader.readEmbedding('X_umap', [0, 1], false, { rows: [1500, 3000] });
    const cells = await openCells(reader);
    assert.equal(cells.length, 3000);
    // Gene 1, given up while its pass runs for gene 2 (asked at once, as a
    // person picking another gene), then gene 3.
    const first = new AbortController();
    const firstRead = reader.getMatrixColumn('X', 3, { signal: first.signal, onPartial: () => {} });
    let second = null;
    await new Promise(resolve => {
      giveUp = () => {
        giveUp = null;
        first.abort(new DOMException('another gene', 'AbortError'));
        second = reader.getMatrixColumn('X', 7, { onPartial: () => {} });
        resolve();
      };
    });
    await assert.rejects(firstRead, error => error?.name === 'AbortError');
    assertGene(await second, values, cells, 7, 'gene 2');
    assertGene(await reader.getMatrixColumn('X', 12), values, cells, 12, 'gene 3');
    assertGene(await reader.getMatrixColumn('X', 3), values, cells, 3, 'gene 1, asked again');
    const twice = fetchedTwice(reads);
    assert.deepEqual(twice, [], `stored bytes fetched more than once: ${JSON.stringify(twice.slice(0, 8))}`);
    // Every chunk of the matrix the open cells lie in was read (the pass is whole).
    assert.ok(reads.some(read => read.key.startsWith('X/indices/')));
});

/** A sparse matrix of `nRows` x `nCols`, a value in about a third of its cells. */
function sparseFixture(nRows, nCols) {
  const random = createMulberry32(3);
  const indptr = [0];
  const indices = [];
  const data = [];
  const dense = new Float32Array(nRows * nCols);
  for (let row = 0; row < nRows; row++) {
    for (let col = 0; col < nCols; col++) {
      if (random() < 0.33) {
        const value = Math.fround(1 + random() * 5);
        indices.push(col);
        data.push(value);
        dense[row * nCols + col] = value;
      }
    }
    indptr.push(indices.length);
  }
  return { nRows, nCols, indptr: Float64Array.from(indptr), indices: Int32Array.from(indices), data: Float32Array.from(data), dense };
}

/**
 * A gene index over `fixture` read over a link of `latencyMs` (values on
 * demand, as over any link slower than a disk), every read of indices
 * recorded as its entry range and answered after `readMs`.
 */
function slowIndex(fixture, { latencyMs, readMs = 2 }) {
  const indexReads = [];
  let stopped = 0;
  const index = new RowMajorColumnIndex({
    layout: 'sparse',
    nRows: fixture.nRows,
    nCols: fixture.nCols,
    nnz: fixture.indices.length,
    readRowPointers: async (start, end) => fixture.indptr.slice(start, end),
    readIndices: async (start, end, { signal } = {}) => {
      indexReads.push([start, end]);
      await new Promise(resolve => setTimeout(resolve, readMs));
      if (signal?.aborted) {
        stopped++;
        throw signal.reason;
      }
      return fixture.indices.slice(start, end);
    },
    readValues: async (start, end) => fixture.data.slice(start, end),
    storeFactory: createColumnStoreFactory({ memoryBudgetBytes: 1e9 }),
    valuesOnDemand: true,
    retainIndicesBytes: 1e9,
    slabEntries: 400,
    link: () => ({ measured: latencyMs > 0, latencyMs, bytesPerMs: 1000, concurrency: 2, mergeGapBytes: 0, roundTripBytes: 0 }),
    label: 'X',
  });
  return { index, indexReads, stopped: () => stopped };
}

function columnOf(fixture, col) {
  return Float32Array.from({ length: fixture.nRows }, (_, row) => fixture.dense[row * fixture.nCols + col]);
}

/** Entries of `reads` (`[start, end)` ranges) read more than once. */
function entriesReadTwice(reads) {
  return fetchedTwice(reads.map(([start, end]) => ({ key: 'indices', start, end }))).reduce((sum, [, from, to, depth]) => sum + (to - from) * (depth - 1), 0);
}

test('a gene asked within one round trip of the one it replaces joins the index pass: no slab is read twice, none stopped', async () => {
  const fixture = sparseFixture(3000, 30);
  const { index, indexReads, stopped } = slowIndex(fixture, { latencyMs: 30 });
  const first = new AbortController();
  const firstRead = index.column(4, { signal: first.signal });
  while (indexReads.length < 8) await new Promise(resolve => setTimeout(resolve, 1));
  first.abort(new DOMException('another gene', 'AbortError'));
  await assert.rejects(firstRead, error => error?.name === 'AbortError');
  // The next gene, a few milliseconds later (the page's next request).
  await new Promise(resolve => setTimeout(resolve, 3));
  assert.deepEqual(Array.from(await index.column(9)), Array.from(columnOf(fixture, 9)));
  assert.deepEqual(Array.from(await index.column(4)), Array.from(columnOf(fixture, 4)), 'the withdrawn gene, from the index');
  assert.equal(stopped(), 0, 'no read was stopped');
  assert.equal(entriesReadTwice(indexReads), 0);
});

test('a gene asked after the pass stopped goes on from where it stopped: the slabs counted are never read again', async () => {
  const fixture = sparseFixture(3000, 30);
  // No round trip to wait: the pass stops as the only gene withdraws.
  const { index, indexReads } = slowIndex(fixture, { latencyMs: 0 });
  const first = new AbortController();
  const firstRead = index.column(4, { signal: first.signal });
  while (indexReads.length < 12) await new Promise(resolve => setTimeout(resolve, 1));
  first.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(firstRead, error => error?.name === 'AbortError');
  // Stopped once its reads in flight have come back.
  await until(() => index.phase === 'idle', 'the pass stopped');
  const before = indexReads.length;
  assert.ok(index.remaining < 1, 'what it counted is kept');
  assert.deepEqual(Array.from(await index.column(9)), Array.from(columnOf(fixture, 9)));
  assert.deepEqual(Array.from(await index.column(4)), Array.from(columnOf(fixture, 4)));
  // Only the slabs read ahead of the one counted when it stopped (their
  // reads were let go) are read again: at most the read-ahead depth.
  const slabEntries = 400;
  const readAhead = 2;
  assert.ok(entriesReadTwice(indexReads) <= (readAhead + 1) * slabEntries, `read again: ${entriesReadTwice(indexReads)} entries`);
  assert.ok(indexReads.length - before < Math.ceil(fixture.indices.length / slabEntries), 'the next gene did not start the pass over');
});

test('growth indexes only the cells it adds: the gene index of the cells open before is carried', async () => {
  const { tree, values } = csrTree();
  const { store, reads } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const options = { format: ZARR_FORMAT, name: 'atlas.zarr', decodedChunkBytes: 64 * 1024 * 1024, link: slowLink(0) };
  const view = await reopen(root, null, { ...options, cellSubset: BLOCKS(1500) });
  const before = await openCells(view);
  assertGene(await view.getMatrixColumn('X', 5), values, before, 5, 'gene on the first view');
  const indexed = reads.filter(read => read.key.startsWith('X/indices/')).length;
  const reader = await reopen(root, view, { ...options, cellSubset: BLOCKS(3000) });
  const after = await openCells(reader);
  assert.deepEqual(after.slice(0, 1500), before, 'the first view is the first cells of the grown one');
  assertGene(await reader.getMatrixColumn('X', 5, { rows: [1500, 3000] }), values, after.slice(1500), 5, 'the added cells');
  assertGene(await reader.getMatrixColumn('X', 9), values, after, 9, 'another gene on every cell');
  assert.deepEqual(fetchedTwice(reads), []);
  assert.ok(reads.filter(read => read.key.startsWith('X/indices/')).length > indexed, 'the added cells were indexed');
});

test('the kept rows\' pointers are asked for in one batch, and read as an activity of their own', async () => {
  const { tree } = csrTree();
  let inFlight = 0;
  let most = 0;
  let pointerChunks = 0;
  const { store } = countingStore(tree, {
    onChunk: async key => {
      if (!key.startsWith('X/indptr/')) return;
      pointerChunks++;
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
    },
  });
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  const activities = [];
  reader.createActivity = what => {
    const activity = { ...what, status: 'running', finish(error = null) { this.status = error === null ? 'done' : 'failed'; }, progress() {}, expect() {}, planned() {}, fetched() {}, decoded() {}, cacheHit() {} };
    activities.push(activity);
    return activity;
  };
  // Blocks spread over the file: their pointers lie in most pointer chunks.
  await reader.open(root, { format: ZARR_FORMAT, name: 'atlas.zarr', link: slowLink(0), cellSubset: BLOCKS(2000) });
  await reader.geneReadPlan('X');
  assert.ok(pointerChunks > 4, `the kept rows lie in many pointer chunks (${pointerChunks})`);
  assert.equal(most, pointerChunks, 'every pointer chunk is asked for at once');
  const pointers = activities.filter(activity => /row pointers/.test(activity.label));
  assert.equal(pointers.length, 1, 'one activity for the pointers');
  assert.equal(pointers[0].status, 'done');
  assert.match(pointers[0].label, /^where each open cell's row of X starts \(its row pointers\), read once before its first gene$/);
});

test('the gene sample prices the first gene of a cell-major matrix at the measured link, within the target', async () => {
  const { tree } = csrTree();
  const { store } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const link = { measured: true, latencyMs: 100, bytesPerMs: 20, concurrency: 6, shapingConcurrency: 6 };
  const rowsOf = k => (k >= N_OBS ? Uint32Array.from({ length: N_OBS }, (_, i) => i) : subsampleBlocks(N_OBS, k, 0, 25));
  // Nothing of it kept in this browser: every kept cell's rows are read.
  const rowsAt = async k => ({ rows: rowsOf(k), indexed: 0 });
  const context = { link, targetMs: 2000, valuesOnDemand: true, decodedChunkBytes: 1e9, rowsAt };
  const fit = await geneTimeFit(root, N_OBS, N_OBS, context);
  assert.equal(fit.limit, 'geneTime');
  assert.equal(fit.layout, 'csr');
  assert.equal(fit.neededCells, N_OBS);
  const cost = await firstGeneReadCost(root, N_OBS, { valuesOnDemand: true, decodedChunkBytes: 1e9 });
  const at = async k => linkReadMs(cost(rowsOf(k)), link);
  assert.ok(await at(fit.cells) <= 2000, 'the sample\'s cells read a gene within the target');
  assert.ok(await at(fit.cells + 1) > 2000, 'one more cell would not');
  assert.ok(fit.neededMs > 2000);
  // A faster link opens every cell; no link (a local file), or a gene-major
  // matrix, is not limited by it.
  assert.equal(await geneTimeFit(root, N_OBS, N_OBS, { ...context, link: { ...link, bytesPerMs: 1e9, latencyMs: 0 } }), null);
  assert.equal(await geneTimeFit(root, N_OBS, N_OBS, { ...context, link: null }), null);
  const csc = await openZarr(countingStore(csrTree({ layout: 'csc' }).tree).store, { decodedChunkCacheBytes: 0 });
  assert.equal(await geneTimeFit(csc, N_OBS, N_OBS, context), null);
  assert.ok(GENE_READ_TARGET_MS >= 10_000 && GENE_READ_TARGET_MS <= 30_000);
  assert.equal(fit.kept, null, 'nothing kept in this browser');
  // A later visit: the gene index of the first open cells is kept in this
  // browser, so they cost the first gene nothing and genes are read for more cells.
  const indexedRows = fit.cells;
  const revisit = await geneTimeFit(root, N_OBS, N_OBS, {
    ...context,
    rowsAt: async k => {
      const rows = rowsOf(k);
      const indexed = Math.min(indexedRows, rows.length);
      return { rows: rows.slice(indexed), indexed };
    },
  });
  assert.ok(revisit === null || revisit.cells > fit.cells, 'genes are read for more cells within the target');
  if (revisit !== null) assert.deepEqual(revisit.kept, { cells: indexedRows, bytes: 0 });
});

test('an auto opening over a slow link opens every cell and reads genes for the cells a gene reads within the target, and says why', async () => {
  const { tree } = csrTree();
  const { store } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  // 1 KB/s: the matrix's stored indices take minutes over it.
  const snapshot = { measured: true, latencyMs: 200, bytesPerMs: 1, concurrency: 6, mergeGapBytes: 0, roundTripBytes: 200, readsAhead: false };
  const link = { readsAhead: false, mergeGapBytes: 0, roundTripBytes: 200, snapshot: () => snapshot, watchProtocol() {} };
  await reader.open(root, { format: ZARR_FORMAT, name: 'atlas.zarr', link, cellSubset: { mode: 'auto' } });
  const subset = reader.cellSubset;
  assert.equal(subset.kept, null, 'the map opens every cell');
  assert.equal(subset.autoFit, null);
  assert.equal(subset.genes.fit.limit, 'geneTime');
  assert.ok(subset.genes.cells < N_OBS && subset.genes.cells === subset.genes.fit.cells);
  assert.equal(subset.cellOrder.method, 'blocks');
  const [genes, sized, stored] = geneSampleFacts(subset.genes);
  assert.deepEqual([genes.label, genes.value], ['Genes read', `${subset.genes.cells.toLocaleString('en-US')} of 6,000 open cells`]);
  assert.equal(sized.label, 'Sized to');
  assert.match(sized.value, /^a gene in about 20 s here$/);
  assert.match(sized.title, /^Every open cell would take ~\d/);
  assert.deepEqual([stored.label, stored.value], ['Stored', 'cell by cell (sparse, CSR)']);
});

test('each layout yields its own cause, and a gene-major one none', () => {
  assert.match(geneLayoutReason('csr'), /cell by cell \(sparse, CSR\), so one gene's values are spread over every cell's row$/);
  assert.match(geneLayoutReason('dense-rows'), /densely, row by row \(in one piece or in blocks of whole cells\), so one gene's values lie in every block$/);
  // Dense strips indexed whole are named as strips, never as rows (a Loom file's 64-gene strips).
  assert.match(geneLayoutReason('dense-wide-strips'), /densely in strips of genes too wide to keep decoded, so every strip is read once and indexed in memory$/);
  assert.equal(geneLayoutFacts('dense-wide-strips', { cells: 3 })[1].value, 'the strips of 3 open cells');
  assert.equal(geneLayoutReason('csc'), null);
  assert.equal(geneLayoutReason('dense-strips'), null);
  assert.equal(geneLayoutFacts('csc', { cells: 10 }), null);
  const csr = geneLayoutFacts('csr', { cells: 1, amount: '4 KB' });
  assert.deepEqual(csr.map(row => row.label), ['Stored', 'One gene reads', 'Later genes', 'Faster']);
  assert.equal(csr[1].value, 'the rows of 1 open cell (4 KB)');
  assert.match(csr[3].title, /cellucid\.prepare\(\) in Python or cellucid_prepare\(\) in R/);
  assert.equal(geneLayoutFacts('dense-rows', { cells: 2 })[1].value, 'the blocks of 2 open cells');
  const plan = { label: 'X', cells: 9000, cellMajor: true, layout: 'csr', built: false, scan: { storedBytes: 40e6 }, bytesPerSecond: 2e6, index: { placement: 'memory', passes: 1 }, progressive: { cells: 9000, done: 0, next: 3000, nextStoredBytes: 13e6 } };
  assert.equal(geneReadPlanFacts(plan).summary, '38 MB · ~20 s · 9,000 cells to read');
  assert.equal(geneReadPlanFacts({ ...plan, layout: 'csc', cellMajor: false }), null);
});

test('a gene waiting on several index segments reads under one activity: the whole gene\'s bytes, progress and end', async () => {
  const made = [];
  const onIndexStartAt = wholeGeneIndexActivity({
    nRows: 100,
    create: label => {
      const activity = { label, status: 'running', expected: 0, steps: [], ends: 0, finish(error = null) { this.ends++; this.status = error === null ? 'done' : 'cancelled'; }, expect(bytes) { this.expected += bytes; }, progress(done, total) { this.steps.push([done, total]); } };
      made.push(activity);
      return activity;
    },
    createRescan: () => null,
    bytesFrom: async row => (100 - row) * 10,
  });
  // One after another: 0-25, 25-50, 50-100.
  for (const [start, rows] of [[0, 25], [25, 25], [50, 50]]) {
    const activity = onIndexStartAt(start, rows)('X');
    activity.expect(1);
    activity.progress(1, 2);
    activity.finish();
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(made.length, 1, 'one activity for the whole gene');
  assert.equal(made[0].expected, 1000, 'the whole gene\'s bytes, expected once');
  assert.equal(made[0].ends, 1);
  assert.deepEqual(made[0].steps.at(-1), [100, 100]);
  // Built together, the last row's segment ending first: ended by the last to end.
  const together = [[0, 25], [25, 25], [50, 50]].map(([start, rows]) => onIndexStartAt(start, rows)('X'));
  assert.equal(made.length, 2);
  together[2].finish();
  together[0].finish();
  assert.equal(made[1].status, 'running');
  together[1].finish();
  assert.equal(made[1].ends, 1);
  // A stop ends it at once; the next build starts a new one with what is left.
  const stopped = onIndexStartAt(0, 50)('X');
  stopped.finish(new DOMException('stopped', 'AbortError'));
  assert.equal(made[2].status, 'cancelled');
  onIndexStartAt(0, 50)('X');
  assert.equal(made.length, 4);
});

test('a run of gene reads on a gene sample checks the sample\'s row pointers once: no read after the first walks its rows', async () => {
  // Every read of a gene asks whether the gene sample's rows' pointers are
  // held (`_readyRows` with the sample's rows). Walked each time -- the
  // runs of the sample's rows made again, twice a read -- a markers run of
  // 30,000 genes over a 9.5M-cell sample spent O(sample) a read and timed
  // out; the sample's coverage is known once found, so a read checks it at
  // once whatever the sample's size.
  const { tree, values } = csrTree();
  const { store } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  const snapshot = { measured: true, latencyMs: 200, bytesPerMs: 1, concurrency: 6, mergeGapBytes: 0, roundTripBytes: 200, readsAhead: false };
  const link = { readsAhead: false, mergeGapBytes: 0, roundTripBytes: 200, snapshot: () => snapshot, watchProtocol() {} };
  await reader.open(root, { format: ZARR_FORMAT, name: 'atlas.zarr', link, cellSubset: { mode: 'auto' } });
  const sample = reader.geneSampleOf('X');
  assert.ok(sample !== null && sample.cells < N_OBS, 'genes are read for a sample of the open cells');
  const cells = await openCells(reader);
  const first = await reader.getMatrixColumn('X', 0);
  for (let i = 0; i < sample.cells; i++) assert.equal(first[i], values[cells[i] * N_VARS], `gene 0, cell ${i}`);

  // Rows walked to make a run list of rows (`CellRows.runs`), from here on.
  let walked = 0;
  const runs = CellRows.prototype.runs;
  CellRows.prototype.runs = function countedRuns() {
    if (this._runs === null) walked += this.kept.length;
    return runs.call(this);
  };
  try {
    const sampleCells = Array.from({ length: sample.cells }, (_, i) => i);
    for (let gene = 1; gene < N_VARS; gene++) {
      const [sparseColumn] = await reader.getMatrixColumnsSparse('X', [gene]);
      const [column] = await reader.getMatrixColumns('X', [gene]);
      const block = await reader.getMatrixCellSubset('X', sampleCells, [gene]);
      let entries = 0;
      for (let i = 0; i < sample.cells; i++) {
        const value = values[cells[i] * N_VARS + gene];
        assert.equal(column[i], value, `gene ${gene}, cell ${i}`);
        if (value !== 0) entries++;
      }
      assert.equal(sparseColumn.indices.length, entries, `gene ${gene}: its entries on the sample`);
      assert.equal(block.values.length, entries, `gene ${gene}: its entries in the sample's cells`);
    }
  } finally {
    CellRows.prototype.runs = runs;
  }
  assert.equal(walked, 0, `${N_VARS - 1} genes read three ways walked ${walked} rows to check the sample's pointers (${sample.cells} rows a check)`);
});
