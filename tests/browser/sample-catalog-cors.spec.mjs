import { fileURLToPath } from 'node:url';

import { expect, test } from './helpers/test.mjs';
import { sampleUrl } from './helpers/origins.mjs';
import { expectWelcomeShown } from './helpers/welcome.mjs';

const TRUNCATED_CATALOG = fileURLToPath(new URL(
  './fixtures/broken-catalogs/truncated-catalog/datasets.json',
  import.meta.url,
));

const CORS_SAMPLE_ROOT = sampleUrl('/tests/browser/fixtures/catalog/');
const CORS_SAMPLE_SELECTION =
  'dataset:local-demo:current-ui';

function launchUrl(sampleCatalog, acceptance) {
  return (
    `/?sampleCatalog=${encodeURIComponent(sampleCatalog)}` +
    `&acceptance=${acceptance}`
  );
}

test('direct CORS catalog startup adopts its explicit default sample', async ({ page }) => {
  const browserErrors = [];
  const sampleRequests = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  // The AnnData reader reads in its worker: the context sees its requests.
  page.context().on('request', request => {
    if (request.url().startsWith(CORS_SAMPLE_ROOT)) {
      sampleRequests.push({
        method: request.method(),
        url: request.url(),
        range: request.headers().range ?? null,
      });
    }
  });

  await page.goto(
    launchUrl(CORS_SAMPLE_ROOT, 'sample-cors-catalog'),
    { waitUntil: 'domcontentloaded' },
  );
  await expectWelcomeShown(page);
  await page.getByRole('button', { name: /Start exploring/ }).click();
  await expect(page.locator('#welcome-modal')).toBeHidden();

  const datasetSelect = page.locator('#dataset-select');
  await expect(
    datasetSelect.locator(`option[value="${CORS_SAMPLE_SELECTION}"]`),
  ).toHaveText(/Current UI fixture/);
  await expect(datasetSelect).toHaveValue(CORS_SAMPLE_SELECTION);
  // Closing onboarding never moves focus into the dropdown.
  await expect(datasetSelect).not.toBeFocused();
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing all 120 cells',
  );
  await expect(page.locator('#view-representation-select option:checked')).toHaveText(/ · 2D$/);
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');
  const categoryBuilderToggle = page.locator(
    '#cat-builder-accordion-item .disclosure-header',
  );
  await expect(categoryBuilderToggle).toBeEnabled();
  await expect(categoryBuilderToggle).toHaveAttribute(
    'aria-disabled',
    'false',
  );
  await expect(page.locator('#cat-builder-dropzone')).toHaveAttribute(
    'aria-disabled',
    'false',
  );
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(
    await page.evaluate(() => window._cellucidViewer.getPointCount()),
  ).toBe(120);
  // The catalog is read once; its file is sized (HEAD, or a one-byte range)
  // and read in place with ranged GETs, never downloaded whole.
  expect(
    sampleRequests.filter(
      request => request.url === `${CORS_SAMPLE_ROOT}datasets.json`,
    ),
  ).toHaveLength(1);
  const fileReads = sampleRequests.filter(
    request => request.url === `${CORS_SAMPLE_ROOT}current-ui.h5ad`,
  );
  expect(fileReads.some(request => request.method === 'GET')).toBe(true);
  expect(
    fileReads.filter(request => request.method === 'GET' && !/^bytes=\d+-\d+$/.test(request.range ?? '')),
  ).toEqual([]);
  expect(
    sampleRequests.filter(request => !request.url.endsWith('datasets.json') && !request.url.endsWith('current-ui.h5ad')),
  ).toEqual([]);
  expect(browserErrors).toEqual([]);
});

/**
 * Each of these is a different thing going wrong with a catalog, and the
 * loader knows which: a `DataSourceError` code, or the HTTP status the server
 * answered with. The first is the answer of the catalog's own server; the
 * others are given for the same address, each after Try again.
 */
const LATER_CATALOG_FAILURES = Object.freeze([
  Object.freeze({
    label: 'permission-denied',
    answer: { status: 403, contentType: 'text/plain', body: 'no' },
    expect: /refused datasets\.json \(HTTP 403, forbidden\): .* the link's permissions/,
    forbid: /Check your network/,
  }),
  Object.freeze({
    label: 'server-error',
    answer: { status: 500, contentType: 'text/plain', body: 'no' },
    expect: /is not answering \(HTTP 500, a server error\) for datasets\.json: a problem on [^ ]+'s side, not with the link or with Cellucid/,
    forbid: /Check your network/,
  }),
  Object.freeze({
    // A body that is not a dataset list and a dropped connection arrive at the
    // UI as the same error, so they honestly share one sentence naming both.
    label: 'not-a-dataset-list',
    answer: { status: 200, contentType: 'application/json', path: TRUNCATED_CATALOG },
    expect: /may not hold Cellucid data/,
    forbid: /not found|refused access/,
  }),
]);

test('a failed direct CORS catalog names its own cause, whatever the cause, and stays recoverable', async ({ page }, testInfo) => {
  const noticeText = () => page.locator('#dataset-notice .dataset-notice-message').first().innerText();
  const seenCatalogSentences = new Map();
  /** What every catalog failure's notice holds, whatever went wrong. */
  const expectCatalogNotice = async failure => {
    await expect.poll(noticeText).toMatch(failure.expect);
    const message = await noticeText();
    await testInfo.attach(`catalog-notice-${failure.label}.txt`, {
      body: message,
      contentType: 'text/plain',
    });
    expect(message).toMatch(/^Sample datasets could not be loaded/);
    expect(message).not.toMatch(failure.forbid);
    // The notice speaks to a bench scientist: whose problem it is, with
    // the host's status (`describeHostFault`), never a URL or a transport term.
    expect(message).not.toMatch(/https?:|CORS|gzip|JSON/);

    // Every failure keeps the notice's persistent retry.
    await expect(page.locator('#dataset-notice button')).toHaveText('Try again');
    await expect(page.locator('#dataset-notice button')).toBeEnabled();

    // No two of these read the same.
    expect(
      seenCatalogSentences.has(message)
        ? seenCatalogSentences.get(message)
        : failure.label,
    ).toBe(failure.label);
    seenCatalogSentences.set(message, failure.label);
  };
  let datasetSelect;
  let notice;
  let retry;
  let missingRoot;

  await test.step('a failed direct CORS catalog is explained inline and stays recoverable', async () => {
    missingRoot = sampleUrl('/tests/browser/fixtures/missing-catalog/');
    const catalogRequests = [];
    page.on('request', request => {
      if (request.url() === `${missingRoot}datasets.json`) {
        catalogRequests.push(request.url());
      }
    });

    await page.goto(
      launchUrl(missingRoot, 'sample-cors-failure'),
      { waitUntil: 'domcontentloaded' },
    );
    await expectWelcomeShown(page);
    await page.getByRole('button', { name: /Start exploring/ }).click();
    await expect(page.locator('#welcome-modal')).toBeHidden();

    // One unreachable sample catalog is that catalog's failure. The selector
    // stays usable so a dataset opened from disk still needs no network at all.
    datasetSelect = page.locator('#dataset-select');
    await expect(datasetSelect).toBeEnabled();
    await expect(datasetSelect.locator('option')).toHaveText([
      'None',
      'No datasets found',
    ]);

    notice = page.locator('#dataset-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/Sample datasets could not be (loaded|opened)/);
    // This root is absent rather than blocked, and the notice says so: the 404
    // the loader reported reaches the user as an address to check, not as a
    // network problem to wait out.
    await expect(notice).toContainText(
      /datasets\.json was not found at [^ ]+ \(HTTP 404, not found\): the link or record does not exist, or it moved\. Check the link/,
    );
    await expect(notice).not.toContainText(/Check your network/);
    // A transport diagnostic is never put in front of a biologist.
    await expect(notice).not.toContainText(/Resource not found/i);
    retry = notice.getByRole('button', { name: 'Try again' });
    await expect(retry).toBeEnabled();

    await expect(page.locator('#dataset-name')).toHaveText('No dataset open');
    await expect(page.locator('#stats')).toHaveText('0 cells • Field: None');
    await expect(page.locator('iframe')).toHaveCount(0);
    expect(
      await page.evaluate(() => window._cellucidViewer.getPointCount()),
    ).toBe(0);
    expect(catalogRequests).toHaveLength(1);

    // A cached probe failure is never re-fetched implicitly, so the second
    // request proves the retry cleared it. Recovery costs no page reload.
    await retry.click();
    await expect.poll(() => catalogRequests.length).toBe(2);
    await expect(notice).toBeVisible();
    await expect(retry).toBeEnabled();
    await expect(datasetSelect).toBeEnabled();
  });

  await test.step('a wrong-address catalog is reported as wrong-address, not as a network problem', async () => {
    await expectCatalogNotice({
      label: 'wrong-address',
      expect: /datasets\.json was not found at [^ ]+ \(HTTP 404, not found\): the link or record does not exist/,
      forbid: /Check your network/,
    });
  });

  for (const failure of LATER_CATALOG_FAILURES) {
    await test.step(`a ${failure.label} catalog is reported as ${failure.label}, not as a network problem`, async () => {
      await page.unrouteAll({ behavior: 'wait' });
      // The answer of another origin: readable by the page only with the header.
      await page.route(`${missingRoot}datasets.json`, route => route.fulfill({
        ...failure.answer,
        headers: { 'access-control-allow-origin': '*' },
      }));
      await retry.click();
      await expectCatalogNotice(failure);
      await expect(datasetSelect).toBeEnabled();
    });
  }
});
