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
import { getActionCatalog, getActions } from '../assets/js/app/actions/index.js';
import { ActionRefused } from '../assets/js/app/actions/dispatcher.js';
import { cancelled } from '../assets/js/utils/abort.js';
import { exampleOf } from '../assets/js/app/actions/schema.js';
import { cameraStateForOrbitPose } from '../assets/js/rendering/camera-state-contract.js';
import {
  destroyMounted,
  installModuleEnvironment,
  mountCinematicCamera
} from './helpers/cinematic-camera-harness.mjs';

const LOOP_BACK = '↩ Return to start';

/** A camera with both poses in step, as the viewer reports one (`cameraStateForOrbitPose`); a free-fly one as given. */
function camera(index, navigationMode = 'orbit') {
  const orbit = { radius: 3 + index, targetRadius: 3 + index, theta: 0.25 * index, phi: 0.75, target: [index, 0, 0] };
  if (navigationMode === 'free') {
    return { navigationMode, orbit, freefly: { position: [index, 0, 3 + index], yaw: -Math.PI / 2 + index, pitch: 0.1 * index } };
  }
  return { ...cameraStateForOrbitPose({ navigationMode, target: orbit.target, radius: orbit.radius, theta: orbit.theta, phi: orbit.phi }), orbit };
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
  assert.throws(() => store.add(camera(2), 'KF 3', null), /labeled "KF 3" already/);
  assert.throws(() => store.rename(first, 'KF 3'), /labeled "KF 3" already/);
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
      error => error instanceof ActionRefused && error.message === 'A keyframe is labeled "Overview" already; choose another label.'
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
      { name: 'ActionRefused', message: 'A keyframe is labeled "Close-up" already; choose another label.' }
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
      { name: 'ActionRefused', message: '2 keyframes are labeled "KF 1"; rename all but one first.' }
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

test('a keyframe holds: camera-path.keyframe.add takes a hold, camera-path.hold.set sets one or every one, camera-path.get reports them', async () => {
  await withCameraPath(async module => {
    await assert.rejects(
      dispatch('camera-path.hold.set', { seconds: 2 }),
      { name: 'ActionRefused', message: 'The camera path has no keyframes; save a camera position first.' }
    );
    const added = await dispatch('camera-path.keyframe.add', { camera: camera(0), label: 'Wide', hold: 1.5 });
    assert.deepEqual(added.outcome, { keyframe: 'Wide' });
    assert.equal(getActionCatalog().get('camera-path.keyframe.add').describe({ hold: 1.5 }, added.outcome), 'Saved camera path keyframe "Wide", held 1.5 s');
    await addKeyframes(2);
    await dispatch('camera-path.duration.set', { seconds: 2 });
    const holds = () => module.camera.getKeyframeStore().getAll().map(kf => kf.hold ?? 0);
    assert.deepEqual(holds(), [1.5, 0, 0]);
    assert.deepEqual((await dispatch('camera-path.hold.set', { keyframe: 'KF 1', seconds: 3 })).outcome, { keyframe: 'KF 1' });
    assert.deepEqual(holds(), [1.5, 3, 0]);
    // Nothing to change is no step.
    assert.equal((await dispatch('camera-path.hold.set', { keyframe: 'KF 1', seconds: 3 })).outcome, null);
    await assert.rejects(
      dispatch('camera-path.hold.set', { keyframe: 'Nope', seconds: 1 }),
      { name: 'ActionRefused', message: /There is no keyframe "Nope"/ }
    );
    await assert.rejects(dispatch('camera-path.hold.set', { keyframe: 'KF 1', seconds: -1 }), /seconds/);

    const read = (await dispatch('camera-path.get', {})).outcome;
    assert.deepEqual(read.keyframes.map(kf => [kf.label, kf.at, kf.hold, kf.seconds]), [
      ['Wide', 0, 1.5, 2], ['KF 1', 3.5, 3, 2], ['KF 2', 8.5, 0, null],
    ]);
    assert.equal(read.seconds, 8.5, 'the length includes the holds');

    assert.deepEqual((await dispatch('camera-path.hold.set', { seconds: 0 })).outcome, { keyframes: 3 });
    assert.deepEqual(holds(), [0, 0, 0]);
    assert.equal(module.camera.exportPath().keyframes.some(kf => Object.hasOwn(kf, 'hold')), false, 'no hold is no key in the saved path');

    // The hold field of the panel makes one step with exact parameters; a malformed entry none.
    const holdInput = value => ({
      dataset: { holdIndex: '0' }, value,
      setCustomValidity() {}, reportValidity() {},
    });
    const change = input => module.dom.keyframeList.listeners('change')[0]({
      target: { closest: selector => (selector === '.cinematic-hold-input' ? input : null) },
    });
    assert.deepEqual(await dispatchedDuring(() => change(holdInput('2,5'))), [
      { type: 'camera-path.hold.set', params: { keyframe: 'Wide', seconds: 2.5 } },
    ]);
    assert.deepEqual(holds(), [2.5, 0, 0]);
    assert.deepEqual(await dispatchedDuring(() => change(holdInput(''))), [
      { type: 'camera-path.hold.set', params: { keyframe: 'Wide', seconds: 0 } },
    ]);
    const bad = holdInput('-2');
    assert.deepEqual(await dispatchedDuring(() => change(bad)), []);
    assert.equal(bad.value, '', 'a malformed hold shows the stored one again');
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

    assert.equal(dom.clearBtn.disabled, false, 'Clear all is on with keyframes to clear');
    const clearEvents = await dispatchedDuring(() => dom.clearBtn.listeners('click')[0]());
    assert.deepEqual(clearEvents, [{ type: 'camera-path.clear', params: {} }]);
    // R9E-9: with nothing to clear, Clear all is dimmed (a click did nothing).
    assert.equal(dom.clearBtn.disabled, true, 'Clear all is off with no keyframe');

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

test('camera-path.play plays the path to its end as one step, camera-path.stop ends a loop, camera-path.get reads the path', async () => {
  const originalNow = performance.now;
  let clock = 1000;
  performance.now = () => clock;
  try {
    await withCameraPath(async (module, environment) => {
      await assert.rejects(dispatch('camera-path.play', {}), { name: 'ActionRefused', message: /plays between two keyframes or more/ });
      assert.deepEqual((await dispatch('camera-path.stop', {})).outcome, { stopped: false }, 'nothing playing: nothing stopped, said');
      await addKeyframes(3);
      await dispatch('camera-path.duration.set', { seconds: 2 });
      await dispatch('camera-path.keyframe.rename', { keyframe: 'KF 3', label: 'Closing pull-back' });

      const read = (await dispatch('camera-path.get', {})).outcome;
      assert.equal(read.seconds, 4);
      assert.deepEqual(read.keyframes.map(kf => [kf.label, kf.at, kf.seconds, kf.automatic]), [
        ['KF 1', 0, 2, false], ['KF 2', 2, 2, false], ['Closing pull-back', 4, null, false],
      ]);
      assert.deepEqual(read.keyframes[2].camera, camera(2));
      assert.equal(read.playing, 'stopped');
      assert.equal(read.return_to_start, false);
      assert.deepEqual(read.playback, {
        position_interpolation: module.dom.positionInterp.value, rotation_interpolation: module.dom.rotationInterp.value,
        easing: module.dom.easingSelect.value, speed: Number(module.dom.defaultSpeedInput.value), loop: false, autoplay: false,
        captions: true,
      });

      // Played to its end: the step lasts the playback and ends at the last keyframe.
      const playing = dispatch('camera-path.play', {});
      for (let wait = 0; wait < 20 && module.camera.getPlaybackController().getState() !== 'PLAYING'; wait++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(module.camera.getPlaybackController().getState(), 'PLAYING');
      assert.equal((await dispatch('camera-path.get', {})).outcome.playing, 'playing');
      clock += 1500;
      environment.drainFrames();
      assert.equal(module.camera.getPlaybackController().getState(), 'PLAYING', 'still playing a second and a half in');
      clock += 3000;
      environment.drainFrames();
      const played = await playing;
      assert.deepEqual(played.outcome, { seconds: 4, keyframes: 3, ended: 'end' });
      const end = module.viewer.getCameraState();
      assert.deepEqual([end.orbit.radius, end.orbit.theta, end.orbit.target], [5, 0.5, [2, 0, 0]]);

      // A looping path plays on: the step ends at once; stop ends the loop where the camera is.
      await dispatch('camera-path.playback.set', { loop: true });
      const looping = await dispatch('camera-path.play', {});
      assert.deepEqual(looping.outcome, { seconds: 4, keyframes: 3, ended: 'looping' });
      assert.equal(module.camera.getPlaybackController().getState(), 'PLAYING');
      clock += 1000;
      environment.drainFrames();
      assert.deepEqual((await dispatch('camera-path.stop', {})).outcome, { stopped: true });
      assert.equal(module.camera.getPlaybackController().getState(), 'STOPPED');
      assert.notDeepEqual(module.viewer.getCameraState().orbit.target, [0, 0, 0], 'stopped where it was, not reset to the start');

      // A stop sent while the play still waits for the path's end runs at
      // once, beside it (a stepless control, never queued behind it on the
      // camera; F96): the play answers ended "stopped", its one step holding
      // the camera where the path stopped.
      await dispatch('camera-path.playback.set', { loop: false });
      const interrupted = dispatch('camera-path.play', {});
      for (let wait = 0; wait < 20 && module.camera.getPlaybackController().getState() !== 'PLAYING'; wait++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      clock += 1000;
      environment.drainFrames();
      const stopped = await Promise.race([
        dispatch('camera-path.stop', {}),
        new Promise((_, reject) => setTimeout(() => reject(new Error('camera-path.stop waited behind camera-path.play')), 2000)),
      ]);
      assert.deepEqual(stopped.outcome, { stopped: true });
      // No history here: a change says it made no step for that, a control
      // makes none to begin with.
      assert.equal(stopped.unrecorded, null, 'a control records no step of its own');
      const ended = await interrupted;
      assert.equal(ended.outcome.ended, 'stopped');
      assert.equal(ended.unrecorded, 'no-history', 'the play is the change, recorded where a history runs');
      assert.equal(module.camera.getPlaybackController().getState(), 'STOPPED');
    });
  } finally {
    performance.now = originalNow;
  }
});

test('the person\'s Stop of an agent\'s turn stops a playing path where the film is: the step keeps that camera, nothing is put back (F104)', async () => {
  const originalNow = performance.now;
  let clock = 1000;
  performance.now = () => clock;
  const actions = getActions();
  const recorded = { failed: 0, steps: [] };
  actions.setRecorder({
    before: ({ definition }) => (definition.type === 'camera-path.play' ? { type: definition.type } : null),
    after: (token, outcome) => {
      const step = { id: `s${recorded.steps.length + 1}`, type: token.type, outcome };
      recorded.steps.push(step);
      return step;
    },
    failed: () => { recorded.failed += 1; },
    observed: () => Promise.resolve(null),
  });
  try {
    await withCameraPath(async (module, environment) => {
      await addKeyframes(3);
      await dispatch('camera-path.duration.set', { seconds: 2 });
      const turn = { origin: 'agent', agent: 'Claude', turn: 'turn-f104' };
      const playing = actions.dispatch('camera-path.play', {}, turn);
      for (let wait = 0; wait < 20 && module.camera.getPlaybackController().getState() !== 'PLAYING'; wait++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(module.camera.getPlaybackController().getState(), 'PLAYING');
      clock += 1000;
      environment.drainFrames();
      const filmFrame = module.viewer.getCameraState();
      assert.notDeepEqual(filmFrame.orbit.target, camera(0).orbit.target, 'the film has moved on from its first keyframe');
      assert.equal(actions.stop({ turn: turn.turn }, cancelled('user', 'The person stopped Claude.')), 1);
      const ended = await playing;
      assert.equal(ended.outcome.ended, 'stopped');
      assert.equal(module.camera.getPlaybackController().getState(), 'STOPPED');
      assert.deepEqual(module.viewer.getCameraState(), filmFrame, 'the camera stays where the film stopped');
      assert.equal(recorded.failed, 0, 'nothing is put back');
      assert.equal(ended.step, recorded.steps.at(-1), 'one step, holding the camera where it stopped');
      assert.equal(getActionCatalog().get('camera-path.play').describe({}, ended.outcome), 'Played the camera path (stopped before its end)');
    });
  } finally {
    actions.setRecorder(null);
    performance.now = originalNow;
  }
});

test('a looping path an agent started belongs to its turn: the turn\'s Stop stops it where it is (R9R-8)', async () => {
  const originalNow = performance.now;
  let clock = 1000;
  performance.now = () => clock;
  const actions = getActions();
  try {
    await withCameraPath(async (module, environment) => {
      await addKeyframes(3);
      await dispatch('camera-path.duration.set', { seconds: 2 });
      await dispatch('camera-path.playback.set', { loop: true });
      const turn = { origin: 'agent', agent: 'Claude', turn: 'turn-loop' };
      const looping = await actions.dispatch('camera-path.play', {}, turn);
      assert.equal(looping.outcome.ended, 'looping');
      clock += 1000;
      environment.drainFrames();
      assert.equal(module.camera.getPlaybackController().getState(), 'PLAYING', 'the loop plays on after the play answered');
      // Another turn's Stop reaches nothing of it.
      assert.equal(actions.stop({ turn: 'another-turn' }, cancelled('user', 'The person stopped ChatGPT.')), 0);
      assert.equal(module.camera.getPlaybackController().getState(), 'PLAYING');
      const frame = module.viewer.getCameraState();
      assert.equal(actions.stop({ turn: turn.turn }, cancelled('user', 'The person stopped Claude.')), 1);
      assert.equal(module.camera.getPlaybackController().getState(), 'STOPPED');
      assert.deepEqual(module.viewer.getCameraState(), frame, 'stopped where the film is');
      // Once at rest the loop is no longer the turn's work.
      assert.equal(actions.stop({ turn: turn.turn }, cancelled('user', 'The person stopped Claude.')), 0);

      // A loop the person stops (Pause or the bar's Stop) lets go of its turn: a later Stop reaches nothing.
      await actions.dispatch('camera-path.play', {}, turn);
      module.camera.getPlaybackController().pause();
      assert.equal(actions.stop({ turn: turn.turn }, cancelled('user', 'The person stopped Claude.')), 0);
      assert.equal(module.camera.getPlaybackController().getState(), 'PAUSED');
    });
  } finally {
    performance.now = originalNow;
  }
});

test('an optional parameter sent as null, "null" or {} is refused with how to fix it: leave it out, and what is used then', () => {
  const catalog = getActions().catalog;
  const problem = (type, params) => {
    try {
      catalog.check(type, params);
      return null;
    } catch (error) {
      return error.message;
    }
  };
  // Seen live (2026-11-11): Haiku 5.5 sent camera "null", Opus 5.5 sent camera {}.
  assert.equal(
    problem('camera-path.keyframe.add', { camera: 'null' }),
    'camera-path.keyframe.add.camera must be object, not "null"; camera is optional: leave it out (send no value at all, not null, "null" or {}) for the selected view\'s camera now'
  );
  assert.match(problem('camera-path.keyframe.add', { camera: {} }), /navigationMode is required; camera is optional: leave it out .* for the selected view's camera now$/);
  assert.match(problem('camera.framing', { fill: 2 }), /fill must be at most 1; fill is optional: leave it out for 0\.8$/);
  // A required parameter is not offered to be left out.
  assert.equal(problem('camera.set', { view: 'View 1', camera: 'null' }), 'camera.set.camera must be object, not "null"');

  // The whole class: every optional top-level parameter of every action, given an empty stand-in it refuses, says so.
  let checked = 0;
  for (const definition of catalog.list()) {
    const { properties = {}, required = [] } = definition.params;
    const base = exampleOf(definition.params);
    for (const key of Object.keys(properties)) {
      if (required.includes(key)) continue;
      for (const stand of [null, 'null', {}]) {
        const message = problem(definition.type, { ...base, [key]: stand });
        if (message !== null) checked++;
        if (message === null || !message.startsWith(`${definition.type}.${key}`)) continue;
        assert.match(message, new RegExp(`; ${key} is optional: leave it out`), `${definition.type}.${key} given ${JSON.stringify(stand)}`);
      }
    }
  }
  assert.ok(checked > 100, `optional parameters refused an empty stand-in: ${checked}`);
});

test('a keyframe composed by hand keeps the pose its mode drives; its free-fly pose follows it', async () => {
  await withCameraPath(async module => {
    const guessed = {
      navigationMode: 'orbit',
      orbit: { radius: 2, targetRadius: 2, theta: 0.5, phi: 1.2, target: [0.1, -0.2, 0.3] },
      // What agents sent live (2026-11-11): a guessed eye, yaw and pitch 0.
      freefly: { position: [1, 1, 1], yaw: 0, pitch: 0 },
    };
    await dispatch('camera-path.keyframe.add', { camera: guessed, label: 'Hand-made' });
    const [kf] = module.camera.getKeyframeStore().getAll();
    assert.deepEqual(kf.orbit, guessed.orbit);
    const eye = [0.1 + 2 * Math.sin(1.2) * Math.cos(0.5), -0.2 + 2 * Math.cos(1.2), 0.3 + 2 * Math.sin(1.2) * Math.sin(0.5)];
    kf.freefly.position.forEach((value, axis) => assert.ok(Math.abs(value - eye[axis]) < 1e-12, `eye ${axis}`));
    const forward = eye.map((value, axis) => (guessed.orbit.target[axis] - value) / 2);
    assert.ok(Math.abs(kf.freefly.pitch - Math.asin(forward[1])) < 1e-12);
    // A camera already in step is kept as it is.
    const inStep = { ...guessed, freefly: { position: eye, yaw: Math.atan2(forward[2], forward[0]), pitch: Math.asin(forward[1]) } };
    await dispatch('camera-path.keyframe.add', { camera: inStep, label: 'In step' });
    assert.deepEqual(module.camera.getKeyframeStore().getAll()[1].freefly, inStep.freefly);
  });
});

test('a field given as {source, key} where its name is asked for is shown as sent, with the name to give (L25-15)', () => {
  const catalog = getActions().catalog;
  const problem = (type, params) => {
    try {
      catalog.check(type, params);
      return null;
    } catch (error) {
      return error.message;
    }
  };
  // Seen live (2026-11-11, Haiku 5.5): "…field must be string, not [object Object]; field is optional: leave it out".
  assert.equal(
    problem('analysis.differential.set', { options: { field: { source: 'obs', key: 'cell_type' } } }),
    'analysis.differential.set.options.field must be string, not the object {"source":"obs","key":"cell_type"}: give the name itself, "cell_type"',
  );
  // An object without a name is shown as sent, and keeps the leave-it-out hint of an optional parameter.
  assert.equal(
    problem('analysis.differential.set', { options: { field: { name: 'x' } } }),
    'analysis.differential.set.options.field must be string, not the object {"name":"x"}; field is optional: leave it out',
  );
});
