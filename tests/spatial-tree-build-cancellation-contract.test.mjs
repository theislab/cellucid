/**
 * A background spatial-tree build belongs to the positions it was asked for.
 * When a dataset or representation replaces them (or the kept view showing
 * them is removed), the build is dropped: the worker answers one message at
 * a time, so the new positions' tree otherwise waited behind the old build
 * while the new data drew without culling or LOD, the main thread kept
 * posting the old positions' slices, and the build's closures kept the old
 * positions alive until the worker answered.
 */
import { DEFAULT_CELL_PRIORITY } from '../assets/js/data/cell-priority.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { HighPerfRenderer } from '../assets/js/rendering/high-perf-renderer.js';
import { createCpuPermuter } from './helpers/cpu-permuter.mjs';

class FakeWorker extends EventTarget {
  static made = [];
  constructor() {
    super();
    this.posted = [];
    this.terminated = false;
    FakeWorker.made.push(this);
  }
  postMessage(message) {
    this.posted.push(message.kind);
  }
  terminate() {
    this.terminated = true;
  }
}

function makeRenderer(positions) {
  const renderer = Object.create(HighPerfRenderer.prototype);
  Object.assign(renderer, {
    options: { LOD_MAX_POINTS_PER_NODE: 64, LOD_MAX_DEPTH: 8 },
    _positions: positions,
    snapshotBuffers: new Map(),
    _spatialTreeWorker: null,
    // A build request starts compiling the adoption's GPU passes.
    _permuter: createCpuPermuter(null),
  });
  return renderer;
}

function build(renderer, positions) {
  const outcome = { done: 0, failed: 0, cancelled: 0 };
  renderer._buildSpatialTreeJob(
    positions, 3, true, DEFAULT_CELL_PRIORITY,
    () => { outcome.done += 1; },
    () => { outcome.failed += 1; },
    () => { outcome.cancelled += 1; },
  );
  return outcome;
}

test('a build whose positions were replaced is dropped, and the worker with it', async t => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  t.after(() => { globalThis.Worker = previousWorker; });
  const old = new Float32Array(30);
  const renderer = makeRenderer(old);
  const outcome = build(renderer, old);
  const worker = FakeWorker.made.at(-1);
  // The positions are copied in tasks of their own, not in the one that asked.
  assert.deepEqual(worker.posted, []);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(worker.posted, ['positions', 'build']);

  // Still drawn: nothing is dropped.
  renderer._cancelStaleSpatialTreeBuilds();
  assert.equal(worker.terminated, false);

  // Another dataset replaces the positions.
  renderer._positions = new Float32Array(30);
  renderer._cancelStaleSpatialTreeBuilds();
  assert.equal(worker.terminated, true);
  assert.deepEqual(outcome, { done: 0, failed: 0, cancelled: 1 }, 'dropped, not failed');
  assert.equal(renderer._spatialTreeRequests.size, 0);
  assert.equal(renderer._spatialTreeWorker, null);

  // The next build starts a fresh worker.
  build(renderer, renderer._positions);
  assert.notEqual(FakeWorker.made.at(-1), worker);
});

test('a build for positions a kept view still draws is kept', t => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  t.after(() => { globalThis.Worker = previousWorker; });
  const kept = new Float32Array(30);
  const renderer = makeRenderer(kept);
  const outcome = build(renderer, kept);
  renderer.snapshotBuffers.set('snapshot-1', { positions: kept });
  renderer._positions = new Float32Array(30);
  renderer._cancelStaleSpatialTreeBuilds();
  assert.equal(FakeWorker.made.at(-1).terminated, false);
  assert.deepEqual(outcome, { done: 0, failed: 0, cancelled: 0 });
});

test('a build dropped before its first slice was sent sends nothing', async t => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  t.after(() => { globalThis.Worker = previousWorker; });
  const old = new Float32Array(30);
  const renderer = makeRenderer(old);
  const outcome = build(renderer, old);
  const worker = FakeWorker.made.at(-1);
  renderer._positions = new Float32Array(30);
  renderer._cancelStaleSpatialTreeBuilds();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(worker.posted, []);
  assert.deepEqual(outcome, { done: 0, failed: 0, cancelled: 1 });
});

test('one build at a time: a second geometry\'s positions are sent only once the worker answered the first', async t => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  t.after(() => { globalThis.Worker = previousWorker; });
  const first = new Float32Array(30);
  const second = new Float32Array(30);
  const renderer = makeRenderer(first);
  renderer.snapshotBuffers.set('snap_1', { positions: second });
  const firstOutcome = build(renderer, first);
  const secondOutcome = build(renderer, second);
  const worker = FakeWorker.made.at(-1);
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  // Only the first geometry is in the worker; the second waits on this side.
  assert.deepEqual(worker.posted, ['positions', 'build']);
  assert.equal(renderer._spatialTreeQueue.length, 1);
  // The worker answers the first (here, with a failure: nothing to decode).
  worker.onmessage({ data: { id: 1, error: 'stub' } });
  assert.deepEqual(firstOutcome, { done: 0, failed: 1, cancelled: 0 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(worker.posted, ['positions', 'build', 'positions', 'build']);
  worker.onmessage({ data: { id: 2, error: 'stub' } });
  assert.deepEqual(secondOutcome, { done: 0, failed: 1, cancelled: 0 });
  assert.equal(renderer._spatialTreeActive, null);
});

test('a worker whose code does not load fails its builds once, saying so, and the next build starts a new one', async t => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  t.after(() => { globalThis.Worker = previousWorker; });
  const positions = new Float32Array(30);
  const renderer = makeRenderer(positions);
  const errors = [];
  renderer._buildSpatialTreeJob(
    positions, 3, true, DEFAULT_CELL_PRIORITY,
    () => assert.fail('nothing was built'),
    error => errors.push(error.message),
    () => assert.fail('nothing was dropped'),
  );
  const worker = FakeWorker.made.at(-1);
  // Its script did not load (offline, say): a plain Event, no message.
  worker.onerror(new Event('error'));
  assert.deepEqual(errors, ['Background spatial index worker failed: its code could not be loaded']);
  // Retired: kept, every later build was posted to it and never answered.
  assert.equal(worker.terminated, true);
  assert.equal(renderer._spatialTreeWorker, null);
  assert.equal(renderer._spatialTreeActive, null);
  // An error of the retired worker arriving late fails nothing more.
  build(renderer, positions);
  const next = FakeWorker.made.at(-1);
  assert.notEqual(next, worker);
  worker.onerror(new Event('error'));
  assert.equal(renderer._spatialTreeWorker, next);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(next.posted, ['positions', 'build']);
});

test('a worker failure is said as what it is: the worker\'s own error, or code that could not be loaded (offline when it is)', async () => {
  const { workerFailureReason } = await import('../assets/js/workers/worker-failure.js');
  assert.equal(workerFailureReason({ message: 'RangeError: too many cells' }), 'RangeError: too many cells');
  assert.equal(workerFailureReason(new Event('error'), { navigator: { onLine: true } }), 'its code could not be loaded');
  assert.equal(workerFailureReason(new Event('error'), { navigator: { onLine: false } }), 'its code could not be loaded: this browser is offline');
  assert.equal(workerFailureReason(null, {}), 'its code could not be loaded');
  assert.equal(workerFailureReason({ message: '  ' }, {}), 'its code could not be loaded');
});
