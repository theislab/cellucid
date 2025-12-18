/**
 * Gene Signature Score UI Component
 *
 * Provides gene signature scoring functionality:
 * - Custom gene list input
 * - Multiple scoring methods (mean, sum, median)
 * - Normalization options (z-score, min-max)
 * - Distribution visualization (violin/box/histogram)
 *
 * Extends FormBasedAnalysisUI for form + results pattern.
 */

import { FormBasedAnalysisUI } from './base/form-based-analysis.js';
import { PlotRegistry } from '../../shared/plot-registry-utils.js';
import {
  createFormRow,
  createFormSelect,
  createFormTextarea,
  createResultHeader
} from '../../shared/dom-utils.js';
import {
  signatureScoresToCSV,
  downloadCSV
} from '../../shared/analysis-utils.js';
import {
  renderSignatureSummaryStats,
  renderGeneChips
} from '../../shared/result-renderer.js';
import { getFiniteMinMax } from '../../shared/number-utils.js';

/**
 * Gene Signature Score UI Component
 * @extends FormBasedAnalysisUI
 */
export class GeneSignatureUI extends FormBasedAnalysisUI {
  // ===========================================================================
  // Required Abstract Method Implementations
  // ===========================================================================

  /**
   * Get page requirements for gene signature
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
   * Get the analysis title
   * @returns {string}
   */
  _getTitle() {
    return 'Gene Signature Score';
  }

  /**
   * Get the analysis description
   * @returns {string}
   */
  _getDescription() {
    return 'Compute and compare a gene signature score across pages.';
  }

  /**
   * Get CSS class prefix
   * @returns {string}
   */
  _getClassName() {
    return 'gene-signature';
  }

  /**
   * Get loading notification message
   * @returns {string}
   */
  _getLoadingMessage() {
    const genes = this._getGeneList();
    return `Computing signature score (${genes.length} genes)...`;
  }

  /**
   * Get success notification message
   * @returns {string}
   */
  _getSuccessMessage() {
    return 'Signature scoring complete';
  }

  /**
   * Get run button text
   * @returns {string}
   */
  _getRunButtonText() {
    return 'Compute Signature Score';
  }

  /**
   * Render form-specific controls
   * @param {HTMLElement} wrapper - Form wrapper element
   */
  _renderFormControls(wrapper) {
    // Gene list input
    const geneListRow = document.createElement('div');
    geneListRow.className = 'analysis-input-row gene-list-row';
    geneListRow.innerHTML = `<label>Signature Genes:</label>`;

    const geneListInput = createFormTextarea({
      className: 'gene-list-input',
      placeholder: 'Enter genes (comma-separated):\nCD3E, CD4, CD8A, FOXP3...',
      rows: 4
    });
    geneListRow.appendChild(geneListInput);
    wrapper.appendChild(geneListRow);

    // Method selector
    const methodSelect = createFormSelect('method', [
      { value: 'mean', label: 'Mean expression', selected: true },
      { value: 'sum', label: 'Sum expression' },
      { value: 'median', label: 'Median expression' }
    ]);
    wrapper.appendChild(createFormRow('Scoring method:', methodSelect));

    // Normalization
    const normalizeSelect = createFormSelect('normalize', [
      { value: 'none', label: 'None', selected: true },
      { value: 'zscore', label: 'Z-score' },
      { value: 'minmax', label: 'Min-Max (0-1)' }
    ]);
    wrapper.appendChild(createFormRow('Normalization:', normalizeSelect));

    // Plot type
    const plotTypeSelect = createFormSelect('plotType', [
      { value: 'violinplot', label: 'Violin plot', selected: true },
      { value: 'boxplot', label: 'Box plot' },
      { value: 'histogram', label: 'Histogram' }
    ]);
    wrapper.appendChild(createFormRow('Visualization:', plotTypeSelect));
  }

  /**
   * Get the gene list from textarea
   * @private
   * @returns {string[]}
   */
  _getGeneList() {
    const form = this._formContainer?.querySelector('.analysis-form');
    const geneListInput = form?.querySelector('.gene-list-input');
    if (!geneListInput) return [];

    return geneListInput.value
      .split(',')
      .map(g => g.trim())
      .filter(g => g);
  }

  /**
   * Extract form values
   * @returns {Object}
   */
  _getFormValues() {
    const form = this._formContainer.querySelector('.analysis-form');
    return {
      genes: this._getGeneList(),
      method: form.querySelector('[name="method"]').value,
      normalize: form.querySelector('[name="normalize"]').value,
      plotType: form.querySelector('[name="plotType"]').value
    };
  }

  /**
   * Validate form values
   * @param {Object} formValues
   * @returns {{ valid: boolean, error?: string }}
   */
  _validateForm(formValues) {
    if (!formValues.genes || formValues.genes.length === 0) {
      return { valid: false, error: 'Please enter at least one gene' };
    }
    return { valid: true };
  }

  /**
   * Run the gene signature analysis
   * @param {Object} formValues - Form values
   * @returns {Promise<Object>} Analysis result
   */
  async _runAnalysisImpl(formValues) {
    // Compute signature scores
    const signatureResults = await this.multiVariableAnalysis.computeSignatureScore({
      genes: formValues.genes,
      pageIds: this._selectedPages,
      method: formValues.method || 'mean'
    });

    // Apply normalization if requested
    let processedResults = signatureResults;
    if (formValues.normalize !== 'none') {
      processedResults = this._normalizeResults(signatureResults, formValues.normalize);
    }

    // Format for visualization
    return {
      type: 'signature',
      plotType: formValues.plotType,
      data: processedResults.map(sr => ({
        pageId: sr.pageId,
        pageName: sr.pageName,
        values: sr.scores.filter(s => Number.isFinite(s)),
        variableInfo: { name: 'Signature Score', kind: 'continuous' }
      })),
      options: {
        showPoints: 'outliers',
        showMean: true
      },
      title: 'Gene Signature Score',
      subtitle: `${formValues.genes.length} genes: ${formValues.genes.slice(0, 5).join(', ')}${formValues.genes.length > 5 ? '...' : ''}`,
      metadata: {
        genes: formValues.genes,
        method: formValues.method,
        normalize: formValues.normalize
      }
    };
  }

  // ===========================================================================
  // Normalization
  // ===========================================================================

  /**
   * Normalize results
   * @param {Object[]} results
   * @param {string} method
   * @returns {Object[]}
   */
  _normalizeResults(results, method) {
    if (method === 'zscore') {
      // Z-score normalization across all values
      const allScores = results.flatMap(r => r.scores.filter(s => Number.isFinite(s)));
      if (allScores.length === 0) return results;
      const mean = allScores.reduce((a, b) => a + b, 0) / allScores.length;
      const std = Math.sqrt(allScores.reduce((a, b) => a + (b - mean) ** 2, 0) / allScores.length);

      return results.map(r => ({
        ...r,
        scores: r.scores.map(s => Number.isFinite(s) ? (s - mean) / (std || 1) : NaN)
      }));
    } else if (method === 'minmax') {
      // Min-max normalization
      const allScores = results.flatMap(r => r.scores.filter(s => Number.isFinite(s)));
      const { min, max, count } = getFiniteMinMax(allScores);
      if (count === 0) return results;
      const range = max - min || 1;

      return results.map(r => ({
        ...r,
        scores: r.scores.map(s => Number.isFinite(s) ? (s - min) / range : NaN)
      }));
    }

    return results;
  }

  // ===========================================================================
  // Custom Result Rendering
  // ===========================================================================

  /**
   * Show analysis result with signature-specific visualization
   * @param {Object} result - Analysis result
   */
  async _showResult(result) {
    this._resultContainer.classList.remove('hidden');
    this._resultContainer.innerHTML = '';

    // Result header
    const header = createResultHeader(result.title, result.subtitle);
    this._resultContainer.appendChild(header);

    // Plot container
    const previewContainer = document.createElement('div');
    previewContainer.className = 'analysis-preview-container';
    this._resultContainer.appendChild(previewContainer);

    const plotContainer = document.createElement('div');
    plotContainer.className = 'analysis-preview-plot';
    plotContainer.id = 'signature-analysis-plot';
    this._plotContainerId = 'signature-analysis-plot';
    previewContainer.appendChild(plotContainer);

    // Render plot
    const plotDef = PlotRegistry.get(result.plotType);
    if (plotDef) {
      try {
        const mergedOptions = PlotRegistry.mergeOptions(result.plotType, result.options || {});
        await plotDef.render(result.data, mergedOptions, plotContainer, null);
      } catch (err) {
        console.error('[GeneSignatureUI] Plot render error:', err);
        plotContainer.innerHTML = `<div class="plot-error">Failed to render plot: ${err.message}</div>`;
      }
    }

    // Expand (modal) action - lower right
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'analysis-actions';
    actionsContainer.style.display = 'flex';

    const expandBtn = this._createExpandButton();
    expandBtn.title = 'Open in full view with statistics and export options';
    actionsContainer.appendChild(expandBtn);
    this._resultContainer.appendChild(actionsContainer);

    // Summary statistics
    renderSignatureSummaryStats(this._resultContainer, result.data);

    // Gene list
    if (result.metadata?.genes) {
      renderGeneChips(this._resultContainer, result.metadata.genes, {
        title: `Genes in Signature (${result.metadata.genes.length})`
      });
    }
  }

  // ===========================================================================
  // Modal Rendering - Overrides from FormBasedAnalysisUI
  // ===========================================================================

  /**
   * Render signature statistics in modal
   * @param {HTMLElement} container - Modal stats container
   */
  _renderModalStats(container) {
    const result = this._lastResult;
    const pageData = result?.data;

    if (!pageData || pageData.length === 0) {
      container.innerHTML = '<p class="modal-stats-placeholder">Statistics not available</p>';
      return;
    }

    // Compute stats for each page
    const statsRows = pageData.map(pd => {
      const values = pd.values.filter(v => typeof v === 'number' && Number.isFinite(v));
      const n = values.length;
      if (n === 0) return `<tr><td>${pd.pageName}</td><td colspan="4">No valid values</td></tr>`;

      const mean = values.reduce((a, b) => a + b, 0) / n;
      const sorted = [...values].sort((a, b) => a - b);
      const median = n % 2 === 0 ? (sorted[n/2-1] + sorted[n/2]) / 2 : sorted[Math.floor(n/2)];
      const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);

      return `
        <tr>
          <td>${pd.pageName}</td>
          <td>${mean.toFixed(3)}</td>
          <td>${median.toFixed(3)}</td>
          <td>${std.toFixed(3)}</td>
          <td>${n.toLocaleString()}</td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <h5>Summary Statistics</h5>
      <table class="analysis-stats-table signature-modal-stats">
        <thead>
          <tr>
            <th>Page</th>
            <th>Mean</th>
            <th>Median</th>
            <th>Std</th>
            <th>Cells</th>
          </tr>
        </thead>
        <tbody>
          ${statsRows}
        </tbody>
      </table>
    `;
  }

  /**
   * Render signature annotations in modal (gene list)
   * @param {HTMLElement} container - Modal annotations container
   */
  _renderModalAnnotations(container) {
    const result = this._lastResult;
    const genes = result?.metadata?.genes;

    if (!genes || genes.length === 0) {
      container.innerHTML = '<p class="modal-annotations-placeholder">No genes in signature</p>';
      return;
    }

    container.innerHTML = `
      <h5>Genes in Signature (${genes.length})</h5>
      <div class="gene-chips modal-gene-chips">
        ${genes.map(g => `<span class="gene-chip">${g}</span>`).join('')}
      </div>
    `;
  }

  /**
   * Export signature results as CSV from modal
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
    const plotEl = document.getElementById('signature-analysis-plot');
    if (!plotEl) return;

    await this._exportPNG(plotEl, {
      filename: 'gene_signature_score',
      width: 1200,
      height: 800
    });
  }

  /**
   * Export results as CSV (signature-specific format)
   */
  _exportResultsCSV() {
    if (!this._lastResult?.data) return;

    const csv = signatureScoresToCSV(this._lastResult.data);
    downloadCSV(csv, 'gene_signature_scores', this._notifications);
  }
}

/**
 * Factory function to create gene signature UI
 * @param {Object} options
 * @returns {GeneSignatureUI}
 */
export function createGeneSignatureUI(options) {
  return new GeneSignatureUI(options);
}

export default GeneSignatureUI;
