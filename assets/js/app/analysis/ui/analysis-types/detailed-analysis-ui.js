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
  createPageSelector,
  createPlotTypeSelector,
  createAnalysisModal,
  openModal,
  renderPlotOptions,
  renderSummaryStats,
  renderStatisticalAnnotations,
  createExpandButton
} from '../components/index.js';
import { createVariableSelectorComponent } from '../shared/variable-selector.js';
import { loadPlotly, purgePlot } from '../../plots/plotly-loader.js';
import { createLayoutEngine } from '../../plots/layout-engine.js';

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
    this._pageSelectContainer = null;
    this._plotTypeContainer = null;

    // Custom page colors
    this._customPageColors = new Map();

    // Session-only saved options per plot type
    this._savedPlotOptions = new Map();

    // Layout engine for plots
    this._layoutEngine = null;

    // Bind methods
    this._handleVariableChange = this._handleVariableChange.bind(this);
    this._handlePageChange = this._handlePageChange.bind(this);
    this._handlePageColorChange = this._handlePageColorChange.bind(this);
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

    // Auto-select all pages by default if none selected
    if (this._selectedPages.length === 0 && pages.length > 0) {
      this._selectedPages = pages.map(p => p.id);
      this._currentConfig.pages = this._selectedPages;
    }

    // If no pages, show message
    if (pages.length === 0) {
      this._controlsContainer.innerHTML = `
        <div class="legend-help">Create highlight pages first using the Highlighted Cells section above.</div>
      `;
      this._hidePreview();
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
   * Render page selector
   */
  _renderPageSelector(pages) {
    const pageSelect = createPageSelector({
      pages: pages,
      selectedIds: this._selectedPages,
      onChange: this._handlePageChange,
      onColorChange: this._handlePageColorChange,
      customColors: this._customPageColors,
      includeDerivedPages: true,
      getCellCountForPageId: (pageId) => this.dataLayer.getCellCountForPageId(pageId)
    });
    this._controlsContainer.appendChild(pageSelect);
    this._pageSelectContainer = pageSelect;
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
    return {
      ...base,
      customPageColors: Array.from(this._customPageColors.entries()),
      savedPlotOptions: Array.from(this._savedPlotOptions.entries())
    };
  }

  importSettings(settings) {
    if (!settings) return;

    if (Array.isArray(settings.customPageColors)) {
      this._customPageColors = new Map(settings.customPageColors);
    }
    if (Array.isArray(settings.savedPlotOptions)) {
      this._savedPlotOptions = new Map(settings.savedPlotOptions);
    }

    super.importSettings(settings);
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

  _handlePageChange(pageIds) {
    this._selectedPages = pageIds || [];
    this._currentConfig.pages = this._selectedPages;
    this._scheduleUpdate();

    if (this.onConfigChange) {
      this.onConfigChange(this._currentConfig);
    }
  }

  _handlePageColorChange(pageId, color) {
    this._customPageColors.set(pageId, color);
    this._scheduleUpdate();
  }

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

  // _canRunAnalysis(), _scheduleUpdate(), _runAnalysisIfValid() - inherited from BaseAnalysisUI

  // ===========================================================================
  // Analysis Execution
  // ===========================================================================

  /**
   * Run the analysis (implements abstract method from BaseAnalysisUI)
   * @override
   */
  async _runAnalysis() {
    if (this._isDestroyed) return;
    this._cleanupPreviousAnalysis();

    if (this._isDestroyed) return;
    this._previewContainer.classList.remove('empty');
    this._previewContainer.classList.add('loading');

    try {
      await loadPlotly();
      if (this._isDestroyed) return;

      // Fetch data
      const pageData = await this.dataLayer.getDataForPages({
        type: this._currentConfig.dataSource.type,
        variableKey: this._currentConfig.dataSource.variable,
        pageIds: this._selectedPages
      });

      if (this._isDestroyed) return;
      if (pageData.length === 0) {
        throw new Error('No data available for selected pages');
      }

      this._currentPageData = pageData;

      // Create layout engine
      this._layoutEngine = createLayoutEngine({
        pageCount: pageData.length,
        pageIds: pageData.map(pd => pd.pageId),
        pageNames: pageData.map(pd => pd.pageName),
        syncXAxis: true,
        syncYAxis: true,
        customColors: this._customPageColors
      });

      // Get plot type
      const plotType = PlotRegistry.get(this._currentConfig.plotType);
      if (!plotType) {
        throw new Error(`Unknown plot type: ${this._currentConfig.plotType}`);
      }

      const mergedOptions = PlotRegistry.mergeOptions(
        this._currentConfig.plotType,
        this._currentConfig.plotOptions
      );

      if (this._isDestroyed) return;
      // Render preview
      this._previewContainer.classList.remove('loading');
      // Purge any existing plot to prevent WebGL memory leaks
      const existingPlot = this._previewContainer.querySelector('.analysis-preview-plot');
      if (existingPlot) purgePlot(existingPlot);
      this._previewContainer.innerHTML = '';

      const previewPlotDiv = document.createElement('div');
      previewPlotDiv.className = 'analysis-preview-plot';
      this._previewContainer.appendChild(previewPlotDiv);

      await plotType.render(pageData, mergedOptions, previewPlotDiv, this._layoutEngine);
      if (this._isDestroyed) return;

      // Show actions
      this._renderActions();

      // Update modal if open
      if (this._modal?._plotContainer) {
        await this._updateModal(plotType, mergedOptions, pageData);
      }

    } catch (err) {
      this._previewContainer.classList.remove('loading');
      this._previewContainer.classList.add('empty');
      throw err;
    }
  }

  async _updateModal(plotType, options, pageData) {
    if (this._isDestroyed) return;
    const modal = this._modal;
    const plotContainer = modal?._plotContainer;
    if (!plotContainer) return;

    purgePlot(plotContainer);
    await plotType.render(pageData, options, plotContainer, this._layoutEngine);
    if (this._isDestroyed) return;

    const modalAfter = this._modal;
    if (!modalAfter) return;

    if (modalAfter._footer) {
      renderSummaryStats(modalAfter._footer, pageData, this._currentConfig.dataSource.variable);
    }

    if (modalAfter._annotationsContent) {
      renderStatisticalAnnotations(
        modalAfter._annotationsContent,
        pageData,
        this._currentConfig.dataSource.type
      );
    }
  }

  // ===========================================================================
  // Preview & Actions
  // ===========================================================================

  // _hidePreview() and _showError() - inherited from BaseAnalysisUI

  /**
   * Render action buttons (expand, etc.)
   */
  _renderActions() {
    this._actionsContainer.innerHTML = '';
    this._actionsContainer.style.display = 'flex';

    const expandBtn = createExpandButton(this._openExpandedView);
    this._actionsContainer.appendChild(expandBtn);
  }

  // ===========================================================================
  // Modal / Expanded View
  // ===========================================================================

  async _openExpandedView() {
    if (!this._canRunAnalysis()) return;

    this._modal = createAnalysisModal({
      onClose: () => { this._modal = null; },
      onExportPNG: () => this._exportPNG(),
      onExportSVG: () => this._exportSVG(),
      onExportCSV: () => this._exportCSV()
    });

    if (this._modal._title) {
      this._modal._title.textContent = `Comparing: ${this._currentConfig.dataSource.variable}`;
    }

    if (this._modal._optionsContent) {
      renderPlotOptions(
        this._modal._optionsContent,
        this._currentConfig.plotType,
        this._currentConfig.plotOptions,
        this._handlePlotOptionChange
      );
    }

    openModal(this._modal);

    if (this._currentPageData && this._modal._plotContainer) {
      try {
        await loadPlotly();

        const plotType = PlotRegistry.get(this._currentConfig.plotType);
        const mergedOptions = PlotRegistry.mergeOptions(
          this._currentConfig.plotType,
          this._currentConfig.plotOptions
        );

        await plotType.render(
          this._currentPageData,
          mergedOptions,
          this._modal._plotContainer,
          this._layoutEngine
        );

        if (this._modal._footer) {
          renderSummaryStats(
            this._modal._footer,
            this._currentPageData,
            this._currentConfig.dataSource.variable
          );
        }

        if (this._modal._annotationsContent) {
          renderStatisticalAnnotations(
            this._modal._annotationsContent,
            this._currentPageData,
            this._currentConfig.dataSource.type
          );
        }
      } catch (err) {
        console.error('[DetailedAnalysisUI] Modal render failed:', err);
        if (this._modal._plotContainer) {
          this._modal._plotContainer.innerHTML = `<div class="analysis-error">Failed to render: ${err.message}</div>`;
        }
      }
    }
  }

  // ===========================================================================
  // Export Functions - Override to use detailed-specific containers
  // ===========================================================================

  /**
   * Get the active plot container (modal or preview)
   * @returns {HTMLElement|null}
   */
  _getActivePlotContainer() {
    return this._modal?._plotContainer || this._previewContainer?.querySelector('.analysis-preview-plot');
  }

  /**
   * Export PNG - delegates to base class with detailed-specific container
   * @override
   */
  async _exportPNG() {
    const container = this._getActivePlotContainer();
    // Call base class method with specific container and options
    await super._exportPNG(container, { filename: 'detailed-analysis' });
  }

  /**
   * Export SVG - delegates to base class with detailed-specific container
   * @override
   */
  async _exportSVG() {
    const container = this._getActivePlotContainer();
    // Call base class method with specific container and options
    await super._exportSVG(container, { filename: 'detailed-analysis' });
  }

  /**
   * Export CSV - delegates to base class with detailed-specific data
   * @override
   */
  async _exportCSV() {
    if (!this._currentConfig.dataSource.variable || !this._currentPageData) return;
    // Call base class method with specific data
    await super._exportCSV(this._currentPageData, this._currentConfig.dataSource.variable, 'detailed-analysis-data.csv');
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
  // _updatePageSelectorCounts(), getConfig(), setConfig() - inherited from BaseAnalysisUI

  /**
   * Destroy and cleanup
   * @override
   */
  destroy() {
    this._isDestroyed = true;
    // Clean up variable selector
    this._variableSelector?.destroy?.();
    this._variableSelector = null;

    // Clean up detailed-specific state
    this._savedPlotOptions.clear();
    this._customPageColors.clear();
    this._layoutEngine = null;

    // Call parent destroy
    super.destroy();
  }
}

/**
 * Create detailed analysis UI instance
 */
export function createDetailedAnalysisUI(options) {
  return new DetailedAnalysisUI(options);
}

export default DetailedAnalysisUI;
