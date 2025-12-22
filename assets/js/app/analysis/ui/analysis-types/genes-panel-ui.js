/**
 * Genes Panel UI
 *
 * Main UI component for the Marker Genes Panel feature.
 * Extends FormBasedAnalysisUI for consistent UX with other analysis types.
 *
 * Features:
 * - Category selection for grouping
 * - Analysis mode selection (ranked, clustered, custom)
 * - Statistical method and threshold configuration
 * - Visualization options (transform, colorscale)
 * - Clustering options (distance, linkage)
 * - Interactive heatmap with hover details
 * - Export functionality
 *
 * @module ui/analysis-types/genes-panel-ui
 */

import { FormBasedAnalysisUI } from './base/form-based-analysis.js';
import {
  createFormSelect,
  createFormRow,
  createFormCheckbox,
  createPerformanceSettings,
  getPerformanceFormValues
} from '../../shared/dom-utils.js';
import { GenesPanelController } from '../../genes-panel/genes-panel-controller.js';
import { HoverContext } from '../components/hover-context.js';
import { ProgressTracker } from '../../shared/progress-tracker.js';
import { PlotRegistry } from '../../shared/plot-registry-utils.js';
import { renderOrUpdatePlot } from '../../shared/plot-lifecycle.js';
import { purgePlot } from '../../plots/plotly-loader.js';
import { downloadCSV } from '../../shared/analysis-utils.js';
import {
  DEFAULTS,
  TOP_N_OPTIONS,
  METHOD_OPTIONS,
  TRANSFORM_OPTIONS,
  COLORSCALE_OPTIONS,
  DISTANCE_OPTIONS,
  LINKAGE_OPTIONS,
  MODE_OPTIONS,
  P_VALUE_THRESHOLDS,
  FOLD_CHANGE_THRESHOLDS,
  ANALYSIS_PHASES
} from '../../genes-panel/constants.js';

// =============================================================================
// GENES PANEL UI
// =============================================================================

/**
 * Genes Panel UI Component
 *
 * @extends FormBasedAnalysisUI
 */
export class GenesPanelUI extends FormBasedAnalysisUI {
  /**
   * Get page requirements for this analysis type
   * @returns {{ minPages: number, maxPages: number, description: string }}
   */
  static getRequirements() {
    return {
      minPages: 1,
      maxPages: null,
      description: 'Discover and visualize marker genes across cell groups'
    };
  }

  /**
   * @param {Object} options
   * @param {Object} options.comparisonModule - Reference to main comparison module
   * @param {Object} options.dataLayer - Enhanced data layer
   */
  constructor(options) {
    super(options);

    /** @type {GenesPanelController|null} */
    this._controller = null;

    /** @type {HoverContext|null} */
    this._hoverContext = null;

    /** @type {ProgressTracker|null} */
    this._progressTracker = null;

    /** @type {HTMLElement|null} Custom genes textarea */
    this._customGenesInput = null;

    /**
     * Modal-only UI state: which group is selected in the marker table.
     * @type {string|null}
     * @private
     */
    this._modalSelectedGroupId = null;

    /**
     * Modal-only UI state: how many markers to show in the table.
     * @type {'top10'|'top20'|'all'}
     * @private
     */
    this._modalGeneListMode = 'top10';

    /**
     * Incremented per modal-annotations render to cancel async chunk rendering.
     * @type {number}
     * @private
     */
    this._modalAnnotationsRenderRevision = 0;

    // Bind methods
    this._handleModeChange = this._handleModeChange.bind(this);
  }

  // ===========================================================================
  // ABSTRACT METHOD IMPLEMENTATIONS
  // ===========================================================================

  /**
   * @override
   */
  _getTitle() {
    return 'Marker Genes';
  }

  /**
   * @override
   */
  _getDescription() {
    return 'Discover marker genes for each group and visualize as a clustered heatmap.';
  }

  /**
   * @override
   */
  _getClassName() {
    return 'genes-panel';
  }

  /**
   * @override
   */
  _getRunButtonText() {
    return 'Discover Markers';
  }

  /**
   * @override
   */
  _getLoadingMessage() {
    return 'Discovering marker genes...';
  }

  /**
   * @override
   */
  _renderFormControls(wrapper) {
    const form = document.createElement('div');
    form.className = 'analysis-form genes-panel-form';

    // Get available categories
    const categories = this._getAvailableCategories();

    // Build category options with placeholder if needed
    const categoryOptions = categories.length > 0
      ? categories.map(c => ({ value: c, label: c }))
      : [{ value: '', label: 'No categorical fields available' }];

    // Category selection
    const categorySelectEl = createFormSelect('obsCategory', categoryOptions);
    const categoryRow = createFormRow('Group By:', categorySelectEl, {
      description: 'Select a categorical observation field'
    });
    form.appendChild(categoryRow);

    // Mode selection - using positional API with onChange for reliability
    const modeSelectEl = createFormSelect('mode', MODE_OPTIONS.map(o => ({
      value: o.value,
      label: o.label,
      description: o.description,
      selected: o.value === 'clustered'
    })), { onChange: this._handleModeChange });
    const modeRow = createFormRow('Mode:', modeSelectEl, {
      description: 'How to select and display genes'
    });
    form.appendChild(modeRow);

    // Custom genes input (hidden by default)
    const customGenesGroup = document.createElement('div');
    customGenesGroup.className = 'form-section custom-genes-group hidden';
    const customGenesLabel = document.createElement('div');
    customGenesLabel.className = 'section-title';
    customGenesLabel.textContent = 'Custom Genes';
    customGenesGroup.appendChild(customGenesLabel);
    const customGenesTextarea = document.createElement('textarea');
    customGenesTextarea.name = 'customGenes';
    customGenesTextarea.className = 'analysis-form-textarea';
    customGenesTextarea.placeholder = 'Enter gene symbols, one per line or comma-separated';
    customGenesTextarea.rows = 4;
    customGenesTextarea.style.cssText = 'width: 100%; font-family: monospace; font-size: 12px;';
    customGenesGroup.appendChild(customGenesTextarea);
    this._customGenesInput = customGenesTextarea;
    form.appendChild(customGenesGroup);

    // Discovery parameters section (collapsible, open by default)
    const { container: discoverySection, content: discoveryContent } = this._createCollapsibleSection({
      title: 'Discovery Parameters',
      className: 'discovery-params',
      expanded: true
    });

    // Top N genes
    const topNSelectEl = createFormSelect('topNPerGroup', TOP_N_OPTIONS.map(o => ({
      value: o.value,
      label: o.label,
      description: o.description,
      selected: o.selected
    })));
    discoveryContent.appendChild(createFormRow('Top Genes per Group:', topNSelectEl));

    // Statistical method
    const methodSelectEl = createFormSelect('method', METHOD_OPTIONS.map(o => ({
      value: o.value,
      label: o.label,
      description: o.description,
      selected: o.selected
    })));
    discoveryContent.appendChild(createFormRow('Statistical Method:', methodSelectEl));

    // P-value threshold
    const pValueSelectEl = createFormSelect('pValueThreshold', P_VALUE_THRESHOLDS.map(o => ({
      value: o.value,
      label: o.label,
      description: o.description,
      selected: o.selected
    })));
    discoveryContent.appendChild(createFormRow('P-value Threshold:', pValueSelectEl));

    // Fold change threshold
    const fcSelectEl = createFormSelect('foldChangeThreshold', FOLD_CHANGE_THRESHOLDS.map(o => ({
      value: o.value,
      label: o.label,
      description: o.description,
      selected: o.selected
    })));
    discoveryContent.appendChild(createFormRow('Log2 FC Threshold:', fcSelectEl));

    // Use adjusted p-value
    const useAdjustedCheckbox = createFormCheckbox({
      label: 'Use FDR-corrected p-values',
      name: 'useAdjustedPValue',
      checked: DEFAULTS.useAdjustedPValue
    });
    discoveryContent.appendChild(useAdjustedCheckbox);

    // Use cache
    const useCacheCheckbox = createFormCheckbox({
      label: 'Use cached results',
      name: 'useCache',
      checked: true
    });
    discoveryContent.appendChild(useCacheCheckbox);

    form.appendChild(discoverySection);

    // Visualization section (collapsible, closed by default as detailed settings)
    const { container: vizSection, content: vizContent } = this._createCollapsibleSection({
      title: 'Visualization',
      className: 'viz-params',
      expanded: false
    });

    // Transform
    const transformSelectEl = createFormSelect('transform', TRANSFORM_OPTIONS.map(o => ({
      value: o.value,
      label: o.label,
      description: o.description,
      selected: o.selected
    })));
    vizContent.appendChild(createFormRow('Transform:', transformSelectEl));

    // Colorscale
    const colorscaleSelectEl = createFormSelect('colorscale', COLORSCALE_OPTIONS.map(o => ({
      value: o.value,
      label: o.label,
      description: o.description,
      selected: o.selected
    })));
    vizContent.appendChild(createFormRow('Color Scale:', colorscaleSelectEl));

    form.appendChild(vizSection);

    // Clustering section (collapsible, closed by default as detailed settings, hidden when mode='ranked')
    const { container: clusterSection, content: clusterContent } = this._createCollapsibleSection({
      title: 'Clustering',
      className: 'cluster-params',
      expanded: false
    });

    // Distance metric
    const distanceSelectEl = createFormSelect('distance', DISTANCE_OPTIONS.map(o => ({
      value: o.value,
      label: o.label,
      description: o.description,
      selected: o.selected
    })));
    clusterContent.appendChild(createFormRow('Distance Metric:', distanceSelectEl));

    // Linkage method
    const linkageSelectEl = createFormSelect('linkage', LINKAGE_OPTIONS.map(o => ({
      value: o.value,
      label: o.label,
      description: o.description,
      selected: o.selected
    })));
    clusterContent.appendChild(createFormRow('Linkage Method:', linkageSelectEl));

    // Cluster options
    const clusterRowsCheckbox = createFormCheckbox({
      label: 'Cluster Genes (rows)',
      name: 'clusterRows',
      checked: DEFAULTS.clusterRows
    });
    clusterContent.appendChild(clusterRowsCheckbox);

    const clusterColsCheckbox = createFormCheckbox({
      label: 'Cluster Groups (columns)',
      name: 'clusterCols',
      checked: DEFAULTS.clusterCols
    });
    clusterContent.appendChild(clusterColsCheckbox);

    form.appendChild(clusterSection);

    // Performance settings section (shared with DE analysis)
    const perfSettings = createPerformanceSettings({
      dataLayer: this.dataLayer,
      collapsed: true
    });
    form.appendChild(perfSettings);

    wrapper.appendChild(form);

    // Initialize visibility based on default mode ('clustered')
    // Uses setTimeout to ensure DOM is ready
    setTimeout(() => this._handleModeChange('clustered'), 0);
  }

  /**
   * @override
   */
  _getFormValues() {
    const form = this._formContainer?.querySelector('.analysis-form');
    if (!form) return {};

    const getValue = (name) => {
      const el = form.querySelector(`[name="${name}"]`);
      if (!el) return null;
      if (el.type === 'checkbox') return el.checked;
      return el.value;
    };

    const values = {
      obsCategory: getValue('obsCategory'),
      mode: getValue('mode'),
      topNPerGroup: parseInt(getValue('topNPerGroup'), 10) || DEFAULTS.topNPerGroup,
      method: getValue('method') || DEFAULTS.method,
      pValueThreshold: parseFloat(getValue('pValueThreshold')) || DEFAULTS.pValueThreshold,
      foldChangeThreshold: parseFloat(getValue('foldChangeThreshold')) || DEFAULTS.foldChangeThreshold,
      transform: getValue('transform') || DEFAULTS.transform,
      colorscale: getValue('colorscale') || DEFAULTS.colorscale,
      distance: getValue('distance') || DEFAULTS.distance,
      linkage: getValue('linkage') || DEFAULTS.linkage,
      clusterRows: getValue('clusterRows'),
      clusterCols: getValue('clusterCols'),
      useAdjustedPValue: getValue('useAdjustedPValue'),
      useCache: getValue('useCache'),
      // Performance settings (shared with DE analysis)
      ...getPerformanceFormValues(form)
    };

    // Handle custom genes
    if (values.mode === 'custom' && this._customGenesInput) {
      const text = this._customGenesInput.value || '';
      values.customGenes = text
        .split(/[\n,]+/)
        .map(g => g.trim())
        .filter(g => g.length > 0);
    }

    return values;
  }

  /**
   * Override _runAnalysis to use ProgressTracker for detailed progress notifications.
   * This replaces the base class's runAnalysisWithLoadingState with proper progress tracking.
   * @override
   */
  async _runAnalysis() {
    if (this._isDestroyed) return;

    // Get form values
    const formValues = this._getFormValues();

    // Validate form
    const validation = this._validateForm(formValues);
    if (!validation.valid) {
      this._notifications.error(validation.error || 'Invalid form values');
      return;
    }

    // Prevent concurrent runs
    if (this._isLoading) return;

    // Get run button for state management
    const runBtn = this._formContainer?.querySelector('.analysis-run-btn');
    const originalText = runBtn?.textContent;

    // Update button state
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.textContent = 'Running...';
    }

    this._isLoading = true;

    // Create progress tracker with phases matching the controller
    this._progressTracker = new ProgressTracker({
      totalItems: 1, // Updated dynamically once totals are known
      phases: [
        ANALYSIS_PHASES.INIT,
        ANALYSIS_PHASES.DISCOVERY,
        ANALYSIS_PHASES.MATRIX,
        ANALYSIS_PHASES.CLUSTERING,
        ANALYSIS_PHASES.RENDER
      ],
      title: 'Marker Genes Discovery',
      category: 'calculation',
      showNotification: true
    });

    this._progressTracker.start();

    try {
      const result = await this._runAnalysisImpl(formValues);

      if (result) {
        if (this._isDestroyed) return;

        // Complete progress tracker
        this._progressTracker.complete('Marker genes discovery complete');

        // Store result
        this._lastResult = result;
        this._currentPageData = result.data || result;

        // Show result
        await this._showResult(result);

        // Callback
        if (this.onResultChange) {
          this.onResultChange(result);
        }
      }
    } catch (error) {
      console.error('[GenesPanelUI] Analysis error:', error);
      this._progressTracker.fail(`Analysis failed: ${error.message}`);
    } finally {
      this._isLoading = false;
      this._progressTracker = null;
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.textContent = originalText;
      }
    }
  }

  /**
   * @override
   */
  async _runAnalysisImpl(formValues) {
    // Initialize controller if needed
    if (!this._controller) {
      this._controller = new GenesPanelController({
        dataLayer: this.dataLayer
      });
      await this._controller.init();
    }

    // Run analysis with progress updates
    const panelResult = await this._controller.runAnalysis({
      ...formValues,
      onProgress: (progress) => {
        this._updateProgress(progress);
      }
    });

    // Ranked mode is markers-only (no heatmap)
    if (formValues.mode === 'ranked') {
      return {
        type: 'genes_panel',
        plotType: null,
        data: null,
        options: {},
        title: 'Marker Genes',
        subtitle: formValues.obsCategory,
        markers: panelResult.markers,
        clustering: panelResult.clustering,
        metadata: panelResult.metadata
      };
    }

    // Clustered/custom mode: render heatmap
    return {
      type: 'genes_panel',
      plotType: 'gene-heatmap',
      data: { matrix: panelResult.matrix },
      options: {
        colorscale: formValues.colorscale,
        showValues: false,
        reverseColorscale: true
      },
      title: 'Marker Genes',
      subtitle: formValues.obsCategory,
      markers: panelResult.markers,
      clustering: panelResult.clustering,
      metadata: panelResult.metadata
    };
  }

  /**
   * @override
   */
  _validateForm(formValues) {
    if (!formValues.obsCategory) {
      return { valid: false, error: 'Please select a grouping category' };
    }

    if (formValues.mode === 'custom') {
      if (!formValues.customGenes || formValues.customGenes.length === 0) {
        return { valid: false, error: 'Please enter at least one gene for custom mode' };
      }
    }

    return { valid: true };
  }

  /**
   * @override
   */
  async _showResult(result) {
    this._resultContainer.classList.remove('hidden');

    // Purge any existing plots to prevent WebGL memory leaks
    purgePlot(this._resultContainer.querySelector('.analysis-preview-plot'));
    this._resultContainer.innerHTML = '';

    if (!result.plotType) {
      this._renderRankedMarkers(result, this._resultContainer);
      return;
    }

    const previewContainer = document.createElement('div');
    previewContainer.className = 'analysis-preview-container';
    this._resultContainer.appendChild(previewContainer);

    const plotContainer = document.createElement('div');
    plotContainer.className = 'analysis-preview-plot';
    plotContainer.id = this._plotContainerId || `genes-panel-plot-${Date.now()}`;
    this._plotContainerId = plotContainer.id;
    // Explicit height helps Plotly compute layout reliably in the sidebar.
    plotContainer.style.cssText = 'width: 100%; height: 380px;';
    previewContainer.appendChild(plotContainer);

    // Ensure plot type is registered
    await import('../../plots/types/gene-heatmap.js');

    const plotDef = PlotRegistry.get(result.plotType);
    if (!plotDef) {
      plotContainer.innerHTML = `<div class="plot-error">Unknown plot type: ${result.plotType}</div>`;
      return;
    }

    const mergedOptions = PlotRegistry.mergeOptions(result.plotType, result.options || {});
    try {
      await renderOrUpdatePlot({
        plotDef,
        data: result.data,
        options: mergedOptions,
        container: plotContainer,
        layoutEngine: null,
        preferUpdate: false
      });
    } catch (err) {
      console.error('[GenesPanelUI] Plot render error:', err);
      plotContainer.innerHTML = `<div class="plot-error">Failed to render heatmap: ${err.message || err}</div>`;
      return;
    }

    // Expand (modal) action
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'analysis-actions';
    actionsContainer.style.display = 'flex';
    actionsContainer.appendChild(this._createExpandButton());
    this._resultContainer.appendChild(actionsContainer);

    // Setup hover context (marker stats)
    this._setupHoverContext(plotContainer, result);
  }

  // ===========================================================================
  // MODAL RENDERING
  // ===========================================================================

  /**
   * @override
   */
  async _renderModalPlot(container) {
    if (!this._lastResult) return;

    container.innerHTML = '';
    const plotContainer = document.createElement('div');
    plotContainer.style.cssText = 'width: 100%; height: 500px;';
    container.appendChild(plotContainer);

    const result = this._lastResult;
    if (!result.plotType) {
      plotContainer.innerHTML = '<div class="analysis-empty-message">No plot for Ranked mode.</div>';
      return;
    }

    await import('../../plots/types/gene-heatmap.js');
    const plotDef = PlotRegistry.get(result.plotType);
    if (!plotDef) {
      plotContainer.innerHTML = `<div class="plot-error">Unknown plot type: ${result.plotType}</div>`;
      return;
    }

    const mergedOptions = PlotRegistry.mergeOptions(result.plotType, result.options || {});
    try {
      await renderOrUpdatePlot({
        plotDef,
        data: result.data,
        options: mergedOptions,
        container: plotContainer,
        layoutEngine: null,
        preferUpdate: false
      });
    } catch (err) {
      console.error('[GenesPanelUI] Modal plot render error:', err);
      plotContainer.innerHTML = `<div class="plot-error">Failed to render heatmap: ${err.message || err}</div>`;
      return;
    }

    this._setupHoverContext(plotContainer, result);
  }

  /**
   * Export marker heatmap data as CSV.
   * @override
   */
  _exportModalCSV() {
    const result = this._lastResult;
    if (!result) return;

    // Heatmap CSV
    const matrix = result?.data?.matrix;
    if (matrix) {
      const { genes, groupNames, values, nRows, nCols } = matrix;
      const header = ['gene', ...groupNames].join(',');
      const lines = new Array(nRows + 1);
      lines[0] = header;

      for (let r = 0; r < nRows; r++) {
        const row = new Array(nCols + 1);
        row[0] = genes[r];
        for (let c = 0; c < nCols; c++) {
          const v = values[r * nCols + c];
          row[c + 1] = Number.isFinite(v) ? String(v) : '';
        }
        lines[r + 1] = row.join(',');
      }

      downloadCSV(lines.join('\n'), 'marker_genes_heatmap', this._notifications);
      return;
    }

    // Ranked markers CSV
    const groups = result?.markers?.groups;
    if (!groups) return;

    const rows = ['group,gene,rank,log2FoldChange,pValue,adjustedPValue,meanInGroup,meanOutGroup,percentInGroup,percentOutGroup'];
    for (const [groupId, groupData] of Object.entries(groups)) {
      for (const m of (groupData?.markers || [])) {
        rows.push([
          groupId,
          m.gene ?? '',
          m.rank ?? '',
          Number.isFinite(m.log2FoldChange) ? m.log2FoldChange : '',
          Number.isFinite(m.pValue) ? m.pValue : '',
          Number.isFinite(m.adjustedPValue) ? m.adjustedPValue : '',
          Number.isFinite(m.meanInGroup) ? m.meanInGroup : '',
          Number.isFinite(m.meanOutGroup) ? m.meanOutGroup : '',
          Number.isFinite(m.percentInGroup) ? m.percentInGroup : '',
          Number.isFinite(m.percentOutGroup) ? m.percentOutGroup : ''
        ].join(','));
      }
    }

    downloadCSV(rows.join('\n'), 'marker_genes_ranked', this._notifications);
  }

  /**
   * Render ranked marker table (sidebar).
   * @private
   */
  _renderRankedMarkers(result, container) {
    const groups = result?.markers?.groups || {};
    const groupIds = Object.keys(groups);

    if (groupIds.length === 0) {
      container.innerHTML = '<div class="analysis-empty-message">No markers available.</div>';
      return;
    }

    const header = document.createElement('div');
    header.className = 'analysis-result-header';
    header.innerHTML = `<h4>Top Marker Genes</h4>`;
    container.appendChild(header);

    const controls = document.createElement('div');
    controls.className = 'analysis-actions';
    controls.style.display = 'flex';
    controls.style.gap = '8px';
    container.appendChild(controls);

    const select = document.createElement('select');
    select.className = 'obs-select';
    for (const id of groupIds) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      select.appendChild(opt);
    }
    controls.appendChild(select);
    controls.appendChild(this._createExpandButton());

    const tableWrap = document.createElement('div');
    container.appendChild(tableWrap);

    const render = () => {
      const groupId = select.value;
      const markers = groups[groupId]?.markers || [];

      const table = document.createElement('table');
      table.className = 'de-genes-table';

      const thead = document.createElement('thead');
      thead.innerHTML = '<tr><th>Gene</th><th>log2FC</th><th>p</th><th>FDR</th></tr>';
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (const m of markers) {
        const tr = document.createElement('tr');
        tr.className = m?.log2FoldChange > 0 ? 'up' : 'down';

        const tdGene = document.createElement('td');
        tdGene.className = 'gene-name';
        tdGene.textContent = String(m?.gene ?? '');
        tr.appendChild(tdGene);

        const tdFc = document.createElement('td');
        tdFc.textContent = Number.isFinite(m?.log2FoldChange) ? m.log2FoldChange.toFixed(3) : 'N/A';
        tr.appendChild(tdFc);

        const tdP = document.createElement('td');
        tdP.textContent = Number.isFinite(m?.pValue) ? m.pValue.toExponential(2) : 'N/A';
        tr.appendChild(tdP);

        const tdFdr = document.createElement('td');
        tdFdr.textContent = Number.isFinite(m?.adjustedPValue) ? m.adjustedPValue.toExponential(2) : 'N/A';
        tr.appendChild(tdFdr);

        tbody.appendChild(tr);
      }
      table.appendChild(tbody);

      tableWrap.innerHTML = '';
      tableWrap.appendChild(table);
    };

    select.addEventListener('change', render);
    render();
  }

  /**
   * @override
   */
  _renderModalStats(container) {
    if (!this._lastResult?.metadata) return;

    const { metadata } = this._lastResult;

    const statsHtml = `
      <div class="modal-stats-section">
        <h4>Analysis Summary</h4>
        <div class="stats-grid">
          <div class="stat-item">
            <span class="stat-label">Category:</span>
            <span class="stat-value">${metadata.obsCategory || 'N/A'}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Mode:</span>
            <span class="stat-value">${metadata.mode}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Method:</span>
            <span class="stat-value">${metadata.method}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Groups:</span>
            <span class="stat-value">${metadata.groupCount}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Genes:</span>
            <span class="stat-value">${metadata.geneCount}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Duration:</span>
            <span class="stat-value">${(metadata.duration / 1000).toFixed(1)}s</span>
          </div>
        </div>
      </div>
    `;

    container.innerHTML = statsHtml;
  }

  /**
   * Render marker genes table in modal (bottom-right panel).
   *
   * Matches the Differential Expression modal pattern:
   * - A header with a "Top N" dropdown
   * - A group selector
   * - A table of genes and stats
   *
   * @override
   */
  _renderModalAnnotations(container) {
    const result = this._lastResult;
    const groups = result?.markers?.groups || null;

    if (!groups) {
      // Custom mode: no marker discovery; show the gene list used in the heatmap.
      const genes = result?.data?.matrix?.genes || result?.matrix?.genes || [];
      if (!genes || genes.length === 0) {
        container.innerHTML = '<p class="modal-annotations-placeholder">No marker genes available.</p>';
        return;
      }

      container.innerHTML = '';
      const headerRow = document.createElement('div');
      headerRow.className = 'de-modal-genes-header';

      const title = document.createElement('h5');
      title.textContent = 'Genes in Heatmap';
      headerRow.appendChild(title);
      container.appendChild(headerRow);

      const pre = document.createElement('div');
      pre.className = 'analysis-empty-message';
      pre.style.whiteSpace = 'pre-wrap';
      pre.textContent = genes.join('\n');
      container.appendChild(pre);
      return;
    }

    const groupIds = Object.keys(groups);
    if (groupIds.length === 0) {
      container.innerHTML = '<p class="modal-annotations-placeholder">No marker genes available.</p>';
      return;
    }

    if (!this._modalSelectedGroupId || !groups[this._modalSelectedGroupId]) {
      this._modalSelectedGroupId = groupIds[0];
    }

    const renderRevision = ++this._modalAnnotationsRenderRevision;

    container.innerHTML = '';

    const headerRow = document.createElement('div');
    headerRow.className = 'de-modal-genes-header';

    const title = document.createElement('h5');
    title.textContent = 'Top Marker Genes';
    headerRow.appendChild(title);

    const topSelect = document.createElement('select');
    topSelect.className = 'obs-select';
    topSelect.innerHTML = `
      <option value="top10">Top 10</option>
      <option value="top20">Top 20</option>
      <option value="all">All</option>
    `;
    topSelect.value = this._modalGeneListMode;
    topSelect.addEventListener('change', () => {
      const v = topSelect.value;
      this._modalGeneListMode = (v === 'all' || v === 'top20') ? v : 'top10';
      this._renderModalAnnotations(container);
    });
    headerRow.appendChild(topSelect);

    const groupSelect = document.createElement('select');
    groupSelect.className = 'obs-select';
    for (const id of groupIds) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      if (id === this._modalSelectedGroupId) opt.selected = true;
      groupSelect.appendChild(opt);
    }
    groupSelect.addEventListener('change', () => {
      this._modalSelectedGroupId = groupSelect.value;
      this._renderModalAnnotations(container);
    });
    headerRow.appendChild(groupSelect);

    container.appendChild(headerRow);

    const markers = groups[this._modalSelectedGroupId]?.markers || [];
    if (markers.length === 0) {
      container.insertAdjacentHTML('beforeend', '<p class="modal-annotations-placeholder">No markers for selected group.</p>');
      return;
    }

    const maxRows = this._modalGeneListMode === 'all'
      ? Infinity
      : (this._modalGeneListMode === 'top20' ? 20 : 10);

    const genesToShow = Number.isFinite(maxRows) ? markers.slice(0, maxRows) : markers;

    const table = document.createElement('table');
    table.className = 'de-genes-table modal-de-genes';

    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Gene</th><th>log2FC</th><th>p</th><th>FDR</th></tr>';
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    container.appendChild(table);

    const createRowEl = (m) => {
      const tr = document.createElement('tr');
      tr.className = m?.log2FoldChange > 0 ? 'up' : 'down';

      const tdGene = document.createElement('td');
      tdGene.className = 'gene-name';
      tdGene.textContent = String(m?.gene ?? '');
      tr.appendChild(tdGene);

      const tdFc = document.createElement('td');
      tdFc.textContent = Number.isFinite(m?.log2FoldChange) ? m.log2FoldChange.toFixed(3) : 'N/A';
      tr.appendChild(tdFc);

      const tdP = document.createElement('td');
      tdP.textContent = Number.isFinite(m?.pValue) ? m.pValue.toExponential(2) : 'N/A';
      tr.appendChild(tdP);

      const tdFdr = document.createElement('td');
      tdFdr.textContent = Number.isFinite(m?.adjustedPValue) ? m.adjustedPValue.toExponential(2) : 'N/A';
      tr.appendChild(tdFdr);

      return tr;
    };

    const shouldChunkRender = this._modalGeneListMode === 'all' && genesToShow.length > 500;
    if (!shouldChunkRender) {
      for (const m of genesToShow) {
        tbody.appendChild(createRowEl(m));
      }
      return;
    }

    const CHUNK = 250;
    let cursor = 0;

    const renderChunk = () => {
      if (renderRevision !== this._modalAnnotationsRenderRevision) return;

      const end = Math.min(genesToShow.length, cursor + CHUNK);
      const frag = document.createDocumentFragment();
      for (let i = cursor; i < end; i++) {
        frag.appendChild(createRowEl(genesToShow[i]));
      }
      tbody.appendChild(frag);
      cursor = end;

      if (cursor < genesToShow.length) {
        setTimeout(renderChunk, 0);
      }
    };

    renderChunk();
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Get available categorical observation fields
   * @private
   * @returns {Array<{value: string, label: string}>} Options for category select
   */
  _getAvailableCategories() {
    try {
      // Use 'categorical_obs' type - data-layer returns VariableInfo[] with key and name
      const catVars = this.dataLayer.getAvailableVariables('categorical_obs');
      return catVars.map(v => v.key);
    } catch (e) {
      console.warn('[GenesPanelUI] Failed to get categorical fields:', e);
      return [];
    }
  }

  /**
   * Create a collapsible section matching Performance Settings design
   *
   * @private
   * @param {Object} options
   * @param {string} options.title - Section title
   * @param {string} options.className - CSS class for the section
   * @param {boolean} [options.expanded=true] - Whether section starts expanded
   * @returns {{ container: HTMLElement, content: HTMLElement }}
   */
  _createCollapsibleSection({ title, className, expanded = true }) {
    const container = document.createElement('div');
    container.className = `form-section ${className}`;

    const header = document.createElement('div');
    header.className = 'analysis-perf-header';
    header.innerHTML = `
      <span class="analysis-perf-title">${title}</span>
      <span class="analysis-perf-toggle">${expanded ? '▲' : '▼'}</span>
    `;

    const content = document.createElement('div');
    content.className = 'analysis-perf-content';
    content.style.display = expanded ? 'block' : 'none';

    let isExpanded = expanded;
    header.addEventListener('click', () => {
      isExpanded = !isExpanded;
      content.style.display = isExpanded ? 'block' : 'none';
      header.querySelector('.analysis-perf-toggle').textContent = isExpanded ? '▲' : '▼';
    });

    container.appendChild(header);
    container.appendChild(content);

    return { container, content };
  }

  /**
   * Handle mode selection change
   * Updates form section visibility based on selected mode:
   * - 'ranked': Hide clustering, show discovery params
   * - 'clustered': Show clustering, show discovery params
   * - 'custom': Hide discovery params, show clustering, show custom genes input
   *
   * @private
   * @param {string|Event} modeOrEvent - Mode value or change event
   */
  _handleModeChange(modeOrEvent) {
    // Support both direct value (from onChange callback) and event object
    const mode = typeof modeOrEvent === 'string' ? modeOrEvent : modeOrEvent?.target?.value;
    if (!mode) return;

    const customGenesGroup = this._formContainer?.querySelector('.custom-genes-group');
    const discoverySection = this._formContainer?.querySelector('.discovery-params');
    const clusterSection = this._formContainer?.querySelector('.cluster-params');

    // Custom genes input: only visible in 'custom' mode
    if (customGenesGroup) {
      customGenesGroup.classList.toggle('hidden', mode !== 'custom');
    }

    // Discovery parameters: visible in 'ranked' and 'clustered' modes
    if (discoverySection) {
      discoverySection.classList.toggle('hidden', mode === 'custom');
    }

    // Clustering section: only visible when mode is 'clustered' or 'custom'
    // Hidden entirely for 'ranked' mode as per user requirement
    if (clusterSection) {
      clusterSection.classList.toggle('hidden', mode === 'ranked');
    }
  }

  /**
   * Setup hover context for detailed gene info
   * @private
   */
  _setupHoverContext(plotContainer, result) {
    // Clean up existing hover context
    if (this._hoverContext) {
      this._hoverContext.destroy();
    }

    // Create new hover context
    this._hoverContext = new HoverContext({
      container: document.body,
      markers: result.markers
    });

    // Attach to plot events
    plotContainer.on?.('plotly_hover', (data) => {
      if (!data.points || data.points.length === 0) return;

      const point = data.points[0];
      const gene = point.x;
      const group = point.y;
      const value = point.z;

      const getClientPosition = () => {
        const evt = data?.event || point?.event;
        if (evt?.touches?.length) {
          return { x: evt.touches[0].clientX, y: evt.touches[0].clientY };
        }
        if (Number.isFinite(evt?.clientX) && Number.isFinite(evt?.clientY)) {
          return { x: evt.clientX, y: evt.clientY };
        }

        // Plotly provides pixel coordinates relative to the plot area.
        if (Number.isFinite(point?.xpx) && Number.isFinite(point?.ypx) && plotContainer?.getBoundingClientRect) {
          const rect = plotContainer.getBoundingClientRect();
          return { x: rect.left + point.xpx, y: rect.top + point.ypx };
        }

        // Last resort: center of plot container.
        if (plotContainer?.getBoundingClientRect) {
          const rect = plotContainer.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }

        return { x: 0, y: 0 };
      };

      // Find marker info
      let markerInfo = null;
      if (result.markers?.groups?.[group]) {
        markerInfo = result.markers.groups[group].markers.find(m => m.gene === gene);
      }

      this._hoverContext.show({
        gene,
        group,
        value,
        position: getClientPosition(),
        markerInfo
      });
    });

    plotContainer.on?.('plotly_unhover', () => {
      this._hoverContext.hide();
    });
  }

  /**
   * Update progress display via ProgressTracker
   * Called by the controller during analysis with { phase, progress, message }
   * @private
   * @param {Object} progress - Progress info from controller
   * @param {string} progress.phase - Current phase name
   * @param {number} progress.progress - Progress percentage (0-100)
   * @param {string} progress.message - Progress message
   */
  _updateProgress(progress) {
    if (!this._progressTracker) return;

    const { phase, progress: percent, loaded, total, message } = progress || {};

    // Keep the ProgressTracker's phase in sync with controller emissions so the
    // notification doesn't appear "stuck" on the initial phase.
    if (typeof phase === 'string' && phase.length > 0) {
      // If phase changes, reset the per-phase counters for a sane ETA.
      const prevPhase = this._progressTracker.getStats()?.phase;
      if (prevPhase !== phase) {
        this._progressTracker.setPhase(phase);
        this._progressTracker.setTotalItems(100);
        this._progressTracker.setCompletedItems(0);
      } else {
        this._progressTracker.setPhase(phase);
      }
    }

    if (Number.isFinite(total) && total > 0) {
      this._progressTracker.setTotalItems(total);
    }

    if (Number.isFinite(loaded)) {
      this._progressTracker.setCompletedItems(loaded);
    } else if (Number.isFinite(percent)) {
      // For phases that only report percentage (e.g., init/clustering), treat
      // the phase total as 100.
      if (!Number.isFinite(total) || total <= 0) {
        this._progressTracker.setTotalItems(100);
      }
      this._progressTracker.setCompletedItems(Math.floor(percent));
    }

    const displayMessage = message || (phase ? `${phase}...` : 'Working...');
    this._progressTracker.setMessage(displayMessage);
  }

  /**
   * @override
   */
  destroy() {
    // Cancel any in-progress tracking
    if (this._progressTracker) {
      this._progressTracker.cancel();
      this._progressTracker = null;
    }
    if (this._hoverContext) {
      this._hoverContext.destroy();
      this._hoverContext = null;
    }
    if (this._controller) {
      this._controller.close();
      this._controller = null;
    }
    super.destroy();
  }

  exportSettings() {
    const base = super.exportSettings();
    return {
      ...base,
      modalSelectedGroupId: this._modalSelectedGroupId,
      modalGeneListMode: this._modalGeneListMode
    };
  }

  importSettings(settings) {
    if (!settings) return;
    if (typeof settings.modalSelectedGroupId === 'string') {
      this._modalSelectedGroupId = settings.modalSelectedGroupId;
    }
    if (settings.modalGeneListMode === 'all' || settings.modalGeneListMode === 'top10' || settings.modalGeneListMode === 'top20') {
      this._modalGeneListMode = settings.modalGeneListMode;
    }
    super.importSettings(settings);
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a GenesPanelUI instance
 *
 * @param {Object} options - Same options as GenesPanelUI constructor
 * @returns {GenesPanelUI}
 */
export function createGenesPanelUI(options) {
  return new GenesPanelUI(options);
}

export default GenesPanelUI;
