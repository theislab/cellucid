/**
 * An analysis's "Expression matrix" (analysis overhaul §2.6): the mapped
 * matrix, or another of the file read through `DataState.openExpressionMatrix`
 * without changing what is shown. The data layer lists the choices from the
 * data-mapping candidates, reads a non-mapped matrix's genes by their names on
 * that matrix's axis, refuses a gene the matrix lacks by name, and opens each
 * matrix once per dataset generation. Marker genes, Differential expression
 * and Dot plot declare the same option.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';
import { MARKER_OPTIONS } from '../assets/js/app/analysis/options/marker-options.js';
import { DE_OPTIONS } from '../assets/js/app/analysis/options/de-options.js';
import { dotplotOptions } from '../assets/js/app/analysis/options/dotplot-options.js';

const EXPRESSION_MENU = [
  { value: null, label: 'None', usable: true, reason: null },
  { value: 'X', label: 'X', usable: true, reason: null },
  { value: 'layer:counts', label: "layers['counts']", usable: true, reason: null },
  { value: 'layer:bad', label: "layers['bad']", usable: false, reason: 'not a matrix' },
  { value: 'raw', label: 'raw.X · 3 genes', usable: true, reason: null },
];

function createState({ menu = EXPRESSION_MENU, expression = 'X' } = {}) {
  const calls = { open: [], sparse: [], subset: [] };
  const rawHandle = Object.freeze({
    expression: 'raw',
    generation: 0,
    fields: Object.freeze([
      { key: 'CD3E', kind: 'continuous', path: 'var/raw/index/0' },
      { key: 'EXTRA', kind: 'continuous', path: 'var/raw/index/1' },
      { key: 'LYZ', kind: 'continuous', path: 'var/raw/index/2' },
    ]),
    loader: { readSparseColumn() {} },
  });
  const state = {
    pointCount: 4,
    varData: { fields: [{ key: 'CD3E', kind: 'continuous' }, { key: 'LYZ', kind: 'continuous' }] },
    getDataMapping: () => ({ expression, geneNames: 'index' }),
    getMappingGroupChoices: group => (group === 'expression' ? menu : null),
    async openExpressionMatrix(matrix) {
      calls.open.push(matrix);
      if (matrix !== 'raw') throw new RangeError(`no ${matrix} in this fixture`);
      return rawHandle;
    },
    async readMatrixSparseColumn(handle, gene, options) {
      calls.sparse.push({ handle, gene, priority: options.priority, owner: options.owner });
      return { length: 4, indices: Uint32Array.of(gene), values: Float32Array.of(gene + 1) };
    },
    async readMatrixCellSubset(handle, genes, cells) {
      calls.subset.push({ handle, genes, cells: [...cells] });
      return { pointers: Float64Array.of(0, 0), cellIndex: new Int32Array(0), values: new Float32Array(0) };
    },
  };
  return { state, calls, rawHandle };
}

function createLayer(state) {
  const layer = Object.create(DataLayer.prototype);
  layer.state = state;
  layer._datasetGeneration = 1;
  layer._destroyed = false;
  layer._matrixHandles = new Map();
  layer._fieldLoadLifecycle = new AbortController();
  return layer;
}

test('the choices are the mapped matrix, then every other usable matrix of the file', () => {
  const layer = createLayer(createState().state);
  assert.deepEqual(layer.getExpressionMatrices(), {
    choices: [
      { value: 'mapped', label: 'Mapped (X)' },
      { value: 'layer:counts', label: "layers['counts']" },
      { value: 'raw', label: 'raw.X · 3 genes' },
    ],
    reason: null,
  });
});

test('a dataset that cannot change its expression matrix lists only the mapped one, saying why', () => {
  const layer = createLayer(createState({ menu: null }).state);
  assert.deepEqual(layer.getExpressionMatrices(), {
    choices: [{ value: 'mapped', label: 'Mapped (X)' }],
    reason: 'This dataset reads only its mapped expression matrix.',
  });
  const none = createLayer(createState({ expression: null }).state);
  assert.deepEqual(none.getExpressionMatrices().choices, [{ value: 'mapped', label: 'Mapped' }]);
  assert.match(none.getExpressionMatrices().reason, /no expression matrix/);
});

test('a choice resolves to what it reads: the mapped matrix through the shown genes, any other by itself', () => {
  const layer = createLayer(createState().state);
  assert.deepEqual(layer.resolveExpressionMatrix('mapped'), { matrix: 'X', read: null, label: 'Mapped (X)' });
  assert.deepEqual(layer.resolveExpressionMatrix('X'), { matrix: 'X', read: null, label: 'Mapped (X)' });
  assert.deepEqual(layer.resolveExpressionMatrix('raw'), { matrix: 'raw', read: 'raw', label: 'raw' });
  assert.deepEqual(
    layer.resolveExpressionMatrix('layer:counts'),
    { matrix: 'layer:counts', read: 'layer:counts', label: "layers['counts']" }
  );
  assert.throws(() => layer.resolveExpressionMatrix('layer:bad'), RangeError);
  assert.throws(() => layer.resolveExpressionMatrix('layer:absent'), RangeError);
});

test('another matrix is read by its own gene names, opened once, every gene owned by the caller', async () => {
  const { state, calls, rawHandle } = createState();
  const layer = createLayer(state);
  assert.deepEqual(await layer.getGeneKeys('mapped'), ['CD3E', 'LYZ']);
  assert.deepEqual(await layer.getGeneKeys('raw'), ['CD3E', 'EXTRA', 'LYZ']);
  const extra = await layer.readGeneColumn('EXTRA', { matrix: 'raw', priority: 'bulk', owner: 'job-1' });
  assert.equal(extra.owned, true);
  assert.equal(extra.fieldIndex, 1);
  assert.deepEqual([...extra.values.values], [2]);
  const lyz = await layer.readGeneColumn('LYZ', { matrix: 'raw' });
  assert.equal(lyz.fieldIndex, 2, 'names on the raw axis, not the mapped one');
  assert.deepEqual(calls.open, ['raw'], 'the matrix is opened once');
  assert.deepEqual(
    calls.sparse.map(({ handle, gene, priority, owner }) => [handle === rawHandle, gene, priority, owner]),
    [[true, 1, 'bulk', 'job-1'], [true, 2, 'normal', null]]
  );
  const columns = await layer.readGeneColumns(['LYZ', 'CD3E'], { matrix: 'raw' });
  assert.deepEqual(columns.map(column => [...column.indices]), [[2], [0]]);
});

test('a gene the matrix lacks is refused by name', async () => {
  const layer = createLayer(createState().state);
  await assert.rejects(
    layer.readGeneColumn('MS4A1', { matrix: 'raw' }),
    error => error.code === 'GENE_NOT_IN_MATRIX' && error.gene === 'MS4A1' && /MS4A1 is not a gene of raw/.test(error.message)
  );
  await assert.rejects(
    layer.readGeneCellSubset(['CD3E', 'MS4A1'], [0, 1], { matrix: 'raw' }),
    error => error.code === 'GENE_NOT_IN_MATRIX' && error.gene === 'MS4A1'
  );
});

test('a cell subset of another matrix reads its genes at their positions on that matrix', async () => {
  const { state, calls } = createState();
  const layer = createLayer(state);
  await layer.readGeneCellSubset(['LYZ', 'EXTRA'], Uint32Array.of(0, 3), { matrix: 'raw' });
  assert.deepEqual(calls.subset.map(({ genes, cells }) => [genes, cells]), [[[2, 1], [0, 3]]]);
});

test('a new dataset generation opens the matrix again', async () => {
  const { state, calls } = createState();
  const layer = createLayer(state);
  await layer.getGeneKeys('raw');
  layer._datasetGeneration += 1;
  await layer.getGeneKeys('raw');
  assert.deepEqual(calls.open, ['raw', 'raw']);
});

test('Marker genes, Differential expression and Dot plot share one Expression matrix option', () => {
  const context = { expressionMatrices: createLayer(createState().state).getExpressionMatrices() };
  for (const schema of [MARKER_OPTIONS, DE_OPTIONS, dotplotOptions]) {
    const entry = schema.entry('matrix');
    assert.equal(entry.label, 'Expression matrix');
    assert.equal(entry.tip, 'analysis-expression-matrix');
    assert.equal(entry.default, 'mapped');
    assert.equal(schema.describeDefault('matrix'), 'The mapped matrix');
    assert.equal(schema.refuse('matrix', 'raw', {}, context), null);
    assert.match(schema.refuse('matrix', 'layer:bad', {}, context), /has no choice "layer:bad"/);
  }
  assert.equal(MARKER_OPTIONS.entry('matrix').group, 'test');
  assert.equal(DE_OPTIONS.entry('matrix').group, 'test');
  assert.equal(dotplotOptions.entry('matrix').group, 'values');
});
