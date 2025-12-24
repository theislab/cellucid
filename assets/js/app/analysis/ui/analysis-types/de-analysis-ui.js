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
  createFormSelect,
  createPerformanceSettings,
  getPerformanceFormValues
} from '../../shared/dom-utils.js';
import {
  deResultsToCSV,
  downloadCSV
} from '../../shared/analysis-utils.js';
// Note: renderStatsGrid and renderDEGenesTable are not used in sidebar
// Modal rendering uses HTML templates directly for better control
import { createPageComparisonSelector } from '../components/index.js';
import { purgePlot } from '../../plots/plotly-loader.js';
import { isFiniteNumber } from '../../shared/number-utils.js';
import { ProgressTracker } from '../../shared/progress-tracker.js';

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
      // DE has its own internal page comparison selector; don't block rendering
      // when the global page selection is empty.
      minPages: 0,
      maxPages: null, // Allow any number of pages; user selects which 2 to compare
      description: 'Select pages to compare'
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

    // Bind handlers
    this._handleComparisonChange = this._handleComparisonChange.bind(this);

    /** @type {ProgressTracker|null} */
    this._progressTracker = null;
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

    // === Performance Settings Section (shared with Genes Panel) ===
    const perfSettings = createPerformanceSettings({
      dataLayer: this.dataLayer,
      className: 'de-performance-settings',
      collapsed: true
    });
    wrapper.appendChild(perfSettings);
  }

  /**
   * Extract form values
   * @returns {Object}
   */
  _getFormValues() {
    const form = this._formContainer.querySelector('.analysis-form');
    const perfValues = getPerformanceFormValues(form);

    return {
      ...perfValues,
      method: form.querySelector('[name="method"]').value
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
      batchConfig: formValues.batchConfig || {},
      onProgress: (progress) => this._updateProgress(progress)
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

  /**
   * Override _runAnalysis to use the same progress bar UX as Marker Analysis.
   * @override
   */
  async _runAnalysis() {
    if (this._isDestroyed) return;

    const formValues = this._getFormValues();
    const validation = this._validateForm(formValues);
    if (!validation.valid) {
      this._notifications.error(validation.error || 'Invalid form values');
      return;
    }

    if (this._isLoading) return;

    const runBtn = this._formContainer?.querySelector('.analysis-run-btn');
    const originalText = runBtn?.textContent;
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.textContent = 'Running...';
    }
    this._isLoading = true;

    this._progressTracker = new ProgressTracker({
      totalItems: 1,
      phases: ['Loading & Computing', 'Multiple Testing Correction'],
      title: 'Differential Expression',
      category: 'calculation',
      showNotification: true
    });
    this._progressTracker.start();

    try {
      const result = await this._runAnalysisImpl(formValues);
      if (!result || this._isDestroyed) return;

      this._progressTracker.complete('Differential expression complete');

      this._lastResult = result;
      this._currentPageData = result.data || result;
      await this._showResult(result);

      if (this.onResultChange) this.onResultChange(result);
    } catch (error) {
      console.error('[DEAnalysisUI] Analysis error:', error);
      this._progressTracker?.fail(`Analysis failed: ${error.message}`);
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
   * Keep the DE ProgressTracker in sync with MultiVariableAnalysis progress emissions.
   * @private
   * @param {{ phase?: string, progress?: number, loaded?: number, total?: number, message?: string }|number} progress
   */
  _updateProgress(progress) {
    if (!this._progressTracker) return;

    // Back-compat: older callers may pass a numeric percent.
    if (Number.isFinite(progress)) {
      this._progressTracker.setPhase('Loading & Computing');
      this._progressTracker.setTotalItems(100);
      this._progressTracker.setCompletedItems(Math.floor(progress));
      return;
    }

    const { phase, progress: percent, loaded, total, message } = progress || {};

    if (typeof phase === 'string' && phase.length > 0) {
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
      if (!Number.isFinite(total) || total <= 0) this._progressTracker.setTotalItems(100);
      this._progressTracker.setCompletedItems(Math.floor(percent));
    }

    if (message) {
      this._progressTracker.setMessage(message);
    }
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
        plotContainer.innerHTML = '';
        const errorEl = document.createElement('div');
        errorEl.className = 'plot-error';
        errorEl.textContent = `Failed to render plot: ${err?.message || err}`;
        plotContainer.appendChild(errorEl);
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

    const geneListMode = this._modalGeneListMode || 'top5';
    const maxRows = geneListMode === 'all'
      ? Infinity
      : (geneListMode === 'top100' ? 100
        : geneListMode === 'top20' ? 20
          : geneListMode === 'top10' ? 10
            : 5);

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
      <option value="top5">Top 5</option>
      <option value="top10">Top 10</option>
      <option value="top20">Top 20</option>
      <option value="top100">Top 100</option>
      <option value="all">All</option>
    `;
    select.value = geneListMode;
    select.addEventListener('change', () => {
      const value = select.value;
      this._modalGeneListMode = (value === 'all' || value === 'top5' || value === 'top10' || value === 'top20' || value === 'top100')
        ? value
        : 'top5';
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
    if (settings.modalGeneListMode === 'all' ||
      settings.modalGeneListMode === 'top5' ||
      settings.modalGeneListMode === 'top10' ||
      settings.modalGeneListMode === 'top20' ||
      settings.modalGeneListMode === 'top100') {
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
