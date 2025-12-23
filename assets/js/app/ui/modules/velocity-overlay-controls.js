/**
 * @fileoverview Vector field overlay UI controls.
 *
 * Wires the sidebar "Vector Field Overlay" controls to the GPU particle overlay in
 * the Viewer. This is intentionally lazy:
 * - We do NOT instantiate the overlay until the user enables it.
 * - We do NOT load vector field data until the user enables it (or keeps it on
 *   while switching embedding dimensions).
 *
 * Vector fields are dimension-specific: only enable the overlay when the dataset
 * provides a field for the currently active embedding dimension.
 *
 * @module ui/modules/velocity-overlay-controls
 */

import { formatCellCount } from '../../../data/data-source.js';
import { getNotificationCenter } from '../../notification-center.js';
import { clamp } from '../../utils/number-utils.js';

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function clampFloat(value, min, max, fallback) {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

/**
 * @param {object} options
 * @param {import('../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {object} options.dom
 */
export function initVelocityOverlayControls({ state, viewer, dom }) {
  const controlBlock = dom?.velocityControls || null;
  const settings = dom?.velocitySettings || null;
  const infoEl = dom?.velocityInfo || null;

  const enabledCheckbox = dom?.velocityEnabledCheckbox || null;
  const fieldSelect = dom?.velocityFieldSelect || null;
  const densityInput = dom?.velocityDensityInput || null;
  const densityDisplay = dom?.velocityDensityDisplay || null;
  const speedInput = dom?.velocitySpeedInput || null;
  const speedDisplay = dom?.velocitySpeedDisplay || null;
  const lifetimeInput = dom?.velocityLifetimeInput || null;
  const lifetimeDisplay = dom?.velocityLifetimeDisplay || null;
  const sizeInput = dom?.velocitySizeInput || null;
  const sizeDisplay = dom?.velocitySizeDisplay || null;
  const opacityInput = dom?.velocityOpacityInput || null;
  const opacityDisplay = dom?.velocityOpacityDisplay || null;
  const colormapSelect = dom?.velocityColormapSelect || null;
  const syncLodCheckbox = dom?.velocitySyncLodCheckbox || null;
  // Advanced settings - Particle Rendering
  const intensityInput = dom?.velocityIntensityInput || null;
  const intensityDisplay = dom?.velocityIntensityDisplay || null;
  const glowInput = dom?.velocityGlowInput || null;
  const glowDisplay = dom?.velocityGlowDisplay || null;
  const cometStretchInput = dom?.velocityCometStretchInput || null;
  const cometStretchDisplay = dom?.velocityCometStretchDisplay || null;
  const coreSharpnessInput = dom?.velocityCoreSharpnessInput || null;
  const coreSharpnessDisplay = dom?.velocityCoreSharpnessDisplay || null;
  // Advanced settings - Trail
  const trailFadeInput = dom?.velocityTrailFadeInput || null;
  const trailFadeDisplay = dom?.velocityTrailFadeDisplay || null;
  const chromaticFadeInput = dom?.velocityChromaticFadeInput || null;
  const chromaticFadeDisplay = dom?.velocityChromaticFadeDisplay || null;
  const turbulenceInput = dom?.velocityTurbulenceInput || null;
  const turbulenceDisplay = dom?.velocityTurbulenceDisplay || null;
  // Advanced settings - HDR & Bloom
  const exposureInput = dom?.velocityExposureInput || null;
  const exposureDisplay = dom?.velocityExposureDisplay || null;
  const bloomStrengthInput = dom?.velocityBloomStrengthInput || null;
  const bloomStrengthDisplay = dom?.velocityBloomStrengthDisplay || null;
  const bloomThresholdInput = dom?.velocityBloomThresholdInput || null;
  const bloomThresholdDisplay = dom?.velocityBloomThresholdDisplay || null;
  const anamorphicInput = dom?.velocityAnamorphicInput || null;
  const anamorphicDisplay = dom?.velocityAnamorphicDisplay || null;
  // Advanced settings - Color Grading
  const saturationInput = dom?.velocitySaturationInput || null;
  const saturationDisplay = dom?.velocitySaturationDisplay || null;
  const contrastInput = dom?.velocityContrastInput || null;
  const contrastDisplay = dom?.velocityContrastDisplay || null;
  const highlightsInput = dom?.velocityHighlightsInput || null;
  const highlightsDisplay = dom?.velocityHighlightsDisplay || null;
  const shadowsInput = dom?.velocityShadowsInput || null;
  const shadowsDisplay = dom?.velocityShadowsDisplay || null;
  // Advanced settings - Cinematic Effects
  const vignetteInput = dom?.velocityVignetteInput || null;
  const vignetteDisplay = dom?.velocityVignetteDisplay || null;
  const filmGrainInput = dom?.velocityFilmGrainInput || null;
  const filmGrainDisplay = dom?.velocityFilmGrainDisplay || null;
  const chromaticAberrationInput = dom?.velocityChromaticAberrationInput || null;
  const chromaticAberrationDisplay = dom?.velocityChromaticAberrationDisplay || null;

  let enabling = false;
  let suppressFieldChange = false;

  const getActiveDim = () => {
    const level = typeof state.getDimensionLevel === 'function' ? state.getDimensionLevel() : 3;
    return Math.max(1, Math.min(3, Math.floor(level || 3)));
  };

  const getAllFields = () => {
    const fields = typeof state.getAvailableVectorFields === 'function'
      ? state.getAvailableVectorFields()
      : [];
    return Array.isArray(fields) ? fields : [];
  };

  const getFieldsForDim = (dim) => {
    const d = Math.max(1, Math.min(3, Math.floor(dim || 3)));
    return getAllFields().filter((f) => Array.isArray(f?.availableDimensions) && f.availableDimensions.includes(d));
  };

  const getUnionDims = () => {
    const dims = new Set();
    for (const field of getAllFields()) {
      const list = Array.isArray(field?.availableDimensions) ? field.availableDimensions : [];
      for (const d of list) {
        if (Number.isInteger(d) && d >= 1 && d <= 3) dims.add(d);
      }
    }
    return Array.from(dims).sort((a, b) => a - b);
  };

  const getDefaultFieldId = () => {
    const id = typeof state.getDefaultVectorFieldId === 'function' ? state.getDefaultVectorFieldId() : null;
    return id ? String(id) : null;
  };

  function setInfo(message) {
    if (infoEl) infoEl.textContent = message || '';
  }

  function disableOverlayUi() {
    if (enabledCheckbox) enabledCheckbox.checked = false;
    if (settings) settings.style.display = 'none';
    if (typeof viewer.setVectorFieldOverlayEnabled === 'function') {
      viewer.setVectorFieldOverlayEnabled(false);
    }
  }

  function updateSettingsVisibility() {
    if (!settings || !enabledCheckbox) return;
    settings.style.display = enabledCheckbox.checked ? 'block' : 'none';
  }

  function updateDensityDisplay() {
    if (!densityInput) return 15_000;
    const thousands = clampInt(densityInput.value, 1, 500, 15);
    const particles = thousands * 1000;
    if (densityDisplay) densityDisplay.textContent = formatCellCount(particles);
    return particles;
  }

  function updateSpeedDisplay() {
    if (!speedInput) return 3.0;
    const value = clampFloat(speedInput.value, 5, 500, 300) / 100;
    if (speedDisplay) speedDisplay.textContent = `${value.toFixed(1)}×`;
    return value;
  }

  function updateLifetimeDisplay() {
    if (!lifetimeInput) return 8.0;
    const value = clampFloat(lifetimeInput.value, 10, 1500, 800) / 100;
    if (lifetimeDisplay) lifetimeDisplay.textContent = `${value.toFixed(1)}s`;
    return value;
  }

  function updateSizeDisplay() {
    if (!sizeInput) return 1.0;
    const value = clampFloat(sizeInput.value, 0.5, 30, 1);
    if (sizeDisplay) sizeDisplay.textContent = value < 10 ? value.toFixed(1) : `${Math.round(value)}`;
    return value;
  }

  function updateOpacityDisplay() {
    if (!opacityInput) return 0.6;
    const value = clampFloat(opacityInput.value, 0, 100, 60) / 100;
    if (opacityDisplay) opacityDisplay.textContent = `${Math.round(value * 100)}%`;
    return value;
  }

  // Advanced settings display functions - Particle Rendering
  function updateIntensityDisplay() {
    if (!intensityInput) return 0.25;
    const value = clampFloat(intensityInput.value, 0.05, 1.5, 0.25);
    if (intensityDisplay) intensityDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateGlowDisplay() {
    if (!glowInput) return 0.3;
    const value = clampFloat(glowInput.value, 0, 1, 0.3);
    if (glowDisplay) glowDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateCometStretchDisplay() {
    if (!cometStretchInput) return 0.6;
    const value = clampFloat(cometStretchInput.value, 0, 2, 0.6);
    if (cometStretchDisplay) cometStretchDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateCoreSharpnessDisplay() {
    if (!coreSharpnessInput) return 0.7;
    const value = clampFloat(coreSharpnessInput.value, 0, 1, 0.7);
    if (coreSharpnessDisplay) coreSharpnessDisplay.textContent = value.toFixed(2);
    return value;
  }

  // Trail settings
  function updateTrailFadeDisplay() {
    if (!trailFadeInput) return 0.925;
    const value = clampFloat(trailFadeInput.value, 0.9, 0.995, 0.925);
    if (trailFadeDisplay) trailFadeDisplay.textContent = value.toFixed(3);
    return value;
  }

  function updateChromaticFadeDisplay() {
    if (!chromaticFadeInput) return 0;
    const value = clampFloat(chromaticFadeInput.value, 0, 1, 0);
    if (chromaticFadeDisplay) chromaticFadeDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateTurbulenceDisplay() {
    if (!turbulenceInput) return 0.3;
    const value = clampFloat(turbulenceInput.value, 0, 1, 0.3);
    if (turbulenceDisplay) turbulenceDisplay.textContent = value.toFixed(2);
    return value;
  }

  // HDR & Bloom
  function updateExposureDisplay() {
    if (!exposureInput) return 0.5;
    const value = clampFloat(exposureInput.value, 0.1, 2, 0.5);
    if (exposureDisplay) exposureDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateBloomStrengthDisplay() {
    if (!bloomStrengthInput) return 0.08;
    const value = clampFloat(bloomStrengthInput.value, 0, 0.5, 0.08);
    if (bloomStrengthDisplay) bloomStrengthDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateBloomThresholdDisplay() {
    if (!bloomThresholdInput) return 0.75;
    const value = clampFloat(bloomThresholdInput.value, 0.1, 1, 0.75);
    if (bloomThresholdDisplay) bloomThresholdDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateAnamorphicDisplay() {
    if (!anamorphicInput) return 1.2;
    const value = clampFloat(anamorphicInput.value, 1, 3, 1.2);
    if (anamorphicDisplay) anamorphicDisplay.textContent = value.toFixed(1);
    return value;
  }

  // Color Grading
  function updateSaturationDisplay() {
    if (!saturationInput) return 1.15;
    const value = clampFloat(saturationInput.value, 0.5, 2, 1.15);
    if (saturationDisplay) saturationDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateContrastDisplay() {
    if (!contrastInput) return 1.05;
    const value = clampFloat(contrastInput.value, 0.5, 2, 1.05);
    if (contrastDisplay) contrastDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateHighlightsDisplay() {
    if (!highlightsInput) return 0.85;
    const value = clampFloat(highlightsInput.value, 0.5, 1.5, 0.85);
    if (highlightsDisplay) highlightsDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateShadowsDisplay() {
    if (!shadowsInput) return 1.05;
    const value = clampFloat(shadowsInput.value, 0.5, 1.5, 1.05);
    if (shadowsDisplay) shadowsDisplay.textContent = value.toFixed(2);
    return value;
  }

  // Cinematic Effects
  function updateVignetteDisplay() {
    if (!vignetteInput) return 0;
    const value = clampFloat(vignetteInput.value, 0, 1, 0);
    if (vignetteDisplay) vignetteDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateFilmGrainDisplay() {
    if (!filmGrainInput) return 0;
    const value = clampFloat(filmGrainInput.value, 0, 0.1, 0);
    if (filmGrainDisplay) filmGrainDisplay.textContent = value.toFixed(3);
    return value;
  }

  function updateChromaticAberrationDisplay() {
    if (!chromaticAberrationInput) return 0;
    const value = clampFloat(chromaticAberrationInput.value, 0, 1, 0);
    if (chromaticAberrationDisplay) chromaticAberrationDisplay.textContent = value.toFixed(2);
    return value;
  }

  function applyConfigFromUi() {
    if (!enabledCheckbox?.checked) return;
    if (typeof viewer.setVectorFieldConfig !== 'function') return;

    viewer.setVectorFieldConfig('particleCount', updateDensityDisplay());
    viewer.setVectorFieldConfig('speedMultiplier', updateSpeedDisplay());
    viewer.setVectorFieldConfig('lifetime', updateLifetimeDisplay());
    viewer.setVectorFieldConfig('particleSize', updateSizeDisplay());
    viewer.setVectorFieldConfig('opacity', updateOpacityDisplay());
    if (colormapSelect) viewer.setVectorFieldConfig('colormapId', colormapSelect.value);
    if (syncLodCheckbox) viewer.setVectorFieldConfig('syncWithLOD', Boolean(syncLodCheckbox.checked));
    // Advanced settings - Particle Rendering
    viewer.setVectorFieldConfig('intensity', updateIntensityDisplay());
    viewer.setVectorFieldConfig('glowAmount', updateGlowDisplay());
    viewer.setVectorFieldConfig('cometStretch', updateCometStretchDisplay());
    viewer.setVectorFieldConfig('coreSharpness', updateCoreSharpnessDisplay());
    // Advanced settings - Trail
    viewer.setVectorFieldConfig('trailFade', updateTrailFadeDisplay());
    viewer.setVectorFieldConfig('chromaticFade', updateChromaticFadeDisplay());
    viewer.setVectorFieldConfig('turbulence', updateTurbulenceDisplay());
    // Advanced settings - HDR & Bloom
    viewer.setVectorFieldConfig('exposure', updateExposureDisplay());
    viewer.setVectorFieldConfig('bloomStrength', updateBloomStrengthDisplay());
    viewer.setVectorFieldConfig('bloomThreshold', updateBloomThresholdDisplay());
    viewer.setVectorFieldConfig('anamorphicRatio', updateAnamorphicDisplay());
    // Advanced settings - Color Grading
    viewer.setVectorFieldConfig('saturation', updateSaturationDisplay());
    viewer.setVectorFieldConfig('contrast', updateContrastDisplay());
    viewer.setVectorFieldConfig('highlights', updateHighlightsDisplay());
    viewer.setVectorFieldConfig('shadows', updateShadowsDisplay());
    // Advanced settings - Cinematic Effects
    viewer.setVectorFieldConfig('vignette', updateVignetteDisplay());
    viewer.setVectorFieldConfig('filmGrain', updateFilmGrainDisplay());
    viewer.setVectorFieldConfig('chromaticAberration', updateChromaticAberrationDisplay());
  }

  function getSelectedFieldId() {
    const dim = getActiveDim();
    const fieldsForDim = getFieldsForDim(dim);
    if (!fieldsForDim.length) return '';

    const current = fieldSelect?.value ? String(fieldSelect.value) : '';
    if (current && fieldsForDim.some((f) => f.id === current)) return current;

    const defaultId = getDefaultFieldId();
    if (defaultId && fieldsForDim.some((f) => f.id === defaultId)) return defaultId;

    return String(fieldsForDim[0].id || '');
  }

  function renderFieldSelectForActiveDim() {
    if (!fieldSelect) return;
    const dim = getActiveDim();
    const fieldsForDim = getFieldsForDim(dim);
    const selectedId = getSelectedFieldId();

    suppressFieldChange = true;
    try {
      fieldSelect.innerHTML = '';
      for (const field of fieldsForDim) {
        const opt = document.createElement('option');
        opt.value = String(field.id);
        opt.textContent = String(field.label || field.id);
        fieldSelect.appendChild(opt);
      }
      fieldSelect.value = selectedId;
    } finally {
      suppressFieldChange = false;
    }
  }

  function syncAvailability() {
    const unionDims = getUnionDims();
    const hasAny = unionDims.length > 0;
    const activeDim = getActiveDim();
    const fieldsForDim = getFieldsForDim(activeDim);
    const hasForDim = fieldsForDim.length > 0;

    if (controlBlock) controlBlock.style.display = hasAny ? 'block' : 'none';

    if (!hasAny) {
      setInfo('');
      disableOverlayUi();
      return;
    }

    renderFieldSelectForActiveDim();

    if (enabledCheckbox) {
      enabledCheckbox.disabled = enabling || !hasForDim;
      if (!hasForDim && enabledCheckbox.checked) {
        disableOverlayUi();
      }
    }

    if (fieldSelect) fieldSelect.disabled = enabling || !hasForDim;

    const dimList = unionDims.map((d) => `${d}D`).join(', ');
    if (!hasForDim) {
      setInfo(`Vector fields available for ${dimList}. Switch embedding dimension to enable.`);
      if (settings) settings.style.display = 'none';
      return;
    }

    setInfo(`Available for ${dimList}.`);
    updateSettingsVisibility();
  }

  async function ensureFieldForActiveDim() {
    const dim = getActiveDim();
    const fieldId = getSelectedFieldId();
    if (!fieldId) return false;
    if (typeof state.ensureVectorField !== 'function') return false;
    const ok = await state.ensureVectorField(fieldId, dim);
    if (ok && typeof viewer.setActiveVectorField === 'function') {
      viewer.setActiveVectorField(fieldId);
    }
    return ok;
  }

  async function handleEnabledChange() {
    if (!enabledCheckbox) return;

    if (!enabledCheckbox.checked) {
      disableOverlayUi();
      syncAvailability();
      return;
    }

    const dims = getUnionDims();
    const activeDim = getActiveDim();
    if (!dims.includes(activeDim)) {
      disableOverlayUi();
      syncAvailability();
      return;
    }

    enabling = true;
    enabledCheckbox.disabled = true;
    setInfo('Loading vector field…');

    try {
      const ok = await ensureFieldForActiveDim();
      if (!ok) {
        disableOverlayUi();
        syncAvailability();
        return;
      }

      if (typeof viewer.setVectorFieldOverlayEnabled === 'function') {
        viewer.setVectorFieldOverlayEnabled(true);
      }
      applyConfigFromUi();
      updateSettingsVisibility();
      syncAvailability();
    } catch (err) {
      console.warn('[UI] Failed to enable vector field overlay:', err);
      getNotificationCenter().error(err?.message || 'Failed to load vector field overlay.', { category: 'render' });
      disableOverlayUi();
      setInfo('Failed to load vector field.');
    } finally {
      enabling = false;
      if (enabledCheckbox) enabledCheckbox.disabled = false;
      syncAvailability();
    }
  }

  async function handleDimensionChanged() {
    syncAvailability();
    if (!enabledCheckbox?.checked) return;

    // Keep overlay on across dimension switches, but only if a field exists for that dim.
    const dims = getUnionDims();
    const activeDim = getActiveDim();
    if (!dims.includes(activeDim)) {
      disableOverlayUi();
      syncAvailability();
      return;
    }

    try {
      enabling = true;
      if (enabledCheckbox) enabledCheckbox.disabled = true;
      setInfo('Loading vector field…');
      const ok = await ensureFieldForActiveDim();
      if (!ok) {
        disableOverlayUi();
        syncAvailability();
        return;
      }
      if (typeof viewer.setVectorFieldOverlayEnabled === 'function') {
        viewer.setVectorFieldOverlayEnabled(true);
      }
      applyConfigFromUi();
      syncAvailability();
    } catch (err) {
      console.warn('[UI] Failed to load vector field for new dimension:', err);
      getNotificationCenter().error(err?.message || 'Failed to load vector field.', { category: 'render' });
      disableOverlayUi();
      setInfo('Failed to load vector field.');
    } finally {
      enabling = false;
      if (enabledCheckbox) enabledCheckbox.disabled = false;
      syncAvailability();
    }
  }

  async function handleFieldChanged() {
    if (!fieldSelect || suppressFieldChange) return;
    syncAvailability();
    if (!enabledCheckbox?.checked) return;
    if (enabling) return;

    enabling = true;
    enabledCheckbox.disabled = true;
    fieldSelect.disabled = true;
    setInfo('Loading vector field…');
    try {
      const ok = await ensureFieldForActiveDim();
      if (!ok) {
        disableOverlayUi();
        syncAvailability();
        return;
      }
      applyConfigFromUi();
      syncAvailability();
    } catch (err) {
      console.warn('[UI] Failed to load selected vector field:', err);
      getNotificationCenter().error(err?.message || 'Failed to load vector field.', { category: 'render' });
      disableOverlayUi();
      setInfo('Failed to load vector field.');
    } finally {
      enabling = false;
      enabledCheckbox.disabled = false;
      fieldSelect.disabled = false;
      syncAvailability();
    }
  }

  function handleVectorFieldsChanged() {
    // Dataset swap: reset toggle state so we don’t keep an overlay enabled across datasets.
    disableOverlayUi();
    syncAvailability();
  }

  // ---------------------------------------------------------------------------
  // DOM wiring
  // ---------------------------------------------------------------------------

  enabledCheckbox?.addEventListener('change', handleEnabledChange);
  fieldSelect?.addEventListener('change', handleFieldChanged);

  densityInput?.addEventListener('input', () => {
    const particles = updateDensityDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('particleCount', particles);
  });
  speedInput?.addEventListener('input', () => {
    const speed = updateSpeedDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('speedMultiplier', speed);
  });
  lifetimeInput?.addEventListener('input', () => {
    const lifetime = updateLifetimeDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('lifetime', lifetime);
  });
  sizeInput?.addEventListener('input', () => {
    const size = updateSizeDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('particleSize', size);
  });
  opacityInput?.addEventListener('input', () => {
    const opacity = updateOpacityDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('opacity', opacity);
  });
  colormapSelect?.addEventListener('change', () => {
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('colormapId', colormapSelect.value);
  });
  syncLodCheckbox?.addEventListener('change', () => {
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('syncWithLOD', Boolean(syncLodCheckbox.checked));
  });

  // Advanced settings event listeners - Particle Rendering
  intensityInput?.addEventListener('input', () => {
    const value = updateIntensityDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('intensity', value);
  });
  glowInput?.addEventListener('input', () => {
    const value = updateGlowDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('glowAmount', value);
  });
  cometStretchInput?.addEventListener('input', () => {
    const value = updateCometStretchDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('cometStretch', value);
  });
  coreSharpnessInput?.addEventListener('input', () => {
    const value = updateCoreSharpnessDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('coreSharpness', value);
  });
  // Trail settings
  trailFadeInput?.addEventListener('input', () => {
    const value = updateTrailFadeDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('trailFade', value);
  });
  chromaticFadeInput?.addEventListener('input', () => {
    const value = updateChromaticFadeDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('chromaticFade', value);
  });
  turbulenceInput?.addEventListener('input', () => {
    const value = updateTurbulenceDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('turbulence', value);
  });
  // HDR & Bloom
  exposureInput?.addEventListener('input', () => {
    const value = updateExposureDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('exposure', value);
  });
  bloomStrengthInput?.addEventListener('input', () => {
    const value = updateBloomStrengthDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('bloomStrength', value);
  });
  bloomThresholdInput?.addEventListener('input', () => {
    const value = updateBloomThresholdDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('bloomThreshold', value);
  });
  anamorphicInput?.addEventListener('input', () => {
    const value = updateAnamorphicDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('anamorphicRatio', value);
  });
  // Color Grading
  saturationInput?.addEventListener('input', () => {
    const value = updateSaturationDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('saturation', value);
  });
  contrastInput?.addEventListener('input', () => {
    const value = updateContrastDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('contrast', value);
  });
  highlightsInput?.addEventListener('input', () => {
    const value = updateHighlightsDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('highlights', value);
  });
  shadowsInput?.addEventListener('input', () => {
    const value = updateShadowsDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('shadows', value);
  });
  // Cinematic Effects
  vignetteInput?.addEventListener('input', () => {
    const value = updateVignetteDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('vignette', value);
  });
  filmGrainInput?.addEventListener('input', () => {
    const value = updateFilmGrainDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('filmGrain', value);
  });
  chromaticAberrationInput?.addEventListener('input', () => {
    const value = updateChromaticAberrationDisplay();
    if (enabledCheckbox?.checked && !enabling) viewer.setVectorFieldConfig?.('chromaticAberration', value);
  });

  // ---------------------------------------------------------------------------
  // State wiring
  // ---------------------------------------------------------------------------

  const onVectorFieldsChanged = () => handleVectorFieldsChanged();
  const onDimChanged = () => handleDimensionChanged();

  state?.on?.('vectorFields:changed', onVectorFieldsChanged);
  state?.on?.('dimension:changed', onDimChanged);

  // Initialize UI state.
  updateDensityDisplay();
  updateSpeedDisplay();
  updateLifetimeDisplay();
  updateSizeDisplay();
  updateOpacityDisplay();
  // Advanced settings - Particle Rendering
  updateIntensityDisplay();
  updateGlowDisplay();
  updateCometStretchDisplay();
  updateCoreSharpnessDisplay();
  // Advanced settings - Trail
  updateTrailFadeDisplay();
  updateChromaticFadeDisplay();
  updateTurbulenceDisplay();
  // Advanced settings - HDR & Bloom
  updateExposureDisplay();
  updateBloomStrengthDisplay();
  updateBloomThresholdDisplay();
  updateAnamorphicDisplay();
  // Advanced settings - Color Grading
  updateSaturationDisplay();
  updateContrastDisplay();
  updateHighlightsDisplay();
  updateShadowsDisplay();
  // Advanced settings - Cinematic Effects
  updateVignetteDisplay();
  updateFilmGrainDisplay();
  updateChromaticAberrationDisplay();
  updateSettingsVisibility();
  syncAvailability();

  return {
    syncAvailability,
    destroy() {
      enabledCheckbox?.removeEventListener('change', handleEnabledChange);
      fieldSelect?.removeEventListener('change', handleFieldChanged);
      state?.off?.('vectorFields:changed', onVectorFieldsChanged);
      state?.off?.('dimension:changed', onDimChanged);
    }
  };
}
