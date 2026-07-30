import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SpatialIndex,
} from '../assets/js/rendering/high-perf-renderer.js';
import {
  findRaySamplePick,
} from '../assets/js/rendering/picking.js';
import {
  POINT_VISIBILITY_THRESHOLD,
} from '../assets/js/rendering/alpha-visibility.js';

const SEARCH_RADIUS = 0.03;
const VISIBILITY_THRESHOLD = POINT_VISIBILITY_THRESHOLD;
const MIN_SAMPLE_STEP = 0.02;
const MAX_SAMPLE_COUNT = 500;

function makeSpatialIndex(positions, maxPointsPerNode = 4) {
  return new SpatialIndex(
    positions,
    new Uint8Array((positions.length / 3) * 4),
    3,
    maxPointsPerNode,
    12,
    {
      buildLOD: false,
      buildLodNodeMappings: false,
      computeNodeStats: false,
    },
  );
}

function referenceRaySamplePick({
  maxDistance,
  positions,
  ray,
  transparency,
}) {
  const directionLength = Math.hypot(...ray.direction);
  const direction = ray.direction.map(value => value / directionLength);
  const sampleStep = Math.max(
    MIN_SAMPLE_STEP,
    maxDistance / MAX_SAMPLE_COUNT,
  );
  const sampleCount = Math.ceil(maxDistance / sampleStep);
  const radiusSquared = SEARCH_RADIUS * SEARCH_RADIUS;

  for (
    let sampleIndex = 0;
    sampleIndex < sampleCount;
    sampleIndex++
  ) {
    const sampleDistance = sampleIndex * sampleStep;
    const sampleX =
      ray.origin[0] + direction[0] * sampleDistance;
    const sampleY =
      ray.origin[1] + direction[1] * sampleDistance;
    const sampleZ =
      ray.origin[2] + direction[2] * sampleDistance;
    let bestCellIndex = -1;
    let bestPerpendicularDistanceSquared = Infinity;

    for (
      let cellIndex = 0;
      cellIndex < positions.length / 3;
      cellIndex++
    ) {
      if (!(transparency[cellIndex] >= VISIBILITY_THRESHOLD)) continue;
      const positionOffset = cellIndex * 3;
      const offsetX = positions[positionOffset] - ray.origin[0];
      const offsetY = positions[positionOffset + 1] - ray.origin[1];
      const offsetZ = positions[positionOffset + 2] - ray.origin[2];
      const projectedDistance =
        offsetX * direction[0] +
        offsetY * direction[1] +
        offsetZ * direction[2];
      if (projectedDistance < 0) continue;

      const sampleOffsetX = positions[positionOffset] - sampleX;
      const sampleOffsetY = positions[positionOffset + 1] - sampleY;
      const sampleOffsetZ = positions[positionOffset + 2] - sampleZ;
      if (
        sampleOffsetX * sampleOffsetX +
          sampleOffsetY * sampleOffsetY +
          sampleOffsetZ * sampleOffsetZ >
        radiusSquared
      ) {
        continue;
      }

      const crossX =
        offsetY * direction[2] - offsetZ * direction[1];
      const crossY =
        offsetZ * direction[0] - offsetX * direction[2];
      const crossZ =
        offsetX * direction[1] - offsetY * direction[0];
      const perpendicularDistanceSquared =
        crossX * crossX + crossY * crossY + crossZ * crossZ;
      if (
        perpendicularDistanceSquared <
          bestPerpendicularDistanceSquared ||
        (
          perpendicularDistanceSquared ===
            bestPerpendicularDistanceSquared &&
          (bestCellIndex === -1 || cellIndex < bestCellIndex)
        )
      ) {
        bestCellIndex = cellIndex;
        bestPerpendicularDistanceSquared =
          perpendicularDistanceSquared;
      }
    }

    if (bestCellIndex !== -1) {
      return {
        cellIndex: bestCellIndex,
        firstSampleIndex: sampleIndex,
        perpendicularDistanceSquared:
          bestPerpendicularDistanceSquared,
      };
    }
  }

  return {
    cellIndex: -1,
    firstSampleIndex: -1,
    perpendicularDistanceSquared: Infinity,
  };
}

function pickBothWays(input) {
  const direct = findRaySamplePick({
    ...input,
    spatialIndex: null,
  });
  const spatialIndex = makeSpatialIndex(input.positions);
  const indexed = findRaySamplePick({
    ...input,
    spatialIndex,
  });
  return { direct, indexed, spatialIndex };
}

test('coarse LOD direct picking ignores a closer excluded source point', () => {
  const positions = Float32Array.from([
    0, 0, 0.1,
    0, 0, 0.2,
    1, 1, 0.15,
  ]);
  const transparency = new Float32Array(3).fill(1);
  const lodMembership = Object.freeze({
    admissionLevels: Uint8Array.from([0xff, 0, 0xff]),
    dimensionLevel: 3,
    generationToken: Object.freeze({}),
    indices: Uint32Array.of(1),
    lodLevel: 0,
    pointCount: 3,
  });
  const input = {
    positions,
    transparency,
    ray: {
      origin: [0, 0, 0],
      direction: [0, 0, 1],
    },
    maxDistance: 0.5,
    spatialIndex: null,
  };

  const fullDetail = findRaySamplePick(input);
  const coarseLod = findRaySamplePick({
    ...input,
    lodMembership,
  });

  assert.equal(fullDetail.cellIndex, 0);
  assert.equal(coarseLod.cellIndex, 1);
  assert.ok(coarseLod.firstSampleIndex > fullDetail.firstSampleIndex);
  assert.equal(coarseLod.examinedPointCount, 1);
});

test('coarse LOD direct picking rejects malformed compact membership', () => {
  const positions = Float32Array.from([
    0, 0, 0.1,
    0, 0, 0.2,
  ]);
  const input = {
    positions,
    transparency: new Float32Array(2).fill(1),
    ray: {
      origin: [0, 0, 0],
      direction: [0, 0, 1],
    },
    maxDistance: 0.5,
    spatialIndex: null,
  };
  const makeMembership = ({
    admissionLevels = Uint8Array.from([0, 0xff]),
    indices = Uint32Array.of(0),
    extra = false,
  } = {}) => Object.freeze({
    admissionLevels,
    dimensionLevel: 3,
    generationToken: Object.freeze({}),
    indices,
    lodLevel: 0,
    pointCount: 2,
    ...(extra ? { unexpected: true } : {}),
  });

  assert.throws(
    () => findRaySamplePick({
      ...input,
      lodMembership: makeMembership({ extra: true }),
    }),
    /frozen renderer certificate/
  );
  assert.throws(
    () => findRaySamplePick({
      ...input,
      lodMembership: makeMembership({
        indices: Uint32Array.of(2),
      }),
    }),
    /does not name an admitted source point/
  );
  assert.throws(
    () => findRaySamplePick({
      ...input,
      lodMembership: makeMembership({
        admissionLevels: Uint8Array.from([0xff, 0]),
      }),
    }),
    /does not name an admitted source point/
  );
});

test('ray picking does not let 32 hidden traversal-first points mask a visible point', () => {
  const pointCount = 40;
  const positions = new Float32Array(pointCount * 3);
  const transparency = new Float32Array(pointCount);
  for (let cellIndex = 0; cellIndex < pointCount; cellIndex++) {
    positions[cellIndex * 3 + 2] = 0.1;
  }
  transparency[32] = 1;
  const input = {
    positions,
    transparency,
    ray: {
      origin: [0, 0, 0],
      direction: [0, 0, 1],
    },
    maxDistance: 0.5,
  };

  const { direct, indexed } = pickBothWays(input);
  assert.equal(referenceRaySamplePick(input).cellIndex, 32);
  assert.equal(direct.cellIndex, 32);
  assert.equal(indexed.cellIndex, 32);
});

test('ray picking chooses the nearest perpendicular point beyond the former candidate cap', () => {
  const pointCount = 40;
  const positions = new Float32Array(pointCount * 3);
  const transparency = new Float32Array(pointCount).fill(1);
  for (let cellIndex = 0; cellIndex < pointCount; cellIndex++) {
    positions[cellIndex * 3 + 1] = 0.02;
    positions[cellIndex * 3 + 2] = 0.1;
  }
  positions[32 * 3 + 1] = 0.001;
  const input = {
    positions,
    transparency,
    ray: {
      origin: [0, 0, 0],
      direction: [0, 0, 1],
    },
    maxDistance: 0.5,
  };

  const expected = referenceRaySamplePick(input);
  const { direct, indexed } = pickBothWays(input);
  assert.equal(expected.cellIndex, 32);
  assert.equal(direct.cellIndex, expected.cellIndex);
  assert.equal(indexed.cellIndex, expected.cellIndex);
  assert.equal(direct.firstSampleIndex, expected.firstSampleIndex);
  assert.equal(indexed.firstSampleIndex, expected.firstSampleIndex);
});

test('indexed and one-pass picking match an independent discrete-sample reference', () => {
  let randomState = 0x6d2b79f5;
  const random = () => {
    randomState = (
      Math.imul(randomState ^ (randomState >>> 15), 1 | randomState) +
      0x6d2b79f5
    ) >>> 0;
    return randomState / 0x100000000;
  };
  const pointCount = 2048;
  const positions = new Float32Array(pointCount * 3);
  const transparency = new Float32Array(pointCount);
  for (let cellIndex = 0; cellIndex < pointCount; cellIndex++) {
    const offset = cellIndex * 3;
    positions[offset] = (random() - 0.5) * 1.6;
    positions[offset + 1] = (random() - 0.5) * 1.6;
    positions[offset + 2] = random() * 3.4 - 0.2;
    transparency[cellIndex] =
      cellIndex % 11 === 0
        ? 0
        : (cellIndex % 13 === 0 ? 0.005 : 1);
  }
  // Guarantee one non-boundary visible hit while leaving traversal order and
  // surrounding candidates randomized.
  positions[177 * 3] = 0.006;
  positions[177 * 3 + 1] = -0.004;
  positions[177 * 3 + 2] = 0.17;
  transparency[177] = 1;

  const input = {
    positions,
    transparency,
    ray: {
      origin: [0.01, -0.02, 0],
      direction: [0.015, 0.01, 3],
    },
    maxDistance: 3,
  };
  const expected = referenceRaySamplePick(input);
  const { direct, indexed } = pickBothWays(input);

  assert.equal(direct.cellIndex, expected.cellIndex);
  assert.equal(indexed.cellIndex, expected.cellIndex);
  assert.equal(direct.firstSampleIndex, expected.firstSampleIndex);
  assert.equal(indexed.firstSampleIndex, expected.firstSampleIndex);
  assert.ok(
    Math.abs(
      direct.perpendicularDistanceSquared -
        expected.perpendicularDistanceSquared
    ) < 1e-15,
  );
  assert.equal(
    indexed.perpendicularDistanceSquared,
    direct.perpendicularDistanceSquared,
  );
});

test('ray picking matches the shader alpha threshold', () => {
  const positions = Float32Array.from([
    0, 0, 0.1,
    0.005, 0, 0.1,
  ]);
  const transparency = Float32Array.from([
    Math.fround(2.49 / 255),
    POINT_VISIBILITY_THRESHOLD,
  ]);
  const input = {
    positions,
    transparency,
    ray: {
      origin: [0, 0, 0],
      direction: [0, 0, 1],
    },
    maxDistance: 0.5,
  };

  const { direct, indexed } = pickBothWays(input);
  assert.equal(direct.cellIndex, 1);
  assert.equal(indexed.cellIndex, 1);
});

test('ray picking verifies float32 sample-sphere boundaries exactly', () => {
  const cases = [
    {
      name: 'last included sample axial boundary',
      position: [0, 0, Math.fround(0.11)],
      maxDistance: 0.1,
      expectedSampleIndex: 4,
    },
    {
      name: 'near-tangent narrow sample interval',
      position: [
        0,
        Math.fround(0.029999),
        Math.fround(0.2),
      ],
      maxDistance: 0.5,
      expectedSampleIndex: 10,
    },
    {
      name: 'off-axis sphere boundary',
      position: [
        0,
        Math.fround(0.02),
        Math.fround(
          0.08 + Math.sqrt(
            SEARCH_RADIUS * SEARCH_RADIUS - 0.02 * 0.02,
          ),
        ),
      ],
      maxDistance: 0.5,
      // Float32 publication rounds this constructed boundary just outside
      // sample 4; sample 5 is therefore the first exact discrete hit.
      expectedSampleIndex: 5,
    },
  ];

  for (const boundaryCase of cases) {
    const positions = Float32Array.from(boundaryCase.position);
    const transparency = Float32Array.of(1);
    const input = {
      positions,
      transparency,
      ray: {
        origin: [0, 0, 0],
        direction: [0, 0, 1],
      },
      maxDistance: boundaryCase.maxDistance,
    };
    const expected = referenceRaySamplePick(input);
    const { direct, indexed } = pickBothWays(input);
    assert.equal(
      expected.firstSampleIndex,
      boundaryCase.expectedSampleIndex,
      boundaryCase.name,
    );
    assert.equal(direct.cellIndex, expected.cellIndex, boundaryCase.name);
    assert.equal(
      direct.firstSampleIndex,
      expected.firstSampleIndex,
      boundaryCase.name,
    );
    assert.equal(indexed.cellIndex, expected.cellIndex, boundaryCase.name);
    assert.equal(
      indexed.firstSampleIndex,
      expected.firstSampleIndex,
      boundaryCase.name,
    );
  }
});

test('fallback examines at most N points once and tree traversal never duplicates IDs', () => {
  const pointCount = 20000;
  const positions = new Float32Array(pointCount * 3);
  const transparency = new Float32Array(pointCount).fill(1);
  for (let cellIndex = 0; cellIndex < pointCount; cellIndex++) {
    const offset = cellIndex * 3;
    positions[offset] = 10 + (cellIndex % 17);
    positions[offset + 1] = 20 + (cellIndex % 13);
    positions[offset + 2] = (cellIndex % 1000) / 100;
  }
  const input = {
    positions,
    transparency,
    ray: {
      origin: [0, 0, 0],
      direction: [0, 0, 1],
    },
    maxDistance: 10,
  };

  const direct = findRaySamplePick({
    ...input,
    spatialIndex: null,
  });
  assert.equal(direct.cellIndex, -1);
  assert.equal(direct.examinedPointCount, pointCount);

  const spatialIndex = makeSpatialIndex(positions, 32);
  const visited = [];
  spatialIndex.visitRaySegmentCandidates(
    input.ray.origin,
    input.ray.direction,
    9.98,
    SEARCH_RADIUS,
    cellIndex => visited.push(cellIndex),
  );
  assert.equal(new Set(visited).size, visited.length);
  assert.ok(visited.length <= pointCount);

  const indexed = findRaySamplePick({
    ...input,
    spatialIndex,
  });
  assert.equal(indexed.cellIndex, -1);
  assert.ok(indexed.examinedPointCount <= pointCount);
});
