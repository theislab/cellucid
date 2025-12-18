/**
 * Cross-Highlighting Module
 *
 * Enables bidirectional highlighting between analysis plots and the embedding view.
 * When a user clicks on a bar, histogram bin, violin region, or other plot element,
 * the corresponding cells are highlighted in the embedding view.
 *
 * Features:
 * - Click to select cells from plot elements
 * - Option to "Save as new page" from selection
 * - Event-driven architecture for loose coupling
 * - Works with all plot types via standardized interface
 */

import { getNotificationCenter } from '../../notification-center.js';

// =============================================================================
// CROSS-HIGHLIGHT MANAGER
// =============================================================================

/**
 * CrossHighlightManager class
 * Coordinates highlighting between analysis plots and embedding views
 */
export class CrossHighlightManager {
  /**
   * @param {Object} options
   * @param {Object} options.dataLayer - Data layer instance
   * @param {Object} [options.embeddingView] - Embedding view instance for highlighting
   * @param {Function} [options.onSelectionChange] - Callback when selection changes
   * @param {Function} [options.onCreatePage] - Callback when user wants to create a page from selection
   */
  constructor(options) {
    this.dataLayer = options.dataLayer;
    this.embeddingView = options.embeddingView || null;
    this.onSelectionChange = options.onSelectionChange || null;
    this.onCreatePage = options.onCreatePage || null;

    this._notifications = getNotificationCenter();

    // Current cross-highlight state
    this._currentSelection = {
      source: null, // 'plot' | 'embedding'
      plotId: null,
      cellIndices: [],
      metadata: {} // Additional info about the selection
    };

    // Registered plots for highlighting
    this._registeredPlots = new Map();

    // Event listeners
    this._eventHandlers = new Map();

    // Bind methods
    this._handlePlotClick = this._handlePlotClick.bind(this);
    this._handlePlotHover = this._handlePlotHover.bind(this);
  }

  // ===========================================================================
  // PLOT REGISTRATION
  // ===========================================================================

  /**
   * Register a plot for cross-highlighting
   * @param {string} plotId - Unique plot identifier
   * @param {Object} plotInstance - Plot instance with Plotly element
   * @param {Object} options
   * @param {string} options.type - Plot type ('barplot', 'histogram', etc.)
   * @param {Object[]} options.pageData - Page data used to render the plot
   * @param {Object} options.plotOptions - Original plot options
   */
  registerPlot(plotId, plotInstance, options) {
    const { type, pageData, plotOptions } = options;

    // Store plot info
    this._registeredPlots.set(plotId, {
      instance: plotInstance,
      type,
      pageData,
      plotOptions,
      element: plotInstance._container || plotInstance
    });

    // Attach Plotly click handler
    const element = plotInstance._container || plotInstance;

    if (element && typeof element.on === 'function') {
      element.on('plotly_click', (data) => {
        this._handlePlotClick(plotId, data);
      });

      element.on('plotly_hover', (data) => {
        this._handlePlotHover(plotId, data);
      });

      element.on('plotly_unhover', () => {
        this._clearHover();
      });
    } else if (element instanceof HTMLElement) {
      // For DOM elements, attach via event delegation
      element.addEventListener('plotly_click', (event) => {
        if (event.detail) {
          this._handlePlotClick(plotId, event.detail);
        }
      });
    }

    console.debug(`[CrossHighlight] Registered plot: ${plotId} (${type})`);
  }

  /**
   * Unregister a plot
   * @param {string} plotId - Plot identifier
   */
  unregisterPlot(plotId) {
    const plotInfo = this._registeredPlots.get(plotId);
    if (plotInfo) {
      // Remove event listeners if possible
      const element = plotInfo.element;
      if (element && typeof element.removeAllListeners === 'function') {
        element.removeAllListeners('plotly_click');
        element.removeAllListeners('plotly_hover');
        element.removeAllListeners('plotly_unhover');
      }
    }

    this._registeredPlots.delete(plotId);
  }

  /**
   * Set the embedding view for highlighting
   * @param {Object} embeddingView - Embedding view instance
   */
  setEmbeddingView(embeddingView) {
    this.embeddingView = embeddingView;
  }

  // ===========================================================================
  // EVENT HANDLING
  // ===========================================================================

  /**
   * Handle click on plot element
   */
  _handlePlotClick(plotId, data) {
    if (!data || !data.points || data.points.length === 0) return;

    const plotInfo = this._registeredPlots.get(plotId);
    if (!plotInfo) return;

    const point = data.points[0];
    const { type, pageData, plotOptions } = plotInfo;

    // Extract cell indices based on plot type
    let cellIndices = [];
    let metadata = {};

    switch (type) {
      case 'barplot':
        cellIndices = this._getCellsFromBarplot(point, pageData, plotOptions);
        metadata = {
          category: point.x || point.y,
          count: point.y || point.x,
          pageName: point.data.name
        };
        break;

      case 'histogram':
        cellIndices = this._getCellsFromHistogram(point, pageData, plotOptions);
        metadata = {
          binStart: point.x - (point.width || 0) / 2,
          binEnd: point.x + (point.width || 0) / 2,
          count: point.y,
          pageName: point.data.name
        };
        break;

      case 'violinplot':
      case 'boxplot':
        cellIndices = this._getCellsFromViolin(point, pageData, plotOptions);
        metadata = {
          pageName: point.data.name,
          side: point.side
        };
        break;

      case 'scatterplot':
        cellIndices = this._getCellsFromScatter(point, pageData);
        metadata = {
          x: point.x,
          y: point.y,
          pageName: point.data.name
        };
        break;

      case 'heatmap':
        cellIndices = this._getCellsFromHeatmap(point, pageData);
        metadata = {
          row: point.y,
          col: point.x,
          value: point.z
        };
        break;

      default:
        // Generic: try to use pointIndex
        if (point.pointIndex !== undefined && pageData.length > 0) {
          const traceIdx = point.curveNumber || 0;
          const pd = pageData[traceIdx];
          if (pd && pd.cellIndices) {
            cellIndices = [pd.cellIndices[point.pointIndex]];
          }
        }
    }

    if (cellIndices.length > 0) {
      this._setSelection({
        source: 'plot',
        plotId,
        cellIndices,
        metadata
      });
    }
  }

  /**
   * Handle hover on plot element (for preview highlighting)
   */
  _handlePlotHover(plotId, data) {
    if (!data || !data.points || data.points.length === 0) return;
    if (!this.embeddingView) return;

    // For hover, we just preview without updating the formal selection
    const plotInfo = this._registeredPlots.get(plotId);
    if (!plotInfo) return;

    const point = data.points[0];
    const { type, pageData, plotOptions } = plotInfo;

    let cellIndices = [];

    // Use same logic as click but for preview
    switch (type) {
      case 'barplot':
        cellIndices = this._getCellsFromBarplot(point, pageData, plotOptions);
        break;
      case 'histogram':
        cellIndices = this._getCellsFromHistogram(point, pageData, plotOptions);
        break;
      default:
        // Skip hover preview for other types
        return;
    }

    if (cellIndices.length > 0 && this.embeddingView.previewHighlight) {
      this.embeddingView.previewHighlight(cellIndices);
    }
  }

  /**
   * Clear hover preview
   */
  _clearHover() {
    if (this.embeddingView && this.embeddingView.clearPreview) {
      this.embeddingView.clearPreview();
    }
  }

  // ===========================================================================
  // CELL INDEX EXTRACTION BY PLOT TYPE
  // ===========================================================================

  /**
   * Get cell indices from barplot category click
   */
  _getCellsFromBarplot(point, pageData, options) {
    const category = options.orientation === 'horizontal' ? point.y : point.x;
    const traceName = point.data.name;

    // Find the page data matching this trace
    const pd = pageData.find(p => p.pageName === traceName);
    if (!pd || !pd.values || !pd.cellIndices) return [];

    // Find cells with this category value
    const cellIndices = [];
    for (let i = 0; i < pd.values.length; i++) {
      if (pd.values[i] === category) {
        cellIndices.push(pd.cellIndices[i]);
      }
    }

    return cellIndices;
  }

  /**
   * Get cell indices from histogram bin click
   */
  _getCellsFromHistogram(point, pageData, options) {
    const traceName = point.data.name;

    // Plotly histogram points have binning info
    // We need to find all cells in this bin range
    const binStart = point.x - (point.width || 0) / 2;
    const binEnd = point.x + (point.width || 0) / 2;

    const pd = pageData.find(p => p.pageName === traceName);
    if (!pd || !pd.values || !pd.cellIndices) return [];

    const cellIndices = [];
    for (let i = 0; i < pd.values.length; i++) {
      const v = pd.values[i];
      if (typeof v === 'number' && v >= binStart && v < binEnd) {
        cellIndices.push(pd.cellIndices[i]);
      }
    }

    return cellIndices;
  }

  /**
   * Get cell indices from violin/box click
   * For violin, clicking selects all cells in that distribution
   */
  _getCellsFromViolin(point, pageData) {
    const traceName = point.data.name;

    const pd = pageData.find(p => p.pageName === traceName);
    if (!pd || !pd.cellIndices) return [];

    // Return all cells for this page (violin represents entire distribution)
    return [...pd.cellIndices];
  }

  /**
   * Get cell indices from scatter point click
   */
  _getCellsFromScatter(point, pageData) {
    const traceIdx = point.curveNumber || 0;
    const pd = pageData[traceIdx];

    if (!pd || !pd.cellIndices) return [];

    const pointIdx = point.pointIndex;
    if (pointIdx !== undefined && pd.cellIndices[pointIdx] !== undefined) {
      return [pd.cellIndices[pointIdx]];
    }

    return [];
  }

  /**
   * Get cell indices from heatmap cell click
   */
  _getCellsFromHeatmap(point, pageData) {
    // Heatmap clicks typically don't map to individual cells
    // but to aggregated values. Return empty for now.
    return [];
  }

  // ===========================================================================
  // SELECTION MANAGEMENT
  // ===========================================================================

  /**
   * Set the current cross-highlight selection
   */
  _setSelection(selection) {
    this._currentSelection = selection;

    // Highlight in embedding view
    if (this.embeddingView && selection.cellIndices.length > 0) {
      this.embeddingView.highlightCells(selection.cellIndices, {
        source: 'analysis',
        metadata: selection.metadata
      });
    }

    // Emit event
    this._emit('selection', selection);

    // Call callback
    if (this.onSelectionChange) {
      this.onSelectionChange(selection);
    }

    // Show notification with action
    if (selection.cellIndices.length > 0) {
      this._showSelectionNotification(selection);
    }
  }

  /**
   * Show notification with action to save selection as page
   */
  _showSelectionNotification(selection) {
    const count = selection.cellIndices.length;
    const metadata = selection.metadata;

    let message = `${count.toLocaleString()} cells selected`;
    if (metadata.category) {
      message = `${count.toLocaleString()} cells in "${metadata.category}"`;
    } else if (metadata.binStart !== undefined) {
      message = `${count.toLocaleString()} cells in bin [${metadata.binStart.toFixed(2)}, ${metadata.binEnd.toFixed(2)})`;
    }

    // Show toast with action button
    this._notifications.show({
      type: 'info',
      category: 'analysis',
      title: 'Selection',
      message,
      duration: 5000,
      actions: [
        {
          label: 'Save as Page',
          handler: () => {
            this._createPageFromSelection(selection);
          }
        },
        {
          label: 'Clear',
          handler: () => {
            this.clearSelection();
          }
        }
      ]
    });
  }

  /**
   * Create a new page from the current selection
   */
  _createPageFromSelection(selection) {
    if (selection.cellIndices.length === 0) {
      this._notifications.warn('No cells selected');
      return;
    }

    if (this.onCreatePage) {
      // Generate page name from metadata
      let pageName = 'Selection';
      if (selection.metadata.category) {
        pageName = `${selection.metadata.category}`;
      } else if (selection.metadata.binStart !== undefined) {
        pageName = `Bin ${selection.metadata.binStart.toFixed(1)}-${selection.metadata.binEnd.toFixed(1)}`;
      }

      this.onCreatePage({
        cellIndices: selection.cellIndices,
        name: pageName,
        source: 'analysis-cross-highlight',
        metadata: selection.metadata
      });
    } else {
      this._notifications.warn('Page creation not available');
    }
  }

  /**
   * Get current selection
   * @returns {Object} Current selection
   */
  getSelection() {
    return { ...this._currentSelection };
  }

  /**
   * Clear the current selection
   */
  clearSelection() {
    this._currentSelection = {
      source: null,
      plotId: null,
      cellIndices: [],
      metadata: {}
    };

    if (this.embeddingView && this.embeddingView.clearHighlight) {
      this.embeddingView.clearHighlight();
    }

    this._emit('selection', this._currentSelection);

    if (this.onSelectionChange) {
      this.onSelectionChange(this._currentSelection);
    }
  }

  /**
   * Programmatically highlight cells from external source
   * @param {number[]} cellIndices - Cell indices to highlight
   * @param {Object} [metadata] - Optional metadata
   */
  highlightCells(cellIndices, metadata = {}) {
    this._setSelection({
      source: 'external',
      plotId: null,
      cellIndices,
      metadata
    });
  }

  // ===========================================================================
  // EVENTS
  // ===========================================================================

  /**
   * Add event listener
   * @param {string} event - Event name ('selection')
   * @param {Function} handler - Handler function
   */
  on(event, handler) {
    if (!this._eventHandlers.has(event)) {
      this._eventHandlers.set(event, []);
    }
    this._eventHandlers.get(event).push(handler);
  }

  /**
   * Remove event listener
   */
  off(event, handler) {
    const handlers = this._eventHandlers.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }

  /**
   * Emit event
   */
  _emit(event, data) {
    const handlers = this._eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (e) {
          console.error('[CrossHighlight] Event handler error:', e);
        }
      }
    }
  }

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  /**
   * Clean up and destroy
   */
  destroy() {
    // Unregister all plots
    for (const plotId of this._registeredPlots.keys()) {
      this.unregisterPlot(plotId);
    }

    this._registeredPlots.clear();
    this._eventHandlers.clear();
    this.clearSelection();
  }
}

// =============================================================================
// FACTORY & EXPORTS
// =============================================================================

let managerInstance = null;

/**
 * Get the singleton CrossHighlightManager instance
 * @param {Object} [options] - Options for initialization
 * @returns {CrossHighlightManager}
 */
export function getCrossHighlightManager(options = {}) {
  if (!managerInstance) {
    managerInstance = new CrossHighlightManager(options);
  }
  return managerInstance;
}

/**
 * Create a new CrossHighlightManager instance
 * @param {Object} options - Manager options
 * @returns {CrossHighlightManager}
 */
export function createCrossHighlightManager(options) {
  return new CrossHighlightManager(options);
}

export default CrossHighlightManager;
