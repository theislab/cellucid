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
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
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
    bufferData(_target, data) {
      gl._state.uploads.push(data);
      if (gl._state.failAttributes) {
        // Accepted upload; the failure is staged for the attribute binding.
      }
    },
    enableVertexAttribArray() {},
    vertexAttribPointer() {
      if (gl._state.failAttributes) {
        throw new Error('synthetic attribute binding failure');
      }
    },
    FLOAT: 0x1406,
    STATIC_DRAW: 0x88e4,
    UNSIGNED_BYTE: 0x1401,
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
    getParameter(parameter) {
      if (parameter === gl.MAX_ARRAY_TEXTURE_LAYERS) return 256;
      assert.equal(parameter, gl.MAX_TEXTURE_SIZE);
      return 16_384;
    },
    _state: {
      failAttributes: false,
      uploads: [],
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
    colorBuffer: gl.createBuffer(),
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
    positions: old.buffer,
    colors: old.colorBuffer,
  };
  // The live store held a draw order; its permutation texture retires with
  // the publication.
  const liveOrder = {
    drawOrder: Object.freeze({ indices: Uint32Array.from([1, 0]), pointCount: 2 }),
    texture: old.lodTexture,
    byteLength: 8,
    width: 2,
    height: 1,
  };
  const perViewState = new Map([
    ['live', { cull: null }],
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
    _liveOrder: liveOrder,
    _liveColorOrder: liveOrder.drawOrder,
    spatialIndices: new Map(),
    _perViewState: perViewState,
    currentDimensionLevel: 3,
    _liveGeometryGeneration: 1,
    _nextGeometryGeneration: 2,
    pointCount: 2,
    _positions: positions,
    _colors: colors,
    _firstRenderDone: true,
    _boundingSphere: { radius: 1 },
    _colorsDirty: false,
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
  });

  renderer._createPointStreams = function createCandidateBuffers() {
    this.buffers.positions = gl.createBuffer();
    this.buffers.colors = gl.createBuffer();
  };
  renderer._createAlphaTexture = function createCandidateAlphaTexture() {
    this._alphaTexture = gl.createTexture();
    this._alphaTexWidth = 2;
    this._alphaTexHeight = 1;
    this._alphaTexData = new Uint8Array([255, 255]);
  };
  renderer._computeBoundingSphere = () => ({ radius: 2 });

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
  // A 2D publication: two components per point.
  const nextPositions = new Float32Array([
    -2, 0,
    2, 0,
  ]);
  const nextColors = new Uint8Array([
    0, 255, 0, 255,
    255, 255, 0, 255,
  ]);
  gl._state.fail.buffers.add(old.buffer);
  gl._state.fail.textures.add(old.texture);

  const stats = renderer.loadData(nextPositions, nextColors, {
    dimensionLevel: 2,
  });

  assert.equal(stats, renderer.stats);
  assert.equal(renderer._positions, nextPositions);
  assert.equal(renderer._colors, nextColors);
  assert.equal(renderer.currentDimensionLevel, 2);
  assert.equal(renderer._liveGeometryGeneration, 2);
  assert.notEqual(renderer.vao, old.vao);
  assert.notEqual(renderer.buffers.positions, old.buffer);
  assert.notEqual(renderer.buffers.colors, old.colorBuffer);
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
  assert.equal(gl._state.buffers.has(old.colorBuffer), false);
  assert.equal(
    countIdentity(gl._state.deleteAttempts.buffers, old.colorBuffer),
    1,
  );
  assert.equal(gl._state.textures.has(old.lodTexture), false, 'the old permutation retires');

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
  renderer._createPointStreams = function createFailingCandidate() {
    candidateBuffer = gl.createBuffer();
    this.buffers.positions = candidateBuffer;
    gl._state.fail.buffers.add(candidateBuffer);
  };
  renderer._createAlphaTexture = () => {
    throw new Error('synthetic candidate alpha publication failure');
  };

  assert.throws(
    () => renderer.loadData(
      new Float32Array([-2, 0, 2, 0]),
      new Uint8Array([
        0, 255, 0, 255,
        255, 255, 0, 255,
      ]),
      {
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
    new Float32Array([-2, 0, 2, 0]),
    new Uint8Array([
      0, 255, 0, 255,
      255, 255, 0, 255,
    ]),
    {
      dimensionLevel: 2,
    },
  );
  const currentBuffer = renderer.buffers.positions;
  const currentColorBuffer = renderer.buffers.colors;
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
  assert.equal(gl._state.buffers.has(currentColorBuffer), false);
  assert.equal(gl._state.vertexArrays.has(currentVao), false);
  assert.equal(gl._state.textures.has(currentTexture), false);
  assert.equal(renderer.buffers.positions, null);
  assert.equal(renderer.buffers.colors, null);
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

/**
 * A live representation switch (`updatePositions`) on the same harness. The
 * live store holds a draw order (`old.lodTexture` is its permutation).
 */
function createSwitchRenderer() {
  return createDataRenderer();
}

test('a live representation switch keeps per-cell owners and retains the geometry it leaves', () => {
  const { gl, old, positions, colors, renderer } = createSwitchRenderer();
  const alphas = renderer._currentAlphas;
  const flat = new Float32Array([-2, 0, 2, 0]);

  renderer.updatePositions(flat, 2);

  assert.equal(renderer._positions, flat);
  assert.equal(renderer.currentDimensionLevel, 2);
  assert.equal(renderer._colors, colors);
  assert.equal(renderer.buffers.colors, old.colorBuffer);
  assert.equal(renderer._alphaTexture, old.texture);
  assert.equal(renderer._currentAlphas, alphas);
  assert.notEqual(renderer.vao, old.vao);
  assert.notEqual(renderer.buffers.positions, old.buffer);
  assert.deepEqual(gl._state.uploads, [flat], 'only the new positions are uploaded');
  assert.equal(renderer._liveGeometryGeneration, 2);
  // The previous publication's VAO retires; its colour buffer and alpha
  // texture moved, and its positions are retained in the draw order they
  // hold, with the permutation that order needs.
  assert.equal(gl._state.vertexArrays.has(old.vao), false);
  assert.equal(gl._state.textures.has(old.lodTexture), true, 'the retained store keeps its permutation');
  assert.equal(gl._state.buffers.has(old.colorBuffer), true);
  assert.equal(gl._state.textures.has(old.texture), true);
  assert.equal(gl._state.buffers.has(old.buffer), true);
  const retained = renderer._snapshotGeometryPools.get(1);
  assert.equal(retained.positions, positions);
  assert.equal(retained.positionBuffer, old.buffer);
  assert.equal(retained.refCount, 0);
  assert.equal(retained.retained, true);
  assert.equal(retained.positionBufferByteLength, positions.byteLength);
  assert.equal(retained.order.texture, old.lodTexture);
  assert.equal(renderer._liveOrder, null, 'the new upload is in source order until its tree lands');
  assert.equal(
    renderer.getRetainedGeometryBytes(),
    positions.byteLength + retained.order.byteLength,
  );
});

test('switching the live view back adopts the retained geometry without an upload', () => {
  const { gl, old, positions, renderer } = createSwitchRenderer();
  const flat = new Float32Array([-2, 0, 2, 0]);
  renderer.updatePositions(flat, 2);
  const flatBuffer = renderer.buffers.positions;
  const uploads = gl._state.uploads.length;

  renderer.updatePositions(positions, 3);

  assert.equal(gl._state.uploads.length, uploads, 'a retained representation needs no upload');
  assert.equal(renderer.buffers.positions, old.buffer);
  assert.equal(renderer._liveGeometryGeneration, 1);
  assert.equal(renderer.currentDimensionLevel, 3);
  const adopted = renderer._snapshotGeometryPools.get(1);
  assert.equal(adopted.borrowsLivePositionBuffer, true);
  assert.equal(adopted.retained, false);
  // The 2D geometry it left is retained in turn, and neither buffer is lost.
  const left = renderer._snapshotGeometryPools.get(2);
  assert.equal(left.positions, flat);
  assert.equal(left.positionBuffer, flatBuffer);
  assert.equal(left.refCount, 0);
  assert.equal(gl._state.buffers.has(flatBuffer), true);
  assert.equal(gl._state.buffers.has(old.buffer), true);
  // Live storage is not retained storage: only the 2D buffer counts.
  assert.equal(renderer.getRetainedGeometryBytes(), flat.byteLength);

  // A kept view of the 2D representation now shares its geometry.
  const acquired = renderer._acquireSnapshotGeometryForPositions(flat, 2);
  assert.equal(acquired, left);
  assert.equal(left.refCount, 1);
  assert.equal(gl._state.uploads.length, uploads);
});

test('the same positions republished to the live view change nothing', () => {
  const { gl, old, positions, renderer } = createSwitchRenderer();
  const vao = renderer.vao;
  renderer.updatePositions(positions, 3);
  assert.equal(renderer.vao, vao);
  assert.equal(renderer.buffers.positions, old.buffer);
  assert.deepEqual(gl._state.uploads, []);
  assert.equal(renderer._pendingDataRetirements.size, 0);
});

test('a failed live switch restores the previous publication and retires only what it created', () => {
  const { gl, old, positions, renderer } = createSwitchRenderer();
  const previous = renderer._captureDataPublication();
  gl._state.failAttributes = true;

  assert.throws(
    () => renderer.updatePositions(new Float32Array([-2, 0, 2, 0]), 2),
    /synthetic attribute binding failure/,
  );

  assert.equal(renderer.vao, previous.vao);
  assert.equal(renderer.buffers, previous.buffers);
  assert.equal(renderer._alphaTexture, old.texture);
  assert.equal(renderer._positions, positions);
  assert.equal(renderer.currentDimensionLevel, 3);
  assert.equal(renderer._liveGeometryGeneration, 1);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  // The candidate's VAO and its uploaded position buffer are deleted; every
  // previous owner -- colour, alpha, positions, VAO -- is untouched.
  const [candidateUpload] = gl._state.uploads;
  assert.ok(candidateUpload instanceof Float32Array);
  for (const handle of [old.buffer, old.colorBuffer]) {
    assert.equal(gl._state.buffers.has(handle), true);
  }
  assert.equal(gl._state.vertexArrays.has(old.vao), true);
  assert.equal(gl._state.textures.has(old.texture), true);
  assert.equal(gl._state.buffers.size, 2, 'only the previous publication\'s buffers remain');
  assert.equal(gl._state.textures.has(old.lodTexture), true, 'the live permutation is untouched');
  assert.equal(gl._state.vertexArrays.size, 1);
  assert.equal(renderer._pendingDataRetirements.size, 0);
});
