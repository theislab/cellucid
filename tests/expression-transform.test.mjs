/**
 * The expression transform (Data mapping › Expression values,
 * `data/expression-transform.js`), the cells' totals it divides by
 * (`data/library-sizes.js`), the gene loader that shows it
 * (`state/managers/expression-values.js`), a run's values in the analysis
 * threads (`analysis/compute/task-values.js`) and the tests on them, held to
 * scanpy 1.11.5: `normalize_total(target_sum=1e4)`, `log1p` and both, then
 * `rank_genes_groups` (Wilcoxon and t-test) on the 8 × 5 matrix below
 * (`fixtures/analysis/scanpy-expression-transform.json`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  EXPRESSION_TARGET_SUM, RAW_VALUES, cellFactors, describeValues, effectiveTransform, factorsOfCells, isValuesRecord,
  requireExpressionTransform, transformBlock, transformColumn, transformKey, transformRows, transformUnits,
  transformValue, transformWords, valuesRecord,
} from '../assets/js/data/expression-transform.js';
import { cellLibrarySizes, keptLibrarySizes, rowLibrarySizes, totalsOfObsField } from '../assets/js/data/library-sizes.js';
import { noteColumnForm, columnFormOf } from '../assets/js/data/column-forms.js';
import { DataStateExpressionMethods, baseVarLoader, shownTransformOf } from '../assets/js/app/state/managers/expression-values.js';
import { clearCellScale, runScale, setCellScale, taskTransform, transformedTask } from '../assets/js/app/analysis/compute/task-values.js';
import { executeOperation } from '../assets/js/app/analysis/compute/operation-handlers.js';
import { OperationType } from '../assets/js/app/analysis/compute/operations.js';
import { createGroupSummaryContext, summarizeGenesByGroup } from '../assets/js/app/analysis/compute/group-expression-summary.js';
import { taskGenes } from '../assets/js/app/analysis/shared/gene-stream-runner.js';
import { momentsMatrixOf } from '../assets/js/app/analysis/shared/gene-moments-cache.js';

const REFERENCE = JSON.parse(readFileSync(new URL('./fixtures/analysis/scanpy-expression-transform.json', import.meta.url), 'utf8'));

// 8 cells × 5 genes of raw counts; cells 0-3 are group A, 4-7 group B.
const X = [
  [0, 3, 10, 1, 0],
  [2, 0, 25, 0, 1],
  [1, 5, 4, 2, 0],
  [0, 1, 40, 0, 3],
  [5, 0, 2, 7, 0],
  [3, 2, 0, 9, 1],
  [0, 0, 6, 4, 2],
  [7, 1, 1, 12, 0],
];
const CELLS = X.length;
const GENES = X[0].length;
const TRANSFORMS = {
  normalized: { normalize: true, log1p: false },
  log1p: { normalize: false, log1p: true },
  'normalized-log1p': { normalize: true, log1p: true },
};
const totals = X.map(row => row.reduce((sum, value) => sum + value, 0));
const column = gene => Float32Array.from(X, row => row[gene]);
const sparse = values => {
  const indices = Uint32Array.from([...values.keys()].filter(cell => values[cell] !== 0));
  return { length: values.length, indices, values: Float32Array.from(indices, cell => values[cell]) };
};
const dense = entries => {
  const out = new Float64Array(entries.length);
  entries.indices.forEach((cell, k) => { out[cell] = entries.values[k]; });
  return out;
};
const close = (actual, expected, tolerance, what) => {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${what}: ${actual} is not ${expected}`);
};

test('each transform of a gene, dense or its entries, is scanpy normalize_total(1e4) / log1p / both to 1e-6', () => {
  assert.equal(EXPRESSION_TARGET_SUM, 10_000);
  const factors = cellFactors(Float64Array.from(totals));
  for (const [key, transform] of Object.entries(TRANSFORMS)) {
    const expected = REFERENCE.variants[key].values;
    for (let gene = 0; gene < GENES; gene++) {
      const of = transform.normalize ? factors : null;
      const fromDense = transformColumn(column(gene), of, transform.log1p);
      assert.ok(fromDense instanceof Float32Array);
      const fromEntries = dense(transformColumn(sparse(column(gene)), of, transform.log1p));
      for (let cell = 0; cell < CELLS; cell++) {
        close(fromDense[cell], expected[cell][gene], 1e-6, `${key}: cell ${cell} gene ${gene} (dense)`);
        close(fromEntries[cell], expected[cell][gene], 1e-6, `${key}: cell ${cell} gene ${gene} (entries)`);
      }
    }
  }
});

test('zeros stay zero, a cell not read stays not read, a total of 0 keeps its zeros; the input is never written', () => {
  const factors = cellFactors(Float64Array.of(0, NaN, 5, 10));
  assert.deepEqual([...factors.slice(0, 1)], [0]);
  assert.ok(Number.isNaN(factors[1]));
  assert.equal(transformValue(0, NaN, true), 0);
  assert.ok(Number.isNaN(transformValue(NaN, 2, true)));
  assert.ok(Number.isNaN(transformValue(3, NaN, false)));
  const values = Float32Array.of(0, 0, 5, NaN);
  const out = transformColumn(values, factors, true);
  assert.deepEqual([...out.slice(0, 2)], [0, 0]);
  close(out[2], Math.log1p(10_000), 1e-7, 'one cell of total 5 holding 5');
  assert.ok(Number.isNaN(out[3]));
  assert.ok(Number.isNaN(values[3]) && values[2] === 5);
  // Rows of a gene read for cells added: their own factors, from `from`.
  const rows = transformRows(Float32Array.of(5, 0), 2, factors, false);
  assert.deepEqual([...rows], [10_000, 0]);
  assert.throws(() => transformRows(Float32Array.of(1, 1), 3, factors, false), RangeError);
  assert.throws(() => transformColumn(Float32Array.of(1, 2, 3, 4, 5), factors, false), RangeError);
});

test('a block of genes in a cell subset is transformed by those cells\' factors, by position', () => {
  const factors = cellFactors(Float64Array.from(totals));
  const cells = Uint32Array.of(1, 2, 5, 6);
  const pointers = [0];
  const cellIndex = [];
  const values = [];
  for (let gene = 0; gene < GENES; gene++) {
    cells.forEach((cell, position) => {
      if (X[cell][gene] !== 0) { cellIndex.push(position); values.push(X[cell][gene]); }
    });
    pointers.push(cellIndex.length);
  }
  for (const [key, transform] of Object.entries(TRANSFORMS)) {
    const block = { pointers: Float64Array.from(pointers), cellIndex: Int32Array.from(cellIndex), values: Float32Array.from(values) };
    const out = transformBlock(block, transform.normalize ? factorsOfCells(factors, cells) : null, transform.log1p);
    out.cellIndex.forEach((position, k) => {
      const gene = out.pointers.findIndex(pointer => pointer > k) - 1;
      close(out.values[k], REFERENCE.variants[key].values[cells[position]][gene], 1e-6, `${key}: subset position ${position}`);
    });
    assert.equal(block.values[0], values[0], 'the block read is left as it is');
  }
});

test('words, units, keys and what a result keeps', () => {
  assert.equal(requireExpressionTransform({ normalize: false, log1p: false }), RAW_VALUES);
  assert.throws(() => requireExpressionTransform({ normalize: true }), TypeError);
  assert.throws(() => requireExpressionTransform({ normalize: 1, log1p: false }), TypeError);
  assert.equal(effectiveTransform(TRANSFORMS.log1p, false), RAW_VALUES);
  assert.deepEqual(Object.values(TRANSFORMS).map(transformKey), ['normalized', 'log1p', 'normalized-log1p']);
  assert.deepEqual(Object.values(TRANSFORMS).map(transformWords), ['Normalized', 'log1p', 'Normalized · log1p']);
  assert.deepEqual([RAW_VALUES, ...Object.values(TRANSFORMS)].map(transformUnits), [null, 'norm.', 'log1p', 'log1p(norm.)']);
  const record = valuesRecord(TRANSFORMS['normalized-log1p'], { source: "obs['total_counts'] (over all genes)" });
  assert.equal(isValuesRecord(record), true);
  assert.equal(isValuesRecord(null), true);
  assert.equal(isValuesRecord({ normalize: false, log1p: false, totals: null }), false);
  assert.equal(describeValues(record), "ln(1 + x · 10,000 / cell total), cell totals from obs['total_counts'] (over all genes)");
  assert.equal(describeValues(valuesRecord(TRANSFORMS.log1p, null)), 'ln(1 + x)');
  assert.match(describeValues(null, { counts: true }), /raw counts as stored/);
  assert.equal(valuesRecord(RAW_VALUES, null), null);
  assert.throws(() => valuesRecord(TRANSFORMS.normalized, null), TypeError);
  assert.equal(momentsMatrixOf(null), 'mapped');
  assert.equal(momentsMatrixOf(record), "mapped normalized by obs['total_counts'] (over all genes) log1p");
});

test('cells\' totals: the file\'s named column first, then a column named like one, else every gene once; cells added read alone', async () => {
  assert.equal(totalsOfObsField(Float32Array.of(1, NaN), 2), null);
  const base = { holder: {}, pointCount: CELLS, readTo: CELLS, matrixLabel: 'X', candidates: ['n_counts'], geneCount: GENES };
  // The file's record wins over a name ranked as a total.
  const named = await cellLibrarySizes({
    ...base, stored: { field: 'total_counts', over: 'all genes' },
    readObs: async key => (key === 'total_counts' ? Float32Array.from(totals, total => total * 3) : Float32Array.from(totals)),
    readGene: async () => assert.fail('no gene is read when a column holds the totals'),
  });
  assert.equal(named.field, 'total_counts');
  assert.equal(named.source, "obs['total_counts'] (over all genes)");
  assert.deepEqual([...named.totals], totals.map(total => total * 3));
  // A column that is not totals (a NaN) is passed over; then the genes.
  let geneReads = 0;
  const holder = {};
  const options = {
    ...base, holder, stored: null, candidates: ['n_counts'], readObs: async () => Float32Array.of(1, NaN, 1, 1, 1, 1, 1, 1),
    readGene: async gene => { geneReads++; return sparse(column(gene)); },
  };
  const [first, second] = await Promise.all([cellLibrarySizes({ ...options, readTo: 6 }), cellLibrarySizes({ ...options, readTo: 6 })]);
  assert.equal(first, second);
  assert.equal(geneReads, GENES);
  assert.deepEqual([...first.totals.slice(0, 6)], totals.slice(0, 6));
  assert.ok(Number.isNaN(first.totals[6]) && Number.isNaN(first.factors[7]));
  assert.equal(first.source, 'the sum of its 5 genes of X');
  // More cells read: only the cells added are summed, gene by gene in them.
  const asked = [];
  const readGenesInCells = async (genes, cells) => {
    asked.push([...cells]);
    const pointers = [0]; const cellIndex = []; const values = [];
    for (const gene of genes) {
      cells.forEach((cell, position) => { if (X[cell][gene] !== 0) { cellIndex.push(position); values.push(X[cell][gene]); } });
      pointers.push(cellIndex.length);
    }
    return { pointers: Float64Array.from(pointers), cellIndex: Int32Array.from(cellIndex), values: Float32Array.from(values) };
  };
  const grown = await cellLibrarySizes({ ...options, readTo: CELLS, readGenesInCells });
  assert.equal(geneReads, GENES, 'no gene is read whole again');
  assert.deepEqual(asked.flat(), [6, 7]);
  assert.deepEqual([...grown.totals], totals);
  // Rows of open cells added (the open cells grown in place): their own sums, kept.
  const kept = keptLibrarySizes(holder);
  const rowsHolder = {};
  const six = await cellLibrarySizes({ ...options, holder: rowsHolder, readTo: 6 });
  const rows = await rowLibrarySizes({ holder: rowsHolder, sizes: six, from: 6, to: 8, readObsRows: () => assert.fail(), geneCount: GENES, readGenesInCells, matrixLabel: 'X' });
  assert.deepEqual([...rows], totals.slice(6));
  assert.equal(keptLibrarySizes(rowsHolder).readTo, 8);
  assert.equal(kept.readTo, CELLS);
  assert.throws(() => cellLibrarySizes({ ...options, holder: null }), TypeError);
});

/** A state with the expression methods over a fake matrix loader. */
function fakeState({ stored = null } = {}) {
  const descriptors = Array.from({ length: GENES }, (_, gene) => ({ key: `g${gene}`, path: `g${gene}` }));
  const reads = { whole: 0, sparse: 0 };
  const base = async (field, { onPartial = null } = {}) => {
    reads.whole++;
    const values = column(Number(field.key.slice(1)));
    const form = () => ({ ...sparse(values), readRows: CELLS });
    noteColumnForm(values, form());
    onPartial?.(form(), CELLS);
    return { values, geneSample: null };
  };
  base.readSparseColumn = async field => { reads.sparse++; return sparse(column(Number(field.key.slice(1)))); };
  base.readRows = async (field, [from, to]) => column(Number(field.key.slice(1))).slice(from, to);
  base.resized = () => base;
  base.storedTotals = () => (stored === null ? null : new Map([[null, stored]]));
  base.log1p = () => null;
  const state = Object.create(DataStateExpressionMethods.prototype);
  Object.assign(state, {
    pointCount: CELLS,
    dataMapping: { expression: 'X', log1p: {} },
    obsData: { fields: [{ key: 'total_counts', kind: 'continuous', values: Float32Array.from(totals) }] },
    _obsFieldDescriptors: [{ key: 'total_counts' }],
    _varFieldDescriptors: descriptors,
    varFieldLoader: base,
    _expressionTransform: RAW_VALUES,
    mappingMatrixHoldsCounts: () => true,
    getGeneSample: () => null,
    getVarAxisGeneCount: () => GENES,
    ensureFieldLoaded: async index => state.obsData.fields[index],
    scheduleLoaderRead: ({ start }) => start(new AbortController().signal, 'bulk'),
    fieldLoader: { readRows: async (field, [from, to]) => ({ kind: 'continuous', values: Float32Array.from(totals.slice(from, to)) }) },
  });
  return { state, base, descriptors, reads };
}

test('the gene loader shown: a gene, its partial answer and its rows come in the transform; analysis reads pass through raw', async () => {
  for (const [key, transform] of Object.entries(TRANSFORMS)) {
    const { state, base, descriptors, reads } = fakeState({ stored: { field: 'total_counts', over: 'all genes' } });
    const shown = state.shownVarLoader(base, transform, { lineage: state.matrixLineage(state.dataMapping, descriptors) });
    assert.equal(baseVarLoader(shown), base);
    assert.equal(shownTransformOf(shown), transform);
    assert.equal(shownTransformOf(base), RAW_VALUES);
    const partials = [];
    const loaded = await shown(descriptors[2], { onPartial: column => partials.push(column) });
    const expected = REFERENCE.variants[key].values.map(row => row[2]);
    loaded.values.forEach((value, cell) => close(value, expected[cell], 1e-6, `${key}: shown gene cell ${cell}`));
    // The form beside the column is transformed with it (coloring reads it).
    const form = columnFormOf(loaded.values);
    form.indices.forEach((cell, k) => close(form.values[k], expected[cell], 1e-6, `${key}: form of cell ${cell}`));
    assert.equal(partials.length, 1);
    partials[0].indices.forEach((cell, k) => close(partials[0].values[k], expected[cell], 1e-6, `${key}: partial cell ${cell}`));
    const rows = await shown.readRows(descriptors[2], [5, 8]);
    [...rows].forEach((value, k) => close(value, expected[5 + k], 1e-6, `${key}: row ${5 + k}`));
    // An analysis's reads pass through as stored.
    assert.deepEqual([...(await shown.readSparseColumn(descriptors[2])).values], [...sparse(column(2)).values]);
    assert.equal(reads.sparse, 1, 'no gene is summed: the file names its totals');
    assert.equal(shownTransformOf(shown.resized(CELLS)), transform);
  }
  // The values as stored install the matrix's own loader.
  const { state, base, descriptors } = fakeState();
  assert.equal(state.shownVarLoader(base, RAW_VALUES, { lineage: state.matrixLineage(state.dataMapping, descriptors) }), base);
  assert.throws(() => state.shownVarLoader(state.shownVarLoader(base, TRANSFORMS.log1p, { lineage: state.matrixLineage(state.dataMapping, descriptors) }), TRANSFORMS.log1p), TypeError);
});

test('without a column of totals the shown loader sums every gene once, kept for every later gene and row', async () => {
  const { state, base, descriptors, reads } = fakeState();
  state.obsData = { fields: [] };
  const shown = state.shownVarLoader(base, TRANSFORMS.normalized, { lineage: state.matrixLineage(state.dataMapping, descriptors) });
  state.varFieldLoader = shown;
  await shown(descriptors[0]);
  await shown(descriptors[1]);
  assert.equal(reads.sparse, GENES);
  assert.deepEqual(state.cellTotalsPlan(), { field: null, over: null, genes: GENES });
  assert.deepEqual(state.shownValuesRecord(), { normalize: true, log1p: false, totals: 'the sum of its 5 genes of X' });
  assert.equal(await state.expressionTransformCost(TRANSFORMS.normalized), null, 'the totals are kept: nothing more is read');
  const sizes = await state.mappedLibrarySizes();
  assert.deepEqual([...sizes.totals], totals);
  assert.equal(reads.sparse, GENES);
});

test('the offer: a matrix of counts with no log1p of its own; else the values stay as stored and say why', () => {
  const { state } = fakeState();
  assert.deepEqual(state.expressionTransformOffer(), { offered: true, reason: null });
  state.dataMapping = { expression: 'layer:logcounts', log1p: { 'layer:logcounts': { base: null } } };
  assert.equal(state.expressionTransformOffer().reason, "layers['logcounts'] holds log1p values already (Data mapping › Genes › Values).");
  state.dataMapping = { expression: 'X', log1p: {} };
  state.mappingMatrixHoldsCounts = () => false;
  assert.match(state.expressionTransformOffer().reason, /X does not hold counts/);
  state._expressionTransform = TRANSFORMS['normalized-log1p'];
  assert.equal(state.shownTransformFor(state.dataMapping), RAW_VALUES);
  state.dataMapping = null;
  assert.equal(state.expressionTransformOffer().offered, false);
});

test('a run\'s values in the threads: delivered genes are put in them there, genes read here are not touched again', () => {
  const factors = cellFactors(Float64Array.from(totals));
  const values = { transform: TRANSFORMS['normalized-log1p'], sizes: { factors, source: 'x' }, key: 'normalized-log1p', record: null };
  assert.equal(runScale(values), factors);
  assert.deepEqual([...runScale(values, Uint32Array.of(1, 3))], [factors[1], factors[3]]);
  assert.equal(runScale({ ...values, transform: TRANSFORMS.log1p }), null);
  assert.deepEqual(taskTransform(values, 'id'), { scale: 'id', log1p: true });
  assert.deepEqual(taskTransform({ ...values, transform: TRANSFORMS.log1p }, 'id'), { scale: null, log1p: true });
  assert.equal(taskTransform(null, 'id'), null);
  const delivered = { delivery: { route: 'r', id: 1, generation: 0 }, block: null, columns: null };
  assert.deepEqual(taskGenes(delivered, { scale: 'id', log1p: true }), { delivery: delivered.delivery, transform: { scale: 'id', log1p: true } });
  const here = { delivery: null, block: null, columns: [column(0)] };
  assert.deepEqual(Object.keys(taskGenes(here, { scale: 'id', log1p: true })), ['columns'], 'genes read here name no transform');
  assert.throws(() => transformedTask({ columns: [column(0)], transform: { scale: 'never-held', log1p: false } }), /not held/);
  assert.deepEqual(Object.keys(transformedTask({ columns: [column(0)], transform: null })), ['columns']);
});

test('markers and differential expression on each transform match scanpy rank_genes_groups (Wilcoxon, t-test)', () => {
  const factors = cellFactors(Float64Array.from(totals));
  const groupOfCell = Uint8Array.from({ length: CELLS }, (_, cell) => (cell < 4 ? 1 : 2));
  setCellScale({ scaleId: 'test-cells', scale: factors });
  executeOperation(OperationType.SET_TWO_GROUP_CONTEXT, { contextId: 'test-de', groupOfCell });
  try {
    for (const [key, transform] of Object.entries(TRANSFORMS)) {
      const columns = Array.from({ length: GENES }, (_, gene) => sparse(column(gene)));
      for (const [method, name] of [['wilcox', 'wilcoxon'], ['ttest', 't-test']]) {
        const foldChange = transform.log1p ? { mode: 'log1p', base: null } : { mode: 'stored', base: null };
        const payload = transformedTask({
          contextId: 'test-de', columns, method, pConvention: 'normal', foldChange,
          transform: { scale: transform.normalize ? 'test-cells' : null, log1p: transform.log1p },
        });
        const batch = executeOperation(OperationType.COMPUTE_DIFFERENTIAL_OF_COLUMNS, payload);
        REFERENCE.variants[key][name].forEach((expected, gene) => {
          close(batch.score[gene], expected.score, 1e-6, `${key} ${method} score of gene ${gene}`);
          close(batch.pValue[gene], expected.pval, 1e-6, `${key} ${method} p of gene ${gene}`);
          // scanpy's fold change undoes log1p (natural) and adds 1e-9: Cellucid's log1p mode is the same.
          if (method === 'wilcox' && transform.log1p) close(batch.log2FoldChange[gene], expected.lfc, 1e-5, `${key} log2FC of gene ${gene}`);
        });
      }
    }
  } finally {
    executeOperation(OperationType.CLEAR_TWO_GROUP_CONTEXT, { contextId: 'test-de' });
    clearCellScale({ scaleId: 'test-cells' });
  }
});

test('the dot plot\'s per-group means are of each transform\'s values (scanpy means)', () => {
  const factors = cellFactors(Float64Array.from(totals));
  const context = createGroupSummaryContext(Int16Array.from({ length: CELLS }, (_, cell) => (cell < 4 ? 0 : 1)), 2);
  for (const [key, transform] of Object.entries(TRANSFORMS)) {
    const columns = Array.from({ length: GENES }, (_, gene) => transformColumn(column(gene), transform.normalize ? factors : null, transform.log1p));
    const summary = summarizeGenesByGroup(context, columns, 0, 0);
    for (let gene = 0; gene < GENES; gene++) {
      for (const group of [0, 1]) {
        close(summary.sum[gene * 2 + group] / 4, REFERENCE.variants[key].means[group][gene], 1e-6, `${key} gene ${gene} group ${group}`);
      }
    }
  }
});

test('the cells\' totals stay with the matrix: values shown as stored, then normalized again, read them once', async () => {
  const { state, base, descriptors, reads } = fakeState();
  state.obsData = { fields: [] };
  state.varFieldLoader = state.shownVarLoader(base, TRANSFORMS.normalized, { lineage: state.matrixLineage(state.dataMapping, descriptors) });
  await state.varFieldLoader(descriptors[0]);
  assert.equal(reads.sparse, GENES);
  state.varFieldLoader = state.shownVarLoader(base, RAW_VALUES, { lineage: state.matrixLineage(state.dataMapping, descriptors) });
  assert.equal(state.varFieldLoader, base);
  // A run normalizing while the values are shown as stored shares them.
  await state.mappedLibrarySizes();
  const again = state.shownVarLoader(base, TRANSFORMS['normalized-log1p'], { lineage: state.matrixLineage(state.dataMapping, descriptors) });
  await again(descriptors[1]);
  assert.equal(reads.sparse, GENES, 'no gene is summed again');
});
