/**
 * A form analysis publishes only its newest run: an older completion or
 * failure never renders, an invalidated render is never adopted, the Run
 * button follows the newest run, and a highlight change marks a shown result
 * stale rather than discarding or re-running it
 * (`ui/analysis-types/base/form-based-analysis.js`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { FormBasedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js';
import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';
import { defineOptions } from '../assets/js/app/analysis/options/option-schema.js';

globalThis.HTMLElement ??= class HTMLElement {};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const SCHEMA = defineOptions({
  id: 'manual',
  groups: [],
  options: [
    { key: 'size', kind: 'number', label: 'Size', tip: 'analysis-signature', group: 'essentials', default: 1 },
  ],
});

class ManualFormHarness extends FormBasedAnalysisUI {
  static getRequirements() {
    return { minPages: 0 };
  }

  _getTitle() {
    return 'Manual';
  }

  _getOptionsSchema() {
    return SCHEMA;
  }

  async _showResult(result) {
    this.renders.push(result.data.owner);
  }
}

function createHarness(pending) {
  const ui = new ManualFormHarness({ comparisonModule: {}, dataLayer: {} });
  ui.renders = [];
  ui._notifications = {
    loading: () => 'manual',
    complete() {},
    fail() {},
    dismiss() {},
    error() {},
  };
  const button = { disabled: false, textContent: 'Run', dataset: {}, removeAttribute() {}, setAttribute() {} };
  ui._runRow = { button, reason: { hidden: true, textContent: '' } };
  ui._runAnalysisImpl = () => pending.shift().promise;
  return { ui, button };
}

test('only the newest of two runs publishes, whichever completes first', async () => {
  const older = deferred();
  const newer = deferred();
  const { ui } = createHarness([older, newer]);
  const olderRun = ui._runAnalysis();
  const newerRun = ui._runAnalysis();
  older.resolve({ data: { owner: 'older' } });
  await olderRun;
  assert.deepEqual(ui.renders, [], 'an older completion never renders');
  assert.equal(ui.isLoading(), true, 'and does not end the newer run');
  newer.resolve({ data: { owner: 'newer' } });
  await newerRun;
  assert.deepEqual(ui.renders, ['newer']);
  assert.equal(ui.getLastResult().data.owner, 'newer');
  assert.equal(ui.isLoading(), false);
});

test('an older run\'s failure is not published', async () => {
  const older = deferred();
  const newer = deferred();
  const { ui } = createHarness([older, newer]);
  const olderRun = ui._runAnalysis();
  const olderJob = ui._shownJob;
  const newerRun = ui._runAnalysis();
  older.reject(new Error('older failure'));
  await olderRun;
  assert.notEqual(olderJob.state, 'failed', 'a superseded run is cancelled, never failed');
  newer.resolve({ data: { owner: 'newer' } });
  await newerRun;
  assert.deepEqual(ui.renders, ['newer']);
});

test('an invalidated render is never adopted as the result', async () => {
  const run = deferred();
  const renderStarted = deferred();
  const renderSettlement = deferred();
  const { ui } = createHarness([run]);
  ui._showResult = async () => {
    renderStarted.resolve();
    await renderSettlement.promise;
  };
  const running = ui._runAnalysis();
  run.resolve({ data: { owner: 'older' } });
  await renderStarted.promise;
  ui._invalidateAnalysisRequest();
  renderSettlement.resolve();
  await running;
  assert.equal(ui.getLastResult(), null);
  assert.equal(ui._currentPageData, null);
  assert.equal(ui.isLoading(), false);
});

test('invalidating a run frees Run at once and cancels its job', async () => {
  const run = deferred();
  const { ui, button } = createHarness([run]);
  const running = ui._runAnalysis();
  assert.equal(button.textContent, 'Running…');
  assert.equal(button.disabled, true);
  const job = ui._shownJob;
  ui._invalidateAnalysisRequest();
  assert.equal(button.textContent, 'Run');
  assert.equal(button.disabled, false);
  assert.equal(job.state, 'cancelled');
  assert.equal(job.signal.aborted, true);
  run.reject(new Error('stale failure'));
  await running;
  assert.equal(job.state, 'cancelled', 'a stale failure never turns a cancel into a failure');
  assert.equal(ui.getLastResult(), null);
});

test('a newer run never captures an older Running label', async () => {
  const older = deferred();
  const newer = deferred();
  const { ui, button } = createHarness([older, newer]);
  const olderRun = ui._runAnalysis();
  const newerRun = ui._runAnalysis();
  newer.resolve({ data: { owner: 'newer' } });
  await newerRun;
  assert.equal(button.textContent, 'Run');
  older.resolve({ data: { owner: 'older' } });
  await olderRun;
  assert.equal(ui.getLastResult().data.owner, 'newer');
  assert.equal(button.textContent, 'Run');
  assert.equal(button.disabled, false);
});

test('a highlight change marks a shown result stale; it neither discards nor re-runs it', async () => {
  const run = deferred();
  const { ui } = createHarness([run]);
  ui._updatePageSelectorCounts = () => {};
  run.resolve({ data: { owner: 'shown' } });
  await ui._runAnalysis();
  assert.equal(ui._isResultStale(), false);
  ui.onHighlightChanged();
  assert.equal(ui.getLastResult().data.owner, 'shown');
  assert.equal(ui._isResultStale(), true);
  assert.deepEqual(ui.renders, ['shown']);
});

test('differential expression stops before testing when its owner is stale', async () => {
  const analysis = new MultiVariableAnalysis({
    state: { pointCount: 10 },
    resolveExpressionMatrix: () => ({ matrix: 'X', read: null, label: 'Mapped (X)' }),
    async getGeneKeys() { return this.getAvailableVariables('gene_expression').map(gene => gene.key); },
    getAvailableVariables: () => [{ key: 'G' }],
  });
  analysis._getComputeManager = async () => {
    throw new Error('a stale run reached the compute threads');
  };
  const result = await analysis.differentialExpression({
    groupA: { name: 'A', cells: Uint32Array.of(0, 1, 2) },
    groupB: { name: 'B', cells: Uint32Array.of(5, 6, 7) },
    method: 'wilcox',
    isCurrent: () => false,
    registerInvalidationCleanup() {},
  });
  assert.equal(result, null);
});
