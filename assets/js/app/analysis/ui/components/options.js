/**
 * Plot Options Rendering
 *
 * UI component for rendering plot-specific options panel
 * based on the current plot type's option schema.
 */

import { PlotRegistry } from '../../shared/plot-registry-utils.js';
import { debounce } from '../../shared/dom-utils.js';

// =============================================================================
// PLOT OPTIONS RENDERING
// =============================================================================

function coerceSelectValue(def, rawValue) {
  const schemaOptions = def?.options || [];
  if (schemaOptions.length === 0) return rawValue;

  const optionValues = schemaOptions.map(opt => opt.value);
  const allNumbers = optionValues.every(v => typeof v === 'number');
  if (allNumbers) {
    const parsed = parseFloat(rawValue);
    return Number.isNaN(parsed) ? rawValue : parsed;
  }

  const allBooleans = optionValues.every(v => typeof v === 'boolean');
  if (allBooleans) {
    return rawValue === 'true';
  }

  return rawValue;
}

/**
 * Render plot options panel based on current plot type
 * @param {HTMLElement} container - Options container
 * @param {string} plotTypeId - Current plot type ID
 * @param {Object} currentOptions - Current option values
 * @param {Function} onChange - Callback when option changes
 */
export function renderPlotOptions(container, plotTypeId, currentOptions = {}, onChange) {
  container.innerHTML = '';

  const plotType = PlotRegistry.get(plotTypeId);
  if (!plotType || !plotType.optionSchema) {
    const empty = document.createElement('div');
    empty.className = 'legend-help';
    empty.textContent = 'No customization options available.';
    container.appendChild(empty);
    return;
  }

  const visibleOptions = PlotRegistry.getVisibleOptions(plotTypeId, currentOptions);

  for (const [key, def] of Object.entries(visibleOptions)) {
    const value = currentOptions[key] ?? plotType.defaultOptions[key];

    const optionRow = document.createElement('div');
    optionRow.className = 'analysis-option-row';

    let input;

    switch (def.type) {
      case 'select': {
        const label = document.createElement('label');
        label.className = 'analysis-option-label';
        label.textContent = def.label;
        label.htmlFor = `analysis-opt-${key}`;
        optionRow.appendChild(label);

        input = document.createElement('select');
        input.className = 'obs-select analysis-option-select';
        input.id = `analysis-opt-${key}`;
        for (const opt of def.options || []) {
          const option = document.createElement('option');
          option.value = opt.value;
          option.textContent = opt.label;
          if (String(opt.value) === String(value)) option.selected = true;
          input.appendChild(option);
        }
        input.addEventListener('change', () => {
          if (onChange) onChange(key, coerceSelectValue(def, input.value));
        });
        optionRow.appendChild(input);
        break;
      }

      case 'checkbox': {
        optionRow.className = 'analysis-option-row checkbox-row';

        input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'analysis-option-checkbox';
        input.id = `analysis-opt-${key}`;
        input.checked = !!value;
        input.addEventListener('change', () => {
          if (onChange) onChange(key, input.checked);
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
        const label = document.createElement('label');
        label.className = 'analysis-option-label';
        label.textContent = def.label;
        label.htmlFor = `analysis-opt-${key}`;
        optionRow.appendChild(label);

        input = document.createElement('input');
        input.type = 'range';
        input.className = 'analysis-option-range';
        input.id = `analysis-opt-${key}`;
        input.min = def.min ?? 0;
        input.max = def.max ?? 100;
        input.step = def.step ?? 1;
        input.value = value ?? def.min ?? 0;

        const valueDisplay = document.createElement('span');
        valueDisplay.className = 'analysis-option-value';
        valueDisplay.textContent = input.value;

        // Debounce the change handler to prevent memory issues on large datasets
        const debouncedChange = debounce(() => {
          if (onChange) onChange(key, parseFloat(input.value));
        }, 300);

        input.addEventListener('input', () => {
          valueDisplay.textContent = input.value;
        });
        input.addEventListener('change', debouncedChange);

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
        label.htmlFor = `analysis-opt-${key}`;
        optionRow.appendChild(label);

        input = document.createElement('input');
        input.type = 'text';
        input.className = 'analysis-option-text';
        input.id = `analysis-opt-${key}`;
        input.value = value ?? '';
        input.placeholder = def.placeholder ?? '';
        input.addEventListener('change', () => {
          if (onChange) onChange(key, input.value);
        });
        optionRow.appendChild(input);
        break;
      }

      default:
        continue;
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
