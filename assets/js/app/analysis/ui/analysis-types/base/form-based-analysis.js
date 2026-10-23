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
 * - _renderFormControls(wrapper) - Render form inputs into wrapper
 * - _getFormValues() - Extract form values as object
 * - _runAnalysisImpl(formValues) - Execute analysis, return result object
 * - _showResult(result) - Render the completed result
 *
 * Subclasses may override:
 * - _validateForm(formValues) - Custom form validation
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
import { createButton, createStatusLine } from '../../../../ui/components/controls.js';
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
import { setOwnDataProperty } from '../../../../../utils/exact-record.js';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(
      `${label} must contain exactly: ${sortedExpected.join(', ')}`
    );
  }
}

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

function requireFormControlSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) {
    throw new TypeError('Form-based analysis formControls must be an object');
  }
  for (const [name, control] of Object.entries(snapshot)) {
    if (name.length === 0) {
      throw new TypeError('Form control names must be non-empty strings');
    }
    requireExactKeys(control, ['type', 'value'], `Form control "${name}"`);
    if (control.type === 'checkbox') {
      if (typeof control.value !== 'boolean') {
        throw new TypeError(
          `Form control "${name}" checkbox value must be a boolean`
        );
      }
    } else if (control.type === 'value') {
      if (typeof control.value !== 'string') {
        throw new TypeError(
          `Form control "${name}" value must be a string`
        );
      }
    } else {
      throw new TypeError(
        `Form control "${name}" type must be checkbox or value`
      );
    }
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
    if (!form) {
      throw new Error(
        'Form-based analysis settings require an initialized analysis form'
      );
    }

    form.querySelectorAll('input[name], select[name], textarea[name]').forEach((el) => {
      const name = el.getAttribute('name');
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('Named form controls require a non-empty name');
      }
      if (Object.hasOwn(out, name)) {
        throw new TypeError(`Form control name "${name}" is duplicated`);
      }
      let control;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') {
        control = { type: 'checkbox', value: el.checked };
      } else if (el instanceof HTMLInputElement) {
        control = { type: 'value', value: el.value };
      } else if (el instanceof HTMLSelectElement) {
        control = { type: 'value', value: el.value };
      } else if (el instanceof HTMLTextAreaElement) {
        control = { type: 'value', value: el.value };
      } else {
        throw new TypeError(`Form control "${name}" has an unsupported element type`);
      }
      setOwnDataProperty(out, name, control);
    });

    requireFormControlSnapshot(out);
    return out;
  }

  /**
   * Apply a snapshot produced by _snapshotNamedFormControls().
   * @param {Record<string, { type: 'checkbox'|'value', value: string|boolean }>|null|undefined} snapshot
   * @protected
   */
  _applyNamedFormControls(snapshot) {
    requireFormControlSnapshot(snapshot);
    const form = this._formContainer?.querySelector?.('.analysis-form');
    if (!form) {
      throw new Error(
        'Form-based analysis settings require an initialized analysis form'
      );
    }

    const namedElements = new Map();
    form.querySelectorAll('input[name], select[name], textarea[name]').forEach((element) => {
      const name = element.getAttribute('name');
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('Named form controls require a non-empty name');
      }
      if (namedElements.has(name)) {
        throw new TypeError(`Form control name "${name}" is duplicated`);
      }
      namedElements.set(name, element);
    });

    const operations = [];
    for (const [name, data] of Object.entries(snapshot)) {
      const el = namedElements.get(name);
      if (!el) {
        throw new Error(`Form control "${name}" was not found`);
      }

      if (data.type === 'checkbox' && el instanceof HTMLInputElement && el.type === 'checkbox') {
        operations.push(() => {
          el.checked = data.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        continue;
      }

      if (data.type === 'value' && (el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) {
        operations.push(() => {
          el.value = data.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        continue;
      }

      if (data.type === 'value' && el instanceof HTMLTextAreaElement) {
        operations.push(() => {
          el.value = data.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        continue;
      }

      throw new TypeError(
        `Form control "${name}" snapshot type does not match its element`
      );
    }

    for (const apply of operations) {
      apply();
    }
  }

  /**
   * Validate the complete settings schema owned by a concrete form analysis.
   *
   * A settings snapshot is imported before the importing panel has rendered —
   * that is how a floating analysis window is populated — so this cannot ask a
   * page selector that does not exist yet, and Differential Expression and
   * Marker Genes never build one at all. It resolves the shared selectable
   * domain instead, which is what the exporting panel was selecting from.
   *
   * @param {unknown} settings
   * @param {string[]} expectedKeys
   * @returns {{ selectedPages: string[], formControls: Object }}
   * @protected
   */
  _requireExactFormSettings(settings, expectedKeys) {
    requireExactKeys(settings, expectedKeys, 'Form-based analysis settings');
    requirePageIds(settings.selectedPages);
    requireFormControlSnapshot(settings.formControls);
    const pages = this.dataLayer.getPages();
    if (!Array.isArray(pages)) {
      throw new TypeError(
        'Form-based analysis page inventory must be an array'
      );
    }
    const availablePageIds = selectablePageIdSet(pages);
    for (const pageId of settings.selectedPages) {
      if (!availablePageIds.has(pageId)) {
        throw new Error(
          `Form-based analysis page "${pageId}" was not found`
        );
      }
      if (this.dataLayer.getCellCountForPageId(pageId) === 0) {
        throw new RangeError(
          `Form-based analysis page "${pageId}" has zero cells and cannot be selected`
        );
      }
    }
    return {
      selectedPages: [...settings.selectedPages],
      formControls: structuredClone(settings.formControls)
    };
  }

  /**
   * Validate custom page colors against the shared selectable page domain.
   *
   * `importSettings` validates one settings object against two page rules: its
   * `selectedPages` through `_requireExactFormSettings` above, and its
   * `customPageColors` here. Those have to be the same rule. This one used to
   * resolve its domain from `this._pageSelector._getPages()` — the widget's
   * current view — which agrees with `selectablePageIdSet` only because every
   * form-based selector happens to be built with `includeDerivedPages: true`
   * (`correlation-analysis-ui.js:441`, `gene-signature-ui.js:360`). That option
   * defaults to `false` (`page-selector.js:168`), so the next selector built
   * without it would have accepted a rest-of page as a selection and refused a
   * colour for the very same page, out of one saved session.
   *
   * The selector is still required, because `_applyCustomPageColors` is what
   * consumes the result and `importSettings` must fail before it mutates
   * anything rather than half-way through applying.
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
      throw new Error(
        'Custom page color settings require an initialized page selector'
      );
    }
    const pages = this.dataLayer.getPages();
    if (!Array.isArray(pages)) {
      throw new TypeError(
        'Form-based analysis page inventory must be an array'
      );
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
        throw new TypeError(
          'Custom page colors must contain [pageId, #rrggbb] pairs'
        );
      }
      const [pageId, color] = entry;
      if (!availablePageIds.has(pageId)) {
        throw new Error(`Custom color page "${pageId}" was not found`);
      }
      if (seenPageIds.has(pageId)) {
        throw new TypeError(
          `Page "${pageId}" has more than one custom color`
        );
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
      throw new Error(
        'Custom page color settings require an initialized page selector'
      );
    }
    const state = this._pageSelector.exportState();
    this._pageSelector.importState({
      mode: state.mode,
      selectedPages: state.selectedPages,
      customColors: colors
    });
  }

  /**
   * Apply settings after the concrete subclass has validated its complete shape.
   * @param {{ selectedPages: string[], formControls: Object }} settings
   * @protected
   */
  _applyFormSettings(settings) {
    this.onPageSelectionChange([...settings.selectedPages]);
    this._applyNamedFormControls(settings.formControls);
  }

  /**
   * Export a settings-only snapshot for cloning/copying.
   * Results (plots/data) are intentionally excluded.
   * @override
   */
  exportSettings() {
    requirePageIds(this._selectedPages);
    return {
      selectedPages: [...this._selectedPages],
      formControls: this._snapshotNamedFormControls()
    };
  }

  /**
   * Import a settings snapshot previously produced by exportSettings().
   * @override
   * @param {{ selectedPages: string[], formControls: Record<string, { type: 'checkbox'|'value', value: string|boolean }> }} settings
   */
  importSettings(settings) {
    const validated = this._requireExactFormSettings(
      settings,
      ['formControls', 'selectedPages']
    );
    this._applyFormSettings(validated);
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
   * @param {number} requestId - Current analysis request generation
   * @returns {Promise<Object>} Analysis result object
   */
  async _runAnalysisImpl(formValues, requestId) {
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
    height = null
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

    if (
      this._previewPlotSlot != null &&
      this._previewPlotHost?.isConnected !== false &&
      this._previewPlotHost?.parentNode?.parentNode === this._resultContainer
    ) {
      if (height !== null) {
        this._previewPlotHost.style.height = `${height}px`;
      }
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
    if (height !== null) host.style.height = `${height}px`;
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
   * @param {Function} [options.onRendered] - Plot-slot render callback.
   * @returns {Promise<HTMLElement|null>} The rendered candidate, or null.
   */
  async _renderPreviewPlot({
    result,
    requestId,
    containerId,
    expandable = false,
    height = null,
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
      height
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
    if (!isPlainObject(result) || !Object.hasOwn(result, 'data')) {
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
   * Render the control panel (form)
   * @override
   */
  _renderControls() {
    // Collapsing an analysis accordion and opening it again rebuilds the form,
    // which threw away every choice the user had made in it — the Marker Genes
    // mode, statistical method and cache checkbox all snapped back to their
    // defaults. Carry the named control values across the rebuild.
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

    // Create form wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'analysis-form';

    // Let subclass render form controls
    this._renderFormControls(wrapper);

    // Scope ids to this UI instance, so a copied window cannot steal the
    // sidebar's controls through a duplicate id.
    applyFormControlAccessibility(wrapper, this._controlScope);
    // Restore before the intent listeners exist: re-stating the values the user
    // already chose is not a fresh edit and must not schedule an analysis.
    this._restoreFormControlValues(wrapper, carriedValues);

    const handleInputIntent = () => this._handleFormInputIntent();
    wrapper.addEventListener('input', handleInputIntent);
    wrapper.addEventListener('change', handleInputIntent);

    // The run button is the one action that commits this form's work.
    wrapper.appendChild(createButton({
      label: this._getRunButtonText(),
      variant: 'primary',
      className: 'analysis-run-btn',
      onClick: () => this._runAnalysis()
    }));
    // What a run will cost, before it starts.
    this._runCostLine = createStatusLine({ tone: 'muted' });
    this._runCostLine.root.classList.add('analysis-run-cost');
    wrapper.appendChild(this._runCostLine.root);

    this._formContainer.appendChild(wrapper);
    this._updateRunCost();
  }

  /**
   * What a run of the form as it stands will cost (`Tests 20,000 genes in
   * 1,234 vs 5,678 cells`), or null when it cannot be said. Override where
   * the cost is known before starting.
   * @returns {string|null}
   * @protected
   */
  _describeRunCost() {
    return null;
  }

  /** Say what a run will cost under the run button. @protected */
  _updateRunCost() {
    if (!this._runCostLine) return;
    this._runCostLine.set(this._describeRunCost() ?? '');
  }

  /**
   * Snapshot the current named form-control values, if a form is rendered.
   *
   * Unlike {@link _snapshotNamedFormControls} this is lenient: it is used to
   * carry a user's choices across a rebuild of the same form, so a missing form
   * is simply "nothing to carry" rather than an error.
   *
   * @returns {Map<string, {checkbox: boolean, value: string|boolean}>|null}
   * @protected
   */
  _captureFormControlValues() {
    const form = this._formContainer?.querySelector?.('.analysis-form');
    if (!form) return null;
    const values = new Map();
    for (const element of form.querySelectorAll(
      'input[name], select[name], textarea[name]'
    )) {
      const name = element.getAttribute('name');
      if (typeof name !== 'string' || name.length === 0) continue;
      if (values.has(name)) continue;
      values.set(
        name,
        element instanceof HTMLInputElement && element.type === 'checkbox'
          ? { checkbox: true, value: element.checked }
          : { checkbox: false, value: element.value }
      );
    }
    return values;
  }

  /**
   * Re-apply carried values to a freshly rendered form.
   *
   * A control that no longer exists, changed kind, or no longer offers the
   * stored option keeps the new form's default — a selection that is no longer
   * valid for the current dataset must not survive.
   *
   * @param {HTMLElement} root - The freshly rendered form.
   * @param {Map<string, {checkbox: boolean, value: string|boolean}>|null} values
   * @protected
   */
  _restoreFormControlValues(root, values) {
    if (values === null || values.size === 0) return;
    for (const element of root.querySelectorAll(
      'input[name], select[name], textarea[name]'
    )) {
      const stored = values.get(element.getAttribute('name'));
      if (stored === undefined) continue;
      const isCheckbox = element instanceof HTMLInputElement
        && element.type === 'checkbox';
      if (stored.checkbox !== isCheckbox) continue;
      if (isCheckbox) {
        if (element.checked === stored.value) continue;
        element.checked = stored.value;
      } else {
        if (
          element instanceof HTMLSelectElement &&
          ![...element.options].some(option => option.value === stored.value)
        ) {
          continue;
        }
        if (element.value === stored.value) continue;
        element.value = stored.value;
      }
      element.dispatchEvent(new Event(
        element instanceof HTMLTextAreaElement ? 'input' : 'change',
        { bubbles: true }
      ));
    }
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
    const runBtn = this._formContainer?.querySelector('.analysis-run-btn') ?? null;
    if (runBtn === null) return;
    const originalText = runBtn.textContent;
    runBtn.disabled = true;
    runBtn.textContent = 'Running…';
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      runBtn.disabled = false;
      runBtn.textContent = originalText;
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
   * doing with Cancel, the result is shown only once it is complete.
   */
  async _runAnalysis() {
    if (this._isDestroyed) return;
    // Get form values
    const formValues = structuredClone(this._getFormValues());

    // Validate form
    const validation = this._validateForm(formValues);
    if (!validation.valid) {
      if (
        typeof validation.error !== 'string' ||
        validation.error.length === 0 ||
        validation.error !== validation.error.trim()
      ) {
        throw new TypeError('Invalid form validation requires an exact error message');
      }
      this._invalidateAnalysisRequest();
      this._notifications.error(validation.error);
      return;
    }

    const requestId = this._startAnalysisRequest();
    if (requestId === null) return;
    const releaseBusy = this._claimBusy();
    const discardTask = this._discardFormResult();
    const job = this._startAnalysisJob(requestId, { title: this._getJobTitle() });
    this._holdRunButton(requestId, job);

    try {
      if (discardTask && typeof discardTask.then === 'function') {
        await discardTask;
      }
      const result = this._isCurrentAnalysisRequest(requestId)
        ? await this._runAnalysisImpl(formValues, requestId, job)
        : null;

      if (result === null || !this._isCurrentAnalysisRequest(requestId)) {
        job.cancel();
        return;
      }
      if (!isPlainObject(result)) {
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
      job.succeed(this._getSuccessMessage());

      // Callback
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
   * Invalidate a manual form request as soon as its displayed inputs change.
   * @protected
   */
  _handleFormInputIntent() {
    if (this._isDestroyed) return;
    this._invalidateAnalysisRequest();
    this._updateRunCost();
    const cleanup = this._discardFormResult();
    if (cleanup && typeof cleanup.then === 'function') {
      void cleanup.catch(error => {
        this._createModalCloseErrorHandler()(error);
      });
    }
    return cleanup;
  }

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
      this._resultContainer.hidden = true;
    }
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
   * Update when page selection changes
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
    this._invalidateAnalysisRequest();
    const cleanup = this._discardFormResult();
    if (cleanup && typeof cleanup.then === 'function') {
      void cleanup.catch(error => {
        this._createModalCloseErrorHandler()(error);
      });
    }
    this._renderControls();
    return cleanup;
  }

  /**
   * Highlight membership is scientific input for every form-based analysis,
   * including DE and Marker Genes whose config has no base dataSource field.
   * @override
   */
  onHighlightChanged() {
    this._updatePageSelectorCounts();
    this._invalidateAnalysisRequest();
    const cleanup = this._discardFormResult();
    if (cleanup && typeof cleanup.then === 'function') {
      void cleanup.catch(error => {
        this._createModalCloseErrorHandler()(error);
      });
    }
    return cleanup;
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
