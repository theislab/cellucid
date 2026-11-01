/**
 * Every cell opens as fast as it did before gene samples and cell orders
 * (lead 2026-10-30, "every-cell opening parity"): what an opening of every
 * cell does that it did not before is counted here.
 *
 * - Every cell in a `blocks` order finds its runs a block at a time
 *   (`subsample-plan.js` `blockOrderRuns`), and the open cells' rows take
 *   them (`cell-subset.js` `noteRunsOf`): no walk of 10M positions, twice.
 * - An embedding's display bounds, every cell placed, are the transform of
 *   its stored bounds (`embedding-payload.js` `coordinatesOfPieces`): no
 *   pass over the coordinates for them.
 * - An embedding's cell-order sums are taken after its payload is handed
 *   over (`EmbeddingPayloads._deferSums`), and a digest asked at once
 *   takes them without reading anything again.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CellRows, noteRunsOf, runsOfPositions } from '../assets/js/data/anndata/views/cell-subset.js';
import { blockOrderRuns } from '../assets/js/data/anndata/subsample-plan.js';
import { blocksPriorityOrder } from '../assets/js/data/subsample.js';
import { EmbeddingPayloads, embeddingPayloadOf } from '../assets/js/data/embedding-payload.js';
import { cellOrderDigest } from '../assets/js/data/cell-order-digest.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';

/** `array`, its element reads counted (`reads.count`). */
function counted(array) {
  const reads = { count: 0 };
  const proxy = new Proxy(array, {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads.count++;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { proxy, reads };
}

function plain(runs) {
  return {
    count: runs.count,
    starts: Array.from(runs.starts.subarray(0, runs.count)),
    ends: Array.from(runs.ends.subarray(0, runs.count)),
    offsets: Array.from(runs.offsets.subarray(0, runs.count + 1)),
  };
}

test('every cell in a blocks order: its runs found a block at a time, exactly the walk\'s', () => {
  for (const [nObs, blockSize, seed] of [[100_000, 4096, 0], [100_003, 4096, 7], [65_536, 65_536, 0], [10, 3, 1], [1, 4, 0], [50_000, 1, 0]]) {
    const order = blocksPriorityOrder(nObs, seed, blockSize);
    const { proxy, reads } = counted(order);
    const runs = blockOrderRuns(proxy, nObs, blockSize);
    assert.deepEqual(plain(runs), plain(runsOfPositions(order)), `${nObs} cells in blocks of ${blockSize}`);
    assert.ok(reads.count <= Math.ceil(nObs / blockSize), `${reads.count} positions read for ${Math.ceil(nObs / blockSize)} blocks`);
  }
});

test('the open cells\' rows take the runs noted with their list: no position walked', () => {
  const nObs = 50_000;
  const order = blocksPriorityOrder(nObs, 0, 1024);
  const { proxy, reads } = counted(order);
  noteRunsOf(proxy, blockOrderRuns(order, nObs, 1024));
  const rows = new CellRows(proxy, nObs);
  const runs = rows.runs();
  assert.equal(reads.count, 0, 'runs taken, not walked');
  assert.deepEqual(plain(runs), plain(runsOfPositions(order)));
  // Rows made of the same list again walk it (the runs were taken once).
  const again = counted(order);
  new CellRows(again.proxy, nObs).runs();
  assert.ok(again.reads.count >= nObs);
});

/** The bounds a pass over the coordinates finds (the placed ones). */
function scannedBounds(positions, width) {
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  for (let axis = 0; axis < width; axis++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = axis; i < positions.length; i += width) {
      if (positions[i] < lo) lo = positions[i];
      if (positions[i] > hi) hi = positions[i];
    }
    min[axis] = lo;
    max[axis] = hi;
  }
  return { min, max };
}

test('an embedding whose every cell is placed: its bounds are the transform of the stored ones, bit for bit', () => {
  const random = createMulberry32(11);
  for (const Type of [Float32Array, Float64Array]) {
    for (const width of [1, 2, 3]) {
      for (const normalize of [true, false]) {
        for (const spread of [1e-3, 1, 7919.5, 3e6]) {
          const values = Type.from({ length: 997 * width }, () => (random() - 0.37) * spread);
          const payload = embeddingPayloadOf(values, width, normalize);
          assert.equal(payload.defect, null);
          assert.equal(payload.unplacedCount, 0);
          assert.deepEqual(payload.bounds, scannedBounds(payload.positions, width), `${Type.name} ${width}-D normalize ${normalize} spread ${spread}`);
        }
      }
    }
  }
  // A cell not placed: its bounds are still found over the placed cells.
  const holed = Float32Array.from([0, 0, Number.NaN, 5, 2, 3, -4, 1]);
  const payload = embeddingPayloadOf(holed, 2, true);
  assert.equal(payload.unplacedCount, 1);
  const placed = payload.positions.filter((_, i) => i !== 2 && i !== 3);
  assert.deepEqual(payload.bounds, scannedBounds(placed, 2));
});

test('an embedding\'s payload goes out before its cell-order sums; a digest asked at once reads nothing again', async () => {
  const n = 5000;
  const stored = Float32Array.from({ length: n * 2 }, (_, i) => Math.fround(Math.sin(i) * 100));
  let reads = 0;
  const payloads = new EmbeddingPayloads(async (key, columns, { rows = null } = {}) => {
    reads++;
    const [a, b] = rows ?? [0, n];
    return stored.slice(a * 2, b * 2);
  }, { cellNames: async cells => cells.map(cell => `cell${cell}`), cellCount: () => n, originals: () => null, pieceCells: 1024 });
  await payloads.embedding('X_umap', [0, 1], true);
  const readsForPayload = reads;
  assert.equal(payloads._sums.size, 0, 'no cell summed before the payload is handed over');
  assert.equal(await payloads.cellOrderDigest('X_umap', [0, 1]), cellOrderDigest(stored, 2));
  assert.equal(reads, readsForPayload, 'the digest read nothing again');
  // Left alone, the sums are taken after the payload's task, a slice of
  // 262,144 rows a task: a request arriving meanwhile is answered between
  // slices, not behind every cell's sums.
  const many = 3 * 262_144 + 17;
  const large = Float32Array.from({ length: many * 2 }, (_, i) => Math.fround(Math.cos(i) * 50));
  const later = new EmbeddingPayloads(async () => large.slice(), { cellNames: async cells => cells.map(cell => `cell${cell}`), cellCount: () => many });
  await later.embedding('X_umap', [0, 1], true);
  assert.equal(later._deferred.length, 4, 'four slices left for later tasks');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(later._deferred.length, 3, 'one slice a task');
  assert.equal(later._sums.get(JSON.stringify(['X_umap', [0, 1]])).covered, 262_144);
  while (later._deferred.length > 0) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(await later.cellOrderDigest('X_umap', [0, 1]), cellOrderDigest(large, 2), 'the sliced sums are the whole read\'s');
});

test('a large share\'s rows in file order and the view row of each: one table pass, the radix order\'s result', async () => {
  const { orderByKey } = await import('../assets/js/utils/radix-order.js');
  const { subsampleUniform, priorityOrder } = await import('../assets/js/data/subsample.js');
  const nObs = 200_000;
  for (const k of [100_000, 30_000, 5_000]) {
    const spec = { method: 'uniform', seed: 3, k };
    const open = priorityOrder(spec, subsampleUniform(nObs, k, 3));
    const { proxy, reads } = counted(open);
    const rows = new CellRows(proxy, nObs);
    rows.ascending();
    reads.count = 0;
    const { order, rows: ascending } = rows.byRow();
    assert.deepEqual(Array.from(order), Array.from(orderByKey(open)), `${k} of ${nObs}`);
    assert.deepEqual(Array.from(ascending.kept), Array.from(open).sort((a, b) => a - b));
    // A share of more than an eighth of the axis: one read a row (its table);
    // fewer: the radix order (two counting and two scattering passes).
    if (8 * k >= nObs) assert.ok(reads.count <= k, `${reads.count} reads of ${k} rows`);
  }
  // Rows already ascending are their own order: nothing read.
  const ascendingRows = Uint32Array.from({ length: 1000 }, (_, i) => 3 * i);
  const own = counted(ascendingRows);
  const plainRows = new CellRows(own.proxy, 3000);
  plainRows.ascending();
  own.reads.count = 0;
  assert.deepEqual(Array.from(plainRows.byRow().order), Array.from({ length: 1000 }, (_, i) => i));
  assert.equal(own.reads.count, 0);
});

test('the gene sample\'s fit reads only the cells of each count it prices, in sequence', async () => {
  const { prefixRowsOf } = await import('../assets/js/data/anndata/subsample-plan.js');
  const { subsampleUniform, priorityOrder } = await import('../assets/js/data/subsample.js');
  const nObs = 200_000;
  const k = 100_000;
  const open = priorityOrder({ method: 'uniform', seed: 5, k }, subsampleUniform(nObs, k, 5));
  const { proxy, reads } = counted(open);
  const rowsOf = prefixRowsOf(proxy, nObs);
  for (const [count, from] of [[k, 0], [60_000, 0], [60_000, 20_000], [3_000, 0], [40, 10]]) {
    reads.count = 0;
    const rows = rowsOf(count, from);
    assert.deepEqual(Array.from(rows), Array.from(open.slice(from, count)).sort((a, b) => a - b), `cells ${from} to ${count}`);
    // One read a cell of the count (the open cells before it and after it untouched).
    assert.ok(reads.count <= count - from, `${reads.count} reads for ${count - from} cells`);
  }
});

test('a share\'s estimated chunk share at opening: a few looks a chunk, the walk\'s share exactly', async () => {
  const { estimatedChunkShare, keptChunkShare } = await import('../assets/js/data/anndata/views/cell-subset.js');
  const { subsampleUniform, subsampleBlocks } = await import('../assets/js/data/subsample.js');
  for (const nRows of [1000, 77_777]) {
    for (const perRow of [1, 1.3, 7.9, 100]) {
      for (const chunkElements of [7, 64, 1000, 65_536]) {
        for (const share of [0.001, 0.3, 0.9]) {
          const k = Math.max(1, Math.floor(nRows * share));
          for (const rows of [subsampleUniform(nRows, k, 3), subsampleBlocks(nRows, k, 3, 50)]) {
            const nnz = Math.round(nRows * perRow);
            const at = row => Math.min(nnz, Math.round(row * (nnz / nRows)));
            assert.equal(estimatedChunkShare(rows, nRows, nnz, chunkElements), keptChunkShare({ at }, rows, chunkElements, nnz), `${nRows} rows, ${perRow} a row, chunks of ${chunkElements}, ${share}`);
          }
        }
      }
    }
  }
  // Few chunks, many rows: the rows are looked at a few times a chunk, not walked.
  const nRows = 400_000;
  const rows = subsampleUniform(nRows, nRows / 2, 9);
  const { proxy, reads } = counted(rows);
  estimatedChunkShare(proxy, nRows, nRows * 20, 1_000_000);
  // One pass to check they ascend (two reads a row), then about log2(rows)
  // a chunk; the walk read every row once more on top.
  assert.ok(reads.count < 2 * rows.length + 8 * 40, `${reads.count} reads of ${rows.length} rows in 8 chunks`);
});

test('the page takes the worker\'s count of unplaced cells: no pass over the positions for it', async () => {
  const { publishUnplacedCount, unplacedCountOf } = await import('../assets/js/rendering/unplaced-positions.js');
  const positions = Float32Array.from([0, 0, Number.NaN, Number.NaN, 1, 1]);
  const { proxy, reads } = counted(positions);
  publishUnplacedCount(proxy, 1);
  assert.equal(unplacedCountOf(proxy, 2), 1);
  assert.equal(reads.count, 0);
  // Not published: counted once, by a pass.
  const other = counted(Float32Array.from([0, 0, Number.NaN, Number.NaN]));
  assert.equal(unplacedCountOf(other.proxy, 2), 1);
  assert.equal(other.reads.count, 2);
  assert.throws(() => publishUnplacedCount(positions, -1), RangeError);
});
