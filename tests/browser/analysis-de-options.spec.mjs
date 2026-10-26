/**
 * Differential expression, end to end: categories of a field as the two
 * groups, Swap, overlapping groups refused with the reason on the Run row, a
 * group under the minimum run and flagged low n, Within a scope, and a free
 * p threshold re-drawn without testing again.
 */
import { expect, test } from './helpers/test.mjs';
import { anndataZarrZip, fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET = 'analysis-de';
const ROOT = appUrl('/tests/browser/fixtures/generated-analysis-de/');
const GROUPS = ['A', 'B', 'C', 'D', 'tiny', 'small'];
const SIZES = [120, 100, 80, 60, 4, 9];
const CELLS = SIZES.reduce((sum, size) => sum + size, 0);
const GENES = Array.from({ length: 12 }, (_, gene) => `G${gene}`);

/** Gene g marks group floor(g / 2); every other value is low with zeros. */
function fixture() {
  const codes = new Int8Array(CELLS);
  let cell = 0;
  SIZES.forEach((size, group) => { for (let i = 0; i < size; i++) codes[cell++] = group; });
  const X = new Float32Array(CELLS * GENES.length);
  for (let c = 0; c < CELLS; c++) {
    for (let g = 0; g < GENES.length; g++) {
      const marker = Math.floor(g / 2) === codes[c];
      X[c * GENES.length + g] = marker
        ? (c % 5 === 0 ? 0 : 2 + (c % 7) / 4)
        : (c % 3 === 0 ? 0.25 * ((c + g) % 4) : 0);
    }
  }
  return anndataZarrZip({
    cells: CELLS,
    genes: [...GENES],
    X,
    obs: { cluster: { categories: [...GROUPS], codes } },
    obsm: {
      X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, i) => Math.sin(i * 0.37) * 4), columns: 2 },
    },
    uns: { cellucid: { schema: 1, id: DATASET, name: 'Differential expression fixture' } },
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

async function openDE(page) {
  await serve(page);
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await page.waitForFunction(count => window._comparisonModule?.state?.pointCount === count, CELLS);
  await page.evaluate(() => { document.getElementById('page-analysis-section').open = true; });
  const header = page.locator('#analysis-header-differential');
  await header.scrollIntoViewIfNeeded();
  await header.click();
  const panel = page.locator('#analysis-panel-differential');
  await expect(panel).toBeVisible();
  return panel;
}

function setOptions(page, patch) {
  return page.evaluate(next => {
    const ui = window._comparisonModule.getUI('differential');
    ui._setOptions({ ...ui._options, ...next });
  }, patch);
}

function summary(page) {
  return page.evaluate(() => {
    const result = window._comparisonModule.getUI('differential')._lastResult;
    if (result === null) return null;
    const row = gene => result.full.results.find(entry => entry.gene === gene);
    return {
      ...result.full.summary,
      g0: row('G0').log2FoldChange,
      g0p: row('G0').adjustedPValue,
      threshold: result.options.pValueThreshold,
      results: result.full.results,
    };
  });
}

async function run(panel) {
  const button = panel.getByRole('button', { name: 'Run differential expression' });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toHaveText('Run');
  await expect(panel.locator('.js-plotly-plot')).toBeVisible();
}

const categories = (a, b) => ({
  compare: 'categories',
  field: 'cluster',
  categoriesA: { mode: 'subset', ids: a },
  categoriesB: { mode: 'subset', ids: b },
});

test('categories as groups, swap, and a free p threshold drawn without testing again', async ({ page }) => {
  const errors = observeProductErrors(page);
  const panel = await openDE(page);
  await setOptions(page, categories(['A'], ['B', 'C']));
  await run(panel);
  let result = await summary(page);
  expect(result.groupASize).toBe(120);
  expect(result.groupBSize).toBe(180);
  expect(result.g0).toBeGreaterThan(1);
  expect(result.g0p).toBeLessThan(1e-6);

  await panel.getByRole('button', { name: 'Swap A and B' }).click();
  await expect(panel.locator('.analysis-stale-chip')).toBeVisible();
  await run(panel);
  result = await summary(page);
  expect(result.groupASize).toBe(180);
  expect(result.g0).toBeLessThan(-1);

  // Any threshold in [0, 1]: the volcano is re-drawn from the same tests.
  await page.evaluate(() => { window.__deResults = window._comparisonModule.getUI('differential')._lastResult.full; });
  await setOptions(page, { maxAdjP: 0.37 });
  await expect.poll(async () => (await summary(page)).threshold).toBe(0.37);
  expect(await page.evaluate(() => window._comparisonModule.getUI('differential')._lastResult.full === window.__deResults)).toBe(true);
  await expect(panel.locator('.analysis-stale-chip')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('overlapping groups are refused with the reason; a small group runs flagged low n', async ({ page }) => {
  const errors = observeProductErrors(page);
  const panel = await openDE(page);
  await setOptions(page, categories(['A', 'B'], ['B']));
  await expect(panel.getByRole('button', { name: 'Run differential expression' })).toBeDisabled();
  await expect(panel.locator('.analysis-run-reason')).toHaveText('A category is in both groups: B');

  await setOptions(page, categories(['tiny'], ['A']));
  await run(panel);
  const result = await summary(page);
  expect(result.groupASize).toBe(4);
  expect(result.lowN).toEqual(['tiny']);
  await expect(panel.locator('.analysis-chip', { hasText: 'low n' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Within keeps only the cells of the chosen categories', async ({ page }) => {
  const errors = observeProductErrors(page);
  const panel = await openDE(page);
  await setOptions(page, {
    ...categories(['A'], ['B', 'C']),
    within: 'category',
    withinField: 'cluster',
    withinCategories: { mode: 'subset', ids: ['A', 'B'] },
  });
  await run(panel);
  const result = await summary(page);
  expect(result.groupASize).toBe(120);
  expect(result.groupBSize).toBe(100);
  expect(errors).toEqual([]);
});
