/**
 * A reason Run cannot start may be a read still under way ("Reading the
 * groups…"). The Run row says that to a person until it goes. An agent or a
 * notebook runs right after setting the options, and was refused with that
 * sentence when the read had not ended (CI run 42156372622, WebKit,
 * `analysis.run` of the markers): `runNow` waits for the read, and refuses only
 * with a reason a read cannot change.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/de-analysis-ui.js';
import { GenesPanelUI } from '../assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const turn = () => new Promise(resolve => setImmediate(resolve));

function running(ui, options) {
  const ran = [];
  ui._requireOptions = () => options;
  ui._runAnalysis = async () => { ran.push('ran'); ui._lastResult = { ran: true }; };
  ui._lastResult = null;
  return ran;
}

function markers(described) {
  const ui = Object.create(GenesPanelUI.prototype);
  Object.assign(ui, {
    _isDestroyed: false,
    _options: null,
    _groupState: { key: null, described: null, pending: null },
    _highlightRevision: 0,
    _notifications: { error: () => {} },
    _refreshOptionsContext: () => {},
    _ensureController: () => ({
      scopeOf: () => null,
      describeGroups: () => described.promise,
      plan: () => ({ blocker: null, testedCount: 2 }),
    }),
  });
  return ui;
}

const MARKERS = Object.freeze({ groupBy: 'cell_type', cells: 'all' });

test('markers run right after their options wait for the groups, then run', async () => {
  const described = deferred();
  const ui = markers(described);
  const ran = running(ui, MARKERS);
  const run = ui.runNow();
  await turn();
  assert.deepEqual(ran, [], 'nothing runs while the groups are read');
  described.resolve({ groups: [] });
  assert.equal(await run, true);
  assert.deepEqual(ran, ['ran']);
});

test('groups that cannot be read refuse the run with why', async () => {
  const described = deferred();
  const ui = markers(described);
  const ran = running(ui, MARKERS);
  const run = ui.runNow();
  await turn();
  described.reject(new Error('the read failed'));
  await assert.rejects(run, /The groups could not be read: the read failed/);
  assert.deepEqual(ran, []);
});

test('a stop while the groups are read ends the wait and runs nothing', async () => {
  const ui = markers(deferred());
  const ran = running(ui, MARKERS);
  const stop = new AbortController();
  const run = ui.runNow({ signal: stop.signal });
  await turn();
  stop.abort(new DOMException('stopped', 'AbortError'));
  await assert.rejects(run, /stopped/);
  assert.deepEqual(ran, []);
});

test('differential expression run right after its options waits for the categories', async () => {
  const described = deferred();
  const ui = Object.create(DEAnalysisUI.prototype);
  Object.assign(ui, {
    _fieldGroups: new Map(),
    _fieldGroupFailures: new Map(),
    _pendingFields: new Set(),
    _fieldReads: new Set(),
    _resolvedGroups: null,
    _replicateBlocker: null,
    _highlightRevision: 0,
    _isDestroyed: false,
    _notifications: { error: () => {} },
    _refreshOptionsContext: () => {},
    _openCells: () => null,
    _helperController: () => ({ describeGroups: () => described.promise }),
  });
  const options = {
    compare: 'categories', field: 'cluster',
    categoriesA: { mode: 'some', ids: ['a'] }, categoriesB: { mode: 'some', ids: ['b'] },
    within: 'all', withinField: '', withinCategories: { mode: 'all', ids: [] },
    pageA: '', pageB: '', replicates: '',
  };
  const ran = running(ui, options);
  const run = ui.runNow();
  await turn();
  assert.deepEqual(ran, [], 'nothing runs while the categories are read');
  described.resolve({ codes: Uint8Array.of(0, 1, 0, 1), categories: ['a', 'b'], groups: [{ optionId: 'a' }, { optionId: 'b' }] });
  assert.equal(await run, true);
  assert.deepEqual(ran, ['ran']);
});

test('a run that ends without a result is said as stopped or cancelled, never as one that changed nothing', async () => {
  // Stopped by its caller (an agent's Stop) while it ran: the caller's reason.
  const stopped = markers(deferred());
  stopped._requireOptions = () => MARKERS;
  stopped._ensureController = () => ({ scopeOf: () => null, describeGroups: async () => ({ groups: [] }), plan: () => ({ blocker: null, testedCount: 2 }) });
  const stop = new AbortController();
  stopped._lastResult = null;
  stopped._runAnalysis = async () => { stop.abort(new DOMException('The person stopped Claude.', 'AbortError')); };
  stopped.cancelRun = () => {};
  await assert.rejects(stopped.runNow({ signal: stop.signal }), /The person stopped Claude\./);
  // Canceled by a person (Cancel in the panel): nothing kept, said so (lane-analyst L3-14).
  const cancelledRun = markers(deferred());
  cancelledRun._requireOptions = () => MARKERS;
  cancelledRun._ensureController = stopped._ensureController;
  cancelledRun._lastResult = null;
  cancelledRun._runAnalysis = async () => {};
  await assert.rejects(cancelledRun.runNow(), error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.message, 'Marker genes was canceled before it finished; nothing was kept.');
    return true;
  });
});
