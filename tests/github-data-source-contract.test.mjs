import assert from 'node:assert/strict';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import {
  GitHubDataSource,
  parseGitHubPath,
} from '../assets/js/data/github-data-source.js';

function manifest(overrides = {}) {
  return {
    version: 1,
    default: 'first',
    datasets: [
      {
        id: 'first',
        path: 'first/',
        name: 'First identity',
        description: 'First description',
        n_cells: 3,
        n_genes: 2,
      },
    ],
    ...overrides,
  };
}

function identity(
  id,
  {
    name = `${id} identity`,
    description = `${id} description`,
    nCells = 3,
    nGenes = 2,
  } = {}
) {
  return {
    version: 2,
    id,
    name,
    description,
    cellucid_data_version: 'test-current',
    stats: {
      n_cells: nCells,
      n_genes: nGenes,
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

function jsonResponse(value, status = 200) {
  return new Response(
    status === 204 ? null : JSON.stringify(value),
    {
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

function installFetch(t, implementation) {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async input => {
    const url = String(input);
    requested.push(url);
    return implementation(url, requested.length);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return requested;
}

function silenceNotifications(t) {
  const notifications = getNotificationCenter();
  const original = {
    loading: notifications.loading,
    complete: notifications.complete,
    fail: notifications.fail,
  };
  notifications.loading = () => 'github-contract-test';
  notifications.complete = () => {};
  notifications.fail = () => {};
  t.after(() => {
    notifications.loading = original.loading;
    notifications.complete = original.complete;
    notifications.fail = original.fail;
  });
}

function installSingleDatasetRepository(
  t,
  {
    input = 'owner/repo/exports',
    catalog = manifest(),
    datasetIdentity = identity('first', {
      name: 'First identity',
      description: 'First description',
    }),
  } = {}
) {
  silenceNotifications(t);
  const requested = installFetch(t, url => {
    if (url.endsWith('/datasets.json')) {
      return jsonResponse(catalog);
    }
    if (url.endsWith('/dataset_identity.json')) {
      return jsonResponse(datasetIdentity);
    }
    return jsonResponse({}, 404);
  });
  const source = new GitHubDataSource();
  return { source, input, requested };
}

test('GitHub repository inputs select one deterministic branch and path', () => {
  assert.deepEqual(
    parseGitHubPath('owner/repo/exports'),
    {
      owner: 'owner',
      repo: 'repo',
      branch: 'main',
      path: 'exports',
    }
  );
  assert.deepEqual(
    parseGitHubPath('owner/repo@release/exports/nested'),
    {
      owner: 'owner',
      repo: 'repo',
      branch: 'release',
      path: 'exports/nested',
    }
  );
  assert.deepEqual(
    parseGitHubPath(
      'https://github.com/owner/repo/tree/release/exports'
    ),
    {
      owner: 'owner',
      repo: 'repo',
      branch: 'release',
      path: 'exports',
    }
  );
  assert.deepEqual(
    parseGitHubPath(
      'https://raw.githubusercontent.com/owner/repo/release/exports/'
    ),
    {
      owner: 'owner',
      repo: 'repo',
      branch: 'release',
      path: 'exports',
    }
  );

  assert.equal(
    parseGitHubPath('https://example.test/owner/repo/exports'),
    null
  );
  assert.equal(
    parseGitHubPath(
      'https://github.com/owner/repo/blob/release/exports/datasets.json'
    ),
    null
  );
  assert.equal(parseGitHubPath('owner/repo@../exports'), null);
});

test('GitHub connect never probes branches or reinterprets path segments', async t => {
  silenceNotifications(t);
  const requested = installFetch(
    t,
    () => jsonResponse({}, 404)
  );
  const source = new GitHubDataSource();

  await assert.rejects(
    source.connect('owner/repo/master/exports'),
    /datasets\.json|resource not found/i
  );
  assert.deepEqual(requested, [
    'https://raw.githubusercontent.com/owner/repo/main/master/exports/datasets.json',
  ]);
});

test('GitHub datasets.json requires one exact catalog shape', async t => {
  const cases = [
    [
      'unknown top-level field',
      manifest({ generated_at: 'now' }),
      /unsupported field.*generated_at|generated_at.*unsupported/i,
    ],
    [
      'unknown entry field',
      manifest({
        datasets: [{
          id: 'first',
          path: 'first/',
          label: 'legacy',
        }],
      }),
      /dataset.*unsupported field.*label|label.*unsupported/i,
    ],
    [
      'missing explicit default',
      manifest({ default: undefined }),
      /missing required field.*default|explicit default.*required/i,
    ],
    [
      'default absent from datasets',
      manifest({ default: 'absent' }),
      /default.*absent.*not present|unknown.*default/i,
    ],
    [
      'duplicate dataset id',
      manifest({
        datasets: [
          { id: 'same', path: 'first/' },
          { id: 'same', path: 'second/' },
        ],
        default: 'same',
      }),
      /unique.*id|duplicate.*id/i,
    ],
    [
      'duplicate dataset path',
      manifest({
        datasets: [
          { id: 'first', path: 'same/' },
          { id: 'second', path: 'same/' },
        ],
      }),
      /unique.*path|reuses path|duplicate.*path/i,
    ],
    [
      'encoded duplicate dataset path',
      manifest({
        datasets: [
          { id: 'first', path: 'same/' },
          { id: 'second', path: '%73ame/' },
        ],
      }),
      /unique.*path|reuses path|duplicate.*path/i,
    ],
    [
      'catalog is missing datasets',
      { version: 1, default: 'first' },
      /missing required field.*datasets/i,
    ],
    [
      'catalog datasets are empty',
      manifest({ datasets: [] }),
      /datasets.*non-empty array/i,
    ],
    [
      'dataset entry is not an object',
      manifest({ datasets: [null] }),
      /dataset entry 0.*object/i,
    ],
    [
      'dataset entry is missing path',
      manifest({ datasets: [{ id: 'first' }] }),
      /dataset entry 0.*missing required field.*path/i,
    ],
    [
      'malformed optional catalog value',
      manifest({
        datasets: [{
          id: 'first',
          path: 'first/',
          description: 7,
        }],
      }),
      /first.*description|description.*string/i,
    ],
    [
      'malformed optional name',
      manifest({
        datasets: [{
          id: 'first',
          path: 'first/',
          name: '',
        }],
      }),
      /first.*name.*non-empty string/i,
    ],
    [
      'malformed optional count',
      manifest({
        datasets: [{
          id: 'first',
          path: 'first/',
          n_cells: -1,
        }],
      }),
      /first.*n_cells.*non-negative safe integer/i,
    ],
  ];

  for (const [name, catalog, pattern] of cases) {
    await t.test(name, async t => {
      const { source, input, requested } =
        installSingleDatasetRepository(t, { catalog });
      await assert.rejects(source.connect(input), pattern);
      assert.deepEqual(
        requested,
        [
          'https://raw.githubusercontent.com/owner/repo/main/exports/datasets.json',
        ],
        'catalog validation must finish before identity loading begins'
      );
      assert.equal(await source.isAvailable(), false);
    });
  }
});

test('GitHub catalog paths must be safe relative directories', async t => {
  const unsafePaths = [
    '',
    'dataset',
    '/absolute/',
    '../escape/',
    './dataset/',
    'nested//dataset/',
    'C:/dataset/',
    'https://example.test/dataset/',
    'nested/%2e%2e/escape/',
    'nested/%2Fescape/',
    'nested\\dataset/',
    'nested/?query/',
    'nested/#fragment/',
  ];

  for (const path of unsafePaths) {
    await t.test(JSON.stringify(path), async t => {
      const catalog = manifest({
        datasets: [{ id: 'first', path }],
      });
      const { source, input, requested } =
        installSingleDatasetRepository(t, { catalog });
      await assert.rejects(
        source.connect(input),
        /safe relative directory|relative directory.*ending/i
      );
      assert.deepEqual(requested, [
        'https://raw.githubusercontent.com/owner/repo/main/exports/datasets.json',
      ]);
    });
  }
});

test('GitHub catalog adoption rejects every dataset when one identity fails', async t => {
  silenceNotifications(t);
  const catalog = manifest({
    datasets: [
      { id: 'first', path: 'first/' },
      { id: 'second', path: 'second/' },
    ],
  });
  const requested = installFetch(t, url => {
    if (url.endsWith('/datasets.json')) {
      return jsonResponse(catalog);
    }
    if (url.endsWith('/first/dataset_identity.json')) {
      return jsonResponse(identity('first'));
    }
    return jsonResponse({}, 404);
  });
  const source = new GitHubDataSource();

  await assert.rejects(
    source.connect('owner/repo/exports'),
    /second.*dataset_identity|dataset_identity.*second/i
  );
  assert.equal(await source.isAvailable(), false);
  assert.deepEqual(await source.listDatasets(), []);
  assert.deepEqual(requested, [
    'https://raw.githubusercontent.com/owner/repo/main/exports/datasets.json',
    'https://raw.githubusercontent.com/owner/repo/main/exports/first/dataset_identity.json',
    'https://raw.githubusercontent.com/owner/repo/main/exports/second/dataset_identity.json',
  ]);
});

test('GitHub catalog duplicates are assertions, never identity repairs', async t => {
  const canonical = identity('first', {
    name: 'Canonical identity name',
    description: 'Canonical identity description',
    nCells: 3,
    nGenes: 2,
  });
  const contradictions = [
    ['name', 'Catalog repair name'],
    ['description', 'Catalog repair description'],
    ['n_cells', 99],
    ['n_genes', 77],
  ];

  for (const [key, value] of contradictions) {
    await t.test(`${key} contradiction rejects`, async t => {
      const catalog = manifest({
        datasets: [{
          id: 'first',
          path: 'first/',
          [key]: value,
        }],
      });
      const { source, input } = installSingleDatasetRepository(t, {
        catalog,
        datasetIdentity: canonical,
      });

      await assert.rejects(
        source.connect(input),
        new RegExp(
          `catalog.*${key}.*does not match|${key}.*contradict`,
          'i'
        )
      );
      assert.equal(await source.isAvailable(), false);
    });
  }

  await t.test('matching duplicate assertions preserve identity metadata', async t => {
    const catalog = manifest({
      datasets: [{
        id: 'first',
        path: 'first/',
        name: canonical.name,
        description: canonical.description,
        n_cells: canonical.stats.n_cells,
        n_genes: canonical.stats.n_genes,
      }],
    });
    const { source, input } = installSingleDatasetRepository(t, {
      catalog,
      datasetIdentity: canonical,
    });

    const { datasets } = await source.connect(input);
    assert.equal(datasets.length, 1);
    assert.equal(datasets[0].name, canonical.name);
    assert.equal(datasets[0].description, canonical.description);
    assert.deepEqual(datasets[0].stats, canonical.stats);
  });
});

test('GitHub getBaseUrl resolves only catalog-owned dataset ids', async t => {
  const { source, input } = installSingleDatasetRepository(t);
  await source.connect(input);

  assert.equal(
    source.getBaseUrl('first'),
    'https://raw.githubusercontent.com/owner/repo/main/exports/first/'
  );
  assert.equal(source._activeDatasetId, 'first');
  assert.throws(
    () => source.getBaseUrl('absent'),
    /absent.*not found.*datasets\.json|dataset.*absent.*not found/i
  );
  assert.equal(source._activeDatasetId, 'first');
});

test('a failed GitHub reconnect preserves the adopted repository', async t => {
  silenceNotifications(t);
  const requested = installFetch(t, url => {
    if (
      url ===
      'https://raw.githubusercontent.com/owner/repo/main/exports/datasets.json'
    ) {
      return jsonResponse(manifest());
    }
    if (
      url ===
      'https://raw.githubusercontent.com/owner/repo/main/exports/first/dataset_identity.json'
    ) {
      return jsonResponse(identity('first', {
        name: 'First identity',
        description: 'First description',
      }));
    }
    return jsonResponse({}, 404);
  });
  const source = new GitHubDataSource();
  await source.connect('owner/repo/exports');
  const originalInfo = source.getConnectionInfo();
  const originalManifest = source._manifest;
  const originalDatasets = source._datasets;

  await assert.rejects(
    source.connect('other/repository/exports'),
    /datasets\.json|resource not found/i
  );
  assert.equal(await source.isAvailable(), true);
  assert.deepEqual(source.getConnectionInfo(), originalInfo);
  assert.equal(source._manifest, originalManifest);
  assert.equal(source._datasets, originalDatasets);
  assert.deepEqual(requested.slice(-1), [
    'https://raw.githubusercontent.com/other/repository/main/exports/datasets.json',
  ]);
});

test('GitHub refresh stages and validates a complete generation before swap', async t => {
  silenceNotifications(t);
  let phase = 'initial';
  const initialManifest = manifest();
  const candidateManifest = manifest({
    default: 'new',
    datasets: [
      { id: 'new', path: 'new/' },
      { id: 'broken', path: 'broken/' },
    ],
  });
  const refreshedManifest = manifest({
    default: 'new',
    datasets: [{ id: 'new', path: 'new/' }],
  });
  installFetch(t, url => {
    if (url.endsWith('/datasets.json')) {
      const value = phase === 'initial'
        ? initialManifest
        : phase === 'broken'
          ? candidateManifest
          : refreshedManifest;
      return jsonResponse(value);
    }
    if (url.endsWith('/first/dataset_identity.json')) {
      return jsonResponse(identity('first', {
        name: 'First identity',
        description: 'First description',
      }));
    }
    if (url.endsWith('/new/dataset_identity.json')) {
      return jsonResponse(identity('new'));
    }
    return jsonResponse({}, 404);
  });

  const source = new GitHubDataSource();
  await source.connect('owner/repo/exports');
  const originalManifest = source._manifest;
  const originalDatasets = source._datasets;

  phase = 'broken';
  await assert.rejects(
    source.refresh(),
    /broken.*dataset_identity|dataset_identity.*broken/i
  );
  assert.equal(source._manifest, originalManifest);
  assert.equal(source._datasets, originalDatasets);
  assert.equal((await source.getMetadata('first')).id, 'first');

  phase = 'refreshed';
  await source.refresh();
  assert.notEqual(source._manifest, originalManifest);
  assert.notEqual(source._datasets, originalDatasets);
  assert.deepEqual(
    (await source.listDatasets()).map(dataset => dataset.id),
    ['new']
  );
  assert.throws(
    () => source.getBaseUrl('first'),
    /first.*not found.*datasets\.json|dataset.*first.*not found/i
  );
});

test('an in-flight GitHub refresh cannot overwrite a replacement connection', async t => {
  silenceNotifications(t);
  const initialManifest = manifest();
  const replacementManifest = manifest({
    default: 'replacement',
    datasets: [{
      id: 'replacement',
      path: 'replacement/',
    }],
  });
  const staleManifest = manifest({
    default: 'stale',
    datasets: [{ id: 'stale', path: 'stale/' }],
  });
  let phase = 'initial';
  let resolveRefreshManifest;
  const refreshManifestStarted = new Promise(resolve => {
    resolveRefreshManifest = response => {
      resolve(response);
    };
  });
  let releaseRefreshManifest;
  installFetch(t, url => {
    if (url.endsWith('/datasets.json')) {
      if (phase === 'refresh') {
        return new Promise(resolve => {
          releaseRefreshManifest = resolve;
          resolveRefreshManifest();
        });
      }
      return jsonResponse(
        phase === 'initial'
          ? initialManifest
          : replacementManifest
      );
    }
    if (url.endsWith('/first/dataset_identity.json')) {
      return jsonResponse(identity('first', {
        name: 'First identity',
        description: 'First description',
      }));
    }
    if (url.endsWith('/replacement/dataset_identity.json')) {
      return jsonResponse(identity('replacement'));
    }
    if (url.endsWith('/stale/dataset_identity.json')) {
      return jsonResponse(identity('stale'));
    }
    return jsonResponse({}, 404);
  });

  const source = new GitHubDataSource();
  await source.connect('owner/repo/exports');

  phase = 'refresh';
  const pendingRefresh = source.refresh();
  await refreshManifestStarted;

  source.disconnect();
  phase = 'replacement';
  await source.connect('owner/repo/exports');
  releaseRefreshManifest(jsonResponse(staleManifest));

  await assert.rejects(
    pendingRefresh,
    /connection changed during refresh/i
  );
  assert.deepEqual(
    (await source.listDatasets()).map(dataset => dataset.id),
    ['replacement']
  );
  assert.equal(
    source.getBaseUrl('replacement'),
    'https://raw.githubusercontent.com/owner/repo/main/exports/replacement/'
  );
});
