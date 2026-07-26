import assert from 'node:assert/strict';
import test from 'node:test';

import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { H5adDataSource } from '../assets/js/data/h5ad.js';
import { ZarrDataSource } from '../assets/js/data/zarr.js';

const INVALIDATED_REQUEST =
  /(dataset|adapter|cache|request).*(changed|cleared|closed|invalidated|superseded)|superseded|no longer active/i;

const BASE_EMBEDDING = {
  data: Float32Array.from([-1, -1, 0, 0, 1, 1]),
  nDims: 2,
};

const OLD_RESULTS = {
  embedding: {
    data: Float32Array.from([0, 0, 2, 0, 1, 0]),
    nDims: 2,
  },
  vector: {
    data: Float32Array.from([1, 2, 3, 4, 5, 6]),
    nDims: 2,
  },
  obs: {
    dtype: 'float',
    values: Float32Array.from([1, 2, 3]),
  },
  connectivity: denseConnectivity(0, 1),
};

const FRESH_RESULTS = {
  embedding: {
    data: Float32Array.from([0, 0, 0, 2, 0, 1]),
    nDims: 2,
  },
  vector: {
    data: Float32Array.from([9, 10, 11, 12, 13, 14]),
    nDims: 2,
  },
  obs: {
    dtype: 'float',
    values: Float32Array.from([9, 10, 11]),
  },
  connectivity: denseConnectivity(1, 2),
};

function denseConnectivity(source, destination) {
  const data = new Float32Array(9);
  data[source * 3 + destination] = 1;
  data[destination * 3 + source] = 1;
  return {
    format: 'dense',
    shape: [3, 3],
    data,
  };
}

function deferred() {
  let markStarted;
  let reject;
  let release;
  const started = new Promise(resolve => {
    markStarted = resolve;
  });
  const value = new Promise((resolve, rejectPromise) => {
    release = resolve;
    reject = rejectPromise;
  });

  return {
    reject,
    started,
    wait() {
      markStarted();
      return value;
    },
    release,
  };
}

const COALESCED_PATHS = [
  'embedding',
  'obs',
  'vector',
  'connectivity',
  'gene',
];

function installPrivateCoordinateResolution(adapter) {
  const embeddingKeys =
    adapter._metadata?.embeddings?.obsm_keys;
  adapter._embeddingKeysByDimension = embeddingKeys
    ? { ...embeddingKeys }
    : null;
  adapter._vectorFieldKeysById.clear();
  const fields =
    adapter._metadata?.vector_fields?.fields ?? {};
  for (const [fieldId, field] of Object.entries(fields)) {
    adapter._vectorFieldKeysById.set(
      fieldId,
      { ...field.obsm_keys }
    );
  }
}

function coalescedRoundValue(kind, round) {
  const offset = round * 10;
  switch (kind) {
    case 'embedding':
      return {
        data: Float32Array.from([
          offset, 0,
          offset + 2, 2,
          offset + 1, 1,
        ]),
        nDims: 2,
      };
    case 'obs':
      return {
        dtype: 'float',
        values: [offset + 1, offset + 2, offset + 3],
      };
    case 'vector':
      return {
        data: Float32Array.from([
          offset + 2, offset + 4,
          offset + 6, offset + 8,
          offset + 10, offset + 12,
        ]),
        nDims: 2,
      };
    case 'connectivity':
      return denseConnectivity(round, round + 1);
    case 'gene':
      return Float32Array.from([
        offset + 1,
        offset + 2,
        offset + 3,
      ]);
    default:
      throw new Error(`Unknown coalesced path '${kind}'`);
  }
}

function createColdCoalescingScenario(kind) {
  const rounds = [deferred(), deferred()];
  let activeRound = 0;
  let payloadCalls = 0;
  let normalizationCalls = 0;

  const readTarget = () => {
    payloadCalls++;
    return rounds[activeRound].wait();
  };

  const loader = {
    nObs: 3,
    obsmKeys: ['X_umap_2d', 'velocity_umap_2d'],
    closeCalls: 0,
    close() {
      this.closeCalls++;
    },
    async getEmbedding(key) {
      if (kind === 'embedding' && key === 'X_umap_2d') {
        return readTarget();
      }
      if (kind === 'vector' && key === 'velocity_umap_2d') {
        return readTarget();
      }
      return BASE_EMBEDDING;
    },
    async getObsField(key) {
      assert.equal(key, 'score');
      return kind === 'obs' ? readTarget() : coalescedRoundValue('obs', 0);
    },
    async getConnectivities() {
      return kind === 'connectivity'
        ? readTarget()
        : coalescedRoundValue('connectivity', 0);
    },
    async getGeneExpression(geneName) {
      assert.equal(geneName, 'GeneA');
      return kind === 'gene'
        ? readTarget()
        : coalescedRoundValue('gene', 0);
    },
  };

  const adapter = new BaseAnnDataAdapter(loader);
  adapter._metadata = {
    embeddings: {
      obsm_keys: {
        '2d': 'X_umap_2d',
      },
    },
    vector_fields: {
      fields: {
        velocity_umap: {
          obsm_keys: {
            '2d': 'velocity_umap_2d',
          },
        },
      },
    },
  };
  installPrivateCoordinateResolution(adapter);
  adapter._obsFieldsMetadata = [{
    key: 'score',
    kind: 'continuous',
  }];
  if (kind === 'vector') {
    adapter._normInfo.set(2, {
      centers: [0, 0],
      maxRange: 4,
      scale: 0.5,
    });
  }

  const normalizeEmbedding =
    adapter._normalizeEmbedding.bind(adapter);
  adapter._normalizeEmbedding = (...args) => {
    normalizationCalls++;
    return normalizeEmbedding(...args);
  };

  const invoke = () => {
    switch (kind) {
      case 'embedding':
        return adapter.getEmbedding(2);
      case 'obs':
        return adapter.getObsFieldData('score');
      case 'vector':
        return adapter.getVectorField('velocity_umap', 2);
      case 'connectivity':
        return adapter.getConnectivityEdges();
      case 'gene':
        return adapter.getGeneExpression('GeneA');
      default:
        throw new Error(`Unknown coalesced path '${kind}'`);
    }
  };

  return {
    adapter,
    invoke,
    loader,
    normalizationCalls() {
      return normalizationCalls;
    },
    payloadCalls() {
      return payloadCalls;
    },
    reject(round, error) {
      rounds[round].reject(error);
    },
    release(round) {
      rounds[round].release(coalescedRoundValue(kind, round));
    },
    selectRound(round) {
      activeRound = round;
    },
    started(round) {
      return rounds[round].started;
    },
  };
}

function createScenario(kind, SourceClass = ZarrDataSource) {
  const pending = deferred();
  let targetedCalls = 0;

  const readTarget = () => {
    targetedCalls++;
    return targetedCalls === 1 ? pending.wait() : FRESH_RESULTS[kind];
  };

  const loader = {
    nObs: 3,
    obsmKeys: ['X_umap_2d', 'velocity_umap_2d'],
    clearCalls: 0,
    closeCalls: 0,
    clearCache() {
      this.clearCalls++;
    },
    close() {
      this.closeCalls++;
    },
    async getEmbedding(key) {
      if (kind === 'embedding' && key === 'X_umap_2d') {
        return readTarget();
      }
      if (kind === 'vector' && key === 'velocity_umap_2d') {
        return readTarget();
      }
      return BASE_EMBEDDING;
    },
    async getObsField(key) {
      assert.equal(key, 'score');
      return kind === 'obs' ? readTarget() : FRESH_RESULTS.obs;
    },
    async getConnectivities() {
      return kind === 'connectivity'
        ? readTarget()
        : FRESH_RESULTS.connectivity;
    },
  };

  const adapter = new BaseAnnDataAdapter(loader);
  adapter._metadata = {
    embeddings: {
      obsm_keys: {
        '2d': 'X_umap_2d',
      },
    },
    vector_fields: {
      fields: {
        velocity_umap: {
          obsm_keys: {
            '2d': 'velocity_umap_2d',
          },
        },
      },
    },
  };
  installPrivateCoordinateResolution(adapter);
  adapter._obsFieldsMetadata = [{
    key: 'score',
    kind: 'continuous',
  }];

  const source = new SourceClass();
  source._loader = loader;
  source._adapter = adapter;

  const invoke = () => {
    switch (kind) {
      case 'embedding':
        return source.getEmbedding(2);
      case 'vector':
        return source.getAdapter().getVectorField('velocity_umap', 2);
      case 'obs':
        return source.getObsFieldData('score');
      case 'connectivity':
        return source.getConnectivityEdges();
      default:
        throw new Error(`Unknown adapter lifecycle scenario '${kind}'`);
    }
  };

  return {
    adapter,
    invoke,
    pending,
    source,
    releaseOld() {
      pending.release(OLD_RESULTS[kind]);
    },
    targetedCalls() {
      return targetedCalls;
    },
  };
}

async function createWarmCacheScenario(kind) {
  const loaderOwnedVector = Float32Array.from([2, 4, 6, 8, 10, 12]);
  const loader = {
    nObs: 3,
    obsmKeys: ['X_umap_2d', 'velocity_umap_2d'],
    closeCalls: 0,
    close() {
      this.closeCalls++;
    },
    async getEmbedding(key) {
      if (key === 'velocity_umap_2d') {
        return {
          data: loaderOwnedVector,
          nDims: 2,
        };
      }
      return {
        data: Float32Array.from([-2, -2, 0, 0, 2, 2]),
        nDims: 2,
      };
    },
    async getConnectivities() {
      return denseConnectivity(0, 2);
    },
  };
  const adapter = new BaseAnnDataAdapter(loader);
  adapter._metadata = {
    embeddings: {
      obsm_keys: {
        '2d': 'X_umap_2d',
      },
    },
    vector_fields: {
      fields: {
        velocity_umap: {
          obsm_keys: {
            '2d': 'velocity_umap_2d',
          },
        },
      },
    },
  };
  installPrivateCoordinateResolution(adapter);

  const invoke = () => {
    switch (kind) {
      case 'embedding':
        return adapter.getEmbedding(2);
      case 'vector':
        return adapter.getVectorField('velocity_umap', 2);
      case 'connectivity':
        return adapter.getConnectivityEdges();
      default:
        throw new Error(`Unknown warm-cache scenario '${kind}'`);
    }
  };

  await invoke();
  assert.equal(cacheIsEmpty(adapter, kind), false);

  return {
    adapter,
    invoke,
    loader,
    loaderOwnedVector,
  };
}

test('H5adDataSource.clearCaches evicts the adapter vector-field cache', () => {
  const source = new H5adDataSource();
  const loader = {
    clearCache() {},
    close() {}
  };
  const adapter = new BaseAnnDataAdapter(loader);
  adapter._vectorFieldCache.set(
    'velocity_umap:2',
    Float32Array.from([1, 2])
  );
  source._loader = loader;
  source._adapter = adapter;

  source.clearCaches();
  assert.equal(adapter._vectorFieldCache.size, 0);
});

test('H5adDataSource.clearCaches invalidates delayed adapter reads', async () => {
  const scenario = createScenario('embedding', H5adDataSource);
  const staleRequest = scenario.invoke();
  const staleAssertion = assert.rejects(staleRequest, INVALIDATED_REQUEST);
  await scenario.pending.started;

  scenario.source.clearCaches();
  scenario.releaseOld();

  await staleAssertion;
  assert.equal(cacheIsEmpty(scenario.adapter, 'embedding'), true);
  await assertFreshResult('embedding', scenario.invoke());
  assert.equal(scenario.targetedCalls(), 2);
});

function cacheIsEmpty(adapter, kind) {
  switch (kind) {
    case 'embedding':
      return adapter._embeddingCache.size === 0 &&
        adapter._normInfo.size === 0;
    case 'vector':
      return adapter._vectorFieldCache.size === 0;
    case 'obs':
      return adapter._obsFieldDataCache.size === 0;
    case 'connectivity':
      return adapter._connectivityCache === undefined;
    default:
      return false;
  }
}

function valuesFromObsResult(result) {
  return Array.from(new Float32Array(result.data));
}

async function assertFreshResult(kind, result) {
  switch (kind) {
    case 'embedding':
      assert.deepEqual(Array.from(await result), [0, -1, 0, 1, 0, 0]);
      break;
    case 'vector':
      assert.deepEqual(
        Array.from(await result),
        Array.from(FRESH_RESULTS.vector.data)
      );
      break;
    case 'obs':
      assert.deepEqual(
        valuesFromObsResult(await result),
        Array.from(FRESH_RESULTS.obs.values)
      );
      break;
    case 'connectivity': {
      const edges = await result;
      assert.deepEqual(Array.from(edges.sources), [1]);
      assert.deepEqual(Array.from(edges.destinations), [2]);
      assert.equal(edges.nEdges, 1);
      break;
    }
  }
}

test('ZarrDataSource.clearCaches evicts a populated adapter vector-field cache', async () => {
  let vectorVersion = 1;
  let vectorReads = 0;
  const loader = {
    nObs: 3,
    obsmKeys: ['X_umap_2d', 'velocity_umap_2d'],
    clearCache() {},
    close() {},
    async getEmbedding(key) {
      if (key === 'X_umap_2d') return BASE_EMBEDDING;
      vectorReads++;
      return {
        data: Float32Array.from({ length: 6 }, (_, index) =>
          vectorVersion * 10 + index
        ),
        nDims: 2,
      };
    },
  };
  const adapter = new BaseAnnDataAdapter(loader);
  adapter._metadata = {
    embeddings: { obsm_keys: { '2d': 'X_umap_2d' } },
    vector_fields: {
      fields: {
        velocity_umap: {
          obsm_keys: { '2d': 'velocity_umap_2d' },
        },
      },
    },
  };
  installPrivateCoordinateResolution(adapter);
  const source = new ZarrDataSource();
  source._loader = loader;
  source._adapter = adapter;

  assert.deepEqual(
    Array.from(await source.getAdapter().getVectorField('velocity_umap', 2)),
    [10, 11, 12, 13, 14, 15]
  );
  assert.equal(vectorReads, 1);

  vectorVersion = 2;
  source.clearCaches();

  assert.equal(
    adapter._vectorFieldCache.size,
    0,
    'clearCaches must release vector-field buffers along with other adapter caches'
  );
  assert.deepEqual(
    Array.from(await source.getAdapter().getVectorField('velocity_umap', 2)),
    [20, 21, 22, 23, 24, 25]
  );
  assert.equal(vectorReads, 2);
});

for (const kind of ['embedding', 'vector', 'obs', 'connectivity']) {
  test(`ZarrDataSource.clearCaches invalidates a delayed adapter ${kind} read`, async () => {
    const scenario = createScenario(kind);
    const staleRequest = scenario.invoke();
    const staleAssertion = assert.rejects(staleRequest, INVALIDATED_REQUEST);
    await scenario.pending.started;

    scenario.source.clearCaches();
    const emptyImmediately = cacheIsEmpty(scenario.adapter, kind);
    scenario.releaseOld();

    await staleAssertion;
    assert.equal(
      emptyImmediately,
      true,
      `${kind} cache must be empty immediately after clearCaches`
    );
    assert.equal(
      cacheIsEmpty(scenario.adapter, kind),
      true,
      `the delayed ${kind} read must not repopulate its invalidated cache`
    );
    await assertFreshResult(kind, scenario.invoke());
    assert.equal(scenario.targetedCalls(), 2);
  });
}

for (const kind of ['embedding', 'vector', 'obs', 'connectivity']) {
  test(`ZarrDataSource.clear invalidates a delayed adapter ${kind} read`, async () => {
    const scenario = createScenario(kind);
    const staleRequest = scenario.invoke();
    const staleAssertion = assert.rejects(staleRequest, INVALIDATED_REQUEST);
    await scenario.pending.started;

    scenario.source.clear();
    const emptyImmediately = cacheIsEmpty(scenario.adapter, kind);
    scenario.releaseOld();

    await staleAssertion;
    assert.equal(
      emptyImmediately,
      true,
      `${kind} cache must be empty immediately after close`
    );
    assert.equal(
      cacheIsEmpty(scenario.adapter, kind),
      true,
      `the delayed ${kind} read must not repopulate its closed adapter cache`
    );
  });
}

for (const lifecycleAction of ['clearCaches', 'close']) {
  for (const kind of ['embedding', 'vector', 'connectivity']) {
    test(`${lifecycleAction} invalidates an immediately pending warm-cache ${kind} read`, async () => {
      const scenario = await createWarmCacheScenario(kind);
      const pendingRead = scenario.invoke();

      scenario.adapter[lifecycleAction]();

      await assert.rejects(pendingRead, INVALIDATED_REQUEST);
      assert.equal(
        cacheIsEmpty(scenario.adapter, kind),
        true,
        `${kind} cache must remain empty after ${lifecycleAction}`
      );
    });
  }
}

test('getVectorField does not mutate or repeatedly scale a loader-owned Float32Array', async () => {
  const scenario = await createWarmCacheScenario('embedding');
  const rawBefore = Array.from(scenario.loaderOwnedVector);

  const first = await scenario.adapter.getVectorField('velocity_umap', 2);
  scenario.adapter.clearCaches();
  const second = await scenario.adapter.getVectorField('velocity_umap', 2);

  assert.deepEqual(Array.from(first), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(second), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(scenario.loaderOwnedVector), rawBefore);
  assert.notStrictEqual(first, scenario.loaderOwnedVector);
  assert.notStrictEqual(second, scenario.loaderOwnedVector);
});

for (const kind of COALESCED_PATHS) {
  test(`same-key cold ${kind} callers share one adapter computation`, async () => {
    const scenario = createColdCoalescingScenario(kind);
    const firstRequest = scenario.invoke();
    const secondRequest = scenario.invoke();
    await scenario.started(0);

    scenario.release(0);
    const [first, second] = await Promise.all([
      firstRequest,
      secondRequest,
    ]);

    assert.equal(
      scenario.payloadCalls(),
      1,
      `${kind} must issue exactly one loader payload request`
    );
    assert.strictEqual(
      first,
      second,
      `${kind} callers must share the settled adapter result`
    );
    if (kind === 'embedding') {
      assert.equal(
        scenario.normalizationCalls(),
        1,
        'embedding normalization must run exactly once'
      );
    }
  });
}

for (const kind of COALESCED_PATHS) {
  test(`clearCaches rejects both coalesced ${kind} callers without stale cleanup`, async () => {
    const scenario = createColdCoalescingScenario(kind);
    const staleFirst = scenario.invoke();
    const staleSecond = scenario.invoke();
    const staleAssertions = [
      assert.rejects(staleFirst, INVALIDATED_REQUEST),
      assert.rejects(staleSecond, INVALIDATED_REQUEST),
    ];
    await scenario.started(0);

    scenario.adapter.clearCaches();
    scenario.selectRound(1);
    const freshFirst = scenario.invoke();
    const freshSecond = scenario.invoke();
    await scenario.started(1);

    scenario.release(0);
    await Promise.all(staleAssertions);

    // The stale promise's cleanup must not delete the newer in-flight entry.
    const freshThird = scenario.invoke();
    scenario.release(1);
    const [first, second, third] = await Promise.all([
      freshFirst,
      freshSecond,
      freshThird,
    ]);

    assert.equal(
      scenario.payloadCalls(),
      2,
      `${kind} must have one stale and one fresh loader request`
    );
    assert.strictEqual(first, second);
    assert.strictEqual(first, third);
  });
}

for (const kind of COALESCED_PATHS) {
  test(`close rejects both coalesced ${kind} callers`, async () => {
    const scenario = createColdCoalescingScenario(kind);
    const firstRequest = scenario.invoke();
    const secondRequest = scenario.invoke();
    const assertions = [
      assert.rejects(firstRequest, INVALIDATED_REQUEST),
      assert.rejects(secondRequest, INVALIDATED_REQUEST),
    ];
    await scenario.started(0);

    scenario.adapter.close();
    scenario.release(0);
    await Promise.all(assertions);

    assert.equal(
      scenario.payloadCalls(),
      1,
      `${kind} must issue one loader request before close`
    );
    assert.equal(scenario.loader.closeCalls, 1);
  });
}

for (const kind of COALESCED_PATHS) {
  test(`rejected coalesced ${kind} work leaves later callers independent`, async () => {
    const scenario = createColdCoalescingScenario(kind);
    const firstRequest = scenario.invoke();
    const secondRequest = scenario.invoke();
    const assertions = [
      assert.rejects(firstRequest, /synthetic adapter failure/i),
      assert.rejects(secondRequest, /synthetic adapter failure/i),
    ];
    await scenario.started(0);

    scenario.reject(0, new Error('synthetic adapter failure'));
    await Promise.all(assertions);

    scenario.selectRound(1);
    const laterFirst = scenario.invoke();
    const laterSecond = scenario.invoke();
    await scenario.started(1);
    scenario.release(1);
    const [first, second] = await Promise.all([
      laterFirst,
      laterSecond,
    ]);

    assert.equal(
      scenario.payloadCalls(),
      2,
      `${kind} must run once for the two later callers`
    );
    assert.strictEqual(first, second);
  });
}

function createCoordinateCacheBudgetScenario(maxMaterializedBytes) {
  const payloads = {
    X_umap_2d: Float32Array.from(
      { length: 10 },
      (_, index) => index
    ),
    velocity_a_2d: Float32Array.from(
      { length: 10 },
      (_, index) => index + 10
    ),
    velocity_b_2d: Float32Array.from(
      { length: 10 },
      (_, index) => index + 20
    ),
  };
  const reads = new Map();
  const loader = {
    nObs: 5,
    obsmKeys: Object.keys(payloads),
    closeCalls: 0,
    close() {
      this.closeCalls++;
    },
    async getEmbedding(key) {
      reads.set(key, (reads.get(key) || 0) + 1);
      return {
        data: payloads[key],
        nDims: 2,
      };
    },
  };
  const adapter = new BaseAnnDataAdapter(loader, {
    maxMaterializedBytes,
  });
  adapter._metadata = {
    embeddings: {
      obsm_keys: {
        '2d': 'X_umap_2d',
      },
    },
    vector_fields: {
      fields: {
        velocity_a: {
          obsm_keys: { '2d': 'velocity_a_2d' },
        },
        velocity_b: {
          obsm_keys: { '2d': 'velocity_b_2d' },
        },
      },
    },
  };
  installPrivateCoordinateResolution(adapter);
  return { adapter, loader, payloads, reads };
}

function hasVectorCache(adapter, fieldId, dim = 2) {
  return adapter._vectorFieldCache.get(fieldId)?.has(dim) === true;
}

test('embedding and vector caches share one cumulative retained-byte owner', async () => {
  const { adapter } = createCoordinateCacheBudgetScenario(80);

  await adapter.getEmbedding(2);
  assert.equal(adapter._coordinateCacheBytes, 40n);
  assert.equal(adapter._embeddingCache.has(2), true);

  await adapter.getVectorField('velocity_a', 2);
  assert.equal(adapter._coordinateCacheBytes, 40n);
  assert.equal(
    adapter._embeddingCache.has(2),
    false,
    'the stale embedding must be evicted before retaining the first vector'
  );
  assert.equal(hasVectorCache(adapter, 'velocity_a'), true);

  await adapter.getVectorField('velocity_b', 2);
  assert.equal(adapter._coordinateCacheBytes, 40n);
  assert.equal(
    hasVectorCache(adapter, 'velocity_a'),
    false,
    'the first vector must be evicted before retaining the second vector'
  );
  assert.equal(hasVectorCache(adapter, 'velocity_b'), true);
});

test('coordinate cache hits refresh one cross-kind LRU order', async () => {
  const { adapter } = createCoordinateCacheBudgetScenario(120);

  await adapter.getEmbedding(2);
  await adapter.getVectorField('velocity_a', 2);
  await adapter.getEmbedding(2);
  await adapter.getVectorField('velocity_b', 2);

  assert.equal(adapter._coordinateCacheBytes, 80n);
  assert.equal(adapter._embeddingCache.has(2), true);
  assert.equal(
    hasVectorCache(adapter, 'velocity_a'),
    false,
    'the untouched vector must be the shared LRU victim'
  );
  assert.equal(hasVectorCache(adapter, 'velocity_b'), true);
});

test('coordinate LRU preserves a pinned result and serves a later caller after release', async () => {
  const { adapter, reads } = createCoordinateCacheBudgetScenario(80);
  await adapter.getEmbedding(2);
  const embeddingKey = adapter._embeddingCoordinateCacheKey(2);
  const releaseEmbedding = adapter._pinCoordinateCacheKey(embeddingKey);

  try {
    await assert.rejects(
      adapter.getVectorField('velocity_a', 2),
      /vector field.*retained cache.*current coordinate results.*Cellucid server/i
    );
  } finally {
    releaseEmbedding();
  }
  assert.equal(adapter._embeddingCache.has(2), true);
  assert.equal(hasVectorCache(adapter, 'velocity_a'), false);
  assert.equal(adapter._coordinateCacheBytes, 40n);

  await adapter.getVectorField('velocity_a', 2);
  assert.equal(
    reads.get('velocity_a_2d'),
    2,
    'the rejected shared operation must not own a later invocation'
  );
  assert.equal(adapter._embeddingCache.has(2), false);
  assert.equal(hasVectorCache(adapter, 'velocity_a'), true);
  assert.equal(adapter._coordinateCacheBytes, 40n);
});

test('oversize coordinate results reject before normalization or vector copying', async () => {
  const embeddingScenario = createCoordinateCacheBudgetScenario(39);
  let normalizationCalls = 0;
  const normalize =
    embeddingScenario.adapter._normalizeEmbedding.bind(
      embeddingScenario.adapter
    );
  embeddingScenario.adapter._normalizeEmbedding = (...args) => {
    normalizationCalls++;
    return normalize(...args);
  };

  await assert.rejects(
    embeddingScenario.adapter.getEmbedding(2),
    /embedding.*retained cache.*39-byte browser limit.*Cellucid server/i
  );
  assert.equal(normalizationCalls, 0);
  assert.equal(embeddingScenario.adapter._embeddingCache.size, 0);
  assert.equal(embeddingScenario.adapter._coordinateCacheBytes, 0n);

  let vectorCopyTouched = false;
  const vectorRaw = new Proxy(
    Float32Array.from({ length: 10 }, (_, index) => index),
    {
      get(target, property) {
        if (property === Symbol.iterator) {
          vectorCopyTouched = true;
          throw new Error('vector copy touched before retained-cache preflight');
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }
  );
  const vectorLoader = {
    nObs: 5,
    obsmKeys: ['velocity_a_2d'],
    close() {},
    async getEmbedding() {
      return { data: vectorRaw, nDims: 2 };
    },
  };
  const vectorAdapter = new BaseAnnDataAdapter(vectorLoader, {
    maxMaterializedBytes: 39,
  });
  vectorAdapter._metadata = {
    vector_fields: {
      fields: {
        velocity_a: {
          obsm_keys: { '2d': 'velocity_a_2d' },
        },
      },
    },
  };
  installPrivateCoordinateResolution(vectorAdapter);
  vectorAdapter._normInfo.set(2, { scale: 1 });

  await assert.rejects(
    vectorAdapter.getVectorField('velocity_a', 2),
    /vector field.*retained cache.*39-byte browser limit.*Cellucid server/i
  );
  assert.equal(vectorCopyTouched, false);
  assert.equal(vectorAdapter._coordinateCacheBytes, 0n);
});

test('raw plus normalized coordinate peak rejects before normalization allocation and cleans in-flight state', async () => {
  const scenario = createCoordinateCacheBudgetScenario(64);
  let normalizationCalls = 0;
  const normalize =
    scenario.adapter._normalizeEmbedding.bind(scenario.adapter);
  scenario.adapter._normalizeEmbedding = (...args) => {
    normalizationCalls++;
    return normalize(...args);
  };
  const released = [];
  scenario.loader.releaseEmbedding = (key, expected) => {
    released.push([key, expected]);
  };

  await assert.rejects(
    scenario.adapter.getEmbedding(2),
    /embedding.*64-byte browser limit.*current coordinate results.*Cellucid server/i
  );
  assert.equal(normalizationCalls, 0);
  assert.equal(scenario.adapter._coordinateCacheBytes, 0n);
  assert.equal(scenario.adapter._coordinateReservedOutputBytes, 0n);
  assert.equal(scenario.adapter._coordinateBufferRefs.size, 0);
  assert.equal(scenario.adapter._embeddingCache.size, 0);
  assert.equal(released.length, 1);

  scenario.adapter._maxMaterializedBytes = 80n;
  const result = await scenario.adapter.getEmbedding(2);
  assert.equal(result.length, 10);
  assert.equal(normalizationCalls, 1);
  assert.equal(scenario.reads.get('X_umap_2d'), 2);
  assert.equal(released.length, 2);
});

test('initialize rejects non-finite embedding components before normalization and releases the raw result', async () => {
  const raw = {
    data: Float32Array.from([0, Number.NaN, 1, 1]),
    nDims: 2
  };
  let normalizationCalls = 0;
  const releases = [];
  const loader = {
    nObs: 2,
    nVars: 0,
    obsKeys: [],
    varNames: [],
    obsmKeys: ['X_umap_2d'],
    async getDatasetMetadata() {
      return {
        stats: {
          n_cells: 2,
          n_genes: 0,
          n_categorical_fields: 0,
          n_continuous_fields: 0
        },
        embeddings: {
          available_dimensions: [2],
          default_dimension: 2,
          obsm_keys: { '2d': 'X_umap_2d' }
        }
      };
    },
    async getEmbedding() {
      return raw;
    },
    releaseEmbedding(key, expected) {
      releases.push([key, expected]);
    },
    close() {}
  };
  const adapter = new BaseAnnDataAdapter(loader);
  adapter._normalizeEmbedding = () => {
    normalizationCalls++;
    throw new Error('normalization must not see non-finite coordinates');
  };

  await assert.rejects(
    adapter.initialize(),
    /embedding.*X_umap_2d.*non-finite.*component/i
  );
  assert.equal(normalizationCalls, 0);
  assert.deepEqual(releases, [['X_umap_2d', raw]]);
  assert.equal(adapter._embeddingCache.size, 0);
  assert.equal(adapter._coordinateCacheBytes, 0n);
});

test('public coordinate reads reject every non-finite component before copy or cache and leave later callers independent', async t => {
  for (const [name, nonFinite] of [
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY]
  ]) {
    await t.test(name, async () => {
      let embeddingAttempt = 0;
      let vectorAttempt = 0;
      const embeddingReleases = [];
      const vectorReleases = [];
      const badEmbedding = {
        data: Float32Array.from([0, nonFinite, 1, 1]),
        nDims: 2
      };
      const goodEmbedding = {
        data: Float32Array.from([0, 0, 1, 1]),
        nDims: 2
      };
      const badVector = {
        data: Float32Array.from([1, nonFinite, 2, 2]),
        nDims: 2
      };
      const goodVector = {
        data: Float32Array.from([1, 1, 2, 2]),
        nDims: 2
      };
      const loader = {
        nObs: 2,
        obsmKeys: ['X_umap_2d', 'velocity_umap_2d'],
        async getEmbedding(key) {
          if (key === 'X_umap_2d') {
            embeddingAttempt++;
            return embeddingAttempt === 1
              ? badEmbedding
              : goodEmbedding;
          }
          vectorAttempt++;
          return vectorAttempt === 1 ? badVector : goodVector;
        },
        releaseEmbedding(key, expected) {
          if (key === 'X_umap_2d') {
            embeddingReleases.push(expected);
          } else {
            vectorReleases.push(expected);
          }
        },
        close() {}
      };
      const adapter = new BaseAnnDataAdapter(loader);
      adapter._metadata = {
        embeddings: {
          obsm_keys: { '2d': 'X_umap_2d' }
        },
        vector_fields: {
          fields: {
            velocity_umap: {
              obsm_keys: { '2d': 'velocity_umap_2d' }
            }
          }
        }
      };
      installPrivateCoordinateResolution(adapter);

      await assert.rejects(
        adapter.getEmbedding(2),
        /embedding.*X_umap_2d.*non-finite.*component/i
      );
      assert.equal(adapter._embeddingCache.size, 0);
      assert.equal(adapter._normInfo.size, 0);
      assert.deepEqual(embeddingReleases, [badEmbedding]);

      const embedding = await adapter.getEmbedding(2);
      assert.deepEqual(Array.from(embedding), [-1, -1, 1, 1]);
      assert.deepEqual(
        embeddingReleases,
        [badEmbedding, goodEmbedding]
      );

      await assert.rejects(
        adapter.getVectorField('velocity_umap', 2),
        /vector field.*velocity_umap_2d.*non-finite.*component/i
      );
      assert.equal(hasVectorCache(adapter, 'velocity_umap'), false);
      assert.deepEqual(vectorReleases, [badVector]);

      const vector =
        await adapter.getVectorField('velocity_umap', 2);
      assert.deepEqual(Array.from(vector), [2, 2, 4, 4]);
      assert.deepEqual(vectorReleases, [badVector, goodVector]);
    });
  }
});

test('adapter releases only consumed raw coordinate entries while retaining normalized results', async () => {
  const rawCache = new Map();
  const unrelated = { marker: 'keep' };
  rawCache.set('unrelated', unrelated);
  const releases = [];
  const loader = {
    nObs: 2,
    obsmKeys: ['X_umap_2d', 'velocity_umap_2d'],
    async getEmbedding(key) {
      const result = {
        data: key === 'X_umap_2d'
          ? Float32Array.from([0, 0, 2, 2])
          : Float32Array.from([1, 2, 3, 4]),
        nDims: 2
      };
      rawCache.set(`obsm:${key}`, result);
      return result;
    },
    releaseEmbedding(key, expected) {
      const cacheKey = `obsm:${key}`;
      releases.push([key, expected]);
      if (rawCache.get(cacheKey) === expected) {
        rawCache.delete(cacheKey);
      }
    },
    close() {}
  };
  const adapter = new BaseAnnDataAdapter(loader);
  adapter._metadata = {
    embeddings: {
      obsm_keys: { '2d': 'X_umap_2d' }
    },
    vector_fields: {
      fields: {
        velocity_umap: {
          obsm_keys: { '2d': 'velocity_umap_2d' }
        }
      }
    }
  };
  installPrivateCoordinateResolution(adapter);

  const embedding = await adapter.getEmbedding(2);
  const vector =
    await adapter.getVectorField('velocity_umap', 2);

  assert.deepEqual(Array.from(embedding), [-1, -1, 1, 1]);
  assert.deepEqual(Array.from(vector), [1, 2, 3, 4]);
  assert.strictEqual(await adapter.getEmbedding(2), embedding);
  assert.strictEqual(
    await adapter.getVectorField('velocity_umap', 2),
    vector
  );
  assert.equal(rawCache.has('obsm:X_umap_2d'), false);
  assert.equal(rawCache.has('obsm:velocity_umap_2d'), false);
  assert.strictEqual(rawCache.get('unrelated'), unrelated);
  assert.deepEqual(
    releases.map(([key]) => key),
    ['X_umap_2d', 'velocity_umap_2d']
  );
});

test('coalesced coordinate callers retain and charge one shared result', async () => {
  const scenario = createColdCoalescingScenario('vector');
  scenario.adapter._maxMaterializedBytes = 64n;
  const firstRequest = scenario.invoke();
  const secondRequest = scenario.invoke();
  await scenario.started(0);
  scenario.release(0);

  const [first, second] = await Promise.all([
    firstRequest,
    secondRequest,
  ]);
  assert.strictEqual(first, second);
  assert.equal(scenario.payloadCalls(), 1);
  assert.equal(scenario.adapter._coordinateCacheBytes, 24n);
  assert.equal(scenario.adapter._coordinateCacheLru.size, 1);
});

test('coordinate cache accounting counts aliased backing buffers once', async () => {
  const sharedBuffer = new ArrayBuffer(40);
  const loader = {
    nObs: 10,
    obsmKeys: ['X_one', 'X_two'],
    close() {},
    async getEmbedding(key) {
      return {
        data: new Float32Array(10),
        nDims: key === 'X_one' ? 1 : 2,
      };
    },
  };
  const adapter = new BaseAnnDataAdapter(loader, {
    maxMaterializedBytes: 120,
  });
  adapter._metadata = {
    embeddings: {
      obsm_keys: {
        '1d': 'X_one',
        '2d': 'X_two',
      },
    },
  };
  installPrivateCoordinateResolution(adapter);
  adapter._normalizeEmbedding = () => new Float32Array(sharedBuffer);

  await adapter.getEmbedding(1);
  await adapter.getEmbedding(2);
  assert.equal(adapter._embeddingCache.size, 2);
  assert.equal(adapter._coordinateCacheBytes, 40n);
  assert.equal(adapter._coordinateBufferRefs.size, 1);
});

test('raw coordinate reservations count a retained backing-buffer alias once', async () => {
  const sharedBuffer = new ArrayBuffer(40);
  const loader = {
    nObs: 10,
    obsmKeys: ['X_one', 'X_two'],
    close() {},
    async getEmbedding(key) {
      return {
        data: key === 'X_one'
          ? new Float32Array(10)
          : new Float32Array(sharedBuffer),
        nDims: key === 'X_one' ? 1 : 2
      };
    }
  };
  const adapter = new BaseAnnDataAdapter(loader, {
    maxMaterializedBytes: 80
  });
  adapter._metadata = {
    embeddings: {
      obsm_keys: {
        '1d': 'X_one',
        '2d': 'X_two'
      }
    }
  };
  installPrivateCoordinateResolution(adapter);
  adapter._normalizeEmbedding = (_data, _srcDim, targetDim) =>
    targetDim === 1
      ? new Float32Array(sharedBuffer)
      : new Float32Array(10);

  await adapter.getEmbedding(1);
  await adapter.getEmbedding(2);

  assert.equal(adapter._embeddingCache.size, 2);
  assert.equal(adapter._coordinateCacheBytes, 80n);
  assert.equal(adapter._coordinateBufferRefs.size, 2);
});

test('clear and close reset coordinate cache ownership for later callers', async () => {
  const { adapter, loader, reads } =
    createCoordinateCacheBudgetScenario(120);
  await adapter.getEmbedding(2);
  await adapter.getVectorField('velocity_a', 2);
  assert.equal(adapter._coordinateCacheBytes, 80n);

  adapter.clearCaches();
  assert.equal(adapter._coordinateCacheBytes, 0n);
  assert.equal(adapter._coordinateCacheLru.size, 0);
  assert.equal(adapter._coordinateBufferRefs.size, 0);
  assert.equal(adapter._embeddingCache.size, 0);
  assert.equal(adapter._vectorFieldCache.size, 0);

  await adapter.getEmbedding(2);
  assert.equal(adapter._coordinateCacheBytes, 40n);
  assert.equal(reads.get('X_umap_2d'), 2);

  adapter.close();
  assert.equal(adapter._coordinateCacheBytes, 0n);
  assert.equal(adapter._coordinateCacheLru.size, 0);
  assert.equal(adapter._coordinateBufferRefs.size, 0);
  assert.equal(loader.closeCalls, 1);
});

test('coordinate requests require the exact current metadata key', async t => {
  await t.test('embedding metadata cannot be inferred from obsm names', async () => {
    let payloadReads = 0;
    const loader = {
      nObs: 2,
      obsmKeys: ['X_umap'],
      close() {},
      getEmbeddingShape() {
        return { nDims: 2, shape: [2, 2] };
      },
      async getEmbedding() {
        payloadReads++;
        return {
          data: Float32Array.from([0, 0, 1, 1]),
          nDims: 2,
        };
      },
    };
    const adapter = new BaseAnnDataAdapter(loader);
    adapter._metadata = {
      embeddings: {
        obsm_keys: {},
      },
    };

    await assert.rejects(
      adapter.getEmbedding(2),
      /metadata.*2D.*embedding key|2D.*metadata.*embedding key/i
    );
    assert.equal(payloadReads, 0);
  });

  await t.test('vector metadata cannot be inferred from obsm names', async () => {
    let payloadReads = 0;
    const loader = {
      nObs: 2,
      obsmKeys: ['velocity_umap'],
      close() {},
      getEmbeddingShape() {
        return { nDims: 2, shape: [2, 2] };
      },
      async getEmbedding() {
        payloadReads++;
        return {
          data: Float32Array.from([1, 2, 3, 4]),
          nDims: 2,
        };
      },
    };
    const adapter = new BaseAnnDataAdapter(loader);
    adapter._metadata = {
      vector_fields: {
        fields: {
          velocity_umap: {
            obsm_keys: {},
          },
        },
      },
    };
    adapter._normInfo.set(2, { scale: 1 });

    await assert.rejects(
      adapter.getVectorField('velocity_umap', 2),
      /metadata.*2D.*vector field key|2D.*metadata.*vector field key/i
    );
    assert.equal(payloadReads, 0);
  });

  await t.test('vector dimensions cannot be clamped into a valid request', async () => {
    let payloadReads = 0;
    const loader = {
      nObs: 2,
      obsmKeys: ['velocity_umap_3d'],
      close() {},
      async getEmbedding() {
        payloadReads++;
        return {
          data: Float32Array.from([1, 2, 3, 4, 5, 6]),
          nDims: 3,
        };
      },
    };
    const adapter = new BaseAnnDataAdapter(loader);
    adapter._metadata = {
      vector_fields: {
        fields: {
          velocity_umap: {
            obsm_keys: {
              '3d': 'velocity_umap_3d',
            },
          },
        },
      },
    };
    adapter._normInfo.set(3, { scale: 1 });

    await assert.rejects(
      adapter.getVectorField('velocity_umap', 4),
      /dimension.*1, 2, or 3|dimension.*between 1 and 3/i
    );
    assert.equal(payloadReads, 0);
  });
});
