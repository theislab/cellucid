/**
 * The server-backed and network-backed data sources reach a rendered dataset.
 *
 * These paths cannot be satisfied by a static file server, so each one is
 * guarded by a reachability probe and skipped when its dependency is absent.
 * Nothing here is stubbed: the remote and Jupyter cases talk to a real
 * `cellucid` Python server, and the GitHub case talks to the real published
 * repository over the network.
 *
 * Start the dependencies before running this file. Each export root is a
 * directory holding `datasets.json` plus the dataset directories it names; the
 * Jupyter root must name exactly one dataset, because the Jupyter URL contract
 * rejects a `dataset` parameter.
 *
 *   cellucid serve <exports-root-with-one-pancreas-dataset> --port 8765 \
 *       --no-browser --no-web-ui
 *   cellucid serve <some>.h5ad --dataset-name "Miller lung (real h5ad)" \
 *       --dataset-id miller --port 8766 --no-browser --no-web-ui
 *   python jupyter-bridge-server.py <single-dataset-exports-root> 8769 \
 *       viewer-obj7 token-obj7
 *
 * `jupyter-bridge-server.py` starts the same `CellucidServer` the CLI runs and
 * registers one viewer with `register_event_callback`, which is what makes
 * `POST /_cellucid/events` authenticated rather than stubbed. A copy lives in
 * `.cellucid-maintenance/artifacts/obj7/`.
 *
 * The Jupyter source derives its server URL from `location`, so it can only
 * ever talk to the page's own origin. The page origin is the static test
 * server, which answers 405 to POST, so `/_cellucid/*` is forwarded verbatim to
 * the real Python server. The forwarding is transport re-homing, not a stub:
 * every status, header and byte comes from Python, including the authenticated
 * `POST /_cellucid/events` that a wrong token would reject with HTTP 403.
 */
import { expect, test } from '@playwright/test';
import { APP_ORIGIN as ORIGIN } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const LOCAL_EXPORTS =
  `${ORIGIN}/tests/browser/fixtures/demo-custom-exports/`;

const EXPORTED_SERVER = 'http://127.0.0.1:8765';
const ANNDATA_SERVER = 'http://127.0.0.1:8766';
const JUPYTER_SERVER = 'http://127.0.0.1:8769';
const JUPYTER_DATASET_ID = 'synthetic-development-3d';
const JUPYTER_VIEWER_ID = 'viewer-obj7';
const JUPYTER_VIEWER_TOKEN = 'token-obj7';

const GITHUB_REPOSITORY = 'theislab/cellucid-demo-custom-datasets/exports';
const GITHUB_CATALOG_URL =
  'https://raw.githubusercontent.com/theislab/'
  + 'cellucid-demo-custom-datasets/main/exports/datasets.json';

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

/** Mirror of `formatCellCount` in assets/js/data/data-source.js. */
function formatCellCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

async function expectRendered(page, { name, cells, genes, field, entries }) {
  await expect(page.locator('#dataset-name')).toHaveText(name, {
    timeout: 90_000,
  });
  await expect(page.locator('#dataset-cells')).toHaveText(
    formatCellCount(cells),
  );
  await expect(page.locator('#dataset-genes')).toHaveText(
    formatCellCount(genes),
  );
  await expect(page.locator('#filter-count')).toHaveText(
    `Showing all ${cells.toLocaleString('en-US')} points`,
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
 * remote-source.js — a real `cellucid serve` over a prepared export
 * ------------------------------------------------------------------ */

test('a prepared export streamed from a real Python server renders', async ({
  page,
}) => {
  test.skip(
    !(await reachable(`${EXPORTED_SERVER}/_cellucid/health`)),
    `No cellucid server on ${EXPORTED_SERVER}`,
  );
  const errors = observeProductErrors(page);
  const url = new URL('/', ORIGIN);
  url.searchParams.set('source', 'remote');
  url.searchParams.set('remote', EXPORTED_SERVER);
  url.searchParams.set('exportsBaseUrl', LOCAL_EXPORTS);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });

  // A remote startup intent must never paint onboarding.
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expectRendered(page, {
    name: 'Pancreatic endocrinogenesis (scVelo)',
    cells: 3696,
    genes: 3753,
    field: 'cell_type',
    entries: 8,
  });
  await expect(page.locator('#dimension-select')).toHaveValue('3');
  expect(errors).toEqual([]);
});

test('the sidebar Connect control adopts a real Python server', async ({
  page,
}) => {
  test.skip(
    !(await reachable(`${EXPORTED_SERVER}/_cellucid/health`)),
    `No cellucid server on ${EXPORTED_SERVER}`,
  );
  const url = new URL('/', ORIGIN);
  url.searchParams.set('exportsBaseUrl', LOCAL_EXPORTS);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  // The sidebar connection controls are wired only after the startup dataset
  // publishes; clicking before that is silently discarded (see OBJ-7 report).
  await expect(page.locator('#dataset-name')).toHaveText(
    'Synthetic cell-type islands — 2D',
  );

  await page.locator('#remote-server-url').fill(EXPORTED_SERVER);
  await page.locator('#remote-connect-btn').click();

  await expectRendered(page, {
    name: 'Pancreatic endocrinogenesis (scVelo)',
    cells: 3696,
    genes: 3753,
    field: 'cell_type',
    entries: 8,
  });
  await expect(page.locator('#remote-disconnect-btn')).toBeVisible();
});

/* ------------------------------------------------------------------ *
 * anndata server — a real .h5ad parsed by Python and streamed
 * ------------------------------------------------------------------ */

test('a real .h5ad served in AnnData mode renders', async ({ page }) => {
  test.skip(
    !(await reachable(`${ANNDATA_SERVER}/_cellucid/health`)),
    `No AnnData cellucid server on ${ANNDATA_SERVER}`,
  );
  // Expected-to-fail while the reader rejects the identity its own writer
  // emits. `cellucid serve <file>.h5ad` publishes
  // export_settings.obs_categorical_dtype = "auto"
  // (cellucid-python/src/cellucid/anndata_adapter.py:1583) and
  // validateIdentityExportSettings accepts only "uint8"/"uint16"
  // (assets/js/data/data-source.js:1140-1147) even though its own error text
  // and the @property doc at data-source.js:36 both name "auto" as legal.
  // Startup dies with:
  //   Invalid dataset_identity.json: export_settings.obs_categorical_dtype
  //   must be auto, uint8, or uint16
  // Delete this marker when data-source.js accepts "auto".
  test.fail();
  const url = new URL('/', ORIGIN);
  url.searchParams.set('source', 'remote');
  url.searchParams.set('remote', ANNDATA_SERVER);
  url.searchParams.set('anndata', 'true');
  url.searchParams.set('exportsBaseUrl', LOCAL_EXPORTS);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expectRendered(page, {
    name: 'Miller lung (real h5ad)',
    cells: 7405,
    genes: 8192,
    field: 'cell_type',
    entries: 10,
  });
});

/* ------------------------------------------------------------------ *
 * github-data-source.js — the real published demo repository
 * ------------------------------------------------------------------ */

test('a published GitHub export renders from a startup intent', async ({
  page,
}) => {
  test.skip(
    !(await reachable(GITHUB_CATALOG_URL)),
    'raw.githubusercontent.com is not reachable',
  );
  const errors = observeProductErrors(page);
  const url = new URL('/', ORIGIN);
  url.searchParams.set('source', 'github-repo');
  url.searchParams.set('github', GITHUB_REPOSITORY);
  url.searchParams.set('dataset', 'synthetic-trajectory-1d');
  url.searchParams.set('exportsBaseUrl', LOCAL_EXPORTS);
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

test('the sidebar GitHub control loads a published repository', async ({
  page,
}) => {
  test.skip(
    !(await reachable(GITHUB_CATALOG_URL)),
    'raw.githubusercontent.com is not reachable',
  );
  const url = new URL('/', ORIGIN);
  url.searchParams.set('exportsBaseUrl', LOCAL_EXPORTS);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Synthetic cell-type islands — 2D',
  );

  await page.locator('#github-repo-url').fill(GITHUB_REPOSITORY);
  await page.locator('#github-connect-btn').click();

  await expect(
    page.locator('#notification-center .notification')
      .filter({ hasText: 'Connected to theislab/cellucid-demo-custom-datasets' }),
  ).toHaveCount(1, { timeout: 60_000 });
  await expect(
    page.locator('#dataset-select optgroup[label="GitHub data"] option'),
  ).toHaveCount(3);
});

/* ------------------------------------------------------------------ *
 * jupyter-source.js — a real authenticated Python bridge
 * ------------------------------------------------------------------ */

test('an authenticated Jupyter bridge renders and delivers its ready event', async ({
  page,
}) => {
  test.skip(
    !(await reachable(`${JUPYTER_SERVER}/_cellucid/health`)),
    `No Jupyter bridge server on ${JUPYTER_SERVER}`,
  );

  const forwarded = [];
  for (const pattern of [
    `${ORIGIN}/_cellucid/**`,
    `${ORIGIN}/${JUPYTER_DATASET_ID}/**`,
  ]) {
    await page.route(pattern, async route => {
      const request = route.request();
      const target = new URL(request.url());
      forwarded.push(`${request.method()} ${target.pathname}`);
      const response = await route.fetch({
        url: `${JUPYTER_SERVER}${target.pathname}${target.search}`,
      });
      await route.fulfill({ response });
    });
  }
  // The Jupyter URL contract forbids every parameter except jupyter/viewerId/
  // viewerToken, so the sample catalog cannot be pointed anywhere local. Deny
  // the public catalog to prove the Jupyter dataset still renders without it.
  await page.route('https://theislab.github.io/**', route => route.abort());

  const url = new URL('/', ORIGIN);
  url.searchParams.set('jupyter', 'true');
  url.searchParams.set('viewerId', JUPYTER_VIEWER_ID);
  url.searchParams.set('viewerToken', JUPYTER_VIEWER_TOKEN);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expectRendered(page, {
    name: 'Synthetic branching development — 3D',
    cells: 96,
    genes: 10,
    field: 'lineage',
    entries: 2,
  });
  await expect(page.locator('#dimension-select')).toHaveValue('3');
  await expect(page.locator('#navigation-mode')).toHaveValue('orbit');

  // The bridge must have completed the authenticated round trip.
  expect(forwarded).toContain('POST /_cellucid/events');
  expect(forwarded).toContain('GET /_cellucid/health');
  expect(forwarded).toContain('GET /_cellucid/datasets');
});

test('a Jupyter bridge that stops is reported, not silently frozen', async ({
  page,
}) => {
  test.skip(
    !(await reachable(`${JUPYTER_SERVER}/_cellucid/health`)),
    `No Jupyter bridge server on ${JUPYTER_SERVER}`,
  );

  let serverUp = true;
  for (const pattern of [
    `${ORIGIN}/_cellucid/**`,
    `${ORIGIN}/${JUPYTER_DATASET_ID}/**`,
  ]) {
    await page.route(pattern, async route => {
      const target = new URL(route.request().url());
      if (!serverUp) {
        await route.abort('connectionrefused');
        return;
      }
      const response = await route.fetch({
        url: `${JUPYTER_SERVER}${target.pathname}${target.search}`,
      });
      await route.fulfill({ response });
    });
  }
  await page.route('https://theislab.github.io/**', route => route.abort());

  const url = new URL('/', ORIGIN);
  url.searchParams.set('jupyter', 'true');
  url.searchParams.set('viewerId', JUPYTER_VIEWER_ID);
  url.searchParams.set('viewerToken', JUPYTER_VIEWER_TOKEN);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#dataset-name')).toHaveText(
    'Synthetic branching development — 3D',
  );

  serverUp = false;
  await expect(
    page.locator('#notification-center .notification')
      .filter({ hasText: 'The Python server stopped' }),
  ).toHaveCount(1, { timeout: 45_000 });
});
