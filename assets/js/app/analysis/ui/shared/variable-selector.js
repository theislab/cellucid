/**
 * VariableSelectorComponent - Shared Variable Selection Component
 *
 * Provides a reusable variable selector with a two-step selection flow:
 * 1. First dropdown: Choose the variable type (Categorical obs, Continuous obs, Gene expression)
 * 2. Second dropdown: Choose the specific variable based on the selected type
 *
 * Features:
 * - Two-step selection for cleaner UX
 * - Searchable gene expression selector
 * - Reactive state management
 *
 * Used by: DetailedAnalysisUI, CorrelationAnalysisUI, and other analysis types
 *
 * @example
 * const varSelector = createVariableSelectorComponent({
 *   dataLayer,
 *   container: document.getElementById('var-select'),
 *   onVariableChange: (type, variable) => console.log('Selected:', type, variable),
 *   allowedTypes: ['categorical', 'continuous', 'gene']
 * });
 *
 * // Get current selection
 * const { type, variable } = varSelector.getSelectedVariable();
 *
 * // Cleanup
 * varSelector.destroy();
 */

import { NONE_VALUE } from '../../shared/dom-utils.js';
import {
  createVariableSelector,
  createGeneExpressionSelector
} from '../components/selectors.js';

/**
 * Variable type constants
 */
export const VariableType = {
  CATEGORICAL_OBS: 'categorical_obs',
  CONTINUOUS_OBS: 'continuous_obs',
  GENE_EXPRESSION: 'gene_expression'
};

/**
 * Type labels for display
 */
const TYPE_LABELS = {
  categorical: 'Categorical obs',
  continuous: 'Continuous obs',
  gene: 'Gene expression'
};

/**
 * VariableSelectorComponent Class
 *
 * Encapsulates variable selection UI logic with a two-step flow.
 */
export class VariableSelectorComponent {
  /**
   * @param {Object} options
   * @param {Object} options.dataLayer - Data layer instance for variable info
   * @param {HTMLElement} options.container - Container element to render into
   * @param {Function} [options.onVariableChange] - Callback when selection changes (receives type, variable)
   * @param {string[]} [options.allowedTypes] - Which types to show: ['categorical', 'continuous', 'gene']
   * @param {Object} [options.initialSelection] - Initial selection { type, variable }
   * @param {Object} [options.labels] - Custom labels for each type
   * @param {string} [options.typeLabel] - Custom label for the type selector (default: 'Variable type:')
   * @param {string} [options.idPrefix='var-selector'] - Prefix used to generate unique element IDs
   */
  constructor(options) {
    this.dataLayer = options.dataLayer;
    this.container = options.container;
    this.onVariableChange = options.onVariableChange;

    // Options with defaults
    this.allowedTypes = options.allowedTypes || ['categorical', 'continuous', 'gene'];
    this.idPrefix = options.idPrefix || 'var-selector';
    this.typeLabel = options.typeLabel ?? 'Variable type:';
    this.labels = {
      categorical: options.labels?.categorical ?? 'Categorical obs:',
      continuous: options.labels?.continuous ?? 'Continuous obs:',
      gene: options.labels?.gene ?? 'Gene expression:'
    };

    // State
    this._selectedType = ''; // 'categorical', 'continuous', or 'gene'
    this._currentSelection = options.initialSelection || {
      type: '',
      variable: ''
    };

    // If initial selection provided, derive the type
    if (this._currentSelection.type) {
      this._selectedType = this._getShortType(this._currentSelection.type);
    }

    // DOM references
    this._typeSelect = null;
    this._variableSelect = null;
    this._geneExpressionContainer = null;

    // Render initial state
    this.render();
  }

  /**
   * Convert VariableType constant to short type name
   */
  _getShortType(varType) {
    if (varType === VariableType.CATEGORICAL_OBS) return 'categorical';
    if (varType === VariableType.CONTINUOUS_OBS) return 'continuous';
    if (varType === VariableType.GENE_EXPRESSION) return 'gene';
    return '';
  }

  /**
   * Render the variable selector (two-step flow)
   */
  render() {
    this.container.innerHTML = '';

    try {
      // Step 1: Type selector
      this._renderTypeSelector();

      // Step 2: Variable selector (based on selected type)
      if (this._selectedType) {
        this._renderVariableSelector();
      }
    } catch (err) {
      console.error('[VariableSelectorComponent] Failed to render:', err);
      this.container.innerHTML = `
        <div class="legend-help text-danger">
          Failed to load variables. Please try refreshing.
        </div>
      `;
    }
  }

  /**
   * Render the type selector (first step)
   * Uses .field-select and .obs-select to match site design
   */
  _renderTypeSelector() {
    const fieldSelect = document.createElement('div');
    fieldSelect.className = 'field-select';

    const label = document.createElement('label');
    label.textContent = this.typeLabel;
    label.htmlFor = `${this.idPrefix}-type`;
    fieldSelect.appendChild(label);

    const select = document.createElement('select');
    select.id = `${this.idPrefix}-type`;
    select.className = 'obs-select';

    // Add "None" option to match site pattern
    const defaultOption = document.createElement('option');
    defaultOption.value = NONE_VALUE;
    defaultOption.textContent = 'None';
    defaultOption.selected = !this._selectedType;
    select.appendChild(defaultOption);

    // Add allowed type options
    for (const shortType of this.allowedTypes) {
      const option = document.createElement('option');
      option.value = shortType;
      option.textContent = TYPE_LABELS[shortType] || shortType;
      if (this._selectedType === shortType) {
        option.selected = true;
      }
      select.appendChild(option);
    }

    select.addEventListener('change', () => {
      this._handleTypeChange(select.value === NONE_VALUE ? '' : select.value);
    });

    fieldSelect.appendChild(select);
    this.container.appendChild(fieldSelect);
    this._typeSelect = select;
  }

  /**
   * Render the variable selector based on selected type (second step)
   * The sub-selectors use .field-select containers matching site design
   */
  _renderVariableSelector() {
    if (this._selectedType === 'categorical') {
      this._renderCategoricalSelector();
    } else if (this._selectedType === 'continuous') {
      this._renderContinuousSelector();
    } else if (this._selectedType === 'gene') {
      this._renderGeneSelector();
    }
  }

  /**
   * Render categorical obs selector (no label - type already shown above)
   */
  _renderCategoricalSelector() {
    const categoricalVars = this.dataLayer.getAvailableVariables('categorical_obs');

    const selectedValue = this._currentSelection.type === VariableType.CATEGORICAL_OBS
      ? this._currentSelection.variable
      : '';

    const selector = createVariableSelector({
      variables: categoricalVars,
      selectedValue,
      label: '', // No label needed - type already shown in first dropdown
      id: `${this.idPrefix}-categorical`,
      onChange: (variable) => this._handleVariableChange(VariableType.CATEGORICAL_OBS, variable)
    });

    this.container.appendChild(selector);
    this._variableSelect = selector.querySelector('select');
  }

  /**
   * Render continuous obs selector (no label - type already shown above)
   */
  _renderContinuousSelector() {
    const continuousVars = this.dataLayer.getAvailableVariables('continuous_obs');

    const selectedValue = this._currentSelection.type === VariableType.CONTINUOUS_OBS
      ? this._currentSelection.variable
      : '';

    const selector = createVariableSelector({
      variables: continuousVars,
      selectedValue,
      label: '', // No label needed - type already shown in first dropdown
      id: `${this.idPrefix}-continuous`,
      onChange: (variable) => this._handleVariableChange(VariableType.CONTINUOUS_OBS, variable)
    });

    this.container.appendChild(selector);
    this._variableSelect = selector.querySelector('select');
  }

  /**
   * Render gene expression selector (no label - type already shown above)
   */
  _renderGeneSelector() {
    const geneVars = this.dataLayer.getAvailableVariables('gene_expression');

    if (geneVars.length === 0) {
      const helpDiv = document.createElement('div');
      helpDiv.className = 'legend-help';
      helpDiv.textContent = 'No gene expression data available.';
      this.container.appendChild(helpDiv);
      return;
    }

    const selectedValue = this._currentSelection.type === VariableType.GENE_EXPRESSION
      ? this._currentSelection.variable
      : '';

    const selector = createGeneExpressionSelector({
      genes: geneVars,
      selectedValue,
      label: '', // No label needed - type already shown in first dropdown
      id: `${this.idPrefix}-gene`,
      onChange: (variable) => this._handleVariableChange(VariableType.GENE_EXPRESSION, variable)
    });

    this.container.appendChild(selector);
    this._geneExpressionContainer = selector;
  }

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  /**
   * Handle type selection change
   */
  _handleTypeChange(shortType) {
    this._selectedType = shortType;

    // Clear current selection when type changes
    this._currentSelection = { type: '', variable: '' };

    // Re-render to show the appropriate variable selector
    this.render();

    // Notify about the cleared selection
    this._notifyChange();
  }

  /**
   * Handle variable selection change
   */
  _handleVariableChange(type, variable) {
    if (variable) {
      this._currentSelection = { type, variable };
    } else {
      this._currentSelection = { type: '', variable: '' };
    }

    this._notifyChange();
  }

  /**
   * Notify about selection change
   */
  _notifyChange() {
    if (this.onVariableChange) {
      this.onVariableChange(
        this._currentSelection.type,
        this._currentSelection.variable
      );
    }
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Get currently selected variable
   * @returns {Object} { type, variable }
   */
  getSelectedVariable() {
    return { ...this._currentSelection };
  }

  /**
   * Set the selected variable
   * @param {string} type - Variable type (VariableType constant)
   * @param {string} variable - Variable key
   */
  setSelectedVariable(type, variable) {
    this._selectedType = this._getShortType(type);
    this._currentSelection = { type, variable };
    this.render();
  }

  /**
   * Clear all selections
   */
  clear() {
    this._selectedType = '';
    this._currentSelection = { type: '', variable: '' };
    this.render();
  }

  /**
   * Check if a variable is selected
   * @returns {boolean}
   */
  hasSelection() {
    return !!(this._currentSelection.type && this._currentSelection.variable);
  }

  /**
   * Get the data kind for the current selection
   * @returns {string} 'categorical' or 'continuous'
   */
  getDataKind() {
    if (this._currentSelection.type === VariableType.CATEGORICAL_OBS) {
      return 'categorical';
    }
    return 'continuous';
  }

  /**
   * Refresh variable lists (call when data changes)
   */
  refresh() {
    this.render();
  }

  /**
   * Focus the gene search input (if visible)
   */
  focusGeneSearch() {
    const geneInput = this.container.querySelector('[id$="-search"]');
    if (geneInput) {
      geneInput.focus();
    }
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
    this._selectedType = '';
    this._currentSelection = { type: '', variable: '' };
    this._typeSelect = null;
    this._variableSelect = null;
    this._geneExpressionContainer = null;
    this.container.innerHTML = '';
  }
}

/**
 * Factory function to create VariableSelectorComponent
 * @param {Object} options
 * @returns {VariableSelectorComponent}
 */
export function createVariableSelectorComponent(options) {
  return new VariableSelectorComponent(options);
}

export default VariableSelectorComponent;
