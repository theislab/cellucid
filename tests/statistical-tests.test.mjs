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
import { benjaminiHochberg as markerBenjaminiHochberg } from '../assets/js/app/analysis/genes-panel/marker-discovery-engine.js';
import { computeQuickDifferentialExpression } from '../assets/js/app/analysis/stats/quick-stats.js';
import {
  applyMultipleTestingCorrection,
  benjaminiHochberg,
  bonferroniCorrection,
  chiSquaredTest,
  confidenceInterval,
  computeFoldChange,
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

  const [result] = await computeQuickDifferentialExpression(dataLayer, 'page-a', 'page-b', 1);
  assertClose(result.pValue, 0.10557280900008414);
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
  assert.ok([...lowSpread.statistics].every(Number.isFinite));

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

  const adjusted = markerBenjaminiHochberg(
    new Float64Array([1e-50, 1e-48, 0.5])
  );
  assert.ok(adjusted instanceof Float64Array);
  assert.ok(adjusted[0] > 0);
  assert.ok(adjusted[1] > adjusted[0]);

  delete globalThis.self;
});
