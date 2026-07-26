/**
 * Statistical Tests Module for Page Analysis
 *
 * Provides statistical comparison tests for categorical and continuous data:
 * - Categorical: Chi-squared test, Fisher's exact test (2x2)
 * - Continuous: t-test, Mann-Whitney U, ANOVA, Kruskal-Wallis
 *
 * All tests return p-values, test statistics, and effect sizes where applicable.
 */

import { getStatRegistry } from '../core/plugin-contract.js';

// Import mathematical functions from centralized math-utils (DRY principle)
import {
  mean,
  variance,
  std,
  chiSquaredPValue,
  fDistributionPValue,
  gammaLn,
  computeRanks,
  mannWhitneyU as computeMannWhitneyU,
  welchTTest as computeWelchTTest
} from '../compute/math-utils.js';
import { isFiniteNumber } from '../shared/number-utils.js';

/**
 * @typedef {Object} StatisticalResult
 * @property {string} testName - Name of the statistical test
 * @property {number} statistic - Test statistic value
 * @property {number} pValue - p-value
 * @property {string} significance - Significance level (* p<0.05, ** p<0.01, *** p<0.001)
 * @property {number|null} effectSize - Effect size (if applicable)
 * @property {string|null} effectSizeType - Type of effect size (e.g., "Cohen's d", "Cramér's V")
 * @property {string} [pValueMethod] - Inference method used for the p-value
 * @property {string} interpretation - Human-readable interpretation
 */

// ============================================================================
// Helper Functions
// ============================================================================


/**
 * Get significance stars from p-value
 */
function getSignificance(pValue) {
  if (!isFiniteNumber(pValue)) return 'N/A';
  if (pValue < 0.001) return '***';
  if (pValue < 0.01) return '**';
  if (pValue < 0.05) return '*';
  return 'ns';
}

/**
 * Format p-value for display
 */
function formatPValue(p) {
  requireProbability(p, 'Displayed p-value');
  if (p < 0.0001) return '< 0.0001';
  if (p < 0.001) return p.toExponential(2);
  return p.toFixed(4);
}

function requireRecord(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function requireProbability(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be finite and between 0 and 1`);
  }
  return value;
}

function requireAlpha(alpha) {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new RangeError('Statistical alpha must be finite and strictly between 0 and 1');
  }
  return alpha;
}

function requireNumericArrayLike(values, label) {
  const supported = Array.isArray(values) || (
    ArrayBuffer.isView(values) && !(values instanceof DataView)
  );
  if (!supported || !Number.isSafeInteger(values.length)) {
    throw new TypeError(`${label} must be an Array or TypedArray`);
  }
  for (let index = 0; index < values.length; index++) {
    if (
      (Array.isArray(values) && !Object.hasOwn(values, index))
      || typeof values[index] !== 'number'
    ) {
      throw new TypeError(`${label} must contain a numeric value at every index`);
    }
  }
  return values;
}

/**
 * Return the original ArrayLike when every value is finite, otherwise a
 * finite-only Array. Avoiding an unconditional copy matters for large pages.
 */
function finiteValues(values, label = 'Statistical values') {
  requireNumericArrayLike(values, label);

  let filtered = null;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (isFiniteNumber(value)) {
      if (filtered) filtered.push(value);
    } else if (!filtered) {
      filtered = [];
      for (let prior = 0; prior < index; prior++) filtered.push(values[prior]);
    }
  }
  return filtered ?? values;
}

const CATEGORY_TYPE_ORDER = new Map([
  ['boolean', 0],
  ['number', 1],
  ['string', 2]
]);

function requireCategoricalValue(value, groupIndex = null, valueIndex = null) {
  const type = typeof value;
  if (
    (type !== 'string' && type !== 'number' && type !== 'boolean')
    || (type === 'number' && !Number.isFinite(value))
  ) {
    const location = groupIndex === null
      ? ''
      : ` at group ${groupIndex + 1}, value ${valueIndex + 1}`;
    throw new TypeError(
      `Categorical statistical value${location} must be a string, ` +
      'finite number, or boolean'
    );
  }
  return type;
}

function categoryText(value) {
  requireCategoricalValue(value);
  return String(value);
}

function compareCategoryValues(left, right) {
  const leftType = requireCategoricalValue(left);
  const rightType = requireCategoricalValue(right);
  const typeDifference =
    CATEGORY_TYPE_ORDER.get(leftType) -
    CATEGORY_TYPE_ORDER.get(rightType);
  if (typeDifference !== 0) return typeDifference;

  if (leftType === 'boolean') return Number(left) - Number(right);
  if (leftType === 'number') {
    return left - right;
  }

  return left < right ? -1 : left > right ? 1 : 0;
}

// ============================================================================
// Statistical Tests for Categorical Data
// ============================================================================

function buildCategoricalTable(pageData) {
  if (!Array.isArray(pageData)) {
    throw new TypeError('Categorical statistical page data must be an array');
  }
  for (let groupIndex = 0; groupIndex < pageData.length; groupIndex++) {
    const page = pageData[groupIndex];
    if (
      page === null
      || typeof page !== 'object'
      || Array.isArray(page)
      || Object.getPrototypeOf(page) !== Object.prototype
      || typeof page.pageName !== 'string'
      || page.pageName.length === 0
      || page.pageName !== page.pageName.trim()
      || (
        !Array.isArray(page.values)
        && !(
          ArrayBuffer.isView(page.values)
          && !(page.values instanceof DataView)
        )
      )
    ) {
      throw new TypeError(
        `Categorical statistical group ${groupIndex + 1} requires a trimmed ` +
        'pageName and array-like values'
      );
    }
    for (let valueIndex = 0; valueIndex < page.values.length; valueIndex++) {
      requireCategoricalValue(
        page.values[valueIndex],
        groupIndex,
        valueIndex
      );
    }
  }

  const nonEmptyPageData = pageData.filter(pd => pd.values.length > 0);
  const categories = new Set();
  for (const pd of nonEmptyPageData) {
    for (const value of pd.values) categories.add(value);
  }
  const categoryValues = Array.from(categories).sort(compareCategoryValues);
  const rowLabels = nonEmptyPageData.map(pd => pd.pageName);

  const observed = nonEmptyPageData.map(pd => {
    const counts = new Map(categoryValues.map(category => [category, 0]));
    for (const value of pd.values) {
      const currentCount = counts.get(value);
      if (!Number.isSafeInteger(currentCount) || currentCount < 0) {
        throw new Error('Categorical count map lost category ownership');
      }
      counts.set(value, currentCount + 1);
    }
    return categoryValues.map(category => counts.get(category));
  });

  const rowTotals = observed.map(row => row.reduce((sum, count) => sum + count, 0));
  const colTotals = categoryValues.map(
    (_, column) => observed.reduce((sum, row) => sum + row[column], 0)
  );
  const grandTotal = rowTotals.reduce((sum, count) => sum + count, 0);

  return { categoryValues, rowLabels, observed, rowTotals, colTotals, grandTotal };
}

function invalidCategoricalResult(testName, interpretation) {
  return {
    testName,
    statistic: NaN,
    pValue: NaN,
    significance: 'N/A',
    effectSize: null,
    effectSizeType: null,
    interpretation
  };
}

function hasExpectedCountBelow(table, minimum) {
  const { observed, rowTotals, colTotals, grandTotal } = table;
  if (grandTotal === 0) return false;

  for (let row = 0; row < observed.length; row++) {
    for (let column = 0; column < colTotals.length; column++) {
      const expected = (rowTotals[row] * colTotals[column]) / grandTotal;
      if (expected < minimum) return true;
    }
  }
  return false;
}

function chiSquaredTestFromTable(table) {
  const { categoryValues, observed, rowTotals, colTotals, grandTotal } = table;
  if (grandTotal === 0) {
    return invalidCategoricalResult('Chi-squared test', 'No data available');
  }
  if (observed.length < 2) {
    return invalidCategoricalResult(
      'Chi-squared test',
      'Need at least 2 non-empty groups for comparison'
    );
  }
  if (categoryValues.length < 2) {
    return invalidCategoricalResult(
      'Chi-squared test',
      'Need at least 2 observed categories for comparison'
    );
  }
  if (hasExpectedCountBelow(table, 5)) {
    return invalidCategoricalResult(
      'Chi-squared test',
      'Pearson chi-squared inference is unavailable because an expected count ' +
        'is below 5; use an exact test or combine sparse categories'
    );
  }

  let chiSq = 0;
  for (let row = 0; row < observed.length; row++) {
    for (let column = 0; column < categoryValues.length; column++) {
      const expected = (rowTotals[row] * colTotals[column]) / grandTotal;
      if (expected > 0) {
        chiSq += (observed[row][column] - expected) ** 2 / expected;
      }
    }
  }

  const df = (observed.length - 1) * (categoryValues.length - 1);
  const pValue = chiSquaredPValue(chiSq, df);

  const k = Math.min(observed.length, categoryValues.length);
  const cramersV = k > 1
    ? Math.sqrt(chiSq / (grandTotal * (k - 1)))
    : 0;

  let effectInterpretation = '';
  if (cramersV < 0.1) effectInterpretation = 'negligible';
  else if (cramersV < 0.2) effectInterpretation = 'small';
  else if (cramersV < 0.4) effectInterpretation = 'medium';
  else effectInterpretation = 'large';

  const significance = getSignificance(pValue);
  return {
    testName: 'Chi-squared test',
    statistic: chiSq,
    pValue,
    significance,
    effectSize: cramersV,
    effectSizeType: "Cramér's V",
    df,
    interpretation: pValue < 0.05
      ? `Significant difference in distributions (${effectInterpretation} effect)`
      : 'No significant difference in distributions'
  };
}

/**
 * Chi-squared test for independence
 * Tests whether categorical distributions differ across groups
 * @param {Object[]} pageData - Array of page data with categorical values
 * @returns {StatisticalResult}
 */
export function chiSquaredTest(pageData) {
  if (!Array.isArray(pageData)) {
    throw new TypeError('Chi-squared page data must be an array');
  }
  if (pageData.length < 2) {
    return invalidCategoricalResult(
      'Chi-squared test',
      'Need at least 2 groups for comparison'
    );
  }
  return chiSquaredTestFromTable(buildCategoricalTable(pageData));
}

function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return gammaLn(n + 1) - gammaLn(k + 1) - gammaLn(n - k + 1);
}

function fisherExactTwoSided(observed) {
  const [[a, b], [c, d]] = observed;
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const total = row1 + row2;
  const denominator = logChoose(total, col1);
  const logProbability = value => (
    logChoose(row1, value) +
    logChoose(row2, col1 - value) -
    denominator
  );

  const observedLogProbability = logProbability(a);
  const minA = Math.max(0, col1 - row2);
  const maxA = Math.min(row1, col1);
  const included = [];
  let maxLogProbability = -Infinity;

  for (let value = minA; value <= maxA; value++) {
    const logP = logProbability(value);
    if (logP <= observedLogProbability + 1e-12) {
      included.push(logP);
      if (logP > maxLogProbability) maxLogProbability = logP;
    }
  }

  const scaledSum = included.reduce(
    (sum, logP) => sum + Math.exp(logP - maxLogProbability),
    0
  );
  return Math.min(1, Math.exp(maxLogProbability) * scaledSum);
}

function fisherExactTestFromTable(table) {
  const { categoryValues, rowLabels, observed, grandTotal } = table;
  if (grandTotal === 0) {
    return invalidCategoricalResult("Fisher's exact test", 'No data available');
  }
  if (observed.length !== 2 || categoryValues.length !== 2) {
    return invalidCategoricalResult(
      "Fisher's exact test",
      "Fisher's exact test requires exactly 2 groups and 2 categories"
    );
  }

  const [[a, b], [c, d]] = observed;
  const crossProducts = { numerator: a * d, denominator: b * c };
  const oddsRatio = crossProducts.denominator > 0
    ? crossProducts.numerator / crossProducts.denominator
    : (crossProducts.numerator > 0 ? Infinity : NaN);
  const pValue = fisherExactTwoSided(observed);
  const significance = getSignificance(pValue);
  const oddsRatioContrast = `${rowLabels[0]} vs ${rowLabels[1]}; ` +
    `${categoryText(categoryValues[0])} vs ${categoryText(categoryValues[1])}`;

  return {
    testName: "Fisher's exact test",
    statistic: oddsRatio,
    pValue,
    significance,
    effectSize: Number.isNaN(oddsRatio) ? null : oddsRatio,
    effectSizeType: `sample OR (${oddsRatioContrast})`,
    pValueMethod: 'Exact (two-sided)',
    interpretation: pValue < 0.05
      ? 'Significant association between group and category'
      : 'No significant association between group and category'
  };
}

/**
 * Fisher's exact test for a 2x2 categorical table.
 *
 * @param {Object[]} pageData - Two page-data objects with categorical values
 * @returns {StatisticalResult}
 */
export function fisherExactTest(pageData) {
  if (!Array.isArray(pageData)) {
    throw new TypeError("Fisher's exact page data must be an array");
  }
  if (pageData.length < 2) {
    return invalidCategoricalResult(
      "Fisher's exact test",
      'Need at least 2 groups for comparison'
    );
  }
  return fisherExactTestFromTable(buildCategoricalTable(pageData));
}

function shouldUseFisherExact(table) {
  const { categoryValues, observed, grandTotal } = table;
  if (observed.length !== 2 || categoryValues.length !== 2 || grandTotal === 0) {
    return false;
  }
  return hasExpectedCountBelow(table, 5);
}

// ============================================================================
// Statistical Tests for Continuous Data
// ============================================================================

/**
 * Independent samples t-test
 * Compares means of two groups
 * @param {number[]} group1 - First group values
 * @param {number[]} group2 - Second group values
 * @returns {StatisticalResult}
 */
export function tTest(group1, group2) {
  const values1 = finiteValues(group1);
  const values2 = finiteValues(group2);
  const n1 = values1.length;
  const n2 = values2.length;

  if (n1 < 2 || n2 < 2) {
    return {
      testName: "Welch's t-test",
      statistic: NaN,
      pValue: NaN,
      significance: 'N/A',
      effectSize: null,
      effectSizeType: null,
      interpretation: 'Need at least 2 samples in each group'
    };
  }

  const m1 = mean(values1);
  const m2 = mean(values2);
  const v1 = variance(values1, 1);
  const v2 = variance(values2, 1);

  const {
    statistic: t,
    pValue,
    df
  } = computeWelchTTest(values1, values2);

  if (!isFiniteNumber(pValue)) {
    return {
      testName: "Welch's t-test",
      statistic: t,
      pValue,
      significance: 'N/A',
      effectSize: null,
      effectSizeType: null,
      df,
      interpretation: 'Welch inference is undefined because both groups are constant'
    };
  }

  // Effect size: Cohen's d
  const pooledStd = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
  const cohensD = pooledStd > 0
    ? (m1 - m2) / pooledStd
    : (m1 === m2 ? 0 : null);

  // Interpretation
  let effectInterpretation = '';
  if (cohensD === null) {
    effectInterpretation = 'effect size undefined because within-group variance is zero';
  } else {
    const absD = Math.abs(cohensD);
    if (absD < 0.2) effectInterpretation = 'negligible effect';
    else if (absD < 0.5) effectInterpretation = 'small effect';
    else if (absD < 0.8) effectInterpretation = 'medium effect';
    else effectInterpretation = 'large effect';
  }

  const significance = getSignificance(pValue);

  return {
    testName: "Welch's t-test",
    statistic: t,
    pValue: pValue,
    significance: significance,
    effectSize: cohensD,
    effectSizeType: "Cohen's d",
    df: df,
    interpretation: pValue < 0.05
      ? `Significant difference between means (${effectInterpretation})`
      : `No significant difference between means`
  };
}

/**
 * Mann-Whitney U test (non-parametric alternative to t-test)
 * @param {number[]} group1 - First group values
 * @param {number[]} group2 - Second group values
 * @returns {StatisticalResult}
 */
export function mannWhitneyU(group1, group2) {
  const values1 = finiteValues(group1);
  const values2 = finiteValues(group2);
  const n1 = values1.length;
  const n2 = values2.length;

  if (n1 < 1 || n2 < 1) {
    return {
      testName: 'Mann-Whitney U',
      statistic: NaN,
      pValue: NaN,
      significance: 'N/A',
      effectSize: null,
      effectSizeType: null,
      interpretation: 'Need at least 1 sample in each group'
    };
  }

  const {
    statistic: U,
    pValue,
    pValueMethod,
    u1
  } = computeMannWhitneyU(values1, values2);

  if (!isFiniteNumber(pValue)) {
    return {
      testName: 'Mann-Whitney U',
      statistic: U,
      pValue,
      significance: 'N/A',
      effectSize: null,
      effectSizeType: null,
      pValueMethod: 'Asymptotic (tie/continuity corrected)',
      interpretation: 'Mann-Whitney inference is undefined because all values are tied'
    };
  }

  // Effect size: rank-biserial correlation
  const rbc = (2 * u1) / (n1 * n2) - 1;

  // Interpretation
  let effectInterpretation = '';
  const absR = Math.abs(rbc);
  if (absR < 0.1) effectInterpretation = 'negligible';
  else if (absR < 0.3) effectInterpretation = 'small';
  else if (absR < 0.5) effectInterpretation = 'medium';
  else effectInterpretation = 'large';

  const significance = getSignificance(pValue);

  return {
    testName: 'Mann-Whitney U',
    statistic: U,
    pValue: pValue,
    significance: significance,
    effectSize: rbc,
    effectSizeType: 'rank-biserial r (group 1 vs 2)',
    pValueMethod: pValueMethod === 'exact'
      ? 'Exact'
      : 'Asymptotic (tie/continuity corrected)',
    interpretation: pValue < 0.05
      ? `Significant difference in distributions (${effectInterpretation} effect)`
      : `No significant difference in distributions`
  };
}

/**
 * One-way ANOVA
 * Compares means across multiple groups
 * @param {number[][]} groups - Array of group value arrays
 * @returns {StatisticalResult}
 */
export function oneWayANOVA(groups) {
  if (!Array.isArray(groups)) {
    throw new TypeError('One-way ANOVA groups must be an array');
  }
  const k = groups.length;

  if (k < 2) {
    return {
      testName: 'One-way ANOVA',
      statistic: NaN,
      pValue: NaN,
      significance: 'N/A',
      effectSize: null,
      effectSizeType: null,
      interpretation: 'Need at least 2 groups'
    };
  }

  // Normalize direct API callers as well as the UI orchestrator.
  const validGroups = groups
    .map((group, index) => finiteValues(group, `ANOVA group ${index + 1}`))
    .filter(group => group.length > 0);
  if (validGroups.length < 2) {
    return {
      testName: 'One-way ANOVA',
      statistic: NaN,
      pValue: NaN,
      significance: 'N/A',
      effectSize: null,
      effectSizeType: null,
      interpretation: 'Need at least 2 non-empty groups'
    };
  }

  // Calculate group means and sizes
  const groupMeans = validGroups.map(g => mean(g));
  const groupSizes = validGroups.map(g => g.length);
  const N = groupSizes.reduce((a, b) => a + b, 0);
  const firstValue = validGroups[0][0];
  let allValuesIdentical = true;
  for (const group of validGroups) {
    for (const value of group) {
      if (value !== firstValue) {
        allValuesIdentical = false;
        break;
      }
    }
    if (!allValuesIdentical) break;
  }

  // Grand mean (nested iteration keeps Array and TypedArray inputs equivalent)
  let grandSum = 0;
  for (const group of validGroups) {
    for (const value of group) grandSum += value;
  }
  const grandMean = grandSum / N;

  // Sum of squares between groups (SSB)
  let SSB = 0;
  for (let i = 0; i < validGroups.length; i++) {
    SSB += groupSizes[i] * Math.pow(groupMeans[i] - grandMean, 2);
  }

  // Sum of squares within groups (SSW)
  let SSW = 0;
  for (let i = 0; i < validGroups.length; i++) {
    for (const x of validGroups[i]) {
      SSW += Math.pow(x - groupMeans[i], 2);
    }
  }

  // Degrees of freedom
  const dfB = validGroups.length - 1;
  const dfW = N - validGroups.length;

  if (dfW <= 0) {
    return {
      testName: 'One-way ANOVA',
      statistic: NaN,
      pValue: NaN,
      significance: 'N/A',
      effectSize: null,
      effectSizeType: null,
      interpretation: 'Insufficient degrees of freedom'
    };
  }

  // Mean squares
  const MSB = SSB / dfB;
  const MSW = SSW / dfW;

  if (allValuesIdentical || (MSW === 0 && MSB === 0)) {
    return {
      testName: 'One-way ANOVA',
      statistic: NaN,
      pValue: NaN,
      significance: 'N/A',
      effectSize: null,
      effectSizeType: null,
      df: [dfB, dfW],
      interpretation: 'ANOVA is undefined because all groups have identical constant values'
    };
  }

  // F statistic
  const F = MSW > 0 ? MSB / MSW : Infinity;

  // p-value
  const pValue = fDistributionPValue(F, dfB, dfW);

  // Effect size: eta-squared
  const SST = SSB + SSW;
  const etaSquared = SST > 0 ? SSB / SST : 0;

  // Interpretation
  let effectInterpretation = '';
  if (etaSquared < 0.01) effectInterpretation = 'negligible';
  else if (etaSquared < 0.06) effectInterpretation = 'small';
  else if (etaSquared < 0.14) effectInterpretation = 'medium';
  else effectInterpretation = 'large';

  const significance = getSignificance(pValue);

  return {
    testName: 'One-way ANOVA',
    statistic: F,
    pValue: pValue,
    significance: significance,
    effectSize: etaSquared,
    effectSizeType: 'η²',
    df: [dfB, dfW],
    interpretation: pValue < 0.05
      ? `Significant difference among group means (${effectInterpretation} effect)`
      : `No significant difference among group means`
  };
}

/**
 * Kruskal-Wallis H test (non-parametric alternative to ANOVA)
 * @param {number[][]} groups - Array of group value arrays
 * @returns {StatisticalResult}
 */
export function kruskalWallis(groups) {
  if (!Array.isArray(groups)) {
    throw new TypeError('Kruskal-Wallis groups must be an array');
  }
  const k = groups.length;

  if (k < 2) {
    return {
      testName: 'Kruskal-Wallis H',
      statistic: NaN,
      pValue: NaN,
      significance: 'N/A',
      effectSize: null,
      effectSizeType: null,
      interpretation: 'Need at least 2 groups'
    };
  }

  // Normalize direct API callers as well as the UI orchestrator.
  const validGroups = groups
    .map((group, index) => finiteValues(group, `Kruskal-Wallis group ${index + 1}`))
    .filter(group => group.length > 0);
  if (validGroups.length < 2) {
    return {
      testName: 'Kruskal-Wallis H',
      statistic: NaN,
      pValue: NaN,
      significance: 'N/A',
      effectSize: null,
      effectSizeType: null,
      interpretation: 'Need at least 2 non-empty groups'
    };
  }

  // Combine all values with group labels
  const combined = [];
  for (let i = 0; i < validGroups.length; i++) {
    for (const v of validGroups[i]) {
      combined.push({ v, group: i });
    }
  }

  const N = combined.length;
  const values = combined.map(x => x.v);
  const ranks = computeRanks(values);

  // Calculate rank sums for each group
  const rankSums = new Array(validGroups.length).fill(0);
  for (let i = 0; i < combined.length; i++) {
    rankSums[combined[i].group] += ranks[i];
  }

  const groupSizes = validGroups.map(g => g.length);

  // H statistic
  let H = 0;
  for (let i = 0; i < validGroups.length; i++) {
    if (groupSizes[i] > 0) {
      H += Math.pow(rankSums[i], 2) / groupSizes[i];
    }
  }
  H = (12 / (N * (N + 1))) * H - 3 * (N + 1);

  // Correct H for tied ranks. This is essential for zero-inflated expression
  // and categorical-like continuous fields where repeated values are common.
  const tieCounts = new Map();
  for (const value of values) {
    const currentCount = tieCounts.get(value);
    tieCounts.set(value, currentCount === undefined ? 1 : currentCount + 1);
  }
  let tieTerm = 0;
  for (const count of tieCounts.values()) {
    if (count > 1) tieTerm += count ** 3 - count;
  }
  const tieCorrection = 1 - tieTerm / (N ** 3 - N);
  if (!(tieCorrection > 0)) {
    return {
      testName: 'Kruskal-Wallis H',
      statistic: NaN,
      pValue: NaN,
      significance: 'N/A',
      effectSize: null,
      effectSizeType: null,
      df: validGroups.length - 1,
      interpretation: 'Kruskal-Wallis is undefined because all values are tied'
    };
  }
  H /= tieCorrection;
  H = Math.max(0, H);

  // Degrees of freedom
  const df = validGroups.length - 1;

  // p-value (chi-squared approximation)
  const pValue = chiSquaredPValue(H, df);

  // Effect size: epsilon-squared
  const epsilonSquared = Math.min(1, Math.max(0, H / (N - 1)));

  // Interpretation
  let effectInterpretation = '';
  if (epsilonSquared < 0.01) effectInterpretation = 'negligible';
  else if (epsilonSquared < 0.06) effectInterpretation = 'small';
  else if (epsilonSquared < 0.14) effectInterpretation = 'medium';
  else effectInterpretation = 'large';

  const significance = getSignificance(pValue);

  return {
    testName: 'Kruskal-Wallis H',
    statistic: H,
    pValue: pValue,
    significance: significance,
    effectSize: epsilonSquared,
    effectSizeType: 'ε²',
    df: df,
    interpretation: pValue < 0.05
      ? `Significant difference among group distributions (${effectInterpretation} effect)`
      : `No significant difference among group distributions`
  };
}

// ============================================================================
// Main Analysis Function
// ============================================================================

const CATEGORICAL_DATA_TYPES = new Set(['categorical', 'categorical_obs']);
const CONTINUOUS_DATA_TYPES = new Set([
  'continuous',
  'continuous_obs',
  'gene_expression'
]);

function requireContinuousPageData(pageData) {
  if (!Array.isArray(pageData)) {
    throw new TypeError('Continuous statistical page data must be an array');
  }
  for (let index = 0; index < pageData.length; index++) {
    const page = requireRecord(
      pageData[index],
      `Continuous statistical group ${index + 1}`
    );
    if (
      typeof page.pageName !== 'string'
      || page.pageName.length === 0
      || page.pageName !== page.pageName.trim()
    ) {
      throw new TypeError(
        `Continuous statistical group ${index + 1} requires a trimmed pageName`
      );
    }
    requireNumericArrayLike(
      page.values,
      `Continuous statistical group ${index + 1} values`
    );
  }
  return pageData;
}

/**
 * Run appropriate statistical test based on data type and number of groups
 * @param {Object[]} pageData - Array of page data objects
 * @param {string} dataType - 'categorical' or 'continuous'
 * @returns {StatisticalResult[]} Array of test results
 */
export function runStatisticalTests(pageData, dataType) {
  if (
    !CATEGORICAL_DATA_TYPES.has(dataType)
    && !CONTINUOUS_DATA_TYPES.has(dataType)
  ) {
    throw new TypeError(`Unsupported statistical data type: ${String(dataType)}`);
  }

  const categoricalTable = CATEGORICAL_DATA_TYPES.has(dataType)
    ? buildCategoricalTable(pageData)
    : null;
  if (categoricalTable === null) {
    requireContinuousPageData(pageData);
  }

  const results = [];

  if (pageData.length < 2) {
    return [{
      testName: 'Statistical Analysis',
      statistic: NaN,
      pValue: NaN,
      significance: 'N/A',
      effectSize: null,
      effectSizeType: null,
      interpretation: 'Select at least 2 pages to compare'
    }];
  }

  if (categoricalTable !== null) {
    results.push(
      shouldUseFisherExact(categoricalTable)
        ? fisherExactTestFromTable(categoricalTable)
        : chiSquaredTestFromTable(categoricalTable)
    );
  } else {
    // Continuous data tests
    const groups = pageData.map((page, index) =>
      finiteValues(page.values, `Continuous statistical group ${index + 1} values`)
    );

    if (groups.length === 2) {
      // Two-group comparisons
      results.push(tTest(groups[0], groups[1]));
      results.push(mannWhitneyU(groups[0], groups[1]));
    } else {
      // Multi-group comparisons
      results.push(oneWayANOVA(groups));
      results.push(kruskalWallis(groups));
    }
  }

  return results;
}

/**
 * Format statistical result for display
 * @param {StatisticalResult} result
 * @returns {Object} Formatted display object
 */
export function formatStatisticalResult(result) {
  requireRecord(result, 'Statistical result');
  for (const key of ['testName', 'significance', 'interpretation']) {
    if (typeof result[key] !== 'string' || result[key].length === 0) {
      throw new TypeError(`Statistical result ${key} must be a non-empty string`);
    }
  }
  if (
    typeof result.statistic !== 'number'
    || typeof result.pValue !== 'number'
    || (
      result.effectSize !== null
      && typeof result.effectSize !== 'number'
    )
    || (
      result.effectSizeType !== null
      && (
        typeof result.effectSizeType !== 'string'
        || result.effectSizeType.length === 0
      )
    )
  ) {
    throw new TypeError('Statistical result contains an invalid numeric contract');
  }
  if (
    Object.hasOwn(result, 'pValueMethod')
    && (
      typeof result.pValueMethod !== 'string'
      || result.pValueMethod.length === 0
    )
  ) {
    throw new TypeError(
      'Statistical result pValueMethod must be a non-empty string when present'
    );
  }

  let statistic = 'N/A';
  if (result.statistic === Infinity) statistic = '∞';
  else if (result.statistic === -Infinity) statistic = '-∞';
  else if (isFiniteNumber(result.statistic)) statistic = result.statistic.toFixed(3);

  let effectSize = 'N/A';
  if (result.effectSize === Infinity) {
    effectSize = `∞ (${result.effectSizeType})`;
  } else if (result.effectSize === -Infinity) {
    effectSize = `-∞ (${result.effectSizeType})`;
  } else if (result.effectSize !== null && isFiniteNumber(result.effectSize)) {
    effectSize = `${result.effectSize.toFixed(3)} (${result.effectSizeType})`;
  }

  return {
    test: result.testName,
    statistic,
    pValue: !isFiniteNumber(result.pValue) ? 'N/A' : formatPValue(result.pValue),
    significance: result.significance,
    effectSize,
    method: Object.hasOwn(result, 'pValueMethod')
      ? result.pValueMethod
      : null,
    interpretation: result.interpretation
  };
}

// ============================================================================
// Multiple Testing Correction
// ============================================================================

/**
 * Benjamini-Hochberg procedure for FDR correction
 * Controls the false discovery rate at a specified level
 *
 * @param {number[]} pValues - Array of p-values
 * @param {number} [alpha=0.05] - Desired FDR level
 * @returns {Object} { adjustedPValues: number[], significant: boolean[], threshold: number }
 */
export function benjaminiHochberg(pValues, alpha = 0.05) {
  requireNumericArrayLike(pValues, 'Benjamini-Hochberg p-values');
  requireAlpha(alpha);
  for (let index = 0; index < pValues.length; index++) {
    requireProbability(
      pValues[index],
      `Benjamini-Hochberg p-value ${index + 1}`
    );
  }
  if (pValues.length === 0) {
    return {
      adjustedPValues: [],
      significant: [],
      threshold: null,
      significantCount: 0
    };
  }

  const n = pValues.length;

  // Create indexed array for sorting
  const indexed = Array.from(pValues, (p, i) => ({
    pValue: p,
    originalIndex: i
  }));
  const m = indexed.length;

  // Sort p-values
  indexed.sort((a, b) => a.pValue - b.pValue);

  // Calculate adjusted p-values using step-up procedure
  const adjustedValid = new Array(m);

  // Start from the largest p-value
  adjustedValid[m - 1] = indexed[m - 1].pValue;

  for (let i = m - 2; i >= 0; i--) {
    // Adjusted p = min(p * m / (i+1), previous adjusted p)
    const rawAdjusted = indexed[i].pValue * m / (i + 1);
    adjustedValid[i] = Math.min(rawAdjusted, adjustedValid[i + 1]);
  }

  // Ensure adjusted p-values don't exceed 1
  for (let i = 0; i < m; i++) {
    adjustedValid[i] = Math.min(adjustedValid[i], 1);
  }

  // Find BH threshold
  let threshold = null;
  for (let i = 0; i < m; i++) {
    const criticalValue = (i + 1) * alpha / m;
    if (indexed[i].pValue <= criticalValue) {
      threshold = indexed[i].pValue;
    }
  }

  // Map back to original indices
  const adjustedPValues = new Array(n).fill(null);
  const significant = new Array(n).fill(false);

  for (let i = 0; i < m; i++) {
    const origIdx = indexed[i].originalIndex;
    adjustedPValues[origIdx] = adjustedValid[i];
    significant[origIdx] = adjustedValid[i] <= alpha;
  }

  return {
    adjustedPValues,
    significant,
    threshold,
    significantCount: significant.filter(s => s).length
  };
}

/**
 * Bonferroni correction (more conservative than BH)
 *
 * @param {number[]} pValues - Array of p-values
 * @param {number} [alpha=0.05] - Significance level
 * @returns {Object} { adjustedPValues: number[], significant: boolean[] }
 */
export function bonferroniCorrection(pValues, alpha = 0.05) {
  requireNumericArrayLike(pValues, 'Bonferroni p-values');
  requireAlpha(alpha);
  for (let index = 0; index < pValues.length; index++) {
    requireProbability(pValues[index], `Bonferroni p-value ${index + 1}`);
  }
  if (pValues.length === 0) {
    return {
      adjustedPValues: [],
      significant: [],
      threshold: null,
      significantCount: 0
    };
  }

  const n = pValues.length;
  const adjustedPValues = Array.from(
    pValues,
    p => Math.min(p * n, 1)
  );

  const significant = adjustedPValues.map(p => p <= alpha);

  return {
    adjustedPValues,
    significant,
    threshold: alpha / n,
    significantCount: significant.filter(s => s).length
  };
}

/**
 * Apply multiple testing correction to an array of results
 * Modifies results in place by adding adjustedPValue field
 *
 * @param {Object[]} results - Array of objects with pValue field
 * @param {string} [method='bh'] - 'bh' (Benjamini-Hochberg) or 'bonferroni'
 * @param {number} [alpha=0.05] - Significance level
 * @returns {Object[]} Results with adjustedPValue added
 */
export function applyMultipleTestingCorrection(results, method = 'bh', alpha = 0.05) {
  if (!Array.isArray(results)) {
    throw new TypeError('Multiple-testing results must be an array');
  }
  if (method !== 'bh' && method !== 'bonferroni') {
    throw new TypeError(
      'Multiple-testing method must be exactly "bh" or "bonferroni"'
    );
  }
  requireAlpha(alpha);
  if (results.length === 0) return [];

  const pValues = results.map((result, index) => {
    requireRecord(result, `Multiple-testing result ${index + 1}`);
    return requireProbability(
      result.pValue,
      `Multiple-testing result ${index + 1} p-value`
    );
  });

  const correction = method === 'bonferroni'
    ? bonferroniCorrection(pValues, alpha)
    : benjaminiHochberg(pValues, alpha);

  return results.map((r, i) => ({
    ...r,
    adjustedPValue: correction.adjustedPValues[i],
    significantAfterCorrection: correction.significant[i]
  }));
}

// ============================================================================
// Additional Statistical Utilities
// ============================================================================

/**
 * Compute confidence interval for a mean
 *
 * @param {number[]} values - Sample values
 * @param {number} [confidenceLevel=0.95] - Confidence level (0-1)
 * @returns {Object} { mean, lower, upper, se, n }
 */
export function confidenceInterval(values, confidenceLevel = 0.95) {
  const validValues = finiteValues(values, 'Confidence-interval values');
  if (
    !Number.isFinite(confidenceLevel)
    || confidenceLevel <= 0
    || confidenceLevel >= 1
  ) {
    throw new RangeError(
      'Confidence level must be finite and strictly between 0 and 1'
    );
  }
  const n = validValues.length;

  if (n < 2) {
    return {
      mean: n === 1 ? validValues[0] : NaN,
      lower: NaN,
      upper: NaN,
      se: NaN,
      n,
      confidenceLevel
    };
  }

  const m = mean(validValues);
  const s = std(validValues, 1); // Sample std (ddof=1)
  const se = s / Math.sqrt(n);

  // Z-score for confidence level (using normal approximation for large n)
  const alpha = 1 - confidenceLevel;
  // Approximate z-score
  const z = -normalCDFInverse(alpha / 2);

  return {
    mean: m,
    lower: m - z * se,
    upper: m + z * se,
    se,
    n,
    confidenceLevel
  };
}

/**
 * Inverse normal CDF (probit function) approximation
 */
function normalCDFInverse(p) {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new RangeError(
      'Inverse normal probability must be finite and strictly between 0 and 1'
    );
  }
  if (p === 0.5) return 0;

  // Rational approximation
  const a = [
    -3.969683028665376e+01,
    2.209460984245205e+02,
    -2.759285104469687e+02,
    1.383577518672690e+02,
    -3.066479806614716e+01,
    2.506628277459239e+00
  ];
  const b = [
    -5.447609879822406e+01,
    1.615858368580409e+02,
    -1.556989798598866e+02,
    6.680131188771972e+01,
    -1.328068155288572e+01
  ];
  const c = [
    -7.784894002430293e-03,
    -3.223964580411365e-01,
    -2.400758277161838e+00,
    -2.549732539343734e+00,
    4.374664141464968e+00,
    2.938163982698783e+00
  ];
  const d = [
    7.784695709041462e-03,
    3.224671290700398e-01,
    2.445134137142996e+00,
    3.754408661907416e+00
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q, r;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
            ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

/**
 * Compute fold change and log2 fold change
 *
 * @param {number} meanA - Mean of group A
 * @param {number} meanB - Mean of group B
 * @param {number} [pseudocount=0.01] - Pseudocount to avoid log(0)
 * @returns {Object} { foldChange, log2FoldChange }
 */
export function computeFoldChange(meanA, meanB, pseudocount = 0.01) {
  if (!Number.isFinite(meanA) || meanA < 0) {
    throw new RangeError('Fold-change meanA must be finite and non-negative');
  }
  if (!Number.isFinite(meanB) || meanB < 0) {
    throw new RangeError('Fold-change meanB must be finite and non-negative');
  }
  if (!Number.isFinite(pseudocount) || pseudocount <= 0) {
    throw new RangeError('Fold-change pseudocount must be finite and positive');
  }
  const adjA = meanA + pseudocount;
  const adjB = meanB + pseudocount;

  return {
    foldChange: adjA / adjB,
    log2FoldChange: Math.log2(adjA / adjB)
  };
}

/**
 * Classify significance and effect size
 *
 * @param {number} pValue - P-value
 * @param {number} effectSize - Effect size (Cohen's d or similar)
 * @returns {Object} Classification
 */
export function classifyResult(pValue, effectSize) {
  requireProbability(pValue, 'Classification p-value');
  if (!Number.isFinite(effectSize)) {
    throw new RangeError('Classification effect size must be finite');
  }
  // Significance classification
  let significanceLevel = 'ns';
  if (pValue < 0.001) significanceLevel = '***';
  else if (pValue < 0.01) significanceLevel = '**';
  else if (pValue < 0.05) significanceLevel = '*';

  // Effect size classification (Cohen's d conventions)
  let effectSizeCategory = 'negligible';
  const absEffect = Math.abs(effectSize);
  if (absEffect >= 0.8) effectSizeCategory = 'large';
  else if (absEffect >= 0.5) effectSizeCategory = 'medium';
  else if (absEffect >= 0.2) effectSizeCategory = 'small';

  return {
    significanceLevel,
    effectSizeCategory,
    isSignificant: pValue < 0.05,
    direction: effectSize > 0 ? 'positive' : effectSize < 0 ? 'negative' : 'none'
  };
}

// =============================================================================
// PLUGIN REGISTRATION
// =============================================================================

/**
 * Register statistical tests as plugins
 * This enables discovery and dynamic selection of tests.
 */
let _statsRegistered = false;

function requirePluginComputeInput(data, requiredKeys, label) {
  requireRecord(data, `${label} input`);
  const actualKeys = Object.keys(data).sort();
  const expectedKeys = [...requiredKeys].sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(
      `${label} input must contain exactly ${expectedKeys.join(', ')}`
    );
  }
  return data;
}

function requireEmptyPluginOptions(options, label) {
  requireRecord(options, `${label} options`);
  if (Object.keys(options).length !== 0) {
    throw new TypeError(`${label} does not accept compute options`);
  }
}

export function registerStatisticalTests() {
  if (_statsRegistered) return;

  const registry = getStatRegistry();
  const register = plugin => {
    if (registry.register(plugin) !== true) {
      throw new Error(`Statistical plugin registration failed: ${plugin.id}`);
    }
  };

  // Chi-squared test for categorical data
  register({
    id: 'chi-squared',
    name: 'Chi-Squared Test',
    description: 'Tests independence between categorical distributions',
    testType: 'categorical',
    supportedTypes: ['categorical'],
    minGroups: 2,
    maxGroups: null,
    compute(data, options = {}) {
      requireEmptyPluginOptions(options, 'Chi-squared plugin');
      const input = requirePluginComputeInput(
        data,
        ['pageData'],
        'Chi-squared plugin'
      );
      return chiSquaredTest(input.pageData);
    }
  });

  // Fisher's exact test for sparse 2x2 categorical data
  register({
    id: 'fisher-exact',
    name: "Fisher's Exact Test",
    description: 'Tests association in a sparse 2x2 contingency table',
    testType: 'categorical',
    supportedTypes: ['categorical'],
    minGroups: 2,
    maxGroups: 2,
    compute(data, options = {}) {
      requireEmptyPluginOptions(options, "Fisher's exact plugin");
      const input = requirePluginComputeInput(
        data,
        ['pageData'],
        "Fisher's exact plugin"
      );
      return fisherExactTest(input.pageData);
    }
  });

  // Welch's t-test for continuous data (2 groups)
  register({
    id: 't-test',
    name: "Welch's t-test",
    description: 'Compares means of two groups without assuming equal variances',
    testType: 'parametric',
    supportedTypes: ['continuous', 'gene_expression'],
    minGroups: 2,
    maxGroups: 2,
    compute(data, options = {}) {
      requireEmptyPluginOptions(options, "Welch's t-test plugin");
      const input = requirePluginComputeInput(
        data,
        ['group1', 'group2'],
        "Welch's t-test plugin"
      );
      return tTest(input.group1, input.group2);
    }
  });

  // Mann-Whitney U test for continuous data (2 groups, non-parametric)
  register({
    id: 'mann-whitney',
    name: 'Mann-Whitney U Test',
    description: 'Compares distributions of two groups (non-parametric)',
    testType: 'nonparametric',
    supportedTypes: ['continuous', 'gene_expression'],
    minGroups: 2,
    maxGroups: 2,
    compute(data, options = {}) {
      requireEmptyPluginOptions(options, 'Mann-Whitney plugin');
      const input = requirePluginComputeInput(
        data,
        ['group1', 'group2'],
        'Mann-Whitney plugin'
      );
      return mannWhitneyU(input.group1, input.group2);
    }
  });

  // One-way ANOVA for continuous data (multiple groups)
  register({
    id: 'anova',
    name: 'One-way ANOVA',
    description: 'Compares means across multiple groups (parametric)',
    testType: 'parametric',
    supportedTypes: ['continuous', 'gene_expression'],
    minGroups: 2,
    maxGroups: null,
    compute(data, options = {}) {
      requireEmptyPluginOptions(options, 'One-way ANOVA plugin');
      const input = requirePluginComputeInput(
        data,
        ['groups'],
        'One-way ANOVA plugin'
      );
      return oneWayANOVA(input.groups);
    }
  });

  // Kruskal-Wallis test for continuous data (multiple groups, non-parametric)
  register({
    id: 'kruskal-wallis',
    name: 'Kruskal-Wallis Test',
    description: 'Compares distributions across multiple groups (non-parametric)',
    testType: 'nonparametric',
    supportedTypes: ['continuous', 'gene_expression'],
    minGroups: 2,
    maxGroups: null,
    compute(data, options = {}) {
      requireEmptyPluginOptions(options, 'Kruskal-Wallis plugin');
      const input = requirePluginComputeInput(
        data,
        ['groups'],
        'Kruskal-Wallis plugin'
      );
      return kruskalWallis(input.groups);
    }
  });

  _statsRegistered = true;
  console.log('[StatisticalTests] Registered 6 statistical tests as plugins');
}

/**
 * Get the StatPluginRegistry with tests registered
 * @returns {import('./plugin-contract.js').StatPluginRegistry}
 */
export function getStatisticalTestRegistry() {
  registerStatisticalTests();
  return getStatRegistry();
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default {
  runStatisticalTests,
  formatStatisticalResult,
  chiSquaredTest,
  fisherExactTest,
  tTest,
  mannWhitneyU,
  oneWayANOVA,
  kruskalWallis,
  benjaminiHochberg,
  bonferroniCorrection,
  applyMultipleTestingCorrection,
  confidenceInterval,
  computeFoldChange,
  classifyResult,
  // Plugin registration
  registerStatisticalTests,
  getStatisticalTestRegistry
};
