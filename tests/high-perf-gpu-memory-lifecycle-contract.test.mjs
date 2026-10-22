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
        positions: null,
        colors: null,
      },
      pointCount: 0,
      _positionGpuByteLength: 0,
      _colorGpuByteLength: 0,
      _alphaTexture: null,
      _alphaTextureByteLength: 0,
      _alphaTexWidth: 0,
      _alphaTexHeight: 0,
      _dummyLodIndexTexture: null,
      _dummyLodIndexTextureByteLength: 0,
      _liveOrder: null,
      spatialIndices: new Map(),
      snapshotBuffers: new Map(),
      _perViewState: new Map(),
      _pendingDataRetirements: new Set(),
      _pendingSnapshotRetirements: new Set(),
      _snapshotGeometryPools: new Map(),
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
  const mainPositionBuffer = createHandle('buffer', 'main-positions');
  const mainColorBuffer = createHandle('buffer', 'main-colors');
  const alphaTexture = createHandle('texture', 'alpha');
  const dummyTexture = createHandle('texture', 'dummy-r32ui');
  const liveOrderTexture = createHandle('texture', 'live-draw-order');
  const pooledOrderTexture = createHandle('texture', 'pooled-draw-order');
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
  const pendingDataBuffer =
    createHandle('buffer', 'pending-data-buffer');
  const pendingDataTexture =
    createHandle('texture', 'pending-data-texture');

  const renderer = createRenderer({
    buffers: {
      positions: mainPositionBuffer,
      colors: mainColorBuffer,
    },
    pointCount: 5,
    _positionGpuByteLength: 60,
    _colorGpuByteLength: 20,
    _alphaTexture: alphaTexture,
    _alphaTextureByteLength: 5,
    _alphaTexWidth: 5,
    _alphaTexHeight: 1,
    _dummyLodIndexTexture: dummyTexture,
    _dummyLodIndexTextureByteLength: 4,
    // The live store's draw-order permutation, 4 bytes a point.
    _liveOrder: { texture: liveOrderTexture, byteLength: 20, width: 5, height: 1 },
  });

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
  // One pooled geometry two views share: one position store and one
  // permutation texture, each counted once.
  renderer._snapshotGeometryPools.set(7, {
    generation: 7,
    positions: new Float32Array(15),
    positionBuffer: sharedSnapshotPositionBuffer,
    positionBufferByteLength: 60,
    order: { texture: pooledOrderTexture, byteLength: 20, width: 5, height: 1 },
    refCount: 2,
    spatialIndices: new Map(),
  });
  // Per-view state owns no GPU object and adds nothing.
  renderer._perViewState.set('snapshot-active', { cull: {} });
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
      // A retiring live permutation texture is still resident.
      { handle: pendingDataTexture, byteLength: 8 },
      // An alias of an active owner counts once.
      { handle: liveOrderTexture, byteLength: 20 },
    ],
    vertexArrays: [],
  });

  renderer._refreshGpuMemoryStats();

  assertGpuBytes(
    renderer,
    60 + 20 + 5 + 4 + 20 + 20 + 20 + 60 + 20 + 16 + 48 + 20 + 8,
  );
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
    _colorsDirty: false,
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
