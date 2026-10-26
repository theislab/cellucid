/**
 * Marker genes: the genes that mark each category of a field.
 *
 * The form is the marker options schema's (`options/marker-options.js`):
 * Group by, Compare against (the rest or one group), Run; groups and cells,
 * test, filters and ranking under More options. A small group is skipped,
 * pooled or tested and flagged by its policy, never an error. The result
 * keeps every gene's statistics for every group, so the filters, ranking and
 * the number shown re-apply at once without testing again
 * (`genes-panel/marker-selection.js`). It shows as a ranked list or a
 * heatmap (clustered or not); its header says what was compared, with chips
 * for skipped groups, low counts and a cached answer.
 *
 * @module ui/analysis-types/genes-panel-ui
 */

import { FormBasedAnalysisUI } from './base/form-based-analysis.js';
import { GenesPanelController, GROUP_ID_PREFIX, POOLED_GROUP_ID } from '../../genes-panel/genes-panel-controller.js';
import { markerMatrix, retransformMatrix } from '../../genes-panel/expression-matrix-builder.js';
import { MARKER_DISPLAY_KEYS, markerDisplayOf, rankGroupGenes, selectMarkers } from '../../genes-panel/marker-selection.js';
import { HoverContext } from '../components/hover-context.js';
import { PlotRegistry } from '../../shared/plot-registry-utils.js';
import { downloadCSV } from '../../shared/analysis-utils.js';
import { downloadBlob } from '../../../utils/download.js';
import { toCSVCell } from '../../compute/csv-export.js';
import { getComputeManager } from '../../compute/compute-manager.js';
import { OperationType } from '../../compute/operations.js';
import { DEFAULTS } from '../../genes-panel/constants.js';
import { MARKER_OPTIONS } from '../../options/marker-options.js';
import { defineOptions } from '../../options/option-schema.js';
import { renderOptionsForm } from '../../options/render-options-form.js';
import { countGeneFamilies } from '../../shared/gene-sets.js';
import { createSegmented } from '../../../ui/components/controls.js';
import {
  createResultEnvelope,
  readResultEnvelope,
  requireDatasetGenes,
  requireDatasetVariable
} from '../../shared/analysis-result-session.js';
import { formatDuration, formatCount, formatCountOf } from '../../../../utils/format-units.js';

/** A marker group in a session: its category, by value. */
const GROUP_KEY_PREFIX = 'category:';

/** The Wilcoxon p-value conventions as the form names them. */
const P_CONVENTION_NAMES = Object.freeze(Object.fromEntries(
  MARKER_OPTIONS.entry('pConvention').choices.map(choice => [choice.value, choice.label])
));

const METHOD_NAMES = Object.freeze({
  wilcox: 'Wilcoxon',
  ttest: 't-test',
  ttest_overestim_var: 't-test (overestimated variance)'
});
const CORRECTION_NAMES = Object.freeze({ bh: 'BH', bonferroni: 'Bonferroni' });
const SHOW_CHOICES = Object.freeze(['list', 'heatmap', 'clustered']);

/** The display options, as their own small form for the expanded view. */
const DISPLAY_OPTIONS = defineOptions({
  id: 'genesPanelDisplay',
  groups: [],
  options: MARKER_OPTIONS.entries
    .filter(entry => MARKER_DISPLAY_KEYS.includes(entry.key))
    .map(entry => ({ ...entry, group: 'essentials' }))
});

export class GenesPanelUI extends FormBasedAnalysisUI {
  static getRequirements() {
    return {
      minPages: 0,
      maxPages: null,
      description: 'Discover and visualize marker genes across cell groups',
      geneExpression: true
    };
  }

  constructor(options) {
    super(options);
    /** @type {GenesPanelController|null} */
    this._controller = null;
    /** The groups of the chosen field in the chosen cells, for the picker and Run. */
    this._groupState = { key: null, described: null, pending: null };
    /** Highly variable genes: unknown until the file is asked. */
    this._familyCounts = null;
    /** Viewer state: how the result shows, which group the table lists, the heatmap's look. */
    this._show = 'heatmap';
    this._selectedGroupId = null;
    this._heatmap = {
      transform: DEFAULTS.transform,
      colorscale: DEFAULTS.colorscale,
      clusterRows: DEFAULTS.clusterRows,
      clusterCols: DEFAULTS.clusterCols,
      distance: DEFAULTS.distance,
      linkage: DEFAULTS.linkage
    };
    /** @type {Map<HTMLElement, {context: HoverContext, binding: Object}>} */
    this._hoverOwners = new Map();
  }

  _getTitle() {
    return 'Marker genes';
  }

  _getClassName() {
    return 'genes-panel';
  }

  _getSuccessMessage(result) {
    const meta = result?.metadata;
    if (!meta) return 'Marker genes complete';
    const skipped = meta.skippedGroups.length;
    return skipped === 0
      ? `Marker genes: ${formatCountOf(meta.testedCount, 'group')} tested`
      : `Marker genes: ${formatCountOf(meta.testedCount, 'group')} tested, ${formatCount(skipped)} skipped ` +
        `(${meta.skippedGroups.map(group => group.name).join(', ')})`;
  }

  // ===========================================================================
  // Options
  // ===========================================================================

  _getOptionsSchema() {
    return MARKER_OPTIONS;
  }

  _getOptionsContext() {
    const categoricalFields = this.dataLayer.getAvailableVariables('categorical_obs')
      .filter(variable => (variable.categoryCount ?? variable.categories?.length ?? 2) >= 2)
      .map(variable => ({ key: variable.key }));
    const genes = this.dataLayer.getAvailableVariables('gene_expression');
    if (this._familyCounts?.of !== genes) {
      this._familyCounts = { of: genes, counts: countGeneFamilies(genes.map(gene => gene.key)) };
    }
    const groupsOf = record => {
      const described = this._groupState.key === this._groupKey(record) ? this._groupState.described : null;
      if (described === null) this._loadGroups(record);
      return (described?.groups ?? []).map(group => ({
        id: group.optionId,
        name: String(group.groupName),
        count: group.count,
        color: group.color
      }));
    };
    return {
      categoricalFields,
      groupsFor: (entry, record) => groupsOf(record),
      // While the field's categories are read, a saved group is kept, not refused.
      groupsKnown: record => {
        groupsOf(record);
        return this._groupState.key === this._groupKey(record) && this._groupState.described !== null;
      },
      minCellsFor: (entry, record) => record.minCells,
      pages: this.dataLayer.getPages()
        .filter(page => this.dataLayer.getCellCountForPageId(page.id) > 0)
        .map(page => ({ id: page.id, name: page.name })),
      geneFamilyCounts: this._familyCounts.counts,
      hasHighlyVariable: this._highlyVariableAvailable(),
      expressionMatrices: this.dataLayer.getExpressionMatrices()
    };
  }

  _isDisplayOption(key) {
    return MARKER_DISPLAY_KEYS.includes(key);
  }

  _getRunNoun() {
    return 'marker genes';
  }

  /**
   * What the described groups depend on: the field and the cells, and the
   * highlights only when the cells are a page's (the filters when they are
   * the visible cells). With all cells, a highlight change keeps the groups
   * (no re-read, no "Reading the groups…" flash).
   */
  _groupKey(record) {
    const revision = record.cells === 'all'
      ? ''
      : record.cells === 'visible' ? `v${this._visibleCellsDigest()}` : this._highlightRevision;
    return `${record.groupBy}|${record.cells}|${revision}`;
  }

  /** Describe the groups of the chosen field in the chosen cells (async), then redraw. */
  _loadGroups(record) {
    const key = this._groupKey(record);
    if (this._groupState.pending === key || record.groupBy === '') return;
    // A read that failed for these groups is not retried on every redraw (it
    // posted its error each time): the next option, cells or highlight
    // change reads again (`_handleOptionsChanged`).
    if (this._groupState.key === key && this._groupState.error != null) return;
    this._groupState = { key, described: null, pending: key };
    const controller = this._ensureController();
    void Promise.resolve()
      .then(() => controller.describeGroups(record.groupBy, controller.scopeOf(record.cells)))
      .then(described => {
        if (this._isDestroyed || this._groupState.pending !== key) return;
        this._groupState = { key, described, pending: null };
        this._refreshOptionsContext();
      })
      .catch(error => {
        if (this._isDestroyed || this._groupState.pending !== key) return;
        this._groupState = { key, described: null, pending: null, error };
        this._notifications.error(`Marker genes groups: ${error.message}`, { category: 'analysis' });
        this._refreshOptionsContext();
      });
  }

  /**
   * A changed option is the user's next try at groups that could not be read.
   * @override
   */
  _handleOptionsChanged(key) {
    if (this._groupState.error != null) this._groupState = { key: null, described: null, pending: null };
    super._handleOptionsChanged(key);
  }

  _getRunBlocker(options) {
    if (options.groupBy === '') return 'This dataset has no categorical field to group by';
    const current = this._groupState.key === this._groupKey(options);
    if (current && this._groupState.error != null) {
      return `The groups could not be read: ${this._groupState.error.message}`;
    }
    const described = current ? this._groupState.described : null;
    if (described === null) {
      this._loadGroups(options);
      return 'Reading the groups…';
    }
    return this._ensureController().plan(options, described).blocker;
  }

  onHighlightChanged() {
    super.onHighlightChanged();
    if (this._options !== null && this._options.cells !== 'all') this._loadGroups(this._options);
  }

  // ===========================================================================
  // Run
  // ===========================================================================

  _ensureController() {
    if (this._controller === null) {
      this._controller = new GenesPanelController({ dataLayer: this.dataLayer });
    }
    return this._controller;
  }

  async _runAnalysisImpl(options, requestId, job) {
    const controller = this._ensureController();
    const run = await controller.runAnalysis({ options, job });
    if (!this._isCurrentAnalysisRequest(requestId)) return null;
    return this._buildResult(run.stats, run.metadata, options, job?.signal ?? null);
  }

  /** The drawn result: the shown markers, the heatmap and its clustering. */
  async _buildResult(stats, metadata, options, signal = null) {
    const display = markerDisplayOf(options);
    const selection = selectMarkers(stats, display);
    const testedIndices = stats.groups.map((group, index) => (group.tested ? index : -1)).filter(index => index >= 0);
    let matrix = null;
    let clustering = null;
    if (selection.shownGenes.length > 0 && testedIndices.length > 0) {
      matrix = markerMatrix(stats, {
        genes: selection.shownGenes,
        groupIndices: testedIndices,
        transform: this._heatmap.transform
      });
      if (this._show === 'clustered' && (this._heatmap.clusterRows || this._heatmap.clusterCols)) {
        const clusterable = this._clusterable(matrix);
        if (clusterable) {
          clustering = await this._ensureController().cluster(matrix, { ...this._heatmap, signal });
          matrix = this._ensureController().applyOrdering(matrix, clustering);
        }
      }
    }
    return {
      type: 'genes_panel',
      plotType: 'gene-heatmap',
      data: { matrix, clustering },
      stats,
      selection,
      options: {
        transform: this._heatmap.transform,
        colorscale: this._heatmap.colorscale,
        hasClustering: this._show === 'clustered',
        clusterRows: this._heatmap.clusterRows,
        clusterCols: this._heatmap.clusterCols,
        distance: this._heatmap.distance,
        linkage: this._heatmap.linkage,
        showValues: false,
        reverseColorscale: true
      },
      title: 'Marker genes',
      subtitle: metadata.groupBy,
      metadata: { ...metadata, display }
    };
  }

  /** A heatmap clusters when every value is finite and an axis has two or more. */
  _clusterable(matrix) {
    if (matrix.nRows < 2 && matrix.nCols < 2) return false;
    for (let i = 0; i < matrix.values.length; i++) if (!Number.isFinite(matrix.values[i])) return false;
    return true;
  }

  /** Redraw the shown result for new display options; a newer redraw stops this one's clustering. */
  _rebuildForDisplay(options) {
    const result = this._lastResult;
    if (!result?.stats) return null;
    this._displayRebuild?.abort();
    const rebuild = new AbortController();
    this._displayRebuild = rebuild;
    // A superseded redraw draws nothing (its token is no longer current).
    return this._buildResult(result.stats, result.metadata, options, rebuild.signal).catch(error => {
      if (rebuild.signal.aborted) return null;
      throw error;
    });
  }

  // ===========================================================================
  // Result view
  // ===========================================================================

  async _showResult(result, requestId) {
    if (!this._isCurrentAnalysisRequest(requestId)) return null;
    this._teardownHoverContext();
    const container = this._resultContainer;
    const header = this._renderResultHeader(result);
    if (this._show === 'list' || result.data.matrix === null) {
      if (this._previewPlotSlot != null) {
        await this._previewPlotSlot.destroy();
        this._previewPlotSlot = null;
        this._previewPlotHost = null;
      }
      container.replaceChildren(header, this._renderRankedPreview(result));
      container.hidden = false;
      this._renderPreviewExpandAction();
      return container;
    }
    await import('../../plots/types/gene-heatmap.js');
    if (!this._isCurrentAnalysisRequest(requestId)) return null;
    const containerId = `genes-panel-plot-${this._instanceId || 'default'}`;
    const rendered = await this._renderPreviewPlot({
      result,
      requestId,
      containerId,
      expandable: true,
      height: Math.min(560, 140 + 14 * result.data.matrix.nRows),
      onRendered: candidate => this._setupHoverContext(candidate, result)
    });
    if (rendered !== null && this._isCurrentAnalysisRequest(requestId)) {
      container.querySelector(':scope > .analysis-result-header')?.remove();
      container.prepend(header);
    }
    return rendered;
  }

  /**
   * One line saying what was compared, chips for what the run decided, the
   * Show switch and the hand-offs.
   */
  _renderResultHeader(result) {
    const { metadata, stats } = result;
    const header = document.createElement('div');
    header.className = 'analysis-result-header';

    const line = document.createElement('p');
    line.className = 'analysis-result-line';
    const reference = stats.groups.find(group => group.reference);
    line.textContent = [
      `${formatCountOf(metadata.testedCount, 'group')}${reference ? ` vs ${reference.groupName}` : ''}`,
      METHOD_NAMES[metadata.method],
      CORRECTION_NAMES[metadata.correction],
      formatCountOf(metadata.geneCount, 'gene'),
      ...(metadata.matrix === 'mapped' ? [] : [metadata.matrixLabel])
    ].join(' · ');
    header.appendChild(line);

    const chips = document.createElement('div');
    chips.className = 'analysis-result-chips';
    const chip = (text, title, tone = '') => {
      const element = document.createElement('span');
      element.className = `analysis-chip${tone ? ` analysis-chip-${tone}` : ''}`;
      element.textContent = text;
      element.title = title;
      chips.appendChild(element);
      return element;
    };
    if (metadata.skippedGroups.length > 0) {
      chip(
        `${formatCount(metadata.skippedGroups.length)} skipped`,
        `Fewer than ${formatCountOf(this._options?.minCells ?? metadata.minCellsPerSide, 'cell')}, not tested (kept in the rest): ` +
          metadata.skippedGroups.map(group => `${group.name} (${formatCount(group.cells)})`).join(', '),
        'warning'
      );
    }
    if (metadata.pooledGroups.length > 0) {
      chip(`${formatCount(metadata.pooledGroups.length)} pooled`,
        `Tested together as one group: ${metadata.pooledGroups.map(group => group.name).join(', ')}`, 'info');
    }
    if (metadata.lowNGroups.length > 0) {
      chip(`${formatCount(metadata.lowNGroups.length)} low n`,
        `Tested with fewer cells than the minimum: ${metadata.lowNGroups.map(group => `${group.name} (${formatCount(group.cells)})`).join(', ')}`, 'warning');
    }
    if (metadata.cached) {
      const cached = chip('Cached', 'The same run was answered from memory');
      const recompute = document.createElement('button');
      recompute.type = 'button';
      recompute.className = 'analysis-link-btn';
      recompute.textContent = 'Recompute';
      recompute.addEventListener('click', () => {
        this._controller?.clearCache();
        this._runAgain();
      });
      cached.after(recompute);
    }
    if (chips.childElementCount > 0) header.appendChild(chips);

    const controls = document.createElement('div');
    controls.className = 'analysis-result-controls';
    const show = createSegmented({
      label: 'Show',
      options: [
        { value: 'list', label: 'List' },
        { value: 'heatmap', label: 'Heatmap' },
        { value: 'clustered', label: 'Clustered' }
      ],
      value: this._show,
      onChange: next => {
        this._show = next;
        this._trackInteractiveTask(this._redrawForDisplay(), 'Marker genes view');
      }
    });
    controls.appendChild(show.root);
    const sendTo = document.createElement('span');
    sendTo.className = 'analysis-send-to';
    const sendButton = (label, mode, presetOf) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'analysis-link-btn';
      button.textContent = label;
      button.addEventListener('click', () => {
        const preset = presetOf();
        void this._trackInteractiveTask(
          Promise.resolve(this.comparisonModule?.openAnalysis?.(mode, preset)),
          `Send to ${label.toLowerCase()}`
        );
      });
      sendTo.appendChild(button);
    };
    if (typeof this.comparisonModule?.openAnalysis === 'function') {
      sendButton('Score as signature', 'signature', () => ({ options: { geneSets: this.getMarkerGeneSets() } }));
      sendButton('Dot plot', 'dotplot', () => ({ options: { groupBy: metadata.groupBy, geneSets: this.getMarkerGeneSets() } }));
      controls.appendChild(sendTo);
    }
    header.appendChild(controls);
    return header;
  }

  /** The ranked list: each tested group and its markers, compact. */
  _renderRankedPreview(result) {
    const { selection, stats, metadata } = result;
    const list = document.createElement('div');
    list.className = 'marker-ranked-preview';
    const tested = selection.groups.filter(entry => entry.group.tested);
    if (selection.shownGenes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      const genesTested = Math.max(0, ...stats.genesTestedByGroup);
      empty.textContent = `No genes pass the filters (${formatCountOf(genesTested, 'gene')} tested in ${formatCountOf(metadata.testedCount, 'group')}).`;
      const relax = document.createElement('button');
      relax.type = 'button';
      relax.className = 'analysis-link-btn';
      relax.textContent = 'Relax filters';
      relax.addEventListener('click', () => this._relaxFilters());
      empty.appendChild(relax);
      list.appendChild(empty);
      return list;
    }
    for (const { group, markers, passing } of tested) {
      const row = document.createElement('div');
      row.className = 'marker-ranked-row';
      const name = document.createElement('span');
      name.className = 'marker-ranked-group';
      const swatch = document.createElement('span');
      swatch.className = 'group-picker-swatch';
      swatch.style.background = group.color;
      name.append(swatch, String(group.groupName));
      if (group.smallFate === null && group.small) name.title = 'Fewer cells than the minimum (low n)';
      const genes = document.createElement('span');
      genes.className = 'marker-ranked-genes';
      if (markers.length === 0) {
        genes.textContent = '—';
      } else {
        markers.forEach((marker, index) => {
          if (index > 0) genes.append(', ');
          genes.appendChild(this._createGeneButton(marker.gene));
        });
      }
      genes.title = `${formatCountOf(passing, 'gene')} pass the filters`;
      row.append(name, genes);
      list.appendChild(row);
    }
    return list;
  }

  /** Show every tested gene ranked by score: the filters that hid them relaxed. */
  _relaxFilters() {
    this._setOptions({
      ...this._options,
      direction: 'both',
      maxAdjP: 1,
      minLog2FC: 0,
      minPctIn: 0,
      maxPctRef: 100
    });
  }

  // ===========================================================================
  // Expanded view
  // ===========================================================================

  async _renderModalPlot(container, { isCurrent = () => true, modal = this._modal, result = this._lastResult } = {}) {
    if (!result) return null;
    const slot = this._ensureModalPlotSlot(modal);
    if (result.data.matrix === null) {
      return slot.render({
        render: candidate => {
          const empty = candidate.ownerDocument.createElement('p');
          empty.className = 'empty-state';
          empty.textContent = 'No genes pass the filters.';
          candidate.replaceChildren(empty);
          return null;
        }
      }, { isCurrent });
    }
    await import('../../plots/types/gene-heatmap.js');
    const plotDef = PlotRegistry.get(result.plotType);
    if (!plotDef) throw new RangeError(`Unknown plot type: ${result.plotType}`);
    const merged = PlotRegistry.mergeOptions(result.plotType, result.options || {});
    return slot.render({
      render: candidate => plotDef.render(result.data, merged, candidate, null),
      onRendered: candidate => this._setupHoverContext(candidate, result)
    }, { isCurrent });
  }

  /** The heatmap's look, and the display options (filters, ranking). */
  _renderModalOptions(container) {
    super._renderModalOptions(container);
    if (this._options === null) return;
    const form = renderOptionsForm({
      schema: DISPLAY_OPTIONS,
      value: markerDisplayOf(this._options),
      context: {},
      onChange: (record, key) => {
        this._options = { ...this._options, ...record };
        this._optionsForm?.setValue(this._options);
        this._handleOptionsChanged(key);
      }
    });
    form.root.classList.add('marker-modal-display');
    container.prepend(form.root);
  }

  /** Heatmap options; clustering ones re-cluster, the rest re-draw. */
  _handlePlotOptionChange(key, value) {
    if (['transform', 'colorscale', 'clusterRows', 'clusterCols', 'distance', 'linkage'].includes(key)) {
      this._heatmap = { ...this._heatmap, [key]: value };
    }
    if (['transform', 'clusterRows', 'clusterCols', 'distance', 'linkage'].includes(key)) {
      return this._trackInteractiveTask(this._redrawForDisplay(), 'Marker heatmap update');
    }
    return super._handlePlotOptionChange(key, value);
  }

  _renderModalStats(container) {
    const result = this._lastResult;
    if (!result?.metadata) return;
    const { metadata } = result;
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
      tdValue.textContent = String(value);
      tr.append(tdLabel, tdValue);
      tbody.appendChild(tr);
    };
    addRow('Group by', metadata.groupBy);
    addRow('Groups tested', `${formatCount(metadata.testedCount)} of ${formatCount(metadata.groupCount)}`);
    addRow('Method', METHOD_NAMES[metadata.method]);
    if (metadata.method === 'wilcox') addRow('p-values', P_CONVENTION_NAMES[metadata.pConvention]);
    addRow('Multiple testing', CORRECTION_NAMES[metadata.correction]);
    addRow('Expression matrix', metadata.matrixLabel);
    addRow('Fold change', metadata.foldChange.mode === 'log1p' ? 'Undo log1p' : 'As stored');
    addRow('Genes tested', formatCount(metadata.geneCount));
    addRow('Duration', metadata.cached ? 'Cached' : formatDuration(metadata.durationMs));
    container.appendChild(table);
  }

  /** The ranked table of one group, sortable, with copy and exports. */
  _renderModalAnnotations(container) {
    const result = this._lastResult;
    container.innerHTML = '';
    if (!result?.stats) return;
    const { stats } = result;
    const testedGroups = stats.groups.filter(group => group.tested);
    if (testedGroups.length === 0) return;
    if (!testedGroups.some(group => group.groupId === this._selectedGroupId)) {
      this._selectedGroupId = testedGroups[0].groupId;
    }
    const header = document.createElement('div');
    header.className = 'de-modal-genes-header';
    const groupSelect = document.createElement('select');
    groupSelect.className = 'obs-select';
    groupSelect.setAttribute('aria-label', 'Group');
    for (const group of testedGroups) {
      const option = document.createElement('option');
      option.value = group.groupId;
      option.textContent = String(group.groupName);
      option.selected = group.groupId === this._selectedGroupId;
      groupSelect.appendChild(option);
    }
    groupSelect.addEventListener('change', () => {
      this._selectedGroupId = groupSelect.value;
      this._renderModalAnnotations(container);
    });
    header.appendChild(groupSelect);
    const groupIndex = stats.groups.findIndex(group => group.groupId === this._selectedGroupId);
    const order = rankGroupGenes(stats, groupIndex, markerDisplayOf(this._options));
    const shown = Array.from(order.subarray(0, Math.min(order.length, this._options.topN)));

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'analysis-link-btn';
    copy.textContent = 'Copy genes';
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(shown.map(i => stats.genes[i]).join('\n'));
    });
    const allCsv = document.createElement('button');
    allCsv.type = 'button';
    allCsv.className = 'analysis-link-btn';
    allCsv.textContent = 'All genes CSV';
    allCsv.title = 'Every gene of every group, with scanpy rank_genes_groups_df column names';
    allCsv.addEventListener('click', () => this._trackInteractiveTask(this._exportAllGenesCSV(), 'CSV export'));
    const gmt = document.createElement('button');
    gmt.type = 'button';
    gmt.className = 'analysis-link-btn';
    gmt.textContent = 'GMT';
    gmt.title = 'The shown markers of each group as gene sets';
    gmt.addEventListener('click', () => this._exportGMT());
    header.append(copy, allCsv, gmt);
    container.appendChild(header);

    const summary = document.createElement('p');
    summary.className = 'analysis-run-reason';
    summary.textContent = `${formatCount(order.length)} of ${formatCount(stats.genesTestedByGroup[groupIndex])} tested genes pass the filters`;
    container.appendChild(summary);

    const columns = [
      ['Gene', i => stats.genes[i], null],
      ['Score', i => stats.scoresByGroup[groupIndex][i], 2],
      ['log2FC', i => stats.log2FoldChangeByGroup[groupIndex][i], 2],
      ['adj p', i => stats.adjustedPValuesByGroup[groupIndex][i], 'p'],
      ['% in', i => stats.pctInByGroup[groupIndex][i], 0],
      ['% ref', i => stats.pctRefByGroup[groupIndex][i], 0],
      ['AUROC', i => stats.aurocByGroup[groupIndex][i], 3]
    ];
    const table = document.createElement('table');
    table.className = 'de-genes-table modal-de-genes';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    let sortColumn = -1;
    let sortAscending = false;
    const tbody = document.createElement('tbody');
    const format = (value, digits) => {
      if (typeof value === 'string') return value;
      if (!Number.isFinite(value)) return '—';
      if (digits === 'p') return value.toExponential(2);
      return value.toFixed(digits);
    };
    const renderRows = () => {
      const rows = shown.slice();
      if (sortColumn >= 0) {
        const read = columns[sortColumn][1];
        rows.sort((a, b) => {
          const x = read(a);
          const y = read(b);
          const order = typeof x === 'string' ? x.localeCompare(y) : (x - y);
          return sortAscending ? order : -order;
        });
      }
      this._renderTableRows(tbody, rows, i => {
        const tr = document.createElement('tr');
        tr.className = stats.scoresByGroup[groupIndex][i] > 0 ? 'up' : 'down';
        for (const [, read, digits] of columns) {
          const td = document.createElement('td');
          if (digits === null) td.appendChild(this._createGeneButton(read(i)));
          else td.textContent = format(read(i), digits);
          tr.appendChild(td);
        }
        return tr;
      }, { chunked: rows.length > 500 });
    };
    columns.forEach(([label], index) => {
      const th = document.createElement('th');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'analysis-sort-btn';
      button.textContent = label;
      button.addEventListener('click', () => {
        sortAscending = sortColumn === index ? !sortAscending : index === 0;
        sortColumn = index;
        for (const cell of headRow.children) cell.removeAttribute('aria-sort');
        th.setAttribute('aria-sort', sortAscending ? 'ascending' : 'descending');
        renderRows();
      });
      th.appendChild(button);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.append(thead, tbody);
    container.appendChild(table);
    renderRows();
  }

  // ===========================================================================
  // Exports
  // ===========================================================================

  /** The shown markers: one line per group and marker, scanpy's column names. */
  _exportModalCSV() {
    const result = this._lastResult;
    if (!result?.selection) return;
    const lines = ['group,rank,names,scores,logfoldchanges,pvals,pvals_adj,pct_nz_group,pct_nz_reference,auroc,small_group'];
    for (const { group, markers } of result.selection.groups) {
      for (const marker of markers) {
        lines.push([
          toCSVCell(String(group.groupName)),
          marker.rank,
          toCSVCell(marker.gene),
          toCSVCell(marker.score),
          toCSVCell(marker.log2FoldChange),
          toCSVCell(marker.pValue),
          toCSVCell(marker.adjustedPValue),
          toCSVCell(marker.percentInGroup / 100),
          toCSVCell(marker.percentOutGroup / 100),
          toCSVCell(marker.auroc),
          group.small ? 'true' : 'false'
        ].join(','));
      }
    }
    downloadCSV(lines.join('\n'), 'marker_genes', this._notifications);
  }

  /** Every gene of every group (long), written by the analysis workers. */
  async _exportAllGenesCSV() {
    const stats = this._lastResult?.stats;
    if (!stats) return;
    try {
      const { rows } = await getComputeManager().execute(
        OperationType.COMPUTE_CSV_EXPORT,
        {
          layout: 'marker-statistics',
          markers: {
            genes: stats.genes,
            groups: stats.groups.map(group => ({ name: String(group.groupName), tested: group.tested, small: group.small })),
            scores: stats.scoresByGroup.map(lane => lane.slice()),
            logfoldchanges: stats.log2FoldChangeByGroup.map(lane => lane.slice()),
            pvals: stats.pValuesByGroup.map(lane => lane.slice()),
            pvalsAdj: stats.adjustedPValuesByGroup.map(lane => lane.slice()),
            pctIn: stats.pctInByGroup.map(lane => lane.slice()),
            pctRef: stats.pctRefByGroup.map(lane => lane.slice()),
            auroc: stats.aurocByGroup.map(lane => lane.slice())
          }
        },
        { transfer: true }
      );
      downloadCSV(rows, 'marker_genes_all', this._notifications);
    } catch (error) {
      this._notifications.error(`CSV export failed: ${error.message}`, { category: 'download' });
    }
  }

  /** The shown markers of each group as a GMT file. */
  _exportGMT() {
    const sets = this.getMarkerGeneSets();
    const text = sets.map(set => [set.name.replace(/\t/g, ' '), 'Cellucid marker genes', ...set.genes].join('\t')).join('\n');
    try {
      downloadBlob(new Blob([`${text}\n`], { type: 'text/plain' }), 'marker_genes.gmt');
    } catch (error) {
      this._notifications.error(`GMT export failed: ${error.message}`, { category: 'download' });
    }
  }

  /**
   * One gene set per tested group of the shown result: its shown markers in
   * rank order, named after the group (Dot plot's and Gene signature's
   * "From markers"). Empty when no result is shown.
   * @returns {Array<{name: string, genes: string[]}>}
   */
  getMarkerGeneSets() {
    const selection = this._lastResult?.selection;
    if (!selection) return [];
    return selection.groups
      .filter(({ group, markers }) => group.tested && markers.length > 0)
      .map(({ group, markers }) => ({ name: String(group.groupName), genes: markers.map(marker => marker.gene) }));
  }

  // ===========================================================================
  // Hover
  // ===========================================================================

  _setupHoverContext(plotContainer, result) {
    if (typeof plotContainer?.on !== 'function' || result?.data?.matrix === null) return null;
    this._teardownHoverContext(plotContainer);
    const { matrix } = result.data;
    const { genes, groupIds, groupNames } = matrix;
    const stats = result.stats;
    const geneIndex = new Map(stats.genes.map((gene, index) => [gene, index]));
    const groupIndex = new Map(stats.groups.map((group, index) => [group.groupId, index]));
    const hoverContext = new HoverContext({ container: plotContainer.ownerDocument.body, offset: 10 });
    const hoverHandler = data => {
      const point = data?.points?.[0];
      if (!point || !Array.isArray(point.pointNumber)) return;
      const [col, row] = point.pointNumber;
      const gene = genes[row];
      const g = groupIndex.get(groupIds[col]);
      const i = geneIndex.get(gene);
      const markerInfo = g === undefined || i === undefined ? null : {
        pValue: stats.pValuesByGroup[g][i],
        adjustedPValue: stats.adjustedPValuesByGroup[g][i],
        log2FoldChange: stats.log2FoldChangeByGroup[g][i],
        percentInGroup: stats.pctInByGroup[g][i],
        rank: null
      };
      hoverContext.show({
        gene,
        group: groupNames[col],
        value: point.z,
        position: { x: data.event.clientX, y: data.event.clientY },
        markerInfo: markerInfo !== null && Number.isFinite(markerInfo.pValue) ? markerInfo : null
      });
    };
    const unhoverHandler = () => hoverContext.hide(100);
    plotContainer.on('plotly_hover', hoverHandler);
    plotContainer.on('plotly_unhover', unhoverHandler);
    this._hoverOwners.set(plotContainer, { context: hoverContext, binding: { hoverHandler, unhoverHandler } });
    return () => this._teardownHoverContext(plotContainer);
  }

  _teardownHoverContext(plotContainer = null) {
    const owners = plotContainer === null ? [...this._hoverOwners] : [[plotContainer, this._hoverOwners.get(plotContainer)]];
    for (const [container, owner] of owners) {
      if (!owner) continue;
      container.removeListener?.('plotly_hover', owner.binding.hoverHandler);
      container.removeListener?.('plotly_unhover', owner.binding.unhoverHandler);
      owner.context.destroy();
      this._hoverOwners.delete(container);
    }
  }

  // ===========================================================================
  // Sessions
  // ===========================================================================

  _exportViewState() {
    return {
      show: this._show,
      selectedGroupId: this._selectedGroupId,
      heatmap: { ...this._heatmap }
    };
  }

  _importViewState(view) {
    const keys = Object.keys(view).sort().join(',');
    if (keys !== 'heatmap,selectedGroupId,show') {
      throw new TypeError('Marker genes view must hold exactly show, selectedGroupId and heatmap');
    }
    if (!SHOW_CHOICES.includes(view.show)) throw new TypeError(`Marker genes view show "${view.show}" is unknown`);
    if (view.selectedGroupId !== null && typeof view.selectedGroupId !== 'string') {
      throw new TypeError('Marker genes view selectedGroupId must be a string or null');
    }
    const heatmap = view.heatmap;
    if (
      heatmap === null || typeof heatmap !== 'object' ||
      Object.keys(heatmap).sort().join(',') !== 'clusterCols,clusterRows,colorscale,distance,linkage,transform'
    ) {
      throw new TypeError('Marker genes view heatmap must hold its transform, colours and clustering');
    }
    this._show = view.show;
    this._selectedGroupId = view.selectedGroupId;
    this._heatmap = { ...heatmap };
  }

  /**
   * The shown result for a session: the run's full statistics (typed
   * columns), its groups named by category value, and its metadata. The
   * shown markers, heatmap and clustering are rebuilt from them.
   */
  exportResult() {
    const result = this._lastResult;
    if (!result?.stats) return null;
    const { stats, metadata } = result;
    const categories = requireDatasetVariable(this.dataLayer, 'categorical_obs', metadata.groupBy, 'The marker genes result').categories;
    const keyOf = groupId => {
      if (groupId === POOLED_GROUP_ID) return groupId;
      const code = Number(groupId.slice(GROUP_ID_PREFIX.length));
      if (!groupId.startsWith(GROUP_ID_PREFIX) || !Number.isSafeInteger(code) || code >= categories.length) {
        throw new RangeError(`Marker group "${groupId}" names no category of "${metadata.groupBy}"`);
      }
      return GROUP_KEY_PREFIX + JSON.stringify(categories[code]);
    };
    const { tuning: _tuning, ...kept } = stats;
    return createResultEnvelope('markers', {
      stats: { ...kept, groups: stats.groups.map(group => ({ ...group, groupId: keyOf(group.groupId) })) },
      metadata
    });
  }

  async importResult(envelope) {
    if (envelope === null) {
      await this._discardFormResult();
      return;
    }
    const payload = readResultEnvelope(envelope, 'markers');
    const { stats, metadata } = payload ?? {};
    if (
      !Array.isArray(stats?.groups) || !Array.isArray(stats.genes) ||
      typeof metadata?.groupBy !== 'string' || typeof metadata.matrix !== 'string' ||
      typeof metadata.matrixLabel !== 'string'
    ) {
      throw new TypeError('A marker genes result must hold its statistics and metadata');
    }
    requireDatasetVariable(this.dataLayer, 'categorical_obs', metadata.groupBy, 'The marker genes result');
    await this.dataLayer.ensureObsFieldLoaded(metadata.groupBy);
    const categories = this.dataLayer.getVariableInfo('categorical_obs', metadata.groupBy)?.categories ?? [];
    const codeOf = new Map(categories.map((category, code) => [JSON.stringify(category), code]));
    for (const group of stats.groups) {
      if (group.groupId === POOLED_GROUP_ID) continue;
      const code = codeOf.get(group.groupId.slice(GROUP_KEY_PREFIX.length));
      if (!group.groupId.startsWith(GROUP_KEY_PREFIX) || code === undefined) {
        throw new Error(`The marker genes result names category ${group.groupId.slice(GROUP_KEY_PREFIX.length)}, which field "${metadata.groupBy}" lacks`);
      }
      group.groupId = GROUP_ID_PREFIX + code;
    }
    await requireDatasetGenes(this.dataLayer, stats.genes, 'The marker genes result', metadata.matrix);
    const result = await this._buildResult(stats, metadata, this._requireOptions());
    await this._restoreAnalysisResult(result);
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  destroy() {
    if (this._destroyPromise != null) return this._destroyPromise;
    try {
      this._teardownHoverContext();
    } catch {
      // Hover listeners on a plot already gone.
    }
    this._displayRebuild?.abort();
    const controller = this._controller;
    this._controller = null;
    if (controller !== null) this._registerFormDestroyTask(controller.close());
    return super.destroy();
  }
}

/**
 * Create a GenesPanelUI instance
 * @param {Object} options - Same options as GenesPanelUI constructor
 * @returns {GenesPanelUI}
 */
export function createGenesPanelUI(options) {
  const ui = new GenesPanelUI(options);
  ui.init(options.container);
  return ui;
}
