/**
 * @fileoverview Per-group expression summaries of a gene — what a dot plot
 * draws (scanpy `pl.dotplot` / `pl.matrixplot`).
 *
 * For each group: the sum of the gene's values, the number of cells whose
 * value is above the expression cutoff, and the sum over those cells. The
 * mean, the fraction expressing and the mean of the expressing cells follow
 * from these and the group's size. One pass over the gene's non-zero entries,
 * O(nnz); zero entries are accounted per group at once.
 *
 * @module analysis/compute/group-expression-summary
 */

import { geneSampleOf } from './gene-statistics.js';
import { formatCountOf } from '../../../utils/format-units.js';

/**
 * The cells of a dot plot: each cell's group (-1 for none) and each group's
 * size.
 *
 * @param {Int16Array|Int32Array} cellGroup
 * @param {number} groupCount
 */
export function createGroupSummaryContext(cellGroup, groupCount) {
  if (!(cellGroup instanceof Int16Array) && !(cellGroup instanceof Int32Array)) {
    throw new TypeError('Group summary cell groups must be an Int16Array or Int32Array');
  }
  if (!Number.isSafeInteger(groupCount) || groupCount < 1) {
    throw new RangeError('Group summary needs at least one group');
  }
  const sizes = new Uint32Array(groupCount);
  for (let cell = 0; cell < cellGroup.length; cell++) {
    const group = cellGroup[cell];
    if (group < -1 || group >= groupCount) {
      throw new RangeError(`Group summary cell ${cell} names group ${group} of ${groupCount}`);
    }
    if (group >= 0) sizes[group] += 1;
  }
  return { cellGroup, groupCount, sizes };
}

/**
 * Summarise genes over the groups of a context.
 *
 * @param {ReturnType<typeof createGroupSummaryContext>} context
 * @param {Array<Float32Array|{length: number, indices: Uint32Array, values: Float32Array|Float64Array}>} genes
 * @param {number} cutoff - A value above it counts as expressed (scanpy
 *   `expression_cutoff`, `>`).
 * @param {number} [bins=0] - With bins, also each gene's distribution in
 *   each group: `bins` equal bins over the gene's range in the grouped cells
 *   (zero included), for a stacked violin.
 * @returns {{sum: Float64Array, expressing: Uint32Array, sumExpressing: Float64Array, sizes: Uint32Array, geneCount: number, groupCount: number, bins: number, range: Float64Array, histogram: Uint32Array}}
 *   Gene-major: `sum[gene * groupCount + group]`; `range[2 * gene]` and
 *   `[2 * gene + 1]` the low and high ends of a gene's bins;
 *   `histogram[(gene * groupCount + group) * bins + bin]`.
 */
export function summarizeGenesByGroup(context, genes, cutoff, bins = 0) {
  if (!Array.isArray(genes)) throw new TypeError('Group summary genes must be an array');
  if (!Number.isFinite(cutoff)) throw new TypeError('Group summary cutoff must be finite');
  if (!Number.isSafeInteger(bins) || bins < 0) throw new RangeError('Group summary bins must be a whole number');
  const { cellGroup, groupCount, sizes } = context;
  const geneCount = genes.length;
  const sum = new Float64Array(geneCount * groupCount);
  const expressing = new Uint32Array(geneCount * groupCount);
  const sumExpressing = new Float64Array(geneCount * groupCount);
  const nonZero = new Uint32Array(groupCount);
  const zeroExpressed = 0 > cutoff;
  const range = new Float64Array(bins > 0 ? geneCount * 2 : 0);
  const histogram = new Uint32Array(bins > 0 ? geneCount * groupCount * bins : 0);
  let grouped = 0;
  for (let group = 0; group < groupCount; group++) grouped += sizes[group];

  for (let gene = 0; gene < geneCount; gene++) {
    const sample = geneSampleOf(genes[gene], 0);
    if (sample.length !== cellGroup.length) {
      throw new RangeError(`Group summary gene ${gene} has ${formatCountOf(sample.length, 'cell')}, not ${cellGroup.length}`);
    }
    const base = gene * groupCount;
    nonZero.fill(0);
    const { indices, values } = sample;
    for (let entry = 0; entry < indices.length; entry++) {
      const group = cellGroup[indices[entry]];
      if (group < 0) continue;
      const value = values[entry];
      // A stored zero is a zero: it is accounted with the implicit ones.
      if (value === 0) continue;
      nonZero[group] += 1;
      sum[base + group] += value;
      if (value > cutoff) {
        expressing[base + group] += 1;
        sumExpressing[base + group] += value;
      }
    }
    if (zeroExpressed) {
      for (let group = 0; group < groupCount; group++) {
        expressing[base + group] += sizes[group] - nonZero[group];
      }
    }
    if (bins > 0) binGene(gene);
  }

  /** The gene's distribution per group, over its range in the grouped cells. */
  function binGene(gene) {
    const sample = geneSampleOf(genes[gene], 0);
    const { indices, values } = sample;
    let stored = 0;
    let low = Infinity;
    let high = -Infinity;
    for (let entry = 0; entry < indices.length; entry++) {
      if (cellGroup[indices[entry]] < 0) continue;
      const value = values[entry];
      if (value === 0) continue;
      stored += 1;
      if (value < low) low = value;
      if (value > high) high = value;
    }
    if (stored < grouped) {
      low = Math.min(low, 0);
      high = Math.max(high, 0);
    }
    if (!(high > low)) {
      low = Number.isFinite(low) ? low : 0;
      high = low + 1;
    }
    range[2 * gene] = low;
    range[2 * gene + 1] = high;
    const scale = bins / (high - low);
    const binOf = value => Math.min(bins - 1, Math.max(0, Math.floor((value - low) * scale)));
    const zeroBin = binOf(0);
    const base = gene * groupCount;
    const counted = new Uint32Array(groupCount);
    for (let entry = 0; entry < indices.length; entry++) {
      const group = cellGroup[indices[entry]];
      if (group < 0) continue;
      const value = values[entry];
      if (value === 0) continue;
      counted[group] += 1;
      histogram[(base + group) * bins + binOf(value)] += 1;
    }
    for (let group = 0; group < groupCount; group++) {
      histogram[(base + group) * bins + zeroBin] += sizes[group] - counted[group];
    }
  }
  return {
    sum, expressing, sumExpressing, sizes: sizes.slice(), geneCount, groupCount, bins, range, histogram
  };
}

/**
 * The values a dot plot shows, from a summary: per gene and group the mean,
 * the fraction of cells expressing and the mean of the expressing cells (0
 * where no cell expresses, as scanpy's `mean_only_expressed` fills it). An
 * empty group has NaN everywhere.
 *
 * @param {ReturnType<typeof summarizeGenesByGroup>} summary
 * @returns {{mean: Float64Array, fraction: Float64Array, meanExpressing: Float64Array}}
 */
export function groupSummaryValues(summary) {
  const { sum, expressing, sumExpressing, sizes, geneCount, groupCount } = summary;
  const total = geneCount * groupCount;
  const mean = new Float64Array(total);
  const fraction = new Float64Array(total);
  const meanExpressing = new Float64Array(total);
  for (let gene = 0; gene < geneCount; gene++) {
    for (let group = 0; group < groupCount; group++) {
      const at = gene * groupCount + group;
      const n = sizes[group];
      mean[at] = n > 0 ? sum[at] / n : NaN;
      fraction[at] = n > 0 ? expressing[at] / n : NaN;
      meanExpressing[at] = n === 0 ? NaN : expressing[at] > 0 ? sumExpressing[at] / expressing[at] : 0;
    }
  }
  return { mean, fraction, meanExpressing };
}

/**
 * The colour value of each dot, scaled as asked (scanpy `standard_scale`):
 * 'none' as is; 'var' each gene to 0–1 over the groups (min-max, a flat
 * gene 0, as scanpy); 'z' each gene to z over the groups (population SD, as
 * `scipy.stats.zscore`; a flat gene 0). NaN stays NaN.
 *
 * @param {Float64Array} values - Gene-major.
 * @param {number} geneCount
 * @param {number} groupCount
 * @param {'none'|'var'|'z'} scale
 * @returns {Float64Array}
 */
export function scaleByGene(values, geneCount, groupCount, scale) {
  if (scale === 'none') return values.slice();
  if (scale !== 'var' && scale !== 'z') throw new RangeError(`Unknown dot plot scale "${scale}"`);
  const out = new Float64Array(values.length);
  for (let gene = 0; gene < geneCount; gene++) {
    const base = gene * groupCount;
    let min = Infinity;
    let max = -Infinity;
    let total = 0;
    let n = 0;
    for (let group = 0; group < groupCount; group++) {
      const v = values[base + group];
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      total += v;
      n += 1;
    }
    const meanValue = n > 0 ? total / n : 0;
    let squares = 0;
    if (scale === 'z') {
      for (let group = 0; group < groupCount; group++) {
        const v = values[base + group];
        if (Number.isFinite(v)) squares += (v - meanValue) ** 2;
      }
    }
    const sd = n > 0 ? Math.sqrt(squares / n) : 0;
    for (let group = 0; group < groupCount; group++) {
      const v = values[base + group];
      if (!Number.isFinite(v)) { out[base + group] = NaN; continue; }
      if (scale === 'var') {
        // scanpy: (x - min) / (max - min), a flat gene all 0.
        out[base + group] = max > min ? (v - min) / (max - min) : 0;
      } else {
        out[base + group] = sd > 0 ? (v - meanValue) / sd : 0;
      }
    }
  }
  return out;
}
