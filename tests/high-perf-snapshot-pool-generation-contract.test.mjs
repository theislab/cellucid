import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighPerfRenderer,
  SpatialIndex,
} from '../assets/js/rendering/high-perf-renderer.js';

function createPoolFixture() {
  const positions = Float32Array.from([
    -1, -1, 0,
    1, -1, 0,
    -1, 1, 0,
    1, 1, 0,
  ]);
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _liveGeometryGeneration: 1,
      _nextGeometryGeneration: 8,
      _snapshotGeometryPools: new Map([
        [7, {
          generation: 7,
          positions,
          refCount: 2,
          spatialIndices: new Map(),
        }],
      ]),
    },
  );
  return { positions, renderer };
}

function createPromotableSpatialOwner(
  positions,
  {
    failFirstPromotion = false,
  } = {},
) {
  let promotionAttempts = 0;
  const reducedIndices = Uint32Array.from([2, 0]);
  const spatialIndex = {
    dimensionLevel: 2,
    lodLevels: [],
    positions,
    ensureLODLevels() {
      promotionAttempts += 1;
      if (failFirstPromotion && promotionAttempts === 1) {
        throw new Error('synthetic LOD promotion failure');
      }
      this.lodLevels = [{
        depth: 0,
        indices: reducedIndices,
        isFullDetail: false,
        pointCount: reducedIndices.length,
        sizeMultiplier: 1.5,
      }];
    },
  };
  return {
    get promotionAttempts() {
      return promotionAttempts;
    },
    spatialIndex,
  };
}

test('one snapshot geometry/dimension owner promotes tree to LOD in place', () => {
  const { positions, renderer } = createPoolFixture();
  const promotable = createPromotableSpatialOwner(positions);
  const treeRootIdentity = {};
  promotable.spatialIndex.root = treeRootIdentity;

  renderer._publishPooledSnapshotSpatialIndex(
    7,
    positions,
    2,
    false,
    promotable.spatialIndex,
  );

  const promoted = renderer._getPooledSnapshotSpatialIndex(
    7,
    positions,
    2,
    true,
  );
  const geometry = renderer._snapshotGeometryPools.get(7);

  assert.strictEqual(promoted, promotable.spatialIndex);
  assert.strictEqual(promoted.root, treeRootIdentity);
  assert.equal(promotable.promotionAttempts, 1);
  assert.equal(promoted.lodLevels.length, 1);
  assert.equal(geometry.spatialIndices.size, 1);
  assert.strictEqual(
    renderer._getPooledSnapshotSpatialIndex(
      7,
      positions,
      2,
      false,
    ),
    promoted,
  );
  assert.strictEqual(
    renderer._getPooledSnapshotSpatialIndex(
      7,
      positions,
      2,
      true,
    ),
    promoted,
  );
  assert.equal(promotable.promotionAttempts, 1);
});

test('failed snapshot LOD promotion preserves and retries the same tree owner', () => {
  const { positions, renderer } = createPoolFixture();
  const promotable = createPromotableSpatialOwner(
    positions,
    { failFirstPromotion: true },
  );
  renderer._publishPooledSnapshotSpatialIndex(
    7,
    positions,
    2,
    false,
    promotable.spatialIndex,
  );

  assert.throws(
    () => renderer._getPooledSnapshotSpatialIndex(
      7,
      positions,
      2,
      true,
    ),
    /synthetic LOD promotion failure/,
  );
  const geometry = renderer._snapshotGeometryPools.get(7);
  assert.equal(geometry.spatialIndices.size, 1);
  assert.strictEqual(
    renderer._getPooledSnapshotSpatialIndex(
      7,
      positions,
      2,
      false,
    ),
    promotable.spatialIndex,
  );
  assert.deepEqual(promotable.spatialIndex.lodLevels, []);

  assert.strictEqual(
    renderer._getPooledSnapshotSpatialIndex(
      7,
      positions,
      2,
      true,
    ),
    promotable.spatialIndex,
  );
  assert.equal(promotable.promotionAttempts, 2);
  assert.equal(geometry.spatialIndices.size, 1);
});

test('geometry-only SpatialIndex accepts null colors only without node stats', () => {
  const positions = Float32Array.from([
    -1, 0, 0,
    1, 0, 0,
  ]);
  const sourceColors = Uint8Array.from([
    255, 0, 0, 255,
    0, 0, 255, 127,
  ]);
  const normalSpatialIndex = new SpatialIndex(
    positions,
    sourceColors,
    2,
    1,
    2,
    {
      buildLOD: false,
      buildLodNodeMappings: false,
      computeNodeStats: false,
    },
  );
  assert.strictEqual(
    normalSpatialIndex.colors,
    sourceColors,
    'the ordinary public SpatialIndex ABI retains provided source colors',
  );

  const spatialIndex = new SpatialIndex(
    positions,
    null,
    2,
    1,
    2,
    {
      buildLOD: true,
      buildLodNodeMappings: false,
      computeNodeStats: false,
    },
  );

  assert.equal(spatialIndex.colors, null);
  assert.equal(
    spatialIndex.lodLevels.at(-1).isFullDetail,
    true,
  );
  assert.equal(spatialIndex.lodLevels.at(-1).colors, null);

  assert.throws(
    () => new SpatialIndex(
      positions,
      null,
      2,
      1,
      2,
      {
        buildLOD: false,
        buildLodNodeMappings: false,
        computeNodeStats: true,
      },
    ),
    /colors/,
  );
});

function cloneUpload(data) {
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (ArrayBuffer.isView(data)) return new data.constructor(data);
  return data;
}

function createRenderTrackingGl() {
  let nextId = 1;
  let boundArrayBuffer = null;
  let boundElementBuffer = null;
  let boundTexture = null;
  const live = {
    buffers: new Set(),
    textures: new Set(),
    vertexArrays: new Set(),
  };
  const uploads = [];
  const draws = [];

  const makeHandle = kind => {
    const handle = Object.freeze({ id: `${kind}-${nextId++}`, kind });
    if (kind === 'buffer') live.buffers.add(handle);
    if (kind === 'texture') live.textures.add(handle);
    if (kind === 'vao') live.vertexArrays.add(handle);
    return handle;
  };

  const gl = {
    ARRAY_BUFFER: 0x8892,
    CLAMP_TO_EDGE: 0x812f,
    DYNAMIC_DRAW: 0x88e8,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    FLOAT: 0x1406,
    MAX_TEXTURE_SIZE: 0x0d33,
    NEAREST: 0x2600,
    NO_ERROR: 0,
    POINTS: 0,
    R32UI: 0x8236,
    RED_INTEGER: 0x8d94,
    STATIC_DRAW: 0x88e4,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    UNSIGNED_BYTE: 0x1401,
    UNSIGNED_INT: 0x1405,

    activeTexture() {},
    bindBuffer(target, buffer) {
      if (target === this.ARRAY_BUFFER) boundArrayBuffer = buffer;
      if (target === this.ELEMENT_ARRAY_BUFFER) {
        boundElementBuffer = buffer;
      }
    },
    bindTexture(target, texture) {
      assert.equal(target, this.TEXTURE_2D);
      boundTexture = texture;
    },
    bindVertexArray() {},
    bufferData(target, data, usage) {
      uploads.push({
        buffer: target === this.ARRAY_BUFFER
          ? boundArrayBuffer
          : boundElementBuffer,
        data: cloneUpload(data),
        target,
        usage,
      });
    },
    createBuffer() {
      return makeHandle('buffer');
    },
    createTexture() {
      return makeHandle('texture');
    },
    createVertexArray() {
      return makeHandle('vao');
    },
    deleteBuffer(buffer) {
      live.buffers.delete(buffer);
    },
    deleteTexture(texture) {
      live.textures.delete(texture);
    },
    deleteVertexArray(vertexArray) {
      live.vertexArrays.delete(vertexArray);
    },
    drawElements(mode, count, type, offset) {
      draws.push({
        buffer: boundElementBuffer,
        count,
        mode,
        offset,
        type,
      });
    },
    enableVertexAttribArray() {},
    getError() {
      return this.NO_ERROR;
    },
    getParameter(parameter) {
      assert.equal(parameter, this.MAX_TEXTURE_SIZE);
      return 4096;
    },
    isBuffer(buffer) {
      return live.buffers.has(buffer);
    },
    isTexture(texture) {
      return live.textures.has(texture);
    },
    isVertexArray(vertexArray) {
      return live.vertexArrays.has(vertexArray);
    },
    texImage2D(
      target,
      _level,
      _internalFormat,
      _width,
      _height,
      _border,
      _format,
      _type,
      data,
    ) {
      uploads.push({
        data: cloneUpload(data),
        target,
        texture: boundTexture,
      });
    },
    texSubImage2D(
      target,
      _level,
      xOffset,
      yOffset,
      width,
      height,
      _format,
      _type,
      data,
    ) {
      uploads.push({
        data: cloneUpload(data),
        height,
        target,
        texture: boundTexture,
        width,
        xOffset,
        yOffset,
      });
    },
    texParameteri() {},
    uniform1f() {},
    uniform1i() {},
    uniform3fv() {},
    uniformMatrix4fv() {},
    useProgram() {},
    vertexAttribPointer() {},

    _state: {
      draws,
      live,
      uploads,
    },
  };
  return gl;
}

function createReducedSpatialIndex(positions, colors) {
  const indices = Uint32Array.from([4, 1, 5, 0]);
  return {
    colors,
    dimensionLevel: 2,
    lodLevels: [
      {
        depth: 0,
        indices,
        isFullDetail: false,
        pointCount: indices.length,
        sizeMultiplier: 1.25,
      },
      {
        colors,
        depth: 1,
        isFullDetail: true,
        pointCount: positions.length / 3,
        positions,
      },
    ],
    pointCount: positions.length / 3,
    positions,
  };
}

function nullUniforms() {
  return {
    u_alphaTex: null,
    u_alphaTexWidth: null,
    u_fogColor: null,
    u_fogDensity: null,
    u_fogFar: null,
    u_fogNear: null,
    u_fov: null,
    u_invAlphaTexWidth: null,
    u_invLodIndexTexWidth: null,
    u_lightDir: null,
    u_lightingStrength: null,
    u_lodIndexTex: null,
    u_lodIndexTexWidth: null,
    u_modelMatrix: null,
    u_mvpMatrix: null,
    u_pointSize: null,
    u_projectionMatrix: null,
    u_sizeAttenuation: null,
    u_useAlphaTex: null,
    u_useLodIndexTex: null,
    u_viewMatrix: null,
    u_viewportHeight: null,
  };
}

function createGpuFixture() {
  const gl = createRenderTrackingGl();
  const positions = new Float32Array(18);
  const colors = new Uint8Array(24);
  for (let index = 0; index < 6; index++) {
    positions[index * 3] = index;
    positions[index * 3 + 1] = -index;
    positions[index * 3 + 2] = index * 0.5;
    colors[index * 4] = 10 + index;
    colors[index * 4 + 1] = 20 + index;
    colors[index * 4 + 2] = 30 + index;
    colors[index * 4 + 3] = 255;
  }
  const mainBuffer = gl.createBuffer();
  const mainVao = gl.createVertexArray();
  const spatialIndex = createReducedSpatialIndex(
    positions,
    colors,
  );
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _alphaTexHeight: 0,
      _alphaTexWidth: 0,
      _alphaTexture: null,
      _colors: colors,
      _dirtyLodDimensions: new Set(),
      _lodArrayBuffers: null,
      _lodIndexTexturesByDimension: new Map(),
      _pendingDataRetirements: new Set(),
      _pendingSnapshotRetirements: new Set(),
      _positions: positions,
      _useAlphaTexture: false,
      activeProgram: {},
      activeQuality: 'full',
      buffers: {
        alphas: null,
        colors: null,
        interleaved: mainBuffer,
        positions: null,
      },
      gl,
      lodBuffersByDimension: new Map(),
      pointCount: 6,
      spatialIndices: new Map([[2, spatialIndex]]),
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
      uniformLocations: new Map([['full', nullUniforms()]]),
      vao: mainVao,
    },
  );
  return {
    colors,
    gl,
    positions,
    renderer,
    spatialIndex,
  };
}

function createViewState(gl) {
  return {
    cachedCulledCount: 0,
    cachedLodDimension: -1,
    cachedLodIsCulled: false,
    cachedLodLevel: -1,
    indexBuffer: gl.createBuffer(),
    indexBufferSize: 0,
    preCachedIndexBuffer: null,
    stats: {
      cullPercent: 0,
      drawCalls: 0,
      fps: 0,
      frustumCulled: false,
      lastFrameTime: 0,
      lodLevel: -1,
      visiblePoints: 0,
    },
    statsPublished: false,
    usePreCachedIndexBuffer: false,
  };
}

function renderParams(viewId) {
  return {
    dimensionLevel: 2,
    fogColor: new Float32Array(3),
    fogDensity: 0,
    fov: 1,
    lightDir: new Float32Array([0, 0, 1]),
    lightingStrength: 0,
    modelMatrix: new Float32Array(16),
    mvpMatrix: new Float32Array(16),
    pointSize: 1,
    projectionMatrix: new Float32Array(16),
    sizeAttenuation: 0,
    viewId,
    viewMatrix: new Float32Array(16),
    viewportHeight: 100,
  };
}

function publishDimensionPrefix(renderer, spatialIndex) {
  assert.equal(
    typeof renderer._createLODResourcesForDimension,
    'function',
    'the dimension prefix must have one atomic publication seam',
  );
  renderer._createLODResourcesForDimension(2, spatialIndex);
  return renderer.lodBuffersByDimension.get(2);
}

test('same-level multiview refreshes a replaced borrowed EBO without upload', () => {
  const fixture = createGpuFixture();
  const firstMetadata = publishDimensionPrefix(
    fixture.renderer,
    fixture.spatialIndex,
  );
  const firstBorrowedEbo = firstMetadata[0].originalIndexBuffer;
  const first = createViewState(fixture.gl);
  const second = createViewState(fixture.gl);
  const snapshot = { vao: fixture.gl.createVertexArray() };

  fixture.renderer._renderSnapshotWithLOD(
    snapshot,
    0,
    renderParams('snap-a'),
    first,
    false,
    fixture.spatialIndex,
    firstMetadata,
  );
  fixture.renderer._renderSnapshotWithLOD(
    snapshot,
    0,
    renderParams('snap-b'),
    second,
    false,
    fixture.spatialIndex,
    firstMetadata,
  );
  assert.strictEqual(first.preCachedIndexBuffer, firstBorrowedEbo);
  assert.strictEqual(second.preCachedIndexBuffer, firstBorrowedEbo);

  const secondMetadata = publishDimensionPrefix(
    fixture.renderer,
    fixture.spatialIndex,
  );
  const secondBorrowedEbo = secondMetadata[0].originalIndexBuffer;
  assert.notStrictEqual(secondBorrowedEbo, firstBorrowedEbo);
  fixture.gl._state.draws.length = 0;
  fixture.gl._state.uploads.length = 0;

  fixture.renderer._renderSnapshotWithLOD(
    snapshot,
    0,
    renderParams('snap-a'),
    first,
    false,
    fixture.spatialIndex,
    secondMetadata,
  );
  fixture.renderer._renderSnapshotWithLOD(
    snapshot,
    0,
    renderParams('snap-b'),
    second,
    false,
    fixture.spatialIndex,
    secondMetadata,
  );

  assert.deepEqual(
    fixture.gl._state.draws.map(draw => draw.buffer),
    [secondBorrowedEbo, secondBorrowedEbo],
  );
  assert.strictEqual(first.preCachedIndexBuffer, secondBorrowedEbo);
  assert.strictEqual(second.preCachedIndexBuffer, secondBorrowedEbo);
  assert.equal(
    fixture.gl._state.uploads.filter(
      upload => upload.target === fixture.gl.ELEMENT_ARRAY_BUFFER,
    ).length,
    0,
    'refreshing a valid borrowed prefix must not upload per view',
  );
});

test('same-level custom snapshot replaces a borrowed EBO with a per-view upload', () => {
  const fixture = createGpuFixture();
  const mainMetadata = publishDimensionPrefix(
    fixture.renderer,
    fixture.spatialIndex,
  );
  const borrowedEbo = mainMetadata[0].originalIndexBuffer;
  const customPositions = fixture.positions.slice();
  customPositions[0] += 10;
  const customSpatialIndex = createReducedSpatialIndex(
    customPositions,
    fixture.colors,
  );
  const viewState = createViewState(fixture.gl);
  const snapshot = { vao: fixture.gl.createVertexArray() };

  fixture.renderer._renderSnapshotWithLOD(
    snapshot,
    0,
    renderParams('custom-snapshot'),
    viewState,
    false,
    fixture.spatialIndex,
    mainMetadata,
  );
  assert.equal(viewState.usePreCachedIndexBuffer, true);
  assert.strictEqual(viewState.preCachedIndexBuffer, borrowedEbo);

  fixture.gl._state.draws.length = 0;
  fixture.gl._state.uploads.length = 0;

  fixture.renderer._renderSnapshotWithLOD(
    snapshot,
    0,
    renderParams('custom-snapshot'),
    viewState,
    false,
    customSpatialIndex,
    mainMetadata,
  );

  const elementUploads = fixture.gl._state.uploads.filter(
    upload => upload.target === fixture.gl.ELEMENT_ARRAY_BUFFER,
  );
  assert.equal(elementUploads.length, 1);
  assert.deepEqual(
    Array.from(elementUploads[0].data),
    Array.from(customSpatialIndex.lodLevels[0].indices),
  );
  assert.equal(fixture.gl._state.draws.length, 1);
  assert.strictEqual(
    fixture.gl._state.draws[0].buffer,
    viewState.indexBuffer,
  );
  assert.notStrictEqual(
    fixture.gl._state.draws[0].buffer,
    borrowedEbo,
  );
  assert.equal(viewState.usePreCachedIndexBuffer, false);
  assert.equal(viewState.preCachedIndexBuffer, null);
});
