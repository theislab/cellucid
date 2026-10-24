/**
 * Dot plot: how much, and in how many cells, each listed gene is expressed
 * in each group (scanpy `pl.dotplot` / `pl.matrixplot`).
 *
 * Only the listed genes are read. The groups of the cells (all, the visible
 * ones, or a page; all groups or a chosen few) are held by every worker
 * (`GROUP_SUMMARY_SET_CONTEXT`), and each gene is summed per group in one
 * pass over its non-zero entries (`GROUP_SUMMARY_COMPUTE_GENES`,
 * `compute/group-expression-summary.js`). How the sums are shown — the
 * scaling, the mean of expressing cells, dot or matrix, the axes, the group
 * order, the colours — is applied to the sums on this thread without reading
 * again.
 *
 * @module analysis-types/dotplot-ui
 */

import { FormBasedAnalysisUI } from './base/form-based-analysis.js';
import { dotplotOptions, DOTPLOT_DISPLAY_OPTIONS } from '../../options/dotplot-options.js';
import { createGeneIndex, resolveGenes } from '../../shared/gene-sets.js';
import { getComputeManager } from '../../compute/compute-manager.js';
import { OperationType } from '../../compute/operations.js';
import { groupSummaryValues, scaleByGene } from '../../compute/group-expression-summary.js';
import {
  agglomerate,
  dendrogramLeafOrder,
  pairwiseDistanceRows
} from '../../compute/hierarchical-clustering.js';
import { createRunTuner } from '../../shared/run-tuner.js';
import { analysisWorkerCount } from '../../shared/performance-config.js';
import { createResultEnvelope, readResultEnvelope, requireDatasetGenes } from '../../shared/analysis-result-session.js';
import { downloadCSV } from '../../shared/analysis-utils.js';
import { formatCount } from '../../../ui/components/display-format.js';
import { escapeHtml } from '../../../utils/dom-utils.js';
import { PlotRegistry } from '../../shared/plot-registry-utils.js';
import { createFieldGroups } from './field-groups.js';
import { missingCategoryCode } from '../../../../data/categorical-storage-contract.js';
import '../../plots/types/dotplot.js';

let groupSummaryRun = 0;

/**
 * Bins of each gene's distribution per group, for the stacked violin: as
 * fine as a violin a row high can show.
 */
const VIOLIN_BINS = 40;

function sampleBytes(values) {
  return ArrayBuffer.isView(values) ? values.byteLength : values.indices.byteLength + values.values.byteLength;
}

/**
 * The order of the groups for the plot.
 *
 * @param {'field'|'size'|'dendrogram'} order
 * @param {number[]} sizes - Cells per group
 * @param {Float64Array} means - Gene-major means
 * @param {number} geneCount
 * @returns {number[]}
 */
export function dotplotGroupOrder(order, sizes, means, geneCount) {
  const groupCount = sizes.length;
  const identity = Array.from({ length: groupCount }, (_, index) => index);
  if (order === 'field' || groupCount < 2) return identity;
  if (order === 'size') return identity.sort((a, b) => sizes[b] - sizes[a] || a - b);
  if (order !== 'dendrogram') throw new RangeError(`Unknown group order "${order}"`);
  // Correlation distance between the groups' mean profiles, average linkage.
  const profiles = new Float64Array(groupCount * geneCount);
  for (let group = 0; group < groupCount; group++) {
    for (let gene = 0; gene < geneCount; gene++) {
      const value = means[gene * groupCount + group];
      profiles[group * geneCount + gene] = Number.isFinite(value) ? value : 0;
    }
  }
  const distances = pairwiseDistanceRows(profiles, groupCount, geneCount, 'correlation', 0, groupCount - 1);
  const { left, right } = agglomerate([distances], [[0, groupCount - 1]], groupCount, 'average');
  return Array.from(dendrogramLeafOrder(left, right, groupCount));
}

/**
 * The plot data from a summary and the display options: colour values,
 * fractions and means in the plot's group order.
 *
 * @param {Object} summary - `result.summary`
 * @param {Object} display - The options record
 * @param {number} cellSizePx
 */
export function dotplotPlotData(summary, display, cellSizePx, plotHeightPx = 300) {
  const { genes, geneSets, groups, sizes, sum, expressing, sumExpressing } = summary;
  const geneCount = genes.length;
  const groupCount = groups.length;
  const values = groupSummaryValues({
    sum, expressing, sumExpressing, sizes: Uint32Array.from(sizes), geneCount, groupCount
  });
  const source = display.meanOnlyExpressing ? values.meanExpressing : values.mean;
  const color = scaleByGene(source, geneCount, groupCount, display.scale);
  const order = dotplotGroupOrder(display.groupOrder, sizes, values.mean, geneCount);
  // Each gene's distribution per group, in plot order, as fractions of the
  // group's cells per bin.
  const bins = summary.bins;
  const density = new Float64Array(geneCount * groupCount * bins);
  for (let gene = 0; gene < geneCount; gene++) {
    order.forEach((group, position) => {
      const from = (gene * groupCount + group) * bins;
      const to = (gene * groupCount + position) * bins;
      for (let bin = 0; bin < bins; bin++) {
        density[to + bin] = sizes[group] > 0 ? summary.histogram[from + bin] / sizes[group] : 0;
      }
    });
  }
  const reorder = array => {
    const out = new Float64Array(array.length);
    for (let gene = 0; gene < geneCount; gene++) {
      order.forEach((group, position) => {
        out[gene * groupCount + position] = array[gene * groupCount + group];
      });
    }
    return out;
  };
  return {
    genes,
    geneSets,
    groups: order.map(index => groups[index]),
    cellCounts: order.map(index => sizes[index]),
    color: reorder(color),
    fraction: reorder(values.fraction),
    mean: reorder(source),
    colorLabel: {
      none: display.meanOnlyExpressing ? 'Mean in expressing cells' : 'Mean expression',
      var: 'Mean, scaled per gene',
      z: 'Mean, z per gene'
    }[display.scale],
    colorMap: display.colorMap,
    maxDotSize: display.maxDotSize,
    cellSizePx,
    plotHeightPx,
    layout: display.plot,
    bins,
    range: summary.range,
    density,
    swap: display.swapAxes,
    showSingleSetName: true
  };
}

export class DotplotUI extends FormBasedAnalysisUI {
  static getRequirements() {
    return {
      minPages: 0,
      maxPages: null,
      description: 'Choose the groups and the genes',
      geneExpression: true
    };
  }

  constructor(options) {
    super(options);
    this._plotContainerIdBase = this._instanceId ? `${this._instanceId}-dotplot` : 'dotplot';
    this._geneIndex = null;
    this._fieldGroups = createFieldGroups({
      dataLayer: this.dataLayer,
      onReady: () => this._refreshOptionsContext(),
      onError: error => this._notifications.error(`Dot plot groups: ${error.message}`, { category: 'analysis' })
    });
  }

  _getTitle() {
    return 'Dot plot';
  }

  _getClassName() {
    return 'dotplot';
  }

  _getOptionsSchema() {
    return dotplotOptions;
  }

  _getRunNoun() {
    return 'dot plot';
  }

  validateDataRequirements() {
    const base = super.validateDataRequirements();
    if (!base.valid) return base;
    if (this.dataLayer.getAvailableVariables('categorical_obs').length === 0) {
      return { valid: false, error: 'Requires a categorical field to group the cells by.' };
    }
    return { valid: true };
  }

  _geneNames() {
    return this.dataLayer.getAvailableVariables('gene_expression').map(info => info.key);
  }

  _getOptionsContext() {
    const categoricalFields = this.dataLayer.getAvailableVariables('categorical_obs').map(info => ({
      key: info.key,
      name: info.name ?? info.key,
      // Null until the field is read: its categories are not known yet.
      categoryCount: Array.isArray(info.categories) ? info.categories.length : (info.categoryCount ?? null)
    }));
    const state = this.dataLayer.state;
    const active = state?.activeFieldSource === 'obs' && state.activeFieldIndex >= 0
      ? state.obsData?.fields?.[state.activeFieldIndex]
      : null;
    return {
      categoricalFields,
      colorField: active?.kind === 'category' ? active.key : null,
      pages: this.dataLayer.getPages().map(page => ({ id: page.id, name: page.name })),
      groupsFor: (_entry, record) => this._fieldGroups.groups(record.groupBy),
      getGenes: () => this._geneNames(),
      getMarkerSets: () => this.comparisonModule.getUI('genesPanel').getMarkerGeneSets(),
      expressionMatrices: this.dataLayer.getExpressionMatrices()
    };
  }

  _getRunBlocker(options) {
    if (options.groupBy === '') return 'Choose the field to group the cells by';
    const requested = options.geneSets.flatMap(set => set.genes);
    if (requested.length === 0) return 'Add the genes to plot';
    this._geneIndex ??= createGeneIndex(this._geneNames());
    // Another matrix's genes are read when it runs: its "not found" chip
    // names those it lacks.
    if (options.matrix === 'mapped' && resolveGenes(requested, this._geneIndex).resolved.length === 0) {
      return 'None of the genes is in this dataset';
    }
    if (options.groups.mode === 'subset' && options.groups.ids.length === 0) {
      return 'Choose at least one group';
    }
    return null;
  }

  _refreshOptionsContext() {
    this._geneIndex = null;
    super._refreshOptionsContext();
  }

  _isDisplayOption(key) {
    return DOTPLOT_DISPLAY_OPTIONS.includes(key);
  }

  _rebuildForDisplay(options) {
    const result = this._lastResult;
    return result
      ? { ...result, data: dotplotPlotData(result.summary, options, this._cellSizePx(result.summary), this._previewHeight(result.summary, options.swapAxes)) }
      : null;
  }

  /** The preview's height: every row legible; the frame scrolls itself beyond. */
  _previewHeight(summary, swap) {
    const rows = swap ? summary.genes.length : summary.groups.length;
    return Math.max(220, Math.min(rows * 22 + 140, 640));
  }

  /** The room one row gets in the preview: its height over the rows. */
  _cellSizePx(summary) {
    const width = this._resultContainer?.clientWidth || 300;
    const across = summary.genes.length;
    const down = summary.groups.length;
    return Math.max(6, Math.min(width * 0.75 / Math.max(1, across), 240 / Math.max(1, down) + 8));
  }

  _scopeMask(cells, cellCount) {
    if (cells === 'all') return null;
    if (cells === 'visible') return this.dataLayer.getVisibleCellMask();
    if (!cells.startsWith('page:')) throw new RangeError(`Unknown cell scope "${cells}"`);
    const mask = new Uint8Array(cellCount);
    for (const index of this.dataLayer.getCellIndicesForPage(cells.slice('page:'.length))) mask[index] = 1;
    return mask;
  }

  async _runAnalysisImpl(options, requestId, job) {
    const signal = job.signal;
    // Genes: each set's genes as the dataset names them, in order; a gene in
    // two sets is a column in each, as in scanpy.
    this._geneIndex ??= createGeneIndex(this._geneNames());
    // Another matrix's genes, named on its own axis (raw has its own).
    const geneIndex = options.matrix === 'mapped'
      ? this._geneIndex
      : createGeneIndex(await this.dataLayer.getGeneKeys(options.matrix));
    if (!this._isCurrentAnalysisRequest(requestId)) return null;
    const genes = [];
    const geneSets = [];
    const unmatched = [];
    for (const set of options.geneSets) {
      const resolution = resolveGenes(set.genes, geneIndex);
      unmatched.push(...resolution.unmatched, ...resolution.ambiguous.map(entry => entry.requested));
      if (resolution.resolved.length === 0) continue;
      geneSets.push({ name: set.name, start: genes.length, end: genes.length + resolution.resolved.length });
      genes.push(...resolution.resolved);
    }
    const uniqueGenes = [...new Set(genes)];
    if (uniqueGenes.length === 0) {
      throw new Error(`None of the genes is in ${this.dataLayer.resolveExpressionMatrix(options.matrix).label}`);
    }
    job.setPlan(`Reads ${formatCount(uniqueGenes.length)} ${uniqueGenes.length === 1 ? 'gene' : 'genes'}`);

    job.step('Grouping cells');
    const field = await this.dataLayer.ensureObsFieldLoaded(options.groupBy, { signal });
    if (!this._isCurrentAnalysisRequest(requestId)) return null;
    const categories = field.categories.map(String);
    const shown = options.groups.mode === 'subset' ? new Set(options.groups.ids) : null;
    const groupOfCode = new Int32Array(Math.max(1, categories.length)).fill(-1);
    const groups = [];
    categories.forEach((name, code) => {
      if (shown !== null && !shown.has(name)) return;
      groupOfCode[code] = groups.length;
      groups.push(name);
    });
    const cellCount = field.codes.length;
    const scope = this._scopeMask(options.cells, cellCount);
    const cellGroup = groups.length <= 0x7fff ? new Int16Array(cellCount) : new Int32Array(cellCount);
    const missing = missingCategoryCode(field.codes);
    for (let cell = 0; cell < cellCount; cell++) {
      const code = field.codes[cell];
      cellGroup[cell] = (scope !== null && scope[cell] === 0) || code === missing || code >= groupOfCode.length
        ? -1
        : groupOfCode[code];
    }
    const sizes = new Array(groups.length).fill(0);
    for (const group of cellGroup) if (group >= 0) sizes[group] += 1;
    // Groups with no cell in scope are left out of the plot.
    if (sizes.every(size => size === 0)) throw new Error('No cells of the chosen groups are in the chosen cells');

    const computeManager = getComputeManager();
    const contextId = `group-summary-${++groupSummaryRun}`;
    await computeManager.broadcast(
      OperationType.GROUP_SUMMARY_SET_CONTEXT,
      () => ({ contextId, cellGroup: cellGroup.slice(), groupCount: groups.length }),
      { timeout: 120000, signal, retainAs: contextId }
    );
    const geneSums = new Map();
    try {
      job.step('Reading genes');
      const tuner = createRunTuner({
        poolSize: analysisWorkerCount(),
        cellCount,
        link: () => this.dataLayer.linkMeasurement()
      });
      let next = 0;
      let done = 0;
      const lane = async () => {
        while (next < uniqueGenes.length) {
          const gene = uniqueGenes[next++];
          const readAt = performance.now();
          const { values, owned } = await this.dataLayer.readGeneColumn(gene, { signal, owner: job.id, matrix: options.matrix });
          tuner.observeRead({ bytes: sampleBytes(values), ms: performance.now() - readAt });
          if (!this._isCurrentAnalysisRequest(requestId)) return;
          tuner.taskStarted();
          const taskAt = performance.now();
          const summary = await computeManager.execute(
            OperationType.GROUP_SUMMARY_COMPUTE_GENES,
            { contextId, genes: [values], cutoff: options.cutoff, bins: VIOLIN_BINS },
            // A gene the view holds is shared: copied. One read for this run is moved.
            { transfer: owned, signal, timeout: 120000 }
          );
          tuner.observeTask({ ms: performance.now() - taskAt });
          geneSums.set(gene, summary);
          done += 1;
          job.items(done, uniqueGenes.length, 'genes');
        }
      };
      const lanes = Math.max(1, Math.min(uniqueGenes.length, tuner.prefetchDepth()));
      await Promise.all(Array.from({ length: lanes }, lane));
    } finally {
      await computeManager.broadcast(
        OperationType.GROUP_SUMMARY_CLEAR_CONTEXT,
        () => ({ contextId }),
        { releases: contextId }
      );
    }
    if (!this._isCurrentAnalysisRequest(requestId)) return null;

    // Gene-major sums over the plot's genes (a gene in two sets twice).
    const groupCount = groups.length;
    const sum = new Float64Array(genes.length * groupCount);
    const expressing = new Uint32Array(genes.length * groupCount);
    const sumExpressing = new Float64Array(genes.length * groupCount);
    genes.forEach((gene, row) => {
      const part = geneSums.get(gene);
      sum.set(part.sum, row * groupCount);
      expressing.set(part.expressing, row * groupCount);
      sumExpressing.set(part.sumExpressing, row * groupCount);
    });
    // Leave out the groups with no cells in scope.
    const keep = groups.map((_, index) => index).filter(index => sizes[index] > 0);
    const pick = (array, Type) => {
      const out = new Type(genes.length * keep.length);
      for (let gene = 0; gene < genes.length; gene++) {
        keep.forEach((group, position) => { out[gene * keep.length + position] = array[gene * groupCount + group]; });
      }
      return out;
    };
    const histogram = new Uint32Array(genes.length * keep.length * VIOLIN_BINS);
    const range = new Float64Array(genes.length * 2);
    genes.forEach((gene, row) => {
      const part = geneSums.get(gene);
      range.set(part.range, row * 2);
      keep.forEach((group, position) => {
        histogram.set(
          part.histogram.subarray(group * VIOLIN_BINS, (group + 1) * VIOLIN_BINS),
          (row * keep.length + position) * VIOLIN_BINS
        );
      });
    });
    const summary = {
      groupBy: options.groupBy,
      matrix: options.matrix,
      matrixLabel: this.dataLayer.resolveExpressionMatrix(options.matrix).label,
      bins: VIOLIN_BINS,
      range,
      histogram,
      cells: options.cells,
      cutoff: options.cutoff,
      genes,
      geneSets,
      groups: keep.map(index => groups[index]),
      sizes: keep.map(index => sizes[index]),
      sum: pick(sum, Float64Array),
      expressing: pick(expressing, Uint32Array),
      sumExpressing: pick(sumExpressing, Float64Array),
      unmatched: [...new Set(unmatched)]
    };
    return {
      type: 'dotplot',
      plotType: 'dotplot',
      title: 'Dot plot',
      subtitle: `${formatCount(genes.length)} genes by ${options.groupBy}`,
      options: {},
      data: dotplotPlotData(summary, options, this._cellSizePx(summary), this._previewHeight(summary, options.swapAxes)),
      summary
    };
  }

  _getSuccessMessage(result = this._lastResult) {
    const summary = result?.summary;
    return summary
      ? `Dot plot: ${formatCount(summary.genes.length)} genes in ${formatCount(summary.groups.length)} groups`
      : 'Dot plot complete';
  }

  async _showResult(result, requestId) {
    const rendered = await this._renderPreviewPlot({
      result,
      requestId,
      containerId: this._plotContainerIdBase,
      expandable: true,
      height: this._previewHeight(result.summary, result.data.swap)
    });
    if (rendered === null || !this._isCurrentAnalysisRequest(requestId)) return rendered;
    const summary = result.summary;
    const container = this._resultContainer;
    container.querySelector(':scope > .analysis-result-header')?.remove();
    const header = document.createElement('div');
    header.className = 'analysis-result-header';
    const line = document.createElement('p');
    line.className = 'analysis-result-line';
    line.textContent = [
      `${formatCount(summary.genes.length)} genes`,
      `${formatCount(summary.groups.length)} groups of ${summary.groupBy}`,
      `${formatCount(summary.sizes.reduce((total, size) => total + size, 0))} cells`
    ].join(' · ');
    header.appendChild(line);
    if (summary.unmatched.length > 0) {
      const row = document.createElement('div');
      row.className = 'analysis-chip-row';
      const chip = document.createElement('span');
      chip.className = 'analysis-chip analysis-chip-warning';
      chip.textContent = `${formatCount(summary.unmatched.length)} not found`;
      chip.title = `Not in this dataset, left out: ${summary.unmatched.join(', ')}`;
      row.appendChild(chip);
      header.appendChild(row);
    }
    container.prepend(header);
    return rendered;
  }

  /** The expanded view draws at its own size: dots scale to its cells. */
  async _renderModalPlot(container, context = {}) {
    const result = context.result ?? this._lastResult;
    const { genes, groups } = result.summary;
    const across = result.data.swap ? groups.length : genes.length;
    const down = result.data.swap ? genes.length : groups.length;
    const room = Math.min(
      (container.clientWidth || 800) * 0.8 / Math.max(1, across),
      (container.clientHeight || 500) * 0.8 / Math.max(1, down)
    );
    return super._renderModalPlot(container, {
      ...context,
      result: { ...result, data: { ...result.data, cellSizePx: room, plotHeightPx: container.clientHeight || 500 } }
    });
  }

  _renderModalStats(container) {
    const summary = this._lastResult?.summary;
    if (!summary) return;
    const rows = [
      ['Group by', summary.groupBy],
      ['Groups', formatCount(summary.groups.length)],
      ['Genes', formatCount(summary.genes.length)],
      ['Expression matrix', summary.matrixLabel],
      ['Cells', formatCount(summary.sizes.reduce((total, size) => total + size, 0))],
      ['Expressed above', String(summary.cutoff)]
    ];
    if (summary.unmatched.length > 0) rows.push(['Not found', summary.unmatched.join(', ')]);
    container.innerHTML = `<table class="analysis-stats-table">${rows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td><strong>${escapeHtml(value)}</strong></td></tr>`).join('')}</table>`;
  }

  _renderModalAnnotations(container) {
    container.innerHTML = '<p class="empty-state">Dot color: mean expression in the group. Dot size: share of the group\'s cells expressing the gene.</p>';
  }

  _exportModalCSV() {
    const result = this._lastResult;
    if (!result) return;
    // The long table, unscaled: one row per group and gene.
    const data = dotplotPlotData(result.summary, { ...this._requireOptions(), scale: 'none', meanOnlyExpressing: false, groupOrder: 'field' }, 1);
    const csv = PlotRegistry.get('dotplot').exportCSV(data);
    const cell = value => {
      const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : 'NA') : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [csv.columns.join(','), ...csv.rows.map(row => csv.columns.map(column => cell(row[column])).join(','))];
    downloadCSV(lines.join('\n'), 'dot_plot', this._notifications);
  }

  /** "Score as signature": the plotted genes, one signature per gene set. */
  async scoreAsSignature() {
    const summary = this._lastResult?.summary;
    if (!summary) return;
    await this.comparisonModule.openAnalysis('signature', {
      options: {
        geneSets: summary.geneSets.map(set => ({ name: set.name, genes: summary.genes.slice(set.start, set.end) }))
      }
    });
  }

  _renderPreviewExpandAction() {
    const expand = super._renderPreviewExpandAction();
    const score = document.createElement('button');
    score.type = 'button';
    score.className = 'analysis-link-btn';
    score.textContent = 'Score as signature';
    score.addEventListener('click', () => this._trackInteractiveTask(this.scoreAsSignature(), 'Score as signature'));
    expand.parentElement.appendChild(score);
    return expand;
  }

  // ---------------------------------------------------------------- Sessions

  exportResult() {
    if (this._lastResult === null || this._lastResult === undefined) return null;
    return createResultEnvelope('dotplot', this._lastResult);
  }

  async importResult(envelope) {
    if (envelope === null) {
      await this._discardFormResult();
      return;
    }
    const result = readResultEnvelope(envelope, 'dotplot');
    const summary = result?.summary;
    if (
      result?.type !== 'dotplot' ||
      result.plotType !== 'dotplot' ||
      summary === null || typeof summary !== 'object' ||
      !(summary.sum instanceof Float64Array) ||
      !(summary.expressing instanceof Uint32Array) ||
      !(summary.histogram instanceof Uint32Array) ||
      !Array.isArray(summary.genes) ||
      typeof summary.matrix !== 'string' || typeof summary.matrixLabel !== 'string'
    ) {
      throw new TypeError('A dot plot result must hold its per-group sums and expression matrix');
    }
    await requireDatasetGenes(this.dataLayer, summary.genes, 'The dot plot result', summary.matrix);
    if (this.dataLayer.getVariableInfo('categorical_obs', summary.groupBy) === null) {
      throw new Error(`The dot plot result groups by "${summary.groupBy}", which this dataset lacks`);
    }
    await this._restoreAnalysisResult(result);
  }
}

export function createDotplotUI(options) {
  const ui = new DotplotUI(options);
  ui.init(options.container);
  return ui;
}
