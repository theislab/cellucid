/**
 * `field.summary` `within` (live-7 L25-13): a summary of a subset of the
 * cells, with the view left as it is. Agents hid the person's cells with
 * filters to summarize donors within one cell type (an Opus turn, 6 filter
 * steps) or cell types per age range (a Haiku turn, 4), then put the view
 * back; `within` keeps the cells of some categories of another categorical
 * field, or those in a range of a continuous field or gene.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDatasetReads } from '../assets/js/app/reads/dataset.js';
import { getActionCatalog } from '../assets/js/app/actions/index.js';
import { SHAPED_INPUTS } from '../assets/js/app/agent/bridge/data-guard.js';

// Six cells: cell types A A A B B B; donors d1 d2 d1 d2 d1 d2; age 7 8 12 15 9 14; total counts 10..60.
const FIELDS = [
  { key: 'cell_type', kind: 'category', categories: ['A', 'B'], codes: Uint8Array.of(0, 0, 0, 1, 1, 1) },
  { key: 'donor', kind: 'category', categories: ['d1', 'd2'], codes: Uint8Array.of(0, 1, 0, 1, 0, 1) },
  { key: 'age', kind: 'continuous', values: Float32Array.of(7, 8, 12, 15, 9, 14) },
  { key: 'total_counts', kind: 'continuous', values: Float32Array.of(10, 20, 30, 40, 50, 60) },
];

function reads() {
  const state = {
    pointCount: 6,
    cellIdentity: {},
    categoryTransparency: new Float32Array(6).fill(1),
    getFields: () => FIELDS,
    getVarFields: () => [],
    ensureFieldLoaded: async index => FIELDS[index],
  };
  return createDatasetReads({ state, viewer: {}, dataSourceManager: null });
}

const signal = new AbortController().signal;

test('donors within one cell type, and cell types per age range, without touching the view (L25-13)', async () => {
  const { fieldSummary } = reads();
  const withinA = await fieldSummary({
    field: { source: 'obs', key: 'total_counts' }, by: { source: 'obs', key: 'donor' }, top: 50, visible_only: false,
    within: { field: { source: 'obs', key: 'cell_type' }, categories: ['A'] },
  }, { signal });
  assert.deepEqual(withinA.within, { field: 'cell_type', cells: 3 });
  assert.deepEqual(withinA.groups.map(group => [group.label, group.cells, group.mean]), [['d1', 2, 20], ['d2', 1, 20]]);
  const young = await fieldSummary({
    field: { source: 'obs', key: 'cell_type' }, by: { source: 'obs', key: 'cell_type' }, top: 50, visible_only: false,
    within: { field: { source: 'obs', key: 'age' }, min: 7, max: 9 },
  }, { signal });
  assert.deepEqual(young.within, { field: 'age', cells: 3 });
  assert.deepEqual(young.groups.map(group => [group.label, group.cells]), [['A', 2], ['B', 1]]);
  // An open end, and none: every cell, within null.
  assert.equal((await fieldSummary({ field: { source: 'obs', key: 'age' }, by: { source: 'obs', key: 'cell_type' }, top: 50, visible_only: false, within: { field: { source: 'obs', key: 'age' }, min: 12 } }, { signal })).within.cells, 3);
  assert.equal((await fieldSummary({ field: { source: 'obs', key: 'age' }, by: { source: 'obs', key: 'cell_type' }, top: 50, visible_only: false }, { signal })).within, null);
});

test('within refuses what does not fit its field, saying what to give', async () => {
  const { fieldSummary } = reads();
  const ask = within => fieldSummary({ field: { source: 'obs', key: 'age' }, by: { source: 'obs', key: 'cell_type' }, top: 50, visible_only: false, within }, { signal });
  await assert.rejects(ask({ field: { source: 'obs', key: 'cell_type' }, min: 1 }), /is categorical: name its categories in within\.categories/);
  await assert.rejects(ask({ field: { source: 'obs', key: 'age' }, categories: ['7'] }), /holds numbers: give within\.min, within\.max or both/);
  await assert.rejects(ask({ field: { source: 'obs', key: 'age' } }), /holds numbers/);
  await assert.rejects(ask({ field: { source: 'obs', key: 'age' }, min: 10, max: 8 }), /within\.min \(10\) is above within\.max \(8\)/);
  await assert.rejects(ask({ field: { source: 'obs', key: 'cell_type' }, categories: ['Z'] }), /no category/i);
});

test('the catalog offers within; a field an agent shaped by naming cells is checked as `by` is', () => {
  const definition = getActionCatalog().get('field.summary');
  assert.deepEqual(Object.keys(definition.params.properties.within.properties), ['field', 'categories', 'min', 'max']);
  assert.ok(definition.result.required.includes('within'));
  assert.deepEqual(SHAPED_INPUTS['field.summary'].fields({ by: { key: 'donor' }, within: { field: { key: 'mine' } } }), ['donor', 'mine']);
  assert.deepEqual(SHAPED_INPUTS['field.summary'].fields({ by: { key: 'donor' } }), ['donor']);
});
