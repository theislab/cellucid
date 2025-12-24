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
  createFormTextarea
} from '../../shared/dom-utils.js';
import {
  signatureScoresToCSV,
  downloadCSV
} from '../../shared/analysis-utils.js';
// renderGeneChips moved inline to modal annotations
import { isFiniteNumber } from '../../shared/number-utils.js';
import { purgePlot } from '../../plots/plotly-loader.js';
import { PageSelectorComponent } from '../shared/page-selector.js';
import { renderSummaryStats, renderStatisticalAnnotations } from '../components/stats-display.js';

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
  async _runAnalysisIfValid() {
    if (this._isDestroyed) return;
    if (!this._canRunAnalysis()) {
      this._hideResult();
      return;
    }

    try {
      this._isLoading = true;
      const formValues = this._getFormValues();
      const result = await this._runAnalysisImpl(formValues);

      if (this._isDestroyed) return;
      if (result) {
        this._lastResult = result;
        this._currentPageData = result.data || result;
        await this._showResult(result);
      }
    } catch (err) {
      console.error('[GeneSignatureUI] Analysis failed:', err);
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

  /**
   * Update when highlights change (cells added/removed from pages)
   * Override base class to check for genes instead of dataSource.variable
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
      // Gene Signature has its own internal page selector; don't block rendering
      // when the global page selection is empty.
      minPages: 0,
      maxPages: null, // No limit
      description: 'Select pages to analyze'
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

    // Let subclass render form controls
    this._renderFormControls(wrapper);

    this._formContainer.appendChild(wrapper);

    // Trigger initial calculation if inputs are valid
    this._scheduleUpdate();
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
    // Restore persisted gene list value
    if (this._savedGeneList) {
      geneListInput.value = this._savedGeneList;
    }
    // Save gene list on input and trigger auto-update
    geneListInput.addEventListener('input', () => {
      this._savedGeneList = geneListInput.value;
      this._scheduleUpdate();
    });
    geneListRow.appendChild(geneListInput);
    wrapper.appendChild(geneListRow);

    // Page selector (matching Detailed and Correlation analysis modes)
    this._renderPageSelector(wrapper);

    // Method selector
    const methodSelect = createFormSelect('method', [
      { value: 'mean', label: 'Mean expression', selected: true },
      { value: 'sum', label: 'Sum expression' },
      { value: 'median', label: 'Median expression' }
    ]);
    methodSelect.addEventListener('change', () => this._scheduleUpdate());
    wrapper.appendChild(createFormRow('Scoring method:', methodSelect));

    // Normalization
    const normalizeSelect = createFormSelect('normalize', [
      { value: 'none', label: 'None', selected: true },
      { value: 'zscore', label: 'Z-score' },
      { value: 'minmax', label: 'Min-Max (0-1)' }
    ]);
    normalizeSelect.addEventListener('change', () => this._scheduleUpdate());
    wrapper.appendChild(createFormRow('Normalization:', normalizeSelect));

    // Plot type
    const plotTypeSelect = createFormSelect('plotType', [
      { value: 'violinplot', label: 'Violin plot', selected: true },
      { value: 'boxplot', label: 'Box plot' },
      { value: 'histogram', label: 'Histogram' }
    ]);
    plotTypeSelect.addEventListener('change', () => this._scheduleUpdate());
    wrapper.appendChild(createFormRow('Visualization:', plotTypeSelect));
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

    // Plot container only - clickable to open modal
    const previewContainer = document.createElement('div');
    previewContainer.className = 'analysis-preview-container';
    previewContainer.style.cursor = 'pointer';
    previewContainer.title = 'Click to open in full view with statistics and export options';
    previewContainer.addEventListener('click', () => this._openExpandedView());
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
        plotContainer.innerHTML = '';
        const errorEl = document.createElement('div');
        errorEl.className = 'plot-error';
        errorEl.textContent = `Failed to render plot: ${err?.message || err}`;
        plotContainer.appendChild(errorEl);
      }
    }

    // Expand (modal) action - consistent with DE mode
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

  /**
   * Render signature statistics in modal (matching Detailed analysis style)
   * @param {HTMLElement} container - Modal stats container
   */
  _renderModalStats(container) {
    const result = this._lastResult;
    const pageData = result?.data;

    if (!pageData || pageData.length === 0) {
      container.innerHTML = '<p class="modal-stats-placeholder">Statistics not available</p>';
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
      statsTitle.textContent = 'Statistical Analysis';
      statsSection.appendChild(statsTitle);

      const statsContainer = document.createElement('div');
      // Gene signature scores are continuous data
      renderStatisticalAnnotations(statsContainer, pageData, 'continuous_obs');
      statsSection.appendChild(statsContainer);

      container.appendChild(statsSection);
    } else if (pageData && pageData.length < 2) {
      const help = document.createElement('div');
      help.className = 'analysis-annotations-help';
      help.textContent = 'Select at least 2 pages to see statistical comparisons.';
      container.appendChild(help);
    }

    // Gene list section
    if (genes && genes.length > 0) {
      const geneSection = document.createElement('div');
      geneSection.className = 'modal-gene-section';
      geneSection.style.marginTop = '1rem';

      const geneTitle = document.createElement('h5');
      geneTitle.textContent = `Genes in Signature (${genes.length})`;
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
      container.innerHTML = '<p class="modal-annotations-placeholder">No annotations available</p>';
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
    const customColors = this._pageSelector?.getCustomColors() || new Map();
    return {
      ...base,
      savedGeneList: this._savedGeneList,
      customPageColors: Array.from(customColors.entries())
    };
  }

  importSettings(settings) {
    super.importSettings(settings);
    if (!settings) return;

    // Restore gene list
    if (settings.savedGeneList) {
      this._savedGeneList = settings.savedGeneList;
    }

    // Restore custom page colors
    if (Array.isArray(settings.customPageColors) && this._pageSelector) {
      settings.customPageColors.forEach(([pageId, color]) => {
        this._pageSelector.customColors.set(pageId, color);
      });
      this._pageSelector.render();
    }
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  destroy() {
    this._isDestroyed = true;
    this._pageSelector?.destroy();
    this._pageSelector = null;
    this._pageSelectContainer = null;
    this._savedGeneList = '';
    super.destroy();
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
