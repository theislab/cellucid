/**
 * Cells to open (Session › Open data): a share of the cells, applied to the
 * open dataset in place.
 *
 * - Below 100 % the count, the method's settings and Apply appear; Apply
 *   reads the dataset again with exactly the cells the specification keeps
 *   (`data/subsample.js`), and everything (point count, the Dataset box, the
 *   cell identity) names them.
 * - A highlight made before is carried across by original cell position:
 *   the cells of it still open, and no other.
 * - Back at 100 %, every cell is open again.
 *
 * Fixture: `data-mapping-full.h5ad` (300 cells).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { chooseFiles } from './helpers/file-input.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FILE = path.join(FIXTURES, 'data-mapping-full.h5ad');
const START_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=subsample-control';

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

/**
 * The open cell count, 0 until the application has published its state: a
 * link's dataset is polled for straight after navigation, while startup still
 * runs, and `expect.poll` fails at once on a callback that throws.
 */
async function pointCount(page) {
  return page.evaluate(() => window._cellucidState?.pointCount ?? 0);
}

/** The original positions of the cells of the highlight group labelled `label`, ascending. */
async function highlightOriginals(page, label) {
  return page.evaluate(name => {
    const state = window._cellucidState;
    for (const pageEntry of state.getHighlightPages()) {
      const group = pageEntry.highlightedGroups.find(item => item.label === name);
      // A subsample's cells open in priority order: positions say nothing of the originals' order.
      if (group) return Array.from(state.cellIdentity.toOriginal(group.cellIndices)).sort((a, b) => a - b);
    }
    return null;
  }, label);
}

test('a share of the cells is read in place, and a highlight keeps its cells that stay open', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await openCollapsedPanels(page);
  await chooseFiles(page.locator('#user-data-file-input'), FILE);
  await expect.poll(() => pointCount(page)).toBe(300);

  // At 100 %: every cell, nothing to apply, no settings.
  await expect(page.locator('#subsample-count')).toHaveText('All 300 cells');
  await expect(page.locator('#subsample-settings')).toBeHidden();
  await expect(page.locator('#subsample-apply')).toBeDisabled();

  // A highlight on the first 60 cells.
  await page.evaluate(() => {
    window._cellucidState.addHighlightDirect({
      cellIndices: Uint32Array.from({ length: 60 }, (_, i) => i),
      label: 'probe',
      type: 'lasso',
    });
  });

  await page.locator('#subsample-percent').fill('40');
  await expect(page.locator('#subsample-count')).toHaveText('120 of 300 cells');
  await expect(page.locator('#subsample-settings')).toBeVisible();
  await expect(page.locator('#subsample-apply')).toBeEnabled();
  // The file's default (blocks, for a file not in priority order); this
  // spec checks uniform's cells.
  await expect(page.locator('#subsample-method')).toHaveValue('');
  await expect(page.locator('#subsample-method option').first()).toContainText('blocks aligned');
  await page.locator('#subsample-method').selectOption('uniform');
  await page.locator('#subsample-seed').fill('7');
  await page.locator('#subsample-apply').click();
  await expect.poll(() => pointCount(page), { timeout: 30_000 }).toBe(120);

  // Exactly the cells the specification keeps.
  const { kept, expected, isSubset, nOriginal } = await page.evaluate(async () => {
    const { subsampleUniform } = await import('/assets/js/data/subsample.js');
    const identity = window._cellucidState.cellIdentity;
    return {
      kept: Array.from(identity.kept),
      expected: Array.from(subsampleUniform(300, 120, 7)),
      isSubset: identity.isSubset,
      nOriginal: identity.nOriginal,
    };
  });
  expect(isSubset).toBe(true);
  expect(nOriginal).toBe(300);
  expect(kept).toEqual(expected);
  await expect(page.locator('#dataset-cells')).toHaveText('120 of 300');
  await expect(page.locator('#subsample-notice')).toContainText('120 of 300 cells (uniform, seed 7)');

  // The highlight kept its cells that are still open, and no other.
  const carried = await highlightOriginals(page, 'probe');
  expect(carried).toEqual(expected.filter(position => position < 60));

  // Back to every cell.
  await page.locator('#subsample-percent').fill('100');
  await expect(page.locator('#subsample-apply')).toBeEnabled();
  await page.locator('#subsample-apply').click();
  await expect.poll(() => pointCount(page), { timeout: 30_000 }).toBe(300);
  expect(await page.evaluate(() => window._cellucidState.cellIdentity.isSubset)).toBe(false);
  await expect(page.locator('#dataset-cells')).toHaveText('300');
  expect(await highlightOriginals(page, 'probe')).toEqual(expected.filter(position => position < 60));

  expect(errors).toEqual([]);
});

test('a link with a subsample opens exactly those cells and keeps them in the address', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const { readFile } = await import('node:fs/promises');
  const { fulfillFile } = await import('./helpers/anndata-zarr-zip.mjs');
  const { SAMPLE_ORIGIN } = await import('./helpers/origins.mjs');
  const url = `${SAMPLE_ORIGIN}/subsample/data-mapping-full.h5ad`;
  const bytes = await readFile(FILE);
  await page.route(url, route => fulfillFile(route, bytes));
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(url)}&cells=40%25&sample=uniform&seed=7`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => pointCount(page), { timeout: 30_000 }).toBe(120);
  const { kept, expected, digest } = await page.evaluate(async () => {
    const { subsampleUniform } = await import('/assets/js/data/subsample.js');
    const identity = window._cellucidState.cellIdentity;
    return { kept: Array.from(identity.kept), expected: Array.from(subsampleUniform(300, 120, 7)), digest: identity.digest };
  });
  expect(kept).toEqual(expected);
  const address = new URL(page.url());
  expect(address.searchParams.get('cells')).toBe('120');
  expect(address.searchParams.get('sample')).toBe('uniform');
  expect(address.searchParams.get('seed')).toBe('7');
  await openCollapsedPanels(page);
  await expect(page.locator('#subsample-notice')).toContainText(`Cell set ${digest}.`);
  await expect(page.locator('#subsample-copy-link')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a malformed subsample in a link is said by name, and the dataset opens whole', async ({ page }) => {
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&cells=ten`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('"cells" must be a share (10%) or a count of cells').first()).toBeVisible();
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  expect(await page.evaluate(() => window._cellucidState.cellIdentity.isSubset)).toBe(false);
});

test('one cell is not offered: a link asking for it is refused with the reason, and the control says why', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&cells=1`, { waitUntil: 'domcontentloaded' });
  // One cell has no coordinate variation to draw (`FEWEST_OPEN_CELLS`).
  await expect(page.getByText('"cells" must be at least 2: one cell has no coordinate variation to draw; got "1".').first()).toBeVisible();
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  expect(await page.evaluate(() => window._cellucidState.cellIdentity.isSubset)).toBe(false);
  await openCollapsedPanels(page);
  // 0.5 % of 120 cells is one cell: said, and not applied.
  await page.locator('#subsample-percent').fill('0.5');
  await expect(page.locator('#subsample-count')).toHaveText('1 of 120 cells: one cell has no coordinate variation to draw, so at least 2 cells open.');
  await expect(page.locator('#subsample-apply')).toBeDisabled();
  // Two cells are.
  await page.locator('#subsample-percent').fill('1.5');
  await expect(page.locator('#subsample-count')).toHaveText('2 of 120 cells');
  await expect(page.locator('#subsample-apply')).toBeEnabled();
  expect(errors.filter(error => !error.includes('"cells" must be at least 2'))).toEqual([]);
});

test('every count of the open cells says how many of every cell they are, the picker\'s too', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&cells=60&sample=uniform&seed=0`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => pointCount(page), { timeout: 30_000 }).toBe(60);
  await dismissWelcome(page);
  const option = page.locator('#dataset-select option', { hasText: 'Current UI fixture' });
  await expect(option).toHaveText('Current UI fixture (60 of 120 cells)');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 60 of 120 cells');
  // Every cell again: the counts are the dataset's.
  await openCollapsedPanels(page);
  await page.locator('#subsample-percent').fill('100');
  await page.locator('#subsample-apply').click();
  await expect.poll(() => pointCount(page), { timeout: 30_000 }).toBe(120);
  await expect(option).toHaveText('Current UI fixture (120 cells)');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  expect(errors).toEqual([]);
});
