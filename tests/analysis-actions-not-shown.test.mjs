/**
 * An analysis action that draws (a run, a view, its pages, Quick's and
 * Detailed's choices, a display option of a shown result) on an analysis
 * that is not shown is refused at once with what to open: a plot waits for
 * a laid-out place to draw in (`shared/plot-render-slot.js`), so on a closed
 * section, a closed sidebar or a folded window it would wait for ever. Nothing
 * is changed before the refusal; options alone (no result to redraw) are set.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createActionCatalog } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher, ActionRefused } from '../assets/js/app/actions/dispatcher.js';
import { ACTION_DEFINITIONS } from '../assets/js/app/actions/definitions/index.js';
import { installAnalysisActions } from '../assets/js/app/analysis/actions.js';

function page({ shown, result }) {
  const calls = [];
  const ui = {
    isShown: () => shown,
    runNow: async () => { calls.push('runNow'); return true; },
    describeResult: () => (result ? { columns: [], rows: [], total: 1 } : null),
    prepareView: view => () => { calls.push(['setView', view]); return true; },
    onPageSelectionChange: ids => calls.push(['pages', ids]),
    getOptions: () => ({ minCells: 3 }),
    setOptions: options => calls.push(['setOptions', options]),
    whenSettled: async () => {},
    getSelectedPages: () => [],
  };
  const comparisonModule = {
    dataLayer: { getPages: () => [{ id: 'p1', name: 'Page 1' }], getAvailableVariables: () => [] },
    getAnalysisWindowManager: () => ({ listWindows: () => [] }),
    getPanelUI: () => ui,
    listPanelUIs: () => [],
    getOpenMode: () => 'genesPanel',
    openMode() {},
    closeOpenMode() {},
    locateUI: () => null,
    setChangeRecorder() {},
    setOpenDatasetDescriber() {},
  };
  const actions = createActionDispatcher({ catalog: createActionCatalog(ACTION_DEFINITIONS) });
  const remove = installAnalysisActions({ actions, comparisonModule, dockable: { place() {} }, section: null, describeOpenDataset: () => null });
  return { actions, calls, remove };
}

test('a drawing analysis action on an analysis that is not shown is refused at once, saying what to open', async () => {
  const { actions, calls, remove } = page({ shown: false, result: true });
  try {
    for (const [type, params] of [
      ['analysis.run', { analysis: 'markers' }],
      ['analysis.view.set', { analysis: 'markers', view: { more: true } }],
      ['analysis.pages.set', { analysis: 'markers', pages: ['Page 1'] }],
      ['analysis.markers.set', { options: { minCells: 5 } }],
    ]) {
      await assert.rejects(actions.dispatch(type, params, { origin: 'agent', agent: 'Claude' }), error => {
        assert.ok(error instanceof ActionRefused, type);
        assert.equal(error.code, 'not-shown', type);
        assert.match(error.message, /^Marker genes is not shown, so it cannot draw: open it first \(analysis\.open/);
        return true;
      });
    }
    assert.deepEqual(calls, [], 'nothing was changed or run before the refusal');
  } finally {
    remove();
  }
});

test('options alone draw nothing, so they are set on an analysis that is not shown; a shown one runs', async () => {
  const hidden = page({ shown: false, result: false });
  try {
    await hidden.actions.dispatch('analysis.markers.set', { options: { minCells: 5 } });
    assert.deepEqual(hidden.calls, [['setOptions', { minCells: 5 }]]);
  } finally {
    hidden.remove();
  }
  const shown = page({ shown: true, result: true });
  try {
    await shown.actions.dispatch('analysis.run', { analysis: 'markers' });
    assert.deepEqual(shown.calls, ['runNow']);
  } finally {
    shown.remove();
  }
});
