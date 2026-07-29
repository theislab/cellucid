import assert from 'node:assert/strict';
import test from 'node:test';

import { HighPerfRenderer } from '../assets/js/rendering/high-perf-renderer.js';

function createDataGl() {
  let nextId = 1;
  const buffers = new Set();
  const textures = new Set();
  const vertexArrays = new Set();
  const deleteAttempts = {
    buffers: [],
    textures: [],
    vertexArrays: [],
  };
  const deleted = {
    buffers: [],
    textures: [],
    vertexArrays: [],
  };
  const fail = {
    buffers: new Set(),
    textures: new Set(),
    vertexArrays: new Set(),
  };
  const gl = {
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    NO_ERROR: 0,
    TEXTURE_2D: 0x0de1,
    createBuffer() {
      const handle = { id: `buffer-${nextId++}` };
      buffers.add(handle);
      return handle;
    },
    createTexture() {
      const handle = { id: `texture-${nextId++}` };
      textures.add(handle);
      return handle;
    },
    createVertexArray() {
      const handle = { id: `vao-${nextId++}` };
      vertexArrays.add(handle);
      return handle;
    },
    bindBuffer() {},
    bindTexture() {},
    bindVertexArray() {},
    deleteBuffer(handle) {
      deleteAttempts.buffers.push(handle);
      if (fail.buffers.has(handle)) {
        throw new Error(`synthetic buffer cleanup failure ${handle.id}`);
      }
      buffers.delete(handle);
      deleted.buffers.push(handle);
    },
    deleteProgram() {},
    deleteTexture(handle) {
      deleteAttempts.textures.push(handle);
      if (fail.textures.has(handle)) {
        throw new Error(`synthetic texture cleanup failure ${handle.id}`);
      }
      textures.delete(handle);
      deleted.textures.push(handle);
    },
    deleteVertexArray(handle) {
      deleteAttempts.vertexArrays.push(handle);
      if (fail.vertexArrays.has(handle)) {
        throw new Error(`synthetic VAO cleanup failure ${handle.id}`);
      }
      vertexArrays.delete(handle);
      deleted.vertexArrays.push(handle);
    },
    getError() {
      return gl.NO_ERROR;
    },
    _state: {
      buffers,
      deleteAttempts,
      deleted,
      fail,
      textures,
      vertexArrays,
    },
  };
  return gl;
}

function countIdentity(values, expected) {
  return values.filter(value => value === expected).length;
}

function createDataRenderer() {
  const gl = createDataGl();
  const renderer = Object.create(HighPerfRenderer.prototype);
  const old = {
    buffer: gl.createBuffer(),
    lodIndexBuffer: gl.createBuffer(),
    perViewBuffer: gl.createBuffer(),
    texture: gl.createTexture(),
    lodTexture: gl.createTexture(),
    vao: gl.createVertexArray(),
  };
  const positions = new Float32Array([
    -1, 0, 0,
    1, 0, 0,
  ]);
  const colors = new Uint8Array([
    255, 0, 0, 255,
    0, 0, 255, 255,
  ]);
  const buffers = {
    interleaved: old.buffer,
    positions: old.buffer,
    colors: null,
    alphas: null,
  };
  const lodIndexTexturesByDimension = new Map([
    [3, [
      { texture: old.texture },
      { texture: old.lodTexture },
    ]],
  ]);
  const lodBuffersByDimension = new Map([
    [3, [{
      buffer: old.buffer,
      isFullDetail: true,
      originalIndexBuffer: old.lodIndexBuffer,
      vao: old.vao,
    }]],
  ]);
  const perViewState = new Map([
    ['live', { indexBuffer: old.perViewBuffer }],
  ]);

  Object.assign(renderer, {
    gl,
    options: {},
    useAdaptiveLOD: false,
    useFrustumCulling: false,
    forceLODLevel: -1,
    vao: old.vao,
    buffers,
    _alphaTexture: old.texture,
    _alphaTexWidth: 2,
    _alphaTexHeight: 1,
    _alphaTexData: new Uint8Array([255, 255]),
    _useAlphaTexture: true,
    _currentAlphas: new Float32Array([1, 1]),
    _lodIndexTexturesByDimension: lodIndexTexturesByDimension,
    spatialIndices: new Map(),
    lodBuffersByDimension,
    _perViewState: perViewState,
    currentDimensionLevel: 3,
    _liveGeometryGeneration: 1,
    _nextGeometryGeneration: 2,
    pointCount: 2,
    _positions: positions,
    _colors: colors,
    _firstRenderDone: true,
    _boundingSphere: { radius: 1 },
    _bufferDirty: false,
    _dirtyLodDimensions: new Set(),
    _interleavedArrayBuffer: new ArrayBuffer(32),
    _interleavedPositionView: null,
    _interleavedColorView: null,
    _snapshotGeometryPools: new Map(),
    _pendingSnapshotRetirements: new Set(),
    _pendingDataRetirements: new Set(),
    snapshotBuffers: new Map(),
    stats: {
      lastFrameTime: 1,
      fps: 60,
      visiblePoints: 2,
      lodLevel: -1,
      gpuMemoryMB: 1,
      drawCalls: 1,
      frustumCulled: false,
      cullPercent: 0,
    },
    indexBuffer: null,
    programs: {},
    activeProgram: null,
    uniformLocations: new Map(),
    _dummyLodIndexTexture: null,
    _lodArrayBuffers: null,
  });

  renderer._createInterleavedBuffer = function createCandidateBuffer() {
    this.buffers.interleaved = gl.createBuffer();
    this._interleavedArrayBuffer = new ArrayBuffer(32);
    this._interleavedPositionView =
      new Float32Array(this._interleavedArrayBuffer);
    this._interleavedColorView =
      new Uint8Array(this._interleavedArrayBuffer);
  };
  renderer._createAlphaTexture = function createCandidateAlphaTexture() {
    this._alphaTexture = gl.createTexture();
    this._alphaTexWidth = 2;
    this._alphaTexHeight = 1;
    this._alphaTexData = new Uint8Array([255, 255]);
  };
  renderer._computeBoundingSphere = () => ({ radius: 2 });
  renderer.getLodBuffersForDimension = () => [];

  return {
    colors,
    gl,
    old,
    positions,
    renderer,
  };
}

test('loadData commits before old retirement and retries each deduplicated handle exactly', () => {
  const { gl, old, renderer } = createDataRenderer();
  const nextPositions = new Float32Array([
    -2, 0, 0,
    2, 0, 0,
  ]);
  const nextColors = new Uint8Array([
    0, 255, 0, 255,
    255, 255, 0, 255,
  ]);
  gl._state.fail.buffers.add(old.buffer);
  gl._state.fail.textures.add(old.texture);

  const stats = renderer.loadData(nextPositions, nextColors, {
    buildSpatialIndex: false,
    dimensionLevel: 2,
  });

  assert.equal(stats, renderer.stats);
  assert.equal(renderer._positions, nextPositions);
  assert.equal(renderer._colors, nextColors);
  assert.equal(renderer.currentDimensionLevel, 2);
  assert.equal(renderer._liveGeometryGeneration, 2);
  assert.notEqual(renderer.vao, old.vao);
  assert.notEqual(renderer.buffers.interleaved, old.buffer);
  assert.notEqual(renderer._alphaTexture, old.texture);
  assert.equal(renderer._pendingDataRetirements.size, 1);
  assert.equal(gl._state.buffers.has(old.buffer), true);
  assert.equal(gl._state.textures.has(old.texture), true);

  // Handles repeated in main/full-detail/texture inventories are captured once.
  assert.equal(
    countIdentity(gl._state.deleteAttempts.buffers, old.buffer),
    1,
  );
  assert.equal(
    countIdentity(gl._state.deleteAttempts.vertexArrays, old.vao),
    1,
  );
  assert.equal(
    countIdentity(gl._state.deleteAttempts.textures, old.texture),
    1,
  );
  assert.equal(gl._state.vertexArrays.has(old.vao), false);
  assert.equal(gl._state.buffers.has(old.lodIndexBuffer), false);
  assert.equal(gl._state.buffers.has(old.perViewBuffer), false);
  assert.equal(gl._state.textures.has(old.lodTexture), false);

  gl._state.fail.buffers.clear();
  gl._state.fail.textures.clear();
  assert.deepEqual(renderer._drainDataRetirements(), []);
  assert.equal(renderer._pendingDataRetirements.size, 0);
  assert.equal(gl._state.buffers.has(old.buffer), false);
  assert.equal(gl._state.textures.has(old.texture), false);
  assert.equal(
    countIdentity(gl._state.deleteAttempts.buffers, old.buffer),
    2,
  );
  assert.equal(
    countIdentity(gl._state.deleteAttempts.vertexArrays, old.vao),
    1,
  );
  assert.equal(
    countIdentity(gl._state.deleteAttempts.textures, old.texture),
    2,
  );
});

test('failed loadData candidate rollback retains cleanup failures without touching the old publication', () => {
  const { gl, old, renderer } = createDataRenderer();
  const previous = renderer._captureDataPublication();
  let candidateBuffer = null;
  renderer._createInterleavedBuffer = function createFailingCandidate() {
    candidateBuffer = gl.createBuffer();
    this.buffers.interleaved = candidateBuffer;
    gl._state.fail.buffers.add(candidateBuffer);
  };
  renderer._createAlphaTexture = () => {
    throw new Error('synthetic candidate alpha publication failure');
  };

  assert.throws(
    () => renderer.loadData(
      new Float32Array([-2, 0, 0, 2, 0, 0]),
      new Uint8Array([
        0, 255, 0, 255,
        255, 255, 0, 255,
      ]),
      {
        buildSpatialIndex: false,
        dimensionLevel: 2,
      },
    ),
    error => (
      error instanceof AggregateError &&
      /publication failed.*rollback/i.test(error.message)
    ),
  );

  assert.equal(renderer.vao, previous.vao);
  assert.equal(renderer.buffers, previous.buffers);
  assert.equal(renderer._alphaTexture, previous.alphaTexture);
  assert.equal(renderer._positions, previous.positions);
  assert.equal(renderer._colors, previous.colors);
  assert.equal(renderer._liveGeometryGeneration, 1);
  assert.equal(renderer._interleavedArrayBuffer, null);
  assert.equal(renderer._interleavedPositionView, null);
  assert.equal(renderer._interleavedColorView, null);
  assert.equal(renderer._pendingDataRetirements.size, 1);
  assert.equal(gl._state.buffers.has(old.buffer), true);
  assert.equal(gl._state.vertexArrays.has(old.vao), true);
  assert.equal(gl._state.textures.has(old.texture), true);
  assert.equal(gl._state.buffers.has(candidateBuffer), true);
  assert.equal(
    countIdentity(gl._state.deleteAttempts.buffers, old.buffer),
    0,
  );

  gl._state.fail.buffers.clear();
  assert.deepEqual(renderer._drainDataRetirements(), []);
  assert.equal(renderer._pendingDataRetirements.size, 0);
  assert.equal(gl._state.buffers.has(candidateBuffer), false);
  assert.equal(gl._state.buffers.has(old.buffer), true);
  assert.equal(
    countIdentity(gl._state.deleteAttempts.buffers, candidateBuffer),
    2,
  );
});

test('dispose drains current and pending data attempt-all, retaining only failures for retry', () => {
  const { gl, old, renderer } = createDataRenderer();
  gl._state.fail.buffers.add(old.buffer);
  renderer.loadData(
    new Float32Array([-2, 0, 0, 2, 0, 0]),
    new Uint8Array([
      0, 255, 0, 255,
      255, 255, 0, 255,
    ]),
    {
      buildSpatialIndex: false,
      dimensionLevel: 2,
    },
  );
  const currentBuffer = renderer.buffers.interleaved;
  const currentVao = renderer.vao;
  const currentTexture = renderer._alphaTexture;

  assert.throws(
    () => renderer.dispose(),
    error => (
      error instanceof AggregateError &&
      /pending resource failure/i.test(error.message)
    ),
  );
  assert.equal(renderer._pendingDataRetirements.size, 1);
  assert.equal(gl._state.buffers.has(old.buffer), true);
  assert.equal(gl._state.buffers.has(currentBuffer), false);
  assert.equal(gl._state.vertexArrays.has(currentVao), false);
  assert.equal(gl._state.textures.has(currentTexture), false);
  assert.equal(renderer.buffers.interleaved, null);
  assert.equal(renderer.vao, null);
  assert.equal(renderer._alphaTexture, null);

  gl._state.fail.buffers.clear();
  renderer.dispose();
  assert.equal(renderer._pendingDataRetirements.size, 0);
  assert.equal(gl._state.buffers.size, 0);
  assert.equal(gl._state.vertexArrays.size, 0);
  assert.equal(gl._state.textures.size, 0);
  assert.equal(
    countIdentity(gl._state.deleteAttempts.buffers, currentBuffer),
    1,
  );
  assert.equal(
    countIdentity(gl._state.deleteAttempts.vertexArrays, currentVao),
    1,
  );
  assert.equal(
    countIdentity(gl._state.deleteAttempts.textures, currentTexture),
    1,
  );
});
