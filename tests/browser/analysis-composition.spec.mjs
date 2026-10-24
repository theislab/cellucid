/**
 * Composition, end to end: the fields it finds by itself, a run without a
 * condition (no test), a run with samples and a condition (a test per cell
 * type, the table and both CSV downloads), a sample split across conditions,
 * and the "cells as replicates" notice without samples.
 */
import { expect, test } from './helpers/test.mjs';
import { anndataZarrZip, fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET = 'analysis-composition';
const ROOT = appUrl('/tests/browser/fixtures/generated-analysis-composition/');
const CELLS = 480;
const TYPES = ['T cell', 'B cell', 'Monocyte', 'NK cell'];
const SAMPLES = ['s1', 's2', 's3', 's4', 's5', 's6'];
const CONDITIONS = ['healthy', 'disease'];

function fixture() {
  // s1..s3 healthy, s4..s6 disease; in disease T cells double. s3 has some
  // cells marked disease: a sample split across the conditions.
  const type = new Int8Array(CELLS);
  const sample = new Int8Array(CELLS);
  const condition = new Int8Array(CELLS);
  for (let cell = 0; cell < CELLS; cell++) {
    sample[cell] = cell % SAMPLES.length;
    condition[cell] = sample[cell] >= 3 ? 1 : 0;
    if (sample[cell] === 2 && cell % 5 === 0) condition[cell] = 1;
    const slot = Math.floor(cell / SAMPLES.length) % 10;
    type[cell] = condition[cell] === 1
      ? [0, 0, 0, 0, 1, 1, 2, 2, 3, 3][slot]
      : [0, 0, 1, 1, 1, 2, 2, 2, 3, 3][slot];
  }
  return anndataZarrZip({
    cells: CELLS,
    genes: ['CD3E', 'MS4A1'],
    X: Float32Array.from({ length: CELLS * 2 }, (_, index) => index % 3),
    obs: {
      cell_type: { categories: [...TYPES], codes: type },
      sample_id: { categories: [...SAMPLES], codes: sample },
      condition: { categories: [...CONDITIONS], codes: condition },
    },
    obsm: {
      X_umap: {
        data: Float32Array.from({ length: CELLS * 2 }, (_, index) => Math.sin(index * 0.37) * 4),
        columns: 2,
      },
    },
    uns: { cellucid: { schema: 1, id: DATASET, name: 'Composition fixture' } },
  });
}

async function serve(page) {
  const bytes = fixture();
  const file = `${DATASET}.zarr.zip`;
  const catalog = JSON.stringify({ schema: 2, default: DATASET, datasets: [{ id: DATASET, path: file }] });
  const prefix = new URL(ROOT).pathname;
  await page.route(`${ROOT}**`, async route => {
    const relative = new URL(route.request().url()).pathname.slice(prefix.length);
    if (relative === 'datasets.json') {
      await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: catalog });
      return;
    }
    if (relative !== file) {
      await route.fulfill({ status: 404, body: `Unexpected fixture request: ${relative}\n` });
      return;
    }
    await fulfillFile(route, bytes);
  });
}

function observeProductErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function openComposition(page) {
  await serve(page);
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await page.waitForFunction(count => window._comparisonModule?.state?.pointCount === count, CELLS);
  await page.evaluate(() => { document.getElementById('page-analysis-section').open = true; });
  const header = page.locator('#analysis-header-composition');
  await header.scrollIntoViewIfNeeded();
  await header.click();
  const panel = page.locator('#analysis-panel-composition');
  await expect(panel).toBeVisible();
  return panel;
}

async function run(panel) {
  const button = panel.getByRole('button', { name: 'Run composition' });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(panel.locator('.composition-result-container .js-plotly-plot')).toBeVisible();
}

test('finds its fields, counts without a condition, then tests across samples', async ({ page }) => {
  const errors = observeProductErrors(page);
  const panel = await openComposition(page);
  await expect(panel.locator('select[name="cellTypes"]')).toHaveValue('cell_type');
  await expect(panel.locator('select[name="samples"]')).toHaveValue('sample_id');
  await expect(panel.locator('select[name="condition"]')).toHaveValue('');
  // Nothing is explained under the button.
  await expect(panel.locator('.analysis-run-row + *')).toHaveCount(0);

  await run(panel);
  const plain = await page.evaluate(() => window._comparisonModule.getUI('composition')._lastResult.composition);
  expect(plain.test).toBeNull();
  expect(plain.totalCells).toBe(480);

  await panel.locator('select[name="condition"]').selectOption('condition');
  await expect(panel.locator('.analysis-stale-chip')).toBeVisible();
  await run(panel);
  await expect(panel.locator('.analysis-stale-chip')).toHaveCount(0);
  const tested = await page.evaluate(() => {
    const { composition } = window._comparisonModule.getUI('composition')._lastResult;
    return {
      test: composition.test.test,
      conditions: composition.conditions,
      units: composition.units.map(unit => unit.label),
      split: composition.splitSamples,
      p: [...composition.test.pValue],
      adjusted: [...composition.test.adjustedP],
      ratio: [...composition.test.log2Ratio],
    };
  });
  expect(tested.test).toBe("Welch's t-test");
  expect(tested.conditions).toEqual(CONDITIONS);
  expect(tested.split).toEqual(['s3']);
  expect(tested.units).toEqual(['s1', 's2', 's3 · healthy', 's3 · disease', 's4', 's5', 's6']);
  expect(tested.ratio[0]).toBeGreaterThan(0.5);
  for (const p of tested.adjusted) expect(p).toBeGreaterThanOrEqual(0);
  await expect(panel.locator('.analysis-chip', { hasText: '1 split sample' })).toBeVisible();

  // The display redraws without a run.
  await panel.locator('.analysis-options-form .disclosure-header', { hasText: 'More options' }).click();
  await panel.locator('.disclosure-header', { hasText: 'Display' }).click();
  await panel.getByRole('button', { name: 'Cell counts' }).click();
  await expect(panel.locator('.analysis-stale-chip')).toHaveCount(0);
  expect(await page.evaluate(() => window._comparisonModule.getUI('composition')._lastResult.data.bars.proportions)).toBe(false);

  // The expanded view: the per-type table, the per-sample view, one CSV per click.
  await panel.getByRole('button', { name: /Expand/ }).click();
  const modal = page.locator('.analysis-modal.open');
  await expect(modal.locator('.composition-table tbody tr')).toHaveCount(4);
  await modal.getByLabel('Plot', { exact: true }).selectOption({ label: 'Per sample' });
  await expect(modal.locator('.analysis-modal-plot .js-plotly-plot .boxlayer')).toHaveCount(1);
  const results = page.waitForEvent('download');
  await modal.getByRole('button', { name: /^CSV/ }).click();
  expect((await results).suggestedFilename()).toBe('composition_results.csv');
  const counts = page.waitForEvent('download');
  await modal.getByRole('button', { name: 'Counts CSV' }).click();
  expect((await counts).suggestedFilename()).toBe('composition_counts.csv');
  expect(errors).toEqual([]);
});

test('without samples the cells are the replicates, and the result says so', async ({ page }) => {
  const errors = observeProductErrors(page);
  const panel = await openComposition(page);
  await panel.locator('select[name="samples"]').selectOption('');
  await panel.locator('select[name="condition"]').selectOption('condition');
  await run(panel);
  await expect(panel.locator('.analysis-chip', { hasText: 'Cells as replicates' })).toBeVisible();
  const test = await page.evaluate(() => window._comparisonModule.getUI('composition')._lastResult.composition.test);
  expect(test.overall.df).toBe(3);
  expect(errors).toEqual([]);
});
