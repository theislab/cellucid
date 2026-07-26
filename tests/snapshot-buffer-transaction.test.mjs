import assert from 'node:assert/strict';
import test from 'node:test';

import { HighPerfRenderer } from '../assets/js/rendering/high-perf-renderer.js';

function createFakeGl() {
  let nextId = 1;
  let arrayBufferBinding = null;
  let vertexArrayBinding = null;
  const buffers = new Set();
  const vertexArrays = new Set();
  const deletedBuffers = [];
  const deletedVertexArrays = [];

  const gl = {
    NO_ERROR: 0,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88E4,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    failUpload: false,
    createBuffer() {
      const buffer = { kind: 'buffer', id: nextId++ };
      buffers.add(buffer);
      return buffer;
    },
    createVertexArray() {
      const vertexArray = { kind: 'vertex-array', id: nextId++ };
      vertexArrays.add(vertexArray);
      return vertexArray;
    },
    bindBuffer(target, buffer) {
      assert.equal(target, gl.ARRAY_BUFFER);
      arrayBufferBinding = buffer;
    },
    bindVertexArray(vertexArray) {
      vertexArrayBinding = vertexArray;
    },
    bufferData(target) {
      assert.equal(target, gl.ARRAY_BUFFER);
      if (gl.failUpload) {
        throw new Error('synthetic snapshot upload failure');
      }
    },
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    deleteBuffer(buffer) {
      buffers.delete(buffer);
      deletedBuffers.push(buffer);
      if (arrayBufferBinding === buffer) arrayBufferBinding = null;
    },
    deleteVertexArray(vertexArray) {
      vertexArrays.delete(vertexArray);
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
  const buffer = gl.createBuffer();
  const vao = gl.createVertexArray();

  renderer.gl = gl;
  renderer.pointCount = 2;
  renderer._positions = positions;
  renderer.useAdaptiveLOD = false;
  renderer.useFrustumCulling = false;
  renderer.forceLODLevel = -1;
  renderer._perViewState = new Map();
  renderer.snapshotBuffers = new Map([
    ['snap_1', {
      id: 'snap_1',
      vao,
      buffer,
      pointCount: 2,
      positions,
      colors,
      bounds: HighPerfRenderer.computeBoundsFromPositions(positions),
      spatialIndex: null,
      dimensionLevel: 3,
    }],
  ]);
  return { gl, renderer };
}

test('snapshot GPU upload failure preserves the complete published resource set', () => {
  const { gl, renderer } = createRenderer();
  const before = renderer.snapshotBuffers.get('snap_1');
  const beforeRecord = { ...before };
  const replacementColors = new Uint8Array([
    0, 255, 0, 255,
    255, 255, 0, 255,
  ]);

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
  assert.equal(gl._state.buffers.size, 1);
  assert.equal(gl._state.vertexArrays.size, 1);
  assert.equal(gl._state.arrayBufferBinding, null);
  assert.equal(gl._state.vertexArrayBinding, null);
});

test('snapshot GPU publication swaps both resources exactly once', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const previousBuffer = snapshot.buffer;
  const previousVao = snapshot.vao;
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
  assert.equal(gl._state.buffers.size, 1);
  assert.equal(gl._state.vertexArrays.size, 1);
});
