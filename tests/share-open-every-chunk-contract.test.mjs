/**
 * A share's opening never does more work than every cell's (the share
 * rule), counted, never timed:
 *
 * - **A share's whole column is read row by row in its rows' file order**
 *   (`cell-subset.js` `rowWaves`): the chunks its rows lie in, each once,
 *   in waves of a slab, each row one copy to its place, and no pass over
 *   pieces (its runs never ordered by source row, listed or walked through
 *   a permutation), which for a 50% uniform share of a 10M-cell `.h5ad`
 *   would take several times every cell's time for the same bytes, placing
 *   5M single-row pieces of each column through three permuted arrays a row
 *   (measured: 23_decisions_partial_reading.md).
 * - **A share that leaves a chunk unread reads only the chunks its rows lie
 *   in**, and a part of the view keeps the pass over pieces.
 * - **Runs are ordered by source row in linear time** (`rankedOrder`, a
 *   radix order of their 32-bit words), rows past 2^32 included.
 * - **Pricing a share's first gene passes over rows in chunks already
 *   counted** (`subsample-plan.js` `rowChunks`): the gene sample's fit
 *   must not price 5M single-row spans at each of its steps (seconds of a
 *   50% share's opening over a 20 ms link); the price is unchanged.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DecodedChunks } from '../assets/js/data/anndata/decoded-chunks.js';
import { CellRows, gatheredArray, planBoxes, runsOfPositions } from '../assets/js/data/anndata/views/cell-subset.js';

/** A chunked array of `rows` rows of `width` values (value = row * 10 + column), counting its reads. */
function countedArray(rows, width, chunkRows) {
  const reads = [];
  const real = {
    kind: 'array', path: 'obsm/X', name: 'X', attrs: {}, attributeType: () => null,
    shape: width === 1 ? [rows] : [rows, width], dtype: { kind: 'float', bytes: 4, size: 4 },
    chunks: width === 1 ? [chunkRows] : [chunkRows, width], partialChunks: false, fillValue: 0,
    async storedBytes([[a, b]]) { return (b - a) * width * 4; },
    async read([[a, b], columns = [0, width]]) {
      reads.push([a, b]);
      const out = new Float32Array((b - a) * (columns[1] - columns[0]));
      for (let row = a; row < b; row++) for (let c = columns[0]; c < columns[1]; c++) out[(row - a) * (columns[1] - columns[0]) + c - columns[0]] = row * 10 + c;
      return out;
    },
  };
  return { real, reads };
}

/** Runs whose `starts` count each read of an element (the pass reads each run's start several times). */
function countedRuns(runs) {
  let gets = 0;
  const starts = new Proxy(runs.starts, {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) gets++;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { runs: { ...runs, starts }, gets: () => gets };
}

/** `count` distinct rows of `rows`, in a shuffled (open) order, seeded. */
function shuffledShare(rows, keep, seed = 7) {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state / 4294967296;
  };
  const kept = [];
  for (let row = 0; row < rows; row++) if (random() < keep) kept.push(row);
  for (let i = kept.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [kept[i], kept[j]] = [kept[j], kept[i]];
  }
  return Uint32Array.from(kept);
}

test('a share\'s whole column is read row by row in file order: each chunk its rows lie in once, its rows exact, no pass over pieces', async () => {
  const { scatterRows, slabRowCount } = await import('../assets/js/data/anndata/values.js');
  for (const [keep, width] of [[0.5, 2], [0.1, 1], [0.05, 3]]) {
    const rows = 2000;
    const chunkRows = 200;
    const kept = shuffledShare(rows, keep);
    assert.equal(new Set(Array.from(kept, row => Math.floor(row / chunkRows))).size, rows / chunkRows, `${keep}: a kept row in every chunk`);
    const { real, reads } = countedArray(rows, width, chunkRows);
    const cellRows = new CellRows(kept, rows);
    const { runs, gets } = countedRuns(cellRows.runs());
    const view = gatheredArray(real, runs, { mergeGapBytes: () => 0, chunks: new DecodedChunks(0) });
    const columns = width === 1 ? [] : [[0, width]];
    const values = await view.read([[0, kept.length], ...columns]);
    for (let v = 0; v < kept.length; v++) {
      for (let c = 0; c < width; c++) assert.equal(values[v * width + c], kept[v] * 10 + c, `${keep}: view row ${v} column ${c}`);
    }
    assert.deepEqual(reads, [[0, rows]], `${keep}: every chunk once, in one read of their stretch, as every cell reads them`);
    assert.equal(gets(), 0, `${keep}: no run of the view walked (${gets()} reads of their starts)`);
    // Handed out as one slab of the view, each row placed as it was read.
    reads.length = 0;
    const placed = new Float32Array(kept.length * width);
    let slabs = 0;
    for await (const slab of view.readInSourceOrder([[0, kept.length], ...columns])) {
      slabs++;
      assert.equal(slabRowCount(slab.runs), kept.length);
      scatterRows(slab.values, width, slab.runs, placed, 0);
    }
    assert.equal(slabs, 1, `${keep}: one slab, in view order`);
    assert.deepEqual(Array.from(placed), Array.from(values), `${keep}: the same rows in their places`);
    assert.deepEqual(reads, [[0, rows]], `${keep}: again one read of the stretch`);
    // Priced as what it reads: the chunks its rows lie in.
    assert.equal(await view.storedBytes([[0, kept.length], ...columns]), rows * width * 4);
  }
});

test('a view of long runs (every cell in a blocks order) keeps the pass over pieces: no row ordered, its runs copied whole', async () => {
  const rows = 4000;
  const block = 400;
  // Every row, in blocks of 400 rows in a shuffled block order.
  const blocks = shuffledShare(rows / block, 1).map(b => b);
  const kept = new Uint32Array(rows);
  let at = 0;
  for (const b of blocks) for (let r = b * block; r < (b + 1) * block; r++) kept[at++] = r;
  const { real, reads } = countedArray(rows, 3, 200);
  const runs = new CellRows(kept, rows).runs();
  let ordered = 0;
  const view = gatheredArray(real, { ...runs, byRow: () => { ordered++; return runs.byRow(); } }, { mergeGapBytes: () => 0, chunks: new DecodedChunks(0) });
  const values = await view.read([[0, rows], [0, 3]]);
  for (let v = 0; v < rows; v += 97) assert.equal(values[v * 3 + 2], kept[v] * 10 + 2, `view row ${v}`);
  assert.equal(ordered, 0, 'no row ordered by file row');
  assert.equal(reads.length, rows / 200, 'each chunk once');
  await view.storedBytes([[0, rows], [0, 3]]);
  for await (const slab of view.readInSourceOrder([[0, rows], [0, 3]])) assert.equal(slab.runs.rows, undefined, 'handed out as runs');
  assert.equal(ordered, 0, 'nor to price or hand out its rows');
});

test('a share that leaves a chunk unread reads only the chunks its rows lie in, and a part of the view keeps the pass over pieces', async () => {
  const rows = 2000;
  const chunkRows = 50;
  // Blocks: every other chunk's rows, shuffled.
  const blocks = [];
  for (let chunk = 0; chunk < rows / chunkRows; chunk += 2) for (let row = chunk * chunkRows; row < (chunk + 1) * chunkRows; row++) blocks.push(row);
  const kept = Uint32Array.from(blocks.reverse());
  const { real, reads } = countedArray(rows, 2, chunkRows);
  const view = gatheredArray(real, new CellRows(kept, rows).runs(), { mergeGapBytes: () => 0, chunks: new DecodedChunks(0) });
  const values = await view.read([[0, kept.length], [0, 2]]);
  kept.forEach((row, v) => assert.equal(values[v * 2 + 1], row * 10 + 1, `view row ${v}`));
  assert.equal(reads.length, rows / chunkRows / 2, 'the chunks its rows lie in, no other');
  // A part of a uniform share's view: its own pass, the chunks that part lies in.
  const spread = shuffledShare(rows, 0.5);
  const part = gatheredArray(countedArray(rows, 1, chunkRows).real, new CellRows(spread, rows).runs(), { mergeGapBytes: () => 0, chunks: new DecodedChunks(0) });
  const some = await part.read([[10, 20]]);
  assert.deepEqual(Array.from(some), Array.from(spread.subarray(10, 20), row => row * 10));
});

test('a column of a uniform share read through the reader: the rows every cell reads, each obsm and obs chunk once, the values of its cells', async () => {
  const { annData, categorical, countingStore, dataFrame, dense, mapping, strings } = await import('./helpers/anndata-store.mjs');
  const { openZarr } = await import('../assets/js/formats/zarr/index.js');
  const { AnnDataReader } = await import('../assets/js/data/anndata/reader.js');
  const { ZARR_FORMAT } = await import('../assets/js/data/anndata/elements.js');
  const cells = 40_000;
  const umap = Float32Array.from({ length: cells * 2 }, (_, i) => i / 2);
  const codes = Int8Array.from({ length: cells }, (_, i) => (i * 7) % 5);
  const tree = annData({
    obs: dataFrame({
      _index: strings(Array.from({ length: cells }, (_, i) => `c${i}`), { chunks: [4000] }),
      kind: categorical(codes, ['a', 'b', 'c', 'd', 'e']),
    }),
    var: dataFrame({ _index: strings(['g0']) }),
    obsm: mapping({ X_umap: dense(umap, [cells, 2], { chunks: [2000, 2], compressed: true }) }),
  });
  tree.children.obs.children.kind.children.codes.chunks = [2500];
  const open = async cellSubset => {
    const counting = countingStore(tree);
    const reader = new AnnDataReader();
    await reader.open(await openZarr(counting.store, { decodedChunkCacheBytes: 0 }), { format: ZARR_FORMAT, name: 'spread.zarr', cellSubset });
    const names = await reader.readObsNames();
    const before = counting.fetched.length;
    const embedding = await reader.readObsmColumns('X_umap', [0, 1]);
    const field = await reader.getObsField('kind');
    const fetched = counting.fetched.slice(before).filter(key => /^(obsm\/X_umap|obs\/kind\/codes)\//.test(key));
    reader.close();
    return { names, embedding, field, fetched };
  };
  const every = await open({ mode: 'all' });
  for (const fraction of [0.5, 0.2]) {
    const share = await open({ mode: 'subsample', method: 'uniform', fraction, seed: 1 });
    assert.ok(share.names.length < cells, `${fraction}: a share`);
    share.names.forEach((name, i) => {
      const cell = Number(String(name).slice(1));
      assert.equal(share.embedding[2 * i], umap[2 * cell], `${fraction} ${name} x`);
      assert.equal(share.embedding[2 * i + 1], umap[2 * cell + 1], `${fraction} ${name} y`);
      assert.equal(share.field.categories[share.field.codes[i]], ['a', 'b', 'c', 'd', 'e'][codes[cell]], `${fraction} ${name} kind`);
    });
    assert.deepEqual([...share.fetched].sort(), [...every.fetched].sort(), `${fraction}: every cell's chunks, each once`);
  }
});

test('runs are ordered by source row in linear time, equal starts in position order, rows past 2^32 included', () => {
  const big = 2 ** 32;
  const starts = Float64Array.from([big + 5, 3, big + 1, 7, 7, 2 * big]);
  const ends = Float64Array.from([big + 6, 4, big + 2, 7, 8, 2 * big + 1]);
  const offsets = Float64Array.from([0, 1, 2, 3, 3, 4, 5]);
  const runs = { count: 6, starts, ends, offsets };
  const { order } = planBoxes(runs, 0, 5, { chunkRows: null, rowBytes: 4, mergeGapBytes: 0, boxed: false });
  // 3, then the empty run at 7 before the one at 7 (position order), then 2^32 + 1, 2^32 + 5, 2^33.
  assert.deepEqual(Array.from(order), [1, 3, 4, 2, 0, 5]);
  // A share's many single-row runs: ascending by row.
  const kept = shuffledShare(100_000, 0.5);
  const shuffled = planBoxes(runsOfPositions(kept), 0, kept.length, { chunkRows: null, rowBytes: 4, mergeGapBytes: 0, boxed: false });
  for (let k = 1; k < shuffled.order.length; k++) assert.ok(shuffled.pieceStarts[shuffled.order[k]] > shuffled.pieceStarts[shuffled.order[k - 1]], `piece ${k}`);
});

test('pricing a share\'s first gene passes over rows in chunks already counted: the same price, a few lookups a chunk', async () => {
  const { rowChunks } = await import('../assets/js/data/anndata/subsample-plan.js');
  const rows = Uint32Array.from(shuffledShare(100_000, 0.5)).sort();
  // Elements of a row: about 8, more for some rows (never decreasing).
  const elementOf = row => row * 8 + Math.floor(row / 7);
  let lookups = 0;
  const counted = row => {
    lookups++;
    return elementOf(row);
  };
  const chunkElements = 4096;
  const priced = rowChunks(rows, counted, chunkElements, 1);
  // Every row's chunks, one by one.
  const touched = new Set();
  for (const row of rows) for (let c = Math.floor(elementOf(row) / chunkElements); c <= Math.floor((elementOf(row + 1) + 1 - 1) / chunkElements); c++) touched.add(c);
  const sorted = [...touched].sort((x, y) => x - y);
  const runs = sorted.filter((c, i) => i === 0 || c !== sorted[i - 1] + 1).length;
  assert.deepEqual(priced, { chunks: touched.size, runs, kept: 0, gaps: 0 });
  let spans = 0;
  for (let i = 0; i < rows.length; i++) if (i === 0 || rows[i] !== rows[i - 1] + 1) spans++;
  assert.ok(lookups < spans / 2, `${lookups} lookups for ${spans} spans of ${touched.size} chunks`);
});

test('putting a grown share in its order places each cell by the bits of the open cells: one read of the kept cells, not a search a cell', async () => {
  const { createCellIdentity } = await import('../assets/js/data/cell-identity.js');
  const nObs = 200_000;
  const kept = Uint32Array.from(shuffledShare(nObs, 0.5)).sort();
  let reads = 0;
  const counted = new Proxy(kept, {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  // The open cells in a chunk order (before) and the same cells in priority order (after).
  const before = createCellIdentity({ nObs, kept: counted, openOrder: shuffledShare(nObs, 1, 3).filter((row, i, all) => kept[Math.min(kept.length - 1, lowerBound(kept, row))] === row) });
  const after = Uint32Array.from(kept);
  for (let i = after.length - 1; i > 0; i--) { const j = (i * 7919) % (i + 1); [after[i], after[j]] = [after[j], after[i]]; }
  reads = 0;
  const positions = before.openPositionsOf(after);
  for (let j = 0; j < after.length; j += 101) assert.equal(before.originalAt(positions[j]), after[j], `cell ${j}`);
  assert.ok(reads <= 2 * kept.length, `${reads} reads of ${kept.length} kept cells`);
  // A few cells: a search each, no pass over the kept cells.
  const few = createCellIdentity({ nObs, kept: Uint32Array.from(kept) });
  assert.deepEqual(Array.from(few.openPositionsOf(Uint32Array.from([kept[9], kept[3], 1 + kept[0]]))), [9, 3, kept[1] === kept[0] + 1 ? 1 : -1]);
});

/** The first index of ascending `values` at or above `value`. */
function lowerBound(values, value) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
