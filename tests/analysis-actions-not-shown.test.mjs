/**
 * An analysis action that draws (a run, a view, its pages, Quick's and
 * Detailed's choices, a display option of a shown result) on an analysis
 * that is not shown is refused at once with what to open: a plot waits for
 * a laid-out place to draw in (`shared/plot-render-slot.js`), so on a closed
 * section, a closed sidebar or a folded window it would wait for ever. Nothing
 * is changed before the refusal; options alone (no result to redraw) are set.
 * The panel shows one analysis at a time: such an action on an analysis of the
 * panel while it shows another shows it first, as a person opens it to use it
 * (`showToDraw` in `analysis/actions.js`), and puts the shown one back when it
 * is refused after all.
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

/**
 * The panel shows one analysis at a time. An agent that set up Differential
 * expression and then Composition with `show` (which replaced it) is not
 * refused "not shown" on running Differential expression: Run in the panel
 * shows the analysis it runs when another is shown, and puts the shown one
 * back when it still cannot draw, so a refusal changes nothing.
 */
function panelOfTwo({ drawable }) {
  let open = 'composition';
  const calls = [];
  const uiOf = modeId => {
    let options = { minCells: 3 };
    return {
      isShown: () => drawable && open === modeId,
      runNow: async () => { calls.push(['runNow', modeId]); return true; },
      describeResult: () => ({ columns: [], rows: [], total: 1 }),
      getOptions: () => options,
      setOptions: given => {
        if (given.minCells === 7) throw new RangeError('Min cells per group cannot be 7 here');
        calls.push(['setOptions', modeId, given]);
        options = { ...options, ...given };
      },
      onPageSelectionChange: ids => calls.push(['pages', modeId, ids]),
      whenSettled: async () => {},
      getSelectedPages: () => [],
    };
  };
  const uis = new Map([['differential', uiOf('differential')], ['composition', uiOf('composition')]]);
  const comparisonModule = {
    dataLayer: { getPages: () => [{ id: 'p1', name: 'Page 1' }], getAvailableVariables: () => [] },
    getAnalysisWindowManager: () => ({ listWindows: () => [] }),
    getPanelUI: modeId => uis.get(modeId),
    listPanelUIs: () => [],
    getOpenMode: () => open,
    openMode(modeId) { calls.push(['open', modeId]); open = modeId; },
    closeOpenMode() { open = null; },
    locateUI: () => null,
    setChangeRecorder() {},
    setOpenDatasetDescriber() {},
  };
  const actions = createActionDispatcher({ catalog: createActionCatalog(ACTION_DEFINITIONS) });
  const remove = installAnalysisActions({ actions, comparisonModule, dockable: { place() {} }, section: null, describeOpenDataset: () => null });
  return { actions, calls, remove, open: () => open };
}

test('run in the panel shows the analysis it runs when the panel shows another', async () => {
  const panel = panelOfTwo({ drawable: true });
  try {
    await panel.actions.dispatch('analysis.run', { analysis: 'differential' }, { origin: 'agent', agent: 'Claude' });
    assert.deepEqual(panel.calls, [['open', 'differential'], ['runNow', 'differential']]);
    assert.equal(panel.open(), 'differential');
  } finally {
    panel.remove();
  }
});

test('run where nothing can draw (the section or the sidebar closed) is refused and leaves the panel showing what it showed', async () => {
  const panel = panelOfTwo({ drawable: false });
  try {
    await assert.rejects(panel.actions.dispatch('analysis.run', { analysis: 'differential' }, { origin: 'agent', agent: 'Claude' }), error => {
      assert.ok(error instanceof ActionRefused);
      assert.equal(error.code, 'not-shown');
      return true;
    });
    assert.equal(panel.open(), 'composition');
    assert.ok(!panel.calls.some(([kind]) => kind === 'runNow'));
  } finally {
    panel.remove();
  }
});

/**
 * The same for options: an agent that has run Differential expression and
 * then Marker genes is not refused "not shown" on setting Differential
 * expression's groups, with `show: true` and without. Changing the options of an analysis with a result shows it, as a person
 * opens it to change them; refused (nothing can draw, or the options are
 * refused) it leaves the panel showing what it showed.
 */
test('options of an analysis with a result, set while the panel shows another, show it and are set', async () => {
  for (const show of [undefined, true]) {
    const panel = panelOfTwo({ drawable: true });
    try {
      const { outcome } = await panel.actions.dispatch('analysis.differential.set', { options: { minCells: 5 }, ...(show ? { show } : {}) }, { origin: 'agent', agent: 'Claude' });
      assert.deepEqual(panel.calls, [['open', 'differential'], ['setOptions', 'differential', { minCells: 5 }]], `show ${show}`);
      assert.equal(panel.open(), 'differential');
      assert.deepEqual(outcome, { changed: 'minCells', opened: true });
    } finally {
      panel.remove();
    }
  }
});

test('options refused, or set where nothing can draw, leave the panel showing what it showed', async () => {
  const undrawable = panelOfTwo({ drawable: false });
  try {
    await assert.rejects(undrawable.actions.dispatch('analysis.differential.set', { options: { minCells: 5 } }, { origin: 'agent', agent: 'Claude' }), error => error.code === 'not-shown');
    assert.equal(undrawable.open(), 'composition');
    assert.ok(!undrawable.calls.some(([kind]) => kind === 'setOptions'));
  } finally {
    undrawable.remove();
  }
  const refused = panelOfTwo({ drawable: true });
  try {
    await assert.rejects(refused.actions.dispatch('analysis.differential.set', { options: { minCells: 7 } }, { origin: 'agent', agent: 'Claude' }), error => error instanceof ActionRefused);
    assert.equal(refused.open(), 'composition');
  } finally {
    refused.remove();
  }
});

test('choosing the pages of an analysis the panel does not show shows it; where nothing can draw it is refused, the panel unchanged', async () => {
  const panel = panelOfTwo({ drawable: true });
  try {
    await panel.actions.dispatch('analysis.pages.set', { analysis: 'differential', pages: ['Page 1'] }, { origin: 'agent', agent: 'Claude' });
    assert.deepEqual(panel.calls, [['open', 'differential'], ['pages', 'differential', ['p1']]]);
  } finally {
    panel.remove();
  }
  const undrawable = panelOfTwo({ drawable: false });
  try {
    await assert.rejects(undrawable.actions.dispatch('analysis.pages.set', { analysis: 'differential', pages: ['Page 1'] }, { origin: 'agent', agent: 'Claude' }), error => error.code === 'not-shown');
    assert.equal(undrawable.open(), 'composition');
    assert.ok(!undrawable.calls.some(([kind]) => kind === 'pages'));
  } finally {
    undrawable.remove();
  }
});
