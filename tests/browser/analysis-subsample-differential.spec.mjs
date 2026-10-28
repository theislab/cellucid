/**
 * Analyses in the app on every way cells can be open, against the
 * independent reference on the kept cells
 * (`tests/fixtures/subsample-analysis/`, `scripts/generate-subsample-analysis-fixtures.py`;
 * `tests/analysis-subsample-differential.test.mjs` holds the same openings
 * through the kernels alone). Here the whole app runs: the link's subsample,
 * the reader worker, the data layer, the analysis windows' group resolution
 * and workers:
 *
 * - every cell of a priority-ordered file; a uniform subsample at the file
 *   seed; stratified (balanced) and spatial subsamples; the uniform prefix of
 *   the store cellucid-python serves for the object;
 * - a share raised and lowered in place with Apply: the result shown goes
 *   "Stale · Run", saying the open cells changed with both counts; it is not
 *   exported, not saved in a session, and its run on the cells open now
 *   equals the reference of those cells.
 *
 * Differential expression (Wilcoxon, `exact` convention: sizes, U and means
 * exactly; the fraction non-zero within 2 ulp; p within 1e-12 relative) and
 * composition (counts, exactly) are compared on each; the cells open are
 * the kept ones, by original position. Also, each against the reference of
 * the cells open:
 *
 * - the store cellucid-r serves for the object (run from its sources by the
 *   generator), its uniform prefix;
 * - a session saved on a subsample and loaded onto the whole dataset: the
 *   session's cells are opened again, and the analyses run on them;
 * - a progressive opening caught at its first view (its growth held by work
 *   on the open cells, `data/open-cells-work.js`): the analyses run on the
 *   first view's cells, then go stale when it grows, and a run equals the
 *   reference of every cell asked for;
 * - Quick insights over every open cell and the Detailed view's summary of a
 *   page of the T cells and of the rest;
 * - every kind of filter (categories hidden, a range of an obs column, a
 *   range of a gene, all three at once): the cells left visible, their
 *   count, and the counts shown said against every cell ("Showing 120 of
 *   240 of 1,200 cells", "Counted on the 240 of 1,200 cells open.");
 * - Differential expression's CSV names each gene by its var index id
 *   (`ENSG…`), the symbol shown beside it.
 */
import { readFileSync } from 'node:fs';

import { closeContextWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const FOLDER = new URL('../fixtures/subsample-analysis/', import.meta.url);
const REFERENCE = JSON.parse(readFileSync(new URL('reference.json', FOLDER), 'utf8'));
const OPENING = Object.fromEntries(REFERENCE.openings.map(opening => [opening.name, opening]));

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/** The link's parameters of a reference opening's request. */
function linkOf(request) {
  if (request === null) return '';
  const entries = [['cells', String(request.k)], ['sample', request.method], ['seed', String(request.seed)]];
  if (request.method === 'stratified') entries.push(['by', request.field], ['alloc', request.allocation]);
  if (request.method === 'spatial') entries.push(['embedding', request.embedding], ['grid', String(request.gridSize)]);
  if (request.method === 'blocks') entries.push(['block', String(request.blockSize)]);
  return `&${new URLSearchParams(entries)}`;
}

async function open(page, opening, { count = opening.kept.length, request = opening.request } = {}) {
  const url = `${SAMPLE_ORIGIN}/subsample-analysis/${opening.file}`;
  const bytes = readFileSync(new URL(opening.file, FOLDER));
  await page.route(url, route => fulfillFile(route, bytes));
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(url)}${linkOf(request)}`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window._comparisonModule?.state?.pointCount ?? 0), { timeout: 60_000 }).toBe(count);
  if (count === opening.kept.length) await expectOpenCells(page, opening);
  await page.evaluate(() => { document.getElementById('page-analysis-section').open = true; });
}

/** The open cells are the reference's kept cells. */
async function expectOpenCells(page, opening) {
  const open = await page.evaluate(() => {
    const identity = window._cellucidState.cellIdentity;
    return Array.from(identity.toOriginal(Uint32Array.from({ length: identity.n }, (_, i) => i))).sort((a, b) => a - b);
  });
  expect(open).toEqual(opening.kept);
}

async function openMode(page, mode) {
  const header = page.locator(`#analysis-header-${mode}`);
  await header.scrollIntoViewIfNeeded();
  if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
  const panel = page.locator(`#analysis-panel-${mode}`);
  await expect(panel).toBeVisible();
  return panel;
}

async function runDE(page) {
  const panel = await openMode(page, 'differential');
  await page.evaluate(() => {
    const ui = window._comparisonModule.getUI('differential');
    ui._setOptions({
      ...ui._options,
      compare: 'categories',
      field: 'cell_type',
      categoriesA: { mode: 'subset', ids: ['T'] },
      categoriesB: { mode: 'subset', ids: ['B'] },
      method: 'wilcox',
      pConvention: 'exact',
      minPct: 0,
    });
  });
  const button = panel.getByRole('button', { name: 'Run differential expression' });
  await expect(button).toBeEnabled();
  // This run's result, not one shown before it (a result gone stale is kept).
  await page.evaluate(() => { window.__resultBefore = window._comparisonModule.getUI('differential')._lastResult ?? null; });
  await button.click();
  await expect(button).toHaveText('Run');
  await expect.poll(() => page.evaluate(() => {
    const result = window._comparisonModule.getUI('differential')._lastResult;
    return result !== null && result !== undefined && result !== window.__resultBefore;
  })).toBe(true);
  return page.evaluate(() => window._comparisonModule.getUI('differential')._lastResult.full.results.map(row => ({
    gene: row.gene, nA: row.nA, nB: row.nB, meanA: row.meanA, meanB: row.meanB, pctA: row.pctA, pctB: row.pctB, statistic: row.statistic, pValue: row.pValue,
  })));
}

function relativeClose(actual, expected, tolerance, label) {
  const scale = Math.max(Math.abs(expected), Number.MIN_VALUE);
  expect(Math.abs(actual - expected) / scale, `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
}

function expectDE(rows, opening) {
  const pair = opening.de.find(entry => entry.a === 'T' && entry.b === 'B');
  for (const want of pair.genes) {
    const got = rows.find(row => row.gene === want.gene);
    const label = `${opening.name} ${want.gene}`;
    expect(got, label).toBeTruthy();
    expect([got.nA, got.nB], `${label} sizes`).toEqual([want.nA, want.nB]);
    relativeClose(got.pctA, want.pctA, 2 * 2 ** -52, `${label} % A`);
    relativeClose(got.pctB, want.pctB, 2 * 2 ** -52, `${label} % B`);
    expect([got.meanA, got.meanB], `${label} means`).toEqual([want.meanA, want.meanB]);
    expect(got.statistic, `${label} U`).toBe(want.U);
    if (want.pWilcox === null) expect(got.pValue, `${label} p of a tied gene`).toBe(1);
    else relativeClose(got.pValue, want.pWilcox, 1e-12, `${label} p`);
  }
}

async function runComposition(page) {
  const panel = await openMode(page, 'composition');
  await page.evaluate(() => {
    const ui = window._comparisonModule.getUI('composition');
    ui._setOptions({ ...ui._options, cellTypes: 'cell_type', samples: 'batch', condition: '' });
  });
  const button = panel.getByRole('button', { name: 'Run composition' });
  await expect(button).toBeEnabled();
  // This run's result, not one shown before it (a result gone stale is kept).
  await page.evaluate(() => { window.__resultBefore = window._comparisonModule.getUI('composition')._lastResult ?? null; });
  await button.click();
  await expect.poll(() => page.evaluate(() => {
    const result = window._comparisonModule.getUI('composition')._lastResult;
    return result !== null && result !== undefined && result !== window.__resultBefore;
  })).toBe(true);
  await expect(panel.locator('.analysis-cells-used')).toHaveAttribute('data-cells-used', 'all');
  return page.evaluate(() => {
    const { types, units, counts } = window._comparisonModule.getUI('composition')._lastResult.composition;
    return { types: types.map(type => type.label ?? type), units: units.map(unit => unit.label), counts: Array.from(counts) };
  });
}

function expectComposition(got, opening) {
  // Every cell type by every batch, as the reference counts it.
  got.types.forEach((type, t) => {
    const row = opening.composition[REFERENCE.types.indexOf(type)];
    got.units.forEach((unit, u) => {
      expect(got.counts[t * got.units.length + u], `${opening.name} ${type} in ${unit}`).toBe(row[REFERENCE.batches.indexOf(unit)]);
    });
  });
  // Every category of the field is a row, one with no open cell too (its counts 0).
  expect([...got.types].sort()).toEqual([...REFERENCE.types].sort());
}

for (const name of ['all-priority', 'uniform-file-seed', 'stratified-balanced', 'spatial', 'served-uniform', 'served-r-uniform']) {
  test(`${name}: differential expression and composition equal the reference on the kept cells`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    const opening = OPENING[name];
    await open(page, opening);
    expectDE(await runDE(page), opening);
    expectComposition(await runComposition(page), opening);
    expect(errors).toEqual([]);
  });
}

test('raised and lowered in place: the result goes stale, is not passed on, and a run equals the reference', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  const small = OPENING['uniform-mid-growth'];
  const large = OPENING['uniform-file-seed'];
  await open(page, small);
  expectDE(await runDE(page), small);

  // Raised to 300 cells in place: the same method and seed.
  const apply = async percent => {
    await page.locator('#subsample-percent').fill(String(percent));
    await page.locator('#subsample-method').selectOption('uniform');
    await page.locator('#subsample-seed').fill('0');
    await page.locator('#subsample-apply').click();
  };
  await apply((100 * large.kept.length) / REFERENCE.nObs);
  await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount), { timeout: 60_000 }).toBe(large.kept.length);
  await expectOpenCells(page, large);
  const panel = await openMode(page, 'differential');
  const chip = panel.locator('.analysis-stale-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('title', 'The open cells changed since this result (150 cells then, 300 cells now). Run again.');
  const passedOn = await page.evaluate(() => {
    const ui = window._comparisonModule.getUI('differential');
    const warnings = [];
    const warning = ui._notifications.warning.bind(ui._notifications);
    ui._notifications.warning = (text, options) => { warnings.push(text); return warning(text, options); };
    const refused = ui._refuseStaleExport('CSV');
    return { saved: ui.exportResult(), refused, warnings };
  });
  expect(passedOn).toEqual({
    saved: null,
    refused: true,
    warnings: ['CSV not exported. The open cells changed since this result (150 cells then, 300 cells now). Run it again to export it.'],
  });
  expectDE(await runDE(page), large);
  await expect(chip).toHaveCount(0);

  // Lowered back to 150 in place.
  await apply((100 * small.kept.length) / REFERENCE.nObs);
  await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount), { timeout: 60_000 }).toBe(small.kept.length);
  await expectOpenCells(page, small);
  await expect(chip).toBeVisible();
  expectDE(await runDE(page), small);
  expectComposition(await runComposition(page), small);
  expect(errors).toEqual([]);
});

async function saveSession(page, testInfo, name) {
  const download = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const path = testInfo.outputPath(name);
  await (await download).saveAs(path);
  return path;
}

test('a session saved on a subsample opens its cells again, and analyses on them equal the reference', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  const opening = OPENING['stratified-balanced'];
  await open(page, opening);
  expectDE(await runDE(page), opening);
  const session = await saveSession(page, testInfo, 'stratified.cellucid-session');

  // The same file opened whole, then the session loaded: its cells are
  // opened again (read again in place of the whole dataset).
  await open(page, OPENING['all-given']);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  await (await chooser).setFiles(session);
  await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount), { timeout: 60_000 }).toBe(opening.kept.length);
  await expectOpenCells(page, opening);
  // The result saved with it is the one shown, current on these cells.
  await expect.poll(() => page.evaluate(() => window._comparisonModule.getUI('differential')._lastResult !== null), { timeout: 30_000 }).toBe(true);
  const restored = await page.evaluate(() => window._comparisonModule.getUI('differential')._lastResult.full.results.map(row => ({
    gene: row.gene, nA: row.nA, nB: row.nB, meanA: row.meanA, meanB: row.meanB, pctA: row.pctA, pctB: row.pctB, statistic: row.statistic, pValue: row.pValue,
  })));
  expectDE(restored, opening);
  // Run again on the restored cells: the reference of the kept cells.
  expectDE(await runDE(page), opening);
  expectComposition(await runComposition(page), opening);
  expect(errors).toEqual([]);
});

test('a progressive opening caught at its first view: analyses run on its cells, then on every cell asked for', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  // Showing a cell measured at 100 ms before: a first view within a second
  // would be 10 cells, so it is the fewest a first view holds, the square
  // root of the 300 asked for (18), whatever the link costs
  // (`progressivePlan`); each step then doubles.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('cellucid:opening-cost:v2', JSON.stringify({ w: 1, x: 1, y: 100, xx: 1, xy: 100 }));
    } catch {
      // Storage blocked: the opening is not progressive, and the first view check fails.
    }
    // Growth is held from the start, as work on the open cells holds it
    // (`open-cells-work.js`), until the test lets it go.
    let state;
    Object.defineProperty(window, '_cellucidState', {
      configurable: true,
      get: () => state,
      set: value => {
        state = value;
        window.__counts = [];
        // By its address: WebKit resolves a relative one against this
        // script's, not the page's. The app's own instance of the module.
        window.__growthHeld = import(new URL('assets/js/data/open-cells-work.js', document.baseURI).href).then(work => {
          work.trackCellWork(new Promise(resolve => { window.__releaseGrowth = resolve; }));
          return 'held';
        }, error => `not held: ${error}`);
      },
    });
  });
  const page = await context.newPage();
  const errors = collectErrors(page);
  // Every count the page shows, to say what happened if the first view is missed.
  await page.addInitScript(() => {
    const watch = () => {
      const count = window._cellucidState?.pointCount ?? 0;
      if (count > 0 && window.__counts?.at(-1) !== count) window.__counts?.push(count);
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  const first = OPENING['uniform-first-view'];
  const asked = OPENING['uniform-file-seed'];
  try {
    await open(page, asked, { count: first.kept.length });
  } catch (error) {
    const seen = await page.evaluate(async () => ({ held: await window.__growthHeld, counts: window.__counts, cost: localStorage.getItem('cellucid:opening-cost:v2') }));
    throw new Error(`The first view was not caught: ${JSON.stringify(seen)}`, { cause: error });
  }
  expect(await page.evaluate(() => window.__growthHeld)).toBe('held');
  // Caught growing: the first view's cells, the growth still to come.
  expect(await page.evaluate(() => window._cellucidState.cellIdentity.n)).toBe(first.kept.length);
  await expectOpenCells(page, first);
  await expect(page.locator('#filter-count')).toHaveText(`Showing all ${first.kept.length} of 1,200 cells`);
  expectDE(await runDE(page), first);
  expectComposition(await runComposition(page), first);

  // Let it grow: every cell asked for opens, the results go stale, and a run equals their reference.
  await page.evaluate(() => window.__releaseGrowth());
  await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount), { timeout: 60_000 }).toBe(asked.kept.length);
  await expectOpenCells(page, asked);
  const panel = await openMode(page, 'differential');
  await expect(panel.locator('.analysis-stale-chip')).toBeVisible();
  expectDE(await runDE(page), asked);
  expectComposition(await runComposition(page), asked);
  expect(errors).toEqual([]);
  await closeContextWithApplicationRetirement(context);
});

/** Original positions, ascending, of the open cells `state` shows (alpha 1). */
async function visibleCells(page) {
  return page.evaluate(() => {
    const state = window._cellucidState;
    const shown = [];
    for (let cell = 0; cell < state.pointCount; cell++) if (state.categoryTransparency[cell] > 0) shown.push(cell);
    return Array.from(state.cellIdentity.toOriginal(Uint32Array.from(shown))).sort((a, b) => a - b);
  });
}

async function chooseGene(page, name) {
  const search = page.locator('#gene-expression-search');
  await search.click();
  await search.fill(name);
  await search.press('Enter');
  await expect.poll(() => page.evaluate(gene => {
    const state = window._cellucidState;
    return state.activeFieldSource === 'var' && state.varData.fields[state.activeVarFieldIndex]?.key === gene;
  }, name), { timeout: 60_000 }).toBe(true);
}

/** Show `key` (an obs field) and, for a range, keep `[low, high]` within its open values. */
async function filterObs(page, key, { hidden = null, range = null } = {}) {
  await page.evaluate(async ({ key, hidden, range }) => {
    const state = window._cellucidState;
    const index = state.obsData.fields.findIndex(field => field.key === key);
    await state.ensureFieldLoaded(index);
    state.setActiveField(index);
    const field = state.obsData.fields[index];
    if (hidden !== null) {
      field.categories.forEach((category, code) => state.setVisibilityForCategory(field, code, !hidden.includes(category)));
    }
    if (range !== null) {
      const stats = field._continuousStats;
      state.applyContinuousFilter(index, Math.max(range[0], stats.min), Math.min(range[1], stats.max));
    }
  }, { key, hidden, range });
}

async function expectFiltered(page, opening, kept, label) {
  expect(await visibleCells(page), `${opening.name}: ${label}: the cells kept`).toEqual(kept);
  expect(await page.evaluate(() => ({ ...window._cellucidState.getFilteredCount() })), `${opening.name}: ${label}: counts`)
    .toEqual({ shown: kept.length, total: opening.kept.length });
  const of = `${opening.kept.length.toLocaleString('en-US')} of 1,200 cells`;
  await expect(page.locator('#filter-count')).toHaveText(kept.length === opening.kept.length
    ? `Showing all ${of}`
    : `Showing ${kept.length.toLocaleString('en-US')} of ${of}`);
}

for (const name of ['stratified-proportional', 'blocks', 'served-r-uniform']) {
  test(`${name}: every kind of filter keeps exactly the reference's cells, and the counts say the open cells of every cell`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    const opening = OPENING[name];
    const spec = REFERENCE.filterSpec;
    const hidden = REFERENCE.types.filter(type => !spec.shownTypes.includes(type));
    await open(page, opening);
    await openCollapsedPanels(page);

    // Categories hidden; the legend says what its counts are of.
    await filterObs(page, 'cell_type', { hidden });
    await expectFiltered(page, opening, opening.filters.category, 'categories hidden');
    await expect(page.locator('#legend .legend-cells-note')).toHaveText(`Counted on the ${opening.kept.length.toLocaleString('en-US')} of 1,200 cells open.`);
    await filterObs(page, 'cell_type', { hidden: [] });

    // A range of an obs column; a missing value is never in it.
    await filterObs(page, 'score', { range: spec.score });
    await expectFiltered(page, opening, opening.filters.continuous, 'score range');
    await page.evaluate(() => {
      const state = window._cellucidState;
      state.resetContinuousFilter(state.obsData.fields.findIndex(field => field.key === 'score'));
    });

    // A range of a gene, shown by its symbol.
    await chooseGene(page, spec.gene);
    await page.evaluate(atLeast => {
      const state = window._cellucidState;
      const stats = state.varData.fields[state.activeVarFieldIndex]._continuousStats;
      state.applyContinuousFilter(null, Math.max(atLeast, stats.min), stats.max);
    }, spec.geneAtLeast);
    await expectFiltered(page, opening, opening.filters.gene, 'gene range');

    // All three at once: the score's range and the categories hidden act
    // whichever field is shown; the gene's while it is shown.
    await filterObs(page, 'score', { range: spec.score });
    await filterObs(page, 'cell_type', { hidden });
    await chooseGene(page, spec.gene);
    await expectFiltered(page, opening, opening.filters.combined, 'every filter at once');
    expect(errors).toEqual([]);
  });
}

/**
 * Two highlight pages: the open T cells, and the rest of the open cells
 * (every other category highlighted), each a category clicked.
 */
async function pagesOfT(page) {
  return page.evaluate(async () => {
    const state = window._cellucidState;
    const index = state.obsData.fields.findIndex(field => field.key === 'cell_type');
    await state.ensureFieldLoaded(index);
    const categories = state.obsData.fields[index].categories;
    state.ensureHighlightPage();
    const t = state.getActivePageId();
    state.addHighlightFromCategory(index, categories.indexOf('T'), 'obs');
    const rest = state.createHighlightPage('Rest').id;
    state.switchToPage(rest);
    const codes = state.obsData.fields[index].codes;
    const present = new Set();
    for (let cell = 0; cell < state.pointCount; cell++) present.add(codes[cell]);
    categories.forEach((category, code) => {
      if (category !== 'T' && present.has(code)) state.addHighlightFromCategory(index, code, 'obs');
    });
    return { t, rest };
  });
}

function relative(actual, expected, tolerance, label) {
  if (expected === undefined) {
    expect(actual, label).toBeNull();
    return;
  }
  relativeClose(actual, expected, tolerance, label);
}

for (const name of ['spatial', 'blocks', 'served-r-uniform']) {
  test(`${name}: Quick insights and the Detailed view's numbers equal the reference on the kept cells`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    const opening = OPENING[name];
    await open(page, opening);
    const pages = await pagesOfT(page);

    // Quick insights over the T cells and the rest: every open cell.
    await openMode(page, 'simple');
    const quick = await page.evaluate(async ids => {
      const ui = window._comparisonModule.getUI('simple');
      const insights = await ui._computeInsights([ids.t, ids.rest], null, null);
      return {
        totalCells: insights.totalCells,
        categorical: insights.categoricalSummaries.map(entry => ({ field: entry.field, top: entry.topCategories.map(({ name, count }) => ({ name, count })) })),
        continuous: insights.continuousSummaries.map(entry => ({ ...entry })),
      };
    }, pages);
    expect(quick.totalCells).toBe(opening.kept.length);
    expect(quick.categorical).toEqual([
      { field: 'cell_type', top: opening.quick.cell_type },
      { field: 'batch', top: opening.quick.batch },
    ]);
    expect(quick.continuous.map(entry => entry.field)).toEqual(['score']);
    const score = quick.continuous[0];
    const want = opening.quick.score;
    expect([score.count, score.missingCount]).toEqual([want.count, want.missing]);
    // Order statistics exactly (they are values of the column); the mean
    // and deviation (a running mean against NumPy's pairwise sums) within
    // 1e-12 relative.
    expect([score.median, score.min, score.max, score.q1, score.q3]).toEqual([want.median, want.min, want.max, want.q1, want.q3]);
    relative(score.mean, want.mean, 1e-12, `${name} quick mean`);
    relative(score.std, want.std, 1e-12, `${name} quick std`);

    // The Detailed view: a page of the T cells and the rest, for each variable.
    await openMode(page, 'detailed');
    const variables = [
      ...REFERENCE.detailedSpec.continuous.map(variable => ({ type: variable === 'score' ? 'continuous_obs' : 'gene_expression', variable })),
      { type: 'categorical_obs', variable: REFERENCE.detailedSpec.categorical },
    ];
    for (const { type, variable } of variables) {
      await page.evaluate(({ ids, type, variable }) => {
        const ui = window._comparisonModule.getUI('detailed');
        ui._handlePageChange([ids.t, ids.rest]);
        ui._handleVariableChange(type, variable);
      }, { ids: pages, type, variable });
      await expect.poll(() => page.evaluate(key => {
        const ui = window._comparisonModule.getUI('detailed');
        return ui._committedView?.config?.dataSource?.variable === key ? ui._currentPageData?.length ?? 0 : 0;
      }, variable), { timeout: 60_000 }).toBe(2);
      const shown = await page.evaluate(async type => {
        const ui = window._comparisonModule.getUI('detailed');
        const { computeStats } = await import('./assets/js/app/analysis/shared/number-utils.js');
        // The counts the summary table shows (`stats-display.js`), by category name.
        const { categoryCounts } = await import('./assets/js/app/analysis/shared/category-counts.js');
        const identity = window._cellucidState.cellIdentity;
        return ui._currentPageData.map(pageData => ({
          cells: Array.from(identity.toOriginal(Uint32Array.from(pageData.cellIndices))).sort((a, b) => a - b).length,
          stats: type === 'categorical_obs' ? null : computeStats(pageData.values),
          counts: type === 'categorical_obs' ? Object.fromEntries(categoryCounts(pageData.values)) : null,
        }));
      }, type);
      expect(shown.length).toBe(2);
      ['T', 'rest'].forEach((pageName, p) => {
        const want = opening.detailed[pageName];
        const label = `${name} detailed ${variable} ${pageName}`;
        expect(shown[p].cells, `${label} cells`).toBe(want.cells);
        if (type === 'categorical_obs') {
          const counts = Object.fromEntries(Object.entries(want[variable]).filter(([, count]) => count > 0));
          expect(shown[p].counts, label).toEqual(counts);
          return;
        }
        const stats = shown[p].stats;
        expect(stats.count, `${label} count`).toBe(want[variable].count);
        if (want[variable].count === 0) return;
        expect([stats.median, stats.min, stats.max], label).toEqual([want[variable].median, want[variable].min, want[variable].max]);
        relative(stats.mean, want[variable].mean, 1e-12, `${label} mean`);
        relative(stats.std, want[variable].std, 1e-12, `${label} std`);
      });
    }
    expect(errors).toEqual([]);
  });
}

test('Differential expression\'s CSV names each gene by its var index id, the symbol shown beside it', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  const opening = OPENING['served-uniform'];
  await open(page, opening);
  expectDE(await runDE(page), opening);
  const download = page.waitForEvent('download');
  await page.evaluate(() => window._comparisonModule.getUI('differential')._exportModalCSV());
  const file = await (await download).path();
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  expect(lines[0].split(',').slice(0, 3)).toEqual(['names', 'symbols', 'scores']);
  const rows = lines.slice(1).map(line => line.split(','));
  expect(rows.length).toBe(REFERENCE.genes.length);
  for (const row of rows) {
    // Each id is the var index of the gene its symbol names.
    expect(REFERENCE.geneIds.indexOf(row[0]), row.join(',')).toBe(REFERENCE.genes.indexOf(row[1]));
  }
  expect(errors).toEqual([]);
});
