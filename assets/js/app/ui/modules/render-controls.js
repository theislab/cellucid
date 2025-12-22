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

import { clamp, clampNormalized, isFiniteNumber } from '../../utils/number-utils.js';

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
 * @param {{ rebuildSmokeDensity?: (gridSize?: number) => void }} [options.smoke]
 * @param {{ onRenderModeApplied?: (mode: 'points'|'smoke') => void }} [options.callbacks]
 */
export function initRenderControls({ viewer, dom, smoke, callbacks = {} }) {
  const rebuildSmokeDensity = smoke?.rebuildSmokeDensity || null;

  const backgroundSelect = dom?.backgroundSelect || null;
  const renderModeSelect = dom?.renderModeSelect || null;
  const depthControls = dom?.depthControls || null;
  const rendererControls = dom?.rendererControls || null;
  const pointsControls = dom?.pointsControls || null;
  const smokeControls = dom?.smokeControls || null;

  const pointSizeInput = dom?.pointSizeInput || null;
  const pointSizeDisplay = dom?.pointSizeDisplay || null;
  const lightingStrengthInput = dom?.lightingInput || null;
  const lightingStrengthDisplay = dom?.lightingDisplay || null;
  const fogDensityInput = dom?.fogInput || null;
  const fogDensityDisplay = dom?.fogDisplay || null;
  const sizeAttenuationInput = dom?.sizeAttenuationInput || null;
  const sizeAttenuationDisplay = dom?.sizeAttenuationDisplay || null;

  const smokeGridInput = dom?.smokeGridInput || null;
  const smokeGridDisplay = dom?.smokeGridDisplay || null;
  const smokeStepsInput = dom?.smokeStepsInput || null;
  const smokeStepsDisplay = dom?.smokeStepsDisplay || null;
  const smokeDensityInput = dom?.smokeDensityInput || null;
  const smokeDensityDisplay = dom?.smokeDensityDisplay || null;
  const smokeSpeedInput = dom?.smokeSpeedInput || null;
  const smokeSpeedDisplay = dom?.smokeSpeedDisplay || null;
  const smokeDetailInput = dom?.smokeDetailInput || null;
  const smokeDetailDisplay = dom?.smokeDetailDisplay || null;
  const smokeWarpInput = dom?.smokeWarpInput || null;
  const smokeWarpDisplay = dom?.smokeWarpDisplay || null;
  const smokeAbsorptionInput = dom?.smokeAbsorptionInput || null;
  const smokeAbsorptionDisplay = dom?.smokeAbsorptionDisplay || null;
  const smokeScatterInput = dom?.smokeScatterInput || null;
  const smokeScatterDisplay = dom?.smokeScatterDisplay || null;
  const smokeEdgeInput = dom?.smokeEdgeInput || null;
  const smokeEdgeDisplay = dom?.smokeEdgeDisplay || null;
  const smokeDirectLightInput = dom?.smokeDirectLightInput || null;
  const smokeDirectLightDisplay = dom?.smokeDirectLightDisplay || null;
  const cloudResolutionInput = dom?.cloudResolutionInput || null;
  const cloudResolutionDisplay = dom?.cloudResolutionDisplay || null;
  const noiseResolutionInput = dom?.noiseResolutionInput || null;
  const noiseResolutionDisplay = dom?.noiseResolutionDisplay || null;

  // Volumetric smoke UI state
  let smokeDirty = false;
  let smokeBuiltOnce = false;
  let smokeGridSize = 128;
  let noiseResolutionScale = viewer.getAdaptiveScaleFactor ? viewer.getAdaptiveScaleFactor() : 1;

  // Debounced auto-rebuild for smoke density
  let smokeRebuildTimeout = null;
  function scheduleAutoRebuild() {
    if (smokeRebuildTimeout) clearTimeout(smokeRebuildTimeout);
    smokeDirty = true;
    smokeRebuildTimeout = setTimeout(() => {
      if (rebuildSmokeDensity && renderModeSelect?.value === 'smoke') {
        rebuildSmokeDensity(smokeGridSize);
        markSmokeClean();
      }
    }, 300);
  }

  function markSmokeDirty() {
    smokeDirty = true;
    if (renderModeSelect?.value === 'smoke') {
      scheduleAutoRebuild();
    }
  }

  function markSmokeClean() {
    smokeDirty = false;
    smokeBuiltOnce = true;
  }

  // Log-scale point size mapping
  const MIN_POINT_SIZE = 0.25;
  const MAX_POINT_SIZE = 200.0;
  const DEFAULT_POINT_SIZE = 1.0;
  const POINT_SIZE_SCALE = MAX_POINT_SIZE / MIN_POINT_SIZE;

  function sliderToPointSize(sliderValue) {
    const raw = parseFloat(sliderValue);
    if (!isFiniteNumber(raw)) return DEFAULT_POINT_SIZE;
    const t = clamp(raw, 0, 100) / 100;
    return MIN_POINT_SIZE * Math.pow(POINT_SIZE_SCALE, t);
  }

  function pointSizeToSlider(size) {
    const clamped = clamp(size, MIN_POINT_SIZE, MAX_POINT_SIZE);
    return (Math.log(clamped / MIN_POINT_SIZE) / Math.log(POINT_SIZE_SCALE)) * 100;
  }

  function formatPointSize(size) {
    if (size < 0.1) return size.toFixed(3);
    return size < 10 ? size.toFixed(2) : size.toFixed(1);
  }

  function applyPointSizeFromSlider() {
    if (!pointSizeInput) return;
    const size = sliderToPointSize(pointSizeInput.value);
    viewer.setPointSize?.(size);
    if (pointSizeDisplay) pointSizeDisplay.textContent = formatPointSize(size);
  }

  function applyRenderMode(mode) {
    const normalized = mode === 'smoke' ? 'smoke' : 'points';
    viewer.setRenderMode?.(normalized);
    if (renderModeSelect && renderModeSelect.value !== normalized) {
      renderModeSelect.value = normalized;
    }
    if (smokeControls) {
      smokeControls.classList.toggle('visible', normalized === 'smoke');
    }
    if (pointsControls) {
      pointsControls.classList.toggle('visible', normalized === 'points');
    }
    if (depthControls) {
      depthControls.style.display = normalized === 'smoke' ? 'none' : 'block';
    }
    if (rendererControls) {
      rendererControls.style.display = normalized === 'smoke' ? 'none' : 'block';
    }

    // Build smoke volume on first switch to smoke mode, or if dirty.
    if (normalized === 'smoke' && rebuildSmokeDensity && (!smokeBuiltOnce || smokeDirty)) {
      rebuildSmokeDensity(smokeGridSize);
      smokeBuiltOnce = true;
      smokeDirty = false;
    }

    callbacks.onRenderModeApplied?.(normalized);
  }

  // ---------------------------------------------------------------------------
  // Smoke parameter sliders
  // ---------------------------------------------------------------------------

  function getResolutionAdaptiveFactor(power = 0.5) {
    const baseGrid = 128;
    const gridFactor = Math.pow(smokeGridSize / baseGrid, power);
    return gridFactor * noiseResolutionScale;
  }

  function updateSmokeStepSlider() {
    if (!smokeStepsInput) return;
    const raw = parseFloat(smokeStepsInput.value);
    const t = clampNormalized(raw, 60);
    const label = t < 0.33 ? 'Fast' : (t < 0.66 ? 'Balanced' : (t < 0.9 ? 'High' : 'Ultra'));
    if (smokeStepsDisplay) smokeStepsDisplay.textContent = label;

    const eased = Math.pow(t, 3);
    const adaptive = getResolutionAdaptiveFactor(0.35);
    const stepMultiplier = (0.5 + 4.0 * eased) * adaptive;
    viewer.setSmokeParams?.({ stepMultiplier });
  }

  function getAdaptiveDensityRange() {
    const scaleFactor = getResolutionAdaptiveFactor(0.5);
    const minDensity = 0.4 * scaleFactor;
    const maxDensity = 8.0 * scaleFactor * 1.4;
    return { min: minDensity, max: maxDensity };
  }

  function updateSmokeDensitySlider() {
    if (!smokeDensityInput) return;
    const raw = parseFloat(smokeDensityInput.value);
    const t = clampNormalized(raw, 50);
    const { min, max } = getAdaptiveDensityRange();
    const density = min + t * (max - min);
    if (smokeDensityDisplay) smokeDensityDisplay.textContent = density.toFixed(1);
    viewer.setSmokeParams?.({ density });
  }

  function updateSmokeSpeedSlider() {
    if (!smokeSpeedInput) return;
    const raw = parseFloat(smokeSpeedInput.value);
    const t = clampNormalized(raw, 80);
    const animationSpeed = t * 2.5;
    if (smokeSpeedDisplay) smokeSpeedDisplay.textContent = animationSpeed.toFixed(2);
    viewer.setSmokeParams?.({ animationSpeed });
  }

  function getAdaptiveDetailRange() {
    const scaleFactor = getResolutionAdaptiveFactor(0.35);
    const maxDetail = 5.0 * scaleFactor;
    return { min: 0, max: maxDetail };
  }

  function updateSmokeDetailSlider() {
    if (!smokeDetailInput) return;
    const raw = parseFloat(smokeDetailInput.value);
    const t = clampNormalized(raw, 60);
    const { min, max } = getAdaptiveDetailRange();
    const detailLevel = min + t * (max - min);
    if (smokeDetailDisplay) smokeDetailDisplay.textContent = detailLevel.toFixed(1);
    viewer.setSmokeParams?.({ detailLevel });
  }

  function updateSmokeWarpSlider() {
    if (!smokeWarpInput) return;
    const raw = parseFloat(smokeWarpInput.value);
    const t = clampNormalized(raw, 50);
    const warpStrength = t * 2.0;
    if (smokeWarpDisplay) smokeWarpDisplay.textContent = (t * 100).toFixed(0) + '%';
    viewer.setSmokeParams?.({ warpStrength });
  }

  function updateSmokeAbsorptionSlider() {
    if (!smokeAbsorptionInput) return;
    const raw = parseFloat(smokeAbsorptionInput.value);
    const t = clampNormalized(raw, 60);
    const adaptive = getResolutionAdaptiveFactor(0.2);
    const lightAbsorption = (t * 2.0) * adaptive;
    if (smokeAbsorptionDisplay) smokeAbsorptionDisplay.textContent = lightAbsorption.toFixed(1);
    viewer.setSmokeParams?.({ lightAbsorption });
  }

  function updateSmokeScatterSlider() {
    if (!smokeScatterInput) return;
    const raw = parseFloat(smokeScatterInput.value);
    const t = clampNormalized(raw, 55);
    const scatterStrength = (t * 2.0) * getResolutionAdaptiveFactor(0.15);
    if (smokeScatterDisplay) smokeScatterDisplay.textContent = scatterStrength.toFixed(1);
    viewer.setSmokeParams?.({ scatterStrength });
  }

  function updateSmokeEdgeSlider() {
    if (!smokeEdgeInput) return;
    const raw = parseFloat(smokeEdgeInput.value);
    const t = clampNormalized(raw, 50);
    const edgeSoftness = 0.2 + t * 1.8;
    if (smokeEdgeDisplay) smokeEdgeDisplay.textContent = edgeSoftness.toFixed(1);
    viewer.setSmokeParams?.({ edgeSoftness });
  }

  function updateSmokeDirectLightSlider() {
    if (!smokeDirectLightInput) return;
    const raw = parseFloat(smokeDirectLightInput.value);
    const t = clampNormalized(raw, 67);
    const directLightIntensity = t * 1.5;
    if (smokeDirectLightDisplay) smokeDirectLightDisplay.textContent = directLightIntensity.toFixed(2) + 'x';
    viewer.setSmokeParams?.({ directLightIntensity });
  }

  if (smokeStepsInput) {
    updateSmokeStepSlider();
    smokeStepsInput.addEventListener('input', updateSmokeStepSlider);
  }
  if (smokeDensityInput) {
    updateSmokeDensitySlider();
    smokeDensityInput.addEventListener('input', updateSmokeDensitySlider);
  }
  if (smokeSpeedInput) {
    updateSmokeSpeedSlider();
    smokeSpeedInput.addEventListener('input', updateSmokeSpeedSlider);
  }
  if (smokeDetailInput) {
    updateSmokeDetailSlider();
    smokeDetailInput.addEventListener('input', updateSmokeDetailSlider);
  }
  if (smokeWarpInput) {
    updateSmokeWarpSlider();
    smokeWarpInput.addEventListener('input', updateSmokeWarpSlider);
  }
  if (smokeAbsorptionInput) {
    updateSmokeAbsorptionSlider();
    smokeAbsorptionInput.addEventListener('input', updateSmokeAbsorptionSlider);
  }
  if (smokeScatterInput) {
    updateSmokeScatterSlider();
    smokeScatterInput.addEventListener('input', updateSmokeScatterSlider);
  }
  if (smokeEdgeInput) {
    updateSmokeEdgeSlider();
    smokeEdgeInput.addEventListener('input', updateSmokeEdgeSlider);
  }
  if (smokeDirectLightInput) {
    updateSmokeDirectLightSlider();
    smokeDirectLightInput.addEventListener('input', updateSmokeDirectLightSlider);
  }

  const GRID_SIZES = [32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024];
  function sliderToGridSize(sliderValue) {
    const t = clamp(sliderValue, 0, 100) / 100;
    const idx = Math.min(GRID_SIZES.length - 1, Math.floor(t * GRID_SIZES.length));
    return GRID_SIZES[idx];
  }

  function updateSmokeGridSlider() {
    if (!smokeGridInput) return;
    const raw = parseFloat(smokeGridInput.value);
    const size = sliderToGridSize(isFiniteNumber(raw) ? raw : 50);
    if (smokeGridDisplay) smokeGridDisplay.textContent = size + '³';
    if (size !== smokeGridSize) {
      smokeGridSize = size;
      updateSmokeDensitySlider();
      updateSmokeDetailSlider();
      updateSmokeWarpSlider();
      updateSmokeAbsorptionSlider();
      updateSmokeScatterSlider();
      updateSmokeStepSlider();
      scheduleAutoRebuild();
    }
  }

  if (smokeGridInput) {
    smokeGridSize = sliderToGridSize(parseFloat(smokeGridInput.value) || 50);
    if (smokeGridDisplay) smokeGridDisplay.textContent = smokeGridSize + '³';
    smokeGridInput.addEventListener('input', updateSmokeGridSlider);
  }

  function updateCloudResolutionSlider() {
    if (!cloudResolutionInput) return;
    const raw = parseFloat(cloudResolutionInput.value);
    const t = clampNormalized(raw, 25);
    const scale = 0.25 + t * 1.75;
    if (cloudResolutionDisplay) cloudResolutionDisplay.textContent = scale.toFixed(2) + 'x';
    viewer.setCloudResolutionScale?.(scale);
  }

  function updateNoiseResolutionSlider() {
    if (!noiseResolutionInput) return;
    const raw = parseFloat(noiseResolutionInput.value);
    const t = clampNormalized(raw, 64);
    const steps = [32, 48, 64, 96, 128, 192, 256];
    const idx = Math.min(steps.length - 1, Math.floor(t * steps.length));
    const size = steps[idx];
    if (noiseResolutionDisplay) noiseResolutionDisplay.textContent = size + '³';
    viewer.setNoiseTextureResolution?.(size);
    if (viewer.getAdaptiveScaleFactor) {
      noiseResolutionScale = viewer.getAdaptiveScaleFactor();
    }
    updateSmokeDensitySlider();
    updateSmokeDetailSlider();
    updateSmokeWarpSlider();
    updateSmokeAbsorptionSlider();
    updateSmokeScatterSlider();
    updateSmokeStepSlider();
  }

  if (cloudResolutionInput) {
    updateCloudResolutionSlider();
    cloudResolutionInput.addEventListener('input', updateCloudResolutionSlider);
  }
  if (noiseResolutionInput) {
    updateNoiseResolutionSlider();
    noiseResolutionInput.addEventListener('input', updateNoiseResolutionSlider);
  }

  // ---------------------------------------------------------------------------
  // Non-smoke visualization controls
  // ---------------------------------------------------------------------------

  if (pointSizeInput) {
    pointSizeInput.addEventListener('input', applyPointSizeFromSlider);
  }

  if (backgroundSelect) {
    viewer.setBackground?.(backgroundSelect.value);
    backgroundSelect.addEventListener('change', () => {
      viewer.setBackground?.(backgroundSelect.value);
    });
  }

  if (lightingStrengthInput) {
    lightingStrengthInput.addEventListener('input', () => {
      const v = parseFloat(lightingStrengthInput.value) / 100.0;
      viewer.setLightingStrength?.(v);
      if (lightingStrengthDisplay) lightingStrengthDisplay.textContent = lightingStrengthInput.value;
    });
  }

  if (fogDensityInput) {
    fogDensityInput.addEventListener('input', () => {
      const v = parseFloat(fogDensityInput.value) / 100.0;
      viewer.setFogDensity?.(v);
      if (fogDensityDisplay) fogDensityDisplay.textContent = fogDensityInput.value;
    });
  }

  if (sizeAttenuationInput) {
    sizeAttenuationInput.addEventListener('input', () => {
      const v = parseFloat(sizeAttenuationInput.value) / 100.0;
      viewer.setSizeAttenuation?.(v);
      if (sizeAttenuationDisplay) sizeAttenuationDisplay.textContent = sizeAttenuationInput.value;
    });
  }

  if (renderModeSelect) {
    applyRenderMode(renderModeSelect.value || 'points');
    renderModeSelect.addEventListener('change', () => {
      const requested = renderModeSelect.value;
      if (requested === 'smoke' && typeof viewer.hasSnapshots === 'function' && viewer.hasSnapshots()) {
        renderModeSelect.value = 'points';
        return;
      }
      applyRenderMode(requested);
    });
  } else {
    applyRenderMode('points');
  }

  // Initial setup of point-size slider and displays.
  if (pointSizeInput && pointSizeInput.value === '0') {
    pointSizeInput.value = String(pointSizeToSlider(DEFAULT_POINT_SIZE));
  }
  if (pointSizeInput) {
    const initialSliderValue = pointSizeInput.value !== ''
      ? parseFloat(pointSizeInput.value)
      : pointSizeToSlider(DEFAULT_POINT_SIZE);
    const normalizedSliderValue = Number.isFinite(initialSliderValue)
      ? clamp(initialSliderValue, 0, 100)
      : pointSizeToSlider(DEFAULT_POINT_SIZE);
    pointSizeInput.value = String(Math.round(normalizedSliderValue));
    applyPointSizeFromSlider();
  }

  if (fogDensityInput) {
    const initialFog = parseFloat(fogDensityInput.value);
    viewer.setFogDensity?.(Number.isFinite(initialFog) ? initialFog / 100.0 : 0.5);
  }
  if (sizeAttenuationInput) {
    const initialSizeAttenuation = parseFloat(sizeAttenuationInput.value);
    viewer.setSizeAttenuation?.(Number.isFinite(initialSizeAttenuation) ? initialSizeAttenuation / 100.0 : 0.65);
  }
  if (lightingStrengthDisplay && lightingStrengthInput) lightingStrengthDisplay.textContent = lightingStrengthInput.value;
  if (fogDensityDisplay && fogDensityInput) fogDensityDisplay.textContent = fogDensityInput.value;
  if (sizeAttenuationDisplay && sizeAttenuationInput) sizeAttenuationDisplay.textContent = sizeAttenuationInput.value;

  return {
    markSmokeDirty,
    markSmokeClean,
    applyRenderMode,
    applyPointSizeFromSlider,
    pointSizeToSlider,
    getSmokeGridSize: () => smokeGridSize,
    rebuildSmokeDensity: (gridSizeOverride) => rebuildSmokeDensity?.(gridSizeOverride ?? smokeGridSize),

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
