import assert from 'node:assert/strict';
import test from 'node:test';

import { SpatialIndex } from '../assets/js/rendering/high-perf/spatial-index.js';
import {
  findCellsInLasso,
  findCellsInProximity,
} from '../assets/js/rendering/highlight-renderer.js';
import {
  findRaySamplePick,
} from '../assets/js/rendering/picking.js';
import {
  POINT_VISIBILITY_THRESHOLD,
} from '../assets/js/rendering/alpha-visibility.js';

function identityMatrix() {
  const matrix = new Float32Array(16);
  matrix[0] = 1;
  matrix[5] = 1;
  matrix[10] = 1;
  matrix[15] = 1;
  return matrix;
}

const mat4 = {
  create: identityMatrix,
  multiply(out, left, right) {
    const product = new Float32Array(16);
    for (let column = 0; column < 4; column++) {
      for (let row = 0; row < 4; row++) {
        let value = 0;
        for (let inner = 0; inner < 4; inner++) {
          value +=
            left[inner * 4 + row] *
            right[column * 4 + inner];
        }
        product[column * 4 + row] = value;
      }
    }
    out.set(product);
    return out;
  },
};

function makeSpatialIndex(
  positions,
  dimensionLevel,
  maxPointsPerNode = 8,
) {
  return new SpatialIndex(
    positions,
    null,
    dimensionLevel,
    maxPointsPerNode,
    18,
    {
      buildLOD: false,
      buildLodNodeMappings: false,
      computeNodeStats: false,
    },
  );
}

function makeViewport(projectionMatrix = identityMatrix()) {
  return {
    viewId: 'pane',
    vpWidth: 160,
    vpHeight: 120,
    vpOffsetX: 25,
    vpOffsetY: 15,
    vpLocalX: 0,
    vpLocalY: 0,
    vpAspect: 4 / 3,
    projectionCenterNdcX: 0,
    projectionMatrix,
    effectiveViewMatrix: identityMatrix(),
    cameraForward: Float32Array.from([0, 0, -1]),
    cameraTargetRadius: 2,
  };
}

function makeLassoContext(projectionMatrix = identityMatrix()) {
  return {
    viewId: 'pane',
    viewport: makeViewport(projectionMatrix),
    viewMatrix: identityMatrix(),
  };
}

function sortedIds(values) {
  return [...values].sort((left, right) => left - right);
}

function assertExactSetParity(direct, indexed) {
  // Direct traversal happens to be ascending. Indexed traversal is
  // intentionally spatial and therefore has no public ordering contract.
  assert.deepEqual(direct, sortedIds(direct));
  assert.equal(new Set(indexed).size, indexed.length);
  assert.deepEqual(sortedIds(indexed), direct);
}

test('indexed lasso and proximity match direct selection in every dimension', () => {
  let randomState = 0x51f15e;
  const random = () => {
    randomState = (
      Math.imul(randomState, 1664525) + 1013904223
    ) >>> 0;
    return randomState / 0x100000000;
  };

  for (const dimensionLevel of [1, 2, 3]) {
    const pointCount = 8192;
    const positions = new Float32Array(pointCount * 3);
    const transparency = new Float32Array(pointCount);
    for (let cellIndex = 0; cellIndex < pointCount; cellIndex++) {
      const offset = cellIndex * 3;
      positions[offset] = random() * 4 - 2;
      positions[offset + 1] = random() * 4 - 2;
      positions[offset + 2] = random() * 2.8 - 1.4;
      transparency[cellIndex] =
        cellIndex % 17 === 0
          ? 0
          : (
              cellIndex % 19 === 0
                ? Math.fround(0.009)
                : (
                    cellIndex % 23 === 0
                      ? Math.fround(0.01)
                      : 1
                  )
            );
    }
    const spatialIndex = makeSpatialIndex(
      positions,
      dimensionLevel,
    );

    const directProximityStats = {};
    const directProximity = findCellsInProximity({
      transparencyArray: transparency,
      centerPos: [0.1, -0.15, 0.05],
      radius3D: 0.42,
      viewPositions: positions,
      queryStats: directProximityStats,
    });
    const indexedProximityStats = {};
    const indexedProximity = findCellsInProximity({
      transparencyArray: transparency,
      centerPos: [0.1, -0.15, 0.05],
      radius3D: 0.42,
      viewPositions: positions,
      spatialIndex,
      queryStats: indexedProximityStats,
    });
    assertExactSetParity(directProximity, indexedProximity);
    assert.equal(
      directProximityStats.examinedPointCount,
      pointCount,
    );
    assert.ok(
      indexedProximityStats.examinedPointCount <= pointCount,
    );

    const lassoPath = [
      { x: 73, y: 40 },
      { x: 131, y: 37 },
      { x: 146, y: 72 },
      { x: 112, y: 104 },
      { x: 66, y: 83 },
    ];
    const directLassoStats = {};
    const directLasso = findCellsInLasso({
      lassoPath,
      lassoViewContext: makeLassoContext(),
      mat4,
      modelMatrix: identityMatrix(),
      transparencyArray: transparency,
      viewPositions: positions,
      queryStats: directLassoStats,
    });
    const indexedLassoStats = {};
    const indexedLasso = findCellsInLasso({
      lassoPath,
      lassoViewContext: makeLassoContext(),
      mat4,
      modelMatrix: identityMatrix(),
      transparencyArray: transparency,
      viewPositions: positions,
      spatialIndex,
      queryStats: indexedLassoStats,
    });
    assertExactSetParity(directLasso, indexedLasso);
    assert.equal(directLassoStats.examinedPointCount, pointCount);
    assert.ok(indexedLassoStats.examinedPointCount <= pointCount);
  }
});

test('radius traversal is cap-free and visits every candidate ID at most once', () => {
  const pointCount = 513;
  const positions = new Float32Array(pointCount * 3);
  const transparency = new Float32Array(pointCount).fill(1);
  for (let cellIndex = 0; cellIndex < pointCount; cellIndex++) {
    const offset = cellIndex * 3;
    positions[offset] = (cellIndex % 9) * 0.0001;
    positions[offset + 1] = (cellIndex % 7) * 0.0001;
    positions[offset + 2] = (cellIndex % 5) * 0.0001;
  }
  const spatialIndex = makeSpatialIndex(positions, 3, 4);
  const queryStats = {};
  const selected = findCellsInProximity({
    transparencyArray: transparency,
    centerPos: [0, 0, 0],
    radius3D: 0.01,
    viewPositions: positions,
    spatialIndex,
    queryStats,
  });

  assert.equal(selected.length, pointCount);
  assert.equal(new Set(selected).size, pointCount);
  assert.equal(queryStats.examinedPointCount, pointCount);
});

test('projected traversal is conservative across clip-W and near-plane adversaries', () => {
  // clipW=z. Negative-W points reverse screen inequalities and a node spanning
  // z=0 cannot safely use ordinary frustum rejection.
  const projection = identityMatrix();
  projection[11] = 1;
  projection[15] = 0;
  const positions = Float32Array.from([
    0, 0, -1,
    0, 0, 1,
    0.05, -0.05, -0.5,
    0.05, -0.05, 0.5,
    2, 0, 1,
    -2, 0, -1,
    0, 0, 1e-11,
    0, 0, -1e-11,
    0, 0, 2,
    0, 0, -2,
    4, 4, 1,
    -4, -4, -1,
  ]);
  const transparency = Float32Array.from([
    1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, Math.fround(0.009),
  ]);
  const lassoPath = [
    { x: 85, y: 55 },
    { x: 125, y: 55 },
    { x: 125, y: 95 },
    { x: 85, y: 95 },
  ];

  for (const dimensionLevel of [1, 2, 3]) {
    const spatialIndex = makeSpatialIndex(
      positions,
      dimensionLevel,
      1,
    );
    const direct = findCellsInLasso({
      lassoPath,
      lassoViewContext: makeLassoContext(projection),
      mat4,
      modelMatrix: identityMatrix(),
      transparencyArray: transparency,
      viewPositions: positions,
    });
    const queryStats = {};
    const indexed = findCellsInLasso({
      lassoPath,
      lassoViewContext: makeLassoContext(projection),
      mat4,
      modelMatrix: identityMatrix(),
      transparencyArray: transparency,
      viewPositions: positions,
      spatialIndex,
      queryStats,
    });
    assertExactSetParity(direct, indexed);
    assert.ok(queryStats.examinedPointCount <= positions.length / 3);
    assert.ok(direct.includes(0), 'negative clip-W point remains selectable');
    assert.ok(direct.includes(1), 'positive clip-W point remains selectable');
    assert.ok(!direct.includes(6), 'clip-W singularity is rejected exactly');
    assert.ok(!direct.includes(7), 'negative clip-W singularity is rejected exactly');
  }
});

test('same-size spatial indexes from another position owner are rejected', () => {
  const positions = Float32Array.from([
    0, 0, 0,
    0.1, 0.1, 0.1,
  ]);
  const wrongPositions = Float32Array.from([
    50, 50, 50,
    60, 60, 60,
  ]);
  const transparency = Float32Array.of(1, 1);
  const wrongIndex = makeSpatialIndex(wrongPositions, 3, 1);

  assert.throws(
    () => findCellsInProximity({
      transparencyArray: transparency,
      centerPos: [0, 0, 0],
      radius3D: 1,
      viewPositions: positions,
      spatialIndex: wrongIndex,
    }),
    /exact matching spatial owner/,
  );
  assert.throws(
    () => findCellsInLasso({
      lassoPath: [
        { x: 70, y: 50 },
        { x: 120, y: 50 },
        { x: 120, y: 100 },
      ],
      lassoViewContext: makeLassoContext(),
      mat4,
      modelMatrix: identityMatrix(),
      transparencyArray: transparency,
      viewPositions: positions,
      spatialIndex: wrongIndex,
    }),
    /exact matching spatial owner/,
  );
  assert.throws(
    () => findRaySamplePick({
      positions,
      transparency,
      ray: {
        origin: [0, 0, -1],
        direction: [0, 0, 1],
      },
      maxDistance: 2,
      spatialIndex: wrongIndex,
    }),
    /exact matching spatial owner/,
  );
});

test('lasso and proximity use the float32 shader visibility boundary', () => {
  const positions = Float32Array.from([
    0, 0, 0,
    0.01, 0, 0,
    -0.01, 0, 0,
  ]);
  const transparency = Float32Array.from([
    0,
    POINT_VISIBILITY_THRESHOLD,
    Math.fround(2.49 / 255),
  ]);
  const spatialIndex = makeSpatialIndex(positions, 3, 1);

  const proximity = findCellsInProximity({
    transparencyArray: transparency,
    centerPos: [0, 0, 0],
    radius3D: 1,
    viewPositions: positions,
    spatialIndex,
  });
  const lasso = findCellsInLasso({
    lassoPath: [
      { x: 80, y: 55 },
      { x: 130, y: 55 },
      { x: 130, y: 100 },
      { x: 80, y: 100 },
    ],
    lassoViewContext: makeLassoContext(),
    mat4,
    modelMatrix: identityMatrix(),
    transparencyArray: transparency,
    viewPositions: positions,
    spatialIndex,
  });

  assert.deepEqual(proximity, [1]);
  assert.deepEqual(lasso, [1]);
});
