/**
 * Every data-loading path fails bounded, explains itself, and leaves the
 * application in a state the user can act from.
 *
 * The catalogs under `fixtures/broken-catalogs/` each fail for one reason: a
 * listed file that is missing, truncated or not a file at all, a file that
 * does not state the id it is listed under, a truncated `datasets.json`, and
 * a catalog that does not state its schema. Listing a catalog reads every file it names,
 * so each is a failure of the whole catalog. A dataset that breaks only when
 * it is opened -- removed, cut short or damaged after the catalog was listed
 * -- is reached from a working session, which is the only way to observe
 * recovery; it is made from the demo catalog at the transport.
 *
 * The other synthetic failures are the ones a file cannot express -- an HTTP
 * status, an offline network, a slow link and a cancelled request -- and
 * those are injected at the transport while the loader under test stays real.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { chooseDirectory } from './helpers/directory-upload.mjs';
import { fulfillFile, zipEntryData } from './helpers/anndata-zarr-zip.mjs';
import { demoFile, observePage, onWorkerClose, readRecord } from './helpers/dataset-loading.mjs';
import { APP_ORIGIN as ORIGIN } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const fixturesDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);
const h5adFixturePath = path.join(fixturesDirectory, 'current-ui-smoke.h5ad');
const zarrFixturePath = path.join(
  fixturesDirectory,
  'current-ui-smoke.zarr.zip',
);

const GOOD_CATALOG = `${ORIGIN}/tests/browser/fixtures/demo-catalog/`;
const BROKEN = `${ORIGIN}/tests/browser/fixtures/broken-catalogs/`;

const GOOD_DATASET = Object.freeze({
  id: 'synthetic-cell-types-2d',
  name: 'Synthetic cell-type islands — 2D',
  cells: 72,
});
/** GOOD_DATASET's file opened by the user: it names itself the same. */
const GOOD_FILE = Object.freeze({
  ...GOOD_DATASET,
  path: path.join(fixturesDirectory, 'demo-catalog', `${GOOD_DATASET.id}.zarr.zip`),
});
const MIXED_DEFAULT = Object.freeze({
  id: 'synthetic-development-3d',
  name: 'Synthetic branching development — 3D',
  cells: 96,
});

/** What `#dataset-name` says while no dataset is open (`dataset-card.js`). */
const NO_DATASET_NAMES = Object.freeze(['No dataset open']);

const CATALOG_NOTICE = '#dataset-notice';
const FIREFOX_WORKER_ROUTING =
  'Firefox does not route requests made by the AnnData reader worker';
const STARTUP_FAILURE = '#cellucid-startup-failure';

function catalogUrl(baseUrl, datasetId) {
  const url = new URL('/', ORIGIN);
  url.searchParams.set('sampleCatalog', baseUrl);
  if (datasetId !== null) url.searchParams.set('dataset', datasetId);
  return url.toString();
}

function optionValue(datasetId) {
  return `dataset:local-demo:${datasetId}`;
}

/** Record what a wet-lab user actually sees, so the report can quote it. */
async function recordUserFacingFailure(page, testInfo, label) {
  const observed = await page.evaluate(() => {
    const text = element =>
      (element === null ? null : element.textContent.trim());
    const notice = document.querySelector('#dataset-notice');
    return {
      catalogNotice: notice === null || notice.hidden
        ? null
        : notice.textContent.trim(),
      startupFailure: text(
        document.getElementById('cellucid-startup-failure'),
      ),
      notifications: [
        ...document.querySelectorAll('#notification-center .notification'),
      ].map(node => node.textContent.trim().replace(/\s+/g, ' ')),
      stats: text(document.getElementById('stats')),
      datasetName: text(document.getElementById('dataset-name')),
    };
  });
  await testInfo.attach(`user-facing-failure-${label}.json`, {
    body: JSON.stringify(observed, null, 2),
    contentType: 'application/json',
  });
  return observed;
}

/**
 * What the app believes it is showing, for a failure that says only "".
 *
 * `#dataset-name` is written in exactly three ways — "No dataset open", what
 * is being opened, and `metadata.name` — so an empty
 * reading means a publication carried an empty name, which is a different defect
 * from a load that never finished. A CI-only intermittent that reports neither
 * cannot be told apart from the other, so the failure carries the distinction.
 */
async function describeRenderState(page) {
  try {
    return await page.evaluate(() => {
      const text = id => document.getElementById(id)?.textContent ?? null;
      const source = window._cellucidDataSourceManager ?? null;
      return {
        datasetName: text('dataset-name'),
        datasetCells: text('dataset-cells'),
        datasetOrigin: text('dataset-origin'),
        filterCount: text('filter-count'),
        selectValue: document.getElementById('dataset-select')?.value ?? null,
        viewerPointCount: (() => {
          try {
            return window._cellucidViewer?.getPointCount?.() ?? null;
          } catch (error) {
            return `unavailable: ${error?.name ?? error}`;
          }
        })(),
        currentDescriptor: (() => {
          try {
            return source?.getStateSnapshot?.() ?? null;
          } catch (error) {
            return `unavailable: ${error?.name ?? error}`;
          }
        })(),
        errorNotifications: [...document.querySelectorAll('.notification-error')]
          .map(node => node.textContent),
      };
    });
  } catch (error) {
    return { describeFailed: String(error?.message ?? error) };
  }
}

async function expectRenders(page, dataset) {
  try {
    await expect(page.locator('#dataset-name')).toHaveText(dataset.name);
  } catch (error) {
    const state = await describeRenderState(page);
    error.message +=
      `\n\nApp state when the name did not arrive:\n${
        JSON.stringify(state, null, 2)
      }`;
    throw error;
  }
  await expect(page.locator('#dataset-cells')).toHaveText(
    String(dataset.cells),
  );
  await expect(page.locator('#filter-count')).toHaveText(
    `Showing all ${dataset.cells} cells`,
  );
  await expect
    .poll(() => page.evaluate(
      () => window._cellucidViewer.getPointCount(),
    ))
    .toBe(dataset.cells);
}

/** The user opens GOOD_DATASET's file themselves, without reloading. */
async function openGoodFile(page) {
  await page.locator('#user-data-file-input').setInputFiles(GOOD_FILE.path);
  await expectRenders(page, GOOD_FILE);
}

async function derivedFile(testInfo, name, bytes) {
  const target = testInfo.outputPath(name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return target;
}

/**
 * Notifications auto-dismiss, so a failure message has to be sampled while it
 * is on screen rather than read once the dust settles.
 */
async function captureFirstErrorNotification(page, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const texts = await page.evaluate(() =>
      [...document.querySelectorAll(
        '#notification-center .notification-error',
      )].map(node => node.textContent.trim().replace(/\s+/g, ' ')));
    if (texts.length > 0) return texts;
    await page.waitForTimeout(200);
  }
  return [];
}

/* ------------------------------------------------------------------ *
 * Catalog-level failures: absent, wrong format, truncated, denied
 * ------------------------------------------------------------------ */

const CATALOG_FAILURES = Object.freeze([
  Object.freeze({
    label: 'absent',
    base: `${ORIGIN}/tests/browser/fixtures/no-such-catalog/`,
    notice: 'nothing is published at that address',
  }),
  Object.freeze({
    label: 'truncated',
    base: `${BROKEN}truncated-catalog/`,
    notice: 'may not hold Cellucid data',
  }),
  Object.freeze({
    label: 'schemaless',
    base: `${BROKEN}schemaless-catalog/`,
    notice: "is missing 'schema'",
    // Retrying cannot help: the notice says what the catalog must be.
    advice: false,
  }),
]);

for (const failure of CATALOG_FAILURES) {
  test(
    `a ${failure.label} dataset catalog fails bounded and stays recoverable`,
    async ({ page }, testInfo) => {
      await page.goto(catalogUrl(failure.base, null), {
        waitUntil: 'domcontentloaded',
      });
      await dismissWelcome(page);

      await expect(page.locator(CATALOG_NOTICE)).toBeVisible();
      // The cause the loader published reaches the notice: an address with
      // nothing on it is not reported as a network problem, and a reply that
      // is not a dataset list is not reported as a missing address.
      await expect(page.locator(CATALOG_NOTICE)).toContainText(failure.notice);
      if (failure.advice !== false) {
        await expect(page.locator(CATALOG_NOTICE)).toContainText('try again');
      }
      await expect(
        page.locator(`${CATALOG_NOTICE} button`),
      ).toHaveText('Try again');
      await expect(page.locator(STARTUP_FAILURE)).toHaveCount(0);

      const observed = await recordUserFacingFailure(
        page,
        testInfo,
        failure.label,
      );
      // Nothing half-loaded is on screen and nothing unloadable is offered.
      expect(NO_DATASET_NAMES).toContain(observed.datasetName);
      await expect(
        page.locator('#dataset-select option:not([value="__none__"])'),
      ).toHaveText(['No datasets found']);

      // The user can still load their own data without reloading the page.
      await openGoodFile(page);
    },
  );
}

test('a permission-denied catalog fails bounded and stays recoverable', async ({
  page,
}, testInfo) => {
  await page.route(`${GOOD_CATALOG}datasets.json`, route =>
    route.fulfill({
      status: 403,
      contentType: 'text/plain',
      body: 'Forbidden',
    }));

  await page.goto(catalogUrl(GOOD_CATALOG, null), {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);

  await expect(page.locator(CATALOG_NOTICE)).toBeVisible();
  const observed = await recordUserFacingFailure(page, testInfo, 'denied-403');
  expect(NO_DATASET_NAMES).toContain(observed.datasetName);
  await expect(page.locator(STARTUP_FAILURE)).toHaveCount(0);
});

test('a catalog failure recovers in place once the catalog is reachable', async ({
  page,
}, testInfo) => {
  // Serve a 503 until the outage ends, then let the real bytes through, so
  // recovery is tested against a transient outage rather than a permanently
  // broken tree. Startup asks a busy host again on its own before it reports
  // anything; once the notice offers "Try again", nothing asks again behind
  // it, and each "Try again" is one request whose answer is shown at once.
  let outage = true;
  let requests = 0;
  await page.route(`${GOOD_CATALOG}datasets.json`, async route => {
    requests += 1;
    if (outage) {
      await route.fulfill({
        status: 503,
        contentType: 'text/plain',
        body: 'Service Unavailable',
      });
      return;
    }
    await route.continue();
  });

  await page.goto(catalogUrl(GOOD_CATALOG, null), {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  const retry = page.locator(`${CATALOG_NOTICE} button`);
  await expect(retry).toHaveText('Try again');
  await expect(page.locator(CATALOG_NOTICE)).toContainText(
    'the server reported a problem of its own',
  );
  await recordUserFacingFailure(page, testInfo, 'transient-503');
  expect(requests).toBeGreaterThan(1);

  // The notice is the person's to act on: nothing retries behind it.
  const shown = requests;
  await page.waitForTimeout(3_000);
  expect(requests).toBe(shown);

  // "Try again" while the host is still busy: one request, reported at once.
  await retry.click();
  await expect(retry).toHaveText('Try again', { timeout: 5_000 });
  await expect(page.locator(CATALOG_NOTICE)).toContainText(
    'the server reported a problem of its own',
  );
  expect(requests).toBe(shown + 1);

  outage = false;
  await retry.click();
  await expect(page.locator(CATALOG_NOTICE)).toBeHidden();
  expect(requests).toBe(shown + 2);
  await expect(page.locator('#dataset-select')).toBeEnabled();
  await page.locator('#dataset-select').selectOption(
    optionValue(GOOD_DATASET.id),
  );
  await expectRenders(page, GOOD_DATASET);
});

/* ------------------------------------------------------------------ *
 * Dataset failures reached from a working session
 * ------------------------------------------------------------------ */

/**
 * GOOD_DATASET's file, as the demo catalog serves it, broken once the
 * catalog has been listed: removed, cut to a third, or with one byte of its
 * embedding flipped, so its ZIP entry no longer matches its checksum.
 */
const OPENING_FAILURES = Object.freeze({
  removed: route => route.fulfill({ status: 404, body: 'Not Found' }),
  truncated: route => {
    const whole = demoFile(GOOD_DATASET);
    return fulfillFile(route, whole.subarray(0, Math.floor(whole.length / 3)));
  },
  damaged: route => {
    const damaged = Buffer.from(demoFile(GOOD_DATASET));
    const embedding = zipEntryData(damaged, `${GOOD_DATASET.id}.zarr/obsm/X_islands/0.0`);
    damaged[embedding.offset + embedding.length - 1] ^= 0xff;
    return fulfillFile(route, damaged);
  },
});

for (const [label, fail] of Object.entries(OPENING_FAILURES)) {
  test(
    `choosing a dataset whose file was ${label} fails bounded and keeps the session`,
    async ({ browserName, page }, testInfo) => {
      test.skip(browserName === 'firefox', FIREFOX_WORKER_ROUTING);
      await page.goto(catalogUrl(GOOD_CATALOG, MIXED_DEFAULT.id), {
        waitUntil: 'domcontentloaded',
      });
      await dismissWelcome(page);
      await expectRenders(page, MIXED_DEFAULT);
      // The catalog has been listed: every read of the file from here on
      // opens it.
      await page.route(`${GOOD_CATALOG}${GOOD_DATASET.id}.zarr.zip`, fail);

      await page.locator('#dataset-select').selectOption(
        optionValue(GOOD_DATASET.id),
      );
      const errors = await captureFirstErrorNotification(page);
      await testInfo.attach(`user-facing-failure-${label}-file.json`, {
        body: JSON.stringify({ errorNotifications: errors }, null, 2),
        contentType: 'application/json',
      });
      expect(errors.length).toBeGreaterThan(0);
      // The notification says it in one sentence; what happened and what to
      // do stay next to the selector.
      expect(errors.join('\n')).toContain(`Could not open "${GOOD_DATASET.name}".`);
      await expect(page.locator(CATALOG_NOTICE)).toContainText(
        `"${GOOD_DATASET.name}" could not be opened`,
      );

      // The session survives: the dataset that was rendered is still rendered,
      // the selector returns to it, and other data still loads.
      await expectRenders(page, MIXED_DEFAULT);
      await expect(page.locator('#dataset-select')).toHaveValue(
        optionValue(MIXED_DEFAULT.id),
      );
      await expect(page.locator(STARTUP_FAILURE)).toHaveCount(0);
      await openGoodFile(page);
    },
  );
}

/**
 * A dataset that cannot be opened is said once: one notification, one short
 * sentence, its own error folded under Details. What to do stays next to
 * the selector with the retry; the opening that failed says nothing more.
 */
for (const [label, fail] of Object.entries(OPENING_FAILURES)) {
  test(`a dataset whose file was ${label} is announced by exactly one notification`, async ({
    browserName,
    page,
  }) => {
    test.skip(browserName === 'firefox', FIREFOX_WORKER_ROUTING);
    await observePage(page);
    await page.goto(catalogUrl(GOOD_CATALOG, MIXED_DEFAULT.id), {
      waitUntil: 'domcontentloaded',
    });
    await dismissWelcome(page);
    await expectRenders(page, MIXED_DEFAULT);
    await page.route(`${GOOD_CATALOG}${GOOD_DATASET.id}.zarr.zip`, fail);

    await page.locator('#dataset-select').selectOption(optionValue(GOOD_DATASET.id));
    await expect(page.locator(CATALOG_NOTICE)).toBeVisible();
    await expectRenders(page, MIXED_DEFAULT);
    await expect(page.locator(
      '#notification-center .notification[data-type="loading"], '
        + '#notification-center .notification[data-type="progress"]',
    )).toHaveCount(0);
    // Settled: every notification ever shown is recorded.
    await page.evaluate(() => new Promise(resolve => {
      setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 0);
    }));
    const { notifications } = await readRecord(page);
    const errors = new Set(
      notifications.filter(entry => entry.type === 'error').map(entry => entry.id),
    );
    expect(errors.size, JSON.stringify(notifications)).toBe(1);
    const card = page.locator('#notification-center .notification-error');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.notification-message')).toHaveText(
      `Could not open "${GOOD_DATASET.name}".`,
    );
    // The raw error is folded under Details, not in the sentence.
    await expect(card.locator('.notification-details-text')).toBeHidden();
    await expect(card.locator('.notification-details-text')).toHaveText(/\S/);
  });
}

/**
 * A catalog whose only (default) dataset cannot be described leaves Cellucid
 * running without it: its opening fails over the empty viewer, saying what
 * happened in one sentence, with the dataset file's problem under Details and
 * the ways on.
 */
const STARTUP_FILE_FAILURES = Object.freeze({
  'missing-file': /forms-h5ad\.h5ad/,
  'truncated-file': /forms-h5ad\.h5ad is truncated/,
  'corrupt-file': /forms-h5ad\.h5ad \(dataset 'forms-h5ad' in datasets\.json\): .*not a valid HDF5\/H5AD file/,
  'mismatched-id': /lists forms-h5ad\.h5ad as dataset 'another-id', but the file states the id 'forms-h5ad'/,
});

for (const [label, names] of Object.entries(STARTUP_FILE_FAILURES)) {
  test(`a catalog with a ${label.replace('-', ' ')} leaves Cellucid running with one actionable opening`, async ({
    page,
  }, testInfo) => {
    await page.goto(catalogUrl(`${BROKEN}${label}/`, null), {
      waitUntil: 'domcontentloaded',
    });

    const failed = page.locator('.opening-overlay[data-state="failed"]');
    await expect(failed).toBeVisible();
    await expect(failed.locator('.opening-title')).toHaveText('The data could not be opened');
    await expect(failed.locator('.welcome-details-text')).toContainText(names);
    await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(failed.getByRole('button', { name: 'Open without this link' })).toBeVisible();
    // Only a failure of the app itself stops it.
    await expect(page.locator(STARTUP_FAILURE)).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
    expect(await page.evaluate(() => window._cellucidViewer.isDisposed())).toBe(false);
    const observed = await recordUserFacingFailure(
      page,
      testInfo,
      `startup-${label}`,
    );
    expect(NO_DATASET_NAMES).toContain(observed.datasetName);
    // What the address asked for comes first: onboarding does not cover it.
    await expect(page.locator('#welcome-modal')).toBeHidden();
  });
}

/* ------------------------------------------------------------------ *
 * Transport failures: offline, slow, cancelled
 * ------------------------------------------------------------------ */

test('an offline dataset switch is reported and the session survives', async ({
  page,
  context,
}, testInfo) => {
  await page.goto(catalogUrl(GOOD_CATALOG, GOOD_DATASET.id), {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await expectRenders(page, GOOD_DATASET);

  await context.setOffline(true);
  await page.locator('#dataset-select').selectOption(
    optionValue(MIXED_DEFAULT.id),
  );
  const errors = await captureFirstErrorNotification(page);
  await testInfo.attach('user-facing-failure-offline.json', {
    body: JSON.stringify({ errorNotifications: errors }, null, 2),
    contentType: 'application/json',
  });
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.join('\n')).toContain(`Could not open "${MIXED_DEFAULT.name}".`);
  await expect(page.locator(CATALOG_NOTICE)).toContainText(
    `"${MIXED_DEFAULT.name}" could not be opened`,
  );
  await expectRenders(page, GOOD_DATASET);

  await context.setOffline(false);
  await page.locator('#dataset-select').selectOption(
    optionValue(MIXED_DEFAULT.id),
  );
  await expectRenders(page, MIXED_DEFAULT);
});

test('a slow link still reaches a rendered dataset', async ({ page }) => {
  await page.route(`${GOOD_CATALOG}**`, async route => {
    await new Promise(resolve => setTimeout(resolve, 250));
    await route.continue();
  });

  await page.goto(catalogUrl(GOOD_CATALOG, GOOD_DATASET.id), {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await expectRenders(page, GOOD_DATASET);
});

test('a load cancelled by switching datasets leaves the winner rendered', async ({
  browserName,
  page,
}) => {
  test.skip(browserName === 'firefox', FIREFOX_WORKER_ROUTING);
  await page.goto(catalogUrl(GOOD_CATALOG, GOOD_DATASET.id), {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await expectRenders(page, GOOD_DATASET);

  // Slow every read of the 3D dataset's file, start it, then choose the 1D
  // dataset while its first read is in flight. The last request must win and
  // the first must not resurface. (The catalog was listed at startup: these
  // reads open it.)
  const supersededUrl = `${GOOD_CATALOG}synthetic-development-3d.zarr.zip`;
  const superseded = { settled: 0, started: 0 };
  const settled = new Set();
  const settleSuperseded = request => {
    if (request.url() !== supersededUrl || settled.has(request)) return;
    settled.add(request);
    superseded.settled += 1;
  };
  page.context().on('requestfinished', settleSuperseded);
  page.context().on('requestfailed', settleSuperseded);
  await page.route(supersededUrl, async route => {
    superseded.started += 1;
    // The newer choice stops the superseded read and ends its reader worker,
    // whose requests are then never answered.
    onWorkerClose(page, /\/assets\/js\/data\/anndata-reader-worker\.js$/, () => settleSuperseded(route.request()));
    await new Promise(resolve => setTimeout(resolve, 1_500));
    await route.continue().catch(() => {});
  });
  await page.locator('#dataset-select').selectOption(
    optionValue('synthetic-development-3d'),
  );
  await expect.poll(() => superseded.started).toBeGreaterThan(0);
  await page.locator('#dataset-select').selectOption(
    optionValue('synthetic-trajectory-1d'),
  );

  await expect(page.locator('#dataset-name')).toHaveText(
    'Synthetic trajectory — 1D',
  );
  await expect(page.locator('#dataset-cells')).toHaveText('48');
  await expect
    .poll(() => page.evaluate(
      () => window._cellucidViewer.getPointCount(),
    ))
    .toBe(48);
  // Let the superseded 3-D load land if it were going to: every request it
  // issued has been answered or abandoned, and the page has run its
  // continuations without the load issuing another one.
  await expect.poll(async () => {
    const startedBefore = superseded.started;
    if (startedBefore === 0 || superseded.settled !== startedBefore) {
      return false;
    }
    await page.evaluate(() => new Promise(resolve => {
      setTimeout(() => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }, 0);
    }));
    return (
      superseded.started === startedBefore &&
      superseded.settled === startedBefore
    );
  }).toBe(true);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Synthetic trajectory — 1D',
  );
  await expect(page.locator('#dataset-select')).toHaveValue(
    optionValue('synthetic-trajectory-1d'),
  );
});

/* ------------------------------------------------------------------ *
 * Direct-file failures: wrong format, truncated, wrong directory, retry
 * ------------------------------------------------------------------ */

test('a non-h5ad file offered to the .h5ad picker fails bounded', async ({
  page,
}, testInfo) => {
  const decoy = await derivedFile(
    testInfo,
    'not-really.h5ad',
    Buffer.from(
      'cell_id,cell_type\nAAACCTG-1,T cell\nAAACGGG-1,B cell\n',
      'utf8',
    ),
  );

  await page.goto(catalogUrl(GOOD_CATALOG, GOOD_DATASET.id), {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await expectRenders(page, GOOD_DATASET);

  await page.locator('#user-data-file-input').setInputFiles(decoy);
  const errors = await captureFirstErrorNotification(page);
  await testInfo.attach('user-facing-failure-h5ad-wrong-format.json', {
    body: JSON.stringify({ errorNotifications: errors }, null, 2),
    contentType: 'application/json',
  });
  expect(errors.join('\n')).toContain(
    'The selected file is not a valid HDF5/H5AD file. '
      + 'Choose an AnnData .h5ad file or regenerate it with AnnData.',
  );

  // The dataset that was already on screen must survive a rejected file, and a
  // real file must still load afterwards.
  await expectRenders(page, GOOD_DATASET);
  await page.locator('#user-data-file-input').setInputFiles(h5adFixturePath);
  await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
  await expect
    .poll(() => page.evaluate(
      () => window._cellucidViewer.getPointCount(),
    ))
    .toBe(120);
});

test('a truncated .h5ad file fails bounded and the previous dataset survives', async ({
  page,
}, testInfo) => {
  const whole = await readFile(h5adFixturePath);
  const truncated = await derivedFile(
    testInfo,
    'truncated.h5ad',
    whole.subarray(0, Math.floor(whole.length / 3)),
  );

  await page.goto(catalogUrl(GOOD_CATALOG, GOOD_DATASET.id), {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await expectRenders(page, GOOD_DATASET);

  await page.locator('#user-data-file-input').setInputFiles(truncated);
  const errors = await captureFirstErrorNotification(page);
  await testInfo.attach('user-facing-failure-h5ad-truncated.json', {
    body: JSON.stringify({ errorNotifications: errors }, null, 2),
    contentType: 'application/json',
  });
  expect(errors.length).toBeGreaterThan(0);
  await expectRenders(page, GOOD_DATASET);
});

test('a truncated Zarr ZIP archive fails bounded and the previous dataset survives', async ({
  page,
}, testInfo) => {
  const whole = await readFile(zarrFixturePath);
  const truncated = await derivedFile(
    testInfo,
    'truncated.zarr.zip',
    whole.subarray(0, Math.floor(whole.length / 3)),
  );

  await page.goto(catalogUrl(GOOD_CATALOG, GOOD_DATASET.id), {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await expectRenders(page, GOOD_DATASET);

  await page
    .locator('#user-data-file-input')
    .setInputFiles(truncated);
  const errors = await captureFirstErrorNotification(page);
  await testInfo.attach('user-facing-failure-zarr-truncated.json', {
    body: JSON.stringify({ errorNotifications: errors }, null, 2),
    contentType: 'application/json',
  });
  expect(errors.length).toBeGreaterThan(0);
  await expectRenders(page, GOOD_DATASET);
});

test('a Zarr store folder chosen one level too high fails bounded', async ({
  page,
  browserName,
}, testInfo) => {
  await page.goto(catalogUrl(GOOD_CATALOG, GOOD_DATASET.id), {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await expectRenders(page, GOOD_DATASET);

  // Picking the folder that holds a store instead of the store itself is the
  // mistake a first-time user makes with a folder picker.
  await chooseDirectory(
    page.locator('#user-data-folder-input'),
    path.join(fixturesDirectory, 'forms-catalog'),
  );

  const errors = await captureFirstErrorNotification(page);
  await testInfo.attach('user-facing-failure-zarr-parent-folder.json', {
    body: JSON.stringify({ errorNotifications: errors }, null, 2),
    contentType: 'application/json',
  });
  // WebKit's folder dialog leaves out hidden files, so there the listing is
  // refused for that before the reader sees it.
  expect(errors.join('\n')).toContain(
    browserName === 'webkit'
      ? "left out the folder's hidden files"
      : 'Select the .zarr folder itself',
  );
  await expectRenders(page, GOOD_DATASET);
});

test('a rejected file can be fixed and re-picked without reloading', async ({
  page,
}, testInfo) => {
  const retryPath = await derivedFile(
    testInfo,
    'retry-same-name.h5ad',
    Buffer.from('not an hdf5 file at all\n', 'utf8'),
  );

  await page.goto(catalogUrl(GOOD_CATALOG, GOOD_DATASET.id), {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await expectRenders(page, GOOD_DATASET);

  await page.locator('#user-data-file-input').setInputFiles(retryPath);
  expect((await captureFirstErrorNotification(page)).length)
    .toBeGreaterThan(0);

  // The rejected file must not stay selected: a stale value means the same
  // path fires no `change` event and the user's retry is silently dropped.
  await expect
    .poll(() => page.locator('#user-data-file-input').evaluate(input => ({
      fileCount: input.files.length,
      value: input.value,
    })))
    .toEqual({ fileCount: 0, value: '' });

  // Replace the bad file with a real one under the same name and retry. The
  // dataset is named after the file, so the fixed file arrives as
  // "retry-same-name" carrying the fixture's 120 cells.
  await derivedFile(
    testInfo,
    'retry-same-name.h5ad',
    await readFile(h5adFixturePath),
  );
  await page.locator('#user-data-file-input').setInputFiles(retryPath);
  await expect(page.locator('#dataset-name')).toHaveText('retry-same-name');
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  await expect
    .poll(() => page.evaluate(
      () => window._cellucidViewer.getPointCount(),
    ))
    .toBe(120);
});
