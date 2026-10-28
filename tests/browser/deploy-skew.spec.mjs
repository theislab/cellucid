/**
 * Deploys and the module graph.
 *
 * A host that caches by path (GitHub Pages answers every file with
 * `max-age=600`, and ignores the query string) once let a page run a cached
 * module of one build beside a freshly fetched one of the next; the app then
 * stopped on "does not provide an export named …" with only a console error.
 * Every script URL now names its bytes (index.html, CELLUCID_MODULE_VERSIONS),
 * and what can still meet a deploy (a page open across it importing a part it
 * had not loaded) says so with a Reload button.
 *
 * A deploy is simulated the way the host behaves: after it, the old URL of a
 * changed file answers the new bytes, and the page's own address answers the
 * new build's index.html.
 *
 * Workers get no import map, so a deployed page starts each from its bundle:
 * one file named by its bytes (`assets/workers/`). The page is a deployed
 * site when it is not served from this machine's own name, so those tests
 * open it at `deployed.localhost`, which every engine resolves to the same
 * server. After a deploy the host no longer has the previous build's bundles.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { expect, test } from './helpers/test.mjs';
import { DEPLOYED_APP_ORIGIN, ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { WORKER_SCRIPTS } from './helpers/worker-scripts.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const ROOT = new URL('../../', import.meta.url);
const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui`;
const INDEX_HTML = readFileSync(new URL('index.html', ROOT), 'utf8');
const NEXT_BUILD = '2999-01-01.0deploy0';
const NEXT_INDEX_HTML = INDEX_HTML.replace(
  /(<meta name="cellucid-web-build-id" content=")[^"]+(")/,
  `$1${NEXT_BUILD}$2`,
);
// A lazily imported module of the next build that imports an export the page's
// already-loaded build does not have: the shape of the reported failure.
const LAZY_MODULE = 'assets/js/app/ui/modules/benchmark/generation-contract.js';
const NEXT_LAZY_MODULE =
  "import { EXPORT_OF_THE_NEXT_BUILD } from '../../../../data/data-mapping.js';\n" +
  'void EXPORT_OF_THE_NEXT_BUILD;\n' +
  readFileSync(new URL(LAZY_MODULE, ROOT), 'utf8');
// A module of the startup graph, changed the same way.
const STATIC_MODULE = 'assets/js/app/ui/core/build-version.js';
const NEXT_STATIC_MODULE =
  "import { EXPORT_OF_THE_NEXT_BUILD } from '../../../data/data-mapping.js';\n" +
  'void EXPORT_OF_THE_NEXT_BUILD;\n' +
  readFileSync(new URL(STATIC_MODULE, ROOT), 'utf8');

// The same dataset, opened as a deployed site.
const DEPLOYED_DATASET_URL = `${DEPLOYED_APP_ORIGIN}/?sampleCatalog=${encodeURIComponent(
  `${DEPLOYED_APP_ORIGIN}/tests/browser/fixtures/catalog/`,
)}&dataset=current-ui`;
const WORKER_SOURCES = new Set([...WORKER_SCRIPTS.values()].map(({ source }) => source));

/** The path of every script request the page sees, worker requests included. */
function observeScriptRequests(page) {
  const paths = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/assets/') && url.pathname.endsWith('.js')) {
      paths.push({ path: url.pathname, versioned: url.searchParams.has('v') });
    }
  });
  return paths;
}

function contentVersion(path) {
  return createHash('sha256').update(readFileSync(new URL(path, ROOT))).digest('hex').slice(0, 12);
}

/** After this, the page's own address answers the next build's index.html. */
async function deployNextIndex(page) {
  await page.route(url => url.pathname === '/', route => {
    if (route.request().resourceType() !== 'fetch') return route.fallback();
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: NEXT_INDEX_HTML });
  });
}

/** After this, the old URL of `path` answers `body`, as the host does. */
async function deployNextModule(page, path, body) {
  await page.route(`**/${path}?v=${contentVersion(path)}`, route => route.fulfill({
    status: 200,
    contentType: 'text/javascript; charset=utf-8',
    body,
  }));
}

async function openAppAndBenchmarkReady(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expect(page.locator('#benchmark-run')).toBeEnabled();
}

test('every module the page loads is requested at the URL naming its bytes', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.__cellucidScriptRequests = [];
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        window.__cellucidScriptRequests.push({ name: entry.name, initiatorType: entry.initiatorType });
      }
    }).observe({ type: 'resource', buffered: true });
  });
  const violations = [];
  page.on('console', message => {
    if (/Content.Security.Policy|import ?map/i.test(message.text())) violations.push(message.text());
  });
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');

  const scripts = (await page.evaluate(() => window.__cellucidScriptRequests))
    .map(entry => ({ ...entry, url: new URL(entry.name) }))
    .filter(({ url }) => url.pathname.startsWith('/assets/') && url.pathname.endsWith('.js'));
  const versioned = scripts.filter(({ url }) => url.searchParams.has('v'));
  // The map is in force (a policy that blocked it would leave every URL plain),
  // and each version is the current bytes of its file.
  expect(versioned.map(({ url }) => url.pathname)).toContain('/assets/js/app/main.js');
  expect(versioned.map(({ url }) => url.pathname)).toContain('/assets/js/app/ui/core/code-load-watch.js');
  expect(
    versioned
      .filter(({ url }) => url.searchParams.get('v') !== contentVersion(url.pathname.slice(1)))
      .map(({ url }) => url.href),
  ).toEqual([]);
  // A plain path is a module worker's: its script (initiator `other`) and,
  // in Chromium alone, the imports of its graph, which Chromium lists in the
  // page's timeline as `script` too. Firefox and WebKit list only the
  // page's own, so there every other script request must be versioned.
  const plain = scripts.filter(({ url }) => !url.searchParams.has('v'));
  if (testInfo.project.name !== 'chromium') {
    expect(plain.filter(({ initiatorType }) => initiatorType !== 'other').map(({ name }) => name)).toEqual([]);
  }
  expect(violations).toEqual([]);
});

test('a page open across a deploy says Cellucid was updated when a part it imports later does not fit', async ({ page }) => {
  await openAppAndBenchmarkReady(page);
  await deployNextIndex(page);
  await deployNextModule(page, LAZY_MODULE, NEXT_LAZY_MODULE);

  await page.locator('#benchmark-section > summary').click();

  const notice = page.locator('#cellucid-code-updated');
  await expect(notice).toBeVisible();
  await expect(notice.locator('.notification-title')).toHaveText('Cellucid has been updated');
  await expect(notice.locator('.notification-message')).toContainText('Reload to use the current version');
  await expect(page.locator('html')).toHaveAttribute('data-code-updated', 'true');
  // The app itself is still the one that started: nothing of it was replaced.
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');

  // Reload loads one build again.
  await page.unrouteAll({ behavior: 'wait' });
  await Promise.all([
    page.waitForEvent('load'),
    notice.getByRole('button', { name: 'Reload' }).click(),
  ]);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expect(page.locator('html')).not.toHaveAttribute('data-code-updated', /.*/);
});

test('a part that fails to load on the current build is not called an update', async ({ page }) => {
  await openAppAndBenchmarkReady(page);
  let checked = false;
  await page.route(url => url.pathname === '/', route => {
    if (route.request().resourceType() === 'fetch') checked = true;
    return route.fallback();
  });
  await page.route(`**/${LAZY_MODULE}?v=*`, route => route.abort());

  await page.locator('#benchmark-section > summary').click();

  await expect.poll(() => checked).toBe(true);
  await expect(page.locator('#cellucid-code-updated')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-code-updated', /.*/);
});

test('a startup module that does not fit says so instead of starting forever', async ({ page }) => {
  await deployNextModule(page, STATIC_MODULE, NEXT_STATIC_MODULE);
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });

  const failure = page.locator('#cellucid-startup-failure');
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute('data-failure', 'code');
  await expect(failure).toHaveAttribute('data-code-failure', 'run');
  await expect(failure.locator('.welcome-title')).toHaveText('Cellucid could not load');
  await expect(failure.locator('.welcome-details-text')).toContainText('EXPORT_OF_THE_NEXT_BUILD');
  await expect(failure.getByRole('link', { name: 'Reload' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-code-load-failed', 'true');
  await expect(page.locator('html')).not.toHaveAttribute('data-code-started', /.*/);
  await expect(page.locator('#data-source-status')).toHaveText(
    'Cellucid could not run its code: one of its files does not fit the others. Reload this page.',
  );
});

test('a page loaded while a deploy lands says Cellucid was updated and offers to reload', async ({ page }) => {
  await deployNextIndex(page);
  await deployNextModule(page, STATIC_MODULE, NEXT_STATIC_MODULE);
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });

  const failure = page.locator('#cellucid-startup-failure');
  await expect(failure).toHaveAttribute('data-code-failure', 'updated');
  await expect(failure.locator('.welcome-title')).toHaveText('Cellucid has been updated');
  await expect(failure.locator('.welcome-intro')).toContainText('Reload to open the current version');
  await expect(page.locator('#data-source-status')).toHaveText(
    'Cellucid has been updated: this page holds files of the previous version. ' +
      'Reload this page to open the current version.',
  );

  // Reload, once the host serves one build, starts the app.
  await page.unrouteAll({ behavior: 'wait' });
  await Promise.all([
    page.waitForEvent('load'),
    failure.getByRole('link', { name: 'Reload' }).click(),
  ]);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expect(page.locator('#cellucid-startup-failure')).toHaveCount(0);
});

test('a deployed page starts every worker from its bundle and loads nothing of a worker by plain path', async ({ page }, testInfo) => {
  expect(WORKER_SCRIPTS.size).toBeGreaterThan(0);
  const requests = observeScriptRequests(page);
  await page.goto(DEPLOYED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  // The decode workers start as the store opens; their bundle is requested
  // by the reader worker, which only Chromium and WebKit show the page.
  const nested = testInfo.project.name !== 'firefox';
  await expect.poll(() => requests.map(({ path }) => path)).toEqual(expect.arrayContaining([
    WORKER_SCRIPTS.get('annDataReaderWorker').bundle,
    ...(nested ? [WORKER_SCRIPTS.get('decodeWorker').bundle] : []),
  ]));

  // Every script is the page's own at the URL naming its bytes, or a bundle;
  // no worker source, and nothing a worker imports, is asked for by its plain
  // path. A module the page imports too (the MatrixMarket entry scanner, whose
  // error the page's link source names) is the page's own at its versioned URL.
  const bundles = new Set([...WORKER_SCRIPTS.values()].map(({ bundle }) => bundle));
  expect(requests.filter(({ path, versioned }) => !versioned && WORKER_SOURCES.has(path)).map(({ path }) => path)).toEqual([]);
  expect(requests.filter(({ path, versioned }) => !versioned && !bundles.has(path)).map(({ path }) => path)).toEqual([]);
});

test('a worker started after a deploy says Cellucid was updated, while the worker already running keeps working', async ({ page }) => {
  await page.goto(DEPLOYED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');

  // The deploy: the page's address answers the next build, and the host no
  // longer has this build's analysis worker bundle (its code changed).
  await page.route(url => url.pathname === '/', route => {
    if (route.request().resourceType() !== 'fetch') return route.fallback();
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: NEXT_INDEX_HTML });
  });
  await page.route(`**${WORKER_SCRIPTS.get('dataWorker').bundle}`, route => route.fulfill({
    status: 404,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><title>File not found</title>',
  }));

  // The analysis workers start now, from the bundle this page names.
  const started = await page.evaluate(async () => {
    const { WorkerPool } = await import('/assets/js/app/analysis/compute/worker-pool.js');
    const pool = new WorkerPool({ poolSize: 1, defaultTimeout: 10_000 });
    try {
      await pool.init();
      return true;
    } catch {
      return false;
    } finally {
      pool.terminate();
    }
  });
  expect(started).toBe(false);

  const notice = page.locator('#cellucid-code-updated');
  await expect(notice).toBeVisible();
  await expect(notice.locator('.notification-title')).toHaveText('Cellucid has been updated');
  await expect(notice.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-code-updated', 'true');

  // The reader worker started before the deploy is one file: it still reads
  // a gene it had not read.
  const gene = await page.evaluate(() => window._cellucidState.varData.fields.at(-1).key);
  const search = page.locator('#gene-expression-search');
  await search.click();
  await search.fill(gene);
  await search.press('Enter');
  await expect.poll(() => page.evaluate(() => {
    const state = window._cellucidState;
    if (state.activeFieldSource !== 'var') return null;
    const field = state.varData.fields[state.activeVarFieldIndex];
    return field.values ? { key: field.key, cells: field.values.length } : null;
  })).toEqual({ key: gene, cells: expect.any(Number) });

  // Reload loads one build again, its workers with it.
  await page.unrouteAll({ behavior: 'wait' });
  await Promise.all([
    page.waitForEvent('load'),
    notice.getByRole('button', { name: 'Reload' }).click(),
  ]);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expect(page.locator('html')).not.toHaveAttribute('data-code-updated', /.*/);
});

test('a worker that fails to start on the current build is not called an update', async ({ page }) => {
  await page.goto(DEPLOYED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  let checked = false;
  await page.route(url => url.pathname === '/', route => {
    if (route.request().resourceType() === 'fetch') checked = true;
    return route.fallback();
  });
  await page.route(`**${WORKER_SCRIPTS.get('dataWorker').bundle}`, route => route.abort());

  await page.evaluate(async () => {
    const { WorkerPool } = await import('/assets/js/app/analysis/compute/worker-pool.js');
    const pool = new WorkerPool({ poolSize: 1, defaultTimeout: 10_000 });
    await pool.init().catch(() => {});
    pool.terminate();
  });

  await expect.poll(() => checked).toBe(true);
  await expect(page.locator('#cellucid-code-updated')).toHaveCount(0);
});
