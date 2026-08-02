import { expect, test } from '@playwright/test';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_HOST,
  APP_ORIGIN,
  APP_PORT,
  appUrl,
  EXPORTS_BASE_URL,
} from './helpers/origins.mjs';

const FIXTURE_ID = 'current-ui-prepared';
const FIXTURE_NAME = 'Current UI prepared fixture';
const FIXTURE_ROOT = fileURLToPath(
  new URL('./fixtures/exports/current-ui-prepared/', import.meta.url),
);

function jsonResponse(route, payload) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(payload),
  });
}

function contentTypeForFixture(path) {
  if (extname(path) === '.json') return 'application/json';
  return 'application/octet-stream';
}

async function installPreparedFixtureRoute(page, requestPrefix) {
  await page.route(`${requestPrefix}**`, async route => {
    const requestUrl = route.request().url();
    if (!requestUrl.startsWith(requestPrefix)) {
      throw new Error(`Unexpected prepared fixture URL: ${requestUrl}`);
    }
    const relativePath = decodeURIComponent(
      requestUrl.slice(requestPrefix.length),
    );
    if (
      relativePath.length === 0
      || relativePath.startsWith('/')
      || relativePath.includes('\\')
      || relativePath.split('/').some(part => part === '' || part === '..')
    ) {
      throw new Error(`Invalid prepared fixture path: ${relativePath}`);
    }
    await route.fulfill({
      status: 200,
      contentType: contentTypeForFixture(relativePath),
      headers: { 'Access-Control-Allow-Origin': '*' },
      path: join(FIXTURE_ROOT, ...relativePath.split('/')),
    });
  });
}

async function installPreparedRemoteServer(page) {
  await page.route(appUrl('/_cellucid/health'), route =>
    jsonResponse(route, {
      status: 'ok',
      type: 'exported',
      version: '0.9.1',
    }));
  await page.route(appUrl('/_cellucid/info'), route =>
    jsonResponse(route, {
      version: '0.9.1',
      host: APP_HOST,
      port: APP_PORT,
      mode: 'standalone',
    }));
  await page.route(appUrl('/_cellucid/datasets'), route =>
    jsonResponse(route, {
      datasets: [{
        id: FIXTURE_ID,
        path: '/remote-fixture/',
        name: FIXTURE_NAME,
      }],
    }));
  await installPreparedFixtureRoute(page, appUrl('/remote-fixture/'));
}

async function installWelcomePaintProbe(page) {
  await page.addInitScript(() => {
    globalThis.__cellucidWelcomePaintProbe = {
      unhideCalls: 0,
      visibleFrames: 0,
    };

    const originalRemove = DOMTokenList.prototype.remove;
    DOMTokenList.prototype.remove = function (...tokens) {
      const modal = document.getElementById('welcome-modal');
      if (
        modal !== null
        && modal.classList === this
        && tokens.includes('hidden')
      ) {
        globalThis.__cellucidWelcomePaintProbe.unhideCalls += 1;
      }
      return Reflect.apply(originalRemove, this, tokens);
    };

    const inspectFrame = () => {
      const modal = document.getElementById('welcome-modal');
      if (modal !== null && !modal.classList.contains('hidden')) {
        globalThis.__cellucidWelcomePaintProbe.visibleFrames += 1;
      }
      requestAnimationFrame(inspectFrame);
    };
    requestAnimationFrame(inspectFrame);
  });
}

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  return errors;
}

async function expectWelcomeNeverPainted(page) {
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  expect(await page.evaluate(
    () => globalThis.__cellucidWelcomePaintProbe,
  )).toEqual({
    unhideCalls: 0,
    visibleFrames: 0,
  });
}

async function expectPreparedDatasetWithoutWelcome(page) {
  await expect(page.locator('#dataset-name')).toHaveText(FIXTURE_NAME);
  await expectWelcomeNeverPainted(page);
}

test('an exact remote-server URL startup never shows or paints onboarding', async ({
  page,
}) => {
  const errors = collectBrowserErrors(page);
  await installWelcomePaintProbe(page);
  await installPreparedRemoteServer(page);

  const remoteUrl = new URL('/', APP_ORIGIN);
  remoteUrl.searchParams.set('remote', APP_ORIGIN);
  remoteUrl.searchParams.set('dataset', FIXTURE_ID);
  remoteUrl.searchParams.set('exportsBaseUrl', EXPORTS_BASE_URL);
  await page.goto(remoteUrl.toString(), { waitUntil: 'domcontentloaded' });

  await expectPreparedDatasetWithoutWelcome(page);
  expect(errors).toEqual([]);
});

test('an exact same-origin remote startup never shows or paints onboarding', async ({
  page,
}) => {
  const errors = collectBrowserErrors(page);
  await installWelcomePaintProbe(page);
  await installPreparedRemoteServer(page);

  const remoteUrl = new URL('/', APP_ORIGIN);
  remoteUrl.searchParams.set('source', 'remote');
  remoteUrl.searchParams.set('dataset', FIXTURE_ID);
  remoteUrl.searchParams.set('exportsBaseUrl', EXPORTS_BASE_URL);
  await page.goto(remoteUrl.toString(), { waitUntil: 'domcontentloaded' });

  await expectPreparedDatasetWithoutWelcome(page);
  expect(errors).toEqual([]);
});

test('an exact GitHub URL startup never shows or paints onboarding', async ({
  page,
}) => {
  const errors = collectBrowserErrors(page);
  await installWelcomePaintProbe(page);
  const rawPrefix =
    'https://raw.githubusercontent.com/cellucid-tests/data/main/exports/';
  await page.route(`${rawPrefix}datasets.json`, route =>
    jsonResponse(route, {
      version: 1,
      default: FIXTURE_ID,
      datasets: [{
        id: FIXTURE_ID,
        name: FIXTURE_NAME,
        path: `${FIXTURE_ID}/`,
        n_cells: 120,
        n_genes: 6,
      }],
    }));
  await installPreparedFixtureRoute(
    page,
    `${rawPrefix}${FIXTURE_ID}/`,
  );

  const githubUrl = new URL('/', APP_ORIGIN);
  githubUrl.searchParams.set(
    'github',
    'cellucid-tests/data/exports',
  );
  githubUrl.searchParams.set('dataset', FIXTURE_ID);
  githubUrl.searchParams.set('exportsBaseUrl', EXPORTS_BASE_URL);
  await page.goto(githubUrl.toString(), { waitUntil: 'domcontentloaded' });

  await expectPreparedDatasetWithoutWelcome(page);
  expect(errors).toEqual([]);
});

test('an exact authenticated Jupyter URL startup never shows or paints onboarding', async ({
  page,
}) => {
  const errors = collectBrowserErrors(page);
  await installWelcomePaintProbe(page);
  await page.route(appUrl('/_cellucid/health'), route =>
    jsonResponse(route, {
      status: 'ok',
      type: 'exported',
      version: '0.9.1',
    }));
  await page.route(appUrl('/_cellucid/datasets'), route =>
    jsonResponse(route, {
      datasets: [{
        id: FIXTURE_ID,
        path: '/jupyter-fixture/',
        name: FIXTURE_NAME,
      }],
    }));
  await page.route(appUrl('/_cellucid/events'), route =>
    jsonResponse(route, { status: 'ok', delivered: true }));
  await installPreparedFixtureRoute(page, appUrl('/jupyter-fixture/'));

  const jupyterUrl = new URL('/', APP_ORIGIN);
  jupyterUrl.searchParams.set('jupyter', 'true');
  jupyterUrl.searchParams.set('viewerId', 'viewer-1');
  jupyterUrl.searchParams.set('viewerToken', 'token-1');
  await page.goto(jupyterUrl.toString(), { waitUntil: 'domcontentloaded' });

  await expectPreparedDatasetWithoutWelcome(page);
  expect(errors).toEqual([]);
});

test('a failed exact remote-server intent keeps onboarding hidden and owns the failure', async ({
  page,
}) => {
  await installWelcomePaintProbe(page);
  await page.route(appUrl('/_cellucid/health'), route =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'synthetic outage' }),
    }));

  const remoteUrl = new URL('/', APP_ORIGIN);
  remoteUrl.searchParams.set('remote', APP_ORIGIN);
  await page.goto(remoteUrl.toString(), { waitUntil: 'domcontentloaded' });

  const failure = page.locator('#cellucid-startup-failure');
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute('role', 'alert');
  await expect(failure).toContainText('Cellucid could not start');
  await expect(failure).toContainText(
    'Remote health request failed with HTTP 503',
  );
  await expect(failure).toContainText(
    'Correct the launch configuration or server response, then reload this page.',
  );
  await expect(failure).toHaveCount(1);
  await expect(page.locator('#dataset-name')).toHaveText('–');
  await expectWelcomeNeverPainted(page);
});

test('a failed exact same-origin AnnData intent keeps onboarding hidden', async ({
  page,
}) => {
  await installWelcomePaintProbe(page);
  await page.route(appUrl('/_cellucid/health'), route =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'synthetic AnnData outage' }),
    }));

  await page.goto('/?anndata=true', { waitUntil: 'domcontentloaded' });

  const failure = page.locator('#cellucid-startup-failure');
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute('role', 'alert');
  await expect(failure).toContainText('Cellucid could not start');
  await expect(failure).toContainText(
    'Same-origin Cellucid health request failed with HTTP 503.',
  );
  await expect(failure).toHaveCount(1);
  await expect(page.locator('#dataset-name')).toHaveText('–');
  await expectWelcomeNeverPainted(page);
});
