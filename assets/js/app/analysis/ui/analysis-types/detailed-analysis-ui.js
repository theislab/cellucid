/**
 * Detailed Analysis UI Component
 *
 * Provides the DETAILED analysis mode with full control over:
 * - Variable selection (categorical obs, continuous obs, gene expression)
 * - Plot type selection
 * - Plot options customization
 * - Preview and expanded view
 * - Export functionality
 *
 * This component extends BaseAnalysisUI for shared functionality and
 * adds detailed-specific features like plot options.
 */

import { BaseAnalysisUI } from '../base-analysis-ui.js';
// Import PlotRegistry from canonical shared directory
import { PlotRegistry } from '../../shared/plot-registry-utils.js';
import {
  createPlotTypeSelector,
  createAnalysisModal,
  openModal,
  closeModal,
  renderPlotOptions,
  renderSummaryStats,
  renderStatisticalAnnotations,
  createExpandButton
} from '../components/index.js';
import { createVariableSelectorComponent } from '../shared/variable-selector.js';
import { PageSelectorComponent } from '../shared/page-selector.js';
import { loadPlotly } from '../../plots/plotly-loader.js';
import { createLayoutEngine } from '../../plots/layout-engine.js';
import { PlotlyRenderSlot } from '../../shared/plotly-render-slot.js';

function combineErrors(errors, message) {
  const present = [...new Set(errors.filter(Boolean))];
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  return new AggregateError(present, message);
}

function requireSavedPlotOptions(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError('Detailed Analysis savedPlotOptions must be an array');
  }
  const optionsByPlot = new Map();
  for (const entry of entries) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      entry[0].length === 0 ||
      entry[1] === null ||
      typeof entry[1] !== 'object' ||
      Array.isArray(entry[1])
    ) {
      throw new TypeError(
        'Detailed Analysis savedPlotOptions must contain [plotType, options] pairs'
      );
    }
    const [plotType, options] = entry;
    if (!PlotRegistry.get(plotType)) {
      throw new Error(
        `Detailed Analysis saved plot type "${plotType}" was not found`
      );
    }
    if (optionsByPlot.has(plotType)) {
      throw new TypeError(
        `Detailed Analysis saved plot type "${plotType}" is duplicated`
      );
    }
    optionsByPlot.set(plotType, structuredClone(options));
  }
  return optionsByPlot;
}

/**
 * Detailed Analysis UI Component
 * Extends BaseAnalysisUI with detailed-specific functionality.
 */
export class DetailedAnalysisUI extends BaseAnalysisUI {
  /**
   * Get page requirements for detailed analysis
   * @static
   * @returns {{ minPages: number, maxPages: number|null, description: string }}
   */
  static getRequirements() {
    return {
      minPages: 1,
      maxPages: null, // No limit
      description: 'Select at least 1 page'
    };
  }

  /**
   * @param {Object} options
   * @param {Object} options.comparisonModule - Reference to main comparison module
   * @param {Object} options.dataLayer - Enhanced data layer
   * @param {Function} [options.onConfigChange] - Callback when config changes
   */
  constructor(options) {
    super(options);

    this._idPrefix = this._instanceId ? `${this._instanceId}-detailed` : 'detailed';
    this._plotTypeSelectId = this._instanceId ? `${this._instanceId}-analysis-plot-type` : 'analysis-plot-type';

    // UI element references (detailed-specific)
    this._variableSelector = null;
    this._pageSelector = null;
    this._pageSelectContainer = null;
    this._plotTypeContainer = null;

    // Session-only saved options per plot type
    this._savedPlotOptions = new Map();

    // Layout engine for plots
    this._layoutEngine = null;
    this._previewPlotSlot = null;
    this._modalPlotSlot = null;
    this._pendingModalCloseTasks = new Set();
    this._destroyPromise = null;
    this._modalRenderGeneration = 0;

    // Bind methods
    this._handleVariableChange = this._handleVariableChange.bind(this);
    this._handlePlotTypeChange = this._handlePlotTypeChange.bind(this);
    this._handlePlotOptionChange = this._handlePlotOptionChange.bind(this);
    this._openExpandedView = this._openExpandedView.bind(this);
  }

  /**
   * Render the complete UI structure (implements abstract method from BaseAnalysisUI)
   * @override
   */
  _render() {
    this._container.innerHTML = '';
    // Use classList.add to preserve original classes (e.g., analysis-accordion-content)
    this._container.classList.add('detailed-analysis-ui');

    // Intro section (matches other analysis panels)
    const intro = document.createElement('div');
    intro.className = 'analysis-intro';
    intro.innerHTML = `
      <h3>Detailed</h3>
      <p>Full control over variables, plots, and customization across selected pages.</p>
    `;
    this._container.appendChild(intro);

    // Controls container
    this._controlsContainer = document.createElement('div');
    this._controlsContainer.className = 'detailed-analysis-controls';
    this._container.appendChild(this._controlsContainer);

    // Preview container
    this._previewContainer = document.createElement('div');
    this._previewContainer.className = 'analysis-preview-container empty';
    this._container.appendChild(this._previewContainer);

    // Actions container
    this._actionsContainer = document.createElement('div');
    this._actionsContainer.className = 'analysis-actions';
    this._actionsContainer.style.display = 'none';
    this._container.appendChild(this._actionsContainer);

    // Render controls
    this._renderControls();
  }

  /**
   * Render the control panel
   */
  _renderControls() {
    this._controlsContainer.innerHTML = '';

    let pages;
    try {
      pages = this.dataLayer.getPages();
    } catch (err) {
      console.error('[DetailedAnalysisUI] Failed to get pages:', err);
      this._controlsContainer.innerHTML = `
        <div class="analysis-error">Failed to load pages. Please try refreshing.</div>
      `;
      return;
    }

    // If no pages, show message
    if (pages.length === 0) {
      this._controlsContainer.innerHTML = `
        <div class="legend-help">Create highlight pages first using the Highlighted Cells section above.</div>
      `;
      const invalidationRequestId = this._invalidateAnalysisRequest();
      this._trackInteractiveTask(
        this._hidePreview(invalidationRequestId),
        'Detailed preview cleanup'
      );
      return;
    }

    // Variable selectors
    this._renderVariableSelectors();

    // Page selector
    this._renderPageSelector(pages);

    // Plot type selector (only if variable selected)
    if (this._currentConfig.dataSource.variable) {
      this._renderPlotTypeSelector();
    }
  }

  /**
   * Render variable selectors (two-step selection)
   */
  _renderVariableSelectors() {
    const variableBlock = document.createElement('div');
    variableBlock.className = 'control-block';

    try {
      // Create the variable selector container
      const selectorContainer = document.createElement('div');
      variableBlock.appendChild(selectorContainer);

      // Destroy previous selector if exists
      this._variableSelector?.destroy?.();

      // Create two-step variable selector
      this._variableSelector = createVariableSelectorComponent({
        dataLayer: this.dataLayer,
        container: selectorContainer,
        allowedTypes: ['categorical', 'continuous', 'gene'],
        idPrefix: this._idPrefix,
        typeLabel: 'Variable:',
        initialSelection: this._currentConfig.dataSource.type ? {
          type: this._currentConfig.dataSource.type,
          variable: this._currentConfig.dataSource.variable
        } : undefined,
        onVariableChange: this._handleVariableChange
      });
    } catch (err) {
      console.error('[DetailedAnalysisUI] Failed to load variables:', err);
      variableBlock.innerHTML += `
        <div class="legend-help text-danger">
          Some variables could not be loaded.
        </div>
      `;
    }

    this._controlsContainer.appendChild(variableBlock);
  }

  /**
   * Render page selector using shared PageSelectorComponent
   */
  _renderPageSelector(pages) {
    // Create container for the component
    this._pageSelectContainer = document.createElement('div');
    this._controlsContainer.appendChild(this._pageSelectContainer);

    // Destroy previous instance if exists
    this._pageSelector?.destroy();

    // Create PageSelectorComponent
    this._pageSelector = new PageSelectorComponent({
      dataLayer: this.dataLayer,
      container: this._pageSelectContainer,
      onSelectionChange: this._handlePageChange,
      onColorChange: this._handlePageColorChange,
      showColorPicker: true,
      showCellCounts: true,
      showSelectAll: true,
      initialSelection: this._selectedPages.length > 0
        ? this._selectedPages
        : undefined,
      includeDerivedPages: true,
      getCellCountForPageId: (pageId) => this.dataLayer.getCellCountForPageId(pageId),
      label: 'Compare pages:'
    });
    this._selectedPages = this._pageSelector.getSelectedPages();
    this._currentConfig.pages = [...this._selectedPages];
  }

  /**
   * Render plot type selector
   */
  _renderPlotTypeSelector() {
    const dataKind = this._currentConfig.dataSource.type === 'categorical_obs'
      ? 'categorical' : 'continuous';

    // Auto-select first compatible plot type if none selected
    if (!this._currentConfig.plotType) {
      const compatiblePlots = PlotRegistry.getForDataType(dataKind);
      if (compatiblePlots.length > 0) {
        this._currentConfig.plotType = compatiblePlots[0].id;
      }
    }

    const plotTypeSelector = createPlotTypeSelector({
      dataType: dataKind,
      selectedId: this._currentConfig.plotType,
      onChange: this._handlePlotTypeChange,
      id: this._plotTypeSelectId
    });
    this._controlsContainer.appendChild(plotTypeSelector);
    this._plotTypeContainer = plotTypeSelector;
  }

  exportSettings() {
    const base = super.exportSettings();
    const savedPlotOptions = requireSavedPlotOptions(
      Array.from(this._savedPlotOptions.entries())
    );
    return {
      ...base,
      savedPlotOptions: Array.from(savedPlotOptions.entries())
    };
  }

  importSettings(settings) {
    this._requireExactSettingsKeys(
      settings,
      ['config', 'savedPlotOptions', 'selectedPages'],
      'Detailed Analysis settings'
    );
    const base = this._requireBaseSettings(settings);
    const savedPlotOptions = requireSavedPlotOptions(settings.savedPlotOptions);

    this._savedPlotOptions = savedPlotOptions;
    this._applyBaseSettings(base);
  }

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  /**
   * Handle variable selection change from two-step selector
   * @param {string} type - Variable type (categorical_obs, continuous_obs, gene_expression)
   * @param {string} variable - Variable key
   */
  _handleVariableChange(type, variable) {
    if (type && variable) {
      this._currentConfig.dataSource.type = type;
      this._currentConfig.dataSource.variable = variable;

      // Update plot type based on data kind
      const dataKind = type === 'categorical_obs' ? 'categorical' : 'continuous';
      this._updatePlotTypeForDataKind(dataKind);

      // Only re-render controls when we have a full selection
      // This ensures plot type selector appears
      this._renderControls();
      this._scheduleUpdate();
    } else if (this._currentConfig.dataSource.variable) {
      // Only clear if we previously had a selection
      this._clearDataSource();
      this._renderControls();
      this._scheduleUpdate();
    }
    // When type is selected but variable is not yet chosen,
    // don't re-render - let the selector handle its own state
  }

  _handlePageChange = (pageIds) => {
    this._selectedPages = pageIds || [];
    this._currentConfig.pages = this._selectedPages;
    this._scheduleUpdate();

    if (this.onConfigChange) {
      this.onConfigChange(this._currentConfig);
    }
  };

  _handlePageColorChange = (pageId, color) => {
    // Persist color to DataState for base pages; component handles derived colors internally
    this.dataLayer?.setPageColor?.(pageId, color);
    this._scheduleUpdate();
  };

  _handlePlotTypeChange(plotTypeId) {
    this._currentConfig.plotType = plotTypeId;
    this._currentConfig.plotOptions = this._getSavedOptionsForPlotType(plotTypeId);
    this._scheduleUpdate();

    if (this._modal?._optionsContent) {
      renderPlotOptions(
        this._modal._optionsContent,
        plotTypeId,
        this._currentConfig.plotOptions,
        this._handlePlotOptionChange
      );
    }
  }

  _handlePlotOptionChange(key, value) {
    this._currentConfig.plotOptions[key] = value;
    this._saveOptionsForPlotType(this._currentConfig.plotType, this._currentConfig.plotOptions);
    this._scheduleUpdate();
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  /**
   * Clear data source selection
   */
  _clearDataSource() {
    this._currentConfig.dataSource.type = '';
    this._currentConfig.dataSource.variable = '';
    this._currentConfig.plotType = '';
    this._currentConfig.plotOptions = {};
  }

  /**
   * Update plot type based on data kind (categorical vs continuous)
   * @param {string} kind - 'categorical' or 'continuous'
   */
  _updatePlotTypeForDataKind(kind) {
    const compatiblePlots = PlotRegistry.getForDataType(kind);
    const currentPlotCompatible = compatiblePlots.find(p => p.id === this._currentConfig.plotType);

    if (!currentPlotCompatible && compatiblePlots.length > 0) {
      this._currentConfig.plotType = compatiblePlots[0].id;
      this._currentConfig.plotOptions = {};
    }
  }

  _reportPlotLifecycleError(context, error) {
    if (!(error instanceof Error)) {
      error = new TypeError(`${context} failed with a non-Error value`);
    }
    this._notifications.error(
      `${context} failed: ${error.message}`,
      { category: 'analysis', title: 'Analysis Error' }
    );
  }

  _createPlotSlot(host, candidateClassName) {
    return new PlotlyRenderSlot({
      host,
      candidateClassName,
      onResizeError: error => {
        this._reportPlotLifecycleError('Plot resize', error);
      }
    });
  }

  _ensurePreviewPlotSlot() {
    if (this._previewPlotSlot !== null) return this._previewPlotSlot;
    if (!(this._previewContainer instanceof HTMLElement)) {
      throw new TypeError('Detailed preview requires an initialized container');
    }
    this._previewPlotSlot = this._createPlotSlot(
      this._previewContainer,
      'analysis-preview-plot'
    );
    return this._previewPlotSlot;
  }

  _trackModalCloseTask(task) {
    if (!task || typeof task.then !== 'function') {
      return Promise.resolve(task);
    }
    this._pendingModalCloseTasks ??= new Set();
    this._pendingModalCloseTasks.add(task);
    task.then(
      () => this._pendingModalCloseTasks.delete(task),
      () => this._pendingModalCloseTasks.delete(task)
    );
    return task;
  }

  _destroyModalPlotOwner(modal) {
    const slot = modal?._analysisPlotSlot ?? null;
    if (this._modal === modal) this._modal = null;
    if (this._modalPlotSlot === slot) this._modalPlotSlot = null;
    modal._analysisPlotSlot = null;
    if (slot === null) return Promise.resolve();
    return this._trackModalCloseTask(slot.destroy());
  }

  _ensureModalPlotSlot(modal) {
    if (!(modal?._plotContainer instanceof HTMLElement)) {
      throw new TypeError('Detailed modal requires an exact plot container');
    }
    if (modal._analysisPlotSlot != null) {
      this._modalPlotSlot = modal._analysisPlotSlot;
      return modal._analysisPlotSlot;
    }
    const slot = this._createPlotSlot(
      modal._plotContainer,
      'analysis-modal-plot-candidate'
    );
    modal._analysisPlotSlot = slot;
    this._modalPlotSlot = slot;
    if (modal._beforeClose == null) {
      modal._beforeClose = () => this._destroyModalPlotOwner(modal);
    }
    return slot;
  }

  _scheduleUpdate(delay = 300) {
    this._modalRenderGeneration += 1;
    return super._scheduleUpdate(delay);
  }

  // _canRunAnalysis(), _scheduleUpdate(), _runAnalysisIfValid() - inherited from BaseAnalysisUI

  // ===========================================================================
  // Analysis Execution
  // ===========================================================================

  /**
   * Run the analysis (implements abstract method from BaseAnalysisUI)
   * @override
   */
  async _runAnalysis(requestId) {
    if (!this._isCurrentAnalysisRequest(requestId)) return;
    const config = structuredClone(this._currentConfig);
    const pageIds = [...this._selectedPages];
    const customColors = new Map(
      this._pageSelector?.getCustomColors?.() || []
    );

    if (!this._isCurrentAnalysisRequest(requestId)) return;
    this._previewContainer.classList.remove('empty');
    this._previewContainer.classList.add('loading');

    try {
      await loadPlotly();
      if (!this._isCurrentAnalysisRequest(requestId)) return;

      // Fetch data
      const pageData = await this.dataLayer.getDataForPages({
        type: config.dataSource.type,
        variableKey: config.dataSource.variable,
        pageIds
      });

      if (!this._isCurrentAnalysisRequest(requestId)) return;
      if (pageData.length === 0) {
        throw new Error('No data available for selected pages');
      }

      // Create layout engine with custom colors from page selector
      const layoutEngine = createLayoutEngine({
        pageCount: pageData.length,
        pageIds: pageData.map(pd => pd.pageId),
        pageNames: pageData.map(pd => pd.pageName),
        syncXAxis: true,
        syncYAxis: true,
        customColors
      });

      // Get plot type
      const plotType = PlotRegistry.get(config.plotType);
      if (!plotType) {
        throw new Error(`Unknown plot type: ${config.plotType}`);
      }

      const mergedOptions = PlotRegistry.mergeOptions(
        config.plotType,
        config.plotOptions
      );

      if (!this._isCurrentAnalysisRequest(requestId)) return;
      const previewSlot = this._ensurePreviewPlotSlot();
      const previewPlotDiv = await previewSlot.render(
        {
          pageData,
          variableName: config.dataSource.variable,
          render: candidate => plotType.render(
            pageData,
            mergedOptions,
            candidate,
            layoutEngine
          )
        },
        {
          isCurrent: () => this._isCurrentAnalysisRequest(requestId)
        }
      );
      if (previewPlotDiv === null) return;

      this._previewContainer.classList.remove('loading');
      this._previewContainer.classList.remove('empty');
      this._currentPageData = pageData;
      this._layoutEngine = layoutEngine;

      // Show actions
      this._renderActions();

      // Update modal if open
      if (this._modal?._plotContainer) {
        await this._updateModal(
          plotType,
          mergedOptions,
          pageData,
          layoutEngine,
          config,
          requestId
        );
      }

    } catch (err) {
      if (!this._isCurrentAnalysisRequest(requestId)) return;
      this._previewContainer.classList.remove('loading');
      this._previewContainer.classList.add('empty');
      throw err;
    }
  }

  async _updateModal(
    plotType,
    options,
    pageData,
    layoutEngine,
    config,
    requestId
  ) {
    if (!this._isCurrentAnalysisRequest(requestId)) return;
    const modal = this._modal;
    const plotContainer = modal?._plotContainer;
    if (!plotContainer) return;

    const slot = this._ensureModalPlotSlot(modal);
    await slot.waitForCommittedLeases();
    if (
      !this._isCurrentAnalysisRequest(requestId) ||
      this._modal !== modal
    ) {
      return;
    }
    const candidate = await slot.render(
      {
        pageData,
        variableName: config.dataSource.variable,
        render: plotCandidate => plotType.render(
          pageData,
          options,
          plotCandidate,
          layoutEngine
        )
      },
      {
        isCurrent: () => (
          this._isCurrentAnalysisRequest(requestId) &&
          this._modal === modal
        )
      }
    );
    if (candidate === null) return;

    const modalAfter = this._modal;
    if (!modalAfter) return;

    if (modalAfter._statsContent) {
      renderSummaryStats(
        modalAfter._statsContent,
        pageData,
        config.dataSource.variable
      );
    }

    if (modalAfter._annotationsContent) {
      renderStatisticalAnnotations(
        modalAfter._annotationsContent,
        pageData,
        config.dataSource.type
      );
    }
  }

  // ===========================================================================
  // Preview & Actions
  // ===========================================================================

  async _hidePreview(requestId = null) {
    const publicationCurrent =
      await this._cleanupPreviousAnalysis(requestId);
    if (!publicationCurrent) return false;

    if (this._previewContainer) {
      for (const child of [...this._previewContainer.children]) {
        if (
          child.classList.contains('analysis-error') ||
          child.classList.contains('analysis-empty-message')
        ) {
          child.remove();
        }
      }
      this._previewContainer.classList.add('empty');
      this._previewContainer.classList.remove('loading');
    }
    if (this._actionsContainer) {
      this._actionsContainer.style.display = 'none';
    }
    return true;
  }

  async _showError(message, requestId = null) {
    const publicationCurrent = await this._hidePreview(requestId);
    if (
      !publicationCurrent ||
      (
        requestId !== null &&
        !this._isCurrentAnalysisRequest(requestId)
      )
    ) {
      return false;
    }
    if (this._previewContainer) {
      const errorEl = document.createElement('div');
      errorEl.className = 'analysis-error';
      errorEl.textContent = message ?? '';
      this._previewContainer.appendChild(errorEl);
    }
    this._notifications.error(
      message,
      { category: 'data', title: 'Analysis Error' }
    );
    return true;
  }

  async _cleanupPreviousAnalysis(requestId = null) {
    const modal = this._modal;
    const tasks = [];
    const errors = [];
    for (const slot of [
      this._previewPlotSlot,
      modal?._analysisPlotSlot
    ]) {
      if (slot === null || slot === undefined) continue;
      try {
        tasks.push(slot.invalidate());
      } catch (error) {
        errors.push(error);
      }
    }
    const outcomes = await Promise.allSettled(tasks);
    errors.push(
      ...outcomes
        .filter(outcome => outcome.status === 'rejected')
        .map(outcome => outcome.reason)
    );
    const publicationCurrent = (
      requestId === null ||
      this._isCurrentAnalysisIntent(requestId)
    );
    if (publicationCurrent) {
      this._currentPageData = null;
      this._layoutEngine = null;
      if (this._modal === modal && modal !== null) {
        for (const content of [
          modal._statsContent,
          modal._annotationsContent
        ]) {
          if (content === null || content === undefined) continue;
          try {
            content.innerHTML = '';
          } catch (error) {
            errors.push(error);
          }
        }
      }
    }
    const failure = combineErrors(
      errors,
      'Detailed plot cleanup failed'
    );
    if (failure) throw failure;
    return publicationCurrent;
  }

  /**
   * Render action buttons (expand, etc.)
   */
  _renderActions() {
    this._actionsContainer.innerHTML = '';
    this._actionsContainer.style.display = 'flex';

    const expandBtn = createExpandButton(() => {
      this._trackInteractiveTask(
        this._openExpandedView(),
        'Expanded analysis view'
      );
    });
    this._actionsContainer.appendChild(expandBtn);
  }

  // ===========================================================================
  // Modal / Expanded View
  // ===========================================================================

  async _openExpandedView() {
    if (!this._canRunAnalysis()) return;

    const pageData = this._currentPageData;
    const layoutEngine = this._layoutEngine;
    const config = structuredClone(this._currentConfig);
    const generation = ++this._modalRenderGeneration;
    let modal = null;
    modal = createAnalysisModal({
      beforeClose: () => this._destroyModalPlotOwner(modal),
      onClose: () => {
        if (this._modal === modal) this._modal = null;
      },
      onCloseError: error => {
        this._reportPlotLifecycleError('Expanded view cleanup', error);
      },
      onExportPNG: () => this._trackInteractiveTask(
        this._exportPNG(),
        'PNG export'
      ),
      onExportSVG: () => this._trackInteractiveTask(
        this._exportSVG(),
        'SVG export'
      ),
      onExportCSV: () => this._trackInteractiveTask(
        this._exportCSV(),
        'CSV export'
      )
    });
    this._modal = modal;

    if (modal._title) {
      modal._title.textContent = `Comparing: ${config.dataSource.variable}`;
    }

    if (modal._optionsContent) {
      renderPlotOptions(
        modal._optionsContent,
        config.plotType,
        config.plotOptions,
        this._handlePlotOptionChange
      );
    }

    openModal(modal);

    if (pageData && modal._plotContainer) {
      try {
        await loadPlotly();

        const plotType = PlotRegistry.get(config.plotType);
        if (!plotType) {
          throw new RangeError(`Unknown plot type: ${config.plotType}`);
        }
        const mergedOptions = PlotRegistry.mergeOptions(
          config.plotType,
          config.plotOptions
        );

        const slot = this._ensureModalPlotSlot(modal);
        const candidate = await slot.render(
          {
            pageData,
            variableName: config.dataSource.variable,
            render: plotCandidate => plotType.render(
              pageData,
              mergedOptions,
              plotCandidate,
              layoutEngine
            )
          },
          {
            isCurrent: () => (
              !this._isDestroyed &&
              this._modal === modal &&
              generation === this._modalRenderGeneration
            )
          }
        );
        if (candidate === null) return;

        if (modal._statsContent) {
          renderSummaryStats(
            modal._statsContent,
            pageData,
            config.dataSource.variable
          );
        }

        if (modal._annotationsContent) {
          renderStatisticalAnnotations(
            modal._annotationsContent,
            pageData,
            config.dataSource.type
          );
        }
      } catch (err) {
        if (
          this._modal === modal &&
          generation === this._modalRenderGeneration
        ) {
          console.error('[DetailedAnalysisUI] Modal render failed:', err);
          await modal._analysisPlotSlot?.invalidate();
          modal._plotContainer.innerHTML = '';
          const errorEl = document.createElement('div');
          errorEl.className = 'analysis-error';
          errorEl.textContent = `Failed to render: ${err?.message || err}`;
          modal._plotContainer.appendChild(errorEl);
        }
      }
    }
  }

  // ===========================================================================
  // Export Functions - Override to use detailed-specific containers
  // ===========================================================================

  _getActivePlotSlot() {
    return this._modal?._analysisPlotSlot ?? this._previewPlotSlot;
  }

  /**
   * Export PNG - delegates to base class with detailed-specific container
   * @override
   */
  async _exportPNG() {
    const slot = this._getActivePlotSlot();
    if (slot == null) return;
    await slot.withCommittedPlot(candidate => (
      super._exportPNG(candidate, { filename: 'detailed-analysis' })
    ));
  }

  /**
   * Export SVG - delegates to base class with detailed-specific container
   * @override
   */
  async _exportSVG() {
    const slot = this._getActivePlotSlot();
    if (slot == null) return;
    await slot.withCommittedPlot(candidate => (
      super._exportSVG(candidate, { filename: 'detailed-analysis' })
    ));
  }

  /**
   * Export CSV - delegates to base class with detailed-specific data
   * @override
   */
  async _exportCSV() {
    const slot = this._getActivePlotSlot();
    if (slot == null) return;
    await slot.withCommittedPlot((_candidate, renderResult) => {
      const payload = renderResult?.payload;
      if (
        !Array.isArray(payload?.pageData) ||
        typeof payload.variableName !== 'string' ||
        payload.variableName.length === 0
      ) {
        throw new Error(
          'Detailed CSV export requires exact committed plot data'
        );
      }
      return super._exportCSV(
        payload.pageData,
        payload.variableName,
        'detailed-analysis-data.csv'
      );
    });
  }

  // ===========================================================================
  // Options Persistence (Session Only)
  // ===========================================================================

  _getSavedOptionsForPlotType(plotTypeId) {
    const saved = this._savedPlotOptions.get(plotTypeId) || {};
    return PlotRegistry.mergeOptions(plotTypeId, saved);
  }

  _saveOptionsForPlotType(plotTypeId, options) {
    this._savedPlotOptions.set(plotTypeId, { ...options });
    this._trimSavedOptions();
  }

  _trimSavedOptions() {
    const MAX_SAVED = 10;
    if (this._savedPlotOptions.size > MAX_SAVED) {
      const entries = Array.from(this._savedPlotOptions.entries());
      this._savedPlotOptions = new Map(entries.slice(-MAX_SAVED));
    }
  }

  // ===========================================================================
  // Cleanup & Lifecycle
  // ===========================================================================

  // _cleanupPreviousAnalysis(), onPagesChanged(), onHighlightChanged(),
  // getConfig(), setConfig() - inherited from BaseAnalysisUI

  /**
   * Override to use PageSelectorComponent's updateCounts method
   * @override
   */
  _updatePageSelectorCounts() {
    this._pageSelector?.updateCounts();
  }

  /**
   * Destroy and cleanup
   * @override
   */
  destroy() {
    if (this._destroyPromise != null) return this._destroyPromise;

    let rejectDestroy;
    let resolveDestroy;
    const destroyTask = new Promise((resolve, reject) => {
      resolveDestroy = resolve;
      rejectDestroy = reject;
    });
    this._destroyPromise = destroyTask;

    const errors = [];
    const selectorTasks = [];
    this._isDestroyed = true;
    this._modalRenderGeneration += 1;
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
    for (const [label, owner] of [
      ['variable selector', this._variableSelector],
      ['page selector', this._pageSelector]
    ]) {
      if (owner === null || owner === undefined) continue;
      if (typeof owner.destroy !== 'function') {
        errors.push(
          new TypeError(`Detailed Analysis ${label} must implement destroy()`)
        );
        continue;
      }
      try {
        const result = owner.destroy();
        if (result !== null && result !== undefined &&
            typeof result.then === 'function') {
          selectorTasks.push(result);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    this._variableSelector = null;
    this._pageSelector = null;
    this._pageSelectContainer = null;

    // Clean up detailed-specific state
    this._savedPlotOptions.clear();
    const previewSlot = this._previewPlotSlot;
    const modal = this._modal;
    void Promise.resolve().then(async () => {
      const cleanupTasks = [
        ...selectorTasks,
        ...(this._pendingModalCloseTasks ?? [])
      ];
      if (previewSlot !== null && previewSlot !== undefined) {
        if (typeof previewSlot.destroy !== 'function') {
          errors.push(
            new TypeError(
              'Detailed Analysis preview plot owner must implement destroy()'
            )
          );
        } else {
          try {
            cleanupTasks.push(previewSlot.destroy());
          } catch (error) {
            errors.push(error);
          }
        }
      }
      if (modal !== null && modal !== undefined) {
        try {
          cleanupTasks.push(closeModal(modal));
        } catch (error) {
          errors.push(error);
        }
      }
      const outcomes = await Promise.allSettled(cleanupTasks);
      errors.push(
        ...outcomes
          .filter(outcome => outcome.status === 'rejected')
          .map(outcome => outcome.reason)
      );
      this._previewPlotSlot = null;
      this._modalPlotSlot = null;
      this._modal = null;
      this._layoutEngine = null;
      try {
        await super.destroy();
      } catch (error) {
        errors.push(error);
      }
      const failure = combineErrors(
        errors,
        'Detailed Analysis destruction failed'
      );
      if (failure) throw failure;
    }).then(resolveDestroy, rejectDestroy);
    void destroyTask.catch(() => {});
    return destroyTask;
  }
}

/**
 * Create detailed analysis UI instance
 */
export function createDetailedAnalysisUI(options) {
  const ui = new DetailedAnalysisUI(options);
  ui.init(options.container);
  return ui;
}

export default DetailedAnalysisUI;
