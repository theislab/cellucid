/**
 * Large analysis pages are computed off the main thread (analysis workers) or
 * in slices that hand the event loop back. Neither may change an answer: every
 * worker operation is the same function the calling thread would run, and
 * every value a producer records for its consumers (category counts, finite
 * values) is the value they would compute. `Object.is` and deep equality are
 * the comparisons.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DataLayer, excludeMissingCategoricalValues } from '../assets/js/app/analysis/data/data-layer.js';
import { categoryCounts } from '../assets/js/app/analysis/shared/category-counts.js';
import {
  adoptFiniteNumbers,
  computeStats,
  finiteNumbers,
  finiteNumbersReport
} from '../assets/js/app/analysis/shared/number-utils.js';
import { executeOperation } from '../assets/js/app/analysis/compute/operation-handlers.js';
import { OperationType } from '../assets/js/app/analysis/compute/operations.js';
import { runStatisticalTests } from '../assets/js/app/analysis/stats/statistical-tests.js';
import { plotlyBoxSummary } from '../assets/js/app/analysis/plots/plotly-box-statistics.js';
import { histogramSamples } from '../assets/js/app/analysis/plots/plotly-histogram-bins.js';
import { densityCurveOrPlan } from '../assets/js/app/analysis/plots/density-curve.js';
import { selectSorted } from '../assets/js/app/analysis/compute/math-utils.js';
import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function page(id, cellIndices) {
  return {
    id,
    name: `Page ${id}`,
    highlightedGroups: [{ id: `${id}-g`, type: 'lasso', label: id, enabled: true, cellIndices, cellCount: cellIndices.length }],
  };
}

test('a categorical page carries exactly the counts a recount gives, in first-occurrence order', async () => {
  const random = lcg(1);
  const n = 70_000;
  const codes = Uint16Array.from({ length: n }, () => (random() < 0.05 ? 65535 : Math.floor(random() * 7)));
  const categories = ['g', 'a', 'f', 'b', 'e', 'c', 'd'];
  const even = [];
  const odd = [];
  for (let i = 0; i < n; i++) (i % 2 ? odd : even).push(i);
  const layer = new DataLayer({
    pointCount: n,
    getHighlightPages: () => [page('a', even), page('b', odd)],
    obsData: { fields: [{ key: 'cell_type', kind: 'category', loaded: true, codes, categories }] },
    varData: { fields: [] },
    ensureFieldLoaded: async () => {},
    ensureVarFieldLoaded: async () => {},
  }, { enableNotifications: false, enablePrefetch: false, enableVersionTracking: true });
  const pages = await layer.getDataForPages({ type: 'categorical_obs', variableKey: 'cell_type', pageIds: ['a', 'b'] });
  for (const pd of pages) {
    const recount = new Map();
    for (const value of pd.values) recount.set(value, (recount.get(value) ?? 0) + 1);
    assert.deepEqual([...categoryCounts(pd.values)], [...recount]);
  }
  for (const pd of excludeMissingCategoricalValues(pages)) {
    const recount = new Map();
    for (const value of pd.values) recount.set(value, (recount.get(value) ?? 0) + 1);
    assert.equal(recount.has(null), false);
    assert.deepEqual([...categoryCounts(pd.values)], [...recount]);
  }
});

test('adopted finite values are exactly what finiteNumbers computes', () => {
  const values = Float32Array.from({ length: 5000 }, (_, i) => (i % 13 === 0 ? NaN : i / 7));
  const report = finiteNumbersReport(values.slice());
  const fresh = values.slice();
  adoptFiniteNumbers(fresh, report.finiteCount, report.finite);
  assert.deepEqual(Array.from(finiteNumbers(fresh)), Array.from(finiteNumbers(values.slice())));
  const allFinite = Float32Array.from({ length: 100 }, (_, i) => i);
  adoptFiniteNumbers(allFinite, 100, null);
  assert.equal(finiteNumbers(allFinite), allFinite);
  assert.throws(() => adoptFiniteNumbers(values.slice(), 3, new Float32Array(2)), /finite count/);
});

test('worker operations return what the calling thread computes', () => {
  const random = lcg(2);
  const a = Float32Array.from({ length: 30_000 }, () => (random() < 0.6 ? 0 : Math.fround(random() * 4)));
  const b = Float32Array.from({ length: 25_000 }, () => (random() < 0.01 ? NaN : Math.fround(random() * 5 - 1)));

  assert.deepEqual(
    executeOperation(OperationType.COMPUTE_SUMMARY_STATISTICS, { values: b }),
    computeStats(b)
  );
  const pages = [{ pageName: 'A', values: a }, { pageName: 'B', values: b }];
  assert.deepEqual(
    executeOperation(OperationType.COMPUTE_STATISTICAL_TESTS, { pages, dataType: 'gene_expression' }).results,
    runStatisticalTests(pages, 'gene_expression')
  );
  const { summary } = executeOperation(OperationType.COMPUTE_BOX_STATISTICS, { values: b, points: 'outliers' });
  assert.deepEqual(summary, plotlyBoxSummary(finiteNumbers(b), 'outliers'));
  const { finite, ...samples } = executeOperation(OperationType.COMPUTE_HISTOGRAM_SAMPLES, { pages: [a, b], nbins: 30 });
  assert.deepEqual(samples, histogramSamples([a, b], 30));
  assert.equal(finite.length, 2);
  const { finiteCount, finite: _f, ...density } = executeOperation(
    OperationType.COMPUTE_DENSITY_PLAN,
    { values: b, bandwidthMult: 0.5, maxKernelTerms: 3_000_000 }
  );
  assert.equal(finiteCount, finiteNumbers(b).length);
  assert.deepEqual(density, densityCurveOrPlan(b, 0.5, 3_000_000));
  const positions = [0, 100, 20_000];
  assert.deepEqual(
    executeOperation(OperationType.COMPUTE_ORDER_STATISTICS, { values: finiteNumbers(b), positions }).selected,
    selectSorted(finiteNumbers(b), positions)
  );
});

test('signature statistics of a large page are the same numbers when the median is selected elsewhere', async () => {
  const random = lcg(3);
  const n = 600_000;
  const scores = Float32Array.from({ length: n }, () => (random() < 0.02 ? NaN : Math.fround(random() * 3)));
  const mva = new MultiVariableAnalysis({});
  const stats = await mva._computeBasicStats(scores);
  const finite = Float32Array.from(Array.from(scores).filter(Number.isFinite));
  const sorted = Float64Array.from(finite).sort();
  const mid = Math.floor(finite.length / 2);
  const median = finite.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  assert.equal(stats.count, finite.length);
  assert.ok(Object.is(stats.median, median));
  assert.ok(Object.is(stats.min, sorted[0]));
  assert.ok(Object.is(stats.max, sorted[sorted.length - 1]));
});
