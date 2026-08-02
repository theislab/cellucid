/**
 * @fileoverview Rendering + volumetric smoke controls.
 *
 * Wires visualization controls (background, point size, lighting, fog, size
 * attenuation), the renderer controls (shader quality, adaptive LOD, forced LOD
 * level, frustum culling, antialiasing) and smoke controls
 * (grid/quality/density/etc) to the Viewer.
 *
 * Antialiasing is the one control here that does not publish to the viewer at
 * all. It is a WebGL context-creation attribute, fixed before this module runs,
 * so the control stores a preference and states on screen that it applies on the
 * next load. Everything else about it — ownership, restore, rollback — follows
 * the same rules as its neighbours.
 *
 * Also exposes a `markSmokeDirty()` hook used by the coordinator to trigger
 * debounced smoke rebuilds after visibility changes.
 *
 * The renderer controls arrived here late. They were wired inline at the far
 * end of the `main.js` bootstrap, past the point where a saved session is
 * restored — and the session serializer publishes a restored control by writing
 * the DOM and dispatching the event its owner listens for. With no listener
 * attached yet, every restored renderer setting stopped in the panel and the
 * viewer never heard about it (CEL-0129). Their owner is this module, which
 * `initUI` builds before anything is restored, so the restore reaches the
 * viewer by the same path a click does.
 *
 * @module ui/modules/render-controls
 */

import {
  isFiniteNumber,
  parseFiniteNumberInRange
} from '../../utils/number-utils.js';
import { getNotificationCenter } from '../../notification-center.js';
import { writeAntialiasPreference } from '../core/antialias-preference.js';
import {
  MAX_SMOKE_GRID_SIZE,
  SMOKE_GRID_SIZES,
  SmokeDensityBuildError,
} from '../../../rendering/smoke-cloud/smoke-density-contract.js';

const VIEWER_BACKGROUNDS = Object.freeze(['grid', 'grid-dark', 'white', 'black']);
const RENDER_MODES = Object.freeze(['points', 'smoke']);
const VIEWER_BACKGROUND_STORAGE_KEY = 'cellucid_viewer_background';

const RANGE_CONTROLS = Object.freeze([
  ['pointSizeInput', 'Point size slider', '0.5'],
  ['lightingInput', 'Lighting strength', '1'],
  ['fogInput', 'Fog density', '1'],
  ['sizeAttenuationInput', 'Perspective size scaling', '1'],
  ['smokeGridInput', 'Smoke grid density', '1'],
  ['smokeStepsInput', 'Smoke ray quality', '1'],
  ['smokeDensityInput', 'Smoke density', '1'],
  ['smokeSpeedInput', 'Smoke animation speed', '1'],
  ['smokeDetailInput', 'Smoke detail', '1'],
  ['smokeWarpInput', 'Smoke turbulence', '1'],
  ['smokeAbsorptionInput', 'Smoke light absorption', '1'],
  ['smokeScatterInput', 'Smoke light scattering', '1'],
  ['smokeEdgeInput', 'Smoke edge softness', '1'],
  ['smokeDirectLightInput', 'Smoke direct light', '1'],
  ['cloudResolutionInput', 'Smoke render resolution', '1'],
  ['noiseResolutionInput', 'Smoke noise resolution', '1']
]);

const DISPLAY_CONTROLS = Object.freeze([
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
  'noiseResolutionDisplay'
]);

const VIEWER_METHODS = Object.freeze([
  'setBackground',
  'setRenderMode',
  'setPointSize',
  'setLightingStrength',
  'setFogDensity',
  'setSizeAttenuation',
  'setSmokeParams',
  'setCloudResolutionScale',
  'setNoiseTextureResolution',
  'getAdaptiveScaleFactor',
  'hasSnapshots',
  'setShaderQuality',
  'setAdaptiveLOD',
  'setForceLOD',
  'setFrustumCulling',
  'getRequestedAntialiasing',
  'getGrantedAntialiasing'
]);

const SHADER_QUALITIES = Object.freeze(['full', 'light', 'ultralight']);

/** The forced-LOD slider range, matching `index.html` and the renderer. */
const FORCED_LOD_MINIMUM = -1;
const FORCED_LOD_MAXIMUM = 17;

function assertExactKeys(value, expectedKeys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be one exact object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    const unexpected = actual.filter(key => !expected.includes(key));
    const missing = expected.filter(key => !actual.includes(key));
    const detail = [
      unexpected.length ? `unexpected ${unexpected.join(', ')}` : '',
      missing.length ? `missing ${missing.join(', ')}` : ''
    ].filter(Boolean).join('; ');
    throw new TypeError(`${label} requires exact keys (${expected.join(', ')}): ${detail}.`);
  }
}

function assertMethod(owner, method, label) {
  if (typeof owner[method] !== 'function') {
    throw new TypeError(`${label} requires ${method}().`);
  }
}

function assertExactFunction(value, label) {
  if (typeof value !== 'function') {
    throw new TypeError(`${label} must be one exact function.`);
  }
  return value;
}

function assertEventControl(control, label) {
  if (
    control === null
    || typeof control !== 'object'
    || typeof control.value !== 'string'
    || typeof control.addEventListener !== 'function'
  ) {
    throw new TypeError(`${label} requires one current interactive DOM control.`);
  }
}

function assertToggleControl(control, label) {
  if (
    control === null
    || typeof control !== 'object'
    || typeof control.checked !== 'boolean'
    || typeof control.addEventListener !== 'function'
  ) {
    throw new TypeError(`${label} requires one current checkbox control.`);
  }
}

function assertShaderQuality(value) {
  if (!SHADER_QUALITIES.includes(value)) {
    throw new TypeError(
      'Shader quality must be exactly "full", "light", or "ultralight".'
    );
  }
  return value;
}

function assertForcedLodControl(control, label) {
  assertEventControl(control, label);
  if (
    control.min !== String(FORCED_LOD_MINIMUM)
    || control.max !== String(FORCED_LOD_MAXIMUM)
    || control.step !== '1'
  ) {
    throw new TypeError(
      `${label} requires exact range attributes min="${FORCED_LOD_MINIMUM}", `
      + `max="${FORCED_LOD_MAXIMUM}", step="1".`
    );
  }
  return assertForcedLodLevel(control.value, label);
}

function assertForcedLodLevel(value, label) {
  const level = Number(value);
  if (
    !Number.isInteger(level)
    || level < FORCED_LOD_MINIMUM
    || level > FORCED_LOD_MAXIMUM
  ) {
    throw new RangeError(
      `${label} must be an integer from ${FORCED_LOD_MINIMUM} `
      + `through ${FORCED_LOD_MAXIMUM}.`
    );
  }
  return level;
}

function assertContainer(control, label) {
  if (
    control === null
    || typeof control !== 'object'
    || control.style === null
    || typeof control.style !== 'object'
    || control.classList === null
    || typeof control.classList !== 'object'
    || typeof control.classList.toggle !== 'function'
  ) {
    throw new TypeError(`${label} requires one current DOM container.`);
  }
}

function assertDisplay(control, label) {
  if (
    control === null
    || typeof control !== 'object'
    || !('textContent' in control)
  ) {
    throw new TypeError(`${label} requires one current DOM display.`);
  }
}

function readExactRange(control, label, expectedStep) {
  assertEventControl(control, label);
  if (
    control.min !== '0'
    || control.max !== '100'
    || control.step !== expectedStep
  ) {
    throw new TypeError(
      `${label} requires exact range attributes min="0", max="100", step="${expectedStep}".`
    );
  }
  const value = parseFiniteNumberInRange(control.value, 0, 100, label);
  const step = Number(expectedStep);
  const quotient = value / step;
  if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
    throw new RangeError(`${label} must align exactly to step ${expectedStep}.`);
  }
  return value;
}

function assertViewerBackground(value) {
  if (!VIEWER_BACKGROUNDS.includes(value)) {
    throw new TypeError(
      'Viewer background must be exactly "grid", "grid-dark", "white", or "black".'
    );
  }
  return value;
}

function assertRenderMode(value) {
  if (!RENDER_MODES.includes(value)) {
    throw new TypeError('Render mode must be exactly "points" or "smoke".');
  }
  return value;
}

function assertAdaptiveScale(value) {
  if (!isFiniteNumber(value) || value <= 0) {
    throw new TypeError('Viewer adaptive scale factor must be one positive finite number.');
  }
  return value;
}

function assertSmokeGridSize(value) {
  if (
    !Number.isSafeInteger(value)
    || value < 8
    || value > MAX_SMOKE_GRID_SIZE
  ) {
    throw new RangeError(
      `Smoke grid size must be an integer from 8 through ${MAX_SMOKE_GRID_SIZE}.`
    );
  }
  return value;
}

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {object} options.dom
 * @param {HTMLSelectElement|null} options.dom.backgroundSelect
 * @param {HTMLSelectElement|null} options.dom.renderModeSelect
 * @param {HTMLElement|null} options.dom.depthControls
 * @param {HTMLElement|null} options.dom.rendererControls
 * @param {HTMLElement|null} options.dom.pointsControls
 * @param {HTMLElement|null} options.dom.smokeControls
 * @param {HTMLInputElement|null} options.dom.pointSizeInput
 * @param {HTMLElement|null} options.dom.pointSizeDisplay
 * @param {HTMLInputElement|null} options.dom.lightingInput
 * @param {HTMLElement|null} options.dom.lightingDisplay
 * @param {HTMLInputElement|null} options.dom.fogInput
 * @param {HTMLElement|null} options.dom.fogDisplay
 * @param {HTMLInputElement|null} options.dom.sizeAttenuationInput
 * @param {HTMLElement|null} options.dom.sizeAttenuationDisplay
 * @param {HTMLInputElement|null} options.dom.smokeGridInput
 * @param {HTMLElement|null} options.dom.smokeGridDisplay
 * @param {HTMLInputElement|null} options.dom.smokeStepsInput
 * @param {HTMLElement|null} options.dom.smokeStepsDisplay
 * @param {HTMLInputElement|null} options.dom.smokeDensityInput
 * @param {HTMLElement|null} options.dom.smokeDensityDisplay
 * @param {HTMLInputElement|null} options.dom.smokeSpeedInput
 * @param {HTMLElement|null} options.dom.smokeSpeedDisplay
 * @param {HTMLInputElement|null} options.dom.smokeDetailInput
 * @param {HTMLElement|null} options.dom.smokeDetailDisplay
 * @param {HTMLInputElement|null} options.dom.smokeWarpInput
 * @param {HTMLElement|null} options.dom.smokeWarpDisplay
 * @param {HTMLInputElement|null} options.dom.smokeAbsorptionInput
 * @param {HTMLElement|null} options.dom.smokeAbsorptionDisplay
 * @param {HTMLInputElement|null} options.dom.smokeScatterInput
 * @param {HTMLElement|null} options.dom.smokeScatterDisplay
 * @param {HTMLInputElement|null} options.dom.smokeEdgeInput
 * @param {HTMLElement|null} options.dom.smokeEdgeDisplay
 * @param {HTMLInputElement|null} options.dom.smokeDirectLightInput
 * @param {HTMLElement|null} options.dom.smokeDirectLightDisplay
 * @param {HTMLInputElement|null} options.dom.cloudResolutionInput
 * @param {HTMLElement|null} options.dom.cloudResolutionDisplay
 * @param {HTMLInputElement|null} options.dom.noiseResolutionInput
 * @param {HTMLElement|null} options.dom.noiseResolutionDisplay
 * @param {{ rebuildSmokeDensity: (gridSize: number) => void }} options.smoke
 */
export function initRenderControls(options) {
  assertExactKeys(options, ['viewer', 'dom', 'smoke'], 'Render controls initialization');
  const { viewer, dom, smoke } = options;
  if (viewer === null || typeof viewer !== 'object' || Array.isArray(viewer)) {
    throw new TypeError('Render controls require one current viewer object.');
  }
  for (const method of VIEWER_METHODS) {
    assertMethod(viewer, method, 'Render controls viewer');
  }
  assertExactKeys(smoke, ['rebuildSmokeDensity'], 'Render controls smoke owner');
  assertMethod(smoke, 'rebuildSmokeDensity', 'Render controls smoke owner');
  if (dom === null || typeof dom !== 'object' || Array.isArray(dom)) {
    throw new TypeError('Render controls require one current DOM inventory.');
  }

  const rebuildSmokeDensity = smoke.rebuildSmokeDensity;

  const {
    backgroundSelect,
    renderModeSelect,
    depthControls,
    rendererControls,
    pointsControls,
    smokeControls,
    pointSizeInput,
    pointSizeDisplay,
    lightingInput: lightingStrengthInput,
    lightingDisplay: lightingStrengthDisplay,
    fogInput: fogDensityInput,
    fogDisplay: fogDensityDisplay,
    sizeAttenuationInput,
    sizeAttenuationDisplay,
    smokeGridInput,
    smokeGridDisplay,
    smokeStepsInput,
    smokeStepsDisplay,
    smokeDensityInput,
    smokeDensityDisplay,
    smokeSpeedInput,
    smokeSpeedDisplay,
    smokeDetailInput,
    smokeDetailDisplay,
    smokeWarpInput,
    smokeWarpDisplay,
    smokeAbsorptionInput,
    smokeAbsorptionDisplay,
    smokeScatterInput,
    smokeScatterDisplay,
    smokeEdgeInput,
    smokeEdgeDisplay,
    smokeDirectLightInput,
    smokeDirectLightDisplay,
    cloudResolutionInput,
    cloudResolutionDisplay,
    noiseResolutionInput,
    noiseResolutionDisplay,
    hpShaderQualitySelect,
    hpLodEnabledCheckbox,
    hpLodForceInput,
    hpLodForceContainer,
    hpLodForceDisplay,
    hpFrustumCullingCheckbox,
    hpAntialiasCheckbox,
    hpAntialiasStatus
  } = dom;

  assertEventControl(backgroundSelect, 'Viewer background selector');
  assertEventControl(renderModeSelect, 'Render mode selector');
  assertContainer(depthControls, 'Depth controls');
  assertContainer(rendererControls, 'Renderer controls');
  assertContainer(pointsControls, 'Point controls');
  assertContainer(smokeControls, 'Smoke controls');
  assertEventControl(hpShaderQualitySelect, 'Shader quality selector');
  assertShaderQuality(hpShaderQualitySelect.value);
  assertToggleControl(hpLodEnabledCheckbox, 'Adaptive LOD toggle');
  assertToggleControl(hpFrustumCullingCheckbox, 'Frustum culling toggle');
  assertToggleControl(hpAntialiasCheckbox, 'Antialiasing toggle');
  assertDisplay(hpAntialiasStatus, 'hpAntialiasStatus');
  assertContainer(hpLodForceContainer, 'Forced LOD level row');
  assertDisplay(hpLodForceDisplay, 'hpLodForceDisplay');
  assertForcedLodControl(hpLodForceInput, 'Forced LOD level slider');
  for (const [key, label, step] of RANGE_CONTROLS) {
    readExactRange(dom[key], label, step);
  }
  for (const key of DISPLAY_CONTROLS) {
    assertDisplay(dom[key], key);
  }
  if (
    typeof document === 'undefined'
    || document.documentElement === null
    || typeof document.documentElement !== 'object'
    || document.documentElement.dataset === null
    || typeof document.documentElement.dataset !== 'object'
  ) {
    throw new TypeError('Render controls require the current document element.');
  }
  const initialBackground = assertViewerBackground(
    document.documentElement.dataset.viewerBackground
  );
  assertRenderMode(renderModeSelect.value);

  // Volumetric smoke UI state
  let smokeDirty = false;
  let smokeBuiltOnce = false;
  let smokeGridSize = 128;
  let noiseResolutionScale = assertAdaptiveScale(viewer.getAdaptiveScaleFactor());
  let destroyed = false;
  const domLifecycle = new AbortController();

  function listen(control, eventName, handler) {
    control.addEventListener(
      eventName,
      handler,
      { signal: domLifecycle.signal }
    );
  }

  // Slider input remains debounced. A committed visibility generation first
  // gets one paint opportunity, then starts density work in the following
  // frame so a large build cannot hide the newly published UI state.
  let smokeRebuildTimeout = null;
  let committedSmokeRebuildQueued = false;
  let smokePaintFrame = null;
  let smokeBuildFrame = null;

  function rebuildDirtySmokeIfActive() {
    if (destroyed) return;
    if (renderModeSelect.value !== 'smoke' || !smokeDirty) return;
    try {
      rebuildSmokeDensity(smokeGridSize);
      markSmokeClean();
    } catch (error) {
      settleSmokeBuildFailure(error);
    }
  }

  function scheduleSliderSmokeRebuild() {
    if (destroyed) return;
    if (smokeRebuildTimeout !== null) clearTimeout(smokeRebuildTimeout);
    smokeDirty = true;
    smokeRebuildTimeout = setTimeout(() => {
      smokeRebuildTimeout = null;
      if (destroyed) return;
      rebuildDirtySmokeIfActive();
    }, 300);
  }

  function markSmokeDirty() {
    if (destroyed) return;
    smokeDirty = true;
    if (renderModeSelect.value !== 'smoke' || committedSmokeRebuildQueued) return;
    if (smokeRebuildTimeout !== null) {
      clearTimeout(smokeRebuildTimeout);
      smokeRebuildTimeout = null;
    }
    committedSmokeRebuildQueued = true;
    smokePaintFrame = requestAnimationFrame(() => {
      smokePaintFrame = null;
      if (destroyed) {
        committedSmokeRebuildQueued = false;
        return;
      }
      smokeBuildFrame = requestAnimationFrame(() => {
        smokeBuildFrame = null;
        committedSmokeRebuildQueued = false;
        if (destroyed) return;
        rebuildDirtySmokeIfActive();
      });
    });
  }

  function markSmokeClean() {
    if (destroyed) return;
    smokeDirty = false;
    smokeBuiltOnce = true;
    if (smokeRebuildTimeout !== null) {
      clearTimeout(smokeRebuildTimeout);
      smokeRebuildTimeout = null;
    }
  }

  // Log-scale point size mapping
  const MIN_POINT_SIZE = 0.25;
  const MAX_POINT_SIZE = 200.0;
  const POINT_SIZE_SCALE = MAX_POINT_SIZE / MIN_POINT_SIZE;

  function sliderToPointSize(sliderValue) {
    const raw = parseFiniteNumberInRange(
      sliderValue,
      0,
      100,
      'Point size slider'
    );
    const t = raw / 100;
    return MIN_POINT_SIZE * Math.pow(POINT_SIZE_SCALE, t);
  }

  function pointSizeToSlider(size) {
    if (!isFiniteNumber(size)) {
      throw new TypeError('Point size must be one finite number.');
    }
    if (size < MIN_POINT_SIZE || size > MAX_POINT_SIZE) {
      throw new RangeError(
        `Point size must be between ${MIN_POINT_SIZE} and ${MAX_POINT_SIZE}.`
      );
    }
    return (Math.log(size / MIN_POINT_SIZE) / Math.log(POINT_SIZE_SCALE)) * 100;
  }

  function formatPointSize(size) {
    if (size < 0.1) return size.toFixed(3);
    return size < 10 ? size.toFixed(2) : size.toFixed(1);
  }

  function applyPointSizeFromSlider() {
    const size = sliderToPointSize(pointSizeInput.value);
    viewer.setPointSize(size);
    pointSizeDisplay.textContent = formatPointSize(size);
  }

  let currentRenderMode = renderModeSelect.value;
  let renderModeChangeHandler = null;

  function notifyRenderModeChange(mode) {
    if (destroyed) return;
    const observer = renderModeChangeHandler;
    if (observer === null) return;
    try {
      observer(mode);
    } catch (error) {
      const exactError = error instanceof Error
        ? error
        : new Error(
          'Render-mode change handler failed with a non-Error value.'
        );
      queueMicrotask(() => {
        throw exactError;
      });
    }
  }

  function syncRenderModeUi(mode) {
    renderModeSelect.value = mode;
    smokeControls.classList.toggle('visible', mode === 'smoke');
    pointsControls.classList.toggle('visible', mode === 'points');
    depthControls.style.display = mode === 'smoke' ? 'none' : 'block';
    rendererControls.style.display = mode === 'smoke' ? 'none' : 'block';
    currentRenderMode = mode;
  }

  function publishRenderMode(mode) {
    viewer.setRenderMode(mode);
    syncRenderModeUi(mode);
    notifyRenderModeChange(mode);
  }

  function settleSmokeRenderFailure(error) {
    const exactError = error instanceof Error
      ? error
      : new Error('Smoke rendering failed with a non-Error value.');
    if (destroyed) return exactError;
    smokeDirty = true;
    syncRenderModeUi('points');
    notifyRenderModeChange('points');
    getNotificationCenter().error(
      `Smoke rendering failed: ${exactError.message}`,
      { category: 'rendering' }
    );
  }

  function settleSmokeBuildFailure(error) {
    if (destroyed) return;
    smokeDirty = true;
    if (!(error instanceof SmokeDensityBuildError)) {
      const message = error instanceof Error
        ? error.message
        : String(error);
      getNotificationCenter().error(
        `Smoke density could not be built: ${message}`,
        { category: 'rendering' }
      );
    }
    publishRenderMode('points');
  }

  function applyRenderMode(mode) {
    if (destroyed) return false;
    const exactMode = assertRenderMode(mode);
    if (exactMode === 'smoke' && viewer.hasSnapshots()) {
      throw new RangeError('Smoke render mode is unavailable while snapshots exist.');
    }

    // Build smoke volume on first switch to smoke mode, or if dirty.
    if (exactMode === 'smoke' && (!smokeBuiltOnce || smokeDirty)) {
      try {
        rebuildSmokeDensity(smokeGridSize);
        markSmokeClean();
      } catch (error) {
        settleSmokeBuildFailure(error);
        return false;
      }
    }
    publishRenderMode(exactMode);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Smoke parameter sliders
  // ---------------------------------------------------------------------------

  function getResolutionAdaptiveFactor(power) {
    const baseGrid = 128;
    const gridFactor = Math.pow(smokeGridSize / baseGrid, power);
    return gridFactor * noiseResolutionScale;
  }

  function updateSmokeStepSlider() {
    const t = readExactRange(
      smokeStepsInput,
      'Smoke ray quality',
      '1'
    ) / 100;
    const label = t < 0.33 ? 'Fast' : (t < 0.66 ? 'Balanced' : (t < 0.9 ? 'High' : 'Ultra'));
    smokeStepsDisplay.textContent = label;

    const eased = Math.pow(t, 3);
    const adaptive = getResolutionAdaptiveFactor(0.35);
    const stepMultiplier = (0.5 + 4.0 * eased) * adaptive;
    viewer.setSmokeParams({ stepMultiplier });
  }

  function getAdaptiveDensityRange() {
    const scaleFactor = getResolutionAdaptiveFactor(0.5);
    const minDensity = 0.4 * scaleFactor;
    const maxDensity = 8.0 * scaleFactor * 1.4;
    return { min: minDensity, max: maxDensity };
  }

  function updateSmokeDensitySlider() {
    const t = readExactRange(
      smokeDensityInput,
      'Smoke density',
      '1'
    ) / 100;
    const { min, max } = getAdaptiveDensityRange();
    const density = min + t * (max - min);
    smokeDensityDisplay.textContent = density.toFixed(1);
    viewer.setSmokeParams({ density });
  }

  function updateSmokeSpeedSlider() {
    const t = readExactRange(
      smokeSpeedInput,
      'Smoke animation speed',
      '1'
    ) / 100;
    const animationSpeed = t * 2.5;
    smokeSpeedDisplay.textContent = animationSpeed.toFixed(2);
    viewer.setSmokeParams({ animationSpeed });
  }

  function getAdaptiveDetailRange() {
    const scaleFactor = getResolutionAdaptiveFactor(0.35);
    const maxDetail = 5.0 * scaleFactor;
    return { min: 0, max: maxDetail };
  }

  function updateSmokeDetailSlider() {
    const t = readExactRange(
      smokeDetailInput,
      'Smoke detail',
      '1'
    ) / 100;
    const { min, max } = getAdaptiveDetailRange();
    const detailLevel = min + t * (max - min);
    smokeDetailDisplay.textContent = detailLevel.toFixed(1);
    viewer.setSmokeParams({ detailLevel });
  }

  function updateSmokeWarpSlider() {
    const t = readExactRange(
      smokeWarpInput,
      'Smoke turbulence',
      '1'
    ) / 100;
    const warpStrength = t * 2.0;
    smokeWarpDisplay.textContent = (t * 100).toFixed(0) + '%';
    viewer.setSmokeParams({ warpStrength });
  }

  function updateSmokeAbsorptionSlider() {
    const t = readExactRange(
      smokeAbsorptionInput,
      'Smoke light absorption',
      '1'
    ) / 100;
    const adaptive = getResolutionAdaptiveFactor(0.2);
    const lightAbsorption = (t * 2.0) * adaptive;
    smokeAbsorptionDisplay.textContent = lightAbsorption.toFixed(1);
    viewer.setSmokeParams({ lightAbsorption });
  }

  function updateSmokeScatterSlider() {
    const t = readExactRange(
      smokeScatterInput,
      'Smoke light scattering',
      '1'
    ) / 100;
    const scatterStrength = (t * 2.0) * getResolutionAdaptiveFactor(0.15);
    smokeScatterDisplay.textContent = scatterStrength.toFixed(1);
    viewer.setSmokeParams({ scatterStrength });
  }

  function updateSmokeEdgeSlider() {
    const t = readExactRange(
      smokeEdgeInput,
      'Smoke edge softness',
      '1'
    ) / 100;
    const edgeSoftness = 0.2 + t * 1.8;
    smokeEdgeDisplay.textContent = edgeSoftness.toFixed(1);
    viewer.setSmokeParams({ edgeSoftness });
  }

  function updateSmokeDirectLightSlider() {
    const t = readExactRange(
      smokeDirectLightInput,
      'Smoke direct light',
      '1'
    ) / 100;
    const directLightIntensity = t * 1.5;
    smokeDirectLightDisplay.textContent = directLightIntensity.toFixed(2) + 'x';
    viewer.setSmokeParams({ directLightIntensity });
  }

  updateSmokeStepSlider();
  listen(smokeStepsInput, 'input', updateSmokeStepSlider);
  updateSmokeDensitySlider();
  listen(smokeDensityInput, 'input', updateSmokeDensitySlider);
  updateSmokeSpeedSlider();
  listen(smokeSpeedInput, 'input', updateSmokeSpeedSlider);
  updateSmokeDetailSlider();
  listen(smokeDetailInput, 'input', updateSmokeDetailSlider);
  updateSmokeWarpSlider();
  listen(smokeWarpInput, 'input', updateSmokeWarpSlider);
  updateSmokeAbsorptionSlider();
  listen(smokeAbsorptionInput, 'input', updateSmokeAbsorptionSlider);
  updateSmokeScatterSlider();
  listen(smokeScatterInput, 'input', updateSmokeScatterSlider);
  updateSmokeEdgeSlider();
  listen(smokeEdgeInput, 'input', updateSmokeEdgeSlider);
  updateSmokeDirectLightSlider();
  listen(smokeDirectLightInput, 'input', updateSmokeDirectLightSlider);

  function sliderToGridSize(sliderValue) {
    if (!isFiniteNumber(sliderValue) || sliderValue < 0 || sliderValue > 100) {
      throw new RangeError('Smoke grid density must be a finite number between 0 and 100.');
    }
    const t = sliderValue / 100;
    const idx = Math.min(
      SMOKE_GRID_SIZES.length - 1,
      Math.floor(t * SMOKE_GRID_SIZES.length)
    );
    return SMOKE_GRID_SIZES[idx];
  }

  function updateSmokeGridSlider() {
    const raw = readExactRange(
      smokeGridInput,
      'Smoke grid density',
      '1'
    );
    const size = sliderToGridSize(raw);
    smokeGridDisplay.textContent = size + '³';
    if (size !== smokeGridSize) {
      smokeGridSize = size;
      updateSmokeDensitySlider();
      updateSmokeDetailSlider();
      updateSmokeWarpSlider();
      updateSmokeAbsorptionSlider();
      updateSmokeScatterSlider();
      updateSmokeStepSlider();
      scheduleSliderSmokeRebuild();
    }
  }

  smokeGridSize = sliderToGridSize(
    readExactRange(smokeGridInput, 'Smoke grid density', '1')
  );
  smokeGridDisplay.textContent = smokeGridSize + '³';
  listen(smokeGridInput, 'input', updateSmokeGridSlider);

  function updateCloudResolutionSlider() {
    const raw = readExactRange(
      cloudResolutionInput,
      'Smoke render resolution',
      '1'
    );
    const scale = raw === 43
      ? 1
      : 0.25 + (raw / 100) * 1.75;
    cloudResolutionDisplay.textContent = scale.toFixed(2) + 'x';
    viewer.setCloudResolutionScale(scale);
  }

  function updateNoiseResolutionSlider() {
    const t = readExactRange(
      noiseResolutionInput,
      'Smoke noise resolution',
      '1'
    ) / 100;
    const steps = [32, 48, 64, 96, 128, 192, 256];
    const idx = Math.min(steps.length - 1, Math.floor(t * steps.length));
    const size = steps[idx];
    noiseResolutionDisplay.textContent = size + '³';
    viewer.setNoiseTextureResolution(size);
    noiseResolutionScale = assertAdaptiveScale(viewer.getAdaptiveScaleFactor());
    updateSmokeDensitySlider();
    updateSmokeDetailSlider();
    updateSmokeWarpSlider();
    updateSmokeAbsorptionSlider();
    updateSmokeScatterSlider();
    updateSmokeStepSlider();
  }

  updateCloudResolutionSlider();
  listen(cloudResolutionInput, 'input', updateCloudResolutionSlider);
  updateNoiseResolutionSlider();
  listen(noiseResolutionInput, 'input', updateNoiseResolutionSlider);

  // ---------------------------------------------------------------------------
  // Non-smoke visualization controls
  // ---------------------------------------------------------------------------

  listen(pointSizeInput, 'input', applyPointSizeFromSlider);

  let currentBackground = initialBackground;
  backgroundSelect.value = initialBackground;
  viewer.setBackground(initialBackground);
  listen(backgroundSelect, 'change', () => {
    let preferencePublished = false;
    let viewerPublished = false;
    try {
      const next = assertViewerBackground(backgroundSelect.value);
      localStorage.setItem(VIEWER_BACKGROUND_STORAGE_KEY, next);
      preferencePublished = true;
      viewer.setBackground(next);
      viewerPublished = true;
      document.documentElement.dataset.viewerBackground = next;
      currentBackground = next;
    } catch (error) {
      backgroundSelect.value = currentBackground;
      const rollbackFailures = [];
      if (preferencePublished) {
        try {
          localStorage.setItem(VIEWER_BACKGROUND_STORAGE_KEY, currentBackground);
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      if (viewerPublished) {
        try {
          viewer.setBackground(currentBackground);
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      document.documentElement.dataset.viewerBackground = currentBackground;
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          'Viewer background publication and rollback both failed.'
        );
      }
      throw error;
    }
  });

  function updateLightingStrength() {
    const raw = readExactRange(
      lightingStrengthInput,
      'Lighting strength',
      '1'
    );
    viewer.setLightingStrength(raw / 100);
    lightingStrengthDisplay.textContent = lightingStrengthInput.value;
  }

  function updateFogDensity() {
    const raw = readExactRange(
      fogDensityInput,
      'Fog density',
      '1'
    );
    viewer.setFogDensity(raw / 100);
    fogDensityDisplay.textContent = fogDensityInput.value;
  }

  function updateSizeAttenuation() {
    const raw = readExactRange(
      sizeAttenuationInput,
      'Perspective size scaling',
      '1'
    );
    viewer.setSizeAttenuation(raw / 100);
    sizeAttenuationDisplay.textContent = sizeAttenuationInput.value;
  }

  listen(lightingStrengthInput, 'input', updateLightingStrength);
  listen(fogDensityInput, 'input', updateFogDensity);
  listen(sizeAttenuationInput, 'input', updateSizeAttenuation);

  applyRenderMode(renderModeSelect.value);
  listen(renderModeSelect, 'change', () => {
    const requested = assertRenderMode(renderModeSelect.value);
    if (requested === 'smoke' && viewer.hasSnapshots()) {
      renderModeSelect.value = currentRenderMode;
      getNotificationCenter().warning(
        'Volumetric smoke requires a single view. Clear snapshots first.',
        { category: 'rendering' }
      );
      return;
    }
    applyRenderMode(requested);
  });

  // ---------------------------------------------------------------------------
  // Renderer controls: shader quality, adaptive LOD, forced LOD, culling
  //
  // Publication is transactional in the viewer: a rejected change leaves the
  // renderer's previous value authoritative, so the control returns to the last
  // value the renderer accepted rather than keeping the one it refused. These
  // baselines are that record, seeded from the markup defaults, which are the
  // values the renderer is constructed with.
  // ---------------------------------------------------------------------------

  let acceptedShaderQuality = assertShaderQuality(hpShaderQualitySelect.value);
  let acceptedFrustumEnabled = hpFrustumCullingCheckbox.checked;
  let acceptedLodEnabled = hpLodEnabledCheckbox.checked;
  let acceptedForcedLodValue = hpLodForceInput.value;

  function formatForcedLodLevel(level) {
    return level < 0 ? 'Auto' : String(level);
  }

  function syncForcedLodUi() {
    hpLodForceContainer.style.display = acceptedLodEnabled ? 'block' : 'none';
    hpLodForceDisplay.textContent = formatForcedLodLevel(
      assertForcedLodLevel(hpLodForceInput.value, 'Forced LOD level')
    );
  }

  function reportRendererControlFailure(control, error) {
    const exactError = error instanceof Error ? error : new Error(String(error));
    console.error(`[RenderControls] ${control} could not be changed:`, exactError);
    try {
      getNotificationCenter().error(
        `${control} was not changed: ${exactError.message}`,
        {
          category: 'rendering',
          title: 'Renderer setting unavailable'
        }
      );
    } catch (notificationError) {
      // Control state is already coherent. Notification delivery is
      // observational and must not escape the synchronous DOM event.
      console.error(
        '[RenderControls] Renderer control failure notification was not delivered:',
        notificationError
      );
    }
  }

  listen(hpShaderQualitySelect, 'change', () => {
    const previousQuality = acceptedShaderQuality;
    let requestedQuality;
    try {
      requestedQuality = assertShaderQuality(hpShaderQualitySelect.value);
      viewer.setShaderQuality(requestedQuality);
      acceptedShaderQuality = requestedQuality;
    } catch (error) {
      hpShaderQualitySelect.value = previousQuality;
      reportRendererControlFailure('Shader quality', error);
    }
  });

  listen(hpFrustumCullingCheckbox, 'change', () => {
    const requestedEnabled = hpFrustumCullingCheckbox.checked;
    const previousEnabled = acceptedFrustumEnabled;
    try {
      viewer.setFrustumCulling(requestedEnabled);
      acceptedFrustumEnabled = requestedEnabled;
    } catch (error) {
      hpFrustumCullingCheckbox.checked = previousEnabled;
      reportRendererControlFailure('Frustum culling', error);
    }
  });

  listen(hpLodEnabledCheckbox, 'change', () => {
    const requestedEnabled = hpLodEnabledCheckbox.checked;
    const previousEnabled = acceptedLodEnabled;
    const previousForcedValue = acceptedForcedLodValue;
    let featurePublished = false;
    try {
      viewer.setAdaptiveLOD(requestedEnabled);
      featurePublished = true;
      // Enabling starts from adaptive mode. Disabling already resets the
      // renderer's global force level as part of the atomic toggle.
      if (requestedEnabled) viewer.setForceLOD(FORCED_LOD_MINIMUM);
      acceptedLodEnabled = requestedEnabled;
      acceptedForcedLodValue = String(FORCED_LOD_MINIMUM);
      hpLodForceInput.value = acceptedForcedLodValue;
      syncForcedLodUi();
    } catch (error) {
      const failures = [error];
      if (featurePublished) {
        try {
          viewer.setAdaptiveLOD(previousEnabled);
          if (previousEnabled) {
            viewer.setForceLOD(
              assertForcedLodLevel(previousForcedValue, 'Forced LOD level')
            );
          }
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      hpLodEnabledCheckbox.checked = previousEnabled;
      hpLodForceInput.value = previousForcedValue;
      syncForcedLodUi();
      reportRendererControlFailure(
        'Adaptive LOD',
        failures.length === 1
          ? error
          : new AggregateError(
            failures,
            'Adaptive LOD publication and UI rollback failed.'
          )
      );
    }
  });

  listen(hpLodForceInput, 'input', () => {
    const previousForcedValue = acceptedForcedLodValue;
    try {
      const requestedLevel = assertForcedLodLevel(
        hpLodForceInput.value,
        'Forced LOD level'
      );
      viewer.setForceLOD(requestedLevel);
      acceptedForcedLodValue = String(requestedLevel);
      hpLodForceDisplay.textContent = formatForcedLodLevel(requestedLevel);
    } catch (error) {
      hpLodForceInput.value = previousForcedValue;
      syncForcedLodUi();
      reportRendererControlFailure('Forced LOD level', error);
    }
  });

  // The forced-LOD row is meaningless while adaptive LOD is off — the renderer
  // ignores the global forced level in that state — and markup cannot express
  // "hidden unless the checkbox beside me is on".
  syncForcedLodUi();

  // ---------------------------------------------------------------------------
  // Antialiasing
  //
  // The odd one out, and it says so on screen. `antialias` is a WebGL
  // context-creation attribute, so there is no setter to call: the viewer's
  // context already has the value it will keep, and a change reaches the GPU
  // only through a page load. See `ui/core/antialias-preference.js` for why a
  // live context swap is not on the table.
  //
  // So the control owns exactly two things — the stored preference, and telling
  // the user the truth about when it takes effect. The comparison is always
  // against the viewer's own record of what it was built with, never against
  // storage, so the notice is about this page rather than about a value another
  // tab may have written.
  // ---------------------------------------------------------------------------

  const antialiasingInForce = viewer.getRequestedAntialiasing();
  const antialiasingGranted = viewer.getGrantedAntialiasing();

  function syncAntialiasStatus() {
    if (antialiasingInForce && !antialiasingGranted) {
      // Asked for and refused. Saying "reload to apply" here would be a lie:
      // reloading would ask again and be refused again.
      hpAntialiasStatus.textContent =
        'This browser is not providing antialiasing for this view.';
      return;
    }
    hpAntialiasStatus.textContent =
      hpAntialiasCheckbox.checked === antialiasingInForce
        ? ''
        : 'Saved. Reload the page to apply — the browser fixes this when it '
          + 'creates the drawing buffer.';
  }

  // The markup default is "on", which is also the preference default, but the
  // viewer was built from whatever was stored. Seeding from the viewer is what
  // stops a reloaded page showing a ticked box over an unantialiased canvas.
  hpAntialiasCheckbox.checked = antialiasingInForce;
  let acceptedAntialiasPreference = antialiasingInForce;
  syncAntialiasStatus();

  listen(hpAntialiasCheckbox, 'change', () => {
    const requested = hpAntialiasCheckbox.checked;
    const previous = acceptedAntialiasPreference;
    try {
      writeAntialiasPreference(localStorage, requested);
      acceptedAntialiasPreference = requested;
      syncAntialiasStatus();
    } catch (error) {
      // Storing the preference is the only thing this control does. If that
      // fails the setting would do nothing at all on the next load, so the box
      // returns to the value that is actually stored rather than showing a
      // choice that was never recorded. A session restore reads the control
      // back after dispatching, so this rollback is also what makes a restore
      // that could not be persisted fail loudly instead of silently.
      hpAntialiasCheckbox.checked = previous;
      syncAntialiasStatus();
      reportRendererControlFailure('Antialiasing', error);
    }
  });

  applyPointSizeFromSlider();
  updateLightingStrength();
  updateFogDensity();
  updateSizeAttenuation();

  return {
    markSmokeDirty,
    markSmokeClean,
    settleSmokeRenderFailure,
    setRenderModeChangeHandler(fn) {
      renderModeChangeHandler = assertExactFunction(
        fn,
        'Render-mode change handler'
      );
    },
    applyRenderMode,
    applyPointSizeFromSlider,
    pointSizeToSlider,
    getSmokeGridSize: () => smokeGridSize,
    rebuildSmokeDensity: gridSize => rebuildSmokeDensity(assertSmokeGridSize(gridSize)),

    updateSmokeStepSlider,
    updateSmokeDensitySlider,
    updateSmokeSpeedSlider,
    updateSmokeDetailSlider,
    updateSmokeWarpSlider,
    updateSmokeAbsorptionSlider,
    updateSmokeScatterSlider,
    updateSmokeEdgeSlider,
    updateSmokeDirectLightSlider,
    updateSmokeGridSlider,
    updateCloudResolutionSlider,
    updateNoiseResolutionSlider,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      renderModeChangeHandler = null;
      domLifecycle.abort();
      smokeDirty = false;
      committedSmokeRebuildQueued = false;
      if (smokeRebuildTimeout !== null) {
        clearTimeout(smokeRebuildTimeout);
        smokeRebuildTimeout = null;
      }
      if (smokePaintFrame !== null) {
        if (typeof globalThis.cancelAnimationFrame === 'function') {
          globalThis.cancelAnimationFrame(smokePaintFrame);
        }
        smokePaintFrame = null;
      }
      if (smokeBuildFrame !== null) {
        if (typeof globalThis.cancelAnimationFrame === 'function') {
          globalThis.cancelAnimationFrame(smokeBuildFrame);
        }
        smokeBuildFrame = null;
      }
    }
  };
}
