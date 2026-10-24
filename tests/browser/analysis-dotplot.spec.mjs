/**
 * Dot plot, end to end: gene sets in, brackets per set, a "not found" chip
 * for a gene the dataset lacks, case-insensitive matching, scaling and
 * layout applied without reading again, a dendrogram group order, the long
 * CSV, and "Score as signature".
 */
import { expect, test } from './helpers/test.mjs';
import { anndataZarrZip, fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET = 'analysis-dotplot';
const ROOT = appUrl('/tests/browser/fixtures/generated-analysis-dotplot/');
const CELLS = 300;
const GENES = ['CD3E', 'CD8A', 'MS4A1', 'CD79A', 'LYZ', 'NKG7'];
const GROUPS = ['T', 'B', 'Mono'];

function fixture() {
  const group = Int8Array.from({ length: CELLS }, (_, cell) => cell % 3);
  const X = new Float32Array(CELLS * GENES.length);
  for (let cell = 0; cell < CELLS; cell++) {
    for (let gene = 0; gene < GENES.length; gene++) {
      const marker = Math.floor(gene / 2) === group[cell];
      X[cell * GENES.length + gene] = marker
        ? (cell % 4 === 0 ? 0 : 1 + (cell % 5) / 4)
        : (cell % 7 === 0 ? 0.25 : 0);
    }
  }
  return anndataZarrZip({
    cells: CELLS,
    genes: [...GENES],
    X,
    obs: { cluster: { categories: [...GROUPS], codes: group } },
    obsm: {
      X_umap: {
        data: Float32Array.from({ length: CELLS * 2 }, (_, index) => Math.cos(index * 0.41) * 3),
        columns: 2,
      },
    },
    uns: { cellucid: { schema: 1, id: DATASET, name: 'Dot plot fixture' } },
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

async function openDotplot(page) {
  await serve(page);
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await page.waitForFunction(count => window._comparisonModule?.state?.pointCount === count, CELLS);
  await page.evaluate(() => { document.getElementById('page-analysis-section').open = true; });
  const header = page.locator('#analysis-header-dotplot');
  await header.scrollIntoViewIfNeeded();
  await header.click();
  const panel = page.locator('#analysis-panel-dotplot');
  await expect(panel).toBeVisible();
  return panel;
}

function lastResult(page) {
  return page.evaluate(() => {
    const result = window._comparisonModule.getUI('dotplot')._lastResult;
    return result === null ? null : {
      groups: result.data.groups,
      genes: result.data.genes,
      color: [...result.data.color],
      fraction: [...result.data.fraction],
      swap: result.data.swap,
      layout: result.data.layout,
      unmatched: result.summary.unmatched,
    };
  });
}

test('genes in sets, brackets, a not-found chip, display without reading, dendrogram, CSV', async ({ page }) => {
  const errors = observeProductErrors(page);
  const panel = await openDotplot(page);
  const run = panel.getByRole('button', { name: 'Run dot plot' });
  // No genes: Run says why, never an error on click.
  await expect(run).toBeDisabled();
  await expect(panel.locator('.analysis-run-reason')).toHaveText('Add the genes to plot');

  await page.evaluate(() => window._comparisonModule.openAnalysis('dotplot', {
    options: {
      groupBy: 'cluster',
      geneSets: [
        { name: 'T cells', genes: ['CD3E', 'cd8a', 'NOPE1'] },
        { name: 'B cells', genes: ['MS4A1', 'CD79A'] },
        { name: 'Myeloid', genes: ['LYZ'] },
      ],
    },
  }));
  await expect(run).toBeEnabled();
  await run.click();
  await expect(panel.locator('.dotplot-result-container .js-plotly-plot')).toBeVisible();
  const first = await lastResult(page);
  expect(first.genes).toEqual(['CD3E', 'CD8A', 'MS4A1', 'CD79A', 'LYZ']);
  expect(first.groups).toEqual(GROUPS);
  expect(first.unmatched).toEqual(['NOPE1']);
  await expect(panel.locator('.analysis-chip', { hasText: '1 not found' })).toBeVisible();
  // T markers are highest in T: fraction 0.75 (one cell in four is zero).
  expect(first.fraction[0 * 3 + 0]).toBeCloseTo(0.75, 10);
  // Three sets: three brackets of three lines each, labelled.
  const shapes = await panel.locator('.js-plotly-plot').evaluate(element => element.layout.shapes.length);
  expect(shapes).toBe(9);

  // Display options apply to the sums: no read, no run.
  await page.evaluate(() => {
    const ui = window._comparisonModule.getUI('dotplot');
    ui._setOptions({ ...ui._options, scale: 'var', swapAxes: true, groupOrder: 'dendrogram' });
  });
  await expect.poll(async () => (await lastResult(page)).swap).toBe(true);
  const scaled = await lastResult(page);
  expect(Math.max(...scaled.color)).toBeCloseTo(1, 12);
  expect(Math.min(...scaled.color)).toBeCloseTo(0, 12);
  expect([...scaled.groups].sort()).toEqual([...GROUPS].sort());
  await expect(panel.locator('.analysis-stale-chip')).toHaveCount(0);

  // The long CSV.
  await panel.getByRole('button', { name: /Expand/ }).click();
  const modal = page.locator('.analysis-modal.open');
  await expect(modal.locator('.analysis-modal-plot .js-plotly-plot')).toBeVisible();
  const download = page.waitForEvent('download');
  await modal.getByRole('button', { name: /CSV/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('dot_plot.csv');
  const text = await (await file.createReadStream()).toArray().then(chunks => Buffer.concat(chunks).toString('utf8'));
  const lines = text.trim().split('\n');
  expect(lines[0]).toBe('group,gene,gene_group,mean,fraction_expressing,n_cells');
  expect(lines).toHaveLength(1 + 3 * 5);
  expect(lines[1]).toMatch(/^T,CD3E,T cells,[0-9.]+,0\.75,100$/);
  await page.keyboard.press('Escape');

  // Score as signature opens Gene signature with one set per gene set.
  await panel.getByRole('button', { name: 'Score as signature' }).click();
  await expect(page.locator('#analysis-header-signature')).toHaveAttribute('aria-expanded', 'true');
  const sets = await page.evaluate(() => window._comparisonModule.getUI('signature')._options.geneSets);
  expect(sets).toEqual([
    { name: 'T cells', genes: ['CD3E', 'CD8A'] },
    { name: 'B cells', genes: ['MS4A1', 'CD79A'] },
    { name: 'Myeloid', genes: ['LYZ'] },
  ]);
  expect(errors).toEqual([]);
});

test('matrix plot draws the same means as cells', async ({ page }) => {
  const errors = observeProductErrors(page);
  const panel = await openDotplot(page);
  await page.evaluate(() => window._comparisonModule.openAnalysis('dotplot', {
    options: { groupBy: 'cluster', plot: 'matrix', geneSets: [{ name: 'All', genes: ['CD3E', 'MS4A1', 'LYZ'] }] },
  }));
  await panel.getByRole('button', { name: 'Run dot plot' }).click();
  await expect(panel.locator('.dotplot-result-container .js-plotly-plot')).toBeVisible();
  const trace = await panel.locator('.js-plotly-plot').evaluate(element => element.data[0].type);
  expect(trace).toBe('heatmap');

  // The stacked violin is the same run drawn another way: one filled violin
  // per gene and group, and the color bar.
  await page.evaluate(() => {
    const ui = window._comparisonModule.getUI('dotplot');
    ui._setOptions({ ...ui._options, plot: 'violin' });
  });
  await expect.poll(() => panel.locator('.js-plotly-plot').evaluate(element => element.data.length)).toBe(3 * 3 + 1);
  const fills = await panel.locator('.js-plotly-plot').evaluate(element => element.data.slice(0, 9).every(trace => trace.fill === 'toself'));
  expect(fills).toBe(true);
  await expect(panel.locator('.analysis-stale-chip')).toHaveCount(0);
  expect(errors).toEqual([]);
});
