/**
 * @fileoverview Rendering + volumetric smoke controls.
 *
 * Wires visualization controls (background, point size, lighting, fog, size
 * attenuation) and smoke controls (grid/quality/density/etc) to the Viewer.
 *
 * Also exposes a `markSmokeDirty()` hook used by the coordinator to trigger
 * debounced smoke rebuilds after visibility changes.
 *
 * @module ui/modules/render-controls
 */

import {
  isFiniteNumber,
  parseFiniteNumberInRange
} from '../../utils/number-utils.js';
import { getNotificationCenter } from '../../notification-center.js';

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
  'hasSnapshots'
]);

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
  if (!Number.isSafeInteger(value) || value < 8) {
    throw new RangeError('Smoke grid size must be an integer of at least 8.');
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
    noiseResolutionDisplay
  } = dom;

  assertEventControl(backgroundSelect, 'Viewer background selector');
  assertEventControl(renderModeSelect, 'Render mode selector');
  assertContainer(depthControls, 'Depth controls');
  assertContainer(rendererControls, 'Renderer controls');
  assertContainer(pointsControls, 'Point controls');
  assertContainer(smokeControls, 'Smoke controls');
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

  // Slider input remains debounced; completed state publications must not wait
  // on browser timers, which can be deferred for occluded/background pages.
  let smokeRebuildTimeout = null;
  let committedSmokeRebuildQueued = false;

  function rebuildDirtySmokeIfActive() {
    if (renderModeSelect.value !== 'smoke' || !smokeDirty) return;
    rebuildSmokeDensity(smokeGridSize);
    markSmokeClean();
  }

  function scheduleSliderSmokeRebuild() {
    if (smokeRebuildTimeout !== null) clearTimeout(smokeRebuildTimeout);
    smokeDirty = true;
    smokeRebuildTimeout = setTimeout(() => {
      smokeRebuildTimeout = null;
      rebuildDirtySmokeIfActive();
    }, 300);
  }

  function markSmokeDirty() {
    smokeDirty = true;
    if (renderModeSelect.value !== 'smoke' || committedSmokeRebuildQueued) return;
    if (smokeRebuildTimeout !== null) {
      clearTimeout(smokeRebuildTimeout);
      smokeRebuildTimeout = null;
    }
    committedSmokeRebuildQueued = true;
    queueMicrotask(() => {
      committedSmokeRebuildQueued = false;
      rebuildDirtySmokeIfActive();
    });
  }

  function markSmokeClean() {
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
  function applyRenderMode(mode) {
    const exactMode = assertRenderMode(mode);
    if (exactMode === 'smoke' && viewer.hasSnapshots()) {
      throw new RangeError('Smoke render mode is unavailable while snapshots exist.');
    }

    // Build smoke volume on first switch to smoke mode, or if dirty.
    if (exactMode === 'smoke' && (!smokeBuiltOnce || smokeDirty)) {
      rebuildSmokeDensity(smokeGridSize);
      smokeBuiltOnce = true;
      smokeDirty = false;
    }
    viewer.setRenderMode(exactMode);
    renderModeSelect.value = exactMode;
    smokeControls.classList.toggle('visible', exactMode === 'smoke');
    pointsControls.classList.toggle('visible', exactMode === 'points');
    depthControls.style.display = exactMode === 'smoke' ? 'none' : 'block';
    rendererControls.style.display = exactMode === 'smoke' ? 'none' : 'block';
    currentRenderMode = exactMode;
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
  smokeStepsInput.addEventListener('input', updateSmokeStepSlider);
  updateSmokeDensitySlider();
  smokeDensityInput.addEventListener('input', updateSmokeDensitySlider);
  updateSmokeSpeedSlider();
  smokeSpeedInput.addEventListener('input', updateSmokeSpeedSlider);
  updateSmokeDetailSlider();
  smokeDetailInput.addEventListener('input', updateSmokeDetailSlider);
  updateSmokeWarpSlider();
  smokeWarpInput.addEventListener('input', updateSmokeWarpSlider);
  updateSmokeAbsorptionSlider();
  smokeAbsorptionInput.addEventListener('input', updateSmokeAbsorptionSlider);
  updateSmokeScatterSlider();
  smokeScatterInput.addEventListener('input', updateSmokeScatterSlider);
  updateSmokeEdgeSlider();
  smokeEdgeInput.addEventListener('input', updateSmokeEdgeSlider);
  updateSmokeDirectLightSlider();
  smokeDirectLightInput.addEventListener('input', updateSmokeDirectLightSlider);

  const GRID_SIZES = [32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024];
  function sliderToGridSize(sliderValue) {
    if (!isFiniteNumber(sliderValue) || sliderValue < 0 || sliderValue > 100) {
      throw new RangeError('Smoke grid density must be a finite number between 0 and 100.');
    }
    const t = sliderValue / 100;
    const idx = Math.min(GRID_SIZES.length - 1, Math.floor(t * GRID_SIZES.length));
    return GRID_SIZES[idx];
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
  smokeGridInput.addEventListener('input', updateSmokeGridSlider);

  function updateCloudResolutionSlider() {
    const t = readExactRange(
      cloudResolutionInput,
      'Smoke render resolution',
      '1'
    ) / 100;
    const scale = 0.25 + t * 1.75;
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
  cloudResolutionInput.addEventListener('input', updateCloudResolutionSlider);
  updateNoiseResolutionSlider();
  noiseResolutionInput.addEventListener('input', updateNoiseResolutionSlider);

  // ---------------------------------------------------------------------------
  // Non-smoke visualization controls
  // ---------------------------------------------------------------------------

  pointSizeInput.addEventListener('input', applyPointSizeFromSlider);

  let currentBackground = initialBackground;
  backgroundSelect.value = initialBackground;
  viewer.setBackground(initialBackground);
  backgroundSelect.addEventListener('change', () => {
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

  lightingStrengthInput.addEventListener('input', updateLightingStrength);
  fogDensityInput.addEventListener('input', updateFogDensity);
  sizeAttenuationInput.addEventListener('input', updateSizeAttenuation);

  applyRenderMode(renderModeSelect.value);
  renderModeSelect.addEventListener('change', () => {
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

  applyPointSizeFromSlider();
  updateLightingStrength();
  updateFogDensity();
  updateSizeAttenuation();

  return {
    markSmokeDirty,
    markSmokeClean,
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
    updateNoiseResolutionSlider
  };
}
