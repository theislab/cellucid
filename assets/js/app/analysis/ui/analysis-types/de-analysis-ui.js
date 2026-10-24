/**
 * Differential expression: every gene compared between two groups of cells.
 *
 * The form is the DE options schema's (`options/de-options.js`): Compare
 * (pages, or categories of a field), Group A and Group B with a swap, Run;
 * cells, test, filters and labels under More options. Groups are resolved
 * to cells here (a "rest of" page, categories, within a scope), then tested
 * (`MultiVariableAnalysis.differentialExpression`). A group smaller than
 * the minimum runs and is flagged low n; overlapping groups disable Run with
 * the reason. Filters and labels re-draw the volcano without testing again.
 *
 * @module analysis-types/de-analysis-ui
 */

import { formatCount } from '../../../ui/components/display-format.js';
import { FormBasedAnalysisUI } from './base/form-based-analysis.js';
import { PlotRegistry } from '../../shared/plot-registry-utils.js';
import { downloadCSV } from '../../shared/analysis-utils.js';
import { toCSVCell } from '../../compute/csv-export.js';
import { isFiniteNumber } from '../../shared/number-utils.js';
import { expandPagesWithDerived } from '../../shared/page-derivation-utils.js';
import { DE_DISPLAY_KEYS, DE_OPTIONS } from '../../options/de-options.js';
import { defineOptions } from '../../options/option-schema.js';
import { renderOptionsForm } from '../../options/render-options-form.js';
import { GenesPanelController, categoryOptionId } from '../../genes-panel/genes-panel-controller.js';
import { countGeneFamilies } from '../../shared/gene-sets.js';
import { pseudobulkUnits } from '../../stats/pseudobulk.js';
import { missingCategoryCode } from '../../../../data/categorical-storage-contract.js';
import {
  createResultEnvelope,
  readResultEnvelope,
  requireDatasetGenes
} from '../../shared/analysis-result-session.js';

/** The Wilcoxon p-value conventions as the form names them. */
const P_CONVENTION_NAMES = Object.freeze(Object.fromEntries(
  DE_OPTIONS.entry('pConvention').choices.map(choice => [choice.value, choice.label])
));

const METHOD_NAMES = Object.freeze({
  wilcox: 'Wilcoxon',
  ttest: 't-test',
  ttest_overestim_var: 't-test (overestimated variance)',
  pseudobulk: 'Pseudobulk t-test'
});

/** The volcano's filters and labels, for the expanded view. */
const DISPLAY_OPTIONS = defineOptions({
  id: 'differentialDisplay',
  groups: [],
  options: DE_OPTIONS.entries
    .filter(entry => DE_DISPLAY_KEYS.includes(entry.key))
    .map(entry => ({ ...entry, group: 'essentials' }))
});

export class DEAnalysisUI extends FormBasedAnalysisUI {
  static getRequirements() {
    return {
      // DE chooses its own two groups.
      minPages: 0,
      maxPages: null,
      description: 'Select pages to compare',
      geneExpression: true
    };
  }

  constructor(options) {
    super(options);
    this._plotContainerIdBase = this._instanceId ? `${this._instanceId}-de-analysis-plot` : 'de-analysis-plot';
    /** Category groups of the fields A/B and Within read (by field). */
    this._fieldGroups = new Map();
    this._pendingFields = new Set();
    this._helper = null;
    this._familyCounts = null;
  }

  _getTitle() {
    return 'Differential expression';
  }

  _getClassName() {
    return 'de-analysis';
  }

  _getSuccessMessage(result) {
    const summary = result?.data?.summary;
    if (!summary) return 'Differential expression complete';
    const significant = this._significantCount(result.data.results, this._options);
    const low = summary.lowN.length > 0 ? ` (low n: ${summary.lowN.join(', ')})` : '';
    return `Differential expression: ${formatCount(significant)} significant genes${low}`;
  }

  // ===========================================================================
  // Options
  // ===========================================================================

  _getOptionsSchema() {
    return DE_OPTIONS;
  }

  _helperController() {
    this._helper ??= new GenesPanelController({ dataLayer: this.dataLayer });
    return this._helper;
  }

  _pageChoices() {
    const pages = this.dataLayer.getPages();
    return expandPagesWithDerived(pages, { includeRestOf: true })
      .filter(page => this.dataLayer.getCellCountForPageId(page.id) > 0)
      .map(page => ({ id: page.id, name: page.name }));
  }

  _groupsOfField(field) {
    if (!field) return [];
    const described = this._fieldGroups.get(field);
    if (described !== undefined) return described.groups;
    if (!this._pendingFields.has(field)) {
      this._pendingFields.add(field);
      void this._helperController().describeGroups(field, null).then(value => {
        this._pendingFields.delete(field);
        if (this._isDestroyed) return;
        this._fieldGroups.set(field, value);
        this._refreshOptionsContext();
      }, error => {
        this._pendingFields.delete(field);
        this._notifications.error(`Differential expression groups: ${error.message}`, { category: 'analysis' });
      });
    }
    return [];
  }

  _getOptionsContext() {
    const genes = this.dataLayer.getAvailableVariables('gene_expression');
    if (this._familyCounts?.of !== genes) {
      this._familyCounts = { of: genes, counts: countGeneFamilies(genes.map(gene => gene.key)) };
    }
    return {
      pages: this._pageChoices(),
      categoricalFields: this.dataLayer.getAvailableVariables('categorical_obs')
        .filter(variable => (variable.categoryCount ?? variable.categories?.length ?? 2) >= 2)
        .map(variable => ({ key: variable.key })),
      groupsFor: (entry, record) => this._groupsOfField(entry.key === 'withinCategories' ? record.withinField : record.field)
        .map(group => ({ id: group.optionId, name: String(group.groupName), count: group.count, color: group.color })),
      minCellsFor: () => null,
      geneFamilyCounts: this._familyCounts.counts,
      hasHighlyVariable: this._highlyVariableAvailable(),
      expressionMatrices: this.dataLayer.getExpressionMatrices()
    };
  }

  _isDisplayOption(key) {
    return DE_DISPLAY_KEYS.includes(key);
  }

  _getRunNoun() {
    return 'differential expression';
  }

  /** The cells "Within" keeps (null: every cell), or null when not ready. */
  _withinMask(options) {
    if (options.within === 'all') return null;
    if (options.within === 'category') {
      const described = this._fieldGroups.get(options.withinField);
      if (described === undefined) return undefined;
      const keep = options.withinCategories.mode === 'all'
        ? null
        : new Set(options.withinCategories.ids);
      const allowed = new Uint8Array(described.categories.length);
      described.categories.forEach((label, code) => {
        if (keep === null || keep.has(categoryOptionId(label))) allowed[code] = 1;
      });
      const mask = new Uint8Array(described.codes.length);
      for (let cell = 0; cell < mask.length; cell++) {
        const code = described.codes[cell];
        mask[cell] = code < allowed.length ? allowed[code] : 0;
      }
      return mask;
    }
    return this._helperController().scopeOf(options.within);
  }

  /** The two groups' cells, or the reason they cannot be compared. */
  _resolveGroups(options) {
    const within = this._withinMask(options);
    if (within === undefined) return { reason: 'Reading the categories…' };
    let a;
    let b;
    if (options.compare === 'pages') {
      if (!options.pageA || !options.pageB) return { reason: 'Choose two pages' };
      if (options.pageA === options.pageB) return { reason: 'Group A and Group B are the same page' };
      const mva = this.multiVariableAnalysis;
      a = mva.pageGroup(options.pageA, within);
      b = mva.pageGroup(options.pageB, within);
    } else {
      const described = this._fieldGroups.get(options.field);
      if (described === undefined) {
        this._groupsOfField(options.field);
        return { reason: 'Reading the categories…' };
      }
      const idsA = new Set(options.categoriesA.mode === 'all' ? described.groups.map(g => g.optionId) : options.categoriesA.ids);
      const idsB = new Set(options.categoriesB.mode === 'all' ? described.groups.map(g => g.optionId) : options.categoriesB.ids);
      if (idsA.size === 0 || idsB.size === 0) return { reason: 'Choose categories for Group A and Group B' };
      const shared = [...idsA].filter(id => idsB.has(id));
      if (shared.length > 0) return { reason: `A category is in both groups: ${shared.join(', ')}` };
      const codesOf = ids => {
        const keep = new Uint8Array(described.categories.length);
        described.categories.forEach((label, code) => { if (ids.has(categoryOptionId(label))) keep[code] = 1; });
        return keep;
      };
      const keepA = codesOf(idsA);
      const keepB = codesOf(idsB);
      const cellsOf = keep => {
        const out = [];
        for (let cell = 0; cell < described.codes.length; cell++) {
          const code = described.codes[cell];
          if (code < keep.length && keep[code] === 1 && (within === null || within[cell] !== 0)) out.push(cell);
        }
        return Uint32Array.from(out);
      };
      const nameOf = ids => [...ids].join(' + ');
      a = { name: nameOf(idsA), cells: cellsOf(keepA) };
      b = { name: nameOf(idsB), cells: cellsOf(keepB) };
    }
    let overlap = 0;
    for (let i = 0, j = 0; i < a.cells.length && j < b.cells.length;) {
      if (a.cells[i] === b.cells[j]) { overlap++; i++; j++; } else if (a.cells[i] < b.cells[j]) i++; else j++;
    }
    if (overlap > 0) return { reason: `The groups share ${formatCount(overlap)} cells` };
    if (a.cells.length < 2 || b.cells.length < 2) return { reason: 'Each group needs at least 2 cells' };
    return { a, b };
  }

  _getRunBlocker(options) {
    const resolved = this._resolveGroups(options);
    if (resolved.reason) return resolved.reason;
    if (options.replicates === '') return null;
    const replicates = this._replicatesOf(options);
    if (replicates === null) return 'Reading the samples…';
    const units = pseudobulkUnits(resolved.a.cells, resolved.b.cells, replicates.codes, replicates.missingCode, this.dataLayer.state.pointCount);
    return units.unitsA < 2 || units.unitsB < 2
      ? `Each group needs cells in at least 2 samples of ${options.replicates}`
      : null;
  }

  /** The sample field of a pseudobulk run, or null while it is read. */
  _replicatesOf(options) {
    this._groupsOfField(options.replicates);
    const described = this._fieldGroups.get(options.replicates);
    if (described === undefined) return null;
    return { name: options.replicates, codes: described.codes, missingCode: missingCategoryCode(described.codes) };
  }

  /** A swap beside Group A and Group B. */
  _decorateOptionsForm(form) {
    const essentials = form.essentials;
    const swap = document.createElement('button');
    swap.type = 'button';
    swap.className = 'analysis-link-btn de-swap';
    swap.textContent = 'Swap A and B';
    swap.addEventListener('click', () => {
      const options = this._options;
      this._setOptions(options.compare === 'pages'
        ? { ...options, pageA: options.pageB, pageB: options.pageA }
        : { ...options, categoriesA: options.categoriesB, categoriesB: options.categoriesA });
    });
    essentials.appendChild(swap);
  }

  // ===========================================================================
  // Run
  // ===========================================================================

  async _runAnalysisImpl(options, requestId, job) {
    const resolved = this._resolveGroups(options);
    if (resolved.reason) throw new Error(resolved.reason);
    const helper = this._helperController();
    const genes = await helper.genesToTest(options);
    const deResults = await this.multiVariableAnalysis.differentialExpression({
      groupA: resolved.a,
      groupB: resolved.b,
      geneList: genes,
      method: options.method,
      pConvention: options.method === 'wilcox' ? options.pConvention : 'exact',
      correction: options.correction,
      foldChange: helper.foldChangeOf(options.foldChange, options.matrix),
      matrix: options.matrix,
      replicates: options.replicates === '' ? null : this._replicatesOf(options),
      minCells: options.minCells,
      job,
      isCurrent: () => this._isCurrentAnalysisRequest(requestId),
      registerInvalidationCleanup: cleanup => this._registerAnalysisInvalidationCleanup(requestId, cleanup)
    });
    if (deResults === null || !this._isCurrentAnalysisRequest(requestId)) return null;
    return this._buildResult(deResults, options);
  }

  /** The drawn result: the volcano over the genes passing the % filter. */
  _buildResult(deResults, options) {
    const drawn = options.minPct > 0
      ? {
          ...deResults,
          results: deResults.results.filter(row => Math.max(row.pctA ?? 0, row.pctB ?? 0) >= options.minPct)
        }
      : deResults;
    return {
      type: 'differential',
      plotType: 'volcanoplot',
      data: drawn,
      full: deResults,
      options: {
        pValueThreshold: options.maxAdjP,
        foldChangeThreshold: options.minLog2FC,
        useAdjustedPValue: true,
        labelTopN: options.labels
      },
      title: 'Differential expression',
      subtitle: `${deResults.summary.groupAName} vs ${deResults.summary.groupBName}`
    };
  }

  _rebuildForDisplay(options) {
    const full = this._lastResult?.full;
    return full ? this._buildResult(full, options) : null;
  }

  _significantCount(results, options) {
    let count = 0;
    for (const row of results ?? []) {
      const p = row.adjustedPValue;
      if (!isFiniteNumber(p) || !isFiniteNumber(row.log2FoldChange)) continue;
      if (p <= options.maxAdjP && Math.abs(row.log2FoldChange) >= options.minLog2FC &&
          Math.max(row.pctA ?? 0, row.pctB ?? 0) >= options.minPct) count++;
    }
    return count;
  }

  // ===========================================================================
  // Result view
  // ===========================================================================

  async _showResult(result, requestId) {
    const rendered = await this._renderPreviewPlot({
      result,
      requestId,
      containerId: this._plotContainerIdBase,
      expandable: true
    });
    if (rendered !== null && this._isCurrentAnalysisRequest(requestId)) {
      const container = this._resultContainer;
      container.querySelector(':scope > .analysis-result-header')?.remove();
      const summary = result.full.summary;
      const header = document.createElement('div');
      header.className = 'analysis-result-header';
      const line = document.createElement('p');
      line.className = 'analysis-result-line';
      line.textContent = [
        `${summary.groupAName} (${formatCount(summary.groupASize)}) vs ${summary.groupBName} (${formatCount(summary.groupBSize)})`,
        METHOD_NAMES[summary.method],
        `${formatCount(summary.genesTested)} genes`,
        ...(summary.matrix === 'mapped' ? [] : [summary.matrixLabel])
      ].join(' · ');
      header.appendChild(line);
      if (summary.lowN.length > 0) {
        const chip = document.createElement('span');
        chip.className = 'analysis-chip analysis-chip-warning';
        chip.textContent = 'low n';
        chip.title = `Fewer than ${formatCount(summary.minCells)} cells: ${summary.lowN.join(', ')}`;
        const chips = document.createElement('div');
        chips.className = 'analysis-result-chips';
        chips.appendChild(chip);
        header.appendChild(chips);
      }
      container.prepend(header);
    }
    return rendered;
  }

  _renderModalOptions(container) {
    super._renderModalOptions(container);
    if (this._options === null) return;
    const form = renderOptionsForm({
      schema: DISPLAY_OPTIONS,
      value: Object.fromEntries(DE_DISPLAY_KEYS.map(key => [key, this._options[key]])),
      context: {},
      onChange: (record, key) => {
        this._options = { ...this._options, ...record };
        this._optionsForm?.setValue(this._options);
        this._handleOptionsChanged(key);
      }
    });
    container.prepend(form.root);
  }

  _renderModalStats(container) {
    const result = this._lastResult;
    const summary = result?.full?.summary;
    if (!summary) {
      container.innerHTML = '<p class="empty-state">Statistics not available</p>';
      return;
    }
    const options = this._options;
    let up = 0;
    let down = 0;
    for (const row of result.data.results) {
      const p = row.adjustedPValue;
      if (!isFiniteNumber(p) || !isFiniteNumber(row.log2FoldChange)) continue;
      if (p <= options.maxAdjP && Math.abs(row.log2FoldChange) >= options.minLog2FC) {
        if (row.log2FoldChange > 0) up++;
        else down++;
      }
    }
    const rows = [
      ['Genes tested', formatCount(summary.genesTested)],
      [
        summary.replicates === null ? 'Not tested (fewer than 2 cells with a value)' : 'Not tested (fewer than 2 samples with a value)',
        formatCount(summary.genesUntestable)
      ],
      ...(summary.replicates === null ? [] : [[
        'Replicates',
        `${summary.replicates.field}: ${formatCount(summary.replicates.samplesA)} vs ${formatCount(summary.replicates.samplesB)} samples`
      ]]),
      [`Significant (adj p ≤ ${options.maxAdjP}, |log2FC| ≥ ${options.minLog2FC})`, formatCount(up + down)],
      ['Up in A', formatCount(up)],
      ['Down in A', formatCount(down)],
      ...(summary.method === 'wilcox' ? [['p-values', P_CONVENTION_NAMES[summary.pConvention]]] : []),
      ['Multiple testing', summary.correction === 'bh' ? 'Benjamini–Hochberg' : 'Bonferroni'],
      ['Expression matrix', summary.matrixLabel],
      ['Fold change', summary.foldChange.mode === 'log1p' ? 'Undo log1p' : 'As stored']
    ];
    const table = document.createElement('table');
    table.className = 'analysis-stats-table de-modal-stats';
    for (const [label, value] of rows) {
      const tr = document.createElement('tr');
      const a = document.createElement('td');
      a.textContent = label;
      const b = document.createElement('td');
      b.textContent = value;
      tr.append(a, b);
      table.appendChild(tr);
    }
    container.replaceChildren(table);
  }

  _renderModalAnnotations(container) {
    const result = this._lastResult;
    const results = result?.data?.results ?? [];
    const options = this._options;
    const significant = results
      .filter(row => isFiniteNumber(row.adjustedPValue) && row.adjustedPValue <= options.maxAdjP &&
        isFiniteNumber(row.log2FoldChange) && Math.abs(row.log2FoldChange) >= options.minLog2FC)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    container.innerHTML = '';
    if (significant.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = `No genes pass the filters (adj p ≤ ${options.maxAdjP}, |log2FC| ≥ ${options.minLog2FC}).`;
      container.appendChild(empty);
      return;
    }
    const table = document.createElement('table');
    table.className = 'de-genes-table modal-de-genes';
    table.innerHTML = '<thead><tr><th>Gene</th><th>Score</th><th>log2FC</th><th>adj p</th><th>% A</th><th>% B</th></tr></thead>';
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    container.appendChild(table);
    const fixed = (value, digits) => (isFiniteNumber(value) ? value.toFixed(digits) : '—');
    this._renderTableRows(tbody, significant, row => {
      const tr = document.createElement('tr');
      tr.className = row.log2FoldChange > 0 ? 'up' : 'down';
      const name = document.createElement('td');
      name.appendChild(this._createGeneButton(row.gene));
      tr.appendChild(name);
      for (const text of [
        fixed(row.score, 2),
        fixed(row.log2FoldChange, 2),
        isFiniteNumber(row.adjustedPValue) ? row.adjustedPValue.toExponential(2) : '—',
        fixed(row.pctA, 0),
        fixed(row.pctB, 0)
      ]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      return tr;
    }, { chunked: significant.length > 500 });
  }

  /** Every gene: scanpy's column names, the two groups' fractions and AUROC. */
  _exportModalCSV() {
    const full = this._lastResult?.full;
    if (!full) return;
    const lines = ['names,scores,logfoldchanges,pvals,pvals_adj,pct_nz_group,pct_nz_reference,auroc,mean_a,mean_b,n_a,n_b'];
    for (const row of full.results) {
      lines.push([
        toCSVCell(row.gene),
        toCSVCell(row.score),
        toCSVCell(row.log2FoldChange),
        toCSVCell(row.pValue),
        toCSVCell(row.adjustedPValue),
        toCSVCell(Number.isFinite(row.pctA) ? row.pctA / 100 : NaN),
        toCSVCell(Number.isFinite(row.pctB) ? row.pctB / 100 : NaN),
        toCSVCell(row.auroc),
        toCSVCell(row.meanA),
        toCSVCell(row.meanB),
        row.nA,
        row.nB
      ].join(','));
    }
    downloadCSV(lines.join('\n'), 'differential_expression', this._notifications);
  }

  // ===========================================================================
  // Sessions
  // ===========================================================================

  exportResult() {
    const full = this._lastResult?.full;
    if (!full) return null;
    const { tuning: _tuning, ...metadata } = full.metadata;
    return createResultEnvelope('differential', { ...full, metadata });
  }

  async importResult(envelope) {
    if (envelope === null) {
      await this._discardFormResult();
      return;
    }
    const full = readResultEnvelope(envelope, 'differential');
    if (
      !Array.isArray(full?.results) || typeof full.summary !== 'object' || full.summary === null ||
      typeof full.summary.matrix !== 'string' || typeof full.summary.matrixLabel !== 'string' ||
      full.summary.replicates === undefined
    ) {
      throw new TypeError('A differential expression result must hold its gene table, summary and expression matrix');
    }
    await requireDatasetGenes(
      this.dataLayer, full.results.map(row => row?.gene), 'The differential expression result', full.summary.matrix
    );
    await this._restoreAnalysisResult(this._buildResult(full, this._requireOptions()));
  }

  destroy() {
    const helper = this._helper;
    this._helper = null;
    if (helper !== null) this._registerFormDestroyTask(helper.close());
    return super.destroy();
  }
}

/**
 * Factory function to create the DE analysis UI
 * @param {Object} options
 * @returns {DEAnalysisUI}
 */
export function createDEAnalysisUI(options) {
  const ui = new DEAnalysisUI(options);
  ui.init(options.container);
  return ui;
}

