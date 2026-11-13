/**
 * An agent's `setting.set` of the vector field's sliders reads back the value
 * set, and Particle density reaches the viewer. The restore path
 * `setting.set`, a session restore and a history jump share
 * (`state-serializer/ui-controls.js` `restoreValidatedControl`) ends as a
 * person's change ends: `input`, then `change`. The vector field's owner
 * follows `input` on the next frame (readout and value) and applies density
 * only on `change`, the release a person's drag ends with; `input` alone
 * would read back the value before ("Intensity: set to 0.25" for 0.9, the
 * step named so and the agent told so) and leave the viewer drawing 15K
 * particles under a readout of 60K.
 *
 * The real owner (`ui/modules/velocity-overlay-controls.js`) and the real
 * serializer share the same fake elements; no frame is ever drawn here
 * (`rendering/frame-phases.js` runs its queue only when the viewer draws), so
 * nothing passes by waiting for one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { initVelocityOverlayControls } from '../assets/js/app/ui/modules/velocity-overlay-controls.js';
import { SETTING_CONTROL_DOMAINS, createUiControlSerializer } from '../assets/js/app/state-serializer/ui-controls.js';
import { representationName } from '../assets/js/data/representation-names.js';

// domKey → [element id, value, min, max, step], as index.html has them.
const SLIDERS = Object.freeze({
  velocityDensityInput: ['velocity-density', '15', '1', '500', '1'],
  velocitySpeedInput: ['velocity-speed', '300', '5', '500', '1'],
  velocityLifetimeInput: ['velocity-lifetime', '800', '10', '1500', '1'],
  velocitySizeInput: ['velocity-size', '1', '0.5', '30', '0.5'],
  velocityOpacityInput: ['velocity-opacity', '60', '0', '100', '1'],
  velocityIntensityInput: ['velocity-intensity', '0.25', '0.05', '1.5', '0.05'],
  velocityGlowInput: ['velocity-glow', '0.3', '0', '1', '0.01'],
  velocityCometStretchInput: ['velocity-comet-stretch', '0.6', '0', '1', '0.01'],
  velocityCoreSharpnessInput: ['velocity-core-sharpness', '0.7', '0', '1', '0.01'],
  velocityTrailFadeInput: ['velocity-trail-fade', '0.925', '0.8', '0.99', '0.005'],
  velocityChromaticFadeInput: ['velocity-chromatic-fade', '0', '0', '1', '0.01'],
  velocityTurbulenceInput: ['velocity-turbulence', '0.3', '0', '1', '0.01'],
  velocityExposureInput: ['velocity-exposure', '0.5', '0.1', '2', '0.05'],
  velocityBloomStrengthInput: ['velocity-bloom-strength', '0.08', '0', '1', '0.01'],
  velocityBloomThresholdInput: ['velocity-bloom-threshold', '0.75', '0', '1', '0.01'],
  velocityAnamorphicInput: ['velocity-anamorphic', '1.2', '1', '4', '0.1'],
  velocitySaturationInput: ['velocity-saturation', '1.15', '0', '2', '0.01'],
  velocityContrastInput: ['velocity-contrast', '1.05', '0.5', '2', '0.01'],
  velocityHighlightsInput: ['velocity-highlights', '0.85', '0', '2', '0.01'],
  velocityShadowsInput: ['velocity-shadows', '1.05', '0', '2', '0.01'],
  velocityVignetteInput: ['velocity-vignette', '0', '0', '1', '0.01'],
  velocityFilmGrainInput: ['velocity-film-grain', '0', '0', '0.2', '0.005'],
  velocityChromaticAberrationInput: ['velocity-chromatic-aberration', '0', '0', '1', '0.01'],
});

const OTHER_DOM_KEYS = Object.freeze([
  'velocityControls', 'velocitySettings', 'velocityInfo', 'velocityEnabledCheckbox', 'velocityFieldSelect',
  'velocityColormapSelect', 'velocitySyncLodCheckbox',
]);

class FakeElement {
  constructor({ id = '', type = '', value = '', min = '', max = '', step = '' } = {}) {
    Object.assign(this, { id, type, value, min, max, step });
    this.tagName = 'INPUT';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.title = '';
    this.innerHTML = '';
    this.textContent = '';
    this.style = {};
    this.options = [];
    this.labels = [];
    this.row = null;
    this.listeners = new Map();
    this.ownerDocument = null;
  }

  closest(selector) {
    if (selector === '.slider-row') return this.row;
    return null;
  }

  appendChild(option) { this.options.push(option); }

  addEventListener(type, listener, options = {}) {
    if (options.signal?.aborted) return;
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(candidate => candidate !== listener));
  }

  dispatchEvent(event) {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener({ target: this, type: event.type });
    return true;
  }
}

function setUp() {
  const dom = {};
  for (const key of OTHER_DOM_KEYS) dom[key] = new FakeElement();
  const inputs = [];
  for (const [key, [id, value, min, max, step]] of Object.entries(SLIDERS)) {
    const input = new FakeElement({ id, type: 'range', value, min, max, step });
    const display = new FakeElement({ id: `${id}-display` });
    input.row = { querySelector: selector => (selector === '.slider-value' ? display : null) };
    dom[key] = input;
    dom[key.replace(/Input$/, 'Display')] = display;
    inputs.push(input);
  }
  dom.velocityColormapSelect.value = 'viridis';
  dom.velocitySyncLodCheckbox.checked = true;
  const applied = [];
  const viewer = {
    setActiveVectorField() {},
    setVectorFieldConfig: (key, value) => applied.push([key, value]),
    setVectorFieldOverlayEnabled() {},
  };
  const state = {
    ensureVectorField: async () => true,
    getAvailableVectorFields: () => [{ id: 'velocity', label: 'velocity', layoutKeys: ['X_umap'] }],
    getDefaultVectorFieldId: () => 'velocity',
    getDimensionLevel: () => 2,
    getActiveViewId: () => 'live',
    getViewLayoutKey: () => 'X_umap',
    viewContexts: new Map([['live', { id: 'live' }]]),
    // The DataState naming every menu uses (`representationNameOf`), over no dataset keys.
    representationNameOf: layout => representationName(layout),
    getDimensionManager: () => ({ getLayout: layoutKey => ({ layoutKey, label: 'UMAP', dimension: 2 }) }),
    off() {},
    on() {},
  };
  const previousDocument = globalThis.document;
  const previousEvent = globalThis.Event;
  const previousFrame = [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame];
  // A frame is asked for and never drawn.
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.document = { createElement: () => new FakeElement(), getElementById: () => null };
  globalThis.Event = class { constructor(type) { this.type = type; } };
  const controls = initVelocityOverlayControls({ dom, state, viewer });
  // The overlay shown (as once its field has loaded): the sliders apply to the viewer.
  dom.velocityEnabledCheckbox.checked = true;
  applied.length = 0;
  const sidebar = {
    querySelectorAll: selector => (selector === 'input[id]' ? inputs : []),
  };
  const serializer = createUiControlSerializer({ sidebar, domains: [...SETTING_CONTROL_DOMAINS] });
  return {
    dom, applied, serializer,
    tearDown() {
      controls.destroy();
      if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
      if (previousEvent === undefined) delete globalThis.Event; else globalThis.Event = previousEvent;
      [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = previousFrame;
    },
  };
}

test('setting.set of a vector-field slider reads back the value it set, at once, and applies it once', () => {
  const { applied, serializer, tearDown } = setUp();
  try {
    const intensity = serializer.setSetting('velocity-intensity', 0.9);
    assert.equal(intensity.value, 0.9);
    assert.equal(intensity.shown, '0.90');
    const size = serializer.setSetting('velocity-size', 2.5);
    assert.equal(size.shown, '2.5');
    const opacity = serializer.setSetting('velocity-opacity', 90);
    assert.equal(opacity.shown, '90%');
    assert.deepEqual(applied, [['intensity', 0.9], ['particleSize', 2.5], ['opacity', 0.9]]);
  } finally {
    tearDown();
  }
});

test('Particle density, applied on release only, reaches the viewer from setting.set and from a restore', () => {
  const { applied, serializer, tearDown } = setUp();
  try {
    const density = serializer.setSetting('velocity-density', 60);
    assert.equal(density.shown, '60K');
    assert.deepEqual(applied, [['particleCount', 60_000]]);
    applied.length = 0;
    // A session, a history jump or an undo puts a value back through the same path.
    const saved = serializer.collectUIControls();
    saved['velocity-density'] = { ...saved['velocity-density'], value: '25' };
    serializer.restoreUIControls(saved);
    assert.deepEqual(applied, [['particleCount', 25_000]]);
  } finally {
    tearDown();
  }
});
