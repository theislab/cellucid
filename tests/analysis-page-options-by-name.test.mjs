/**
 * An analysis option whose choices are the highlight pages (Differential
 * expression's Group A and Group B) is named by the page's name in the
 * actions, as every action names pages: an agent that reads `pageA:
 * "restof__page_1"` is not refused "Group A has no choice "PreEndo Arx+"" for
 * the page's name and left to guess "page_2". The record keeps the id; the
 * set, the get and a person's recorded change speak names.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createActionCatalog } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher, ActionRefused } from '../assets/js/app/actions/dispatcher.js';
import { ACTION_DEFINITIONS } from '../assets/js/app/actions/definitions/index.js';
import { installAnalysisActions } from '../assets/js/app/analysis/actions.js';
import { DE_OPTIONS } from '../assets/js/app/analysis/options/de-options.js';
import { optionParamSchema } from '../assets/js/app/actions/definitions/analysis.js';

const PAGES = [{ id: 'page_1', name: 'Page 1' }, { id: 'page_2', name: 'PreEndo Arx+' }, { id: 'page_3', name: 'PreEndo Arx-' }];

function panel() {
  let options = { compare: 'pages', pageA: 'restof__page_1', pageB: 'restof__page_1', field: 'clusters' };
  const given = [];
  const ui = {
    isShown: () => true,
    describeResult: () => null,
    getOptions: () => ({ ...options }),
    setOptions: next => { given.push(next); options = { ...options, ...next }; },
    whenSettled: async () => {},
    getSelectedPages: () => [],
    getLastResult: () => null,
    getResultProvenance: () => null,
    isRunning: () => false,
    getStaleReasons: async () => [],
  };
  let recorder = null;
  const comparisonModule = {
    dataLayer: { getPages: () => PAGES, getAvailableVariables: () => [] },
    getAnalysisWindowManager: () => ({ listWindows: () => [] }),
    getPanelUI: () => ui,
    readPanelUI: (_id, read) => read(ui),
    listPanelUIs: () => [],
    getOpenMode: () => 'differential',
    openMode() {},
    closeOpenMode() {},
    locateUI: () => ({ modeId: 'differential', where: 'panel' }),
    setChangeRecorder(fn) { recorder = fn; },
    setOpenDatasetDescriber() {},
  };
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog(ACTION_DEFINITIONS) });
  const observed = [];
  // The person's changes the analyses report, as recorded.
  const actions = Object.create(dispatcher, {
    recordObserved: { value: async (type, params) => { observed.push({ type, params }); return null; } },
  });
  const remove = installAnalysisActions({ actions, comparisonModule, dockable: { place() {} }, section: null, describeOpenDataset: () => null });
  return { actions, given, remove, observed, personChange: detail => recorder(ui, 'set', detail) };
}

test('Group A and Group B are given by page name, kept as the page\'s id, and read back by name', async () => {
  const { actions, given, remove } = panel();
  try {
    const read = await actions.dispatch('analysis.differential.get', {});
    assert.equal(read.outcome.options.pageA, 'Rest of Page 1');
    await actions.dispatch('analysis.differential.set', { options: { pageA: 'PreEndo Arx+', pageB: 'preendo arx-' } }, { origin: 'agent', agent: 'Claude' });
    assert.deepEqual(given.at(-1), { pageA: 'page_2', pageB: 'page_3' });
    const after = await actions.dispatch('analysis.differential.get', {});
    assert.deepEqual([after.outcome.options.pageA, after.outcome.options.pageB], ['PreEndo Arx+', 'PreEndo Arx-']);
    await assert.rejects(actions.dispatch('analysis.differential.set', { options: { pageA: 'page_2' } }), error => {
      assert.ok(error instanceof ActionRefused);
      assert.match(error.message, /^There is no page "page_2"; the pages are "Page 1", "Rest of Page 1", "PreEndo Arx\+"/);
      return true;
    });
  } finally {
    remove();
  }
});

test('a person\'s choice of Group A is recorded by the page\'s name', () => {
  const { observed, remove, personChange } = panel();
  try {
    personChange({ options: { pageA: 'page_3' } });
    assert.deepEqual(observed.at(-1), { type: 'analysis.differential.set', params: { in: 'panel', options: { pageA: 'PreEndo Arx-' } } });
  } finally {
    remove();
  }
});

test('the tool says a page option takes a page by its name', () => {
  const entry = DE_OPTIONS.entries.find(each => each.key === 'pageA');
  assert.equal(entry.pages, true);
  assert.deepEqual(optionParamSchema(entry), { type: 'string', description: 'Group A: a highlight page by its name, or "Rest of <page>"' });
});
