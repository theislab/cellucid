/**
 * Asynchronous analysis content publishes one counted `aria-busy` signal.
 *
 * Quick Insights was the first region to say when it was still changing; the
 * expanded view, the Detailed preview and the Correlation and Gene Signature
 * runs grew after they appeared with no signal at all. The signal now
 * lives once in BaseAnalysisUI and every asynchronous region uses it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { BaseAnalysisUI } from '../assets/js/app/analysis/ui/base-analysis-ui.js';
import { FormBasedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js';
import { CorrelationAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/correlation-analysis-ui.js';
import { DetailedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/detailed-analysis-ui.js';
import { GeneSignatureUI } from '../assets/js/app/analysis/ui/analysis-types/gene-signature-ui.js';
import { QuickInsights } from '../assets/js/app/analysis/ui/analysis-types/quick-insights-ui.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function region() {
  const attributes = new Map();
  return {
    attributes,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
    get busy() {
      return attributes.get('aria-busy') ?? null;
    },
  };
}

async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve));
}

test('busy claims are counted so a late release cannot clear a newer owner', () => {
  const ui = Object.create(BaseAnalysisUI.prototype);
  const target = region();
  const first = ui._claimBusy(target);
  const second = ui._claimBusy(target);
  assert.equal(target.busy, 'true');
  first();
  first();
  assert.equal(target.busy, 'true', 'a repeated release is a no-op');
  second();
  assert.equal(target.busy, null);

  // The level-triggered form shares the same counter.
  const held = ui._claimBusy(target);
  ui._setBusy(true, target);
  ui._setBusy(true, target);
  held();
  assert.equal(target.busy, 'true');
  ui._setBusy(false, target);
  assert.equal(target.busy, null);
  assert.doesNotThrow(() => ui._claimBusy(null)());
});

test('Quick Insights uses the shared busy signal instead of its own', () => {
  assert.equal(Object.hasOwn(QuickInsights.prototype, '_setBusy'), false);
  assert.equal(QuickInsights.prototype._setBusy, BaseAnalysisUI.prototype._setBusy);
  assert.equal(Object.hasOwn(BaseAnalysisUI.prototype, '_showLoading'), false);
});

test('the expanded view body is busy for its whole render', async () => {
  const ui = Object.create(FormBasedAnalysisUI.prototype);
  const body = region();
  const draw = deferred();
  ui._drawExpandedViewContent = () => draw.promise;
  const rendering = ui._renderExpandedViewContent({ _body: body }, {});
  assert.equal(body.busy, 'true');
  draw.resolve(true);
  assert.equal(await rendering, true);
  assert.equal(body.busy, null);

  const failing = deferred();
  ui._drawExpandedViewContent = () => failing.promise;
  const failed = ui._renderExpandedViewContent({ _body: body }, {});
  assert.equal(body.busy, 'true');
  failing.reject(new Error('render failed'));
  await assert.rejects(failed, /render failed/);
  assert.equal(body.busy, null);
});

test('the Detailed preview is busy while its run fetches and renders', async () => {
  const ui = new DetailedAnalysisUI({ comparisonModule: {}, dataLayer: {} });
  const preview = region();
  ui._previewContainer = preview;
  const run = deferred();
  ui._runPreviewAnalysis = () => run.promise;
  const requestId = ui._startAnalysisRequest();
  const running = ui._runAnalysis(requestId);
  assert.equal(preview.busy, 'true');
  run.resolve();
  await running;
  assert.equal(preview.busy, null);
  ui._finishAnalysisRequest(requestId);
});

for (const [label, UIClass] of [
  ['Correlation', CorrelationAnalysisUI],
  ['Gene Signature', GeneSignatureUI],
]) {
  test(`${label} runs are busy until their result settles`, async () => {
    const ui = new UIClass({ comparisonModule: {}, dataLayer: {} });
    const container = region();
    ui._container = container;
    ui._selectedPages = ['page-1'];
    ui._options = {};
    ui._getRunBlocker = () => null;
    ui._startAnalysisJob = () => ({ cancel() {}, succeed() {}, step() {}, subscribe: () => () => {}, running: true });
    const computation = deferred();
    ui._runAnalysisImpl = () => computation.promise;
    const running = ui._runAnalysis();
    await nextTurn();
    assert.equal(container.busy, 'true');
    computation.resolve(null);
    await running;
    assert.equal(container.busy, null);
  });
}
