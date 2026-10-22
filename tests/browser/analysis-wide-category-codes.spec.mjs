/**
 * Analysis of a categorical field with more categories than uint16 codes
 * carry (70,000, stored as uint32 codes) counts every cell under its own
 * label: the highlight pages built from its categories, the Detailed category
 * counts, Quick Insights, and marker discovery, which hands the codes to the
 * analysis workers.
 *
 * The prepared fixture's three categories are moved to codes on both sides of
 * 65,535: a copy of the codes into 16 bits sent beta (65,536) to code 0 and
 * alpha (69,999) to 4,463, which name other categories here. Five alpha cells
 * are made missing, so the missing code of the wide width is exercised too.
 */
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { chooseDirectory } from './helpers/directory-upload.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const fixtureDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'exports',
  'current-ui-prepared',
);

const CATEGORY_COUNT = 70_000;
const UINT32_MISSING = 4_294_967_295;
// Old uint8 code -> its code in the wide field.
const MOVED = new Map([[0, 69_999], [1, 65_536], [2, 2]]);
const MISSING_ALPHA_CELLS = 5;

async function writeWideExport(directory) {
  await cp(fixtureDirectory, directory, { recursive: true });
  const identityPath = path.join(directory, 'dataset_identity.json');
  const manifestPath = path.join(directory, 'obs_manifest.json');
  const identity = JSON.parse(await readFile(identityPath, 'utf8'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  identity.export_settings.obs_categorical_dtype = 'uint32';
  identity.name = 'wide categories';
  const expected = {};
  for (const field of manifest._categoricalFields) {
    const [index, key, labels, dtype] = field;
    expect(dtype).toBe('uint8');
    const oldPath = path.join(directory, 'obs', `${index}.codes.u8`);
    const oldCodes = await readFile(oldPath);
    const wide = Array.from({ length: CATEGORY_COUNT }, (_, code) => `zz-${String(code).padStart(6, '0')}`);
    for (const [oldCode, newCode] of MOVED) wide[newCode] = labels[oldCode];
    const codes = new Uint32Array(oldCodes.length);
    const counts = {};
    let missingLeft = MISSING_ALPHA_CELLS;
    for (let cell = 0; cell < oldCodes.length; cell++) {
      const oldCode = oldCodes[cell];
      if (oldCode === 0 && missingLeft > 0) {
        missingLeft--;
        codes[cell] = UINT32_MISSING;
        continue;
      }
      codes[cell] = MOVED.get(oldCode);
      counts[labels[oldCode]] = (counts[labels[oldCode]] ?? 0) + 1;
    }
    await rm(oldPath);
    await writeFile(path.join(directory, 'obs', `${index}.codes.u32`), Buffer.from(codes.buffer));
    field[2] = wide;
    field[3] = 'uint32';
    field[4] = UINT32_MISSING;
    // Centroids name categories by label, which have not changed.
    identity.obs_fields.find(entry => entry.key === key).n_categories = CATEGORY_COUNT;
    expected[key] = counts;
  }
  await writeFile(identityPath, JSON.stringify(identity, null, 2));
  await writeFile(manifestPath, JSON.stringify(manifest));
  return expected;
}

test('every analysis that reads a uint32 categorical field counts each cell under its own label', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const directory = testInfo.outputPath('current-ui-prepared');
  const expected = (await writeWideExport(directory)).cell_type;
  // The fixture's cell_type has 40 cells per category; five alpha cells are missing.
  expect(expected).toEqual({ alpha: 35, beta: 40, gamma: 40 });

  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });

  await page.goto(
    `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=browser-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');
  await chooseDirectory(page.locator('#user-data-file-input'), directory);
  await expect(page.locator('#dataset-name')).toHaveText('wide categories');
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
    const controller = new GenesPanelController({ dataLayer });
    let markers;
    try {
      const result = await controller.runAnalysis({
        obsCategory: 'cell_type',
        method: 'wilcox',
        useCache: false,
        topNPerGroup: 'all',
        pValueThreshold: 1,
        foldChangeThreshold: 0,
      });
      markers = Object.fromEntries(
        Object.values(result.markers.groups).map(group => [
          group.groupName,
          { id: group.groupId, cells: group.cellCount, genesTested: group.genesTested },
        ]),
      );
    } finally {
      await controller.close();
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
    alpha: { alpha: 35, beta: 0, gamma: 0 },
    beta: { alpha: 0, beta: 40, gamma: 0 },
    gamma: { alpha: 0, beta: 0, gamma: 40 },
  });
  expect(measured.quick).toEqual({ total: 115, counts: expected });
  // Every gene of the fixture (six) is tested for every group in the workers.
  expect(measured.markers).toEqual({
    alpha: { id: 'category-code:69999', cells: 35, genesTested: 6 },
    beta: { id: 'category-code:65536', cells: 40, genesTested: 6 },
    gamma: { id: 'category-code:2', cells: 40, genesTested: 6 },
  });
  expect(browserErrors).toEqual([]);
});
