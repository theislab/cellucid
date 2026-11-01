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
import { chooseFiles } from './helpers/file-input.mjs';

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
    'sampleCatalog',
    `${origin}/tests/browser/fixtures/demo-catalog/`,
  );
  url.searchParams.set('dataset', 'synthetic-cell-types-2d');
  return url.toString();
}

/** Serve the worktree as www.cellucid.com and keep Google unreachable. */
async function routeProduction(context) {
  const google = [];
  await context.route(`${PRODUCTION_ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    try {
      const response = await route.fetch({
        url: appUrl(`${url.pathname}${url.search}`),
      });
      await route.fulfill({ response });
    } catch (error) {
      // A page navigated away (the next viewer URL) lets go of the requests
      // it still had in flight, and their fetched responses with them
      // (Web contracts run 41269083996, Windows Chromium: "Fetch response
      // has been disposed"). Nothing waits for them; anything else fails.
      if (!/has been disposed|has been closed/.test(String(error?.message))) throw error;
    }
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

async function runSession(page, origin, waitFor) {
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

  await chooseFiles(page.locator('#user-data-file-input'), h5adFixturePath);
  await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');

  const whole = await readFile(h5adFixturePath);
  await chooseFiles(page.locator('#user-data-file-input'), {
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
  // Every dataset is read in the AnnData reader worker, and Firefox does not
  // route the requests a worker makes, so under the routed production
  // hostname nothing would open. The local-origin test below runs the same
  // session on Firefox.
  test.skip(browserName === 'firefox', 'Firefox does not route requests made by the AnnData reader worker');
  const google = await routeProduction(context);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await runSession(page, PRODUCTION_ORIGIN, (name, outcome) => (
    waitForEvent(page, name, outcome)
  ));
  // Whether the browser recorded a largest contentful paint at all: it
  // stops at the first input (here the Escape that closes the welcome
  // dialog), so a runner that painted no text or image before it has none
  // to report. Every one it has must be reported.
  const browserHasLcp = await page.evaluate(() => {
    if (!PerformanceObserver.supportedEntryTypes?.includes('largest-contentful-paint')) return false;
    const observer = new PerformanceObserver(() => {});
    observer.observe({ type: 'largest-contentful-paint', buffered: true });
    const recorded = observer.takeRecords().length > 0;
    observer.disconnect();
    return recorded;
  });
  await hidePage(page);
  // Every metric is reported once, on the first hide; a second hide is inert.
  await hidePage(page);

  const dataLayer = await readDataLayer(page);
  expect(google.every(url => url.startsWith('https://www.googletagmanager.com/gtag/js'))).toBe(true);
  expect(pageErrors).toEqual([]);

  // Before the tag: advertising use denied, Google signals off, and every
  // hit's location and referrer reduced to origin and path.
  expect(dataLayer.filter(entry => entry[0] === 'consent')).toEqual([
    ['consent', 'default', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'granted',
    }],
  ]);
  const address = { page_location: `${PRODUCTION_ORIGIN}/`, page_referrer: '' };
  expect(dataLayer.filter(entry => entry[0] === 'set' && entry[1] !== 'user_properties')).toEqual([
    ['set', address],
  ]);
  const config = dataLayer.filter(entry => entry[0] === 'config');
  expect(config).toEqual([
    ['config', 'G-K4774ZWGEQ', {
      ...address,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    }],
  ]);
  const userProperties = dataLayer.filter(entry => entry[0] === 'set' && entry[1] === 'user_properties');
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
    ['data_load', 'local-user-file', 'success'],
    ['data_load', 'local-user-file', 'failure'],
  ]);
  const [startupLoad, , , , switchLoad, localLoad, failedLoad] = appEvents
    .map(entry => entry[2]);
  // A catalog chosen with ?sampleCatalog= is not the public sample catalog.
  expect(startupLoad.dataset_id).toBeUndefined();
  expect(startupLoad).toMatchObject({
    source_type: 'local-demo',
    cell_bucket: '<1k',
    dimensions: '2',
    has_connectivity: 1,
    state_restore: 'none',
  });
  expect(switchLoad).toMatchObject({ dimensions: '3', has_vector_field: 1 });
  expect(localLoad).toMatchObject({ source_type: 'local-user', field_count: 2 });
  // A file that never parsed has no shape to describe, only its error class.
  expect(failedLoad).toMatchObject({ source_type: 'local-user' });
  expect(typeof failedLoad.error_name).toBe('string');
  expect(failedLoad.cell_bucket).toBeUndefined();

  const metrics = events
    .filter(([, name]) => name === 'web_vital')
    .map(([, , params]) => params.metric_name);
  expect(new Set(metrics).size).toBe(metrics.length);
  // WebKit exposes none of the observed entry types, so it reports nothing.
  if (browserName === 'chromium') {
    expect(metrics).toEqual(expect.arrayContaining(['FCP', 'CLS', ...(browserHasLcp ? ['LCP'] : [])]));
  }

  // Nothing the user named or opened is in any payload.
  const sent = JSON.stringify(dataLayer);
  for (const fragment of [
    'AML_relapse', 'donor7', 'current-ui-smoke', 'Synthetic', 'synthetic-',
    'sampleCatalog', 'tests/browser', '.h5ad', 'cell_type',
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

test('a viewer page on the production host never loads analytics', async ({ page, context }) => {
  // A notebook widget frames the hosted app as `?viewer=embedded`; a Python
  // or R browser-tab viewer is `?viewer=true…`. Neither ever reports.
  const google = await routeProduction(context);
  for (const search of ['?viewer=embedded', '?viewer=true&viewerId=v1&viewerToken=t1']) {
    await page.goto(`${PRODUCTION_ORIGIN}/${search}`, { waitUntil: 'domcontentloaded' });
    expect(await page.evaluate(() => ({
      enabled: window.cellucidAnalyticsEnabled,
      gtag: Object.hasOwn(window, 'gtag'),
      dataLayer: Object.hasOwn(window, 'dataLayer'),
      preconnect: [...document.querySelectorAll('link[rel="preconnect"]')].map(link => link.href),
    }))).toEqual({ enabled: false, gtag: false, dataLayer: false, preconnect: [] });
  }
  expect(google).toEqual([]);
});
