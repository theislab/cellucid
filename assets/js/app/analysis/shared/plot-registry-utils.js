/**
 * Centralized PlotRegistry Utility
 *
 * This module provides the SINGLE source of truth for all PlotRegistry operations.
 * All UI files should import from here instead of creating local wrappers.
 *
 * The raw plugin registry (from plugin-contract.js) has different method names:
 * - getForType() instead of getForDataType()
 * - getOptions() instead of mergeOptions()
 *
 * This wrapper provides consistent, user-friendly method names that match
 * what the UI code expects.
 *
 * @example
 * import { PlotRegistry } from '../shared/plot-registry-utils.js';
 *
 * // Get a specific plot type
 * const plotType = PlotRegistry.get('barplot');
 *
 * // Get all plot types for a data type
 * const continuousPlots = PlotRegistry.getForDataType('continuous');
 *
 * // Merge user options with defaults
 * const mergedOptions = PlotRegistry.mergeOptions('violinplot', userOptions);
 */

import { getPlotRegistry } from '../core/plugin-contract.js';
import { validateOptionSchema } from '../core/analysis-types.js';
import { LEGEND_DEFAULT_OPTIONS, LEGEND_POSITION_SCHEMA } from './legend-utils.js';
import { setOwnDataProperty } from '../../../utils/exact-record.js';

/**
 * PlotRegistry wrapper with user-friendly method names
 *
 * This is the canonical implementation that all UI files should use.
 * It wraps the raw PlotPluginRegistry from plugin-contract.js.
 */
export const PlotRegistry = {
  /**
   * Get a specific plot type by ID
   * @param {string} id - Plot type ID (e.g., 'barplot', 'violinplot')
   * @returns {Object|null} Plot type definition or null
   */
  get: (id) => {
    const plugin = getPlotRegistry().get(id);
    if (!plugin) return null;
    return plugin;
  },

  /**
   * Get all registered plot types
   * @returns {Object[]} Array of all plot type definitions
   */
  getAll: () => {
    return getPlotRegistry().getAll();
  },

  /**
   * Get plot types that support a specific data type
   * @param {string} dataType - 'categorical', 'continuous', 'categorical_obs', etc.
   * @returns {Object[]} Array of compatible plot types
   */
  getForDataType: (dataType) => {
    // Normalize to 'categorical' or 'continuous'
    const normalizedType = dataType.includes('categorical') ? 'categorical' : 'continuous';

    return getPlotRegistry().getAll()
      .filter(pt =>
        pt.supportedTypes?.includes(normalizedType) ||
        pt.supportedTypes?.includes(dataType) ||
        pt.supportedTypes?.includes('any')
      )
      ;
  },

  /**
   * Merge user options with plot type defaults
   * @param {string} plotTypeId - Plot type ID
   * @param {Object} options - User-provided options
   * @returns {Object} Merged options object
   */
  mergeOptions: (plotTypeId, options = {}) => {
    return getPlotRegistry().getOptions(plotTypeId, options);
  },

  /**
   * Get visible options based on current option values
   * Filters out options that have showWhen conditions that aren't met
   * @param {string} plotTypeId - Plot type ID
   * @param {Object} currentOptions - Current option values
   * @returns {Object} Filtered option schema
   */
  getVisibleOptions: (plotTypeId, currentOptions = {}) => {
    const plotType = getPlotRegistry().get(plotTypeId);
    if (!plotType) return {};

    const optionSchema = plotType.optionSchema;
    if (
      optionSchema === null ||
      typeof optionSchema !== 'object' ||
      Array.isArray(optionSchema)
    ) {
      throw new TypeError('Plot option schema must be an object');
    }
    const visible = {};
    for (const [key, def] of Object.entries(optionSchema)) {
      if (
        def === null ||
        typeof def !== 'object' ||
        Array.isArray(def)
      ) {
        throw new TypeError(
          `Plot option ${key} definition must be an object`
        );
      }
      const showWhen = Object.hasOwn(def, 'showWhen')
        ? def.showWhen
        : undefined;
      // Skip options with unmet showWhen conditions
      if (
        typeof showWhen === 'function' &&
        !showWhen.call(def, currentOptions)
      ) {
        continue;
      }
      setOwnDataProperty(visible, key, def);
    }
    return visible;
  },

  /**
   * Check if a plot type exists
   * @param {string} id - Plot type ID
   * @returns {boolean}
   */
  has: (id) => getPlotRegistry().has(id),

  /**
   * Get list of all plot type IDs
   * @returns {string[]}
   */
  getIds: () => getPlotRegistry().getAll().map(p => p.id),

  /**
   * Register a new plot type
   * @param {Object} plotType - Plot type definition
   * @returns {boolean} True if registered successfully
   */
  register: (plotType) => {
    if (
      plotType === null ||
      typeof plotType !== 'object' ||
      Array.isArray(plotType)
    ) {
      console.error('[PlotRegistry] Plot type must be an object');
      return false;
    }
    if (
      !Object.hasOwn(plotType, 'id') ||
      typeof plotType.id !== 'string' ||
      plotType.id.trim().length === 0 ||
      !/^[a-z][a-z0-9_-]*$/.test(plotType.id)
    ) {
      console.error('[PlotRegistry] Plot type must have a valid id');
      return false;
    }
    if (
      !Object.hasOwn(plotType, 'render') ||
      typeof plotType.render !== 'function'
    ) {
      console.error(`[PlotRegistry] Plot type '${plotType.id}' must have a render function`);
      return false;
    }

    const supportsLegend = (
      !Object.hasOwn(plotType, 'supportsLegend') ||
      plotType.supportsLegend !== false
    );
    const plotDefaultOptions = Object.hasOwn(plotType, 'defaultOptions')
      ? plotType.defaultOptions
      : undefined;
    const plotOptionSchema = Object.hasOwn(plotType, 'optionSchema')
      ? plotType.optionSchema
      : undefined;
    if (
      plotDefaultOptions !== undefined &&
      (
        plotDefaultOptions === null ||
        typeof plotDefaultOptions !== 'object' ||
        Array.isArray(plotDefaultOptions)
      )
    ) {
      console.error(
        `[PlotRegistry] Plot type '${plotType.id}' default options must be an object`
      );
      return false;
    }
    if (plotOptionSchema !== undefined) {
      const schemaErrors = validateOptionSchema(plotOptionSchema);
      if (schemaErrors.length > 0) {
        console.error(
          `[PlotRegistry] Plot type '${plotType.id}' has an invalid option schema:`,
          schemaErrors
        );
        return false;
      }
    }

    const defaultOptions = supportsLegend
      ? { ...LEGEND_DEFAULT_OPTIONS, ...(plotDefaultOptions || {}) }
      : (plotDefaultOptions || {});

    const optionSchema = supportsLegend
      ? { legendPosition: LEGEND_POSITION_SCHEMA, ...(plotOptionSchema || {}) }
      : (plotOptionSchema || {});

    if (
      !Object.hasOwn(plotType, 'supportedTypes') ||
      !Array.isArray(plotType.supportedTypes) ||
      plotType.supportedTypes.length === 0
    ) {
      console.error(`[PlotRegistry] Plot type '${plotType.id}' must declare supportedTypes`);
      return false;
    }

    const plugin = {
      id: plotType.id,
      name: (
        Object.hasOwn(plotType, 'name') &&
        plotType.name
      ) ? plotType.name : plotType.id,
      description: (
        Object.hasOwn(plotType, 'description') &&
        plotType.description
      ) ? plotType.description : '',
      supportedTypes: plotType.supportedTypes,
      supportedLayouts: (
        Object.hasOwn(plotType, 'supportedLayouts') &&
        plotType.supportedLayouts
      ) ? plotType.supportedLayouts : ['side-by-side', 'grouped'],
      defaultOptions,
      optionSchema,
      // Core render/update/export functions
      render: plotType.render,
      update: Object.hasOwn(plotType, 'update') ? plotType.update : undefined,
      exportCSV: Object.hasOwn(plotType, 'exportCSV')
        ? plotType.exportCSV
        : undefined,
      // Plot building methods used by PlotFactory.render() via `this`
      buildTraces: Object.hasOwn(plotType, 'buildTraces')
        ? plotType.buildTraces
        : undefined,
      buildLayout: Object.hasOwn(plotType, 'buildLayout')
        ? plotType.buildLayout
        : undefined
    };

    return getPlotRegistry().register(plugin);
  },

  /**
   * Unregister a plot type
   * @param {string} id - Plot type ID
   * @returns {boolean} True if unregistered successfully
   */
  unregister: (id) => getPlotRegistry().unregister(id),

  /**
   * Clear all registered plot types
   */
  clear: () => getPlotRegistry().clear(),

  /**
   * Validate options for a plot type
   * @param {string} id - Plot type ID
   * @param {Object} options - Options to validate
   * @returns {Object} Validation result { valid: boolean, errors: string[], warnings: string[] }
   */
  validateOptions: (id, options) => {
    return getPlotRegistry().validateOptions(id, options);
  },

  /**
   * Get registry statistics
   * @returns {Object} Stats about registered plot types
   */
  getStats: () => {
    const all = getPlotRegistry().getAll();
    const byType = {};

    for (const plugin of all) {
      for (const type of (plugin.supportedTypes || [])) {
        const count = Object.hasOwn(byType, type)
          ? byType[type]
          : 0;
        setOwnDataProperty(byType, type, count + 1);
      }
    }

    return {
      total: all.length,
      byType,
      ids: all.map(p => p.id)
    };
  }
};

// Default export for convenience
export default PlotRegistry;
