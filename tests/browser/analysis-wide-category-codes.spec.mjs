/**
 * Analysis of a categorical field with more categories than uint16 codes
 * carry (70,000, `fixtures/uint32-categories.h5ad`) counts every cell under
 * its own label: the highlight pages built from its categories, the Detailed
 * category counts, Quick Insights, and marker discovery, which hands the
 * codes to the analysis workers.
 *
 * The fixture's three labels sit on both sides of 65,535: a copy of the codes
 * into 16 bits sends alpha (65,536) to code 0, gamma, and beta (69,999) to
 * 4,463, which name other categories. Five gamma cells are missing, so the
 * missing code of the wide width is exercised too.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'uint32-categories.h5ad',
);

const CATEGORY_COUNT = 70_000;
// The fixture's cell_type has 40 cells per label; five gamma cells are missing.
const EXPECTED = Object.freeze({ alpha: 40, beta: 40, gamma: 35 });

test('every analysis that reads a uint32 categorical field counts each cell under its own label', async ({ page }) => {
  test.setTimeout(240_000);
  const expected = EXPECTED;

  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });

  await page.goto(
    `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=browser-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await page.locator('#user-data-file-input').setInputFiles(fixturePath);
  await expect(page.locator('#dataset-name')).toHaveText('uint32 categories');
  await expect.poll(() => page.evaluate(() => Boolean(window._comparisonModule?.dataLayer))).toBe(true);

  const measured = await page.evaluate(async () => {
    const cm = window._comparisonModule;
    const { state, dataLayer } = cm;
    const fieldIndex = state.obsData.fields.findIndex(field => field.key === 'cell_type');
    const field = state.obsData.fields[fieldIndex];
    await dataLayer.ensureObsFieldLoaded('cell_type');
    const codeOf = label => field.categories.indexOf(label);

    // Highlight pages built from the wide codes.
    const pageFor = label => {
      const created = state.createHighlightPage(label);
      state.switchToPage(created.id);
      state.addHighlightFromCategory(fieldIndex, codeOf(label), 'obs');
      return created.id;
    };
    const pages = { alpha: pageFor('alpha'), beta: pageFor('beta'), gamma: pageFor('gamma') };
    const pageIds = Object.values(pages);
    const pageCells = Object.fromEntries(
      Object.entries(pages).map(([label, id]) => [label, dataLayer.getCellCountForPageId(id)]),
    );

    // Detailed analysis of a categorical variable: counts per page.
    const detailed = await dataLayer.getCategoryCountsByPage('cell_type', pageIds);
    const detailedCounts = Object.fromEntries(
      Object.entries(pages).map(([label, id]) => [label, detailed.pages[id].counts]),
    );

    // Quick Insights over the three pages.
    const { QuickInsights } = await import('/assets/js/app/analysis/ui/analysis-types/quick-insights-ui.js');
    const insights = new QuickInsights({ container: null, dataLayer });
    insights._selectedCategoricalObsKeys = ['cell_type'];
    insights._selectedContinuousObsKeys = [];
    insights._hasUserSelectedCategoricalObsFields = true;
    insights._hasUserSelectedContinuousObsFields = true;
    const quick = await insights._computeInsights(pageIds);
    const summary = quick.categoricalSummaries.find(entry => entry.field === 'cell_type');

    // Marker discovery by the field, through the analysis workers.
    const { GenesPanelController } = await import('/assets/js/app/analysis/genes-panel/genes-panel-controller.js');
    const { MARKER_OPTIONS } = await import('/assets/js/app/analysis/options/marker-options.js');
    const controller = new GenesPanelController({ dataLayer });
    let markers;
    try {
      const { stats } = await controller.runAnalysis({
        options: MARKER_OPTIONS.withDefaults({ groupBy: 'cell_type' }, { categoricalFields: [{ key: 'cell_type' }] }),
      });
      markers = Object.fromEntries(
        stats.groups.map((group, index) => [
          group.groupName,
          { id: group.groupId, cells: group.cellCount, genesTested: stats.genesTestedByGroup[index] },
        ]),
      );
    } finally {
      controller.close();
    }

    return {
      categoryCount: field.categories.length,
      codesWidth: field.codes.constructor.name,
      pageCells,
      detailedCounts,
      quick: {
        total: summary.total,
        counts: Object.fromEntries(summary.topCategories.map(entry => [entry.name, entry.count])),
      },
      markers,
    };
  });

  expect(measured.categoryCount).toBe(CATEGORY_COUNT);
  expect(measured.codesWidth).toBe('Uint32Array');
  expect(measured.pageCells).toEqual(expected);
  // Each page counts every category seen on any compared page.
  expect(measured.detailedCounts).toEqual({
    alpha: { alpha: 40, beta: 0, gamma: 0 },
    beta: { alpha: 0, beta: 40, gamma: 0 },
    gamma: { alpha: 0, beta: 0, gamma: 35 },
  });
  expect(measured.quick).toEqual({ total: 115, counts: expected });
  // Every gene of the fixture (six) is tested for every group in the workers.
  expect(measured.markers).toEqual({
    alpha: { id: 'category-code:65536', cells: 40, genesTested: 6 },
    beta: { id: 'category-code:69999', cells: 40, genesTested: 6 },
    gamma: { id: 'category-code:0', cells: 35, genesTested: 6 },
  });
  expect(browserErrors).toEqual([]);
});
