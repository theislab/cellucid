import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { initVisualizationReset } from '../assets/js/app/ui/modules/visualization-reset.js';
import {
  POINT_SIZE_SLIDER_MINIMUM,
  pointSizeSliderPositionForCellCount,
} from '../assets/js/rendering/point-size-scale.js';

const resetSource = await readFile(
  new URL('../assets/js/app/ui/modules/visualization-reset.js', import.meta.url),
  'utf8'
);
const viewerSource = await readFile(
  new URL('../assets/js/rendering/viewer.js', import.meta.url),
  'utf8'
);

async function readJavaScriptTree(directoryUrl) {
  const sources = [];
  for (const entry of await readdir(directoryUrl, { withFileTypes: true })) {
    const entryUrl = new URL(entry.name, directoryUrl);
    if (entry.isDirectory()) {
      entryUrl.pathname += '/';
      sources.push(...await readJavaScriptTree(entryUrl));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      sources.push({
        path: entryUrl.pathname,
        source: await readFile(entryUrl, 'utf8')
      });
    }
  }
  return sources;
}

const applicationSources = await readJavaScriptTree(
  new URL('../assets/js/', import.meta.url)
);

function createElement({ value = '', checked = false, tagName = 'INPUT' } = {}) {
  const listeners = new Map();
  return {
    value,
    checked,
    tagName,
    textContent: '',
    addEventListener(type, listener, options = {}) {
      if (!listeners.has(type)) {
        listeners.set(type, []);
      }
      listeners.get(type).push(listener);
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          this.removeEventListener(type, listener);
        }, { once: true });
      }
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter(candidate => candidate !== listener)
      );
    },
    getListeners(type) {
      return [...(listeners.get(type) ?? [])];
    },
    dispatch(type, event = { target: null }) {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener(event);
      }
    }
  };
}

function createHarness() {
  const renderDom = {
    backgroundSelect: createElement({ value: 'grid-dark', tagName: 'SELECT' }),
    renderModeSelect: createElement({ value: 'smoke', tagName: 'SELECT' }),
    pointSizeInput: createElement({ value: '42.5' }),
    lightingInput: createElement({ value: '61' }),
    lightingDisplay: createElement({ tagName: 'SPAN' }),
    fogInput: createElement({ value: '51' }),
    fogDisplay: createElement({ tagName: 'SPAN' }),
    sizeAttenuationInput: createElement({ value: '81' }),
    sizeAttenuationDisplay: createElement({ tagName: 'SPAN' }),
    smokeGridInput: createElement({ value: '62' }),
    smokeStepsInput: createElement({ value: '76' }),
    smokeDensityInput: createElement({ value: '57' }),
    smokeSpeedInput: createElement({ value: '41' }),
    smokeDetailInput: createElement({ value: '63' }),
    smokeWarpInput: createElement({ value: '11' }),
    smokeAbsorptionInput: createElement({ value: '66' }),
    smokeScatterInput: createElement({ value: '2' }),
    smokeEdgeInput: createElement({ value: '3' }),
    smokeDirectLightInput: createElement({ value: '4' }),
    cloudResolutionInput: createElement({ value: '16' }),
    noiseResolutionInput: createElement({ value: '59' })
  };

  const cameraDom = {
    resetBtn: createElement({ tagName: 'BUTTON' }),
    navigationModeSelect: createElement({ value: 'orbit', tagName: 'SELECT' }),
    lookSensitivityInput: createElement({ value: '6' }),
    moveSpeedInput: createElement({ value: '101' }),
    invertLookCheckbox: createElement({ checked: true }),
    projectilesEnabledCheckbox: createElement({ checked: false }),
    pointerLockCheckbox: createElement({ checked: false }),
    orbitKeySpeedInput: createElement({ value: '41' }),
    orbitReverseCheckbox: createElement({ checked: true }),
    showOrbitAnchorCheckbox: createElement({ checked: true }),
    planarPanSpeedInput: createElement({ value: '99' }),
    planarZoomToCursorCheckbox: createElement({ checked: true }),
    planarInvertAxesCheckbox: createElement({ checked: false })
  };

  const calls = [];
  // The reset resolves the navigation mode from the focused view's dimension
  // rather than from an app-init capture, so the harness publishes one.
  const viewer = {
    focusedViewId: 'live',
    viewDimension: 3,
    getFocusedViewId() {
      calls.push(['viewer', 'getFocusedViewId']);
      return this.focusedViewId;
    },
    getViewDimension(viewId) {
      calls.push(['viewer', 'getViewDimension', viewId]);
      return this.viewDimension;
    }
  };
  for (const method of [
    'resetCamera',
    'setBackground',
    'setNavigationMode',
    'setInvertLookY',
    'setInvertLookX',
    'setProjectilesEnabled',
    'setPointerLockEnabled',
    'setOrbitInvertRotation',
    'setPlanarZoomToCursor',
    'setPlanarInvertAxes',
    'setShowOrbitAnchor',
    'setLightingStrength',
    'setFogDensity',
    'setSizeAttenuation'
  ]) {
    viewer[method] = (...args) => calls.push(['viewer', method, ...args]);
  }

  const renderControls = {};
  for (const method of [
    'applyRenderMode',
    'applyPointSizeFromSlider',
    'updateSmokeStepSlider',
    'updateSmokeDensitySlider',
    'updateSmokeSpeedSlider',
    'updateSmokeDetailSlider',
    'updateSmokeWarpSlider',
    'updateSmokeAbsorptionSlider',
    'updateSmokeScatterSlider',
    'updateSmokeEdgeSlider',
    'updateSmokeDirectLightSlider',
    'updateSmokeGridSlider',
    'updateCloudResolutionSlider',
    'updateNoiseResolutionSlider'
  ]) {
    renderControls[method] = (...args) => calls.push(['render', method, ...args]);
  }

  const cameraControls = {};
  for (const method of [
    'toggleNavigationPanels',
    'updateLookSensitivity',
    'updateMoveSpeed',
    'updateOrbitKeySpeed',
    'updatePlanarPanSpeed'
  ]) {
    cameraControls[method] = (...args) => calls.push(['camera', method, ...args]);
  }

  return {
    renderDom,
    cameraDom,
    viewer,
    renderControls,
    cameraControls,
    calls
  };
}

function mutateControls({ renderDom, cameraDom }) {
  for (const element of Object.values(renderDom)) {
    if (typeof element.value === 'string') {
      element.value = '99';
    }
  }
  renderDom.backgroundSelect.value = 'black';
  renderDom.renderModeSelect.value = 'points';

  for (const element of Object.values(cameraDom)) {
    if (typeof element.value === 'string') {
      element.value = '1';
    }
    if (typeof element.checked === 'boolean') {
      element.checked = !element.checked;
    }
  }
  cameraDom.navigationModeSelect.value = 'planar';
}

function resetOptions(harness) {
  return {
    viewer: harness.viewer,
    renderDom: harness.renderDom,
    cameraDom: harness.cameraDom,
    renderControls: harness.renderControls,
    cameraControls: harness.cameraControls
  };
}

test('visualization reset requires its exact dependency and DOM ownership graph', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { addEventListener() {} };
  try {
    const unknownOptionHarness = createHarness();
    assert.throws(
      () => initVisualizationReset({ ...unknownOptionHarness, calls: undefined }),
      /exactly/i
    );

    const missingDomHarness = createHarness();
    delete missingDomHarness.renderDom.backgroundSelect;
    assert.throws(
      () => initVisualizationReset(resetOptions(missingDomHarness)),
      /backgroundSelect/
    );

    const missingViewerHarness = createHarness();
    delete missingViewerHarness.viewer.setInvertLookX;
    assert.throws(
      () => initVisualizationReset(resetOptions(missingViewerHarness)),
      /setInvertLookX/
    );

    const missingDimensionOwnerHarness = createHarness();
    delete missingDimensionOwnerHarness.viewer.getViewDimension;
    assert.throws(
      () => initVisualizationReset(resetOptions(missingDimensionOwnerHarness)),
      /getViewDimension/
    );

    const missingRenderOwnerHarness = createHarness();
    delete missingRenderOwnerHarness.renderControls.updateSmokeStepSlider;
    assert.throws(
      () => initVisualizationReset(resetOptions(missingRenderOwnerHarness)),
      /updateSmokeStepSlider/
    );

    const missingCameraOwnerHarness = createHarness();
    delete missingCameraOwnerHarness.cameraControls.updatePlanarPanSpeed;
    assert.throws(
      () => initVisualizationReset(resetOptions(missingCameraOwnerHarness)),
      /updatePlanarPanSpeed/
    );
  } finally {
    globalThis.document = previousDocument;
  }
});

test('visualization reset restores every captured value without defaults or coercion', () => {
  const documentListeners = new Map();
  const previousDocument = globalThis.document;
  globalThis.document = {
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    }
  };

  try {
    const harness = createHarness();
    const reset = initVisualizationReset({
      viewer: harness.viewer,
      renderDom: harness.renderDom,
      cameraDom: harness.cameraDom,
      renderControls: harness.renderControls,
      cameraControls: harness.cameraControls
    });

    mutateControls(harness);
    reset.resetVisualizationToDefaults();

    assert.equal(harness.renderDom.backgroundSelect.value, 'grid-dark');
    assert.equal(harness.renderDom.renderModeSelect.value, 'smoke');
    assert.equal(harness.renderDom.pointSizeInput.value, '42.5');
    assert.equal(harness.renderDom.lightingInput.value, '61');
    assert.equal(harness.renderDom.lightingDisplay.textContent, '61');
    assert.equal(harness.renderDom.fogInput.value, '51');
    assert.equal(harness.renderDom.fogDisplay.textContent, '51');
    assert.equal(harness.renderDom.sizeAttenuationInput.value, '81');
    assert.equal(harness.renderDom.sizeAttenuationDisplay.textContent, '81');
    assert.equal(harness.renderDom.smokeGridInput.value, '62');
    assert.equal(harness.renderDom.smokeStepsInput.value, '76');
    assert.equal(harness.renderDom.smokeDensityInput.value, '57');
    assert.equal(harness.renderDom.smokeSpeedInput.value, '41');
    assert.equal(harness.renderDom.smokeDetailInput.value, '63');
    assert.equal(harness.renderDom.smokeWarpInput.value, '11');
    assert.equal(harness.renderDom.smokeAbsorptionInput.value, '66');
    assert.equal(harness.renderDom.smokeScatterInput.value, '2');
    assert.equal(harness.renderDom.smokeEdgeInput.value, '3');
    assert.equal(harness.renderDom.smokeDirectLightInput.value, '4');
    assert.equal(harness.renderDom.cloudResolutionInput.value, '16');
    assert.equal(harness.renderDom.noiseResolutionInput.value, '59');

    assert.equal(harness.cameraDom.navigationModeSelect.value, 'orbit');
    assert.equal(harness.cameraDom.lookSensitivityInput.value, '6');
    assert.equal(harness.cameraDom.moveSpeedInput.value, '101');
    assert.equal(harness.cameraDom.invertLookCheckbox.checked, true);
    assert.equal(harness.cameraDom.projectilesEnabledCheckbox.checked, false);
    assert.equal(harness.cameraDom.pointerLockCheckbox.checked, false);
    assert.equal(harness.cameraDom.orbitKeySpeedInput.value, '41');
    assert.equal(harness.cameraDom.orbitReverseCheckbox.checked, true);
    assert.equal(harness.cameraDom.showOrbitAnchorCheckbox.checked, true);
    assert.equal(harness.cameraDom.planarPanSpeedInput.value, '99');
    assert.equal(harness.cameraDom.planarZoomToCursorCheckbox.checked, true);
    assert.equal(harness.cameraDom.planarInvertAxesCheckbox.checked, false);

    assert.deepEqual(harness.calls, [
      ['viewer', 'resetCamera'],
      ['viewer', 'setBackground', 'grid-dark'],
      ['viewer', 'getFocusedViewId'],
      ['viewer', 'getViewDimension', 'live'],
      ['viewer', 'setNavigationMode', 'orbit'],
      ['camera', 'toggleNavigationPanels', 'orbit'],
      ['camera', 'updateLookSensitivity'],
      ['camera', 'updateMoveSpeed'],
      ['viewer', 'setInvertLookY', true],
      ['viewer', 'setInvertLookX', true],
      ['viewer', 'setProjectilesEnabled', false],
      ['viewer', 'setPointerLockEnabled', false],
      ['camera', 'updateOrbitKeySpeed'],
      ['viewer', 'setOrbitInvertRotation', true],
      ['viewer', 'setShowOrbitAnchor', true],
      ['camera', 'updatePlanarPanSpeed'],
      ['viewer', 'setPlanarZoomToCursor', true],
      ['viewer', 'setPlanarInvertAxes', false],
      ['render', 'applyPointSizeFromSlider'],
      ['viewer', 'setLightingStrength', 0.61],
      ['viewer', 'setFogDensity', 0.51],
      ['viewer', 'setSizeAttenuation', 0.81],
      ['render', 'updateSmokeStepSlider'],
      ['render', 'updateSmokeDensitySlider'],
      ['render', 'updateSmokeSpeedSlider'],
      ['render', 'updateSmokeDetailSlider'],
      ['render', 'updateSmokeWarpSlider'],
      ['render', 'updateSmokeAbsorptionSlider'],
      ['render', 'updateSmokeScatterSlider'],
      ['render', 'updateSmokeEdgeSlider'],
      ['render', 'updateSmokeDirectLightSlider'],
      ['render', 'updateSmokeGridSlider'],
      ['render', 'updateCloudResolutionSlider'],
      ['render', 'updateNoiseResolutionSlider'],
      ['render', 'applyRenderMode', 'smoke']
    ]);

    harness.calls.length = 0;
    harness.cameraDom.resetBtn.dispatch('click');
    assert.equal(harness.calls[0][1], 'resetCamera');

    harness.calls.length = 0;
    documentListeners.get('keydown')({ key: 'r', target: { tagName: 'DIV' } });
    assert.deepEqual(harness.calls, [['viewer', 'resetCamera']]);

    harness.calls.length = 0;
    documentListeners.get('keydown')({ key: 'R', target: { tagName: 'INPUT' } });
    assert.deepEqual(harness.calls, []);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('capturing invalid reset state fails visibly instead of repairing it', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { addEventListener() {} };
  try {
    const partialNumericHarness = createHarness();
    partialNumericHarness.renderDom.lightingInput.value = '61px';
    assert.throws(
      () => initVisualizationReset(resetOptions(partialNumericHarness)),
      /lighting strength/i
    );

    // The navigation mode a reset applies is derived from the focused view's
    // dimension, so that is where an impossible value must be refused rather
    // than silently resolved to some mode.
    const invalidDimensionHarness = createHarness();
    invalidDimensionHarness.viewer.viewDimension = 4;
    const invalidDimensionReset = initVisualizationReset(
      resetOptions(invalidDimensionHarness)
    );
    assert.throws(
      () => invalidDimensionReset.resetVisualizationToDefaults(),
      /exactly 1, 2, or 3/i
    );

    const nonBooleanHarness = createHarness();
    nonBooleanHarness.cameraDom.invertLookCheckbox.checked = 1;
    assert.throws(
      () => initVisualizationReset(resetOptions(nonBooleanHarness)),
      /invertLookCheckbox/
    );
  } finally {
    globalThis.document = previousDocument;
  }
});

test('visualization reset destruction detaches and fences retained reset intents', () => {
  const documentListeners = new Map();
  const previousDocument = globalThis.document;
  globalThis.document = {
    addEventListener(type, listener, options = {}) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(listener);
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          this.removeEventListener(type, listener);
        }, { once: true });
      }
    },
    removeEventListener(type, listener) {
      documentListeners.set(
        type,
        (documentListeners.get(type) ?? [])
          .filter(candidate => candidate !== listener)
      );
    }
  };

  try {
    const harness = createHarness();
    const reset = initVisualizationReset(resetOptions(harness));
    const retainedButtonListener =
      harness.cameraDom.resetBtn.getListeners('click')[0];
    const retainedDocumentListener = documentListeners.get('keydown')[0];

    mutateControls(harness);
    reset.destroy();
    reset.destroy();

    assert.equal(harness.cameraDom.resetBtn.getListeners('click').length, 0);
    assert.equal(documentListeners.get('keydown').length, 0);
    retainedButtonListener({ target: harness.cameraDom.resetBtn });
    retainedDocumentListener({ key: 'r', target: { tagName: 'DIV' } });
    reset.resetVisualizationToDefaults();
    reset.captureInitialState();

    assert.deepEqual(harness.calls, []);
    assert.equal(harness.renderDom.backgroundSelect.value, 'black');
    assert.equal(harness.cameraDom.navigationModeSelect.value, 'planar');
  } finally {
    globalThis.document = previousDocument;
  }
});

test('reset applies the navigation mode the focused dimension implies', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { addEventListener() {} };
  try {
    // A 1-D or 2-D embedding is driven with Planar. The page starts on Orbit
    // long before a dataset exists, so resetting to that start value would drop
    // a flat embedding into the disoriented view Reset Camera is meant to fix.
    for (const [dimension, expectedMode] of [
      [1, 'planar'],
      [2, 'planar'],
      [3, 'orbit']
    ]) {
      const harness = createHarness();
      harness.viewer.focusedViewId = 'snap_2';
      harness.viewer.viewDimension = dimension;
      assert.equal(harness.cameraDom.navigationModeSelect.value, 'orbit');
      const reset = initVisualizationReset(resetOptions(harness));

      harness.cameraDom.navigationModeSelect.value = 'free';
      harness.calls.length = 0;
      reset.resetVisualizationToDefaults();

      assert.equal(
        harness.cameraDom.navigationModeSelect.value,
        expectedMode,
        `reset at ${dimension}D must select ${expectedMode}`
      );
      assert.deepEqual(
        harness.calls.filter(call => (
          call[1] === 'setNavigationMode'
          || call[1] === 'toggleNavigationPanels'
          || call[1] === 'getViewDimension'
        )),
        [
          ['viewer', 'getViewDimension', 'snap_2'],
          ['viewer', 'setNavigationMode', expectedMode],
          ['camera', 'toggleNavigationPanels', expectedMode]
        ]
      );
    }
  } finally {
    globalThis.document = previousDocument;
  }
});

test('reset and viewer sources contain no legacy invert alias or optional reset calls', () => {
  for (const { path, source } of applicationSources) {
    assert.doesNotMatch(
      source,
      /\.setInvertLook\s*\(/,
      `${path} still calls the removed setInvertLook alias`
    );
  }

  assert.doesNotMatch(viewerSource, /\bsetInvertLook\s*\(/);
  assert.match(
    viewerSource,
    /setInvertLookY\(value\)\s*\{\s*invertLookY = assertExactBoolean\(value,\s*'Vertical invert look'\);\s*\}/
  );
  assert.match(
    viewerSource,
    /setInvertLookX\(value\)\s*\{\s*invertLookX = assertExactBoolean\(value,\s*'Horizontal invert look'\);\s*\}/
  );

  assert.doesNotMatch(resetSource, /\?\./);
  assert.doesNotMatch(resetSource, /\?\?/);
  assert.doesNotMatch(resetSource, /\bBoolean\s*\(/);
  assert.doesNotMatch(resetSource, /\bparseFloat\s*\(/);
  assert.doesNotMatch(resetSource, /\|\|\s*['"`]/);
});

test('a large dataset opens at a negative slider position and is still captured', () => {
  // The point-size slider is the one range control whose domain is not 0-100.
  // Its position is the exponent of a logarithmic size curve and runs below zero
  // so the curve reaches the sizes millions of cells need: 18,142,044 cells open
  // at position -12. Capturing that against a 0-100 bound threw, and the
  // publication path reports a throw here as "the dataset is loaded, but its
  // controls could not be synchronized" — so every dataset above roughly four
  // hundred thousand cells lost its Reset baseline and said so on screen.
  const previousDocument = globalThis.document;
  globalThis.document = { addEventListener() {} };
  const harness = createHarness();
  const openingPosition =
    pointSizeSliderPositionForCellCount(18_142_044);
  assert.ok(
    openingPosition < 0,
    'this test is meaningless unless the position really is negative',
  );
  assert.ok(openingPosition >= POINT_SIZE_SLIDER_MINIMUM);

  try {
    harness.renderDom.pointSizeInput.value = String(openingPosition);
    const reset = initVisualizationReset(resetOptions(harness));
    reset.captureInitialState();

    harness.renderDom.pointSizeInput.value = '42.5';
    reset.resetVisualizationToDefaults();
    assert.equal(
      harness.renderDom.pointSizeInput.value,
      String(openingPosition),
      'Reset must return to the size the dataset opened at',
    );

    // Every reachable position round-trips, including both ends of the domain.
    for (const position of [POINT_SIZE_SLIDER_MINIMUM, -12, 0, 16.5, 100]) {
      harness.renderDom.pointSizeInput.value = String(position);
      reset.captureInitialState();
      harness.renderDom.pointSizeInput.value = '7';
      reset.resetVisualizationToDefaults();
      assert.equal(harness.renderDom.pointSizeInput.value, String(position));
    }
  } finally {
    globalThis.document = previousDocument;
  }
});
