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
 * chip) until the next run. A result records what it was computed on, by
 * content (`shared/result-provenance.js`: the dataset, the open cells, the
 * genes read for, the data mapping, the pages' cells, the visible cells for
 * an analysis of them, the deciding settings), and is stale exactly when
 * that differs from the page now: another set of open cells (Apply in
 * place, a progressive opening's step), genes read for more cells, a
 * mapping change, a change of its pages' cells and, for an analysis of the
 * visible cells, a filter. A stale result is never passed on as current: a
 * session (and the history) keeps it with its provenance, so it comes back
 * stale; it is not exported (CSV, PNG, SVG, GMT refuse and say why) and not
 * published to the derived results a notebook reads (its scores and gene
 * sets are withdrawn while it is stale).
 *
 * Subclasses implement:
 * - static getRequirements() - { minPages, maxPages, description }
 * - _getTitle()
 * - _getOptionsSchema() - the analysis's schema
 * - _runAnalysisImpl(options, requestId, job, sample) - the result
 *   `{ data, ... }`, or null when superseded. `sample` is null (every open
 *   cell) unless the analysis takes a first pass (`_takesCellSample`): then
 *   it is the first pass's cells (`shared/progressive-cells.js`), and the
 *   analysis runs exactly as it would on every cell, on each group's cells
 *   among them
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
 * - _takesCellSample() - true when `_runAnalysisImpl` narrows its cells to a
 *   `sample`: a run then answers first on a uniform sample of the open cells
 *   when that pays (measured), and refines in place to every open cell
 *
 * @module analysis-types/base/form-based-analysis
 */

import { BaseAnalysisUI } from '../../base-analysis-ui.js';
import { createButton, createStatusLine } from '../../../../ui/components/controls.js';
import { renderOptionsForm } from '../../../options/render-options-form.js';
import { transformWords } from '../../../../../data/expression-transform.js';
import { PLACES, placePath } from '../../../../ui/place-names.js';
import { sameOptionValue, subsetOptions } from '../../../options/option-schema.js';
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
import { downloadCSV } from '../../../shared/analysis-utils.js';
import { PlotRegistry } from '../../../shared/plot-registry-utils.js';
import { PlotlyRenderSlot } from '../../../shared/plotly-render-slot.js';
import { isPlainRecord, requireExactKeys } from '../../../../../utils/exact-record.js';
import { listNames, namedError, quoteName } from '../../../../actions/targets/names.js';
import { analysisCostKind, getAnalysisCostModel, runProgressively } from '../../../shared/progressive-cells.js';
import { formatCountOf } from '../../../../../utils/format-units.js';
import { cellsSteady } from '../../../../../data/open-cells-work.js';
import { failureDetails, joinFailure, sayFailure } from '../../../../../utils/errors.js';
import { isLeftOutResult } from '../../../shared/analysis-result-session.js';
import { awaitWithSignal, cancelled, onAbort, throwIfAborted } from '../../../../../utils/abort.js';
import {
  captureProvenance,
  requireProvenance,
  staleReasons,
  visibleCellsNow
} from '../../../shared/result-provenance.js';
import { isHexColor } from '../../../../../utils/hex-color.js';

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
    /** The display options' own form schema, made once (`_displayOptionsSchema`). */
    this._displaySchema = undefined;

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
    /**
     * The shown result's inputs: `options`, the options it is drawn with
     * (display options follow the form), and `provenance`, what it was
     * computed on (`shared/result-provenance.js`).
     */
    this._resultInputs = null;
    /**
     * The record of a result a shared session left out
     * (`importLeftOutResult`), given back by `exportResult` until the
     * analysis has a result again or loses it; null otherwise.
     */
    this._leftOutResult = null;
    /** Whether the shown result's derived results were withdrawn as stale. */
    this._publishedStale = false;
    /** The open cells what the analysis keeps of the data describes (`_onOpenCellsChanged`). */
    this._cellsSeen = this._openCells();
    /** Highlight changes heard (a key of what the analysis keeps of the groups). */
    this._highlightRevision = 0;
    /**
     * The revision of the visible cells (`visibleCellsNow`) the form was
     * last brought up to date for: the input of an analysis scoped to
     * "Visible cells" (`_scopesByVisibleCells`), which moves only when the
     * set of visible cells does, not on every visibility pass (a recolor
     * runs one).
     */
    this._seenVisibleRevision = null;
    /** The latest staleness check (`_updateStale`): only its answer is shown. */
    this._staleCheck = 0;
    /** Changes recorded while another mode was shown (`noteHiddenChange`). */
    this._missedInputChange = false;
    /** Display redraws: the latest one's token is current. */
    this._displayRevision = 0;
    this._runRow = null;

    /** The gene loader last asked for highly variable genes, and its answer. */
    this._highlyVariable = { loader: null, marked: false };
    // Genes read for more of the open cells (Genes read for): a result
    // that read genes for fewer is stale (`getStaleReasons`).
    const geneSampleState = this.dataLayer?.state ?? null;
    const onGeneSample = () => {
      if (!this._isDestroyed) this._updateStale();
    };
    const unsubscribe = typeof geneSampleState?.on === 'function' ? geneSampleState.on('gene-sample:changed', onGeneSample) : null;
    const stopGeneSample = typeof unsubscribe === 'function'
      ? unsubscribe
      : () => geneSampleState?.off?.('gene-sample:changed', onGeneSample);
    // The expression values changed (Data mapping › Expression values): the
    // form's values line says the new ones, and a result of the old is stale.
    const onExpression = () => {
      if (this._isDestroyed) return;
      this._updateValuesLine();
      this._updateStale();
    };
    const unsubscribeExpression = typeof geneSampleState?.on === 'function' ? geneSampleState.on('expression:changed', onExpression) : null;
    this._stopGeneSampleWatch = () => {
      stopGeneSample();
      if (typeof unsubscribeExpression === 'function') unsubscribeExpression();
      else geneSampleState?.off?.('expression:changed', onExpression);
    };
    /** The form's read-only line of the values its genes are read in (`_valuesNote`). */
    this._valuesLine = null;
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
          this._notifications.error(`${joinFailure(`Highly variable genes could not be read`, sayFailure(error))}`, { ...failureDetails(error), category: 'analysis' });
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

  /**
   * What Run's reason is waiting for: the reads under way that it names
   * ("Reading the groups…"), to be awaited, or null when no read is under way.
   * A person sees that reason on the Run row until it goes; a caller who runs
   * right after setting the options waits for it (`runNow`). @protected
   */
  _runInputsRead() {
    return null;
  }

  /** Why these options cannot run, once what is being read for them has been read. @private */
  async _runBlockerOnceRead(signal) {
    for (;;) {
      const blocker = this._getRunBlocker(this._requireOptions());
      const reading = blocker === null ? null : this._runInputsRead();
      if (reading === null) return blocker;
      await awaitWithSignal(reading, signal);
    }
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

  /** The cells open now: replaced whenever they change (`state.cellIdentity`). @protected */
  _openCells() {
    return this.dataLayer?.state?.cellIdentity ?? null;
  }

  /**
   * The gene sample a result read its genes for (`shared/gene-sample-cells.js`
   * `geneSampleUse`), as the run recorded it: a differential expression's
   * summary, a signature's, a marker run's metadata; else, for an analysis
   * that reads genes (`_readsGenes`), the open cells' gene sample now. Null
   * when genes were read for every open cell, or none were read.
   *
   * @param {Object|null} result
   * @returns {{cells: number, of: number, groups?: Array}|null}
   * @protected
   */
  _resultGeneSample(result) {
    const recorded = result?.geneSample ?? result?.summary?.geneSample ?? result?.metadata?.geneSample
      ?? result?.data?.geneSample ?? result?.data?.summary?.geneSample ?? undefined;
    if (recorded !== undefined) return recorded;
    if (!this._readsGenes(result?.options ?? null)) return null;
    const sample = this.dataLayer?.state?.getGeneSample?.() ?? null;
    return sample === null ? null : { cells: sample.cells, of: sample.of, groups: [] };
  }

  /**
   * Whether a run with these options reads genes: any variable it names is a
   * gene's (`type: 'gene_expression'`), or it names genes or gene sets.
   * Overridden by an analysis that always does.
   *
   * @param {Object|null} options
   * @returns {boolean}
   * @protected
   */
  _readsGenes(options) {
    if (options === null || typeof options !== 'object') return false;
    const seen = new Set();
    const visit = value => {
      if (value === null || typeof value !== 'object' || seen.has(value)) return false;
      seen.add(value);
      if (value.type === 'gene_expression') return true;
      return Object.entries(value).some(([key, entry]) => ((key === 'genes' || key === 'geneSets' || key === 'geneList') && entry != null && (!Array.isArray(entry) || entry.length > 0)) || visit(entry));
    };
    return visit(options);
  }

  /**
   * The open cells changed (Apply in place, a progressive opening's step):
   * what the analysis keeps of the data (a field's codes, its groups and
   * their counts) describes the cells open before, and is read again. A
   * description still being read for those cells is dropped when it
   * arrives. @protected
   */
  _onOpenCellsChanged() {}

  /** Call `_onOpenCellsChanged` once for each new set of open cells. @private */
  _syncOpenCells() {
    const cells = this._openCells();
    if (cells === this._cellsSeen) return;
    this._cellsSeen = cells;
    this._onOpenCellsChanged();
    // A blocker may depend on how the open cells were chosen.
    this._updateRunRow();
  }

  /**
   * What a result computed now would be computed on
   * (`shared/result-provenance.js`), with `genesReadFor` the gene sample it
   * read genes for. The inputs are taken when it is called; their digests
   * follow (SHA-256, the history's).
   *
   * @param {Object} options
   * @param {string[]} pageIds
   * @param {{cells: number, of: number}|null} genesReadFor
   * @returns {Promise<Object>}
   * @protected
   */
  _currentProvenance(options, pageIds, genesReadFor) {
    const schema = this._getOptionsSchema();
    const deciding = {};
    for (const key of schema.keys) if (!this._isDisplayOption(key)) deciding[key] = options[key];
    const state = this.dataLayer?.state ?? null;
    return captureProvenance({
      state,
      dataset: this.comparisonModule?.describeOpenDataset?.() ?? null,
      pageIds: [...pageIds],
      options: deciding,
      genesReadFor,
      visible: this._scopesByVisibleCells(options) ? visibleCellsNow(state)?.cells ?? null : null,
      values: this._valuesRead(options)?.transform ?? null,
    });
  }

  /** The shown result's provenance (null without a result). */
  getResultProvenance() {
    return this._lastResult === null || this._resultInputs === null ? null : this._resultInputs.provenance;
  }

  /**
   * Why the shown result is stale, one sentence each: what differs between
   * what it was computed on and the page now. Empty when it is current (or
   * there is none).
   * @returns {Promise<string[]>}
   */
  async getStaleReasons() {
    if (this._lastResult === null || this._resultInputs === null) return [];
    const recorded = this._resultInputs.provenance;
    const sample = this.dataLayer?.state?.getGeneSample?.() ?? null;
    const now = await this._currentProvenance(
      this._requireOptions(),
      [...this._selectedPages],
      sample === null ? null : { cells: sample.cells, of: sample.of }
    );
    return staleReasons(recorded, now);
  }

  /** Why the shown result is stale, in one line. @private */
  _staleReasonOf(reasons) {
    return reasons.join(' ') || 'The settings, pages or cells changed since this result.';
  }

  /**
   * Refuse to export a stale result, saying why: an export is read as the
   * result of the settings and cells shown now. True when refused.
   * @returns {Promise<boolean>}
   * @protected
   */
  async _refuseStaleExport(format) {
    const reasons = await this.getStaleReasons();
    if (reasons.length === 0) return false;
    this._notifications.warning(`${format} not exported. ${this._staleReasonOf(reasons)} Run it again to export it.`, { category: 'download' });
    return true;
  }

  /**
   * A stale result's scores and gene sets leave the derived results (a
   * notebook would read them as current); they come back when it is current
   * again (a setting changed back). @private
   */
  _syncStalePublication(stale) {
    if (this._lastResult === null || stale === this._publishedStale) return;
    this._publishedStale = stale;
    this._publishDerivedResultsSafely(stale ? null : this._lastResult);
  }

  /**
   * Dim the shown result and offer a run when it no longer matches the form,
   * and withdraw a stale result from the derived results. Asked again before
   * an answer arrives, only the latest answer is applied.
   * @returns {Promise<void>}
   * @private
   */
  async _updateStale() {
    const check = ++this._staleCheck;
    let reasons;
    try {
      reasons = await this.getStaleReasons();
    } catch (error) {
      console.error(`[Analysis] ${this._getTitle()}: whether the result is stale could not be checked:`, error);
      return;
    }
    if (check !== this._staleCheck || this._isDestroyed) return;
    const stale = reasons.length > 0;
    this._syncStalePublication(stale);
    const container = this._resultContainer;
    if (!(container instanceof HTMLElement)) return;
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
      chip.addEventListener('click', () => this._runAgain());
      container.prepend(chip);
    }
    chip.title = `${this._staleReasonOf(reasons)} Run again.`;
  }

  /**
   * The shown result for a session or the history, with what it was
   * computed on; without one, the record of a result a shared session left
   * out (`importLeftOutResult`), or null. A stale one is kept too: its
   * provenance makes it stale again where it is restored. Subclasses encode
   * the result (`_exportResult`).
   * @returns {null|{kind: string, version: number, payload: unknown, provenance: Object}|{kind: string, leftOut: true, provenance: Object|null}}
   */
  exportResult() {
    if (this._lastResult === null || this._resultInputs === null) {
      return this._leftOutResult === null ? null : structuredClone(this._leftOutResult);
    }
    const envelope = this._exportResult();
    return envelope === null ? null : { ...envelope, provenance: structuredClone(this._resultInputs.provenance) };
  }

  /**
   * Restore the record of a result a shared session left out
   * (`shared/analysis-result-session.js`): no result is shown, and the
   * record is what the analysis gives a session and the history until it
   * has a result again, so the state restored is the state shown. Opening
   * the file runs it again (`session/recompute-results.js`).
   * @param {{kind: string, leftOut: true, provenance: Object|null}} record
   * @returns {Promise<void>}
   */
  async importLeftOutResult(record) {
    if (!isLeftOutResult(record)) throw new TypeError(`${this._getTitle()}: a result left out must be {kind, leftOut: true, provenance}`);
    await this._discardFormResult();
    this._leftOutResult = structuredClone(record);
  }

  /** The shown, current result as a session envelope, or null. @protected */
  _exportResult() {
    return null;
  }

  /**
   * The expression values a run of these options reads its genes in: the
   * one declaration its provenance records (a result goes stale only when
   * they would change, `_currentProvenance`), its values line says
   * (`_valuesNote`) and an agent reads (`computed_on.values`).
   * `{transform, note}`: the transform the matrix it reads is shown in
   * (`DataLayer.expressionTransformOf`, the "Expression matrix" option's,
   * else the mapped one's), `note` null; or, for an analysis that reads its
   * genes as stored whatever the setting (pseudobulk, UCell: an override),
   * the values as stored and the line saying why. Null for a run that reads
   * no gene values (`_readsGenes`).
   *
   * @param {Object} options
   * @returns {{transform: import('../../../../../data/expression-transform.js').ExpressionTransform, note: string|null}|null}
   * @protected
   */
  _valuesRead(options) {
    if (!this._readsGenes(options) || typeof this.dataLayer?.expressionTransformOf !== 'function') return null;
    const matrix = this._getOptionsSchema().keys.includes('matrix') ? options.matrix : 'mapped';
    return { transform: this.dataLayer.expressionTransformOf(matrix), note: null };
  }

  /**
   * The values line under the form ("Values: Normalized · log1p (Data
   * mapping › Expression values)", `_valuesRead`'s words), for an analysis
   * with an "Expression matrix" option; null otherwise.
   * @param {Object} options
   * @returns {string|null}
   * @protected
   */
  _valuesNote(options) {
    if (!this._getOptionsSchema().keys.includes('matrix')) return null;
    const read = this._valuesRead(options);
    if (read === null) return null;
    return read.note ?? `Values: ${transformWords(read.transform)} (${placePath(PLACES.dataMapping, PLACES.expressionValues)})`;
  }

  /** `_valuesNote` of the options now, null when it cannot be said. @private */
  _valuesNoteNow() {
    if (this._options === null) return null;
    try {
      return this._valuesNote(this._options);
    } catch {
      // A matrix the dataset no longer offers: the options reconcile first.
      return null;
    }
  }

  /** Show the values line for the options now (a status line stays while empty). @private */
  _updateValuesLine() {
    if (this._valuesLine == null) return;
    this._valuesLine.set(this._valuesNoteNow() ?? '', 'muted');
  }

  /** Disable Run with its reason when the options cannot run. @private */
  _updateRunRow() {
    this._updateValuesLine();
    if (this._runRow === null || this._options === null) return;
    const { button, reason } = this._runRow;
    const blocker = this._isLoading ? null : this._getRunBlocker(this._options);
    // What a run would cost, said before it starts when it is large; it
    // never disables Run.
    const said = blocker ?? (this._isLoading ? null : this._getRunNotice(this._options));
    if (button.dataset.running !== 'true') button.disabled = blocker !== null;
    reason.hidden = said === null;
    reason.textContent = said ?? '';
    if (blocker === null) button.removeAttribute('title');
    else button.title = blocker;
  }

  /**
   * A cost of running these options worth saying before Run (memory a
   * result would hold beyond this device's share for analyses), or null.
   * Never a refusal: `_getRunBlocker` refuses.
   * @param {Object} _options
   * @returns {string|null}
   * @protected
   */
  _getRunNotice(_options) {
    return null;
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
   * hold a page it may select and may not color.
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
        !isHexColor(entry[1])
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
   * A person's change of the options made outside the options form (Swap A
   * and B, Relax filters, the expanded view's display options): one step
   * (`analysis.<name>.set`) of the options that differ from `before`, as a
   * change in the form is.
   * @param {Object} before - The options before the change
   * @protected
   */
  _recordOptionsChange(before) {
    const after = this._requireOptions();
    const changed = Object.keys(after).filter(key => !sameOptionValue(before[key], after[key]));
    if (changed.length === 0) return;
    this._recordPersonChange('set', { options: Object.fromEntries(changed.map(key => [key, structuredClone(after[key])])) });
  }

  /**
   * How this analysis is shown, named as `analysis.view.set` names it
   * (`analysis/options/analysis-views.js`): the open disclosures of its
   * options (`more`, the option `groups` open, in the schema's order) and
   * what a subclass's result shows (`_viewParams`).
   * @returns {Object}
   */
  getView() {
    const disclosures = this._optionsForm?.getView() ?? this._disclosures;
    return { more: disclosures.more, groups: [...disclosures.groups], ...this._viewParams() };
  }

  /**
   * Change how this analysis is shown (`analysis.view.set`): only the keys
   * given. The whole of `partial` is checked before anything changes; a key
   * this analysis does not take, or a value it does not offer, is refused
   * with a TypeError or RangeError naming it. Nothing runs.
   *
   * @param {Object} partial
   * @returns {boolean} whether anything changed
   */
  setView(partial) {
    return this.prepareView(partial)();
  }

  /**
   * Check a `setView` whole and return what applies it (resolving whether
   * anything changed), so a caller can refuse for another reason (the
   * analysis is not shown) after the view is checked and before anything
   * changes.
   *
   * @param {Object} partial
   * @returns {() => boolean}
   */
  prepareView(partial) {
    if (!isPlainRecord(partial)) throw new TypeError(`${this._getTitle()} view must be an object`);
    const { more, groups, plot, ...rest } = partial;
    const applyPlot = this._preparePlotView(plot);
    const schema = this._getOptionsSchema();
    const groupIds = schema.groups.map(group => group.id);
    if (more !== undefined && typeof more !== 'boolean') throw new TypeError(`${this._getTitle()}'s "more" must be true or false`);
    if (groups !== undefined) {
      if (!Array.isArray(groups)) throw new TypeError(`${this._getTitle()}'s "groups" must be a list of option groups`);
      for (const id of groups) {
        if (!groupIds.includes(id)) {
          throw namedError(RangeError, `${this._getTitle()} has no option group ${quoteName(id)}; its groups are ${listNames(groupIds)}.`);
        }
      }
    }
    const applyRest = this._prepareViewParams(rest);
    return () => {
      const current = this._optionsForm?.getView() ?? this._disclosures;
      const next = {
        more: more ?? current.more,
        groups: groups === undefined ? [...current.groups] : groupIds.filter(id => groups.includes(id)),
      };
      const disclosuresChanged = next.more !== current.more || JSON.stringify(next.groups) !== JSON.stringify(current.groups);
      this._disclosures = next;
      this._optionsForm?.setView(next);
      const restChanged = applyRest();
      const plotChanged = applyPlot();
      return disclosuresChanged || restChanged || plotChanged;
    };
  }

  /**
   * Check the `plot` part of a `setView` (options of the plot the expanded
   * view draws, by name) against the shown result's plot, and return what
   * applies it. An option the plot does not have, or a value it does not
   * take, is refused naming the options it has.
   * @protected
   * @param {Array<{option: string, value: unknown}>|undefined} plot
   * @returns {() => boolean}
   */
  _preparePlotView(plot) {
    if (plot === undefined) return () => false;
    const result = this._lastResult;
    if (!result?.plotType) throw new RangeError(`${this._getTitle()} has no result whose plot could be changed yet; run it first.`);
    const definition = PlotRegistry.get(result.plotType);
    const schema = definition?.optionSchema ?? {};
    const names = Object.keys(schema);
    if (!Array.isArray(plot) || plot.length === 0) throw new TypeError(`${this._getTitle()}'s "plot" must list options`);
    for (const { option, value } of plot) {
      const entry = schema[option];
      if (entry === undefined) {
        throw namedError(RangeError, `The plot of ${this._getTitle()} has no option ${quoteName(option)}; its options are ${listNames(names)}.`);
      }
      if (entry.type === 'checkbox' && typeof value !== 'boolean') throw new TypeError(`The plot option "${option}" is on or off (true or false)`);
      if (entry.type === 'range' && (typeof value !== 'number' || !Number.isFinite(value))) throw new TypeError(`The plot option "${option}" is a number`);
      if (entry.type === 'select' && Array.isArray(entry.options) && !entry.options.some(choice => choice.value === value)) {
        throw namedError(RangeError, `The plot option ${quoteName(option)} has no choice ${JSON.stringify(value)}; its choices are ${listNames(entry.options.map(choice => String(choice.value)))}.`);
      }
    }
    return () => {
      const before = JSON.stringify(this._requestedPlotOptions ?? result.options ?? {});
      for (const { option, value } of plot) void this._applyPlotOptionChange(option, value);
      return JSON.stringify(this._requestedPlotOptions ?? result.options ?? {}) !== before;
    };
  }

  /**
   * A subclass's part of `getView()` (what its result shows), by name. @protected
   * @returns {Object}
   */
  _viewParams() {
    return {};
  }

  /**
   * Check a subclass's part of a `setView` (every key but `more` and
   * `groups`) and return what applies it (resolving whether anything
   * changed). A key the analysis does not take is refused here. @protected
   * @param {Object} rest
   * @returns {() => boolean}
   */
  _prepareViewParams(rest) {
    const keys = Object.keys(rest);
    if (keys.length > 0) {
      throw new TypeError(`${this._getTitle()} has no view "${keys[0]}"; it takes "more", "groups" and "plot".`);
    }
    return () => false;
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
      `Plot resize failed: ${sayFailure(error)}`,
      { ...failureDetails(error), category: 'analysis', title: 'Analysis error' }
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
   * @param {Object} options.result - Analysis result to plot: the result
   *   itself (its Expand opens once this very result is published).
   * @param {Object} [options.plotOptions=result.options] - The plot options the
   *   preview draws with, when they differ from the result's (composition's
   *   preview leaves the legend out).
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
    plotOptions = result?.options,
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
      structuredClone(plotOptions || {})
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
      this._renderPreviewExpandAction(result);
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
  _renderPreviewExpandAction(result) {
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
    // The full view shows the published result: its preview is drawn first and the result is
    // published once its drawing has committed, so Expand waits for that (found 2026-11-10: a
    // click in between said "Expanded analysis view requires a completed analysis result").
    const published = this._lastResult === result;
    expandBtn.disabled = !published;
    if (!published) expandBtn.title = 'Opens once the result is drawn';
    this._previewExpand = { button: expandBtn, result };
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
        `Expanded view cleanup failed: ${sayFailure(error)}`,
        { ...failureDetails(error), category: 'analysis', title: 'Analysis cleanup error' }
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
        this._refuseStaleExport('CSV').then(refused => (refused ? undefined : this._exportModalCSV())),
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
   * Show a result restored from a session through the same render path a
   * fresh run takes, so the two draw identically.
   *
   * The result is this UI's current one once this resolves; its plot is
   * drawn as soon as its panel can draw. A plot waits for its host to have a
   * size (`PlotRenderSlot`), and a host in a closed analysis row, a closed
   * window or a tab in the background has none until the person shows it,
   * so a restore that waited for the drawing would wait on a click. A
   * drawing that fails says so and withdraws the result.
   *
   * @param {Object} result - The decoded result, shaped as `_runAnalysisImpl`
   *   returns it.
   * @param {Object} provenance - What it was computed on, as saved with it
   *   (`shared/result-provenance.js`): compared with the page now, it says
   *   whether the restored result is current.
   * @returns {Promise<void>}
   * @protected
   */
  async _restoreAnalysisResult(result, provenance) {
    if (this._isDestroyed) {
      throw new Error(`${this.constructor.name} was destroyed before its result was restored`);
    }
    if (!isPlainRecord(result) || !Object.hasOwn(result, 'data')) {
      throw new TypeError('A restored analysis result must be an object with data');
    }
    requireProvenance(provenance);
    await this._discardFormResult();
    const requestId = this._startAnalysisRequest();
    if (requestId === null) {
      throw new Error(`${this.constructor.name} could not start restoring its result`);
    }
    const releaseBusy = this._claimBusy();
    let drawing = null;
    try {
      drawing = this._showResult(result, requestId);
      await this._publishAnalysisResult(result, requestId);
      // A restored result is drawn with the options restored with it, and
      // is current exactly when what it was computed on is the page's now.
      this._resultInputs = {
        options: structuredClone(this._requireOptions()),
        provenance: structuredClone(provenance)
      };
      this._updateStale();
      if (this.onResultChange !== null && this.onResultChange !== undefined) {
        this.onResultChange(result);
      }
    } catch (error) {
      releaseBusy();
      this._finishAnalysisRequest(requestId);
      drawing?.catch(() => {});
      throw error;
    }
    void drawing.then(
      () => {},
      async error => {
        if (!this._isCurrentAnalysisRequest(requestId)) return;
        this._notifications.error(
          `${joinFailure(`The restored result could not be drawn`, sayFailure(error))}`,
          { ...failureDetails(error), category: 'analysis', title: 'Analysis error' }
        );
        this._invalidateAnalysisRequest();
        await this._discardFormResult();
      }
    ).finally(() => {
      releaseBusy();
      this._finishAnalysisRequest(requestId);
    });
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
    if (this._previewExpand?.result === result) {
      this._previewExpand.button.disabled = false;
      this._previewExpand.button.title = 'Open in full view with statistics and export options';
    }
    this._leftOutResult = null;
    this._publishedStale = false;
    // Every result is of the open cells: say how they were chosen, and on
    // which of them genes were read (`_resultGeneSample`).
    this._showCellChoice(this._openCells(), this._resultGeneSample(result));
    this._publishDerivedResultsSafely(result);
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
   * A gene of a result as a button: choosing it colors the cells by the
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
    button.title = `Color cells by ${gene}`;
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
   * The expanded view's options: the analysis's display options (those that
   * only change how its result is drawn, `_isDisplayOption`) as a form of
   * their own, then the plot's own options; "No customization options" only
   * when there is neither.
   * @param {HTMLElement} container - Modal options container
   * @param {Object} [plotOptions] - The plot options to show
   */
  _renderModalOptions(container, plotOptions = this._lastResult?.options ?? {}) {
    const plotType = this._lastResult?.plotType ?? null;
    const plotSchema = plotType === null ? null : PlotRegistry.get(plotType)?.optionSchema ?? null;
    const display = this._options === null ? null : this._displayOptionsSchema();
    container.innerHTML = '';
    if (plotType !== null && (display === null || Object.keys(plotSchema ?? {}).length > 0)) {
      renderPlotOptions(container, plotType, plotOptions, this._handlePlotOptionChange);
    } else if (display === null) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No customization options available.';
      container.appendChild(empty);
      return;
    }
    if (display === null) return;
    const form = renderOptionsForm({
      schema: display,
      value: Object.fromEntries(display.keys.map(key => [key, this._options[key]])),
      context: this._getOptionsContext(),
      onChange: (record, key) => {
        const before = this._requireOptions();
        this._options = { ...this._options, ...record };
        this._optionsForm?.setValue(this._options);
        this._handleOptionsChanged(key);
        // The display options are the analysis's options: a step, as in the panel.
        this._recordOptionsChange(before);
      }
    });
    form.root.classList.add('analysis-modal-display');
    container.prepend(form.root);
  }

  /**
   * The expanded view's plot options as a step names them, as the options
   * column labels them ("Transform set to z-score", "Show values set to on"):
   * `entries` are `analysis.view.set`'s `plot` (`{option, value}`), named by the
   * shown result's plot type; an option it does not declare keeps its name.
   *
   * @param {Array<{option: string, value: *}>} entries
   * @returns {string[]}
   */
  plotOptionWords(entries) {
    const plotType = this._lastResult?.plotType ?? null;
    const schema = plotType === null ? {} : (PlotRegistry.get(plotType)?.optionSchema ?? {});
    return entries.map(({ option, value }) => {
      const entry = Object.hasOwn(schema, option) ? schema[option] : null;
      const label = entry?.label ?? option;
      const valueText = entry?.type === 'checkbox'
        ? (value ? 'on' : 'off')
        : (Array.isArray(entry?.options) ? entry.options.find(choice => choice.value === value)?.label : undefined) ?? String(value);
      return `${label} set to ${valueText}`;
    });
  }

  /**
   * The display options as their own form for the expanded view, or null
   * when the analysis has none. @private
   */
  _displayOptionsSchema() {
    if (this._displaySchema === undefined) {
      const schema = this._getOptionsSchema();
      const keys = schema.keys.filter(key => this._isDisplayOption(key));
      this._displaySchema = keys.length === 0
        ? null
        : subsetOptions(schema, { id: `${schema.id}Display`, keys, outer: () => this._requireOptions() });
    }
    return this._displaySchema;
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

    // Re-render the options (the display options with them) to respect showWhen conditions
    if (this._modal?._optionsContent && this._lastResult.plotType) {
      this._renderModalOptions(this._modal._optionsContent, requestedOptions);
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
    const task = this._applyPlotOptionChange(key, value);
    // An option of the plot the expanded view draws is part of how the result
    // is shown: a step (`analysis.view.set` with `plot`), recorded once it settles.
    this._recordPersonChange('view', { view: { plot: [{ option: key, value }] } });
    return task;
  }

  /**
   * Apply one option of the expanded view's plot and draw again, recording
   * nothing (a person's change records through `_handlePlotOptionChange`,
   * an action's through the dispatcher).
   * @protected
   * @param {string} key
   * @param {*} value
   * @returns {Promise<void>|undefined}
   */
  _applyPlotOptionChange(key, value) {
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
    if (await this._refuseStaleExport('PNG')) return;
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
    if (await this._refuseStaleExport('SVG')) return;
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
   * The result's table as the file its expanded view's CSV button writes, and
   * the action `analysis.export` writes the same way: `{name, csv}` (the
   * file's name without `.csv`; its text or a Blob), or null with no result.
   * Each analysis gives its own table.
   * @param {{all?: boolean}} [_choice] - Marker genes: every gene of every group instead of the shown markers
   * @returns {Promise<{name: string, csv: string|Blob}|null>|{name: string, csv: string|Blob}|null}
   */
  tableFile(_choice) {
    throw new Error('tableFile() must be implemented by subclass');
  }

  /** The expanded view's CSV: the result's table file, downloaded. */
  async _exportModalCSV() {
    let file;
    try {
      file = await this.tableFile();
    } catch (err) {
      this._notifications.error(`CSV export failed: ${sayFailure(err)}`, { ...failureDetails(err), category: 'download' });
      return;
    }
    if (file !== null) downloadCSV(file.csv, file.name, this._notifications);
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

    // The cells the shown result used (a first pass's sample, or all), and
    // how the open cells were chosen.
    this._container.appendChild(this._getCellsUsedLine().root);
    this._container.appendChild(this._getCellChoiceChip());

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
        // Genes still being read is no problem: the form opens once they
        // are; no dataset open is a state, not a fault of this analysis.
        tone: validation.pending === true || validation.noDataset === true ? 'muted' : 'warning',
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
        this._recordPersonChange('set', {
          options: key === null ? structuredClone(record) : { [key]: structuredClone(record[key]) }
        });
      },
      onViewChange: view => {
        // A disclosure the person opened or closed: a step (`analysis.view.set`), the keys that changed.
        const before = this._disclosures;
        this._disclosures = view;
        const changed = {};
        if (before.more !== view.more) changed.more = view.more;
        if (JSON.stringify(before.groups) !== JSON.stringify(view.groups)) changed.groups = [...view.groups];
        if (Object.keys(changed).length > 0) this._recordPersonChange('view', { view: changed });
      }
    });
    wrapper.appendChild(this._optionsForm.root);
    this._decorateOptionsForm(this._optionsForm);

    // The values the genes are read in: the app's one setting, said here,
    // never an option of the analysis.
    this._valuesLine = null;
    if (this._valuesNoteNow() !== null) {
      this._valuesLine = createStatusLine({ tone: 'muted' });
      this._valuesLine.root.classList.add('analysis-values-line');
      wrapper.appendChild(this._valuesLine.root);
    }

    const runRow = document.createElement('div');
    runRow.className = 'analysis-run-row';
    const reason = document.createElement('p');
    reason.className = 'analysis-run-reason';
    reason.hidden = true;
    const button = createButton({
      label: 'Run',
      variant: 'primary',
      className: 'analysis-run-btn',
      onClick: () => this._runFromPerson()
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
    this._trackInteractiveTask(this._runFromPerson(), this._getTitle());
  }

  /**
   * A run the person started (Run, Stale · Run, Run again): a step once it
   * leaves a result (`_recordPersonChange`).
   * @private
   */
  async _runFromPerson() {
    const before = this._lastResult;
    await this._runAnalysis();
    if (this._lastResult !== null && this._lastResult !== before) this._recordPersonChange('run', {});
  }

  // ===========================================================================
  // Actions (`analysis/actions.js`): what an agent, a notebook or a replay does
  // ===========================================================================

  /** The options record (a copy). */
  getOptions() {
    return structuredClone(this._requireOptions());
  }

  /**
   * Set some options, as the form would: the record with `partial` over it
   * is checked by the schema (a TypeError naming every refusal), shown in
   * the form; a display option redraws the result, any other leaves it
   * stale. Nothing runs.
   * @param {Object} partial
   */
  setOptions(partial) {
    const schema = this._getOptionsSchema();
    for (const key of Object.keys(partial)) schema.entry(key);
    this._setOptions({ ...structuredClone(this._requireOptions()), ...structuredClone(partial) });
  }

  /**
   * How long a run would take on the open cells now, from what runs of this
   * analysis over the same genes measured on this device
   * (`AnalysisCostModel`), or null when it reads no cells, before any was
   * measured, or when only one run was measured on fewer cells than are open
   * now (all its time counted per cell would grow with the cells, though
   * most of a small run is paid once): `{ms, bytes: null, what}`.
   * The agent presence judges heavy work by it.
   * @returns {{ms: number, bytes: null, what: string}|null}
   */
  estimateRun() {
    if (this._options === null || this._options === undefined || !this._takesCellSample()) return null;
    const cells = this.dataLayer?.state?.pointCount ?? 0;
    const model = getAnalysisCostModel();
    const kind = analysisCostKind(this._getTitle());
    const units = this._getRunUnits(this._options);
    const cost = model.cost(kind, units);
    if (cost === null || !(cells > 0)) return null;
    if (model.passCount(kind, units) === 1 && cells > model.measuredCells(kind, units)) return null;
    return { ms: cost.fixedMs + cost.perCellMs * cells, bytes: null, what: `${this._getTitle()} on ${formatCountOf(cells, 'open cell')}` };
  }

  /**
   * Run now, as Run does, and wait for it to end. Throws what stops it from
   * running (Run's own reason) or why it failed; a cancel (Cancel, or
   * `signal`) ends it with what was shown before.
   * @param {{signal?: AbortSignal|null}} [how]
   * @returns {Promise<boolean>} Whether it left a new result
   */
  async runNow({ signal = null } = {}) {
    const blocker = await this._runBlockerOnceRead(signal);
    if (blocker !== null) throw new RangeError(blocker);
    throwIfAborted(signal);
    const before = this._lastResult;
    // Stopped before its job exists (waiting for the open cells to settle)
    // it never starts; once it runs, its job is cancelled (`_runAnalysis`).
    await this._runAnalysis({ signal });
    const job = this._shownJob ?? null;
    if (job !== null && job.state === 'failed') throw new Error(job.message);
    if (this._lastResult !== null && this._lastResult !== before) return true;
    // A run that ended without a result was stopped: by its caller (an
    // agent's Stop), or by a person (Cancel, another run). Said as such, never
    // as a run that changed nothing (an agent was told "it was so already").
    throwIfAborted(signal);
    throw cancelled('user', `${this._getTitle()} was canceled before it finished; nothing was kept.`);
  }

  /**
   * The shown result as a table an agent reads: the top `top` rows (per
   * group where the result has groups), with the number of rows in all.
   * Null without a result.
   * @param {number} top
   * @returns {{columns: string[], rows: Array<Array<string|number|boolean|null>>, total: number}|null}
   */
  describeResult(top) {
    if (this._lastResult === null || this._lastResult === undefined) return null;
    return this._resultTable(this._lastResult, top);
  }

  /**
   * The result's table (`describeResult`). Every analysis with a Run button
   * implements it.
   * @abstract
   * @protected
   */
  _resultTable(_result, _top) {
    throw new Error(`${this.constructor.name} must implement _resultTable()`);
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
   * `signal` (a caller's: `runNow`): stopped while the run waits to start,
   * it throws why and nothing runs; stopped once it runs, its job is
   * cancelled, as Cancel does (F147: a run stopped before its job existed
   * used to run to its end).
   * @param {{signal?: AbortSignal|null}} [how]
   */
  async _runAnalysis({ signal = null } = {}) {
    if (this._isDestroyed) return;
    const options = structuredClone(this._requireOptions());
    // Run is disabled while a blocker holds; a run started another way (a
    // preset, "Run again") stops here, saying why on the Run row.
    if (this._getRunBlocker(options) !== null) {
      this._updateRunRow();
      return;
    }
    // The open cells being changed in place: the run starts on the cells
    // after it, and its result is theirs (`data/open-cells-work.js`).
    const steady = cellsSteady();
    if (steady !== null) {
      await awaitWithSignal(steady, signal);
      if (this._isDestroyed) return;
    }
    // Genes read for more cells in the background (the first gene's
    // top-up): stopped and settled, so the run reads on the sample that stays.
    const holding = this.dataLayer?.holdGeneSample?.() ?? null;
    if (holding !== null) {
      await awaitWithSignal(holding, signal);
      if (this._isDestroyed) return;
    }
    throwIfAborted(signal);
    const pages = [...this._selectedPages];
    const cells = this._openCells();
    // What the run is computed on, taken as it starts (its digests follow):
    // a change while it runs leaves its result stale.
    const computedOn = this._currentProvenance(options, pages, null);

    const requestId = this._startAnalysisRequest();
    if (requestId === null) return;
    const releaseBusy = this._claimBusy();
    const job = this._startAnalysisJob(requestId, { title: this._getJobTitle() });
    // The caller stopped: its run is cancelled, as Cancel does.
    const stopWithCaller = onAbort(signal, () => job.cancel());
    this._holdRunButton(requestId, job);
    const openCells = this._takesCellSample() ? (this.dataLayer.state?.pointCount ?? 0) : 0;
    // The first pass on screen, if any (`runProgressively`).
    const progress = { shown: null };

    try {
      const isCurrent = () => this._isCurrentAnalysisRequest(requestId);
      const pass = sample => this._runAnalysisImpl(options, requestId, job, sample);
      // A first pass on a uniform sample of the open cells, when it answers
      // sooner by enough to be worth its cost (measured on this device).
      const result = !isCurrent()
        ? null
        : this._takesCellSample()
          ? await runProgressively({
              kind: analysisCostKind(this._getTitle()),
              units: this._getRunUnits(options),
              dataLayer: this.dataLayer,
              job,
              isCurrent,
              pass,
              progress,
              onFirstPass: async (first, sample) => {
                this._requireFormResult(first);
                job.step('Drawing the first pass');
                await this._showResult(first, requestId);
                if (!isCurrent()) return false;
                // The gene sample first: the line says it with the cells used.
                this._showCellChoice(cells, this._resultGeneSample(first));
                this._showCellsUsed(sample, openCells, 'refining');
                // Canceled or superseded while refining: the first pass
                // stays on screen, saying it is one.
                this._registerAnalysisInvalidationCleanup(requestId, () => {
                  if (progress.shown === sample) this._showCellsUsed(sample, openCells, 'stopped');
                });
                return true;
              }
            })
          : await pass(null);

      if (result === null || !isCurrent()) {
        job.cancel();
        if (progress.shown !== null && isCurrent()) this._showCellsUsed(progress.shown, openCells, 'stopped');
        return;
      }
      this._requireFormResult(result);
      job.step('Drawing the result');
      await this._showResult(result, requestId);
      if (!this._isCurrentAnalysisRequest(requestId)) return;
      progress.shown = null;
      if (this._takesCellSample()) {
        // The gene sample the result read genes for first: the line says it
        // (never "every cell" for a moment); publishing says it again.
        this._showCellChoice(cells, this._resultGeneSample(result));
        this._showCellsUsed(null, openCells, null, true);
      }

      // Publish result/data only after the owned render transaction commits.
      await this._publishAnalysisResult(result, requestId);
      const genesReadFor = this._resultGeneSample(result);
      const provenance = await computedOn;
      if (!this._isCurrentAnalysisRequest(requestId)) return;
      provenance.genesReadFor = genesReadFor === null ? null : { cells: genesReadFor.cells, of: genesReadFor.of };
      this._resultInputs = { options, provenance };
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
      // A first pass stays on screen, saying it is one.
      if (progress.shown !== null) this._showCellsUsed(progress.shown, openCells, 'stopped');
      // The job's status view and notification say why; a cancel is calm.
      this._failAnalysisJob(job, error);
    } finally {
      stopWithCaller();
      releaseBusy();
      this._finishAnalysisRequest(requestId);
    }
  }

  /** @private */
  _requireFormResult(result) {
    if (!isPlainRecord(result)) {
      throw new TypeError('Form-based analysis must return an exact result object');
    }
    if (!Object.hasOwn(result, 'data')) {
      throw new TypeError('Form-based analysis result must contain data');
    }
  }

  /**
   * Whether `_runAnalysisImpl` narrows its cells to a first pass's `sample`
   * (see the module comment). An analysis that cannot answer on a sample
   * keeps the default and always runs once on every open cell.
   * @returns {boolean}
   * @protected
   */
  _takesCellSample() {
    return false;
  }

  /**
   * The units of work a run of `options` scales with, for the cost model a
   * first pass is judged by (`shared/progressive-cells.js`): the genes it
   * reads, for an analysis that reads genes; 1 otherwise.
   * @param {Object} _options
   * @returns {number}
   * @protected
   */
  _getRunUnits(_options) {
    return 1;
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
    this._showCellsUsed(null);
    this._showCellChoice(null);
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
    this._leftOutResult = null;
    this._publishDerivedResultsSafely(null);
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
   * @param {{given?: boolean}} [options] - As `BaseAnalysisUI.onPageSelectionChange`.
   */
  onPageSelectionChange(pageIds, { given = true } = {}) {
    requirePageIds(pageIds);
    this._requireAvailableSelectedPages(
      pageIds,
      'Form-based analysis selectedPages'
    );
    this._assignPages(pageIds, { given });
    this._renderControls();
    this._updateStale();
  }

  /**
   * Highlight membership is scientific input for every form-based analysis:
   * a change marks the shown result stale; nothing runs.
   * @override
   */
  onHighlightChanged() {
    this._syncOpenCells();
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
   * The revision of the cells the view shows (`visibleCellsNow`): it moves
   * exactly when the set of visible cells does. A key of what an analysis
   * scoped to them keeps. Null without a view.
   * @protected
   */
  _visibleCellsRevision() {
    return visibleCellsNow(this.dataLayer?.state ?? null)?.revision ?? null;
  }

  /**
   * Whether the set of visible cells changed since the form last caught up
   * with it. @returns {boolean}
   * @private
   */
  _syncVisibleCells() {
    const revision = this._visibleCellsRevision();
    if (revision === this._seenVisibleRevision) return false;
    this._seenVisibleRevision = revision;
    return true;
  }

  /**
   * A visibility pass ran (a filter, or a recolor). Only an analysis scoped
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
    // Hidden, a result made stale is withdrawn at once all the same.
    if (kind === 'highlight') this._updateStale();
  }

  /**
   * The gene list was read after the first view (or could not be): the form
   * is built again -- every choice kept -- so a form that waited for the
   * genes opens, and every gene choice lists them.
   * @override
   */
  onGenesListed() {
    if (this._isDestroyed || this._formContainer === null) return;
    this._renderControls();
  }

  /**
   * A field was created, renamed, deleted or had its categories edited: the
   * categories read of every field are read again (as for other open cells,
   * `_onOpenCellsChanged`) and the form offers the fields there are now. Heard
   * while the action that changed the field runs, so a choice the change
   * takes away (a deleted field) is reconciled inside that action's step.
   * @override
   */
  onFieldsChanged() {
    if (this._isDestroyed) return;
    this._onOpenCellsChanged();
    this._refreshOptionsContext();
    this._updateStale();
  }

  /** Shown again: catch up with the changes recorded while hidden. */
  onShown() {
    this._syncOpenCells();
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
    this._stopGeneSampleWatch?.();
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
