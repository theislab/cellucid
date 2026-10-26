/**
 * @fileoverview Rendering + volumetric smoke controls.
 *
 * Wires visualization controls (background, point size, lighting, fog, size
 * attenuation), the renderer controls (shader quality, adaptive LOD, forced LOD
 * level, frustum culling, antialiasing) and smoke controls
 * (grid/quality/density/etc) to the Viewer.
 *
 * Antialiasing is the one control here that publishes to two places: to the
 * viewer, like its neighbours, and to `localStorage`, because the preference
 * describes the machine rather than the view. It also has a third state its
 * checkbox cannot show — `auto`, which defers to the dataset's cell count.
 * Everything else about it — ownership, restore, rollback — follows the same
 * rules as its neighbours.
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

import { parseFiniteNumberInRange } from '../../utils/number-utils.js';
import { getNotificationCenter } from '../../notification-center.js';
import { formatDecimal } from '../components/display-format.js';
import { formatCount, formatCountOf } from '../../../utils/format-units.js';
import {
  antialiasingInForce,
  resolveAntialiasPreference,
  writeAntialiasPreference,
} from '../core/antialias-preference.js';
import {
  MAX_SMOKE_GRID_SIZE,
  SmokeDensityBuildError,
  SmokeUnsupportedError,
} from '../../../rendering/smoke-cloud/smoke-density-contract.js';
import { reportSmokeUnavailable } from './smoke-availability.js';
import {
  describeShaderQualities,
  isShaderQuality,
} from '../../../rendering/shader-quality.js';
import {
  smokeAbsorptionScale,
  smokeDensityScale,
  smokeDetailScale,
  smokeDirectLightScale,
  smokeEdgeScale,
  smokeGridScale,
  smokeNoiseScale,
  smokeRayQualityScale,
  smokeResolutionScale,
  smokeScatterScale,
  smokeSpeedScale,
  smokeTurbulenceScale,
} from './smoke-control-scales.js';
import {
  formatPointSize,
  pointSizeSliderPositionForCellCount,
  pointSizeToSliderPosition,
  sliderPositionToPointSize,
  POINT_SIZE_SLIDER_MAXIMUM,
  POINT_SIZE_SLIDER_MINIMUM,
} from '../../../rendering/point-size-scale.js';
import {
  VIEWER_BACKGROUND_ERROR_MESSAGE,
  isViewerBackground,
} from '../../../rendering/viewer-backgrounds.js';
import { requireExactObjectKeys } from '../../../utils/exact-record.js';
import { PLACES } from '../place-names.js';

const RENDER_MODES = Object.freeze(['points', 'smoke']);
const VIEWER_BACKGROUND_STORAGE_KEY = 'cellucid_viewer_background';

const RANGE_CONTROLS = Object.freeze([
  ['pointSizeInput', 'Point size slider', '0.5', POINT_SIZE_SLIDER_MINIMUM],
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
  'getSmokeSupport',
  'hasSnapshots',
  'setShaderQuality',
  'setAdaptiveLOD',
  'setForceLOD',
  'setFrustumCulling',
  'setAntialiasing',
  'getAntialiasing',
  'isAntialiasingAvailable'
]);


/** The forced-LOD slider range, matching `index.html` and the renderer. */
const FORCED_LOD_MINIMUM = -1;
const FORCED_LOD_MAXIMUM = 17;

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
  if (!isShaderQuality(value)) {
    throw new TypeError(
      `Shader quality must be exactly ${describeShaderQualities()}.`
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

function assertHideableElement(control, label) {
  if (
    control === null
    || typeof control !== 'object'
    || typeof control.hidden !== 'boolean'
  ) {
    throw new TypeError(`${label} requires one current hideable DOM element.`);
  }
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

function readExactRange(control, label, expectedStep, expectedMinimum = 0) {
  assertEventControl(control, label);
  if (
    control.min !== String(expectedMinimum)
    || control.max !== '100'
    || control.step !== expectedStep
  ) {
    throw new TypeError(
      `${label} requires exact range attributes min="${expectedMinimum}", `
      + `max="100", step="${expectedStep}".`
    );
  }
  const value = parseFiniteNumberInRange(
    control.value,
    expectedMinimum,
    100,
    label
  );
  const step = Number(expectedStep);
  const quotient = value / step;
  if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
    throw new RangeError(`${label} must align exactly to step ${expectedStep}.`);
  }
  return value;
}

function assertViewerBackground(value) {
  if (!isViewerBackground(value)) {
    throw new TypeError(VIEWER_BACKGROUND_ERROR_MESSAGE);
  }
  return value;
}

function assertRenderMode(value) {
  if (!RENDER_MODES.includes(value)) {
    throw new TypeError('Render mode must be exactly "points" or "smoke".');
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
 * @param {HTMLElement|null} options.dom.pointsPerformanceControls
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
  requireExactObjectKeys(options, ['viewer', 'dom', 'smoke'], 'Render controls initialization');
  const { viewer, dom, smoke } = options;
  if (viewer === null || typeof viewer !== 'object' || Array.isArray(viewer)) {
    throw new TypeError('Render controls require one current viewer object.');
  }
  for (const method of VIEWER_METHODS) {
    assertMethod(viewer, method, 'Render controls viewer');
  }
  requireExactObjectKeys(smoke, ['rebuildSmokeDensity'], 'Render controls smoke owner');
  assertMethod(smoke, 'rebuildSmokeDensity', 'Render controls smoke owner');
  if (dom === null || typeof dom !== 'object' || Array.isArray(dom)) {
    throw new TypeError('Render controls require one current DOM inventory.');
  }

  const rebuildSmokeDensity = smoke.rebuildSmokeDensity;

  const {
    backgroundSelect,
    renderModeSelect,
    renderModeMaturityTag,
    depthControls,
    rendererControls,
    pointsControls,
    pointsPerformanceControls,
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
  assertHideableElement(renderModeMaturityTag, 'Render-mode maturity tag');
  assertContainer(rendererControls, 'Renderer controls');
  assertContainer(pointsControls, 'Point controls');
  assertContainer(pointsPerformanceControls, 'Point performance controls');
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
  for (const [key, label, step, minimum = 0] of RANGE_CONTROLS) {
    readExactRange(dom[key], label, step, minimum);
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
  let smokeGridSize = MAX_SMOKE_GRID_SIZE;
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

  function sliderToPointSize(sliderValue) {
    const raw = parseFiniteNumberInRange(
      sliderValue,
      POINT_SIZE_SLIDER_MINIMUM,
      POINT_SIZE_SLIDER_MAXIMUM,
      'Point size slider'
    );
    return sliderPositionToPointSize(raw);
  }

  function applyPointSizeFromSlider() {
    const size = sliderToPointSize(pointSizeInput.value);
    viewer.setPointSize(size);
    pointSizeDisplay.textContent = formatPointSize(size);
  }

  /**
   * Move the point-size slider to the size a dataset of this many cells wants.
   *
   * Published through the control's own `input` event so every other owner of
   * that control — the session serializer's restore path and the Visualization
   * reset capture — sees the change the same way it sees a drag. A restore that
   * runs afterwards overrides this, which is the correct precedence: an explicit
   * saved choice outranks a derived default.
   *
   * @param {number} cellCount
   * @returns {number} The published point size.
   */
  function applyAutomaticPointSize(cellCount) {
    if (destroyed) {
      throw new Error(
        'Automatic point size cannot be published after teardown.'
      );
    }
    const position = pointSizeSliderPositionForCellCount(cellCount);
    pointSizeInput.value = String(position);
    pointSizeInput.dispatchEvent(new Event('input', { bubbles: true }));
    return sliderPositionToPointSize(position);
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
    // The tag names the maturity of the selected mode, so it is present exactly
    // when that mode is. `Points` is not in beta and must not wear the tag.
    renderModeMaturityTag.hidden = mode !== 'smoke';
    smokeControls.classList.toggle('visible', mode === 'smoke');
    pointsControls.classList.toggle('visible', mode === 'points');
    depthControls.style.display = mode === 'smoke' ? 'none' : 'block';
    rendererControls.style.display = mode === 'smoke' ? 'none' : 'block';
    // Level of detail and frustum culling drive the point renderer only; the
    // Performance group stays, because antialiasing below them governs the
    // drawing buffer in both modes.
    pointsPerformanceControls.hidden = mode === 'smoke';
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
    // Handled: the headline below is the user-facing report, the exact
    // failure is kept for bug reports.
    console.warn('[RenderControls] Smoke rendering failed:', exactError);
    getNotificationCenter().error(
      'Volumetric smoke stopped rendering, so the view is back in Points.',
      { category: 'rendering', title: 'Volumetric smoke stopped' }
    );
  }

  function settleSmokeBuildFailure(error) {
    if (destroyed) return;
    smokeDirty = true;
    if (error instanceof SmokeUnsupportedError) {
      reportSmokeUnavailable(viewer.getSmokeSupport());
    } else {
      console.warn('[RenderControls] Smoke density could not be built:', error);
      // A SmokeDensityBuildError has already failed its own progress
      // notification with the same headline.
      if (!(error instanceof SmokeDensityBuildError)) {
        getNotificationCenter().error(
          'Volumetric smoke could not be built. Points rendering works as usual.',
          { category: 'rendering' }
        );
      }
    }
    publishRenderMode('points');
  }

  function applyRenderMode(mode) {
    if (destroyed) return false;
    const exactMode = assertRenderMode(mode);
    // A device that cannot run smoke is told so in plain words and stays in
    // Points: nothing is built, nothing half-published.
    if (exactMode === 'smoke') {
      const support = viewer.getSmokeSupport();
      if (!support.supported) {
        reportSmokeUnavailable(support);
        publishRenderMode('points');
        return false;
      }
    }
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
  //
  // Each slider publishes exactly one renderer value through its fixed scale in
  // smoke-control-scales.js. No slider rescales another: the readout beside a
  // slider means the same thing at every grid and noise resolution.
  // ---------------------------------------------------------------------------

  function publishSmokeSlider(input, display, label, scale, publish) {
    const { value, readout } = scale(readExactRange(input, label, '1'));
    display.textContent = readout;
    publish(value);
  }

  function updateSmokeStepSlider() {
    publishSmokeSlider(
      smokeStepsInput, smokeStepsDisplay, 'Smoke ray quality',
      smokeRayQualityScale,
      stepMultiplier => viewer.setSmokeParams({ stepMultiplier })
    );
  }

  function updateSmokeDensitySlider() {
    publishSmokeSlider(
      smokeDensityInput, smokeDensityDisplay, 'Smoke density',
      smokeDensityScale,
      density => viewer.setSmokeParams({ density })
    );
  }

  function updateSmokeSpeedSlider() {
    publishSmokeSlider(
      smokeSpeedInput, smokeSpeedDisplay, 'Smoke animation speed',
      smokeSpeedScale,
      animationSpeed => viewer.setSmokeParams({ animationSpeed })
    );
  }

  function updateSmokeDetailSlider() {
    publishSmokeSlider(
      smokeDetailInput, smokeDetailDisplay, 'Smoke detail',
      smokeDetailScale,
      detailLevel => viewer.setSmokeParams({ detailLevel })
    );
  }

  function updateSmokeWarpSlider() {
    publishSmokeSlider(
      smokeWarpInput, smokeWarpDisplay, 'Smoke turbulence',
      smokeTurbulenceScale,
      warpStrength => viewer.setSmokeParams({ warpStrength })
    );
  }

  function updateSmokeAbsorptionSlider() {
    publishSmokeSlider(
      smokeAbsorptionInput, smokeAbsorptionDisplay, 'Smoke light absorption',
      smokeAbsorptionScale,
      lightAbsorption => viewer.setSmokeParams({ lightAbsorption })
    );
  }

  function updateSmokeScatterSlider() {
    publishSmokeSlider(
      smokeScatterInput, smokeScatterDisplay, 'Smoke light scattering',
      smokeScatterScale,
      scatterStrength => viewer.setSmokeParams({ scatterStrength })
    );
  }

  function updateSmokeEdgeSlider() {
    publishSmokeSlider(
      smokeEdgeInput, smokeEdgeDisplay, 'Smoke edge softness',
      smokeEdgeScale,
      edgeSoftness => viewer.setSmokeParams({ edgeSoftness })
    );
  }

  function updateSmokeDirectLightSlider() {
    publishSmokeSlider(
      smokeDirectLightInput, smokeDirectLightDisplay, 'Smoke direct light',
      smokeDirectLightScale,
      directLightIntensity => viewer.setSmokeParams({ directLightIntensity })
    );
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

  // The grid is the one smoke control that rebuilds the volume, so its
  // readout follows the slider at once and the rebuild waits for the drag to
  // settle.
  function updateSmokeGridSlider() {
    const { value: size, readout } = smokeGridScale(
      readExactRange(smokeGridInput, 'Smoke grid density', '1')
    );
    smokeGridDisplay.textContent = readout;
    if (size !== smokeGridSize) {
      smokeGridSize = size;
      scheduleSliderSmokeRebuild();
    }
  }

  {
    const { value, readout } = smokeGridScale(
      readExactRange(smokeGridInput, 'Smoke grid density', '1')
    );
    smokeGridSize = value;
    smokeGridDisplay.textContent = readout;
  }
  listen(smokeGridInput, 'input', updateSmokeGridSlider);

  function updateCloudResolutionSlider() {
    publishSmokeSlider(
      cloudResolutionInput, cloudResolutionDisplay, 'Smoke render resolution',
      smokeResolutionScale,
      scale => viewer.setCloudResolutionScale(scale)
    );
  }

  function updateNoiseResolutionSlider() {
    publishSmokeSlider(
      noiseResolutionInput, noiseResolutionDisplay, 'Smoke noise resolution',
      smokeNoiseScale,
      size => viewer.setNoiseTextureResolution(size)
    );
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
    lightingStrengthDisplay.textContent = formatDecimal(raw, 0);
  }

  function updateFogDensity() {
    const raw = readExactRange(
      fogDensityInput,
      'Fog density',
      '1'
    );
    viewer.setFogDensity(raw / 100);
    fogDensityDisplay.textContent = formatDecimal(raw, 0);
  }

  function updateSizeAttenuation() {
    const raw = readExactRange(
      sizeAttenuationInput,
      'Perspective size scaling',
      '1'
    );
    viewer.setSizeAttenuation(raw / 100);
    sizeAttenuationDisplay.textContent = formatDecimal(raw, 0);
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
    hpLodForceContainer.hidden = !acceptedLodEnabled;
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
  // A live setting, published to the viewer like any other. It was not always:
  // `antialias` is a WebGL context-creation attribute, and while the drawing
  // buffer carried it the control could only store a preference and tell the user
  // to reload. `rendering/scene-msaa-target.js` moved multisampling into a
  // renderbuffer the application owns, so a change now reaches the next frame.
  //
  // The checkbox has two states and the preference has three. `auto` is the
  // third, and it is what the box shows when the user has not chosen: ticked or
  // not according to the dataset, per `ui/core/antialias-preference.js`. Touching
  // the box is what turns `auto` into a choice — after that the dataset stops
  // deciding, which is the only reading of an explicit click that respects it.
  // ---------------------------------------------------------------------------

  const antialiasingAvailable = viewer.isAntialiasingAvailable();
  const storedAntialias = resolveAntialiasPreference(localStorage);
  let antialiasPreferenceMode = storedAntialias.mode;
  let datasetCellCount = null;
  let viewDimension = null;

  function syncAntialiasStatus() {
    if (!antialiasingAvailable) {
      // Not a state to keep offering: reloading would ask again and be refused
      // again, and there is no preference that changes it.
      hpAntialiasStatus.textContent =
        'This browser is not providing antialiasing for this view.';
      return;
    }
    hpAntialiasStatus.textContent = antialiasPreferenceMode === 'auto'
      ? (
        datasetCellCount === null
          ? 'Chosen automatically from the size of the dataset.'
          : `Chosen automatically: ${formatCountOf(datasetCellCount, 'cell')} in ${viewDimension}D.`
      )
      : '';
  }

  function publishAntialiasing(enabled) {
    const inForce = viewer.setAntialiasing(enabled);
    hpAntialiasCheckbox.checked = inForce;
    syncAntialiasStatus();
    return inForce;
  }

  publishAntialiasing(
    antialiasingInForce(antialiasPreferenceMode, datasetCellCount, viewDimension)
  );

  if (storedAntialias.discarded !== null) {
    // Discarded rather than obeyed, and never in silence: the user chose this
    // setting once and is entitled to know the choice did not survive. Reporting
    // it must not be able to stop the controls from working, though — the whole
    // point of discarding rather than throwing is that a bad stored value cannot
    // break a load.
    try {
      getNotificationCenter().warning(
        `The stored antialiasing preference `
        + `${JSON.stringify(storedAntialias.discarded)} was not recognized and `
        + 'has been discarded, so antialiasing follows the size of the dataset. '
        + `Set it again in ${PLACES.visualization.name} if you wanted it fixed.`,
        { category: 'rendering', title: 'Antialiasing preference reset' }
      );
    } catch (error) {
      console.error(
        '[RenderControls] Discarded antialiasing preference was not reported:',
        error
      );
    }
  }

  /**
   * Re-decide antialiasing for a dataset that has just been published.
   *
   * Does nothing to an explicit choice. `auto` is re-evaluated per dataset rather
   * than once per page because datasets are switched in place: a page that opened
   * on four thousand cells and now holds eighteen million has to answer for the
   * eighteen million.
   *
   * @param {number} cellCount
   * @param {1|2|3} dimension The dimension the dataset opens in.
   * @returns {boolean} What is in force afterwards.
   */
  function applyDatasetAntialiasing(cellCount, dimension) {
    if (destroyed) {
      throw new Error(
        'Automatic antialiasing cannot be published after teardown.'
      );
    }
    if (!Number.isSafeInteger(cellCount) || cellCount <= 0) {
      throw new RangeError(
        'Automatic antialiasing requires one positive safe integer cell count.'
      );
    }
    datasetCellCount = cellCount;
    viewDimension = requireViewDimension(dimension);
    return publishAntialiasing(
      antialiasingInForce(antialiasPreferenceMode, datasetCellCount, viewDimension)
    );
  }

  /**
   * Re-decide automatic antialiasing when the active view changes dimension.
   * A flat view costs far more to antialias than a 3D one (see
   * `AUTOMATIC_ANTIALIAS_CELL_LIMIT_FLAT`), so `auto` follows the view being
   * worked in. An explicit choice is left alone.
   *
   * @param {1|2|3} dimension
   * @returns {boolean} What is in force afterwards.
   */
  function applyViewDimensionAntialiasing(dimension) {
    if (destroyed) return viewer.getAntialiasing();
    viewDimension = requireViewDimension(dimension);
    if (datasetCellCount === null) return viewer.getAntialiasing();
    return publishAntialiasing(
      antialiasingInForce(antialiasPreferenceMode, datasetCellCount, viewDimension)
    );
  }

  function requireViewDimension(dimension) {
    if (dimension !== 1 && dimension !== 2 && dimension !== 3) {
      throw new RangeError(
        'Automatic antialiasing requires a view dimension of 1, 2, or 3.'
      );
    }
    return dimension;
  }

  listen(hpAntialiasCheckbox, 'change', () => {
    const requested = hpAntialiasCheckbox.checked;
    const previousMode = antialiasPreferenceMode;
    const previousInForce = viewer.getAntialiasing();
    try {
      // An explicit click ends automatic selection for good, in both directions:
      // a user who ticks the box on an eighteen-million-cell dataset means it.
      writeAntialiasPreference(localStorage, requested ? 'on' : 'off');
      antialiasPreferenceMode = requested ? 'on' : 'off';
      publishAntialiasing(requested);
    } catch (error) {
      // The preference and the renderer are published together or not at all: a
      // box that survives a failed write would promise a setting on the next
      // load that was never recorded.
      antialiasPreferenceMode = previousMode;
      viewer.setAntialiasing(previousInForce);
      hpAntialiasCheckbox.checked = previousInForce;
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
    applyAutomaticPointSize,
    applyDatasetAntialiasing,
    applyViewDimensionAntialiasing,
    pointSizeSliderPositionForCellCount,
    pointSizeToSlider: pointSizeToSliderPosition,
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
