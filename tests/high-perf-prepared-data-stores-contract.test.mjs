/**
 * A dataset's GPU stores can be allocated ahead of its publication
 * (`HighPerfRenderer.prepareDataStores`), in a task of their own: WebGL
 * reports a refused allocation only through `getError`, which waits for the
 * GPU, so the wait is spent there and the publication itself reads no error
 * back. The publication adopts exactly the stores made for its size and
 * dimension, writes its values into them, and releases any it cannot use.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { HighPerfRenderer } from '../assets/js/rendering/high-perf-renderer.js';

function createRecordingGl({ refuse = null } = {}) {
  let nextId = 1;
  const calls = { bufferData: [], bufferSubData: [], texStorage3D: [], texSubImage3D: [], getError: 0, deleted: [] };
  let pendingError = 0;
  const gl = {
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    RED: 0x1903,
    R8: 0x8229,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    TEXTURE_2D: 0x0de1,
    TEXTURE_2D_ARRAY: 0x8c1a,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
    NO_ERROR: 0,
    OUT_OF_MEMORY: 0x0505,
    createBuffer: () => ({ id: nextId++, kind: 'buffer' }),
    createTexture: () => ({ id: nextId++, kind: 'texture' }),
    createVertexArray: () => ({ id: nextId++, kind: 'vao' }),
    bindBuffer() {},
    bindTexture() {},
    bindVertexArray() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    texParameteri() {},
    bufferData(_target, dataOrSize, usage) {
      calls.bufferData.push({ size: typeof dataOrSize === 'number' ? dataOrSize : dataOrSize.byteLength, usage });
      if (refuse === 'buffer') pendingError = gl.OUT_OF_MEMORY;
    },
    bufferSubData(_target, offset, data) {
      calls.bufferSubData.push({ offset, bytes: data.byteLength });
    },
    texStorage3D(...args) {
      calls.texStorage3D.push(args);
      if (refuse === 'texture') pendingError = gl.OUT_OF_MEMORY;
    },
    texSubImage3D(...args) {
      calls.texSubImage3D.push(args);
    },
    getError() {
      calls.getError += 1;
      const code = pendingError;
      pendingError = 0;
      return code;
    },
    getParameter(parameter) {
      if (parameter === gl.MAX_TEXTURE_SIZE) return 16_384;
      if (parameter === gl.MAX_ARRAY_TEXTURE_LAYERS) return 256;
      throw new Error(`unexpected getParameter(${parameter})`);
    },
    isContextLost: () => false,
    deleteBuffer(handle) { calls.deleted.push(handle); },
    deleteTexture(handle) { calls.deleted.push(handle); },
    deleteVertexArray(handle) { calls.deleted.push(handle); },
  };
  return { gl, calls };
}

function createRenderer(gl) {
  const renderer = Object.create(HighPerfRenderer.prototype);
  Object.assign(renderer, {
    gl,
    buffers: { positions: null, colors: null },
    vao: gl.createVertexArray(),
    pointCount: 0,
    stats: { gpuMemoryMB: 0 },
    snapshotBuffers: new Map(),
    _preparedDataStores: null,
    _pendingDataRetirements: new Set(),
    _pendingSnapshotRetirements: new Set(),
    _snapshotGeometryPools: new Map(),
  });
  renderer._assertOperational = () => {};
  renderer._refreshGpuMemoryStats = () => 0;
  renderer.getRetainedGeometryBytes = () => 0;
  renderer.getKeptColorBytes = () => 0;
  renderer._dormantSnapshotStoreBytes = () => 0;
  return renderer;
}

test('prepared stores are adopted by the publication of exactly their dataset, with no allocation and no error read back', () => {
  const { gl, calls } = createRecordingGl();
  const renderer = createRenderer(gl);
  const pointCount = 5;
  renderer.prepareDataStores(pointCount, 3);
  assert.deepEqual(calls.bufferData.map(call => call.size), [pointCount * 12, pointCount * 4]);
  assert.equal(calls.texStorage3D.length, 1);
  const prepared = renderer._preparedDataStores;
  const { positions: positionBuffer, colors: colorBuffer } = prepared.buffers;
  const alphaTexture = prepared.alphaTexture;

  const taken = renderer._takePreparedDataStores(pointCount, 3);
  assert.equal(renderer._preparedDataStores, null);
  calls.bufferData.length = 0;
  calls.texStorage3D.length = 0;
  calls.getError = 0;
  const positions = new Float32Array(pointCount * 3).map((_, i) => i);
  const colors = new Uint8Array(pointCount * 4).fill(9);
  renderer._createPointStreams(positions, colors, 3, taken);
  renderer._alphaTexture = null;
  renderer._alphaTexData = null;
  renderer._queueDataRetirement = () => {};
  renderer._drainDataRetirements = () => [];
  renderer._createAlphaTexture(pointCount, Uint8Array.of(1, 0, 1, 1, 0), taken);

  assert.equal(renderer.buffers.positions, positionBuffer);
  assert.equal(renderer.buffers.colors, colorBuffer);
  assert.equal(renderer._alphaTexture, alphaTexture);
  assert.equal(calls.bufferData.length, 0, 'nothing allocated');
  assert.equal(calls.texStorage3D.length, 0, 'no texture allocated');
  assert.equal(calls.getError, 0, 'no error read back');
  assert.equal(calls.texSubImage3D.length, 1, 'the alpha values are written once');
  assert.deepEqual([...renderer._alphaTexData.subarray(0, pointCount)], [255, 0, 255, 255, 0]);
  // The positions cross when first needed, the colors in the first frame.
  assert.equal(renderer._positionsUploadPending, true);
  assert.equal(renderer._colorsDirty, true);
  renderer._positions = positions;
  renderer._flushPendingPositionUpload();
  assert.deepEqual(calls.bufferSubData, [{ offset: 0, bytes: positions.byteLength }]);
});

test('stores prepared for another size or dimension are released, not adopted', () => {
  const { gl, calls } = createRecordingGl();
  const renderer = createRenderer(gl);
  renderer.prepareDataStores(4, 2);
  const prepared = renderer._preparedDataStores;
  const handles = [prepared.buffers.positions, prepared.buffers.colors, prepared.alphaTexture];
  assert.equal(renderer._takePreparedDataStores(4, 3), null);
  assert.equal(renderer._preparedDataStores, null);
  for (const handle of handles) assert.ok(calls.deleted.includes(handle), `released ${handle.kind}`);

  renderer.prepareDataStores(6, 3);
  const second = renderer._preparedDataStores;
  renderer.prepareDataStores(6, 3);
  assert.ok(calls.deleted.includes(second.buffers.positions), 'a new preparation replaces the previous one');
  renderer.releasePreparedDataStores();
  assert.equal(renderer._preparedDataStores, null);
});

test('a dataset the device cannot hold is refused when it is prepared, and nothing is kept', () => {
  for (const refuse of ['buffer', 'texture']) {
    const { gl, calls } = createRecordingGl({ refuse });
    const renderer = createRenderer(gl);
    assert.throws(() => renderer.prepareDataStores(8, 3), /could not allocate/);
    assert.equal(renderer._preparedDataStores, null);
    assert.ok(calls.deleted.length >= 2, `${refuse}: the stores made are released`);
  }
});
