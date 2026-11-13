/**
 * An action's Stop reaches the work its implementation waits for. The
 * dispatcher waits for a stopped action to end before it puts back what the
 * action changed (never a half-made change), so a wait not tied to the
 * action's signal holds every later history move and every action on its
 * domains until that work ends. Each shared wait below takes the signal:
 *
 * - a view's embedding (`setViewRepresentation`, under `view.embedding.*`
 *   and the `views` domain's restore): stopped while it waits for its turn
 *   or its coordinates, it throws why at once and publishes nothing;
 * - a field copied (`duplicateField`, under `field.duplicate`): stopped
 *   while its source field is read, nothing is made;
 * - a kept view given a branch's state (`view.keep` with `branch`): the
 *   per-view domains' restores get the action's signal;
 * - the history report's pictures (`history.report`): stopped, no further
 *   step is shown, the jump under way ends and the step shown before comes
 *   back before the report ends as a cancellation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DataStateViewMethods } from '../assets/js/app/state/managers/view-manager.js';
import { FieldOverlayPublicMethods } from '../assets/js/app/state/managers/field/overlay-public.js';
import { createHistorySharing } from '../assets/js/app/ui/modules/state/share.js';
import { abortReason, cancelled, onAbort } from '../assets/js/utils/abort.js';
import { settlesSoon } from './helpers/settles.mjs';

const STOP = () => cancelled('user', 'The person stopped Claude.');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const source = path => readFileSync(new URL(`../assets/js/${path}`, import.meta.url), 'utf8');

/** A 2-cell page whose live view shows `2d`; `3d`'s coordinates arrive when `positions` resolves. */
function representationState(positions) {
  const published = [];
  const layouts = { '2d': 2, '3d': 3 };
  const viewLayouts = new Map([['live', '2d']]);
  const manager = {
    getLayout: key => ({ layoutKey: key, dimension: layouts[key], label: key }),
    getPositions: () => positions,
    getViewLayout: id => viewLayouts.get(id),
    getDefaultLayout: level => (level === 3 ? '3d' : '2d'),
    isEnabled: () => true,
    pinLayout: () => () => {},
    setViewLayout: (id, key) => { published.push(['layout', id, key]); viewLayouts.set(id, key); },
  };
  const state = Object.assign(Object.create(DataStateViewMethods.prototype), {
    activeViewId: 'live',
    centroidColors: null,
    centroidLabels: [],
    centroidPositions: null,
    dimensionManager: manager,
    getFieldForView: () => null,
    pointCount: 2,
    positionsArray: Float32Array.from([-0.5, -0.5, 0.5, 0.5]),
    positionsDimension: 2,
    viewer: {
      setViewEmbedding: (id, { dimension }) => published.push(['viewer', id, dimension]),
      updatePositions: (_positions, level) => published.push(['positions', 'live', level]),
    },
    viewContexts: new Map([['live', { id: 'live', followsDefault: true, centroidPositions: null, centroidColors: null, centroidLabels: [] }]]),
    _dimensionChangeLock: null,
    emit: () => {},
  });
  return { state, published, viewLayouts };
}

test('a view\'s embedding stopped while its coordinates are read ends at once and publishes nothing', async () => {
  const coordinates = deferred();
  const { state, published, viewLayouts } = representationState(coordinates.promise);
  const stop = new AbortController();
  const changing = state.setViewRepresentation('live', '3d', { followsDefault: true, signal: stop.signal });
  await new Promise(resolve => setImmediate(resolve));
  const reason = STOP();
  stop.abort(reason);
  const outcome = await settlesSoon(changing);
  assert.ok(outcome !== null, 'it ended without its coordinates');
  assert.equal(outcome.error, reason);
  assert.deepEqual(published, [], 'nothing published');
  assert.equal(viewLayouts.get('live'), '2d');
  // The coordinates arriving later change nothing; the next change runs (its turn is free).
  coordinates.resolve(new Float32Array(6));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(published, []);
  await state.setViewRepresentation('live', '3d', { followsDefault: true });
  assert.equal(viewLayouts.get('live'), '3d');
  // A caller already stopped changes nothing.
  const stopped = new AbortController();
  stopped.abort(STOP());
  await assert.rejects(state.setViewRepresentation('live', '2d', { followsDefault: true, signal: stopped.signal }), error => error.name === 'AbortError');
  assert.equal(viewLayouts.get('live'), '3d');
  // Anything but a signal is refused as before.
  await assert.rejects(state.setViewRepresentation('live', '2d', { followsDefault: true, signal: 'stop' }), /exactly one boolean "followsDefault"/);
});

test('every embedding change of an action or a restore passes its signal down to the coordinates', () => {
  const controls = source('app/ui/modules/representation-controls.js');
  for (const call of ['setViewEmbeddingRef(viewId, embedding, { signal })', 'showDefaultRepresentation(viewId, dimension, { signal })', 'cycleRepresentation(viewId, dimension, { signal })']) {
    assert.ok(controls.includes(call), call);
  }
  assert.ok(source('app/state/domains/views.js').includes('{ followsDefault: wanted.followsDefault, signal });'), 'the views domain\'s restore passes its signal');
  const manager = source('app/state/managers/view-manager.js');
  assert.match(manager, /await awaitWithSignal\(this\._dimensionChangeLock, signal\)/);
  assert.match(manager, /await awaitWithSignal\(dimensionManager\.getPositions\(nextLayoutKey\), signal\)/);
  assert.match(source('app/state/managers/mapping-manager.js'), /setViewEmbedding\(viewId, ref, \{ signal \}\)/);
});

test('a field copy stopped while its source field is read makes nothing', async () => {
  const sourceField = { key: 'score', kind: 'continuous', loaded: false };
  const asked = [];
  let made = 0;
  const state = Object.assign(Object.create(FieldOverlayPublicMethods.prototype), {
    _datasetGeneration: 1,
    obsData: { fields: [sourceField] },
    pointCount: 2,
    varData: { fields: [] },
    getDatasetGeneration() { return this._datasetGeneration; },
    // A read that ends with the signal it is given (`ensureFieldLoaded`).
    ensureFieldLoaded: (_index, { signal = null } = {}) => new Promise((_resolve, reject) => {
      asked.push(signal);
      onAbort(signal, () => reject(abortReason(signal)));
    }),
    _userDefinedFields: { createContinuousAlias() { made++; } },
  });
  const stop = new AbortController();
  const copying = state.duplicateField('obs', 0, { newKey: 'score copy', signal: stop.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(asked[0], stop.signal, 'the read is given the signal');
  const reason = STOP();
  stop.abort(reason);
  const outcome = await settlesSoon(copying);
  assert.ok(outcome !== null);
  assert.equal(outcome.error, reason);
  assert.equal(made, 0);
  assert.equal(state.obsData.fields.length, 1);
  // The action gives it its signal.
  assert.match(source('app/ui/modules/field-selector.js'), /duplicateField\(target\.source, target\.index, name === undefined \? \{ signal \} : \{ newKey: name, signal \}\)/);
});

test('a kept view given a branch\'s state restores it under the action\'s signal', () => {
  const views = source('app/ui/modules/view-controls.js');
  assert.match(views, /actions\.provide\('view\.keep', async \(\{ branch, name \}, \{ signal \}\) =>/);
  assert.match(views, /await showBranchIn\(keptId, branch, signal\)/);
  const body = views.slice(views.indexOf('async function showBranchIn('), views.indexOf('function clearViews('));
  assert.match(body, /owner\.restore\([^;]*\{ signal \}\)/);
  assert.doesNotMatch(body, /signal: null/);
});

/** A tracker shown at s3 (s0 → s1 → s2 → s3); `jump` moves its head, and the jump to s2 holds until its signal aborts. */
function reportPage() {
  const steps = new Map([
    ['s0', { id: 's0', parent: null, label: 'Opened' }],
    ['s1', { id: 's1', parent: 's0', label: 'One' }],
    ['s2', { id: 's2', parent: 's1', label: 'Two' }],
    ['s3', { id: 's3', parent: 's2', label: 'Three' }],
  ]);
  const tracker = {
    id: 't1', headId: 's3', activeBranch: 'main',
    step: id => steps.get(id),
    branch: () => ({ tip: 's3', name: 'Main' }),
  };
  const jumps = [];
  const jump = (stepId, { signal = null } = {}) => {
    jumps.push([stepId, signal !== null]);
    if (stepId !== 's2') {
      tracker.headId = stepId;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      onAbort(signal, () => reject(abortReason(signal)));
    });
  };
  const pictured = [];
  const sharing = createHistorySharing({
    ownerDocument: {},
    history: () => null,
    view: () => tracker,
    read: async () => ({ text: '' }),
    jump,
    datasetFacts: () => ({ name: 'Demo' }),
    pictures: async () => { pictured.push(tracker.headId); return { png: 'AA==' }; },
    reportDom: null,
    run: task => task(),
  });
  return { sharing, tracker, jumps, pictured };
}

test('a report stopped while it shows a step for a picture ends at once and comes back to the step shown', async () => {
  const { sharing, tracker, jumps, pictured } = reportPage();
  const stop = new AbortController();
  const reporting = sharing.report({ pictures: ['s1', 's2', 's3'], signal: stop.signal });
  while (jumps.length < 2) await new Promise(resolve => setImmediate(resolve));
  const reason = STOP();
  stop.abort(reason);
  const outcome = await settlesSoon(reporting);
  assert.ok(outcome !== null, 'it ended without the jump\'s own end');
  assert.equal(outcome.error, reason);
  assert.deepEqual(jumps, [['s1', true], ['s2', true], ['s3', false]], 'no further step; the step shown before comes back, whatever stopped');
  assert.deepEqual(pictured, ['s1']);
  assert.equal(tracker.headId, 's3');
  // The action gives the report its signal, and the panel gives a jump its caller's.
  const panel = source('app/ui/modules/state/index.js');
  assert.match(panel, /provide\('history\.report', \(params, \{ confirm, signal \}\) => reportAction\(params, confirm, signal\)\)/);
  assert.match(panel, /sharing\.report\(\{ pictures: choice, signal \}\)/);
  assert.match(panel, /jump: \(stepId, how\) => actions\.act\('history\.jump', \{ step: stepId \}, how\)/);
});

test('a saved state opened by an agent restores its history under the action\'s signal', () => {
  // `history.saved.open`: the opening is cancelled by its Stop (`asAgentOpening`), and the history's
  // restore after it hears the same signal down to `SessionSerializer.loadSavedHistory` (`_runOwnedRestore`).
  assert.match(source('app/ui/modules/dataset-open-action.js'), /await store\.open\(id, \{ heavy, signal \}\)/);
  const histories = source('app/history/dataset-history.js');
  assert.match(histories, /open: \(id, \{ heavy = null, signal = null \} = \{\}\) => openFromList\(id, \{ heavy, signal \}\)/);
  assert.match(histories, /async loadSaved\(source, \{ heavy = null, signal = null \} = \{\}\)/);
  assert.match(histories, /loadSavedHistory\(\(\) => Promise\.resolve\(source\), \{ label: 'Saved state', heavy, signal \}\)/);
  const session = source('app/ui/modules/session-controls.js');
  assert.match(session, /function openSavedState\(id, \{ heavy = null, signal = null \} = \{\}\)/);
  assert.match(session, /savedStates\.load\(source, \{ heavy, signal \}\)/);
  // The page passes the options through (`main.js`, `ui-coordinator.js`).
  assert.match(source('app/main.js'), /openSavedState: \(id, options\) => ui\.openSavedState\(id, options\)/);
  assert.match(source('app/main.js'), /loadSavedHistory: \(open, options\) => sessionSerializer\.loadSavedHistory\(open, options\)/);
  assert.match(source('app/ui/core/ui-coordinator.js'), /openSavedState: sessionControls\.openSavedState,/);
});
