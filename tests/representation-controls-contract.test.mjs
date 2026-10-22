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
  Object.freeze({ layoutKey: 'X_umap_3d', dimension: 3, name: 'UMAP', label: 'UMAP', isDefault: true }),
  Object.freeze({ layoutKey: 'X_pca', dimension: 2, name: 'PCA (unintegrated)', label: 'PCA (unintegrated)', isDefault: false }),
  Object.freeze({ layoutKey: 'X_umap_2d', dimension: 2, name: 'UMAP', label: 'UMAP', isDefault: true }),
  Object.freeze({ layoutKey: 'X_tsne', dimension: 2, name: 't-SNE', label: 't-SNE', isDefault: false }),
]);

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
    async setViewRepresentation(viewId, nextLayoutKey, options) {
      calls.push(['setViewRepresentation', viewId, nextLayoutKey, options]);
      if (this.pending !== null) await this.pending;
      this.layouts.set(viewId, nextLayoutKey);
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

test('choosing a representation switches the selected view as an explicit choice', async t => {
  const { dom, fireChange } = installDom(t);
  const events = captureNotifications(t);
  const { calls, state } = createState();
  let badgeCalls = 0;
  const controls = initRepresentationControls({
    state,
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
  assert.deepEqual(calls, [
    ['setViewRepresentation', 'snap_1', 'X_tsne', { followsDefault: false }],
  ]);
  // While the view loads, the picker cannot start a second switch.
  assert.equal(dom.select.disabled, true);
  assert.equal(dom.select.title, 'Switching…');
  switching.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(dom.select.disabled, false);
  assert.equal(dom.select.value, 'X_tsne');
  assert.equal(badgeCalls, 1);
  assert.deepEqual(events, []);

  // A refused switch says why and shows what the view still shows.
  state.pending = null;
  state.setViewRepresentation = async () => {
    throw new Error('X_pca is not enabled for this dataset.');
  };
  fireChange('X_pca');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(events, [
    ['error', 'X_pca is not enabled for this dataset.', { category: 'dimension' }],
  ]);
  assert.equal(dom.select.value, 'X_tsne');
  assert.equal(badgeCalls, 1);
});

test('one enabled representation is named, not offered as a choice', t => {
  const { dom } = installDom(t);
  const { state } = createState({ representations: [REPRESENTATIONS[2]] });
  const controls = initRepresentationControls({
    state,
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
  const { calls, state } = createState();
  let badgeCalls = 0;
  const controls = initRepresentationControls({
    state,
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

  // Nothing after teardown reaches the state.
  const before = state.layouts.get('snap_1');
  await controls.cycle(2);
  fireChange('X_pca');
  assert.equal(state.layouts.get('snap_1'), before);
});
