/**
 * Plot Options Rendering
 *
 * UI component for rendering plot-specific options panel
 * based on the current plot type's option schema.
 */

import { PlotRegistry } from '../../shared/plot-registry-utils.js';
import { formatDecimal } from '../../../ui/components/display-format.js';

/**
 * Digits a readout needs to show every value a step can reach.
 * @param {number} step
 * @returns {number}
 */
function stepDigits(step) {
  const text = String(step);
  const exponent = text.match(/e-(\d+)$/);
  if (exponent) return Math.min(6, Number(exponent[1]));
  const fraction = text.split('.')[1];
  return fraction === undefined ? 0 : Math.min(6, fraction.length);
}

/**
 * The empty state an options panel shows when a plot has nothing to tune.
 * @param {HTMLElement} container
 */
function appendNoOptions(container) {
  const empty = document.createElement('p');
  empty.className = 'empty-state';
  empty.textContent = 'No customization options available.';
  container.appendChild(empty);
}

/**
 * A field label bound to the control it names.
 * @param {string} text
 * @param {string} controlId
 * @returns {HTMLLabelElement}
 */
function createOptionLabel(text, controlId) {
  const label = document.createElement('label');
  label.textContent = text;
  label.htmlFor = controlId;
  return label;
}

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
  const optionSchema = Object.hasOwn(plotType, 'optionSchema')
    ? plotType.optionSchema
    : undefined;
  if (
    optionSchema === null ||
    typeof optionSchema !== 'object' ||
    Array.isArray(optionSchema)
  ) {
    throw new TypeError(
      `Plot type ${plotTypeId} optionSchema must be a non-null, non-array object`
    );
  }
  const defaultOptions = Object.hasOwn(plotType, 'defaultOptions')
    ? plotType.defaultOptions
    : undefined;
  if (
    defaultOptions === null ||
    typeof defaultOptions !== 'object' ||
    Array.isArray(defaultOptions)
  ) {
    throw new TypeError(
      `Plot type ${plotTypeId} defaultOptions must be a non-null, non-array object`
    );
  }
  if (Object.keys(optionSchema).length === 0) {
    appendNoOptions(container);
    return;
  }
  const visibleOptions = PlotRegistry.getVisibleOptions(
    plotTypeId,
    currentOptions
  );

  for (const [key, def] of Object.entries(visibleOptions)) {
    const inputId = `${idPrefix}-analysis-opt-${key}`;
    const currentValue = Object.hasOwn(currentOptions, key)
      ? currentOptions[key]
      : undefined;
    const defaultValue = Object.hasOwn(defaultOptions, key)
      ? defaultOptions[key]
      : undefined;
    const value = currentValue ?? defaultValue;
    if (!def || typeof def !== 'object') {
      throw new TypeError(`Plot option ${key} must be an object`);
    }
    const type = Object.hasOwn(def, 'type')
      ? def.type
      : undefined;
    const labelText = Object.hasOwn(def, 'label')
      ? def.label
      : undefined;
    if (typeof labelText !== 'string' || labelText.length === 0) {
      throw new TypeError(`Plot option ${key} must define a non-empty label`);
    }

    const optionRow = document.createElement('div');
    optionRow.className = 'control-block';

    let input;

    switch (type) {
      case 'select': {
        optionRow.appendChild(createOptionLabel(labelText, inputId));

        input = document.createElement('select');
        input.className = 'obs-select';
        input.id = inputId;
        const optionDefinitions = Object.hasOwn(def, 'options')
          ? def.options
          : undefined;
        if (
          !Array.isArray(optionDefinitions) ||
          optionDefinitions.length === 0
        ) {
          throw new TypeError(`Select option ${key} requires a non-empty options array`);
        }
        const choices = optionDefinitions.map(opt => {
          if (!opt || typeof opt !== 'object') {
            throw new TypeError(
              `Select option ${key} contains an invalid choice`
            );
          }
          const choiceLabel = Object.hasOwn(opt, 'label')
            ? opt.label
            : undefined;
          if (typeof choiceLabel !== 'string' || choiceLabel.length === 0) {
            throw new TypeError(
              `Select option ${key} contains an invalid choice`
            );
          }
          return {
            label: choiceLabel,
            value: Object.hasOwn(opt, 'value') ? opt.value : undefined,
          };
        });
        const selectedIndex = choices.findIndex(
          choice => Object.is(choice.value, value)
        );
        if (selectedIndex < 0) {
          throw new RangeError(`Select option ${key} does not define its current value`);
        }
        for (let optionIndex = 0; optionIndex < choices.length; optionIndex++) {
          const choice = choices[optionIndex];
          const option = document.createElement('option');
          option.value = `${optionIndex}`;
          option.textContent = choice.label;
          input.appendChild(option);
        }
        input.selectedIndex = selectedIndex;
        input.addEventListener('change', () => {
          const choice = choices[input.selectedIndex];
          if (!choice) {
            throw new RangeError(`Select option ${key} has no selected schema value`);
          }
          onChange(key, choice.value);
        });
        optionRow.appendChild(input);
        break;
      }

      case 'checkbox': {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.id = inputId;
        if (typeof value !== 'boolean') {
          throw new TypeError(`Checkbox option ${key} must be boolean`);
        }
        input.checked = value;
        input.addEventListener('change', () => {
          onChange(key, input.checked);
        });

        // The option text is the checkbox's own label, wrapping it.
        const checkLabel = document.createElement('label');
        checkLabel.className = 'checkbox-inline';
        checkLabel.htmlFor = input.id;
        checkLabel.appendChild(input);
        checkLabel.appendChild(document.createTextNode(labelText));
        optionRow.appendChild(checkLabel);
        break;
      }

      case 'range':
      case 'number': {
        const min = Object.hasOwn(def, 'min') ? def.min : undefined;
        const max = Object.hasOwn(def, 'max') ? def.max : undefined;
        const step = Object.hasOwn(def, 'step') ? def.step : undefined;
        if (
          !Number.isFinite(min) ||
          !Number.isFinite(max) ||
          !Number.isFinite(step) ||
          min >= max ||
          step <= 0
        ) {
          throw new RangeError(
            `Numeric option ${key} requires finite min < max and a positive step`
          );
        }
        if (!Number.isFinite(value) || value < min || value > max) {
          throw new RangeError(`Numeric option ${key} value must be within its declared range`);
        }
        optionRow.appendChild(createOptionLabel(labelText, inputId));

        input = document.createElement('input');
        input.type = type;
        input.className = type === 'range' ? '' : 'obs-select';
        input.id = inputId;
        input.min = `${min}`;
        input.max = `${max}`;
        input.step = `${step}`;
        input.valueAsNumber = value;

        const commitNumericChange = () => {
          const nextValue = input.valueAsNumber;
          if (!Number.isFinite(nextValue) || nextValue < min || nextValue > max) {
            throw new RangeError(`Numeric option ${key} produced an out-of-range value`);
          }
          onChange(key, nextValue);
        };
        input.addEventListener('change', commitNumericChange);

        if (type === 'number') {
          optionRow.appendChild(input);
          break;
        }

        // A range shows its value beside the track, at the precision its
        // step can reach; the drag only updates the readout, the release
        // commits.
        const digits = stepDigits(step);
        const valueDisplay = document.createElement('span');
        valueDisplay.className = 'slider-value';
        valueDisplay.textContent = formatDecimal(value, digits);
        input.addEventListener('input', () => {
          valueDisplay.textContent = formatDecimal(input.valueAsNumber, digits);
        });

        const rangeRow = document.createElement('div');
        rangeRow.className = 'slider-row';
        rangeRow.appendChild(input);
        rangeRow.appendChild(valueDisplay);
        optionRow.appendChild(rangeRow);
        break;
      }

      case 'text': {
        optionRow.appendChild(createOptionLabel(labelText, inputId));

        input = document.createElement('input');
        input.type = 'text';
        input.className = 'obs-select';
        input.id = inputId;
        if (typeof value !== 'string') {
          throw new TypeError(`Text option ${key} must be a string`);
        }
        const placeholder = Object.hasOwn(def, 'placeholder')
          ? def.placeholder
          : undefined;
        if (placeholder !== undefined && typeof placeholder !== 'string') {
          throw new TypeError(`Text option ${key} placeholder must be a string`);
        }
        input.value = value;
        input.placeholder = placeholder === undefined ? '' : placeholder;
        input.addEventListener('change', () => {
          onChange(key, input.value);
        });
        optionRow.appendChild(input);
        break;
      }

      default:
        throw new RangeError(`Unknown plot option type for ${key}: ${String(type)}`);
    }

    container.appendChild(optionRow);
  }

  if (container.children.length === 0) {
    appendNoOptions(container);
  }
}
