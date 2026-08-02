/**
 * Genes Panel UI
 *
 * Main UI component for the Marker Genes Panel feature.
 * Extends FormBasedAnalysisUI for consistent UX with other analysis types.
 *
 * Features:
 * - Category selection for grouping
 * - Analysis mode selection (ranked, clustered, custom)
 * - Statistical method and threshold configuration
 * - Visualization options (transform, colorscale)
 * - Clustering options (distance, linkage)
 * - Interactive heatmap with hover details
 * - Export functionality
 *
 * @module ui/analysis-types/genes-panel-ui
 */

import { FormBasedAnalysisUI } from './base/form-based-analysis.js';
import {
  createCollapsibleSection,
  createFormSelect,
  createFormRow,
  createFormCheckbox,
  createPerformanceSettings,
  getPerformanceFormValues
} from '../../shared/dom-utils.js';
import { GenesPanelController } from '../../genes-panel/genes-panel-controller.js';
import { encodeGroupName } from '../../genes-panel/expression-matrix-builder.js';
import { HoverContext } from '../components/hover-context.js';
import { ProgressTracker } from '../../shared/progress-tracker.js';
import { PlotRegistry } from '../../shared/plot-registry-utils.js';
import { downloadCSV, toCSVCell } from '../../shared/analysis-utils.js';
import {
  DEFAULTS,
  DISTANCE_OPTIONS,
  LINKAGE_OPTIONS,
  MODE_OPTIONS,
  ANALYSIS_PHASES
} from '../../genes-panel/constants.js';
import { setOwnDataProperty } from '../../../../utils/exact-record.js';

// =============================================================================
// GENES PANEL UI
// =============================================================================

/**
 * Genes Panel UI Component
 *
 * @extends FormBasedAnalysisUI
 */
export class GenesPanelUI extends FormBasedAnalysisUI {
  /**
   * Get page requirements for this analysis type
   * @returns {{ minPages: number, maxPages: number, description: string }}
   */
  static getRequirements() {
    return {
      minPages: 0,
      maxPages: null,
      description: 'Discover and visualize marker genes across cell groups'
    };
  }

  /**
   * @param {Object} options
   * @param {Object} options.comparisonModule - Reference to main comparison module
   * @param {Object} options.dataLayer - Enhanced data layer
   */
  constructor(options) {
    super(options);

    /** @type {GenesPanelController|null} */
    this._controller = null;

    /** @type {Error|AggregateError|null} Deferred controller cleanup diagnostic */
    this._controllerCloseError = null;

    /** @type {HoverContext|null} */
    this._hoverContext = null;

    /**
     * Exact Plotly listener ownership for the active hover context.
     * @type {{
     *   container: HTMLElement,
     *   hoverHandler: Function,
     *   unhoverHandler: Function
     * }|null}
     */
    this._hoverPlotBinding = null;
    /** @type {Map<HTMLElement, { context: HoverContext, binding: Object }>} */
    this._hoverOwners = new Map();

    /** @type {ProgressTracker|null} */
    this._progressTracker = null;

    /** @type {HTMLElement|null} Custom genes textarea */
    this._customGenesInput = null;

    /** @type {HTMLElement|null} The rendered form subtree, before it is attached */
    this._formRoot = null;

    /**
     * Modal-only UI state: which group is selected in the marker table.
     * @type {string|null}
     * @private
     */
    this._modalSelectedGroupId = null;

    /**
     * Modal-only UI state: how many markers to show in the table.
     * @type {'top5'|'top10'|'top20'|'top100'|'all'}
     * @private
     */
    this._modalGeneListMode = 'top5';

    /**
     * Incremented per modal-annotations render to cancel async chunk rendering.
     * @type {number}
     * @private
     */
    this._modalAnnotationsRenderRevision = 0;

    /** @type {any|null} Full (unsliced) heatmap matrix from last run */
    this._fullMatrix = null;

    /** @type {'top5'|'top10'|'top20'|'top100'|'all'|null} */
    this._committedGeneListMode = null;

    /**
     * Serial owner for latest-intent heatmap reconciliation. Plot render
     * revisions may supersede one another, but every latest visual intent still
     * reconciles the requested scientific selection before it can commit.
     * @type {Promise<void>}
     * @private
     */
    this._geneOptionTail = Promise.resolve();

    // Bind methods
    this._handleModeChange = this._handleModeChange.bind(this);
  }

  // ===========================================================================
  // ABSTRACT METHOD IMPLEMENTATIONS
  // ===========================================================================

  /**
   * @override
   */
  _getTitle() {
    return 'Marker Genes';
  }

  /**
   * @override
   */
  _getDescription() {
    return 'Discover marker genes for each group and visualize as a clustered heatmap.';
  }

  /**
   * @override
   */
  _getClassName() {
    return 'genes-panel';
  }

  /**
   * @override
   */
  _getRunButtonText() {
    return 'Discover Markers';
  }

  /**
   * @override
   */
  _getLoadingMessage() {
    return 'Discovering marker genes...';
  }

  /**
   * @override
   */
  _renderFormControls(wrapper) {
    const form = document.createElement('div');
    form.className = 'analysis-form genes-panel-form';
    this._formRoot = form;

    // Get available categories
    const categories = this._getAvailableCategories();

    // Build category options with placeholder if needed
    const categoryOptions = categories.length > 0
      ? categories.map(c => ({ value: c, label: c }))
      : [{ value: '', label: 'No categorical fields available' }];

    // Category selection
    const categorySelectEl = createFormSelect('obsCategory', categoryOptions);
    const categoryRow = createFormRow('Group By:', categorySelectEl, {
      description: ''
    });
    form.appendChild(categoryRow);

    // Use cache (placed next to Group By as it affects data loading)
    const useCacheCheckbox = createFormCheckbox({
      label: 'Use cached results',
      name: 'useCache',
      checked: true
    });
    form.appendChild(useCacheCheckbox);

    // Mode selection - using positional API with onChange for reliability
    const modeSelectEl = createFormSelect('mode', MODE_OPTIONS.map(o => ({
      value: o.value,
      label: o.label,
      description: o.description,
      selected: o.value === 'clustered'
    })), { onChange: this._handleModeChange });
    // Statistical method selector (placed next to Mode; thresholds are adjusted in the figure modal)
    const methodSelectEl = createFormSelect('method', [
      { value: 'wilcox', label: 'Wilcoxon', description: 'Rank-based test, robust to outliers and non-normal distributions.', selected: true },
      { value: 'ttest', label: 't-test', description: 'Parametric test, assumes normally distributed expression data.' }
    ]);

    // The row's visible label reads "Mode:", so the second select sharing that
    // row needs to say what it is on its own.
    const methodControl = methodSelectEl.querySelector('select') ?? methodSelectEl;
    methodControl.setAttribute('aria-label', 'Statistical method');

    const modeAndMethod = document.createElement('div');
    modeAndMethod.className = 'page-comparison-row';
    modeSelectEl.classList.add('page-select');
    methodSelectEl.classList.add('page-select');
    modeAndMethod.appendChild(modeSelectEl);
    modeAndMethod.appendChild(methodSelectEl);

    const modeRow = createFormRow('Mode:', modeAndMethod, { description: '' });
    form.appendChild(modeRow);

    // Custom genes input (hidden by default)
    const customGenesGroup = document.createElement('div');
    customGenesGroup.className = 'form-section custom-genes-group hidden';
    const customGenesLabel = document.createElement('div');
    customGenesLabel.className = 'section-title';
    customGenesLabel.textContent = 'Custom Genes';
    customGenesGroup.appendChild(customGenesLabel);
    const customGenesTextarea = document.createElement('textarea');
    customGenesTextarea.name = 'customGenes';
    customGenesTextarea.className = 'analysis-form-textarea';
    customGenesTextarea.placeholder = 'Enter gene symbols, one per line or comma-separated';
    customGenesTextarea.rows = 4;
    customGenesTextarea.style.cssText = 'width: 100%; font-family: monospace; font-size: 12px;';
    customGenesGroup.appendChild(customGenesTextarea);
    this._customGenesInput = customGenesTextarea;
    form.appendChild(customGenesGroup);

    // Clustering section (collapsible, closed by default as detailed settings, hidden when mode='ranked')
    const { container: clusterSection, content: clusterContent } = this._createCollapsibleSection({
      title: 'Clustering',
      className: 'cluster-params',
      expanded: false
    });

    // Distance metric
    const distanceSelectEl = createFormSelect('distance', DISTANCE_OPTIONS.map(o => ({
      value: o.value,
      label: o.label,
      description: o.description,
      selected: o.selected
    })));
    clusterContent.appendChild(createFormRow('Distance Metric:', distanceSelectEl));

    // Linkage method
    const linkageSelectEl = createFormSelect('linkage', LINKAGE_OPTIONS.map(o => ({
      value: o.value,
      label: o.label,
      description: o.description,
      selected: o.selected
    })));
    clusterContent.appendChild(createFormRow('Linkage Method:', linkageSelectEl));

    // Cluster options
    const clusterRowsCheckbox = createFormCheckbox({
      label: 'Cluster Genes (rows)',
      name: 'clusterRows',
      checked: DEFAULTS.clusterRows
    });
    clusterContent.appendChild(clusterRowsCheckbox);

    const clusterColsCheckbox = createFormCheckbox({
      label: 'Cluster Groups (columns)',
      name: 'clusterCols',
      checked: DEFAULTS.clusterCols
    });
    clusterContent.appendChild(clusterColsCheckbox);

    form.appendChild(clusterSection);

    // Performance settings section (shared with DE analysis)
    const perfSettings = createPerformanceSettings({
      dataLayer: this.dataLayer,
      collapsed: true
    });
    form.appendChild(perfSettings);

    wrapper.appendChild(form);

    // Initialize section visibility from the mode the form actually shows.
    // Hard-coding 'clustered' contradicted the select whenever the form was
    // rebuilt with a carried-over mode.
    this._handleModeChange(
      (modeSelectEl.querySelector('select') ?? modeSelectEl).value
    );
  }

  /**
   * @override
   */
  _getFormValues() {
    const form = this._formContainer?.querySelector('.analysis-form');
    if (!form) {
      throw new Error('Marker analysis form is not mounted');
    }

    const getValue = (name) => {
      const el = form.querySelector(`[name="${name}"]`);
      if (!el) {
        throw new Error(`Marker analysis form field "${name}" is required`);
      }
      if (el.type === 'checkbox') {
        if (typeof el.checked !== 'boolean') {
          throw new TypeError(
            `Marker analysis checkbox "${name}" must expose a boolean checked state`
          );
        }
        return el.checked;
      }
      if (typeof el.value !== 'string' || el.value.length === 0) {
        throw new TypeError(
          `Marker analysis form field "${name}" must expose a non-empty value`
        );
      }
      return el.value;
    };

    const values = {
      obsCategory: getValue('obsCategory'),
      mode: getValue('mode'),
      topNPerGroup: DEFAULTS.topNPerGroup,
      method: getValue('method'),
      // Thresholds are adjusted dynamically in the figure modal; keep defaults for initial run.
      pValueThreshold: DEFAULTS.pValueThreshold,
      foldChangeThreshold: DEFAULTS.foldChangeThreshold,
      transform: DEFAULTS.transform,
      colorscale: DEFAULTS.colorscale,
      distance: getValue('distance'),
      linkage: getValue('linkage'),
      clusterRows: getValue('clusterRows'),
      clusterCols: getValue('clusterCols'),
      useAdjustedPValue: DEFAULTS.useAdjustedPValue,
      useCache: getValue('useCache'),
      // Performance settings (shared with DE analysis)
      ...getPerformanceFormValues(form)
    };

    // Handle custom genes
    if (values.mode === 'custom' && this._customGenesInput) {
      if (typeof this._customGenesInput.value !== 'string') {
        throw new TypeError(
          'Custom marker gene input must expose a string value'
        );
      }
      const text = this._customGenesInput.value;
      values.customGenes = text
        .split(/[\n,]+/)
        .map(g => g.trim())
        .filter(g => g.length > 0);
    }

    return values;
  }

  /**
   * Override _runAnalysis to use ProgressTracker for detailed progress notifications.
   * This replaces the base class's runAnalysisWithLoadingState with proper progress tracking.
   * @override
   */
  async _runAnalysis() {
    if (this._isDestroyed) return;

    // Get form values
    const formValues = structuredClone(this._getFormValues());

    // Validate form
    const validation = this._validateForm(formValues);
    if (!validation.valid) {
      this._invalidateAnalysisRequest();
      this._notifications.error(validation.error || 'Invalid form values');
      return;
    }

    const requestId = this._startAnalysisRequest();
    if (requestId === null) return;

    // Get run button for state management
    const runBtn = this._formContainer?.querySelector('.analysis-run-btn');
    const originalText = runBtn?.textContent;
    let buttonRestored = false;
    const restoreButton = () => {
      if (!runBtn || buttonRestored) return;
      runBtn.disabled = false;
      runBtn.textContent = originalText;
      buttonRestored = true;
    };

    // Update button state
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.textContent = 'Running...';
    }

    // Create progress tracker with phases matching the controller
    const progressTracker = new ProgressTracker({
      totalItems: 1, // Updated dynamically once totals are known
      phases: [
        ANALYSIS_PHASES.INIT,
        ANALYSIS_PHASES.DISCOVERY,
        ANALYSIS_PHASES.MATRIX,
        ANALYSIS_PHASES.CLUSTERING,
        ANALYSIS_PHASES.RENDER
      ],
      title: 'Marker Genes Discovery',
      category: 'calculation',
      showNotification: true
    });

    this._progressTracker = progressTracker;
    progressTracker.start();
    let progressSettled = false;
    const controllerRunOwner = {
      controller: null,
      active: false
    };
    this._registerAnalysisInvalidationCleanup(requestId, () => {
      const cleanupErrors = [];
      if (controllerRunOwner.active) {
        controllerRunOwner.active = false;
        try {
          controllerRunOwner.controller.abort();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (!progressSettled) {
        try {
          progressTracker.cancel();
        } catch (error) {
          cleanupErrors.push(error);
        }
        progressSettled = true;
      }
      if (this._progressTracker === progressTracker) {
        this._progressTracker = null;
      }
      try {
        restoreButton();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) {
        throw new AggregateError(
          cleanupErrors,
          'Genes Panel request invalidation cleanup failed'
        );
      }
    });

    try {
      const analysisOutput = await this._runAnalysisImpl(
        formValues,
        requestId,
        progressTracker,
        controllerRunOwner
      );

      if (analysisOutput) {
        if (!this._isCurrentAnalysisRequest(requestId)) return;
        const { result, fullMatrix } = analysisOutput;

        await this._showResult(result, requestId);
        if (!this._isCurrentAnalysisRequest(requestId)) return;

        progressTracker.complete('Marker genes discovery complete');
        progressSettled = true;
        this._fullMatrix = fullMatrix;
        this._committedGeneListMode = this._modalGeneListMode;
        await this._publishAnalysisResult(result, requestId);

        // Callback
        if (this.onResultChange) {
          this.onResultChange(result);
        }
      }
    } catch (error) {
      if (!this._isCurrentAnalysisRequest(requestId)) return;
      console.error('[GenesPanelUI] Analysis error:', error);
      progressTracker.fail(`Analysis failed: ${error.message}`);
      progressSettled = true;
    } finally {
      if (
        this._isCurrentAnalysisRequest(requestId) &&
        this._progressTracker === progressTracker
      ) {
        this._progressTracker = null;
      }
      this._finishAnalysisRequest(requestId);
      if (!this._isLoading) restoreButton();
    }
  }

  /**
   * @override
   */
  async _runAnalysisImpl(
    formValues,
    requestId,
    progressTracker,
    controllerRunOwner = null
  ) {
    // Initialize controller if needed
    if (!this._controller) {
      this._controller = new GenesPanelController({
        dataLayer: this.dataLayer
      });
      await this._controller.init();
    }
    if (!this._isCurrentAnalysisRequest(requestId)) return null;

    // Run analysis with progress updates
    const controller = this._controller;
    if (controllerRunOwner !== null) {
      controllerRunOwner.controller = controller;
      controllerRunOwner.active = true;
    }
    let panelResult;
    try {
      panelResult = await controller.runAnalysis({
        ...formValues,
        onProgress: (progress) => {
          if (this._isCurrentAnalysisRequest(requestId)) {
            this._updateProgress(progress, progressTracker);
          }
        }
      });
    } finally {
      if (
        controllerRunOwner !== null &&
        controllerRunOwner.controller === controller
      ) {
        controllerRunOwner.active = false;
      }
    }
    if (!this._isCurrentAnalysisRequest(requestId)) return null;

    let fullMatrix = panelResult.matrix;
    let resultMarkers = panelResult.markers;
    let selectedGenes = null;
    if (panelResult.markers !== null) {
      const selection = this._prepareMarkerSelection({
        markers: panelResult.markers,
        topN: this._getTopNFromMode(this._modalGeneListMode),
        thresholdOptions: formValues
      });
      resultMarkers = {
        ...panelResult.markers,
        groups: selection.groups
      };
      selectedGenes = selection.genes;
      if (
        selectedGenes.length > 0 &&
        !this._matrixCoversGenes(fullMatrix, selectedGenes)
      ) {
        const { groups } = await controller.getGroupsAndCodes(
          formValues.obsCategory,
          {}
        );
        if (!this._isCurrentAnalysisRequest(requestId)) return null;
        fullMatrix = await controller.buildMatrixForGenes({
          genes: selectedGenes,
          groups,
          transform: formValues.transform,
          batchConfig: panelResult.metadata?.batchConfig || {},
          onProgress: null
        });
        if (!this._isCurrentAnalysisRequest(requestId)) return null;
        if (!this._matrixCoversGenes(fullMatrix, selectedGenes)) {
          throw new Error(
            'Initial marker matrix does not cover every selected gene'
          );
        }
      }
    }
    const displayMatrix = selectedGenes === null
      ? fullMatrix
      : (selectedGenes.length === 0
          ? this._createEmptyHeatmapMatrix(fullMatrix)
          : this._sliceHeatmapMatrixForGenes(
              fullMatrix,
              selectedGenes
            ));
    const clusteringMatchesDisplay = (
      panelResult.clustering !== null &&
      panelResult.matrix?.transform === displayMatrix?.transform &&
      this._sameExactTextArray(
        panelResult.matrix?.genes,
        displayMatrix?.genes
      ) &&
      this._sameExactTextArray(
        panelResult.matrix?.groupIds,
        displayMatrix?.groupIds
      )
    );
    const clustering = clusteringMatchesDisplay
      ? panelResult.clustering
      : null;

    // Clustered/custom mode: render heatmap
    return {
      fullMatrix: fullMatrix || null,
      result: {
        type: 'genes_panel',
        plotType: 'gene-heatmap',
        data: { matrix: displayMatrix, clustering },
        options: {
          pValueThreshold: formValues.pValueThreshold,
          foldChangeThreshold: formValues.foldChangeThreshold,
          useAdjustedPValue: formValues.useAdjustedPValue,
          transform: formValues.transform,
          hasClustering: clustering !== null,
          colorscale: formValues.colorscale,
          showValues: false,
          reverseColorscale: true
        },
        title: 'Marker Genes',
        subtitle: formValues.obsCategory,
        markers: resultMarkers,
        clustering,
        metadata: {
          ...panelResult.metadata,
          matrixGeneCount: displayMatrix?.nRows ?? 0
        }
      }
    };
  }

  _handlePlotOptionChange(key, value) {
    const prepared = this._preparePlotOptionChange(key, value);
    if (prepared === null || prepared === undefined) return;
    const { revision, requestedOptions } = prepared;

    return this._trackInteractiveTask(
      this._enqueueGeneHeatmapReconciliation(
        revision,
        requestedOptions,
        this._modalGeneListMode
      ),
      (
        key === 'pValueThreshold' ||
        key === 'foldChangeThreshold' ||
        key === 'useAdjustedPValue'
      )
        ? 'Marker threshold update'
        : (key === 'transform'
            ? 'Gene heatmap transform update'
            : 'Gene heatmap option update')
    );
  }

  _getMarkerThresholdOptions(
    options = this._requestedPlotOptions ??
      this._lastResult?.options ??
      {}
  ) {
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options)
    ) {
      throw new TypeError('Marker threshold options must be an object');
    }
    const opts = options;
    const pValueThreshold = Object.hasOwn(opts, 'pValueThreshold')
      ? opts.pValueThreshold
      : DEFAULTS.pValueThreshold;
    const foldChangeThreshold = Object.hasOwn(opts, 'foldChangeThreshold')
      ? opts.foldChangeThreshold
      : DEFAULTS.foldChangeThreshold;
    const useAdjustedPValue = Object.hasOwn(opts, 'useAdjustedPValue')
      ? opts.useAdjustedPValue
      : DEFAULTS.useAdjustedPValue;
    if (
      !Number.isFinite(pValueThreshold) ||
      pValueThreshold < 0 ||
      pValueThreshold > 1
    ) {
      throw new RangeError(
        'Marker p-value threshold must be finite and between 0 and 1'
      );
    }
    if (
      !Number.isFinite(foldChangeThreshold) ||
      foldChangeThreshold < 0
    ) {
      throw new RangeError(
        'Marker fold-change threshold must be finite and non-negative'
      );
    }
    if (typeof useAdjustedPValue !== 'boolean') {
      throw new TypeError(
        'Marker adjusted-p-value selection must be boolean'
      );
    }
    return {
      pValueThreshold,
      foldChangeThreshold,
      useAdjustedPValue
    };
  }

  /**
   * @override
   */
  _validateForm(formValues) {
    if (!formValues.obsCategory) {
      return { valid: false, error: 'Please select a grouping category' };
    }

    if (formValues.mode === 'custom') {
      if (!formValues.customGenes || formValues.customGenes.length === 0) {
        return { valid: false, error: 'Please enter at least one gene for custom mode' };
      }
    }

    return { valid: true };
  }

  /**
   * @override
   */
  async _showResult(result, requestId) {
    if (!this._isCurrentAnalysisRequest(requestId)) return;

    // Ensure plot type is registered
    await import('../../plots/types/gene-heatmap.js');
    if (!this._isCurrentAnalysisRequest(requestId)) return;

    const containerId = this._plotContainerId ||
      `genes-panel-plot-${this._instanceId || 'default'}`;
    await this._renderPreviewPlot({
      result,
      requestId,
      containerId,
      expandable: true,
      height: 380,
      onRendered: plotCandidate => this._setupHoverContext(
        plotCandidate,
        result,
        { replaceExisting: false }
      )
    });
  }

  // ===========================================================================
  // MODAL RENDERING
  // ===========================================================================

  /**
   * @override
   */
  async _renderModalPlot(
    container,
    {
      isCurrent = () => true,
      modal = this._modal,
      result = this._lastResult
    } = {}
  ) {
    if (!result) return null;

    await import('../../plots/types/gene-heatmap.js');
    if (!PlotRegistry.get(result.plotType)) {
      throw new RangeError(`Unknown plot type: ${result.plotType}`);
    }

    const slot = this._ensureModalPlotSlot(modal);
    if (modal._beforeClose == null) {
      modal._beforeClose = () => this._destroyModalPlotOwner(modal);
    }
    return this._renderGeneResultInSlot({
      slot,
      result,
      isCurrent
    });
  }

  /**
   * Export the current marker result as CSV.
   * @override
   */
  _exportModalCSV() {
    const result = this._lastResult;
    if (!result) return;

    const { csv, filename } = this._buildModalCSVExport(result);
    downloadCSV(csv, filename, this._notifications);
  }

  /**
   * Choose which CSV a marker result exports, and serialize it.
   *
   * The three modes draw the same preview but do not carry the same payload.
   * Clustered and Custom Genes are *about* the heatmap, so they export the wide
   * per-group matrix. Ranked Genes is about the per-group ranking shown in the
   * expanded view, so it exports that table — which also carries the group
   * means and detection rates the matrix has no column for.
   *
   * The mode is read from the result rather than from the form, because the
   * expanded view can outlive the form values that produced it; exporting the
   * form's mode would label one run's numbers with another run's shape. A
   * result that reached here without a mode is a defect upstream, and saying so
   * is better than silently exporting the wrong one of two valid files.
   *
   * @param {Object} result - The result being exported.
   * @returns {{csv: string, filename: string}}
   * @private
   */
  _buildModalCSVExport(result) {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new TypeError('Marker genes CSV export requires a result object');
    }
    const mode = result.metadata?.mode;
    if (mode === 'ranked') {
      return {
        csv: this._serializeRankedMarkersCSV(result.markers?.groups),
        filename: 'marker_genes_ranked'
      };
    }
    if (mode === 'clustered' || mode === 'custom') {
      return {
        csv: this._serializeHeatmapCSV(result.data?.matrix),
        filename: 'marker_genes_heatmap'
      };
    }
    throw new RangeError(
      `Unknown marker genes display mode: ${JSON.stringify(mode)}`
    );
  }

  /**
   * Serialize the ranked per-group marker table shown in the expanded view.
   *
   * The `group` column carries the category the user grouped by, exactly as the
   * heatmap CSV's column headers and the expanded view's picker carry it, and
   * for the same reason: `category-code:0` is a synthetic handle that keys
   * `markers.groups`, the matrix columns and the saved selection, and it means
   * nothing outside this session. Both exports encode it through the one rule in
   * `encodeGroupName`, so a ranked table and a heatmap taken from the same
   * analysis can be joined on the group.
   *
   * @param {Object|undefined} groups - `markers.groups`, keyed by group id.
   * @returns {string}
   * @private
   */
  _serializeRankedMarkersCSV(groups) {
    if (
      groups === null ||
      typeof groups !== 'object' ||
      Array.isArray(groups)
    ) {
      throw new TypeError(
        'Ranked marker CSV requires the discovered per-group markers'
      );
    }

    const rows = ['group,gene,rank,log2FoldChange,pValue,adjustedPValue,meanInGroup,meanOutGroup,percentInGroup,percentOutGroup'];
    for (const [groupId, groupData] of Object.entries(groups)) {
      const groupName = encodeGroupName(groupData?.groupName, groupId);
      for (const m of (groupData?.markers || [])) {
        rows.push([
          toCSVCell(groupName),
          toCSVCell(m.gene ?? ''),
          m.rank ?? '',
          Number.isFinite(m.log2FoldChange) ? m.log2FoldChange : '',
          Number.isFinite(m.pValue) ? m.pValue : '',
          Number.isFinite(m.adjustedPValue) ? m.adjustedPValue : '',
          Number.isFinite(m.meanInGroup) ? m.meanInGroup : '',
          Number.isFinite(m.meanOutGroup) ? m.meanOutGroup : '',
          Number.isFinite(m.percentInGroup) ? m.percentInGroup : '',
          Number.isFinite(m.percentOutGroup) ? m.percentOutGroup : ''
        ].join(','));
      }
    }
    return rows.join('\n');
  }

  /**
   * Serialize the exact displayed heatmap, including the valid zero-row state.
   * @param {Object} matrix
   * @returns {string}
   * @private
   */
  _serializeHeatmapCSV(matrix) {
    if (
      matrix === null ||
      typeof matrix !== 'object' ||
      Array.isArray(matrix)
    ) {
      throw new TypeError('Marker heatmap CSV requires a matrix object');
    }
    const { genes, groupNames, values, nRows, nCols } = matrix;
    if (
      !Number.isSafeInteger(nRows) ||
      nRows < 0 ||
      !Number.isSafeInteger(nCols) ||
      nCols < 1 ||
      !Array.isArray(genes) ||
      genes.length !== nRows ||
      genes.some(gene => typeof gene !== 'string' || gene.length === 0) ||
      !Array.isArray(groupNames) ||
      groupNames.length !== nCols ||
      groupNames.some(
        groupName => typeof groupName !== 'string' || groupName.length === 0
      ) ||
      (
        !Array.isArray(values) &&
        !ArrayBuffer.isView(values)
      ) ||
      values.length !== nRows * nCols
    ) {
      throw new TypeError(
        'Marker heatmap CSV axes and values must match exact matrix dimensions'
      );
    }

    const lines = new Array(nRows + 1);
    lines[0] = ['gene', ...groupNames].map(toCSVCell).join(',');
    for (let r = 0; r < nRows; r++) {
      const row = new Array(nCols + 1);
      row[0] = toCSVCell(genes[r]);
      for (let c = 0; c < nCols; c++) {
        row[c + 1] = toCSVCell(values[r * nCols + c]);
      }
      lines[r + 1] = row.join(',');
    }
    return lines.join('\n');
  }

  /**
   * @override
   */
  _renderModalStats(container) {
    if (!this._lastResult?.metadata) return;

    const { metadata } = this._lastResult;
    container.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'analysis-stats-table';

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

	    const addRow = (label, value) => {
	      const tr = document.createElement('tr');
	      const tdLabel = document.createElement('td');
	      tdLabel.textContent = label;
	      const tdValue = document.createElement('td');
	      const strong = document.createElement('strong');
	      strong.textContent = String(value);
	      tdValue.replaceChildren(strong);
	      tr.appendChild(tdLabel);
	      tr.appendChild(tdValue);
	      tbody.appendChild(tr);
	    };

    addRow('Category', String(metadata.obsCategory || 'N/A'));
    addRow('Mode', String(metadata.mode || 'N/A'));
    addRow('Method', String(metadata.method || 'N/A'));
    addRow('Groups', Number.isFinite(metadata.groupCount) ? String(metadata.groupCount) : String(metadata.groupCount || 'N/A'));
    addRow('Genes', Number.isFinite(metadata.geneCount) ? String(metadata.geneCount) : String(metadata.geneCount || 'N/A'));

    const durationSec = Number.isFinite(metadata.duration) ? (metadata.duration / 1000).toFixed(1) : null;
    addRow('Duration', durationSec ? `${durationSec}s` : 'N/A');

    container.appendChild(table);
  }

  /**
   * Render marker genes table in modal (bottom-right panel).
   *
   * Matches the Differential Expression modal pattern:
   * - A header with a "Top N" dropdown
   * - A group selector
   * - A table of genes and stats
   *
   * @override
   */
  _renderModalAnnotations(container) {
    const result = this._lastResult;
    const groups = result?.markers?.groups || null;

    if (!groups) {
      // Custom mode: no marker discovery; show the gene list used in the heatmap.
      const genes = result?.data?.matrix?.genes || result?.matrix?.genes || [];
      if (!genes || genes.length === 0) {
        container.innerHTML = '<p class="modal-annotations-placeholder">No marker genes available.</p>';
        return;
      }

      container.innerHTML = '';
      const headerRow = document.createElement('div');
      headerRow.className = 'de-modal-genes-header';

      const title = document.createElement('h5');
      title.textContent = 'Genes in Heatmap';
      headerRow.appendChild(title);
      container.appendChild(headerRow);

      const pre = document.createElement('div');
      pre.className = 'analysis-empty-message';
      pre.style.whiteSpace = 'pre-wrap';
      pre.textContent = genes.join('\n');
      container.appendChild(pre);
      return;
    }

    const groupIds = Object.keys(groups);
    if (groupIds.length === 0) {
      container.innerHTML = '<p class="modal-annotations-placeholder">No marker genes available.</p>';
      return;
    }

    if (
      !this._modalSelectedGroupId ||
      !Object.hasOwn(groups, this._modalSelectedGroupId)
    ) {
      this._modalSelectedGroupId = groupIds[0];
    }

    const renderRevision = ++this._modalAnnotationsRenderRevision;

    container.innerHTML = '';

    const headerRow = document.createElement('div');
    headerRow.className = 'de-modal-genes-header';

    const title = document.createElement('h5');
    title.textContent = 'Top Marker Genes';
    headerRow.appendChild(title);

    const topSelect = document.createElement('select');
    topSelect.className = 'obs-select';
    topSelect.innerHTML = `
      <option value="top5">Top 5</option>
      <option value="top10">Top 10</option>
      <option value="top20">Top 20</option>
      <option value="top100">Top 100</option>
      <option value="all">All</option>
    `;
    topSelect.value = this._modalGeneListMode;
    topSelect.addEventListener('change', () => {
      const v = topSelect.value;
      this._modalGeneListMode = (v === 'all' || v === 'top5' || v === 'top10' || v === 'top20' || v === 'top100')
        ? v
        : 'top5';
      this._renderModalAnnotations(container);
      this._trackInteractiveTask(
        this._rerenderHeatmapForModalSelection(),
        'Gene heatmap list update'
      );
    });
    headerRow.appendChild(topSelect);

    const groupSelect = document.createElement('select');
    groupSelect.className = 'obs-select';
    for (const id of groupIds) {
      // The group id is a synthetic handle, `category-code:<code>`, and it is
      // what `markers.groups`, the heatmap columns, the hover lookup and the
      // saved `modalSelectedGroupId` all address - so it stays the option's
      // value. What the user picked is the category, and every group carries
      // it: MarkerDiscoveryEngine refuses a group without an exact primitive
      // `groupName` before it computes a single statistic. `encodeGroupName` is
      // the same rule the heatmap axis and the ranked CSV render through.
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = encodeGroupName(groups[id]?.groupName, id);
      if (id === this._modalSelectedGroupId) opt.selected = true;
      groupSelect.appendChild(opt);
    }
    groupSelect.addEventListener('change', () => {
      this._modalSelectedGroupId = groupSelect.value;
      this._renderModalAnnotations(container);
    });
    headerRow.appendChild(groupSelect);

    container.appendChild(headerRow);

    const selectedGroup = groups[this._modalSelectedGroupId];
    container.appendChild(
      this._createGroupTestingSummary(
        selectedGroup,
        result?.markers?.minCellsPerSide
      )
    );

    const markers = selectedGroup?.markers || [];
    if (markers.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'modal-annotations-placeholder';
      empty.textContent = selectedGroup?.genesTested === 0
        ? 'No gene could be tested for this group, so it has no markers.'
        : 'No markers for selected group at the current thresholds.';
      container.appendChild(empty);
      return;
    }

    const maxRows = this._modalGeneListMode === 'all'
      ? Infinity
      : (this._modalGeneListMode === 'top100' ? 100
        : this._modalGeneListMode === 'top20' ? 20
          : this._modalGeneListMode === 'top10' ? 10
            : 5);

    const genesToShow = Number.isFinite(maxRows) ? markers.slice(0, maxRows) : markers;

    const table = document.createElement('table');
    table.className = 'de-genes-table modal-de-genes';

    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Gene</th><th>log2FC</th><th>p</th><th>FDR</th></tr>';
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    container.appendChild(table);

    const createRowEl = (m) => {
      const tr = document.createElement('tr');
      tr.className = m?.log2FoldChange > 0 ? 'up' : 'down';

      const tdGene = document.createElement('td');
      tdGene.className = 'gene-name';
      tdGene.textContent = String(m?.gene ?? '');
      tr.appendChild(tdGene);

      const tdFc = document.createElement('td');
      tdFc.textContent = Number.isFinite(m?.log2FoldChange) ? m.log2FoldChange.toFixed(3) : 'N/A';
      tr.appendChild(tdFc);

      const tdP = document.createElement('td');
      tdP.textContent = Number.isFinite(m?.pValue) ? m.pValue.toExponential(2) : 'N/A';
      tr.appendChild(tdP);

      const tdFdr = document.createElement('td');
      tdFdr.textContent = Number.isFinite(m?.adjustedPValue) ? m.adjustedPValue.toExponential(2) : 'N/A';
      tr.appendChild(tdFdr);

      return tr;
    };

    const shouldChunkRender = this._modalGeneListMode === 'all' && genesToShow.length > 500;
    if (!shouldChunkRender) {
      for (const m of genesToShow) {
        tbody.appendChild(createRowEl(m));
      }
      return;
    }

    const CHUNK = 250;
    let cursor = 0;

    const renderChunk = () => {
      if (renderRevision !== this._modalAnnotationsRenderRevision) return;

      const end = Math.min(genesToShow.length, cursor + CHUNK);
      const frag = document.createDocumentFragment();
      for (let i = cursor; i < end; i++) {
        frag.appendChild(createRowEl(genesToShow[i]));
      }
      tbody.appendChild(frag);
      cursor = end;

      if (cursor < genesToShow.length) {
        setTimeout(renderChunk, 0);
      }
    };

    renderChunk();
  }

  /**
   * Caption the marker table with the family the group's FDR was computed over.
   *
   * A group is compared against the rest one gene at a time, and a gene where
   * either side held fewer than `minCellsPerSide` cells with a measured value
   * was never tested. Such a gene has no p-value, is not in the Benjamini-
   * Hochberg denominator, and can never appear in the list below - so the list
   * alone cannot distinguish "nothing was significant" from "most of the panel
   * was unmeasurable here". Both numbers are stated so it can.
   *
   * @param {Object|undefined} group - The selected group's marker result
   * @param {number|undefined} minCellsPerSide - Cells required on each side
   * @returns {HTMLElement}
   */
  _createGroupTestingSummary(group, minCellsPerSide) {
    const summary = document.createElement('p');
    summary.className = 'modal-annotations-placeholder';

    const genesTested = group?.genesTested;
    const genesUntestable = group?.genesUntestable;
    if (
      !Number.isSafeInteger(genesTested) ||
      !Number.isSafeInteger(genesUntestable)
    ) {
      // Partial results have not corrected anything yet, and custom gene sets
      // never ran a comparison. Neither has a denominator to report.
      summary.hidden = true;
      return summary;
    }

    const tested = document.createElement('strong');
    tested.textContent = genesTested.toLocaleString();
    summary.append(tested, ' genes tested (FDR denominator)');

    if (genesUntestable > 0) {
      const untested = document.createElement('strong');
      untested.textContent = genesUntestable.toLocaleString();
      summary.append(' · ', untested, ' not tested');
      if (Number.isSafeInteger(minCellsPerSide)) {
        summary.append(
          ` (fewer than ${minCellsPerSide.toLocaleString()} cells with a measured value in this group or in the rest)`
        );
      }
    }

    return summary;
  }

  _getTopNFromMode(mode) {
    if (mode === 'all') return Infinity;
    if (mode === 'top100') return 100;
    if (mode === 'top20') return 20;
    if (mode === 'top10') return 10;
    return 5;
  }

  _computeTopMarkersForGroupIndex({
    groupId,
    geneKeys,
    pValuesEffective,
    pValuesRaw,
    adjPValues,
    log2FC,
    topN,
    pValueThreshold,
    foldChangeThreshold
  }) {
    const out = [];
    const n = geneKeys.length;
    if (!pValuesEffective || !log2FC) return out;

    for (let i = 0; i < n; i++) {
      const p = pValuesEffective[i];
      const fc = log2FC[i];
      // Inclusive, matching the engine and the Benjamini-Hochberg step-up.
      if (!Number.isFinite(p) || p > pValueThreshold) continue;
      if (!Number.isFinite(fc) || Math.abs(fc) < foldChangeThreshold) continue;

      out.push({
        gene: geneKeys[i],
        geneIndex: i,
        groupId,
        effectivePValue: p,
        pValue: Number.isFinite(pValuesRaw?.[i]) ? pValuesRaw[i] : p,
        adjustedPValue: Number.isFinite(adjPValues?.[i]) ? adjPValues[i] : null,
        log2FoldChange: fc
      });
    }

    out.sort((a, b) => {
      if (a.effectivePValue !== b.effectivePValue) {
        return a.effectivePValue - b.effectivePValue;
      }
      const effectOrder =
        Math.abs(b.log2FoldChange) - Math.abs(a.log2FoldChange);
      if (effectOrder !== 0) return effectOrder;
      if (a.geneIndex !== b.geneIndex) return a.geneIndex - b.geneIndex;
      return a.gene.localeCompare(b.gene);
    });

    return out
      .slice(0, Math.min(out.length, topN))
      .map(({ effectivePValue: _effectivePValue, ...marker }) => marker);
  }

  _rebuildMarkerGroupsFromStats({
    markers,
    topN,
    thresholdOptions
  }) {
    const stats = markers?.stats;
    if (!stats?.genes || !stats.groupIds || !stats.pValuesByGroup || !stats.log2FoldChangeByGroup) return null;

    const {
      pValueThreshold,
      foldChangeThreshold,
      useAdjustedPValue
    } = this._getMarkerThresholdOptions(thresholdOptions);

    /** @type {Record<string, any>} */
    const nextGroups = {};
    for (let g = 0; g < stats.groupIds.length; g++) {
      const groupId = stats.groupIds[g];
      const pEff = useAdjustedPValue ? stats.adjustedPValuesByGroup?.[g] : stats.pValuesByGroup[g];
      const picked = this._computeTopMarkersForGroupIndex({
        groupId,
        geneKeys: stats.genes,
        pValuesEffective: pEff,
        pValuesRaw: stats.pValuesByGroup[g],
        adjPValues: stats.adjustedPValuesByGroup?.[g],
        log2FC: stats.log2FoldChangeByGroup[g],
        topN: Number.isFinite(topN) ? topN : stats.genes.length,
        pValueThreshold,
        foldChangeThreshold
      });
      const existingGroup = (
        markers.groups !== null &&
        markers.groups !== undefined &&
        Object.hasOwn(markers.groups, groupId)
      )
        ? markers.groups[groupId]
        : undefined;

      setOwnDataProperty(nextGroups, groupId, {
        ...(existingGroup || {}),
        groupId,
        markers: picked.map((m, i) => ({ ...m, rank: i + 1 }))
      });
    }

    return nextGroups;
  }

  _computeHeatmapGeneSet({ markers, topN, thresholdOptions }) {
    const nextGroups = this._rebuildMarkerGroupsFromStats({
      markers,
      topN,
      thresholdOptions
    });
    const groups = nextGroups || markers?.groups || {};
    return this._collectHeatmapGenesFromGroups(groups, topN);
  }

  _collectHeatmapGenesFromGroups(groups, topN = Infinity) {
    if (
      groups === null ||
      typeof groups !== 'object' ||
      Array.isArray(groups)
    ) {
      throw new TypeError('Marker heatmap groups must be an object');
    }
    if (
      topN !== Infinity &&
      (!Number.isSafeInteger(topN) || topN < 1)
    ) {
      throw new RangeError(
        'Marker heatmap Top-N must be Infinity or a positive integer'
      );
    }
    const wanted = new Set();
    for (const group of Object.values(groups)) {
      if (
        group === null ||
        typeof group !== 'object' ||
        !Array.isArray(group.markers)
      ) {
        throw new TypeError(
          'Every marker heatmap group must own a markers array'
        );
      }
      const list = group.markers;
      const limit = Math.min(list.length, topN);
      for (let i = 0; i < limit; i++) {
        const gene = list[i]?.gene;
        if (
          typeof gene !== 'string' ||
          gene.length === 0 ||
          gene !== gene.trim()
        ) {
          throw new TypeError(
            'Every selected marker must own an exact non-empty gene'
          );
        }
        wanted.add(gene);
      }
    }
    return wanted;
  }

  _prepareMarkerSelection({
    markers,
    topN,
    thresholdOptions
  }) {
    const groups = this._rebuildMarkerGroupsFromStats({
      markers,
      topN,
      thresholdOptions
    });
    if (groups === null) {
      throw new Error(
        'Interactive marker selection requires full marker statistics'
      );
    }
    return {
      groups,
      genes: Array.from(
        this._collectHeatmapGenesFromGroups(groups, topN)
      )
    };
  }

  _matrixCoversGenes(matrix, genes) {
    if (
      matrix === null ||
      typeof matrix !== 'object' ||
      !Array.isArray(matrix.genes)
    ) {
      return false;
    }
    const available = new Set(matrix.genes);
    if (available.size !== matrix.genes.length) {
      throw new Error('Marker heatmap source matrix contains duplicate genes');
    }
    return genes.every(gene => available.has(gene));
  }

  _createEmptyHeatmapMatrix(matrix) {
    if (
      matrix === null ||
      typeof matrix !== 'object' ||
      !Number.isSafeInteger(matrix.nCols) ||
      matrix.nCols < 1 ||
      !Array.isArray(matrix.groupIds) ||
      matrix.groupIds.length !== matrix.nCols ||
      !Array.isArray(matrix.groupNames) ||
      matrix.groupNames.length !== matrix.nCols
    ) {
      throw new TypeError(
        'Empty marker heatmap requires exact non-empty group axes'
      );
    }
    return {
      ...matrix,
      genes: [],
      values: new Float32Array(0),
      rawValues: matrix.rawValues === null
        ? null
        : new Float32Array(0),
      nRows: 0
    };
  }

  _sliceHeatmapMatrixForGenes(matrix, requestedGenes) {
    if (
      matrix === null ||
      typeof matrix !== 'object' ||
      !Array.isArray(matrix.genes) ||
      !Number.isSafeInteger(matrix.nRows) ||
      matrix.nRows < 1 ||
      matrix.genes.length !== matrix.nRows ||
      !Number.isSafeInteger(matrix.nCols) ||
      matrix.nCols < 1 ||
      (
        !Array.isArray(matrix.values) &&
        !ArrayBuffer.isView(matrix.values)
      ) ||
      matrix.values.length !== matrix.nRows * matrix.nCols
    ) {
      throw new TypeError(
        'Marker heatmap source matrix must own exact positive dimensions'
      );
    }
    if (
      !Array.isArray(requestedGenes) ||
      requestedGenes.some(
        gene =>
          typeof gene !== 'string' ||
          gene.length === 0 ||
          gene !== gene.trim()
      ) ||
      new Set(requestedGenes).size !== requestedGenes.length
    ) {
      throw new TypeError(
        'Marker heatmap selection must contain unique non-empty genes'
      );
    }
    if (requestedGenes.length === 0) {
      return this._createEmptyHeatmapMatrix(matrix);
    }

    const wanted = new Set(requestedGenes);
    const keepRows = [];
    const covered = new Set();
    for (let i = 0; i < matrix.genes.length; i++) {
      const gene = matrix.genes[i];
      if (wanted.has(gene)) {
        keepRows.push(i);
        covered.add(gene);
      }
    }
    if (covered.size !== wanted.size) {
      const missing = requestedGenes.filter(gene => !covered.has(gene));
      throw new Error(
        `Marker heatmap source matrix is missing selected genes: ${missing.join(', ')}`
      );
    }
    if (keepRows.length === matrix.genes.length) return matrix;

    const nCols = matrix.nCols;
    const nRows = keepRows.length;
    const outValues = new Float32Array(nRows * nCols);
    const outRaw = matrix.rawValues === null
      ? null
      : new Float32Array(nRows * nCols);
    for (let r = 0; r < nRows; r++) {
      const srcOffset = keepRows[r] * nCols;
      const dstOffset = r * nCols;
      outValues.set(
        matrix.values.subarray
          ? matrix.values.subarray(srcOffset, srcOffset + nCols)
          : matrix.values.slice(srcOffset, srcOffset + nCols),
        dstOffset
      );
      if (outRaw !== null) {
        if (
          (
            !Array.isArray(matrix.rawValues) &&
            !ArrayBuffer.isView(matrix.rawValues)
          ) ||
          matrix.rawValues.length !== matrix.nRows * nCols
        ) {
          throw new TypeError(
            'Marker heatmap raw values must match exact matrix dimensions'
          );
        }
        outRaw.set(
          matrix.rawValues.subarray
            ? matrix.rawValues.subarray(srcOffset, srcOffset + nCols)
            : matrix.rawValues.slice(srcOffset, srcOffset + nCols),
          dstOffset
        );
      }
    }
    return {
      ...matrix,
      genes: keepRows.map(index => matrix.genes[index]),
      values: outValues,
      rawValues: outRaw,
      nRows
    };
  }

  _buildHeatmapMatrixForMode({
    matrix,
    markers,
    mode,
    thresholdOptions
  }) {
    if (!matrix || !markers) return matrix;

    const topN = this._getTopNFromMode(mode);
    const selection = this._prepareMarkerSelection({
      markers,
      topN,
      thresholdOptions
    });
    return this._sliceHeatmapMatrixForGenes(matrix, selection.genes);
  }

  async _rerenderHeatmapForModalSelection() {
    if (!this._lastResult?.plotType || this._lastResult.plotType !== 'gene-heatmap') return;
    if (!this._fullMatrix || !this._lastResult.markers) return;
    const revision = ++this._optionRenderRevision;
    const requestedOptions = structuredClone(
      this._requestedPlotOptions ??
      this._lastResult.options ??
      {}
    );
    return this._enqueueGeneHeatmapReconciliation(
      revision,
      requestedOptions,
      this._modalGeneListMode
    );
  }

  _enqueueGeneHeatmapReconciliation(
    revision,
    requestedOptions,
    mode
  ) {
    const ownedOptions = structuredClone(requestedOptions);
    const predecessor = Promise.resolve(this._geneOptionTail).catch(() => {});
    const operation = predecessor.then(() => (
      this._reconcileGeneHeatmapIntent(
        revision,
        ownedOptions,
        mode
      )
    ));
    this._geneOptionTail = operation;
    void operation.catch(() => {});
    return operation;
  }

  _isGeneHeatmapIntentCurrent(
    revision,
    ownedResult,
    ownedController
  ) {
    return (
      !this._isDestroyed &&
      revision === this._optionRenderRevision &&
      this._lastResult === ownedResult &&
      this._controller === ownedController
    );
  }

  _getRequestedHeatmapTransform(requestedOptions, defaultTransform) {
    const transform = Object.hasOwn(requestedOptions, 'transform')
      ? requestedOptions.transform
      : defaultTransform;
    if (!['none', 'zscore', 'log1p'].includes(transform)) {
      throw new RangeError(
        `Unknown marker heatmap transform: ${String(transform)}`
      );
    }
    return transform;
  }

  _sameExactTextArray(left, right) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }

  async _stageGeneHeatmapIntent({
    revision,
    requestedOptions,
    mode,
    ownedResult,
    ownedController
  }) {
    if (
      requestedOptions === null ||
      typeof requestedOptions !== 'object' ||
      Array.isArray(requestedOptions)
    ) {
      throw new TypeError(
        'Gene heatmap reconciliation requires an options object'
      );
    }
    const requestedThresholds =
      this._getMarkerThresholdOptions(requestedOptions);
    const targetTransform = this._getRequestedHeatmapTransform(
      requestedOptions,
      ownedResult.metadata?.transform ??
        ownedResult.data?.matrix?.transform ??
        DEFAULTS.transform
    );
    const sourceMatrix = this._fullMatrix ?? ownedResult.data?.matrix;
    if (
      sourceMatrix === null ||
      typeof sourceMatrix !== 'object' ||
      !Array.isArray(sourceMatrix.genes)
    ) {
      throw new TypeError(
        'Gene heatmap reconciliation requires a canonical matrix'
      );
    }

    let stagedMarkers = ownedResult.markers;
    let wantedGenes;
    if (ownedResult.markers === null) {
      wantedGenes = [...sourceMatrix.genes];
    } else {
      const topN = this._getTopNFromMode(mode);
      const committedThresholds = this._getMarkerThresholdOptions(
        ownedResult.options || {}
      );
      const selectionIsCommitted = (
        this._committedGeneListMode === mode &&
        committedThresholds.pValueThreshold ===
          requestedThresholds.pValueThreshold &&
        committedThresholds.foldChangeThreshold ===
          requestedThresholds.foldChangeThreshold &&
        committedThresholds.useAdjustedPValue ===
          requestedThresholds.useAdjustedPValue
      );
      const selection = selectionIsCommitted
        ? {
            groups: ownedResult.markers.groups,
            genes: Array.from(
              this._collectHeatmapGenesFromGroups(
                ownedResult.markers.groups,
                topN
              )
            )
          }
        : this._prepareMarkerSelection({
            markers: ownedResult.markers,
            topN,
            thresholdOptions: requestedOptions
          });
      stagedMarkers = {
        ...ownedResult.markers,
        groups: selection.groups
      };
      wantedGenes = selection.genes;
    }

    let canonicalMatrix = sourceMatrix;
    if (wantedGenes.length > 0 &&
        !this._matrixCoversGenes(sourceMatrix, wantedGenes)) {
      const obsCategory = ownedResult.metadata?.obsCategory;
      if (
        typeof obsCategory !== 'string' ||
        obsCategory.length === 0 ||
        ownedController === null ||
        typeof ownedController?.getGroupsAndCodes !== 'function' ||
        typeof ownedController?.buildMatrixForGenes !== 'function'
      ) {
        throw new Error(
          'Missing marker genes require an exact matrix rebuild owner'
        );
      }
      const { groups } = await ownedController.getGroupsAndCodes(
        obsCategory,
        {}
      );
      if (!this._isGeneHeatmapIntentCurrent(
        revision,
        ownedResult,
        ownedController
      )) {
        return null;
      }
      canonicalMatrix = await ownedController.buildMatrixForGenes({
        genes: wantedGenes,
        groups,
        transform: targetTransform,
        batchConfig: ownedResult.metadata?.batchConfig || {},
        onProgress: null
      });
      if (!this._isGeneHeatmapIntentCurrent(
        revision,
        ownedResult,
        ownedController
      )) {
        return null;
      }
      if (!this._matrixCoversGenes(canonicalMatrix, wantedGenes)) {
        throw new Error(
          'Rebuilt marker matrix does not cover every selected gene'
        );
      }
    } else if (canonicalMatrix.transform !== targetTransform) {
      if (
        ownedController === null ||
        typeof ownedController?.retransform !== 'function'
      ) {
        throw new Error(
          'Marker heatmap transform requires an exact controller owner'
        );
      }
      const transformed = ownedController.retransform(
        { matrix: canonicalMatrix },
        targetTransform
      );
      if (
        transformed === null ||
        typeof transformed !== 'object' ||
        transformed.matrix === null ||
        typeof transformed.matrix !== 'object'
      ) {
        throw new TypeError(
          'Marker heatmap transform must return an exact matrix'
        );
      }
      canonicalMatrix = transformed.matrix;
    }

    const displayMatrix = wantedGenes.length === 0
      ? this._createEmptyHeatmapMatrix(canonicalMatrix)
      : this._sliceHeatmapMatrixForGenes(
          canonicalMatrix,
          wantedGenes
        );
    const priorMatrix = ownedResult.data?.matrix;
    const matrixIdentityUnchanged = (
      priorMatrix !== null &&
      typeof priorMatrix === 'object' &&
      priorMatrix.transform === displayMatrix.transform &&
      this._sameExactTextArray(priorMatrix.genes, displayMatrix.genes) &&
      this._sameExactTextArray(
        priorMatrix.groupIds,
        displayMatrix.groupIds
      )
    );
    const priorClustering =
      ownedResult.data?.clustering ??
      ownedResult.clustering ??
      null;
    const clustering = matrixIdentityUnchanged
      ? priorClustering
      : null;
    const options = {
      ...requestedOptions,
      transform: targetTransform,
      hasClustering: clustering !== null
    };
    const metadata = {
      ...(ownedResult.metadata || {}),
      transform: targetTransform,
      matrixGeneCount: displayMatrix.nRows
    };
    const stagedResult = {
      ...ownedResult,
      data: { matrix: displayMatrix, clustering },
      options,
      markers: stagedMarkers,
      clustering,
      metadata
    };
    return {
      canonicalMatrix,
      stagedResult
    };
  }

  _renderGeneResultInSlot({
    slot,
    result,
    isCurrent
  }) {
    if (slot === null || typeof slot?.render !== 'function') {
      throw new TypeError(
        'Gene heatmap render requires an exact plot slot'
      );
    }
    if (typeof isCurrent !== 'function') {
      throw new TypeError(
        'Gene heatmap render requires an ownership predicate'
      );
    }
    const matrix = result.data?.matrix;
    const isEmpty = matrix?.nRows === 0;
    const plotDef = isEmpty ? null : PlotRegistry.get(result.plotType);
    if (!isEmpty && !plotDef) {
      throw new RangeError(`Unknown plot type: ${result.plotType}`);
    }
    const mergedOptions = isEmpty
      ? null
      : PlotRegistry.mergeOptions(
          result.plotType,
          result.options || {}
        );
    const payload = {
      render: plotCandidate => {
        if (isEmpty) {
          const ownerDocument = plotCandidate.ownerDocument;
          if (
            ownerDocument === null ||
            typeof ownerDocument?.createElement !== 'function' ||
            typeof plotCandidate.replaceChildren !== 'function'
          ) {
            throw new TypeError(
              'Empty marker heatmap candidate requires an owner document'
            );
          }
          const empty = ownerDocument.createElement('div');
          empty.className = 'analysis-empty-message';
          empty.setAttribute('role', 'status');
          empty.textContent =
            'No marker genes match the current thresholds.';
          plotCandidate.replaceChildren(empty);
          return null;
        }
        return plotDef.render(
          result.data,
          mergedOptions,
          plotCandidate,
          null
        );
      }
    };
    if (!isEmpty) {
      payload.onRendered = plotCandidate => this._setupHoverContext(
        plotCandidate,
        result,
        { replaceExisting: false }
      );
    }
    return slot.render(payload, { isCurrent });
  }

  async _renderStagedGeneResult({
    result,
    revision,
    ownedResult,
    ownedController
  }) {
    const isCurrent = () => this._isGeneHeatmapIntentCurrent(
      revision,
      ownedResult,
      ownedController
    );
    if (!isCurrent()) return false;

    const modal = this._modal;
    if (modal !== null) {
      const modalSlot = this._ensureModalPlotSlot(modal);
      const modalCandidate = await this._renderGeneResultInSlot({
        slot: modalSlot,
        result,
        isCurrent
      });
      if (modalCandidate === null || !isCurrent()) return false;
    }

    if (this._previewPlotSlot !== null) {
      const previewCandidate = await this._renderGeneResultInSlot({
        slot: this._previewPlotSlot,
        result,
        isCurrent
      });
      if (previewCandidate === null || !isCurrent()) return false;
    }
    return isCurrent();
  }

  _commitStagedGeneResult({
    ownedResult,
    stagedResult,
    canonicalMatrix,
    mode
  }) {
    ownedResult.data = stagedResult.data;
    ownedResult.options = stagedResult.options;
    ownedResult.markers = stagedResult.markers;
    ownedResult.clustering = stagedResult.clustering;
    ownedResult.metadata = stagedResult.metadata;
    this._fullMatrix = canonicalMatrix;
    this._committedGeneListMode = mode;
    this._currentPageData = stagedResult.data;
    this._requestedPlotOptions = structuredClone(
      stagedResult.options
    );

    const modal = this._modal;
    if (modal !== null) {
      this._renderModalOptions(modal._optionsContent);
      this._renderModalStats(modal._statsContent);
      this._renderModalAnnotations(modal._annotationsContent);
    }
  }

  async _reconcileGeneHeatmapIntent(
    revision,
    requestedOptions,
    mode
  ) {
    if (
      this._isDestroyed ||
      revision !== this._optionRenderRevision
    ) {
      return;
    }
    const ownedResult = this._lastResult;
    const ownedController = this._controller;
    if (
      ownedResult === null ||
      ownedResult?.plotType !== 'gene-heatmap'
    ) {
      return;
    }
    const staged = await this._stageGeneHeatmapIntent({
      revision,
      requestedOptions,
      mode,
      ownedResult,
      ownedController
    });
    if (staged === null || !this._isGeneHeatmapIntentCurrent(
      revision,
      ownedResult,
      ownedController
    )) {
      return;
    }
    const rendered = await this._renderStagedGeneResult({
      result: staged.stagedResult,
      revision,
      ownedResult,
      ownedController
    });
    if (!rendered || !this._isGeneHeatmapIntentCurrent(
      revision,
      ownedResult,
      ownedController
    )) {
      return;
    }
    this._commitStagedGeneResult({
      ownedResult,
      stagedResult: staged.stagedResult,
      canonicalMatrix: staged.canonicalMatrix,
      mode
    });
  }

  _refreshMarkersAndHeatmapFromThresholds(
    revision,
    requestedOptions = this._requestedPlotOptions
  ) {
    return this._reconcileGeneHeatmapIntent(
      revision,
      structuredClone(requestedOptions),
      this._modalGeneListMode
    );
  }

  _refreshHeatmapTransform(
    revision,
    transform,
    requestedOptions = this._requestedPlotOptions
  ) {
    return this._reconcileGeneHeatmapIntent(
      revision,
      {
        ...structuredClone(requestedOptions),
        transform
      },
      this._modalGeneListMode
    );
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * @override
   */
  _discardFormResult() {
    this._fullMatrix = null;
    this._committedGeneListMode = null;
    return super._discardFormResult();
  }

  /**
   * Get available categorical observation fields
   * @private
   * @returns {Array<{value: string, label: string}>} Options for category select
   */
  _getAvailableCategories() {
    try {
      // Use 'categorical_obs' type - data-layer returns VariableInfo[] with key and name
      const catVars = this.dataLayer.getAvailableVariables('categorical_obs');
      return catVars.map(v => v.key);
    } catch (e) {
      console.warn('[GenesPanelUI] Failed to get categorical fields:', e);
      return [];
    }
  }

  /**
   * Create a collapsible section matching Performance Settings design
   *
   * @private
   * @param {Object} options
   * @param {string} options.title - Section title
   * @param {string} options.className - CSS class for the section
   * @param {boolean} [options.expanded=true] - Whether section starts expanded
   * @returns {{ container: HTMLElement, content: HTMLElement }}
   */
  _createCollapsibleSection({ title, className, expanded = true }) {
    const { container, content } = createCollapsibleSection({
      title: String(title ?? ''),
      expanded,
      containerClassName: `form-section ${className}`
    });
    return { container, content };
  }

  /**
   * Handle mode selection change
   * Updates form section visibility based on selected mode:
   * - 'ranked': Hide clustering, show discovery params
   * - 'clustered': Show clustering, show discovery params
   * - 'custom': Hide discovery params, show clustering, show custom genes input
   *
   * @private
   * @param {string|Event} modeOrEvent - Mode value or change event
   */
  _handleModeChange(modeOrEvent) {
    // Support both direct value (from onChange callback) and event object
    const mode = typeof modeOrEvent === 'string' ? modeOrEvent : modeOrEvent?.target?.value;
    if (!mode) return;

    // The form subtree is the authority: it exists before the caller attaches
    // it to the panel, so section visibility can be settled during the render
    // rather than deferred to a timer.
    const root = this._formRoot ?? this._formContainer;
    const customGenesGroup = root?.querySelector('.custom-genes-group');
    const discoverySection = root?.querySelector('.discovery-params');
    const clusterSection = root?.querySelector('.cluster-params');

    // Custom genes input: only visible in 'custom' mode
    if (customGenesGroup) {
      customGenesGroup.classList.toggle('hidden', mode !== 'custom');
    }

    // Discovery parameters: visible in 'ranked' and 'clustered' modes
    if (discoverySection) {
      discoverySection.classList.toggle('hidden', mode === 'custom');
    }

    // Clustering section: only visible when mode is 'clustered' or 'custom'
    // Hidden entirely for 'ranked' mode as per user requirement
    if (clusterSection) {
      clusterSection.classList.toggle('hidden', mode === 'ranked');
    }
  }

  /**
   * Setup hover context for detailed gene info
   * @private
   */
  _setupHoverContext(
    plotContainer,
    result,
    { replaceExisting = true } = {}
  ) {
    if (
      plotContainer === null ||
      typeof plotContainer !== 'object' ||
      plotContainer.nodeType !== 1 ||
      typeof plotContainer.on !== 'function' ||
      typeof plotContainer.removeListener !== 'function'
    ) {
      throw new TypeError(
        'Marker heatmap container must expose Plotly on and removeListener methods'
      );
    }
    if (
      result === null ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      result.data === null ||
      typeof result.data !== 'object' ||
      Array.isArray(result.data) ||
      result.data.matrix === null ||
      typeof result.data.matrix !== 'object' ||
      Array.isArray(result.data.matrix)
    ) {
      throw new TypeError(
        'Marker heatmap hover requires an exact result matrix'
      );
    }

    const matrix = result.data.matrix;
    const { genes, groupIds, groupNames, nRows, nCols } = matrix;
    if (
      !Number.isSafeInteger(nRows) ||
      nRows < 1 ||
      !Number.isSafeInteger(nCols) ||
      nCols < 1 ||
      !Array.isArray(genes) ||
      genes.length !== nRows ||
      genes.some(gene => typeof gene !== 'string' || gene.length === 0) ||
      new Set(genes).size !== genes.length ||
      !Array.isArray(groupIds) ||
      groupIds.length !== nCols ||
      groupIds.some(
        groupId => typeof groupId !== 'string' || groupId.length === 0
      ) ||
      new Set(groupIds).size !== groupIds.length ||
      !Array.isArray(groupNames) ||
      groupNames.length !== nCols ||
      groupNames.some(
        groupName => typeof groupName !== 'string' || groupName.length === 0
      )
    ) {
      throw new TypeError(
        'Marker heatmap hover matrix axes must match its exact dimensions'
      );
    }

    const markerLookup = this._buildHoverMarkerLookup(
      result.markers,
      groupIds
    );
    const ownerDocument = plotContainer.ownerDocument;
    if (
      ownerDocument === null ||
      typeof ownerDocument !== 'object' ||
      ownerDocument.body === null ||
      typeof ownerDocument.body !== 'object'
    ) {
      throw new TypeError(
        'Marker heatmap container must belong to a mounted document'
      );
    }

    this._hoverOwners ??= new Map();
    if (replaceExisting) {
      this._teardownHoverContext();
    } else if (this._hoverOwners.has(plotContainer)) {
      this._teardownHoverContext(plotContainer);
    }
    const hoverContext = new HoverContext({
      container: ownerDocument.body,
      offset: 10
    });

    const hoverHandler = data => {
      if (
        data === null ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        !Array.isArray(data.points) ||
        data.points.length !== 1
      ) {
        throw new TypeError(
          'Plotly marker hover must contain exactly one point'
        );
      }
      const point = data.points[0];
      if (
        point === null ||
        typeof point !== 'object' ||
        Array.isArray(point) ||
        !Array.isArray(point.pointNumber) ||
        point.pointNumber.length !== 2 ||
        !Number.isSafeInteger(point.pointNumber[0]) ||
        !Number.isSafeInteger(point.pointNumber[1])
      ) {
        throw new TypeError(
          'Plotly marker hover point must expose an exact heatmap index pair'
        );
      }
      const [groupIndex, geneIndex] = point.pointNumber;
      if (
        groupIndex < 0 ||
        groupIndex >= nCols ||
        geneIndex < 0 ||
        geneIndex >= nRows
      ) {
        throw new RangeError(
          'Plotly marker hover point is outside the heatmap matrix'
        );
      }
      const gene = genes[geneIndex];
      const group = groupNames[groupIndex];
      if (
        point.x !== gene ||
        point.y !== group ||
        !Number.isFinite(point.z)
      ) {
        throw new TypeError(
          'Plotly marker hover point does not match the rendered matrix cell'
        );
      }
      const event = data.event;
      if (
        event === null ||
        typeof event !== 'object' ||
        !Number.isFinite(event.clientX) ||
        !Number.isFinite(event.clientY)
      ) {
        throw new TypeError(
          'Plotly marker hover event must expose finite client coordinates'
        );
      }

      let markerInfo = null;
      if (markerLookup !== null) {
        const groupMarkers = markerLookup.get(groupIds[groupIndex]);
        if (groupMarkers.has(gene)) {
          markerInfo = groupMarkers.get(gene);
        }
      }

      hoverContext.show({
        gene,
        group,
        value: point.z,
        position: { x: event.clientX, y: event.clientY },
        markerInfo
      });
    };

    const unhoverHandler = () => {
      hoverContext.hide(100);
    };

    let hoverAttached = false;
    let unhoverAttached = false;
    try {
      plotContainer.on('plotly_hover', hoverHandler);
      hoverAttached = true;
      plotContainer.on('plotly_unhover', unhoverHandler);
      unhoverAttached = true;
    } catch (error) {
      const cleanupErrors = [error];
      if (unhoverAttached) {
        try {
          plotContainer.removeListener('plotly_unhover', unhoverHandler);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (hoverAttached) {
        try {
          plotContainer.removeListener('plotly_hover', hoverHandler);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        hoverContext.destroy();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length === 1) throw error;
      throw new AggregateError(
        cleanupErrors,
        'Marker heatmap hover setup and cleanup both failed'
      );
    }

    const binding = {
      container: plotContainer,
      hoverHandler,
      unhoverHandler
    };
    this._hoverOwners.set(plotContainer, {
      context: hoverContext,
      binding
    });
    this._hoverContext = hoverContext;
    this._hoverPlotBinding = binding;
    return () => this._teardownHoverContext(plotContainer);
  }

  /**
   * Normalize current marker results into exact tooltip display records.
   * @private
   */
  _buildHoverMarkerLookup(markers, groupIds) {
    if (markers === null) return null;
    if (
      markers === undefined ||
      typeof markers !== 'object' ||
      Array.isArray(markers) ||
      markers.groups === null ||
      typeof markers.groups !== 'object' ||
      Array.isArray(markers.groups)
    ) {
      throw new TypeError(
        'Marker heatmap marker results must be null or own a groups record'
      );
    }

    const lookup = new Map();
    for (const groupId of groupIds) {
      if (!Object.hasOwn(markers.groups, groupId)) {
        throw new Error(
          `Marker heatmap results are missing group "${groupId}"`
        );
      }
      const group = markers.groups[groupId];
      if (
        group === null ||
        typeof group !== 'object' ||
        Array.isArray(group) ||
        group.groupId !== groupId ||
        !Array.isArray(group.markers)
      ) {
        throw new TypeError(
          `Marker heatmap group "${groupId}" is malformed`
        );
      }
      const groupLookup = new Map();
      for (const marker of group.markers) {
        if (
          marker === null ||
          typeof marker !== 'object' ||
          Array.isArray(marker) ||
          typeof marker.gene !== 'string' ||
          marker.gene.length === 0 ||
          marker.groupId !== groupId ||
          !Number.isFinite(marker.pValue) ||
          marker.pValue < 0 ||
          marker.pValue > 1 ||
          (
            marker.adjustedPValue !== null &&
            (
              !Number.isFinite(marker.adjustedPValue) ||
              marker.adjustedPValue < 0 ||
              marker.adjustedPValue > 1
            )
          ) ||
          !Number.isFinite(marker.log2FoldChange) ||
          !Number.isSafeInteger(marker.rank) ||
          marker.rank < 1
        ) {
          throw new TypeError(
            `Marker heatmap group "${groupId}" contains malformed marker statistics`
          );
        }
        if (groupLookup.has(marker.gene)) {
          throw new Error(
            `Marker heatmap group "${groupId}" contains duplicate gene "${marker.gene}"`
          );
        }
        let percentInGroup = null;
        if (Object.hasOwn(marker, 'percentInGroup')) {
          if (
            !Number.isFinite(marker.percentInGroup) ||
            marker.percentInGroup < 0 ||
            marker.percentInGroup > 100
          ) {
            throw new RangeError(
              `Marker heatmap gene "${marker.gene}" has an invalid in-group percentage`
            );
          }
          percentInGroup = marker.percentInGroup;
        }
        groupLookup.set(marker.gene, {
          pValue: marker.pValue,
          adjustedPValue: marker.adjustedPValue,
          log2FoldChange: marker.log2FoldChange,
          percentInGroup,
          rank: marker.rank
        });
      }
      lookup.set(groupId, groupLookup);
    }
    return lookup;
  }

  /**
   * Release both Plotly listener ownership and tooltip DOM ownership.
   * @private
   */
  _teardownHoverContext(plotContainer = null) {
    this._hoverOwners ??= new Map();
    const owners = [];
    if (plotContainer !== null) {
      const owner = this._hoverOwners.get(plotContainer);
      if (owner !== undefined) owners.push(owner);
      this._hoverOwners.delete(plotContainer);
    } else if (this._hoverOwners.size > 0) {
      owners.push(...this._hoverOwners.values());
      this._hoverOwners.clear();
    } else if (
      this._hoverPlotBinding !== null ||
      this._hoverContext !== null
    ) {
      owners.push({
        binding: this._hoverPlotBinding,
        context: this._hoverContext
      });
    }
    if (
      plotContainer === null ||
      this._hoverPlotBinding?.container === plotContainer
    ) {
      this._hoverPlotBinding = null;
      this._hoverContext = null;
    }
    const errors = [];
    for (const { binding, context: hoverContext } of owners) {
      if (binding != null) {
        try {
          binding.container.removeListener(
            'plotly_hover',
            binding.hoverHandler
          );
        } catch (error) {
          errors.push(error);
        }
        try {
          binding.container.removeListener(
            'plotly_unhover',
            binding.unhoverHandler
          );
        } catch (error) {
          errors.push(error);
        }
      }
      if (hoverContext != null) {
        try {
          hoverContext.destroy();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        'Marker heatmap hover cleanup failed'
      );
    }
  }

  /**
   * Update progress display via ProgressTracker
   * Called by the controller during analysis with { phase, progress, message }
   * @private
   * @param {Object} progress - Progress info from controller
   * @param {string} progress.phase - Current phase name
   * @param {number} progress.progress - Progress percentage (0-100)
   * @param {string} progress.message - Progress message
   */
  _updateProgress(progress, progressTracker = this._progressTracker) {
    if (!progressTracker) return;

    const { phase, progress: percent, loaded, total, message } = progress || {};

    // Keep the ProgressTracker's phase in sync with controller emissions so the
    // notification doesn't appear "stuck" on the initial phase.
    if (typeof phase === 'string' && phase.length > 0) {
      // If phase changes, reset the per-phase counters for a sane ETA.
      const prevPhase = progressTracker.getStats()?.phase;
      if (prevPhase !== phase) {
        progressTracker.setPhase(phase);
        progressTracker.setTotalItems(100);
        progressTracker.setCompletedItems(0);
      } else {
        progressTracker.setPhase(phase);
      }
    }

    if (Number.isFinite(total) && total > 0) {
      progressTracker.setTotalItems(total);
    }

    if (Number.isFinite(loaded)) {
      progressTracker.setCompletedItems(loaded);
    } else if (Number.isFinite(percent)) {
      // For phases that only report percentage (e.g., init/clustering), treat
      // the phase total as 100.
      if (!Number.isFinite(total) || total <= 0) {
        progressTracker.setTotalItems(100);
      }
      progressTracker.setCompletedItems(Math.floor(percent));
    }

    const displayMessage = message || (phase ? `${phase}...` : 'Working...');
    progressTracker.setMessage(displayMessage);
  }

  /**
   * @override
   */
  destroy() {
    if (this._destroyPromise != null) return this._destroyPromise;
    const errors = [];
    const progressTracker = this._progressTracker;
    this._progressTracker = null;
    if (progressTracker !== null) {
      try {
        progressTracker.cancel();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this._teardownHoverContext();
    } catch (error) {
      errors.push(error);
    }
    const controller = this._controller;
    this._controller = null;
    if (controller !== null && controller !== undefined) {
      try {
        const closeTask = controller.close();
        if (closeTask && typeof closeTask.then === 'function') {
          this._registerFormDestroyTask(closeTask);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    const parentTask = super.destroy();
    if (errors.length === 0) return parentTask;
    const destruction = Promise.resolve(parentTask).then(
      () => {
        if (errors.length === 1) throw errors[0];
        throw new AggregateError(errors, 'Marker Genes UI cleanup failed');
      },
      parentError => {
        throw new AggregateError(
          [...errors, parentError],
          'Marker Genes UI cleanup failed'
        );
      }
    );
    this._destroyPromise = destruction;
    void destruction.catch(() => {});
    return destruction;
  }

  exportSettings() {
    const base = super.exportSettings();
    return {
      ...base,
      modalSelectedGroupId: this._modalSelectedGroupId,
      modalGeneListMode: this._modalGeneListMode
    };
  }

  importSettings(settings) {
    const base = this._requireExactFormSettings(
      settings,
      [
        'formControls',
        'modalGeneListMode',
        'modalSelectedGroupId',
        'selectedPages'
      ]
    );
    if (
      settings.modalSelectedGroupId !== null &&
      (
        typeof settings.modalSelectedGroupId !== 'string' ||
        settings.modalSelectedGroupId.length === 0
      )
    ) {
      throw new TypeError(
        'Marker Genes modalSelectedGroupId must be null or a non-empty string'
      );
    }
    const geneListModes = new Set([
      'all',
      'top5',
      'top10',
      'top20',
      'top100'
    ]);
    if (!geneListModes.has(settings.modalGeneListMode)) {
      throw new TypeError(
        'Marker Genes modalGeneListMode is unsupported'
      );
    }

    this._modalSelectedGroupId = settings.modalSelectedGroupId;
    this._modalGeneListMode = settings.modalGeneListMode;
    this._applyFormSettings(base);
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a GenesPanelUI instance
 *
 * @param {Object} options - Same options as GenesPanelUI constructor
 * @returns {GenesPanelUI}
 */
export function createGenesPanelUI(options) {
  const ui = new GenesPanelUI(options);
  ui.init(options.container);
  return ui;
}

export default GenesPanelUI;
