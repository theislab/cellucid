import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { initDimensionControls } from '../assets/js/app/ui/modules/dimension-controls.js';
import { initDatasetConnections } from '../assets/js/app/ui/modules/dataset-connections.js';
import {
  DATA_CONFIG,
} from '../assets/js/data/data-source.js';
import {
  createDataSourceManager,
} from '../assets/js/data/data-source-manager.js';
import { LocalDemoDataSource } from '../assets/js/data/local-demo-source.js';

function manifest(overrides = {}) {
  return {
    version: 1,
    default: 'first',
    datasets: [
      { id: 'first', path: 'first/', name: 'First' },
      { id: 'second', path: 'second/', name: 'Second' },
    ],
    ...overrides,
  };
}

function identity(id, name, cells) {
  return {
    version: 2,
    id,
    name,
    description: `${name} description`,
    cellucid_data_version: 'test-current',
    stats: {
      n_cells: cells,
      n_genes: 2,
      n_obs_fields: 0,
      n_categorical_fields: 0,
      n_continuous_fields: 0,
      has_connectivity: false,
      n_edges: null,
    },
    embeddings: {
      available_dimensions: [2],
      default_dimension: 2,
      files: { '2d': 'points_2d.bin' },
    },
    obs_fields: [],
  };
}

function identityWithObsFields() {
  const value = identity('invalid', 'Fields identity', 3);
  value.stats.n_obs_fields = 2;
  value.stats.n_categorical_fields = 1;
  value.stats.n_continuous_fields = 1;
  value.obs_fields = [
    { key: 'batch', kind: 'category', n_categories: 2 },
    { key: 'score', kind: 'continuous' },
  ];
  return value;
}

function sourceWithManifest(value) {
  const source = new LocalDemoDataSource(
    'https://catalog.cellucid.test/exports/'
  );
  source._manifest = value;
  return source;
}

function installIdentityFetch(t, responses) {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async input => {
    const url = String(input);
    requested.push(url);
    const response = responses.get(url);
    if (!response) {
      return new Response('', {
        status: 404,
        statusText: 'Not Found',
      });
    }
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return requested;
}

async function expectIdentityRejection(t, value, pattern) {
  const source = sourceWithManifest(
    manifest({
      default: 'invalid',
      datasets: [{ id: 'invalid', path: 'invalid/' }],
    })
  );
  installIdentityFetch(t, new Map([
    [
      'https://catalog.cellucid.test/exports/invalid/dataset_identity.json',
      value,
    ],
  ]));
  await assert.rejects(source.listDatasets(), pattern);
  assert.equal(source._datasets, null);
}

test('demo catalog requires one explicit existing default dataset', async t => {
  await t.test('missing default is rejected', async () => {
    const source = sourceWithManifest(
      manifest({ default: undefined })
    );
    await assert.rejects(
      source.getDefaultDatasetId(),
      /datasets\.json.*default|required.*default/i
    );
  });

  await t.test('unknown default is rejected', async () => {
    const source = sourceWithManifest(
      manifest({ default: 'not-listed' })
    );
    await assert.rejects(
      source.getDefaultDatasetId(),
      /default.*not-listed.*not.*datasets|unknown.*default/i
    );
  });
});

test('demo catalog metadata adoption is atomic across every advertised entry', async t => {
  const source = sourceWithManifest(manifest());
  installIdentityFetch(t, new Map([
    [
      'https://catalog.cellucid.test/exports/first/dataset_identity.json',
      identity('first', 'First identity', 3),
    ],
  ]));

  await assert.rejects(
    source.listDatasets(),
    /second.*dataset_identity|dataset_identity.*second/i
  );
  assert.equal(source._datasets, null);
});

test('demo catalog resolves only explicitly declared dataset paths', () => {
  const source = sourceWithManifest(manifest());
  assert.equal(
    source.getBaseUrl('first'),
    'https://catalog.cellucid.test/exports/first/'
  );
  assert.throws(
    () => source.getBaseUrl('not-listed'),
    /not-listed.*not.*datasets|dataset.*not-listed.*not found/i
  );
  const fileLikePathSource = sourceWithManifest(
    manifest({
      datasets: [
        { id: 'first', path: 'first', name: 'First' },
      ],
    })
  );
  assert.throws(
    () => fileLikePathSource.getBaseUrl('first'),
    /relative directory ending in '\/'/i
  );
});

test('demo catalog rejects incomplete identities and count contradictions', async t => {
  await t.test('identity required fields cannot be defaulted', async t => {
    const source = sourceWithManifest(
      manifest({
        default: 'broken',
        datasets: [{ id: 'broken', path: 'broken/' }],
      })
    );
    installIdentityFetch(t, new Map([
      [
        'https://catalog.cellucid.test/exports/broken/dataset_identity.json',
        { version: 2 },
      ],
    ]));

    await assert.rejects(
      source.listDatasets(),
      /broken.*dataset_identity|dataset_identity.*(stats|embeddings|name)/i
    );
    assert.equal(source._datasets, null);
  });

  await t.test('catalog counts must equal identity counts', async t => {
    const source = sourceWithManifest(
      manifest({
        default: 'conflict',
        datasets: [{
          id: 'conflict',
          path: 'conflict/',
          n_cells: 99,
          n_genes: 77,
        }],
      })
    );
    installIdentityFetch(t, new Map([
      [
        'https://catalog.cellucid.test/exports/conflict/dataset_identity.json',
        identity('conflict', 'Identity', 3),
      ],
    ]));

    await assert.rejects(
      source.listDatasets(),
      /conflict.*(n_cells|n_genes)|n_cells.*99.*3|n_genes.*77.*2/i
    );
    assert.equal(source._datasets, null);
  });
});

test('dataset identity v2 rejects every incomplete scientific summary', async t => {
  await t.test('undeclared top-level fields are rejected', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.legacy_stats = {};
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*unsupported field.*legacy_stats/i
    );
  });

  await t.test('an identity id cannot contradict its catalog id', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.id = 'different';
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*different.*catalog id.*invalid/i
    );
  });

  await t.test('an identity id cannot be omitted', async t => {
    const value = identity('invalid', 'Identity', 3);
    delete value.id;
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*missing required field.*id/i
    );
  });

  await t.test('description is required and must remain a string', async t => {
    const value = identity('invalid', 'Identity', 3);
    delete value.description;
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*description/i
    );
  });

  await t.test('cellucid data version cannot be empty', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.cellucid_data_version = ' ';
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*cellucid_data_version/i
    );
  });

  await t.test('all stats fields are required', async t => {
    const value = identity('invalid', 'Identity', 3);
    delete value.stats.n_edges;
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*stats.*n_edges/i
    );
  });

  await t.test('field summary counts must add up', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.stats.n_obs_fields = 1;
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*n_obs_fields.*categorical.*continuous/i
    );
  });

  await t.test('false connectivity requires an exact null edge count', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.stats.n_edges = 0;
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*n_edges.*null.*has_connectivity.*false/i
    );
  });

  await t.test('true connectivity requires an exact integer edge count', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.stats.has_connectivity = true;
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*n_edges.*non-negative safe integer/i
    );
  });
});

test('dataset identity v2 requires exact embedding metadata', async t => {
  await t.test('alias-resolution metadata is not part of the current identity', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.embeddings.umap_resolution = {
      source_key: 'X_umap',
      action: 'used_as',
    };
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*embeddings.*unsupported field.*umap_resolution/i
    );
  });

  await t.test('available dimensions must be an array', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.embeddings.available_dimensions = 2;
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*available_dimensions.*array/i
    );
  });

  await t.test('available dimensions cannot contain duplicates', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.embeddings.available_dimensions = [2, 2];
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*available_dimensions.*unique/i
    );
  });

  await t.test('default dimension must be advertised', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.embeddings.default_dimension = 3;
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*default_dimension.*available/i
    );
  });

  await t.test('files must use exact dimensional keys', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.embeddings.files = { 2: 'points_2d.bin' };
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*embeddings\.files.*exactly/i
    );
  });

  await t.test('advertised files must be safe relative paths', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.embeddings.files['2d'] = '../points_2d.bin';
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*embeddings\.files\.2d.*safe relative/i
    );
  });
});

test('dataset identity v2 requires exact observation summaries', async t => {
  await t.test('obs_fields length must match stats', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.obs_fields.push({ key: 'score', kind: 'continuous' });
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*obs_fields length.*n_obs_fields/i
    );
  });

  await t.test('categorical fields require category counts', async t => {
    const value = identityWithObsFields();
    delete value.obs_fields[0].n_categories;
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*obs_fields\[0\].*n_categories/i
    );
  });

  await t.test('continuous fields cannot carry categorical summaries', async t => {
    const value = identityWithObsFields();
    value.obs_fields[1].n_categories = 2;
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*obs_fields\[1\].*unsupported.*n_categories/i
    );
  });

  await t.test('field keys must be unique', async t => {
    const value = identityWithObsFields();
    value.obs_fields[1].key = 'batch';
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*duplicate key.*batch/i
    );
  });

  await t.test('field kinds must agree with aggregate stats', async t => {
    const value = identityWithObsFields();
    value.stats.n_categorical_fields = 2;
    value.stats.n_continuous_fields = 0;
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*obs_fields kinds.*stats/i
    );
  });
});

test('optional identity metadata is preserved only when valid', async t => {
  await t.test('valid optional metadata is preserved exactly', async t => {
    const source = sourceWithManifest(
      manifest({
        default: 'first',
        datasets: [{ id: 'first', path: 'first/' }],
      })
    );
    const value = identity('first', 'Identity', 3);
    value.created_at = '2026-07-25T00:00:00Z';
    value.export_settings = {
      compression: 6,
      var_quantization: 8,
      obs_continuous_quantization: null,
      obs_categorical_dtype: 'auto',
    };
    value.source = {
      name: 'Public source',
      url: 'https://example.test/data',
    };
    value.vector_fields = {
      default_field: 'velocity_umap',
      fields: {
        velocity_umap: {
          label: 'Velocity (UMAP)',
          basis: 'umap',
          available_dimensions: [2],
          default_dimension: 2,
          files: {
            '2d': 'vectors/velocity_umap_2d.bin',
          },
        },
      },
    };
    installIdentityFetch(t, new Map([
      [
        'https://catalog.cellucid.test/exports/first/dataset_identity.json',
        value,
      ],
    ]));

    const metadata = await source.getMetadata('first');
    assert.equal(metadata.created_at, value.created_at);
    assert.deepEqual(metadata.export_settings, value.export_settings);
    assert.deepEqual(metadata.source, value.source);
    assert.deepEqual(metadata.vector_fields, value.vector_fields);
    assert.deepEqual(metadata.embeddings, value.embeddings);
  });

  await t.test('malformed optional containers are rejected', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.source = [];
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*source.*object/i
    );
  });

  await t.test('malformed export settings are rejected', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.export_settings = [];
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*export_settings.*object/i
    );
  });

  await t.test('malformed timestamps are rejected', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.created_at = 'not-a-time';
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*created_at.*UTC timestamp/i
    );
  });
});

test('zero-valued catalog counts are assertions, not absent defaults', async t => {
  const source = sourceWithManifest(
    manifest({
      default: 'conflict',
      datasets: [{
        id: 'conflict',
        path: 'conflict/',
        n_cells: 0,
      }],
    })
  );
  installIdentityFetch(t, new Map([
    [
      'https://catalog.cellucid.test/exports/conflict/dataset_identity.json',
      identity('conflict', 'Identity', 3),
    ],
  ]));

  await assert.rejects(
    source.listDatasets(),
    /conflict.*n_cells=0.*n_cells=3/i
  );
  assert.equal(source._datasets, null);
});

test('valid current demo catalog exposes exact metadata and default', async t => {
  const source = sourceWithManifest(manifest());
  const requested = installIdentityFetch(t, new Map([
    [
      'https://catalog.cellucid.test/exports/first/dataset_identity.json',
      identity('first', 'First identity', 3),
    ],
    [
      'https://catalog.cellucid.test/exports/second/dataset_identity.json',
      identity('second', 'Second identity', 5),
    ],
  ]));

  assert.equal(await source.getDefaultDatasetId(), 'first');
  assert.deepEqual(
    (await source.listDatasets()).map(dataset => [
      dataset.id,
      dataset.name,
      dataset.stats.n_cells,
    ]),
    [
      ['first', 'First', 3],
      ['second', 'Second', 5],
    ]
  );
  assert.deepEqual(requested, [
    'https://catalog.cellucid.test/exports/first/dataset_identity.json',
    'https://catalog.cellucid.test/exports/second/dataset_identity.json',
  ]);
  assert.equal(await source.hasDataset('second'), true);
  assert.equal(await source.hasDataset('missing'), false);

  const firstMetadata = await source.getMetadata('first');
  assert.deepEqual(firstMetadata.embeddings, {
    available_dimensions: [2],
    default_dimension: 2,
    files: { '2d': 'points_2d.bin' },
  });
  assert.equal(Object.hasOwn(firstMetadata, 'created_at'), false);
  assert.equal(Object.hasOwn(firstMetadata, 'export_settings'), false);
  assert.equal(Object.hasOwn(firstMetadata, 'source'), false);
});

test('an explicit empty bootstrap never adopts a synthetic zero-point scene', async () => {
  const mainSource = await readFile(
    new URL('../assets/js/app/main.js', import.meta.url),
    'utf8'
  );
  const selectionStart = mainSource.indexOf(
    'const hasInitialDataset ='
  );
  const sceneEnd = mainSource.indexOf(
    '// One-time helper to rebuild density',
    selectionStart
  );
  assert.ok(selectionStart >= 0 && sceneEnd > selectionStart);

  const selectionBootstrap = mainSource.slice(selectionStart, sceneEnd);
  assert.match(
    selectionBootstrap,
    /await stageDatasetRuntime\(\{[\s\S]*showProgress:\s*true,[\s\S]*\}\)/
  );
  assert.match(
    selectionBootstrap,
    /catch \(error\) \{[\s\S]*completeDataLoadFailure\([\s\S]*throw error;\s*\}/
  );
  assert.doesNotMatch(
    selectionBootstrap,
    /OptionalDefault|clearActiveDataset|rejected or unconfigured optional/
  );
  assert.doesNotMatch(
    selectionBootstrap,
    /Promise\.resolve\(new Float32Array\(0\)\)|state\.initScene\(/
  );

  const uiStart = mainSource.indexOf('ui = initUI({', sceneEnd);
  const uiEnd = mainSource.indexOf('// Setup connectivity controls', uiStart);
  assert.ok(uiStart >= 0 && uiEnd > uiStart);
  assert.match(
    mainSource.slice(uiStart, uiEnd),
    /if \(hasInitialDataset\) \{\s*synchronizePublishedDatasetUi\([\s\S]*initialPublication\s*\);\s*await ui\.activateField\(-1\);\s*\}/
  );
});

test('single-dimension adoption publishes the exact selector option', t => {
  const originalDocument = globalThis.document;
  const originalHTMLElement = globalThis.HTMLElement;
  const originalHTMLSelectElement = globalThis.HTMLSelectElement;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = originalHTMLElement;
    if (originalHTMLSelectElement === undefined) {
      delete globalThis.HTMLSelectElement;
    } else {
      globalThis.HTMLSelectElement = originalHTMLSelectElement;
    }
  });

  class FakeHTMLElement {}
  class FakeHTMLSelectElement extends FakeHTMLElement {}
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.HTMLSelectElement = FakeHTMLSelectElement;

  const options = [];
  const ownerDocument = {
    createElement(tagName) {
      assert.equal(tagName, 'option');
      return {
        disabled: false,
        title: '',
        value: '',
        textContent: '',
      };
    },
  };
  globalThis.document = ownerDocument;
  const dimensionSelect = Object.assign(new FakeHTMLSelectElement(), {
    _innerHTML: '',
    value: '',
    ownerDocument,
    addEventListener() {},
    appendChild(option) {
      options.push(option);
    },
  });
  Object.defineProperty(dimensionSelect, 'innerHTML', {
    configurable: true,
    get() {
      return this._innerHTML;
    },
    set(value) {
      this._innerHTML = value;
      options.length = 0;
    },
  });

  let availableDimensions = [];
  let activeDimension = 3;
  const state = {
    getActiveViewId() {
      return 'live';
    },
    getAvailableDimensions() {
      return [...availableDimensions];
    },
    getViewDimensionLevel() {
      return activeDimension;
    },
    on() {},
    async setDimensionLevel() {},
  };
  const dimensionControls = Object.assign(new FakeHTMLElement(), {
    ownerDocument,
    style: { display: '' },
  });
  const controls = initDimensionControls({
    state,
    dom: {
      controls: dimensionControls,
      select: dimensionSelect,
    },
    callbacks: {
      onViewBadgesMaybeChanged() {},
    },
  });

  assert.equal(options.length, 0);
  assert.equal(dimensionControls.style.display, 'none');

  availableDimensions = [2];
  activeDimension = 2;
  controls.updateDimensionSelectUI();

  assert.deepEqual(
    options.map(option => ({
      value: option.value,
      text: option.textContent,
      disabled: option.disabled,
    })),
    [{ value: '2', text: '2D', disabled: false }]
  );
  assert.equal(dimensionSelect.value, '2');
  assert.equal(dimensionControls.style.display, 'none');
});

test(
  'a rejected sample catalog leaves explicit H5AD, Zarr ZIP, prepared, and server loaders usable',
  async t => {
    const originalExportsBaseUrl = DATA_CONFIG.EXPORTS_BASE_URL;
    const originalFetch = globalThis.fetch;
    const originalDocument = globalThis.document;
    const originalHistory = globalThis.history;
    const originalWindow = globalThis.window;
    const notifications = getNotificationCenter();
    const originalNotifications = {
      complete: notifications.complete,
      dismiss: notifications.dismiss,
      fail: notifications.fail,
      loading: notifications.loading,
    };
    t.after(() => {
      DATA_CONFIG.EXPORTS_BASE_URL = originalExportsBaseUrl;
      globalThis.fetch = originalFetch;
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
      if (originalHistory === undefined) delete globalThis.history;
      else globalThis.history = originalHistory;
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
      Object.assign(notifications, originalNotifications);
    });

    DATA_CONFIG.EXPORTS_BASE_URL =
      'https://catalog.cellucid.test/exports/';
    globalThis.window = {
      addEventListener() {},
      location: {
        href: 'https://catalog.cellucid.test/index.html',
        origin: 'https://catalog.cellucid.test',
        search: '',
      },
    };
    const invalidIdentity = identity(
      'rejected',
      'Rejected sample',
      3
    );
    invalidIdentity._cellucid_version_marker = 'stale';
    let invalidIdentityRequests = 0;
    globalThis.fetch = async input => {
      const url = String(input);
      if (url === 'https://catalog.cellucid.test/exports/datasets.json') {
        return new Response(JSON.stringify({
          version: 1,
          default: 'rejected',
          datasets: [{
            id: 'rejected',
            path: 'rejected/',
            name: 'Rejected sample',
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (
        url ===
        'https://catalog.cellucid.test/exports/rejected/dataset_identity.json'
      ) {
        invalidIdentityRequests++;
        return new Response(JSON.stringify(invalidIdentity), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('', { status: 404 });
    };

    const failingCatalogManager = createDataSourceManager();
    await failingCatalogManager.initialize();
    assert.equal(invalidIdentityRequests, 0);
    await assert.rejects(
      failingCatalogManager.getAllDatasets(),
      /rejected.*dataset_identity.*unsupported field.*_cellucid_version_marker/i
    );
    assert.equal(invalidIdentityRequests, 1);
    await assert.rejects(
      failingCatalogManager.getAllDatasets(),
      /rejected.*dataset_identity.*unsupported field.*_cellucid_version_marker/i
    );
    assert.equal(invalidIdentityRequests, 1);
    assert.equal(failingCatalogManager.hasActiveDataset(), false);

    const manager = createDataSourceManager();
    const localMetadata = {
      id: 'local-h5ad',
      name: 'Local H5AD',
      stats: { n_cells: 2 },
    };
    const zarrMetadata = {
      id: 'local-h5ad',
      name: 'Local Zarr ZIP',
      stats: { n_cells: 3 },
    };
    const preparedMetadata = {
      id: 'local-h5ad',
      name: 'Local prepared',
      stats: { n_cells: 4 },
    };
    let activeLocalMetadata = localMetadata;
    const localSource = {
      datasetId: 'local-h5ad',
      getBaseUrl(datasetId) {
        assert.equal(datasetId, 'local-h5ad');
        return 'h5ad://local-h5ad/';
      },
      async getMetadata(datasetId) {
        assert.equal(datasetId, 'local-h5ad');
        return activeLocalMetadata;
      },
      getIdentityId(datasetId) {
        assert.equal(datasetId, 'local-h5ad');
        return 'local-h5ad';
      },
      getType() {
        return 'local-user';
      },
      async isAvailable() {
        return false;
      },
      async listDatasets() {
        return [];
      },
      async loadFromH5adFile(file) {
        assert.equal(file?.name, 'working.h5ad');
        activeLocalMetadata = localMetadata;
        return localMetadata;
      },
      async loadFromZarrArchive(file) {
        assert.equal(file?.name, 'working.zarr.zip');
        activeLocalMetadata = zarrMetadata;
        return zarrMetadata;
      },
      async loadFromPreparedDirectory(files) {
        assert.deepEqual(
          Array.from(files, file => file.name),
          ['dataset_identity.json', 'points_2d.bin']
        );
        activeLocalMetadata = preparedMetadata;
        return preparedMetadata;
      },
    };
    manager.registerSource('local-user', localSource);

    await manager.initialize();
    assert.equal(manager.hasActiveDataset(), false);
    await assert.rejects(
      manager.getAllDatasets(),
      /rejected.*dataset_identity.*unsupported field.*_cellucid_version_marker/i
    );
    const requestsAfterCatalogRejection = invalidIdentityRequests;
    await assert.rejects(
      manager.getAllDatasets(),
      /rejected.*dataset_identity.*unsupported field.*_cellucid_version_marker/i
    );
    assert.equal(manager.hasActiveDataset(), false);
    assert.equal(manager.getCurrentDatasetId(), null);
    assert.equal(manager.getCurrentSourceType(), null);
    assert.ok(manager.getSource('local-demo'));
    assert.ok(manager.getSource('github-repo'));
    assert.equal(manager.getSource('local-user'), localSource);

    assert.equal(
      invalidIdentityRequests,
      requestsAfterCatalogRejection,
      'the rejected configured sample must not be retried and republished'
    );

    const createInput = () => {
      const listeners = new Map();
      return {
        value: '',
        listeners,
        addEventListener(type, listener) {
          listeners.set(type, listener);
        },
      };
    };
    const h5adInput = createInput();
    const zarrInput = createInput();
    const preparedInput = createInput();
    globalThis.document = { addEventListener() {} };
    globalThis.window = {
      addEventListener() {},
      innerHeight: 800,
      location: {
        href: 'https://cellucid.test/?dataset=rejected',
        search: '?dataset=rejected',
      },
    };
    globalThis.history = {
      replaceState(_state, _title, href) {
        globalThis.window.location.href = String(href);
        globalThis.window.location.search = new URL(String(href)).search;
      },
    };
    globalThis.window.history = globalThis.history;
    const notificationEvents = [];
    notifications.loading = message => {
      notificationEvents.push(['loading', message]);
      return 'local-h5ad-load';
    };
    notifications.complete = (id, message) => {
      notificationEvents.push(['complete', id, message]);
    };
    notifications.dismiss = id => {
      notificationEvents.push(['dismiss', id]);
    };
    notifications.fail = (id, message) => {
      notificationEvents.push(['fail', id, message]);
    };

    let reloadCalls = 0;
    const reloadedMetadata = [];
    initDatasetConnections({
      state: {},
      viewer: {},
      dom: {
        userDataFileInput: preparedInput,
        userDataH5adInput: h5adInput,
        userDataZarrArchiveInput: zarrInput,
      },
      dataSourceManager: manager,
      reloadDataset: async metadata => {
        reloadCalls++;
        reloadedMetadata.push(metadata);
      },
      populateDatasetDropdown() {},
      noneDatasetValue: '__none__',
    });

    await h5adInput.listeners.get('change')({
      target: {
        files: [{ name: 'working.h5ad' }],
      },
    });
    await zarrInput.listeners.get('change')({
      target: {
        files: [{ name: 'working.zarr.zip' }],
      },
    });
    await preparedInput.listeners.get('change')({
      target: {
        files: [
          { name: 'dataset_identity.json' },
          { name: 'points_2d.bin' },
        ],
      },
    });

    assert.equal(h5adInput.value, '');
    assert.equal(zarrInput.value, '');
    assert.equal(preparedInput.value, '');
    assert.equal(reloadCalls, 3);
    assert.deepEqual(
      reloadedMetadata,
      [localMetadata, zarrMetadata, preparedMetadata]
    );
    assert.equal(manager.getCurrentSourceType(), 'local-user');
    assert.equal(manager.getCurrentDatasetId(), 'local-h5ad');
    assert.deepEqual(
      notificationEvents.map(event => event[0]),
      [
        'loading',
        'complete',
        'loading',
        'complete',
        'loading',
        'complete',
      ]
    );
    assert.equal(
      new URL(globalThis.window.location.href).searchParams.has('dataset'),
      false
    );

    const remoteMetadata = {
      id: 'served',
      name: 'Server AnnData',
      stats: { n_cells: 5 },
    };
    const remoteSource = {
      connected: false,
      async connect({ url }) {
        assert.equal(url, 'http://127.0.0.1:8765');
        this.connected = true;
      },
      isConnected() {
        return this.connected;
      },
      async listDatasets() {
        return [remoteMetadata];
      },
      async getMetadata(datasetId) {
        assert.equal(datasetId, 'served');
        return remoteMetadata;
      },
      getBaseUrl(datasetId) {
        assert.equal(datasetId, 'served');
        return 'http://127.0.0.1:8765/';
      },
      getType() {
        return 'remote';
      },
    };
    manager.registerSource('remote', remoteSource);
    const remoteListeners = new Map();
    const remoteConnectBtn = {
      disabled: false,
      textContent: 'Connect',
      addEventListener(type, listener) {
        remoteListeners.set(type, listener);
      },
    };
    const remoteServerUrl = {
      disabled: false,
      value: 'http://127.0.0.1:8765',
    };
    initDatasetConnections({
      state: {},
      viewer: {},
      dom: {
        remoteConnectBtn,
        remoteServerUrl,
      },
      dataSourceManager: manager,
      reloadDataset: async metadata => {
        reloadedMetadata.push(metadata);
      },
      populateDatasetDropdown() {},
      noneDatasetValue: '__none__',
    });
    await remoteListeners.get('click')();
    assert.equal(remoteConnectBtn.disabled, false);
    assert.equal(remoteConnectBtn.textContent, 'Reconnect');
    assert.equal(manager.getCurrentSourceType(), 'remote');
    assert.equal(manager.getCurrentDatasetId(), 'served');
    assert.equal(reloadedMetadata.at(-1), remoteMetadata);
  }
);
