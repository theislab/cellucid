/**
 * Plot Registry for Page Analysis
 *
 * Plugin-based architecture for plot types with self-describing metadata.
 * Each plot type provides its own render function, options schema, and
 * compatibility information.
 */

/**
 * @typedef {Object} OptionDef
 * @property {'select' | 'checkbox' | 'number' | 'range' | 'text'} type
 * @property {string} label - Display label
 * @property {Array<{value: string, label: string}>} [options] - For select type
 * @property {number} [min] - For number/range type
 * @property {number} [max] - For number/range type
 * @property {number} [step] - For number/range type
 * @property {string} [placeholder] - For text type
 * @property {Function} [showWhen] - Condition function (options) => boolean
 */

/**
 * @typedef {Object} PlotType
 * @property {string} id - Unique identifier
 * @property {string} name - Display name
 * @property {string} [description] - Description text
 * @property {string} [icon] - Icon/emoji for visual picker
 * @property {string[]} supportedDataTypes - Array of compatible data types
 * @property {string[]} supportedLayouts - Array of compatible layout modes
 * @property {Object} defaultOptions - Default option values
 * @property {Object<string, OptionDef>} optionSchema - Option definitions for UI
 * @property {Function} render - Main render function
 * @property {Function} [update] - Optional update function for live updates
 */

// Registry storage
const plotRegistry = new Map();

/**
 * Plot Registry class (static methods for global access)
 */
export class PlotRegistry {
  /**
   * Register a plot type
   * @param {PlotType} plotType - Plot type definition
   */
  static register(plotType) {
    if (!plotType.id) {
      console.error('[PlotRegistry] Plot type must have an id');
      return;
    }

    // Validate required fields
    if (!plotType.render || typeof plotType.render !== 'function') {
      console.error(`[PlotRegistry] Plot type '${plotType.id}' must have a render function`);
      return;
    }

    // Set defaults
    plotType.supportedDataTypes = plotType.supportedDataTypes || ['categorical', 'continuous'];
    plotType.supportedLayouts = plotType.supportedLayouts || ['side-by-side', 'grouped'];
    plotType.defaultOptions = plotType.defaultOptions || {};
    plotType.optionSchema = plotType.optionSchema || {};

    plotRegistry.set(plotType.id, plotType);
  }

  /**
   * Get a plot type by ID
   * @param {string} id - Plot type ID
   * @returns {PlotType|null}
   */
  static get(id) {
    return plotRegistry.get(id) || null;
  }

  /**
   * Get all registered plot types
   * @returns {PlotType[]}
   */
  static getAll() {
    return Array.from(plotRegistry.values());
  }

  /**
   * Get plot types compatible with a data type
   * @param {string} dataType - 'categorical' or 'continuous'
   * @returns {PlotType[]}
   */
  static getForDataType(dataType) {
    const normalizedType = dataType.includes('categorical') ? 'categorical' : 'continuous';
    return PlotRegistry.getAll().filter(pt =>
      pt.supportedDataTypes.includes(normalizedType) ||
      pt.supportedDataTypes.includes(dataType)
    );
  }

  /**
   * Get plot type IDs
   * @returns {string[]}
   */
  static getIds() {
    return Array.from(plotRegistry.keys());
  }

  /**
   * Check if a plot type is registered
   * @param {string} id - Plot type ID
   * @returns {boolean}
   */
  static has(id) {
    return plotRegistry.has(id);
  }

  /**
   * Unregister a plot type
   * @param {string} id - Plot type ID
   */
  static unregister(id) {
    plotRegistry.delete(id);
  }

  /**
   * Clear all registered plot types
   */
  static clear() {
    plotRegistry.clear();
  }

  /**
   * Merge options with defaults for a plot type
   * @param {string} plotTypeId - Plot type ID
   * @param {Object} options - User options
   * @returns {Object} Merged options
   */
  static mergeOptions(plotTypeId, options = {}) {
    const plotType = PlotRegistry.get(plotTypeId);
    if (!plotType) return options;
    return { ...plotType.defaultOptions, ...options };
  }

  /**
   * Get visible options for current state
   * @param {string} plotTypeId - Plot type ID
   * @param {Object} currentOptions - Current option values
   * @returns {Object<string, OptionDef>}
   */
  static getVisibleOptions(plotTypeId, currentOptions = {}) {
    const plotType = PlotRegistry.get(plotTypeId);
    if (!plotType) return {};

    const visible = {};
    for (const [key, def] of Object.entries(plotType.optionSchema)) {
      if (def.showWhen && typeof def.showWhen === 'function') {
        if (!def.showWhen(currentOptions)) {
          continue;
        }
      }
      visible[key] = def;
    }
    return visible;
  }
}

/**
 * Default page color palette
 */
export const PAGE_COLORS = [
  '#2563eb', // blue-600
  '#dc2626', // red-600
  '#16a34a', // green-600
  '#9333ea', // purple-600
  '#ea580c', // orange-600
  '#0891b2', // cyan-600
  '#c026d3', // fuchsia-600
  '#65a30d', // lime-600
  '#e11d48', // rose-600
  '#0d9488', // teal-600
  '#7c3aed', // violet-600
  '#ca8a04'  // yellow-600
];

/**
 * Get color for a page by index
 * @param {number} pageIndex
 * @returns {string}
 */
export function getPageColor(pageIndex) {
  return PAGE_COLORS[pageIndex % PAGE_COLORS.length];
}

/**
 * Create traces and layout shared helper
 * For internal use by plot types
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
    if (value === null || value === undefined || Number.isNaN(value)) {
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
   * @returns {Object}
   */
  boxStats(values) {
    const sorted = values.filter(v => typeof v === 'number' && !Number.isNaN(v)).sort((a, b) => a - b);
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
    const mean = sorted.reduce((a, b) => a + b, 0) / n;

    return { min, max, q1, median, q3, iqr, lowerFence, upperFence, mean, n };
  },

  /**
   * Calculate histogram bins
   * @param {number[]} values
   * @param {number} binCount
   * @returns {Object}
   */
  histogramBins(values, binCount = 20) {
    const valid = values.filter(v => typeof v === 'number' && !Number.isNaN(v));
    if (valid.length === 0) return { bins: [], min: 0, max: 0 };

    const min = Math.min(...valid);
    const max = Math.max(...valid);
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
    return {
      autosize: true,
      margin: { l: 55, r: 20, t: 40, b: 55 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: '#ffffff',
      font: {
        family: 'Inter, system-ui, -apple-system, sans-serif',
        size: 11,
        color: '#374151'
      },
      showlegend: options.showLegend !== false,
      legend: {
        orientation: 'h',
        yanchor: 'bottom',
        y: 1.02,
        xanchor: 'center',
        x: 0.5,
        font: { size: 11, color: '#374151' },
        bgcolor: 'transparent',
        borderwidth: 0,
        itemsizing: 'constant'
      },
      xaxis: {
        gridcolor: '#f3f4f6',
        gridwidth: 1,
        linecolor: '#e5e7eb',
        linewidth: 1,
        tickfont: { size: 11, color: '#6b7280' },
        title: { font: { size: 12, color: '#374151' }, standoff: 12 },
        zeroline: false,
        automargin: true
      },
      yaxis: {
        gridcolor: '#f3f4f6',
        gridwidth: 1,
        linecolor: '#e5e7eb',
        linewidth: 1,
        tickfont: { size: 11, color: '#6b7280' },
        title: { font: { size: 12, color: '#374151' }, standoff: 12 },
        zeroline: false,
        automargin: true
      },
      hoverlabel: {
        bgcolor: '#111827',
        bordercolor: '#111827',
        font: { family: 'Inter, system-ui, sans-serif', size: 12, color: '#ffffff' }
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

export default PlotRegistry;
