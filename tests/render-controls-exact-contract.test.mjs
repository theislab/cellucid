import assert from 'node:assert/strict';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { initRenderControls } from '../assets/js/app/ui/modules/render-controls.js';
import {
  SmokeDensityBuildError,
} from '../assets/js/rendering/smoke-cloud/smoke-density-contract.js';
import {
  MINIMUM_POINT_SIZE,
  POINT_SIZE_SLIDER_MINIMUM,
  formatPointSize,
  sliderPositionToPointSize,
} from '../assets/js/rendering/point-size-scale.js';

class FakeElement {
  constructor({
    value = '',
    min = '',
    max = '',
    step = '',
    checked = null,
    hidden = false,
  } = {}) {
    this.value = value;
    this.hidden = hidden;
    this.min = min;
    this.max = max;
    this.step = step;
    if (checked !== null) this.checked = checked;
    this.textContent = '';
    this.style = {};
    this.listeners = new Map();
    this.classList = {
      toggles: [],
      toggle: (name, force) => {
        this.classList.toggles.push([name, force]);
      },
    };
  }

  addEventListener(type, listener, options = {}) {
    if (options.signal?.aborted) return;
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
    if (options.signal) {
      options.signal.addEventListener(
        'abort',
        () => this.removeEventListener(type, listener),
        { once: true },
      );
    }
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter(candidate => candidate !== listener),
    );
  }

  dispatch(type) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ target: this });
    }
  }

  // Publishing a control value by dispatching the control's own event is the
  // ownership rule the session serializer follows, so the fake has to model it.
  dispatchEvent(event) {
    this.dispatch(event.type);
    return true;
  }
}

const INPUT_DEFAULTS = Object.freeze({
  pointSizeInput: ['16.5', '0.5', String(POINT_SIZE_SLIDER_MINIMUM)],
  lightingInput: ['60', '1'],
  fogInput: ['50', '1'],
  sizeAttenuationInput: ['80', '1'],
  smokeGridInput: ['80', '1'],
  smokeStepsInput: ['75', '1'],
  smokeDensityInput: ['56', '1'],
  smokeSpeedInput: ['40', '1'],
  smokeDetailInput: ['60', '1'],
  smokeWarpInput: ['10', '1'],
  smokeAbsorptionInput: ['65', '1'],
  smokeScatterInput: ['0', '1'],
  smokeEdgeInput: ['0', '1'],
  smokeDirectLightInput: ['3', '1'],
  cloudResolutionInput: ['15', '1'],
  noiseResolutionInput: ['58', '1'],
});

const DISPLAY_KEYS = Object.freeze([
  'pointSizeDisplay',
  'lightingDisplay',
  'fogDisplay',
  'sizeAttenuationDisplay',
  'smokeGridDisplay',
  'smokeStepsDisplay',
  'smokeDensityDisplay',
  'smokeSpeedDisplay',
  'smokeDetailDisplay',
  'smokeWarpDisplay',
  'smokeAbsorptionDisplay',
  'smokeScatterDisplay',
  'smokeEdgeDisplay',
  'smokeDirectLightDisplay',
  'cloudResolutionDisplay',
  'noiseResolutionDisplay',
]);

function makeDom() {
  const dom = {
    backgroundSelect: new FakeElement({ value: 'grid' }),
    renderModeSelect: new FakeElement({ value: 'points' }),
    renderModeMaturityTag: new FakeElement({ hidden: true }),
    depthControls: new FakeElement(),
    rendererControls: new FakeElement(),
    pointsControls: new FakeElement(),
    smokeControls: new FakeElement(),
    hpShaderQualitySelect: new FakeElement({ value: 'full' }),
    hpLodEnabledCheckbox: new FakeElement({ checked: false }),
    hpFrustumCullingCheckbox: new FakeElement({ checked: false }),
    hpLodForceInput: new FakeElement({
      value: '-1',
      min: '-1',
      max: '17',
      step: '1',
    }),
    hpLodForceContainer: new FakeElement(),
    hpLodForceDisplay: new FakeElement(),
    // Antialiasing is owned here too. It publishes to storage rather than to
    // the viewer because it is a context-creation attribute; its own behaviour
    // is held by `antialias-setting-contract.test.mjs`.
    hpAntialiasCheckbox: new FakeElement({ checked: true }),
    hpAntialiasStatus: new FakeElement(),
  };
  for (const [key, [value, step, min = '0']] of Object.entries(INPUT_DEFAULTS)) {
    dom[key] = new FakeElement({
      value,
      min,
      max: '100',
      step,
    });
  }
  for (const key of DISPLAY_KEYS) {
    dom[key] = new FakeElement();
  }
  return dom;
}

function makeViewer({
  hasSnapshots = false,
  antialiasingAvailable = true,
} = {}) {
  const calls = [];
  let antialiasing = false;
  const viewer = {
    calls,
    setBackground(value) {
      calls.push(['setBackground', value]);
    },
    setRenderMode(value) {
      calls.push(['setRenderMode', value]);
    },
    setPointSize(value) {
      calls.push(['setPointSize', value]);
    },
    setLightingStrength(value) {
      calls.push(['setLightingStrength', value]);
    },
    setFogDensity(value) {
      calls.push(['setFogDensity', value]);
    },
    setSizeAttenuation(value) {
      calls.push(['setSizeAttenuation', value]);
    },
    setSmokeParams(value) {
      calls.push(['setSmokeParams', value]);
    },
    setCloudResolutionScale(value) {
      calls.push(['setCloudResolutionScale', value]);
    },
    setNoiseTextureResolution(value) {
      calls.push(['setNoiseTextureResolution', value]);
    },
    setShaderQuality(value) {
      calls.push(['setShaderQuality', value]);
    },
    setAdaptiveLOD(value) {
      calls.push(['setAdaptiveLOD', value]);
    },
    setForceLOD(value) {
      calls.push(['setForceLOD', value]);
    },
    setFrustumCulling(value) {
      calls.push(['setFrustumCulling', value]);
    },
    getAdaptiveScaleFactor() {
      calls.push(['getAdaptiveScaleFactor']);
      return 1;
    },
    hasSnapshots() {
      calls.push(['hasSnapshots']);
      return hasSnapshots;
    },
    setAntialiasing(value) {
      calls.push(['setAntialiasing', value]);
      antialiasing = value;
      return value;
    },
    getAntialiasing() {
      return antialiasing;
    },
    isAntialiasingAvailable() {
      return antialiasingAvailable;
    },
  };
  return viewer;
}

function installDocument(background = 'grid', storage = null) {
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: {
      documentElement: {
        dataset: {
          viewerBackground: background,
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage ?? {
      getItem() {
        return null;
      },
      setItem() {
      },
      removeItem() {
      },
    },
  });
  return () => {
    if (priorDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', priorDocument);
    if (priorStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', priorStorage);
  };
}

function makeOptions(viewerOptions, rebuild = null) {
  const viewer = makeViewer(viewerOptions);
  const dom = makeDom();
  const smokeCalls = [];
  const smoke = {
    rebuildSmokeDensity(gridSize) {
      smokeCalls.push(gridSize);
      if (rebuild !== null) return rebuild(gridSize);
    },
  };
  return { viewer, dom, smoke, smokeCalls };
}

test('render controls reject obsolete or open initialization options before mutation', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();

  assert.throws(
    () => initRenderControls({
      viewer,
      dom,
      smoke,
      legacyMode: true,
    }),
    /unexpected.*legacyMode|exact.*keys/i,
  );
  assert.deepEqual(viewer.calls, []);
});

test('render controls preflight every range before any viewer mutation', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  dom.smokeDirectLightInput.value = '12px';

  assert.throws(
    () => initRenderControls({ viewer, dom, smoke }),
    /direct light.*exact finite decimal/i,
  );
  assert.deepEqual(viewer.calls, []);
});

test('render controls require the validated bootstrap background exactly', t => {
  const restore = installDocument('sepia');
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();

  assert.throws(
    () => initRenderControls({ viewer, dom, smoke }),
    /viewer background.*grid.*grid-dark.*white.*black/i,
  );
  assert.deepEqual(viewer.calls, []);
});

test('render controls reject unknown initial render mode instead of choosing points', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  dom.renderModeSelect.value = 'legacy-points';

  assert.throws(
    () => initRenderControls({ viewer, dom, smoke }),
    /render mode.*points.*smoke/i,
  );
  assert.deepEqual(viewer.calls, []);
});

test('range event failures propagate without publishing substituted values', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  initRenderControls({ viewer, dom, smoke });
  const callsBefore = viewer.calls.length;

  dom.fogInput.value = '101';
  assert.throws(
    () => dom.fogInput.dispatch('input'),
    /fog.*between 0 and 100/i,
  );
  assert.equal(viewer.calls.length, callsBefore);
});

test('background persistence failure preserves the current viewer state', t => {
  const storageFailure = new Error('browser storage write error');
  const restore = installDocument('grid', {
    getItem() {
      return null;
    },
    setItem() {
      throw storageFailure;
    },
    removeItem() {
    },
  });
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  initRenderControls({ viewer, dom, smoke });
  const callsBefore = viewer.calls.length;

  dom.backgroundSelect.value = 'black';
  assert.throws(
    () => dom.backgroundSelect.dispatch('change'),
    error => error === storageFailure,
  );
  assert.equal(dom.backgroundSelect.value, 'grid');
  assert.equal(globalThis.document.documentElement.dataset.viewerBackground, 'grid');
  assert.equal(viewer.calls.length, callsBefore);
});

test('public point-size conversion rejects out-of-contract values', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });

  assert.throws(
    () => controls.pointSizeToSlider(0),
    /point size.*between 0\.050 and 200/i,
  );
  assert.throws(
    () => controls.pointSizeToSlider(Number.NaN),
    /point size.*finite number/i,
  );

  // The slider's zero position is the curve's anchor, not its minimum: every
  // position that was ever stored still means exactly the size it meant, and
  // the reach below 0.25 is added under it rather than folded into it.
  assert.equal(controls.pointSizeToSlider(0.25), 0);
  assert.equal(controls.pointSizeToSlider(200), 100);
  for (const position of [-24, -12, 0, 16.5, 50, 100]) {
    assert.ok(
      Math.abs(
        controls.pointSizeToSlider(sliderPositionToPointSize(position))
        - position,
      ) < 1e-9,
      `slider position ${position} must survive a round trip`,
    );
  }
  assert.ok(MINIMUM_POINT_SIZE < 0.0503 && MINIMUM_POINT_SIZE > 0.05);
  assert.equal(formatPointSize(MINIMUM_POINT_SIZE), '0.050');
  assert.equal(
    Number(sliderPositionToPointSize(16.5).toFixed(4)),
    0.7533,
  );
});

test('a dataset opens at the point size its cell count wants', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });

  // Total drawn area is cellCount * diameter^2, so four times the cells is half
  // the dot. One shipped constant cannot serve a 3,696-cell trajectory and an
  // 18-million-cell atlas at once.
  const sizeFor = cellCount => sliderPositionToPointSize(
    controls.pointSizeSliderPositionForCellCount(cellCount),
  );
  const trajectory = sizeFor(3_696);
  const atlas = sizeFor(18_142_044);
  assert.ok(trajectory > 4, `${trajectory} is not large enough for 3,696 cells`);
  assert.ok(atlas < 0.15, `${atlas} is not small enough for 18.1M cells`);
  assert.ok(
    Math.abs(sizeFor(400_000) - 0.75) < 0.03,
    'around 400,000 cells must reproduce the size this control shipped with',
  );
  for (const cellCount of [1, 1_000, 10_000, 1_000_000, 500_000_000]) {
    const position = controls.pointSizeSliderPositionForCellCount(cellCount);
    assert.ok(position >= POINT_SIZE_SLIDER_MINIMUM && position <= 100);
    assert.equal(
      Math.abs(position % 0.5),
      0,
      `${position} is off the slider step`,
    );
  }
  assert.throws(
    () => controls.pointSizeSliderPositionForCellCount(0),
    /positive safe integer cell count/i,
  );

  // Publication goes through the control's own input event, so every other
  // owner of that slider sees it the way it sees a drag.
  viewer.calls.length = 0;
  const published = controls.applyAutomaticPointSize(18_142_044);
  const publishedPosition = Number(dom.pointSizeInput.value);
  assert.equal(
    Math.abs(publishedPosition % 0.5),
    0,
    'the published position must survive the next exact range read',
  );
  assert.equal(published, sliderPositionToPointSize(publishedPosition));
  assert.ok(published < 0.15, `${published} is not small enough for 18.1M cells`);
  assert.deepEqual(
    viewer.calls.filter(([method]) => method === 'setPointSize'),
    [['setPointSize', published]],
  );
  assert.equal(dom.pointSizeDisplay.textContent, formatPointSize(published));
});

test('smoke conflicts notify and roll back the selector while the public owner rejects', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke, smokeCalls } = makeOptions({ hasSnapshots: true });
  const controls = initRenderControls({ viewer, dom, smoke });
  const notificationCenter = getNotificationCenter();
  const originalWarning = notificationCenter.warning;
  const warnings = [];
  notificationCenter.warning = (message, options) => {
    warnings.push([message, options]);
  };
  t.after(() => {
    notificationCenter.warning = originalWarning;
  });

  dom.renderModeSelect.value = 'smoke';
  dom.renderModeSelect.dispatch('change');
  assert.equal(dom.renderModeSelect.value, 'points');
  assert.deepEqual(smokeCalls, []);
  assert.equal(
    viewer.calls.filter(([method, value]) => method === 'setRenderMode' && value === 'smoke').length,
    0,
  );
  assert.deepEqual(warnings, [[
    'Volumetric smoke requires a single view. Clear snapshots first.',
    { category: 'rendering' },
  ]]);

  assert.throws(
    () => controls.applyRenderMode('smoke'),
    /smoke render mode.*snapshots/i,
  );
});

test('public smoke rebuild requires one explicit exact grid size', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke, smokeCalls } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });

  assert.throws(
    () => controls.rebuildSmokeDensity(),
    /grid size.*integer.*8 through 128/i,
  );
  assert.throws(
    () => controls.rebuildSmokeDensity('128'),
    /grid size.*integer.*8 through 128/i,
  );
  assert.throws(
    () => controls.rebuildSmokeDensity(129),
    /grid size.*integer.*8 through 128/i,
  );
  controls.rebuildSmokeDensity(128);
  assert.deepEqual(smokeCalls, [128]);
});

test('smoke grid defaults to bounded 128³ and exposes no oversized UI choice', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });

  assert.equal(controls.getSmokeGridSize(), 128);
  assert.equal(dom.smokeGridDisplay.textContent, '128³');
});

test('smoke render resolution exposes an exact native detent and exact endpoints', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  initRenderControls({ viewer, dom, smoke });

  const expectations = [
    ['0', 0.25, '0.25x'],
    ['42', 0.985, '0.98x'],
    ['43', 1, '1.00x'],
    ['44', 1.02, '1.02x'],
    ['100', 2, '2.00x'],
  ];
  for (const [raw, exactScale, display] of expectations) {
    dom.cloudResolutionInput.value = raw;
    dom.cloudResolutionInput.dispatch('input');
    assert.deepEqual(
      viewer.calls
        .filter(([name]) => name === 'setCloudResolutionScale')
        .at(-1),
      ['setCloudResolutionScale', exactScale],
    );
    assert.equal(dom.cloudResolutionDisplay.textContent, display);
  }
});

test('late-bound render-mode observer covers programmatic and DOM publications exactly', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });
  const observed = [];

  assert.throws(
    () => controls.setRenderModeChangeHandler(null),
    /render-mode change handler.*exact function/i,
  );
  controls.setRenderModeChangeHandler(mode => {
    observed.push([mode, dom.renderModeSelect.value]);
  });

  assert.equal(controls.applyRenderMode('smoke'), true);
  dom.renderModeSelect.value = 'points';
  dom.renderModeSelect.dispatch('change');

  assert.deepEqual(observed, [
    ['smoke', 'smoke'],
    ['points', 'points'],
  ]);
});

test('render-mode observer failure cannot veto the committed viewer and DOM mode', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });
  const failure = new Error('synthetic render-mode observer failure');
  const priorQueueMicrotask = Object.getOwnPropertyDescriptor(
    globalThis,
    'queueMicrotask',
  );
  const deferred = [];
  Object.defineProperty(globalThis, 'queueMicrotask', {
    configurable: true,
    writable: true,
    value(callback) {
      deferred.push(callback);
    },
  });
  t.after(() => {
    if (priorQueueMicrotask === undefined) {
      delete globalThis.queueMicrotask;
    } else {
      Object.defineProperty(
        globalThis,
        'queueMicrotask',
        priorQueueMicrotask,
      );
    }
  });
  controls.setRenderModeChangeHandler(() => {
    throw failure;
  });

  assert.equal(controls.applyRenderMode('smoke'), true);
  assert.equal(dom.renderModeSelect.value, 'smoke');
  assert.deepEqual(
    viewer.calls.filter(([name]) => name === 'setRenderMode').at(-1),
    ['setRenderMode', 'smoke'],
  );
  assert.equal(deferred.length, 1);
  assert.throws(
    () => deferred[0](),
    error => error === failure,
  );
});

test('failed smoke entry rolls every visible control back to points', t => {
  const restore = installDocument();
  t.after(restore);
  const failure = new SmokeDensityBuildError(
    'synthetic unavailable smoke renderer',
    new Error('synthetic GPU capability failure'),
  );
  const { viewer, dom, smoke } = makeOptions(
    undefined,
    () => {
      throw failure;
    },
  );
  initRenderControls({ viewer, dom, smoke });

  dom.renderModeSelect.value = 'smoke';
  assert.doesNotThrow(() => dom.renderModeSelect.dispatch('change'));
  assert.equal(dom.renderModeSelect.value, 'points');
  assert.deepEqual(
    viewer.calls.filter(([name]) => name === 'setRenderMode').at(-1),
    ['setRenderMode', 'points'],
  );
  assert.deepEqual(dom.smokeControls.classList.toggles.at(-1), [
    'visible',
    false,
  ]);
  assert.deepEqual(dom.pointsControls.classList.toggles.at(-1), [
    'visible',
    true,
  ]);
  assert.equal(dom.depthControls.style.display, 'block');
  assert.equal(dom.rendererControls.style.display, 'block');
});

test('runtime smoke failure settlement synchronizes UI without republishing viewer state', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });
  const observedModes = [];
  controls.setRenderModeChangeHandler(mode => {
    observedModes.push(mode);
  });
  controls.applyRenderMode('smoke');
  const setModeCallsBefore = viewer.calls.filter(
    ([name]) => name === 'setRenderMode'
  ).length;
  const notificationCenter = getNotificationCenter();
  const originalError = notificationCenter.error;
  const notifications = [];
  notificationCenter.error = (message, options) => {
    notifications.push([message, options]);
  };
  t.after(() => {
    notificationCenter.error = originalError;
  });

  controls.settleSmokeRenderFailure(
    new Error('synthetic ray-march failure')
  );

  assert.equal(dom.renderModeSelect.value, 'points');
  assert.deepEqual(dom.smokeControls.classList.toggles.at(-1), [
    'visible',
    false,
  ]);
  assert.deepEqual(dom.pointsControls.classList.toggles.at(-1), [
    'visible',
    true,
  ]);
  assert.equal(dom.depthControls.style.display, 'block');
  assert.equal(dom.rendererControls.style.display, 'block');
  assert.equal(
    viewer.calls.filter(([name]) => name === 'setRenderMode').length,
    setModeCallsBefore,
  );
  assert.deepEqual(observedModes, ['smoke', 'points']);
  assert.deepEqual(notifications, [[
    'Smoke rendering failed: synthetic ray-march failure',
    { category: 'rendering' },
  ]]);
});

test('committed smoke changes coalesce and rebuild after one paint generation', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke, smokeCalls } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });

  controls.applyRenderMode('smoke');
  smokeCalls.length = 0;
  const currentGridSize = controls.getSmokeGridSize();

  const originalSetTimeout = globalThis.setTimeout;
  let debounceScheduled = false;
  globalThis.setTimeout = () => {
    debounceScheduled = true;
    return 1;
  };
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
  });
  const priorRequestAnimationFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    'requestAnimationFrame',
  );
  const frameCallbacks = [];
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value(callback) {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    },
  });
  t.after(() => {
    if (priorRequestAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      Object.defineProperty(
        globalThis,
        'requestAnimationFrame',
        priorRequestAnimationFrame,
      );
    }
  });

  controls.markSmokeDirty();
  controls.markSmokeDirty();
  controls.markSmokeDirty();

  assert.equal(debounceScheduled, false);
  assert.deepEqual(smokeCalls, []);
  assert.equal(frameCallbacks.length, 1);
  frameCallbacks.shift()(1);
  assert.deepEqual(smokeCalls, []);
  assert.equal(frameCallbacks.length, 1);
  frameCallbacks.shift()(2);
  assert.deepEqual(smokeCalls, [currentGridSize]);
});

test('render-control destroy cancels and fences debounce and first-frame owners', t => {
  const restore = installDocument();
  t.after(restore);
  const priorSetTimeout = globalThis.setTimeout;
  const priorClearTimeout = globalThis.clearTimeout;
  const priorRequestAnimationFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    'requestAnimationFrame',
  );
  const priorCancelAnimationFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    'cancelAnimationFrame',
  );
  let nextOwnerId = 1;
  const timeoutCallbacks = new Map();
  const frameCallbacks = new Map();
  const cancelledTimeouts = [];
  const cancelledFrames = [];
  globalThis.setTimeout = callback => {
    const id = nextOwnerId++;
    timeoutCallbacks.set(id, callback);
    return id;
  };
  globalThis.clearTimeout = id => {
    cancelledTimeouts.push(id);
  };
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value(callback) {
      const id = nextOwnerId++;
      frameCallbacks.set(id, callback);
      return id;
    },
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value(id) {
      cancelledFrames.push(id);
    },
  });
  t.after(() => {
    globalThis.setTimeout = priorSetTimeout;
    globalThis.clearTimeout = priorClearTimeout;
    if (priorRequestAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      Object.defineProperty(
        globalThis,
        'requestAnimationFrame',
        priorRequestAnimationFrame,
      );
    }
    if (priorCancelAnimationFrame === undefined) {
      delete globalThis.cancelAnimationFrame;
    } else {
      Object.defineProperty(
        globalThis,
        'cancelAnimationFrame',
        priorCancelAnimationFrame,
      );
    }
  });

  const { viewer, dom, smoke, smokeCalls } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });
  controls.applyRenderMode('smoke');
  smokeCalls.length = 0;

  dom.smokeGridInput.value = '0';
  dom.smokeGridInput.dispatch('input');
  const timeoutOwner = [...timeoutCallbacks.keys()][0];
  assert.equal(Number.isInteger(timeoutOwner), true);

  controls.markSmokeDirty();
  const firstFrameOwner = [...frameCallbacks.keys()][0];
  assert.deepEqual(cancelledTimeouts, [timeoutOwner]);
  assert.equal(Number.isInteger(firstFrameOwner), true);

  controls.destroy();
  controls.destroy();

  assert.deepEqual(cancelledFrames, [firstFrameOwner]);
  const viewerCallCount = viewer.calls.length;
  dom.pointSizeInput.value = '50';
  dom.pointSizeInput.dispatch('input');
  assert.equal(viewer.calls.length, viewerCallCount);

  timeoutCallbacks.get(timeoutOwner)();
  frameCallbacks.get(firstFrameOwner)(1);
  assert.deepEqual(smokeCalls, []);
  assert.equal(frameCallbacks.size, 1);
});

test('render-control destroy cancels and fences the nested rebuild frame', t => {
  const restore = installDocument();
  t.after(restore);
  const priorRequestAnimationFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    'requestAnimationFrame',
  );
  const priorCancelAnimationFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    'cancelAnimationFrame',
  );
  let nextFrameId = 1;
  const frameCallbacks = new Map();
  const cancelledFrames = [];
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value(callback) {
      const id = nextFrameId++;
      frameCallbacks.set(id, callback);
      return id;
    },
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value(id) {
      cancelledFrames.push(id);
    },
  });
  t.after(() => {
    if (priorRequestAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      Object.defineProperty(
        globalThis,
        'requestAnimationFrame',
        priorRequestAnimationFrame,
      );
    }
    if (priorCancelAnimationFrame === undefined) {
      delete globalThis.cancelAnimationFrame;
    } else {
      Object.defineProperty(
        globalThis,
        'cancelAnimationFrame',
        priorCancelAnimationFrame,
      );
    }
  });

  const { viewer, dom, smoke, smokeCalls } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });
  controls.applyRenderMode('smoke');
  smokeCalls.length = 0;
  controls.markSmokeDirty();

  frameCallbacks.get(1)(1);
  assert.equal(frameCallbacks.has(2), true);
  controls.destroy();
  controls.destroy();
  assert.deepEqual(cancelledFrames, [2]);

  frameCallbacks.get(2)(2);
  assert.deepEqual(smokeCalls, []);
});

test('a failed committed smoke rebuild settles inside its frame owner', t => {
  const restore = installDocument();
  t.after(restore);
  let failRebuild = false;
  const { viewer, dom, smoke } = makeOptions(
    undefined,
    () => {
      if (failRebuild) {
        throw new SmokeDensityBuildError(
          'synthetic scheduled smoke failure',
          new Error('synthetic scheduled GPU failure'),
        );
      }
    },
  );
  const controls = initRenderControls({ viewer, dom, smoke });
  controls.applyRenderMode('smoke');
  failRebuild = true;

  const priorRequestAnimationFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    'requestAnimationFrame',
  );
  const frameCallbacks = [];
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value(callback) {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    },
  });
  t.after(() => {
    if (priorRequestAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      Object.defineProperty(
        globalThis,
        'requestAnimationFrame',
        priorRequestAnimationFrame,
      );
    }
  });

  controls.markSmokeDirty();
  frameCallbacks.shift()(1);
  assert.doesNotThrow(() => frameCallbacks.shift()(2));
  assert.equal(dom.renderModeSelect.value, 'points');
  assert.deepEqual(
    viewer.calls.filter(([name]) => name === 'setRenderMode').at(-1),
    ['setRenderMode', 'points'],
  );
});

test('current render-control source contains no normalization/default route', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(
      new URL('../assets/js/app/ui/modules/render-controls.js', import.meta.url),
      'utf8',
    )
  );
  const numberUtils = await import('node:fs/promises').then(({ readFile }) =>
    readFile(
      new URL('../assets/js/app/utils/number-utils.js', import.meta.url),
      'utf8',
    )
  );

  assert.doesNotMatch(
    source,
    /safeGetStoredViewerBackground|normalizeViewerBackground|clampNormalized|DEFAULT_POINT_SIZE|\?\.\(|set[A-Z][A-Za-z]+\?\./,
  );
  assert.doesNotMatch(
    source,
    /gridSizeOverride\s*===\s*undefined\s*\?\s*smokeGridSize/,
  );
  assert.doesNotMatch(numberUtils, /export function clampNormalized\\b/);
});

test('the maturity tag names the selected mode, not the control', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });

  // `Points` is finished; `Volumetric smoke cloud` is not. A tag next to the
  // label would otherwise read as a property of the whole control.
  assert.equal(dom.renderModeMaturityTag.hidden, true);
  assert.equal(controls.applyRenderMode('smoke'), true);
  assert.equal(dom.renderModeMaturityTag.hidden, false);
  assert.equal(controls.applyRenderMode('points'), true);
  assert.equal(dom.renderModeMaturityTag.hidden, true);

  // A smoke failure settles the UI back to points, so the tag has to go with it.
  const notificationCenter = getNotificationCenter();
  const originalError = notificationCenter.error;
  notificationCenter.error = () => {};
  t.after(() => {
    notificationCenter.error = originalError;
  });
  controls.applyRenderMode('smoke');
  assert.equal(dom.renderModeMaturityTag.hidden, false);
  controls.settleSmokeRenderFailure(new Error('synthetic smoke failure'));
  assert.equal(dom.renderModeMaturityTag.hidden, true);
});
