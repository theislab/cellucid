/**
 * @fileoverview Pseudobulk differential expression: replicates, not cells,
 * are the observations.
 *
 * With a sample field, each sample's cells of Group A form one unit and its
 * cells of Group B another (a sample with cells on both sides gives a unit to
 * each). A gene's value for a unit is its mean over the unit's cells — the
 * per-sample mean, read in one O(nnz) pass over the gene's non-zero entries
 * by the analysis workers (`compute/group-expression-summary.js`, one group a
 * unit). The test is Welch's t between the two sides' unit means
 * (`scipy.stats.ttest_ind(equal_var=False)` on the per-sample means); no
 * variance moderation (limma, edgeR, DESeq2) is applied.
 *
 * @module analysis/stats/pseudobulk
 */

import { welchTTestFromMoments } from '../compute/math-utils.js';
import { foldChangeOfMeans } from '../compute/gene-statistics.js';

/**
 * The units of a pseudobulk comparison.
 *
 * @param {Uint32Array} cellsA - Sorted cells of Group A
 * @param {Uint32Array} cellsB - Sorted cells of Group B, disjoint from A
 * @param {ArrayLike<number>} codes - Each cell's sample code
 * @param {number} missingCode - The code of a cell with no sample
 * @param {number} pointCount
 * @returns {{cellUnit: Int32Array, unitCount: number, unitSide: Uint8Array, unitSample: Int32Array, unitsA: number, unitsB: number, cellsLeftOut: number}}
 *   `cellUnit[cell]` is the cell's unit (-1: none); `unitSide[u]` 1 (A) or
 *   2 (B); `unitSample[u]` its sample code. Units are ordered A first, then
 *   by sample code.
 */
export function pseudobulkUnits(cellsA, cellsB, codes, missingCode, pointCount) {
  if (codes.length !== pointCount) {
    throw new RangeError(`The sample field has ${codes.length} cells; the dataset has ${pointCount}`);
  }
  let maxCode = -1;
  for (const cells of [cellsA, cellsB]) {
    for (let i = 0; i < cells.length; i++) {
      const code = codes[cells[i]];
      if (code !== missingCode && code > maxCode) maxCode = code;
    }
  }
  const cellUnit = new Int32Array(pointCount).fill(-1);
  const sides = [];
  const samples = [];
  let cellsLeftOut = 0;
  for (const [side, cells] of [[1, cellsA], [2, cellsB]]) {
    // The side's samples in code order, then each cell's unit.
    const unitOfCode = new Int32Array(maxCode + 1).fill(-1);
    for (let i = 0; i < cells.length; i++) {
      const code = codes[cells[i]];
      if (code !== missingCode) unitOfCode[code] = 0;
    }
    for (let code = 0; code <= maxCode; code++) {
      if (unitOfCode[code] < 0) continue;
      unitOfCode[code] = sides.length;
      sides.push(side);
      samples.push(code);
    }
    for (let i = 0; i < cells.length; i++) {
      const code = codes[cells[i]];
      if (code === missingCode) cellsLeftOut += 1;
      else cellUnit[cells[i]] = unitOfCode[code];
    }
  }
  const unitSide = Uint8Array.from(sides);
  let unitsA = 0;
  for (const side of sides) if (side === 1) unitsA += 1;
  return {
    cellUnit,
    unitCount: unitSide.length,
    unitSide,
    unitSample: Int32Array.from(samples),
    unitsA,
    unitsB: sides.length - unitsA,
    cellsLeftOut
  };
}

/**
 * One gene's sample-level test from its per-unit sums.
 *
 * @param {ArrayLike<number>} sum - The gene's sum over each unit's cells
 * @param {ArrayLike<number>} expressing - Each unit's cells with a value above 0
 * @param {ArrayLike<number>} sizes - Each unit's cells
 * @param {Uint8Array} unitSide
 * @param {{mode: 'stored'|'log1p', base: number|null}} foldChange
 * @returns {{meanA: number, meanB: number, pctA: number, pctB: number, log2FoldChange: number, pValue: number, statistic: number, score: number, auroc: number, nA: number, nB: number}}
 *   `meanA`/`meanB` the mean of the side's unit means; `nA`/`nB` the units
 *   whose mean is finite; `pctA`/`pctB` the share of the side's cells above 0
 */
export function pseudobulkGeneTest(sum, expressing, sizes, unitSide, foldChange) {
  const moments = [null, { n: 0, total: 0, squares: 0, cells: 0, above: 0 }, { n: 0, total: 0, squares: 0, cells: 0, above: 0 }];
  let minimum = Infinity;
  const means = new Float64Array(unitSide.length);
  for (let unit = 0; unit < unitSide.length; unit++) {
    const side = moments[unitSide[unit]];
    side.cells += sizes[unit];
    side.above += expressing[unit];
    const mean = sizes[unit] > 0 ? sum[unit] / sizes[unit] : NaN;
    means[unit] = mean;
    if (!Number.isFinite(mean)) continue;
    side.n += 1;
    side.total += mean;
    if (mean < minimum) minimum = mean;
  }
  const meanOf = side => (side.n > 0 ? side.total / side.n : NaN);
  const [, a, b] = moments;
  const meanA = meanOf(a);
  const meanB = meanOf(b);
  for (let unit = 0; unit < unitSide.length; unit++) {
    if (!Number.isFinite(means[unit])) continue;
    const side = moments[unitSide[unit]];
    side.squares += (means[unit] - (side === a ? meanA : meanB)) ** 2;
  }
  const varianceOf = side => (side.n > 1 ? side.squares / (side.n - 1) : NaN);
  const { statistic, pValue } = welchTTestFromMoments(meanA, varianceOf(a), a.n, meanB, varianceOf(b), b.n);
  const tested = a.n >= 2 && b.n >= 2 && Number.isFinite(pValue);
  return {
    meanA,
    meanB,
    pctA: a.cells > 0 ? (100 * a.above) / a.cells : NaN,
    pctB: b.cells > 0 ? (100 * b.above) / b.cells : NaN,
    log2FoldChange: tested ? foldChangeOfMeans(meanA, meanB, minimum, foldChange) : NaN,
    pValue: tested ? pValue : NaN,
    statistic: tested ? statistic : NaN,
    score: tested ? statistic : NaN,
    auroc: NaN,
    nA: a.n,
    nB: b.n
  };
}
