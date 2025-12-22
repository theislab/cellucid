/**
 * FormBasedAnalysisUI - Base class for form-based analysis UIs
 *
 * Common pattern for analysis types that follow:
 * - Form inputs at top
 * - Run button
 * - Results display below
 * - Expandable modal view (matching Detailed Analysis pattern)
 *
 * Used by: DEAnalysisUI, GeneSignatureUI
 *
 * Subclasses must implement:
 * - static getRequirements() - Return { minPages, maxPages, description }
 * - _getTitle() - Return analysis title
 * - _getDescription() - Return analysis description
 * - _renderFormControls(wrapper) - Render form inputs into wrapper
 * - _getFormValues() - Extract form values as object
 * - _runAnalysisImpl(formValues) - Execute analysis, return result object
 *
 * Subclasses may override:
 * - _validateForm(formValues) - Custom form validation
 * - _showResult(result) - Custom result rendering
 * - _getLoadingMessage() - Custom loading message
 * - _getSuccessMessage() - Custom success message
 * - _getRunButtonText() - Custom button text
 * - _getClassName() - CSS class prefix
 * - _renderModalPlot(container) - Custom modal plot rendering
 * - _renderModalOptions(container) - Custom modal options rendering
 * - _renderModalStats(container) - Custom modal statistics rendering
 * - _renderModalAnnotations(container) - Custom modal annotations rendering
 *
 * @module analysis-types/base/form-based-analysis
 */

import { BaseAnalysisUI } from '../../base-analysis-ui.js';
import {
  createFormButton,
  createNotice,
  createResultHeader,
  createActionsBar
} from '../../../shared/dom-utils.js';
import {
  runAnalysisWithLoadingState,
  validatePageRequirements,
  getRequirementText
} from '../../../shared/analysis-utils.js';
import {
  createAnalysisModal,
  openModal,
  closeModal,
  createExpandButton,
  renderPlotOptions
} from '../../components/index.js';
import { loadPlotly, downloadImage, purgePlot } from '../../../plots/plotly-loader.js';
import { PlotRegistry } from '../../../shared/plot-registry-utils.js';
import { renderOrUpdatePlot } from '../../../shared/plot-lifecycle.js';

/**
 * Abstract base class for form-based analysis UIs
 * @extends BaseAnalysisUI
 * @abstract
 */
export class FormBasedAnalysisUI extends BaseAnalysisUI {
  /**
   * @param {Object} options
   * @param {Object} options.comparisonModule - Reference to main comparison module
   * @param {Object} options.dataLayer - Enhanced data layer
   * @param {Object} [options.multiVariableAnalysis] - Multi-variable analysis module
   * @param {Function} [options.onResultChange] - Callback when results change
   */
  constructor(options) {
    super(options);

    this.multiVariableAnalysis = options.multiVariableAnalysis;
    this.onResultChange = options.onResultChange;

    // UI containers (form-specific)
    this._formContainer = null;
    this._resultContainer = null;
    this._plotContainerId = null;

    // Modal support - matching Detailed Analysis pattern
    this._modal = null;

    // Bind methods
    this._openExpandedView = this._openExpandedView.bind(this);
    this._handlePlotOptionChange = this._handlePlotOptionChange.bind(this);

    // Prevent overlapping re-renders on rapid option changes
    this._optionRenderRevision = 0;

    // Note: _selectedPages, _lastResult, and _isLoading are inherited from BaseAnalysisUI
  }

  /**
   * Snapshot current form control values by their `name` attribute.
   * This intentionally captures settings only (not results).
   * @returns {Record<string, { type: 'checkbox'|'value', value: string|boolean }>}
   * @protected
   */
  _snapshotNamedFormControls() {
    /** @type {Record<string, { type: 'checkbox'|'value', value: string|boolean }>} */
    const out = {};
    const form = this._formContainer?.querySelector?.('.analysis-form');
    if (!form) return out;

    form.querySelectorAll('input[name], select[name], textarea[name]').forEach((el) => {
      const name = el.getAttribute('name');
      if (!name) return;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') {
        out[name] = { type: 'checkbox', value: el.checked };
      } else if (el instanceof HTMLInputElement) {
        out[name] = { type: 'value', value: el.value };
      } else if (el instanceof HTMLSelectElement) {
        out[name] = { type: 'value', value: el.value };
      } else if (el instanceof HTMLTextAreaElement) {
        out[name] = { type: 'value', value: el.value };
      }
    });

    return out;
  }

  /**
   * Apply a snapshot produced by _snapshotNamedFormControls().
   * @param {Record<string, { type: 'checkbox'|'value', value: string|boolean }>|null|undefined} snapshot
   * @protected
   */
  _applyNamedFormControls(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const form = this._formContainer?.querySelector?.('.analysis-form');
    if (!form) return;

    for (const [name, data] of Object.entries(snapshot)) {
      if (!data) continue;
      const el = form.querySelector(`[name="${CSS.escape(name)}"]`);
      if (!el) continue;

      if (data.type === 'checkbox' && el instanceof HTMLInputElement && el.type === 'checkbox') {
        el.checked = !!data.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        continue;
      }

      if (data.type === 'value' && (el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) {
        el.value = String(data.value ?? '');
        el.dispatchEvent(new Event('change', { bubbles: true }));
        continue;
      }

      if (data.type === 'value' && el instanceof HTMLTextAreaElement) {
        el.value = String(data.value ?? '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        continue;
      }
    }
  }

  /**
   * Export a settings-only snapshot for cloning/copying.
   * Results (plots/data) are intentionally excluded.
   * @override
   */
  exportSettings() {
    return {
      selectedPages: [...this._selectedPages],
      formControls: this._snapshotNamedFormControls()
    };
  }

  /**
   * Import a settings snapshot previously produced by exportSettings().
   * @override
   * @param {{ selectedPages?: string[], formControls?: Record<string, { type: 'checkbox'|'value', value: string|boolean }> }|null} settings
   */
  importSettings(settings) {
    if (!settings) return;
    const selectedPages = Array.isArray(settings.selectedPages) ? settings.selectedPages : null;
    if (selectedPages) {
      this.onPageSelectionChange([...selectedPages]);
    }
    this._applyNamedFormControls(settings.formControls);
  }

  // ===========================================================================
  // Abstract Methods - MUST be implemented by subclasses
  // ===========================================================================

  /**
   * Get page requirements for this analysis type
   * @static
   * @abstract
   * @returns {{ minPages: number, maxPages?: number, description?: string }}
   */
  static getRequirements() {
    throw new Error('static getRequirements() must be implemented by subclass');
  }

  /**
   * Get the analysis title for display
   * @abstract
   * @returns {string}
   */
  _getTitle() {
    throw new Error('_getTitle() must be implemented by subclass');
  }

  /**
   * Get the analysis description
   * @abstract
   * @returns {string}
   */
  _getDescription() {
    throw new Error('_getDescription() must be implemented by subclass');
  }

  /**
   * Render form-specific controls into the wrapper
   * @abstract
   * @param {HTMLElement} wrapper - Form wrapper element to render into
   */
  _renderFormControls(wrapper) {
    throw new Error('_renderFormControls() must be implemented by subclass');
  }

  /**
   * Extract form values from the form
   * @abstract
   * @returns {Object} Form values object
   */
  _getFormValues() {
    throw new Error('_getFormValues() must be implemented by subclass');
  }

  /**
   * Run the analysis implementation
   * @abstract
   * @param {Object} formValues - Values from _getFormValues()
   * @returns {Promise<Object>} Analysis result object
   */
  async _runAnalysisImpl(formValues) {
    throw new Error('_runAnalysisImpl() must be implemented by subclass');
  }

  // ===========================================================================
  // Optional Override Methods
  // ===========================================================================

  /**
   * Get CSS class prefix for this analysis type
   * Override for custom class names
   * @returns {string}
   */
  _getClassName() {
    return 'form-analysis';
  }

  /**
   * Get loading notification message
   * Override for custom message
   * @returns {string}
   */
  _getLoadingMessage() {
    return 'Running analysis...';
  }

  /**
   * Get success notification message
   * Override for custom message
   * @returns {string}
   */
  _getSuccessMessage() {
    return 'Analysis complete';
  }

  /**
   * Get run button text
   * Override for custom text
   * @returns {string}
   */
  _getRunButtonText() {
    return 'Run Analysis';
  }

  /**
   * Validate form values before running analysis
   * Override for custom validation
   * @param {Object} formValues - Values from _getFormValues()
   * @returns {{ valid: boolean, error?: string }}
   */
  _validateForm(formValues) {
    return { valid: true };
  }

  /**
   * Show analysis result
   * Override for custom result rendering
   * @param {Object} result - Analysis result from _runAnalysisImpl()
   */
  async _showResult(result) {
    // Default implementation - subclasses typically override this
    this._resultContainer.classList.remove('hidden');
    this._resultContainer.innerHTML = '';

    // Result header
    const header = createResultHeader(
      result.title || this._getTitle(),
      result.subtitle
    );
    this._resultContainer.appendChild(header);

    // Placeholder for result content
    const content = document.createElement('div');
    content.className = 'result-content';
    content.innerHTML = '<p>Analysis complete. Override _showResult() for custom rendering.</p>';
    this._resultContainer.appendChild(content);
  }

  // ===========================================================================
  // Modal Support Methods - Matching Detailed Analysis Pattern
  // ===========================================================================

  /**
   * Open expanded modal view with grid layout (Settings, Plot, Stats, Annotations)
   * Matches the Detailed Analysis modal pattern exactly.
   * Subclasses can override the _renderModal* methods for custom content.
   */
  async _openExpandedView() {
    if (!this._lastResult) return;

    // Create modal with export handlers
    this._modal = createAnalysisModal({
      onClose: () => { this._modal = null; },
      onExportPNG: () => this._exportModalPNG(),
      onExportSVG: () => this._exportModalSVG(),
      onExportCSV: () => this._exportModalCSV()
    });

    // Set modal title
    if (this._modal._title) {
      const title = this._lastResult.title || this._getTitle();
      const subtitle = this._lastResult.subtitle || '';
      this._modal._title.textContent = subtitle ? `${title}: ${subtitle}` : title;
    }

    // Render options panel (right side)
    if (this._modal._optionsContent) {
      this._renderModalOptions(this._modal._optionsContent);
    }

    openModal(this._modal);

    // Render plot in modal
    if (this._modal._plotContainer) {
      try {
        await loadPlotly();
        await this._renderModalPlot(this._modal._plotContainer);
      } catch (err) {
        console.error(`[${this.constructor.name}] Modal plot render failed:`, err);
        this._modal._plotContainer.innerHTML = `<div class="analysis-error">Failed to render: ${err.message}</div>`;
      }
    }

    // Render summary stats (bottom left)
    if (this._modal._statsContent) {
      this._renderModalStats(this._modal._statsContent);
    }

    // Render statistical annotations (bottom right)
    if (this._modal._annotationsContent) {
      this._renderModalAnnotations(this._modal._annotationsContent);
    }
  }

  /**
   * Render plot in modal - Override for custom plot rendering
   * @param {HTMLElement} container - Modal plot container
   */
  async _renderModalPlot(container) {
    // Default implementation - subclasses should override
    const result = this._lastResult;
    if (!result?.plotType || !result?.data) {
      container.innerHTML = '<div class="analysis-empty-message">No plot data available</div>';
      return;
    }

    const plotDef = PlotRegistry.get(result.plotType);
    if (!plotDef) {
      container.innerHTML = `<div class="analysis-error">Unknown plot type: ${result.plotType}</div>`;
      return;
    }

    const mergedOptions = PlotRegistry.mergeOptions(result.plotType, result.options || {});
    await renderOrUpdatePlot({
      plotDef,
      data: result.data,
      options: mergedOptions,
      container,
      layoutEngine: null,
      preferUpdate: false
    });
  }

  /**
   * Render options in modal - Override for custom options
   * @param {HTMLElement} container - Modal options container
   */
  _renderModalOptions(container) {
    const result = this._lastResult;
    if (!result?.plotType) {
      const empty = document.createElement('div');
      empty.className = 'legend-help';
      empty.textContent = 'No customization options available.';
      container.innerHTML = '';
      container.appendChild(empty);
      return;
    }

    renderPlotOptions(
      container,
      result.plotType,
      result.options || {},
      this._handlePlotOptionChange
    );
  }

  /**
   * Handle plot option changes from the modal options panel.
   * Keeps the result as source of truth and re-renders modal + preview.
   * @private
   * @param {string} key
   * @param {*} value
   */
  _handlePlotOptionChange(key, value) {
    if (!this._lastResult) return;
    if (!this._lastResult.options) this._lastResult.options = {};

    this._lastResult.options[key] = value;

    // Re-render options panel to respect showWhen conditions
    if (this._modal?._optionsContent && this._lastResult.plotType) {
      renderPlotOptions(
        this._modal._optionsContent,
        this._lastResult.plotType,
        this._lastResult.options,
        this._handlePlotOptionChange
      );
    }

    const revision = ++this._optionRenderRevision;
    void this._rerenderAfterOptionChange(revision);
  }

  /**
   * Re-render plots and dependent panels after option changes.
   * @private
   */
  async _rerenderAfterOptionChange(revision) {
    if (this._isDestroyed) return;
    if (revision !== this._optionRenderRevision) return;

    const result = this._lastResult;
    if (!result?.plotType || !result?.data) return;

    const plotDef = PlotRegistry.get(result.plotType);
    if (!plotDef) return;

    const mergedOptions = PlotRegistry.mergeOptions(result.plotType, result.options || {});

    // Update modal plot (if open)
    if (this._modal?._plotContainer) {
      try {
        await loadPlotly();
        if (this._isDestroyed) return;
        if (revision !== this._optionRenderRevision) return;
        await renderOrUpdatePlot({
          plotDef,
          data: result.data,
          options: mergedOptions,
          container: this._modal._plotContainer,
          layoutEngine: null,
          preferUpdate: true
        });
      } catch (err) {
        console.error(`[${this.constructor.name}] Modal plot re-render failed:`, err);
      }

      if (this._modal?._statsContent) {
        this._renderModalStats(this._modal._statsContent);
      }
      if (this._modal?._annotationsContent) {
        this._renderModalAnnotations(this._modal._annotationsContent);
      }
    }

    // Update inline/preview plot (if present)
    const previewContainer = this._plotContainerId
      ? document.getElementById(this._plotContainerId)
      : null;

    if (previewContainer) {
      try {
        await loadPlotly();
        if (this._isDestroyed) return;
        if (revision !== this._optionRenderRevision) return;
        await renderOrUpdatePlot({
          plotDef,
          data: result.data,
          options: mergedOptions,
          container: previewContainer,
          layoutEngine: null,
          preferUpdate: true
        });
      } catch (err) {
        console.error(`[${this.constructor.name}] Preview plot re-render failed:`, err);
      }
    }
  }

  /**
   * Render statistics in modal - Override for custom stats
   * @param {HTMLElement} container - Modal stats container
   */
  _renderModalStats(container) {
    // Default implementation - empty, subclasses should override
    container.innerHTML = '<p class="modal-stats-placeholder">Statistics not available</p>';
  }

  /**
   * Render statistical annotations in modal - Override for custom annotations
   * @param {HTMLElement} container - Modal annotations container
   */
  _renderModalAnnotations(container) {
    // Default implementation - empty, subclasses should override
    container.innerHTML = '<p class="modal-annotations-placeholder">Statistical analysis not available</p>';
  }

  // ===========================================================================
  // Modal Export Handlers
  // ===========================================================================

  /**
   * Export modal plot as PNG
   */
  async _exportModalPNG() {
    const container = this._modal?._plotContainer;
    if (!container) return;

    try {
      await downloadImage(container, {
        format: 'png',
        width: 1200,
        height: 800,
        filename: `${this._getClassName()}_analysis`
      });
      this._notifications.success('Plot exported as PNG', { category: 'download' });
    } catch (err) {
      this._notifications.error('PNG export failed: ' + err.message, { category: 'download' });
    }
  }

  /**
   * Export modal plot as SVG
   */
  async _exportModalSVG() {
    const container = this._modal?._plotContainer;
    if (!container) return;

    try {
      await downloadImage(container, {
        format: 'svg',
        width: 1200,
        height: 800,
        filename: `${this._getClassName()}_analysis`
      });
      this._notifications.success('Plot exported as SVG', { category: 'download' });
    } catch (err) {
      this._notifications.error('SVG export failed: ' + err.message, { category: 'download' });
    }
  }

  /**
   * Export modal data as CSV - Override for custom CSV format
   */
  _exportModalCSV() {
    // Default implementation - subclasses should override with proper CSV export
    this._notifications.info('CSV export not implemented for this analysis type', { category: 'download' });
  }

  /**
   * Create an expand button for use in result rendering
   * @returns {HTMLElement} Expand button element
   */
  _createExpandButton() {
    return createExpandButton(this._openExpandedView);
  }

  // ===========================================================================
  // Implemented Methods (from BaseAnalysisUI)
  // ===========================================================================

  /**
   * Initialize the analysis UI
   * @param {HTMLElement} container - Container for the UI
   */
  init(container) {
    this._container = container;
    this._render();
  }

  /**
   * Render the complete UI structure
   * @override
   */
  _render() {
    if (!this._container) return;

    this._container.innerHTML = '';
    // Use classList.add to preserve original classes (e.g., analysis-accordion-content)
    this._container.classList.add(`${this._getClassName()}-panel`);

    // Intro section
    const intro = document.createElement('div');
    intro.className = 'analysis-intro';
    intro.innerHTML = `
      <h3>${this._getTitle()}</h3>
      <p>${this._getDescription()}</p>
    `;
    this._container.appendChild(intro);

    // Form container
    this._formContainer = document.createElement('div');
    this._formContainer.className = `${this._getClassName()}-form-container`;
    this._container.appendChild(this._formContainer);

    // Result container (hidden initially)
    this._resultContainer = document.createElement('div');
    this._resultContainer.className = `${this._getClassName()}-result-container hidden`;
    this._container.appendChild(this._resultContainer);

    // Render form controls
    this._renderControls();
  }

  /**
   * Render the control panel (form)
   * @override
   */
  _renderControls() {
    this._formContainer.innerHTML = '';

    // Validate page requirements
    const requirements = this.constructor.getRequirements();
    const validation = validatePageRequirements(this._selectedPages, requirements);

    if (!validation.valid) {
      const notice = createNotice(
        validation.error || getRequirementText(requirements)
      );
      this._formContainer.appendChild(notice);
      return;
    }

    // Create form wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'analysis-form';

    // Let subclass render form controls
    this._renderFormControls(wrapper);

    // Run button
    const runBtn = createFormButton(
      this._getRunButtonText(),
      () => this._runAnalysis(),
      { className: 'btn-primary analysis-run-btn' }
    );
    wrapper.appendChild(runBtn);

    this._formContainer.appendChild(wrapper);
  }

  /**
   * Run the analysis with loading state management
   */
  async _runAnalysis() {
    if (this._isDestroyed) return;
    // Get form values
    const formValues = this._getFormValues();

    // Validate form
    const validation = this._validateForm(formValues);
    if (!validation.valid) {
      this._notifications.error(validation.error || 'Invalid form values');
      return;
    }

    // Get run button for state management
    const runBtn = this._formContainer.querySelector('.analysis-run-btn');

    try {
      const result = await runAnalysisWithLoadingState({
        component: this,
        runButton: runBtn,
        loadingMessage: this._getLoadingMessage(),
        successMessage: this._getSuccessMessage(),
        analysisFunction: () => this._runAnalysisImpl(formValues)
      });

      if (result) {
        if (this._isDestroyed) return;
        // Store result
        this._lastResult = result;

        // Store for base class export
        this._currentPageData = result.data || result;

        // Show result
        await this._showResult(result);

        // Callback
        if (this.onResultChange) {
          this.onResultChange(result);
        }
      }
    } catch (error) {
      console.error(`[${this.constructor.name}] Analysis error:`, error);
    }
  }

  // ===========================================================================
  // Page Selection
  // ===========================================================================

  /**
   * Update when page selection changes
   * @param {string[]} pageIds - Selected page IDs
   */
  onPageSelectionChange(pageIds) {
    this._selectedPages = pageIds || [];
    this._currentConfig.pages = this._selectedPages;
    this._renderControls();

    // Hide result when pages change
    if (this._resultContainer) {
      this._resultContainer.classList.add('hidden');
    }
  }

  // ===========================================================================
  // Public API - Note: getLastResult(), getSelectedPages(), isLoading() are inherited from BaseAnalysisUI
  // ===========================================================================

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  /**
   * Destroy and cleanup
   * @override
   */
  destroy() {
    this._isDestroyed = true;
    // Purge any preview plot to release Plotly/WebGL resources before DOM removal.
    try {
      const plotEl = this._plotContainerId
        ? document.getElementById(this._plotContainerId)
        : this._container?.querySelector?.('.analysis-preview-plot');
      if (plotEl) purgePlot(plotEl);
    } catch (_err) {
      // Ignore purge errors during teardown
    }

    // Close modal if open
    if (this._modal) {
      closeModal(this._modal);
      this._modal = null;
    }
    // Clear form-specific state
    this._formContainer = null;
    this._resultContainer = null;
    this._plotContainerId = null;
    // Base class handles _selectedPages, _lastResult, _isLoading
    super.destroy();
  }
}

/**
 * Factory function to create form-based analysis UI
 * @param {Function} UIClass - Subclass of FormBasedAnalysisUI
 * @param {Object} options - Options for the UI
 * @returns {FormBasedAnalysisUI}
 */
export function createFormBasedAnalysisUI(UIClass, options) {
  return new UIClass(options);
}

export default FormBasedAnalysisUI;
