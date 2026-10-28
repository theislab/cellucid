import { expect, test } from './helpers/test.mjs';
import { sampleUrl } from './helpers/origins.mjs';

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
  await page.getByRole('button', { name: /Choose a dataset/ }).click();

  const datasetSelect = page.locator('#dataset-select');
  await expect(
    datasetSelect.locator(`option[value="${CORS_SAMPLE_SELECTION}"]`),
  ).toHaveText(/Current UI fixture/);
  await expect(datasetSelect).toHaveValue(CORS_SAMPLE_SELECTION);
  // Onboarding leads to the Session panel, never into the dropdown itself;
  // a click moves no focus, so nothing is ringed.
  await expect(page.locator('#session-section > summary')).not.toBeFocused();
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

test('a failed direct CORS catalog is explained inline and stays recoverable', async ({ page }) => {
  const missingRoot = sampleUrl('/tests/browser/fixtures/missing-catalog/');
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
  await page.getByRole('button', { name: /Choose a dataset/ }).click();

  // One unreachable sample catalog is that catalog's failure. The selector
  // stays usable so a dataset opened from disk still needs no network at all.
  const datasetSelect = page.locator('#dataset-select');
  await expect(datasetSelect).toBeEnabled();
  await expect(datasetSelect.locator('option')).toHaveText([
    'None',
    'No datasets found',
  ]);

  const notice = page.locator('#dataset-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/Sample datasets could not be (loaded|opened)/);
  // This root is absent rather than blocked, and the notice says so: the 404
  // the loader reported reaches the user as an address to check, not as a
  // network problem to wait out.
  await expect(notice).toContainText(
    /nothing is published at that address .*Check the address for a typo, then try again/,
  );
  await expect(notice).not.toContainText(/Check your network/);
  // A transport diagnostic is never put in front of a biologist.
  await expect(notice).not.toContainText(/Resource not found/i);
  const retry = notice.getByRole('button', { name: 'Try again' });
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
