/**
 * On a 2-D dataset that has no vector field (the lifecycle probe's
 * synthetic-cell-types-2d: obsm X_islands and X_marker_scores only), `Show
 * overlay` must not refuse a `setting.set` with "switched off by another
 * setting", for no setting has switched it off. The switch says why it is off
 * (its `title`: the tooltip on the dimmed control), and a refusal of a
 * disabled control repeats the reason its owner gave
 * (ui/core/control-availability.js, ui-controls.js).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initVelocityOverlayControls,
  SWITCH_UNAVAILABLE,
} from '../assets/js/app/ui/modules/velocity-overlay-controls.js';
import { unavailableReasonOf } from '../assets/js/app/ui/core/control-availability.js';
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

const OTHER_DOM_KEYS = Object.freeze([
  'velocityControls',
  'velocitySettings',
  'velocityInfo',
  'velocityEnabledCheckbox',
  'velocityFieldSelect',
  'velocityDensityDisplay',
  'velocitySpeedDisplay',
  'velocityLifetimeDisplay',
  'velocitySizeDisplay',
  'velocityOpacityDisplay',
  'velocityColormapSelect',
  'velocitySyncLodCheckbox',
  'velocityIntensityDisplay',
  'velocityGlowDisplay',
  'velocityCometStretchDisplay',
  'velocityCoreSharpnessDisplay',
  'velocityTrailFadeDisplay',
  'velocityChromaticFadeDisplay',
  'velocityTurbulenceDisplay',
  'velocityExposureDisplay',
  'velocityBloomStrengthDisplay',
  'velocityBloomThresholdDisplay',
  'velocityAnamorphicDisplay',
  'velocitySaturationDisplay',
  'velocityContrastDisplay',
  'velocityHighlightsDisplay',
  'velocityShadowsDisplay',
  'velocityVignetteDisplay',
  'velocityFilmGrainDisplay',
  'velocityChromaticAberrationDisplay',
]);

function makeElement(value = '') {
  return {
    checked: false,
    disabled: false,
    innerHTML: '',
    style: {},
    textContent: '',
    value,
    addEventListener() {},
    appendChild() {},
    removeEventListener() {},
  };
}

function makeSelectElement(initialOptions = []) {
  const select = makeElement();
  select.options = initialOptions.map(value => ({ value }));
  let innerHTML = '';
  Object.defineProperty(select, 'innerHTML', {
    configurable: true,
    get() {
      return innerHTML;
    },
    set(value) {
      innerHTML = value;
      if (value === '') {
        select.options.length = 0;
        select.value = '';
      }
    },
  });
  select.appendChild = option => {
    select.options.push(option);
  };
  return select;
}

function makeDom(overrides = {}) {
  const dom = {};
  for (const key of OTHER_DOM_KEYS) dom[key] = makeElement();
  for (const [key, value] of Object.entries(NUMERIC_VALUES)) {
    dom[key] = makeElement(value);
  }
  dom.velocityColormapSelect.value = 'viridis';
  dom.velocitySyncLodCheckbox.checked = true;
  return Object.assign(dom, overrides);
}

function makeState(overrides = {}) {
  return Object.assign({
    ensureVectorField: async () => true,
    getAvailableVectorFields: () => [],
    getDefaultVectorFieldId: () => null,
    getDimensionLevel: () => 2,
    getActiveViewId: () => 'live',
    getViewLayoutKey: () => 'X_umap',
    viewContexts: new Map([['live', { id: 'live' }]]),
    // The DataState naming every menu uses (`representationNameOf`), over no dataset keys.
    representationNameOf: layout => representationName(layout),
    getDimensionManager: () => ({
      getLayout: layoutKey => ({ layoutKey, label: 'UMAP', dimension: 2 }),
    }),
    off() {},
    on() {},
  }, overrides);
}

function makeViewer(overrides = {}) {
  return Object.assign({
    setActiveVectorField() {},
    setVectorFieldConfig() {},
    setVectorFieldOverlayEnabled() {},
  }, overrides);
}


function withDocument(run) {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => makeElement() };
  try {
    return run();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

test('a 2-D dataset with no vector field: the switch is off and says so, naming what to do', () => withDocument(() => {
  const dom = makeDom();
  const controls = initVelocityOverlayControls({
    dom,
    state: makeState({ getAvailableVectorFields: () => [], getViewLayoutKey: () => 'X_islands' }),
    viewer: makeViewer(),
  });
  assert.equal(dom.velocityEnabledCheckbox.disabled, true);
  assert.equal(dom.velocityEnabledCheckbox.title, SWITCH_UNAVAILABLE.noField);
  assert.equal(unavailableReasonOf(dom.velocityEnabledCheckbox), SWITCH_UNAVAILABLE.noField, 'what a refused setting.set says');
  assert.match(dom.velocityEnabledCheckbox.title, /this dataset has no vector field.*open a dataset with one/);
  controls.destroy();
}));

test('a field bound to another embedding, or none chosen: each says its cause; available says nothing', () => withDocument(() => {
  let layout = 'X_pca';
  const dom = makeDom();
  const controls = initVelocityOverlayControls({
    dom,
    state: makeState({
      getAvailableVectorFields: () => [
        { id: 'drift', label: 'Drift', layoutKeys: ['X_umap'] },
        { id: 'velocity', label: 'Velocity', layoutKeys: ['X_umap'] },
      ],
      getViewLayoutKey: () => layout,
    }),
    viewer: makeViewer(),
  });
  assert.equal(dom.velocityEnabledCheckbox.disabled, true);
  // The embeddings named as the View N shows picker names them.
  assert.equal(dom.velocityEnabledCheckbox.title, SWITCH_UNAVAILABLE.notShown('UMAP · 2D'));
  assert.match(dom.velocityInfo.textContent, /^Vector fields are bound to UMAP · 2D\. /);
  layout = 'X_umap';
  controls.syncAvailability();
  assert.equal(dom.velocityEnabledCheckbox.title, SWITCH_UNAVAILABLE.noneSelected);
  dom.velocityFieldSelect.value = 'velocity';
  controls.syncAvailability();
  assert.equal(dom.velocityEnabledCheckbox.disabled, false);
  assert.equal(dom.velocityEnabledCheckbox.title, '');
  controls.destroy();
}));
