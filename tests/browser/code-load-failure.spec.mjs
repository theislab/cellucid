import { expect, test } from './helpers/test.mjs';

import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui`;

test('a module that fails to download says so instead of starting forever', async ({
  page,
}) => {
  // Any module of the graph will do; one deep in it shows that a nested
  // dependency, not only main.js itself, reaches the watch. Its URL names its
  // bytes (index.html, CELLUCID_MODULE_VERSIONS).
  await page.route('**/assets/js/utils/deadline.js?v=*', route => route.abort());
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });

  const status = page.locator('#data-source-status');
  await expect(status).toHaveText(
    'Cellucid could not load its code: a request for one of its files failed. ' +
      'Check the network connection, then reload this page.',
  );
  await expect(status).toHaveAttribute('role', 'alert');
  await expect(status).toHaveClass(/\berror\b/);
  await expect(page.locator('html')).toHaveAttribute(
    'data-code-load-failed',
    'true',
  );
  // The app cannot run, so the startup failure screen says so over it, with
  // the file that failed folded under Details.
  const failure = page.locator('#cellucid-startup-failure');
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute('data-failure', 'code');
  await expect(failure).toHaveAttribute('data-code-failure', 'download');
  await expect(failure.locator('.welcome-title')).toHaveText('Cellucid could not load');
  await expect(failure.locator('.welcome-details-text')).toContainText('did not download');
  await expect(failure.getByRole('link', { name: 'Try again' })).toBeVisible();
});

const ANALYSIS_CODE = '**/assets/js/app/analysis/comparison-module.js?v=*';
const ENTRY_CODE = '**/assets/js/app/main.js?v=*';
const ANALYSIS_FAILED = 'The analysis tools could not load';

/**
 * Hold every request for `pattern` until `release()` fails it, as a
 * connection that drops would: `requested` resolves with the first one's URL.
 */
async function holdCode(page, pattern) {
  const held = [];
  let seen;
  const requested = new Promise(resolve => { seen = resolve; });
  await page.route(pattern, route => {
    held.push(route);
    seen(route.request().url());
  });
  return {
    requested,
    async release() {
      // A request the leaving page stopped itself (WebKit) is handled already.
      await Promise.all(held.splice(0).map(route => route.abort('connectionfailed').catch(() => {})));
      // Later requests (the next page's) load.
      await page.unroute(pattern);
    },
  };
}

/**
 * What the page says once the load of `url`, under way, has failed and
 * every continuation of that failure has run: the page imports the same
 * address (it joins the same load), and reports a task after its own import
 * fails. `reported` resolves with what it says.
 */
async function armFailureReport(page, url) {
  let report;
  const reported = new Promise(resolve => { report = resolve; });
  await page.exposeFunction('__reportAfterCodeFailure', said => report(said));
  await page.evaluate(address => {
    void import(address).catch(() => setTimeout(() => window.__reportAfterCodeFailure({
      codeLoadFailed: document.documentElement.dataset.codeLoadFailed ?? null,
      notifications: [...document.querySelectorAll('.notification-center .notification-message')].map(node => node.textContent),
    }), 0));
  }, url);
  return { reported };
}

/** The start has gone past taking up the analysis code (`main.js`), which it opens its dataset after. */
function analysisTakenUp(page) {
  return expect(page.locator('html')).toHaveAttribute('data-startup-phase', /^(dataset|positions|session|ready)$/);
}

function consoleErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

test('analysis tools that do not load say so', async ({ page }) => {
  const errors = consoleErrors(page);
  const analysis = await holdCode(page, ANALYSIS_CODE);
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await analysis.requested;
  await analysisTakenUp(page);
  await analysis.release();
  await expect(page.locator('.notification-center .notification-message', { hasText: ANALYSIS_FAILED })).toHaveCount(1);
  expect(errors.filter(text => text.includes(ANALYSIS_FAILED))).toHaveLength(1);
});

// The page takes up its analysis code as its start reaches the dataset
// (`main.js`, once the interface is built), and its own code at once (the
// code-load watch).
const CASES = [
  ['its analysis tools', ANALYSIS_CODE, analysisTakenUp],
  ['its own code', ENTRY_CODE, async () => {}],
];

// What shows a page asked to leave that it stays: the person acts on it, or
// the browser reports the navigation failed (Chromium, at Stay on the question
// of unkept work).
const STAYS = [
  ['a key pressed', page => page.keyboard.press('Shift')],
  ['a navigation that failed', page => page.evaluate(() => window.navigation.dispatchEvent(new Event('navigateerror')))],
];

for (const [what, pattern, started] of CASES) {
  test(`a page reloaded while ${what} load says nothing of the load its leaving stopped`, async ({ page }) => {
    const errors = consoleErrors(page);
    const code = await holdCode(page, pattern);
    await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
    const url = await code.requested;
    await started(page);
    const { reported } = await armFailureReport(page, url);
    // The reload's request is answered only once the page it leaves has met
    // the failed load: until then that page is the one shown.
    let said = null;
    let reloading = false;
    await page.route(address => address.pathname === '/', async route => {
      if (reloading || !route.request().isNavigationRequest()) return route.fallback();
      reloading = true;
      await code.release();
      said = await reported;
      return route.continue();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(said).toEqual({ codeLoadFailed: null, notifications: [] });
    expect(errors.filter(text => text.includes(ANALYSIS_FAILED))).toEqual([]);
  });

  for (const [how, stay] of STAYS) test(`a page that stays after it was asked to leave (${how}) says that ${what} did not load`, async ({ page }) => {
    const code = await holdCode(page, pattern);
    await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
    const url = await code.requested;
    await started(page);
    const { reported } = await armFailureReport(page, url);
    // A navigation that does not happen (stopped, a download, declined at the
    // question of unkept work) begins as one that does.
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
    await code.release();
    expect(await reported).toEqual({ codeLoadFailed: null, notifications: [] });
    // The page shows it stays, and the failure is said.
    await stay(page);
    if (pattern === ENTRY_CODE) {
      await expect(page.locator('#cellucid-startup-failure')).toHaveAttribute('data-code-failure', 'download');
    } else {
      await expect(page.locator('.notification-center .notification-message', { hasText: ANALYSIS_FAILED })).toHaveCount(1);
    }
  });
}
