import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=filter-legend-sync-ci`;

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  return errors;
}

async function openPreparedFixture(page) {
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
}

function activeContinuousFilter(page) {
  return page.evaluate(() => {
    const field = window._cellucidState.getActiveField();
    return { ...field._continuousFilter };
  });
}

test('removing a range filter from Active filters resets the legend sliders it drew', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openPreparedFixture(page);

  await page.locator('#continuous-field').selectOption({ label: 'score' });
  const sliders = page.locator('#legend .slider-row input[type="range"]');
  await expect(sliders).toHaveCount(2);
  await sliders.nth(1).fill('50');
  await expect(page.locator('#active-filters')).toContainText('score:');
  const narrowed = await activeContinuousFilter(page);

  await page.locator('#active-filters .list-item-remove').click();
  await expect(page.locator('#active-filters')).toHaveText('No filters active.');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  await expect(sliders.nth(0)).toHaveValue('0');
  await expect(sliders.nth(1)).toHaveValue('100');

  // Nudging Min must not resurrect the removed Max bound.
  await sliders.nth(0).fill('1');
  const nudged = await activeContinuousFilter(page);
  const stats = await page.evaluate(() => {
    const field = window._cellucidState.getActiveField();
    return { ...field._continuousStats };
  });
  expect(nudged.max).toBe(stats.max);
  expect(nudged.max).not.toBe(narrowed.max);

  expect(productErrors).toEqual([]);
});

test('removing a category filter from Active filters re-ticks its legend checkbox', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openPreparedFixture(page);

  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  const alphaRow = page.locator('.legend-item', {
    has: page.locator('.legend-label-main', { hasText: /^alpha$/ }),
  });
  await alphaRow.locator('.legend-checkbox').uncheck();
  await expect(page.locator('#filter-count')).toHaveText('Showing 80 of 120 cells');

  await page.locator('#active-filters .list-item-remove').click();
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  await expect(alphaRow.locator('.legend-checkbox')).toBeChecked();

  expect(productErrors).toEqual([]);
});

test('the annotation-mode highlight button follows the category checkbox', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await page.addInitScript(() => {
    window._simulate_repo_connected = true;
  });
  await openPreparedFixture(page);
  await page.evaluate(async () => {
    const { getCommunityAnnotationSession } = await import(
      '/assets/js/app/community-annotations/session.js'
    );
    getCommunityAnnotationSession().setFieldAnnotated('cell_type', true);
  });

  // An annotated field's option carries the voting badge before its key.
  const annotatedOption = page.locator('#categorical-field option', {
    hasText: /cell_type$/,
  });
  await expect(annotatedOption).toHaveCount(1);
  await page.locator('#categorical-field').selectOption(
    await annotatedOption.getAttribute('value'),
  );
  const alphaRow = page.locator('.legend-item', {
    has: page.locator('.legend-label-main', { hasText: /^alpha$/ }),
  });
  const highlightButton = alphaRow.locator('.legend-highlight-btn');
  await expect(highlightButton).toBeEnabled();

  await alphaRow.locator('.legend-checkbox').uncheck();
  await expect(page.locator('#filter-count')).toHaveText('Showing 80 of 120 cells');
  await expect(highlightButton).toBeDisabled();

  await alphaRow.locator('.legend-checkbox').check();
  await expect(highlightButton).toBeEnabled();
  await highlightButton.click();
  await expect(highlightButton).toHaveAttribute('aria-pressed', 'true');

  expect(productErrors).toEqual([]);
});
