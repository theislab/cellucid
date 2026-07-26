/**
 * Shared Mathematical Utilities for Compute Module
 *
 * Centralizes all mathematical and statistical helper functions used by:
 * - data-worker.js
 * - operation-handlers.js
 *
 * This eliminates code duplication and ensures consistent implementations.
 */

// ============================================================================
// Basic Statistical Functions
// ============================================================================

/**
 * Calculate mean of an array.
 *
 * @param {number[]} arr - Array of numeric values
 * @returns {number} Mean value, or NaN if empty
 */
export function mean(arr) {
  if (!arr || arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Calculate variance of an array.
 *
 * @param {number[]} arr - Array of numeric values
 * @param {number} [ddof=0] - Delta degrees of freedom (0 for population, 1 for sample)
 * @returns {number} Variance, or NaN if insufficient data
 */
export function variance(arr, ddof = 0) {
  if (!arr || arr.length <= ddof) return NaN;
  const m = mean(arr);
  const sumSq = arr.reduce((a, b) => a + (b - m) ** 2, 0);
  return sumSq / (arr.length - ddof);
}

/**
 * Calculate standard deviation of an array.
 *
 * @param {number[]} arr - Array of numeric values
 * @param {number} [ddof=0] - Delta degrees of freedom (0 for population, 1 for sample)
 * @returns {number} Standard deviation
 */
export function std(arr, ddof = 0) {
  return Math.sqrt(variance(arr, ddof));
}

// ============================================================================
// Statistical Distribution Functions
// ============================================================================

/**
 * Standard-normal survival function P(Z > z).
 *
 * The gamma relationship evaluates positive tails directly, avoiding the
 * catastrophic cancellation caused by subtracting a CDF rounded to one.
 *
 * @param {number} z - Z-score value
 * @returns {number} Upper-tail probability
 */
export function normalSurvival(z) {
  if (Number.isNaN(z)) return NaN;
  if (z === Infinity) return 0;
  if (z === -Infinity) return 1;

  const positiveTail = 0.5 * regularizedGammaQ(0.5, (z * z) / 2);
  return z >= 0 ? positiveTail : 1 - positiveTail;
}

/**
 * Standard-normal cumulative distribution function P(Z <= z).
 *
 * @param {number} z - Z-score value
 * @returns {number} Cumulative probability
 */
export function normalCDF(z) {
  return normalSurvival(-z);
}

/**
 * Student t-distribution CDF.
 *
 * Uses the regularized incomplete beta identity for finite degrees of freedom.
 * This remains important around common significance thresholds even at
 * moderately large df, where substituting the normal CDF can change the
 * reported significance.
 *
 * @param {number} t - T-statistic value
 * @param {number} df - Degrees of freedom
 * @returns {number} Cumulative probability
 */
export function tCDF(t, df) {
  if (Number.isNaN(t) || df <= 0 || Number.isNaN(df)) return NaN;
  if (t === -Infinity) return 0;
  if (t === Infinity) return 1;
  if (df === Infinity) return normalCDF(t);
  if (!Number.isFinite(t) || !Number.isFinite(df)) return NaN;

  const x = df / (df + t * t);
  const lowerTail = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t < 0 ? lowerTail : 1 - lowerTail;
}

/**
 * Two-sided Student t p-value evaluated through the stable lower tail.
 *
 * @param {number} t - T statistic
 * @param {number} df - Degrees of freedom
 * @returns {number} Two-sided p-value
 */
export function tTwoSidedPValue(t, df) {
  if (Number.isNaN(t)) return NaN;
  const pValue = 2 * tCDF(-Math.abs(t), df);
  return Number.isNaN(pValue) ? NaN : Math.min(1, Math.max(0, pValue));
}

/**
 * Incomplete beta function approximation using continued fraction method.
 *
 * @param {number} x - Value in [0, 1]
 * @param {number} a - Shape parameter a
 * @param {number} b - Shape parameter b
 * @returns {number} Incomplete beta function value
 */
export function incompleteBeta(x, a, b) {
  if (x === 0) return 0;
  if (x === 1) return 1;

  if (x > (a + 1) / (a + b + 2)) {
    return 1 - incompleteBeta(1 - x, b, a);
  }

  const bt = Math.exp(
    gammaLn(a + b) - gammaLn(a) - gammaLn(b) +
    a * Math.log(x) + b * Math.log(1 - x)
  );

  // Continued fraction
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= 100; m++) {
    const m2 = 2 * m;

    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;

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
 * Log gamma function using Lanczos approximation.
 * Accurate to about 15 decimal places.
 *
 * @param {number} z - Input value
 * @returns {number} Natural log of gamma(z)
 */
export function gammaLn(z) {
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

const GAMMA_EPSILON = 1e-14;
const GAMMA_MIN_ITERATIONS = 1000;
const GAMMA_MAX_ITERATIONS = 100000;
const GAMMA_FPMIN = 1e-300;

function regularizedGammaSeries(a, x) {
  let sum = 1 / a;
  let term = sum;
  let ap = a;
  const maxIterations = Math.min(
    GAMMA_MAX_ITERATIONS,
    Math.max(GAMMA_MIN_ITERATIONS, Math.ceil(16 * Math.sqrt(a)))
  );

  for (let n = 1; n <= maxIterations; n++) {
    ap += 1;
    term *= x / ap;
    sum += term;
    if (Math.abs(term) <= Math.abs(sum) * GAMMA_EPSILON) {
      return sum * Math.exp(-x + a * Math.log(x) - gammaLn(a));
    }
  }
  return NaN;
}

function regularizedGammaContinuedFraction(a, x) {
  let b = x + 1 - a;
  if (Math.abs(b) < GAMMA_FPMIN) b = GAMMA_FPMIN;

  let c = 1 / GAMMA_FPMIN;
  let d = 1 / b;
  let h = d;
  const maxIterations = Math.min(
    GAMMA_MAX_ITERATIONS,
    Math.max(GAMMA_MIN_ITERATIONS, Math.ceil(16 * Math.sqrt(a)))
  );

  for (let i = 1; i <= maxIterations; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < GAMMA_FPMIN) d = GAMMA_FPMIN;
    c = b + an / c;
    if (Math.abs(c) < GAMMA_FPMIN) c = GAMMA_FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) <= GAMMA_EPSILON) {
      return Math.exp(-x + a * Math.log(x) - gammaLn(a)) * h;
    }
  }
  return NaN;
}

/**
 * Regularized lower incomplete gamma P(a, x).
 *
 * @param {number} a - Positive shape parameter
 * @param {number} x - Non-negative evaluation point
 * @returns {number} Probability in [0, 1]
 */
export function regularizedGammaP(a, x) {
  if (!(a > 0) || x < 0 || Number.isNaN(x)) return NaN;
  if (x === 0) return 0;
  if (x === Infinity) return 1;
  if (!Number.isFinite(a) || !Number.isFinite(x)) return NaN;

  const value = x < a + 1
    ? regularizedGammaSeries(a, x)
    : 1 - regularizedGammaContinuedFraction(a, x);
  return Math.min(1, Math.max(0, value));
}

/**
 * Regularized upper incomplete gamma Q(a, x).
 *
 * @param {number} a - Positive shape parameter
 * @param {number} x - Non-negative evaluation point
 * @returns {number} Upper-tail probability in [0, 1]
 */
export function regularizedGammaQ(a, x) {
  if (!(a > 0) || x < 0 || Number.isNaN(x)) return NaN;
  if (x === 0) return 1;
  if (x === Infinity) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(x)) return NaN;

  const value = x < a + 1
    ? 1 - regularizedGammaSeries(a, x)
    : regularizedGammaContinuedFraction(a, x);
  return Math.min(1, Math.max(0, value));
}

/**
 * Chi-squared CDF via the regularized incomplete gamma function.
 *
 * @param {number} x - Chi-squared statistic value
 * @param {number} df - Degrees of freedom
 * @returns {number} Cumulative probability
 */
export function chiSquaredCDF(x, df) {
  if (!Number.isFinite(df) || df <= 0 || Number.isNaN(x)) return NaN;
  if (x <= 0) return 0;
  if (x === Infinity) return 1;
  const probability = regularizedGammaP(df / 2, x / 2);
  if (!Number.isNaN(probability)) return probability;

  // Bounded approximation for shapes too large to converge within the iteration
  // guard. Wilson-Hilferty is highly accurate in this large-df regime.
  const z = (Math.cbrt(x / df) - (1 - 2 / (9 * df))) /
    Math.sqrt(2 / (9 * df));
  return normalCDF(z);
}

/**
 * Calculate chi-squared p-value (upper tail).
 *
 * @param {number} statistic - Chi-squared statistic value
 * @param {number} df - Degrees of freedom
 * @returns {number} P-value
 */
export function chiSquaredPValue(statistic, df) {
  if (!Number.isFinite(df) || df <= 0 || Number.isNaN(statistic)) return NaN;
  if (statistic <= 0) return 1;
  if (statistic === Infinity) return 0;
  const probability = regularizedGammaQ(df / 2, statistic / 2);
  if (!Number.isNaN(probability)) return probability;

  const z = (Math.cbrt(statistic / df) - (1 - 2 / (9 * df))) /
    Math.sqrt(2 / (9 * df));
  return normalSurvival(z);
}

/**
 * F-distribution p-value approximation using incomplete beta function.
 *
 * @param {number} f - F-statistic value
 * @param {number} df1 - Numerator degrees of freedom
 * @param {number} df2 - Denominator degrees of freedom
 * @returns {number} P-value (upper tail)
 */
export function fDistributionPValue(f, df1, df2) {
  if (!Number.isFinite(df1) || !Number.isFinite(df2) || df1 <= 0 || df2 <= 0) {
    return NaN;
  }
  if (Number.isNaN(f)) return NaN;
  if (f <= 0) return 1;
  if (f === Infinity) return 0;
  // Using beta function approximation
  const x = df2 / (df2 + df1 * f);
  return incompleteBeta(x, df2 / 2, df1 / 2);
}

// ============================================================================
// Correlation Functions
// ============================================================================

/**
 * Compute Pearson correlation coefficient.
 *
 * @param {Array<{x: number, y: number}>} pairs - Array of {x, y} pairs
 * @returns {number} Pearson correlation coefficient (-1 to 1)
 */
export function computePearsonR(pairs) {
  const n = pairs.length;
  if (n < 2) return 0;

  const sumX = pairs.reduce((s, p) => s + p.x, 0);
  const sumY = pairs.reduce((s, p) => s + p.y, 0);
  const sumXY = pairs.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = pairs.reduce((s, p) => s + p.x * p.x, 0);
  const sumY2 = pairs.reduce((s, p) => s + p.y * p.y, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt(
    (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)
  );

  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Compute Spearman rank correlation coefficient.
 *
 * @param {Array<{x: number, y: number}>} pairs - Array of {x, y} pairs
 * @returns {number} Spearman correlation coefficient (-1 to 1)
 */
export function computeSpearmanR(pairs) {
  // Convert to ranks
  const xRanks = computeRanks(pairs.map(p => p.x));
  const yRanks = computeRanks(pairs.map(p => p.y));

  // Compute Pearson on ranks
  const rankedPairs = xRanks.map((xr, i) => ({ x: xr, y: yRanks[i] }));
  return computePearsonR(rankedPairs);
}

/**
 * Compute ranks with proper handling of ties (average rank method).
 *
 * @param {number[]} values - Array of values to rank
 * @returns {number[]} Array of ranks (1-based, fractional for ties)
 */
export function computeRanks(values) {
  const n = values.length;
  if (n === 0) return [];

  // Sort an index array so we don't allocate per-element objects.
  const order = new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  order.sort((a, b) => {
    const va = values[a];
    const vb = values[b];
    if (va === vb) return 0;
    return va < vb ? -1 : 1;
  });

  const ranks = new Array(n);
  let i = 0;

  while (i < n) {
    let j = i + 1;
    const v = values[order[i]];

    // Find ties (values that are equal).
    while (j < n && values[order[j]] === v) {
      j++;
    }

    // Assign average rank to all tied values (1-based ranks).
    const avgRank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) {
      ranks[order[k]] = avgRank;
    }

    i = j;
  }

  return ranks;
}

/**
 * Compute simple linear regression (y = slope * x + intercept).
 *
 * @param {Array<{x: number, y: number}>} pairs - Array of {x, y} pairs
 * @returns {{slope: number, intercept: number}} Regression coefficients
 */
export function linearRegression(pairs) {
  const n = pairs.length;
  if (n < 2) return { slope: 0, intercept: pairs[0]?.y || 0 };

  const sumX = pairs.reduce((s, p) => s + p.x, 0);
  const sumY = pairs.reduce((s, p) => s + p.y, 0);
  const sumXY = pairs.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = pairs.reduce((s, p) => s + p.x * p.x, 0);

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  return { slope, intercept };
}

// ============================================================================
// Statistical Tests
// ============================================================================

const exactMannWhitneyCache = new Map();

/**
 * Build the exact null distribution for the smaller sample's U statistic.
 * The cache makes repeated comparisons with the same group sizes inexpensive.
 *
 * @param {number} nSmall
 * @param {number} nLarge
 * @returns {{cumulative: Float64Array, total: number}}
 */
function getExactMannWhitneyDistribution(nSmall, nLarge) {
  const key = `${nSmall}:${nLarge}`;
  const cached = exactMannWhitneyCache.get(key);
  if (cached) return cached;

  const n = nSmall + nLarge;
  const minRankSum = (nSmall * (nSmall + 1)) / 2;
  const maxRankSum = (nSmall * (2 * n - nSmall + 1)) / 2;
  const maxU = nSmall * nLarge;
  const rankSumCounts = Array.from(
    { length: nSmall + 1 },
    () => new Float64Array(maxRankSum + 1)
  );
  rankSumCounts[0][0] = 1;

  for (let rank = 1; rank <= n; rank++) {
    for (let selected = Math.min(rank, nSmall); selected >= 1; selected--) {
      for (let sum = maxRankSum; sum >= rank; sum--) {
        rankSumCounts[selected][sum] += rankSumCounts[selected - 1][sum - rank];
      }
    }
  }

  const cumulative = new Float64Array(maxU + 1);
  let running = 0;
  for (let u = 0; u <= maxU; u++) {
    running += rankSumCounts[nSmall][minRankSum + u];
    cumulative[u] = running;
  }

  const distribution = { cumulative, total: running };
  exactMannWhitneyCache.set(key, distribution);
  return distribution;
}

/**
 * Calculate a two-sided Mann-Whitney p-value from a U statistic.
 *
 * Exact inference is used for small, untied inputs. Otherwise this applies the
 * tie-adjusted asymptotic variance and a continuity correction.
 *
 * @param {number} n1 - First sample size
 * @param {number} n2 - Second sample size
 * @param {number} statistic - U statistic (either tail)
 * @param {{tieTerm?: number, allowExact?: boolean}} [options]
 * @returns {{pValue: number, pValueMethod: 'exact'|'asymptotic'}}
 */
export function mannWhitneyPValue(n1, n2, statistic, options = {}) {
  const { tieTerm = 0, allowExact = true } = options;
  const n = n1 + n2;
  const hasTies = tieTerm > 0;
  // Match R's long-standing automatic policy: exact only when both samples
  // contain fewer than 50 finite values and there are no ties.
  const canUseExact = allowExact && !hasTies && n1 < 50 && n2 < 50;

  if (canUseExact) {
    const nSmall = Math.min(n1, n2);
    const nLarge = Math.max(n1, n2);
    const maxU = nSmall * nLarge;
    const observedU = Math.max(0, Math.min(maxU, Math.round(statistic)));
    const lowerU = Math.min(observedU, maxU - observedU);
    const { cumulative, total } = getExactMannWhitneyDistribution(nSmall, nLarge);
    const pValue = Math.min(1, (2 * cumulative[lowerU]) / total);
    return { pValue, pValueMethod: 'exact' };
  }

  const mu = (n1 * n2) / 2;
  const tieAdjustment = n > 1 ? tieTerm / (n * (n - 1)) : 0;
  const variance = (n1 * n2 / 12) * (n + 1 - tieAdjustment);
  if (!(variance > 0)) {
    if (statistic === mu) {
      return { pValue: 1, pValueMethod: 'asymptotic' };
    }
    throw new RangeError(
      'Mann-Whitney variance is zero for a non-null statistic'
    );
  }

  const z = Math.max(0, (Math.abs(statistic - mu) - 0.5) / Math.sqrt(variance));
  const pValue = Math.min(1, Math.max(0, 2 * normalSurvival(z)));
  return { pValue, pValueMethod: 'asymptotic' };
}

/**
 * Mann-Whitney U test (Wilcoxon rank-sum test).
 * Non-parametric test for comparing two independent samples.
 *
 * @param {ArrayLike<number>} group1 - First group of values
 * @param {ArrayLike<number>} group2 - Second group of values
 * @returns {{statistic: number, pValue: number, pValueMethod: 'exact'|'asymptotic', u1: number, u2: number}} Test statistic and p-value
 */
export function mannWhitneyU(group1, group2) {
  const n1 = group1.length;
  const n2 = group2.length;

  if (n1 === 0 || n2 === 0) {
    return {
      statistic: NaN,
      pValue: NaN,
      pValueMethod: 'asymptotic',
      u1: NaN,
      u2: NaN
    };
  }

  // Combine and rank (TypedArray-safe; avoids `.map()` which behaves differently on TypedArrays).
  // Sort an index array so we don't allocate per-element objects.
  const n = n1 + n2;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  const valueAt = (idx) => (idx < n1 ? group1[idx] : group2[idx - n1]);

  order.sort((a, b) => valueAt(a) - valueAt(b));

  // Rank-sum for group 1 with tie handling (no separate ranks[] allocation).
  let R1 = 0;
  let tieTerm = 0;
  let i = 0;
  while (i < n) {
    let j = i + 1;
    const v = valueAt(order[i]);
    while (j < n && valueAt(order[j]) === v) j++;

    const tieCount = j - i;
    if (tieCount > 1) {
      tieTerm += tieCount ** 3 - tieCount;
    }

    const avgRank = (i + j + 1) / 2; // ranks are 1-based
    for (let k = i; k < j; k++) {
      if (order[k] < n1) R1 += avgRank;
    }
    i = j;
  }

  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const U2 = n1 * n2 - U1;
  const U = Math.min(U1, U2);

  const { pValue, pValueMethod } = mannWhitneyPValue(n1, n2, U, { tieTerm });

  return { statistic: U, pValue, pValueMethod, u1: U1, u2: U2 };
}

/**
 * Welch's t-test from precomputed sample moments.
 *
 * @param {number} mean1 - First sample mean
 * @param {number} variance1 - First sample variance (ddof=1)
 * @param {number} n1 - First sample size
 * @param {number} mean2 - Second sample mean
 * @param {number} variance2 - Second sample variance (ddof=1)
 * @param {number} n2 - Second sample size
 * @returns {{statistic: number, pValue: number, df: number}} Test statistic, p-value, and degrees of freedom
 */
export function welchTTestFromMoments(mean1, variance1, n1, mean2, variance2, n2) {
  if (
    n1 < 2 ||
    n2 < 2 ||
    !Number.isFinite(mean1) ||
    !Number.isFinite(mean2) ||
    !Number.isFinite(variance1) ||
    !Number.isFinite(variance2) ||
    variance1 < 0 ||
    variance2 < 0
  ) {
    return { statistic: NaN, pValue: NaN, df: NaN };
  }

  const se = Math.sqrt(variance1 / n1 + variance2 / n2);
  if (se === 0) {
    const difference = mean1 - mean2;
    if (difference === 0) {
      return {
        statistic: 0,
        pValue: 1,
        df: n1 + n2 - 2
      };
    }
    return {
      statistic: difference < 0 ? -Infinity : Infinity,
      pValue: 0,
      df: n1 + n2 - 2
    };
  }

  const t = (mean1 - mean2) / se;

  // Welch-Satterthwaite degrees of freedom
  const num = Math.pow(variance1 / n1 + variance2 / n2, 2);
  const denom =
    Math.pow(variance1 / n1, 2) / (n1 - 1) +
    Math.pow(variance2 / n2, 2) / (n2 - 1);
  const df = num / denom;

  const pValue = tTwoSidedPValue(t, df);

  return { statistic: t, pValue, df };
}

/**
 * Welch's t-test.
 * Parametric test for comparing two independent samples with unequal variances.
 *
 * @param {number[]} group1 - First group of values
 * @param {number[]} group2 - Second group of values
 * @returns {{statistic: number, pValue: number, df: number}} Test statistic, p-value, and degrees of freedom
 */
export function welchTTest(group1, group2) {
  const n1 = group1.length;
  const n2 = group2.length;
  if (n1 < 2 || n2 < 2) {
    return { statistic: NaN, pValue: NaN, df: NaN };
  }

  const mean1 = group1.reduce((sum, value) => sum + value, 0) / n1;
  const mean2 = group2.reduce((sum, value) => sum + value, 0) / n2;
  const variance1 = group1.reduce(
    (sum, value) => sum + (value - mean1) ** 2,
    0
  ) / (n1 - 1);
  const variance2 = group2.reduce(
    (sum, value) => sum + (value - mean2) ** 2,
    0
  ) / (n2 - 1);

  return welchTTestFromMoments(mean1, variance1, n1, mean2, variance2, n2);
}

// ============================================================================
// Binning Functions
// ============================================================================

/**
 * Calculate equal-width bin breaks.
 *
 * @param {number[]} values - Array of numeric values
 * @param {number} count - Number of bins
 * @returns {number[]} Array of bin break points
 */
export function equalWidthBreaks(values, count) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const step = (max - min) / count;

  const breaks = [];
  for (let i = 0; i <= count; i++) {
    breaks.push(min + step * i);
  }
  return breaks;
}

/**
 * Calculate quantile-based bin breaks.
 *
 * @param {number[]} values - Array of numeric values
 * @param {number} count - Number of bins
 * @returns {number[]} Array of bin break points
 */
export function quantileBreaks(values, count) {
  const sorted = [...values].sort((a, b) => a - b);
  const breaks = [sorted[0]];

  for (let i = 1; i < count; i++) {
    const idx = Math.floor((i / count) * sorted.length);
    breaks.push(sorted[idx]);
  }
  breaks.push(sorted[sorted.length - 1]);

  return breaks;
}

// ============================================================================
// Condition Evaluation
// ============================================================================

/**
 * Supported filter operators
 */
export const FilterOperator = {
  EQUALS: 'equals',
  NOT_EQUALS: 'not_equals',
  GREATER_THAN: 'greater_than',
  LESS_THAN: 'less_than',
  GREATER_EQUAL: 'greater_equal',
  LESS_EQUAL: 'less_equal',
  BETWEEN: 'between',
  IN: 'in',
  NOT_IN: 'not_in',
  CONTAINS: 'contains',
  STARTS_WITH: 'starts_with',
  ENDS_WITH: 'ends_with',
  IS_NULL: 'is_null',
  IS_NOT_NULL: 'is_not_null',
  TOP_PERCENT: 'top_percent',
  BOTTOM_PERCENT: 'bottom_percent'
};

/**
 * Evaluate a filter condition against a value.
 *
 * @param {*} value - Value to test
 * @param {{operator: string, value: *}} condition - Condition to evaluate
 * @returns {boolean} Whether the condition passes
 */
export function evaluateCondition(value, condition, thresholds = null) {
  const { operator } = condition;
  const target = condition.value;

  switch (operator) {
    case FilterOperator.EQUALS:
    case 'equals':
      return value === target;
    case FilterOperator.NOT_EQUALS:
    case 'not_equals':
      return value !== target;
    case FilterOperator.GREATER_THAN:
    case 'greater_than':
      return value > target;
    case FilterOperator.LESS_THAN:
    case 'less_than':
      return value < target;
    case FilterOperator.GREATER_EQUAL:
    case 'greater_equal':
      return value >= target;
    case FilterOperator.LESS_EQUAL:
    case 'less_equal':
      return value <= target;
    case FilterOperator.BETWEEN:
    case 'between':
      return value >= target[0] && value <= target[1];
    case FilterOperator.IN:
    case 'in':
      return Array.isArray(target) && target.includes(value);
    case FilterOperator.NOT_IN:
    case 'not_in':
      return Array.isArray(target) && !target.includes(value);
    case FilterOperator.CONTAINS:
    case 'contains':
      return String(value).toLowerCase().includes(String(target).toLowerCase());
    case FilterOperator.STARTS_WITH:
    case 'starts_with':
      return String(value).toLowerCase().startsWith(String(target).toLowerCase());
    case FilterOperator.ENDS_WITH:
    case 'ends_with':
      return String(value).toLowerCase().endsWith(String(target).toLowerCase());
    case FilterOperator.IS_NULL:
    case 'is_null':
      return value === null || value === undefined || value === '' || (typeof value === 'number' && !Number.isFinite(value));
    case FilterOperator.IS_NOT_NULL:
    case 'is_not_null':
      return value !== null && value !== undefined && value !== '' && !(typeof value === 'number' && !Number.isFinite(value));
    case FilterOperator.TOP_PERCENT:
    case 'top_percent':
    case FilterOperator.BOTTOM_PERCENT:
    case 'bottom_percent': {
      const threshold = thresholds?.get?.(`${condition.id}_threshold`);
      if (!threshold) return false;
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      return threshold.type === 'gte' ? value >= threshold.value : value <= threshold.value;
    }
    default:
      return false;
  }
}

// ============================================================================
// Formatting Functions - Import from shared/formatting.js
// ============================================================================

// Import directly from shared/formatting.js for number and p-value formatting
// This module focuses on mathematical computations only

// ============================================================================
// Value Filtering Utilities
// ============================================================================

/**
 * Filter array to only valid numeric values (excludes NaN, null, undefined).
 *
 * @param {Array} values - Array of values
 * @returns {number[]} Array of valid numeric values
 */
export function filterNumeric(values) {
  return values.filter(v => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Check if a value is a valid number (not NaN, not null, not undefined).
 *
 * @param {*} value - Value to check
 * @returns {boolean} True if value is a valid number
 */
export function isValidNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Check if a value is missing (null, undefined, or NaN).
 *
 * @param {*} value - Value to check
 * @returns {boolean} True if value is missing
 */
export function isMissing(value) {
  return value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value));
}

// ============================================================================
// Formatting Utilities (worker-safe)
// ============================================================================

/**
 * Format a number for UI-facing labels (e.g., bin range labels).
 * Worker-safe (no Intl / locale dependencies).
 *
 * @param {number} value
 * @returns {string}
 */
export function formatNumber(value) {
  if (!Number.isFinite(value)) return 'N/A';
  const abs = Math.abs(value);

  // Scientific for very small / very large magnitudes.
  if ((abs > 0 && abs < 0.001) || abs >= 10000) {
    return value.toExponential(2);
  }

  if (abs >= 100) return String(Math.round(value));
  if (abs >= 10) return value.toFixed(1).replace(/\.0$/, '');

  // Keep a couple decimals for small values; trim trailing zeros.
  return value.toFixed(3).replace(/\.?0+$/, '');
}

// ============================================================================
// Default Export
// ============================================================================

export default {
  // Basic statistics
  mean,
  variance,
  std,

  // Distribution functions
  normalCDF,
  normalSurvival,
  tCDF,
  tTwoSidedPValue,
  incompleteBeta,
  gammaLn,
  regularizedGammaP,
  regularizedGammaQ,
  chiSquaredCDF,
  chiSquaredPValue,
  fDistributionPValue,

  // Correlation functions
  computePearsonR,
  computeSpearmanR,
  computeRanks,
  linearRegression,

  // Statistical tests
  mannWhitneyPValue,
  mannWhitneyU,
  welchTTestFromMoments,
  welchTTest,

  // Binning functions
  equalWidthBreaks,
  quantileBreaks,

  // Condition evaluation
  FilterOperator,
  evaluateCondition,

  // Value utilities
  filterNumeric,
  isValidNumber,
  isMissing,
  formatNumber
};
