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
 * - Page requirements validation system
 *
 * All analysis UIs (Detailed, Quick, Advanced, Correlation, DE, Signature)
 * should extend this class and implement the abstract methods.
 *
 * REQUIREMENTS SYSTEM:
 * - Subclasses can define static getRequirements() to specify page and data
 *   constraints
 * - Use validateRequirements() to check if requirements are met
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
 *     // Build this mode's own controls and preview containers, then call
 *     // _renderControls(). Selector components are constructed by the
 *     // subclass that owns them, not by this base class.
 *   }
 * }
 */

import { createVisibilityGatedRender } from '../../ui/core/visibility-gate.js';
import { getNotificationCenter } from '../../notification-center.js';
import {
  validatePageRequirements,
  getRequirementText,
  downloadCSV
} from '../shared/analysis-utils.js';
import { getComputeManager } from '../compute/compute-manager.js';
import { OperationType } from '../compute/operations.js';
import {
  joinPerCellCSV,
  pageInOriginalOrder,
  perCellCSVHeader,
  splitPerCellRows
} from '../compute/csv-export.js';
import { analysisWorkerCount } from '../shared/performance-config.js';
import { selectablePageIdSet } from '../shared/page-derivation-utils.js';
import { createAnalysisModal, openModal, closeModal } from './components/modal.js';
import { createControlScope } from './components/control-accessibility.js';
import { purgePlot, downloadImage } from '../plots/plotly-loader.js';
import { CancellableJob, createRequestIdTracker, isCancellation } from '../../jobs/cancellable-job.js';
import { createJobStatusView } from '../../jobs/job-status-view.js';
import { createStatusLine } from '../../ui/components/controls.js';
import { describeCellsUsed } from '../shared/progressive-cells.js';
import { isPlainRecord, requireExactKeys } from '../../../utils/exact-record.js';

/**
 * A per-cell CSV file written by the analysis workers (compute/csv-export.js),
 * so the main thread neither builds nor holds its text: the rows are split
 * into consecutive ranges, one per worker, each written as a Blob, and the
 * Blobs are joined after the header. The bytes are those of writing every row
 * in order.
 *
 * `cell_index` is the cell's original position (its row in the dataset in
 * its original order), as every export and the notebook name a cell, and each
 * page's rows ascend by it: the open cells' positions inside the app are
 * translated by `identity` (`pageInOriginalOrder`), so a subsample, or a file
 * stored in priority order, joins back to the right rows in the dataset's order.
 *
 * @param {'page-data'|'signature-scores'} layout
 * @param {Array<{pageName: string, values: ArrayLike<unknown>, cellIndices?: ArrayLike<number>, categories?: string[], missingCode?: number}>} pageData
 * @param {string|undefined} variableName
 * @param {import('../../../data/cell-identity.js').CellIdentity} identity - The open dataset's cells
 * @returns {Promise<Blob>}
 */
export async function writePerCellCSV(layout, pageData, variableName, identity) {
  const header = perCellCSVHeader(layout, variableName);
  const pages = pageData.map(pd => {
    const { values, cellIndices } = pageInOriginalOrder(pd, identity);
    return {
      pageName: pd.pageName,
      values,
      cellIndices,
      setName: pd.setName ?? null,
      categories: pd.categories ?? null,
      missingCode: pd.missingCode ?? null
    };
  });
  const manager = getComputeManager();
  const ranges = splitPerCellRows(pages, analysisWorkerCount());
  const parts = await Promise.all(ranges.map(range => manager.execute(
    OperationType.COMPUTE_CSV_EXPORT,
    { layout, pages: range },
    // Each range's slices are its own copies.
    { transfer: true }
  )));
  return joinPerCellCSV(header, parts.map(part => part.rows));
}

function cloneSettings(value) {
  return structuredClone(value);
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
  if (!isPlainRecord(config.plotOptions)) {
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

/**
 * Outstanding busy claims per region. A region can be owned by more than one
 * render at once (a sidebar preview and the expanded view of the same result,
 * or a superseded run that has not unwound yet), so `aria-busy` is published
 * from a count rather than by whichever owner wrote last.
 *
 * @type {WeakMap<Element, number>}
 */
const busyClaimCounts = new WeakMap();

function publishBusyClaims(region) {
  if ((busyClaimCounts.get(region) ?? 0) > 0) {
    region.setAttribute('aria-busy', 'true');
  } else {
    region.removeAttribute('aria-busy');
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

    // Every element id this UI generates is prefixed with this scope. The
    // sidebar panel and each floating copy of the same analysis mode are
    // separate instances, so without it they emit the same ids and a
    // `<label for>` in one panel resolves to the control in the other.
    this._controlScope = createControlScope(
      this._instanceId.length > 0 ? this._instanceId : 'analysis'
    );

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

    // Debounce timer
    this._updateTimer = null;

    // Lifecycle guard (prevents async work from updating after teardown)
    this._isDestroyed = false;

    // One monotonic owner for analysis intent, computation, and publication.
    // A request that computes runs as a cancellable job (`_startAnalysisJob`)
    // whose signal stops its reads and worker tasks; invalidating the request
    // cancels the job.
    this._analysisRequestTracker = createRequestIdTracker();
    /** @type {ReturnType<typeof createJobStatusView>|null} */
    this._jobStatus = null;
    /** @type {CancellableJob|null} The job the status view shows */
    this._shownJob = null;
    this._activeAnalysisRequestId = null;
    this._analysisInvalidationOwner = null;
    this._interactiveTasks = new Set();
    this._interactiveFailures = [];
    this._baseDestroyPromise = null;

    // Release functions for level-triggered `_setBusy()` claims, per region.
    this._busyReleases = new Map();

    // Highlight changes run through a visibility gate: while the panel's
    // section or window is collapsed, or the sidebar is hidden, the change is
    // recorded and applied once when the panel is shown again.
    this._highlightGate = null;
  }

  // ===========================================================================
  // Requirements System
  // ===========================================================================

  /**
   * Get page requirements for this analysis type (override in subclass)
   * @static
   * @returns {{ minPages?: number, maxPages?: number, description?: string, geneExpression?: boolean }|null}
   */
  static getRequirements() {
    return null; // No requirements by default
  }

  /**
   * Validate this analysis type's requirements: the data it is built on, then
   * the current page selection.
   * @param {string[]} pageIds - Page IDs to validate
   * @returns {{ valid: boolean, error?: string }}
   */
  validateRequirements(pageIds) {
    const data = this.validateDataRequirements();
    if (!data.valid) return data;
    const requirements = this.constructor.getRequirements();
    if (!requirements) return { valid: true };
    return validatePageRequirements(pageIds, requirements);
  }

  /**
   * Validate the data this analysis type is built on, whatever the pages.
   * None publishes no genes, and a dataset may be exported without them; a
   * mode built on gene expression then has no form to offer or copy.
   * @returns {{ valid: boolean, error?: string }}
   */
  validateDataRequirements() {
    const requirements = this.constructor.getRequirements();
    if (requirements?.geneExpression !== true) return { valid: true };
    // A dataset just shown reads its genes after its first view
    // (`DataState.listPublishedGenes`): the form opens once they are read.
    if (this.dataLayer.state.areGenesPending()) {
      return { valid: false, pending: true, error: 'Reading the gene names… This analysis opens once they are read.' };
    }
    if (this.dataLayer.getAvailableVariables('gene_expression').length === 0) {
      const failure = this.dataLayer.state.getGeneListFailure();
      return {
        valid: false,
        error: failure === null
          ? 'Requires gene expression data.'
          : `The gene names could not be read: ${failure.message}`
      };
    }
    return { valid: true };
  }

  /**
   * The gene list was read after the first view (or could not be). Nothing
   * here lists genes itself: a gene selector of the controls lists them on
   * its own (`VariableSelector`), and a form is built again
   * (`FormBasedAnalysisUI.onGenesListed`).
   */
  onGenesListed() {}

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
   * Check if this analysis type's requirements are met
   * @returns {boolean}
   */
  meetsRequirements() {
    return this.validateRequirements(this._selectedPages).valid;
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
    this._highlightGate?.destroy();
    this._highlightGate = createVisibilityGatedRender(
      container,
      () => this._applyHighlightChange()
    );
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
    if (!isPlainRecord(settings)) {
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

  /**
   * The current result for a session, or null. An analysis whose result is
   * recomputed from its settings when it is shown (Quick, Detailed) keeps no
   * result in a session; the analyses that are costly to rerun override this
   * (`shared/analysis-result-session.js`).
   * @returns {null|{kind: string, version: number, payload: unknown}}
   */
  exportResult() {
    return null;
  }

  /**
   * Restore a result written by `exportResult()`.
   * @param {null|Object} result
   * @returns {Promise<void>}
   */
  async importResult(result) {
    if (result !== null) {
      throw new TypeError(
        `${this.constructor.name} recomputes its result from its settings; ` +
        'a session result for it must be null'
      );
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
   *
   * The inventory is the shared selectable domain, not this mode's own view of
   * it. `AnalysisUIManager` hands the same selection to whichever mode becomes
   * active, so a mode that answered from its page selector — or, when it owns
   * none, from the base pages alone — refused a page the manager had already
   * accepted.
   *
   * @param {string[]} pageIds
   * @param {string} label
   * @protected
   */
  _requireAvailableSelectedPages(pageIds, label) {
    const pages = this.dataLayer.getPages();
    if (!Array.isArray(pages)) {
      throw new TypeError('Analysis page inventory must be an array');
    }
    const availablePageIds = selectablePageIdSet(pages);
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
    this._applyHighlightChangeWhenShown();
  }

  /**
   * Apply a highlight change now if the panel is shown; otherwise record it.
   * Recounting and re-running for a panel nobody can see is deferred until it
   * is shown (see `onVisibilityChanged`).
   * @protected
   */
  _applyHighlightChangeWhenShown() {
    if (this._highlightGate === null) {
      this._applyHighlightChange();
      return;
    }
    this._highlightGate.request();
  }

  /**
   * Bring a shown panel up to date with the current highlights.
   * @protected
   */
  _applyHighlightChange() {
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
   * Update the page selector's cell counts in place. A UI without a page
   * selector component has no counts to update.
   */
  _updatePageSelectorCounts() {
    this._pageSelector?.updateCounts();
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
            { category: 'analysis', title: 'Analysis error' }
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

  // ===========================================================================
  // Cancellable jobs
  // ===========================================================================

  /**
   * The view of this UI's running, cancelled or failed job (Cancel, Run
   * again), created on first use; the UI places `root` where its result
   * appears.
   * @returns {ReturnType<typeof createJobStatusView>}
   * @protected
   */
  _getJobStatusView() {
    this._jobStatus ??= createJobStatusView({
      onRunAgain: () => this._runAgain()
    });
    return this._jobStatus;
  }

  /**
   * The line saying which cells the shown result used (a progressive run's
   * first pass, or every cell), created on first use; the UI places `root`
   * beside its result.
   * @returns {{root: HTMLElement, set: Function}}
   * @protected
   */
  _getCellsUsedLine() {
    if (this._cellsUsedLine == null) {
      this._cellsUsedLine = createStatusLine({ tone: 'muted' });
      this._cellsUsedLine.root.classList.add('analysis-cells-used');
      this._cellsUsedLine.root.hidden = true;
    }
    return this._cellsUsedLine;
  }

  /**
   * Say which cells the shown result used: a first pass's sample (refining,
   * or stopped before every cell), or every cell; nothing when no result is
   * shown (`shared/progressive-cells.js`).
   * @param {{m: number, n: number}|null} sample
   * @param {number} [openCells]
   * @param {'refining'|'stopped'|null} [state]
   * @param {boolean} [shown] - A result on every open cell is shown
   * @protected
   */
  _showCellsUsed(sample, openCells = 0, state = null, shown = false) {
    const line = this._cellsUsedLine;
    if (line == null) return;
    if (sample === null && !shown) {
      line.set('');
      line.root.hidden = true;
      delete line.root.dataset.cellsUsed;
      return;
    }
    line.set(describeCellsUsed(sample, openCells, state), state === 'stopped' ? 'warning' : 'muted');
    line.root.hidden = false;
    line.root.dataset.cellsUsed = sample === null ? 'all' : 'sample';
  }

  /**
   * Run the analysis again after it was cancelled or failed (Run again).
   * @protected
   */
  _runAgain() {
    if (this._isDestroyed) return;
    this._trackInteractiveTask(this._runAnalysisIfValid(), 'Analysis');
  }

  /**
   * Run request `requestId`'s computation as a cancellable job
   * (`app/jobs/cancellable-job.js`): its signal goes to every read and worker
   * task; Cancel (in the status view or the job's notification), a new
   * request, closing the window or switching the dataset cancel it.
   * Cancelling invalidates the request, so nothing of it is published.
   *
   * @param {number} requestId
   * @param {{title: string, plan?: string|null}} options
   * @returns {CancellableJob}
   * @protected
   */
  _startAnalysisJob(requestId, { title, plan = null }) {
    const job = new CancellableJob({
      title,
      plan,
      readKind: 'analysis',
      notifications: this._notifications,
      onCancel: () => {
        if (this._isCurrentAnalysisRequest(requestId)) this._invalidateAnalysisRequest();
      }
    });
    this._registerAnalysisInvalidationCleanup(requestId, () => job.cancel());
    this._shownJob = job;
    // A UI without a document (a headless test) has no view to show.
    if (typeof document !== 'undefined') this._getJobStatusView().show(job);
    return job;
  }

  /**
   * End `job` by the outcome of its request: a failure is shown in the
   * status view and its notification (once), a cancellation is a calm
   * Cancelled. Returns whether it failed.
   *
   * @param {CancellableJob} job
   * @param {unknown} error
   * @returns {boolean}
   * @protected
   */
  _failAnalysisJob(job, error) {
    if (isCancellation(error) || !job.running) {
      job.cancel();
      return false;
    }
    console.error(`[${this.constructor.name}] ${job.title} failed:`, error);
    job.fail(error);
    return true;
  }

  /**
   * Stop showing an ended job (the inputs changed): a running one stays.
   * @protected
   */
  _clearJobStatus() {
    if (this._shownJob?.running) return;
    this._shownJob = null;
    this._jobStatus?.show(null);
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
      this._clearJobStatus();
      await this._hidePreview(invalidationRequestId);
      return;
    }

    const requestId = this._startAnalysisRequest(scheduledRequestId);
    if (requestId === null) return;
    const job = this._startAnalysisJob(requestId, { title: this._getJobTitle() });
    try {
      await this._runAnalysis(requestId, job);
      if (this._isCurrentAnalysisRequest(requestId)) job.succeed();
      else job.cancel();
    } catch (err) {
      if (!this._isCurrentAnalysisRequest(requestId) || isCancellation(err)) {
        job.cancel();
        return;
      }
      // The job's status view and notification say why; what the previous
      // run showed no longer answers the inputs.
      this._failAnalysisJob(job, err);
      await this._hidePreview(requestId);
    } finally {
      this._finishAnalysisRequest(requestId);
    }
  }

  /**
   * What this UI's job is called (its mode's name).
   * @returns {string}
   * @protected
   */
  _getJobTitle() {
    return 'Analysis';
  }

  /**
   * Run the analysis (override in subclass): `job` is the request's
   * cancellable job, whose signal its reads and tasks take.
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
      this._actionsContainer.hidden = true;
    }
  }

  // ===========================================================================
  // Busy Signal
  // ===========================================================================

  /**
   * Claim that `region` is pending replacement until the returned release
   * function is called.
   *
   * Analysis content fills in after debounces, Plotly loading, data fetches
   * and asynchronous renders, so a region can change well after it appears.
   * `aria-busy` tells assistive technology -- and anything waiting for the
   * region to settle -- that it is still changing. Claims are counted, so a
   * superseded render that unwinds late cannot clear the busy state a newer
   * render still owns. Releasing twice is a no-op.
   *
   * @param {Element|null} [region]
   * @returns {() => void}
   * @protected
   */
  _claimBusy(region = this._container) {
    if (region === null || region === undefined) return () => {};
    if (
      typeof region.setAttribute !== 'function' ||
      typeof region.removeAttribute !== 'function'
    ) {
      throw new TypeError('Analysis busy region must be an element');
    }
    busyClaimCounts.set(region, (busyClaimCounts.get(region) ?? 0) + 1);
    publishBusyClaims(region);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (busyClaimCounts.get(region) ?? 1) - 1;
      if (remaining > 0) busyClaimCounts.set(region, remaining);
      else busyClaimCounts.delete(region);
      publishBusyClaims(region);
    };
  }

  /**
   * Hold one busy claim on `region` for exactly the duration of `run`.
   *
   * @template T
   * @param {Element|null} region
   * @param {() => Promise<T>|T} run
   * @returns {Promise<T>}
   * @protected
   */
  async _whileBusy(region, run) {
    const release = this._claimBusy(region);
    try {
      return await run();
    } finally {
      release();
    }
  }

  /**
   * Level-triggered form of `_claimBusy()` for owners whose loading and
   * settled states are separate calls: at most one claim per region is held
   * on this UI's behalf, taken by `_setBusy(true)` and released by
   * `_setBusy(false)`.
   *
   * @param {boolean} busy
   * @param {Element|null} [region]
   * @protected
   */
  _setBusy(busy, region = this._container) {
    if (region === null || region === undefined) return;
    this._busyReleases ??= new Map();
    const release = this._busyReleases.get(region);
    if (busy) {
      if (release === undefined) {
        this._busyReleases.set(region, this._claimBusy(region));
      }
      return;
    }
    if (release !== undefined) {
      this._busyReleases.delete(region);
      release();
    }
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
      const csv = await writePerCellCSV('page-data', pageData, variableName || 'value', this.dataLayer.state.cellIdentity);
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

  /**
   * Publish what this analysis's shown result holds besides its plot -- gene
   * sets, per-cell scores -- to the dataset's derived results
   * (`registries/derived-results.js`), or clear them (`result` null). The
   * analyses whose results a notebook pulls back override it.
   *
   * @param {Object|null} _result
   * @protected
   */
  _publishDerivedResults(_result) {}

  /** `_publishDerivedResults`, reported instead of thrown: it never stops an analysis. */
  _publishDerivedResultsSafely(result) {
    try {
      this._publishDerivedResults(result);
    } catch (error) {
      console.error(`[${this.constructor.name}] Publishing derived results failed:`, error);
    }
  }
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
    this._highlightGate?.destroy();
    this._highlightGate = null;
    try {
      this._invalidateAnalysisRequest();
    } catch (error) {
      errors.push(error);
    }
    this._jobStatus?.destroy();
    this._jobStatus = null;
    this._shownJob = null;
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
      this._publishDerivedResultsSafely(null);
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
