import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  HighPerfRenderer,
  SpatialIndex,
} from '../assets/js/rendering/high-perf-renderer.js';

const UINT32_SENTINEL = 0xffffffff;
const UNIFORM_NAMES = Object.freeze([
  'u_mvpMatrix',
  'u_viewMatrix',
  'u_modelMatrix',
  'u_projectionMatrix',
  'u_pointSize',
  'u_sizeAttenuation',
  'u_viewportHeight',
  'u_fov',
  'u_lightingStrength',
  'u_fogDensity',
  'u_fogNear',
  'u_fogFar',
  'u_fogColor',
  'u_lightDir',
]);

function collectLeaves(root) {
  const leaves = [];
  const visit = (node) => {
    if (!node) return;
    if (node.indices instanceof Uint32Array) {
      leaves.push(node);
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return leaves;
}

function collectReachableTypedViews(root) {
  const seen = new Set();
  const views = [];
  const stack = [root];

  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || typeof value !== 'object' || seen.has(value)) {
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
        stack.push(descriptor.value);
      }
    }
  }

  return views;
}

function collectReachableBuffers(root) {
  return new Set(
    collectReachableTypedViews(root).map(view => view.buffer),
  );
}

function makeNestedPrefixSpatialIndex() {
  const pointCount = 16;
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);

  // IDs are deliberately interleaved between the four quadrants. Tree leaves
  // therefore retain ascending source-ID order while the hierarchical LOD
  // prefix crosses leaf boundaries in a different order.
  for (let pointId = 0; pointId < pointCount; pointId++) {
    const quadrant = pointId & 3;
    const withinQuadrant = pointId >>> 2;
    const positionOffset = pointId * 3;
    positions[positionOffset] =
      (quadrant & 1 ? 10 : -10) + withinQuadrant * 0.01;
    positions[positionOffset + 1] =
      (quadrant & 2 ? 10 : -10) + withinQuadrant * 0.02;
    positions[positionOffset + 2] = 0;

    const colorOffset = pointId * 4;
    colors[colorOffset] = pointId;
    colors[colorOffset + 1] = pointId * 3;
    colors[colorOffset + 2] = pointId * 7;
    colors[colorOffset + 3] = 255;
  }

  const spatialIndex = new SpatialIndex(
    positions,
    colors,
    2,
    4,
    4,
    {
      buildLOD: false,
      buildLodNodeMappings: false,
      computeNodeStats: false,
    },
  );

  const hierarchicalOrder = Uint32Array.from([
    7, 0, 13, 2,
    9, 4, 15, 6,
    1, 10, 5, 12,
    3, 14, 8, 11,
  ]);
  const reducedCounts = [2, 5, 9, 13];
  spatialIndex._hierarchicalOrder = hierarchicalOrder;
  spatialIndex.lodLevels = reducedCounts.map((pointCountAtLevel, depth) => ({
    depth,
    pointCount: pointCountAtLevel,
    indices: hierarchicalOrder.subarray(0, pointCountAtLevel),
    sizes: null,
    isFullDetail: false,
    sizeMultiplier: 1,
  }));
  spatialIndex.lodLevels.push({
    depth: reducedCounts.length,
    pointCount,
    positions,
    colors,
    sizes: null,
    isFullDetail: true,
  });
  spatialIndex._buildLOD = true;

  const leaves = collectLeaves(spatialIndex.root);
  assert.equal(leaves.length, 4);
  return {
    colors,
    hierarchicalOrder,
    leaves,
    positions,
    reducedCounts,
    spatialIndex,
  };
}

function makeLargeSpatialIndex(pointCount) {
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);
  for (let pointId = 0; pointId < pointCount; pointId++) {
    const offset = pointId * 3;
    positions[offset] = ((pointId * 37) % 1009) - 504;
    positions[offset + 1] = ((pointId * 101) % 997) - 498;
    positions[offset + 2] = ((pointId * 211) % 991) - 495;
    colors[pointId * 4 + 3] = 255;
  }

  return new SpatialIndex(
    positions,
    colors,
    3,
    64,
    8,
    {
      buildLOD: true,
      buildLodNodeMappings: false,
      computeNodeStats: false,
    },
  );
}

function newReachableBuffers(spatialIndex, buffersBefore) {
  return Array.from(collectReachableBuffers(spatialIndex))
    .filter(buffer => !buffersBefore.has(buffer));
}

function buildLodNodeMappingsWithoutNotificationUi(spatialIndex) {
  if (spatialIndex._lodNodeMappingsBuilt) return;
  spatialIndex._buildLODNodeMappings();
  spatialIndex._lodNodeMappingsBuilt = true;
}

function legacyCompactIndices(level, visibleLeaves, pointCount) {
  const compactRankByOriginalId = new Uint32Array(pointCount);
  compactRankByOriginalId.fill(UINT32_SENTINEL);
  for (let compactIndex = 0; compactIndex < level.indices.length; compactIndex++) {
    compactRankByOriginalId[level.indices[compactIndex]] = compactIndex;
  }

  const result = [];
  for (const leaf of visibleLeaves) {
    for (const originalId of leaf.indices) {
      const compactIndex = compactRankByOriginalId[originalId];
      if (compactIndex !== UINT32_SENTINEL) result.push(compactIndex);
    }
  }
  return Uint32Array.from(result);
}

function makeRenderHarness() {
  const uniforms = Object.fromEntries(
    UNIFORM_NAMES.map(name => [name, null]),
  );
  const drawCounts = [];
  const gl = {
    POINTS: 0,
    UNSIGNED_INT: 0x1405,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE_2D: 0x0de1,
    useProgram() {},
    uniformMatrix4fv() {},
    uniform1f() {},
    uniform1i() {},
    uniform3fv() {},
    bindVertexArray() {},
    bindBuffer() {},
    activeTexture() {},
    bindTexture() {},
    drawElements(_mode, count) {
      drawCounts.push(count);
    },
  };

  const uploads = [];
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      gl,
      activeProgram: {},
      activeQuality: 'full',
      uniformLocations: new Map([['full', uniforms]]),
      stats: {},
      _dummyLodIndexTexture: {},
      _lodResourceOwnersByDimension: new Map(),
      _validatedLodNodeMappings: new WeakMap(),
      _validatedSpatialIndices: new WeakSet(),
      _checkFrustumCacheValid() {
        return false;
      },
      _bindAlphaTexture() {},
      _updateStats() {},
      _uploadToViewIndexBuffer(viewState, indices) {
        const accepted = Uint32Array.from(indices);
        uploads.push(accepted);
        viewState.indexBufferSize = accepted.length;
        viewState.indexBufferByteLength = accepted.byteLength;
      },
    },
  );

  return { drawCounts, renderer, uploads };
}

function makeViewState(visibleLeaves, spatialIndex = null) {
  return {
    cachedVisibleNodes: visibleLeaves,
    cachedVisibleSpatialOwner: spatialIndex,
    cachedVisibleSpatialRoot: spatialIndex?.root ?? null,
    cachedLodLevel: -1,
    cachedCulledCount: 0,
    cachedLodVisibleIndices: null,
    visibleLodIndicesBuffer: null,
    visibleLodIndicesCapacity: 0,
    lastVisibleCount: undefined,
    indexBuffer: {},
    indexBufferSize: 0,
    indexBufferByteLength: 0,
  };
}

function makeSnapshotViewState(spatialIndex, visibleLeaves) {
  return {
    ...makeViewState(visibleLeaves),
    cachedVisibleSpatialOwner: spatialIndex,
    cachedVisibleSpatialRoot: spatialIndex.root,
    cachedLodMappingGeneration: null,
    cachedLodDimension: -1,
    cachedLodIsCulled: false,
    usePreCachedIndexBuffer: false,
    preCachedIndexBuffer: null,
    preCachedGenerationToken: null,
    preCachedSpatialOwner: null,
  };
}

function makeRenderParams(viewId) {
  return {
    mvpMatrix: new Float32Array(16),
    viewMatrix: new Float32Array(16),
    modelMatrix: new Float32Array(16),
    projectionMatrix: new Float32Array(16),
    pointSize: 1,
    sizeAttenuation: 1,
    viewportHeight: 512,
    fov: 1,
    lightingStrength: 0,
    fogDensity: 0,
    fogColor: new Float32Array(3),
    lightDir: new Float32Array(3),
    viewId,
    dimensionLevel: 2,
  };
}

function snapshotOwnState(objects) {
  return objects.map(object => [
    object,
    new Map(
      Reflect.ownKeys(object).map(key => [
        key,
        Object.getOwnPropertyDescriptor(object, key),
      ]),
    ),
  ]);
}

function ownStateMatches(snapshot) {
  for (const [object, expectedDescriptors] of snapshot) {
    const actualKeys = Reflect.ownKeys(object);
    if (actualKeys.length !== expectedDescriptors.size) return false;
    for (const key of actualKeys) {
      const expected = expectedDescriptors.get(key);
      const actual = Object.getOwnPropertyDescriptor(object, key);
      if (!expected || !actual) return false;
      for (const descriptorKey of [
        'value',
        'get',
        'set',
        'writable',
        'enumerable',
        'configurable',
      ]) {
        if (actual[descriptorKey] !== expected[descriptorKey]) return false;
      }
    }
  }
  return true;
}

test('LOD node mappings retain one maximum-prefix backing store instead of per-level leaf arrays', () => {
  const {
    leaves,
    reducedCounts,
    spatialIndex,
  } = makeNestedPrefixSpatialIndex();
  const buffersBefore = collectReachableBuffers(spatialIndex);

  buildLodNodeMappingsWithoutNotificationUi(spatialIndex);

  const addedBuffers = newReachableBuffers(spatialIndex, buffersBefore);
  const maximumReducedCount = Math.max(...reducedCounts);
  assert.equal(
    addedBuffers.length,
    1,
    'all reduced levels must share one newly retained mapping backing store',
  );
  assert.equal(
    addedBuffers[0].byteLength,
    maximumReducedCount * Uint32Array.BYTES_PER_ELEMENT,
    'mapping storage must be bounded by the largest reduced prefix',
  );

  const addedBuffer = addedBuffers[0];
  const addedViews = collectReachableTypedViews(spatialIndex)
    .filter(view => view.buffer === addedBuffer);
  assert.ok(
    addedViews.some(view => view.byteLength === addedBuffer.byteLength),
    'the exact maximum-prefix owner must remain reachable',
  );

  for (const leaf of leaves) {
    assert.equal(
      Object.hasOwn(leaf, 'lodIndices'),
      false,
      'leaves must not retain one typed mapping array per LOD level',
    );
    const leafAddedBuffers = Array.from(collectReachableBuffers(leaf))
      .filter(buffer => !buffersBefore.has(buffer));
    assert.deepEqual(
      leafAddedBuffers,
      [],
      'leaf mapping metadata must be scalar offsets/counts into the shared owner',
    );
  }
});

test('compact LOD node mapping preserves every legacy compact-index order for every level and visible-leaf subset', () => {
  const {
    leaves,
    spatialIndex,
  } = makeNestedPrefixSpatialIndex();
  buildLodNodeMappingsWithoutNotificationUi(spatialIndex);

  const lodBuffers = spatialIndex.lodLevels.map(level => ({
    ...level,
    vao: {},
  }));
  const {
    drawCounts,
    renderer,
    uploads,
  } = makeRenderHarness();

  for (let lodLevel = 0; lodLevel < spatialIndex.lodLevels.length - 1; lodLevel++) {
    const level = spatialIndex.lodLevels[lodLevel];
    for (let mask = 0; mask < (1 << leaves.length); mask++) {
      const visibleLeaves = leaves.filter(
        (_leaf, leafIndex) => (mask & (1 << leafIndex)) !== 0,
      );
      const expected = legacyCompactIndices(
        level,
        visibleLeaves,
        spatialIndex.pointCount,
      );
      const viewState =
        makeViewState(visibleLeaves, spatialIndex);
      const uploadsBefore = uploads.length;
      const drawsBefore = drawCounts.length;

      renderer._renderLODWithFrustumCulling(
        lodLevel,
        makeRenderParams(`lod-${lodLevel}-mask-${mask}`),
        [],
        viewState,
        spatialIndex,
        lodBuffers,
      );

      assert.deepEqual(
        viewState.cachedLodVisibleIndices,
        expected,
        `LOD ${lodLevel}, visible-leaf mask ${mask}`,
      );
      assert.equal(viewState.cachedCulledCount, expected.length);
      if (visibleLeaves.length === 0) {
        assert.equal(uploads.length, uploadsBefore);
      } else {
        assert.deepEqual(uploads.at(-1), expected);
      }
      assert.equal(
        drawCounts.length - drawsBefore,
        expected.length > 0 ? 1 : 0,
      );
    }
  }
});

test('custom-position snapshots translate the exact live compact order without a visible-ID Set or full-prefix scratch', () => {
  const {
    hierarchicalOrder,
    leaves,
    spatialIndex,
  } = makeNestedPrefixSpatialIndex();
  buildLodNodeMappingsWithoutNotificationUi(spatialIndex);

  const lodBuffers = spatialIndex.lodLevels.map(level => ({
    ...level,
    vao: {},
  }));
  const {
    drawCounts,
    renderer,
    uploads,
  } = makeRenderHarness();
  const renderSource =
    HighPerfRenderer.prototype
      ._renderSnapshotLODWithFrustumCulling
      .toString();
  assert.doesNotMatch(renderSource, /new Set|cachedVisibleOriginalSet/);
  assert.match(renderSource, /countLodMappedIndices/);
  assert.match(renderSource, /writeLodMappedIndices/);

  for (
    let lodLevel = 0;
    lodLevel < spatialIndex.lodLevels.length - 1;
    lodLevel++
  ) {
    const level = spatialIndex.lodLevels[lodLevel];
    for (let mask = 0; mask < (1 << leaves.length); mask++) {
      const visibleLeaves = leaves.filter(
        (_leaf, leafIndex) =>
          (mask & (1 << leafIndex)) !== 0,
      );
      const compactOrder = legacyCompactIndices(
        level,
        visibleLeaves,
        spatialIndex.pointCount,
      );
      const expectedOriginalOrder = Uint32Array.from(
        compactOrder,
        compactRank => hierarchicalOrder[compactRank],
      );
      const viewState =
        makeSnapshotViewState(spatialIndex, visibleLeaves);
      const uploadsBefore = uploads.length;
      const drawsBefore = drawCounts.length;

      renderer._renderSnapshotLODWithFrustumCulling(
        { vao: {}, positions: spatialIndex.positions },
        lodLevel,
        makeRenderParams(
          `custom-snapshot-${lodLevel}-${mask}`,
        ),
        [],
        viewState,
        false,
        spatialIndex,
        lodBuffers,
      );

      assert.deepEqual(
        viewState.cachedLodVisibleIndices,
        expectedOriginalOrder,
        `snapshot LOD ${lodLevel}, visible-leaf mask ${mask}`,
      );
      assert.equal(
        Object.hasOwn(viewState, 'cachedVisibleOriginalSet'),
        false,
      );
      assert.ok(
        viewState.visibleLodIndicesCapacity <=
          Math.ceil(expectedOriginalOrder.length * 1.5),
        'scratch capacity must scale with admitted points, not the full prefix',
      );
      if (visibleLeaves.length === 0) {
        assert.equal(uploads.length, uploadsBefore);
      } else {
        assert.deepEqual(
          uploads.at(-1),
          expectedOriginalOrder,
        );
      }
      assert.equal(
        drawCounts.length - drawsBefore,
        expectedOriginalOrder.length > 0 ? 1 : 0,
      );
    }
  }
});

test('snapshot LOD changes reuse unchanged-frustum leaves and retain exact per-view isolation', () => {
  const {
    hierarchicalOrder,
    leaves,
    spatialIndex,
  } = makeNestedPrefixSpatialIndex();
  buildLodNodeMappingsWithoutNotificationUi(spatialIndex);
  const lodBuffers = spatialIndex.lodLevels.map(level => ({
    ...level,
    vao: {},
  }));
  const { renderer, uploads } = makeRenderHarness();
  const viewA = makeSnapshotViewState(
    spatialIndex,
    [leaves[0], leaves[2]],
  );
  const viewB = makeSnapshotViewState(
    spatialIndex,
    [leaves[1], leaves[3]],
  );
  const formerlyWideCapacity = 400_000;
  viewA.visibleLodIndicesBuffer =
    new Uint32Array(formerlyWideCapacity);
  viewA.visibleLodIndicesCapacity = formerlyWideCapacity;
  viewB.visibleLodIndicesBuffer =
    new Uint32Array(formerlyWideCapacity);
  viewB.visibleLodIndicesCapacity = formerlyWideCapacity;
  const expectedOriginalOrder = (lodLevel, visibleLeaves) => {
    const compact = legacyCompactIndices(
      spatialIndex.lodLevels[lodLevel],
      visibleLeaves,
      spatialIndex.pointCount,
    );
    return Uint32Array.from(
      compact,
      rank => hierarchicalOrder[rank],
    );
  };

  renderer._renderSnapshotLODWithFrustumCulling(
    { vao: {} },
    3,
    makeRenderParams('snapshot-a'),
    [],
    viewA,
    false,
    spatialIndex,
    lodBuffers,
  );
  const viewABuffer = viewA.visibleLodIndicesBuffer;
  assert.equal(
    viewABuffer.length,
    Math.ceil(viewA.cachedCulledCount * 1.5),
    'a formerly wide pane must shed materially oversized scratch',
  );
  assert.equal(
    viewB.visibleLodIndicesBuffer.length,
    formerlyWideCapacity,
    'shrinking one pane must not mutate a sibling view owner',
  );
  const firstA = Uint32Array.from(
    viewA.cachedLodVisibleIndices,
  );

  renderer._renderSnapshotLODWithFrustumCulling(
    { vao: {} },
    2,
    makeRenderParams('snapshot-b'),
    [],
    viewB,
    false,
    spatialIndex,
    lodBuffers,
  );
  assert.notStrictEqual(
    viewA.visibleLodIndicesBuffer,
    viewB.visibleLodIndicesBuffer,
  );
  assert.equal(
    viewB.visibleLodIndicesBuffer.length,
    Math.ceil(viewB.cachedCulledCount * 1.5),
    'each pane must independently converge from its prior wide capacity',
  );
  assert.deepEqual(
    viewA.cachedLodVisibleIndices,
    firstA,
    'rendering another view must not overwrite the first view scratch',
  );

  renderer._collectVisibleNodes = () => {
    throw new Error(
      'unchanged frustum must not traverse the tree on LOD change',
    );
  };
  renderer._renderSnapshotLODWithFrustumCulling(
    { vao: {} },
    1,
    makeRenderParams('snapshot-a'),
    [],
    viewA,
    false,
    spatialIndex,
    lodBuffers,
  );

  assert.strictEqual(
    viewA.visibleLodIndicesBuffer,
    viewABuffer,
    'sufficient per-view scratch must survive an LOD transition',
  );
  assert.deepEqual(
    viewA.cachedLodVisibleIndices,
    expectedOriginalOrder(1, [leaves[0], leaves[2]]),
  );
  assert.deepEqual(
    viewB.cachedLodVisibleIndices,
    expectedOriginalOrder(2, [leaves[1], leaves[3]]),
  );
  assert.deepEqual(
    uploads.at(-1),
    viewA.cachedLodVisibleIndices,
  );
});

test('unchanged-frustum full/reduced transitions rebuild mode data once and then reuse exact leaves', () => {
  const {
    leaves,
    spatialIndex,
  } = makeNestedPrefixSpatialIndex();
  buildLodNodeMappingsWithoutNotificationUi(spatialIndex);
  const lodBuffers = spatialIndex.lodLevels.map(level => ({
    ...level,
    vao: {},
  }));
  const { renderer, uploads } = makeRenderHarness();
  renderer.pointCount = spatialIndex.pointCount;
  renderer.vao = {};
  const originalCollect =
    renderer._collectVisibleNodes.bind(renderer);

  for (const mode of ['live', 'snapshot']) {
    const viewState =
      makeSnapshotViewState(spatialIndex, leaves);
    if (mode === 'live') {
      renderer._renderLODWithFrustumCulling(
        2,
        makeRenderParams('live-mode-transition'),
        [],
        viewState,
        spatialIndex,
        lodBuffers,
      );
    } else {
      renderer._renderSnapshotLODWithFrustumCulling(
        { vao: {} },
        2,
        makeRenderParams('snapshot-mode-transition'),
        [],
        viewState,
        false,
        spatialIndex,
        lodBuffers,
      );
    }

    let transitionTraversals = 0;
    renderer._collectVisibleNodes = (...args) => {
      transitionTraversals++;
      return originalCollect(...args);
    };
    if (mode === 'live') {
      renderer._renderWithFrustumCulling(
        makeRenderParams('live-mode-transition'),
        [],
        viewState,
        spatialIndex,
      );
    } else {
      renderer._renderSnapshotWithFrustumCulling(
        { pointCount: spatialIndex.pointCount, vao: {} },
        makeRenderParams('snapshot-mode-transition'),
        [],
        viewState,
        1,
        false,
        spatialIndex,
      );
    }
    assert.equal(transitionTraversals, 1);
    assert.equal(viewState.cachedLodLevel, -1);
    assert.equal(viewState.cachedLodIsCulled, false);
    assert.equal(
      uploads.at(-1).length,
      spatialIndex.pointCount,
    );

    renderer._collectVisibleNodes = () => {
      throw new Error(
        'full-to-reduced mode transition must reuse unchanged-frustum leaves',
      );
    };
    if (mode === 'live') {
      renderer._renderLODWithFrustumCulling(
        1,
        makeRenderParams('live-mode-transition'),
        [],
        viewState,
        spatialIndex,
        lodBuffers,
      );
    } else {
      renderer._renderSnapshotLODWithFrustumCulling(
        { vao: {} },
        1,
        makeRenderParams('snapshot-mode-transition'),
        [],
        viewState,
        false,
        spatialIndex,
        lodBuffers,
      );
    }
    assert.equal(viewState.cachedLodLevel, 1);
    assert.equal(viewState.cachedLodIsCulled, true);
    renderer._collectVisibleNodes = originalCollect;
  }
});

test('snapshot empty visibility stays upload-free and mapping generations force exact retry', () => {
  const {
    leaves,
    spatialIndex,
  } = makeNestedPrefixSpatialIndex();
  buildLodNodeMappingsWithoutNotificationUi(spatialIndex);
  const lodBuffers = spatialIndex.lodLevels.map(level => ({
    ...level,
    vao: {},
  }));
  const harness = makeRenderHarness();
  const {
    drawCounts,
    renderer,
    uploads,
  } = harness;

  let countCalls = 0;
  let writeCalls = 0;
  const originalCount =
    spatialIndex.countLodMappedIndices.bind(spatialIndex);
  const originalWrite =
    spatialIndex.writeLodMappedIndices.bind(spatialIndex);
  spatialIndex.countLodMappedIndices = (...args) => {
    countCalls++;
    return originalCount(...args);
  };
  spatialIndex.writeLodMappedIndices = (...args) => {
    writeCalls++;
    return originalWrite(...args);
  };

  const emptyView =
    makeSnapshotViewState(spatialIndex, []);
  emptyView.visibleLodIndicesBuffer =
    new Uint32Array(400_000);
  emptyView.visibleLodIndicesCapacity = 400_000;
  renderer._renderSnapshotLODWithFrustumCulling(
    { vao: {} },
    1,
    makeRenderParams('snapshot-empty'),
    [],
    emptyView,
    false,
    spatialIndex,
    lodBuffers,
  );
  renderer._renderSnapshotLODWithFrustumCulling(
    { vao: {} },
    1,
    makeRenderParams('snapshot-empty'),
    [],
    emptyView,
    false,
    spatialIndex,
    lodBuffers,
  );
  assert.equal(countCalls, 0);
  assert.equal(writeCalls, 0);
  assert.equal(uploads.length, 0);
  assert.equal(drawCounts.length, 0);
  assert.deepEqual(
    emptyView.cachedLodVisibleIndices,
    new Uint32Array(),
  );
  assert.equal(
    emptyView.visibleLodIndicesCapacity,
    0,
    'a fully empty pane must release a material LOD scratch high-water mark',
  );

  const emptyLiveView = makeViewState([], spatialIndex);
  emptyLiveView.visibleLodIndicesBuffer =
    new Uint32Array(400_000);
  emptyLiveView.visibleLodIndicesCapacity = 400_000;
  renderer._renderLODWithFrustumCulling(
    1,
    makeRenderParams('live-empty'),
    [],
    emptyLiveView,
    spatialIndex,
    lodBuffers,
  );
  assert.equal(
    emptyLiveView.visibleLodIndicesCapacity,
    0,
    'live empty visibility must use the same retained-memory policy',
  );

  const retryView = makeSnapshotViewState(
    spatialIndex,
    leaves,
  );
  renderer._renderSnapshotLODWithFrustumCulling(
    { vao: {} },
    2,
    makeRenderParams('snapshot-retry'),
    [],
    retryView,
    false,
    spatialIndex,
    lodBuffers,
  );
  const acceptedGeneration =
    retryView.cachedLodMappingGeneration;
  const acceptedDraws = drawCounts.length;

  // Rebuilding the exact same tree publishes fresh leaf metadata and a fresh
  // token. The unchanged camera/LOD must still rebuild its snapshot EBO.
  spatialIndex._buildLODNodeMappings();
  const replacementGeneration =
    spatialIndex._lodNodeMapping.generationToken;
  assert.notStrictEqual(
    replacementGeneration,
    acceptedGeneration,
  );

  let rejectNextUpload = true;
  const acceptedUpload =
    renderer._uploadToViewIndexBuffer;
  renderer._uploadToViewIndexBuffer = (viewState, indices) => {
    if (rejectNextUpload) {
      rejectNextUpload = false;
      throw new Error('synthetic snapshot EBO upload failure');
    }
    acceptedUpload.call(renderer, viewState, indices);
  };
  assert.throws(
    () => renderer._renderSnapshotLODWithFrustumCulling(
      { vao: {} },
      2,
      makeRenderParams('snapshot-retry'),
      [],
      retryView,
      false,
      spatialIndex,
      lodBuffers,
    ),
    /synthetic snapshot EBO upload failure/,
  );
  assert.equal(
    drawCounts.length,
    acceptedDraws,
    'failed replacement must not draw the stale accepted EBO',
  );
  assert.equal(retryView.cachedLodLevel, -1);
  assert.equal(retryView.cachedVisibleNodes, null);
  assert.equal(retryView.cachedLodMappingGeneration, null);

  renderer._renderSnapshotLODWithFrustumCulling(
    { vao: {} },
    2,
    makeRenderParams('snapshot-retry'),
    [],
    retryView,
    false,
    spatialIndex,
    lodBuffers,
  );
  assert.equal(
    retryView.cachedLodMappingGeneration,
    replacementGeneration,
  );
  assert.equal(drawCounts.length, acceptedDraws + 1);
});

test('large narrow-frustum snapshot scratch is bounded by mapped visibility, not the maximum LOD prefix', () => {
  const spatialIndex = makeLargeSpatialIndex(10_001);
  buildLodNodeMappingsWithoutNotificationUi(spatialIndex);
  const leaves = collectLeaves(spatialIndex.root);
  const visibleLeaves = [leaves[0]];
  const lodLevel = spatialIndex.lodLevels.length - 2;
  const visibleCount = spatialIndex.countLodMappedIndices(
    visibleLeaves,
    lodLevel,
  );
  const fullPrefixCount =
    spatialIndex.lodLevels[lodLevel].pointCount;
  const lodBuffers = spatialIndex.lodLevels.map(level => ({
    ...level,
    vao: {},
  }));
  const { renderer } = makeRenderHarness();
  const viewState = makeSnapshotViewState(
    spatialIndex,
    visibleLeaves,
  );

  renderer._renderSnapshotLODWithFrustumCulling(
    { vao: {} },
    lodLevel,
    makeRenderParams('snapshot-large-narrow'),
    [],
    viewState,
    false,
    spatialIndex,
    lodBuffers,
  );

  assert.equal(
    viewState.cachedCulledCount,
    visibleCount,
  );
  assert.equal(
    viewState.visibleLodIndicesCapacity,
    Math.ceil(visibleCount * 1.5),
  );
  assert.ok(
    viewState.visibleLodIndicesCapacity <
      fullPrefixCount / 20,
    `expected narrow-frustum capacity ${viewState.visibleLodIndicesCapacity} to stay far below prefix ${fullPrefixCount}`,
  );

  const liveViewState =
    makeViewState(visibleLeaves, spatialIndex);
  liveViewState.visibleLodIndicesBuffer =
    new Uint32Array(400_000);
  liveViewState.visibleLodIndicesCapacity = 400_000;
  renderer._renderLODWithFrustumCulling(
    lodLevel,
    makeRenderParams('live-large-narrow'),
    [],
    liveViewState,
    spatialIndex,
    lodBuffers,
  );
  assert.equal(
    liveViewState.visibleLodIndicesCapacity,
    Math.ceil(visibleCount * 1.5),
    'live LOD/frustum must share the snapshot shrink policy',
  );

  const retained = liveViewState.visibleLodIndicesBuffer;
  renderer._ensureVisibleLodIndexScratch(
    liveViewState,
    Math.max(0, visibleCount - 1),
  );
  assert.strictEqual(
    liveViewState.visibleLodIndicesBuffer,
    retained,
    'ordinary narrow-frustum variation must stay inside shrink hysteresis',
  );
});

test('LOD node mapping publication is atomic and a failed build retries from the untouched tree', () => {
  const {
    leaves,
    spatialIndex,
  } = makeNestedPrefixSpatialIndex();
  const faultLeaf = leaves.at(-1);
  const originalIndices = faultLeaf.indices;
  let shouldThrow = true;
  Object.defineProperty(faultLeaf, 'indices', {
    configurable: true,
    enumerable: true,
    get() {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('synthetic leaf mapping read failure');
      }
      return originalIndices;
    },
  });

  const stateBefore = snapshotOwnState([
    spatialIndex,
    ...leaves,
  ]);
  assert.throws(
    () => buildLodNodeMappingsWithoutNotificationUi(spatialIndex),
    /synthetic leaf mapping read failure/,
  );
  const failureWasAtomic = ownStateMatches(stateBefore);
  assert.equal(spatialIndex._lodNodeMappingsBuilt, false);

  assert.doesNotThrow(
    () => buildLodNodeMappingsWithoutNotificationUi(spatialIndex),
  );
  assert.equal(spatialIndex._lodNodeMappingsBuilt, true);
  assert.equal(
    failureWasAtomic,
    true,
    'failed staging must not publish partial leaf metadata or mapping owners',
  );
});

test('large-N LOD node mapping retained bytes stay at the maximum-prefix bound', (t) => {
  const spatialIndex = makeLargeSpatialIndex(10_001);
  const buffersBefore = collectReachableBuffers(spatialIndex);
  const reducedLevels = spatialIndex.lodLevels.filter(
    level => !level.isFullDetail,
  );
  const expectedBound = Math.max(
    ...reducedLevels.map(level => level.pointCount),
  ) * Uint32Array.BYTES_PER_ELEMENT;
  const legacyPerLevelBytes = reducedLevels.reduce(
    (total, level) => total + level.pointCount * Uint32Array.BYTES_PER_ELEMENT,
    0,
  );

  const startedAt = performance.now();
  buildLodNodeMappingsWithoutNotificationUi(spatialIndex);
  const elapsedMs = performance.now() - startedAt;
  const addedBuffers = newReachableBuffers(spatialIndex, buffersBefore);
  const retainedBytes = addedBuffers.reduce(
    (total, buffer) => total + buffer.byteLength,
    0,
  );

  t.diagnostic(
    `10,001 points: mapping build ${elapsedMs.toFixed(2)}ms; ` +
    `retained ${retainedBytes.toLocaleString()} bytes; ` +
    `legacy per-level projection ${legacyPerLevelBytes.toLocaleString()} bytes; ` +
    `maximum-prefix bound ${expectedBound.toLocaleString()} bytes`,
  );
  assert.equal(addedBuffers.length, 1);
  assert.equal(retainedBytes, expectedBound);
  assert.ok(legacyPerLevelBytes / expectedBound > 4.5);
});
