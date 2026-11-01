/**
 * One rank pass per opening (`subsample.js` `createSubsampleCache`): an
 * opening that resolves several sizes of one subsample -- a progressive
 * opening's target, its first view, each growth step and the target again
 * (`progressive-open.js`, `resolveCellSubset`) -- ranks the cells once, for
 * the largest size, and takes every other size from that rank order.
 *
 * - A five-step growth at a million cells makes one pass over the cells in
 *   all (`stats.passes`), for `uniform`, `blocks` (over the blocks), a
 *   priority-ordered file opened whole (none: its layout's order) and a
 *   subsample grown from few chunks.
 * - Every step's cells and open order are, bit for bit, what a reference
 *   computed here from the specification's definition gives (every rank,
 *   sorted), and what the one-shot functions give.
 * - A `stratified` or `spatial` size within what its strata ranked reads
 *   neither its field nor its embedding again.
 * - The reader holds one cache for the opening's life and its later
 *   openings of the same bytes take it over (`carry`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { annData, array, categorical, countingStore, dataFrame, dense, mapping, sparse, strings } from './helpers/anndata-store.mjs';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { resolveCellSubset } from '../assets/js/data/anndata/subsample-plan.js';
import { chunkMajorOrder } from '../assets/js/data/anndata/progressive-open.js';
import {
  createSubsampleCache,
  priorityOrder,
  rankOf,
  subsampleBlockRuns,
  subsampleBlocks,
  subsampleSpatial,
  subsampleStratified,
  subsampleUniform,
} from '../assets/js/data/subsample.js';

const N = 1_000_000;
const TARGET = 500_000;
/** The growth of a progressive opening: its target first, then the first view, three steps, and the target again. */
const STEPS = [31_250, 62_500, 125_000, 250_000];
const CONTEXT = { valuesOnDemand: true, decodedChunkBytes: 1e9 };

const scalar = (value, dtype = '<i8') => array([value], { dtype, shape: [], chunks: [] });

/** A store of `n` cells whose cell count is its metadata (nothing per cell is written), with `extra` children. */
function cellsOnly(n, extra = {}) {
  return annData({
    obs: dataFrame({ _index: array(new Float32Array(0), { dtype: '<f4', shape: [n], chunks: [n], writeChunks: false }), ...(extra.obs ?? {}) }),
    var: dataFrame({ _index: strings(['g0', 'g1']) }),
    ...(extra.obsm === undefined ? {} : { obsm: mapping(extra.obsm) }),
    ...(extra.uns === undefined ? {} : { uns: extra.uns }),
  });
}

async function rootOf(tree) {
  const { store, fetched } = countingStore(tree);
  return { root: await openZarr(store, { decodedChunkCacheBytes: 0 }), fetched };
}

/** The `k` lowest-ranked of `n` positions and all of them by rank, from every rank sorted (the definition). */
function reference(n, seed) {
  const ranks = new Uint32Array(n);
  for (let p = 0; p < n; p++) ranks[p] = rankOf(seed, p);
  const sorted = Uint32Array.from(ranks).sort();
  return {
    kept(k) {
      const threshold = sorted[k - 1];
      const out = new Uint32Array(k);
      let at = 0;
      for (let p = 0; p < n; p++) if (ranks[p] <= threshold) out[at++] = p;
      return out;
    },
    order(kept) {
      return Uint32Array.from(Array.from(kept).sort((a, b) => ranks[a] - ranks[b]));
    },
  };
}

/** The `blocks` subsample of `k` from its definition: whole blocks in rank order of their number, the last cut. */
function blocksReference(n, k, seed, blockSize) {
  const blocks = Array.from({ length: Math.ceil(n / blockSize) }, (_, b) => b).sort((a, b) => rankOf(seed, a) - rankOf(seed, b));
  const order = [];
  for (const block of blocks) {
    for (let row = block * blockSize; row < Math.min(n, (block + 1) * blockSize) && order.length < k; row++) order.push(row);
    if (order.length === k) break;
  }
  return { kept: Uint32Array.from(order).sort(), order: Uint32Array.from(order) };
}

function sameArray(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) assert.fail(`${label}: entry ${i} is ${actual[i]}, not ${expected[i]}`);
  }
}

test('a uniform growth of five steps at a million cells ranks the cells once, and every step is the subsample of its size', async () => {
  const { root } = await rootOf(cellsOnly(N));
  const cache = createSubsampleCache();
  const context = { ...CONTEXT, subsampleCache: cache };
  const seed = 11;
  const spec = k => ({ method: 'uniform', nObs: N, k, seed });
  const asked = await resolveCellSubset(root, { mode: 'subsample', method: 'uniform', k: TARGET, seed, strict: true }, context);
  assert.deepEqual(cache.stats, { passes: 1, ranked: N });
  const resolutions = [asked];
  for (const k of STEPS) resolutions.push(await resolveCellSubset(root, { mode: 'subsample', method: 'uniform', k, seed, strict: true }, context));
  // The last step: the cells asked for, as resolved (`planProgressiveOpening`'s `final`).
  const last = await resolveCellSubset(root, { mode: 'kept', spec: spec(TARGET), kept: Uint32Array.from(asked.kept), autoFit: null, reproduced: null }, context);
  assert.equal(last.reproduced, true);
  resolutions.push(last);
  assert.deepEqual(cache.stats, { passes: 1, ranked: N }, 'one pass over the cells for the whole growth');
  const truth = reference(N, seed);
  for (const resolution of resolutions) {
    const k = resolution.kept.length;
    const kept = truth.kept(k);
    sameArray(resolution.kept, kept, `k=${k}: cells`);
    sameArray(resolution.kept, subsampleUniform(N, k, seed), `k=${k}: subsampleUniform`);
    sameArray(resolution.openOrder, truth.order(kept), `k=${k}: open order`);
    sameArray(resolution.openOrder, priorityOrder(spec(k), kept), `k=${k}: priorityOrder`);
    assert.deepEqual(resolution.spec, spec(k));
  }
  // Each step's open cells start with the previous step's: a growth appends.
  for (let s = 1; s < resolutions.length - 1; s++) {
    sameArray(resolutions[s + 1].openOrder.subarray(0, resolutions[s].openOrder.length), resolutions[s].openOrder, `step ${s}: appended`);
  }
});

test('a blocks growth ranks the blocks once, and every step is the blocks subsample of its size', async () => {
  const { root } = await rootOf(cellsOnly(N));
  const cache = createSubsampleCache();
  const context = { ...CONTEXT, subsampleCache: cache };
  const seed = 3;
  const blockSize = 37;
  const request = k => ({ mode: 'subsample', method: 'blocks', k, seed, blockSize, strict: true });
  const resolutions = [await resolveCellSubset(root, request(TARGET), context)];
  for (const k of STEPS) resolutions.push(await resolveCellSubset(root, request(k), context));
  const spec = { method: 'blocks', nObs: N, k: TARGET, seed, blockSize };
  resolutions.push(await resolveCellSubset(root, { mode: 'kept', spec, kept: subsampleBlocks(N, TARGET, seed, blockSize), autoFit: null, reproduced: null }, context));
  assert.deepEqual(cache.stats, { passes: 1, ranked: Math.ceil(N / blockSize) }, 'one pass over the blocks');
  for (const resolution of resolutions) {
    const k = resolution.kept.length;
    const truth = blocksReference(N, k, seed, blockSize);
    sameArray(resolution.kept, truth.kept, `k=${k}: cells`);
    sameArray(resolution.openOrder, truth.order, `k=${k}: open order`);
    sameArray(resolution.openOrder, priorityOrder(resolution.spec, resolution.kept), `k=${k}: priorityOrder`);
    const runs = cache.blockRuns(N, k, seed, blockSize);
    const oneShot = subsampleBlockRuns(N, k, seed, blockSize);
    assert.equal(runs.count, oneShot.count);
    sameArray(runs.starts, oneShot.starts, `k=${k}: run starts`);
    sameArray(runs.ends, oneShot.ends, `k=${k}: run ends`);
  }
  assert.deepEqual(cache.stats, { passes: 1, ranked: Math.ceil(N / blockSize) });
});

test('a priority-ordered file opened whole grows through prefixes of its order, ranking nothing more', async () => {
  const seed = 5;
  const { root } = await rootOf(cellsOnly(N, { uns: mapping({ cellucid: mapping({ priority: mapping({ seed: scalar(seed, '<u8'), specVersion: scalar(1), nObs: scalar(N) }) }) }) }));
  const cache = createSubsampleCache();
  const context = { ...CONTEXT, subsampleCache: cache };
  // Opened whole: the rows' original positions (the seed's rank order).
  const whole = await resolveCellSubset(root, { mode: 'all' }, context);
  const order = await whole.openOrderRead;
  const truth = reference(N, seed);
  for (const k of [...STEPS, 600_000]) {
    const step = await resolveCellSubset(root, { mode: 'subsample', method: 'uniform', k, seed, strict: true }, context);
    sameArray(step.kept, truth.kept(k), `k=${k}: cells`);
    assert.equal(step.prefix, k, `k=${k}: the file's first rows`);
    sameArray(await step.openOrderRead, order.subarray(0, k), `k=${k}: open order`);
  }
  assert.deepEqual(cache.stats, { passes: 0, ranked: 0 }, 'the layout\'s order, ranked once for it, serves every step');
});

test('a subsample grown from few chunks selects and orders its cells once for all its steps', async () => {
  const { root } = await rootOf(cellsOnly(N));
  const cache = createSubsampleCache();
  const context = { ...CONTEXT, subsampleCache: cache };
  const spec = { method: 'uniform', nObs: N, k: TARGET, seed: 9 };
  const chunks = { rows: 50_000, seed: 9 };
  const steps = [];
  for (const cells of [40_000, 160_000, TARGET]) steps.push(await resolveCellSubset(root, { mode: 'chunks', spec, autoFit: null, chunks: { ...chunks, cells } }, context));
  assert.deepEqual(cache.stats, { passes: 1, ranked: N });
  const kept = subsampleUniform(N, TARGET, 9);
  const { order } = chunkMajorOrder(priorityOrder(spec, kept), chunks.rows, chunks.seed);
  for (const step of steps) {
    sameArray(step.openOrder, order.subarray(0, step.openOrder.length), `${step.openOrder.length} cells: chunk order`);
  }
  // The same subsample's order, asked again, is the same array, and its chunk order is computed once.
  const again = cache.priorityOrder(spec, cache.uniform(N, TARGET, 9));
  assert.equal(again, cache.priorityOrder(spec, cache.uniform(N, TARGET, 9)));
  assert.equal(chunkMajorOrder(again, chunks.rows, chunks.seed), chunkMajorOrder(again, chunks.rows, chunks.seed));
});

test('stratified and spatial sizes within what their strata ranked read neither the field nor the embedding again', async () => {
  const n = 200_000;
  let state = 7;
  const random = () => ((state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const codes = Int8Array.from({ length: n }, () => (random() < 0.03 ? -1 : Math.floor(random() * random() * 6)));
  const umap = Float32Array.from({ length: n * 2 }, () => random() * random() * 10);
  const tree = cellsOnly(n, {
    obs: { cluster: categorical(codes, ['a', 'b', 'c', 'd', 'e', 'f']) },
    obsm: { X_umap: dense(umap, [n, 2], { chunks: [50_000, 2] }) },
  });
  const { root, fetched } = await rootOf(tree);
  const cache = createSubsampleCache();
  const context = { ...CONTEXT, subsampleCache: cache };
  const codesOf = Float64Array.from(codes, code => (code < 0 ? Number.NaN : code));
  for (const [method, extra, oneShot] of [
    ['stratified', { field: 'cluster', allocation: 'balanced', minPerCategory: 5 }, k => subsampleStratified(codesOf, 6, k, 4, { allocation: 'balanced', minPerCategory: 5 })],
    ['stratified', { field: 'cluster', allocation: 'proportional', minPerCategory: 0 }, k => subsampleStratified(codesOf, 6, k, 4, { allocation: 'proportional' })],
    ['spatial', { embedding: 'X_umap', columns: [0, 1], gridSize: 8 }, k => subsampleSpatial(umap, 2, k, 4, { gridSize: 8 })],
  ]) {
    const request = k => ({ mode: 'subsample', method, k, seed: 4, strict: true, ...extra });
    const first = await resolveCellSubset(root, request(80_000), context);
    sameArray(first.kept, oneShot(80_000), `${method} ${extra.allocation ?? ''} 80000`);
    const reads = fetched.length;
    const passes = cache.stats.passes;
    // A smaller size of a balanced split (water-filling never takes a stratum's quota down when the total rises).
    for (const k of [10_000, 40_000, 80_000]) {
      const smaller = await resolveCellSubset(root, request(k), context);
      sameArray(smaller.kept, oneShot(k), `${method} ${extra.allocation ?? ''} ${k}`);
      sameArray(smaller.openOrder, priorityOrder(smaller.spec, smaller.kept), `${method} ${k}: open order`);
    }
    if (method === 'spatial' || extra.allocation === 'balanced') {
      assert.equal(fetched.length, reads, `${method}: nothing read again`);
      assert.equal(cache.stats.passes, passes, `${method}: nothing ranked again`);
    }
    // A larger size reads its input again and ranks its strata further, exactly.
    const larger = await resolveCellSubset(root, request(150_000), context);
    sameArray(larger.kept, oneShot(150_000), `${method} 150000`);
  }
});

test('the reader holds one cache for the opening and its growth steps take it over', async () => {
  const n = 3000;
  const values = Float32Array.from({ length: n * 4 }, (_, i) => ((i * 7) % 5 === 0 ? 1 + (i % 3) : 0));
  const data = [];
  const indices = [];
  const indptr = [0];
  for (let cell = 0; cell < n; cell++) {
    for (let gene = 0; gene < 4; gene++) {
      if (values[cell * 4 + gene] !== 0) {
        indices.push(gene);
        data.push(values[cell * 4 + gene]);
      }
    }
    indptr.push(data.length);
  }
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: n }, (_, i) => `c${i}`), { chunks: [500] }) }),
    var: dataFrame({ _index: strings(['g0', 'g1', 'g2', 'g3']) }),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: n * 2 }, (_, i) => (i * 13) % 97), [n, 2], { chunks: [500, 2] }) }),
    X: sparse({ format: 'csr', data: Float32Array.from(data), indices: Int32Array.from(indices), indptr: Int32Array.from(indptr), shape: [n, 4] }),
  });
  const { store } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const request = k => ({ mode: 'subsample', method: 'uniform', k, seed: 2 });
  let previous = null;
  let cache = null;
  for (const k of [2000, 300, 600, 1200, 2000]) {
    const reader = new AnnDataReader();
    await reader.open(root, { format: ZARR_FORMAT, name: 'growth.zarr', decodedChunkBytes: 0, cellSubset: request(k), carry: previous });
    cache ??= reader._subsampleCache;
    assert.equal(reader._subsampleCache, cache, `k=${k}: the opening's cache, carried`);
    sameArray(reader.cellSubset.kept, subsampleUniform(n, k, 2), `k=${k}: cells`);
    if (previous !== null) {
      previous.releaseStore();
      previous.close();
      assert.equal(previous._subsampleCache, null, 'let go on close');
    }
    previous = reader;
  }
  assert.deepEqual(cache.stats, { passes: 1, ranked: n });
  previous.close();
  assert.equal(previous._subsampleCache, null);
});
