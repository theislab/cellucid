import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  BackendStatus,
  ComputeManager
} from '../assets/js/app/analysis/compute/compute-manager.js';
import { executeOperation } from '../assets/js/app/analysis/compute/operation-handlers.js';
import {
  CPU_CAPABLE_OPERATIONS,
  OperationType,
  WORKER_CAPABLE_OPERATIONS
} from '../assets/js/app/analysis/compute/operations.js';
import { WorkerPool } from '../assets/js/app/analysis/compute/worker-pool.js';
import { toCSV } from '../assets/js/app/analysis/shared/analysis-utils.js';

const COMPUTE_ROOT = new URL('../assets/js/app/analysis/compute/', import.meta.url);

function createInitializedManager({ worker = true } = {}) {
  const manager = new ComputeManager();
  manager._initialized = true;
  manager._workerStatus = worker ? BackendStatus.AVAILABLE : BackendStatus.UNAVAILABLE;
  manager._workerBackend = worker
    ? {
        execute() {
          throw new Error('worker execute stub was not configured');
        },
        getStats() {
          return { poolSize: 1 };
        },
        getTerminalFailure() {
          return null;
        },
        isTerminal() {
          return false;
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

test('CSV conversion requires own headers and row cells for prototype-named columns', () => {
  const columns = Object.getOwnPropertyNames(Object.prototype);
  const row = Object.fromEntries(
    columns.map((column, index) => [column, `value-${index}`]),
  );

  assert.equal(
    toCSV([row], { columns }),
    [
      columns.join(','),
      columns.map((_, index) => `value-${index}`).join(','),
    ].join('\n'),
  );
  assert.equal(
    toCSV([{}], { columns }),
    [
      columns.join(','),
      columns.map(() => '').join(','),
    ].join('\n'),
  );

  assert.equal(
    toCSV(
      [Object.fromEntries([['constructor', 'value']])],
      {
        columns: ['constructor', 'toString', 'valueOf', '__proto__'],
        headers: Object.fromEntries([
          ['constructor', ''],
          ['toString', 0],
          ['valueOf', false],
          ['__proto__', null],
        ]),
      },
    ),
    ',0,false,\nvalue,,,',
  );
});

test('ComputeManager executes exactly one preselected backend and propagates its error', async t => {
  const manager = createInitializedManager();
  t.after(() => manager.terminate());
  manager.selectBackend = () => 'worker';

  const calls = [];
  manager._executeOnBackend = async backend => {
    calls.push(backend);
    throw new Error(`${backend} execution failed exactly once`);
  };

  await assert.rejects(
    manager.execute(OperationType.COMPUTE_CORRELATION, {
      xValues: new Float32Array([1, 2, 3]),
      yValues: new Float32Array([1, 2, 4])
    }),
    /worker execution failed exactly once/
  );
  assert.deepEqual(calls, ['worker']);
});

test('worker execution failure is never recomputed on the main thread', async t => {
  const manager = createInitializedManager({ worker: true });
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
  const manager = createInitializedManager({ worker: false });
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
      OperationType.COMPUTE_CORRELATION,
      { xValues: new Float32Array([1]), yValues: new Float32Array([1]) },
      { preferredBackend: 'cpu' }
    ),
    /Execution options may contain only: .*\(unexpected: preferredBackend\)/i
  );
  assert.deepEqual(calls, []);
});

test('WorkerPool never executes scientific work on the main thread', async t => {
  const pool = new WorkerPool({ poolSize: 1 });
  t.after(() => pool.terminate());
  pool.workersAvailable = false;

  await assert.rejects(
    pool.execute(OperationType.COMPUTE_CORRELATION,
    {
      xValues: new Float32Array([1, 2, 3]),
      yValues: new Float32Array([1, 2, 3])
    }),
    /Web Workers.*unavailable|unavailable.*Web Workers/i
  );

  await assert.rejects(
    pool.executeOnWorker(0, OperationType.COMPUTE_CORRELATION,
    {
      xValues: new Float32Array([1, 2, 3]),
      yValues: new Float32Array([1, 2, 3])
    }),
    /Web Workers.*unavailable|unavailable.*Web Workers/i
  );

  await assert.rejects(
    pool.broadcast(OperationType.COMPUTE_CORRELATION, [{ xValues: [1, 2, 3], yValues: [1, 2, 3] }]),
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
      /positive safe integer|WorkerPool options may contain only: defaultTimeout, poolSize \(unexpected: alias\)/i
    );
  }

  const pool = new WorkerPool({ poolSize: 1 });
  await assert.rejects(
    pool.execute(
      OperationType.COMPUTE_CORRELATION, { xValues: [1, 2, 3], yValues: [1, 2, 3] },
      { restartWorkerOnAbort: true }
    ),
    /Worker execution options may contain only: .*\(unexpected: restartWorkerOnAbort\)/i
  );
  await assert.rejects(
    pool.executeOnWorker(
      0,
      OperationType.COMPUTE_CORRELATION, { xValues: [1, 2, 3], yValues: [1, 2, 3] },
      30_000
    ),
    /options must be a plain object/i
  );
});

test('WorkerPool preflights broadcasts before dispatching any work', async t => {
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
      OperationType.COMPUTE_CORRELATION,
      [{ xValues: [1], yValues: [1] }, Object.create(null)],
      { transfer: false }
    ),
    /broadcast payload 1 must be a plain object/i
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
      OperationType.COMPUTE_CORRELATION,
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

test('a running-task abort answers its caller and leaves the pool and its queue alone', async t => {
  const originalWorker = globalThis.Worker;
  const workers = [];
  class SilentWorker extends EventTarget {
    constructor() {
      super();
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
    OperationType.COMPUTE_CORRELATION, { xValues: [1, 2, 3], yValues: [1, 2, 3] },
    { signal: controller.signal, transfer: false }
  );
  const queued = pool.execute(
    OperationType.COMPUTE_CORRELATION, { xValues: [4, 5, 6], yValues: [4, 5, 6] },
    { transfer: false }
  );
  let queuedSettled = false;
  void queued.then(() => { queuedSettled = true; }, () => { queuedSettled = true; });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pool.pendingRequests.size, 1);
  assert.equal(pool.taskQueues[0].length, 1);
  controller.abort();
  await assert.rejects(running, error => error.name === 'AbortError');
  await new Promise(resolve => setImmediate(resolve));

  // A cancel is not a failure: the pool is ready and the queued task waits
  // for the worker (cooperatively, or for its replacement after the grace).
  assert.equal(queuedSettled, false);
  assert.equal(pool.isReady(), true);
  assert.equal(pool.getTerminalFailure(), null);
  assert.equal(workers[0].terminated, false);
  assert.equal(pool.pendingRequests.get('pool-1').abandoned, true);
});

test('a worker crash has one terminal owner and never creates a replacement', async t => {
  const originalWorker = globalThis.Worker;
  let created = 0;
  class SilentWorker extends EventTarget {
    constructor() {
      super();
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
      task: {
        resolve: () => assert.fail('crashed work must not resolve'),
        reject: error => resolve(error),
      },
      timeoutId: null,
      workerIndex: 0,
      type: OperationType.COMPUTE_CORRELATION,
      abandoned: false,
      graceTimer: undefined
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
    pool.execute(OperationType.COMPUTE_CORRELATION, { xValues: [1], yValues: [1] }),
    error => error === rejectedWith
  );
});

test('ComputeManager retires a terminal worker pool and discovers a fresh one for the next operation', async t => {
  const originalWorker = globalThis.Worker;
  const workers = [];
  class AcknowledgingWorker extends EventTarget {
    constructor() {
      super();
      this.terminated = false;
      workers.push(this);
    }

    postMessage(message) {
      if (message.type !== 'INIT') return;
      queueMicrotask(() => {
        this.onmessage({
          data: { type: 'INIT_ACK', workerId: message.payload.id }
        });
      });
    }

    terminate() {
      this.terminated = true;
    }
  }
  globalThis.Worker = AcknowledgingWorker;
  t.after(() => {
    if (originalWorker === undefined) {
      delete globalThis.Worker;
    } else {
      globalThis.Worker = originalWorker;
    }
  });

  const manager = new ComputeManager();
  t.after(() => manager.terminate());
  await manager.init();
  assert.equal(manager.getStatus().worker.status, BackendStatus.AVAILABLE);
  const firstPool = manager._workerBackend;
  assert.equal(workers.length, firstPool.poolSize);

  // A running-task timeout is terminal for the exact pool that owned it.
  const timedOut = manager.execute(
    OperationType.COMPUTE_CORRELATION,
    {
      xValues: new Float32Array([1, 2, 3]),
      yValues: new Float32Array([1, 2, 3])
    },
    { backend: 'worker', timeout: 1, transfer: false }
  );
  const terminalFailure = await timedOut.then(
    () => assert.fail('a silent worker must time out'),
    error => error
  );
  assert.match(terminalFailure.message, /timed out after 1ms/);
  assert.equal(firstPool.isTerminal(), true);
  assert.equal(firstPool.getTerminalFailure(), terminalFailure);
  assert.ok(workers.every(worker => worker.terminated));
  assert.equal(manager.getStatus().worker.status, BackendStatus.FAILED);
  assert.equal(manager.getStatus().worker.failure, terminalFailure.message);
  assert.notEqual(manager.getStatus().worker.status, BackendStatus.AVAILABLE);

  // The next owner discovers a fresh pool instead of the terminal error.
  const workersBefore = workers.length;
  await manager.init();
  assert.equal(manager.getStatus().worker.status, BackendStatus.AVAILABLE);
  assert.notEqual(manager._workerBackend, firstPool);
  assert.equal(manager._workerBackend.isReady(), true);
  assert.equal(workers.length, workersBefore + firstPool.poolSize);
  assert.equal(manager.getStatus().worker.failure, null);
  // The terminal pool itself is never revived.
  await assert.rejects(
    firstPool.execute(OperationType.COMPUTE_CORRELATION, { xValues: [1], yValues: [1] }),
    error => error === terminalFailure
  );
});

test('a pool retired elsewhere is replaced before the manager selects a backend', async t => {
  const manager = createInitializedManager({ worker: true });
  t.after(() => manager.terminate());
  const terminalFailure = new Error('terminal worker transport failure');
  manager._workerBackend = {
    async execute() {
      assert.fail('a retired pool must not receive work');
    },
    getTerminalFailure() {
      return terminalFailure;
    },
    isTerminal() {
      return true;
    },
    getStats() {
      return { poolSize: 1 };
    },
    terminate() {}
  };
  const discovered = [];
  manager._doInit = async () => {
    discovered.push(manager.getStatus().worker.failure);
    manager._workerBackend = null;
    manager._workerStatus = BackendStatus.UNAVAILABLE;
    manager._workerFailure = null;
    manager._initialized = true;
  };

  const result = await manager.execute(
    OperationType.COMPUTE_CORRELATION,
    {
      xValues: new Float32Array([4, 5, 6]),
      yValues: new Float32Array([4, 5, 6])
    }
  );
  assert.deepEqual(discovered, [terminalFailure.message]);
  assert.equal(result._compute.backend, 'cpu');
});

test('ComputeManager rejects alternate option records', async t => {
  const manager = createInitializedManager({ worker: false });
  t.after(() => manager.terminate());

  await assert.rejects(
    manager.execute(
      OperationType.COMPUTE_CORRELATION,
    {
      xValues: new Float32Array([1, 2, 3]),
      yValues: new Float32Array([1, 2, 3])
    },
      Object.create(null)
    ),
    /options must be a plain object/i
  );
});

test('CPU and worker selections return the exact same scientific contract', async t => {
  const manager = createInitializedManager({ worker: true });
  t.after(() => manager.terminate());
  manager._workerBackend.execute = async (operation, payload) =>
    structuredClone(executeOperation(operation, payload));

  const fixtures = [
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

test('compute metadata contains no retry or fallback narrative', async t => {
  const manager = createInitializedManager({ worker: false });
  t.after(() => manager.terminate());

  const result = await manager.execute(
    OperationType.COMPUTE_CORRELATION,
    {
      xValues: new Float32Array([1, 2, 3]),
      yValues: new Float32Array([1, 2, 3])
    },
    { backend: 'cpu' }
  );

  assert.deepEqual(
    Object.keys(result._compute).sort(),
    ['backend', 'elapsedMs', 'operation']
  );
});

test('obsolete compute compatibility surface and runtime fallback module are absent', async () => {
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

// A failed worker is never revived or recycled; the one worker ever replaced
// is one still running a task its caller cancelled (worker-pool.js).
test('analysis worker lifecycle contains no failure restart or heap-recycle path', async () => {
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
