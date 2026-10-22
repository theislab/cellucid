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

test('final snapshot retirement deletes its VAO before colour storage and retains the pooled positions', () => {
  const { gl, positionBuffer, renderer, snapshot } =
    createFixture();

  renderer.deleteSnapshotBuffer(snapshot.id);

  assert.deepEqual(
    gl._state.events,
    [
      { handle: snapshot.vao, kind: 'vertex-array' },
      { handle: snapshot.buffer, kind: 'buffer' },
    ],
    'the vertex owner must be gone before its referenced storage is deleted',
  );
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  // No view shows the geometry now: it stays retained, within budget, so
  // showing the representation again costs no upload.
  assert.equal(renderer._snapshotGeometryPools.size, 1);
  const retained = renderer._snapshotGeometryPools.get(7);
  assert.equal(retained.refCount, 0);
  assert.equal(retained.retained, true);
  assert.equal(retained.positionBuffer, positionBuffer);
  assert.equal(renderer.getRetainedGeometryBytes(), retained.positionBufferByteLength);
  assert.equal(gl._state.liveVertexArrays.size, 0);
  assert.deepEqual([...gl._state.liveBuffers], [positionBuffer]);

  // Evicting it deletes the storage, once, after every VAO that drew it.
  const retainedBytes = retained.positionBufferByteLength;
  assert.equal(renderer.evictRetainedGeometry(Infinity), retainedBytes);
  assert.deepEqual(gl._state.events.at(-1), { handle: positionBuffer, kind: 'buffer' });
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  assert.equal(renderer._pendingDataRetirements.size, 0);
  assert.equal(gl._state.liveBuffers.size, 0);
  assert.equal(renderer.getRetainedGeometryBytes(), 0);
});

test('delete-then-throw snapshot handles settle through exact liveness checks', () => {
  const { gl, positionBuffer, renderer, snapshot } =
    createFixture();
  gl._state.failures.vertexArrays.set(snapshot.vao, 'after');
  gl._state.failures.buffers.set(snapshot.buffer, 'after');
  gl._state.failures.buffers.set(positionBuffer, 'after');

  assert.doesNotThrow(() => renderer.deleteSnapshotBuffer(snapshot.id));
  // The retained position storage is deleted on eviction, through the same
  // liveness settlement.
  assert.doesNotThrow(() => renderer.evictRetainedGeometry(Infinity));

  assert.deepEqual(
    gl._state.events,
    [
      { handle: snapshot.vao, kind: 'vertex-array' },
      { handle: snapshot.buffer, kind: 'buffer' },
      { handle: positionBuffer, kind: 'buffer' },
    ],
  );
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  assert.equal(renderer._pendingDataRetirements.size, 0);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  assert.equal(gl._state.liveVertexArrays.size, 0);
  assert.equal(gl._state.liveBuffers.size, 0);

  // A settled delete-then-throw handle is never attempted a second time.
  renderer.deleteSnapshotBuffer(snapshot.id);
  renderer.evictRetainedGeometry(Infinity);
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
  // Only once the VAO is truly gone does the geometry become retained, and
  // only eviction deletes it.
  assert.equal(renderer._snapshotGeometryPools.get(7).refCount, 0);
  assert.equal(gl._state.liveBuffers.has(positionBuffer), true);
  renderer.evictRetainedGeometry(Infinity);
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
  ]);
  assert.equal(renderer._snapshotGeometryPools.get(7).refCount, 0);
  assert.equal(gl._state.liveBuffers.has(positionBuffer), true);

  renderer.evictRetainedGeometry(Infinity);
  assert.deepEqual(gl._state.events.at(-1), { handle: positionBuffer, kind: 'buffer' });
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  assert.equal(gl._state.liveBuffers.size, 0);
});

test('a retained geometry inside the budget survives; over the budget the least recently used goes first', () => {
  const { gl, positionBuffer, renderer, snapshot } = createFixture();
  renderer.deleteSnapshotBuffer(snapshot.id);
  const older = renderer._snapshotGeometryPools.get(7);
  older.lastUsed = 1;
  // Within budget (at least 64 MiB), a budget pass keeps it.
  assert.equal(renderer.evictRetainedGeometry(), 0);
  assert.equal(gl._state.liveBuffers.has(positionBuffer), true);

  const newerBuffer = gl.createBuffer();
  renderer._snapshotGeometryPools.set(9, {
    generation: 9,
    dimension: 3,
    positions: new Float32Array(6),
    positionBuffer: newerBuffer,
    positionBufferByteLength: 24,
    borrowsLivePositionBuffer: false,
    refCount: 0,
    retained: true,
    lastUsed: 2,
    spatialIndices: new Map(),
  });
  // Asking for the whole budget as headroom leaves room for nothing retained:
  // the oldest goes first, then the next.
  const budget = renderer._geometryRetentionBudget();
  const olderBytes = older.positionBufferByteLength;
  assert.equal(renderer.evictRetainedGeometry(budget - 24), olderBytes);
  assert.equal(gl._state.liveBuffers.has(positionBuffer), false);
  assert.equal(gl._state.liveBuffers.has(newerBuffer), true);
  assert.equal(renderer.evictRetainedGeometry(budget), 24);
  assert.equal(gl._state.liveBuffers.has(newerBuffer), false);
});

test('releasing one evicted positions array drops only its retained geometry', () => {
  const { gl, positionBuffer, renderer, snapshot } = createFixture();
  renderer.deleteSnapshotBuffer(snapshot.id);
  assert.equal(renderer.releaseRetainedGeometryFor(new Float32Array(6)), 0);
  assert.equal(gl._state.liveBuffers.has(positionBuffer), true);
  assert.equal(
    renderer.releaseRetainedGeometryFor(snapshot.positions),
    snapshot.positions.byteLength,
  );
  assert.equal(gl._state.liveBuffers.has(positionBuffer), false);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
});

test('a geometry the live view borrows is never deleted by eviction', () => {
  const { gl, positionBuffer, renderer, snapshot } = createFixture();
  renderer._snapshotGeometryPools.get(7).borrowsLivePositionBuffer = true;
  renderer.deleteSnapshotBuffer(snapshot.id);
  assert.equal(renderer.getRetainedGeometryBytes(), 0, 'live-owned storage is not retained storage');
  renderer.evictRetainedGeometry(Infinity);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  assert.equal(gl._state.liveBuffers.has(positionBuffer), true);
});
