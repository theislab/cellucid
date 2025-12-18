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
      minPages: 2,
      maxPages: null, // Allow any number of pages; user selects which 2 to compare
      description: 'Select at least 2 pages'
    };
  }

  /**
   * @param {Object} options
   */
  constructor(options) {
    super(options);

    // Track which two pages are selected for comparison
    this._comparisonPages = [];

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
      pages: availablePages.length >= 2 ? availablePages : pages,
      selectedIds: this._comparisonPages.length === 2 ? this._comparisonPages : this._selectedPages.slice(0, 2),
      onChange: this._handleComparisonChange
    });
    wrapper.appendChild(pageSelector);

    // Gene count selector
    const geneCountSelect = createFormSelect('geneCount', [
      { value: '50', label: 'Top 50 genes' },
      { value: '100', label: 'Top 100 genes', selected: true },
      { value: '250', label: 'Top 250 genes' },
      { value: '500', label: 'Top 500 genes' },
      { value: '-1', label: 'All genes (slow)' }
    ]);
    wrapper.appendChild(createFormRow('Number of genes to test:', geneCountSelect));

    // Method selector
    const methodSelect = createFormSelect('method', [
      { value: 'wilcox', label: 'Wilcoxon (recommended)', selected: true },
      { value: 'ttest', label: 't-test' }
    ]);
    wrapper.appendChild(createFormRow('Statistical method:', methodSelect));

    // P-value threshold
    const pValueSelect = createFormSelect('pValueThreshold', [
      { value: '0.001', label: 'p < 0.001' },
      { value: '0.01', label: 'p < 0.01' },
      { value: '0.05', label: 'p < 0.05', selected: true }
    ]);
    wrapper.appendChild(createFormRow('Significance threshold:', pValueSelect));

    // Fold change threshold
    const fcSelect = createFormSelect('fcThreshold', [
      { value: '0', label: 'No threshold' },
      { value: '0.5', label: '|log2FC| > 0.5' },
      { value: '1', label: '|log2FC| > 1', selected: true },
      { value: '2', label: '|log2FC| > 2' }
    ]);
    wrapper.appendChild(createFormRow('Log2 fold change threshold:', fcSelect));
  }

  /**
   * Extract form values
   * @returns {Object}
   */
  _getFormValues() {
    const form = this._formContainer.querySelector('.analysis-form');
    return {
      geneCount: parseInt(form.querySelector('[name="geneCount"]').value, 10),
      method: form.querySelector('[name="method"]').value,
      pValueThreshold: parseFloat(form.querySelector('[name="pValueThreshold"]').value),
      fcThreshold: parseFloat(form.querySelector('[name="fcThreshold"]').value)
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

    // Get gene list
    const allGenes = this.dataLayer.getAvailableVariables('gene_expression');
    const geneList = formValues.geneCount === -1
      ? null
      : allGenes.slice(0, formValues.geneCount).map(g => g.key);

    // Run differential expression
    const deResults = await this.multiVariableAnalysis.differentialExpression({
      pageA,
      pageB,
      geneList,
      method: formValues.method || 'wilcox'
    });

    const pValueThreshold = Number.isFinite(formValues.pValueThreshold)
      ? formValues.pValueThreshold
      : 0.05;
    const foldChangeThreshold = Number.isFinite(formValues.fcThreshold)
      ? formValues.fcThreshold
      : 1.0;

    return {
      type: 'differential',
      plotType: 'volcanoplot',
      data: deResults,
      options: {
        pValueThreshold,
        foldChangeThreshold,
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
    this._resultContainer.innerHTML = '';

    // Volcano plot container - directly under the run button, no header
    const previewContainer = document.createElement('div');
    previewContainer.className = 'analysis-preview-container';
    this._resultContainer.appendChild(previewContainer);

    const plotContainer = document.createElement('div');
    plotContainer.className = 'analysis-preview-plot';
    plotContainer.id = 'de-analysis-plot';
    this._plotContainerId = 'de-analysis-plot';
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
   * @param {HTMLElement} container - Modal stats container
   */
  _renderModalStats(container) {
    const result = this._lastResult;
    const summary = result?.data?.summary;

    if (!summary) {
      container.innerHTML = '<p class="modal-stats-placeholder">Statistics not available</p>';
      return;
    }

    container.innerHTML = `
      <h5>Summary Statistics</h5>
      <table class="analysis-stats-table de-modal-stats">
        <tr>
          <td>Genes Tested</td>
          <td><strong>${summary.totalGenes?.toLocaleString() || 'N/A'}</strong></td>
        </tr>
        <tr>
          <td>Significant Genes (FDR < 0.05)</td>
          <td class="significant"><strong>${summary.significantGenes?.toLocaleString() || 'N/A'}</strong></td>
        </tr>
        <tr>
          <td>Upregulated</td>
          <td class="up"><strong>${summary.upregulated?.toLocaleString() || 'N/A'}</strong></td>
        </tr>
        <tr>
          <td>Downregulated</td>
          <td class="down"><strong>${summary.downregulated?.toLocaleString() || 'N/A'}</strong></td>
        </tr>
        ${summary.meanExpression !== undefined ? `
        <tr>
          <td>Mean Expression (A)</td>
          <td><strong>${summary.meanExpressionA?.toFixed(3) || 'N/A'}</strong></td>
        </tr>
        <tr>
          <td>Mean Expression (B)</td>
          <td><strong>${summary.meanExpressionB?.toFixed(3) || 'N/A'}</strong></td>
        </tr>
        ` : ''}
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

    const {
      pValueThreshold = 0.05,
      foldChangeThreshold = 1.0,
      useAdjustedPValue = true
    } = options;

    const getPValue = (row) => {
      if (!row) return null;
      const raw = useAdjustedPValue ? (row.adjustedPValue ?? row.pValue) : row.pValue;
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    };

    const passesThresholds = (row) => {
      const p = getPValue(row);
      if (p === null) return false;
      if (p >= pValueThreshold) return false;

      const fc = row?.log2FoldChange;
      if (typeof fc !== 'number' || !Number.isFinite(fc)) return false;
      return Math.abs(fc) >= foldChangeThreshold;
    };

    // Get top 10 significant genes (based on active plot thresholds)
    const topGenes = results
      .filter(passesThresholds)
      .sort((a, b) => Math.abs(b.log2FoldChange) - Math.abs(a.log2FoldChange))
      .slice(0, 10);

    if (topGenes.length === 0) {
      container.innerHTML = `
        <p class="modal-annotations-placeholder">
          No genes passed the current thresholds (p &lt; ${pValueThreshold}, |log2FC| ≥ ${foldChangeThreshold}).
        </p>
      `;
      return;
    }

    container.innerHTML = `
      <h5>Top Differentially Expressed Genes</h5>
      <table class="de-genes-table modal-de-genes">
        <thead>
          <tr>
            <th>Gene</th>
            <th>Log2 FC</th>
            <th>${useAdjustedPValue ? 'Adj. P-value' : 'P-value'}</th>
          </tr>
        </thead>
        <tbody>
          ${topGenes.map(g => `
            <tr class="${g.log2FoldChange > 0 ? 'up' : 'down'}">
              <td class="gene-name">${g.gene}</td>
              <td>${g.log2FoldChange.toFixed(3)}</td>
              <td>${(() => {
                const p = getPValue(g);
                if (p === null) return 'N/A';
                if (p < 0.001) return '<0.001';
                return p.toFixed(4);
              })()}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
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
    const plotEl = document.getElementById('de-analysis-plot');
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
