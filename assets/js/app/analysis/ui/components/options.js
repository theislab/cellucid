/**
 * Plot Options Rendering
 *
 * UI component for rendering plot-specific options panel
 * based on the current plot type's option schema.
 */

import { PlotRegistry } from '../../shared/plot-registry-utils.js';

// =============================================================================
// PLOT OPTIONS RENDERING
// =============================================================================

let plotOptionsIdCounter = 0;

/**
 * Ensure a stable, unique ID prefix for plot option inputs within a container.
 * This prevents duplicate IDs when multiple modals/windows are open.
 * @param {HTMLElement} container
 * @param {string|undefined|null} providedPrefix
 * @returns {string}
 */
function getOrCreatePlotOptionsIdPrefix(container, providedPrefix) {
  if (providedPrefix !== undefined && providedPrefix !== null) {
    if (
      typeof providedPrefix !== 'string' ||
      providedPrefix.length === 0 ||
      providedPrefix.trim() !== providedPrefix
    ) {
      throw new TypeError('Plot options idPrefix must be exact non-empty text');
    }
    container.dataset.plotOptionsIdPrefix = providedPrefix;
    return providedPrefix;
  }

  const existing = container.dataset.plotOptionsIdPrefix;
  if (existing !== undefined) {
    if (existing.length === 0) {
      throw new TypeError('Stored plot options idPrefix must be non-empty');
    }
    return existing;
  }

  plotOptionsIdCounter += 1;
  const next = `plotopts-${plotOptionsIdCounter}`;
  container.dataset.plotOptionsIdPrefix = next;
  return next;
}

/**
 * Render plot options panel based on current plot type
 * @param {HTMLElement} container - Options container
 * @param {string} plotTypeId - Current plot type ID
 * @param {Object} currentOptions - Current option values
 * @param {Function} onChange - Callback when option changes
 * @param {{ idPrefix?: string }} [renderOptions] - Optional render options
 */
export function renderPlotOptions(container, plotTypeId, currentOptions = {}, onChange, renderOptions = {}) {
  if (!container || typeof container.appendChild !== 'function' || !container.dataset) {
    throw new TypeError('Plot options container must be an HTML element');
  }
  if (typeof plotTypeId !== 'string' || plotTypeId.length === 0) {
    throw new TypeError('Plot type ID must be a non-empty string');
  }
  if (!currentOptions || typeof currentOptions !== 'object' || Array.isArray(currentOptions)) {
    throw new TypeError('Current plot options must be an object');
  }
  if (typeof onChange !== 'function') {
    throw new TypeError('Plot options onChange callback is required');
  }
  if (!renderOptions || typeof renderOptions !== 'object' || Array.isArray(renderOptions)) {
    throw new TypeError('Plot render options must be an object');
  }
  container.innerHTML = '';
  const idPrefix = getOrCreatePlotOptionsIdPrefix(container, renderOptions.idPrefix);

  const plotType = PlotRegistry.get(plotTypeId);
  if (!plotType) {
    throw new RangeError(`Unknown plot type: ${plotTypeId}`);
  }
  if (!plotType.optionSchema || Object.keys(plotType.optionSchema).length === 0) {
    const empty = document.createElement('div');
    empty.className = 'legend-help';
    empty.textContent = 'No customization options available.';
    container.appendChild(empty);
    return;
  }

  const visibleOptions = PlotRegistry.getVisibleOptions(plotTypeId, currentOptions);

  for (const [key, def] of Object.entries(visibleOptions)) {
    const inputId = `${idPrefix}-analysis-opt-${key}`;
    if (!plotType.defaultOptions || typeof plotType.defaultOptions !== 'object') {
      throw new TypeError(`Plot type ${plotTypeId} must define defaultOptions`);
    }
    const value = Object.hasOwn(currentOptions, key)
      ? currentOptions[key]
      : plotType.defaultOptions[key];
    if (!def || typeof def !== 'object' || typeof def.label !== 'string' || def.label.length === 0) {
      throw new TypeError(`Plot option ${key} must define a non-empty label`);
    }

    const optionRow = document.createElement('div');
    optionRow.className = 'analysis-option-row';

    let input;

    switch (def.type) {
      case 'select': {
        const label = document.createElement('label');
        label.className = 'analysis-option-label';
        label.textContent = def.label;
        label.htmlFor = inputId;
        optionRow.appendChild(label);

        input = document.createElement('select');
        input.className = 'obs-select analysis-option-select';
        input.id = inputId;
        if (!Array.isArray(def.options) || def.options.length === 0) {
          throw new TypeError(`Select option ${key} requires a non-empty options array`);
        }
        const selectedIndex = def.options.findIndex(opt => Object.is(opt.value, value));
        if (selectedIndex < 0) {
          throw new RangeError(`Select option ${key} does not define its current value`);
        }
        for (let optionIndex = 0; optionIndex < def.options.length; optionIndex++) {
          const opt = def.options[optionIndex];
          if (!opt || typeof opt.label !== 'string' || opt.label.length === 0) {
            throw new TypeError(`Select option ${key} contains an invalid choice`);
          }
          const option = document.createElement('option');
          option.value = `${optionIndex}`;
          option.textContent = opt.label;
          input.appendChild(option);
        }
        input.selectedIndex = selectedIndex;
        input.addEventListener('change', () => {
          const option = def.options[input.selectedIndex];
          if (!option) {
            throw new RangeError(`Select option ${key} has no selected schema value`);
          }
          onChange(key, option.value);
        });
        optionRow.appendChild(input);
        break;
      }

      case 'checkbox': {
        optionRow.className = 'analysis-option-row checkbox-row';

        input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'analysis-option-checkbox';
        input.id = inputId;
        if (typeof value !== 'boolean') {
          throw new TypeError(`Checkbox option ${key} must be boolean`);
        }
        input.checked = value;
        input.addEventListener('change', () => {
          onChange(key, input.checked);
        });

        const checkLabel = document.createElement('label');
        checkLabel.className = 'analysis-option-label';
        checkLabel.htmlFor = input.id;
        checkLabel.textContent = def.label;

        optionRow.appendChild(input);
        optionRow.appendChild(checkLabel);
        break;
      }

      case 'range':
      case 'number': {
        if (
          !Number.isFinite(def.min) ||
          !Number.isFinite(def.max) ||
          !Number.isFinite(def.step) ||
          def.min >= def.max ||
          def.step <= 0
        ) {
          throw new RangeError(
            `Numeric option ${key} requires finite min < max and a positive step`
          );
        }
        if (!Number.isFinite(value) || value < def.min || value > def.max) {
          throw new RangeError(`Numeric option ${key} value must be within its declared range`);
        }
        const label = document.createElement('label');
        label.className = 'analysis-option-label';
        label.textContent = def.label;
        label.htmlFor = inputId;
        optionRow.appendChild(label);

        input = document.createElement('input');
        input.type = def.type;
        input.className = def.type === 'range'
          ? 'analysis-option-range'
          : 'analysis-option-number';
        input.id = inputId;
        input.min = `${def.min}`;
        input.max = `${def.max}`;
        input.step = `${def.step}`;
        input.valueAsNumber = value;

        const valueDisplay = document.createElement('span');
        valueDisplay.className = 'analysis-option-value';
        valueDisplay.textContent = `${value}`;

        const commitNumericChange = () => {
          const nextValue = input.valueAsNumber;
          if (!Number.isFinite(nextValue) || nextValue < def.min || nextValue > def.max) {
            throw new RangeError(`Numeric option ${key} produced an out-of-range value`);
          }
          onChange(key, nextValue);
        };

        input.addEventListener('input', () => {
          valueDisplay.textContent = `${input.valueAsNumber}`;
        });
        input.addEventListener('change', commitNumericChange);

        const rangeRow = document.createElement('div');
        rangeRow.className = 'slider-row';
        rangeRow.appendChild(input);
        rangeRow.appendChild(valueDisplay);
        optionRow.appendChild(rangeRow);
        break;
      }

      case 'text': {
        const label = document.createElement('label');
        label.className = 'analysis-option-label';
        label.textContent = def.label;
        label.htmlFor = inputId;
        optionRow.appendChild(label);

        input = document.createElement('input');
        input.type = 'text';
        input.className = 'analysis-option-text';
        input.id = inputId;
        if (typeof value !== 'string') {
          throw new TypeError(`Text option ${key} must be a string`);
        }
        if (def.placeholder !== undefined && typeof def.placeholder !== 'string') {
          throw new TypeError(`Text option ${key} placeholder must be a string`);
        }
        input.value = value;
        input.placeholder = def.placeholder === undefined ? '' : def.placeholder;
        input.addEventListener('change', () => {
          onChange(key, input.value);
        });
        optionRow.appendChild(input);
        break;
      }

      default:
        throw new RangeError(`Unknown plot option type for ${key}: ${String(def.type)}`);
    }

    container.appendChild(optionRow);
  }

  if (container.children.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'legend-help';
    empty.textContent = 'No customization options available.';
    container.appendChild(empty);
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  renderPlotOptions
};
