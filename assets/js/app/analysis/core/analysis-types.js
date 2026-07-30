/**
 * Analysis Types and Validation
 *
 * Shared type definitions (via JSDoc) and validation utilities for the analysis module.
 * Provides a unified contract for configs, results, and plugins.
 *
 * This module is imported by:
 * - plugin-contract.js (validatePluginContract, validateOptionsAgainstSchema, mergeOptions)
 *
 * Note: Individual modules (transforms, templates, plots) have their own validate()
 * methods for plugin-specific validation. The validateAnalysisConfig() function
 * is for formal AnalysisConfig object validation (e.g., for serialization/persistence).
 */

import { setOwnDataProperty } from '../../../utils/exact-record.js';

// =============================================================================
// TYPE DEFINITIONS (JSDoc for IDE support)
// =============================================================================

/**
 * @typedef {Object} AnalysisConfig
 * @property {string} id - Unique identifier for this analysis run
 * @property {string} type - Analysis type: 'comparison' | 'differential' | 'correlation' | 'custom'
 * @property {string[]} pageIds - Page IDs involved in analysis
 * @property {VariableSelection[]} variables - Selected variables
 * @property {TransformConfig[]} transforms - Transform pipeline configuration
 * @property {PlotConfig[]} plots - Plot configurations
 * @property {Object} [options] - Analysis-type-specific options
 * @property {number} created - Unix timestamp of creation
 * @property {number} [modified] - Unix timestamp of last modification
 */

/**
 * @typedef {Object} VariableSelection
 * @property {string} key - Variable key/name
 * @property {string} type - Variable type: 'categorical_obs' | 'continuous_obs' | 'gene_expression'
 * @property {string} [role] - Role in analysis: 'primary' | 'secondary' | 'grouping' | 'covariate'
 */

/**
 * @typedef {Object} TransformConfig
 * @property {string} id - Transform identifier (e.g., 'log1p', 'zscore')
 * @property {boolean} enabled - Whether transform is active
 * @property {Object} options - Transform-specific options
 */

/**
 * @typedef {Object} PlotConfig
 * @property {string} type - Plot type identifier (e.g., 'barplot', 'histogram')
 * @property {string} variableKey - Variable to plot
 * @property {Object} options - Plot-specific options
 * @property {string} [layoutSlot] - Position in layout ('main' | 'side' | 'grid-N')
 */

/**
 * @typedef {Object} AnalysisResult
 * @property {string} configId - Reference to source config
 * @property {boolean} success - Whether analysis completed successfully
 * @property {number} computeTimeMs - Time taken for computation
 * @property {Object} data - Result data (structure depends on analysis type)
 * @property {StatisticalResult[]} [statistics] - Statistical test results
 * @property {PlotResult[]} [plots] - Generated plot data
 * @property {string[]} [warnings] - Non-fatal warnings
 * @property {string} [error] - Error message if failed
 * @property {ExportableData} [exportable] - Data formatted for export
 */

/**
 * @typedef {Object} StatisticalResult
 * @property {string} testId - Statistical test identifier
 * @property {string} testName - Human-readable test name
 * @property {number} statistic - Test statistic value
 * @property {number} pValue - P-value
 * @property {string} [pValueMethod] - Inference method used for the p-value
 * @property {number} [effectSize] - Effect size (Cohen's d, etc.)
 * @property {number[]} [confidenceInterval] - [lower, upper] bounds
 * @property {number} [degreesOfFreedom] - DoF for the test
 * @property {Object} [extra] - Additional test-specific results
 */

/**
 * @typedef {Object} PlotResult
 * @property {string} plotType - Plot type used
 * @property {Object} traces - Plotly traces
 * @property {Object} layout - Plotly layout
 * @property {HTMLElement} [container] - DOM container reference
 */

/**
 * @typedef {Object} ExportableData
 * @property {Object[]} rows - Array of row objects for CSV/table export
 * @property {string[]} columns - Column names in order
 * @property {Object} metadata - Export metadata (source, date, config summary)
 */

// =============================================================================
// PLUGIN CONTRACT TYPES
// =============================================================================

/**
 * @typedef {Object} PluginContract
 * @property {string} id - Unique plugin identifier (lowercase, no spaces)
 * @property {string} name - Human-readable name
 * @property {string} [description] - Plugin description
 * @property {string[]} supportedTypes - Data types this plugin handles
 * @property {Object} defaultOptions - Default option values
 * @property {OptionSchema} optionSchema - Schema for options UI generation
 * @property {Function} validate - Validation function(config) => { valid, errors }
 * @property {Function} execute - Execution function (signature depends on plugin type)
 */

/**
 * @typedef {Object} OptionSchema
 * @description Object mapping option keys to their schema definitions
 * Each key maps to an OptionDefinition
 */

/**
 * @typedef {Object} OptionDefinition
 * @property {string} type - Input type: 'select' | 'checkbox' | 'number' | 'range' | 'text' | 'color'
 * @property {string} label - Display label
 * @property {string} [description] - Help text
 * @property {boolean} [required] - Whether required
 * @property {*} [default] - Default value
 * @property {Array<{value: *, label: string}>} [options] - For select type
 * @property {number} [min] - For number/range types
 * @property {number} [max] - For number/range types
 * @property {number} [step] - For number/range types
 * @property {Function} [validate] - Custom validation function
 * @property {string[]} [dependsOn] - Option keys this depends on
 * @property {Function} [showWhen] - Conditional display function
 */

// =============================================================================
// VALIDATION UTILITIES
// =============================================================================

function isObjectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validation result type
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Whether validation passed
 * @property {string[]} errors - Array of error messages
 * @property {string[]} warnings - Array of warning messages
 */

/**
 * Validate an analysis configuration
 * @param {AnalysisConfig} config - Configuration to validate
 * @param {Object} [options] - Validation options
 * @param {boolean} [options.strict=false] - Require all fields
 * @returns {ValidationResult}
 */
export function validateAnalysisConfig(config, options = {}) {
  const { strict = false } = options;
  const errors = [];
  const warnings = [];

  // Required fields
  if (!config) {
    return { valid: false, errors: ['Config is null or undefined'], warnings: [] };
  }

  if (!config.type) {
    errors.push('Missing required field: type');
  } else if (!['comparison', 'differential', 'correlation', 'custom'].includes(config.type)) {
    errors.push(`Invalid analysis type: ${config.type}`);
  }

  if (!config.pageIds || !Array.isArray(config.pageIds)) {
    errors.push('Missing or invalid pageIds array');
  } else if (config.pageIds.length === 0) {
    errors.push('pageIds array is empty');
  }

  // Validate variables if present
  if (config.variables) {
    if (!Array.isArray(config.variables)) {
      errors.push('variables must be an array');
    } else {
      config.variables.forEach((v, i) => {
        const varErrors = validateVariableSelection(v);
        varErrors.forEach(e => errors.push(`variables[${i}]: ${e}`));
      });
    }
  } else if (strict) {
    errors.push('Missing required field: variables');
  }

  // Validate transforms if present
  if (config.transforms) {
    if (!Array.isArray(config.transforms)) {
      errors.push('transforms must be an array');
    } else {
      config.transforms.forEach((t, i) => {
        const transformErrors = validateTransformConfig(t);
        transformErrors.forEach(e => errors.push(`transforms[${i}]: ${e}`));
      });
    }
  }

  // Validate plots if present
  if (config.plots) {
    if (!Array.isArray(config.plots)) {
      errors.push('plots must be an array');
    } else {
      config.plots.forEach((p, i) => {
        const plotErrors = validatePlotConfig(p);
        plotErrors.forEach(e => errors.push(`plots[${i}]: ${e}`));
      });
    }
  }

  // Check for ID
  if (strict && !config.id) {
    errors.push('Missing required field: id');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validate a variable selection
 * @param {VariableSelection} variable
 * @returns {string[]} Array of error messages
 */
export function validateVariableSelection(variable) {
  const errors = [];

  if (!variable.key) {
    errors.push('Missing key');
  }

  if (!variable.type) {
    errors.push('Missing type');
  } else if (!['categorical_obs', 'continuous_obs', 'gene_expression'].includes(variable.type)) {
    errors.push(`Invalid type: ${variable.type}`);
  }

  if (variable.role && !['primary', 'secondary', 'grouping', 'covariate'].includes(variable.role)) {
    errors.push(`Invalid role: ${variable.role}`);
  }

  return errors;
}

/**
 * Validate a transform configuration
 * @param {TransformConfig} transform
 * @returns {string[]} Array of error messages
 */
export function validateTransformConfig(transform) {
  const errors = [];

  if (!transform.id) {
    errors.push('Missing id');
  }

  if (typeof transform.enabled !== 'boolean') {
    errors.push('enabled must be a boolean');
  }

  if (transform.options && typeof transform.options !== 'object') {
    errors.push('options must be an object');
  }

  return errors;
}

/**
 * Validate a plot configuration
 * @param {PlotConfig} plot
 * @returns {string[]} Array of error messages
 */
export function validatePlotConfig(plot) {
  const errors = [];

  if (!plot.type) {
    errors.push('Missing type');
  }

  if (!plot.variableKey) {
    errors.push('Missing variableKey');
  }

  if (plot.options && typeof plot.options !== 'object') {
    errors.push('options must be an object');
  }

  return errors;
}

/**
 * Validate a plugin contract definition
 * @param {PluginContract} plugin - Plugin to validate
 * @param {string} pluginType - Type of plugin ('plot' | 'transform' | 'template' | 'stat')
 * @returns {ValidationResult}
 */
export function validatePluginContract(plugin, pluginType = 'plugin') {
  const errors = [];
  const warnings = [];

  if (!isObjectRecord(plugin)) {
    return { valid: false, errors: ['Plugin must be an object'], warnings: [] };
  }

  // Required fields for all plugins
  if (!Object.hasOwn(plugin, 'id')) {
    errors.push('Missing required field: id');
  } else if (
    typeof plugin.id !== 'string' ||
    plugin.id.trim().length === 0
  ) {
    errors.push('id must be a non-empty string');
  } else if (!/^[a-z][a-z0-9_-]*$/.test(plugin.id)) {
    errors.push('id must be lowercase alphanumeric with hyphens/underscores, starting with a letter');
  }

  if (!Object.hasOwn(plugin, 'name')) {
    errors.push('Missing required field: name');
  } else if (
    typeof plugin.name !== 'string' ||
    plugin.name.trim().length === 0
  ) {
    errors.push('name must be a non-empty string');
  }

  if (!Object.hasOwn(plugin, 'supportedTypes')) {
    errors.push('Missing required field: supportedTypes');
  } else if (!Array.isArray(plugin.supportedTypes)) {
    errors.push('supportedTypes must be an array');
  } else if (plugin.supportedTypes.length === 0) {
    errors.push('supportedTypes must be a non-empty array');
  } else if (plugin.supportedTypes.some(
    type => typeof type !== 'string' || type.trim().length === 0
  )) {
    errors.push('supportedTypes entries must be non-empty strings');
  }

  // defaultOptions
  if (
    !Object.hasOwn(plugin, 'defaultOptions') ||
    plugin.defaultOptions === undefined
  ) {
    warnings.push('No defaultOptions defined');
  } else if (!isObjectRecord(plugin.defaultOptions)) {
    errors.push('defaultOptions must be an object');
  }

  // optionSchema
  if (
    !Object.hasOwn(plugin, 'optionSchema') ||
    plugin.optionSchema === undefined
  ) {
    warnings.push('No optionSchema defined - UI will use defaults');
  } else {
    const schemaErrors = validateOptionSchema(plugin.optionSchema);
    schemaErrors.forEach(e => errors.push(`optionSchema: ${e}`));
  }

  // validate function
  if (
    Object.hasOwn(plugin, 'validate') &&
    plugin.validate &&
    typeof plugin.validate !== 'function'
  ) {
    errors.push('validate must be a function');
  }

  // Type-specific validations
  switch (pluginType) {
    case 'plot':
      if (
        !Object.hasOwn(plugin, 'render') ||
        typeof plugin.render !== 'function'
      ) {
        errors.push('Plot plugins must have a render function');
      }
      break;
    case 'transform':
      if (
        !Object.hasOwn(plugin, 'execute') ||
        typeof plugin.execute !== 'function'
      ) {
        errors.push('Transform plugins must have an execute function');
      }
      break;
    case 'template':
      if (!Object.hasOwn(plugin, 'requiredInputs') || !plugin.requiredInputs) {
        errors.push('Template plugins must have requiredInputs');
      }
      break;
    case 'stat':
      if (
        !Object.hasOwn(plugin, 'compute') ||
        typeof plugin.compute !== 'function'
      ) {
        errors.push('Statistical test plugins must have a compute function');
      }
      break;
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validate an option schema
 * @param {OptionSchema} schema
 * @returns {string[]} Array of error messages
 */
export function validateOptionSchema(schema) {
  const errors = [];
  const validTypes = ['select', 'checkbox', 'number', 'range', 'text', 'color', 'multiselect'];

  if (!isObjectRecord(schema)) {
    return ['Schema must be an object'];
  }

  for (const [key, def] of Object.entries(schema)) {
    if (!isObjectRecord(def)) {
      errors.push(`${key}: definition must be an object`);
      continue;
    }

    const hasType = Object.hasOwn(def, 'type');
    const type = hasType
      ? def.type
      : undefined;
    const hasLabel = Object.hasOwn(def, 'label');
    const label = hasLabel
      ? def.label
      : undefined;

    if (!hasType) {
      errors.push(`${key}: missing type`);
    } else if (
      typeof type !== 'string' ||
      type.trim().length === 0
    ) {
      errors.push(`${key}: type must be a non-empty string`);
    } else if (!validTypes.includes(type)) {
      errors.push(`${key}: invalid type '${type}'`);
    }

    if (!hasLabel) {
      errors.push(`${key}: missing label`);
    } else if (
      typeof label !== 'string' ||
      label.trim().length === 0
    ) {
      errors.push(`${key}: label must be a non-empty string`);
    }

    const optionValues = Object.hasOwn(def, 'options')
      ? def.options
      : undefined;
    if (type === 'select' || type === 'multiselect') {
      if (type === 'select' && !Array.isArray(optionValues)) {
        errors.push(`${key}: select type requires options array`);
      } else if (
        optionValues !== undefined &&
        !Array.isArray(optionValues)
      ) {
        errors.push(`${key}: options must be an array`);
      } else if (Array.isArray(optionValues)) {
        for (let i = 0; i < optionValues.length; i++) {
          const option = optionValues[i];
          if (!isObjectRecord(option)) {
            errors.push(`${key}: options[${i}] must be an object`);
            continue;
          }
          if (!Object.hasOwn(option, 'value')) {
            errors.push(`${key}: options[${i}] is missing value`);
          }
          const optionLabel = Object.hasOwn(option, 'label')
            ? option.label
            : undefined;
          if (
            typeof optionLabel !== 'string' ||
            optionLabel.trim().length === 0
          ) {
            errors.push(
              `${key}: options[${i}].label must be a non-empty string`
            );
          }
        }
      }
    }

    if (type === 'number' || type === 'range') {
      const min = Object.hasOwn(def, 'min')
        ? def.min
        : undefined;
      const max = Object.hasOwn(def, 'max')
        ? def.max
        : undefined;
      const step = Object.hasOwn(def, 'step')
        ? def.step
        : undefined;
      const validMin = min === undefined ||
        (typeof min === 'number' && Number.isFinite(min));
      const validMax = max === undefined ||
        (typeof max === 'number' && Number.isFinite(max));
      if (!validMin) {
        errors.push(`${key}: min must be a finite number`);
      }
      if (!validMax) {
        errors.push(`${key}: max must be a finite number`);
      }
      if (
        step !== undefined &&
        (
          typeof step !== 'number' ||
          !Number.isFinite(step) ||
          step <= 0
        )
      ) {
        errors.push(`${key}: step must be a positive finite number`);
      }
      if (
        min !== undefined &&
        max !== undefined &&
        validMin &&
        validMax &&
        min > max
      ) {
        errors.push(`${key}: min cannot be greater than max`);
      }
    }
  }

  return errors;
}

/**
 * Validate options against a schema
 * @param {Object} options - Options object to validate
 * @param {OptionSchema} schema - Schema to validate against
 * @param {Object} defaults - Default values
 * @returns {ValidationResult}
 */
export function validateOptionsAgainstSchema(options, schema, defaults = {}) {
  const errors = [];
  const warnings = [];

  if (!isObjectRecord(options)) {
    return {
      valid: false,
      errors: ['Options must be an object'],
      warnings: []
    };
  }
  if (!isObjectRecord(defaults)) {
    return {
      valid: false,
      errors: ['Defaults must be an object'],
      warnings: []
    };
  }
  if (schema === undefined) {
    return { valid: true, errors: [], warnings: ['No schema provided'] };
  }
  if (!isObjectRecord(schema)) {
    return {
      valid: false,
      errors: ['Schema must be an object'],
      warnings: []
    };
  }
  const schemaErrors = validateOptionSchema(schema);
  if (schemaErrors.length > 0) {
    return {
      valid: false,
      errors: schemaErrors,
      warnings: []
    };
  }

  // Check for unknown options
  for (const key of Object.keys(options)) {
    if (!Object.hasOwn(schema, key)) {
      warnings.push(`Unknown option: ${key}`);
    }
  }

  // Validate each schema field
  for (const [key, def] of Object.entries(schema)) {
    const optionValue = Object.hasOwn(options, key)
      ? options[key]
      : undefined;
    const defaultValue = Object.hasOwn(defaults, key)
      ? defaults[key]
      : undefined;
    const value = optionValue ?? defaultValue;
    const label = Object.hasOwn(def, 'label')
      ? def.label
      : undefined;
    const type = Object.hasOwn(def, 'type')
      ? def.type
      : undefined;
    const optionValues = Object.hasOwn(def, 'options')
      ? def.options
      : undefined;
    const required = Object.hasOwn(def, 'required')
      ? def.required
      : undefined;
    const min = Object.hasOwn(def, 'min')
      ? def.min
      : undefined;
    const max = Object.hasOwn(def, 'max')
      ? def.max
      : undefined;
    const validator = Object.hasOwn(def, 'validate')
      ? def.validate
      : undefined;

    // Check required
    if (required && value === undefined) {
      errors.push(`${label || key} is required`);
      continue;
    }

    if (value === undefined) continue;

    // Type-specific validation
    switch (type) {
      case 'select':
        if (optionValues && !optionValues.some(o => o.value === value)) {
          errors.push(`${label || key}: invalid value`);
        }
        break;

      case 'checkbox':
        if (typeof value !== 'boolean') {
          errors.push(`${label || key}: must be boolean`);
        }
        break;

      case 'number':
      case 'range':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          errors.push(`${label || key}: must be a number`);
        } else {
          if (min !== undefined && value < min) {
            errors.push(`${label || key}: must be >= ${min}`);
          }
          if (max !== undefined && value > max) {
            errors.push(`${label || key}: must be <= ${max}`);
          }
        }
        break;

      case 'text':
        if (typeof value !== 'string') {
          errors.push(`${label || key}: must be a string`);
        }
        break;

      case 'multiselect':
        if (!Array.isArray(value)) {
          errors.push(`${label || key}: must be an array`);
        } else if (optionValues) {
          const validValues = new Set(optionValues.map(o => o.value));
          for (const v of value) {
            if (!validValues.has(v)) {
              errors.push(`${label || key}: invalid value`);
            }
          }
        }
        break;
    }

    // Custom validation
    if (typeof validator === 'function') {
      const customResult = validator.call(def, value, options);
      if (customResult !== true) {
        const validationMessage = (
          typeof customResult === 'string' &&
          customResult.length > 0
        ) ? customResult : 'validation failed';
        errors.push(`${label || key}: ${validationMessage}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Generate a unique analysis ID
 * @returns {string}
 */
export function generateAnalysisId() {
  return `analysis_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Create a default analysis config
 * @param {Object} overrides - Values to override defaults
 * @returns {AnalysisConfig}
 */
export function createDefaultConfig(overrides = {}) {
  return {
    id: generateAnalysisId(),
    type: 'comparison',
    pageIds: [],
    variables: [],
    transforms: [],
    plots: [],
    options: {},
    created: Date.now(),
    ...overrides
  };
}

/**
 * Deep merge options with defaults
 * @param {Object} defaults - Default values
 * @param {Object} overrides - Override values
 * @returns {Object} Merged options
 */
export function mergeOptions(defaults, overrides) {
  if (!isObjectRecord(defaults)) {
    throw new TypeError('Defaults must be an object');
  }
  if (!isObjectRecord(overrides)) {
    throw new TypeError('Overrides must be an object');
  }
  const result = { ...defaults };

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      const currentValue = Object.hasOwn(result, key)
        ? result[key]
        : undefined;
      if (typeof value === 'object' && value !== null && !Array.isArray(value) &&
          typeof currentValue === 'object' && currentValue !== null &&
          !Array.isArray(currentValue)) {
        setOwnDataProperty(
          result,
          key,
          mergeOptions(currentValue, value)
        );
      } else {
        setOwnDataProperty(result, key, value);
      }
    }
  }

  return result;
}

/**
 * Clone a config, generating a new ID
 * @param {AnalysisConfig} config - Config to clone
 * @returns {AnalysisConfig}
 */
export function cloneConfig(config) {
  return {
    ...JSON.parse(JSON.stringify(config)),
    id: generateAnalysisId(),
    created: Date.now(),
    modified: undefined
  };
}

/**
 * Create summary string for a config (for display/export)
 * @param {AnalysisConfig} config
 * @returns {string}
 */
export function summarizeConfig(config) {
  const parts = [];

  parts.push(`Type: ${config.type}`);
  parts.push(`Pages: ${config.pageIds.length}`);

  if (config.variables?.length) {
    parts.push(`Variables: ${config.variables.length}`);
  }

  if (config.transforms?.length) {
    const enabled = config.transforms.filter(t => t.enabled).length;
    parts.push(`Transforms: ${enabled}/${config.transforms.length}`);
  }

  return parts.join(' | ');
}

export default {
  validateAnalysisConfig,
  validateVariableSelection,
  validateTransformConfig,
  validatePlotConfig,
  validatePluginContract,
  validateOptionSchema,
  validateOptionsAgainstSchema,
  generateAnalysisId,
  createDefaultConfig,
  mergeOptions,
  cloneConfig,
  summarizeConfig
};
