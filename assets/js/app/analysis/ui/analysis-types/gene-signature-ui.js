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

import { formatCount } from '../../../ui/components/display-format.js';
import { createStatusLine } from '../../../ui/components/controls.js';
import { FormBasedAnalysisUI } from './base/form-based-analysis.js';
import { createSelectField } from '../../shared/dom-utils.js';
import { createField } from '../../../ui/components/controls.js';
import {
  signatureScoresToCSV,
  downloadCSV
} from '../../shared/analysis-utils.js';
// renderGeneChips moved inline to modal annotations
import { isFiniteNumber } from '../../shared/number-utils.js';
import { PageSelectorComponent } from '../shared/page-selector.js';
import { applyFormControlAccessibility } from '../components/control-accessibility.js';
import {
  preparePageStatistics,
  renderSummaryStats,
  renderStatisticalAnnotations
} from '../components/stats-display.js';
import { createSlicedYield } from '../../shared/concurrency-utils.js';

/**
 * Gene Signature Score UI Component
 * @extends FormBasedAnalysisUI
 */
export class GeneSignatureUI extends FormBasedAnalysisUI {
  constructor(options) {
    super(options);

    // Page selector component
    this._pageSelector = null;
    this._pageSelectContainer = null;

    // Persist gene list input across re-renders
    this._savedGeneList = '';

    // Bind methods
    this._handlePageChange = this._handlePageChange.bind(this);
    this._handlePageColorChange = this._handlePageColorChange.bind(this);
  }

  // ===========================================================================
  // Page Selection Handlers
  // ===========================================================================

  _handlePageChange(pageIds) {
    this._selectedPages = pageIds || [];
    this._currentConfig.pages = this._selectedPages;
    // Trigger auto-update (like detailed mode)
    this._scheduleUpdate();
  }

  _handlePageColorChange(pageId, color) {
    this.dataLayer?.setPageColor?.(pageId, color);
    // Trigger auto-update to reflect color changes
    this._scheduleUpdate();
  }

  // ===========================================================================
  // Auto-calculation Logic (like Detailed mode)
  // ===========================================================================

  /**
   * Override _canRunAnalysis to check for genes instead of variable
   * @override
   */
  _canRunAnalysis() {
    const genes = this._getGeneList();
    return genes.length > 0 && this._selectedPages.length > 0;
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

    const requestId = this._startAnalysisRequest(scheduledRequestId);
    if (requestId === null) return;
    const releaseBusy = this._claimBusy();
    try {
      const formValues = structuredClone(this._getFormValues());
      const validation = this._validateForm(formValues);
      if (!validation.valid) {
        await this._showError(validation.error, requestId);
        return;
      }
      const result = await this._runAnalysisImpl(formValues, requestId);

      if (!this._isCurrentAnalysisRequest(requestId)) return;
      if (result) {
        await this._showResult(result, requestId);
        if (!this._isCurrentAnalysisRequest(requestId)) return;
        await this._publishAnalysisResult(result, requestId);
      }
    } catch (err) {
      if (!this._isCurrentAnalysisRequest(requestId)) return;
      console.error('[GeneSignatureUI] Analysis failed:', err);
      await this._showError('Analysis failed: ' + err.message, requestId);
    } finally {
      releaseBusy();
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
      this._resultContainer.hidden = false;
      this._resultContainer.appendChild(
        createStatusLine({ tone: 'danger', text: message }).root
      );
    }
    this._notifications?.error?.(message, { category: 'analysis' });
    return true;
  }

  /**
   * Update when highlights change (cells added/removed from pages)
   * Override base class to check for genes instead of dataSource.variable
   * @override
   */
  onHighlightChanged() {
    // This mode recalculates by itself, so a highlight change re-runs it
    // (deferred while the panel is hidden) instead of discarding the result
    // the way the run-button forms do.
    this._applyHighlightChangeWhenShown();
  }

  /**
   * @override
   */
  _applyHighlightChange() {
    this._updatePageSelectorCounts();

    if (this._canRunAnalysis()) {
      this._scheduleUpdate();
    }
  }

  // ===========================================================================
  // Required Abstract Method Implementations
  // ===========================================================================

  /**
   * Get page requirements for gene signature
   * @static
   * @returns {{ minPages: number, maxPages: number|null, description: string, geneExpression: true }}
   */
  static getRequirements() {
    return {
      // Gene Signature has its own internal page selector; don't block rendering
      // when the global page selection is empty.
      minPages: 0,
      maxPages: null, // No limit
      description: 'Select pages to analyze',
      geneExpression: true
    };
  }

  /**
   * Get the analysis title
   * @returns {string}
   */
  _getTitle() {
    return 'Gene signature score';
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
   * Override _renderControls to not render a button (auto-calculate like detailed mode)
   * @override
   */
  _renderControls() {
    // Rebuilding the form on every accordion reopen must not discard the
    // choices already made in it.
    const carriedValues = this._captureFormControlValues();
    this._formContainer.innerHTML = '';

    // Validate requirements
    const validation = this.validateRequirements(this._selectedPages);

    if (!validation.valid) {
      this._formContainer.appendChild(createStatusLine({
        tone: 'warning',
        text: validation.error || this.getRequirementText()
      }).root);
      return;
    }

    // Create form wrapper (no button - auto-calculates)
    const wrapper = document.createElement('div');
    wrapper.className = 'analysis-form';

    // Let subclass render form controls
    this._renderFormControls(wrapper);

    // Same form-control accessibility pass the base class runs: scoped ids and
    // a label bound to every control. Overriding _renderControls to drop the
    // run button must not also drop that.
    applyFormControlAccessibility(wrapper, this._controlScope);
    this._restoreFormControlValues(wrapper, carriedValues);

    this._formContainer.appendChild(wrapper);

    // Trigger initial calculation if inputs are valid
    this._scheduleUpdate();
  }

  /**
   * Render form-specific controls
   * @param {HTMLElement} wrapper - Form wrapper element
   */
  _renderFormControls(wrapper) {
    // Gene list input, named by its visible label: a placeholder vanishes as
    // soon as anything is typed.
    const geneListInput = document.createElement('textarea');
    geneListInput.name = 'genes';
    geneListInput.className = 'obs-select gene-list-input';
    geneListInput.placeholder = 'CD3E, CD4, CD8A, FOXP3…';
    geneListInput.rows = 4;
    // Restore persisted gene list value
    if (this._savedGeneList) {
      geneListInput.value = this._savedGeneList;
    }
    // Save gene list on input and trigger auto-update
    geneListInput.addEventListener('input', () => {
      this._savedGeneList = geneListInput.value;
      this._scheduleUpdate();
    });
    wrapper.appendChild(createField({
      label: 'Signature genes',
      control: geneListInput,
      tip: 'gene-signature-genes'
    }));

    // Page selector (matching Detailed and Correlation analysis modes)
    this._renderPageSelector(wrapper);

    const scheduleUpdate = () => this._scheduleUpdate();
    wrapper.appendChild(createSelectField({
      label: 'Scoring method',
      name: 'method',
      tip: 'gene-signature-scoring',
      options: [
        { value: 'mean', label: 'Mean expression', selected: true },
        { value: 'sum', label: 'Sum expression' },
        { value: 'median', label: 'Median expression' }
      ],
      onChange: scheduleUpdate
    }).root);

    wrapper.appendChild(createSelectField({
      label: 'Normalization',
      name: 'normalize',
      options: [
        { value: 'none', label: 'None', selected: true },
        { value: 'zscore', label: 'Z-score' },
        { value: 'minmax', label: 'Min-Max (0-1)' }
      ],
      onChange: scheduleUpdate
    }).root);

    wrapper.appendChild(createSelectField({
      label: 'Visualization',
      name: 'plotType',
      options: [
        { value: 'violinplot', label: 'Violin plot', selected: true },
        { value: 'boxplot', label: 'Box plot' },
        { value: 'histogram', label: 'Histogram' }
      ],
      onChange: scheduleUpdate
    }).root);
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
      console.error('[GeneSignatureUI] Failed to get pages:', err);
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
      label: 'Compare pages'
    });
    this._selectedPages = this._pageSelector.getSelectedPages();
    this._currentConfig.pages = [...this._selectedPages];
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
    const seenGenes = new Set();
    for (const gene of formValues.genes) {
      if (seenGenes.has(gene)) {
        return {
          valid: false,
          error: `Gene "${gene}" is listed more than once; list each gene once`
        };
      }
      seenGenes.add(gene);
    }
    if (!['mean', 'sum', 'median'].includes(formValues.method)) {
      return { valid: false, error: 'Select mean, sum, or median signature scoring' };
    }
    if (!['none', 'zscore', 'minmax'].includes(formValues.normalize)) {
      return { valid: false, error: 'Select a supported signature normalization' };
    }
    if (!['violinplot', 'boxplot', 'histogram'].includes(formValues.plotType)) {
      return { valid: false, error: 'Select a supported signature visualization' };
    }
    return { valid: true };
  }

  /**
   * Run the gene signature analysis
   * @param {Object} formValues - Form values
   * @returns {Promise<Object>} Analysis result
   */
  async _runAnalysisImpl(formValues, requestId = null) {
    const pageIds = [...this._selectedPages];
    // Compute signature scores
    const signatureResults = await this.multiVariableAnalysis.computeSignatureScore({
      genes: formValues.genes,
      pageIds,
      method: formValues.method,
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

    // Apply normalization if requested
    if (formValues.normalize !== 'none') {
      await this._normalizeResults(signatureResults, formValues.normalize);
      if (requestId !== null && !this._isCurrentAnalysisRequest(requestId)) return null;
    }

    const data = signatureResults.map(sr => ({
      pageId: sr.pageId,
      pageName: sr.pageName,
      // Keep raw scores to avoid duplicating large arrays; plots/stats filter as needed.
      values: sr.scores,
      variableInfo: { name: 'Signature Score', kind: 'continuous' }
    }));
    // The summary and tests the expanded view shows, computed by the analysis
    // workers for large pages so that drawing the view only reads them.
    await preparePageStatistics(data, 'continuous_obs');
    if (requestId !== null && !this._isCurrentAnalysisRequest(requestId)) return null;

    // Format for visualization
    return {
      type: 'signature',
      plotType: formValues.plotType,
      data,
      options: {
        showPoints: 'outliers',
        showMean: true
      },
      title: 'Gene signature score',
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
  async _normalizeResults(results, method) {
    // Every pass walks every score on this thread, so it hands the event loop
    // back between slices of a large page.
    const yieldIfSliceSpent = createSlicedYield();
    const pause = async () => {
      const pending = yieldIfSliceSpent();
      if (pending !== undefined) await pending;
    };
    if (method === 'zscore') {
      // Z-score normalization across all values (streaming; avoids huge temporary arrays)
      let count = 0;
      let meanVal = 0;
      let m2 = 0;

      for (const r of results) {
        const scores = r?.scores || [];
        for (let i = 0; i < scores.length; i++) {
          if ((i & 0xffff) === 0xffff) await pause();
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
          if ((i & 0xffff) === 0xffff) await pause();
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
          if ((i & 0xffff) === 0xffff) await pause();
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
          if ((i & 0xffff) === 0xffff) await pause();
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
  async _showResult(result, requestId) {
    const plotContainerId = this._instanceId ? `${this._instanceId}-signature-analysis-plot` : 'signature-analysis-plot';
    return this._renderPreviewPlot({
      result,
      requestId,
      containerId: plotContainerId,
      expandable: true
    });
  }

  // ===========================================================================
  // Modal Rendering - Overrides from FormBasedAnalysisUI
  // ===========================================================================

  /**
   * Render signature statistics in modal (matching Detailed analysis style)
   * @param {HTMLElement} container - Modal stats container
   */
  _renderModalStats(container) {
    const result = this._lastResult;
    const pageData = result?.data;

    if (!pageData || pageData.length === 0) {
      container.innerHTML = '<p class="empty-state">Statistics not available</p>';
      return;
    }

    // Use the same renderSummaryStats function as DetailedAnalysisUI
    renderSummaryStats(container, pageData, 'Signature Score');
  }

  /**
   * Render signature annotations in modal (statistical analysis + gene list)
   * @param {HTMLElement} container - Modal annotations container
   */
  _renderModalAnnotations(container) {
    const result = this._lastResult;
    const pageData = result?.data;
    const genes = result?.metadata?.genes;

    container.innerHTML = '';

    // Statistical analysis section (like detailed mode)
    if (pageData && pageData.length >= 2) {
      const statsSection = document.createElement('div');
      statsSection.className = 'modal-statistical-analysis';

      const statsTitle = document.createElement('h5');
      statsTitle.textContent = 'Statistical analysis';
      statsSection.appendChild(statsTitle);

      const statsContainer = document.createElement('div');
      // Gene signature scores are continuous data
      renderStatisticalAnnotations(statsContainer, pageData, 'continuous_obs');
      statsSection.appendChild(statsContainer);

      container.appendChild(statsSection);
    } else if (pageData && pageData.length < 2) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'Select 2+ pages for statistics.';
      container.appendChild(empty);
    }

    // Gene list section
    if (genes && genes.length > 0) {
      const geneSection = document.createElement('div');
      geneSection.className = 'modal-gene-section';

      const geneTitle = document.createElement('h5');
      geneTitle.textContent = `Genes in signature (${formatCount(genes.length)})`;
      geneSection.appendChild(geneTitle);

      const chips = document.createElement('div');
      chips.className = 'gene-chips modal-gene-chips';

      const frag = document.createDocumentFragment();
      for (const gene of genes) {
        const chip = document.createElement('span');
        chip.className = 'gene-chip';
        chip.textContent = String(gene ?? '');
        frag.appendChild(chip);
      }
      chips.appendChild(frag);
      geneSection.appendChild(chips);

      container.appendChild(geneSection);
    }

    if (container.innerHTML === '') {
      container.innerHTML = '<p class="empty-state">No annotations available</p>';
    }
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

  // ===========================================================================
  // Settings Export/Import
  // ===========================================================================

  exportSettings() {
    const base = super.exportSettings();
    if (!this._pageSelector) {
      throw new Error(
        'Gene signature settings require an initialized page selector'
      );
    }
    if (
      base.formControls.genes?.type !== 'value' ||
      base.formControls.genes.value !== this._savedGeneList
    ) {
      throw new TypeError(
        'Gene signature savedGeneList must exactly match the genes form control'
      );
    }
    const customColors = this._pageSelector.getCustomColors();
    return {
      ...base,
      savedGeneList: this._savedGeneList,
      customPageColors: Array.from(customColors.entries())
    };
  }

  importSettings(settings) {
    const base = this._requireExactFormSettings(
      settings,
      [
        'customPageColors',
        'formControls',
        'savedGeneList',
        'selectedPages'
      ]
    );
    if (typeof settings.savedGeneList !== 'string') {
      throw new TypeError(
        'Gene signature savedGeneList must be a string'
      );
    }
    if (
      base.formControls.genes?.type !== 'value' ||
      base.formControls.genes.value !== settings.savedGeneList
    ) {
      throw new TypeError(
        'Gene signature savedGeneList must exactly match the genes form control'
      );
    }
    const method = base.formControls.method;
    if (
      method?.type !== 'value' ||
      !new Set(['mean', 'median', 'sum']).has(method.value)
    ) {
      throw new TypeError('Gene signature method control is unsupported');
    }
    const normalization = base.formControls.normalize;
    if (
      normalization?.type !== 'value' ||
      !new Set(['minmax', 'none', 'zscore']).has(normalization.value)
    ) {
      throw new TypeError(
        'Gene signature normalization control is unsupported'
      );
    }
    const plotType = base.formControls.plotType;
    if (
      plotType?.type !== 'value' ||
      !new Set(['boxplot', 'histogram', 'violinplot']).has(plotType.value)
    ) {
      throw new TypeError(
        'Gene signature plot type control is unsupported'
      );
    }
    const customPageColors = this._requireCustomPageColors(
      settings.customPageColors
    );

    this._savedGeneList = settings.savedGeneList;
    this._applyFormSettings(base);
    this._applyCustomPageColors(customPageColors);
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  destroy() {
    if (this._destroyPromise != null) return this._destroyPromise;
    this._isDestroyed = true;
    const errors = [];
    if (this._pageSelector !== null && this._pageSelector !== undefined) {
      if (typeof this._pageSelector.destroy !== 'function') {
        errors.push(
          new TypeError('Gene Signature page selector must implement destroy()')
        );
      } else {
        try {
          this._pageSelector.destroy();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    this._pageSelector = null;
    this._pageSelectContainer = null;
    this._savedGeneList = '';
    const parentTask = super.destroy();
    if (errors.length === 0) return parentTask;
    const destruction = Promise.resolve(parentTask).then(
      () => {
        if (errors.length === 1) throw errors[0];
        throw new AggregateError(errors, 'Gene Signature UI cleanup failed');
      },
      parentError => {
        throw new AggregateError(
          [...errors, parentError],
          'Gene Signature UI cleanup failed'
        );
      }
    );
    this._destroyPromise = destruction;
    void destruction.catch(() => {});
    return destruction;
  }
}

/**
 * Factory function to create gene signature UI
 * @param {Object} options
 * @returns {GeneSignatureUI}
 */
export function createGeneSignatureUI(options) {
  const ui = new GeneSignatureUI(options);
  ui.init(options.container);
  return ui;
}
