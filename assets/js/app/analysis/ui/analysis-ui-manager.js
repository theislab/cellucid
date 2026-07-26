/**
 * AnalysisUIManager - Unified manager for all analysis UIs
 *
 * Responsibilities:
 * - Container creation and management for all analysis types
 * - Lazy instantiation of UIs on first access
 * - Mode switching with consistent API
 * - Page change notifications to active UI
 * - Unified lifecycle management
 *
 * Benefits:
 * - DRY: No more repetitive container/init code in ComparisonModule
 * - Consistent: All UIs use same interface (onPageSelectionChange)
 * - Flexible: Easy to add/remove analysis types
 * - Maintainable: Single place for UI management logic
 *
 * @example
 * const manager = createAnalysisUIManager({
 *   container: accordionContent,
 *   dataLayer,
 *   comparisonModule: this
 * });
 *
 * manager.register({
 *   id: 'quick',
 *   name: 'Quick Insights',
 *   factory: createQuickInsights,
 *   // ...
 * });
 *
 * manager.initContainers();
 * manager.switchToMode('quick');
 * manager.onPageSelectionChange(pageIds);
 */

/**
 * AnalysisUIManager class
 */
export class AnalysisUIManager {
  /**
   * @param {Object} options
   * @param {Object} [options.containerMap] - Map of mode ID to pre-created container elements
   * @param {Object} options.dataLayer - Enhanced data layer instance
   * @param {Object} options.comparisonModule - Reference to ComparisonModule
   */
  constructor(options) {
    this.dataLayer = options.dataLayer;
    this.comparisonModule = options.comparisonModule;
    this._containerMap = options.containerMap || null;

    if (!this._containerMap) {
      throw new Error('[AnalysisUIManager] containerMap is required');
    }

    // Registry of all analysis types (id -> config)
    this._registry = new Map();

    // Active UI instances: id -> { config, container, ui, initialized }
    this._uis = new Map();

    // Current active mode
    this._activeMode = null;

    // Current page selection (shared across mode switches)
    this._currentPages = [];
  }

  // ===========================================================================
  // Registration
  // ===========================================================================

  /**
   * Register an analysis type
   * @param {Object} config - Analysis type configuration
   * @param {string} config.id - Unique identifier (used as mode key)
   * @param {string} config.name - Display name
   * @param {Function} config.factory - Factory function to create UI instance
   * @param {Object} [config.factoryOptions] - Additional options passed to factory
   * @param {number} [config.minPages=1] - Minimum required pages
   * @param {number|null} [config.maxPages=null] - Maximum pages (null = unlimited)
   * @param {string} [config.icon] - Icon for mode toggle button
   * @param {string} [config.tooltip] - Tooltip text
   */
  register(config) {
    this._registry.set(config.id, {
      id: config.id,
      name: config.name,
      factory: config.factory,
      factoryOptions: config.factoryOptions || {},
      minPages: config.minPages ?? 1,
      maxPages: config.maxPages ?? null,
      icon: config.icon || '',
      tooltip: config.tooltip || config.name
    });
  }

  /**
   * Unregister an analysis type
   * @param {string} id - Analysis type ID
   */
  unregister(id) {
    // Destroy UI if initialized
    const entry = this._uis.get(id);
    if (entry?.ui?.destroy) {
      entry.ui.destroy();
    }
    if (entry?.container) {
      entry.container.remove();
    }
    this._uis.delete(id);
    this._registry.delete(id);
  }

  // ===========================================================================
  // Container Management
  // ===========================================================================

  /**
   * Initialize containers for all registered types
   * Call this once after all registrations are complete
   * If containerMap was provided, uses those containers instead of creating new ones
   */
  initContainers() {
    for (const [id, config] of this._registry) {
      let container;

      // Use pre-created container from map if available
      if (this._containerMap && this._containerMap[id]) {
        container = this._containerMap[id];
        container.id = `${id}-analysis-container`;
        container.classList.add(`${id}-analysis-panel`, 'analysis-panel');
      } else {
        console.warn(`[AnalysisUIManager] No container available for mode: ${id}`);
        continue;
      }

      this._uis.set(id, {
        config,
        container,
        ui: null,
        initialized: false
      });
    }
  }

  /**
   * Get container for a specific mode
   * @param {string} modeId - Mode ID
   * @returns {HTMLElement|null}
   */
  getContainer(modeId) {
    return this._uis.get(modeId)?.container || null;
  }

  // ===========================================================================
  // Mode Switching
  // ===========================================================================

  /**
   * Switch to a specific analysis mode
   * @param {string} modeId - Mode ID to switch to
   * @returns {boolean} True if switch was successful
   */
  switchToMode(modeId) {
    // Skip if already active
    if (modeId === this._activeMode) {
      // Still notify of current pages in case they changed
      const entry = this._uis.get(modeId);
      if (entry?.ui?.onPageSelectionChange) {
        entry.ui.onPageSelectionChange(this._currentPages);
      }
      return true;
    }

    // Validate mode exists
    const entry = this._uis.get(modeId);
    if (!entry) {
      console.warn(`[AnalysisUIManager] Unknown mode: ${modeId}`);
      return false;
    }

    // Lazy initialize if needed
    if (!entry.initialized) {
      this._initializeUI(modeId, entry);
    }

    // Notify of current pages
    if (entry.ui?.onPageSelectionChange) {
      entry.ui.onPageSelectionChange(this._currentPages);
    }

    this._activeMode = modeId;
    return true;
  }

  /**
   * Get the currently active mode
   * @returns {string|null}
   */
  getActiveMode() {
    return this._activeMode;
  }

  /**
   * Check if a mode is currently active
   * @param {string} modeId - Mode ID
   * @returns {boolean}
   */
  isActive(modeId) {
    return this._activeMode === modeId;
  }

  /**
   * Clear active mode (when accordion closes)
   */
  clearActiveMode() {
    this._activeMode = null;
  }

  // ===========================================================================
  // Page Change Notifications
  // ===========================================================================

  /**
   * Set the current page selection used across modes.
   *
   * This is the canonical setter for `_currentPages`. Callers can optionally
   * suppress notifying the active UI (e.g., when the active UI has already
   * applied the selection via a local interaction).
   *
   * @param {string[]} pageIds - Selected page IDs
   * @param {Object} [options]
   * @param {boolean} [options.notifyActiveUI=true] - Whether to notify the active UI
   */
  setCurrentPages(pageIds, options = {}) {
    if (!Array.isArray(pageIds)) {
      throw new TypeError('Analysis manager current pages must be an array');
    }
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some(key => key !== 'notifyActiveUI')
    ) {
      throw new TypeError(
        'Analysis manager page options may contain only notifyActiveUI'
      );
    }
    const notifyActiveUI = Object.hasOwn(options, 'notifyActiveUI')
      ? options.notifyActiveUI
      : true;
    if (typeof notifyActiveUI !== 'boolean') {
      throw new TypeError('notifyActiveUI must be a boolean');
    }
    const pages = this.dataLayer.getPages();
    if (!Array.isArray(pages)) {
      throw new TypeError('Analysis manager page inventory must be an array');
    }
    const availablePageIds = new Set(pages.map(page => page.id));
    const nextPages = [];
    const seenPageIds = new Set();
    for (const pageId of pageIds) {
      if (typeof pageId !== 'string' || pageId.length === 0) {
        throw new TypeError(
          'Analysis manager page IDs must be non-empty strings'
        );
      }
      if (!availablePageIds.has(pageId)) {
        throw new Error(
          `Analysis manager page "${pageId}" was not found`
        );
      }
      if (seenPageIds.has(pageId)) {
        throw new TypeError(
          `Analysis manager page "${pageId}" is selected more than once`
        );
      }
      if (this.dataLayer.getCellCountForPageId(pageId) === 0) {
        throw new RangeError(
          `Analysis manager page "${pageId}" has zero cells and cannot be selected`
        );
      }
      seenPageIds.add(pageId);
      nextPages.push(pageId);
    }
    this._currentPages = nextPages;

    if (!notifyActiveUI) return;

    // Only notify active UI
    const entry = this._uis.get(this._activeMode);
    if (entry?.ui?.onPageSelectionChange) {
      entry.ui.onPageSelectionChange([...this._currentPages]);
    }
  }

  /**
   * Notify page selection change
   * Only notifies the active UI for performance
   * @param {string[]} pageIds - Selected page IDs
   */
  onPageSelectionChange(pageIds) {
    this.setCurrentPages(pageIds, { notifyActiveUI: true });
  }

  /**
   * Notify highlight changed (cells added/removed)
   * Only notifies the active UI
   */
  onHighlightChanged() {
    const entry = this._uis.get(this._activeMode);
    if (entry?.ui?.onHighlightChanged) {
      entry.ui.onHighlightChanged();
    }
  }

  /**
   * Notify active UI that visibility changed (accordion opened/closed)
   * @param {boolean} isVisible
   */
  onVisibilityChanged(isVisible) {
    const entry = this._uis.get(this._activeMode);
    entry?.ui?.onVisibilityChanged?.(isVisible);
  }

  /**
   * Get current pages
   * @returns {string[]}
   */
  getCurrentPages() {
    return [...this._currentPages];
  }

  // ===========================================================================
  // UI Access
  // ===========================================================================

  /**
   * Get UI instance for a mode (initializes if needed)
   * @param {string} modeId - Mode ID
   * @returns {Object|null} UI instance or null
   */
  getUI(modeId) {
    const entry = this._uis.get(modeId);
    if (!entry) return null;

    // Initialize if needed
    if (!entry.initialized) {
      this._initializeUI(modeId, entry);
    }

    return entry.ui;
  }

  /**
   * Get active UI instance
   * @returns {Object|null}
   */
  getActiveUI() {
    if (!this._activeMode) return null;
    return this._uis.get(this._activeMode)?.ui || null;
  }

  /**
   * Check if a UI is initialized
   * @param {string} modeId - Mode ID
   * @returns {boolean}
   */
  isInitialized(modeId) {
    return this._uis.get(modeId)?.initialized || false;
  }

  // ===========================================================================
  // Type Information
  // ===========================================================================

  /**
   * Get analysis type metadata
   * @param {string} modeId - Mode ID
   * @returns {Object|null} Type configuration
   */
  getTypeInfo(modeId) {
    return this._registry.get(modeId) || null;
  }

  /**
   * Get all registered types
   * @returns {Object[]} Array of type configurations
   */
  getAllTypes() {
    return Array.from(this._registry.values());
  }

  /**
   * Get types available for given page count
   * @param {number} pageCount - Number of selected pages
   * @returns {Object[]} Available type configurations
   */
  getAvailableTypes(pageCount) {
    return this.getAllTypes().filter(type => {
      if (type.minPages && pageCount < type.minPages) return false;
      if (type.maxPages !== null && pageCount > type.maxPages) return false;
      return true;
    });
  }

  /**
   * Check if type is available for page count
   * @param {string} modeId - Mode ID
   * @param {number} pageCount - Number of selected pages
   * @returns {boolean}
   */
  isTypeAvailable(modeId, pageCount) {
    const type = this._registry.get(modeId);
    if (!type) return false;
    if (type.minPages && pageCount < type.minPages) return false;
    if (type.maxPages !== null && pageCount > type.maxPages) return false;
    return true;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Initialize a UI instance
   * @private
   * @param {string} id - Mode ID
   * @param {Object} entry - UI entry from _uis map
   */
  _initializeUI(id, entry) {
    const config = entry.config;

    // Build options object
    const options = {
      comparisonModule: this.comparisonModule,
      dataLayer: this.dataLayer,
      multiVariableAnalysis: this.comparisonModule.multiVariableAnalysis,
      container: entry.container,
      ...config.factoryOptions
    };

    const ui = config.factory(options);
    if (
      ui === null ||
      typeof ui !== 'object' ||
      ui._container !== entry.container
    ) {
      throw new TypeError(
        `Analysis factory "${id}" must return a fully initialized UI in the supplied container`
      );
    }

    entry.ui = ui;
    entry.initialized = true;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Destroy all UIs and cleanup
   */
  destroy() {
    for (const [id, entry] of this._uis) {
      if (entry.ui?.destroy) {
        entry.ui.destroy();
      }
      if (entry.container?.parentNode) {
        entry.container.remove();
      }
    }

    this._uis.clear();
    this._registry.clear();
    this._activeMode = null;
    this._currentPages = [];
  }

  /**
   * Reset to initial state (destroys UIs but keeps registry)
   */
  reset() {
    for (const [id, entry] of this._uis) {
      if (entry.ui?.destroy) {
        entry.ui.destroy();
      }
      entry.ui = null;
      entry.initialized = false;
    }
    this._activeMode = null;
    this._currentPages = [];
  }
}

/**
 * Factory function to create AnalysisUIManager
 * @param {Object} options - Manager options
 * @returns {AnalysisUIManager}
 */
export function createAnalysisUIManager(options) {
  return new AnalysisUIManager(options);
}

export default AnalysisUIManager;
