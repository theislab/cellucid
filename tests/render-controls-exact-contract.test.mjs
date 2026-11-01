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

  // A person's event is trusted (`isTrusted`); one a module dispatches is not.
  dispatch(type, { isTrusted = true } = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ target: this, isTrusted });
    }
  }

  // Publishing a control value by dispatching the control's own event is the
  // ownership rule the session serializer follows, so the fake has to model it.
  dispatchEvent(event) {
    this.dispatch(event.type, { isTrusted: false });
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

/** A measured frame time as the viewer reports it: bounds, exact for a number. */
function boundsOf(milliseconds) {
  return typeof milliseconds === 'number' ? { lo: milliseconds, hi: milliseconds } : milliseconds;
}

function makeDom() {
  const dom = {
    backgroundSelect: new FakeElement({ value: 'grid' }),
    renderModeSelect: new FakeElement({ value: 'points' }),
    renderModeMaturityTag: new FakeElement({ hidden: true }),
    depthControls: new FakeElement(),
    rendererControls: new FakeElement(),
    pointsControls: new FakeElement(),
    pointsPerformanceControls: new FakeElement(),
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
    hpPerformanceStatus: new FakeElement(),
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
  smokeSupport = { supported: true, reason: null, message: null, detail: null },
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
    getSmokeSupport() {
      calls.push(['getSmokeSupport']);
      return smokeSupport;
    },
    setShaderQuality(value) {
      calls.push(['setShaderQuality', value]);
    },
    setAdaptiveLOD(value) {
      calls.push(['setAdaptiveLOD', value]);
      viewer.emitPerformanceSettings();
    },
    lodLevelCount: 18,
    getLODLevelCount() {
      return viewer.lodLevelCount;
    },
    setForceLOD(value) {
      calls.push(['setForceLOD', value]);
    },
    setFrustumCulling(value) {
      calls.push(['setFrustumCulling', value]);
      viewer.emitPerformanceSettings();
    },
    /** The opening measured now, as the viewer numbers each one it arms. */
    opening: 1,
    settingsListeners: new Set(),
    onPerformanceSettingsChanged(listener) {
      viewer.settingsListeners.add(listener);
      return () => viewer.settingsListeners.delete(listener);
    },
    emitPerformanceSettings() {
      for (const listener of [...viewer.settingsListeners]) listener({ opening: viewer.opening });
    },
    frameCostListeners: new Set(),
    onFullDetailFrameCost(listener) {
      viewer.frameCostListeners.add(listener);
      return () => viewer.frameCostListeners.delete(listener);
    },
    measureFullDetailFrameCost() {
      calls.push(['measureFullDetailFrameCost']);
      viewer.reportMeasuring();
    },
    verifyFullDetailFrameCost() {
      calls.push(['verifyFullDetailFrameCost']);
    },
    /**
     * As the viewer does when it starts a measurement (a dataset published,
     * cells grown, another representation, a restored context, a framing):
     * a new opening, said before it is measured.
     */
    reportMeasuring() {
      viewer.opening += 1;
      for (const listener of [...viewer.frameCostListeners]) {
        listener({ kind: 'measuring', opening: viewer.opening });
      }
    },
    /**
     * As the viewer does once a full-detail frame is measured too slow
     * (`cullable`: a cell of the frames measured may lie outside its view).
     */
    reportFullDetailFrameCost(milliseconds, { cullable = true } = {}) {
      const frame = boundsOf(milliseconds);
      for (const listener of [...viewer.frameCostListeners]) {
        listener({ kind: 'too-slow', opening: viewer.opening, frame, gpu: frame, budgetMilliseconds: 1000 / 30, cullable });
      }
    },
    /** As the viewer does when nothing the page could turn on draws fewer cells. */
    reportNothingFewer() {
      for (const listener of [...viewer.frameCostListeners]) {
        listener({ kind: 'nothing-fewer', opening: viewer.opening });
      }
    },
    /** As the viewer does once the frames drawn with the choice are measured. */
    reportVerified(verdict, milliseconds, fullMilliseconds) {
      for (const listener of [...viewer.frameCostListeners]) {
        listener({ kind: 'verified', opening: viewer.opening, verdict, frame: boundsOf(milliseconds), fullFrame: boundsOf(fullMilliseconds) });
      }
    },
    presentedListeners: new Set(),
    onPresentedViewStateChanged(listener) {
      viewer.presentedListeners.add(listener);
      return () => viewer.presentedListeners.delete(listener);
    },
    emitPresented(reason) {
      for (const listener of [...viewer.presentedListeners]) listener({ generation: 1, reason, viewId: 'live' });
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
    /viewer background must be exactly one of "white", "grid", "studio", "atelier", "abyss", "aurora", "black", "grid-dark", "studio-dark", "nebula", "abyss-dark", "aurora-dark"/i,
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

test('level of detail and culling turn on when a full-detail frame is measured too slow; a person\'s choice stands; the next dataset is measured afresh', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });
  const toggles = () => viewer.calls.filter(([method]) => method === 'setAdaptiveLOD' || method === 'setFrustumCulling');

  viewer.calls.length = 0;
  viewer.reportFullDetailFrameCost(120);
  assert.deepEqual(toggles(), [['setAdaptiveLOD', true], ['setFrustumCulling', true]]);
  assert.equal(dom.hpLodEnabledCheckbox.checked, true);
  assert.equal(dom.hpFrustumCullingCheckbox.checked, true);
  // Kept only once its frames are measured faster.
  assert.deepEqual(viewer.calls.at(-1), ['verifyFullDetailFrameCost']);
  assert.match(dom.hpPerformanceStatus.textContent, /120 ms here; measuring level of detail and frustum culling/);
  viewer.reportVerified('faster', 40, 120);
  assert.equal(dom.hpLodEnabledCheckbox.checked, true);
  assert.match(dom.hpPerformanceStatus.textContent, /120 ms.*33 ms.*40 ms with level of detail and frustum culling/);

  // The next dataset: back off before it is measured, and fast enough stays off.
  viewer.calls.length = 0;
  viewer.reportMeasuring();
  assert.deepEqual(toggles(), [['setAdaptiveLOD', false], ['setFrustumCulling', false]]);
  assert.equal(dom.hpPerformanceStatus.textContent, '');

  // A person turns level of detail on, then off: their choice stands.
  dom.hpLodEnabledCheckbox.checked = true;
  dom.hpLodEnabledCheckbox.dispatch('change');
  dom.hpLodEnabledCheckbox.checked = false;
  dom.hpLodEnabledCheckbox.dispatch('change');
  viewer.calls.length = 0;
  viewer.reportFullDetailFrameCost(400);
  assert.deepEqual(toggles(), []);
  assert.equal(dom.hpLodEnabledCheckbox.checked, false);
  viewer.reportMeasuring();
  assert.deepEqual(toggles(), []);
  controls.destroy();
  assert.equal(viewer.frameCostListeners.size, 0);
});

test('an automatic choice measured no faster is turned off again, and the next framing is measured afresh', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });
  const toggles = () => viewer.calls.filter(([method]) => method === 'setAdaptiveLOD' || method === 'setFrustumCulling');
  // A 2D view at full framing: level of detail stays at every cell and
  // culling only costs (721 ms against 438 ms measured on software GL).
  viewer.calls.length = 0;
  viewer.reportFullDetailFrameCost(438);
  viewer.reportVerified('not-faster', 721, 438);
  assert.deepEqual(toggles(), [
    ['setAdaptiveLOD', true], ['setFrustumCulling', true],
    ['setAdaptiveLOD', false], ['setFrustumCulling', false],
  ]);
  assert.equal(dom.hpLodEnabledCheckbox.checked, false);
  assert.equal(dom.hpFrustumCullingCheckbox.checked, false);
  assert.equal(dom.hpPerformanceStatus.textContent, 'Every cell drawn: level of detail and frustum culling measured 721 ms a frame against 438 ms without, no faster here. Measured again when the view moves.');
  // Nothing more to undo at the next opening.
  viewer.calls.length = 0;
  // A style change is no new framing; a camera that moved and settled is.
  viewer.emitPresented('style');
  assert.deepEqual(viewer.calls, []);
  viewer.emitPresented('camera-settled');
  assert.deepEqual(viewer.calls, [['measureFullDetailFrameCost']]);
  assert.equal(viewer.presentedListeners.size, 0, 'one re-measurement a framing');
  // Zoomed in, culling gains: kept.
  viewer.calls.length = 0;
  viewer.reportFullDetailFrameCost(300);
  viewer.reportVerified('faster', 90, 300);
  assert.deepEqual(toggles(), [['setAdaptiveLOD', true], ['setFrustumCulling', true]]);
  assert.equal(dom.hpFrustumCullingCheckbox.checked, true);
  controls.destroy();
  assert.equal(viewer.presentedListeners.size, 0);
});

test('a caller that sets level of detail or culling itself makes its opening\'s choice; the next opening is measured as any', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });
  const toggles = () => viewer.calls.filter(([method]) => method === 'setAdaptiveLOD' || method === 'setFrustumCulling');
  // Turned on by this page, then a caller (a benchmark configuration, a
  // test) sets culling while the choice is being verified: the verdict of
  // that opening changes nothing the caller set.
  viewer.reportFullDetailFrameCost(400);
  assert.equal(dom.hpFrustumCullingCheckbox.checked, true);
  viewer.setFrustumCulling(true);
  viewer.calls.length = 0;
  viewer.reportVerified('not-faster', 500, 400);
  assert.deepEqual(toggles(), []);
  assert.equal(dom.hpPerformanceStatus.textContent, '');
  // A caller's setting that equals the boxes' is a choice too: a report
  // later in the same opening turns nothing on.
  viewer.setAdaptiveLOD(false);
  viewer.calls.length = 0;
  viewer.reportFullDetailFrameCost(400);
  assert.deepEqual(toggles(), []);
  // The framing this page waited for is not measured.
  viewer.emitPresented('camera-settled');
  assert.deepEqual(viewer.calls.filter(([method]) => method === 'measureFullDetailFrameCost'), []);
  // The next opening: what this page turned on is turned off, and its
  // measurement decides again.
  viewer.calls.length = 0;
  viewer.reportMeasuring();
  assert.deepEqual(toggles(), [['setAdaptiveLOD', false], ['setFrustumCulling', false]]);
  viewer.calls.length = 0;
  viewer.reportFullDetailFrameCost(400);
  assert.deepEqual(toggles(), [['setAdaptiveLOD', true], ['setFrustumCulling', true]]);
  controls.destroy();
  assert.equal(viewer.settingsListeners.size, 0);
});

test('every new measurement re-verifies this page\'s own choice as at an opening (a restored context, another representation); a person\'s choice is left alone', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });
  const toggles = () => viewer.calls.filter(([method]) => method === 'setAdaptiveLOD' || method === 'setFrustumCulling');
  viewer.reportFullDetailFrameCost(120);
  viewer.reportVerified('faster', 40, 120);
  assert.equal(dom.hpFrustumCullingCheckbox.checked, true);
  // A restored context (or a representation) is measured afresh: the choice
  // goes off for the frames of every cell...
  viewer.calls.length = 0;
  viewer.reportMeasuring();
  assert.deepEqual(toggles(), [['setAdaptiveLOD', false], ['setFrustumCulling', false]]);
  assert.equal(dom.hpPerformanceStatus.textContent, '');
  // ...then on again and verified, not kept unverified.
  viewer.calls.length = 0;
  viewer.reportFullDetailFrameCost(130);
  assert.deepEqual(toggles(), [['setAdaptiveLOD', true], ['setFrustumCulling', true]]);
  assert.deepEqual(viewer.calls.at(-1), ['verifyFullDetailFrameCost']);
  // No faster on the new basis: off.
  viewer.reportVerified('not-faster', 128, 130);
  assert.equal(dom.hpLodEnabledCheckbox.checked, false);
  assert.equal(dom.hpFrustumCullingCheckbox.checked, false);
  // Nothing of this page's left on: the next measurement turns nothing off.
  viewer.calls.length = 0;
  viewer.reportMeasuring();
  assert.deepEqual(toggles(), []);
  // A person's choice is never undone by a measurement.
  dom.hpFrustumCullingCheckbox.checked = true;
  dom.hpFrustumCullingCheckbox.dispatch('change');
  viewer.calls.length = 0;
  viewer.reportMeasuring();
  viewer.reportFullDetailFrameCost(400);
  assert.deepEqual(toggles(), []);
  assert.equal(dom.hpFrustumCullingCheckbox.checked, true);
  controls.destroy();
});

test('below the ladder\'s first count a slow frame turns culling on, not level of detail (every level is every cell)', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });
  const toggles = () => viewer.calls.filter(([method]) => method === 'setAdaptiveLOD' || method === 'setFrustumCulling');
  viewer.lodLevelCount = 1;
  viewer.calls.length = 0;
  viewer.reportFullDetailFrameCost(120);
  assert.deepEqual(toggles(), [['setFrustumCulling', true]]);
  assert.equal(dom.hpLodEnabledCheckbox.checked, false);
  viewer.reportVerified('faster', 60, 120);
  assert.match(dom.hpPerformanceStatus.textContent, /^Turned on for this dataset: a frame of every cell took 120 ms/);
  // The cells grow past the ladder's first count and are measured again,
  // as at an opening: culling off for the frames of every cell, then both on
  // and verified; the next opening turns both back off.
  viewer.lodLevelCount = 9;
  viewer.calls.length = 0;
  viewer.reportMeasuring();
  assert.deepEqual(toggles(), [['setFrustumCulling', false]]);
  viewer.reportFullDetailFrameCost(90);
  assert.deepEqual(toggles(), [['setFrustumCulling', false], ['setAdaptiveLOD', true], ['setFrustumCulling', true]]);
  assert.deepEqual(viewer.calls.at(-1), ['verifyFullDetailFrameCost']);
  viewer.reportVerified('faster', 30, 90);
  viewer.calls.length = 0;
  viewer.reportMeasuring();
  assert.deepEqual(toggles(), [['setAdaptiveLOD', false], ['setFrustumCulling', false]]);
  controls.destroy();
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

test('choosing smoke on a device that cannot run it says why and stays in Points', t => {
  const restore = installDocument();
  t.after(restore);
  const support = Object.freeze({
    supported: false,
    reason: 'float-blend',
    message: "Volumetric smoke isn't available on this device: its graphics driver "
      + "can't blend high-precision colour, which the smoke cloud needs to add up "
      + 'the cells. Points rendering works as usual.',
    detail: 'WebGL2 extension EXT_float_blend is unavailable.',
  });
  const { viewer, dom, smoke, smokeCalls } = makeOptions({ smokeSupport: support });
  const controls = initRenderControls({ viewer, dom, smoke });
  const notificationCenter = getNotificationCenter();
  const originalWarning = notificationCenter.warning;
  const originalError = notificationCenter.error;
  const warnings = [];
  const errors = [];
  notificationCenter.warning = (message, options) => warnings.push([message, options]);
  notificationCenter.error = (message, options) => errors.push([message, options]);
  const originalInfo = console.info;
  const consoleInfo = [];
  console.info = (...args) => consoleInfo.push(args.join(' '));
  t.after(() => {
    notificationCenter.warning = originalWarning;
    notificationCenter.error = originalError;
    console.info = originalInfo;
  });

  dom.renderModeSelect.value = 'smoke';
  dom.renderModeSelect.dispatch('change');
  assert.equal(dom.renderModeSelect.value, 'points');
  assert.deepEqual(smokeCalls, [], 'nothing is built');
  assert.equal(
    viewer.calls.filter(([method, value]) => method === 'setRenderMode' && value === 'smoke').length,
    0,
  );
  assert.deepEqual(warnings, [[
    support.message,
    { category: 'rendering', title: 'Volumetric smoke unavailable' },
  ]]);
  assert.deepEqual(errors, []);
  // The capability name is for the console, not the headline.
  assert.doesNotMatch(support.message, /EXT_|R32F|WebGL/);
  assert.match(consoleInfo.join('\n'), /EXT_float_blend/);

  // Programmatic publication (session restore, Jupyter) gets the same answer
  // instead of an exception.
  assert.equal(controls.applyRenderMode('smoke'), false);
  assert.equal(dom.renderModeSelect.value, 'points');
  assert.equal(warnings.length, 2);
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

test('smoke render resolution steps by 0.05 from 0.25× to native, never above', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  initRenderControls({ viewer, dom, smoke });

  const expectations = [
    ['0', 0.25, '0.25×'],
    ['33', 0.5, '0.50×'],
    ['50', 0.65, '0.65×'],
    ['97', 1, '1.00×'],
    ['100', 1, '1.00×'],
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
  assert.equal(dom.pointsPerformanceControls.hidden, false);
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
  assert.equal(dom.pointsPerformanceControls.hidden, false);
  assert.equal(
    viewer.calls.filter(([name]) => name === 'setRenderMode').length,
    setModeCallsBefore,
  );
  assert.deepEqual(observedModes, ['smoke', 'points']);
  assert.deepEqual(notifications, [[
    'Volumetric smoke stopped rendering, so the view is back in Points.',
    { category: 'rendering', title: 'Volumetric smoke stopped' },
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

test('culling is tried only where a cell may lie outside the view, and a framing where nothing could be drawn fewer is not measured', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });
  const toggles = () => viewer.calls.filter(([method]) => method === 'setAdaptiveLOD' || method === 'setFrustumCulling');
  const measured = () => viewer.calls.filter(([method]) => method === 'measureFullDetailFrameCost');

  // Too slow with every cell in view: level of detail alone is tried.
  viewer.calls.length = 0;
  viewer.reportFullDetailFrameCost(120, { cullable: false });
  assert.deepEqual(toggles(), [['setAdaptiveLOD', true]]);
  assert.match(dom.hpPerformanceStatus.textContent, /120 ms here; measuring level of detail\.$/);
  viewer.reportVerified('not-faster', 118, 120);

  // Nothing could be drawn fewer: nothing is turned on, and the next
  // framing (a zoom that leaves cells out) is measured afresh.
  viewer.reportMeasuring();
  viewer.calls.length = 0;
  viewer.reportNothingFewer();
  assert.deepEqual(toggles(), []);
  assert.deepEqual(measured(), []);
  viewer.emitPresented('camera-settled');
  assert.deepEqual(measured(), [['measureFullDetailFrameCost']]);
  controls.destroy();
});

test('frames the browser cannot time apart are not kept, and the tip says so, with the bounds measured', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });
  // A fence polled late on a busy page: the frame of every cell lies
  // between 174 and 324 ms, and the frame with the choice on between 150
  // and 174 ms (Web contracts run 41307458156, Linux Chromium).
  viewer.reportFullDetailFrameCost({ lo: 174.4, hi: 323.6 });
  assert.equal(dom.hpPerformanceStatus.textContent, 'A frame of every cell took 174–324 ms here; measuring level of detail and frustum culling.');
  viewer.reportVerified('unresolved', { lo: 150, hi: 174.2 }, { lo: 174.4, hi: 323.6 });
  assert.equal(dom.hpLodEnabledCheckbox.checked, false);
  assert.equal(dom.hpFrustumCullingCheckbox.checked, false);
  assert.equal(dom.hpPerformanceStatus.textContent, 'Every cell drawn: level of detail and frustum culling measured 150–174 ms a frame against 174–324 ms without, closer than this browser can time. Measured again when the view moves.');
  // Measured again at the next framing, as after a verdict of no faster.
  viewer.calls.length = 0;
  viewer.emitPresented('camera-settled');
  assert.deepEqual(viewer.calls, [['measureFullDetailFrameCost']]);
  controls.destroy();
});
