import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { initRepresentationControls } from '../assets/js/app/ui/modules/representation-controls.js';
import { initDatasetConnections } from '../assets/js/app/ui/modules/dataset-connections.js';
import { createTestDatasetIntents } from './helpers/dataset-intents.mjs';
import {
  DATA_CONFIG,
} from '../assets/js/data/data-source.js';
import {
  DataSourceManager,
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
    version: 3,
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
      default_dimension: 2,
      defaults: { '2d': 'X_umap' },
      items: {
        X_umap: {
          label: 'X_umap',
          dimension: 2,
          file: 'embeddings/0_2d.bin',
          source: { key: 'X_umap', columns: [0, 1] },
        },
      },
    },
    obs_fields: [],
  };
}

function embeddingItem(dimension, file, key = null) {
  return {
    label: key ?? `item ${dimension}d`,
    dimension,
    file,
    source: {
      key,
      columns: Array.from({ length: dimension }, (_, column) => column),
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
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

test('concurrent cold demo listings share one complete catalog generation', async t => {
  const originalFetch = globalThis.fetch;
  const catalogResponse = deferred();
  let catalogCalls = 0;
  let identityCalls = 0;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/datasets.json')) {
      catalogCalls += 1;
      return catalogResponse.promise;
    }
    if (url.endsWith('/first/dataset_identity.json')) {
      identityCalls += 1;
      return new Response(
        JSON.stringify(identity('first', 'First identity', 3)),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    return new Response('', { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const source = new LocalDemoDataSource(
    'https://catalog.cellucid.test/exports/'
  );
  const firstListing = source.listDatasets();
  const secondListing = source.listDatasets();
  await Promise.resolve();

  assert.equal(catalogCalls, 1);
  catalogResponse.resolve(new Response(JSON.stringify(manifest({
    datasets: [{
      id: 'first',
      path: 'first/',
      name: 'First',
    }],
  })), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));

  const [first, second] = await Promise.all([
    firstListing,
    secondListing,
  ]);
  assert.equal(first, second);
  assert.equal(first, source._datasets);
  assert.equal(source._manifest.default, 'first');
  assert.deepEqual(first.map(dataset => dataset.id), ['first']);
  assert.equal(identityCalls, 1);
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

test('demo catalog paths cannot escape or reinterpret the configured exports root', () => {
  const unsafePaths = [
    '%2e%2e/escape/',
    '%2E%2E/escape/',
    'nested/%2e%2e/escape/',
    'nested/%2Fescape/',
    'nested/%5cescape/',
    '%252e%252e/escape/',
    'nested/%252fescape/',
    'nested/%255cescape/',
    'nested/%2541/',
    'safe/?query=/',
    'safe/#fragment/',
    'safe path/',
  ];

  for (const path of unsafePaths) {
    const source = sourceWithManifest(
      manifest({
        default: 'unsafe',
        datasets: [{ id: 'unsafe', path }],
      })
    );
    assert.throws(
      () => source.getBaseUrl('unsafe'),
      /safe relative path|canonical.*directory path/i,
      path
    );
  }
});

test('demo catalog preserves canonical spaces and single-encoded Unicode', () => {
  const path =
    'cell%20atlas/%E7%BB%86%E8%83%9E/';
  const source = sourceWithManifest(
    manifest({
      default: 'encoded',
      datasets: [{
        id: 'encoded',
        path,
        name: 'Encoded',
      }],
    })
  );

  assert.equal(
    source.getBaseUrl('encoded'),
    `https://catalog.cellucid.test/exports/${path}`
  );
});

test('demo catalog opts into one exact per-dataset state manifest', () => {
  const source = sourceWithManifest(
    manifest({
      datasets: [
        {
          id: 'first',
          path: 'first/',
          name: 'First',
          state_manifest: 'state-snapshots.json',
          state_sha256: 'a'.repeat(64),
          state_bytes: 3268,
        },
        { id: 'second', path: 'second/', name: 'Second' },
      ],
    })
  );
  assert.deepEqual(
    source.getStateDescriptor('first'),
    {
      manifestUrl:
        'https://catalog.cellucid.test/exports/first/state-snapshots.json',
      stateBytes: 3268,
      stateSha256: 'a'.repeat(64),
    },
  );
  assert.equal(source.getStateDescriptor('second'), null);

  const manager = new DataSourceManager();
  manager.activeSource = source;
  manager.activeDatasetId = 'first';
  manager.activeIdentityId = 'first-generation';
  manager.activeBaseUrl = source.getBaseUrl('first');
  assert.deepEqual(
    manager.getCurrentStateDescriptor(),
    {
      baseUrl: 'https://catalog.cellucid.test/exports/first/',
      datasetId: 'first',
      identityId: 'first-generation',
      manifestUrl:
        'https://catalog.cellucid.test/exports/first/state-snapshots.json',
      selectionRevision: 0,
      sourceType: 'local-demo',
      stateBytes: 3268,
      stateSha256: 'a'.repeat(64),
    },
  );
  manager.activeDatasetId = 'second';
  manager.activeIdentityId = 'second-generation';
  manager.activeBaseUrl = source.getBaseUrl('second');
  assert.equal(manager.getCurrentStateDescriptor(), null);

  for (const [stateManifest, stateSha256, stateBytes = 3268] of [
    ['states.json', 'a'.repeat(64)],
    ['../state-snapshots.json', 'a'.repeat(64)],
    ['/state-snapshots.json', 'a'.repeat(64)],
    [' state-snapshots.json', 'a'.repeat(64)],
    ['state-snapshots.json', 'A'.repeat(64)],
    ['state-snapshots.json', 'short'],
    ['state-snapshots.json', undefined],
    [undefined, 'a'.repeat(64)],
    ['state-snapshots.json', 'a'.repeat(64), null],
    ['state-snapshots.json', 'a'.repeat(64), 0],
    ['state-snapshots.json', 'a'.repeat(64), 1.5],
  ]) {
    const entry = {
      id: 'first',
      path: 'first/',
    };
    if (stateManifest !== undefined) {
      entry.state_manifest = stateManifest;
    }
    if (stateSha256 !== undefined) {
      entry.state_sha256 = stateSha256;
    }
    if (stateBytes !== null) {
      entry.state_bytes = stateBytes;
    }
    const invalid = sourceWithManifest(
      manifest({
        datasets: [entry],
        default: 'first',
      })
    );
    assert.throws(
      () => invalid.getStateDescriptor('first'),
      /state_manifest|state_sha256|state_bytes|state-snapshots\.json|sha-256/i
    );
  }
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
        { version: 3 },
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

test('dataset identity v3 rejects every incomplete scientific summary', async t => {
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

test('dataset identity v3 requires exact embedding metadata', async t => {
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

  await t.test('version-2 embedding keys are not part of the current identity', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.embeddings.available_dimensions = [2];
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*embeddings.*unsupported field.*available_dimensions/i
    );
  });

  await t.test('embedding items must be a non-empty object', async t => {
    for (const items of [[], {}, null]) {
      const value = identity('invalid', 'Identity', 3);
      value.embeddings.items = items;
      await expectIdentityRejection(
        t,
        value,
        /dataset_identity.*embeddings\.items.*non-empty object/i
      );
    }
  });

  await t.test('embedding items must be ordered by dimension, then id', async t => {
    const byDimension = identity('invalid', 'Identity', 3);
    byDimension.embeddings = {
      default_dimension: 3,
      defaults: { '2d': 'X_umap', '3d': 'X_tsne' },
      items: {
        X_tsne: embeddingItem(3, 'embeddings/0_3d.bin'),
        X_umap: embeddingItem(2, 'embeddings/1_2d.bin', 'X_umap'),
      },
    };
    await expectIdentityRejection(
      t,
      byDimension,
      /dataset_identity.*embeddings\.items.*ordered by dimension.*code-point/i
    );

    const byId = identity('invalid', 'Identity', 3);
    byId.embeddings = {
      default_dimension: 2,
      defaults: { '2d': 'X_umap' },
      items: {
        X_umap: embeddingItem(2, 'embeddings/0_2d.bin', 'X_umap'),
        X_pca: embeddingItem(2, 'embeddings/1_2d.bin', 'X_pca'),
      },
    };
    await expectIdentityRejection(
      t,
      byId,
      /dataset_identity.*embeddings\.items.*ordered by dimension.*code-point/i
    );
  });

  await t.test('embedding items hold exactly label, dimension, file, and source', async t => {
    const extra = identity('invalid', 'Identity', 3);
    extra.embeddings.items.X_umap.basis = 'umap';
    await expectIdentityRejection(
      t,
      extra,
      /dataset_identity.*embeddings\.items\.X_umap.*unsupported field.*basis/i
    );

    const missing = identity('invalid', 'Identity', 3);
    delete missing.embeddings.items.X_umap.source;
    await expectIdentityRejection(
      t,
      missing,
      /dataset_identity.*embeddings\.items\.X_umap.*missing required field.*source/i
    );
  });

  await t.test('embedding ids and labels must be exact display text', async t => {
    const paddedId = identity('invalid', 'Identity', 3);
    paddedId.embeddings.items = {
      ' X_umap': paddedId.embeddings.items.X_umap,
    };
    paddedId.embeddings.defaults['2d'] = ' X_umap';
    await expectIdentityRejection(
      t,
      paddedId,
      /dataset_identity.*Embedding id.*cannot be displayed exactly/i
    );

    const emptyLabel = identity('invalid', 'Identity', 3);
    emptyLabel.embeddings.items.X_umap.label = '';
    await expectIdentityRejection(
      t,
      emptyLabel,
      /dataset_identity.*embeddings\.items\.X_umap\.label.*cannot be displayed exactly/i
    );
  });

  await t.test('embedding dimensions must be 1, 2, or 3', async t => {
    for (const dimension of [0, 4, 2.5, '2']) {
      const value = identity('invalid', 'Identity', 3);
      value.embeddings.items.X_umap.dimension = dimension;
      await expectIdentityRejection(
        t,
        value,
        /dataset_identity.*embeddings\.items\.X_umap\.dimension.*1, 2, or 3/i
      );
    }
  });

  await t.test('default dimension must be named in defaults', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.embeddings.default_dimension = 3;
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*default_dimension.*embeddings\.defaults/i
    );
  });

  await t.test('defaults must use exact dimensional keys, one per item dimension', async t => {
    for (const defaults of [
      { 2: 'X_umap' },
      {},
      { '2d': 'X_umap', '3d': 'X_umap' },
    ]) {
      const value = identity('invalid', 'Identity', 3);
      value.embeddings.defaults = defaults;
      await expectIdentityRejection(
        t,
        value,
        /dataset_identity.*embeddings\.defaults.*exactly one item per embedding dimension/i
      );
    }
  });

  await t.test('defaults must name an item of their own dimension', async t => {
    const unknown = identity('invalid', 'Identity', 3);
    unknown.embeddings.defaults['2d'] = 'X_missing';
    await expectIdentityRejection(
      t,
      unknown,
      /dataset_identity.*embeddings\.defaults\.2d.*item of that dimension/i
    );

    const wrongDimension = identity('invalid', 'Identity', 3);
    wrongDimension.embeddings = {
      default_dimension: 3,
      defaults: { '2d': 'X_umap', '3d': 'X_umap' },
      items: {
        X_umap: embeddingItem(2, 'embeddings/0_2d.bin', 'X_umap'),
        X_umap_3d: embeddingItem(3, 'embeddings/1_3d.bin'),
      },
    };
    await expectIdentityRejection(
      t,
      wrongDimension,
      /dataset_identity.*embeddings\.defaults\.3d.*item of that dimension/i
    );
  });

  await t.test('embedding files must be the exact producer path', async t => {
    for (const path of [
      '../points_2d.bin',
      'points_2d.bin',
      '%2e%2e/embeddings/0_2d.bin',
      'embeddings/%30_2d.bin',
      'embeddings/1_2d.bin',
      'embeddings/0_3d.bin',
      'embeddings/0_2d.bin.gz',
      'embeddings/0_2d.bin?download=1',
      'embeddings/0_2d.bin#fragment',
      './embeddings/0_2d.bin',
      'embeddings/X_umap.bin',
      ' embeddings/0_2d.bin',
    ]) {
      const value = identity('invalid', 'Identity', 3);
      value.embeddings.items.X_umap.file = path;
      await expectIdentityRejection(
        t,
        value,
        /dataset_identity.*embeddings\.items\.X_umap\.file.*exactly "embeddings\/0_2d\.bin"/i
      );
    }
  });

  await t.test('a compressed export carries .gz on every embedding path', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.export_settings = {
      compression: 6,
      var_quantization: null,
      obs_continuous_quantization: null,
      obs_categorical_dtype: 'uint8',
    };
    await expectIdentityRejection(
      t,
      value,
      /dataset_identity.*embeddings\.items\.X_umap\.file.*exactly "embeddings\/0_2d\.bin\.gz"/i
    );

    const uncompressed = identity('invalid', 'Identity', 3);
    uncompressed.export_settings = {
      compression: null,
      var_quantization: null,
      obs_continuous_quantization: null,
      obs_categorical_dtype: 'uint8',
    };
    uncompressed.embeddings.items.X_umap.file = 'embeddings/0_2d.bin.gz';
    await expectIdentityRejection(
      t,
      uncompressed,
      /dataset_identity.*embeddings\.items\.X_umap\.file.*exactly "embeddings\/0_2d\.bin"/i
    );
  });

  await t.test('embedding source holds an optional key and one distinct column per axis', async t => {
    for (const source of [
      { key: 'X_umap' },
      { key: 'X_umap', columns: [0, 1], basis: 'umap' },
      { key: '', columns: [0, 1] },
      { key: 7, columns: [0, 1] },
      { key: 'X_umap', columns: [0] },
      { key: 'X_umap', columns: [0, 0] },
      { key: 'X_umap', columns: [0, -1] },
      { key: 'X_umap', columns: [0, 1.5] },
      { key: 'X_umap', columns: null },
    ]) {
      const value = identity('invalid', 'Identity', 3);
      value.embeddings.items.X_umap.source = source;
      await expectIdentityRejection(
        t,
        value,
        /dataset_identity.*embeddings\.items\.X_umap\.source/i
      );
    }
  });

  await t.test(
    'multi-item embeddings with spaces and single-encoded Unicode ids remain exact',
    async t => {
      const value = identity('invalid', 'Identity', 3);
      value.embeddings = {
        default_dimension: 3,
        defaults: { '1d': 'pseudotime', '2d': 'cell atlas 细胞', '3d': 'X_umap_3d' },
        items: {
          pseudotime: embeddingItem(1, 'embeddings/0_1d.bin'),
          X_umap: embeddingItem(2, 'embeddings/1_2d.bin', 'X_umap'),
          'cell atlas 细胞': {
            label: 'Cell atlas 细胞',
            dimension: 2,
            file: 'embeddings/2_2d.bin',
            source: { key: 'X_atlas', columns: [3, 1] },
          },
          X_umap_3d: embeddingItem(3, 'embeddings/3_3d.bin'),
        },
      };
      const source = sourceWithManifest(
        manifest({
          default: 'invalid',
          datasets: [{
            id: 'invalid',
            path: 'invalid/',
          }],
        })
      );
      installIdentityFetch(t, new Map([
        [
          'https://catalog.cellucid.test/exports/invalid/dataset_identity.json',
          value,
        ],
      ]));

      const datasets = await source.listDatasets();
      assert.deepEqual(datasets[0].embeddings, value.embeddings);
      assert.deepEqual(
        Object.keys(datasets[0].embeddings.items),
        ['pseudotime', 'X_umap', 'cell atlas 细胞', 'X_umap_3d']
      );
    }
  );
});

test('dataset identity v3 requires exact observation summaries', async t => {
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
      obs_categorical_dtype: 'uint8',
    };
    value.source = {
      name: 'Public source',
      url: 'https://example.test/data',
    };
    value.embeddings.items.X_umap.file = 'embeddings/0_2d.bin.gz';
    value.vector_fields = {
      default_field: 'velocity',
      fields: {
        velocity: {
          label: 'velocity',
          files: {
            X_umap: 'vectors/0_0.bin.gz',
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

  await t.test('vector fields obey the exact version-3 binding rule', async t => {
    function withVectors(fields, embeddings = null) {
      const value = identity('invalid', 'Identity', 3);
      if (embeddings) value.embeddings = embeddings;
      value.vector_fields = {
        default_field: Object.keys(fields)[0],
        fields,
      };
      return value;
    }
    const twoItems = {
      default_dimension: 3,
      defaults: { '2d': 'X_umap', '3d': 'X_umap_3d' },
      items: {
        X_umap: embeddingItem(2, 'embeddings/0_2d.bin', 'X_umap'),
        X_umap_3d: embeddingItem(3, 'embeddings/1_3d.bin'),
      },
    };
    const cases = [
      [
        { velocity: { label: 'Velocity (UMAP)', files: { X_umap: 'vectors/0_0.bin' } } },
        null,
        /vector_fields\.fields\.velocity\.label.*field id "velocity" exactly/i,
      ],
      [
        {
          velocity: {
            label: 'velocity',
            basis: 'umap',
            files: { X_umap: 'vectors/0_0.bin' },
          },
        },
        null,
        /vector_fields\.fields\.velocity.*unsupported field.*basis/i,
      ],
      [
        {
          velocity: {
            label: 'velocity',
            available_dimensions: [2],
            default_dimension: 2,
            files: { X_umap: 'vectors/0_0.bin' },
          },
        },
        null,
        /vector_fields\.fields\.velocity.*unsupported field.*available_dimensions/i,
      ],
      [
        { velocity: { label: 'velocity', files: {} } },
        null,
        /vector_fields\.fields\.velocity\.files.*non-empty object/i,
      ],
      [
        { velocity: { label: 'velocity', files: { X_tsne: 'vectors/0_0.bin' } } },
        null,
        /vector_fields\.fields\.velocity\.files binds embedding "X_tsne"/i,
      ],
      [
        { velocity: { label: 'velocity', files: { '2d': 'vectors/0_0.bin' } } },
        null,
        /vector_fields\.fields\.velocity\.files binds embedding "2d"/i,
      ],
      [
        { velocity: { label: 'velocity', files: { X_umap: 'vectors/velocity_umap_2d.bin' } } },
        null,
        /vector_fields\.fields\.velocity\.files\.X_umap.*exactly "vectors\/0_0\.bin"/i,
      ],
      [
        { velocity: { label: 'velocity', files: { X_umap: 'vectors/0_0.bin.gz' } } },
        null,
        /vector_fields\.fields\.velocity\.files\.X_umap.*exactly "vectors\/0_0\.bin"/i,
      ],
      [
        {
          velocity: {
            label: 'velocity',
            files: {
              X_umap_3d: 'vectors/0_1.bin',
              X_umap: 'vectors/0_0.bin',
            },
          },
        },
        twoItems,
        /vector_fields\.fields\.velocity\.files.*embeddings\.items order/i,
      ],
      [
        {
          velocity: { label: 'velocity', files: { X_umap: 'vectors/0_0.bin' } },
          acceleration: { label: 'acceleration', files: { X_umap: 'vectors/1_0.bin' } },
        },
        null,
        /vector_fields\.fields.*ordered by id in code-point order/i,
      ],
      [
        {
          acceleration: { label: 'acceleration', files: { X_umap: 'vectors/0_0.bin' } },
          velocity: { label: 'velocity', files: { X_umap_3d: 'vectors/0_1.bin' } },
        },
        twoItems,
        /vector_fields\.fields\.velocity\.files\.X_umap_3d.*exactly "vectors\/1_1\.bin"/i,
      ],
    ];
    for (const [fields, embeddings, pattern] of cases) {
      await expectIdentityRejection(
        t,
        withVectors(fields, embeddings),
        new RegExp(`dataset_identity.*${pattern.source}`, 'i')
      );
    }

    const source = sourceWithManifest(
      manifest({
        default: 'first',
        datasets: [{ id: 'first', path: 'first/' }],
      })
    );
    const valid = withVectors({
      acceleration: { label: 'acceleration', files: { X_umap_3d: 'vectors/0_1.bin' } },
      velocity: {
        label: 'velocity',
        files: { X_umap: 'vectors/1_0.bin', X_umap_3d: 'vectors/1_1.bin' },
      },
    }, twoItems);
    valid.id = 'first';
    installIdentityFetch(t, new Map([
      [
        'https://catalog.cellucid.test/exports/first/dataset_identity.json',
        valid,
      ],
    ]));
    const metadata = await source.getMetadata('first');
    assert.deepEqual(metadata.vector_fields, valid.vector_fields);
    assert.deepEqual(metadata.embeddings, valid.embeddings);
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
    default_dimension: 2,
    defaults: { '2d': 'X_umap' },
    items: {
      X_umap: {
        label: 'X_umap',
        dimension: 2,
        file: 'embeddings/0_2d.bin',
        source: { key: 'X_umap', columns: [0, 1] },
      },
    },
  });
  assert.equal(Object.hasOwn(firstMetadata, 'created_at'), false);
  assert.equal(Object.hasOwn(firstMetadata, 'export_settings'), false);
  assert.equal(Object.hasOwn(firstMetadata, 'source'), false);
});

test('demo catalog identities are read as one batch, not one round trip each', async t => {
  const originalFetch = globalThis.fetch;
  const identityUrls = [];
  const gates = [];
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/datasets.json')) {
      return new Response(JSON.stringify(manifest()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    identityUrls.push(url);
    const id = url.includes('/first/') ? 'first' : 'second';
    const gate = deferred();
    gates.push(() => gate.resolve(
      new Response(
        JSON.stringify(identity(id, `${id} identity`, 3)),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ));
    return gate.promise;
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const source = new LocalDemoDataSource(
    'https://catalog.cellucid.test/exports/'
  );
  const listing = source.listDatasets();
  // Drain the microtask queue without advancing any clock: whatever requests a
  // batched reader intends to issue are all in flight by now. A reader that
  // awaits one identity before requesting the next would have issued exactly
  // one, and this assertion is what fails if that regresses.
  for (let turn = 0; turn < 64; turn += 1) {
    await Promise.resolve();
  }
  assert.deepEqual(identityUrls, [
    'https://catalog.cellucid.test/exports/first/dataset_identity.json',
    'https://catalog.cellucid.test/exports/second/dataset_identity.json',
  ]);

  for (const release of gates) release();
  assert.deepEqual(
    (await listing).map(dataset => dataset.id),
    ['first', 'second']
  );
});

test('a failed demo identity still names its own dataset and adopts nothing', async t => {
  const source = sourceWithManifest(manifest());
  installIdentityFetch(t, new Map([
    [
      'https://catalog.cellucid.test/exports/first/dataset_identity.json',
      identity('first', 'First identity', 3),
    ],
  ]));

  await assert.rejects(
    source.listDatasets(),
    error => (
      error.code === 'INVALID_FORMAT' &&
      error.details?.datasetId === 'second' &&
      /^Dataset 'second' is invalid: /.test(error.message)
    )
  );
  assert.equal(source._datasets, null);
  // The cached failure is the same exact error, so a second listing repeats the
  // diagnosis instead of degrading it to a bare empty catalog.
  await assert.rejects(
    source.listDatasets(),
    error => error.details?.datasetId === 'second'
  );
});

test('refresh aborts a stale sample metadata generation before it can refill caches', async t => {
  const originalFetch = globalThis.fetch;
  let phase = 'stale';
  let staleSignal = null;
  let releaseStaleIdentity;
  let markStaleIdentityStarted;
  const staleIdentityStarted = new Promise(resolve => {
    markStaleIdentityStarted = resolve;
  });
  const staleIdentityResponse = new Promise(resolve => {
    releaseStaleIdentity = resolve;
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/datasets.json')) {
      return new Response(JSON.stringify({
        version: 1,
        default: 'first',
        datasets: [{ id: 'first', path: 'first/' }],
      }), { status: 200 });
    }
    if (url.endsWith('/first/dataset_identity.json')) {
      if (phase === 'stale') {
        staleSignal = init.signal ?? null;
        markStaleIdentityStarted();
        return staleIdentityResponse;
      }
      const current = identity('first', 'Current identity', 5);
      current.description = 'Current catalog generation';
      return new Response(JSON.stringify(current), { status: 200 });
    }
    return new Response('', { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const source = new LocalDemoDataSource(
    'https://catalog.cellucid.test/exports/'
  );
  const staleLoad = source.listDatasets();
  await staleIdentityStarted;
  source.refresh();

  assert.ok(staleSignal instanceof AbortSignal);
  assert.equal(staleSignal.aborted, true);
  phase = 'current';
  releaseStaleIdentity(
    new Response(
      JSON.stringify(identity('first', 'Stale identity', 3)),
      { status: 200 }
    )
  );
  await assert.rejects(staleLoad, /abort|cancel|supersed/i);
  assert.equal(source._datasets, null);
  assert.equal(source._datasetError, null);

  const [current] = await source.listDatasets();
  assert.equal(current.description, 'Current catalog generation');
  assert.equal(current.stats.n_cells, 5);
});

test('startup publishes the empty runtime and loads its selection as one dataset change', async () => {
  const mainSource = await readFile(
    new URL('../assets/js/app/main.js', import.meta.url),
    'utf8'
  );
  const emptyStart = mainSource.indexOf(
    '// Startup publishes the empty runtime'
  );
  const emptyEnd = mainSource.indexOf(
    '// Stage one exact manager/source/runtime/URL generation',
    emptyStart
  );
  assert.ok(emptyStart >= 0 && emptyEnd > emptyStart);
  const emptyBootstrap = mainSource.slice(emptyStart, emptyEnd);
  // No startup path of its own: the empty runtime is published whatever
  // startup selected, and nothing here stages or publishes a dataset.
  assert.match(
    emptyBootstrap,
    /publishEmptyDatasetRuntime\(\{ clearViews: false \}\);/
  );
  assert.doesNotMatch(
    emptyBootstrap,
    /stageDatasetRuntime|commitDatasetRuntimeStage|hasInitialDataset|initialPublication/
  );
  assert.doesNotMatch(
    emptyBootstrap,
    /Promise\.resolve\(new Float32Array\(0\)\)|state\.initScene\(/
  );

  // The reload owns the startup load: its progress is shown, its steps are
  // deadline-bound startup steps, and its failure is logged once, by the
  // terminal startup failure it becomes.
  const reloadStart = mainSource.indexOf(
    'async function reloadActiveDatasetInPlace'
  );
  const reloadEnd = mainSource.indexOf(
    'async function clearActiveDatasetInPlace',
    reloadStart
  );
  const reloadSource = mainSource.slice(reloadStart, reloadEnd);
  assert.match(reloadSource, /showProgress: isStartupLoad,/);
  assert.match(
    reloadSource,
    /const stagePhases = isStartupLoad \? startup : RELOAD_STAGE_PHASES;/
  );
  assert.match(
    reloadSource,
    /if \(!isStartupLoad\) \{\s*console\.error\(\s*'\[Main\] Failed to reload dataset in-place:'/
  );
  assert.doesNotMatch(mainSource, /initialDataLoad/);

  // The startup selection loads only after every control and the render
  // loop exist, and before startup is published ready.
  const admission = mainSource.indexOf('admitDeferredControls();');
  const viewerStart = mainSource.indexOf('viewer.start();', admission);
  const startupLoad = mainSource.indexOf(
    'startupOutcome = await ui.loadStartupDataset(startupSelection);',
    viewerStart
  );
  const ready = mainSource.indexOf("startup.enter('ready');", startupLoad);
  assert.ok(
    admission > 0 &&
    viewerStart > admission &&
    startupLoad > viewerStart &&
    ready > startupLoad
  );
});

test('single-representation adoption publishes the exact picker option', t => {
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

  const ownerDocument = {
    createElement(tagName) {
      assert.ok(tagName === 'option' || tagName === 'optgroup', tagName);
      return {
        tagName,
        label: '',
        title: '',
        value: '',
        textContent: '',
        children: [],
        appendChild(child) {
          this.children.push(child);
        },
      };
    },
  };
  globalThis.document = ownerDocument;
  const select = Object.assign(new FakeHTMLSelectElement(), {
    groups: [],
    value: '',
    title: '',
    disabled: false,
    ownerDocument,
    addEventListener() {},
    replaceChildren(...groups) {
      this.groups = groups;
    },
  });
  const label = Object.assign(new FakeHTMLElement(), { textContent: '' });
  const controls = Object.assign(new FakeHTMLElement(), {
    ownerDocument,
    hidden: false,
  });

  let representations = [];
  let liveLayoutKey = null;
  const state = {
    getActiveViewId() {
      return 'live';
    },
    getEnabledRepresentations() {
      return representations;
    },
    getViewLayoutKey() {
      if (liveLayoutKey === null) {
        throw new RangeError('Layout state is not published for view "live".');
      }
      return liveLayoutKey;
    },
    on() {
      return () => {};
    },
    async setViewRepresentation() {},
    async cycleRepresentation() {},
  };
  const picker = initRepresentationControls({
    state,
    dom: { controls, label, select },
    callbacks: {
      viewLabel: () => null,
      onViewBadgesMaybeChanged() {},
    },
  });

  // No dataset: no representation, nothing to pick, the block hidden.
  assert.deepEqual(select.groups, []);
  assert.equal(controls.hidden, true);

  representations = [Object.freeze({
    layoutKey: 'X_umap',
    dimension: 2,
    name: 'UMAP',
    label: 'UMAP',
    ref: { key: 'X_umap', columns: null },
    isDefault: true,
  })];
  liveLayoutKey = 'X_umap';
  picker.render();

  assert.equal(controls.hidden, false);
  assert.equal(label.textContent, 'Shows');
  assert.deepEqual(
    select.groups.map(group => ({
      label: group.label,
      options: group.children.map(option => ({
        value: option.value,
        text: option.textContent,
      })),
    })),
    [{ label: '2D', options: [{ value: 'X_umap', text: 'UMAP · 2D' }] }]
  );
  assert.equal(select.value, 'X_umap');
  // One representation names what the view shows; there is nothing to switch
  // to, and the picker says where more come from.
  assert.equal(select.disabled, true);
  assert.match(select.title, /one embedding.*Data mapping/i);
  picker.destroy();
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

    const failingCatalogManager = new DataSourceManager();
    await failingCatalogManager.initialize();
    assert.equal(invalidIdentityRequests, 0);
    const firstPass = await failingCatalogManager.getAllDatasets();
    const firstDemoFailure = firstPass.find(
      entry => entry.sourceType === 'local-demo'
    );
    assert.match(
      firstDemoFailure.error.message,
      /rejected.*dataset_identity.*unsupported field.*_cellucid_version_marker/i
    );
    assert.deepEqual(firstDemoFailure.datasets, []);
    assert.equal(invalidIdentityRequests, 1);
    const secondPass = await failingCatalogManager.getAllDatasets();
    assert.equal(
      secondPass.find(entry => entry.sourceType === 'local-demo').error,
      firstDemoFailure.error,
      'the rejected catalog must be republished from cache, never re-fetched'
    );
    assert.equal(invalidIdentityRequests, 1);
    assert.equal(failingCatalogManager.hasActiveDataset(), false);

    const localMetadata = identity('local-user', 'Local H5AD', 2);
    const zarrMetadata = identity(
      'local-user',
      'Local Zarr ZIP',
      3
    );
    const preparedMetadata = identity(
      'local-user',
      'Local prepared',
      4
    );
    const localCandidates = [];

    function createLocalCandidate() {
      let activeMetadata = null;
      const candidate = {
        datasetId: 'local-user',
        disconnectCalls: 0,
        createSelectionCandidate: createLocalCandidate,
        disconnect() {
          this.disconnectCalls++;
        },
        getBaseUrl(datasetId) {
          assert.equal(datasetId, 'local-user');
          return 'local-user://selection/';
        },
        async getMetadata(datasetId) {
          assert.equal(datasetId, 'local-user');
          assert.ok(activeMetadata);
          return activeMetadata;
        },
        getIdentityId(datasetId) {
          assert.equal(datasetId, 'local-user');
          return 'local-user';
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
          activeMetadata = localMetadata;
          return activeMetadata;
        },
        async loadFromPreparedDirectory(files) {
          assert.deepEqual(
            Array.from(files, file => file.name),
            ['dataset_identity.json', '0_2d.bin']
          );
          activeMetadata = preparedMetadata;
          return activeMetadata;
        },
        async loadFromZarrArchive(file) {
          assert.equal(file?.name, 'working.zarr.zip');
          activeMetadata = zarrMetadata;
          return activeMetadata;
        },
      };
      localCandidates.push(candidate);
      return candidate;
    }

    const manager = new DataSourceManager();
    const localSource = createLocalCandidate();
    manager.registerSource('local-user', localSource);
    await manager.initialize();
    assert.equal(manager.hasActiveDataset(), false);

    // A rejected sample catalog is that catalog's failure. Enumerating sources
    // still succeeds, so every explicit local loader below stays reachable.
    const catalogPass = await manager.getAllDatasets();
    const rejectedEntry = catalogPass.find(
      entry => entry.sourceType === 'local-demo'
    );
    assert.match(
      rejectedEntry.error.message,
      /rejected.*dataset_identity.*unsupported field.*_cellucid_version_marker/i
    );
    const rejectedCatalogError = rejectedEntry.error;
    assert.equal(
      catalogPass.some(entry => entry.sourceType === 'local-user'),
      false,
      'an unavailable local source stays omitted rather than reported failed'
    );
    const requestsAfterCatalogRejection = invalidIdentityRequests;
    assert.equal(
      (await manager.getAllDatasets()).find(
        entry => entry.sourceType === 'local-demo'
      ).error,
      rejectedCatalogError
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

    const createButton = () => {
      const listeners = new Map();
      return {
        disabled: false,
        listeners,
        textContent: '',
        addEventListener(type, listener) {
          listeners.set(type, listener);
        },
      };
    };
    const createInput = (value = '') => {
      const listeners = new Map();
      return {
        disabled: false,
        listeners,
        value,
        addEventListener(type, listener) {
          listeners.set(type, listener);
        },
        click() {},
      };
    };
    const select = {
      disabled: true,
      focusCalls: 0,
      focus() {
        this.focusCalls++;
      },
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
    const notificationEvents = [];
    notifications.loading = message => {
      const id = `dataset-load-${notificationEvents.length}`;
      notificationEvents.push(['loading', id, message]);
      return id;
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

    const activatedMetadata = [];
    const activateDataset = async (
      datasetId,
      sourceType,
      loadMethod,
      source
    ) => {
      const stage = await manager.stageDatasetSelection(
        sourceType,
        datasetId,
        { loadMethod, source }
      );
      const publication = manager.commitDatasetSelection(stage);
      manager.publishDatasetSelection(publication);
      manager.finalizeDatasetSelection(publication);
      activatedMetadata.push(stage.metadata);
      return true;
    };
    const failedCatalogOutcome = async () => Object.freeze({
      error: rejectedCatalogError,
      status: 'failed',
    });

    const datasetIntents = createTestDatasetIntents(activateDataset);

    initDatasetConnections({
      datasetIntents,
      clearDataset: async () => true,
      dataSourceManager: manager,
      dom: {
        select,
        userDataBrowseBtn: createButton(),
        userDataFileInput: preparedInput,
        userDataH5adBtn: createButton(),
        userDataH5adInput: h5adInput,
        userDataZarrArchiveBtn: createButton(),
        userDataZarrArchiveInput: zarrInput,
      },
      noneDatasetValue: '__none__',
      populateDatasetDropdown: failedCatalogOutcome,
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
          { name: '0_2d.bin' },
        ],
      },
    });

    assert.equal(h5adInput.value, '');
    assert.equal(zarrInput.value, '');
    assert.equal(preparedInput.value, '');
    assert.deepEqual(
      activatedMetadata,
      [localMetadata, zarrMetadata, preparedMetadata]
    );
    assert.equal(localCandidates.length, 4);
    assert.equal(manager.getCurrentSourceType(), 'local-user');
    assert.equal(manager.getCurrentDatasetId(), 'local-user');
    assert.deepEqual(
      notificationEvents.map(event => event[0]),
      ['loading', 'fail', 'loading', 'fail', 'loading', 'fail']
    );

    const remoteMetadata = identity(
      'served',
      'Server AnnData',
      5
    );
    const remoteCandidates = [];
    function createRemoteCandidate() {
      const candidate = {
        connected: false,
        disconnectCalls: 0,
        async connect({ url }) {
          assert.equal(url, 'http://127.0.0.1:8765');
          this.connected = true;
        },
        createConnectionCandidate: createRemoteCandidate,
        disconnect() {
          this.connected = false;
          this.disconnectCalls++;
        },
        getBaseUrl(datasetId) {
          assert.equal(datasetId, 'served');
          return 'http://127.0.0.1:8765/';
        },
        getConnectionInfo() {
          return {
            status: this.connected ? 'connected' : 'disconnected',
            url: this.connected ? 'http://127.0.0.1:8765' : null,
          };
        },
        async getMetadata(datasetId) {
          assert.equal(datasetId, 'served');
          return remoteMetadata;
        },
        getType() {
          return 'remote';
        },
        async listDatasets() {
          assert.equal(this.connected, true);
          return [remoteMetadata];
        },
        onConnectionLost() {},
      };
      remoteCandidates.push(candidate);
      return candidate;
    }
    const remoteSource = createRemoteCandidate();
    manager.registerSource('remote', remoteSource);
    const remoteConnectBtn = createButton();
    const remoteServerUrl = createInput(
      'http://127.0.0.1:8765'
    );
    initDatasetConnections({
      datasetIntents,
      clearDataset: async () => true,
      dataSourceManager: manager,
      dom: {
        remoteConnectBtn,
        remoteDisconnectBtn: createButton(),
        remoteDisconnectContainer: { style: {} },
        remoteServerUrl,
        select,
      },
      noneDatasetValue: '__none__',
      populateDatasetDropdown: failedCatalogOutcome,
    });
    await remoteConnectBtn.listeners.get('click')();
    assert.equal(remoteConnectBtn.disabled, false);
    assert.equal(remoteConnectBtn.textContent, 'Reconnect');
    assert.equal(manager.getCurrentSourceType(), 'remote');
    assert.equal(manager.getCurrentDatasetId(), 'served');
    assert.equal(activatedMetadata.at(-1), remoteMetadata);
    assert.equal(remoteCandidates.length, 2);
    assert.deepEqual(
      notificationEvents.map(event => event[0]),
      [
        'loading',
        'fail',
        'loading',
        'fail',
        'loading',
        'fail',
        'loading',
        'fail',
      ]
    );
  }
);
