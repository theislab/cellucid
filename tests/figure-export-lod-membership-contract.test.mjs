import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  computeVisibleCameraBounds,
  computeVisibleRealBounds,
} from '../assets/js/app/ui/modules/figure-export/utils/coordinate-mapper.js';
import {
  reducePointsByDensity,
} from '../assets/js/app/ui/modules/figure-export/utils/density-reducer.js';
import {
  assertLodMembership,
  matchesLodMembershipPresentation,
} from '../assets/js/app/ui/modules/figure-export/utils/lod-membership.js';
import {
  forEachProjectedPoint,
} from '../assets/js/app/ui/modules/figure-export/utils/point-projector.js';
import {
  getLodMembership,
} from '../assets/js/app/ui/modules/figure-export/utils/point-size.js';
import {
  rasterizePointsWebgl,
} from '../assets/js/app/ui/modules/figure-export/utils/webgl-point-rasterizer.js';

const figureExportRoot = new URL(
  '../assets/js/app/ui/modules/figure-export/',
  import.meta.url
);

const IDENTITY_MATRIX = Float32Array.from([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

const POSITIONS = Float32Array.from([
  -0.75, -0.5, 0,
  -0.25, -0.1, 0,
  0.25, 0.2, 0,
  0.75, 0.6, 0,
]);

test('presented LOD freshness compares only opaque generation and scalar shape', () => {
  const membership = createMembership();
  const presented = Object.freeze({
    admittedCount: membership.indices.length,
    dimensionLevel: membership.dimensionLevel,
    generationToken: membership.generationToken,
    lodLevel: membership.lodLevel,
    pointCount: membership.pointCount,
  });
  assert.equal(
    matchesLodMembershipPresentation(presented, membership),
    true,
  );
  assert.equal(
    Object.hasOwn(presented, 'indices'),
    false,
  );
  assert.equal(
    Object.hasOwn(presented, 'admissionLevels'),
    false,
  );
  assert.equal(
    matchesLodMembershipPresentation(
      Object.freeze({
        ...presented,
        admittedCount: presented.admittedCount - 1,
      }),
      membership,
    ),
    false,
  );
  assert.equal(
    matchesLodMembershipPresentation(
      Object.freeze({
        ...presented,
        generationToken: Object.freeze({}),
      }),
      membership,
    ),
    false,
  );
  assert.equal(matchesLodMembershipPresentation(null, null), true);
});

const COLORS = Uint8Array.from([
  255, 0, 0, 255,
  0, 255, 0, 255,
  0, 0, 255, 255,
  255, 255, 255, 255,
]);

function createMembership({
  admissionLevels = [0, 1, 2, 255],
  dimensionLevel = 2,
  generationToken = Object.freeze({}),
  indices = null,
  lodLevel = 1,
  pointCount = admissionLevels.length,
} = {}) {
  const exactAdmissionLevels = Uint8Array.from(admissionLevels);
  const exactIndices = indices === null
    ? Uint32Array.from(
        Array.from(exactAdmissionLevels.keys()).filter(
          index => exactAdmissionLevels[index] <= lodLevel
        )
      )
    : Uint32Array.from(indices);
  return Object.freeze({
    admissionLevels: exactAdmissionLevels,
    dimensionLevel,
    generationToken,
    indices: exactIndices,
    lodLevel,
    pointCount,
  });
}

function renderState() {
  return {
    mvpMatrix: IDENTITY_MATRIX,
    viewMatrix: IDENTITY_MATRIX,
    modelMatrix: IDENTITY_MATRIX,
    projectionMatrix: IDENTITY_MATRIX,
    viewportWidth: 100,
    viewportHeight: 100,
    fov: 1,
    pointSize: 4,
    sizeAttenuation: 1,
    lightingStrength: 1,
    fogDensity: 0,
    fogColor: Float32Array.from([0, 0, 0]),
    lightDir: Float32Array.from([0, 0, 1]),
    cameraPosition: [0, 0, 2],
    shaderQuality: 'full',
  };
}

async function collectJavascriptSources(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const sources = [];
  for (const entry of entries) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directoryUrl);
    if (entry.isDirectory()) {
      sources.push(...await collectJavascriptSources(child));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      sources.push(await readFile(child, 'utf8'));
    }
  }
  return sources;
}

test('figure-export validates one exact frozen LOD membership owner', () => {
  const membership = createMembership();
  assert.equal(assertLodMembership(null, { pointCount: 4, dimensionLevel: 2 }), null);
  assert.equal(
    assertLodMembership(membership, { pointCount: 4, dimensionLevel: 2 }),
    membership
  );
  const compactExportMembership = Object.freeze({
    dimensionLevel: membership.dimensionLevel,
    generationToken: Object.freeze({}),
    indices: new Uint32Array(membership.indices),
    lodLevel: membership.lodLevel,
    pointCount: membership.pointCount,
  });
  assert.equal(
    assertLodMembership(compactExportMembership, {
      pointCount: 4,
      dimensionLevel: 2,
    }),
    compactExportMembership,
    'atomic export owns only the K admitted IDs, not another dense N-byte array'
  );

  assert.throws(
    () => assertLodMembership({ ...membership }, { pointCount: 4 }),
    /exact frozen descriptor/
  );
  assert.throws(
    () => assertLodMembership(Object.freeze({
      ...membership,
      [Symbol('unexpected')]: true,
    }), { pointCount: 4 }),
    /exact frozen descriptor/
  );
  assert.throws(
    () => assertLodMembership(createMembership({ pointCount: 3 }), {
      pointCount: 4,
    }),
    /one Uint8 admission level|pointCount/
  );
  assert.throws(
    () => assertLodMembership(createMembership({ dimensionLevel: 3 }), {
      pointCount: 4,
      dimensionLevel: 2,
    }),
    /dimensionLevel/
  );
  assert.throws(
    () => assertLodMembership(createMembership({ generationToken: null }), {
      pointCount: 4,
    }),
    /generationToken/
  );
  assert.throws(
    () => assertLodMembership(createMembership({ lodLevel: -1 }), {
      pointCount: 4,
    }),
    /lodLevel/
  );
  assert.throws(
    () => assertLodMembership(Object.freeze({
      ...membership,
      indices: Float32Array.from([0, 1]),
    }), { pointCount: 4 }),
    /Uint32 prefix/
  );
  assert.throws(
    () => assertLodMembership(createMembership({
      indices: [0, 1, 2, 3, 0],
    }), { pointCount: 4 }),
    /Uint32 prefix/
  );
});

test('point-size accessor preserves descriptor identity and exact view ownership', () => {
  const membership = createMembership();
  const calls = [];
  const viewer = {
    getCurrentLodMembership(viewId, dimensionLevel) {
      calls.push([viewId, dimensionLevel]);
      return membership;
    },
  };

  assert.equal(
    getLodMembership({ viewer, viewId: 7, dimensionLevel: 2 }),
    membership
  );
  assert.deepEqual(calls, [['7', 2]]);
  assert.throws(
    () => getLodMembership({
      viewer: {},
      viewId: 'live',
      dimensionLevel: 2,
    }),
    /requires viewer\.getCurrentLodMembership/
  );
});

test('projection admits source points at or below the active LOD level', () => {
  const membership = createMembership();
  for (const sortByDepth of [false, true]) {
    const indices = [];
    const result = forEachProjectedPoint({
      positions: POSITIONS,
      colors: COLORS,
      lodMembership: membership,
      renderState: renderState(),
      plotRect: { x: 0, y: 0, width: 100, height: 100 },
      sortByDepth,
      onPoint(_x, _y, _r, _g, _b, _a, _radius, index) {
        indices.push(index);
      },
    });
    assert.deepEqual(indices, [0, 1]);
    assert.equal(result.drawn, 2);
    assert.equal(result.skipped, 2);
  }

  const fullDetailIndices = [];
  forEachProjectedPoint({
    positions: POSITIONS,
    colors: COLORS,
    lodMembership: null,
    renderState: renderState(),
    plotRect: { x: 0, y: 0, width: 100, height: 100 },
    onPoint(_x, _y, _r, _g, _b, _a, _radius, index) {
      fullDetailIndices.push(index);
    },
  });
  assert.deepEqual(fullDetailIndices, [0, 1, 2, 3]);
});

test('depth-sorted projection packs only in-crop points before assigning bins', () => {
  const positions = Float32Array.from([
    -0.5, 0, 0,
    0.5, 0, 0,
  ]);
  const colors = Uint8Array.from([
    255, 0, 0, 255,
    0, 255, 0, 255,
  ]);
  const projected = [];

  const result = forEachProjectedPoint({
    positions,
    colors,
    renderState: renderState(),
    plotRect: { x: 0, y: 0, width: 100, height: 100 },
    crop: {
      enabled: true,
      x: 0.5,
      y: 0,
      width: 0.5,
      height: 1,
    },
    sortByDepth: true,
    onPoint(...point) {
      projected.push(point);
    },
  });

  assert.deepEqual(result, { drawn: 1, skipped: 1 });
  assert.equal(projected.length, 1);
  assert.equal(projected[0][7], 1);
  assert.deepEqual(projected[0].slice(2, 6), [0, 255, 0, 1]);
  assert.ok(
    projected[0].every(Number.isFinite),
    'a cropped depth bin must never expose an uninitialized packed slot'
  );
});

test('density reduction and coordinate bounds share exact LOD admission semantics', () => {
  const membership = createMembership();
  const reduced = reducePointsByDensity({
    positions: POSITIONS,
    colors: COLORS,
    lodMembership: membership,
    renderState: renderState(),
    targetCount: 100,
    gridSize: 32,
    seed: 9,
  });
  assert.deepEqual(Array.from(reduced.index).sort((a, b) => a - b), [0, 1]);

  const realBounds = computeVisibleRealBounds({
    positions: POSITIONS,
    lodMembership: membership,
    mvpMatrix: IDENTITY_MATRIX,
    viewportWidth: 100,
    viewportHeight: 100,
    normTransform: { center: [0, 0, 0], scale: 1 },
  });
  assert.deepEqual(realBounds, {
    minX: POSITIONS[0],
    maxX: POSITIONS[3],
    minY: POSITIONS[1],
    maxY: POSITIONS[4],
  });

  const cameraBounds = computeVisibleCameraBounds({
    positions: POSITIONS,
    lodMembership: membership,
    mvpMatrix: IDENTITY_MATRIX,
    viewMatrix: IDENTITY_MATRIX,
    viewportWidth: 100,
    viewportHeight: 100,
  });
  assert.deepEqual(cameraBounds, realBounds);

  const fullDetail = reducePointsByDensity({
    positions: POSITIONS,
    colors: COLORS,
    lodMembership: null,
    renderState: renderState(),
    targetCount: 100,
    gridSize: 32,
    seed: 9,
  });
  assert.deepEqual(
    Array.from(fullDetail.index).sort((a, b) => a - b),
    [0, 1, 2, 3]
  );
});

test('optimized reduction and coordinate bounds reject the full depth clip volume', () => {
  const positions = Float32Array.from([
    -0.8, -0.4, -1.01,
    0.1, 0.2, 0,
    0.9, 0.7, 1.01,
  ]);
  const colors = new Uint8Array(12);
  colors.fill(255);
  const membership = createMembership({
    admissionLevels: [0, 0, 0],
    lodLevel: 0,
  });

  for (const sortByDepth of [false, true]) {
    const projectedIndices = [];
    forEachProjectedPoint({
      positions,
      colors,
      lodMembership: membership,
      renderState: renderState(),
      plotRect: { x: 0, y: 0, width: 100, height: 100 },
      sortByDepth,
      onPoint(_x, _y, _r, _g, _b, _a, _radius, index) {
        projectedIndices.push(index);
      },
    });
    assert.deepEqual(projectedIndices, [1]);
  }

  const reduced = reducePointsByDensity({
    positions,
    colors,
    lodMembership: membership,
    renderState: renderState(),
    targetCount: 10,
    gridSize: 32,
    seed: 29,
  });
  assert.deepEqual(Array.from(reduced.index), [1]);

  const expectedBounds = {
    minX: positions[3],
    maxX: positions[3],
    minY: positions[4],
    maxY: positions[4],
  };
  assert.deepEqual(
    computeVisibleRealBounds({
      positions,
      lodMembership: membership,
      mvpMatrix: IDENTITY_MATRIX,
      viewportWidth: 100,
      viewportHeight: 100,
      normTransform: { center: [0, 0, 0], scale: 1 },
    }),
    expectedBounds
  );
  assert.deepEqual(
    computeVisibleCameraBounds({
      positions,
      lodMembership: membership,
      mvpMatrix: IDENTITY_MATRIX,
      viewMatrix: IDENTITY_MATRIX,
      viewportWidth: 100,
      viewportHeight: 100,
    }),
    expectedBounds
  );
});

test('density reduction apportions an exact deterministic 1000-point grid target', () => {
  const side = 40;
  const pointCount = side * side;
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);
  colors.fill(255);
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const pointIndex = row * side + column;
      const positionIndex = pointIndex * 3;
      positions[positionIndex] = ((column + 0.5) / side) * 2 - 1;
      positions[positionIndex + 1] = ((row + 0.5) / side) * 2 - 1;
    }
  }

  const options = {
    positions,
    colors,
    renderState: renderState(),
    targetCount: 1000,
    gridSize: side,
    seed: 20260729,
  };
  const first = reducePointsByDensity(options);
  const second = reducePointsByDensity(options);

  assert.equal(first.index.length, 1000);
  assert.equal(new Set(first.index).size, 1000);
  assert.deepEqual(first.index, second.index);
  assert.equal(
    reducePointsByDensity({ ...options, targetCount: pointCount + 1 }).index.length,
    pointCount
  );
  assert.equal(
    reducePointsByDensity({ ...options, targetCount: 0 }).index.length,
    0
  );
});

test('density reduction cannot sample away visible highlighted points', () => {
  const pointCount = 100;
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);
  colors.fill(255);
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    const positionIndex = pointIndex * 3;
    positions[positionIndex] =
      ((pointIndex % 10) + 0.5) / 5 - 1;
    positions[positionIndex + 1] =
      (Math.floor(pointIndex / 10) + 0.5) / 5 - 1;
  }
  const highlightArray = new Uint8Array(pointCount);
  const highlightedIndices = [97, 98, 99];
  for (const pointIndex of highlightedIndices) {
    highlightArray[pointIndex] = 255;
  }

  const reduced = reducePointsByDensity({
    positions,
    colors,
    highlightArray,
    highlightedIndices,
    renderState: renderState(),
    targetCount: 10,
    gridSize: 32,
    seed: 41,
  });
  const selected = new Set(reduced.index);

  assert.equal(reduced.index.length, 10);
  for (const pointIndex of highlightedIndices) {
    assert.equal(
      selected.has(pointIndex),
      true,
      `highlighted point ${pointIndex} must survive reduction`
    );
  }
});

test('highlight overflow uses one exact deterministic density-bounded budget', () => {
  const pointCount = 40;
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);
  const highlightArray = new Uint8Array(pointCount);
  colors.fill(255);
  highlightArray.fill(255, 0, 20);
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    const positionIndex = pointIndex * 3;
    positions[positionIndex] =
      ((pointIndex % 8) + 0.5) / 4 - 1;
    positions[positionIndex + 1] =
      (Math.floor(pointIndex / 8) + 0.5) / 2.5 - 1;
  }
  const options = {
    positions,
    colors,
    highlightArray,
    highlightedIndices: Array.from({ length: 20 }, (_, index) => index),
    renderState: renderState(),
    targetCount: 7,
    gridSize: 32,
    seed: 73,
  };

  const first = reducePointsByDensity(options);
  const second = reducePointsByDensity(options);
  assert.equal(first.index.length, 7);
  assert.deepEqual(first.index, second.index);
  assert.equal(
    Array.from(first.index).every(
      pointIndex => highlightArray[pointIndex] >= 3
    ),
    true
  );
});

test('fast density preview preserves only renderer-visible sparse highlights outside its stride', () => {
  const pointCount = 1000;
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);
  const highlightArray = new Uint8Array(pointCount);
  const transparency = new Float32Array(pointCount);
  colors.fill(255);
  transparency.fill(1);
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    const positionIndex = pointIndex * 3;
    positions[positionIndex] =
      ((pointIndex % 25) + 0.5) / 12.5 - 1;
    positions[positionIndex + 1] =
      (Math.floor(pointIndex / 25) + 0.5) / 20 - 1;
  }
  highlightArray[996] = 255;
  highlightArray[997] = 255;
  highlightArray[998] = 255;
  highlightArray[999] = 255;
  transparency[997] = 0;
  positions[999 * 3 + 2] = 2;
  const admittedIds = Uint32Array.from(
    Array.from({ length: pointCount - 1 }, (_, index) =>
      index < 998 ? index : 999
    )
  );
  const admissionLevels = new Uint8Array(pointCount);
  admissionLevels.fill(0xff);
  for (const pointIndex of admittedIds) admissionLevels[pointIndex] = 0;
  const lodMembership = Object.freeze({
    admissionLevels,
    dimensionLevel: 2,
    generationToken: Object.freeze({}),
    indices: admittedIds,
    lodLevel: 0,
    pointCount,
  });

  const reduced = reducePointsByDensity({
    positions,
    colors,
    transparency,
    lodMembership,
    highlightArray,
    highlightedIndices: [996, 997, 998, 999],
    renderState: renderState(),
    targetCount: 10,
    gridSize: 32,
    maxScanPoints: 10,
    seed: 97,
  });

  assert.equal(reduced.index.length, 10);
  assert.equal(Array.from(reduced.index).includes(996), true);
  assert.equal(Array.from(reduced.index).includes(997), false);
  assert.equal(Array.from(reduced.index).includes(998), false);
  assert.equal(Array.from(reduced.index).includes(999), false);
});

test('compact LOD preview never leaks an unadmitted sparse highlight', () => {
  const pointCount = 1000;
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);
  const highlightArray = new Uint8Array(pointCount);
  const transparency = new Float32Array(pointCount);
  colors.fill(255);
  transparency.fill(1);
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    positions[pointIndex * 3] =
      ((pointIndex % 25) + 0.5) / 12.5 - 1;
    positions[pointIndex * 3 + 1] =
      (Math.floor(pointIndex / 25) + 0.5) / 20 - 1;
  }
  highlightArray[998] = 255;
  const admittedIds = Uint32Array.from(
    Array.from({ length: pointCount - 1 }, (_, index) =>
      index < 998 ? index : 999
    )
  );
  const lodMembership = Object.freeze({
    dimensionLevel: 2,
    generationToken: Object.freeze({}),
    indices: admittedIds,
    lodLevel: 0,
    pointCount,
  });

  const reduced = reducePointsByDensity({
    positions,
    colors,
    transparency,
    lodMembership,
    highlightArray,
    highlightedIndices: [998],
    renderState: renderState(),
    targetCount: 10,
    gridSize: 32,
    maxScanPoints: 10,
    seed: 97,
  });

  assert.equal(Array.from(reduced.index).includes(998), false);
  assert.equal(reduced.scannedSourceCount, 10);
});

test('reduced figure export consumes only the exact K-point prefix for large N', () => {
  const pointCount = 200_000;
  const admittedIds = Uint32Array.from([
    pointCount - 1,
    12_345,
    42,
    150_000,
  ]);
  const positions = new Float32Array(pointCount * 3);
  positions.fill(4);
  const colors = new Uint8Array(pointCount * 4);
  colors.fill(255);
  for (let rank = 0; rank < admittedIds.length; rank++) {
    const pointIndex = admittedIds[rank];
    const positionIndex = pointIndex * 3;
    positions[positionIndex] = -0.75 + rank * 0.5;
    positions[positionIndex + 1] = -0.5 + rank * 0.25;
    positions[positionIndex + 2] = 0;
  }

  const admissionOwner = new Uint8Array(pointCount);
  admissionOwner.fill(0xff);
  for (const pointIndex of admittedIds) admissionOwner[pointIndex] = 0;
  let randomAdmissionReads = 0;
  const observedAdmissionOwner = new Proxy(admissionOwner, {
    get(target, key) {
      if (/^\d+$/.test(String(key))) randomAdmissionReads++;
      return Reflect.get(target, key, target);
    },
  });
  const membership = Object.freeze({
    admissionLevels: observedAdmissionOwner,
    dimensionLevel: 2,
    generationToken: Object.freeze({}),
    indices: admittedIds,
    lodLevel: 0,
    pointCount,
  });

  const projected = [];
  const projection = forEachProjectedPoint({
    positions,
    colors,
    lodMembership: membership,
    renderState: renderState(),
    plotRect: { x: 0, y: 0, width: 100, height: 100 },
    onPoint(_x, _y, _r, _g, _b, _a, _radius, index) {
      projected.push(index);
    },
  });
  const reduced = reducePointsByDensity({
    positions,
    colors,
    lodMembership: membership,
    renderState: renderState(),
    targetCount: 100,
    gridSize: 32,
    seed: 19,
  });

  assert.deepEqual(projected, Array.from(admittedIds));
  assert.equal(projection.drawn, admittedIds.length);
  assert.equal(projection.skipped, pointCount - admittedIds.length);
  assert.deepEqual(
    Array.from(reduced.index).sort((a, b) => a - b),
    Array.from(admittedIds).sort((a, b) => a - b)
  );
  assert.equal(
    randomAdmissionReads,
    0,
    'sequential export paths must not scan the N-byte random-access owner'
  );
});

test('WebGL packing compacts only the admitted prefix and borrows presented fog', async () => {
  const rasterizerSource = await readFile(
    new URL(
      'utils/webgl-point-rasterizer.js',
      figureExportRoot
    ),
    'utf8'
  );
  const start = rasterizerSource.indexOf('function packBuffers(');
  const end = rasterizerSource.indexOf(
    '/**\n * Render a point cloud',
    start
  );
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const packBuffers = new Function(
    `${rasterizerSource.slice(start, end)}
     return packBuffers;`
  )();

  const membership = createMembership({
    admissionLevels: [0, 2, 1, 255],
  });
  const packed = packBuffers({
    positions: POSITIONS,
    colors: COLORS,
    transparency: null,
    lodMembership: membership,
    highlightArray: null,
    emphasizeSelection: false,
    selectionMutedOpacity: 0.15,
    alphaThreshold: 0.01,
  });

  assert.equal(packed.count, 2);
  assert.deepEqual(
    Array.from(packed.positions),
    Array.from(POSITIONS.slice(0, 3)).concat(Array.from(POSITIONS.slice(6, 9)))
  );
  assert.deepEqual(
    Array.from(packed.colors),
    Array.from(COLORS.slice(0, 4)).concat(Array.from(COLORS.slice(8, 12)))
  );
  assert.equal(Object.hasOwn(packed, 'bounds'), false);
  assert.doesNotMatch(
    rasterizerSource.slice(start, end),
    /for\s*\(\s*let\s+i\s*=\s*0\s*;\s*i\s*<\s*n/,
    'fog bounds must not add a full-N scan before K-point packing'
  );

  const fullDetail = packBuffers({
    positions: POSITIONS,
    colors: COLORS,
    transparency: null,
    lodMembership: null,
    highlightArray: null,
    emphasizeSelection: false,
    selectionMutedOpacity: 0.15,
    alphaThreshold: 0.01,
  });
  assert.equal(fullDetail.count, 4);
  assert.equal(fullDetail.positions, POSITIONS);

  const largePointCount = 200_000;
  const admittedIds = Uint32Array.from([
    7,
    12_345,
    150_000,
    largePointCount - 1,
  ]);
  const largePositions = new Float32Array(largePointCount * 3);
  const largeColors = new Uint8Array(largePointCount * 4);
  largeColors.fill(255);
  let positionReads = 0;
  let colorReads = 0;
  const observedPositions = new Proxy(largePositions, {
    get(target, key) {
      if (/^\d+$/.test(String(key))) positionReads++;
      return Reflect.get(target, key, target);
    },
  });
  const observedColors = new Proxy(largeColors, {
    get(target, key) {
      if (/^\d+$/.test(String(key))) colorReads++;
      return Reflect.get(target, key, target);
    },
  });
  const admissionLevels = new Uint8Array(largePointCount);
  admissionLevels.fill(0xff);
  for (const pointIndex of admittedIds) admissionLevels[pointIndex] = 0;
  const largeMembership = Object.freeze({
    admissionLevels,
    dimensionLevel: 2,
    generationToken: Object.freeze({}),
    indices: admittedIds,
    lodLevel: 0,
    pointCount: largePointCount,
  });
  const compact = packBuffers({
    positions: observedPositions,
    colors: observedColors,
    transparency: null,
    lodMembership: largeMembership,
    highlightArray: null,
    emphasizeSelection: false,
    selectionMutedOpacity: 0.15,
    alphaThreshold: 0.01,
  });
  assert.equal(compact.count, admittedIds.length);
  assert.equal(positionReads, admittedIds.length * 3);
  assert.equal(colorReads, admittedIds.length * 4);
});

test('WebGL export rejects a descriptor from a different point generation', () => {
  const wrongGeneration = createMembership({
    admissionLevels: [0, 1],
  });
  assert.throws(
    () => rasterizePointsWebgl({
      positions: Float32Array.from([0, 0, 0]),
      colors: Uint8Array.from([255, 255, 255, 255]),
      lodMembership: wrongGeneration,
      renderState: renderState(),
      outputWidthPx: 16,
      outputHeightPx: 16,
      pointSizePx: 2,
    }),
    /pointCount/
  );
});

test('figure-export source has no dense LOD mask API or hot-loop conversion', async () => {
  const sources = await collectJavascriptSources(figureExportRoot);
  const combined = sources.join('\n');

  assert.doesNotMatch(
    combined,
    /visibilityMask|getLodVisibilityMask|getLodVisibilityArray/
  );
  assert.match(combined, /getCurrentLodMembership\(/);
  assert.ok(
    (combined.match(/lodMembership\?\.indices/g) ?? []).length >= 6,
    'all sequential exporter hot paths must consume the exact admitted prefix'
  );
  assert.doesNotMatch(
    combined,
    /const admissionLevels\s*=\s*lodMembership/,
    'sequential export must never fall back to scanning random-access admission bytes'
  );
});

test('preview invalidation stays scan-capped and only current ownership commits', async () => {
  const source = await readFile(
    new URL(
      'figure-export-ui.js',
      figureExportRoot
    ),
    'utf8'
  );
  const listenerStart = source.indexOf(
    'const subscribePreviewInvalidation ='
  );
  const listenerEnd = source.indexOf('  const nameEl =', listenerStart);
  assert.notEqual(listenerStart, -1);
  assert.notEqual(listenerEnd, -1);
  const listenerSource = source.slice(listenerStart, listenerEnd);
  for (const eventName of [
    'field:changed',
    'visibility:changed',
    'highlight:changed',
    'dimension:changed',
    'view:changed',
    'page:changed',
  ]) {
    assert.match(listenerSource, new RegExp(`['"]${eventName}['"]`));
  }
  assert.match(listenerSource, /invalidatePreviewSamples\(\)/);
  assert.match(listenerSource, /viewer\.onLodChanged/);
  assert.match(
    listenerSource,
    /viewer\.onPresentedViewStateChanged/
  );
  assert.match(
    listenerSource,
    /rebuildDelayMs:\s*PREVIEW_PRESENTATION_SETTLE_MS/
  );
  assert.match(
    listenerSource,
    /event\?\.reason === 'camera-changing'[\s\S]*rebuild: false/
  );
  assert.match(
    listenerSource,
    /event\?\.reason === 'camera-settled'[\s\S]*invalidatePreviewSamples\(\)/
  );

  const builderStart = source.indexOf(
    'async function buildPreviewSample('
  );
  const builderEnd = source.indexOf(
    '  function schedulePreviewDraw()',
    builderStart
  );
  assert.notEqual(builderStart, -1);
  assert.notEqual(builderEnd, -1);
  const builderSource = source.slice(builderStart, builderEnd);
  assert.match(
    builderSource,
    /const maxScanPoints = PREVIEW_MAX_SCAN_POINTS;/
  );
  assert.doesNotMatch(
    builderSource,
    /maxScanPoints\s*=\s*fastSample\s*\?[^:]+:\s*null/
  );
  assert.match(builderSource, /viewer\.withBorrowedViewData\(/);
  assert.match(builderSource, /previewEpochFence\.accepts\(/);
  assert.equal(
    (
      builderSource.match(
        /token !== previewBuildToken/g
      ) ?? []
    ).length,
    2
  );
  assert.match(builderSource, /return true;\s*\n  \}/);
  assert.match(
    builderSource,
    /candidate\.reduced\.scannedSourceCount/
  );
  assert.match(
    builderSource,
    /candidate\.reduced\.candidateSourceCount/
  );
  assert.doesNotMatch(
    builderSource,
    /visibleCount\s*>=\s*PREVIEW_AUTOBUILD_THRESHOLD/
  );
});
