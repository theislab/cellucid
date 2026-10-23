import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

// The sample server answers single-range requests with 206 and allows any
// origin, as a bucket or a repository's file host does. A link to one of its
// files must open the file in place: only ranges are requested, never the
// whole body.
const FIXTURE = `${SAMPLE_ORIGIN}/tests/browser/fixtures/current-ui-smoke.h5ad`;
// The sample catalog is pinned at the local fixture, so no test reaches the
// network for the published one.
const PINNED = `sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&`;

test('an .h5ad link opens in place from ?data= with range requests only', async ({ page }) => {
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => browserErrors.push(`page: ${error.stack || error.message}`));
  const reads = [];
  page.context().on('request', request => {
    if (request.url() === FIXTURE) {
      reads.push({ method: request.method(), range: request.headers().range ?? null });
    }
  });

  await page.goto(`/?${PINNED}data=${encodeURIComponent(FIXTURE)}`, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(page);

  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  await expect(page.locator('#data-link-url')).toHaveValue(FIXTURE);
  // The Transfers panel says what is read, from where, and where it goes.
  const transfer = page.locator('#transfers-list .transfer-row');
  await expect(transfer).toHaveCount(1);
  await expect(transfer).toContainText('current-ui-smoke · reading in place');
  await expect(transfer).toContainText('/tests/browser/fixtures/current-ui-smoke.h5ad');
  await expect(transfer).toContainText('memory only: nothing is saved to disk');

  const gets = reads.filter(read => read.method === 'GET');
  expect(gets.length).toBeGreaterThan(0);
  expect(gets.filter(read => !/^bytes=\d+-\d+$/.test(read.range ?? ''))).toEqual([]);
  expect(new URL(page.url()).searchParams.get('data')).toBe(FIXTURE);
  expect(browserErrors).toEqual([]);
});

test('a Zarr ZIP link opens in place from ?data=', async ({ page }) => {
  const archive = `${SAMPLE_ORIGIN}/tests/browser/fixtures/current-ui-smoke.zarr.zip`;
  await page.goto(`/?${PINNED}data=${encodeURIComponent(archive)}`, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
});

test('Open from link refuses text it does not recognise before connecting', async ({ page }) => {
  await page.goto(`/?${PINNED}data=` + encodeURIComponent(FIXTURE), { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
  await page.locator('#data-link-disconnect-btn').click();
  await page.locator('#data-link-url').fill('not a link');
  await page.locator('#data-link-connect-btn').click();
  await expect(
    page.locator('#notification-center .notification').filter({ hasText: 'Cellucid does not recognise "not a link"' }),
  ).toHaveCount(1);
});

test('a linked file that states its id (uns[\'cellucid\'][\'id\']) keeps it, read with ranges only', async ({ page }) => {
  const fileUrl = `${SAMPLE_ORIGIN}/tests/browser/fixtures/forms-catalog/forms-h5ad.h5ad`;
  const reads = [];
  page.context().on('request', request => {
    // The size probe is a HEAD; every read of the bytes is a ranged GET.
    if (request.url() === fileUrl && request.method() === 'GET') {
      reads.push(request.headers().range ?? null);
    }
  });
  await page.goto(`/?${PINNED}data=${encodeURIComponent(fileUrl)}`, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(page);
  // Its name is the one it states (uns['cellucid']['name']).
  await expect(page.locator('#dataset-name')).toHaveText('Forms — .h5ad');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 48 cells');
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.filter(range => !/^bytes=\d+-\d+$/.test(range ?? ''))).toEqual([]);
  expect(await page.evaluate(async () => {
    const { getDataSourceManager } = await import('/assets/js/data/data-source-manager.js');
    return getDataSourceManager().getCurrentIdentityId();
  })).toBe('forms-h5ad');
});

test('a Zarr store folder link opens in place through its consolidated metadata', async ({ page }) => {
  const folder = `${SAMPLE_ORIGIN}/tests/browser/fixtures/forms-catalog/forms-zarr.zarr/`;
  await page.goto(`/?${PINNED}data=${encodeURIComponent(folder)}`, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Forms — Zarr folder');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 48 cells');
});

test('a catalog link lists every form a catalog holds and opens the one chosen', async ({ page }) => {
  const catalog = `${SAMPLE_ORIGIN}/tests/browser/fixtures/forms-catalog/`;
  await page.goto(
    `/?${PINNED}data=${encodeURIComponent(catalog)}&dataset=forms-zarr-zip`,
    { waitUntil: 'domcontentloaded' },
  );
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Forms — Zarr ZIP');
  for (const id of ['forms-h5ad', 'forms-zarr-zip', 'forms-zarr']) {
    await expect(page.locator(`#dataset-select option[value="dataset:link:${id}"]`)).toHaveCount(1);
  }
  await page.locator('#dataset-select').selectOption('dataset:link:forms-zarr');
  await expect(page.locator('#dataset-name')).toHaveText('Forms — Zarr folder');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 48 cells');
});

test('a catalog link without dataset= opens the dataset its catalog names as default', async ({ page }) => {
  // datasets.json must name a default; a link to a catalog of several opens
  // on it, as the sample catalog does, and dataset= still picks another.
  const catalog = `${SAMPLE_ORIGIN}/tests/browser/fixtures/demo-catalog/`;
  await page.goto(`/?${PINNED}data=${encodeURIComponent(catalog)}`, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Synthetic cell-type islands — 2D');

  await page.goto(
    `/?${PINNED}data=${encodeURIComponent(catalog)}&dataset=synthetic-trajectory-1d`,
    { waitUntil: 'domcontentloaded' },
  );
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Synthetic trajectory — 1D');
});
