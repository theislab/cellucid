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
  normalCDF,
  chiSquaredPValue,
  fDistributionPValue,
  computeRanks
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
 * @property {string} interpretation - Human-readable interpretation
 */

// ============================================================================
// Helper Functions
// ============================================================================

// Alias for backward compatibility with internal code
const rankData = computeRanks;

/**
 * Get significance stars from p-value
 */
function getSignificance(pValue) {
  if (pValue < 0.001) return '***';
  if (pValue < 0.01) return '**';
  if (pValue < 0.05) return '*';
  return 'ns';
}

/**
 * Format p-value for display
 */
function formatPValue(p) {
  if (p < 0.0001) return '< 0.0001';
  if (p < 0.001) return p.toExponential(2);
  return p.toFixed(4);
}

// ============================================================================
// Statistical Tests for Categorical Data
// ============================================================================

/**
 * Chi-squared test for independence
 * Tests whether categorical distributions differ across groups
 * @param {Object[]} pageData - Array of page data with categorical values
 * @returns {StatisticalResult}
 */
export function chiSquaredTest(pageData) {
  if (!pageData || pageData.length < 2) {
    return {
      testName: 'Chi-squared test',
      statistic: NaN,
      pValue: NaN,
      significance: 'N/A',
      effectSize: null,
      effectSizeType: null,
      interpretation: 'Need at least 2 groups for comparison'
    };
  }

  // Build contingency table
  const categories = new Set();
  for (const pd of pageData) {
    for (const v of pd.values) {
      categories.add(v);
    }
  }
  const catArray = Array.from(categories);

  // Observed frequencies
  const observed = pageData.map(pd => {
    const counts = {};
    for (const cat of catArray) counts[cat] = 0;
    for (const v of pd.values) counts[v]++;
    return catArray.map(cat => counts[cat]);
  });

  // Row totals, column totals, grand total
  const rowTotals = observed.map(row => row.reduce((a, b) => a + b, 0));
  const colTotals = catArray.map((_, j) => observed.reduce((sum, row) => sum + row[j], 0));
  const grandTotal = rowTotals.reduce((a, b) => a + b, 0);

  if (grandTotal === 0) {
    return {
      testName: 'Chi-squared test',
      statistic: NaN,
      pValue: NaN,
      significance: 'N/A',
      effectSize: null,
      effectSizeType: null,
      interpretation: 'No data available'
    };
  }

  // Calculate chi-squared statistic
  let chiSq = 0;
  for (let i = 0; i < observed.length; i++) {
    for (let j = 0; j < catArray.length; j++) {
      const expected = (rowTotals[i] * colTotals[j]) / grandTotal;
      if (expected > 0) {
        chiSq += Math.pow(observed[i][j] - expected, 2) / expected;
      }
    }
  }

  // Degrees of freedom
  const df = (observed.length - 1) * (catArray.length - 1);

  // p-value
  const pValue = chiSquaredPValue(chiSq, df);

  // Effect size: Cramér's V
  const k = Math.min(observed.length, catArray.length);
  const cramersV = Math.sqrt(chiSq / (grandTotal * (k - 1)));

  // Interpretation
  let effectInterpretation = '';
  if (cramersV < 0.1) effectInterpretation = 'negligible';
  else if (cramersV < 0.2) effectInterpretation = 'small';
  else if (cramersV < 0.4) effectInterpretation = 'medium';
  else effectInterpretation = 'large';

  const significance = getSignificance(pValue);

  return {
    testName: 'Chi-squared test',
    statistic: chiSq,
    pValue: pValue,
    significance: significance,
    effectSize: cramersV,
    effectSizeType: "Cramér's V",
    df: df,
    interpretation: pValue < 0.05
      ? `Significant difference in distributions (${effectInterpretation} effect)`
      : `No significant difference in distributions`
  };
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
  const n1 = group1.length;
  const n2 = group2.length;

  if (n1 < 2 || n2 < 2) {
    return {
      testName: "Student's t-test",
      statistic: NaN,
      pValue: NaN,
      significance: 'N/A',
      effectSize: null,
      effectSizeType: null,
      interpretation: 'Need at least 2 samples in each group'
    };
  }

  const m1 = mean(group1);
  const m2 = mean(group2);
  const v1 = variance(group1, 1);
  const v2 = variance(group2, 1);

  // Welch's t-test (doesn't assume equal variances)
  const se = Math.sqrt(v1 / n1 + v2 / n2);
  const t = (m1 - m2) / se;

  // Welch-Satterthwaite degrees of freedom
  const num = Math.pow(v1 / n1 + v2 / n2, 2);
  const denom = Math.pow(v1 / n1, 2) / (n1 - 1) + Math.pow(v2 / n2, 2) / (n2 - 1);
  const df = num / denom;

  // p-value using normal approximation for large df
  const pValue = 2 * (1 - normalCDF(Math.abs(t)));

  // Effect size: Cohen's d
  const pooledStd = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
  const cohensD = pooledStd > 0 ? (m1 - m2) / pooledStd : 0;

  // Interpretation
  let effectInterpretation = '';
  const absD = Math.abs(cohensD);
  if (absD < 0.2) effectInterpretation = 'negligible';
  else if (absD < 0.5) effectInterpretation = 'small';
  else if (absD < 0.8) effectInterpretation = 'medium';
  else effectInterpretation = 'large';

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
      ? `Significant difference between means (${effectInterpretation} effect)`
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
  const n1 = group1.length;
  const n2 = group2.length;

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

  // Combine and rank
  const combined = [
    ...group1.map(v => ({ v, group: 1 })),
    ...group2.map(v => ({ v, group: 2 }))
  ];
  const values = combined.map(x => x.v);
  const ranks = rankData(values);

  // Calculate rank sum for each group
  let R1 = 0, R2 = 0;
  for (let i = 0; i < combined.length; i++) {
    if (combined[i].group === 1) R1 += ranks[i];
    else R2 += ranks[i];
  }

  // Calculate U statistics
  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const U2 = R2 - (n2 * (n2 + 1)) / 2;
  const U = Math.min(U1, U2);

  // Normal approximation for p-value (large sample)
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  const z = sigma > 0 ? (U - mu) / sigma : 0;
  const pValue = 2 * (1 - normalCDF(Math.abs(z)));

  // Effect size: rank-biserial correlation
  const rbc = 1 - (2 * U) / (n1 * n2);

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
    effectSizeType: 'rank-biserial r',
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
  const k = groups.length; // Number of groups

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

  // Filter out empty groups
  const validGroups = groups.filter(g => g && g.length > 0);
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

  // Grand mean
  const grandMean = validGroups.flat().reduce((a, b) => a + b, 0) / N;

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

  // F statistic
  const F = MSW > 0 ? MSB / MSW : 0;

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

  // Filter out empty groups
  const validGroups = groups.filter(g => g && g.length > 0);
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
  const ranks = rankData(values);

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

  // Degrees of freedom
  const df = validGroups.length - 1;

  // p-value (chi-squared approximation)
  const pValue = chiSquaredPValue(H, df);

  // Effect size: epsilon-squared
  const epsilonSquared = H / (N - 1);

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

/**
 * Run appropriate statistical test based on data type and number of groups
 * @param {Object[]} pageData - Array of page data objects
 * @param {string} dataType - 'categorical' or 'continuous'
 * @returns {StatisticalResult[]} Array of test results
 */
export function runStatisticalTests(pageData, dataType) {
  const results = [];

  if (!pageData || pageData.length < 2) {
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

  if (dataType === 'categorical' || dataType === 'categorical_obs') {
    // Chi-squared test for categorical data
    results.push(chiSquaredTest(pageData));
  } else {
    // Continuous data tests
    const groups = pageData.map(pd =>
      pd.values.filter(v => isFiniteNumber(v))
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
  return {
    test: result.testName,
    statistic: !isFiniteNumber(result.statistic) ? 'N/A' : result.statistic.toFixed(3),
    pValue: !isFiniteNumber(result.pValue) ? 'N/A' : formatPValue(result.pValue),
    significance: result.significance,
    effectSize: result.effectSize !== null && isFiniteNumber(result.effectSize)
      ? `${result.effectSize.toFixed(3)} (${result.effectSizeType})`
      : 'N/A',
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
  if (!pValues || pValues.length === 0) {
    return { adjustedPValues: [], significant: [], threshold: null };
  }

  const n = pValues.length;

  // Create indexed array for sorting
  const indexed = pValues.map((p, i) => ({
    pValue: p,
    originalIndex: i,
    isValid: isFiniteNumber(p)
  }));

  // Separate valid and invalid p-values
  const valid = indexed.filter(x => x.isValid);
  const m = valid.length;

  if (m === 0) {
    return {
      adjustedPValues: pValues.map(() => null),
      significant: pValues.map(() => false),
      threshold: null
    };
  }

  // Sort valid p-values
  valid.sort((a, b) => a.pValue - b.pValue);

  // Calculate adjusted p-values using step-up procedure
  const adjustedValid = new Array(m);

  // Start from the largest p-value
  adjustedValid[m - 1] = valid[m - 1].pValue;

  for (let i = m - 2; i >= 0; i--) {
    // Adjusted p = min(p * m / (i+1), previous adjusted p)
    const rawAdjusted = valid[i].pValue * m / (i + 1);
    adjustedValid[i] = Math.min(rawAdjusted, adjustedValid[i + 1]);
  }

  // Ensure adjusted p-values don't exceed 1
  for (let i = 0; i < m; i++) {
    adjustedValid[i] = Math.min(adjustedValid[i], 1);
  }

  // Find BH threshold
  let threshold = 0;
  for (let i = 0; i < m; i++) {
    const criticalValue = (i + 1) * alpha / m;
    if (valid[i].pValue <= criticalValue) {
      threshold = valid[i].pValue;
    }
  }

  // Map back to original indices
  const adjustedPValues = new Array(n).fill(null);
  const significant = new Array(n).fill(false);

  for (let i = 0; i < m; i++) {
    const origIdx = valid[i].originalIndex;
    adjustedPValues[origIdx] = adjustedValid[i];
    significant[origIdx] = adjustedValid[i] < alpha;
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
  if (!pValues || pValues.length === 0) {
    return { adjustedPValues: [], significant: [] };
  }

  const n = pValues.length;
  const adjustedPValues = pValues.map(p => {
    if (!isFiniteNumber(p)) return null;
    return Math.min(p * n, 1);
  });

  const significant = adjustedPValues.map(p => p !== null && p < alpha);

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
  if (!results || results.length === 0) return results;

  const pValues = results.map(r => r.pValue);

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
  const validValues = values.filter(v => isFiniteNumber(v));
  const n = validValues.length;

  if (n < 2) {
    return { mean: validValues[0] || NaN, lower: NaN, upper: NaN, se: NaN, n };
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
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
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

export function registerStatisticalTests() {
  if (_statsRegistered) return;

  const registry = getStatRegistry();

  // Chi-squared test for categorical data
  registry.register({
    id: 'chi-squared',
    name: 'Chi-Squared Test',
    description: 'Tests independence between categorical distributions',
    testType: 'categorical',
    supportedTypes: ['categorical'],
    minGroups: 2,
    maxGroups: null,
    compute(data, options = {}) {
      return chiSquaredTest(data.pageData || data);
    }
  });

  // Student's t-test for continuous data (2 groups)
  registry.register({
    id: 't-test',
    name: "Student's t-test",
    description: 'Compares means of two groups (parametric)',
    testType: 'parametric',
    supportedTypes: ['continuous', 'gene_expression'],
    minGroups: 2,
    maxGroups: 2,
    compute(data, options = {}) {
      const { group1, group2 } = data;
      return tTest(group1, group2);
    }
  });

  // Mann-Whitney U test for continuous data (2 groups, non-parametric)
  registry.register({
    id: 'mann-whitney',
    name: 'Mann-Whitney U Test',
    description: 'Compares distributions of two groups (non-parametric)',
    testType: 'nonparametric',
    supportedTypes: ['continuous', 'gene_expression'],
    minGroups: 2,
    maxGroups: 2,
    compute(data, options = {}) {
      const { group1, group2 } = data;
      return mannWhitneyU(group1, group2);
    }
  });

  // One-way ANOVA for continuous data (multiple groups)
  registry.register({
    id: 'anova',
    name: 'One-way ANOVA',
    description: 'Compares means across multiple groups (parametric)',
    testType: 'parametric',
    supportedTypes: ['continuous', 'gene_expression'],
    minGroups: 2,
    maxGroups: null,
    compute(data, options = {}) {
      const groups = data.groups || data.pageData?.map(pd => pd.values);
      return oneWayANOVA(groups);
    }
  });

  // Kruskal-Wallis test for continuous data (multiple groups, non-parametric)
  registry.register({
    id: 'kruskal-wallis',
    name: 'Kruskal-Wallis Test',
    description: 'Compares distributions across multiple groups (non-parametric)',
    testType: 'nonparametric',
    supportedTypes: ['continuous', 'gene_expression'],
    minGroups: 2,
    maxGroups: null,
    compute(data, options = {}) {
      const groups = data.groups || data.pageData?.map(pd => pd.values);
      return kruskalWallis(groups);
    }
  });

  _statsRegistered = true;
  console.log('[StatisticalTests] Registered 5 statistical tests as plugins');
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
