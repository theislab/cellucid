import { expect, test } from '@playwright/test';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=outlier-filter-ci`;

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

  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('#outlier-filter-container')).toHaveClass(/visible/);

  await page.locator('#outlier-filter').fill('50');
  await page.locator('#outlier-filter').dispatchEvent('change');

  await expect(page.locator('#filter-count')).toHaveText('Showing 60 of 120 points');
  await expect(page.locator('#active-filters')).toContainText('cell_type: outlier ≤ 50%');

  const filteredState = await page.evaluate(() => {
    const state = window._cellucidState;
    return {
      quantiles: Array.from(state.outlierQuantilesArray),
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
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 points');
  await expect(page.locator('#active-filters')).toHaveText('No filters active');
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('#filter-count')).toHaveText('Showing 60 of 120 points');
  await expect(page.locator('#active-filters')).toContainText('cell_type: outlier ≤ 50%');

  await page.locator('#outlier-filter').fill('100');
  await page.locator('#outlier-filter').dispatchEvent('change');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 points');
  await expect(page.locator('#active-filters')).toHaveText('No filters active');
  expect(productErrors).toEqual([]);
});
