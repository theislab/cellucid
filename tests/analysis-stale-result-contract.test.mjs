/**
 * A stale analysis result is never passed on as current
 * (`analysis-types/base/form-based-analysis.js`):
 *
 * - another set of open cells (Apply in place, a progressive opening's step,
 *   each replacing `state.cellIdentity`) makes the shown result stale, and
 *   its chip says the open cells changed, with both counts;
 * - what an analysis keeps of the data (Differential expression's field
 *   codes and groups, Marker genes' groups, Composition's and Dot plot's
 *   category counts) is read again on the new cells, and a description
 *   still being read for the earlier cells is dropped when it arrives;
 * - a stale result is not saved in a session (`exportResult` gives null),
 *   not exported (CSV, PNG, SVG, GMT refuse with a warning saying why) and
 *   not published to the derived results a notebook reads (withdrawn while
 *   stale, published again once current, also when the analysis is hidden).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/de-analysis-ui.js';
import { GenesPanelUI } from '../assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js';
import { CompositionUI } from '../assets/js/app/analysis/ui/analysis-types/composition-ui.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';

// No DOM here: the result container is absent, so nothing is drawn.
globalThis.HTMLElement ??= class HTMLElement {};

const OPTIONS = Object.freeze({
  compare: 'categories', field: 'cluster', pageA: '', pageB: '',
  categoriesA: { mode: 'some', ids: ['a'] }, categoriesB: { mode: 'some', ids: ['b'] },
  within: 'all', withinField: '', withinCategories: { mode: 'all', ids: [] },
});

/** A UI of `Class` showing a result computed on the cells open now. */
function shownResult(Class) {
  const ui = Object.create(Class.prototype);
  const published = [];
  const warnings = [];
  const state = {
    categoryTransparency: new Uint8Array(4).fill(1),
    _transparencyEpoch: 1,
    cellIdentity: createCellIdentity({ nObs: 10, kept: Uint32Array.of(1, 3, 5, 7) }),
  };
  const result = { full: { results: [], summary: {}, metadata: {} }, data: {} };
  Object.assign(ui, {
    dataLayer: { state },
    _options: OPTIONS,
    _lastResult: result,
    _selectedPages: new Set(),
    _highlightRevision: 0,
    _seenVisibleDigest: null,
    _visibleDigestCache: null,
    _missedInputChange: false,
    _publishedStale: false,
    _cellsSeen: state.cellIdentity,
    _fieldGroups: new Map(),
    _fieldGroupFailures: new Map(),
    _pendingFields: new Set(),
    _resolvedGroups: null,
    _replicateBlocker: null,
    _resultContainer: null,
    _notifications: { warning: (text, options) => warnings.push({ text, options }) },
    _refreshOptionsContext: () => {},
    _updatePageSelectorCounts: () => {},
    _publishDerivedResults: value => published.push(value),
    _exportResult: () => ({ kind: 'test', version: 2, payload: {} }),
    _exportModalCSV: () => { throw new Error('a stale result reached the CSV writer'); },
  });
  ui._resultInputs = { options: OPTIONS, pages: [], highlightRevision: 0, visibleDigest: ui._visibleCellsDigest(), cells: state.cellIdentity };
  return { ui, state, published, warnings, result };
}

/** Apply in place: the open cells are replaced, and every analysis hears a highlight change. */
function resize(state, kept, ui, { hidden = false } = {}) {
  state.cellIdentity = createCellIdentity({ nObs: 10, kept: Uint32Array.from(kept) });
  if (hidden) ui.noteHiddenChange('highlight');
  else ui.onHighlightChanged();
}

test('another set of open cells makes the result stale, and says so with both counts', () => {
  const { ui, state } = shownResult(DEAnalysisUI);
  assert.equal(ui._isResultStale(), false);
  assert.notEqual(ui.exportResult(), null, 'a current result is saved');
  resize(state, [1, 3], ui);
  assert.equal(ui._isResultStale(), true);
  assert.equal(ui._resultCellsChanged(), true);
  assert.equal(ui._staleReason(), 'The open cells changed since this result (4 cells then, 2 cells now).');
  // The same count, other cells (another seed): still stale.
  const other = shownResult(DEAnalysisUI);
  other.state.cellIdentity = createCellIdentity({ nObs: 10, kept: Uint32Array.of(0, 2, 4, 6) });
  assert.equal(other.ui._isResultStale(), true);
  assert.equal(other.ui._staleReason(), 'The open cells changed since this result.');
});

test('a stale result is not saved, exported or published', async () => {
  const { ui, state, published, warnings, result } = shownResult(DEAnalysisUI);
  resize(state, [1, 3, 5, 7, 9], ui);
  assert.equal(ui.exportResult(), null, 'not saved in a session');
  assert.deepEqual(published, [null], 'withdrawn from the derived results');
  for (const format of ['CSV', 'PNG', 'SVG']) assert.equal(ui._refuseStaleExport(format), true, format);
  assert.equal(await ui._exportModalPNG(), undefined);
  assert.equal(await ui._exportModalSVG(), undefined);
  assert.deepEqual(warnings.map(w => w.text), [
    'CSV not exported. The open cells changed since this result (4 cells then, 5 cells now). Run it again to export it.',
    'PNG not exported. The open cells changed since this result (4 cells then, 5 cells now). Run it again to export it.',
    'SVG not exported. The open cells changed since this result (4 cells then, 5 cells now). Run it again to export it.',
    'PNG not exported. The open cells changed since this result (4 cells then, 5 cells now). Run it again to export it.',
    'SVG not exported. The open cells changed since this result (4 cells then, 5 cells now). Run it again to export it.',
  ]);
  // Withdrawn once, not again on every check.
  ui.onHighlightChanged();
  assert.deepEqual(published, [null]);
  // A run on the cells open now publishes and saves again.
  ui._resultInputs = { ...ui._resultInputs, highlightRevision: ui._highlightRevision, cells: state.cellIdentity };
  await ui._publishAnalysisResult.call({ ...ui, _publishDerivedResultsSafely: value => published.push(value) }, result);
  assert.equal(published.at(-1), result);
});

test('a hidden analysis withdraws a result made stale at once', () => {
  const { ui, state, published } = shownResult(GenesPanelUI);
  resize(state, [1, 3], ui, { hidden: true });
  assert.deepEqual(published, [null]);
  assert.equal(ui.exportResult(), null);
});

test('a result stale by its settings is withdrawn, and published again when they are set back', () => {
  const { ui, published, result } = shownResult(DEAnalysisUI);
  ui._options = { ...OPTIONS, field: 'other' };
  ui._updateStale();
  assert.deepEqual(published, [null]);
  ui._options = OPTIONS;
  ui._updateStale();
  assert.deepEqual(published, [null, result]);
  assert.notEqual(ui.exportResult(), null);
});

test('the exports outside the expanded view refuse a stale result too', async () => {
  const markers = shownResult(GenesPanelUI);
  resize(markers.state, [1], markers.ui, { hidden: true });
  markers.ui._lastResult = { stats: { genes: [] } };
  markers.ui.getMarkerGeneSets = () => { throw new Error('a stale result reached the GMT writer'); };
  markers.ui._exportGMT();
  await markers.ui._exportAllGenesCSV();
  assert.deepEqual(markers.warnings.map(w => w.text.split('.')[0]), ['GMT not exported', 'CSV not exported']);
  const composition = shownResult(CompositionUI);
  resize(composition.state, [1], composition.ui, { hidden: true });
  composition.ui._lastResult = { composition: { get types() { throw new Error('a stale result reached the counts writer'); } } };
  composition.ui._downloadCounts();
  assert.equal(composition.warnings.length, 1);
});

test('another set of open cells drops what the analyses kept of the earlier cells', async () => {
  const de = shownResult(DEAnalysisUI);
  let reads = 0;
  const gates = [];
  de.ui._helper = { describeGroups: () => { reads++; return new Promise(resolve => gates.push(resolve)); } };
  de.ui._fieldGroups.set('cluster', { codes: new Uint8Array(4), categories: ['a', 'b'], groups: [] });
  de.ui._resolvedGroups = { key: 'k', resolved: {} };
  resize(de.state, [1, 3, 5, 7, 9], de.ui, { hidden: true });
  de.ui.onShown();
  assert.equal(de.ui._fieldGroups.size, 0, 'the earlier cells\' codes are gone');
  assert.equal(de.ui._resolvedGroups, null);
  // Asked again: read on the cells open now. A read that started for the
  // earlier cells and ends after the change is dropped.
  assert.deepEqual(de.ui._groupsOfField('cluster'), []);
  assert.equal(reads, 1);
  resize(de.state, [1, 3], de.ui, { hidden: true });
  de.ui.onShown();
  gates[0]({ codes: new Uint8Array(5), groups: [{ optionId: 'a' }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(de.ui._fieldGroups.has('cluster'), false, 'described for cells no longer open');
  de.ui._groupsOfField('cluster');
  assert.equal(reads, 2);

  const markers = shownResult(GenesPanelUI);
  markers.ui._groupState = { key: 'cluster|all|', described: { codes: new Uint8Array(4), groups: [] }, pending: null };
  resize(markers.state, [1, 3, 5], markers.ui, { hidden: true });
  markers.ui.onShown();
  assert.deepEqual(markers.ui._groupState, { key: null, described: null, pending: null });

  const composition = shownResult(CompositionUI);
  let resets = 0;
  composition.ui._fieldGroups = { reset: () => { resets++; } };
  resize(composition.state, [1], composition.ui, { hidden: true });
  composition.ui.onShown();
  composition.ui.onShown();
  assert.equal(resets, 1, 'once for each new set of open cells');
});
