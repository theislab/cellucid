import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';

const MIB = 1024 * 1024;

function createHandle(kind, id) {
  return Object.freeze({ id, kind });
}

function createRenderer(overrides = {}) {
  return Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      gl: null,
      stats: { gpuMemoryMB: 0 },
      buffers: {
        interleaved: null,
        positions: null,
        colors: null,
        alphas: null,
      },
      pointCount: 0,
      _interleavedGpuByteLength: 0,
      _alphaTexture: null,
      _alphaTextureByteLength: 0,
      _alphaTexWidth: 0,
      _alphaTexHeight: 0,
      _dummyLodIndexTexture: null,
      _dummyLodIndexTextureByteLength: 0,
      _lodResourceOwnersByDimension: new Map(),
      _lodIndexTexturesByDimension: new Map(),
      lodBuffersByDimension: new Map(),
      spatialIndices: new Map(),
      snapshotBuffers: new Map(),
      _perViewState: new Map(),
      _pendingDataRetirements: new Set(),
      _pendingSnapshotRetirements: new Set(),
      _snapshotGeometryPools: new Map(),
      _validatedLodNodeMappings: new WeakMap(),
      _validatedSpatialIndices: new WeakSet(),
      _liveGeometryGeneration: 0,
      _nextGeometryGeneration: 1,
      ...overrides,
    },
  );
}

function assertGpuBytes(renderer, expected) {
  assert.ok(
    Math.abs(renderer.stats.gpuMemoryMB * MIB - expected) < 1e-9,
    `expected ${expected} exact known GPU bytes, received ${renderer.stats.gpuMemoryMB * MIB}`,
  );
}

test('GPU memory statistics include every active and pending known-byte owner exactly once', () => {
  const mainBuffer = createHandle('buffer', 'main');
  const alphaTexture = createHandle('texture', 'alpha');
  const dummyTexture = createHandle('texture', 'dummy-r32ui');
  const compactBuffer = createHandle('buffer', 'lod-compact');
  const lodIndexBuffer = createHandle('buffer', 'lod-indices');
  const lodIndexTexture = createHandle('texture', 'lod-index-texture');
  const activeSnapshotBuffer =
    createHandle('buffer', 'snapshot-active');
  const secondSnapshotBuffer =
    createHandle('buffer', 'snapshot-second');
  const sharedSnapshotPositionBuffer =
    createHandle('buffer', 'snapshot-position-shared');
  const pendingSnapshotBuffer =
    createHandle('buffer', 'snapshot-pending');
  const pendingSnapshotPositionBuffer =
    createHandle('buffer', 'snapshot-position-pending');
  const perViewBuffer = createHandle('buffer', 'view-ebo');
  const pendingDataBuffer =
    createHandle('buffer', 'pending-data-buffer');
  const pendingDataTexture =
    createHandle('texture', 'pending-data-texture');

  const renderer = createRenderer({
    buffers: {
      interleaved: mainBuffer,
      positions: null,
      colors: null,
      alphas: null,
    },
    pointCount: 5,
    _interleavedGpuByteLength: 80,
    _alphaTexture: alphaTexture,
    _alphaTextureByteLength: 5,
    _alphaTexWidth: 5,
    _alphaTexHeight: 1,
    _dummyLodIndexTexture: dummyTexture,
    _dummyLodIndexTextureByteLength: 4,
  });

  const generationToken = Object.freeze({});
  const lodOwner = {
    compactBuffer,
    compactByteLength: 64,
    compactVao: createHandle('vertex-array', 'lod-vao'),
    generationToken,
    gpuByteLength: 96,
    topologyOwner: {
      originalIndexBuffer: lodIndexBuffer,
      originalIndexByteLength: 16,
      indexTexture: lodIndexTexture,
      indexTextureByteLength: 16,
    },
  };
  renderer._lodResourceOwnersByDimension.set(2, lodOwner);
  // These draw projections alias the sole generation owner and must add no
  // bytes of their own.
  renderer.lodBuffersByDimension.set(2, [
    {
      buffer: compactBuffer,
      vao: lodOwner.compactVao,
      originalIndexBuffer: lodIndexBuffer,
      generationToken,
    },
  ]);
  renderer._lodIndexTexturesByDimension.set(2, [
    {
      texture: lodIndexTexture,
      generationToken,
    },
  ]);

  renderer.snapshotBuffers.set('snapshot-active', {
    id: 'snapshot-active',
    buffer: activeSnapshotBuffer,
    bufferByteLength: 20,
    pointCount: 5,
    geometryGeneration: 7,
  });
  renderer.snapshotBuffers.set('snapshot-second', {
    id: 'snapshot-second',
    buffer: secondSnapshotBuffer,
    bufferByteLength: 20,
    pointCount: 5,
    geometryGeneration: 7,
  });
  renderer._snapshotGeometryPools.set(7, {
    generation: 7,
    positions: new Float32Array(15),
    positionBuffer: sharedSnapshotPositionBuffer,
    positionBufferByteLength: 60,
    refCount: 2,
    spatialIndices: new Map(),
  });
  renderer._perViewState.set('snapshot-active', {
    indexBuffer: perViewBuffer,
    indexBufferByteLength: 12,
    indexBufferSize: 3,
    // A borrowed LOD EBO is an alias, not a second per-view allocation.
    preCachedIndexBuffer: lodIndexBuffer,
    usePreCachedIndexBuffer: true,
  });
  renderer._pendingSnapshotRetirements.add({
    id: 'snapshot-old',
    buffer: pendingSnapshotBuffer,
    bufferByteLength: 16,
    positionBuffer: pendingSnapshotPositionBuffer,
    positionBufferByteLength: 48,
    vao: null,
    geometryGeneration: null,
    positions: null,
  });
  renderer._pendingDataRetirements.add({
    buffers: [
      { handle: pendingDataBuffer, byteLength: 20 },
    ],
    textures: [
      { handle: pendingDataTexture, byteLength: 8 },
    ],
    vertexArrays: [],
  });

  renderer._refreshGpuMemoryStats();

  assertGpuBytes(
    renderer,
    80 + 5 + 4 + 96 + 20 + 20 + 60 + 12 + 16 + 48 + 20 + 8,
  );
});

test('failed per-view EBO replacement preserves its allocated byte owner while invalidating semantic draw state', () => {
  const NO_ERROR = 0;
  const INVALID_OPERATION = 0x0502;
  const indexBuffer = createHandle('buffer', 'view-ebo');
  let acceptedByteLength = 8;
  let errors = [NO_ERROR, INVALID_OPERATION];
  let rejectUpload = true;
  const gl = {
    NO_ERROR,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    DYNAMIC_DRAW: 0x88e8,
    bindVertexArray() {},
    bindBuffer() {},
    bufferData(_target, value) {
      if (!rejectUpload) {
        acceptedByteLength = value.byteLength;
      }
    },
    getError() {
      return errors.shift() ?? NO_ERROR;
    },
  };
  const viewState = {
    indexBuffer,
    indexBufferSize: 2,
    indexBufferByteLength: 8,
    cachedCulledCount: 2,
    cachedVisibleIndices: Uint32Array.from([4, 9]),
    cachedLodVisibleIndices: null,
    cachedLodLevel: -1,
    cachedLodDimension: 2,
    cachedLodIsCulled: false,
    cachedVisibleNodes: null,
    lastFrustumMVP: new Float32Array(16),
    lastLodLevel: -1,
    preCachedIndexBuffer: null,
    preCachedGenerationToken: null,
    preCachedSpatialOwner: null,
    usePreCachedIndexBuffer: false,
    stats: {},
  };
  const renderer = createRenderer({ gl });
  renderer._perViewState.set('view-a', viewState);

  assert.throws(
    () => renderer._uploadToViewIndexBuffer(
      viewState,
      Uint32Array.from([1, 2, 3]),
    ),
    /WebGL error/i,
  );
  assert.equal(acceptedByteLength, 8);
  assert.equal(
    viewState.indexBufferByteLength,
    8,
    'semantic invalidation must not erase still-live allocation size',
  );
  renderer._refreshGpuMemoryStats();
  assertGpuBytes(renderer, 8);

  rejectUpload = false;
  errors = [NO_ERROR, NO_ERROR];
  renderer._uploadToViewIndexBuffer(
    viewState,
    Uint32Array.from([3, 4, 5]),
  );
  assert.equal(acceptedByteLength, 12);
  assert.equal(viewState.indexBufferByteLength, 12);
  assertGpuBytes(renderer, 12);
});

test('pending snapshot VBO bytes survive pre-delete failure and settle after delete-then-throw liveness proof', () => {
  const buffer = createHandle('buffer', 'snapshot-retired');
  const liveBuffers = new Set([buffer]);
  const attempts = [];
  let behavior = 'before';
  const gl = {
    deleteBuffer(handle) {
      attempts.push(handle);
      if (behavior === 'before') {
        throw new Error('synthetic pre-delete failure');
      }
      liveBuffers.delete(handle);
      if (behavior === 'after') {
        throw new Error('synthetic post-delete failure');
      }
    },
    deleteVertexArray() {},
    isBuffer(handle) {
      return liveBuffers.has(handle);
    },
    isVertexArray() {
      return false;
    },
  };
  const renderer = createRenderer({ gl });

  const retirement = renderer._queueSnapshotRetirement(
    {
      id: 'snapshot-retired',
      buffer,
      bufferByteLength: 64,
      pointCount: 4,
      vao: null,
    },
    false,
  );
  assert.equal(retirement.bufferByteLength, 64);
  assertGpuBytes(renderer, 64);

  const firstFailures = renderer._drainSnapshotRetirements();
  assert.equal(firstFailures.length, 1);
  assert.equal(renderer._pendingSnapshotRetirements.size, 1);
  assertGpuBytes(renderer, 64);

  behavior = 'after';
  const secondFailures = renderer._drainSnapshotRetirements();
  assert.deepEqual(secondFailures, []);
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  assertGpuBytes(renderer, 0);

  renderer._drainSnapshotRetirements();
  assert.equal(
    attempts.filter(handle => handle === buffer).length,
    2,
    'a liveness-settled delete-then-throw handle must not be retried',
  );
});

test('clearAllViewState detaches first, attempts every EBO, and retry-accounts only live failures', () => {
  const buffers = [
    createHandle('buffer', 'view-a'),
    createHandle('buffer', 'view-b'),
    createHandle('buffer', 'view-c'),
  ];
  const liveBuffers = new Set(buffers);
  const attempts = [];
  const failures = new Map([
    [buffers[0], 'after'],
    [buffers[1], 'before'],
  ]);
  const gl = {
    deleteBuffer(handle) {
      attempts.push(handle);
      const behavior = failures.get(handle) ?? null;
      if (behavior === 'before') {
        throw new Error(`synthetic pre-delete failure for ${handle.id}`);
      }
      liveBuffers.delete(handle);
      if (behavior === 'after') {
        throw new Error(`synthetic post-delete failure for ${handle.id}`);
      }
    },
    deleteTexture() {},
    deleteVertexArray() {},
    isBuffer(handle) {
      return liveBuffers.has(handle);
    },
    isTexture() {
      return false;
    },
    isVertexArray() {
      return false;
    },
  };
  const renderer = createRenderer({ gl });
  const byteLengths = [8, 12, 16];
  for (let index = 0; index < buffers.length; index++) {
    renderer._perViewState.set(`view-${index}`, {
      indexBuffer: buffers[index],
      indexBufferByteLength: byteLengths[index],
      indexBufferSize: byteLengths[index] / 4,
    });
  }

  assert.throws(
    () => renderer.clearAllViewState(),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 1
    ),
  );
  assert.deepEqual(attempts, buffers);
  assert.equal(
    renderer._perViewState.size,
    0,
    'fallible cleanup must not leave detached view state active',
  );
  assert.equal(liveBuffers.has(buffers[0]), false);
  assert.equal(liveBuffers.has(buffers[1]), true);
  assert.equal(liveBuffers.has(buffers[2]), false);
  assertGpuBytes(renderer, 12);

  failures.delete(buffers[1]);
  assert.doesNotThrow(() => renderer.clearAllViewState());
  assert.equal(liveBuffers.size, 0);
  assertGpuBytes(renderer, 0);
  assert.equal(
    attempts.filter(handle => handle === buffers[0]).length,
    1,
  );
  assert.equal(
    attempts.filter(handle => handle === buffers[1]).length,
    2,
  );
  assert.equal(
    attempts.filter(handle => handle === buffers[2]).length,
    1,
  );
});

test('dummy texture disposal settles delete-then-throw without retaining or double-deleting its four bytes', () => {
  const dummyTexture = createHandle('texture', 'dummy-r32ui');
  const liveTextures = new Set([dummyTexture]);
  const attempts = [];
  const gl = {
    deleteBuffer() {},
    deleteProgram() {},
    deleteTexture(handle) {
      attempts.push(handle);
      liveTextures.delete(handle);
      throw new Error('synthetic post-delete texture failure');
    },
    deleteVertexArray() {},
    isBuffer() {
      return false;
    },
    isTexture(handle) {
      return liveTextures.has(handle);
    },
    isVertexArray() {
      return false;
    },
  };
  const renderer = createRenderer({
    gl,
    _dummyLodIndexTexture: dummyTexture,
    _dummyLodIndexTextureByteLength: 4,
    indexBuffer: null,
    programs: {
      full: null,
      light: null,
      ultralight: null,
    },
    activeProgram: null,
    uniformLocations: new Map(),
    vao: null,
    _positions: null,
    _colors: null,
    _firstRenderDone: false,
    _boundingSphere: null,
    _bufferDirty: false,
    _dirtyLodDimensions: new Set(),
    _interleavedArrayBuffer: null,
    _interleavedPositionView: null,
    _interleavedColorView: null,
    _lodArrayBuffers: null,
    _alphaTexData: null,
    _useAlphaTexture: false,
    _currentAlphas: null,
  });

  renderer._refreshGpuMemoryStats();
  assertGpuBytes(renderer, 4);
  assert.doesNotThrow(() => renderer.dispose());
  assert.equal(renderer._dummyLodIndexTexture, null);
  assertGpuBytes(renderer, 0);

  assert.doesNotThrow(() => renderer.dispose());
  assert.equal(
    attempts.filter(handle => handle === dummyTexture).length,
    1,
  );
});
