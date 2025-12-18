/**
 * Page Comparison & Multi-Page Analysis Module
 *
 * Main entry point that orchestrates the data layer, transforms,
 * plot registry, layout engine, and UI components.
 *
 * UI follows the same pattern as the Filtering section:
 * - Three separate dropdowns for categorical obs, continuous obs, and gene expression
 * - Selecting one clears the others (mutual exclusion)
 * - Auto-generates plot when valid selection is made (no "Run" button)
 * - Plot is shown in a popup/modal with customization options
 */

import { createDataLayer } from './data/data-layer.js';
import { TransformPipeline, createTransformPipeline } from './data/transform-pipeline.js';
import { createLayoutEngine } from './plots/layout-engine.js';
import { createMultiVariableAnalysis } from './stats/multi-variable-analysis.js';
import { runStatisticalTests as runStats } from './stats/statistical-tests.js';
import { loadPlotly } from './plots/plotly-loader.js';
import { getNotificationCenter } from '../notification-center.js';
import { getMemoryMonitor } from './shared/memory-monitor.js';
// Import PlotRegistry from centralized location
import { PlotRegistry } from './shared/plot-registry-utils.js';

// Import unified UI manager and analysis type factories
import { createAnalysisUIManager } from './ui/analysis-ui-manager.js';
import { createQuickInsights } from './ui/analysis-types/quick-insights-ui.js';
import { createDetailedAnalysisUI } from './ui/analysis-types/detailed-analysis-ui.js';
import { createCorrelationAnalysisUI } from './ui/analysis-types/correlation-analysis-ui.js';
import { createDEAnalysisUI } from './ui/analysis-types/de-analysis-ui.js';
import { createGeneSignatureUI } from './ui/analysis-types/gene-signature-ui.js';

// Import plot types to register them
import './plots/types/barplot.js';
import './plots/types/boxplot.js';
import './plots/types/violinplot.js';
import './plots/types/histogram.js';
import './plots/types/pieplot.js';
import './plots/types/densityplot.js';
import './plots/types/heatmap.js';
import './plots/types/volcanoplot.js';
import './plots/types/scatterplot.js';

/**
 * Comparison Module class
 */
export class ComparisonModule {
  /**
   * @param {Object} options
   * @param {Object} options.state - DataState instance
   * @param {HTMLElement} options.container - Container element
   */
  constructor(options) {
    this.state = options.state;
    this.container = options.container;

    // Initialize components - DataLayer now includes all enhanced features by default
    this.dataLayer = createDataLayer(this.state);
    this.layoutEngine = null;
    this.transformPipeline = createTransformPipeline();

    // Advanced analysis modules (lazy initialized)
    this._multiVariableAnalysis = null;

    // Unified UI manager for all analysis types
    this._uiManager = null;

    // Current analysis mode (set during init)
    this._analysisMode = null;

    // Track last known highlight page IDs so we can preserve user selections
    // when pages are added/removed/renamed.
    this._lastKnownPageIds = [];

    // Notification center
    this._notifications = getNotificationCenter();

    // Last statistical results (cached for UI reuse)
    this._lastStatResults = [];
    this._lastStatResultsTimestamp = null;
    this._currentPageData = null;

    // Current state (shared across analysis UIs)
    this.currentConfig = {
      dataSource: {
        type: '', // 'categorical_obs', 'continuous_obs', 'gene_expression'
        variable: ''
      },
      pages: [],
      transforms: [],
      plotType: '',
      layout: 'grouped',
      plotOptions: {},
      syncAxes: true // Synchronize axes across multi-page plots
    };

    // Event hooks
    this._hooks = {
      beforeRender: [],
      afterRender: []
    };

    // Register with memory monitor for automatic cleanup
    this._memoryMonitor = getMemoryMonitor();
    this._memoryMonitor.registerCleanupHandler('comparison-module', () => {
      // Data layer cache cleanup
      if (this.dataLayer && this.dataLayer.performCacheCleanup) {
        this.dataLayer.performCacheCleanup();
      }
    });
    // Start monitoring if not already active
    this._memoryMonitor.start();
  }

  /**
   * Initialize the module
   */
  init() {
    if (!this.container) {
      console.error('[ComparisonModule] Container element not found');
      return;
    }

    const accordionContent = this.container.querySelector('.accordion-content');
    if (!accordionContent) {
      console.error('[ComparisonModule] Accordion content not found');
      return;
    }

    // Create analysis type accordion (minimalist design)
    // Each item has header + content area for proper accordion behavior
    // ARIA attributes provide accessibility for screen readers
    this._modeToggleContainer = document.createElement('div');
    this._modeToggleContainer.className = 'analysis-accordion';
    this._modeToggleContainer.setAttribute('role', 'tablist');
    this._modeToggleContainer.innerHTML = `
      <div class="analysis-accordion-item" data-mode="simple">
        <button type="button" class="analysis-accordion-header" aria-expanded="false" aria-controls="analysis-panel-simple">
          <span class="analysis-accordion-title">Quick</span>
          <span class="analysis-accordion-desc">Automatic insights</span>
          <span class="analysis-accordion-chevron" aria-hidden="true"></span>
        </button>
        <div class="analysis-accordion-content" id="analysis-panel-simple" data-mode="simple" role="region" aria-labelledby="analysis-header-simple"></div>
      </div>
      <div class="analysis-accordion-item" data-mode="detailed">
        <button type="button" class="analysis-accordion-header" aria-expanded="false" aria-controls="analysis-panel-detailed">
          <span class="analysis-accordion-title">Detailed</span>
          <span class="analysis-accordion-desc">Full control over options</span>
          <span class="analysis-accordion-chevron" aria-hidden="true"></span>
        </button>
        <div class="analysis-accordion-content" id="analysis-panel-detailed" data-mode="detailed" role="region" aria-labelledby="analysis-header-detailed"></div>
      </div>
      <div class="analysis-accordion-item" data-mode="correlation">
        <button type="button" class="analysis-accordion-header" aria-expanded="false" aria-controls="analysis-panel-correlation">
          <span class="analysis-accordion-title">Correlation</span>
          <span class="analysis-accordion-desc">Explore variable relationships</span>
          <span class="analysis-accordion-chevron" aria-hidden="true"></span>
        </button>
        <div class="analysis-accordion-content" id="analysis-panel-correlation" data-mode="correlation" role="region" aria-labelledby="analysis-header-correlation"></div>
      </div>
      <div class="analysis-accordion-item" data-mode="differential">
        <button type="button" class="analysis-accordion-header" aria-expanded="false" aria-controls="analysis-panel-differential">
          <span class="analysis-accordion-title">Differential Expression</span>
          <span class="analysis-accordion-desc">Find DE genes between groups</span>
          <span class="analysis-accordion-chevron" aria-hidden="true"></span>
        </button>
        <div class="analysis-accordion-content" id="analysis-panel-differential" data-mode="differential" role="region" aria-labelledby="analysis-header-differential"></div>
      </div>
      <div class="analysis-accordion-item" data-mode="signature">
        <button type="button" class="analysis-accordion-header" aria-expanded="false" aria-controls="analysis-panel-signature">
          <span class="analysis-accordion-title">Gene Signature</span>
          <span class="analysis-accordion-desc">Compute signature scores</span>
          <span class="analysis-accordion-chevron" aria-hidden="true"></span>
        </button>
        <div class="analysis-accordion-content" id="analysis-panel-signature" data-mode="signature" role="region" aria-labelledby="analysis-header-signature"></div>
      </div>
    `;
    accordionContent.appendChild(this._modeToggleContainer);

    // Accordion click event - select mode
    this._modeToggleContainer.querySelectorAll('.analysis-accordion-header').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.analysis-accordion-item');
        this._setAnalysisMode(item.dataset.mode);
      });
    });

    // Build container map from accordion content areas
    const containerMap = {};
    this._modeToggleContainer.querySelectorAll('.analysis-accordion-content').forEach(content => {
      containerMap[content.dataset.mode] = content;
    });

    // Create unified UI manager with accordion containers
    this._uiManager = createAnalysisUIManager({
      containerMap,
      dataLayer: this.dataLayer,
      comparisonModule: this
    });

    // Register all analysis types (unified - all treated equally)
    this._registerAnalysisTypes();

    // Initialize containers for all types
    this._uiManager.initContainers();

    // Update with current pages
    const pages = this.dataLayer.getPages();
    if (pages.length > 0) {
      this.currentConfig.pages = pages.map(p => p.id);
    }

    // Seed shared page selection before first mode switch
    this._uiManager.setCurrentPages(this.currentConfig.pages, { notifyActiveUI: false });
    this._lastKnownPageIds = pages.map(p => p.id);

    // Switch to default mode (simple/quick) via the unified setter
    this._setAnalysisMode('simple');

    // Listen for page changes (add/remove/rename/switch)
    if (this.state.addHighlightPageChangeCallback) {
      this.state.addHighlightPageChangeCallback(() => {
        this.onPagesChanged();
      });
    }

    // Listen for highlight changes (cells added/removed from pages)
    if (this.state.addHighlightChangeCallback) {
      this.state.addHighlightChangeCallback(() => {
        this.onHighlightChanged();
      });
    }
  }

  /**
   * Register all analysis types with the UI manager
   * All types are treated equally - no special handling per type
   * @private
   */
  _registerAnalysisTypes() {
    // Quick Insights (simple mode)
    this._uiManager.register({
      id: 'simple',
      name: 'Quick',
      factory: createQuickInsights,
      minPages: 1,
      maxPages: null,
      icon: 'bolt',
      tooltip: 'Automatic insights for the active page'
    });

    // Detailed Analysis
    this._uiManager.register({
      id: 'detailed',
      name: 'Detailed',
      factory: createDetailedAnalysisUI,
      factoryOptions: {
        onConfigChange: (config) => {
          const next = { ...this.currentConfig, ...config };
          if (Array.isArray(config?.pages)) {
            next.pages = [...config.pages];
            this._uiManager?.setCurrentPages?.(next.pages, { notifyActiveUI: false });
          }
          this.currentConfig = next;
        }
      },
      minPages: 1,
      maxPages: null,
      icon: 'settings',
      tooltip: 'Full control over analysis options'
    });

    // Correlation Analysis
    this._uiManager.register({
      id: 'correlation',
      name: 'Correlation',
      factory: createCorrelationAnalysisUI,
      minPages: 1,
      maxPages: null,
      icon: 'scatter',
      tooltip: 'Explore correlations between variables'
    });

    // Differential Expression
    this._uiManager.register({
      id: 'differential',
      name: 'Differential Expression',
      factory: createDEAnalysisUI,
      minPages: 1,
      maxPages: null, // User can select which 2 pages to compare from available pages
      icon: 'bar-chart',
      tooltip: 'Find differentially expressed genes'
    });

    // Gene Signature Score
    this._uiManager.register({
      id: 'signature',
      name: 'Gene Signature',
      factory: createGeneSignatureUI,
      minPages: 1,
      maxPages: null,
      icon: 'list',
      tooltip: 'Compute gene signature scores'
    });
  }

  /**
   * Set the analysis mode with proper accordion toggle behavior
   *
   * Accordion behavior:
   * - Clicking a closed item opens it and closes all others
   * - Clicking an already-open item closes it (toggle)
   * - Zero or one item can be open at a time
   *
   * ARIA: Updates aria-expanded attributes for screen reader accessibility
   *
   * @param {'simple'|'detailed'|'correlation'|'differential'|'signature'} mode
   */
  _setAnalysisMode(mode) {
    const allItems = this._modeToggleContainer.querySelectorAll('.analysis-accordion-item');
    const clickedItem = this._modeToggleContainer.querySelector(
      `.analysis-accordion-item[data-mode="${mode}"]`
    );

    // IMPORTANT: Check if clicked item is ALREADY open BEFORE any DOM changes
    const isAlreadyOpen = clickedItem?.classList.contains('open');

    // Close ALL accordion items and update ARIA states
    allItems.forEach(item => {
      item.classList.remove('open');
      const header = item.querySelector('.analysis-accordion-header');
      if (header) {
        header.setAttribute('aria-expanded', 'false');
      }
    });

    // Toggle behavior: only open if it wasn't already open
    if (!isAlreadyOpen && clickedItem) {
      // Open the clicked item
      clickedItem.classList.add('open');

      // Update ARIA expanded state
      const clickedHeader = clickedItem.querySelector('.analysis-accordion-header');
      if (clickedHeader) {
        clickedHeader.setAttribute('aria-expanded', 'true');
      }

      // Only switch UI manager when actually opening a new/different mode
      if (mode !== this._analysisMode) {
        this._analysisMode = mode;
        this._uiManager.switchToMode(mode);
      }
    } else {
      // Item was toggled closed - clear the active mode
      this._analysisMode = null;
    }
  }

  // ===========================================================================
  // Public API Methods
  // ===========================================================================

  /**
   * Run analysis with given configuration
   *
   * This method is used by:
   * - advanced-analysis-ui.js for correlation plots
   *
   * @param {Object} config - Analysis configuration
   * @returns {Promise<Object[]>} Transformed page data
   */
  async runAnalysis(config) {
    try {
      // Ensure Plotly is loaded (lazy loading)
      await loadPlotly();

      // Fire beforeRender hooks
      for (const hook of this._hooks.beforeRender) {
        await hook(config);
      }

      // Fetch data for all pages
      const pageData = await this.dataLayer.getDataForPages({
        type: config.dataSource.type,
        variableKey: config.dataSource.variable,
        pageIds: config.pages
      });

      if (pageData.length === 0) {
        throw new Error('No data available for selected pages');
      }

      // Apply transforms if any
      let transformedData = pageData;
      if (config.transforms && config.transforms.length > 0) {
        const pipeline = TransformPipeline.fromConfig(config.transforms);
        transformedData = pageData.map(pd => ({
          ...pd,
          ...pipeline.apply(pd)
        }));
      }

      // Create layout engine
      this.layoutEngine = createLayoutEngine({
        pageCount: transformedData.length,
        pageIds: transformedData.map(pd => pd.pageId),
        pageNames: transformedData.map(pd => pd.pageName),
        syncXAxis: config.syncAxes !== false,
        syncYAxis: config.syncAxes !== false
      });

      // Fire afterRender hooks
      for (const hook of this._hooks.afterRender) {
        await hook(config, transformedData);
      }

      // Store for use by runStatisticalTests()
      this._currentPageData = transformedData;

      // Return transformed data for external use (analysis UIs, exports)
      return transformedData;

    } catch (err) {
      console.error('[ComparisonModule] runAnalysis failed:', err);
      throw err;
    }
  }

  // ===========================================================================
  // Event Handlers (Page/Highlight Changes)
  // ===========================================================================

  /**
   * Handle pages changed event (pages added/removed/renamed/switched)
   * Unified handling via UI manager
   */
  onPagesChanged() {
    const pages = this.dataLayer.getPages();
    const currentPageIds = pages.map(p => p.id);
    const currentPageIdSet = new Set(currentPageIds);

    const previousPageIds = Array.isArray(this._lastKnownPageIds) ? this._lastKnownPageIds : [];
    const previousPageIdSet = new Set(previousPageIds);

    const addedPageIds = currentPageIds.filter(id => !previousPageIdSet.has(id));

    // Treat the manager's selection as canonical (it is the shared selection across modes).
    const previousSelection = this._uiManager?.getCurrentPages?.() ?? this.currentConfig.pages ?? [];
    const previousSelectionSet = new Set(previousSelection);

    const hadAllPreviously =
      previousPageIds.length > 0 &&
      previousPageIds.every(id => previousSelectionSet.has(id));

    const nextSelectionSet = new Set(
      (previousSelection || []).filter(id => currentPageIdSet.has(id))
    );

    // Preserve "Select All" semantics: if the user previously had all pages selected,
    // auto-include newly created pages so the selection remains "all".
    if (hadAllPreviously) {
      for (const id of addedPageIds) {
        nextSelectionSet.add(id);
      }
    }

    // If selection is empty (e.g., deletions), default to selecting all current pages.
    if (nextSelectionSet.size === 0) {
      for (const id of currentPageIds) {
        nextSelectionSet.add(id);
      }
    }

    const nextSelection = currentPageIds.filter(id => nextSelectionSet.has(id));

    this.currentConfig.pages = nextSelection;
    this._uiManager.onPageSelectionChange(nextSelection);
    this._lastKnownPageIds = currentPageIds;
  }

  /**
   * Handle highlight changed event (cells added/removed from pages)
   * Unified handling via UI manager
   */
  onHighlightChanged() {
    // Notify UI manager (it notifies only the active UI)
    this._uiManager.onHighlightChanged();
  }

  // ===========================================================================
  // Configuration & Hooks
  // ===========================================================================

  /**
   * Get current configuration
   */
  getConfig() {
    return { ...this.currentConfig };
  }

  /**
   * Set configuration
   */
  setConfig(config) {
    this.currentConfig = { ...this.currentConfig, ...config };
  }

  /**
   * Add event hook
   */
  on(event, callback) {
    if (this._hooks[event]) {
      this._hooks[event].push(callback);
    }
  }

  /**
   * Remove event hook
   */
  off(event, callback) {
    if (this._hooks[event]) {
      const idx = this._hooks[event].indexOf(callback);
      if (idx >= 0) {
        this._hooks[event].splice(idx, 1);
      }
    }
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Perform periodic cleanup to prevent memory degradation
   */
  performCleanup() {
    if (this.dataLayer && this.dataLayer.performCacheCleanup) {
      const result = this.dataLayer.performCacheCleanup();
      console.debug('[ComparisonModule] Cleanup completed:', result);
    }

    // Clear stale stat results
    if (this._lastStatResults && this._lastStatResults.length > 0) {
      const now = Date.now();
      if (this._lastStatResultsTimestamp && (now - this._lastStatResultsTimestamp) > 5 * 60 * 1000) {
        this._lastStatResults = [];
        this._lastStatResultsTimestamp = null;
      }
    }
  }

  /**
   * Cleanup and destroy the module
   */
  destroy() {
    // Unregister from memory monitor
    if (this._memoryMonitor) {
      this._memoryMonitor.unregisterCleanupHandler('comparison-module');
      this._memoryMonitor = null;
    }

    // Destroy UI manager (handles all analysis UIs)
    if (this._uiManager) {
      this._uiManager.destroy();
      this._uiManager = null;
    }

    // Clear caches
    if (this.dataLayer && this.dataLayer.clearAllCaches) {
      this.dataLayer.clearAllCaches();
    }

    // Clear hooks
    this._hooks = { beforeRender: [], afterRender: [] };

    // Null out references to free memory
    this.layoutEngine = null;
    this._multiVariableAnalysis = null;
    this._lastStatResults = [];
    this._lastStatResultsTimestamp = null;
    this._currentPageData = null;
    this.dataLayer = null;
  }

  // =========================================================================
  // Advanced Analysis Features
  // =========================================================================

  /**
   * Get multi-variable analysis module (lazy initialization)
   * @returns {Object} MultiVariableAnalysis instance
   */
  get multiVariableAnalysis() {
    if (!this._multiVariableAnalysis) {
      this._multiVariableAnalysis = createMultiVariableAnalysis(this.dataLayer);
    }
    return this._multiVariableAnalysis;
  }

  /**
   * Run statistical tests on current page data
   * @returns {Promise<Object[]>} Statistical test results
   */
  async runStatisticalTests() {
    if (!this._currentPageData || this._currentPageData.length < 2) {
      return [];
    }

    const dataType = this.currentConfig.dataSource.type === 'categorical_obs'
      ? 'categorical' : 'continuous';

    this._lastStatResults = runStats(this._currentPageData, dataType);
    this._lastStatResultsTimestamp = Date.now();
    return this._lastStatResults;
  }

  /**
   * Get the last statistical test results
   * @returns {Object[]}
   */
  getLastStatResults() {
    return this._lastStatResults;
  }

  /**
   * Perform correlation analysis between two variables
   * @param {Object} options - { varX, varY, pageIds, method }
   * @returns {Promise<Object[]>}
   */
  async correlationAnalysis(options) {
    return this.multiVariableAnalysis.correlationAnalysis(options);
  }

  /**
   * Perform differential expression analysis
   * @param {Object} options - { pageA, pageB, geneList, method }
   * @returns {Promise<Object>}
   */
  async differentialExpression(options) {
    return this.multiVariableAnalysis.differentialExpression(options);
  }

  /**
   * Compute gene signature score
   * @param {Object} options - { genes, pageIds, method }
   * @returns {Promise<Object[]>}
   */
  async computeSignatureScore(options) {
    return this.multiVariableAnalysis.computeSignatureScore(options);
  }

  /**
   * Fetch bulk gene expression data with progress
   * @param {Object} options - { pageIds, geneList, forceReload, onProgress }
   * @returns {Promise<Object>}
   */
  async fetchBulkGeneExpression(options) {
    return this.dataLayer.fetchBulkGeneExpression(options);
  }

  /**
   * Get cache statistics from enhanced data layer
   * @returns {Object}
   */
  getCacheStats() {
    return this.dataLayer.getCacheStats();
  }

  /**
   * Clear all caches
   */
  clearCaches() {
    this.dataLayer.clearAllCaches();
  }

  /**
   * Get individual analysis UIs via manager
   * @returns {Object} Object with individual UI instances
   */
  getAnalysisUIs() {
    return {
      quick: this._uiManager?.getUI('simple'),
      detailed: this._uiManager?.getUI('detailed'),
      correlation: this._uiManager?.getUI('correlation'),
      de: this._uiManager?.getUI('differential'),
      signature: this._uiManager?.getUI('signature')
    };
  }

  /**
   * Get a specific analysis UI by mode ID
   * @param {string} modeId - Mode ID (simple, detailed, correlation, differential, signature)
   * @returns {Object|null} UI instance or null
   */
  getUI(modeId) {
    return this._uiManager?.getUI(modeId) || null;
  }

  /**
   * Get the UI manager instance
   * @returns {AnalysisUIManager|null}
   */
  getUIManager() {
    return this._uiManager;
  }

  // =========================================================================
  // Static Extensibility APIs
  // =========================================================================

  static registerPlotType(plotType) {
    PlotRegistry.register(plotType);
  }

  static registerTransform(id, transform) {
    TransformPipeline.registerTransform(id, transform);
  }

  static getPlotType(id) {
    return PlotRegistry.get(id);
  }

  static getPlotTypes() {
    return PlotRegistry.getAll();
  }

  static getTransforms() {
    return TransformPipeline.getAllTransforms();
  }
}

// Custom exporter registry
const customExporters = new Map();

ComparisonModule.registerExporter = function(format, exportFn) {
  customExporters.set(format, exportFn);
};

ComparisonModule.getExporter = function(format) {
  return customExporters.get(format) || null;
};

/**
 * Create a new ComparisonModule instance
 */
export function createComparisonModule(options) {
  const module = new ComparisonModule(options);
  module.init();
  return module;
}

// Re-export for external use
export { PlotRegistry };
export { DataLayer, createDataLayer } from './data/data-layer.js';
export { TransformPipeline, createTransformPipeline } from './data/transform-pipeline.js';
export { LayoutEngine, createLayoutEngine } from './plots/layout-engine.js';
export { MultiVariableAnalysis, createMultiVariableAnalysis } from './stats/multi-variable-analysis.js';

// Re-export UI manager and analysis UIs (all treated equally)
export { AnalysisUIManager, createAnalysisUIManager } from './ui/analysis-ui-manager.js';
export { QuickInsights, createQuickInsights } from './ui/analysis-types/quick-insights-ui.js';
export { DetailedAnalysisUI, createDetailedAnalysisUI } from './ui/analysis-types/detailed-analysis-ui.js';
export { CorrelationAnalysisUI, createCorrelationAnalysisUI } from './ui/analysis-types/correlation-analysis-ui.js';
export { DEAnalysisUI, createDEAnalysisUI } from './ui/analysis-types/de-analysis-ui.js';
export { GeneSignatureUI, createGeneSignatureUI } from './ui/analysis-types/gene-signature-ui.js';

// Re-export query builder
export { QueryBuilder, createQueryBuilder, OPERATORS } from './data/query-builder.js';

// Re-export statistical functions
export {
  benjaminiHochberg,
  bonferroniCorrection,
  applyMultipleTestingCorrection,
  confidenceInterval,
  computeFoldChange
} from './stats/statistical-tests.js';
