/**
 * Differential Expression Analysis UI Component
 *
 * Provides differential expression analysis functionality:
 * - Two-page comparison
 * - Gene selection (top N or all)
 * - Statistical method selection
 * - Volcano plot visualization
 * - DE gene table
 *
 * Extends FormBasedAnalysisUI for form + results pattern.
 */

import { FormBasedAnalysisUI } from './base/form-based-analysis.js';
import { PlotRegistry } from '../../shared/plot-registry-utils.js';
import {
  createFormRow,
  createFormSelect
} from '../../shared/dom-utils.js';
import {
  deResultsToCSV,
  downloadCSV
} from '../../shared/analysis-utils.js';
// Note: renderStatsGrid and renderDEGenesTable are not used in sidebar
// Modal rendering uses HTML templates directly for better control
import { createPageComparisonSelector } from '../components/index.js';
import { PerformanceConfig } from '../../shared/performance-config.js';
import { purgePlot } from '../../plots/plotly-loader.js';
import { isFiniteNumber } from '../../shared/number-utils.js';

/**
 * Differential Expression Analysis UI Component
 * @extends FormBasedAnalysisUI
 */
export class DEAnalysisUI extends FormBasedAnalysisUI {
  // ===========================================================================
  // Required Abstract Method Implementations
  // ===========================================================================

  /**
   * Get page requirements for differential expression
   * @static
   * @returns {{ minPages: number, maxPages: number, description: string }}
   */
  static getRequirements() {
    return {
      minPages: 1,
      maxPages: null, // Allow any number of pages; user selects which 2 to compare
      description: 'Select at least 1 page'
    };
  }

  /**
   * @param {Object} options
   */
  constructor(options) {
    super(options);

    this._plotContainerIdBase = this._instanceId ? `${this._instanceId}-de-analysis-plot` : 'de-analysis-plot';

    // Track which two pages are selected for comparison
    this._comparisonPages = [];

    /**
     * Modal-only UI state: how many DE genes to show in the annotations table.
     * @type {'top10'|'all'}
     * @private
     */
    this._modalGeneListMode = 'top10';

    /**
     * Incremented per modal-annotations render to cancel async chunk rendering.
     * @type {number}
     * @private
     */
    this._modalAnnotationsRenderRevision = 0;

    // Bind handlers
    this._handleComparisonChange = this._handleComparisonChange.bind(this);
  }

  /**
   * Handle page comparison selection change
   * @param {string[]} pageIds - Selected page IDs [pageA, pageB]
   */
  _handleComparisonChange(pageIds) {
    this._comparisonPages = pageIds || [];
  }

  /**
   * Get the analysis title
   * @returns {string}
   */
  _getTitle() {
    return 'Differential Expression';
  }

  /**
   * Get the analysis description
   * @returns {string}
   */
  _getDescription() {
    return 'Find genes differentially expressed between two pages.';
  }

  /**
   * Get CSS class prefix
   * @returns {string}
   */
  _getClassName() {
    return 'de-analysis';
  }

  /**
   * Get loading notification message
   * @returns {string}
   */
  _getLoadingMessage() {
    return 'Running differential expression...';
  }

  /**
   * Get success notification message
   * @returns {string}
   */
  _getSuccessMessage() {
    return 'Differential expression complete';
  }

  /**
   * Get run button text
   * @returns {string}
   */
  _getRunButtonText() {
    return 'Run Differential Expression';
  }

  /**
   * Render form-specific controls
   * @param {HTMLElement} wrapper - Form wrapper element
   */
  _renderFormControls(wrapper) {
    // Get available pages
    const pages = this.dataLayer.getPages();
    const availablePages = pages.filter(p => this._selectedPages.includes(p.id));

    // Page comparison selector (handles 2+ pages elegantly)
    const pageSelector = createPageComparisonSelector({
      pages: availablePages.length > 0 ? availablePages : pages,
      selectedIds: this._comparisonPages.length === 2 ? this._comparisonPages : this._selectedPages.slice(0, 2),
      onChange: this._handleComparisonChange
    });
    wrapper.appendChild(pageSelector);

    // Method selector
    const methodSelect = createFormSelect('method', [
      { value: 'wilcox', label: 'Wilcoxon', description: 'Rank-based test, robust to outliers and non-normal distributions.', selected: true },
      { value: 'ttest', label: 't-test', description: 'Parametric test, assumes normally distributed expression data.' }
    ]);
    wrapper.appendChild(createFormRow('Statistical method:', methodSelect));

    // Note: Significance and fold change thresholds are now in the results view
    // where they can be adjusted dynamically after analysis

    // === Performance Settings Section ===
    this._renderPerformanceSettings(wrapper);
  }

  /**
   * Render performance settings section
   * @param {HTMLElement} wrapper - Form wrapper element
   * @private
   */
  _renderPerformanceSettings(wrapper) {
    // Get data characteristics for dataset info display
    const pointCount = this.dataLayer?.state?.pointCount || 100000;
    const geneCount = this.dataLayer?.getAvailableVariables?.('gene_expression')?.length || 20000;
    const dataInfo = PerformanceConfig.getRecommendedSettings(pointCount, geneCount);

    // Performance settings container
    const perfSection = document.createElement('div');
    perfSection.className = 'de-performance-settings';

    // Section header with toggle
    const header = document.createElement('div');
    header.className = 'de-perf-header';
    header.innerHTML = `
      <span class="de-perf-title">Performance Settings</span>
      <span class="de-perf-toggle">▼</span>
    `;

    const content = document.createElement('div');
    content.className = 'de-perf-content';

    // Batch size selector
    const batchOptions = PerformanceConfig.getBatchSizeOptions(pointCount, geneCount);
    const batchSelect = createFormSelect('batchSize', batchOptions.map(opt => ({
      value: String(opt.value),
      label: opt.label,
      description: opt.description,
      selected: opt.selected
    })));
    content.appendChild(createFormRow('Batch size:', batchSelect));

    // Memory budget selector
    const memoryOptions = PerformanceConfig.getMemoryBudgetOptions();
    const memorySelect = createFormSelect('memoryBudget', memoryOptions.map(opt => ({
      value: String(opt.value),
      label: opt.label,
      description: opt.description,
      selected: opt.selected
    })));
    content.appendChild(createFormRow('Memory budget:', memorySelect));

    // Network concurrency selector (actual parallel network requests)
    const networkOptions = PerformanceConfig.getNetworkConcurrencyOptions();
    const networkSelect = createFormSelect('networkConcurrency', networkOptions.map(opt => ({
      value: String(opt.value),
      label: opt.label,
      description: opt.description,
      selected: opt.selected
    })));
    content.appendChild(createFormRow('Network parallelism:', networkSelect));

    // Parallelism selector
    const parallelismSelect = createFormSelect('parallelism', [
      { value: 'auto', label: 'Auto', description: 'Automatically distributes work across available cores.' },
      { value: '1', label: '1 core', description: 'Sequential processing with minimal resource usage.' },
      { value: '2', label: '2 cores', description: 'Light parallel processing for moderate workloads.' },
      { value: '4', label: '4 cores', description: 'Balanced parallel processing.' },
      { value: '8', label: '8 cores', description: 'Full parallel processing for maximum throughput.', selected: true }
    ]);
    content.appendChild(createFormRow('Compute parallelism:', parallelismSelect));

    // Dataset info display
    const infoDiv = document.createElement('div');
    infoDiv.className = 'de-perf-info';
    infoDiv.innerHTML = `
      <strong>Dataset:</strong> ${(pointCount / 1000).toFixed(0)}K cells × ${geneCount.toLocaleString()} genes<br>
      <strong>Est. data:</strong> ~${dataInfo.totalDataMB.toFixed(0)} MB total<br>
      <strong>Est. time:</strong> ~${dataInfo.estimatedTimeFormatted}
    `;
    content.appendChild(infoDiv);

    // Toggle functionality
    let isExpanded = false;
    content.style.display = 'none';

    header.addEventListener('click', () => {
      isExpanded = !isExpanded;
      content.style.display = isExpanded ? 'block' : 'none';
      header.querySelector('.de-perf-toggle').textContent = isExpanded ? '▲' : '▼';
    });

    perfSection.appendChild(header);
    perfSection.appendChild(content);
    wrapper.appendChild(perfSection);
  }

  /**
   * Extract form values
   * @returns {Object}
   */
  _getFormValues() {
    const form = this._formContainer.querySelector('.analysis-form');
    const parallelismRaw = form.querySelector('[name="parallelism"]')?.value || 'auto';
    const batchSizeRaw = form.querySelector('[name="batchSize"]')?.value;
    const memoryBudgetRaw = form.querySelector('[name="memoryBudget"]')?.value;
    const networkConcurrencyRaw = form.querySelector('[name="networkConcurrency"]')?.value;

    return {
      parallelism: parallelismRaw === 'auto' ? 'auto' : parseInt(parallelismRaw, 10),
      method: form.querySelector('[name="method"]').value,
      // Batch configuration for optimized loading
      batchConfig: {
        preloadCount: batchSizeRaw ? parseInt(batchSizeRaw, 10) : undefined,
        memoryBudgetMB: memoryBudgetRaw ? parseInt(memoryBudgetRaw, 10) : undefined,
        networkConcurrency: networkConcurrencyRaw ? parseInt(networkConcurrencyRaw, 10) : undefined
      }
    };
  }

  /**
   * Run the differential expression analysis
   * @param {Object} formValues - Form values
   * @returns {Promise<Object>} Analysis result
   */
  async _runAnalysisImpl(formValues) {
    // Use comparison pages if set, otherwise fall back to first two selected pages
    const [pageA, pageB] = this._comparisonPages.length === 2
      ? this._comparisonPages
      : this._selectedPages.slice(0, 2);

    // Run differential expression with optimized batch loading
    const deResults = await this.multiVariableAnalysis.differentialExpression({
      pageA,
      pageB,
      geneList: null, // Always test all genes; results are sorted so "top genes" naturally surface.
      method: formValues.method || 'wilcox',
      parallelism: formValues.parallelism,
      batchConfig: formValues.batchConfig || {}
    });

    // Use default thresholds - these can be adjusted dynamically in the results view
    return {
      type: 'differential',
      plotType: 'volcanoplot',
      data: deResults,
      options: {
        pValueThreshold: 0.05,
        foldChangeThreshold: 1.0,
        useAdjustedPValue: true,
        labelTopN: 15
      },
      title: 'Differential Expression',
      subtitle: `${deResults.metadata.pageAName} vs ${deResults.metadata.pageBName}`
    };
  }

  // ===========================================================================
  // Custom Result Rendering
  // ===========================================================================

  /**
   * Show analysis result with DE-specific visualization
   * Only shows volcano plot and expand button in sidebar.
   * Summary statistics and DE genes table are shown only in expanded modal view.
   * @param {Object} result - Analysis result
   */
  async _showResult(result) {
    this._resultContainer.classList.remove('hidden');
    // Purge any existing plots to prevent WebGL memory leaks
    purgePlot(this._resultContainer.querySelector('.analysis-preview-plot'));
    this._resultContainer.innerHTML = '';

    // Volcano plot container - directly under the run button, no header
    const previewContainer = document.createElement('div');
    previewContainer.className = 'analysis-preview-container';
    this._resultContainer.appendChild(previewContainer);

    const plotContainer = document.createElement('div');
    plotContainer.className = 'analysis-preview-plot';
    plotContainer.id = this._plotContainerIdBase;
    this._plotContainerId = this._plotContainerIdBase;
    previewContainer.appendChild(plotContainer);

    // Render volcano plot
    const plotDef = PlotRegistry.get(result.plotType);
    if (plotDef) {
      try {
        const mergedOptions = PlotRegistry.mergeOptions(result.plotType, result.options || {});
        await plotDef.render(result.data, mergedOptions, plotContainer, null);
      } catch (err) {
        console.error('[DEAnalysisUI] Volcano plot render error:', err);
        plotContainer.innerHTML = `<div class="plot-error">Failed to render plot: ${err.message}</div>`;
      }
    }

    // Expand (modal) action - shows stats and DE genes table in expanded view
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'analysis-actions';
    actionsContainer.style.display = 'flex';

    const expandBtn = this._createExpandButton();
    expandBtn.title = 'Open in full view with statistics and export options';
    actionsContainer.appendChild(expandBtn);
    this._resultContainer.appendChild(actionsContainer);

    // Note: Summary statistics and Top DE genes table are NOT shown in sidebar
    // They are only displayed in the expanded modal view (_renderModalStats and _renderModalAnnotations)
  }

  // ===========================================================================
  // Modal Rendering - Overrides from FormBasedAnalysisUI
  // ===========================================================================

  /**
   * Render DE statistics in modal
   * Statistics are dynamically calculated based on current threshold settings
   * @param {HTMLElement} container - Modal stats container
   */
  _renderModalStats(container) {
    const result = this._lastResult;
    const results = result?.data?.results;
    const options = PlotRegistry.mergeOptions('volcanoplot', result?.options || {});

    if (!results || results.length === 0) {
      container.innerHTML = '<p class="modal-stats-placeholder">Statistics not available</p>';
      return;
    }

    const {
      pValueThreshold = 0.05,
      foldChangeThreshold = 1.0,
      useAdjustedPValue = true
    } = options;

    // Calculate dynamic statistics based on current thresholds
    let upregulated = 0;
    let downregulated = 0;

    for (const row of results) {
      const pVal = useAdjustedPValue ? (row.adjustedPValue ?? row.pValue) : row.pValue;
      if (!isFiniteNumber(pVal) || !isFiniteNumber(row.log2FoldChange)) continue;

      const isSignificant = pVal < pValueThreshold && Math.abs(row.log2FoldChange) >= foldChangeThreshold;
      if (isSignificant) {
        if (row.log2FoldChange > 0) {
          upregulated++;
        } else {
          downregulated++;
        }
      }
    }

    const significantTotal = upregulated + downregulated;
    const pLabel = useAdjustedPValue ? 'FDR' : 'p';

    container.innerHTML = `
      <h5>Summary Statistics</h5>
      <table class="analysis-stats-table de-modal-stats">
        <tr>
          <td>Genes Tested</td>
          <td><strong>${results.length.toLocaleString()}</strong></td>
        </tr>
        <tr>
          <td>Significant (${pLabel} < ${pValueThreshold}, |log₂FC| ≥ ${foldChangeThreshold})</td>
          <td class="significant"><strong>${significantTotal.toLocaleString()}</strong></td>
        </tr>
        <tr>
          <td>Upregulated</td>
          <td class="up"><strong>${upregulated.toLocaleString()}</strong></td>
        </tr>
        <tr>
          <td>Downregulated</td>
          <td class="down"><strong>${downregulated.toLocaleString()}</strong></td>
        </tr>
      </table>
    `;
  }

  /**
   * Render DE statistical annotations in modal
   * @param {HTMLElement} container - Modal annotations container
   */
  _renderModalAnnotations(container) {
    const result = this._lastResult;
    const results = result?.data?.results;
    const options = PlotRegistry.mergeOptions('volcanoplot', result?.options || {});

    if (!results || results.length === 0) {
      container.innerHTML = '<p class="modal-annotations-placeholder">No significant genes found</p>';
      return;
    }

    const renderRevision = ++this._modalAnnotationsRenderRevision;

    const {
      pValueThreshold = 0.05,
      foldChangeThreshold = 1.0,
      useAdjustedPValue = true
    } = options;

    const geneListMode = this._modalGeneListMode || 'top10';
    const maxRows = geneListMode === 'all' ? Infinity : 10;

    const getPValue = (row) => {
      if (!row) return null;
      const raw = useAdjustedPValue ? (row.adjustedPValue ?? row.pValue) : row.pValue;
      return isFiniteNumber(raw) ? raw : null;
    };

    const passesThresholds = (row) => {
      const p = getPValue(row);
      if (p === null) return false;
      if (p >= pValueThreshold) return false;

      const fc = row?.log2FoldChange;
      if (!isFiniteNumber(fc)) return false;
      return Math.abs(fc) >= foldChangeThreshold;
    };

    /** @type {Array<any>} */
    const significantGenes = [];
    for (const row of results) {
      if (passesThresholds(row)) {
        significantGenes.push(row);
      }
    }

    significantGenes.sort((a, b) => Math.abs(b.log2FoldChange) - Math.abs(a.log2FoldChange));
    const genesToShow = Number.isFinite(maxRows) ? significantGenes.slice(0, maxRows) : significantGenes;

    if (genesToShow.length === 0) {
      container.innerHTML = `
        <p class="modal-annotations-placeholder">
          No genes passed the current thresholds (p &lt; ${pValueThreshold}, |log2FC| ≥ ${foldChangeThreshold}).
        </p>
      `;
      return;
    }

    container.innerHTML = '';

    const headerRow = document.createElement('div');
    headerRow.className = 'de-modal-genes-header';

    const title = document.createElement('h5');
    title.textContent = 'Top Differentially Expressed Genes';
    headerRow.appendChild(title);

    const select = document.createElement('select');
    select.className = 'obs-select';
    select.innerHTML = `
      <option value="top10">Top 10</option>
      <option value="all">All</option>
    `;
    select.value = geneListMode;
    select.addEventListener('change', () => {
      this._modalGeneListMode = select.value === 'all' ? 'all' : 'top10';
      this._renderModalAnnotations(container);
    });
    headerRow.appendChild(select);

    container.appendChild(headerRow);

    const table = document.createElement('table');
    table.className = 'de-genes-table modal-de-genes';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const thGene = document.createElement('th');
    thGene.textContent = 'Gene';
    const thFc = document.createElement('th');
    thFc.textContent = 'Log2 FC';
    const thP = document.createElement('th');
    thP.textContent = useAdjustedPValue ? 'Adj. P-value' : 'P-value';
    headRow.appendChild(thGene);
    headRow.appendChild(thFc);
    headRow.appendChild(thP);
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    container.appendChild(table);

    const formatPValueCell = (p) => {
      if (p === null) return 'N/A';
      if (p < 0.001) return '<0.001';
      return p.toFixed(4);
    };

    const createRowEl = (row) => {
      const tr = document.createElement('tr');
      tr.className = row?.log2FoldChange > 0 ? 'up' : 'down';

      const tdGene = document.createElement('td');
      tdGene.className = 'gene-name';
      tdGene.textContent = String(row?.gene ?? '');
      tr.appendChild(tdGene);

      const tdFc = document.createElement('td');
      tdFc.textContent = isFiniteNumber(row?.log2FoldChange) ? row.log2FoldChange.toFixed(3) : 'N/A';
      tr.appendChild(tdFc);

      const tdP = document.createElement('td');
      tdP.textContent = formatPValueCell(getPValue(row));
      tr.appendChild(tdP);

      return tr;
    };

    const shouldChunkRender = geneListMode === 'all' && genesToShow.length > 500;
    if (!shouldChunkRender) {
      for (const row of genesToShow) {
        tbody.appendChild(createRowEl(row));
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

  /**
   * Export DE results as CSV from modal
   */
  _exportModalCSV() {
    this._exportResultsCSV();
  }

  // ===========================================================================
  // Export Functions
  // ===========================================================================

  /**
   * Export plot as PNG
   */
  async _exportPlotPNG() {
    const plotEl = this._plotContainerId ? document.getElementById(this._plotContainerId) : null;
    if (!plotEl) return;

    await this._exportPNG(plotEl, {
      filename: 'differential_expression',
      width: 1200,
      height: 800
    });
  }

  /**
   * Export results as CSV (DE-specific format)
   */
  _exportResultsCSV() {
    if (!this._lastResult?.data?.results) return;

    const csv = deResultsToCSV(this._lastResult.data.results);
    downloadCSV(csv, 'differential_expression', this._notifications);
  }

  exportSettings() {
    const base = super.exportSettings();
    return {
      ...base,
      comparisonPages: [...this._comparisonPages],
      modalGeneListMode: this._modalGeneListMode
    };
  }

  importSettings(settings) {
    if (!settings) return;
    if (Array.isArray(settings.comparisonPages)) {
      this._comparisonPages = settings.comparisonPages.slice(0, 2);
    }
    if (settings.modalGeneListMode === 'all' || settings.modalGeneListMode === 'top10') {
      this._modalGeneListMode = settings.modalGeneListMode;
    }
    super.importSettings(settings);
  }
}

/**
 * Factory function to create DE analysis UI
 * @param {Object} options
 * @returns {DEAnalysisUI}
 */
export function createDEAnalysisUI(options) {
  return new DEAnalysisUI(options);
}

export default DEAnalysisUI;
