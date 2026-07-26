import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  QuickInsights,
} from '../assets/js/app/analysis/ui/analysis-types/quick-insights-ui.js';

function quickInsightsHarness({
  categoricalFields = [{ key: 'cell_type', name: 'Cell type' }],
  continuousFields = [],
  fetchBulkObsFields,
} = {}) {
  const insights = Object.create(QuickInsights.prototype);
  insights._selectedCategoricalObsKeys = categoricalFields.map(field => field.key);
  insights._selectedContinuousObsKeys = continuousFields.map(field => field.key);
  insights._hasUserSelectedCategoricalObsFields = true;
  insights._hasUserSelectedContinuousObsFields = true;
  insights.dataLayer = {
    getPages() {
      return [{
        id: 'page-1',
        name: 'Page 1',
        highlightedGroups: [],
      }];
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
