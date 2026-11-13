/**
 * An analysis result records the expression values its genes were read
 * in as the analysis declares them (`form-based-analysis.js` `_valuesRead`),
 * not the app-wide setting:
 *
 * - a cell-level differential expression reads the matrix in the values it
 *   is shown in: its provenance records them, and it goes stale when the
 *   person changes Expression values;
 * - a pseudobulk one sums raw counts whatever the setting: it records the
 *   values as stored, its header says so, and the setting changing leaves
 *   it current;
 * - an analysis that reads no gene values (Composition) records none and is
 *   never stale on the setting;
 * - the values line under each form says the same declaration.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/de-analysis-ui.js';
import { CompositionUI } from '../assets/js/app/analysis/ui/analysis-types/composition-ui.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { describeProvenance, requireProvenance, staleReasons } from '../assets/js/app/analysis/shared/result-provenance.js';
import { RAW_VALUES } from '../assets/js/data/expression-transform.js';

globalThis.HTMLElement ??= class HTMLElement {};

const NORMALIZED_LOG1P = Object.freeze({ normalize: true, log1p: true });

const DE_OPTIONS = Object.freeze({
  compare: 'categories', field: 'cluster', pageA: '', pageB: '',
  categoriesA: { mode: 'some', ids: ['a'] }, categoriesB: { mode: 'some', ids: ['b'] },
  within: 'all', withinField: '', withinCategories: { mode: 'all', ids: [] },
  matrix: 'mapped', replicates: '', paired: false,
});

/** A UI of `Class` over a data layer whose Expression values are `page.setting` (a counts matrix: it takes them). */
function analysisOn(Class, page) {
  const ui = Object.create(Class.prototype);
  const state = { cellIdentity: createCellIdentity({ nObs: 10, kept: null }), getDataMapping: () => ({ expression: 'X' }) };
  Object.assign(ui, {
    dataLayer: { state, expressionTransformOf: () => page.setting },
    _selectedPages: new Set(),
    _isDisplayOption: () => false,
    _scopesByVisibleCells: () => false,
  });
  return ui;
}

test('cell-level DE records the values it read and goes stale when they change; pseudobulk records raw counts and stays current', async () => {
  const page = { setting: RAW_VALUES };
  const ui = analysisOn(DEAnalysisUI, page);
  const cells = { ...DE_OPTIONS };
  const pseudobulk = { ...DE_OPTIONS, replicates: 'donor' };
  const recordedCells = await ui._currentProvenance(cells, [], null);
  const recordedPseudobulk = await ui._currentProvenance(pseudobulk, [], null);
  requireProvenance(structuredClone(recordedCells));
  requireProvenance(structuredClone(recordedPseudobulk));
  assert.equal(recordedCells.values, 'raw');
  assert.equal(recordedPseudobulk.values, 'raw');

  // The person turns Normalize and log1p on.
  page.setting = NORMALIZED_LOG1P;
  assert.deepEqual(staleReasons(recordedCells, await ui._currentProvenance(cells, [], null)), [
    'The expression values changed since this result (raw values then, normalized · log1p now).',
  ]);
  assert.deepEqual(staleReasons(recordedPseudobulk, await ui._currentProvenance(pseudobulk, [], null)), [], 'pseudobulk sums raw counts whatever the setting');

  // A result computed now: its header says what it was computed on.
  const nowCells = await ui._currentProvenance(cells, [], null);
  const nowPseudobulk = await ui._currentProvenance(pseudobulk, [], null);
  assert.equal(describeProvenance(nowCells).values, 'normalized · log1p');
  assert.equal(describeProvenance(nowPseudobulk).values, 'raw values');

  // The values line says the same declaration.
  assert.match(ui._valuesNote(cells), /^Values: Normalized · log1p \(/);
  assert.match(ui._valuesNote(pseudobulk), /^Values: raw counts summed per sample/);
});

test('an analysis that reads no gene values records none and is never stale on Expression values', async () => {
  const page = { setting: RAW_VALUES };
  const ui = analysisOn(CompositionUI, page);
  const options = { cellTypes: 'cluster', samples: 'donor', condition: '', cells: 'all' };
  const recorded = await ui._currentProvenance(options, [], null);
  requireProvenance(structuredClone(recorded));
  assert.equal(recorded.values, null);
  assert.equal(describeProvenance(recorded).values, null);
  page.setting = NORMALIZED_LOG1P;
  assert.deepEqual(staleReasons(recorded, await ui._currentProvenance(options, [], null)), []);
  assert.equal(ui._valuesRead(options), null);
});
