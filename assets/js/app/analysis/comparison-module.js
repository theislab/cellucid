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

import { DataLayer, createDataLayer } from './data-layer.js';
import { TransformPipeline, createTransformPipeline } from './transform-pipeline.js';
import { PlotRegistry } from './plot-registry.js';
import { LayoutEngine, createLayoutEngine } from './layout-engine.js';
import {
  createVariableSelector,
  createGeneExpressionSelector,
  createPageSelector,
  createPlotTypeSelector,
  createAnalysisModal,
  openModal,
  closeModal,
  renderPlotOptions,
  renderSummaryStats,
  renderStatisticalAnnotations,
  createExpandButton
} from './ui-components.js';
import { loadPlotly, purgePlot, downloadImage } from './plotly-loader.js';
import { getNotificationCenter } from '../notification-center.js';

// Import plot types to register them
import './plot-types/barplot.js';
import './plot-types/boxplot.js';
import './plot-types/violinplot.js';
import './plot-types/histogram.js';
import './plot-types/pieplot.js';
import './plot-types/densityplot.js';
import './plot-types/heatmap.js';

const NONE_VALUE = '-1';
const DEBOUNCE_DELAY = 300; // ms

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

    // Initialize components
    this.dataLayer = createDataLayer(this.state);
    this.layoutEngine = null;
    this.transformPipeline = createTransformPipeline();

    // Current state
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

    // Custom page colors (pageId -> color hex)
    this.customPageColors = new Map();

    // Session-only plot options per plot type (plotTypeId -> options)
    // Only stores options that differ from defaults; cleared on page refresh
    this._savedPlotOptions = new Map();

    // DOM references
    this.controlsContainer = null;
    this.previewContainer = null;
    this.actionsContainer = null;

    // UI component references
    this.categoricalSelect = null;
    this.continuousSelect = null;
    this.geneExpressionContainer = null;
    this.pageSelectContainer = null;
    this.plotTypeContainer = null;

    // Modal reference
    this.modal = null;
    this.modalPlotContainer = null;

    // Current plot reference and data
    this.currentPlot = null;
    this.currentPageData = null;

    // Debounce timer
    this._updateTimer = null;

    // Event hooks
    this._hooks = {
      beforeRender: [],
      afterRender: []
    };

    // Bind methods
    this._handleCategoricalChange = this._handleCategoricalChange.bind(this);
    this._handleContinuousChange = this._handleContinuousChange.bind(this);
    this._handleGeneChange = this._handleGeneChange.bind(this);
    this._handlePageChange = this._handlePageChange.bind(this);
    this._handlePageColorChange = this._handlePageColorChange.bind(this);
    this._handlePlotTypeChange = this._handlePlotTypeChange.bind(this);
    this._handlePlotOptionChange = this._handlePlotOptionChange.bind(this);
    this._scheduleUpdate = this._scheduleUpdate.bind(this);
    this._openExpandedView = this._openExpandedView.bind(this);
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

    // Create controls container
    this.controlsContainer = document.createElement('div');
    this.controlsContainer.id = 'page-analysis-controls';
    accordionContent.appendChild(this.controlsContainer);

    // Create preview container (small inline plot)
    this.previewContainer = document.createElement('div');
    this.previewContainer.id = 'page-analysis-preview';
    this.previewContainer.className = 'analysis-preview-container empty';
    accordionContent.appendChild(this.previewContainer);

    // Create actions container (expand button, export)
    this.actionsContainer = document.createElement('div');
    this.actionsContainer.id = 'page-analysis-actions';
    this.actionsContainer.className = 'analysis-actions';
    this.actionsContainer.style.display = 'none';
    accordionContent.appendChild(this.actionsContainer);

    // Render initial UI
    this._renderControls();

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
   * Render the control panel - minimal design matching Filtering section
   */
  _renderControls() {
    this.controlsContainer.innerHTML = '';

    const pages = this.dataLayer.getPages();

    // Auto-select all pages by default if none are selected
    if (this.currentConfig.pages.length === 0 && pages.length > 0) {
      this.currentConfig.pages = pages.map(p => p.id);
    }

    // If no pages, show message
    if (pages.length === 0) {
      const message = document.createElement('div');
      message.className = 'legend-help';
      message.textContent = 'Create highlight pages first using the Highlighted Cells section above.';
      this.controlsContainer.appendChild(message);
      this._hidePreview();
      return;
    }

    // Variable selectors block - exactly like Filtering section
    const variableBlock = document.createElement('div');
    variableBlock.className = 'control-block';

    // Categorical obs dropdown
    const categoricalVars = this.dataLayer.getAvailableVariables('categorical_obs');
    const categoricalSelector = createVariableSelector({
      variables: categoricalVars,
      selectedValue: this.currentConfig.dataSource.type === 'categorical_obs'
        ? this.currentConfig.dataSource.variable : '',
      label: 'Categorical obs:',
      id: 'analysis-categorical-field',
      onChange: this._handleCategoricalChange
    });
    variableBlock.appendChild(categoricalSelector);
    this.categoricalSelect = categoricalSelector.querySelector('select');

    // Continuous obs dropdown
    const continuousVars = this.dataLayer.getAvailableVariables('continuous_obs');
    const continuousSelector = createVariableSelector({
      variables: continuousVars,
      selectedValue: this.currentConfig.dataSource.type === 'continuous_obs'
        ? this.currentConfig.dataSource.variable : '',
      label: 'Continuous obs:',
      id: 'analysis-continuous-field',
      onChange: this._handleContinuousChange
    });
    variableBlock.appendChild(continuousSelector);
    this.continuousSelect = continuousSelector.querySelector('select');

    // Gene expression dropdown (searchable) - only if genes available
    const geneVars = this.dataLayer.getAvailableVariables('gene_expression');
    if (geneVars.length > 0) {
      const geneSelector = createGeneExpressionSelector({
        genes: geneVars,
        selectedValue: this.currentConfig.dataSource.type === 'gene_expression'
          ? this.currentConfig.dataSource.variable : '',
        label: 'Gene expression:',
        id: 'analysis-gene',
        onChange: this._handleGeneChange
      });
      variableBlock.appendChild(geneSelector);
      this.geneExpressionContainer = geneSelector;
    }

    this.controlsContainer.appendChild(variableBlock);

    // Page selector - now matching highlight module style with color picker
    const pageSelect = createPageSelector({
      pages: pages,
      selectedIds: this.currentConfig.pages,
      onChange: this._handlePageChange,
      onColorChange: this._handlePageColorChange,
      customColors: this.customPageColors
    });
    this.controlsContainer.appendChild(pageSelect);
    this.pageSelectContainer = pageSelect;

    // Plot type selector - only show if variable is selected
    if (this.currentConfig.dataSource.variable) {
      const dataKind = this.currentConfig.dataSource.type === 'categorical_obs'
        ? 'categorical' : 'continuous';

      // Auto-select first compatible plot type if none selected
      if (!this.currentConfig.plotType) {
        const compatiblePlots = PlotRegistry.getForDataType(dataKind);
        if (compatiblePlots.length > 0) {
          this.currentConfig.plotType = compatiblePlots[0].id;
        }
      }

      const plotTypeSelector = createPlotTypeSelector({
        dataType: dataKind,
        selectedId: this.currentConfig.plotType,
        onChange: this._handlePlotTypeChange
      });
      this.controlsContainer.appendChild(plotTypeSelector);
      this.plotTypeContainer = plotTypeSelector;
    }
  }

  /**
   * Render actions (expand button, exports)
   */
  _renderActions() {
    this.actionsContainer.innerHTML = '';
    this.actionsContainer.style.display = 'flex';

    // Expand button to open modal
    const expandBtn = createExpandButton(this._openExpandedView);
    this.actionsContainer.appendChild(expandBtn);
  }

  /**
   * Hide preview and actions
   */
  _hidePreview() {
    this.previewContainer.innerHTML = '';
    this.previewContainer.classList.add('empty');
    this.previewContainer.classList.remove('loading');
    this.actionsContainer.style.display = 'none';
  }

  /**
   * Check if analysis can be run
   */
  _canRunAnalysis() {
    return (
      this.currentConfig.dataSource.variable &&
      this.currentConfig.pages.length > 0 &&
      this.currentConfig.plotType
    );
  }

  /**
   * Handle categorical field change - clears others
   */
  _handleCategoricalChange(variable) {
    if (variable) {
      this.currentConfig.dataSource.type = 'categorical_obs';
      this.currentConfig.dataSource.variable = variable;

      // Clear others
      if (this.continuousSelect) this.continuousSelect.value = NONE_VALUE;
      if (this.geneExpressionContainer?._clearSelection) {
        this.geneExpressionContainer._clearSelection();
      }

      // Update plot type for categorical data
      this._updatePlotTypeForDataKind('categorical');
    } else {
      this._clearDataSource();
    }
    this._renderControls();
    this._scheduleUpdate();
  }

  /**
   * Handle continuous field change - clears others
   */
  _handleContinuousChange(variable) {
    if (variable) {
      this.currentConfig.dataSource.type = 'continuous_obs';
      this.currentConfig.dataSource.variable = variable;

      // Clear others
      if (this.categoricalSelect) this.categoricalSelect.value = NONE_VALUE;
      if (this.geneExpressionContainer?._clearSelection) {
        this.geneExpressionContainer._clearSelection();
      }

      // Update plot type for continuous data
      this._updatePlotTypeForDataKind('continuous');
    } else {
      this._clearDataSource();
    }
    this._renderControls();
    this._scheduleUpdate();
  }

  /**
   * Handle gene expression change - clears others
   */
  _handleGeneChange(variable) {
    if (variable) {
      this.currentConfig.dataSource.type = 'gene_expression';
      this.currentConfig.dataSource.variable = variable;

      // Clear others
      if (this.categoricalSelect) this.categoricalSelect.value = NONE_VALUE;
      if (this.continuousSelect) this.continuousSelect.value = NONE_VALUE;

      // Update plot type for continuous data (gene expression is continuous)
      this._updatePlotTypeForDataKind('continuous');
    } else {
      this._clearDataSource();
    }
    this._renderControls();
    this._scheduleUpdate();
  }

  /**
   * Clear data source selection
   */
  _clearDataSource() {
    this.currentConfig.dataSource.type = '';
    this.currentConfig.dataSource.variable = '';
    this.currentConfig.plotType = '';
    this.currentConfig.plotOptions = {};
  }

  /**
   * Update plot type when data kind changes
   */
  _updatePlotTypeForDataKind(kind) {
    const compatiblePlots = PlotRegistry.getForDataType(kind);
    const currentPlotCompatible = compatiblePlots.find(p => p.id === this.currentConfig.plotType);

    if (!currentPlotCompatible && compatiblePlots.length > 0) {
      this.currentConfig.plotType = compatiblePlots[0].id;
      this.currentConfig.plotOptions = {};
    }
  }

  /**
   * Handle page selection change
   */
  _handlePageChange(pageIds) {
    this.currentConfig.pages = pageIds;
    this._scheduleUpdate();
  }

  /**
   * Handle page color change
   */
  _handlePageColorChange(pageId, color) {
    this.customPageColors.set(pageId, color);
    // Trigger re-render if we have a valid analysis
    this._scheduleUpdate();
  }

  /**
   * Handle plot type change
   */
  _handlePlotTypeChange(plotTypeId) {
    this.currentConfig.plotType = plotTypeId;
    // Load saved options for this plot type
    this.currentConfig.plotOptions = this.getSavedOptionsForPlotType(plotTypeId);
    this._scheduleUpdate();

    // Update options panel if modal is open
    if (this.modal && this.modal._optionsContent) {
      renderPlotOptions(
        this.modal._optionsContent,
        plotTypeId,
        this.currentConfig.plotOptions,
        this._handlePlotOptionChange
      );
    }
  }

  /**
   * Handle plot option change from modal
   */
  _handlePlotOptionChange(key, value) {
    this.currentConfig.plotOptions[key] = value;
    // Save options for persistence
    this.saveOptionsForPlotType(this.currentConfig.plotType, this.currentConfig.plotOptions);
    this._scheduleUpdate();
  }

  /**
   * Schedule an update (debounced)
   */
  _scheduleUpdate() {
    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
    }
    this._updateTimer = setTimeout(() => {
      this._runAnalysisIfValid();
    }, DEBOUNCE_DELAY);
  }

  /**
   * Run analysis if configuration is valid
   */
  async _runAnalysisIfValid() {
    if (!this._canRunAnalysis()) {
      // Clear preview if configuration became invalid
      this._hidePreview();
      return;
    }

    try {
      await this.runAnalysis(this.currentConfig);
    } catch (err) {
      console.error('[ComparisonModule] Analysis failed:', err);
      this._showError('Analysis failed: ' + err.message);
    }
  }

  /**
   * Run analysis with given configuration
   */
  async runAnalysis(config) {
    // Show loading state
    this.previewContainer.classList.remove('empty');
    this.previewContainer.classList.add('loading');

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

      // Store current page data for modal
      this.currentPageData = transformedData;

      // Create layout engine with custom colors and sync options
      this.layoutEngine = createLayoutEngine({
        pageCount: transformedData.length,
        pageIds: transformedData.map(pd => pd.pageId),
        pageNames: transformedData.map(pd => pd.pageName),
        syncXAxis: config.syncAxes !== false,
        syncYAxis: config.syncAxes !== false,
        customColors: this.customPageColors
      });

      // Get plot type
      const plotType = PlotRegistry.get(config.plotType);
      if (!plotType) {
        throw new Error(`Unknown plot type: ${config.plotType}`);
      }

      // Merge options with defaults
      const mergedOptions = PlotRegistry.mergeOptions(config.plotType, config.plotOptions);

      // Render to preview container
      this.previewContainer.classList.remove('loading');
      this.previewContainer.innerHTML = '';

      // Create a plot div for preview
      const previewPlotDiv = document.createElement('div');
      previewPlotDiv.className = 'analysis-preview-plot';
      this.previewContainer.appendChild(previewPlotDiv);

      this.currentPlot = await plotType.render(
        transformedData,
        mergedOptions,
        previewPlotDiv,
        this.layoutEngine
      );

      // Show actions
      this._renderActions();

      // If modal is open, update it too
      if (this.modal && this.modal._plotContainer) {
        purgePlot(this.modal._plotContainer);
        await plotType.render(
          transformedData,
          mergedOptions,
          this.modal._plotContainer,
          this.layoutEngine
        );

        // Update summary stats
        if (this.modal._footer) {
          renderSummaryStats(
            this.modal._footer,
            transformedData,
            config.dataSource.variable
          );
        }

        // Update statistical annotations
        if (this.modal._annotationsContent) {
          renderStatisticalAnnotations(
            this.modal._annotationsContent,
            transformedData,
            config.dataSource.type
          );
        }
      }

      // Fire afterRender hooks
      for (const hook of this._hooks.afterRender) {
        await hook(config, this.currentPlot);
      }

    } catch (err) {
      this.previewContainer.classList.remove('loading');
      this.previewContainer.classList.add('empty');
      throw err;
    }
  }

  /**
   * Show error message
   */
  _showError(message) {
    this.previewContainer.classList.remove('loading');
    this.previewContainer.classList.add('empty');
    this.previewContainer.innerHTML = `<div class="analysis-error">${message}</div>`;
    this.actionsContainer.style.display = 'none';

    // Also show in notification center
    getNotificationCenter().error(message, { category: 'data', title: 'Analysis Error' });
  }

  /**
   * Open expanded view in modal
   */
  async _openExpandedView() {
    if (!this._canRunAnalysis()) return;

    // Create modal
    this.modal = createAnalysisModal({
      onClose: () => {
        this.modal = null;
      },
      onExportPNG: () => this.exportPNG(),
      onExportSVG: () => this.exportSVG(),
      onExportCSV: () => this.exportCSV()
    });

    // Set title
    if (this.modal._title) {
      this.modal._title.textContent = `Comparing: ${this.currentConfig.dataSource.variable}`;
    }

    // Render plot options
    if (this.modal._optionsContent) {
      renderPlotOptions(
        this.modal._optionsContent,
        this.currentConfig.plotType,
        this.currentConfig.plotOptions,
        this._handlePlotOptionChange
      );
    }

    // Open modal
    openModal(this.modal);

    // Render plot in modal
    if (this.currentPageData && this.modal._plotContainer) {
      try {
        await loadPlotly();

        const plotType = PlotRegistry.get(this.currentConfig.plotType);
        const mergedOptions = PlotRegistry.mergeOptions(
          this.currentConfig.plotType,
          this.currentConfig.plotOptions
        );

        await plotType.render(
          this.currentPageData,
          mergedOptions,
          this.modal._plotContainer,
          this.layoutEngine
        );

        // Render summary stats
        if (this.modal._footer) {
          renderSummaryStats(
            this.modal._footer,
            this.currentPageData,
            this.currentConfig.dataSource.variable
          );
        }

        // Render statistical annotations
        if (this.modal._annotationsContent) {
          renderStatisticalAnnotations(
            this.modal._annotationsContent,
            this.currentPageData,
            this.currentConfig.dataSource.type
          );
        }
      } catch (err) {
        console.error('[ComparisonModule] Modal render failed:', err);
        if (this.modal._plotContainer) {
          this.modal._plotContainer.innerHTML = `<div class="analysis-error">Failed to render: ${err.message}</div>`;
        }
        getNotificationCenter().error('Plot render failed: ' + err.message, { category: 'data', title: 'Render Error' });
      }
    }
  }

  /**
   * Handle pages changed event (pages added/removed/renamed/switched)
   */
  onPagesChanged() {
    // Update page list in selector
    const pages = this.dataLayer.getPages();
    const allPageIds = new Set(pages.map(p => p.id));

    // Filter out any selected pages that no longer exist
    this.currentConfig.pages = this.currentConfig.pages.filter(id => allPageIds.has(id));

    // Auto-select any new pages that were added
    const selectedSet = new Set(this.currentConfig.pages);
    pages.forEach(p => {
      if (!selectedSet.has(p.id)) {
        this.currentConfig.pages.push(p.id);
      }
    });

    // Re-render controls to update page list
    this._renderControls();
    this._scheduleUpdate();
  }

  /**
   * Handle highlight changed event (cells added/removed from pages)
   */
  onHighlightChanged() {
    // Update page selector to show new cell counts
    this._updatePageSelectorCounts();

    // If we have selected pages, re-run the analysis with new data
    if (this.currentConfig.pages.length > 0 && this.currentConfig.dataSource.variable) {
      this._scheduleUpdate();
    }
  }

  /**
   * Update page selector tabs with current cell counts
   */
  _updatePageSelectorCounts() {
    if (!this.controlsContainer) return;

    const pageTabs = this.controlsContainer.querySelectorAll('.analysis-page-tab');

    pageTabs.forEach(tab => {
      const pageId = tab.dataset.pageId;
      if (pageId) {
        const countSpan = tab.querySelector('.analysis-page-count');
        if (countSpan) {
          const cellCount = this.dataLayer.getCellIndicesForPage(pageId).length;
          countSpan.textContent = cellCount > 0 ? cellCount.toLocaleString() : '(0)';
        }
      }
    });
  }

  /**
   * Export plot as PNG
   */
  async exportPNG() {
    const container = this.modal?._plotContainer || this.previewContainer?.querySelector('.analysis-preview-plot');
    if (!container) return;

    try {
      await downloadImage(container, {
        format: 'png',
        width: 1200,
        height: 800,
        filename: 'page-analysis'
      });
      getNotificationCenter().success('Plot exported as PNG', { category: 'download' });
    } catch (err) {
      console.error('[ComparisonModule] PNG export failed:', err);
      getNotificationCenter().error('PNG export failed: ' + err.message, { category: 'download' });
    }
  }

  /**
   * Export plot as SVG
   */
  async exportSVG() {
    const container = this.modal?._plotContainer || this.previewContainer?.querySelector('.analysis-preview-plot');
    if (!container) return;

    try {
      await downloadImage(container, {
        format: 'svg',
        width: 1200,
        height: 800,
        filename: 'page-analysis'
      });
      getNotificationCenter().success('Plot exported as SVG', { category: 'download' });
    } catch (err) {
      console.error('[ComparisonModule] SVG export failed:', err);
      getNotificationCenter().error('SVG export failed: ' + err.message, { category: 'download' });
    }
  }

  /**
   * Export data as CSV
   */
  async exportCSV() {
    if (!this.currentConfig.dataSource.variable || !this.currentPageData) return;

    try {
      // Build CSV
      const rows = ['page,cell_index,value'];
      for (const pd of this.currentPageData) {
        for (let i = 0; i < pd.values.length; i++) {
          rows.push(`"${pd.pageName}",${pd.cellIndices[i]},${pd.values[i]}`);
        }
      }

      const csv = rows.join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = 'page-analysis-data.csv';
      a.click();

      URL.revokeObjectURL(url);
      getNotificationCenter().success('Data exported as CSV', { category: 'download' });
    } catch (err) {
      console.error('[ComparisonModule] CSV export failed:', err);
      getNotificationCenter().error('CSV export failed: ' + err.message, { category: 'download' });
    }
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
    this._renderControls();
    this._scheduleUpdate();
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

  /**
   * Get saved options for a plot type, merged with defaults
   * @param {string} plotTypeId
   * @returns {Object}
   */
  getSavedOptionsForPlotType(plotTypeId) {
    const saved = this._savedPlotOptions.get(plotTypeId) || {};
    return PlotRegistry.mergeOptions(plotTypeId, saved);
  }

  /**
   * Save options for current plot type (session-only, not persisted)
   * @param {string} plotTypeId
   * @param {Object} options
   */
  saveOptionsForPlotType(plotTypeId, options) {
    this._savedPlotOptions.set(plotTypeId, { ...options });
  }

  /**
   * Cleanup
   */
  destroy() {
    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
    }
    if (this.previewContainer) {
      const plotEl = this.previewContainer.querySelector('.analysis-preview-plot');
      if (plotEl) purgePlot(plotEl);
    }
    if (this.modal) {
      closeModal(this.modal);
      this.modal = null;
    }
    this._hooks = { beforeRender: [], afterRender: [] };
    this.currentPlot = null;
    this.currentPageData = null;
    this.layoutEngine = null;
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

export { PlotRegistry, DataLayer, TransformPipeline, LayoutEngine };
