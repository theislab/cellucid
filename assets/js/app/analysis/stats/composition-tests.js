/**
 * @fileoverview Do cell-type proportions differ between conditions?
 *
 * The input is the cell count of every cell type in every unit — a sample
 * (or a sample within a condition) when the data has samples, else a whole
 * condition. With samples, each type is tested across the units of each
 * condition, so the replicates are samples, not cells:
 *
 * - `logit` (default, after propeller, Phipson et al. 2022): each unit's
 *   pseudo-proportions as propeller's `getTransformedProps` takes them,
 *   `(count + 0.5) / (total + 0.5 · K)` over the K types with cells (the
 *   row sums of the table plus 0.5), on the logit scale, then Welch's t-test
 *   for two conditions or a one-way ANOVA for more. propeller's limma
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
 * `scipy.stats.chi2_contingency` and R `chisq.test`): the Detailed view's
 * kernel (`categorical-tests.js`).
 *
 * p-values are adjusted over the types (Benjamini-Hochberg or Bonferroni).
 *
 * A type with no cells in any unit (a category the scope, a page or a
 * subsample left out) is not tested: its transformed proportions would
 * depend only on the unit totals, so an absent type would look changed
 * whenever conditions differ in size. It stays out of the CLR centre, the
 * tests and the multiple-testing family, with NaN statistics and the test
 * `'no cells'`.
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
import { chiSquaredIndependence, fisherExact2x2 } from './categorical-tests.js';

export const COMPOSITION_METHODS = Object.freeze(['logit', 'rank', 'clr']);
export const COMPOSITION_CORRECTIONS = Object.freeze(['bh', 'bonferroni']);
const PSEUDOCOUNT = 0.5;
/** The test of a type with no cells in any unit: none, out of the family. */
export const NO_CELLS = 'no cells';

/**
 * Per-unit values of one type for a method.
 *
 * @param {'logit'|'rank'|'clr'} method
 * @param {Uint32Array} counts - `counts[type * unitCount + unit]`
 * @param {number} typeCount
 * @param {number} unitCount
 * @param {Float64Array} totals - Cells per unit.
 * @param {Uint8Array} present - 1 for a type with cells in some unit; an
 *   absent type is left out of the CLR centre and its values are NaN.
 * @returns {Float64Array} `values[type * unitCount + unit]`
 */
export function transformedProportions(method, counts, typeCount, unitCount, totals, present) {
  const out = new Float64Array(typeCount * unitCount).fill(NaN);
  if (method === 'clr') {
    let presentCount = 0;
    for (let type = 0; type < typeCount; type++) presentCount += present[type];
    for (let unit = 0; unit < unitCount; unit++) {
      let logSum = 0;
      for (let type = 0; type < typeCount; type++) {
        if (present[type] === 1) logSum += Math.log(counts[type * unitCount + unit] + PSEUDOCOUNT);
      }
      const centre = logSum / presentCount;
      for (let type = 0; type < typeCount; type++) {
        if (present[type] === 1) {
          out[type * unitCount + unit] = Math.log(counts[type * unitCount + unit] + PSEUDOCOUNT) - centre;
        }
      }
    }
    return out;
  }
  // propeller's pseudo-proportions: every present type's count plus 0.5,
  // over the unit's total plus 0.5 a present type.
  let presentTypes = 0;
  for (let type = 0; type < typeCount; type++) presentTypes += present[type];
  for (let type = 0; type < typeCount; type++) {
    if (present[type] === 0) continue;
    for (let unit = 0; unit < unitCount; unit++) {
      const count = counts[type * unitCount + unit];
      if (method === 'logit') {
        const p = (count + PSEUDOCOUNT) / (totals[unit] + PSEUDOCOUNT * presentTypes);
        out[type * unitCount + unit] = Math.log(p / (1 - p));
      } else {
        out[type * unitCount + unit] = totals[unit] > 0 ? count / totals[unit] : NaN;
      }
    }
  }
  return out;
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
  // A type with cells in some unit; the others are not tested.
  const present = new Uint8Array(typeCount);
  for (let type = 0; type < typeCount; type++) {
    for (let unit = 0; unit < unitCount; unit++) {
      const count = counts[type * unitCount + unit];
      totals[unit] += count;
      if (count > 0) present[type] = 1;
    }
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
  // counts takes Fisher's exact test (its statistic is the odds ratio); a
  // type with no cells is not tested.
  const typeTest = Array.from(present, isPresent => (isPresent === 1 ? 'none' : NO_CELLS));
  let test;
  let overall = null;

  if (conditionCount < 2) {
    test = 'none';
  } else if (samples) {
    const values = transformedProportions(method, counts, typeCount, unitCount, totals, present);
    const two = conditionCount === 2;
    test = method === 'rank'
      ? (two ? 'Wilcoxon rank-sum' : 'Kruskal-Wallis')
      : (two ? "Welch's t-test" : 'One-way ANOVA');
    for (let type = 0; type < typeCount; type++) {
      if (present[type] === 0) continue;
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
      if (present[type] === 0) continue;
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
