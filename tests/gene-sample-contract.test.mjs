/**
 * Large row-stored atlases open every cell the device holds; a gene is read
 * for a stated sample of them (`subsample-plan.js`, `geneSampleOf`).
 *
 * The map of an opening (positions, codes: a few bytes a cell) and a gene of
 * a matrix stored cell by cell (CSR, or dense in row chunks: the cell's whole
 * row read once) cost per cell on scales thousands apart, so one count can
 * not serve both: a CSR atlas over a link used to open as the few thousand
 * cells whose first gene read within the target. Now:
 *
 * - the map opens every cell the device holds (memory alone), in a priority
 *   order whose prefixes are samples: a file in its own order in its
 *   default `blocks` subsample's order (`cellOrder`);
 * - a gene is read for the first `genes.cells` open cells, as many as the
 *   one cost model reads within the gene-time target over the measured link,
 *   or as the gene index's memory holds; the others answer NaN (no value,
 *   never a zero), and no read of them is answered as zeros;
 * - growing the sample (Genes read for, in Session › Subsampling) reads only the rows it adds,
 *   in steps, keeps what it read when stopped, and every gene after it is
 *   read for the larger sample;
 * - a gene-major matrix, or a link fast enough, has no sample and the cells
 *   open in file order;
 * - the open cells read again keep their order and their sample.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { annData, countingStore, dataFrame, dense, mapping, sparse, strings } from './helpers/anndata-store.mjs';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';
import { GENE_READ_TARGET_MS, ORDER_OPENING_PASSES, geneIndexFit, orderOpeningMs, orderPays, resolveCellSubset, rowChunks } from '../assets/js/data/anndata/subsample-plan.js';
import { growthSegmentBounds } from '../assets/js/data/anndata/prefix-column-index.js';
import { priorityOrder, subsampleBlocks, subsampleUniform } from '../assets/js/data/subsample.js';
import { requestOfOpenCells } from '../assets/js/data/cell-subset-policy.js';
import { cellPriorityOf } from '../assets/js/data/cell-priority.js';
import { LinkMeter } from '../assets/js/formats/io/link.js';
import { LOCAL_POLICY, REMOTE_POLICY } from '../assets/js/formats/io/byte-source.js';
import { hostLinkSeed } from '../assets/js/data/host-link-memory.js';

const N_OBS = 6000;
const N_VARS = 40;

/** A CSR (or CSC) X of `N_OBS` cells in small chunks, and its dense values (cell-major). */
function atlas({ layout = 'csr' } = {}) {
  const random = createMulberry32(5);
  const values = new Float32Array(N_OBS * N_VARS);
  for (let cell = 0; cell < N_OBS; cell++) {
    for (let gene = 0; gene < N_VARS; gene++) {
      if (random() < 0.3) values[cell * N_VARS + gene] = Math.fround(1 + random() * 9);
    }
  }
  const data = [];
  const indices = [];
  const indptr = [0];
  const major = layout === 'csc' ? N_VARS : N_OBS;
  const minor = layout === 'csc' ? N_OBS : N_VARS;
  for (let i = 0; i < major; i++) {
    for (let j = 0; j < minor; j++) {
      const value = layout === 'csc' ? values[j * N_VARS + i] : values[i * N_VARS + j];
      if (value !== 0) {
        indices.push(j);
        data.push(value);
      }
    }
    indptr.push(data.length);
  }
  const X = sparse({ format: layout, data: Float32Array.from(data), indices: Int32Array.from(indices), indptr: Int32Array.from(indptr), shape: [N_OBS, N_VARS], compressed: true });
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

/** The stored values of a dense cell-major copy (its non-zeros). */
function entriesOf(values) {
  let entries = 0;
  for (let i = 0; i < values.length; i++) if (values[i] !== 0) entries++;
  return entries;
}

/** A measured link over which the whole matrix's first gene takes far past the target. */
function slowLink(bytesPerMs = 2) {
  const snapshot = { measured: true, latencyMs: 50, bytesPerMs, concurrency: 6, shapingConcurrency: 6, mergeGapBytes: 0, roundTripBytes: 100, readsAhead: false };
  return { readsAhead: false, mergeGapBytes: 0, roundTripBytes: 100, snapshot: () => snapshot, watchProtocol() {} };
}

/** Open cells' original positions, in open order. */
async function openCells(reader) {
  return Array.from(await reader.readObsNames(), name => Number(String(name).slice(1)));
}

function geneOf(values, gene) {
  return Float32Array.from({ length: N_OBS }, (_, cell) => values[cell * N_VARS + gene]);
}

test('a CSR atlas over a slow link opens every cell, in its default subsample\'s order, and reads genes for a stated sample', async () => {
  const { tree } = atlas();
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  const link = slowLink().snapshot();
  const context = { valuesOnDemand: true, decodedChunkBytes: 1e9, budgets: { allowanceBytes: 1e12, columnIndexBytes: 1e12 }, link, geneTargetMs: 2000 };
  const subset = await resolveCellSubset(root, { mode: 'auto' }, context);
  assert.equal(subset.kept, null, 'the map opens every cell');
  assert.equal(subset.autoFit, null, 'nothing about the map was fitted');
  assert.equal(subset.genes.of, N_OBS);
  assert.ok(subset.genes.cells > 1 && subset.genes.cells < N_OBS, `a gene sample (${subset.genes.cells})`);
  assert.equal(subset.genes.fit.limit, 'geneTime');
  assert.equal(subset.genes.fit.matrix, 'X');
  assert.equal(subset.genes.fit.layout, 'csr');
  assert.equal(subset.cellOrder.method, 'blocks');
  assert.equal(subset.ordered, true);
  // The sample of m cells is the default blocks subsample of m cells.
  const first = Array.from(subset.openOrder.subarray(0, subset.genes.cells)).sort((a, b) => a - b);
  assert.deepEqual(first, Array.from(subsampleBlocks(N_OBS, subset.genes.cells, subset.cellOrder.seed, subset.cellOrder.blockSize)));
  // A fast link: no sample, every cell in file order.
  const fast = await resolveCellSubset(root, { mode: 'auto' }, { ...context, link: { ...link, bytesPerMs: 1e9, latencyMs: 0 } });
  assert.equal(fast.genes, null);
  assert.equal(fast.cellOrder, null);
  assert.equal(fast.fileRows, null);
  // No link to price it (a local file, before it is read): no time fit.
  assert.equal((await resolveCellSubset(root, { mode: 'auto' }, { ...context, link: null })).genes, null);
  // 'all' opens every cell for the map too, and genes are still sampled.
  const all = await resolveCellSubset(root, { mode: 'all' }, context);
  assert.equal(all.kept, null);
  assert.equal(all.genes.cells, subset.genes.cells);
  // A person's 'all' for genes: every open cell's, no sample.
  assert.equal((await resolveCellSubset(root, { mode: 'all', genes: 'all' }, context)).genes, null);
  assert.equal(GENE_READ_TARGET_MS, 20_000);
});

test('every cell opens in its default subsample\'s order only when the sample brings the first gene sooner by more than the order costs', async () => {
  const { tree } = atlas();
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  const link = slowLink().snapshot();
  const context = { valuesOnDemand: true, decodedChunkBytes: 1e9, budgets: { allowanceBytes: 1e12, columnIndexBytes: 1e12 }, link, geneTargetMs: 2000 };
  const sampled = await resolveCellSubset(root, { mode: 'all' }, context);
  const { neededMs, sampleMs } = sampled.genes.fit;
  assert.ok(neededMs - sampleMs > 1000, `priced: every cell ${neededMs} ms, the sample ${sampleMs} ms`);
  assert.notEqual(sampled.cellOrder, null, 'a sample that saves seconds takes the order');
  // The rule: the priced saving against the order's measured cost. A
  // sample of 9.84M of 10M cells over a local web host (first gene priced
  // at about 4 s, the sample 64 ms sooner) against an order that cost the
  // opening about 150 ms: every cell opens in file order, its genes read
  // for every cell (as before samples).
  assert.equal(orderPays({ neededMs: 4000, sampleMs: 3936 }, 150), false);
  assert.equal(orderPays({ neededMs: 8000, sampleMs: 1000 }, 150), true);
  assert.equal(orderPays({ neededMs: Infinity, sampleMs: 1000 }, 150), false);
  // The cost is the opening's end to end: every pass over the open cells the
  // order adds (its copy in the reply, the page's check, the first view's
  // arrays gathered and scattered), each priced at the order's own making.
  // A saving larger than making the order but smaller than the opening's
  // passes does not pay.
  assert.equal(orderOpeningMs(11), ORDER_OPENING_PASSES * 11);
  assert.equal(orderPays({ neededMs: 4000, sampleMs: 3950 }, 11), true, 'the order made alone');
  assert.equal(orderPays({ neededMs: 4000, sampleMs: 3950 }, orderOpeningMs(11)), false, 'the opening end to end');
});

test('the gene index\'s memory bounds the gene sample, never the map', async () => {
  const { tree } = atlas();
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  // An index budget that holds about a tenth of the cells' entries.
  const fit = geneIndexFit(root, N_OBS, N_OBS, { valuesOnDemand: true, decodedChunkBytes: 1e9, columnIndexBytes: 30_000 });
  assert.equal(fit.limit, 'columnIndex');
  assert.ok(fit.cells > 0 && fit.cells < N_OBS);
  const subset = await resolveCellSubset(root, { mode: 'auto' }, { valuesOnDemand: true, decodedChunkBytes: 1e9, budgets: { allowanceBytes: 1e12, columnIndexBytes: 30_000 }, link: null });
  assert.equal(subset.kept, null, 'the map opens every cell');
  assert.equal(subset.autoFit, null);
  assert.equal(subset.genes.cells, fit.cells);
  assert.equal(subset.genes.fit.limit, 'columnIndex');
});

test('a gene-major matrix reads a gene for every open cell: no sample, file order', async () => {
  const { tree } = atlas({ layout: 'csc' });
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  const subset = await resolveCellSubset(root, { mode: 'auto' }, { valuesOnDemand: true, decodedChunkBytes: 1e9, budgets: { allowanceBytes: 1e12, columnIndexBytes: 1e12 }, link: slowLink().snapshot(), geneTargetMs: 2000 });
  assert.equal(subset.genes, null);
  assert.equal(subset.cellOrder, null);
  assert.equal(subset.fileRows, null);
});

test('a gene is read for the sample\'s cells: NaN on the others, and no read answers them as zeros (a cell named past it is read by its row)', async () => {
  const { tree, values } = atlas();
  const counting = countingStore(tree);
  const root = await openZarr(counting.store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'atlas.zarr', link: slowLink(), cellSubset: { mode: 'auto' } });
  const sample = reader.geneSample;
  assert.ok(sample !== null && sample.cells < N_OBS, 'a gene sample');
  const cells = await openCells(reader);
  assert.equal(cells.length, N_OBS);
  const gene = geneOf(values, 7);
  const column = await reader.getMatrixColumn('X', 7);
  for (let i = 0; i < N_OBS; i++) {
    if (i < sample.cells) assert.equal(column[i], gene[cells[i]], `open cell ${i}`);
    else assert.ok(Number.isNaN(column[i]), `open cell ${i} was not read`);
  }
  const rows = await reader.getMatrixColumn('X', 7, { rows: [sample.cells - 2, sample.cells + 2] });
  assert.equal(rows[0], gene[cells[sample.cells - 2]]);
  assert.ok(Number.isNaN(rows[2]) && Number.isNaN(rows[3]));
  // A cell past the sample, named by a caller, is read by its row: its own value, never a zero.
  const past = sample.cells + 3;
  const subsetRead = await reader.getMatrixCellSubset('X', [0, past], [7]);
  assert.equal(subsetRead.pointers.length, 2);
  const valueOf = (block, position) => {
    for (let e = block.pointers[0]; e < block.pointers[1]; e++) if (block.cellIndex[e] === position) return block.values[e];
    return 0;
  };
  assert.equal(valueOf(subsetRead, 0), gene[cells[0]]);
  assert.equal(valueOf(subsetRead, 1), gene[cells[past]]);
  const inSample = await reader.getMatrixCellSubset('X', [0, sample.cells - 1], [7]);
  assert.equal(valueOf(inSample, 1), gene[cells[sample.cells - 1]]);
  // The plan before a gene says what is read: the sample's cells.
  const plan = await reader.geneReadPlan('X');
  assert.deepEqual(plan.sample, { cells: sample.cells, of: N_OBS });
  assert.equal(plan.cells, sample.cells);
  // LOD ranks the cells one by one, not by block.
  assert.equal(cellPriorityOf(reader.cellSubset).seed, 0);
  assert.ok(cellPriorityOf(reader.cellSubset).originals instanceof Uint32Array);
});

test('reading genes for every cell is priced first, grows in steps that read only the rows they add, and every later gene is whole', async () => {
  const { tree, values } = atlas();
  const counting = countingStore(tree);
  const root = await openZarr(counting.store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'atlas.zarr', link: slowLink(), cellSubset: { mode: 'auto' } });
  const before = reader.geneSample.cells;
  await reader.getMatrixColumn('X', 3);
  const cost = await reader.geneSampleCost('X', N_OBS);
  assert.equal(cost.cells, before);
  assert.equal(cost.target, N_OBS);
  assert.ok(cost.bytes > 0 && cost.ms > 0 && cost.requests > 0, 'bytes, requests and time before it runs');
  assert.ok(['memory', 'disk'].includes(cost.index.placement));
  const steps = [];
  const fetchedBefore = counting.fetched.length;
  const grown = await reader.growGeneSample('X', N_OBS, { gene: 3, onStep: (sample, cells) => steps.push(cells) });
  assert.equal(grown, null, 'every open cell\'s genes are read');
  assert.equal(reader.geneSample, null);
  assert.ok(steps.length >= 1 && steps.at(-1) === N_OBS && steps.every((cells, i) => i === 0 || cells > steps[i - 1]));
  // Each step one of the doubling segments after the sample (`growthSegmentBounds`).
  assert.deepEqual(steps, growthSegmentBounds(before, N_OBS, entriesOf(values) / N_OBS));
  // The rows read before are not read again.
  const keys = counting.fetched.slice(fetchedBefore).filter(key => key.startsWith('X/indices/'));
  const earlier = new Set(counting.fetched.slice(0, fetchedBefore).filter(key => key.startsWith('X/indices/')));
  assert.equal(keys.filter(key => earlier.has(key)).length <= 1, true, 'at most the chunk the sample\'s last row shares');
  const cells = await openCells(reader);
  const gene = geneOf(values, 11);
  const column = await reader.getMatrixColumn('X', 11);
  for (let i = 0; i < N_OBS; i++) assert.equal(column[i], gene[cells[i]], `open cell ${i}`);
});

for (const [label, cellSubset] of [['every cell', { mode: 'auto' }], ['a uniform share', { mode: 'subsample', method: 'uniform', fraction: 0.5, seed: 4 }]]) {
test(`${label}: a later visit grown as far as an earlier one reads no byte of the rows the earlier growth kept`, async t => {
  const { opfsOnDisk } = await import('./helpers/opfs-on-disk.mjs');
  const { tree, values } = atlas();
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const identity = { kind: 'remote', key: 'host:atlas', version: `md5:${'1'.repeat(32)}:1` };
  const visit = async (request, grow) => {
    const counting = countingStore(tree);
    const root = await openZarr(counting.store, { decodedChunkCacheBytes: 0 });
    const reader = new AnnDataReader();
    await reader.open(root, { format: ZARR_FORMAT, name: 'atlas.zarr', link: slowLink(), cellSubset: request, keptIndexes: { identity, environment: disk.environment } });
    const sample = reader.geneSample;
    await reader.getMatrixColumn('X', 3);
    const before = counting.fetched.length;
    await reader.growGeneSample('X', grow(sample), { gene: 3 });
    const grownReads = counting.fetched.slice(before).filter(key => key.startsWith('X/indices/') || key.startsWith('X/data/'));
    const cells = await openCells(reader);
    const gene = geneOf(values, 5);
    const column = await reader.getMatrixColumn('X', 5);
    const rows = reader.geneSample?.cells ?? cells.length;
    for (let i = 0; i < rows; i++) assert.equal(column[i], gene[cells[i]], `${label}: open cell ${i}`);
    await reader.whenIndexesKept();
    const subset = reader.cellSubset;
    reader.close();
    return { sample, grownReads, rows, subset };
  };
  // The first visit grows its sample to three times its size; every segment is kept.
  const first = await visit(cellSubset, sample => sample.cells * 3);
  assert.ok(first.grownReads.length > 0, 'the first growth reads the matrix');
  // A later visit opens the first sample's cells (a count), then grows as far.
  const again = await visit({ ...requestOfOpenCells(first.subset), genes: first.sample.cells }, () => first.rows);
  assert.equal(again.sample.cells, first.sample.cells);
  assert.equal(again.rows, first.rows);
  assert.deepEqual(again.grownReads, [], `${label}: the growth takes the kept runs past the sample`);
});
}

test('a grown sample doubles from itself: its first step reads as many cells as its first gene did', () => {
  // A CELLxGENE-sized atlas, request-bound: 2,192 of 2,282,447 cells, about 1,700 values a cell.
  assert.deepEqual(growthSegmentBounds(2192, 2_282_447, 1700).slice(0, 3), [4384, 8768, 17536]);
  assert.equal(growthSegmentBounds(2192, 2_282_447, 1700).at(-1), 2_282_447);
  // At least one slab of the index's work (2^20 values) a step.
  assert.deepEqual(growthSegmentBounds(10, 5000, 1000), [10 + Math.ceil(2 ** 20 / 1000), 2118, 4236, 5000]);
  assert.deepEqual(growthSegmentBounds(500, 400, 1700), []);
});

test('a growth to some cells keeps them, one stopped keeps what it read, and the open cells read again keep their order and sample', async () => {
  const { tree, values } = atlas();
  const counting = countingStore(tree);
  const root = await openZarr(counting.store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'atlas.zarr', link: slowLink(), cellSubset: { mode: 'auto' } });
  const before = reader.geneSample.cells;
  const to = before + 100;
  const grown = await reader.growGeneSample('X', to, { gene: 0 });
  assert.equal(grown.cells, to);
  assert.equal(grown.of, N_OBS);
  assert.equal(grown.fit, null, 'a count a person chose');
  const cells = await openCells(reader);
  const gene = geneOf(values, 2);
  const column = await reader.getMatrixColumn('X', 2);
  assert.equal(column[to - 1], gene[cells[to - 1]]);
  assert.ok(Number.isNaN(column[to]));
  // Stopped before its first step is read: the sample is what it was.
  const stop = new AbortController();
  const growing = reader.growGeneSample('X', N_OBS, { gene: 0, signal: stop.signal });
  stop.abort(new DOMException('stopped', 'AbortError'));
  await assert.rejects(growing);
  assert.equal(reader.geneSample.cells, to);
  assert.ok(Number.isNaN((await reader.getMatrixColumn('X', 2))[to]), 'no segment past the sample is read for a gene');
  // The same cells again: the request names their order and their sample.
  const request = requestOfOpenCells(reader.cellSubset);
  assert.equal(request.mode, 'all');
  assert.deepEqual(request.order, reader.cellSubset.cellOrder);
  assert.equal(request.genes, to);
  const again = new AnnDataReader();
  await again.open(root, { format: ZARR_FORMAT, name: 'atlas.zarr', link: slowLink(), cellSubset: request, carry: reader });
  assert.deepEqual(Array.from(again.cellSubset.openOrder), Array.from(reader.cellSubset.openOrder));
  assert.equal(again.geneSample.cells, to);
  // Its genes come from the index the first opening built (nothing read again).
  const fetched = counting.fetched.length;
  const carried = await again.getMatrixColumn('X', 2);
  assert.equal(carried[to - 1], gene[cells[to - 1]]);
  assert.equal(counting.fetched.filter((key, i) => i >= fetched && key.startsWith('X/indices/')).length, 0);
});

test('every cell opened in its order for a fitted sample opens whole, keeping the sample: the same cells, and the gene time the page fills after the first gene', async () => {
  const { tree } = atlas();
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  const open = async (cellSubset, carry = null) => {
    const reader = new AnnDataReader();
    await reader.open(root, { format: ZARR_FORMAT, name: 'atlas.zarr', link: slowLink(), cellSubset, ...(carry === null ? {} : { carry }) });
    return reader;
  };
  const direct = await open({ mode: 'auto' });
  const sample = direct.geneSample;
  assert.equal(sample.fit?.limit, 'geneTime');
  // Showing a cell costs 1 ms, yet a growth would put every cell on the map
  // later than one reading (a round trip a step over the link the sample is
  // priced by): every cell opens whole, as in file order.
  const reader = await open({ mode: 'auto', progressive: { targetMs: 1, msPerCell: 1 } });
  assert.equal(reader.cellSubset.growth, null);
  assert.equal(reader.nObs, N_OBS);
  assert.equal(reader.geneSample.cells, sample.cells);
  assert.equal(reader.geneSample.fit?.limit, 'geneTime', 'still the sample the gene time sized (the page tops it up)');
  assert.equal(reader.geneSample.fit.budgetMs, sample.fit.budgetMs);
  assert.deepEqual(Array.from(reader.cellSubset.openOrder), Array.from(direct.cellSubset.openOrder));
  // The open cells read again keep it; a count chosen (a session's) has none.
  const request = requestOfOpenCells(reader.cellSubset);
  assert.deepEqual(request.genes, { cells: sample.cells, fit: reader.geneSample.fit });
  assert.equal((await open(request, reader)).geneSample.fit?.limit, 'geneTime');
  assert.equal((await open({ ...request, genes: sample.cells })).geneSample.fit, null);
  // A request's sample is 'all', a count or a fitted one, nothing else.
  await assert.rejects(open({ ...request, genes: { cells: 10 } }), /fitted sample/);
});

test('a share spread through a file in its own order opens in the file\'s cell order: its gene sample is its cells in every cell\'s first blocks, for no more bytes', async () => {
  const { tree } = atlas();
  const context = { valuesOnDemand: true, decodedChunkBytes: 1e9, budgets: { allowanceBytes: 1e12, columnIndexBytes: 1e12 }, link: slowLink(0.5).snapshot(), geneTargetMs: 2000 };
  const resolve = async request => resolveCellSubset(await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 }), request, context);
  const all = await resolve({ mode: 'all' });
  const order = all.cellOrder;
  assert.equal(order.method, 'blocks');
  const blockOf = cell => Math.floor(cell / order.blockSize);
  // The rank of each block in every cell's order (its first blocks first).
  const rank = new Map();
  for (const cell of all.openOrder) if (!rank.has(blockOf(cell))) rank.set(blockOf(cell), rank.size);
  for (const [request, fraction] of [
    [{ mode: 'subsample', method: 'uniform', k: 3000, seed: 3, strict: true }, 0.5],
    [{ mode: 'subsample', method: 'uniform', k: 600, seed: 3, strict: true }, 0.1],
    [{ mode: 'subsample', method: 'spatial', k: 600, seed: 9, strict: true }, 0.1],
  ]) {
    const share = await resolve(request);
    const what = `${request.method} ${request.k}`;
    // The cells are exactly the share's (sessions, links, Python and R).
    if (request.method === 'uniform') assert.deepEqual(Array.from(share.kept), Array.from(subsampleUniform(N_OBS, request.k, request.seed)), what);
    assert.deepEqual(share.cellOrder, order, `${what}: every cell's cell order`);
    assert.deepEqual(Array.from(share.openOrder), Array.from(priorityOrder({ method: 'blocks', seed: order.seed, blockSize: order.blockSize }, share.kept)), `${what}: its cells in that order`);
    assert.equal(share.ordered, true);
    // Its gene sample: its cells in the blocks every cell's order reads first.
    const sample = share.openOrder.subarray(0, share.genes.cells);
    const lastRank = Math.max(...Array.from(sample, cell => rank.get(blockOf(cell))));
    const inBlocks = Array.from(share.kept).filter(cell => rank.get(blockOf(cell)) < lastRank);
    for (const cell of inBlocks) assert.ok(sample.includes(cell), `${what}: cell ${cell} of a block before the sample's last is in it`);
    // At least its share of every cell's sample (in its own priority order
    // each of its first cells lay in a chunk of its own: 6 cells for both).
    assert.ok(share.genes.cells >= fraction * all.genes.cells, `${what}: ${share.genes.cells} cells against every cell's ${all.genes.cells}`);
  }
  // A blocks share keeps its own order; so does a share whose every cell is read.
  const blocks = await resolve({ mode: 'subsample', method: 'blocks', k: 600, seed: 3, strict: true });
  assert.equal(blocks.cellOrder, null);
  assert.deepEqual(Array.from(blocks.openOrder), Array.from(priorityOrder(blocks.spec, blocks.kept)));
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  const fast = await resolveCellSubset(root, { mode: 'subsample', method: 'uniform', k: 3000, seed: 3, strict: true }, { ...context, link: { ...context.link, bytesPerMs: 1e9, latencyMs: 0 } });
  assert.equal(fast.genes, null);
  assert.equal(fast.cellOrder, null);
  assert.deepEqual(Array.from(fast.openOrder), Array.from(priorityOrder(fast.spec, fast.kept)));
});

test('a share\'s first gene, counted at the store: no more stored bytes or reads than every cell\'s, for at least its share of every cell\'s cells', async () => {
  const { tree } = atlas();
  const firstGene = async cellSubset => {
    const counting = countingStore(tree);
    const reader = new AnnDataReader();
    await reader.open(await openZarr(counting.store, { decodedChunkCacheBytes: 0 }), { format: ZARR_FORMAT, name: 'atlas.zarr', link: slowLink(), cellSubset });
    const before = counting.reads.length;
    await reader.getMatrixColumn('X', 7);
    const reads = counting.reads.slice(before).filter(read => read.key.startsWith('X/'));
    const result = { cells: reader.geneSample?.cells ?? null, reads: reads.length, bytes: reads.reduce((sum, read) => sum + read.end - read.start, 0) };
    reader.close();
    return result;
  };
  const all = await firstGene({ mode: 'all' });
  assert.ok(all.cells < N_OBS, 'every cell: a sample');
  for (const fraction of [0.5, 0.1]) {
    const share = await firstGene({ mode: 'subsample', method: 'uniform', fraction, seed: 3 });
    assert.ok(share.bytes <= all.bytes && share.reads <= all.reads, `${fraction}: ${share.bytes} bytes in ${share.reads} reads, every cell's ${all.bytes} in ${all.reads}`);
    assert.ok(share.cells >= fraction * all.cells, `${fraction}: ${share.cells} cells, every cell's ${all.cells}`);
  }
});

test('a share in its cell order is read again, and grows by its first cells, in the same order with the same gene sample', async () => {
  const { tree } = atlas();
  const context = { valuesOnDemand: true, decodedChunkBytes: 1e9, budgets: { allowanceBytes: 1e12, columnIndexBytes: 1e12 }, link: slowLink(0.5).snapshot(), geneTargetMs: 2000 };
  const resolve = async (request, link = context.link) => resolveCellSubset(await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 }), request, { ...context, link });
  const share = await resolve({ mode: 'subsample', method: 'uniform', k: 3000, seed: 3, strict: true });
  // Read again: the order is named, so a link that would choose another rung changes nothing.
  const request = requestOfOpenCells(share);
  assert.deepEqual(request.order, share.cellOrder);
  const again = await resolve(request, { ...context.link, bytesPerMs: 50, latencyMs: 400 });
  assert.deepEqual(Array.from(again.openOrder), Array.from(share.openOrder));
  assert.equal(again.genes.cells, share.genes.cells);
  // A step of its growth: its first 1,000 cells, the same first cells and gene sample.
  const genes = { cells: share.genes.cells, fit: share.genes.fit };
  const step = await resolve({ mode: 'prefix', spec: share.spec, k: 1000, order: share.cellOrder, genes });
  assert.deepEqual(Array.from(step.openOrder), Array.from(share.openOrder.subarray(0, 1000)));
  assert.deepEqual(Array.from(step.kept), Array.from(share.openOrder.subarray(0, 1000)).sort((a, b) => a - b));
  assert.deepEqual(step.part, { cells: 1000, target: 3000 });
  assert.equal(step.reproduced, false);
  assert.equal(step.spec.k, 1000);
  assert.equal(step.genes.cells, share.genes.cells);
  // Read again (a session saved on it): exactly it, in the same order.
  const stepAgain = await resolve(requestOfOpenCells(step));
  assert.deepEqual(Array.from(stepAgain.openOrder), Array.from(step.openOrder));
  // Its levels of detail rank its cells one by one under its seed.
  assert.equal(cellPriorityOf(share).seed, 3);
  assert.deepEqual(cellPriorityOf(share).originals, share.openOrder);
  await assert.rejects(resolve({ mode: 'prefix', spec: share.spec, k: 3001, order: share.cellOrder }), /opens 2 to 3000/);
});

test('a share lowered and raised back reads genes for the sample the same cells were read for, in their order: never every cell unless a person read them', async () => {
  // The raise (Apply 100 %, `{mode: 'all'}`) names no sample: before, it was
  // fitted again over the link as measured then -- a 50M-cell store's sample
  // of 4.49M became every cell after a round trip (markers 15.4 → 62.3 s, a
  // reader worker of 8.7 GB), a 2M-cell `.h5ad` over an emulated 40 MB/s
  // link 1,690,543 → 352,680 cells in another block order.
  const { tree } = atlas();
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  const open = async (cellSubset, carry = null, link = slowLink()) => {
    const reader = new AnnDataReader();
    await reader.open(root, { format: ZARR_FORMAT, name: 'atlas.zarr', link, cellSubset, ...(carry === null ? {} : { carry }) });
    return reader;
  };
  // A link measured fast enough that a sample fitted again would be every cell.
  const fast = slowLink(1e6);
  assert.equal((await open({ mode: 'all' }, null, fast)).geneSample, null, 'the fast link alone fits every cell');
  const roundTrip = async first => {
    const lowered = await open({ mode: 'subsample', method: 'uniform', seed: 0, k: 600, strict: true }, first);
    return open({ mode: 'all' }, lowered, fast);
  };

  // Fitted to the gene time: the same count, fit, and order come back.
  const first = await open({ mode: 'auto' });
  const fitted = first.geneSample;
  assert.equal(fitted.fit?.limit, 'geneTime');
  const raised = await roundTrip(first);
  assert.equal(raised.geneSample.cells, fitted.cells);
  assert.deepEqual(raised.geneSample.fit, fitted.fit, 'the fit kept: the page tops it up as it did');
  assert.deepEqual(raised.cellSubset.cellOrder, first.cellSubset.cellOrder);
  assert.deepEqual(Array.from(raised.cellSubset.openOrder), Array.from(first.cellSubset.openOrder));

  // A link measured faster than the opening's fits more: the sample is fitted
  // again, never to fewer cells than were read (E-ANND-5: an opening sample
  // of 68 cells, sized on the link's first small reads, came back as 68).
  const lowered68 = await open({ mode: 'subsample', method: 'uniform', seed: 0, k: 600, strict: true }, first);
  const refitted = await open({ mode: 'all' }, lowered68, slowLink(8));
  assert.ok(refitted.geneSample.cells > fitted.cells && refitted.geneSample.cells < N_OBS, String(refitted.geneSample.cells));
  assert.equal(refitted.geneSample.fit?.limit, 'geneTime');
  assert.deepEqual(refitted.cellSubset.cellOrder, first.cellSubset.cellOrder, 'in the order the cells were read in');

  // Grown to fill the gene time (the page's top-up): its count, with the fit that sized it.
  const toppedUp = await open({ mode: 'auto' });
  const grown = await toppedUp.growGeneSample('X', fitted.cells + 100, { gene: 0, topUp: true });
  assert.equal(grown.cells, fitted.cells + 100);
  assert.deepEqual(grown.fit, fitted.fit);
  const raisedGrown = await roundTrip(toppedUp);
  assert.equal(raisedGrown.geneSample.cells, fitted.cells + 100);
  assert.equal(raisedGrown.geneSample.fit?.limit, 'geneTime');

  // A person's count stays theirs; a person's read of every open cell (Genes read for at 100 %) stays every cell, in its order.
  const chosen = await open({ mode: 'auto' });
  assert.equal((await chosen.growGeneSample('X', fitted.cells + 50, { gene: 0 })).fit, null);
  const raisedChosen = await roundTrip(chosen);
  assert.equal(raisedChosen.geneSample.cells, fitted.cells + 50);
  assert.equal(raisedChosen.geneSample.fit, null);
  const all = await open({ mode: 'auto' });
  assert.equal(await all.growGeneSample('X', N_OBS, { gene: 0 }), null);
  const raisedAll = await roundTrip(all);
  assert.equal(raisedAll.geneSample, null);
  assert.deepEqual(raisedAll.cellSubset.cellOrder, all.cellSubset.cellOrder);

  // The lowered share opened again is its own sample again too; a request naming a sample still wins.
  const lowered = await open({ mode: 'subsample', method: 'uniform', seed: 0, k: 600, strict: true }, first);
  const back = await open({ mode: 'subsample', method: 'uniform', seed: 0, k: 600, strict: true }, await open({ mode: 'all' }, lowered), fast);
  assert.equal(back.geneSample.cells, lowered.geneSample.cells);
  assert.equal(back.geneSample.fit?.limit, 'geneTime');
  assert.equal((await open({ mode: 'all', genes: 120 }, lowered, fast)).geneSample.cells, 120);
});

test('a share chosen after every cell was open is held to the sample every cell\'s first gene was fitted to, not one priced again', async () => {
  const { tree } = atlas();
  const root = await openZarr(countingStore(tree).store, { decodedChunkBytes: 0 });
  const context = { valuesOnDemand: true, decodedChunkBytes: 1e9, link: slowLink().snapshot(), targetMs: GENE_READ_TARGET_MS / 2, readOptions: {}, expression: 'X' };
  const cellOrder = { method: 'blocks', seed: 0, blockSize: 171 };
  // Its first gene fitted 1,000 cells then; priced again now it would be 214.
  const seen = { of: N_OBS, cellOrder, genes: { cells: 1200, of: N_OBS, fit: { cells: 1000, limit: 'geneTime' } } };
  const { firstGeneReadCost, prefixRowsOf, wholeSampleCost } = await import('../assets/js/data/anndata/subsample-plan.js');
  const ceiling = await wholeSampleCost(root, N_OBS, null, { ...context, seen });
  const read = (await firstGeneReadCost(root, N_OBS, { valuesOnDemand: true, decodedChunkBytes: 1e9 }))(prefixRowsOf(null, N_OBS, cellOrder)(1000));
  assert.deepEqual(ceiling, { bytes: read.bytes, requests: read.requests });
  // Every cell read in its gene time (or a person's count, no fit): priced as before.
  assert.notDeepEqual(await wholeSampleCost(root, N_OBS, null, { ...context, seen: { ...seen, genes: null } }), ceiling);
});

// ---------------------------------------------------------------- the page

import { cellsReadFor, fillUnread, geneSampleUse, maskReadFor } from '../assets/js/app/analysis/shared/gene-sample-cells.js';
import { describeOpenCellChoice } from '../assets/js/app/analysis/shared/open-cell-choice.js';
import { geneMomentsOf } from '../assets/js/app/analysis/compute/operation-handlers.js';
import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { collectViewFilters } from '../assets/js/app/state/managers/filter-manager.js';
import { decodeGeneSampleRecord, geneSampleDigest } from '../assets/js/app/session/cell-subset-record.js';
import { geneSampleCostText, geneSampleFacts, geneSampleText } from '../assets/js/data/gene-read-plan.js';

test('an analysis takes its cells below the gene sample, and a per-cell result is NaN past it', () => {
  const sample = { cells: 5, of: 10 };
  assert.deepEqual(Array.from(cellsReadFor(Uint32Array.of(1, 4, 5, 9), sample)), [1, 4]);
  const all = Uint32Array.of(0, 2);
  assert.equal(cellsReadFor(all, sample), all, 'every cell read: the same list');
  assert.equal(cellsReadFor(Uint32Array.of(1, 7), null).length, 2, 'no sample: every cell');
  const mask = Uint8Array.of(1, 0, 1, 1, 0, 1, 1, 0, 0, 1);
  assert.deepEqual(Array.from(maskReadFor(mask, sample)), [1, 0, 1, 1, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(mask).slice(5), [1, 1, 0, 0, 1], 'the mask itself is not written');
  const scores = fillUnread(new Float32Array(10).fill(1), sample);
  assert.ok(scores.slice(0, 5).every(value => value === 1) && scores.slice(5).every(Number.isNaN));
  assert.deepEqual(geneSampleUse(sample, [{ name: 'A', used: 2, of: 4 }]), { cells: 5, of: 10, groups: [{ name: 'A', used: 2, of: 4 }] });
  assert.equal(geneSampleUse(null), null);
});

test('a gene\'s moments are over the cells it is read for: no entry past them is a zero', () => {
  // Cells 0-3 read: values 2, 0, 4, 0; cells 4-9 not read (no entry).
  const sparse = { length: 10, indices: Uint32Array.of(0, 2), values: Float32Array.of(2, 4) };
  const over = geneMomentsOf(sparse, 4);
  assert.equal(over.n, 4);
  assert.equal(over.mean, 1.5);
  assert.equal(geneMomentsOf(sparse).mean, 0.6, 'over every cell, the absent entries would be zeros');
  // A dense column NaN past the sample gives the same.
  const dense = Float32Array.of(2, 0, 4, 0, NaN, NaN, NaN, NaN, NaN, NaN);
  assert.deepEqual(geneMomentsOf(dense, 4), over);
  assert.deepEqual(geneMomentsOf(dense), over);
});

test('differential expression tests each group\'s cells among the gene sample, and says so', async () => {
  const analysis = new MultiVariableAnalysis({
    state: { pointCount: 10 },
    geneCellsOf: async () => ({ cells: 6, of: 10 }),
    resolveExpressionMatrix: () => ({ matrix: 'X', read: null, label: 'Mapped (X)' }),
    getGeneKeys: async () => [],
  });
  const groups = { groupA: { name: 'A', cells: Uint32Array.of(0, 1, 7) }, groupB: { name: 'B', cells: Uint32Array.of(2, 3, 8, 9) } };
  // Group A keeps 2 cells, B 2: past the checks, to the genes (none here).
  await assert.rejects(analysis.differentialExpression({ ...groups, requestOwnership: { isCurrent: () => true } }), /No genes available/);
  // A group with one cell among the sample is refused, naming how many it has.
  await assert.rejects(
    analysis.differentialExpression({ groupA: { name: 'A', cells: Uint32Array.of(0, 6, 7) }, groupB: groups.groupB, requestOwnership: { isCurrent: () => true } }),
    /"A" has 1 of its 3 cells among the first 6 open cells, those genes are read for/
  );
});

test('the chip names the gene sample, with each group\'s share', () => {
  const whole = createCellIdentity({ nObs: 455_000 });
  assert.equal(describeOpenCellChoice(whole), null);
  const genes = { cells: 40_000, of: 455_000, groups: [{ name: 'B cells', used: 3_100, of: 35_000 }] };
  const choice = describeOpenCellChoice(whole, { genes });
  // Every cell open: no chip of its own; the gene sample's line, compact (one line at the narrowest panel).
  assert.equal(choice.text, null);
  assert.equal(choice.method, 'genes');
  assert.equal(choice.genes.text, 'Genes read for 40K of 455K cells');
  assert.match(choice.genes.detail, /^Genes are read for 40,000 of the 455,000 open cells/);
  assert.match(choice.genes.detail, /B cells: 3,100 of 35,000/);
  assert.match(choice.genes.detail, /which is not 0/);
  assert.match(choice.genes.detail, /Read genes for more cells in Session › Subsampling: Genes read for, then run it again\.$/);
  // A subsample: its chip, and the gene sample's line beside it.
  const share = createCellIdentity({ nObs: 455_000, kept: Uint32Array.from({ length: 1000 }, (_, i) => i * 10), choice: { spec: { method: 'uniform', nObs: 455_000, k: 1000, seed: 0 }, chunked: false } });
  const both = describeOpenCellChoice(share, { genes: { cells: 400, of: 1000, groups: [] } });
  assert.match(both.text, /uniform/);
  assert.equal(both.representative, false);
  assert.equal(both.genes.text, 'Genes read for 400 of 1K cells');
});

test('a gene\'s range filter is listed with the cells it keeps for not being read', () => {
  const gene = { key: 'CD3E', kind: 'continuous', values: new Float32Array(3), _continuousStats: { min: 0, max: 5 }, _continuousFilter: { min: 1, max: 5 }, _filterEnabled: true };
  const view = { obsData: { fields: [] }, varData: { fields: [gene] } };
  assert.equal(collectViewFilters(view, { geneSampled: true }).at(-1).text, 'CD3E: 1 – 5, cells not read kept');
  assert.equal(collectViewFilters(view).at(-1).text, 'CD3E: 1 – 5');
});

test('the gene sample is said in one sentence, its facts and its cost', () => {
  assert.equal(geneSampleText({ cells: 40_000, of: 2_282_447 }), 'Gene read for 40,000 of 2,282,447 cells');
  assert.equal(geneSampleText({ cells: 40_000, of: 2_282_447 }, { plural: true }), 'Genes read for 40,000 of 2,282,447 cells');
  assert.equal(geneSampleCostText({ bytes: 1.6e9, ms: 630_000 }), '1.5 GB, ~10 min 30 s');
  assert.equal(geneSampleCostText({ bytes: 0, ms: 0 }), 'kept here, nothing to download');
  // Beside the action, in the narrowest panel: the time in its largest unit (the full HLCA's cost).
  assert.equal(geneSampleCostText({ bytes: 9_817_766_646, ms: 4_514_526 }, { compact: true }), '9.1 GB, ~1.3 h');
  assert.equal(geneSampleCostText({ bytes: 1.6e9, ms: 630_000 }, { compact: true }), '1.5 GB, ~11 min');
  assert.equal(geneSampleCostText({ bytes: 1.6e9, ms: 19_400 }, { compact: true }), '1.5 GB, ~20 s');
  assert.equal(geneSampleCostText({ bytes: 0, ms: 0 }, { compact: true }), 'kept here');
  assert.deepEqual(geneSampleFacts(null), []);
  assert.deepEqual(geneSampleFacts({ cells: 9, of: 10, fit: null }).map(row => row.label), ['Genes read', 'Sized to']);
});

test('a session records the gene sample as the cells it is, and refuses one out of its contract', () => {
  const identity = createCellIdentity({ nObs: 10, kept: null, openOrder: Uint32Array.of(5, 6, 0, 1, 2, 3, 4, 7, 8, 9) });
  const digest = geneSampleDigest(identity, 3);
  assert.equal(digest, geneSampleDigest(createCellIdentity({ nObs: 10, kept: null, openOrder: Uint32Array.of(0, 5, 6, 1, 2, 3, 4, 7, 8, 9) }), 3), 'the cells, in any order');
  const record = { cells: 3, order: { method: 'blocks', seed: 0, blockSize: 5 }, digest };
  assert.deepEqual(decodeGeneSampleRecord(record, 10, 'genes'), record);
  assert.throws(() => decodeGeneSampleRecord({ ...record, cells: 10 }, 10, 'genes'), /cells must be a count of open cells from 1 to 9/);
  assert.throws(() => decodeGeneSampleRecord({ ...record, extra: 1 }, 10, 'genes'), TypeError);
  assert.throws(() => decodeGeneSampleRecord({ ...record, order: { method: 'uniform', seed: 0, blockSize: 5 } }, 10, 'genes'), /cell order/);
  assert.throws(() => decodeGeneSampleRecord({ ...record, digest: 'x' }, 10, 'genes'), /digest/);
});

test('a figure of a gene read for a sample says so under its colour bar', async () => {
  const { buildColorScaleNote } = await import('../assets/js/app/ui/modules/figure-export/components/legend-builder.js');
  // Gray for zero off (the default): the faded cells only.
  assert.equal(buildColorScaleNote({ geneSample: { cells: 40_000, of: 455_000 }, zeroGray: { enabled: false, applies: true, drawn: false } }, 0, 1), 'Gene read for 40,000 of 455,000 cells. Faded: not read');
  // On (or a log scale): the gray for 0 too.
  assert.equal(buildColorScaleNote({ geneSample: { cells: 40_000, of: 455_000 }, zeroGray: { enabled: true, applies: true, drawn: true } }, 0, 1), 'Gene read for 40,000 of 455,000 cells. Faded: not read · gray: 0');
  assert.equal(buildColorScaleNote({ geneSample: { cells: 40_000, of: 455_000 }, colorbar: { centered: true } }, -1, 1), 'Color scale centred at 0 · Gene read for 40,000 of 455,000 cells. Faded: not read');
  assert.equal(buildColorScaleNote({ geneSample: null }, 0, 1), null);
  // Every cell read, gray for zero on: the figure says what gray is.
  assert.equal(buildColorScaleNote({ geneSample: null, zeroGray: { enabled: true, applies: true, drawn: true } }, 0, 1), 'Gray: 0');
  assert.equal(buildColorScaleNote({ geneSample: null, zeroGray: { enabled: true, applies: false, drawn: false } }, 0, 1), null);
});

test('a later visit keeps the cell order a gene index was kept under, even when every cell\'s genes now fit', async () => {
  const { tree } = atlas();
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  const context = { valuesOnDemand: true, decodedChunkBytes: 1e9, budgets: { allowanceBytes: 1e12, columnIndexBytes: 1e12 }, link: slowLink(2).snapshot(), geneTargetMs: 2000 };
  // Every cell's index kept under the blocks order (a visit that read genes for all cells).
  const kept = await resolveCellSubset(root, { mode: 'auto' }, { ...context, keptIndexRows: async spec => ({ rows: spec?.method === 'blocks' ? N_OBS : 0, values: true }) });
  assert.equal(kept.genes, null, 'every open cell\'s genes are read');
  assert.equal(kept.cellOrder?.method, 'blocks', 'in the order the index is kept under, so it counts');
  assert.equal(kept.ordered, true);
  // Nothing kept and a fast link: file order.
  const fresh = await resolveCellSubset(root, { mode: 'auto' }, { ...context, link: { ...context.link, bytesPerMs: 1e9, latencyMs: 0 } });
  assert.equal(fresh.cellOrder, null);
});

test('the first gene of a CSR matrix in compressed chunks is priced with its values: they are read in whole chunks', async () => {
  const { firstGeneReadCost } = await import('../assets/js/data/anndata/subsample-plan.js');
  const { tree } = atlas();
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  const rows = Uint32Array.from({ length: 600 }, (_, i) => i);
  const onDemand = (await firstGeneReadCost(root, N_OBS, { valuesOnDemand: true, decodedChunkBytes: 1e9 }))(rows);
  const withValues = (await firstGeneReadCost(root, N_OBS, { valuesOnDemand: false, decodedChunkBytes: 1e9 }))(rows);
  assert.equal(onDemand.bytes, withValues.bytes, 'compressed values cost the first gene as much as when read with the index');
});

test('a raw CSR matrix over a slow link has a gene sample, said before any gene is read: what this browser holds of it is told per stored chunk, not per element', async t => {
  // A `.zarr.zip` stored uncompressed (`partialChunks`: a read fetches only
  // its rows' bytes, priced per element) whose stored chunks hold every
  // cell: the page holds none of them at open. Its held-chunk predicate
  // (`heldChunkBands`) names stored chunks; read as elements, every element
  // past the first chunk's index looked held, the first gene was priced at
  // a few bytes, and the atlas opened with no sample (the first gene then
  // read every cell's row over the slow link).
  await import('./helpers/anndata-reader-in-process.mjs');
  const { anndataZarrZip } = await import('./browser/helpers/anndata-zarr-zip.mjs');
  const { AnnDataFileSource } = await import('../assets/js/data/anndata-file-source.js');
  const CELLS = 2400;
  const GENES = 1500;
  const PER_CELL = 1200;
  const data = new Float32Array(CELLS * PER_CELL);
  const indices = new Int32Array(CELLS * PER_CELL);
  const indptr = new Int32Array(CELLS + 1);
  for (let cell = 0; cell < CELLS; cell++) {
    for (let j = 0; j < PER_CELL; j++) {
      indices[cell * PER_CELL + j] = (cell + j) % GENES;
      data[cell * PER_CELL + j] = 1 + ((cell * 7 + j) % 13);
    }
    indices.subarray(cell * PER_CELL, (cell + 1) * PER_CELL).sort();
    indptr[cell + 1] = (cell + 1) * PER_CELL;
  }
  const bytes = anndataZarrZip({
    cells: CELLS,
    genes: Array.from({ length: GENES }, (_, g) => `g${g}`),
    X: { data, indices, indptr },
    obsm: { X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, i) => Math.sin(i) * 10), columns: 2 } },
  });
  // One shared link: 40 ms a round trip, 400 bytes a millisecond.
  const original = globalThis.fetch;
  let free = 0;
  globalThis.fetch = async (input, init = {}) => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(new Headers(init.headers ?? {}).get('Range') ?? '');
    const start = match === null ? 0 : Number(match[1]);
    const end = match === null || match[2] === '' ? bytes.length - 1 : Math.min(Number(match[2]), bytes.length - 1);
    const at = Math.max(performance.now() + 40, free) + (end + 1 - start) / 400;
    free = at;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, at - performance.now())));
    const headers = { ETag: '"raw-v1"', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1) };
    return new Response(bytes.slice(start, end + 1), { status: match === null ? 200 : 206, headers });
  };
  const { log, info, debug } = console;
  Object.assign(console, { log: () => {}, info: () => {}, debug: () => {} });
  const source = new AnnDataFileSource();
  t.after(() => {
    source.clear();
    globalThis.fetch = original;
    Object.assign(console, { log, info, debug });
  });
  await source.loadFile({ url: 'https://host.test/raw.zarr.zip', size: bytes.length, name: 'raw.zarr.zip', identity: Object.freeze({ kind: 'remote', key: 'url:raw', version: 'etag:"raw-v1"' }) });
  const subset = source.getCellSubset();
  assert.equal(subset.kept, null, 'every cell open');
  assert.equal(subset.genes?.fit?.limit, 'geneTime');
  assert.ok(subset.genes.cells > 1 && subset.genes.cells < CELLS, `a sample of the cells: ${subset.genes.cells}`);
  assert.equal(subset.genes.fit.kept, null, 'nothing of the matrix is held at open');
  // Said before any gene (or row pointer) is read: the page shows it at open
  // and every analysis asks it first (the open cells' view of the matrix
  // has its shape, not its arrays, until their pointers are read).
  assert.deepEqual(await source._loader.geneSampleOf('X'), { cells: subset.genes.cells, of: CELLS });
});

test('held stored chunks of a raw array part its elements by chunk', () => {
  // Rows of 10 elements in stored chunks of 100 elements (10 rows), priced per element.
  const held = band => band === 1;
  const rows = Uint32Array.from({ length: 30 }, (_, i) => i);
  assert.deepEqual(rowChunks(rows, row => row * 10, 1, 0, held, 100), { chunks: 200, runs: 2, kept: 100, gaps: 0 });
  // Rows 5..14: half of chunk 0, half of chunk 1 (held).
  assert.deepEqual(rowChunks(Uint32Array.from({ length: 10 }, (_, i) => 5 + i), row => row * 10, 1, 0, held, 100), { chunks: 50, runs: 1, kept: 50, gaps: 0 });
  // Nothing held: one span, whatever its length.
  assert.deepEqual(rowChunks(rows, row => row * 10, 1, 0, null, 100), { chunks: 300, runs: 1, kept: 0, gaps: 0 });
});

test('scattered rows are priced with the gaps the reader fetches through: their bytes, no request, never across a held chunk', () => {
  // Rows 0 and 30 of one element each, in stored chunks of 10: chunks 0 and 3, two chunks apart.
  const rows = Uint32Array.of(0, 30);
  assert.deepEqual(rowChunks(rows, row => row, 10), { chunks: 2, runs: 2, kept: 0, gaps: 0 });
  assert.deepEqual(rowChunks(rows, row => row, 10, 0, null, 1, null, 1), { chunks: 2, runs: 2, kept: 0, gaps: 0 }, 'a gap wider than the merge gap is another request');
  assert.deepEqual(rowChunks(rows, row => row, 10, 0, null, 1, null, 2), { chunks: 4, runs: 1, kept: 0, gaps: 2 }, 'a gap within it is fetched');
  // A held chunk between them: read from this machine, never fetched through.
  assert.deepEqual(rowChunks(Uint32Array.of(0, 10, 30), row => row, 10, 0, chunk => chunk === 1, 1, null, 2), { chunks: 2, runs: 2, kept: 1, gaps: 0 });
});

test('when the gene index of every open cell is kept nowhere here, its cost names the most cells it is kept for', async () => {
  const { tree } = atlas();
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'atlas.zarr', link: slowLink(), cellSubset: { mode: 'auto' } });
  const sample = reader.geneSample.cells;
  const every = await reader.geneSampleCost('X', N_OBS);
  assert.equal(every.index.refusal, null);
  assert.equal(every.index.fits, N_OBS, 'every open cell, when its index is kept');
  // Room for half of it: memory and storage both refuse the rest.
  const room = every.index.residentBytes / 2;
  const factory = reader.columnStoreFactory;
  const plan = factory.plan.bind(factory);
  reader.columnStoreFactory = { ...factory, plan: async bytes => (bytes > room ? { kind: null, refusal: 'no room in this test' } : plan(bytes)) };
  const capped = await reader.geneSampleCost('X', N_OBS);
  assert.equal(capped.index.refusal, 'no room in this test');
  assert.ok(capped.index.fits > sample && capped.index.fits < N_OBS, `between the sample and every cell: ${capped.index.fits}`);
  const at = await reader.geneSampleCost('X', capped.index.fits);
  assert.equal(at.index.refusal, null, 'the most cells it fits is kept');
  assert.notEqual((await reader.geneSampleCost('X', capped.index.fits + 1)).index.refusal, null, 'one more is not');
});

test('genes read for more cells reach every kept view: its values, its statistics, and its colours once focused', async () => {
  const { DataState } = await import('../assets/js/app/state/core/data-state.js');
  const { createInMemoryDimensionManager } = await import('../assets/js/data/dimension-manager.js');
  const state = new DataState(null, null);
  state.viewer = new Proxy({ getViewLayout: () => ({ mode: 'grid' }) }, { get: (target, key) => (Object.hasOwn(target, key) ? target[key] : () => {}) });
  state.pointCount = 2;
  state.dimensionManager = createInMemoryDimensionManager({ positions: new Float32Array(4), dimension: 2 });
  state.activeDimensionLevel = 2;
  state.cellVisibilityMask = new Uint8Array([1, 1]);
  state.categoryTransparency = new Uint8Array([1, 1]);
  state.colorsArray = new Uint8Array(8);
  state.obsData = { fields: [] };
  // A gene read for the first open cell of two (the second NaN: not read).
  const descriptor = { key: 'g', kind: 'continuous', path: 'var/g' };
  state._varFieldDescriptors = [descriptor];
  state.varData = { fields: [{ ...descriptor, loaded: true, values: Float32Array.of(2, NaN) }] };
  state.varFieldLoader = { readRows: async () => Float32Array.of(5), geneSampleOf: async () => null, geneSample: () => null };
  state.setActiveVarField(0);
  state._resetViewContexts();
  state.createViewFromSource('live', 'snap_1');
  state.dimensionManager.copyViewLayout('live', 'snap_1');
  const kept = state.viewContexts.get('snap_1');
  const neutral = (colors, cell) => colors[cell * 4 + 3] === 254;
  assert.ok(neutral(kept.colorsArray, 1), 'the kept view draws the cell not read neutral');
  // Read for the second cell too (a growth step).
  await state._fillGeneRows(1, 2);
  assert.deepEqual(Array.from(kept.varData.fields[0].values), [2, 5], 'the kept view holds the values read');
  assert.equal(kept.varData.fields[0].values, state.varData.fields[0].values, 'one array, never written in place');
  assert.deepEqual(kept.varData.fields[0]._continuousStats, { min: 2, max: 5 });
  state.setActiveView('snap_1');
  assert.ok(!neutral(state.colorsArray, 1), 'focused, the kept view draws the cell read');
  assert.equal(kept.geneValuesRead, false);
});

test('the gene sample is sized by the link or by decoding its chunks here, whichever takes longer', async () => {
  const { tree } = atlas();
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  const fast = { ...slowLink(2).snapshot(), bytesPerMs: 1e9, latencyMs: 0 };
  const context = { valuesOnDemand: true, decodedChunkBytes: 1e9, budgets: { allowanceBytes: 1e12, columnIndexBytes: 1e12 }, link: fast, geneTargetMs: 2000 };
  // A link fast enough and decoding as fast: every cell's genes are read.
  const quick = await resolveCellSubset(root, { mode: 'auto' }, { ...context, decodeBytesPerMs: 1e9 });
  assert.equal(quick.genes, null);
  // The same link where chunks decode at 10 bytes a millisecond: decoding binds, and sizes the sample.
  const slow = await resolveCellSubset(root, { mode: 'auto' }, { ...context, decodeBytesPerMs: 10 });
  assert.equal(slow.genes?.fit?.limit, 'geneTime');
  assert.ok(slow.genes.cells > 1 && slow.genes.cells < N_OBS, `a sample: ${slow.genes?.cells}`);
  // No decode measured yet: the link's time alone.
  assert.equal((await resolveCellSubset(root, { mode: 'auto' }, { ...context, decodeBytesPerMs: null })).genes, null);
});

test('a later visit is priced by what it still reads: the kept rows\' values when the kept index lacks them, within the target', async () => {
  const { firstGeneReadCost, geneReadMs } = await import('../assets/js/data/anndata/subsample-plan.js');
  const { tree } = atlas();
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  // A remembered fast link (the earlier visit's large reads), as a revisit prices with.
  const link = { ...slowLink(40).snapshot(), remembered: true };
  const context = { valuesOnDemand: true, decodedChunkBytes: 1e9, budgets: { allowanceBytes: 1e12, columnIndexBytes: 1e12 }, link, geneTargetMs: 2000, decodeBytesPerMs: null };
  const first = await resolveCellSubset(root, { mode: 'auto' }, context);
  assert.ok(first.genes !== null, 'a sample on the first visit');
  const indexed = first.genes.cells;
  // The earlier visit kept the gene index of its sample: with the values, and without them.
  const withValues = await resolveCellSubset(root, { mode: 'auto' }, { ...context, keptIndexRows: async () => ({ rows: indexed, values: true }) });
  const positionsOnly = await resolveCellSubset(root, { mode: 'auto' }, { ...context, keptIndexRows: async () => ({ rows: indexed, values: false }) });
  // The first gene answers from the kept cells; the count the target
  // prices (`growTo`) is what the top-up reads next.
  assert.equal(withValues.genes?.cells, indexed, 'kept values: the first gene reads the kept cells alone');
  assert.equal(withValues.genes.fit.bytes, 0, 'kept values: the kept cells cost nothing');
  assert.ok(withValues.genes.fit.growTo > indexed, `kept values: more cells priced within the target (${withValues.genes.fit.growTo})`);
  const pricedOf = opened => opened.genes?.fit?.growTo ?? opened.genes?.cells ?? N_OBS;
  assert.ok(positionsOnly.genes !== null && pricedOf(positionsOnly) < pricedOf(withValues), 'kept positions alone: the kept cells still cost their values');
  // The sample it chose, priced in full (the kept cells' values and the rest), lands within the target.
  const cost = await firstGeneReadCost(root, N_OBS, { valuesOnDemand: true, decodedChunkBytes: 1e9 });
  const order = positionsOnly.cellOrder;
  const rowsOf = k => (k >= N_OBS ? Uint32Array.from({ length: N_OBS }, (_, i) => i) : subsampleBlocks(N_OBS, k, order.seed, order.blockSize));
  const ordered = priorityOrder({ ...order, nObs: N_OBS, k: positionsOnly.genes.cells }, rowsOf(positionsOnly.genes.cells));
  const rest = cost(ordered.slice(indexed).sort());
  const values = cost.values(ordered.slice(0, indexed).sort());
  assert.ok(values.bytes > 0 && values.requests > 0, 'the kept cells\' value chunks are read');
  const ms = geneReadMs({ bytes: rest.bytes + values.bytes, requests: rest.requests + values.requests }, link, null);
  assert.ok(ms <= context.geneTargetMs, `priced at ${Math.round(ms)} ms, within ${context.geneTargetMs} ms`);
});

test('the cells open in blocks sized from the link and the layout: the storage block doubled until a block fills its round trip', async () => {
  const { defaultBlockSize, firstGeneReadCost } = await import('../assets/js/data/anndata/subsample-plan.js');
  const { tree } = atlas();
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  const base = defaultBlockSize(root, N_OBS);
  const context = { valuesOnDemand: true, decodedChunkBytes: 1e9, budgets: { allowanceBytes: 1e12, columnIndexBytes: 1e12 }, decodeBytesPerMs: null };
  // A link whose round trip is worth few bytes: blocks of the storage.
  const thin = { ...slowLink(2).snapshot(), latencyMs: 50, bytesPerMs: 2 };
  const near = await resolveCellSubset(root, { mode: 'auto' }, { ...context, link: thin, geneTargetMs: 20_000 });
  assert.equal(near.cellOrder?.blockSize, base);
  // A link whose round trip is worth a megabyte: blocks large enough that bytes, not round trips, bind.
  const far = { ...slowLink(2).snapshot(), latencyMs: 400, bytesPerMs: 2500 };
  const opened = await resolveCellSubset(root, { mode: 'auto' }, { ...context, link: far, geneTargetMs: 200 });
  const size = opened.cellOrder?.blockSize;
  assert.ok(size > base && Number.isInteger(Math.log2(size / base)), `a power-of-two multiple of the storage block: ${size} of ${base}`);
  const cost = await firstGeneReadCost(root, N_OBS, { valuesOnDemand: true, decodedChunkBytes: 1e9 });
  const running = far.shapingConcurrency;
  const needed = rows => cost(Uint32Array.from({ length: rows }, (_, i) => Math.floor(N_OBS / 2) + i)).requests * far.latencyMs * far.bytesPerMs / (running * cost.bytesPerRow);
  assert.ok(size >= needed(base) || size * 2 > N_OBS, 'its bytes fill its round trips');
  assert.ok(size / 2 < needed(base), 'and half of it would not');
  // A gene index kept here under any rung of the ladder: that rung, whatever
  // the link says now (a revisit opens the cells it read before).
  for (const keptAt of [size / 2, base, ...(size * 2 <= N_OBS ? [size * 2] : [])]) {
    const kept = await resolveCellSubset(root, { mode: 'auto' }, { ...context, link: far, geneTargetMs: 200, keptIndexRows: async order => ({ rows: order?.blockSize === keptAt ? 100 : 0, values: true }) });
    assert.equal(kept.cellOrder?.blockSize, keptAt);
  }
  // Of several kept, the one holding the most cells.
  const most = await resolveCellSubset(root, { mode: 'auto' }, { ...context, link: far, geneTargetMs: 200, keptIndexRows: async order => ({ rows: order?.blockSize === base ? 100 : order?.blockSize === base * 4 ? 300 : 0, values: true }) });
  assert.equal(most.cellOrder?.blockSize, base * 4);
});

test('a first visit sizes its blocks at what the link can deliver: the opening\'s rate is a lower bound, raised by the host\'s remembered rate or this browser\'s downlink', async () => {
  const { blockSizeLadder } = await import('../assets/js/data/anndata/subsample-plan.js');
  const { tree } = atlas();
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  const ladder = blockSizeLadder(root, N_OBS);
  assert.ok(ladder.every((size, i) => i === 0 || size === ladder[i - 1] * 2) && ladder.at(-1) * 2 > N_OBS, `one ladder of doublings: ${ladder}`);
  const context = { valuesOnDemand: true, decodedChunkBytes: 1e9, budgets: { allowanceBytes: 1e12, columnIndexBytes: 1e12 }, decodeBytesPerMs: null, geneTargetMs: 200 };
  // The opening's structure reads measured little (a lower bound, no delivery filled the link).
  const opened = { ...slowLink(2).snapshot(), latencyMs: 400, bytesPerMs: 2, bandwidthMeasured: false };
  const unseeded = await resolveCellSubset(root, { mode: 'auto' }, { ...context, link: opened });
  assert.equal(unseeded.cellOrder.blockSize, ladder[0]);
  const seeded = await resolveCellSubset(root, { mode: 'auto' }, { ...context, link: opened, seedBytesPerMs: 2500 });
  assert.ok(seeded.cellOrder.blockSize > ladder[0] && ladder.includes(seeded.cellOrder.blockSize), `the downlink raises the rung: ${seeded.cellOrder.blockSize}`);
  // A link whose rate is above the seed: the link's.
  const fast = await resolveCellSubset(root, { mode: 'auto' }, { ...context, link: { ...opened, bytesPerMs: 2500, bandwidthMeasured: true }, seedBytesPerMs: 2 });
  assert.equal(fast.cellOrder.blockSize, seeded.cellOrder.blockSize);
  // A `blocks` subsample nobody sized takes the same rung, recorded in its spec; a size asked for stays.
  const share = await resolveCellSubset(root, { mode: 'subsample', method: 'blocks', fraction: 0.1 }, { ...context, link: opened, seedBytesPerMs: 2500 });
  assert.equal(share.spec.blockSize, seeded.cellOrder.blockSize);
  const asked = await resolveCellSubset(root, { mode: 'subsample', method: 'blocks', fraction: 0.1, blockSize: 7 }, { ...context, link: opened, seedBytesPerMs: 2500 });
  assert.equal(asked.spec.blockSize, 7);
  // A share's blocks revisited: the rung its kept gene index is filed under (its seed's order).
  const keptRung = ladder[1];
  const revisit = await resolveCellSubset(root, { mode: 'subsample', method: 'blocks', fraction: 0.1, seed: 5 }, {
    ...context,
    link: opened,
    seedBytesPerMs: 2500,
    keptIndexRows: async order => ({ rows: order?.seed === 5 && order?.blockSize === keptRung ? 50 : 0, values: true }),
  });
  assert.equal(revisit.spec.blockSize, keptRung);
});

test('a later visit takes the kept runs ending within its sample: a run reaching past it is read again, and priced so', async () => {
  const { tree } = atlas();
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  const link = slowLink(2).snapshot();
  const context = { valuesOnDemand: true, decodedChunkBytes: 1e9, budgets: { allowanceBytes: 1e12, columnIndexBytes: 1e12 }, link, geneTargetMs: 2000, decodeBytesPerMs: null };
  const fresh = await resolveCellSubset(root, { mode: 'auto' }, context);
  const g = fresh.genes.cells;
  // One kept run of 5,000 rows: a sample smaller than it cannot take it.
  const oneRun = await resolveCellSubset(root, { mode: 'auto' }, { ...context, keptIndexRows: async () => ({ rows: 5000, ends: [5000], values: true }) });
  assert.ok(oneRun.genes.cells >= 5000, `the sample takes the run whole (${oneRun.genes.cells}), never a part of it priced as kept`);
  // Runs ending at g / 2 and 5,000: a sample below 5,000 takes the first only.
  const twoRuns = await resolveCellSubset(root, { mode: 'auto' }, { ...context, keptIndexRows: async () => ({ rows: 5000, ends: [Math.floor(g / 2), 5000], values: true }) });
  assert.ok(twoRuns.genes.cells >= 5000 || twoRuns.genes.cells < g + Math.floor(g / 2) + 1, `${twoRuns.genes.cells}`);
  // Priced as the reader reads it: the rows past the last run ending within the sample.
  const { firstGeneReadCost, geneReadMs } = await import('../assets/js/data/anndata/subsample-plan.js');
  const cost = await firstGeneReadCost(root, N_OBS, { valuesOnDemand: true, decodedChunkBytes: 1e9 });
  const order = twoRuns.cellOrder;
  const k = twoRuns.genes.cells;
  const taken = k >= 5000 ? 5000 : Math.floor(g / 2);
  const ordered = priorityOrder({ ...order, nObs: N_OBS, k }, subsampleBlocks(N_OBS, k, order.seed, order.blockSize));
  const ms = geneReadMs(cost(ordered.slice(taken).sort()), link, null);
  assert.ok(ms <= context.geneTargetMs, `priced at ${Math.round(ms)} ms`);
});

/**
 * A link read over the network on which nothing is measured yet, nor
 * remembered: a later visit whose opening read all it needed from what this
 * browser keeps, its host's speed unknown here (forgotten, or never kept).
 */
function unmeasuredLink() {
  const snapshot = { measured: false, latencyMs: null, loadedLatencyMs: null, bytesPerMs: null, concurrency: 6, shapingConcurrency: 6, mergeGapBytes: 0, roundTripBytes: null, readsAhead: false, deliveredBytes: 0 };
  return { readsAhead: false, mergeGapBytes: 0, roundTripBytes: null, snapshot: () => snapshot, watchProtocol() {} };
}

/** Where each row's entries start in the atlas's CSR `X` (its `indptr`), from its dense values. */
function entryEnds(values) {
  const ends = new Float64Array(N_OBS + 1);
  for (let cell = 0; cell < N_OBS; cell++) {
    let entries = 0;
    for (let gene = 0; gene < N_VARS; gene++) if (values[cell * N_VARS + gene] !== 0) entries++;
    ends[cell + 1] = ends[cell] + entries;
  }
  return ends;
}

/**
 * One visit of the atlas over `link` with what `disk` keeps: the gene
 * sample the opening fitted, the matrix chunks its first gene fetched
 * (`fetched`: none of what is kept), and its values checked on the sample.
 */
async function keptVisit(disk, tree, values, link, { grow = false } = {}) {
  const identity = { kind: 'remote', key: 'host:atlas', version: `md5:${'2'.repeat(32)}:1` };
  const counting = countingStore(tree);
  const root = await openZarr(counting.store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'atlas.zarr', link, cellSubset: { mode: 'auto' }, keptIndexes: { identity, environment: disk.environment } });
  const sample = reader.geneSample;
  const subset = reader.cellSubset;
  const before = counting.fetched.length;
  const column = await reader.getMatrixColumn('X', 3);
  const fetched = counting.fetched.slice(before).filter(key => key.startsWith('X/'));
  const cells = await openCells(reader);
  const gene = geneOf(values, 3);
  for (let i = 0; i < (sample?.cells ?? N_OBS); i++) assert.equal(column[i], gene[cells[i]], `open cell ${i}`);
  // The top-up's first step: genes for the cells the target priced.
  let grown = null;
  if (grow && sample?.fit?.growTo != null) {
    const from = counting.fetched.length;
    await reader.growGeneSample('X', sample.fit.growTo, { gene: 3, topUp: true });
    grown = { cells: reader.geneSample?.cells ?? N_OBS, fetched: counting.fetched.slice(from).filter(key => key.startsWith('X/')) };
    const again = await reader.getMatrixColumn('X', 3);
    for (let i = 0; i < grown.cells; i++) assert.equal(again[i], gene[cells[i]], `grown open cell ${i}`);
  }
  for (let wait = 0; (await reader.geneReadPlan('X')).built !== true; wait++) {
    assert.ok(wait < 2000, 'the index is built');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await reader.whenIndexesKept();
  reader.close();
  return { sample, cellOrder: subset.cellOrder, fetched, cells, grown };
}

test('a later visit over a link nothing has measured nor remembered reads its first gene for the kept cells: a cell read from the file is never priced as free', async t => {
  const { opfsOnDisk } = await import('./helpers/opfs-on-disk.mjs');
  const { tree, values } = atlas();
  const firstVisit = async () => {
    const disk = opfsOnDisk();
    t.after(() => disk.cleanup());
    const first = await keptVisit(disk, tree, values, slowLink(4));
    assert.equal(first.sample?.fit?.limit, 'geneTime');
    assert.ok(first.sample.cells > 100 && first.sample.cells < N_OBS / 2, `a sample the measured link sized (${first.sample.cells})`);
    assert.ok(first.fetched.length > 0 && first.sample.fit.bytes > 0, 'its first gene reads the matrix, priced so');
    return { disk, first };
  };
  // Nothing measured: the kept cells, exactly, in the same order; the
  // first gene priced at nothing and fetching nothing. Priced as free, the
  // sample was every open cell (the gene index's memory alone bounding it):
  // an HLCA core revisit read 575 MB for its first gene where the first
  // visit read 9.4 MB.
  {
    const { disk, first } = await firstVisit();
    const again = await keptVisit(disk, tree, values, unmeasuredLink());
    assert.equal(again.sample?.cells, first.sample.cells, 'the cells kept, no more');
    assert.deepEqual(again.cellOrder, first.cellOrder, 'in the order they were kept under');
    assert.equal(again.sample.fit.limit, 'geneTime', 'a sample the gene time sizes: the page tops it up once the first gene measured the link');
    assert.deepEqual(again.sample.fit.kept, { cells: first.sample.cells, bytes: 0 });
    assert.equal(again.sample.fit.bytes, 0);
    assert.equal(again.sample.fit.requests, 0);
    assert.equal(again.sample.fit.neededMs, null, 'what every cell would take is not known');
    const sized = geneSampleFacts(again.sample).find(row => row.label === 'Sized to');
    assert.match(sized.title, /not measured yet/, 'the Details say why: nothing measured the connection');
    // Priced at no byte, and no entry read: only the kept rows' pointers,
    // which the kept run is checked against (`kept-column-index.js`).
    assert.deepEqual(again.fetched.filter(key => !key.startsWith('X/indptr/')), [], 'no entry of the matrix is read');
    assert.ok(again.fetched.length <= first.fetched.filter(key => key.startsWith('X/indptr/')).length, `the kept rows' pointers at most (${again.fetched})`);
  }
  // Measured (or remembered) again: the first gene still answers from the
  // kept cells alone (coming back is never slower than the first visit);
  // the new cells the target prices at the link (`growTo`) are what the
  // top-up reads first, and only theirs. A lower bound of the link (a
  // quarter of the rate) never prices more.
  const priced = {};
  for (const rate of [4, 1]) {
    const { disk, first } = await firstVisit();
    const again = await keptVisit(disk, tree, values, slowLink(rate), { grow: true });
    assert.equal(again.sample.cells, first.sample.cells, `rate ${rate}: the first gene reads the kept cells alone`);
    assert.equal(again.sample.fit.bytes, 0);
    assert.deepEqual(again.fetched.filter(key => !key.startsWith('X/indptr/')), [], `rate ${rate}: no entry of the matrix is read for the first gene`);
    const growTo = again.sample.fit.growTo;
    assert.ok(growTo > first.sample.cells, `rate ${rate}: more cells priced within the target (${growTo})`);
    assert.equal(again.grown.cells, growTo, `rate ${rate}: the top-up's first step reads them`);
    // Read as priced: the entries of the new cells' rows alone (the stored
    // chunks of `indices` and `data` they lie in), and pointers.
    const entryChunks = new Set();
    const ends = entryEnds(values);
    for (const row of again.cells.slice(first.sample.cells, growTo)) {
      for (let chunk = Math.floor(ends[row] / 512); chunk * 512 < ends[row + 1]; chunk++) entryChunks.add(chunk);
    }
    const entries = again.grown.fetched.filter(key => !key.startsWith('X/indptr/'));
    assert.ok(entries.length > 0 && entries.every(key => entryChunks.has(Number(key.split('/').at(-1)))), `rate ${rate}: the new cells' entries only (${entries})`);
    priced[rate] = growTo;
  }
  assert.ok(priced[1] <= priced[4], `a lower-bound link prices no more (${priced[1]} at a quarter of the rate, ${priced[4]})`);
});

test('over a link nothing has measured, a first gene with nothing kept reads the fewest cells in the file\'s cell order; a local file\'s link is not such a link', async () => {
  const { tree } = atlas();
  const root = await openZarr(countingStore(tree).store, { decodedChunkCacheBytes: 0 });
  const context = { valuesOnDemand: true, decodedChunkBytes: 1e9, budgets: { allowanceBytes: 1e12, columnIndexBytes: 1e12 }, decodeBytesPerMs: null };
  const opened = await resolveCellSubset(root, { mode: 'auto' }, { ...context, link: unmeasuredLink().snapshot() });
  assert.equal(opened.genes?.cells, 2, 'the fewest cells: their first gene measures the link');
  assert.equal(opened.genes.fit.limit, 'geneTime');
  assert.equal(opened.cellOrder?.method, 'blocks', 'every cell in its default subsample\'s order, never file order with every cell\'s genes');
  // A local file is read ahead: its reads are not priced by a link.
  const local = await resolveCellSubset(root, { mode: 'auto' }, { ...context, link: { ...unmeasuredLink().snapshot(), readsAhead: true } });
  assert.equal(local.genes, null, 'every open cell\'s genes are read');
});

/**
 * A link whose opening measured only small reads, each mostly its round trip
 * (`policy`'s prior; 3 ms and 30 bytes a read): its rate is a lower bound,
 * nothing having kept it full (`bandwidthMeasured` false). A loopback host's
 * opening of a 10M-cell store in Chromium: 45 MB/s from 0.9 MB of metadata.
 */
function openingMeasuredLink(policy, reads = Array.from({ length: 8 }, () => ({ bytes: 30, ms: 3 }))) {
  let now = 0;
  const link = new LinkMeter(policy, { clock: () => now });
  for (const { bytes, ms } of reads) {
    const started = link.begin();
    now += ms;
    link.end(started, bytes);
  }
  return link;
}

test('a store on this machine (a loopback host, a local file) reads its first gene for every open cell, the matrix once, as a person\'s every cell does; over a network the same opening measurement samples', async () => {
  const { tree, values } = atlas();
  const firstGene = async ({ link, hostLink = null, cellSubset = { mode: 'auto' } }) => {
    const counting = countingStore(tree);
    const reader = new AnnDataReader();
    await reader.open(await openZarr(counting.store, { decodedChunkCacheBytes: 0 }), { format: ZARR_FORMAT, name: 'atlas.zarr', link, hostLink, cellSubset });
    const before = counting.reads.length;
    const column = await reader.getMatrixColumn('X', 7);
    const reads = counting.reads.slice(before).filter(read => read.key.startsWith('X/'));
    const result = {
      sample: reader.geneSample,
      fileRows: reader.cellSubset?.fileRows ?? null,
      cells: await openCells(reader),
      column,
      chunks: reads.map(read => read.key).sort(),
      bytes: reads.reduce((sum, read) => sum + read.end - read.start, 0),
    };
    reader.close();
    return result;
  };
  const web = openingMeasuredLink(REMOTE_POLICY);
  assert.equal(web.snapshot().bandwidthMeasured, false, 'the opening\'s rate is a lower bound');
  assert.equal(web.readsAhead, false);
  // Every open cell's genes, as a person asks for them: the work every cell's first gene is.
  const person = await firstGene({ link: web, cellSubset: { mode: 'auto', genes: 'all' } });
  assert.equal(person.sample, null);
  // Over a network the measured lower bound prices every cell past the gene
  // time: a sample, and fewer of the matrix's chunks.
  const remote = await firstGene({ link: openingMeasuredLink(REMOTE_POLICY), hostLink: hostLinkSeed('https://s3.us-west-2.amazonaws.com', { storage: null, timeline: null }) });
  assert.equal(remote.sample?.fit?.limit, 'geneTime', 'a host across a network keeps its gene sample');
  assert.ok(remote.sample.cells < N_OBS && remote.bytes < person.bytes, `${remote.sample.cells} cells, ${remote.bytes} of ${person.bytes} bytes`);
  // On this machine (Python's or R's served store, `cellucid serve`, a web
  // server run here; a picked file or folder): the same measurement, every
  // open cell, in file order, each value exact, the matrix's chunks each
  // read once -- exactly the work of every cell's first gene.
  const gene = geneOf(values, 7);
  for (const [label, opened] of [
    ['loopback host', { link: openingMeasuredLink(REMOTE_POLICY), hostLink: hostLinkSeed('http://127.0.0.1:8765', { storage: null, timeline: null }) }],
    ['local file', { link: openingMeasuredLink(LOCAL_POLICY) }],
  ]) {
    const read = await firstGene(opened);
    assert.equal(read.sample, null, `${label}: no gene sample`);
    assert.equal(read.fileRows, null, `${label}: every cell, in file order`);
    assert.equal(read.cells.length, N_OBS);
    for (let i = 0; i < N_OBS; i++) assert.equal(read.column[i], gene[read.cells[i]], `${label}: open cell ${i}`);
    assert.equal(new Set(read.chunks).size, read.chunks.length, `${label}: no chunk read twice`);
    if (label === 'loopback host') {
      assert.deepEqual(read.chunks, person.chunks, `${label}: the chunks every cell's first gene reads`);
      assert.equal(read.bytes, person.bytes);
    }
  }
});

/**
 * Openings measured while this machine was busy (another browser starting,
 * a run ending beside it), as a 10M-cell store on a loopback host in
 * Chromium measured them in 5 of 6 openings under load: `slowRead`, the
 * opening's small reads and then one slowed past three round trips, so it
 * counts as transfer and its rate as the link's (`bandwidthMeasured`;
 * 100-13,000 B/ms measured); `slowTurns`, small reads of which most waited
 * (a round trip under load of 863 ms where 1.5-7 ms is usual, its first
 * gene's many waves of requests priced at 45.7 s; this fixture's first gene
 * is one wave, so its round trip under load is taken past the gene time).
 */
const CONTENDED_OPENINGS = {
  slowRead: [...Array.from({ length: 8 }, () => ({ bytes: 30, ms: 3 })), { bytes: 300, ms: 30 }],
  slowTurns: [...Array.from({ length: 3 }, () => ({ bytes: 30, ms: 3 })), ...Array.from({ length: 8 }, () => ({ bytes: 30, ms: 12_000 }))],
};

test('a busy machine never samples a store on this machine: a loopback host or a local file is priced as this machine at rest whatever its opening measured; a host across a network as measured, a sample', async () => {
  const { tree, values } = atlas();
  const firstGene = async ({ link, hostLink = null }) => {
    const counting = countingStore(tree);
    const reader = new AnnDataReader();
    await reader.open(await openZarr(counting.store, { decodedChunkCacheBytes: 0 }), { format: ZARR_FORMAT, name: 'atlas.zarr', link, hostLink, cellSubset: { mode: 'auto' } });
    const column = await reader.getMatrixColumn('X', 7);
    const result = { sample: reader.geneSample, fileRows: reader.cellSubset?.fileRows ?? null, cells: await openCells(reader), column };
    reader.close();
    return result;
  };
  const seed = origin => hostLinkSeed(origin, { storage: null, timeline: null });
  const gene = geneOf(values, 7);
  for (const [name, reads] of Object.entries(CONTENDED_OPENINGS)) {
    const measured = openingMeasuredLink(REMOTE_POLICY, reads).snapshot();
    assert.equal(measured.bandwidthMeasured, true, `${name}: a delivery counted as keeping the link full`);
    if (name === 'slowRead') assert.ok(measured.bytesPerMs < LOCAL_POLICY.bytesPerMs / 1000, `${name}: measured far below a disk (${measured.bytesPerMs} B/ms)`);
    else assert.ok(measured.loadedLatencyMs > 100 * measured.latencyMs, `${name}: a round trip under load far past the shortest (${measured.loadedLatencyMs} ms)`);
    // Across a network the same measurement is the link: a sample, sized by the gene time.
    const remote = await firstGene({ link: openingMeasuredLink(REMOTE_POLICY, reads), hostLink: seed('https://s3.us-west-2.amazonaws.com') });
    assert.equal(remote.sample?.fit?.limit, 'geneTime', `${name}: a host across a network keeps its gene sample`);
    assert.ok(remote.sample.cells < N_OBS, `${name}: ${remote.sample.cells} cells`);
    // On this machine: every open cell, in file order, each value exact.
    for (const [label, opened] of [
      ['loopback host', { link: openingMeasuredLink(REMOTE_POLICY, reads), hostLink: seed('http://127.0.0.1:8765') }],
      ['localhost host', { link: openingMeasuredLink(REMOTE_POLICY, reads), hostLink: seed('http://localhost:8000') }],
      ['local file', { link: openingMeasuredLink(LOCAL_POLICY, reads) }],
    ]) {
      const read = await firstGene(opened);
      assert.equal(read.sample, null, `${name}, ${label}: no gene sample`);
      assert.equal(read.fileRows, null, `${name}, ${label}: every cell, in file order`);
      assert.equal(read.cells.length, N_OBS);
      for (let i = 0; i < N_OBS; i++) assert.equal(read.column[i], gene[read.cells[i]], `${name}, ${label}: open cell ${i}`);
    }
  }
});

/**
 * A DataState over a loader whose growth takes `walkMs` plus `msPerCell` a
 * cell added on a virtual clock (`performance.now` stands still otherwise),
 * with a sample of `cells` of `of` the gene time sized.
 */
async function toppingState({ cells = 1000, of = 1_000_000, budgetMs = 20_000, msPerCell = 2, walkMs = 1000, fits = Infinity, kept = null, neededMs = 1e9 } = {}) {
  const { DataState } = await import('../assets/js/app/state/core/data-state.js');
  const clock = { now: 0 };
  const state = new DataState(null, null);
  state.pointCount = of;
  const descriptor = { key: 'g', kind: 'continuous', path: 'var/g' };
  state._varFieldDescriptors = [descriptor];
  state.varData = { fields: [] };
  const fit = { cells, limit: 'geneTime', budgetMs, neededMs, neededCells: of, layout: 'csr', matrix: 'X', kept };
  let read = cells;
  const steps = [];
  state.varFieldLoader = {
    readRows: async (_field, [from, to]) => new Float32Array(to - from),
    geneSample: () => (read >= of ? null : { cells: read, of, fit: read === cells ? fit : null }),
    geneSampleOf: async () => (read >= of ? null : { cells: read, of }),
    geneSampleCost: async (_field, target) => ({
      cells: read, target, bytes: 0, keptBytes: 0, requests: 0,
      ms: null,
      index: { residentBytes: 0, placement: 'memory', refusal: Number.isFinite(fits) && target > fits ? 'memory' : null, fits: Math.min(target, fits) },
    }),
    growGeneSample: async (_field, target, { signal, onStep }) => {
      if (signal?.aborted) throw signal.reason;
      steps.push({ from: read, to: target, at: clock.now });
      clock.now += walkMs + (target - read) * msPerCell;
      read = target;
      onStep?.(null, target);
      return read >= of ? null : { cells: read, of, fit: null };
    },
  };
  state.noteGeneSample({ cells, of });
  return { state, clock, steps, fit };
}

/** Run `body` with `performance.now` on `clock`. */
async function onClock(clock, body) {
  const realNow = performance.now;
  performance.now = () => clock.now;
  try { return await body(); } finally { performance.now = realNow; }
}

test('the first gene\'s time left reads genes for more cells, measured: within the gene time, each step at the rate the last read ran', async () => {
  const { state, clock, steps, fit } = await toppingState({ cells: 1000, msPerCell: 2, walkMs: 1000 });
  // The first gene of 1,000 cells took 3 s (a walk of 1 s, then 2 ms a cell): 17 s are left.
  await onClock(clock, () => state.topUpGeneSample(3000));
  assert.ok(steps.length >= 1, 'genes are read for more cells in the time left');
  const spent = 3000 + clock.now;
  assert.ok(spent <= fit.budgetMs, `within the gene time (${spent} ms)`);
  const sample = state.getGeneSample();
  // 1,000 + 1,000 x 17 / 3 = 6,666 cells in 1 + 11.3 s, then 6,666 + 5,666 x 4.7 / 12.3 = 8,831.
  assert.ok(sample.cells >= 8000, `the gene time filled (${sample.cells} cells, steps ${JSON.stringify(steps)})`);
  assert.equal(sample.fit?.limit, 'geneTime', 'still the sample the gene time sized');
  assert.equal(state.getGeneSampleGrowth(), null);
  // Once per sample: a later gene reads the index.
  assert.equal(state.topUpGeneSample(10), null);
});

test('no time left, a step too small to see, the gene index\'s memory and the cells a kept index answered each bound the top-up', async () => {
  // The first gene took the whole gene time: nothing more.
  {
    const { state, steps } = await toppingState();
    assert.equal(state.topUpGeneSample(20_000), null);
    assert.equal(steps.length, 0);
  }
  // A step adding under a quarter of the cells read is not made.
  {
    const { state, clock, steps } = await toppingState({ cells: 1000 });
    await onClock(clock, () => state.topUpGeneSample(17_000));
    assert.equal(steps.length, 0, `${JSON.stringify(steps)}`);
  }
  // The gene index is kept for 2,500 cells at most.
  {
    const { state, clock, steps } = await toppingState({ cells: 1000, fits: 2500 });
    await onClock(clock, () => state.topUpGeneSample(3000));
    assert.deepEqual(steps.map(step => step.to), [2500]);
  }
  // A first gene made fast by a kept gene index: only the cells it read
  // count (200 of 1,000 in 1.4 s), and the kept ones count as read at that
  // rate: the gene time buys 200 x 20 / 1.4 = 2,857 cells in all, not 1,000
  // more than 200 x 18.6 / 1.4.
  {
    const { state, clock, steps } = await toppingState({ cells: 1000, kept: { cells: 800, bytes: 1 } });
    await onClock(clock, () => state.topUpGeneSample(1400));
    assert.deepEqual(steps.map(step => step.to).slice(0, 1), [Math.floor(200 * 20_000 / 1400)]);
    assert.ok(state.getGeneSample().cells <= Math.floor(200 * 20_000 / 1400), 'never more cells in all than the gene time buys');
  }
  // A later visit whose kept sample already holds what the gene time buys: nothing more is read.
  {
    const { state, clock, steps } = await toppingState({ cells: 10_000, kept: { cells: 9_900, bytes: 1 } });
    await onClock(clock, () => state.topUpGeneSample(1000));
    assert.equal(steps.length, 0, `100 cells read in 1 s buy 2,000 in the gene time, and 10,000 are held (${JSON.stringify(steps)})`);
  }
  // A later visit's first gene answered from its 1,000 kept cells, 1,800
  // priced over the link (`growTo`): the first step reads those, then the
  // steps are sized by what it took, the kept cells counted as read at its
  // rate (800 cells in 2.6 s buy 6,153 in all in the gene time).
  {
    const { state, clock, steps, fit } = await toppingState({ cells: 1000, kept: { cells: 1000, bytes: 0 }, msPerCell: 2, walkMs: 1000 });
    state._geneSample = null;
    const withGrow = { ...fit, growTo: 1800 };
    state.varFieldLoader.geneSample = () => ({ cells: 1000, of: 1_000_000, fit: withGrow });
    state.noteGeneSample({ cells: 1000, of: 1_000_000, fit: withGrow });
    await onClock(clock, () => state.topUpGeneSample(50));
    assert.equal(steps[0]?.to, 1800, `the priced cells first (${JSON.stringify(steps)})`);
    assert.ok(steps.length >= 2 && steps[1].to > 1800, 'then grown by what it took');
    assert.ok(50 + clock.now <= fit.budgetMs, `within the gene time (${50 + clock.now} ms)`);
    assert.ok(state.getGeneSample().cells <= Math.floor(800 * fit.budgetMs / (1000 + 800 * 2)), `${state.getGeneSample().cells}`);
  }
  // Every cell of the first gene kept, sized over a link with no price
  // (`neededMs` null): the first step measures, the least a step reads (a
  // quarter of the cells), and the next are sized from it, within the gene
  // time, at the rate it ran.
  {
    const { state, clock, steps, fit } = await toppingState({ cells: 1000, kept: { cells: 1000, bytes: 0 }, neededMs: null, msPerCell: 2, walkMs: 1000 });
    await onClock(clock, () => state.topUpGeneSample(50));
    assert.equal(steps[0]?.to, 1250, `a measuring step first (${JSON.stringify(steps)})`);
    assert.ok(steps.length >= 2 && steps[1].to > 1250, 'then steps sized from what it took');
    assert.ok(50 + clock.now <= fit.budgetMs, `within the gene time (${50 + clock.now} ms)`);
    // The kept cells count as read at the rate the first read from the file ran.
    assert.ok(state.getGeneSample().cells <= Math.floor(250 * fit.budgetMs / (1000 + 250 * 2)), `${state.getGeneSample().cells}`);
  }
  // A sample a person chose (no fit) is never topped up.
  {
    const { state } = await toppingState();
    state.varFieldLoader.geneSample = () => ({ cells: 1000, of: 1_000_000, fit: null });
    state._geneSample = null;
    state.noteGeneSample({ cells: 1000, of: 1_000_000 });
    assert.equal(state.topUpGeneSample(3000), null);
  }
});

test('a person\'s Genes read for takes over from the top-up, which stops keeping what it read', async () => {
  const { state, clock, steps } = await toppingState({ cells: 1000, of: 50_000 });
  // The top-up's first step waits until released.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const grow = state.varFieldLoader.growGeneSample;
  state.varFieldLoader.growGeneSample = async (field, target, options) => {
    if (steps.length === 0) {
      await Promise.race([gate, new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))]);
    }
    return grow(field, target, options);
  };
  await onClock(clock, async () => {
    const topping = state.topUpGeneSample(3000);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(state.getGeneSampleGrowth()?.cells, 1000, 'the top-up is under way');
    const asked = state.readGenesForMoreCells(50_000);
    release();
    assert.equal(await asked, null, 'every open cell read, as asked');
    await topping;
  });
  assert.deepEqual(steps.map(step => step.to), [50_000], 'the top-up stopped before its step read anything');
  assert.equal(state.getGeneSampleGrowth(), null);
});

test('an analysis about to read genes holds the sample still: the top-up stops, settles, and makes no further step', async () => {
  // A DE started while the first gene's top-up read on failed at 10M cells:
  // each step said a new sample, which the data layer takes as a new load
  // ("invalidated by a dataset lifecycle change"). The run holds the sample
  // first (`holdGeneSample`); every change is said before it resolves.
  const { state, clock, steps } = await toppingState({ cells: 1000, of: 50_000 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const grow = state.varFieldLoader.growGeneSample;
  state.varFieldLoader.growGeneSample = async (field, target, options) => {
    if (steps.length === 0) {
      await Promise.race([gate, new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))]);
    }
    return grow(field, target, options);
  };
  const changes = [];
  state.on('gene-sample:changed', ({ sample }) => changes.push(sample?.cells ?? null));
  await onClock(clock, async () => {
    const topping = state.topUpGeneSample(3000);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(state.getGeneSampleGrowth()?.cells, 1000, 'the top-up is under way');
    await state.holdGeneSample();
    const held = changes.length;
    const sample = state.getGeneSample();
    assert.equal(state.getGeneSampleGrowth(), null, 'no growth runs once held');
    release();
    await topping;
    assert.equal(changes.length, held, 'nothing changes the sample after the hold resolves');
    assert.deepEqual(state.getGeneSample(), sample);
  });
  assert.deepEqual(steps, [], 'the top-up stopped before its step read anything, and made no other');
  // Nothing to hold: null, in the same turn.
  assert.equal(state.holdGeneSample(), null);
  // A person's Genes read for is theirs: a hold leaves it.
  const { state: other } = await toppingState({ cells: 1000, of: 50_000 });
  const asked = other.readGenesForMoreCells(50_000);
  assert.equal(other.holdGeneSample(), null, 'a person\'s growth is not held');
  assert.equal(await asked, null, 'every open cell read, as asked');
});

test('a gene asked for never waits behind the top-up: its step stops at once, keeping what it read, and the steps go on after the gene', async () => {
  const { state, clock, steps, fit } = await toppingState({ cells: 1000, of: 1_000_000, msPerCell: 2, walkMs: 1000 });
  // The top-up's first step waits until released or stopped.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const grow = state.varFieldLoader.growGeneSample;
  let stopped = 0;
  state.varFieldLoader.growGeneSample = async (field, target, options) => {
    if (steps.length === 0 && stopped === 0) {
      await Promise.race([gate, new Promise((_, reject) => options.signal.addEventListener('abort', () => { stopped++; reject(options.signal.reason); }, { once: true }))]);
    }
    return grow(field, target, options);
  };
  await onClock(clock, async () => {
    const topping = state.topUpGeneSample(3000);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(state.getGeneSampleGrowth()?.cells, 1000, 'the top-up is under way');
    // A gene is asked for: the step stops at once.
    const resume = state.yieldGeneSampleTopUp();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(stopped, 1, 'the step under way stopped');
    assert.equal(state.getGeneSampleGrowth(), null, 'nothing is read for more cells while the gene is');
    assert.equal(steps.length, 0);
    // The gene read: the steps go on within the gene time.
    clock.now += 500;
    resume();
    resume();
    await topping;
  });
  assert.ok(steps.length >= 1, 'the top-up went on after the gene');
  // Its own reads within the gene time (the gene's 500 ms are the gene's).
  assert.ok(3000 + clock.now - 500 <= fit.budgetMs + 1, `within the gene time (${3000 + clock.now - 500} ms)`);
  assert.equal(state.getGeneSample().fit?.limit, 'geneTime');
  // No top-up under way: a gene asked for changes nothing.
  const { state: idle } = await toppingState();
  idle.yieldGeneSampleTopUp()();
});
