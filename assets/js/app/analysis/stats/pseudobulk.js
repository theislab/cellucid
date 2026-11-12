/**
 * @fileoverview Pseudobulk differential expression: replicates, not cells,
 * are the observations.
 *
 * With a sample field, each sample's cells of Group A form one unit and its
 * cells of Group B another (a sample with cells on both sides gives a unit to
 * each). A gene's sum over each unit's cells is read in one O(nnz) pass over
 * its non-zero entries by the analysis workers
 * (`compute/group-expression-summary.js`, one group a unit), for every gene
 * of the matrix; the model is fit once they are all in (`pseudobulkLimma`),
 * since the normalization and the variance moderation take every gene.
 *
 * A matrix of counts (the Data-mapping `counts` flag): each unit's summed
 * counts, normalized as edgeR normalizes samples
 * (`stats/edger-normalization.js`): TMM factors over every gene of the
 * matrix, on each unit's library size — the sum of its cells' stored totals
 * (`total_counts`: `unitLibrarySizes`) when the file stores them, else the
 * unit's summed counts over every gene (edgeR's default `colSums`) — then
 * log-CPM with edgeR's library-scaled prior (`cpm(log = TRUE, prior.count =
 * 2)` on library × factor). The raw stored counts are always summed,
 * whatever the app's expression transform: normalizing cells before summing
 * them would be wrong. Any other matrix: each unit's mean over its cells, as
 * stored.
 *
 * The values are then fit as limma fits them (`stats/limma.js`): a linear
 * model per gene, `~ group` unpaired, or `~ donor + group` paired (the same
 * donors in both groups: liver and bone marrow of one fetus — the donor a
 * blocking factor, so each donor's own level is taken out before the groups
 * are compared; a sample on one side only is left out of a paired fit, and
 * counted), then empirical-Bayes moderation of the variances, its prior
 * estimated from every gene (limma-trend: `eBayes(trend = TRUE)`); the
 * moderated t of the group coefficient on d + d0 degrees of freedom. The
 * fold change is the group coefficient: of log2-CPM for counts (A − B,
 * paired within donors), else of the means as stored (`foldChangeOfMeans`).
 * This is the limma-trend pipeline of the limma user's guide and of
 * pseudobulk benchmarks (Law et al. 2014, Genome Biol 15:R29; Crowell et
 * al. 2020, Nat Commun 11:6077; Squair et al. 2021, Nat Commun 12:5692).
 *
 * A gene no cell of the compared samples expresses (no value above 0) has
 * nothing to fit: it is left out of the fit and of the moderation's prior,
 * as the minimal expression filter of an edgeR/limma pipeline leaves it
 * out, and reported untested.
 *
 * Every unit weighs the same in the fit, so a sample with a few cells of a
 * group — common for a rare cell type — would count as much as one with
 * thousands while its value is mostly noise. As pseudobulk practice does, a
 * unit with fewer cells than a minimum (10 by default) is left out; how many
 * were is part of the result.
 *
 * A cell with no value of a gene (NaN: a modality that did not measure it)
 * is left out of that gene's unit sum, as every analysis leaves it out, and
 * the minimum counts measured cells: a unit with fewer measured cells than
 * the minimum is missing (NA) for that gene only — limma fits each gene on
 * its observed units — and each gene says how many units it was fit on
 * (`nA`, `nB`). The TMM factors take the units' complete sums, as edgeR
 * takes a matrix without NA.
 *
 * @module analysis/stats/pseudobulk
 */

import { lmFit, eBayes, rMedian } from './limma.js';
import { tmmNormFactors, logCpm } from './edger-normalization.js';
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
 * Each unit's library size: the sum of its cells' stored totals (an obs
 * column such as `total_counts`, over the whole transcriptome), a cell with
 * no total adding nothing.
 *
 * @param {{cellUnit: Int32Array, unitCount: number}} units - `pseudobulkUnits`
 * @param {ArrayLike<number>} totals - Each cell's total (NaN: none)
 * @returns {Float64Array}
 */
export function unitLibrarySizes(units, totals) {
  if (totals.length !== units.cellUnit.length) {
    throw new RangeError(`The cells' totals cover ${formatCountOf(totals.length, 'cell')}; the units ${units.cellUnit.length}`);
  }
  const libraries = new Float64Array(units.unitCount);
  for (let cell = 0; cell < units.cellUnit.length; cell++) {
    const unit = units.cellUnit[cell];
    if (unit >= 0 && Number.isFinite(totals[cell])) libraries[unit] += totals[cell];
  }
  return libraries;
}

/**
 * The pairs of a paired comparison: a sample with a unit on each side (the
 * same donor in both groups) pairs its two units.
 *
 * @param {{unitSide: Uint8Array, unitSample: Int32Array, unitCount: number}} units - `pseudobulkUnits`
 * @returns {{pairOf: Int32Array, pairs: number, unpairedA: number, unpairedB: number}}
 *   `pairOf[u]` the other side's unit of the same sample for a unit of A,
 *   -1 otherwise; `unpairedA` / `unpairedB` the units of a side whose sample
 *   has none on the other (left out of a paired fit)
 */
export function pairedUnits(units) {
  const pairOf = new Int32Array(units.unitCount).fill(-1);
  const unitBOf = new Map();
  for (let unit = 0; unit < units.unitCount; unit++) {
    if (units.unitSide[unit] === 2) unitBOf.set(units.unitSample[unit], unit);
  }
  let pairs = 0;
  let unpairedA = 0;
  for (let unit = 0; unit < units.unitCount; unit++) {
    if (units.unitSide[unit] !== 1) continue;
    const partner = unitBOf.get(units.unitSample[unit]);
    if (partner === undefined) {
      unpairedA += 1;
      continue;
    }
    pairOf[unit] = partner;
    pairs += 1;
  }
  return { pairOf, pairs, unpairedA, unpairedB: unitBOf.size - pairs };
}

/**
 * The fit of every gene of the matrix from its per-unit sums: edgeR's TMM
 * and log-CPM for counts, then limma's `lmFit` and `eBayes(trend = TRUE)`
 * of the group coefficient (the module's header).
 *
 * @param {Object} input
 * @param {Float64Array} input.sums - genes × units, gene-major: each gene's
 *   sum over each unit's measured cells
 * @param {ArrayLike<number>} input.measured - genes × units: the unit's cells
 *   with a value of the gene
 * @param {ArrayLike<number>} input.expressing - genes × units: the unit's
 *   cells with a value above 0
 * @param {number} input.geneCount - Every gene of the matrix
 * @param {{unitSide: Uint8Array, unitSample: Int32Array, unitCount: number}} input.units - `pseudobulkUnits`
 * @param {Int32Array|null} [input.pairOf=null] - `pairedUnits(units).pairOf`
 *   for a paired fit (`~ donor + group`); null: unpaired (`~ group`)
 * @param {boolean} input.counts - The sums are counts: TMM + log-CPM; else
 *   each unit's mean, as stored
 * @param {Float64Array|null} [input.unitLibraries=null] - Each unit's
 *   library size, its cells' stored totals summed (`unitLibrarySizes`);
 *   null: each unit's summed counts over every gene (edgeR's `colSums`)
 * @param {number} input.minCellsPerSample - A unit with fewer measured cells
 *   of a gene is missing for that gene
 * @param {{mode: 'stored'|'log1p', base: number|null}} input.foldChange - The
 *   fold change of means as stored (not counts)
 * @returns {{genes: Object, model: Object}} `genes`: per gene of the matrix
 *   (Float64Array unless said), `meanA`/`meanB` the mean of the side's
 *   observed unit values (log2-CPM for counts), `pctA`/`pctB` the share of
 *   the side's measured cells above 0, `log2FoldChange`, `statistic` (the
 *   moderated t), `pValue`, `nA`/`nB` (Int32Array: the units fit),
 *   `expressed` (Uint8Array: in the fit), `missingUnits` (Int32Array: fit
 *   units missing for the gene); `model` what the result says of the fit
 *   (`describe…` keys: design, libraries, factors, prior)
 */
export function pseudobulkLimma({
  sums, measured, expressing, geneCount, units, pairOf = null, counts, unitLibraries = null, minCellsPerSample, foldChange
}) {
  const unitCount = units.unitCount;
  if (sums.length !== geneCount * unitCount || measured.length !== sums.length || expressing.length !== sums.length) {
    throw new RangeError('Pseudobulk sums, measured and expressing are genes × units');
  }
  if (!Number.isSafeInteger(minCellsPerSample) || minCellsPerSample < 1) {
    throw new RangeError('The minimum cells per sample must be a positive integer');
  }
  if (unitLibraries !== null && unitLibraries.length !== unitCount) {
    throw new RangeError('The units\' library sizes need one a unit');
  }
  // The fit's units: every unit, or (paired) those of donors in both groups.
  const fitUnits = [];
  for (let unit = 0; unit < unitCount; unit++) {
    if (pairOf === null || pairOf[unit] >= 0 || (units.unitSide[unit] === 2 && pairOf.includes(unit))) fitUnits.push(unit);
  }
  const fitCount = fitUnits.length;
  // The design: intercept, the donors past the first (paired), then the
  // group (1 for A: its coefficient is A − B).
  const donors = pairOf === null ? [] : [...new Set(fitUnits.map(unit => units.unitSample[unit]))];
  const columnCount = 2 + Math.max(donors.length - 1, 0);
  const design = new Float64Array(fitCount * columnCount);
  fitUnits.forEach((unit, row) => {
    design[row * columnCount] = 1;
    const donor = donors.indexOf(units.unitSample[unit]);
    if (donor > 0) design[row * columnCount + donor] = 1;
    if (units.unitSide[unit] === 1) design[row * columnCount + columnCount - 1] = 1;
  });
  const fitSums = new Float64Array(geneCount * fitCount);
  for (let gene = 0; gene < geneCount; gene++) {
    for (let k = 0; k < fitCount; k++) fitSums[gene * fitCount + k] = sums[gene * unitCount + fitUnits[k]];
  }
  // Each fit unit's values: log-CPM of its sums (counts), else its means.
  let values;
  let libraries = null;
  let normalization = null;
  if (counts) {
    if (unitLibraries !== null) {
      libraries = Float64Array.from(fitUnits, unit => unitLibraries[unit]);
    } else {
      libraries = new Float64Array(fitCount);
      for (let gene = 0; gene < geneCount; gene++) {
        for (let k = 0; k < fitCount; k++) libraries[k] += fitSums[gene * fitCount + k];
      }
    }
    for (let k = 0; k < fitCount; k++) {
      if (!(libraries[k] > 0)) {
        throw new RangeError(unitLibraries === null
          ? 'A sample has no counts over any gene: it has no library size'
          : 'A sample\'s cells have no stored total counts: it has no library size');
      }
    }
    const tmm = tmmNormFactors(fitSums, geneCount, fitCount, libraries);
    const effective = Float64Array.from(libraries, (library, k) => library * tmm.factors[k]);
    values = logCpm(fitSums, geneCount, fitCount, effective);
    normalization = { factors: tmm.factors, reference: tmm.reference, effective };
  } else {
    values = new Float64Array(geneCount * fitCount);
    for (let gene = 0; gene < geneCount; gene++) {
      for (let k = 0; k < fitCount; k++) {
        const at = gene * unitCount + fitUnits[k];
        values[gene * fitCount + k] = measured[at] > 0 ? sums[at] / measured[at] : NaN;
      }
    }
  }
  // Missing units, and the genes some cell of the fit expresses.
  const genes = {
    meanA: new Float64Array(geneCount).fill(NaN),
    meanB: new Float64Array(geneCount).fill(NaN),
    pctA: new Float64Array(geneCount).fill(NaN),
    pctB: new Float64Array(geneCount).fill(NaN),
    log2FoldChange: new Float64Array(geneCount).fill(NaN),
    statistic: new Float64Array(geneCount).fill(NaN),
    pValue: new Float64Array(geneCount).fill(NaN),
    nA: new Int32Array(geneCount),
    nB: new Int32Array(geneCount),
    expressed: new Uint8Array(geneCount),
    missingUnits: new Int32Array(geneCount)
  };
  const fitGenes = [];
  for (let gene = 0; gene < geneCount; gene++) {
    let cellsA = 0;
    let cellsB = 0;
    let aboveA = 0;
    let aboveB = 0;
    for (let unit = 0; unit < unitCount; unit++) {
      const at = gene * unitCount + unit;
      if (units.unitSide[unit] === 1) {
        cellsA += measured[at];
        aboveA += expressing[at];
      } else {
        cellsB += measured[at];
        aboveB += expressing[at];
      }
    }
    genes.pctA[gene] = cellsA > 0 ? (100 * aboveA) / cellsA : NaN;
    genes.pctB[gene] = cellsB > 0 ? (100 * aboveB) / cellsB : NaN;
    let expressedCells = 0;
    let totalA = 0;
    let totalB = 0;
    for (let k = 0; k < fitCount; k++) {
      const at = gene * unitCount + fitUnits[k];
      if (measured[at] < minCellsPerSample) {
        values[gene * fitCount + k] = NaN;
        genes.missingUnits[gene] += 1;
        continue;
      }
      expressedCells += expressing[at];
      const value = values[gene * fitCount + k];
      if (units.unitSide[fitUnits[k]] === 1) {
        genes.nA[gene] += 1;
        totalA += value;
      } else {
        genes.nB[gene] += 1;
        totalB += value;
      }
    }
    genes.meanA[gene] = genes.nA[gene] > 0 ? totalA / genes.nA[gene] : NaN;
    genes.meanB[gene] = genes.nB[gene] > 0 ? totalB / genes.nB[gene] : NaN;
    if (expressedCells > 0) {
      genes.expressed[gene] = 1;
      fitGenes.push(gene);
    }
  }
  if (fitGenes.length === 0) throw new RangeError('No gene is expressed in the compared samples');
  // limma, on the expressed genes.
  const fitValues = new Float64Array(fitGenes.length * fitCount);
  fitGenes.forEach((gene, row) => fitValues.set(values.subarray(gene * fitCount, (gene + 1) * fitCount), row * fitCount));
  const fit = lmFit(fitValues, fitGenes.length, fitCount, design, columnCount, columnCount - 1);
  const moderated = eBayes(fit, { trend: true });
  fitGenes.forEach((gene, row) => {
    const p = moderated.pValue[row];
    if (!Number.isFinite(p)) return;
    genes.statistic[gene] = moderated.t[row];
    genes.pValue[gene] = p;
    if (counts) {
      genes.log2FoldChange[gene] = fit.coefficient[row];
    } else {
      let minimum = Infinity;
      for (let k = 0; k < fitCount; k++) {
        const value = fitValues[row * fitCount + k];
        if (value < minimum) minimum = value;
      }
      genes.log2FoldChange[gene] = foldChangeOfMeans(genes.meanA[gene], genes.meanB[gene], minimum, foldChange);
    }
  });
  const s2Prior = Float64Array.from(moderated.s2Prior).sort();
  const model = {
    design: pairOf === null ? '~ group' : '~ donor + group',
    samples: fitCount,
    donors: donors.length,
    counts,
    libraries: counts ? (unitLibraries === null ? 'column sums' : 'stored totals') : null,
    librarySizes: libraries === null ? null : Array.from(libraries),
    normFactors: normalization === null ? null : Array.from(normalization.factors),
    referenceSample: normalization === null ? null : normalization.reference,
    genesFit: fitGenes.length,
    genesNotExpressed: geneCount - fitGenes.length,
    priorDf: moderated.dfPrior,
    priorVariance: { min: s2Prior[0], median: rMedian(s2Prior), max: s2Prior[s2Prior.length - 1] },
    trend: moderated.splineDf >= 2,
    splineDf: moderated.splineDf,
    dfPooled: moderated.dfPooled
  };
  return { genes, model };
}

/** A number of a fit in words: four significant digits. */
const fitNumber = value => (value === null ? '∞' : Number(value.toPrecision(4)).toString());

/**
 * How a pseudobulk fit normalized its samples, in words (a result's
 * Statistics and `about`).
 *
 * @param {Object} model - `pseudobulkLimma`'s `model`, as a result keeps it
 *   (`priorDf` null: infinite; `libraryField` the stored totals' field)
 * @returns {string}
 */
export function describePseudobulkNormalisation(model) {
  if (!model.counts) return 'none: each sample\'s mean of the values as stored';
  const factors = model.normFactors;
  const libraries = model.libraries === 'stored totals'
    ? `the samples' summed stored ${model.libraryField}`
    : 'the samples\' summed counts over every gene';
  return `raw counts summed per sample (the expression transform does not apply); TMM (edgeR calcNormFactors) on library sizes from ${libraries}, ` +
    `factors ${fitNumber(Math.min(...factors))}–${fitNumber(Math.max(...factors))}; log-CPM (edgeR cpm, log = TRUE, prior.count = 2)`;
}

/**
 * The pseudobulk fit's model in words: design and moderation.
 *
 * @param {Object} model - As `describePseudobulkNormalisation`
 * @param {string} field - The sample field
 * @returns {string}
 */
export function describePseudobulkModel(model, field) {
  const design = model.design === '~ group'
    ? `~ group over ${model.samples} samples of ${field}`
    : `~ donor + group over the ${model.donors} samples of ${field} in both groups (each its own level, blocked)`;
  const prior = model.priorDf === null
    ? 'prior df infinite (the variances spread no more than chance): each gene\'s variance is the prior\'s'
    : `prior df d0 = ${fitNumber(model.priorDf)}`;
  const variance = model.priorVariance.min === model.priorVariance.max
    ? `s0² = ${fitNumber(model.priorVariance.median)}`
    : `s0² ${fitNumber(model.priorVariance.min)}–${fitNumber(model.priorVariance.max)} (median ${fitNumber(model.priorVariance.median)})`;
  return `limma lmFit ${design}, then eBayes${model.trend ? '(trend = TRUE): ' : ': '}${prior}, ${variance}` +
    `${model.trend ? ` trending with the mean ${model.counts ? 'log-CPM' : 'value'}` : ''}, from ${model.genesFit} genes; ` +
    `moderated t of the group coefficient on d + d0 df`;
}
