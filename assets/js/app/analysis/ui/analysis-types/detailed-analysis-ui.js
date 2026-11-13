/**
 * Detailed Analysis UI Component
 *
 * Provides the DETAILED analysis mode with full control over:
 * - Variable selection (categorical obs, continuous obs, gene expression)
 * - Plot type selection
 * - Plot options customization
 * - Preview and expanded view
 * - Export functionality
 *
 * This component extends BaseAnalysisUI for shared functionality and
 * adds detailed-specific features like plot options.
 */

import { createStatusLine } from '../../../ui/components/controls.js';
import { BaseAnalysisUI } from '../base-analysis-ui.js';
// Import PlotRegistry from canonical shared directory
import { PlotRegistry } from '../../shared/plot-registry-utils.js';
import { BasePlot } from '../../plots/plot-base.js';
import {
  createPlotTypeSelector,
  createAnalysisModal,
  openModal,
  closeModal,
  renderPlotOptions,
  preparePageStatistics,
  renderSummaryStats,
  renderStatisticalAnnotations,
  createExpandButton
} from '../components/index.js';
import { createVariableSelectorComponent } from '../shared/variable-selector.js';
import { PageSelectorComponent } from '../shared/page-selector.js';
import { loadPlotly } from '../../plots/plotly-loader.js';
import { createLayoutEngine } from '../../plots/layout-engine.js';
import { PlotlyRenderSlot } from '../../shared/plotly-render-slot.js';
import { setOwnDataProperty } from '../../../../utils/exact-record.js';
import { excludeMissingCategoricalValues } from '../../data/data-layer.js';
import { PLACES } from '../../../ui/place-names.js';
import { analysisCostKind, runProgressively } from '../../shared/progressive-cells.js';
import { failureDetails, joinFailure, sayFailure } from '../../../../utils/errors.js';
import { listNames, namedError, quoteName } from '../../../actions/targets/names.js';
import { promiseWithResolvers } from '../../../../utils/promise-resolvers.js';

/** A variable's kind in words, for a refusal. */
const VARIABLE_WORDS = Object.freeze({
  categorical_obs: 'categorical field',
  continuous_obs: 'continuous field',
  gene_expression: 'gene',
});

function combineErrors(errors, message) {
  const present = [...new Set(errors.filter(Boolean))];
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  return new AggregateError(present, message);
}

function requireSavedPlotOptions(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError('Detailed Analysis savedPlotOptions must be an array');
  }
  const optionsByPlot = new Map();
  for (const entry of entries) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      entry[0].length === 0 ||
      entry[1] === null ||
      typeof entry[1] !== 'object' ||
      Array.isArray(entry[1])
    ) {
      throw new TypeError(
        'Detailed Analysis savedPlotOptions must contain [plotType, options] pairs'
      );
    }
    const [plotType, options] = entry;
    if (!PlotRegistry.get(plotType)) {
      throw new Error(
        `Detailed Analysis saved plot type "${plotType}" was not found`
      );
    }
    if (optionsByPlot.has(plotType)) {
      throw new TypeError(
        `Detailed Analysis saved plot type "${plotType}" is duplicated`
      );
    }
    optionsByPlot.set(plotType, structuredClone(options));
  }
  return optionsByPlot;
}

/**
 * Detailed Analysis UI Component
 * Extends BaseAnalysisUI with detailed-specific functionality.
 */
export class DetailedAnalysisUI extends BaseAnalysisUI {
  /**
   * Get page requirements for detailed analysis
   * @static
   * @returns {{ minPages: number, maxPages: number|null, description: string }}
   */
  static getRequirements() {
    return {
      minPages: 1,
      maxPages: null, // No limit
      description: 'Select at least 1 page'
    };
  }

  /**
   * @param {Object} options
   * @param {Object} options.comparisonModule - Reference to main comparison module
   * @param {Object} options.dataLayer - Enhanced data layer
   * @param {Function} [options.onConfigChange] - Callback when config changes
   */
  constructor(options) {
    super(options);

    this._idPrefix = this._instanceId ? `${this._instanceId}-detailed` : 'detailed';
    this._plotTypeSelectId = this._instanceId ? `${this._instanceId}-analysis-plot-type` : 'analysis-plot-type';

    // UI element references (detailed-specific)
    this._variableSelector = null;
    this._variableBlock = null;
    this._pageSelector = null;
    this._pageSelectContainer = null;
    this._plotTypeContainer = null;

    // Session-only saved options per plot type
    this._savedPlotOptions = new Map();

    // The last committed result: the exact config snapshot a run started from,
    // the data it fetched for that config, and its layout engine. The expanded
    // view draws from this snapshot, never from `_currentConfig`, which the
    // controls change before the debounced run fetches matching data.
    /** @type {{config: Object, pageData: Object[], layoutEngine: Object}|null} */
    this._committedView = null;
    this._previewPlotSlot = null;
    this._modalPlotSlot = null;
    this._pendingModalCloseTasks = new Set();
    this._destroyPromise = null;
    this._modalRenderGeneration = 0;

    // Genes read for more of the open cells (Genes read for): a gene's plot
    // is drawn again on the cells now read, once the growth ends (the
    // detailed view follows its inputs; it has no Run to go stale).
    const geneSampleState = this.dataLayer?.state ?? null;
    let geneCells = geneSampleState?.getGeneSample?.()?.cells ?? null;
    const onGeneSample = ({ sample = null, growth = null } = {}) => {
      const cells = sample?.cells ?? null;
      if (this._isDestroyed || growth != null || cells === geneCells) return;
      geneCells = cells;
      if (this._currentConfig?.dataSource?.type === 'gene_expression' && this._committedView !== null) this._scheduleUpdate();
    };
    geneSampleState?.on?.('gene-sample:changed', onGeneSample);
    this._stopGeneSampleWatch = () => geneSampleState?.off?.('gene-sample:changed', onGeneSample);

    // Bind methods
    this._handleVariableChange = this._handleVariableChange.bind(this);
    this._handlePlotTypeChange = this._handlePlotTypeChange.bind(this);
    this._handlePlotOptionChange = this._handlePlotOptionChange.bind(this);
    this._openExpandedView = this._openExpandedView.bind(this);
  }

  /**
   * Render the complete UI structure (implements abstract method from BaseAnalysisUI)
   * @override
   */
  _render() {
    this._container.innerHTML = '';
    // Use classList.add to preserve original classes (e.g., analysis-mode-content)
    this._container.classList.add('detailed-analysis-ui');

    // Controls container
    this._controlsContainer = document.createElement('div');
    this._controlsContainer.className = 'detailed-analysis-controls';
    this._container.appendChild(this._controlsContainer);

    // The running, canceled or failed state of the plot's job.
    this._container.appendChild(this._getJobStatusView().root);

    // The cells the shown plot used (a first pass's sample, or all), and
    // how the open cells were chosen.
    this._container.appendChild(this._getCellsUsedLine().root);
    this._container.appendChild(this._getCellChoiceChip());

    // Preview container
    this._previewContainer = document.createElement('div');
    this._previewContainer.className = 'analysis-preview-container empty';
    this._container.appendChild(this._previewContainer);

    // Actions container
    this._actionsContainer = document.createElement('div');
    this._actionsContainer.className = 'analysis-actions';
    this._actionsContainer.hidden = true;
    this._container.appendChild(this._actionsContainer);

    // Render controls
    this._renderControls();
  }

  /**
   * Render the control panel
   */
  _renderControls() {
    this._controlsContainer.innerHTML = '';

    // No dataset open: said as every analysis says it (`validateDataRequirements`).
    const data = this.validateDataRequirements();
    if (!data.valid) {
      this._controlsContainer.replaceChildren(createStatusLine({ tone: 'muted', text: data.error }).root);
      const invalidationRequestId = this._invalidateAnalysisRequest();
      this._trackInteractiveTask(
        this._hidePreview(invalidationRequestId),
        'Detailed preview cleanup'
      );
      return;
    }

    let pages;
    try {
      pages = this.dataLayer.getPages();
    } catch (err) {
      console.error('[DetailedAnalysisUI] Failed to get pages:', err);
      this._controlsContainer.replaceChildren(createStatusLine({
        tone: 'danger',
        text: `${joinFailure(`The highlight pages could not be read`, sayFailure(err))}`
      }).root);
      return;
    }

    // If no pages, show message
    if (pages.length === 0) {
      this._controlsContainer.innerHTML = `
        <p class="empty-state">Create highlight pages first in the ${PLACES.highlighting.name} section above.</p>
      `;
      const invalidationRequestId = this._invalidateAnalysisRequest();
      this._trackInteractiveTask(
        this._hidePreview(invalidationRequestId),
        'Detailed preview cleanup'
      );
      return;
    }

    // Variable selectors
    this._renderVariableSelectors();

    // Page selector
    this._renderPageSelector(pages);

    // Plot type selector (only if variable selected)
    if (this._currentConfig.dataSource.variable) {
      this._renderPlotTypeSelector();
    }
  }

  /**
   * Attach the two-step variable selector, building it exactly once.
   *
   * The selector owns a state this panel's config cannot express: a type
   * chosen while its variable is still unchosen. Changing the type reports
   * `('', '')`, which this panel would read as "selection cleared": wiping
   * `dataSource.type` and rebuilding the selector from that empty config would
   * replace the type the user had just chosen by "None". The selector is
   * built once and re-attached across rebuilds instead, so the control that
   * raises a change is never destroyed by it.
   */
  _renderVariableSelectors() {
    if (this._variableBlock !== null) {
      this._syncVariableSelectorToConfig();
      this._controlsContainer.appendChild(this._variableBlock);
      return;
    }

    const variableBlock = document.createElement('div');
    variableBlock.className = 'control-block';
    const selectorContainer = document.createElement('div');
    variableBlock.appendChild(selectorContainer);
    this._controlsContainer.appendChild(variableBlock);

    try {
      this._variableSelector = createVariableSelectorComponent({
        dataLayer: this.dataLayer,
        container: selectorContainer,
        allowedTypes: ['categorical', 'continuous', 'gene'],
        idPrefix: this._idPrefix,
        typeLabel: 'Variable',
        initialSelection: this._currentConfig.dataSource.type ? {
          type: this._currentConfig.dataSource.type,
          variable: this._currentConfig.dataSource.variable
        } : undefined,
        onVariableChange: this._handleVariableChange
      });
    } catch (err) {
      console.error('[DetailedAnalysisUI] Failed to load variables:', err);
      variableBlock.appendChild(createStatusLine({
        tone: 'danger',
        text: 'Some variables could not be loaded.'
      }).root);
      // Leave the block unowned so the next render can try again.
      return;
    }

    this._variableBlock = variableBlock;
  }

  /**
   * Push a config this panel owns — a restored session, a copied window — into
   * the live selector.
   *
   * A config that already agrees with what the selector reports is left alone:
   * re-rendering it would discard a type the user has chosen but not yet paired
   * with a variable, which is exactly the state `dataSource` cannot carry.
   */
  _syncVariableSelectorToConfig() {
    if (this._variableSelector === null) return;
    const shown = this._variableSelector.getSelectedVariable();
    const { type, variable } = this._currentConfig.dataSource;
    if (shown.type === type && shown.variable === variable) return;
    this._variableSelector.setSelectedVariable(type, variable);
  }

  /**
   * Render page selector using shared PageSelectorComponent
   */
  _renderPageSelector(pages) {
    // Create container for the component
    this._pageSelectContainer = document.createElement('div');
    this._controlsContainer.appendChild(this._pageSelectContainer);

    // Destroy previous instance if exists
    this._pageSelector?.destroy();

    // Create PageSelectorComponent
    this._pageSelector = new PageSelectorComponent({
      dataLayer: this.dataLayer,
      container: this._pageSelectContainer,
      onSelectionChange: (pageIds, { byPerson }) => {
        this._handlePageChange(pageIds);
        // A page the selector let go as the pages changed is part of that change, not a step.
        if (byPerson) this._recordPersonChange('pages', { pageIds: [...(pageIds || [])] });
      },
      onColorChange: this._handlePageColorChange,
      showColorPicker: true,
      showCellCounts: true,
      showSelectAll: true,
      initialSelection: this._pageSelectionToShow(),
      includeDerivedPages: true,
      getCellCountForPageId: (pageId) => this.dataLayer.getCellCountForPageId(pageId),
      label: 'Compare pages'
    });
    this._adoptSelectorDefault();
  }

  /**
   * Render plot type selector
   */
  _renderPlotTypeSelector() {
    const dataKind = this._currentConfig.dataSource.type === 'categorical_obs'
      ? 'categorical' : 'continuous';

    // Auto-select first compatible plot type if none selected
    if (!this._currentConfig.plotType) {
      const compatiblePlots = PlotRegistry.getForDataType(dataKind);
      if (compatiblePlots.length > 0) {
        this._currentConfig.plotType = compatiblePlots[0].id;
      }
    }

    const plotTypeSelector = createPlotTypeSelector({
      dataType: dataKind,
      selectedId: this._currentConfig.plotType,
      onChange: this._handlePlotTypeChange,
      id: this._plotTypeSelectId
    });
    this._controlsContainer.appendChild(plotTypeSelector);
    this._plotTypeContainer = plotTypeSelector;
  }

  exportSettings() {
    const base = super.exportSettings();
    const savedPlotOptions = requireSavedPlotOptions(
      Array.from(this._savedPlotOptions.entries())
    );
    return {
      ...base,
      savedPlotOptions: Array.from(savedPlotOptions.entries())
    };
  }

  importSettings(settings) {
    this._requireExactSettingsKeys(
      settings,
      ['config', 'savedPlotOptions', 'selectedPages'],
      'Detailed Analysis settings'
    );
    const base = this._requireBaseSettings(settings);
    const savedPlotOptions = requireSavedPlotOptions(settings.savedPlotOptions);

    this._savedPlotOptions = savedPlotOptions;
    this._applyBaseSettings(base);
  }

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  /**
   * Handle variable selection change from two-step selector.
   *
   * `dataSource` mirrors a *complete* selection only. An incomplete one — the
   * type chosen, its variable not yet picked — belongs to the selector, and
   * `_renderVariableSelectors()` keeps that selector alive across the rebuilds
   * below so the mirror never overwrites it.
   *
   * @param {string} type - Variable type (categorical_obs, continuous_obs, gene_expression)
   * @param {string} variable - Variable key
   */
  _handleVariableChange(type, variable) {
    const before = { ...this._currentConfig.dataSource };
    this._applyVariable(type && variable ? { type, key: variable } : null);
    // A person's choice of what to plot: a step (`analysis.detailed.set`).
    const after = this._currentConfig.dataSource;
    if (after.type !== before.type || after.variable !== before.variable) {
      this._recordPersonChange('detailed', { variable: after.variable ? { type: after.type, key: after.variable } : null });
    }
  }

  /**
   * Plot `variable` (`{type, key}`), or nothing (null); the plot follows its
   * data kind. A type chosen without a variable changes nothing downstream.
   * @param {{type: string, key: string}|null} variable
   * @private
   */
  _applyVariable(variable) {
    if (variable !== null) {
      this._currentConfig.dataSource.type = variable.type;
      this._currentConfig.dataSource.variable = variable.key;

      // Update plot type based on data kind
      const dataKind = variable.type === 'categorical_obs' ? 'categorical' : 'continuous';
      this._updatePlotTypeForDataKind(dataKind);

      // Re-render so the plot type selector appears for the new data kind.
      this._renderControls();
      this._scheduleUpdate();
    } else if (this._currentConfig.dataSource.variable) {
      // The selection became incomplete: drop the plot type selector it fed.
      this._clearDataSource();
      this._renderControls();
      this._scheduleUpdate();
    }
  }

  /**
   * Set what the analysis plots (`analysis.detailed.set`), only the parts
   * given: the variable (a field or a gene by name, or null), the plot (a
   * plot type the variable's kind offers) and plot options of that plot.
   * Everything is checked before anything changes; a name that does not
   * resolve is refused with a RangeError naming what there is.
   *
   * @param {{variable?: {type: string, key: string}|null, plot?: string,
   *   plotOptions?: Array<{option: string, value: unknown}>}} change
   * @returns {boolean} whether anything changed
   */
  setPlot({ variable, plot, plotOptions }) {
    if (variable !== undefined && variable !== null) {
      const keys = (this.dataLayer.getAvailableVariables(variable.type) ?? []).map(entry => entry.key);
      if (!keys.includes(variable.key)) {
        throw namedError(RangeError, `There is no ${VARIABLE_WORDS[variable.type] ?? variable.type} ${quoteName(variable.key)} to plot; there are ${listNames(keys)}.`);
      }
    }
    const kindOf = type => (type === 'categorical_obs' ? 'categorical' : 'continuous');
    const nextType = variable === undefined ? this._currentConfig.dataSource.type : variable?.type ?? '';
    if ((plot !== undefined || plotOptions !== undefined) && !nextType) {
      throw new RangeError('Detailed has nothing to plot yet: choose its variable first.');
    }
    const compatible = nextType ? PlotRegistry.getForDataType(kindOf(nextType)).map(entry => entry.id) : [];
    if (plot !== undefined && !compatible.includes(plot)) {
      throw namedError(RangeError, `Detailed cannot draw ${quoteName(plot)} for this variable; it draws ${listNames(compatible)}.`);
    }
    const plotId = plot ?? (compatible.includes(this._currentConfig.plotType) ? this._currentConfig.plotType : compatible[0]);
    const schema = plotId ? PlotRegistry.get(plotId)?.optionSchema ?? {} : {};
    for (const { option } of plotOptions ?? []) {
      if (!Object.hasOwn(schema, option)) {
        throw namedError(RangeError, `The ${plotId} plot has no option ${quoteName(option)}; its options are ${listNames(Object.keys(schema))}.`);
      }
    }
    const before = JSON.stringify(this._currentConfig);
    if (variable !== undefined) {
      const applied = () => {
        const shown = this._currentConfig.dataSource;
        return variable === null ? !shown.variable : shown.type === variable.type && shown.variable === variable.key;
      };
      // The selector shows it (and may apply it, as a person's choice does); applied once either way.
      if (!applied()) this._variableSelector?.setSelectedVariable(variable?.type ?? '', variable?.key ?? '');
      if (!applied()) this._applyVariable(variable);
    }
    // Applied, not reported as the person's (the action's own step holds it): a person's change
    // is a step of its own even while an action runs (dispatcher `recordObserved`).
    if (plot !== undefined && plot !== this._currentConfig.plotType) {
      this._applyPlotType(plot);
      this._renderControls();
    }
    for (const { option, value } of plotOptions ?? []) this._applyPlotOption(option, value);
    return JSON.stringify(this._currentConfig) !== before;
  }

  _handlePageChange = (pageIds) => {
    this._assignPages(pageIds || []);
    this._scheduleUpdate();

    if (this.onConfigChange) {
      this.onConfigChange(this._currentConfig);
    }
  };

  _handlePageColorChange = (pageId, color) => {
    // Persist color to DataState for base pages; component handles derived colors internally
    this.dataLayer?.setPageColor?.(pageId, color);
    this._scheduleUpdate();
  };

  /** A person's choice of plot (the plot type selector): a step (`analysis.detailed.set`). */
  _handlePlotTypeChange(plotTypeId) {
    if (plotTypeId !== this._currentConfig.plotType) this._recordPersonChange('detailed', { plot: plotTypeId });
    this._applyPlotType(plotTypeId);
  }

  /** Draw `plotTypeId` with its saved options (a person's choice, or `setPlot`'s). */
  _applyPlotType(plotTypeId) {
    this._currentConfig.plotType = plotTypeId;
    this._currentConfig.plotOptions = this._getSavedOptionsForPlotType(plotTypeId);
    this._scheduleUpdate();

    if (this._modal?._optionsContent) {
      this._modal._optionsPlotType = plotTypeId;
      renderPlotOptions(
        this._modal._optionsContent,
        plotTypeId,
        this._currentConfig.plotOptions,
        this._handlePlotOptionChange
      );
    }
  }

  /** A person's plot option (the expanded view's options): a step (`analysis.detailed.set`). */
  _handlePlotOptionChange(key, value) {
    if (this._currentConfig.plotOptions[key] !== value) {
      this._recordPersonChange('detailed', { plotOptions: [{ option: key, value }] });
    }
    this._applyPlotOption(key, value);
  }

  /** Set one plot option and keep it for its plot type (a person's change, or `setPlot`'s). */
  _applyPlotOption(key, value) {
    setOwnDataProperty(this._currentConfig.plotOptions, key, value);
    this._saveOptionsForPlotType(this._currentConfig.plotType, this._currentConfig.plotOptions);
    this._scheduleUpdate();
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  /**
   * Clear data source selection
   */
  _clearDataSource() {
    this._currentConfig.dataSource.type = '';
    this._currentConfig.dataSource.variable = '';
    this._currentConfig.plotType = '';
    this._currentConfig.plotOptions = {};
  }

  /**
   * Update plot type based on data kind (categorical vs continuous)
   * @param {string} kind - 'categorical' or 'continuous'
   */
  _updatePlotTypeForDataKind(kind) {
    const compatiblePlots = PlotRegistry.getForDataType(kind);
    const currentPlotCompatible = compatiblePlots.find(p => p.id === this._currentConfig.plotType);

    if (!currentPlotCompatible && compatiblePlots.length > 0) {
      this._currentConfig.plotType = compatiblePlots[0].id;
      this._currentConfig.plotOptions = {};
    }
  }

  _reportPlotLifecycleError(context, error) {
    if (!(error instanceof Error)) {
      error = new TypeError(`${context} failed with a non-Error value`);
    }
    this._notifications.error(
      `${context} failed: ${sayFailure(error)}`,
      { ...failureDetails(error), category: 'analysis', title: 'Analysis error' }
    );
  }

  _createPlotSlot(host, candidateClassName) {
    return new PlotlyRenderSlot({
      host,
      candidateClassName,
      onResizeError: error => {
        this._reportPlotLifecycleError('Plot resize', error);
      }
    });
  }

  _ensurePreviewPlotSlot() {
    if (this._previewPlotSlot !== null) return this._previewPlotSlot;
    if (!(this._previewContainer instanceof HTMLElement)) {
      throw new TypeError('Detailed preview requires an initialized container');
    }
    this._previewPlotSlot = this._createPlotSlot(
      this._previewContainer,
      'analysis-preview-plot'
    );
    return this._previewPlotSlot;
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

  _destroyModalPlotOwner(modal) {
    const slot = modal?._analysisPlotSlot ?? null;
    if (this._modal === modal) this._modal = null;
    if (this._modalPlotSlot === slot) this._modalPlotSlot = null;
    modal._analysisPlotSlot = null;
    if (slot === null) return Promise.resolve();
    return this._trackModalCloseTask(slot.destroy());
  }

  _ensureModalPlotSlot(modal) {
    if (!(modal?._plotContainer instanceof HTMLElement)) {
      throw new TypeError('Detailed modal requires an exact plot container');
    }
    if (modal._analysisPlotSlot != null) {
      this._modalPlotSlot = modal._analysisPlotSlot;
      return modal._analysisPlotSlot;
    }
    const slot = this._createPlotSlot(
      modal._plotContainer,
      'analysis-modal-plot-candidate'
    );
    modal._analysisPlotSlot = slot;
    this._modalPlotSlot = slot;
    if (modal._beforeClose == null) {
      modal._beforeClose = () => this._destroyModalPlotOwner(modal);
    }
    return slot;
  }

  _scheduleUpdate(delay = 300) {
    this._modalRenderGeneration += 1;
    return super._scheduleUpdate(delay);
  }

  // _canRunAnalysis(), _scheduleUpdate(), _runAnalysisIfValid() - inherited from BaseAnalysisUI

  // ===========================================================================
  // Analysis Execution
  // ===========================================================================

  /** A gene's values are read when the variable is a gene's. @override */
  _runReadsGenes() {
    return this._currentConfig?.dataSource?.type === 'gene_expression';
  }

  /**
   * Run the analysis (implements abstract method from BaseAnalysisUI)
   * @override
   */
  async _runAnalysis(requestId, job) {
    if (!this._isCurrentAnalysisRequest(requestId)) return;
    const openCells = this.dataLayer.state?.pointCount ?? 0;
    const isCurrent = () => this._isCurrentAnalysisRequest(requestId);
    const progress = { shown: null };
    try {
      // A first pass on a uniform sample of the open cells, when it answers
      // sooner by enough to be worth its cost (measured on this device);
      // each pass draws its plot.
      const done = await this._whileBusy(
        this._previewContainer,
        () => runProgressively({
          kind: analysisCostKind(this._getJobTitle()),
          dataLayer: this.dataLayer,
          job,
          isCurrent,
          progress,
          pass: async sample => {
            await this._runPreviewAnalysis(requestId, job, sample);
            return isCurrent() ? true : null;
          },
          onFirstPass: async (_drawn, sample) => {
            this._showCellsUsed(sample, openCells, 'refining');
            // Canceled or superseded while refining: the first pass stays
            // on screen, saying it is one.
            this._registerAnalysisInvalidationCleanup(requestId, () => {
              if (progress.shown === sample) this._showCellsUsed(sample, openCells, 'stopped');
            });
          }
        })
      );
      if (done !== null && isCurrent()) {
        progress.shown = null;
        this._showCellsUsed(null, openCells, null, true);
      }
      else if (progress.shown !== null && isCurrent()) this._showCellsUsed(progress.shown, openCells, 'stopped');
    } catch (error) {
      if (progress.shown !== null && isCurrent()) this._showCellsUsed(progress.shown, openCells, 'stopped');
      throw error;
    }
  }

  /** @override */
  _getJobTitle() {
    return 'Detailed analysis';
  }

  /** @private */
  async _runPreviewAnalysis(requestId, job, sample = null) {
    const config = structuredClone(this._currentConfig);
    // A first pass reads each page's cells in the sample (`progressive-cells.js`).
    const pageIds = sample === null ? [...this._selectedPages] : sample.pageIds([...this._selectedPages]);
    // Every page in its swatch's color, whatever order the pages were picked in.
    const pageColors = new Map(this._pageSelector?.getPageColors?.() || []);

    if (!this._isCurrentAnalysisRequest(requestId)) return;
    this._previewContainer.classList.remove('empty');
    this._previewContainer.classList.add('loading');

    try {
      await loadPlotly();
      if (!this._isCurrentAnalysisRequest(requestId)) return;

      // Fetch data
      job.step(`Reading ${config.dataSource.variable}`);
      const fetchedPageData = await this.dataLayer.getDataForPages({
        type: config.dataSource.type,
        variableKey: config.dataSource.variable,
        pageIds,
        silent: true,
        signal: job.signal,
        owner: job.id
      });
      job.step('Drawing the plot');
      // Missing categories are excluded per variable, before any plot,
      // summary table or categorical test sees the page.
      const pageDataOfCells = config.dataSource.type === 'categorical_obs'
        ? excludeMissingCategoricalValues(fetchedPageData)
        : fetchedPageData;
      // A sample's pages are named and colored as their pages.
      const pageData = (sample === null
        ? pageDataOfCells
        : pageDataOfCells.map(page => ({ ...page, pageId: sample.basePageId(page.pageId) })))
        .map(page => (pageColors.has(page.pageId) ? { ...page, pageColor: pageColors.get(page.pageId) } : page));

      if (!this._isCurrentAnalysisRequest(requestId)) return;
      if (pageData.length === 0) {
        throw new Error('No data available for selected pages');
      }

      // Create layout engine with custom colors from page selector
      const layoutEngine = createLayoutEngine({
        pageCount: pageData.length,
        pageIds: pageData.map(pd => pd.pageId),
        pageNames: pageData.map(pd => pd.pageName),
        syncXAxis: true,
        syncYAxis: true,
        // The engine takes the colors of the pages it draws, no other.
        customColors: new Map(pageData.filter(pd => pageColors.has(pd.pageId)).map(pd => [pd.pageId, pageColors.get(pd.pageId)]))
      });

      // Get plot type
      const plotType = PlotRegistry.get(config.plotType);
      if (!plotType) {
        throw new Error(`Unknown plot type: ${config.plotType}`);
      }

      const mergedOptions = PlotRegistry.mergeOptions(
        config.plotType,
        config.plotOptions
      );

      if (!this._isCurrentAnalysisRequest(requestId)) return;
      const previewSlot = this._ensurePreviewPlotSlot();
      const previewPlotDiv = await previewSlot.render(
        {
          pageData,
          valueLabel: BasePlot.getValueLabel(pageData),
          render: candidate => plotType.render(
            pageData,
            mergedOptions,
            candidate,
            layoutEngine,
            { signal: job.signal }
          )
        },
        {
          isCurrent: () => this._isCurrentAnalysisRequest(requestId)
        }
      );
      if (previewPlotDiv === null) return;

      this._previewContainer.classList.remove('loading');
      this._previewContainer.classList.remove('empty');
      this._currentPageData = pageData;
      this._committedView = Object.freeze({ config, pageData, layoutEngine });
      // A gene read for a sample of the open cells is summarized on its
      // cells with a value (NaN elsewhere): the chip says which.
      const geneSample = config.dataSource.type === 'gene_expression' ? (this.dataLayer.state?.getGeneSample?.() ?? null) : null;
      this._showCellChoice(this.dataLayer.state?.cellIdentity ?? null, geneSample === null ? null : { cells: geneSample.cells, of: geneSample.of, groups: [] });

      // Show actions
      this._renderActions();

      // Update modal if open
      if (this._modal?._plotContainer) {
        await this._updateModal(plotType, mergedOptions, requestId);
      }

    } catch (err) {
      if (!this._isCurrentAnalysisRequest(requestId)) return;
      this._previewContainer.classList.remove('loading');
      this._previewContainer.classList.add('empty');
      throw err;
    }
  }

  async _updateModal(plotType, options, requestId) {
    if (!this._isCurrentAnalysisRequest(requestId)) return;
    const modal = this._modal;
    const plotContainer = modal?._plotContainer;
    if (!plotContainer) return;
    const committed = this._committedView;
    await this._whileBusy(
      modal._body,
      () => this._redrawModal(modal, committed, plotType, options, requestId)
    );
  }

  /** @private */
  async _redrawModal(modal, committed, plotType, options, requestId) {
    const { config, pageData, layoutEngine } = committed;
    this._renderModalHeading(modal, config, pageData);

    const slot = this._ensureModalPlotSlot(modal);
    await slot.waitForCommittedLeases();
    if (
      !this._isCurrentAnalysisRequest(requestId) ||
      this._modal !== modal
    ) {
      return;
    }
    const candidate = await slot.render(
      {
        pageData,
        valueLabel: BasePlot.getValueLabel(pageData),
        render: plotCandidate => plotType.render(
          pageData,
          options,
          plotCandidate,
          layoutEngine
        )
      },
      {
        isCurrent: () => (
          this._isCurrentAnalysisRequest(requestId) &&
          this._modal === modal
        )
      }
    );
    if (candidate === null) return;

    // Large pages' summary and tests are computed by the analysis workers.
    if (modal._statsContent || modal._annotationsContent) {
      await preparePageStatistics(pageData, config.dataSource.type);
      if (
        !this._isCurrentAnalysisRequest(requestId) ||
        this._modal !== modal
      ) {
        return;
      }
    }

    const modalAfter = this._modal;
    if (!modalAfter) return;

    if (modalAfter._statsContent) {
      renderSummaryStats(
        modalAfter._statsContent,
        pageData,
        BasePlot.getValueLabel(pageData)
      );
    }

    if (modalAfter._annotationsContent) {
      renderStatisticalAnnotations(
        modalAfter._annotationsContent,
        pageData,
        config.dataSource.type
      );
    }
  }

  // ===========================================================================
  // Preview & Actions
  // ===========================================================================

  async _hidePreview(requestId = null) {
    const publicationCurrent =
      await this._cleanupPreviousAnalysis(requestId);
    if (!publicationCurrent) return false;

    if (this._previewContainer) {
      for (const child of [...this._previewContainer.children]) {
        if (
          child.classList.contains('status-line') ||
          child.classList.contains('empty-state')
        ) {
          child.remove();
        }
      }
      this._previewContainer.classList.add('empty');
      this._previewContainer.classList.remove('loading');
    }
    if (this._actionsContainer) {
      this._actionsContainer.hidden = true;
    }
    this._showCellsUsed(null);
    this._showCellChoice(null);
    return true;
  }

  async _cleanupPreviousAnalysis(requestId = null) {
    const modal = this._modal;
    const tasks = [];
    const errors = [];
    for (const slot of [
      this._previewPlotSlot,
      modal?._analysisPlotSlot
    ]) {
      if (slot === null || slot === undefined) continue;
      try {
        tasks.push(slot.invalidate());
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
    const publicationCurrent = (
      requestId === null ||
      this._isCurrentAnalysisIntent(requestId)
    );
    if (publicationCurrent) {
      this._currentPageData = null;
      this._committedView = null;
      if (this._modal === modal && modal !== null) {
        for (const content of [
          modal._statsContent,
          modal._annotationsContent
        ]) {
          if (content === null || content === undefined) continue;
          try {
            content.innerHTML = '';
          } catch (error) {
            errors.push(error);
          }
        }
      }
    }
    const failure = combineErrors(
      errors,
      'Detailed plot cleanup failed'
    );
    if (failure) throw failure;
    return publicationCurrent;
  }

  /**
   * Render action buttons (expand, etc.)
   */
  _renderActions() {
    this._actionsContainer.innerHTML = '';
    this._actionsContainer.hidden = false;

    const expandBtn = createExpandButton(() => {
      this._trackInteractiveTask(
        this._openExpandedView(),
        'Expanded analysis view'
      );
    });
    this._actionsContainer.appendChild(expandBtn);
  }

  // ===========================================================================
  // Modal / Expanded View
  // ===========================================================================

  /**
   * Title and options panel for the committed result the modal shows. The
   * options panel is rebuilt only when the committed plot type changes, so an
   * option being edited in the modal keeps its focus across redraws.
   * @private
   */
  _renderModalHeading(modal, config, pageData) {
    if (modal._title) {
      modal._title.textContent = `Comparing: ${BasePlot.getValueLabel(pageData)}`;
    }
    if (modal._optionsContent && modal._optionsPlotType !== config.plotType) {
      modal._optionsPlotType = config.plotType;
      renderPlotOptions(
        modal._optionsContent,
        config.plotType,
        config.plotOptions,
        this._handlePlotOptionChange
      );
    }
  }

  async _openExpandedView() {
    const committed = this._committedView;
    if (committed === null) return;
    const generation = ++this._modalRenderGeneration;
    let modal = null;
    modal = createAnalysisModal({
      beforeClose: () => this._destroyModalPlotOwner(modal),
      onClose: () => {
        if (this._modal === modal) this._modal = null;
      },
      onCloseError: error => {
        this._reportPlotLifecycleError('Expanded view cleanup', error);
      },
      onExportPNG: () => this._trackInteractiveTask(
        this._exportPNG(),
        'PNG export'
      ),
      onExportSVG: () => this._trackInteractiveTask(
        this._exportSVG(),
        'SVG export'
      ),
      onExportCSV: () => this._trackInteractiveTask(
        this._exportCSV(),
        'CSV export'
      )
    });
    this._modal = modal;
    this._renderModalHeading(modal, committed.config, committed.pageData);
    // Closed while it opened: its close has begun and its plot owner is
    // gone, so nothing is drawn into it.
    if (!openModal(modal)) return;
    if (modal._plotContainer) {
      await this._whileBusy(
        modal._body,
        () => this._drawExpandedView(modal, committed, generation)
      );
    }
  }

  /** @private */
  async _drawExpandedView(modal, committed, generation) {
    const { config, pageData, layoutEngine } = committed;
    try {
      await loadPlotly();
      // Closed while Plotly loaded: its close took its plot owner, and a
      // slot made now would hold a plot nothing purges.
      if (
        this._isDestroyed ||
        this._modal !== modal ||
        generation !== this._modalRenderGeneration
      ) {
        return;
      }

      const plotType = PlotRegistry.get(config.plotType);
      if (!plotType) {
        throw new RangeError(`Unknown plot type: ${config.plotType}`);
      }
      const mergedOptions = PlotRegistry.mergeOptions(
        config.plotType,
        config.plotOptions
      );

      const slot = this._ensureModalPlotSlot(modal);
      const candidate = await slot.render(
        {
          pageData,
          valueLabel: BasePlot.getValueLabel(pageData),
          render: plotCandidate => plotType.render(
            pageData,
            mergedOptions,
            plotCandidate,
            layoutEngine
          )
        },
        {
          isCurrent: () => (
            !this._isDestroyed &&
            this._modal === modal &&
            generation === this._modalRenderGeneration
          )
        }
      );
      if (candidate === null) return;

      // Large pages' summary and tests are computed by the analysis workers.
      if (modal._statsContent || modal._annotationsContent) {
        await preparePageStatistics(pageData, config.dataSource.type);
        if (
          this._isDestroyed ||
          this._modal !== modal ||
          generation !== this._modalRenderGeneration
        ) {
          return;
        }
      }

      if (modal._statsContent) {
        renderSummaryStats(
          modal._statsContent,
          pageData,
          BasePlot.getValueLabel(pageData)
        );
      }

      if (modal._annotationsContent) {
        renderStatisticalAnnotations(
          modal._annotationsContent,
          pageData,
          config.dataSource.type
        );
      }
    } catch (err) {
      if (
        this._modal === modal &&
        generation === this._modalRenderGeneration
      ) {
        console.error('[DetailedAnalysisUI] Modal render failed:', err);
        await modal._analysisPlotSlot?.invalidate();
        modal._plotContainer.innerHTML = '';
        modal._plotContainer.appendChild(createStatusLine({
          tone: 'danger',
          text: `${joinFailure(`The plot could not be drawn`, sayFailure(err))} Run the analysis again to redraw it.`
        }).root);
      }
    }
  }

  // ===========================================================================
  // Export Functions - Override to use detailed-specific containers
  // ===========================================================================

  _getActivePlotSlot() {
    return this._modal?._analysisPlotSlot ?? this._previewPlotSlot;
  }

  /**
   * Export PNG - delegates to base class with detailed-specific container
   * @override
   */
  async _exportPNG() {
    const slot = this._getActivePlotSlot();
    if (slot == null) return;
    await slot.withCommittedPlot(candidate => (
      super._exportPNG(candidate, { filename: 'detailed-analysis' })
    ));
  }

  /**
   * Export SVG - delegates to base class with detailed-specific container
   * @override
   */
  async _exportSVG() {
    const slot = this._getActivePlotSlot();
    if (slot == null) return;
    await slot.withCommittedPlot(candidate => (
      super._exportSVG(candidate, { filename: 'detailed-analysis' })
    ));
  }

  /**
   * Export CSV - delegates to base class with detailed-specific data
   * @override
   */
  async _exportCSV() {
    const slot = this._getActivePlotSlot();
    if (slot == null) return;
    await slot.withCommittedPlot((_candidate, renderResult) => {
      const payload = renderResult?.payload;
      if (
        !Array.isArray(payload?.pageData) ||
        typeof payload.valueLabel !== 'string' ||
        payload.valueLabel.length === 0
      ) {
        throw new Error(
          'Detailed CSV export requires exact committed plot data'
        );
      }
      return super._exportCSV(
        payload.pageData,
        payload.valueLabel,
        'detailed-analysis-data.csv'
      );
    });
  }

  // ===========================================================================
  // Options Persistence (Session Only)
  // ===========================================================================

  _getSavedOptionsForPlotType(plotTypeId) {
    const saved = this._savedPlotOptions.get(plotTypeId) || {};
    return PlotRegistry.mergeOptions(plotTypeId, saved);
  }

  _saveOptionsForPlotType(plotTypeId, options) {
    // One entry per plot type: the registry bounds it, so every plot type
    // the user configured keeps its options.
    this._savedPlotOptions.set(plotTypeId, { ...options });
  }

  // ===========================================================================
  // Cleanup & Lifecycle
  // ===========================================================================

  // _cleanupPreviousAnalysis(), onPagesChanged(), onHighlightChanged(),
  // getConfig(), setConfig() - inherited from BaseAnalysisUI

  /**
   * Destroy and cleanup
   * @override
   */
  destroy() {
    if (this._destroyPromise != null) return this._destroyPromise;

    const { promise: destroyTask, resolve: resolveDestroy, reject: rejectDestroy } = promiseWithResolvers();
    this._destroyPromise = destroyTask;

    const errors = [];
    const selectorTasks = [];
    this._isDestroyed = true;
    this._stopGeneSampleWatch?.();
    this._modalRenderGeneration += 1;
    try {
      this._invalidateAnalysisRequest();
    } catch (error) {
      errors.push(error);
    }
    this._pendingUpdate.cancel();
    // The update that will not run now is settled, so nothing waits for it.
    this._settleScheduledUpdate?.();
    this._settleScheduledUpdate = null;
    for (const [label, owner] of [
      ['variable selector', this._variableSelector],
      ['page selector', this._pageSelector]
    ]) {
      if (owner === null || owner === undefined) continue;
      if (typeof owner.destroy !== 'function') {
        errors.push(
          new TypeError(`Detailed Analysis ${label} must implement destroy()`)
        );
        continue;
      }
      try {
        const result = owner.destroy();
        if (result !== null && result !== undefined &&
            typeof result.then === 'function') {
          selectorTasks.push(result);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    this._variableSelector = null;
    this._variableBlock = null;
    this._pageSelector = null;
    this._pageSelectContainer = null;

    // Clean up detailed-specific state
    this._savedPlotOptions.clear();
    const previewSlot = this._previewPlotSlot;
    const modal = this._modal;
    void Promise.resolve().then(async () => {
      const cleanupTasks = [
        ...selectorTasks,
        ...(this._pendingModalCloseTasks ?? [])
      ];
      if (previewSlot !== null && previewSlot !== undefined) {
        if (typeof previewSlot.destroy !== 'function') {
          errors.push(
            new TypeError(
              'Detailed Analysis preview plot owner must implement destroy()'
            )
          );
        } else {
          try {
            cleanupTasks.push(previewSlot.destroy());
          } catch (error) {
            errors.push(error);
          }
        }
      }
      if (modal !== null && modal !== undefined) {
        try {
          cleanupTasks.push(closeModal(modal));
        } catch (error) {
          errors.push(error);
        }
      }
      const outcomes = await Promise.allSettled(cleanupTasks);
      errors.push(
        ...outcomes
          .filter(outcome => outcome.status === 'rejected')
          .map(outcome => outcome.reason)
      );
      this._previewPlotSlot = null;
      this._modalPlotSlot = null;
      this._modal = null;
      this._committedView = null;
      try {
        await super.destroy();
      } catch (error) {
        errors.push(error);
      }
      const failure = combineErrors(
        errors,
        'Detailed Analysis destruction failed'
      );
      if (failure) throw failure;
    }).then(resolveDestroy, rejectDestroy);
    void destroyTask.catch(() => {});
    return destroyTask;
  }
}

/**
 * Create detailed analysis UI instance
 */
export function createDetailedAnalysisUI(options) {
  const ui = new DetailedAnalysisUI(options);
  ui.init(options.container);
  return ui;
}
