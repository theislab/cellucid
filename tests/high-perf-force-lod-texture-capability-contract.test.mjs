import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getNotificationCenter,
} from '../assets/js/app/notification-center.js';
import {
  HighPerfRenderer,
  RendererConfig,
} from '../assets/js/rendering/high-perf-renderer.js';
import { SpatialIndex } from '../assets/js/rendering/high-perf/spatial-index.js';

const DIMENSION = 2;

function makePositions(pointCount, offset = 0) {
  const positions = new Float32Array(pointCount * 3);
  for (let index = 0; index < pointCount; index++) {
    const positionOffset = index * 3;
    positions[positionOffset] = offset + index / Math.max(pointCount, 1);
    positions[positionOffset + 1] =
      offset + ((index * 7) % Math.max(pointCount, 1)) /
        Math.max(pointCount, 1);
    positions[positionOffset + 2] = 0;
  }
  return positions;
}

function makeColors(pointCount) {
  const colors = new Uint8Array(pointCount * 4);
  for (let index = 0; index < pointCount; index++) {
    const colorOffset = index * 4;
    colors[colorOffset] = (index * 17) & 0xff;
    colors[colorOffset + 1] = (index * 31) & 0xff;
    colors[colorOffset + 2] = (index * 47) & 0xff;
    colors[colorOffset + 3] = 255;
  }
  return colors;
}

function createTrackingGl(maxTextureSize = 8192) {
  let nextId = 1;
  let boundArrayBuffer = null;
  let boundElementBuffer = null;
  let boundTexture = null;
  let boundVertexArray = null;
  const live = {
    buffers: new Set(),
    textures: new Set(),
    vertexArrays: new Set(),
  };
  const creates = {
    buffers: [],
    textures: [],
    vertexArrays: [],
  };
  const deletes = {
    buffers: [],
    textures: [],
    vertexArrays: [],
  };
  const uploads = [];

  const adopt = (kind, label = null) => {
    const handle = Object.freeze({
      id: label ?? `${kind}-${nextId++}`,
      kind,
    });
    if (kind === 'buffer') live.buffers.add(handle);
    if (kind === 'texture') live.textures.add(handle);
    if (kind === 'vertex-array') live.vertexArrays.add(handle);
    return handle;
  };

  const gl = {
    ARRAY_BUFFER: 0x8892,
    BLEND: 0x0be2,
    CLAMP_TO_EDGE: 0x812f,
    DEPTH_TEST: 0x0b71,
    DYNAMIC_DRAW: 0x88e8,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    FLOAT: 0x1406,
    FUNC_ADD: 0x8006,
    MAX_TEXTURE_SIZE: 0x0d33,
    NEAREST: 0x2600,
    NO_ERROR: 0,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    POINTS: 0x0000,
    R8: 0x8229,
    R32UI: 0x8236,
    RED: 0x1903,
    RED_INTEGER: 0x8d94,
    STATIC_DRAW: 0x88e4,
    SRC_ALPHA: 0x0302,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    UNSIGNED_BYTE: 0x1401,
    UNSIGNED_INT: 0x1405,

    bindBuffer(target, handle) {
      if (target === this.ARRAY_BUFFER) {
        boundArrayBuffer = handle;
      } else {
        assert.equal(target, this.ELEMENT_ARRAY_BUFFER);
        boundElementBuffer = handle;
      }
    },
    bindTexture(target, handle) {
      assert.equal(target, this.TEXTURE_2D);
      boundTexture = handle;
    },
    bindVertexArray(handle) {
      boundVertexArray = handle;
    },
    blendEquation() {},
    blendFuncSeparate() {},
    bufferData(target, data, usage) {
      uploads.push({
        buffer: target === this.ARRAY_BUFFER
          ? boundArrayBuffer
          : boundElementBuffer,
        byteLength: data.byteLength,
        kind: 'buffer',
        target,
        usage,
      });
    },
    createBuffer() {
      const handle = adopt('buffer');
      creates.buffers.push(handle);
      return handle;
    },
    createTexture() {
      const handle = adopt('texture');
      creates.textures.push(handle);
      return handle;
    },
    createVertexArray() {
      const handle = adopt('vertex-array');
      creates.vertexArrays.push(handle);
      return handle;
    },
    deleteBuffer(handle) {
      deletes.buffers.push(handle);
      live.buffers.delete(handle);
    },
    deleteTexture(handle) {
      deletes.textures.push(handle);
      live.textures.delete(handle);
    },
    deleteVertexArray(handle) {
      deletes.vertexArrays.push(handle);
      live.vertexArrays.delete(handle);
    },
    disable() {},
    enable() {},
    enableVertexAttribArray() {},
    getError() {
      return this.NO_ERROR;
    },
    getParameter(parameter) {
      assert.equal(parameter, this.MAX_TEXTURE_SIZE);
      return maxTextureSize;
    },
    isBuffer(handle) {
      return live.buffers.has(handle);
    },
    isTexture(handle) {
      return live.textures.has(handle);
    },
    isVertexArray(handle) {
      return live.vertexArrays.has(handle);
    },
    texImage2D(
      target,
      level,
      internalFormat,
      width,
      height,
      border,
      format,
      type,
      data,
    ) {
      assert.equal(target, this.TEXTURE_2D);
      assert.notEqual(boundTexture, null);
      uploads.push({
        border,
        byteLength: data?.byteLength ?? 0,
        data,
        format,
        height,
        internalFormat,
        kind: 'texture',
        level,
        texture: boundTexture,
        type,
        width,
      });
    },
    texSubImage2D(
      target,
      level,
      xOffset,
      yOffset,
      width,
      height,
      format,
      type,
      data,
    ) {
      assert.equal(target, this.TEXTURE_2D);
      assert.notEqual(boundTexture, null);
      assert.ok(ArrayBuffer.isView(data));
      uploads.push({
        byteLength: data.byteLength,
        data: new data.constructor(data),
        format,
        height,
        kind: 'texture-subimage',
        level,
        texture: boundTexture,
        type,
        width,
        xOffset,
        yOffset,
      });
    },
    texParameteri() {},
    vertexAttribPointer() {},

    _adoptBuffer(label) {
      return adopt('buffer', label);
    },
    _adoptTexture(label) {
      return adopt('texture', label);
    },
    _adoptVertexArray(label) {
      return adopt('vertex-array', label);
    },
    _setMaxTextureSize(value) {
      maxTextureSize = value;
    },
    _state: {
      get boundVertexArray() {
        return boundVertexArray;
      },
      creates,
      deletes,
      live,
      uploads,
    },
  };
  return gl;
}

function replaceCalculationNotifications(t) {
  const notifications = getNotificationCenter();
  const previous = {
    completeCalculation: notifications.completeCalculation,
    failCalculation: notifications.failCalculation,
    hasNotification: notifications.hasNotification,
    startCalculation: notifications.startCalculation,
  };
  let nextId = 1;
  Object.assign(notifications, {
    completeCalculation() {},
    failCalculation() {},
    hasNotification: () => true,
    startCalculation: () => `force-lod-${nextId++}`,
  });
  t.after(() => Object.assign(notifications, previous));
}

function renderParams(viewId, forceLOD = 0) {
  const identity = Float32Array.from([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  return {
    autoFog: false,
    cameraDistance: 4,
    cameraPosition: Float32Array.from([0, 0, 4]),
    dimensionLevel: DIMENSION,
    fogColor: Float32Array.from([0, 0, 0]),
    fogDensity: 0,
    forceLOD,
    fov: Math.PI / 4,
    lightDir: Float32Array.from([0, 0, 1]),
    lightingStrength: 0,
    modelMatrix: identity,
    mvpMatrix: identity,
    pointSize: 2,
    projectionMatrix: identity,
    quality: 'full',
    sizeAttenuation: 0,
    useAlphaTexture: false,
    viewId,
    viewMatrix: identity,
    viewportHeight: 600,
    viewportWidth: 800,
  };
}

function createRendererState(
  gl,
  positions,
  colors,
  {
    liveGeometryGeneration = 3,
  } = {},
) {
  const mainBuffer = gl._adoptBuffer('main-buffer');
  const mainVao = gl._adoptVertexArray('main-vao');
  return Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _alphaTexData: null,
      _alphaTexHeight: 0,
      _alphaTexWidth: 0,
      _alphaTexture: null,
      _bufferDirty: false,
      _colors: colors,
      _currentAlphas: null,
      _dirtyLodDimensions: new Set(),
      _dummyLodIndexTexture:
        gl._adoptTexture('dummy-lod-index-texture'),
      _dummyLodIndexTextureByteLength:
        Uint32Array.BYTES_PER_ELEMENT,
      _firstRenderDone: true,
      _interleavedArrayBuffer: null,
      _interleavedColorView: null,
      _interleavedPositionView: null,
      _liveGeometryGeneration: liveGeometryGeneration,
      _lodArrayBuffers: null,
      _lodIndexTexturesByDimension: new Map(),
      _lodResourceOwnersByDimension: new Map(),
      _nextGeometryGeneration: liveGeometryGeneration + 1,
      _pendingDataRetirements: new Set(),
      _pendingSnapshotRetirements: new Set(),
      _perViewState: new Map(),
      _positions: positions,
      _snapshotGeometryPools: new Map(),
      _useAlphaTexture: false,
      _validatedLodNodeMappings: new WeakMap(),
      _validatedSpatialIndices: new WeakSet(),
      activeProgram: Object.freeze({ id: 'program' }),
      activeQuality: 'full',
      buffers: {
        alphas: null,
        colors: null,
        interleaved: mainBuffer,
        positions: null,
      },
      currentDimensionLevel: DIMENSION,
      forceLODLevel: -1,
      gl,
      lodBuffersByDimension: new Map(),
      options: {
        ...RendererConfig,
        USE_FRUSTUM_CULLING: false,
        USE_LOD: false,
      },
      pointCount: positions.length / 3,
      snapshotBuffers: new Map(),
      spatialIndices: new Map(),
      stats: {
        cullPercent: 0,
        drawCalls: 0,
        fps: 0,
        frustumCulled: false,
        gpuMemoryMB: 0,
        lastFrameTime: 0,
        lodLevel: -1,
        visiblePoints: 0,
      },
      uniformLocations: new Map(),
      useAdaptiveLOD: false,
      useFrustumCulling: false,
      vao: mainVao,
    },
  );
}

function makeSpatialOwner(positions, maximumIndices) {
  return {
    dimensionLevel: DIMENSION,
    lodLevels: [
      {
        depth: 0,
        indices: maximumIndices,
        isFullDetail: false,
        pointCount: maximumIndices.length,
        sizeMultiplier: 1.5,
      },
      {
        depth: 1,
        isFullDetail: true,
        pointCount: positions.length / 3,
        positions,
        sizeMultiplier: 1,
      },
    ],
    pointCount: positions.length / 3,
    positions,
    ensureLODLevels() {},
  };
}

test('explicit live forceLOD lazily builds one exact LOD generation when all LOD defaults are disabled', t => {
  replaceCalculationNotifications(t);
  assert.equal(
    RendererConfig.USE_LOD,
    false,
    'this contract exercises the shipped global default',
  );

  const gl = createTrackingGl();
  const positions = makePositions(4);
  const colors = makeColors(4);
  const renderer = createRendererState(gl, positions, colors);
  const viewState = {
    lastLodLevel: -1,
    prevLodLevel: undefined,
  };
  let renderedLevel = null;
  renderer._getViewState = () => viewState;
  renderer._renderLOD = level => {
    renderedLevel = level;
  };
  renderer._publishFrameTiming = () => {};
  renderer.getStats = () => ({ renderedLevel });

  const result = renderer.render(renderParams('live', 0));
  const spatialIndex = renderer.spatialIndices.get(DIMENSION);
  const owner =
    renderer._lodResourceOwnersByDimension.get(DIMENSION);

  assert.equal(renderer.useAdaptiveLOD, false);
  assert.equal(renderer.options.USE_LOD, false);
  assert.ok(spatialIndex instanceof SpatialIndex);
  assert.ok(spatialIndex.lodLevels.length > 1);
  assert.strictEqual(spatialIndex.positions, positions);
  assert.strictEqual(owner.spatialIndex, spatialIndex);
  assert.equal(
    owner.liveGeometryGeneration,
    renderer._liveGeometryGeneration,
  );
  assert.equal(
    renderer.lodBuffersByDimension.get(DIMENSION).length,
    spatialIndex.lodLevels.length,
  );
  assert.equal(renderedLevel, 0);
  assert.deepEqual(result, { renderedLevel: 0 });
});

test('explicit snapshot forceLOD promotes the exact pooled tree when all LOD defaults are disabled', t => {
  replaceCalculationNotifications(t);
  const gl = createTrackingGl();
  const livePositions = makePositions(4);
  const colors = makeColors(4);
  const renderer = createRendererState(
    gl,
    livePositions,
    colors,
    { liveGeometryGeneration: 10 },
  );
  const snapshotPositions = makePositions(4, 10);
  const spatialIndex = new SpatialIndex(
    snapshotPositions,
    null,
    DIMENSION,
    renderer.options.LOD_MAX_POINTS_PER_NODE,
    renderer.options.LOD_MAX_DEPTH,
    {
      buildLOD: false,
      buildLodNodeMappings: false,
      computeNodeStats: false,
    },
  );
  const geometryGeneration = 9;
  const alphaTexData = new Uint8Array(4);
  alphaTexData.fill(255);
  const snapshotBuffer =
    gl._adoptBuffer('snapshot-buffer');
  const snapshot = {
    alphaTexData,
    alphaTexHeight: 1,
    alphaTexWidth: 4,
    alphaTexture:
      gl._adoptTexture('snapshot-alpha-texture'),
    alphaTextureByteLength: alphaTexData.byteLength,
    bounds: HighPerfRenderer.computeBoundsFromPositions(
      snapshotPositions,
    ),
    buffer: snapshotBuffer,
    bufferByteLength: 4 * 3,
    colorOwner: {
      buffer: snapshotBuffer,
      byteLength: 4 * 3,
      pointCount: 4,
      refCount: 1,
    },
    dimensionLevel: DIMENSION,
    geometryGeneration,
    id: 'snapshot',
    pointCount: 4,
    positions: snapshotPositions,
    spatialIndex,
    vao: gl._adoptVertexArray('snapshot-vao'),
  };
  renderer.snapshotBuffers.set('snapshot', snapshot);
  renderer._snapshotGeometryPools.set(geometryGeneration, {
    generation: geometryGeneration,
    positions: snapshotPositions,
    refCount: 1,
    spatialIndices: new Map([[DIMENSION, spatialIndex]]),
  });

  const viewState = {
    lastLodLevel: -1,
    prevLodLevel: undefined,
  };
  let draw = null;
  renderer._getViewState = () => viewState;
  renderer.invalidateViewState = () => true;
  renderer._renderSnapshotWithLOD = (
    exactSnapshot,
    lodLevel,
    _params,
    _viewState,
    _useAlphaTexture,
    exactSpatialIndex,
  ) => {
    draw = {
      exactSnapshot,
      exactSpatialIndex,
      lodLevel,
    };
  };
  renderer._publishFrameTiming = () => {};
  renderer.getStats = () => ({ lodLevel: draw?.lodLevel ?? null });

  const result = renderer.renderWithSnapshot(
    'snapshot',
    renderParams('snapshot', 0),
  );

  assert.equal(renderer.useAdaptiveLOD, false);
  assert.equal(renderer.options.USE_LOD, false);
  assert.strictEqual(snapshot.spatialIndex, spatialIndex);
  assert.strictEqual(
    renderer._snapshotGeometryPools
      .get(geometryGeneration)
      .spatialIndices
      .get(DIMENSION),
    spatialIndex,
  );
  assert.ok(spatialIndex.lodLevels.length > 1);
  assert.strictEqual(draw.exactSnapshot, snapshot);
  assert.strictEqual(draw.exactSpatialIndex, spatialIndex);
  assert.equal(draw.lodLevel, 0);
  assert.deepEqual(result, { lodLevel: 0 });
});

test('explicit snapshot forceLOD builds an exact missing pooled LOD tree when defaults are disabled', t => {
  replaceCalculationNotifications(t);
  const gl = createTrackingGl();
  const livePositions = makePositions(3);
  const colors = makeColors(3);
  const renderer = createRendererState(
    gl,
    livePositions,
    colors,
    { liveGeometryGeneration: 20 },
  );
  const snapshotPositions = makePositions(3, 20);
  const geometryGeneration = 19;
  const alphaTexData = new Uint8Array(3);
  alphaTexData.fill(255);
  const snapshotBuffer =
    gl._adoptBuffer('unindexed-snapshot-buffer');
  const snapshot = {
    alphaTexData,
    alphaTexHeight: 1,
    alphaTexWidth: 3,
    alphaTexture:
      gl._adoptTexture('unindexed-snapshot-alpha-texture'),
    alphaTextureByteLength: alphaTexData.byteLength,
    bounds: HighPerfRenderer.computeBoundsFromPositions(
      snapshotPositions,
    ),
    buffer: snapshotBuffer,
    bufferByteLength: 3 * 3,
    colorOwner: {
      buffer: snapshotBuffer,
      byteLength: 3 * 3,
      pointCount: 3,
      refCount: 1,
    },
    dimensionLevel: DIMENSION,
    geometryGeneration,
    id: 'unindexed-snapshot',
    pointCount: 3,
    positions: snapshotPositions,
    spatialIndex: null,
    vao: gl._adoptVertexArray('unindexed-snapshot-vao'),
  };
  renderer.snapshotBuffers.set('unindexed-snapshot', snapshot);
  renderer._snapshotGeometryPools.set(geometryGeneration, {
    generation: geometryGeneration,
    positions: snapshotPositions,
    refCount: 1,
    spatialIndices: new Map(),
  });

  const viewState = {
    lastLodLevel: -1,
    prevLodLevel: undefined,
  };
  let draw = null;
  renderer._getViewState = () => viewState;
  renderer.invalidateViewState = () => true;
  renderer._renderSnapshotWithLOD = (
    _snapshot,
    lodLevel,
    _params,
    _viewState,
    _useAlphaTexture,
    spatialIndex,
  ) => {
    draw = { lodLevel, spatialIndex };
  };
  renderer._publishFrameTiming = () => {};
  renderer.getStats = () => ({ lodLevel: draw?.lodLevel ?? null });

  const result = renderer.renderWithSnapshot(
    'unindexed-snapshot',
    renderParams('unindexed-snapshot', 0),
  );
  const pooledSpatialIndex =
    renderer._snapshotGeometryPools
      .get(geometryGeneration)
      .spatialIndices
      .get(DIMENSION);

  assert.ok(pooledSpatialIndex instanceof SpatialIndex);
  assert.strictEqual(snapshot.spatialIndex, pooledSpatialIndex);
  assert.strictEqual(pooledSpatialIndex.positions, snapshotPositions);
  assert.ok(pooledSpatialIndex.lodLevels.length > 1);
  assert.strictEqual(draw.spatialIndex, pooledSpatialIndex);
  assert.equal(draw.lodLevel, 0);
  assert.deepEqual(result, { lodLevel: 0 });
});

test('same-length LOD metadata cannot hide a stale spatial or maximum-prefix owner', () => {
  const gl = createTrackingGl();
  const positions = makePositions(4);
  const colors = makeColors(4);
  const renderer = createRendererState(gl, positions, colors);
  const acceptedIndices = Uint32Array.from([0, 1]);
  const currentIndices = Uint32Array.from([2, 3]);
  const acceptedSpatial = makeSpatialOwner(
    positions,
    acceptedIndices,
  );
  const currentSpatial = makeSpatialOwner(
    positions,
    currentIndices,
  );
  const generationToken = Object.freeze({});
  const staleBuffers = [
    {
      generationToken,
      isFullDetail: false,
      pointCount: 2,
    },
    {
      generationToken: null,
      isFullDetail: true,
      pointCount: 4,
    },
  ];
  const staleTextures = [
    { generationToken },
    { generationToken: null },
  ];
  const staleOwner = {
    generationToken,
    liveGeometryGeneration: renderer._liveGeometryGeneration,
    maximumIndices: acceptedIndices,
    pointCount: 4,
    spatialIndex: acceptedSpatial,
  };
  renderer._lodResourceOwnersByDimension.set(
    DIMENSION,
    staleOwner,
  );
  renderer.lodBuffersByDimension.set(DIMENSION, staleBuffers);
  renderer._lodIndexTexturesByDimension.set(
    DIMENSION,
    staleTextures,
  );

  const rebuilds = [];
  const replacement = Object.freeze([{ id: 'replacement' }]);
  renderer._createLODResourcesForDimension = (
    dimensionLevel,
    spatialIndex,
  ) => {
    rebuilds.push({ dimensionLevel, spatialIndex });
    return replacement;
  };

  assert.strictEqual(
    renderer._ensureLodResourcesForDimension(
      DIMENSION,
      currentSpatial,
    ),
    replacement,
  );
  assert.deepEqual(rebuilds, [{
    dimensionLevel: DIMENSION,
    spatialIndex: currentSpatial,
  }]);

  rebuilds.length = 0;
  staleOwner.spatialIndex = currentSpatial;
  assert.strictEqual(
    renderer._ensureLodResourcesForDimension(
      DIMENSION,
      currentSpatial,
    ),
    replacement,
    'a same-sized replacement prefix is a new topology owner',
  );
  assert.deepEqual(rebuilds, [{
    dimensionLevel: DIMENSION,
    spatialIndex: currentSpatial,
  }]);

  rebuilds.length = 0;
  staleOwner.maximumIndices = currentIndices;
  staleBuffers[0].generationToken = Object.freeze({});
  assert.strictEqual(
    renderer._ensureLodResourcesForDimension(
      DIMENSION,
      currentSpatial,
    ),
    replacement,
    'reduced draw metadata must project the exact owner token',
  );
  assert.deepEqual(rebuilds, [{
    dimensionLevel: DIMENSION,
    spatialIndex: currentSpatial,
  }]);

  rebuilds.length = 0;
  staleBuffers[0].generationToken = generationToken;
  staleTextures[0].generationToken = Object.freeze({});
  assert.strictEqual(
    renderer._ensureLodResourcesForDimension(
      DIMENSION,
      currentSpatial,
    ),
    replacement,
    'R32UI metadata must project the exact owner token',
  );
  assert.deepEqual(rebuilds, [{
    dimensionLevel: DIMENSION,
    spatialIndex: currentSpatial,
  }]);
});

test('LOD ensure validates exact handles, bytes, texture geometry, token, and full-detail projections', () => {
  const gl = createTrackingGl();
  const positions = makePositions(4);
  const colors = makeColors(4);
  const renderer = createRendererState(gl, positions, colors);
  const spatialIndex = makeSpatialOwner(
    positions,
    Uint32Array.from([2, 0]),
  );
  renderer.spatialIndices.set(DIMENSION, spatialIndex);
  const acceptedMetadata =
    renderer._createLODResourcesForDimension(
      DIMENSION,
      spatialIndex,
    );
  const acceptedOwner =
    renderer._lodResourceOwnersByDimension.get(DIMENSION);
  const acceptedTextureMetadata =
    renderer._lodIndexTexturesByDimension.get(DIMENSION);
  let owner = acceptedOwner;
  let reducedMetadata = acceptedMetadata[0];
  let fullMetadata = acceptedMetadata.at(-1);
  let textureMetadata = acceptedTextureMetadata[0];
  let fullTextureMetadata = acceptedTextureMetadata.at(-1);

  let rebuilds = 0;
  const replacement = Object.freeze([{ id: 'replacement' }]);
  renderer._createLODResourcesForDimension = (
    dimensionLevel,
    exactSpatialIndex,
  ) => {
    assert.equal(dimensionLevel, DIMENSION);
    assert.strictEqual(exactSpatialIndex, spatialIndex);
    rebuilds += 1;
    return replacement;
  };

  assert.strictEqual(
    renderer._ensureLodResourcesForDimension(
      DIMENSION,
      spatialIndex,
    ),
    acceptedMetadata,
    'an exact accepted projection must remain allocation-free',
  );
  assert.equal(rebuilds, 0);

  const cases = [
    {
      label: 'compact buffer handle',
      mutate() {
        const previousOwner = owner.compactBuffer;
        const previousMetadata = reducedMetadata.buffer;
        owner.compactBuffer = null;
        reducedMetadata.buffer = null;
        return () => {
          owner.compactBuffer = previousOwner;
          reducedMetadata.buffer = previousMetadata;
        };
      },
    },
    {
      label: 'compact VAO handle',
      mutate() {
        const previousOwner = owner.compactVao;
        const previousMetadata = reducedMetadata.vao;
        owner.compactVao = null;
        reducedMetadata.vao = null;
        return () => {
          owner.compactVao = previousOwner;
          reducedMetadata.vao = previousMetadata;
        };
      },
    },
    {
      label: 'original-index buffer handle',
      mutate() {
        const previousOwner =
          owner.topologyOwner.originalIndexBuffer;
        const previousMetadata =
          reducedMetadata.originalIndexBuffer;
        owner.topologyOwner.originalIndexBuffer = null;
        reducedMetadata.originalIndexBuffer = null;
        return () => {
          owner.topologyOwner.originalIndexBuffer =
            previousOwner;
          reducedMetadata.originalIndexBuffer =
            previousMetadata;
        };
      },
    },
    {
      label: 'R32UI texture handle',
      mutate() {
        const previousOwner = owner.topologyOwner.indexTexture;
        const previousMetadata = textureMetadata.texture;
        owner.topologyOwner.indexTexture = null;
        textureMetadata.texture = null;
        return () => {
          owner.topologyOwner.indexTexture = previousOwner;
          textureMetadata.texture = previousMetadata;
        };
      },
    },
    {
      label: 'compact byte length',
      mutate() {
        const previous = owner.compactByteLength;
        owner.compactByteLength = previous - 1;
        return () => {
          owner.compactByteLength = previous;
        };
      },
    },
    {
      label: 'original-index byte length',
      mutate() {
        const previous =
          owner.topologyOwner.originalIndexByteLength;
        owner.topologyOwner.originalIndexByteLength =
          previous - 1;
        return () => {
          owner.topologyOwner.originalIndexByteLength =
            previous;
        };
      },
    },
    {
      label: 'R32UI byte length',
      mutate() {
        const previous =
          owner.topologyOwner.indexTextureByteLength;
        owner.topologyOwner.indexTextureByteLength =
          previous - Uint32Array.BYTES_PER_ELEMENT;
        return () => {
          owner.topologyOwner.indexTextureByteLength =
            previous;
        };
      },
    },
    {
      label: 'aggregate GPU byte length',
      mutate() {
        const previous = owner.gpuByteLength;
        owner.gpuByteLength = previous - 1;
        return () => {
          owner.gpuByteLength = previous;
        };
      },
    },
    {
      label: 'canonical texture geometry',
      mutate() {
        const previousWidth = owner.topologyOwner.textureWidth;
        const previousHeight =
          owner.topologyOwner.textureHeight;
        const previousMetadataWidth = textureMetadata.width;
        const previousMetadataHeight = textureMetadata.height;
        owner.topologyOwner.textureWidth = 1;
        owner.topologyOwner.textureHeight = 2;
        textureMetadata.width = 1;
        textureMetadata.height = 2;
        return () => {
          owner.topologyOwner.textureWidth = previousWidth;
          owner.topologyOwner.textureHeight = previousHeight;
          textureMetadata.width = previousMetadataWidth;
          textureMetadata.height = previousMetadataHeight;
        };
      },
    },
    {
      label: 'immutable generation token',
      mutate() {
        const previousOwner = owner.generationToken;
        const previousMetadata =
          reducedMetadata.generationToken;
        const previousTexture =
          textureMetadata.generationToken;
        const mutableToken = {};
        owner.generationToken = mutableToken;
        reducedMetadata.generationToken = mutableToken;
        textureMetadata.generationToken = mutableToken;
        return () => {
          owner.generationToken = previousOwner;
          reducedMetadata.generationToken = previousMetadata;
          textureMetadata.generationToken = previousTexture;
        };
      },
    },
    {
      label: 'full-detail main-buffer projection',
      mutate() {
        const previous = fullMetadata.buffer;
        fullMetadata.buffer = owner.compactBuffer;
        return () => {
          fullMetadata.buffer = previous;
        };
      },
    },
    {
      label: 'full-detail topology projection',
      mutate() {
        const previousBuffer =
          fullMetadata.originalIndexBuffer;
        const previousCount =
          fullMetadata.originalIndexCount;
        const previousTexture =
          fullTextureMetadata.texture;
        fullMetadata.originalIndexBuffer =
          owner.topologyOwner.originalIndexBuffer;
        fullMetadata.originalIndexCount = 1;
        fullTextureMetadata.texture =
          owner.topologyOwner.indexTexture;
        return () => {
          fullMetadata.originalIndexBuffer =
            previousBuffer;
          fullMetadata.originalIndexCount = previousCount;
          fullTextureMetadata.texture = previousTexture;
        };
      },
    },
  ];

  for (const exactCase of cases) {
    const mutableMetadata = acceptedMetadata.map(
      metadata => ({ ...metadata }),
    );
    const mutableTextureMetadata = acceptedTextureMetadata.map(
      metadata => ({ ...metadata }),
    );
    owner = {
      ...acceptedOwner,
      topologyOwner: {
        ...acceptedOwner.topologyOwner,
      },
    };
    reducedMetadata = mutableMetadata[0];
    fullMetadata = mutableMetadata.at(-1);
    textureMetadata = mutableTextureMetadata[0];
    fullTextureMetadata = mutableTextureMetadata.at(-1);
    renderer._lodResourceOwnersByDimension.set(DIMENSION, owner);
    renderer.lodBuffersByDimension.set(DIMENSION, mutableMetadata);
    renderer._lodIndexTexturesByDimension.set(
      DIMENSION,
      mutableTextureMetadata,
    );
    const restore = exactCase.mutate();
    const before = rebuilds;
    try {
      assert.strictEqual(
        renderer._ensureLodResourcesForDimension(
          DIMENSION,
          spatialIndex,
        ),
        replacement,
        `${exactCase.label} corruption must rebuild`,
      );
      assert.equal(
        rebuilds,
        before + 1,
        `${exactCase.label} corruption must rebuild exactly once`,
      );
    } finally {
      restore();
      renderer._lodResourceOwnersByDimension.set(
        DIMENSION,
        acceptedOwner,
      );
      renderer.lodBuffersByDimension.set(
        DIMENSION,
        acceptedMetadata,
      );
      renderer._lodIndexTexturesByDimension.set(
        DIMENSION,
        acceptedTextureMetadata,
      );
    }
  }

  assert.strictEqual(
    renderer._ensureLodResourcesForDimension(
      DIMENSION,
      spatialIndex,
    ),
    acceptedMetadata,
    'restoring every exact projection must restore no-churn reuse',
  );
});

test('a full-detail-only spatial generation retains one zero-byte owner without repeated rebuilds', () => {
  const gl = createTrackingGl();
  const positions = makePositions(3);
  const colors = makeColors(3);
  const renderer = createRendererState(gl, positions, colors);
  const spatialIndex = {
    dimensionLevel: DIMENSION,
    ensureLODLevels() {},
    lodLevels: [{
      depth: 0,
      isFullDetail: true,
      pointCount: 3,
      positions,
      sizeMultiplier: 1,
    }],
    pointCount: 3,
    positions,
  };
  renderer.spatialIndices.set(DIMENSION, spatialIndex);
  const createCounts = {
    buffers: gl._state.creates.buffers.length,
    textures: gl._state.creates.textures.length,
    vertexArrays: gl._state.creates.vertexArrays.length,
  };

  const acceptedMetadata =
    renderer._createLODResourcesForDimension(
      DIMENSION,
      spatialIndex,
    );
  const acceptedTextures =
    renderer._lodIndexTexturesByDimension.get(DIMENSION);
  const owner =
    renderer._lodResourceOwnersByDimension.get(DIMENSION);

  assert.ok(owner);
  assert.strictEqual(owner.spatialIndex, spatialIndex);
  assert.equal(owner.maximumIndices, null);
  assert.equal(owner.pointCount, 3);
  assert.equal(
    owner.liveGeometryGeneration,
    renderer._liveGeometryGeneration,
  );
  assert.ok(Object.isFrozen(owner.generationToken));
  assert.equal(owner.compactBuffer, null);
  assert.equal(owner.compactVao, null);
  assert.equal(owner.compactByteLength, 0);
  assert.equal(owner.topologyOwner.originalIndexBuffer, null);
  assert.equal(owner.topologyOwner.originalIndexByteLength, 0);
  assert.equal(owner.topologyOwner.indexTexture, null);
  assert.equal(owner.topologyOwner.indexTextureByteLength, 0);
  assert.equal(owner.topologyOwner.textureWidth, 0);
  assert.equal(owner.topologyOwner.textureHeight, 0);
  assert.equal(owner.gpuByteLength, 0);
  assert.equal(acceptedMetadata.length, 1);
  assert.strictEqual(
    acceptedMetadata[0].vao,
    renderer.vao,
  );
  assert.strictEqual(
    acceptedMetadata[0].buffer,
    renderer.buffers.interleaved,
  );
  assert.equal(acceptedMetadata[0].isFullDetail, true);
  assert.equal(acceptedMetadata[0].generationToken, null);
  assert.deepEqual(acceptedTextures, [{
    texture: null,
    width: 0,
    height: 0,
    generationToken: null,
  }]);
  assert.deepEqual(
    {
      buffers: gl._state.creates.buffers.length,
      textures: gl._state.creates.textures.length,
      vertexArrays: gl._state.creates.vertexArrays.length,
    },
    createCounts,
    'a zero-reduced-level generation owns no additional GL handles',
  );

  let rebuilds = 0;
  renderer._createLODResourcesForDimension = () => {
    rebuilds += 1;
    throw new Error(
      'a retained full-detail-only owner must not rebuild',
    );
  };
  assert.strictEqual(
    renderer._ensureLodResourcesForDimension(
      DIMENSION,
      spatialIndex,
    ),
    acceptedMetadata,
  );
  assert.strictEqual(
    renderer._ensureLodResourcesForDimension(
      DIMENSION,
      spatialIndex,
    ),
    acceptedMetadata,
  );
  assert.equal(rebuilds, 0);
  assert.strictEqual(
    renderer._lodResourceOwnersByDimension.get(DIMENSION),
    owner,
  );
  assert.strictEqual(
    renderer.lodBuffersByDimension.get(DIMENSION),
    acceptedMetadata,
  );
  assert.strictEqual(
    renderer._lodIndexTexturesByDimension.get(DIMENSION),
    acceptedTextures,
  );
});

test('internal certified LOD readiness is O(1) while external owners retain deep validation', () => {
  const gl = createTrackingGl();
  const positions = makePositions(4);
  const colors = makeColors(4);
  const renderer = createRendererState(gl, positions, colors);
  const spatialIndex = makeSpatialOwner(
    positions,
    Uint32Array.from([2, 0]),
  );
  renderer.spatialIndices.set(DIMENSION, spatialIndex);
  const acceptedMetadata =
    renderer._createLODResourcesForDimension(
      DIMENSION,
      spatialIndex,
    );

  const originalDeepEnsure =
    renderer._ensureLodResourcesForDimension;
  let deepValidations = 0;
  renderer._ensureLodResourcesForDimension = function (...args) {
    deepValidations += 1;
    return originalDeepEnsure.apply(this, args);
  };
  assert.strictEqual(
    renderer._getCertifiedLodResourcesForDimension(
      DIMENSION,
      spatialIndex,
    ),
    acceptedMetadata,
  );
  assert.strictEqual(
    renderer._getCertifiedLodResourcesForDimension(
      DIMENSION,
      spatialIndex,
    ),
    acceptedMetadata,
  );
  assert.equal(
    deepValidations,
    0,
    'an accepted renderer-owned generation must not scan its levels again',
  );

  const externalOwner = {
    dimensionLevel: DIMENSION,
    spatialIndex,
  };
  renderer._lodResourceOwnersByDimension.set(
    DIMENSION,
    externalOwner,
  );
  const replacement = Object.freeze([{ id: 'replacement' }]);
  renderer._ensureLodResourcesForDimension = (
    dimensionLevel,
    exactSpatialIndex,
  ) => {
    assert.equal(dimensionLevel, DIMENSION);
    assert.strictEqual(exactSpatialIndex, spatialIndex);
    deepValidations += 1;
    return replacement;
  };
  assert.strictEqual(
    renderer._getCertifiedLodResourcesForDimension(
      DIMENSION,
      spatialIndex,
    ),
    replacement,
  );
  assert.equal(
    deepValidations,
    1,
    'an external or malformed owner must route through deep validation',
  );
});

test('alpha and R32UI packing consume runtime texture width beyond 4096', () => {
  const pointCount = 4097;
  const gl = createTrackingGl(8192);
  const positions = makePositions(pointCount);
  const colors = makeColors(pointCount);

  const alphaRenderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _alphaTexData: null,
      _alphaTexHeight: 0,
      _alphaTexWidth: 0,
      _alphaTexture: null,
      _useAlphaTexture: false,
      gl,
    },
  );
  alphaRenderer._createAlphaTexture(pointCount);

  const lodRenderer = createRendererState(
    gl,
    positions,
    colors,
  );
  const maximumIndices = Uint32Array.from(
    { length: pointCount },
    (_value, index) => index,
  );
  const spatialIndex = makeSpatialOwner(
    positions,
    maximumIndices,
  );
  lodRenderer.spatialIndices.set(DIMENSION, spatialIndex);
  lodRenderer._createLODResourcesForDimension(
    DIMENSION,
    spatialIndex,
  );

  const alphaUpload = gl._state.uploads.find(
    upload => (
      upload.kind === 'texture' &&
      upload.internalFormat === gl.R8
    ),
  );
  const indexUpload = gl._state.uploads.find(
    upload => (
      upload.kind === 'texture' &&
      upload.internalFormat === gl.R32UI
    ),
  );
  const topologyOwner =
    lodRenderer._lodResourceOwnersByDimension
      .get(DIMENSION)
      .topologyOwner;

  assert.equal(alphaRenderer._alphaTexWidth, pointCount);
  assert.equal(alphaRenderer._alphaTexHeight, 1);
  assert.equal(alphaUpload.width, pointCount);
  assert.equal(alphaUpload.height, 1);
  assert.equal(indexUpload.width, pointCount);
  assert.equal(indexUpload.height, 1);
  assert.equal(topologyOwner.textureWidth, pointCount);
  assert.equal(topologyOwner.textureHeight, 1);
});

test('invalid texture capabilities reject before allocation and preserve exact accepted publications', () => {
  for (const invalidCapability of [0, -1, 8192.5, Number.NaN]) {
    const gl = createTrackingGl(invalidCapability);
    const acceptedAlphaTexture =
      gl._adoptTexture(`accepted-alpha-${String(invalidCapability)}`);
    const acceptedAlphaData = Uint8Array.from([255, 127]);
    const alphaRenderer = Object.assign(
      Object.create(HighPerfRenderer.prototype),
      {
        _alphaTexData: acceptedAlphaData,
        _alphaTexHeight: 1,
        _alphaTexWidth: 2,
        _alphaTexture: acceptedAlphaTexture,
        _useAlphaTexture: true,
        gl,
      },
    );

    assert.throws(
      () => alphaRenderer._createAlphaTexture(3),
      /invalid MAX_TEXTURE_SIZE capability/,
    );
    assert.strictEqual(
      alphaRenderer._alphaTexture,
      acceptedAlphaTexture,
    );
    assert.strictEqual(
      alphaRenderer._alphaTexData,
      acceptedAlphaData,
    );
    assert.equal(alphaRenderer._alphaTexWidth, 2);
    assert.equal(alphaRenderer._alphaTexHeight, 1);
    assert.equal(gl._state.creates.textures.length, 0);
    assert.equal(gl._state.deletes.textures.length, 0);

    const positions = makePositions(3);
    const colors = makeColors(3);
    const lodRenderer = createRendererState(
      gl,
      positions,
      colors,
    );
    const spatialIndex = makeSpatialOwner(
      positions,
      Uint32Array.from([0, 1, 2]),
    );
    const acceptedOwner = Object.freeze({
      id: `accepted-owner-${String(invalidCapability)}`,
    });
    const acceptedBuffers = Object.freeze([
      Object.freeze({ id: 'accepted-buffer-view' }),
    ]);
    const acceptedTextures = Object.freeze([
      Object.freeze({ id: 'accepted-texture-view' }),
    ]);
    const acceptedOwnersMap = new Map([
      [DIMENSION, acceptedOwner],
    ]);
    const acceptedBuffersMap = new Map([
      [DIMENSION, acceptedBuffers],
    ]);
    const acceptedTexturesMap = new Map([
      [DIMENSION, acceptedTextures],
    ]);
    lodRenderer._lodResourceOwnersByDimension =
      acceptedOwnersMap;
    lodRenderer.lodBuffersByDimension = acceptedBuffersMap;
    lodRenderer._lodIndexTexturesByDimension =
      acceptedTexturesMap;

    assert.throws(
      () => lodRenderer._createLODResourcesForDimension(
        DIMENSION,
        spatialIndex,
      ),
      /invalid MAX_TEXTURE_SIZE capability/,
    );
    assert.strictEqual(
      lodRenderer._lodResourceOwnersByDimension,
      acceptedOwnersMap,
    );
    assert.strictEqual(
      lodRenderer.lodBuffersByDimension,
      acceptedBuffersMap,
    );
    assert.strictEqual(
      lodRenderer._lodIndexTexturesByDimension,
      acceptedTexturesMap,
    );
    assert.equal(gl._state.creates.buffers.length, 0);
    assert.equal(gl._state.creates.vertexArrays.length, 0);
    assert.equal(gl._state.creates.textures.length, 0);
  }
});

test('texture-capacity failures preserve accepted alpha and R32UI publications', () => {
  const gl = createTrackingGl(4);
  const acceptedAlphaTexture =
    gl._adoptTexture('accepted-alpha');
  const acceptedAlphaData = Uint8Array.from([255, 127, 63, 31]);
  const alphaRenderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _alphaTexData: acceptedAlphaData,
      _alphaTexHeight: 1,
      _alphaTexWidth: 4,
      _alphaTexture: acceptedAlphaTexture,
      _useAlphaTexture: true,
      gl,
    },
  );

  assert.throws(
    () => alphaRenderer._createAlphaTexture(17),
    /exact 4x4 texture capacity/,
  );
  assert.strictEqual(
    alphaRenderer._alphaTexture,
    acceptedAlphaTexture,
  );
  assert.strictEqual(
    alphaRenderer._alphaTexData,
    acceptedAlphaData,
  );
  assert.equal(alphaRenderer._alphaTexWidth, 4);
  assert.equal(alphaRenderer._alphaTexHeight, 1);
  assert.equal(alphaRenderer._useAlphaTexture, true);
  assert.equal(
    gl._state.live.textures.has(acceptedAlphaTexture),
    true,
  );
  assert.equal(gl._state.deletes.textures.length, 0);

  const positions = makePositions(17);
  const colors = makeColors(17);
  const lodRenderer = createRendererState(gl, positions, colors);
  const spatialIndex = makeSpatialOwner(
    positions,
    Uint32Array.from(
      { length: 17 },
      (_value, index) => index,
    ),
  );
  const acceptedOwner = Object.freeze({ id: 'accepted-owner' });
  const acceptedBuffers = Object.freeze([
    Object.freeze({ id: 'accepted-buffer-view' }),
  ]);
  const acceptedTextures = Object.freeze([
    Object.freeze({ id: 'accepted-texture-view' }),
  ]);
  const acceptedOwnersMap = new Map([
    [DIMENSION, acceptedOwner],
  ]);
  const acceptedBuffersMap = new Map([
    [DIMENSION, acceptedBuffers],
  ]);
  const acceptedTexturesMap = new Map([
    [DIMENSION, acceptedTextures],
  ]);
  lodRenderer._lodResourceOwnersByDimension = acceptedOwnersMap;
  lodRenderer.lodBuffersByDimension = acceptedBuffersMap;
  lodRenderer._lodIndexTexturesByDimension =
    acceptedTexturesMap;
  const createCounts = {
    buffers: gl._state.creates.buffers.length,
    textures: gl._state.creates.textures.length,
    vertexArrays: gl._state.creates.vertexArrays.length,
  };

  assert.throws(
    () => lodRenderer._createLODResourcesForDimension(
      DIMENSION,
      spatialIndex,
    ),
    /exact 4x4 R32UI texture capacity/,
  );
  assert.strictEqual(
    lodRenderer._lodResourceOwnersByDimension,
    acceptedOwnersMap,
  );
  assert.strictEqual(
    lodRenderer.lodBuffersByDimension,
    acceptedBuffersMap,
  );
  assert.strictEqual(
    lodRenderer._lodIndexTexturesByDimension,
    acceptedTexturesMap,
  );
  assert.deepEqual(
    {
      buffers: gl._state.creates.buffers.length,
      textures: gl._state.creates.textures.length,
      vertexArrays: gl._state.creates.vertexArrays.length,
    },
    createCounts,
  );
});
