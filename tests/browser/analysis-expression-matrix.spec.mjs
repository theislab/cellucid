/**
 * An analysis's "Expression matrix" and a result gene that colours the cells.
 *
 * The fixture has X (four genes), layers['counts'] (X times ten) and raw with
 * its own genes (X's four and EXTRA). Marker genes run on raw test raw's five
 * genes; Differential expression on the counts layer reports the layer's
 * means; Dot plot on raw finds EXTRA and names a gene raw lacks as not found.
 * Nothing shown changes: the gene list keeps X's genes. The same file opened
 * from disk lists the same matrices and reads the same values.
 *
 * Clicking a gene of a marker or DE result colours the cells by it through the
 * sidebar's gene selector, whose search box then names it; a gene only raw has
 * is said in a notification and colours nothing.
 *
 * Differential expression with Replicates set to the sample field is a
 * pseudobulk test: Welch's t across the per-sample means.
 */
import { expect, test } from './helpers/test.mjs';
import { anndataZarrZip, fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { chooseFiles } from './helpers/file-input.mjs';

const DATASET = 'analysis-expression-matrix';
const ROOT = appUrl('/tests/browser/fixtures/generated-analysis-expression-matrix/');
const CELLS = 240;
const GENES = ['CD3E', 'MS4A1', 'LYZ', 'NKG7'];
const RAW_GENES = ['CD3E', 'MS4A1', 'LYZ', 'NKG7', 'EXTRA'];
const GROUPS = ['T', 'B', 'Mono'];

const SAMPLES = ['s1', 's2', 's3', 's4'];
const groupOf = cell => cell % 3;
const sampleOf = cell => Math.floor(cell / (CELLS / SAMPLES.length));
const xValue = (cell, gene) => (gene === groupOf(cell) ? 1 + (cell % 5) / 4 : (cell % 7 === 0 ? 0.5 : 0));
const rawValue = (cell, gene) => (gene === 4 ? (groupOf(cell) === 2 ? 3 + (cell % 4) : 0) : 2 * xValue(cell, gene) + 1);

function fixture() {
  const X = new Float32Array(CELLS * GENES.length);
  const counts = new Float32Array(CELLS * GENES.length);
  const rawX = new Float32Array(CELLS * RAW_GENES.length);
  for (let cell = 0; cell < CELLS; cell++) {
    for (let gene = 0; gene < GENES.length; gene++) {
      X[cell * GENES.length + gene] = xValue(cell, gene);
      counts[cell * GENES.length + gene] = 10 * xValue(cell, gene);
    }
    for (let gene = 0; gene < RAW_GENES.length; gene++) rawX[cell * RAW_GENES.length + gene] = rawValue(cell, gene);
  }
  return anndataZarrZip({
    cells: CELLS,
    genes: [...GENES],
    X,
    layers: { counts },
    raw: { genes: [...RAW_GENES], X: rawX },
    obs: {
      cluster: { categories: [...GROUPS], codes: Int8Array.from({ length: CELLS }, (_, cell) => groupOf(cell)) },
      sample: { categories: SAMPLES, codes: Int8Array.from({ length: CELLS }, (_, cell) => sampleOf(cell)) },
    },
    obsm: {
      X_umap: {
        data: Float32Array.from({ length: CELLS * 2 }, (_, index) => Math.sin(index * 0.37) * 4),
        columns: 2,
      },
    },
    uns: { cellucid: { schema: 1, id: DATASET, name: 'Expression matrix fixture' } },
  });
}

async function serve(page, bytes) {
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

async function openFromLink(page, bytes) {
  await serve(page, bytes);
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await page.waitForFunction(count => window._comparisonModule?.state?.pointCount === count, CELLS);
}

async function openPanel(page, modeId) {
  await page.evaluate(() => { document.getElementById('page-analysis-section').open = true; });
  const header = page.locator(`#analysis-header-${modeId}`);
  await header.scrollIntoViewIfNeeded();
  await header.click();
  const panel = page.locator(`#analysis-panel-${modeId}`);
  await expect(panel).toBeVisible();
  return panel;
}

/** Set an analysis's options as its form would, then press Run. */
async function run(page, panel, modeId, options, runLabel) {
  await page.evaluate(({ modeId, options }) => {
    const ui = window._comparisonModule.getUI(modeId);
    ui._setOptions({ ...ui._options, ...options });
  }, { modeId, options });
  const button = panel.getByRole('button', { name: runLabel });
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => page.evaluate(modeId => window._comparisonModule.getUI(modeId)._lastResult != null, modeId)).toBe(true);
}

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const cellsOf = group => Array.from({ length: CELLS }, (_, cell) => cell).filter(cell => groupOf(cell) === group);

test('marker genes, DE and dot plot read the matrix chosen for them; nothing shown changes', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openFromLink(page, fixture());

  const matrices = await page.evaluate(() => window._comparisonModule.dataLayer.getExpressionMatrices());
  expect(matrices).toEqual({
    choices: [
      { value: 'mapped', label: 'Mapped (X)' },
      { value: 'layer:counts', label: "layers['counts']" },
      { value: 'raw', label: 'raw.X · 5 genes' },
    ],
    reason: null,
  });

  // Marker genes on raw: raw's own five genes, EXTRA among them.
  const markers = await openPanel(page, 'genesPanel');
  await markers.locator('.analysis-more-options > .disclosure-header').click();
  await markers.locator('.analysis-options-group > .disclosure-header-row > .disclosure-header', { hasText: 'Test' }).click();
  const select = markers.getByLabel('Expression matrix', { exact: true });
  await expect(select.locator('option')).toHaveText(['Mapped (X)', "layers['counts']", 'raw.X · 5 genes']);
  await select.selectOption('raw');
  await run(page, markers, 'genesPanel', { groupBy: 'cluster' }, 'Run marker genes');
  const markerRun = await page.evaluate(() => {
    const { stats, metadata } = window._comparisonModule.getUI('genesPanel')._lastResult;
    return { genes: stats.genes, matrix: metadata.matrix, label: metadata.matrixLabel };
  });
  expect(markerRun).toEqual({ genes: RAW_GENES, matrix: 'raw', label: 'raw' });
  await expect(markers.locator('.analysis-result-line')).toContainText('raw');

  // DE on the counts layer: its means are the layer's (ten times X's).
  const de = await openPanel(page, 'differential');
  await run(page, de, 'differential', {
    compare: 'categories',
    field: 'cluster',
    categoriesA: { mode: 'subset', ids: ['T'] },
    categoriesB: { mode: 'subset', ids: ['B'] },
    matrix: 'layer:counts',
  }, 'Run differential expression');
  const deRun = await page.evaluate(() => {
    const { full } = window._comparisonModule.getUI('differential')._lastResult;
    const row = full.results.find(entry => entry.gene === 'CD3E');
    return { matrix: full.summary.matrix, label: full.summary.matrixLabel, meanA: row.meanA, meanB: row.meanB, genes: full.results.length };
  });
  expect(deRun.matrix).toBe('layer:counts');
  expect(deRun.label).toBe("layers['counts']");
  expect(deRun.genes).toBe(GENES.length);
  expect(deRun.meanA).toBeCloseTo(mean(cellsOf(0).map(cell => 10 * xValue(cell, 0))), 4);
  expect(deRun.meanB).toBeCloseTo(mean(cellsOf(1).map(cell => 10 * xValue(cell, 0))), 4);

  // Dot plot on raw: EXTRA is found there; a gene raw lacks is named.
  await page.evaluate(() => window._comparisonModule.openAnalysis('dotplot', {
    options: { groupBy: 'cluster', matrix: 'raw', geneSets: [{ name: 'Set 1', genes: ['EXTRA', 'CD3E', 'NOPE'] }] }
  }));
  const dot = page.locator('#analysis-panel-dotplot');
  await dot.getByRole('button', { name: 'Run dot plot' }).click();
  await expect.poll(() => page.evaluate(() => window._comparisonModule.getUI('dotplot')._lastResult?.summary?.genes ?? null))
    .toEqual(['EXTRA', 'CD3E']);
  const dotRun = await page.evaluate(() => {
    const { summary } = window._comparisonModule.getUI('dotplot')._lastResult;
    return { unmatched: summary.unmatched, matrix: summary.matrix, groups: summary.groups, sum: [...summary.sum] };
  });
  expect(dotRun.unmatched).toEqual(['NOPE']);
  expect(dotRun.matrix).toBe('raw');
  const monoIndex = dotRun.groups.indexOf('Mono');
  expect(dotRun.sum[monoIndex]).toBeCloseTo(cellsOf(2).reduce((sum, cell) => sum + rawValue(cell, 4), 0), 3);

  // What is shown is untouched: the gene list is still X's.
  const shown = await page.evaluate(() => ({
    genes: window._comparisonModule.dataLayer.getAvailableVariables('gene_expression').map(gene => gene.key),
    expression: window._comparisonModule.state.getDataMapping().expression,
  }));
  expect(shown).toEqual({ genes: GENES, expression: 'X' });
  expect(errors).toEqual([]);
});

test('a result gene colours the cells, and the sidebar gene search names it', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openFromLink(page, fixture());
  const markers = await openPanel(page, 'genesPanel');
  await run(page, markers, 'genesPanel', { groupBy: 'cluster' }, 'Run marker genes');
  await markers.locator('.analysis-result-controls').getByText('List', { exact: true }).click();
  const gene = markers.locator('.marker-ranked-genes .analysis-gene-link').first();
  await expect(gene).toBeVisible();
  const name = await gene.textContent();
  await gene.click();
  await expect(page.locator('#gene-expression-search')).toHaveValue(name);
  await expect.poll(() => page.evaluate(() => {
    const state = window._comparisonModule.state;
    return state.activeFieldSource === 'var' ? state.varData.fields[state.activeVarFieldIndex].key : null;
  })).toBe(name);

  // A gene only raw has colours nothing and says so.
  await page.evaluate(() => window._comparisonModule.colorByGene('EXTRA'));
  await expect(page.locator('#gene-expression-search')).toHaveValue(name);
  expect(errors).toEqual([]);
});

test('a file opened from disk lists the same matrices and reads the same raw values', async ({ page }) => {
  const errors = observeProductErrors(page);
  const bytes = fixture();
  await openFromLink(page, bytes);
  await chooseFiles(page.locator('#user-data-file-input'), { name: 'local-matrices.zarr.zip', mimeType: 'application/zip', buffer: bytes });
  await expect.poll(() => page.evaluate(() => window._comparisonModule?.state?.getDataMapping?.()?.expression ?? null)).toBe('X');
  await expect.poll(() => page.evaluate(() => window._comparisonModule.dataLayer.getExpressionMatrices().choices.map(choice => choice.value)))
    .toEqual(['mapped', 'layer:counts', 'raw']);
  const extra = await page.evaluate(async () => {
    const layer = window._comparisonModule.dataLayer;
    const keys = await layer.getGeneKeys('raw');
    const { values } = await layer.readGeneColumn('EXTRA', { matrix: 'raw' });
    return { keys, length: values.length, indices: [...values.indices], values: [...values.values] };
  });
  const expected = Array.from({ length: CELLS }, (_, cell) => cell).filter(cell => rawValue(cell, 4) !== 0);
  expect(extra.keys).toEqual(RAW_GENES);
  expect(extra.length).toBe(CELLS);
  expect(extra.indices).toEqual(expected);
  expect(extra.values).toEqual(expected.map(cell => rawValue(cell, 4)));
  expect(errors).toEqual([]);
});

test('differential expression with a sample field tests the samples, not the cells', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openFromLink(page, fixture());
  const de = await openPanel(page, 'differential');
  await run(page, de, 'differential', {
    compare: 'categories',
    field: 'cluster',
    categoriesA: { mode: 'subset', ids: ['T'] },
    categoriesB: { mode: 'subset', ids: ['B'] },
    replicates: 'sample',
  }, 'Run differential expression');
  const result = await page.evaluate(() => {
    const { full } = window._comparisonModule.getUI('differential')._lastResult;
    const row = full.results.find(entry => entry.gene === 'CD3E');
    return { method: full.summary.method, replicates: full.summary.replicates, row: { meanA: row.meanA, meanB: row.meanB, nA: row.nA, nB: row.nB, score: row.score, pValue: row.pValue } };
  });
  expect(result.method).toBe('pseudobulk');
  expect(result.replicates).toEqual({ field: 'sample', samplesA: 4, samplesB: 4, cellsLeftOut: 0 });
  const unitMeans = group => SAMPLES.map((_, sample) => mean(cellsOf(group).filter(cell => sampleOf(cell) === sample).map(cell => xValue(cell, 0))));
  const a = unitMeans(0);
  const b = unitMeans(1);
  expect(result.row.nA).toBe(4);
  expect(result.row.nB).toBe(4);
  expect(result.row.meanA).toBeCloseTo(mean(a), 5);
  expect(result.row.meanB).toBeCloseTo(mean(b), 5);
  const variance = values => values.reduce((sum, value) => sum + (value - mean(values)) ** 2, 0) / (values.length - 1);
  const t = (mean(a) - mean(b)) / Math.sqrt(variance(a) / a.length + variance(b) / b.length);
  expect(result.row.score).toBeCloseTo(t, 4);
  await expect(de.locator('.analysis-result-line')).toContainText('Pseudobulk t-test');
  expect(errors).toEqual([]);
});
