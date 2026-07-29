import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';

function countIdentity(values, expected) {
  return values.filter(value => value === expected).length;
}

function createRetirementGl() {
  let nextId = 1;
  const liveBuffers = new Set();
  const liveVertexArrays = new Set();
  const events = [];
  const failures = {
    buffers: new Map(),
    vertexArrays: new Map(),
  };

  const create = (kind, live) => {
    const handle = Object.freeze({ id: `${kind}-${nextId++}`, kind });
    live.add(handle);
    return handle;
  };
  const destroy = (kind, handle, live, configuredFailures) => {
    events.push({ handle, kind });
    const behavior = configuredFailures.get(handle) ?? null;
    if (behavior === 'before') {
      throw new Error(`synthetic ${kind} pre-delete failure`);
    }
    live.delete(handle);
    if (behavior === 'after') {
      throw new Error(`synthetic ${kind} post-delete failure`);
    }
  };

  return {
    createBuffer() {
      return create('buffer', liveBuffers);
    },
    createVertexArray() {
      return create('vertex-array', liveVertexArrays);
    },
    deleteBuffer(handle) {
      destroy('buffer', handle, liveBuffers, failures.buffers);
    },
    deleteVertexArray(handle) {
      destroy(
        'vertex-array',
        handle,
        liveVertexArrays,
        failures.vertexArrays,
      );
    },
    isBuffer(handle) {
      return liveBuffers.has(handle);
    },
    isVertexArray(handle) {
      return liveVertexArrays.has(handle);
    },
    _state: {
      events,
      failures,
      liveBuffers,
      liveVertexArrays,
    },
  };
}

function createFixture() {
  const gl = createRetirementGl();
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      gl,
      _liveGeometryGeneration: 7,
      _nextGeometryGeneration: 8,
      _pendingDataRetirements: new Set(),
      _pendingSnapshotRetirements: new Set(),
      _snapshotGeometryPools: new Map(),
      snapshotBuffers: new Map(),
    },
  );
  const positions = Float32Array.from([
    -1, 0, 0,
    1, 0, 0,
  ]);
  const positionBuffer = gl.createBuffer();
  const snapshot = {
    id: 'snapshot-a',
    buffer: gl.createBuffer(),
    bufferByteLength: 8,
    vao: gl.createVertexArray(),
    geometryGeneration: 7,
    positions,
  };
  renderer.snapshotBuffers.set(snapshot.id, snapshot);
  renderer._snapshotGeometryPools.set(7, {
    generation: 7,
    positions,
    positionBuffer,
    positionBufferByteLength: positions.byteLength,
    refCount: 1,
    spatialIndices: new Map(),
  });
  return { gl, positionBuffer, renderer, snapshot };
}

test('final snapshot retirement deletes every VAO before color and pooled position storage', () => {
  const { gl, positionBuffer, renderer, snapshot } =
    createFixture();

  renderer.deleteSnapshotBuffer(snapshot.id);

  assert.deepEqual(
    gl._state.events,
    [
      { handle: snapshot.vao, kind: 'vertex-array' },
      { handle: snapshot.buffer, kind: 'buffer' },
      { handle: positionBuffer, kind: 'buffer' },
    ],
    'the vertex owner must be gone before its referenced storage is deleted',
  );
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  assert.equal(gl._state.liveVertexArrays.size, 0);
  assert.equal(gl._state.liveBuffers.size, 0);
});

test('delete-then-throw snapshot handles settle through exact liveness checks', () => {
  const { gl, positionBuffer, renderer, snapshot } =
    createFixture();
  gl._state.failures.vertexArrays.set(snapshot.vao, 'after');
  gl._state.failures.buffers.set(snapshot.buffer, 'after');
  gl._state.failures.buffers.set(positionBuffer, 'after');

  assert.doesNotThrow(() => renderer.deleteSnapshotBuffer(snapshot.id));

  assert.deepEqual(
    gl._state.events,
    [
      { handle: snapshot.vao, kind: 'vertex-array' },
      { handle: snapshot.buffer, kind: 'buffer' },
      { handle: positionBuffer, kind: 'buffer' },
    ],
  );
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  assert.equal(gl._state.liveVertexArrays.size, 0);
  assert.equal(gl._state.liveBuffers.size, 0);

  // A settled delete-then-throw handle is never attempted a second time.
  renderer.deleteSnapshotBuffer(snapshot.id);
  assert.equal(
    countIdentity(
      gl._state.events.map(event => event.handle),
      snapshot.vao,
    ),
    1,
  );
  assert.equal(
    countIdentity(
      gl._state.events.map(event => event.handle),
      snapshot.buffer,
    ),
    1,
  );
  assert.equal(
    countIdentity(
      gl._state.events.map(event => event.handle),
      positionBuffer,
    ),
    1,
  );
});

test('pre-delete VAO failure retains every referenced owner behind the retry barrier', () => {
  const { gl, positionBuffer, renderer, snapshot } =
    createFixture();
  gl._state.failures.vertexArrays.set(snapshot.vao, 'before');

  assert.throws(
    () => renderer.deleteSnapshotBuffer(snapshot.id),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 1 &&
      /retirement remains pending/i.test(error.message)
    ),
  );

  assert.deepEqual(
    gl._state.events,
    [
      { handle: snapshot.vao, kind: 'vertex-array' },
    ],
  );
  assert.equal(renderer._pendingSnapshotRetirements.size, 1);
  const [retirement] = renderer._pendingSnapshotRetirements;
  assert.strictEqual(retirement.vao, snapshot.vao);
  assert.equal(retirement.buffer, snapshot.buffer);
  assert.equal(retirement.geometryGeneration, 7);
  assert.equal(renderer._snapshotGeometryPools.size, 1);
  assert.equal(
    renderer._snapshotGeometryPools.get(7).refCount,
    1,
  );
  assert.equal(gl._state.liveVertexArrays.has(snapshot.vao), true);
  assert.equal(gl._state.liveBuffers.has(snapshot.buffer), true);
  assert.equal(gl._state.liveBuffers.has(positionBuffer), true);

  gl._state.failures.vertexArrays.delete(snapshot.vao);
  assert.doesNotThrow(() => renderer.deleteSnapshotBuffer(snapshot.id));
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  assert.equal(gl._state.liveVertexArrays.size, 0);
  assert.equal(
    countIdentity(
      gl._state.events.map(event => event.handle),
      snapshot.vao,
    ),
    2,
  );
  assert.equal(
    countIdentity(
      gl._state.events.map(event => event.handle),
      snapshot.buffer,
    ),
    1,
  );
  assert.equal(
    countIdentity(
      gl._state.events.map(event => event.handle),
      positionBuffer,
    ),
    1,
  );
});

test('shared position storage retires only after the last referencing VAO', () => {
  const { gl, positionBuffer, renderer, snapshot } =
    createFixture();
  const second = {
    id: 'snapshot-b',
    buffer: gl.createBuffer(),
    bufferByteLength: 8,
    vao: gl.createVertexArray(),
    geometryGeneration: snapshot.geometryGeneration,
    positions: snapshot.positions,
  };
  renderer.snapshotBuffers.set(second.id, second);
  renderer._snapshotGeometryPools.get(7).refCount = 2;

  renderer.deleteSnapshotBuffer(snapshot.id);
  assert.deepEqual(gl._state.events, [
    { handle: snapshot.vao, kind: 'vertex-array' },
    { handle: snapshot.buffer, kind: 'buffer' },
  ]);
  assert.equal(renderer._snapshotGeometryPools.get(7).refCount, 1);
  assert.equal(gl._state.liveBuffers.has(positionBuffer), true);

  renderer.deleteSnapshotBuffer(second.id);
  assert.deepEqual(gl._state.events, [
    { handle: snapshot.vao, kind: 'vertex-array' },
    { handle: snapshot.buffer, kind: 'buffer' },
    { handle: second.vao, kind: 'vertex-array' },
    { handle: second.buffer, kind: 'buffer' },
    { handle: positionBuffer, kind: 'buffer' },
  ]);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  assert.equal(gl._state.liveBuffers.size, 0);
});
