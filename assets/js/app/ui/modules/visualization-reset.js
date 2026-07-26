/**
 * @fileoverview Exact reset wiring for visualization and camera controls.
 *
 * The reset owner captures the initialized control state once every required
 * owner is present. Resetting restores that exact state; missing controls,
 * missing methods, malformed values, and unsupported enum values are errors.
 *
 * @module ui/modules/visualization-reset
 */

import { assertNavigationMode } from '../../../rendering/camera-state-contract.js';
import { parseRangeInput } from '../core/numeric-input-contract.js';

const EXACT_OPTION_KEYS = Object.freeze([
  'cameraControls',
  'cameraDom',
  'renderControls',
  'renderDom',
  'viewer'
]);

const RENDER_VALUE_KEYS = Object.freeze([
  'backgroundSelect',
  'renderModeSelect',
  'pointSizeInput',
  'lightingInput',
  'fogInput',
  'sizeAttenuationInput',
  'smokeGridInput',
  'smokeStepsInput',
  'smokeDensityInput',
  'smokeSpeedInput',
  'smokeDetailInput',
  'smokeWarpInput',
  'smokeAbsorptionInput',
  'smokeScatterInput',
  'smokeEdgeInput',
  'smokeDirectLightInput',
  'cloudResolutionInput',
  'noiseResolutionInput'
]);

const RENDER_DISPLAY_KEYS = Object.freeze([
  'lightingDisplay',
  'fogDisplay',
  'sizeAttenuationDisplay'
]);

const CAMERA_VALUE_KEYS = Object.freeze([
  'navigationModeSelect',
  'lookSensitivityInput',
  'moveSpeedInput',
  'orbitKeySpeedInput',
  'planarPanSpeedInput'
]);

const CAMERA_CHECKBOX_KEYS = Object.freeze([
  'invertLookCheckbox',
  'projectilesEnabledCheckbox',
  'pointerLockCheckbox',
  'orbitReverseCheckbox',
  'showOrbitAnchorCheckbox',
  'planarZoomToCursorCheckbox',
  'planarInvertAxesCheckbox'
]);

const VIEWER_METHODS = Object.freeze([
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
]);

const RENDER_CONTROL_METHODS = Object.freeze([
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
]);

const CAMERA_CONTROL_METHODS = Object.freeze([
  'toggleNavigationPanels',
  'updateLookSensitivity',
  'updateMoveSpeed',
  'updateOrbitKeySpeed',
  'updatePlanarPanSpeed'
]);

const BACKGROUND_MODES = Object.freeze(['grid', 'grid-dark', 'white', 'black']);
const RENDER_MODES = Object.freeze(['points', 'smoke']);

function assertRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function assertExactOptions(options) {
  assertRecord(options, 'Visualization reset options');
  const actualKeys = Object.keys(options).sort();
  const hasWrongKeys = (
    actualKeys.length !== EXACT_OPTION_KEYS.length ||
    actualKeys.some((key, index) => key !== EXACT_OPTION_KEYS[index])
  );
  if (hasWrongKeys) {
    throw new TypeError(
      `Visualization reset options must contain exactly ${EXACT_OPTION_KEYS.join(', ')}.`
    );
  }
  return options;
}

function requireValueElements(owner, keys, label) {
  assertRecord(owner, label);
  for (const key of keys) {
    const element = owner[key];
    if (element === null || typeof element !== 'object') {
      throw new Error(`${label} is missing the required "${key}" element.`);
    }
    if (typeof element.value !== 'string') {
      throw new TypeError(`${label} "${key}" must expose an exact string value.`);
    }
  }
}

function requireDisplayElements(owner, keys, label) {
  for (const key of keys) {
    const element = owner[key];
    if (element === null || typeof element !== 'object') {
      throw new Error(`${label} is missing the required "${key}" element.`);
    }
  }
}

function requireCheckboxElements(owner, keys, label) {
  assertRecord(owner, label);
  for (const key of keys) {
    const element = owner[key];
    if (element === null || typeof element !== 'object') {
      throw new Error(`${label} is missing the required "${key}" element.`);
    }
    if (typeof element.checked !== 'boolean') {
      throw new TypeError(`${label} "${key}" must expose an exact boolean state.`);
    }
  }
}

function requireResetButton(cameraDom) {
  const resetButton = cameraDom.resetBtn;
  if (resetButton === null || typeof resetButton !== 'object') {
    throw new Error('Visualization reset camera DOM is missing the required "resetBtn" element.');
  }
  if (typeof resetButton.addEventListener !== 'function') {
    throw new TypeError('Visualization reset "resetBtn" must support event listeners.');
  }
  return resetButton;
}

function requireMethods(owner, methods, label) {
  assertRecord(owner, label);
  for (const method of methods) {
    if (typeof owner[method] !== 'function') {
      throw new TypeError(`${label} must provide ${method}().`);
    }
  }
}

function assertChoice(value, allowedValues, label) {
  if (typeof value !== 'string' || !allowedValues.includes(value)) {
    throw new TypeError(
      `${label} must be exactly one of ${allowedValues.join(', ')}; received ${String(value)}.`
    );
  }
  return value;
}

function captureRange(input, { minimum, maximum, label }) {
  const raw = input.value;
  const value = parseRangeInput(raw, { minimum, maximum, label });
  return Object.freeze({ raw, value });
}

function captureBoolean(input, label) {
  if (typeof input.checked !== 'boolean') {
    throw new TypeError(`${label} must be an exact boolean.`);
  }
  return input.checked;
}

function restoreRange(input, state, apply) {
  input.value = state.raw;
  apply();
}

function isTextEntryTarget(target) {
  if (target === null || typeof target !== 'object') {
    return false;
  }
  return (
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    target.isContentEditable === true
  );
}

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {object} options.renderDom
 * @param {object} options.cameraDom
 * @param {object} options.renderControls
 * @param {object} options.cameraControls
 */
export function initVisualizationReset(options) {
  const exactOptions = assertExactOptions(options);
  const {
    viewer,
    renderDom,
    cameraDom,
    renderControls,
    cameraControls
  } = exactOptions;

  requireValueElements(renderDom, RENDER_VALUE_KEYS, 'Visualization reset render DOM');
  requireDisplayElements(renderDom, RENDER_DISPLAY_KEYS, 'Visualization reset render DOM');
  requireValueElements(cameraDom, CAMERA_VALUE_KEYS, 'Visualization reset camera DOM');
  requireCheckboxElements(cameraDom, CAMERA_CHECKBOX_KEYS, 'Visualization reset camera DOM');
  const resetCameraBtn = requireResetButton(cameraDom);
  requireMethods(viewer, VIEWER_METHODS, 'Visualization reset viewer');
  requireMethods(
    renderControls,
    RENDER_CONTROL_METHODS,
    'Visualization reset render controls'
  );
  requireMethods(
    cameraControls,
    CAMERA_CONTROL_METHODS,
    'Visualization reset camera controls'
  );

  const {
    backgroundSelect,
    renderModeSelect,
    pointSizeInput,
    lightingInput,
    lightingDisplay,
    fogInput,
    fogDisplay,
    sizeAttenuationInput,
    sizeAttenuationDisplay,
    smokeGridInput,
    smokeStepsInput,
    smokeDensityInput,
    smokeSpeedInput,
    smokeDetailInput,
    smokeWarpInput,
    smokeAbsorptionInput,
    smokeScatterInput,
    smokeEdgeInput,
    smokeDirectLightInput,
    cloudResolutionInput,
    noiseResolutionInput
  } = renderDom;

  const {
    navigationModeSelect,
    lookSensitivityInput,
    moveSpeedInput,
    invertLookCheckbox,
    projectilesEnabledCheckbox,
    pointerLockCheckbox,
    orbitKeySpeedInput,
    orbitReverseCheckbox,
    showOrbitAnchorCheckbox,
    planarPanSpeedInput,
    planarZoomToCursorCheckbox,
    planarInvertAxesCheckbox
  } = cameraDom;

  let initialUIState;

  function captureInitialState() {
    initialUIState = Object.freeze({
      background: assertChoice(
        backgroundSelect.value,
        BACKGROUND_MODES,
        'Visualization background'
      ),
      renderMode: assertChoice(
        renderModeSelect.value,
        RENDER_MODES,
        'Visualization render mode'
      ),
      pointSize: captureRange(
        pointSizeInput,
        { minimum: 0, maximum: 100, label: 'Point size' }
      ),
      lighting: captureRange(
        lightingInput,
        { minimum: 0, maximum: 100, label: 'Lighting strength' }
      ),
      fog: captureRange(
        fogInput,
        { minimum: 0, maximum: 100, label: 'Fog density' }
      ),
      sizeAttenuation: captureRange(
        sizeAttenuationInput,
        { minimum: 0, maximum: 100, label: 'Size attenuation' }
      ),
      smokeGrid: captureRange(
        smokeGridInput,
        { minimum: 0, maximum: 100, label: 'Smoke grid' }
      ),
      smokeSteps: captureRange(
        smokeStepsInput,
        { minimum: 0, maximum: 100, label: 'Smoke steps' }
      ),
      smokeDensity: captureRange(
        smokeDensityInput,
        { minimum: 0, maximum: 100, label: 'Smoke density' }
      ),
      smokeSpeed: captureRange(
        smokeSpeedInput,
        { minimum: 0, maximum: 100, label: 'Smoke speed' }
      ),
      smokeDetail: captureRange(
        smokeDetailInput,
        { minimum: 0, maximum: 100, label: 'Smoke detail' }
      ),
      smokeWarp: captureRange(
        smokeWarpInput,
        { minimum: 0, maximum: 100, label: 'Smoke warp' }
      ),
      smokeAbsorption: captureRange(
        smokeAbsorptionInput,
        { minimum: 0, maximum: 100, label: 'Smoke absorption' }
      ),
      smokeScatter: captureRange(
        smokeScatterInput,
        { minimum: 0, maximum: 100, label: 'Smoke scatter' }
      ),
      smokeEdge: captureRange(
        smokeEdgeInput,
        { minimum: 0, maximum: 100, label: 'Smoke edge' }
      ),
      smokeDirectLight: captureRange(
        smokeDirectLightInput,
        { minimum: 0, maximum: 100, label: 'Smoke direct light' }
      ),
      cloudResolution: captureRange(
        cloudResolutionInput,
        { minimum: 0, maximum: 100, label: 'Cloud resolution' }
      ),
      noiseResolution: captureRange(
        noiseResolutionInput,
        { minimum: 0, maximum: 100, label: 'Noise resolution' }
      ),
      navigationMode: assertNavigationMode(navigationModeSelect.value),
      lookSensitivity: captureRange(
        lookSensitivityInput,
        { minimum: 1, maximum: 30, label: 'Look sensitivity' }
      ),
      moveSpeed: captureRange(
        moveSpeedInput,
        { minimum: 1, maximum: 500, label: 'Move speed' }
      ),
      invertLook: captureBoolean(invertLookCheckbox, 'Invert look'),
      projectilesEnabled: captureBoolean(
        projectilesEnabledCheckbox,
        'Projectile shooting'
      ),
      pointerLockEnabled: captureBoolean(pointerLockCheckbox, 'Pointer capture'),
      orbitKeySpeed: captureRange(
        orbitKeySpeedInput,
        { minimum: 1, maximum: 100, label: 'Orbit keyboard speed' }
      ),
      orbitInvertRotation: captureBoolean(
        orbitReverseCheckbox,
        'Orbit invert rotation'
      ),
      showOrbitAnchor: captureBoolean(showOrbitAnchorCheckbox, 'Show orbit anchor'),
      planarPanSpeed: captureRange(
        planarPanSpeedInput,
        { minimum: 1, maximum: 100, label: 'Planar keyboard speed' }
      ),
      planarZoomToCursor: captureBoolean(
        planarZoomToCursorCheckbox,
        'Planar zoom to cursor'
      ),
      planarInvertAxes: captureBoolean(
        planarInvertAxesCheckbox,
        'Planar invert axes'
      )
    });
    return initialUIState;
  }

  function resetVisualizationToDefaults() {
    viewer.resetCamera();

    backgroundSelect.value = initialUIState.background;
    viewer.setBackground(initialUIState.background);

    navigationModeSelect.value = initialUIState.navigationMode;
    viewer.setNavigationMode(initialUIState.navigationMode);
    cameraControls.toggleNavigationPanels(initialUIState.navigationMode);

    restoreRange(
      lookSensitivityInput,
      initialUIState.lookSensitivity,
      cameraControls.updateLookSensitivity
    );
    restoreRange(
      moveSpeedInput,
      initialUIState.moveSpeed,
      cameraControls.updateMoveSpeed
    );

    invertLookCheckbox.checked = initialUIState.invertLook;
    viewer.setInvertLookY(initialUIState.invertLook);
    viewer.setInvertLookX(initialUIState.invertLook);

    projectilesEnabledCheckbox.checked = initialUIState.projectilesEnabled;
    viewer.setProjectilesEnabled(initialUIState.projectilesEnabled);

    pointerLockCheckbox.checked = initialUIState.pointerLockEnabled;
    viewer.setPointerLockEnabled(initialUIState.pointerLockEnabled);

    restoreRange(
      orbitKeySpeedInput,
      initialUIState.orbitKeySpeed,
      cameraControls.updateOrbitKeySpeed
    );
    orbitReverseCheckbox.checked = initialUIState.orbitInvertRotation;
    viewer.setOrbitInvertRotation(initialUIState.orbitInvertRotation);
    showOrbitAnchorCheckbox.checked = initialUIState.showOrbitAnchor;
    viewer.setShowOrbitAnchor(initialUIState.showOrbitAnchor);

    restoreRange(
      planarPanSpeedInput,
      initialUIState.planarPanSpeed,
      cameraControls.updatePlanarPanSpeed
    );
    planarZoomToCursorCheckbox.checked = initialUIState.planarZoomToCursor;
    viewer.setPlanarZoomToCursor(initialUIState.planarZoomToCursor);
    planarInvertAxesCheckbox.checked = initialUIState.planarInvertAxes;
    viewer.setPlanarInvertAxes(initialUIState.planarInvertAxes);

    restoreRange(
      pointSizeInput,
      initialUIState.pointSize,
      renderControls.applyPointSizeFromSlider
    );

    lightingInput.value = initialUIState.lighting.raw;
    viewer.setLightingStrength(initialUIState.lighting.value / 100);
    lightingDisplay.textContent = initialUIState.lighting.raw;

    fogInput.value = initialUIState.fog.raw;
    viewer.setFogDensity(initialUIState.fog.value / 100);
    fogDisplay.textContent = initialUIState.fog.raw;

    sizeAttenuationInput.value = initialUIState.sizeAttenuation.raw;
    viewer.setSizeAttenuation(initialUIState.sizeAttenuation.value / 100);
    sizeAttenuationDisplay.textContent = initialUIState.sizeAttenuation.raw;

    restoreRange(
      smokeStepsInput,
      initialUIState.smokeSteps,
      renderControls.updateSmokeStepSlider
    );
    restoreRange(
      smokeDensityInput,
      initialUIState.smokeDensity,
      renderControls.updateSmokeDensitySlider
    );
    restoreRange(
      smokeSpeedInput,
      initialUIState.smokeSpeed,
      renderControls.updateSmokeSpeedSlider
    );
    restoreRange(
      smokeDetailInput,
      initialUIState.smokeDetail,
      renderControls.updateSmokeDetailSlider
    );
    restoreRange(
      smokeWarpInput,
      initialUIState.smokeWarp,
      renderControls.updateSmokeWarpSlider
    );
    restoreRange(
      smokeAbsorptionInput,
      initialUIState.smokeAbsorption,
      renderControls.updateSmokeAbsorptionSlider
    );
    restoreRange(
      smokeScatterInput,
      initialUIState.smokeScatter,
      renderControls.updateSmokeScatterSlider
    );
    restoreRange(
      smokeEdgeInput,
      initialUIState.smokeEdge,
      renderControls.updateSmokeEdgeSlider
    );
    restoreRange(
      smokeDirectLightInput,
      initialUIState.smokeDirectLight,
      renderControls.updateSmokeDirectLightSlider
    );
    restoreRange(
      smokeGridInput,
      initialUIState.smokeGrid,
      renderControls.updateSmokeGridSlider
    );
    restoreRange(
      cloudResolutionInput,
      initialUIState.cloudResolution,
      renderControls.updateCloudResolutionSlider
    );
    restoreRange(
      noiseResolutionInput,
      initialUIState.noiseResolution,
      renderControls.updateNoiseResolutionSlider
    );

    renderModeSelect.value = initialUIState.renderMode;
    renderControls.applyRenderMode(initialUIState.renderMode);
  }

  captureInitialState();

  resetCameraBtn.addEventListener('click', resetVisualizationToDefaults);
  document.addEventListener('keydown', (event) => {
    if (isTextEntryTarget(event.target)) {
      return;
    }
    if (event.key === 'r' || event.key === 'R') {
      viewer.resetCamera();
    }
  });

  return Object.freeze({ resetVisualizationToDefaults, captureInitialState });
}
