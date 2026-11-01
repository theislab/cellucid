/**
 * Cells an embedding does not place (K-03): NaN positions in every axis are
 * the one mark (rendering/unplaced-positions.js). They are in no tree, in
 * no bound, never on the GPU as NaN, and every vertex shader that reads a
 * cell's position rejects their stand-in.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  UNPLACED_GPU_POSITION,
  isProvenCellRows,
  isUnplacedCell,
  positionsForGpu,
  requirePlacedOrUnplacedRows,
  unplacedCountOf,
  vectorsForGpu,
} from '../assets/js/rendering/unplaced-positions.js';
import { SpatialIndex } from '../assets/js/rendering/high-perf/spatial-index.js';
import { buildSpatialTreeJob } from '../assets/js/rendering/high-perf/spatial-tree-job.js';
import { isProvenFiniteFloat32Array, publishPositionBounds, readPositionBounds } from '../assets/js/rendering/position-layout.js';
import { HP_VS_FULL, HP_VS_LIGHT, HP_VS_HIGHLIGHT } from '../assets/js/rendering/shaders/high-perf-shaders.js';
import { LINE_INSTANCED_VS_SOURCE } from '../assets/js/rendering/shaders/edge-grid-shaders.js';
import {
  connectivityVisibleCells,
  countVisibleConnectivityEdges,
  createConnectivityEdgeIndex,
  createConnectivitySelectionScratch,
  selectConnectivityEdges,
} from '../assets/js/rendering/connectivity-edge-selection.js';
import { VelocityOverlay } from '../assets/js/rendering/overlays/velocity/velocity-overlay.js';
import { connectivityEdgesFromPairs, edgeListOf } from './helpers/connectivity-edges.mjs';

/** `n` cells in 3D, every `every`-th in a run of `run` unplaced. */
function cloud(n, unplacedOf) {
  const positions = new Float32Array(n * 3);
  let seed = 7;
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  for (let cell = 0; cell < n; cell++) {
    if (unplacedOf(cell)) positions.fill(NaN, cell * 3, cell * 3 + 3);
    else for (let axis = 0; axis < 3; axis++) positions[cell * 3 + axis] = random() * 2 - 1;
  }
  return positions;
}

test('a row is placed (finite) or unplaced (NaN in every axis), nothing between', () => {
  const positions = cloud(10, cell => cell === 0 || cell === 7);
  assert.equal(requirePlacedOrUnplacedRows(positions, 3, 'P'), positions);
  assert.equal(unplacedCountOf(positions, 3), 2);
  assert.equal(isUnplacedCell(positions, 3, 0), true);
  assert.equal(isUnplacedCell(positions, 3, 1), false);
  const partial = cloud(4, () => false);
  partial[5] = NaN;
  assert.throws(() => requirePlacedOrUnplacedRows(partial, 3, 'P'), /must be finite, or NaN in every axis/);
  const half = cloud(4, () => false);
  half[3] = NaN;
  assert.throws(() => requirePlacedOrUnplacedRows(half, 3, 'P'), /NaN in one axis but not in every axis/);
});

test('NaN never goes up: positions take the stand-in, vectors a zero; placed data is not copied', () => {
  const placed = cloud(6, () => false);
  assert.equal(positionsForGpu(placed, 3), placed, 'every cell placed: the array itself');
  const positions = cloud(6, cell => cell % 3 === 1);
  const gpu = positionsForGpu(positions, 3);
  assert.notEqual(gpu, positions);
  assert.ok(gpu.every(Number.isFinite));
  assert.deepEqual(Array.from(gpu.subarray(3, 6)), [UNPLACED_GPU_POSITION, UNPLACED_GPU_POSITION, UNPLACED_GPU_POSITION].map(Math.fround));
  assert.deepEqual(Array.from(gpu.subarray(0, 3)), Array.from(positions.subarray(0, 3)));
  assert.ok(Number.isNaN(positions[3]), 'the published array keeps its NaN');
  const vectors = Float32Array.from([1, 2, NaN, NaN]);
  assert.deepEqual(Array.from(vectorsForGpu(vectors, 2)), [1, 2, 0, 0]);
});

test('bounds are the placed cells\', whichever cell comes first', () => {
  const positions = Float32Array.from([NaN, NaN, -2, 5, 3, -1]);
  const { min, max } = readPositionBounds(positions, 2);
  assert.deepEqual([min[0], max[0], min[1], max[1]], [-2, 3, -1, 5]);
});

test('the tree holds placed cells only; each band ends with its unplaced cells, out of every leaf range', () => {
  const n = 20_000;
  const unplacedOf = cell => cell % 10 < 3;
  const positions = cloud(n, unplacedOf);
  for (const build of [
    () => new SpatialIndex(positions, null, 3, 64, 12, { buildLOD: true }),
    () => {
      const { tree, order } = buildSpatialTreeJob({ positions: positions.slice(), dimensionLevel: 3, maxPointsPerNode: 64, maxDepth: 12, buildLOD: true });
      return new SpatialIndex(positions, null, 3, 64, 12, { buildLOD: true, prebuiltTree: tree, prebuiltOrder: order });
    },
  ]) {
    const index = build();
    assert.equal(index.placedCount, 14_000);
    assert.equal(index.validatePointCount().valid, true);
    assert.ok(Object.values(index.bounds).every(Number.isFinite));
    const order = index.drawOrder;
    const stride = order.leafCount + 1;
    for (let band = 0; band < order.bandCount; band++) {
      const start = band === 0 ? 0 : order.bandEnds[band - 1];
      const leavesEnd = order.leafOffsets[band * stride + order.leafCount];
      for (let slot = start; slot < order.bandEnds[band]; slot++) {
        assert.equal(unplacedOf(order.indices[slot]), slot >= leavesEnd, `band ${band} slot ${slot}`);
      }
    }
    // Every slot a culled draw of the whole tree reaches is a placed cell.
    const starts = new Int32Array(order.bandCount * 4);
    const counts = new Int32Array(order.bandCount * 4);
    const { elementCount } = index.writeDrawRanges(Uint32Array.of(0, order.leafCount), 1, order.bandCount - 1, starts, counts);
    assert.equal(elementCount, 14_000);
  }
});

test('every vertex shader that reads a cell\'s position rejects an unplaced one', () => {
  for (const [name, source] of Object.entries({ HP_VS_FULL, HP_VS_LIGHT, HP_VS_HIGHLIGHT, LINE_INSTANCED_VS_SOURCE })) {
    assert.match(source, /bool isUnplacedPosition\(vec3 position\)/, name);
    assert.match(source, /isUnplacedPosition\(a_(position|source)\)/, name);
  }
});

test('the edge slider counts and shows only edges whose both ends are placed in the shown view', () => {
  // A chain 0-1-2-...-9 and its skips: cells 3 and 7 are unplaced.
  const sources = [];
  const destinations = [];
  for (let cell = 0; cell < 9; cell++) { sources.push(cell); destinations.push(cell + 1); }
  for (let cell = 0; cell < 8; cell++) { sources.push(cell); destinations.push(cell + 2); }
  const graph = connectivityEdgesFromPairs(Uint32Array.from(sources), Uint32Array.from(destinations), 10);
  const index = createConnectivityEdgeIndex(graph);
  const positions = cloud(10, cell => cell === 3 || cell === 7);
  const list = edgeListOf(graph);
  const placed = edge => {
    const { sources, destinations } = list;
    return sources[edge] !== 3 && sources[edge] !== 7 && destinations[edge] !== 3 && destinations[edge] !== 7;
  };
  const expected = Array.from({ length: graph.nEdges }, (_, edge) => edge).filter(placed).length;
  for (const visibility of [null, { transparency: new Uint8Array(10).fill(1), lodMembership: null }]) {
    const { mask } = connectivityVisibleCells(visibility, null, { positions, dimension: 3 });
    assert.equal(mask[3], 0);
    assert.equal(mask[7], 0);
    assert.equal(countVisibleConnectivityEdges(index, mask, 0, 10), expected);
    const out = new Uint32Array(graph.nEdges * 3);
    const { shown } = selectConnectivityEdges(index, mask, graph.nEdges, out, createConnectivitySelectionScratch());
    assert.equal(shown, expected, 'the slider\'s K reaches only edges it can draw');
    for (let record = 0; record < shown; record++) {
      for (const end of [out[record * 3], out[record * 3 + 1]]) assert.ok(end !== 3 && end !== 7);
    }
  }
  // Every cell placed: no mask is made (every edge visible).
  assert.equal(connectivityVisibleCells(null, null, { positions: cloud(10, () => false), dimension: 3 }).mask, null);
});

test('velocity particles never spawn at an unplaced cell', () => {
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    config: { spawnTableSize: 64 },
  });
  const cellCount = 40;
  const transparency = new Uint8Array(cellCount).fill(1);
  const positions = cloud(cellCount, cell => cell % 4 === 0);
  const placement = { positions, dimension: 3 };
  const build = overlay._createSpawnTableBuild(transparency, cellCount, null, placement);
  while (!overlay._advanceSpawnTableBuild(build, { timeRemaining: () => 0, didTimeout: true })) { /* slices */ }
  const table = overlay._finishSpawnTableBuild(build);
  assert.equal(table.length, 30);
  for (const cell of table) assert.notEqual(cell % 4, 0, `cell ${cell} spawns`);
  assert.deepEqual(table, overlay._buildSpawnTable(transparency, cellCount, null, placement));
});

test('a proof of rows with unplaced cells is not a proof of finiteness', () => {
  const positions = cloud(5, cell => cell === 2);
  publishPositionBounds(positions, 3, { min: [-1, -1, -1], max: [1, 1, 1] });
  assert.equal(isProvenCellRows(positions), true);
  assert.equal(isProvenFiniteFloat32Array(positions), false);
  const scanned = cloud(5, cell => cell === 4);
  requirePlacedOrUnplacedRows(scanned, 3, 'P');
  assert.equal(isProvenCellRows(scanned), true);
  assert.equal(isProvenFiniteFloat32Array(scanned), false);
});
