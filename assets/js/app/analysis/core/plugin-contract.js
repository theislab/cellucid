/**
 * Unified Plugin Contract System
 *
 * Standardizes plot plugin registration, validation, and lifecycle.
 *
 * This module provides:
 * - A common base registry class for all plugin types
 * - Runtime validation at registration time
 * - Consistent API across plugin types
 * - UI generation from option schemas
 * - Plugin discovery and introspection
 */

import { categoryCounts } from '../shared/category-counts.js';
import {
  validatePluginContract,
  validateOptionsAgainstSchema,
  mergeOptions
} from './analysis-types.js';
import { filterFiniteNumbers, getFiniteMinMax, mean } from '../shared/number-utils.js';
import { debug, debugWarn, debugError } from '../shared/debug-utils.js';
import { getPlotTheme } from '../shared/plot-theme.js';
import { getPageColor, PAGE_COLORS } from '../../utils/page-colors.js';
import { setOwnDataProperty } from '../../../utils/exact-record.js';

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
   * @param {string} options.pluginType - Plugin type for validation ('plot')
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
      debugError(this._name, 'Failed to register plugin:', validation.errors);
      return false;
    }

    if (validation.warnings.length > 0) {
      debugWarn(this._name, `Warnings for '${plugin.id}':`, validation.warnings);
    }

    // Check required methods
    for (const method of this._requiredMethods) {
      if (
        !Object.hasOwn(plugin, method) ||
        typeof plugin[method] !== 'function'
      ) {
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
      defaultOptions: (
        Object.hasOwn(plugin, 'defaultOptions') &&
        plugin.defaultOptions
      ) ? plugin.defaultOptions : {},
      optionSchema: (
        Object.hasOwn(plugin, 'optionSchema') &&
        plugin.optionSchema
      ) ? plugin.optionSchema : {},
      supportedTypes: plugin.supportedTypes
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
        const count = Object.hasOwn(byType, type)
          ? byType[type]
          : 0;
        setOwnDataProperty(byType, type, count + 1);
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
    normalized.supportedLayouts = (
      Object.hasOwn(plugin, 'supportedLayouts') &&
      plugin.supportedLayouts
    ) ? plugin.supportedLayouts : ['single'];

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

// Re-export the shared page color palette.
export { getPageColor, PAGE_COLORS };

// =============================================================================
// PLOT HELPERS
// =============================================================================

/**
 * Shared utility functions for plot types
 */
const CATEGORY_NAME_TYPE_ORDER = { boolean: 0, number: 1, string: 2 };

function compareCategoryLabelsByName(left, right) {
  const leftType = typeof left;
  const rightType = typeof right;
  if (
    !Object.hasOwn(CATEGORY_NAME_TYPE_ORDER, leftType)
    || !Object.hasOwn(CATEGORY_NAME_TYPE_ORDER, rightType)
  ) {
    throw new TypeError('Category labels must be strings, numbers, or booleans');
  }
  if (leftType !== rightType) {
    return CATEGORY_NAME_TYPE_ORDER[leftType] - CATEGORY_NAME_TYPE_ORDER[rightType];
  }
  if (leftType === 'string') return left.localeCompare(right);
  return Number(left) - Number(right);
}

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
   * Count categorical values, in first-occurrence order (see
   * shared/category-counts.js: counted once per page-values array, shared,
   * read only).
   * @param {string[]} values
   * @returns {Map<string, number>}
   */
  countCategories(values) {
    return categoryCounts(values);
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
        // Category labels are strings, finite numbers or booleans. Booleans
        // sort before numbers before strings; numbers sort numerically.
        entries.sort((a, b) => compareCategoryLabelsByName(a[0], b[0]));
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
// SINGLETON
// =============================================================================

let plotRegistryInstance = null;

/**
 * Get the singleton plot plugin registry.
 * @returns {PlotPluginRegistry}
 */
export function getPlotRegistry() {
  if (!plotRegistryInstance) {
    plotRegistryInstance = new PlotPluginRegistry();
  }
  return plotRegistryInstance;
}
