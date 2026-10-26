/**
 * Startup never offers a control it will not act on, and never leaves two
 * dialogs claiming the screen.
 *
 * The sidebar data-source controls are static markup, but the listeners that
 * act on them are attached by `initUI()`, which runs only once startup has read
 * its dataset catalog. They used to paint enabled and typeable for that whole
 * window, and a click there produced no request, no notification and no record
 * of any kind. Once they open, the startup dataset has not started loading
 * yet, and a choice made while it loads replaces it
 * (`dataset-load-supersede.spec.mjs`).
 *
 * The link is slowed by holding routes rather than by shipping large payloads:
 * this is a functional test of an ordering defect, not a measurement.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { openZarrFolder } from './helpers/dataset-drop.mjs';
import {
  APP_ORIGIN as ORIGIN,
  SAMPLE_ORIGIN,
} from './helpers/origins.mjs';

const fixturesDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);
const GOOD_CATALOG = `${ORIGIN}/tests/browser/fixtures/demo-catalog/`;
const GOOD_DATASET = Object.freeze({
  id: 'synthetic-cell-types-2d',
  name: 'Synthetic cell-type islands — 2D',
  cells: 72,
});
/**
 * A second dataset, so a local load visibly replaces the first: the one Zarr
 * store folder of the browser tests.
 */
const LOCAL_DATASET = Object.freeze({
  path: path.join(fixturesDirectory, 'forms-catalog', 'forms-zarr.zarr'),
  name: 'Forms — Zarr folder',
  cells: 48,
});

/** Every control a user can reach to point Cellucid at their own data. */
const DATA_SOURCE_CONTROLS = Object.freeze([
  '#dataset-select',
  '#user-data-open-btn',
  '#user-data-file-input',
  '#user-data-folder-input',
  '#data-address',
  '#data-address-open-btn',
]);

const STATUS = '#data-source-status';

function catalogUrl(baseUrl, datasetId) {
  const url = new URL('/', ORIGIN);
  url.searchParams.set('sampleCatalog', baseUrl);
  if (datasetId !== null) url.searchParams.set('dataset', datasetId);
  return url.toString();
}

/** Hold every catalog byte back until the test releases it. */
async function withHeldCatalog(page, run) {
  let release = null;
  const held = new Promise(resolve => {
    release = resolve;
  });
  await page.route(`${GOOD_CATALOG}**`, async route => {
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
  async ({ page, browserName }, testInfo) => {
    await withHeldCatalog(page, async releaseCatalog => {
      await page.goto(catalogUrl(GOOD_CATALOG, GOOD_DATASET.id), {
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

      releaseCatalog();
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

    // And they really work, rather than merely looking enabled: a Zarr
    // folder holding a different dataset replaces what startup put on screen.
    await openZarrFolder(page, browserName, LOCAL_DATASET.path);
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
  await page.goto(catalogUrl(GOOD_CATALOG, GOOD_DATASET.id), {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.locator('#dataset-name')).toHaveText(GOOD_DATASET.name);
  await page.keyboard.press('Escape');
  await expect(page.locator('#welcome-modal')).toBeHidden();

  const input = page.locator('#data-address');
  await input.focus();
  await expect(input).toBeFocused();
  await page.keyboard.type(`${SAMPLE_ORIGIN}/`);
  await expect(input).toHaveValue(`${SAMPLE_ORIGIN}/`);

  // Tab order is engine policy — WebKit does not put buttons in it unless full
  // keyboard access is on — so operability is what is asserted: the admitted
  // button takes focus and acts on a key press.
  const connect = page.locator('#data-address-open-btn');
  await connect.focus();
  await expect(connect).toBeFocused();
  await page.keyboard.press('Enter');
  // A bare address of this computer is a server's; the sample host there
  // answers, but not as a Cellucid server, and the notification says so.
  await expect(
    page.locator('#notification-center .notification').filter({
      hasText: `${SAMPLE_ORIGIN} answers, but it is not a Cellucid server`,
    }),
  ).toHaveCount(1);
});

test('a terminal startup failure leaves exactly one dialog on screen', async ({
  page,
}, testInfo) => {
  // Only a failure of the app itself is terminal (a dataset that does not
  // open leaves the app running): here, a browser with no WebGL2, after
  // onboarding has opened.
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
      return kind === 'webgl2' ? null : getContext.call(this, kind, ...rest);
    };
  });
  await page.goto(catalogUrl(GOOD_CATALOG, null), {
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
