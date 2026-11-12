/**
 * What an agent reads to reason about a dataset as a scientist would
 * (lane-scientist L5-1 … L5-6), on a small fixture of counts with cell
 * types, donors and a condition:
 *
 * - a list of gene names is checked in one read (`genes.search` `names`);
 * - a field per category leaves out the categories with no cells and takes
 *   the categories wanted (`field.summary` `empty`, `categories`);
 * - an analysis result says how it was tested (`analysis.result` `about`):
 *   Differential expression its groups and cells, test (pseudobulk with
 *   replicates), matrix ("counts, not normalized"), significant genes;
 *   Marker genes each group's cells; Gene signature the tests between pages;
 * - the composition result has numbers without a condition (each type's
 *   cells, pooled and per-donor proportions) and its test with one;
 * - a cell scope names a highlight page by its name (`page:<name>`).
 */
import { expect, test } from './helpers/test.mjs';
import { anndataZarrZip, fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { waitForDatasetReady, waitForPageAtRest } from './helpers/dataset-ready.mjs';

const DATASET = 'research-reads';
const ROOT = appUrl('/tests/browser/fixtures/generated-research-reads/');
const CELLS = 96;
const GENES = Object.freeze(['CD3E', 'CD3D', 'MS4A1', 'LYZ', 'NKG7', 'Gnly']);
const TYPES = Object.freeze(['T cell', 'B cell', 'Monocyte']);
const DONORS = Object.freeze(['d1', 'd2', 'd3', 'd4']);
const CONDITIONS = Object.freeze(['healthy', 'disease']);
const typeOf = cell => cell % 3;
const donorOf = cell => Math.floor(cell / 24);
// Donors d1, d2 healthy; d3, d4 disease.
const conditionOf = cell => (donorOf(cell) < 2 ? 0 : 1);
// Whole numbers: the matrix holds counts. A gene is high in its type, plus a donor offset.
const expressionOf = (cell, gene) => (typeOf(cell) === gene % 3 ? 5 + donorOf(cell) : 0) + ((cell + gene) % 2);

async function serveDataset(page) {
  const bytes = anndataZarrZip({
    cells: CELLS,
    genes: [...GENES],
    X: Float32Array.from({ length: CELLS * GENES.length }, (_, index) => expressionOf(Math.floor(index / GENES.length), index % GENES.length)),
    obs: {
      cell_type: { categories: [...TYPES], codes: Int8Array.from({ length: CELLS }, (_, cell) => typeOf(cell)) },
      donor: { categories: [...DONORS], codes: Int8Array.from({ length: CELLS }, (_, cell) => donorOf(cell)) },
      condition: { categories: [...CONDITIONS], codes: Int8Array.from({ length: CELLS }, (_, cell) => conditionOf(cell)) },
    },
    obsm: {
      X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, index) => (index % 2 === 0 ? (index / 2) % 12 : Math.floor(index / 24))), columns: 2 },
    },
    uns: { cellucid: { schema: 1, id: DATASET, name: 'Research reads fixture' } },
  });
  const file = `${DATASET}.zarr.zip`;
  const catalog = JSON.stringify({ schema: 2, default: DATASET, datasets: [{ id: DATASET, path: file }] });
  const prefix = new URL(ROOT).pathname;
  await page.route(`${ROOT}**`, async route => {
    const relative = new URL(route.request().url()).pathname.slice(prefix.length);
    if (relative === 'datasets.json') {
      await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: catalog });
    } else if (relative === file) {
      await fulfillFile(route, bytes).catch(() => {});
    } else {
      await route.fulfill({ status: 404, body: `Unexpected fixture request: ${relative}\n` });
    }
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

async function openFixture(page) {
  await serveDataset(page);
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await waitForDatasetReady(page, CELLS);
  await waitForPageAtRest(page);
  await page.waitForFunction(() => window._comparisonModule?.getAnalysisWindowManager?.() != null);
}

/** Dispatch an action in the page; a refusal comes back as `{error}`. */
function dispatch(page, type, params = {}) {
  return page.evaluate(async ([type, params]) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    try {
      const { outcome } = await getActions().dispatch(type, params);
      return { outcome };
    } catch (error) {
      return { error: error.message };
    }
  }, [type, params]);
}

async function act(page, type, params = {}) {
  const result = await dispatch(page, type, params);
  expect(result.error, `${type} ${JSON.stringify(params)}`).toBeUndefined();
  return result.outcome;
}

const cellsWhere = predicate => Array.from({ length: CELLS }, (_, cell) => cell).filter(predicate);

test('a list of genes is checked in one read; a field per category leaves out empty categories and takes those wanted', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openFixture(page);
  expect(await act(page, 'genes.search', { names: ['cd3e', 'GNLY', 'SFTPC', 'LYZ', 'CD3E', 'SFTPC'] }))
    .toEqual({ genes: ['CD3E', 'Gnly', 'LYZ'], matches: 3, total: GENES.length, lacks: ['SFTPC'] });
  expect((await dispatch(page, 'genes.search', {})).error).toBe('Give either a query to search for, or names to look up.');
  expect((await act(page, 'genes.search', { query: 'CD3' })).genes).toEqual(['CD3E', 'CD3D']);

  await act(page, 'filter.category.visibility', { field: { source: 'obs', key: 'cell_type' }, categories: ['B cell', 'Monocyte'], visible: false });
  const visible = await act(page, 'field.summary', { field: { source: 'var', key: 'CD3E' }, by: { source: 'obs', key: 'cell_type' }, visible_only: true });
  expect(visible.groups.map(group => [group.label, group.cells])).toEqual([['T cell', 32]]);
  expect(visible.empty).toBe(2);
  const byDonor = await act(page, 'field.summary', {
    field: { source: 'var', key: 'CD3E' }, by: { source: 'obs', key: 'donor' }, categories: ['d4', 'd1'],
  });
  // In the field's order, every cell (not only the visible ones).
  expect(byDonor.groups.map(group => [group.label, group.cells])).toEqual([['d1', 24], ['d4', 24]]);
  expect(byDonor.empty).toBe(0);
  const d1 = cellsWhere(cell => donorOf(cell) === 0).map(cell => expressionOf(cell, 0));
  expect(byDonor.groups[0].mean).toBeCloseTo(d1.reduce((sum, value) => sum + value, 0) / d1.length, 6);
  expect((await dispatch(page, 'field.summary', {
    field: { source: 'var', key: 'CD3E' }, by: { source: 'obs', key: 'donor' }, categories: ['d9'],
  })).error).toMatch(/^There is no category "d9" in "donor"/);
  expect(errors).toEqual([]);
});

test('an analysis result says how it was tested: groups and cells, test, matrix, replicates, tests between pages', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openFixture(page);

  // Differential expression, cells as observations.
  await act(page, 'analysis.differential.set', {
    options: { compare: 'categories', field: 'cell_type', categoriesA: { mode: 'subset', ids: ['T cell'] }, categoriesB: { mode: 'subset', ids: ['B cell'] } },
    show: true,
  });
  await act(page, 'analysis.run', { analysis: 'differential' });
  let de = await act(page, 'analysis.result', { analysis: 'differential', top: 3 });
  expect(de.about).toMatchObject({
    group_a: 'T cell', cells_a: 32, group_b: 'B cell', cells_b: 32,
    multiple_testing: 'Benjamini–Hochberg', genes_tested: GENES.length,
  });
  expect(de.about.test).toMatch(/^Wilcoxon, cells as observations/);
  // The matrix, and the values it was read in (Data mapping › Expression values: as stored by default).
  expect(de.about.expression_matrix).toMatch(/counts/);
  expect(de.about.values).toBe('raw counts as stored, not normalized');
  expect(de.about.significant_up_in_a + de.about.significant_up_in_b).toBeGreaterThan(0);
  expect(de.about.rows).toBe('the top 3 genes by score up in A, then the top 3 up in B: top counts each direction');
  // T cells' genes (gene % 3 === 0: CD3E, LYZ) are up in A, B cells' (CD3D, NKG7) in B.
  expect(de.rows.filter(row => row[0] === 'A').map(row => row[1]).sort()).toEqual(['CD3E', 'LYZ']);
  expect(de.rows.filter(row => row[0] === 'B').map(row => row[1]).sort()).toEqual(['CD3D', 'NKG7']);

  // With donors as replicates: pseudobulk, samples per side.
  await act(page, 'analysis.differential.set', { options: { replicates: 'donor', minCellsPerSample: 2 } });
  await act(page, 'analysis.run', { analysis: 'differential' });
  de = await act(page, 'analysis.result', { analysis: 'differential', top: 3 });
  expect(de.about).toMatchObject({ samples_a: 4, samples_b: 4, samples_left_out: '0 of A, 0 of B (fewer than 2 cells)' });
  expect(de.about.test).toMatch(/^pseudobulk: limma moderated t between the samples of donor/);
  expect(de.about.model).toMatch(/^limma lmFit ~ group over 8 samples of donor, then eBayes/);

  // Marker genes: each tested group's cells (DE is shown; setting markers' options shows it).
  await act(page, 'analysis.markers.set', { options: { groupBy: 'cell_type' }, show: true });
  await act(page, 'analysis.run', { analysis: 'markers' });
  const markers = await act(page, 'analysis.result', { analysis: 'markers', top: 2 });
  expect(markers.about.cells_per_group).toEqual(TYPES.map(name => ({ name, cells: 32 })));
  expect(markers.about).toMatchObject({ group_by: 'cell_type', groups_tested: '3 of 3', genes_tested: GENES.length });
  expect(markers.about.rows).toBe("each group's top 2 shown markers, best first (its filters and Rank by): top counts each group");

  // Gene signature on two pages: the tests between them.
  await act(page, 'highlight.category', { field: { source: 'obs', key: 'cell_type' }, categories: ['T cell'], page: 'T' });
  await act(page, 'highlight.category', { field: { source: 'obs', key: 'cell_type' }, categories: ['B cell'], page: 'B' });
  await act(page, 'analysis.signature.set', { options: { geneSets: [{ name: 'T program', genes: ['CD3E', 'LYZ', 'SFTPC'] }], method: 'mean' }, show: true });
  await act(page, 'analysis.pages.set', { analysis: 'signature', pages: ['T', 'B'] });
  await act(page, 'analysis.run', { analysis: 'signature' });
  const signature = await act(page, 'analysis.result', { analysis: 'signature' });
  expect(signature.about.method).toBe('mean');
  const [set] = signature.about.sets;
  expect(set).toMatchObject({ name: 'T program', genes: 2, not_found: ['SFTPC'] });
  expect(set.tests.map(entry => entry.test)).toEqual([expect.stringMatching(/t-test/i), expect.stringMatching(/Mann/i)]);
  for (const entry of set.tests) expect(entry.p_value).toBeLessThan(0.001);

  // A cell scope names a page by its name, and reads it back so.
  await act(page, 'analysis.markers.set', { options: { cells: 'page:T' } });
  expect((await act(page, 'analysis.markers.get')).options.cells).toBe('page:T');
  expect((await dispatch(page, 'analysis.markers.set', { options: { cells: 'page:Nope' } })).error).toMatch(/^There is no page "Nope"/);
  expect(errors).toEqual([]);
});

test('the composition result has numbers without a condition, and its test with one', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openFixture(page);
  await act(page, 'analysis.composition.set', { options: { cellTypes: 'cell_type', samples: 'donor', condition: '' }, show: true });
  await act(page, 'analysis.run', { analysis: 'composition' });
  let composition = await act(page, 'analysis.result', { analysis: 'composition' });
  expect(composition.columns).toEqual(['cell_type', 'cells', 'proportion', ...DONORS.map(donor => `proportion_${donor}`)]);
  expect(composition.rows).toHaveLength(3);
  for (const row of composition.rows) {
    expect(row[1]).toBe(32);
    expect(row[2]).toBeCloseTo(1 / 3, 6);
    // Each donor holds 24 cells, 8 of each type.
    for (const share of row.slice(3)) expect(share).toBeCloseTo(1 / 3, 6);
  }
  expect(composition.about).toMatchObject({ cell_types: 'cell_type', samples: 'donor', condition: null, cells: CELLS, test: null });
  expect(composition.about.cells_per_unit).toEqual(DONORS.map(name => ({ name, cells: 24 })));

  await act(page, 'analysis.composition.set', { options: { condition: 'condition' } });
  await act(page, 'analysis.run', { analysis: 'composition' });
  composition = await act(page, 'analysis.result', { analysis: 'composition' });
  expect(composition.columns.slice(0, 9)).toEqual([
    'cell_type', 'cells', 'proportion', 'mean_proportion_healthy', 'mean_proportion_disease', 'log2_ratio', 'test', 'p_value', 'p_adjusted',
  ]);
  expect(composition.about.samples_per_condition).toEqual([{ name: 'healthy', samples: 2 }, { name: 'disease', samples: 2 }]);
  expect(composition.about.multiple_testing).toBe('Benjamini–Hochberg');
  expect(typeof composition.about.test).toBe('string');
  expect(errors).toEqual([]);
});
