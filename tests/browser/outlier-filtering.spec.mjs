import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=outlier-filter-ci`;
// The current-ui fixture stores no outlier quantiles: they are computed from
// its latent space on the filter's first use.
const CURRENT_UI_FILE = `${SAMPLE_ORIGIN}/tests/browser/fixtures/catalog/current-ui.h5ad`;
// Written by prepare(latent_key="X_scVI") (scripts/generate-outlier-quantile-fixtures.py):
// every categorical field's quantiles are stored.
const STORED = `${SAMPLE_ORIGIN}/tests/browser/fixtures/outliers-stored.h5ad`;
const STORED_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(STORED)}`;

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      errors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return errors;
}

test('latent-space outlier filtering uses the active field raw quantiles', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);

  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('#outlier-filter-container')).toBeVisible();
  // Before anything is read, the control says what its first use reads.
  await expect(page.locator('#outlier-filter-note'))
    .toContainText('The first use reads the latent space latent_space');

  await page.locator('#outlier-filter').fill('50');
  await page.locator('#outlier-filter').dispatchEvent('change');

  await expect(page.locator('#filter-count')).toHaveText('Showing 60 of 120 cells');
  await expect(page.locator('#active-filters')).toContainText('cell_type: outlier ≤ 50%');
  await expect(page.locator('#outlier-filter-note')).toBeHidden();

  const filteredState = await page.evaluate(() => {
    const state = window._cellucidState;
    return {
      quantiles: Array.from(state.getActiveOutlierQuantiles()),
      transparency: Array.from(state.categoryTransparency),
      visibility: Array.from(state.cellVisibilityMask),
    };
  });
  expect(filteredState.quantiles).toHaveLength(120);
  expect(filteredState.quantiles.every(value => Number.isFinite(value) && value >= 0 && value <= 1))
    .toBe(true);
  expect(filteredState.transparency).toEqual(
    filteredState.quantiles.map(quantile => (quantile <= 0.5 ? 1 : 0)),
  );
  expect(filteredState.visibility).toEqual(new Array(120).fill(1));

  await page.locator('#continuous-field').selectOption({ label: 'score' });
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  await expect(page.locator('#active-filters')).toHaveText('No filters active.');
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('#filter-count')).toHaveText('Showing 60 of 120 cells');
  await expect(page.locator('#active-filters')).toContainText('cell_type: outlier ≤ 50%');

  await page.locator('#outlier-filter').fill('100');
  await page.locator('#outlier-filter').dispatchEvent('change');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  await expect(page.locator('#active-filters')).toHaveText('No filters active.');
  expect(productErrors).toEqual([]);
});

test('stored quantiles filter at once, one field read at a time; a field too small says so', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  const reads = [];
  page.context().on('request', request => {
    if (request.url() === STORED) reads.push(request.headers().range ?? null);
  });
  await page.goto(STORED_URL, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Outliers stored');
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('#outlier-filter-container')).toBeVisible();
  await expect(page.locator('#outlier-filter')).toBeEnabled();
  await expect(page.locator('#outlier-filter-note')).toBeHidden();

  const before = reads.length;
  await page.locator('#outlier-filter').fill('90');
  await page.locator('#outlier-filter').dispatchEvent('change');
  await expect(page.locator('#active-filters')).toContainText('cell_type: outlier ≤ 90%');
  const counts = await page.evaluate(() => {
    const state = window._cellucidState;
    const quantiles = state.getActiveOutlierQuantiles();
    let kept = 0;
    for (const quantile of quantiles) if (quantile <= 0.9) kept++;
    return { kept, total: quantiles.length };
  });
  await expect(page.locator('#filter-count')).toHaveText(`Showing ${counts.kept} of ${counts.total} cells`);
  // One field's array, never the 600 x 12 latent space: a few ranges at most.
  expect(reads.length - before).toBeLessThanOrEqual(3);

  // The latent space the file stores them for is marked in Data mapping.
  await expect(page.locator('#data-mapping-latent option[value="X_scVI"]')).toContainText('outliers stored');

  // 'rare' has no category of 10 cells.
  await page.locator('#categorical-field').selectOption({ label: 'rare' });
  await expect(page.locator('#outlier-filter')).toBeDisabled();
  await expect(page.locator('#outlier-filter-note')).toContainText('No category of “rare” has 10 cells');
  expect(productErrors).toEqual([]);
});

test('computing can be cancelled: nothing is kept, the slider is back at 100%, and it can start again', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('#outlier-filter-note')).toContainText('first use reads the latent space');

  // The 120-cell fixture is read in a moment; hold the computation until the
  // test lets it go, as a large remote latent space would, honouring Cancel.
  await page.evaluate(() => {
    const loader = window._cellucidState.fieldLoader;
    const load = loader.loadOutlierQuantiles;
    window.__releaseOutliers = null;
    loader.loadOutlierQuantiles = (field, options) => new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      window.__releaseOutliers = () => load(field, options).then(resolve, reject);
    });
  });
  await page.locator('#outlier-filter').fill('50');
  await page.locator('#outlier-filter').dispatchEvent('change');
  await expect(page.locator('#outlier-filter-progress')).toBeVisible();
  await expect(page.locator('#outlier-filter-note')).toContainText('the outlier distances');
  await expect(page.locator('#outlier-filter-action')).toHaveText('Cancel');
  await page.locator('#outlier-filter-action').click();

  await expect(page.locator('#outlier-filter-progress')).toBeHidden();
  await expect(page.locator('#outlier-filter')).toHaveValue('100');
  await expect(page.locator('#outlier-filter-note')).toContainText('first use reads the latent space');
  await expect(page.locator('#active-filters')).toHaveText('No filters active.');
  expect(await page.evaluate(() => window._cellucidState.getActiveField().outlierQuantiles ?? null)).toBeNull();

  // Started again, it completes.
  await page.locator('#outlier-filter').fill('50');
  await page.locator('#outlier-filter').dispatchEvent('change');
  await expect(page.locator('#outlier-filter-progress')).toBeVisible();
  await page.evaluate(() => window.__releaseOutliers());
  await expect(page.locator('#filter-count')).toHaveText('Showing 60 of 120 cells');
  await expect(page.locator('#outlier-filter-progress')).toBeHidden();
  await expect(page.locator('#outlier-filter-note')).toBeHidden();
  expect(productErrors).toEqual([]);
});

test('without a latent space the control explains itself and opens the setting that turns it on', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  const smoke = `${SAMPLE_ORIGIN}/tests/browser/fixtures/current-ui-smoke.h5ad`;
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(smoke)}`, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('#outlier-filter-container')).toBeVisible();
  await expect(page.locator('#outlier-filter')).toBeDisabled();
  await expect(page.locator('#outlier-filter-note')).toContainText('not in the 2D/3D layout');
  await expect(page.locator('#outlier-filter-action')).toHaveText('Choose latent space');
  await page.locator('#outlier-filter-action').click();
  const latent = page.locator('#data-mapping-latent');
  await expect(latent).toBeVisible();
  await expect(latent).toBeFocused();
  expect(productErrors).toEqual([]);
});
