import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import {
  APP_HOST,
  APP_ORIGIN,
  APP_PORT,
  SAMPLE_CATALOG_URL,
  appUrl,
} from './helpers/origins.mjs';
import { fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { jsonResponse, serveAnnDataServer } from './helpers/anndata-server.mjs';

const FIXTURE_ID = 'current-ui';
const FIXTURE_NAME = 'Current UI fixture';
const FIXTURE_FILE = fileURLToPath(
  new URL('./fixtures/catalog/current-ui.h5ad', import.meta.url),
);
const FIXTURE = Object.freeze({
  id: FIXTURE_ID,
  name: FIXTURE_NAME,
  file: FIXTURE_FILE,
  cells: 120,
  genes: 6,
});

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

async function expectDatasetWithoutWelcome(page) {
  await expect(page.locator('#dataset-name')).toHaveText(FIXTURE_NAME);
  await expectWelcomeNeverPainted(page);
}

test('an exact remote-server URL startup never shows or paints onboarding', async ({
  page,
}) => {
  const errors = collectBrowserErrors(page);
  await installWelcomePaintProbe(page);
  await serveAnnDataServer(page, APP_ORIGIN, FIXTURE, {
    info: { host: APP_HOST, port: APP_PORT },
  });

  const remoteUrl = new URL('/', APP_ORIGIN);
  remoteUrl.searchParams.set('remote', APP_ORIGIN);
  remoteUrl.searchParams.set('dataset', FIXTURE_ID);
  remoteUrl.searchParams.set('sampleCatalog', SAMPLE_CATALOG_URL);
  await page.goto(remoteUrl.toString(), { waitUntil: 'domcontentloaded' });

  await expectDatasetWithoutWelcome(page);
  expect(errors).toEqual([]);
});

test('an exact same-origin remote startup never shows or paints onboarding', async ({
  page,
}) => {
  const errors = collectBrowserErrors(page);
  await installWelcomePaintProbe(page);
  await serveAnnDataServer(page, APP_ORIGIN, FIXTURE, {
    info: { host: APP_HOST, port: APP_PORT },
  });

  const remoteUrl = new URL('/', APP_ORIGIN);
  remoteUrl.searchParams.set('source', 'remote');
  remoteUrl.searchParams.set('dataset', FIXTURE_ID);
  remoteUrl.searchParams.set('sampleCatalog', SAMPLE_CATALOG_URL);
  await page.goto(remoteUrl.toString(), { waitUntil: 'domcontentloaded' });

  await expectDatasetWithoutWelcome(page);
  expect(errors).toEqual([]);
});

test('an exact GitHub URL startup never shows or paints onboarding', async ({
  page,
}) => {
  const errors = collectBrowserErrors(page);
  await installWelcomePaintProbe(page);
  const rawPrefix =
    'https://raw.githubusercontent.com/cellucid-tests/data/HEAD/catalog/';
  await page.route(`${rawPrefix}datasets.json`, route =>
    jsonResponse(route, {
      schema: 2,
      default: FIXTURE_ID,
      datasets: [{ id: FIXTURE_ID, path: 'current-ui.h5ad' }],
    }));
  const bytes = readFileSync(FIXTURE_FILE);
  await page.route(`${rawPrefix}current-ui.h5ad`, route => fulfillFile(route, bytes));

  const githubUrl = new URL('/', APP_ORIGIN);
  githubUrl.searchParams.set(
    'data',
    'gh:cellucid-tests/data/catalog',
  );
  githubUrl.searchParams.set('dataset', FIXTURE_ID);
  githubUrl.searchParams.set('sampleCatalog', SAMPLE_CATALOG_URL);
  await page.goto(githubUrl.toString(), { waitUntil: 'domcontentloaded' });

  await expectDatasetWithoutWelcome(page);
  expect(errors).toEqual([]);
});

test('an exact authenticated Jupyter URL startup never shows or paints onboarding', async ({
  page,
}) => {
  const errors = collectBrowserErrors(page);
  await installWelcomePaintProbe(page);
  await serveAnnDataServer(page, APP_ORIGIN, FIXTURE, { jupyter: true });

  const jupyterUrl = new URL('/', APP_ORIGIN);
  jupyterUrl.searchParams.set('jupyter', 'true');
  jupyterUrl.searchParams.set('viewerId', 'viewer-1');
  jupyterUrl.searchParams.set('viewerToken', 'token-1');
  await page.goto(jupyterUrl.toString(), { waitUntil: 'domcontentloaded' });

  await expectDatasetWithoutWelcome(page);
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
