/**
 * Levels of detail admit cells in their priority order (data/cell-priority.js):
 * the uniform rank of the subsampling specification. So every reduced level
 * is a uniform random sample of the open cells, and with frustum culling
 * each unit in view draws its own share of the same sample.
 *
 * - The priority order is the cells sorted by rank (an independent oracle),
 *   and a priority-ordered file's open order is it already.
 * - A level of `m` cells is exactly the uniform subsample of size `m` under
 *   the same seed (`subsampleUniform`), so levels and subsamples agree.
 * - On a cloud stored sorted by category, with categories in separate
 *   places, every level and every culled view draws the categories in the
 *   proportions of the cells they stand for, within sampling error.
 * - `cellPriorityOf` reads the order an opening presents its cells in;
 *   `priorityPrefix` is a prefix of the same order.
 * - A renderer's levels follow the priority it is given: levels built under
 *   another are dropped, trees without levels are kept, and a build that
 *   lands under a priority since replaced is not installed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CELL_PRIORITY,
  OPEN_ORDER_PRIORITY,
  buildPriorityOrder,
  cellPriorityOf,
  priorityPrefix,
  rankedCellPriority,
  reviveCellPriority,
} from '../assets/js/data/cell-priority.js';
import { rankOf, subsampleUniform } from '../assets/js/data/subsample.js';
import { buildSpatialTreeJob } from '../assets/js/rendering/high-perf/spatial-tree-job.js';
import { SpatialIndex } from '../assets/js/rendering/high-perf/spatial-index.js';
import { HighPerfRenderer } from '../assets/js/rendering/high-perf-renderer.js';
import { getNotificationCenter } from '../assets/js/app/notification-center.js';

function silenceCalculationNotifications(t) {
  const notifications = getNotificationCenter();
  const previous = {
    completeCalculation: notifications.completeCalculation,
    failCalculation: notifications.failCalculation,
    dismiss: notifications.dismiss,
    hasNotification: notifications.hasNotification,
    startCalculation: notifications.startCalculation,
  };
  Object.assign(notifications, {
    completeCalculation() {},
    failCalculation() {},
    dismiss() {},
    hasNotification: () => true,
    startCalculation: () => 'lod-priority-test',
  });
  t.after(() => Object.assign(notifications, previous));
}

function rankOracle(n, seed, originals = null) {
  return Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => rankOf(seed, originals === null ? a : originals[a]) - rankOf(seed, originals === null ? b : originals[b]));
}

test('the priority order is the open cells sorted by rank, or open order itself', () => {
  for (const n of [0, 1, 2, 3, 999, 65_537]) {
    for (const seed of [0, 1, 0xdeadbeef, 0xffffffff]) {
      assert.deepEqual(Array.from(buildPriorityOrder(n, rankedCellPriority(seed))), rankOracle(n, seed), `n ${n} seed ${seed}`);
      const originals = Uint32Array.from({ length: n }, (_, i) => (i * 2654435761 + 17) >>> 0);
      assert.deepEqual(
        Array.from(buildPriorityOrder(n, rankedCellPriority(seed, originals))),
        rankOracle(n, seed, originals),
      );
    }
    assert.deepEqual(Array.from(buildPriorityOrder(n, OPEN_ORDER_PRIORITY)), Array.from({ length: n }, (_, i) => i));
  }
  assert.equal(rankedCellPriority(0), DEFAULT_CELL_PRIORITY);
  assert.equal(reviveCellPriority({ seed: null, originals: null }), OPEN_ORDER_PRIORITY);
  assert.throws(() => buildPriorityOrder(4, { seed: 0, originals: null }), /frozen/);
  assert.throws(() => buildPriorityOrder(4, rankedCellPriority(0, new Uint32Array(3))), /3 cells/);
});

test('a level of m cells is the uniform subsample of size m under the same seed', () => {
  const n = 50_000;
  for (const seed of [0, 42]) {
    const order = buildPriorityOrder(n, rankedCellPriority(seed));
    for (const m of [1, 1_000, 1_137, 12_345, 49_999]) {
      const level = Array.from(order.subarray(0, m)).sort((a, b) => a - b);
      assert.deepEqual(level, Array.from(subsampleUniform(n, m, seed)), `m ${m}`);
    }
  }
});

/**
 * A cloud stored the way an atlas usually is: sorted by cell type, each type
 * in its own place, with very unequal sizes (one type is 0.5 % of the cells).
 */
function sortedAtlas(n, dimension) {
  const shares = [0.4, 0.25, 0.2, 0.1, 0.045, 0.005];
  const codes = new Uint8Array(n);
  const positions = new Float32Array(n * dimension);
  let state = 12345;
  const random = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 2 ** 32;
  };
  let cell = 0;
  shares.forEach((share, code) => {
    const count = code === shares.length - 1 ? n - cell : Math.round(share * n);
    for (let i = 0; i < count; i++, cell++) {
      codes[cell] = code;
      for (let axis = 0; axis < dimension; axis++) {
        positions[cell * dimension + axis] = code * 3 + (axis === 0 ? 0 : code) + random();
      }
    }
  });
  return { positions, codes, categories: shares.length };
}

function proportions(cells, codes, categories) {
  const counts = new Float64Array(categories);
  for (const cell of cells) counts[codes[cell]]++;
  return Array.from(counts, count => count / cells.length);
}

/** Largest category-share difference against the bound of 5 standard errors (finite population). */
function assertRepresentative(cells, population, codes, categories, label) {
  const drawn = proportions(cells, codes, categories);
  const truth = proportions(population, codes, categories);
  const m = cells.length;
  const N = population.length;
  for (let code = 0; code < categories; code++) {
    const p = truth[code];
    const bound = 5 * Math.sqrt((p * (1 - p) / m) * ((N - m) / Math.max(1, N - 1))) + 1e-12;
    assert.ok(
      Math.abs(drawn[code] - p) <= bound,
      `${label}: category ${code} drawn ${drawn[code].toFixed(4)} of ${m}, population ${p.toFixed(4)} (bound ${bound.toFixed(4)})`,
    );
  }
}

for (const dimension of [2, 3]) {
  test(`${dimension}D: every level draws the categories in their population shares, culled or not`, () => {
    const n = 60_000;
    const { positions, codes, categories } = sortedAtlas(n, dimension);
    const { tree, order } = buildSpatialTreeJob({
      positions, dimensionLevel: dimension, maxPointsPerNode: 256, maxDepth: 8, buildLOD: true, priority: DEFAULT_CELL_PRIORITY,
    });
    const index = new SpatialIndex(positions, null, dimension, 256, 8, { buildLOD: true, prebuiltTree: tree, prebuiltOrder: order });
    const everyCell = Uint32Array.from({ length: n }, (_, i) => i);
    const stride = order.leafCount + 1;
    // The units of one category's place: a culled view of the cloud.
    const unitsInView = [];
    for (let unit = 0; unit < order.leafCount; unit++) {
      const start = order.leafOffsets[(order.bandCount - 1) * stride + unit];
      const end = order.leafOffsets[(order.bandCount - 1) * stride + unit + 1];
      if (end > start && codes[order.indices[start]] <= 1) unitsInView.push(unit);
    }
    assert.ok(unitsInView.length > 1);
    for (let level = 0; level < index.lodLevels.length - 1; level++) {
      const drawn = index.lodLevels[level].indices;
      assertRepresentative(drawn, everyCell, codes, categories, `level ${level}`);
      // Culled: the units in view at this level draw their own cells of the
      // level's sample (bands 0..level of each unit), and those are a uniform
      // sample of the cells in view.
      const inView = [];
      const drawnInView = [];
      for (const unit of unitsInView) {
        for (let band = 0; band < order.bandCount; band++) {
          const start = order.leafOffsets[band * stride + unit];
          const end = order.leafOffsets[band * stride + unit + 1];
          for (let at = start; at < end; at++) {
            inView.push(order.indices[at]);
            if (band <= level) drawnInView.push(order.indices[at]);
          }
        }
      }
      const levelSet = new Uint8Array(n);
      for (const cell of drawn) levelSet[cell] = 1;
      assert.deepEqual(
        drawnInView.slice().sort((a, b) => a - b),
        inView.filter(cell => levelSet[cell] === 1).sort((a, b) => a - b),
        'a culled level is the level restricted to the view',
      );
      assertRepresentative(drawnInView, inView, codes, categories, `level ${level}, culled`);
    }
  });
}

test('the share check sees a biased level: file order of a sorted atlas is not a sample', () => {
  const n = 60_000;
  const { positions, codes, categories } = sortedAtlas(n, 2);
  // Open order taken as the priority of a file that is not priority-ordered:
  // its first rows are the first categories only.
  const { order } = buildSpatialTreeJob({
    positions, dimensionLevel: 2, maxPointsPerNode: 256, maxDepth: 8, buildLOD: true, priority: OPEN_ORDER_PRIORITY,
  });
  const everyCell = Uint32Array.from({ length: n }, (_, i) => i);
  assert.throws(
    () => assertRepresentative(order.indices.subarray(0, order.bandEnds[0]), everyCell, codes, categories, 'level 0'),
    /category \d drawn/,
  );
});

test('a priority-ordered file draws its first rows at every level', () => {
  const n = 20_000;
  const { positions } = sortedAtlas(n, 2);
  const { order } = buildSpatialTreeJob({
    positions, dimensionLevel: 2, maxPointsPerNode: 128, maxDepth: 8, buildLOD: true, priority: OPEN_ORDER_PRIORITY,
  });
  for (let band = 0; band < order.bandCount; band++) {
    const prefix = Array.from(order.indices.subarray(0, order.bandEnds[band])).sort((a, b) => a - b);
    assert.deepEqual(prefix, Array.from({ length: order.bandEnds[band] }, (_, i) => i));
  }
  // The priority crosses to the worker as a plain message.
  const ranked = rankedCellPriority(9, Uint32Array.from({ length: n }, (_, i) => n - 1 - i));
  const { order: crossed } = buildSpatialTreeJob({
    positions, dimensionLevel: 2, maxPointsPerNode: 128, maxDepth: 8, buildLOD: true,
    priority: structuredClone({ seed: ranked.seed, originals: ranked.originals }),
  });
  const expected = buildPriorityOrder(n, ranked);
  const first = order.bandEnds[0];
  assert.deepEqual(
    Array.from(crossed.indices.subarray(0, first)).sort((a, b) => a - b),
    Array.from(expected.subarray(0, first)).sort((a, b) => a - b),
  );
});

test('an opening says how its cells are ordered', () => {
  // A file Cellucid did not write, every cell open: ranked under the default seed.
  assert.equal(cellPriorityOf(null), DEFAULT_CELL_PRIORITY);
  assert.equal(cellPriorityOf({ ordered: false, spec: null, openOrder: null, kept: null }), DEFAULT_CELL_PRIORITY);
  // A priority-ordered file opened whole, or by a prefix; a cell-level subsample.
  assert.equal(cellPriorityOf({ ordered: true, spec: null, openOrder: new Uint32Array(3), kept: null }), OPEN_ORDER_PRIORITY);
  for (const method of ['uniform', 'stratified', 'spatial']) {
    assert.equal(cellPriorityOf({ ordered: true, spec: { method, seed: 5 }, openOrder: new Uint32Array(3) }), OPEN_ORDER_PRIORITY);
  }
  // Blocks open in run order: their cells are ranked one by one.
  const openOrder = Uint32Array.from([40, 41, 42, 7, 8]);
  const blocks = cellPriorityOf({ ordered: true, spec: { method: 'blocks', seed: 5, blockSize: 3 }, openOrder });
  assert.equal(blocks.seed, 5);
  assert.equal(blocks.originals, openOrder);
  assert.deepEqual(Array.from(buildPriorityOrder(5, blocks)), rankOracle(5, 5, openOrder));
});

test('a priority prefix is a prefix of the priority order', () => {
  const n = 40_000;
  const cells = Uint32Array.from({ length: n }, (_, i) => i);
  for (const priority of [DEFAULT_CELL_PRIORITY, rankedCellPriority(3, Uint32Array.from(cells, i => i * 7 + 1)), OPEN_ORDER_PRIORITY]) {
    const order = buildPriorityOrder(n, priority);
    for (const m of [0, 1, 400, 4_000, n]) {
      const prefix = priorityPrefix(priority, n, m);
      const kept = prefix.filter(cells);
      // Exactly the first `kept.length` cells of the order.
      assert.deepEqual(Array.from(kept), Array.from(order.subarray(0, kept.length)).sort((a, b) => a - b));
      // About m of them: within 5 standard deviations of a Bernoulli count.
      assert.ok(Math.abs(kept.length - m) <= 5 * Math.sqrt(m) + 1, `m ${m}: ${kept.length}`);
      if (priority === OPEN_ORDER_PRIORITY) assert.equal(kept.length, m);
    }
  }
});

test('a renderer rebuilds its levels under a new priority and keeps its plain trees', () => {
  const positions = new Float32Array(3_000 * 2);
  for (let i = 0; i < positions.length; i++) positions[i] = (i * 0.61803) % 1;
  const withLevels = new SpatialIndex(positions, null, 2, 64, 8, { buildLOD: true });
  const plain = new SpatialIndex(positions, null, 2, 64, 8, { buildLOD: false });
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    pointCount: 3_000,
    _positions: positions,
    _cellPriority: DEFAULT_CELL_PRIORITY,
    spatialIndices: new Map([[2, withLevels], [3, plain]]),
    snapshotBuffers: new Map(),
    _snapshotGeometryPools: new Map(),
  });
  let frames = 0;
  renderer.onAsyncTreeReady = () => { frames += 1; };
  renderer.setCellPriority(DEFAULT_CELL_PRIORITY);
  assert.equal(renderer.spatialIndices.size, 2, 'the same priority changes nothing');
  renderer.setCellPriority(OPEN_ORDER_PRIORITY);
  assert.equal(renderer.getCellPriority(), OPEN_ORDER_PRIORITY);
  assert.deepEqual([...renderer.spatialIndices.keys()], [3]);
  assert.equal(frames, 1, 'a frame asks for the levels again');
  assert.throws(() => renderer.setCellPriority(rankedCellPriority(1, new Uint32Array(5))), /5 cells/);
  // A plain tree whose order is one band (made under a ranked priority) is
  // dropped once the cells are in priority order: a store holding it could
  // neither draw levels by rank nor take the next order band by band.
  renderer.setCellPriority(DEFAULT_CELL_PRIORITY);
  plain.ensureDrawOrder();
  assert.equal(plain.drawOrder.ranked, false);
  renderer.spatialIndices = new Map([[3, plain]]);
  renderer.setCellPriority(OPEN_ORDER_PRIORITY);
  assert.equal(renderer.spatialIndices.size, 0);
});

test('a build that lands under a priority since replaced is not installed', t => {
  silenceCalculationNotifications(t);
  const positions = new Float32Array(2_000 * 2);
  for (let i = 0; i < positions.length; i++) positions[i] = (i * 0.414) % 1;
  const jobs = [];
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    pointCount: 2_000,
    _positions: positions,
    _colors: new Uint8Array(2_000 * 4),
    _cellPriority: DEFAULT_CELL_PRIORITY,
    currentDimensionLevel: 2,
    options: { LOD_MAX_DEPTH: 8, LOD_MAX_POINTS_PER_NODE: 64 },
    spatialIndices: new Map(),
    snapshotBuffers: new Map(),
    _snapshotGeometryPools: new Map(),
  });
  renderer._buildSpatialTreeJob = (jobPositions, dimensionLevel, buildLOD, priority, onDone, onError, onCancel) => {
    jobs.push({ jobPositions, dimensionLevel, buildLOD, priority, onDone, onError, onCancel });
  };
  let asked = 0;
  renderer.onAsyncTreeReady = () => { asked += 1; };
  const settled = [];
  renderer._requestSpatialIndex({ kind: 'live' }, true, installed => settled.push(installed));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].priority, DEFAULT_CELL_PRIORITY);
  renderer.setCellPriority(OPEN_ORDER_PRIORITY);
  // A request under the new priority does not wait for the stale build.
  const errors = [];
  renderer._requestSpatialIndex({ kind: 'live' }, true, (_installed, error) => { if (error) errors.push(error); });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1].priority, OPEN_ORDER_PRIORITY);
  jobs[0].onDone(buildSpatialTreeJob({ positions, dimensionLevel: 2, maxPointsPerNode: 64, maxDepth: 8, buildLOD: true, priority: jobs[0].priority }));
  assert.equal(renderer.spatialIndices.size, 0, 'the stale levels are not installed');
  assert.deepEqual(settled, [false]);
  assert.ok(asked >= 1);
  jobs[1].onDone(buildSpatialTreeJob({ positions, dimensionLevel: 2, maxPointsPerNode: 64, maxDepth: 8, buildLOD: true, priority: jobs[1].priority }));
  assert.deepEqual(errors, []);
  const installed = renderer.spatialIndices.get(2);
  assert.ok(installed);
  const first = installed.drawOrder.bandEnds[0];
  assert.deepEqual(
    Array.from(installed.drawOrder.indices.subarray(0, first)).sort((a, b) => a - b),
    Array.from({ length: first }, (_, i) => i),
  );
});
