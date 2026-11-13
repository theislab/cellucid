/**
 * `analysis.export` writes an analysis's whole result table as the file its
 * expanded view's CSV button writes (`tableFile`), through the browser's
 * download, so an agent asked to "export that table" can. Refused, saying why, with no result, with an out-of-date one, and
 * for `all` on an analysis other than marker genes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createActionCatalog } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher, ActionRefused } from '../assets/js/app/actions/dispatcher.js';
import { ACTION_DEFINITIONS } from '../assets/js/app/actions/definitions/index.js';
import { installAnalysisActions } from '../assets/js/app/analysis/actions.js';

// The download: an anchor clicked on a stand-in page; the files written are kept here.
const written = [];
globalThis.URL.createObjectURL = blob => { written.push({ blob }); return `blob:${written.length}`; };
globalThis.URL.revokeObjectURL = () => {};
globalThis.document ??= {
  createElement: () => ({ style: {}, click() { written.at(-1).name = this.download; }, remove() {} }),
  body: { appendChild() {}, append() {} },
};

function page({ result = true, stale = [], tables = {} } = {}) {
  const ui = {
    isShown: () => true,
    getLastResult: () => (result ? {} : null),
    getResultProvenance: () => null,
    isRunning: () => false,
    getStaleReasons: async () => stale,
    tableFile: async choice => tables[choice?.all ? 'all' : 'shown'] ?? null,
  };
  const comparisonModule = {
    dataLayer: { getPages: () => [], getAvailableVariables: () => [] },
    getAnalysisWindowManager: () => ({ listWindows: () => [] }),
    getPanelUI: () => ui,
    readPanelUI: (_id, read) => read(ui),
    listPanelUIs: () => [],
    getOpenMode: () => 'differential',
    openMode() {},
    closeOpenMode() {},
    locateUI: () => null,
    setChangeRecorder() {},
    setOpenDatasetDescriber() {},
  };
  const actions = createActionDispatcher({ catalog: createActionCatalog(ACTION_DEFINITIONS) });
  const remove = installAnalysisActions({ actions, comparisonModule, dockable: { place() {} }, section: null, describeOpenDataset: () => null });
  return { actions, remove };
}

const refusal = pattern => error => {
  assert.ok(error instanceof ActionRefused, String(error));
  assert.match(error.message, pattern);
  return true;
};

test('the result table is written as the expanded view\'s CSV writes it, and the agent is told its name and size', async () => {
  written.length = 0;
  const csv = 'gene,scores\nPdx1,12.5\nGcg,-10.1';
  const { actions, remove } = page({ tables: { shown: { name: 'differential_expression', csv } } });
  try {
    const done = await actions.dispatch('analysis.export', { analysis: 'differential' });
    assert.deepEqual(done.outcome, { analysis: 'differential', file: 'differential_expression.csv', bytes: csv.length });
    assert.equal(written.length, 1);
    assert.equal(written[0].name, 'differential_expression.csv');
    assert.equal(await written[0].blob.text(), csv);
  } finally {
    remove();
  }
});

test('marker genes with all write every gene of every group; all on another analysis is refused', async () => {
  written.length = 0;
  const all = new Blob(['group,names\nBeta,Ins2\nBeta,Pdx1'], { type: 'text/csv' });
  const markers = page({ tables: { shown: { name: 'marker_genes', csv: 'x' }, all: { name: 'marker_genes_all', csv: all } } });
  try {
    const done = await markers.actions.dispatch('analysis.export', { analysis: 'markers', all: true });
    assert.deepEqual(done.outcome, { analysis: 'markers', file: 'marker_genes_all.csv', bytes: all.size });
    await assert.rejects(markers.actions.dispatch('analysis.export', { analysis: 'dotplot', all: true }), refusal(/^"all" exports every gene of marker genes; Dot plot has one table\.$/));
  } finally {
    markers.remove();
  }
});

test('no result, or an out-of-date one, is refused saying why; nothing is written', async () => {
  written.length = 0;
  const none = page({ result: false });
  try {
    await assert.rejects(none.actions.dispatch('analysis.export', { analysis: 'composition' }), refusal(/^Composition has no result yet; run it first/));
  } finally {
    none.remove();
  }
  const stale = page({ stale: ['The cells changed since this result.'], tables: { shown: { name: 'dot_plot', csv: 'x' } } });
  try {
    await assert.rejects(stale.actions.dispatch('analysis.export', { analysis: 'dotplot' }), refusal(/^Dot plot's result is out of date: The cells changed since this result\. Run it again to export it\.$/));
  } finally {
    stale.remove();
  }
  assert.equal(written.length, 0);
});
