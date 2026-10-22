/**
 * A histogram sample that the vendored Plotly (2.27.0, histogram `calc`) bins
 * into exactly the histogram it draws from every raw value.
 *
 * Handed one million raw values, Plotly's histogram `calc` assigns each one to
 * a bin and records it there — a per-value pass on the main thread that grows
 * with the page (about 0.2 s for a million cells, two seconds for ten). With
 * explicit bins (`xbins.start` and `xbins.size`) Plotly assigns a value `v` to
 * bin `floor((v - start) / size + 1e-9)` (`Lib.findBin`); this module groups
 * the values by that same expression and hands Plotly, per occupied bin, at
 * most three of the bin's own values with `histfunc: 'sum'` weights:
 *
 * - the bin's first value in input order, weighted by the bin's count;
 * - the bin's smallest and largest values, weighted 0 (omitted when they are
 *   the first value).
 *
 * Every representative is a real value of its bin, so Plotly assigns it to the
 * same bin by the same expression, and summing the weights gives the same
 * integer count per bin and the same total, hence the same bar heights under
 * every `histnorm` and `cumulative` setting. The bin-range hover labels depend
 * on the data through three things only — the smallest distance from a value
 * to its bin's lower edge, the smallest distance to its upper edge, and
 * whether every bin holds a single repeated value (then the label is the
 * bin's first value) — and the first, smallest and largest values of each bin
 * reproduce all three. tests/analysis-histogram-bins-identity.test.mjs and
 * tests/browser/analysis-histogram-bins-identity.spec.mjs hold the drawn
 * histogram to Plotly's raw-value one.
 *
 * @module plots/plotly-histogram-bins
 */

import { finiteNumbers } from '../shared/number-utils.js';

/** Plotly `Lib.findBin` rounding tolerance for explicit bins. */
const FIND_BIN_ROUNDING = 1e-9;

/** Bins counted in flat arrays; the histogram draws at most 100. */
const DIRECT_BINS = 1024;

/**
 * The representative sample of finite values for explicit bins.
 *
 * @param {ArrayLike<number>} values - Finite numbers
 * @param {{start: number, size: number}} bins - The trace's `xbins`
 * @returns {{x: Float64Array, y: Float64Array}} Values and `sum` weights
 */
export function plotlyHistogramSample(values, bins) {
  const { start, size } = bins;
  if (!Number.isFinite(start) || !(size > 0) || !Number.isFinite(size)) {
    throw new RangeError('Histogram bins need a finite start and a positive finite size');
  }
  // Bins 0 … DIRECT_BINS - 1 (every bin a histogram here draws) are counted in
  // flat arrays; any other bin is kept in a map.
  const count = new Float64Array(DIRECT_BINS);
  const first = new Float64Array(DIRECT_BINS);
  const min = new Float64Array(DIRECT_BINS);
  const max = new Float64Array(DIRECT_BINS);
  /** @type {Map<number, {first: number, min: number, max: number, count: number}>} */
  const others = new Map();
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const bin = Math.floor((value - start) / size + FIND_BIN_ROUNDING);
    if (bin >= 0 && bin < DIRECT_BINS) {
      if (count[bin] === 0) {
        first[bin] = value;
        min[bin] = value;
        max[bin] = value;
      } else {
        if (value < min[bin]) min[bin] = value;
        if (value > max[bin]) max[bin] = value;
      }
      count[bin]++;
      continue;
    }
    const group = others.get(bin);
    if (group === undefined) {
      others.set(bin, { first: value, min: value, max: value, count: 1 });
    } else {
      group.count++;
      if (value < group.min) group.min = value;
      if (value > group.max) group.max = value;
    }
  }
  const x = [];
  const y = [];
  const emit = (binFirst, binMin, binMax, binCount) => {
    x.push(binFirst);
    y.push(binCount);
    if (!Object.is(binMin, binFirst)) {
      x.push(binMin);
      y.push(0);
    }
    if (!Object.is(binMax, binFirst) && !Object.is(binMax, binMin)) {
      x.push(binMax);
      y.push(0);
    }
  };
  for (let bin = 0; bin < DIRECT_BINS; bin++) {
    if (count[bin] > 0) emit(first[bin], min[bin], max[bin], count[bin]);
  }
  for (const group of others.values()) {
    emit(group.first, group.min, group.max, group.count);
  }
  return { x: Float64Array.from(x), y: Float64Array.from(y) };
}

/**
 * @typedef {Object} HistogramSamples
 * @property {number} min - Smallest finite value over every page
 * @property {number} max - Largest finite value over every page
 * @property {number} size - Bin width, `(max - min) / nbins`
 * @property {Array<{x: Float64Array, y: Float64Array}|null>} samples - Per page;
 *   null for a page with no finite value or when the bins have no width
 */

/**
 * The shared bins of a histogram's pages and each page's representative
 * sample: everything the histogram traces carry. Computed on the calling
 * thread for small pages and by an analysis worker for large ones.
 *
 * @param {ArrayLike<number>[]} pages - Each page's values
 * @param {number} nbins
 * @returns {HistogramSamples}
 */
export function histogramSamples(pages, nbins) {
  let min = Infinity;
  let max = -Infinity;
  const finitePages = pages.map(finiteNumbers);
  for (const values of finitePages) {
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new RangeError('Plot range requires at least one finite numeric value');
  }
  const size = (max - min) / nbins;
  const binned = size > 0 && Number.isFinite(size);
  const samples = finitePages.map(values => (
    values.length > 0 && binned ? plotlyHistogramSample(values, { start: min, size }) : null
  ));
  return { min, max, size, samples };
}
