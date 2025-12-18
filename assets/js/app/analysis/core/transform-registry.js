/**
 * Transform Registry
 *
 * This module provides:
 * - Built-in transform definitions (log1p, zscore, minmax, etc.)
 * - UI generation helpers (generateOptionsUI, parseOptionsFromForm)
 * - Registration of built-in transforms with the unified TransformPluginRegistry
 *
 * NOTE: The canonical TransformPluginRegistry is in plugin-contract.js.
 * This module registers transforms with that registry and provides UI utilities.
 */

import { getTransformRegistry as getUnifiedRegistry } from './plugin-contract.js';
import { getFiniteMinMax } from '../shared/number-utils.js';

// =============================================================================
// BUILT-IN TRANSFORM DEFINITIONS
// =============================================================================

/**
 * Built-in transform definitions
 * These are registered with the unified TransformPluginRegistry on init
 */
const BUILTIN_TRANSFORMS = [
  // Log1p Transform
  {
    id: 'log1p',
    name: 'Log1p',
    description: 'Apply log(1 + x) transformation, useful for count data',
    supportedTypes: ['continuous', 'gene_expression'],
    gpuMethod: 'log1pTransform',
    workerMethod: null,

    defaultOptions: {},
    optionSchema: {},

    validate(data) {
      if (!data.values || data.values.length === 0) {
        return { valid: false, errors: ['No values to transform'] };
      }
      return { valid: true, errors: [] };
    },

    async execute(data, options, context) {
      const { backend, registry } = context;
      const values = data.values;

      const numericIndices = [];
      const numericValues = [];
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
          numericIndices.push(i);
          numericValues.push(v);
        }
      }

      let transformed;
      if (backend === 'gpu' && registry.isGPUAvailable()) {
        const gpu = registry.getGPU();
        const input = new Float32Array(numericValues);
        transformed = gpu.log1pTransform(input);
      } else {
        transformed = new Float32Array(numericValues.length);
        for (let i = 0; i < numericValues.length; i++) {
          transformed[i] = Math.log1p(numericValues[i]);
        }
      }

      const result = Array.from(values);
      for (let i = 0; i < numericIndices.length; i++) {
        result[numericIndices[i]] = transformed[i];
      }

      return {
        values: result,
        metadata: { transform: 'log1p', gpuAccelerated: backend === 'gpu' }
      };
    }
  },

  // Z-Score Normalization
  {
    id: 'zscore',
    name: 'Z-Score',
    description: 'Standardize to mean=0, std=1',
    supportedTypes: ['continuous', 'gene_expression'],
    gpuMethod: 'zScoreNormalize',
    workerMethod: 'COMPUTE_ZSCORE',

    defaultOptions: {
      useGlobalStats: false
    },

    optionSchema: {
      useGlobalStats: {
        type: 'checkbox',
        label: 'Use global statistics',
        description: 'Use pre-computed mean/std instead of per-page'
      }
    },

    validate(data) {
      if (!data.values || data.values.length === 0) {
        return { valid: false, errors: ['No values to transform'] };
      }
      return { valid: true, errors: [] };
    },

    async execute(data, options, context) {
      const { backend, registry } = context;
      const values = data.values;

      const numericValues = [];
      const numericIndices = [];
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (typeof v === 'number' && Number.isFinite(v)) {
          numericIndices.push(i);
          numericValues.push(v);
        }
      }

      if (numericValues.length === 0) {
        return { values: [...values], metadata: { transform: 'zscore', skipped: true } };
      }

      const mean = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
      const variance = numericValues.reduce((a, b) => a + (b - mean) ** 2, 0) / numericValues.length;
      const std = Math.sqrt(variance);

      if (std === 0) {
        const result = values.map(v => typeof v === 'number' && Number.isFinite(v) ? 0 : v);
        return { values: result, metadata: { transform: 'zscore', mean, std: 0 } };
      }

      let transformed;
      if (backend === 'gpu' && registry.isGPUAvailable()) {
        const gpu = registry.getGPU();
        const input = new Float32Array(numericValues);
        transformed = gpu.zScoreNormalize(input, mean, std);
      } else {
        transformed = new Float32Array(numericValues.length);
        for (let i = 0; i < numericValues.length; i++) {
          transformed[i] = (numericValues[i] - mean) / std;
        }
      }

      const result = Array.from(values);
      for (let i = 0; i < numericIndices.length; i++) {
        result[numericIndices[i]] = transformed[i];
      }

      return {
        values: result,
        metadata: { transform: 'zscore', mean, std, gpuAccelerated: backend === 'gpu' }
      };
    }
  },

  // Min-Max Normalization
  {
    id: 'minmax',
    name: 'Min-Max',
    description: 'Scale values to [0, 1] range',
    supportedTypes: ['continuous', 'gene_expression'],
    gpuMethod: 'minMaxNormalize',

    defaultOptions: {
      targetMin: 0,
      targetMax: 1
    },

    optionSchema: {
      targetMin: {
        type: 'number',
        label: 'Target minimum',
        default: 0,
        min: -1000,
        max: 1000
      },
      targetMax: {
        type: 'number',
        label: 'Target maximum',
        default: 1,
        min: -1000,
        max: 1000
      }
    },

    validate(data, options) {
      if (!data.values || data.values.length === 0) {
        return { valid: false, errors: ['No values to transform'] };
      }
      if (options.targetMin >= options.targetMax) {
        return { valid: false, errors: ['Target min must be less than target max'] };
      }
      return { valid: true, errors: [] };
    },

    async execute(data, options, context) {
      const { backend, registry } = context;
      const { targetMin, targetMax } = options;
      const values = data.values;

      const numericValues = [];
      const numericIndices = [];
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (typeof v === 'number' && Number.isFinite(v)) {
          numericIndices.push(i);
          numericValues.push(v);
        }
      }

      if (numericValues.length === 0) {
        return { values: [...values], metadata: { transform: 'minmax', skipped: true } };
      }

      let dataMin = Infinity, dataMax = -Infinity;
      for (const v of numericValues) {
        if (v < dataMin) dataMin = v;
        if (v > dataMax) dataMax = v;
      }

      const dataRange = dataMax - dataMin;
      const targetRange = targetMax - targetMin;

      if (dataRange === 0) {
        const midpoint = (targetMin + targetMax) / 2;
        const result = values.map(v => typeof v === 'number' && Number.isFinite(v) ? midpoint : v);
        return { values: result, metadata: { transform: 'minmax', dataMin, dataMax, dataRange: 0 } };
      }

      let transformed;
      if (backend === 'gpu' && registry.isGPUAvailable() && targetMin === 0 && targetMax === 1) {
        const gpu = registry.getGPU();
        const input = new Float32Array(numericValues);
        transformed = gpu.minMaxNormalize(input, dataMin, dataMax);
      } else {
        transformed = new Float32Array(numericValues.length);
        for (let i = 0; i < numericValues.length; i++) {
          const normalized = (numericValues[i] - dataMin) / dataRange;
          transformed[i] = targetMin + normalized * targetRange;
        }
      }

      const result = Array.from(values);
      for (let i = 0; i < numericIndices.length; i++) {
        result[numericIndices[i]] = transformed[i];
      }

      return {
        values: result,
        metadata: {
          transform: 'minmax',
          dataMin,
          dataMax,
          targetMin,
          targetMax,
          gpuAccelerated: backend === 'gpu'
        }
      };
    }
  },

  // Clamp Transform
  {
    id: 'clamp',
    name: 'Clamp',
    description: 'Clamp values to a specified range',
    supportedTypes: ['continuous', 'gene_expression'],
    gpuMethod: 'clamp',

    defaultOptions: {
      min: null,
      max: null
    },

    optionSchema: {
      min: {
        type: 'number',
        label: 'Minimum',
        description: 'Lower bound (leave empty for no minimum)'
      },
      max: {
        type: 'number',
        label: 'Maximum',
        description: 'Upper bound (leave empty for no maximum)'
      }
    },

    validate(data, options) {
      if (!data.values || data.values.length === 0) {
        return { valid: false, errors: ['No values to transform'] };
      }
      if (options.min !== null && options.max !== null && options.min > options.max) {
        return { valid: false, errors: ['Min must be less than or equal to max'] };
      }
      return { valid: true, errors: [] };
    },

    async execute(data, options, context) {
      const { backend, registry } = context;
      let { min, max } = options;
      const values = data.values;

      const numericValues = [];
      const numericIndices = [];
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (typeof v === 'number' && Number.isFinite(v)) {
          numericIndices.push(i);
          numericValues.push(v);
        }
      }

      if (numericValues.length === 0 || (min === null && max === null)) {
        return { values: [...values], metadata: { transform: 'clamp', skipped: true } };
      }

      if (min === null) min = -Infinity;
      if (max === null) max = Infinity;

      let transformed;
      if (backend === 'gpu' && registry.isGPUAvailable() && Number.isFinite(min) && Number.isFinite(max)) {
        const gpu = registry.getGPU();
        const input = new Float32Array(numericValues);
        transformed = gpu.clamp(input, min, max);
      } else {
        transformed = new Float32Array(numericValues.length);
        for (let i = 0; i < numericValues.length; i++) {
          transformed[i] = Math.max(min, Math.min(max, numericValues[i]));
        }
      }

      const result = Array.from(values);
      for (let i = 0; i < numericIndices.length; i++) {
        result[numericIndices[i]] = transformed[i];
      }

      return {
        values: result,
        metadata: { transform: 'clamp', min, max, gpuAccelerated: backend === 'gpu' }
      };
    }
  },

  // Scale Transform
  {
    id: 'scale',
    name: 'Scale',
    description: 'Multiply values by a factor and add offset',
    supportedTypes: ['continuous', 'gene_expression'],
    gpuMethod: 'scaleAndOffset',

    defaultOptions: {
      factor: 1,
      offset: 0
    },

    optionSchema: {
      factor: {
        type: 'number',
        label: 'Scale factor',
        default: 1,
        step: 0.1
      },
      offset: {
        type: 'number',
        label: 'Offset',
        default: 0,
        step: 0.1
      }
    },

    validate(data) {
      if (!data.values || data.values.length === 0) {
        return { valid: false, errors: ['No values to transform'] };
      }
      return { valid: true, errors: [] };
    },

    async execute(data, options, context) {
      const { backend, registry } = context;
      const { factor, offset } = options;
      const values = data.values;

      const numericValues = [];
      const numericIndices = [];
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (typeof v === 'number' && Number.isFinite(v)) {
          numericIndices.push(i);
          numericValues.push(v);
        }
      }

      if (numericValues.length === 0) {
        return { values: [...values], metadata: { transform: 'scale', skipped: true } };
      }

      let transformed;
      if (backend === 'gpu' && registry.isGPUAvailable()) {
        const gpu = registry.getGPU();
        const input = new Float32Array(numericValues);
        transformed = gpu.scaleAndOffset(input, factor, offset);
      } else {
        transformed = new Float32Array(numericValues.length);
        for (let i = 0; i < numericValues.length; i++) {
          transformed[i] = numericValues[i] * factor + offset;
        }
      }

      const result = Array.from(values);
      for (let i = 0; i < numericIndices.length; i++) {
        result[numericIndices[i]] = transformed[i];
      }

      return {
        values: result,
        metadata: { transform: 'scale', factor, offset, gpuAccelerated: backend === 'gpu' }
      };
    }
  },

  // Binning Transform
  {
    id: 'binning',
    name: 'Binning',
    description: 'Convert continuous values to categorical bins',
    supportedTypes: ['continuous', 'gene_expression'],
    gpuMethod: null,
    workerMethod: 'BIN_VALUES',

    defaultOptions: {
      method: 'equal_width',
      binCount: 5,
      labels: null,
      customBreaks: null
    },

    optionSchema: {
      method: {
        type: 'select',
        label: 'Method',
        options: [
          { value: 'equal_width', label: 'Equal Width' },
          { value: 'quantile', label: 'Quantile' },
          { value: 'custom', label: 'Custom Breaks' }
        ]
      },
      binCount: {
        type: 'number',
        label: 'Number of bins',
        default: 5,
        min: 2,
        max: 50,
        showWhen: (opts) => opts.method !== 'custom'
      },
      customBreaks: {
        type: 'text',
        label: 'Custom breaks (comma-separated)',
        description: 'e.g., 0, 1, 5, 10, 100',
        showWhen: (opts) => opts.method === 'custom'
      }
    },

    validate(data, options) {
      if (!data.values || data.values.length === 0) {
        return { valid: false, errors: ['No values to transform'] };
      }
      if (options.method === 'custom' && !options.customBreaks) {
        return { valid: false, errors: ['Custom breaks are required for custom method'] };
      }
      return { valid: true, errors: [] };
    },

    async execute(data, options) {
      const { method, binCount, customBreaks, labels: customLabels } = options;
      const values = data.values;

      const numericValues = values.filter(v => typeof v === 'number' && Number.isFinite(v));

      if (numericValues.length === 0) {
        return {
          values: values.map(() => 'No data'),
          metadata: { transform: 'binning', bins: [] }
        };
      }

      let breaks;
      if (method === 'custom' && customBreaks) {
        if (typeof customBreaks === 'string') {
          breaks = customBreaks.split(',').map(s => parseFloat(s.trim())).filter(n => Number.isFinite(n));
        } else {
          breaks = [...customBreaks];
        }
        breaks.sort((a, b) => a - b);
      } else if (method === 'quantile') {
        const sorted = [...numericValues].sort((a, b) => a - b);
        breaks = [sorted[0]];
        for (let i = 1; i < binCount; i++) {
          const idx = Math.floor((i / binCount) * sorted.length);
          breaks.push(sorted[idx]);
        }
        breaks.push(sorted[sorted.length - 1]);
      } else {
        const { min, max } = getFiniteMinMax(numericValues);
        const step = (max - min) / binCount;
        breaks = [];
        for (let i = 0; i <= binCount; i++) {
          breaks.push(min + step * i);
        }
      }

      const formatValue = v => {
        if (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0)) {
          return v.toExponential(1);
        }
        return v.toFixed(2).replace(/\.?0+$/, '');
      };

      const labels = customLabels || [];
      if (labels.length === 0) {
        for (let i = 0; i < breaks.length - 1; i++) {
          labels.push(`${formatValue(breaks[i])}-${formatValue(breaks[i + 1])}`);
        }
      }

      const binnedValues = values.map(v => {
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          return 'Missing';
        }
        for (let i = 0; i < breaks.length - 1; i++) {
          const isLast = i === breaks.length - 2;
          if (v >= breaks[i] && (isLast ? v <= breaks[i + 1] : v < breaks[i + 1])) {
            return labels[i];
          }
        }
        return labels[labels.length - 1];
      });

      return {
        values: binnedValues,
        metadata: {
          transform: 'binning',
          method,
          bins: breaks,
          labels,
          kind: 'category'
        }
      };
    }
  },

  // Percentage Transform
  {
    id: 'percentage',
    name: 'Percentage',
    description: 'Convert to percentage of maximum value',
    supportedTypes: ['continuous', 'gene_expression'],

    defaultOptions: {
      relativeTo: 'max'
    },

    optionSchema: {
      relativeTo: {
        type: 'select',
        label: 'Relative to',
        options: [
          { value: 'max', label: 'Maximum' },
          { value: 'sum', label: 'Sum' },
          { value: 'value', label: 'Custom value' }
        ]
      },
      customValue: {
        type: 'number',
        label: 'Custom value',
        showWhen: (opts) => opts.relativeTo === 'value'
      }
    },

    validate(data) {
      if (!data.values || data.values.length === 0) {
        return { valid: false, errors: ['No values to transform'] };
      }
      return { valid: true, errors: [] };
    },

    async execute(data, options) {
      const { relativeTo, customValue } = options;
      const values = data.values;

      const numericValues = values.filter(v => typeof v === 'number' && Number.isFinite(v));

      if (numericValues.length === 0) {
        return { values: [...values], metadata: { transform: 'percentage', skipped: true } };
      }

      let divisor;
      switch (relativeTo) {
        case 'sum':
          divisor = numericValues.reduce((a, b) => a + b, 0);
          break;
        case 'value':
          divisor = Number.isFinite(customValue) ? customValue : 1;
          break;
        default:
          divisor = getFiniteMinMax(numericValues).max;
      }

      if (divisor === 0) {
        return { values: [...values], metadata: { transform: 'percentage', divisor: 0 } };
      }

      const result = values.map(v => {
        if (typeof v === 'number' && Number.isFinite(v)) {
          return (v / divisor) * 100;
        }
        return v;
      });

      return {
        values: result,
        metadata: { transform: 'percentage', relativeTo, divisor, unit: '%' }
      };
    }
  },

  // Filter Transform
  {
    id: 'filter',
    name: 'Filter',
    description: 'Filter values based on criteria',
    supportedTypes: ['continuous', 'categorical', 'gene_expression', 'any'],

    defaultOptions: {
      method: 'threshold',
      min: null,
      max: null,
      includeValues: null,
      excludeValues: null,
      removeOutliers: false
    },

    optionSchema: {
      method: {
        type: 'select',
        label: 'Method',
        options: [
          { value: 'threshold', label: 'Threshold' },
          { value: 'outliers', label: 'Remove Outliers' },
          { value: 'include', label: 'Include Values' },
          { value: 'exclude', label: 'Exclude Values' }
        ]
      },
      min: {
        type: 'number',
        label: 'Minimum',
        showWhen: (opts) => opts.method === 'threshold'
      },
      max: {
        type: 'number',
        label: 'Maximum',
        showWhen: (opts) => opts.method === 'threshold'
      }
    },

    validate(data) {
      if (!data.values || data.values.length === 0) {
        return { valid: false, errors: ['No values to filter'] };
      }
      return { valid: true, errors: [] };
    },

    async execute(data, options) {
      const { method, min, max, includeValues, excludeValues } = options;
      const values = [...data.values];
      const indices = data.cellIndices || values.map((_, i) => i);

      let mask;
      switch (method) {
        case 'threshold':
          mask = values.map(v => {
            if (typeof v !== 'number') return true;
            if (min !== null && v < min) return false;
            if (max !== null && v > max) return false;
            return true;
          });
          break;

        case 'outliers': {
          const numericVals = values.filter(v => typeof v === 'number' && Number.isFinite(v));
          const sorted = [...numericVals].sort((a, b) => a - b);
          const q1 = sorted[Math.floor(sorted.length * 0.25)];
          const q3 = sorted[Math.floor(sorted.length * 0.75)];
          const iqr = q3 - q1;
          const lowerBound = q1 - 1.5 * iqr;
          const upperBound = q3 + 1.5 * iqr;
          mask = values.map(v => {
            if (typeof v !== 'number') return true;
            return v >= lowerBound && v <= upperBound;
          });
          break;
        }

        case 'include':
          if (!includeValues) {
            mask = values.map(() => true);
          } else {
            const includeSet = new Set(includeValues);
            mask = values.map(v => includeSet.has(v));
          }
          break;

        case 'exclude':
          if (!excludeValues) {
            mask = values.map(() => true);
          } else {
            const excludeSet = new Set(excludeValues);
            mask = values.map(v => !excludeSet.has(v));
          }
          break;

        default:
          mask = values.map(() => true);
      }

      const filteredValues = [];
      const filteredIndices = [];
      for (let i = 0; i < values.length; i++) {
        if (mask[i]) {
          filteredValues.push(values[i]);
          filteredIndices.push(indices[i]);
        }
      }

      return {
        values: filteredValues,
        cellIndices: filteredIndices,
        metadata: {
          transform: 'filter',
          method,
          originalCount: values.length,
          filteredCount: filteredValues.length,
          removedCount: values.length - filteredValues.length
        }
      };
    }
  }
];

// =============================================================================
// UI GENERATION FROM SCHEMA
// =============================================================================

/**
 * Generate form HTML from an option schema
 * @param {Object} schema - Option schema
 * @param {Object} values - Current option values
 * @param {string} prefix - Input name prefix
 * @returns {string} HTML string
 */
export function generateOptionsUI(schema, values = {}, prefix = 'opt') {
  if (!schema || typeof schema !== 'object') return '';

  const html = [];

  for (const [key, def] of Object.entries(schema)) {
    const id = `${prefix}-${key}`;
    const value = values[key] ?? def.default;
    const showCondition = def.showWhen ? `data-show-when="${key}"` : '';

    html.push(`<div class="form-group" ${showCondition}>`);
    html.push(`<label for="${id}">${def.label || key}</label>`);

    switch (def.type) {
      case 'select':
        html.push(`<select id="${id}" name="${id}" data-key="${key}">`);
        for (const opt of (def.options || [])) {
          const selected = opt.value === value ? 'selected' : '';
          html.push(`<option value="${opt.value}" ${selected}>${opt.label}</option>`);
        }
        html.push('</select>');
        break;

      case 'checkbox': {
        const checked = value ? 'checked' : '';
        html.push(`<input type="checkbox" id="${id}" name="${id}" data-key="${key}" ${checked}>`);
        break;
      }

      case 'number': {
        const minAttr = def.min !== undefined ? `min="${def.min}"` : '';
        const maxAttr = def.max !== undefined ? `max="${def.max}"` : '';
        const step = def.step !== undefined ? `step="${def.step}"` : '';
        html.push(`<input type="number" id="${id}" name="${id}" data-key="${key}" value="${value || ''}" ${minAttr} ${maxAttr} ${step}>`);
        break;
      }

      case 'range':
        html.push(`<input type="range" id="${id}" name="${id}" data-key="${key}" value="${value || 0}" min="${def.min || 0}" max="${def.max || 100}" step="${def.step || 1}">`);
        html.push(`<span class="range-value">${value}</span>`);
        break;

      case 'text':
        html.push(`<input type="text" id="${id}" name="${id}" data-key="${key}" value="${value || ''}">`);
        break;

      case 'color':
        html.push(`<input type="color" id="${id}" name="${id}" data-key="${key}" value="${value || '#000000'}">`);
        break;

      case 'multiselect': {
        html.push(`<select id="${id}" name="${id}" data-key="${key}" multiple>`);
        const selectedValues = new Set(value || []);
        for (const opt of (def.options || [])) {
          const selected = selectedValues.has(opt.value) ? 'selected' : '';
          html.push(`<option value="${opt.value}" ${selected}>${opt.label}</option>`);
        }
        html.push('</select>');
        break;
      }
    }

    if (def.description) {
      html.push(`<small class="form-help">${def.description}</small>`);
    }

    html.push('</div>');
  }

  return html.join('\n');
}

/**
 * Parse form values from a form element
 * @param {HTMLFormElement} form - Form element
 * @param {Object} schema - Option schema
 * @returns {Object} Parsed values
 */
export function parseOptionsFromForm(form, schema) {
  const values = {};

  for (const [key, def] of Object.entries(schema)) {
    const input = form.querySelector(`[data-key="${key}"]`);
    if (!input) continue;

    switch (def.type) {
      case 'checkbox':
        values[key] = input.checked;
        break;
      case 'number':
      case 'range':
        values[key] = input.value !== '' ? parseFloat(input.value) : null;
        break;
      case 'multiselect':
        values[key] = Array.from(input.selectedOptions).map(o => o.value);
        break;
      default:
        values[key] = input.value;
    }
  }

  return values;
}

// =============================================================================
// REGISTRATION & EXPORTS
// =============================================================================

let _builtinsRegistered = false;

/**
 * Register built-in transforms with the unified registry
 * Called automatically on first use
 */
export function registerBuiltinTransforms() {
  if (_builtinsRegistered) return;

  const registry = getUnifiedRegistry();

  for (const transform of BUILTIN_TRANSFORMS) {
    registry.register(transform);
  }

  _builtinsRegistered = true;
  console.log(`[TransformRegistry] Registered ${BUILTIN_TRANSFORMS.length} built-in transforms`);
}

/**
 * Get the unified TransformRegistry instance
 * @returns {import('./plugin-contract.js').TransformPluginRegistry}
 */
export function getTransformRegistry() {
  const registry = getUnifiedRegistry();

  // Register built-ins on first access
  if (!_builtinsRegistered) {
    registerBuiltinTransforms();
  }

  return registry;
}

/**
 * Initialize the transform registry (call before using)
 * @returns {Promise<import('./plugin-contract.js').TransformPluginRegistry>}
 */
export async function initTransformRegistry() {
  const registry = getUnifiedRegistry();

  // Initialize the registry (checks GPU/Worker availability)
  await registry.init();

  // Register built-in transforms
  registerBuiltinTransforms();

  return registry;
}

// Export the built-in transforms for reference
export { BUILTIN_TRANSFORMS };

export default {
  getTransformRegistry,
  initTransformRegistry,
  registerBuiltinTransforms,
  generateOptionsUI,
  parseOptionsFromForm,
  BUILTIN_TRANSFORMS
};
