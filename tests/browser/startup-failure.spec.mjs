import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';

const catalogPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'catalog',
  'datasets.json',
);

test('invalid explicit remote intent stops on one visible startup failure', async ({
  page
}, testInfo) => {
  const pageErrors = [];
  const failedResponses = [];
  page.on('pageerror', error => {
    pageErrors.push(error.stack || error.message);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      failedResponses.push(`${response.status()}: ${response.url()}`);
    }
  });

  await page.goto('/?remote=', { waitUntil: 'domcontentloaded' });
  const failure = page.locator('#cellucid-startup-failure');
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute('role', 'alert');
  await expect(failure).toContainText('Cellucid could not start');
  await expect(failure).toContainText(
    'Startup URL parameter "remote" must be one non-empty exact value.'
  );
  await expect(failure).toHaveCount(1);
  await expect(page.locator('#dataset-cells')).not.toHaveText('120');
  await page.screenshot({
    path: testInfo.outputPath(
      `startup-failure-${testInfo.project.name}.png`
    ),
    fullPage: true
  });

  expect(pageErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});

/**
 * Holds every startup step deadline (60 s, `STARTUP_STEP_DEADLINE_MS`) until
 * the test expires it. The deadline runs on an ordinary timer, so only a timer
 * of exactly that length is held; every other timer keeps its real length.
 *
 * The deadlines used to be shortened to 400 ms instead, which made every step
 * race them: on a macOS WebKit runner reading the dataset took longer, and startup stalled there, before ever reaching the request the test
 * holds. Held, a step's deadline only fires when `expireStartupDeadlines` is
 * called, which the tests do once the request they hold is in flight; the
 * steps before it have released theirs by then.
 */
async function holdStartupDeadlines(page) {
  await page.addInitScript(() => {
    const realSetTimeout = window.setTimeout.bind(window);
    const realClearTimeout = window.clearTimeout.bind(window);
    const held = new Map();
    let nextId = -1;
    window.setTimeout = (handler, milliseconds, ...args) => {
      if (milliseconds !== 60_000) return realSetTimeout(handler, milliseconds, ...args);
      // Negative ids never collide with the browser's own timer ids.
      const id = nextId--;
      held.set(id, () => handler(...args));
      return id;
    };
    window.clearTimeout = id => {
      if (!held.delete(id)) realClearTimeout(id);
    };
    window.__expireStartupDeadlines = () => {
      const due = [...held.values()];
      held.clear();
      for (const fire of due) fire();
      return due.length;
    };
  });
}

/**
 * Holds every request matching `pattern` open forever: it neither answers nor
 * fails. The returned `inFlight` settles once the first one has been made.
 */
async function stallRequests(page, pattern) {
  let stalled = () => {};
  const inFlight = new Promise(resolve => {
    stalled = resolve;
  });
  await page.route(pattern, () => stalled());
  return { inFlight };
}

/** Expire the deadline of the step waiting on the stalled request. */
async function expireStartupDeadlines(page) {
  expect(await page.evaluate(() => window.__expireStartupDeadlines())).toBe(1);
}

test('a startup request that never answers names its phase and URL', async ({
  page
}) => {
  await holdStartupDeadlines(page);
  // The same-origin health probe is held open forever: it neither answers nor
  // fails, which is the stall that used to leave the page waiting with no word.
  const stalled = await stallRequests(page, '**/_cellucid/health');

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await stalled.inFlight;
  await expireStartupDeadlines(page);
  const failure = page.locator('#cellucid-startup-failure');
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute('role', 'alert');
  await expect(failure).toContainText(
    'Startup stalled while checking the data server'
  );
  await expect(failure).toContainText('/_cellucid/health did not answer within 60 s');
  await expect(page.locator('html')).toHaveAttribute(
    'data-startup-phase',
    'health'
  );
});

test('a stalled published default session ends startup naming its phase and URL', async ({
  page
}) => {
  await holdStartupDeadlines(page);
  // The catalog default advertises a published default session whose file
  // request is held open forever.
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  catalog.datasets[0].session = {
    path: 'current-ui.cellucid-session',
    bytes: 1,
    sha256: '0'.repeat(64),
  };
  await page.route('**/tests/browser/fixtures/catalog/datasets.json', route =>
    route.fulfill({
      body: JSON.stringify(catalog),
      contentType: 'application/json',
      status: 200,
    })
  );
  const stalled = await stallRequests(
    page,
    '**/tests/browser/fixtures/catalog/current-ui.cellucid-session'
  );

  await page.goto(
    `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}` +
      '&dataset=current-ui&acceptance=published-state-stall-ci',
    { waitUntil: 'domcontentloaded' }
  );
  await stalled.inFlight;
  await expireStartupDeadlines(page);
  const failure = page.locator('#cellucid-startup-failure');
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute('role', 'alert');
  await expect(failure).toContainText(
    'Startup stalled while reading the published default session'
  );
  await expect(failure).toContainText(
    '/catalog/current-ui.cellucid-session did not answer within 60 s'
  );
  await expect(failure).toHaveCount(1);
  await expect(page.locator('html')).toHaveAttribute(
    'data-startup-phase',
    'session'
  );
  await expect(page.locator('.notification-title', {
    hasText: 'Sample view unavailable'
  })).toHaveCount(0);
});

test('a successful startup publishes its phases and ends ready', async ({
  page
}) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute(
    'data-startup-phase',
    'ready'
  );
  await expect(page.locator('#cellucid-startup-failure')).toHaveCount(0);
});
