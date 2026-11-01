/**
 * @fileoverview The one kernel of the tests of a contingency table, used by
 * the Detailed view (a categorical field across pages) and by Composition
 * (cell types across conditions, cells as replicates): one χ², one Fisher,
 * so a table gets one answer wherever it is tested.
 *
 * - `chiSquaredIndependence`: Pearson's χ² test of independence, with
 *   Yates's continuity correction on a 2 × 2 table (one degree of freedom),
 *   as `scipy.stats.chi2_contingency(correction=True)` and R `chisq.test`
 *   (their defaults) apply it; the uncorrected statistic is reported too,
 *   for Cramér's V.
 * - `fisherExact2x2`: Fisher's exact test of a 2 × 2 table, two-sided as R
 *   `fisher.test`: the tables no more probable than the observed one, within
 *   a relative 1e-7 (R's `relErr`), so tables equally probable in exact
 *   arithmetic are counted whatever the rounding. The probabilities are
 *   taken relative to the observed table's by the hypergeometric ratio
 *   `p(x+1)/p(x)`, one step at a time, and summed scaled, so neither a large
 *   table's log-factorials nor a p-value under 1e-308 lose it.
 *
 * @module analysis/stats/categorical-tests
 */

import { chiSquaredPValue, gammaLn } from '../compute/math-utils.js';

/** R `fisher.test`'s relative tolerance for "as probable as the observed table". */
const FISHER_RELATIVE_TOLERANCE = 1e-7;

function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return gammaLn(n + 1) - gammaLn(k + 1) - gammaLn(n - k + 1);
}

/**
 * Fisher's exact test of the 2 × 2 table [[a, b], [c, d]], two-sided.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @param {number} d
 * @returns {{oddsRatio: number, pValue: number}} The sample odds ratio
 *   `ad / bc` (Infinity when only `bc` is 0, NaN when both are)
 */
export function fisherExact2x2(a, b, c, d) {
  for (const count of [a, b, c, d]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Fisher table counts must be whole numbers');
  }
  const oddsRatio = b * c > 0 ? (a * d) / (b * c) : (a * d > 0 ? Infinity : NaN);
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const total = row1 + row2;
  if (total === 0) return { oddsRatio, pValue: 1 };
  const lowest = Math.max(0, col1 - row2);
  const highest = Math.min(row1, col1);
  // log p(x) - log p(a), one hypergeometric ratio at a time from a.
  const threshold = Math.log1p(FISHER_RELATIVE_TOLERANCE);
  let scaled = 1;
  let log = 0;
  for (let x = a; x < highest; x++) {
    log += Math.log((row1 - x) * (col1 - x)) - Math.log((x + 1) * (row2 - col1 + x + 1));
    if (log <= threshold) scaled += Math.exp(log);
  }
  log = 0;
  for (let x = a; x > lowest; x--) {
    log += Math.log(x * (row2 - col1 + x)) - Math.log((row1 - x + 1) * (col1 - x + 1));
    if (log <= threshold) scaled += Math.exp(log);
  }
  const observed = logChoose(row1, a) + logChoose(row2, c) - logChoose(total, col1);
  return { oddsRatio, pValue: Math.min(1, Math.exp(observed + Math.log(scaled))) };
}

/**
 * Pearson's χ² test of independence of a rows × columns table of counts.
 * Rows or columns with no cells are left out first.
 *
 * @param {number[][]} table
 * @returns {{statistic: number, pearson: number, corrected: boolean, df: number, pValue: number, minExpected: number, rows: number, columns: number, total: number}}
 *   `statistic` with Yates's correction when the table has one degree of
 *   freedom (`corrected`), `pearson` without; `rows`, `columns` the non-empty
 *   ones tested
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
  const rowTotals = observed.map(row => row.reduce((sum, value) => sum + value, 0));
  const columnTotals = keep.map((_, j) => observed.reduce((sum, row) => sum + row[j], 0));
  const total = rowTotals.reduce((sum, value) => sum + value, 0);
  if (r < 2 || c < 2) {
    return { statistic: NaN, pearson: NaN, corrected: false, df: 0, pValue: NaN, minExpected: NaN, rows: r, columns: c, total };
  }
  const df = (r - 1) * (c - 1);
  const corrected = df === 1;
  let statistic = 0;
  let pearson = 0;
  let minExpected = Infinity;
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      const expected = (rowTotals[i] * columnTotals[j]) / total;
      minExpected = Math.min(minExpected, expected);
      const difference = Math.abs(observed[i][j] - expected);
      pearson += (difference * difference) / expected;
      // Yates: |O − E| less a half, never below 0 (SciPy's and R's min(0.5, |O − E|)).
      const yates = corrected ? Math.max(0, difference - 0.5) : difference;
      statistic += (yates * yates) / expected;
    }
  }
  return { statistic, pearson, corrected, df, pValue: chiSquaredPValue(statistic, df), minExpected, rows: r, columns: c, total };
}
