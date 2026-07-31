/**
 * Quick Statistics Module
 *
 * Provides efficient statistical utilities for quick insights and field scoring:
 * - Field informativeness scoring (entropy, variance, missingness)
 * - Two-page comparison utilities (effect sizes, categorical shifts)
 * - Quick differential expression analysis
 *
 * These functions are designed for performance with large single-cell datasets.
 */

import { welchTTest } from '../compute/math-utils.js';
import { benjaminiHochbergTestable } from './statistical-tests.js';
import {
  isFiniteNumber,
  mean as computeMean,
  std as computeStd,
  variance as computeVar,
  filterFiniteNumbers
} from '../shared/number-utils.js';

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
 * Compute exact variance for continuous data
 * @param {number[]} values - Numeric values
 * @returns {Object} { variance, coefficient_of_variation }
 */
export function computeVarianceScore(values) {
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) {
    throw new TypeError('Variance scoring values must be an array or typed array');
  }
  const valid = filterFiniteNumbers(values);
  if (valid.length < 2) return { variance: null, cv: null };

  const meanVal = computeMean(valid);
  const varianceVal = computeVar(valid);
  const standardDeviation = Math.sqrt(varianceVal);
  const cv = meanVal === 0
    ? (standardDeviation === 0 ? null : Infinity)
    : standardDeviation / Math.abs(meanVal);

  return { variance: varianceVal, cv };
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
        (typeof v === 'number' && !isFiniteNumber(v))) {
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
  if (variance === null || cv === null) {
    return { score: null, variance, cv, missingness };
  }

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
      const valid = filterFiniteNumbers(pd.values);
      if (valid.length === 0) return { mean: 0, std: 1, n: 0 };

      return {
        mean: computeMean(valid),
        std: computeStd(valid),
        n: valid.length
      };
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
 * Rows are listed only when |Cohen's d| exceeds this. It is a reporting rule,
 * not part of the test: it is applied after every gene has been tested and
 * corrected, so it never conditions a probability. 0.2 is the conventional
 * "negligible" boundary, the same cut `computeEffectSizeWithCI` labels with.
 */
const EFFECT_SIZE_REPORTING_THRESHOLD = 0.2;

/**
 * Compute Cohen's d effect size with confidence interval
 * @param {number[]} group1 - First group values
 * @param {number[]} group2 - Second group values
 * @returns {Object} { effectSize, ci95Low, ci95High, interpretation }
 */
export function computeEffectSizeWithCI(group1, group2) {
  const valid1 = group1.filter(v => isFiniteNumber(v));
  const valid2 = group2.filter(v => isFiniteNumber(v));

  const n1 = valid1.length;
  const n2 = valid2.length;

  if (n1 < 2 || n2 < 2) {
    return { effectSize: 0, ci95Low: 0, ci95High: 0, interpretation: 'insufficient data' };
  }

  const mean1 = computeMean(valid1);
  const mean2 = computeMean(valid2);

  // Sample variance uses (n-1) denominator (Bessel's correction) for unbiased estimate
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

    // Haldane–Anscombe correction gives a finite, disclosed 2×2 odds ratio
    // when any cell count is zero.
    const selected1 = count1 + 0.5;
    const other1 = total1 - count1 + 0.5;
    const selected2 = count2 + 0.5;
    const other2 = total2 - count2 + 0.5;
    const logOddsRatio = Math.log(
      (selected1 / other1) / (selected2 / other2)
    );
    const se = Math.sqrt(
      1 / selected1 + 1 / other1 + 1 / selected2 + 1 / other2
    );

    shifts.push({
      category: cat,
      count1,
      count2,
      percent1: prop1 * 100,
      percent2: prop2 * 100,
      percentDiff: diff * 100,
      absDiff,
      logOddsRatio,
      logOrCiLow: logOddsRatio - 1.96 * se,
      logOrCiHigh: logOddsRatio + 1.96 * se,
      direction: diff > 0 ? 'enriched' : diff < 0 ? 'depleted' : 'unchanged'
    });
  }

  // Sort by absolute difference
  shifts.sort((a, b) => b.absDiff - a.absDiff);

  return shifts;
}

/**
 * Quick differential expression between two pages.
 *
 * Every gene in the family is tested. That ordering matters: Cohen's d and the
 * Welch t statistic share the numerator `mean1 - mean2`, so filtering on
 * `|d| > EFFECT_SIZE_REPORTING_THRESHOLD` before testing is filtering on the
 * test statistic itself, and a nominal p reported after such a selection is not
 * the probability it appears to be. The correction is therefore applied to the
 * whole family, and the effect-size rule is applied afterwards, to decide which
 * rows are worth listing rather than which genes were examined.
 *
 * The pre-filter still shapes the interpretation of what comes back: `results`
 * is a subset chosen by observed effect size, so it is not a random sample of
 * the family and the listed rows are enriched for large effects by
 * construction. What it no longer does is condition the probabilities. Each row
 * carries both numbers - `pValue`, the nominal Welch probability for that gene
 * alone, and `adjustedPValue`, the Benjamini-Hochberg value over the family of
 * `genesTested` genes - so neither can be mistaken for the other.
 *
 * @param {Object} dataLayer - Data layer instance
 * @param {string} pageId1 - First page ID
 * @param {string} pageId2 - Second page ID
 * @param {number} maxGenes - Size of the family to examine
 * @returns {Promise<{
 *   genesTested: number,
 *   genesUntestable: number,
 *   effectSizeThreshold: number,
 *   results: Object[]
 * }>} The correction's denominator, the untestable remainder, the effect-size
 *   rule the rows were selected by, and the selected rows
 */
export async function computeQuickDifferentialExpression(dataLayer, pageId1, pageId2, maxGenes = 50) {
  if (
    !dataLayer ||
    typeof dataLayer.getAvailableVariables !== 'function' ||
    typeof dataLayer.getDataForPages !== 'function'
  ) {
    throw new TypeError('Quick differential expression requires a complete data layer');
  }
  if (
    typeof pageId1 !== 'string' ||
    pageId1.length === 0 ||
    typeof pageId2 !== 'string' ||
    pageId2.length === 0 ||
    pageId1 === pageId2
  ) {
    throw new TypeError('Quick differential expression requires two distinct page IDs');
  }
  if (!Number.isSafeInteger(maxGenes) || maxGenes < 1) {
    throw new RangeError('Quick differential expression maxGenes must be a positive integer');
  }
  const geneVars = dataLayer.getAvailableVariables('gene_expression');
  if (!Array.isArray(geneVars)) {
    throw new TypeError('Gene variable discovery must return an array');
  }
  if (geneVars.length === 0) {
    return {
      genesTested: 0,
      genesUntestable: 0,
      effectSizeThreshold: EFFECT_SIZE_REPORTING_THRESHOLD,
      results: []
    };
  }

  const examined = [];
  const genesToTest = geneVars.slice(0, maxGenes);

  for (const gene of genesToTest) {
    if (
      !gene ||
      typeof gene.key !== 'string' ||
      gene.key.length === 0 ||
      typeof gene.name !== 'string' ||
      gene.name.length === 0
    ) {
      throw new TypeError('Every gene variable requires exact key and name strings');
    }
    const pageData = await dataLayer.getDataForPages({
      type: 'gene_expression',
      variableKey: gene.key,
      pageIds: [pageId1, pageId2]
    });

    if (!Array.isArray(pageData) || pageData.length !== 2) {
      throw new TypeError(`Gene ${gene.key} must return data for exactly two pages`);
    }

    const [pd1, pd2] = pageData;
    if (!pd1 || !pd2 || !pd1.values || !pd2.values) {
      throw new TypeError(`Gene ${gene.key} page values are required`);
    }
    const values1 = filterFiniteNumbers(pd1.values);
    const values2 = filterFiniteNumbers(pd2.values);
    if (values1.length < 2 || values2.length < 2) {
      throw new RangeError(`Gene ${gene.key} requires at least two finite values per page`);
    }
    const effect = computeEffectSizeWithCI(values1, values2);
    // Tested before any selection, so the probability is not conditioned on the
    // effect size the row is later chosen by.
    const { pValue } = welchTTest(values1, values2);
    examined.push({ gene, effect, pValue });
  }

  const {
    adjustedPValues,
    testedCount,
    untestableCount
  } = benjaminiHochbergTestable(examined.map(entry => entry.pValue));

  const results = [];
  for (const [index, { gene, effect, pValue }] of examined.entries()) {
    if (Math.abs(effect.effectSize) <= EFFECT_SIZE_REPORTING_THRESHOLD) continue;
    if (effect.mean1 < 0 || effect.mean2 < 0) {
      throw new RangeError(`Gene ${gene.key} has a negative mean and no defined log2 fold change`);
    }

    results.push({
      gene: gene.key,
      geneName: gene.name,
      log2FC: Math.log2(effect.mean1 / effect.mean2),
      effectSize: effect.effectSize,
      effectSizeCiLow: effect.ci95Low,
      effectSizeCiHigh: effect.ci95High,
      pValue,
      adjustedPValue: adjustedPValues[index],
      mean1: effect.mean1,
      mean2: effect.mean2,
      interpretation: effect.interpretation
    });
  }

  // Sort by absolute effect size
  results.sort((a, b) => Math.abs(b.effectSize) - Math.abs(a.effectSize));

  return {
    genesTested: testedCount,
    genesUntestable: untestableCount,
    effectSizeThreshold: EFFECT_SIZE_REPORTING_THRESHOLD,
    results
  };
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default {
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
