/**
 * The analysis engine's rank and moment kernels were rewritten for speed. Speed
 * is not allowed to change an answer, so every one of them is pinned here against
 * a reference written straight from the definition of the statistic — not against
 * the implementation it replaced, and not against a rounded expectation.
 *
 * `Object.is` is the comparison throughout: these must be the same IEEE-754
 * doubles, not merely close ones.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeRanks,
  mannWhitneyPValue,
  mannWhitneyU,
  sampleMoments,
  selectSorted,
  welchTTest,
  welchTTestFromMoments,
  mean,
  variance
} from '../assets/js/app/analysis/compute/math-utils.js';
import {
  computeCorrelation,
  computeDifferential,
  computeStats
} from '../assets/js/app/analysis/compute/operation-handlers.js';
import {
  kruskalWallis,
  mannWhitneyU as displayedMannWhitneyU,
  tTest
} from '../assets/js/app/analysis/stats/statistical-tests.js';
import { computeStats as numberUtilsComputeStats } from '../assets/js/app/analysis/shared/number-utils.js';

// ---------------------------------------------------------------------------
// Deterministic generators
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Expression-shaped values: zero inflated and quantized to `levels` steps, the
 * shape every prepared export actually has (8-bit quantization, mostly zeros).
 */
function quantizedValues(length, seed, { dropout = 0.7, levels = 256 } = {}) {
  const random = mulberry32(seed);
  const values = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    values[i] = random() < dropout
      ? 0
      : Math.round(random() * (levels - 1)) * (6 / (levels - 1));
  }
  return values;
}

/** Values with essentially no ties, which is what a direct AnnData load gives. */
function continuousValues(length, seed) {
  const random = mulberry32(seed);
  const values = new Float32Array(length);
  for (let i = 0; i < length; i++) values[i] = random() * 10;
  return values;
}

// ---------------------------------------------------------------------------
// References, written from the definition of the statistic
// ---------------------------------------------------------------------------

/**
 * Mid-ranks by definition: sort the pooled values, and give every member of a
 * tie block the mean of the 1-based ranks that block occupies.
 */
function referenceMidRanks(values) {
  const n = values.length;
  const positions = Array.from({ length: n }, (_, index) => index);
  positions.sort((left, right) => {
    const a = values[left];
    const b = values[right];
    if (a === b) return left - right;
    return a < b ? -1 : 1;
  });

  const ranks = new Array(n);
  let start = 0;
  while (start < n) {
    let end = start + 1;
    while (end < n && values[positions[end]] === values[positions[start]]) end++;
    let rankSum = 0;
    for (let k = start; k < end; k++) rankSum += k + 1;
    const averageRank = rankSum / (end - start);
    for (let k = start; k < end; k++) ranks[positions[k]] = averageRank;
    start = end;
  }
  return ranks;
}

/** Mann-Whitney U from the rank-sum definition, using the reference mid-ranks. */
function referenceMannWhitneyU(group1, group2) {
  const n1 = group1.length;
  const n2 = group2.length;
  const pooled = new Array(n1 + n2);
  for (let i = 0; i < n1; i++) pooled[i] = group1[i];
  for (let i = 0; i < n2; i++) pooled[n1 + i] = group2[i];

  const ranks = referenceMidRanks(pooled);
  let rankSum1 = 0;
  for (let i = 0; i < n1; i++) rankSum1 += ranks[i];

  const tieCounts = new Map();
  for (const value of pooled) {
    tieCounts.set(value, (tieCounts.get(value) ?? 0) + 1);
  }
  let tieTerm = 0;
  for (const count of tieCounts.values()) {
    if (count > 1) tieTerm += count ** 3 - count;
  }

  const u1 = rankSum1 - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const statistic = Math.min(u1, u2);
  const { pValue, pValueMethod } = mannWhitneyPValue(n1, n2, statistic, { tieTerm });
  return { statistic, pValue, pValueMethod, u1, u2 };
}

/** Welch moments by definition: sample mean, then sample variance about it. */
function referenceMoments(values) {
  const n = values.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const m = sum / n;
  let sumSquares = 0;
  for (let i = 0; i < n; i++) sumSquares += (values[i] - m) ** 2;
  return { mean: m, variance: sumSquares / (n - 1), n };
}

/** Kruskal-Wallis H by definition, tie-corrected. */
function referenceKruskalH(groups) {
  const pooled = [];
  const owner = [];
  groups.forEach((group, index) => {
    for (const value of group) {
      pooled.push(value);
      owner.push(index);
    }
  });
  const N = pooled.length;
  const ranks = referenceMidRanks(pooled);

  const rankSums = new Array(groups.length).fill(0);
  for (let i = 0; i < N; i++) rankSums[owner[i]] += ranks[i];

  let H = 0;
  for (let index = 0; index < groups.length; index++) {
    if (groups[index].length > 0) H += rankSums[index] ** 2 / groups[index].length;
  }
  H = (12 / (N * (N + 1))) * H - 3 * (N + 1);

  const tieCounts = new Map();
  for (const value of pooled) tieCounts.set(value, (tieCounts.get(value) ?? 0) + 1);
  let tieTerm = 0;
  for (const count of tieCounts.values()) {
    if (count > 1) tieTerm += count ** 3 - count;
  }
  const correction = 1 - tieTerm / (N ** 3 - N);
  if (!(correction > 0)) return null;
  return Math.max(0, H / correction);
}

/** Order statistics by definition: sort a boxed copy and index into it. */
function referenceComputeStats(values) {
  const numeric = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value === 'number' && Number.isFinite(value)) numeric.push(value);
  }
  const n = numeric.length;
  if (n === 0) return null;
  const sorted = [...numeric].sort((a, b) => a - b);
  const sum = numeric.reduce((a, b) => a + b, 0);
  const meanValue = sum / n;
  // `computeStats` squares through `values.map(...)`, whose result container
  // follows the input container: a Float32Array input rounds each squared
  // deviation to single precision before summation, a boxed Array does not.
  // That container-dependent rounding predates this test and is preserved here
  // deliberately, so the reference has to mirror it.
  const squaredDiffs = ArrayBuffer.isView(values)
    ? new Float32Array(n)
    : new Array(n);
  for (let i = 0; i < n; i++) squaredDiffs[i] = Math.pow(numeric[i] - meanValue, 2);
  const varianceValue = squaredDiffs.reduce((a, b) => a + b, 0) / n;
  const q1 = sorted[Math.floor(n * 0.25)];
  const midIndex = Math.floor(n * 0.5);
  const q3 = sorted[Math.floor(n * 0.75)];
  return {
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
    mean: meanValue,
    median: n % 2 === 0 ? (sorted[midIndex - 1] + sorted[midIndex]) / 2 : sorted[midIndex],
    std: Math.sqrt(varianceValue),
    q1,
    q3,
    iqr: q3 - q1,
    sum,
    variance: varianceValue
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('Mann-Whitney U equals the rank-sum definition on both rank strategies', () => {
  // The kernel tabulates distinct values when there are few of them and sorts
  // and merges when there are many. Both are exercised: quantized data stays
  // far under the tabulation bound, and the continuous shapes below blow past
  // it, so a defect confined to one strategy cannot hide.
  let comparisons = 0;
  for (let trial = 0; trial < 900; trial++) {
    const random = mulberry32(trial + 1);
    const n1 = 1 + Math.floor(random() * 80);
    const n2 = 1 + Math.floor(random() * 80);
    const levels = 2 + Math.floor(random() * 12);
    const group1 = quantizedValues(n1, trial * 2 + 7, { dropout: random() * 0.8, levels });
    const group2 = quantizedValues(n2, trial * 2 + 8, { dropout: random() * 0.8, levels });

    const actual = mannWhitneyU(group1, group2);
    const expected = referenceMannWhitneyU(group1, group2);
    for (const key of ['statistic', 'pValue', 'pValueMethod', 'u1', 'u2']) {
      assert.ok(
        Object.is(actual[key], expected[key]),
        `trial ${trial} ${key}: ${actual[key]} !== ${expected[key]}`
      );
    }
    comparisons++;
  }
  assert.equal(comparisons, 900);

  // High-cardinality inputs take the sort-and-merge strategy.
  for (const size of [200, 5000]) {
    const group1 = continuousValues(size, size + 11);
    const group2 = continuousValues(Math.floor(size * 0.6), size + 12);
    const actual = mannWhitneyU(group1, group2);
    const expected = referenceMannWhitneyU(group1, group2);
    for (const key of ['statistic', 'pValue', 'pValueMethod', 'u1', 'u2']) {
      assert.ok(
        Object.is(actual[key], expected[key]),
        `continuous ${size} ${key}: ${actual[key]} !== ${expected[key]}`
      );
    }
  }

  // Realistic expression scale: half a panel's worth of cells per side.
  const large1 = quantizedValues(60_000, 991);
  const large2 = quantizedValues(40_000, 992, { dropout: 0.5 });
  const largeActual = mannWhitneyU(large1, large2);
  const largeExpected = referenceMannWhitneyU(large1, large2);
  for (const key of ['statistic', 'pValue', 'pValueMethod', 'u1', 'u2']) {
    assert.ok(
      Object.is(largeActual[key], largeExpected[key]),
      `large ${key}: ${largeActual[key]} !== ${largeExpected[key]}`
    );
  }
});

test('Mann-Whitney U is container-agnostic: Array and TypedArray agree exactly', () => {
  // `statistical-tests` filters to a boxed Array when a value is non-finite and
  // passes the TypedArray straight through when none is. Both must rank alike.
  for (let trial = 0; trial < 120; trial++) {
    const typed1 = quantizedValues(37 + trial, trial + 41);
    const typed2 = quantizedValues(29 + trial, trial + 42, { dropout: 0.4 });
    const boxed1 = Array.from(typed1);
    const boxed2 = Array.from(typed2);
    const fromTyped = mannWhitneyU(typed1, typed2);
    const fromBoxed = mannWhitneyU(boxed1, boxed2);
    for (const key of ['statistic', 'pValue', 'pValueMethod', 'u1', 'u2']) {
      assert.ok(
        Object.is(fromTyped[key], fromBoxed[key]),
        `trial ${trial} ${key}: ${fromTyped[key]} !== ${fromBoxed[key]}`
      );
    }
  }
});

test('computeRanks equals mid-ranks by definition on both rank strategies', () => {
  for (let trial = 0; trial < 500; trial++) {
    const random = mulberry32(trial + 301);
    const length = 1 + Math.floor(random() * 120);
    const levels = 2 + Math.floor(random() * 10);
    const values = quantizedValues(length, trial + 302, { dropout: random() * 0.9, levels });
    const actual = computeRanks(values);
    const expected = referenceMidRanks(values);
    assert.equal(actual.length, expected.length);
    for (let i = 0; i < length; i++) {
      assert.ok(
        Object.is(actual[i], expected[i]),
        `trial ${trial} rank ${i}: ${actual[i]} !== ${expected[i]}`
      );
    }
  }

  // Over the tabulation bound, so the index-sort strategy answers.
  const continuous = continuousValues(9000, 777);
  const actual = computeRanks(continuous);
  const expected = referenceMidRanks(continuous);
  for (let i = 0; i < continuous.length; i++) {
    assert.ok(Object.is(actual[i], expected[i]), `continuous rank ${i}`);
  }

  assert.deepEqual(computeRanks([]), []);
  assert.deepEqual(computeRanks([5]), [1]);
  assert.deepEqual(computeRanks([2, 2, 2, 2]), [2.5, 2.5, 2.5, 2.5]);
});

test('sample moments equal the two-pass definition and drive Welch unchanged', () => {
  for (let trial = 0; trial < 400; trial++) {
    const random = mulberry32(trial + 601);
    const n1 = 2 + Math.floor(random() * 90);
    const n2 = 2 + Math.floor(random() * 90);
    const group1 = quantizedValues(n1, trial + 602, { dropout: random() * 0.7 });
    const group2 = quantizedValues(n2, trial + 603, { dropout: random() * 0.7 });

    const momentsA = sampleMoments(group1);
    const referenceA = referenceMoments(group1);
    assert.ok(Object.is(momentsA.mean, referenceA.mean), `trial ${trial} mean`);
    assert.ok(Object.is(momentsA.variance, referenceA.variance), `trial ${trial} variance`);
    // The standalone helpers must not have drifted from the fused pair.
    assert.ok(Object.is(momentsA.mean, mean(group1)), `trial ${trial} mean vs mean()`);
    assert.ok(
      Object.is(momentsA.variance, variance(group1, 1)),
      `trial ${trial} variance vs variance()`
    );

    const momentsB = sampleMoments(group2);
    const expected = welchTTestFromMoments(
      referenceA.mean, referenceA.variance, n1,
      referenceMoments(group2).mean, referenceMoments(group2).variance, n2
    );
    const actual = welchTTest(group1, group2);
    for (const key of ['statistic', 'pValue', 'df']) {
      assert.ok(
        Object.is(actual[key], expected[key]),
        `trial ${trial} welch ${key}: ${actual[key]} !== ${expected[key]}`
      );
    }
    assert.ok(Object.is(momentsB.mean, referenceMoments(group2).mean));
  }

  assert.ok(Number.isNaN(sampleMoments([]).mean));
  assert.ok(Number.isNaN(sampleMoments([]).variance));
  assert.equal(sampleMoments([4]).mean, 4);
  assert.ok(Number.isNaN(sampleMoments([4]).variance));
});

test("Welch's t-test wrapper reports the same statistic, p and Cohen's d", () => {
  for (let trial = 0; trial < 200; trial++) {
    const group1 = quantizedValues(20 + trial, trial + 811);
    const group2 = quantizedValues(15 + trial, trial + 812, { dropout: 0.4 });
    const displayed = tTest(group1, group2);
    const referenceA = referenceMoments(group1);
    const referenceB = referenceMoments(group2);
    const core = welchTTestFromMoments(
      referenceA.mean, referenceA.variance, group1.length,
      referenceB.mean, referenceB.variance, group2.length
    );
    assert.ok(Object.is(displayed.statistic, core.statistic), `trial ${trial} t`);
    assert.ok(Object.is(displayed.pValue, core.pValue), `trial ${trial} p`);
    assert.ok(Object.is(displayed.df, core.df), `trial ${trial} df`);

    const n1 = group1.length;
    const n2 = group2.length;
    const pooledStd = Math.sqrt(
      ((n1 - 1) * referenceA.variance + (n2 - 1) * referenceB.variance) / (n1 + n2 - 2)
    );
    const expectedD = pooledStd > 0
      ? (referenceA.mean - referenceB.mean) / pooledStd
      : (referenceA.mean === referenceB.mean ? 0 : null);
    assert.ok(Object.is(displayed.effectSize, expectedD), `trial ${trial} cohen d`);
  }
});

test('Kruskal-Wallis H equals the tie-corrected definition', () => {
  for (let trial = 0; trial < 500; trial++) {
    const random = mulberry32(trial + 1201);
    const groupCount = 2 + Math.floor(random() * 3);
    const levels = 2 + Math.floor(random() * 8);
    const groups = [];
    for (let index = 0; index < groupCount; index++) {
      groups.push(
        quantizedValues(1 + Math.floor(random() * 50), trial * 11 + index + 3, {
          dropout: random() * 0.8,
          levels
        })
      );
    }
    const actual = kruskalWallis(groups);
    const expected = referenceKruskalH(groups.map(group => Array.from(group)));
    if (expected === null) {
      assert.ok(Number.isNaN(actual.statistic), `trial ${trial} fully tied`);
    } else {
      assert.ok(
        Object.is(actual.statistic, expected),
        `trial ${trial} H: ${actual.statistic} !== ${expected}`
      );
    }
  }
});

test('selectSorted returns the element at each requested sorted position', () => {
  // Exercised in both strategies: quantized inputs stay under the tabulation
  // bound, continuous inputs blow past it.
  for (let trial = 0; trial < 300; trial++) {
    const random = mulberry32(trial + 2501);
    const length = 1 + Math.floor(random() * 3000);
    const values = random() < 0.5
      ? quantizedValues(length, trial + 2502, { dropout: random() * 0.9 })
      : continuousValues(length, trial + 2503);
    const sorted = [...values].sort((a, b) => a - b);
    const positions = [
      0,
      length - 1,
      Math.floor(length * 0.25),
      Math.floor(length * 0.5),
      Math.floor(length * 0.75),
      Math.max(0, Math.floor(length * 0.5) - 1)
    ];
    const selected = selectSorted(values, positions);
    assert.equal(selected.length, positions.length);
    for (let i = 0; i < positions.length; i++) {
      assert.ok(
        Object.is(selected[i], sorted[positions[i]]),
        `trial ${trial} position ${positions[i]}: ${selected[i]} !== ${sorted[positions[i]]}`
      );
    }
  }

  assert.deepEqual(selectSorted([3, 1, 2], []), []);
  assert.deepEqual(selectSorted([3, 1, 2], [0, 1, 2]), [1, 2, 3]);
  // Positions may be requested in any order, and repeated.
  assert.deepEqual(selectSorted([9, 4, 7, 4], [3, 0, 0]), [9, 4, 4]);
});

test('computeStats order statistics equal the boxed-sort definition', () => {
  for (let trial = 0; trial < 300; trial++) {
    const random = mulberry32(trial + 1501);
    const length = 1 + Math.floor(random() * 2000);
    const values = quantizedValues(length, trial + 1502, { dropout: random() * 0.9 });
    const actual = computeStats({ values });
    const expected = referenceComputeStats(values);
    for (const key of Object.keys(expected)) {
      assert.ok(
        Object.is(actual[key], expected[key]),
        `trial ${trial} ${key}: ${actual[key]} !== ${expected[key]}`
      );
    }
  }

  // Continuous inputs pass the tabulation bound and take the sorting strategy.
  for (const length of [500, 9000]) {
    const values = continuousValues(length, length + 1811);
    const actual = computeStats({ values });
    const expected = referenceComputeStats(values);
    for (const key of Object.keys(expected)) {
      assert.ok(
        Object.is(actual[key], expected[key]),
        `continuous ${length} ${key}: ${actual[key]} !== ${expected[key]}`
      );
    }
  }

  // A boxed Array input still walks the comparator path and must agree.
  const boxed = Array.from(quantizedValues(500, 1599));
  const boxedActual = computeStats({ values: boxed });
  const boxedExpected = referenceComputeStats(boxed);
  for (const key of Object.keys(boxedExpected)) {
    assert.ok(Object.is(boxedActual[key], boxedExpected[key]), `boxed ${key}`);
  }
});

test('number-utils computeStats median equals the boxed-sort definition', () => {
  for (let trial = 0; trial < 200; trial++) {
    const random = mulberry32(trial + 1701);
    const length = 1 + Math.floor(random() * 1500);
    const values = quantizedValues(length, trial + 1702, { dropout: random() * 0.9 });
    const boxed = [...values].sort((a, b) => a - b);
    const middle = Math.floor(length / 2);
    const expectedMedian = length % 2 === 0
      ? (boxed[middle - 1] + boxed[middle]) / 2
      : boxed[middle];
    const actual = numberUtilsComputeStats(values);
    assert.ok(
      Object.is(actual.median, expectedMedian),
      `trial ${trial} median: ${actual.median} !== ${expectedMedian}`
    );
  }

  for (const length of [501, 4000, 9001]) {
    const values = continuousValues(length, length + 1791);
    const boxed = [...values].sort((a, b) => a - b);
    const middle = Math.floor(length / 2);
    const expectedMedian = length % 2 === 0
      ? (boxed[middle - 1] + boxed[middle]) / 2
      : boxed[middle];
    assert.ok(
      Object.is(numberUtilsComputeStats(values).median, expectedMedian),
      `continuous ${length} median`
    );
  }
});

test('differential expression reports the same numbers through the operation handler', () => {
  for (let trial = 0; trial < 200; trial++) {
    const random = mulberry32(trial + 1901);
    const groupAValues = quantizedValues(2 + Math.floor(random() * 200), trial + 1902);
    const groupBValues = quantizedValues(2 + Math.floor(random() * 200), trial + 1903, {
      dropout: 0.5
    });
    for (const method of ['wilcox', 'ttest']) {
      const result = computeDifferential({ groupAValues, groupBValues, method });
      const referenceA = referenceMoments(groupAValues);
      const referenceB = referenceMoments(groupBValues);
      assert.ok(Object.is(result.meanA, referenceA.mean), `trial ${trial} meanA`);
      assert.ok(Object.is(result.meanB, referenceB.mean), `trial ${trial} meanB`);
      assert.ok(
        Object.is(
          result.log2FoldChange,
          Math.log2((referenceA.mean + 0.01) / (referenceB.mean + 0.01))
        ),
        `trial ${trial} log2FC`
      );
      const expected = method === 'wilcox'
        ? referenceMannWhitneyU(groupAValues, groupBValues)
        : welchTTestFromMoments(
            referenceA.mean, referenceA.variance, groupAValues.length,
            referenceB.mean, referenceB.variance, groupBValues.length
          );
      assert.ok(Object.is(result.pValue, expected.pValue), `trial ${trial} ${method} p`);
      assert.ok(
        Object.is(result.statistic, expected.statistic),
        `trial ${trial} ${method} statistic`
      );
      assert.equal(result.nA, groupAValues.length);
      assert.equal(result.nB, groupBValues.length);
    }
  }
});

test('Spearman correlation still ranks through the shared kernel', () => {
  for (let trial = 0; trial < 120; trial++) {
    const xValues = quantizedValues(300 + trial, trial + 2101);
    const yValues = quantizedValues(300 + trial, trial + 2102, { dropout: 0.4 });
    const result = computeCorrelation({ xValues, yValues, method: 'spearman' });

    const xRanks = referenceMidRanks(xValues);
    const yRanks = referenceMidRanks(yValues);
    const n = xRanks.length;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      sx += xRanks[i];
      sy += yRanks[i];
      sxx += xRanks[i] * xRanks[i];
      syy += yRanks[i] * yRanks[i];
      sxy += xRanks[i] * yRanks[i];
    }
    const numerator = n * sxy - sx * sy;
    const denominator = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    const expected = denominator === 0 ? 0 : numerator / denominator;
    assert.ok(Object.is(result.r, expected), `trial ${trial} r: ${result.r} !== ${expected}`);
  }
});

test('the displayed Mann-Whitney wrapper still filters non-finite values', () => {
  // The kernel is documented as accepting finite values only, and the wrapper is
  // what guarantees that. If the wrapper ever stopped filtering, this changes.
  const withNaN = displayedMannWhitneyU([0, 1, NaN], [2, 3]);
  const withoutNaN = displayedMannWhitneyU([0, 1], [2, 3]);
  assert.ok(Object.is(withNaN.pValue, withoutNaN.pValue));
  assert.ok(Object.is(withNaN.statistic, withoutNaN.statistic));

  const withInfinity = displayedMannWhitneyU([0, 1, Infinity], [2, 3]);
  assert.ok(Object.is(withInfinity.pValue, withoutNaN.pValue));
});

test('numeric array validation still rejects every non-numeric container', () => {
  // TypedArray inputs no longer walk every element, so the rejections that scan
  // used to provide have to be proven to survive.
  const holed = new Array(4);
  holed[0] = 1;
  holed[1] = 2;
  holed[3] = 4;
  assert.throws(() => tTest(holed, [1, 2, 3, 4]), /numeric value at every index/);
  assert.throws(() => tTest([1, 2, '3', 4], [1, 2, 3, 4]), /numeric value at every index/);
  assert.throws(
    () => tTest(new BigInt64Array([1n, 2n, 3n]), [1, 2, 3]),
    /numeric value at every index/
  );
  assert.throws(
    () => tTest(new BigUint64Array([1n, 2n, 3n]), [1, 2, 3]),
    /numeric value at every index/
  );
  assert.throws(() => tTest(new DataView(new ArrayBuffer(8)), [1, 2, 3]), /Array or TypedArray/);
  assert.throws(() => tTest({ length: 3 }, [1, 2, 3]), /Array or TypedArray/);

  // And the accepted containers stay accepted.
  assert.equal(typeof tTest(new Float32Array([1, 2, 3]), [4, 5, 6]).pValue, 'number');
  assert.equal(typeof tTest(new Int16Array([1, 2, 3]), [4, 5, 6]).pValue, 'number');
  assert.equal(typeof tTest([1, 2, 3], [4, 5, 6]).pValue, 'number');
});
