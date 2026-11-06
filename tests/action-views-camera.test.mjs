/**
 * View and camera actions (`app/actions/definitions/views.js`, `camera.js`):
 * views named as the Compare views list names them
 * (`app/actions/targets/views.js`), the camera actions the Navigation panel
 * implements (`ui/modules/camera-controls.js`), and a camera gesture recorded
 * by observation of the viewer's `camera-settled` publication, or, when an
 * action on the cameras starts while it still moves, ahead of that action.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getActionCatalog, getActions } from '../assets/js/app/actions/index.js';
import { ActionRefused } from '../assets/js/app/actions/dispatcher.js';
import { openViewIds, resolveViewName, viewNameAt, viewNameInValue, viewNameOf } from '../assets/js/app/actions/targets/views.js';
import { initCameraControls } from '../assets/js/app/ui/modules/camera-controls.js';
import { createDefaultCameraPose } from '../assets/js/rendering/camera-state-contract.js';

function fakeViews({ hidden = false, snapshots = ['snap_1', 'snap_4'] } = {}) {
  return {
    getLiveViewHidden: () => hidden,
    getSnapshotViews: () => snapshots.map(id => ({ id, label: id })),
  };
}

test('a view is named "View N", as the Compare views list numbers its rows', () => {
  const shown = fakeViews();
  assert.deepEqual(openViewIds(shown), ['live', 'snap_1', 'snap_4']);
  assert.equal(viewNameOf(shown, 'live'), 'View 1', 'the live view is View 1 while it is shown');
  assert.equal(viewNameOf(shown, 'snap_1'), 'View 2');
  assert.equal(viewNameOf(shown, 'snap_4'), 'View 3');
  assert.equal(resolveViewName(shown, 'View 1'), 'live');
  assert.equal(resolveViewName(shown, 'View 3'), 'snap_4');
  assert.throws(() => viewNameOf(shown, 'snap_9'), /View "snap_9" is not open/);
  assert.equal(viewNameAt(0), 'View 1');
  assert.equal(viewNameAt(11), 'View 12');
  assert.throws(() => viewNameAt(-1), RangeError);

  // "live" is not a name: one view has one name.
  assert.throws(() => resolveViewName(shown, 'live'), error => (
    error instanceof ActionRefused
    && error.message === '"live" names no view; 3 views are open (View 1 to View 3).'
  ));

  // With the live view hidden the rows move up, and the live view has no row.
  const hidden = fakeViews({ hidden: true });
  assert.equal(viewNameOf(hidden, 'snap_1'), 'View 1');
  assert.equal(resolveViewName(hidden, 'View 2'), 'snap_4');
  assert.throws(() => viewNameOf(hidden, 'live'), /View "live" is not open/);
  assert.throws(() => resolveViewName(shown, 'View 4'), error => (
    error instanceof ActionRefused && error.message === 'There is no View 4: 3 views are open (View 1 to View 3).'
  ));
  assert.throws(() => resolveViewName(fakeViews({ snapshots: ['snap_2'] }), 'View 3'), {
    message: 'There is no View 3: 2 views are open (View 1 and View 2).',
  });
  assert.throws(() => resolveViewName(fakeViews({ snapshots: [] }), 'View 2'), {
    message: 'There is no View 2: 1 view is open (View 1).',
  });

  // A per-view value lists the live view first even while it is hidden.
  assert.deepEqual([0, 1, 2].map(index => viewNameInValue(index, false)), ['View 1', 'View 2', 'View 3']);
  assert.deepEqual([0, 1, 2].map(index => viewNameInValue(index, true)), ['the hidden live view', 'View 1', 'View 2']);
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEW_NAMES_OWNER = path.join('assets', 'js', 'app', 'actions', 'targets', 'views.js');

function scripts(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return scripts(full);
    return /\.m?js$/.test(entry.name) ? [full] : [];
  });
}

test('one module names views: nothing else spells "View N" or "the live view" for a view', () => {
  // A view's name is made only by `viewNameAt` (and what calls it), so the
  // views list, a step's label, a refusal and a comparison line agree.
  const spellings = [/`View \$\{/, /['"]View ['"]\s*\+/, /['"`]the live view['"`]/];
  const offenders = [];
  for (const file of scripts(path.join(ROOT, 'assets', 'js'))) {
    const relative = path.relative(ROOT, file);
    if (relative === VIEW_NAMES_OWNER) continue;
    const text = readFileSync(file, 'utf8');
    for (const pattern of spellings) {
      const match = pattern.exec(text);
      if (match !== null) offenders.push(`${relative}:${text.slice(0, match.index).split('\n').length}`);
    }
  }
  assert.deepEqual(offenders, [], 'name a view with viewNameAt / viewNameOf / viewNameInValue (app/actions/targets/views.js)');
});

test('view and camera definitions: names in params, sentences a person reads, one pseudocode line', () => {
  const catalog = getActionCatalog();
  assert.equal(catalog.get('view.focus').params.properties.view.pattern, '^View [1-9][0-9]*$');
  assert.throws(() => catalog.check('view.focus', { view: 'live' }), /does not have the expected form/);
  assert.throws(() => catalog.check('view.focus', { view: 'View 0' }), /does not have the expected form/);
  assert.throws(() => catalog.check('view.focus', { view: 'snap_1' }), /does not have the expected form/);
  assert.throws(() => catalog.check('camera.navigation.set', { view: 'View 1', mode: 'fly' }), /must be one of/);
  assert.throws(
    () => catalog.check('view.embedding.set', { view: 'View 1', embedding: { key: 'X_umap', columns: [0, 0] } }),
    /must not repeat/
  );
  const camera = { navigationMode: 'orbit', ...createDefaultCameraPose() };
  camera.orbit = { ...camera.orbit, targetRadius: camera.orbit.radius };
  assert.equal(catalog.check('camera.set', { view: 'View 2', camera }).type, 'camera.set');

  const cases = [
    ['view.keep', {}, { view: 'View 2' }, 'Kept the view as View 2', 'keep_view()'],
    ['view.remove', { view: 'View 1' }, null, 'Removed View 1', 'remove_view("View 1")'],
    ['view.clear', {}, { views: 2 }, 'Removed every kept view (2 views)', 'clear_views()'],
    ['view.layout.set', { layout: 'single' }, null, 'Showed the selected view alone', 'set_view_layout("single")'],
    ['view.focus', { view: 'View 3' }, null, 'Selected View 3', 'select_view("View 3")'],
    ['view.cameras.link', { linked: true }, null, 'Linked the cameras of views of one embedding', 'link_cameras(True)'],
    ['view.embedding.set', { view: 'View 1', embedding: { key: 'X_pca', columns: [0, 1] } }, null,
      'Showed obsm["X_pca"] [0, 1] in View 1', 'show_embedding("View 1", "X_pca", [0, 1])'],
    ['view.embedding.cycle', { view: 'View 2', dimension: 2 }, { embedding: 't-SNE' }, 'Showed t-SNE in View 2', 'next_embedding("View 2", 2)'],
    ['cells.visibility.set', { cells: [3, 1], visible: false }, { cells: 2 }, 'Hid 2 cells', 'set_visibility(<2 cells>, visible=False)'],
    ['camera.set', { view: 'View 2', camera }, null, 'Moved the camera of View 2', 'set_camera("View 2", <camera>)'],
    ['camera.reset', { view: 'View 1' }, null, 'Reset the camera of View 1', 'reset_camera("View 1")'],
    ['camera.navigation.set', { view: 'View 1', mode: 'free' }, null, 'Navigated View 1 by free-fly', 'set_navigation_mode("View 1", "free")'],
    ['display.reset', {}, null, 'Reset the camera and display', 'reset_display()'],
  ];
  for (const [type, params, outcome, sentence, code] of cases) {
    const definition = catalog.check(type, params);
    assert.equal(definition.describe(params, outcome), sentence, type);
    assert.equal(definition.code(params), code, type);
  }
  // A camera gesture and the gestures after it on the same view are one step;
  // clicking through panes is one step.
  assert.equal(catalog.get('camera.set').coalesce({ view: 'View 2', camera }), 'View 2');
  assert.equal(catalog.get('view.focus').coalesce({ view: 'View 1' }), 'focus');
  assert.deepEqual(catalog.get('view.keep').touches, ['views', 'active-field', 'filters', 'colors', 'visibility', 'camera']);
  assert.deepEqual(catalog.get('display.reset').touches, ['camera', 'settings']);
});

function createControl({ checked = false, value = '' } = {}) {
  const listeners = new Map();
  return {
    checked,
    style: {},
    value,
    addEventListener(type, listener, options = {}) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
      options.signal?.addEventListener('abort', () => {
        listeners.set(type, listeners.get(type).filter(candidate => candidate !== listener));
      }, { once: true });
    },
    blur() {},
    dispatch(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ target: this });
    },
  };
}

function cameraAt(radius, mode = 'orbit') {
  const pose = createDefaultCameraPose();
  return { navigationMode: mode, orbit: { ...pose.orbit, radius, targetRadius: radius }, freefly: pose.freefly };
}

/** The Navigation panel over a viewer of a live view and one kept view. */
function mountCameraControls(t) {
  const dom = {};
  for (const key of [
    'freeflyControls', 'orbitControls', 'planarControls', 'lookSensitivityDisplay', 'moveSpeedDisplay',
    'invertLookCheckbox', 'projectilesEnabledCheckbox', 'pointerLockCheckbox', 'orbitKeySpeedDisplay',
    'planarPanSpeedDisplay', 'orbitReverseCheckbox', 'showOrbitAnchorCheckbox', 'planarZoomToCursorCheckbox',
    'planarInvertAxesCheckbox',
  ]) dom[key] = createControl();
  dom.navigationModeSelect = createControl({ value: 'orbit' });
  dom.lookSensitivityInput = createControl({ value: '10' });
  dom.moveSpeedInput = createControl({ value: '100' });
  dom.orbitKeySpeedInput = createControl({ value: '50' });
  dom.planarPanSpeedInput = createControl({ value: '50' });

  const calls = [];
  const presented = new Set();
  const modes = new Map([['live', 'orbit'], ['snap_1', 'orbit']]);
  const cameras = new Map([['live', cameraAt(3)], ['snap_1', cameraAt(4)]]);
  const viewer = {
    focusedViewId: 'live',
    ...fakeViews({ snapshots: ['snap_1'] }),
    getFocusedViewId() { return this.focusedViewId; },
    getNavigationMode() { return modes.get(this.focusedViewId); },
    getViewNavigationMode: viewId => modes.get(viewId),
    getCamerasLocked: () => false,
    getViewCameraState: viewId => structuredClone(cameras.get(viewId)),
    setNavigationMode(mode) { calls.push(['setNavigationMode', mode]); modes.set(this.focusedViewId, mode); },
    setViewNavigationMode(viewId, mode) { calls.push(['setViewNavigationMode', viewId, mode]); modes.set(viewId, mode); },
    setViewCameraState(viewId, camera) { calls.push(['setViewCameraState', viewId, camera]); cameras.set(viewId, structuredClone(camera)); },
    resetCamera() { calls.push(['resetCamera']); },
    moving: false,
    isCameraInMotion() { return this.moving; },
    stopInertia() { calls.push(['stopInertia']); this.moving = false; },
    onPresentedViewStateChanged(listener) {
      presented.add(listener);
      return () => presented.delete(listener);
    },
    publish(event) { for (const listener of [...presented]) listener(event); },
  };
  for (const method of [
    'setInvertLookX', 'setInvertLookY', 'setLookSensitivity', 'setMoveSpeed', 'setOrbitInvertRotation',
    'setOrbitKeySpeed', 'setPlanarInvertAxes', 'setPlanarPanSpeed', 'setPlanarZoomToCursor',
    'setPointerLockChangeHandler', 'setPointerLockEnabled', 'setProjectilesEnabled', 'setShowOrbitAnchor',
  ]) viewer[method] = (...args) => calls.push([method, ...args]);
  viewer.isProjectileSpatialIndexReady = () => true;

  const badgeCalls = [];
  const controls = initCameraControls({
    viewer,
    dom,
    callbacks: { onViewBadgesMaybeChanged: () => badgeCalls.push('badges') },
  });
  t.after(() => controls.destroy());
  calls.length = 0;
  return { badgeCalls, calls, cameras, controls, dom, modes, presented, viewer };
}

test('camera actions act on the view they name; a bad name or camera is refused and changes nothing', async t => {
  const { badgeCalls, calls, cameras, dom, modes } = mountCameraControls(t);
  const actions = getActions();

  // The focused view's mode is the panel's: select, settings box, pointer.
  await actions.dispatch('camera.navigation.set', { view: 'View 1', mode: 'planar' });
  assert.deepEqual(calls, [['setNavigationMode', 'planar'], ['setPointerLockEnabled', false]]);
  assert.equal(dom.navigationModeSelect.value, 'planar');
  // Another view's mode is its own.
  calls.length = 0;
  await actions.dispatch('camera.navigation.set', { view: 'View 2', mode: 'free' });
  assert.deepEqual(calls, [['setViewNavigationMode', 'snap_1', 'free']]);
  assert.equal(modes.get('snap_1'), 'free');
  assert.equal(dom.navigationModeSelect.value, 'planar', 'the panel shows the focused view');
  assert.equal(badgeCalls.length, 2);

  calls.length = 0;
  const camera = cameraAt(9, 'planar');
  const { outcome } = await actions.dispatch('camera.set', { view: 'View 2', camera });
  assert.deepEqual(outcome, { view: 'View 2' });
  assert.deepEqual(cameras.get('snap_1'), camera);

  // Reset: the focused view through the viewer's own reset (it also lets go
  // of the pointer and the projectiles); another view to the starting pose
  // in its own mode.
  calls.length = 0;
  await actions.dispatch('camera.reset', { view: 'View 1' });
  assert.deepEqual(calls, [['resetCamera']]);
  calls.length = 0;
  await actions.dispatch('camera.reset', { view: 'View 2' });
  const pose = createDefaultCameraPose();
  assert.deepEqual(cameras.get('snap_1'), {
    navigationMode: 'free',
    orbit: { ...pose.orbit, targetRadius: pose.orbit.radius },
    freefly: pose.freefly,
  });

  calls.length = 0;
  await assert.rejects(actions.dispatch('camera.reset', { view: 'View 3' }), {
    name: 'ActionRefused', message: 'There is no View 3: 2 views are open (View 1 and View 2).',
  });
  const flat = cameraAt(1);
  flat.orbit.radius = 0;
  await assert.rejects(actions.dispatch('camera.set', { view: 'View 1', camera: flat }), /must be more than 0/);
  assert.deepEqual(calls, []);
});

test('the mode select dispatches camera.navigation.set for the focused view, with its exact value', async t => {
  const { calls, dom, viewer } = mountCameraControls(t);
  const dispatched = [];
  t.after(getActions().subscribe(event => {
    if (event.kind === 'start') dispatched.push([event.type, event.params]);
  }));
  viewer.focusedViewId = 'snap_1';
  dom.navigationModeSelect.value = 'free';
  dom.navigationModeSelect.dispatch('change');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(dispatched, [['camera.navigation.set', { view: 'View 2', mode: 'free' }]]);
  assert.deepEqual(calls, [['setNavigationMode', 'free']]);
});

test('a camera gesture is one observed camera.set naming the view and the camera it settled at', async t => {
  const { presented, viewer, controls } = mountCameraControls(t);
  const observed = [];
  const actions = getActions();
  actions.setRecorder({
    before: async () => null,
    after: async () => null,
    failed: async () => {},
    async observed({ definition, params, meta }) {
      observed.push([definition.type, params, meta.origin]);
      return null;
    },
  });
  t.after(() => actions.setRecorder(null));

  viewer.focusedViewId = 'snap_1';
  // A gesture's burst, other publications and the settle: one record.
  viewer.publish({ reason: 'camera-changing', viewId: 'snap_1' });
  viewer.publish({ reason: 'camera', viewId: 'snap_1' });
  viewer.publish({ reason: 'camera-settled', viewId: 'snap_1' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(observed, [['camera.set', { view: 'View 2', camera: cameraAt(4) }, 'user']]);

  // A settle for a view no longer open records nothing and throws nothing.
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    viewer.publish({ reason: 'camera-settled', viewId: 'snap_9' });
  } finally {
    console.error = originalError;
  }
  assert.equal(observed.length, 1);
  assert.equal(errors.length, 1);

  controls.destroy();
  assert.equal(presented.size, 0);
  for (const type of ['camera.set', 'camera.reset', 'camera.navigation.set']) {
    assert.equal(actions.provided(type), false, `${type} is withdrawn with the panel`);
  }
});

test('an action on the cameras that starts while the camera still moves records the gesture first, stopped where it is', async t => {
  const { calls, viewer, controls } = mountCameraControls(t);
  const order = [];
  const actions = getActions();
  actions.setRecorder({
    async before({ definition }) { order.push(['before', definition.type]); return null; },
    after: async () => null,
    failed: async () => {},
    async observed({ definition, params }) {
      order.push(['observed', definition.type, params.view]);
      return null;
    },
  });
  t.after(() => actions.setRecorder(null));

  // At rest: an action on the cameras starts as it is.
  await actions.dispatch('camera.navigation.set', { view: 'View 1', mode: 'planar' });
  assert.deepEqual(order, [['before', 'camera.navigation.set']]);
  assert.equal(calls.some(([name]) => name === 'stopInertia'), false);

  // Still gliding (W pressed, O right after it): the glide stops where it is
  // shown and is recorded before the action's history step begins.
  order.length = 0;
  calls.length = 0;
  viewer.moving = true;
  await actions.dispatch('camera.navigation.set', { view: 'View 1', mode: 'orbit' });
  assert.deepEqual(order, [['observed', 'camera.set', 'View 1'], ['before', 'camera.navigation.set']]);
  assert.deepEqual(calls[0], ['stopInertia']);

  // An action on other state, a read, and the history's own re-application
  // of a step leave a moving camera alone.
  order.length = 0;
  calls.length = 0;
  viewer.moving = true;
  t.after(actions.provide('layout.theme.set', () => null));
  await actions.dispatch('layout.theme.set', { theme: 'dark' });
  await actions.dispatch('camera.navigation.set', { view: 'View 1', mode: 'planar' }, { origin: 'replay', internal: true, rewrite: 's1' });
  assert.deepEqual(order, [['before', 'layout.theme.set'], ['before', 'camera.navigation.set']]);
  assert.equal(calls.some(([name]) => name === 'stopInertia'), false);

  controls.destroy();
  order.length = 0;
  await assert.rejects(actions.dispatch('camera.reset', { view: 'View 1' }), /not available/);
  assert.equal(viewer.moving, true, 'a closed panel stops nothing');
});
