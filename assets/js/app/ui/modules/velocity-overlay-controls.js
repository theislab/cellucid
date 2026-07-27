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
import {
  parseIntegerInput,
  parseRangeInput
} from '../core/numeric-input-contract.js';

const VELOCITY_NUMERIC_INPUTS = Object.freeze({
  density: Object.freeze({
    domKey: 'velocityDensityInput',
    integer: true,
    label: 'Particle density',
    maximum: 500,
    minimum: 1
  }),
  speed: Object.freeze({
    domKey: 'velocitySpeedInput',
    integer: true,
    label: 'Flow speed',
    maximum: 500,
    minimum: 5
  }),
  lifetime: Object.freeze({
    domKey: 'velocityLifetimeInput',
    integer: true,
    label: 'Trail length',
    maximum: 1500,
    minimum: 10
  }),
  size: Object.freeze({
    domKey: 'velocitySizeInput',
    integer: false,
    label: 'Particle size',
    maximum: 30,
    minimum: 0.5
  }),
  opacity: Object.freeze({
    domKey: 'velocityOpacityInput',
    integer: true,
    label: 'Opacity',
    maximum: 100,
    minimum: 0
  }),
  intensity: Object.freeze({
    domKey: 'velocityIntensityInput',
    integer: false,
    label: 'Intensity',
    maximum: 1.5,
    minimum: 0.05
  }),
  glow: Object.freeze({
    domKey: 'velocityGlowInput',
    integer: false,
    label: 'Glow amount',
    maximum: 1,
    minimum: 0
  }),
  cometStretch: Object.freeze({
    domKey: 'velocityCometStretchInput',
    integer: false,
    label: 'Comet stretch',
    maximum: 2,
    minimum: 0
  }),
  coreSharpness: Object.freeze({
    domKey: 'velocityCoreSharpnessInput',
    integer: false,
    label: 'Core sharpness',
    maximum: 1,
    minimum: 0
  }),
  trailFade: Object.freeze({
    domKey: 'velocityTrailFadeInput',
    integer: false,
    label: 'Trail fade',
    maximum: 0.995,
    minimum: 0.9
  }),
  chromaticFade: Object.freeze({
    domKey: 'velocityChromaticFadeInput',
    integer: false,
    label: 'Chromatic fade',
    maximum: 1,
    minimum: 0
  }),
  turbulence: Object.freeze({
    domKey: 'velocityTurbulenceInput',
    integer: false,
    label: 'Turbulence',
    maximum: 1,
    minimum: 0
  }),
  exposure: Object.freeze({
    domKey: 'velocityExposureInput',
    integer: false,
    label: 'Exposure',
    maximum: 2,
    minimum: 0.1
  }),
  bloomStrength: Object.freeze({
    domKey: 'velocityBloomStrengthInput',
    integer: false,
    label: 'Bloom strength',
    maximum: 0.5,
    minimum: 0
  }),
  bloomThreshold: Object.freeze({
    domKey: 'velocityBloomThresholdInput',
    integer: false,
    label: 'Bloom threshold',
    maximum: 1,
    minimum: 0.1
  }),
  anamorphic: Object.freeze({
    domKey: 'velocityAnamorphicInput',
    integer: false,
    label: 'Anamorphic ratio',
    maximum: 3,
    minimum: 1
  }),
  saturation: Object.freeze({
    domKey: 'velocitySaturationInput',
    integer: false,
    label: 'Saturation',
    maximum: 2,
    minimum: 0.5
  }),
  contrast: Object.freeze({
    domKey: 'velocityContrastInput',
    integer: false,
    label: 'Contrast',
    maximum: 2,
    minimum: 0.5
  }),
  highlights: Object.freeze({
    domKey: 'velocityHighlightsInput',
    integer: false,
    label: 'Highlights',
    maximum: 1.5,
    minimum: 0.5
  }),
  shadows: Object.freeze({
    domKey: 'velocityShadowsInput',
    integer: false,
    label: 'Shadows',
    maximum: 1.5,
    minimum: 0.5
  }),
  vignette: Object.freeze({
    domKey: 'velocityVignetteInput',
    integer: false,
    label: 'Vignette',
    maximum: 1,
    minimum: 0
  }),
  filmGrain: Object.freeze({
    domKey: 'velocityFilmGrainInput',
    integer: false,
    label: 'Film grain',
    maximum: 0.1,
    minimum: 0
  }),
  chromaticAberration: Object.freeze({
    domKey: 'velocityChromaticAberrationInput',
    integer: false,
    label: 'Chromatic aberration',
    maximum: 1,
    minimum: 0
  })
});

const REQUIRED_DOM_KEYS = Object.freeze([
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
  ...Object.values(VELOCITY_NUMERIC_INPUTS).map(({ domKey }) => domKey)
]);

function parseVelocityInput(dom, name) {
  const contract = VELOCITY_NUMERIC_INPUTS[name];
  if (!contract) {
    throw new Error(`Unknown vector field overlay numeric input "${String(name)}".`);
  }
  const input = dom[contract.domKey];
  if (!input || typeof input.value !== 'string') {
    throw new Error(
      `Vector field overlay is missing its required ${contract.label} input.`
    );
  }
  const options = {
    minimum: contract.minimum,
    maximum: contract.maximum,
    label: contract.label
  };
  return contract.integer
    ? parseIntegerInput(input.value, options)
    : parseRangeInput(input.value, options);
}

function assertVelocityOverlayContract(options) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).sort().join(',') !== 'dom,state,viewer'
  ) {
    throw new TypeError(
      'Vector field overlay initialization requires exactly dom, state, and viewer.'
    );
  }
  const { state, viewer, dom } = options;
  if (!dom || typeof dom !== 'object' || Array.isArray(dom)) {
    throw new TypeError('Vector field overlay dom must be an object.');
  }
  for (const key of REQUIRED_DOM_KEYS) {
    if (!dom[key]) {
      throw new Error(`Vector field overlay is missing required DOM owner "${key}".`);
    }
  }
  for (const key of ['velocityEnabledCheckbox', 'velocitySyncLodCheckbox']) {
    if (typeof dom[key].checked !== 'boolean') {
      throw new TypeError(`Vector field overlay "${key}" must expose a boolean checked state.`);
    }
  }
  for (const method of [
    'getDimensionLevel',
    'getAvailableVectorFields',
    'getDefaultVectorFieldId',
    'ensureVectorField',
    'on',
    'off'
  ]) {
    if (!state || typeof state[method] !== 'function') {
      throw new TypeError(`Vector field overlay state requires ${method}().`);
    }
  }
  for (const method of [
    'setVectorFieldOverlayEnabled',
    'setVectorFieldConfig',
    'setActiveVectorField'
  ]) {
    if (!viewer || typeof viewer[method] !== 'function') {
      throw new TypeError(`Vector field overlay viewer requires ${method}().`);
    }
  }
  for (const name of Object.keys(VELOCITY_NUMERIC_INPUTS)) {
    parseVelocityInput(dom, name);
  }
}

/**
 * @param {object} options
 * @param {import('../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {object} options.dom
 */
export function initVelocityOverlayControls(options) {
  assertVelocityOverlayContract(options);
  const { state, viewer, dom } = options;
  const controlBlock = dom.velocityControls;
  const settings = dom.velocitySettings;
  const infoEl = dom.velocityInfo;

  const enabledCheckbox = dom.velocityEnabledCheckbox;
  const fieldSelect = dom.velocityFieldSelect;
  const densityInput = dom.velocityDensityInput;
  const densityDisplay = dom.velocityDensityDisplay;
  const speedInput = dom.velocitySpeedInput;
  const speedDisplay = dom.velocitySpeedDisplay;
  const lifetimeInput = dom.velocityLifetimeInput;
  const lifetimeDisplay = dom.velocityLifetimeDisplay;
  const sizeInput = dom.velocitySizeInput;
  const sizeDisplay = dom.velocitySizeDisplay;
  const opacityInput = dom.velocityOpacityInput;
  const opacityDisplay = dom.velocityOpacityDisplay;
  const colormapSelect = dom.velocityColormapSelect;
  const syncLodCheckbox = dom.velocitySyncLodCheckbox;
  // Advanced settings - Particle Rendering
  const intensityInput = dom.velocityIntensityInput;
  const intensityDisplay = dom.velocityIntensityDisplay;
  const glowInput = dom.velocityGlowInput;
  const glowDisplay = dom.velocityGlowDisplay;
  const cometStretchInput = dom.velocityCometStretchInput;
  const cometStretchDisplay = dom.velocityCometStretchDisplay;
  const coreSharpnessInput = dom.velocityCoreSharpnessInput;
  const coreSharpnessDisplay = dom.velocityCoreSharpnessDisplay;
  // Advanced settings - Trail
  const trailFadeInput = dom.velocityTrailFadeInput;
  const trailFadeDisplay = dom.velocityTrailFadeDisplay;
  const chromaticFadeInput = dom.velocityChromaticFadeInput;
  const chromaticFadeDisplay = dom.velocityChromaticFadeDisplay;
  const turbulenceInput = dom.velocityTurbulenceInput;
  const turbulenceDisplay = dom.velocityTurbulenceDisplay;
  // Advanced settings - HDR & Bloom
  const exposureInput = dom.velocityExposureInput;
  const exposureDisplay = dom.velocityExposureDisplay;
  const bloomStrengthInput = dom.velocityBloomStrengthInput;
  const bloomStrengthDisplay = dom.velocityBloomStrengthDisplay;
  const bloomThresholdInput = dom.velocityBloomThresholdInput;
  const bloomThresholdDisplay = dom.velocityBloomThresholdDisplay;
  const anamorphicInput = dom.velocityAnamorphicInput;
  const anamorphicDisplay = dom.velocityAnamorphicDisplay;
  // Advanced settings - Color Grading
  const saturationInput = dom.velocitySaturationInput;
  const saturationDisplay = dom.velocitySaturationDisplay;
  const contrastInput = dom.velocityContrastInput;
  const contrastDisplay = dom.velocityContrastDisplay;
  const highlightsInput = dom.velocityHighlightsInput;
  const highlightsDisplay = dom.velocityHighlightsDisplay;
  const shadowsInput = dom.velocityShadowsInput;
  const shadowsDisplay = dom.velocityShadowsDisplay;
  // Advanced settings - Cinematic Effects
  const vignetteInput = dom.velocityVignetteInput;
  const vignetteDisplay = dom.velocityVignetteDisplay;
  const filmGrainInput = dom.velocityFilmGrainInput;
  const filmGrainDisplay = dom.velocityFilmGrainDisplay;
  const chromaticAberrationInput = dom.velocityChromaticAberrationInput;
  const chromaticAberrationDisplay = dom.velocityChromaticAberrationDisplay;

  let enabling = false;
  let suppressFieldChange = false;

  const getActiveDim = () => {
    const level = state.getDimensionLevel();
    if (!Number.isInteger(level) || level < 1 || level > 3) {
      throw new RangeError(
        `Vector field overlay dimension must be exactly 1, 2, or 3; received ${String(level)}.`
      );
    }
    return level;
  };

  const getAllFields = () => {
    const fields = state.getAvailableVectorFields();
    if (!Array.isArray(fields)) {
      throw new TypeError('Available vector fields must be an array.');
    }
    const ids = new Set();
    for (const field of fields) {
      if (
        !field ||
        typeof field !== 'object' ||
        Array.isArray(field) ||
        typeof field.id !== 'string' ||
        field.id.length === 0 ||
        typeof field.label !== 'string' ||
        field.label.length === 0 ||
        !Array.isArray(field.availableDimensions) ||
        field.availableDimensions.length === 0 ||
        !Number.isInteger(field.defaultDimension) ||
        !field.availableDimensions.includes(field.defaultDimension)
      ) {
        throw new TypeError('Each available vector field must expose one complete current descriptor.');
      }
      const dimensions = new Set();
      for (const dimension of field.availableDimensions) {
        if (
          !Number.isInteger(dimension) ||
          dimension < 1 ||
          dimension > 3 ||
          dimensions.has(dimension)
        ) {
          throw new TypeError(
            `Vector field "${field.id}" must declare unique dimensions from 1 through 3.`
          );
        }
        dimensions.add(dimension);
      }
      if (ids.has(field.id)) {
        throw new TypeError(`Vector field id "${field.id}" is duplicated.`);
      }
      ids.add(field.id);
    }
    return fields;
  };

  const getFieldsForDim = (dim) => {
    if (!Number.isInteger(dim) || dim < 1 || dim > 3) {
      throw new RangeError('Vector field dimension must be exactly 1, 2, or 3.');
    }
    return getAllFields().filter((field) => field.availableDimensions.includes(dim));
  };

  const getUnionDims = () => {
    const dims = new Set();
    for (const field of getAllFields()) {
      for (const dimension of field.availableDimensions) dims.add(dimension);
    }
    return Array.from(dims).sort((a, b) => a - b);
  };

  const getDefaultFieldId = () => {
    const id = state.getDefaultVectorFieldId();
    if (id === null) return null;
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('The default vector field id must be a non-empty string or null.');
    }
    if (!getAllFields().some((field) => field.id === id)) {
      throw new Error(`Default vector field "${id}" is not declared.`);
    }
    return id;
  };

  function setInfo(message) {
    if (typeof message !== 'string') {
      throw new TypeError('Vector field overlay information must be a string.');
    }
    infoEl.textContent = message;
  }

  function disableOverlayUi() {
    enabledCheckbox.checked = false;
    settings.style.display = 'none';
    viewer.setVectorFieldOverlayEnabled(false);
  }

  function updateSettingsVisibility() {
    settings.style.display = enabledCheckbox.checked ? 'block' : 'none';
  }

  function updateDensityDisplay() {
    const thousands = parseVelocityInput(dom, 'density');
    const particles = thousands * 1000;
    densityDisplay.textContent = formatCellCount(particles);
    return particles;
  }

  function updateSpeedDisplay() {
    const value = parseVelocityInput(dom, 'speed') / 100;
    speedDisplay.textContent = `${value.toFixed(value < 0.1 ? 2 : 1)}×`;
    return value;
  }

  function updateLifetimeDisplay() {
    const value = parseVelocityInput(dom, 'lifetime') / 100;
    lifetimeDisplay.textContent = `${value.toFixed(1)}s`;
    return value;
  }

  function updateSizeDisplay() {
    const value = parseVelocityInput(dom, 'size');
    sizeDisplay.textContent = value < 10 ? value.toFixed(1) : `${Math.round(value)}`;
    return value;
  }

  function updateOpacityDisplay() {
    const value = parseVelocityInput(dom, 'opacity') / 100;
    opacityDisplay.textContent = `${Math.round(value * 100)}%`;
    return value;
  }

  // Advanced settings display functions - Particle Rendering
  function updateIntensityDisplay() {
    const value = parseVelocityInput(dom, 'intensity');
    intensityDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateGlowDisplay() {
    const value = parseVelocityInput(dom, 'glow');
    glowDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateCometStretchDisplay() {
    const value = parseVelocityInput(dom, 'cometStretch');
    cometStretchDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateCoreSharpnessDisplay() {
    const value = parseVelocityInput(dom, 'coreSharpness');
    coreSharpnessDisplay.textContent = value.toFixed(2);
    return value;
  }

  // Trail settings
  function updateTrailFadeDisplay() {
    const value = parseVelocityInput(dom, 'trailFade');
    trailFadeDisplay.textContent = value.toFixed(3);
    return value;
  }

  function updateChromaticFadeDisplay() {
    const value = parseVelocityInput(dom, 'chromaticFade');
    chromaticFadeDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateTurbulenceDisplay() {
    const value = parseVelocityInput(dom, 'turbulence');
    turbulenceDisplay.textContent = value.toFixed(2);
    return value;
  }

  // HDR & Bloom
  function updateExposureDisplay() {
    const value = parseVelocityInput(dom, 'exposure');
    exposureDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateBloomStrengthDisplay() {
    const value = parseVelocityInput(dom, 'bloomStrength');
    bloomStrengthDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateBloomThresholdDisplay() {
    const value = parseVelocityInput(dom, 'bloomThreshold');
    bloomThresholdDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateAnamorphicDisplay() {
    const value = parseVelocityInput(dom, 'anamorphic');
    anamorphicDisplay.textContent = value.toFixed(1);
    return value;
  }

  // Color Grading
  function updateSaturationDisplay() {
    const value = parseVelocityInput(dom, 'saturation');
    saturationDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateContrastDisplay() {
    const value = parseVelocityInput(dom, 'contrast');
    contrastDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateHighlightsDisplay() {
    const value = parseVelocityInput(dom, 'highlights');
    highlightsDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateShadowsDisplay() {
    const value = parseVelocityInput(dom, 'shadows');
    shadowsDisplay.textContent = value.toFixed(2);
    return value;
  }

  // Cinematic Effects
  function updateVignetteDisplay() {
    const value = parseVelocityInput(dom, 'vignette');
    vignetteDisplay.textContent = value.toFixed(2);
    return value;
  }

  function updateFilmGrainDisplay() {
    const value = parseVelocityInput(dom, 'filmGrain');
    filmGrainDisplay.textContent = value.toFixed(3);
    return value;
  }

  function updateChromaticAberrationDisplay() {
    const value = parseVelocityInput(dom, 'chromaticAberration');
    chromaticAberrationDisplay.textContent = value.toFixed(2);
    return value;
  }

  function applyConfigFromUi() {
    if (!enabledCheckbox.checked) return;

    viewer.setVectorFieldConfig('particleCount', updateDensityDisplay());
    viewer.setVectorFieldConfig('speedMultiplier', updateSpeedDisplay());
    viewer.setVectorFieldConfig('lifetime', updateLifetimeDisplay());
    viewer.setVectorFieldConfig('particleSize', updateSizeDisplay());
    viewer.setVectorFieldConfig('opacity', updateOpacityDisplay());
    viewer.setVectorFieldConfig('colormapId', colormapSelect.value);
    viewer.setVectorFieldConfig('syncWithLOD', syncLodCheckbox.checked);
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

    const current = fieldSelect.value;
    if (current.length > 0) {
      if (!fieldsForDim.some((field) => field.id === current)) {
        throw new Error(
          `Selected vector field "${current}" is not declared for ${dim}D.`
        );
      }
      return current;
    }

    const defaultId = getDefaultFieldId();
    if (defaultId && fieldsForDim.some((f) => f.id === defaultId)) return defaultId;

    return '';
  }

  function renderFieldSelectForActiveDim() {
    const dim = getActiveDim();
    const fieldsForDim = getFieldsForDim(dim);
    const selectedId = getSelectedFieldId();

    suppressFieldChange = true;
    try {
      fieldSelect.innerHTML = '';
      if (!selectedId && fieldsForDim.length > 0) {
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select vector field';
        placeholder.disabled = true;
        fieldSelect.appendChild(placeholder);
      }
      for (const field of fieldsForDim) {
        const opt = document.createElement('option');
        opt.value = field.id;
        opt.textContent = field.label;
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

    controlBlock.style.display = hasAny ? 'block' : 'none';

    if (!hasAny) {
      setInfo('');
      disableOverlayUi();
      return;
    }

    renderFieldSelectForActiveDim();
    const hasSelectedField = getSelectedFieldId().length > 0;

    enabledCheckbox.disabled = enabling || !hasForDim || !hasSelectedField;
    if (!hasForDim && enabledCheckbox.checked) {
      disableOverlayUi();
    }

    fieldSelect.disabled = enabling || !hasForDim;

    const dimList = unionDims.map((d) => `${d}D`).join(', ');
    if (!hasForDim) {
      setInfo(`Vector fields available for ${dimList}. Switch embedding dimension to enable.`);
      settings.style.display = 'none';
      return;
    }

    if (!hasSelectedField) {
      setInfo(`Available for ${dimList}. Select a vector field before enabling the overlay.`);
      settings.style.display = 'block';
      return;
    }

    setInfo(`Available for ${dimList}.`);
    updateSettingsVisibility();
  }

  async function ensureFieldForActiveDim() {
    const dim = getActiveDim();
    const fieldId = getSelectedFieldId();
    if (fieldId.length === 0) {
      throw new Error(
        'A vector field must be selected before loading overlay data.'
      );
    }
    await state.ensureVectorField(
      fieldId,
      dim,
      { silent: false }
    );
    viewer.setActiveVectorField(fieldId);
  }

  async function handleEnabledChange() {
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
      await ensureFieldForActiveDim();
      viewer.setVectorFieldOverlayEnabled(true);
      applyConfigFromUi();
      updateSettingsVisibility();
      syncAvailability();
    } catch (error) {
      if (!(error instanceof Error) || error.message.length === 0) {
        throw new TypeError(
          'Vector field overlay loading must reject with a non-empty Error.'
        );
      }
      getNotificationCenter().error(error.message, { category: 'render' });
      disableOverlayUi();
      setInfo('Failed to load vector field.');
      throw error;
    } finally {
      enabling = false;
      enabledCheckbox.disabled = false;
      syncAvailability();
    }
  }

  async function handleDimensionChanged() {
    const selectedFieldId = fieldSelect.value;
    if (
      selectedFieldId.length > 0 &&
      !getFieldsForDim(getActiveDim()).some(
        (field) => field.id === selectedFieldId
      )
    ) {
      fieldSelect.value = '';
    }
    syncAvailability();
    if (!enabledCheckbox.checked) return;

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
      enabledCheckbox.disabled = true;
      setInfo('Loading vector field…');
      await ensureFieldForActiveDim();
      viewer.setVectorFieldOverlayEnabled(true);
      applyConfigFromUi();
      syncAvailability();
    } catch (error) {
      if (!(error instanceof Error) || error.message.length === 0) {
        throw new TypeError(
          'Vector field dimension loading must reject with a non-empty Error.'
        );
      }
      getNotificationCenter().error(error.message, { category: 'render' });
      disableOverlayUi();
      setInfo('Failed to load vector field.');
      throw error;
    } finally {
      enabling = false;
      enabledCheckbox.disabled = false;
      syncAvailability();
    }
  }

  async function handleFieldChanged() {
    if (suppressFieldChange) return;
    syncAvailability();
    if (!enabledCheckbox.checked) return;
    if (enabling) return;

    enabling = true;
    enabledCheckbox.disabled = true;
    fieldSelect.disabled = true;
    setInfo('Loading vector field…');
    try {
      await ensureFieldForActiveDim();
      applyConfigFromUi();
      syncAvailability();
    } catch (error) {
      if (!(error instanceof Error) || error.message.length === 0) {
        throw new TypeError(
          'Vector field selection loading must reject with a non-empty Error.'
        );
      }
      getNotificationCenter().error(error.message, { category: 'render' });
      disableOverlayUi();
      setInfo('Failed to load vector field.');
      throw error;
    } finally {
      enabling = false;
      enabledCheckbox.disabled = false;
      fieldSelect.disabled = false;
      syncAvailability();
    }
  }

  function handleVectorFieldsChanged() {
    // Dataset swap: reset toggle state so we don’t keep an overlay enabled across datasets.
    fieldSelect.value = '';
    disableOverlayUi();
    syncAvailability();
  }

  // ---------------------------------------------------------------------------
  // DOM wiring
  // ---------------------------------------------------------------------------

  enabledCheckbox.addEventListener('change', handleEnabledChange);
  fieldSelect.addEventListener('change', handleFieldChanged);

  densityInput.addEventListener('input', () => {
    const particles = updateDensityDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('particleCount', particles);
  });
  speedInput.addEventListener('input', () => {
    const speed = updateSpeedDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('speedMultiplier', speed);
  });
  lifetimeInput.addEventListener('input', () => {
    const lifetime = updateLifetimeDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('lifetime', lifetime);
  });
  sizeInput.addEventListener('input', () => {
    const size = updateSizeDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('particleSize', size);
  });
  opacityInput.addEventListener('input', () => {
    const opacity = updateOpacityDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('opacity', opacity);
  });
  colormapSelect.addEventListener('change', () => {
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('colormapId', colormapSelect.value);
  });
  syncLodCheckbox.addEventListener('change', () => {
    if (enabledCheckbox.checked && !enabling) {
      viewer.setVectorFieldConfig('syncWithLOD', syncLodCheckbox.checked);
    }
  });

  // Advanced settings event listeners - Particle Rendering
  intensityInput.addEventListener('input', () => {
    const value = updateIntensityDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('intensity', value);
  });
  glowInput.addEventListener('input', () => {
    const value = updateGlowDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('glowAmount', value);
  });
  cometStretchInput.addEventListener('input', () => {
    const value = updateCometStretchDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('cometStretch', value);
  });
  coreSharpnessInput.addEventListener('input', () => {
    const value = updateCoreSharpnessDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('coreSharpness', value);
  });
  // Trail settings
  trailFadeInput.addEventListener('input', () => {
    const value = updateTrailFadeDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('trailFade', value);
  });
  chromaticFadeInput.addEventListener('input', () => {
    const value = updateChromaticFadeDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('chromaticFade', value);
  });
  turbulenceInput.addEventListener('input', () => {
    const value = updateTurbulenceDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('turbulence', value);
  });
  // HDR & Bloom
  exposureInput.addEventListener('input', () => {
    const value = updateExposureDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('exposure', value);
  });
  bloomStrengthInput.addEventListener('input', () => {
    const value = updateBloomStrengthDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('bloomStrength', value);
  });
  bloomThresholdInput.addEventListener('input', () => {
    const value = updateBloomThresholdDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('bloomThreshold', value);
  });
  anamorphicInput.addEventListener('input', () => {
    const value = updateAnamorphicDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('anamorphicRatio', value);
  });
  // Color Grading
  saturationInput.addEventListener('input', () => {
    const value = updateSaturationDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('saturation', value);
  });
  contrastInput.addEventListener('input', () => {
    const value = updateContrastDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('contrast', value);
  });
  highlightsInput.addEventListener('input', () => {
    const value = updateHighlightsDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('highlights', value);
  });
  shadowsInput.addEventListener('input', () => {
    const value = updateShadowsDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('shadows', value);
  });
  // Cinematic Effects
  vignetteInput.addEventListener('input', () => {
    const value = updateVignetteDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('vignette', value);
  });
  filmGrainInput.addEventListener('input', () => {
    const value = updateFilmGrainDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('filmGrain', value);
  });
  chromaticAberrationInput.addEventListener('input', () => {
    const value = updateChromaticAberrationDisplay();
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('chromaticAberration', value);
  });

  // ---------------------------------------------------------------------------
  // State wiring
  // ---------------------------------------------------------------------------

  const onVectorFieldsChanged = () => handleVectorFieldsChanged();
  const onDimChanged = () => handleDimensionChanged();

  state.on('vectorFields:changed', onVectorFieldsChanged);
  state.on('dimension:changed', onDimChanged);

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
      enabledCheckbox.removeEventListener('change', handleEnabledChange);
      fieldSelect.removeEventListener('change', handleFieldChanged);
      state.off('vectorFields:changed', onVectorFieldsChanged);
      state.off('dimension:changed', onDimChanged);
    }
  };
}
