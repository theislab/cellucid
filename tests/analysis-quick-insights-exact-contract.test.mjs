import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  QuickInsights,
} from '../assets/js/app/analysis/ui/analysis-types/quick-insights-ui.js';
import {
  AnalysisUIManager,
} from '../assets/js/app/analysis/ui/analysis-ui-manager.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function quickInsightsOwnershipHarness({ isVisible = () => true } = {}) {
  const computation = deferred();
  const publications = [];
  const pages = [
    { id: 'page-1', name: 'Page 1', highlightedGroups: [] },
    { id: 'page-2', name: 'Page 2', highlightedGroups: [] },
  ];
  const insights = new QuickInsights({
    container: null,
    dataLayer: {
      getActiveHighlightPageId() {
        return 'page-1';
      },
      getPages() {
        return pages;
      },
    },
  });

  insights._isVisible = isVisible;
  insights._computeInsights = () => computation.promise;
  insights._renderEmpty = () => publications.push({ type: 'empty' });
  insights._renderError = message => publications.push({ message, type: 'error' });
  insights._renderInsights = result => publications.push({ result, type: 'insights' });
  insights._renderLoading = () => publications.push({ type: 'loading' });

  return { computation, insights, publications };
}

function quickInsightsHarness({
  categoricalFields = [{ key: 'cell_type', name: 'Cell type' }],
  continuousFields = [],
  fetchBulkObsFields,
  pages = [{
    id: 'page-1',
    name: 'Page 1',
    highlightedGroups: [],
  }],
} = {}) {
  const insights = Object.create(QuickInsights.prototype);
  insights._selectedCategoricalObsKeys = categoricalFields.map(field => field.key);
  insights._selectedContinuousObsKeys = continuousFields.map(field => field.key);
  insights._hasUserSelectedCategoricalObsFields = true;
  insights._hasUserSelectedContinuousObsFields = true;
  insights.dataLayer = {
    getPages() {
      return pages;
    },
    getCellCountForPageId() {
      return 1;
    },
    getAvailableVariables(type) {
      if (type === 'categorical_obs') return categoricalFields;
      if (type === 'continuous_obs') return continuousFields;
      throw new Error(`Unexpected variable type: ${type}`);
    },
    fetchBulkObsFields,
  };
  return insights;
}

test('Quick Insights propagates the required bulk observation failure', async () => {
  const injected = new Error('injected Quick Insights field failure');
  const insights = quickInsightsHarness({
    fetchBulkObsFields: async () => {
      throw injected;
    },
  });

  await assert.rejects(
    insights._computeInsights(['page-1'], new AbortController().signal),
    error => error === injected,
  );
});

test('Quick Insights rejects a missing requested field instead of returning partial insights', async () => {
  const insights = quickInsightsHarness({
    fetchBulkObsFields: async () => ({
      fields: {},
      pageData: {
        'page-1': {
          name: 'Page 1',
          cellIndices: Uint32Array.of(0),
          cellCount: 1,
        },
      },
      stats: {
        fieldsLoaded: 0,
        cellsTotal: 1,
        loadTimeMs: 1,
      },
    }),
  });

  await assert.rejects(
    insights._computeInsights(['page-1'], new AbortController().signal),
    /requested observation field "cell_type" is missing/i,
  );
});

test('Quick Insights preserves prototype-named field and page cross-products', async () => {
  const exactNames = Object.getOwnPropertyNames(Object.prototype);
  const pages = exactNames.map(id => ({
    id,
    name: `Page ${id}`,
    highlightedGroups: [],
  }));
  const continuousFields = exactNames.map(key => ({
    key,
    name: `Field ${key}`,
  }));
  const fields = Object.fromEntries(
    exactNames.map((key, fieldIndex) => [
      key,
      {
        values: Float32Array.from(
          { length: exactNames.length },
          (_, pageIndex) => fieldIndex * 100 + pageIndex,
        ),
      },
    ]),
  );
  const pageData = Object.fromEntries(
    exactNames.map((pageId, pageIndex) => [
      pageId,
      {
        cellIndices: Uint32Array.of(pageIndex),
      },
    ]),
  );
  const insights = quickInsightsHarness({
    categoricalFields: [],
    continuousFields,
    fetchBulkObsFields: async () => ({
      fields,
      pageData,
      stats: {
        cellsTotal: exactNames.length,
        fieldsLoaded: exactNames.length,
        loadTimeMs: 1,
      },
    }),
    pages,
  });

  const result = await insights._computeInsights(
    exactNames,
    new AbortController().signal,
  );

  assert.deepEqual(result.pages.map(page => page.id), exactNames);
  assert.equal(result.totalCells, exactNames.length);
  assert.deepEqual(
    result.continuousSummaries.map(summary => summary.field),
    exactNames,
  );
  for (const summary of result.continuousSummaries) {
    assert.equal(summary.count, exactNames.length, summary.field);
    assert.equal(summary.missingCount, 0, summary.field);
  }
});

test('Quick Insights categorical summaries require exact raw codes and categories', () => {
  const insights = Object.create(QuickInsights.prototype);

  assert.throws(
    () => insights._summarizeCategoricalAcrossPages(
      'cell_type',
      {
        'page-1': {
          values: ['T cell'],
        },
      },
      ['page-1'],
      {
        'page-1': {
          cellIndices: Uint32Array.of(0),
        },
      },
    ),
    /cell_type.*Uint16Array.*categories/i,
  );

  assert.throws(
    () => insights._summarizeCategoricalAcrossPages(
      'cell_type',
      {
        categories: ['T cell'],
        codes: Uint16Array.of(1),
      },
      ['page-1'],
      {
        'page-1': {
          cellIndices: Uint32Array.of(0),
        },
      },
    ),
    /category code 1.*cell_type.*outside 1 categor/i,
  );
});

test('Quick Insights computes one deterministic exact continuous contract at every size', () => {
  const count = 50_001;
  const values = Float32Array.from({ length: count }, (_, index) => index);
  const cellIndices = Uint32Array.from({ length: count }, (_, index) => index);
  const insights = Object.create(QuickInsights.prototype);

  const first = insights._summarizeContinuousAcrossPages(
    'score',
    { values },
    ['page-1'],
    {
      'page-1': {
        cellIndices,
      },
    },
  );
  const second = insights._summarizeContinuousAcrossPages(
    'score',
    { values },
    ['page-1'],
    {
      'page-1': {
        cellIndices,
      },
    },
  );

  assert.deepEqual(second, first);
  assert.equal(first.approximate, false);
  assert.equal(first.count, count);
  assert.equal(first.mean, 25_000);
  assert.equal(first.median, 25_000);
  assert.equal(first.min, 0);
  assert.equal(first.max, 50_000);
  assert.equal(first.q1, 12_500);
  assert.equal(first.q3, 37_500);
});

test('Quick Insights exposes only the current selected-pages and settings contract', async () => {
  const source = await readFile(
    new URL(
      '../assets/js/app/analysis/ui/analysis-types/quick-insights-ui.js',
      import.meta.url,
    ),
    'utf8',
  );

  assert.doesNotMatch(source, /\bupdateForActivePage\b/);
  assert.doesNotMatch(source, /settings\.pageMode|settings\.manuallySelectedPages/);
  assert.doesNotMatch(source, /legacy method|legacy format|backwards compatibility/i);
});

test('Quick Insights publishes a new trigger generation before its debounce window', async t => {
  t.mock.method(console, 'error', () => {});
  const { computation, insights, publications } = quickInsightsOwnershipHarness();
  const pending = insights.updateForSelectedPages();
  publications.length = 0;
  const previousRequestId = insights._currentRequestId;

  insights._triggerUpdate();
  const requestIdAfterTrigger = insights._currentRequestId;
  computation.reject(new Error('older request failed after the newer intent'));
  await pending;
  insights.destroy();

  assert.deepEqual(
    {
      publications,
      requestGenerationAdvanced:
        requestIdAfterTrigger === previousRequestId + 1,
    },
    {
      publications: [],
      requestGenerationAdvanced: true,
    },
  );
});

test('Quick Insights page, destroy, and dataset-reset intents own all later publication', async () => {
  let visible = true;
  const pageCase = quickInsightsOwnershipHarness({
    isVisible: () => visible,
  });
  const pagePending = pageCase.insights.updateForSelectedPages();
  pageCase.publications.length = 0;
  pageCase.insights._pageSelector = {
    destroy() {},
    getSelectedPages() {
      return ['page-2'];
    },
    isDynamicMode() {
      return false;
    },
  };
  const pageRequestId = pageCase.insights._currentRequestId;
  visible = false;
  pageCase.insights._handlePageChange(['page-2']);
  const pageRequestIdAfterIntent = pageCase.insights._currentRequestId;
  pageCase.computation.resolve({
    pages: [{ cellCount: 1, id: 'page-1', name: 'Page 1' }],
    totalCells: 1,
  });
  await pagePending;
  pageCase.insights.destroy();

  const destroyCase = quickInsightsOwnershipHarness();
  const destroyPending = destroyCase.insights.updateForSelectedPages();
  destroyCase.publications.length = 0;
  destroyCase.insights.destroy();
  destroyCase.computation.reject(
    new Error('request failed after direct destruction'),
  );
  await destroyPending;

  const datasetCase = quickInsightsOwnershipHarness();
  const datasetPending = datasetCase.insights.updateForSelectedPages();
  datasetCase.publications.length = 0;
  const manager = Object.create(AnalysisUIManager.prototype);
  manager._uis = new Map([
    ['quick', { initialized: true, ui: datasetCase.insights }],
  ]);
  manager._activeMode = 'quick';
  manager._currentPages = ['page-1'];
  manager.reset();
  datasetCase.computation.reject(
    new Error('request failed after dataset-reset teardown'),
  );
  await datasetPending;

  assert.deepEqual(
    {
      datasetReset: datasetCase.publications,
      destroy: destroyCase.publications,
      hiddenPageChange: pageCase.publications,
      pageGenerationAdvanced:
        pageRequestIdAfterIntent === pageRequestId + 1,
    },
    {
      datasetReset: [],
      destroy: [],
      hiddenPageChange: [],
      pageGenerationAdvanced: true,
    },
  );
});
