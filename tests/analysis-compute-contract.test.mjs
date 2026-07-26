import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as analysisPublic from '../assets/js/app/analysis/index.js';
import {
  BackendStatus,
  ComputeManager
} from '../assets/js/app/analysis/compute/compute-manager.js';
import { GPUCompute } from '../assets/js/app/analysis/compute/gpu-compute.js';
import { executeOperation } from '../assets/js/app/analysis/compute/operation-handlers.js';
import {
  CPU_CAPABLE_OPERATIONS,
  GPU_CAPABLE_OPERATIONS,
  OperationType,
  WORKER_CAPABLE_OPERATIONS
} from '../assets/js/app/analysis/compute/operations.js';
import { WorkerPool } from '../assets/js/app/analysis/compute/worker-pool.js';

const COMPUTE_ROOT = new URL('../assets/js/app/analysis/compute/', import.meta.url);

function createInitializedManager({ gpu = true, worker = true } = {}) {
  const manager = new ComputeManager();
  manager._initialized = true;
  manager._gpuStatus = gpu ? BackendStatus.AVAILABLE : BackendStatus.UNAVAILABLE;
  manager._workerStatus = worker ? BackendStatus.AVAILABLE : BackendStatus.UNAVAILABLE;
  manager._gpuBackend = gpu
    ? {
        dispose() {},
        getInfo() {
          return { initialized: true };
        }
      }
    : null;
  manager._workerBackend = worker
    ? {
        execute() {
          throw new Error('worker execute stub was not configured');
        },
        getStats() {
          return { poolSize: 1 };
        },
        terminate() {}
      }
    : null;
  return manager;
}

function withoutComputeMetadata(result) {
  const { _compute, ...scientificResult } = result;
  return scientificResult;
}

test('numeric mismatches are not advertised as GPU-capable operations', () => {
  assert.equal(GPU_CAPABLE_OPERATIONS.size, 0);
  assert.deepEqual(
    [...WORKER_CAPABLE_OPERATIONS].sort(),
    [...CPU_CAPABLE_OPERATIONS].sort()
  );

  const values = new Float32Array([1, 2, 3, 4]);
  const cpuStats = executeOperation(OperationType.COMPUTE_STATS, { values });
  const gpuUtility = new GPUCompute();
  const gpuStats = gpuUtility.computeFullStatistics(values);

  assert.notEqual(
    cpuStats.q1,
    gpuStats.q1,
    'the pre-fix CPU and GPU quartile definitions must remain a visible reproduction'
  );
  assert.equal(GPU_CAPABLE_OPERATIONS.has(OperationType.COMPUTE_STATS), false);

  const constant = new Float32Array([5, 5, 5, 5]);
  const cpuHistogram = executeOperation(OperationType.COMPUTE_HISTOGRAM, {
    values: constant,
    bins: 4
  });
  const gpuHistogram = gpuUtility.computeHistogram(constant, 4);

  assert.equal(cpuHistogram.total, 4);
  assert.equal(gpuHistogram.validCount, 0);
  assert.equal(GPU_CAPABLE_OPERATIONS.has(OperationType.COMPUTE_HISTOGRAM), false);
});

test('ComputeManager executes exactly one preselected backend and propagates its error', async t => {
  const manager = createInitializedManager();
  t.after(() => manager.terminate());
  manager.selectBackend = () => 'gpu';

  const calls = [];
  manager._executeOnBackend = async backend => {
    calls.push(backend);
    throw new Error(`${backend} execution failed exactly once`);
  };

  await assert.rejects(
    manager.execute(OperationType.SCALE, {
      values: new Float32Array([1, 2]),
      scale: 2
    }),
    /gpu execution failed exactly once/
  );
  assert.deepEqual(calls, ['gpu']);
});

test('worker execution failure is never recomputed on the main thread', async t => {
  const manager = createInitializedManager({ gpu: false, worker: true });
  t.after(() => manager.terminate());

  const calls = [];
  manager._executeOnBackend = async backend => {
    calls.push(backend);
    throw new Error(`${backend} scientific failure`);
  };

  await assert.rejects(
    manager.execute(OperationType.COMPUTE_CORRELATION, {
      xValues: new Float32Array([1, 2, 3]),
      yValues: new Float32Array([1, 2, 4])
    }),
    /worker scientific failure/
  );
  assert.deepEqual(calls, ['worker']);
});

test('an explicit backend request is exact and rejected before execution when unavailable', async t => {
  const manager = createInitializedManager({ gpu: false, worker: false });
  t.after(() => manager.terminate());

  const calls = [];
  manager._executeOnBackend = async backend => {
    calls.push(backend);
    return { values: new Float32Array([2]) };
  };

  await assert.rejects(
    manager.execute(
      OperationType.COMPUTE_CORRELATION,
      {
        xValues: new Float32Array([1, 2]),
        yValues: new Float32Array([1, 2])
      },
      { backend: 'worker' }
    ),
    /worker backend.*unavailable|unavailable.*worker backend/i
  );
  assert.deepEqual(calls, []);

  await assert.rejects(
    manager.execute(
      OperationType.SCALE,
      { values: new Float32Array([1]), scale: 2 },
      { preferredBackend: 'cpu' }
    ),
    /unknown execution option.*preferredBackend|preferredBackend.*unknown execution option/i
  );
  assert.deepEqual(calls, []);
});

test('batch execution never retries a failed task on CPU', async t => {
  const manager = createInitializedManager();
  t.after(() => manager.terminate());
  manager.selectBackend = () => 'gpu';

  const calls = [];
  manager._executeOnBackend = async backend => {
    calls.push(backend);
    if (backend === 'gpu') throw new Error('batch GPU failure');
    return { values: new Float32Array([99]) };
  };

  await assert.rejects(
    manager.executeBatch([
      {
        operation: OperationType.SCALE,
        payload: { values: new Float32Array([1]), scale: 2 }
      }
    ]),
    /batch GPU failure/
  );
  assert.deepEqual(calls, ['gpu']);
});

test('WorkerPool never executes scientific work on the main thread', async t => {
  const pool = new WorkerPool({ poolSize: 1 });
  t.after(() => pool.terminate());
  pool.workersAvailable = false;

  await assert.rejects(
    pool.execute(OperationType.COMPUTE_STATS, {
      values: new Float32Array([1, 2, 3])
    }),
    /Web Workers.*unavailable|unavailable.*Web Workers/i
  );

  await assert.rejects(
    pool.executeOnWorker(0, OperationType.COMPUTE_STATS, {
      values: new Float32Array([1, 2, 3])
    }),
    /Web Workers.*unavailable|unavailable.*Web Workers/i
  );

  await assert.rejects(
    pool.broadcast(OperationType.COMPUTE_STATS, [{ values: [1, 2, 3] }]),
    /Web Workers.*unavailable|unavailable.*Web Workers/i
  );
});

test('WorkerPool transfers each backing buffer at most once', () => {
  const pool = new WorkerPool({ poolSize: 1 });
  const buffer = new ArrayBuffer(16);
  const first = new Float32Array(buffer, 0, 2);
  const second = new Float32Array(buffer, 8, 2);

  assert.deepEqual(
    pool._collectTransferables({ first, nested: [second, buffer] }),
    [buffer]
  );
});

test('WorkerPool rejects every undeclared or coercive configuration shape', async () => {
  for (const options of [
    { poolSize: 0 },
    { poolSize: 1.5 },
    { defaultTimeout: '30000' },
    { poolSize: 1, alias: true }
  ]) {
    assert.throws(
      () => new WorkerPool(options),
      /positive safe integer|unknown key/i
    );
  }

  const pool = new WorkerPool({ poolSize: 1 });
  await assert.rejects(
    pool.execute(
      OperationType.COMPUTE_STATS,
      { values: [1, 2, 3] },
      { restartWorkerOnAbort: true }
    ),
    /unknown key.*restartWorkerOnAbort/i
  );
  await assert.rejects(
    pool.executeOnWorker(
      0,
      OperationType.COMPUTE_STATS,
      { values: [1, 2, 3] },
      30_000
    ),
    /options must be a plain object/i
  );
});

test('WorkerPool preflights broadcasts and batches before dispatching any work', async t => {
  const posted = [];
  const pool = new WorkerPool({ poolSize: 2 });
  t.after(() => pool.terminate());
  pool.workers = [
    { postMessage: message => posted.push(message), terminate() {} },
    { postMessage: message => posted.push(message), terminate() {} }
  ];
  pool.workerStates = ['idle', 'idle'];
  pool.taskQueues = [[], []];
  pool.initialized = true;
  pool._lifecycle = 'ready';

  await assert.rejects(
    pool.broadcast(
      OperationType.COMPUTE_STATS,
      [{ values: [1] }, Object.create(null)],
      { transfer: false }
    ),
    /broadcast payload 1 must be a plain object/i
  );
  assert.equal(posted.length, 0);

  await assert.rejects(
    pool.executeBatch([
      {
        type: OperationType.COMPUTE_STATS,
        payload: { values: [1] }
      },
      {
        type: OperationType.COMPUTE_STATS,
        payload: { values: [2] },
        alternate: true
      }
    ]),
    /unknown key.*alternate/i
  );
  assert.equal(posted.length, 0);
});

test('WorkerPool makes transfer traversal failure terminal immediately', async t => {
  const pool = new WorkerPool({ poolSize: 1 });
  t.after(() => pool.terminate());
  let terminated = false;
  pool.workers = [{
    postMessage() {
      assert.fail('invalid transfer payload must not be posted');
    },
    terminate() {
      terminated = true;
    }
  }];
  pool.workerStates = ['idle'];
  pool.taskQueues = [[]];
  pool.initialized = true;
  pool._lifecycle = 'ready';

  const payload = {};
  Object.defineProperty(payload, 'values', {
    enumerable: true,
    get() {
      throw new Error('synthetic transfer traversal failure');
    }
  });

  await assert.rejects(
    pool.execute(
      OperationType.COMPUTE_STATS,
      payload,
      { transfer: true }
    ),
    /dispatch failed.*synthetic transfer traversal failure/i
  );
  assert.equal(terminated, true);
  assert.match(
    pool.getTerminalFailure().message,
    /synthetic transfer traversal failure/i
  );
});

test('a running-task abort terminates the exact worker pool and rejects its queue', async t => {
  const originalWorker = globalThis.Worker;
  const workers = [];
  class SilentWorker {
    constructor() {
      this.terminated = false;
      workers.push(this);
    }

    postMessage() {}

    terminate() {
      this.terminated = true;
    }
  }
  globalThis.Worker = SilentWorker;
  t.after(() => {
    if (originalWorker === undefined) {
      delete globalThis.Worker;
    } else {
      globalThis.Worker = originalWorker;
    }
  });

  const pool = new WorkerPool({ poolSize: 1, defaultTimeout: 1_000 });
  t.after(() => pool.terminate());
  pool.workers = [new SilentWorker()];
  pool.workerStates = ['idle'];
  pool.taskQueues = [[]];
  pool.initialized = true;
  pool._lifecycle = 'ready';

  const controller = new AbortController();
  const running = pool.execute(
    OperationType.COMPUTE_STATS,
    { values: [1, 2, 3] },
    { signal: controller.signal, transfer: false }
  );
  const queued = pool.execute(
    OperationType.COMPUTE_STATS,
    { values: [4, 5, 6] },
    { transfer: false }
  );
  const settled = Promise.allSettled([running, queued]);

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pool.pendingRequests.size, 1);
  assert.equal(pool.taskQueues[0].length, 1);
  controller.abort();
  const results = await settled;

  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
  assert.equal(results[0].reason?.name, 'AbortError');
  assert.equal(results[1].reason, results[0].reason);
  assert.equal(pool.isReady(), false);
  assert.equal(pool.getTerminalFailure(), results[0].reason);
  assert.equal(workers[0].terminated, true);
});

test('a worker crash has one terminal owner and never creates a replacement', async t => {
  const originalWorker = globalThis.Worker;
  let created = 0;
  class SilentWorker {
    constructor() {
      created++;
      this.terminated = false;
    }

    postMessage() {}

    terminate() {
      this.terminated = true;
    }
  }
  globalThis.Worker = SilentWorker;
  t.after(() => {
    if (originalWorker === undefined) {
      delete globalThis.Worker;
    } else {
      globalThis.Worker = originalWorker;
    }
  });

  const pool = new WorkerPool({ poolSize: 1 });
  t.after(() => pool.terminate());
  const worker = new SilentWorker();
  pool.workers = [worker];
  pool.workerStates = ['busy'];
  pool.taskQueues = [[]];
  pool.initialized = true;
  pool._lifecycle = 'ready';

  const pendingResult = new Promise(resolve => {
    pool.pendingRequests.set('pool-1', {
      resolve: () => assert.fail('crashed work must not resolve'),
      reject: error => resolve(error),
      timeoutId: null,
      workerIndex: 0,
      type: OperationType.COMPUTE_STATS,
      signal: null,
      abortHandler: null,
      startTime: 0
    });
  });

  const beforeCrash = created;
  pool._handleError(0, { message: 'synthetic worker crash' });
  const rejectedWith = await pendingResult;

  assert.equal(created, beforeCrash);
  assert.equal(worker.terminated, true);
  assert.equal(pool.isReady(), false);
  assert.equal(pool.getTerminalFailure(), rejectedWith);
  assert.match(rejectedWith.message, /worker 0.*synthetic worker crash/i);
  await assert.rejects(
    pool.execute(OperationType.COMPUTE_STATS, { values: [1] }),
    error => error === rejectedWith
  );
});

test('ComputeManager exposes a terminal worker-pool failure without changing backend', async t => {
  const manager = createInitializedManager({ gpu: false, worker: true });
  t.after(() => manager.terminate());
  const terminalFailure = new Error('terminal worker transport failure');
  manager._workerBackend = {
    async execute() {
      throw terminalFailure;
    },
    getTerminalFailure() {
      return terminalFailure;
    },
    getStats() {
      return { poolSize: 1 };
    },
    terminate() {}
  };

  await assert.rejects(
    manager.execute(
      OperationType.COMPUTE_STATS,
      { values: new Float32Array([1, 2, 3]) },
      { backend: 'worker' }
    ),
    error => error === terminalFailure
  );

  assert.equal(manager.getStatus().worker.status, BackendStatus.FAILED);
  assert.equal(manager.getStatus().worker.failure, terminalFailure.message);
  assert.equal(manager.isWorkerAvailable(), false);
  await assert.rejects(
    manager.execute(
      OperationType.COMPUTE_STATS,
      { values: new Float32Array([4, 5, 6]) }
    ),
    error => error === terminalFailure
  );
  await assert.rejects(
    manager.init(),
    error => error === terminalFailure
  );
});

test('ComputeManager rejects alternate option and batch task records', async t => {
  const manager = createInitializedManager({ gpu: false, worker: false });
  t.after(() => manager.terminate());

  await assert.rejects(
    manager.execute(
      OperationType.COMPUTE_STATS,
      { values: new Float32Array([1, 2, 3]) },
      Object.create(null)
    ),
    /options must be a plain object/i
  );
  await assert.rejects(
    manager.executeBatch([
      {
        operation: OperationType.COMPUTE_STATS,
        payload: { values: new Float32Array([1, 2, 3]) },
        backend: 'cpu'
      }
    ]),
    /unknown compute batch task key.*backend/i
  );
});

test('CPU and worker selections return the exact same scientific contract', async t => {
  const manager = createInitializedManager({ gpu: false, worker: true });
  t.after(() => manager.terminate());
  manager._workerBackend.execute = async (operation, payload) =>
    structuredClone(executeOperation(operation, payload));

  const fixtures = [
    {
      operation: OperationType.COMPUTE_STATS,
      payload: { values: new Float32Array([1, 2, NaN, 4]) }
    },
    {
      operation: OperationType.COMPUTE_CORRELATION,
      payload: {
        xValues: new Float32Array([1, 2, 3, 4]),
        yValues: new Float32Array([1, 3, 2, 5]),
        method: 'spearman'
      }
    },
    {
      operation: OperationType.COMPUTE_DIFFERENTIAL,
      payload: {
        groupAValues: new Float32Array([0, 1, 2, 3]),
        groupBValues: new Float32Array([4, 5, 6, 7]),
        method: 'wilcox'
      }
    },
    {
      operation: OperationType.AGGREGATE_CATEGORIES,
      payload: { values: ['T', 'B', 'T'], normalize: true }
    }
  ];

  for (const fixture of fixtures) {
    const cpu = await manager.execute(
      fixture.operation,
      structuredClone(fixture.payload),
      { backend: 'cpu' }
    );
    const worker = await manager.execute(
      fixture.operation,
      structuredClone(fixture.payload),
      { backend: 'worker' }
    );
    assert.deepEqual(
      withoutComputeMetadata(worker),
      withoutComputeMetadata(cpu),
      fixture.operation
    );
  }
});

test('compute metadata and metrics contain no retry or fallback narrative', async t => {
  const manager = createInitializedManager({ gpu: false, worker: false });
  t.after(() => manager.terminate());

  const result = await manager.execute(
    OperationType.COMPUTE_STATS,
    { values: new Float32Array([1, 2, 3]) },
    { backend: 'cpu' }
  );

  assert.deepEqual(
    Object.keys(result._compute).sort(),
    ['backend', 'elapsedMs', 'operation']
  );
  assert.deepEqual(
    Object.keys(manager.getMetrics()).sort(),
    ['cpuExecutions', 'gpuExecutions', 'totalExecutions', 'totalTimeMs', 'workerExecutions']
  );
});

test('obsolete compute compatibility surface and runtime fallback module are absent', async () => {
  const computePublic = await import('../assets/js/app/analysis/compute/index.js');
  assert.equal('executeFallback' in computePublic, false);
  assert.equal('executeFallback' in analysisPublic, false);
  assert.equal('initComputeManager' in computePublic, false);
  assert.equal('createComputeManager' in computePublic, false);

  const manager = new ComputeManager();
  const pool = new WorkerPool({ poolSize: 1 });
  try {
    for (const method of [
      'computeStats',
      'computeHistogram',
      'computeCorrelation',
      'computeDifferential',
      'log1pTransform',
      'zscoreNormalize',
      'minmaxNormalize',
      'extractValues',
      'aggregateCategories'
    ]) {
      assert.equal(method in manager, false, `ComputeManager.${method}`);
    }
    for (const method of [
      'extractValues',
      'computeStats',
      'computeCorrelation',
      'computeDifferential',
      'aggregateCategories',
      'binValues',
      'batchExtract',
      'computeDifferentialBatch'
    ]) {
      assert.equal(method in pool, false, `WorkerPool.${method}`);
    }
  } finally {
    manager.terminate();
    pool.terminate();
  }

  await assert.rejects(
    readFile(new URL('fallback-operations.js', COMPUTE_ROOT), 'utf8'),
    error => error?.code === 'ENOENT'
  );
});

test('bounded analysis call sites contain no execution-failure backend switch', async () => {
  const [dataLayer, markerDiscovery, multiVariable, manager, workerPool] =
    await Promise.all([
      readFile(new URL('../assets/js/app/analysis/data/data-layer.js', import.meta.url), 'utf8'),
      readFile(
        new URL(
          '../assets/js/app/analysis/genes-panel/marker-discovery-engine.js',
          import.meta.url
        ),
        'utf8'
      ),
      readFile(
        new URL(
          '../assets/js/app/analysis/stats/multi-variable-analysis.js',
          import.meta.url
        ),
        'utf8'
      ),
      readFile(new URL('compute-manager.js', COMPUTE_ROOT), 'utf8'),
      readFile(new URL('worker-pool.js', COMPUTE_ROOT), 'utf8')
    ]);

  assert.doesNotMatch(dataLayer, /computeManager\.compute[A-Z]|_computeStatsLocal|_aggregateCategoriesLocal/);
  assert.doesNotMatch(markerDiscovery, /_computeGeneMarkersFallback|Promise\.allSettled/);
  assert.doesNotMatch(multiVariable, /computeManager\.compute[A-Z]|markerStyleAvailable|legacy DE backend/);
  assert.doesNotMatch(manager, /fallbackUsed|gpuFallbacks|workerFallbacks|fallback-operations/i);
  assert.doesNotMatch(workerPool, /_fallbackExecute|fallback-operations|main thread fallback/i);
});

test('analysis worker lifecycle contains no worker replacement or heap-recycle path', async () => {
  const [manager, workerPool, markerDiscovery, cleanup] = await Promise.all([
    readFile(new URL('compute-manager.js', COMPUTE_ROOT), 'utf8'),
    readFile(new URL('worker-pool.js', COMPUTE_ROOT), 'utf8'),
    readFile(
      new URL(
        '../assets/js/app/analysis/genes-panel/marker-discovery-engine.js',
        import.meta.url
      ),
      'utf8'
    ),
    readFile(
      new URL('../assets/js/app/analysis/shared/resource-cleanup.js', import.meta.url),
      'utf8'
    )
  ]);
  const currentLifecycle = [manager, workerPool, markerDiscovery, cleanup].join('\n');

  assert.doesNotMatch(
    currentLifecycle,
    /_restartWorker|restartWorkerOnAbort|_workerRestartPromise|pruneIdleWorkers|cleanupIdleResources|keepAtLeastIdleWorkers/
  );
});
