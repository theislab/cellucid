/**
 * Startup never offers a control it will not act on, and never leaves two
 * dialogs claiming the screen.
 *
 * The sidebar data-source controls are static markup, but the listeners that
 * act on them are attached by `initUI()`, which does not run until the initial
 * dataset has finished loading. They used to paint enabled and typeable for
 * that whole window, and a click there produced no request, no notification and
 * no record of any kind — a user who landed on the page and immediately picked
 * their own `.h5ad` watched the demo dataset stay put with no explanation.
 *
 * The link is slowed by holding routes rather than by shipping large payloads:
 * this is a functional test of an ordering defect, not a measurement.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  APP_ORIGIN as ORIGIN,
  SAMPLE_ORIGIN,
} from './helpers/origins.mjs';

const fixturesDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);
const GOOD_EXPORTS = `${ORIGIN}/tests/browser/fixtures/demo-custom-exports/`;
const BROKEN_EXPORTS = `${ORIGIN}/tests/browser/fixtures/broken-exports/`;
const GOOD_DATASET = Object.freeze({
  id: 'synthetic-cell-types-2d',
  name: 'Synthetic cell-type islands — 2D',
  cells: 72,
});
/** A second prepared export, so a local load visibly replaces the first. */
const LOCAL_DATASET = Object.freeze({
  id: 'synthetic-trajectory-1d',
  name: 'Synthetic trajectory — 1D',
  cells: 48,
});

/** Every control a user can reach to point Cellucid at their own data. */
const DATA_SOURCE_CONTROLS = Object.freeze([
  '#dataset-select',
  '#user-data-h5ad-btn',
  '#user-data-zarr-archive-btn',
  '#user-data-browse-btn',
  '#user-data-file-input',
  '#user-data-h5ad-input',
  '#user-data-zarr-archive-input',
  '#remote-server-url',
  '#remote-connect-btn',
  '#github-repo-url',
  '#github-connect-btn',
]);

const STATUS = '#data-source-status';

function exportsUrl(baseUrl, datasetId) {
  const url = new URL('/', ORIGIN);
  url.searchParams.set('exportsBaseUrl', baseUrl);
  if (datasetId !== null) url.searchParams.set('dataset', datasetId);
  return url.toString();
}

/** Hold every export byte back until the test releases it. */
async function withHeldExports(page, run) {
  let release = null;
  const held = new Promise(resolve => {
    release = resolve;
  });
  await page.route(`${GOOD_EXPORTS}**`, async route => {
    await held;
    await route.continue();
  });
  try {
    return await run(() => release());
  } finally {
    release();
  }
}

async function readControlStates(page) {
  return page.evaluate(controls => Object.fromEntries(
    controls.map(selector => {
      const element = document.querySelector(selector);
      return [selector, element === null ? 'absent' : element.disabled];
    })), DATA_SOURCE_CONTROLS);
}

test(
  'no data-source control is offered while its listener is unattached',
  async ({ page }, testInfo) => {
    await withHeldExports(page, async releaseExports => {
      await page.goto(exportsUrl(GOOD_EXPORTS, GOOD_DATASET.id), {
        waitUntil: 'domcontentloaded',
      });

      // The static sidebar has painted; the dataset is still in flight.
      await expect(page.locator('#user-data-block')).toBeVisible();
      const duringStartup = await readControlStates(page);
      await testInfo.attach('controls-during-startup.json', {
        body: JSON.stringify(duringStartup, null, 2),
        contentType: 'application/json',
      });
      for (const [selector, disabled] of Object.entries(duringStartup)) {
        expect(
          disabled,
          `${selector} must not be offered before it is wired`,
        ).toBe(true);
      }

      // The disabled state is announced, not merely drawn: a live region says
      // why, and every control points at it.
      const status = page.locator(STATUS);
      await expect(status).toBeVisible();
      await expect(status).toHaveAttribute('role', 'status');
      await expect(status).toHaveAttribute('aria-live', 'polite');
      await expect(status).toContainText('Starting Cellucid');
      for (const selector of DATA_SOURCE_CONTROLS) {
        if (selector.endsWith('-input') && selector.includes('user-data-')) {
          continue;
        }
        await expect(page.locator(selector)).toHaveAttribute(
          'aria-describedby',
          'data-source-status',
        );
      }

      releaseExports();
    });

    // Once startup completes every control becomes usable and the change is
    // announced through the same live region.
    await expect(page.locator('#dataset-name')).toHaveText(GOOD_DATASET.name);
    for (const selector of DATA_SOURCE_CONTROLS) {
      await expect(page.locator(selector)).toBeEnabled();
    }
    await expect(page.locator(STATUS)).toContainText(
      'Data sources are ready',
    );
    await expect(page.locator(STATUS)).toHaveClass('sr-only');

    // And they really work, rather than merely looking enabled: a directory
    // holding a different dataset replaces what startup put on screen.
    await page
      .locator('#user-data-file-input')
      .setInputFiles(path.join(
        fixturesDirectory, 'demo-custom-exports', LOCAL_DATASET.id,
      ));
    await expect(page.locator('#dataset-name')).toHaveText(LOCAL_DATASET.name);
    await expect(page.locator('#dataset-cells')).toHaveText(
      String(LOCAL_DATASET.cells),
    );
    await expect
      .poll(() => page.evaluate(() => window._cellucidViewer.getPointCount()))
      .toBe(LOCAL_DATASET.cells);
  },
);

test('a keyboard user can reach and use the controls once they open', async ({
  page,
}) => {
  await page.goto(exportsUrl(GOOD_EXPORTS, GOOD_DATASET.id), {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.locator('#dataset-name')).toHaveText(GOOD_DATASET.name);
  await page.keyboard.press('Escape');
  await expect(page.locator('#welcome-modal')).toBeHidden();

  const input = page.locator('#remote-server-url');
  await input.focus();
  await expect(input).toBeFocused();
  await page.keyboard.type(`${SAMPLE_ORIGIN}/`);
  await expect(input).toHaveValue(`${SAMPLE_ORIGIN}/`);

  // Tab order is engine policy — WebKit does not put buttons in it unless full
  // keyboard access is on — so operability is what is asserted: the admitted
  // button takes focus and acts on a key press.
  const connect = page.locator('#remote-connect-btn');
  await connect.focus();
  await expect(connect).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.locator('#notification-center .notification').filter({
      hasText: /The remote server/,
    }),
  ).toHaveCount(1);
});

test('a terminal startup failure leaves exactly one dialog on screen', async ({
  page,
}, testInfo) => {
  await page.goto(exportsUrl(`${BROKEN_EXPORTS}corrupt-payload/`, null), {
    waitUntil: 'domcontentloaded',
  });

  const failure = page.locator('#cellucid-startup-failure');
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute('role', 'alert');

  // Onboarding invites the user into an application that no longer exists.
  const welcome = page.locator('#welcome-modal');
  await expect(welcome).toBeHidden();
  const observed = await page.evaluate(() => {
    const modal = document.getElementById('welcome-modal');
    return {
      welcomeClass: modal.getAttribute('class'),
      welcomeHeight: modal.getBoundingClientRect().height,
      focusedId: document.activeElement === null
        ? null
        : document.activeElement.id,
      dialogCount: document.querySelectorAll(
        '[role="dialog"]:not(.hidden):not([hidden]), [role="alert"]',
      ).length,
    };
  });
  await testInfo.attach('terminal-failure-surfaces.json', {
    body: JSON.stringify(observed, null, 2),
    contentType: 'application/json',
  });
  expect(observed.welcomeHeight).toBe(0);
  expect(observed.dialogCount).toBe(1);
  // Focus is not stranded on a control inside the dialog that just closed.
  expect(observed.focusedId).toBe('cellucid-startup-failure');

  // The retracted dialog must also release the Tab trap it was holding.
  await page.keyboard.press('Tab');
  await expect(welcome).toBeHidden();
});
