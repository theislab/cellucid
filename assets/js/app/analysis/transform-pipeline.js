/**
 * Transform Pipeline for Page Analysis
 *
 * Provides chainable data transformations before plotting:
 * - Binning (continuous to categorical)
 * - Normalization (percentage, min-max, z-score)
 * - Log transforms
 * - Filtering
 * - Aggregation
 */

/**
 * @typedef {Object} TransformStep
 * @property {string} type - Transform type identifier
 * @property {Object} options - Transform-specific options
 */

/**
 * @typedef {Object} TransformedData
 * @property {(string|number)[]} values - Transformed values
 * @property {Object} metadata - Additional metadata about the transform
 */

/**
 * Built-in transform definitions
 */
const TRANSFORMS = {
  /**
   * Binning - convert continuous values to categorical bins
   */
  binning: {
    id: 'binning',
    name: 'Binning',
    description: 'Convert continuous values to categorical bins',
    applicableTo: ['continuous'],

    defaultOptions: {
      method: 'equal_width', // 'equal_width', 'quantile', 'custom'
      binCount: 5,
      labels: null, // auto-generated if null
      customBreaks: null // for custom method
    },

    apply(data, options = {}) {
      const { method = 'equal_width', binCount = 5, customBreaks, labels } = options;
      const values = data.values.filter(v => typeof v === 'number' && !Number.isNaN(v));

      if (values.length === 0) {
        return { values: data.values.map(() => 'No data'), metadata: { bins: [] } };
      }

      let breaks;
      if (method === 'custom' && customBreaks) {
        breaks = [...customBreaks].sort((a, b) => a - b);
      } else if (method === 'quantile') {
        breaks = this._quantileBreaks(values, binCount);
      } else {
        breaks = this._equalWidthBreaks(values, binCount);
      }

      // Generate bin labels
      const binLabels = labels || this._generateLabels(breaks);

      // Bin each value
      const binnedValues = data.values.map(v => {
        if (typeof v !== 'number' || Number.isNaN(v)) {
          return 'Missing';
        }
        for (let i = 0; i < breaks.length - 1; i++) {
          if (v >= breaks[i] && (i === breaks.length - 2 ? v <= breaks[i + 1] : v < breaks[i + 1])) {
            return binLabels[i];
          }
        }
        return binLabels[binLabels.length - 1];
      });

      return {
        values: binnedValues,
        metadata: {
          bins: breaks,
          labels: binLabels,
          kind: 'category' // Transform converts to categorical
        }
      };
    },

    _equalWidthBreaks(values, count) {
      const min = Math.min(...values);
      const max = Math.max(...values);
      const step = (max - min) / count;
      const breaks = [];
      for (let i = 0; i <= count; i++) {
        breaks.push(min + step * i);
      }
      return breaks;
    },

    _quantileBreaks(values, count) {
      const sorted = [...values].sort((a, b) => a - b);
      const breaks = [sorted[0]];
      for (let i = 1; i < count; i++) {
        const idx = Math.floor((i / count) * sorted.length);
        breaks.push(sorted[idx]);
      }
      breaks.push(sorted[sorted.length - 1]);
      return breaks;
    },

    _generateLabels(breaks) {
      const labels = [];
      const format = v => {
        if (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0)) {
          return v.toExponential(1);
        }
        return v.toFixed(2).replace(/\.?0+$/, '');
      };
      for (let i = 0; i < breaks.length - 1; i++) {
        labels.push(`${format(breaks[i])}-${format(breaks[i + 1])}`);
      }
      return labels;
    }
  },

  /**
   * Normalization transforms
   */
  normalize: {
    id: 'normalize',
    name: 'Normalize',
    description: 'Normalize values using various methods',
    applicableTo: ['continuous'],

    defaultOptions: {
      method: 'percentage' // 'percentage', 'minmax', 'zscore', 'sum_to_one'
    },

    apply(data, options = {}) {
      const { method = 'percentage' } = options;
      const values = [...data.values];

      switch (method) {
        case 'percentage':
          return this._percentage(values);
        case 'minmax':
          return this._minmax(values);
        case 'zscore':
          return this._zscore(values);
        case 'sum_to_one':
          return this._sumToOne(values);
        default:
          console.warn(`[Transform] Unknown normalize method: ${method}`);
          return { values, metadata: {} };
      }
    },

    _percentage(values) {
      const max = Math.max(...values.filter(v => typeof v === 'number' && !Number.isNaN(v)));
      if (max === 0) return { values, metadata: { max: 0 } };

      return {
        values: values.map(v => (typeof v === 'number' && !Number.isNaN(v)) ? (v / max) * 100 : v),
        metadata: { max, unit: '%' }
      };
    },

    _minmax(values) {
      const numericValues = values.filter(v => typeof v === 'number' && !Number.isNaN(v));
      const min = Math.min(...numericValues);
      const max = Math.max(...numericValues);
      const range = max - min;

      if (range === 0) return { values: values.map(v => typeof v === 'number' ? 0.5 : v), metadata: { min, max } };

      return {
        values: values.map(v => (typeof v === 'number' && !Number.isNaN(v)) ? (v - min) / range : v),
        metadata: { min, max, range }
      };
    },

    _zscore(values) {
      const numericValues = values.filter(v => typeof v === 'number' && !Number.isNaN(v));
      const mean = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
      const variance = numericValues.reduce((a, b) => a + (b - mean) ** 2, 0) / numericValues.length;
      const std = Math.sqrt(variance);

      if (std === 0) return { values: values.map(v => typeof v === 'number' ? 0 : v), metadata: { mean, std: 0 } };

      return {
        values: values.map(v => (typeof v === 'number' && !Number.isNaN(v)) ? (v - mean) / std : v),
        metadata: { mean, std }
      };
    },

    _sumToOne(values) {
      const sum = values.reduce((a, v) => a + (typeof v === 'number' && !Number.isNaN(v) ? v : 0), 0);
      if (sum === 0) return { values, metadata: { sum: 0 } };

      return {
        values: values.map(v => (typeof v === 'number' && !Number.isNaN(v)) ? v / sum : v),
        metadata: { sum }
      };
    }
  },

  /**
   * Log transform
   */
  log: {
    id: 'log',
    name: 'Log Transform',
    description: 'Apply logarithmic transformation',
    applicableTo: ['continuous'],

    defaultOptions: {
      method: 'log1p', // 'log1p', 'log2', 'log10', 'natural'
      pseudocount: 1 // added before log for zero handling
    },

    apply(data, options = {}) {
      const { method = 'log1p', pseudocount = 1 } = options;
      const values = [...data.values];

      const logFn = {
        log1p: v => Math.log1p(v),
        log2: v => Math.log2(v + pseudocount),
        log10: v => Math.log10(v + pseudocount),
        natural: v => Math.log(v + pseudocount)
      }[method] || (v => Math.log1p(v));

      return {
        values: values.map(v => {
          if (typeof v !== 'number' || Number.isNaN(v)) return v;
          if (v < 0) return NaN; // Log of negative undefined
          return logFn(v);
        }),
        metadata: { method, pseudocount }
      };
    }
  },

  /**
   * Filter transform
   */
  filter: {
    id: 'filter',
    name: 'Filter',
    description: 'Filter values based on criteria',
    applicableTo: ['continuous', 'category'],

    defaultOptions: {
      method: 'threshold', // 'threshold', 'outliers', 'topn', 'include', 'exclude'
      min: null,
      max: null,
      n: 10,
      includeValues: null,
      excludeValues: null
    },

    apply(data, options = {}, cellIndices = null) {
      const { method, min, max, n, includeValues, excludeValues } = options;
      const values = [...data.values];
      const indices = cellIndices || data.cellIndices || values.map((_, i) => i);

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

        case 'outliers':
          // Remove outliers using IQR method
          const numericVals = values.filter(v => typeof v === 'number' && !Number.isNaN(v));
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

        case 'topn':
          // Keep top N values
          const indexed = values.map((v, i) => ({ v, i }));
          indexed.sort((a, b) => (b.v || 0) - (a.v || 0));
          const topIndices = new Set(indexed.slice(0, n).map(x => x.i));
          mask = values.map((_, i) => topIndices.has(i));
          break;

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
        metadata: {
          originalCount: values.length,
          filteredCount: filteredValues.length,
          removedCount: values.length - filteredValues.length
        },
        cellIndices: filteredIndices
      };
    }
  },

  /**
   * Aggregation transform
   */
  aggregate: {
    id: 'aggregate',
    name: 'Aggregate',
    description: 'Aggregate values by group',
    applicableTo: ['continuous', 'category'],

    defaultOptions: {
      method: 'count', // 'count', 'mean', 'median', 'sum', 'min', 'max', 'std'
      groupBy: null // optional grouping variable
    },

    apply(data, options = {}) {
      const { method = 'count' } = options;
      const values = data.values;

      // If categorical, count occurrences
      if (data.variableInfo?.kind === 'category' || typeof values[0] === 'string') {
        const counts = {};
        for (const v of values) {
          counts[v] = (counts[v] || 0) + 1;
        }
        return {
          values: counts,
          metadata: { method: 'count', isAggregated: true }
        };
      }

      // Continuous aggregation
      const numericValues = values.filter(v => typeof v === 'number' && !Number.isNaN(v));
      if (numericValues.length === 0) {
        return { values: null, metadata: { method, isAggregated: true } };
      }

      let result;
      switch (method) {
        case 'count':
          result = numericValues.length;
          break;
        case 'sum':
          result = numericValues.reduce((a, b) => a + b, 0);
          break;
        case 'mean':
          result = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
          break;
        case 'median':
          const sorted = [...numericValues].sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          result = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
          break;
        case 'min':
          result = Math.min(...numericValues);
          break;
        case 'max':
          result = Math.max(...numericValues);
          break;
        case 'std':
          const mean = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
          const variance = numericValues.reduce((a, b) => a + (b - mean) ** 2, 0) / numericValues.length;
          result = Math.sqrt(variance);
          break;
        default:
          result = numericValues.length;
      }

      return {
        values: result,
        metadata: { method, isAggregated: true, count: numericValues.length }
      };
    }
  }
};

/**
 * Custom transform registry for external extensions
 */
const customTransforms = new Map();

/**
 * Transform Pipeline class
 */
export class TransformPipeline {
  constructor() {
    this.steps = [];
  }

  /**
   * Register a custom transform
   * @param {string} id - Transform identifier
   * @param {Object} transform - Transform definition
   */
  static registerTransform(id, transform) {
    customTransforms.set(id, transform);
  }

  /**
   * Get a transform by ID
   * @param {string} id - Transform identifier
   * @returns {Object|null}
   */
  static getTransform(id) {
    return TRANSFORMS[id] || customTransforms.get(id) || null;
  }

  /**
   * Get all available transforms
   * @returns {Object[]}
   */
  static getAllTransforms() {
    const all = Object.values(TRANSFORMS);
    for (const [, transform] of customTransforms) {
      all.push(transform);
    }
    return all;
  }

  /**
   * Add a transform step to the pipeline
   * @param {string} type - Transform type identifier
   * @param {Object} options - Transform options
   * @returns {TransformPipeline} - For chaining
   */
  add(type, options = {}) {
    const transform = TransformPipeline.getTransform(type);
    if (!transform) {
      console.warn(`[TransformPipeline] Unknown transform: ${type}`);
      return this;
    }

    this.steps.push({
      type,
      options: { ...transform.defaultOptions, ...options }
    });

    return this;
  }

  /**
   * Remove last transform step
   * @returns {TransformPipeline}
   */
  pop() {
    this.steps.pop();
    return this;
  }

  /**
   * Clear all steps
   * @returns {TransformPipeline}
   */
  clear() {
    this.steps = [];
    return this;
  }

  /**
   * Apply the pipeline to data
   * @param {Object} data - Input data object with values array
   * @returns {Object} - Transformed data
   */
  apply(data) {
    // Create a deep copy of the data to avoid mutating the original
    let current = {
      ...data,
      values: [...data.values],
      // Ensure cellIndices are also cloned to maintain correlation
      cellIndices: data.cellIndices ? [...data.cellIndices] : null,
      variableInfo: data.variableInfo ? { ...data.variableInfo } : null
    };
    let accumulatedMetadata = {};

    for (const step of this.steps) {
      const transform = TransformPipeline.getTransform(step.type);
      if (!transform) continue;

      const result = transform.apply(current, step.options, current.cellIndices);

      // Merge result into current data
      current.values = result.values;
      if (result.cellIndices !== undefined) {
        current.cellIndices = result.cellIndices;
      }
      // Update cellCount if values array length changed (e.g., after filtering)
      if (Array.isArray(result.values)) {
        current.cellCount = result.values.length;
      }
      if (result.metadata) {
        accumulatedMetadata = { ...accumulatedMetadata, ...result.metadata };
        // Update variable info if transform changed the kind
        if (result.metadata.kind) {
          current.variableInfo = {
            ...current.variableInfo,
            kind: result.metadata.kind
          };
        }
      }
    }

    current.transformMetadata = accumulatedMetadata;
    return current;
  }

  /**
   * Serialize pipeline to config object
   * @returns {TransformStep[]}
   */
  toConfig() {
    return this.steps.map(step => ({ ...step }));
  }

  /**
   * Create pipeline from config
   * @param {TransformStep[]} config
   * @returns {TransformPipeline}
   */
  static fromConfig(config) {
    const pipeline = new TransformPipeline();
    if (Array.isArray(config)) {
      for (const step of config) {
        pipeline.add(step.type, step.options);
      }
    }
    return pipeline;
  }

  /**
   * Clone the pipeline
   * @returns {TransformPipeline}
   */
  clone() {
    return TransformPipeline.fromConfig(this.toConfig());
  }
}

/**
 * Create a new transform pipeline
 * @returns {TransformPipeline}
 */
export function createTransformPipeline() {
  return new TransformPipeline();
}

export { TRANSFORMS };
