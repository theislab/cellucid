import { DEFAULT_CELL_PRIORITY } from '../assets/js/data/cell-priority.js';
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
import { createCpuPermuter } from './helpers/cpu-permuter.mjs';
import { planLinearTexture } from '../assets/js/rendering/linear-texture.js';

const DIMENSION = 2;

// A 2D embedding: DIMENSION components per point.
function makePositions(pointCount, offset = 0) {
  const positions = new Float32Array(pointCount * DIMENSION);
  for (let index = 0; index < pointCount; index++) {
    const positionOffset = index * DIMENSION;
    positions[positionOffset] = offset + index / Math.max(pointCount, 1);
    positions[positionOffset + 1] =
      offset + ((index * 7) % Math.max(pointCount, 1)) /
        Math.max(pointCount, 1);
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

function createTrackingGl(maxTextureSize = 8192, maxArrayLayers = 256) {
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
  const copyBindings = new Map();

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
    COPY_READ_BUFFER: 0x8f36,
    COPY_WRITE_BUFFER: 0x8f37,
    DEPTH_TEST: 0x0b71,
    DYNAMIC_DRAW: 0x88e8,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    FLOAT: 0x1406,
    FUNC_ADD: 0x8006,
    MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
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
    TEXTURE_2D_ARRAY: 0x8c1a,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    UNSIGNED_BYTE: 0x1401,
    UNSIGNED_INT: 0x1405,

    bindBuffer(target, handle) {
      if (target === this.ARRAY_BUFFER) {
        boundArrayBuffer = handle;
      } else if (target === this.COPY_READ_BUFFER || target === this.COPY_WRITE_BUFFER) {
        copyBindings.set(target, handle);
      } else {
        assert.equal(target, this.ELEMENT_ARRAY_BUFFER);
        boundElementBuffer = handle;
      }
    },
    copyBufferSubData(readTarget, writeTarget, readOffset, writeOffset, size) {
      uploads.push({
        byteLength: size,
        from: copyBindings.get(readTarget),
        kind: 'copy',
        to: copyBindings.get(writeTarget),
      });
    },
    bindTexture(target, handle) {
      assert.ok(target === this.TEXTURE_2D || target === this.TEXTURE_2D_ARRAY);
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
        byteLength: typeof data === 'number' ? data : data.byteLength,
        kind: 'buffer',
        target,
        usage,
      });
    },
    bufferSubData() {},
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
      if (parameter === this.MAX_ARRAY_TEXTURE_LAYERS) return maxArrayLayers;
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
    texStorage2D(target, levels, internalFormat, width, height) {
      assert.equal(target, this.TEXTURE_2D);
      assert.notEqual(boundTexture, null);
      uploads.push({
        byteLength: 0,
        data: null,
        height,
        internalFormat,
        kind: 'texture',
        level: 0,
        levels,
        texture: boundTexture,
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
    texStorage3D(target, levels, internalFormat, width, height, depth) {
      assert.equal(target, this.TEXTURE_2D_ARRAY);
      assert.notEqual(boundTexture, null);
      uploads.push({
        byteLength: 0,
        data: null,
        depth,
        height,
        internalFormat,
        kind: 'texture',
        level: 0,
        levels,
        texture: boundTexture,
        width,
      });
    },
    texSubImage3D(
      target,
      level,
      xOffset,
      yOffset,
      zOffset,
      width,
      height,
      depth,
      format,
      type,
      data,
      srcOffset = 0,
    ) {
      assert.equal(target, this.TEXTURE_2D_ARRAY);
      assert.notEqual(boundTexture, null);
      assert.ok(ArrayBuffer.isView(data));
      const view = data.subarray(srcOffset, srcOffset + width * height * depth);
      uploads.push({
        byteLength: view.byteLength,
        data: new data.constructor(view),
        format,
        height,
        kind: 'texture-subimage',
        level,
        texture: boundTexture,
        type,
        width,
        xOffset,
        yOffset,
        zOffset,
      });
    },
    texParameteri() {},
    uniform2i() {},
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
    _setMaxArrayLayers(value) {
      maxArrayLayers = value;
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
  const mainPositionBuffer = gl._adoptBuffer('main-position-buffer');
  const mainColorBuffer = gl._adoptBuffer('main-color-buffer');
  const mainVao = gl._adoptVertexArray('main-vao');
  return Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _cellPriority: DEFAULT_CELL_PRIORITY,
      _alphaTexHeight: 0,
      _alphaTexWidth: 0,
      _alphaTexture: null,
      _permuter: createCpuPermuter(gl),
      _colorsDirty: false,
      _colors: colors,
      _colorGpuByteLength: colors.byteLength,
      _currentAlphas: null,
      _liveOrder: null,
      _liveColorOrder: null,
      _dummyLodIndexTexture:
        gl._adoptTexture('dummy-lod-index-texture'),
      _dummyLodIndexTextureByteLength:
        Uint32Array.BYTES_PER_ELEMENT,
      _firstRenderDone: true,
      _liveGeometryGeneration: liveGeometryGeneration,
      _nextGeometryGeneration: liveGeometryGeneration + 1,
      _pendingDataRetirements: new Set(),
      _pendingSnapshotRetirements: new Set(),
      _perViewState: new Map(),
      _positions: positions,
      _snapshotGeometryPools: new Map(),
      _useAlphaTexture: false,
      _validatedSpatialIndices: new WeakSet(),
      activeProgram: Object.freeze({ id: 'program' }),
      activeQuality: 'full',
      programs: { full: Object.freeze({ id: 'program' }) },
      buffers: {
        colors: mainColorBuffer,
        positions: mainPositionBuffer,
      },
      currentDimensionLevel: DIMENSION,
      forceLODLevel: -1,
      gl,
      options: {
        ...RendererConfig,
        USE_FRUSTUM_CULLING: false,
        USE_LOD: false,
      },
      pointCount: positions.length / DIMENSION,
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
  let draw = null;
  renderer._getViewState = () => viewState;
  renderer._drawPoints = request => {
    draw = request;
  };
  renderer._publishFrameTiming = () => {};
  renderer.getStats = () => ({ renderedLevel: draw?.lodLevel ?? null });

  const result = renderer.render(renderParams('live', 0));
  const spatialIndex = renderer.spatialIndices.get(DIMENSION);

  assert.equal(renderer.useAdaptiveLOD, false);
  assert.equal(renderer.options.USE_LOD, false);
  assert.ok(spatialIndex instanceof SpatialIndex);
  // Four cells are below the first level: one level, every cell.
  assert.equal(spatialIndex.lodLevels.length, 1);
  assert.strictEqual(spatialIndex.positions, positions);
  // The live store adopted the new tree's banded draw order before the draw.
  assert.strictEqual(renderer._liveOrder.drawOrder, spatialIndex.drawOrder);
  assert.equal(spatialIndex.drawOrder.bandCount, spatialIndex.lodLevels.length);
  assert.strictEqual(draw.tree, spatialIndex);
  assert.strictEqual(draw.order, renderer._liveOrder);
  assert.equal(draw.lodLevel, 0);
  assert.deepEqual(result, { renderedLevel: 0 });
});

test('explicit snapshot forceLOD replaces a frustum-only pooled tree with one carrying LOD levels', t => {
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
    { buildLOD: false },
  );
  const geometryGeneration = 9;
  // The published transparency, kept by reference: four shown cells.
  const alphas = new Uint8Array(4).fill(1);
  const snapshotBuffer =
    gl._adoptBuffer('snapshot-buffer');
  const snapshot = {
    alphas,
    alphaTexHeight: 1,
    alphaTexWidth: 4,
    alphaTexture:
      gl._adoptTexture('snapshot-alpha-texture'),
    alphaTexPlan: planLinearTexture(alphas.length, 16384, 256),
    alphaTextureByteLength: alphas.length,
    bounds: HighPerfRenderer.computeBoundsFromPositions(
      snapshotPositions,
      DIMENSION,
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
  // The geometry already holds the tree's order (adoption is pinned elsewhere).
  renderer._ensureSnapshotDrawOrder = (_snapshot, tree) => (
    tree === null ? null : { drawOrder: tree.ensureDrawOrder() }
  );
  renderer._ensureSnapshotColorsInOrder = () => {};
  renderer._drawPoints = request => {
    draw = {
      exactSnapshot: renderer.snapshotBuffers.get(request.params.viewId),
      exactSpatialIndex: request.tree,
      lodLevel: request.lodLevel,
      vao: request.vao,
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
  // The tree with levels was built as one job (inline here: no worker) and
  // replaced the frustum-only one in the geometry's pool.
  const promoted = snapshot.spatialIndex;
  assert.notStrictEqual(promoted, spatialIndex);
  assert.strictEqual(promoted.positions, snapshotPositions);
  assert.strictEqual(
    renderer._snapshotGeometryPools
      .get(geometryGeneration)
      .spatialIndices
      .get(DIMENSION),
    promoted,
  );
  assert.equal(promoted.lodLevels.length, 1);
  assert.equal(spatialIndex.lodLevels.length, 0, 'the old tree is not promoted in place');
  assert.strictEqual(draw.exactSnapshot, snapshot);
  assert.strictEqual(draw.vao, snapshot.vao);
  assert.strictEqual(draw.exactSpatialIndex, promoted);
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
  // Three points in a linear texture of one row, exactly three texels wide.
  const alphas = new Uint8Array(3).fill(1);
  const snapshotBuffer =
    gl._adoptBuffer('unindexed-snapshot-buffer');
  const snapshot = {
    alphas,
    alphaTexHeight: 1,
    alphaTexWidth: 3,
    alphaTexture:
      gl._adoptTexture('unindexed-snapshot-alpha-texture'),
    alphaTexPlan: planLinearTexture(3, 16384, 256),
    alphaTextureByteLength: alphas.length,
    bounds: HighPerfRenderer.computeBoundsFromPositions(
      snapshotPositions,
      DIMENSION,
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
  // The geometry already holds the tree's order (adoption is pinned elsewhere).
  renderer._ensureSnapshotDrawOrder = (_snapshot, tree) => (
    tree === null ? null : { drawOrder: tree.ensureDrawOrder() }
  );
  renderer._ensureSnapshotColorsInOrder = () => {};
  renderer._drawPoints = request => {
    draw = { lodLevel: request.lodLevel, spatialIndex: request.tree };
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
  assert.equal(pooledSpatialIndex.lodLevels.length, 1);
  assert.strictEqual(draw.spatialIndex, pooledSpatialIndex);
  assert.equal(draw.lodLevel, 0);
  assert.deepEqual(result, { lodLevel: 0 });
});

test('alpha and draw-order R32UI linear textures use the runtime width beyond 4096', () => {
  const pointCount = 4097;
  const gl = createTrackingGl(8192);

  const alphaRenderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _cellPriority: DEFAULT_CELL_PRIORITY,
      _alphaTexHeight: 0,
      _alphaTexWidth: 0,
      _alphaTexture: null,
      _useAlphaTexture: false,
      gl,
    },
  );
  alphaRenderer._createAlphaTexture(pointCount);

  const orderRenderer = createRendererState(
    gl,
    makePositions(pointCount),
    makeColors(pointCount),
  );
  const indices = Uint32Array.from(
    { length: pointCount },
    (_value, index) => pointCount - 1 - index,
  );
  const record = orderRenderer._createStoreOrder(
    Object.freeze({ indices, pointCount }),
    'test draw order',
  );

  const alphaUpload = gl._state.uploads.find(
    upload => upload.kind === 'texture' && upload.internalFormat === gl.R8,
  );
  const indexUpload = gl._state.uploads.find(
    upload => upload.kind === 'texture' && upload.internalFormat === gl.R32UI,
  );
  const indexRows = gl._state.uploads.filter(
    upload => upload.kind === 'texture-subimage' && upload.texture === record.texture,
  );

  // One row exactly as wide as the points (addressed with a 2^13 shift), in
  // one layer: the first upload covers the whole image.
  assert.equal(alphaRenderer._alphaTexWidth, pointCount);
  assert.equal(alphaRenderer._alphaTexHeight, 1);
  assert.deepEqual([alphaUpload.width, alphaUpload.height, alphaUpload.depth], [pointCount, 1, 1]);
  assert.deepEqual([indexUpload.width, indexUpload.height, indexUpload.depth], [pointCount, 1, 1]);
  assert.equal(record.plan.width, pointCount);
  assert.equal(record.plan.widthShift, 13);
  assert.equal(record.plan.layers, 1);
  assert.equal(record.byteLength, pointCount * 4);
  // Rows stream straight from the order: no padded host duplicate.
  assert.equal(indexRows.length, 1);
  assert.equal(indexRows[0].width, pointCount);
  assert.deepEqual(indexRows[0].data, indices);
});

test('invalid texture capabilities reject before allocation and preserve exact accepted publications', () => {
  for (const [invalidSize, invalidLayers] of [
    [0, 256], [-1, 256], [8192.5, 256], [Number.NaN, 256], [8192, 0], [8192, Number.NaN],
  ]) {
    const gl = createTrackingGl(invalidSize, invalidLayers);
    const label = `${String(invalidSize)}/${String(invalidLayers)}`;
    const acceptedAlphaTexture = gl._adoptTexture(`accepted-alpha-${label}`);
    const acceptedAlphaData = Uint8Array.from([255, 127]);
    const alphaRenderer = Object.assign(
      Object.create(HighPerfRenderer.prototype),
      {
        _cellPriority: DEFAULT_CELL_PRIORITY,
        _currentAlphas: acceptedAlphaData,
        _alphaTexHeight: 1,
        _alphaTexWidth: 2,
        _alphaTexture: acceptedAlphaTexture,
        _useAlphaTexture: true,
        gl,
      },
    );

    assert.throws(
      () => alphaRenderer._createAlphaTexture(3),
      /needs a positive MAX_(TEXTURE_SIZE|ARRAY_TEXTURE_LAYERS)/,
    );
    assert.strictEqual(alphaRenderer._alphaTexture, acceptedAlphaTexture);
    assert.strictEqual(alphaRenderer._currentAlphas, acceptedAlphaData);
    assert.equal(alphaRenderer._alphaTexWidth, 2);
    assert.equal(alphaRenderer._alphaTexHeight, 1);
    assert.equal(gl._state.creates.textures.length, 0);
    assert.equal(gl._state.deletes.textures.length, 0);

    const orderRenderer = createRendererState(gl, makePositions(3), makeColors(3));
    const acceptedOrder = Object.freeze({ id: `accepted-order-${label}` });
    orderRenderer._liveOrder = acceptedOrder;
    assert.throws(
      () => orderRenderer._createStoreOrder(
        Object.freeze({ indices: Uint32Array.from([2, 0, 1]), pointCount: 3 }),
        'test draw order',
      ),
      /needs a positive MAX_(TEXTURE_SIZE|ARRAY_TEXTURE_LAYERS)/,
    );
    assert.strictEqual(orderRenderer._liveOrder, acceptedOrder);
    assert.equal(gl._state.creates.buffers.length, 0);
    assert.equal(gl._state.creates.vertexArrays.length, 0);
    assert.equal(gl._state.creates.textures.length, 0);
  }
});

test('per-point textures hold more than MAX_TEXTURE_SIZE^2 points in layers', () => {
  // A 4x4 texture holds 16 texels; 17 points take a second layer instead of
  // being refused (Firefox reports 8192: 67.1M texels a layer).
  const gl = createTrackingGl(4, 256);
  const alphaRenderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _cellPriority: DEFAULT_CELL_PRIORITY,
      _alphaTexHeight: 0,
      _alphaTexWidth: 0,
      _alphaTexture: null,
      _useAlphaTexture: false,
      gl,
    },
  );
  alphaRenderer._createAlphaTexture(17);
  assert.equal(alphaRenderer._alphaTexPlan.layers, 2);
  assert.equal(alphaRenderer._alphaTexPlan.rowsPerLayer, 3);
  const orderRenderer = createRendererState(gl, makePositions(17), makeColors(17));
  const indices = Uint32Array.from({ length: 17 }, (_value, index) => 16 - index);
  const record = orderRenderer._createStoreOrder(
    Object.freeze({ indices, pointCount: 17 }),
    'test draw order',
  );
  assert.equal(record.plan.layers, 2);
  // Every index lands in its texel: the rows written cover the order exactly.
  const rows = gl._state.uploads.filter(
    upload => upload.kind === 'texture-subimage' && upload.texture === record.texture,
  );
  const written = new Uint32Array(17);
  for (const row of rows) {
    const first = (row.zOffset * 3 + row.yOffset) * 4 + row.xOffset;
    written.set(row.data, first);
  }
  assert.deepEqual(written, indices);
});

test('texture-capacity failures preserve accepted alpha and draw-order publications', () => {
  // 17 points need 2 layers of a 4x4 texture; this GPU allows 1.
  const gl = createTrackingGl(4, 1);
  const acceptedAlphaTexture =
    gl._adoptTexture('accepted-alpha');
  const acceptedAlphaData = Uint8Array.from([255, 127, 63, 31]);
  const alphaRenderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _cellPriority: DEFAULT_CELL_PRIORITY,
      _currentAlphas: acceptedAlphaData,
      _alphaTexHeight: 1,
      _alphaTexWidth: 4,
      _alphaTexture: acceptedAlphaTexture,
      _useAlphaTexture: true,
      gl,
    },
  );

  assert.throws(
    () => alphaRenderer._createAlphaTexture(17),
    /17 items need 2 texture layers; this GPU allows 1/,
  );
  assert.strictEqual(
    alphaRenderer._alphaTexture,
    acceptedAlphaTexture,
  );
  assert.strictEqual(
    alphaRenderer._currentAlphas,
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

  const orderRenderer = createRendererState(gl, makePositions(17), makeColors(17));
  const acceptedOrder = Object.freeze({ id: 'accepted-order' });
  orderRenderer._liveOrder = acceptedOrder;
  const createCounts = {
    buffers: gl._state.creates.buffers.length,
    textures: gl._state.creates.textures.length,
    vertexArrays: gl._state.creates.vertexArrays.length,
  };

  assert.throws(
    () => orderRenderer._createStoreOrder(
      Object.freeze({
        indices: Uint32Array.from({ length: 17 }, (_value, index) => index),
        pointCount: 17,
      }),
      'test draw order',
    ),
    /17 items need 2 texture layers; this GPU allows 1/,
  );
  assert.strictEqual(orderRenderer._liveOrder, acceptedOrder);
  assert.deepEqual(
    {
      buffers: gl._state.creates.buffers.length,
      textures: gl._state.creates.textures.length,
      vertexArrays: gl._state.creates.vertexArrays.length,
    },
    createCounts,
  );
});
