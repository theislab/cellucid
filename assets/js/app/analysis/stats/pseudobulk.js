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
 * Every unit weighs the same in that test, so a sample with a few cells of a
 * group — common for a rare cell type — would count as much as one with
 * thousands while its mean is mostly noise. As pseudobulk practice does, a
 * unit with fewer cells than a minimum (10 by default) is left out; how many
 * were is part of the result.
 *
 * A cell with no value of a gene (NaN: a modality that did not measure it)
 * is left out of that gene's unit mean, as every analysis leaves it out, so
 * a unit's mean is over its measured cells and the minimum counts those: a
 * unit with fewer measured cells than the minimum is left out of that gene's
 * test only, and each gene says how many units it tested (`nA`, `nB`).
 *
 * @module analysis/stats/pseudobulk
 */

import { welchTTestFromMoments } from '../compute/math-utils.js';
import { foldChangeOfMeans } from '../compute/gene-statistics.js';
import { formatCountOf } from '../../../utils/format-units.js';

/**
 * The units of a pseudobulk comparison.
 *
 * @param {Uint32Array} cellsA - Sorted cells of Group A
 * @param {Uint32Array} cellsB - Sorted cells of Group B, disjoint from A
 * @param {ArrayLike<number>} codes - Each cell's sample code
 * @param {number} missingCode - The code of a cell with no sample
 * @param {number} pointCount
 * @param {number} minCellsPerSample - A sample's cells of a side below this
 *   make no unit: they are left out
 * @returns {{cellUnit: Int32Array, unitCount: number, unitSide: Uint8Array, unitSample: Int32Array, unitsA: number, unitsB: number, cellsLeftOut: number, smallUnitsA: number, smallUnitsB: number, cellsInSmallUnits: number}}
 *   `cellUnit[cell]` is the cell's unit (-1: none); `unitSide[u]` 1 (A) or
 *   2 (B); `unitSample[u]` its sample code. Units are ordered A first, then
 *   by sample code. `cellsLeftOut` counts cells with no sample;
 *   `smallUnitsA`/`smallUnitsB` the samples of each side left out for having
 *   fewer cells than the minimum, and `cellsInSmallUnits` their cells.
 */
export function pseudobulkUnits(cellsA, cellsB, codes, missingCode, pointCount, minCellsPerSample) {
  if (codes.length !== pointCount) {
    throw new RangeError(`The sample field has ${formatCountOf(codes.length, 'cell')}; the dataset has ${pointCount}`);
  }
  if (!Number.isSafeInteger(minCellsPerSample) || minCellsPerSample < 1) {
    throw new RangeError('The minimum cells per sample must be a positive integer');
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
  const small = [0, 0, 0];
  let cellsLeftOut = 0;
  let cellsInSmallUnits = 0;
  for (const [side, cells] of [[1, cellsA], [2, cellsB]]) {
    // The side's cells per sample, then its samples with enough of them in
    // code order, then each cell's unit.
    const cellsOfCode = new Uint32Array(maxCode + 1);
    for (let i = 0; i < cells.length; i++) {
      const code = codes[cells[i]];
      if (code !== missingCode) cellsOfCode[code] += 1;
    }
    const unitOfCode = new Int32Array(maxCode + 1).fill(-1);
    for (let code = 0; code <= maxCode; code++) {
      if (cellsOfCode[code] === 0) continue;
      if (cellsOfCode[code] < minCellsPerSample) {
        small[side] += 1;
        cellsInSmallUnits += cellsOfCode[code];
        continue;
      }
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
    cellsLeftOut,
    smallUnitsA: small[1],
    smallUnitsB: small[2],
    cellsInSmallUnits
  };
}

/**
 * One gene's sample-level test from its per-unit sums.
 *
 * @param {ArrayLike<number>} sum - The gene's sum over each unit's measured cells
 * @param {ArrayLike<number>} expressing - Each unit's cells with a value above 0
 * @param {ArrayLike<number>} measured - Each unit's cells with a value of the gene
 * @param {Uint8Array} unitSide
 * @param {{mode: 'stored'|'log1p', base: number|null}} foldChange
 * @param {number} minCellsPerSample - A unit with fewer measured cells is
 *   left out of this gene's test
 * @returns {{meanA: number, meanB: number, pctA: number, pctB: number, log2FoldChange: number, pValue: number, statistic: number, score: number, auroc: number, nA: number, nB: number}}
 *   `meanA`/`meanB` the mean of the side's unit means; `nA`/`nB` the units
 *   tested (with at least `minCellsPerSample` measured cells); `pctA`/`pctB`
 *   the share of the side's measured cells above 0
 */
export function pseudobulkGeneTest(sum, expressing, measured, unitSide, foldChange, minCellsPerSample) {
  if (!Number.isSafeInteger(minCellsPerSample) || minCellsPerSample < 1) {
    throw new RangeError('The minimum cells per sample must be a positive integer');
  }
  const moments = [null, { n: 0, total: 0, squares: 0, cells: 0, above: 0 }, { n: 0, total: 0, squares: 0, cells: 0, above: 0 }];
  let minimum = Infinity;
  const means = new Float64Array(unitSide.length);
  for (let unit = 0; unit < unitSide.length; unit++) {
    const side = moments[unitSide[unit]];
    side.cells += measured[unit];
    side.above += expressing[unit];
    const mean = measured[unit] >= minCellsPerSample ? sum[unit] / measured[unit] : NaN;
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
