import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighPerfRenderer,
  SpatialIndex,
} from '../assets/js/rendering/high-perf-renderer.js';
import {
  findKnnNeighborsUpToDegree,
  HighlightRenderer,
  HighlightTools,
  resetKnnCache,
} from '../assets/js/rendering/highlight-renderer.js';
import {
  POINT_VISIBILITY_THRESHOLD,
} from '../assets/js/rendering/alpha-visibility.js';

const FULL_DETAIL_ADMISSION = 0xff;
const PROJECTED_POINT_COUNT = 30_000_000;

function makeNestedSpatialIndex({
  dimensionLevel = 2,
  order = [5, 1, 7, 0, 3, 6, 2, 4],
} = {}) {
  const pointCount = order.length;
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);
  for (let pointId = 0; pointId < pointCount; pointId++) {
    const positionOffset = pointId * 3;
    positions[positionOffset] = pointId;
    positions[positionOffset + 1] = pointId * 2;
    positions[positionOffset + 2] = dimensionLevel === 3
      ? pointId * 3
      : 0;
    colors.fill(255, pointId * 4, pointId * 4 + 4);
  }

  const spatialIndex = new SpatialIndex(
    positions,
    colors,
    dimensionLevel,
    pointCount,
    1,
    {
      buildLOD: false,
      buildLodNodeMappings: false,
      computeNodeStats: false,
    },
  );
  const hierarchicalOrder = Uint32Array.from(order);
  spatialIndex._hierarchicalOrder = hierarchicalOrder;
  spatialIndex.lodLevels = [
    {
      depth: 0,
      indices: hierarchicalOrder.subarray(0, 2),
      isFullDetail: false,
      pointCount: 2,
      sizeMultiplier: 1.4,
    },
    {
      depth: 1,
      indices: hierarchicalOrder.subarray(0, 5),
      isFullDetail: false,
      pointCount: 5,
      sizeMultiplier: 1.2,
    },
    {
      depth: 2,
      isFullDetail: true,
      pointCount,
      positions,
      colors,
    },
  ];
  spatialIndex._buildLOD = true;
  return spatialIndex;
}

function collectReachableTypedViews(root) {
  const seen = new Set();
  const views = [];
  const pending = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (
      value === null ||
      typeof value !== 'object' ||
      seen.has(value)
    ) {
      continue;
    }
    seen.add(value);
    if (ArrayBuffer.isView(value)) {
      views.push(value);
      continue;
    }
    if (value instanceof ArrayBuffer) continue;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && Object.hasOwn(descriptor, 'value')) {
        pending.push(descriptor.value);
      }
    }
  }
  return views;
}

function expectedAdmissionLevels(
  pointCount,
  levelZero,
  levelOne,
) {
  const expected = new Uint8Array(pointCount);
  expected.fill(FULL_DETAIL_ADMISSION);
  for (const pointId of levelOne) expected[pointId] = 1;
  for (const pointId of levelZero) expected[pointId] = 0;
  return expected;
}

function assertExactMembershipDescriptor(
  descriptor,
  {
    admissionLevels,
    dimensionLevel,
    indices,
    lodLevel,
    pointCount,
  },
) {
  assert.ok(Object.isFrozen(descriptor));
  assert.deepEqual(
    Object.keys(descriptor).sort(),
    [
      'admissionLevels',
      'dimensionLevel',
      'generationToken',
      'indices',
      'lodLevel',
      'pointCount',
    ],
  );
  assert.ok(descriptor.admissionLevels instanceof Uint8Array);
  assert.equal(descriptor.admissionLevels, admissionLevels);
  assert.equal(descriptor.dimensionLevel, dimensionLevel);
  assert.equal(descriptor.indices, indices);
  assert.equal(descriptor.lodLevel, lodLevel);
  assert.equal(descriptor.pointCount, pointCount);
  assert.ok(
    descriptor.generationToken !== null &&
    typeof descriptor.generationToken === 'object' &&
    Object.isFrozen(descriptor.generationToken),
  );
}

test('LOD membership publishes one lazy compact admission owner shared by every reduced level', () => {
  const spatialIndex = makeNestedSpatialIndex();
  const pointCount = spatialIndex.pointCount;

  assert.equal(
    collectReachableTypedViews(spatialIndex).some(
      view =>
        view instanceof Uint8Array &&
        view.length === pointCount,
    ),
    false,
    'construction must not eagerly allocate point-count LOD membership',
  );
  assert.equal(spatialIndex.getLodMembership(-1), null);

  const levelZero = spatialIndex.getLodMembership(0);
  const levelOne = spatialIndex.getLodMembership(1);
  assert.equal(spatialIndex.getLodMembership(0), levelZero);
  assert.equal(spatialIndex.getLodMembership(1), levelOne);
  assert.equal(spatialIndex.getLodMembership(2), null);

  assertExactMembershipDescriptor(levelZero, {
    admissionLevels: levelZero.admissionLevels,
    dimensionLevel: 2,
    indices: spatialIndex.lodLevels[0].indices,
    lodLevel: 0,
    pointCount,
  });
  assertExactMembershipDescriptor(levelOne, {
    admissionLevels: levelZero.admissionLevels,
    dimensionLevel: 2,
    indices: spatialIndex.lodLevels[1].indices,
    lodLevel: 1,
    pointCount,
  });
  assert.equal(
    levelOne.generationToken,
    levelZero.generationToken,
  );
  assert.deepEqual(
    levelZero.admissionLevels,
    expectedAdmissionLevels(
      pointCount,
      spatialIndex.lodLevels[0].indices,
      spatialIndex.lodLevels[1].indices,
    ),
  );

  for (
    let lodLevel = 0;
    lodLevel < spatialIndex.lodLevels.length - 1;
    lodLevel++
  ) {
    const membership = spatialIndex.getLodMembership(lodLevel);
    const exactIds = new Set(
      spatialIndex.lodLevels[lodLevel].indices,
    );
    for (let pointId = 0; pointId < pointCount; pointId++) {
      assert.equal(
        membership.admissionLevels[pointId] <= lodLevel,
        exactIds.has(pointId),
        `LOD ${lodLevel}, point ${pointId}`,
      );
    }
  }

  assert.equal(levelZero.admissionLevels.byteLength, pointCount);
  const projectedSharedBytes =
    levelZero.admissionLevels.BYTES_PER_ELEMENT *
    PROJECTED_POINT_COUNT;
  const retiredFourPaneDenseBytes =
    Float32Array.BYTES_PER_ELEMENT *
    PROJECTED_POINT_COUNT *
    4;
  assert.equal(projectedSharedBytes, 30_000_000);
  assert.equal(retiredFourPaneDenseBytes, 480_000_000);
});

test('hostile LOD membership construction is atomic and retryable', async t => {
  const hostileCases = [
    {
      label: 'non-prefix level',
      detachedIndices: [5, 4, 7, 0, 3],
      order: [5, 1, 7, 0, 3, 6, 2, 4],
      pattern: /prefix|nested|membership/i,
    },
    {
      label: 'duplicate source id',
      order: [5, 1, 7, 7, 3, 6, 2, 4],
      pattern: /duplicate|repeat/i,
    },
    {
      label: 'out-of-range source id',
      order: [5, 1, 7, 8, 3, 6, 2, 4],
      pattern: /outside|range/i,
    },
    {
      label: 'duplicate source id in full-detail tail',
      order: [5, 1, 7, 0, 3, 6, 2, 6],
      pattern: /duplicate|repeat|tail/i,
    },
    {
      label: 'out-of-range source id in full-detail tail',
      order: [5, 1, 7, 0, 3, 6, 2, 8],
      pattern: /outside|range|tail/i,
    },
  ];

  for (const hostile of hostileCases) {
    await t.test(hostile.label, () => {
      const spatialIndex = makeNestedSpatialIndex({
        order: hostile.order,
      });
      if (hostile.detachedIndices) {
        spatialIndex.lodLevels[1] = {
          ...spatialIndex.lodLevels[1],
          indices: Uint32Array.from(hostile.detachedIndices),
        };
      }

      assert.throws(
        () => spatialIndex.getLodMembership(1),
        hostile.pattern,
      );
      assert.equal(
        collectReachableTypedViews(spatialIndex).some(
          view =>
            view instanceof Uint8Array &&
            view.length === spatialIndex.pointCount,
        ),
        false,
        'a rejected candidate must not become reachable',
      );

      const repairedOrder = Uint32Array.from([
        5, 1, 7, 0, 3, 6, 2, 4,
      ]);
      spatialIndex._hierarchicalOrder = repairedOrder;
      spatialIndex.lodLevels[0] = {
        ...spatialIndex.lodLevels[0],
        indices: repairedOrder.subarray(0, 2),
        pointCount: 2,
      };
      spatialIndex.lodLevels[1] = {
        ...spatialIndex.lodLevels[1],
        indices: repairedOrder.subarray(0, 5),
        pointCount: 5,
      };
      const retried = spatialIndex.getLodMembership(1);
      assert.deepEqual(
        retried.admissionLevels,
        expectedAdmissionLevels(
          spatialIndex.pointCount,
          spatialIndex.lodLevels[0].indices,
          spatialIndex.lodLevels[1].indices,
        ),
      );
    });
  }
});

test('renderer resolves shared and custom LOD membership from exact geometry owners without per-view masks', () => {
  const mainSpatialIndex = makeNestedSpatialIndex();
  const customSpatialIndex = makeNestedSpatialIndex({
    order: [2, 6, 4, 0, 7, 1, 3, 5],
  });
  const liveGeneration = 41;
  const customGeneration = 40;
  const viewIds = ['live', 'shared-a', 'shared-b', 'shared-c'];
  const perViewState = new Map(
    [...viewIds, 'custom'].map(viewId => [
      viewId,
      { lastLodLevel: 0 },
    ]),
  );
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _liveGeometryGeneration: liveGeneration,
      _perViewState: perViewState,
      _positions: mainSpatialIndex.positions,
      pointCount: mainSpatialIndex.pointCount,
      snapshotBuffers: new Map([
        ...viewIds.slice(1).map(viewId => [
          viewId,
          {
            dimensionLevel: 2,
            geometryGeneration: liveGeneration,
            positions: mainSpatialIndex.positions.slice(),
            spatialIndex: null,
          },
        ]),
        [
          'custom',
          {
            dimensionLevel: 2,
            geometryGeneration: customGeneration,
            positions: customSpatialIndex.positions,
            spatialIndex: customSpatialIndex,
          },
        ],
      ]),
      spatialIndices: new Map([[2, mainSpatialIndex]]),
    },
  );

  const sharedMemberships = viewIds.map(viewId =>
    renderer.getCurrentLodMembership(viewId, 2),
  );
  assert.ok(
    sharedMemberships.every(
      membership => membership === sharedMemberships[0],
    ),
  );
  assert.equal(
    renderer.getViewGeometryGeneration('live'),
    liveGeneration,
  );
  assert.equal(
    renderer.getViewGeometryGeneration('shared-a'),
    liveGeneration,
  );

  const customMembership =
    renderer.getCurrentLodMembership('custom', 2);
  assert.notEqual(customMembership, sharedMemberships[0]);
  assert.notEqual(
    customMembership.admissionLevels,
    sharedMemberships[0].admissionLevels,
  );
  assert.notEqual(
    customMembership.generationToken,
    sharedMemberships[0].generationToken,
  );
  assert.equal(
    renderer.getViewGeometryGeneration('custom'),
    customGeneration,
  );

  for (const viewState of perViewState.values()) {
    assert.equal(
      collectReachableTypedViews(viewState).some(
        view => view.length === renderer.pointCount,
      ),
      false,
      'a view may retain only scalar membership keys',
    );
  }

  perViewState.get('live').lastLodLevel = -1;
  assert.equal(
    renderer.getCurrentLodMembership('live', 2),
    null,
  );
  perViewState.get('live').lastLodLevel = 2;
  assert.equal(
    renderer.getCurrentLodMembership('live', 2),
    null,
  );
});

function makeStaleZeroHighlightFixture() {
  const pointCount = 8;
  const positions = new Float32Array(pointCount * 3);
  const transparency = new Float32Array(pointCount).fill(1);
  const staleBuffers = new Map(
    ['live', 'pane-a', 'pane-b', 'pane-c'].map(
      (viewId, index) => [
        viewId,
        {
          buffer: Object.freeze({ viewId }),
          dimensionLevel: 2,
          geometryGeneration: 1,
          lodSignature: 0,
          membershipGenerationToken: Object.freeze({ index }),
          pointCount: 2,
          vertexArray: Object.freeze({
            viewId,
            kind: 'highlight-vao',
          }),
        },
      ],
    ),
  );
  let membershipLookups = 0;
  let bufferAllocations = 0;
  let bufferUploads = 0;
  let drawCalls = 0;
  const deletedBuffers = [];
  const deletedVertexArrays = [];
  const gl = {
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88e8,
    NO_ERROR: 0,
    POINTS: 0,
    createBuffer() {
      bufferAllocations++;
      return {};
    },
    bindBuffer() {},
    bindVertexArray() {},
    deleteBuffer(buffer) {
      deletedBuffers.push(buffer);
    },
    deleteVertexArray(vertexArray) {
      deletedVertexArrays.push(vertexArray);
    },
    getError() {
      return this.NO_ERROR;
    },
    bufferData() {
      bufferUploads++;
    },
    drawArrays() {
      drawCalls++;
    },
  };
  const highlightRenderer = Object.assign(
    Object.create(HighlightRenderer.prototype),
    {
      _highlightDataRef: null,
      _highlightDataVersion: 0,
      _highlightedIndicesCache: null,
      _pendingBufferDeletes: new Set(),
      _pendingVertexArrayDeletes: new Set(),
      _totalHighlightedCount: 8,
      _viewBuffers: staleBuffers,
      gl,
    },
  );
  const hpRenderer = {
    getCurrentLodMembership() {
      membershipLookups++;
      throw new Error(
        'zero-highlight rendering requested compact LOD membership',
      );
    },
    getLodVisibilityArray() {
      membershipLookups++;
      throw new Error(
        'zero-highlight rendering requested a dense LOD mask',
      );
    },
    getCurrentLODLevel() {
      return 0;
    },
    getViewGeometryGeneration() {
      return 1;
    },
  };
  const tools = Object.assign(
    Object.create(HighlightTools.prototype),
    {
      _lastGeometryGenerationMap: new Map(),
      _lastLodMembershipMap: new Map(),
      _transparencyGenerations: new Map(),
      highlightArray: null,
      highlightRenderer,
      hpRenderer,
    },
  );
  return {
    get bufferAllocations() {
      return bufferAllocations;
    },
    get bufferUploads() {
      return bufferUploads;
    },
    get drawCalls() {
      return drawCalls;
    },
    deletedBuffers,
    deletedVertexArrays,
    get membershipLookups() {
      return membershipLookups;
    },
    highlightRenderer,
    pointCount,
    positions,
    staleBuffers,
    tools,
    transparency,
  };
}

test('zero highlights clear stale pane counts without requesting or allocating LOD membership', () => {
  const fixture = makeStaleZeroHighlightFixture();
  const emptyHighlights = new Uint8Array(fixture.pointCount);
  const retiredBuffers = new Map(
    [...fixture.staleBuffers].map(([viewId, state]) => [
      viewId,
      state.buffer,
    ]),
  );
  const retiredVertexArrays = new Map(
    [...fixture.staleBuffers].map(([viewId, state]) => [
      viewId,
      state.vertexArray,
    ]),
  );

  fixture.tools.updateHighlight(emptyHighlights, []);
  for (const viewId of fixture.staleBuffers.keys()) {
    fixture.tools.syncHighlightBufferForLod(
      fixture.positions,
      viewId,
      fixture.transparency,
      2,
    );
  }

  assert.equal(fixture.membershipLookups, 0);
  assert.equal(fixture.bufferAllocations, 0);
  assert.equal(fixture.bufferUploads, 0);
  assert.equal(fixture.highlightRenderer.getTotalPointCount(), 0);
  for (const [viewId, viewBuffer] of fixture.staleBuffers) {
    assert.equal(viewBuffer.pointCount, 0);
    assert.equal(viewBuffer.buffer, null);
    assert.equal(viewBuffer.vertexArray, null);
    fixture.highlightRenderer.draw({
      dimensionLevel: 2,
      viewId,
    });
  }
  assert.deepEqual(
    new Set(fixture.deletedBuffers),
    new Set(retiredBuffers.values()),
  );
  assert.equal(fixture.highlightRenderer._pendingBufferDeletes.size, 0);
  assert.deepEqual(
    new Set(fixture.deletedVertexArrays),
    new Set(retiredVertexArrays.values()),
  );
  assert.equal(
    fixture.highlightRenderer._pendingVertexArrayDeletes.size,
    0,
  );
  assert.equal(fixture.drawCalls, 0);
});

function nextFloat32(value, direction) {
  const buffer = new ArrayBuffer(4);
  const floats = new Float32Array(buffer);
  const words = new Uint32Array(buffer);
  floats[0] = Math.fround(value);
  words[0] += direction;
  return floats[0];
}

function makeMembershipDescriptor({
  admittedIds,
  dimensionLevel,
  label,
  lodLevel = 0,
  pointCount,
}) {
  const admissionLevels = new Uint8Array(pointCount);
  admissionLevels.fill(FULL_DETAIL_ADMISSION);
  for (const pointId of admittedIds) {
    admissionLevels[pointId] = lodLevel;
  }
  return Object.freeze({
    admissionLevels,
    dimensionLevel,
    generationToken: Object.freeze({ label }),
    indices: Uint32Array.from(admittedIds),
    lodLevel,
    pointCount,
  });
}

function legacySparsePositionFingerprints(positions) {
  const len = positions.length;
  const step = Math.max(3, Math.floor(len / 300)) * 3;
  let rendererSum = 0;
  let toolsSum = 0;
  for (let offset = 0; offset < len; offset += step) {
    rendererSum +=
      positions[offset] +
      positions[offset + 1] +
      positions[offset + 2];
    toolsSum += positions[offset];
  }
  const pointCount = len / 3;
  const q1 = Math.floor(pointCount * 0.25) * 3;
  const mid = Math.floor(pointCount * 0.5) * 3;
  const q3 = Math.floor(pointCount * 0.75) * 3;
  const last = len - 3;
  return [
    len * 31 + rendererSum,
    `${positions[0]},${positions[1]},${positions[2]},` +
      `${positions[q1]},${positions[mid]},${positions[q3]},` +
      `${positions[last]},${positions[last + 1]},` +
      `${positions[last + 2]},${toolsSum.toFixed(2)},${len}`,
  ];
}

function makeHighlightPublicationFixture() {
  const pointCount = 120;
  const positions = new Float32Array(pointCount * 3);
  for (let pointId = 0; pointId < pointCount; pointId++) {
    const offset = pointId * 3;
    positions[offset] = pointId;
    positions[offset + 1] = 100 + pointId;
    positions[offset + 2] = 200 + pointId;
  }
  const threshold = POINT_VISIBILITY_THRESHOLD;
  const transparency = new Float32Array(pointCount).fill(1);
  transparency[1] = threshold;
  transparency[2] = nextFloat32(threshold, -1);
  transparency[3] = nextFloat32(threshold, 1);

  const memberships = {
    dimension2: makeMembershipDescriptor({
      admittedIds: [1, 2, 3],
      dimensionLevel: 2,
      label: 'dimension-2',
      pointCount,
    }),
    dimension3A: makeMembershipDescriptor({
      admittedIds: [4],
      dimensionLevel: 3,
      label: 'dimension-3-a',
      pointCount,
    }),
    dimension3B: makeMembershipDescriptor({
      admittedIds: [3],
      dimensionLevel: 3,
      label: 'dimension-3-b',
      pointCount,
    }),
  };
  let activeMembership = memberships.dimension2;
  let geometryGeneration = 7;
  let legacyVisibilityCalls = 0;
  const uploads = [];
  const gl = {
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    NO_ERROR: 0,
    UNSIGNED_BYTE: 0x1401,
    createBuffer() {
      return {};
    },
    createVertexArray() {
      return {};
    },
    bindBuffer() {},
    bindVertexArray() {},
    deleteBuffer() {},
    deleteVertexArray() {},
    enableVertexAttribArray() {},
    getError() {
      return this.NO_ERROR;
    },
    bufferData(target, source, usage) {
      assert.equal(target, this.ARRAY_BUFFER);
      assert.equal(usage, this.DYNAMIC_DRAW);
      const sourceBytes = source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(
            source.buffer,
            source.byteOffset,
            source.byteLength,
          );
      const copied = sourceBytes.slice();
      const packed = new Float32Array(copied.buffer);
      const packedPositions = [];
      for (
        let floatOffset = 0;
        floatOffset < packed.length;
        floatOffset += 4
      ) {
        packedPositions.push([
          packed[floatOffset],
          packed[floatOffset + 1],
          packed[floatOffset + 2],
        ]);
      }
      uploads.push(packedPositions);
    },
    vertexAttribPointer() {},
  };
  const highlightRenderer = Object.assign(
    Object.create(HighlightRenderer.prototype),
    {
      _highlightDataRef: null,
      _highlightDataVersion: 0,
      _highlightedIndicesCache: null,
      _pendingBufferDeletes: new Set(),
      _pendingVertexArrayDeletes: new Set(),
      _totalHighlightedCount: 0,
      _viewBuffers: new Map(),
      attribLocations: {
        color: 1,
        position: 0,
      },
      gl,
    },
  );
  const hpRenderer = {
    getCurrentLodMembership(viewId, dimensionLevel) {
      assert.equal(viewId, 'live');
      assert.equal(dimensionLevel, activeMembership.dimensionLevel);
      return activeMembership;
    },
    getCurrentLODLevel() {
      return activeMembership.lodLevel;
    },
    getLodVisibilityArray() {
      legacyVisibilityCalls++;
      const dense = new Float32Array(pointCount);
      for (let pointId = 0; pointId < pointCount; pointId++) {
        dense[pointId] =
          activeMembership.admissionLevels[pointId] <=
          activeMembership.lodLevel
            ? 1
            : 0;
      }
      return dense;
    },
    getViewGeometryGeneration(viewId) {
      assert.equal(viewId, 'live');
      return geometryGeneration;
    },
  };
  const tools = Object.assign(
    Object.create(HighlightTools.prototype),
    {
      _lastGeometryGenerationMap: new Map(),
      _lastLodMembershipMap: new Map(),
      _transparencyGenerations: new Map(),
      highlightArray: null,
      highlightRenderer,
      hpRenderer,
    },
  );
  const highlightData = new Uint8Array(pointCount);
  for (const pointId of [1, 2, 3, 4]) {
    highlightData[pointId] = 255;
  }
  tools.updateHighlight(highlightData, [1, 2, 3, 4]);

  return {
    get legacyVisibilityCalls() {
      return legacyVisibilityCalls;
    },
    get membership() {
      return activeMembership;
    },
    set membership(value) {
      activeMembership = value;
    },
    get generation() {
      return geometryGeneration;
    },
    set generation(value) {
      geometryGeneration = value;
    },
    memberships,
    pointCount,
    positions,
    tools,
    transparency,
    uploads,
  };
}

test('highlight publication keys exact geometry, dimension, and membership while preserving the R8 alpha boundary', () => {
  const fixture = makeHighlightPublicationFixture();
  const sync = dimensionLevel =>
    fixture.tools.syncHighlightBufferForLod(
      fixture.positions,
      'live',
      fixture.transparency,
      dimensionLevel,
    );

  sync(2);
  assert.deepEqual(
    fixture.uploads.shift(),
    [
      [1, 101, 201],
      [3, 103, 203],
    ],
    'alpha immediately below the first R8-visible Float32 must be excluded',
  );
  assert.equal(
    fixture.legacyVisibilityCalls,
    0,
    'highlight rendering must not request a dense LOD mask',
  );

  sync(2);
  assert.equal(
    fixture.uploads.length,
    0,
    'stable exact cache keys must not republish the GPU buffer',
  );

  const legacyFingerprintsBefore =
    legacySparsePositionFingerprints(fixture.positions);
  const samePositionsReference = fixture.positions;
  fixture.positions[4] = 901;
  assert.equal(fixture.positions, samePositionsReference);
  assert.deepEqual(
    legacySparsePositionFingerprints(fixture.positions),
    legacyFingerprintsBefore,
    'the adversarial same-reference mutation must evade both retired sparse hashes',
  );
  fixture.generation = 8;
  sync(2);
  assert.deepEqual(
    fixture.uploads.shift(),
    [
      [1, 901, 201],
      [3, 103, 203],
    ],
    'an exact geometry generation change must republish unsampled coordinates',
  );

  sync(2);
  assert.equal(fixture.uploads.length, 0);

  fixture.membership = fixture.memberships.dimension3A;
  sync(3);
  assert.deepEqual(
    fixture.uploads.shift(),
    [[4, 104, 204]],
    'dimension is part of the exact membership cache key',
  );

  fixture.membership = fixture.memberships.dimension3B;
  sync(3);
  assert.deepEqual(
    fixture.uploads.shift(),
    [[3, 103, 203]],
    'a replacement spatial owner must invalidate the same numeric LOD',
  );
  assert.equal(fixture.uploads.length, 0);
});

test('transparency publication exactly retires same-reference KNN paths', () => {
  const adjacency = new Map([
    [0, Uint32Array.from([1])],
    [1, Uint32Array.from([0, 2])],
    [2, Uint32Array.from([1])],
  ]);
  const transparency = Float32Array.from([1, 1, 1]);
  resetKnnCache();
  assert.deepEqual(
    [...findKnnNeighborsUpToDegree(
      0,
      2,
      adjacency,
      transparency,
    ).allCells],
    [0, 1, 2],
  );

  // Filtering owns this Float32Array and mutates it in place. The explicit
  // viewer publication must invalidate visited/frontier state even though
  // the array identity is unchanged.
  transparency[1] = 0;
  const tools = Object.assign(
    Object.create(HighlightTools.prototype),
    {
      _disposed: false,
      _transparencyGenerations: new Map(),
    },
  );
  assert.equal(tools.handleTransparencyChange('live'), 1);
  assert.deepEqual(
    [...findKnnNeighborsUpToDegree(
      0,
      2,
      adjacency,
      transparency,
    ).allCells],
    [0],
  );
});

function makeHighlightUploadFailureFixture() {
  const errors = [];
  const createdBuffers = [];
  const createdVertexArrays = [];
  const deletedBuffers = [];
  const deletedVertexArrays = [];
  const attributeConfigurationCalls = [];
  const uploadContracts = [];
  let failNextBufferCreation = false;
  let failNextUpload = false;
  let failNextVertexArrayConfiguration = false;
  let failNextVertexArrayCreation = false;
  let nextBufferId = 1;
  let nextVertexArrayId = 1;
  let uploadAttempts = 0;
  const gl = {
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    NO_ERROR: 0,
    OUT_OF_MEMORY: 0x0505,
    UNSIGNED_BYTE: 0x1401,
    createBuffer() {
      if (failNextBufferCreation) {
        failNextBufferCreation = false;
        errors.push(this.OUT_OF_MEMORY);
        return null;
      }
      const buffer = Object.freeze({ id: nextBufferId++ });
      createdBuffers.push(buffer);
      return buffer;
    },
    createVertexArray() {
      if (failNextVertexArrayCreation) {
        failNextVertexArrayCreation = false;
        errors.push(this.OUT_OF_MEMORY);
        return null;
      }
      const vertexArray = Object.freeze({
        id: nextVertexArrayId++,
      });
      createdVertexArrays.push(vertexArray);
      return vertexArray;
    },
    bindBuffer() {},
    bindVertexArray() {},
    bufferData(target, data, usage, sourceOffset) {
      uploadAttempts++;
      uploadContracts.push({
        argumentCount: arguments.length,
        data,
        sourceOffset,
        target,
        usage,
      });
      if (failNextUpload) {
        failNextUpload = false;
        errors.push(this.OUT_OF_MEMORY);
      }
    },
    deleteBuffer(buffer) {
      deletedBuffers.push(buffer);
    },
    deleteVertexArray(vertexArray) {
      deletedVertexArrays.push(vertexArray);
    },
    enableVertexAttribArray(location) {
      attributeConfigurationCalls.push([
        'enable',
        location,
      ]);
    },
    getError() {
      return errors.shift() ?? this.NO_ERROR;
    },
    vertexAttribPointer(...args) {
      attributeConfigurationCalls.push(['pointer', ...args]);
      if (failNextVertexArrayConfiguration) {
        failNextVertexArrayConfiguration = false;
        throw new Error(
          'synthetic highlight vertex-array configuration failure'
        );
      }
    },
  };
  const renderer = Object.assign(
    Object.create(HighlightRenderer.prototype),
    {
      _highlightDataRef: null,
      _highlightDataVersion: 0,
      _highlightedIndicesCache: null,
      _pendingBufferDeletes: new Set(),
      _pendingProgramDeletes: new Set(),
      _pendingVertexArrayDeletes: new Set(),
      _totalHighlightedCount: 0,
      _viewBuffers: new Map(),
      attribLocations: {
        color: 1,
        position: 0,
      },
      gl,
    },
  );
  return {
    attributeConfigurationCalls,
    createdBuffers,
    createdVertexArrays,
    deletedBuffers,
    deletedVertexArrays,
    failNextUpload() {
      failNextUpload = true;
    },
    failNextBufferCreation() {
      failNextBufferCreation = true;
    },
    failNextVertexArrayConfiguration() {
      failNextVertexArrayConfiguration = true;
    },
    failNextVertexArrayCreation() {
      failNextVertexArrayCreation = true;
    },
    get uploadAttempts() {
      return uploadAttempts;
    },
    renderer,
    uploadContracts,
  };
}

function publishSingleHighlight(renderer, geometryGeneration) {
  const highlightData = Uint8Array.from([255, 0]);
  const positions = Float32Array.from([
    geometryGeneration,
    2,
    3,
    4,
    5,
    6,
  ]);
  const transparency = Float32Array.from([1, 1]);
  renderer.rebuildBuffer(
    highlightData,
    positions,
    null,
    'live',
    transparency,
    geometryGeneration,
    2,
    0,
  );
}

test('highlight upload OOM never certifies a failed new or replacement buffer', () => {
  const newFailure = makeHighlightUploadFailureFixture();
  newFailure.failNextUpload();
  assert.throws(
    () => publishSingleHighlight(newFailure.renderer, 1),
    /0x505/,
  );
  const rejectedRecord =
    newFailure.renderer._viewBuffers.get('live');
  assert.equal(rejectedRecord.buffer, null);
  assert.equal(rejectedRecord.vertexArray, null);
  assert.equal(rejectedRecord.published, false);
  assert.equal(rejectedRecord.pointCount, 0);
  assert.equal(newFailure.createdBuffers.length, 1);
  assert.deepEqual(
    newFailure.deletedBuffers,
    newFailure.createdBuffers,
    'a failed candidate allocation must retire before retry',
  );
  assert.deepEqual(
    newFailure.deletedVertexArrays,
    newFailure.createdVertexArrays,
    'a failed candidate VAO must retire with its buffer',
  );
  assert.equal(newFailure.renderer._pendingBufferDeletes.size, 0);
  assert.equal(
    newFailure.renderer._pendingVertexArrayDeletes.size,
    0,
  );

  publishSingleHighlight(newFailure.renderer, 1);
  const acceptedRecord =
    newFailure.renderer._viewBuffers.get('live');
  assert.equal(acceptedRecord.published, true);
  assert.equal(acceptedRecord.geometryGeneration, 1);
  assert.equal(acceptedRecord.pointCount, 1);
  assert.equal(newFailure.createdBuffers.length, 2);
  assert.equal(newFailure.createdVertexArrays.length, 2);
  assert.equal(
    acceptedRecord.vertexArray,
    newFailure.createdVertexArrays[1],
  );

  const replacementFailure = makeHighlightUploadFailureFixture();
  publishSingleHighlight(replacementFailure.renderer, 1);
  const retainedRecord =
    replacementFailure.renderer._viewBuffers.get('live');
  const retainedBuffer = retainedRecord.buffer;
  const retainedVertexArray = retainedRecord.vertexArray;
  const retainedGeneration = retainedRecord.geometryGeneration;
  const retainedHighlightGeneration =
    retainedRecord.highlightGeneration;
  replacementFailure.failNextUpload();
  assert.throws(
    () => publishSingleHighlight(replacementFailure.renderer, 2),
    /0x505/,
  );
  assert.equal(retainedRecord.buffer, retainedBuffer);
  assert.equal(retainedRecord.vertexArray, retainedVertexArray);
  assert.equal(retainedRecord.published, true);
  assert.equal(
    retainedRecord.geometryGeneration,
    retainedGeneration,
  );
  assert.equal(
    retainedRecord.highlightGeneration,
    retainedHighlightGeneration,
  );
  assert.equal(replacementFailure.deletedBuffers.length, 0);
  assert.equal(replacementFailure.deletedVertexArrays.length, 0);
  assert.equal(
    replacementFailure.renderer.needsRefresh(
      null,
      'live',
      2,
      2,
      0,
    ),
    true,
  );

  publishSingleHighlight(replacementFailure.renderer, 2);
  assert.equal(retainedRecord.buffer, retainedBuffer);
  assert.equal(retainedRecord.vertexArray, retainedVertexArray);
  assert.equal(retainedRecord.geometryGeneration, 2);
  assert.equal(retainedRecord.pointCount, 1);
  assert.equal(replacementFailure.createdBuffers.length, 1);
  assert.equal(replacementFailure.createdVertexArrays.length, 1);
});

test('highlight upload selects the preserving WebGL2 view overload and configures its VAO once', () => {
  const fixture = makeHighlightUploadFailureFixture();

  publishSingleHighlight(fixture.renderer, 1);
  const accepted = fixture.renderer._viewBuffers.get('live');
  const acceptedBuffer = accepted.buffer;
  const acceptedVertexArray = accepted.vertexArray;
  const initialConfiguration =
    fixture.attributeConfigurationCalls.slice();
  publishSingleHighlight(fixture.renderer, 2);

  assert.equal(accepted.buffer, acceptedBuffer);
  assert.equal(accepted.vertexArray, acceptedVertexArray);
  assert.equal(fixture.createdBuffers.length, 1);
  assert.equal(fixture.createdVertexArrays.length, 1);
  assert.deepEqual(
    fixture.attributeConfigurationCalls,
    initialConfiguration,
    'replacement uploads must reuse the immutable VAO layout',
  );
  assert.deepEqual(
    initialConfiguration.map(call => call[0]),
    ['enable', 'pointer', 'enable', 'pointer'],
  );
  assert.equal(fixture.uploadContracts.length, 2);
  for (const upload of fixture.uploadContracts) {
    assert.equal(upload.argumentCount, 4);
    assert.equal(upload.target, 0x8892);
    assert.equal(upload.usage, 0x88e8);
    assert.equal(upload.sourceOffset, 0);
    assert.ok(upload.data instanceof Uint8Array);
    assert.equal(upload.data.byteOffset, 0);
    assert.equal(upload.data.byteLength, upload.data.buffer.byteLength);
  }
});

test('hostile highlight VAO allocation or configuration retires the complete unpublished pair', () => {
  const bufferAllocationFailure =
    makeHighlightUploadFailureFixture();
  bufferAllocationFailure.failNextBufferCreation();
  assert.throws(
    () => publishSingleHighlight(
      bufferAllocationFailure.renderer,
      1
    ),
    /0x505/,
  );
  const bufferAllocationRecord =
    bufferAllocationFailure.renderer._viewBuffers.get('live');
  assert.equal(bufferAllocationRecord.buffer, null);
  assert.equal(bufferAllocationRecord.vertexArray, null);
  assert.deepEqual(bufferAllocationFailure.createdBuffers, []);
  assert.deepEqual(bufferAllocationFailure.deletedBuffers, []);
  assert.doesNotThrow(
    () => publishSingleHighlight(
      bufferAllocationFailure.renderer,
      1
    ),
    'allocation failure must not poison the retry preflight',
  );

  const allocationFailure = makeHighlightUploadFailureFixture();
  allocationFailure.failNextVertexArrayCreation();
  assert.throws(
    () => publishSingleHighlight(allocationFailure.renderer, 1),
    /0x505/,
  );
  const allocationRecord =
    allocationFailure.renderer._viewBuffers.get('live');
  assert.equal(allocationRecord.buffer, null);
  assert.equal(allocationRecord.vertexArray, null);
  assert.deepEqual(
    allocationFailure.deletedBuffers,
    allocationFailure.createdBuffers,
  );
  assert.deepEqual(allocationFailure.deletedVertexArrays, []);
  assert.doesNotThrow(
    () => publishSingleHighlight(allocationFailure.renderer, 1),
    'VAO allocation failure must not poison the retry preflight',
  );

  const configurationFailure = makeHighlightUploadFailureFixture();
  configurationFailure.failNextVertexArrayConfiguration();
  assert.throws(
    () => publishSingleHighlight(configurationFailure.renderer, 1),
    /vertex-array configuration failure/,
  );
  const configurationRecord =
    configurationFailure.renderer._viewBuffers.get('live');
  assert.equal(configurationRecord.buffer, null);
  assert.equal(configurationRecord.vertexArray, null);
  assert.deepEqual(
    configurationFailure.deletedBuffers,
    configurationFailure.createdBuffers,
  );
  assert.deepEqual(
    configurationFailure.deletedVertexArrays,
    configurationFailure.createdVertexArrays,
  );
  assert.equal(
    configurationFailure.renderer._pendingBufferDeletes.size,
    0,
  );
  assert.equal(
    configurationFailure.renderer._pendingVertexArrayDeletes.size,
    0,
  );
});

test('highlight upload OOM is fenced per view until one exact semantic generation changes', () => {
  const fixture = makeHighlightUploadFailureFixture();
  const geometryGenerations = new Map([
    ['live', 1],
    ['snapshot-1', 1],
  ]);
  const highlightData = Uint8Array.from([255, 0]);
  const positionsByView = new Map([
    ['live', Float32Array.from([1, 2, 3, 4, 5, 6])],
    ['snapshot-1', Float32Array.from([7, 8, 9, 10, 11, 12])],
  ]);
  const transparencyByView = new Map([
    ['live', Float32Array.from([1, 1])],
    ['snapshot-1', Float32Array.from([1, 1])],
  ]);
  const tools = Object.assign(
    Object.create(HighlightTools.prototype),
    {
      _disposed: false,
      _transparencyGenerations: new Map([
        ['live', 0],
        ['snapshot-1', 0],
      ]),
      highlightArray: highlightData,
      highlightRenderer: fixture.renderer,
      hpRenderer: {
        getCurrentLodMembership() {
          return null;
        },
        getViewGeometryGeneration(viewId) {
          return geometryGenerations.get(viewId);
        },
      },
    },
  );
  const sync = viewId => tools.syncHighlightBufferForLod(
    positionsByView.get(viewId),
    viewId,
    transparencyByView.get(viewId),
    2,
  );

  sync('live');
  sync('snapshot-1');
  assert.equal(fixture.uploadAttempts, 2);
  const retainedLiveRecord =
    fixture.renderer._viewBuffers.get('live');
  const retainedLiveBuffer = retainedLiveRecord.buffer;

  geometryGenerations.set('live', 2);
  geometryGenerations.set('snapshot-1', 2);
  fixture.failNextUpload();
  assert.throws(() => sync('live'), /0x505/);
  assert.equal(fixture.uploadAttempts, 3);
  assert.equal(retainedLiveRecord.buffer, retainedLiveBuffer);
  assert.equal(retainedLiveRecord.geometryGeneration, 1);
  assert.equal(
    retainedLiveRecord.pointCount,
    0,
    'a failed newer publication must revoke the stale accepted draw count',
  );
  assert.equal(
    fixture.renderer.getTotalPointCount(),
    1,
    'the other pane remains published while the failed pane is suppressed',
  );
  assert.equal(
    fixture.renderer.needsRefresh(null, 'live', 2, 2, 0),
    false,
    'the exact failed generation must not allocate again on the next RAF',
  );

  assert.doesNotThrow(() => sync('live'));
  assert.equal(fixture.uploadAttempts, 3);
  assert.equal(retainedLiveRecord.geometryGeneration, 1);
  assert.equal(retainedLiveRecord.pointCount, 0);

  // One pane's allocation failure must not fence or abort later panes.
  assert.doesNotThrow(() => sync('snapshot-1'));
  assert.equal(fixture.uploadAttempts, 4);
  assert.equal(
    fixture.renderer._viewBuffers.get('snapshot-1').geometryGeneration,
    2,
  );

  // A meaningful geometry publication re-enables exactly one attempt.
  geometryGenerations.set('live', 3);
  assert.doesNotThrow(() => sync('live'));
  assert.equal(fixture.uploadAttempts, 5);
  assert.equal(retainedLiveRecord.geometryGeneration, 3);
  assert.equal(retainedLiveRecord.failedPublication, null);
  assert.equal(retainedLiveRecord.buffer, retainedLiveBuffer);
  assert.equal(retainedLiveRecord.pointCount, 1);
});

test('CPU highlight source allocation failure preserves the accepted generation without per-frame retries', {
  concurrency: false,
}, () => {
  const fixture = makeHighlightUploadFailureFixture();
  const geometryGenerations = new Map([['live', 1]]);
  const positions = Float32Array.from([1, 2, 3, 4, 5, 6]);
  const transparency = Float32Array.from([1, 1]);
  const tools = Object.assign(
    Object.create(HighlightTools.prototype),
    {
      _disposed: false,
      _transparencyGenerations: new Map([['live', 0]]),
      highlightArray: Uint8Array.from([255, 0]),
      highlightRenderer: fixture.renderer,
      hpRenderer: {
        getCurrentLodMembership() {
          return null;
        },
        getViewGeometryGeneration(viewId) {
          return geometryGenerations.get(viewId);
        },
      },
    },
  );
  const sync = () => tools.syncHighlightBufferForLod(
    positions,
    'live',
    transparency,
    2,
  );

  sync();
  const acceptedRecord = fixture.renderer._viewBuffers.get('live');
  const acceptedBuffer = acceptedRecord.buffer;
  assert.equal(fixture.uploadAttempts, 1);

  geometryGenerations.set('live', 2);
  const NativeArrayBuffer = globalThis.ArrayBuffer;
  let sourceAllocationAttempts = 0;
  globalThis.ArrayBuffer = class HostileHighlightArrayBuffer {
    constructor(byteLength) {
      sourceAllocationAttempts++;
      if (byteLength === 16) {
        throw new RangeError('synthetic highlight source allocation failure');
      }
      return new NativeArrayBuffer(byteLength);
    }
  };
  try {
    assert.throws(sync, /synthetic highlight source allocation failure/);
  } finally {
    globalThis.ArrayBuffer = NativeArrayBuffer;
  }

  assert.equal(sourceAllocationAttempts, 1);
  assert.equal(fixture.uploadAttempts, 1);
  assert.equal(acceptedRecord.buffer, acceptedBuffer);
  assert.equal(acceptedRecord.geometryGeneration, 1);
  assert.equal(
    fixture.renderer.needsRefresh(null, 'live', 2, 2, 0),
    false,
  );

  assert.doesNotThrow(sync);
  assert.equal(fixture.uploadAttempts, 1);
  assert.equal(acceptedRecord.geometryGeneration, 1);

  geometryGenerations.set('live', 3);
  assert.doesNotThrow(sync);
  assert.equal(fixture.uploadAttempts, 2);
  assert.equal(acceptedRecord.geometryGeneration, 3);
  assert.equal(acceptedRecord.failedPublication, null);
});
