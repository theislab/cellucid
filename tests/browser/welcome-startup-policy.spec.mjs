import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import {
  APP_HOST,
  APP_ORIGIN,
  APP_PORT,
  SAMPLE_CATALOG_URL,
  appUrl,
} from './helpers/origins.mjs';
import { serveAnnDataServer } from './helpers/anndata-server.mjs';

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
      openCalls: 0,
      visibleFrames: 0,
    };

    // The welcome is a <dialog> the page opens with showModal().
    const originalShowModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function (...args) {
      if (this.id === 'welcome-modal') {
        globalThis.__cellucidWelcomePaintProbe.openCalls += 1;
      }
      return Reflect.apply(originalShowModal, this, args);
    };

    const inspectFrame = () => {
      const modal = document.getElementById('welcome-modal');
      if (modal !== null && modal.open) {
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
    openCalls: 0,
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

test('a failed exact remote-server intent keeps onboarding hidden and says why', async ({
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
  remoteUrl.searchParams.set('sampleCatalog', SAMPLE_CATALOG_URL);
  await page.goto(remoteUrl.toString(), { waitUntil: 'domcontentloaded' });

  // A server that does not answer is data that did not open: Cellucid
  // starts without it, and the failed opening says why with the ways on.
  const failed = page.locator('.opening-overlay[data-state="failed"]');
  await expect(failed).toBeVisible();
  await expect(failed.locator('.opening-title')).toHaveText('The data could not be opened');
  await expect(failed.locator('.welcome-details-text')).toContainText(
    'Remote health request failed with HTTP 503',
  );
  await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(failed.getByRole('button', { name: 'Open without this link' })).toBeVisible();
  await expect(page.locator('#cellucid-startup-failure')).toHaveCount(0);
  await expect(page.locator('#dataset-name')).toHaveText('No dataset open');
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
  await expect(page.locator('#dataset-name')).toHaveText('No dataset open');
  await expectWelcomeNeverPainted(page);
});
