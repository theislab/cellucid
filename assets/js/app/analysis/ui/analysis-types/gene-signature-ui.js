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
import {
  isFiniteNumber,
  mean,
  std,
  median,
  filterFiniteNumbers
} from '../../shared/number-utils.js';
import { purgePlot } from '../../plots/plotly-loader.js';

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
      name: 'genes',
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
    if (formValues.normalize !== 'none') {
      this._normalizeResults(signatureResults, formValues.normalize);
    }

    // Format for visualization
    return {
      type: 'signature',
      plotType: formValues.plotType,
      data: signatureResults.map(sr => ({
        pageId: sr.pageId,
        pageName: sr.pageName,
        // Keep raw scores to avoid duplicating large arrays; plots/stats filter as needed.
        values: sr.scores,
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
      // Z-score normalization across all values (streaming; avoids huge temporary arrays)
      let count = 0;
      let meanVal = 0;
      let m2 = 0;

      for (const r of results) {
        const scores = r?.scores || [];
        for (let i = 0; i < scores.length; i++) {
          const x = scores[i];
          if (!isFiniteNumber(x)) continue;
          count++;
          const delta = x - meanVal;
          meanVal += delta / count;
          const delta2 = x - meanVal;
          m2 += delta * delta2;
        }
      }

      if (count === 0) return results;
      const stdVal = Math.sqrt(m2 / count);
      const denom = stdVal || 1;

      for (const r of results) {
        const scores = r?.scores || [];
        for (let i = 0; i < scores.length; i++) {
          const x = scores[i];
          scores[i] = isFiniteNumber(x) ? (x - meanVal) / denom : NaN;
        }
      }

      return results;
    } else if (method === 'minmax') {
      // Min-max normalization
      let min = Infinity;
      let max = -Infinity;
      let count = 0;

      for (const r of results) {
        const scores = r?.scores || [];
        for (let i = 0; i < scores.length; i++) {
          const x = scores[i];
          if (!isFiniteNumber(x)) continue;
          count++;
          if (x < min) min = x;
          if (x > max) max = x;
        }
      }

      if (count === 0) return results;
      const range = (max - min) || 1;

      for (const r of results) {
        const scores = r?.scores || [];
        for (let i = 0; i < scores.length; i++) {
          const x = scores[i];
          scores[i] = isFiniteNumber(x) ? (x - min) / range : NaN;
        }
      }

      return results;
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
    // Purge any existing plots to prevent WebGL memory leaks
    purgePlot(this._resultContainer.querySelector('.analysis-preview-plot'));
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
    const plotContainerId = this._instanceId ? `${this._instanceId}-signature-analysis-plot` : 'signature-analysis-plot';
    plotContainer.id = plotContainerId;
    this._plotContainerId = plotContainerId;
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

    // Compute stats for each page using centralized utilities
    const statsRows = pageData.map(pd => {
      const values = filterFiniteNumbers(pd.values);
      const n = values.length;
      if (n === 0) return `<tr><td>${pd.pageName}</td><td colspan="4">No valid values</td></tr>`;

      const meanVal = mean(values);
      const medianVal = median(values);
      const stdVal = std(values);

      return `
        <tr>
          <td>${pd.pageName}</td>
          <td>${meanVal.toFixed(3)}</td>
          <td>${medianVal.toFixed(3)}</td>
          <td>${stdVal.toFixed(3)}</td>
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
    const plotEl = this._plotContainerId ? document.getElementById(this._plotContainerId) : null;
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
