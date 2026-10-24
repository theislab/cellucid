/**
 * Page Comparison & Multi-Page Analysis Module
 *
 * Main entry point that orchestrates the data layer, plot registry,
 * layout engine, and UI components.
 *
 * UI follows the same pattern as the Filtering section:
 * - Three separate dropdowns for categorical obs, continuous obs, and gene expression
 * - Selecting one clears the others (mutual exclusion)
 * - Auto-generates plot when valid selection is made (no "Run" button)
 * - Plot is shown in a popup/modal with customization options
 */

import { createDataLayer } from './data/data-layer.js';
import { createMultiVariableAnalysis } from './stats/multi-variable-analysis.js';
import { getNotificationCenter } from '../notification-center.js';
import { getMemoryMonitor } from './shared/memory-monitor.js';
import { clearActiveSourceCaches } from './shared/resource-cleanup.js';
import { debugError } from './shared/debug-utils.js';
import { closeModal } from './ui/components/modal.js';
import { analysisViewSizes } from './shared/analysis-view-sizes.js';
import { setOwnDataProperty } from '../../utils/exact-record.js';
import { createGroup, createInfoTip } from '../ui/components/controls.js';

// Import unified UI manager and analysis type factories
import { createAnalysisUIManager } from './ui/analysis-ui-manager.js';
import { createQuickInsights } from './ui/analysis-types/quick-insights-ui.js';
import { createDetailedAnalysisUI } from './ui/analysis-types/detailed-analysis-ui.js';
import { createCorrelationAnalysisUI } from './ui/analysis-types/correlation-analysis-ui.js';
import { createDEAnalysisUI } from './ui/analysis-types/de-analysis-ui.js';
import { createGeneSignatureUI } from './ui/analysis-types/gene-signature-ui.js';
import { createGenesPanelUI } from './ui/analysis-types/genes-panel-ui.js';
import { createCompositionUI } from './ui/analysis-types/composition-ui.js';
import { createDotplotUI } from './ui/analysis-types/dotplot-ui.js';
import { createAnalysisWindowManager } from './ui/analysis-window-manager.js';

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
import './plots/types/gene-heatmap.js';

/**
 * Comparison Module class
 */
/**
 * Whether an analysis mode row is open. The header's `aria-expanded` is the
 * one record of that state; the region's `hidden` follows it.
 *
 * @param {Element} item - A `.analysis-mode` disclosure.
 * @returns {boolean}
 */
function isModeItemOpen(item) {
  return item.querySelector(':scope > .disclosure-header-row > .disclosure-header')
    ?.getAttribute('aria-expanded') === 'true';
}

/**
 * Open or close one analysis mode row.
 *
 * @param {Element} item - A `.analysis-mode` disclosure.
 * @param {boolean} open
 */
function setModeItemOpen(item, open) {
  const header = item.querySelector(':scope > .disclosure-header-row > .disclosure-header');
  const content = item.querySelector(':scope > .analysis-mode-content');
  if (header !== null) header.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (content !== null) content.hidden = !open;
}

export class ComparisonModule {
  /**
   * @param {Object} options
   * @param {Object} options.state - DataState instance
   * @param {HTMLElement} options.container - Container element
   */
  constructor(options) {
    this.state = options.state;
    this.container = options.container;
    if (typeof options.colorByGene !== 'function') {
      throw new TypeError('The analysis module needs colorByGene(geneKey), the sidebar gene selector\'s');
    }
    this._colorByGene = options.colorByGene;

    // Initialize components - DataLayer now includes all enhanced features by default
    this.dataLayer = createDataLayer(this.state);

    // Advanced analysis modules (lazy initialized)
    this._multiVariableAnalysis = null;

    // Unified UI manager for all analysis types
    this._uiManager = null;

    // Floating windows created via "Copy" on analysis sub-accordions
    this._analysisWindowManager = null;

    // Current analysis mode (set during init)
    this._analysisMode = null;

    // Track last known highlight page IDs so we can preserve user selections
    // when pages are added/removed/renamed.
    this._lastKnownPageIds = [];
    this._lastKnownSelectablePageIds = [];

    // Notification center
    this._notifications = getNotificationCenter();

    this._datasetReloadResetCount = 0;
    this._lastDatasetReloadReset = null;
    this._destroyPromise = null;
    this._datasetResetPromise = null;
    this._stateUnsubscribers = [];

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

    // Register with memory monitor for automatic cleanup
    this._memoryMonitor = getMemoryMonitor();
    this._memoryMonitor.registerCleanupHandler('comparison-module', async (reason) => {
      const cleanupErrors = [];
      const cleanupTasks = [];
      const cleanup = operation => {
        try {
          return operation();
        } catch (error) {
          cleanupErrors.push(error);
          return undefined;
        }
      };

      if (
        this.dataLayer === null ||
        typeof this.dataLayer?.performCacheCleanup !== 'function'
      ) {
        cleanupErrors.push(
          new TypeError('Comparison cleanup requires DataLayer.performCacheCleanup()')
        );
      } else {
        cleanup(() => this.dataLayer.performCacheCleanup());
      }

      if (reason === 'threshold' || reason === 'critical') {
        cleanup(() => clearActiveSourceCaches());

        let modals = [];
        cleanup(() => {
          modals = document.querySelectorAll('.analysis-modal');
        });
        for (const modal of modals) {
          const closeTask = cleanup(() => closeModal(modal));
          if (closeTask && typeof closeTask.then === 'function') {
            cleanupTasks.push(closeTask);
          }
        }
      }

      const outcomes = await Promise.allSettled(cleanupTasks);
      cleanupErrors.push(
        ...outcomes
          .filter(outcome => outcome.status === 'rejected')
          .map(outcome => outcome.reason)
      );
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) {
        throw new AggregateError(
          cleanupErrors,
          `Comparison cleanup failed in ${cleanupErrors.length} operations`
        );
      }
    });
    // Start monitoring if not already active
    this._memoryMonitor.start({ checkInterval: 15000 });
  }

  /**
   * Initialize the module
   */
  init() {
    if (!this.container) {
      debugError('ComparisonModule', 'Container element not found');
      return;
    }

    const accordionContent = this.container.querySelector('.accordion-content');
    if (!accordionContent) {
      debugError('ComparisonModule', 'Accordion content not found');
      return;
    }

    // Analysis type accordion (minimalist design). Each header is a native
    // disclosure button; the copy action is its sibling rather than a button
    // nested inside it, so both controls stay operable and announced.
    // What each mode does is told by its (i), beside the title. The rows are
    // grouped by what they are asked of: genes, cells, or a field to explore.
    const ANALYSIS_SECTIONS = [
      { title: 'Genes', modes: [
        { mode: 'genesPanel', title: 'Marker genes', tip: 'analysis-marker-genes' },
        { mode: 'differential', title: 'Differential expression', tip: 'analysis-differential' },
        { mode: 'dotplot', title: 'Dot plot', tip: 'analysis-dotplot' },
        { mode: 'signature', title: 'Gene signature', tip: 'analysis-signature' },
      ] },
      { title: 'Cells', modes: [
        { mode: 'composition', title: 'Composition', tip: 'analysis-composition' },
      ] },
      { title: 'Explore', modes: [
        { mode: 'simple', title: 'Quick', tip: 'analysis-quick' },
        { mode: 'detailed', title: 'Detailed', tip: 'analysis-detailed' },
        { mode: 'correlation', title: 'Correlation', tip: 'analysis-correlation' },
      ] },
    ];
    const modeRow = ({ mode, title }) => `
      <div class="disclosure analysis-mode" data-mode="${mode}">
        <div class="disclosure-header-row">
          <button type="button" id="analysis-header-${mode}" class="disclosure-header" aria-expanded="false" aria-controls="analysis-panel-${mode}">
            <span class="disclosure-title">${title}</span>
            <span class="disclosure-chevron" aria-hidden="true"></span>
          </button>
          <button type="button" class="analysis-mode-copy-btn accordion-copy-btn" aria-label="Copy ${title} analysis window" title="Copy ${title} analysis window"></button>
        </div>
        <div class="disclosure-content analysis-mode-content" id="analysis-panel-${mode}" data-mode="${mode}" role="region" aria-labelledby="analysis-header-${mode}" hidden></div>
      </div>`;
    this._modeToggleContainer = document.createElement('div');
    this._modeToggleContainer.className = 'analysis-mode-sections';
    for (const section of ANALYSIS_SECTIONS) {
      const group = createGroup({ title: section.title });
      group.root.classList.add('analysis-mode-section');
      const list = document.createElement('div');
      list.className = 'disclosure-list analysis-mode-list';
      list.innerHTML = section.modes.map(modeRow).join('');
      group.body.appendChild(list);
      this._modeToggleContainer.appendChild(group.root);
    }
    for (const { mode, title, tip } of ANALYSIS_SECTIONS.flatMap(section => section.modes)) {
      const row = this._modeToggleContainer.querySelector(
        `.analysis-mode[data-mode="${mode}"] > .disclosure-header-row`
      );
      const info = createInfoTip({ tip, label: `About ${title.toLowerCase()} analysis` });
      row.insertBefore(info.button, row.querySelector('.analysis-mode-copy-btn'));
      row.after(info.popover);
    }
    accordionContent.appendChild(this._modeToggleContainer);

    // A native button answers click, Enter, and Space with one click event.
    // One delegated listener serves every header and every copy button.
    this._modeToggleContainer.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const copyBtn = target?.closest('.analysis-mode-copy-btn') ?? null;
      if (copyBtn !== null && this._modeToggleContainer.contains(copyBtn)) {
        e.preventDefault();
        e.stopPropagation();
        this._copyModeToWindow(copyBtn);
        return;
      }
      // Only a mode's own header switches modes: the disclosures inside a
      // mode's form (Clustering, for one) are headers too, and
      // their clicks bubble through this list.
      const header = target?.closest(
        '.analysis-mode > .disclosure-header-row > .disclosure-header'
      ) ?? null;
      if (header === null || !this._modeToggleContainer.contains(header)) return;
      const item = header.closest('.analysis-mode');
      if (!item) return;
      this._setAnalysisMode(item.dataset.mode);
    });

    // Build container map from accordion content areas
    const containerMap = {};
    this._modeToggleContainer.querySelectorAll('.analysis-mode-content').forEach(content => {
      setOwnDataProperty(containerMap, content.dataset.mode, content);
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

    // Floating analysis windows: allow copying sub-accordion items into detached panels
    this._analysisWindowManager = createAnalysisWindowManager({
      comparisonModule: this,
      uiManager: this._uiManager,
      sidebar: document.getElementById('sidebar')
    });

    // Update with current pages
    const pages = this.dataLayer.getPages();
    const selectablePageIds = this._getSelectableBasePageIds(pages);
    this.currentConfig.pages = [...selectablePageIds];

    // Seed shared page selection before first mode switch
    this._uiManager.setCurrentPages(this.currentConfig.pages, { notifyActiveUI: false });
    this._lastKnownPageIds = pages.map(p => p.id);
    this._lastKnownSelectablePageIds = [...selectablePageIds];

    // Set default active mode (simple/quick) without auto-opening the accordion item.
    // Users can open the desired section explicitly.
    this._analysisMode = 'simple';
    this._uiManager.switchToMode('simple');

    this._subscribeToStateChanges();
  }

  /**
   * Subscribe to shared page/highlight state with exact teardown ownership.
   * @private
   */
  _subscribeToStateChanges() {
    if (typeof this.state?.on !== 'function') return;
    if (!Array.isArray(this._stateUnsubscribers)) {
      throw new TypeError(
        'Comparison state subscription ownership must be an array'
      );
    }
    if (this._stateUnsubscribers.length !== 0) {
      throw new Error('Comparison state subscriptions are already active');
    }
    const subscriptions = [
      ['page:changed', () => this.onPagesChanged()],
      ['highlight:changed', () => this.onHighlightChanged()]
    ];
    try {
      for (const [eventName, handler] of subscriptions) {
        const unsubscribe = this.state.on(eventName, handler);
        if (typeof unsubscribe !== 'function') {
          if (typeof this.state.off === 'function') {
            this.state.off(eventName, handler);
          }
          throw new TypeError(
            `Comparison state subscription "${eventName}" must return an unsubscribe function`
          );
        }
        this._stateUnsubscribers.push(unsubscribe);
      }
    } catch (error) {
      const cleanupErrors = [error];
      for (const unsubscribe of this._stateUnsubscribers.splice(0)) {
        try {
          unsubscribe();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length === 1) throw error;
      throw new AggregateError(
        cleanupErrors,
        'Comparison state subscription setup failed'
      );
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
      name: 'Differential expression',
      factory: createDEAnalysisUI,
      minPages: 1,
      maxPages: null, // User can select which 2 pages to compare from available pages
      icon: 'bar-chart',
      tooltip: 'Find differentially expressed genes'
    });

    // Gene Signature Score
    this._uiManager.register({
      id: 'signature',
      name: 'Gene signature',
      factory: createGeneSignatureUI,
      minPages: 1,
      maxPages: null,
      icon: 'list',
      tooltip: 'Compute gene signature scores'
    });

    // Marker Genes Panel
    this._uiManager.register({
      id: 'genesPanel',
      name: 'Marker genes',
      factory: createGenesPanelUI,
      minPages: 1,
      maxPages: null,
      icon: 'grid',
      tooltip: 'Discover and visualize marker genes across cell groups'
    });

    // Dot plot
    this._uiManager.register({
      id: 'dotplot',
      name: 'Dot plot',
      factory: createDotplotUI,
      minPages: 0,
      maxPages: null,
      icon: 'grid',
      tooltip: 'Mean expression and fraction expressing of genes across groups'
    });

    // Composition
    this._uiManager.register({
      id: 'composition',
      name: 'Composition',
      factory: createCompositionUI,
      minPages: 0,
      maxPages: null,
      icon: 'bar-chart',
      tooltip: 'Cell-type proportions across samples and conditions'
    });
  }

  /**
   * Copy one analysis mode into a floating window, sized from its row.
   *
   * @param {HTMLButtonElement} btn - The row's copy button.
   */
  _copyModeToWindow(btn) {
    const item = btn.closest('.analysis-mode');
    if (!item) return;

    const mode = item.dataset.mode;
    const header = item.querySelector('.disclosure-header');
    const sourceRect = header?.getBoundingClientRect?.() || item.getBoundingClientRect();
    const sectionRect = btn.closest('details.accordion-section')?.getBoundingClientRect?.();
    const itemRect = item.getBoundingClientRect();
    const isExpanded = isModeItemOpen(item);
    const headerTitle = header?.querySelector?.('.disclosure-title')?.textContent?.trim?.() || '';

    try {
      // A mode whose data is missing shows a notice, not a form, so there are
      // no settings to copy: say why instead of opening a window.
      const data = this._uiManager.getUI(mode)?.validateDataRequirements();
      if (data?.valid === false) {
        this._notifications.info(data.error, { category: 'analysis' });
        return;
      }
      const creation = this._analysisWindowManager?.copyFromEmbedded?.(
        mode,
        {
          sourceRect,
          preferredSize: {
            width: sectionRect?.width ?? itemRect.width,
            height: isExpanded ? itemRect.height : undefined
          },
          headerTitle
        }
      );
      if (creation && typeof creation.then === 'function') {
        void creation.catch(error => {
          console.error(
            '[ComparisonModule] Analysis window creation failed:',
            error
          );
          this._notifications.error(
            `Could not create the analysis window: ${error.message}`,
            { category: 'analysis', title: 'Analysis Window Error' }
          );
        });
      }
    } catch (error) {
      console.error(
        '[ComparisonModule] Analysis window creation failed:',
        error
      );
      this._notifications.error(
        `Could not create the analysis window: ${error.message}`,
        { category: 'analysis', title: 'Analysis Window Error' }
      );
    }
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
   * @param {'simple'|'detailed'|'correlation'|'differential'|'signature'|'genesPanel'|'dotplot'|'composition'} mode
   */
  _setAnalysisMode(mode) {
    const allItems = this._modeToggleContainer.querySelectorAll('.analysis-mode');
    const clickedItem = this._modeToggleContainer.querySelector(
      `.analysis-mode[data-mode="${mode}"]`
    );

    // IMPORTANT: Check if clicked item is ALREADY open BEFORE any DOM changes
    const isAlreadyOpen = clickedItem !== null && isModeItemOpen(clickedItem);

    // Close ALL accordion items: aria-expanded and the region's `hidden`
    // are the one record of the open state.
    allItems.forEach(item => setModeItemOpen(item, false));

    // Toggle behavior: only open if it wasn't already open
    if (!isAlreadyOpen && clickedItem) {
      setModeItemOpen(clickedItem, true);

      // Only switch UI manager when actually opening a new/different mode
      if (mode !== this._analysisMode) {
        this._analysisMode = mode;
        this._uiManager.switchToMode(mode);
      }
      // Notify UI that it's now visible (triggers pending updates)
      this._uiManager.onVisibilityChanged(true);
    } else {
      // Item was toggled closed - clear the active mode
      this._analysisMode = null;
      this._uiManager.clearActiveMode();
    }
  }

  // ===========================================================================
  // Event Handlers (Page/Highlight Changes)
  // ===========================================================================

  /**
   * Return the exact base-page IDs that currently contain cells.
   * @param {unknown} pages
   * @returns {string[]}
   * @private
   */
  _getSelectableBasePageIds(pages) {
    if (!Array.isArray(pages)) {
      throw new TypeError('Comparison page inventory must be an array');
    }
    const selectablePageIds = [];
    const seenPageIds = new Set();
    for (const page of pages) {
      if (
        page === null ||
        typeof page !== 'object' ||
        Array.isArray(page) ||
        typeof page.id !== 'string' ||
        page.id.length === 0
      ) {
        throw new TypeError(
          'Comparison pages require a non-empty string id'
        );
      }
      if (seenPageIds.has(page.id)) {
        throw new TypeError(`Comparison page ID "${page.id}" is duplicated`);
      }
      seenPageIds.add(page.id);
      const cellCount = this.dataLayer.getCellCountForPageId(page.id);
      if (!Number.isSafeInteger(cellCount) || cellCount < 0) {
        throw new TypeError(
          `Comparison page "${page.id}" cell count must be a non-negative safe integer`
        );
      }
      if (cellCount > 0) {
        selectablePageIds.push(page.id);
      }
    }
    return selectablePageIds;
  }

  /**
   * Handle pages changed event (pages added/removed/renamed/switched)
   * Unified handling via UI manager
   */
  onPagesChanged() {
    const pages = this.dataLayer.getPages();
    const currentPageIds = pages.map(p => p.id);
    const selectablePageIds = this._getSelectableBasePageIds(pages);
    const selectablePageIdSet = new Set(selectablePageIds);
    const previousPageIds = this._lastKnownPageIds;
    if (!Array.isArray(previousPageIds)) {
      throw new TypeError('Previous comparison page IDs must be an array');
    }
    const previousPageIdSet = new Set(previousPageIds);
    const previousSelectablePageIds = this._lastKnownSelectablePageIds;
    if (!Array.isArray(previousSelectablePageIds)) {
      throw new TypeError(
        'Previous selectable comparison page IDs must be an array'
      );
    }
    const previousSelectablePageIdSet =
      new Set(previousSelectablePageIds);
    const addedSelectablePageIds = selectablePageIds.filter(
      id => !previousPageIdSet.has(id) || !previousSelectablePageIdSet.has(id)
    );

    // Treat the manager's selection as canonical (it is the shared selection across modes).
    const previousSelection = this._uiManager.getCurrentPages();
    if (!Array.isArray(previousSelection)) {
      throw new TypeError('Comparison current pages must be an array');
    }
    const previousSelectionSet = new Set(previousSelection);

    const hadAllPreviously =
      previousSelectablePageIds.length > 0 &&
      previousSelectablePageIds.every(id => previousSelectionSet.has(id));

    const nextSelectionSet = new Set(
      previousSelection.filter(id => selectablePageIdSet.has(id))
    );

    // Preserve "Select All" semantics: if the user previously had all pages selected,
    // auto-include newly created pages so the selection remains "all".
    if (hadAllPreviously) {
      for (const id of addedSelectablePageIds) {
        nextSelectionSet.add(id);
      }
    }

    // If selection is empty after a page-topology change, select every non-empty page.
    if (nextSelectionSet.size === 0) {
      for (const id of selectablePageIds) {
        nextSelectionSet.add(id);
      }
    }

    const nextSelection = selectablePageIds.filter(
      id => nextSelectionSet.has(id)
    );

    this.currentConfig.pages = nextSelection;
    this._uiManager.onPageSelectionChange(nextSelection);
    this._lastKnownPageIds = currentPageIds;
    this._lastKnownSelectablePageIds = selectablePageIds;

    // Keep floating analysis windows in sync with page add/remove/rename changes.
    this._analysisWindowManager.onPagesChanged();
  }

  /**
   * Handle highlight changed event (cells added/removed from pages)
   * Unified handling via UI manager
   */
  onHighlightChanged() {
    const selectablePageIds = this._getSelectableBasePageIds(
      this.dataLayer.getPages()
    );
    const selectablePageIdSet = new Set(selectablePageIds);
    const previousSelection = this._uiManager.getCurrentPages();
    if (!Array.isArray(previousSelection)) {
      throw new TypeError('Comparison current pages must be an array');
    }
    const nextSelection = previousSelection.filter(
      pageId => selectablePageIdSet.has(pageId)
    );
    if (
      nextSelection.length !== previousSelection.length ||
      nextSelection.some(
        (pageId, index) => pageId !== previousSelection[index]
      )
    ) {
      this.currentConfig.pages = [...nextSelection];
      this._uiManager.onPageSelectionChange(nextSelection);
    }
    this._lastKnownSelectablePageIds = selectablePageIds;

    // Notify UI manager (it notifies only the active UI)
    this._uiManager.onHighlightChanged();

    // Notify floating analysis windows too
    this._analysisWindowManager.onHighlightChanged();
  }

  // ===========================================================================
  // Configuration & Hooks
  // ===========================================================================

  /**
   * Get the AnalysisWindowManager instance (if initialized).
   *
   * Session bundle restore uses this to reopen floating analysis windows from
   * descriptors without reaching into private fields.
   *
   * @returns {any|null}
   */
  getAnalysisWindowManager() {
    return this._analysisWindowManager || null;
  }

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
  }

  /**
   * Cleanup and destroy the module
   * @returns {Promise<void>}
   */
  destroy() {
    if (this._destroyPromise != null) return this._destroyPromise;
    const stateSubscriptionErrors = [];
    const stateUnsubscribers = this._stateUnsubscribers;
    this._stateUnsubscribers = [];
    if (stateUnsubscribers !== undefined && stateUnsubscribers !== null) {
      if (!Array.isArray(stateUnsubscribers)) {
        stateSubscriptionErrors.push(
          new TypeError(
            'Comparison state subscription ownership must be an array'
          )
        );
      } else {
        for (const unsubscribe of stateUnsubscribers) {
          if (typeof unsubscribe !== 'function') {
            stateSubscriptionErrors.push(
              new TypeError(
                'Comparison state subscription cleanup must be a function'
              )
            );
            continue;
          }
          try {
            unsubscribe();
          } catch (error) {
            stateSubscriptionErrors.push(error);
          }
        }
      }
    }
    const memoryMonitor = this._memoryMonitor;
    const windowManager = this._analysisWindowManager;
    const uiManager = this._uiManager;
    const dataLayer = this.dataLayer;
    const datasetResetTask = this._datasetResetPromise;

    this._destroyPromise = Promise.resolve().then(async () => {
      const errors = [...stateSubscriptionErrors];
      let memoryHandlerDrain = null;
      if (memoryMonitor !== null && memoryMonitor !== undefined) {
        try {
          memoryHandlerDrain = memoryMonitor.unregisterCleanupHandler(
            'comparison-module'
          );
        } catch (error) {
          errors.push(error);
        }
      }
      this._memoryMonitor = null;

      if (memoryHandlerDrain !== null && memoryHandlerDrain !== undefined) {
        try {
          await memoryHandlerDrain;
        } catch (error) {
          errors.push(error);
        }
      }

      // A dataset reset owns both managers until it has fully settled. Retire
      // those managers only after that owner releases them; otherwise destroy()
      // can race reset-owned close/reset work on the same child instances.
      if (datasetResetTask != null) {
        try {
          await datasetResetTask;
        } catch (error) {
          errors.push(error);
        }
      }

      const ownerTasks = [];
      if (windowManager !== null && windowManager !== undefined) {
        if (typeof windowManager.closeAll !== 'function') {
          errors.push(
            new TypeError(
              'AnalysisWindowManager must implement closeAll()'
            )
          );
        } else {
          try {
            ownerTasks.push(windowManager.closeAll());
          } catch (error) {
            errors.push(error);
          }
        }
      }
      if (uiManager !== null && uiManager !== undefined) {
        if (typeof uiManager.destroy !== 'function') {
          errors.push(
            new TypeError('AnalysisUIManager must implement destroy()')
          );
        } else {
          try {
            ownerTasks.push(uiManager.destroy());
          } catch (error) {
            errors.push(error);
          }
        }
      }
      const ownerOutcomes = await Promise.allSettled(ownerTasks);
      errors.push(
        ...ownerOutcomes
          .filter(outcome => outcome.status === 'rejected')
          .map(outcome => outcome.reason)
      );

      if (dataLayer !== null && dataLayer !== undefined) {
        if (typeof dataLayer.destroy !== 'function') {
          errors.push(
            new TypeError('Comparison DataLayer must implement destroy()')
          );
        } else {
          try {
            await dataLayer.destroy();
          } catch (error) {
            errors.push(error);
          }
        }
      }

      this._analysisWindowManager = null;
      this._uiManager = null;
      this.dataLayer = null;
      this._multiVariableAnalysis = null;

      const exactErrors = [...new Set(errors)];
      if (exactErrors.length === 1) throw exactErrors[0];
      if (exactErrors.length > 1) {
        throw new AggregateError(
          exactErrors,
          'Comparison module destruction failed'
        );
      }
    });
    void this._destroyPromise.catch(() => {});
    return this._destroyPromise;
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
   * Reset analysis UI + caches after an in-place dataset reload.
   *
   * In-place reload keeps the JS context alive (notably `local-user` datasets),
   * so analysis UIs and caches that assume dataset-stable identities must be
   * cleared to avoid cross-dataset state bleed.
   *
   * @param {object} options
   * @param {string} options.reason
   */
  resetForDatasetReload(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Dataset reload reset options must be an object');
    }
    const { reason } = options;
    if (
      typeof reason !== 'string' ||
      reason.length === 0 ||
      reason !== reason.trim()
    ) {
      throw new TypeError(
        'Dataset reload reset reason must be one exact non-empty string'
      );
    }
    if (this._destroyPromise != null) {
      throw new Error('Cannot reset a destroyed ComparisonModule');
    }
    if (this._datasetResetPromise != null) {
      return this._datasetResetPromise;
    }
    if (!Number.isSafeInteger(this._datasetReloadResetCount)) {
      throw new TypeError('Dataset reload reset count must be a safe integer');
    }
    const windowManager = this._analysisWindowManager;
    const uiManager = this._uiManager;
    const dataLayer = this.dataLayer;
    if (
      windowManager !== null &&
      windowManager !== undefined &&
      typeof windowManager.closeAll !== 'function'
    ) {
      throw new TypeError('AnalysisWindowManager must implement closeAll()');
    }
    if (
      uiManager !== null &&
      uiManager !== undefined &&
      (
        typeof uiManager.clearActiveMode !== 'function' ||
        typeof uiManager.reset !== 'function'
      )
    ) {
      throw new TypeError(
        'AnalysisUIManager must implement clearActiveMode() and reset()'
      );
    }
    if (
      dataLayer === null ||
      dataLayer === undefined ||
      typeof dataLayer.resetForDatasetReload !== 'function'
    ) {
      throw new TypeError(
        'Dataset reload requires DataLayer.resetForDatasetReload()'
      );
    }
    if (typeof this.onPagesChanged !== 'function') {
      throw new TypeError('ComparisonModule.onPagesChanged() is required');
    }

    // Publish the reset owner before touching any child or DOM surface.
    // closeAll(), reset(), and even a classList implementation can reenter
    // destroy(); that destruction must capture and drain this exact task.
    let resolveOwnedReset;
    let rejectOwnedReset;
    const task = new Promise((resolve, reject) => {
      resolveOwnedReset = resolve;
      rejectOwnedReset = reject;
    });
    this._datasetResetPromise = task;
    const releaseTask = () => {
      if (this._datasetResetPromise === task) {
        this._datasetResetPromise = null;
      }
    };
    void task.then(releaseTask, releaseTask);
    void task.catch(() => {});

    const errors = [];
    const managerTasks = [];
    const runSynchronous = operation => {
      try {
        return operation();
      } catch (error) {
        errors.push(error);
        return undefined;
      }
    };

    try {
      if (this._modeToggleContainer !== null) {
        if (
          typeof this._modeToggleContainer?.querySelectorAll !== 'function'
        ) {
          errors.push(
            new TypeError(
              'Analysis accordion must implement querySelectorAll()'
            )
          );
        } else {
          const items = this._modeToggleContainer.querySelectorAll(
            '.analysis-mode'
          );
          if (
            items === null ||
            typeof items[Symbol.iterator] !== 'function'
          ) {
            errors.push(
              new TypeError(
                'Analysis accordion query must return an iterable'
              )
            );
          } else {
            for (const item of items) {
              runSynchronous(() => setModeItemOpen(item, false));
            }
          }
        }
      }

      if (windowManager !== null && windowManager !== undefined) {
        const closeTask = runSynchronous(() => windowManager.closeAll());
        if (closeTask && typeof closeTask.then === 'function') {
          managerTasks.push(closeTask);
        }
      }
      // Window and expanded-view sizes belong to the dataset they were given on.
      runSynchronous(() => analysisViewSizes.clear());
      if (uiManager !== null && uiManager !== undefined) {
        runSynchronous(() => uiManager.clearActiveMode());
        const resetTask = runSynchronous(() => uiManager.reset());
        if (resetTask && typeof resetTask.then === 'function') {
          managerTasks.push(resetTask);
        }
      }
    } catch (error) {
      errors.push(error);
    }

    if (errors.length > 0) {
      const exactErrors = [...new Set(errors)];
      const setupError = exactErrors.length === 1
        ? exactErrors[0]
        : new AggregateError(
            exactErrors,
            `Dataset reload analysis reset failed in ` +
              `${exactErrors.length} operations`
          );
      void Promise.allSettled(managerTasks).then(() => {
        rejectOwnedReset(setupError);
      });
      // Preserve the existing synchronous setup-failure surface while the
      // already-published owner remains available to a reentrant destroy().
      throw setupError;
    }

    const lifecycleTask = Promise.resolve().then(async () => {
      const lifecycleErrors = [];
      const managerOutcomes = await Promise.allSettled(managerTasks);
      lifecycleErrors.push(
        ...managerOutcomes
          .filter(outcome => outcome.status === 'rejected')
          .map(outcome => outcome.reason)
      );

      try {
        await dataLayer.resetForDatasetReload();
      } catch (error) {
        lifecycleErrors.push(error);
      }

      this._analysisMode = null;
      this._multiVariableAnalysis = null;

      try {
        await this.onPagesChanged();
      } catch (error) {
        lifecycleErrors.push(error);
      }

      const exactErrors = [...new Set(lifecycleErrors)];
      if (exactErrors.length === 1) throw exactErrors[0];
      if (exactErrors.length > 1) {
        throw new AggregateError(
          exactErrors,
          'Dataset reload analysis reset failed'
        );
      }

      this._datasetReloadResetCount += 1;
      this._lastDatasetReloadReset = {
        at: Date.now(),
        reason,
      };
    });
    void lifecycleTask.then(resolveOwnedReset, rejectOwnedReset);
    return task;
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
      signature: this._uiManager?.getUI('signature'),
      genesPanel: this._uiManager?.getUI('genesPanel'),
      dotplot: this._uiManager?.getUI('dotplot'),
      composition: this._uiManager?.getUI('composition')
    };
  }

  /**
   * Get a specific analysis UI by mode ID
   * @param {string} modeId - Mode ID (simple, detailed, correlation, differential, signature, genesPanel)
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

  /**
   * Colour the cells by one gene of a result (a marker or a DE gene), through
   * the sidebar's gene selector, so its search box names the gene shown. A
   * gene the shown expression matrix lacks (a result read from another
   * matrix) is said in a notification; a newer choice supersedes this one.
   *
   * @param {string} geneKey
   * @returns {Promise<void>}
   */
  async colorByGene(geneKey) {
    const known = this.dataLayer.getAvailableVariables('gene_expression').some(gene => gene.key === geneKey);
    if (!known) {
      this._notifications.info(`${geneKey} is not in the expression matrix shown`, { category: 'analysis' });
      return;
    }
    try {
      await this._colorByGene(geneKey);
    } catch (error) {
      this._notifications.error(`Colouring by ${geneKey} failed: ${error.message}`, { category: 'analysis' });
    }
  }

  /**
   * Open one analysis in the docked panel and hand it a preset — the "Send to"
   * path between analyses (marker genes → gene signature or dot plot). The
   * row opens the way a click opens it, scrolls into view, and the analysis
   * applies the preset through its own `applyPreset(preset)`, which validates
   * it and refuses what it cannot use.
   *
   * @param {string} modeId - A registered analysis id.
   * @param {Object} preset - Analysis-specific values; see each analysis's `applyPreset`.
   * @returns {Promise<void>}
   */
  async openAnalysis(modeId, preset) {
    const uiManager = this._uiManager;
    if (!uiManager) throw new Error('The analysis panel is not initialized');
    if (uiManager.getTypeInfo(modeId) === null) {
      throw new Error(`Unknown analysis "${modeId}"`);
    }
    if (preset === null || typeof preset !== 'object' || Array.isArray(preset)) {
      throw new TypeError(`The preset for analysis "${modeId}" must be an object`);
    }
    if (this._getOpenMode() !== modeId) this._setAnalysisMode(modeId);
    const ui = uiManager.getUI(modeId);
    if (typeof ui?.applyPreset !== 'function') {
      throw new Error(`Analysis "${modeId}" does not accept presets`);
    }
    await ui.applyPreset(preset);
    this._modeToggleContainer
      ?.querySelector(`.analysis-mode[data-mode="${modeId}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }

  // ===========================================================================
  // Session state (docked analysis panel)
  // ===========================================================================

  /**
   * The docked mode whose row is open, or null when every row is closed.
   * @returns {string|null}
   * @private
   */
  _getOpenMode() {
    if (!this._modeToggleContainer) return null;
    for (const item of this._modeToggleContainer.querySelectorAll('.analysis-mode')) {
      if (isModeItemOpen(item)) return item.dataset.mode;
    }
    return null;
  }

  /**
   * The docked analysis panel for a session: which mode row is open, and for
   * every mode created so far its settings (`ui.exportSettings()`) and result
   * (`ui.exportResult()`: null, or `{kind, version, payload}` of JSON values
   * and typed arrays; see shared/analysis-result-session.js). A mode never
   * opened holds its defaults and is left out.
   *
   * @returns {{openMode: string|null, modes: Object<string, {settings: Object, result: null|Object}>}}
   */
  exportSessionState() {
    const uiManager = this._uiManager;
    if (!uiManager) throw new Error('The analysis panel is not initialized');
    const modes = {};
    for (const { id } of uiManager.getAllTypes()) {
      if (!uiManager.isInitialized(id)) continue;
      const ui = uiManager.getUI(id);
      setOwnDataProperty(modes, id, {
        settings: ui.exportSettings(),
        result: ui.exportResult()
      });
    }
    const openMode = this._getOpenMode();
    if (openMode !== null && !Object.hasOwn(modes, openMode)) {
      throw new Error(`The open analysis mode "${openMode}" has no initialized panel`);
    }
    return { openMode, modes };
  }

  /**
   * Restore `exportSessionState()` output: open the saved mode row the way a
   * click does (or close the open one), then for each mode apply its
   * settings and then its result. The value is checked whole before anything
   * changes; a mode's own settings and result are checked by its UI, and the
   * first refusal is thrown.
   *
   * @param {{openMode: string|null, modes: Object<string, {settings: Object, result: null|Object}>}} state
   * @returns {Promise<void>}
   */
  async importSessionState(state) {
    const uiManager = this._uiManager;
    if (!uiManager) throw new Error('The analysis panel is not initialized');
    const isRecord = value => (
      value !== null && typeof value === 'object' && !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    );
    const exactKeys = (value, keys) => (
      isRecord(value) && Object.keys(value).sort().join('\u0000') === [...keys].sort().join('\u0000')
    );
    if (!exactKeys(state, ['openMode', 'modes'])) {
      throw new TypeError('Analysis session state must hold exactly openMode and modes');
    }
    if (!isRecord(state.modes)) {
      throw new TypeError('Analysis session modes must be an object');
    }
    for (const [modeId, mode] of Object.entries(state.modes)) {
      if (uiManager.getTypeInfo(modeId) === null) {
        throw new Error(`Analysis session names an unknown mode "${modeId}"`);
      }
      if (!exactKeys(mode, ['settings', 'result'])) {
        throw new TypeError(`Analysis session mode "${modeId}" must hold exactly settings and result`);
      }
      if (!isRecord(mode.settings)) {
        throw new TypeError(`Analysis session mode "${modeId}" settings must be an object`);
      }
      if (mode.result !== null && !isRecord(mode.result)) {
        throw new TypeError(`Analysis session mode "${modeId}" result must be null or an object`);
      }
    }
    const { openMode } = state;
    if (openMode !== null && !Object.hasOwn(state.modes, openMode)) {
      throw new TypeError('Analysis session openMode must be null or one of its modes');
    }

    const currentOpenMode = this._getOpenMode();
    if (openMode !== currentOpenMode) {
      // _setAnalysisMode toggles: naming the open row closes it.
      this._setAnalysisMode(openMode ?? currentOpenMode);
    }
    for (const [modeId, mode] of Object.entries(state.modes)) {
      const ui = uiManager.getUI(modeId);
      ui.importSettings(structuredClone(mode.settings));
      await ui.importResult(mode.result);
    }
  }
}

/**
 * Create a new ComparisonModule instance
 */
export function createComparisonModule(options) {
  const module = new ComparisonModule(options);
  module.init();
  return module;
}
