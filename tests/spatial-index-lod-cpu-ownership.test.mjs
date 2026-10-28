import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';
import { SpatialIndex } from '../assets/js/rendering/high-perf/spatial-index.js';
import {
  ADAPTIVE_LOD_MAXIMUM_REDUCTION,
  ADAPTIVE_LOD_POINT_BUDGET,
} from '../assets/js/rendering/high-perf/lod-levels.js';
import { calculateSpatialBounds } from '../assets/js/rendering/high-perf/spatial-tree.js';
import {
  VelocityOverlay,
} from '../assets/js/rendering/overlays/velocity/velocity-overlay.js';
import { DEFAULT_CELL_PRIORITY, buildPriorityOrder } from '../assets/js/data/cell-priority.js';

// The fixed ladder (draw-order.js `lodLadder`): 1,000 cells, then 5/4 of
// the level before (rounded down), capped by the cell count.
const LARGE_POINT_COUNT = 10001;
const LARGE_REDUCED_COUNTS = Object.freeze([
  1000, 1250, 1562, 1952, 2440, 3050, 3812, 4765, 5956, 7445, 9306,
]);
const LARGE_LEGACY_SEPARATE_BACKING_BYTES =
  LARGE_REDUCED_COUNTS.reduce((sum, count) => sum + count, 0) *
  Uint32Array.BYTES_PER_ELEMENT;
const LARGE_SHARED_BACKING_BYTES =
  LARGE_POINT_COUNT * Uint32Array.BYTES_PER_ELEMENT;
const LARGE_AVOIDED_BACKING_BYTES =
  LARGE_LEGACY_SEPARATE_BACKING_BYTES - LARGE_SHARED_BACKING_BYTES;

function makeSpatialIndex() {
  // A 2D embedding: two components per point.
  const positions = Float32Array.from([
    -4, -2,
    4, -2,
    -4, 2,
    4, 2,
    -2, -1,
    2, -1,
    -2, 1,
    2, 1,
  ]);
  const colors = Uint8Array.from([
    10, 11, 12, 255,
    20, 21, 22, 254,
    30, 31, 32, 253,
    40, 41, 42, 252,
    50, 51, 52, 251,
    60, 61, 62, 250,
    70, 71, 72, 249,
    80, 81, 82, 248,
  ]);
  const spatialIndex = new SpatialIndex(
    positions,
    colors,
    2,
    2,
    4,
    { buildLOD: true },
  );
  return { colors, positions, spatialIndex };
}

function makeLodOnlySpatialIndex(pointCount) {
  const positions = new Float32Array(pointCount * 2);
  const colors = new Uint8Array(pointCount * 4);
  for (let index = 0; index < pointCount; index++) {
    const positionOffset = index * 2;
    positions[positionOffset] = (index * 37) % 1009 - 504;
    positions[positionOffset + 1] = (index * 101) % 997 - 498;

    const colorOffset = index * 4;
    colors[colorOffset] = index & 0xff;
    colors[colorOffset + 1] = (index * 3) & 0xff;
    colors[colorOffset + 2] = (index * 7) & 0xff;
    colors[colorOffset + 3] = 255;
  }

  // LOD generation depends only on these source fields and the leaves the
  // draw order groups points by. One leaf over every point keeps the tree out
  // of what this contract measures: the LOD index ownership itself.
  const spatialIndex = Object.assign(
    Object.create(SpatialIndex.prototype),
    {
      colors,
      dimensionLevel: 2,
      pointCount,
      positions,
      drawOrder: null,
      _lodMembershipOwner: null,
    },
  );
  spatialIndex.bounds = calculateSpatialBounds(positions, 2);
  spatialIndex.root = singleLeafRoot(pointCount, spatialIndex.bounds);
  spatialIndex.lodLevels = spatialIndex._generateLODLevels(DEFAULT_CELL_PRIORITY);
  return { colors, positions, spatialIndex };
}

function singleLeafRoot(pointCount, bounds) {
  const indices = new Uint32Array(pointCount);
  for (let index = 0; index < pointCount; index++) indices[index] = index;
  return { bounds, indices, children: null, pointCount };
}

function referenceRadiusQuery(
  positions,
  indices,
  center,
  radius,
  maxResults,
) {
  const results = [];
  const radiusSquared = radius * radius;
  for (
    let lodIndex = 0;
    lodIndex < indices.length && results.length < maxResults;
    lodIndex++
  ) {
    const originalIndex = indices[lodIndex];
    // 2D fixture: z is the zero a 2D embedding does not store.
    const offset = originalIndex * 2;
    const position = [
      positions[offset],
      positions[offset + 1],
      0,
    ];
    const dx = position[0] - center[0];
    const dy = position[1] - center[1];
    const dz = position[2] - center[2];
    if (dx * dx + dy * dy + dz * dz <= radiusSquared) {
      results.push({ lodIndex, originalIndex, position });
    }
  }
  return results;
}

test('a dataset below the first level has one level: every cell', () => {
  const { colors, positions, spatialIndex } = makeSpatialIndex();
  assert.equal(spatialIndex.lodLevels.length, 1);
  const fullDetail = spatialIndex.lodLevels[0];
  assert.equal(fullDetail.depth, 0);
  assert.equal(fullDetail.pointCount, positions.length / 2);
  assert.equal(fullDetail.positions, positions);
  assert.equal(fullDetail.colors, colors);
  assert.equal(Object.hasOwn(fullDetail, 'indices'), false);
  assert.equal(fullDetail.isFullDetail, true);
  assert.equal(spatialIndex.drawOrder.bandCount, 1);
});

test('reduced CPU LOD levels are the fixed ladder, views of one draw order, in priority order', () => {
  const {
    colors,
    positions,
    spatialIndex,
  } = makeLodOnlySpatialIndex(LARGE_POINT_COUNT);
  const levelsIdentity = spatialIndex.lodLevels;
  const reducedLevels = levelsIdentity.slice(0, LARGE_REDUCED_COUNTS.length);
  const indexIdentities = reducedLevels.map(level => level.indices);
  const hierarchicalOrder = spatialIndex.drawOrder.indices;
  const priority = buildPriorityOrder(LARGE_POINT_COUNT, DEFAULT_CELL_PRIORITY);

  assert.equal(levelsIdentity.length, LARGE_REDUCED_COUNTS.length + 1);
  assert.deepEqual(
    reducedLevels.map(level => level.pointCount),
    LARGE_REDUCED_COUNTS,
  );
  assert.ok(hierarchicalOrder instanceof Uint32Array);
  assert.equal(hierarchicalOrder.length, LARGE_POINT_COUNT);
  assert.equal(new Set(indexIdentities).size, LARGE_REDUCED_COUNTS.length);

  for (let levelIndex = 0; levelIndex < reducedLevels.length; levelIndex++) {
    const level = reducedLevels[levelIndex];
    const { indices, pointCount } = level;
    assert.ok(indices instanceof Uint32Array);
    assert.equal(indices.buffer, hierarchicalOrder.buffer);
    assert.equal(indices.byteOffset, hierarchicalOrder.byteOffset);
    assert.equal(indices.length, pointCount);
    assert.deepEqual(indices, hierarchicalOrder.subarray(0, pointCount));
    // The first `pointCount` cells of the priority order.
    assert.deepEqual(
      Array.from(indices).sort((x, y) => x - y),
      Array.from(priority.subarray(0, pointCount)).sort((x, y) => x - y),
    );
    assert.equal(level.depth, levelIndex);
    assert.equal(level.isFullDetail, false);
    assert.equal(level.sizes, null);
    assert.equal(Object.hasOwn(level, 'positions'), false);
    assert.equal(
      level.sizeMultiplier,
      Math.sqrt(Math.min(44, LARGE_POINT_COUNT / pointCount)) * 0.2 + 0.8,
    );
  }

  const uniqueBackingBuffers = new Set(
    indexIdentities.map(indices => indices.buffer),
  );
  const actualUniqueBackingBytes = Array.from(uniqueBackingBuffers)
    .reduce((sum, buffer) => sum + buffer.byteLength, 0);
  assert.equal(uniqueBackingBuffers.size, 1);
  assert.equal(actualUniqueBackingBytes, LARGE_SHARED_BACKING_BYTES);
  assert.equal(LARGE_LEGACY_SEPARATE_BACKING_BYTES, 170152);
  assert.equal(LARGE_SHARED_BACKING_BYTES, 40004);
  assert.ok(LARGE_AVOIDED_BACKING_BYTES / LARGE_LEGACY_SEPARATE_BACKING_BYTES > 0.76);

  const fullDetail = levelsIdentity.at(-1);
  assert.equal(fullDetail.depth, LARGE_REDUCED_COUNTS.length);
  assert.equal(fullDetail.positions, positions);
  assert.equal(fullDetail.colors, colors);
  assert.equal(fullDetail.pointCount, LARGE_POINT_COUNT);
  assert.equal(fullDetail.isFullDetail, true);
  assert.equal(Object.hasOwn(fullDetail, 'indices'), false);

  // The levels are published once, at construction.
  assert.equal(spatialIndex.lodLevels, levelsIdentity);
  for (let levelIndex = 0; levelIndex < indexIdentities.length; levelIndex++) {
    assert.equal(spatialIndex.lodLevels[levelIndex].indices, indexIdentities[levelIndex]);
  }
});

test('index-only reduced LOD radius queries preserve source and custom-position results', () => {
  const { positions, spatialIndex } = makeLodOnlySpatialIndex(LARGE_POINT_COUNT);
  const levelIndex = 0;
  const indices = spatialIndex.lodLevels[levelIndex].indices;
  const orderBeforeQueries = Uint32Array.from(
    spatialIndex.drawOrder.indices,
  );
  const center = [-2, 0, 0];
  const radius = 3;
  const maxResults = 5;

  assert.deepEqual(
    spatialIndex.queryRadiusAtLOD(
      center,
      radius,
      levelIndex,
      maxResults,
    ),
    referenceRadiusQuery(
      positions,
      indices,
      center,
      radius,
      maxResults,
    ),
  );

  const customPositions = Float32Array.from(positions, (value, index) => (
    index % 3 === 0 ? value + 10 : value
  ));
  const customCenter = [8, 0, 0];
  assert.deepEqual(
    spatialIndex.queryRadiusAtLOD(
      customCenter,
      radius,
      levelIndex,
      maxResults,
      customPositions,
    ),
    referenceRadiusQuery(
      customPositions,
      indices,
      customCenter,
      radius,
      maxResults,
    ),
  );
  assert.deepEqual(spatialIndex.drawOrder.indices, orderBeforeQueries);
});

test('active full-detail LOD publishes null and velocity treats it as all cells', () => {
  const { spatialIndex } = makeSpatialIndex();
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _perViewState: new Map([
        ['live', { lastLodLevel: spatialIndex.lodLevels.length - 1 }],
      ]),
      snapshotBuffers: new Map(),
      spatialIndices: new Map([[2, spatialIndex]]),
    },
  );

  const fullDetailCandidates = renderer.getCurrentLodIndices('live', 2);
  assert.equal(fullDetailCandidates, null);

  const velocity = Object.assign(
    Object.create(VelocityOverlay.prototype),
    {
      config: { spawnTableSize: spatialIndex.pointCount },
    },
  );
  assert.deepEqual(
    velocity._buildSpawnTable(
      new Uint8Array(spatialIndex.pointCount).fill(1),
      spatialIndex.pointCount,
      fullDetailCandidates,
    ),
    Uint32Array.from(
      { length: spatialIndex.pointCount },
      (_, index) => index,
    ),
  );
});

// Positions and bounds as the renderer actually sees them: every embedding is
// normalized into roughly [-1, 1] before it reaches the index, so a camera
// distance of 1 is a camera one data-width away. A synthetic index built at
// some other scale puts every test distance below the selector's near clamp and
// hides whether the camera moves the level at all.
const makeNormalizedIndex = pointCount => {
  const positions = new Float32Array(pointCount * 2);
  for (let index = 0; index < pointCount; index++) {
    positions[index * 2] = ((index % 977) / 977) * 2 - 1;
    positions[index * 2 + 1] = (((index * 31) % 1021) / 1021) * 2 - 1;
  }
  const index = Object.assign(
    Object.create(SpatialIndex.prototype),
    {
      bounds: { minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: 0, maxZ: 0 },
      dimensionLevel: 2,
      pointCount,
      positions,
      _adaptiveMinimumLevel: 0,
      drawOrder: null,
      _lodMembershipOwner: null,
    },
  );
  index.root = singleLeafRoot(pointCount, index.bounds);
  index.lodLevels = index._generateLODLevels(DEFAULT_CELL_PRIORITY);
  return index;
};

// Pull back through the selector's whole useful range and return to where it
// started, one call per step as the render loop makes them.
const walkCamera = index => {
  const distances = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12];
  const levels = [];
  let previous = -1;
  for (const distance of distances) {
    previous = index.getLODLevel(distance, previous, 2);
    levels.push(previous);
  }
  for (const distance of [...distances].reverse()) {
    previous = index.getLODLevel(distance, previous, 2);
    levels.push(previous);
  }
  return levels;
};

test('adaptive selection is bounded by a budget and a ratio, not a ratio alone', () => {
  // A fixed reduction ratio is what made a large dataset unusable on `Auto`:
  // the coarsest ladder step is 44x whatever the cell count, so pulling the
  // camera back on 18.1M cells discarded 97.7% of them whether or not the frame
  // needed it.
  //
  // An absolute budget alone broke the other end. No level of a 200k cloud
  // holds two million points, so the floor landed on full detail and `Auto`
  // answered full detail at every camera distance -- on every dataset most
  // people open, the level readout never moved and the forced-level slider was
  // the only control that did anything.
  assert.equal(ADAPTIVE_LOD_POINT_BUDGET, 2_000_000);
  assert.equal(ADAPTIVE_LOD_MAXIMUM_REDUCTION, 8);

  for (const pointCount of [50_000, 200_000, 1_000_000, 3_000_000, 18_142_044]) {
    const index = makeNormalizedIndex(pointCount);
    const floorLevel = index._adaptiveMinimumLevel;
    const finest = index.lodLevels.length - 1;
    assert.ok(
      floorLevel > 0 && floorLevel < finest,
      `${pointCount} points must leave adaptive selection a range to work in, `
      + `got floor ${floorLevel} of ${finest}`,
    );

    const floorCount = Math.min(
      ADAPTIVE_LOD_POINT_BUDGET,
      pointCount / ADAPTIVE_LOD_MAXIMUM_REDUCTION,
    );
    assert.ok(
      index.lodLevels[floorLevel].pointCount >= floorCount,
      `the floor level must hold at least ${floorCount} points`,
    );
    assert.ok(
      index.lodLevels[floorLevel - 1].pointCount < floorCount,
      'the floor must be the coarsest level that still holds that count',
    );

    const levels = walkCamera(index);
    assert.equal(
      Math.max(...levels),
      finest,
      `${pointCount} points must reach full detail with the camera close`,
    );
    assert.equal(
      Math.min(...levels),
      floorLevel,
      `${pointCount} points must reach the floor with the camera pulled back`,
    );
    assert.ok(
      new Set(levels).size >= 4,
      `${pointCount} points must give the camera more than a couple of levels`,
    );

    // Hysteresis must not be able to walk below the floor either, even when a
    // restored session hands in a coarser previous level.
    assert.ok(index.getLODLevel(100, 0, 2) >= floorLevel);
  }
});

test('a cloud too small to sample keeps every level identical rather than empty', () => {
  // The ladder floors each level at 1,000 points, so the smallest published
  // dataset -- 3,696 cells -- cannot be reduced by more than 3.7x however far
  // the camera pulls back. The camera still drives the level; the levels it
  // drives to just hold the same number of points.
  const index = makeNormalizedIndex(3_696);
  assert.equal(index._adaptiveMinimumLevel, 0);
  for (const level of index.lodLevels) {
    assert.ok(
      level.pointCount >= 1_000,
      'no level may drop a small cloud below the 1,000-point ladder floor',
    );
  }
  const levels = walkCamera(index);
  assert.ok(
    new Set(levels).size >= 4,
    'the camera must still move the level on the smallest published dataset',
  );
});
