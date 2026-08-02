/**
 * Layout Engine for Page Analysis
 *
 * Handles multi-page comparison layouts, subplot arrangement,
 * axis synchronization, and responsive sizing.
 */

import { getPageColor, PAGE_COLORS } from '../core/plugin-contract.js';
import { getPlotTheme } from '../shared/plot-theme.js';
import { escapeHtml } from '../../utils/dom-utils.js';

/**
 * Layout mode definitions
 */
export const LAYOUT_MODES = {
  'side-by-side': {
    id: 'side-by-side',
    name: 'Side by Side',
    description: 'Separate subplot for each page',
    icon: '▥',
    calculateGrid(pageCount) {
      // Single row for up to 4, then wrap
      if (pageCount <= 4) {
        return { rows: 1, cols: pageCount };
      }
      const cols = Math.min(pageCount, 3);
      const rows = Math.ceil(pageCount / cols);
      return { rows, cols };
    }
  },

  'overlay': {
    id: 'overlay',
    name: 'Overlay',
    description: 'All pages on same plot with different colors',
    icon: '◫',
    calculateGrid() {
      return { rows: 1, cols: 1 };
    }
  },

  'grouped': {
    id: 'grouped',
    name: 'Grouped',
    description: 'Single plot with grouped elements by page',
    icon: '▤',
    calculateGrid() {
      return { rows: 1, cols: 1 };
    }
  },

  'grid': {
    id: 'grid',
    name: 'Grid',
    description: 'Auto-arranged grid of subplots',
    icon: '▦',
    calculateGrid(pageCount) {
      if (pageCount <= 1) return { rows: 1, cols: 1 };
      const cols = Math.ceil(Math.sqrt(pageCount));
      const rows = Math.ceil(pageCount / cols);
      return { rows, cols };
    }
  },

  'stacked': {
    id: 'stacked',
    name: 'Stacked',
    description: 'Vertical stack of subplots',
    icon: '☰',
    calculateGrid(pageCount) {
      return { rows: pageCount, cols: 1 };
    }
  }
};

/**
 * Layout Engine class
 */
export class LayoutEngine {
  /**
   * @param {Object} options
   * @param {number} options.pageCount - Number of pages to display
   * @param {string[]} options.pageIds - Page IDs for color assignment
   * @param {string[]} options.pageNames - Page names for labeling
   * @param {boolean} [options.syncXAxis=true] - Synchronize X axes
   * @param {boolean} [options.syncYAxis=true] - Synchronize Y axes
   * @param {string[]} [options.colorScheme] - Custom color palette
   * @param {Map} [options.customColors] - Map of pageId -> custom color
   */
  constructor(options) {
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options)
    ) {
      throw new TypeError('LayoutEngine options must be an object');
    }
    if (!Number.isSafeInteger(options.pageCount) || options.pageCount <= 0) {
      throw new RangeError('LayoutEngine pageCount must be a positive integer');
    }
    if (
      !Array.isArray(options.pageIds) ||
      options.pageIds.length !== options.pageCount
    ) {
      throw new RangeError(
        'LayoutEngine pageIds length must exactly equal pageCount'
      );
    }
    if (
      !Array.isArray(options.pageNames) ||
      options.pageNames.length !== options.pageCount
    ) {
      throw new RangeError(
        'LayoutEngine pageNames length must exactly equal pageCount'
      );
    }
    if (
      options.pageIds.some(
        id => typeof id !== 'string' || id.length === 0 || id !== id.trim()
      ) ||
      new Set(options.pageIds).size !== options.pageIds.length
    ) {
      throw new TypeError(
        'LayoutEngine pageIds must be unique non-empty strings'
      );
    }
    if (
      options.pageNames.some(
        name =>
          typeof name !== 'string' ||
          name.length === 0 ||
          name !== name.trim()
      )
    ) {
      throw new TypeError(
        'LayoutEngine pageNames must be non-empty strings'
      );
    }

    const syncXAxis = options.syncXAxis === undefined
      ? true
      : options.syncXAxis;
    const syncYAxis = options.syncYAxis === undefined
      ? true
      : options.syncYAxis;
    if (typeof syncXAxis !== 'boolean' || typeof syncYAxis !== 'boolean') {
      throw new TypeError(
        'LayoutEngine syncXAxis and syncYAxis must be booleans'
      );
    }

    const colorScheme = options.colorScheme === undefined
      ? PAGE_COLORS
      : options.colorScheme;
    if (
      !Array.isArray(colorScheme) ||
      colorScheme.length === 0 ||
      colorScheme.some(color => typeof color !== 'string' || color.length === 0)
    ) {
      throw new TypeError(
        'LayoutEngine colorScheme must be a non-empty array of colors'
      );
    }

    const customColors = options.customColors === undefined
      ? new Map()
      : options.customColors;
    if (!(customColors instanceof Map)) {
      throw new TypeError('LayoutEngine customColors must be a Map');
    }
    for (const [pageId, color] of customColors) {
      if (!options.pageIds.includes(pageId)) {
        throw new Error(
          `LayoutEngine custom color references unknown page "${pageId}"`
        );
      }
      if (typeof color !== 'string' || color.length === 0) {
        throw new TypeError(
          `LayoutEngine custom color for "${pageId}" must be a non-empty string`
        );
      }
    }

    this.pageCount = options.pageCount;
    this.pageIds = [...options.pageIds];
    this.pageNames = [...options.pageNames];
    this.syncXAxis = syncXAxis;
    this.syncYAxis = syncYAxis;
    this.colorScheme = [...colorScheme];
    this.customColors = new Map(customColors);

    // Map page IDs to indices for consistent coloring
    this._pageColorMap = new Map();
    this.pageIds.forEach((id, idx) => {
      this._pageColorMap.set(id, idx);
    });
  }

  /**
   * Get color for a specific page
   * @param {string|number} pageIdOrIndex - Page ID or index
   * @returns {string} Color hex code
   */
  getPageColor(pageIdOrIndex) {
    let pageId;
    let index;

    if (typeof pageIdOrIndex === 'string') {
      pageId = pageIdOrIndex;
      index = this._pageColorMap.get(pageIdOrIndex);
      if (index === undefined) {
        throw new Error(`LayoutEngine received unknown page "${pageIdOrIndex}"`);
      }
    } else {
      if (
        !Number.isSafeInteger(pageIdOrIndex) ||
        pageIdOrIndex < 0 ||
        pageIdOrIndex >= this.pageCount
      ) {
        throw new RangeError(
          `LayoutEngine page index must be between 0 and ${this.pageCount - 1}`
        );
      }
      index = pageIdOrIndex;
      pageId = this.pageIds[index];
    }

    // Check for custom color first
    if (this.customColors.has(pageId)) {
      return this.customColors.get(pageId);
    }

    return this.colorScheme[index % this.colorScheme.length];
  }

  /**
   * Get page name by ID or index
   * @param {string|number} pageIdOrIndex
   * @returns {string}
   */
  getPageName(pageIdOrIndex) {
    let index;
    if (typeof pageIdOrIndex === 'string') {
      index = this.pageIds.indexOf(pageIdOrIndex);
    } else {
      index = pageIdOrIndex;
    }

    if (!Number.isSafeInteger(index) || index < 0 || index >= this.pageCount) {
      throw new Error(
        `LayoutEngine received unknown page "${String(pageIdOrIndex)}"`
      );
    }
    return this.pageNames[index];
  }

  /**
   * Get subplot grid specification for a layout mode
   * @param {string} mode - Layout mode ID
   * @returns {{rows: number, cols: number}}
   */
  getSubplotGrid(mode) {
    const layoutMode = LAYOUT_MODES[mode];
    if (!layoutMode) {
      throw new Error(`Unknown layout mode "${String(mode)}"`);
    }
    return layoutMode.calculateGrid(this.pageCount);
  }

  /**
   * Calculate responsive dimensions
   * @param {number} containerWidth
   * @param {number} containerHeight
   * @param {string} mode
   * @returns {{width: number, height: number, plotWidth: number, plotHeight: number}}
   */
  calculateDimensions(containerWidth, containerHeight, mode) {
    if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
      throw new RangeError(
        'LayoutEngine containerWidth must be a positive finite number'
      );
    }
    if (!Number.isFinite(containerHeight) || containerHeight <= 0) {
      throw new RangeError(
        'LayoutEngine containerHeight must be a positive finite number'
      );
    }
    const grid = this.getSubplotGrid(mode);
    const minPlotSize = 200;
    const maxHeight = Math.max(containerHeight, 300);

    // Calculate based on grid
    let plotWidth = containerWidth / grid.cols;
    let plotHeight = maxHeight / grid.rows;

    // Ensure minimum sizes
    plotWidth = Math.max(plotWidth, minPlotSize);
    plotHeight = Math.max(plotHeight, minPlotSize);

    // Adjust total dimensions
    const totalWidth = Math.max(containerWidth, plotWidth * grid.cols);
    const totalHeight = Math.max(plotHeight * grid.rows, 250);

    return {
      width: totalWidth,
      height: totalHeight,
      plotWidth,
      plotHeight,
      grid
    };
  }

  /**
   * Build Plotly layout with subplot configuration
   * @param {string} mode - Layout mode
   * @param {Object} baseLayout - Base layout configuration
   * @returns {Object} Plotly layout object
   */
  buildPlotlyLayout(mode, baseLayout = {}) {
    if (
      baseLayout === null ||
      typeof baseLayout !== 'object' ||
      Array.isArray(baseLayout)
    ) {
      throw new TypeError('LayoutEngine baseLayout must be an object');
    }
    const grid = this.getSubplotGrid(mode);
    const layout = { ...baseLayout };

    // For single plot modes
    if (mode === 'overlay' || mode === 'grouped') {
      layout.showlegend = true;
      return layout;
    }

    // For subplot modes (side-by-side, grid, stacked)
    if (grid.rows > 1 || grid.cols > 1) {
      // Configure subplot grid
      const horizontalSpacing = 0.05;
      const verticalSpacing = 0.1;

      const plotWidth = (1 - horizontalSpacing * (grid.cols - 1)) / grid.cols;
      const plotHeight = (1 - verticalSpacing * (grid.rows - 1)) / grid.rows;

      // Generate axis domains for each subplot
      for (let row = 0; row < grid.rows; row++) {
        for (let col = 0; col < grid.cols; col++) {
          const idx = row * grid.cols + col + 1;
          if (idx > this.pageCount) break;

          const xStart = col * (plotWidth + horizontalSpacing);
          const xEnd = xStart + plotWidth;
          const yStart = 1 - (row + 1) * (plotHeight + verticalSpacing) + verticalSpacing;
          const yEnd = yStart + plotHeight;

          const xAxisKey = idx === 1 ? 'xaxis' : `xaxis${idx}`;
          const yAxisKey = idx === 1 ? 'yaxis' : `yaxis${idx}`;

          layout[xAxisKey] = {
            ...layout.xaxis,
            domain: [xStart, xEnd],
            anchor: idx === 1 ? 'y' : `y${idx}`
          };

          layout[yAxisKey] = {
            ...layout.yaxis,
            domain: [yStart, yEnd],
            anchor: idx === 1 ? 'x' : `x${idx}`
          };

          // Handle axis synchronization
          if (this.syncXAxis && idx > 1) {
            layout[xAxisKey].matches = 'x';
          }
          if (this.syncYAxis && idx > 1) {
            layout[yAxisKey].matches = 'y';
          }
        }
      }

      // Add annotations for subplot titles
      if (layout.annotations === undefined) {
        layout.annotations = [];
      } else if (!Array.isArray(layout.annotations)) {
        throw new TypeError('Plotly layout annotations must be an array');
      } else {
        layout.annotations = [...layout.annotations];
      }
      const theme = getPlotTheme();
      for (let i = 0; i < this.pageCount; i++) {
        const row = Math.floor(i / grid.cols);
        const col = i % grid.cols;
        const xPos = col * (plotWidth + horizontalSpacing) + plotWidth / 2;
        const yPos = 1 - row * (plotHeight + verticalSpacing) + 0.02;

        layout.annotations.push({
          // Plotly parses its HTML subset in annotation text; page names are
          // user/session supplied.
          text: escapeHtml(this.getPageName(i)),
          x: xPos,
          y: yPos,
          xref: 'paper',
          yref: 'paper',
          xanchor: 'center',
          yanchor: 'bottom',
          showarrow: false,
          font: { size: theme.titleFontSize, color: theme.text, weight: 600 }
        });
      }
    }

    return layout;
  }

  /**
   * Get axis reference for a subplot index
   * @param {number} index - Zero-based subplot index
   * @returns {{x: string, y: string}}
   */
  getAxisRef(index) {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= this.pageCount
    ) {
      throw new RangeError(
        `LayoutEngine subplot index must be between 0 and ${this.pageCount - 1}`
      );
    }
    if (index === 0) {
      return { x: 'x', y: 'y' };
    }
    return { x: `x${index + 1}`, y: `y${index + 1}` };
  }

  /**
   * Get all available layout modes
   * @returns {Object[]}
   */
  static getLayoutModes() {
    return Object.values(LAYOUT_MODES);
  }

  /**
   * Get layout mode by ID
   * @param {string} id
   * @returns {Object|null}
   */
  static getLayoutMode(id) {
    const layoutMode = LAYOUT_MODES[id];
    if (layoutMode === undefined) {
      throw new Error(`Unknown layout mode "${String(id)}"`);
    }
    return layoutMode;
  }

  /**
   * Create color scale for continuous data
   * @param {string} colormap - Colormap name
   * @returns {Array<[number, string]>}
   */
  static createColorScale(colormap = 'viridis') {
    const colormaps = {
      viridis: [
        [0, '#440154'],
        [0.25, '#3b528b'],
        [0.5, '#21918c'],
        [0.75, '#5ec962'],
        [1, '#fde725']
      ],
      plasma: [
        [0, '#0d0887'],
        [0.25, '#7e03a8'],
        [0.5, '#cc4778'],
        [0.75, '#f89540'],
        [1, '#f0f921']
      ],
      blues: [
        [0, '#f7fbff'],
        [0.5, '#6baed6'],
        [1, '#08306b']
      ],
      reds: [
        [0, '#fff5f0'],
        [0.5, '#fb6a4a'],
        [1, '#67000d']
      ]
    };

    const colorScale = colormaps[colormap];
    if (colorScale === undefined) {
      throw new Error(`Unknown colormap "${String(colormap)}"`);
    }
    return colorScale.map(([position, color]) => [position, color]);
  }
}

/**
 * Create a new layout engine
 * @param {Object} options
 * @returns {LayoutEngine}
 */
export function createLayoutEngine(options) {
  return new LayoutEngine(options);
}

export { getPageColor };
