/**
 * Worker dispatch pacing: payloads posted without transfer are cloned on this
 * thread, so the pool clones at most DISPATCH_CLONE_BYTES_PER_TASK per task
 * and posts the rest in tasks of their own. Every task still reaches its
 * worker, in order; a transferred payload is never held back.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISPATCH_CLONE_BYTES_PER_TASK,
  WorkerPool,
} from '../assets/js/app/analysis/compute/worker-pool.js';

function installWorkers(t) {
  const original = globalThis.Worker;
  const workers = [];
  class EchoWorker extends EventTarget {
    constructor() {
      super();
      this.received = [];
      workers.push(this);
    }
    postMessage(message) {
      if (message.type === 'INIT') {
        queueMicrotask(() => this.onmessage({ data: { type: 'INIT_ACK', workerId: message.payload.id } }));
        return;
      }
      this.received.push(message.requestId);
      queueMicrotask(() => this.onmessage({ data: { requestId: message.requestId, success: true, result: { ok: true } } }));
    }
    terminate() {}
  }
  globalThis.Worker = EchoWorker;
  t.after(() => {
    if (original === undefined) delete globalThis.Worker;
    else globalThis.Worker = original;
  });
  return workers;
}

const macrotask = () => new Promise(resolve => setTimeout(resolve, 1));

test('a task clones at most its budget; the next dispatch waits for its own task', async t => {
  const workers = installWorkers(t);
  const pool = new WorkerPool({ poolSize: 3 });
  t.after(() => pool.terminate());
  await pool.init();
  const big = new Float32Array(Math.ceil(DISPATCH_CLONE_BYTES_PER_TASK * 0.6 / 4));
  const task = (id, payload, transfer) => {
    const settled = {};
    settled.promise = new Promise((resolve, reject) => Object.assign(settled, { resolve, reject }));
    return { settled, task: { type: 'T', payload, requestId: id, resolve: settled.resolve, reject: settled.reject, timeout: 1000, signal: null, transfer } };
  };
  const a = task('a', { values: big }, false);
  const b = task('b', { values: big }, false);
  const c = task('c', { values: new Float32Array(big.length) }, true);
  pool._dispatchToWorker(0, a.task);
  pool._dispatchToWorker(1, b.task);
  pool._dispatchToWorker(2, c.task);
  assert.deepEqual(workers.map(w => w.received), [['a'], [], ['c']], 'b waits; a transfer is never held back');
  assert.equal(pool.workerStates[1], 'busy', 'the waiting dispatch keeps its worker');
  // Its own task comes after this one, whenever the event loop gets to it.
  for (let turns = 0; workers[1].received.length === 0 && turns < 2000; turns++) await macrotask();
  assert.deepEqual(workers.map(w => w.received), [['a'], ['b'], ['c']]);
  await Promise.all([a.settled.promise, b.settled.promise, c.settled.promise]);
});

test('execute paces through the public path and every task resolves', async t => {
  const workers = installWorkers(t);
  const pool = new WorkerPool({ poolSize: 4 });
  t.after(() => pool.terminate());
  await pool.init();
  const big = new Float32Array(Math.ceil(DISPATCH_CLONE_BYTES_PER_TASK * 0.4 / 4));
  const results = await Promise.all(
    Array.from({ length: 6 }, () => pool.execute('T', { values: big }, { transfer: false }))
  );
  assert.equal(results.length, 6);
  assert.equal(workers.reduce((sum, w) => sum + w.received.length, 0), 6);
});

test('a dispatch aborted while it waits frees its worker', async t => {
  installWorkers(t);
  const pool = new WorkerPool({ poolSize: 2 });
  t.after(() => pool.terminate());
  await pool.init();
  const big = new Float32Array(Math.ceil(DISPATCH_CLONE_BYTES_PER_TASK * 0.6 / 4));
  const controller = new AbortController();
  const first = pool.execute('T', { values: big }, { transfer: false });
  const second = pool.execute('T', { values: big }, { transfer: false, signal: controller.signal });
  // Both reach the pool's dispatch in this task; the second waits for one of
  // its own, and nothing else keeps the process alive until that task runs.
  while (pool._pacedDispatches.length === 0) await Promise.resolve();
  controller.abort();
  await first;
  await assert.rejects(second, error => error.name === 'AbortError');
  assert.deepEqual(pool.workerStates, ['idle', 'idle']);
});
