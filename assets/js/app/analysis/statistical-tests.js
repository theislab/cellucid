/**
 * Statistical Tests Module for Page Analysis
 *
 * Provides statistical comparison tests for categorical and continuous data:
 * - Categorical: Chi-squared test, Fisher's exact test (2x2)
 * - Continuous: t-test, Mann-Whitney U, ANOVA, Kruskal-Wallis
 *
 * All tests return p-values, test statistics, and effect sizes where applicable.
 */

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

/**
 * Calculate mean of an array
 */
function mean(arr) {
  if (!arr || arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Calculate variance of an array
 */
function variance(arr, ddof = 0) {
  if (!arr || arr.length <= ddof) return NaN;
  const m = mean(arr);
  const sumSq = arr.reduce((a, b) => a + (b - m) ** 2, 0);
  return sumSq / (arr.length - ddof);
}

/**
 * Calculate standard deviation
 */
function std(arr, ddof = 0) {
  return Math.sqrt(variance(arr, ddof));
}

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

/**
 * Rank array values (for non-parametric tests)
 */
function rankData(arr) {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array(arr.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    // Find ties
    while (j < indexed.length && indexed[j].v === indexed[i].v) {
      j++;
    }
    // Assign average rank to ties
    const avgRank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) {
      ranks[indexed[k].i] = avgRank;
    }
    i = j;
  }
  return ranks;
}

/**
 * Normal CDF approximation (for p-value calculation)
 */
function normalCDF(z) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  z = Math.abs(z) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * z);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Chi-squared CDF approximation (using Wilson-Hilferty transformation)
 */
function chiSquaredCDF(x, df) {
  if (x <= 0) return 0;
  if (df <= 0) return NaN;

  // Wilson-Hilferty approximation
  const z = Math.pow(x / df, 1/3) - (1 - 2 / (9 * df));
  const denom = Math.sqrt(2 / (9 * df));
  return normalCDF(z / denom);
}

/**
 * Calculate chi-squared p-value
 */
function chiSquaredPValue(statistic, df) {
  return 1 - chiSquaredCDF(statistic, df);
}

/**
 * F-distribution CDF approximation
 */
function fDistributionPValue(f, df1, df2) {
  if (f <= 0) return 1;
  // Using beta function approximation
  const x = df2 / (df2 + df1 * f);
  return incompleteBeta(x, df2 / 2, df1 / 2);
}

/**
 * Incomplete beta function approximation (for F-distribution)
 */
function incompleteBeta(x, a, b) {
  // Simple approximation using continued fraction
  if (x === 0) return 0;
  if (x === 1) return 1;

  // Use symmetry for better convergence
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - incompleteBeta(1 - x, b, a);
  }

  const bt = Math.exp(
    gammaLn(a + b) - gammaLn(a) - gammaLn(b) +
    a * Math.log(x) + b * Math.log(1 - x)
  );

  // Continued fraction
  let result = x / a;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= 100; m++) {
    const m2 = 2 * m;

    // Even step
    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;

    // Odd step
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;

    if (Math.abs(del - 1) < 1e-10) break;
  }

  return bt * h / a;
}

/**
 * Log gamma function approximation (Lanczos)
 */
function gammaLn(z) {
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7
  ];

  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - gammaLn(1 - z);
  }

  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += c[i] / (z + i);
  }

  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
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
      pd.values.filter(v => typeof v === 'number' && !Number.isNaN(v))
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
    statistic: isNaN(result.statistic) ? 'N/A' : result.statistic.toFixed(3),
    pValue: isNaN(result.pValue) ? 'N/A' : formatPValue(result.pValue),
    significance: result.significance,
    effectSize: result.effectSize !== null && !isNaN(result.effectSize)
      ? `${result.effectSize.toFixed(3)} (${result.effectSizeType})`
      : 'N/A',
    interpretation: result.interpretation
  };
}

export default {
  runStatisticalTests,
  formatStatisticalResult,
  chiSquaredTest,
  tTest,
  mannWhitneyU,
  oneWayANOVA,
  kruskalWallis
};
