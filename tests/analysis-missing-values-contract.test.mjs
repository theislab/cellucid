import assert from 'node:assert/strict';
import test from 'node:test';
import { adoptCategoryCounts, categoryCounts } from '../assets/js/app/analysis/shared/category-counts.js';

import {
  DataLayer,
  excludeMissingCategoricalValues,
} from '../assets/js/app/analysis/data/data-layer.js';
import { PlotHelpers } from '../assets/js/app/analysis/core/plugin-contract.js';
import { runStatisticalTests } from '../assets/js/app/analysis/stats/statistical-tests.js';

function layerOver(field) {
  const layer = Object.create(DataLayer.prototype);
  layer.state = { obsData: { fields: [field] }, varData: null };
  layer._datasetGeneration = 0;
  layer._notifications = null;
  layer.getVariableInfo = () => ({
    key: field.key,
    kind: field.kind,
    _fieldIndex: 0,
  });
  layer.getPageInfo = (pageId) => ({ id: pageId, name: pageId });
  layer._getVersionedCellIndices = () => Uint32Array.of(0, 1, 2, 3);
  layer._ensureFieldLoaded = async () => {};
  layer._requireCurrentDatasetGeneration = () => {};
  return layer;
}

async function pageValues(field, type) {
  const layer = layerOver(field);
  const [page] = await layer._fetchDataForPages({
    type,
    variableKey: field.key,
    pageIds: ['P1'],
    silent: true,
  });
  return page;
}

test('uint8 categorical codes publish their own missing code as a missing value', async () => {
  // Highlight-page categoricals with at most 255 categories are uint8 and use
  // 255, not 65535, for cells no page covers.
  const page = await pageValues({
    key: 'from pages',
    kind: 'category',
    categories: ['A', 'B'],
    codes: Uint8Array.of(0, 255, 1, 0),
    loaded: true,
  }, 'categorical_obs');
  assert.ok(page.values instanceof Uint8Array);
  assert.deepEqual(Array.from(page.values), [0, 255, 1, 0]);
  assert.equal(page.missingCode, 255);
  assert.deepEqual(page.categories, ['A', 'B']);
  assert.deepEqual([...categoryCounts(page.values)], [['A', 2], [null, 1], ['B', 1]]);
});

test('categorical codes reach whole-field analysis consumers at their own width', async () => {
  // Each width keeps its own array and its own missing code: nothing is
  // copied, so a uint32 field's codes above 65,535 are not truncated.
  for (const [codes, missing] of [
    [Uint8Array.of(0, 255, 1, 0), 255],
    [Uint16Array.of(0, 65_535, 1, 0), 65_535],
    [Uint32Array.of(0, 4_294_967_295, 69_999, 0), 4_294_967_295],
  ]) {
    const categories = Array.from({ length: 70_000 }, (_, code) => `c${code}`);
    const layer = layerOver({ key: 'wide', kind: 'category', categories, codes, loaded: true });
    layer._getObsFieldIndexMap = () => new Map([['wide', 0]]);
    const loaded = await layer.ensureObsFieldLoaded('wide');
    assert.strictEqual(loaded.codes, codes);
    assert.equal(loaded.codes[1], missing);
  }
});

test('continuous NaN is published as missing instead of failing the page', async () => {
  const page = await pageValues({
    key: 'score',
    kind: 'continuous',
    values: Float32Array.of(1, NaN, 3, 4),
    loaded: true,
  }, 'continuous_obs');
  assert.equal(page.values.length, 4);
  assert.ok(Number.isNaN(page.values[1]));
});

/** Uint8 codes over `labels` (255 missing) with their counts adopted, as the data layer publishes them. */
function codedPage(codes, labels = ['T', 'B']) {
  const values = Uint8Array.from(codes);
  const counts = new Map();
  for (const code of values) {
    const label = code === 255 ? null : labels[code];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  adoptCategoryCounts(values, counts);
  return values;
}

test('categorical statistics drop missing cells as the docs describe', () => {
  const pages = excludeMissingCategoricalValues([
    {
      pageId: 'p1',
      pageName: 'P1',
      values: codedPage([...Array(40).fill(0), ...Array(20).fill(1), 255]),
      categories: ['T', 'B'],
      missingCode: 255,
      cellIndices: Uint32Array.from({ length: 61 }, (_, index) => index),
      cellCount: 61,
    },
    {
      pageId: 'p2',
      pageName: 'P2',
      values: codedPage([...Array(20).fill(0), ...Array(40).fill(1)]),
      categories: ['T', 'B'],
      missingCode: 255,
      cellIndices: Uint32Array.from({ length: 60 }, (_, index) => 100 + index),
      cellCount: 60,
    },
  ]);
  assert.ok(pages[0].values instanceof Uint8Array);
  assert.deepEqual([...categoryCounts(pages[0].values)], [['T', 40], ['B', 20]]);
  assert.equal(pages[0].values.length, 60);
  assert.equal(pages[0].cellCount, 60);
  assert.equal(pages[0].cellIndices.length, 60);
  assert.equal(pages[0].cellIndices[59], 59);
  const [result] = runStatisticalTests(
    pages.map(page => ({ pageName: page.pageName, values: page.values })),
    'categorical_obs',
  );
  assert.ok(Number.isFinite(result.pValue));
});

test('excluding missing categorical values keeps a page without missing cells as the same object', () => {
  const page = {
    pageId: 'p1',
    pageName: 'P1',
    values: codedPage([0, 1], ['a', 'b']),
    categories: ['a', 'b'],
    missingCode: 255,
    cellIndices: Uint32Array.of(3, 4),
    cellCount: 2,
  };
  assert.equal(excludeMissingCategoricalValues([page])[0], page);
});

test('sorting categories by name accepts numeric and boolean labels', () => {
  assert.deepEqual(
    PlotHelpers.sortCategories(new Map([[10, 1], [2, 5], [1, 3]]), 'name'),
    [1, 2, 10],
  );
  assert.deepEqual(
    PlotHelpers.sortCategories(new Map([['b', 1], [true, 1], ['a', 1], [false, 1]]), 'name'),
    [false, true, 'a', 'b'],
  );
});

test('Quick Insights composition excludes missing cells from the counts and the percentages', async () => {
  const { QuickInsights } = await import(
    '../assets/js/app/analysis/ui/analysis-types/quick-insights-ui.js'
  );
  const insights = Object.create(QuickInsights.prototype);
  const summary = await insights._summarizeCategoricalAcrossPages(
    'cell_type',
    {
      categories: ['T', 'B'],
      codes: Uint16Array.of(0, 0, 65_535, 65_535, 65_535, 1),
    },
    ['page-1'],
    { 'page-1': { cellIndices: Uint32Array.of(0, 1, 2, 3, 4, 5) } },
  );
  assert.equal(summary.total, 3);
  assert.deepEqual(
    summary.topCategories.map(({ name, count, percent }) => [name, count, percent]),
    [['T', 2, '66.7'], ['B', 1, '33.3']],
  );

  assert.equal(
    await insights._summarizeCategoricalAcrossPages(
      'cell_type',
      { categories: ['T'], codes: Uint16Array.of(65_535) },
      ['page-1'],
      { 'page-1': { cellIndices: Uint32Array.of(0) } },
    ),
    null,
  );
});
