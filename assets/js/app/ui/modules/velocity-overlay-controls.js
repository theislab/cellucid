/**
 * @fileoverview Vector field overlay UI controls.
 *
 * Wires the sidebar "Vector Field Overlay" controls to the GPU particle overlay in
 * the Viewer. This is intentionally lazy:
 * - We do NOT instantiate the overlay until the user enables it.
 * - We do NOT load vector field data until the user enables it (or keeps it on
 *   while switching embedding dimensions).
 *
 * Vector fields are bound to embeddings: the overlay is enabled only while the
 * active view shows an embedding the dataset provides a field for.
 *
 * @module ui/modules/velocity-overlay-controls
 */

import { getNotificationCenter } from '../../notification-center.js';
import { coalesceToFrame } from '../components/controls.js';
import {
  formatCompactCount,
  formatDecimal,
  formatMultiplier,
  formatPercent,
  formatWithUnit
} from '../components/display-format.js';
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

const decimals = digits => value => formatDecimal(value, digits);

/**
 * Every overlay slider: the viewer setting it drives, how a slider position
 * becomes that setting, and how the readout prints it. One table replaces the
 * twenty-three hand-written update functions it used to take.
 *
 * `commit: 'change'` marks the one slider whose setting restarts the whole
 * particle system (every particle is re-seeded and the trails are cleared):
 * it follows the thumb with its readout only, and applies when the user lets
 * go. Every other setting is applied at most once per frame while dragging.
 */
const VELOCITY_SLIDERS = Object.freeze([
  { name: 'density', config: 'particleCount', display: 'velocityDensityDisplay', commit: 'change',
    read: raw => raw * 1000, format: formatCompactCount },
  { name: 'speed', config: 'speedMultiplier', display: 'velocitySpeedDisplay',
    read: raw => raw / 100, format: value => formatMultiplier(value, value < 0.1 ? 2 : 1) },
  { name: 'lifetime', config: 'lifetime', display: 'velocityLifetimeDisplay',
    read: raw => raw / 100, format: value => formatWithUnit(value, 1, 's') },
  { name: 'size', config: 'particleSize', display: 'velocitySizeDisplay',
    read: raw => raw, format: value => formatDecimal(value, value < 10 ? 1 : 0) },
  { name: 'opacity', config: 'opacity', display: 'velocityOpacityDisplay',
    read: raw => raw / 100, format: value => formatPercent(value * 100) },
  { name: 'intensity', config: 'intensity', display: 'velocityIntensityDisplay',
    read: raw => raw, format: decimals(2) },
  { name: 'glow', config: 'glowAmount', display: 'velocityGlowDisplay',
    read: raw => raw, format: decimals(2) },
  { name: 'cometStretch', config: 'cometStretch', display: 'velocityCometStretchDisplay',
    read: raw => raw, format: decimals(2) },
  { name: 'coreSharpness', config: 'coreSharpness', display: 'velocityCoreSharpnessDisplay',
    read: raw => raw, format: decimals(2) },
  { name: 'trailFade', config: 'trailFade', display: 'velocityTrailFadeDisplay',
    read: raw => raw, format: decimals(3) },
  { name: 'chromaticFade', config: 'chromaticFade', display: 'velocityChromaticFadeDisplay',
    read: raw => raw, format: decimals(2) },
  { name: 'turbulence', config: 'turbulence', display: 'velocityTurbulenceDisplay',
    read: raw => raw, format: decimals(2) },
  { name: 'exposure', config: 'exposure', display: 'velocityExposureDisplay',
    read: raw => raw, format: decimals(2) },
  { name: 'bloomStrength', config: 'bloomStrength', display: 'velocityBloomStrengthDisplay',
    read: raw => raw, format: decimals(2) },
  { name: 'bloomThreshold', config: 'bloomThreshold', display: 'velocityBloomThresholdDisplay',
    read: raw => raw, format: decimals(2) },
  { name: 'anamorphic', config: 'anamorphicRatio', display: 'velocityAnamorphicDisplay',
    read: raw => raw, format: decimals(1) },
  { name: 'saturation', config: 'saturation', display: 'velocitySaturationDisplay',
    read: raw => raw, format: decimals(2) },
  { name: 'contrast', config: 'contrast', display: 'velocityContrastDisplay',
    read: raw => raw, format: decimals(2) },
  { name: 'highlights', config: 'highlights', display: 'velocityHighlightsDisplay',
    read: raw => raw, format: decimals(2) },
  { name: 'shadows', config: 'shadows', display: 'velocityShadowsDisplay',
    read: raw => raw, format: decimals(2) },
  { name: 'vignette', config: 'vignette', display: 'velocityVignetteDisplay',
    read: raw => raw, format: decimals(2) },
  { name: 'filmGrain', config: 'filmGrain', display: 'velocityFilmGrainDisplay',
    read: raw => raw, format: decimals(3) },
  { name: 'chromaticAberration', config: 'chromaticAberration', display: 'velocityChromaticAberrationDisplay',
    read: raw => raw, format: decimals(2) }
].map(slider => Object.freeze(slider)));

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
    'getActiveViewId',
    'getDimensionManager',
    'getViewLayoutKey',
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
  if (!(state.viewContexts instanceof Map)) {
    throw new TypeError('Vector field overlay state requires its viewContexts Map.');
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
  const colormapSelect = dom.velocityColormapSelect;
  const syncLodCheckbox = dom.velocitySyncLodCheckbox;

  let enabling = false;
  let suppressFieldChange = false;
  let destroyed = false;
  let operationGeneration = 0;
  let destructionPromise = null;
  const activeOperations = new Set();
  const domLifecycle = new AbortController();

  function acquireOperationOwner() {
    if (destroyed) return null;
    operationGeneration += 1;
    return operationGeneration;
  }

  function isOperationOwnerCurrent(owner) {
    return (
      !destroyed &&
      owner !== null &&
      owner === operationGeneration
    );
  }

  function trackOperation(operation) {
    const tracked = Promise.resolve(operation);
    activeOperations.add(tracked);
    const retire = () => {
      activeOperations.delete(tracked);
    };
    tracked.then(retire, retire);
    return tracked;
  }

  function observeEventOperation(operation, eventName) {
    void operation.catch(error => {
      if (destroyed) return;
      try {
        console.error(
          `[VelocityOverlayControls] ${eventName} handler failed:`,
          error
        );
      } catch {
        // Optional diagnostics cannot own event or teardown settlement.
      }
    });
    return operation;
  }

  function listen(element, eventName, handler) {
    const guardedHandler = (...args) => {
      if (destroyed) return undefined;
      const result = handler(...args);
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        typeof result.then === 'function'
      ) {
        return observeEventOperation(
          trackOperation(result),
          eventName
        );
      }
      return result;
    };
    element.addEventListener(
      eventName,
      guardedHandler,
      { signal: domLifecycle.signal }
    );
  }

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
        !Array.isArray(field.layoutKeys) ||
        field.layoutKeys.length === 0
      ) {
        throw new TypeError('Each available vector field must expose one complete current descriptor.');
      }
      const layoutKeys = new Set();
      for (const layoutKey of field.layoutKeys) {
        if (
          typeof layoutKey !== 'string' ||
          layoutKey.length === 0 ||
          layoutKeys.has(layoutKey)
        ) {
          throw new TypeError(
            `Vector field "${field.id}" must be bound to distinct embedding ids.`
          );
        }
        layoutKeys.add(layoutKey);
      }
      if (ids.has(field.id)) {
        throw new TypeError(`Vector field id "${field.id}" is duplicated.`);
      }
      ids.add(field.id);
    }
    return fields;
  };

  // A vector field is bound to embeddings, so it is drawn only in a view that
  // shows one of them: the active view's layout, not its dimension, decides.
  const getActiveLayoutKey = () => state.getViewLayoutKey(state.getActiveViewId());

  const getFieldsForActiveLayout = () => {
    const fields = getAllFields();
    // Without vector fields there is nothing to match, and no dataset layout
    // need be published yet.
    if (fields.length === 0) return [];
    const layoutKey = getActiveLayoutKey();
    return fields.filter((field) => field.layoutKeys.includes(layoutKey));
  };

  /**
   * The names of every embedding some vector field is bound to: its label and,
   * when they differ, its id ("UMAP · X_umap_3d"), since one dataset can label
   * several embeddings alike.
   */
  const getBoundEmbeddingLabels = () => {
    const dimensionManager = state.getDimensionManager();
    const labels = new Set();
    for (const field of getAllFields()) {
      for (const layoutKey of field.layoutKeys) {
        const { label } = dimensionManager.getLayout(layoutKey);
        labels.add(label === layoutKey ? layoutKey : `${label} · ${layoutKey}`);
      }
    }
    return [...labels];
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

  function syncDisabledOverlayUi() {
    enabledCheckbox.checked = false;
    settings.hidden = true;
  }

  function disableOverlayUi() {
    syncDisabledOverlayUi();
    viewer.setVectorFieldOverlayEnabled(false);
  }

  function updateSettingsVisibility() {
    settings.hidden = !enabledCheckbox.checked;
  }

  /** Read one slider, print its readout, and return its viewer value. */
  function readSlider(slider) {
    const value = slider.read(parseVelocityInput(dom, slider.name));
    dom[slider.display].textContent = slider.format(value);
    return value;
  }

  function applyConfigFromUi() {
    if (!enabledCheckbox.checked) return;
    for (const slider of VELOCITY_SLIDERS) {
      viewer.setVectorFieldConfig(slider.config, readSlider(slider));
    }
    viewer.setVectorFieldConfig('colormapId', colormapSelect.value);
    viewer.setVectorFieldConfig('syncWithLOD', syncLodCheckbox.checked);
  }

  function getSelectedFieldId() {
    const fieldsForDim = getFieldsForActiveLayout();
    if (!fieldsForDim.length) return '';

    const current = fieldSelect.value;
    if (current.length > 0) {
      if (!fieldsForDim.some((field) => field.id === current)) {
        throw new Error(
          `Selected vector field "${current}" is not bound to the embedding this view shows.`
        );
      }
      return current;
    }

    const defaultId = getDefaultFieldId();
    if (defaultId && fieldsForDim.some((f) => f.id === defaultId)) return defaultId;

    return '';
  }

  function renderFieldSelectForActiveDim() {
    const fieldsForDim = getFieldsForActiveLayout();
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
    if (destroyed) return;
    const boundLabels = getBoundEmbeddingLabels();
    const hasAny = boundLabels.length > 0;
    const fieldsForDim = getFieldsForActiveLayout();
    const hasForDim = fieldsForDim.length > 0;

    controlBlock.hidden = !hasAny;
    renderFieldSelectForActiveDim();

    if (!hasAny) {
      enabledCheckbox.disabled = true;
      fieldSelect.disabled = true;
      setInfo('');
      if (enabledCheckbox.checked) {
        disableOverlayUi();
      } else {
        syncDisabledOverlayUi();
      }
      return;
    }

    const hasSelectedField = getSelectedFieldId().length > 0;

    enabledCheckbox.disabled = enabling || !hasForDim || !hasSelectedField;
    if (!hasForDim && enabledCheckbox.checked) {
      disableOverlayUi();
    }

    fieldSelect.disabled = enabling || !hasForDim;

    const embeddingList = boundLabels.join(', ');
    if (!hasForDim) {
      setInfo(`Vector fields are bound to ${embeddingList}. Show one of them in this view to enable.`);
      settings.hidden = true;
      return;
    }

    if (!hasSelectedField) {
      setInfo(`Available on ${embeddingList}. Select a vector field before enabling the overlay.`);
      settings.hidden = false;
      return;
    }

    setInfo(`Available on ${embeddingList}.`);
    updateSettingsVisibility();
  }

  /**
   * Load the selected field for every representation an open view shows that
   * the field is bound to: each representation's data is loaded once and
   * drawn by every view that shows it.
   */
  async function ensureFieldForShownLayouts(owner) {
    const fieldId = getSelectedFieldId();
    if (fieldId.length === 0) {
      throw new Error(
        'A vector field must be selected before loading overlay data.'
      );
    }
    const field = getAllFields().find(candidate => candidate.id === fieldId);
    const shown = new Set(
      [...state.viewContexts.keys()].map(viewId => state.getViewLayoutKey(viewId))
    );
    for (const layoutKey of field.layoutKeys) {
      if (!shown.has(layoutKey)) continue;
      await state.ensureVectorField(fieldId, layoutKey, { silent: false });
      if (!isOperationOwnerCurrent(owner)) return false;
    }
    if (!isOperationOwnerCurrent(owner)) return false;
    viewer.setActiveVectorField(fieldId);
    return true;
  }

  async function handleEnabledChange() {
    const owner = acquireOperationOwner();
    if (owner === null) return;
    if (!enabledCheckbox.checked) {
      disableOverlayUi();
      syncAvailability();
      return;
    }

    if (getFieldsForActiveLayout().length === 0) {
      disableOverlayUi();
      syncAvailability();
      return;
    }

    enabling = true;
    enabledCheckbox.disabled = true;
    setInfo('Loading vector field…');
    let failureInfo = null;

    try {
      await ensureFieldForShownLayouts(owner);
      if (!isOperationOwnerCurrent(owner)) return;
      viewer.setVectorFieldOverlayEnabled(true);
      applyConfigFromUi();
      updateSettingsVisibility();
      syncAvailability();
    } catch (error) {
      if (!isOperationOwnerCurrent(owner)) return;
      const exactError =
        error instanceof Error && error.message.length > 0
          ? error
          : new TypeError(
              'Vector field overlay loading failed with an invalid error.'
            );
      getNotificationCenter().error(exactError.message, { category: 'render' });
      disableOverlayUi();
      failureInfo = 'Failed to load vector field.';
    } finally {
      if (!isOperationOwnerCurrent(owner)) return;
      enabling = false;
      enabledCheckbox.disabled = false;
      syncAvailability();
      if (failureInfo !== null) setInfo(failureInfo);
    }
  }

  async function handleDimensionChanged() {
    const owner = acquireOperationOwner();
    if (owner === null) return;
    const selectedFieldId = fieldSelect.value;
    if (
      selectedFieldId.length > 0 &&
      !getFieldsForActiveLayout().some(
        (field) => field.id === selectedFieldId
      )
    ) {
      fieldSelect.value = '';
    }
    syncAvailability();
    if (!enabledCheckbox.checked) return;

    // Keep the overlay on across layout switches, but only while the view
    // shows an embedding some field is bound to.
    if (getFieldsForActiveLayout().length === 0) {
      disableOverlayUi();
      syncAvailability();
      return;
    }

    let failureInfo = null;
    try {
      enabling = true;
      enabledCheckbox.disabled = true;
      setInfo('Loading vector field…');
      await ensureFieldForShownLayouts(owner);
      if (!isOperationOwnerCurrent(owner)) return;
      viewer.setVectorFieldOverlayEnabled(true);
      applyConfigFromUi();
      syncAvailability();
    } catch (error) {
      if (!isOperationOwnerCurrent(owner)) return;
      const exactError =
        error instanceof Error && error.message.length > 0
          ? error
          : new TypeError(
              'Vector field dimension loading failed with an invalid error.'
            );
      getNotificationCenter().error(exactError.message, { category: 'render' });
      disableOverlayUi();
      failureInfo = 'Failed to load vector field.';
    } finally {
      if (!isOperationOwnerCurrent(owner)) return;
      enabling = false;
      enabledCheckbox.disabled = false;
      syncAvailability();
      if (failureInfo !== null) setInfo(failureInfo);
    }
  }

  async function handleFieldChanged() {
    const owner = acquireOperationOwner();
    if (owner === null) return;
    if (suppressFieldChange) return;
    syncAvailability();
    if (!enabledCheckbox.checked) return;
    if (enabling) return;

    enabling = true;
    enabledCheckbox.disabled = true;
    fieldSelect.disabled = true;
    setInfo('Loading vector field…');
    let failureInfo = null;
    try {
      await ensureFieldForShownLayouts(owner);
      if (!isOperationOwnerCurrent(owner)) return;
      applyConfigFromUi();
      syncAvailability();
    } catch (error) {
      if (!isOperationOwnerCurrent(owner)) return;
      const exactError =
        error instanceof Error && error.message.length > 0
          ? error
          : new TypeError(
              'Vector field selection loading failed with an invalid error.'
            );
      getNotificationCenter().error(exactError.message, { category: 'render' });
      disableOverlayUi();
      failureInfo = 'Failed to load vector field.';
    } finally {
      if (!isOperationOwnerCurrent(owner)) return;
      enabling = false;
      enabledCheckbox.disabled = false;
      fieldSelect.disabled = false;
      syncAvailability();
      if (failureInfo !== null) setInfo(failureInfo);
    }
  }

  function handleVectorFieldsChanged() {
    if (destroyed) return;
    operationGeneration += 1;
    enabling = false;
    enabledCheckbox.disabled = false;
    fieldSelect.disabled = false;
    // Dataset swap: reset toggle state so we don’t keep an overlay enabled across datasets.
    fieldSelect.value = '';
    disableOverlayUi();
    syncAvailability();
  }

  // ---------------------------------------------------------------------------
  // DOM wiring
  // ---------------------------------------------------------------------------

  listen(enabledCheckbox, 'change', handleEnabledChange);
  listen(fieldSelect, 'change', handleFieldChanged);

  const sliderFrames = [];
  for (const slider of VELOCITY_SLIDERS) {
    const input = dom[VELOCITY_NUMERIC_INPUTS[slider.name].domKey];
    const apply = () => {
      const value = readSlider(slider);
      if (enabledCheckbox.checked && !enabling) {
        viewer.setVectorFieldConfig(slider.config, value);
      }
    };
    if (slider.commit === 'change') {
      const paint = coalesceToFrame(() => readSlider(slider));
      sliderFrames.push(paint);
      listen(input, 'input', () => paint());
      listen(input, 'change', () => {
        paint.cancel();
        apply();
      });
    } else {
      const frame = coalesceToFrame(apply);
      sliderFrames.push(frame);
      listen(input, 'input', () => frame());
      listen(input, 'change', () => frame.flush());
    }
  }
  listen(colormapSelect, 'change', () => {
    if (enabledCheckbox.checked && !enabling) viewer.setVectorFieldConfig('colormapId', colormapSelect.value);
  });
  listen(syncLodCheckbox, 'change', () => {
    if (enabledCheckbox.checked && !enabling) {
      viewer.setVectorFieldConfig('syncWithLOD', syncLodCheckbox.checked);
    }
  });

  // ---------------------------------------------------------------------------
  // State wiring
  // ---------------------------------------------------------------------------

  const onVectorFieldsChanged = () => handleVectorFieldsChanged();
  const onDimChanged = () => {
    if (destroyed) return undefined;
    return observeEventOperation(
      trackOperation(handleDimensionChanged()),
      'view:representation-changed'
    );
  };

  state.on('vectorFields:changed', onVectorFieldsChanged);
  state.on('view:representation-changed', onDimChanged);

  // Initialize UI state.
  for (const slider of VELOCITY_SLIDERS) readSlider(slider);
  updateSettingsVisibility();
  syncAvailability();

  function destroy() {
    if (destructionPromise !== null) return destructionPromise;
    let resolveDestruction;
    let rejectDestruction;
    destructionPromise = new Promise((resolve, reject) => {
      resolveDestruction = resolve;
      rejectDestruction = reject;
    });
    destroyed = true;
    operationGeneration += 1;

    const cleanupErrors = [];
    for (const cleanup of [
      () => domLifecycle.abort(),
      () => sliderFrames.forEach(frame => frame.cancel()),
      () => state.off('vectorFields:changed', onVectorFieldsChanged),
      () => state.off('view:representation-changed', onDimChanged),
    ]) {
      try {
        cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    void Promise.allSettled([...activeOperations])
      .then(() => {
        if (cleanupErrors.length === 1) throw cleanupErrors[0];
        if (cleanupErrors.length > 1) {
          throw new AggregateError(
            cleanupErrors,
            'Vector field overlay controls could not release every owner.'
          );
        }
      })
      .then(resolveDestruction, rejectDestruction);
    return destructionPromise;
  }

  return {
    syncAvailability,
    settleRenderFailure(error) {
      if (!(error instanceof Error) || error.message.length === 0) {
        throw new TypeError(
          'Velocity render failure settlement requires a non-empty Error.'
        );
      }
      if (destroyed) return error;
      const secondaryFailures = [];
      const collectFailure = (value, defaultMessage) => {
        secondaryFailures.push(
          value instanceof Error ? value : new Error(defaultMessage)
        );
      };

      // The renderer has already switched the overlay off before reporting a
      // runtime failure. Retry its pending cleanup once, but keep every UI and
      // notification step independent so a repeated WebGL deletion failure
      // cannot strand checked controls or suppress the terminal notice.
      syncDisabledOverlayUi();
      try {
        viewer.setVectorFieldOverlayEnabled(false);
      } catch (cleanupError) {
        collectFailure(
          cleanupError,
          'Velocity overlay cleanup retry failed with a non-Error value.'
        );
      }
      try {
        syncAvailability();
      } catch (syncError) {
        collectFailure(
          syncError,
          'Velocity overlay availability sync failed with a non-Error value.'
        );
      }
      // A failed availability sync must not be allowed to undo the terminal
      // state owned by this settlement.
      syncDisabledOverlayUi();
      try {
        setInfo('Velocity rendering unavailable.');
      } catch (infoError) {
        collectFailure(
          infoError,
          'Velocity overlay status update failed with a non-Error value.'
        );
      }
      try {
        getNotificationCenter().error(
          `Velocity rendering stopped: ${error.message}`,
          { category: 'render' }
        );
      } catch (notificationError) {
        collectFailure(
          notificationError,
          'Velocity overlay failure notification failed with a non-Error value.'
        );
      }

      if (secondaryFailures.length === 0) return error;
      const diagnostic = new AggregateError(
        [error, ...secondaryFailures],
        'Velocity rendering stopped and failure settlement was incomplete.'
      );
      // This handler is itself the viewer's terminal observer. Throwing here
      // would be re-queued as an unhandled observer failure, so retain the
      // complete aggregate through the diagnostic channel without recursion.
      try {
        console.error(diagnostic);
      } catch {
        // Optional diagnostics cannot replace the settled UI state.
      }
      return diagnostic;
    },
    destroy
  };
}
