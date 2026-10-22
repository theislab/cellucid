/**
 * What a production page asks Google Analytics to send, end to end.
 *
 * The app is served under its real production hostname, so the production
 * bootstrap runs for real, while `gtag.js` is replaced by an empty stub: the
 * bootstrap's own `gtag` keeps queueing every call into `dataLayer`, which is
 * exactly the record of what would have been sent, and nothing can reach
 * Google. Every recorded event is validated against the schema in Node, and
 * the scripted session must produce exactly the expected sequence.
 *
 * On a local origin the same session must not produce any analytics at all.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from './helpers/test.mjs';
import { APP_ORIGIN, appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import {
  validateEvent,
  validateUserProperties,
} from '../../assets/js/analytics/schema.js';

const PRODUCTION_ORIGIN = 'https://www.cellucid.com';
const fixturesDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);
const h5adFixturePath = path.join(fixturesDirectory, 'current-ui-smoke.h5ad');
const FIRST = 'Synthetic cell-type islands — 2D';
const SECOND = 'Synthetic branching development — 3D';

function sessionUrl(origin) {
  const url = new URL('/', origin);
  url.searchParams.set(
    'exportsBaseUrl',
    `${origin}/tests/browser/fixtures/demo-custom-exports/`,
  );
  url.searchParams.set('dataset', 'synthetic-cell-types-2d');
  return url.toString();
}

/** Serve the worktree as www.cellucid.com and keep Google unreachable. */
async function routeProduction(context) {
  const google = [];
  await context.route(`${PRODUCTION_ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const response = await route.fetch({
      url: appUrl(`${url.pathname}${url.search}`),
    });
    await route.fulfill({ response });
  });
  await context.route('https://www.googletagmanager.com/**', route => {
    google.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: '/* gtag.js stub: calls stay queued in dataLayer */',
    });
  });
  await context.route(/google-analytics\.com|analytics\.google\.com/, route => {
    google.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  return google;
}

async function readDataLayer(page) {
  return page.evaluate(() => (window.dataLayer ?? []).map(entry => (
    JSON.parse(JSON.stringify(
      Array.from(entry),
      (_key, value) => (value instanceof Date ? 'date' : value),
    ))
  )));
}

async function waitForEvent(page, name, predicate = '') {
  await page.waitForFunction(
    ([eventName, condition]) => (window.dataLayer ?? []).some(entry => (
      entry[0] === 'event' &&
      entry[1] === eventName &&
      (condition === '' || entry[2]?.outcome === condition)
    )),
    [name, predicate],
  );
}

async function hidePage(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function runSession(page, origin, waitFor, { localFiles = true } = {}) {
  await page.goto(sessionUrl(origin), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(FIRST);
  await waitFor('app_ready');

  await page.locator('#highlight-mode-lasso').click();
  await page.locator('#highlight-mode-lasso').click();
  await page.locator('#add-highlight-page').click();

  await page
    .locator('#dataset-select')
    .selectOption('dataset:local-demo:synthetic-development-3d');
  await expect(page.locator('#dataset-name')).toHaveText(SECOND);
  await waitFor('data_load', 'success');
  if (!localFiles) return;

  await page.locator('#user-data-h5ad-input').setInputFiles(h5adFixturePath);
  await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');

  const whole = await readFile(h5adFixturePath);
  await page.locator('#user-data-h5ad-input').setInputFiles({
    name: 'AML_relapse_donor7-private.h5ad',
    mimeType: 'application/octet-stream',
    buffer: whole.subarray(0, Math.floor(whole.length / 3)),
  });
  await waitFor('data_load', 'failure');
  await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
}

test('a production session sends exactly the declared events', async ({
  browserName,
  page,
  context,
}) => {
  const google = await routeProduction(context);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  // A direct .h5ad is read in a dedicated worker, and Firefox does not route
  // the requests a worker makes, so under the production hostname its script
  // would be fetched from the real www.cellucid.com. Firefox runs the session
  // without the two local-file loads; the local-origin test below covers them.
  const localFiles = browserName !== 'firefox';

  await runSession(page, PRODUCTION_ORIGIN, (name, outcome) => (
    waitForEvent(page, name, outcome)
  ), { localFiles });
  await hidePage(page);
  // Every metric is reported once, on the first hide; a second hide is inert.
  await hidePage(page);

  const dataLayer = await readDataLayer(page);
  expect(google.every(url => url.startsWith('https://www.googletagmanager.com/gtag/js'))).toBe(true);
  expect(pageErrors).toEqual([]);

  const config = dataLayer.filter(entry => entry[0] === 'config');
  expect(config).toEqual([
    ['config', 'G-K4774ZWGEQ', { page_location: `${PRODUCTION_ORIGIN}/` }],
  ]);
  const userProperties = dataLayer.filter(entry => entry[0] === 'set');
  expect(userProperties.map(entry => Object.keys(entry[2]))).toEqual([
    ['input_class', 'viewport_class'],
    ['renderer_class', 'smoke_supported'],
  ]);
  for (const [, kind, properties] of userProperties) {
    expect(kind).toBe('user_properties');
    expect(validateUserProperties(properties)).toEqual(properties);
  }

  const events = dataLayer.filter(entry => entry[0] === 'event');
  for (const [, name, params] of events) {
    // The exact payload, unchanged by validation: nothing undeclared.
    expect(validateEvent(name, params)).toEqual(params);
  }
  const appEvents = events.filter(([, name]) => name !== 'web_vital');
  expect(appEvents.map(([, name, params]) => [
    name,
    params.load_method ?? params.feature ?? null,
    params.outcome ?? params.variant ?? null,
  ])).toEqual([
    ['data_load', 'dataset-url-param', 'success'],
    ['app_ready', null, null],
    ['feature_used', 'highlight_tool', 'lasso'],
    ['feature_used', 'highlight_page', 'add'],
    ['data_load', 'dataset-dropdown', 'success'],
    ...(localFiles
      ? [
          ['data_load', 'local-user-h5ad', 'success'],
          ['data_load', 'local-user-h5ad', 'failure'],
        ]
      : []),
  ]);
  const [startupLoad, , , , switchLoad, localLoad, failedLoad] = appEvents
    .map(entry => entry[2]);
  // A catalog chosen with ?exportsBaseUrl= is not the public sample catalog.
  expect(startupLoad.dataset_id).toBeUndefined();
  expect(startupLoad).toMatchObject({
    source_type: 'local-demo',
    cell_bucket: '<1k',
    dimensions: '2',
    has_connectivity: 1,
    state_restore: 'none',
  });
  expect(switchLoad).toMatchObject({ dimensions: '3', has_vector_field: 1 });
  if (localFiles) {
    expect(localLoad).toMatchObject({ source_type: 'local-user', field_count: 2 });
    // A file that never parsed has no shape to describe, only its error class.
    expect(failedLoad).toMatchObject({ source_type: 'local-user' });
    expect(typeof failedLoad.error_name).toBe('string');
    expect(failedLoad.cell_bucket).toBeUndefined();
  }

  const metrics = events
    .filter(([, name]) => name === 'web_vital')
    .map(([, , params]) => params.metric_name);
  expect(new Set(metrics).size).toBe(metrics.length);
  // WebKit exposes none of the observed entry types, so it reports nothing.
  if (browserName === 'chromium') {
    expect(metrics).toEqual(expect.arrayContaining(['FCP', 'LCP', 'CLS']));
  }

  // Nothing the user named or opened is in any payload.
  const sent = JSON.stringify(dataLayer);
  for (const fragment of [
    'AML_relapse', 'donor7', 'current-ui-smoke', 'Synthetic', 'synthetic-',
    'exportsBaseUrl', 'tests/browser', '.h5ad', 'cell_type',
  ]) {
    expect(sent, fragment).not.toContain(fragment);
  }
});

test('a local origin runs the same session without any analytics', async ({
  page,
  context,
}) => {
  const google = [];
  await context.route(/googletagmanager\.com|google-analytics\.com|analytics\.google\.com/, route => {
    google.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await runSession(page, APP_ORIGIN, async (name, outcome) => {
    // Nothing is queued locally, so the session waits on the page instead.
    if (name === 'app_ready') {
      await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
    } else if (outcome === 'failure') {
      await expect(page.locator('#notification-center .notification-error').first()).toBeVisible();
    }
  });
  await hidePage(page);

  expect(google).toEqual([]);
  expect(await page.evaluate(() => ({
    enabled: window.cellucidAnalyticsEnabled,
    gtag: Object.hasOwn(window, 'gtag'),
    dataLayer: Object.hasOwn(window, 'dataLayer'),
  }))).toEqual({ enabled: false, gtag: false, dataLayer: false });
  // Off production every event is still validated; a violation would surface
  // here as an uncaught error.
  expect(pageErrors).toEqual([]);
});
