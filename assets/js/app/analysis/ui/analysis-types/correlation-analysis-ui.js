/**
 * Correlation: how two variables move together within each page.
 *
 * The form is the correlation options schema's
 * (`options/correlation-options.js`): the X and Y variables (an obs field or
 * a gene, the same picker Detailed uses), the pages, Run; the method and the
 * colouring under More options. Computed by
 * `MultiVariableAnalysis.correlationAnalysis`, drawn by the `scatterplot`
 * plot type.
 */

import { formatCount } from '../../../../utils/format-units.js';
import { FormBasedAnalysisUI } from './base/form-based-analysis.js';
import { correlationResultsToCSV, downloadCSV } from '../../shared/analysis-utils.js';
import { createVariableSelectorComponent } from '../shared/variable-selector.js';
import { PageSelectorComponent } from '../shared/page-selector.js';
import { CORRELATION_OPTIONS } from '../../options/correlation-options.js';
import { isFiniteNumber } from '../../shared/number-utils.js';
import {
  createResultEnvelope,
  readResultEnvelope,
  requireDatasetPages,
  requireDatasetVariable
} from '../../shared/analysis-result-session.js';
import { failureText } from '../../../../utils/errors.js';

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


/**
 * @typedef {{ type: 'continuous_obs'|'gene_expression', key: string }} CorrelationVariable
 */

/**
 * Why a page's correlation is undefined: a variable constant in its cells
 * (`computeCorrelation`'s `constant`), named.
 *
 * @param {{constant: 'x'|'y'|'both', xVariable?: string, yVariable?: string}} result
 * @returns {string}
 */
function constantCorrelationReason(result) {
  if (result.constant === 'both') return 'both variables are constant in these cells';
  const name = result.constant === 'x' ? result.xVariable : result.yVariable;
  return `${name ?? (result.constant === 'x' ? 'X' : 'Y')} is constant in these cells`;
}


/** A finite number, or null (JSON has no NaN). */
const finiteOrNull = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export class CorrelationAnalysisUI extends FormBasedAnalysisUI {
  static getRequirements() {
    return {
      // Correlation has its own page selector.
      minPages: 0,
      maxPages: null,
      description: 'Select pages to analyze'
    };
  }

  _getTitle() {
    return 'Correlation';
  }

  _getClassName() {
    return 'correlation-analysis';
  }

  _getSuccessMessage() {
    return 'Correlation analysis complete';
  }

  constructor(options) {
    super(options);
    this._plotContainerIdBase = this._instanceId ? `${this._instanceId}-correlation-analysis-plot` : 'correlation-analysis-plot';
    this._pageSelector = null;
    this._pageSelectContainer = null;
  }

  // ===========================================================================
  // Options
  // ===========================================================================

  _getOptionsSchema() {
    return CORRELATION_OPTIONS;
  }

  _getOptionsContext() {
    return {
      variableExists: (type, key) => this.dataLayer.getAvailableVariables(type).some(variable => variable.key === key),
      categoricalFields: this.dataLayer.getAvailableVariables('categorical_obs').map(variable => ({ key: variable.key })),
      createVariableControl: (entry, value, onChange) => this._createVariableControl(entry, value, onChange)
    };
  }

  /** The X / Y picker: an obs field or a gene, as in Detailed. */
  _createVariableControl(entry, value, onChange) {
    const root = document.createElement('div');
    root.className = 'control-block';
    const axis = entry.key === 'variableX' ? 'x' : 'y';
    const selector = createVariableSelectorComponent({
      dataLayer: this.dataLayer,
      container: root,
      allowedTypes: ['continuous', 'gene'],
      idPrefix: this._instanceId ? `${this._instanceId}-correlation-${axis}` : `correlation-${axis}`,
      typeLabel: entry.label,
      onVariableChange: () => {
        const selected = selector.getSelectedVariable();
        onChange(selected.type && selected.variable ? { type: selected.type, key: selected.variable } : null);
      }
    });
    const set = next => {
      if (next === null) selector.clear();
      else selector.setSelectedVariable(next.type, next.key);
    };
    set(value);
    return { root, set, destroy: () => selector.destroy() };
  }

  _getRunBlocker(options) {
    if (options.variableX === null || options.variableY === null) return 'Choose the X and Y variables';
    if (options.variableX.type === options.variableY.type && options.variableX.key === options.variableY.key) {
      return 'X and Y are the same variable';
    }
    if (this._selectedPages.length === 0) return 'Select at least one page';
    return null;
  }

  _renderFormLead(wrapper) {
    const pages = this.dataLayer.getPages();
    if (!Array.isArray(pages) || pages.length === 0) return;
    this._pageSelectContainer = document.createElement('div');
    wrapper.appendChild(this._pageSelectContainer);
    this._pageSelector?.destroy();
    this._pageSelector = new PageSelectorComponent({
      dataLayer: this.dataLayer,
      container: this._pageSelectContainer,
      onSelectionChange: pageIds => {
        this._assignPages(pageIds || []);
        this._recordPersonChange('pages', { pageIds: [...this._selectedPages] });
        this._updateRunRow();
        this._updateStale();
      },
      onColorChange: (pageId, color) => this.dataLayer?.setPageColor?.(pageId, color),
      showColorPicker: true,
      showCellCounts: true,
      showSelectAll: true,
      initialSelection: this._pageSelectionToShow(),
      includeDerivedPages: true,
      getCellCountForPageId: pageId => this.dataLayer.getCellCountForPageId(pageId),
      label: 'Pages'
    });
    this._adoptSelectorDefault();
  }

  // ===========================================================================
  // Run
  // ===========================================================================

  /** @override */
  _takesCellSample() {
    return true;
  }

  async _runAnalysisImpl(options, requestId, job, sample = null) {
    requireCorrelationVariable(options.variableX, 'Correlation X variable');
    requireCorrelationVariable(options.variableY, 'Correlation Y variable');
    // A first pass correlates each page's cells in the sample.
    const pageIds = sample === null ? [...this._selectedPages] : sample.pageIds([...this._selectedPages]);
    const customColors = new Map(this._pageSelector?.getCustomColors?.() || []);
    const colorBy = options.colorBy === '' ? null : options.colorBy;
    const readinessRequests = [
      { type: options.variableX.type, variableKey: options.variableX.key, pageIds },
      { type: options.variableY.type, variableKey: options.variableY.key, pageIds },
      ...(colorBy === null ? [] : [{ type: 'categorical_obs', variableKey: colorBy, pageIds }])
    ];
    // Each variable is read in turn before the computation.
    for (const request of readinessRequests) {
      job?.step(`Reading ${request.variableKey}`);
      const readyPageData = await this.dataLayer.getDataForPages({
        ...request,
        silent: true,
        signal: job?.signal ?? null,
        owner: job?.id ?? null
      });
      if (!this._isCurrentAnalysisRequest(requestId)) return null;
      requireReadyPageData(readyPageData, pageIds, request.variableKey);
    }
    const correlationResults = await this.multiVariableAnalysis.correlationAnalysis({
      varX: options.variableX,
      varY: options.variableY,
      pageIds,
      method: options.method,
      colorBy: colorBy === null ? null : { type: 'categorical_obs', key: colorBy },
      job,
      isCurrent: () => this._isCurrentAnalysisRequest(requestId),
      registerInvalidationCleanup: cleanup => this._registerAnalysisInvalidationCleanup(requestId, cleanup)
    });
    if (!this._isCurrentAnalysisRequest(requestId)) return null;
    if (sample !== null) {
      for (const result of correlationResults) {
        if (result.pageId) result.pageId = sample.basePageId(result.pageId);
      }
    }
    if (customColors.size > 0) {
      for (const result of correlationResults) {
        if (result.pageId && customColors.has(result.pageId)) result.pageColor = customColors.get(result.pageId);
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
        colorBy: colorBy === null ? null : { type: 'categorical_obs', key: colorBy }
      },
      title: 'Correlation',
      subtitle: `${options.variableX.key} vs ${options.variableY.key}`,
      metadata: {
        method: options.method,
        variableX: options.variableX,
        variableY: options.variableY,
        colorBy
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
      expandable: true
    });
  }

  // ===========================================================================
  // Modal Rendering - Overrides from FormBasedAnalysisUI
  // ===========================================================================

  _renderModalStats(container) {
    const results = this._lastResult?.data;
    if (!Array.isArray(results) || results.length === 0) {
      container.innerHTML = '<p class="empty-state">Statistics not available</p>';
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
      const rVal = isFiniteNumber(r?.r) ? r.r.toFixed(4) : (r?.constant ? 'Undefined' : 'N/A');
      const r2Val = isFiniteNumber(r?.rSquared) ? r.rSquared.toFixed(4) : 'N/A';
      const pVal = isFiniteNumber(r?.pValue) ? r.pValue.toExponential(3) : 'N/A';
      const nVal = typeof r?.n === 'number'
        ? formatCount(r.n)
        : (Array.isArray(r?.xValues) ? formatCount(r.xValues.length) : 'N/A');

      const tr = document.createElement('tr');

      const tdPage = document.createElement('td');
      tdPage.textContent = String(r?.pageName || 'Page');
      tr.appendChild(tdPage);

      const tdR = document.createElement('td');
      tdR.textContent = hasError ? '—' : rVal;
      if (!hasError && r?.constant) tdR.title = constantCorrelationReason(r);
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
      container.innerHTML = '<p class="empty-state">No correlation results</p>';
      return;
    }

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
    // A variable constant in a page: no correlation there to read.
    for (const r of results) {
      if (r?.error || !r?.constant) continue;
      const tr = document.createElement('tr');
      const tdPage = document.createElement('td');
      tdPage.textContent = String(r.pageName || 'Page');
      const tdReason = document.createElement('td');
      tdReason.colSpan = 3;
      tdReason.textContent = `Undefined: ${constantCorrelationReason(r)}`;
      tr.append(tdPage, tdReason);
      tbody.appendChild(tr);
    }
    if (valid.length === 0 && !results.some(r => !r?.error && r?.constant)) {
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
          strengthLabel = 'Very strong';
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
          strengthLabel = 'Very weak or none';
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
  }

  _exportModalCSV() {
    this._exportResultsCSV();
  }

  // ===========================================================================
  // Export Helpers
  // ===========================================================================

  async _exportPlotPNG() {
    if (await this._refuseStaleExport('PNG')) return;
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

  /**
   * The shown result for a session: each page's statistics and plotted
   * points, variables by key.
   * @returns {null|{kind: 'correlation', version: number, payload: unknown}}
   */
  /**
   * One row per page: r, r squared, p and the cells, as an agent reads the
   * result (`describeResult`).
   * @override
   */
  _resultTable(result, top) {
    const pages = Array.isArray(result?.data) ? result.data : [];
    const method = result?.metadata?.method ?? null;
    const cellsOf = page => (Number.isFinite(page.n) ? page.n
      : (Array.isArray(page.xValues) || ArrayBuffer.isView(page.xValues) ? page.xValues.length : null));
    return {
      columns: ['page', 'method', 'r', 'r_squared', 'p_value', 'cells'],
      rows: pages.slice(0, top).map(page => [
        String(page.pageName ?? ''), method, finiteOrNull(page.r),
        Number.isFinite(page.rSquared) ? page.rSquared : (Number.isFinite(page.r) ? page.r * page.r : null),
        finiteOrNull(page.pValue), cellsOf(page)
      ]),
      total: pages.length
    };
  }

  _exportResult() {
    if (this._lastResult === null || this._lastResult === undefined) return null;
    return createResultEnvelope('correlation', this._lastResult);
  }

  /**
   * Restore a result written by `exportResult()`; refused when it names a
   * variable, cell group or colour category the open dataset lacks.
   * @param {null|Object} envelope
   * @returns {Promise<void>}
   */
  async importResult(envelope) {
    if (envelope === null) {
      await this._discardFormResult();
      return;
    }
    const result = readResultEnvelope(envelope, 'correlation');
    const metadata = result?.metadata;
    if (
      result?.type !== 'correlation' ||
      !Array.isArray(result.data) ||
      metadata === null ||
      typeof metadata !== 'object'
    ) {
      throw new TypeError('A correlation result must hold its pages and variables');
    }
    requireCorrelationVariable(metadata.variableX, 'Correlation result X variable');
    requireCorrelationVariable(metadata.variableY, 'Correlation result Y variable');
    requireDatasetVariable(
      this.dataLayer,
      metadata.variableX.type,
      metadata.variableX.key,
      'The correlation result'
    );
    requireDatasetVariable(
      this.dataLayer,
      metadata.variableY.type,
      metadata.variableY.key,
      'The correlation result'
    );
    requireDatasetPages(
      this.dataLayer,
      result.data.map(page => page?.pageId),
      'The correlation result'
    );
    if (metadata.colorBy !== null) {
      requireDatasetVariable(this.dataLayer, 'categorical_obs', metadata.colorBy, 'The correlation result');
      await this.dataLayer.ensureObsFieldLoaded(metadata.colorBy);
      const categories = new Set(
        this.dataLayer.getVariableInfo('categorical_obs', metadata.colorBy)?.categories ?? []
      );
      for (const page of result.data) {
        if (!Array.isArray(page.colorValues)) continue;
        for (const label of page.colorValues) {
          if (label !== null && !categories.has(label)) {
            throw new Error(
              `The correlation result colours by category "${String(label)}", ` +
              `which field "${metadata.colorBy}" lacks`
            );
          }
        }
      }
    }
    await this._restoreAnalysisResult(result, envelope.provenance);
  }

  // ===========================================================================
  // Sessions
  // ===========================================================================

  _getExtraSettingKeys() {
    return ['customPageColors'];
  }

  _exportExtraSettings() {
    return {
      customPageColors: this._pageSelector === null ? [] : Array.from(this._pageSelector.getCustomColors().entries())
    };
  }

  _importExtraSettings(settings) {
    if (this._pageSelector !== null) {
      this._applyCustomPageColors(this._requireCustomPageColors(settings.customPageColors));
    }
  }

  destroy() {
    if (this._destroyPromise != null) return this._destroyPromise;
    this._isDestroyed = true;
    try {
      this._pageSelector?.destroy();
    } catch (error) {
      this._notifications.error(`Correlation cleanup failed: ${failureText(error)}`, { category: 'analysis' });
    }
    this._pageSelector = null;
    this._pageSelectContainer = null;
    return super.destroy();
  }

}

export function createCorrelationAnalysisUI(options) {
  const ui = new CorrelationAnalysisUI(options);
  ui.init(options.container);
  return ui;
}
