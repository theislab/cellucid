/**
 * FormBasedAnalysisUI - the one form mechanism of every analysis with a Run
 * button (marker genes, differential expression, gene signature,
 * correlation, composition, dot plot).
 *
 * The form is drawn from the analysis's options schema
 * (`options/option-schema.js`, `options/render-options-form.js`): its
 * essentials, then "More options" in collapsed groups, then the Run row (one
 * muted line saying why Run is disabled, when it is, and the Run button;
 * nothing under it). The options are one validated record
 * (`this._options`); sessions save `{options, selectedPages, view}`. Typing
 * never runs anything. An option change re-applies a display option to the
 * shown result, or marks the result stale (dimmed, with a "Stale · Run"
 * chip) until the next run.
 *
 * Subclasses implement:
 * - static getRequirements() - { minPages, maxPages, description }
 * - _getTitle()
 * - _getOptionsSchema() - the analysis's schema
 * - _runAnalysisImpl(options, requestId, job) - the result `{ data, ... }`,
 *   or null when superseded
 * - _showResult(result, requestId) - render the completed result
 *
 * Subclasses may implement:
 * - _getOptionsContext() - what the data offers the schema (default {})
 * - _renderFormLead(wrapper) - controls above the options (a page selector)
 * - _getRunNoun() - Run's accessible name is "Run <noun>"
 * - _getRunBlocker(options) - why Run is disabled, or null
 * - _isDisplayOption(key) / _rebuildForDisplay(options) - options that
 *   re-render the shown result without recomputing it
 * - _exportViewState() / _importViewState(view) - viewer state saved in the
 *   session's `view` record beside the open disclosures
 * - _getExtraSettingKeys() / _exportExtraSettings() / _importExtraSettings()
 * - _getSuccessMessage(), _getClassName(), and the _renderModal* methods
 *
 * @module analysis-types/base/form-based-analysis
 */

import { BaseAnalysisUI } from '../../base-analysis-ui.js';
import { createButton, createStatusLine } from '../../../../ui/components/controls.js';
import { renderOptionsForm } from '../../../options/render-options-form.js';
import { sameOptionValue } from '../../../options/option-schema.js';
import {
  createAnalysisModal,
  openModal,
  closeModal,
  createExpandButton,
  renderPlotOptions
} from '../../components/index.js';
import {
  applyFormControlAccessibility
} from '../../components/control-accessibility.js';
import { selectablePageIdSet } from '../../../shared/page-derivation-utils.js';
import { loadPlotly, downloadImage } from '../../../plots/plotly-loader.js';
import { PlotRegistry } from '../../../shared/plot-registry-utils.js';
import { PlotlyRenderSlot } from '../../../shared/plotly-render-slot.js';
import { isPlainRecord, requireExactKeys } from '../../../../../utils/exact-record.js';

function requirePageIds(pageIds) {
  if (!Array.isArray(pageIds)) {
    throw new TypeError('Form-based analysis selectedPages must be an array');
  }
  const seen = new Set();
  for (const pageId of pageIds) {
    if (typeof pageId !== 'string' || pageId.length === 0) {
      throw new TypeError(
        'Form-based analysis selectedPages must contain non-empty string IDs'
      );
    }
    if (seen.has(pageId)) {
      throw new TypeError(
        `Form-based analysis page "${pageId}" is selected more than once`
      );
    }
    seen.add(pageId);
  }
}

function requireView(view) {
  if (!isPlainRecord(view) || !isPlainRecord(view.disclosures)) {
    throw new TypeError('Form-based analysis view must hold its disclosures');
  }
  const { disclosures } = view;
  requireExactKeys(disclosures, ['groups', 'more'], 'Form-based analysis view disclosures');
  if (typeof disclosures.more !== 'boolean' || !Array.isArray(disclosures.groups) ||
      disclosures.groups.some(id => typeof id !== 'string')) {
    throw new TypeError('Form-based analysis view disclosures must be { more: boolean, groups: string[] }');
  }
}

function combineErrors(errors, message) {
  const present = [...new Set(errors.filter(Boolean))];
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  return new AggregateError(present, message);
}

async function throwAfterModalCleanup(owner, modal, primaryError, context) {
  if (owner._modal === modal) owner._modal = null;
  try {
    await closeModal(modal);
  } catch (cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `${context} failed and modal teardown also failed`
    );
  }
  throw primaryError;
}

function throwAfterExportFailureNotification(
  notifications,
  primaryError,
  format
) {
  let notificationError = null;
  try {
    if (
      !(primaryError instanceof Error) ||
      typeof primaryError.message !== 'string' ||
      primaryError.message.length === 0 ||
      primaryError.message !== primaryError.message.trim()
    ) {
      throw new TypeError('Analysis export failures must be exact Error instances');
    }
    if (!notifications || typeof notifications.error !== 'function') {
      throw new TypeError('Analysis exports require an error notification owner');
    }
    notifications.error(
      `${format} export failed: ${primaryError.message}`,
      { category: 'download' }
    );
  } catch (error) {
    notificationError = error;
  }
  if (notificationError !== null) {
    throw new AggregateError(
      [primaryError, notificationError],
      `${format} export and failure notification both failed`
    );
  }
  throw primaryError;
}

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
    this._modalPlotSlot = null;
    this._previewPlotHost = null;
    this._previewPlotSlot = null;
    this._pendingModalCloseTasks = new Set();
    this._formDestroyTasks = new Set();
    this._destroyPromise = null;
    this._requestedPlotOptions = null;

    // Bind methods
    this._openExpandedView = this._openExpandedView.bind(this);
    this._handlePlotOptionChange = this._handlePlotOptionChange.bind(this);

    // Prevent overlapping re-renders on rapid option changes
    this._optionRenderRevision = 0;

    /** @type {Object|null} The validated options record (the schema's). */
    this._options = null;
    /** @type {{more: boolean, groups: string[]}} Open "More options" disclosures. */
    this._disclosures = { more: false, groups: [] };
    /** @type {ReturnType<typeof renderOptionsForm>|null} */
    this._optionsForm = null;
    /** The options and pages the shown result was computed with. */
    this._resultInputs = null;
    /** Highlight changes since the shown result was computed. */
    this._highlightRevision = 0;
    /**
     * The visible cells' digest (`_visibleCellsDigest`) the form was last
     * brought up to date for: the input of an analysis scoped to "Visible
     * cells" (`_scopesByVisibleCells`), which moves only when the set of
     * visible cells does, not on every visibility pass (a recolour runs one).
     */
    this._seenVisibleDigest = null;
    /** `_visibleCellsDigest`'s last answer and what it read. */
    this._visibleDigestCache = null;
    /** Changes recorded while another mode was shown (`noteHiddenChange`). */
    this._missedInputChange = false;
    /** Display redraws: the latest one's token is current. */
    this._displayRevision = 0;
    this._runRow = null;

    /** The gene loader last asked for highly variable genes, and its answer. */
    this._highlyVariable = { loader: null, marked: false };
    // Note: _selectedPages, _lastResult, and _isLoading are inherited from BaseAnalysisUI
  }

  // ===========================================================================
  // Options
  // ===========================================================================

  /**
   * The options schema of this analysis.
   * @abstract
   * @returns {ReturnType<import('../../../options/option-schema.js').defineOptions>}
   */
  _getOptionsSchema() {
    throw new Error('_getOptionsSchema() must be implemented by subclass');
  }

  /**
   * What the data offers the options (fields, groups, genes, pages).
   * @returns {Object}
   */
  _getOptionsContext() {
    return {};
  }

  /** The options record, created from the defaults on first use. */
  _requireOptions() {
    if (this._options === null) {
      this._options = this._getOptionsSchema().defaults(this._getOptionsContext());
    }
    return this._options;
  }

  /**
   * Replace the options (a restored session, a preset): validated by the
   * schema, shown in the form.
   * @param {Object} options
   * @protected
   */
  _setOptions(options) {
    const schema = this._getOptionsSchema();
    this._options = schema.normalize(options, this._getOptionsContext());
    this._optionsForm?.setValue(this._options);
    this._handleOptionsChanged(null);
  }

  /** The data changed: dependent choices are reconciled and the form redrawn. @protected */
  _refreshOptionsContext() {
    if (this._optionsForm !== null) {
      this._options = this._optionsForm.setContext(this._getOptionsContext());
    } else if (this._options !== null) {
      this._options = this._reconcileOptions(this._getOptionsContext());
    }
    this._updateRunRow();
  }

  /**
   * The record with each value the data no longer offers (a field gone after
   * a dataset change) back at its default; every other choice is kept.
   * @private
   */
  _reconcileOptions(context) {
    const schema = this._getOptionsSchema();
    if (schema.validate(this._options, context).valid) return this._options;
    return schema.normalize(
      Object.fromEntries(schema.keys.map(key => [
        key,
        schema.refuse(key, this._options[key], this._options, context) === null
          ? this._options[key]
          : schema.defaultOf(key, context)
      ])),
      context
    );
  }

  /**
   * Whether the data mapping marks highly variable genes (the "Only genes
   * in: Highly variable" choice). Asked of each gene loader once: the first
   * call starts the read and answers false; the answer redraws the form. A
   * changed mapping makes a new loader, which is asked again.
   * @protected
   */
  _highlyVariableAvailable() {
    const loader = this.dataLayer.state?.varFieldLoader ?? null;
    if (loader !== this._highlyVariable.loader) {
      this._highlyVariable = { loader, marked: false };
      if (loader !== null) {
        void loader.highlyVariableGenes().then(genes => {
          if (this._isDestroyed || this._highlyVariable.loader !== loader) return;
          this._highlyVariable = { loader, marked: Array.isArray(genes) && genes.length > 0 };
          if (this._highlyVariable.marked) this._refreshOptionsContext();
        }, error => {
          if (this._isDestroyed || this._highlyVariable.loader !== loader) return;
          this._notifications.error(`Highly variable genes could not be read: ${error.message}`, { category: 'analysis' });
        });
      }
    }
    return this._highlyVariable.marked;
  }

  /** Whether an option only changes how the shown result is drawn. @protected */
  _isDisplayOption(key) {
    return false;
  }

  /**
   * The shown result rebuilt for new display options (filters, ranking,
   * rescaling), from what the shown result holds: nothing is read or
   * computed again. Null when there is nothing to redraw.
   * @param {Object} options
   * @returns {Promise<Object|null>|Object|null}
   * @protected
   */
  _rebuildForDisplay(options) {
    return null;
  }

  /**
   * Redraw the shown result for the current display options. Render only: it
   * never starts an analysis request, so it cannot supersede a run; while a
   * run is in progress it does nothing (the run applies the latest display
   * options when it publishes). Its own token (`{display}`) is current until
   * the next redraw or run.
   * @returns {Promise<void>}
   * @protected
   */
  async _redrawForDisplay() {
    if (this._isDestroyed || this._isLoading || this._lastResult === null) return;
    const token = { display: ++this._displayRevision };
    const rebuilt = await this._rebuildForDisplay(structuredClone(this._options));
    if (rebuilt === null || rebuilt === undefined || !this._isCurrentAnalysisRequest(token)) return;
    await this._showResult(rebuilt, token);
    if (!this._isCurrentAnalysisRequest(token)) return;
    await this._publishAnalysisResult(rebuilt, token);
    this._updateStale();
  }

  /**
   * A display redraw's token is current until the next redraw or run; an
   * analysis request id, as the base class says.
   * @override
   */
  _isCurrentAnalysisRequest(requestId) {
    if (requestId !== null && typeof requestId === 'object' && Number.isSafeInteger(requestId.display)) {
      return (
        !this._isDestroyed &&
        requestId.display === this._displayRevision &&
        this._activeAnalysisRequestId === null
      );
    }
    return super._isCurrentAnalysisRequest(requestId);
  }

  /** Why Run is disabled for these options, or null. @protected */
  _getRunBlocker(options) {
    return null;
  }

  /** Run's accessible name is "Run <noun>". @protected */
  _getRunNoun() {
    return this._getTitle().toLowerCase();
  }

  /** Controls drawn above the options (a page selector). @protected */
  _renderFormLead(wrapper) {}

  /** Add to the rendered options form (a swap beside two choices). @protected */
  _decorateOptionsForm(form) {}

  /** The subclass's own viewer state, saved in the session `view` record. @protected */
  _exportViewState() {
    return {};
  }

  /** Restore what `_exportViewState` saved. @protected */
  _importViewState(view) {}

  /** Settings keys a subclass adds beside options, selectedPages and view. @protected */
  _getExtraSettingKeys() {
    return [];
  }

  /** @protected */
  _exportExtraSettings() {
    return {};
  }

  /** @protected */
  _importExtraSettings(settings) {}

  /**
   * An option changed (key null: several at once). A display option is
   * re-applied to the shown result; anything else marks it stale.
   * @private
   */
  _handleOptionsChanged(key) {
    this._updateRunRow();
    if (this._lastResult === null || this._resultInputs === null) return;
    // Display options that changed are re-applied to the shown result; any
    // other change leaves it stale until the next run.
    const shown = this._resultInputs.options;
    const displayChanged = this._getOptionsSchema().keys.filter(name =>
      this._isDisplayOption(name) && !sameOptionValue(shown[name], this._options[name]));
    if (displayChanged.length > 0 && !this._isLoading) {
      this._resultInputs.options = {
        ...shown,
        ...Object.fromEntries(displayChanged.map(name => [name, this._options[name]]))
      };
      this._trackInteractiveTask(this._redrawForDisplay(), `${this._getTitle()} display`);
    }
    this._updateStale();
  }

  /** Whether the shown result was computed from other inputs than the form's. */
  _isResultStale() {
    if (this._lastResult === null || this._resultInputs === null) return false;
    const { options, pages, highlightRevision, visibleDigest } = this._resultInputs;
    if (highlightRevision !== this._highlightRevision) return true;
    if (this._scopesByVisibleCells(options) && visibleDigest !== this._visibleCellsDigest()) return true;
    if (!sameOptionValue(pages, [...this._selectedPages])) return true;
    const schema = this._getOptionsSchema();
    return schema.keys.some(key => !this._isDisplayOption(key) && !sameOptionValue(options[key], this._options[key]));
  }

  /** Dim the shown result and offer a run when it no longer matches the form. @private */
  _updateStale() {
    const container = this._resultContainer;
    if (!(container instanceof HTMLElement)) return;
    const stale = this._isResultStale();
    container.classList.toggle('analysis-result-stale', stale);
    let chip = container.querySelector(':scope > .analysis-stale-chip');
    if (!stale) {
      if (chip !== null) chip.remove();
      return;
    }
    if (chip === null) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'analysis-chip analysis-chip-warning analysis-stale-chip';
      chip.textContent = 'Stale · Run';
      chip.title = 'The settings or pages changed since this result: run again';
      chip.addEventListener('click', () => this._runAgain());
      container.prepend(chip);
    }
  }

  /** Disable Run with its reason when the options cannot run. @private */
  _updateRunRow() {
    if (this._runRow === null || this._options === null) return;
    const { button, reason } = this._runRow;
    const blocker = this._isLoading ? null : this._getRunBlocker(this._options);
    if (button.dataset.running !== 'true') button.disabled = blocker !== null;
    reason.hidden = blocker === null;
    reason.textContent = blocker ?? '';
    if (blocker === null) button.removeAttribute('title');
    else button.title = blocker;
  }

  /**
   * Export a settings-only snapshot for cloning/copying and sessions.
   * Results are exported by `exportResult`.
   * @override
   */
  exportSettings() {
    requirePageIds(this._selectedPages);
    return {
      options: structuredClone(this._requireOptions()),
      selectedPages: [...this._selectedPages],
      view: {
        disclosures: structuredClone(this._optionsForm?.getView() ?? this._disclosures),
        ...this._exportViewState()
      },
      ...this._exportExtraSettings()
    };
  }

  /**
   * Validate a settings record (exactly `{options, selectedPages, view}` plus
   * the subclass's extra keys) without applying it.
   * @protected
   */
  _requireSettings(settings) {
    requireExactKeys(
      settings,
      ['options', 'selectedPages', 'view', ...this._getExtraSettingKeys()],
      `${this._getTitle()} settings`
    );
    requirePageIds(settings.selectedPages);
    const pages = this.dataLayer.getPages();
    if (!Array.isArray(pages)) {
      throw new TypeError('Form-based analysis page inventory must be an array');
    }
    const availablePageIds = selectablePageIdSet(pages);
    for (const pageId of settings.selectedPages) {
      if (!availablePageIds.has(pageId)) {
        throw new Error(`Form-based analysis page "${pageId}" was not found`);
      }
      if (this.dataLayer.getCellCountForPageId(pageId) === 0) {
        throw new RangeError(
          `Form-based analysis page "${pageId}" has zero cells and cannot be selected`
        );
      }
    }
    requireView(settings.view);
    const options = this._getOptionsSchema().normalize(settings.options, this._getOptionsContext());
    return { ...settings, options };
  }

  /**
   * Validate custom page colors against the shared selectable page domain
   * (the one `_requireSettings` judges `selectedPages` by): a session cannot
   * hold a page it may select and may not colour.
   *
   * @param {unknown} entries
   * @returns {Array<[string, string]>}
   * @protected
   */
  _requireCustomPageColors(entries) {
    if (!Array.isArray(entries)) {
      throw new TypeError('Custom page colors must be an array');
    }
    if (!this._pageSelector) {
      throw new Error('Custom page color settings require an initialized page selector');
    }
    const pages = this.dataLayer.getPages();
    if (!Array.isArray(pages)) {
      throw new TypeError('Form-based analysis page inventory must be an array');
    }
    const availablePageIds = selectablePageIdSet(pages);
    const colors = [];
    const seenPageIds = new Set();
    for (const entry of entries) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        entry[0].length === 0 ||
        typeof entry[1] !== 'string' ||
        !/^#[0-9a-fA-F]{6}$/.test(entry[1])
      ) {
        throw new TypeError('Custom page colors must contain [pageId, #rrggbb] pairs');
      }
      const [pageId, color] = entry;
      if (!availablePageIds.has(pageId)) {
        throw new Error(`Custom color page "${pageId}" was not found`);
      }
      if (seenPageIds.has(pageId)) {
        throw new TypeError(`Page "${pageId}" has more than one custom color`);
      }
      seenPageIds.add(pageId);
      colors.push([pageId, color]);
    }
    return colors;
  }

  /**
   * Apply validated custom colors through the selector's exact state boundary.
   * @param {Array<[string, string]>} colors
   * @protected
   */
  _applyCustomPageColors(colors) {
    if (!this._pageSelector) {
      throw new Error('Custom page color settings require an initialized page selector');
    }
    const state = this._pageSelector.exportState();
    this._pageSelector.importState({
      mode: state.mode,
      selectedPages: state.selectedPages,
      customColors: colors
    });
  }

  /**
   * Import a settings snapshot produced by exportSettings().
   * @override
   */
  importSettings(settings) {
    const validated = this._requireSettings(settings);
    const { disclosures, ...viewState } = validated.view;
    this._disclosures = { more: disclosures.more, groups: [...disclosures.groups] };
    this._options = validated.options;
    this._importExtraSettings(validated);
    this._importViewState(viewState);
    this.onPageSelectionChange([...validated.selectedPages]);
  }

  /**
   * Open with preset options (`ComparisonModule.openAnalysis`): the
   * defaults with the preset's options over them, and its pages if it names
   * them.
   * @param {{options?: Object, selectedPages?: string[]}} preset
   */
  async applyPreset(preset) {
    if (!isPlainRecord(preset)) throw new TypeError(`${this._getTitle()} preset must be an object`);
    for (const key of Object.keys(preset)) {
      if (key !== 'options' && key !== 'selectedPages') {
        throw new TypeError(`${this._getTitle()} preset has no "${key}"`);
      }
    }
    const options = this._getOptionsSchema().withDefaults(preset.options ?? {}, this._getOptionsContext());
    if (preset.selectedPages !== undefined) {
      requirePageIds(preset.selectedPages);
      this.onPageSelectionChange([...preset.selectedPages]);
    }
    this._setOptions(options);
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
   * Render form-specific controls into the wrapper
   * @abstract
   * @param {HTMLElement} wrapper - Form wrapper element to render into
   */
  _renderFormControls(wrapper) {
    throw new Error('_renderFormControls() must be implemented by subclass');
  }

  /**
   * Run the analysis implementation
   * @abstract
   * @param {Object} options - The validated options record
   * @param {number} requestId - Current analysis request generation
   * @param {import('../../../../jobs/cancellable-job.js').CancellableJob} job
   * @returns {Promise<Object|null>} Analysis result object
   */
  async _runAnalysisImpl(options, requestId, job) {
    throw new Error('_runAnalysisImpl() must be implemented by subclass');
  }

  // ===========================================================================
  // Default and Optional Override Methods
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
   * Get success notification message
   * Override for custom message
   * @returns {string}
   */
  _getSuccessMessage() {
    return 'Analysis complete';
  }

  /**
   * Show analysis result
   * @abstract
   * @param {Object} result - Analysis result from _runAnalysisImpl()
   * @param {number} requestId - Current analysis request generation
   */
  async _showResult(result, requestId) {
    throw new Error('_showResult() must be implemented by subclass');
  }

  _reportPlotResizeError(error) {
    if (!(error instanceof Error)) {
      error = new TypeError('Analysis plot resize failed with a non-Error value');
    }
    this._notifications.error(
      `Plot resize failed: ${error.message}`,
      { category: 'analysis', title: 'Analysis error' }
    );
  }

  _createOwnedPlotSlot(host, candidateClassName) {
    return new PlotlyRenderSlot({
      host,
      candidateClassName,
      onResizeError: error => this._reportPlotResizeError(error)
    });
  }

  async _ensurePreviewPlotSlot({
    containerId,
    height = null,
    minWidth = null
  }) {
    if (!(this._resultContainer instanceof HTMLElement)) {
      throw new TypeError(
        'Analysis preview requires an initialized result container'
      );
    }
    if (
      typeof containerId !== 'string' ||
      containerId.length === 0 ||
      containerId.trim() !== containerId
    ) {
      throw new TypeError('Analysis preview container ID must be exact text');
    }
    if (height !== null && (!Number.isFinite(height) || height <= 0)) {
      throw new RangeError('Analysis preview height must be positive');
    }
    if (minWidth !== null && (!Number.isFinite(minWidth) || minWidth <= 0)) {
      throw new RangeError('Analysis preview minimum width must be positive');
    }
    // A plot that needs more room than the panel gives (every name of a dot
    // plot) is drawn wider, and its frame scrolls across.
    const sizeHost = host => {
      if (height !== null) host.style.height = `${height}px`;
      host.style.minWidth = minWidth === null ? '' : `${minWidth}px`;
    };

    if (
      this._previewPlotSlot != null &&
      this._previewPlotHost?.isConnected !== false &&
      this._previewPlotHost?.parentNode?.parentNode === this._resultContainer
    ) {
      sizeHost(this._previewPlotHost);
      return this._previewPlotSlot;
    }

    if (this._previewPlotSlot != null) {
      await this._previewPlotSlot.destroy();
      this._previewPlotSlot = null;
      this._previewPlotHost = null;
    }

    this._resultContainer.innerHTML = '';
    const previewContainer = document.createElement('div');
    previewContainer.className = 'analysis-preview-container';

    const host = document.createElement('div');
    host.className = 'analysis-preview-plot-host';
    host.id = containerId;
    sizeHost(host);
    previewContainer.appendChild(host);
    this._resultContainer.appendChild(previewContainer);

    const slot = this._createOwnedPlotSlot(host, 'analysis-preview-plot');
    this._previewPlotHost = host;
    this._previewPlotSlot = slot;
    this._plotContainerId = containerId;
    return slot;
  }

  /**
   * Render an analysis preview and, once it has a plot, the control that opens
   * the full view.
   *
   * The expand affordance used to be each subclass's own business: DE, Marker
   * Genes and Gene Signature each appended an identical `.analysis-actions` row
   * after calling this method, while Correlation asked only for the preview
   * container's `clickable` shortcut — a bare click listener on a `<div>` with
   * `tabindex="-1"` and no role. Correlation's expanded view was therefore
   * unreachable by keyboard and unannounced. The affordance belongs to the
   * preview, so it is rendered here, once, for every mode.
   *
   * @param {Object} options
   * @param {Object} options.result - Analysis result to plot.
   * @param {number} options.requestId - Owning analysis request.
   * @param {string} options.containerId - Exact id for the plot host.
   * @param {boolean} [options.expandable=false] - Offer the full-view control.
   * @param {number|null} [options.height=null] - Fixed preview height in px.
   * @param {number|null} [options.minWidth=null] - The narrowest the plot is
   *   drawn, in px: a narrower panel scrolls it across.
   * @param {Function} [options.onRendered] - Plot-slot render callback.
   * @returns {Promise<HTMLElement|null>} The rendered candidate, or null.
   */
  async _renderPreviewPlot({
    result,
    requestId,
    containerId,
    expandable = false,
    height = null,
    minWidth = null,
    onRendered
  }) {
    if (typeof expandable !== 'boolean') {
      throw new TypeError('Analysis preview expandable must be a boolean');
    }
    if (!this._isCurrentAnalysisRequest(requestId)) return null;
    if (
      result === null ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      typeof result.plotType !== 'string' ||
      result.plotType.length === 0
    ) {
      throw new TypeError(
        'Analysis preview requires an exact result and plot type'
      );
    }
    const plotDef = PlotRegistry.get(result.plotType);
    if (!plotDef) {
      throw new RangeError(`Unknown analysis plot type: ${result.plotType}`);
    }
    const mergedOptions = PlotRegistry.mergeOptions(
      result.plotType,
      structuredClone(result.options || {})
    );
    const slot = await this._ensurePreviewPlotSlot({
      containerId,
      height,
      minWidth
    });
    if (!this._isCurrentAnalysisRequest(requestId)) return null;

    this._resultContainer.hidden = false;
    const candidate = await slot.render(
      {
        render: async plotCandidate => {
          await loadPlotly();
          return plotDef.render(
            result.data,
            mergedOptions,
            plotCandidate,
            null
          );
        },
        onRendered
      },
      {
        isCurrent: () => this._isCurrentAnalysisRequest(requestId)
      }
    );
    if (candidate === null) return null;
    if (expandable && this._isCurrentAnalysisRequest(requestId)) {
      this._renderPreviewExpandAction();
    }
    return candidate;
  }

  /**
   * Put the full-view control below the preview it opens.
   *
   * `.analysis-actions` already carries the row's layout, so nothing here sets
   * geometry inline.
   *
   * @returns {HTMLButtonElement} The rendered expand button.
   * @protected
   */
  _renderPreviewExpandAction() {
    if (!(this._resultContainer instanceof HTMLElement)) {
      throw new TypeError(
        'Analysis preview requires an initialized result container'
      );
    }
    const priorActions = this._resultContainer.querySelector('.analysis-actions');
    if (priorActions !== null) priorActions.remove();

    const actions = document.createElement('div');
    actions.className = 'analysis-actions';
    const expandBtn = this._createExpandButton();
    expandBtn.title = 'Open in full view with statistics and export options';
    actions.appendChild(expandBtn);
    this._resultContainer.appendChild(actions);
    return expandBtn;
  }

  _trackModalCloseTask(task) {
    if (!task || typeof task.then !== 'function') {
      return Promise.resolve(task);
    }
    this._pendingModalCloseTasks ??= new Set();
    this._pendingModalCloseTasks.add(task);
    task.then(
      () => this._pendingModalCloseTasks.delete(task),
      () => this._pendingModalCloseTasks.delete(task)
    );
    return task;
  }

  _registerFormDestroyTask(task) {
    if (!task || typeof task.then !== 'function') {
      return Promise.resolve(task);
    }
    this._formDestroyTasks ??= new Set();
    const ownedTask = Promise.resolve(task);
    this._formDestroyTasks.add(ownedTask);
    void ownedTask.catch(() => {});
    return ownedTask;
  }

  _destroyModalPlotOwner(modal) {
    const slot = modal?._analysisPlotSlot ?? null;
    if (this._modal === modal) this._modal = null;
    if (this._modalPlotSlot === slot) this._modalPlotSlot = null;
    modal._analysisPlotSlot = null;
    if (slot === null) return Promise.resolve();
    const task = slot.destroy();
    return this._trackModalCloseTask(task);
  }

  _ensureModalPlotSlot(modal) {
    if (!(modal?._plotContainer instanceof HTMLElement)) {
      throw new TypeError(
        'Analysis modal must provide the _plotContainer element'
      );
    }
    if (modal._analysisPlotSlot !== null &&
        modal._analysisPlotSlot !== undefined) {
      this._modalPlotSlot = modal._analysisPlotSlot;
      return modal._analysisPlotSlot;
    }
    const slot = this._createOwnedPlotSlot(
      modal._plotContainer,
      'analysis-modal-plot-candidate'
    );
    modal._analysisPlotSlot = slot;
    this._modalPlotSlot = slot;
    // Whoever creates the slot owns its teardown: closing waits for a
    // running render to settle before the modal is cleaned up.
    if (modal._beforeClose == null) {
      modal._beforeClose = () => this._destroyModalPlotOwner(modal);
    }
    return slot;
  }

  _createModalCloseErrorHandler() {
    return error => {
      if (!(error instanceof Error)) {
        error = new TypeError(
          'Analysis modal close failed with a non-Error value'
        );
      }
      this._notifications.error(
        `Expanded view cleanup failed: ${error.message}`,
        { category: 'analysis', title: 'Analysis cleanup error' }
      );
    };
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
    const result = this._lastResult;
    if (!result) {
      throw new Error(
        'Expanded analysis view requires a completed analysis result'
      );
    }

    let modal = null;
    modal = createAnalysisModal({
      beforeClose: () => this._destroyModalPlotOwner(modal),
      onClose: () => {
        if (this._modal === modal) {
          this._modal = null;
          this._cancelChunkedTableRender();
        }
      },
      onCloseError: this._createModalCloseErrorHandler(),
      onExportPNG: () => this._trackInteractiveTask(
        this._exportModalPNG(),
        'PNG export'
      ),
      onExportSVG: () => this._trackInteractiveTask(
        this._exportModalSVG(),
        'SVG export'
      ),
      onExportCSV: () => this._trackInteractiveTask(
        Promise.resolve().then(() => this._exportModalCSV()),
        'CSV export'
      )
    });
    this._modal = modal;

    try {
      for (const field of [
        '_annotationsContent',
        '_body',
        '_optionsContent',
        '_plotContainer',
        '_statsContent',
        '_title'
      ]) {
        if (!(modal[field] instanceof HTMLElement)) {
          throw new TypeError(
            `Analysis modal must provide the ${field} element`
          );
        }
      }

      openModal(modal);

      const rendered = await this._renderExpandedViewContent(modal, result);
      // An unrendered view is closed only when its result was discarded and
      // nothing replaced it. A newer result supersedes this render but owns
      // the same overlay: `_publishAnalysisResult()` is drawing it right now.
      if (!rendered && this._modal === modal && this._lastResult === null) {
        await closeModal(modal);
      }
    } catch (error) {
      await throwAfterModalCleanup(
        this,
        modal,
        error,
        `${this.constructor.name} expanded analysis view`
      );
    }
  }

  /**
   * Draw one result into an already-open expanded view.
   *
   * Everything the overlay shows comes from the result it is given: title,
   * options panel, plot, summary statistics and annotations. Keeping them in
   * one place is what lets the overlay be *re-drawn* when a new result arrives,
   * instead of only when it is first opened.
   *
   * The overlay body is `aria-busy` for the whole render, Plotly loading
   * included.
   *
   * @param {Object} modal - The open analysis modal.
   * @param {Object} result - The result to draw.
   * @returns {Promise<boolean>} False when ownership changed mid-render.
   * @protected
   */
  async _renderExpandedViewContent(modal, result) {
    return this._whileBusy(
      modal._body,
      () => this._drawExpandedViewContent(modal, result)
    );
  }

  /** @private */
  async _drawExpandedViewContent(modal, result) {
    const title = result.title || this._getTitle();
    const subtitle = result.subtitle || '';
    modal._title.textContent = subtitle ? `${title}: ${subtitle}` : title;

    // Render options panel (right side)
    this._renderModalOptions(modal._optionsContent);

    await loadPlotly();
    if (
      this._isDestroyed ||
      this._modal !== modal ||
      this._lastResult !== result
    ) {
      return false;
    }

    await this._renderModalPlot(modal._plotContainer, {
      isCurrent: () => (
        !this._isDestroyed &&
        this._modal === modal &&
        this._lastResult === result
      ),
      modal,
      result
    });
    if (this._modal !== modal || this._lastResult !== result) return false;

    // Render summary stats (bottom left)
    this._renderModalStats(modal._statsContent);

    // Render statistical annotations (bottom right)
    this._renderModalAnnotations(modal._annotationsContent);
    return true;
  }

  /**
   * Show a result restored from a session through the same render and
   * publication path a fresh run takes, so the two draw identically.
   *
   * @param {Object} result - The decoded result, shaped as `_runAnalysisImpl`
   *   returns it.
   * @param {Object} [options]
   * @param {() => void} [options.beforePublish] - Restores the state a run
   *   sets beside its result, after the render and before publication.
   * @returns {Promise<void>}
   * @protected
   */
  async _restoreAnalysisResult(result, { beforePublish = null } = {}) {
    if (this._isDestroyed) {
      throw new Error(`${this.constructor.name} was destroyed before its result was restored`);
    }
    if (!isPlainRecord(result) || !Object.hasOwn(result, 'data')) {
      throw new TypeError('A restored analysis result must be an object with data');
    }
    await this._discardFormResult();
    const requestId = this._startAnalysisRequest();
    if (requestId === null) {
      throw new Error(`${this.constructor.name} could not start restoring its result`);
    }
    const releaseBusy = this._claimBusy();
    try {
      await this._showResult(result, requestId);
      if (!this._isCurrentAnalysisRequest(requestId)) {
        throw new Error(`Restoring the ${this.constructor.name} result was superseded`);
      }
      if (beforePublish !== null) beforePublish();
      await this._publishAnalysisResult(result, requestId);
      // A restored result was computed from the options restored with it.
      this._resultInputs = {
        options: structuredClone(this._requireOptions()),
        pages: [...this._selectedPages],
        highlightRevision: this._highlightRevision,
        visibleDigest: this._visibleCellsDigest()
      };
      this._updateStale();
      if (this.onResultChange !== null && this.onResultChange !== undefined) {
        this.onResultChange(result);
      }
    } finally {
      releaseBusy();
      this._finishAnalysisRequest(requestId);
    }
  }

  /**
   * Publish a completed analysis as this UI's current result.
   *
   * The overlay used to be bound to whichever result was current when it was
   * opened, and nothing re-drew it afterwards. Changing the inputs with the
   * overlay open therefore left the two surfaces showing different science at
   * the same time — measured on Gene Signature, the sidebar preview moved to
   * mean 1.448292 while the overlay still showed mean 3.966388 under a title
   * naming the previous gene set. Detailed analysis already refreshed its open
   * modal (`_updateModal`); this is that missing counterpart for every
   * form-based mode.
   *
   * @param {Object} result - The newly completed result.
   * @param {number|null} [requestId] - Owning analysis request, when there is one.
   * @returns {Promise<void>}
   * @protected
   */
  async _publishAnalysisResult(result, requestId = null) {
    this._lastResult = result;
    this._currentPageData = result.data || result;
    this._requestedPlotOptions = structuredClone(result.options || {});

    const modal = this._modal;
    if (modal === null || modal === undefined) return;
    if (requestId !== null && !this._isCurrentAnalysisRequest(requestId)) return;

    try {
      await this._renderExpandedViewContent(modal, result);
    } catch (error) {
      // A stale overlay is worse than no overlay: it shows a result the user
      // has already replaced. Close it and say why, rather than reporting the
      // analysis — which succeeded — as failed. A teardown failure on top of
      // the render failure is reported alongside it, never in place of it.
      if (this._modal === modal) this._modal = null;
      let cleanupError = null;
      try {
        await closeModal(modal);
      } catch (closeFailure) {
        cleanupError = closeFailure;
      }
      const reported = cleanupError === null
        ? combineErrors([error], '')
        : new AggregateError(
          [error, cleanupError],
          'Expanded view refresh and its teardown both failed'
        );
      this._notifications.error(
        `Expanded view could not follow the new result: ${reported.message}`,
        { category: 'analysis', title: 'Analysis error' }
      );
    }
  }

  /**
   * A gene of a result as a button: choosing it colours the cells by the
   * gene, through the sidebar's gene selector (`ComparisonModule.colorByGene`).
   *
   * @param {string} gene
   * @returns {HTMLButtonElement}
   * @protected
   */
  _createGeneButton(gene) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'analysis-gene-link';
    button.textContent = gene;
    button.title = `Colour cells by ${gene}`;
    button.addEventListener('click', () => {
      void this.comparisonModule.colorByGene(gene);
    });
    return button;
  }

  /**
   * Append table rows to `tbody`, in 250-row chunks across tasks when
   * `chunked`, so a very long gene list does not block the page.
   *
   * A UI owns at most one chunked render. Starting another, closing the
   * expanded view, or destroying the UI cancels the chunks still pending, and a
   * table that has left the document stops receiving rows.
   *
   * @param {HTMLElement} tbody
   * @param {Array} rows
   * @param {(row: *) => HTMLElement} createRow
   * @param {{chunked: boolean}} options
   * @protected
   */
  _renderTableRows(tbody, rows, createRow, { chunked }) {
    this._cancelChunkedTableRender();
    if (!chunked) {
      for (const row of rows) tbody.appendChild(createRow(row));
      return;
    }
    const CHUNK = 250;
    let cursor = 0;
    const appendChunk = () => {
      const end = Math.min(rows.length, cursor + CHUNK);
      const fragment = document.createDocumentFragment();
      for (let index = cursor; index < end; index++) {
        fragment.appendChild(createRow(rows[index]));
      }
      tbody.appendChild(fragment);
      cursor = end;
      if (cursor < rows.length) {
        this._chunkedTableTimer = setTimeout(continueChunks, 0);
      }
    };
    const continueChunks = () => {
      this._chunkedTableTimer = null;
      if (this._isDestroyed || !tbody.isConnected) return;
      appendChunk();
    };
    // The first chunk is synchronous so the table is never shown empty.
    appendChunk();
  }

  /** @protected */
  _cancelChunkedTableRender() {
    if (this._chunkedTableTimer == null) return;
    clearTimeout(this._chunkedTableTimer);
    this._chunkedTableTimer = null;
  }

  /**
   * Render plot in modal - Override for custom plot rendering
   * @param {HTMLElement} container - Modal plot container
   */
  async _renderModalPlot(
    container,
    {
      isCurrent = () => true,
      modal = this._modal,
      result = this._lastResult
    } = {}
  ) {
    // Default implementation - subclasses should override
    if (!result?.plotType || !result?.data) {
      throw new Error('Modal plot rendering requires exact plotType and data');
    }

    const plotDef = PlotRegistry.get(result.plotType);
    if (!plotDef) {
      throw new Error(`Unknown modal plot type: ${result.plotType}`);
    }

    const mergedOptions = PlotRegistry.mergeOptions(result.plotType, result.options || {});
    const slot = this._ensureModalPlotSlot(modal);
    return slot.render(
      {
        render: candidate => plotDef.render(
          result.data,
          mergedOptions,
          candidate,
          null
        )
      },
      { isCurrent }
    );
  }

  /**
   * Render options in modal - Override for custom options
   * @param {HTMLElement} container - Modal options container
   */
  _renderModalOptions(container) {
    const result = this._lastResult;
    if (!result?.plotType) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
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
   * Publish one requested option intent without choosing how its dependent
   * scientific state is recomputed. Specialized analyses can own that
   * recomputation before starting a plot render.
   * @private
   * @param {string} key
   * @param {*} value
   * @returns {{revision: number, requestedOptions: Object}|null}
   */
  _preparePlotOptionChange(key, value) {
    if (!this._lastResult) return;
    const requestedOptions = {
      ...(
        this._requestedPlotOptions ??
        this._lastResult.options ??
        {}
      ),
      [key]: value
    };
    this._requestedPlotOptions = structuredClone(requestedOptions);

    // Re-render options panel to respect showWhen conditions
    if (this._modal?._optionsContent && this._lastResult.plotType) {
      renderPlotOptions(
        this._modal._optionsContent,
        this._lastResult.plotType,
        requestedOptions,
        this._handlePlotOptionChange
      );
    }

    const revision = ++this._optionRenderRevision;
    return {
      revision,
      requestedOptions: structuredClone(requestedOptions)
    };
  }

  /**
   * Handle plot option changes from the modal options panel.
   * Keeps the result as source of truth and re-renders modal + preview.
   * @private
   * @param {string} key
   * @param {*} value
   * @returns {Promise<void>|undefined}
   */
  _handlePlotOptionChange(key, value) {
    const prepared = this._preparePlotOptionChange(key, value);
    if (prepared === null || prepared === undefined) return;
    return this._trackInteractiveTask(
      this._rerenderAfterOptionChange(
        prepared.revision,
        prepared.requestedOptions
      ),
      'Plot option update'
    );
  }

  /**
   * Re-render plots and dependent panels after option changes.
   * @private
   */
  async _rerenderAfterOptionChange(
    revision,
    requestedOptions = this._requestedPlotOptions
  ) {
    if (this._isDestroyed) return;
    if (revision !== this._optionRenderRevision) return;

    const result = this._lastResult;
    if (result === null || result === undefined) return;
    if (!result.plotType || !result.data) {
      throw new Error('Plot option updates require exact plotType and data');
    }

    const plotDef = PlotRegistry.get(result.plotType);
    if (!plotDef) {
      throw new Error(`Unknown plot option update type: ${result.plotType}`);
    }

    if (requestedOptions === null || requestedOptions === undefined) {
      requestedOptions = structuredClone(result.options || {});
    }
    if (
      typeof requestedOptions !== 'object' ||
      Array.isArray(requestedOptions)
    ) {
      throw new TypeError('Plot option update requires an exact options object');
    }
    const mergedOptions = PlotRegistry.mergeOptions(
      result.plotType,
      requestedOptions
    );

    // Update modal plot (if open)
    if (this._modal !== null) {
      const modal = this._modal;
      try {
        if (!(modal._plotContainer instanceof HTMLElement)) {
          throw new TypeError('Analysis modal must provide the _plotContainer element');
        }
        await loadPlotly();
        if (this._isDestroyed) return;
        if (revision !== this._optionRenderRevision) return;
        const modalSlot = this._ensureModalPlotSlot(modal);
        const committed = await modalSlot.render(
          {
            render: candidate => plotDef.render(
              result.data,
              mergedOptions,
              candidate,
              null
            )
          },
          {
            isCurrent: () => (
              !this._isDestroyed &&
              this._modal === modal &&
              this._lastResult === result &&
              revision === this._optionRenderRevision
            )
          }
        );
        if (committed === null) return;
        if (!(modal._statsContent instanceof HTMLElement)) {
          throw new TypeError('Analysis modal must provide the _statsContent element');
        }
        if (!(modal._annotationsContent instanceof HTMLElement)) {
          throw new TypeError('Analysis modal must provide the _annotationsContent element');
        }
        this._renderModalStats(modal._statsContent);
        this._renderModalAnnotations(modal._annotationsContent);
      } catch (error) {
        await throwAfterModalCleanup(
          this,
          modal,
          error,
          `${this.constructor.name} modal plot update`
        );
      }
    }

    // Update inline/preview plot (if present)
    const previewHost = this._previewPlotHost ?? (
      this._plotContainerId
        ? document.getElementById(this._plotContainerId)
        : null
    );

    if (previewHost) {
      await loadPlotly();
      if (this._isDestroyed) return;
      if (revision !== this._optionRenderRevision) return;
      if (this._previewPlotSlot == null) {
        this._previewPlotHost = previewHost;
        this._previewPlotSlot = this._createOwnedPlotSlot(
          previewHost,
          'analysis-preview-plot'
        );
      }
      const previewCommitted = await this._previewPlotSlot.render(
        {
          render: candidate => plotDef.render(
            result.data,
            mergedOptions,
            candidate,
            null
          )
        },
        {
          isCurrent: () => (
            !this._isDestroyed &&
            this._lastResult === result &&
            revision === this._optionRenderRevision
          )
        }
      );
      if (previewCommitted === null) return;
    }
    if (revision !== this._optionRenderRevision) return;
    result.options = structuredClone(requestedOptions);
    this._requestedPlotOptions = structuredClone(requestedOptions);
  }

  /**
   * Render statistics in modal - Override for custom stats
   * @param {HTMLElement} container - Modal stats container
   */
  _renderModalStats(container) {
    // Default implementation - empty, subclasses should override
    container.innerHTML = '<p class="empty-state">Statistics not available</p>';
  }

  /**
   * Render statistical annotations in modal - Override for custom annotations
   * @param {HTMLElement} container - Modal annotations container
   */
  _renderModalAnnotations(container) {
    // Default implementation - empty, subclasses should override
    container.innerHTML = '<p class="empty-state">Statistical analysis not available</p>';
  }

  // ===========================================================================
  // Modal Export Handlers
  // ===========================================================================

  /**
   * Export modal plot as PNG
   */
  async _exportModalPNG() {
    const modal = this._modal;
    const slot = modal?._analysisPlotSlot ?? null;
    if (!(modal?._plotContainer instanceof HTMLElement) || slot === null) {
      throw new Error('PNG export requires an open analysis modal plot');
    }

    try {
      await slot.withCommittedPlot(candidate => (
        downloadImage(candidate, {
          format: 'png',
          width: 1200,
          height: 800,
          filename: `${this._getClassName()}_analysis`
        })
      ));
    } catch (err) {
      throwAfterExportFailureNotification(this._notifications, err, 'PNG');
    }
    this._notifications.success('Plot exported as PNG', { category: 'download' });
  }

  /**
   * Export modal plot as SVG
   */
  async _exportModalSVG() {
    const modal = this._modal;
    const slot = modal?._analysisPlotSlot ?? null;
    if (!(modal?._plotContainer instanceof HTMLElement) || slot === null) {
      throw new Error('SVG export requires an open analysis modal plot');
    }

    try {
      await slot.withCommittedPlot(candidate => (
        downloadImage(candidate, {
          format: 'svg',
          width: 1200,
          height: 800,
          filename: `${this._getClassName()}_analysis`
        })
      ));
    } catch (err) {
      throwAfterExportFailureNotification(this._notifications, err, 'SVG');
    }
    this._notifications.success('Plot exported as SVG', { category: 'download' });
  }

  /**
   * Export modal data as CSV - Override for custom CSV format
   */
  _exportModalCSV() {
    throw new Error('_exportModalCSV() must be implemented by subclass');
  }

  /**
   * Create an expand button for use in result rendering
   * @returns {HTMLElement} Expand button element
   */
  _createExpandButton() {
    return createExpandButton(() => {
      this._trackInteractiveTask(
        this._openExpandedView(),
        'Expanded analysis view'
      );
    });
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
    // Use classList.add to preserve original classes (e.g., analysis-mode-content)
    this._container.classList.add(`${this._getClassName()}-panel`);

    // Form container
    this._formContainer = document.createElement('div');
    this._formContainer.className = `${this._getClassName()}-form-container`;
    this._container.appendChild(this._formContainer);

    // The running, cancelled or failed state of the analysis's job.
    this._container.appendChild(this._getJobStatusView().root);

    // Result container (hidden initially)
    this._resultContainer = document.createElement('div');
    this._resultContainer.className = `${this._getClassName()}-result-container`;
    this._resultContainer.hidden = true;
    this._container.appendChild(this._resultContainer);

    // Render form controls
    this._renderControls();
  }

  /**
   * Render the form: the lead (a page selector), the options, the Run row.
   * The options record lives on the UI, so a rebuild (collapsing and opening
   * the accordion) keeps every choice.
   * @override
   */
  _renderControls() {
    this._optionsForm?.destroy();
    this._optionsForm = null;
    this._runRow = null;
    this._formContainer.innerHTML = '';

    const validation = this.validateRequirements(this._selectedPages);
    if (!validation.valid) {
      this._formContainer.appendChild(createStatusLine({
        tone: 'warning',
        text: validation.error || this.getRequirementText()
      }).root);
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'analysis-form';
    this._renderFormLead(wrapper);

    const context = this._getOptionsContext();
    const schema = this._getOptionsSchema();
    if (this._options === null) {
      this._options = schema.defaults(context);
    } else {
      this._options = this._reconcileOptions(context);
    }
    this._optionsForm = renderOptionsForm({
      schema,
      value: this._options,
      context,
      view: this._disclosures,
      onChange: (record, key) => {
        this._options = record;
        this._handleOptionsChanged(key);
      },
      onViewChange: view => {
        this._disclosures = view;
      }
    });
    wrapper.appendChild(this._optionsForm.root);
    this._decorateOptionsForm(this._optionsForm);

    const runRow = document.createElement('div');
    runRow.className = 'analysis-run-row';
    const reason = document.createElement('p');
    reason.className = 'analysis-run-reason';
    reason.hidden = true;
    const button = createButton({
      label: 'Run',
      variant: 'primary',
      className: 'analysis-run-btn',
      onClick: () => this._runAnalysis()
    });
    button.setAttribute('aria-label', `Run ${this._getRunNoun()}`);
    runRow.append(reason, button);
    wrapper.appendChild(runRow);
    this._runRow = { button, reason };

    applyFormControlAccessibility(wrapper, this._controlScope);
    this._formContainer.appendChild(wrapper);
    this._updateRunRow();
  }

  /**
   * Run again after a cancel or a failure: the form's run.
   * @override
   */
  _runAgain() {
    if (this._isDestroyed) return;
    this._trackInteractiveTask(this._runAnalysis(), this._getTitle());
  }

  /** @override */
  _getJobTitle() {
    return this._getTitle();
  }

  /**
   * Hold the run button at "Running…" until `job` ends or its request is
   * invalidated.
   * @param {number} requestId
   * @param {import('../../../../jobs/cancellable-job.js').CancellableJob} job
   * @protected
   */
  _holdRunButton(requestId, job) {
    const runBtn = this._runRow?.button ?? null;
    if (runBtn === null) return;
    runBtn.disabled = true;
    runBtn.dataset.running = 'true';
    runBtn.textContent = 'Running…';
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      delete runBtn.dataset.running;
      runBtn.textContent = 'Run';
      runBtn.disabled = false;
      this._updateRunRow();
    };
    const unsubscribe = job.subscribe(() => {
      if (job.running) return;
      unsubscribe();
      restore();
    });
    this._registerAnalysisInvalidationCleanup(requestId, restore);
  }

  /**
   * Run the analysis as a cancellable job: its status view shows what it is
   * doing with Cancel; the result is shown only once it is complete.
   */
  async _runAnalysis() {
    if (this._isDestroyed) return;
    const options = structuredClone(this._requireOptions());
    // Run is disabled while a blocker holds; a run started another way (a
    // preset, "Run again") stops here, saying why on the Run row.
    if (this._getRunBlocker(options) !== null) {
      this._updateRunRow();
      return;
    }
    const pages = [...this._selectedPages];
    const highlightRevision = this._highlightRevision;
    const visibleDigest = this._visibleCellsDigest();

    const requestId = this._startAnalysisRequest();
    if (requestId === null) return;
    const releaseBusy = this._claimBusy();
    const job = this._startAnalysisJob(requestId, { title: this._getJobTitle() });
    this._holdRunButton(requestId, job);

    try {
      const result = this._isCurrentAnalysisRequest(requestId)
        ? await this._runAnalysisImpl(options, requestId, job)
        : null;

      if (result === null || !this._isCurrentAnalysisRequest(requestId)) {
        job.cancel();
        return;
      }
      if (!isPlainRecord(result)) {
        throw new TypeError('Form-based analysis must return an exact result object');
      }
      if (!Object.hasOwn(result, 'data')) {
        throw new TypeError('Form-based analysis result must contain data');
      }
      job.step('Drawing the result');
      await this._showResult(result, requestId);
      if (!this._isCurrentAnalysisRequest(requestId)) return;

      // Publish result/data only after the owned render transaction commits.
      await this._publishAnalysisResult(result, requestId);
      this._resultInputs = { options, pages, highlightRevision, visibleDigest };
      // Display options changed while the run went: drawn now, once.
      const schema = this._getOptionsSchema();
      const displayChanged = schema.keys.filter(name =>
        this._isDisplayOption(name) && !sameOptionValue(options[name], this._options[name]));
      if (displayChanged.length > 0) {
        this._resultInputs.options = {
          ...options,
          ...Object.fromEntries(displayChanged.map(name => [name, this._options[name]]))
        };
        this._finishAnalysisRequest(requestId);
        await this._redrawForDisplay();
      }
      this._updateStale();
      job.succeed(this._getSuccessMessage(this._lastResult ?? result));

      if (this.onResultChange !== null && this.onResultChange !== undefined) {
        if (typeof this.onResultChange !== 'function') {
          throw new TypeError('onResultChange must be a function');
        }
        this.onResultChange(result);
      }
    } catch (error) {
      if (!this._isCurrentAnalysisRequest(requestId)) {
        job.cancel();
        return;
      }
      // The job's status view and notification say why; a cancel is calm.
      this._failAnalysisJob(job, error);
    } finally {
      releaseBusy();
      this._finishAnalysisRequest(requestId);
    }
  }

  // ===========================================================================
  // Page Selection
  // ===========================================================================

  /**
   * Remove result state and render owners that no longer match the form.
   * @protected
   */
  _discardFormResult() {
    this._optionRenderRevision += 1;
    this._clearJobStatus();
    const cleanupTasks = [];
    if (this._previewPlotSlot != null) {
      cleanupTasks.push(this._previewPlotSlot.invalidate());
    } else if (this._resultContainer) {
      this._resultContainer.innerHTML = '';
    }
    if (this._resultContainer) {
      const actions = this._resultContainer.querySelector?.(
        '.analysis-actions'
      );
      if (actions) actions.remove();
      const staleChip = this._resultContainer.querySelector(':scope > .analysis-stale-chip');
      if (staleChip !== null) staleChip.remove();
      this._resultContainer.classList.remove('analysis-result-stale');
      this._resultContainer.hidden = true;
    }
    this._resultInputs = null;
    if (this._modal) {
      const modal = this._modal;
      const closeTask = closeModal(modal);
      if (closeTask && typeof closeTask.then === 'function') {
        cleanupTasks.push(this._trackModalCloseTask(closeTask));
      }
    }
    this._lastResult = null;
    this._currentPageData = null;
    this._requestedPlotOptions = null;
    if (cleanupTasks.length === 0) return;
    return Promise.allSettled(cleanupTasks).then(results => {
      const failure = combineErrors(
        results
          .filter(result => result.status === 'rejected')
          .map(result => result.reason),
        'Analysis result cleanup failed'
      );
      if (failure) throw failure;
    });
  }

  /**
   * Update when page selection changes: the shown result is kept and marked
   * stale; nothing runs.
   * @param {string[]} pageIds - Selected page IDs
   */
  onPageSelectionChange(pageIds) {
    requirePageIds(pageIds);
    this._requireAvailableSelectedPages(
      pageIds,
      'Form-based analysis selectedPages'
    );
    this._selectedPages = [...pageIds];
    this._currentConfig.pages = this._selectedPages;
    this._renderControls();
    this._updateStale();
  }

  /**
   * Highlight membership is scientific input for every form-based analysis:
   * a change marks the shown result stale; nothing runs.
   * @override
   */
  onHighlightChanged() {
    this._updatePageSelectorCounts();
    this._highlightRevision += 1;
    this._refreshOptionsContext();
    this._updateStale();
  }

  /**
   * Whether these options read the cells the view shows ("Visible cells"),
   * so a filter change is a change of input.
   * @protected
   */
  _scopesByVisibleCells(options) {
    return options?.cells === 'visible' || options?.within === 'visible';
  }

  /**
   * A digest of which cells the view shows (its transparency, one byte a
   * cell), or null without one. Kept while the transparency array and its
   * write count are the same, so asking costs a pass over the cells only
   * after a visibility write.
   * @protected
   */
  _visibleCellsDigest() {
    const state = this.dataLayer?.state;
    const transparency = state?.categoryTransparency;
    if (!(transparency instanceof Uint8Array)) return null;
    const epoch = state._transparencyEpoch ?? 0;
    const kept = this._visibleDigestCache;
    if (kept !== null && kept.array === transparency && kept.epoch === epoch) return kept.digest;
    // FNV-1a over the bytes, four at a time where the array is aligned.
    let hash = 0x811c9dc5;
    const whole = transparency.byteOffset % 4 === 0 ? transparency.length >>> 2 : 0;
    const words = new Uint32Array(transparency.buffer, transparency.byteOffset, whole);
    for (let index = 0; index < whole; index++) hash = Math.imul(hash ^ words[index], 0x01000193);
    for (let index = whole * 4; index < transparency.length; index++) {
      hash = Math.imul(hash ^ transparency[index], 0x01000193);
    }
    const digest = `${transparency.length}:${(hash >>> 0).toString(16)}`;
    this._visibleDigestCache = { array: transparency, epoch, digest };
    return digest;
  }

  /**
   * Whether the set of visible cells changed since the form last caught up
   * with it. @returns {boolean}
   * @private
   */
  _syncVisibleCells() {
    const digest = this._visibleCellsDigest();
    if (digest === this._seenVisibleDigest) return false;
    this._seenVisibleDigest = digest;
    return true;
  }

  /**
   * A visibility pass ran (a filter, or a recolour). Only an analysis scoped
   * to "Visible cells" reads the shown cells, and only a change of them is a
   * change of its input: its groups are read again and its result is stale.
   */
  onCellVisibilityChanged() {
    if (!this._scopesByVisibleCells(this._options)) return;
    if (!this._syncVisibleCells()) return;
    this._refreshOptionsContext();
    this._updateStale();
  }

  /**
   * An input changed while another mode is shown: recorded now (so nothing
   * cached from before is reused), brought up to date when shown (`onShown`).
   *
   * @param {'highlight'|'cell-visibility'} kind
   */
  noteHiddenChange(kind) {
    if (kind === 'highlight') this._highlightRevision += 1;
    else if (kind !== 'cell-visibility') throw new RangeError(`Unknown analysis input change: ${String(kind)}`);
    this._missedInputChange = true;
  }

  /** Shown again: catch up with the changes recorded while hidden. */
  onShown() {
    if (!this._missedInputChange) return;
    this._missedInputChange = false;
    if (this._scopesByVisibleCells(this._options)) this._syncVisibleCells();
    this._updatePageSelectorCounts();
    this._refreshOptionsContext();
    this._updateStale();
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
    if (this._destroyPromise != null) return this._destroyPromise;
    this._isDestroyed = true;
    this._invalidateAnalysisRequest();
    this._optionRenderRevision += 1;
    this._cancelChunkedTableRender();

    this._destroyPromise = Promise.resolve().then(async () => {
      const errors = [];
      const tasks = [
        ...(this._formDestroyTasks ?? []),
        ...(this._pendingModalCloseTasks ?? [])
      ];
      const previewSlot = this._previewPlotSlot;
      if (previewSlot != null) {
        try {
          tasks.push(previewSlot.destroy());
        } catch (error) {
          errors.push(error);
        }
      }

      const modal = this._modal;
      if (modal != null) {
        try {
          tasks.push(closeModal(modal));
        } catch (error) {
          errors.push(error);
        }
      }

      const outcomes = await Promise.allSettled(tasks);
      errors.push(
        ...outcomes
          .filter(outcome => outcome.status === 'rejected')
          .map(outcome => outcome.reason)
      );

      this._optionsForm?.destroy();
      this._optionsForm = null;
      this._runRow = null;
      this._previewPlotSlot = null;
      this._previewPlotHost = null;
      this._modalPlotSlot = null;
      this._modal = null;
      this._formContainer = null;
      this._resultContainer = null;
      this._plotContainerId = null;
      this._requestedPlotOptions = null;

      try {
        await super.destroy();
      } catch (error) {
        errors.push(error);
      }

      const failure = combineErrors(
        errors,
        'Form analysis teardown failed'
      );
      if (failure) throw failure;
    });
    void this._destroyPromise.catch(() => {});
    return this._destroyPromise;
  }
}
