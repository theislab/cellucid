import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const keyframeModule = await import(
  '../assets/js/app/ui/modules/cinematic-camera/keyframe-store.js'
);
const { createPlaybackController, prefersReducedMotion } = await import(
  '../assets/js/app/ui/modules/cinematic-camera/playback-controller.js'
);
const { interpolateCameraState } = await import(
  '../assets/js/app/ui/modules/cinematic-camera/interpolation-engine.js'
);

const cameraModuleSource = await readFile(
  new URL('../assets/js/app/ui/modules/cinematic-camera/index.js', import.meta.url),
  'utf8'
);
const playbackControllerSource = await readFile(
  new URL(
    '../assets/js/app/ui/modules/cinematic-camera/playback-controller.js',
    import.meta.url
  ),
  'utf8'
);
const transportBarSource = await readFile(
  new URL('../assets/js/app/ui/modules/cinematic-camera/transport-bar.js', import.meta.url),
  'utf8'
);
const uiCoordinatorSource = await readFile(
  new URL('../assets/js/app/ui/core/ui-coordinator.js', import.meta.url),
  'utf8'
);
const domCacheSource = await readFile(
  new URL('../assets/js/app/ui/core/dom-cache.js', import.meta.url),
  'utf8'
);
const mainSource = await readFile(
  new URL('../assets/js/app/main.js', import.meta.url),
  'utf8'
);
const datasetStateSource = await readFile(
  new URL(
    '../assets/js/app/session/dataset-state-manifest.js',
    import.meta.url
  ),
  'utf8'
);
const sessionSerializerSource = await readFile(
  new URL(
    '../assets/js/app/session/session-serializer.js',
    import.meta.url
  ),
  'utf8'
);
const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');

function keyframe(id, offset = 0) {
  return {
    id,
    label: id,
    navigationMode: 'orbit',
    orbit: {
      radius: 3 + offset,
      targetRadius: 3 + offset,
      theta: 0.25 + offset,
      phi: 0.75,
      target: [offset, 0, 0]
    },
    freefly: {
      position: [offset, 0, 3 + offset],
      yaw: -Math.PI / 2,
      pitch: 0
    },
    transitionDuration: 1
  };
}

test('camera path readiness requires at least two fully valid keyframes', () => {
  const isReady = keyframeModule.isCameraPathReady;
  const isValid = keyframeModule.isValidCameraKeyframe;

  assert.equal(typeof isReady, 'function');
  assert.equal(typeof isValid, 'function');
  assert.equal(isReady([]), false);
  assert.equal(isReady([keyframe('one')]), false);
  assert.equal(isReady([keyframe('one'), keyframe('two', 1)]), true);

  const malformed = keyframe('bad');
  malformed.freefly.position[1] = Number.NaN;
  assert.equal(isValid(malformed), false);
  assert.equal(isReady([keyframe('one'), malformed]), false);

  const hostileId = keyframe('"><button>Injected</button>');
  assert.equal(
    isValid(hostileId),
    false,
    'session ids that can break out of a data attribute must be rejected'
  );
});

test('session import rejects malformed or hostile camera paths atomically', () => {
  const store = keyframeModule.createKeyframeStore();
  assert.equal(
    store.importAll({ keyframes: [keyframe('existing')], nextIndex: 2 }),
    true
  );
  const malformed = keyframe('bad');
  malformed.navigationMode = 'teleport';

  assert.equal(
    store.importAll({ keyframes: [keyframe('one'), malformed], nextIndex: 3 }),
    false
  );
  assert.deepEqual(store.getAll().map(({ id }) => id), ['existing']);

  assert.equal(
    store.importAll({
      keyframes: [keyframe('one'), keyframe('"><button>Injected</button>', 1)],
      nextIndex: 3
    }),
    false
  );
  assert.deepEqual(store.getAll().map(({ id }) => id), ['existing']);

  const missingTiming = keyframe('missing-timing');
  delete missingTiming.transitionDuration;
  assert.equal(
    store.importAll({ keyframes: [missingTiming], nextIndex: 2 }),
    false
  );
  assert.deepEqual(store.getAll().map(({ id }) => id), ['existing']);

  assert.equal(
    store.importAll({ keyframes: [keyframe('one')] }),
    false,
    'the current session contract requires its exact nextIndex'
  );
  assert.deepEqual(store.getAll().map(({ id }) => id), ['existing']);

  assert.equal(
    store.importAll({
      keyframes: [keyframe('one')],
      nextIndex: 2,
      legacyNextIndex: 2
    }),
    false,
    'obsolete or unknown keyframe-store fields are not part of the current contract'
  );
  assert.deepEqual(store.getAll().map(({ id }) => id), ['existing']);
});

test('Camera Path session state accepts only the exact current fields', async () => {
  const { assertCameraPathSessionState } = await import(
    '../assets/js/app/ui/modules/cinematic-camera/index.js'
  );
  const state = {
    autoplay: false,
    keyframes: [keyframe('one'), keyframe('two')],
    nextIndex: 3,
    loopBackKeyframeId: null,
    loopPlayback: false,
    positionMethod: 'linear',
    rotationMethod: 'linear',
    easing: 'linear',
    defaultSpeed: '30',
    navigationMode: 'orbit',
    orbitKeySpeed: '40',
    orbitReverse: true,
    showOrbitAnchor: true,
    planarPanSpeed: '100',
    planarZoomToCursor: true,
    planarInvertAxes: false,
    lookSensitivity: '5',
    moveSpeed: '100',
    invertLook: false
  };

  assert.equal(assertCameraPathSessionState(state), state);
  assert.throws(
    () => assertCameraPathSessionState({ ...state, legacyPlayback: false }),
    /exactly/i
  );
  const { defaultSpeed: _defaultSpeed, ...missingDefaultSpeed } = state;
  assert.throws(
    () => assertCameraPathSessionState(missingDefaultSpeed),
    /exactly/i
  );
  assert.throws(
    () => assertCameraPathSessionState({ ...state, defaultSpeed: '30 trailing' }),
    /default speed/i
  );
  assert.throws(
    () => assertCameraPathSessionState({ ...state, autoplay: 1 }),
    /autoplay/i
  );
  assert.throws(
    () => assertCameraPathSessionState({ ...state, moveSpeed: '501' }),
    /move speed/i
  );
});

test('camera path duration edits reject invalid values instead of normalizing them', () => {
  const store = keyframeModule.createKeyframeStore();
  assert.equal(
    store.importAll({ keyframes: [keyframe('one'), keyframe('two')], nextIndex: 3 }),
    true
  );

  assert.throws(() => store.setDuration(0, Number.NaN), /duration/i);
  assert.throws(() => store.setDuration(0, 0), /duration/i);
  assert.throws(() => store.setDuration(0, 60.1), /duration/i);
  assert.throws(() => store.setAllDurations('2'), /duration/i);
  assert.throws(() => store.setAllDurations(60.1), /duration/i);
  assert.deepEqual(
    store.getAll().map(({ transitionDuration }) => transitionDuration),
    [1, 1]
  );
});

test('keyframe mutation commands reject invalid identities, labels, and directions', () => {
  const store = keyframeModule.createKeyframeStore();
  assert.equal(store.importAll({
    keyframes: [keyframe('one'), keyframe('two')],
    nextIndex: 3
  }), true);
  const originalIds = store.getAll().map(({ id }) => id);

  const {
    id: _id,
    label: _label,
    transitionDuration: _transitionDuration,
    ...invalidCameraState
  } = keyframe('invalid-state');
  invalidCameraState.freefly = {
    ...invalidCameraState.freefly,
    yaw: Number.NaN
  };
  const {
    id: _validId,
    label: _validLabel,
    transitionDuration: _validTransitionDuration,
    ...validCameraState
  } = keyframe('valid-state');

  assert.throws(() => store.add(invalidCameraState), /camera state/i);
  assert.throws(() => store.add(validCameraState, '  spaced  '), /label/i);
  assert.throws(() => store.remove('missing'), /not found/i);
  assert.throws(() => store.rename('missing', 'Renamed'), /not found/i);
  assert.throws(() => store.rename('one', '  Renamed  '), /label/i);
  assert.throws(() => store.reorder('one', 0), /direction/i);
  assert.throws(() => store.reorder('one', -1), /range/i);
  assert.deepEqual(store.getAll().map(({ id }) => id), originalIds);
});

test('keyframe reads cannot mutate store-owned camera coordinates', () => {
  const store = keyframeModule.createKeyframeStore();
  assert.equal(store.importAll({
    keyframes: [keyframe('one'), keyframe('two')],
    nextIndex: 3
  }), true);

  assert.throws(() => {
    store.getAll()[0].orbit.radius = 999;
  }, TypeError);
  assert.equal(store.getAll()[0].orbit.radius, 3);

  const exported = store.exportAll();
  exported.keyframes[0].orbit.radius = 777;
  exported.keyframes[0].orbit.target[0] = 777;
  assert.equal(store.getAll()[0].orbit.radius, 3);
  assert.deepEqual(store.getAll()[0].orbit.target, [0, 0, 0]);
});

test('keyframe change subscriptions require the exact current event contract', () => {
  const store = keyframeModule.createKeyframeStore();
  assert.throws(() => store.on('legacy-change', () => {}), /event/i);
  assert.throws(() => store.on('changed', null), /listener/i);
  assert.throws(() => store.off('legacy-change', () => {}), /event/i);
  assert.throws(() => store.off('changed', null), /listener/i);
});

test('playback stops without moving when a path becomes invalid', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const scheduledFrames = new Map();
  let nextFrameId = 1;

  globalThis.requestAnimationFrame = callback => {
    const id = nextFrameId++;
    scheduledFrames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => {
    scheduledFrames.delete(id);
  };

  try {
    const store = keyframeModule.createKeyframeStore();
    assert.equal(store.importAll({
      keyframes: [keyframe('one'), keyframe('two', 1)],
      nextIndex: 3
    }), true);

    const appliedStates = [];
    const controller = createPlaybackController({
      viewer: {
        setCameraState: state => appliedStates.push(state)
      },
      keyframeStore: store,
      getInterpolationOptions: () => ({
        positionMethod: 'linear',
        rotationMethod: 'linear',
        easing: 'linear',
        loop: false,
        autoPaceSpeed: 1
      })
    });

    controller.play();
    assert.equal(controller.getState(), 'PLAYING');
    assert.equal(scheduledFrames.size, 1);

    store.remove('two');
    assert.equal(controller.getState(), 'STOPPED');
    assert.equal(scheduledFrames.size, 0);
    assert.equal(
      appliedStates.length,
      0,
      'invalidating a path must not jump to an old keyframe'
    );

    controller.destroy();
  } finally {
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
});

test('a reduced-motion preference completes the path instead of animating it', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalMatchMedia = globalThis.matchMedia;
  const scheduledFrames = new Map();
  const mediaQueries = [];
  // The module keeps the MediaQueryList it is handed and reads `matches` live,
  // exactly as a browser reports an OS-level preference change.
  const reducedMotionMedia = { matches: true };
  let nextFrameId = 1;

  globalThis.requestAnimationFrame = callback => {
    const id = nextFrameId++;
    scheduledFrames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => {
    scheduledFrames.delete(id);
  };
  globalThis.matchMedia = query => {
    mediaQueries.push(query);
    return reducedMotionMedia;
  };

  try {
    const store = keyframeModule.createKeyframeStore();
    assert.equal(store.importAll({
      keyframes: [keyframe('one'), keyframe('two', 1)],
      nextIndex: 3
    }), true);

    const options = {
      positionMethod: 'linear',
      rotationMethod: 'linear',
      easing: 'linear',
      loop: false,
      autoPaceSpeed: 1
    };
    const appliedStates = [];
    const stateChanges = [];
    const progress = [];
    const controller = createPlaybackController({
      viewer: {
        setCameraState: state => appliedStates.push(state)
      },
      keyframeStore: store,
      getInterpolationOptions: () => ({ ...options })
    });
    controller.on('stateChange', value => stateChanges.push(value));
    controller.on('timeUpdate', update => progress.push(update.globalT));

    assert.equal(prefersReducedMotion(), true);
    assert.deepEqual(mediaQueries, ['(prefers-reduced-motion: reduce)']);

    controller.play();
    assert.equal(
      scheduledFrames.size,
      0,
      'a stated reduced-motion preference must not start an animation loop'
    );
    assert.equal(controller.getState(), 'STOPPED');
    assert.deepEqual(stateChanges, ['STOPPED']);
    assert.deepEqual(progress, [1, 0]);
    assert.equal(
      appliedStates.length,
      1,
      'the end of the path must still be published'
    );
    assert.deepEqual(
      appliedStates[0],
      interpolateCameraState(store.getAll(), 1, { ...options }),
      'reduced motion must reach the exact camera the animation would have reached'
    );

    // Every intermediate viewpoint stays reachable, still without animating.
    controller.seekTo(0.5);
    assert.equal(scheduledFrames.size, 0);
    assert.deepEqual(
      appliedStates[1],
      interpolateCameraState(store.getAll(), 0.5, { ...options })
    );

    // Clearing the preference restores the frame loop.
    reducedMotionMedia.matches = false;
    controller.play();
    assert.equal(controller.getState(), 'PLAYING');
    assert.equal(scheduledFrames.size, 1);
    controller.stop({ resetCamera: false });

    controller.destroy();
  } finally {
    // The cached MediaQueryList outlives the stub, so leave motion enabled.
    reducedMotionMedia.matches = false;
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
    if (originalMatchMedia === undefined) {
      delete globalThis.matchMedia;
    } else {
      globalThis.matchMedia = originalMatchMedia;
    }
  }
});

test('editing a valid path stops active playback before cached timing goes stale', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const scheduledFrames = new Map();
  let nextFrameId = 1;

  globalThis.requestAnimationFrame = callback => {
    const id = nextFrameId++;
    scheduledFrames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => {
    scheduledFrames.delete(id);
  };

  try {
    const store = keyframeModule.createKeyframeStore();
    assert.equal(store.importAll({
      keyframes: [keyframe('one'), keyframe('two', 1)],
      nextIndex: 3
    }), true);

    const appliedStates = [];
    const controller = createPlaybackController({
      viewer: {
        setCameraState: state => appliedStates.push(state)
      },
      keyframeStore: store,
      getInterpolationOptions: () => ({
        positionMethod: 'linear',
        rotationMethod: 'linear',
        easing: 'linear',
        loop: false,
        autoPaceSpeed: 1
      })
    });

    controller.play();
    assert.equal(controller.getState(), 'PLAYING');
    store.setDuration(0, 5);
    assert.equal(controller.getState(), 'STOPPED');
    assert.equal(scheduledFrames.size, 0);
    assert.equal(
      appliedStates.length,
      0,
      'editing a playing path must not jump the camera'
    );

    controller.destroy();
  } finally {
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
});

test('playback rejects implicit control options and invalid user commands', () => {
  const store = keyframeModule.createKeyframeStore();
  const viewer = { setCameraState() {} };
  const interpolationOptions = () => ({
    positionMethod: 'linear',
    rotationMethod: 'linear',
    easing: 'linear',
    loop: false,
    autoPaceSpeed: 1
  });

  assert.throws(
    () => createPlaybackController({
      viewer,
      keyframeStore: store,
      getInterpolationOptions: undefined
    }),
    /getInterpolationOptions/
  );

  const controller = createPlaybackController({
    viewer,
    keyframeStore: store,
    getInterpolationOptions: interpolationOptions
  });
  assert.throws(
    () => controller.play(),
    /at least two valid keyframes/i
  );
  assert.throws(
    () => controller.stop(),
    /resetCamera/i
  );
  assert.throws(
    () => controller.pause(),
    /playing/i
  );

  assert.equal(store.importAll({
    keyframes: [keyframe('one'), keyframe('two', 1)],
    nextIndex: 3
  }), true);
  assert.throws(
    () => controller.seekTo(-0.01),
    /from 0 through 1/i
  );
  assert.throws(
    () => controller.seekTo(1.01),
    /from 0 through 1/i
  );

  controller.stop({ resetCamera: false });
  controller.destroy();
});

test('natural playback completion remains at the final keyframe', () => {
  const originalPerformance = globalThis.performance;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  let nowMilliseconds = 0;
  const scheduledFrames = new Map();
  let nextFrameId = 1;

  globalThis.performance = { now: () => nowMilliseconds };
  globalThis.requestAnimationFrame = callback => {
    const id = nextFrameId++;
    scheduledFrames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => {
    scheduledFrames.delete(id);
  };

  try {
    const store = keyframeModule.createKeyframeStore();
    assert.equal(store.importAll({
      keyframes: [keyframe('one'), keyframe('two', 1)],
      nextIndex: 3
    }), true);

    const appliedStates = [];
    const controller = createPlaybackController({
      viewer: {
        setCameraState: state => appliedStates.push(state)
      },
      keyframeStore: store,
      getInterpolationOptions: () => ({
        positionMethod: 'linear',
        rotationMethod: 'linear',
        easing: 'linear',
        loop: false,
        autoPaceSpeed: 1
      })
    });

    controller.play();
    const [[frameId, frame]] = scheduledFrames;
    scheduledFrames.delete(frameId);
    nowMilliseconds = 1000;
    frame();

    assert.equal(controller.getState(), 'STOPPED');
    assert.equal(
      appliedStates.length,
      1,
      'completion must publish the exact final state once, without resetting to the start'
    );
    assert.deepEqual(appliedStates[0].orbit.target, [1, 0, 0]);
    assert.equal(appliedStates[0].orbit.radius, 4);

    controller.destroy();
  } finally {
    globalThis.performance = originalPerformance;
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
});

test('an explicit stop resets a scrubbed idle path to its first keyframe', () => {
  const store = keyframeModule.createKeyframeStore();
  assert.equal(store.importAll({
    keyframes: [keyframe('one'), keyframe('two', 1)],
    nextIndex: 3
  }), true);

  const appliedStates = [];
  const controller = createPlaybackController({
    viewer: {
      setCameraState: state => appliedStates.push(state)
    },
    keyframeStore: store,
    getInterpolationOptions: () => ({
      positionMethod: 'linear',
      rotationMethod: 'linear',
      easing: 'linear',
      loop: false,
      autoPaceSpeed: 1
    })
  });

  controller.seekTo(1);
  assert.deepEqual(appliedStates.at(-1).orbit.target, [1, 0, 0]);
  assert.equal(controller.getState(), 'STOPPED');

  controller.stop({ resetCamera: true });
  assert.deepEqual(
    appliedStates.at(-1).orbit.target,
    [0, 0, 0],
    'the explicit Stop command must honor its reset-to-start label after idle scrubbing'
  );
  controller.destroy();
});

test('camera playback internals expose one explicit current control contract', () => {
  for (const [label, source] of [
    ['playback controller', playbackControllerSource],
    ['transport bar', transportBarSource]
  ]) {
    assert.doesNotMatch(source, /options\s*=\s*\{\}/, `${label} has an implicit options default`);
    assert.doesNotMatch(source, /options\s*\|\|\s*\{\}/, `${label} normalizes invalid options`);
  }
  assert.doesNotMatch(
    playbackControllerSource,
    /keyframeStore\.(?:on|off)\?\./,
    'the keyframe-store event contract is required'
  );
  assert.doesNotMatch(
    transportBarSource,
    /getInterpolationOptions\s*\?/,
    'the interpolation-options provider is required'
  );
});

test('camera paths default to idle, restore autoplay transactionally, and reset with datasets', () => {
  const restoreStart = cameraModuleSource.indexOf('function restoreSessionState');
  const restoreEnd = cameraModuleSource.indexOf('\n  return {', restoreStart);
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart);

  const restoreBody = cameraModuleSource.slice(restoreStart, restoreEnd);
  assert.doesNotMatch(
    restoreBody,
    /playbackController\.play\s*\(/,
    'raw path restoration must not bypass the session transaction'
  );
  assert.doesNotMatch(
    cameraModuleSource,
    /^\s*transportBar\.create\(\);\s*$/m,
    'the top transport must not mount unconditionally'
  );
  assert.match(cameraModuleSource, /dataSourceManager\.onDatasetChange\(handleDatasetChange\)/);
  assert.match(cameraModuleSource, /dataSourceManager\.offDatasetChange\(handleDatasetChange\)/);
  assert.doesNotMatch(cameraModuleSource, /dataSourceManager\?\./);
  assert.match(uiCoordinatorSource, /initCinematicCamera\(\{[\s\S]*?dataSourceManager/);
  assert.match(indexHtml, /Autoplay is opt-in\./);
  assert.match(
    indexHtml,
    /id="cinematic-loop"[\s\S]*?Loop playback[\s\S]*?id="cinematic-autoplay"[\s\S]*?Autoplay/
  );
  assert.match(cameraModuleSource, /function startAutoplay\(\)/);
});

test('dataset publication restores only an integrity-pinned static sample view', () => {
  assert.doesNotMatch(mainSource, /restoreLatestFromDatasetExports/);
  assert.match(mainSource, /restoreCurrentDatasetState\(\{/);
  assert.match(
    datasetStateSource,
    /restorePublishedDefaultState[\s\S]*new Blob\(\[stateBytes\]/
  );
  assert.match(
    sessionSerializerSource,
    /Published default session must not contain cinematic camera data\./
  );
  assert.match(
    sessionSerializerSource,
    /manifestProfile:\s*'published-default'/
  );
});

test('the Camera Path DOM cache exposes only controls consumed by the current module', () => {
  const start = domCacheSource.indexOf('    cinematicCamera: {');
  const end = domCacheSource.indexOf('\n    },', start);
  assert.ok(start >= 0 && end > start);
  const cinematicDomCache = domCacheSource.slice(start, end);

  for (const obsoleteReference of [
    'section',
    'loopBackBtn',
    'interpolationSettings'
  ]) {
    assert.doesNotMatch(
      cinematicDomCache,
      new RegExp(`\\b${obsoleteReference}\\s*:`),
      `${obsoleteReference} is not part of the current Camera Path DOM contract`
    );
  }
});

test('top transport remains unmounted until two valid sidebar keyframes exist', async () => {
  const { createTransportBar } = await import(
    '../assets/js/app/ui/modules/cinematic-camera/transport-bar.js'
  );

  const originalDocument = globalThis.document;
  let createElementCalls = 0;
  globalThis.document = {
    activeElement: null,
    createElement() {
      createElementCalls++;
      throw new Error('transport attempted to mount');
    },
    getElementById() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {}
  };

  try {
    const store = keyframeModule.createKeyframeStore();
    const controller = createPlaybackController({
      viewer: { setCameraState() {} },
      keyframeStore: store,
      getInterpolationOptions: () => ({
        positionMethod: 'linear',
        rotationMethod: 'linear',
        easing: 'linear',
        loop: false,
        autoPaceSpeed: 1
      })
    });
    const transport = createTransportBar({
      playbackController: controller,
      keyframeStore: store,
      getInterpolationOptions: () => ({
        positionMethod: 'linear',
        rotationMethod: 'linear',
        easing: 'linear',
        loop: false,
        autoPaceSpeed: 1
      })
    });

    assert.throws(
      () => transport.updateVisibility(),
      /reveal/
    );
    transport.updateVisibility({ reveal: false });
    assert.equal(transport.isMounted(), false);
    assert.equal(createElementCalls, 0);

    assert.equal(store.importAll({ keyframes: [keyframe('one')], nextIndex: 2 }), true);
    transport.updateVisibility({ reveal: false });
    assert.equal(transport.isMounted(), false);
    assert.equal(createElementCalls, 0);

    assert.equal(
      store.importAll({
        keyframes: [keyframe('one'), keyframe('two', 1)],
        nextIndex: 3
      }),
      true
    );
    assert.throws(
      () => transport.updateVisibility({ reveal: false }),
      /transport attempted to mount/
    );
    assert.equal(createElementCalls, 1);

    transport.destroy();
    controller.destroy();
  } finally {
    if (originalDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
  }
});
