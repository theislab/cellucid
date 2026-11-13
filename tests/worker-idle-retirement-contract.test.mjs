/**
 * One lifetime rule for the app's worker pools (`workers/idle-retirement.js`)
 * and the analysis pool's memory:
 *
 * - workers with nothing to do for `WORKER_IDLE_MS` end, and start again for
 *   the next task, with the same count; a pool keeping state for a run
 *   (`retainAs`) or with a task under way keeps its workers;
 * - a hidden or frozen page ends every idle worker at once
 *   (`retireIdleWorkers`);
 * - the analysis pool runs no more workers than the `analysis` share holds
 *   a run's per-cell state for, and the state a run keeps in the workers is
 *   counted in that share (every worker's copy), so a run's genes take what
 *   it leaves;
 * - the decode pool's size follows its share as it changes, and the memory
 *   model's trim ends its idle workers.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYSIS_CONTEXT_BYTES_PER_CELL,
  WorkerPool,
  analysisPoolSize,
  analysisRunBudgetBytes,
  getWorkerPool,
} from '../assets/js/app/analysis/compute/worker-pool.js';
import { WORKER_IDLE_MS, registerIdleWorkers, retireIdleWorkers } from '../assets/js/workers/idle-retirement.js';
import { memoryReport, resetMemoryModel, residencyBudgetBytes, setOpenCells } from '../assets/js/data/memory-budget.js';
import {
  DECODE_WORKER_BYTES,
  configureDecodePool,
  decodeChunkBytes,
  decodePoolStats,
  decodeWorkersHeldBytes,
  trimDecodeWorkers,
} from '../assets/js/formats/io/decode-pool.js';

function installWorkers(t) {
  const original = globalThis.Worker;
  const started = [];
  class EchoWorker extends EventTarget {
    constructor() {
      super();
      this.terminated = false;
      started.push(this);
    }
    postMessage(message) {
      if (message.type === 'INIT') {
        queueMicrotask(() => this.onmessage({ data: { type: 'INIT_ACK', workerId: message.payload.id } }));
        return;
      }
      queueMicrotask(() => this.onmessage({ data: { requestId: message.requestId, success: true, result: { ok: true } } }));
    }
    terminate() {
      this.terminated = true;
    }
  }
  globalThis.Worker = EchoWorker;
  t.after(() => {
    if (original === undefined) delete globalThis.Worker;
    else globalThis.Worker = original;
  });
  return started;
}

test.beforeEach(() => resetMemoryModel());
test.after(() => resetMemoryModel());

test('an idle analysis pool ends its workers after WORKER_IDLE_MS and starts them again, the same count, for the next task', async t => {
  const started = installWorkers(t);
  const pool = new WorkerPool({ poolSize: 3 });
  t.after(() => pool.terminate());
  await pool.init();
  // The clock is the test's from here (starting workers waits a task each).
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.deepEqual(await pool.execute('T', {}), { ok: true });
  assert.equal(started.length, 3);
  await Promise.resolve();
  t.mock.timers.tick(WORKER_IDLE_MS - 1);
  assert.ok(started.every(worker => !worker.terminated), 'kept within the idle time');
  t.mock.timers.tick(1);
  assert.ok(started.every(worker => worker.terminated), 'ended once idle');
  assert.equal(pool.isReady(), false);
  assert.equal(pool.isTerminal(), false, 'retiring idle workers is no failure');
  assert.equal(pool.getStats().poolSize, 3);
  t.mock.timers.reset();
  assert.deepEqual(await pool.execute('T', {}), { ok: true });
  assert.equal(started.length, 6, 'started again for the next task');
  assert.equal(pool.workers.length, 3);
});

test('tasks asked together after the idle workers ended share one start: none is refused while it runs', async t => {
  const started = installWorkers(t);
  const pool = new WorkerPool({ poolSize: 2 });
  t.after(() => pool.terminate());
  await pool.init();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await pool.execute('T', {});
  await Promise.resolve();
  t.mock.timers.tick(WORKER_IDLE_MS);
  assert.equal(pool.isReady(), false, 'the idle workers ended');
  t.mock.timers.reset();
  // A run's context broadcast and its first task, asked in one turn: the
  // second finds the first one's start under way and waits for it (it was
  // refused with a null reason, which reached the analysis as "failed: null").
  const [context, first, second] = await Promise.all([
    pool.broadcast('SET_CONTEXT', () => ({})),
    pool.execute('T', {}),
    pool.execute('T', {}),
  ]);
  assert.ok(Array.isArray(context));
  assert.deepEqual([first, second], [{ ok: true }, { ok: true }]);
  assert.equal(started.length, 4, 'started once again, the same count');
});

test('a pool keeping state for a run keeps its workers; the state is counted in the analysis share, every worker\'s copy', async t => {
  const started = installWorkers(t);
  const pool = new WorkerPool({ poolSize: 2 });
  t.after(() => pool.terminate());
  await pool.init();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const groups = new Uint8Array(1000);
  await pool.broadcast('SET', () => ({ groupOfCell: groups.slice() }), { retainAs: 'run' });
  assert.equal(pool.keptStateBytes(), 2 * 1000);
  assert.equal(memoryReport().shares.analysis.heldBytes, 2000, 'counted by the memory model');
  t.mock.timers.tick(10 * WORKER_IDLE_MS);
  assert.ok(started.every(worker => !worker.terminated), 'a run\'s kept state holds the workers');
  retireIdleWorkers();
  assert.ok(started.every(worker => !worker.terminated), 'not idle: a hidden page keeps them too');
  await pool.broadcast('CLEAR', () => ({}), { releases: 'run' });
  assert.equal(pool.keptStateBytes(), 0);
  // State a worker builds beyond its payload (a two-group context's
  // positions) is counted as the caller says, every worker's.
  await pool.broadcast('SET', () => ({ groupOfCell: groups.slice() }), { retainAs: 'built', heldBytes: 5 * 1000 });
  assert.equal(pool.keptStateBytes(), 2 * 5 * 1000);
  await assert.rejects(pool.broadcast('SET', () => ({}), { heldBytes: 10 }), /heldBytes counts retained state/);
  await pool.broadcast('CLEAR', () => ({}), { releases: 'built' });
  assert.equal(pool.keptStateBytes(), 0);
  retireIdleWorkers();
  assert.ok(started.every(worker => worker.terminated), 'a hidden page ends idle workers at once');
});

test('the analysis pool runs no more workers than its share holds a run\'s per-cell state for, at least one', () => {
  const environment = { navigator: { hardwareConcurrency: 10 } };
  assert.equal(analysisPoolSize({ memoryBytes: 256 * 2 ** 20, cells: 0, environment }), 8, 'cores less two');
  assert.equal(analysisPoolSize({ memoryBytes: 256 * 2 ** 20, cells: 1_000_000, environment }), 8);
  assert.equal(
    analysisPoolSize({ memoryBytes: 256 * 2 ** 20, cells: 10_000_000, environment }),
    Math.floor((256 * 2 ** 20) / (10_000_000 * ANALYSIS_CONTEXT_BYTES_PER_CELL)),
    '10M cells: five bytes a cell a worker, within the share',
  );
  assert.equal(analysisPoolSize({ memoryBytes: 1, cells: 10_000_000, environment }), 1);
});

test('a run\'s genes take what the state kept in the workers leaves of the analysis share', async t => {
  installWorkers(t);
  setOpenCells(1000);
  const pool = getWorkerPool();
  t.after(() => pool.terminate());
  const share = residencyBudgetBytes('analysis');
  assert.equal(analysisRunBudgetBytes(), share);
  await pool.broadcast('SET', () => ({ groupOfCell: new Uint8Array(4096) }), { retainAs: 'kept' });
  assert.equal(analysisRunBudgetBytes(), share - pool.poolSize * 4096);
});

test('the shared rule: idle() starts the wait again; dispose stops counting a pool', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let retired = 0;
  const pool = registerIdleWorkers(() => { retired++; });
  pool.idle();
  t.mock.timers.tick(WORKER_IDLE_MS / 2);
  pool.idle();
  t.mock.timers.tick(WORKER_IDLE_MS - 1);
  assert.equal(retired, 0);
  t.mock.timers.tick(1);
  assert.equal(retired, 1);
  pool.dispose();
  retireIdleWorkers();
  assert.equal(retired, 1, 'a disposed pool is not counted');
});

test('the decode pool follows its share as it changes, and the memory model\'s trim ends its idle workers', async t => {
  let memoryBytes = 3 * DECODE_WORKER_BYTES;
  const created = [];
  configureDecodePool({
    memoryBytes: () => memoryBytes,
    minBytes: 0,
    createWorker: () => {
      const listeners = new Map();
      const worker = {
        terminated: false,
        addEventListener: (type, listener) => listeners.set(type, listener),
        postMessage(message) {
          const tasks = Array.isArray(message.tasks) ? message.tasks : [message];
          queueMicrotask(() => listeners.get('message')?.({ data: { id: tasks[0].id, results: tasks.map(task => ({ id: task.id, bytes: new Uint8Array(task.size) })) } }));
        },
        terminate() { this.terminated = true; },
      };
      created.push(worker);
      return worker;
    },
  });
  t.after(() => configureDecodePool());
  assert.equal(decodePoolStats().size, 0, 'no pool before the first chunk');
  memoryBytes = 0;
  // Its memory holds no worker now: the chunk is decoded here.
  const here = await decodeChunkBytes({ kind: 'zarr', description: {}, input: new Uint8Array(64), size: 64, revive: error => new Error(error.message), inThread: () => new Uint8Array(64) });
  assert.equal(here.length, 64);
  assert.equal(created.length, 0);
  assert.equal(decodeWorkersHeldBytes(), 0);
  assert.equal(trimDecodeWorkers(0), null);
});
