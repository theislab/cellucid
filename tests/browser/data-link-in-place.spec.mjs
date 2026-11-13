import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { waitForPageAtRest } from './helpers/dataset-ready.mjs';

// The sample server answers single-range requests with 206 and allows any
// origin, as a bucket or a repository's file host does. A link to one of its
// files must open the file in place: only ranges are requested, never the
// whole body.
const FIXTURE = `${SAMPLE_ORIGIN}/tests/browser/fixtures/current-ui-smoke.h5ad`;
// The sample catalog is pinned at the local fixture, so no test reaches the
// network for the published one.
const PINNED = `sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&`;

test('an .h5ad link opens in place and the address bar says what it cannot open', async ({ page }) => {
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => browserErrors.push(`page: ${error.stack || error.message}`));
  const reads = [];
  const catalogRequests = [];
  page.context().on('request', request => {
    if (request.url() === FIXTURE) {
      reads.push({ method: request.method(), range: request.headers().range ?? null });
    }
    if (request.url().startsWith(SAMPLE_CATALOG_URL)) catalogRequests.push(request.url());
  });
  // A web host that holds no catalog, for the last step.
  await page.route('https://example.org/**', route => route.fulfill({
    status: 404,
    contentType: 'text/html',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: '<html>Not Found</html>',
  }));

  await page.goto(`/?${PINNED}data=${encodeURIComponent(FIXTURE)}`, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(page);

  await test.step('an .h5ad link opens in place from ?data= with range requests only', async () => {
    await expect(page.locator('#welcome-modal')).toBeHidden();
    await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
    await expect(page.locator('#dataset-cells')).toHaveText('120');
    await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
    await expect(page.locator('#data-address')).toHaveValue(FIXTURE);
    // The Dataset box says where it is read from and how much has been read;
    // the connection is one line under the address bar.
    await expect(page.locator('#dataset-origin')).toHaveText(`h5ad file · ${new URL(FIXTURE).host}`);
    await expect(page.locator('#dataset-read')).toHaveText(/^(Reading… )?[\d.]+ (B|KB|MB) read in \d+ requests?$/);
    await expect(page.locator('#data-link-disconnect-container')).toBeVisible();
    await expect(page.locator('#data-link-connection-target')).toHaveText(`${new URL(FIXTURE).host}/…/current-ui-smoke.h5ad`);
    await expect(page.locator('#data-link-connection-target')).toHaveAttribute('title', FIXTURE);
    await page.locator('#dataset-details .disclosure-header').click();
    await expect(page.locator('#dataset-details-list')).toContainText('In place from');
    await expect(page.locator('#transfers-list')).toHaveCount(0);

    const gets = reads.filter(read => read.method === 'GET');
    expect(gets.length).toBeGreaterThan(0);
    expect(gets.filter(read => !/^bytes=\d+-\d+$/.test(read.range ?? ''))).toEqual([]);
    expect(new URL(page.url()).searchParams.get('data')).toBe(FIXTURE);
    expect(browserErrors).toEqual([]);
  });

  await test.step('a link open reads no sample file until the picker is reached for', async () => {
    // The picker names the samples as `datasets.json` lists them; their files
    // are not read.
    const sample = page.locator('#dataset-select option[value="dataset:local-demo:current-ui"]');
    await expect(sample).toHaveText('current-ui');
    await page.waitForLoadState('networkidle');
    expect(catalogRequests).toEqual([`${SAMPLE_CATALOG_URL}datasets.json`]);
    // Reaching for the picker reads them, and each option gains its name and count.
    await page.locator('#dataset-select').focus();
    await expect(sample).toHaveText('Current UI fixture (120 cells)');
    expect(catalogRequests.some(url => url.endsWith('current-ui.h5ad'))).toBe(true);
    // The link's dataset stays the one on screen.
    await expect(page.locator('#dataset-cells')).toHaveText('120');
    expect(new URL(page.url()).searchParams.get('data')).toBe(FIXTURE);
  });

  await test.step('a folder link without datasets.json says so, whichever host serves it', async () => {
    // A web address the text cannot settle is first asked whether it is a
    // Cellucid server; the link that follows says how the opening ends, as a
    // GitHub path does. A loopback host and any other web host alike.
    // The Dataset box fills in after its name and moves the controls under it:
    // a click made meanwhile is pressed on one thing and released on another.
    await waitForPageAtRest(page);
    for (const folder of [`${SAMPLE_ORIGIN}/tests/browser/fixtures/`, 'https://example.org/atlas/']) {
      await page.locator('#data-address').fill(folder);
      await page.locator('#data-address-open-btn').click();
      const refusal = page.locator('#notification-center .notification[data-type="error"]').filter({
        hasText: `${folder} holds no datasets.json, so it is not a dataset catalog. Link to the folder that holds datasets.json`,
      });
      await expect(refusal).toHaveCount(1);
      await refusal.locator('.notification-dismiss').click();
      await expect(refusal).toHaveCount(0);
    }
    // Typed without http://, a loopback address is a server's: one that
    // answers but is no Cellucid server says so, and how to open a folder there.
    const schemeless = `${SAMPLE_ORIGIN.replace(/^http:\/\//, '')}/tests/browser/fixtures/`;
    await page.locator('#data-address').fill(schemeless);
    await page.locator('#data-address-open-btn').click();
    const notServer = page.locator('#notification-center .notification[data-type="error"]').filter({
      hasText: 'answers, but it is not a Cellucid server',
    });
    await expect(notServer).toHaveCount(1);
    await expect(notServer).toContainText('type the address of its datasets.json');
    // The dataset on screen stays.
    await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
  });
});

test('a Zarr ZIP link opens in place from ?data=', async ({ page }) => {
  const archive = `${SAMPLE_ORIGIN}/tests/browser/fixtures/current-ui-smoke.zarr.zip`;
  await page.goto(`/?${PINNED}data=${encodeURIComponent(archive)}`, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
});

test('a Zarr store folder link opens in place through its consolidated metadata', async ({ page }) => {
  const folder = `${SAMPLE_ORIGIN}/tests/browser/fixtures/forms-catalog/forms-zarr.zarr/`;
  await page.goto(`/?${PINNED}data=${encodeURIComponent(folder)}`, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Forms — Zarr folder');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 48 cells');
});

test('a catalog link opens its default, dataset= picks another, the picker lists every form', async ({ page }) => {
  await test.step('a catalog link without dataset= opens the dataset its catalog names as default', async () => {
    // datasets.json must name a default; a link to a catalog of several opens
    // on it, as the sample catalog does.
    const catalog = `${SAMPLE_ORIGIN}/tests/browser/fixtures/demo-catalog/`;
    await page.goto(`/?${PINNED}data=${encodeURIComponent(catalog)}`, { waitUntil: 'domcontentloaded' });
    await openCollapsedPanels(page);
    await expect(page.locator('#dataset-name')).toHaveText('Synthetic cell-type islands — 2D');
  });

  await test.step('a catalog link lists every form a catalog holds and opens the one chosen', async () => {
    // dataset= picks another than the default.
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
});
