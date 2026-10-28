/**
 * Reads of some open cells (`rows: [start, end)`): what an opening grown in
 * place appends (`AnnDataFileSource.resizeCells`) and what an analysis's
 * first pass reads on the first cells of priority order.
 *
 * - Every reader method that takes `rows` (`getObsField`, `readObsmColumns`,
 *   `readEmbedding`, `readVectorField`, `getMatrixColumn(s)`) answers, bit
 *   for bit, rows `[start, end)` of what it answers for every open cell, on
 *   every opening: a priority-ordered file whole and by a prefix, a blocks
 *   and a uniform subsample of a file in its own order, a whole file; for
 *   every obs encoding and every matrix layout.
 * - Only what those rows need is fetched where the layout allows: a
 *   priority-ordered file's gene-major X reads the gene's entries between
 *   the prefix-count levels around the rows.
 * - An opening grown or cut in place keeps the frame its cells were shown
 *   in: no cell's display coordinates move.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { annData, array, categorical, countingStore, dataFrame, dense, mapping, nullable, sparse, strings } from './helpers/anndata-store.mjs';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';
import { rankOf } from '../assets/js/data/subsample.js';
import { prefixLevels } from '../assets/js/data/anndata/priority-layout.js';

function draw(random, low, high) {
  return low + Math.floor(random() * (high - low + 1));
}

function sameBits(actual, expected, label) {
  assert.equal(actual.constructor, expected.constructor, `${label}: type`);
  assert.equal(actual.length, expected.length, `${label}: length`);
  if (ArrayBuffer.isView(actual)) {
    assert.deepEqual(
      new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength),
      new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength),
      `${label}: bits`
    );
  } else {
    assert.deepEqual(actual, expected, `${label}: values`);
  }
}

/** A cells x genes matrix node (CSR, CSC or dense) of rows of {gene: value}. */
function matrixNode(random, rows, nObs, nVars, layout) {
  if (layout === 'dense') {
    const values = new Float32Array(nObs * nVars);
    rows.forEach((row, cell) => row.forEach((value, gene) => { values[cell * nVars + gene] = value; }));
    return dense(values, [nObs, nVars], { chunks: [draw(random, 1, nObs), nVars] });
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
  const node = sparse({ format: layout, data: Float32Array.from(data), indices: Int32Array.from(indices), indptr: Int32Array.from(indptr), shape: [nObs, nVars] });
  node.children.data.chunks = [Math.max(1, draw(random, 4, 24))];
  node.children.indices.chunks = [Math.max(1, draw(random, 4, 24))];
  node.children.indptr.chunks = [Math.max(1, draw(random, 4, 64))];
  return node;
}

/**
 * A dataset of `n` cells, its rows stored in `order` (original positions),
 * written in priority order under `seed` (with original positions, levels
 * and prefix counts) when `priority`.
 */
function buildTree(random, { n, nVars, layout, order, priority, seed }) {
  // The levels a file of n cells records (`priority-layout.js`).
  const levels = prefixLevels(n);
  const cells = Array.from({ length: n }, (_, p) => {
    const row = new Map();
    for (let g = 0; g < nVars; g++) if (random() < 0.35) row.set(g, Math.fround(1 + random() * 7));
    return row;
  });
  const score = Float32Array.from({ length: n }, () => random() * 3);
  const codes = Int8Array.from({ length: n }, () => draw(random, -1, 3));
  const counts = Int32Array.from({ length: n }, () => draw(random, 0, 40));
  const countMask = Uint8Array.from({ length: n }, () => (random() < 0.2 ? 1 : 0));
  const label = Array.from({ length: n }, () => ['x', 'y', 'z'][draw(random, 0, 2)]);
  const umap = Float32Array.from({ length: n * 3 }, () => random() * 20 - 5);
  const velocity = Float32Array.from({ length: n * 3 }, () => random() - 0.5);
  const rows = order.map(p => cells[p]);
  const chunk = () => [draw(random, 1, Math.max(1, Math.floor(n / 3)))];
  const obs = {
    _index: strings(order.map(p => `cell-${p}`), { chunks: chunk() }),
    score: array(Float32Array.from(order, p => score[p]), { chunks: chunk() }),
    cluster: categorical(Int8Array.from(order, p => codes[p]), ['a', 'b', 'c', 'd']),
    counts: nullable('nullable-integer', Int32Array.from(order, p => counts[p]), Uint8Array.from(order, p => countMask[p])),
    label: strings(order.map(p => label[p]), { chunks: chunk() }),
  };
  if (priority) obs.cellucid_original_position = array(Uint32Array.from(order), { dtype: '<u4', chunks: chunk() });
  const children = {
    obs: dataFrame(obs),
    var: dataFrame({ _index: strings(Array.from({ length: nVars }, (_, g) => `g${g}`)) }),
    obsm: mapping({
      X_umap: dense(Float32Array.from(order.flatMap(p => [umap[3 * p], umap[3 * p + 1], umap[3 * p + 2]])), [n, 3], { chunks: [draw(random, 1, n), 3] }),
      velocity_umap: dense(Float32Array.from(order.flatMap(p => [velocity[3 * p], velocity[3 * p + 1], velocity[3 * p + 2]])), [n, 3], { chunks: [draw(random, 1, n), 3] }),
    }),
    X: matrixNode(random, rows, n, nVars, layout),
  };
  if (priority) {
    children.uns = mapping({ cellucid: mapping({ priority: mapping({
      seed: array([seed], { dtype: '<u8', shape: [], chunks: [] }),
      specVersion: array([1], { dtype: '<i8', shape: [], chunks: [] }),
      nObs: array([n], { dtype: '<i8', shape: [], chunks: [] }),
      levels: array(levels, { dtype: '<i8' }),
    }) }) });
    const table = [];
    for (let g = 0; g < nVars; g++) {
      for (const level of levels) {
        let count = 0;
        for (let r = 0; r < level; r++) if (rows[r].has(g)) count++;
        table.push(count);
      }
    }
    children.varm = mapping({ cellucid_prefix_counts: dense(Int32Array.from(table), [nVars, levels.length], { dtype: '<i4', chunks: [nVars, 1] }) });
  }
  return annData(children);
}

async function openTree(tree, cellSubset, { root = null, carry = null } = {}) {
  let fetched = null;
  if (root === null) {
    const counting = countingStore(tree);
    fetched = counting.fetched;
    root = await openZarr(counting.store, { decodedChunkCacheBytes: 0 });
  }
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'case.zarr', decodedChunkBytes: 0, cellSubset, carry });
  return { reader, fetched, root };
}

/** Everything read with `rows` equals the whole read cut to them. */
async function assertRowsAreCuts(reader, random, label) {
  const n = reader.nObs;
  const genes = Array.from({ length: reader.nVars }, (_, g) => g);
  const whole = {
    score: (await reader.getObsField('score')).values,
    cluster: (await reader.getObsField('cluster')).codes,
    counts: (await reader.getObsField('counts')).values,
    label: (await reader.getObsField('label')).values,
    umap: await reader.readObsmColumns('X_umap', [0, 2]),
    embedding: await reader.readEmbedding('X_umap', [0, 1, 2], true),
    own: await reader.readEmbedding('X_umap', [0, 1], false),
    vectors: await reader.readVectorField('velocity_umap', [0, 1, 2], { key: 'X_umap', columns: [0, 1, 2] }, true),
    genes: await reader.getMatrixColumns('X', genes),
  };
  const ranges = [[0, n], [0, 1], [n - 1, n], [0, Math.ceil(n / 3)]];
  for (let r = 0; r < 4; r++) {
    const start = draw(random, 0, n - 1);
    ranges.push([start, draw(random, start, n)]);
  }
  for (const [start, end] of ranges) {
    const at = `${label} rows ${start}-${end}`;
    const rows = [start, end];
    sameBits((await reader.getObsField('score', { rows })).values, whole.score.slice(start, end), `${at}: score`);
    sameBits((await reader.getObsField('cluster', { rows })).codes, whole.cluster.slice(start, end), `${at}: cluster`);
    sameBits((await reader.getObsField('counts', { rows })).values, whole.counts.slice(start, end), `${at}: nullable counts`);
    assert.deepEqual((await reader.getObsField('label', { rows })).values, whole.label.slice(start, end), `${at}: strings`);
    sameBits(await reader.readObsmColumns('X_umap', [0, 2], { rows }), whole.umap.slice(2 * start, 2 * end), `${at}: obsm columns`);
    const embedding = await reader.readEmbedding('X_umap', [0, 1, 2], true, { rows });
    sameBits(embedding.positions, whole.embedding.positions.slice(3 * start, 3 * end), `${at}: embedding`);
    assert.deepEqual(embedding.transform, whole.embedding.transform, `${at}: transform`);
    sameBits((await reader.readEmbedding('X_umap', [0, 1], false, { rows })).positions, whole.own.positions.slice(2 * start, 2 * end), `${at}: own coordinates`);
    const vectors = await reader.readVectorField('velocity_umap', [0, 1, 2], { key: 'X_umap', columns: [0, 1, 2] }, true, { rows });
    sameBits(vectors.vectors, whole.vectors.vectors.slice(3 * start, 3 * end), `${at}: vectors`);
    const columns = await reader.getMatrixColumns('X', genes, { rows });
    columns.forEach((column, g) => sameBits(column, whole.genes[g].slice(start, end), `${at}: gene ${g}`));
    sameBits(await reader.getMatrixColumn('X', genes.length - 1, { rows }), whole.genes.at(-1).slice(start, end), `${at}: one gene`);
  }
  // Some cells among the first ones (an analysis's first pass): the block
  // of those cells is the whole columns' values there.
  for (const end of [1, Math.ceil(n / 4), n]) {
    const cells = Array.from({ length: Math.min(end, 7) }, () => draw(random, 0, end - 1)).filter((cell, i, all) => all.indexOf(cell) === i);
    const block = await reader.getMatrixCellSubset('X', cells, genes);
    const want = { pointers: [0], cellIndex: [], values: [] };
    whole.genes.forEach(column => {
      cells.forEach((cell, i) => {
        if (column[cell] !== 0) {
          want.cellIndex.push(i);
          want.values.push(column[cell]);
        }
      });
      want.pointers.push(want.cellIndex.length);
    });
    assert.deepEqual(Array.from(block.pointers), want.pointers, `${label} cells below ${end}: pointers`);
    assert.deepEqual(Array.from(block.cellIndex), want.cellIndex, `${label} cells below ${end}: cells`);
    sameBits(block.values, Float32Array.from(want.values), `${label} cells below ${end}: values`);
  }
  await assert.rejects(reader.getObsField('score', { rows: [0, n + 1] }), RangeError);
  await assert.rejects(reader.getMatrixColumn('X', 0, { rows: [2, 1] }), RangeError);
}

test('rows of every read are, bit for bit, the whole read cut to them, on every opening and layout', async () => {
  for (let c = 0; c < 12; c++) {
    const random = createMulberry32(0x0c0 + c);
    const n = draw(random, 30, 160);
    const nVars = draw(random, 2, 6);
    const seed = draw(random, 0, 0xffffffff);
    const layout = ['csr', 'csc', 'dense'][c % 3];
    const byRank = Array.from({ length: n }, (_, i) => i).sort((a, b) => rankOf(seed, a) - rankOf(seed, b));
    const shape = { n, nVars, layout, seed };
    const ordered = buildTree(createMulberry32(7 + c), { ...shape, order: byRank, priority: true });
    const plain = buildTree(createMulberry32(7 + c), { ...shape, order: Array.from({ length: n }, (_, i) => i), priority: false });
    for (const [tree, request, what] of [
      [ordered, { mode: 'all' }, 'priority file whole'],
      [ordered, { mode: 'subsample', k: draw(random, 2, n - 1) }, 'priority file prefix'],
      [ordered, { mode: 'subsample', method: 'uniform', seed: (seed ^ 5) >>> 0, k: draw(random, 2, n - 1) }, 'priority file other seed'],
      [plain, { mode: 'all' }, 'file order whole'],
      [plain, { mode: 'subsample', method: 'blocks', blockSize: draw(random, 1, 9), seed: 3, k: draw(random, 2, n - 1) }, 'blocks'],
      [plain, { mode: 'subsample', method: 'uniform', seed: 11, k: draw(random, 2, n - 1) }, 'uniform'],
    ]) {
      const { reader } = await openTree(tree, request);
      await assertRowsAreCuts(reader, random, `case ${c} ${layout} ${what}`);
      reader.close();
    }
  }
});

test("a priority-ordered file's gene-major X reads only the entries between the levels around the rows", async () => {
  const random = createMulberry32(0xfeed);
  const n = 900;
  const nVars = 3;
  const seed = 77;
  const levels = prefixLevels(n);
  const byRank = Array.from({ length: n }, (_, i) => i).sort((a, b) => rankOf(seed, a) - rankOf(seed, b));
  const tree = buildTree(random, { n, nVars, layout: 'csc', order: byRank, priority: true, seed });
  const X = tree.children.X.children;
  X.data.chunks = [8];
  X.indices.chunks = [8];
  const pointers = Array.from(X.indptr.values, Number);
  const chunkOf = (gene, rows) => {
    // Entries of `gene` below row `rows`, from the stored rows.
    let count = 0;
    for (let e = pointers[gene]; e < pointers[gene + 1]; e++) if (Number(X.indices.values[e]) < rows) count++;
    return count;
  };
  const gene = 1;
  for (const [request, start, end] of [[{ mode: 'all' }, 0, 30], [{ mode: 'all' }, 90, 270], [{ mode: 'subsample', k: 500 }, 0, 90], [{ mode: 'subsample', k: 500 }, 270, 500]]) {
    const { reader, fetched } = await openTree(tree, request);
    const before = fetched.length;
    const column = await reader.getMatrixColumn('X', gene, { rows: [start, end] });
    const keys = fetched.slice(before).filter(key => key.startsWith('X/indices/') || key.startsWith('X/data/'));
    // Entries from the level at or below `start` to one past the level at or above `end`.
    const below = levels.findLastIndex(size => size <= start);
    const above = levels.findIndex(size => size >= end);
    const from = pointers[gene] + (below < 0 ? 0 : chunkOf(gene, levels[below]));
    const to = Math.min(pointers[gene + 1], pointers[gene] + chunkOf(gene, levels[above]) + 1);
    const allowed = new Set();
    for (let chunk = Math.floor(from / 8); chunk <= Math.floor((to - 1) / 8); chunk++) allowed.add(chunk);
    for (const key of keys) {
      assert.ok(allowed.has(Number(key.slice(key.lastIndexOf('/') + 1))), `${JSON.stringify(request)} rows ${start}-${end}: ${key} lies outside the levels around them`);
    }
    // And the values are the stored gene's on those rows.
    const whole = await reader.getMatrixColumn('X', gene);
    sameBits(column, whole.slice(start, end), `rows ${start}-${end}`);
    reader.close();
  }
});

test('an opening grown or cut in place keeps every cell where it was shown', async () => {
  for (const layout of ['csr', 'csc']) {
    const random = createMulberry32(layout === 'csr' ? 41 : 42);
    const n = 400;
    const seed = 5;
    const byRank = Array.from({ length: n }, (_, i) => i).sort((a, b) => rankOf(seed, a) - rankOf(seed, b));
    const ordered = buildTree(random, { n, nVars: 3, layout, order: byRank, priority: true, seed });
    const plain = buildTree(createMulberry32(9), { n, nVars: 3, layout, order: Array.from({ length: n }, (_, i) => i), priority: false, seed });
    for (const [tree, request, label] of [
      [ordered, k => (k === n ? { mode: 'all' } : { mode: 'subsample', k }), `${layout} priority file`],
      [plain, k => ({ mode: 'subsample', method: 'blocks', blockSize: 7, seed: 2, k }), `${layout} blocks`],
      [plain, k => ({ mode: 'subsample', method: 'uniform', seed: 2, k }), `${layout} uniform`],
    ]) {
      const first = await openTree(tree, request(40));
      const shown = await first.reader.readEmbedding('X_umap', [0, 1, 2], true);
      let previous = first.reader;
      for (const k of [120, label.includes('priority') ? n : 390, 70]) {
        const next = await openTree(tree, request(k), { root: first.root, carry: previous });
        previous.releaseStore();
        previous.close();
        previous = next.reader;
        const grown = await next.reader.readEmbedding('X_umap', [0, 1, 2], true);
        assert.deepEqual(grown.transform, shown.transform, `${label} k=${k}: the same frame`);
        const kept = Math.min(40, k);
        sameBits(grown.positions.slice(0, 3 * kept), shown.positions.slice(0, 3 * kept), `${label} k=${k}: the first cells did not move`);
        // The cells appended are in the same frame: the rows read alone equal the whole read's.
        const rows = await next.reader.readEmbedding('X_umap', [0, 1, 2], true, { rows: [kept, k] });
        sameBits(rows.positions, grown.positions.slice(3 * kept), `${label} k=${k}: appended rows`);
      }
      previous.close();
    }
  }
  // A reopening that is not nested (other cells first) frames its cells anew.
  const random = createMulberry32(3);
  const tree = buildTree(random, { n: 200, nVars: 2, layout: 'csr', order: Array.from({ length: 200 }, (_, i) => i), priority: false, seed: 1 });
  const a = await openTree(tree, { mode: 'subsample', method: 'uniform', seed: 1, k: 30 });
  await a.reader.readEmbedding('X_umap', [0, 1, 2], true);
  const b = await openTree(tree, { mode: 'subsample', method: 'uniform', seed: 2, k: 60 }, { root: a.root, carry: a.reader });
  const fresh = await openTree(tree, { mode: 'subsample', method: 'uniform', seed: 2, k: 60 });
  assert.deepEqual((await b.reader.readEmbedding('X_umap', [0, 1, 2], true)).transform, (await fresh.reader.readEmbedding('X_umap', [0, 1, 2], true)).transform);
  a.reader.releaseStore();
  a.reader.close();
  b.reader.close();
  fresh.reader.close();
});

test("an analysis's first pass on the first cells reads only their genes' first entries", async () => {
  const random = createMulberry32(0xbeef);
  const n = 900;
  const seed = 31;
  const levels = prefixLevels(n);
  const byRank = Array.from({ length: n }, (_, i) => i).sort((a, b) => rankOf(seed, a) - rankOf(seed, b));
  const tree = buildTree(random, { n, nVars: 4, layout: 'csc', order: byRank, priority: true, seed });
  const X = tree.children.X.children;
  X.data.chunks = [8];
  X.indices.chunks = [8];
  for (const request of [{ mode: 'all' }, { mode: 'subsample', k: 600 }]) {
    const { reader, fetched } = await openTree(tree, request);
    const before = fetched.length;
    const cells = [3, 17, 29, 88];
    await reader.getMatrixCellSubset('X', cells, [0, 1, 2, 3]);
    const sampleReads = fetched.slice(before).filter(key => key.startsWith('X/indices/') || key.startsWith('X/data/')).length;
    const { reader: other, fetched: otherFetched } = await openTree(tree, request);
    await other.getMatrixColumns('X', [0, 1, 2, 3]);
    const wholeReads = otherFetched.filter(key => key.startsWith('X/indices/') || key.startsWith('X/data/')).length;
    assert.ok(sampleReads * 3 < wholeReads, `${JSON.stringify(request)}: the first cells' genes read ${sampleReads} chunks, whole genes ${wholeReads}`);
    reader.close();
    other.close();
  }
});

test('a progressive opening is sized from what reading is measured to cost, and only for nested cells', async () => {
  const { progressivePlan, planProgressiveOpening } = await import('../assets/js/data/anndata/progressive-open.js');
  const link = { latencyMs: 100, bytesPerMs: 1000, readsAhead: false };
  const bytesFor = k => 8 * k;
  // 1M cells of 8 bytes over 1 MB/s: 8 s; the first view is what arrives in
  // the second left after the latency, each step what arrives in twice the
  // time the cells open took.
  assert.deepEqual(progressivePlan({ target: 1_000_000, bytesFor, link, msPerCell: null, targetMs: 1000 }), {
    first: 112_500,
    steps: [237_500, 487_500, 987_500, 1_000_000],
    firstMs: 1000,
    wholeMs: 8100,
  });
  // Cells whose chunks are read already come in the same step.
  const shared = k => 8 * Math.max(k, Math.min(k * 4, 400_000));
  const sharedPlan = progressivePlan({ target: 1_000_000, bytesFor: shared, link, msPerCell: null, targetMs: 1000 });
  for (let i = 1; i < sharedPlan.steps.length; i++) assert.ok(sharedPlan.steps[i] >= 2 * sharedPlan.steps[i - 1] || sharedPlan.steps[i] === 1_000_000);
  // Predicted within the second, or nothing measured: at once.
  assert.equal(progressivePlan({ target: 100_000, bytesFor, link, msPerCell: null, targetMs: 1000 }), null);
  assert.equal(progressivePlan({ target: 1_000_000, bytesFor, link: null, msPerCell: null, targetMs: 1000 }), null);
  // One rule for every source: a picked file's link (read ahead) is priced
  // as a web host's, at what its reads measured.
  assert.deepEqual(progressivePlan({ target: 1_000_000, bytesFor, link: { ...link, readsAhead: true }, msPerCell: null, targetMs: 1000 }),
    progressivePlan({ target: 1_000_000, bytesFor, link, msPerCell: null, targetMs: 1000 }));
  // A disk-fast local read (8 MB in 4 ms) opens at once; decoding counts:
  // 16 MB decoded at 1 MB/s (1 KB/ms) is 16 s, and the first view comes
  // within the second.
  const disk = { latencyMs: 0.05, bytesPerMs: 2_000_000, readsAhead: true };
  assert.equal(progressivePlan({ target: 1_000_000, bytesFor, link: disk, decoding: { bytesPerMs: 1e9, expansion: 2 }, msPerCell: null, targetMs: 1000 }), null);
  const slowDecode = progressivePlan({ target: 1_000_000, bytesFor, link: disk, decoding: { bytesPerMs: 1000, expansion: 2 }, msPerCell: null, targetMs: 1000 });
  assert.ok(slowDecode !== null && slowDecode.wholeMs > 16_000 && slowDecode.firstMs <= 1000 && 2 * slowDecode.firstMs <= slowDecode.wholeMs);
  // Decoding priced: the same link and cells, a smaller first view.
  const decoded = progressivePlan({ target: 1_000_000, bytesFor, link, decoding: { bytesPerMs: 1000, expansion: 1 }, msPerCell: null, targetMs: 1000 });
  assert.ok(decoded.first < 112_500 && decoded.wholeMs === 16_100);
  // Cells that lie in nearly every chunk at once (blocks of a file chunked
  // coarser than them): a first view would read nearly what every cell reads.
  const chunky = k => 8_000_000 * Math.min(1, 0.6 + k / 2_500_000);
  assert.equal(progressivePlan({ target: 1_000_000, bytesFor: chunky, link, msPerCell: null, targetMs: 1000 }), null);
  // The page's measured cost of showing a cell counts too; never below the square root of the cells.
  assert.equal(progressivePlan({ target: 2000, bytesFor: null, link: null, msPerCell: 2, targetMs: 1000 }).first, 500);
  assert.equal(progressivePlan({ target: 10_000, bytesFor: null, link: null, msPerCell: 100, targetMs: 1000 }).first, 100);
  // Eligible: uniform and blocks subsamples, a priority-ordered file whole;
  // not stratified, spatial or a foreign file whole -- and those are decided
  // without pricing anything (nothing is read, nothing allocated per cell).
  const priced = [];
  // Decoding priced free here (`decodeBytesPerMs`), whatever this process decoded before.
  const cost = { nObs: 1_000_000, costOf: async target => { priced.push(target); return { bytesFor, chunkRows: 1, bytesPerChunk: 8, expansion: 1 }; }, link, decodeBytesPerMs: Infinity, msPerCell: null, targetMs: 1000 };
  const kept = Uint32Array.from({ length: 500_000 }, (_, i) => 2 * i);
  const uniform = await planProgressiveOpening({ kept, spec: { method: 'uniform', seed: 3, nObs: 1_000_000, k: 500_000 }, autoFit: null, prioritySeed: null }, cost);
  assert.deepEqual(uniform.first, { mode: 'subsample', method: 'uniform', seed: 3, strict: true, k: 112_500 });
  assert.equal(uniform.growth.final.mode, 'kept');
  assert.equal(uniform.growth.target, 500_000);
  assert.deepEqual(priced, [500_000]);
  priced.length = 0;
  assert.equal(await planProgressiveOpening({ kept, spec: { method: 'stratified', seed: 3 }, autoFit: null, prioritySeed: null }, cost), null);
  assert.equal(await planProgressiveOpening({ kept, spec: { method: 'spatial', seed: 3 }, autoFit: null, prioritySeed: null }, cost), null);
  assert.equal(await planProgressiveOpening({ kept: null, spec: null, prioritySeed: null }, cost), null);
  assert.deepEqual(priced, []);
  // A picked file is priced as any source: a disk-fast read opens at once.
  assert.equal(await planProgressiveOpening({ kept, spec: { method: 'uniform', seed: 3 }, autoFit: null, prioritySeed: null }, { ...cost, link: disk }), null);
  assert.deepEqual(priced, [500_000]);
  const whole = await planProgressiveOpening({ kept: null, spec: null, prioritySeed: 7 }, cost);
  assert.deepEqual(whole.growth.final, { mode: 'all' });
  assert.deepEqual(whole.first, { mode: 'subsample', method: 'uniform', seed: 7, strict: true, k: 112_500 });
});

test('the first view is priced by the chunks of the embedding its cells lie in', async () => {
  const { firstViewCost } = await import('../assets/js/data/anndata/progressive-open.js');
  const n = 1000;
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: n }, (_, i) => `c${i}`)) }),
    var: dataFrame({ _index: strings(['g']) }),
    obsm: mapping({ X_umap: dense(new Float32Array(n * 2), [n, 2], { chunks: [100, 2] }) }),
  });
  const { reader, root } = await openTree(tree, { mode: 'all' });
  const full = root;
  // In file order: a chunk every 100 cells.
  const { bytesFor: inOrder } = await firstViewCost(full, n, null, n);
  assert.equal(inOrder(100) * 10, inOrder(1000));
  assert.equal(inOrder(101), 2 * inOrder(100));
  // One cell of every chunk first: 10 cells already cost every chunk.
  const spread = Uint32Array.from({ length: n }, (_, i) => (i % 10) * 100 + Math.floor(i / 10));
  const { bytesFor: scattered } = await firstViewCost(full, n, spread, n);
  assert.equal(scattered(10), inOrder(1000));
  assert.equal(scattered(5), inOrder(500));
  // Priced for every k as the first cells' chunks, counted once.
  for (const k of [0, 1, 9, 10, 11, 999, 1000, 5000]) {
    const chunks = new Set();
    for (let i = 0; i < Math.min(k, n); i++) chunks.add(Math.floor(spread[i] / 100));
    assert.equal(scattered(k), chunks.size * inOrder(100), `k=${k}`);
  }
  // A target below every cell: the chunks of its cells alone.
  const { bytesFor: partial } = await firstViewCost(full, n, spread, 20);
  assert.equal(partial(20), inOrder(1000));
  assert.equal(partial(5000), inOrder(1000));
  reader.close();
});

test('a first view priced before any chunk was decoded reads its first cell\'s chunk to measure decoding', async () => {
  const { firstViewCost, decodingRate } = await import('../assets/js/data/anndata/progressive-open.js');
  const { configureDecodePool, decodePoolStats } = await import('../assets/js/formats/io/decode-pool.js');
  const n = 1000;
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: n }, (_, i) => `c${i}`)) }),
    var: dataFrame({ _index: strings(['g']) }),
    obsm: mapping({ X_umap: dense(new Float32Array(n * 2), [n, 2], { chunks: [100, 2] }) }),
  });
  const { reader, fetched, root } = await openTree(tree, { mode: 'all' });
  const spread = Uint32Array.from({ length: n }, (_, i) => (i % 10) * 100 + Math.floor(i / 10));
  configureDecodePool({ createWorker: null });
  // Not asked to measure: nothing read.
  fetched.length = 0;
  await firstViewCost(root, n, spread, n);
  assert.deepEqual(fetched, []);
  // Asked to: the chunk of the first open cell (row 0, chunk 0), and only it.
  const cost = await firstViewCost(root, n, Uint32Array.from(spread, (row, i) => (i === 0 ? 734 : row)), n, {}, { measureDecode: true });
  assert.deepEqual(fetched.filter(key => key.includes('X_umap')), ['obsm/X_umap/7.0']);
  assert.equal(cost.expansion, 1);
  reader.close();
  // A compressed store (anndata's Zstandard): decoding its chunk measures the rate.
  configureDecodePool({ createWorker: null });
  assert.equal(decodingRate(), null);
  const { corpusFolder } = await import('./helpers/zarr-corpus.mjs');
  const { directoryStore } = await import('../assets/js/formats/zarr/index.js');
  const compressed = await openZarr(directoryStore(await corpusFolder('anndata/v3.zarr')));
  const measured = await firstViewCost(compressed, 60, null, 60, {}, { measureDecode: true });
  assert.ok(measured.expansion > 0);
  assert.ok(decodePoolStats().decodedBytesPerMs > 0 && decodingRate() >= decodePoolStats().decodedBytesPerMs);
  configureDecodePool({});
});

test('a subsample grown from few chunks reads each chunk once and ends as the subsample opened directly', async () => {
  const { chunkMajorOrder, planProgressiveOpening } = await import('../assets/js/data/anndata/progressive-open.js');
  const n = 600;
  const chunkRows = 100;
  const random = createMulberry32(77);
  const umap = Float32Array.from({ length: n * 2 }, () => Math.fround(random() * 20 - 10));
  const score = Float32Array.from({ length: n }, () => Math.fround(random() * 5));
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: n }, (_, i) => `c${i}`)), score: array(score, { chunks: [chunkRows] }) }),
    var: dataFrame({ _index: strings(['g']) }),
    obsm: mapping({ X_umap: dense(umap, [n, 2], { chunks: [chunkRows, 2] }) }),
  });
  const ask = { mode: 'subsample', method: 'blocks', blockSize: 3, seed: 4, k: 90, strict: true };
  const direct = await openTree(tree, ask);
  const subset = direct.reader.cellSubset;
  const directUmap = await direct.reader.readObsmColumns('X_umap', [0, 1]);
  const directScore = (await direct.reader.getObsField('score')).values;

  // The plan: the cells' chunks are every chunk of the embedding, so a
  // first view in priority order reads it whole; in chunk order it reads few.
  const link = { latencyMs: 50, bytesPerMs: 10, readsAhead: false };
  const cost = { bytesFor: k => (k === 0 ? 0 : 6 * 800), chunkRows, bytesPerChunk: 800 };
  const plan = await planProgressiveOpening({ ...subset, prioritySeed: null }, { nObs: n, costOf: async () => cost, link, msPerCell: null, targetMs: 200 });
  assert.equal(plan.growth.chunked, true);
  // Chunks as fine as the cells: priority order reads no more for a first
  // view, and growing from few chunks would not bring it forward.
  const fine = { bytesFor: k => k * 8, chunkRows: 1, bytesPerChunk: 8 };
  const finePlan = await planProgressiveOpening({ ...subset, prioritySeed: null }, { nObs: n, costOf: async () => fine, link, msPerCell: null, targetMs: 200 });
  assert.notEqual(finePlan?.growth.chunked, true);
  const { order, ends } = chunkMajorOrder(subset.openOrder, chunkRows, ask.seed);
  assert.deepEqual(Array.from(order).sort((a, b) => a - b), Array.from(subset.kept), 'the same cells, the subsample asked for');
  const counts = [plan.first.chunks.cells, ...plan.growth.steps];
  for (const k of counts) assert.ok(Array.from(ends).includes(k), `step ${k} ends at a chunk`);
  assert.equal(counts.at(-1), 90);

  // Every step opens the kept cells of the chunks read so far, chunk by
  // chunk, reading each embedding chunk once.
  const counting = countingStore(tree);
  const root = await openZarr(counting.store, { decodedChunkCacheBytes: 0 });
  let previous = null;
  let from = 0;
  for (const cells of counts) {
    const request = { ...plan.growth.step, chunks: { ...plan.growth.step.chunks, cells } };
    const next = await openTree(tree, request, { root, carry: previous });
    if (previous !== null) {
      previous.releaseStore();
      previous.close();
    }
    previous = next.reader;
    assert.deepEqual(Array.from(next.reader.cellSubset.openOrder), Array.from(order.subarray(0, cells)));
    assert.equal(next.reader.cellSubset.ordered, false, 'a step is not a sample');
    const before = counting.fetched.length;
    const rows = await next.reader.readObsmColumns('X_umap', [0, 1], { rows: [from, cells] });
    const fetched = counting.fetched.slice(before).filter(key => key.startsWith('obsm/X_umap/'));
    const chunksOfRows = new Set(Array.from(order.subarray(from, cells), row => Math.floor(row / chunkRows)));
    assert.equal(new Set(fetched).size, chunksOfRows.size, `cells ${from}–${cells}: their chunks only`);
    for (let j = from; j < cells; j++) {
      for (let c = 0; c < 2; c++) assert.equal(rows[(j - from) * 2 + c], umap[order[j] * 2 + c]);
    }
    from = cells;
  }
  const embeddingFetches = counting.fetched.filter(key => key.startsWith('obsm/X_umap/'));
  assert.equal(new Set(embeddingFetches).size, embeddingFetches.length, 'each chunk fetched once');

  // Then the same cells in priority order: what opening the subsample directly opens.
  const final = await openTree(tree, plan.growth.final, { root, carry: previous });
  previous.releaseStore();
  previous.close();
  const opened = final.reader.cellSubset;
  assert.deepEqual(Array.from(opened.openOrder), Array.from(subset.openOrder));
  assert.deepEqual(Array.from(opened.kept), Array.from(subset.kept));
  assert.deepEqual(opened.spec, subset.spec);
  const finalUmap = await final.reader.readObsmColumns('X_umap', [0, 1]);
  sameBits(finalUmap, directUmap, 'embedding');
  sameBits((await final.reader.getObsField('score')).values, directScore, 'score');
  final.reader.close();
  direct.reader.close();
});

test('chunk order is taken only when its first view arrives at least twice as soon', async () => {
  const { planProgressiveOpening } = await import('../assets/js/data/anndata/progressive-open.js');
  // Lung-atlas-like: 258 embedding chunks of 892 rows, 1 % kept, a link of
  // 1.6 MB/s, 1 MB read by every first view whatever its cells.
  const nObs = 258 * 892;
  const chunkRows = 892;
  const bytesPerChunk = 70_000;
  const k = Math.round(nObs / 100);
  const random = createMulberry32(1234);
  const shuffled = values => {
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    return values;
  };
  // Blocks of 19 cells in priority order (a block's cells together); uniform cells spread.
  const blockStarts = shuffled(Array.from({ length: Math.floor(nObs / 19) }, (_, b) => b * 19));
  const blocks = blockStarts.flatMap(start => Array.from({ length: 19 }, (_, i) => start + i)).slice(0, k);
  const uniform = shuffled(Array.from({ length: nObs }, (_, i) => i)).slice(0, k);
  const plan = async (openOrder, method) => {
    const firstChunk = new Map();
    openOrder.forEach((cell, i) => {
      const chunk = Math.floor(cell / chunkRows);
      if (!firstChunk.has(chunk)) firstChunk.set(chunk, i);
    });
    const firsts = [...firstChunk.values()].sort((a, b) => a - b);
    const cost = { bytesFor: n => firsts.filter(i => i < n).length * bytesPerChunk, chunkRows, bytesPerChunk };
    const resolution = {
      kept: Uint32Array.from(openOrder).sort(),
      openOrder: Uint32Array.from(openOrder),
      spec: { method, seed: 3, nObs, k, ...(method === 'blocks' ? { blockSize: 19 } : {}) },
      autoFit: null,
      prioritySeed: null,
    };
    return planProgressiveOpening(resolution, { nObs, costOf: async () => cost, link: { latencyMs: 100, bytesPerMs: 1600, readsAhead: false }, msPerCell: null, targetMs: 1000 });
  };
  // Blocks: the first cells of priority order lie in a few chunks already.
  const blocksPlan = await plan(blocks, 'blocks');
  assert.equal(blocksPlan?.growth.chunked ?? false, false, 'blocks keep priority order');
  // Uniform: the first cells of priority order lie in most chunks; chunk order reads few.
  const uniformPlan = await plan(uniform, 'uniform');
  assert.equal(uniformPlan?.growth.chunked, true, 'a uniform share grows from few chunks');
});

test('a reopening of the same store reads its gene names and every cell\'s field counts once, with the same answers', async () => {
  const random = createMulberry32(0x5eed);
  const n = 300;
  const tree = buildTree(random, { n, nVars: 5, layout: 'csr', order: Array.from({ length: n }, (_, i) => i), priority: false, seed: 1 });
  const counting = countingStore(tree);
  const root = await openZarr(counting.store, { decodedChunkCacheBytes: 0 });
  const open = async (cellSubset, carry = null) => {
    const reader = new AnnDataReader();
    await reader.open(root, { format: ZARR_FORMAT, name: 'case.zarr', decodedChunkBytes: 0, cellSubset, carry });
    return reader;
  };
  const request = k => ({ mode: 'subsample', method: 'uniform', seed: 4, k });
  const first = await open(request(40));
  await first.readVarNames('X', null);
  await first.subsampleRepresentation('cluster');
  const before = counting.fetched.length;
  const grown = await open(request(160), first);
  await grown.readVarNames('X', null);
  await grown.subsampleRepresentation('cluster');
  const reads = counting.fetched.slice(before);
  // Neither the var index nor the cluster codes of every cell are read
  // again: the codes read are the open cells' chunks.
  assert.deepEqual(reads.filter(key => key.startsWith('var/')), [], 'the var index is carried');
  const codeChunks = key => key.startsWith('obs/cluster/codes/');
  const freshBefore = counting.fetched.length;
  const fresh = await open(request(160));
  await fresh.readVarNames('X', null);
  await fresh.subsampleRepresentation('cluster');
  const freshReads = counting.fetched.slice(freshBefore);
  assert.ok(freshReads.some(key => key.startsWith('var/')), 'a fresh opening reads the var index');
  assert.ok(reads.filter(codeChunks).length <= freshReads.filter(codeChunks).length, 'no more code chunks than a fresh opening');
  const names = await grown.readVarNames('X', null);
  assert.deepEqual(names.index, Array.from({ length: 5 }, (_, g) => `g${g}`));
  const shown = await grown.subsampleRepresentation('cluster');
  assert.deepEqual(shown, await fresh.subsampleRepresentation('cluster'), 'the same representation as a fresh opening');
  assert.equal(await grown.subsampleRepresentation('cluster'), await grown.subsampleRepresentation('cluster'), 'asked again, answered once');
  first.close();
  grown.close();
  fresh.close();
});
