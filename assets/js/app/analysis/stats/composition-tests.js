/**
 * @fileoverview Do cell-type proportions differ between conditions?
 *
 * The input is the cell count of every cell type in every unit — a sample
 * (or a sample within a condition) when the data has samples, else a whole
 * condition. With samples, each type is tested across the units of each
 * condition, so the replicates are samples, not cells:
 *
 * - `logit` (default, after propeller, Phipson et al. 2022): each unit's
 *   proportion `(count + 0.5) / (total + 1)` on the logit scale, then Welch's
 *   t-test for two conditions or a one-way ANOVA for more. propeller's limma
 *   empirical-Bayes moderation is not applied, which is more conservative
 *   with few samples.
 * - `rank`: the proportions, Wilcoxon rank-sum (as R `wilcox.test`) for two
 *   conditions or Kruskal-Wallis for more.
 * - `clr`: the centred log-ratio of each unit's counts (pseudocount 0.5),
 *   then Welch's t-test or ANOVA.
 *
 * Without samples the only replicates are cells, so the tests are
 * descriptive: a χ² test of type × condition, and for each type a 2 × k χ²
 * of that type against the rest (Fisher's exact test for a 2 × 2 table with
 * an expected count below 5; Yates's correction on a 2 × 2 χ², as
 * `scipy.stats.chi2_contingency`).
 *
 * p-values are adjusted over the types (Benjamini-Hochberg or Bonferroni).
 *
 * @module analysis/stats/composition-tests
 */

import {
  benjaminiHochbergAdjusted,
  bonferroniAdjusted,
  kruskalWallis,
  mannWhitneyU,
  oneWayANOVA,
  tTest
} from './statistical-tests.js';
import { chiSquaredPValue, gammaLn } from '../compute/math-utils.js';

export const COMPOSITION_METHODS = Object.freeze(['logit', 'rank', 'clr']);
export const COMPOSITION_CORRECTIONS = Object.freeze(['bh', 'bonferroni']);
const PSEUDOCOUNT = 0.5;

/**
 * Per-unit values of one type for a method.
 *
 * @param {'logit'|'rank'|'clr'} method
 * @param {Uint32Array} counts - `counts[type * unitCount + unit]`
 * @param {number} typeCount
 * @param {number} unitCount
 * @param {Float64Array} totals - Cells per unit.
 * @returns {Float64Array} `values[type * unitCount + unit]`
 */
export function transformedProportions(method, counts, typeCount, unitCount, totals) {
  const out = new Float64Array(typeCount * unitCount);
  if (method === 'clr') {
    for (let unit = 0; unit < unitCount; unit++) {
      let logSum = 0;
      for (let type = 0; type < typeCount; type++) {
        logSum += Math.log(counts[type * unitCount + unit] + PSEUDOCOUNT);
      }
      const centre = logSum / typeCount;
      for (let type = 0; type < typeCount; type++) {
        out[type * unitCount + unit] = Math.log(counts[type * unitCount + unit] + PSEUDOCOUNT) - centre;
      }
    }
    return out;
  }
  for (let type = 0; type < typeCount; type++) {
    for (let unit = 0; unit < unitCount; unit++) {
      const count = counts[type * unitCount + unit];
      if (method === 'logit') {
        const p = (count + PSEUDOCOUNT) / (totals[unit] + 1);
        out[type * unitCount + unit] = Math.log(p / (1 - p));
      } else {
        out[type * unitCount + unit] = totals[unit] > 0 ? count / totals[unit] : NaN;
      }
    }
  }
  return out;
}

function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return gammaLn(n + 1) - gammaLn(k + 1) - gammaLn(n - k + 1);
}

/**
 * Fisher's exact test of a 2 × 2 table, two-sided as SciPy: the tables no
 * more probable than the observed one (relative tolerance 1e-7).
 *
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @param {number} d
 */
export function fisherExact2x2(a, b, c, d) {
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const total = row1 + row2;
  if (total === 0) return { oddsRatio: NaN, pValue: 1 };
  const denominator = logChoose(total, col1);
  const logP = value => logChoose(row1, value) + logChoose(row2, col1 - value) - denominator;
  const observed = logP(a);
  const threshold = observed + Math.log1p(1e-7);
  let p = 0;
  for (let value = Math.max(0, col1 - row2); value <= Math.min(row1, col1); value++) {
    const lp = logP(value);
    if (lp <= threshold) p += Math.exp(lp);
  }
  const oddsRatio = b * c > 0 ? (a * d) / (b * c) : (a * d > 0 ? Infinity : NaN);
  return { oddsRatio, pValue: Math.min(1, p) };
}

/**
 * Pearson's χ² test of independence of a rows × columns table, as
 * `scipy.stats.chi2_contingency` (Yates's correction when it has one degree
 * of freedom). Rows or columns with no cells are dropped first.
 *
 * @param {number[][]} table
 * @returns {{statistic: number, df: number, pValue: number, minExpected: number}}
 */
export function chiSquaredIndependence(table) {
  const rows = table.filter(row => row.some(value => value > 0));
  const columnCount = rows[0]?.length ?? 0;
  const keep = [];
  for (let column = 0; column < columnCount; column++) {
    if (rows.some(row => row[column] > 0)) keep.push(column);
  }
  const observed = rows.map(row => keep.map(column => row[column]));
  const r = observed.length;
  const c = keep.length;
  if (r < 2 || c < 2) return { statistic: NaN, df: 0, pValue: NaN, minExpected: NaN };
  const rowTotals = observed.map(row => row.reduce((sum, value) => sum + value, 0));
  const columnTotals = keep.map((_, j) => observed.reduce((sum, row) => sum + row[j], 0));
  const total = rowTotals.reduce((sum, value) => sum + value, 0);
  const df = (r - 1) * (c - 1);
  let statistic = 0;
  let minExpected = Infinity;
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      const expected = (rowTotals[i] * columnTotals[j]) / total;
      minExpected = Math.min(minExpected, expected);
      let difference = Math.abs(observed[i][j] - expected);
      if (df === 1) difference = Math.max(0, difference - 0.5);
      statistic += (difference * difference) / expected;
    }
  }
  return { statistic, df, pValue: chiSquaredPValue(statistic, df), minExpected };
}

function adjust(pValues, correction) {
  if (correction === 'bh') return benjaminiHochbergAdjusted(pValues).adjustedPValues;
  if (correction === 'bonferroni') return bonferroniAdjusted(pValues).adjustedPValues;
  throw new RangeError(`Unknown multiple-testing correction "${correction}"`);
}

/**
 * Test every cell type.
 *
 * @param {object} input
 * @param {Uint32Array} input.counts - `counts[type * unitCount + unit]`
 * @param {number} input.typeCount
 * @param {number} input.unitCount
 * @param {Int32Array} input.conditionOfUnit - Each unit's condition index.
 * @param {number} input.conditionCount
 * @param {boolean} input.samples - Whether units are samples (replicates).
 * @param {'logit'|'rank'|'clr'} input.method
 * @param {'bh'|'bonferroni'} input.correction
 * @returns {{
 *   test: string,
 *   meanProportion: Float64Array,
 *   log2Ratio: Float64Array,
 *   statistic: Float64Array,
 *   pValue: Float64Array,
 *   typeTest: string[],
 *   adjustedP: Float64Array,
 *   unitsPerCondition: Uint32Array,
 *   overall: {statistic: number, df: number, pValue: number}|null
 * }} `meanProportion[type * conditionCount + condition]`; `log2Ratio` is the
 *   second condition's mean proportion over the first's (NaN with other than
 *   two conditions).
 */
export function testComposition(input) {
  const {
    counts, typeCount, unitCount, conditionOfUnit, conditionCount, samples, method, correction
  } = input;
  if (!COMPOSITION_METHODS.includes(method)) throw new RangeError(`Unknown composition test "${method}"`);
  if (!COMPOSITION_CORRECTIONS.includes(correction)) {
    throw new RangeError(`Unknown multiple-testing correction "${correction}"`);
  }
  if (!(counts instanceof Uint32Array) || counts.length !== typeCount * unitCount) {
    throw new TypeError('Composition counts must be a Uint32Array of types × units');
  }
  if (!(conditionOfUnit instanceof Int32Array) || conditionOfUnit.length !== unitCount) {
    throw new TypeError('Composition needs the condition of every unit');
  }

  const totals = new Float64Array(unitCount);
  for (let type = 0; type < typeCount; type++) {
    for (let unit = 0; unit < unitCount; unit++) totals[unit] += counts[type * unitCount + unit];
  }
  const unitsPerCondition = new Uint32Array(conditionCount);
  for (let unit = 0; unit < unitCount; unit++) unitsPerCondition[conditionOfUnit[unit]] += 1;

  // Mean proportion per condition: over its samples, or pooled over its
  // cells without samples (one unit per condition).
  const meanProportion = new Float64Array(typeCount * conditionCount);
  for (let type = 0; type < typeCount; type++) {
    const sums = new Float64Array(conditionCount);
    for (let unit = 0; unit < unitCount; unit++) {
      if (totals[unit] > 0) sums[conditionOfUnit[unit]] += counts[type * unitCount + unit] / totals[unit];
    }
    for (let condition = 0; condition < conditionCount; condition++) {
      meanProportion[type * conditionCount + condition] = unitsPerCondition[condition] > 0
        ? sums[condition] / unitsPerCondition[condition]
        : NaN;
    }
  }
  const log2Ratio = new Float64Array(typeCount).fill(NaN);
  if (conditionCount === 2) {
    for (let type = 0; type < typeCount; type++) {
      log2Ratio[type] = Math.log2(meanProportion[type * 2 + 1] / meanProportion[type * 2]);
    }
  }

  const statistic = new Float64Array(typeCount).fill(NaN);
  const pValue = new Float64Array(typeCount).fill(NaN);
  // The test each type's statistic belongs to: a 2 × 2 table with small
  // counts takes Fisher's exact test (its statistic is the odds ratio).
  const typeTest = new Array(typeCount).fill('none');
  let test;
  let overall = null;

  if (conditionCount < 2) {
    test = 'none';
  } else if (samples) {
    const values = transformedProportions(method, counts, typeCount, unitCount, totals);
    const two = conditionCount === 2;
    test = method === 'rank'
      ? (two ? 'Wilcoxon rank-sum' : 'Kruskal-Wallis')
      : (two ? "Welch's t-test" : 'One-way ANOVA');
    for (let type = 0; type < typeCount; type++) {
      const groups = Array.from({ length: conditionCount }, () => []);
      for (let unit = 0; unit < unitCount; unit++) {
        groups[conditionOfUnit[unit]].push(values[type * unitCount + unit]);
      }
      let result;
      if (method === 'rank') result = two ? mannWhitneyU(groups[0], groups[1]) : kruskalWallis(groups);
      else result = two ? tTest(groups[0], groups[1]) : oneWayANOVA(groups);
      statistic[type] = result.statistic;
      pValue[type] = result.pValue;
      typeTest[type] = test;
    }
  } else {
    // Cells as replicates: one unit per condition.
    test = 'χ² (cells as replicates)';
    const table = [];
    for (let type = 0; type < typeCount; type++) {
      const row = new Array(conditionCount).fill(0);
      for (let unit = 0; unit < unitCount; unit++) row[conditionOfUnit[unit]] += counts[type * unitCount + unit];
      table.push(row);
    }
    const all = chiSquaredIndependence(table);
    overall = { statistic: all.statistic, df: all.df, pValue: all.pValue };
    const columnTotals = new Array(conditionCount).fill(0);
    for (const row of table) row.forEach((value, column) => { columnTotals[column] += value; });
    for (let type = 0; type < typeCount; type++) {
      const inType = table[type];
      const rest = columnTotals.map((total, column) => total - inType[column]);
      const pair = chiSquaredIndependence([inType, rest]);
      if (conditionCount === 2 && pair.df === 1 && pair.minExpected < 5) {
        const fisher = fisherExact2x2(inType[0], inType[1], rest[0], rest[1]);
        statistic[type] = fisher.oddsRatio;
        pValue[type] = fisher.pValue;
        typeTest[type] = "Fisher's exact";
      } else {
        statistic[type] = pair.statistic;
        pValue[type] = pair.pValue;
        typeTest[type] = 'χ²';
      }
    }
  }

  return {
    test,
    meanProportion,
    log2Ratio,
    statistic,
    pValue,
    typeTest,
    adjustedP: adjust(pValue, correction),
    unitsPerCondition,
    overall
  };
}
