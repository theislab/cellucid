import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import {
  MappingLoadError,
  assembleAnnDataCandidates,
  describeAnnDataProbes,
  resolveVectorBinding,
} from '../assets/js/data/data-mapping-candidates.js';
import { canonicalEmbeddingId } from '../assets/js/data/data-mapping.js';
import { mappingProbes, selectColumns } from './helpers/anndata-mapping-mocks.mjs';
import { H5adDataSource } from '../assets/js/data/h5ad.js';
import { ZarrDataSource } from '../assets/js/data/zarr.js';
import { connectivityEdgesOf } from '../assets/js/data/sparse-utils.js';

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

/**
 * Install what `initialize()` and `finalizeDirectIdentity()` resolve, without
 * running them: the described `obsm` entries, the candidate catalog and the
 * identity embeddings (in item order). Vector payloads are read by their
 * mapping route against that catalog, so they need nothing more.
 *
 * @param {BaseAnnDataAdapter} adapter
 * @param {{
 *   obsm: Record<string, number>,
 *   embeddings: Array<{key: string, columns: number[]}>,
 *   nVars?: number
 * }} resolution - `obsm` lists entries in catalog order; a positive `nVars`
 *   adds a dense X of that many genes.
 */
function installPrivateCoordinateResolution(adapter, { obsm, embeddings, nVars = 0 }) {
  const described = describeAnnDataProbes(
    mappingProbes({ nObs: adapter._loader.nObs, obsm, nVars, hasX: nVars > 0 })
  );
  const slots = { '1d': null, '2d': null, '3d': null };
  for (const ref of embeddings) slots[`${ref.columns.length}d`] = ref;
  adapter._describedObsm = described.obsm;
  adapter._slots = Object.freeze(slots);
  adapter._candidates = assembleAnnDataCandidates(described, { slots, guessed: [] });
  adapter._identityEmbeddings = embeddings.map(ref => ({
    id: canonicalEmbeddingId(ref.key, ref.columns, { width: obsm[ref.key] }),
    dimension: ref.columns.length,
    ref,
  }));
}

/** The resolution of the 3-cell fixtures: a 2D UMAP and its velocity. */
const UMAP_WITH_VELOCITY = Object.freeze({
  obsm: { X_umap_2d: 2, velocity_umap_2d: 2 },
  embeddings: [{ key: 'X_umap_2d', columns: [0, 1] }],
});

const UMAP_REF = Object.freeze({ key: 'X_umap_2d', columns: [0, 1] });

/**
 * The mapping route of `obsm[key]` bound to `embedding`, as
 * `resolveVectorBinding()` names it against the adapter's catalog.
 */
function vectorRoute(adapter, key, embedding = UMAP_REF) {
  const resolved = resolveVectorBinding(adapter._candidates, { key, embedding });
  assert.equal(resolved.ok, true, resolved.reason);
  return resolved.path;
}

/** Read `obsm[key]` as the vectors of `embedding`, through its mapping route. */
function readVector(adapter, key, embedding = UMAP_REF) {
  return adapter.getVectorPayload(vectorRoute(adapter, key, embedding), embedding.columns.length);
}

/** `velocity_umap_2d` (obsm 1) over `X_umap_2d` (obsm 0) columns [0, 1]. */
const VELOCITY_ROUTE = '_cellucid/mapping/vectors/1/0-1/0/0-1.bin';

/** A `{data, nDims}` loader result read at `columns`, as `readObsmColumns` returns it. */
function columnsOf(result, columns) {
  return selectColumns(result.data, result.nDims, columns);
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
    closeCalls: 0,
    close() {
      this.closeCalls++;
    },
    async readObsmColumns(key, columns) {
      if (kind === 'embedding' && key === 'X_umap_2d') {
        return columnsOf(await readTarget(), columns);
      }
      if (kind === 'vector' && key === 'velocity_umap_2d') {
        return columnsOf(await readTarget(), columns);
      }
      return columnsOf(BASE_EMBEDDING, columns);
    },
    async getObsField(key) {
      assert.equal(key, 'score');
      return kind === 'obs' ? readTarget() : coalescedRoundValue('obs', 0);
    },
    async getConnectivityEdges() {
      return connectivityEdgesOf(await this.readConnectivityMatrix(), this.nObs);
    },
    async readConnectivityMatrix() {
      return kind === 'connectivity'
        ? readTarget()
        : coalescedRoundValue('connectivity', 0);
    },
    async readVarNames(axis, column) {
      assert.equal(axis, 'X');
      assert.equal(column, null);
      return { index: ['GeneA'], values: ['GeneA'] };
    },
    async getMatrixColumn(element, index) {
      assert.equal(element, 'X');
      assert.equal(index, 0);
      return kind === 'gene'
        ? readTarget()
        : coalescedRoundValue('gene', 0);
    },
  };

  const adapter = new BaseAnnDataAdapter(loader);
  installPrivateCoordinateResolution(adapter, { ...UMAP_WITH_VELOCITY, nVars: 1 });
  adapter._obsFieldsMetadata = [{
    key: 'score',
    kind: 'continuous',
  }];
  if (kind === 'vector') {
    adapter._normInfo.set('X_umap_2d', {
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
        return adapter.getEmbeddingForRef(UMAP_REF);
      case 'obs':
        return adapter.getObsFieldData('score');
      case 'vector':
        return readVector(adapter, 'velocity_umap_2d');
      case 'connectivity':
        return adapter.getConnectivityEdges();
      case 'gene':
        return adapter.getGeneValues('var/0.values.f32');
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
    clearCalls: 0,
    closeCalls: 0,
    clearCache() {
      this.clearCalls++;
    },
    close() {
      this.closeCalls++;
    },
    async readObsmColumns(key, columns) {
      if (kind === 'embedding' && key === 'X_umap_2d') {
        return columnsOf(await readTarget(), columns);
      }
      if (kind === 'vector' && key === 'velocity_umap_2d') {
        return columnsOf(await readTarget(), columns);
      }
      return columnsOf(BASE_EMBEDDING, columns);
    },
    async getObsField(key) {
      assert.equal(key, 'score');
      return kind === 'obs' ? readTarget() : FRESH_RESULTS.obs;
    },
    async getConnectivityEdges() {
      return connectivityEdgesOf(await this.readConnectivityMatrix(), this.nObs);
    },
    async readConnectivityMatrix() {
      return kind === 'connectivity'
        ? readTarget()
        : FRESH_RESULTS.connectivity;
    },
  };

  const adapter = new BaseAnnDataAdapter(loader);
  installPrivateCoordinateResolution(adapter, UMAP_WITH_VELOCITY);
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
        return source.getAdapter().getEmbeddingPayload('embeddings/0_2d.bin', 2);
      case 'vector':
        return readVector(source.getAdapter(), 'velocity_umap_2d');
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
    closeCalls: 0,
    close() {
      this.closeCalls++;
    },
    async readObsmColumns(key, columns) {
      if (key === 'velocity_umap_2d') {
        return columnsOf({ data: loaderOwnedVector, nDims: 2 }, columns);
      }
      return columnsOf({ data: Float32Array.from([-2, -2, 0, 0, 2, 2]), nDims: 2 }, columns);
    },
    async getConnectivityEdges() {
      return connectivityEdgesOf(await this.readConnectivityMatrix(), this.nObs);
    },
    async readConnectivityMatrix() {
      return denseConnectivity(0, 2);
    },
  };
  const adapter = new BaseAnnDataAdapter(loader);
  installPrivateCoordinateResolution(adapter, UMAP_WITH_VELOCITY);

  const invoke = () => {
    switch (kind) {
      case 'embedding':
        return adapter.getEmbeddingForRef(UMAP_REF);
      case 'vector':
        return readVector(adapter, 'velocity_umap_2d');
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
    VELOCITY_ROUTE,
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
      return adapter._connectivityCache.size === 0;
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
    clearCache() {},
    close() {},
    async readObsmColumns(key, columns) {
      if (key === 'X_umap_2d') return columnsOf(BASE_EMBEDDING, columns);
      vectorReads++;
      return columnsOf({
        data: Float32Array.from({ length: 6 }, (_, index) =>
          vectorVersion * 10 + index
        ),
        nDims: 2,
      }, columns);
    },
  };
  const adapter = new BaseAnnDataAdapter(loader);
  installPrivateCoordinateResolution(adapter, UMAP_WITH_VELOCITY);
  const source = new ZarrDataSource();
  source._loader = loader;
  source._adapter = adapter;

  assert.deepEqual(
    Array.from(await readVector(source.getAdapter(), 'velocity_umap_2d')),
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
    Array.from(await readVector(source.getAdapter(), 'velocity_umap_2d')),
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

test('getVectorPayload does not mutate or repeatedly scale a loader-owned Float32Array', async () => {
  const scenario = await createWarmCacheScenario('embedding');
  const rawBefore = Array.from(scenario.loaderOwnedVector);

  const first = await readVector(scenario.adapter, 'velocity_umap_2d');
  scenario.adapter.clearCaches();
  const second = await readVector(scenario.adapter, 'velocity_umap_2d');

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

// Budgets below count what the adapter holds at once: a loader read is one
// transient Float64 value per coordinate (8 bytes), a retained result one
// Float32 value (4 bytes). Five 2D cells read as 80 bytes and retain 40.
function createCoordinateCacheBudgetScenario(cacheBudgetBytes) {
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
    closeCalls: 0,
    close() {
      this.closeCalls++;
    },
    async readObsmColumns(key, columns) {
      reads.set(key, (reads.get(key) || 0) + 1);
      return selectColumns(payloads[key], 2, columns);
    },
  };
  const adapter = new BaseAnnDataAdapter(loader, {
    cacheBudgetBytes,
  });
  installPrivateCoordinateResolution(adapter, {
    obsm: { X_umap_2d: 2, velocity_a_2d: 2, velocity_b_2d: 2 },
    embeddings: [UMAP_REF],
  });
  return { adapter, loader, payloads, reads };
}

function hasVectorCache(adapter, key, embedding = UMAP_REF) {
  return adapter._vectorFieldCache.has(vectorRoute(adapter, key, embedding));
}

test('embedding and vector caches share one cumulative retained-byte owner', async () => {
  const { adapter } = createCoordinateCacheBudgetScenario(120);

  await adapter.getEmbeddingForRef(UMAP_REF);
  assert.equal(adapter._coordinateCacheBytes, 40n);
  assert.equal(adapter._embeddingCache.has('X_umap_2d'), true);

  await readVector(adapter, 'velocity_a_2d');
  assert.equal(adapter._coordinateCacheBytes, 40n);
  assert.equal(
    adapter._embeddingCache.has('X_umap_2d'),
    false,
    'the stale embedding must be evicted before retaining the first vector'
  );
  assert.equal(hasVectorCache(adapter, 'velocity_a_2d'), true);

  await readVector(adapter, 'velocity_b_2d');
  assert.equal(adapter._coordinateCacheBytes, 40n);
  assert.equal(
    hasVectorCache(adapter, 'velocity_a_2d'),
    false,
    'the first vector must be evicted before retaining the second vector'
  );
  assert.equal(hasVectorCache(adapter, 'velocity_b_2d'), true);
});

test('coordinate cache hits refresh one cross-kind LRU order', async () => {
  const { adapter } = createCoordinateCacheBudgetScenario(160);

  await adapter.getEmbeddingForRef(UMAP_REF);
  await readVector(adapter, 'velocity_a_2d');
  await adapter.getEmbeddingForRef(UMAP_REF);
  await readVector(adapter, 'velocity_b_2d');

  assert.equal(adapter._coordinateCacheBytes, 80n);
  assert.equal(adapter._embeddingCache.has('X_umap_2d'), true);
  assert.equal(
    hasVectorCache(adapter, 'velocity_a_2d'),
    false,
    'the untouched vector must be the shared LRU victim'
  );
  assert.equal(hasVectorCache(adapter, 'velocity_b_2d'), true);
});

test('coordinate LRU keeps a pinned result and still serves every caller beyond its budget', async () => {
  const { adapter, reads } = createCoordinateCacheBudgetScenario(40);
  await adapter.getEmbeddingForRef(UMAP_REF);
  const embeddingKey = adapter._embeddingCoordinateCacheKey('X_umap_2d');
  const releaseEmbedding = adapter._pinCoordinateCacheKey(embeddingKey);

  // The budget is a residency policy: with the embedding pinned there is
  // nothing to evict, and the vector is still read and kept beside it.
  try {
    await readVector(adapter, 'velocity_a_2d');
  } finally {
    releaseEmbedding();
  }
  assert.equal(adapter._embeddingCache.has('X_umap_2d'), true);
  assert.equal(hasVectorCache(adapter, 'velocity_a_2d'), true);
  assert.equal(adapter._coordinateCacheBytes, 80n);

  // Once released, the next result evicts the least recently used entries.
  await readVector(adapter, 'velocity_b_2d');
  assert.equal(reads.get('velocity_a_2d'), 1);
  assert.equal(adapter._embeddingCache.has('X_umap_2d'), false);
  assert.equal(hasVectorCache(adapter, 'velocity_b_2d'), true);
});

test('a coordinate result larger than the cache budget is read and returned, never refused', async () => {
  const scenario = createCoordinateCacheBudgetScenario(39);
  const embedding = await scenario.adapter.getEmbeddingForRef(UMAP_REF);
  assert.equal(embedding.length, 10);
  const vector = await readVector(scenario.adapter, 'velocity_a_2d');
  assert.equal(vector.length, 10);
});

test('a raw plus normalized coordinate peak above the cache budget still loads, and only the result is retained', async () => {
  // 80 transient read bytes plus 40 normalized bytes exceed 64: no refusal.
  const scenario = createCoordinateCacheBudgetScenario(64);
  const result = await scenario.adapter.getEmbeddingForRef(UMAP_REF);
  assert.equal(result.length, 10);
  assert.equal(scenario.reads.get('X_umap_2d'), 1);
  // Only the normalized result is retained; the transient read is released.
  assert.equal(scenario.adapter._coordinateCacheBytes, 40n);
  assert.equal(scenario.adapter._coordinateReservedOutputBytes, 0n);
  assert.equal(scenario.adapter._embeddingInFlight.size, 0);
});

test('initialize rejects non-finite embedding components before normalization', async () => {
  let normalizationCalls = 0;
  let reads = 0;
  const loader = {
    nObs: 2,
    nVars: 0,
    obsKeys: [],
    varNames: [],
    async getDatasetMetadata() {
      return {
        stats: {
          n_cells: 2,
          n_genes: 0,
          n_categorical_fields: 0,
          n_continuous_fields: 0
        },
        probes: mappingProbes({ nObs: 2, obsm: { X_umap_2d: 2 } }),
        obs_fields: []
      };
    },
    async readObsmColumns(key, columns) {
      reads++;
      return selectColumns([0, Number.NaN, 1, 1], 2, columns);
    },
    close() {}
  };
  const adapter = new BaseAnnDataAdapter(loader);
  adapter._normalizeEmbedding = () => {
    normalizationCalls++;
    throw new Error('normalization must not see non-finite coordinates');
  };

  // The default rule's X_umap_2d is reported, never replaced by a guess.
  await assert.rejects(
    adapter.initialize(),
    error => error.name === 'EmbeddingLoadError' &&
      /Embedding 'X_umap_2d' cannot be plotted: NaN at cell 0\./.test(error.message)
  );
  assert.equal(normalizationCalls, 0);
  assert.equal(reads, 1);
  assert.equal(adapter._embeddingCache.size, 0);
  assert.equal(adapter._coordinateCacheBytes, 0n);
  assert.equal(adapter._metadata, null);
});

test('public coordinate reads reject every non-finite component before copy or cache and leave later callers independent', async t => {
  for (const [name, nonFinite, defect] of [
    ['NaN', Number.NaN, 'NaN'],
    ['positive infinity', Number.POSITIVE_INFINITY, 'Infinity'],
    ['negative infinity', Number.NEGATIVE_INFINITY, '-Infinity'],
    ['beyond float32', 1e300, 'not representable as float32']
  ]) {
    await t.test(name, async () => {
      let embeddingAttempt = 0;
      let vectorAttempt = 0;
      const loader = {
        nObs: 2,
        async readObsmColumns(key, columns) {
          if (key === 'X_umap_2d') {
            embeddingAttempt++;
            return selectColumns(
              embeddingAttempt === 1 ? [0, nonFinite, 1, 1] : [0, 0, 1, 1],
              2,
              columns
            );
          }
          vectorAttempt++;
          return selectColumns(
            vectorAttempt === 1 ? [1, nonFinite, 2, 2] : [1, 1, 2, 2],
            2,
            columns
          );
        },
        close() {}
      };
      const adapter = new BaseAnnDataAdapter(loader);
      installPrivateCoordinateResolution(adapter, UMAP_WITH_VELOCITY);

      await assert.rejects(
        adapter.getEmbeddingForRef(UMAP_REF),
        new RegExp(`Embedding 'X_umap_2d' cannot be plotted: ${defect} at cell 0`)
      );
      assert.equal(adapter._embeddingCache.size, 0);
      assert.equal(adapter._normInfo.size, 0);
      assert.equal(adapter._coordinateCacheBytes, 0n);

      const embedding = await adapter.getEmbeddingForRef(UMAP_REF);
      assert.deepEqual(Array.from(embedding), [-1, -1, 1, 1]);
      assert.equal(embeddingAttempt, 2);

      await assert.rejects(
        readVector(adapter, 'velocity_umap_2d'),
        error => error instanceof MappingLoadError &&
          error.key === 'velocity_umap_2d' &&
          error.reason === `${defect} at cell 0` &&
          error.message === `Vector field 'velocity_umap_2d' cannot be drawn: ${defect} at cell 0.`
      );
      assert.equal(hasVectorCache(adapter, 'velocity_umap_2d'), false);
      // Only the embedding's normalized result stays charged.
      assert.equal(adapter._coordinateCacheBytes, 16n);
      assert.equal(adapter._vectorFieldInFlight.size, 0);

      const vector =
        await readVector(adapter, 'velocity_umap_2d');
      assert.deepEqual(Array.from(vector), [2, 2, 4, 4]);
      assert.equal(vectorAttempt, 2);
    });
  }
});

test('adapter retains normalized results until a payload caller takes them', async () => {
  const reads = [];
  const loader = {
    nObs: 2,
    async readObsmColumns(key, columns) {
      reads.push(key);
      return selectColumns(
        key === 'X_umap_2d' ? [0, 0, 2, 2] : [1, 2, 3, 4],
        2,
        columns
      );
    },
    close() {}
  };
  const adapter = new BaseAnnDataAdapter(loader);
  installPrivateCoordinateResolution(adapter, UMAP_WITH_VELOCITY);

  const embedding = await adapter.getEmbeddingForRef(UMAP_REF);
  const vector =
    await readVector(adapter, 'velocity_umap_2d');

  assert.deepEqual(Array.from(embedding), [-1, -1, 1, 1]);
  assert.deepEqual(Array.from(vector), [1, 2, 3, 4]);
  assert.strictEqual(await adapter.getEmbeddingForRef(UMAP_REF), embedding);
  assert.strictEqual(
    await readVector(adapter, 'velocity_umap_2d'),
    vector
  );
  assert.deepEqual(reads, ['X_umap_2d', 'velocity_umap_2d']);
  // Two retained results; no transient read stays charged.
  assert.equal(adapter._coordinateCacheBytes, 32n);

  // The payload route hands the cached embedding to its caller, who
  // normalizes it in place for display, and the adapter forgets it.
  const payload = await adapter.getEmbeddingPayload('embeddings/0_2d.bin', 2);
  assert.strictEqual(payload, embedding, 'the identity path names the cached embedding');
  assert.equal(adapter._embeddingCache.has('X_umap_2d'), false);
  assert.equal(adapter._coordinateCacheBytes, 16n);
  payload.fill(7);

  // A caller's writes never reach a later request: it reads the array again.
  const again = await adapter.getEmbeddingPayload('embeddings/0_2d.bin', 2);
  assert.notStrictEqual(again, payload);
  assert.deepEqual(Array.from(again), [-1, -1, 1, 1]);
  assert.deepEqual(reads, ['X_umap_2d', 'velocity_umap_2d', 'X_umap_2d']);
  assert.equal(adapter._coordinateCacheBytes, 16n);
});

test('coalesced coordinate callers retain and charge one shared result', async () => {
  const scenario = createColdCoalescingScenario('vector');
  // 48 transient read bytes plus 24 normalized bytes.
  scenario.adapter._cacheBudgetBytes = 72n;
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

const ONE_AND_TWO = Object.freeze({
  obsm: { X_one: 1, X_two: 2 },
  embeddings: [
    { key: 'X_one', columns: [0] },
    { key: 'X_two', columns: [0, 1] },
  ],
});

test('coordinate cache accounting counts aliased backing buffers once', async () => {
  const sharedBuffer = new ArrayBuffer(40);
  const loader = {
    nObs: 10,
    close() {},
    async readObsmColumns(key, columns) {
      return Float64Array.from({ length: 10 * columns.length }, (_, index) => index);
    },
  };
  // The 2D read peaks at 40 retained + 160 read + 80 normalized bytes.
  const adapter = new BaseAnnDataAdapter(loader, {
    cacheBudgetBytes: 280,
  });
  installPrivateCoordinateResolution(adapter, ONE_AND_TWO);
  adapter._normalizeEmbedding = () => new Float32Array(sharedBuffer);

  await adapter.getEmbeddingForRef({ key: 'X_one', columns: [0] });
  await adapter.getEmbeddingForRef({ key: 'X_two', columns: [0, 1] });
  assert.equal(adapter._embeddingCache.size, 2);
  assert.equal(adapter._coordinateCacheBytes, 40n);
  assert.equal(adapter._coordinateBufferRefs.size, 1);
});

test('raw coordinate reservations count a retained backing-buffer alias once', async () => {
  // The 1D result is retained as a 160-byte buffer, and the 2D read (20
  // Float64 values) is a view of that same buffer, so the 2D peak is
  // 160 retained + 0 read + 80 normalized = 240 bytes; counting the alias
  // twice would need 400.
  const sharedBuffer = new ArrayBuffer(160);
  new Float64Array(sharedBuffer).set(
    Float64Array.from({ length: 20 }, (_, index) => index)
  );
  const loader = {
    nObs: 10,
    close() {},
    async readObsmColumns(key) {
      return key === 'X_one'
        ? Float64Array.from({ length: 10 }, (_, index) => index)
        : new Float64Array(sharedBuffer);
    }
  };
  const adapter = new BaseAnnDataAdapter(loader, {
    cacheBudgetBytes: 240
  });
  installPrivateCoordinateResolution(adapter, ONE_AND_TWO);
  adapter._normalizeEmbedding = (_data, dimension) =>
    dimension === 1
      ? new Float32Array(sharedBuffer, 0, 10)
      : new Float32Array(20);

  await adapter.getEmbeddingForRef({ key: 'X_one', columns: [0] });
  await adapter.getEmbeddingForRef({ key: 'X_two', columns: [0, 1] });

  assert.equal(adapter._embeddingCache.size, 2);
  assert.equal(adapter._coordinateCacheBytes, 240n);
  assert.equal(adapter._coordinateBufferRefs.size, 2);
});

test('clear and close reset coordinate cache ownership for later callers', async () => {
  const { adapter, loader, reads } =
    createCoordinateCacheBudgetScenario(160);
  await adapter.getEmbeddingForRef(UMAP_REF);
  await readVector(adapter, 'velocity_a_2d');
  assert.equal(adapter._coordinateCacheBytes, 80n);

  adapter.clearCaches();
  assert.equal(adapter._coordinateCacheBytes, 0n);
  assert.equal(adapter._coordinateCacheLru.size, 0);
  assert.equal(adapter._coordinateBufferRefs.size, 0);
  assert.equal(adapter._embeddingCache.size, 0);
  assert.equal(adapter._vectorFieldCache.size, 0);

  await adapter.getEmbeddingForRef(UMAP_REF);
  assert.equal(adapter._coordinateCacheBytes, 40n);
  assert.equal(reads.get('X_umap_2d'), 2);

  adapter.close();
  assert.equal(adapter._coordinateCacheBytes, 0n);
  assert.equal(adapter._coordinateCacheLru.size, 0);
  assert.equal(adapter._coordinateBufferRefs.size, 0);
  assert.equal(loader.closeCalls, 1);
});

test('coordinate requests name exactly what the file and its identity hold', async t => {
  function adapterWithReads() {
    const loader = {
      nObs: 2,
      payloadReads: 0,
      close() {},
      async readObsmColumns(key, columns) {
        this.payloadReads++;
        return selectColumns([0, 0, 1, 1], 2, columns);
      },
    };
    const adapter = new BaseAnnDataAdapter(loader);
    installPrivateCoordinateResolution(adapter, {
      obsm: { X_umap_2d: 2, velocity_umap_2d: 2, X_pca: 4 },
      embeddings: [UMAP_REF],
    });
    return { adapter, loader };
  }

  await t.test('an obsm key the file does not list is never read', async () => {
    const { adapter, loader } = adapterWithReads();
    await assert.rejects(
      adapter.getEmbeddingForRef({ key: 'X_umap', columns: [0, 1] }),
      /obsm\['X_umap'\] does not exist/
    );
    await assert.rejects(
      adapter.getEmbeddingForRef({ key: 'X_pca', columns: [0, 4] }),
      /column 4 does not exist/i
    );
    assert.equal(loader.payloadReads, 0);
  });

  await t.test('payload paths route to identity items or catalog entries', async () => {
    const { adapter, loader } = adapterWithReads();
    await assert.rejects(
      adapter.getEmbeddingPayload('embeddings/1_2d.bin', 2),
      /no embedding payload 'embeddings\/1_2d\.bin'/
    );
    await assert.rejects(
      adapter.getEmbeddingPayload('embeddings/0_3d.bin', 3),
      /no embedding payload/
    );
    // The caller's layout dimension is checked against the payload, never clamped.
    await assert.rejects(
      adapter.getEmbeddingPayload('_cellucid/mapping/embeddings/2/0-1.bin', 3),
      /holds 2D coordinates, not 3D/
    );
    await assert.rejects(
      adapter.getEmbeddingPayload('_cellucid/mapping/embeddings/9/0-1.bin', 2),
      /no embedding payload/
    );
    await assert.rejects(
      adapter.getEmbeddingPayload('obs/0.values.f32', 2),
      /no embedding payload/
    );
    assert.equal(loader.payloadReads, 0);

    // obsm entry 2 is X_pca: its columns 3 and 1, read on request.
    const reads = [];
    loader.readObsmColumns = async (key, columns) => {
      reads.push([key, columns]);
      return selectColumns([0, 1, 2, 3, 4, 5, 6, 7], 4, columns);
    };
    const mapped = await adapter.getEmbeddingPayload(
      '_cellucid/mapping/embeddings/2/3-1.bin',
      2
    );
    assert.deepEqual(reads, [['X_pca', [3, 1]]]);
    assert.equal(mapped.length, 4);
    // Handed to the caller, so not retained; its scale stays for its vectors.
    assert.equal(adapter._embeddingCache.has('X_pca[3,1]'), false);
    assert.equal(adapter._normInfo.has('X_pca[3,1]'), true);
  });

  await t.test('a vector route is read only as the binding resolveVectorBinding names', async () => {
    const { adapter, loader } = adapterWithReads();
    adapter._normInfo.set('X_umap_2d', { scale: 1 });
    // obsm 0 is X_umap_2d, 1 velocity_umap_2d, 2 X_pca (4 columns).
    assert.equal(vectorRoute(adapter, 'velocity_umap_2d'), VELOCITY_ROUTE);
    for (const [route, dimension, pattern] of [
      // Not a vector route, or an obsm entry the catalog does not list.
      ['vectors/0_0.bin', 2, /no vector payload 'vectors\/0_0\.bin'/],
      ['_cellucid/mapping/vectors/9/0-1/0/0-1.bin', 2, /no vector payload/],
      ['_cellucid/mapping/vectors/1/0-1/9/0-1.bin', 2, /no vector payload/],
      // A vector array is never its own embedding.
      ['_cellucid/mapping/vectors/0/0-1/0/0-1.bin', 2, /Cannot draw this vector field: obsm\['X_umap_2d'\] is the embedding itself/],
      // A 4-column array is neither 2 wide nor as wide as X_umap_2d.
      ['_cellucid/mapping/vectors/2/0-1/0/0-1.bin', 2, /obsm\['X_pca'\] has 4 columns; it needs 2, or 2 like obsm\['X_umap_2d'\]/],
      // The vector columns are the ones the binding rule picks, nothing else.
      ['_cellucid/mapping/vectors/1/1-0/0/0-1.bin', 2, /obsm\['velocity_umap_2d'\] cannot be bound to obsm\['X_umap_2d'\] at these columns/],
      ['_cellucid/mapping/vectors/2/2-3/2/2-3.bin', 2, /obsm\['X_pca'\] is the embedding itself/],
      // The caller's layout dimension is checked against the payload.
      [VELOCITY_ROUTE, 3, /holds 2D vectors, not 3D/],
    ]) {
      await assert.rejects(adapter.getVectorPayload(route, dimension), pattern, route);
    }
    assert.equal(loader.payloadReads, 0);
    assert.equal(adapter._vectorFieldCache.size, 0);

    // The same array bound to another embedding is another route: X_pca
    // columns [3, 1] read velocity_umap_2d whole, under X_pca's own scale.
    const reads = [];
    loader.readObsmColumns = async (key, columns) => {
      reads.push([key, columns]);
      return selectColumns(key === 'X_pca' ? [0, 0, 0, 0, 4, 4, 4, 4] : [1, 1, 1, 1], key === 'X_pca' ? 4 : 2, columns);
    };
    const pcaRef = { key: 'X_pca', columns: [3, 1] };
    const pcaRoute = vectorRoute(adapter, 'velocity_umap_2d', pcaRef);
    assert.equal(pcaRoute, '_cellucid/mapping/vectors/1/0-1/2/3-1.bin');
    const vectors = await adapter.getVectorPayload(pcaRoute, 2);
    assert.deepEqual(reads, [['X_pca', [3, 1]], ['velocity_umap_2d', [0, 1]]]);
    assert.equal(adapter._normInfo.get('X_pca[3,1]').scale, 0.5);
    assert.deepEqual(Array.from(vectors), [0.5, 0.5, 0.5, 0.5]);
    assert.strictEqual(adapter._vectorFieldCache.get(pcaRoute), vectors);
  });

  await t.test('vectors are scaled by their own embedding\'s normalization', async () => {
    const loader = {
      nObs: 2,
      close() {},
      async readObsmColumns(key, columns) {
        const values = {
          X_umap_2d: [0, 0, 4, 4],
          X_tsne: [0, 0, 1, 1],
          velocity_umap_2d: [1, 1, 1, 1],
        }[key];
        return selectColumns(values, 2, columns);
      },
    };
    const adapter = new BaseAnnDataAdapter(loader);
    installPrivateCoordinateResolution(adapter, {
      obsm: { X_umap_2d: 2, X_tsne: 2, velocity_umap_2d: 2 },
      embeddings: [UMAP_REF],
    });
    // Another 2D embedding with a different range loads first.
    await adapter.getEmbeddingForRef({ key: 'X_tsne', columns: [0, 1] });
    assert.equal(adapter._normInfo.get('X_tsne').scale, 2);
    const vector = await readVector(adapter, 'velocity_umap_2d');
    assert.equal(adapter._normInfo.get('X_umap_2d').scale, 0.5);
    assert.deepEqual(Array.from(vector), [0.5, 0.5, 0.5, 0.5]);
  });
});
