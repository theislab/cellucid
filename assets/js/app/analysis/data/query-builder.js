/**
 * Query Builder for Advanced Cell Filtering
 *
 * Provides a flexible way to build complex filter expressions:
 * - Multiple conditions with AND/OR logic
 * - Various operators (equals, greater than, contains, etc.)
 * - Categorical and continuous variable support
 * - Gene expression thresholds
 * - Visual query builder UI
 *
 * Scientists can use this to create sophisticated cell subsets
 * beyond simple category selections.
 */

/**
 * Operator definitions with metadata
 */
export const OPERATORS = {
  // Equality operators
  equals: {
    id: 'equals',
    label: 'equals',
    symbol: '=',
    types: ['categorical', 'continuous'],
    valueType: 'single'
  },
  not_equals: {
    id: 'not_equals',
    label: 'does not equal',
    symbol: '≠',
    types: ['categorical', 'continuous'],
    valueType: 'single'
  },

  // Comparison operators (continuous only)
  greater_than: {
    id: 'greater_than',
    label: 'greater than',
    symbol: '>',
    types: ['continuous'],
    valueType: 'single'
  },
  greater_equal: {
    id: 'greater_equal',
    label: 'greater than or equal',
    symbol: '≥',
    types: ['continuous'],
    valueType: 'single'
  },
  less_than: {
    id: 'less_than',
    label: 'less than',
    symbol: '<',
    types: ['continuous'],
    valueType: 'single'
  },
  less_equal: {
    id: 'less_equal',
    label: 'less than or equal',
    symbol: '≤',
    types: ['continuous'],
    valueType: 'single'
  },
  between: {
    id: 'between',
    label: 'between',
    symbol: '∈',
    types: ['continuous'],
    valueType: 'range'
  },

  // Set operators
  in: {
    id: 'in',
    label: 'is one of',
    symbol: '∈',
    types: ['categorical'],
    valueType: 'multi'
  },
  not_in: {
    id: 'not_in',
    label: 'is not one of',
    symbol: '∉',
    types: ['categorical'],
    valueType: 'multi'
  },

  // String operators
  contains: {
    id: 'contains',
    label: 'contains',
    symbol: '⊃',
    types: ['categorical'],
    valueType: 'single'
  },
  starts_with: {
    id: 'starts_with',
    label: 'starts with',
    symbol: '^',
    types: ['categorical'],
    valueType: 'single'
  },
  ends_with: {
    id: 'ends_with',
    label: 'ends with',
    symbol: '$',
    types: ['categorical'],
    valueType: 'single'
  },

  // Null operators
  is_null: {
    id: 'is_null',
    label: 'is empty/missing',
    symbol: '∅',
    types: ['categorical', 'continuous'],
    valueType: 'none'
  },
  is_not_null: {
    id: 'is_not_null',
    label: 'is not empty',
    symbol: '!∅',
    types: ['categorical', 'continuous'],
    valueType: 'none'
  },

  // Percentile operators
  top_percent: {
    id: 'top_percent',
    label: 'in top %',
    symbol: '↑%',
    types: ['continuous'],
    valueType: 'single'
  },
  bottom_percent: {
    id: 'bottom_percent',
    label: 'in bottom %',
    symbol: '↓%',
    types: ['continuous'],
    valueType: 'single'
  }
};

/**
 * Get operators compatible with a field type
 */
export function getOperatorsForType(fieldType) {
  return Object.values(OPERATORS).filter(op =>
    op.types.includes(fieldType)
  );
}

/**
 * Query Condition class
 */
export class QueryCondition {
  constructor(options = {}) {
    this.id = options.id || crypto.randomUUID();
    this.field = options.field || null;
    this.fieldType = options.fieldType || 'categorical';
    this.fieldSource = options.fieldSource || 'obs'; // 'obs', 'var', 'gene'
    this.operator = options.operator || 'equals';
    this.value = options.value ?? null;
    this.logic = options.logic || 'AND'; // 'AND' or 'OR'
    this.enabled = options.enabled !== false;
    this.negate = options.negate || false;
  }

  /**
   * Validate the condition
   */
  isValid() {
    if (!this.field) return false;
    if (!OPERATORS[this.operator]) return false;

    const op = OPERATORS[this.operator];
    if (op.valueType === 'none') return true;
    if (op.valueType === 'single' && (this.value === null || this.value === undefined)) return false;
    if (op.valueType === 'multi' && (!Array.isArray(this.value) || this.value.length === 0)) return false;
    if (op.valueType === 'range') {
      if (!Array.isArray(this.value) || this.value.length !== 2) return false;
      if (this.value[0] > this.value[1]) return false;
    }

    return true;
  }

  /**
   * Convert to serializable object
   */
  toJSON() {
    return {
      id: this.id,
      field: this.field,
      fieldType: this.fieldType,
      fieldSource: this.fieldSource,
      operator: this.operator,
      value: this.value,
      logic: this.logic,
      enabled: this.enabled,
      negate: this.negate
    };
  }

  /**
   * Create from serialized object
   */
  static fromJSON(json) {
    return new QueryCondition(json);
  }

  /**
   * Get human-readable description
   */
  toString() {
    const op = OPERATORS[this.operator];
    if (!op) return `${this.field} ? ${this.value}`;

    let valueStr = '';
    if (op.valueType === 'single') {
      valueStr = String(this.value);
    } else if (op.valueType === 'multi') {
      valueStr = `[${this.value.slice(0, 3).join(', ')}${this.value.length > 3 ? '...' : ''}]`;
    } else if (op.valueType === 'range') {
      valueStr = `${this.value[0]} - ${this.value[1]}`;
    }

    const prefix = this.negate ? 'NOT ' : '';
    return `${prefix}${this.field} ${op.label} ${valueStr}`.trim();
  }
}

/**
 * Query Builder class
 */
export class QueryBuilder {
  /**
   * @param {Object} dataLayer - Data layer for field info
   */
  constructor(dataLayer) {
    this.dataLayer = dataLayer;
    this.conditions = [];
    this.name = '';
    this.description = '';
    this._changeCallbacks = [];
  }

  /**
   * Add a condition
   */
  addCondition(options = {}) {
    const condition = new QueryCondition(options);
    this.conditions.push(condition);
    this._notifyChange();
    return condition;
  }

  /**
   * Remove a condition by ID
   */
  removeCondition(conditionId) {
    const index = this.conditions.findIndex(c => c.id === conditionId);
    if (index !== -1) {
      this.conditions.splice(index, 1);
      this._notifyChange();
      return true;
    }
    return false;
  }

  /**
   * Update a condition
   */
  updateCondition(conditionId, updates) {
    const condition = this.conditions.find(c => c.id === conditionId);
    if (condition) {
      Object.assign(condition, updates);
      this._notifyChange();
      return condition;
    }
    return null;
  }

  /**
   * Get all conditions
   */
  getConditions() {
    return this.conditions;
  }

  /**
   * Get enabled conditions only
   */
  getEnabledConditions() {
    return this.conditions.filter(c => c.enabled);
  }

  /**
   * Clear all conditions
   */
  clear() {
    this.conditions = [];
    this._notifyChange();
  }

  /**
   * Check if query has any conditions
   */
  isEmpty() {
    return this.conditions.length === 0;
  }

  /**
   * Check if all conditions are valid
   */
  isValid() {
    const enabled = this.getEnabledConditions();
    if (enabled.length === 0) return true;
    return enabled.every(c => c.isValid());
  }

  /**
   * Execute query against cell indices
   *
   * @param {number[]|Uint32Array} cellIndices - Cell indices to filter
   * @param {Object} fieldsData - Map of field -> values array
   * @returns {Promise<number[]>} Filtered cell indices
   */
  async execute(cellIndices, fieldsData) {
    const enabled = this.getEnabledConditions();

    if (enabled.length === 0) {
      return Array.from(cellIndices);
    }

    // Pre-compute percentile thresholds if needed
    const thresholds = await this._computePercentileThresholds(enabled, fieldsData);

    // Apply filters
    const result = [];

    for (const cellIdx of cellIndices) {
      if (this._evaluateCell(cellIdx, enabled, fieldsData, thresholds)) {
        result.push(cellIdx);
      }
    }

    return result;
  }

  /**
   * Pre-compute percentile thresholds for top_percent/bottom_percent operators
   */
  async _computePercentileThresholds(conditions, fieldsData) {
    const thresholds = new Map();

    for (const cond of conditions) {
      if (cond.operator === 'top_percent' || cond.operator === 'bottom_percent') {
        const fieldValues = fieldsData[cond.field];
        if (!fieldValues) continue;

        const validValues = Array.from(fieldValues)
          .filter(v => typeof v === 'number' && Number.isFinite(v));

        if (validValues.length === 0) continue;

        validValues.sort((a, b) => a - b);

        const percentile = cond.value / 100;
        let thresholdValue;

        if (cond.operator === 'top_percent') {
          // Top X% means value > (100-X)th percentile
          const idx = Math.floor(validValues.length * (1 - percentile));
          thresholdValue = validValues[Math.min(idx, validValues.length - 1)];
          thresholds.set(`${cond.id}_threshold`, { value: thresholdValue, type: 'gte' });
        } else {
          // Bottom X% means value < Xth percentile
          const idx = Math.floor(validValues.length * percentile);
          thresholdValue = validValues[Math.max(0, idx - 1)];
          thresholds.set(`${cond.id}_threshold`, { value: thresholdValue, type: 'lte' });
        }
      }
    }

    return thresholds;
  }

  /**
   * Evaluate a single cell against all conditions
   */
  _evaluateCell(cellIdx, conditions, fieldsData, thresholds) {
    if (conditions.length === 0) return true;

    // Start with first condition
    let result = this._evaluateCondition(conditions[0], cellIdx, fieldsData, thresholds);

    // Apply remaining conditions with logic
    for (let i = 1; i < conditions.length; i++) {
      const cond = conditions[i];
      const condResult = this._evaluateCondition(cond, cellIdx, fieldsData, thresholds);

      if (cond.logic === 'AND') {
        result = result && condResult;
      } else {
        result = result || condResult;
      }
    }

    return result;
  }

  /**
   * Evaluate a single condition for a cell
   */
  _evaluateCondition(condition, cellIdx, fieldsData, thresholds) {
    const fieldValues = fieldsData[condition.field];
    if (!fieldValues) return false;

    const value = fieldValues[cellIdx];
    let result = this._evaluateOperator(condition, value, thresholds);

    // Apply negation if set
    if (condition.negate) {
      result = !result;
    }

    return result;
  }

  /**
   * Evaluate operator against value
   */
  _evaluateOperator(condition, value, thresholds) {
    const { operator } = condition;
    const target = condition.value;

    switch (operator) {
      case 'equals':
        return value === target;

      case 'not_equals':
        return value !== target;

      case 'greater_than':
        return typeof value === 'number' && Number.isFinite(value) && value > target;

      case 'greater_equal':
        return typeof value === 'number' && Number.isFinite(value) && value >= target;

      case 'less_than':
        return typeof value === 'number' && Number.isFinite(value) && value < target;

      case 'less_equal':
        return typeof value === 'number' && Number.isFinite(value) && value <= target;

      case 'between':
        return typeof value === 'number' && Number.isFinite(value) &&
               Array.isArray(target) && target.length === 2 &&
               value >= target[0] && value <= target[1];

      case 'in':
        return Array.isArray(target) && target.includes(value);

      case 'not_in':
        return Array.isArray(target) && !target.includes(value);

      case 'contains':
        return String(value).toLowerCase().includes(String(target).toLowerCase());

      case 'starts_with':
        return String(value).toLowerCase().startsWith(String(target).toLowerCase());

      case 'ends_with':
        return String(value).toLowerCase().endsWith(String(target).toLowerCase());

      case 'is_null':
        return value === null || value === undefined ||
               (typeof value === 'number' && !Number.isFinite(value)) ||
               value === '';

      case 'is_not_null':
        return value !== null && value !== undefined &&
               !(typeof value === 'number' && !Number.isFinite(value)) &&
               value !== '';

      case 'top_percent':
      case 'bottom_percent': {
        const threshold = thresholds.get(`${condition.id}_threshold`);
        if (!threshold) return false;
        if (typeof value !== 'number' || !Number.isFinite(value)) return false;
        return threshold.type === 'gte' ? value >= threshold.value : value <= threshold.value;
      }

      default:
        console.warn(`[QueryBuilder] Unknown operator: ${operator}`);
        return false;
    }
  }

  /**
   * Subscribe to changes
   */
  onChange(callback) {
    this._changeCallbacks.push(callback);
    return () => {
      const idx = this._changeCallbacks.indexOf(callback);
      if (idx !== -1) this._changeCallbacks.splice(idx, 1);
    };
  }

  /**
   * Notify change listeners
   */
  _notifyChange() {
    for (const cb of this._changeCallbacks) {
      try {
        cb(this);
      } catch (err) {
        console.error('[QueryBuilder] Change callback error:', err);
      }
    }
  }

  /**
   * Serialize to JSON
   */
  toJSON() {
    return {
      name: this.name,
      description: this.description,
      conditions: this.conditions.map(c => c.toJSON())
    };
  }

  /**
   * Load from JSON
   */
  static fromJSON(json, dataLayer) {
    const builder = new QueryBuilder(dataLayer);
    builder.name = json.name || '';
    builder.description = json.description || '';
    builder.conditions = (json.conditions || []).map(c => QueryCondition.fromJSON(c));
    return builder;
  }

  /**
   * Get human-readable query description
   */
  toString() {
    const enabled = this.getEnabledConditions();
    if (enabled.length === 0) return 'No filters';

    return enabled.map((c, i) => {
      const prefix = i === 0 ? '' : ` ${c.logic} `;
      return prefix + c.toString();
    }).join('');
  }

  // =========================================================================
  // UI Rendering
  // =========================================================================

  /**
   * Render query builder UI
   * @param {HTMLElement} container - Container element
   * @param {Object} options - Render options
   */
  render(container, options = {}) {
    const {
      showHeader = true,
      onExecute = null,
      fieldOptions = []
    } = options;

    container.innerHTML = '';
    container.className = 'query-builder';

    // Header
    if (showHeader) {
      const header = document.createElement('div');
      header.className = 'query-builder-header';
      header.innerHTML = `
        <span class="query-builder-title">Query Builder</span>
        <div class="query-builder-actions">
          <button type="button" class="btn-small query-clear-btn">Clear All</button>
        </div>
      `;

      header.querySelector('.query-clear-btn').addEventListener('click', () => {
        this.clear();
        this.render(container, options);
      });

      container.appendChild(header);
    }

    // Conditions list
    const conditionsList = document.createElement('div');
    conditionsList.className = 'query-conditions-list';

    if (this.conditions.length === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'query-empty-state';
      emptyState.textContent = 'No conditions. Click "Add Condition" to start building your query.';
      conditionsList.appendChild(emptyState);
    } else {
      this.conditions.forEach((condition, index) => {
        const row = this._renderConditionRow(condition, index, fieldOptions, container, options);
        conditionsList.appendChild(row);
      });
    }

    container.appendChild(conditionsList);

    // Add condition button
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn-small query-add-btn';
    addBtn.textContent = '+ Add Condition';
    addBtn.addEventListener('click', () => {
      this.addCondition();
      this.render(container, options);
    });

    container.appendChild(addBtn);

    // Execute button
    if (onExecute) {
      const execBtn = document.createElement('button');
      execBtn.type = 'button';
      execBtn.className = 'btn-primary query-execute-btn';
      execBtn.textContent = 'Apply Filter';
      execBtn.disabled = !this.isValid();
      execBtn.addEventListener('click', () => onExecute(this));

      container.appendChild(execBtn);
    }

    // Summary
    const summary = document.createElement('div');
    summary.className = 'query-summary';
    summary.textContent = this.toString();
    container.appendChild(summary);
  }

  /**
   * Render a single condition row
   */
  _renderConditionRow(condition, index, fieldOptions, container, options) {
    const row = document.createElement('div');
    row.className = 'query-condition-row' + (condition.enabled ? '' : ' disabled');
    row.dataset.conditionId = condition.id;

    // Logic selector (AND/OR) - only show for conditions after the first
    if (index > 0) {
      const logicSelect = document.createElement('select');
      logicSelect.className = 'query-logic-select';
      logicSelect.innerHTML = `
        <option value="AND" ${condition.logic === 'AND' ? 'selected' : ''}>AND</option>
        <option value="OR" ${condition.logic === 'OR' ? 'selected' : ''}>OR</option>
      `;
      logicSelect.addEventListener('change', () => {
        this.updateCondition(condition.id, { logic: logicSelect.value });
      });
      row.appendChild(logicSelect);
    } else {
      const logicPlaceholder = document.createElement('span');
      logicPlaceholder.className = 'query-logic-placeholder';
      logicPlaceholder.textContent = 'WHERE';
      row.appendChild(logicPlaceholder);
    }

    // Field selector
    const fieldSelect = document.createElement('select');
    fieldSelect.className = 'query-field-select';
    fieldSelect.innerHTML = `<option value="">Select field...</option>`;

    for (const field of fieldOptions) {
      const option = document.createElement('option');
      option.value = field.key;
      option.textContent = field.key;
      option.dataset.type = field.type || 'categorical';
      option.dataset.source = field.source || 'obs';
      if (field.key === condition.field) {
        option.selected = true;
      }
      fieldSelect.appendChild(option);
    }

    fieldSelect.addEventListener('change', () => {
      const selectedOption = fieldSelect.selectedOptions[0];
      this.updateCondition(condition.id, {
        field: fieldSelect.value,
        fieldType: selectedOption?.dataset.type || 'categorical',
        fieldSource: selectedOption?.dataset.source || 'obs',
        value: null // Reset value when field changes
      });
      this.render(container, options);
    });

    row.appendChild(fieldSelect);

    // Operator selector
    const operatorSelect = document.createElement('select');
    operatorSelect.className = 'query-operator-select';

    const availableOperators = getOperatorsForType(condition.fieldType);
    for (const op of availableOperators) {
      const option = document.createElement('option');
      option.value = op.id;
      option.textContent = op.label;
      if (op.id === condition.operator) {
        option.selected = true;
      }
      operatorSelect.appendChild(option);
    }

    operatorSelect.addEventListener('change', () => {
      this.updateCondition(condition.id, {
        operator: operatorSelect.value,
        value: null // Reset value when operator changes
      });
      this.render(container, options);
    });

    row.appendChild(operatorSelect);

    // Value input (varies by operator)
    const valueContainer = this._renderValueInput(condition, container, options);
    row.appendChild(valueContainer);

    // Enable/disable toggle
    const enableBtn = document.createElement('button');
    enableBtn.type = 'button';
    enableBtn.className = 'query-toggle-btn';
    enableBtn.title = condition.enabled ? 'Disable condition' : 'Enable condition';
    enableBtn.textContent = condition.enabled ? '✓' : '○';
    enableBtn.addEventListener('click', () => {
      this.updateCondition(condition.id, { enabled: !condition.enabled });
      this.render(container, options);
    });
    row.appendChild(enableBtn);

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'query-remove-btn';
    removeBtn.title = 'Remove condition';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      this.removeCondition(condition.id);
      this.render(container, options);
    });
    row.appendChild(removeBtn);

    return row;
  }

  /**
   * Render value input based on operator type
   */
  _renderValueInput(condition, container, options) {
    const wrapper = document.createElement('div');
    wrapper.className = 'query-value-container';

    const op = OPERATORS[condition.operator];
    if (!op || op.valueType === 'none') {
      return wrapper;
    }

    if (op.valueType === 'single') {
      const input = document.createElement('input');
      input.type = condition.fieldType === 'continuous' ? 'number' : 'text';
      input.className = 'query-value-input';
      input.placeholder = 'Value';
      input.value = condition.value ?? '';

      input.addEventListener('change', () => {
        const val = condition.fieldType === 'continuous'
          ? parseFloat(input.value)
          : input.value;
        this.updateCondition(condition.id, { value: val });
      });

      wrapper.appendChild(input);

    } else if (op.valueType === 'range') {
      const minInput = document.createElement('input');
      minInput.type = 'number';
      minInput.className = 'query-value-input query-range-input';
      minInput.placeholder = 'Min';
      minInput.value = condition.value?.[0] ?? '';

      const maxInput = document.createElement('input');
      maxInput.type = 'number';
      maxInput.className = 'query-value-input query-range-input';
      maxInput.placeholder = 'Max';
      maxInput.value = condition.value?.[1] ?? '';

      const updateRange = () => {
        const min = parseFloat(minInput.value);
        const max = parseFloat(maxInput.value);
        if (Number.isFinite(min) && Number.isFinite(max)) {
          this.updateCondition(condition.id, { value: [min, max] });
        }
      };

      minInput.addEventListener('change', updateRange);
      maxInput.addEventListener('change', updateRange);

      wrapper.appendChild(minInput);
      const sep = document.createElement('span');
      sep.textContent = ' to ';
      sep.className = 'query-range-sep';
      wrapper.appendChild(sep);
      wrapper.appendChild(maxInput);

    } else if (op.valueType === 'multi') {
      // Multi-select for categories
      const select = document.createElement('select');
      select.className = 'query-value-select';
      select.multiple = true;

      // This would need to be populated with actual category values
      // from the data layer - for now just show text input
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'query-value-input';
      input.placeholder = 'Values (comma-separated)';
      input.value = Array.isArray(condition.value) ? condition.value.join(', ') : '';

      input.addEventListener('change', () => {
        const values = input.value.split(',').map(v => v.trim()).filter(v => v);
        this.updateCondition(condition.id, { value: values });
      });

      wrapper.appendChild(input);
    }

    return wrapper;
  }
}

/**
 * Create a new QueryBuilder instance
 */
export function createQueryBuilder(dataLayer) {
  return new QueryBuilder(dataLayer);
}

export default QueryBuilder;
