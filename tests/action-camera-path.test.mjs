/**
 * Camera path actions (`app/actions/definitions/camera.js`, implemented by
 * `app/ui/modules/cinematic-camera/index.js`): keyframes named by unique
 * labels, every action's exact effect on the keyframe store and the playback
 * controls, each refusal's sentence, the controls dispatching exactly one
 * action with exact parameters, and a restore dispatching none.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createKeyframeStore } from '../assets/js/app/ui/modules/cinematic-camera/keyframe-store.js';
import { getActions } from '../assets/js/app/actions/index.js';
import { ActionRefused } from '../assets/js/app/actions/dispatcher.js';
import {
  destroyMounted,
  installModuleEnvironment,
  mountCinematicCamera
} from './helpers/cinematic-camera-harness.mjs';

const LOOP_BACK = '↩ Return to start';

function camera(index, navigationMode = 'orbit') {
  return {
    navigationMode,
    orbit: { radius: 3 + index, targetRadius: 3 + index, theta: 0.25 * index, phi: 0.75, target: [index, 0, 0] },
    freefly: { position: [index, 0, 3 + index], yaw: -Math.PI / 2 + index, pitch: 0.1 * index }
  };
}

function labels(module) {
  return module.camera.getKeyframeStore().getAll().map(kf => kf.label);
}

function dispatch(type, params) {
  return getActions().dispatch(type, params);
}

/** Every action dispatched while `run` runs, as {type, params}. */
async function dispatchedDuring(run) {
  const events = [];
  const unsubscribe = getActions().subscribe(event => {
    if (event.kind === 'start') events.push({ type: event.type, params: structuredClone(event.params) });
  });
  try {
    await run();
    await getActions().idle();
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally {
    unsubscribe();
  }
  return events;
}

/**
 * The changes recorded by observation while `run` runs (a control that is
 * its own setting: the history records the step from its event), and the
 * actions dispatched meanwhile, as {type, params}.
 */
async function observedDuring(run) {
  const observed = [];
  const actions = getActions();
  actions.setRecorder({
    before: () => null,
    after: () => null,
    failed: () => undefined,
    observed: ({ definition, params }) => {
      observed.push({ type: definition.type, params: structuredClone(params) });
      return Promise.resolve(null);
    },
  });
  try {
    const dispatched = await dispatchedDuring(run);
    return { observed, dispatched };
  } finally {
    actions.setRecorder(null);
  }
}

/** Run `body` with one mounted Camera Path in a module environment. */
async function withCameraPath(body, options) {
  const environment = installModuleEnvironment();
  try {
    const module = mountCinematicCamera(options);
    await body(module, environment);
  } finally {
    destroyMounted();
    environment.restore();
  }
}

async function addKeyframes(count) {
  for (let index = 0; index < count; index++) {
    await dispatch('camera-path.keyframe.add', { camera: camera(index) });
  }
}

test('keyframe labels are unique: a default label skips labels in use, add and rename refuse one in use', () => {
  const store = createKeyframeStore();
  const first = store.add(camera(0), undefined, null);
  store.rename(first, 'KF 2');
  const second = store.add(camera(1), undefined, null);
  assert.deepEqual(store.getAll().map(kf => kf.label), ['KF 2', 'KF 3'],
    'the default "KF 2" is someone\'s already, so the next default is "KF 3"');
  assert.throws(() => store.add(camera(2), 'KF 3', null), /labelled "KF 3" already/);
  assert.throws(() => store.rename(first, 'KF 3'), /labelled "KF 3" already/);
  store.rename(second, 'KF 3');
  assert.equal(store.getById(second).label, 'KF 3', 'a keyframe keeps its own label');
  assert.equal(store.getCount(), 2, 'a refused add adds nothing');
});

test('camera-path.keyframe.add saves the named camera, label and embedding, before the return to start', async () => {
  const embedding = { key: 'X_umap', columns: [0, 1] };
  await withCameraPath(async module => {
    const made = await dispatch('camera-path.keyframe.add', { camera: camera(1, 'planar'), label: 'Overview', embedding });
    assert.deepEqual(made.outcome, { keyframe: 'Overview' });
    const [kf] = module.camera.getKeyframeStore().getAll();
    assert.deepEqual(
      { navigationMode: kf.navigationMode, orbit: { ...kf.orbit, target: [...kf.orbit.target] }, freefly: { ...kf.freefly, position: [...kf.freefly.position] } },
      camera(1, 'planar')
    );
    assert.deepEqual({ key: kf.representation.key, columns: [...kf.representation.columns] }, embedding);

    // Omitted: the viewer's camera now, the focused view's embedding, "KF n".
    module.viewer.place(4, 'free');
    const omitted = await dispatch('camera-path.keyframe.add', {});
    assert.deepEqual(omitted.outcome, { keyframe: 'KF 1' });
    const second = module.camera.getKeyframeStore().getAll()[1];
    assert.equal(second.navigationMode, 'free');
    assert.equal(second.orbit.radius, 7);
    assert.deepEqual(second.representation, null);

    await dispatch('camera-path.loop-back.set', { enabled: true });
    assert.deepEqual(labels(module), ['Overview', 'KF 1', LOOP_BACK]);
    await dispatch('camera-path.keyframe.add', { camera: camera(2) });
    assert.deepEqual(labels(module), ['Overview', 'KF 1', 'KF 2', LOOP_BACK],
      'a new keyframe goes before the return to start');

    await assert.rejects(
      dispatch('camera-path.keyframe.add', { camera: camera(3), label: 'Overview' }),
      error => error instanceof ActionRefused && error.message === 'A keyframe is labelled "Overview" already; choose another label.'
    );
    await assert.rejects(
      dispatch('camera-path.keyframe.add', { camera: camera(3), label: LOOP_BACK }),
      error => error instanceof ActionRefused && /names the return to the first keyframe/.test(error.message)
    );
    assert.equal(module.camera.getKeyframeStore().getCount(), 4, 'a refused add saves nothing');
  }, { focusedRepresentation: () => null });
});

test('camera-path.keyframe.remove, move and rename name keyframes by label, and refuse what cannot be', async () => {
  await withCameraPath(async module => {
    await addKeyframes(3);
    assert.deepEqual(labels(module), ['KF 1', 'KF 2', 'KF 3']);

    assert.deepEqual((await dispatch('camera-path.keyframe.move', { keyframe: 'KF 3', direction: 'up' })).outcome, { keyframe: 'KF 3' });
    assert.deepEqual(labels(module), ['KF 1', 'KF 3', 'KF 2']);
    await dispatch('camera-path.keyframe.move', { keyframe: 'KF 1', direction: 'down' });
    assert.deepEqual(labels(module), ['KF 3', 'KF 1', 'KF 2']);
    await assert.rejects(
      dispatch('camera-path.keyframe.move', { keyframe: 'KF 3', direction: 'up' }),
      { name: 'ActionRefused', message: '"KF 3" is the first keyframe already.' }
    );
    await assert.rejects(
      dispatch('camera-path.keyframe.move', { keyframe: 'KF 2', direction: 'down' }),
      { name: 'ActionRefused', message: '"KF 2" is the last keyframe already.' }
    );

    await dispatch('camera-path.keyframe.rename', { keyframe: 'KF 1', label: 'Close-up' });
    assert.deepEqual(labels(module), ['KF 3', 'Close-up', 'KF 2']);
    assert.equal((await dispatch('camera-path.keyframe.rename', { keyframe: 'KF 2', label: 'KF 2' })).outcome, null,
      'renaming to its own label changes nothing');
    await assert.rejects(
      dispatch('camera-path.keyframe.rename', { keyframe: 'KF 2', label: 'Close-up' }),
      { name: 'ActionRefused', message: 'A keyframe is labelled "Close-up" already; choose another label.' }
    );
    await assert.rejects(
      dispatch('camera-path.keyframe.remove', { keyframe: 'KF 9' }),
      { name: 'ActionRefused', message: 'There is no keyframe "KF 9"; its keyframes are "KF 3", "Close-up" and "KF 2".' }
    );

    // The return to start follows its toggle: it is not edited, and nothing moves past it.
    await dispatch('camera-path.loop-back.set', { enabled: true });
    for (const [type, params] of [
      ['camera-path.keyframe.remove', { keyframe: LOOP_BACK }],
      ['camera-path.keyframe.move', { keyframe: LOOP_BACK, direction: 'up' }],
      ['camera-path.keyframe.rename', { keyframe: LOOP_BACK, label: 'Back' }]
    ]) {
      await assert.rejects(dispatch(type, params), error => (
        error instanceof ActionRefused && /The return to the first keyframe cannot be/.test(error.message)
      ), type);
    }
    await assert.rejects(
      dispatch('camera-path.keyframe.move', { keyframe: 'KF 2', direction: 'down' }),
      { name: 'ActionRefused', message: '"KF 2" is the last keyframe before the return to start already.' }
    );

    await dispatch('camera-path.keyframe.remove', { keyframe: 'Close-up' });
    assert.deepEqual(labels(module), ['KF 3', 'KF 2', LOOP_BACK]);
    // Fewer than two keyframes of the person's own: the return to start goes too.
    await dispatch('camera-path.keyframe.remove', { keyframe: 'KF 3' });
    assert.deepEqual(labels(module), ['KF 2']);
    assert.equal(module.camera.exportPath().loopBackKeyframeId, null);
  });
});

test('camera-path.keyframe.* refuses a label two restored keyframes share', async () => {
  await withCameraPath(async module => {
    await addKeyframes(2);
    const saved = module.camera.exportPath();
    saved.keyframes[1].label = saved.keyframes[0].label;
    module.camera.restorePath(saved);
    await assert.rejects(
      dispatch('camera-path.keyframe.remove', { keyframe: 'KF 1' }),
      { name: 'ActionRefused', message: '2 keyframes are labelled "KF 1"; rename all but one first.' }
    );
  });
});

test('camera-path.duration.set times one transition or every one; the last keyframe starts none', async () => {
  await withCameraPath(async module => {
    await addKeyframes(1);
    await assert.rejects(
      dispatch('camera-path.duration.set', { seconds: 2 }),
      { name: 'ActionRefused', message: 'A transition needs two keyframes; save another camera position first.' }
    );
    await addKeyframes(2);
    const durations = () => module.camera.getKeyframeStore().getAll().map(kf => kf.transitionDuration);
    assert.deepEqual((await dispatch('camera-path.duration.set', { keyframe: 'KF 2', seconds: 2.5 })).outcome, { keyframe: 'KF 2' });
    assert.deepEqual(durations(), [null, 2.5, null]);
    await assert.rejects(
      dispatch('camera-path.duration.set', { keyframe: 'KF 3', seconds: 1 }),
      { name: 'ActionRefused', message: 'No transition starts at "KF 3": it is the last keyframe.' }
    );
    assert.deepEqual((await dispatch('camera-path.duration.set', { seconds: 1.5 })).outcome, { keyframes: 3 });
    assert.deepEqual(durations(), [1.5, 1.5, 1.5]);
    await dispatch('camera-path.duration.set', { keyframe: 'KF 1', seconds: null });
    assert.deepEqual(durations(), [null, 1.5, 1.5]);
    await assert.rejects(dispatch('camera-path.duration.set', { keyframe: 'KF 1', seconds: 0.05 }), /at least 0\.1/);
  });
});

test('camera-path.loop-back.set needs two keyframes; camera-path.clear stops playback where the camera is', async () => {
  await withCameraPath(async module => {
    await addKeyframes(1);
    await assert.rejects(
      dispatch('camera-path.loop-back.set', { enabled: true }),
      { name: 'ActionRefused', message: 'A return to the first keyframe needs two keyframes; save another camera position first.' }
    );
    await addKeyframes(1);
    await dispatch('camera-path.loop-back.set', { enabled: true });
    assert.deepEqual(labels(module), ['KF 1', 'KF 2', LOOP_BACK]);
    assert.equal(module.camera.exportPath().loopBackKeyframeId, module.camera.getKeyframeStore().getAll()[2].id);
    await dispatch('camera-path.loop-back.set', { enabled: true });
    assert.equal(module.camera.getKeyframeStore().getCount(), 3, 'turning it on twice adds one return');
    await dispatch('camera-path.loop-back.set', { enabled: false });
    assert.deepEqual(labels(module), ['KF 1', 'KF 2']);

    module.viewer.place(9, 'orbit');
    const before = module.viewer.getCameraState();
    module.camera.getPlaybackController().play();
    module.viewer.place(9, 'orbit');
    const cleared = await dispatch('camera-path.clear', {});
    assert.deepEqual(cleared.outcome, { keyframes: 2 });
    assert.equal(module.camera.getPlaybackController().getState(), 'STOPPED');
    assert.deepEqual(module.viewer.getCameraState(), before, 'clearing the path does not move the camera');
    assert.deepEqual(labels(module), []);
    assert.equal((await dispatch('camera-path.clear', {})).outcome, null, 'an empty path clears nothing');
  });
});

test('camera-path.playback.set sets each playback control as a person would', async () => {
  await withCameraPath(async module => {
    const { dom } = module;
    await dispatch('camera-path.playback.set', {
      position_interpolation: 'bezier', rotation_interpolation: 'linear', easing: 'ease-out', speed: 80, loop: true,
    });
    assert.equal(dom.positionInterp.value, 'bezier');
    assert.equal(dom.rotationInterp.value, 'linear');
    assert.equal(dom.easingSelect.value, 'ease-out');
    assert.equal(dom.defaultSpeedInput.value, '80');
    assert.equal(dom.defaultSpeedDisplay.textContent, 'Very fast');
    assert.equal(dom.loopCheckbox.checked, true);
    const saved = module.camera.exportPath();
    assert.deepEqual(
      [saved.positionMethod, saved.rotationMethod, saved.easing, saved.defaultSpeed, saved.loopPlayback],
      ['bezier', 'linear', 'ease-out', '80', true]
    );

    // Autoplay on starts a path that is ready.
    await addKeyframes(2);
    assert.equal(module.camera.getPlaybackController().getState(), 'STOPPED');
    await dispatch('camera-path.playback.set', { autoplay: true });
    assert.equal(dom.autoplayCheckbox.checked, true);
    assert.equal(module.camera.getPlaybackController().getState(), 'PLAYING');
    await assert.rejects(dispatch('camera-path.playback.set', { easing: 'bounce' }), /must be one of/);
  });
});

test('each control makes exactly one step with exact parameters, dispatched or recorded from its own event; a restore makes none', async () => {
  await withCameraPath(async module => {
    const { dom, viewer } = module;
    viewer.place(2, 'planar');
    const saveEvents = await dispatchedDuring(() => dom.saveBtn.listeners('click')[0]());
    assert.deepEqual(saveEvents, [{
      type: 'camera-path.keyframe.add',
      params: { camera: camera(2, 'planar'), embedding: null }
    }]);

    // The playback controls are their own settings (the camera-path value
    // reads them): a person's change is made by the control and recorded
    // from its event as the action's step, never dispatched after it (which
    // would find nothing to change and leave the change outside the history).
    dom.defaultSpeedInput.value = '61';
    const speed = await observedDuring(() => dom.defaultSpeedInput.dispatchEvent({ type: 'input' }));
    assert.deepEqual(speed, { observed: [{ type: 'camera-path.playback.set', params: { speed: 61 } }], dispatched: [] });
    assert.equal(dom.defaultSpeedDisplay.textContent, 'Fast');
    assert.equal(module.camera.exportPath().defaultSpeed, '61', 'the value recorded is the one the control holds');

    for (const [element, value, params, key] of [
      [dom.positionInterp, 'linear', { position_interpolation: 'linear' }, 'positionMethod'],
      [dom.rotationInterp, 'linear', { rotation_interpolation: 'linear' }, 'rotationMethod'],
      [dom.easingSelect, 'ease-in', { easing: 'ease-in' }, 'easing'],
    ]) {
      element.value = value;
      assert.deepEqual(
        await observedDuring(() => element.dispatchEvent({ type: 'change' })),
        { observed: [{ type: 'camera-path.playback.set', params }], dispatched: [] }
      );
      assert.equal(module.camera.exportPath()[key], value);
    }
    dom.loopCheckbox.checked = true;
    assert.deepEqual(
      await observedDuring(() => dom.loopCheckbox.dispatchEvent({ type: 'change' })),
      { observed: [{ type: 'camera-path.playback.set', params: { loop: true } }], dispatched: [] }
    );
    dom.autoplayCheckbox.checked = true;
    assert.deepEqual(
      await observedDuring(() => dom.autoplayCheckbox.dispatchEvent({ type: 'change' })),
      { observed: [{ type: 'camera-path.playback.set', params: { autoplay: true } }], dispatched: [] }
    );
    dom.autoplayCheckbox.checked = false;
    await observedDuring(() => dom.autoplayCheckbox.dispatchEvent({ type: 'change' }));

    await addKeyframes(1);
    dom.setAllDuration.value = '2';
    const setAll = await dispatchedDuring(() => dom.setAllBtn.listeners('click')[0]());
    assert.deepEqual(setAll, [{ type: 'camera-path.duration.set', params: { seconds: 2 } }]);
    assert.deepEqual(module.camera.getKeyframeStore().getAll().map(kf => kf.transitionDuration), [2, 2]);

    const clearEvents = await dispatchedDuring(() => dom.clearBtn.listeners('click')[0]());
    assert.deepEqual(clearEvents, [{ type: 'camera-path.clear', params: {} }]);

    // A restore (a session load, the history putting a path back) is not a step.
    await addKeyframes(2);
    const saved = structuredClone(module.camera.exportPath());
    saved.defaultSpeed = '12';
    const restoreEvents = await observedDuring(() => module.camera.restorePath(saved));
    assert.deepEqual(restoreEvents, { observed: [], dispatched: [] });
    assert.equal(dom.defaultSpeedDisplay.textContent, 'Very slow');
  });
});

test('going to a keyframe places the selected view\'s camera through camera.set, then shows its mode', async () => {
  const placed = [];
  const remove = getActions().provided('camera.set')
    ? () => {}
    : getActions().provide('camera.set', params => { placed.push(structuredClone(params)); });
  try {
    await withCameraPath(async module => {
      await dispatch('camera-path.keyframe.add', { camera: camera(5, 'free'), label: 'Fly' });
      const [kf] = module.camera.getKeyframeStore().getAll();
      module.navigation.modes.length = 0;
      const events = await dispatchedDuring(() => module.dom.keyframeList.listeners('click')[0]({
        target: {
          closest: selector => {
            if (selector === '.cinematic-keyframe-item') return { dataset: { id: kf.id } };
            if (selector === '[data-action]') return { dataset: { action: 'goto' } };
            return null;
          }
        }
      }));
      assert.deepEqual(events, [{ type: 'camera.set', params: { view: 'View 1', camera: camera(5, 'free') } }]);
      assert.deepEqual(module.navigation.modes, ['free']);
    });
    assert.deepEqual(placed, [{ view: 'View 1', camera: camera(5, 'free') }]);
  } finally {
    remove();
  }
});
