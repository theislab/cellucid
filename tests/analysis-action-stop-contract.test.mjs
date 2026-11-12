/**
 * An analysis action stopped while the work it set off runs ends promptly as
 * a cancellation, and that work stops with it (bug hunt F147).
 *
 * The dispatcher waits for a stopped action to end before it puts back what
 * the action changed (LB-1: never a half-made change), so an action that
 * waits on work not tied to its signal holds every later history move and
 * every action on its domains for as long as that work runs. The analyses'
 * changes wait for what they set off (`whenSettled`: a redraw, an update
 * after its delay, a run reading thousands of genes) so that the step holds
 * it; `analysis.run` waited for the open cells and the gene sample to settle
 * before its job existed, so a Stop then found no job to cancel and the run
 * went on to its end. Now:
 *
 * - `whenSettled({signal})` / `whenWindowSettled(id, {signal})`: stopped,
 *   the analysis's work is stopped (its request invalidated: its job
 *   cancelled, an update in its delay dropped) and the wait throws why once
 *   that work has ended, so nothing it set off lands after the rollback;
 * - `runNow({signal})`: stopped before its job exists, nothing runs;
 * - every settle wait of `analysis/actions.js` passes the action's signal
 *   (checked on the source: an action added later keeps the rule).
 *
 * No timers but the analysis's own zero-delay update: work is held open by
 * promises the test releases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { deferred, makePage } from './history-fake-page.mjs';
import { analysisActions } from '../assets/js/app/actions/definitions/analysis.js';
import { installAnalysisActions } from '../assets/js/app/analysis/actions.js';
import { BaseAnalysisUI } from '../assets/js/app/analysis/ui/base-analysis-ui.js';
import { GenesPanelUI } from '../assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js';
import { QuickInsights } from '../assets/js/app/analysis/ui/analysis-types/quick-insights-ui.js';
import { AnalysisWindowManager } from '../assets/js/app/analysis/ui/analysis-window-manager.js';
import { createRequestIdTracker } from '../assets/js/app/jobs/cancellable-job.js';
import { cancelled, isCancellation } from '../assets/js/utils/abort.js';
import { settlesSoon, staysPending } from './helpers/settles.mjs';

const AGENT = Object.freeze({ origin: 'agent', agent: 'Claude', turn: 'turn-analysis' });
const STOP = () => cancelled('user', 'The person stopped Claude.');

/** The request machinery of a real analysis (`BaseAnalysisUI`), on `proto`. */
function analysisOn(proto, extra = {}) {
  const ui = Object.create(proto);
  Object.assign(ui, {
    _isDestroyed: false,
    _notifications: { error() {} },
    _analysisRequestTracker: createRequestIdTracker(),
    _activeAnalysisRequestId: null,
    _analysisInvalidationOwner: null,
    _isLoading: false,
    _interactiveTasks: new Set(),
    ...extra,
  });
  return ui;
}

/**
 * An analysis whose options live in the fake page's `analysis` domain
 * (`page.state.c`): setting them schedules an update (its delay 0) whose run
 * holds until `finish` resolves or its request is invalidated; a run that
 * finishes while still current writes its result (`c = 1000`).
 */
function heldAnalysis(page) {
  const finish = deferred();
  const started = deferred();
  const ui = analysisOn(BaseAnalysisUI.prototype);
  const runs = [];
  ui._runAnalysisIfValid = async scheduled => {
    const requestId = ui._startAnalysisRequest(scheduled);
    if (requestId === null) return;
    const ended = new Promise(resolve => {
      ui._registerAnalysisInvalidationCleanup(requestId, () => resolve('cancelled'));
      finish.promise.then(() => resolve('finished'));
    });
    runs.push('started');
    started.resolve();
    const how = await ended;
    runs.push(how);
    if (how === 'finished' && ui._isCurrentAnalysisRequest(requestId)) page.state.c = 1000;
    ui._finishAnalysisRequest(requestId);
  };
  Object.assign(ui, {
    isShown: () => true,
    describeResult: () => null,
    getSelectedPages: () => [],
    getOptions: () => ({ minCells: page.state.c }),
    setOptions: ({ minCells }) => {
      page.state.c = minCells;
      ui._scheduleUpdate(0);
    },
  });
  return { ui, runs, finish, started: started.promise };
}

function comparisonModuleOf(panelUi, windows) {
  return {
    dataLayer: { getPages: () => [{ id: 'p1', name: 'Page 1' }], getAvailableVariables: () => [] },
    getAnalysisWindowManager: () => windows,
    getPanelUI: () => panelUi,
    listPanelUIs: () => [],
    getOpenMode: () => 'genesPanel',
    openMode() {},
    closeOpenMode() {},
    locateUI: () => null,
    setChangeRecorder() {},
    setOpenDatasetDescriber() {},
  };
}

/** A fake page whose `analysis` domain is `state.c`, with the analysis actions installed on its dispatcher. */
async function analysisPage({ panel, windows = () => ({ listWindows: () => [] }) }) {
  const made = await makePage({
    extra: analysisActions,
    provide: (dispatcher, page) => {
      installAnalysisActions({
        actions: dispatcher,
        comparisonModule: comparisonModuleOf(panel(page), windows(page)),
        dockable: { place() {} },
        section: null,
        describeOpenDataset: () => null,
      });
    },
  });
  // A step to undo after the stopped action: the history must be free again.
  const s1 = await made.step('a.set', { v: 1 });
  return { ...made, s1 };
}

test('an analysis setting stopped while the update it set off runs ends at once, put back, its update stopped', async () => {
  let held = null;
  const { page, history, dispatcher } = await analysisPage({ panel: p => { held = heldAnalysis(p); return held.ui; } });
  const steps = history.active.steps.size;
  const setting = dispatcher.dispatch('analysis.markers.set', { options: { minCells: 5 } }, AGENT);
  await held.started;
  assert.equal(page.state.c, 5, 'the options were set and their update runs');
  const reason = STOP();
  assert.equal(dispatcher.stop({ turn: AGENT.turn }, reason), 1);
  // Not released: the action ends without its update's own end.
  const outcome = await settlesSoon(setting);
  assert.ok(outcome !== null, 'the stopped action ended without waiting for its update');
  assert.equal(outcome.error, reason);
  assert.equal(page.state.c, 0, 'put back');
  assert.deepEqual(held.runs, ['started', 'cancelled'], 'its update was stopped');
  assert.equal(history.active.steps.size, steps, 'no step');
  held.finish.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.state.c, 0, 'nothing of the stopped update lands later');
  // The history is free: a move runs.
  await dispatcher.dispatch('history.undo', {});
  assert.equal(page.state.a, 0);
  await dispatcher.idle();
});

test('an analysis window opened by a stopped action: its first update stops and the window goes', async () => {
  let window = null;
  const windows = page => {
    const entries = new Map();
    const manager = {
      _windows: entries,
      listWindows: () => [...entries.keys()].map((id, index) => ({ id, number: index + 1 })),
      windowNumberOf: id => [...entries.keys()].indexOf(id) + 1,
      copyFromEmbedded: () => {
        window = heldAnalysis(page);
        entries.set('w1', { ui: window.ui });
        // The new window is part of the analyses (the domain): what the rollback puts back.
        page.state.c = 77;
        window.ui._scheduleUpdate(0);
        return 'w1';
      },
    };
    manager.whenWindowSettled = AnalysisWindowManager.prototype.whenWindowSettled.bind(manager);
    return manager;
  };
  const { page, dispatcher } = await analysisPage({ panel: p => heldAnalysis(p).ui, windows });
  const opening = dispatcher.dispatch('analysis.open', { analysis: 'markers', window: true }, AGENT);
  while (window === null) await new Promise(resolve => setImmediate(resolve));
  await window.started;
  const reason = STOP();
  assert.equal(dispatcher.stop({ turn: AGENT.turn }, reason), 1);
  const outcome = await settlesSoon(opening);
  assert.ok(outcome !== null, 'the stopped opening ended without waiting for the window\'s update');
  assert.equal(outcome.error, reason);
  assert.equal(page.state.c, 0, 'put back');
  assert.deepEqual(window.runs, ['started', 'cancelled']);
  window.finish.resolve();
  await dispatcher.dispatch('history.undo', {});
  assert.equal(page.state.a, 0, 'a history move runs after it');
});

test('a run stopped while it waits to start (the gene sample settling) never starts and ends at once', async () => {
  const hold = deferred();
  const holding = deferred();
  const started = [];
  const ui = analysisOn(GenesPanelUI.prototype, {
    _options: {},
    _lastResult: null,
    _shownJob: null,
    _requireOptions: () => ({}),
    _getRunBlocker: () => null,
    _updateRunRow: () => {},
    isShown: () => true,
    describeResult: () => null,
    getSelectedPages: () => [],
    dataLayer: { holdGeneSample: () => { holding.resolve(); return hold.promise; } },
  });
  ui._startAnalysisRequest = () => { started.push('request'); return null; };
  const { page, dispatcher } = await analysisPage({ panel: () => ui });
  const running = dispatcher.dispatch('analysis.run', { analysis: 'markers' }, AGENT);
  // The run waits for the gene sample to hold still (its job does not exist yet).
  await holding.promise;
  const reason = STOP();
  assert.equal(dispatcher.stop({ turn: AGENT.turn }, reason), 1);
  const outcome = await settlesSoon(running);
  assert.ok(outcome !== null, 'the stopped run ended without waiting for the gene sample');
  assert.equal(outcome.error, reason);
  hold.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [], 'no run started after the Stop');
  await dispatcher.dispatch('history.undo', {});
  assert.equal(page.state.a, 0, 'a history move runs after it');
});

test('Quick insights stopped while it settles: its own job is cancelled too', async () => {
  const ui = analysisOn(QuickInsights.prototype, { _currentRequestId: 0 });
  let cancelledJobs = 0;
  const jobEnded = deferred();
  ui._job = { cancel: () => { cancelledJobs++; jobEnded.resolve(); } };
  ui._trackInteractiveTask(jobEnded.promise, 'Quick insights update');
  const stop = new AbortController();
  const settling = ui.whenSettled({ signal: stop.signal });
  const reason = STOP();
  stop.abort(reason);
  const outcome = await settlesSoon(settling);
  assert.ok(outcome !== null);
  assert.equal(outcome.error, reason);
  assert.ok(isCancellation(outcome.error));
  assert.equal(cancelledJobs, 1);
  assert.equal(ui._job, null);
});

test('an unstopped settle waits for the work and resolves; a settle with nothing under way resolves at once', async () => {
  const ui = analysisOn(BaseAnalysisUI.prototype);
  const work = deferred();
  ui._trackInteractiveTask(work.promise, 'Redraw');
  const stop = new AbortController();
  const settling = ui.whenSettled({ signal: stop.signal });
  assert.equal(await staysPending(settling), true, 'it waits for the work');
  work.resolve();
  assert.deepEqual(await settlesSoon(settling), { value: undefined });
  assert.deepEqual(await settlesSoon(analysisOn(BaseAnalysisUI.prototype).whenSettled()), { value: undefined });
});

test('every settle wait of the analysis actions is given the action\'s signal', () => {
  const source = readFileSync(new URL('../assets/js/app/analysis/actions.js', import.meta.url), 'utf8');
  const waits = [...source.matchAll(/\b(whenSettled|whenWindowSettled)\(([^)]*)\)/g)];
  assert.ok(waits.length >= 7, 'the settle waits are found');
  for (const [call, , args] of waits) {
    assert.match(args, /\{ signal \}$/, `${call} passes the action's signal`);
  }
  // Each handler that waits takes its signal.
  for (const match of source.matchAll(/actions\.provide\(([^,]+), async \(([^)]*)\)([^]*?)\n {4}\}\),/g)) {
    if (/whenSettled|whenWindowSettled|runNow/.test(match[3])) assert.match(match[0], /\{ signal \}\) =>/, `${match[1]} takes its signal`);
  }
});
