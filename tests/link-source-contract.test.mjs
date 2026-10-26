/**
 * Every dataset opened from a link (`LinkDataSource`): one AnnData file, a
 * Zarr store folder, or a dataset catalog folder (`datasets.json` and the
 * AnnData files it lists), opened as a complete candidate before the open
 * link is replaced.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { DataSourceManager } from '../assets/js/data/data-source-manager.js';
import { LinkDataSource } from '../assets/js/data/link-source.js';
import { parseGitHubPath } from '../assets/js/data/sources/providers/github.js';
import { serveFixtureHost } from './helpers/fixture-web-host.mjs';

const GITHUB = 'https://raw.githubusercontent.com/owner/repo/HEAD/exports/';
const WEB = 'https://data.example.org/anndata/';
const FIXTURES = new URL('./fixtures/cellucid-ready/', import.meta.url);
const SESSION_SHA = 'c'.repeat(64);

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
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requested.push(url);
    return implementation(url, requested.length, init);
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
  notifications.loading = () => 'link-contract-test';
  notifications.complete = () => {};
  notifications.fail = () => {};
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  t.after(() => {
    notifications.loading = original.loading;
    notifications.complete = original.complete;
    notifications.fail = original.fail;
    console.log = log;
    console.warn = warn;
  });
}

function catalog(datasets = [{ id: 'tiny-ready', path: 'ready.zarr/' }]) {
  return { schema: 2, default: datasets[0].id, datasets };
}

function serveCatalog(t, prefix, value = catalog()) {
  return serveFixtureHost(t, {
    prefix,
    root: FIXTURES,
    files: new Map([['datasets.json', JSON.stringify(value)]]),
  });
}

test('GitHub repository inputs select one deterministic branch and path', () => {
  // Without @branch: HEAD, the repository's default branch as GitHub's
  // content hosts resolve it, with no request.
  assert.deepEqual(
    parseGitHubPath('owner/repo/exports'),
    {
      owner: 'owner',
      repo: 'repo',
      branch: 'HEAD',
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
  assert.deepEqual(
    parseGitHubPath(
      'owner/repo/cell%20atlas/%E7%BB%86%E8%83%9E'
    ),
    {
      owner: 'owner',
      repo: 'repo',
      branch: 'HEAD',
      path: 'cell atlas/细胞',
    }
  );

  assert.equal(
    parseGitHubPath('https://example.test/owner/repo/exports'),
    null
  );
  // A link to a catalog's datasets.json opens its folder.
  assert.deepEqual(
    parseGitHubPath(
      'https://github.com/owner/repo/blob/release/exports/datasets.json'
    ),
    { owner: 'owner', repo: 'repo', branch: 'release', path: 'exports' }
  );
  assert.equal(parseGitHubPath('owner/repo@../exports'), null);
  for (const nestedEncoding of [
    'owner/repo/%252e%252e/escape',
    'owner/repo/nested/%252fescape',
    'owner/repo/nested/%255cescape',
    'owner/repo/nested/%2541',
    'https://github.com/owner/repo/tree/main/%252e%252e/escape',
  ]) {
    assert.equal(
      parseGitHubPath(nestedEncoding),
      null,
      nestedEncoding,
    );
  }
});

test('GitHub connect never probes branches or reinterprets path segments', async t => {
  silenceNotifications(t);
  const requested = installFetch(
    t,
    () => jsonResponse({}, 404)
  );
  const source = new LinkDataSource();

  await assert.rejects(
    source.connect('owner/repo/master/exports'),
    /holds no datasets\.json/i
  );
  assert.deepEqual(requested, [
    'https://raw.githubusercontent.com/owner/repo/HEAD/master/exports/datasets.json',
  ]);
});

test('a linked catalog lists its files from their metadata and opens the one chosen', async t => {
  silenceNotifications(t);
  serveCatalog(t, GITHUB, catalog([{
    id: 'tiny-ready',
    path: 'ready.zarr/',
    session: { path: 'tiny-ready.cellucid-session', bytes: 9, sha256: SESSION_SHA },
  }]));
  const source = new LinkDataSource();
  const connection = await source.connect('owner/repo/exports');
  assert.equal(connection.defaultDatasetId, 'tiny-ready');
  assert.deepEqual(connection.datasets, [{
    id: 'tiny-ready',
    name: 'Tiny ready dataset',
    description: 'Six cells written for the Cellucid web contract tests.',
    stats: { n_cells: 6, n_genes: 3 },
  }]);
  assert.equal(await source.isAvailable(), true);
  assert.equal(source.getConnectionInfo().baseUrl, GITHUB);
  assert.equal(source.getAnnDataSource('tiny-ready'), null, 'listing opens nothing');
  assert.throws(() => source.getBaseUrl('tiny-ready'), /is not open/);
  const metadata = await source.getMetadata('tiny-ready');
  assert.equal(metadata.name, 'Tiny ready dataset');
  assert.equal(source.getBaseUrl('tiny-ready'), 'anndata://tiny-ready/');
  assert.equal(source.getAnnDataSource('tiny-ready').getType(), 'anndata');
  assert.equal(source.getAnnDataSource('tiny-ready').format, 'zarr');
  assert.deepEqual(source.getStateDescriptor('tiny-ready'), {
    sessionUrl: `${GITHUB}tiny-ready.cellucid-session`,
    sessionBytes: 9,
    sessionSha256: SESSION_SHA,
  });
  await assert.rejects(source.getMetadata('other'), /not found/);
  source.disconnect();
  assert.equal(await source.isAvailable(), false);
  assert.equal(source.getAnnDataSource('tiny-ready'), null);
});

test('a linked catalog without a schema is refused with what a catalog must hold', async t => {
  silenceNotifications(t);
  installFetch(t, url => (url.endsWith('/datasets.json')
    ? jsonResponse({ default: 'first', datasets: [{ id: 'first', path: 'first.h5ad' }] })
    : jsonResponse({}, 404)));
  const source = new LinkDataSource();
  await assert.rejects(source.connect('owner/repo/catalog'), /the catalog must contain exactly: datasets, default, schema \(missing: schema\)/);
  assert.equal(await source.isAvailable(), false);
});

test('one linked file is its dataset, under the id it states', async t => {
  silenceNotifications(t);
  serveFixtureHost(t, { prefix: WEB, root: FIXTURES });
  const source = new LinkDataSource();
  const connection = await source.connect(`${WEB}ready.h5ad`);
  assert.equal(connection.defaultDatasetId, 'tiny-ready');
  assert.equal(connection.datasets[0].id, 'tiny-ready', 'uns[\'cellucid\'][\'id\'] over the link\'s id');
  assert.equal(connection.datasets[0].name, 'Tiny ready dataset');
  assert.equal(source.getBaseUrl('tiny-ready'), 'anndata://tiny-ready/');
  assert.equal(source.getStateDescriptor('tiny-ready'), null, 'one file names no default view');
  source.disconnect();
});

test('a linked Zarr store folder and a zipped one open in place', async t => {
  silenceNotifications(t);
  serveFixtureHost(t, { prefix: WEB, root: FIXTURES });
  for (const path of ['ready.zarr/', 'ready.zarr.zip']) {
    const source = new LinkDataSource();
    const connection = await source.connect(`${WEB}${path}`);
    assert.equal(connection.datasets[0].id, 'tiny-ready', path);
    assert.equal(source.getBaseUrl('tiny-ready'), 'anndata://tiny-ready/', path);
    source.disconnect();
  }
});

test('a failed reconnect preserves the adopted link', async t => {
  silenceNotifications(t);
  serveCatalog(t, GITHUB);
  const source = new LinkDataSource();
  await source.connect('owner/repo/exports');
  const originalInfo = source.getConnectionInfo();
  const originalDatasets = await source.listDatasets();
  await assert.rejects(
    source.connect('other/repository/exports'),
    /datasets\.json/i
  );
  assert.equal(await source.isAvailable(), true);
  assert.deepEqual(source.getConnectionInfo(), originalInfo);
  assert.strictEqual(await source.listDatasets(), originalDatasets);
});

test('disconnect aborts an in-flight link before it can adopt', async t => {
  silenceNotifications(t);
  let catalogSignal = null;
  let releaseCatalog;
  let markCatalogStarted;
  const catalogStarted = new Promise(resolve => {
    markCatalogStarted = resolve;
  });
  const catalogResponse = new Promise(resolve => {
    releaseCatalog = resolve;
  });
  installFetch(t, (url, _count, init = {}) => {
    if (url.endsWith('/datasets.json')) {
      catalogSignal = init.signal ?? null;
      markCatalogStarted();
      return catalogResponse;
    }
    return jsonResponse({}, 404);
  });
  const source = new LinkDataSource();
  const pendingConnect = source.connect('owner/repo/exports');
  await catalogStarted;
  source.disconnect();
  assert.ok(catalogSignal instanceof AbortSignal);
  assert.equal(catalogSignal.aborted, true);
  releaseCatalog(jsonResponse(catalog()));
  await assert.rejects(pendingConnect, /abort|cancel|supersed/i);
  assert.equal(await source.isAvailable(), false);
  assert.deepEqual(await source.listDatasets(), []);
});

test('a refresh reads the linked catalog again; the dataset shown stays readable', async t => {
  silenceNotifications(t);
  const host = serveCatalog(t, GITHUB);
  const source = new LinkDataSource();
  await source.connect('owner/repo/exports');
  await source.getMetadata('tiny-ready');
  source.getBaseUrl('tiny-ready');
  const shown = source.getAnnDataSource('tiny-ready');
  await source.refresh();
  assert.equal(host.requests.filter(request => request.url.endsWith('/datasets.json')).length, 2);
  assert.strictEqual(source.getAnnDataSource('tiny-ready'), shown);
  source.releaseExcept(null);
  assert.equal(source.getAnnDataSource('tiny-ready'), null);
  source.disconnect();
});

test('an unconnected link has nothing to refresh and does not fail a reload', async () => {
  const manager = new DataSourceManager();
  manager.registerSource('link', new LinkDataSource());
  const results = await manager.getAllDatasets({ refresh: true });
  assert.deepEqual(results, []);
});

