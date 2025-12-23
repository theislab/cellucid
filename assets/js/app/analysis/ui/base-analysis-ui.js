/**
 * BaseAnalysisUI - Abstract Base Class for Analysis UI Components
 *
 * Provides common functionality shared by all analysis UI modes:
 * - Container initialization
 * - Notification integration
 * - Page change handling
 * - Modal management
 * - Export functionality (PNG, SVG, CSV)
 * - Cleanup and lifecycle management
 * - Shared component factories (PageSelector, VariableSelector, FigureContainer)
 * - Page requirements validation system
 *
 * All analysis UIs (Detailed, Quick, Advanced, Correlation, DE, Signature)
 * should extend this class and implement the abstract methods.
 *
 * REQUIREMENTS SYSTEM:
 * - Subclasses can define static getRequirements() to specify page constraints
 * - Use validatePageRequirements() to check if requirements are met
 * - Use getRequirementText() to get human-readable requirement description
 *
 * @example
 * class MyAnalysisUI extends BaseAnalysisUI {
 *   static getRequirements() {
 *     return { minPages: 2, maxPages: 2, description: 'Select exactly 2 pages' };
 *   }
 *
 *   constructor(options) {
 *     super(options);
 *     // Additional initialization
 *   }
 *
 *   _render() {
 *     // Use shared components:
 *     this._pageSelector = this._createPageSelector(container);
 *     this._varSelector = this._createVariableSelector(container);
 *     this._figureContainer = this._createFigureContainer(container);
 *   }
 * }
 */

import { getNotificationCenter } from '../../notification-center.js';
import {
  validatePageRequirements,
  getRequirementText,
  pageDataToCSV,
  downloadCSV
} from '../shared/analysis-utils.js';
import { formatCount } from '../shared/formatting.js';
import { createAnalysisModal, openModal, closeModal } from './components/modal.js';
import { loadPlotly, purgePlot, downloadImage } from '../plots/plotly-loader.js';
import { PlotRegistry } from '../shared/plot-registry-utils.js';
import { createPageSelectorComponent } from './shared/page-selector.js';
import { createVariableSelectorComponent } from './shared/variable-selector.js';
import { createFigureContainer } from './shared/figure-container.js';

function cloneSettings(value) {
  if (value == null) return value;
  try {
    // structuredClone is supported in all modern browsers we target.
    return structuredClone(value);
  } catch (_err) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_err2) {
      // Fall back to returning as-is (best effort); callers must avoid mutating.
      return value;
    }
  }
}

/**
 * Abstract base class for all analysis UI components
 */
export class BaseAnalysisUI {
  /**
   * @param {Object} options
   * @param {Object} options.comparisonModule - Reference to main comparison module
   * @param {Object} options.dataLayer - Enhanced data layer
   * @param {Function} [options.onConfigChange] - Callback when config changes
   */
  constructor(options) {
    this.comparisonModule = options.comparisonModule;
    this.dataLayer = options.dataLayer;
    this.onConfigChange = options.onConfigChange;
    this._instanceId = options.instanceId || '';

    this._notifications = getNotificationCenter();

    // UI containers
    this._container = null;
    this._controlsContainer = null;
    this._previewContainer = null;
    this._actionsContainer = null;

    // Modal reference
    this._modal = null;

    // Selected pages - UNIFIED across all analysis types
    this._selectedPages = [];

    // Current analysis configuration (pages mirrored from _selectedPages).
    this._currentConfig = {
      dataSource: {
        type: '',
        variable: ''
      },
      pages: [],
      plotType: '',
      plotOptions: {}
    };

    // Current data
    this._currentPageData = null;

    // Last analysis result
    this._lastResult = null;

    // Loading state
    this._isLoading = false;

    // Persistent page colors (shared with Highlighted Cells UI via DataState).
    // This Map instance is passed through to plotting so updates propagate without rebuilding objects.
    this._pageColorMap = new Map();

    // Debounce timer
    this._updateTimer = null;

    // Lifecycle guard (prevents async work from updating after teardown)
    this._isDestroyed = false;
  }

  // ===========================================================================
  // Requirements System
  // ===========================================================================

  /**
   * Get page requirements for this analysis type (override in subclass)
   * @static
   * @returns {{ minPages?: number, maxPages?: number, description?: string }|null}
   */
  static getRequirements() {
    return null; // No requirements by default
  }

  /**
   * Validate page requirements against current selection
   * @param {string[]} pageIds - Page IDs to validate
   * @returns {{ valid: boolean, error?: string }}
   */
  validatePages(pageIds) {
    const requirements = this.constructor.getRequirements();
    if (!requirements) return { valid: true };
    return validatePageRequirements(pageIds, requirements);
  }

  /**
   * Get human-readable requirement text for this analysis type
   * @returns {string}
   */
  getRequirementText() {
    const requirements = this.constructor.getRequirements();
    if (!requirements) return 'No specific requirements';
    return getRequirementText(requirements);
  }

  /**
   * Check if current page selection meets requirements
   * @returns {boolean}
   */
  meetsPageRequirements() {
    return this.validatePages(this._selectedPages).valid;
  }

  // ===========================================================================
  // Abstract Methods (must be implemented by subclasses)
  // ===========================================================================

  /**
   * Render the complete UI structure
   * @abstract
   */
  _render() {
    throw new Error('_render() must be implemented by subclass');
  }

  /**
   * Render the control panel
   * @abstract
   */
  _renderControls() {
    throw new Error('_renderControls() must be implemented by subclass');
  }

  // ===========================================================================
  // Public API Methods
  // ===========================================================================

  /**
   * Initialize the analysis UI
   * @param {HTMLElement} container - Container for the UI
   */
  init(container) {
    this._isDestroyed = false;
    this._container = container;
    this._render();

    // Auto-select all pages
    const pages = this.dataLayer.getPages();
    if (pages.length > 0) {
      this._selectedPages = pages.map(p => p.id);
      this._currentConfig.pages = this._selectedPages;
    }
  }

  /**
   * Get current configuration
   * @returns {Object}
   */
  getConfig() {
    return { ...this._currentConfig };
  }

  /**
   * Set configuration
   * @param {Object} config
   */
  setConfig(config) {
    this._currentConfig = { ...this._currentConfig, ...config };
    this._renderControls();
    this._scheduleUpdate();
  }

  /**
   * Export a settings-only snapshot for cloning/copying.
   * Results (plots/data) are intentionally excluded.
   * @returns {{ selectedPages: string[], config: Object }}
   */
  exportSettings() {
    return {
      selectedPages: [...this._selectedPages],
      config: cloneSettings(this._currentConfig)
    };
  }

  /**
   * Import a settings snapshot previously produced by exportSettings().
   * @param {{ selectedPages?: string[], config?: Object }|null} settings
   */
  importSettings(settings) {
    if (!settings) return;
    const selectedPages = Array.isArray(settings.selectedPages) ? settings.selectedPages : null;
    const config = settings.config && typeof settings.config === 'object' ? settings.config : null;

    // Apply page selection first so dependent controls (e.g., page selectors) render correctly.
    if (selectedPages && typeof this.onPageSelectionChange === 'function') {
      this.onPageSelectionChange([...selectedPages]);
    }

    if (config && typeof this.setConfig === 'function') {
      // Preserve the explicitly imported page selection if provided.
      const merged = selectedPages ? { ...config, pages: [...selectedPages] } : config;
      this.setConfig(cloneSettings(merged));
    }
  }

  // ===========================================================================
  // Page/Highlight Change Handlers
  // ===========================================================================

  /**
   * Handle page selection change - UNIFIED METHOD
   * All analysis UIs should use this method for page change notifications.
   * This is the primary method called by AnalysisUIManager.
   * @param {string[]} pageIds - Selected page IDs
   */
  onPageSelectionChange(pageIds) {
    this._selectedPages = pageIds || [];
    this._currentConfig.pages = this._selectedPages;
    this._renderControls();
    this._scheduleUpdate();
  }

  /**
   * Get the currently selected page IDs
   * @returns {string[]}
   */
  getSelectedPages() {
    return [...this._selectedPages];
  }

  /**
   * Update when highlights change (cells added/removed from pages)
   */
  onHighlightChanged() {
    this._updatePageSelectorCounts();

    if (this._selectedPages.length > 0 && this._currentConfig.dataSource.variable) {
      this._scheduleUpdate();
    }
  }

  /**
   * Get the last analysis result
   * @returns {Object|null}
   */
  getLastResult() {
    return this._lastResult;
  }

  /**
   * Check if analysis is currently loading
   * @returns {boolean}
   */
  isLoading() {
    return this._isLoading;
  }

  /**
   * Update page selector counts (override for custom implementation)
   */
  _updatePageSelectorCounts() {
    if (!this._controlsContainer) return;

    const pageTabs = this._controlsContainer.querySelectorAll('.analysis-page-tab');
    pageTabs.forEach(tab => {
      const pageId = tab.dataset.pageId;
      if (pageId) {
        const countSpan = tab.querySelector('.analysis-page-count');
        if (countSpan) {
          const cellCount = this.dataLayer.getCellIndicesForPage(pageId).length;
          countSpan.textContent = cellCount > 0 ? formatCount(cellCount) : '(0)';
        }
      }
    });
  }

  // ===========================================================================
  // Common Helper Methods
  // ===========================================================================

  /**
   * Check if analysis can run (common validation)
   * @returns {boolean}
   */
  _canRunAnalysis() {
    return (
      this._currentConfig.dataSource.variable &&
      this._selectedPages.length > 0 &&
      this._currentConfig.plotType
    );
  }

  /**
   * Schedule an update with debouncing
   * @param {number} delay - Debounce delay in ms (default 300)
   */
  _scheduleUpdate(delay = 300) {
    if (this._isDestroyed) return;
    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
    }
    this._updateTimer = setTimeout(() => {
      this._runAnalysisIfValid();
    }, delay);
  }

  /**
   * Run analysis if configuration is valid (override for custom logic)
   */
  async _runAnalysisIfValid() {
    if (this._isDestroyed) return;
    if (!this._canRunAnalysis()) {
      this._hidePreview();
      return;
    }

    try {
      await this._runAnalysis();
    } catch (err) {
      console.error(`[${this.constructor.name}] Analysis failed:`, err);
      this._showError('Analysis failed: ' + err.message);
    }
  }

  /**
   * Run the analysis (override in subclass)
   */
  async _runAnalysis() {
    throw new Error('_runAnalysis() must be implemented by subclass');
  }

  // ===========================================================================
  // Preview & Error Display
  // ===========================================================================

  /**
   * Hide the preview area
   */
  _hidePreview() {
    if (this._previewContainer) {
      // Purge any existing plot to prevent WebGL memory leaks
      const plotEl = this._previewContainer.querySelector('.analysis-preview-plot');
      if (plotEl) purgePlot(plotEl);
      this._previewContainer.innerHTML = '';
      this._previewContainer.classList.add('empty');
      this._previewContainer.classList.remove('loading');
    }
    if (this._actionsContainer) {
      this._actionsContainer.style.display = 'none';
    }
  }

  /**
   * Show loading state in preview
   */
  _showLoading() {
    if (this._previewContainer) {
      this._previewContainer.classList.remove('empty');
      this._previewContainer.classList.add('loading');
    }
  }

  /**
   * Show error message
   * @param {string} message
   */
  _showError(message) {
    if (this._previewContainer) {
      this._previewContainer.classList.remove('loading');
      this._previewContainer.classList.add('empty');
      this._previewContainer.textContent = '';
      const errorEl = document.createElement('div');
      errorEl.className = 'analysis-error';
      errorEl.textContent = message ?? '';
      this._previewContainer.appendChild(errorEl);
    }
    if (this._actionsContainer) {
      this._actionsContainer.style.display = 'none';
    }

    this._notifications.error(message, { category: 'data', title: 'Analysis Error' });
  }

  // ===========================================================================
  // Export Functionality
  // ===========================================================================

  /**
   * Export plot as PNG
   * @param {HTMLElement} [container] - Plot container (optional, uses preview by default)
   * @param {Object} [options] - Export options
   */
  async _exportPNG(container, options = {}) {
    const plotContainer = container || this._modal?._plotContainer ||
      this._previewContainer?.querySelector('.analysis-preview-plot');

    if (!plotContainer) return;

    try {
      await downloadImage(plotContainer, {
        format: 'png',
        width: options.width || 1200,
        height: options.height || 800,
        filename: options.filename || 'analysis'
      });
      this._notifications.success('Plot exported as PNG', { category: 'download' });
    } catch (err) {
      this._notifications.error('PNG export failed: ' + err.message, { category: 'download' });
    }
  }

  /**
   * Export plot as SVG
   * @param {HTMLElement} [container] - Plot container
   * @param {Object} [options] - Export options
   */
  async _exportSVG(container, options = {}) {
    const plotContainer = container || this._modal?._plotContainer ||
      this._previewContainer?.querySelector('.analysis-preview-plot');

    if (!plotContainer) return;

    try {
      await downloadImage(plotContainer, {
        format: 'svg',
        width: options.width || 1200,
        height: options.height || 800,
        filename: options.filename || 'analysis'
      });
      this._notifications.success('Plot exported as SVG', { category: 'download' });
    } catch (err) {
      this._notifications.error('SVG export failed: ' + err.message, { category: 'download' });
    }
  }

  /**
   * Export data as CSV
   * @param {Object[]} pageData - Page data to export
   * @param {string} variableName - Variable name for header
   * @param {string} [filename] - Output filename
   */
  async _exportCSV(pageData, variableName, filename = 'analysis-data.csv') {
    if (!pageData || pageData.length === 0) return;

    try {
      const csv = pageDataToCSV(pageData, variableName || 'value');
      const baseName = String(filename || 'analysis-data').replace(/\.csv$/i, '');
      downloadCSV(csv, baseName, this._notifications);
    } catch (err) {
      this._notifications.error('CSV export failed: ' + err.message, { category: 'download' });
    }
  }

  // ===========================================================================
  // Modal Management
  // ===========================================================================

  /**
   * Create and open an analysis modal
   * @param {Object} config - Modal configuration
   * @returns {Object} Modal instance
   */
  _createModal(config = {}) {
    this._modal = createAnalysisModal({
      onClose: () => { this._modal = null; },
      onExportPNG: () => this._exportPNG(),
      onExportSVG: () => this._exportSVG(),
      onExportCSV: () => this._exportCSV(
        this._currentPageData,
        this._currentConfig.dataSource.variable
      ),
      ...config
    });

    return this._modal;
  }

  /**
   * Open the modal
   */
  _openModal() {
    if (this._modal) {
      openModal(this._modal);
    }
  }

  /**
   * Close the modal
   */
  _closeModal() {
    if (this._modal) {
      closeModal(this._modal);
      this._modal = null;
    }
  }

  // ===========================================================================
  // Shared Component Factories
  // ===========================================================================

  /**
   * Create a PageSelectorComponent instance
   * @param {HTMLElement} container - Container to render into
   * @param {Object} [options] - Additional options
   * @returns {Object} PageSelectorComponent instance
   */
  _createPageSelector(container, options = {}) {
    return createPageSelectorComponent({
      dataLayer: this.dataLayer,
      container,
      onSelectionChange: (pageIds) => this._onPageSelectionChange(pageIds),
      onColorChange: (pageId, color) => this._onPageColorChange(pageId, color),
      initialSelection: this._selectedPages,
      ...options
    });
  }

  /**
   * Create a VariableSelectorComponent instance
   * @param {HTMLElement} container - Container to render into
   * @param {Object} [options] - Additional options
   * @returns {Object} VariableSelectorComponent instance
   */
  _createVariableSelector(container, options = {}) {
    return createVariableSelectorComponent({
      dataLayer: this.dataLayer,
      container,
      onVariableChange: (type, variable) => this._onVariableChange(type, variable),
      initialSelection: this._currentConfig.dataSource,
      ...options
    });
  }

  /**
   * Create a FigureContainer instance
   * @param {HTMLElement} container - Container to render into
   * @param {Object} [options] - Additional options
   * @returns {Object} FigureContainer instance
   */
  _createFigureContainer(container, options = {}) {
    this._syncPageColorMapFromState();
    return createFigureContainer({
      container,
      onExportPNG: () => this._exportPNG(),
      onExportSVG: () => this._exportSVG(),
      onExportCSV: () => this._exportCSV(
        this._currentPageData,
        this._currentConfig.dataSource.variable
      ),
      onPlotOptionChange: (key, value) => this._onPlotOptionChange(key, value),
      customColors: this._pageColorMap,
      ...options
    });
  }

  // ===========================================================================
  // Shared Component Event Handlers (override in subclass if needed)
  // ===========================================================================

  /**
   * Handle page selection change from PageSelector
   * @param {string[]} pageIds - Selected page IDs
   */
  _onPageSelectionChange(pageIds) {
    this._selectedPages = pageIds;
    this._currentConfig.pages = this._selectedPages;
    this._syncPageColorMapFromState();
    this._scheduleUpdate();

    if (this.onConfigChange) {
      this.onConfigChange(this._currentConfig);
    }
  }

  /**
   * Handle page color change from PageSelector
   * @param {string} pageId - Page ID
   * @param {string} color - New color
   */
  _onPageColorChange(pageId, color) {
    this.dataLayer?.setPageColor?.(pageId, color);
    this._syncPageColorMapFromState();
    this._scheduleUpdate();
  }

  _syncPageColorMapFromState() {
    this._pageColorMap.clear();
    const pages = this.dataLayer?.getPages?.() || [];
    for (const page of pages) {
      if (!page?.id) continue;
      const color = page.color || this.dataLayer?.getPageColor?.(page.id) || null;
      if (color) this._pageColorMap.set(page.id, color);
    }
  }

  /**
   * Handle variable change from VariableSelector
   * @param {string} type - Variable type
   * @param {string} variable - Variable key
   */
  _onVariableChange(type, variable) {
    this._currentConfig.dataSource = { type, variable };
    this._updatePlotTypeForDataKind(type);
    this._renderControls();
    this._scheduleUpdate();
  }

  /**
   * Handle plot option change
   * @param {string} key - Option key
   * @param {*} value - Option value
   */
  _onPlotOptionChange(key, value) {
    this._currentConfig.plotOptions[key] = value;
    this._scheduleUpdate();
  }

  /**
   * Update plot type for data kind (categorical vs continuous)
   * @param {string} type - Variable type
   */
  _updatePlotTypeForDataKind(type) {
    const kind = type === 'categorical_obs' ? 'categorical' : 'continuous';
    const compatiblePlots = PlotRegistry.getForDataType(kind);
    const currentPlotCompatible = compatiblePlots.find(
      p => p.id === this._currentConfig.plotType
    );

    if (!currentPlotCompatible && compatiblePlots.length > 0) {
      this._currentConfig.plotType = compatiblePlots[0].id;
      this._currentConfig.plotOptions = {};
    }
  }

  // ===========================================================================
  // Data Fetching Helpers
  // ===========================================================================

  /**
   * Fetch analysis data for current configuration
   * @returns {Promise<Object[]|null>} Page data array or null
   */
  async _fetchAnalysisData() {
    if (!this._canRunAnalysis()) return null;

    const { type, variable } = this._currentConfig.dataSource;
    return this.dataLayer.getDataForPages({
      type,
      variableKey: variable,
      pageIds: this._selectedPages
    });
  }

  // ===========================================================================
  // Cleanup & Lifecycle
  // ===========================================================================

  /**
   * Cleanup previous analysis data
   */
  _cleanupPreviousAnalysis() {
    if (this._previewContainer) {
      const plotEl = this._previewContainer.querySelector('.analysis-preview-plot');
      if (plotEl) purgePlot(plotEl);
    }

    if (this._modal?._plotContainer) {
      purgePlot(this._modal._plotContainer);
    }

    this._currentPageData = null;
  }

  /**
   * Destroy and cleanup the component
   */
  destroy() {
    this._isDestroyed = true;
    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
    }

    this._cleanupPreviousAnalysis();

    if (this._modal) {
      closeModal(this._modal);
      this._modal = null;
    }

    if (this._container) {
      this._container.innerHTML = '';
    }

    // Clear state
    this._selectedPages = [];
    this._lastResult = null;
    this._isLoading = false;
  }
}

/**
 * Factory function to create analysis UI instance
 * @param {Function} UIClass - UI class constructor
 * @param {Object} options - Options for the UI
 * @returns {Object} UI instance
 */
export function createAnalysisUI(UIClass, options) {
  const ui = new UIClass(options);
  return ui;
}

export default BaseAnalysisUI;
