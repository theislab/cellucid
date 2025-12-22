/**
 * FigureContainer - Shared Figure/Plot Container Component
 *
 * Provides a reusable plot container with:
 * - Preview area with loading/empty/error states
 * - Expand to modal functionality
 * - Export toolbar (PNG, SVG, CSV)
 * - Automatic plot cleanup on updates
 * - Summary statistics display
 *
 * Used by: DetailedAnalysisUI, and other analysis types
 *
 * @example
 * const figContainer = createFigureContainer({
 *   container: document.getElementById('figure-area'),
 *   onExportPNG: () => handlePNGExport(),
 *   onExportSVG: () => handleSVGExport(),
 *   onExportCSV: () => handleCSVExport(),
 *   expandable: true
 * });
 *
 * // Render a plot
 * await figContainer.renderPlot(plotType, pageData, options);
 *
 * // Show states
 * figContainer.showLoading();
 * figContainer.showError('Something went wrong');
 * figContainer.showEmpty('Select a variable to see results');
 *
 * // Cleanup
 * figContainer.destroy();
 */

import { loadPlotly, purgePlot, downloadImage } from '../../plots/plotly-loader.js';
import { createLayoutEngine } from '../../plots/layout-engine.js';
import { PlotRegistry } from '../../shared/plot-registry-utils.js';
import { pageDataToCSV, downloadCSV } from '../../shared/analysis-utils.js';
import {
  createAnalysisModal,
  openModal,
  closeModal,
  renderSummaryStats,
  renderStatisticalAnnotations,
  renderPlotOptions,
  createExpandButton
} from '../components/index.js';
import { getNotificationCenter } from '../../../notification-center.js';

/**
 * FigureContainer Class
 *
 * Encapsulates plot container UI logic with preview, modal, and export support.
 */
export class FigureContainer {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.container - Container element to render into
   * @param {Function} [options.onExportPNG] - PNG export handler
   * @param {Function} [options.onExportSVG] - SVG export handler
   * @param {Function} [options.onExportCSV] - CSV export handler
   * @param {Function} [options.onPlotOptionChange] - Plot option change handler
   * @param {boolean} [options.expandable=true] - Show expand button
   * @param {boolean} [options.showStats=true] - Show statistics in modal
   * @param {boolean} [options.showOptions=true] - Show plot options in modal
   * @param {Map} [options.customColors] - Custom page colors map
   */
  constructor(options) {
    this.container = options.container;
    this.onExportPNG = options.onExportPNG;
    this.onExportSVG = options.onExportSVG;
    this.onExportCSV = options.onExportCSV;
    this.onPlotOptionChange = options.onPlotOptionChange;

    // Options with defaults
    this.expandable = options.expandable ?? true;
    this.showStats = options.showStats ?? true;
    this.showOptions = options.showOptions ?? true;
    this.customColors = options.customColors || new Map();

    // State
    this._currentPlotType = null;
    this._currentPageData = null;
    this._currentOptions = {};
    this._layoutEngine = null;
    this._modal = null;

    // DOM references
    this._previewContainer = null;
    this._actionsContainer = null;
    this._plotDiv = null;

    // Notifications
    this._notifications = getNotificationCenter();

    // Render initial state
    this._render();
  }

  /**
   * Render the figure container structure
   */
  _render() {
    this.container.innerHTML = '';
    this.container.className = 'figure-container-component';

    // Preview container
    this._previewContainer = document.createElement('div');
    this._previewContainer.className = 'analysis-preview-container empty';
    this.container.appendChild(this._previewContainer);

    // Actions container
    this._actionsContainer = document.createElement('div');
    this._actionsContainer.className = 'analysis-actions';
    this._actionsContainer.style.display = 'none';
    this.container.appendChild(this._actionsContainer);
  }

  // ===========================================================================
  // State Display Methods
  // ===========================================================================

  /**
   * Show loading state
   */
  showLoading() {
    // Purge any existing plot to prevent WebGL memory leaks
    this._cleanup();
    this._previewContainer.innerHTML = '';
    this._previewContainer.classList.remove('empty');
    this._previewContainer.classList.add('loading');
    this._actionsContainer.style.display = 'none';
  }

  /**
   * Show error state
   * @param {string} message - Error message
   */
  showError(message) {
    this._cleanup();
    this._previewContainer.classList.remove('loading');
    this._previewContainer.classList.add('empty');
    this._previewContainer.innerHTML = `<div class="analysis-error">${message}</div>`;
    this._actionsContainer.style.display = 'none';

    this._notifications.error(message, { category: 'data', title: 'Analysis Error' });
  }

  /**
   * Show empty state
   * @param {string} [message] - Optional message
   */
  showEmpty(message) {
    this._cleanup();
    this._previewContainer.classList.remove('loading');
    this._previewContainer.classList.add('empty');

    if (message) {
      this._previewContainer.innerHTML = `<div class="analysis-empty-message">${message}</div>`;
    } else {
      this._previewContainer.innerHTML = '';
    }

    this._actionsContainer.style.display = 'none';
  }

  // ===========================================================================
  // Plot Rendering
  // ===========================================================================

  /**
   * Render a plot
   * @param {string} plotTypeId - Plot type ID
   * @param {Object[]} pageData - Page data array
   * @param {Object} [options] - Plot options
   * @param {Object} [layoutEngineOptions] - Layout engine options
   * @returns {Promise<void>}
   */
  async renderPlot(plotTypeId, pageData, options = {}, layoutEngineOptions = {}) {
    if (!plotTypeId || !pageData || pageData.length === 0) {
      this.showEmpty('No data to display');
      return;
    }

    this._cleanup();
    this.showLoading();

    try {
      await loadPlotly();

      // Store current state
      this._currentPlotType = plotTypeId;
      this._currentPageData = pageData;
      this._currentOptions = options;

      // Create layout engine
      this._layoutEngine = createLayoutEngine({
        pageCount: pageData.length,
        pageIds: pageData.map(pd => pd.pageId),
        pageNames: pageData.map(pd => pd.pageName),
        syncXAxis: true,
        syncYAxis: true,
        customColors: this.customColors,
        ...layoutEngineOptions
      });

      // Get plot type definition
      const plotType = PlotRegistry.get(plotTypeId);
      if (!plotType) {
        throw new Error(`Unknown plot type: ${plotTypeId}`);
      }

      // Merge options with defaults
      const mergedOptions = PlotRegistry.mergeOptions(plotTypeId, options);

      // Create plot div
      this._previewContainer.classList.remove('loading');
      this._previewContainer.classList.remove('empty');
      this._previewContainer.innerHTML = '';

      this._plotDiv = document.createElement('div');
      this._plotDiv.className = 'analysis-preview-plot';
      this._previewContainer.appendChild(this._plotDiv);

      // Render the plot
      await plotType.render(pageData, mergedOptions, this._plotDiv, this._layoutEngine);

      // Show actions
      this._renderActions();

      // Update modal if open
      if (this._modal?._plotContainer) {
        await this._updateModal(plotType, mergedOptions, pageData);
      }

    } catch (err) {
      console.error('[FigureContainer] Plot render failed:', err);
      this.showError('Failed to render plot: ' + err.message);
    }
  }

  /**
   * Render action buttons
   */
  _renderActions() {
    this._actionsContainer.innerHTML = '';
    this._actionsContainer.style.display = 'flex';

    if (this.expandable) {
      const expandBtn = createExpandButton(() => this._openModal());
      this._actionsContainer.appendChild(expandBtn);
    }
  }

  // ===========================================================================
  // Modal Handling
  // ===========================================================================

  /**
   * Open the expanded modal view
   */
  async _openModal() {
    if (!this._currentPlotType || !this._currentPageData) return;

    this._modal = createAnalysisModal({
      onClose: () => { this._modal = null; },
      onExportPNG: () => this._handleExportPNG(),
      onExportSVG: () => this._handleExportSVG(),
      onExportCSV: () => this._handleExportCSV()
    });

    // Set title
    if (this._modal._title && this._currentPageData[0]?.variableInfo?.name) {
      this._modal._title.textContent = `Comparing: ${this._currentPageData[0].variableInfo.name}`;
    }

    // Render plot options
    if (this.showOptions && this._modal._optionsContent) {
      renderPlotOptions(
        this._modal._optionsContent,
        this._currentPlotType,
        this._currentOptions,
        (key, value) => {
          this._currentOptions[key] = value;
          if (this.onPlotOptionChange) {
            this.onPlotOptionChange(key, value);
          }
          // Re-render with new options
          this._renderModalPlot();
        }
      );
    }

    openModal(this._modal);

    // Render plot in modal
    await this._renderModalPlot();

    // Render statistics
    if (this.showStats && this._modal._statsContent) {
      renderSummaryStats(
        this._modal._statsContent,
        this._currentPageData,
        this._currentPageData[0]?.variableInfo?.name || 'Variable'
      );
    }

    // Render statistical annotations
    if (this._modal._annotationsContent) {
      const dataType = this._currentPageData[0]?.variableInfo?.kind === 'categorical'
        ? 'categorical_obs' : 'continuous_obs';
      renderStatisticalAnnotations(
        this._modal._annotationsContent,
        this._currentPageData,
        dataType
      );
    }
  }

  /**
   * Render plot in modal
   */
  async _renderModalPlot() {
    if (!this._modal?._plotContainer) return;

    try {
      await loadPlotly();

      purgePlot(this._modal._plotContainer);

      const plotType = PlotRegistry.get(this._currentPlotType);
      const mergedOptions = PlotRegistry.mergeOptions(
        this._currentPlotType,
        this._currentOptions
      );

      await plotType.render(
        this._currentPageData,
        mergedOptions,
        this._modal._plotContainer,
        this._layoutEngine
      );
    } catch (err) {
      console.error('[FigureContainer] Modal plot render failed:', err);
      if (this._modal._plotContainer) {
        this._modal._plotContainer.innerHTML = `<div class="analysis-error">Failed to render: ${err.message}</div>`;
      }
    }
  }

  /**
   * Update modal after options change
   */
  async _updateModal(plotType, options, pageData) {
    purgePlot(this._modal._plotContainer);
    await plotType.render(pageData, options, this._modal._plotContainer, this._layoutEngine);

    if (this._modal._statsContent) {
      renderSummaryStats(
        this._modal._statsContent,
        pageData,
        pageData[0]?.variableInfo?.name || 'Variable'
      );
    }
  }

  /**
   * Close modal if open
   */
  closeModal() {
    if (this._modal) {
      closeModal(this._modal);
      this._modal = null;
    }
  }

  // ===========================================================================
  // Export Handlers
  // ===========================================================================

  /**
   * Handle PNG export
   */
  async _handleExportPNG() {
    if (this.onExportPNG) {
      this.onExportPNG();
      return;
    }

    // Default export behavior
    const container = this._modal?._plotContainer || this._plotDiv;
    if (!container) return;

    try {
      await downloadImage(container, {
        format: 'png',
        width: 1200,
        height: 800,
        filename: 'analysis'
      });
      this._notifications.success('Plot exported as PNG', { category: 'download' });
    } catch (err) {
      this._notifications.error('PNG export failed: ' + err.message, { category: 'download' });
    }
  }

  /**
   * Handle SVG export
   */
  async _handleExportSVG() {
    if (this.onExportSVG) {
      this.onExportSVG();
      return;
    }

    // Default export behavior
    const container = this._modal?._plotContainer || this._plotDiv;
    if (!container) return;

    try {
      await downloadImage(container, {
        format: 'svg',
        width: 1200,
        height: 800,
        filename: 'analysis'
      });
      this._notifications.success('Plot exported as SVG', { category: 'download' });
    } catch (err) {
      this._notifications.error('SVG export failed: ' + err.message, { category: 'download' });
    }
  }

  /**
   * Handle CSV export
   */
  async _handleExportCSV() {
    if (this.onExportCSV) {
      this.onExportCSV();
      return;
    }

    // Default export behavior
    if (!this._currentPageData || this._currentPageData.length === 0) return;

    try {
      const variableName =
        this._currentPageData?.[0]?.variableInfo?.name ||
        this._currentPageData?.[0]?.variableInfo?.key ||
        'value';
      const csv = pageDataToCSV(this._currentPageData, variableName);
      downloadCSV(csv, 'analysis-data', this._notifications);
    } catch (err) {
      this._notifications.error('CSV export failed: ' + err.message, { category: 'download' });
    }
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Get the current plot div element
   * @returns {HTMLElement|null}
   */
  getPlotElement() {
    return this._plotDiv;
  }

  /**
   * Get the modal plot element (if modal is open)
   * @returns {HTMLElement|null}
   */
  getModalPlotElement() {
    return this._modal?._plotContainer || null;
  }

  /**
   * Get the current page data
   * @returns {Object[]|null}
   */
  getPageData() {
    return this._currentPageData;
  }

  /**
   * Get the current plot type
   * @returns {string|null}
   */
  getPlotType() {
    return this._currentPlotType;
  }

  /**
   * Get the current options
   * @returns {Object}
   */
  getOptions() {
    return { ...this._currentOptions };
  }

  /**
   * Update custom colors
   * @param {Map} colors
   */
  setCustomColors(colors) {
    this.customColors = colors;
    if (this._layoutEngine) {
      this._layoutEngine.setCustomColors(colors);
    }
  }

  /**
   * Check if there's a plot rendered
   * @returns {boolean}
   */
  hasPlot() {
    return !!(this._plotDiv && this._currentPageData);
  }

  /**
   * Cleanup previous plot
   */
  _cleanup() {
    if (this._plotDiv) {
      purgePlot(this._plotDiv);
      this._plotDiv = null;
    }

    if (this._modal?._plotContainer) {
      purgePlot(this._modal._plotContainer);
    }
  }

  /**
   * Refresh the plot (re-render with current data and options)
   */
  async refresh() {
    if (this._currentPlotType && this._currentPageData) {
      await this.renderPlot(
        this._currentPlotType,
        this._currentPageData,
        this._currentOptions
      );
    }
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
    this._cleanup();
    this.closeModal();

    this._currentPlotType = null;
    this._currentPageData = null;
    this._currentOptions = {};
    this._layoutEngine = null;

    this.container.innerHTML = '';
  }
}

/**
 * Factory function to create FigureContainer
 * @param {Object} options
 * @returns {FigureContainer}
 */
export function createFigureContainer(options) {
  return new FigureContainer(options);
}

export default FigureContainer;
