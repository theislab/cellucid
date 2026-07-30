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
import { createRequestIdTracker } from '../shared/cancellable-operation.js';
import { setOwnDataProperty } from '../../../utils/exact-record.js';

function cloneSettings(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(
      `${label} must contain exactly: ${sortedExpected.join(', ')}`
    );
  }
}

function requirePageIds(pageIds, label) {
  if (!Array.isArray(pageIds)) {
    throw new TypeError(`${label} must be an array`);
  }
  const seen = new Set();
  for (const pageId of pageIds) {
    if (typeof pageId !== 'string' || pageId.length === 0) {
      throw new TypeError(`${label} must contain non-empty string page IDs`);
    }
    if (seen.has(pageId)) {
      throw new TypeError(`${label} contains duplicate page ID "${pageId}"`);
    }
    seen.add(pageId);
  }
}

function requireAnalysisConfig(config) {
  requireExactKeys(
    config,
    ['dataSource', 'pages', 'plotOptions', 'plotType'],
    'Analysis config'
  );
  requireExactKeys(
    config.dataSource,
    ['type', 'variable'],
    'Analysis config dataSource'
  );
  const allowedTypes = new Set([
    '',
    'categorical_obs',
    'continuous_obs',
    'gene_expression'
  ]);
  if (
    typeof config.dataSource.type !== 'string' ||
    !allowedTypes.has(config.dataSource.type)
  ) {
    throw new TypeError('Analysis config dataSource.type is unsupported');
  }
  if (typeof config.dataSource.variable !== 'string') {
    throw new TypeError('Analysis config dataSource.variable must be a string');
  }
  if (
    (config.dataSource.type.length === 0) !==
    (config.dataSource.variable.length === 0)
  ) {
    throw new TypeError(
      'Analysis config dataSource type and variable must both be empty or both be selected'
    );
  }
  requirePageIds(config.pages, 'Analysis config pages');
  if (typeof config.plotType !== 'string') {
    throw new TypeError('Analysis config plotType must be a string');
  }
  if (!isPlainObject(config.plotOptions)) {
    throw new TypeError('Analysis config plotOptions must be an object');
  }
}

function requireMatchingPages(selectedPages, configPages) {
  if (
    selectedPages.length !== configPages.length ||
    selectedPages.some((pageId, index) => pageId !== configPages[index])
  ) {
    throw new TypeError(
      'Analysis settings selectedPages must exactly match config.pages'
    );
  }
}

function combineLifecycleErrors(errors, message) {
  const present = [...new Set(errors.filter(Boolean))];
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  return new AggregateError(present, message);
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

    // One monotonic owner for analysis intent, computation, and publication.
    // Generations are deliberately used instead of worker AbortSignals because
    // aborting one running task is terminal for the shared worker pool.
    this._analysisRequestTracker = createRequestIdTracker();
    this._activeAnalysisRequestId = null;
    this._analysisInvalidationOwner = null;
    this._interactiveTasks = new Set();
    this._interactiveFailures = [];
    this._baseDestroyPromise = null;
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

    if (this._selectedPages.length === 0) {
      const pages = this.dataLayer.getPages();
      const selectablePageIds = pages
        .filter(page => this.dataLayer.getCellCountForPageId(page.id) > 0)
        .map(page => page.id);
      this._selectedPages = selectablePageIds;
      this._currentConfig.pages = [...selectablePageIds];
    }
  }

  /**
   * Get current configuration
   * @returns {Object}
   */
  getConfig() {
    requireAnalysisConfig(this._currentConfig);
    requireMatchingPages(this._selectedPages, this._currentConfig.pages);
    return cloneSettings(this._currentConfig);
  }

  /**
   * Set configuration
   * @param {Object} config
   */
  setConfig(config) {
    requireAnalysisConfig(config);
    requireMatchingPages(this._selectedPages, config.pages);
    this._currentConfig = cloneSettings(config);
    this._renderControls();
    this._scheduleUpdate();
  }

  /**
   * Export a settings-only snapshot for cloning/copying.
   * Results (plots/data) are intentionally excluded.
   * @returns {{ selectedPages: string[], config: Object }}
   */
  exportSettings() {
    requirePageIds(this._selectedPages, 'Analysis selectedPages');
    this._requireAvailableSelectedPages(
      this._selectedPages,
      'Analysis selectedPages'
    );
    requireAnalysisConfig(this._currentConfig);
    requireMatchingPages(this._selectedPages, this._currentConfig.pages);
    return {
      selectedPages: [...this._selectedPages],
      config: cloneSettings(this._currentConfig)
    };
  }

  /**
   * Require the complete settings key set owned by a concrete subclass.
   * @param {unknown} settings
   * @param {string[]} expectedKeys
   * @param {string} label
   * @protected
   */
  _requireExactSettingsKeys(settings, expectedKeys, label) {
    requireExactKeys(settings, expectedKeys, label);
  }

  /**
   * Validate the settings fields owned by BaseAnalysisUI.
   * @param {unknown} settings
   * @returns {{ selectedPages: string[], config: Object }}
   * @protected
   */
  _requireBaseSettings(settings) {
    if (!isPlainObject(settings)) {
      throw new TypeError('Analysis settings must be an object');
    }
    requirePageIds(settings.selectedPages, 'Analysis settings selectedPages');
    this._requireAvailableSelectedPages(
      settings.selectedPages,
      'Analysis settings selectedPages'
    );
    requireAnalysisConfig(settings.config);
    requireMatchingPages(settings.selectedPages, settings.config.pages);

    return {
      selectedPages: [...settings.selectedPages],
      config: cloneSettings(settings.config)
    };
  }

  /**
   * Apply settings after a concrete subclass validates its complete schema.
   * @param {{ selectedPages: string[], config: Object }} settings
   * @protected
   */
  _applyBaseSettings(settings) {
    this.onPageSelectionChange([...settings.selectedPages]);
    this.setConfig(cloneSettings(settings.config));
  }

  /**
   * Import a settings snapshot previously produced by exportSettings().
   * @param {{ selectedPages: string[], config: Object }} settings
   */
  importSettings(settings) {
    requireExactKeys(
      settings,
      ['config', 'selectedPages'],
      'Analysis settings'
    );
    this._applyBaseSettings(this._requireBaseSettings(settings));
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
    requirePageIds(pageIds, 'Analysis selectedPages');
    this._requireAvailableSelectedPages(pageIds, 'Analysis selectedPages');
    this._selectedPages = [...pageIds];
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
   * Validate the shape and current ownership of selected page IDs.
   * @param {unknown} pageIds
   * @param {string} label
   * @protected
   */
  _requireSelectedPageIds(pageIds, label) {
    requirePageIds(pageIds, label);
    this._requireAvailableSelectedPages(pageIds, label);
  }

  /**
   * Require selected pages to exist in the current UI inventory and contain
   * cells.
   * @param {string[]} pageIds
   * @param {string} label
   * @protected
   */
  _requireAvailableSelectedPages(pageIds, label) {
    const pages = this._pageSelector
      ? this._pageSelector._getPages()
      : this.dataLayer.getPages();
    if (!Array.isArray(pages)) {
      throw new TypeError('Analysis page inventory must be an array');
    }
    const availablePageIds = new Set(pages.map(page => page.id));
    for (const pageId of pageIds) {
      if (!availablePageIds.has(pageId)) {
        throw new Error(`${label} page "${pageId}" was not found`);
      }
      if (this.dataLayer.getCellCountForPageId(pageId) === 0) {
        throw new RangeError(
          `${label} page "${pageId}" has zero cells and cannot be selected`
        );
      }
    }
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
    const requestId = this._beginAnalysisIntent();
    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
    }
    this._updateTimer = setTimeout(() => {
      this._updateTimer = null;
      if (!this._isCurrentAnalysisIntent(requestId)) return;
      this._trackInteractiveTask(
        this._runAnalysisIfValid(requestId),
        'Scheduled analysis update'
      );
    }, delay);
  }

  /**
   * Observe user-triggered asynchronous work without replacing the exact task
   * returned to direct callers. Destruction drains every still-active task.
   * @param {Promise<*>} task
   * @param {string} context
   * @returns {Promise<*>}
   * @protected
   */
  _trackInteractiveTask(task, context) {
    if (task === null || task === undefined || typeof task.then !== 'function') {
      throw new TypeError(`${context} must return a Promise`);
    }
    this._interactiveTasks ??= new Set();
    this._interactiveTasks.add(task);
    const releaseTask = () => {
      this._interactiveTasks.delete(task);
    };
    const observer = task.then(
      releaseTask,
      error => {
        // Once destruction starts, the lifecycle owner must retain the rejected
        // task until destroy() snapshots and settles it. Releasing here would
        // lose an already-queued same-turn rejection.
        if (this._isDestroyed) return;
        releaseTask();
        try {
          this._notifications.error(
            `${context} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { category: 'analysis', title: 'Analysis Error' }
          );
        } catch (reportingError) {
          this._interactiveFailures ??= [];
          this._interactiveFailures.push(
            combineLifecycleErrors(
              [error, reportingError],
              `${context} and failure reporting failed`
            )
          );
        }
      }
    );
    void Promise.resolve(observer).catch(() => {});
    return task;
  }

  /**
   * Publish a new input intent immediately, before any debounce delay.
   * @returns {number}
   * @protected
   */
  _beginAnalysisIntent() {
    const invalidationOwner = this._analysisInvalidationOwner;
    const requestId = this._analysisRequestTracker.next();
    this._activeAnalysisRequestId = null;
    this._analysisInvalidationOwner = null;
    this._isLoading = false;

    if (invalidationOwner !== null) {
      const cleanupErrors = [];
      for (const cleanup of invalidationOwner.cleanups) {
        try {
          cleanup();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) {
        throw new AggregateError(
          cleanupErrors,
          'Analysis request invalidation cleanup failed'
        );
      }
    }
    return requestId;
  }

  /**
   * Start computation for either a scheduled intent or a direct invocation.
   * @param {number|null} requestId
   * @returns {number|null}
   * @protected
   */
  _startAnalysisRequest(requestId = null) {
    const ownedRequestId = requestId === null
      ? this._beginAnalysisIntent()
      : requestId;
    if (!this._isCurrentAnalysisIntent(ownedRequestId)) return null;
    this._activeAnalysisRequestId = ownedRequestId;
    this._analysisInvalidationOwner = {
      requestId: ownedRequestId,
      cleanups: new Set()
    };
    this._isLoading = true;
    return ownedRequestId;
  }

  /**
   * Register an exact-request cleanup that runs synchronously on invalidation.
   * Normal completion drops the cleanup without invoking it.
   * @param {number} requestId
   * @param {Function} cleanup
   * @returns {boolean} Whether the cleanup was registered to a live request
   * @protected
   */
  _registerAnalysisInvalidationCleanup(requestId, cleanup) {
    if (typeof cleanup !== 'function') {
      throw new TypeError(
        'Analysis invalidation cleanup must be a function'
      );
    }
    if (
      !this._isCurrentAnalysisRequest(requestId) ||
      this._analysisInvalidationOwner?.requestId !== requestId
    ) {
      cleanup();
      return false;
    }
    this._analysisInvalidationOwner.cleanups.add(cleanup);
    return true;
  }

  /**
   * Invalidate every scheduled or active request.
   * @returns {number} The new inert generation.
   * @protected
   */
  _invalidateAnalysisRequest() {
    return this._beginAnalysisIntent();
  }

  /**
   * @param {number} requestId
   * @returns {boolean}
   * @protected
   */
  _isCurrentAnalysisIntent(requestId) {
    return (
      !this._isDestroyed &&
      this._analysisRequestTracker.isCurrent(requestId)
    );
  }

  /**
   * @param {number} requestId
   * @returns {boolean}
   * @protected
   */
  _isCurrentAnalysisRequest(requestId) {
    return (
      this._activeAnalysisRequestId === requestId &&
      this._isCurrentAnalysisIntent(requestId)
    );
  }

  /**
   * Release loading ownership only when this exact request still owns it.
   * @param {number} requestId
   * @protected
   */
  _finishAnalysisRequest(requestId) {
    if (!this._isCurrentAnalysisRequest(requestId)) return;
    this._activeAnalysisRequestId = null;
    this._analysisInvalidationOwner = null;
    this._isLoading = false;
  }

  /**
   * Run analysis if configuration is valid (override for custom logic)
   */
  async _runAnalysisIfValid(scheduledRequestId = null) {
    if (this._isDestroyed) return;
    if (
      scheduledRequestId !== null &&
      !this._isCurrentAnalysisIntent(scheduledRequestId)
    ) {
      return;
    }
    if (!this._canRunAnalysis()) {
      const invalidationRequestId = this._invalidateAnalysisRequest();
      await this._hidePreview(invalidationRequestId);
      return;
    }

    const requestId = this._startAnalysisRequest(scheduledRequestId);
    if (requestId === null) return;
    try {
      await this._runAnalysis(requestId);
    } catch (err) {
      if (!this._isCurrentAnalysisRequest(requestId)) return;
      console.error(`[${this.constructor.name}] Analysis failed:`, err);
      await this._showError('Analysis failed: ' + err.message, requestId);
    } finally {
      this._finishAnalysisRequest(requestId);
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
      onExportPNG: () => this._trackInteractiveTask(
        this._exportPNG(),
        'PNG export'
      ),
      onExportSVG: () => this._trackInteractiveTask(
        this._exportSVG(),
        'SVG export'
      ),
      onExportCSV: () => this._trackInteractiveTask(
        this._exportCSV(
          this._currentPageData,
          this._currentConfig.dataSource.variable
        ),
        'CSV export'
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
    if (!this._modal) return Promise.resolve();
    return this._trackInteractiveTask(
      closeModal(this._modal),
      'Analysis modal close'
    );
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
    requirePageIds(pageIds, 'Analysis selectedPages');
    this._selectedPages = [...pageIds];
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
    setOwnDataProperty(this._currentConfig.plotOptions, key, value);
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
    if (this._baseDestroyPromise != null) {
      return this._baseDestroyPromise;
    }

    let rejectDestroy;
    let resolveDestroy;
    const destroyTask = new Promise((resolve, reject) => {
      resolveDestroy = resolve;
      rejectDestroy = reject;
    });
    this._baseDestroyPromise = destroyTask;

    const errors = [];
    this._isDestroyed = true;
    try {
      this._invalidateAnalysisRequest();
    } catch (error) {
      errors.push(error);
    }
    if (this._updateTimer) {
      try {
        clearTimeout(this._updateTimer);
      } catch (error) {
        errors.push(error);
      }
      this._updateTimer = null;
    }

    void Promise.resolve().then(async () => {
      const interactiveOutcomes = await Promise.allSettled([
        ...(this._interactiveTasks ?? [])
      ]);
      errors.push(
        ...interactiveOutcomes
          .filter(outcome => outcome.status === 'rejected')
          .map(outcome => outcome.reason)
      );
      errors.push(...(this._interactiveFailures ?? []));
      this._interactiveTasks?.clear();
      this._interactiveFailures = [];
      try {
        await this._cleanupPreviousAnalysis();
      } catch (error) {
        errors.push(error);
      }

      const modal = this._modal;
      if (modal) {
        try {
          await closeModal(modal);
        } catch (error) {
          errors.push(error);
        }
        if (this._modal === modal) this._modal = null;
      }

      if (this._container) {
        try {
          this._container.innerHTML = '';
        } catch (error) {
          errors.push(error);
        }
      }

      this._selectedPages = [];
      this._lastResult = null;
      this._currentPageData = null;
      this._isLoading = false;

      const failure = combineLifecycleErrors(
        errors,
        'Analysis UI destruction failed'
      );
      if (failure) throw failure;
    }).then(resolveDestroy, rejectDestroy);
    void destroyTask.catch(() => {});
    return destroyTask;
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
