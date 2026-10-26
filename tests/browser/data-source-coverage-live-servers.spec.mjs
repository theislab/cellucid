/**
 * The server-backed and network-backed data sources reach a rendered dataset.
 *
 * These paths cannot be satisfied by a static file server, so each one is
 * guarded by a reachability probe and skipped when its dependency is absent.
 * Nothing here is stubbed: the remote and viewer host cases talk to a real
 * `cellucid` Python server, and the GitHub case talks to the real published
 * repository over the network.
 *
 * Start the dependencies before running this file. The viewer channel serves
 * one AnnData file, the demo catalog's `synthetic-development-3d`
 * (`fixtures/demo-catalog/synthetic-development-3d.zarr.zip`), because the
 * viewer host URL contract rejects a `dataset` parameter.
 *
 *   cellucid serve <some>.h5ad --dataset-name "Miller lung (real h5ad)" \
 *       --dataset-id miller --port 8766 --no-browser --no-web-ui
 *   python jupyter-bridge-server.py \
 *       tests/browser/fixtures/demo-catalog/synthetic-development-3d.zarr.zip \
 *       8769 viewer-obj7 token-obj7
 *
 * `jupyter-bridge-server.py` starts the same `AnnDataServer` the CLI runs and
 * registers one viewer with `register_event_callback`
 * (`cellucid._viewer_channel`), which is what makes the viewer channel's
 * `hello` authenticated rather than stubbed. A copy lives in
 * `.cellucid-maintenance/artifacts/obj7/`.
 *
 * The viewer host source derives its server URL from `location`, so it can only
 * ever talk to the page's own origin. The page origin is the static test
 * server, so `/_cellucid/*` and the viewer channel's WebSocket are forwarded
 * verbatim to the real Python server. The forwarding is transport re-homing,
 * not a stub: every status, header, frame and byte comes from Python,
 * including the authenticated `hello` that a wrong token would close with 4401.
 */
import { expect, test } from './helpers/test.mjs';
import { APP_ORIGIN as ORIGIN } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { formatCompactCount } from '../../assets/js/app/ui/components/display-format.js';
import { formatCount } from '../../assets/js/utils/format-units.js';

const LOCAL_CATALOG =
  `${ORIGIN}/tests/browser/fixtures/demo-catalog/`;

const ANNDATA_SERVER = 'http://127.0.0.1:8766';
const VIEWER_HOST_SERVER = 'http://127.0.0.1:8769';
const VIEWER_HOST_VIEWER_ID = 'viewer-obj7';
const VIEWER_HOST_VIEWER_TOKEN = 'token-obj7';

const GITHUB_REPOSITORY = 'theislab/cellucid-demo-custom-datasets/catalog';
const GITHUB_CATALOG_URL =
  'https://raw.githubusercontent.com/theislab/'
  + 'cellucid-demo-custom-datasets/HEAD/catalog/datasets.json';

async function reachable(url, init) {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  return errors;
}


async function expectRendered(page, { name, cells, genes, field, entries }) {
  await expect(page.locator('#dataset-name')).toHaveText(name, {
    timeout: 90_000,
  });
  await expect(page.locator('#dataset-cells')).toHaveText(
    formatCompactCount(cells),
  );
  await expect(page.locator('#dataset-genes')).toHaveText(
    formatCompactCount(genes),
  );
  await expect(page.locator('#filter-count')).toHaveText(
    `Showing all ${formatCount(cells)} cells`,
  );
  await expect
    .poll(() => page.evaluate(
      () => window._cellucidViewer.getPointCount(),
    ), { timeout: 60_000 })
    .toBe(cells);
  await page.locator('#categorical-field').selectOption({ label: field });
  await expect(page.locator('.legend-item')).toHaveCount(entries);
}

/* ------------------------------------------------------------------ *
 * anndata server — a real .h5ad the viewer reads in place from Python
 * ------------------------------------------------------------------ */

test('a real .h5ad served in AnnData mode renders', async ({ page }) => {
  test.skip(
    !(await reachable(`${ANNDATA_SERVER}/_cellucid/health`)),
    `No AnnData cellucid server on ${ANNDATA_SERVER}`,
  );
  // The server declares the store and its launch defaults in its catalog;
  // the viewer reads the file itself with range requests, under the
  // server's dataset id and name.
  const url = new URL('/', ORIGIN);
  url.searchParams.set('source', 'remote');
  url.searchParams.set('remote', ANNDATA_SERVER);
  url.searchParams.set('anndata', 'true');
  url.searchParams.set('sampleCatalog', LOCAL_CATALOG);
  const catalogResponse = page.waitForResponse(
    response => response.url() === `${ANNDATA_SERVER}/_cellucid/datasets`,
  );
  const rangeResponse = page.waitForResponse(
    response =>
      response.url().startsWith(`${ANNDATA_SERVER}/_cellucid/anndata/`) &&
      response.status() === 206,
  );
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });

  const catalog = await (await catalogResponse).json();
  expect(catalog.datasets).toHaveLength(1);
  expect(catalog.datasets[0].anndata.file.kind).toBe('h5ad');
  expect((await rangeResponse).headers()['content-range']).toMatch(/^bytes \d+-\d+\/\d+$/);

  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expectRendered(page, {
    name: 'Miller lung (real h5ad)',
    cells: 7405,
    genes: 8192,
    field: 'cell_type',
    entries: 10,
  });
  expect(
    await page.evaluate(() => window._cellucidState.getDataMapping().kind),
  ).toBe('anndata');
});

test('the sidebar Connect control adopts a real Python server', async ({
  page,
}) => {
  test.skip(
    !(await reachable(`${ANNDATA_SERVER}/_cellucid/health`)),
    `No AnnData cellucid server on ${ANNDATA_SERVER}`,
  );
  const url = new URL('/', ORIGIN);
  url.searchParams.set('sampleCatalog', LOCAL_CATALOG);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Synthetic cell-type islands — 2D',
  );

  await page.locator('#data-address').fill(ANNDATA_SERVER);
  await page.locator('#data-address-open-btn').click();

  await expectRendered(page, {
    name: 'Miller lung (real h5ad)',
    cells: 7405,
    genes: 8192,
    field: 'cell_type',
    entries: 10,
  });
  await expect(page.locator('#remote-disconnect-btn')).toBeVisible();
});

/* ------------------------------------------------------------------ *
 * github-data-source.js — the real published demo repository
 * ------------------------------------------------------------------ */

test('a published GitHub catalog renders from a startup intent', async ({
  page,
}) => {
  test.skip(
    !(await reachable(GITHUB_CATALOG_URL)),
    'raw.githubusercontent.com is not reachable',
  );
  const errors = observeProductErrors(page);
  const url = new URL('/', ORIGIN);
  url.searchParams.set('data', `gh:${GITHUB_REPOSITORY}`);
  url.searchParams.set('dataset', 'synthetic-trajectory-1d');
  url.searchParams.set('sampleCatalog', LOCAL_CATALOG);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expectRendered(page, {
    name: 'Synthetic trajectory — 1D',
    cells: 48,
    genes: 6,
    field: 'stage',
    entries: 4,
  });
  expect(errors).toEqual([]);
});

test('the Open from link control loads a published GitHub repository', async ({
  page,
}) => {
  test.skip(
    !(await reachable(GITHUB_CATALOG_URL)),
    'raw.githubusercontent.com is not reachable',
  );
  // The published repository is live data that grows with the demo
  // repository, so the count it must announce is the count it publishes.
  const published = await (await fetch(GITHUB_CATALOG_URL, {
    signal: AbortSignal.timeout(8_000),
  })).json();
  const publishedCount = published.datasets.length;
  expect(publishedCount).toBeGreaterThan(1);
  const url = new URL('/', ORIGIN);
  url.searchParams.set('sampleCatalog', LOCAL_CATALOG);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Synthetic cell-type islands — 2D',
  );

  await page.locator('#data-address').fill(GITHUB_REPOSITORY);
  await page.locator('#data-address-open-btn').click();

  await expect(
    page.locator('#notification-center .notification')
      .filter({ hasText: `Connected - ${publishedCount} datasets found` }),
  ).toHaveCount(1, { timeout: 60_000 });
  await expect(
    page.locator('#dataset-select option[value^="dataset:link:"]'),
  ).toHaveCount(publishedCount);
  // While the catalog is connected the list is its own, named by its host.
  await expect(page.locator('label[for="dataset-select"]')).toHaveText(/^Dataset from /);
});

/* ------------------------------------------------------------------ *
 * viewer-host-source.js — a real authenticated Python bridge
 * ------------------------------------------------------------------ */

test('an authenticated viewer channel renders and delivers its ready event', async ({
  page,
}) => {
  test.skip(
    !(await reachable(`${VIEWER_HOST_SERVER}/_cellucid/health`)),
    `No viewer channel server on ${VIEWER_HOST_SERVER}`,
  );

  const forwarded = [];
  await page.route(`${ORIGIN}/_cellucid/**`, async route => {
    const request = route.request();
    const target = new URL(request.url());
    forwarded.push(`${request.method()} ${target.pathname}`);
    const response = await route.fetch({
      url: `${VIEWER_HOST_SERVER}${target.pathname}${target.search}`,
    });
    await route.fulfill({ response });
  });
  const frames = [];
  await page.routeWebSocket(`${ORIGIN.replace(/^http/, 'ws')}/_cellucid/ws`, socket => {
    const server = socket.connectToServer(`${VIEWER_HOST_SERVER.replace(/^http/, 'ws')}/_cellucid/ws`);
    socket.onMessage(message => {
      frames.push(typeof message === 'string' ? JSON.parse(message).type : 'binary');
      server.send(message);
    });
  });
  // The viewer page contract forbids every parameter except viewer/viewerId/
  // viewerToken, so the sample catalog cannot be pointed anywhere local. Deny
  // the public catalog to prove the viewer host dataset still renders without it.
  await page.route('https://theislab.github.io/**', route => route.abort());

  const url = new URL('/', ORIGIN);
  url.searchParams.set('viewer', 'true');
  url.searchParams.set('viewerId', VIEWER_HOST_VIEWER_ID);
  url.searchParams.set('viewerToken', VIEWER_HOST_VIEWER_TOKEN);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expectRendered(page, {
    name: 'Synthetic branching development — 3D',
    cells: 96,
    genes: 10,
    field: 'lineage',
    entries: 2,
  });
  await expect(page.locator('#view-representation-select option:checked')).toHaveText(/ · 3D$/);
  await expect(page.locator('#navigation-mode')).toHaveValue('orbit');

  // The bridge must have completed the authenticated round trip.
  await expect.poll(() => frames).toContain('ready');
  expect(frames[0]).toBe('hello');
  expect(forwarded).toContain('GET /_cellucid/health');
  expect(forwarded).toContain('GET /_cellucid/datasets');
});

test('a viewer channel that stops is reported, not silently frozen', async ({
  page,
}) => {
  test.skip(
    !(await reachable(`${VIEWER_HOST_SERVER}/_cellucid/health`)),
    `No viewer channel server on ${VIEWER_HOST_SERVER}`,
  );

  let serverUp = true;
  await page.route(`${ORIGIN}/_cellucid/**`, async route => {
    const target = new URL(route.request().url());
    if (!serverUp) {
      await route.abort('connectionrefused');
      return;
    }
    const response = await route.fetch({
      url: `${VIEWER_HOST_SERVER}${target.pathname}${target.search}`,
    });
    await route.fulfill({ response });
  });
  let pageSocket = null;
  await page.routeWebSocket(`${ORIGIN.replace(/^http/, 'ws')}/_cellucid/ws`, socket => {
    if (!serverUp) {
      // Nothing listens any more: the reopen cannot connect.
      socket.connectToServer('ws://127.0.0.1:9/');
      return;
    }
    pageSocket = socket;
    socket.connectToServer(`${VIEWER_HOST_SERVER.replace(/^http/, 'ws')}/_cellucid/ws`);
  });
  await page.route('https://theislab.github.io/**', route => route.abort());

  const url = new URL('/', ORIGIN);
  url.searchParams.set('viewer', 'true');
  url.searchParams.set('viewerId', VIEWER_HOST_VIEWER_ID);
  url.searchParams.set('viewerToken', VIEWER_HOST_VIEWER_TOKEN);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#dataset-name')).toHaveText(
    'Synthetic branching development — 3D',
  );

  // The server goes away: its channel drops, the page reopens it once, the
  // reopen fails, and one health request finds the server gone. Nothing polls.
  serverUp = false;
  await pageSocket.close({ code: 1011, reason: 'server gone' });
  await expect(
    page.locator('#notification-center .notification')
      .filter({ hasText: 'stopped (its server no longer answers)' }),
  ).toHaveCount(1, { timeout: 45_000 });
});
