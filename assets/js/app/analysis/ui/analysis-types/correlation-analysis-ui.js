/**
 * Correlation Analysis UI Component
 *
 * Goals:
 * - Match the `Detailed` variable selection mechanism (continuous obs + gene expression selector)
 * - Stack X and Y selectors vertically (not side-by-side)
 * - Use the centralized compute pipeline (MultiVariableAnalysis.correlationAnalysis)
 * - Render via PlotRegistry's `scatterplot`
 * - Use the standard figure modal grid with interactive plot options
 */

import { FormBasedAnalysisUI } from './base/form-based-analysis.js';
import { PlotRegistry } from '../../shared/plot-registry-utils.js';
import {
  createFormRow,
  createFormSelect,
  createResultHeader
} from '../../shared/dom-utils.js';
import { correlationResultsToCSV, downloadCSV } from '../../shared/analysis-utils.js';
import { createVariableSelectorComponent } from '../shared/variable-selector.js';

/**
 * @typedef {{ type: 'continuous_obs'|'gene_expression', key: string }} CorrelationVariable
 * @typedef {{ variableX: CorrelationVariable|null, variableY: CorrelationVariable|null, method: 'pearson'|'spearman' }} CorrelationFormValues
 */

export class CorrelationAnalysisUI extends FormBasedAnalysisUI {
  static getRequirements() {
    return {
      minPages: 1,
      maxPages: null,
      description: 'Select at least 1 page'
    };
  }

  _getTitle() {
    return 'Correlation';
  }

  _getDescription() {
    return 'Compute correlation between two variables across selected pages.';
  }

  _getClassName() {
    return 'correlation-analysis';
  }

  _getLoadingMessage() {
    return 'Computing correlation...';
  }

  _getSuccessMessage() {
    return 'Correlation analysis complete';
  }

  _getRunButtonText() {
    return 'Compute Correlation';
  }

  constructor(options) {
    super(options);

    this._xSelector = null;
    this._ySelector = null;
  }

  /**
   * Render form-specific controls
   * @param {HTMLElement} wrapper
   */
  _renderFormControls(wrapper) {
    // X axis variable selector
    const xContainer = document.createElement('div');
    xContainer.className = 'control-block';
    wrapper.appendChild(xContainer);

    this._xSelector?.destroy?.();
    this._xSelector = createVariableSelectorComponent({
      dataLayer: this.dataLayer,
      container: xContainer,
      allowedTypes: ['continuous', 'gene'],
      idPrefix: 'correlation-x',
      typeLabel: 'X Axis Variable:',
      onVariableChange: () => this._hideStaleResult()
    });

    // Y axis variable selector
    const yContainer = document.createElement('div');
    yContainer.className = 'control-block';
    wrapper.appendChild(yContainer);

    this._ySelector?.destroy?.();
    this._ySelector = createVariableSelectorComponent({
      dataLayer: this.dataLayer,
      container: yContainer,
      allowedTypes: ['continuous', 'gene'],
      idPrefix: 'correlation-y',
      typeLabel: 'Y Axis Variable:',
      onVariableChange: () => this._hideStaleResult()
    });

    // Correlation method selector
    const methodSelect = createFormSelect('method', [
      { value: 'pearson', label: 'Pearson (linear)', selected: true },
      { value: 'spearman', label: 'Spearman (rank)' }
    ]);
    wrapper.appendChild(createFormRow('Correlation method:', methodSelect));
  }

  /**
   * Hide results when inputs change (prevents stale plot/stat interpretation).
   * @private
   */
  _hideStaleResult() {
    if (this._resultContainer) {
      this._resultContainer.classList.add('hidden');
    }
  }

  /**
   * Extract form values
   * @returns {CorrelationFormValues}
   */
  _getFormValues() {
    const form = this._formContainer.querySelector('.analysis-form');
    const method = form.querySelector('[name="method"]')?.value || 'pearson';

    const xSel = this._xSelector?.getSelectedVariable?.() || { type: '', variable: '' };
    const ySel = this._ySelector?.getSelectedVariable?.() || { type: '', variable: '' };

    const variableX = xSel.type && xSel.variable ? { type: xSel.type, key: xSel.variable } : null;
    const variableY = ySel.type && ySel.variable ? { type: ySel.type, key: ySel.variable } : null;

    return {
      variableX,
      variableY,
      method
    };
  }

  _validateForm(formValues) {
    if (!formValues.variableX) {
      return { valid: false, error: 'Please select an X axis variable' };
    }
    if (!formValues.variableY) {
      return { valid: false, error: 'Please select a Y axis variable' };
    }
    if (formValues.variableX.key === formValues.variableY.key &&
        formValues.variableX.type === formValues.variableY.type) {
      return { valid: false, error: 'X and Y variables must be different' };
    }
    return { valid: true };
  }

  /**
   * Run the correlation analysis
   * @param {CorrelationFormValues} formValues
   */
  async _runAnalysisImpl(formValues) {
    if (!this.multiVariableAnalysis?.correlationAnalysis) {
      throw new Error('Correlation analysis module not available');
    }

    const correlationResults = await this.multiVariableAnalysis.correlationAnalysis({
      varX: formValues.variableX,
      varY: formValues.variableY,
      pageIds: this._selectedPages,
      method: formValues.method || 'pearson'
    });

    return {
      type: 'correlation',
      plotType: 'scatterplot',
      data: correlationResults,
      options: {
        showTrendline: true,
        showR2: true,
        showConfidenceInterval: true
      },
      title: 'Correlation',
      subtitle: `${formValues.variableX.key} vs ${formValues.variableY.key}`,
      metadata: {
        method: formValues.method || 'pearson',
        variableX: formValues.variableX,
        variableY: formValues.variableY
      }
    };
  }

  // ===========================================================================
  // Custom Result Rendering
  // ===========================================================================

  async _showResult(result) {
    this._resultContainer.classList.remove('hidden');
    this._resultContainer.innerHTML = '';

    const header = createResultHeader(result.title, result.subtitle);
    this._resultContainer.appendChild(header);

    // Plot container (use the same base styling as the Detailed preview)
    const previewContainer = document.createElement('div');
    previewContainer.className = 'analysis-preview-container';
    this._resultContainer.appendChild(previewContainer);

    const plotContainer = document.createElement('div');
    plotContainer.className = 'analysis-preview-plot';
    plotContainer.id = 'correlation-analysis-plot';
    this._plotContainerId = 'correlation-analysis-plot';
    previewContainer.appendChild(plotContainer);

    const plotDef = PlotRegistry.get(result.plotType);
    if (plotDef) {
      try {
        const mergedOptions = PlotRegistry.mergeOptions(result.plotType, result.options || {});
        await plotDef.render(result.data, mergedOptions, plotContainer, null);
      } catch (err) {
        console.error('[CorrelationAnalysisUI] Plot render error:', err);
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
  }

  // ===========================================================================
  // Modal Rendering - Overrides from FormBasedAnalysisUI
  // ===========================================================================

  _renderModalStats(container) {
    const results = this._lastResult?.data;
    if (!Array.isArray(results) || results.length === 0) {
      container.innerHTML = '<p class="modal-stats-placeholder">Statistics not available</p>';
      return;
    }

    const rows = results.map(r => {
      const hasError = !!r.error;
      const rVal = typeof r.r === 'number' && Number.isFinite(r.r) ? r.r.toFixed(4) : 'N/A';
      const r2Val = typeof r.rSquared === 'number' && Number.isFinite(r.rSquared) ? r.rSquared.toFixed(4) : 'N/A';
      const pVal = typeof r.pValue === 'number' && Number.isFinite(r.pValue) ? r.pValue.toExponential(3) : 'N/A';
      const nVal = typeof r.n === 'number' ? r.n.toLocaleString() : (Array.isArray(r.xValues) ? r.xValues.length.toLocaleString() : 'N/A');

      return `
        <tr>
          <td>${r.pageName || 'Page'}</td>
          <td>${hasError ? '—' : rVal}</td>
          <td>${hasError ? '—' : r2Val}</td>
          <td class="${!hasError && r.pValue < 0.05 ? 'significant' : ''}">${hasError ? '—' : pVal}</td>
          <td>${hasError ? '—' : nVal}</td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <table class="analysis-stats-table">
        <thead>
          <tr>
            <th>Page</th>
            <th>r</th>
            <th>r²</th>
            <th>p</th>
            <th>n</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `;
  }

  _renderModalAnnotations(container) {
    const results = this._lastResult?.data;
    if (!Array.isArray(results) || results.length === 0) {
      container.innerHTML = '<p class="modal-annotations-placeholder">No correlation results</p>';
      return;
    }

    const rows = results
      .filter(r => !r.error && typeof r.r === 'number' && Number.isFinite(r.r))
      .map(r => {
        const absR = Math.abs(r.r);
        let strengthLabel, strengthClass;
        if (absR >= 0.8) {
          strengthLabel = 'Very Strong';
          strengthClass = 'very-strong';
        } else if (absR >= 0.6) {
          strengthLabel = 'Strong';
          strengthClass = 'strong';
        } else if (absR >= 0.4) {
          strengthLabel = 'Moderate';
          strengthClass = 'moderate';
        } else if (absR >= 0.2) {
          strengthLabel = 'Weak';
          strengthClass = 'weak';
        } else {
          strengthLabel = 'Very Weak / None';
          strengthClass = 'none';
        }

        const direction = r.r > 0 ? 'Positive' : r.r < 0 ? 'Negative' : 'None';
        const directionClass = r.r > 0 ? 'up' : r.r < 0 ? 'down' : '';

        return `
          <tr>
            <td>${r.pageName || 'Page'}</td>
            <td><strong class="${directionClass}">${direction}</strong></td>
            <td><strong class="correlation-${strengthClass}">${strengthLabel}</strong></td>
            <td><strong>${r.r.toFixed(3)}</strong></td>
          </tr>
        `;
      })
      .join('');

    const method = this._lastResult?.metadata?.method || 'pearson';

    container.innerHTML = `
      <table class="analysis-stats-table correlation-interpretation">
        <thead>
          <tr>
            <th>Page</th>
            <th>Direction</th>
            <th>Strength</th>
            <th>r</th>
          </tr>
        </thead>
        <tbody>
          ${rows || `<tr><td colspan="4">No valid correlation values</td></tr>`}
        </tbody>
      </table>
      <p class="interpretation-note">
        Interpreting ${method} correlation: |r| ≥ 0.8 (very strong), ≥ 0.6 (strong), ≥ 0.4 (moderate), ≥ 0.2 (weak).
      </p>
    `;
  }

  _exportModalCSV() {
    this._exportResultsCSV();
  }

  // ===========================================================================
  // Export Helpers
  // ===========================================================================

  async _exportPlotPNG() {
    const plotEl = document.getElementById('correlation-analysis-plot');
    if (!plotEl) return;

    await this._exportPNG(plotEl, {
      filename: 'correlation',
      width: 1200,
      height: 800
    });
  }

  _exportResultsCSV() {
    const results = this._lastResult?.data;
    if (!Array.isArray(results) || results.length === 0) return;

    const csv = correlationResultsToCSV(results, this._lastResult?.metadata || {});
    downloadCSV(csv, 'correlation_results', this._notifications);
  }

  destroy() {
    this._xSelector?.destroy?.();
    this._ySelector?.destroy?.();
    this._xSelector = null;
    this._ySelector = null;
    super.destroy();
  }
}

export function createCorrelationAnalysisUI(options) {
  return new CorrelationAnalysisUI(options);
}

export default CorrelationAnalysisUI;
