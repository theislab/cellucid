/**
 * Session › Data mapping › Expression values: one transform of the mapped
 * matrix (normalize to 10,000 counts per cell, log1p) that the coloring, the
 * legend, a gene's filter, the agents' reads and the analyses follow
 * (`data/expression-transform.js`, `state/managers/expression-values.js`).
 *
 * The fixture's X holds whole counts (a matrix of counts). Without an obs
 * total the cells' totals are every gene summed; with `obs['total_counts']`
 * named by `uns['cellucid']['totalCounts']` they are that column (here three
 * times the genes' sum, as a panel's totals over the whole transcriptome are
 * larger), and no gene is read for them.
 */
import { expect, test } from './helpers/test.mjs';
import { anndataZarrZip, fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { waitForDatasetReady } from './helpers/dataset-ready.mjs';

const ROOT = appUrl('/tests/browser/fixtures/generated-expression-values/');
const CELLS = 120;
const GENES = ['CD3E', 'MS4A1', 'LYZ', 'NKG7'];
const GROUPS = ['T', 'B', 'Mono'];
const groupOf = cell => cell % 3;
const count = (cell, gene) => (gene === groupOf(cell) ? 5 + (cell % 9) * 3 : (cell % 4 === 0 ? 1 : 0)) + (gene === 3 ? cell % 2 : 0);
const sums = Array.from({ length: CELLS }, (_, cell) => GENES.reduce((sum, _, gene) => sum + count(cell, gene), 0));

function fixture(id, { storedTotals }) {
  const X = new Float32Array(CELLS * GENES.length);
  for (let cell = 0; cell < CELLS; cell++) for (let gene = 0; gene < GENES.length; gene++) X[cell * GENES.length + gene] = count(cell, gene);
  return anndataZarrZip({
    cells: CELLS,
    genes: [...GENES],
    X,
    obs: {
      cluster: { categories: [...GROUPS], codes: Int8Array.from({ length: CELLS }, (_, cell) => groupOf(cell)) },
      ...(storedTotals ? { total_counts: Float32Array.from(sums, sum => sum * 3) } : {}),
    },
    obsm: { X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, index) => Math.cos(index * 0.31) * 3), columns: 2 } },
    uns: {
      cellucid: {
        schema: 1, id, name: 'Expression values fixture',
        ...(storedTotals ? { totalCounts: { field: 'total_counts', over: 'all genes' } } : {}),
      },
    },
  });
}

async function open(page, id, bytes) {
  const file = `${id}.zarr.zip`;
  const catalog = JSON.stringify({ schema: 2, default: id, datasets: [{ id, path: file }] });
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
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${id}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await waitForDatasetReady(page, CELLS);
}

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

function observeProductErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/** The shown values of a gene, from the state (what coloring and filters read). */
function shownGene(page, gene) {
  return page.evaluate(gene => {
    const state = window._comparisonModule.dataLayer.state;
    const field = state.varData.fields.find(entry => entry.key === gene);
    return field?.loaded ? Array.from(field.values) : null;
  }, gene);
}

const normalizedLog = (cell, gene, total) => Math.log1p(count(cell, gene) * 10_000 / total);

for (const storedTotals of [false, true]) {
  test(`one switch shows and analyses the genes normalized and log1p (${storedTotals ? 'stored totals' : 'every gene summed'})`, async ({ page }) => {
    const errors = observeProductErrors(page);
    const id = storedTotals ? 'expression-values-stored' : 'expression-values-summed';
    await open(page, id, fixture(id, { storedTotals }));
    const totalOf = cell => (storedTotals ? sums[cell] * 3 : sums[cell]);

    // The section: after Genes, collapsed, its header the values shown.
    await page.evaluate(() => { document.getElementById('session-data-mapping')?.closest('details')?.setAttribute('open', ''); });
    const section = page.locator('[data-mapping-section="expression-values"]');
    await expect(section).toHaveCount(1);
    await expect(section.locator('.disclosure-desc')).toHaveText('Raw values');
    await expect(section.locator('.disclosure-content')).toBeHidden();

    // Colored by a gene with a color range of counts, then normalized + log1p.
    expect((await dispatch(page, 'color.by', { field: { source: 'var', key: 'LYZ' } })).error).toBeUndefined();
    await expect.poll(() => shownGene(page, 'LYZ')).not.toBeNull();
    const raw = await shownGene(page, 'LYZ');
    raw.forEach((value, cell) => expect(value).toBe(count(cell, 2)));
    const summary = await dispatch(page, 'dataset.summary');
    expect(summary.outcome.genes.values).toMatchObject({
      normalize: false, log1p: false, shown: 'Raw values', offered: true, reason: null,
      totals: storedTotals
        ? { stored: true, field: 'total_counts', over: 'all genes', genes_summed: 0 }
        : { stored: false, field: null, over: null, genes_summed: GENES.length },
    });
    expect((await dispatch(page, 'expression.transform.set', {})).error).toMatch(/^Name `normalize`, `log1p` or both/);
    const set = await dispatch(page, 'expression.transform.set', { normalize: true, log1p: true });
    expect(set.error).toBeUndefined();
    expect(set.outcome.shown).toBe('normalized · log1p');

    // Every view of the gene follows: its values, the legend's units, the header.
    await expect.poll(() => shownGene(page, 'LYZ')).not.toBeNull();
    const shown = await shownGene(page, 'LYZ');
    shown.forEach((value, cell) => expect(Math.abs(value - normalizedLog(cell, 2, totalOf(cell)))).toBeLessThan(1e-5));
    await expect(section.locator('.disclosure-desc')).toHaveText('Normalized · log1p');
    await expect(page.locator('.legend-values-note')).toHaveText('Values: log1p(norm.) (Data mapping › Expression values)');

    // One step: undo puts the values as stored back (the gene read again), redo the transform.
    expect((await dispatch(page, 'history.undo')).error).toBeUndefined();
    await expect.poll(async () => (await dispatch(page, 'dataset.summary')).outcome.genes.values.shown).toBe('Raw values');
    await expect.poll(() => shownGene(page, 'LYZ')).toEqual(raw);
    await expect(page.locator('.legend-values-note')).toBeHidden();
    expect((await dispatch(page, 'history.redo')).error).toBeUndefined();
    await expect.poll(async () => (await dispatch(page, 'dataset.summary')).outcome.genes.values.shown).toBe('Normalized · log1p');
    await expect.poll(async () => Math.abs((await shownGene(page, 'LYZ'))[1] - normalizedLog(1, 2, totalOf(1)))).toBeLessThan(1e-5);

    // An agent's reads name the values; a summary per cluster is of them.
    const perCluster = await dispatch(page, 'field.summary', { field: { source: 'var', key: 'LYZ' }, by: { source: 'obs', key: 'cluster' } });
    expect(perCluster.outcome.values).toBe(storedTotals
      ? "ln(1 + x · 10,000 / cell total), cell totals from obs['total_counts'] (over all genes)"
      : 'ln(1 + x · 10,000 / cell total), cell totals from the sum of its 4 genes of X');
    const monoCells = Array.from({ length: CELLS }, (_, cell) => cell).filter(cell => groupOf(cell) === 2);
    const monoMean = monoCells.reduce((sum, cell) => sum + normalizedLog(cell, 2, totalOf(cell)), 0) / monoCells.length;
    expect(Math.abs(perCluster.outcome.groups.find(group => group.label === 'Mono').mean - monoMean)).toBeLessThan(1e-5);
    const values = await dispatch(page, 'cells.values', { cells: [0, 2], fields: [{ source: 'var', key: 'LYZ' }, { source: 'obs', key: 'cluster' }] });
    expect(values.outcome.gene_values).toBe(perCluster.outcome.values);

    // Marker genes of the cluster test the same values: the mean in Mono is theirs.
    const markers = await dispatch(page, 'analysis.markers.set', { options: { groupBy: 'cluster' } });
    expect(markers.error).toBeUndefined();
    expect((await dispatch(page, 'analysis.run', { analysis: 'markers' })).error).toBeUndefined();
    const result = await dispatch(page, 'analysis.result', { analysis: 'markers' });
    expect(result.outcome.about.values).toBe(perCluster.outcome.values);

    expect(errors).toEqual([]);
  });
}

test('the switches in the section make the change at once, naming where the totals come from', async ({ page }) => {
  const id = 'expression-values-switches';
  await open(page, id, fixture(id, { storedTotals: true }));
  const section = page.locator('[data-mapping-section="expression-values"]');
  await page.evaluate(() => {
    for (const details of document.querySelectorAll('details')) if (details.querySelector('[data-mapping-section="expression-values"]')) details.open = true;
  });
  await section.locator('.disclosure-header').evaluate(header => header.click());
  const normalize = section.locator('[data-expression-switch="normalize"]');
  await expect(normalize).toHaveAttribute('aria-checked', 'false');
  await expect(section.locator('.expression-values-source')).toHaveText("Cell totals from obs['total_counts'] (all genes)");
  await normalize.evaluate(button => button.click());
  await expect(section.locator('.disclosure-desc')).toHaveText('Normalized');
  await expect(normalize).toHaveAttribute('aria-checked', 'true');
  const step = await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    return getActions().catalog.get('expression.transform.set').title;
  });
  expect(step).toBe('Set the expression values');
});
