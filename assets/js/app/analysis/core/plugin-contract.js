/**
 * Unified Plugin Contract System
 *
 * Standardizes plugin registration, validation, and lifecycle across all
 * plugin types: plots, transforms, and statistical tests.
 *
 * This module provides:
 * - A common base registry class for all plugin types
 * - Runtime validation at registration time
 * - Consistent API across plugin types
 * - UI generation from option schemas
 * - Plugin discovery and introspection
 */

import {
  validatePluginContract,
  validateOptionsAgainstSchema,
  mergeOptions
} from './analysis-types.js';
import { filterFiniteNumbers, getFiniteMinMax, mean } from '../shared/number-utils.js';
import { debug, debugWarn, debugError } from '../shared/debug-utils.js';
import { getPlotTheme } from '../shared/plot-theme.js';
import { getPageColor, PAGE_COLORS } from '../../utils/page-colors.js';

// Re-export validation functions for index.js
export { validatePluginContract, validateOptionsAgainstSchema, mergeOptions };

// =============================================================================
// BASE REGISTRY CLASS
// =============================================================================

/**
 * Base registry class for all plugin types
 * @template T The plugin type
 */
export class BasePluginRegistry {
   /**
   * @param {Object} options
   * @param {string} options.name - Registry name for logging
   * @param {string} options.pluginType - Plugin type for validation ('plot' | 'transform' | 'stat')
   * @param {string[]} [options.requiredMethods] - Method names that plugins must implement
   */
  constructor(options) {
    this._name = options.name || 'PluginRegistry';
    this._pluginType = options.pluginType || 'plugin';
    this._requiredMethods = options.requiredMethods || [];
    this._plugins = new Map();
    this._initialized = false;
    this._eventHandlers = new Map();
  }

  /**
   * Initialize the registry
   */
  async init() {
    if (this._initialized) return;
    this._initialized = true;
    this._emit('init');
  }

  /**
   * Register a plugin
   * @param {Object} plugin - Plugin definition
   * @returns {boolean} True if registered successfully
   */
  register(plugin) {
    // Validate plugin contract
    const validation = validatePluginContract(plugin, this._pluginType);

    if (!validation.valid) {
      debugError(this._name, `Failed to register '${plugin?.id}':`, validation.errors);
      return false;
    }

    if (validation.warnings.length > 0) {
      debugWarn(this._name, `Warnings for '${plugin.id}':`, validation.warnings);
    }

    // Check required methods
    for (const method of this._requiredMethods) {
      if (typeof plugin[method] !== 'function') {
        debugError(this._name, `Plugin '${plugin.id}' missing required method: ${method}`);
        return false;
      }
    }

    // Check for duplicate
    if (this._plugins.has(plugin.id)) {
      debugWarn(this._name, `Overwriting existing plugin: ${plugin.id}`);
    }

    // Normalize plugin
    const normalized = this._normalizePlugin(plugin);

    // Store plugin
    this._plugins.set(plugin.id, normalized);

    this._emit('register', { plugin: normalized });

    return true;
  }

  /**
   * Normalize a plugin definition (override in subclasses)
   * @param {Object} plugin
   * @returns {Object}
   */
  _normalizePlugin(plugin) {
    return {
      ...plugin,
      defaultOptions: plugin.defaultOptions || {},
      optionSchema: plugin.optionSchema || {},
      supportedTypes: plugin.supportedTypes || ['any']
    };
  }

  /**
   * Unregister a plugin
   * @param {string} id - Plugin ID
   * @returns {boolean} True if plugin was removed
   */
  unregister(id) {
    const existed = this._plugins.has(id);
    this._plugins.delete(id);
    if (existed) {
      this._emit('unregister', { id });
    }
    return existed;
  }

  /**
   * Remove all registered plugins
   * @returns {number} Number of plugins removed
   */
  clear() {
    const count = this._plugins.size;
    if (count === 0) return 0;
    this._plugins.clear();
    this._emit('clear', { count });
    return count;
  }

  /**
   * Get a plugin by ID
   * @param {string} id - Plugin ID
   * @returns {Object|null}
   */
  get(id) {
    return this._plugins.get(id) || null;
  }

  /**
   * Check if plugin exists
   * @param {string} id - Plugin ID
   * @returns {boolean}
   */
  has(id) {
    return this._plugins.has(id);
  }

  /**
   * Get all registered plugins
   * @returns {Object[]}
   */
  getAll() {
    return Array.from(this._plugins.values());
  }

  /**
   * Get plugins that support a specific data type
   * @param {string} dataType - Data type to filter by
   * @returns {Object[]}
   */
  getForType(dataType) {
    return this.getAll().filter(p =>
      p.supportedTypes.includes(dataType) || p.supportedTypes.includes('any')
    );
  }

  /**
   * Get list of plugin IDs
   * @returns {string[]}
   */
  getIds() {
    return Array.from(this._plugins.keys());
  }

  /**
   * Validate options for a plugin
   * @param {string} id - Plugin ID
   * @param {Object} options - Options to validate
   * @returns {ValidationResult}
   */
  validateOptions(id, options) {
    const plugin = this.get(id);
    if (!plugin) {
      return { valid: false, errors: [`Unknown plugin: ${id}`], warnings: [] };
    }

    return validateOptionsAgainstSchema(
      options,
      plugin.optionSchema,
      plugin.defaultOptions
    );
  }

  /**
   * Get merged options with defaults
   * @param {string} id - Plugin ID
   * @param {Object} options - User options
   * @returns {Object} Merged options
   */
  getOptions(id, options = {}) {
    const plugin = this.get(id);
    if (!plugin) return options;

    return mergeOptions(plugin.defaultOptions, options);
  }

  /**
   * Add event handler
   * @param {string} event - Event name
   * @param {Function} handler - Handler function
   */
  on(event, handler) {
    if (!this._eventHandlers.has(event)) {
      this._eventHandlers.set(event, []);
    }
    this._eventHandlers.get(event).push(handler);
  }

  /**
   * Remove event handler
   * @param {string} event - Event name
   * @param {Function} handler - Handler function
   */
  off(event, handler) {
    const handlers = this._eventHandlers.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }

  /**
   * Emit an event
   * @param {string} event - Event name
   * @param {Object} [data] - Event data
   */
  _emit(event, data = {}) {
    const handlers = this._eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (e) {
          debugError(this._name, 'Event handler error:', e);
        }
      }
    }
  }

  /**
   * Get registry stats
   * @returns {Object}
   */
  getStats() {
    const byType = {};
    for (const plugin of this._plugins.values()) {
      for (const type of plugin.supportedTypes) {
        byType[type] = (byType[type] || 0) + 1;
      }
    }

    return {
      name: this._name,
      pluginType: this._pluginType,
      count: this._plugins.size,
      byType,
      initialized: this._initialized
    };
  }
}

// =============================================================================
// SPECIALIZED REGISTRIES
// =============================================================================

/**
 * Plot Plugin Registry
 */
export class PlotPluginRegistry extends BasePluginRegistry {
  constructor() {
    super({
      name: 'PlotRegistry',
      pluginType: 'plot',
      requiredMethods: ['render']
    });
  }

  _normalizePlugin(plugin) {
    const normalized = super._normalizePlugin(plugin);

    // Add plot-specific defaults
    normalized.supportedLayouts = plugin.supportedLayouts || ['single'];

    // Ensure update method exists (default to re-render)
    if (!normalized.update) {
      normalized.update = function(figure, pageData, options, layoutEngine) {
        return this.render(pageData, options, figure, layoutEngine);
      };
    }

    // Ensure exportCSV method exists (default implementation)
    if (!normalized.exportCSV) {
      normalized.exportCSV = function(pageData, options) {
        // Default: export raw values
        const rows = [];
        for (const pd of pageData) {
          for (let i = 0; i < pd.values.length; i++) {
            rows.push({
              page: pd.pageName,
              cell_index: pd.cellIndices?.[i] ?? i,
              value: pd.values[i]
            });
          }
        }
        return {
          rows,
          columns: ['page', 'cell_index', 'value']
        };
      };
    }

    return normalized;
  }

  /**
   * Render a plot
   * @param {string} id - Plot type ID
   * @param {Object[]} pageData - Page data array
   * @param {Object} options - Plot options
   * @param {HTMLElement} container - Container element
   * @param {Object} [layoutEngine] - Layout engine instance
   * @returns {Promise<Object>} Plot result
   */
  async render(id, pageData, options, container, layoutEngine) {
    const plugin = this.get(id);
    if (!plugin) {
      throw new Error(`Unknown plot type: ${id}`);
    }

    const mergedOptions = this.getOptions(id, options);
    return plugin.render(pageData, mergedOptions, container, layoutEngine);
  }

  /**
   * Update an existing plot
   * @param {string} id - Plot type ID
   * @param {Object} figure - Existing figure reference
   * @param {Object[]} pageData - Page data array
   * @param {Object} options - Plot options
   * @param {Object} [layoutEngine] - Layout engine instance
   * @returns {Promise<Object>} Updated plot
   */
  async update(id, figure, pageData, options, layoutEngine) {
    const plugin = this.get(id);
    if (!plugin) {
      throw new Error(`Unknown plot type: ${id}`);
    }

    const mergedOptions = this.getOptions(id, options);
    return plugin.update(figure, pageData, mergedOptions, layoutEngine);
  }

  /**
   * Export plot data as CSV
   * @param {string} id - Plot type ID
   * @param {Object[]} pageData - Page data array
   * @param {Object} options - Plot options
   * @returns {Object} { rows, columns }
   */
  exportCSV(id, pageData, options) {
    const plugin = this.get(id);
    if (!plugin) {
      throw new Error(`Unknown plot type: ${id}`);
    }

    const mergedOptions = this.getOptions(id, options);
    return plugin.exportCSV(pageData, mergedOptions);
  }
}

/**
 * Transform Plugin Registry
 *
 * Unified registry for data transforms with automatic backend selection.
 * Supports GPU > Worker > CPU fallback pattern for optimal performance.
 */
export class TransformPluginRegistry extends BasePluginRegistry {
  constructor() {
    super({
      name: 'TransformRegistry',
      pluginType: 'transform',
      requiredMethods: ['execute']
    });

    this._gpuAvailable = false;
    this._workerAvailable = false;
    this._gpuCompute = null;
    this._workerPool = null;
  }

  /**
   * Initialize the registry and check backend availability
   * @returns {Promise<void>}
   */
  async init() {
    if (this._initialized) return;

    // Check GPU availability
    try {
      const { getGPUCompute } = await import('./gpu-compute.js');
      const gpu = getGPUCompute();
      await gpu.init();
      this._gpuAvailable = gpu._initialized;
      if (this._gpuAvailable) {
        this._gpuCompute = gpu;
      }
    } catch (e) {
      this._gpuAvailable = false;
    }

    // Check worker availability via WorkerPool
    try {
      const { getWorkerPool } = await import('../compute/worker-pool.js');
      const pool = getWorkerPool();
      await pool.init();
      this._workerAvailable = pool.isReady();
      if (this._workerAvailable) {
        this._workerPool = pool;
      }
    } catch (e) {
      this._workerAvailable = false;
    }

    this._initialized = true;
    debug('TransformRegistry', `Initialized (GPU: ${this._gpuAvailable}, Worker: ${this._workerAvailable})`);
    this._emit('init');
  }

  _normalizePlugin(plugin) {
    const normalized = super._normalizePlugin(plugin);

    // Add transform-specific properties
    normalized.gpuMethod = plugin.gpuMethod || null;
    normalized.workerMethod = plugin.workerMethod || null;

    return normalized;
  }

  /**
   * Select the best backend for a transform
   * Priority: GPU > Worker > CPU (based on availability, not array size)
   * @param {Object} plugin - Transform plugin
   * @param {string} [preferredBackend] - Preferred backend override
   * @returns {string} 'gpu' | 'worker' | 'cpu'
   */
  selectBackend(plugin, preferredBackend = null) {
    // Respect explicit preference if backend is available
    if (preferredBackend === 'gpu' && this._gpuAvailable && plugin.gpuMethod) return 'gpu';
    if (preferredBackend === 'worker' && this._workerAvailable && plugin.workerMethod) return 'worker';
    if (preferredBackend === 'cpu') return 'cpu';

    // GPU first if available and transform supports it
    if (plugin.gpuMethod && this._gpuAvailable) {
      return 'gpu';
    }

    // Worker second if available and transform supports it
    if (plugin.workerMethod && this._workerAvailable) {
      return 'worker';
    }

    // CPU as final fallback
    return 'cpu';
  }

  /**
   * Get GPU compute instance
   * @returns {Object|null}
   */
  getGPU() {
    return this._gpuCompute;
  }

  /**
   * Get worker pool instance
   * @returns {Object|null}
   */
  getWorkerPool() {
    return this._workerPool;
  }

  /**
   * Check if GPU is available
   * @returns {boolean}
   */
  isGPUAvailable() {
    return this._gpuAvailable;
  }

  /**
   * Check if workers are available
   * @returns {boolean}
   */
  isWorkerAvailable() {
    return this._workerAvailable;
  }

  /**
   * Execute a transform with automatic backend selection
   * @param {string} id - Transform ID
   * @param {Object} data - Input data
   * @param {Object} options - Transform options
   * @param {Object} [context] - Execution context
   * @returns {Promise<Object>} Transformed data
   */
  async execute(id, data, options = {}, context = {}) {
    const plugin = this.get(id);
    if (!plugin) {
      throw new Error(`Unknown transform: ${id}`);
    }

    const mergedOptions = this.getOptions(id, options);

    // Validate options
    const validation = this.validateOptions(id, mergedOptions);
    if (!validation.valid) {
      throw new Error(`Invalid options: ${validation.errors.join(', ')}`);
    }

    // Run custom validation if present
    if (plugin.validate) {
      const customValidation = plugin.validate(data, mergedOptions);
      if (customValidation !== true && customValidation?.valid === false) {
        throw new Error(`Validation failed: ${customValidation.errors?.join(', ')}`);
      }
    }

    // Select backend
    const backend = this.selectBackend(plugin, context.preferredBackend);

    // Execute with timing
    const startTime = performance.now();
    let result;

    try {
      result = await plugin.execute(data, mergedOptions, {
        ...context,
        backend,
        registry: this
      });
    } catch (err) {
      // Fallback to CPU if accelerated backend fails
      if (backend !== 'cpu') {
        debugWarn('TransformRegistry', `${backend} execution failed, falling back to CPU:`, err.message);
        result = await plugin.execute(data, mergedOptions, {
          ...context,
          backend: 'cpu',
          registry: this
        });
      } else {
        throw err;
      }
    }

    const elapsed = performance.now() - startTime;

    // Add execution metadata
    return {
      ...result,
      _meta: {
        transformId: id,
        backend,
        elapsedMs: elapsed,
        inputCount: data.values?.length || 0,
        outputCount: result.values?.length || 0
      }
    };
  }
}

/**
 * Statistical Test Plugin Registry
 */
export class StatPluginRegistry extends BasePluginRegistry {
  constructor() {
    super({
      name: 'StatRegistry',
      pluginType: 'stat',
      requiredMethods: ['compute']
    });
  }

  _normalizePlugin(plugin) {
    const normalized = super._normalizePlugin(plugin);

    // Add stat-specific properties
    normalized.testType = plugin.testType || 'generic'; // 'parametric', 'nonparametric', 'correlation'
    normalized.assumptions = plugin.assumptions || [];

    return normalized;
  }

  /**
   * Compute statistical test
   * @param {string} id - Test ID
   * @param {Object} data - Test data
   * @param {Object} options - Test options
   * @returns {Promise<Object>} Test result
   */
  async compute(id, data, options = {}) {
    const plugin = this.get(id);
    if (!plugin) {
      throw new Error(`Unknown statistical test: ${id}`);
    }

    const mergedOptions = this.getOptions(id, options);

    // Run custom validation if present
    if (plugin.validate) {
      const validation = plugin.validate(data, mergedOptions);
      if (validation !== true && validation?.valid === false) {
        throw new Error(`Validation failed: ${validation.errors?.join(', ')}`);
      }
    }

    return plugin.compute(data, mergedOptions);
  }

  /**
   * Get tests by type
   * @param {string} testType - Test type filter
   * @returns {Object[]}
   */
  getByTestType(testType) {
    return this.getAll().filter(t => t.testType === testType);
  }
}

// =============================================================================
// UNIFIED PLUGIN MANAGER
// =============================================================================

/**
 * Unified Plugin Manager
 * Provides a single access point for all plugin registries
 */
class PluginManager {
  constructor() {
    this.plots = new PlotPluginRegistry();
    this.transforms = new TransformPluginRegistry();
    this.stats = new StatPluginRegistry();

    this._initialized = false;
  }

  /**
   * Initialize all registries
   */
  async init() {
    if (this._initialized) return;

    await Promise.all([
      this.plots.init(),
      this.transforms.init(),
      this.stats.init()
    ]);

    this._initialized = true;
    debug('PluginManager', 'All registries initialized');
  }

  /**
   * Get overall statistics
   */
  getStats() {
    return {
      plots: this.plots.getStats(),
      transforms: this.transforms.getStats(),
      stats: this.stats.getStats()
    };
  }

  /**
   * Find plugins by name/description search
   * @param {string} query - Search query
   * @returns {Object} { plots, transforms, stats }
   */
  search(query) {
    const q = query.toLowerCase();
    const matches = (plugin) =>
      plugin.name.toLowerCase().includes(q) ||
      (plugin.description && plugin.description.toLowerCase().includes(q));

    return {
      plots: this.plots.getAll().filter(matches),
      transforms: this.transforms.getAll().filter(matches),
      stats: this.stats.getAll().filter(matches)
    };
  }
}

// Re-export the shared page color palette.
export { getPageColor, PAGE_COLORS };

// =============================================================================
// PLOT HELPERS
// =============================================================================

/**
 * Shared utility functions for plot types
 */
export const PlotHelpers = {
  /**
   * Get color for page
   */
  getPageColor,

  /**
   * Format number for display
   * @param {number} value
   * @param {number} precision
   * @returns {string}
   */
  formatNumber(value, precision = 2) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return 'N/A';
    }
    if (Math.abs(value) >= 1000000) {
      return (value / 1000000).toFixed(1) + 'M';
    }
    if (Math.abs(value) >= 1000) {
      return (value / 1000).toFixed(1) + 'K';
    }
    if (Number.isInteger(value)) {
      return value.toString();
    }
    return value.toFixed(precision);
  },

  /**
   * Count categorical values
   * @param {string[]} values
   * @returns {Map<string, number>}
   */
  countCategories(values) {
    const counts = new Map();
    for (const v of values) {
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    return counts;
  },

  /**
   * Sort categories by count or name
   * @param {Map<string, number>} counts
   * @param {'count' | 'name' | 'none'} sortBy
   * @returns {string[]}
   */
  sortCategories(counts, sortBy = 'count') {
    const entries = Array.from(counts.entries());
    switch (sortBy) {
      case 'count':
        entries.sort((a, b) => b[1] - a[1]);
        break;
      case 'name':
        entries.sort((a, b) => a[0].localeCompare(b[0]));
        break;
      // 'none' - keep original order
    }
    return entries.map(e => e[0]);
  },

  /**
   * Calculate box plot statistics
   * @param {number[]} values
   * @returns {Object|null}
   */
  boxStats(values) {
    const sorted = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
    if (sorted.length === 0) return null;

    const n = sorted.length;
    const q1Idx = Math.floor(n * 0.25);
    const q2Idx = Math.floor(n * 0.5);
    const q3Idx = Math.floor(n * 0.75);

    const q1 = sorted[q1Idx];
    const median = sorted[q2Idx];
    const q3 = sorted[q3Idx];
    const iqr = q3 - q1;
    const lowerFence = q1 - 1.5 * iqr;
    const upperFence = q3 + 1.5 * iqr;

    const min = sorted[0];
    const max = sorted[n - 1];
    const meanVal = mean(sorted);

    return { min, max, q1, median, q3, iqr, lowerFence, upperFence, mean: meanVal, n };
  },

  /**
   * Calculate histogram bins
   * @param {number[]} values
   * @param {number} binCount
   * @returns {Object}
   */
  histogramBins(values, binCount = 20) {
    const valid = filterFiniteNumbers(values);
    if (valid.length === 0) return { bins: [], min: 0, max: 0 };

    const { min, max } = getFiniteMinMax(valid);
    const binWidth = (max - min) / binCount || 1;

    const bins = new Array(binCount).fill(0);
    const edges = [];
    for (let i = 0; i <= binCount; i++) {
      edges.push(min + i * binWidth);
    }

    for (const v of valid) {
      let binIdx = Math.floor((v - min) / binWidth);
      if (binIdx >= binCount) binIdx = binCount - 1;
      if (binIdx < 0) binIdx = 0;
      bins[binIdx]++;
    }

    return { bins, edges, min, max, binWidth, total: valid.length };
  },

  /**
   * Create base Plotly layout - minimal design matching cellucid
   * Clean, professional appearance with minimal chrome
   * @param {Object} options
   * @returns {Object}
   */
  createBaseLayout(options = {}) {
    const theme = getPlotTheme();
    return {
      autosize: true,
      margin: { l: 55, r: 20, t: 40, b: 55 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: theme.plotBg,
      font: {
        family: theme.fontFamily,
        size: theme.fontSize,
        color: theme.text
      },
      showlegend: options.showLegend !== false,
      legend: {
        orientation: 'h',
        yanchor: 'bottom',
        y: 1.02,
        xanchor: 'center',
        x: 0.5,
        font: { size: theme.legendFontSize, color: theme.text },
        bgcolor: 'transparent',
        borderwidth: 0,
        itemsizing: 'constant'
      },
      xaxis: {
        gridcolor: theme.grid,
        gridwidth: 1,
        linecolor: theme.axisLine,
        linewidth: 1,
        tickfont: { size: theme.tickFontSize, color: theme.textMuted },
        title: { font: { size: theme.titleFontSize, color: theme.text }, standoff: 12 },
        zeroline: false,
        automargin: true
      },
      yaxis: {
        gridcolor: theme.grid,
        gridwidth: 1,
        linecolor: theme.axisLine,
        linewidth: 1,
        tickfont: { size: theme.tickFontSize, color: theme.textMuted },
        title: { font: { size: theme.titleFontSize, color: theme.text }, standoff: 12 },
        zeroline: false,
        automargin: true
      },
      hoverlabel: {
        bgcolor: theme.hover.bg,
        bordercolor: theme.hover.border,
        font: { family: theme.fontFamily, size: theme.titleFontSize, color: theme.hover.text }
      },
      ...options
    };
  },

  /**
   * Apply axis synchronization settings
   * @param {Object} layout
   * @param {Object} options
   * @returns {Object}
   */
  applyAxisSync(layout, options = {}) {
    if (options.syncYAxis && layout.yaxis) {
      // Will be handled by subplot matching
    }
    if (options.syncXAxis && layout.xaxis) {
      // Will be handled by subplot matching
    }
    return layout;
  }
};

// =============================================================================
// SINGLETON EXPORTS
// =============================================================================

let pluginManagerInstance = null;

/**
 * Get the singleton plugin manager
 * @returns {PluginManager}
 */
export function getPluginManager() {
  if (!pluginManagerInstance) {
    pluginManagerInstance = new PluginManager();
  }
  return pluginManagerInstance;
}

/**
 * Initialize the plugin manager
 * @returns {Promise<PluginManager>}
 */
export async function initPluginManager() {
  const manager = getPluginManager();
  await manager.init();
  return manager;
}

// Helper functions for direct registry access
export function getPlotRegistry() {
  return getPluginManager().plots;
}

export function getTransformRegistry() {
  return getPluginManager().transforms;
}

export function getStatRegistry() {
  return getPluginManager().stats;
}

export default PluginManager;
