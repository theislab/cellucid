/**
 * Pseudobulk differential expression held to edgeR and limma
 * (`stats/pseudobulk.js` `pseudobulkLimma`, `stats/edger-normalization.js`,
 * `stats/limma.js`): TMM factors and log-CPM as `normLibSizes(method =
 * "TMM")` and `cpm(log = TRUE, prior.count = 2)`, the per-gene fit as
 * `lmFit`, the moderation as `eBayes(trend = TRUE)` with `fitFDist`, at
 * 1e-6 (p-values relative), on the cases of
 * `tests/fixtures/analysis/pseudobulk-limma-reference.json`, written by
 * `scripts/generate-pseudobulk-limma-reference.R` with R 4.5.3, edgeR 4.10.7
 * and limma 3.68.5: unpaired and paired (`~ donor + group`, donors in one
 * group only left out), library sizes as column sums and as stored totals,
 * missing units (unequal residual df, a gene with none, a gene measured
 * nowhere), unexpressed genes, a trend knot shoved off its boundary, values
 * that are not counts, an infinite prior df, and two genes (no moderation).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { pairedUnits, pseudobulkLimma, pseudobulkUnits, unitLibrarySizes } from '../assets/js/app/analysis/stats/pseudobulk.js';
import { logCpm, tmmNormFactors } from '../assets/js/app/analysis/stats/edger-normalization.js';
import {
  digamma, eBayes, lmFit, logmdigamma, studentTwoSidedP, tetragamma, trigamma, trigammaInverse
} from '../assets/js/app/analysis/stats/limma.js';

const FIXTURE = new URL('./fixtures/analysis/pseudobulk-limma-reference.json', import.meta.url);
const text = readFileSync(FIXTURE, 'utf8');
const { versions, cases } = JSON.parse(text);

const number = value => (value === null ? NaN : value === 'Infinity' ? Infinity : value === '-Infinity' ? -Infinity : value);
const numbers = values => Float64Array.from(values, number);

function close(actual, expected, label, { relative = false } = {}) {
  if (Number.isNaN(expected)) {
    assert.ok(Number.isNaN(actual), `${label}: ${actual}, expected NA`);
    return;
  }
  if (!Number.isFinite(expected)) {
    assert.equal(actual, expected, label);
    return;
  }
  const scale = relative ? Math.max(Math.abs(expected), 1e-300) : Math.max(1, Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= 1e-6 * scale, `${label}: ${actual}, R ${expected}`);
}

/** The case's units as `pseudobulkUnits` gives them. */
function unitsOf(input) {
  return {
    unitCount: input.units,
    unitSide: Uint8Array.from(input.sides),
    unitSample: Int32Array.from(input.samples)
  };
}

function fitOf(input) {
  const units = unitsOf(input);
  return pseudobulkLimma({
    sums: numbers(input.sums),
    measured: numbers(input.measured),
    expressing: numbers(input.expressing),
    geneCount: input.genes,
    units,
    pairOf: input.paired ? pairedUnits(units).pairOf : null,
    counts: input.counts,
    unitLibraries: input.unitLibraries === null ? null : numbers(input.unitLibraries),
    minCellsPerSample: input.minCellsPerSample,
    foldChange: { mode: 'stored', base: null }
  });
}

test('the reference is the one the R script wrote, by edgeR 4.10.7 and limma 3.68.5', () => {
  assert.deepEqual(versions, { R: '4.5.3', edgeR: '4.10.7', limma: '3.68.5' });
  assert.equal(cases.length, 7);
});

test('polygamma functions and Student\'s t as R computes them', () => {
  // R 4.5.3: digamma, trigamma, psigamma(deriv = 2), limma's logmdigamma and
  // trigammaInverse, 2 * pt(-abs(t), df).
  const reference = [
    [digamma(0.5), -1.9635100260214231], [digamma(3.7), 1.1671535393615113], [digamma(40.25), 3.6826362084455622],
    [trigamma(0.5), 4.934802200544679], [trigamma(3.7), 0.31003785767003833], [trigamma(40.25), 0.025155906192376006],
    [tetragamma(0.5), -16.82879664423432], [tetragamma(3.7), -0.095395308728554035], [tetragamma(40.25), -0.00063278625800094329],
    [logmdigamma(0.5), 1.2703628454613649], [logmdigamma(3.7), 0.14117928028866727], [logmdigamma(40.25), 0.012473795419009961],
    [trigammaInverse(0.31003785767003833), 3.7000000000000006], [trigammaInverse(4.934802200544679), 0.5]
  ];
  for (const [actual, expected] of reference) close(actual, expected, `special function ${expected}`, { relative: true });
  const tails = [
    [2.1, 5, 0.089753249884598679], [0.3, 3.5, 0.78113340983988966], [-4.2, 12.7, 0.001092037057024149],
    [9, 20, 1.8040416180193579e-08], [25, 1000, 1.5203541383321533e-107], [3, 250000, 0.0027000619811317584],
    [3, 5e5, 0.0026999290204542631], [0.1, Infinity, 0.92034432544594202]
  ];
  for (const [t, df, p] of tails) close(studentTwoSidedP(t, df), p, `2 pt(-|${t}|, ${df})`, { relative: true });
});

for (const { name, input, expected } of cases) {
  test(`edgeR and limma: ${name}`, () => {
    const units = unitsOf(input);
    const fitUnits = expected.fitUnits;
    const fitCount = fitUnits.length;
    const sums = numbers(input.sums);
    const fitSums = new Float64Array(input.genes * fitCount);
    for (let gene = 0; gene < input.genes; gene++) {
      fitUnits.forEach((unit, k) => { fitSums[gene * fitCount + k] = sums[gene * input.units + unit]; });
    }
    // edgeR: library sizes, TMM factors, log-CPM.
    if (input.counts) {
      const libraries = numbers(expected.librarySizes);
      if (input.unitLibraries === null) {
        for (let k = 0; k < fitCount; k++) {
          let sum = 0;
          for (let gene = 0; gene < input.genes; gene++) sum += fitSums[gene * fitCount + k];
          close(sum, libraries[k], `column sum ${k}`);
        }
      }
      const { factors } = tmmNormFactors(fitSums, input.genes, fitCount, libraries);
      factors.forEach((factor, k) => close(factor, expected.normFactors[k], `TMM factor ${k}`));
      const values = logCpm(fitSums, input.genes, fitCount, libraries.map((library, k) => library * expected.normFactors[k]));
      const expectedValues = numbers(expected.values);
      values.forEach((value, i) => {
        if (!Number.isNaN(expectedValues[i])) close(value, expectedValues[i], `log-CPM ${i}`);
      });
    }
    // limma on R's own values: lmFit, then eBayes.
    const keep = expected.keep;
    const allValues = numbers(expected.values);
    const values = new Float64Array(keep.length * fitCount);
    keep.forEach((gene, row) => values.set(allValues.subarray(gene * fitCount, (gene + 1) * fitCount), row * fitCount));
    const design = [];
    const donors = input.paired ? [...new Set(fitUnits.map(unit => input.samples[unit]))].sort((a, b) => a - b) : [];
    const columns = 2 + Math.max(donors.length - 1, 0);
    for (const unit of fitUnits) {
      const row = new Array(columns).fill(0);
      row[0] = 1;
      const donor = donors.indexOf(input.samples[unit]);
      if (donor > 0) row[donor] = 1;
      if (input.sides[unit] === 1) row[columns - 1] = 1;
      design.push(...row);
    }
    const fit = lmFit(values, keep.length, fitCount, Float64Array.from(design), columns, columns - 1);
    for (const key of ['coefficient', 'stdevUnscaled', 'sigma', 'dfResidual', 'Amean']) {
      fit[key].forEach((value, row) => close(value, number(expected[key][row]), `${key} of gene ${keep[row]}`));
    }
    const moderated = eBayes(fit, { trend: true });
    close(moderated.dfPrior, number(expected.dfPrior[0]), 'prior df');
    for (const [key, actual] of [['s2Prior', moderated.s2Prior], ['s2Post', moderated.s2Post], ['t', moderated.t], ['dfTotal', moderated.dfTotal]]) {
      actual.forEach((value, row) => close(value, number(expected[key][row]), `${key} of gene ${keep[row]}`));
    }
    moderated.pValue.forEach((value, row) => close(value, number(expected.pValue[row]), `p of gene ${keep[row]}`, { relative: true }));

    // The whole fit from the units' sums, as the analysis runs it.
    const { genes, model } = fitOf(input);
    const kept = new Set(keep);
    for (let gene = 0; gene < input.genes; gene++) {
      const row = keep.indexOf(gene);
      assert.equal(genes.expressed[gene], kept.has(gene) && fit.dfResidual[row] >= 0 ? 1 : 0, `gene ${gene} in the fit`);
      if (row < 0) {
        assert.ok(Number.isNaN(genes.pValue[gene]), `gene ${gene} untested`);
        continue;
      }
      close(genes.statistic[gene], number(expected.t[row]), `moderated t of gene ${gene}`);
      close(genes.pValue[gene], number(expected.pValue[row]), `p of gene ${gene}`, { relative: true });
      if (input.counts) close(genes.log2FoldChange[gene], number(expected.coefficient[row]), `log2 fold change of gene ${gene}`);
    }
    close(model.priorDf, number(expected.dfPrior[0]), 'model prior df');
    assert.equal(model.design, input.paired ? '~ donor + group' : '~ group');
    assert.equal(model.samples, fitCount);
    assert.equal(model.genesFit, keep.length);
    assert.equal(model.genesNotExpressed, input.genes - keep.length);
    if (input.counts) {
      assert.equal(model.libraries, input.unitLibraries === null ? 'column sums' : 'stored totals');
      model.normFactors.forEach((factor, k) => close(factor, expected.normFactors[k], `model factor ${k}`));
    } else {
      assert.equal(model.libraries, null);
      assert.equal(model.normFactors, null);
    }
  });
}

test('a paired fit leaves out the donors in one group only; library sizes are the samples\' stored totals summed', () => {
  // Cells: A donors 0, 1, 2; B donors 0, 1, 3.
  const codes = Uint8Array.of(0, 1, 2, 0, 1, 3);
  const units = pseudobulkUnits(Uint32Array.of(0, 1, 2), Uint32Array.of(3, 4, 5), codes, 255, 6, 1);
  const pairing = pairedUnits(units);
  assert.deepEqual({ pairs: pairing.pairs, unpairedA: pairing.unpairedA, unpairedB: pairing.unpairedB }, { pairs: 2, unpairedA: 1, unpairedB: 1 });
  assert.deepEqual([...pairing.pairOf], [3, 4, -1, -1, -1, -1]);
  assert.deepEqual([...unitLibrarySizes(units, Float64Array.of(10, 20, NaN, 40, 50, 60))], [10, 20, 0, 40, 50, 60]);
  // A paired case of the reference has 10 units, 8 of them fit.
  const paired = cases.find(({ input }) => input.paired);
  assert.equal(fitOf(paired.input).model.samples, 8);
});

test('a sample without counts or stored totals has no library size, and is refused', () => {
  const { input } = cases[0];
  const sums = numbers(input.sums);
  for (let gene = 0; gene < input.genes; gene++) sums[gene * input.units] = 0;
  assert.throws(() => fitOf({ ...input, sums: Array.from(sums) }), /no counts over any gene/);
  const libraries = new Array(input.units).fill(1000);
  libraries[2] = 0;
  assert.throws(() => fitOf({ ...input, unitLibraries: libraries }), /no stored total counts/);
});

/**
 * A dataset of cells whose samples' sums are a case's: each unit 30 cells,
 * its first cell holding the unit's count of every gene, the rest 0; with
 * stored totals, the unit's library on its first cell.
 */
function datasetOf(input) {
  const cellsPerUnit = 30;
  const pointCount = input.units * cellsPerUnit;
  const sums = numbers(input.sums);
  const codes = new Uint8Array(pointCount);
  const columns = {};
  const geneNames = Array.from({ length: input.genes }, (_, gene) => `g${gene}`);
  geneNames.forEach((name, gene) => {
    const column = new Float32Array(pointCount);
    for (let unit = 0; unit < input.units; unit++) column[unit * cellsPerUnit] = sums[gene * input.units + unit];
    columns[name] = column;
  });
  const sideCells = side => {
    const cells = [];
    for (let unit = 0; unit < input.units; unit++) {
      if (input.sides[unit] !== side) continue;
      for (let k = 0; k < cellsPerUnit; k++) cells.push(unit * cellsPerUnit + k);
    }
    return Uint32Array.from(cells);
  };
  for (let unit = 0; unit < input.units; unit++) codes.fill(input.samples[unit], unit * cellsPerUnit, (unit + 1) * cellsPerUnit);
  const totals = new Float64Array(pointCount);
  if (input.unitLibraries !== null) {
    for (let unit = 0; unit < input.units; unit++) totals[unit * cellsPerUnit] = number(input.unitLibraries[unit]);
  }
  return { pointCount, codes, columns, geneNames, cellsA: sideCells(1), cellsB: sideCells(2), totals };
}

async function runDifferential(input, { geneList = null } = {}) {
  const { MultiVariableAnalysis } = await import('../assets/js/app/analysis/stats/multi-variable-analysis.js');
  const { executeOperation } = await import('../assets/js/app/analysis/compute/operation-handlers.js');
  const data = datasetOf(input);
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    state: { pointCount: data.pointCount },
    resolveExpressionMatrix: () => ({ matrix: 'X', read: null, label: 'Mapped (X)' }),
    geneCellsOf: async () => null,
    matrixHoldsCounts: () => input.counts,
    async getGeneKeys() { return data.geneNames; },
    getAvailableVariables: () => data.geneNames.map(key => ({ key })),
    async readGeneColumn(gene) { return { fieldIndex: 0, values: data.columns[gene], owned: false }; },
  };
  analysis._getComputeManager = async () => ({
    selectBackend: () => 'cpu',
    async broadcast(operation, payloadFor) { return [executeOperation(operation, payloadFor(0))]; },
    async execute(operation, payload) { return executeOperation(operation, payload); },
  });
  return analysis.differentialExpression({
    groupA: { name: 'A', cells: data.cellsA },
    groupB: { name: 'B', cells: data.cellsB },
    geneList,
    replicates: { name: 'donor', codes: data.codes, missingCode: 255, minCellsPerSample: input.minCellsPerSample },
    paired: input.paired,
    cellTotals: input.unitLibraries === null ? null : { field: 'total_counts', totals: data.totals },
  });
}

test('differential expression with replicates streams every gene, fits once, and reports the genes asked for', async () => {
  for (const index of [0, 3]) {
    const { input, expected } = cases[index];
    const result = await runDifferential(input);
    const model = result.summary.replicates.model;
    assert.equal(model.design, input.paired ? '~ donor + group' : '~ group');
    assert.equal(model.libraries, input.unitLibraries === null ? 'column sums' : 'stored totals');
    assert.equal(model.libraryField, input.unitLibraries === null ? null : 'total_counts');
    assert.deepEqual(result.summary.foldChange, { mode: 'log2cpm', base: null });
    assert.equal(result.summary.method, 'pseudobulk');
    assert.equal(result.summary.replicates.paired, input.paired);
    assert.equal(result.summary.genesTested, expected.keep.length);
    for (const [row, gene] of expected.keep.entries()) {
      const entry = result.results.find(candidate => candidate.gene === `g${gene}`);
      close(entry.score, number(expected.t[row]), `${input.paired ? 'paired' : 'unpaired'} t of g${gene}`);
      close(entry.pValue, number(expected.pValue[row]), `p of g${gene}`, { relative: true });
      close(entry.log2FoldChange, number(expected.coefficient[row]), `log2 fold change of g${gene}`);
    }
    const unexpressed = result.results.find(candidate => candidate.gene === `g${input.genes - 1}`);
    assert.equal(unexpressed.error, 'Not expressed in any sample compared');
    // Asking for three genes: their rows only, the fit (and its prior) of every gene.
    const asked = expected.keep.slice(0, 3).map(gene => `g${gene}`);
    const subset = await runDifferential(input, { geneList: asked });
    assert.deepEqual(subset.results.map(entry => entry.gene).sort(), [...asked].sort());
    for (const entry of subset.results) {
      const row = expected.keep.indexOf(Number(entry.gene.slice(1)));
      close(entry.score, number(expected.t[row]), `subset t of ${entry.gene}`);
    }
    assert.equal(subset.summary.replicates.model.genesFit, expected.keep.length);
  }
});
