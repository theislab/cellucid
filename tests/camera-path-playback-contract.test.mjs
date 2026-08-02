/**
 * Playback-time and round-trip contracts for cinematic camera paths.
 *
 * `camera-path-contract.test.mjs` covers the schema and lifecycle boundaries —
 * what a session chunk is allowed to contain. This file covers what the module
 * actually does with one: that a saved path comes back identical, that the
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
const { resolveSegmentDurations } = await import(
  '../assets/js/app/ui/modules/cinematic-camera/interpolation-engine.js'
);
const { createTransportBar } = await import(
  '../assets/js/app/ui/modules/cinematic-camera/transport-bar.js'
);
const { initCinematicCamera } = await import(
  '../assets/js/app/ui/modules/cinematic-camera/index.js'
);

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

    controller.stop({ resetCamera: false });

    // An explicit Stop clears the scrub, so the next Play starts at the top.
    applied.length = 0;
    controller.play();
    assert.equal(harness.advance(16), true);
    assert.ok(
      applied.at(-1).orbit.target[0] < 0.1,
      'Stop must clear the scrub so Play restarts from the first keyframe'
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

    const slowDuration = resolveSegmentDurations(store.getAll(), 1)
      .reduce((sum, value) => sum + value, 0);
    const fastDuration = resolveSegmentDurations(store.getAll(), 4)
      .reduce((sum, value) => sum + value, 0);
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

const CINEMATIC_DOM_KEYS = [
  'navModeSelect', 'orbitControls', 'planarControls', 'freeflyControls',
  'orbitKeySpeedInput', 'orbitKeySpeedDisplay', 'orbitReverseCheckbox',
  'showOrbitAnchorCheckbox', 'planarPanSpeedInput', 'planarPanSpeedDisplay',
  'planarZoomToCursorCheckbox', 'planarInvertAxesCheckbox',
  'lookSensitivityInput', 'lookSensitivityDisplay', 'moveSpeedInput',
  'moveSpeedDisplay', 'invertLookCheckbox', 'pointerLockCheckbox', 'saveBtn',
  'keyframeList', 'clearBtn', 'timingActions', 'setAllDuration', 'setAllBtn',
  'defaultSpeedInput', 'defaultSpeedDisplay', 'positionInterp',
  'rotationInterp', 'easingSelect', 'loopCheckbox', 'autoplayCheckbox'
];

function createStubElement({ checked = false, value = '' } = {}) {
  const handlers = new Map();
  const names = new Set();
  const children = new Map();
  return {
    checked,
    disabled: false,
    inert: false,
    value,
    innerHTML: '',
    textContent: '',
    clientHeight: 100,
    scrollHeight: 50,
    style: {},
    dataset: {},
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
    appendChild() {},
    remove() {},
    blur() {},
    focus() {},
    select() {},
    contains() {
      return false;
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    querySelector(selector) {
      if (!children.has(selector)) children.set(selector, createStubElement());
      return children.get(selector);
    },
    addEventListener(type, listener, options = {}) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(listener);
      options.signal?.addEventListener(
        'abort',
        () => {
          handlers.set(
            type,
            handlers.get(type).filter(entry => entry !== listener)
          );
        },
        { once: true }
      );
    },
    removeEventListener(type, listener) {
      handlers.set(
        type,
        (handlers.get(type) ?? []).filter(entry => entry !== listener)
      );
    },
    dispatchEvent(event) {
      for (const listener of [...(handlers.get(event.type) ?? [])]) {
        listener(event);
      }
      return true;
    },
    listeners(type) {
      return [...(handlers.get(type) ?? [])];
    }
  };
}

function createCinematicDom() {
  const seeds = {
    navModeSelect: { value: 'orbit' },
    orbitKeySpeedInput: { value: '40' },
    planarPanSpeedInput: { value: '100' },
    lookSensitivityInput: { value: '5' },
    moveSpeedInput: { value: '100' },
    defaultSpeedInput: { value: '30' },
    positionInterp: { value: 'catmull-rom' },
    rotationInterp: { value: 'slerp' },
    easingSelect: { value: 'linear' },
    setAllDuration: { value: '' },
    orbitReverseCheckbox: { checked: true },
    showOrbitAnchorCheckbox: { checked: true }
  };
  const dom = {};
  for (const key of CINEMATIC_DOM_KEYS) dom[key] = createStubElement(seeds[key]);
  return dom;
}

function installModuleEnvironment() {
  const previous = {
    document: globalThis.document,
    Event: globalThis.Event,
    MutationObserver: globalThis.MutationObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame
  };
  const scheduled = new Map();
  let nextFrameId = 1;
  globalThis.requestAnimationFrame = callback => {
    const id = nextFrameId++;
    scheduled.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => {
    scheduled.delete(id);
  };
  if (typeof globalThis.Event !== 'function') {
    globalThis.Event = class StubEvent {
      constructor(type) {
        this.type = type;
      }
    };
  }
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  const sidebar = createStubElement();
  globalThis.document = {
    activeElement: null,
    body: { appendChild() {} },
    createElement: () => createStubElement(),
    getElementById: id => (id === 'sidebar' ? sidebar : null),
    addEventListener() {},
    removeEventListener() {}
  };
  return {
    drainFrames() {
      const pending = [...scheduled];
      scheduled.clear();
      for (const [, callback] of pending) callback(0);
    },
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    }
  };
}

function createStubViewer(initialMode = 'orbit') {
  let mode = initialMode;
  const camera = {
    navigationMode: initialMode,
    orbit: {
      radius: 3, targetRadius: 3, theta: 0.25, phi: 0.75, target: [0, 0, 0]
    },
    freefly: { position: [0, 0, 3], yaw: -Math.PI / 2, pitch: 0 }
  };
  const pointerLock = { enabled: false };
  return {
    pointerLock,
    place(index, navigationMode) {
      mode = navigationMode;
      camera.navigationMode = navigationMode;
      camera.orbit = {
        radius: 3 + index,
        targetRadius: 3 + index,
        theta: 0.25 * index,
        phi: 0.75,
        target: [index, 0, 0]
      };
      camera.freefly = {
        position: [index, 0, 3 + index],
        yaw: -Math.PI / 2 + index,
        pitch: 0.1 * index
      };
    },
    getNavigationMode: () => mode,
    setNavigationMode(next) {
      mode = next;
    },
    getCameraState: () => structuredClone(camera),
    setCameraState(value) {
      mode = value.navigationMode;
      camera.navigationMode = value.navigationMode;
      camera.orbit = structuredClone(value.orbit);
      camera.freefly = structuredClone(value.freefly);
    },
    setPointerLockEnabled(value) {
      pointerLock.enabled = value;
    },
    setInvertLookX() {}, setInvertLookY() {}, setLookSensitivity() {},
    setMoveSpeed() {}, setOrbitInvertRotation() {}, setOrbitKeySpeed() {},
    setPlanarInvertAxes() {}, setPlanarPanSpeed() {},
    setPlanarZoomToCursor() {}, setShowOrbitAnchor() {}
  };
}

function createStubDatasetSource() {
  const listeners = new Set();
  return {
    onDatasetChange: listener => listeners.add(listener),
    offDatasetChange: listener => listeners.delete(listener),
    announce() {
      for (const listener of [...listeners]) listener();
    }
  };
}

function mountCinematicCamera() {
  const dom = createCinematicDom();
  const viewer = createStubViewer();
  const dataSourceManager = createStubDatasetSource();
  const camera = initCinematicCamera({ viewer, dom, dataSourceManager });
  return { camera, dom, viewer, dataSourceManager };
}

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
      store.add(source.viewer.getCameraState());
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

    const saved = structuredClone(source.camera.exportSessionState());
    assert.deepEqual(
      saved.keyframes.map(({ label }) => label),
      ['KF 1', 'KF 3', 'Middle stop'],
      'the exported path must carry the edited order and labels'
    );

    // A session load restores into a module that was built from scratch.
    const restored = mountCinematicCamera();
    restored.camera.restoreSessionState(structuredClone(saved));
    environment.drainFrames();
    assert.deepEqual(
      structuredClone(restored.camera.exportSessionState()),
      saved,
      'every restored field must equal the field that was saved'
    );

    // And into one that already holds a different path, which is what Load
    // State does after a user has been working.
    const dirty = mountCinematicCamera();
    for (const index of [7, 8]) {
      dirty.viewer.place(index, 'orbit');
      dirty.camera.getKeyframeStore().add(dirty.viewer.getCameraState());
    }
    environment.drainFrames();
    dirty.camera.restoreSessionState(structuredClone(saved));
    environment.drainFrames();
    assert.deepEqual(
      structuredClone(dirty.camera.exportSessionState()),
      saved,
      'restoring over an existing path must replace it exactly, not merge with it'
    );

    // The label counter is restored too, so the next keyframe continues the
    // saved numbering instead of colliding with an existing label.
    dirty.viewer.place(9, 'orbit');
    dirty.camera.getKeyframeStore().add(dirty.viewer.getCameraState());
    assert.equal(
      dirty.camera.getKeyframeStore().getAll().at(-1).label,
      `KF ${saved.nextIndex}`
    );

    source.camera.destroy();
    restored.camera.destroy();
    dirty.camera.destroy();
  } finally {
    environment.restore();
  }
});

test('the return-to-start keyframe does not consume a user keyframe number', () => {
  const environment = installModuleEnvironment();
  try {
    const module = mountCinematicCamera();
    const store = module.camera.getKeyframeStore();
    for (const index of [0, 1]) {
      module.viewer.place(index, 'orbit');
      store.add(module.viewer.getCameraState());
    }
    environment.drainFrames();

    // The list renders a "Return to Start" toggle once two keyframes exist.
    const [onListChange] = module.dom.keyframeList.listeners('change');
    const toggle = { checked: true };
    onListChange({
      target: {
        closest: selector =>
          (selector === '.cinematic-loopback-list-toggle' ? toggle : null)
      }
    });
    environment.drainFrames();

    const withLoopBack = module.camera.exportSessionState();
    assert.equal(withLoopBack.keyframes.length, 3);
    assert.equal(
      withLoopBack.loopBackKeyframeId,
      withLoopBack.keyframes.at(-1).id
    );

    module.viewer.place(2, 'orbit');
    store.add(module.viewer.getCameraState());
    const labels = store.getAll().map(({ label }) => label);
    assert.deepEqual(
      labels.filter(label => label.startsWith('KF ')),
      ['KF 1', 'KF 2', 'KF 3'],
      `the loop-back keyframe must not advance the user numbering; got ${JSON.stringify(labels)}`
    );

    module.camera.destroy();
  } finally {
    environment.restore();
  }
});

test('leaving free-fly clears the Camera Path pointer-lock control', () => {
  const environment = installModuleEnvironment();
  try {
    const module = mountCinematicCamera();

    module.dom.navModeSelect.value = 'free';
    const [onNavigationChange] = module.dom.navModeSelect.listeners('change');
    onNavigationChange();
    module.dom.pointerLockCheckbox.checked = true;
    const [onPointerLockChange] =
      module.dom.pointerLockCheckbox.listeners('change');
    onPointerLockChange();
    assert.equal(module.viewer.pointerLock.enabled, true);

    // The viewer drops pointer lock whenever navigation leaves free-fly, and
    // the Compare Views mirror of this control clears itself when it does. The
    // Camera Path mirror must agree, whichever surface changed the mode.
    module.dom.navModeSelect.value = 'orbit';
    onNavigationChange();
    assert.equal(
      module.dom.pointerLockCheckbox.checked,
      false,
      'the pointer-lock control must not claim a lock the viewer has released'
    );

    module.dom.navModeSelect.value = 'free';
    onNavigationChange();
    module.camera.syncNavigationMode('planar');
    assert.equal(
      module.dom.pointerLockCheckbox.checked,
      false,
      'a mode change published by another surface must clear it too'
    );

    module.camera.destroy();
  } finally {
    environment.restore();
  }
});
