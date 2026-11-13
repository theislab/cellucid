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
 * Paired (`paired`: the same samples in both of two conditions, a donor's
 * liver and bone marrow), each sample with a unit in both conditions is a
 * pair and the others are left out: `logit` and `clr` take Student's t of
 * the pairs' differences (`scipy.stats.ttest_rel`; for complete pairs, the
 * condition's t of the linear model `~ sample + condition`, propeller's and
 * limma's blocked design without the moderation), `rank` the Wilcoxon
 * signed-rank test of the proportions (as R `wilcox.test(paired = TRUE)`:
 * zero differences dropped; exact below 50 pairs without ties, else the
 * normal approximation with tie and continuity corrections).
 *
 * A type is tested over the pairs holding any of its cells (on either side):
 * in a pair with none on both sides its two transformed proportions are the
 * two units' sizes alone (`0.5 / (total + 0.5·K)`), so the difference is the
 * log ratio of the units' sizes — the same sign for every donor whose one
 * organ gave more cells than the other, which a paired t reads as a change
 * of a type that is not there (measured: 37_decisions_analysis.md). The
 * signed-rank test drops such a pair (a zero difference) and the t-tests drop
 * it too, so the three methods test one set of pairs. Below
 * `MIN_PAIRS_WITH_CELLS` such pairs a type is not tested (`TOO_FEW_PAIRS`):
 * with two, a paired t has one degree of freedom and the signed-rank test
 * cannot reach p < 0.5. It stays in the CLR centre and the pseudo-proportions'
 * K (it has cells), out of the tests and the multiple-testing family.
 * `pairsTested` gives each type's pairs.
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
 * A type with no cells in any unit the test reads (a category the scope, a
 * page or a subsample left out; paired, one whose cells are all in units
 * outside the pairs) is not tested: its transformed proportions would
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
  pairedTTest,
  tTest
} from './statistical-tests.js';
import { chiSquaredIndependence, fisherExact2x2 } from './categorical-tests.js';
import { normalSurvival } from '../compute/math-utils.js';

const COMPOSITION_METHODS = Object.freeze(['logit', 'rank', 'clr']);
const COMPOSITION_CORRECTIONS = Object.freeze(['bh', 'bonferroni']);
const PSEUDOCOUNT = 0.5;
/** The test of a type with no cells in any unit: none, out of the family. */
export const NO_CELLS = 'no cells';
/**
 * The test of a paired type with cells in fewer than `MIN_PAIRS_WITH_CELLS`
 * pairs: none, out of the family.
 */
export const TOO_FEW_PAIRS = 'too few pairs';
/** The pairs holding a type's cells a paired test of it needs. */
export const MIN_PAIRS_WITH_CELLS = 3;

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
 * The exact null distribution of the signed-rank statistic for n pairs:
 * `counts[v]` the subsets of ranks 1..n summing to v, of 2^n.
 */
function signedRankCounts(n) {
  const max = (n * (n + 1)) / 2;
  const counts = new Float64Array(max + 1);
  counts[0] = 1;
  for (let rank = 1; rank <= n; rank++) {
    for (let v = max; v >= rank; v--) counts[v] += counts[v - rank];
  }
  return counts;
}

/**
 * Wilcoxon signed-rank test of paired values `a[i] - b[i]`, two-sided, as R
 * `wilcox.test(a, b, paired = TRUE)` computes it: zero differences dropped;
 * `V` the sum of the ranks (mid-ranks for ties) of the positive
 * differences; the exact p-value below 50 pairs with no tie, else the
 * normal approximation with the tie correction of its variance and a
 * continuity correction. No pair left: no test (NaN).
 *
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {{statistic: number, pValue: number, n: number, exact: boolean}}
 */
export function wilcoxonSignedRank(a, b) {
  const d = [];
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    const difference = a[i] - b[i];
    if (difference !== 0) d.push(difference);
  }
  const n = d.length;
  if (n === 0) return { statistic: NaN, pValue: NaN, n, exact: false };
  const order = d.map((value, index) => index).sort((x, y) => Math.abs(d[x]) - Math.abs(d[y]));
  const ranks = new Float64Array(n);
  let ties = false;
  let tieTerm = 0;
  for (let start = 0; start < n;) {
    let end = start + 1;
    while (end < n && Math.abs(d[order[end]]) === Math.abs(d[order[start]])) end++;
    const size = end - start;
    if (size > 1) {
      ties = true;
      tieTerm += size ** 3 - size;
    }
    const rank = (start + 1 + end) / 2;
    for (let k = start; k < end; k++) ranks[order[k]] = rank;
    start = end;
  }
  let statistic = 0;
  for (let i = 0; i < n; i++) if (d[i] > 0) statistic += ranks[i];
  if (n < 50 && !ties) {
    const counts = signedRankCounts(n);
    const total = 2 ** n;
    let lower = 0;
    for (let v = 0; v <= statistic; v++) lower += counts[v];
    let upper = 0;
    for (let v = statistic; v < counts.length; v++) upper += counts[v];
    return { statistic, pValue: Math.min(1, 2 * Math.min(lower, upper) / total), n, exact: true };
  }
  const mean = (n * (n + 1)) / 4;
  const sigma = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - tieTerm / 48);
  if (!(sigma > 0)) return { statistic, pValue: NaN, n, exact: false };
  const centred = statistic - mean;
  const z = (centred - Math.sign(centred) * 0.5) / sigma;
  return { statistic, pValue: Math.min(1, 2 * normalSurvival(Math.abs(z))), n, exact: false };
}

/**
 * The pairs of a paired composition test: each sample with a unit in both
 * conditions (0 and 1), its unit in each.
 *
 * @param {Int32Array} unitSample - Each unit's sample
 * @param {Int32Array} conditionOfUnit - Each unit's condition (0 or 1)
 * @returns {{first: Int32Array, second: Int32Array, unpaired: number}} The
 *   pairs' units in condition 0 and in condition 1, in sample order; the
 *   units of a sample in one condition only
 */
export function compositionPairs(unitSample, conditionOfUnit) {
  const unitOf = [new Map(), new Map()];
  for (let unit = 0; unit < unitSample.length; unit++) unitOf[conditionOfUnit[unit]].set(unitSample[unit], unit);
  const samples = [...unitOf[0].keys()].filter(sample => unitOf[1].has(sample)).sort((x, y) => x - y);
  return {
    first: Int32Array.from(samples, sample => unitOf[0].get(sample)),
    second: Int32Array.from(samples, sample => unitOf[1].get(sample)),
    unpaired: unitSample.length - 2 * samples.length,
  };
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
 * @param {Int32Array} [input.unitSample] - Each unit's sample (paired only)
 * @param {boolean} [input.paired=false] - Pair each sample's units of the
 *   two conditions (`compositionPairs`); needs samples and two conditions
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
 *   pairs: number|null,
 *   pairsTested: Int32Array|null,
 *   overall: {statistic: number, df: number, pValue: number}|null
 * }} `pairs`: the samples in both conditions (null unpaired);
 *   `pairsTested[type]`: the pairs holding its cells, which its test took
 *   (null unpaired); `meanProportion[type * conditionCount + condition]`
 *   (paired: over the pairs' samples alone); `log2Ratio` is the second
 *   condition's mean proportion over the first's (NaN with other than two
 *   conditions).
 */
export function testComposition(input) {
  const {
    counts, typeCount, unitCount, conditionOfUnit, conditionCount, samples, method, correction,
    unitSample = null, paired = false
  } = input;
  if (paired && (!samples || conditionCount !== 2 || !(unitSample instanceof Int32Array) || unitSample.length !== unitCount)) {
    throw new RangeError('A paired composition test needs samples, each unit\'s sample, and two conditions');
  }
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

  // Paired, the samples in both conditions: the test reads them alone, and so
  // do the mean proportions and their ratio: with every sample, a donor with
  // cells in one condition only would turn the ratio toward that condition
  // against what the paired test finds (measured: 37_decisions_analysis.md).
  const pairing = paired ? compositionPairs(unitSample, conditionOfUnit) : null;
  const meanUnits = pairing === null ? null : new Uint8Array(unitCount);
  if (pairing !== null) for (const unit of [...pairing.first, ...pairing.second]) meanUnits[unit] = 1;
  const unitsOfMean = new Uint32Array(conditionCount);
  for (let unit = 0; unit < unitCount; unit++) {
    if (meanUnits === null || meanUnits[unit] === 1) unitsOfMean[conditionOfUnit[unit]] += 1;
  }
  // Mean proportion per condition: over its samples (paired: those in both
  // conditions), or pooled over its cells without samples (one unit per condition).
  const meanProportion = new Float64Array(typeCount * conditionCount);
  for (let type = 0; type < typeCount; type++) {
    const sums = new Float64Array(conditionCount);
    for (let unit = 0; unit < unitCount; unit++) {
      if (meanUnits !== null && meanUnits[unit] === 0) continue;
      if (totals[unit] > 0) sums[conditionOfUnit[unit]] += counts[type * unitCount + unit] / totals[unit];
    }
    for (let condition = 0; condition < conditionCount; condition++) {
      meanProportion[type * conditionCount + condition] = unitsOfMean[condition] > 0
        ? sums[condition] / unitsOfMean[condition]
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

  let pairs = null;
  let pairsTested = null;
  if (conditionCount < 2) {
    test = 'none';
  } else if (paired) {
    const { first, second } = pairing;
    // The test reads the pairs only: a type with cells only in units left
    // out (a sample in one condition) has none in any unit it tests, and its
    // transformed proportions there would be the pairs' sizes alone, which
    // can come out "significant" with no cell in any pair (measured:
    // 37_decisions_analysis.md). It is not tested.
    const inPairs = new Uint8Array(typeCount);
    for (let type = 0; type < typeCount; type++) {
      for (const unit of [...first, ...second]) {
        if (counts[type * unitCount + unit] > 0) { inPairs[type] = 1; break; }
      }
      if (inPairs[type] === 0) typeTest[type] = NO_CELLS;
    }
    const values = transformedProportions(method, counts, typeCount, unitCount, totals, inPairs);
    pairs = first.length;
    pairsTested = new Int32Array(typeCount);
    test = method === 'rank' ? 'Wilcoxon signed-rank (paired)' : 'paired t-test';
    for (let type = 0; type < typeCount; type++) {
      if (inPairs[type] === 0) continue;
      // Only the pairs holding its cells (above).
      const a = [];
      const b = [];
      for (let pair = 0; pair < pairs; pair++) {
        const one = first[pair];
        const two = second[pair];
        if (counts[type * unitCount + one] === 0 && counts[type * unitCount + two] === 0) continue;
        a.push(values[type * unitCount + one]);
        b.push(values[type * unitCount + two]);
      }
      pairsTested[type] = a.length;
      if (a.length < MIN_PAIRS_WITH_CELLS) {
        typeTest[type] = TOO_FEW_PAIRS;
        continue;
      }
      const result = method === 'rank' ? wilcoxonSignedRank(a, b) : pairedTTest(a, b);
      statistic[type] = result.statistic;
      pValue[type] = result.pValue;
      typeTest[type] = test;
    }
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
    pairs,
    pairsTested,
    overall
  };
}
