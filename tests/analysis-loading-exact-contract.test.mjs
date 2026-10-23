import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DataLayer,
} from '../assets/js/app/analysis/data/data-layer.js';

const PROTOTYPE_PROPERTY_NAMES =
  Object.getOwnPropertyNames(Object.prototype);

function assertExactOrdinaryRecord(record, expectedKeys) {
  assert.equal(Object.getPrototypeOf(record), Object.prototype);
  assert.deepEqual(Object.keys(record), expectedKeys);
  for (const key of expectedKeys) {
    assert.equal(Object.hasOwn(record, key), true, key);
  }
}

function bareDataLayer(state = {}) {
  const layer = Object.create(DataLayer.prototype);
  layer.state = state;
  layer._datasetGeneration = 0;
  layer._cacheGeneration = 0;
  layer._fieldLoadLifecycle = new AbortController();
  layer._destroyed = false;
  layer._notifications = null;
  layer._pageVersions = null;
  layer._pageIndexSnapshots = new Map();
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
  const olderWork = layer._pendingRequests.get('same-request');
  assert.ok(olderWork !== undefined);

  layer.resetForDatasetReload();
  const newerRequest = layer.getDataForPages(request);
  const newerWork = layer._pendingRequests.get('same-request');
  assert.notEqual(newerWork, olderWork, 'a reset starts the request again');

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
    newerWork,
    'an old settlement must not delete the newer same-key pending owner',
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

test('observation fields load only through the DataState lease, never a second loader', async () => {
  // `fetchBulkObsFields` reads every field through
  // `DataState.ensureFieldLoaded`, which registers analysis as an independent
  // lease on a shared field and marks it loaded, so a later read reuses the
  // same values instead of reading them again.
  const loadedThroughLease = [];
  const layer = bareDataLayer();
  layer.getAvailableVariables = type => (
    type === 'continuous_obs' ? [{ key: 'score' }] : []
  );
  layer.ensureObsFieldLoaded = async fieldKey => {
    loadedThroughLease.push(fieldKey);
    return { fieldIndex: 0, kind: 'continuous', values: Float32Array.of(4.5) };
  };

  const result = await layer.fetchBulkObsFields({
    pageIds: ['page-1'],
    obsFields: ['score'],
    subsetPages: false,
  });

  assert.deepEqual(loadedThroughLease, ['score']);
  assert.equal(result.stats.fieldsLoaded, 1);
});

test('observation loading propagates the first required scientific input failure', async t => {
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
      layer._loadObsFieldsConcurrently(
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
  await t.test('continuous field', async () => {
    const layer = bareDataLayer();
    layer.getAvailableVariables = type => (
      type === 'continuous_obs' ? [{ key: 'score' }] : []
    );
    layer.ensureObsFieldLoaded = async () => ({
      fieldIndex: 0,
      kind: 'continuous',
      values: Float32Array.of(4.5),
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
    const layer = bareDataLayer();
    layer.getAvailableVariables = type => (
      type === 'categorical_obs' ? [{ key: 'cell_type' }] : []
    );
    layer.ensureObsFieldLoaded = async () => ({
      fieldIndex: 0,
      kind: 'category',
      codes: Uint16Array.of(0),
      categories: ['T cell'],
      colors: {},
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

test('all public DataLayer page records preserve prototype-named page identities', async t => {
  const createLayer = () => {
    const layer = bareDataLayer();
    layer.getPages = () => PROTOTYPE_PROPERTY_NAMES.map(id => ({
      id,
      name: id,
    }));
    layer.getCellIndicesForPage = pageId => Uint32Array.of(
      PROTOTYPE_PROPERTY_NAMES.indexOf(pageId),
    );
    return layer;
  };

  await t.test('observation field pages and pageData', async () => {
    const layer = createLayer();
    layer.getAvailableVariables = type => (
      type === 'continuous_obs' ? [{ key: 'score' }] : []
    );
    layer.ensureObsFieldLoaded = async () => ({
      fieldIndex: 0,
      kind: 'continuous',
      values: Float32Array.from(
        { length: PROTOTYPE_PROPERTY_NAMES.length },
        (_value, index) => index,
      ),
    });
    const result = await layer.fetchBulkObsFields({
      pageIds: PROTOTYPE_PROPERTY_NAMES,
      obsFields: ['score'],
    });
    assertExactOrdinaryRecord(
      result.pageData,
      PROTOTYPE_PROPERTY_NAMES,
    );
    assertExactOrdinaryRecord(result.fields, ['score']);
    assertExactOrdinaryRecord(
      result.fields.score,
      ['kind', 'categories', ...PROTOTYPE_PROPERTY_NAMES],
    );
  });

  await t.test('category-count page records', async () => {
    const layer = createLayer();
    layer.getDataForPages = async () => (
      PROTOTYPE_PROPERTY_NAMES.map((pageId, index) => ({
        pageId,
        pageName: pageId,
        values: [`category-${index}`],
        cellCount: 1,
      }))
    );
    const result = await layer.getCategoryCountsByPage(
      'cell_type',
      PROTOTYPE_PROPERTY_NAMES,
    );
    assertExactOrdinaryRecord(
      result.pages,
      PROTOTYPE_PROPERTY_NAMES,
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
  });

  assert.equal(result.stats.fieldsLoaded, 1);
  assert.deepEqual(result.fields.score, {
    kind: 'continuous',
    categories: null,
    values,
  });
});

test('sequential DataLayer analysis preserves prototype-named fields and categories', async t => {
  await t.test('observation fields', async () => {
    const layer = bareDataLayer();
    layer.getAvailableVariables = type => (
      type === 'continuous_obs'
        ? PROTOTYPE_PROPERTY_NAMES.map(key => ({ key }))
        : []
    );
    layer.ensureObsFieldLoaded = async fieldKey => ({
      fieldIndex: PROTOTYPE_PROPERTY_NAMES.indexOf(fieldKey),
      kind: 'continuous',
      values: Float32Array.of(PROTOTYPE_PROPERTY_NAMES.indexOf(fieldKey)),
    });

    const result = await layer.fetchBulkObsFields({
      pageIds: ['page-1'],
      obsFields: PROTOTYPE_PROPERTY_NAMES,
      subsetPages: false,
    });
    assert.equal(result.stats.fieldsLoaded, PROTOTYPE_PROPERTY_NAMES.length);
    assertExactOrdinaryRecord(result.fields, PROTOTYPE_PROPERTY_NAMES);
  });

  await t.test('category counts', async () => {
    const layer = bareDataLayer();
    layer.getDataForPages = async () => [{
      pageId: 'page-1',
      pageName: 'Page 1',
      values: PROTOTYPE_PROPERTY_NAMES,
      cellCount: PROTOTYPE_PROPERTY_NAMES.length,
    }];

    const result = await layer.getCategoryCountsByPage(
      'prototype_categories',
      ['page-1'],
    );
    const counts = result.pages['page-1'].counts;
    assertExactOrdinaryRecord(counts, PROTOTYPE_PROPERTY_NAMES);
    for (const name of PROTOTYPE_PROPERTY_NAMES) {
      assert.equal(counts[name], 1, name);
    }
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
    }),
    /category code 1.*cell_type.*outside 1 categor/i,
  );
});
