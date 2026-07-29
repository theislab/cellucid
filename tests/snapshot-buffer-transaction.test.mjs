import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getNotificationCenter,
} from '../assets/js/app/notification-center.js';
import { HighPerfRenderer } from '../assets/js/rendering/high-perf-renderer.js';

function createFakeGl() {
  let nextId = 1;
  let arrayBufferBinding = null;
  let vertexArrayBinding = null;
  const buffers = new Set();
  const vertexArrays = new Set();
  const deletedBuffers = [];
  const deletedVertexArrays = [];
  const bufferDeleteAttempts = [];
  const vertexArrayDeleteAttempts = [];
  const bufferBytes = new Map();
  const vertexAttributes = new Map();
  let bufferCreateCount = 0;
  let vertexArrayCreateCount = 0;
  let vertexAttribPointerCount = 0;
  let uploadCount = 0;

  const gl = {
    NO_ERROR: 0,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88E4,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    failUpload: false,
    failUploadAt: -1,
    failBufferAllocationAt: -1,
    failVertexArrayAllocationAt: -1,
    failVertexAttribPointerAt: -1,
    failDeleteBuffer: false,
    failDeleteVertexArray: false,
    createBuffer() {
      bufferCreateCount++;
      if (bufferCreateCount === gl.failBufferAllocationAt) {
        return null;
      }
      const buffer = { kind: 'buffer', id: nextId++ };
      buffers.add(buffer);
      return buffer;
    },
    createVertexArray() {
      vertexArrayCreateCount++;
      if (
        vertexArrayCreateCount ===
        gl.failVertexArrayAllocationAt
      ) {
        return null;
      }
      const vertexArray = { kind: 'vertex-array', id: nextId++ };
      vertexArrays.add(vertexArray);
      vertexAttributes.set(vertexArray, new Map());
      return vertexArray;
    },
    bindBuffer(target, buffer) {
      assert.equal(target, gl.ARRAY_BUFFER);
      arrayBufferBinding = buffer;
    },
    bindVertexArray(vertexArray) {
      vertexArrayBinding = vertexArray;
    },
    bufferData(target, source) {
      assert.equal(target, gl.ARRAY_BUFFER);
      uploadCount++;
      if (gl.failUpload || uploadCount === gl.failUploadAt) {
        throw new Error('synthetic snapshot upload failure');
      }
      assert.ok(arrayBufferBinding);
      const bytes = source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(
            source.buffer,
            source.byteOffset,
            source.byteLength,
          );
      bufferBytes.set(
        arrayBufferBinding,
        Uint8Array.from(bytes),
      );
    },
    enableVertexAttribArray(index) {
      assert.ok(vertexArrayBinding);
      const attributes = vertexAttributes.get(vertexArrayBinding);
      attributes.set(index, {
        ...(attributes.get(index) ?? {}),
        enabled: true,
      });
    },
    vertexAttribPointer(
      index,
      size,
      type,
      normalized,
      stride,
      offset
    ) {
      vertexAttribPointerCount++;
      if (
        vertexAttribPointerCount ===
        gl.failVertexAttribPointerAt
      ) {
        throw new Error(
          'synthetic vertex-attribute publication failure'
        );
      }
      assert.ok(vertexArrayBinding);
      assert.ok(arrayBufferBinding);
      const attributes = vertexAttributes.get(vertexArrayBinding);
      attributes.set(index, {
        ...(attributes.get(index) ?? {}),
        buffer: arrayBufferBinding,
        normalized,
        offset,
        size,
        stride,
        type,
      });
    },
    deleteBuffer(buffer) {
      bufferDeleteAttempts.push(buffer);
      if (gl.failDeleteBuffer) {
        throw new Error(`synthetic buffer retirement failure ${buffer.id}`);
      }
      buffers.delete(buffer);
      bufferBytes.delete(buffer);
      deletedBuffers.push(buffer);
      if (arrayBufferBinding === buffer) arrayBufferBinding = null;
    },
    deleteVertexArray(vertexArray) {
      vertexArrayDeleteAttempts.push(vertexArray);
      if (gl.failDeleteVertexArray) {
        throw new Error(
          `synthetic vertex-array retirement failure ${vertexArray.id}`
        );
      }
      vertexArrays.delete(vertexArray);
      vertexAttributes.delete(vertexArray);
      deletedVertexArrays.push(vertexArray);
      if (vertexArrayBinding === vertexArray) vertexArrayBinding = null;
    },
    getError() {
      return gl.NO_ERROR;
    },
    _state: {
      buffers,
      vertexArrays,
      deletedBuffers,
      deletedVertexArrays,
      bufferDeleteAttempts,
      bufferBytes,
      vertexAttributes,
      vertexArrayDeleteAttempts,
      get bufferCreateCount() {
        return bufferCreateCount;
      },
      get uploadCount() {
        return uploadCount;
      },
      get vertexArrayCreateCount() {
        return vertexArrayCreateCount;
      },
      get vertexAttribPointerCount() {
        return vertexAttribPointerCount;
      },
      get arrayBufferBinding() {
        return arrayBufferBinding;
      },
      get vertexArrayBinding() {
        return vertexArrayBinding;
      },
    },
  };
  return gl;
}

function createRenderer() {
  const gl = createFakeGl();
  const renderer = Object.create(HighPerfRenderer.prototype);
  const positions = new Float32Array([
    -1, 0, 0,
    1, 0, 0,
  ]);
  const colors = new Uint8Array([
    255, 0, 0, 255,
    0, 0, 255, 255,
  ]);
  const positionBuffer = gl.createBuffer();
  const buffer = gl.createBuffer();
  const vao = gl.createVertexArray();
  const snapshotPositions = positions.slice();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, snapshotPositions, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(
    1,
    4,
    gl.UNSIGNED_BYTE,
    true,
    4,
    0
  );
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  renderer.gl = gl;
  renderer.pointCount = 2;
  renderer._positions = positions;
  renderer._liveGeometryGeneration = 1;
  renderer._nextGeometryGeneration = 2;
  renderer.useAdaptiveLOD = false;
  renderer.useFrustumCulling = false;
  renderer.forceLODLevel = -1;
  renderer._perViewState = new Map();
  renderer.snapshotBuffers = new Map([
    ['snap_1', {
      id: 'snap_1',
      vao,
      buffer,
      bufferByteLength: colors.byteLength,
      pointCount: 2,
      positions: snapshotPositions,
      geometryGeneration: 1,
      colors,
      bounds: HighPerfRenderer.computeBoundsFromPositions(snapshotPositions),
      spatialIndex: null,
      dimensionLevel: 3,
    }],
  ]);
  renderer._snapshotGeometryPools = new Map([
    [1, {
      generation: 1,
      positions: snapshotPositions,
      positionBuffer,
      positionBufferByteLength:
        snapshotPositions.byteLength,
      refCount: 1,
      spatialIndices: new Map(),
    }],
  ]);
  return { gl, renderer };
}

function copyBytes(view) {
  return Uint8Array.from(
    new Uint8Array(
      view.buffer,
      view.byteOffset,
      view.byteLength,
    )
  );
}

function replaceCalculationNotifications(overrides) {
  const notifications = getNotificationCenter();
  const previous = {
    completeCalculation: notifications.completeCalculation,
    failCalculation: notifications.failCalculation,
    hasNotification: notifications.hasNotification,
    startCalculation: notifications.startCalculation,
  };
  Object.assign(notifications, {
    hasNotification: () => true,
    ...overrides,
  });
  return () => Object.assign(notifications, previous);
}

test('snapshots from one live generation share one immutable CPU copy', () => {
  const { gl, renderer } = createRenderer();
  const existing = renderer.snapshotBuffers.get('snap_1');
  const colors = existing.colors;
  renderer.deleteSnapshotBuffer('snap_1');
  gl._state.deletedBuffers.length = 0;
  gl._state.deletedVertexArrays.length = 0;

  renderer.createSnapshotBuffer(
    'snap_1',
    colors,
    null,
    renderer._positions,
    3,
    'live',
  );
  renderer.createSnapshotBuffer(
    'snap_2',
    colors,
    null,
    renderer._positions,
    3,
    'live',
  );

  const first = renderer.snapshotBuffers.get('snap_1');
  const second = renderer.snapshotBuffers.get('snap_2');
  const frozenCoordinates = Array.from(first.positions);
  assert.notEqual(first.positions, renderer._positions);
  assert.equal(first.positions, second.positions);
  assert.equal(first.geometryGeneration, renderer._liveGeometryGeneration);
  assert.equal(second.geometryGeneration, renderer._liveGeometryGeneration);
  assert.equal(
    renderer._snapshotGeometryPools.get(
      renderer._liveGeometryGeneration
    ).refCount,
    2,
  );

  renderer._positions[0] = 1234;
  assert.deepEqual(Array.from(first.positions), frozenCoordinates);
  assert.deepEqual(Array.from(second.positions), frozenCoordinates);

  renderer.deleteSnapshotBuffer('snap_1');
  assert.equal(
    renderer._snapshotGeometryPools.get(
      renderer._liveGeometryGeneration
    ).refCount,
    1,
  );
  renderer.deleteSnapshotBuffer('snap_2');
  assert.equal(renderer._snapshotGeometryPools.size, 0);
});

test('geometry-generation certificates remain exact across live and snapshot replacement lifecycles', () => {
  const { gl, renderer } = createRenderer();
  const first = renderer.snapshotBuffers.get('snap_1');
  const oldGeometry = renderer._snapshotGeometryPools.get(1);
  const oldPositionBuffer = oldGeometry.positionBuffer;

  assert.equal(renderer.getViewGeometryGeneration('live'), 1);
  assert.equal(renderer.getViewGeometryGeneration('snap_1'), 1);
  assert.throws(
    () => renderer.getViewGeometryGeneration('missing'),
    /does not exist/,
  );

  renderer.createSnapshotBuffer(
    'snap_2',
    first.colors,
    null,
    renderer._positions,
    3,
    'live',
  );
  assert.equal(renderer.getViewGeometryGeneration('snap_2'), 1);
  assert.equal(oldGeometry.refCount, 2);

  // A new live publication invalidates live-generation equality without
  // changing or retiring snapshots frozen from the old publication.
  renderer._positions = renderer._positions.slice();
  renderer._liveGeometryGeneration = 2;
  renderer._nextGeometryGeneration = 3;
  assert.equal(renderer.getViewGeometryGeneration('live'), 2);
  assert.equal(renderer.getViewGeometryGeneration('snap_1'), 1);
  assert.equal(renderer.getViewGeometryGeneration('snap_2'), 1);
  assert.equal(gl._state.buffers.has(oldPositionBuffer), true);

  const second = renderer.snapshotBuffers.get('snap_2');
  renderer.createSnapshotBuffer(
    'snap_3',
    second.colors,
    null,
    second.positions,
    3,
    'snap_2',
  );
  assert.equal(renderer.getViewGeometryGeneration('snap_3'), 1);
  assert.equal(oldGeometry.refCount, 3);
  assert.equal(
    renderer._snapshotGeometryPools.get(1).positionBuffer,
    oldPositionBuffer,
  );

  renderer.updateSnapshotPositions(
    'snap_1',
    first.positions,
    2,
  );
  const replacementGeneration =
    renderer.getViewGeometryGeneration('snap_1');
  assert.equal(replacementGeneration, 3);
  assert.equal(renderer.getViewGeometryGeneration('live'), 2);
  assert.equal(renderer.getViewGeometryGeneration('snap_2'), 1);
  assert.equal(renderer.getViewGeometryGeneration('snap_3'), 1);
  assert.equal(oldGeometry.refCount, 2);

  renderer.deleteSnapshotBuffer('snap_2');
  renderer.deleteSnapshotBuffer('snap_3');
  assert.equal(renderer._snapshotGeometryPools.has(1), false);
  assert.equal(gl._state.buffers.has(oldPositionBuffer), false);
  assert.equal(
    renderer.getViewGeometryGeneration('snap_1'),
    replacementGeneration,
  );
  assert.throws(
    () => renderer.getViewGeometryGeneration('snap_2'),
    /does not exist/,
  );

  renderer._positions = null;
  renderer._liveGeometryGeneration = 0;
  assert.throws(
    () => renderer.getViewGeometryGeneration('live'),
    /no published geometry generation/,
  );
});

test('same-generation snapshots share positions and color-only replacement uploads exactly 4N bytes', (t) => {
  const { gl, renderer } = createRenderer();
  const scratch = new ArrayBuffer(renderer.pointCount * 16);
  renderer._interleavedArrayBuffer = scratch;
  renderer._interleavedPositionView =
    new Float32Array(scratch);
  renderer._interleavedColorView =
    new Uint8Array(scratch);
  const firstColors = new Uint8Array([
    1, 2, 3, 4,
    5, 6, 7, 8,
  ]);
  const secondColors = new Uint8Array([
    11, 12, 13, 14,
    15, 16, 17, 18,
  ]);
  const replacementColors = new Uint8Array([
    21, 22, 23, 24,
    25, 26, 27, 28,
  ]);

  renderer.createSnapshotBuffer(
    'snap_2',
    firstColors,
    null,
    renderer._positions,
    3,
    'live',
  );
  const first = renderer.snapshotBuffers.get('snap_2');
  const geometry = renderer._snapshotGeometryPools.get(
    first.geometryGeneration
  );
  const firstGpuBytes = Uint8Array.from(
    gl._state.bufferBytes.get(first.buffer),
  );
  assert.deepEqual(
    firstGpuBytes,
    firstColors,
  );

  renderer.createSnapshotBuffer(
    'snap_3',
    secondColors,
    null,
    renderer._positions,
    3,
    'live',
  );
  const second = renderer.snapshotBuffers.get('snap_3');
  const secondGpuBytes = Uint8Array.from(
    gl._state.bufferBytes.get(second.buffer),
  );
  assert.strictEqual(
    renderer._interleavedArrayBuffer,
    scratch,
  );
  assert.deepEqual(
    gl._state.bufferBytes.get(first.buffer),
    firstGpuBytes,
    'packing the next view must not mutate the first GPU copy',
  );
  assert.deepEqual(
    secondGpuBytes,
    secondColors,
  );
  assert.equal(
    renderer._snapshotGeometryPools.get(
      second.geometryGeneration
    ),
    geometry,
  );
  assert.deepEqual(
    gl._state.bufferBytes.get(geometry.positionBuffer),
    copyBytes(geometry.positions),
  );
  for (const snapshot of [first, second]) {
    const attributes =
      gl._state.vertexAttributes.get(snapshot.vao);
    assert.deepEqual(attributes.get(0), {
      buffer: geometry.positionBuffer,
      enabled: true,
      normalized: false,
      offset: 0,
      size: 3,
      stride: 12,
      type: gl.FLOAT,
    });
    assert.deepEqual(attributes.get(1), {
      buffer: snapshot.buffer,
      enabled: true,
      normalized: true,
      offset: 0,
      size: 4,
      stride: 4,
      type: gl.UNSIGNED_BYTE,
    });
  }
  assert.equal(
    renderer._snapshotGeometryPools.get(
      renderer._liveGeometryGeneration
    ).refCount,
    3,
    'both added views must share the immutable live-geometry copy',
  );

  const uploadCountBeforeReplacement =
    gl._state.uploadCount;
  const sharedPositionBuffer = geometry.positionBuffer;
  const sharedPositionBytes = Uint8Array.from(
    gl._state.bufferBytes.get(sharedPositionBuffer)
  );
  renderer.updateSnapshotBuffer(
    'snap_2',
    replacementColors,
    null,
    first.positions,
    3,
  );
  assert.strictEqual(
    renderer._interleavedArrayBuffer,
    scratch,
  );
  assert.deepEqual(
    gl._state.bufferBytes.get(second.buffer),
    secondGpuBytes,
    'snapshot replacement must not mutate a sibling GPU copy',
  );
  assert.deepEqual(
    gl._state.bufferBytes.get(first.buffer),
    replacementColors,
  );
  assert.equal(
    gl._state.uploadCount,
    uploadCountBeforeReplacement + 1,
    'a same-geometry replacement uploads only its new color store',
  );
  assert.equal(
    geometry.positionBuffer,
    sharedPositionBuffer,
  );
  assert.deepEqual(
    gl._state.bufferBytes.get(sharedPositionBuffer),
    sharedPositionBytes,
  );

  for (const method of [
    HighPerfRenderer.prototype.createSnapshotBuffer,
    HighPerfRenderer.prototype.updateSnapshotBuffer,
  ]) {
    assert.doesNotMatch(
      method.toString(),
      /new ArrayBuffer/,
    );
    assert.doesNotMatch(
      method.toString(),
      /_ensureSharedPackingScratch/,
    );
  }
  const pointCount = 30_000_000;
  const interleavedEightViewBytes =
    8 * pointCount * 16;
  const splitEightViewBytes =
    pointCount * 12 + 8 * pointCount * 4;
  const avoidedDuplicateBytes =
    interleavedEightViewBytes - splitEightViewBytes;
  assert.equal(avoidedDuplicateBytes, 2_520_000_000);
  t.diagnostic(
    `eight same-geometry 30M-point snapshots use ` +
    `${splitEightViewBytes.toLocaleString()} bytes instead of ` +
    `${interleavedEightViewBytes.toLocaleString()}, saving ` +
    `${avoidedDuplicateBytes.toLocaleString()} bytes ` +
    `(${(avoidedDuplicateBytes / 1024 / 1024).toFixed(3)} MiB)`,
  );
});

test('snapshot deletion retains exact failed handles for retry without releasing geometry twice', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const positionBuffer =
    renderer._snapshotGeometryPools.get(
      snapshot.geometryGeneration
    ).positionBuffer;
  gl.failDeleteBuffer = true;
  gl.failDeleteVertexArray = true;

  assert.throws(
    () => renderer.deleteSnapshotBuffer('snap_1'),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 1 &&
      /detached.*retirement remains pending/i.test(error.message)
    ),
  );
  assert.equal(renderer.snapshotBuffers.has('snap_1'), false);
  assert.equal(renderer._snapshotGeometryPools.size, 1);
  assert.equal(
    renderer._snapshotGeometryPools.get(
      snapshot.geometryGeneration
    ).refCount,
    1,
  );
  assert.equal(gl._state.buffers.has(snapshot.buffer), true);
  assert.equal(gl._state.buffers.has(positionBuffer), true);
  assert.equal(gl._state.vertexArrays.has(snapshot.vao), true);
  assert.equal(renderer._pendingSnapshotRetirements.size, 1);

  // A live VAO is a hard barrier: neither color nor geometry storage was
  // attempted, and the detached ID remains the exact retry surface.
  assert.equal(gl._state.bufferDeleteAttempts.length, 0);
  gl.failDeleteBuffer = false;
  gl.failDeleteVertexArray = false;
  assert.equal(renderer.deleteSnapshotBuffer('snap_1'), undefined);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  assert.equal(
    gl._state.bufferDeleteAttempts.filter(
      handle => handle === snapshot.buffer
    ).length,
    1,
  );
  assert.equal(
    gl._state.bufferDeleteAttempts.filter(
      handle => handle === positionBuffer
    ).length,
    1,
  );
  assert.equal(
    gl._state.vertexArrayDeleteAttempts.filter(
      handle => handle === snapshot.vao
    ).length,
    2,
  );
  assert.deepEqual(
    gl._state.deletedBuffers,
    [snapshot.buffer, positionBuffer]
  );
  assert.deepEqual(gl._state.deletedVertexArrays, [snapshot.vao]);
});

test('delete-all continues detaching snapshots after a retirement failure', () => {
  const { gl, renderer } = createRenderer();
  const colors = renderer.snapshotBuffers.get('snap_1').colors;
  renderer.createSnapshotBuffer(
    'snap_2',
    colors,
    null,
    renderer._positions,
    3,
    'live',
  );
  gl.failDeleteBuffer = true;

  assert.throws(
    () => renderer.deleteAllSnapshotBuffers(),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 3
    ),
  );
  assert.equal(renderer.snapshotBuffers.size, 0);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  assert.equal(gl._state.vertexArrays.size, 0);
  assert.equal(gl._state.buffers.size, 3);
  assert.equal(renderer._pendingSnapshotRetirements.size, 2);

  gl.failDeleteBuffer = false;
  renderer.deleteAllSnapshotBuffers();
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  assert.equal(gl._state.buffers.size, 0);
  assert.equal(gl._state.deletedBuffers.length, 3);
  assert.equal(gl._state.deletedVertexArrays.length, 2);
});

test('dispose retries a failed snapshot VAO without double release or premature pooled-position deletion', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const geometry = renderer._snapshotGeometryPools.get(
    snapshot.geometryGeneration
  );
  const positionBuffer = geometry.positionBuffer;
  Object.assign(renderer, {
    _alphaTexData: null,
    _alphaTexHeight: 0,
    _alphaTexWidth: 0,
    _alphaTexture: null,
    _alphaTextureByteLength: 0,
    _boundingSphere: null,
    _bufferDirty: false,
    _colors: null,
    _currentAlphas: null,
    _dirtyLodDimensions: new Set(),
    _dummyLodIndexTexture: null,
    _dummyLodIndexTextureByteLength: 0,
    _firstRenderDone: false,
    _interleavedArrayBuffer: null,
    _interleavedColorView: null,
    _interleavedGpuByteLength: 0,
    _interleavedPositionView: null,
    _lodIndexTexturesByDimension: new Map(),
    _lodResourceOwnersByDimension: new Map(),
    _pendingProgramRetirements: new Set(),
    _pendingProgramUnbind: false,
    _pendingShaderRetirements: new Set(),
    _useAlphaTexture: false,
    activeProgram: null,
    buffers: {
      alphas: null,
      colors: null,
      interleaved: null,
      positions: null,
    },
    currentDimensionLevel: 3,
    lodBuffersByDimension: new Map(),
    programs: {
      full: null,
      light: null,
      ultralight: null,
    },
    spatialIndices: new Map(),
    stats: { gpuMemoryMB: 0 },
    uniformLocations: new Map(),
    vao: null,
  });
  gl.failDeleteVertexArray = true;

  assert.throws(
    () => renderer.dispose(),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 1 &&
      /disposal retains/i.test(error.message)
    ),
  );
  assert.equal(renderer.snapshotBuffers.size, 0);
  assert.equal(renderer._pendingSnapshotRetirements.size, 1);
  assert.equal(geometry.refCount, 1);
  assert.equal(
    renderer._snapshotGeometryPools.get(
      geometry.generation
    ),
    geometry,
  );
  assert.equal(gl._state.buffers.has(snapshot.buffer), true);
  assert.equal(gl._state.buffers.has(positionBuffer), true);

  gl.failDeleteVertexArray = false;
  assert.doesNotThrow(() => renderer.dispose());
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  assert.equal(gl._state.buffers.size, 0);
  assert.equal(gl._state.vertexArrays.size, 0);
  assert.equal(
    gl._state.vertexArrayDeleteAttempts.filter(
      handle => handle === snapshot.vao
    ).length,
    2,
  );
  assert.equal(
    gl._state.bufferDeleteAttempts.filter(
      handle => handle === positionBuffer
    ).length,
    1,
  );
});

test('position upload failure releases newly acquired geometry exactly once without 16N staging', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const before = { ...snapshot };
  const livePool =
    renderer._snapshotGeometryPools.get(snapshot.geometryGeneration);
  gl.failUpload = true;
  assert.throws(
    () => renderer.updateSnapshotPositions(
      'snap_1',
      snapshot.positions,
      2,
    ),
    /synthetic snapshot upload failure/,
  );

  assert.deepEqual({ ...snapshot }, before);
  assert.equal(renderer._snapshotGeometryPools.size, 1);
  assert.equal(livePool.refCount, 1);
  assert.equal(gl._state.buffers.size, 2);
  assert.equal(gl._state.vertexArrays.size, 1);
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  for (const method of [
    HighPerfRenderer.prototype.createSnapshotBuffer,
    HighPerfRenderer.prototype.updateSnapshotBuffer,
  ]) {
    assert.doesNotMatch(method.toString(), /new ArrayBuffer/);
    assert.doesNotMatch(
      method.toString(),
      /_ensureSharedPackingScratch/
    );
  }
});

test('rejected split uploads retain zero accepted GPU bytes across cleanup retry', async (t) => {
  const configureAccounting = renderer => {
    renderer.stats = { gpuMemoryMB: 0 };
    renderer.buffers = {
      alphas: null,
      colors: null,
      interleaved: null,
      positions: null,
    };
    renderer._interleavedGpuByteLength = 0;
    renderer._alphaTexture = null;
    renderer._alphaTextureByteLength = 0;
    renderer._dummyLodIndexTexture = null;
    renderer._dummyLodIndexTextureByteLength = 0;
    renderer._lodResourceOwnersByDimension = new Map();
  };
  const assertActiveBytesOnly = renderer => {
    const expected =
      renderer.pointCount * 4 +
      renderer.pointCount * 3 * Float32Array.BYTES_PER_ELEMENT;
    assert.equal(
      renderer.stats.gpuMemoryMB * 1024 * 1024,
      expected,
    );
  };

  await t.test('position upload', () => {
    const { gl, renderer } = createRenderer();
    configureAccounting(renderer);
    const snapshot = renderer.snapshotBuffers.get('snap_1');
    gl.failUpload = true;
    gl.failDeleteBuffer = true;

    assert.throws(
      () => renderer.updateSnapshotPositions(
        'snap_1',
        snapshot.positions,
        2,
      ),
      error => (
        error instanceof AggregateError &&
        /rollback error/i.test(error.message)
      ),
    );
    assert.equal(renderer._pendingSnapshotRetirements.size, 1);
    const [retirement] =
      renderer._pendingSnapshotRetirements;
    assert.equal(retirement.buffer, null);
    assert.ok(retirement.positionBuffer);
    assert.equal(retirement.positionBufferByteLength, 0);
    assert.equal(retirement.geometryGeneration, null);
    assertActiveBytesOnly(renderer);

    gl.failUpload = false;
    gl.failDeleteBuffer = false;
    assert.deepEqual(
      renderer._drainSnapshotRetirements('snap_1'),
      [],
    );
  });

  await t.test('color upload', () => {
    const { gl, renderer } = createRenderer();
    configureAccounting(renderer);
    const snapshot = renderer.snapshotBuffers.get('snap_1');
    gl.failUpload = true;
    gl.failDeleteBuffer = true;

    assert.throws(
      () => renderer.updateSnapshotBuffer(
        'snap_1',
        snapshot.colors,
        null,
        snapshot.positions,
        3,
      ),
      error => (
        error instanceof AggregateError &&
        /rollback error/i.test(error.message)
      ),
    );
    assert.equal(renderer._pendingSnapshotRetirements.size, 1);
    const [retirement] =
      renderer._pendingSnapshotRetirements;
    assert.ok(retirement.buffer);
    assert.equal(retirement.bufferByteLength, 0);
    assert.equal(retirement.positionBuffer, null);
    assert.equal(retirement.geometryGeneration, null);
    assertActiveBytesOnly(renderer);

    gl.failUpload = false;
    gl.failDeleteBuffer = false;
    assert.deepEqual(
      renderer._drainSnapshotRetirements('snap_1'),
      [],
    );
  });
});

test('null position, color, and VAO allocations roll back exact geometry references', async (t) => {
  await t.test('new position allocation', () => {
    const { gl, renderer } = createRenderer();
    const snapshot = renderer.snapshotBuffers.get('snap_1');
    const before = { ...snapshot };
    gl.failBufferAllocationAt =
      gl._state.bufferCreateCount + 1;

    assert.throws(
      () => renderer.updateSnapshotPositions(
        'snap_1',
        snapshot.positions,
        2,
      ),
      /shared position buffer/,
    );
    assert.deepEqual({ ...snapshot }, before);
    assert.equal(renderer._snapshotGeometryPools.size, 1);
    assert.equal(
      renderer._snapshotGeometryPools.get(1).refCount,
      1,
    );
    assert.equal(gl._state.buffers.size, 2);
    assert.equal(gl._state.vertexArrays.size, 1);
    assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  });

  await t.test('color allocation', () => {
    const { gl, renderer } = createRenderer();
    const snapshot = renderer.snapshotBuffers.get('snap_1');
    const geometry = renderer._snapshotGeometryPools.get(1);
    gl.failBufferAllocationAt =
      gl._state.bufferCreateCount + 1;

    assert.throws(
      () => renderer.createSnapshotBuffer(
        'snap_2',
        snapshot.colors,
        null,
        renderer._positions,
        3,
        'live',
      ),
      /color resources/,
    );
    assert.equal(renderer.snapshotBuffers.has('snap_2'), false);
    assert.equal(geometry.refCount, 1);
    assert.equal(gl._state.buffers.size, 2);
    assert.equal(gl._state.vertexArrays.size, 1);
    assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  });

  await t.test('VAO allocation after accepted color upload', () => {
    const { gl, renderer } = createRenderer();
    const snapshot = renderer.snapshotBuffers.get('snap_1');
    const geometry = renderer._snapshotGeometryPools.get(1);
    const uploadsBefore = gl._state.uploadCount;
    gl.failVertexArrayAllocationAt =
      gl._state.vertexArrayCreateCount + 1;

    assert.throws(
      () => renderer.createSnapshotBuffer(
        'snap_2',
        snapshot.colors,
        null,
        renderer._positions,
        3,
        'live',
      ),
      /vertex resources/,
    );
    assert.equal(gl._state.uploadCount, uploadsBefore + 1);
    assert.equal(renderer.snapshotBuffers.has('snap_2'), false);
    assert.equal(geometry.refCount, 1);
    assert.equal(gl._state.buffers.size, 2);
    assert.equal(gl._state.vertexArrays.size, 1);
    assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  });
});

test('VAO attribute setup failure deletes the staged VAO before releasing split storage', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const geometry = renderer._snapshotGeometryPools.get(1);
  const deletedBufferCount = gl._state.deletedBuffers.length;
  const deletedVaoCount =
    gl._state.deletedVertexArrays.length;
  gl.failVertexAttribPointerAt =
    gl._state.vertexAttribPointerCount + 1;

  assert.throws(
    () => renderer.createSnapshotBuffer(
      'snap_2',
      snapshot.colors,
      null,
      renderer._positions,
      3,
      'live',
    ),
    /vertex-attribute publication failure/,
  );
  assert.equal(renderer.snapshotBuffers.has('snap_2'), false);
  assert.equal(geometry.refCount, 1);
  assert.equal(gl._state.deletedVertexArrays.length, deletedVaoCount + 1);
  assert.equal(gl._state.deletedBuffers.length, deletedBufferCount + 1);
  assert.equal(gl._state.buffers.size, 2);
  assert.equal(gl._state.vertexArrays.size, 1);
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
});

test('snapshot GPU upload failure preserves the complete published resource set', () => {
  const { gl, renderer } = createRenderer();
  const before = renderer.snapshotBuffers.get('snap_1');
  const beforeRecord = { ...before };
  const replacementColors = new Uint8Array([
    0, 255, 0, 255,
    255, 255, 0, 255,
  ]);
  const acceptedGpuBytes = copyBytes(before.colors);
  const geometry = renderer._snapshotGeometryPools.get(
    before.geometryGeneration
  );
  const acceptedPositionBytes = Uint8Array.from(
    gl._state.bufferBytes.get(geometry.positionBuffer)
  );
  gl._state.bufferBytes.set(
    before.buffer,
    Uint8Array.from(acceptedGpuBytes),
  );

  gl.failUpload = true;
  assert.throws(
    () => renderer.updateSnapshotBuffer(
      'snap_1',
      replacementColors,
      null,
      before.positions,
      3
    ),
    /synthetic snapshot upload failure/,
  );

  assert.equal(renderer.snapshotBuffers.get('snap_1'), before);
  assert.deepEqual({ ...before }, beforeRecord);
  assert.equal(gl._state.buffers.has(before.buffer), true);
  assert.equal(gl._state.vertexArrays.has(before.vao), true);
  assert.equal(gl._state.buffers.size, 2);
  assert.equal(gl._state.vertexArrays.size, 1);
  assert.deepEqual(
    gl._state.bufferBytes.get(before.buffer),
    acceptedGpuBytes,
    'failed upload cannot mutate the accepted color GPU store',
  );
  assert.deepEqual(
    gl._state.bufferBytes.get(geometry.positionBuffer),
    acceptedPositionBytes,
    'a color-only failure must not re-upload positions',
  );
  assert.equal(gl._state.arrayBufferBinding, null);
  assert.equal(gl._state.vertexArrayBinding, null);
});

test('snapshot rollback keeps failed candidate cleanup owned for exact retry', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const before = { ...snapshot };
  const originalBuffer = snapshot.buffer;
  const originalVao = snapshot.vao;
  const positionBuffer =
    renderer._snapshotGeometryPools.get(
      snapshot.geometryGeneration
    ).positionBuffer;
  const replacementColors = snapshot.colors.slice();

  gl.failUpload = true;
  gl.failDeleteBuffer = true;
  assert.throws(
    () => renderer.updateSnapshotBuffer(
      'snap_1',
      replacementColors,
      null,
      snapshot.positions,
      3,
    ),
    error => (
      error instanceof AggregateError &&
      /rollback error/i.test(error.message)
    ),
  );

  assert.deepEqual({ ...snapshot }, before);
  assert.equal(renderer._pendingSnapshotRetirements.size, 1);
  assert.equal(gl._state.buffers.has(originalBuffer), true);
  assert.equal(gl._state.vertexArrays.has(originalVao), true);
  assert.equal(gl._state.vertexArrays.size, 1);
  const failedCandidate = Array.from(gl._state.buffers).find(
    handle => (
      handle !== originalBuffer &&
      handle !== positionBuffer
    )
  );
  assert.ok(failedCandidate);
  assert.equal(
    gl._state.bufferDeleteAttempts.filter(
      handle => handle === failedCandidate
    ).length,
    1,
  );

  gl.failUpload = false;
  gl.failDeleteBuffer = false;
  assert.deepEqual(renderer._drainSnapshotRetirements('snap_1'), []);
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  assert.equal(gl._state.buffers.size, 2);
  assert.equal(gl._state.buffers.has(originalBuffer), true);
  assert.equal(
    gl._state.bufferDeleteAttempts.filter(
      handle => handle === failedCandidate
    ).length,
    2,
  );
});

test('snapshot GPU publication swaps both resources exactly once', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const previousBuffer = snapshot.buffer;
  const previousVao = snapshot.vao;
  const sharedPositionBuffer =
    renderer._snapshotGeometryPools.get(
      snapshot.geometryGeneration
    ).positionBuffer;
  const replacementColors = new Uint8Array([
    0, 255, 0, 255,
    255, 255, 0, 255,
  ]);

  assert.equal(
    renderer.updateSnapshotBuffer(
      'snap_1',
      replacementColors,
      null,
      snapshot.positions,
      3
    ),
    true,
  );

  assert.notEqual(snapshot.buffer, previousBuffer);
  assert.notEqual(snapshot.vao, previousVao);
  assert.deepEqual(snapshot.colors, replacementColors);
  assert.notEqual(snapshot.colors, replacementColors);
  assert.equal(gl._state.buffers.has(previousBuffer), false);
  assert.equal(gl._state.vertexArrays.has(previousVao), false);
  assert.deepEqual(gl._state.deletedBuffers, [previousBuffer]);
  assert.deepEqual(gl._state.deletedVertexArrays, [previousVao]);
  assert.equal(gl._state.buffers.size, 2);
  assert.equal(
    gl._state.buffers.has(sharedPositionBuffer),
    true
  );
  assert.equal(gl._state.vertexArrays.size, 1);
});

test('color replacement keeps an extra geometry ref until its old VAO actually retires', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const oldBuffer = snapshot.buffer;
  const oldVao = snapshot.vao;
  const geometry = renderer._snapshotGeometryPools.get(
    snapshot.geometryGeneration
  );
  const positionBuffer = geometry.positionBuffer;
  gl.failDeleteVertexArray = true;

  assert.equal(
    renderer.updateSnapshotBuffer(
      'snap_1',
      snapshot.colors,
      null,
      snapshot.positions,
      3,
    ),
    true,
  );
  assert.equal(geometry.refCount, 2);
  assert.equal(renderer._pendingSnapshotRetirements.size, 1);
  assert.equal(gl._state.vertexArrays.has(oldVao), true);
  assert.equal(gl._state.buffers.has(oldBuffer), true);
  assert.equal(gl._state.buffers.has(positionBuffer), true);

  assert.throws(
    () => renderer.deleteSnapshotBuffer('snap_1'),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 2
    ),
  );
  assert.equal(renderer.snapshotBuffers.size, 0);
  assert.equal(geometry.refCount, 2);
  assert.equal(
    renderer._snapshotGeometryPools.get(
      geometry.generation
    ),
    geometry,
  );
  assert.equal(gl._state.buffers.has(positionBuffer), true);

  gl.failDeleteVertexArray = false;
  assert.doesNotThrow(
    () => renderer.deleteSnapshotBuffer('snap_1')
  );
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  assert.equal(gl._state.vertexArrays.size, 0);
  assert.equal(gl._state.buffers.size, 0);
  assert.equal(
    gl._state.bufferDeleteAttempts.at(-1),
    positionBuffer,
    'the pooled position VBO retires after both VAO retry owners',
  );
});

test('published snapshot updates stay successful while failed old handles remain retryable', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const previous = { ...snapshot };
  gl.failDeleteBuffer = true;

  assert.equal(
    renderer.updateSnapshotPositions(
      'snap_1',
      snapshot.positions,
      2,
    ),
    true,
  );

  assert.equal(renderer.snapshotBuffers.get('snap_1'), snapshot);
  assert.notEqual(snapshot.geometryGeneration, previous.geometryGeneration);
  assert.notEqual(snapshot.positions, previous.positions);
  assert.notEqual(snapshot.buffer, previous.buffer);
  assert.notEqual(snapshot.vao, previous.vao);
  assert.equal(
    renderer._snapshotGeometryPools.has(previous.geometryGeneration),
    false,
  );
  assert.equal(
    renderer._snapshotGeometryPools.get(
      snapshot.geometryGeneration
    ).refCount,
    1,
  );
  assert.equal(gl._state.buffers.has(previous.buffer), true);
  assert.equal(gl._state.vertexArrays.has(previous.vao), false);
  assert.equal(renderer._pendingSnapshotRetirements.size, 1);

  gl.failDeleteBuffer = false;
  assert.deepEqual(renderer._drainSnapshotRetirements('snap_1'), []);
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  assert.equal(gl._state.buffers.has(previous.buffer), false);
  assert.equal(
    gl._state.bufferDeleteAttempts.filter(
      handle => handle === previous.buffer
    ).length,
    2,
  );
  assert.equal(
    gl._state.vertexArrayDeleteAttempts.filter(
      handle => handle === previous.vao
    ).length,
    1,
  );
  renderer.deleteSnapshotBuffer('snap_1');
  assert.equal(renderer._snapshotGeometryPools.size, 0);
});

test('snapshot geometry publication copies even the same input identity', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const ownedPositions = snapshot.positions;
  const ownedBounds = snapshot.bounds;
  const ownedBuffer = snapshot.buffer;
  const ownedVao = snapshot.vao;
  const ownedPositionBuffer =
    renderer._snapshotGeometryPools.get(
      snapshot.geometryGeneration
    ).positionBuffer;

  assert.equal(
    renderer.updateSnapshotPositions('snap_1', snapshot.positions, 2),
    true,
  );
  assert.equal(snapshot.dimensionLevel, 2);
  assert.notStrictEqual(snapshot.positions, renderer._positions);
  assert.notStrictEqual(snapshot.positions, ownedPositions);
  assert.notStrictEqual(snapshot.bounds, ownedBounds);
  assert.notStrictEqual(snapshot.buffer, ownedBuffer);
  assert.notStrictEqual(snapshot.vao, ownedVao);
  assert.deepEqual(
    gl._state.deletedBuffers,
    [ownedBuffer, ownedPositionBuffer]
  );
  assert.deepEqual(gl._state.deletedVertexArrays, [ownedVao]);
  assert.equal(gl._state.buffers.size, 2);
  assert.equal(gl._state.vertexArrays.size, 1);
  assert.equal(renderer._snapshotGeometryPools.has(1), false);
  assert.equal(
    renderer._snapshotGeometryPools.get(snapshot.geometryGeneration).positions,
    snapshot.positions,
  );
});

test('snapshot dimension metadata preserves immutable geometry and GPU resources', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const before = { ...snapshot };

  assert.equal(
    renderer.setSnapshotDimensionLevel('snap_1', 2),
    true,
  );
  assert.equal(snapshot.dimensionLevel, 2);
  assert.equal(snapshot.positions, before.positions);
  assert.equal(snapshot.geometryGeneration, before.geometryGeneration);
  assert.equal(snapshot.bounds, before.bounds);
  assert.equal(snapshot.buffer, before.buffer);
  assert.equal(snapshot.vao, before.vao);
  assert.equal(snapshot.spatialIndex, null);
  assert.deepEqual(gl._state.deletedBuffers, []);
  assert.deepEqual(gl._state.deletedVertexArrays, []);
});

test('view-state invalidation resets semantic caches without GPU buffer churn', () => {
  const { gl, renderer } = createRenderer();
  const viewState = renderer._getViewState('live');
  const indexBuffer = viewState.indexBuffer;
  viewState.lastFrustumMVP = new Float32Array(16);
  viewState.cachedCulledCount = 17;
  viewState.cachedVisibleIndices = new Uint32Array([1]);
  viewState.cachedLodVisibleIndices = new Uint32Array([1]);
  const visibleOriginalSet = new Set([1]);
  viewState.cachedVisibleOriginalSet = visibleOriginalSet;
  viewState.cachedLodVisibility = new Float32Array([1, 0]);
  viewState.cachedLodVisibilityFilterGen = 4;
  const lodVisibility = viewState.cachedLodVisibility;
  const lodVisibilityIndices = new Uint32Array([1]);
  viewState.cachedLodVisibilityIndices = lodVisibilityIndices;
  viewState.cachedCombinedVisibility = new Float32Array([1, 0]);
  const combinedVisibility = viewState.cachedCombinedVisibility;
  viewState.indexBufferSize = 17;
  viewState.usePreCachedIndexBuffer = true;
  viewState.preCachedIndexBuffer = { id: 'lod-index' };
  viewState.statsPublished = true;
  viewState.filterGeneration = 9;
  const bufferCount = gl._state.buffers.size;

  assert.equal(renderer.invalidateViewState('live'), true);

  assert.equal(viewState.indexBuffer, indexBuffer);
  assert.equal(viewState.filterGeneration, 9);
  assert.equal(viewState.lastFrustumMVP, null);
  assert.equal(viewState.cachedCulledCount, 0);
  assert.equal(viewState.cachedVisibleIndices, null);
  assert.equal(viewState.cachedLodVisibleIndices, null);
  assert.equal(viewState.cachedVisibleOriginalSet, visibleOriginalSet);
  assert.equal(viewState.cachedLodVisibility, lodVisibility);
  assert.equal(viewState.cachedLodVisibilityFilterGen, -1);
  assert.equal(
    viewState.cachedLodVisibilityIndices,
    lodVisibilityIndices,
  );
  assert.equal(viewState.cachedCombinedVisibility, combinedVisibility);
  assert.equal(viewState.cachedCombinedVisDim, -1);
  assert.equal(viewState.indexBufferSize, 0);
  assert.equal(viewState.usePreCachedIndexBuffer, false);
  assert.equal(viewState.preCachedIndexBuffer, null);
  assert.equal(viewState.statsPublished, false);
  assert.equal(gl._state.buffers.size, bufferCount);
  assert.deepEqual(gl._state.deletedBuffers, []);
  assert.equal(renderer.invalidateViewState('missing'), false);
});

test('same-identity custom snapshot spatial failure retains every published owner', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  renderer._positions = snapshot.positions.slice();
  renderer._liveGeometryGeneration = 2;
  renderer._nextGeometryGeneration = 3;
  renderer.useFrustumCulling = true;
  renderer.options = {
    LOD_MAX_DEPTH: 2,
    LOD_MAX_POINTS_PER_NODE: 0,
  };
  const previous = { ...snapshot };
  const notifications = [];
  const restoreNotifications = replaceCalculationNotifications({
    completeCalculation() {
      notifications.push('complete');
    },
    failCalculation(id) {
      notifications.push(['fail', id]);
    },
    startCalculation() {
      notifications.push('start');
      return 'spatial-1';
    },
  });

  try {
    assert.throws(
      () => renderer.updateSnapshotPositions(
        'snap_1',
        snapshot.positions,
        2,
      ),
      /maxPointsPerNode must be a positive integer/,
    );
  } finally {
    restoreNotifications();
  }

  assert.deepEqual({ ...snapshot }, previous);
  assert.equal(gl._state.buffers.size, 2);
  assert.equal(gl._state.vertexArrays.size, 1);
  assert.deepEqual(gl._state.deletedBuffers, []);
  assert.deepEqual(gl._state.deletedVertexArrays, []);
  assert.deepEqual(notifications, [
    'start',
    ['fail', 'spatial-1'],
  ]);
});

test('snapshot notification completion failure cannot roll back a valid publication', () => {
  const completionFailure = new Error('synthetic completion failure');
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  renderer._positions = snapshot.positions.slice();
  renderer._liveGeometryGeneration = 2;
  renderer._nextGeometryGeneration = 3;
  renderer.useFrustumCulling = true;
  renderer.options = {
    LOD_MAX_DEPTH: 2,
    LOD_MAX_POINTS_PER_NODE: 1,
  };
  const previous = { ...snapshot };
  let failureNotifications = 0;
  const restoreNotifications = replaceCalculationNotifications({
    completeCalculation() {
      throw completionFailure;
    },
    failCalculation() {
      failureNotifications++;
    },
    startCalculation() {
      return 'spatial-2';
    },
  });

  try {
    assert.equal(
      renderer.updateSnapshotPositions(
        'snap_1',
        snapshot.positions,
        2,
      ),
      true,
    );
  } finally {
    restoreNotifications();
  }

  assert.notEqual(snapshot.buffer, previous.buffer);
  assert.notEqual(snapshot.vao, previous.vao);
  assert.notEqual(
    snapshot.geometryGeneration,
    previous.geometryGeneration,
  );
  assert.equal(snapshot.dimensionLevel, 2);
  assert.equal(failureNotifications, 0);
  assert.equal(gl._state.buffers.size, 2);
  assert.equal(gl._state.vertexArrays.size, 1);
  assert.equal(gl._state.deletedBuffers.length, 2);
  assert.equal(gl._state.deletedVertexArrays.length, 1);
  assert.equal(gl._state.deletedBuffers[0], previous.buffer);
  assert.equal(gl._state.deletedVertexArrays[0], previous.vao);
});

test('dismissed snapshot calculation notification is non-authoritative', () => {
  const { renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  renderer._positions = snapshot.positions.slice();
  renderer._liveGeometryGeneration = 2;
  renderer._nextGeometryGeneration = 3;
  renderer.useFrustumCulling = true;
  renderer.options = {
    LOD_MAX_DEPTH: 2,
    LOD_MAX_POINTS_PER_NODE: 1,
  };
  let terminalCalls = 0;
  const restoreNotifications = replaceCalculationNotifications({
    completeCalculation() {
      terminalCalls++;
    },
    failCalculation() {
      terminalCalls++;
    },
    hasNotification: () => false,
    startCalculation: () => 'dismissed-spatial',
  });

  try {
    assert.equal(
      renderer.updateSnapshotPositions(
        'snap_1',
        snapshot.positions,
        2,
      ),
      true,
    );
  } finally {
    restoreNotifications();
  }

  assert.equal(snapshot.dimensionLevel, 2);
  assert.equal(terminalCalls, 0);
});

test('same-generation snapshots reuse one exact dimension spatial owner', () => {
  const { renderer } = createRenderer();
  const first = renderer.snapshotBuffers.get('snap_1');
  renderer.createSnapshotBuffer(
    'snap_2',
    first.colors,
    null,
    renderer._positions,
    3,
    'live',
  );
  const second = renderer.snapshotBuffers.get('snap_2');
  assert.equal(first.positions, second.positions);
  assert.equal(first.geometryGeneration, second.geometryGeneration);

  renderer._liveGeometryGeneration = 2;
  renderer._nextGeometryGeneration = 3;
  renderer.useFrustumCulling = true;
  renderer.options = {
    LOD_MAX_DEPTH: 2,
    LOD_MAX_POINTS_PER_NODE: 1,
  };
  let starts = 0;
  const restoreNotifications = replaceCalculationNotifications({
    completeCalculation() {},
    failCalculation() {
      throw new Error('shared spatial build unexpectedly failed');
    },
    startCalculation() {
      starts++;
      return `shared-spatial-${starts}`;
    },
  });

  try {
    renderer.rebuildSnapshotSpatialIndex('snap_1', 2);
    renderer.rebuildSnapshotSpatialIndex('snap_2', 2);
  } finally {
    restoreNotifications();
  }

  assert.equal(starts, 1);
  assert.equal(first.spatialIndex, second.spatialIndex);
  assert.equal(first.dimensionLevel, 2);
  assert.equal(second.dimensionLevel, 2);
  assert.equal(
    renderer._snapshotGeometryPools.get(
      first.geometryGeneration
    ).spatialIndices.size,
    1,
  );
});
