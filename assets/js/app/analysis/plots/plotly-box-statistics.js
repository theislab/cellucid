/**
 * Box statistics computed exactly as the vendored Plotly (2.27.0, box `calc`,
 * `quartilemethod: 'linear'`, `sdmultiple: 1`) computes them from raw values.
 *
 * Handing Plotly one million raw values makes its box `calc` build a point
 * object per value, bin it, and sort the objects through a comparator — about
 * 0.7 s of main-thread work before anything is drawn. Plotly's precomputed mode
 * takes the statistics instead, plus only the points it will draw (the
 * outliers, or every value when all points are shown). Given the statistics
 * below it builds the identical calcdata: the same quartiles, fences, mean,
 * standard deviation, notch span, minimum and maximum, so the same box,
 * whiskers, hover rows and autorange; the outliers are drawn at the same
 * positions, with a stack of identical outliers capped at
 * `COINCIDENT_OUTLIER_COPIES` copies (see there).
 *
 * The arithmetic mirrors Plotly's `Lib.interp`, `Lib.findBin`, `Lib.mean` and
 * `Lib.stdev` operation for operation, over the same ascending order, so every
 * statistic is bit-identical. tests/analysis-box-statistics-identity.test.mjs
 * and tests/browser/analysis-box-statistics-identity.spec.mjs hold it to that.
 *
 * @module plots/plotly-box-statistics
 */

import { sortedAscending } from '../compute/math-utils.js';

/** Plotly `Lib.findBin` tolerance. */
const FIND_BIN_ROUNDING = 1e-9;

/**
 * Plotly `Lib.interp`.
 * @param {Float64Array} sorted
 * @param {number} fraction
 */
function interp(sorted, fraction) {
  const n = fraction * sorted.length - 0.5;
  if (n < 0) return sorted[0];
  if (n > sorted.length - 1) return sorted[sorted.length - 1];
  const frac = n % 1;
  return frac * sorted[Math.ceil(n)] + (1 - frac) * sorted[Math.floor(n)];
}

/**
 * Plotly `Lib.findBin` over a sorted array of bin edges.
 * @param {number} value
 * @param {Float64Array} edges
 * @param {boolean} [strict]
 */
function findBin(value, edges, strict = false) {
  let low = 0;
  let high = edges.length;
  let steps = 0;
  const slope = high > 1 ? (edges[high - 1] - edges[0]) / (high - 1) : 1;
  let compare;
  if (slope >= 0) compare = strict ? (a, b) => a < b : (a, b) => a <= b;
  else compare = strict ? (a, b) => a >= b : (a, b) => a > b;
  const target = value + slope * FIND_BIN_ROUNDING * (strict ? -1 : 1) * (slope >= 0 ? 1 : -1);
  while (low < high && steps++ < 100) {
    const middle = Math.floor((low + high) / 2);
    if (compare(edges[middle], target)) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/**
 * Finite values in the order Plotly's stable comparator sort leaves them:
 * ascending, with ties in input order. Among numbers only the signed zeros are
 * distinguishable ties, so the zero run is rewritten in input order after an
 * ordinary numeric sort (which places -0 before +0). The numeric sort is the
 * linear-time `sortedAscending`, which orders exactly as the native sort does.
 *
 * @param {ArrayLike<number>} values - Finite numbers
 * @returns {Float64Array}
 */
export function sortLikePlotly(values) {
  const sorted = sortedAscending(values);
  let zeroStart = -1;
  let zeroEnd = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] === 0) {
      if (zeroStart === -1) zeroStart = i;
      zeroEnd = i + 1;
    } else if (zeroStart !== -1) {
      break;
    }
  }
  if (zeroStart !== -1) {
    let write = zeroStart;
    for (let i = 0; i < values.length && write < zeroEnd; i++) {
      if (values[i] === 0) sorted[write++] = values[i];
    }
  }
  return sorted;
}

/**
 * @typedef {Object} PlotlyBoxStatistics
 * @property {number} q1
 * @property {number} median
 * @property {number} q3
 * @property {number} lowerfence
 * @property {number} upperfence
 * @property {number} mean
 * @property {number} sd
 * @property {number} notchspan
 * @property {Float64Array} sorted - Every value, ascending as Plotly orders it
 */

/**
 * The statistics Plotly's raw-value box `calc` derives from these values.
 *
 * @param {ArrayLike<number>} values - At least one finite number
 * @returns {PlotlyBoxStatistics}
 */
export function plotlyBoxStatistics(values) {
  if (values.length === 0) {
    throw new RangeError('Box statistics require at least one value');
  }
  return statisticsOfSorted(sortLikePlotly(values));
}

/**
 * The box `calc` statistics of values already in Plotly's order.
 * @param {Float64Array} sorted
 * @returns {PlotlyBoxStatistics}
 */
function statisticsOfSorted(sorted) {
  const count = sorted.length;
  const median = interp(sorted, 0.5);
  const q1 = interp(sorted, 0.25);
  const q3 = interp(sorted, 0.75);
  let sum = 0;
  for (let i = 0; i < count; i++) sum = sum + sorted[i];
  const mean = sum / count;
  let squares = 0;
  for (let i = 0; i < count; i++) squares = squares + Math.pow(sorted[i] - mean, 2);
  const sd = Math.sqrt(squares / count);
  // `Lib.stdev(values, count - 1, mean)`: the sample deviation a violin's
  // bandwidth is taken from.
  const sampleSd = Math.sqrt(squares / (count - 1 || count));
  const lowerfence = Math.min(
    q1,
    sorted[Math.min(findBin(2.5 * q1 - 1.5 * q3, sorted, true) + 1, count - 1)]
  );
  const upperfence = Math.max(
    q3,
    sorted[Math.max(findBin(2.5 * q3 - 1.5 * q1, sorted), 0)]
  );
  const notchspan = 1.57 * (q3 - q1) / Math.sqrt(count);
  return { q1, median, q3, lowerfence, upperfence, mean, sd, sampleSd, notchspan, sorted };
}

/**
 * How many copies of one outlier value are drawn.
 *
 * Outliers are drawn without jitter, on the box's own axis line, so every copy
 * of a value lands on the same spot: a zero-inflated gene whose quartiles are
 * all zero makes every expressing cell an outlier, and Plotly draws one SVG
 * element per point — 170,000 elements, and a second of main-thread work, for
 * a one-million-cell page. Past a handful of copies a stack is visually
 * complete: each copy is drawn at marker opacity 0.8, so 16 copies leave the
 * stack's interior 0.2^16 short of opaque, far below one 8-bit colour step.
 * Only the anti-aliased rim keeps converging with more copies: a rim pixel a
 * quarter covered is already 97% of the way to its limit. Only identical
 * values are merged — distinct values are never moved or
 * dropped — so every drawn position, the hover text, the minimum and maximum
 * and the autorange are those of the full point list.
 */
export const COINCIDENT_OUTLIER_COPIES = 16;

/**
 * The values Plotly draws as points: those outside the fences — at most
 * `COINCIDENT_OUTLIER_COPIES` copies of each value, all of which land on one
 * spot — or every value (jittered, so copies are spread and all are kept).
 *
 * @param {PlotlyBoxStatistics} statistics
 * @param {'outliers'|'all'} points
 * @returns {Float64Array}
 */
export function plotlyBoxPoints(statistics, points) {
  const { sorted, lowerfence, upperfence } = statistics;
  if (points === 'all') return sorted;
  let below = 0;
  while (below < sorted.length && sorted[below] < lowerfence) below++;
  let above = sorted.length;
  while (above > below && sorted[above - 1] > upperfence) above--;
  const outliers = new Float64Array(below + sorted.length - above);
  let count = 0;
  const keep = (from, to) => {
    let run = 0;
    for (let i = from; i < to; i++) {
      run = i > from && sorted[i] === sorted[i - 1] ? run + 1 : 0;
      if (run < COINCIDENT_OUTLIER_COPIES) outliers[count++] = sorted[i];
    }
  };
  keep(0, below);
  keep(above, sorted.length);
  return count === outliers.length ? outliers : outliers.slice(0, count);
}

/**
 * Whether Plotly's precomputed mode can carry these statistics unchanged. It
 * rejects a median outside the quartiles, which rounding can produce by one
 * unit in the last place when the quartiles fall inside a run of tied values;
 * the raw-value path draws that box as is.
 *
 * @param {PlotlyBoxStatistics} statistics
 */
export function isPlotlyPrecomputable(statistics) {
  return statistics.median >= statistics.q1 && statistics.q3 >= statistics.median;
}

/**
 * @typedef {Object} PlotlyBoxSummary
 * @property {number} q1
 * @property {number} median
 * @property {number} q3
 * @property {number} lowerfence
 * @property {number} upperfence
 * @property {number} mean
 * @property {number} sd
 * @property {number} notchspan
 * @property {Float64Array} points - The values the box draws as points
 */

/**
 * Everything a precomputed box trace carries: the statistics and the points
 * it draws. This is what a box plot hands Plotly, computed on the calling
 * thread for a small page and by an analysis worker for a large one.
 *
 * @param {ArrayLike<number>} values - At least one finite number
 * @param {'outliers'|'all'} points
 * @returns {PlotlyBoxSummary}
 */
export function plotlyBoxSummary(values, points) {
  const statistics = plotlyBoxStatistics(values);
  return {
    q1: statistics.q1,
    median: statistics.median,
    q3: statistics.q3,
    lowerfence: statistics.lowerfence,
    upperfence: statistics.upperfence,
    mean: statistics.mean,
    sd: statistics.sd,
    notchspan: statistics.notchspan,
    points: plotlyBoxPoints(statistics, points)
  };
}

/**
 * @typedef {Object} PlotlyViolinBox
 * @property {number} min
 * @property {number} max
 * @property {number} mean
 * @property {number} sd - Before Plotly multiplies it by the trace's `sdmultiple`
 * @property {number} sampleSd - The sample standard deviation the violin calc
 *   takes its bandwidth from
 * @property {number} med
 * @property {number} q1
 * @property {number} q3
 * @property {number} lf
 * @property {number} uf
 * @property {number} lo
 * @property {number} uo
 * @property {number} ln
 * @property {number} un
 * @property {Array<{v: number, i: number}>} pts - The points the violin
 *   draws with `points: 'outliers'` (none with `points: false`), as Plotly's
 *   point records: the value and its index in the trace's values
 */

/**
 * The calcdata entry Plotly's raw-value box `calc` builds for a violin of
 * values handed to it in its own order (`quartilemethod: 'linear'`), for the
 * vendored bundle's precomputed violin calc (`_precomputedViolin`): the same
 * fields, each the same double. Plotly's own entry keeps a record for every
 * value; this one keeps the records the violin draws, which are the only ones
 * anything reads once the values themselves are carried as an array. As for a
 * box, a stack of identical outliers is drawn with at most
 * `COINCIDENT_OUTLIER_COPIES` copies.
 *
 * @param {Float64Array} sorted - Finite values, ascending as Plotly orders them
 * @param {'outliers'|'none'} points
 * @returns {PlotlyViolinBox}
 */
export function plotlyViolinBox(sorted, points) {
  if (!(sorted instanceof Float64Array) || sorted.length === 0) {
    throw new RangeError('A violin box needs at least one value in Plotly order');
  }
  if (points !== 'outliers' && points !== 'none') {
    throw new RangeError('A precomputed violin draws outliers or no points');
  }
  const statistics = statisticsOfSorted(sorted);
  const { q1, q3, median: med, lowerfence: lf, upperfence: uf } = statistics;
  const pts = [];
  if (points === 'outliers') {
    const keep = (from, to) => {
      let run = 0;
      for (let i = from; i < to; i++) {
        run = i > from && sorted[i] === sorted[i - 1] ? run + 1 : 0;
        if (run < COINCIDENT_OUTLIER_COPIES) pts.push({ v: sorted[i], i });
      }
    };
    let below = 0;
    while (below < sorted.length && sorted[below] < lf) below++;
    let above = sorted.length;
    while (above > below && sorted[above - 1] > uf) above--;
    keep(0, below);
    keep(above, sorted.length);
  }
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: statistics.mean,
    sd: statistics.sd,
    sampleSd: statistics.sampleSd,
    med,
    q1,
    q3,
    lf,
    uf,
    lo: 4 * q1 - 3 * q3,
    uo: 4 * q3 - 3 * q1,
    ln: med - statistics.notchspan,
    un: med + statistics.notchspan,
    pts
  };
}
