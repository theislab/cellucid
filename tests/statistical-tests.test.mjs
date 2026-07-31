import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chiSquaredCDF,
  chiSquaredPValue,
  fDistributionPValue,
  mannWhitneyU as coreMannWhitneyU,
  normalSurvival,
  tCDF,
  tTwoSidedPValue,
  welchTTest,
  welchTTestFromMoments
} from '../assets/js/app/analysis/compute/math-utils.js';
import { computeCorrelation } from '../assets/js/app/analysis/compute/operation-handlers.js';
import { computeQuickDifferentialExpression } from '../assets/js/app/analysis/stats/quick-stats.js';
import {
  applyMultipleTestingCorrection,
  benjaminiHochberg,
  benjaminiHochbergAdjusted,
  benjaminiHochbergTestable,
  bonferroniCorrection,
  chiSquaredTest,
  confidenceInterval,
  computeFoldChange,
  fisherExactTest,
  formatStatisticalResult,
  kruskalWallis,
  mannWhitneyU,
  oneWayANOVA,
  runStatisticalTests,
  tTest
} from '../assets/js/app/analysis/stats/statistical-tests.js';

function assertClose(actual, expected, tolerance = 1e-10) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

function assertRelative(actual, expected, relativeTolerance = 1e-10) {
  const error = Math.abs(actual - expected);
  assert.ok(
    error <= Math.abs(expected) * relativeTolerance,
    `expected ${actual} to be within ${relativeTolerance} relative error of ${expected}`
  );
}

test('Student t CDF preserves tails, symmetry, and infinite limits', () => {
  assertClose(tCDF(-2, 30), 0.02731252248149155);
  assertClose(tCDF(2, 30), 0.9726874775185084);
  assertClose(2 * (1 - tCDF(2, 30)), 0.05462504496298311);
  assert.equal(tCDF(-Infinity, 30), 0);
  assert.equal(tCDF(Infinity, 30), 1);
});

test('two-sided t and normal tails remain finite without CDF cancellation', () => {
  assertRelative(tTwoSidedPValue(20, 30), 6.749083665771285e-19, 1e-12);
  assertRelative(tTwoSidedPValue(10, 1000), 1.6670702958600081e-22, 1e-11);

  const z = (1250 - 0.5) / Math.sqrt(50 * 50 * 101 / 12);
  assertRelative(2 * normalSurvival(z), 7.066071930388964e-18, 1e-10);

  const separated = coreMannWhitneyU(
    Array.from({ length: 50 }, (_, index) => index),
    Array.from({ length: 50 }, (_, index) => index + 50)
  );
  assertRelative(separated.pValue, 7.066071930388964e-18, 1e-10);
});

test('Welch test uses its finite-sample t distribution in every public path', () => {
  const expectedP = 0.10557280900008414;

  const core = welchTTest([0, 1], [2, 3]);
  const direct = tTest([0, 1], [2, 3]);
  const orchestrated = runStatisticalTests([
    { pageName: 'First', values: new Float32Array([0, 1]) },
    { pageName: 'Second', values: new Float32Array([2, 3]) }
  ], 'continuous_obs')[0];

  for (const result of [core, direct, orchestrated]) {
    assertClose(result.statistic, -Math.sqrt(8));
    assertClose(result.df, 2);
    assertClose(result.pValue, expectedP);
  }
  assert.equal(orchestrated.significance, 'ns');
  assert.match(orchestrated.interpretation, /^No significant difference/);
});

test('Welch test defines identical and distinct zero-variance groups exactly', () => {
  const identicalCore = welchTTest([1, 1], [1, 1]);
  assert.deepEqual(
    identicalCore,
    { statistic: 0, pValue: 1, df: 2 }
  );
  assert.deepEqual(
    welchTTestFromMoments(1, 0, 2, 1, 0, 2),
    { statistic: 0, pValue: 1, df: 2 }
  );

  const identicalDisplayed = tTest([1, 1], [1, 1]);
  assert.equal(identicalDisplayed.statistic, 0);
  assert.equal(identicalDisplayed.pValue, 1);
  assert.equal(identicalDisplayed.significance, 'ns');
  assert.equal(identicalDisplayed.effectSize, 0);

  const distinct = welchTTest([0, 0], [1, 1]);
  assert.equal(distinct.statistic, -Infinity);
  assert.equal(distinct.pValue, 0);
  assert.equal(distinct.df, 2);

  for (const result of [
    tTest([0, 0], [1, 1]),
    runStatisticalTests([
      { pageName: 'First', values: new Float32Array([0, 0]) },
      { pageName: 'Second', values: new Float32Array([1, 1]) }
    ], 'continuous_obs')[0]
  ]) {
    assert.equal(result.statistic, -Infinity);
    assert.equal(result.pValue, 0);
    assert.equal(result.significance, '***');
    assert.equal(result.effectSize, null);
    assert.match(result.interpretation, /effect size undefined/);
  }
});

test('Mann-Whitney uses an exact two-sided probability for small untied samples', () => {
  for (const groups of [
    [[0, 1, 2], [3, 4, 5]],
    [new Float32Array([0, 1, 2]), new Float32Array([3, 4, 5])]
  ]) {
    const core = coreMannWhitneyU(...groups);
    assert.equal(core.statistic, 0);
    assert.equal(core.pValueMethod, 'exact');
    assert.equal(core.pValue, 0.1);

    const displayed = mannWhitneyU(...groups);
    assert.equal(displayed.statistic, 0);
    assert.equal(displayed.pValue, 0.1);
    assert.equal(displayed.pValueMethod, 'Exact');
    assert.equal(displayed.significance, 'ns');
    assert.equal(formatStatisticalResult(displayed).method, 'Exact');
  }

  assert.equal(mannWhitneyU([0, 1, 2], [3, 4, 5]).effectSize, -1);
  assert.equal(mannWhitneyU([3, 4, 5], [0, 1, 2]).effectSize, 1);
});

test('Mann-Whitney asymptotic probability corrects for ties and continuity', () => {
  for (const result of [
    coreMannWhitneyU([0, 1, 1, 2], [1, 2, 2, 3]),
    mannWhitneyU([0, 1, 1, 2], [1, 2, 2, 3])
  ]) {
    assertClose(result.pValue, 0.1720337089218, 1e-6);
  }
  assert.equal(
    coreMannWhitneyU([0, 1, 1, 2], [1, 2, 2, 3]).pValueMethod,
    'asymptotic'
  );
  assert.match(
    mannWhitneyU([0, 1, 1, 2], [1, 2, 2, 3]).pValueMethod,
    /^Asymptotic/
  );

  const allTiedCore = coreMannWhitneyU([1, 1], [1, 1]);
  assert.equal(allTiedCore.pValue, 1);
  const allTiedDisplayed = mannWhitneyU([1, 1], [1, 1]);
  assert.equal(allTiedDisplayed.pValue, 1);
  assert.equal(allTiedDisplayed.significance, 'ns');
  assert.equal(allTiedDisplayed.effectSize, 0);
});

test('Mann-Whitney bounds exact inference to small samples', () => {
  const result = coreMannWhitneyU(
    Array.from({ length: 50 }, (_, index) => index),
    Array.from({ length: 50 }, (_, index) => index + 50)
  );
  assert.equal(result.pValueMethod, 'asymptotic');
  assert.ok(Number.isFinite(result.pValue));
});

test('degenerate one-way ANOVA distinguishes constant groups', () => {
  const distinct = oneWayANOVA([
    new Float32Array([0, 0]),
    new Float32Array([1, 1]),
    new Float32Array([2, 2])
  ]);
  assert.equal(distinct.statistic, Infinity);
  assert.equal(distinct.pValue, 0);
  assert.equal(distinct.significance, '***');
  assert.equal(formatStatisticalResult(distinct).statistic, '∞');

  const identical = oneWayANOVA([[1, 1], [1, 1], [1, 1]]);
  assert.ok(Number.isNaN(identical.statistic));
  assert.ok(Number.isNaN(identical.pValue));
  assert.equal(identical.significance, 'N/A');
  assert.equal(identical.effectSize, null);

  const decimalIdentical = oneWayANOVA([
    [0.1, 0.1],
    [0.1, 0.1, 0.1],
    [0.1, 0.1, 0.1, 0.1]
  ]);
  assert.ok(Number.isNaN(decimalIdentical.statistic));
  assert.equal(decimalIdentical.significance, 'N/A');
});

test('one-way ANOVA handles typed arrays without flattening corruption', () => {
  const result = oneWayANOVA([
    new Float32Array([0, 1]),
    new Float32Array([2, 3]),
    new Float32Array([4, 5])
  ]);

  assertClose(result.statistic, 16);
  assertClose(result.pValue, 0.02509457330439086);
  assert.equal(result.significance, '*');
});

test('scatter correlation uses the Student t reference probability', () => {
  const result = computeCorrelation({
    xValues: [1, 2, 3, 4, 5],
    yValues: [1, 2, 3, 5, 4],
    method: 'pearson'
  });

  assertClose(result.r, 0.9);
  assertClose(result.pValue, 0.0373860734685);
});

test('quick differential expression delegates p-values to Welch inference', async () => {
  const dataLayer = {
    getAvailableVariables: () => [{ key: 'GENE', name: 'Gene' }],
    getDataForPages: async () => [
      { values: [0, 1] },
      { values: [2, 3] }
    ]
  };

  const quick = await computeQuickDifferentialExpression(
    dataLayer,
    'page-a',
    'page-b',
    1
  );
  // scipy.stats.ttest_ind([0, 1], [2, 3], equal_var=False) -> pvalue 0.10557...
  const [result] = quick.results;
  assertClose(result.pValue, 0.10557280900008414);
  // A family of one: the correction cannot move the probability.
  assert.equal(quick.genesTested, 1);
  assert.equal(quick.genesUntestable, 0);
  assertClose(result.adjustedPValue, 0.10557280900008414);
});

test('chi-square upper tails use the exact gamma relationship', () => {
  assertClose(chiSquaredPValue(3.84, 1), 0.0500435212487051);
  assertClose(chiSquaredPValue(10, 2), 0.006737946999085467);
  assertClose(chiSquaredPValue(500000, 500000), 0.4997340385066312, 1e-8);
  assertClose(chiSquaredPValue(1000000, 1000000), 0.4998119368033945, 1e-8);
  assertClose(chiSquaredPValue(10000000, 10000000), 0.4999405291773478, 1e-8);
  const boundedFallback = chiSquaredPValue(1e12, 1e12);
  assert.ok(Number.isFinite(boundedFallback));
  assert.ok(Math.abs(boundedFallback - 0.5) < 1e-5);
  assertClose(
    chiSquaredCDF(1e12, 1e12) + boundedFallback,
    1,
    1e-12
  );
  assert.ok(Number.isNaN(chiSquaredPValue(0, 0)));
});

test('automatic categorical inference uses Fisher exact for a sparse 2x2 table', () => {
  const [result] = runStatisticalTests([
    { pageName: 'First', values: ['A', 'A', 'A'] },
    { pageName: 'Second', values: ['B', 'B', 'B'] }
  ], 'categorical_obs');

  assert.equal(result.testName, "Fisher's exact test");
  assertClose(result.pValue, 0.1);
  assert.equal(result.significance, 'ns');
  assert.equal(result.pValueMethod, 'Exact (two-sided)');
});

test('Fisher odds-ratio references are deterministic and disclosed', () => {
  const original = runStatisticalTests([
    { pageName: 'First', values: ['A', 'A', 'A', 'B'] },
    { pageName: 'Second', values: ['A', 'B', 'B', 'B'] }
  ], 'categorical_obs')[0];
  const permuted = runStatisticalTests([
    { pageName: 'First', values: ['B', 'A', 'A', 'A'] },
    { pageName: 'Second', values: ['B', 'B', 'B', 'A'] }
  ], 'categorical_obs')[0];

  assert.equal(original.statistic, 9);
  assert.equal(permuted.statistic, 9);
  assert.equal(original.pValue, permuted.pValue);
  assert.match(original.effectSizeType, /First vs Second; A vs B/);

  const separated = runStatisticalTests([
    { pageName: 'A page', values: ['A', 'A', 'A'] },
    { pageName: 'B page', values: ['B', 'B', 'B'] }
  ], 'categorical_obs')[0];
  const separatedDisplay = formatStatisticalResult(separated);
  assert.equal(separated.effectSize, Infinity);
  assert.equal(
    separatedDisplay.effectSize,
    '∞ (sample OR (A page vs B page; A vs B))'
  );
});

test('automatic categorical inference keeps chi-square only when expected counts are adequate', () => {
  const dense = runStatisticalTests([
    { pageName: 'First', values: [...Array(15).fill('A'), ...Array(5).fill('B')] },
    { pageName: 'Second', values: [...Array(5).fill('A'), ...Array(15).fill('B')] }
  ], 'categorical_obs')[0];
  assert.equal(dense.testName, 'Chi-squared test');
  assertClose(dense.pValue, 0.001565402258002548);

  const non2x2 = runStatisticalTests([
    { pageName: 'First', values: [...Array(5).fill('A'), ...Array(5).fill('B'), ...Array(5).fill('C')] },
    { pageName: 'Second', values: [...Array(5).fill('A'), ...Array(5).fill('B'), ...Array(5).fill('C')] }
  ], 'categorical_obs')[0];
  assert.equal(non2x2.testName, 'Chi-squared test');
  assert.ok(Number.isFinite(non2x2.pValue));

  const sparseNon2x2 = runStatisticalTests([
    { pageName: 'First', values: ['A', 'A', 'A'] },
    { pageName: 'Second', values: ['B', 'C', 'C'] }
  ], 'categorical_obs')[0];
  assert.equal(sparseNon2x2.testName, 'Chi-squared test');
  assert.ok(Number.isNaN(sparseNon2x2.statistic));
  assert.ok(Number.isNaN(sparseNon2x2.pValue));
  assert.equal(sparseNon2x2.significance, 'N/A');
  assert.match(sparseNon2x2.interpretation, /expected count.*below 5/i);
});

test('categorical inference rejects missing table dimensions', () => {
  for (const result of [
    chiSquaredTest([
      { pageName: 'First', values: ['A', 'A'] },
      { pageName: 'Second', values: ['A', 'A'] }
    ]),
    runStatisticalTests([
      { pageName: 'First', values: [] },
      { pageName: 'Second', values: ['A', 'B'] }
    ], 'categorical_obs')[0]
  ]) {
    assert.ok(Number.isNaN(result.statistic));
    assert.ok(Number.isNaN(result.pValue));
    assert.equal(result.significance, 'N/A');
    assert.equal(result.effectSize, null);
  }
});

test('categorical inference rejects unsupported or missing labels without serialization', () => {
  const unsupported = [
    null,
    undefined,
    NaN,
    Infinity,
    1n,
    Symbol('category'),
    { label: 'object category' },
    ['array category']
  ];

  for (const value of unsupported) {
    assert.throws(
      () => runStatisticalTests([
        { pageName: 'First', values: ['reference', 'reference'] },
        { pageName: 'Second', values: [value, value] }
      ], 'categorical_obs'),
      /categorical statistical value.*string, finite number, or boolean/i
    );
  }

  const circular = {};
  circular.self = circular;
  assert.throws(
    () => runStatisticalTests([
      { pageName: 'First', values: ['reference'] },
      { pageName: 'Second', values: [circular] }
    ], 'categorical_obs'),
    /categorical statistical value.*string, finite number, or boolean/i
  );
});

test('categorical inference preserves distinct primitive category identities', () => {
  const exactCategories = Array.from(
    { length: 6 },
    () => [false, 0, '0']
  ).flat();
  const result = runStatisticalTests([
    { pageName: 'First', values: exactCategories },
    { pageName: 'Second', values: [...exactCategories] }
  ], 'categorical_obs')[0];

  assert.equal(result.testName, 'Chi-squared test');
  assert.equal(result.df, 2);
  assert.equal(result.statistic, 0);
  assert.equal(result.pValue, 1);
});

test('Kruskal-Wallis corrects tied ranks before its chi-square tail', () => {
  const result = kruskalWallis([
    [1, 1],
    [2, 4, 1, 2, 0, 2, 1],
    [2, 3, 2, 4, 3, 2, 2, 4]
  ]);

  assertClose(result.statistic, 6.322531160115);
  assertClose(result.pValue, 0.04237208187084923);
  assert.equal(result.significance, '*');

  const allTied = kruskalWallis([[1, 1], [1, 1], [1, 1]]);
  assert.ok(Number.isNaN(allTied.statistic));
  assert.ok(Number.isNaN(allTied.pValue));
  assert.equal(allTied.significance, 'N/A');
  assert.equal(allTied.effectSize, null);
});

test('central continuous APIs filter non-finite values and guard undefined domains', () => {
  assertClose(tTest([0, 1, NaN], [2, 3]).pValue, 0.10557280900008414);
  assertClose(mannWhitneyU([0, 1, NaN], [2, 3]).pValue, 1 / 3);

  const groups = [
    [1, 2, NaN],
    [3, 4, 5],
    [6, 7, 8]
  ];

  const anova = oneWayANOVA(groups);
  assertClose(anova.statistic, 20.833333333333332);
  assertClose(anova.pValue, 0.0037575784670738433);

  const kruskal = kruskalWallis(groups);
  assertClose(kruskal.statistic, 6.25);
  assertClose(kruskal.pValue, 0.04393693362340742);
  assert.ok(kruskal.effectSize >= 0 && kruskal.effectSize <= 1);

  assert.ok(Number.isNaN(fDistributionPValue(1, 0, 3)));
  assert.ok(Number.isNaN(fDistributionPValue(1, 2, 0)));
});

test('statistical APIs reject alternate schemas and preserve numeric zero', () => {
  assert.throws(
    () => runStatisticalTests([
      { values: [0, 1] },
      { pageName: 'Second', values: [2, 3] }
    ], 'continuous_obs'),
    /requires a trimmed pageName/i
  );
  assert.throws(
    () => runStatisticalTests([], 'unknown'),
    /unsupported statistical data type/i
  );
  assert.throws(
    () => tTest(null, [1, 2]),
    /must be an Array or TypedArray/i
  );
  assert.throws(
    () => oneWayANOVA([[1, '2'], [3, 4]]),
    /numeric value at every index/i
  );

  assert.deepEqual(
    confidenceInterval([0]),
    {
      mean: 0,
      lower: NaN,
      upper: NaN,
      se: NaN,
      n: 1,
      confidenceLevel: 0.95
    }
  );
  assert.throws(
    () => confidenceInterval([1, 2], 1),
    /confidence level.*strictly between/i
  );
  assert.throws(
    () => computeFoldChange(-1, 2),
    /meanA.*non-negative/i
  );
});

test('multiple-testing correction has one exact method and probability contract', () => {
  assert.deepEqual(
    benjaminiHochberg([0.01, 0.04, 0.03]),
    {
      adjustedPValues: [0.03, 0.04, 0.04],
      significant: [true, true, true],
      threshold: 0.04,
      significantCount: 3
    }
  );
  assert.deepEqual(
    bonferroniCorrection([]),
    {
      adjustedPValues: [],
      significant: [],
      threshold: null,
      significantCount: 0
    }
  );
  assert.throws(
    () => benjaminiHochberg([0.1, NaN]),
    /p-value 2.*finite and between/i
  );
  assert.throws(
    () => bonferroniCorrection([1.1]),
    /p-value 1.*between 0 and 1/i
  );
  assert.throws(
    () => applyMultipleTestingCorrection([{ pValue: 0.1 }], 'automatic'),
    /method must be exactly/i
  );
});

test('marker worker uses centered moments and preserves extreme p-values', async () => {
  const messages = [];
  globalThis.self = { postMessage: message => messages.push(message) };
  await import('../assets/js/app/analysis/compute/data-worker.js?statistical-regression');

  const runWorker = (type, payload, requestId) => {
    globalThis.self.onmessage({ data: { type, payload, requestId } });
    const message = messages.at(-1);
    assert.equal(message.requestId, requestId);
    assert.equal(message.success, true);
    return message.result;
  };

  const lowSpreadSize = 30000;
  const lowSpreadCodes = new Uint16Array(lowSpreadSize * 2);
  lowSpreadCodes.fill(1, lowSpreadSize);
  runWorker('MARKERS_SET_CONTEXT', {
    codes: lowSpreadCodes,
    codeToGroupIndex: new Int16Array([0, 1]),
    groupCount: 2
  }, 'low-spread-context');

  const lowSpreadValues = new Float32Array(lowSpreadSize * 2);
  for (let index = 0; index < lowSpreadSize; index++) {
    lowSpreadValues[index] = 100 + ((index % 3) - 1) * 1e-5;
    lowSpreadValues[lowSpreadSize + index] =
      100.0001 + ((index % 3) - 1) * 1e-5;
  }
  const lowSpread = runWorker('MARKERS_COMPUTE_GENE', {
    values: lowSpreadValues,
    method: 'ttest',
    minCells: 2
  }, 'low-spread-gene');
  // Uncentered sums of squares over 30,000 values near 100 with a 1e-5 spread
  // cancel into a negative variance, which welchTTestFromMoments answers with
  // NaN. A finite probability is therefore the assertion that the running
  // centered moments held.
  //   scipy.stats.ttest_ind(a, b, equal_var=False)
  //     -> statistic=-1949.9674997291625, df=59998.0, pvalue=0.0
  assert.ok([...lowSpread.pValues].every(Number.isFinite));
  assert.deepEqual([...lowSpread.pValues], [0, 0]);
  // numpy means of the same Float32 fixture, kept in Float32 by the worker.
  assertRelative(lowSpread.meanInGroup[0], 100, 1e-6);
  assertRelative(lowSpread.meanInGroup[1], 100.0000991821289, 1e-6);

  const tailSize = 1000;
  const tailCodes = new Uint16Array(tailSize * 2);
  tailCodes.fill(1, tailSize);
  runWorker('MARKERS_SET_CONTEXT', {
    codes: tailCodes,
    codeToGroupIndex: new Int16Array([0, 1]),
    groupCount: 2
  }, 'tail-context');
  const tailValues = new Float32Array(tailSize * 2);
  for (let index = 0; index < tailSize; index++) {
    const centered = (index % 3) - 1;
    tailValues[index] = centered;
    tailValues[tailSize + index] = centered + 0.8;
  }
  const tail = runWorker('MARKERS_COMPUTE_GENE', {
    values: tailValues,
    method: 'ttest',
    minCells: 2
  }, 'tail-gene');
  assert.ok(tail.pValues instanceof Float64Array);
  assert.ok([...tail.pValues].every(pValue => pValue > 0));

  const { adjustedPValues: adjusted } = benjaminiHochbergAdjusted(
    new Float64Array([1e-50, 1e-48, 0.5])
  );
  assert.ok(adjusted instanceof Float64Array);
  assert.ok(adjusted[0] > 0);
  assert.ok(adjusted[1] > adjusted[0]);

  delete globalThis.self;
});

// =============================================================================
// INDEPENDENT-REFERENCE PARITY
//
// Every constant below is the value produced by SciPy 1.16.3 / NumPy 1.26.4 on
// the same fixture, not a value copied back out of this implementation. The
// SciPy call each one came from is named beside it, including the branch
// (`method='exact'` vs `method='asymptotic'`, `use_continuity=True`), because
// the branch is part of the contract these tests pin.
//
// The contract being pinned:
//   * Mann-Whitney U is two-sided, tests H0 "the two samples come from the same
//     distribution", uses average ranks for ties, and reports U = min(U1, U2).
//   * Inference is exact only when the pooled sample has no ties and both
//     groups hold fewer than 50 values; otherwise it is the normal
//     approximation with the tie-corrected variance
//     (n1*n2/12)*((n+1) - sum(t^3-t)/(n(n-1))) and a 0.5 continuity correction.
//   * Benjamini-Hochberg is the step-up procedure with the running minimum
//     taken from the largest ordered p-value downward, the m/k multiplier, and
//     clamping applied only to the emitted value.
// =============================================================================

test('Mann-Whitney matches scipy.stats.mannwhitneyu on ties, zeros, and single-cell groups', () => {
  // scipy.stats.mannwhitneyu(x, y, alternative='two-sided', method=<branch>,
  //                          use_continuity=True)
  const cases = [
    {
      name: 'untied 5 vs 5',
      g1: [1, 2, 3, 4, 5],
      g2: [6, 7, 8, 9, 10],
      method: 'exact',
      scipy: 0.007936507936507936
    },
    {
      name: 'untied interleaved',
      g1: [1, 3, 5, 7, 9],
      g2: [2, 4, 6, 8, 10],
      method: 'exact',
      scipy: 0.6904761904761905
    },
    {
      // Quantised counts: the realistic case. An implementation that omits the
      // tie correction from the variance reports 0.0679 here instead.
      name: 'heavy count ties',
      g1: [0, 0, 0, 0, 1, 1, 2, 3, 0, 0],
      g2: [0, 1, 1, 1, 2, 2, 3, 4, 5, 0],
      method: 'asymptotic',
      scipy: 0.06958804115458374
    },
    {
      name: 'two distinct pooled values',
      g1: [0, 0, 0, 0, 0, 1, 1, 1],
      g2: [0, 1, 1, 1, 1, 1, 1, 1],
      method: 'asymptotic',
      scipy: 0.0526842533782829
    },
    {
      name: 'all-zero group versus counts',
      g1: new Array(25).fill(0),
      g2: [
        1, 0, 0, 2, 3, 0, 1, 4, 0, 0, 2, 1, 0, 3, 0,
        1, 0, 0, 5, 2, 0, 1, 1, 0, 0, 3, 0, 2, 1, 0
      ],
      method: 'asymptotic',
      scipy: 2.534086896180356e-05
    },
    {
      name: 'constant group at an interior value',
      g1: new Array(20).fill(5),
      g2: [1, 2, 3, 4, 5, 5, 6, 7, 8, 9, 10, 11],
      method: 'asymptotic',
      scipy: 0.3556977661530264
    },
    {
      name: 'group of size one, untied',
      g1: [7],
      g2: [1, 2, 3, 4, 5, 6, 8, 9, 10],
      method: 'exact',
      scipy: 0.8
    },
    {
      name: 'group of size one, tied',
      g1: [3],
      g2: [1, 2, 3, 3, 4, 5],
      method: 'asymptotic',
      scipy: 1
    },
    {
      name: 'two versus two',
      g1: [1, 2],
      g2: [3, 4],
      method: 'exact',
      scipy: 0.3333333333333333
    },
    {
      name: 'two versus three with ties',
      g1: [1, 1],
      g2: [1, 2, 2],
      method: 'asymptotic',
      scipy: 0.31731050786291415
    }
  ];

  for (const { name, g1, g2, method, scipy } of cases) {
    const core = coreMannWhitneyU(g1, g2);
    assert.equal(core.pValueMethod, method, name);
    assertRelative(core.pValue, scipy, 1e-12);
    // The displayed wrapper must not re-derive or round the probability.
    assert.equal(mannWhitneyU(g1, g2).pValue, core.pValue, name);
  }

  // Degenerate: a fully tied pool has zero rank variance, so the asymptotic
  // formula is unusable. It is not undefined — every arrangement is equally
  // extreme, the statistic equals its null mean n1*n2/2, and the exact
  // permutation probability is 1. SciPy agrees:
  //   scipy.stats.mannwhitneyu([3,3,3], [3,3,3,3], alternative='two-sided',
  //                            method='asymptotic', use_continuity=True)
  //     -> MannwhitneyuResult(statistic=6.0, pvalue=1.0)
  //   scipy.stats.mannwhitneyu([0,0], [0,0,0], ...)
  //     -> MannwhitneyuResult(statistic=3.0, pvalue=1.0)
  assert.equal(coreMannWhitneyU([3, 3, 3], [3, 3, 3, 3]).pValue, 1);
  assert.equal(coreMannWhitneyU([3, 3, 3], [3, 3, 3, 3]).statistic, 6);
  assert.equal(coreMannWhitneyU([0, 0], [0, 0, 0]).pValue, 1);
  assert.equal(coreMannWhitneyU([0, 0], [0, 0, 0]).statistic, 3);

  // Empty groups have no statistic at all.
  const empty = coreMannWhitneyU([], [1, 2, 3]);
  assert.ok(Number.isNaN(empty.pValue));
  assert.ok(Number.isNaN(empty.statistic));

  // Exact inference is bounded to n < 50 per group, matching the branch policy.
  const untied49 = Array.from({ length: 49 }, (_, i) => i * 2);
  const untied49b = Array.from({ length: 49 }, (_, i) => i * 2 + 1);
  assert.equal(coreMannWhitneyU(untied49, untied49b).pValueMethod, 'exact');
  assert.equal(
    coreMannWhitneyU([...untied49, 200], untied49b).pValueMethod,
    'asymptotic'
  );
});

test('Benjamini-Hochberg matches scipy.stats.false_discovery_control', () => {
  // scipy.stats.false_discovery_control(p, method='bh')
  const vectors = [
    {
      name: 'running minimum binds at ranks 3-5',
      p: [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216],
      scipy: [
        0.01, 0.04, 0.084, 0.084, 0.084, 0.1, 0.1057142857142857,
        0.216, 0.216, 0.216
      ]
    },
    {
      name: 'tied p-values receive identical adjusted values',
      p: [0.02, 0.02, 0.02, 0.5, 0.5, 0.9],
      scipy: [0.04, 0.04, 0.04, 0.6, 0.6, 0.9]
    },
    {
      name: 'p * m / k above one is clamped',
      p: [0.4, 0.9, 0.95, 0.99, 1.0],
      scipy: [1, 1, 1, 1, 1]
    },
    {
      name: 'adjusted values are returned in input order',
      p: [0.9, 0.001, 0.5, 0.02, 0.7],
      scipy: [0.9, 0.005, 0.8333333333333334, 0.05, 0.875]
    },
    {
      name: 'denormal-scale tails survive the multiplier',
      p: [1e-300, 1e-200, 1e-100, 0.5, 0.9],
      scipy: [5e-300, 2.5e-200, 1.6666666666666669e-100, 0.625, 0.9]
    }
  ];

  for (const { name, p, scipy } of vectors) {
    const { adjustedPValues: adjusted } =
      benjaminiHochbergAdjusted(Float64Array.from(p));
    assert.equal(adjusted.length, scipy.length, name);
    for (let index = 0; index < scipy.length; index++) {
      assertRelative(adjusted[index], scipy[index], 1e-12);
    }

    // All three public entry points must be the same procedure.
    const wrapper = benjaminiHochberg(p, 0.05);
    const testable = benjaminiHochbergTestable(Float64Array.from(p));
    for (let index = 0; index < scipy.length; index++) {
      assertRelative(wrapper.adjustedPValues[index], scipy[index], 1e-12);
      assertRelative(testable.adjustedPValues[index], scipy[index], 1e-12);
    }
    assert.equal(testable.testedCount, p.length, name);
    assert.equal(testable.untestableCount, 0, name);

    // The rejection set is exactly the step-up rule it claims to implement:
    // reject the k* smallest ordered p-values, k* = max{k : p(k) <= k*alpha/m}.
    const m = p.length;
    const ordered = [...p].sort((left, right) => left - right);
    let kStar = 0;
    for (let rank = 0; rank < m; rank++) {
      if (ordered[rank] <= ((rank + 1) * 0.05) / m) kStar = rank + 1;
    }
    assert.equal(wrapper.significantCount, kStar, name);
    assert.equal(
      wrapper.threshold,
      kStar === 0 ? null : ordered[kStar - 1],
      name
    );
    for (let index = 0; index < m; index++) {
      assert.equal(
        wrapper.significant[index],
        kStar > 0 && p[index] <= ordered[kStar - 1],
        `${name} @ ${index}`
      );
    }
  }

  // An untested gene is not a member of the family being corrected, so it is
  // excluded from the denominator instead of being given a fabricated value.
  const partial = benjaminiHochbergTestable(
    Float64Array.from([0.01, NaN, 0.04, NaN, 0.03])
  );
  assert.equal(partial.testedCount, 3);
  assert.equal(partial.untestableCount, 2);
  assert.equal(partial.adjustedPValues[1], null);
  assert.equal(partial.adjustedPValues[3], null);
  // scipy.stats.false_discovery_control([0.01, 0.04, 0.03], method='bh')
  //   -> [0.03, 0.04, 0.04]; the denominator is 3, not 5.
  for (const [index, expected] of [[0, 0.03], [2, 0.04], [4, 0.04]]) {
    assertRelative(partial.adjustedPValues[index], expected, 1e-12);
  }
});

test('Kruskal-Wallis, Welch, chi-squared, and Fisher match their scipy references', () => {
  // scipy.stats.kruskal(*groups)
  const kw = kruskalWallis([
    [0, 1, 1, 2, 2, 2, 3],
    [1, 2, 2, 3, 3, 4, 4, 5],
    [0, 0, 1, 1, 2, 5, 6, 7, 7]
  ]);
  assertRelative(kw.statistic, 2.48331388284947, 1e-12);
  assertRelative(kw.pValue, 0.2889051222670269, 1e-12);
  assert.equal(kw.df, 2);

  // scipy.stats.ttest_ind(a, b, equal_var=False)
  const welch = tTest(
    [1.0, 2.5, 3.5, 4.0, 5.5, 6.0],
    [2.0, 3.0, 3.25, 7.5, 9.0, 11.0, 12.5]
  );
  assertRelative(welch.statistic, -1.787722024188142, 1e-12);
  assertRelative(welch.pValue, 0.10925042591908535, 1e-10);
  assertRelative(welch.df, 8.54130161062574, 1e-12);

  const page = (pageName, counts) => ({
    pageName,
    values: [
      ...new Array(counts[0]).fill('a'),
      ...new Array(counts[1]).fill('b'),
      ...new Array(counts[2] ?? 0).fill('c')
    ]
  });

  // scipy.stats.chi2_contingency([[30, 20, 10], [10, 25, 25]], correction=False)
  const chi = chiSquaredTest([page('p1', [30, 20, 10]), page('p2', [10, 25, 25])]);
  assertRelative(chi.statistic, 16.984126984126984, 1e-12);
  assertRelative(chi.pValue, 0.00020508962237123583, 1e-10);
  assert.equal(chi.df, 2);

  // scipy.stats.fisher_exact([[3, 7], [9, 2]], alternative='two-sided')
  const fisher = fisherExactTest([page('p1', [3, 7]), page('p2', [9, 2])]);
  assertRelative(fisher.statistic, 0.09523809523809523, 1e-12);
  assertRelative(fisher.pValue, 0.02997312285237981, 1e-12);
});

test('marker worker one-vs-rest Wilcoxon ranks against the whole pooled sample', async () => {
  const messages = [];
  globalThis.self = { postMessage: message => messages.push(message) };
  await import('../assets/js/app/analysis/compute/data-worker.js?one-vs-rest-reference');

  const runWorker = (type, payload, requestId) => {
    globalThis.self.onmessage({ data: { type, payload, requestId } });
    const message = messages.at(-1);
    assert.equal(message.requestId, requestId);
    assert.equal(message.success, true, message.error);
    return message.result;
  };

  // Three groups of ten cells over quantised counts. Every one-vs-rest test
  // shares one pooled rank basis and one tie term, so a per-group tie term or a
  // per-group re-ranking would move these numbers.
  const codes = Uint16Array.from([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2
  ]);
  const values = Float32Array.from([
    0, 0, 0, 1, 0, 0, 2, 0, 1, 0,
    1, 2, 1, 3, 2, 1, 2, 4, 1, 2,
    5, 4, 6, 5, 7, 4, 5, 6, 5, 8
  ]);
  runWorker('MARKERS_SET_CONTEXT', {
    codes,
    codeToGroupIndex: Int16Array.from([0, 1, 2]),
    groupCount: 3
  }, 'one-vs-rest-context');

  const result = runWorker('MARKERS_COMPUTE_GENE', {
    values,
    method: 'wilcox',
    minCells: 2
  }, 'one-vs-rest-gene');

  // scipy.stats.mannwhitneyu(group, rest, alternative='two-sided',
  //                          method='asymptotic', use_continuity=True)
  const scipyPValues = [
    6.500927773245818e-05,
    0.70446206022802,
    1.1053583171993454e-05
  ];
  for (let group = 0; group < 3; group++) {
    assertRelative(result.pValues[group], scipyPValues[group], 1e-12);
    assert.equal(result.nIn[group], 10);
    assert.equal(result.nOut[group], 20);
  }
  assert.equal(result.nAll, 30);

  // numpy means and log2((meanIn + 0.01) / (meanOut + 0.01)); the worker keeps
  // fold change in Float32, so the tolerance is Float32 resolution.
  const scipyMeanIn = [0.4, 1.9, 5.5];
  const scipyMeanOut = [3.7, 2.95, 1.15];
  const scipyLog2FC = [
    -3.1777233720027196,
    -0.6320245375932011,
    2.2479275134435857
  ];
  for (let group = 0; group < 3; group++) {
    assertRelative(result.meanInGroup[group], scipyMeanIn[group], 1e-6);
    assertRelative(result.meanOutGroup[group], scipyMeanOut[group], 1e-6);
    assertRelative(result.log2FoldChange[group], scipyLog2FC[group], 1e-6);
  }

  // A gene that is zero in every cell is a fully tied pool: no evidence, p = 1.
  runWorker('MARKERS_SET_CONTEXT', {
    codes: Uint16Array.from([0, 0, 0, 0, 1, 1, 1, 1]),
    codeToGroupIndex: Int16Array.from([0, 1]),
    groupCount: 2
  }, 'all-zero-context');
  const allZero = runWorker('MARKERS_COMPUTE_GENE', {
    values: new Float32Array(8),
    method: 'wilcox',
    minCells: 2
  }, 'all-zero-gene');
  assert.deepEqual([...allZero.pValues], [1, 1]);

  delete globalThis.self;
});

test('rank inference is invariant to the export quantisation it reads', async () => {
  const messages = [];
  globalThis.self = { postMessage: message => messages.push(message) };
  await import('../assets/js/app/analysis/compute/data-worker.js?quantisation-invariance');

  const runWorker = (type, payload, requestId) => {
    globalThis.self.onmessage({ data: { type, payload, requestId } });
    const message = messages.at(-1);
    assert.equal(message.success, true, message.error);
    return message.result;
  };

  // Published exports store expression quantised, and the loader dequantises
  // with `minValue + code * (maxValue - minValue) / maxQuant` — a strictly
  // increasing affine map whenever minValue < maxValue. (The format also allows
  // minValue == maxValue for a constant field, but then every code is 0, so the
  // codes and the values are equally tied and ranks are unaffected.)
  // A rank test must therefore return the same probability whether it is handed
  // the codes or the dequantised values.
  const dequantize = (codes, minValue, maxValue, bits) => {
    const maxQuant = bits === 8 ? 254 : 65534;
    const scale = (maxValue - minValue) / maxQuant;
    const out = new Float32Array(codes.length);
    for (let index = 0; index < codes.length; index++) {
      out[index] = minValue + codes[index] * scale;
    }
    return out;
  };

  const cellCount = 400;
  const groupCodes = new Uint16Array(cellCount);
  const quantCodes = new Uint16Array(cellCount);
  for (let index = 0; index < cellCount; index++) {
    groupCodes[index] = index % 2;
    const bucket = index % 7;
    quantCodes[index] = bucket === 0
      ? 0
      : bucket === 6
        ? 254
        : bucket + groupCodes[index];
  }
  runWorker('MARKERS_SET_CONTEXT', {
    codes: groupCodes,
    codeToGroupIndex: Int16Array.from([0, 1]),
    groupCount: 2
  }, 'quantisation-context');

  const rawResult = runWorker('MARKERS_COMPUTE_GENE', {
    values: Float32Array.from(quantCodes),
    method: 'wilcox',
    minCells: 2
  }, 'quantisation-raw');

  for (const [bits, minValue, maxValue] of [
    [8, 0, 400],
    [16, 0, 400],
    [8, -3, 9.5]
  ]) {
    const dequantised = runWorker('MARKERS_COMPUTE_GENE', {
      values: dequantize(quantCodes, minValue, maxValue, bits),
      method: 'wilcox',
      minCells: 2
    }, `quantisation-${bits}-${minValue}`);
    assert.deepEqual(
      [...dequantised.pValues],
      [...rawResult.pValues],
      `uint${bits} dequantisation must not move the rank probability`
    );
  }

  delete globalThis.self;
});

test('every non-empty Mann-Whitney comparison reports a probability, never "undefined"', () => {
  // The wrapper used to carry a branch for "inference is undefined because all
  // values are tied". No such state exists: `mannWhitneyU` filters to finite
  // values and returns early when either sample is empty, and for two non-empty
  // samples the exact branch is a ratio of permutation counts while the
  // asymptotic branch has a strictly positive tie-corrected variance unless the
  // pool is fully tied — and a fully tied pool returns exactly 1.
  const multisets = [];
  for (let size = 1; size <= 4; size++) {
    const build = (prefix) => {
      if (prefix.length === size) {
        multisets.push([...prefix]);
        return;
      }
      const smallest = prefix.length === 0 ? 0 : prefix[prefix.length - 1];
      for (let value = smallest; value <= 2; value++) {
        build([...prefix, value]);
      }
    };
    build([]);
  }

  let comparisons = 0;
  for (const left of multisets) {
    for (const right of multisets) {
      comparisons++;
      const result = mannWhitneyU(left, right);
      const label = `${JSON.stringify(left)} vs ${JSON.stringify(right)}`;
      assert.ok(
        Number.isFinite(result.pValue) &&
          result.pValue >= 0 &&
          result.pValue <= 1,
        `${label} must produce a probability, got ${result.pValue}`
      );
      assert.notEqual(result.significance, 'N/A', label);
      assert.equal(typeof result.effectSize, 'number', label);
      assert.equal(
        result.effectSizeType,
        'rank-biserial r (group 1 vs 2)',
        label
      );
      assert.match(result.interpretation, /difference in distributions/, label);
    }
  }
  assert.equal(comparisons, 34 * 34);

  // The fully tied pool is the case the deleted branch claimed to own. It is a
  // fully specified answer, not a missing one.
  //   scipy.stats.mannwhitneyu([0,0,0], [0,0,0,0], alternative='two-sided',
  //                            method='asymptotic', use_continuity=True)
  //     -> MannwhitneyuResult(statistic=6.0, pvalue=1.0)
  const tied = mannWhitneyU([0, 0, 0], [0, 0, 0, 0]);
  assert.equal(tied.pValue, 1);
  assert.equal(tied.statistic, 6);
  assert.equal(tied.significance, 'ns');
  assert.equal(tied.effectSize, 0);
  assert.equal(tied.pValueMethod, 'Asymptotic (tie/continuity corrected)');
  assert.equal(
    tied.interpretation,
    'No significant difference in distributions'
  );

  // An empty sample still has no statistic; that guard is the live one.
  const empty = mannWhitneyU([], [1, 2, 3]);
  assert.ok(Number.isNaN(empty.pValue));
  assert.equal(empty.significance, 'N/A');
  assert.equal(empty.interpretation, 'Need at least 1 sample in each group');
});

test('Welch reports the condition that actually made its probability undefined', () => {
  // Constant groups do not make Welch inference undefined. Equal constants are
  // a zero difference over a zero standard error, which this implementation
  // reports as p = 1; unequal constants are an infinite t, reported as p = 0.
  // SciPy returns NaN for the equal-constant case
  //   scipy.stats.ttest_ind([2,2,2], [2,2,2], equal_var=False)
  //     -> TtestResult(statistic=nan, pvalue=nan, df=1.0)
  // and 0 for the unequal-constant case
  //   scipy.stats.ttest_ind([2,2,2], [3,3,3], equal_var=False)
  //     -> TtestResult(statistic=-inf, pvalue=0.0, df=1.0)
  // The first is a stated divergence: a zero difference is evidence of nothing,
  // so the two-sided probability is 1.
  const equalConstants = tTest([2, 2, 2], [2, 2, 2]);
  assert.equal(equalConstants.statistic, 0);
  assert.equal(equalConstants.pValue, 1);
  assert.equal(equalConstants.significance, 'ns');

  const unequalConstants = tTest([2, 2, 2], [3, 3, 3]);
  assert.equal(unequalConstants.statistic, -Infinity);
  assert.equal(unequalConstants.pValue, 0);
  assert.equal(unequalConstants.significance, '***');

  // The one input that does leave Welch without a probability is a sample
  // moment that overflowed: (1e200)^2 is not a finite double, so the variance
  // is Infinity and the t statistic never exists.
  const overflowed = tTest([1e200, -1e200, 0], [1, 2, 3]);
  assert.ok(Number.isNaN(overflowed.pValue));
  assert.equal(overflowed.significance, 'N/A');
  assert.equal(overflowed.effectSize, null);
  assert.equal(
    overflowed.interpretation,
    'Welch inference is undefined because the sample moments are not finite'
  );
});

test('the marker worker publishes probabilities and effects, never a test statistic', async () => {
  const messages = [];
  globalThis.self = { postMessage: message => messages.push(message) };
  await import('../assets/js/app/analysis/compute/data-worker.js?statistic-free-contract');

  const runWorker = (type, payload, requestId) => {
    globalThis.self.onmessage({ data: { type, payload, requestId } });
    const message = messages.at(-1);
    assert.equal(message.requestId, requestId);
    assert.equal(message.success, true, message.error);
    return message.result;
  };

  // 4,500 cells in the group against 7,469 out of it — an ordinary size for a
  // cell type in a 12,000-cell view. Mann-Whitney U is min(U1, U2), which
  // reaches n1*n2/2 = 16,782,750 here, above the 2^24 boundary where Float32
  // stops holding consecutive integers.
  const inSize = 4500;
  const outSize = 7469;
  const total = inSize + outSize;
  const codes = new Uint16Array(total);
  codes.fill(1, inSize);
  const values = new Float32Array(total);
  for (let index = 0; index < total; index++) {
    values[index] = index < inSize
      ? index % 41
      : (index * 19) % 41;
  }

  runWorker('MARKERS_SET_CONTEXT', {
    codes,
    codeToGroupIndex: Int16Array.from([0, 1]),
    groupCount: 2
  }, 'statistic-free-context');
  const result = runWorker('MARKERS_COMPUTE_GENE', {
    values,
    method: 'wilcox',
    minCells: 2
  }, 'statistic-free-gene');

  // The exact statistic for this fixture, from
  //   scipy.stats.mannwhitneyu(group, rest, alternative='two-sided',
  //                            method='asymptotic', use_continuity=True)
  // is U1 = 16,777,559 and U2 = 16,832,941, so U = min = 16,777,559 — an odd
  // integer above 2^24 that Float32 cannot hold. It used to be stored in one
  // and shipped to the engine, which validated it and threw it away.
  const exactU = 16777559;
  assert.ok(exactU > 2 ** 24);
  assert.notEqual(Math.fround(exactU), exactU);
  assert.equal(Math.fround(exactU), 16777560);

  // The probability is computed from the exact double and is unaffected.
  assertRelative(result.pValues[0], 0.8797590880529592, 1e-12);
  assertRelative(result.pValues[1], 0.8797590880529592, 1e-12);

  // The worker's published contract carries no statistic in any container.
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      'log2FoldChange',
      'meanInGroup',
      'meanOutGroup',
      'nAll',
      'nIn',
      'nOut',
      'pValues',
      'percentInGroup',
      'percentOutGroup'
    ]
  );
  assert.equal(result.nAll, total);
  assert.deepEqual([...result.nIn], [inSize, outSize]);
  assert.deepEqual([...result.nOut], [outSize, inSize]);

  // numpy references for the same Float32 fixture.
  assertRelative(result.meanInGroup[0], 19.965555555555557, 1e-6);
  assertRelative(result.meanOutGroup[0], 19.999330566340877, 1e-6);
  assertRelative(result.log2FoldChange[0], -0.0024372735241243813, 1e-4);
  assertRelative(result.percentInGroup[0], 97.55555555555556, 1e-6);
  assertRelative(result.percentOutGroup[0], 97.56326148078726, 1e-6);

  delete globalThis.self;
});

test('quick differential expression corrects over every gene it examined', async () => {
  // Fifty genes are examined. One separates the pages; the other forty-nine are
  // identical between them, so they carry no effect and are never listed - but
  // they were tested, and they are part of the family.
  const FAMILY_SIZE = 50;
  const separated = { page1: [1, 2, 3, 4, 5, 6], page2: [4, 5, 6, 7, 8, 9] };
  const identical = { page1: [1, 2, 3, 4, 5, 6], page2: [1, 2, 3, 4, 5, 6] };

  const dataLayer = {
    getAvailableVariables: () => Array.from(
      { length: FAMILY_SIZE },
      (_unused, index) => ({ key: `GENE_${index}`, name: `Gene ${index}` })
    ),
    async getDataForPages({ variableKey }) {
      const source = variableKey === 'GENE_0' ? separated : identical;
      return [{ values: source.page1 }, { values: source.page2 }];
    }
  };

  const quick = await computeQuickDifferentialExpression(
    dataLayer,
    'page-a',
    'page-b',
    FAMILY_SIZE
  );

  // The denominator is the family, not the reported subset.
  assert.equal(quick.genesTested, FAMILY_SIZE);
  assert.equal(quick.genesUntestable, 0);
  assert.equal(quick.effectSizeThreshold, 0.2);

  // Only the separated gene clears |Cohen's d| > 0.2, so only it is listed.
  // Reporting is a selection; testing is not.
  assert.deepEqual(quick.results.map(row => row.gene), ['GENE_0']);
  const [row] = quick.results;

  // scipy.stats.ttest_ind([1,2,3,4,5,6], [4,5,6,7,8,9], equal_var=False)
  //   -> statistic=-2.7774602993176547, df=10.0, pvalue=0.019535605462663135
  assertRelative(row.pValue, 0.019535605462663135, 1e-12);

  // scipy.stats.false_discovery_control([0.019535605462663135] + [1.0] * 49,
  //                                     method='bh')[0]
  //   -> 0.9767802731331567
  // Nominal 0.0195 reads as significant at 0.05; the FDR over the fifty genes
  // that were actually examined is 0.977. Those are the two numbers the caller
  // must be able to tell apart.
  assertRelative(row.adjustedPValue, 0.9767802731331567, 1e-12);
  assert.ok(row.pValue < 0.05);
  assert.ok(row.adjustedPValue > 0.9);

  // numpy: pooled sd = 1.8708286933869707, Cohen's d = -1.6035674514745464,
  // log2(3.5 / 6.5) = -0.8930847960834881
  assertRelative(row.effectSize, -1.6035674514745464, 1e-12);
  assertRelative(row.effectSizeCiLow, -2.9043877055194063, 1e-12);
  assertRelative(row.effectSizeCiHigh, -0.3027471974296867, 1e-12);
  assertRelative(row.log2FC, -0.8930847960834881, 1e-12);
  assert.equal(row.mean1, 3.5);
  assert.equal(row.mean2, 6.5);

  // An empty inventory still declares an empty family rather than nothing.
  const empty = await computeQuickDifferentialExpression(
    { getAvailableVariables: () => [], getDataForPages: async () => [] },
    'page-a',
    'page-b',
    FAMILY_SIZE
  );
  assert.deepEqual(empty, {
    genesTested: 0,
    genesUntestable: 0,
    effectSizeThreshold: 0.2,
    results: []
  });
});
