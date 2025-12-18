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

  if (!plugin) {
    return { valid: false, errors: ['Plugin is null or undefined'], warnings: [] };
  }

  // Required fields for all plugins
  if (!plugin.id) {
    errors.push('Missing required field: id');
  } else if (!/^[a-z][a-z0-9_-]*$/.test(plugin.id)) {
    errors.push('id must be lowercase alphanumeric with hyphens/underscores, starting with a letter');
  }

  if (!plugin.name) {
    errors.push('Missing required field: name');
  }

  if (!plugin.supportedTypes) {
    errors.push('Missing required field: supportedTypes');
  } else if (!Array.isArray(plugin.supportedTypes)) {
    errors.push('supportedTypes must be an array');
  }

  // defaultOptions
  if (plugin.defaultOptions === undefined) {
    warnings.push('No defaultOptions defined');
  } else if (typeof plugin.defaultOptions !== 'object') {
    errors.push('defaultOptions must be an object');
  }

  // optionSchema
  if (plugin.optionSchema) {
    const schemaErrors = validateOptionSchema(plugin.optionSchema);
    schemaErrors.forEach(e => errors.push(`optionSchema: ${e}`));
  } else {
    warnings.push('No optionSchema defined - UI will use defaults');
  }

  // validate function
  if (plugin.validate && typeof plugin.validate !== 'function') {
    errors.push('validate must be a function');
  }

  // Type-specific validations
  switch (pluginType) {
    case 'plot':
      if (!plugin.render || typeof plugin.render !== 'function') {
        errors.push('Plot plugins must have a render function');
      }
      break;
    case 'transform':
      if (!plugin.execute || typeof plugin.execute !== 'function') {
        errors.push('Transform plugins must have an execute function');
      }
      break;
    case 'template':
      if (!plugin.requiredInputs) {
        errors.push('Template plugins must have requiredInputs');
      }
      break;
    case 'stat':
      if (!plugin.compute || typeof plugin.compute !== 'function') {
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

  if (typeof schema !== 'object') {
    return ['Schema must be an object'];
  }

  for (const [key, def] of Object.entries(schema)) {
    if (!def.type) {
      errors.push(`${key}: missing type`);
    } else if (!validTypes.includes(def.type)) {
      errors.push(`${key}: invalid type '${def.type}'`);
    }

    if (!def.label) {
      errors.push(`${key}: missing label`);
    }

    if (def.type === 'select' && (!def.options || !Array.isArray(def.options))) {
      errors.push(`${key}: select type requires options array`);
    }

    if ((def.type === 'number' || def.type === 'range')) {
      if (def.min !== undefined && typeof def.min !== 'number') {
        errors.push(`${key}: min must be a number`);
      }
      if (def.max !== undefined && typeof def.max !== 'number') {
        errors.push(`${key}: max must be a number`);
      }
      if (def.min !== undefined && def.max !== undefined && def.min > def.max) {
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

  if (!schema) {
    return { valid: true, errors: [], warnings: ['No schema provided'] };
  }

  // Check for unknown options
  for (const key of Object.keys(options)) {
    if (!schema[key]) {
      warnings.push(`Unknown option: ${key}`);
    }
  }

  // Validate each schema field
  for (const [key, def] of Object.entries(schema)) {
    const value = options[key] ?? defaults[key];

    // Check required
    if (def.required && value === undefined) {
      errors.push(`${def.label || key} is required`);
      continue;
    }

    if (value === undefined) continue;

    // Type-specific validation
    switch (def.type) {
      case 'select':
        if (def.options && !def.options.some(o => o.value === value)) {
          errors.push(`${def.label || key}: invalid value '${value}'`);
        }
        break;

      case 'checkbox':
        if (typeof value !== 'boolean') {
          errors.push(`${def.label || key}: must be boolean`);
        }
        break;

      case 'number':
      case 'range':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          errors.push(`${def.label || key}: must be a number`);
        } else {
          if (def.min !== undefined && value < def.min) {
            errors.push(`${def.label || key}: must be >= ${def.min}`);
          }
          if (def.max !== undefined && value > def.max) {
            errors.push(`${def.label || key}: must be <= ${def.max}`);
          }
        }
        break;

      case 'text':
        if (typeof value !== 'string') {
          errors.push(`${def.label || key}: must be a string`);
        }
        break;

      case 'multiselect':
        if (!Array.isArray(value)) {
          errors.push(`${def.label || key}: must be an array`);
        } else if (def.options) {
          const validValues = new Set(def.options.map(o => o.value));
          for (const v of value) {
            if (!validValues.has(v)) {
              errors.push(`${def.label || key}: invalid value '${v}'`);
            }
          }
        }
        break;
    }

    // Custom validation
    if (def.validate && typeof def.validate === 'function') {
      const customResult = def.validate(value, options);
      if (customResult !== true) {
        errors.push(`${def.label || key}: ${customResult || 'validation failed'}`);
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
  const result = { ...defaults };

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value) &&
          typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])) {
        result[key] = mergeOptions(result[key], value);
      } else {
        result[key] = value;
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
