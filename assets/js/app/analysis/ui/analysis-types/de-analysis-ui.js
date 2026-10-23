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

import { formatCount } from '../../../ui/components/display-format.js';
import { FormBasedAnalysisUI } from './base/form-based-analysis.js';
import { PlotRegistry } from '../../shared/plot-registry-utils.js';
import {
  createPerformanceSettings,
  createSelectField,
  getPerformanceFormValues
} from '../../shared/dom-utils.js';
import {
  deResultsToCSV,
  downloadCSV
} from '../../shared/analysis-utils.js';
// Note: the sidebar shows only the volcano plot. Summary statistics and the DE
// gene table are rendered from HTML templates in the expanded modal view
// (_renderModalStats, _renderModalAnnotations), which is the only DE result view.
import { createPageComparisonSelector } from '../components/index.js';
import { isFiniteNumber } from '../../shared/number-utils.js';
import {
  createResultEnvelope,
  readResultEnvelope,
  requireDatasetGenes,
  requireDatasetPages
} from '../../shared/analysis-result-session.js';

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
   * @returns {{ minPages: number, maxPages: number, description: string, geneExpression: true }}
   */
  static getRequirements() {
    return {
      // DE has its own internal page comparison selector; don't block rendering
      // when the global page selection is empty.
      minPages: 0,
      maxPages: null, // Allow any number of pages; user selects which 2 to compare
      description: 'Select pages to compare',
      geneExpression: true
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


    // Bind handlers
    this._handleComparisonChange = this._handleComparisonChange.bind(this);
  }

  /**
   * Handle page comparison selection change
   * @param {string[]} pageIds - Selected page IDs [pageA, pageB]
   */
  _handleComparisonChange(pageIds) {
    if (!Array.isArray(pageIds) || pageIds.length !== 2) {
      throw new TypeError(
        'Differential expression requires exactly two comparison page IDs'
      );
    }
    if (
      pageIds.some(
        pageId => typeof pageId !== 'string' || pageId.length === 0
      )
    ) {
      throw new TypeError(
        'Differential expression comparison page IDs must be non-empty strings'
      );
    }
    if (pageIds[0] === pageIds[1]) {
      throw new TypeError(
        'Differential expression comparison pages must be different'
      );
    }
    for (const pageId of pageIds) {
      if (this.dataLayer.getCellCountForPageId(pageId) === 0) {
        throw new RangeError(
          `Differential expression page "${pageId}" has zero cells and cannot be selected`
        );
      }
    }
    this._comparisonPages = [...pageIds];
    this._handleFormInputIntent();
  }

  /**
   * Get the analysis title
   * @returns {string}
   */
  _getTitle() {
    return 'Differential expression';
  }

  /**
   * What a run costs: every gene, tested in the two pages' cells.
   * @override
   */
  _describeRunCost() {
    if (!Array.isArray(this._comparisonPages) || this._comparisonPages.length !== 2) return null;
    const genes = this.dataLayer.getAvailableVariables('gene_expression').length;
    const [a, b] = this._comparisonPages.map(pageId => this.dataLayer.getCellCountForPageId(pageId));
    return `Tests ${formatCount(genes)} genes in ${formatCount(a)} vs ${formatCount(b)} cells.`;
  }

  /**
   * Get CSS class prefix
   * @returns {string}
   */
  _getClassName() {
    return 'de-analysis';
  }

  /**
   * Get run button text
   * @returns {string}
   */
  _getRunButtonText() {
    return 'Run differential expression';
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
      selectedIds: this._comparisonPages,
      onChange: this._handleComparisonChange,
      getCellCountForPageId: pageId =>
        this.dataLayer.getCellCountForPageId(pageId)
    });
    wrapper.appendChild(pageSelector);

    // Method selector
    wrapper.appendChild(createSelectField({
      label: 'Statistical method',
      name: 'method',
      tip: 'analysis-test-method',
      options: [
        { value: 'wilcox', label: 'Wilcoxon', selected: true },
        { value: 'ttest', label: 't-test' }
      ]
    }).root);

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

  _validateForm(formValues) {
    if (this._comparisonPages.length !== 2) {
      return {
        valid: false,
        error: 'Select two non-empty cell groups to run differential expression'
      };
    }
    if (formValues.method !== 'wilcox' && formValues.method !== 'ttest') {
      return {
        valid: false,
        error: 'Select a supported differential expression method'
      };
    }
    return { valid: true };
  }

  /**
   * Run the differential expression analysis
   * @param {Object} formValues - Form values
   * @param {number} requestId
   * @param {import('../../../jobs/cancellable-job.js').CancellableJob} job -
   *   The run's job: told every gene tested; its signal stops the gene
   *   reads and the worker tasks
   * @returns {Promise<Object|null>} Analysis result
   */
  async _runAnalysisImpl(formValues, requestId, job) {
    if (
      !Array.isArray(this._comparisonPages) ||
      this._comparisonPages.length !== 2
    ) {
      throw new Error(
        'Differential expression requires two selected comparison pages'
      );
    }
    const [pageA, pageB] = this._comparisonPages;
    if (formValues.method !== 'wilcox' && formValues.method !== 'ttest') {
      throw new TypeError(
        'Differential expression method must be wilcox or ttest'
      );
    }
    if (
      formValues.batchConfig === null ||
      typeof formValues.batchConfig !== 'object' ||
      Array.isArray(formValues.batchConfig)
    ) {
      throw new TypeError(
        'Differential expression batchConfig must be an object'
      );
    }

    // Run differential expression with optimized batch loading
    const deResults = await this.multiVariableAnalysis.differentialExpression({
      pageA,
      pageB,
      geneList: null, // Always test all genes; results are sorted so "top genes" naturally surface.
      method: formValues.method,
      parallelism: formValues.parallelism,
      batchConfig: formValues.batchConfig,
      job,
      isCurrent: () => this._isCurrentAnalysisRequest(requestId),
      registerInvalidationCleanup: cleanup =>
        this._registerAnalysisInvalidationCleanup(requestId, cleanup)
    });
    if (
      deResults === null ||
      !this._isCurrentAnalysisRequest(requestId)
    ) {
      return null;
    }

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
      title: 'Differential expression',
      subtitle: `${deResults.metadata.pageAName} vs ${deResults.metadata.pageBName}`
    };
  }

  /**
   * The success notification: how many genes are significant.
   * @override
   */
  _getSuccessMessage() {
    const summary = this._lastResult?.data?.summary;
    return summary
      ? `Differential expression: ${formatCount(summary.significantGenes)} significant genes`
      : 'Differential expression complete';
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
  async _showResult(result, requestId) {
    // Note: Summary statistics and Top DE genes table are NOT shown in sidebar
    // They are only displayed in the expanded modal view (_renderModalStats and _renderModalAnnotations)
    return this._renderPreviewPlot({
      result,
      requestId,
      containerId: this._plotContainerIdBase,
      expandable: true
    });
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
    const summary = result?.data?.summary;
    const options = PlotRegistry.mergeOptions('volcanoplot', result?.options || {});

    if (!results || results.length === 0) {
      container.innerHTML = '<p class="empty-state">Statistics not available</p>';
      return;
    }
    if (
      summary === null ||
      typeof summary !== 'object' ||
      Array.isArray(summary) ||
      !Number.isSafeInteger(summary.genesTested) ||
      !Number.isSafeInteger(summary.genesUntestable) ||
      !Number.isSafeInteger(summary.minCells)
    ) {
      throw new TypeError(
        'Differential-expression summary must report genesTested, genesUntestable and minCells'
      );
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
      const pVal = useAdjustedPValue ? row.adjustedPValue : row.pValue;
      if (!isFiniteNumber(pVal) || !isFiniteNumber(row.log2FoldChange)) continue;

      const isSignificant = pVal <= pValueThreshold && Math.abs(row.log2FoldChange) >= foldChangeThreshold;
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

    // "Genes tested" must be the multiple-testing denominator, not the panel
    // size: genes that failed the min-cell check carry no p-value and were
    // never part of the corrected family. Both the denominator and the skipped
    // remainder are shown, so the reported FDR can be reconstructed from the
    // counts in this table alone.
    container.innerHTML = `
      <table class="analysis-stats-table de-modal-stats">
        <tr>
          <td>Genes tested (FDR denominator)</td>
          <td><strong>${formatCount(summary.genesTested)}</strong></td>
        </tr>
        <tr>
          <td title="Genes skipped before testing: one of the two groups had fewer than ${summary.minCells} cells with a measured value for that gene, so no p-value exists and the gene is not part of the FDR correction.">Not tested (&lt; ${formatCount(summary.minCells)} cells with a value)</td>
          <td><strong>${formatCount(summary.genesUntestable)}</strong></td>
        </tr>
        <tr>
          <td>Significant (${pLabel} ≤ ${pValueThreshold}, |log₂FC| ≥ ${foldChangeThreshold})</td>
          <td class="significant"><strong>${formatCount(significantTotal)}</strong></td>
        </tr>
        <tr>
          <td>Upregulated</td>
          <td class="up"><strong>${formatCount(upregulated)}</strong></td>
        </tr>
        <tr>
          <td>Downregulated</td>
          <td class="down"><strong>${formatCount(downregulated)}</strong></td>
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
      container.innerHTML = '<p class="empty-state">No significant genes found</p>';
      return;
    }

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
      const raw = useAdjustedPValue ? row.adjustedPValue : row.pValue;
      return isFiniteNumber(raw) ? raw : null;
    };

    const passesThresholds = (row) => {
      const p = getPValue(row);
      if (p === null) return false;
      if (p > pValueThreshold) return false;

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
        <p class="empty-state">
          No genes passed the current thresholds (p ≤ ${pValueThreshold}, |log2FC| ≥ ${foldChangeThreshold}).
        </p>
      `;
      return;
    }

    container.innerHTML = '';

    const headerRow = document.createElement('div');
    headerRow.className = 'de-modal-genes-header';

    const title = document.createElement('h5');
    title.textContent = 'Top differentially expressed genes';
    headerRow.appendChild(title);

    const select = document.createElement('select');
    select.className = 'obs-select';
    select.setAttribute('aria-label', 'Genes to list');
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
      if (p === 0) return '0';
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

    this._renderTableRows(tbody, genesToShow, createRowEl, {
      chunked: geneListMode === 'all' && genesToShow.length > 500
    });
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

  /**
   * The shown result for a session: the volcano result whose table names
   * genes by key and pages by ID.
   * @returns {null|{kind: 'differential', version: number, payload: unknown}}
   */
  exportResult() {
    if (this._lastResult === null || this._lastResult === undefined) return null;
    return createResultEnvelope('differential', this._lastResult);
  }

  /**
   * Restore a result written by `exportResult()`; refused when it names a
   * gene or cell group the open dataset lacks.
   * @param {null|Object} envelope
   * @returns {Promise<void>}
   */
  async importResult(envelope) {
    if (envelope === null) {
      await this._discardFormResult();
      return;
    }
    const result = readResultEnvelope(envelope, 'differential');
    const results = result?.data?.results;
    const summary = result?.data?.summary;
    if (
      result?.type !== 'differential' ||
      result.plotType !== 'volcanoplot' ||
      !Array.isArray(results) ||
      summary === null ||
      typeof summary !== 'object'
    ) {
      throw new TypeError('A differential expression result must hold a volcano result table');
    }
    requireDatasetGenes(
      this.dataLayer,
      results.map(row => row?.gene),
      'The differential expression result'
    );
    requireDatasetPages(
      this.dataLayer,
      [summary.pageA, summary.pageB],
      'The differential expression result'
    );
    await this._restoreAnalysisResult(result);
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
    const base = this._requireExactFormSettings(
      settings,
      [
        'comparisonPages',
        'formControls',
        'modalGeneListMode',
        'selectedPages'
      ]
    );
    if (
      !Array.isArray(settings.comparisonPages) ||
      (settings.comparisonPages.length !== 0 &&
        settings.comparisonPages.length !== 2)
    ) {
      throw new TypeError(
        'Differential expression comparisonPages must contain zero or two page IDs'
      );
    }
    const selectedPageIds = new Set(base.selectedPages);
    const seenComparisonPageIds = new Set();
    for (const pageId of settings.comparisonPages) {
      if (typeof pageId !== 'string' || pageId.length === 0) {
        throw new TypeError(
          'Differential expression comparison page IDs must be non-empty strings'
        );
      }
      if (!selectedPageIds.has(pageId)) {
        throw new Error(
          `Differential expression comparison page "${pageId}" is not selected`
        );
      }
      if (seenComparisonPageIds.has(pageId)) {
        throw new TypeError(
          `Differential expression comparison page "${pageId}" is duplicated`
        );
      }
      seenComparisonPageIds.add(pageId);
    }
    const geneListModes = new Set([
      'all',
      'top5',
      'top10',
      'top20',
      'top100'
    ]);
    if (!geneListModes.has(settings.modalGeneListMode)) {
      throw new TypeError(
        'Differential expression modalGeneListMode is unsupported'
      );
    }
    if (
      base.formControls.method?.type !== 'value' ||
      (
        base.formControls.method.value !== 'ttest' &&
        base.formControls.method.value !== 'wilcox'
      )
    ) {
      throw new TypeError(
        'Differential expression method control is unsupported'
      );
    }

    this._comparisonPages = [...settings.comparisonPages];
    this._modalGeneListMode = settings.modalGeneListMode;
    this._applyFormSettings(base);
  }
}

/**
 * Factory function to create DE analysis UI
 * @param {Object} options
 * @returns {DEAnalysisUI}
 */
export function createDEAnalysisUI(options) {
  const ui = new DEAnalysisUI(options);
  ui.init(options.container);
  return ui;
}
