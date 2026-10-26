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
import { chooseFiles } from './helpers/file-input.mjs';

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

  await chooseFiles(page.locator('#user-data-file-input'), fixturePath);
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

  // A scroll of a few rows keeps the rows still in view as they are: the same
  // nodes, never detached, so whatever is focused or open in one (a checkbox,
  // a rename) survives the scroll. Rebuilding the window replaced every row,
  // dropping the focus to the page. (The rows past the three used categories
  // hold no cells, so their controls are disabled and take no focus here;
  // the row's identity is what the focus depends on.)
  // Past the overscan, so each scroll step moves the window.
  const stride = await list.evaluate(async element => {
    const row = element.querySelector('.legend-item');
    const pitch = row.nextElementSibling.offsetTop - row.offsetTop;
    element.scrollTop = 200 * pitch;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return pitch;
  });
  const before = await page.locator('.legend-item', { hasText: /^zz-/ }).nth(30).evaluate(row => {
    window.__keptLegendRow = row;
    window.__firstLegendRow = row.parentElement.firstElementChild;
    return row.textContent;
  });
  await list.evaluate(async (element, pitch) => {
    for (let step = 1; step <= 3; step++) {
      element.scrollTop = (200 + step) * pitch;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
  }, stride);
  // The window did move, and the row still in it is the same node.
  expect(await page.evaluate(() => window.__firstLegendRow.isConnected)).toBe(false);
  expect(await page.evaluate(() => window.__keptLegendRow.isConnected)).toBe(true);
  expect(await page.evaluate(() => window.__keptLegendRow.textContent)).toBe(before);

  expect(browserErrors).toEqual([]);
});
