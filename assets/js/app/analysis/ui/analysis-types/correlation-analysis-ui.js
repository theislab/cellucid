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
  NONE_VALUE
} from '../../shared/dom-utils.js';
import { correlationResultsToCSV, downloadCSV } from '../../shared/analysis-utils.js';
import { createVariableSelectorComponent } from '../shared/variable-selector.js';
import { PageSelectorComponent } from '../shared/page-selector.js';
import { purgePlot } from '../../plots/plotly-loader.js';
import { isFiniteNumber } from '../../shared/number-utils.js';

/**
 * @typedef {{ type: 'continuous_obs'|'gene_expression', key: string }} CorrelationVariable
 * @typedef {{ variableX: CorrelationVariable|null, variableY: CorrelationVariable|null, method: 'pearson'|'spearman' }} CorrelationFormValues
 */

export class CorrelationAnalysisUI extends FormBasedAnalysisUI {
  static getRequirements() {
    return {
      // Correlation has its own internal page selector; don't block rendering
      // when the global page selection is empty.
      minPages: 0,
      maxPages: null,
      description: 'Select pages to analyze'
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

  constructor(options) {
    super(options);

    this._xSelector = null;
    this._ySelector = null;

    this._xIdPrefix = this._instanceId ? `${this._instanceId}-correlation-x` : 'correlation-x';
    this._yIdPrefix = this._instanceId ? `${this._instanceId}-correlation-y` : 'correlation-y';
    this._plotContainerIdBase = this._instanceId ? `${this._instanceId}-correlation-analysis-plot` : 'correlation-analysis-plot';

    // Page selector component
    this._pageSelector = null;
    this._pageSelectContainer = null;

    // Color by categorical variable
    this._colorByVariable = null;

  }

  // ===========================================================================
  // Page Selection Handlers
  // ===========================================================================

  _handlePageChange = (pageIds) => {
    this._selectedPages = pageIds || [];
    this._currentConfig.pages = this._selectedPages;
    // Trigger auto-update (like detailed mode)
    this._scheduleUpdate();
  };

  _handlePageColorChange = (pageId, color) => {
    this.dataLayer?.setPageColor?.(pageId, color);
    // Trigger auto-update to reflect color changes
    this._scheduleUpdate();
  };

  // ===========================================================================
  // Auto-calculation Logic (like Detailed mode)
  // ===========================================================================

  /**
   * Override _canRunAnalysis to check for X and Y variables
   * @override
   */
  _canRunAnalysis() {
    const xSel = this._xSelector?.getSelectedVariable?.() || { type: '', variable: '' };
    const ySel = this._ySelector?.getSelectedVariable?.() || { type: '', variable: '' };
    return (
      xSel.type && xSel.variable &&
      ySel.type && ySel.variable &&
      this._selectedPages.length > 0
    );
  }

  /**
   * Override to run analysis automatically when inputs are valid
   * @override
   */
  async _runAnalysisIfValid() {
    if (this._isDestroyed) return;
    if (!this._canRunAnalysis()) {
      this._hideResult();
      return;
    }

    // Validate that X and Y are different
    const formValues = this._getFormValues();
    if (formValues.variableX?.key === formValues.variableY?.key &&
        formValues.variableX?.type === formValues.variableY?.type) {
      this._hideResult();
      return;
    }

    try {
      this._isLoading = true;
      const result = await this._runAnalysisImpl(formValues);

      if (this._isDestroyed) return;
      if (result) {
        this._lastResult = result;
        this._currentPageData = result.data || result;
        await this._showResult(result);
      }
    } catch (err) {
      console.error('[CorrelationAnalysisUI] Analysis failed:', err);
      this._showError('Analysis failed: ' + err.message);
    } finally {
      this._isLoading = false;
    }
  }

  /**
   * Hide result container
   */
  _hideResult() {
    if (this._resultContainer) {
      purgePlot(this._resultContainer.querySelector('.analysis-preview-plot'));
      this._resultContainer.innerHTML = '';
      this._resultContainer.classList.add('hidden');
    }
    this._lastResult = null;
  }

  /**
   * Show error message
   */
  _showError(message) {
    if (this._resultContainer) {
      this._resultContainer.classList.remove('hidden');
      this._resultContainer.innerHTML = '';
      const errorEl = document.createElement('div');
      errorEl.className = 'analysis-error';
      errorEl.textContent = message;
      this._resultContainer.appendChild(errorEl);
    }
    this._notifications?.error?.(message, { category: 'analysis' });
  }

  // ===========================================================================
  // Page Change Notification Overrides
  // ===========================================================================

  /**
   * Update when highlights change (cells added/removed from pages)
   * Override base class to check for X/Y variables instead of dataSource.variable
   * @override
   */
  onHighlightChanged() {
    this._updatePageSelectorCounts();

    if (this._canRunAnalysis()) {
      this._scheduleUpdate();
    }
  }

  /**
   * Override to use PageSelectorComponent's updateCounts method
   * @override
   */
  _updatePageSelectorCounts() {
    this._pageSelector?.updateCounts();
  }

  /**
   * Override _renderControls to not render a button (auto-calculate like detailed mode)
   * @override
   */
  _renderControls() {
    this._formContainer.innerHTML = '';

    // Validate page requirements
    const validation = this.validatePages(this._selectedPages);

    if (!validation.valid) {
      const notice = document.createElement('div');
      notice.className = 'analysis-notice';
      notice.textContent = validation.error || this.getRequirementText();
      this._formContainer.appendChild(notice);
      return;
    }

    // Create form wrapper (no button - auto-calculates)
    const wrapper = document.createElement('div');
    wrapper.className = 'analysis-form';

    // Render form controls
    this._renderFormControls(wrapper);

    this._formContainer.appendChild(wrapper);

    // Trigger initial calculation if inputs are valid
    this._scheduleUpdate();
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
      idPrefix: this._xIdPrefix,
      typeLabel: 'X Axis Variable:',
      onVariableChange: () => this._scheduleUpdate()
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
      idPrefix: this._yIdPrefix,
      typeLabel: 'Y Axis Variable:',
      onVariableChange: () => this._scheduleUpdate()
    });

    // Page selector (matching DetailedAnalysisUI)
    this._renderPageSelector(wrapper);

    // Color by categorical variable selector
    this._renderColorBySelector(wrapper);

    // Correlation method selector
    const methodSelect = createFormSelect('method', [
      { value: 'pearson', label: 'Pearson (linear)', selected: true },
      { value: 'spearman', label: 'Spearman (rank)' }
    ]);
    methodSelect.addEventListener('change', () => this._scheduleUpdate());
    wrapper.appendChild(createFormRow('Correlation method:', methodSelect));
  }

  /**
   * Render page selector using shared PageSelectorComponent
   * @param {HTMLElement} wrapper
   */
  _renderPageSelector(wrapper) {
    let pages;
    try {
      pages = this.dataLayer.getPages();
    } catch (err) {
      console.error('[CorrelationAnalysisUI] Failed to get pages:', err);
      return;
    }

    if (pages.length === 0) return;

    // Auto-select all pages by default if none selected
    if (this._selectedPages.length === 0 && pages.length > 0) {
      this._selectedPages = pages.map(p => p.id);
      this._currentConfig.pages = this._selectedPages;
    }

    // Create container for the component
    this._pageSelectContainer = document.createElement('div');
    wrapper.appendChild(this._pageSelectContainer);

    // Destroy previous instance if exists
    this._pageSelector?.destroy();

    // Create PageSelectorComponent
    this._pageSelector = new PageSelectorComponent({
      dataLayer: this.dataLayer,
      container: this._pageSelectContainer,
      onSelectionChange: this._handlePageChange,
      onColorChange: this._handlePageColorChange,
      showColorPicker: true,
      showCellCounts: true,
      showSelectAll: true,
      initialSelection: this._selectedPages,
      includeDerivedPages: true,
      getCellCountForPageId: (pageId) => this.dataLayer.getCellCountForPageId(pageId),
      label: 'Compare pages:'
    });
  }

  /**
   * Render color by categorical variable selector
   * @param {HTMLElement} wrapper
   */
  _renderColorBySelector(wrapper) {
    let categoricalVars = [];
    try {
      categoricalVars = this.dataLayer.getAvailableVariables('categorical_obs') || [];
    } catch (err) {
      console.error('[CorrelationAnalysisUI] Failed to get categorical variables:', err);
    }

    if (categoricalVars.length === 0) return;

    const colorBySelect = createFormSelect('colorBy', [
      { value: NONE_VALUE, label: 'None (color by page)', selected: !this._colorByVariable },
      ...categoricalVars.map(v => ({
        value: v.key,
        label: v.key,
        selected: this._colorByVariable === v.key
      }))
    ]);

    colorBySelect.addEventListener('change', () => {
      const value = colorBySelect.value;
      this._colorByVariable = (value && value !== NONE_VALUE) ? value : null;
      this._scheduleUpdate();
    });

    wrapper.appendChild(createFormRow('Color by:', colorBySelect));
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
      method,
      colorBy: this._colorByVariable
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
      method: formValues.method || 'pearson',
      colorBy: formValues.colorBy ? { type: 'categorical_obs', key: formValues.colorBy } : null
    });

    // Pass custom page colors to results for proper coloring
    const customColors = this._pageSelector?.getCustomColors() || new Map();
    if (customColors.size > 0) {
      for (const result of correlationResults) {
        if (result.pageId && customColors.has(result.pageId)) {
          result.pageColor = customColors.get(result.pageId);
        }
      }
    }

    return {
      type: 'correlation',
      plotType: 'scatterplot',
      data: correlationResults,
      options: {
        showTrendline: true,
        showR2: true,
        showConfidenceInterval: true,
        colorBy: formValues.colorBy ? { type: 'categorical_obs', key: formValues.colorBy } : null
      },
      title: 'Correlation',
      subtitle: `${formValues.variableX.key} vs ${formValues.variableY.key}`,
      metadata: {
        method: formValues.method || 'pearson',
        variableX: formValues.variableX,
        variableY: formValues.variableY,
        colorBy: formValues.colorBy
      }
    };
  }

  // ===========================================================================
  // Custom Result Rendering
  // ===========================================================================

  async _showResult(result) {
    this._resultContainer.classList.remove('hidden');
    // Purge any existing plots to prevent WebGL memory leaks
    purgePlot(this._resultContainer.querySelector('.analysis-preview-plot'));
    this._resultContainer.innerHTML = '';

    // Plot container only - clickable to open modal (like detailed mode)
    const previewContainer = document.createElement('div');
    previewContainer.className = 'analysis-preview-container';
    previewContainer.style.cursor = 'pointer';
    previewContainer.title = 'Click to open in full view with statistics and export options';
    previewContainer.addEventListener('click', () => this._openFigureModal?.());
    this._resultContainer.appendChild(previewContainer);

    const plotContainer = document.createElement('div');
    plotContainer.className = 'analysis-preview-plot';
    plotContainer.id = this._plotContainerIdBase;
    this._plotContainerId = this._plotContainerIdBase;
    previewContainer.appendChild(plotContainer);

    const plotDef = PlotRegistry.get(result.plotType);
    if (plotDef) {
      try {
        const mergedOptions = PlotRegistry.mergeOptions(result.plotType, result.options || {});
        await plotDef.render(result.data, mergedOptions, plotContainer, null);
      } catch (err) {
        console.error('[CorrelationAnalysisUI] Plot render error:', err);
        plotContainer.innerHTML = '';
        const errorEl = document.createElement('div');
        errorEl.className = 'plot-error';
        errorEl.textContent = `Failed to render plot: ${err?.message || err}`;
        plotContainer.appendChild(errorEl);
      }
    }
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

    container.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'analysis-stats-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['Page', 'r', 'r²', 'p', 'n']) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const r of results) {
      const hasError = !!r?.error;
      const rVal = isFiniteNumber(r?.r) ? r.r.toFixed(4) : 'N/A';
      const r2Val = isFiniteNumber(r?.rSquared) ? r.rSquared.toFixed(4) : 'N/A';
      const pVal = isFiniteNumber(r?.pValue) ? r.pValue.toExponential(3) : 'N/A';
      const nVal = typeof r?.n === 'number'
        ? r.n.toLocaleString()
        : (Array.isArray(r?.xValues) ? r.xValues.length.toLocaleString() : 'N/A');

      const tr = document.createElement('tr');

      const tdPage = document.createElement('td');
      tdPage.textContent = String(r?.pageName || 'Page');
      tr.appendChild(tdPage);

      const tdR = document.createElement('td');
      tdR.textContent = hasError ? '—' : rVal;
      tr.appendChild(tdR);

      const tdR2 = document.createElement('td');
      tdR2.textContent = hasError ? '—' : r2Val;
      tr.appendChild(tdR2);

      const tdP = document.createElement('td');
      tdP.textContent = hasError ? '—' : pVal;
      if (!hasError && isFiniteNumber(r?.pValue) && r.pValue < 0.05) tdP.classList.add('significant');
      tr.appendChild(tdP);

      const tdN = document.createElement('td');
      tdN.textContent = hasError ? '—' : nVal;
      tr.appendChild(tdN);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.appendChild(table);
  }

  _renderModalAnnotations(container) {
    const results = this._lastResult?.data;
    if (!Array.isArray(results) || results.length === 0) {
      container.innerHTML = '<p class="modal-annotations-placeholder">No correlation results</p>';
      return;
    }

    const method = this._lastResult?.metadata?.method || 'pearson';

    container.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'analysis-stats-table correlation-interpretation';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['Page', 'Direction', 'Strength', 'r']) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    const valid = results.filter(r => !r?.error && isFiniteNumber(r?.r));
    if (valid.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.textContent = 'No valid correlation values';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      for (const r of valid) {
        const absR = Math.abs(r.r);
        let strengthLabel;
        let strengthClass;
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

        const tr = document.createElement('tr');

        const tdPage = document.createElement('td');
        tdPage.textContent = String(r.pageName || 'Page');
        tr.appendChild(tdPage);

        const tdDir = document.createElement('td');
        const strongDir = document.createElement('strong');
        if (directionClass) strongDir.className = directionClass;
        strongDir.textContent = direction;
        tdDir.appendChild(strongDir);
        tr.appendChild(tdDir);

        const tdStrength = document.createElement('td');
        const strongStrength = document.createElement('strong');
        strongStrength.className = `correlation-${strengthClass}`;
        strongStrength.textContent = strengthLabel;
        tdStrength.appendChild(strongStrength);
        tr.appendChild(tdStrength);

        const tdR = document.createElement('td');
        const strongR = document.createElement('strong');
        strongR.textContent = r.r.toFixed(3);
        tdR.appendChild(strongR);
        tr.appendChild(tdR);

        tbody.appendChild(tr);
      }
    }

    table.appendChild(tbody);
    container.appendChild(table);

    const note = document.createElement('p');
    note.className = 'interpretation-note';
    note.textContent = `Interpreting ${method} correlation: |r| ≥ 0.8 (very strong), ≥ 0.6 (strong), ≥ 0.4 (moderate), ≥ 0.2 (weak).`;
    container.appendChild(note);
  }

  _exportModalCSV() {
    this._exportResultsCSV();
  }

  // ===========================================================================
  // Export Helpers
  // ===========================================================================

  async _exportPlotPNG() {
    const plotEl = this._plotContainerId ? document.getElementById(this._plotContainerId) : null;
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
    this._isDestroyed = true;
    this._xSelector?.destroy?.();
    this._ySelector?.destroy?.();
    this._pageSelector?.destroy();
    this._xSelector = null;
    this._ySelector = null;
    this._pageSelector = null;
    this._pageSelectContainer = null;
    this._colorByVariable = null;
    super.destroy();
  }

  exportSettings() {
    const base = super.exportSettings();
    const customColors = this._pageSelector?.getCustomColors() || new Map();
    return {
      ...base,
      variableX: this._xSelector?.getSelectedVariable?.() || null,
      variableY: this._ySelector?.getSelectedVariable?.() || null,
      colorBy: this._colorByVariable,
      customPageColors: Array.from(customColors.entries())
    };
  }

  importSettings(settings) {
    super.importSettings(settings);
    if (!settings) return;

    const variableX = settings.variableX;
    const variableY = settings.variableY;

    if (variableX?.type && variableX?.variable && this._xSelector?.setSelectedVariable) {
      this._xSelector.setSelectedVariable(variableX.type, variableX.variable);
    }
    if (variableY?.type && variableY?.variable && this._ySelector?.setSelectedVariable) {
      this._ySelector.setSelectedVariable(variableY.type, variableY.variable);
    }

    // Restore colorBy
    if (settings.colorBy) {
      this._colorByVariable = settings.colorBy;
    }

    // Restore custom page colors to component
    if (Array.isArray(settings.customPageColors) && this._pageSelector) {
      settings.customPageColors.forEach(([pageId, color]) => {
        this._pageSelector.customColors.set(pageId, color);
      });
      this._pageSelector.render();
    }
  }
}

export function createCorrelationAnalysisUI(options) {
  return new CorrelationAnalysisUI(options);
}

export default CorrelationAnalysisUI;
