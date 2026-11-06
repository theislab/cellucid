/**
 * The representation picker of the selected view, and the keyboard's 1/2/3
 * gesture (`ui/modules/representation-controls.js`).
 *
 * The picker lists every enabled representation of the open dataset, grouped
 * by dimension, and edits the view selected in Compare views; its label says
 * which view. Keys 1, 2 and 3 show a dimension's default in the selected view
 * and, pressed again, step through that dimension's other representations; a
 * short notice names what is shown and its place in the cycle.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { getActions } from '../assets/js/app/actions/index.js';
import {
  initRepresentationControls,
  representationOptionText,
  representationOptionTitle,
} from '../assets/js/app/ui/modules/representation-controls.js';

function createDeferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

const REPRESENTATIONS = Object.freeze([
  Object.freeze({ layoutKey: 'X_umap_3d', dimension: 3, name: 'UMAP', label: 'UMAP', isDefault: true, ref: { key: 'X_umap', columns: [0, 1, 2] } }),
  Object.freeze({ layoutKey: 'X_pca', dimension: 2, name: 'PCA (unintegrated)', label: 'PCA (unintegrated)', isDefault: false, ref: { key: 'X_pca', columns: [0, 1] } }),
  Object.freeze({ layoutKey: 'X_umap_2d', dimension: 2, name: 'UMAP', label: 'UMAP', isDefault: true, ref: { key: 'X_umap', columns: [0, 1] } }),
  Object.freeze({ layoutKey: 'X_tsne', dimension: 2, name: 't-SNE', label: 't-SNE', isDefault: false, ref: { key: 'X_tsne', columns: [0, 1] } }),
]);

/** Views as the viewer lists them: the live view and one kept view (View 2). */
const VIEWER = Object.freeze({
  getLiveViewHidden: () => false,
  getSnapshotViews: () => [{ id: 'snap_1' }],
});

/** Every action dispatched in a test, with its exact params. */
function recordDispatches(t) {
  const events = [];
  const stop = getActions().subscribe(event => {
    if (event.kind === 'start') events.push([event.type, event.params]);
  });
  t.after(stop);
  return events;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function installDom(t) {
  const previous = {
    HTMLElement: globalThis.HTMLElement,
    HTMLSelectElement: globalThis.HTMLSelectElement,
  };
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });
  class FakeHTMLElement {}
  class FakeHTMLSelectElement extends FakeHTMLElement {}
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.HTMLSelectElement = FakeHTMLSelectElement;

  const ownerDocument = {
    createElement(tagName) {
      assert.ok(tagName === 'option' || tagName === 'optgroup', tagName);
      return {
        tagName,
        label: '',
        title: '',
        value: '',
        textContent: '',
        children: [],
        appendChild(child) {
          this.children.push(child);
        },
      };
    },
  };
  const listeners = [];
  const select = Object.assign(new FakeHTMLSelectElement(), {
    ownerDocument,
    groups: [],
    value: '',
    title: '',
    disabled: false,
    addEventListener(type, listener, options) {
      assert.equal(type, 'change');
      listeners.push({ listener, signal: options.signal });
    },
    replaceChildren(...groups) {
      this.groups = groups;
    },
  });
  const label = Object.assign(new FakeHTMLElement(), { textContent: '' });
  const controls = Object.assign(new FakeHTMLElement(), { hidden: false });
  return {
    dom: { controls, label, select },
    fireChange(value) {
      select.value = value;
      for (const { listener, signal } of listeners) {
        if (!signal.aborted) listener();
      }
    },
    listeners,
  };
}

function captureNotifications(t) {
  const notifications = getNotificationCenter();
  const original = {
    dismiss: notifications.dismiss,
    error: notifications.error,
    hasNotification: notifications.hasNotification,
    info: notifications.info,
  };
  const events = [];
  let nextId = 1;
  const open = new Set();
  notifications.info = (message, options) => {
    const id = `n${nextId++}`;
    open.add(id);
    events.push(['info', message, options]);
    return id;
  };
  notifications.error = (message, options) => {
    events.push(['error', message, options]);
    return `n${nextId++}`;
  };
  notifications.hasNotification = id => open.has(id);
  notifications.dismiss = id => {
    open.delete(id);
    events.push(['dismiss', id]);
  };
  t.after(() => Object.assign(notifications, original));
  return events;
}

function createState({ layoutKey = 'X_umap_2d', representations = REPRESENTATIONS } = {}) {
  const listeners = new Map();
  const calls = [];
  const state = {
    activeViewId: 'snap_1',
    layouts: new Map([['live', 'X_umap_3d'], ['snap_1', layoutKey]]),
    representations,
    pending: null,
    getActiveViewId() {
      return this.activeViewId;
    },
    getEnabledRepresentations() {
      return this.representations;
    },
    getViewLayoutKey(viewId) {
      if (!this.layouts.has(viewId)) {
        throw new RangeError(`Layout state is not published for view "${viewId}".`);
      }
      return this.layouts.get(viewId);
    },
    on(name, listener) {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    async setViewEmbeddingRef(viewId, ref) {
      calls.push(['setViewEmbeddingRef', viewId, ref]);
      if (this.pending !== null) await this.pending;
      const shown = this.representations.find(item => (
        item.ref.key === ref.key && item.ref.columns.join() === ref.columns.join()
      ));
      if (shown === undefined) throw new RangeError(`This dataset cannot plot obsm['${ref.key}'].`);
      this.layouts.set(viewId, shown.layoutKey);
      return shown.layoutKey;
    },
    async showDefaultRepresentation(viewId, dimension) {
      calls.push(['showDefaultRepresentation', viewId, dimension]);
      const shown = this.representations.find(item => item.dimension === dimension && item.isDefault);
      this.layouts.set(viewId, shown.layoutKey);
      return shown.layoutKey;
    },
    async cycleRepresentation(viewId, dimension) {
      calls.push(['cycleRepresentation', viewId, dimension]);
      if (this.pending !== null) await this.pending;
      const choices = this.representations
        .filter(item => item.dimension === dimension)
        .map(item => item.layoutKey);
      const current = this.layouts.get(viewId);
      const next = choices.includes(current)
        ? choices[(choices.indexOf(current) + 1) % choices.length]
        : this.representations.find(item => item.dimension === dimension && item.isDefault).layoutKey;
      this.layouts.set(viewId, next);
      return { layoutKey: next, position: choices.indexOf(next) + 1, count: choices.length };
    },
  };
  return { calls, listeners, state };
}

function pickerGroups(select) {
  return select.groups.map(group => ({
    label: group.label,
    options: group.children.map(option => option.textContent),
  }));
}

test('option text names the representation and its dimension; the title says what it is read from', () => {
  assert.equal(representationOptionText(REPRESENTATIONS[1]), 'PCA (unintegrated) · 2D');
  assert.equal(
    representationOptionTitle(REPRESENTATIONS[0]),
    'The 3D default of this dataset (UMAP).'
  );
  assert.equal(
    representationOptionTitle(REPRESENTATIONS[3]),
    'A 2D embedding of this dataset (t-SNE).'
  );
});

test('the picker lists every enabled representation by dimension and names the view it edits', t => {
  const { dom } = installDom(t);
  const { state } = createState();
  const controls = initRepresentationControls({
    state,
    viewer: VIEWER,
    dom,
    callbacks: {
      viewLabel: viewId => (viewId === 'snap_1' ? 'View 2' : null),
      onViewBadgesMaybeChanged() {},
    },
  });
  t.after(() => controls.destroy());

  assert.equal(dom.controls.hidden, false);
  assert.equal(dom.label.textContent, 'View 2 shows');
  assert.deepEqual(pickerGroups(dom.select), [
    { label: '3D', options: ['UMAP · 3D'] },
    { label: '2D', options: ['PCA (unintegrated) · 2D', 'UMAP · 2D', 't-SNE · 2D'] },
  ]);
  assert.equal(dom.select.value, 'X_umap_2d');
  assert.equal(dom.select.title, 'The 2D default of this dataset (UMAP).');
  assert.equal(dom.select.disabled, false);

  // One view open: the picker edits "the" view.
  state.activeViewId = 'live';
  controls.render();
  assert.equal(dom.label.textContent, 'Shows');
  assert.equal(dom.select.value, 'X_umap_3d');

  // No dataset layout published, or nothing enabled: nothing to pick.
  state.layouts.delete('live');
  controls.render();
  assert.equal(dom.controls.hidden, true);
  assert.deepEqual(dom.select.groups, []);
  state.layouts.set('live', 'X_umap_3d');
  state.representations = [];
  controls.render();
  assert.equal(dom.controls.hidden, true);
});

test('choosing a representation is the view.embedding.set action of the selected view', async t => {
  const { dom, fireChange } = installDom(t);
  const events = captureNotifications(t);
  const dispatched = recordDispatches(t);
  const { calls, state } = createState();
  let badgeCalls = 0;
  const controls = initRepresentationControls({
    state,
    viewer: VIEWER,
    dom,
    callbacks: {
      viewLabel: () => 'View 2',
      onViewBadgesMaybeChanged() {
        badgeCalls += 1;
      },
    },
  });
  t.after(() => controls.destroy());

  const switching = createDeferred();
  state.pending = switching.promise;
  fireChange('X_tsne');
  // While the view loads, the picker cannot start a second switch.
  assert.equal(dom.select.disabled, true);
  assert.equal(dom.select.title, 'Switching…');
  await settle();
  assert.deepEqual(dispatched, [
    ['view.embedding.set', { view: 'View 2', embedding: { key: 'X_tsne', columns: [0, 1] } }],
  ]);
  assert.deepEqual(calls, [
    ['setViewEmbeddingRef', 'snap_1', { key: 'X_tsne', columns: [0, 1] }],
  ]);
  switching.resolve();
  await settle();
  assert.equal(dom.select.disabled, false);
  assert.equal(dom.select.value, 'X_tsne');
  assert.equal(badgeCalls, 1);
  assert.deepEqual(events, []);

  // A refused switch says why and shows what the view still shows.
  state.pending = null;
  state.setViewEmbeddingRef = async () => {
    throw new RangeError('X_pca is not enabled for this dataset.');
  };
  fireChange('X_pca');
  await settle();
  assert.deepEqual(events, [
    ['error', 'X_pca is not enabled for this dataset.', { category: 'dimension' }],
  ]);
  assert.equal(dom.select.value, 'X_tsne');
  assert.equal(badgeCalls, 1);
});

test('an embedding without a data mapping name is chosen by its dimension when it is the default, else refused', async t => {
  const { dom, fireChange } = installDom(t);
  const events = captureNotifications(t);
  const dispatched = recordDispatches(t);
  const unnamed = [
    { layoutKey: '2d', dimension: 2, name: 'Generated', label: 'Generated', isDefault: true, ref: null },
    { layoutKey: 'extra', dimension: 2, name: 'Extra', label: 'Extra', isDefault: false, ref: null },
  ];
  const { calls, state } = createState({ layoutKey: 'extra', representations: unnamed });
  const controls = initRepresentationControls({
    state,
    viewer: VIEWER,
    dom,
    callbacks: { viewLabel: () => 'View 2', onViewBadgesMaybeChanged() {} },
  });
  t.after(() => controls.destroy());

  fireChange('2d');
  await settle();
  assert.deepEqual(dispatched, [['view.embedding.default', { view: 'View 2', dimension: 2 }]]);
  assert.deepEqual(calls, [['showDefaultRepresentation', 'snap_1', 2]]);
  assert.deepEqual(events, []);

  fireChange('extra');
  await settle();
  assert.equal(dispatched.length, 1, 'nothing is dispatched for an embedding a step cannot name');
  assert.deepEqual(events, [[
    'error',
    'Extra has no data mapping name a step could record; the 2 key steps through it.',
    { category: 'dimension' },
  ]]);
  assert.equal(dom.select.value, '2d');
});

test('agents and replays name the view and the embedding; unknown names are refused with a sentence', async t => {
  const { dom } = installDom(t);
  captureNotifications(t);
  const { calls, state } = createState();
  const controls = initRepresentationControls({
    state,
    viewer: VIEWER,
    dom,
    callbacks: { viewLabel: () => 'View 2', onViewBadgesMaybeChanged() {} },
  });
  t.after(() => controls.destroy());
  const actions = getActions();

  const set = await actions.dispatch('view.embedding.set', { view: 'View 1', embedding: { key: 'X_pca', columns: [0, 1] } });
  assert.deepEqual(set.outcome, { view: 'View 1' });
  assert.equal(state.layouts.get('live'), 'X_pca');
  const shown = await actions.dispatch('view.embedding.default', { view: 'View 2', dimension: 3 });
  assert.deepEqual(shown.outcome, { view: 'View 2', embedding: 'UMAP' });
  assert.equal(state.layouts.get('snap_1'), 'X_umap_3d');
  const cycled = await actions.dispatch('view.embedding.cycle', { view: 'View 2', dimension: 2 });
  assert.deepEqual(cycled.outcome, { view: 'View 2', embedding: 'UMAP', position: 2, count: 3 });
  assert.deepEqual(calls.map(call => call[0]), ['setViewEmbeddingRef', 'showDefaultRepresentation', 'cycleRepresentation']);

  await assert.rejects(
    actions.dispatch('view.embedding.set', { view: 'View 3', embedding: { key: 'X_pca', columns: [0, 1] } }),
    { name: 'ActionRefused', message: 'There is no View 3: 2 views are open (View 1 and View 2).' }
  );
  await assert.rejects(
    actions.dispatch('view.embedding.set', { view: 'View 1', embedding: { key: 'X_nope', columns: [0, 1] } }),
    { name: 'ActionRefused', message: "This dataset cannot plot obsm['X_nope']." }
  );
  await assert.rejects(
    actions.dispatch('view.embedding.cycle', { view: 'View 1', dimension: 1 }),
    { name: 'ActionRefused', message: 'No 1D embedding is on. Turn one on in Session › Data mapping.' }
  );
  assert.equal(calls.length, 4, 'only the refused embedding reached the state');
});

test('one enabled representation is named, not offered as a choice', t => {
  const { dom } = installDom(t);
  const { state } = createState({ representations: [REPRESENTATIONS[2]] });
  const controls = initRepresentationControls({
    state,
    viewer: VIEWER,
    dom,
    callbacks: { viewLabel: () => null, onViewBadgesMaybeChanged() {} },
  });
  t.after(() => controls.destroy());
  assert.equal(dom.controls.hidden, false);
  assert.equal(dom.select.disabled, true);
  assert.match(dom.select.title, /one embedding.*Session › Data mapping/);
});

test('keys 1, 2 and 3 step through a dimension and say where they are in the cycle', async t => {
  const { dom } = installDom(t);
  const events = captureNotifications(t);
  const dispatched = recordDispatches(t);
  const { calls, state } = createState();
  let badgeCalls = 0;
  const controls = initRepresentationControls({
    state,
    viewer: VIEWER,
    dom,
    callbacks: {
      viewLabel: () => 'View 2',
      onViewBadgesMaybeChanged() {
        badgeCalls += 1;
      },
    },
  });
  t.after(() => controls.destroy());

  await controls.cycle(2);
  await controls.cycle(2);
  await controls.cycle(3);
  assert.deepEqual(calls, [
    ['cycleRepresentation', 'snap_1', 2],
    ['cycleRepresentation', 'snap_1', 2],
    ['cycleRepresentation', 'snap_1', 3],
  ]);
  assert.deepEqual(dispatched, [
    ['view.embedding.cycle', { view: 'View 2', dimension: 2 }],
    ['view.embedding.cycle', { view: 'View 2', dimension: 2 }],
    ['view.embedding.cycle', { view: 'View 2', dimension: 3 }],
  ]);
  // Each notice replaces the one before it, so a burst of key presses leaves
  // one notice naming where the view is now.
  assert.deepEqual(events, [
    ['info', '2D · t-SNE (3 of 3)', { category: 'dimension', duration: 2200 }],
    ['dismiss', 'n1'],
    ['info', '2D · PCA (unintegrated) (1 of 3)', { category: 'dimension', duration: 2200 }],
    ['dismiss', 'n2'],
    ['info', '3D · UMAP', { category: 'dimension', duration: 2200 }],
  ]);
  assert.equal(badgeCalls, 3);
  assert.equal(dom.select.value, 'X_umap_3d');

  // A dimension with nothing enabled says where to turn one on, and moves
  // nothing.
  events.length = 0;
  await controls.cycle(1);
  assert.equal(calls.length, 3);
  assert.equal(dispatched.length, 3);
  assert.deepEqual(events, [[
    'info',
    'No 1D embedding is on. Turn one on in Session › Data mapping.',
    { category: 'dimension', duration: 2200 },
  ]]);
});

test('the picker follows every representation change and mapping change', t => {
  const { dom } = installDom(t);
  const { listeners, state } = createState();
  const controls = initRepresentationControls({
    state,
    viewer: VIEWER,
    dom,
    callbacks: { viewLabel: () => 'View 2', onViewBadgesMaybeChanged() {} },
  });
  t.after(() => controls.destroy());
  assert.deepEqual([...listeners.keys()].sort(), ['mapping:changed', 'view:representation-changed']);

  state.layouts.set('snap_1', 'X_pca');
  listeners.get('view:representation-changed')({ viewId: 'snap_1' });
  assert.equal(dom.select.value, 'X_pca');

  state.representations = REPRESENTATIONS.filter(item => item.layoutKey !== 'X_tsne');
  listeners.get('mapping:changed')({});
  assert.deepEqual(pickerGroups(dom.select)[1].options, ['PCA (unintegrated) · 2D', 'UMAP · 2D']);
});

test('teardown removes every listener and fences a switch still settling', async t => {
  const { dom, fireChange, listeners: domListeners } = installDom(t);
  const events = captureNotifications(t);
  const { listeners, state } = createState();
  let badgeCalls = 0;
  const controls = initRepresentationControls({
    state,
    viewer: VIEWER,
    dom,
    callbacks: {
      viewLabel: () => 'View 2',
      onViewBadgesMaybeChanged() {
        badgeCalls += 1;
      },
    },
  });
  const switching = createDeferred();
  state.pending = switching.promise;
  fireChange('X_tsne');
  // The action reached the state, which is still switching.
  await settle();

  controls.destroy();
  assert.equal(domListeners.every(({ signal }) => signal.aborted), true);
  assert.equal(listeners.size, 0, 'both state subscriptions are released');

  // The switch settles after teardown: the destroyed controls publish
  // nothing -- no badge refresh, no notice, no redraw.
  const valueAtTeardown = dom.select.value;
  switching.reject(new Error('late representation failure'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(badgeCalls, 0);
  assert.deepEqual(events, []);
  assert.equal(dom.select.value, valueAtTeardown);

  // Nothing after teardown reaches the state, and the actions are no longer
  // provided by the closed picker.
  const before = state.layouts.get('snap_1');
  await controls.cycle(2);
  fireChange('X_pca');
  assert.equal(state.layouts.get('snap_1'), before);
  for (const type of ['view.embedding.set', 'view.embedding.default', 'view.embedding.cycle']) {
    assert.equal(getActions().provided(type), false, type);
  }
});
