/**
 * A host's (Python's, R's) commands are actions of the catalog
 * (`app/viewer-host/command-handler.js`): each is dispatched with origin
 * `host` and the host's name, lowercased, takes the path a control takes,
 * and is answered with its outcome as JSON and the history step it made,
 * as part of the host's turn when it names one. A session file a host
 * pushes is loaded as the person's Load loads one. None is carried out while
 * the person shows another dataset.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createViewerHostCommandHandlers,
} from '../assets/js/app/viewer-host/command-handler.js';
import {
  DataStateFilterMethods,
} from '../assets/js/app/state/managers/filter-manager.js';
import {
  DataState,
} from '../assets/js/app/state/core/data-state.js';
import { orderedCellIdentity } from './helpers/ordered-cell-identity.mjs';
import { getActions } from '../assets/js/app/actions/index.js';
import { provideHighlightActions } from '../assets/js/app/ui/modules/highlight/highlight-actions.js';
import { installFieldActions } from '../assets/js/app/state/actions/field-actions.js';
import { resolveField } from '../assets/js/app/actions/targets/fields.js';

/** Handlers over the page's dispatcher, for the host `runtime` while `shown()` names its dataset. */
function hostHandlers({
  runtime = 'python', shown = () => 'example', actions = getActions(),
  loadSession = async () => { throw new Error('This test loads no session'); },
} = {}) {
  return createViewerHostCommandHandlers({
    getShownHostDataset: shown,
    getHostRuntime: () => runtime,
    actions,
    loadSession,
  });
}

/** An action command as the channel hands it over: no turn unless one is given. */
function command(action, params, turn = null, turnLabel = null) {
  return { action, params, turn, turnLabel };
}

/** Provide `handlers` (type → implementation) on the page's dispatcher for one test. */
function provide(t, handlers) {
  const removers = Object.entries(handlers).map(([type, handler]) => getActions().provide(type, handler));
  t.after(() => { for (const remove of removers) remove(); });
}

test('the handlers take exactly the dataset shown, what opened the viewer, the dispatcher and the session loader', () => {
  const actions = { dispatch: async () => ({ outcome: null, step: null, unrecorded: null }) };
  const options = {
    getShownHostDataset: () => 'example', getHostRuntime: () => 'r', actions,
    loadSession: async () => ({ tracker: { id: 't', name: 'T' }, head: 's0' }),
  };
  assert.deepEqual(Object.keys(createViewerHostCommandHandlers(options)), ['handleAction', 'handleLoadSession']);
  for (const wrong of [
    null,
    {},
    { ...options, state: {} },
    { getShownHostDataset: options.getShownHostDataset, actions },
  ]) {
    assert.throws(() => createViewerHostCommandHandlers(wrong), /require exactly getShownHostDataset, getHostRuntime, actions, loadSession/);
  }
  assert.throws(() => createViewerHostCommandHandlers({ ...options, getHostRuntime: 'r' }), /getHostRuntime must be a function/);
  assert.throws(() => createViewerHostCommandHandlers({ ...options, loadSession: null }), /loadSession must be a function/);
  assert.throws(() => createViewerHostCommandHandlers({ ...options, actions: {} }), /action dispatcher/);
});

test('a host action is dispatched as the host, and answered with its outcome as JSON and its step', async () => {
  const dispatched = [];
  let answer = null;
  const actions = {
    async dispatch(type, params, meta) {
      dispatched.push([type, params, meta]);
      return answer;
    },
  };
  const cells = Uint32Array.of(4, 1);
  answer = {
    // An outcome as its implementation made it: values JSON cannot carry
    // are converted, never refused after the action ran.
    outcome: { name: 'leiden', kind: 'categorical', skip: undefined, counts: Uint32Array.of(2, 3), ratio: Number.NaN },
    step: { id: 's3', label: 'Added the categorical column leiden', parent: 's2', touches: ['fields'] },
    unrecorded: null,
  };
  const handlers = hostHandlers({ runtime: 'python', actions });
  assert.deepEqual(await handlers.handleAction(command('field.push', { cells })), {
    outcome: { name: 'leiden', kind: 'categorical', counts: [2, 3], ratio: null },
    step: { id: 's3', label: 'Added the categorical column leiden' },
    unrecorded: null,
  });
  // The parameters reach the dispatcher as the channel decoded them (typed arrays in place).
  assert.equal(dispatched[0][1].cells, cells);
  assert.deepEqual(dispatched[0], ['field.push', { cells }, { origin: 'host', host: 'python', turn: null, turnLabel: null }]);

  // A read: no step, and nothing to say why.
  answer = { outcome: undefined, step: null, unrecorded: null };
  assert.deepEqual(await hostHandlers({ runtime: 'r', actions }).handleAction(command('history.get', {})), {
    outcome: null, step: null, unrecorded: null,
  });
  assert.deepEqual(dispatched[1][2], { origin: 'host', host: 'r', turn: null, turnLabel: null });
  // A Python notebook's steps are Python's, whatever the viewer calls its host.
  await hostHandlers({ runtime: 'jupyter', actions }).handleAction(command('history.undo', {}));
  assert.deepEqual(dispatched[2][2], { origin: 'host', host: 'python', turn: null, turnLabel: null });
  // A host that named itself nothing is still the host.
  await hostHandlers({ runtime: null, actions }).handleAction(command('history.undo', {}));
  assert.deepEqual(dispatched[3][2], { origin: 'host', host: null, turn: null, turnLabel: null });
  // A notebook turn travels with each of its actions into the dispatch meta.
  await hostHandlers({ runtime: 'r', actions }).handleAction(command('color.by', {}, 'r-turn-2', 'Normalize and cluster'));
  assert.deepEqual(dispatched[4][2], { origin: 'host', host: 'r', turn: 'r-turn-2', turnLabel: 'Normalize and cluster' });
});

test('the steps of one notebook turn are one turn of the history', async t => {
  const { createActionCatalog, defineAction } = await import('../assets/js/app/actions/catalog.js');
  const { createActionDispatcher } = await import('../assets/js/app/actions/dispatcher.js');
  const { createDomainRegistry } = await import('../assets/js/app/actions/domains.js');
  const { createHistory } = await import('../assets/js/app/history/history.js');
  const { historyActions } = await import('../assets/js/app/actions/definitions/history.js');
  const state = { highlights: { active: null, pages: [] } };
  const domains = createDomainRegistry();
  for (const id of domains.missing()) {
    domains.provide(id, {
      capture: () => (id === 'highlights' ? state.highlights : null),
      restore: value => { if (id === 'highlights') state.highlights = value; },
    });
  }
  const mark = defineAction({
    type: 'test.mark', title: 'Mark', summary: 'Mark a page.', group: 'Test', reads: [], effect: 'state', touches: ['highlights'],
    params: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } },
    describe: params => `Marked ${params.name}`, code: params => `mark(${JSON.stringify(params.name)})`,
  });
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([mark, ...historyActions]) });
  dispatcher.provide('test.mark', ({ name }) => {
    state.highlights = { active: null, pages: [...state.highlights.pages, { id: name, name, color: '#000000', groups: [] }] };
    return null;
  });
  let clock = 1_767_225_600_000;
  let trackers = 0;
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'demo', name: 'Demo', cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-00000000000${++trackers}`, now: () => (clock += 1000),
  });
  t.after(() => history.destroy?.());
  await history.startTracker({ name: 'Tracker 1' });
  const handlers = hostHandlers({ actions: dispatcher });
  await handlers.handleAction(command('test.mark', { name: 'a' }, 'python-turn-1', 'QC'));
  await handlers.handleAction(command('test.mark', { name: 'b' }, 'python-turn-1', 'QC'));
  await handlers.handleAction(command('test.mark', { name: 'c' }));
  const steps = history.active.steps instanceof Map ? [...history.active.steps.values()] : history.active.steps;
  const taken = steps.filter(step => step.type === 'test.mark');
  assert.deepEqual(taken.map(step => step.turn ?? step.by?.turn ?? null), ['python-turn-1', 'python-turn-1', null]);
});

test('a host\'s change that made no step is answered with why (unrecorded), from the history itself', async t => {
  const { createActionCatalog, defineAction } = await import('../assets/js/app/actions/catalog.js');
  const { createActionDispatcher } = await import('../assets/js/app/actions/dispatcher.js');
  const { createDomainRegistry } = await import('../assets/js/app/actions/domains.js');
  const { createHistory } = await import('../assets/js/app/history/history.js');
  const { historyActions } = await import('../assets/js/app/actions/definitions/history.js');
  const { VIEWER_ACTION_UNRECORDED } = await import('../assets/js/data/viewer-protocol.js');
  const { UNRECORDED_NOTES } = await import('../assets/js/app/agent/bridge/mcp-content.js');
  // The reasons a host hears are the ones an agent is told: one closed set.
  assert.deepEqual(Object.keys(UNRECORDED_NOTES).sort(), Object.keys(VIEWER_ACTION_UNRECORDED).sort());
  const state = { highlights: { active: null, pages: [] } };
  const domains = createDomainRegistry();
  for (const id of domains.missing()) {
    domains.provide(id, {
      capture: () => (id === 'highlights' ? state.highlights : null),
      restore: value => { if (id === 'highlights') state.highlights = value; },
    });
  }
  const page = defineAction({
    type: 'test.page', title: 'Page', summary: 'Show one page.', group: 'Test', reads: [], effect: 'state', touches: ['highlights'],
    params: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } },
    describe: params => `Showed ${params.name}`, code: params => `page(${JSON.stringify(params.name)})`,
  });
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([page, ...historyActions]) });
  dispatcher.provide('test.page', ({ name }) => {
    state.highlights = { active: null, pages: [{ id: name, name, color: '#000000', groups: [] }] };
    return null;
  });
  let clock = 1_767_225_600_000;
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'demo', name: 'Demo', cellOrder: null },
    newTrackerId: () => 't-00000000-0000-4000-8000-000000000001', now: () => (clock += 1000),
  });
  t.after(() => history.destroy?.());
  await history.startTracker({ name: 'Tracker 1' });
  const handlers = hostHandlers({ actions: dispatcher });
  const made = await handlers.handleAction(command('test.page', { name: 'a' }));
  assert.equal(made.unrecorded, null, 'a step was made');
  assert.notEqual(made.step, null);
  // The same page again: nothing changed.
  assert.deepEqual(await handlers.handleAction(command('test.page', { name: 'a' })), { outcome: null, step: null, unrecorded: 'unchanged' });
  // A read is no change: nothing to say.
  const read = await handlers.handleAction(command('history.summary', {}));
  assert.deepEqual([read.step, read.unrecorded], [null, null]);
  await handlers.handleAction(command('history.recording.pause', {}));
  assert.deepEqual(await handlers.handleAction(command('test.page', { name: 'b' })), { outcome: null, step: null, unrecorded: 'paused' });
  await handlers.handleAction(command('history.recording.resume', {}));
  history.destroy();
  assert.deepEqual(await handlers.handleAction(command('test.page', { name: 'c' })), { outcome: null, step: null, unrecorded: 'no-history' });
});

test('every reason a dispatch gives reaches the host, and none beside a step', async () => {
  const { VIEWER_ACTION_UNRECORDED } = await import('../assets/js/data/viewer-protocol.js');
  for (const reason of Object.keys(VIEWER_ACTION_UNRECORDED)) {
    const actions = { dispatch: async () => ({ outcome: { field: 'cell_type' }, step: null, unrecorded: reason }) };
    assert.deepEqual(await hostHandlers({ actions }).handleAction(command('color.by', {})), {
      outcome: { field: 'cell_type' }, step: null, unrecorded: reason,
    });
  }
});

test('a session file a host pushes is loaded as the person loads one, while its dataset is shown', async () => {
  let shown = 'example';
  const loaded = [];
  const handlers = hostHandlers({
    shown: () => shown,
    loadSession: async file => {
      loaded.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      return { tracker: { id: 't-1', name: 'Shared' }, head: 's4' };
    },
  });
  const file = new TextEncoder().encode('CELLUCID_SESSION/4\n');
  assert.deepEqual(await handlers.handleLoadSession({ name: 'shared.cellucid-session', file }), {
    tracker: { id: 't-1', name: 'Shared' }, head: 's4',
  });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, 'shared.cellucid-session');
  assert.deepEqual(loaded[0].bytes, file);
  shown = null;
  await assert.rejects(
    handlers.handleLoadSession({ name: 'shared.cellucid-session', file }),
    /^Error: The viewer shows a dataset the Python session did not open, so the session "shared\.cellucid-session" was not carried out/,
  );
  assert.equal(loaded.length, 1);
});

test('no action is carried out while the viewer shows another dataset', async () => {
  let shown = null;
  const dispatched = [];
  const actions = {
    async dispatch(type) {
      dispatched.push(type);
      return { outcome: null, step: null, unrecorded: null };
    },
  };
  const handlers = hostHandlers({ shown: () => shown, actions });
  for (const action of ['highlight.cells', 'color.by', 'history.get', 'history.undo']) {
    await assert.rejects(
      handlers.handleAction(command(action, {})),
      new RegExp(`^Error: The viewer shows a dataset the Python session did not open, so "${action.replace('.', '\\.')}" was not carried out; open the dataset of the Python session again`),
    );
  }
  assert.deepEqual(dispatched, []);
  shown = 'example';
  await handlers.handleAction(command('color.by', {}));
  assert.deepEqual(dispatched, ['color.by']);
});

test('an unknown action, and parameters the action\'s schema refuses, reach the host as errors', async () => {
  const handlers = hostHandlers();
  await assert.rejects(handlers.handleAction(command('nothing.here', {})), /^RangeError: There is no action "nothing\.here"$/);
  await assert.rejects(handlers.handleAction(command('color.by', { field: 'cell_type' })), TypeError);
  await assert.rejects(handlers.handleAction(command('history.jump', { step: 'step 3' })), /step/);
});

test('a host\'s coloring resolves its field by name, and refuses an absent or ambiguous one', async t => {
  let chosen = 0;
  const state = {
    pointCount: 0,
    getFields: () => [{ key: 'duplicate' }, { key: 'duplicate' }, { key: 'shown' }],
  };
  const seen = [];
  provide(t, {
    // The field selector's own choice in the app; here it resolves the field
    // as it does and records the choice.
    'color.by': ({ field }, { meta }) => {
      resolveField(state, field);
      chosen += 1;
      seen.push([meta.origin, meta.host]);
      return { field: field.key, source: field.source, kind: 'category' };
    },
  });
  const handlers = hostHandlers();
  await assert.rejects(
    handlers.handleAction({ action: 'color.by', params: { field: { source: 'obs', key: 'missing' } } }),
    /^ActionRefused: There is no field "missing"; the fields are "duplicate", "duplicate" and "shown"\.$/,
  );
  await assert.rejects(
    handlers.handleAction({ action: 'color.by', params: { field: { source: 'obs', key: 'duplicate' } } }),
    /Two fields are named "duplicate"; rename one first\./,
  );
  assert.equal(chosen, 0);
  assert.deepEqual(await handlers.handleAction({ action: 'color.by', params: { field: { source: 'obs', key: 'shown' } } }), {
    outcome: { field: 'shown', source: 'obs', kind: 'category' },
    // No history on this page: no step, and the host is told why.
    step: null,
    unrecorded: 'no-history',
  });
  assert.deepEqual(seen, [['host', 'python']]);
});

test('a host\'s highlight goes to a page of its color and never recolors one', async t => {
  const state = new DataState({}, null);
  state.pointCount = 5;
  state.highlightArray = new Uint8Array(5);
  // Of 5 cells, open cell i is original position [4, 0, 3, 1, 2][i].
  state.cellIdentity = orderedCellIdentity({ nObs: 5 });
  t.after(provideHighlightActions({ state }));

  const { outcome } = await hostHandlers().handleAction({
    action: 'highlight.cells',
    params: { cells: Uint32Array.of(1, 3), color: '#123abc' },
  });
  assert.equal(typeof outcome, 'object');

  // The person's page keeps its color; the highlight has a page of its own.
  assert.deepEqual(
    state.getHighlightPages().map(({ name, color }) => [name, color]),
    [['Page 1', '#2563eb'], ['Page 2', '#123abc']]
  );
  const page = state.getActivePage();
  assert.equal(page.color, '#123abc');
  const [group] = page.highlightedGroups;
  assert.ok(group.cellIndices instanceof Uint32Array, 'a direct highlight owns its cells as a Uint32Array');
  assert.deepEqual({ ...group, cellIndices: [...group.cellIndices] }, {
    id: 'highlight_1',
    type: 'annotation',
    label: 'Highlight',
    enabled: true,
    // Original positions 1 and 3 are open cells 3 and 2.
    cellIndices: [2, 3],
    cellCount: 2,
  });
  assert.deepEqual([...state.highlightArray], [0, 0, 255, 255, 0]);
  await assert.rejects(
    hostHandlers().handleAction({ action: 'highlight.cells', params: { cells: Uint32Array.of(1, 5), color: '#123abc' } }),
    /outside the 5 cells of the dataset/,
  );
  assert.equal(page.highlightedGroups.length, 1);
});

test('a host\'s highlight names original positions: only the open ones are highlighted', async t => {
  const state = new DataState({}, null);
  state.pointCount = 3;
  state.highlightArray = new Uint8Array(3);
  // Cells 0, 2, 4 of 6, opened in the order 4, 0, 2.
  state.cellIdentity = orderedCellIdentity({ nObs: 6, kept: [0, 2, 4] });
  t.after(provideHighlightActions({ state }));
  const handlers = hostHandlers({ runtime: 'r' });
  await handlers.handleAction({ action: 'highlight.cells', params: { cells: Uint32Array.of(4, 1, 2), color: '#123abc', label: 'Picked' } });
  const [group] = state.getActivePage().highlightedGroups;
  assert.equal(group.label, 'Picked');
  assert.deepEqual([...group.cellIndices], [0, 2]);
  await assert.rejects(
    handlers.handleAction({ action: 'highlight.cells', params: { cells: Uint32Array.of(1, 3), color: '#123abc' } }),
    /None of the 2 cells/,
  );
});

test('a pushed column and a gene set reach the viewer state and are answered with what they made', async t => {
  const state = new DataState({}, null);
  state.pointCount = 4;
  state.obsData = { fields: [] };
  const upserts = [];
  state.upsertUserDefinedContinuousField = options => {
    upserts.push(['continuous', options]);
    return { fieldIndex: 0, fieldId: 'user_obs_value_1', key: options.key, updatedInPlace: false };
  };
  state.upsertUserDefinedCategoricalField = options => {
    upserts.push(['categorical', options]);
    state.obsData.fields.push({
      key: options.key, kind: 'category', categories: options.categories, _isUserDefined: true,
      _userDefinedId: 'user_cat_1', _operation: options.meta._operation,
    });
    return { fieldIndex: state.obsData.fields.length - 1, key: options.key, updatedInPlace: false };
  };
  // A subsample of 4 of the dataset's 10 cells, opened in the order 8, 1, 5, 3:
  // the column is gathered to them, in that order.
  state.cellIdentity = orderedCellIdentity({ nObs: 10, kept: [1, 3, 5, 8] });
  t.after(installFieldActions({ state }));
  const handlers = hostHandlers({ runtime: 'r' });

  const continuous = await handlers.handleAction({
    action: 'field.push',
    params: { key: 'score', kind: 'continuous', categories: null, n_obs: 10, cells: Uint32Array.of(3, 4, 8), values: Float32Array.of(0.5, 9, -1) },
  });
  assert.deepEqual(continuous, { outcome: { name: 'score', kind: 'continuous', id: 'user_obs_value_1' }, step: null, unrecorded: 'no-history' });
  assert.deepEqual([...upserts[0][1].values], [-1, NaN, NaN, 0.5]);
  assert.deepEqual(upserts[0][1].operation, { type: 'notebook-push' });

  const categorical = await handlers.handleAction({
    action: 'field.push',
    params: { key: 'leiden', kind: 'categorical', categories: ['a', 'b'], n_obs: 10, cells: null, values: Uint16Array.of(0, 1, 0, 65535, 1, 0, 0, 0, 1, 0) },
  });
  assert.deepEqual(categorical.outcome, { name: 'leiden', kind: 'categorical', id: 'user_cat_1' });
  // Codes narrowed to the storage of two categories, "no category" carried across.
  assert.ok(upserts[1][1].codes instanceof Uint8Array);
  assert.deepEqual([...upserts[1][1].codes], [1, 1, 0, 255]);

  await assert.rejects(
    handlers.handleAction({ action: 'field.push', params: { key: 'x', kind: 'continuous', categories: null, n_obs: 11, cells: null, values: new Float32Array(11) } }),
    /another dataset/,
  );
  state.obsData.fields.push({ key: 'cell_type', kind: 'category', categories: ['a'] });
  await assert.rejects(
    handlers.handleAction({ action: 'field.push', params: { key: 'cell_type', kind: 'categorical', categories: ['a'], n_obs: 10, cells: null, values: new Uint8Array(10) } }),
    /exists already/,
  );

  const geneSet = await handlers.handleAction({ action: 'gene-set.save', params: { name: 'T', description: '', genes: ['CD3E'] } });
  assert.deepEqual(geneSet.outcome, { id: 'gene_set_1', name: 'T', genes: 1 });
  assert.deepEqual(state.getDerivedResults().toSessionRecord(), [{ name: 'T', description: '', genes: ['CD3E'] }]);
});

const SHOWN_MAPPING = Object.freeze({
  kind: 'anndata',
  embeddings: { enabled: [{ key: 'X_umap', columns: [0, 1] }], defaults: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null } },
  knn: null,
  geneNames: 'index',
  expression: 'X',
  log1p: {},
  highlyVariable: null,
  latent: null,
  vectorFields: [],
});

test('a host\'s data mapping is one transaction whose origin is the notebook\'s', async t => {
  const calls = [];
  let current = SHOWN_MAPPING;
  let refuse = false;
  const state = {
    async applyDataMapping(mapping, options) {
      calls.push([mapping, options]);
      if (refuse) throw new RangeError('obsp[\'distances\'] is not symmetric');
      current = mapping;
      return true;
    },
    getDataMapping: () => current,
    // The groups that follow the matrix are DataState's rule (`followMappingChanges`,
    // tests/data-mapping-axis-context-contract.test.mjs); this dataset has none to move.
    followMappingChanges: (base, changes) => ({ ...base, ...changes }),
  };
  t.after(installFieldActions({ state }));
  const handlers = hostHandlers();
  const { outcome } = await handlers.handleAction({ action: 'mapping.set', params: { expression: 'raw' } });
  assert.deepEqual(outcome, { groups: 1 });
  // The mapping applied is the notebook's: what `mapping:changed` reports to it.
  // The handler's heavy-work asker goes with it (normalized values of another matrix sum its totals).
  assert.equal(calls.length, 1);
  const [[mapping, { heavy, signal, ...options }]] = calls;
  assert.deepEqual([mapping, options], [{ ...SHOWN_MAPPING, expression: 'raw' }, { origin: 'notebook' }]);
  assert.equal(typeof heavy, 'function');
  // And the action's Stop.
  assert.ok(signal instanceof AbortSignal);
  // Refused, nothing changes and the host is told why.
  refuse = true;
  await assert.rejects(handlers.handleAction({ action: 'mapping.set', params: { expression: 'X' } }), /not symmetric/);
  assert.equal(current.expression, 'raw');
});

test('manual viewer host visibility composes with current filters', () => {
  const state = Object.assign(
    Object.create(DataStateFilterMethods.prototype),
    {
      pointCount: 3,
      obsData: { fields: [] },
      varData: null,
      activeFieldSource: null,
      activeVarFieldIndex: -1,
      colorsArray: new Uint8Array([
        0, 0, 0, 255,
        0, 0, 0, 255,
        0, 0, 0, 255,
      ]),
      categoryTransparency: new Uint8Array([1, 1, 1]),
      cellVisibilityMask: new Uint8Array([1, 1, 1]),
      isOutlierFilterEnabledForActiveField: () => false,
      getCurrentOutlierThreshold: () => 1,
      _updateActiveCategoryCounts: () => false,
      _pushTransparencyToViewer() {},
      _syncActiveContext() {},
      updateFilteredCount() {},
      updateFilterSummary() {},
      _notifyVisibilityChange() {},
    },
  );

  state.setCellVisibility([1], false);
  assert.deepEqual([...state.cellVisibilityMask], [1, 0, 1]);
  assert.deepEqual([...state.categoryTransparency], [1, 0, 1]);

  state.setCellVisibility(null, true);
  assert.deepEqual([...state.cellVisibilityMask], [1, 1, 1]);
  assert.deepEqual([...state.categoryTransparency], [1, 1, 1]);
  assert.throws(
    () => state.setCellVisibility([3], false),
    /outside.*point count/i,
  );
});
