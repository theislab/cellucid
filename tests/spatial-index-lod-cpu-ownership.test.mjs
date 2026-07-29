import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighPerfRenderer,
  SpatialIndex,
} from '../assets/js/rendering/high-perf-renderer.js';
import {
  VelocityOverlay,
} from '../assets/js/rendering/overlays/velocity/velocity-overlay.js';

const REDUCTION_FACTORS = Object.freeze([
  44, 35, 28, 23, 18, 14.5, 11.5, 9.3, 7.5,
  6, 4.8, 3.8, 3, 2.4, 1.95, 1.55, 1.25,
]);
const LEGACY_INDEX_ORDER = Object.freeze([4, 6, 5, 7, 2, 3, 0, 1]);
const LEGACY_INDEX_BYTES = Object.freeze([
  4, 0, 0, 0,
  6, 0, 0, 0,
  5, 0, 0, 0,
  7, 0, 0, 0,
  2, 0, 0, 0,
  3, 0, 0, 0,
  0, 0, 0, 0,
  1, 0, 0, 0,
]);
const LARGE_POINT_COUNT = 10001;
const LARGE_REDUCED_COUNTS = Object.freeze([
  1000, 1000, 1000, 1000, 1000, 1000, 1000, 1076, 1334,
  1667, 2084, 2632, 3334, 4168, 5129, 6453, 8001,
]);
const LARGE_LEGACY_SEPARATE_BACKING_BYTES =
  LARGE_REDUCED_COUNTS.reduce((sum, count) => sum + count, 0) *
  Uint32Array.BYTES_PER_ELEMENT;
const LARGE_SHARED_BACKING_BYTES =
  LARGE_POINT_COUNT * Uint32Array.BYTES_PER_ELEMENT;
const LARGE_AVOIDED_BACKING_BYTES =
  LARGE_LEGACY_SEPARATE_BACKING_BYTES - LARGE_SHARED_BACKING_BYTES;

function makeSpatialIndex() {
  const positions = Float32Array.from([
    -4, -2, 0,
    4, -2, 0,
    -4, 2, 0,
    4, 2, 0,
    -2, -1, 0,
    2, -1, 0,
    -2, 1, 0,
    2, 1, 0,
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
    {
      buildLOD: true,
      buildLodNodeMappings: false,
      computeNodeStats: false,
    },
  );
  return { colors, positions, spatialIndex };
}

function makeLodOnlySpatialIndex(pointCount) {
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);
  for (let index = 0; index < pointCount; index++) {
    const positionOffset = index * 3;
    positions[positionOffset] = (index * 37) % 1009 - 504;
    positions[positionOffset + 1] = (index * 101) % 997 - 498;
    positions[positionOffset + 2] = 0;

    const colorOffset = index * 4;
    colors[colorOffset] = index & 0xff;
    colors[colorOffset + 1] = (index * 3) & 0xff;
    colors[colorOffset + 2] = (index * 7) & 0xff;
    colors[colorOffset + 3] = 255;
  }

  // LOD generation depends only on these source fields. Avoid constructing the
  // spatial tree so this contract measures the LOD index ownership itself.
  const spatialIndex = Object.assign(
    Object.create(SpatialIndex.prototype),
    {
      colors,
      dimensionLevel: 2,
      pointCount,
      positions,
    },
  );
  spatialIndex.bounds = spatialIndex._calculateBounds();
  spatialIndex.lodLevels = spatialIndex._generateLODLevels();
  return { colors, positions, spatialIndex };
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
    const offset = originalIndex * 3;
    const position = [
      positions[offset],
      positions[offset + 1],
      positions[offset + 2],
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

test('reduced CPU LOD levels publish stable shared-prefix original-index views', () => {
  const { colors, positions, spatialIndex } = makeSpatialIndex();
  const levelsIdentity = spatialIndex.lodLevels;
  const indexIdentities = levelsIdentity
    .slice(0, REDUCTION_FACTORS.length)
    .map(level => level.indices);

  assert.equal(spatialIndex.positions, positions);
  assert.equal(spatialIndex.colors, colors);
  assert.ok(Array.isArray(levelsIdentity));
  assert.equal(levelsIdentity.length, 18);

  for (let levelIndex = 0; levelIndex < REDUCTION_FACTORS.length; levelIndex++) {
    const level = levelsIdentity[levelIndex];
    assert.deepEqual(Array.from(level.indices), LEGACY_INDEX_ORDER);
    assert.deepEqual(
      Array.from(
        new Uint8Array(
          level.indices.buffer,
          level.indices.byteOffset,
          level.indices.byteLength,
        ),
      ),
      LEGACY_INDEX_BYTES,
    );
    assert.equal(Object.hasOwn(level, 'positions'), false);
    assert.equal(Object.hasOwn(level, 'colors'), false);
    assert.equal(level.depth, levelIndex);
    assert.equal(level.pointCount, positions.length / 3);
    assert.equal(level.sizes, null);
    assert.equal(level.isFullDetail, false);
    assert.equal(
      level.sizeMultiplier,
      Math.sqrt(REDUCTION_FACTORS[levelIndex]) * 0.2 + 0.8,
    );
  }

  const fullDetail = levelsIdentity.at(-1);
  assert.equal(fullDetail.depth, 17);
  assert.equal(fullDetail.pointCount, positions.length / 3);
  assert.equal(fullDetail.positions, positions);
  assert.equal(fullDetail.colors, colors);
  assert.equal(Object.hasOwn(fullDetail, 'indices'), false);
  assert.equal(fullDetail.sizes, null);
  assert.equal(fullDetail.isFullDetail, true);

  const hierarchicalOrder = spatialIndex._hierarchicalOrder;
  assert.ok(hierarchicalOrder instanceof Uint32Array);
  assert.deepEqual(Array.from(hierarchicalOrder), LEGACY_INDEX_ORDER);
  assert.equal(hierarchicalOrder.length, spatialIndex.pointCount);
  assert.equal(hierarchicalOrder.byteOffset, 0);
  assert.equal(new Set(indexIdentities).size, REDUCTION_FACTORS.length);
  assert.equal(
    new Set(indexIdentities.map(indices => indices.buffer)).size,
    1,
  );
  for (const indices of indexIdentities) {
    assert.equal(indices.buffer, hierarchicalOrder.buffer);
    assert.equal(indices.byteOffset, hierarchicalOrder.byteOffset);
    assert.equal(
      indices.byteLength,
      spatialIndex.pointCount * Uint32Array.BYTES_PER_ELEMENT,
    );
  }

  spatialIndex.ensureLODLevels();
  assert.equal(spatialIndex.lodLevels, levelsIdentity);
  for (let levelIndex = 0; levelIndex < indexIdentities.length; levelIndex++) {
    assert.equal(spatialIndex.lodLevels[levelIndex].indices, indexIdentities[levelIndex]);
  }
});

test('one typed hierarchical order backs every large reduced LOD prefix', () => {
  const {
    colors,
    positions,
    spatialIndex,
  } = makeLodOnlySpatialIndex(LARGE_POINT_COUNT);
  const levelsIdentity = spatialIndex.lodLevels;
  const reducedLevels = levelsIdentity.slice(0, REDUCTION_FACTORS.length);
  const indexIdentities = reducedLevels.map(level => level.indices);
  const hierarchicalOrder = spatialIndex._hierarchicalOrder;

  assert.equal(levelsIdentity.length, REDUCTION_FACTORS.length + 1);
  assert.deepEqual(
    reducedLevels.map(level => level.pointCount),
    LARGE_REDUCED_COUNTS,
  );
  assert.ok(hierarchicalOrder instanceof Uint32Array);
  assert.equal(hierarchicalOrder.length, LARGE_POINT_COUNT);
  assert.equal(new Set(indexIdentities).size, REDUCTION_FACTORS.length);

  for (let levelIndex = 0; levelIndex < reducedLevels.length; levelIndex++) {
    const { indices, pointCount } = reducedLevels[levelIndex];
    assert.ok(indices instanceof Uint32Array);
    assert.equal(indices, indexIdentities[levelIndex]);
    assert.equal(indices.buffer, hierarchicalOrder.buffer);
    assert.equal(indices.byteOffset, hierarchicalOrder.byteOffset);
    assert.equal(indices.length, pointCount);
    assert.deepEqual(
      indices,
      hierarchicalOrder.subarray(0, pointCount),
    );
  }

  const uniqueBackingBuffers = new Set(
    indexIdentities.map(indices => indices.buffer),
  );
  const actualUniqueBackingBytes = Array.from(uniqueBackingBuffers)
    .reduce((sum, buffer) => sum + buffer.byteLength, 0);
  assert.equal(uniqueBackingBuffers.size, 1);
  assert.equal(actualUniqueBackingBytes, LARGE_SHARED_BACKING_BYTES);
  assert.equal(LARGE_LEGACY_SEPARATE_BACKING_BYTES, 171512);
  assert.equal(LARGE_SHARED_BACKING_BYTES, 40004);
  assert.equal(LARGE_AVOIDED_BACKING_BYTES, 131508);
  assert.ok(
    LARGE_AVOIDED_BACKING_BYTES /
      LARGE_LEGACY_SEPARATE_BACKING_BYTES >
      0.76,
  );

  const fullDetail = levelsIdentity.at(-1);
  assert.equal(fullDetail.positions, positions);
  assert.equal(fullDetail.colors, colors);
  assert.equal(fullDetail.pointCount, LARGE_POINT_COUNT);
  assert.equal(fullDetail.isFullDetail, true);
  assert.equal(Object.hasOwn(fullDetail, 'indices'), false);

  spatialIndex.ensureLODLevels();
  assert.equal(spatialIndex.lodLevels, levelsIdentity);
  for (let levelIndex = 0; levelIndex < indexIdentities.length; levelIndex++) {
    assert.equal(
      spatialIndex.lodLevels[levelIndex].indices,
      indexIdentities[levelIndex],
    );
  }
});

test('index-only reduced LOD radius queries preserve source and custom-position results', () => {
  const { positions, spatialIndex } = makeSpatialIndex();
  const levelIndex = 0;
  const indices = spatialIndex.lodLevels[levelIndex].indices;
  const orderBeforeQueries = Uint32Array.from(
    spatialIndex._hierarchicalOrder,
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
  assert.deepEqual(spatialIndex._hierarchicalOrder, orderBeforeQueries);
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
      new Float32Array(spatialIndex.pointCount).fill(1),
      spatialIndex.pointCount,
      fullDetailCandidates,
    ),
    Uint32Array.from(
      { length: spatialIndex.pointCount },
      (_, index) => index,
    ),
  );
});
