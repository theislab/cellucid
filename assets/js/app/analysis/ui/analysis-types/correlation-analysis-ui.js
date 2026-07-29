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
import { isFiniteNumber } from '../../shared/number-utils.js';

function requireCorrelationVariable(variable, label) {
  if (
    variable === null ||
    typeof variable !== 'object' ||
    Array.isArray(variable) ||
    Object.keys(variable).length !== 2 ||
    !Object.hasOwn(variable, 'type') ||
    !Object.hasOwn(variable, 'key') ||
    (variable.type !== 'continuous_obs' && variable.type !== 'gene_expression') ||
    typeof variable.key !== 'string' ||
    variable.key.length === 0
  ) {
    throw new TypeError(
      `${label} must contain exactly a continuous_obs or gene_expression type and non-empty key`
    );
  }
}

function requireReadyPageData(pageData, pageIds, variableKey) {
  if (!Array.isArray(pageData)) {
    throw new TypeError(
      `Correlation readiness for "${variableKey}" must return an array`
    );
  }
  if (pageData.length !== pageIds.length) {
    throw new Error(
      `Correlation readiness for "${variableKey}" returned ${pageData.length} ` +
      `pages instead of ${pageIds.length}`
    );
  }

  const expectedPageIds = new Set(pageIds);
  const seenPageIds = new Set();
  for (const page of pageData) {
    if (
      page === null ||
      typeof page !== 'object' ||
      Array.isArray(page) ||
      typeof page.pageId !== 'string' ||
      !expectedPageIds.has(page.pageId) ||
      page.values === null ||
      typeof page.values !== 'object' ||
      !Number.isSafeInteger(page.values.length) ||
      page.cellIndices === null ||
      typeof page.cellIndices !== 'object' ||
      !Number.isSafeInteger(page.cellIndices.length) ||
      page.values.length !== page.cellIndices.length
    ) {
      throw new TypeError(
        `Correlation readiness for "${variableKey}" returned invalid page data`
      );
    }
    if (seenPageIds.has(page.pageId)) {
      throw new TypeError(
        `Correlation readiness for "${variableKey}" duplicated page "${page.pageId}"`
      );
    }
    seenPageIds.add(page.pageId);
  }
}

function requireStoredCorrelationVariable(variable, label, dataLayer) {
  if (
    variable === null ||
    typeof variable !== 'object' ||
    Array.isArray(variable) ||
    Object.keys(variable).length !== 2 ||
    !Object.hasOwn(variable, 'type') ||
    !Object.hasOwn(variable, 'variable') ||
    typeof variable.type !== 'string' ||
    typeof variable.variable !== 'string'
  ) {
    throw new TypeError(
      `${label} must contain exactly string type and variable fields`
    );
  }
  if (variable.type.length === 0 || variable.variable.length === 0) {
    if (variable.type.length !== 0 || variable.variable.length !== 0) {
      throw new TypeError(
        `${label} type and variable must both be empty or both be selected`
      );
    }
    return;
  }
  if (
    variable.type !== 'continuous_obs' &&
    variable.type !== 'gene_expression'
  ) {
    throw new TypeError(`${label} type is unsupported`);
  }
  const inventory = dataLayer.getAvailableVariables(variable.type);
  if (!Array.isArray(inventory)) {
    throw new TypeError(`${label} variable inventory must be an array`);
  }
  if (!inventory.some(candidate => candidate?.key === variable.variable)) {
    throw new Error(
      `${label} variable "${variable.variable}" was not found`
    );
  }
}

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
  async _runAnalysisIfValid(scheduledRequestId = null) {
    if (this._isDestroyed) return;
    if (
      scheduledRequestId !== null &&
      !this._isCurrentAnalysisIntent(scheduledRequestId)
    ) {
      return;
    }
    if (!this._canRunAnalysis()) {
      this._invalidateAnalysisRequest();
      await this._hideResult();
      return;
    }

    // Validate that X and Y are different
    const formValues = structuredClone(this._getFormValues());
    if (formValues.variableX?.key === formValues.variableY?.key &&
        formValues.variableX?.type === formValues.variableY?.type) {
      this._invalidateAnalysisRequest();
      await this._hideResult();
      return;
    }

    const requestId = this._startAnalysisRequest(scheduledRequestId);
    if (requestId === null) return;
    try {
      const result = await this._runAnalysisImpl(formValues, requestId);

      if (!this._isCurrentAnalysisRequest(requestId)) return;
      if (result) {
        await this._showResult(result, requestId);
        if (!this._isCurrentAnalysisRequest(requestId)) return;
        this._lastResult = result;
        this._currentPageData = result.data || result;
        this._requestedPlotOptions = structuredClone(result.options || {});
      }
    } catch (err) {
      if (!this._isCurrentAnalysisRequest(requestId)) return;
      console.error('[CorrelationAnalysisUI] Analysis failed:', err);
      await this._showError('Analysis failed: ' + err.message, requestId);
    } finally {
      this._finishAnalysisRequest(requestId);
    }
  }

  /**
   * Hide result container
   */
  _hideResult() {
    return this._discardFormResult();
  }

  /**
   * Show error message
   */
  async _showError(message, requestId = null) {
    await this._discardFormResult();
    if (
      requestId !== null &&
      !this._isCurrentAnalysisRequest(requestId)
    ) {
      return false;
    }
    if (this._resultContainer) {
      this._resultContainer.classList.remove('hidden');
      const errorEl = document.createElement('div');
      errorEl.className = 'analysis-error';
      errorEl.textContent = message;
      this._resultContainer.appendChild(errorEl);
    }
    this._notifications?.error?.(message, { category: 'analysis' });
    return true;
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
      initialSelection: this._selectedPages.length > 0
        ? this._selectedPages
        : undefined,
      includeDerivedPages: true,
      getCellCountForPageId: (pageId) => this.dataLayer.getCellCountForPageId(pageId),
      label: 'Compare pages:'
    });
    this._selectedPages = this._pageSelector.getSelectedPages();
    this._currentConfig.pages = [...this._selectedPages];
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
  async _runAnalysisImpl(formValues, requestId = null) {
    if (!this.multiVariableAnalysis?.correlationAnalysis) {
      throw new Error('Correlation analysis module not available');
    }
    if (typeof this.dataLayer?.getDataForPages !== 'function') {
      throw new TypeError('Correlation analysis requires dataLayer.getDataForPages()');
    }
    requireCorrelationVariable(formValues.variableX, 'Correlation X variable');
    requireCorrelationVariable(formValues.variableY, 'Correlation Y variable');
    if (
      !Array.isArray(this._selectedPages) ||
      this._selectedPages.length === 0 ||
      this._selectedPages.some(
        pageId => typeof pageId !== 'string' || pageId.length === 0
      ) ||
      new Set(this._selectedPages).size !== this._selectedPages.length
    ) {
      throw new TypeError(
        'Correlation analysis requires unique non-empty selected page IDs'
      );
    }

    const pageIds = [...this._selectedPages];
    const customColors = new Map(
      this._pageSelector?.getCustomColors?.() || []
    );
    const readinessRequests = [
      {
        type: formValues.variableX.type,
        variableKey: formValues.variableX.key,
        pageIds
      },
      {
        type: formValues.variableY.type,
        variableKey: formValues.variableY.key,
        pageIds
      }
    ];
    if (formValues.colorBy !== null) {
      if (typeof formValues.colorBy !== 'string' || formValues.colorBy.length === 0) {
        throw new TypeError('Correlation colorBy must be null or a non-empty string');
      }
      readinessRequests.push({
        type: 'categorical_obs',
        variableKey: formValues.colorBy,
        pageIds
      });
    }

    // Materialize each scientific array in a deterministic sequence before the
    // compute request. This is one execution path: readiness failure terminates
    // the analysis, and no alternate render or delayed second attempt is scheduled.
    for (const request of readinessRequests) {
      const readyPageData = await this.dataLayer.getDataForPages(request);
      if (
        requestId !== null &&
        !this._isCurrentAnalysisRequest(requestId)
      ) {
        return null;
      }
      requireReadyPageData(
        readyPageData,
        pageIds,
        request.variableKey
      );
    }

    const correlationResults = await this.multiVariableAnalysis.correlationAnalysis({
      varX: formValues.variableX,
      varY: formValues.variableY,
      pageIds,
      method: formValues.method,
      colorBy: formValues.colorBy ? { type: 'categorical_obs', key: formValues.colorBy } : null,
      isCurrent: requestId === null
        ? undefined
        : () => this._isCurrentAnalysisRequest(requestId),
      registerInvalidationCleanup: requestId === null
        ? undefined
        : cleanup =>
          this._registerAnalysisInvalidationCleanup(requestId, cleanup)
    });
    if (
      requestId !== null &&
      !this._isCurrentAnalysisRequest(requestId)
    ) {
      return null;
    }

    // Pass custom page colors to results for proper coloring
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

  async _showResult(result, requestId) {
    return this._renderPreviewPlot({
      result,
      requestId,
      containerId: this._plotContainerIdBase,
      clickable: true
    });
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
    if (this._destroyPromise != null) return this._destroyPromise;
    this._isDestroyed = true;
    const errors = [];
    for (const [label, owner] of [
      ['X variable selector', this._xSelector],
      ['Y variable selector', this._ySelector],
      ['page selector', this._pageSelector]
    ]) {
      if (owner === null || owner === undefined) continue;
      if (typeof owner.destroy !== 'function') {
        errors.push(new TypeError(`Correlation ${label} must implement destroy()`));
        continue;
      }
      try {
        owner.destroy();
      } catch (error) {
        errors.push(error);
      }
    }
    this._xSelector = null;
    this._ySelector = null;
    this._pageSelector = null;
    this._pageSelectContainer = null;
    this._colorByVariable = null;
    const parentTask = super.destroy();
    if (errors.length === 0) return parentTask;
    const destruction = Promise.resolve(parentTask).then(
      () => {
        if (errors.length === 1) throw errors[0];
        throw new AggregateError(errors, 'Correlation UI cleanup failed');
      },
      parentError => {
        throw new AggregateError(
          [...errors, parentError],
          'Correlation UI cleanup failed'
        );
      }
    );
    this._destroyPromise = destruction;
    void destruction.catch(() => {});
    return destruction;
  }

  exportSettings() {
    const base = super.exportSettings();
    if (!this._xSelector || !this._ySelector || !this._pageSelector) {
      throw new Error(
        'Correlation settings require initialized variable and page selectors'
      );
    }
    const customColors = this._pageSelector.getCustomColors();
    return {
      ...base,
      variableX: this._xSelector.getSelectedVariable(),
      variableY: this._ySelector.getSelectedVariable(),
      colorBy: this._colorByVariable,
      customPageColors: Array.from(customColors.entries())
    };
  }

  importSettings(settings) {
    const base = this._requireExactFormSettings(
      settings,
      [
        'colorBy',
        'customPageColors',
        'formControls',
        'selectedPages',
        'variableX',
        'variableY'
      ]
    );
    requireStoredCorrelationVariable(
      settings.variableX,
      'Correlation X variable',
      this.dataLayer
    );
    requireStoredCorrelationVariable(
      settings.variableY,
      'Correlation Y variable',
      this.dataLayer
    );
    if (
      settings.colorBy !== null &&
      (typeof settings.colorBy !== 'string' || settings.colorBy.length === 0)
    ) {
      throw new TypeError(
        'Correlation colorBy must be null or a non-empty string'
      );
    }
    const categoricalVariables =
      this.dataLayer.getAvailableVariables('categorical_obs');
    if (!Array.isArray(categoricalVariables)) {
      throw new TypeError(
        'Correlation categorical variable inventory must be an array'
      );
    }
    if (
      settings.colorBy !== null &&
      !categoricalVariables.some(variable => variable?.key === settings.colorBy)
    ) {
      throw new Error(
        `Correlation color variable "${settings.colorBy}" was not found`
      );
    }
    const methodControl = base.formControls.method;
    if (
      methodControl?.type !== 'value' ||
      (methodControl.value !== 'pearson' &&
        methodControl.value !== 'spearman')
    ) {
      throw new TypeError(
        'Correlation method control must be pearson or spearman'
      );
    }
    const colorControl = base.formControls.colorBy;
    const expectedColorValue = settings.colorBy ?? NONE_VALUE;
    if (
      categoricalVariables.length > 0 &&
      (
        colorControl?.type !== 'value' ||
        colorControl.value !== expectedColorValue
      )
    ) {
      throw new TypeError(
        'Correlation colorBy must exactly match its form control'
      );
    }
    if (categoricalVariables.length === 0 && colorControl !== undefined) {
      throw new TypeError(
        'Correlation colorBy control is unavailable for this dataset'
      );
    }
    const customPageColors = this._requireCustomPageColors(
      settings.customPageColors
    );

    this._applyFormSettings(base);
    if (settings.variableX.type.length === 0) {
      this._xSelector.clear();
    } else {
      this._xSelector.setSelectedVariable(
        settings.variableX.type,
        settings.variableX.variable
      );
    }
    if (settings.variableY.type.length === 0) {
      this._ySelector.clear();
    } else {
      this._ySelector.setSelectedVariable(
        settings.variableY.type,
        settings.variableY.variable
      );
    }
    this._colorByVariable = settings.colorBy;
    this._applyCustomPageColors(customPageColors);
  }
}

export function createCorrelationAnalysisUI(options) {
  const ui = new CorrelationAnalysisUI(options);
  ui.init(options.container);
  return ui;
}

export default CorrelationAnalysisUI;
