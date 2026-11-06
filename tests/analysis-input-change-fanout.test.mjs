/**
 * What an analysis reads changes outside it in two ways: highlights (its
 * pages) and filters (its "Visible cells"). Every built analysis hears both:
 * - the shown mode at once; a mode not shown records the change and catches
 *   up when shown. Only the active mode heard highlight changes, so a result
 *   kept in another mode was never marked stale, and its groups were cached
 *   against the old highlights;
 * - a filter change marks stale, and reads the groups again for, an analysis
 *   scoped to "Visible cells" only. Nothing heard filter changes before.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisUIManager } from '../assets/js/app/analysis/ui/analysis-ui-manager.js';
import { DEAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/de-analysis-ui.js';

function managerWith(uis, active) {
  const manager = Object.create(AnalysisUIManager.prototype);
  manager._uis = new Map(Object.entries(uis).map(([id, ui]) => [id, { ui, initialized: true }]));
  manager._activeMode = active;
  return manager;
}

function recorder() {
  const calls = [];
  return {
    calls,
    onHighlightChanged: () => calls.push('highlight'),
    onCellVisibilityChanged: () => calls.push('cell-visibility'),
    noteHiddenChange: kind => calls.push(`hidden:${kind}`),
  };
}

test('the shown mode is brought up to date; every other built mode records the change', () => {
  const shown = recorder();
  const hidden = recorder();
  const manager = managerWith({ de: shown, markers: hidden, unbuilt: null }, 'de');
  manager.onHighlightChanged();
  manager.onCellVisibilityChanged();
  assert.deepEqual(shown.calls, ['highlight', 'cell-visibility']);
  assert.deepEqual(hidden.calls, ['hidden:highlight', 'hidden:cell-visibility']);
});

async function deUi(options) {
  const ui = Object.create(DEAnalysisUI.prototype);
  let refreshes = 0;
  // One highlight page, the result's: a change of its cells is a change of input.
  const page = { id: 'page_1', name: 'Page 1', highlightedGroups: [{ id: 'g1', enabled: true, cellIndices: Uint32Array.of(0, 1) }] };
  const state = {
    categoryTransparency: Uint8Array.from([1, 1, 0, 1, 1, 1, 0, 1, 1]),
    _transparencyEpoch: 1,
    getHighlightPages: () => [page],
    getHighlightedCellCountForPage: () => page.highlightedGroups[0].cellIndices.length,
  };
  Object.assign(ui, {
    dataLayer: { state },
    _options: options,
    _lastResult: {},
    _selectedPages: new Set(['page_1']),
    _highlightRevision: 0,
    _seenVisibleRevision: null,
    _missedInputChange: false,
    _publishedStale: false,
    _cellsSeen: null,
    _refreshOptionsContext: () => { refreshes += 1; },
    _updateStale: () => {},
    _updatePageSelectorCounts: () => {},
  });
  ui._resultInputs = { options, provenance: await ui._currentProvenance(options, ['page_1'], null) };
  ui._seenVisibleRevision = ui._visibleCellsRevision();
  return { ui, state, page, refreshes: () => refreshes };
}

const DE_OPTIONS = Object.freeze({
  compare: 'categories', field: 'cluster', pageA: '', pageB: '',
  categoriesA: { mode: 'some', ids: ['a'] }, categoriesB: { mode: 'some', ids: ['b'] },
  within: 'all', withinField: '', withinCategories: { mode: 'all', ids: [] },
});

/** A visibility pass: the transparency written again, `changed` cells flipped. */
function visibilityPass(state, changed = []) {
  state.categoryTransparency = Uint8Array.from(state.categoryTransparency);
  for (const cell of changed) state.categoryTransparency[cell] ^= 1;
  state._transparencyEpoch += 1;
}

/** Whether the shown result is stale. */
async function isStale(ui) {
  return (await ui.getStaleReasons()).length > 0;
}

test('only a change of the visible cells makes stale a result scoped to them', async () => {
  const visible = await deUi({ ...DE_OPTIONS, within: 'visible' });
  // A recolour runs a visibility pass that shows the same cells.
  visibilityPass(visible.state);
  visible.ui.onCellVisibilityChanged();
  assert.equal(await isStale(visible.ui), false);
  assert.equal(visible.refreshes(), 0, 'the groups are not read again');
  // A filter hides a cell.
  visibilityPass(visible.state, [4]);
  visible.ui.onCellVisibilityChanged();
  assert.equal(await isStale(visible.ui), true);
  assert.equal(visible.refreshes(), 1, 'the groups are read again');

  const all = await deUi({ ...DE_OPTIONS });
  visibilityPass(all.state, [4]);
  all.ui.onCellVisibilityChanged();
  assert.equal(await isStale(all.ui), false);
  assert.equal(all.refreshes(), 0);
});

test('a mode not shown catches up when shown, and its result is stale meanwhile', async () => {
  const { ui, page, refreshes } = await deUi({ ...DE_OPTIONS });
  // A highlight change that leaves the result's page as it was is no change of its input.
  ui.noteHiddenChange('highlight');
  assert.equal(await isStale(ui), false);
  // Its page's cells change.
  page.highlightedGroups = [{ id: 'g1', enabled: true, cellIndices: Uint32Array.of(0, 1, 2) }];
  ui.noteHiddenChange('highlight');
  assert.deepEqual(await ui.getStaleReasons(), ['The cells of Page 1 changed since this result.']);
  assert.equal(refreshes(), 0, 'nothing is redrawn while hidden');
  ui.onShown();
  ui.onShown();
  assert.equal(refreshes(), 1);
});
