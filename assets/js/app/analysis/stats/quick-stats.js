/**
 * Quick Statistics Module
 *
 * Provides efficient statistical utilities for quick insights and field scoring:
 * - Streaming statistics for large datasets (reservoir sampling)
 * - Field informativeness scoring (entropy, variance, missingness)
 * - Two-page comparison utilities (effect sizes, categorical shifts)
 * - Quick differential expression analysis
 *
 * These functions are designed for performance with large single-cell datasets.
 */

import { normalCDF } from '../compute/math-utils.js';

// =============================================================================
// STREAMING STATISTICS (for huge pages)
// =============================================================================

/**
 * Compute approximate statistics without full sorting
 * Uses reservoir sampling and running statistics
 * @param {number[]} values - Numeric values
 * @param {number} maxSampleSize - Max samples for exact computation (default 10000)
 * @returns {Object} Statistics
 */
export function computeStreamingStats(values, maxSampleSize = 10000) {
  const n = values.length;

  if (n === 0) {
    return { count: 0, min: null, max: null, mean: null, median: null, std: null, approximate: false };
  }

  // For small arrays, compute exact stats
  if (n <= maxSampleSize) {
    const valid = values.filter(v => typeof v === 'number' && Number.isFinite(v));
    if (valid.length === 0) {
      return { count: 0, min: null, max: null, mean: null, median: null, std: null, approximate: false };
    }

    const sorted = [...valid].sort((a, b) => a - b);
    const sum = valid.reduce((a, b) => a + b, 0);
    const mean = sum / valid.length;
    const variance = valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length;
    const mid = Math.floor(valid.length / 2);
    const median = valid.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];

    return {
      count: valid.length,
      min: sorted[0],
      max: sorted[valid.length - 1],
      mean,
      median,
      std: Math.sqrt(variance),
      q1: sorted[Math.floor(valid.length * 0.25)],
      q3: sorted[Math.floor(valid.length * 0.75)],
      approximate: false
    };
  }

  // Streaming computation for large arrays
  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let min = Infinity;
  let max = -Infinity;

  // Reservoir sample for median estimation
  const reservoirSize = Math.min(1000, n);
  const reservoir = new Float64Array(reservoirSize);
  let reservoirFilled = 0;

  // P-square algorithm bins for quantile estimation
  const pSquareN = 5;
  const markers = new Float64Array(pSquareN);
  const markerPos = new Float64Array(pSquareN);
  let pSquareInitialized = false;

  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;

    // Update running stats
    count++;
    sum += v;
    sumSq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;

    // Reservoir sampling
    if (reservoirFilled < reservoirSize) {
      reservoir[reservoirFilled++] = v;
    } else {
      // Randomly replace elements
      const j = Math.floor(Math.random() * count);
      if (j < reservoirSize) {
        reservoir[j] = v;
      }
    }

    // Initialize P-square markers
    if (!pSquareInitialized && count === pSquareN) {
      const sorted = Array.from(reservoir.slice(0, count)).sort((a, b) => a - b);
      for (let k = 0; k < pSquareN; k++) {
        markers[k] = sorted[k];
        markerPos[k] = k;
      }
      pSquareInitialized = true;
    }
  }

  if (count === 0) {
    return { count: 0, min: null, max: null, mean: null, median: null, std: null, approximate: true };
  }

  const mean = sum / count;
  const variance = (sumSq / count) - (mean * mean);

  // Estimate median from reservoir sample
  const sortedReservoir = Array.from(reservoir.slice(0, Math.min(reservoirFilled, reservoirSize)))
    .sort((a, b) => a - b);

  const sampleLen = sortedReservoir.length;
  const midSample = Math.floor(sampleLen / 2);
  const medianEstimate = sampleLen % 2 === 0
    ? (sortedReservoir[midSample - 1] + sortedReservoir[midSample]) / 2
    : sortedReservoir[midSample];

  const q1Estimate = sortedReservoir[Math.floor(sampleLen * 0.25)];
  const q3Estimate = sortedReservoir[Math.floor(sampleLen * 0.75)];

  return {
    count,
    min,
    max,
    mean,
    median: medianEstimate,
    std: Math.sqrt(Math.max(0, variance)),
    q1: q1Estimate,
    q3: q3Estimate,
    approximate: true,
    sampleSize: sampleLen
  };
}

// =============================================================================
// FIELD SCORING (for intelligent selection)
// =============================================================================

/**
 * Compute Shannon entropy for categorical data
 * @param {Map<string, number>} counts - Category counts
 * @param {number} total - Total count
 * @returns {number} Entropy (0 = single category, higher = more diverse)
 */
export function computeEntropy(counts, total) {
  if (total === 0) return 0;

  let entropy = 0;
  for (const count of counts.values()) {
    if (count > 0) {
      const p = count / total;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

/**
 * Compute variance for continuous data (streaming)
 * @param {number[]} values - Numeric values
 * @param {number} sampleSize - Max samples
 * @returns {Object} { variance, coefficient_of_variation }
 */
export function computeVarianceScore(values, sampleSize = 5000) {
  const sampled = values.length <= sampleSize
    ? values
    : values.filter(() => Math.random() < sampleSize / values.length);

  const valid = sampled.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (valid.length < 2) return { variance: 0, cv: 0 };

  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const variance = valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length;
  const cv = mean !== 0 ? Math.sqrt(variance) / Math.abs(mean) : 0;

  return { variance, cv };
}

/**
 * Compute missingness rate
 * @param {any[]} values - Field values
 * @returns {number} Proportion of missing values (0-1)
 */
export function computeMissingness(values) {
  if (values.length === 0) return 1;

  let missing = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === '' ||
        (typeof v === 'number' && !Number.isFinite(v))) {
      missing++;
    }
  }
  return missing / values.length;
}

/**
 * Score a categorical field for informativeness
 * Higher score = more informative/interesting
 * @param {any[]} values - Field values
 * @param {Object} [pageContext] - Optional page context for difference scoring
 * @returns {Object} { score, entropy, missingness, categoryCount }
 */
export function scoreCategoricalField(values, pageContext = null) {
  const counts = new Map();
  let total = 0;

  for (const v of values) {
    if (v !== null && v !== undefined && v !== '') {
      counts.set(v, (counts.get(v) || 0) + 1);
      total++;
    }
  }

  if (total === 0) {
    return { score: 0, entropy: 0, missingness: 1, categoryCount: 0 };
  }

  const entropy = computeEntropy(counts, total);
  const missingness = computeMissingness(values);
  const categoryCount = counts.size;

  // Normalize entropy (0-1 based on max possible)
  const maxEntropy = Math.log2(categoryCount);
  const normalizedEntropy = maxEntropy > 0 ? entropy / maxEntropy : 0;

  // Score formula:
  // - Prefer moderate entropy (not too uniform, not single category)
  // - Penalize high missingness
  // - Bonus for reasonable category count (2-20)
  let score = normalizedEntropy * 0.4;
  score -= missingness * 0.3;
  score += (categoryCount >= 2 && categoryCount <= 20) ? 0.2 : 0;
  score += (categoryCount >= 3 && categoryCount <= 10) ? 0.1 : 0;

  return { score, entropy, normalizedEntropy, missingness, categoryCount };
}

/**
 * Score a continuous field for informativeness
 * @param {number[]} values - Field values
 * @param {Object} [pageContext] - Optional page context for difference scoring
 * @returns {Object} { score, variance, cv, missingness }
 */
export function scoreContinuousField(values, pageContext = null) {
  const { variance, cv } = computeVarianceScore(values);
  const missingness = computeMissingness(values);

  // Score formula:
  // - Prefer higher coefficient of variation (more spread relative to mean)
  // - Penalize high missingness
  const cvScore = Math.min(cv / 2, 1); // Cap CV contribution at 1

  let score = cvScore * 0.5;
  score -= missingness * 0.3;
  score += variance > 0 ? 0.2 : 0;

  return { score, variance, cv, missingness };
}

/**
 * Score fields for "most different between pages"
 * @param {Object[]} pageData - Array of { pageId, pageName, values }
 * @returns {number} Difference score (0-1)
 */
export function scoreFieldDifference(pageData) {
  if (pageData.length < 2) return 0;

  // For categorical: compare distributions
  const isCategorical = typeof pageData[0].values[0] === 'string';

  if (isCategorical) {
    const distributions = pageData.map(pd => {
      const counts = new Map();
      let total = 0;
      for (const v of pd.values) {
        if (v !== null && v !== undefined && v !== '') {
          counts.set(v, (counts.get(v) || 0) + 1);
          total++;
        }
      }
      return { counts, total };
    });

    // Get all categories
    const allCats = new Set();
    for (const { counts } of distributions) {
      for (const cat of counts.keys()) {
        allCats.add(cat);
      }
    }

    // Compute Jensen-Shannon divergence approximation
    let divergence = 0;
    for (const cat of allCats) {
      const props = distributions.map(d =>
        d.total > 0 ? (d.counts.get(cat) || 0) / d.total : 0
      );

      // Max difference for this category
      let maxProp = -Infinity;
      let minProp = Infinity;
      for (let i = 0; i < props.length; i++) {
        const p = props[i];
        if (p > maxProp) maxProp = p;
        if (p < minProp) minProp = p;
      }
      divergence += (maxProp - minProp);
    }

    return Math.min(divergence / allCats.size, 1);
  } else {
    // For continuous: compare means using effect size
    const stats = pageData.map(pd => {
      const valid = pd.values.filter(v => typeof v === 'number' && Number.isFinite(v));
      if (valid.length === 0) return { mean: 0, std: 1, n: 0 };

      const sum = valid.reduce((a, b) => a + b, 0);
      const mean = sum / valid.length;
      const variance = valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length;

      return { mean, std: Math.sqrt(variance), n: valid.length };
    });

    // Compute effect size (Cohen's d approximation)
    if (stats.length === 2 && stats[0].n > 0 && stats[1].n > 0) {
      const pooledStd = Math.sqrt(
        (stats[0].std ** 2 + stats[1].std ** 2) / 2
      );

      if (pooledStd > 0) {
        const effectSize = Math.abs(stats[0].mean - stats[1].mean) / pooledStd;
        return Math.min(effectSize / 2, 1); // Normalize (d=2 -> score=1)
      }
    }

    return 0;
  }
}

// =============================================================================
// TWO-PAGE COMPARISON UTILITIES
// =============================================================================

/**
 * Compute Cohen's d effect size with confidence interval
 * @param {number[]} group1 - First group values
 * @param {number[]} group2 - Second group values
 * @returns {Object} { effectSize, ci95Low, ci95High, interpretation }
 */
export function computeEffectSizeWithCI(group1, group2) {
  const valid1 = group1.filter(v => typeof v === 'number' && Number.isFinite(v));
  const valid2 = group2.filter(v => typeof v === 'number' && Number.isFinite(v));

  const n1 = valid1.length;
  const n2 = valid2.length;

  if (n1 < 2 || n2 < 2) {
    return { effectSize: 0, ci95Low: 0, ci95High: 0, interpretation: 'insufficient data' };
  }

  const mean1 = valid1.reduce((a, b) => a + b, 0) / n1;
  const mean2 = valid2.reduce((a, b) => a + b, 0) / n2;

  const var1 = valid1.reduce((a, b) => a + (b - mean1) ** 2, 0) / (n1 - 1);
  const var2 = valid2.reduce((a, b) => a + (b - mean2) ** 2, 0) / (n2 - 1);

  // Pooled standard deviation (weighted by sample sizes)
  const pooledVar = ((n1 - 1) * var1 + (n2 - 1) * var2) / (n1 + n2 - 2);
  const pooledStd = Math.sqrt(pooledVar);

  if (pooledStd === 0) {
    return { effectSize: 0, ci95Low: 0, ci95High: 0, interpretation: 'no variance' };
  }

  // Cohen's d
  const d = (mean1 - mean2) / pooledStd;

  // Confidence interval using approximation
  // SE(d) ≈ sqrt((n1 + n2)/(n1 * n2) + d^2/(2*(n1 + n2)))
  const se = Math.sqrt((n1 + n2) / (n1 * n2) + (d * d) / (2 * (n1 + n2)));
  const ci95Low = d - 1.96 * se;
  const ci95High = d + 1.96 * se;

  // Interpretation
  const absD = Math.abs(d);
  let interpretation;
  if (absD < 0.2) interpretation = 'negligible';
  else if (absD < 0.5) interpretation = 'small';
  else if (absD < 0.8) interpretation = 'medium';
  else interpretation = 'large';

  return {
    effectSize: d,
    ci95Low,
    ci95High,
    interpretation,
    mean1,
    mean2,
    std1: Math.sqrt(var1),
    std2: Math.sqrt(var2),
    n1,
    n2
  };
}

/**
 * Compute categorical shift metrics between two groups
 * @param {any[]} group1 - First group categorical values
 * @param {any[]} group2 - Second group categorical values
 * @returns {Object[]} Array of category shifts sorted by magnitude
 */
export function computeCategoricalShifts(group1, group2) {
  // Count categories in each group
  const counts1 = new Map();
  const counts2 = new Map();
  let total1 = 0;
  let total2 = 0;

  for (const v of group1) {
    if (v !== null && v !== undefined && v !== '') {
      counts1.set(v, (counts1.get(v) || 0) + 1);
      total1++;
    }
  }

  for (const v of group2) {
    if (v !== null && v !== undefined && v !== '') {
      counts2.set(v, (counts2.get(v) || 0) + 1);
      total2++;
    }
  }

  if (total1 === 0 || total2 === 0) return [];

  // Get all categories
  const allCats = new Set([...counts1.keys(), ...counts2.keys()]);

  const shifts = [];
  for (const cat of allCats) {
    const count1 = counts1.get(cat) || 0;
    const count2 = counts2.get(cat) || 0;
    const prop1 = count1 / total1;
    const prop2 = count2 / total2;
    const diff = prop1 - prop2;
    const absDiff = Math.abs(diff);

    // Log odds ratio for effect size
    const p1 = Math.max(0.001, Math.min(0.999, prop1));
    const p2 = Math.max(0.001, Math.min(0.999, prop2));
    const logOddsRatio = Math.log((p1 / (1 - p1)) / (p2 / (1 - p2)));

    // Standard error for log odds ratio CI
    const se = Math.sqrt(
      1 / (count1 + 0.5) + 1 / (total1 - count1 + 0.5) +
      1 / (count2 + 0.5) + 1 / (total2 - count2 + 0.5)
    );

    shifts.push({
      category: cat,
      count1,
      count2,
      percent1: (prop1 * 100).toFixed(1),
      percent2: (prop2 * 100).toFixed(1),
      percentDiff: (diff * 100).toFixed(1),
      absDiff,
      logOddsRatio: isFinite(logOddsRatio) ? logOddsRatio : 0,
      logOrCiLow: isFinite(logOddsRatio) ? logOddsRatio - 1.96 * se : 0,
      logOrCiHigh: isFinite(logOddsRatio) ? logOddsRatio + 1.96 * se : 0,
      direction: diff > 0 ? 'enriched' : diff < 0 ? 'depleted' : 'unchanged'
    });
  }

  // Sort by absolute difference
  shifts.sort((a, b) => b.absDiff - a.absDiff);

  return shifts;
}

/**
 * Perform quick differential expression analysis between two pages
 * Uses approximate statistics for speed
 * @param {Object} dataLayer - Data layer instance
 * @param {string} pageId1 - First page ID
 * @param {string} pageId2 - Second page ID
 * @param {number} maxGenes - Maximum genes to analyze
 * @returns {Promise<Object[]>} Top differential genes
 */
export async function computeQuickDifferentialExpression(dataLayer, pageId1, pageId2, maxGenes = 50) {
  const geneVars = dataLayer.getAvailableVariables('gene_expression');
  if (geneVars.length === 0) return [];

  const results = [];
  const genesToTest = geneVars.slice(0, Math.min(maxGenes, geneVars.length));

  for (const gene of genesToTest) {
    try {
      const pageData = await dataLayer.getDataForPages({
        type: 'gene_expression',
        variableKey: gene.key,
        pageIds: [pageId1, pageId2]
      });

      if (pageData.length !== 2) continue;

      const [pd1, pd2] = pageData;
      const effect = computeEffectSizeWithCI(pd1.values, pd2.values);

      if (Math.abs(effect.effectSize) > 0.2) { // Only include if at least small effect
        // Compute log2 fold change
        const log2FC = effect.mean1 > 0 && effect.mean2 > 0
          ? Math.log2(effect.mean1 / effect.mean2)
          : 0;

        // Approximate p-value using Welch's t-test approximation
        const t = (effect.mean1 - effect.mean2) / Math.sqrt(
          (effect.std1 ** 2 / effect.n1) + (effect.std2 ** 2 / effect.n2)
        );
        // Approximation for large samples: use normal distribution
        const approxPValue = 2 * (1 - normalCDF(Math.abs(t)));

        results.push({
          gene: gene.key,
          geneName: gene.name || gene.key,
          log2FC,
          effectSize: effect.effectSize,
          effectSizeCiLow: effect.ci95Low,
          effectSizeCiHigh: effect.ci95High,
          pValue: approxPValue,
          mean1: effect.mean1,
          mean2: effect.mean2,
          interpretation: effect.interpretation
        });
      }
    } catch (err) {
      // Skip failed genes
    }
  }

  // Sort by absolute effect size
  results.sort((a, b) => Math.abs(b.effectSize) - Math.abs(a.effectSize));

  return results;
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default {
  // Streaming statistics
  computeStreamingStats,

  // Field scoring
  computeEntropy,
  computeVarianceScore,
  computeMissingness,
  scoreCategoricalField,
  scoreContinuousField,
  scoreFieldDifference,

  // Two-page comparison
  computeEffectSizeWithCI,
  computeCategoricalShifts,
  computeQuickDifferentialExpression
};
