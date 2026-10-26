/**
 * A display option changed while a form analysis runs never supersedes the
 * run: the run completes, and its result is drawn with the latest display
 * options. A display redraw is render only (`_redrawForDisplay`), never an
 * analysis request (`ui/analysis-types/base/form-based-analysis.js`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { FormBasedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js';
import { defineOptions } from '../assets/js/app/analysis/options/option-schema.js';

// No result container is mounted: staleness has nothing to dim.
globalThis.HTMLElement ??= class HTMLElement {};

const SCHEMA = defineOptions({
  id: 'probe',
  groups: [{ id: 'display', title: 'Display' }],
  options: [
    { key: 'size', kind: 'number', label: 'Size', tip: 'analysis-signature', group: 'essentials', default: 1 },
    { key: 'scale', kind: 'number', label: 'Scale', tip: 'analysis-signature', group: 'display', default: 1 },
  ],
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

class ProbeUI extends FormBasedAnalysisUI {
  constructor() {
    super({ dataLayer: { getPages: () => [] }, comparisonModule: null });
    this.gate = deferred();
    this.shown = [];
    this.jobs = [];
  }
  _getTitle() { return 'Probe'; }
  _getOptionsSchema() { return SCHEMA; }
  _isDisplayOption(key) { return key === 'scale'; }
  _startAnalysisJob() {
    const job = {
      outcome: null,
      running: true,
      signal: new AbortController().signal,
      step() {},
      subscribe() { return () => {}; },
      succeed() { this.outcome = 'succeeded'; this.running = false; },
      cancel() { this.outcome = 'cancelled'; this.running = false; },
    };
    this.jobs.push(job);
    return job;
  }
  _failAnalysisJob(job, error) { job.outcome = `failed: ${error.message}`; }
  _claimBusy() { return () => {}; }
  async _runAnalysisImpl(options) {
    await this.gate.promise;
    return { data: { size: options.size }, scale: options.scale };
  }
  _rebuildForDisplay(options) {
    return { data: this._lastResult.data, scale: options.scale };
  }
  async _showResult(result) {
    this.shown.push(result.scale);
  }
  async _publishAnalysisResult(result) {
    this._lastResult = result;
  }
}

test('a display option changed mid-run is applied when the run publishes, and the run completes', async () => {
  const ui = new ProbeUI();
  const run = ui._runAnalysis();
  await Promise.resolve();
  // The user changes a display option while the run computes.
  ui._options = { ...ui._requireOptions(), scale: 3 };
  ui._lastResult = { data: { size: 0 }, scale: 1 };
  ui._resultInputs = { options: { size: 0, scale: 1 }, pages: [], highlightRevision: 0 };
  ui._handleOptionsChanged('scale');
  ui.gate.resolve();
  await run;
  assert.equal(ui.jobs.length, 1);
  assert.equal(ui.jobs[0].outcome, 'succeeded', 'the run is not superseded');
  assert.deepEqual(ui.shown, [1, 3], 'the run draws its result, then the latest display options');
  assert.equal(ui._lastResult.scale, 3);
  assert.equal(ui._resultInputs.options.scale, 3);
});

test('a display redraw after a run starts no analysis request', async () => {
  const ui = new ProbeUI();
  ui.gate.resolve();
  await ui._runAnalysis();
  const intent = ui._activeAnalysisRequestId;
  ui._options = { ...ui._options, scale: 5 };
  ui._handleOptionsChanged('scale');
  await Promise.all([...ui._interactiveTasks]);
  assert.equal(ui._activeAnalysisRequestId, intent);
  assert.deepEqual(ui.shown, [1, 5]);
  assert.equal(ui.jobs.length, 1, 'no second job');
});
