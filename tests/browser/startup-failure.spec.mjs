import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from './helpers/test.mjs';
import { appUrl, ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { tabKey } from './helpers/dialog-keys.mjs';

const catalogPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'catalog',
  'datasets.json',
);

test('a link Cellucid cannot read leaves it running and says what is wrong with the link', async ({
  page
}) => {
  // R9E-1: each of these stopped Cellucid on "Cellucid could not start —
  // Something went wrong while starting", Try again first.
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  const catalog = `sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`;
  for (const [search, said] of [
    [`${catalog}&remote=`, 'This link\'s "remote" has no value.'],
    [`${catalog}&dataset=a&dataset=b`, 'This link names "dataset" 2 times; a link names it once.'],
    [`${catalog}&dataset=%20a`, 'This link\'s "dataset" has spaces around its value (" a"); remove them.'],
    [`${catalog}&anndata=1`, 'This link\'s "anndata" is "1"; it can only be "true".'],
    [`${catalog}&source=foo`, 'This link\'s "source" is "foo"; a link\'s source is "local-demo" (a sample dataset) or "remote" (a Cellucid server).'],
    [`${catalog}&remote=http%3A%2F%2F127.0.0.1%3A1&data=x`, 'This link names both a Cellucid server ("remote") and data ("data"); a link opens one of them.'],
    [`${catalog}&viewer=1`, /^This link is the address of a viewer that Python or R opened/],
  ]) {
    await page.goto(`/?${search}`, { waitUntil: 'domcontentloaded' });
    const failed = page.locator('.opening-overlay[data-state="failed"]');
    await expect(failed, search).toBeVisible();
    await expect(page.locator('#cellucid-startup-failure')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
    await expect(failed.locator('.opening-step'), search).toHaveText(said);
    // Opening the same link again meets the same refusal: the way on leads.
    await expect(failed.locator('.opening-actions button')).toHaveText(['Open without this link', 'Try again']);
    await expect(page.locator('#welcome-modal[open]')).toHaveCount(0);
    await expect(page.locator('#dataset-name')).toHaveText('No dataset open');
  }
  // Open without this link drops every parameter the link named its data
  // with, and keeps the page's own (the sample catalog).
  await page.locator('.opening-overlay').getByRole('button', { name: 'Open without this link' }).click();
  expect([...new URL(page.url()).searchParams.keys()]).toEqual(['sampleCatalog']);
  expect(pageErrors).toEqual([]);
});

test('the startup failure screen holds the keyboard and folds the technical message under Details', async ({
  page
}, testInfo) => {
  // A browser older than Cellucid needs: the one screen the app cannot run past.
  await page.addInitScript(() => {
    AbortSignal.any = undefined;
  });
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`, { waitUntil: 'domcontentloaded' });
  const failure = page.locator('#cellucid-startup-failure');
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute('role', 'alert');
  await expect(failure).toHaveAttribute('data-failure', 'browser');
  await expect(failure).toHaveCount(1);
  await expect(failure.locator('.welcome-title')).toHaveText('This browser cannot run Cellucid');
  await expect(failure.locator('.welcome-intro')).not.toContainText('AbortSignal');
  // The application behind it is out of reach: Tab stays on the screen.
  // WebKit, like Safari, moves to links and buttons with Option+Tab (plain
  // Tab reaches them only with "Press Tab to highlight each item" on).
  await page.keyboard.press(tabKey(testInfo.project.name));
  await expect(failure.getByRole('link', { name: 'Try again' })).toBeFocused();
  const details = failure.locator('details.welcome-details');
  await expect(details).not.toHaveAttribute('open', /.*/);
  await expect(details.locator('.welcome-details-text')).toBeHidden();
  await details.locator('summary').click();
  await expect(details.locator('.welcome-details-text')).toContainText('This browser lacks AbortSignal.any');
  await page.screenshot({
    path: testInfo.outputPath(
      `startup-failure-${testInfo.project.name}.png`
    ),
    fullPage: true
  });
});

test('a data link that does not open leaves Cellucid running and offers the ways on', async ({
  page
}) => {
  const missing = appUrl('/tests/browser/fixtures/missing-startup-link.h5ad');
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(missing)}&dataset=x`, { waitUntil: 'domcontentloaded' });
  // Not the startup failure screen: the app starts, and the failed opening
  // says why over the empty viewer.
  const failed = page.locator('.opening-overlay[data-state="failed"]');
  await expect(failed).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
  await expect(page.locator('#cellucid-startup-failure')).toHaveCount(0);
  await expect(failed.locator('.opening-title')).toHaveText('The data could not be opened');
  // The reason itself, not a generic "could not read", and said once: no
  // card beside the dialog repeats it.
  // The host's own answer, said as the host's (`formats/io/byte-source.js`).
  const reason = /^missing-startup-link\.h5ad was not found at .* \(HTTP 404, not found\): the link or record does not exist, or it moved\. Check the link, or ask its owner\.$/;
  await expect(failed.locator('.opening-step')).toHaveText(reason);
  await expect(failed.locator('.welcome-details-text')).toBeHidden();
  await expect(failed.locator('.welcome-details-text')).toContainText('missing-startup-link.h5ad');
  await expect(page.locator('.notification', { hasText: 'missing-startup-link.h5ad' })).toHaveCount(0);
  // A missing file stays missing however often it is asked for: the way on
  // the failure leads with is opening Cellucid without the link.
  await expect(failed.locator('.opening-actions button')).toHaveText(['Open without this link', 'Try again']);
  await expect(failed.getByRole('button', { name: 'Open without this link' })).toBeFocused();

  // Open without this link: the failure goes, the address loses the link's
  // parameters and nothing else, and the app is there to use.
  await failed.getByRole('button', { name: 'Open without this link' }).click();
  await expect(page.locator('.opening-overlay[data-state="failed"]')).toHaveCount(0);
  expect([...new URL(page.url()).searchParams.keys()]).toEqual(['sampleCatalog']);
  await expect(page.locator('#dataset-name')).toHaveText('No dataset open');
  await expect(page.locator('#user-data-open-btn')).toBeEnabled();
  // The empty viewer says what it waits for and where (R9E-10), and its
  // button shows that place.
  const empty = page.locator('.opening-overlay[data-state="empty"]');
  await expect(empty).toBeVisible();
  await expect(empty.locator('.opening-title')).toHaveText('No dataset open');
  await expect(empty.locator('.opening-step')).toHaveText(
    'Choose a sample, open a file or folder, or paste a link in Session › Open data; a file can also be dropped here.'
  );
  await empty.getByRole('button', { name: 'Show Open data' }).click();
  await expect(page.locator('#dataset-select')).toBeFocused();
  // A dataset chosen there takes the panel away.
  await page.locator('#dataset-select').selectOption({ index: 1 });
  await expect(page.locator('#dataset-name')).not.toHaveText('No dataset open');
  await expect(page.locator('.opening-overlay')).toBeHidden();
});

test('a browser without WebGL2 is told so, and no link setting is offered', async ({
  page
}) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
      return kind === 'webgl2' ? null : getContext.call(this, kind, ...rest);
    };
  });
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`, { waitUntil: 'domcontentloaded' });
  const failure = page.locator('#cellucid-startup-failure');
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute('data-failure', 'browser');
  await expect(failure.locator('.welcome-title')).toHaveText('This browser cannot run Cellucid');
  await expect(failure.getByRole('link', { name: 'System requirements' })).toBeVisible();
  await expect(failure.getByRole('link', { name: 'Open Cellucid without this link' })).toHaveCount(0);
});

test('a browser whose graphics process hands back a lost context is told to reload, not shown a shader failure', async ({
  page
}) => {
  // WebKit after a GPU reset gives every new context lost (WebKit bug
  // 328185): the viewer's context is lost as it is made.
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
      const context = getContext.call(this, kind, ...rest);
      if (kind === 'webgl2' && context !== null && !context.isContextLost()) {
        context.getExtension('WEBGL_lose_context').loseContext();
      }
      return context;
    };
  });
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`, { waitUntil: 'domcontentloaded' });
  const failure = page.locator('#cellucid-startup-failure');
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute('data-failure', 'graphics');
  await expect(failure.locator('.welcome-title')).toHaveText('The browser\u2019s graphics stopped working');
  await expect(failure).toContainText('Reload the page; if this happens again, restart the browser.');
  await expect(failure).not.toContainText(/shader/i);
  await expect(failure.getByRole('link', { name: 'Open Cellucid without this link' })).toHaveCount(0);
  expect(errors.filter(message => /shader/i.test(message))).toEqual([]);
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
 * steps before it have released theirs by then. The opening's own stall
 * measure has the same length but stands down while a step's deadline runs
 * (`onStartupStepDeadline` in `app/startup-phase.js`), so exactly one held
 * timer, the waiting step's deadline, is what the tests expire.
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
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute(
    'data-startup-phase',
    'ready'
  );
  await expect(page.locator('#cellucid-startup-failure')).toHaveCount(0);
});

test('a failed opening stays in view above the sidebar, which open on a phone fills the screen', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const missing = appUrl('/tests/browser/fixtures/missing-startup-link.h5ad');
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(missing)}&dataset=x`, { waitUntil: 'domcontentloaded' });
  const failed = page.locator('.opening-overlay[data-state="failed"]');
  await expect(failed).toBeVisible();
  const panel = failed.locator('.opening-panel');
  const sidebar = page.locator('#sidebar');
  // The phone panel starts as its peek bar; opened full screen, it lies
  // under the failed opening, which stays on top.
  await page.locator('#phone-sheet-bar').dispatchEvent('click');
  await expect(sidebar).not.toHaveClass(/\bhidden\b/);
  await expect(sidebar).toBeVisible();
  // Measured once it has slid in: the sheet is the whole screen.
  await expect.poll(async () => {
    const box = await sidebar.boundingBox();
    return box === null ? null : { x: Math.round(box.x), width: Math.round(box.width) };
  }).toEqual({ x: 0, width: 390 });
  const [panelBox, sidebarBox] = [await panel.boundingBox(), await sidebar.boundingBox()];
  // The two overlap: the sidebar covers the middle of the screen.
  expect(sidebarBox.x < panelBox.x + panelBox.width && panelBox.x < sidebarBox.x + sidebarBox.width).toBe(true);
  expect(sidebarBox.y < panelBox.y + panelBox.height && panelBox.y < sidebarBox.y + sidebarBox.height).toBe(true);
  // The panel is what is under the pointer there, and its ways on take a click.
  const onTop = await panel.evaluate(element => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return element.contains(hit);
  });
  expect(onTop).toBe(true);
  await failed.getByRole('button', { name: 'Try again' }).click({ trial: true });
  await failed.getByRole('button', { name: 'Open without this link' }).click({ trial: true });
});

test('a dataset that stops arriving before its first view is a data failure, not a startup failure', async ({
  page
}) => {
  await holdStartupDeadlines(page);
  // Every read of the dataset's file is held open: nothing arrives. They are
  // let through at the end, so the dataset list finishes and the app can be
  // retired.
  const held = [];
  let inFlight = () => {};
  const stalled = { inFlight: new Promise(resolve => { inFlight = resolve; }) };
  await page.route('**/tests/browser/fixtures/catalog/current-ui.h5ad', route => {
    held.push(route);
    inFlight();
  });
  await page.goto(
    `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui`,
    { waitUntil: 'domcontentloaded' }
  );
  await stalled.inFlight;
  await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'dataset');
  expect(await page.evaluate(() => window.__expireStartupDeadlines())).toBeGreaterThanOrEqual(1);
  // Cellucid runs without it: the opening fails over the empty viewer, with
  // the ways on, and the startup failure screen is not shown.
  const failed = page.locator('.opening-overlay[data-state="failed"]');
  await expect(failed).toBeVisible();
  await expect(failed.locator('.opening-title')).toHaveText('The data could not be opened');
  await expect(failed.locator('.welcome-details-text')).toContainText('Startup stalled while opening the dataset');
  await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(failed.getByRole('button', { name: 'Open without this link' })).toBeVisible();
  await expect(page.locator('#cellucid-startup-failure')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
  expect(await page.evaluate(() => window._cellucidViewer.isDisposed())).toBe(false);
  await Promise.all(held.map(route => route.fallback().catch(() => {})));
});
