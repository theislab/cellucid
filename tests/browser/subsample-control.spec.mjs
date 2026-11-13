/**
 * Cells to open (Session › Open data): a share of the cells, applied to the
 * open dataset in place.
 *
 * - Below 100% the count, the method's settings and Apply appear; Apply
 *   reads the dataset again with exactly the cells the specification keeps
 *   (`data/subsample.js`), and everything (point count, the Dataset box, the
 *   cell identity) names them.
 * - A highlight made before is carried across by original cell position:
 *   the cells of it still open, and no other.
 * - Back at 100%, every cell is open again.
 * - A figure exported from a subsample says it is one: its provenance (the
 *   SVG's `cellucid:json` and `dc:description`) names the open cells, the
 *   dataset's, how they were chosen and the cell-set digest the Session panel
 *   shows. A figure of every cell makes no such claim.
 *
 * Fixture: `data-mapping-full.h5ad` (300 cells).
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels, openSessionSectionsOnLoad } from './helpers/panels.mjs';
import { chooseFiles } from './helpers/file-input.mjs';

// Cells to open, Genes read for and the data mapping are in the Session
// panel's sections, collapsed by default: open, as a viewer who opened them.
test.beforeEach(async ({ page }) => {
  await openSessionSectionsOnLoad(page);
});

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

/** The original positions of the cells of the highlight group labeled `label`, ascending. */
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

function decodeXmlText(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

async function exportSvg(page, testInfo, label) {
  await page.getByLabel('Download format').selectOption('svg');
  await page.getByLabel('SVG point strategy').selectOption('full-vector');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#figure-export-btn').click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  const outputPath = testInfo.outputPath(`${label}.svg`);
  await download.saveAs(outputPath);
  const svg = await readFile(outputPath, 'utf8');
  const json = JSON.parse(decodeXmlText(svg.match(/<cellucid:json>([\s\S]+?)<\/cellucid:json>/)[1]));
  const description = decodeXmlText(svg.match(/<dc:description>([\s\S]*?)<\/dc:description>/)[1]);
  return { json, description };
}

test('a share of the cells is read in place, a highlight keeps its cells that stay open, and a figure names the cells it shows', async ({ page }, testInfo) => {
  const errors = collectBrowserErrors(page);
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await openCollapsedPanels(page);
  await chooseFiles(page.locator('#user-data-file-input'), FILE);
  await expect.poll(() => pointCount(page)).toBe(300);

  // At 100%: every cell, nothing to apply, no settings.
  await expect(page.locator('#subsample-count')).toHaveText('All 300 cells');
  await expect(page.locator('#subsample-settings')).toBeHidden();
  await expect(page.locator('#subsample-apply')).toBeDisabled();

  // A figure of every cell makes no claim about its cells.
  await page.locator('#figure-export-section > summary').click();
  await expect(page.locator('#figure-export-section')).toHaveAttribute('open', '');
  await page.getByRole('button', { name: /^Download\b/ }).click();
  await test.step('a figure of every cell does not name its cells', async () => {
    const whole = await exportSvg(page, testInfo, 'every-cell');
    expect(whole.json.dataset.cells).toBeNull();
    expect(whole.description).not.toContain('Cells:');
  });

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
  await expect(page.locator('#subsample-method option').first()).toHaveText('File default (blocks)');
  await page.locator('#subsample-method').selectOption('uniform');
  await page.locator('#subsample-seed').fill('7');
  await page.locator('#subsample-apply').click();
  await expect.poll(() => pointCount(page)).toBe(120);

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
  // One short line; the facts behind it under Details.
  await expect(page.locator('#subsample-notice')).toHaveText('Uniform, seed 7.');
  await expect(page.locator('#subsample-details-body')).toBeHidden();
  await page.locator('#subsample-details .disclosure-header').click();
  await expect(page.locator('#subsample-details-list dt:text-is("Open") + dd')).toHaveText('120 of 300 cells');
  await expect(page.locator('#subsample-details-list dt:text-is("Chosen by") + dd')).toHaveText('uniform');
  await expect(page.locator('#subsample-details-list dt:text-is("Seed") + dd')).toHaveText('7');
  // What a gene costs on this file, worked out once Details opened.
  await expect(page.locator('#subsample-details-list dt').filter({ hasText: /^(A gene reads|First gene)$/ })).toHaveCount(1);

  // A figure of the subsample says it is one: the open cells, the dataset's,
  // how they were chosen and the cell-set digest the Session panel shows.
  await test.step('a figure of a subsample names its cells', async () => {
    const digest = await page.evaluate(() => window._cellucidState.cellIdentity.digest);
    const share = await exportSvg(page, testInfo, 'subsample');
    expect(share.json.dataset.cells).toEqual({ open: 120, of: 300, method: 'uniform, seed 7', digest });
    expect(share.description).toContain(`Cells: a subsample, 120 of 300 (uniform, seed 7; cell set ${digest})`);
  });

  // The highlight kept its cells that are still open, and no other.
  const carried = await highlightOriginals(page, 'probe');
  expect(carried).toEqual(expected.filter(position => position < 60));

  // Back to every cell.
  await page.locator('#subsample-percent').fill('100');
  await expect(page.locator('#subsample-apply')).toBeEnabled();
  await page.locator('#subsample-apply').click();
  await expect.poll(() => pointCount(page)).toBe(300);
  expect(await page.evaluate(() => window._cellucidState.cellIdentity.isSubset)).toBe(false);
  await expect(page.locator('#dataset-cells')).toHaveText('300');
  // Every cell: no line, no Details.
  await expect(page.locator('#subsample-notice')).toBeHidden();
  await expect(page.locator('#subsample-details')).toBeHidden();
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
  await expect.poll(() => pointCount(page)).toBe(120);
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
  await page.locator('#subsample-details .disclosure-header').click();
  await expect(page.locator('#subsample-details-list dt:text-is("Cell set") + dd')).toHaveText(digest);
  await expect(page.locator('#subsample-copy-link')).toBeVisible();
  expect(errors).toEqual([]);
});

test('one cell is not offered, and every count of the open cells says how many of every cell they are', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&cells=1`, { waitUntil: 'domcontentloaded' });

  await test.step('one cell is not offered: a link asking for it is refused with the reason, and the control says why', async () => {
    // One cell has no coordinate variation to draw (`FEWEST_OPEN_CELLS`).
    await expect(page.getByText('"cells" must be at least 2: one cell has no coordinate variation to draw; got "1".').first()).toBeVisible();
    await dismissWelcome(page);
    await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
    expect(await page.evaluate(() => window._cellucidState.cellIdentity.isSubset)).toBe(false);
    await openCollapsedPanels(page);
    // 0.5% of 120 cells is one cell: said, and not applied.
    await page.locator('#subsample-percent').fill('0.5');
    await expect(page.locator('#subsample-count')).toHaveText('1 of 120 cells: one cell has no coordinate variation to draw, so at least 2 cells open.');
    await expect(page.locator('#subsample-apply')).toBeDisabled();
    // Two cells are.
    await page.locator('#subsample-percent').fill('1.5');
    await expect(page.locator('#subsample-count')).toHaveText('2 of 120 cells');
    await expect(page.locator('#subsample-apply')).toBeEnabled();
  });

  await test.step('every count of the open cells says how many of every cell they are, the picker\'s too', async () => {
    await page.locator('#subsample-percent').fill('50');
    await page.locator('#subsample-method').selectOption('uniform');
    await page.locator('#subsample-seed').fill('0');
    await page.locator('#subsample-apply').click();
    await expect.poll(() => pointCount(page)).toBe(60);
    const option = page.locator('#dataset-select option', { hasText: 'Current UI fixture' });
    // The chosen sample says its name alone at rest (the Dataset card says its
    // cells); reached for, the picker says its open cells.
    await expect(option).toHaveText('Current UI fixture');
    await page.locator('#dataset-select').focus();
    await expect(option).toHaveText('Current UI fixture (60 of 120 cells)');
    await expect(page.locator('#filter-count')).toHaveText('Showing all 60 of 120 cells');
    // Every cell again: the counts are the dataset's.
    await page.locator('#subsample-percent').fill('100');
    await page.locator('#subsample-apply').click();
    await expect.poll(() => pointCount(page)).toBe(120);
    await page.locator('#dataset-select').focus();
    await expect(option).toHaveText('Current UI fixture (120 cells)');
    await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  });
  expect(errors.filter(error => !error.includes('"cells" must be at least 2'))).toEqual([]);
});

test.describe('in a locale that writes a decimal comma', () => {
  test.use({ locale: 'de-DE' });

  test('a share typed with a decimal comma is that share: in the box, the count and the cells opened', async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
    await openCollapsedPanels(page);
    expect(await page.evaluate(() => navigator.language)).toBe('de-DE');
    const box = page.locator('#subsample-percent');
    await box.click();
    await box.press('ControlOrMeta+a');
    await box.press('Backspace');
    // Typed as a German or Turkish user types it: the comma is the decimal point, never a thousands separator.
    await box.pressSequentially('12,5');
    await expect(box).toHaveValue('12,5');
    await expect(page.locator('#subsample-count')).toHaveText('15 of 120 cells');
    await expect(page.locator('#subsample-slider')).toHaveValue('12.5');
    await page.locator('#subsample-apply').click();
    await expect.poll(() => pointCount(page)).toBe(15);
    // The box says the share the open cells are, written as every number in the app is.
    await expect(box).toHaveValue('12.5');
    // "9,969" is a share of about ten per cent, never nine thousand.
    await box.fill('9,969');
    await expect(page.locator('#subsample-count')).toHaveText('12 of 120 cells');
    expect(await page.evaluate(() => window._cellucidState.cellIdentity.kept.length)).toBe(15);
    expect(errors).toEqual([]);
  });
});
