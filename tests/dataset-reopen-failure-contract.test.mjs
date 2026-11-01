/**
 * Apply in Cells to open that cannot read the cells asked for
 * (`DatasetControls.reopenOpenDataset`): the cells open before stay open
 * (`app/open-cells-resize.js` reads them back) and the failure is said once,
 * naming the dataset and the reason, with the raw error under Details; the
 * reading resolves `{shown: false}`, never rejects (an Apply that rejected
 * was an unhandled rejection the person never saw: Web contracts run
 * 41269083996, Linux WebKit). A cancellation is said by nobody.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { cancelled } from '../assets/js/utils/abort.js';
import { makeHarness, makeIdentity } from './helpers/dataset-controls-harness.mjs';

const moduleUrl = new URL('../assets/js/app/ui/modules/dataset-controls.js', import.meta.url);

async function openControls(t, resizeOpenCells) {
  const identity = makeIdentity('cells', 'Lung atlas', 300);
  const harness = makeHarness([{ sourceType: 'remote', datasets: [identity], error: null }]);
  t.after(harness.browser.restore);
  harness.manager.getSource = type => ({
    getType: () => type,
    getAnnDataSource: () => ({ reopenCells: async () => ({}) }),
  });
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    resizeOpenCells,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks,
  });
  assert.deepEqual(await controls.catalogReady, { status: 'ready' });
  assert.equal(await controls.loadStartupDataset({ datasetId: 'cells', loadMethod: 'dataset-dropdown', sourceType: 'remote' }), 'ready');
  t.after(() => controls.destroy());
  return { controls, harness };
}

test('a read again that fails is said once, and the cells open before stay', async t => {
  const failure = new Error('The browser could not read the file again.');
  const { controls, harness } = await openControls(t, async () => { throw failure; });
  const before = harness.statuses.length;
  assert.deepEqual(await controls.reopenOpenDataset({ mode: 'subsample', method: 'uniform', k: 120, seed: 7, strict: true }), { shown: false, inPlace: false });
  const said = harness.statuses.slice(before);
  assert.equal(said.length, 1);
  assert.equal(said[0].isError, true);
  assert.match(said[0].message, /^"Lung atlas" could not be read again with these cells.* The cells open before are still open\.$/);
  assert.ok(said[0].details !== undefined, 'the raw error is under Details');
});

test('a read again that is cancelled says nothing', async t => {
  const { controls, harness } = await openControls(t, async () => {
    throw cancelled('user', 'Reading the cells was stopped.');
  });
  const before = harness.statuses.length;
  assert.deepEqual(await controls.reopenOpenDataset({ mode: 'all' }), { shown: false, inPlace: false });
  assert.deepEqual(harness.statuses.slice(before), []);
});

test('a read again that lands in place says nothing either', async t => {
  const { controls, harness } = await openControls(t, async () => ({ inPlace: true }));
  const before = harness.statuses.length;
  assert.deepEqual(await controls.reopenOpenDataset({ mode: 'all' }), { shown: true, inPlace: true });
  assert.deepEqual(harness.statuses.slice(before), []);
});
