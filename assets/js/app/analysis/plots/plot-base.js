/**
 * Base Plot Class for Analysis Module
 *
 * Provides shared functionality for all plot types:
 * - Common hover label styling
 * - Page color management
 * - Numeric value filtering
 * - Consistent render/update pattern
 * - Standard CSV export structure
 *
 * Plot types can extend this class to reduce code duplication
 * and maintain consistent behavior across the module.
 */

import { PlotHelpers, getPageColor, PAGE_COLORS } from '../core/plugin-contract.js';
import { createMinimalPlotly, getPlotlyConfig } from './plotly-loader.js';
import { isFiniteNumber } from '../shared/number-utils.js';
import { getPlotTheme } from '../shared/plot-theme.js';

/**
 * Common hover label style used by all plots
 */
export const COMMON_HOVER_STYLE = {
  bgcolor: '',
  bordercolor: '',
  font: {
    family: '',
    size: 12,
    color: ''
  }
};

function syncCommonHoverStyle() {
  const theme = getPlotTheme();
  COMMON_HOVER_STYLE.bgcolor = theme.hover.bg;
  COMMON_HOVER_STYLE.bordercolor = theme.hover.border;
  COMMON_HOVER_STYLE.font.family = theme.fontFamily;
  COMMON_HOVER_STYLE.font.size = theme.titleFontSize;
  COMMON_HOVER_STYLE.font.color = theme.hover.text;
}

syncCommonHoverStyle();

if (typeof window !== 'undefined') {
  window.addEventListener('cellucid:theme-change', () => {
    syncCommonHoverStyle();
  });
}

/**
 * Base class for plot type definitions
 *
 * Provides shared utilities and patterns for implementing plot types.
 * Can be used either by extending this class or by using its static methods.
 */
export class BasePlot {
  /**
   * Create a new BasePlot definition
   *
   * @param {Object} definition - Plot type definition
   * @param {string} definition.id - Unique plot type ID
   * @param {string} definition.name - Display name
   * @param {string} [definition.description] - Description
   * @param {string[]} [definition.supportedTypes] - Supported data types
   * @param {string[]} [definition.supportedLayouts] - Supported layout modes
   * @param {Object} [definition.defaultOptions] - Default option values
   * @param {Object} [definition.optionSchema] - Option schema for UI generation
   */
  constructor(definition) {
    this.id = definition.id;
    this.name = definition.name;
    this.description = definition.description || '';
    this.supportedTypes = definition.supportedTypes || ['continuous', 'categorical'];
    this.supportedLayouts = definition.supportedLayouts || ['side-by-side'];
    this.defaultOptions = definition.defaultOptions || {};
    this.optionSchema = definition.optionSchema || {};
  }

  // ===========================================================================
  // Static Utility Methods (can be used without extending)
  // ===========================================================================

  /**
   * Filter values to numeric only
   * @param {any[]} values - Array of values
   * @returns {number[]} Filtered numeric values
   */
  static filterNumeric(values) {
    return values.filter(v => isFiniteNumber(v));
  }

  /**
   * Get color for a page
   * @param {Object} layoutEngine - Layout engine instance
   * @param {string} pageId - Page ID
   * @param {number} index - Fallback index
   * @returns {string} Color hex string
   */
  static getPageColor(layoutEngine, pageId, index) {
    return layoutEngine?.getPageColor(pageId) || getPageColor(index);
  }

  /**
   * Calculate global min/max across all page data
   * @param {Object[]} pageData - Array of page data objects
   * @returns {{ min: number, max: number }}
   */
  static getGlobalRange(pageData) {
    let globalMin = Infinity;
    let globalMax = -Infinity;

    for (const pd of pageData) {
      for (const v of pd.values) {
        if (isFiniteNumber(v)) {
          if (v < globalMin) globalMin = v;
          if (v > globalMax) globalMax = v;
        }
      }
    }

    return {
      min: Number.isFinite(globalMin) ? globalMin : 0,
      max: Number.isFinite(globalMax) ? globalMax : 1
    };
  }

  /**
   * Create common hover label configuration
   * @returns {Object} Hover label config for Plotly
   */
  static getHoverLabel() {
    return { ...COMMON_HOVER_STYLE };
  }

  /**
   * Create base Plotly layout with common styling
   * @param {Object} options - Layout options
   * @returns {Object} Plotly layout object
   */
  static createLayout(options = {}) {
    return PlotHelpers.createBaseLayout({
      hoverlabel: COMMON_HOVER_STYLE,
      ...options
    });
  }

  /**
   * Get Plotly config object
   * @returns {Object} Plotly config
   */
  static getPlotlyConfig() {
    return getPlotlyConfig();
  }

  /**
   * Load Plotly (lazy load)
   * @returns {Promise<Object>} Plotly module
   */
  static async loadPlotly() {
    return createMinimalPlotly();
  }

  /**
   * Get variable name from page data
   * @param {Object[]} pageData - Page data array
   * @param {string} [fallback='Value'] - Fallback name
   * @returns {string} Variable name
   */
  static getVariableName(pageData, fallback = 'Value') {
    return pageData[0]?.variableInfo?.name || fallback;
  }

  /**
   * Standard render wrapper with error handling
   *
   * @param {Function} buildTraces - Function that builds Plotly traces
   * @param {Function} buildLayout - Function that builds Plotly layout
   * @param {Object[]} pageData - Page data array
   * @param {Object} options - Plot options
   * @param {HTMLElement} container - Container element
   * @param {Object} layoutEngine - Layout engine
   * @param {string} plotName - Plot name for error messages
   * @returns {Promise<Object>} Plotly figure
   */
  static async renderPlot(buildTraces, buildLayout, pageData, options, container, layoutEngine, plotName) {
    try {
      const traces = buildTraces(pageData, options, layoutEngine);
      const layout = buildLayout(pageData, options, layoutEngine);
      const config = BasePlot.getPlotlyConfig();
      const Plotly = await BasePlot.loadPlotly();
      return await Plotly.newPlot(container, traces, layout, config);
    } catch (err) {
      console.error(`[${plotName}] Render error:`, err);
      throw new Error(`Failed to render ${plotName}: ${err.message}`);
    }
  }

  /**
   * Standard update wrapper with fallback to re-render
   *
   * @param {Function} buildTraces - Function that builds Plotly traces
   * @param {Function} buildLayout - Function that builds Plotly layout
   * @param {Object} figure - Existing Plotly figure
   * @param {Object[]} pageData - Page data array
   * @param {Object} options - Plot options
   * @param {Object} layoutEngine - Layout engine
   * @param {Function} renderFallback - Render function to use as fallback
   * @param {string} plotName - Plot name for error messages
   * @returns {Promise<Object>} Updated Plotly figure
   */
  static async updatePlot(buildTraces, buildLayout, figure, pageData, options, layoutEngine, renderFallback, plotName) {
    try {
      const traces = buildTraces(pageData, options, layoutEngine);
      const layout = buildLayout(pageData, options, layoutEngine);
      const config = BasePlot.getPlotlyConfig();
      const Plotly = await BasePlot.loadPlotly();
      return await Plotly.react(figure, traces, layout, config);
    } catch (err) {
      console.warn(`[${plotName}] Update error, falling back to re-render:`, err);
      return renderFallback(pageData, options, figure, layoutEngine);
    }
  }

  // ===========================================================================
  // Instance Methods (for classes that extend BasePlot)
  // ===========================================================================

  /**
   * Filter values to numeric only (instance method)
   */
  filterNumeric(values) {
    return BasePlot.filterNumeric(values);
  }

  /**
   * Get page color (instance method)
   */
  getPageColor(layoutEngine, pageId, index) {
    return BasePlot.getPageColor(layoutEngine, pageId, index);
  }

  /**
   * Create layout (instance method)
   */
  createLayout(options = {}) {
    return BasePlot.createLayout(options);
  }

  /**
   * Get variable name (instance method)
   */
  getVariableName(pageData, fallback = 'Value') {
    return BasePlot.getVariableName(pageData, fallback);
  }

  /**
   * Render the plot - must be implemented by subclass
   * @param {Object[]} pageData - Array of page data objects
   * @param {Object} options - Plot options
   * @param {HTMLElement} container - Container element
   * @param {Object} layoutEngine - Layout engine instance
   * @returns {Promise<Object>} Plotly figure reference
   */
  async render(pageData, options, container, layoutEngine) {
    throw new Error(`${this.id}: render() must be implemented by subclass`);
  }

  /**
   * Update existing plot - default implementation re-renders
   * @param {Object} figure - Existing Plotly figure
   * @param {Object[]} pageData - Array of page data objects
   * @param {Object} options - Plot options
   * @param {Object} layoutEngine - Layout engine instance
   * @returns {Promise<Object>} Updated Plotly figure
   */
  async update(figure, pageData, options, layoutEngine) {
    // Default: fall back to re-render
    return this.render(pageData, options, figure, layoutEngine);
  }

  /**
   * Export plot data as CSV - default implementation exports raw values
   * @param {Object[]} pageData - Array of page data objects
   * @param {Object} options - Plot options
   * @returns {Object} { rows, columns, metadata }
   */
  exportCSV(pageData, options) {
    const rows = [];
    const columns = ['page', 'cell_index', 'value'];

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
      columns,
      metadata: {
        plotType: this.id,
        pageCount: pageData.length,
        exportDate: new Date().toISOString()
      }
    };
  }

  /**
   * Get the plot definition object (for registration)
   * @returns {Object} Plot type definition
   */
  toDefinition() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      supportedTypes: this.supportedTypes,
      supportedLayouts: this.supportedLayouts,
      defaultOptions: this.defaultOptions,
      optionSchema: this.optionSchema,
      render: this.render.bind(this),
      update: this.update.bind(this),
      exportCSV: this.exportCSV.bind(this)
    };
  }
}

// ===========================================================================
// Helper Functions for Plot Development
// ===========================================================================

/**
 * Create a plot definition using BasePlot utilities
 *
 * This is a convenience function for creating plot definitions
 * without extending BasePlot class.
 *
 * @param {Object} definition - Plot definition with custom render/update/export
 * @returns {Object} Complete plot definition with base utilities
 */
export function createPlotDefinition(definition) {
  const base = {
    supportedTypes: ['continuous'],
    supportedLayouts: ['side-by-side'],
    defaultOptions: {},
    optionSchema: {}
  };

  // Merge with base
  const merged = { ...base, ...definition };

  // Add utility references
  merged._utils = {
    filterNumeric: BasePlot.filterNumeric,
    getPageColor: BasePlot.getPageColor,
    getGlobalRange: BasePlot.getGlobalRange,
    getHoverLabel: BasePlot.getHoverLabel,
    createLayout: BasePlot.createLayout,
    getPlotlyConfig: BasePlot.getPlotlyConfig,
    loadPlotly: BasePlot.loadPlotly,
    getVariableName: BasePlot.getVariableName
  };

  // Wrap update to provide fallback to render
  if (!merged.update && merged.render) {
    merged.update = function(figure, pageData, options, layoutEngine) {
      return this.render(pageData, options, figure, layoutEngine);
    };
  }

  // Wrap exportCSV to provide default implementation
  if (!merged.exportCSV) {
    merged.exportCSV = function(pageData, options) {
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
        columns: ['page', 'cell_index', 'value'],
        metadata: {
          plotType: merged.id,
          pageCount: pageData.length,
          exportDate: new Date().toISOString()
        }
      };
    };
  }

  return merged;
}

// ===========================================================================
// Exports
// ===========================================================================

export default BasePlot;

// Re-export commonly used utilities for convenience
export {
  PlotHelpers,
  getPageColor,
  PAGE_COLORS,
  createMinimalPlotly,
  getPlotlyConfig
};
