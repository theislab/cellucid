/**
 * Nothing in the sidebar runs past it: Quick's
 * statistics table fits its panel at the sidebar's width, a long field name
 * wraps in its cell, and highlight page tabs show their names whole when the
 * row has room.
 *
 * The fixture (`current-ui`): 120 cells, `cell_type` (alpha, beta, gamma), a
 * continuous `score`.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=sidebar-fit`;
const CELL_TYPE = Object.freeze({ source: 'obs', key: 'cell_type' });

function dispatch(page, type, params) {
  return page.evaluate(async ({ type, params }) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    return (await getActions().dispatch(type, params)).outcome;
  }, { type, params });
}

/** Elements of `root` whose right edge is past `root`'s. */
function overflowing(locator) {
  return locator.evaluate(root => {
    const edge = root.getBoundingClientRect().right + 0.5;
    return [...root.querySelectorAll('*')]
      .filter(element => element.getClientRects().length > 0 && element.getBoundingClientRect().right > edge)
      .map(element => `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`);
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  await dispatch(page, 'highlight.category', { field: CELL_TYPE, categories: ['alpha'], page: 'Page 1' });
  await dispatch(page, 'highlight.category', { field: CELL_TYPE, categories: ['beta'], page: 'Page 2' });
  await dispatch(page, 'highlight.category', { field: CELL_TYPE, categories: ['gamma'], page: 'Page 3' });
});

test('the sidebar fits its panel: Quick statistics with a long field name, and the highlight page tabs', async ({ page }) => {
  await test.step('Quick statistics fit their panel, a long field name included', async () => {
    // A continuous field with a long name, as an AnnData often has.
    await dispatch(page, 'field.push', {
      key: 'total_counts_mitochondrial_fraction_log1p', kind: 'continuous', categories: null, n_obs: 120, cells: null,
      values: Array.from({ length: 120 }, (_, at) => at / 120),
    });
    await page.evaluate(() => { document.getElementById('page-analysis-section').open = true; });
    await page.locator('#analysis-header-simple').click();
    const panel = page.locator('#analysis-panel-simple');
    const table = panel.locator('.insights-stats-table');
    await expect(table).toBeVisible();
    await expect(table.locator('th').last()).toHaveText('Pop. SD');
    await expect(table.locator('th').last()).toHaveAttribute('title', /Population standard deviation/);
    await expect(table.locator('td', { hasText: 'total_counts_mitochondrial_fraction_log1p' })).toBeVisible();
    expect(await overflowing(panel)).toEqual([]);
  });
  await test.step('highlight page tabs show their names whole beside free room', async () => {
    await page.evaluate(() => { document.getElementById('highlighted-cells-section').open = true; });
    const names = page.locator('#highlight-pages-tabs .highlight-page-tab-name');
    await expect(names).toHaveCount(3);
    for (const name of await names.all()) {
      expect(await name.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    expect(await overflowing(page.locator('#highlighted-cells-section'))).toEqual([]);
  });
});
