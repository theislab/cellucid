import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TransformPluginRegistry,
} from '../assets/js/app/analysis/core/plugin-contract.js';
import {
  DataLayer,
} from '../assets/js/app/analysis/data/data-layer.js';
import {
  loadAnalysisBulkData,
  loadAnalysisBulkObsData,
  loadAnalysisSubset,
} from '../assets/js/data/data-loaders.js';

function bareDataLayer(state = {}) {
  const layer = Object.create(DataLayer.prototype);
  layer.state = state;
  layer._datasetGeneration = 0;
  layer._cacheGeneration = 0;
  layer._fieldLoadLifecycle = new AbortController();
  layer._destroyed = false;
  layer._notifications = null;
  layer.getCellIndicesForPage = () => Uint32Array.of(0);
  layer.getPages = () => [{ id: 'page-1', name: 'Page 1' }];
  return layer;
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function transformRegistry(execute, {
  gpuAvailable = true,
  gpuMethod = 'executeGPU',
} = {}) {
  const registry = new TransformPluginRegistry();
  registry._gpuAvailable = gpuAvailable;
  registry._plugins.set('probe', {
    gpuMethod,
    workerMethod: null,
    execute,
    defaultOptions: {},
    optionSchema: {},
  });
  registry.getOptions = () => ({});
  registry.validateOptions = () => ({ valid: true, errors: [] });
  return registry;
}

test('a selected transform backend executes exactly once and propagates failure', async () => {
  const injected = new Error('injected GPU execution failure');
  const backends = [];
  const registry = transformRegistry(async (_data, _options, context) => {
    backends.push(context.backend);
    throw injected;
  });

  await assert.rejects(
    registry.execute(
      'probe',
      { values: Float32Array.of(1) },
      {},
      { preferredBackend: 'gpu' },
    ),
    error => error === injected,
  );
  assert.deepEqual(backends, ['gpu']);
});

test('an explicitly requested unavailable transform backend rejects before execution', async () => {
  let executions = 0;
  const registry = transformRegistry(async () => {
    executions++;
    return { values: Float32Array.of(1) };
  }, {
    gpuAvailable: false,
  });

  await assert.rejects(
    registry.execute(
      'probe',
      { values: Float32Array.of(1) },
      {},
      { preferredBackend: 'gpu' },
    ),
    /requested transform backend "gpu" is unavailable/i,
  );
  assert.equal(executions, 0);
});

test('bulk gene loader failure is not converted into a sequential result', async () => {
  const injected = new Error('injected bulk gene failure');
  const varManifest = {};
  Object.defineProperty(varManifest, 'fields', {
    get() {
      throw injected;
    },
  });
  const layer = bareDataLayer({
    manifestUrl: 'https://example.test/var_manifest.json',
    varManifest,
  });
  let sequentialCalls = 0;
  layer._loadGenesSequentially = async () => {
    sequentialCalls++;
  };

  await assert.rejects(
    layer.fetchAnalysisData({
      pageIds: ['page-1'],
      genes: ['Gene A'],
    }),
    error => error === injected,
  );
  assert.equal(sequentialCalls, 0);
});

test('dataset reset generation-isolates old cache and pending-request settlement', async t => {
  const layer = new DataLayer({}, {
    enableNotifications: false,
    enablePrefetch: false,
    enableVersionTracking: false,
  });
  t.after(() => layer.destroy());

  const older = deferred();
  const newer = deferred();
  const pending = [older, newer];
  layer.refreshPageVersions = () => {};
  layer._getCacheKey = () => 'same-request';
  layer._fetchDataForPages = () => pending.shift().promise;

  const request = {
    type: 'continuous_obs',
    variableKey: 'score',
    pageIds: ['page-1'],
  };
  const olderRequest = layer.getDataForPages(request);
  assert.equal(layer._pendingRequests.get('same-request'), older.promise);

  layer.resetForDatasetReload();
  const newerRequest = layer.getDataForPages(request);
  assert.equal(layer._pendingRequests.get('same-request'), newer.promise);

  older.resolve(['old-dataset']);
  await assert.rejects(
    olderRequest,
    /analysis data request.*invalidated|invalidated.*analysis data request/i,
  );
  assert.equal(
    layer._dataCache.has('same-request'),
    false,
    'an old dataset generation must not repopulate the cache',
  );
  assert.equal(
    layer._pendingRequests.get('same-request'),
    newer.promise,
    'an old finally block must not delete the newer same-key pending owner',
  );

  newer.resolve(['new-dataset']);
  assert.deepEqual(await newerRequest, ['new-dataset']);
  assert.deepEqual(layer._dataCache.get('same-request'), ['new-dataset']);
  assert.equal(layer._pendingRequests.has('same-request'), false);
});

test('page-data requests snapshot caller-owned page IDs before cache keying and awaits', async t => {
  const layer = new DataLayer({}, {
    enableNotifications: false,
    enablePrefetch: false,
    enableVersionTracking: false,
  });
  t.after(() => layer.destroy());

  const gate = deferred();
  layer.refreshPageVersions = () => {};
  layer._getCacheKey = ({ pageIds }) => `pages:${pageIds.join(',')}`;
  layer._fetchDataForPages = async ({ pageIds }) => {
    await gate.promise;
    return [...pageIds];
  };

  const pageIds = ['page-A'];
  const request = layer.getDataForPages({
    type: 'continuous_obs',
    variableKey: 'score',
    pageIds,
  });
  pageIds[0] = 'page-B';
  gate.resolve();

  assert.deepEqual(await request, ['page-A']);
  assert.deepEqual(layer._dataCache.get('pages:page-A'), ['page-A']);
  assert.equal(layer._dataCache.has('pages:page-B'), false);
});

test('dataset reset rejects an old bulk-gene generation without cache or notification publication', async t => {
  const layer = new DataLayer({}, {
    enableNotifications: false,
    enablePrefetch: false,
    enableVersionTracking: false,
  });
  t.after(() => layer.destroy());

  const gate = deferred();
  const terminal = [];
  layer._notifications = {
    show() {
      return 'bulk-old';
    },
    updateProgress() {},
    complete(id) {
      terminal.push(['complete', id]);
    },
    fail(id) {
      terminal.push(['fail', id]);
    },
    dismiss(id) {
      terminal.push(['dismiss', id]);
    },
  };
  layer.refreshPageVersions = () => {};
  layer.getAvailableVariables = () => [{ key: 'Gene A' }];
  layer.getDataForPages = async () => gate.promise;

  const request = layer.fetchBulkGeneExpression({
    pageIds: ['page-1'],
    geneList: ['Gene A'],
  });
  layer.resetForDatasetReload();
  gate.resolve([{
    pageId: 'page-1',
    pageName: 'Old page',
    values: [1],
    cellIndices: [0],
    cellCount: 1,
  }]);

  await assert.rejects(
    request,
    /analysis data request.*invalidated|invalidated.*analysis data request/i,
  );
  assert.equal(layer._bulkGeneCache.size, 0);
  assert.deepEqual(terminal, [['dismiss', 'bulk-old']]);
});

test('session cache rollback cannot resurrect an older dataset after reset or destroy', async t => {
  for (const lifecycle of ['reset', 'destroy']) {
    await t.test(lifecycle, () => {
      const layer = new DataLayer({}, {
        enableNotifications: false,
        enablePrefetch: false,
        enableVersionTracking: false,
      });
      layer._bulkGeneCache.set('old-dataset', {
        data: {},
        timestamp: 1,
        geneCount: 0,
      });
      layer._bulkGeneCacheAccessOrder.push('old-dataset');
      const replacement = layer.beginSessionCacheReplacement();

      if (lifecycle === 'reset') {
        layer.resetForDatasetReload();
      } else {
        layer.destroy();
      }
      assert.deepEqual([...layer._bulkGeneCache.keys()], []);
      assert.throws(
        () => replacement.rollback(),
        /dataset|lifecycle|invalidated|ownership changed/i,
      );
      assert.deepEqual([...layer._bulkGeneCache.keys()], []);

      if (lifecycle !== 'destroy') layer.destroy();
    });
  }
});

test('bulk observation loader failure is not converted into a sequential result', async () => {
  const injected = new Error('injected bulk observation failure');
  const obsManifest = {};
  Object.defineProperty(obsManifest, 'fields', {
    get() {
      throw injected;
    },
  });
  const layer = bareDataLayer({
    manifestUrl: 'https://example.test/obs_manifest.json',
    obsManifest,
  });
  let sequentialCalls = 0;
  layer._loadObsFieldsSequentially = async () => {
    sequentialCalls++;
  };

  await assert.rejects(
    layer.fetchBulkObsFields({
      pageIds: ['page-1'],
      obsFields: ['cell_type'],
    }),
    error => error === injected,
  );
  assert.equal(sequentialCalls, 0);
});

test('sequential loaders propagate the first required scientific input failure', async t => {
  await t.test('gene expression', async () => {
    const injected = new Error('injected gene failure');
    const layer = bareDataLayer();
    layer.getDataForPages = async () => {
      throw injected;
    };
    const result = {
      genes: {},
      stats: { genesLoaded: 0 },
    };

    await assert.rejects(
      layer._loadGenesSequentially(
        ['Gene A'],
        ['page-1'],
        result,
      ),
      error => error === injected,
    );
    assert.deepEqual(result.genes, {});
    assert.equal(result.stats.genesLoaded, 0);
  });

  await t.test('observation field', async () => {
    const injected = new Error('injected observation failure');
    const layer = bareDataLayer();
    layer.getAvailableVariables = type => (
      type === 'continuous_obs' ? [{ key: 'score' }] : []
    );
    layer.ensureObsFieldLoaded = async () => {
      throw injected;
    };
    let publications = 0;

    await assert.rejects(
      layer._loadObsFieldsSequentially(
        ['score'],
        undefined,
        () => {
          publications++;
        },
      ),
      error => error === injected,
    );
    assert.equal(publications, 0);
  });
});

test('requested latent data requires an adopted identity in both public aggregators', async t => {
  for (const method of [
    'fetchAnalysisData',
    'fetchComprehensiveAnalysisData',
  ]) {
    await t.test(method, async () => {
      const layer = bareDataLayer();
      await assert.rejects(
        layer[method]({
          pageIds: ['page-1'],
          genes: [],
          obsFields: [],
          includeLatent: true,
          latentDimension: 2,
        }),
        /latent.*requires.*manifestUrl.*datasetIdentity/i,
      );
    });
  }
});

test('bulk loaders reject every missing requested variable before I/O or progress', async t => {
  await t.test('gene', async () => {
    await assert.rejects(
      loadAnalysisBulkData({
        manifestUrl: 'https://example.test/var_manifest.json',
        varManifest: { fields: [{ key: 'Gene A' }] },
        geneList: ['Missing Gene'],
        batchSize: 1,
        suppressNotifications: true,
      }),
      /requested gene.*Missing Gene.*not declared/i,
    );
  });

  await t.test('observation field', async () => {
    await assert.rejects(
      loadAnalysisBulkObsData({
        manifestUrl: 'https://example.test/obs_manifest.json',
        obsManifest: { fields: [{ key: 'score' }] },
        fieldList: ['missing_field'],
        batchSize: 1,
        suppressNotifications: true,
      }),
      /requested observation field.*missing_field.*not declared/i,
    );
  });
});

test('bulk gene loading rejects the original payload failure without partial success', async t => {
  const previousFetch = globalThis.fetch;
  const injected = new Error('injected Gene B payload failure');
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  globalThis.fetch = async url => {
    if (String(url).endsWith('/gene-b.bin')) {
      throw injected;
    }
    return new Response(Float32Array.of(1, 2).buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '8',
      },
    });
  };

  await assert.rejects(
    loadAnalysisBulkData({
      manifestUrl: 'https://example.test/var_manifest.json',
      varManifest: {
        fields: [
          {
            key: 'Gene A',
            kind: 'continuous',
            valuesPath: 'gene-a.bin',
            valuesDtype: 'float32',
            quantized: false,
          },
          {
            key: 'Gene B',
            kind: 'continuous',
            valuesPath: 'gene-b.bin',
            valuesDtype: 'float32',
            quantized: false,
          },
        ],
      },
      geneList: ['Gene A', 'Gene B'],
      batchSize: 2,
      suppressNotifications: true,
    }),
    error => error === injected,
  );
});

test('DataLayer rejects unknown variable and page identities', async t => {
  const layer = bareDataLayer();

  await t.test('variable type', () => {
    assert.throws(
      () => layer.getAvailableVariables('legacy-variable'),
      /unknown variable type.*legacy-variable/i,
    );
  });

  await t.test('page id', () => {
    delete layer.getCellIndicesForPage;
    layer.getPages = () => [];
    assert.throws(
      () => layer.getCellIndicesForPage('unknown'),
      /page not found.*unknown/i,
    );
  });
});

test('DataLayer field loading propagates hook failures and rejects absent ownership', async t => {
  await t.test('hook failure', async () => {
    const injected = new Error('injected field owner failure');
    const layer = bareDataLayer({
      ensureFieldLoaded: async () => {
        throw injected;
      },
    });

    await assert.rejects(
      layer._ensureFieldLoaded(
        { loaded: false, _loadingPromise: null },
        0,
        'obs',
      ),
      error => error === injected,
    );
  });

  await t.test('missing hook', async () => {
    const layer = bareDataLayer({});
    await assert.rejects(
      layer._ensureFieldLoaded(
        { loaded: false, _loadingPromise: null },
        0,
        'obs',
      ),
      /observation field loader is unavailable/i,
    );
  });
});

test('DataLayer rejects missing variables and pages instead of returning partial data', async t => {
  await t.test('missing variable', async () => {
    const layer = bareDataLayer();
    layer.getVariableInfo = () => null;
    await assert.rejects(
      layer._fetchDataForPages({
        type: 'gene_expression',
        variableKey: 'Missing Gene',
        pageIds: ['page-1'],
      }),
      /variable not found.*Missing Gene/i,
    );
  });

  await t.test('missing page', async () => {
    const field = {
      kind: 'continuous',
      loaded: true,
      values: Float32Array.of(1),
    };
    const layer = bareDataLayer({
      obsData: { fields: [field] },
    });
    layer.getVariableInfo = () => ({
      key: 'score',
      kind: 'continuous',
      _fieldIndex: 0,
    });
    layer.getPageInfo = () => null;

    await assert.rejects(
      layer._fetchDataForPages({
        type: 'continuous_obs',
        variableKey: 'score',
        pageIds: ['missing-page'],
      }),
      /page not found.*missing-page/i,
    );
  });
});

test('DataLayer rejects scientific index and category-code substitution', async t => {
  await t.test('cell index', async () => {
    const field = {
      kind: 'continuous',
      loaded: true,
      values: Float32Array.of(1),
    };
    const layer = bareDataLayer({
      obsData: { fields: [field] },
    });
    layer.getVariableInfo = () => ({
      key: 'score',
      kind: 'continuous',
      _fieldIndex: 0,
    });
    layer.getPageInfo = () => ({ id: 'page-1', name: 'Page 1' });
    layer.getCellIndicesForPage = () => [1];

    await assert.rejects(
      layer._fetchDataForPages({
        type: 'continuous_obs',
        variableKey: 'score',
        pageIds: ['page-1'],
      }),
      /cell index 1.*outside.*length 1/i,
    );
  });

  await t.test('category code', async () => {
    const field = {
      kind: 'category',
      loaded: true,
      codes: Uint16Array.of(2),
      categories: ['A'],
    };
    const layer = bareDataLayer({
      obsData: { fields: [field] },
    });
    layer.getVariableInfo = () => ({
      key: 'cell_type',
      kind: 'category',
      _fieldIndex: 0,
    });
    layer.getPageInfo = () => ({ id: 'page-1', name: 'Page 1' });
    layer.getCellIndicesForPage = () => [0];

    await assert.rejects(
      layer._fetchDataForPages({
        type: 'categorical_obs',
        variableKey: 'cell_type',
        pageIds: ['page-1'],
      }),
      /category code 2.*outside.*1 categor/i,
    );
  });
});

test('bulk observation projection rejects out-of-range page membership', async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  await t.test('continuous field', async () => {
    globalThis.fetch = async () => new Response(
      Float32Array.of(4.5).buffer,
      {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '4',
        },
      },
    );
    const layer = bareDataLayer({
      manifestUrl: 'https://example.test/obs_manifest.json',
      obsManifest: {
        fields: [{
          key: 'score',
          kind: 'continuous',
          valuesPath: 'score.f32',
          valuesDtype: 'float32',
          quantized: false,
          centroids: null,
          outlierQuantilesPath: null,
        }],
      },
    });
    layer.getCellIndicesForPage = () => [1];

    await assert.rejects(
      layer.fetchBulkObsFields({
        pageIds: ['page-1'],
        obsFields: ['score'],
      }),
      /cell index 1.*outside.*score.*length 1/i,
    );
  });

  await t.test('categorical field', async () => {
    globalThis.fetch = async () => new Response(
      Uint16Array.of(0).buffer,
      {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '2',
        },
      },
    );
    const layer = bareDataLayer({
      manifestUrl: 'https://example.test/obs_manifest.json',
      obsManifest: {
        fields: [{
          key: 'cell_type',
          kind: 'category',
          categories: ['T cell'],
          codesPath: 'cell-type.u16',
          codesDtype: 'uint16',
          codesMissingValue: 65_535,
          outlierQuantilesPath: null,
          outlierDtype: null,
          outlierQuantized: false,
          centroidsByDim: {},
        }],
      },
    });
    layer.getCellIndicesForPage = () => [1];

    await assert.rejects(
      layer.fetchBulkObsFields({
        pageIds: ['page-1'],
        obsFields: ['cell_type'],
      }),
      /cell index 1.*outside.*cell_type.*length 1/i,
    );
  });
});

test('cached bulk gene reads reject a missing requested gene atomically', async () => {
  const layer = bareDataLayer();
  layer._bulkGeneCacheMaxAge = 60_000;
  layer._getBulkGeneCacheKey = () => 'cache-key';
  layer._getBulkGeneCache = () => ({
    timestamp: Date.now(),
    data: {
      'Gene A': {
        'page-1': {
          values: Float32Array.of(1),
          cellIndices: Uint32Array.of(0),
          pageName: 'Page 1',
          cellCount: 1,
        },
      },
    },
  });

  await assert.rejects(
    layer.fetchBulkGeneExpression({
      pageIds: ['page-1'],
      geneList: ['Gene A', 'Missing Gene'],
    }),
    /cached bulk gene data.*missing requested genes.*Missing Gene/i,
  );
});

test('analysis subset extraction is exact and rejects invalid membership', async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const options = cellIndices => ({
    manifestUrl: 'https://example.test/var_manifest.json',
    varManifest: {
      fields: [{
        key: 'Gene A',
        kind: 'continuous',
        valuesPath: 'gene-a.f32',
        valuesDtype: 'float32',
        quantized: false,
      }],
    },
    geneList: ['Gene A'],
    cellIndices,
    suppressNotifications: true,
  });

  await t.test('valid ordered subset', async () => {
    globalThis.fetch = async () => new Response(
      Float32Array.of(1.25, 2.5, 5).buffer,
      {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '12',
        },
      },
    );
    const result = await loadAnalysisSubset(options([2, 0]));
    assert.deepEqual(result.cellIndices, [2, 0]);
    assert.deepEqual(
      Array.from(result.genes['Gene A'].values),
      [5, 1.25],
    );
    assert.deepEqual(result.genes['Gene A'].indices, [2, 0]);
  });

  await t.test('duplicate membership rejects before I/O', async () => {
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      return new Response(Float32Array.of(1).buffer);
    };
    await assert.rejects(
      loadAnalysisSubset(options([0, 0])),
      /cell index 0 is duplicated/i,
    );
    assert.equal(fetchCount, 0);
  });

  await t.test('out-of-range membership rejects instead of inserting NaN', async () => {
    globalThis.fetch = async () => new Response(
      Float32Array.of(1).buffer,
      {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '4',
        },
      },
    );
    await assert.rejects(
      loadAnalysisSubset(options([1])),
      /cell index 1.*outside gene "Gene A".*length 1/i,
    );
  });
});

test('sequential observation loading publishes the same raw field contract', async () => {
  const values = Float32Array.of(3.5);
  const layer = bareDataLayer();
  layer.getAvailableVariables = type => (
    type === 'continuous_obs' ? [{ key: 'score' }] : []
  );
  layer.ensureObsFieldLoaded = async () => ({
    fieldIndex: 0,
    kind: 'continuous',
    values,
  });

  const result = await layer.fetchBulkObsFields({
    pageIds: ['page-1'],
    obsFields: ['score'],
    subsetPages: false,
    includeCategoricalValues: false,
  });

  assert.equal(result.stats.fieldsLoaded, 1);
  assert.deepEqual(result.fields.score, {
    kind: 'continuous',
    categories: null,
    values,
  });
});

test('raw categorical publication rejects an invalid selected code', async () => {
  const layer = bareDataLayer();
  layer.getAvailableVariables = type => (
    type === 'categorical_obs' ? [{ key: 'cell_type' }] : []
  );
  layer.ensureObsFieldLoaded = async () => ({
    fieldIndex: 0,
    kind: 'category',
    codes: Uint16Array.of(1),
    categories: ['T cell'],
    colors: {},
  });

  await assert.rejects(
    layer.fetchBulkObsFields({
      pageIds: ['page-1'],
      obsFields: ['cell_type'],
      subsetPages: false,
      includeCategoricalValues: false,
    }),
    /category code 1.*cell_type.*outside 1 categor/i,
  );
});
