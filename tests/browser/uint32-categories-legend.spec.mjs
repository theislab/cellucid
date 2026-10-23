/**
 * A field with more categories than uint16 codes carry
 * (`fixtures/uint32-categories.h5ad`, 70,000 categories, three of them used)
 * loads, and its legend builds only the rows in view.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'uint32-categories.h5ad',
);

test('a field with more categories than uint16 carries loads, and its legend builds only the rows in view', async ({ page }) => {
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });

  await page.goto(
    `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=browser-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');

  await page.locator('#user-data-h5ad-input').setInputFiles(fixturePath);
  await expect(page.locator('#dataset-name')).toHaveText('uint32 categories');
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });

  const list = page.locator('.legend-items-container.legend-items-virtual');
  await expect(list).toBeVisible();
  const rowCount = await page.locator('.legend-item').count();
  expect(rowCount).toBeGreaterThan(0);
  expect(rowCount).toBeLessThan(200);
  // The categories cells hold come first.
  await expect(page.locator('.legend-item .legend-label-main').first()).toHaveText(/^(alpha|beta|gamma)$/);

  // The end of the inventory, categories no cell holds, is reachable, and
  // only a window of rows exists.
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator('.legend-item .legend-label-main').last()).toHaveText(/^zz-\d{6}$/);
  expect(await page.locator('.legend-item').count()).toBeLessThan(200);

  // Hiding a category filters its cells, and the row keeps its state when
  // it is rebuilt after scrolling away and back.
  await list.evaluate(element => { element.scrollTop = 0; });
  const beta = page.locator('.legend-item', { hasText: 'beta' });
  await beta.locator('.legend-checkbox').uncheck();
  // The fixture's cell_type holds 40 beta cells.
  await expect(page.locator('#filter-count')).toHaveText('Showing 80 of 120 cells');
  await list.evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
  await list.evaluate(element => { element.scrollTop = 0; });
  await expect(page.locator('.legend-item', { hasText: 'beta' }).locator('.legend-checkbox')).not.toBeChecked();

  expect(browserErrors).toEqual([]);
});
