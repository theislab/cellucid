/**
 * A dataset choice made while another dataset is still loading replaces it.
 *
 * Every dataset change — the startup selection, a sample, None, a file, a
 * folder, a connection that opens its only dataset, the benchmark — begins one
 * transaction when the user acts, and beginning one aborts the load in flight.
 * A choice made during a load used to be discarded behind it (the startup
 * load ran before any control was wired), or to lose to it (a file still being
 * read published over a sample chosen after it).
 *
 * Each case holds the load in flight at the transport, makes the second
 * choice, and then lets the held requests go. The end state must be exactly the
 * last choice — the dataset select, the dataset panel, the viewer and the
 * startup phase agree — and the superseded load must never publish, never
 * leave a progress notification or a pending select entry behind, and never
 * log a product error.
 */
import path from 'node:path';
import {
  closePageWithApplicationRetirement,
  expect,
  test,
} from './helpers/test.mjs';
import { chooseDirectory } from './helpers/directory-upload.mjs';
import { SAMPLE_ORIGIN, SAMPLE_PORT, appUrl } from './helpers/origins.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import {
  DEVELOPMENT,
  EXPORTS,
  H5AD,
  H5AD_PATH,
  NONE,
  PENDING_OPTION,
  START,
  TRAJECTORY,
  chooseSessionFile,
  demoExportsDirectory,
  expectAnnouncedOnce,
  expectNeverPublished,
  expectNoFailureAnnounced,
  expectSettledOn,
  holdRequests,
  jsonResponse,
  observePage,
  openStarted,
  openWithHeldStart,
  openingPositionsFile,
  readRecord,
  releaseAndDrain,
  savedSessionFor,
  serveOneDatasetRemote,
  servePreparedExport,
  startUrl,
} from './helpers/dataset-loading.mjs';

/* ------------------------------------------------------------------ *
 * The startup dataset is still loading
 * ------------------------------------------------------------------ */

test('a file chosen while the startup dataset loads replaces it', async ({
  page,
}) => {
  const { held, productErrors } = await openWithHeldStart(page);
  await page.locator('#user-data-h5ad-input').setInputFiles(H5AD_PATH);
  await expectSettledOn(page, H5AD);
  await releaseAndDrain(page, held);
  await expectSettledOn(page, H5AD);
  await expectNeverPublished(page, START.name);
  await expectAnnouncedOnce(page, /User data ready: 120 cells/);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

test('a prepared folder chosen while the startup dataset loads replaces it', async ({
  page,
}) => {
  const { held, productErrors } = await openWithHeldStart(page);
  await chooseDirectory(
    page.locator('#user-data-file-input'),
    path.join(demoExportsDirectory, TRAJECTORY.id),
  );
  const folder = { ...TRAJECTORY, select: /^dataset:local-user:/ };
  await expectSettledOn(page, folder);
  await releaseAndDrain(page, held);
  await expectSettledOn(page, folder);
  await expectNeverPublished(page, START.name);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

test('a sample chosen while the startup dataset loads replaces it', async ({
  page,
}) => {
  const { held, productErrors } = await openWithHeldStart(page);
  await page.locator('#dataset-select').selectOption(TRAJECTORY.select);
  await expectSettledOn(page, TRAJECTORY);
  await releaseAndDrain(page, held);
  await expectSettledOn(page, TRAJECTORY);
  await expectNeverPublished(page, START.name);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

test('None chosen while the startup dataset loads clears it', async ({
  page,
}) => {
  const { held, productErrors } = await openWithHeldStart(page);
  await page.locator('#dataset-select').selectOption(NONE.select);
  await expectSettledOn(page, NONE);
  await releaseAndDrain(page, held);
  await expectSettledOn(page, NONE);
  await expectNeverPublished(page, START.name);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

test('a session chosen while the startup dataset loads is applied once it has loaded', async ({
  page,
  context,
}, testInfo) => {
  await openStarted(page);
  const sessionPath = await savedSessionFor(
    page,
    testInfo,
    START,
    'startup-session',
  );
  const second = await context.newPage();
  try {
    const { held, productErrors } = await openWithHeldStart(second);
    await chooseSessionFile(second, sessionPath);
    // The session waits, visibly, for the dataset it will be applied to.
    await expect(
      second.locator('#notification-center .notification').filter({
        hasText: 'Waiting for the dataset to finish loading',
      }),
    ).toHaveCount(1);
    await releaseAndDrain(second, held);
    await expectSettledOn(second, START);
    await openCollapsedPanels(second);
    await expect(second.locator('#background-select')).toHaveValue('black');
    await expectAnnouncedOnce(second, /Session fully restored/);
    await expectNoFailureAnnounced(second);
    expect(productErrors).toEqual([]);
  } finally {
    await closePageWithApplicationRetirement(second);
  }
});

test('a benchmark run while the startup dataset loads replaces it', async ({
  page,
}) => {
  const { held, productErrors } = await openWithHeldStart(page);
  await page.locator('#benchmark-section > summary').click();
  await expect(page.locator('#benchmark-run')).toBeEnabled();
  await page.locator('#benchmark-count').fill('1000');
  await page.locator('#benchmark-pattern').selectOption('atlas');
  await page.locator('#benchmark-run').click();
  await expect
    .poll(() => page.evaluate(() => window._cellucidState.pointCount))
    .toBe(1000);
  // Synthetic points replace the runtime; no dataset is selected for them.
  await expect(page.locator('#dataset-select')).toHaveValue(NONE.select);
  await expect(page.locator('html')).toHaveAttribute(
    'data-startup-phase',
    'ready',
  );
  await releaseAndDrain(page, held);
  await expect
    .poll(() => page.evaluate(() => window._cellucidViewer.getPointCount()))
    .toBe(1000);
  await expectNeverPublished(page, START.name);
  await expect(page.locator('#dataset-info')).not.toHaveClass(/\bloading\b/);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

test('a one-dataset server connected while the startup dataset loads replaces it', async ({
  page,
}) => {
  await serveOneDatasetRemote(page, TRAJECTORY);
  const { held, productErrors } = await openWithHeldStart(page);
  await page.locator('#remote-server-url').fill(SAMPLE_ORIGIN);
  await page.locator('#remote-connect-btn').click();
  const remote = { ...TRAJECTORY, select: /^dataset:remote:/ };
  await expectSettledOn(page, remote);
  await releaseAndDrain(page, held);
  await expectSettledOn(page, remote);
  await expectNeverPublished(page, START.name);
  await expectAnnouncedOnce(page, /Connected - dataset ".*" loaded/);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

test('a one-dataset GitHub repository connected while the startup dataset loads replaces it', async ({
  page,
}) => {
  const rawPrefix =
    'https://raw.githubusercontent.com/cellucid-tests/one/main/exports/';
  await page.route(`${rawPrefix}datasets.json`, route =>
    jsonResponse(route, {
      version: 1,
      default: TRAJECTORY.id,
      datasets: [{
        id: TRAJECTORY.id,
        name: TRAJECTORY.name,
        path: `${TRAJECTORY.id}/`,
        n_cells: TRAJECTORY.cells,
        n_genes: 6,
      }],
    }));
  await servePreparedExport(page, `${rawPrefix}${TRAJECTORY.id}/`, TRAJECTORY.id);
  const { held, productErrors } = await openWithHeldStart(page);
  await page.locator('#github-repo-url').fill('cellucid-tests/one/exports');
  await page.locator('#github-connect-btn').click();
  const github = { ...TRAJECTORY, select: /^dataset:github-repo:/ };
  await expectSettledOn(page, github);
  await releaseAndDrain(page, held);
  await expectSettledOn(page, github);
  await expectNeverPublished(page, START.name);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * Another dataset change is still loading
 * ------------------------------------------------------------------ */

test('a file chosen while a sample loads replaces it', async ({ page }) => {
  const productErrors = await openStarted(page);
  const held = await holdRequests(page, `${EXPORTS}${DEVELOPMENT.id}/`);
  const since = (await readRecord(page)).names.length;
  await page.locator('#dataset-select').selectOption(DEVELOPMENT.select);
  await expect.poll(() => held.started).toBeGreaterThan(0);
  await page.locator('#user-data-h5ad-input').setInputFiles(H5AD_PATH);
  await expectSettledOn(page, H5AD);
  await releaseAndDrain(page, held);
  await expectSettledOn(page, H5AD);
  await expectNeverPublished(page, DEVELOPMENT.name, since);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

// The H5AD read is held by holding its hdf5 library, which the reader worker
// fetches. Firefox does not route the requests a dedicated worker makes, so
// there it cannot be held; Chromium and WebKit run these two cases.
const FIREFOX_WORKER_ROUTING =
  'Firefox does not route requests made by the AnnData reader worker';

test('a sample chosen while a file is still being read replaces it', async ({
  browserName,
  page,
}) => {
  test.skip(browserName === 'firefox', FIREFOX_WORKER_ROUTING);
  const productErrors = await openStarted(page);
  // The H5AD reader's library is fetched on first use, so holding it holds
  // the read itself.
  const held = await holdRequests(page, /\/assets\/external\/hdf5_hl\.js/);
  await page.locator('#user-data-h5ad-input').setInputFiles(H5AD_PATH);
  await expect.poll(() => held.started).toBeGreaterThan(0);
  // The select shows what is being opened while it is read.
  await expect(page.locator('#dataset-select')).toHaveValue(PENDING_OPTION);
  await page.locator('#dataset-select').selectOption(TRAJECTORY.select);
  await expectSettledOn(page, TRAJECTORY);
  await releaseAndDrain(page, held);
  await expectSettledOn(page, TRAJECTORY);
  await expectNeverPublished(page, H5AD.name);
  const { notifications } = await readRecord(page);
  expect(
    notifications.filter(entry => /User data ready/.test(entry.text)),
  ).toEqual([]);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

test('None chosen while a file is still being read clears the dataset', async ({
  browserName,
  page,
}) => {
  test.skip(browserName === 'firefox', FIREFOX_WORKER_ROUTING);
  const productErrors = await openStarted(page);
  const held = await holdRequests(page, /\/assets\/external\/hdf5_hl\.js/);
  await page.locator('#user-data-h5ad-input').setInputFiles(H5AD_PATH);
  await expect.poll(() => held.started).toBeGreaterThan(0);
  await page.locator('#dataset-select').selectOption(NONE.select);
  await expectSettledOn(page, NONE);
  await releaseAndDrain(page, held);
  await expectSettledOn(page, NONE);
  await expectNeverPublished(page, H5AD.name);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

test('None chosen while a sample loads clears the dataset', async ({ page }) => {
  const productErrors = await openStarted(page);
  const held = await holdRequests(page, `${EXPORTS}${DEVELOPMENT.id}/`);
  const since = (await readRecord(page)).names.length;
  await page.locator('#dataset-select').selectOption(DEVELOPMENT.select);
  await expect.poll(() => held.started).toBeGreaterThan(0);
  await page.locator('#dataset-select').selectOption(NONE.select);
  await expectSettledOn(page, NONE);
  await releaseAndDrain(page, held);
  await expectSettledOn(page, NONE);
  await expectNeverPublished(page, DEVELOPMENT.name, since);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

test('a session chosen while a sample loads is applied to that sample', async ({
  page,
  context,
}, testInfo) => {
  await openStarted(page);
  const sessionPath = await savedSessionFor(
    page,
    testInfo,
    TRAJECTORY,
    'trajectory-session',
  );
  const second = await context.newPage();
  try {
    const productErrors = await openStarted(second);
    const held = await holdRequests(second, `${EXPORTS}${TRAJECTORY.id}/`);
    await second.locator('#dataset-select').selectOption(TRAJECTORY.select);
    await expect.poll(() => held.started).toBeGreaterThan(0);
    await chooseSessionFile(second, sessionPath);
    await expect(
      second.locator('#notification-center .notification').filter({
        hasText: 'Waiting for the dataset to finish loading',
      }),
    ).toHaveCount(1);
    await releaseAndDrain(second, held);
    await expectSettledOn(second, TRAJECTORY);
    await openCollapsedPanels(second);
    await expect(second.locator('#background-select')).toHaveValue('black');
    await expectAnnouncedOnce(second, /Session fully restored/);
    await expectNoFailureAnnounced(second);
    expect(productErrors).toEqual([]);
  } finally {
    await closePageWithApplicationRetirement(second);
  }
});

test('a sample chosen while the benchmark prepares replaces it', async ({
  page,
}) => {
  const productErrors = await openStarted(page);
  const held = await holdRequests(
    page,
    /\/assets\/js\/app\/ui\/modules\/benchmark\/generation\.js/,
  );
  await page.locator('#benchmark-section > summary').click();
  await expect(page.locator('#benchmark-run')).toBeEnabled();
  await page.locator('#benchmark-count').fill('1000');
  await page.locator('#benchmark-pattern').selectOption('atlas');
  await page.locator('#benchmark-run').click();
  await expect.poll(() => held.started).toBeGreaterThan(0);
  await page.locator('#dataset-select').selectOption(TRAJECTORY.select);
  await expectSettledOn(page, TRAJECTORY);
  await releaseAndDrain(page, held);
  await expectSettledOn(page, TRAJECTORY);
  // The overtaken run says so once; it is not a failure.
  await expectAnnouncedOnce(page, /Benchmark superseded/);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

/**
 * Lifts the remote connection's own deadline out of the way.
 *
 * The two cases below hold the server's dataset listing while a later choice
 * is made, and release it once that choice is in. The connection gives the
 * server five seconds (`remote-source.js`), and everything between Connect and
 * the release ran inside them: on a macOS Firefox runner clicking Load and
 * restoring the session took six, the deadline passed first, and the
 * connection failed as unreachable instead of answering late. The deadline is
 * not what these cases are about, so only that one timer, five seconds long
 * and set by the remote source, is given the source's maximum; every other
 * timer keeps its length.
 */
async function liftConnectionDeadline(page) {
  await page.addInitScript(() => {
    const realSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (handler, milliseconds, ...args) => realSetTimeout(
      handler,
      milliseconds === 5_000 && /\/data\/remote-source\.js\b/.test(new Error().stack ?? '')
        ? 120_000
        : milliseconds,
      ...args,
    );
  });
}

test('a server that answers after a newer choice keeps its dataset in the catalog', async ({
  page,
}) => {
  let releaseCatalog = () => {};
  const catalogHeld = new Promise(resolve => {
    releaseCatalog = resolve;
  });
  await serveOneDatasetRemote(page, DEVELOPMENT, { holdCatalog: catalogHeld });
  await liftConnectionDeadline(page);
  const productErrors = await openStarted(page);
  await page.locator('#remote-server-url').fill(SAMPLE_ORIGIN);
  await page.locator('#remote-connect-btn').click();
  await expect(
    page.locator('#notification-center .notification').filter({
      hasText: 'Connecting to',
    }),
  ).toHaveCount(1);
  // Chosen after Connect was clicked, so it is the last choice. The server
  // answers while that choice loads.
  await page.locator('#dataset-select').selectOption(TRAJECTORY.select);
  releaseCatalog();
  await expectSettledOn(page, TRAJECTORY);
  await expect(
    page.locator('#dataset-select option[value^="dataset:remote:"]'),
  ).toHaveCount(1);
  await expectAnnouncedOnce(
    page,
    /Connected - dataset ".*" is available in Sample datasets/,
  );
  await expectSettledOn(page, TRAJECTORY);
  await expect(
    page.locator('#dataset-select option[value^="dataset:remote:"]'),
  ).toHaveCount(1);
  await expectNeverPublished(page, DEVELOPMENT.name);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

test('a server that answers after a session was applied leaves that dataset and session', async ({
  page,
}, testInfo) => {
  let releaseCatalog = () => {};
  const catalogHeld = new Promise(resolve => {
    releaseCatalog = resolve;
  });
  await serveOneDatasetRemote(page, DEVELOPMENT, { holdCatalog: catalogHeld });
  await liftConnectionDeadline(page);
  const productErrors = await openStarted(page);
  const sessionPath = await savedSessionFor(
    page,
    testInfo,
    START,
    'connect-then-session',
  );
  await page.locator('#background-select').selectOption('studio');
  await expect(page.locator('#background-select')).toHaveValue('studio');

  await page.locator('#remote-server-url').fill(SAMPLE_ORIGIN);
  await page.locator('#remote-connect-btn').click();
  await expect(
    page.locator('#notification-center .notification').filter({
      hasText: 'Connecting to',
    }),
  ).toHaveCount(1);
  // The session is applied after Connect was clicked, so it is the later
  // action; the server answers once it has been applied.
  await chooseSessionFile(page, sessionPath);
  await expect(page.locator('#background-select')).toHaveValue('black');
  await expectAnnouncedOnce(page, /Session fully restored/);
  releaseCatalog();

  await expectAnnouncedOnce(
    page,
    /Connected - dataset ".*" is available in Sample datasets/,
  );
  await expect(
    page.locator('#dataset-select option[value^="dataset:remote:"]'),
  ).toHaveCount(1);
  await expectSettledOn(page, START);
  await expect(page.locator('#background-select')).toHaveValue('black');
  await expectNeverPublished(page, DEVELOPMENT.name);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * A lost connection clears only the dataset it lost
 * ------------------------------------------------------------------ */

// Intercepted by the page, never bound: the browser-test servers own the
// configured ports, so the advertised update socket sits beside them.
const REMOTE_SOCKET_PORT = SAMPLE_PORT + 101;

async function connectOneDatasetRemote(page) {
  const remote = await serveOneDatasetRemote(page, TRAJECTORY, {
    webSocketPort: REMOTE_SOCKET_PORT,
  });
  const productErrors = await openStarted(page);
  await page.locator('#remote-server-url').fill(SAMPLE_ORIGIN);
  await page.locator('#remote-connect-btn').click();
  await expectSettledOn(page, { ...TRAJECTORY, select: /^dataset:remote:/ });
  await expect.poll(() => remote.socketOpened()).toBe(true);
  return { productErrors, remote };
}

async function expectConnectionLossReported(page) {
  await expectAnnouncedOnce(page, /connection was lost\. Reconnect to continue/);
  const { notifications } = await readRecord(page);
  // The loss is the one failure the user is told about.
  expect(
    notifications
      .filter(entry => entry.type === 'error')
      .filter(entry => !/connection was lost/.test(entry.text)),
  ).toEqual([]);
  await expect(
    page.locator('#dataset-select option[value^="dataset:remote:"]'),
  ).toHaveCount(0);
  await expect(page.locator('#remote-connect-btn')).toBeEnabled();
}

test('a connection lost while a newer choice loads lets that choice land', async ({
  page,
}) => {
  const { productErrors, remote } = await connectOneDatasetRemote(page);
  const held = await holdRequests(page, `${EXPORTS}${DEVELOPMENT.id}/`);
  await page.locator('#dataset-select').selectOption(DEVELOPMENT.select);
  await expect.poll(() => held.started).toBeGreaterThan(0);

  await remote.closeSocket();
  // Recovery waits for the choice instead of clearing over it.
  await page.evaluate(() => new Promise(resolve => {
    setTimeout(() => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }, 300);
  }));
  await expect(page.locator('#dataset-select')).toHaveValue(DEVELOPMENT.select);
  await expect(page.locator('#dataset-name')).toHaveText(TRAJECTORY.name);
  // The loss is said at once, while recovery waits for the choice.
  await expect.poll(async () => (await readRecord(page)).notifications.filter(
    entry => entry.type === 'error' && /connection was lost\./.test(entry.text),
  ).length).toBe(1);

  await releaseAndDrain(page, held);
  await expectSettledOn(page, DEVELOPMENT);
  await expectConnectionLossReported(page);
  await expectSettledOn(page, DEVELOPMENT);
  expect(productErrors).toEqual([]);
});

test('a connection lost while a newer choice loads clears its dataset if that choice fails', async ({
  page,
}) => {
  const { productErrors, remote } = await connectOneDatasetRemote(page);
  let releaseFailure = () => {};
  const failureHeld = new Promise(resolve => {
    releaseFailure = resolve;
  });
  let failingRequests = 0;
  await page.route(`${EXPORTS}${DEVELOPMENT.id}/**`, async route => {
    failingRequests += 1;
    await failureHeld;
    await route.fulfill({ status: 503, body: 'unavailable' }).catch(() => {});
  });
  await page.locator('#dataset-select').selectOption(DEVELOPMENT.select);
  await expect.poll(() => failingRequests).toBeGreaterThan(0);

  await remote.closeSocket();
  releaseFailure();
  // The choice failed and says so; only then is the lost dataset cleared.
  await expect(
    page.locator('#notification-center .notification[data-type="error"]').filter({
      hasText: DEVELOPMENT.name,
    }),
  ).not.toHaveCount(0);
  await expectAnnouncedOnce(page, /connection was lost\. Reconnect to continue/);
  await expect(page.locator('#dataset-name')).toHaveText(NONE.name);
  await expect(page.locator('#dataset-select')).toHaveValue(NONE.select);
  await expect
    .poll(() => page.evaluate(() => window._cellucidViewer.getPointCount()))
    .toBe(0);
  await expect(
    page.locator('#dataset-select option[value^="dataset:remote:"]'),
  ).toHaveCount(0);
  // The only errors logged are the failed load's own report of itself.
  // (Engines print the logged Error differently, so the reports are matched
  // by their own prefix.)
  expect(
    productErrors.filter(entry => !(
      entry.includes('[Main] Failed to reload dataset in-place:') ||
      entry.includes('[UI] Dataset switch failed:') ||
      /\b503\b/.test(entry)
    )),
  ).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * Jupyter: the notebook's dataset is the startup dataset
 * ------------------------------------------------------------------ */

/**
 * Serve an authenticated Jupyter bridge on the page's own origin that offers
 * one dataset, and record every event the viewer posts to Python.
 */
async function serveJupyterBridge(page, target) {
  const events = [];
  await page.route(appUrl('/_cellucid/health'), route =>
    jsonResponse(route, { status: 'ok', type: 'exported', version: '0.9.1' }));
  await page.route(appUrl('/_cellucid/datasets'), route =>
    jsonResponse(route, {
      datasets: [{ id: target.id, path: '/jupyter-one/', name: target.name }],
    }));
  await page.route(appUrl('/_cellucid/events'), async route => {
    events.push(JSON.parse(route.request().postData() ?? 'null'));
    await jsonResponse(route, { status: 'ok', delivered: true });
  });
  // A current notebook server publishes what it accepts on the wire.
  await page.route(appUrl('/_cellucid/protocol'), route =>
    jsonResponse(route, { events: ['ready'], commands: [] }));
  await servePreparedExport(page, appUrl('/jupyter-one/'), target.id);
  return events;
}

function jupyterUrl() {
  const url = new URL('/', appUrl('/'));
  url.searchParams.set('jupyter', 'true');
  url.searchParams.set('viewerId', 'viewer-1');
  url.searchParams.set('viewerToken', 'token-1');
  return url.toString();
}

test('the notebook dataset reports ready to Python once it is on screen', async ({
  page,
}) => {
  const productErrors = await observePage(page);
  const events = await serveJupyterBridge(page, TRAJECTORY);
  await page.goto(jupyterUrl(), { waitUntil: 'domcontentloaded' });
  await expectSettledOn(page, { ...TRAJECTORY, select: /^dataset:jupyter:/ });
  await expect
    .poll(() => events.filter(event => event?.type === 'ready'))
    .toEqual([
      expect.objectContaining({
        type: 'ready',
        n_cells: TRAJECTORY.cells,
        dimensions: 1,
      }),
    ]);
  expect(productErrors).toEqual([]);
});

test('a file chosen while the notebook dataset loads replaces it and Python is not told it is ready', async ({
  page,
}) => {
  const productErrors = await observePage(page);
  const events = await serveJupyterBridge(page, TRAJECTORY);
  const held = await holdRequests(
    page,
    appUrl(`/jupyter-one/${await openingPositionsFile(TRAJECTORY.id)}`),
  );
  await page.goto(jupyterUrl(), { waitUntil: 'domcontentloaded' });
  await expect.poll(() => held.started).toBeGreaterThan(0);
  await expect(page.locator('#user-data-h5ad-input')).toBeEnabled();
  await page.locator('#user-data-h5ad-input').setInputFiles(H5AD_PATH);
  await expectSettledOn(page, H5AD);
  await releaseAndDrain(page, held);
  await expectSettledOn(page, H5AD);
  await expectNeverPublished(page, TRAJECTORY.name);
  // The viewer is not showing the dataset Python's indices describe.
  expect(events.filter(event => event?.type === 'ready')).toEqual([]);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});
