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
 * Each case holds the load in flight -- an opening at the AnnData reader
 * worker (`holdOpening`), a file read at its reader's transport -- makes the
 * second choice, and then lets what it held go. The end state must be exactly the
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
import { openZarrFolder } from './helpers/dataset-drop.mjs';
import { serveAnnDataServer } from './helpers/anndata-server.mjs';
import { APP_ORIGIN, SAMPLE_ORIGIN, SAMPLE_PORT, appUrl } from './helpers/origins.mjs';
import { workerScriptPattern } from './helpers/worker-scripts.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import {
  DEVELOPMENT,
  H5AD,
  H5AD_PATH,
  NONE,
  PENDING_OPTION,
  UNLISTED_OPTION,
  SAMPLE_CATALOG,
  START,
  TRAJECTORY,
  ZARR_FOLDER,
  chooseSessionFile,
  demoCatalogDirectory,
  expectAnnouncedOnce,
  expectNeverPublished,
  expectNoFailureAnnounced,
  expectSettledOn,
  holdOpening,
  holdRequests,
  jsonResponse,
  observePage,
  openStarted,
  openWithHeldStart,
  readRecord,
  releaseAndDrain,
  savedSessionFor,
  serveDemoFile,
  serveOneDatasetRemote,
  startUrl,
} from './helpers/dataset-loading.mjs';
import { chooseFiles } from './helpers/file-input.mjs';

/* ------------------------------------------------------------------ *
 * The startup dataset is still loading
 * ------------------------------------------------------------------ */

test('a file chosen while the startup dataset loads replaces it', async ({
  page,
}) => {
  const { held, productErrors } = await openWithHeldStart(page);
  await chooseFiles(page.locator('#user-data-file-input'), H5AD_PATH);
  await expectSettledOn(page, H5AD);
  await releaseAndDrain(page, held);
  await expectSettledOn(page, H5AD);
  await expectNeverPublished(page, START.name);
  await expectAnnouncedOnce(page, /User data ready: 120 cells/);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

test('a Zarr folder chosen while the startup dataset loads replaces it', async ({
  page,
  browserName,
}) => {
  const { held, productErrors } = await openWithHeldStart(page);
  await openZarrFolder(page, browserName, ZARR_FOLDER.path);
  await expectSettledOn(page, ZARR_FOLDER);
  await releaseAndDrain(page, held);
  await expectSettledOn(page, ZARR_FOLDER);
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
  await expect(page.locator('#dataset-info')).not.toHaveAttribute('data-state', 'loading');
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

test('a one-dataset server connected while the startup dataset loads replaces it', async ({
  page,
}) => {
  await serveOneDatasetRemote(page, TRAJECTORY);
  const { held, productErrors } = await openWithHeldStart(page);
  await page.locator('#data-address').fill(SAMPLE_ORIGIN);
  await page.locator('#data-address-open-btn').click();
  const remote = { ...TRAJECTORY, select: UNLISTED_OPTION };
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
    'https://raw.githubusercontent.com/cellucid-tests/one/HEAD/catalog/';
  await page.route(`${rawPrefix}datasets.json`, route =>
    jsonResponse(route, {
      schema: 2,
      default: TRAJECTORY.id,
      datasets: [{ id: TRAJECTORY.id, path: `${TRAJECTORY.id}.zarr.zip` }],
    }));
  await serveDemoFile(page, `${rawPrefix}${TRAJECTORY.id}.zarr.zip`, TRAJECTORY);
  const { held, productErrors } = await openWithHeldStart(page);
  await page.locator('#data-address').fill('cellucid-tests/one/catalog');
  await page.locator('#data-address-open-btn').click();
  const github = { ...TRAJECTORY, select: UNLISTED_OPTION };
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
  const held = await holdOpening(page, DEVELOPMENT);
  const since = (await readRecord(page)).names.length;
  await page.locator('#dataset-select').selectOption(DEVELOPMENT.select);
  await expect.poll(() => held.started).toBeGreaterThan(0);
  await chooseFiles(page.locator('#user-data-file-input'), H5AD_PATH);
  await expectSettledOn(page, H5AD);
  await releaseAndDrain(page, held);
  await expectSettledOn(page, H5AD);
  await expectNeverPublished(page, DEVELOPMENT.name, since);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

// The H5AD read is held by holding the HDF5 reader (`formats/hdf5`), which
// the AnnData reader worker imports when it starts. Every file opened gets
// its own worker, so only the first import after the hold (the chosen file's)
// is held. Firefox does not route the requests a dedicated worker makes, so
// there it cannot be held; Chromium and WebKit run these two cases.
const HDF5_READER = /\/assets\/js\/formats\/hdf5\/index\.js$/;
// The worker that fetches it: a read the newer choice replaced ends it, and
// the held request with it.
const READER_WORKER = workerScriptPattern('annDataReaderWorker');
const FIREFOX_WORKER_ROUTING =
  'Firefox does not route requests made by the AnnData reader worker';

test('a sample chosen while a file is still being read replaces it', async ({
  browserName,
  page,
}) => {
  test.skip(browserName === 'firefox', FIREFOX_WORKER_ROUTING);
  const productErrors = await openStarted(page);
  // The HDF5 reader is fetched when the reader worker starts, so holding it
  // holds the read itself.
  const held = await holdRequests(page, HDF5_READER, { first: 1, worker: READER_WORKER });
  await chooseFiles(page.locator('#user-data-file-input'), H5AD_PATH);
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
  const held = await holdRequests(page, HDF5_READER, { first: 1, worker: READER_WORKER });
  await chooseFiles(page.locator('#user-data-file-input'), H5AD_PATH);
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
  const held = await holdOpening(page, DEVELOPMENT);
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
    const held = await holdOpening(second, TRAJECTORY);
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
  await page.locator('#data-address').fill(SAMPLE_ORIGIN);
  await page.locator('#data-address-open-btn').click();
  await expect(
    page.locator('#notification-center .notification').filter({
      hasText: SAMPLE_ORIGIN,
    }),
  ).toHaveCount(1);
  // Chosen after Connect was clicked, so it is the last choice. The server
  // answers while that choice loads.
  await page.locator('#dataset-select').selectOption(TRAJECTORY.select);
  releaseCatalog();
  await expectSettledOn(page, TRAJECTORY);
  // A server's one dataset is not a choice of the sample list: opening the
  // address again shows it.
  await expect(
    page.locator('#dataset-select option[value^="dataset:remote:"]'),
  ).toHaveCount(0);
  await expectAnnouncedOnce(
    page,
    /Connected - ".*" was not opened because another dataset was chosen meanwhile/,
  );
  await expectSettledOn(page, TRAJECTORY);
  // A server's one dataset is not a choice of the sample list: opening the
  // address again shows it.
  await expect(
    page.locator('#dataset-select option[value^="dataset:remote:"]'),
  ).toHaveCount(0);
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

  await page.locator('#data-address').fill(SAMPLE_ORIGIN);
  await page.locator('#data-address-open-btn').click();
  await expect(
    page.locator('#notification-center .notification').filter({
      hasText: SAMPLE_ORIGIN,
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
    /Connected - ".*" was not opened because another dataset was chosen meanwhile/,
  );
  // A server's one dataset is not a choice of the sample list: opening the
  // address again shows it.
  await expect(
    page.locator('#dataset-select option[value^="dataset:remote:"]'),
  ).toHaveCount(0);
  await expectSettledOn(page, START);
  await expect(page.locator('#background-select')).toHaveValue('black');
  await expectNeverPublished(page, DEVELOPMENT.name);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * Jupyter: the notebook's dataset is the startup dataset
 * ------------------------------------------------------------------ */

/**
 * Serve an authenticated viewer channel on the page's own origin that offers
 * one dataset, and record every event the viewer posts to Python.
 */
async function serveViewerHostBridge(page, target) {
  const { events } = await serveAnnDataServer(page, APP_ORIGIN, {
    ...target,
    file: path.join(demoCatalogDirectory, `${target.id}.zarr.zip`),
  }, { viewerHost: true });
  return events;
}

function viewerHostUrl() {
  const url = new URL('/', appUrl('/'));
  url.searchParams.set('viewer', 'true');
  url.searchParams.set('viewerId', 'viewer-1');
  url.searchParams.set('viewerToken', 'token-1');
  return url.toString();
}

test('the notebook dataset reports ready to Python once it is on screen', async ({
  page,
}) => {
  const productErrors = await observePage(page);
  const events = await serveViewerHostBridge(page, TRAJECTORY);
  await page.goto(viewerHostUrl(), { waitUntil: 'domcontentloaded' });
  // A notebook's one dataset is not a choice of the sample list: the list
  // shows "—" and the Dataset box names it.
  await expectSettledOn(page, { ...TRAJECTORY, select: UNLISTED_OPTION });
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
  const events = await serveViewerHostBridge(page, TRAJECTORY);
  const held = await holdOpening(page, TRAJECTORY);
  await page.goto(viewerHostUrl(), { waitUntil: 'domcontentloaded' });
  await expect.poll(() => held.started).toBeGreaterThan(0);
  await chooseFiles(page.locator('#user-data-file-input'), H5AD_PATH);
  await expectSettledOn(page, H5AD);
  await releaseAndDrain(page, held);
  await expectSettledOn(page, H5AD);
  await expectNeverPublished(page, TRAJECTORY.name);
  // The viewer is not showing the dataset Python's indices describe.
  expect(events.filter(event => event?.type === 'ready')).toEqual([]);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});
