/**
 * Playback-time and round-trip contracts for cinematic camera paths.
 *
 * `camera-path-contract.test.mjs` covers the schema and lifecycle boundaries —
 * what the path's state (`exportPath`, the `camera-path` state domain's value)
 * is allowed to contain. This file covers what the module actually does with
 * one: that a saved path comes back identical, that the
 * transport's displayed position is the position `play()` uses, that a live
 * pace change moves the clock the transport shows, and that neither the frame
 * loop nor the pointer-activity path re-derives the whole path on every event.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const keyframeModule = await import(
  '../assets/js/app/ui/modules/cinematic-camera/keyframe-store.js'
);
const { createPlaybackController } = await import(
  '../assets/js/app/ui/modules/cinematic-camera/playback-controller.js'
);
const { resolvePathTiming } = await import(
  '../assets/js/app/ui/modules/cinematic-camera/interpolation-engine.js'
);
const { createTransportBar } = await import(
  '../assets/js/app/ui/modules/cinematic-camera/transport-bar.js'
);
const {
  destroyMounted,
  installModuleEnvironment,
  mountCinematicCamera
} = await import('./helpers/cinematic-camera-harness.mjs');

function keyframe(index, transitionDuration = 1) {
  return {
    id: `kf-${index}`,
    label: `KF ${index + 1}`,
    navigationMode: 'orbit',
    orbit: {
      radius: 3 + index,
      targetRadius: 3 + index,
      theta: 0.25 * index,
      phi: 0.75,
      target: [index, 0, 0]
    },
    freefly: {
      position: [index, 0, 3 + index],
      yaw: -Math.PI / 2,
      pitch: 0
    },
    representation: null,
    transitionDuration
  };
}

function linearOptions(overrides = {}) {
  return {
    positionMethod: 'linear',
    rotationMethod: 'linear',
    easing: 'linear',
    loop: false,
    autoPaceSpeed: 1,
    ...overrides
  };
}

/** Deterministic clock plus a hand-driven animation-frame queue. */
function createFrameHarness() {
  const originalPerformance = globalThis.performance;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const scheduled = new Map();
  let nextFrameId = 1;
  const clock = { milliseconds: 0 };

  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => clock.milliseconds }
  });
  globalThis.requestAnimationFrame = callback => {
    const id = nextFrameId++;
    scheduled.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => {
    scheduled.delete(id);
  };

  return {
    clock,
    scheduled,
    advance(milliseconds) {
      clock.milliseconds += milliseconds;
      const pending = scheduled.entries().next();
      if (pending.done) return false;
      const [id, callback] = pending.value;
      scheduled.delete(id);
      callback();
      return true;
    },
    restore() {
      Object.defineProperty(globalThis, 'performance', {
        configurable: true,
        value: originalPerformance
      });
      if (originalRequestAnimationFrame === undefined) {
        delete globalThis.requestAnimationFrame;
      } else {
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      }
      if (originalCancelAnimationFrame === undefined) {
        delete globalThis.cancelAnimationFrame;
      } else {
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
      }
    }
  };
}

/**
 * Count `Object.keys` calls.
 *
 * Every schema check in the camera-path modules routes through `Object.keys`
 * — `hasExactKeys`, `isValidCameraKeyframe`, and `assertCameraPathOptions` all
 * call it and all allocate the array it returns. Counting it is therefore an
 * exact, load-invariant measure of how much re-validation an event performs,
 * where a wall-clock number would only be a measure of the machine.
 */
function createKeyCounter() {
  const originalKeys = Object.keys;
  let counting = false;
  let calls = 0;
  Object.keys = function countedKeys(value) {
    if (counting) calls += 1;
    return originalKeys(value);
  };
  return {
    start() {
      calls = 0;
      counting = true;
    },
    stop() {
      counting = false;
      return calls;
    },
    restore() {
      Object.keys = originalKeys;
    }
  };
}

test('Play resumes from the position an idle path was scrubbed to', () => {
  const harness = createFrameHarness();
  try {
    const store = keyframeModule.createKeyframeStore();
    assert.equal(store.importAll({
      keyframes: [keyframe(0), keyframe(1)],
      nextIndex: 3
    }), true);

    const applied = [];
    const controller = createPlaybackController({
      viewer: { setCameraState: state => applied.push(state) },
      keyframeStore: store,
      getInterpolationOptions: () => linearOptions()
    });

    // Scrubbing an idle path is a supported flow: it moves the camera and the
    // transport publishes the new position through `timeUpdate`.
    controller.seekTo(0.5);
    assert.equal(controller.getState(), 'STOPPED');
    assert.deepEqual(applied.at(-1).orbit.target, [0.5, 0, 0]);

    applied.length = 0;
    controller.play();
    assert.equal(harness.advance(16), true);

    assert.ok(
      controller.getProgress() > 0.4,
      `Play must continue from the scrubbed position, not restart; progress was ${controller.getProgress()}`
    );
    assert.ok(
      applied.at(-1).orbit.target[0] > 0.4,
      `the camera must stay near the scrubbed viewpoint; target was ${JSON.stringify(applied.at(-1).orbit.target)}`
    );

    // A stop that leaves the camera where it is keeps the position the
    // transport shows; the bar's Stop (back to the first keyframe)
    // clears it, so the next Play starts at the top.
    controller.stop({ resetCamera: false });
    assert.ok(controller.getProgress() > 0.4, 'a stop in place keeps the position');
    controller.stop({ resetCamera: true });
    assert.equal(controller.getProgress(), 0);
    applied.length = 0;
    controller.play();
    assert.equal(harness.advance(16), true);
    assert.ok(
      applied.at(-1).orbit.target[0] < 0.1,
      'the bar\'s Stop must clear the scrub so Play restarts from the first keyframe'
    );
    controller.stop({ resetCamera: false });

    // Seeking to the very end of a non-looping path is the one case where Play
    // restarts instead of resuming, so the button is never a no-op.
    controller.seekTo(1);
    applied.length = 0;
    controller.play();
    assert.equal(controller.getState(), 'PLAYING');
    assert.equal(harness.advance(16), true);
    assert.equal(controller.getState(), 'PLAYING');
    assert.ok(
      applied.at(-1).orbit.target[0] < 0.1,
      'Play at the end of a path must restart it rather than complete instantly'
    );

    controller.stop({ resetCamera: false });
    controller.destroy();
  } finally {
    harness.restore();
  }
});

test('a live pace change retimes the running path instead of drifting from its clock', () => {
  const harness = createFrameHarness();
  try {
    const store = keyframeModule.createKeyframeStore();
    assert.equal(store.importAll({
      keyframes: [keyframe(0, null), keyframe(1, null)],
      nextIndex: 3
    }), true);

    let autoPaceSpeed = 1;
    const updates = [];
    const controller = createPlaybackController({
      viewer: { setCameraState() {} },
      keyframeStore: store,
      getInterpolationOptions: () => linearOptions({ autoPaceSpeed })
    });
    controller.on('timeUpdate', update => updates.push(update));

    const slowDuration = resolvePathTiming(store.getAll(), 1).total;
    const fastDuration = resolvePathTiming(store.getAll(), 4).total;
    assert.ok(slowDuration > fastDuration);

    controller.play();
    harness.advance(Math.round(slowDuration * 500));
    const beforeChange = updates.at(-1);
    assert.ok(Math.abs(beforeChange.globalT - 0.5) < 0.02);
    assert.ok(Math.abs(beforeChange.totalDuration - slowDuration) < 1e-9);

    // The default-speed slider is live during playback: moving it must move the
    // clock the transport reads, not only the geometry the interpolator walks.
    autoPaceSpeed = 4;
    harness.advance(1);
    const afterChange = updates.at(-1);
    assert.ok(
      Math.abs(afterChange.totalDuration - fastDuration) < 1e-9,
      `the running path must adopt the new duration; reported ${afterChange.totalDuration}, expected ${fastDuration}`
    );
    assert.ok(
      Math.abs(afterChange.globalT - beforeChange.globalT) < 0.02,
      `retiming must not jump the camera; progress moved from ${beforeChange.globalT} to ${afterChange.globalT}`
    );
    assert.ok(
      Math.abs(afterChange.elapsed - afterChange.globalT * fastDuration) < 1e-6,
      'the reported elapsed time must belong to the reported total'
    );

    controller.stop({ resetCamera: false });
    controller.destroy();
  } finally {
    harness.restore();
  }
});

test('a playback frame costs the same for a 2-keyframe path as for a 40-keyframe path', () => {
  const harness = createFrameHarness();
  const counter = createKeyCounter();
  const FRAMES = 60;

  function measure(pathLength) {
    const store = keyframeModule.createKeyframeStore();
    assert.equal(store.importAll({
      keyframes: Array.from({ length: pathLength }, (_, index) => keyframe(index)),
      nextIndex: pathLength + 1
    }), true);
    const controller = createPlaybackController({
      viewer: { setCameraState() {} },
      keyframeStore: store,
      getInterpolationOptions: () => linearOptions({ loop: true })
    });
    controller.play();
    harness.advance(16);

    counter.start();
    for (let frame = 0; frame < FRAMES; frame += 1) {
      assert.equal(harness.advance(16), true);
    }
    const calls = counter.stop();

    controller.stop({ resetCamera: false });
    controller.destroy();
    return calls / FRAMES;
  }

  try {
    const shortPath = measure(2);
    const longPath = measure(40);

    assert.equal(
      longPath,
      shortPath,
      `a frame must not re-validate the path: ${shortPath} Object.keys calls per frame ` +
        `for 2 keyframes against ${longPath} for 40`
    );
    assert.ok(
      shortPath <= 4,
      `a playback frame must not rebuild the path schema; measured ${shortPath} Object.keys calls per frame`
    );
  } finally {
    counter.restore();
    harness.restore();
  }
});

test('pointer activity keeps the transport alive without re-deriving the path', () => {
  const harness = createFrameHarness();
  const counter = createKeyCounter();
  const originalDocument = globalThis.document;
  const originalMutationObserver = globalThis.MutationObserver;
  const documentListeners = new Map();

  function createElement() {
    const created = new Map();
    const names = new Set();
    const element = {
      classList: {
        add: name => names.add(name),
        remove: name => names.delete(name),
        contains: name => names.has(name),
        toggle: (name, force) => {
          const on = force === undefined ? !names.has(name) : force;
          if (on) names.add(name);
          else names.delete(name);
          return on;
        }
      },
      inert: false,
      innerHTML: '',
      style: {},
      dataset: {},
      appendChild() {},
      remove() {},
      contains() {
        return false;
      },
      setAttribute() {},
      addEventListener() {},
      removeEventListener() {},
      querySelectorAll() {
        return [];
      },
      querySelector(selector) {
        if (!created.has(selector)) created.set(selector, createElement());
        return created.get(selector);
      }
    };
    return element;
  }

  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.document = {
    activeElement: null,
    body: { appendChild() {} },
    createElement,
    getElementById(id) {
      return id === 'sidebar' ? createElement() : null;
    },
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      documentListeners.set(
        type,
        (documentListeners.get(type) ?? []).filter(entry => entry !== listener)
      );
    }
  };

  try {
    const store = keyframeModule.createKeyframeStore();
    assert.equal(store.importAll({
      keyframes: Array.from({ length: 40 }, (_, index) => keyframe(index)),
      nextIndex: 41
    }), true);
    const controller = createPlaybackController({
      viewer: { setCameraState() {} },
      keyframeStore: store,
      getInterpolationOptions: () => linearOptions()
    });
    const transport = createTransportBar({
      playbackController: controller,
      keyframeStore: store,
      getInterpolationOptions: () => linearOptions()
    });

    transport.updateVisibility({ reveal: true });
    assert.equal(transport.isMounted(), true);

    const onMouseMove = documentListeners.get('mousemove');
    assert.equal(onMouseMove.length, 1);

    // Warm up, then measure: a mouse drag over the canvas fires this handler at
    // pointer rate while a path exists, so it must not walk the keyframes.
    onMouseMove[0]();
    counter.start();
    const MOVES = 50;
    for (let move = 0; move < MOVES; move += 1) onMouseMove[0]();
    const perMove = counter.stop() / MOVES;

    assert.ok(
      perMove <= 1,
      `pointer activity must not re-validate the path; measured ${perMove} Object.keys calls per mousemove`
    );

    transport.destroy();
    controller.destroy();
  } finally {
    counter.restore();
    if (originalDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
    if (originalMutationObserver === undefined) {
      delete globalThis.MutationObserver;
    } else {
      globalThis.MutationObserver = originalMutationObserver;
    }
    harness.restore();
  }
});

// ---------------------------------------------------------------------------
// Whole-module round trip
// ---------------------------------------------------------------------------

test('a recorded path survives save and restore field for field', () => {
  const environment = installModuleEnvironment();
  try {
    const source = mountCinematicCamera();
    const store = source.camera.getKeyframeStore();

    // Record four keyframes in three navigation modes, then edit them the way
    // the list lets a user: delete, rename, retime, reorder. The deletion is
    // what makes the label counter independent of the keyframe count, so a
    // restore that re-derived it instead of reading it would be visible.
    for (const [index, mode] of [
      [0, 'orbit'], [1, 'free'], [2, 'planar'], [3, 'orbit']
    ]) {
      source.viewer.place(index, mode);
      store.add(source.viewer.getCameraState(), undefined, null);
    }
    const ids = store.getAll().map(({ id }) => id);
    store.remove(ids[3]);
    store.rename(ids[1], 'Middle stop');
    store.setDuration(0, 2.5);
    store.reorder(ids[2], -1);
    source.dom.loopCheckbox.checked = true;
    source.dom.autoplayCheckbox.checked = true;
    source.dom.positionInterp.value = 'bezier';
    source.dom.rotationInterp.value = 'linear';
    source.dom.easingSelect.value = 'ease-in-out';
    source.dom.defaultSpeedInput.value = '77';
    source.dom.defaultSpeedInput.dispatchEvent(new globalThis.Event('input'));
    environment.drainFrames();

    const saved = structuredClone(source.camera.exportPath());
    assert.deepEqual(
      saved.keyframes.map(({ label }) => label),
      ['KF 1', 'KF 3', 'Middle stop'],
      'the exported path must carry the edited order and labels'
    );

    // A session load restores into a module that was built from scratch
    // (mounting it retires the one that recorded the path).
    const restored = mountCinematicCamera();
    restored.camera.restorePath(structuredClone(saved));
    environment.drainFrames();
    assert.deepEqual(
      structuredClone(restored.camera.exportPath()),
      saved,
      'every restored field must equal the field that was saved'
    );

    // And into one that already holds a different path, which is what Load
    // State does after a user has been working.
    const dirty = mountCinematicCamera();
    for (const index of [7, 8]) {
      dirty.viewer.place(index, 'orbit');
      dirty.camera.getKeyframeStore().add(dirty.viewer.getCameraState(), undefined, null);
    }
    environment.drainFrames();
    dirty.camera.restorePath(structuredClone(saved));
    environment.drainFrames();
    assert.deepEqual(
      structuredClone(dirty.camera.exportPath()),
      saved,
      'restoring over an existing path must replace it exactly, not merge with it'
    );

    // The label counter is restored too, so the next keyframe continues the
    // saved numbering instead of colliding with an existing label.
    dirty.viewer.place(9, 'orbit');
    dirty.camera.getKeyframeStore().add(dirty.viewer.getCameraState(), undefined, null);
    assert.equal(
      dirty.camera.getKeyframeStore().getAll().at(-1).label,
      `KF ${saved.nextIndex}`
    );

  } finally {
    destroyMounted();
    environment.restore();
  }
});

test('the return-to-start keyframe does not consume a user keyframe number', async () => {
  const environment = installModuleEnvironment();
  try {
    const module = mountCinematicCamera();
    const store = module.camera.getKeyframeStore();
    for (const index of [0, 1]) {
      module.viewer.place(index, 'orbit');
      store.add(module.viewer.getCameraState(), undefined, null);
    }
    environment.drainFrames();

    // The list renders a "Return to Start" toggle once two keyframes exist.
    // Turning it on is a camera path action, applied once it is dispatched.
    const [onListChange] = module.dom.keyframeList.listeners('change');
    const toggle = { checked: true };
    onListChange({
      target: {
        closest: selector =>
          (selector === '.cinematic-loopback-list-toggle' ? toggle : null)
      }
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    environment.drainFrames();

    const withLoopBack = module.camera.exportPath();
    assert.equal(withLoopBack.keyframes.length, 3);
    assert.equal(
      withLoopBack.loopBackKeyframeId,
      withLoopBack.keyframes.at(-1).id
    );

    module.viewer.place(2, 'orbit');
    store.add(module.viewer.getCameraState(), undefined, null);
    const labels = store.getAll().map(({ label }) => label);
    assert.deepEqual(
      labels.filter(label => label.startsWith('KF ')),
      ['KF 1', 'KF 2', 'KF 3'],
      `the loop-back keyframe must not advance the user numbering; got ${JSON.stringify(labels)}`
    );
  } finally {
    destroyMounted();
    environment.restore();
  }
});

test('a path restore moves neither the camera nor its navigation mode', () => {
  // The navigation mode and the camera are the camera domain's; a restored
  // path is only keyframes and how they play. Restoring one recorded in
  // other modes leaves the viewer, and the Navigation panel, as they are.
  const environment = installModuleEnvironment();
  try {
    const module = mountCinematicCamera();
    const store = module.camera.getKeyframeStore();
    module.viewer.place(0, 'free');
    store.add(module.viewer.getCameraState(), undefined, null);
    module.viewer.place(1, 'planar');
    store.add(module.viewer.getCameraState(), undefined, null);
    const saved = structuredClone(module.camera.exportPath());

    module.viewer.place(2, 'orbit');
    const camera = module.viewer.getCameraState();
    module.navigation.modes.length = 0;
    module.camera.restorePath(saved);
    environment.drainFrames();
    assert.equal(module.viewer.getNavigationMode(), 'orbit');
    assert.deepEqual(module.viewer.getCameraState(), camera);
    // Stopping playback shows the mode the viewer has; the path names none.
    assert.deepEqual(module.navigation.modes, ['orbit']);
    assert.deepEqual(structuredClone(module.camera.exportPath()), saved);
  } finally {
    destroyMounted();
    environment.restore();
  }
});
