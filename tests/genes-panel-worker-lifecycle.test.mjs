import test from 'node:test';
import assert from 'node:assert/strict';

import { getWorkerPool } from '../assets/js/app/analysis/compute/worker-pool.js';
import { computeCategoryGroupingDigest } from '../assets/js/app/analysis/data/data-layer.js';
import { GenesPanelController } from '../assets/js/app/analysis/genes-panel/genes-panel-controller.js';
import { MarkerCache } from '../assets/js/app/analysis/genes-panel/marker-cache.js';
import { MarkerDiscoveryEngine } from '../assets/js/app/analysis/genes-panel/marker-discovery-engine.js';
import { ProgressTracker } from '../assets/js/app/analysis/shared/progress-tracker.js';
import { GenesPanelUI } from '../assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve));
}

async function withPatchedWorkerPool(overrides, callback) {
  const pool = getWorkerPool();
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, Object.getOwnPropertyDescriptor(pool, key));
    Object.defineProperty(pool, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  try {
    return await callback(pool);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor === undefined) {
        delete pool[key];
      } else {
        Object.defineProperty(pool, key, descriptor);
      }
    }
  }
}

async function withoutProgressNotifications(callback) {
  const previous = Object.getOwnPropertyDescriptor(
    ProgressTracker.prototype,
    '_initNotification',
  );
  Object.defineProperty(ProgressTracker.prototype, '_initNotification', {
    configurable: true,
    writable: true,
    value() {},
  });
  try {
    return await callback();
  } finally {
    Object.defineProperty(
      ProgressTracker.prototype,
      '_initNotification',
      previous,
    );
  }
}

function createMarkerDataLayer(gene, values) {
  return {
    state: {
      pointCount: values.length,
    },
    getAvailableVariables(kind) {
      assert.equal(kind, 'gene_expression');
      return [{ key: gene, name: gene }];
    },
    async ensureGeneExpressionLoaded(requestedGene, options) {
      assert.equal(requestedGene, gene);
      assert.deepEqual(options, { silent: true });
      return { values };
    },
    unloadGeneExpression(requestedGene) {
      assert.equal(requestedGene, gene);
      return true;
    },
    invalidateVariable(kind, requestedGene) {
      assert.equal(kind, 'gene_expression');
      assert.equal(requestedGene, gene);
    },
  };
}

function createDiscoveryFixture({
  contextCode = 0,
  gene = `GENE_${contextCode}`,
} = {}) {
  const obsCodes = Uint16Array.from([contextCode, contextCode + 1]);
  const groups = [
    {
      groupId: `context-${contextCode}-a`,
      groupName: `Context ${contextCode} A`,
      groupCode: contextCode,
      cellIndices: Uint32Array.from([0]),
      cellCount: 1,
      color: '#112233',
    },
    {
      groupId: `context-${contextCode}-b`,
      groupName: `Context ${contextCode} B`,
      groupCode: contextCode + 1,
      cellIndices: Uint32Array.from([1]),
      cellCount: 1,
      color: '#445566',
    },
  ];
  const dataLayer = createMarkerDataLayer(
    gene,
    Float32Array.from([contextCode + 1, contextCode + 2]),
  );
  const engine = new MarkerDiscoveryEngine({
    dataLayer,
    config: {
      minCells: 1,
      progressInterval: 1,
      batchSize: 1,
      networkConcurrency: 1,
      memoryBudgetMB: 1,
    },
  });
  const options = {
    obsCategory: `category-${contextCode}`,
    groups,
    obsCodes,
    geneList: [gene],
    method: 'ttest',
    topNPerGroup: 1,
    minCells: 1,
    pValueThreshold: 1,
    foldChangeThreshold: 0,
    useAdjustedPValue: false,
    parallelism: 1,
    batchConfig: {
      preloadCount: 1,
      networkConcurrency: 1,
      memoryBudgetMB: 1,
    },
  };
  return { engine, options };
}

function createWorkerMarkerResult() {
  return {
    nAll: 2,
    pValues: Float64Array.from([0.01, 0.02]),
    log2FoldChange: Float32Array.from([1, -1]),
    meanInGroup: Float32Array.from([2, 1]),
    meanOutGroup: Float32Array.from([1, 2]),
    percentInGroup: Float32Array.from([100, 50]),
    percentOutGroup: Float32Array.from([50, 100]),
    nIn: Uint32Array.from([1, 1]),
    nOut: Uint32Array.from([1, 1]),
  };
}

function readyPoolOverrides({ broadcast, execute }) {
  return {
    async init() {
      return true;
    },
    isReady() {
      return true;
    },
    getStats() {
      return {
        poolSize: 1,
        state: 'ready',
        failure: null,
        busyWorkers: 0,
        idleWorkers: 1,
        pendingRequests: 0,
        queuedTasks: 0,
      };
    },
    broadcast,
    execute,
  };
}

test('marker discovery keeps cooperative cancellation out of the shared worker pool', async () => {
  const { engine, options } = createDiscoveryFixture();
  const controller = new AbortController();
  const workerOptions = [];

  await withPatchedWorkerPool(
    readyPoolOverrides({
      async broadcast(type, createPayload, executionOptions) {
        assert.equal(type, 'MARKERS_SET_CONTEXT');
        assert.ok(createPayload(0).codes instanceof Uint16Array);
        workerOptions.push(['broadcast', executionOptions]);
        return [true];
      },
      async execute(type, payload, executionOptions) {
        assert.equal(type, 'MARKERS_COMPUTE_GENE');
        assert.ok(payload.values instanceof Float32Array);
        workerOptions.push(['execute', executionOptions]);
        return createWorkerMarkerResult();
      },
    }),
    async () => {
      await engine.discoverMarkers({
        ...options,
        signal: controller.signal,
      });
    },
  );

  assert.deepEqual(
    workerOptions.map(([owner]) => owner),
    ['broadcast', 'execute'],
  );
  for (const [owner, executionOptions] of workerOptions) {
    assert.equal(
      Object.hasOwn(executionOptions, 'signal'),
      false,
      `${owner} must not receive a cooperative AbortSignal`,
    );
  }
});

test('marker discovery preserves every prototype-named group id as an ordinary own result', async () => {
  const prototypeNames = Object.getOwnPropertyNames(Object.prototype);
  const prototypeDescriptors = Object.getOwnPropertyDescriptors(
    Object.prototype,
  );

  await withPatchedWorkerPool(
    readyPoolOverrides({
      async broadcast() {
        return [true];
      },
      async execute() {
        return createWorkerMarkerResult();
      },
    }),
    async () => {
      for (const [index, groupId] of prototypeNames.entries()) {
        const { engine, options } = createDiscoveryFixture({
          contextCode: index * 2,
          gene: `PROTO_GROUP_GENE_${index}`,
        });
        options.groups[0].groupId = groupId;

        const result = await engine.discoverMarkers(options);
        assert.equal(
          Object.getPrototypeOf(result.groups),
          Object.prototype,
          groupId,
        );
        assert.equal(Object.hasOwn(result.groups, groupId), true, groupId);
        assert.deepEqual(
          Object.getOwnPropertyDescriptor(result.groups, groupId),
          {
            configurable: true,
            enumerable: true,
            value: result.groups[groupId],
            writable: true,
          },
          groupId,
        );
        assert.equal(result.groups[groupId].groupId, groupId);
        assert.equal(result.groups[groupId].markers[0].groupId, groupId);
      }
    },
  );

  assert.deepEqual(
    Object.getOwnPropertyDescriptors(Object.prototype),
    prototypeDescriptors,
  );
});

test('marker abort drains a running worker task without publishing stale results or poisoning the pool', async () => {
  const { engine, options } = createDiscoveryFixture();
  const taskStarted = deferred();
  const taskGate = deferred();
  const abortController = new AbortController();
  const abortReason = new DOMException('Superseded marker request', 'AbortError');
  let poolUsable = true;
  let ingestCount = 0;
  const progressEvents = [];
  const partialEvents = [];

  const originalIngest = engine._ingestGeneResult;
  engine._ingestGeneResult = function ingestWithAudit(args) {
    ingestCount++;
    return originalIngest.call(this, args);
  };

  await withPatchedWorkerPool(
    readyPoolOverrides({
      async broadcast() {
        return [true];
      },
      async execute(type, _payload, executionOptions) {
        if (type === 'UNRELATED_POOL_TASK') {
          if (!poolUsable) {
            throw new Error('shared worker pool was poisoned by marker abort');
          }
          return { ok: true };
        }

        assert.equal(type, 'MARKERS_COMPUTE_GENE');
        if (executionOptions.signal !== undefined) {
          executionOptions.signal.addEventListener(
            'abort',
            () => {
              poolUsable = false;
            },
            { once: true },
          );
        }
        taskStarted.resolve();
        return taskGate.promise;
      },
    }),
    async pool => {
      const operation = engine.discoverMarkers({
        ...options,
        signal: abortController.signal,
        onProgress(event) {
          progressEvents.push(event);
        },
        onPartialResults(event) {
          partialEvents.push(event);
        },
      });
      let settled = false;
      void operation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await taskStarted.promise;
      const progressAtAbort = progressEvents.length;
      const partialAtAbort = partialEvents.length;
      abortController.abort(abortReason);
      await nextTurn();

      assert.equal(
        settled,
        false,
        'marker cancellation must drain the already-dispatched worker task',
      );
      taskGate.resolve(createWorkerMarkerResult());

      await assert.rejects(operation, error => error === abortReason);
      assert.equal(ingestCount, 0, 'an aborted result must not be ingested');
      assert.equal(
        progressEvents.length,
        progressAtAbort,
        'an aborted result must not advance progress',
      );
      assert.equal(
        partialEvents.length,
        partialAtAbort,
        'an aborted result must not emit partial markers',
      );
      assert.equal(poolUsable, true);
      await assert.doesNotReject(
        pool.execute('UNRELATED_POOL_TASK', {}, { timeout: 1 }),
      );
    },
  );
});

test('marker worker contexts are serialized across discovery engine instances', async () => {
  const first = createDiscoveryFixture({ contextCode: 0 });
  const second = createDiscoveryFixture({ contextCode: 2 });
  const firstTaskStarted = deferred();
  const firstTaskGate = deferred();
  const events = [];
  let currentContext = null;

  await withPatchedWorkerPool(
    readyPoolOverrides({
      async broadcast(type, createPayload) {
        assert.equal(type, 'MARKERS_SET_CONTEXT');
        const payload = createPayload(0);
        currentContext = payload.codes[0];
        events.push(`broadcast:${currentContext}`);
        return [true];
      },
      async execute(type) {
        assert.equal(type, 'MARKERS_COMPUTE_GENE');
        const ownedContext = currentContext;
        events.push(`execute:${ownedContext}:start`);
        if (ownedContext === 0) {
          firstTaskStarted.resolve();
          await firstTaskGate.promise;
        }
        events.push(`execute:${ownedContext}:end`);
        return createWorkerMarkerResult();
      },
    }),
    async () => {
      const firstOperation = first.engine.discoverMarkers(first.options);
      await firstTaskStarted.promise;
      const secondOperation = second.engine.discoverMarkers(second.options);
      second.options.obsCodes[0] = 99;
      second.options.groups[0].groupId = 'mutated-after-call';
      await nextTurn();
      const eventsBeforeFirstSettles = [...events];

      firstTaskGate.resolve();
      const results = await Promise.allSettled([firstOperation, secondOperation]);
      assert.deepEqual(
        results.map(result => result.status),
        ['fulfilled', 'fulfilled'],
      );
      assert.deepEqual(
        results[1].value.stats.groupIds,
        ['context-2-a', 'context-2-b'],
        'queued discovery must retain its entry-time group metadata snapshot',
      );

      assert.deepEqual(
        eventsBeforeFirstSettles,
        ['broadcast:0', 'execute:0:start'],
        'a second engine must not replace the module-global worker context',
      );
      assert.deepEqual(events, [
        'broadcast:0',
        'execute:0:start',
        'execute:0:end',
        'broadcast:2',
        'execute:2:start',
        'execute:2:end',
      ]);
    },
  );
});

test('queued marker discovery owns validated batch concurrency values', async () => {
  const first = createDiscoveryFixture({ contextCode: 0 });
  const waiting = createDiscoveryFixture({ contextCode: 2 });
  const firstTaskStarted = deferred();
  const firstTaskGate = deferred();
  let currentContext = null;

  await withPatchedWorkerPool(
    readyPoolOverrides({
      async broadcast(_type, createPayload) {
        currentContext = createPayload(0).codes[0];
        return [true];
      },
      async execute() {
        if (currentContext === 0) {
          firstTaskStarted.resolve();
          await firstTaskGate.promise;
        }
        return createWorkerMarkerResult();
      },
    }),
    async () => {
      const firstOperation = first.engine.discoverMarkers(first.options);
      await firstTaskStarted.promise;

      const ownedBatchConfig = {
        preloadCount: 1,
        networkConcurrency: 1,
        memoryBudgetMB: 1,
      };
      const waitingOperation = waiting.engine.discoverMarkers({
        ...waiting.options,
        batchConfig: ownedBatchConfig,
      });

      // Mutation happens after synchronous validation but while the run waits
      // for the first engine's module-global marker context.
      ownedBatchConfig.preloadCount = 0;
      ownedBatchConfig.networkConcurrency = 0;

      firstTaskGate.resolve();
      const [firstResult, waitingResult] = await Promise.all([
        firstOperation,
        waitingOperation,
      ]);
      assert.equal(firstResult.obsCategory, first.options.obsCategory);
      assert.equal(waitingResult.obsCategory, waiting.options.obsCategory);
    },
  );
});

test('an aborted marker-context waiter leaves the active lease immediately', async () => {
  const first = createDiscoveryFixture({ contextCode: 0 });
  const waiting = createDiscoveryFixture({ contextCode: 2 });
  const firstTaskStarted = deferred();
  const firstTaskGate = deferred();
  const waitingAbort = new AbortController();
  const abortReason = new DOMException('Queued marker run was superseded', 'AbortError');
  const broadcasts = [];

  await withPatchedWorkerPool(
    readyPoolOverrides({
      async broadcast(_type, createPayload) {
        broadcasts.push(createPayload(0).codes[0]);
        return [true];
      },
      async execute() {
        if (broadcasts.at(-1) === 0) {
          firstTaskStarted.resolve();
          await firstTaskGate.promise;
        }
        return createWorkerMarkerResult();
      },
    }),
    async () => {
      const firstOperation = first.engine.discoverMarkers(first.options);
      await firstTaskStarted.promise;
      const waitingOperation = waiting.engine.discoverMarkers({
        ...waiting.options,
        signal: waitingAbort.signal,
      });
      const waitingOutcome = waitingOperation.then(
        () => ({ status: 'fulfilled' }),
        error => ({ status: 'rejected', error }),
      );

      waitingAbort.abort(abortReason);
      await nextTurn();
      assert.deepEqual(
        await Promise.race([
          waitingOutcome,
          Promise.resolve({ status: 'still-pending' }),
        ]),
        { status: 'rejected', error: abortReason },
        'a queued cancellation must not wait for the unrelated active context',
      );
      assert.deepEqual(broadcasts, [0]);

      firstTaskGate.resolve();
      await firstOperation;
    },
  );
});

test('marker cancellation preserves a distinct worker failure by exact identity', async () => {
  const { engine, options } = createDiscoveryFixture();
  const taskStarted = deferred();
  const taskGate = deferred();
  const abortController = new AbortController();
  const abortReason = new DOMException('Marker request superseded', 'AbortError');
  const workerFailure = new DOMException('Shared worker terminated', 'AbortError');

  await withPatchedWorkerPool(
    readyPoolOverrides({
      async broadcast() {
        return [true];
      },
      async execute() {
        taskStarted.resolve();
        return taskGate.promise;
      },
    }),
    async () => {
      const operation = engine.discoverMarkers({
        ...options,
        signal: abortController.signal,
      });
      await taskStarted.promise;
      abortController.abort(abortReason);
      taskGate.reject(workerFailure);
      await assert.rejects(operation, error => error === workerFailure);
    },
  );
});

test('final marker partial callback abort rejects with the exact reason', async () => {
  const { engine, options } = createDiscoveryFixture();
  const abortController = new AbortController();
  const abortReason = new Error('final marker callback invalidated its owner');
  let finalCallbackCount = 0;

  await withPatchedWorkerPool(
    readyPoolOverrides({
      async broadcast() {
        return [true];
      },
      async execute() {
        return createWorkerMarkerResult();
      },
    }),
    async () => {
      const operation = engine.discoverMarkers({
        ...options,
        signal: abortController.signal,
        onPartialResults(event) {
          if (!event.isComplete) return;
          finalCallbackCount++;
          abortController.abort(abortReason);
        },
      });

      await assert.rejects(operation, error => error === abortReason);
    },
  );

  assert.equal(finalCallbackCount, 1);
});

test('concurrent controller initialization creates one engine and cache set', async () => {
  const previousIndexedDB = Object.getOwnPropertyDescriptor(
    globalThis,
    'indexedDB',
  );
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: undefined,
  });

  try {
    const controller = new GenesPanelController({ dataLayer: {} });
    controller._getDatasetId = () => 'init-lifecycle-dataset';

    const firstInit = controller.init();
    const firstSet = {
      discovery: controller._discoveryEngine,
      matrix: controller._matrixBuilder,
      clustering: controller._clusteringEngine,
      cache: controller._cache,
    };
    const secondInit = controller.init();
    const secondSet = {
      discovery: controller._discoveryEngine,
      matrix: controller._matrixBuilder,
      clustering: controller._clusteringEngine,
      cache: controller._cache,
    };

    await Promise.all([firstInit, secondInit]);
    for (const key of Object.keys(firstSet)) {
      assert.ok(firstSet[key], `${key} must be created during initialization`);
      assert.strictEqual(
        secondSet[key],
        firstSet[key],
        `concurrent init replaced the ${key} owner`,
      );
      assert.strictEqual(controller[`_${key === 'discovery'
        ? 'discoveryEngine'
        : key === 'matrix'
          ? 'matrixBuilder'
          : key === 'clustering'
            ? 'clusteringEngine'
            : 'cache'}`], firstSet[key]);
    }
  } finally {
    if (previousIndexedDB === undefined) {
      delete globalThis.indexedDB;
    } else {
      Object.defineProperty(globalThis, 'indexedDB', previousIndexedDB);
    }
  }
});

test('controller close is idempotent and waits for every active public operation', async () => {
  const matrixStarted = deferred();
  const matrixGate = deferred();
  const groupsStarted = deferred();
  const groupsGate = deferred();
  const controller = new GenesPanelController({ dataLayer: {} });
  let cacheCloseCount = 0;

  controller._initialized = true;
  controller._matrixBuilder = {
    async buildMatrix() {
      matrixStarted.resolve();
      return matrixGate.promise;
    },
  };
  controller._getGroupsFromCategory = async () => {
    groupsStarted.resolve();
    return groupsGate.promise;
  };
  controller._cache = {
    close() {
      cacheCloseCount++;
    },
  };

  const matrixOperation = controller.buildMatrixForGenes({
    genes: ['GENE'],
    groups: [],
  });
  const groupsOperation = controller.getGroupsAndCodes('category');
  await Promise.all([matrixStarted.promise, groupsStarted.promise]);

  const firstClose = controller.close();
  const secondClose = controller.close();
  assert.equal(
    cacheCloseCount,
    0,
    'cache ownership must outlive active controller operations',
  );

  const matrix = { genes: ['GENE'] };
  matrixGate.resolve(matrix);
  assert.strictEqual(await matrixOperation, matrix);
  await nextTurn();
  assert.equal(
    cacheCloseCount,
    0,
    'one remaining public operation must keep the cache open',
  );

  const groupResult = { groups: [], obsCodes: new Uint16Array() };
  groupsGate.resolve(groupResult);
  assert.strictEqual(await groupsOperation, groupResult);
  await Promise.all([
    Promise.resolve(firstClose),
    Promise.resolve(secondClose),
  ]);
  await nextTurn();
  assert.equal(cacheCloseCount, 1, 'repeated close must close the cache once');
});

for (const lifecycle of ['abort', 'close']) {
  test(`controller ${lifecycle} owns a run synchronously before initialization awaits`, async () => {
    const controller = new GenesPanelController({ dataLayer: {} });
    let groupAccesses = 0;
    let cacheCloseCount = 0;
    controller._initialized = true;
    controller._getGroupsFromCategory = async () => {
      groupAccesses++;
      throw new Error('a canceled run reached group loading');
    };
    controller._cache = {
      setDatasetId() {},
      close() {
        cacheCloseCount++;
      },
    };
    controller._getDatasetId = () => 'same-turn-cancel';

    const operation = controller.runAnalysis({
      obsCategory: 'category',
      useCache: false,
    });
    const closeTask = lifecycle === 'close'
      ? controller.close()
      : null;
    if (lifecycle === 'abort') controller.abort();

    await assert.rejects(operation, error => error?.name === 'AbortError');
    if (closeTask) await closeTask;
    assert.equal(groupAccesses, 0);
    assert.equal(cacheCloseCount, lifecycle === 'close' ? 1 : 0);

    if (lifecycle === 'abort') {
      await controller.close();
      assert.equal(cacheCloseCount, 1);
    }
  });
}

test('custom marker analysis rechecks cancellation after a matrix await', async () => {
  const matrixStarted = deferred();
  const matrixGate = deferred();
  const controller = new GenesPanelController({
    dataLayer: {
      getAvailableVariables(kind) {
        assert.equal(kind, 'gene_expression');
        return [{ key: 'GENE' }];
      },
    },
  });
  controller._initialized = true;
  controller._cache = {
    setDatasetId() {},
    close() {},
  };
  controller._getDatasetId = () => 'custom-cancel';
  controller._getGroupsFromCategory = async () => ({
    groups: [{ groupId: 'group', groupName: 'Group' }],
    obsCodes: Uint16Array.from([0]),
  });
  controller._matrixBuilder = {
    async buildMatrix() {
      matrixStarted.resolve();
      return matrixGate.promise;
    },
  };

  const operation = controller.runAnalysis({
    obsCategory: 'category',
    mode: 'custom',
    customGenes: ['GENE'],
    clusterRows: false,
    clusterCols: false,
  });
  await matrixStarted.promise;
  controller.abort();
  matrixGate.resolve({ genes: ['GENE'] });

  await assert.rejects(operation, error => error?.name === 'AbortError');
  await controller.close();
});

test('final marker progress cannot abort and then publish a fulfilled result', async () => {
  const controller = new GenesPanelController({ dataLayer: {} });
  controller._initialized = true;
  controller._getDatasetId = () => 'final-progress-cancel';
  controller._getGroupsFromCategory = async () => ({
    groups: [
      { groupId: 'a', groupName: 'A' },
      { groupId: 'b', groupName: 'B' },
    ],
    obsCodes: Uint16Array.from([0, 1]),
  });
  controller._cache = {
    setDatasetId() {},
    async get() {
      return {
        groups: {
          a: { markers: [{ gene: 'GENE' }] },
          b: { markers: [{ gene: 'GENE' }] },
        },
      };
    },
    close() {},
  };
  controller._matrixBuilder = {
    async buildMatrix() {
      return { genes: ['GENE'] };
    },
  };

  const operation = controller.runAnalysis({
    obsCategory: 'category',
    mode: 'ranked',
    clusterRows: false,
    clusterCols: false,
    onProgress(event) {
      if (event.phase === 'Rendering results') controller.abort();
    },
  });

  await assert.rejects(operation, error => error?.name === 'AbortError');
  await controller.close();
});

test('controller snapshots custom genes and batch configuration before its first await', async () => {
  const groupsGate = deferred();
  const customGenes = ['GENE'];
  const batchConfig = {
    preloadCount: 1,
    networkConcurrency: 1,
    memoryBudgetMB: 1,
  };
  const seen = [];
  const controller = new GenesPanelController({
    dataLayer: {
      getAvailableVariables() {
        return [{ key: 'GENE' }];
      },
    },
  });
  controller._initialized = true;
  controller._cache = {
    setDatasetId() {},
    close() {},
  };
  controller._getDatasetId = () => 'owned-controller-options';
  controller._getGroupsFromCategory = () => groupsGate.promise;
  controller._matrixBuilder = {
    async buildMatrix(options) {
      seen.push(options);
      return { genes: [...options.genes] };
    },
  };

  const operation = controller.runAnalysis({
    obsCategory: 'category',
    mode: 'custom',
    customGenes,
    batchConfig,
    clusterRows: false,
    clusterCols: false,
  });
  customGenes[0] = 'MUTATED';
  customGenes.push('LATE');
  batchConfig.preloadCount = 999;
  groupsGate.resolve({
    groups: [{ groupId: 'group', groupName: 'Group' }],
    obsCodes: Uint16Array.from([0]),
  });

  const result = await operation;
  assert.deepEqual(result.matrix.genes, ['GENE']);
  assert.deepEqual(seen[0].genes, ['GENE']);
  assert.deepEqual(seen[0].batchConfig, {
    preloadCount: 1,
    networkConcurrency: 1,
    memoryBudgetMB: 1,
  });
  await controller.close();
});

test('controller snapshots matrix-helper inputs before initialization awaits', async () => {
  const initGate = deferred();
  const observed = [];
  const firstProgress = () => {};
  const replacementProgress = () => {};
  const firstAbort = new AbortController();
  const replacementAbort = new AbortController();
  const cellIndices = Uint32Array.from([0, 1]);
  const options = {
    genes: ['GENE'],
    groups: [{
      groupId: 'group-a',
      groupName: 'Group A',
      color: '#112233',
      cellIndices,
    }],
    transform: 'zscore',
    batchConfig: {
      preloadCount: 2,
      networkConcurrency: 1,
      memoryBudgetMB: 4,
    },
    onProgress: firstProgress,
    signal: firstAbort.signal,
  };
  const controller = new GenesPanelController({ dataLayer: {} });
  controller.init = () => initGate.promise;
  controller._matrixBuilder = {
    async buildMatrix(ownedOptions) {
      observed.push(ownedOptions);
      return { genes: [...ownedOptions.genes] };
    },
  };

  const operation = controller.buildMatrixForGenes(options);
  options.genes[0] = 'MUTATED';
  options.genes.push('LATE');
  options.groups[0].groupId = 'mutated-group';
  options.groups[0].cellIndices = Uint32Array.from([99]);
  options.groups.push({ groupId: 'late-group' });
  options.transform = 'none';
  options.batchConfig.preloadCount = 999;
  options.onProgress = replacementProgress;
  options.signal = replacementAbort.signal;
  initGate.resolve();

  assert.deepEqual(await operation, { genes: ['GENE'] });
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0].genes, ['GENE']);
  assert.equal(observed[0].groups.length, 1);
  assert.equal(observed[0].groups[0].groupId, 'group-a');
  assert.strictEqual(observed[0].groups[0].cellIndices, cellIndices);
  assert.equal(observed[0].transform, 'zscore');
  assert.deepEqual(observed[0].batchConfig, {
    preloadCount: 2,
    networkConcurrency: 1,
    memoryBudgetMB: 4,
  });
  assert.strictEqual(observed[0].onProgress, firstProgress);
  assert.strictEqual(observed[0].signal, firstAbort.signal);
  await controller.close();
});

test('controller snapshots group-helper callbacks before initialization awaits', async () => {
  const initGate = deferred();
  const firstProgress = () => {};
  const replacementProgress = () => {};
  const firstAbort = new AbortController();
  const replacementAbort = new AbortController();
  const options = {
    onProgress: firstProgress,
    signal: firstAbort.signal,
  };
  const controller = new GenesPanelController({ dataLayer: {} });
  controller.init = () => initGate.promise;
  let observedOptions = null;
  controller._getGroupsFromCategory = async (_category, ownedOptions) => {
    observedOptions = ownedOptions;
    return { groups: [], obsCodes: new Uint16Array() };
  };

  const operation = controller.getGroupsAndCodes('category', options);
  options.onProgress = replacementProgress;
  options.signal = replacementAbort.signal;
  initGate.resolve();

  await operation;
  assert.strictEqual(observedOptions.onProgress, firstProgress);
  assert.strictEqual(observedOptions.signal, firstAbort.signal);
  await controller.close();
});

test('controller snapshots recluster inputs before initialization awaits', async () => {
  const initGate = deferred();
  const values = Float32Array.from([1, 2, 3, 4]);
  const matrix = {
    genes: ['GENE_A', 'GENE_B'],
    groupIds: ['group-a', 'group-b'],
    groupNames: ['Group A', 'Group B'],
    groupColors: ['#112233', '#445566'],
    values,
    rawValues: null,
    nRows: 2,
    nCols: 2,
    transform: 'zscore',
  };
  const result = {
    matrix,
    metadata: {
      distance: 'correlation',
      linkage: 'average',
      clusterRows: true,
      clusterCols: false,
      note: 'owned',
    },
    tag: 'original-result',
  };
  const options = {};
  const observed = [];
  const clustering = { rowOrder: [1, 0], colOrder: [0, 1] };
  const orderedMatrix = { ordered: true };
  const controller = new GenesPanelController({ dataLayer: {} });
  controller.init = () => initGate.promise;
  controller._clusteringEngine = {
    async clusterMatrix(ownedOptions) {
      observed.push(ownedOptions);
      return clustering;
    },
    applyOrdering(ownedMatrix, ownedClustering) {
      assert.strictEqual(ownedMatrix, observed[0].matrix);
      assert.strictEqual(ownedClustering, clustering);
      return orderedMatrix;
    },
  };

  const operation = controller.recluster(result, options);
  options.distance = 'euclidean';
  options.linkage = 'complete';
  options.clusterRows = false;
  options.clusterCols = true;
  result.matrix = { replaced: true };
  matrix.genes[0] = 'MUTATED_GENE';
  matrix.groupIds[0] = 'mutated-group';
  result.metadata.distance = 'cosine';
  result.metadata.note = 'mutated';
  result.tag = 'mutated-result';
  initGate.resolve();

  const output = await operation;
  assert.equal(observed.length, 1);
  assert.equal(observed[0].distance, 'correlation');
  assert.equal(observed[0].linkage, 'average');
  assert.equal(observed[0].clusterRows, true);
  assert.equal(observed[0].clusterCols, false);
  assert.deepEqual(observed[0].matrix.genes, ['GENE_A', 'GENE_B']);
  assert.deepEqual(observed[0].matrix.groupIds, ['group-a', 'group-b']);
  assert.strictEqual(observed[0].matrix.values, values);
  assert.strictEqual(output.matrix, orderedMatrix);
  assert.strictEqual(output.clustering, clustering);
  assert.equal(output.tag, 'original-result');
  assert.equal(output.metadata.note, 'owned');
  assert.equal(output.metadata.distance, 'correlation');
  assert.equal(output.metadata.linkage, 'average');
  await controller.close();
});

test('Genes Panel invalidation during controller init cannot start stale discovery', async () => {
  const initGate = deferred();
  const originalInit = Object.getOwnPropertyDescriptor(
    GenesPanelController.prototype,
    'init',
  );
  const originalRunAnalysis = Object.getOwnPropertyDescriptor(
    GenesPanelController.prototype,
    'runAnalysis',
  );
  let initCalls = 0;
  let discoveryCalls = 0;

  Object.defineProperty(GenesPanelController.prototype, 'init', {
    configurable: true,
    writable: true,
    value() {
      initCalls++;
      return initGate.promise;
    },
  });
  Object.defineProperty(GenesPanelController.prototype, 'runAnalysis', {
    configurable: true,
    writable: true,
    async value() {
      discoveryCalls++;
      return {
        matrix: { genes: ['GENE'] },
        markers: null,
        clustering: null,
        metadata: {},
      };
    },
  });

  const ui = new GenesPanelUI({
    comparisonModule: {},
    dataLayer: {},
  });
  ui._getFormValues = () => ({
    obsCategory: 'category',
    mode: 'custom',
    customGenes: ['GENE'],
  });
  ui._validateForm = () => ({ valid: true });
  ui._buildHeatmapMatrixForMode = () => ({ genes: ['GENE'] });

  try {
    await withoutProgressNotifications(async () => {
      const operation = ui._runAnalysis();
      await nextTurn();
      assert.equal(initCalls, 1);

      ui._invalidateAnalysisRequest();
      initGate.resolve();
      await operation;

      assert.equal(
        discoveryCalls,
        0,
        'an intent invalidated during init must not start marker discovery',
      );
    });
  } finally {
    Object.defineProperty(
      GenesPanelController.prototype,
      'init',
      originalInit,
    );
    Object.defineProperty(
      GenesPanelController.prototype,
      'runAnalysis',
      originalRunAnalysis,
    );
    await ui._controller?.close();
  }
});

test('Genes Panel invalidation aborts its active discovery owner', async () => {
  const discoveryStarted = deferred();
  const discoveryGate = deferred();
  const abortReason = new DOMException(
    'Marker UI request invalidated',
    'AbortError',
  );
  let abortCount = 0;
  let settleDiscovery = null;

  const ui = new GenesPanelUI({
    comparisonModule: {},
    dataLayer: {},
  });
  ui._controller = {
    runAnalysis() {
      discoveryStarted.resolve();
      return discoveryGate.promise;
    },
    abort() {
      abortCount++;
      settleDiscovery?.reject(abortReason);
    },
  };
  ui._getFormValues = () => ({
    obsCategory: 'category',
    mode: 'clustered',
  });
  ui._validateForm = () => ({ valid: true });

  await withoutProgressNotifications(async () => {
    const operation = ui._runAnalysis();
    await discoveryStarted.promise;
    settleDiscovery = discoveryGate;
    ui._invalidateAnalysisRequest();
    await nextTurn();

    const observedAbortCount = abortCount;
    if (observedAbortCount === 0) {
      discoveryGate.resolve({
        matrix: { genes: ['GENE'] },
        markers: null,
        clustering: null,
        metadata: {},
      });
    }
    await operation;
    assert.equal(
      observedAbortCount,
      1,
      'request invalidation must cooperatively abort stale marker discovery',
    );
  });
});

function createMarkerCacheKeyAuditController(minCells, observedParams) {
  const markers = {
    groups: {
      a: { markers: [{ gene: 'GENE' }] },
      b: { markers: [{ gene: 'GENE' }] },
    },
  };
  const controller = new GenesPanelController({
    dataLayer: {},
    config: { minCells },
  });
  controller._initialized = true;
  controller._getDatasetId = () => 'cache-key-audit';
  controller._getGroupsFromCategory = async () => ({
    groups: [{ groupId: 'a' }, { groupId: 'b' }],
    obsCodes: Uint16Array.from([0, 1]),
  });
  controller._cache = {
    setDatasetId() {},
    async get(_category, params) {
      observedParams.push(structuredClone(params));
      return markers;
    },
    close() {},
  };
  controller._matrixBuilder = {
    async buildMatrix() {
      return { genes: ['GENE'] };
    },
  };
  return controller;
}

function canonicalCacheParams(params) {
  return JSON.stringify(Object.entries(params).sort(([left], [right]) =>
    left.localeCompare(right)
  ));
}

test('marker hot cache isolates mutable result envelopes from UI threshold rebuilds', async () => {
  const pValues = Float64Array.from([0.01]);
  const markers = {
    obsCategory: 'category',
    groups: {
      a: {
        groupId: 'a',
        markers: [{ gene: 'GENE', groupId: 'a', rank: 1 }],
      },
    },
    stats: {
      genes: ['GENE'],
      groupIds: ['a'],
      pValuesByGroup: [pValues],
      adjustedPValuesByGroup: [Float64Array.from([0.01])],
      log2FoldChangeByGroup: [Float32Array.from([2])],
    },
  };
  const params = {
    method: 'ttest',
    topNPerGroup: 1,
    pValueThreshold: 0.05,
    foldChangeThreshold: 1,
    useAdjustedPValue: true,
    minCells: 1,
    groupingDigest: computeCategoryGroupingDigest(Uint16Array.from([0, 1])),
  };
  const cache = new MarkerCache({
    datasetId: 'cache-ownership-audit',
    maxCategories: 1,
  });

  await cache.set('category', markers, params);
  markers.groups.a.markers[0].gene = 'MUTATED_AFTER_SET';
  markers.stats.genes[0] = 'MUTATED_AFTER_SET';

  const first = await cache.get('category', params);
  assert.equal(first.groups.a.markers[0].gene, 'GENE');
  assert.deepEqual(first.stats.genes, ['GENE']);
  assert.strictEqual(
    first.stats.pValuesByGroup[0],
    pValues,
    'read-only typed statistic buffers should not be duplicated',
  );

  first.groups.a.markers[0].gene = 'MUTATED_NESTED_VIEW';
  first.groups = {
    a: {
      groupId: 'a',
      markers: [{ gene: 'THRESHOLD_REBUILD', groupId: 'a', rank: 1 }],
    },
  };
  first.stats.genes[0] = 'MUTATED_STATS_VIEW';
  first.stats.groupIds[0] = 'mutated-group';
  first.stats.pValuesByGroup.push(Float64Array.from([0.5]));

  const second = await cache.get('category', params);
  assert.notStrictEqual(second, first);
  assert.equal(second.groups.a.markers[0].gene, 'GENE');
  assert.deepEqual(second.stats.genes, ['GENE']);
  assert.deepEqual(second.stats.groupIds, ['a']);
  assert.equal(second.stats.pValuesByGroup.length, 1);
  assert.strictEqual(second.stats.pValuesByGroup[0], pValues);
  cache.close();
});

test('controller marker cache keys own adjusted-p semantics', async () => {
  const observed = [];
  const controller = createMarkerCacheKeyAuditController(2, observed);
  try {
    await controller.runAnalysis({
      obsCategory: 'category',
      mode: 'ranked',
      useAdjustedPValue: false,
    });
    await controller.runAnalysis({
      obsCategory: 'category',
      mode: 'ranked',
      useAdjustedPValue: true,
    });
    assert.deepEqual(
      observed.map(params => params.useAdjustedPValue),
      [false, true],
    );
    assert.notEqual(
      canonicalCacheParams(observed[0]),
      canonicalCacheParams(observed[1]),
      'raw-p and adjusted-p marker results must not share a cache key',
    );
  } finally {
    await controller.close();
  }
});

test('controller marker cache keys own min-cell semantics', async () => {
  const firstObserved = [];
  const first = createMarkerCacheKeyAuditController(2, firstObserved);
  const secondObserved = [];
  const second = createMarkerCacheKeyAuditController(3, secondObserved);
  try {
    await first.runAnalysis({
      obsCategory: 'category',
      mode: 'ranked',
      useAdjustedPValue: false,
    });
    await second.runAnalysis({
      obsCategory: 'category',
      mode: 'ranked',
      useAdjustedPValue: false,
    });
    assert.equal(firstObserved[0].minCells, 2);
    assert.equal(secondObserved[0].minCells, 3);
    assert.notEqual(
      canonicalCacheParams(firstObserved[0]),
      canonicalCacheParams(secondObserved[0]),
      'marker results computed with different minCells must not share a cache key',
    );
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

function createMarkerGroupingAuditController(obsCodes, observedParams) {
  const markers = {
    obsCategory: 'category',
    groups: {
      a: { groupId: 'a', markers: [{ gene: 'GENE' }] },
      b: { groupId: 'b', markers: [{ gene: 'GENE' }] },
    },
  };
  const controller = new GenesPanelController({
    dataLayer: {},
    config: { minCells: 1 },
  });
  controller._initialized = true;
  controller._getDatasetId = () => 'grouping-identity-audit';
  controller._getGroupsFromCategory = async () => ({
    groups: [{ groupId: 'a' }, { groupId: 'b' }],
    obsCodes,
  });
  controller._cache = {
    setDatasetId() {},
    async get(_category, params) {
      observedParams.push({ ...params });
      return markers;
    },
    close() {},
  };
  controller._matrixBuilder = {
    async buildMatrix() {
      return { genes: ['GENE'] };
    },
  };
  return controller;
}

test('category grouping digest is the exact per-cell code assignment', () => {
  const base = Uint16Array.from([0, 0, 1, 1, 2, 2]);
  assert.match(computeCategoryGroupingDigest(base), /^[0-9a-f]{32}$/);
  assert.equal(
    computeCategoryGroupingDigest(base),
    computeCategoryGroupingDigest(Uint16Array.from([0, 0, 1, 1, 2, 2])),
    'the same grouping must produce the same digest',
  );

  // One cell moved between groups. Group sizes are unchanged, so any digest
  // built from cardinality alone would collide here.
  assert.notEqual(
    computeCategoryGroupingDigest(base),
    computeCategoryGroupingDigest(Uint16Array.from([0, 1, 0, 1, 2, 2])),
    'a single reassigned cell must change the digest',
  );

  // Merging two categories: every cell coded 2 becomes 1. This is exactly what
  // an in-place category merge does to a user-defined field.
  assert.notEqual(
    computeCategoryGroupingDigest(base),
    computeCategoryGroupingDigest(Uint16Array.from([0, 0, 1, 1, 1, 1])),
    'a merged category must change the digest',
  );

  // Moving a category to "unassigned" (the 65535 missing marker).
  assert.notEqual(
    computeCategoryGroupingDigest(base),
    computeCategoryGroupingDigest(Uint16Array.from([0, 0, 1, 1, 65535, 65535])),
    'cells moved to unassigned must change the digest',
  );

  for (const invalid of [null, undefined, new Uint16Array(0), [0, 1], Uint32Array.from([0, 1])]) {
    assert.throws(
      () => computeCategoryGroupingDigest(invalid),
      /non-empty Uint16Array/i,
    );
  }
});

test('marker cache entries are addressed by the grouping they were computed over', async () => {
  const cache = new MarkerCache({
    datasetId: 'grouping-identity-audit',
    maxCategories: 4,
  });
  const baseParams = {
    method: 'wilcox',
    topNPerGroup: 10,
    pValueThreshold: 0.05,
    foldChangeThreshold: 1,
    useAdjustedPValue: true,
    minCells: 10,
  };
  const beforeEdit = {
    ...baseParams,
    groupingDigest: computeCategoryGroupingDigest(
      Uint16Array.from([0, 0, 1, 1, 2, 2]),
    ),
  };
  const afterMerge = {
    ...baseParams,
    groupingDigest: computeCategoryGroupingDigest(
      Uint16Array.from([0, 0, 1, 1, 1, 1]),
    ),
  };

  await cache.set('cell_type', { marker: 'before' }, beforeEdit);
  assert.deepEqual(await cache.get('cell_type', beforeEdit), { marker: 'before' });
  assert.equal(
    await cache.get('cell_type', afterMerge),
    null,
    'a rewritten grouping must not read the previous grouping\'s markers',
  );

  await assert.rejects(
    async () => cache.get('cell_type', baseParams),
    /groupingDigest/,
    'omitting the grouping identity is a caller defect, not a cache miss',
  );
  await assert.rejects(
    async () => cache.set('cell_type', { marker: 'x' }, {
      ...baseParams,
      groupingDigest: 'not-a-digest',
    }),
    /groupingDigest/,
  );
  cache.close();
});

test('controller marker cache keys own grouping identity', async () => {
  const beforeObserved = [];
  const before = createMarkerGroupingAuditController(
    Uint16Array.from([0, 0, 1, 1, 2, 2]),
    beforeObserved,
  );
  const afterObserved = [];
  // The same category key after an in-place merge of codes 1 and 2.
  const after = createMarkerGroupingAuditController(
    Uint16Array.from([0, 0, 1, 1, 1, 1]),
    afterObserved,
  );
  try {
    await before.runAnalysis({ obsCategory: 'category', mode: 'ranked' });
    await after.runAnalysis({ obsCategory: 'category', mode: 'ranked' });

    assert.match(beforeObserved[0].groupingDigest, /^[0-9a-f]{32}$/);
    assert.notEqual(
      canonicalCacheParams(beforeObserved[0]),
      canonicalCacheParams(afterObserved[0]),
      'markers computed over different groupings must not share a cache key',
    );
  } finally {
    await Promise.all([before.close(), after.close()]);
  }
});

// =============================================================================
// UNTESTABLE MARKER GROUPS
//
// A group is compared against the rest one gene at a time, and data-worker.js
// runs that comparison only when the group and the rest each hold at least
// max(2, minCells) cells with a measured value for the gene. Otherwise it leaves
// NaN. Direct AnnData reaches the panel through getGeneExpression, which passes
// X through without a finiteness check, so a gene with missing values is an
// ordinary input rather than a corrupt one.
//
// Every constant below is the value SciPy 1.16.3 produces on the same fixture:
//   scipy.stats.mannwhitneyu(group, rest, alternative='two-sided',
//                            method='asymptotic', use_continuity=True)
//   scipy.stats.false_discovery_control(tested_p_values, method='bh')
// with the correction applied to the tested subset only.
// =============================================================================

const UNTESTABLE_GROUP_CELLS = 12;
const UNTESTABLE_MIN_CELLS = 10;
const UNTESTABLE_LOW = [0, 0, 1, 0, 2, 1, 0, 0, 1, 0, 0, 1];
const UNTESTABLE_HIGH = [3, 4, 3, 5, 4, 3, 4, 6, 5, 4, 3, 4];
const UNTESTABLE_OTHER = [0, 1, 0, 0, 1, 0, 2, 0, 0, 1, 0, 0];
const UNTESTABLE_MISSING = new Array(UNTESTABLE_GROUP_CELLS).fill(Number.NaN);

const UNTESTABLE_GENES = {
  // Measured everywhere: all three groups are compared.
  GENE_ALL: [...UNTESTABLE_LOW, ...UNTESTABLE_HIGH, ...UNTESTABLE_OTHER],
  // Missing across the whole third group: groups one and two still compare
  // 12 against 12, the third has nothing to compare.
  GENE_PARTIAL: [...UNTESTABLE_LOW, ...UNTESTABLE_HIGH, ...UNTESTABLE_MISSING],
  // Three measured cells in total: no group clears the min-cell rule, and the
  // rest of the sample is empty for the one group that has any cells at all.
  GENE_SPARSE: [
    1, 2, 3, ...new Array(UNTESTABLE_GROUP_CELLS - 3).fill(Number.NaN),
    ...UNTESTABLE_MISSING,
    ...UNTESTABLE_MISSING,
  ],
  // Measured nowhere: nAll is zero.
  GENE_ABSENT: [
    ...UNTESTABLE_MISSING,
    ...UNTESTABLE_MISSING,
    ...UNTESTABLE_MISSING,
  ],
};

function assertRelativeValue(actual, expected, label, relativeTolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * relativeTolerance,
    `${label}: ${actual} is not within ${relativeTolerance} relative of ${expected}`,
  );
}

function createUntestableMarkerFixture() {
  const geneKeys = Object.keys(UNTESTABLE_GENES);
  const totalCells = UNTESTABLE_GROUP_CELLS * 3;
  const obsCodes = new Uint16Array(totalCells);
  for (let cell = 0; cell < totalCells; cell++) {
    obsCodes[cell] = Math.floor(cell / UNTESTABLE_GROUP_CELLS);
  }
  const groups = [0, 1, 2].map(groupCode => ({
    groupId: `group-${groupCode}`,
    groupName: `Group ${groupCode}`,
    groupCode,
    cellIndices: Uint32Array.from(
      { length: UNTESTABLE_GROUP_CELLS },
      (_unused, offset) => groupCode * UNTESTABLE_GROUP_CELLS + offset,
    ),
    cellCount: UNTESTABLE_GROUP_CELLS,
    color: '#123456',
  }));

  const dataLayer = {
    state: { pointCount: totalCells },
    getAvailableVariables(kind) {
      assert.equal(kind, 'gene_expression');
      return geneKeys.map(key => ({ key, name: key }));
    },
    async ensureGeneExpressionLoaded(gene, options) {
      assert.deepEqual(options, { silent: true });
      return { values: Float32Array.from(UNTESTABLE_GENES[gene]) };
    },
    unloadGeneExpression() {
      return true;
    },
    invalidateVariable() {},
  };

  const engine = new MarkerDiscoveryEngine({
    dataLayer,
    config: {
      minCells: UNTESTABLE_MIN_CELLS,
      progressInterval: 1,
      batchSize: 1,
      networkConcurrency: 1,
      memoryBudgetMB: 1,
    },
  });

  return {
    engine,
    geneKeys,
    options: {
      obsCategory: 'untestable-groups',
      groups,
      obsCodes,
      geneList: geneKeys,
      method: 'wilcox',
      topNPerGroup: 'all',
      minCells: UNTESTABLE_MIN_CELLS,
      pValueThreshold: 1,
      foldChangeThreshold: 0,
      useAdjustedPValue: false,
      parallelism: 1,
      batchConfig: {
        preloadCount: 1,
        networkConcurrency: 1,
        memoryBudgetMB: 1,
      },
    },
  };
}

async function withRealMarkerWorkerPool(callback) {
  const messages = [];
  globalThis.self = { postMessage: message => messages.push(message) };
  await import(
    '../assets/js/app/analysis/compute/data-worker.js?untestable-marker-groups'
  );
  let requestCounter = 0;
  const dispatch = (type, payload) => {
    const requestId = `untestable-${requestCounter++}`;
    globalThis.self.onmessage({ data: { type, payload, requestId } });
    const message = messages.at(-1);
    assert.equal(message.requestId, requestId);
    assert.equal(message.success, true, message.error);
    return message.result;
  };

  try {
    return await withPatchedWorkerPool(
      readyPoolOverrides({
        async broadcast(type, createPayload) {
          return [dispatch(type, createPayload(0))];
        },
        async execute(type, payload) {
          return dispatch(type, payload);
        },
      }),
      callback,
    );
  } finally {
    delete globalThis.self;
  }
}

test('a group that could not be tested is reported, not treated as a defect', async () => {
  const { engine, geneKeys, options } = createUntestableMarkerFixture();

  const result = await withRealMarkerWorkerPool(
    () => engine.discoverMarkers(options),
  );

  const geneIndex = Object.fromEntries(
    geneKeys.map((gene, index) => [gene, index]),
  );
  assert.deepEqual(result.stats.genes, geneKeys);
  assert.equal(result.minCellsPerSide, UNTESTABLE_MIN_CELLS);

  // scipy.stats.mannwhitneyu on the same Float32 fixture. `null` marks the
  // (group, gene) pairs where one side held fewer than 10 measured cells, so no
  // comparison was run at all.
  const scipyPValues = {
    'group-0': {
      GENE_ALL: 0.020701755492849257,
      GENE_PARTIAL: 0.00002465264969586051,
      GENE_SPARSE: null,
      GENE_ABSENT: null,
    },
    'group-1': {
      GENE_ALL: 4.908663904833548e-7,
      GENE_PARTIAL: 0.00002465264969586051,
      GENE_SPARSE: null,
      GENE_ABSENT: null,
    },
    'group-2': {
      GENE_ALL: 0.006956001858611514,
      GENE_PARTIAL: null,
      GENE_SPARSE: null,
      GENE_ABSENT: null,
    },
  };

  // scipy.stats.false_discovery_control over the tested subset of each group.
  // The denominators are 2, 2 and 1 — never 4. Group 2's single tested gene is
  // the sharpest case: with the untested genes counted its adjusted value would
  // be 0.006956 * 4 = 0.0278 instead of the p-value itself.
  const scipyAdjusted = {
    'group-0': {
      GENE_ALL: 0.020701755492849257,
      GENE_PARTIAL: 0.00004930529939172102,
    },
    'group-1': {
      GENE_ALL: 9.817327809667096e-7,
      GENE_PARTIAL: 0.00002465264969586051,
    },
    'group-2': {
      GENE_ALL: 0.006956001858611514,
    },
  };

  const expectedCounts = {
    'group-0': { genesTested: 2, genesUntestable: 2 },
    'group-1': { genesTested: 2, genesUntestable: 2 },
    'group-2': { genesTested: 1, genesUntestable: 3 },
  };

  for (let g = 0; g < result.stats.groupIds.length; g++) {
    const groupId = result.stats.groupIds[g];
    const rawLane = result.stats.pValuesByGroup[g];
    const adjustedLane = result.stats.adjustedPValuesByGroup[g];
    assert.ok(adjustedLane instanceof Float64Array, groupId);

    for (const gene of geneKeys) {
      const index = geneIndex[gene];
      const expectedRaw = scipyPValues[groupId][gene];
      if (expectedRaw === null) {
        assert.ok(
          Number.isNaN(rawLane[index]),
          `${groupId}/${gene} must carry no p-value`,
        );
        assert.ok(
          Number.isNaN(adjustedLane[index]),
          `${groupId}/${gene} must carry no adjusted p-value`,
        );
        continue;
      }
      assertRelativeValue(rawLane[index], expectedRaw, `${groupId}/${gene} p`);
      assertRelativeValue(
        adjustedLane[index],
        scipyAdjusted[groupId][gene],
        `${groupId}/${gene} adjusted`,
      );
    }

    const group = result.groups[groupId];
    assert.equal(group.genesTested, expectedCounts[groupId].genesTested, groupId);
    assert.equal(
      group.genesUntestable,
      expectedCounts[groupId].genesUntestable,
      groupId,
    );
    assert.equal(
      group.genesTested + group.genesUntestable,
      geneKeys.length,
      `${groupId} counts must partition the panel`,
    );

    // Only tested genes can be ranked. An untested gene has no probability, so
    // it is absent from the list rather than sorted in at the bottom.
    for (const marker of group.markers) {
      assert.notEqual(
        scipyPValues[groupId][marker.gene],
        null,
        `${groupId} ranked "${marker.gene}", which was never tested`,
      );
      assert.ok(Number.isFinite(marker.pValue), `${groupId}/${marker.gene}`);
      assert.ok(
        Number.isFinite(marker.adjustedPValue),
        `${groupId}/${marker.gene}`,
      );
    }
    assert.deepEqual(
      group.markers.map(marker => marker.gene).sort(),
      Object.keys(scipyAdjusted[groupId]).sort(),
      groupId,
    );
  }
});

/**
 * Minimal element stub for the one caption builder under test: it appends text
 * nodes and <strong> children and reads them back through textContent.
 */
class SummaryElementStub {
  constructor(tagName) {
    this.tagName = tagName;
    this.className = '';
    this.hidden = false;
    this.childNodes = [];
    this._text = '';
  }

  set textContent(value) {
    this._text = String(value);
    this.childNodes = [];
  }

  get textContent() {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes
      .map(node => (typeof node === 'string' ? node : node.textContent))
      .join('');
  }

  append(...nodes) {
    for (const node of nodes) this.childNodes.push(node);
  }
}

function withSummaryDOM(run) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement(tagName) {
      return new SummaryElementStub(tagName);
    },
  };
  try {
    return run();
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

test('the genes panel states the denominator each marker group was corrected over', () => {
  withSummaryDOM(() => {
  const ui = Object.create(GenesPanelUI.prototype);

  const tested = ui._createGroupTestingSummary(
    { genesTested: 1, genesUntestable: 3 },
    10,
  );
  assert.equal(tested.hidden, false);
  assert.equal(
    tested.textContent,
    '1 genes tested (FDR denominator) · 3 not tested (fewer than 10 cells '
      + 'with a measured value in this group or in the rest)',
  );

  const complete = ui._createGroupTestingSummary(
    { genesTested: 2000, genesUntestable: 0 },
    10,
  );
  assert.equal(
    complete.textContent,
    `${(2000).toLocaleString()} genes tested (FDR denominator)`,
  );

  // Partial emissions have corrected nothing yet and must claim no denominator.
  const partial = ui._createGroupTestingSummary(
    { genesTested: null, genesUntestable: null },
    10,
  );
  assert.equal(partial.hidden, true);
  assert.equal(partial.textContent, '');
  });
});
