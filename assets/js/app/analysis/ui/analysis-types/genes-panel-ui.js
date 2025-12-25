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
  DISTANCE_OPTIONS,
  LINKAGE_OPTIONS,
  MODE_OPTIONS,
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
      minPages: 0,
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
     * @type {'top5'|'top10'|'top20'|'top100'|'all'}
     * @private
     */
    this._modalGeneListMode = 'top5';

    /**
     * Incremented per modal-annotations render to cancel async chunk rendering.
     * @type {number}
     * @private
     */
    this._modalAnnotationsRenderRevision = 0;

    /** @type {any|null} Full (unsliced) heatmap matrix from last run */
    this._fullMatrix = null;

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
      description: ''
    });
    form.appendChild(categoryRow);

    // Use cache (placed next to Group By as it affects data loading)
    const useCacheCheckbox = createFormCheckbox({
      label: 'Use cached results',
      name: 'useCache',
      checked: true
    });
    form.appendChild(useCacheCheckbox);

    // Mode selection - using positional API with onChange for reliability
    const modeSelectEl = createFormSelect('mode', MODE_OPTIONS.map(o => ({
      value: o.value,
      label: o.label,
      description: o.description,
      selected: o.value === 'clustered'
    })), { onChange: this._handleModeChange });
    // Statistical method selector (placed next to Mode; thresholds are adjusted in the figure modal)
    const methodSelectEl = createFormSelect('method', [
      { value: 'wilcox', label: 'Wilcoxon', description: 'Rank-based test, robust to outliers and non-normal distributions.', selected: true },
      { value: 'ttest', label: 't-test', description: 'Parametric test, assumes normally distributed expression data.' }
    ]);

    const modeAndMethod = document.createElement('div');
    modeAndMethod.className = 'page-comparison-row';
    modeSelectEl.classList.add('page-select');
    methodSelectEl.classList.add('page-select');
    modeAndMethod.appendChild(modeSelectEl);
    modeAndMethod.appendChild(methodSelectEl);

    const modeRow = createFormRow('Mode:', modeAndMethod, { description: '' });
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
      topNPerGroup: 'all',
      method: getValue('method') || DEFAULTS.method,
      // Thresholds are adjusted dynamically in the figure modal; keep defaults for initial run.
      pValueThreshold: DEFAULTS.pValueThreshold,
      foldChangeThreshold: DEFAULTS.foldChangeThreshold,
      transform: DEFAULTS.transform,
      colorscale: DEFAULTS.colorscale,
      distance: getValue('distance') || DEFAULTS.distance,
      linkage: getValue('linkage') || DEFAULTS.linkage,
      clusterRows: getValue('clusterRows'),
      clusterCols: getValue('clusterCols'),
      useAdjustedPValue: DEFAULTS.useAdjustedPValue,
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

    // Cache the full matrix so we can re-slice it when the modal "Top N" changes.
    this._fullMatrix = panelResult.matrix || null;

    const displayMatrix = this._buildHeatmapMatrixForMode({
      matrix: panelResult.matrix,
      markers: panelResult.markers,
      mode: this._modalGeneListMode
    });

    // Clustered/custom mode: render heatmap
    return {
      type: 'genes_panel',
      plotType: 'gene-heatmap',
      data: { matrix: displayMatrix, clustering: panelResult.clustering },
      options: {
        pValueThreshold: formValues.pValueThreshold,
        foldChangeThreshold: formValues.foldChangeThreshold,
        useAdjustedPValue: formValues.useAdjustedPValue,
        hasClustering: !!panelResult.clustering,
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

  _handlePlotOptionChange(key, value) {
    super._handlePlotOptionChange(key, value);

    if (key === 'pValueThreshold' || key === 'foldChangeThreshold' || key === 'useAdjustedPValue') {
      const revision = this._optionRenderRevision;
      void this._refreshMarkersAndHeatmapFromThresholds(revision);
    }

    if (key === 'transform') {
      const revision = this._optionRenderRevision;
      void this._refreshHeatmapTransform(revision, value);
    }
  }

  _getMarkerThresholdOptions() {
    const opts = this._lastResult?.options || {};
    return {
      pValueThreshold: Number.isFinite(opts.pValueThreshold) ? opts.pValueThreshold : DEFAULTS.pValueThreshold,
      foldChangeThreshold: Number.isFinite(opts.foldChangeThreshold) ? opts.foldChangeThreshold : DEFAULTS.foldChangeThreshold,
      useAdjustedPValue: opts.useAdjustedPValue !== false
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
      plotContainer.innerHTML = '';
      const errorEl = document.createElement('div');
      errorEl.className = 'plot-error';
      errorEl.textContent = `Unknown plot type: ${result.plotType}`;
      plotContainer.appendChild(errorEl);
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
      plotContainer.innerHTML = '';
      const errorEl = document.createElement('div');
      errorEl.className = 'plot-error';
      errorEl.textContent = `Failed to render heatmap: ${err?.message || err}`;
      plotContainer.appendChild(errorEl);
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
      plotContainer.innerHTML = '';
      const errorEl = document.createElement('div');
      errorEl.className = 'plot-error';
      errorEl.textContent = `Unknown plot type: ${result.plotType}`;
      plotContainer.appendChild(errorEl);
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
      plotContainer.innerHTML = '';
      const errorEl = document.createElement('div');
      errorEl.className = 'plot-error';
      errorEl.textContent = `Failed to render heatmap: ${err?.message || err}`;
      plotContainer.appendChild(errorEl);
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
    container.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'analysis-stats-table';

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

	    const addRow = (label, value) => {
	      const tr = document.createElement('tr');
	      const tdLabel = document.createElement('td');
	      tdLabel.textContent = label;
	      const tdValue = document.createElement('td');
	      const strong = document.createElement('strong');
	      strong.textContent = String(value);
	      tdValue.replaceChildren(strong);
	      tr.appendChild(tdLabel);
	      tr.appendChild(tdValue);
	      tbody.appendChild(tr);
	    };

    addRow('Category', String(metadata.obsCategory || 'N/A'));
    addRow('Mode', String(metadata.mode || 'N/A'));
    addRow('Method', String(metadata.method || 'N/A'));
    addRow('Groups', Number.isFinite(metadata.groupCount) ? String(metadata.groupCount) : String(metadata.groupCount || 'N/A'));
    addRow('Genes', Number.isFinite(metadata.geneCount) ? String(metadata.geneCount) : String(metadata.geneCount || 'N/A'));

    const durationSec = Number.isFinite(metadata.duration) ? (metadata.duration / 1000).toFixed(1) : null;
    addRow('Duration', durationSec ? `${durationSec}s` : 'N/A');

    container.appendChild(table);
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
      <option value="top5">Top 5</option>
      <option value="top10">Top 10</option>
      <option value="top20">Top 20</option>
      <option value="top100">Top 100</option>
      <option value="all">All</option>
    `;
    topSelect.value = this._modalGeneListMode;
    topSelect.addEventListener('change', () => {
      const v = topSelect.value;
      this._modalGeneListMode = (v === 'all' || v === 'top5' || v === 'top10' || v === 'top20' || v === 'top100')
        ? v
        : 'top5';
      this._renderModalAnnotations(container);
      this._rerenderHeatmapForModalSelection();
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
      : (this._modalGeneListMode === 'top100' ? 100
        : this._modalGeneListMode === 'top20' ? 20
          : this._modalGeneListMode === 'top10' ? 10
            : 5);

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

  _getTopNFromMode(mode) {
    if (mode === 'all') return Infinity;
    if (mode === 'top100') return 100;
    if (mode === 'top20') return 20;
    if (mode === 'top10') return 10;
    return 5;
  }

  _computeTopMarkersForGroupIndex({
    groupId,
    geneKeys,
    pValuesEffective,
    pValuesRaw,
    adjPValues,
    log2FC,
    topN,
    pValueThreshold,
    foldChangeThreshold
  }) {
    const out = [];
    const n = geneKeys.length;
    if (!pValuesEffective || !log2FC) return out;

    for (let i = 0; i < n; i++) {
      const p = pValuesEffective[i];
      const fc = log2FC[i];
      if (!Number.isFinite(p) || p >= pValueThreshold) continue;
      if (!Number.isFinite(fc) || Math.abs(fc) < foldChangeThreshold) continue;

      out.push({
        gene: geneKeys[i],
        geneIndex: i,
        groupId,
        pValue: Number.isFinite(pValuesRaw?.[i]) ? pValuesRaw[i] : p,
        adjustedPValue: Number.isFinite(adjPValues?.[i]) ? adjPValues[i] : null,
        log2FoldChange: fc
      });
    }

    out.sort((a, b) => {
      const pa = Number.isFinite(a.adjustedPValue) ? a.adjustedPValue : (Number.isFinite(a.pValue) ? a.pValue : 1);
      const pb = Number.isFinite(b.adjustedPValue) ? b.adjustedPValue : (Number.isFinite(b.pValue) ? b.pValue : 1);
      if (pa !== pb) return pa - pb;
      return Math.abs(b.log2FoldChange) - Math.abs(a.log2FoldChange);
    });

    return out.slice(0, Math.min(out.length, topN));
  }

  _rebuildMarkerGroupsFromStats({ markers, topN }) {
    const stats = markers?.stats;
    if (!stats?.genes || !stats.groupIds || !stats.pValuesByGroup || !stats.log2FoldChangeByGroup) return null;

    const { pValueThreshold, foldChangeThreshold, useAdjustedPValue } = this._getMarkerThresholdOptions();

    /** @type {Record<string, any>} */
    const nextGroups = {};
    for (let g = 0; g < stats.groupIds.length; g++) {
      const groupId = stats.groupIds[g];
      const pEff = useAdjustedPValue ? stats.adjustedPValuesByGroup?.[g] : stats.pValuesByGroup[g];
      const picked = this._computeTopMarkersForGroupIndex({
        groupId,
        geneKeys: stats.genes,
        pValuesEffective: pEff,
        pValuesRaw: stats.pValuesByGroup[g],
        adjPValues: stats.adjustedPValuesByGroup?.[g],
        log2FC: stats.log2FoldChangeByGroup[g],
        topN: Number.isFinite(topN) ? topN : stats.genes.length,
        pValueThreshold,
        foldChangeThreshold
      });

      nextGroups[groupId] = {
        ...(markers.groups?.[groupId] || {}),
        groupId,
        markers: picked.map((m, i) => ({ ...m, rank: i + 1 }))
      };
    }

    return nextGroups;
  }

  _computeHeatmapGeneSet({ markers, topN }) {
    const nextGroups = this._rebuildMarkerGroupsFromStats({ markers, topN });
    const groups = nextGroups || markers?.groups || {};

    const wanted = new Set();
    for (const group of Object.values(groups)) {
      const list = group?.markers || [];
      const limit = Math.min(list.length, topN);
      for (let i = 0; i < limit; i++) {
        if (list[i]?.gene) wanted.add(list[i].gene);
      }
    }
    return wanted;
  }

  _buildHeatmapMatrixForMode({ matrix, markers, mode }) {
    if (!matrix || !markers) return matrix;

    const topN = this._getTopNFromMode(mode);
    if (!Number.isFinite(topN)) return matrix;

    const wanted = this._computeHeatmapGeneSet({ markers, topN });

    if (wanted.size === 0) return matrix;

    const genes = matrix.genes || [];
    const keepRows = [];
    for (let i = 0; i < genes.length; i++) {
      if (wanted.has(genes[i])) keepRows.push(i);
    }

    if (keepRows.length === 0 || keepRows.length === genes.length) return matrix;

    const nCols = matrix.nCols || (matrix.groupIds?.length || 0);
    const nRows = keepRows.length;
    const outValues = new Float32Array(nRows * nCols);
    outValues.fill(NaN);
    const outRaw = matrix.rawValues ? new Float32Array(nRows * nCols) : null;

    for (let r = 0; r < nRows; r++) {
      const srcRow = keepRows[r];
      const srcOffset = srcRow * nCols;
      const dstOffset = r * nCols;
      for (let c = 0; c < nCols; c++) {
        outValues[dstOffset + c] = matrix.values[srcOffset + c];
        if (outRaw && matrix.rawValues) {
          outRaw[dstOffset + c] = matrix.rawValues[srcOffset + c];
        }
      }
    }

    const out = {
      ...matrix,
      genes: keepRows.map(i => genes[i]),
      values: outValues,
      rawValues: outRaw,
      nRows
    };

    return out;
  }

  async _rerenderHeatmapForModalSelection() {
    if (!this._lastResult?.plotType || this._lastResult.plotType !== 'gene-heatmap') return;
    if (!this._fullMatrix || !this._lastResult.markers) return;

    // Update marker lists to match current threshold options.
    const topN = this._getTopNFromMode(this._modalGeneListMode);
    const rebuilt = this._rebuildMarkerGroupsFromStats({ markers: this._lastResult.markers, topN });
    if (rebuilt) {
      this._lastResult.markers.groups = rebuilt;
    }

    const nextMatrix = this._buildHeatmapMatrixForMode({
      matrix: this._fullMatrix,
      markers: this._lastResult.markers,
      mode: this._modalGeneListMode
    });

    // Update the cached result and re-render preview plot.
    const clustering = this._lastResult.data?.clustering || this._lastResult.clustering || null;
    this._lastResult.data = { matrix: nextMatrix, clustering };
    if (this._lastResult.options) this._lastResult.options.hasClustering = !!clustering;
    const revision = ++this._optionRenderRevision;
    void this._rerenderAfterOptionChange(revision);
  }

  async _refreshMarkersAndHeatmapFromThresholds(revision) {
    if (this._isDestroyed) return;
    if (revision !== this._optionRenderRevision) return;
    if (!this._lastResult?.markers) return;

    const topN = this._getTopNFromMode(this._modalGeneListMode);
    const rebuilt = this._rebuildMarkerGroupsFromStats({ markers: this._lastResult.markers, topN });
    if (rebuilt) {
      this._lastResult.markers.groups = rebuilt;
    }

    // Compute desired gene set for heatmap.
    const wanted = Array.from(this._computeHeatmapGeneSet({ markers: this._lastResult.markers, topN }))
      .filter(Boolean);

    if (wanted.length === 0) {
      return;
    }

    // If the gene set is fully covered by the current matrix, slice locally.
    const current = this._fullMatrix;
    const geneSet = new Set(current?.genes || []);
    const canSlice = current && current.values && wanted.every(g => geneSet.has(g));

    let nextMatrix;
    if (canSlice) {
      nextMatrix = this._buildHeatmapMatrixForMode({
        matrix: current,
        markers: this._lastResult.markers,
        mode: this._modalGeneListMode
      });
    } else {
      // Rebuild matrix for the new gene set (no re-run of marker discovery).
      const obsCategory = this._lastResult.metadata?.obsCategory;
      if (!obsCategory || !this._controller) return;

      const { groups } = await this._controller.getGroupsAndCodes(obsCategory, {});
      if (this._isDestroyed) return;
      if (revision !== this._optionRenderRevision) return;

      nextMatrix = await this._controller.buildMatrixForGenes({
        genes: wanted,
        groups,
        transform: this._lastResult.metadata?.transform || DEFAULTS.transform,
        batchConfig: this._lastResult.metadata?.batchConfig || {},
        onProgress: null
      });
      this._fullMatrix = nextMatrix;
    }

    const clustering = this._lastResult.data?.clustering || this._lastResult.clustering || null;
    this._lastResult.data = { matrix: nextMatrix, clustering };
    if (this._lastResult.options) this._lastResult.options.hasClustering = !!clustering;
    const nextRevision = ++this._optionRenderRevision;
    void this._rerenderAfterOptionChange(nextRevision);
  }

  async _refreshHeatmapTransform(revision, transform) {
    if (this._isDestroyed) return;
    if (revision !== this._optionRenderRevision) return;
    if (!this._controller || !this._fullMatrix) return;

    // Re-transform the full matrix (preserves rawValues so repeated toggles work).
    const wrapper = { matrix: this._fullMatrix };
    const transformed = this._controller.retransform(wrapper, transform)?.matrix || null;
    if (!transformed) return;

    this._fullMatrix = transformed;
    if (this._lastResult?.metadata) {
      this._lastResult.metadata.transform = transform;
    }

    const nextMatrix = this._buildHeatmapMatrixForMode({
      matrix: this._fullMatrix,
      markers: this._lastResult?.markers,
      mode: this._modalGeneListMode
    });

    const clustering = this._lastResult?.data?.clustering || this._lastResult?.clustering || null;
    if (this._lastResult) {
      if (!this._lastResult.options) this._lastResult.options = {};
      this._lastResult.options.transform = transform;
      this._lastResult.data = { matrix: nextMatrix, clustering };
    }

    const nextRevision = ++this._optionRenderRevision;
    void this._rerenderAfterOptionChange(nextRevision);
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
    const titleEl = document.createElement('span');
    titleEl.className = 'analysis-perf-title';
    titleEl.textContent = String(title ?? '');
    header.appendChild(titleEl);

    const toggleEl = document.createElement('span');
    toggleEl.className = 'analysis-perf-toggle';
    toggleEl.textContent = expanded ? '▲' : '▼';
    header.appendChild(toggleEl);

    const content = document.createElement('div');
    content.className = 'analysis-perf-content';
    content.style.display = expanded ? 'block' : 'none';

    let isExpanded = expanded;
    header.addEventListener('click', () => {
      isExpanded = !isExpanded;
      content.style.display = isExpanded ? 'block' : 'none';
      toggleEl.textContent = isExpanded ? '▲' : '▼';
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
