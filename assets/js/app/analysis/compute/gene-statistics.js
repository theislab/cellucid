/**
 * Gene statistics from a gene's non-zero entries.
 *
 * Single-cell expression is mostly zeros: the median gene of a 562,000-cell
 * atlas is non-zero in 0.2 % of its cells. Every statistic the analyses report
 * is a function of the non-zero values and of how many zeros each group holds,
 * so the kernels here walk the non-zero entries only and account for the zeros
 * in closed form — and give exactly the numbers a walk over every cell gives:
 *
 * - A sum is unchanged by adding zeros (a running sum that starts at +0 never
 *   becomes -0, and `s + 0 === s` bit for bit), so the non-zero entries summed
 *   in cell order are the sum of every cell in cell order, and a mean is the
 *   same double.
 * - Every zero ties with every other zero: they are one rank block whose size
 *   is the zero count, placed between the negative and the positive values.
 *   Rank sums and the tie term are therefore fed the same blocks in the same
 *   ascending order a pass over every cell feeds them, and rank sums are exact
 *   (integers or halves far below 2^53), so a rank test's statistic and
 *   probability are the same doubles.
 * - A centred sum of squares adds `(0 - mean) ** 2` for each zero. Where the
 *   result must equal a pass over every cell in cell order (the two-sample
 *   test), the zeros' terms are added at their positions; the one-vs-rest
 *   marker kernel adds them per group in one product.
 *
 * A gene is handed to a kernel as a *sample*: `{length, indices, values}`, the
 * stored entries of a vector of `length` values, `indices` strictly ascending
 * within `[0, length)` and every position not listed holding zero. A stored
 * entry may itself be zero (it counts as one) or non-finite (it is left out,
 * as a missing measurement). A dense array is turned into a sample by
 * `geneSampleOf` in one pass, so a dense and a sparse gene go through one
 * implementation.
 *
 * @module compute/gene-statistics
 */

import {
  DistinctValueIndex,
  MAX_TABULATED_DISTINCT_VALUES,
  TwoSampleRankSum,
  ascendingOrder,
  log2FoldChangeOfMeans,
  mannWhitneyPValue,
  sortedAscending,
  welchTTestFromMoments
} from './math-utils.js';

/**
 * @typedef {Object} GeneSample
 * @property {number} length - Values the sample stands for
 * @property {Uint32Array} indices - Positions of the stored entries, ascending
 * @property {Float32Array|Float64Array} values - The stored entries
 */

// ============================================================================
// Samples
// ============================================================================

/**
 * Whether `value` has the shape of a sample (its entries are checked by the
 * kernels as they walk them).
 *
 * @param {unknown} value
 * @returns {value is GeneSample}
 */
export function isGeneSample(value) {
  return value !== null
    && typeof value === 'object'
    && !ArrayBuffer.isView(value)
    && !Array.isArray(value)
    && value.indices instanceof Uint32Array
    && (value.values instanceof Float32Array || value.values instanceof Float64Array)
    && value.indices.length === value.values.length
    && Number.isSafeInteger(value.length)
    && value.length >= value.indices.length;
}

/**
 * Space a dense array is turned into a sample in: grown on demand and reused,
 * so a worker that receives one dense gene after another allocates once.
 */
class SampleScratch {
  constructor() {
    this.indices = new Uint32Array(0);
    this.values32 = new Float32Array(0);
    this.values64 = new Float64Array(0);
  }

  /** @param {number} capacity */
  reserve(capacity, wide) {
    if (this.indices.length < capacity) {
      const size = Math.max(capacity, this.indices.length * 2);
      this.indices = new Uint32Array(size);
    }
    if (wide) {
      if (this.values64.length < capacity) {
        this.values64 = new Float64Array(Math.max(capacity, this.values64.length * 2));
      }
      return this.values64;
    }
    if (this.values32.length < capacity) {
      this.values32 = new Float32Array(Math.max(capacity, this.values32.length * 2));
    }
    return this.values32;
  }
}

/** One scratch per role a kernel needs at once (two groups and a column). */
const scratchSlots = [new SampleScratch(), new SampleScratch(), new SampleScratch()];

/**
 * A gene as a sample. A sample is returned as it is; a dense array (any
 * typed array but a BigInt one, or an Array) becomes the sample of its
 * entries that are not zero — a non-number Array entry is stored as NaN, a
 * missing value, exactly as the dense kernels left it out.
 *
 * A converted sample lives in reused space: it is valid until the next
 * conversion into the same `slot`, and its values keep the input's precision
 * (a Float32Array stays float32; anything else is held as float64).
 *
 * @param {ArrayLike<number>|GeneSample} values
 * @param {0|1|2} [slot=0]
 * @returns {GeneSample}
 */
export function geneSampleOf(values, slot = 0) {
  if (isGeneSample(values)) return values;
  if (
    values === null
    || typeof values !== 'object'
    || (!Array.isArray(values) && !ArrayBuffer.isView(values))
    || values instanceof DataView
    || values instanceof BigInt64Array
    || values instanceof BigUint64Array
  ) {
    throw new TypeError('A gene must be a numeric array or a sample {length, indices, values}');
  }
  const scratch = scratchSlots[slot];
  const length = values.length;
  // The space is reserved for the whole length once per thread and reused,
  // so the scan is one pass.
  const out = scratch.reserve(length, !(values instanceof Float32Array));
  const indices = scratch.indices;
  let count = 0;
  if (values instanceof Float32Array) {
    // Eight values per test of their bits ORed together (sign bit shifted
    // out, so -0 and +0 both read as zero): a mostly-zero column is skipped
    // eight cells at a time.
    const bits = new Uint32Array(values.buffer, values.byteOffset, length);
    const blocked = length & ~7;
    let i = 0;
    for (; i < blocked; i += 8) {
      if (((bits[i] | bits[i + 1] | bits[i + 2] | bits[i + 3]
        | bits[i + 4] | bits[i + 5] | bits[i + 6] | bits[i + 7]) << 1) === 0) {
        continue;
      }
      for (let j = i; j < i + 8; j++) {
        if ((bits[j] << 1) === 0) continue;
        indices[count] = j;
        out[count++] = values[j];
      }
    }
    for (; i < length; i++) {
      if ((bits[i] << 1) === 0) continue;
      indices[count] = i;
      out[count++] = values[i];
    }
  } else if (Array.isArray(values)) {
    for (let i = 0; i < length; i++) {
      const value = values[i];
      if (value === 0) continue;
      indices[count] = i;
      out[count++] = typeof value === 'number' ? value : NaN;
    }
  } else {
    for (let i = 0; i < length; i++) {
      const value = values[i];
      if (value === 0) continue;
      indices[count] = i;
      out[count++] = value;
    }
  }
  return { length, indices: indices.subarray(0, count), values: out.subarray(0, count) };
}

function sampleOrderError(owner) {
  return new RangeError(`${owner}: sample indices must be strictly ascending and within its length`);
}

/**
 * What a two-sample test needs of one sample, in one pass: the finite count,
 * the sum of the finite values in position order, their minimum, and the
 * non-zero finite values (for ranking).
 *
 * @param {GeneSample} sample
 * @param {string} owner
 */
function describeSample(sample, owner) {
  const { length, indices, values } = sample;
  let nonFinite = 0;
  let nonZero = 0;
  let sum = 0;
  let minimum = Infinity;
  let previous = -1;
  for (let k = 0; k < indices.length; k++) {
    const position = indices[k];
    if (position <= previous || position >= length) throw sampleOrderError(owner);
    previous = position;
    const value = values[k];
    if (!Number.isFinite(value)) {
      nonFinite++;
      continue;
    }
    if (value === 0) continue;
    nonZero++;
    sum += value;
    if (value < minimum) minimum = value;
  }
  const n = length - nonFinite;
  const zeros = n - nonZero;
  if (zeros > 0 && minimum > 0) minimum = 0;
  return { n, zeros, nonZero, sum, minimum };
}

/**
 * The non-zero finite values of a sample, in position order.
 * @param {GeneSample} sample
 * @param {number} count
 */
function nonZeroValues(sample, count) {
  const out = new Float64Array(count);
  const values = sample.values;
  let k = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value !== 0 && Number.isFinite(value)) out[k++] = value;
  }
  return out;
}

/**
 * Two-pass centred sum of squares of a sample's finite values about `mean`,
 * every term added in position order — the zeros' `(0 - mean) ** 2` at their
 * own positions — so it is the very sum a pass over the dense values gives.
 *
 * @param {GeneSample} sample
 * @param {number} mean
 */
function centredSumOfSquares(sample, mean) {
  const { length, indices, values } = sample;
  const zeroTerm = (0 - mean) ** 2;
  let sumSquares = 0;
  let position = 0;
  for (let k = 0; k < indices.length; k++) {
    const stored = indices[k];
    for (; position < stored; position++) sumSquares += zeroTerm;
    position = stored + 1;
    const value = values[k];
    if (!Number.isFinite(value)) continue;
    sumSquares += (value - mean) ** 2;
  }
  for (; position < length; position++) sumSquares += zeroTerm;
  return sumSquares;
}

// ============================================================================
// Two-sample test (differential expression of two groups)
// ============================================================================

const twoSampleIndex = new DistinctValueIndex();
const twoSampleCountA = new Float64Array(MAX_TABULATED_DISTINCT_VALUES);
const twoSampleCountB = new Float64Array(MAX_TABULATED_DISTINCT_VALUES);

/**
 * Feed the tie blocks of two samples in ascending value order, the zeros as
 * one block between the negative and the positive values.
 *
 * @param {GeneSample} sampleA
 * @param {GeneSample} sampleB
 * @param {{zeros: number, nonZero: number}} a
 * @param {{zeros: number, nonZero: number}} b
 * @param {TwoSampleRankSum} sums
 */
function feedTwoSampleBlocks(sampleA, sampleB, a, b, sums) {
  const zeroBlock = a.zeros + b.zeros;
  const index = twoSampleIndex;
  index.clear();
  const tabulate = (values, counts) => {
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (value === 0 || !Number.isFinite(value)) continue;
      const number = index.numberOf(value);
      if (number === -1) return false;
      counts[number] += 1;
    }
    return true;
  };
  const tabulated = tabulate(sampleA.values, twoSampleCountA)
    && tabulate(sampleB.values, twoSampleCountB);
  if (tabulated) {
    const ascending = index.ascendingNumbers();
    let zeroFed = zeroBlock === 0;
    for (let block = 0; block < ascending.length; block++) {
      const number = ascending[block];
      if (!zeroFed && index.values[number] > 0) {
        sums.addBlock(a.zeros, b.zeros);
        zeroFed = true;
      }
      sums.addBlock(twoSampleCountA[number], twoSampleCountB[number]);
    }
    if (!zeroFed) sums.addBlock(a.zeros, b.zeros);
  }
  // Leave both tables empty for the next call (an abandoned tabulation
  // numbered every slot).
  twoSampleCountA.fill(0, 0, index.size);
  twoSampleCountB.fill(0, 0, index.size);
  if (tabulated) return;
  // More distinct values than the tabulation bound: sort each sample's
  // non-zero values and merge them block by block.
  const sortedA = sortedAscending(nonZeroValues(sampleA, a.nonZero));
  const sortedB = sortedAscending(nonZeroValues(sampleB, b.nonZero));
  let indexA = 0;
  let indexB = 0;
  let zeroFed = zeroBlock === 0;
  while (indexA < sortedA.length || indexB < sortedB.length) {
    const value = indexA < sortedA.length
      && (indexB >= sortedB.length || sortedA[indexA] <= sortedB[indexB])
      ? sortedA[indexA]
      : sortedB[indexB];
    if (!zeroFed && value > 0) {
      sums.addBlock(a.zeros, b.zeros);
      zeroFed = true;
    }
    let blockA = 0;
    while (indexA < sortedA.length && sortedA[indexA] === value) {
      blockA++;
      indexA++;
    }
    let blockB = 0;
    while (indexB < sortedB.length && sortedB[indexB] === value) {
      blockB++;
      indexB++;
    }
    sums.addBlock(blockA, blockB);
  }
  if (!zeroFed) sums.addBlock(a.zeros, b.zeros);
}

/**
 * Differential expression of one gene between two samples: means, log2 fold
 * change, and a Mann-Whitney U (`wilcox`) or Welch (`ttest`) probability —
 * exactly the numbers the same test gives over the dense finite values of
 * each group (`mannWhitneyU`, `welchTTest` and `mean` in math-utils).
 *
 * @param {GeneSample} sampleA
 * @param {GeneSample} sampleB
 * @param {'wilcox'|'ttest'} method
 * @returns {{meanA: number, meanB: number, log2FoldChange: number, pValue: number, statistic: number, nA: number, nB: number, method?: string}}
 */
export function twoSampleDifferential(sampleA, sampleB, method) {
  if (method !== 'wilcox' && method !== 'ttest') {
    throw new RangeError('Differential expression method must be wilcox or ttest');
  }
  const a = describeSample(sampleA, 'Group A');
  const b = describeSample(sampleB, 'Group B');
  const nA = a.n;
  const nB = b.n;
  if (nA < 2 || nB < 2) {
    return {
      meanA: NaN,
      meanB: NaN,
      log2FoldChange: NaN,
      pValue: NaN,
      statistic: NaN,
      nA,
      nB
    };
  }
  const meanA = a.sum / nA;
  const meanB = b.sum / nB;
  const log2FoldChange = log2FoldChangeOfMeans(meanA, meanB, Math.min(a.minimum, b.minimum));

  let pValue;
  let statistic;
  if (method === 'wilcox') {
    const sums = new TwoSampleRankSum();
    feedTwoSampleBlocks(sampleA, sampleB, a, b, sums);
    const U1 = sums.rankSumA - (nA * (nA + 1)) / 2;
    const U2 = nA * nB - U1;
    statistic = Math.min(U1, U2);
    ({ pValue } = mannWhitneyPValue(nA, nB, statistic, { tieTerm: sums.tieTerm }));
  } else {
    const varianceA = centredSumOfSquares(sampleA, meanA) / (nA - 1);
    const varianceB = centredSumOfSquares(sampleB, meanB) / (nB - 1);
    ({ pValue, statistic } = welchTTestFromMoments(meanA, varianceA, nA, meanB, varianceB, nB));
  }
  return { meanA, meanB, log2FoldChange, pValue, statistic, nA, nB, method };
}

// ============================================================================
// Two groups of one column (differential expression read by column)
// ============================================================================

/**
 * The two groups of a differential-expression run over whole gene columns:
 * which group each cell belongs to, and its position within that group. Both
 * groups are in ascending cell order, the order their values were compared in
 * when they were gathered.
 *
 * @param {Uint8Array} groupOfCell - 1 for group A, 2 for group B, 0 for neither
 * @returns {{length: number, groupOfCell: Uint8Array, positionInGroup: Uint32Array, sizeA: number, sizeB: number}}
 */
export function createTwoGroupContext(groupOfCell) {
  if (!(groupOfCell instanceof Uint8Array) || groupOfCell.length === 0) {
    throw new TypeError('Two-group context needs a non-empty Uint8Array of group memberships');
  }
  const length = groupOfCell.length;
  const positionInGroup = new Uint32Array(length);
  let sizeA = 0;
  let sizeB = 0;
  for (let cell = 0; cell < length; cell++) {
    const group = groupOfCell[cell];
    if (group === 1) positionInGroup[cell] = sizeA++;
    else if (group === 2) positionInGroup[cell] = sizeB++;
    else if (group !== 0) {
      throw new RangeError(`Cell ${cell} has group ${group}; memberships are 0, 1 or 2`);
    }
  }
  return { length, groupOfCell, positionInGroup, sizeA, sizeB };
}

/**
 * Split a gene column into the samples of the context's two groups.
 *
 * @param {ArrayLike<number>|GeneSample} column - Every cell's value
 * @param {ReturnType<typeof createTwoGroupContext>} context
 * @returns {{sampleA: GeneSample, sampleB: GeneSample}} Valid until the next split
 */
export function splitTwoGroups(column, context) {
  const sample = geneSampleOf(column, 2);
  if (sample.length !== context.length) {
    throw new RangeError(
      `Gene column has ${sample.length} values; the groups were defined over ${context.length} cells`
    );
  }
  const { indices, values } = sample;
  const { groupOfCell, positionInGroup } = context;
  const wide = values instanceof Float64Array;
  // Count first so each group's space is reserved once.
  let countA = 0;
  let countB = 0;
  let previous = -1;
  for (let k = 0; k < indices.length; k++) {
    const cell = indices[k];
    if (cell <= previous || cell >= sample.length) throw sampleOrderError('Gene column');
    previous = cell;
    const group = groupOfCell[cell];
    if (group === 1) countA++;
    else if (group === 2) countB++;
  }
  const outA = scratchSlots[0].reserve(countA, wide);
  const outB = scratchSlots[1].reserve(countB, wide);
  const indicesA = scratchSlots[0].indices;
  const indicesB = scratchSlots[1].indices;
  let a = 0;
  let b = 0;
  for (let k = 0; k < indices.length; k++) {
    const cell = indices[k];
    const group = groupOfCell[cell];
    if (group === 1) {
      indicesA[a] = positionInGroup[cell];
      outA[a++] = values[k];
    } else if (group === 2) {
      indicesB[b] = positionInGroup[cell];
      outB[b++] = values[k];
    }
  }
  return {
    sampleA: { length: context.sizeA, indices: indicesA.subarray(0, a), values: outA.subarray(0, a) },
    sampleB: { length: context.sizeB, indices: indicesB.subarray(0, b), values: outB.subarray(0, b) }
  };
}

// ============================================================================
// One group against the rest, every group at once (marker discovery)
// ============================================================================

/**
 * The grouping of a marker run: each cell's group (-1 for a cell in no
 * group) and every group's size.
 *
 * @param {Int16Array|Int32Array} cellGroupIndex
 * @param {number} groupCount
 */
export function createGroupingContext(cellGroupIndex, groupCount) {
  const groupSize = new Uint32Array(groupCount);
  for (let cell = 0; cell < cellGroupIndex.length; cell++) {
    const group = cellGroupIndex[cell];
    if (group >= 0) groupSize[group]++;
  }
  return {
    groupCount,
    cellGroupIndex,
    groupSize,
    valueIndex: new DistinctValueIndex(),
    /** Rows of per-group counts, one row per distinct non-zero value. */
    countsByValue: new Uint32Array(64 * groupCount),
  };
}

/**
 * One-vs-rest statistics of one gene for every group of a grouping: for each
 * group, its cells against every other grouped cell that carries a measured
 * value. Cost is linear in the gene's non-zero entries plus the groups times
 * the distinct values, whatever the cell count.
 *
 * Means are each group's finite values summed in cell order over their count
 * (the rest: the total less the group); a Wilcoxon probability is exactly the
 * two-sample `mannWhitneyU` of the group against the rest; a Welch probability
 * comes from centred second moments of the group and of all grouped cells.
 *
 * @param {GeneSample} sample - The gene in every cell
 * @param {ReturnType<typeof createGroupingContext>} context
 * @param {{method: 'wilcox'|'ttest', minCells: number, pseudocount: number}} options
 */
export function oneVsRestMarkers(sample, context, { method, minCells, pseudocount }) {
  const { groupCount, cellGroupIndex, groupSize } = context;
  if (sample.length !== cellGroupIndex.length) {
    throw new RangeError('Marker gene values must cover exactly the grouped cells');
  }
  const { indices, values } = sample;
  const wilcox = method === 'wilcox';

  const nonFinite = new Uint32Array(groupCount);
  const nonZero = new Uint32Array(groupCount);
  const exprIn = new Uint32Array(groupCount);
  const sumIn = new Float64Array(groupCount);
  let sumAll = 0;
  let exprAll = 0;
  let minimumNonZero = Infinity;

  // Wilcoxon tabulates every non-zero value once per group (count-derived
  // expression holds few distinct values per gene); past the tabulation bound
  // the non-zero values are sorted instead.
  const valueIndex = wilcox ? context.valueIndex : null;
  valueIndex?.clear();
  let tabulated = wilcox;
  let counts = context.countsByValue;

  let previous = -1;
  for (let k = 0; k < indices.length; k++) {
    const cell = indices[k];
    if (cell <= previous || cell >= sample.length) throw sampleOrderError('Marker gene');
    previous = cell;
    const group = cellGroupIndex[cell];
    if (group < 0) continue;
    const value = values[k];
    if (!Number.isFinite(value)) {
      nonFinite[group]++;
      continue;
    }
    if (value === 0) continue;
    nonZero[group]++;
    sumIn[group] += value;
    sumAll += value;
    if (value > 0) {
      exprIn[group]++;
      exprAll++;
    }
    if (value < minimumNonZero) minimumNonZero = value;
    if (tabulated) {
      const row = valueIndex.numberOf(value);
      if (row === -1) {
        tabulated = false;
      } else {
        const at = row * groupCount + group;
        if (at >= counts.length) {
          const grown = new Uint32Array(Math.max(counts.length * 2, (row + 1) * groupCount));
          grown.set(counts);
          counts = grown;
          context.countsByValue = grown;
        }
        counts[at]++;
      }
    }
  }

  const nIn = new Uint32Array(groupCount);
  const nOut = new Uint32Array(groupCount);
  const zeros = new Float64Array(groupCount);
  let nAll = 0;
  let zerosAll = 0;
  for (let g = 0; g < groupCount; g++) {
    nIn[g] = groupSize[g] - nonFinite[g];
    zeros[g] = nIn[g] - nonZero[g];
    nAll += nIn[g];
    zerosAll += zeros[g];
  }
  for (let g = 0; g < groupCount; g++) nOut[g] = nAll - nIn[g];
  // Minimum over every measured cell: one-vs-rest compares all of them.
  const minAll = zerosAll > 0 ? Math.min(minimumNonZero, 0) : minimumNonZero;

  const pValues = new Float64Array(groupCount).fill(NaN);
  const log2FoldChange = new Float32Array(groupCount).fill(NaN);
  const meanInGroup = new Float32Array(groupCount).fill(NaN);
  const meanOutGroup = new Float32Array(groupCount).fill(NaN);
  const percentInGroup = new Float32Array(groupCount);
  const percentOutGroup = new Float32Array(groupCount);

  const meanIn = new Float64Array(groupCount).fill(NaN);
  const meanOut = new Float64Array(groupCount).fill(NaN);
  for (let g = 0; g < groupCount; g++) {
    const nA = nIn[g];
    if (nA === 0) continue;
    const nB = nOut[g];
    meanIn[g] = sumIn[g] / nA;
    meanOut[g] = nB > 0 ? (sumAll - sumIn[g]) / nB : NaN;
    meanInGroup[g] = meanIn[g];
    meanOutGroup[g] = meanOut[g];
    percentInGroup[g] = (exprIn[g] / nA) * 100;
    percentOutGroup[g] = nB > 0 ? ((exprAll - exprIn[g]) / nB) * 100 : 0;
    if (nAll >= 2 && Number.isFinite(meanIn[g]) && Number.isFinite(meanOut[g])) {
      log2FoldChange[g] = log2FoldChangeOfMeans(meanIn[g], meanOut[g], minAll, pseudocount);
    }
  }

  const result = {
    nAll,
    pValues,
    log2FoldChange,
    meanInGroup,
    meanOutGroup,
    percentInGroup,
    percentOutGroup,
    nIn,
    nOut
  };
  if (nAll < 2) {
    if (wilcox) clearCounts(context, counts, valueIndex);
    return result;
  }
  const minPerSide = Math.max(2, minCells);

  if (!wilcox) {
    // Centred second moments: each group about its mean, and all grouped
    // cells about theirs, over the non-zero entries plus each zero's term.
    const meanAll = sumAll / nAll;
    const m2In = new Float64Array(groupCount);
    let m2All = 0;
    for (let k = 0; k < indices.length; k++) {
      const group = cellGroupIndex[indices[k]];
      if (group < 0) continue;
      const value = values[k];
      if (value === 0 || !Number.isFinite(value)) continue;
      m2In[group] += (value - meanIn[group]) ** 2;
      m2All += (value - meanAll) ** 2;
    }
    m2All += zerosAll * meanAll ** 2;
    for (let g = 0; g < groupCount; g++) {
      if (nIn[g] > 0) m2In[g] += zeros[g] * meanIn[g] ** 2;
    }
    for (let g = 0; g < groupCount; g++) {
      const nA = nIn[g];
      const nB = nOut[g];
      if (nA < minPerSide || nB < minPerSide) continue;
      const meanA = meanIn[g];
      const meanB = meanOut[g];
      const meanDifference = meanA - meanB;
      const betweenM2 = meanDifference ** 2 * nA * nB / nAll;
      let restM2 = m2All - m2In[g] - betweenM2;
      const m2Scale = Math.max(1, Math.abs(m2All), Math.abs(m2In[g]), Math.abs(betweenM2));
      if (restM2 < 0 && restM2 >= -32 * Number.EPSILON * m2Scale) restM2 = 0;
      const test = welchTTestFromMoments(
        meanA, m2In[g] / (nA - 1), nA,
        meanB, restM2 / (nB - 1), nB
      );
      pValues[g] = Number.isFinite(test.pValue) ? test.pValue : NaN;
    }
    return result;
  }

  // Wilcoxon: one pass over the ascending tie blocks ranks every group.
  const rankSum = new Float64Array(groupCount);
  let tieTerm = 0;
  let ranked = 0;
  const addZeroBlock = () => {
    if (zerosAll === 0) return;
    if (zerosAll > 1) tieTerm += zerosAll ** 3 - zerosAll;
    const averageRank = ranked + (zerosAll + 1) / 2;
    for (let g = 0; g < groupCount; g++) rankSum[g] += zeros[g] * averageRank;
    ranked += zerosAll;
  };
  let zeroFed = false;
  if (tabulated) {
    const ascending = valueIndex.ascendingNumbers();
    for (let k = 0; k < ascending.length; k++) {
      const number = ascending[k];
      if (!zeroFed && valueIndex.values[number] > 0) {
        addZeroBlock();
        zeroFed = true;
      }
      const rowStart = number * groupCount;
      let tieCount = 0;
      for (let g = 0; g < groupCount; g++) tieCount += counts[rowStart + g];
      if (tieCount > 1) tieTerm += tieCount ** 3 - tieCount;
      const averageRank = ranked + (tieCount + 1) / 2;
      for (let g = 0; g < groupCount; g++) rankSum[g] += counts[rowStart + g] * averageRank;
      ranked += tieCount;
    }
    clearCounts(context, counts, valueIndex);
  } else {
    clearCounts(context, counts, valueIndex);
    // Past the tabulation bound: order the non-zero measured cells by value
    // in linear time, then walk their tie blocks.
    let measuredCount = 0;
    for (let g = 0; g < groupCount; g++) measuredCount += nonZero[g];
    const measured = values instanceof Float32Array
      ? new Float32Array(measuredCount)
      : new Float64Array(measuredCount);
    const owner = new Int32Array(measuredCount);
    let m = 0;
    for (let k = 0; k < indices.length; k++) {
      const group = cellGroupIndex[indices[k]];
      if (group < 0) continue;
      const value = values[k];
      if (value === 0 || !Number.isFinite(value)) continue;
      measured[m] = value;
      owner[m++] = group;
    }
    const order = ascendingOrder(measured);
    let i = 0;
    while (i < measuredCount) {
      const value = measured[order[i]];
      if (!zeroFed && value > 0) {
        addZeroBlock();
        zeroFed = true;
      }
      let j = i + 1;
      while (j < measuredCount && measured[order[j]] === value) j++;
      const tieCount = j - i;
      if (tieCount > 1) tieTerm += tieCount ** 3 - tieCount;
      const averageRank = ranked + (tieCount + 1) / 2;
      for (let k = i; k < j; k++) rankSum[owner[order[k]]] += averageRank;
      ranked += tieCount;
      i = j;
    }
  }
  if (!zeroFed) addZeroBlock();

  for (let g = 0; g < groupCount; g++) {
    const nA = nIn[g];
    const nB = nOut[g];
    if (nA < minPerSide || nB < minPerSide) continue;
    const U1 = rankSum[g] - (nA * (nA + 1)) / 2;
    const U2 = nA * nB - U1;
    const { pValue } = mannWhitneyPValue(nA, nB, Math.min(U1, U2), {
      tieTerm,
      allowExact: true
    });
    pValues[g] = Number.isFinite(pValue) ? pValue : NaN;
  }
  return result;
}

/** Zero the rows a gene used, so the next gene starts from an empty table. */
function clearCounts(context, counts, valueIndex) {
  counts.fill(0, 0, valueIndex.size * context.groupCount);
  valueIndex.clear();
}
