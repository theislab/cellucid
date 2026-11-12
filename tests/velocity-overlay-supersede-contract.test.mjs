/**
 * R9V-1 (bug hunt round 9): a field chosen while the overlay was turning on
 * left it "loading" for good. The field change took the operation over and
 * returned because a load was under way; the load, no longer the owner,
 * returned without clearing its loading state. Every way in (an agent's
 * `setting.set`, a session or history restore that switches the overlay on
 * and then picks the field) ended with the switch and the select grayed,
 * "the vector field is loading", and no particle.
 *
 * The newest operation owns the block: a field change, the switch turned off
 * or another embedding shown during a load takes the loading state over and
 * finishes it. R9V-4: the only field bound to the shown embedding is chosen;
 * among several none is guessed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { undoLater } from './helpers/teardown.mjs';

import {
  initVelocityOverlayControls,
  SWITCH_UNAVAILABLE,
} from '../assets/js/app/ui/modules/velocity-overlay-controls.js';
import { representationName } from '../assets/js/data/representation-names.js';

const NUMERIC_VALUES = Object.freeze({
  velocityDensityInput: '15',
  velocitySpeedInput: '300',
  velocityLifetimeInput: '800',
  velocitySizeInput: '1',
  velocityOpacityInput: '60',
  velocityIntensityInput: '0.25',
  velocityGlowInput: '0.3',
  velocityCometStretchInput: '0.6',
  velocityCoreSharpnessInput: '0.7',
  velocityTrailFadeInput: '0.925',
  velocityChromaticFadeInput: '0',
  velocityTurbulenceInput: '0.3',
  velocityExposureInput: '0.5',
  velocityBloomStrengthInput: '0.08',
  velocityBloomThresholdInput: '0.75',
  velocityAnamorphicInput: '1.2',
  velocitySaturationInput: '1.15',
  velocityContrastInput: '1.05',
  velocityHighlightsInput: '0.85',
  velocityShadowsInput: '1.05',
  velocityVignetteInput: '0',
  velocityFilmGrainInput: '0',
  velocityChromaticAberrationInput: '0',
});

const DISPLAY_KEYS = Object.freeze([
  'velocityControls', 'velocitySettings', 'velocityInfo', 'velocityColormapSelect',
  'velocitySyncLodCheckbox', 'velocityDensityDisplay', 'velocitySpeedDisplay',
  'velocityLifetimeDisplay', 'velocitySizeDisplay', 'velocityOpacityDisplay',
  'velocityIntensityDisplay', 'velocityGlowDisplay', 'velocityCometStretchDisplay',
  'velocityCoreSharpnessDisplay', 'velocityTrailFadeDisplay', 'velocityChromaticFadeDisplay',
  'velocityTurbulenceDisplay', 'velocityExposureDisplay', 'velocityBloomStrengthDisplay',
  'velocityBloomThresholdDisplay', 'velocityAnamorphicDisplay', 'velocitySaturationDisplay',
  'velocityContrastDisplay', 'velocityHighlightsDisplay', 'velocityShadowsDisplay',
  'velocityVignetteDisplay', 'velocityFilmGrainDisplay', 'velocityChromaticAberrationDisplay',
]);

function makeElement(value = '') {
  const listeners = new Map();
  return {
    checked: false,
    disabled: false,
    hidden: false,
    title: '',
    textContent: '',
    value,
    style: {},
    dataset: {},
    listeners,
    setAttribute(name, attributeValue) { this[name] = attributeValue; },
    removeAttribute(name) { this[name] = ''; },
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener() {},
    appendChild() {},
    fire(type) { return listeners.get(type)?.(); },
  };
}

function makeSelect() {
  const select = makeElement();
  select.options = [];
  let html = '';
  Object.defineProperty(select, 'innerHTML', {
    get: () => html,
    set(value) {
      html = value;
      if (value === '') { select.options.length = 0; select.value = ''; }
    },
  });
  select.appendChild = option => { select.options.push(option); };
  return select;
}

function makeDom() {
  const dom = {};
  for (const key of DISPLAY_KEYS) dom[key] = makeElement();
  for (const [key, value] of Object.entries(NUMERIC_VALUES)) dom[key] = makeElement(value);
  dom.velocityColormapSelect.value = 'viridis';
  dom.velocitySyncLodCheckbox.checked = true;
  dom.velocityEnabledCheckbox = makeElement();
  dom.velocityFieldSelect = makeSelect();
  return dom;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** Two fields on UMAP, one on t-SNE; loads wait until the test lets them finish. */
function setup(t, { fields, layout = 'X_umap' } = {}) {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => makeElement() };
  undoLater(t, () => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  const shown = { layout };
  const pending = [];
  const viewer = { enabled: false, field: null, calls: [] };
  const dom = makeDom();
  const controls = initVelocityOverlayControls({
    dom,
    state: {
      getAvailableVectorFields: () => fields ?? [
        { id: 'drift', label: 'drift', layoutKeys: ['X_umap'] },
        { id: 'velocity', label: 'velocity', layoutKeys: ['X_tsne', 'X_umap'] },
      ],
      getDefaultVectorFieldId: () => null,
      getActiveViewId: () => 'live',
      getViewLayoutKey: () => shown.layout,
      viewContexts: new Map([['live', { id: 'live' }]]),
      // The DataState naming every menu uses (`representationNameOf`), over no dataset keys.
      representationNameOf: layout => representationName(layout),
      getDimensionManager: () => ({
        getLayout: layoutKey => ({ layoutKey, label: layoutKey, dimension: 2, provenance: null }),
      }),
      ensureVectorField(fieldId, layoutKey) {
        const gate = deferred();
        pending.push({ fieldId, layoutKey, gate });
        return gate.promise.then(() => true);
      },
      on() {},
      off() {},
    },
    viewer: {
      setVectorFieldOverlayEnabled(on) { viewer.enabled = on; viewer.calls.push(['enabled', on]); },
      setActiveVectorField(id) { viewer.field = id; viewer.calls.push(['field', id]); },
      setVectorFieldConfig() {},
    },
  });
  undoLater(t, () => controls.destroy());
  const finishLoads = async () => {
    while (pending.length > 0) pending.shift().gate.resolve();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { dom, controls, viewer, pending, shown, finishLoads };
}

// A stranded load never settles: a time limit turns that into a failure.
test('a field chosen while the overlay turns on is shown; nothing is left loading', { timeout: 5000 }, async t => {
  const { dom, viewer, pending, finishLoads } = setup(t);
  dom.velocityFieldSelect.value = 'velocity';
  dom.velocityEnabledCheckbox.checked = true;
  const enabling = dom.velocityEnabledCheckbox.fire('change');
  assert.equal(dom.velocityEnabledCheckbox.title, SWITCH_UNAVAILABLE.loading);
  assert.equal(dom.velocityFieldSelect.title, SWITCH_UNAVAILABLE.loading, 'the select waits with the switch');
  assert.deepEqual(pending.map(load => load.fieldId), ['velocity']);

  // An agent's setting.set, or a restore, picks drift during the load.
  dom.velocityFieldSelect.value = 'drift';
  const choosing = dom.velocityFieldSelect.fire('change');
  await finishLoads();
  await Promise.all([enabling, choosing]);

  assert.equal(viewer.enabled, true);
  assert.equal(viewer.field, 'drift', 'the newest choice is the one shown');
  assert.equal(dom.velocityEnabledCheckbox.checked, true);
  assert.equal(dom.velocityEnabledCheckbox.disabled, false);
  assert.equal(dom.velocityEnabledCheckbox.title, '');
  assert.equal(dom.velocityFieldSelect.disabled, false);
  assert.equal(dom.velocityInfo.textContent, 'Available on UMAP · 2D, t-SNE · 2D.');
});

test('the switch turned off during a load ends off and not loading', { timeout: 5000 }, async t => {
  const { dom, viewer, finishLoads } = setup(t);
  dom.velocityFieldSelect.value = 'drift';
  dom.velocityEnabledCheckbox.checked = true;
  const enabling = dom.velocityEnabledCheckbox.fire('change');
  dom.velocityEnabledCheckbox.checked = false;
  const disabling = dom.velocityEnabledCheckbox.fire('change');
  await finishLoads();
  await Promise.all([enabling, disabling]);
  assert.equal(viewer.enabled, false, 'the superseded load does not turn the overlay on');
  assert.equal(dom.velocityEnabledCheckbox.checked, false);
  assert.equal(dom.velocityEnabledCheckbox.disabled, false);
  assert.equal(dom.velocityEnabledCheckbox.title, '');
  assert.equal(dom.velocitySettings.hidden, true);
});

test('another embedding shown during a load takes the load over', { timeout: 5000 }, async t => {
  const { dom, controls, viewer, shown, finishLoads } = setup(t);
  dom.velocityFieldSelect.value = 'velocity';
  dom.velocityEnabledCheckbox.checked = true;
  const enabling = dom.velocityEnabledCheckbox.fire('change');
  shown.layout = 'X_tsne';
  const redrawing = controls.redraw();
  await finishLoads();
  await Promise.all([enabling, redrawing]);
  assert.equal(viewer.enabled, true);
  assert.equal(viewer.field, 'velocity');
  assert.equal(dom.velocityEnabledCheckbox.disabled, false);
  assert.equal(dom.velocityFieldSelect.disabled, false);
});

test('the only field bound to the shown embedding is chosen; among several none is guessed (R9V-4)', t => {
  const { dom, controls, shown } = setup(t, { layout: 'X_tsne' });
  assert.equal(dom.velocityFieldSelect.value, 'velocity');
  assert.equal(dom.velocityEnabledCheckbox.disabled, false);
  shown.layout = 'X_umap';
  dom.velocityFieldSelect.value = '';
  controls.syncAvailability();
  assert.equal(dom.velocityFieldSelect.value, '');
  assert.equal(dom.velocityEnabledCheckbox.title, SWITCH_UNAVAILABLE.noneSelected);
});

test('the switch names the embeddings to show as the picker does (R9V-3)', t => {
  const { dom } = setup(t, { layout: 'X_pca' });
  assert.equal(
    dom.velocityEnabledCheckbox.title,
    SWITCH_UNAVAILABLE.notShown('one of UMAP · 2D, t-SNE · 2D'),
  );
  assert.equal(
    dom.velocityInfo.textContent,
    'Vector fields are bound to UMAP · 2D, t-SNE · 2D. Show one of them in this view to enable.',
  );
});
