import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  initVelocityOverlayControls,
} from '../assets/js/app/ui/modules/velocity-overlay-controls.js';
import {
  validateVelocityOverlayConfig,
} from '../assets/js/rendering/overlays/velocity/velocity-overlay.js';

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

test('velocity controls accept the exact current HTML values', () => {
  const controls = initVelocityOverlayControls({
    dom: makeDom(),
    state: makeState(),
    viewer: makeViewer(),
  });
  assert.equal(typeof controls.syncAvailability, 'function');
  assert.equal(typeof controls.destroy, 'function');
  controls.destroy();
});

test('renderer accepts every endpoint exposed by the visible velocity sliders', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const endpoints = Object.freeze([
    Object.freeze({
      html: /id="velocity-speed"[^>]*min="5"[^>]*max="500"/,
      key: 'speedMultiplier',
      minimum: 0.05,
      maximum: 5,
    }),
    Object.freeze({
      html: /id="velocity-lifetime"[^>]*min="10"[^>]*max="1500"/,
      key: 'lifetime',
      minimum: 0.1,
      maximum: 15,
    }),
    Object.freeze({
      html: /id="velocity-size"[^>]*min="0\.5"[^>]*max="30"/,
      key: 'particleSize',
      minimum: 0.5,
      maximum: 30,
    }),
    Object.freeze({
      html: /id="velocity-intensity"[^>]*min="0\.05"[^>]*max="1\.5"/,
      key: 'intensity',
      minimum: 0.05,
      maximum: 1.5,
    }),
    Object.freeze({
      html: /id="velocity-exposure"[^>]*min="0\.1"[^>]*max="2"/,
      key: 'exposure',
      minimum: 0.1,
      maximum: 2,
    }),
  ]);

  for (const endpoint of endpoints) {
    assert.match(html, endpoint.html);
    assert.deepEqual(
      validateVelocityOverlayConfig(endpoint.key, endpoint.minimum, 500_000),
      { key: endpoint.key, value: endpoint.minimum },
    );
    assert.deepEqual(
      validateVelocityOverlayConfig(endpoint.key, endpoint.maximum, 500_000),
      { key: endpoint.key, value: endpoint.maximum },
    );
  }
});

test('minimum flow speed is displayed and published without rounding away its value', () => {
  let onSpeedInput = null;
  const speedInput = makeElement('5');
  speedInput.addEventListener = (event, handler) => {
    if (event === 'input') onSpeedInput = handler;
  };
  const dom = makeDom({ velocitySpeedInput: speedInput });
  const updates = [];
  const controls = initVelocityOverlayControls({
    dom,
    state: makeState(),
    viewer: makeViewer({
      setVectorFieldConfig(key, value) {
        updates.push([key, value]);
      },
    }),
  });

  dom.velocityEnabledCheckbox.checked = true;
  assert.equal(typeof onSpeedInput, 'function');
  onSpeedInput();
  assert.equal(dom.velocitySpeedDisplay.textContent, '0.05×');
  assert.deepEqual(updates, [['speedMultiplier', 0.05]]);
  controls.destroy();
});

test('velocity controls reject malformed or missing input before wiring or viewer mutation', () => {
  let wired = 0;
  let mutated = 0;
  const badInput = makeElement('15K');
  badInput.addEventListener = () => {
    wired++;
  };
  const dom = makeDom({ velocityDensityInput: badInput });
  for (const element of Object.values(dom)) {
    if (element !== badInput) {
      element.addEventListener = () => {
        wired++;
      };
    }
  }

  assert.throws(
    () => initVelocityOverlayControls({
      dom,
      state: makeState(),
      viewer: makeViewer({
        setVectorFieldOverlayEnabled() {
          mutated++;
        },
      }),
    }),
    /particle density.*complete decimal/i
  );
  assert.equal(wired, 0);
  assert.equal(mutated, 0);

  const missing = makeDom();
  delete missing.velocityExposureInput;
  assert.throws(
    () => initVelocityOverlayControls({
      dom: missing,
      state: makeState(),
      viewer: makeViewer(),
    }),
    /velocityExposureInput/
  );
});

test('multiple vector fields require an explicit sidebar selection', () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return makeElement();
    },
  };
  try {
    const dom = makeDom();
    const controls = initVelocityOverlayControls({
      dom,
      state: makeState({
        getAvailableVectorFields: () => [
          {
            id: 'drift_umap',
            label: 'Drift (UMAP)',
            availableDimensions: [2],
            defaultDimension: 2,
          },
          {
            id: 'velocity_umap',
            label: 'Velocity (UMAP)',
            availableDimensions: [2],
            defaultDimension: 2,
          },
        ],
      }),
      viewer: makeViewer(),
    });

    assert.equal(dom.velocityFieldSelect.value, '');
    assert.equal(dom.velocityEnabledCheckbox.disabled, true);
    assert.equal(dom.velocitySettings.style.display, 'block');
    assert.match(dom.velocityInfo.textContent, /select a vector field/i);

    dom.velocityFieldSelect.value = 'velocity_umap';
    controls.syncAvailability();
    assert.equal(dom.velocityEnabledCheckbox.disabled, false);
    assert.equal(dom.velocitySettings.style.display, 'none');
    controls.destroy();
  } finally {
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
  }
});

test('velocity controls expose no clamp, coercion, or first-field substitution path', async () => {
  const source = await readFile(
    new URL(
      '../assets/js/app/ui/modules/velocity-overlay-controls.js',
      import.meta.url
    ),
    'utf8'
  );
  assert.doesNotMatch(
    source,
    /\b(?:Number\.)?parse(?:Int|Float)\s*\(|\bclamp(?:Int|Float)?\b/
  );
  assert.doesNotMatch(source, /fieldsForDim\[0\]/);
  assert.doesNotMatch(source, /Boolean\(syncLodCheckbox\.checked\)/);
  assert.doesNotMatch(source, /\?\./);
  assert.doesNotMatch(source, /console\.warn|err\?\.message/);
});
