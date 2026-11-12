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

import { PLACES, placePath } from '../../../ui/place-names.js';
import { countNoun, formatCount, formatCountOf, formatPercent, formatPValue } from '../../../../utils/format-units.js';
import { FormBasedAnalysisUI } from './base/form-based-analysis.js';
import { PlotRegistry } from '../../shared/plot-registry-utils.js';
import { geneNameColumns, toCSVCell } from '../../compute/csv-export.js';
import { isFiniteNumber } from '../../shared/number-utils.js';
import { expandPagesWithDerived } from '../../shared/page-derivation-utils.js';
import { DE_DISPLAY_KEYS, DE_OPTIONS } from '../../options/de-options.js';
import { GenesPanelController, categoryOptionId } from '../../genes-panel/genes-panel-controller.js';
import { countGeneFamilies, geneIdentities } from '../../shared/gene-sets.js';
import { describePseudobulkModel, describePseudobulkNormalisation, pairedUnits, pseudobulkUnits } from '../../stats/pseudobulk.js';
import { describeValues, geneValueLabel, isValuesRecord, transformWords, RAW_VALUES } from '../../../../data/expression-transform.js';
import { missingCategoryCode } from '../../../../data/categorical-storage-contract.js';
import {
  createResultEnvelope,
  readResultEnvelope,
  requireDatasetGenes
} from '../../shared/analysis-result-session.js';
import { sharedCellCount } from '../../shared/page-overlap.js';
import { failureDetails, joinFailure, sayFailure } from '../../../../utils/errors.js';
import { buttonClassName } from '../../../ui/components/controls.js';

/** The Wilcoxon p-value conventions as the form names them. */
const P_CONVENTION_NAMES = Object.freeze(Object.fromEntries(
  DE_OPTIONS.entry('pConvention').choices.map(choice => [choice.value, choice.label])
));

/** A result's fold change as its Statistics and its `about` say it. */
const FOLD_CHANGE_NAMES = Object.freeze({ log1p: 'Undo log1p', stored: 'As stored', log2cpm: 'Group coefficient of log2-CPM (limma)' });
const FOLD_CHANGE_ABOUT = Object.freeze({
  log1p: 'of the means after undoing log1p',
  // F159: a ratio of means of log-scale values is not an "X-fold" change; the result says so to whoever reads it.
  stored: 'of the means as stored (log2 of their ratio; of log-scale values, such as log1p, a ratio of means is no fold change of expression)',
  log2cpm: 'the group coefficient of the samples\' log2-CPM (limma; paired: within donors)'
});

const METHOD_NAMES = Object.freeze({
  wilcox: 'Wilcoxon',
  ttest: 't-test',
  ttest_overestim_var: 't-test (overestimated variance)',
  pseudobulk: 'Pseudobulk limma'
});


/** A finite number, or null (JSON has no NaN). */
const finiteOrNull = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

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
    /** The reads of a field's categories under way. */
    this._fieldReads = new Set();
    /** Fields whose categories could not be read, with the error. */
    this._fieldGroupFailures = new Map();
    /** The last `_resolveGroups` answer and what it was resolved from. */
    this._resolvedGroups = null;
    /** The last replicates blocker and the groups and samples it counted. */
    this._replicateBlocker = null;
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
    // A field whose categories could not be read is not read again on every
    // redraw (each posted its error): Run says why until the field changes.
    if (!this._pendingFields.has(field) && !this._fieldGroupFailures.has(field)) {
      this._pendingFields.add(field);
      const cells = this._openCells();
      const read = this._helperController().describeGroups(field, null).then(value => {
        // Described for cells no longer open: read again when next asked for.
        if (this._isDestroyed || cells !== this._openCells()) return;
        this._pendingFields.delete(field);
        this._fieldGroups.set(field, value);
        this._refreshOptionsContext();
      }, error => {
        if (this._isDestroyed || cells !== this._openCells()) return;
        this._pendingFields.delete(field);
        this._fieldGroupFailures.set(field, error);
        this._notifications.error(`Differential expression groups: ${sayFailure(error)}`, { ...failureDetails(error), category: 'analysis' });
        this._refreshOptionsContext();
      }).finally(() => this._fieldReads.delete(read));
      this._fieldReads.add(read);
    }
    return [];
  }

  /** @override */
  _runInputsRead() {
    return this._fieldReads.size === 0 ? null : Promise.all(this._fieldReads);
  }

  /**
   * Another set of open cells: every field's categories and codes are read
   * again on them, and the groups resolved again.
   * @override
   */
  _onOpenCellsChanged() {
    this._fieldGroups.clear();
    this._fieldGroupFailures.clear();
    this._pendingFields.clear();
    this._resolvedGroups = null;
    this._replicateBlocker = null;
  }

  /**
   * A changed option is the user's next try: the fields whose categories
   * could not be read are read again when next asked for.
   * @override
   */
  _handleOptionsChanged(key) {
    this._fieldGroupFailures.clear();
    super._handleOptionsChanged(key);
  }

  /** Why Run waits for `field`'s categories: read failed, or still reading. @private */
  _fieldGroupsBlocker(field) {
    const failure = this._fieldGroupFailures.get(field);
    return failure === undefined
      ? 'Reading the categories…'
      : `${joinFailure(`The categories of ${field} could not be read`, sayFailure(failure))}`;
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
        .map(variable => ({ key: variable.key, categoryCount: variable.categoryCount ?? variable.categories?.length ?? null })),
      colorField: this.dataLayer.getColoringCategoricalField(),
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

  /**
   * The two groups' cells, or the reason they cannot be compared.
   *
   * Resolving is a pass over every cell, and Run's state asks for it on every
   * option, highlight and page change: the answer is kept while the options
   * that choose the groups, the highlights and the fields they read are the
   * same.
   */
  _resolveGroups(options) {
    const key = JSON.stringify([
      options.compare, options.pageA, options.pageB, options.field,
      options.categoriesA, options.categoriesB,
      options.within, options.withinField, options.withinCategories,
      this._highlightRevision,
      options.within === 'visible' ? this._visibleCellsRevision() : null,
    ]);
    // What the fields it reads hold: their categories, or why they have none.
    const field = this._fieldGroups.get(options.field) ?? this._fieldGroupFailures.get(options.field);
    const withinField = this._fieldGroups.get(options.withinField) ?? this._fieldGroupFailures.get(options.withinField);
    const kept = this._resolvedGroups;
    if (kept !== null && kept.key === key && kept.field === field && kept.withinField === withinField) {
      return kept.resolved;
    }
    const resolved = this._resolveGroupsNow(options);
    this._resolvedGroups = { key, field, withinField, resolved };
    return resolved;
  }

  /** @private */
  _resolveGroupsNow(options) {
    const within = this._withinMask(options);
    if (within === undefined) {
      this._groupsOfField(options.withinField);
      return { reason: this._fieldGroupsBlocker(options.withinField) };
    }
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
        return { reason: this._fieldGroupsBlocker(options.field) };
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
      const { codes } = described;
      // One pass into a typed list as long as the cells, then the group's
      // part of it copied out.
      const cellsOf = keep => {
        const out = new Uint32Array(codes.length);
        const limit = keep.length;
        let count = 0;
        if (within === null) {
          for (let cell = 0; cell < codes.length; cell++) {
            const code = codes[cell];
            if (code < limit && keep[code] === 1) out[count++] = cell;
          }
        } else {
          for (let cell = 0; cell < codes.length; cell++) {
            const code = codes[cell];
            if (code < limit && keep[code] === 1 && within[cell] !== 0) out[count++] = cell;
          }
        }
        return out.slice(0, count);
      };
      const nameOf = ids => [...ids].join(' + ');
      a = { name: nameOf(idsA), cells: cellsOf(keepA) };
      b = { name: nameOf(idsB), cells: cellsOf(keepB) };
    }
    const overlap = sharedCellCount(a.cells, b.cells);
    if (overlap > 0) return { reason: `The groups share ${formatCountOf(overlap, 'cell')}` };
    if (a.cells.length < 2 || b.cells.length < 2) return { reason: 'Each group needs at least 2 cells' };
    return { a, b };
  }

  _getRunBlocker(options) {
    const resolved = this._resolveGroups(options);
    if (resolved.reason) return resolved.reason;
    if (options.replicates === '') return null;
    const replicates = this._replicatesOf(options);
    if (replicates === null) {
      return this._fieldGroupFailures.has(options.replicates)
        ? this._fieldGroupsBlocker(options.replicates)
        : 'Reading the samples…';
    }
    // Counting the samples is a pass over every cell: kept for these groups
    // and this sample field.
    const kept = this._replicateBlocker;
    if (kept?.resolved === resolved && kept.codes === replicates.codes && kept.minimum === replicates.minCellsPerSample && kept.paired === options.paired) return kept.blocker;
    const units = pseudobulkUnits(resolved.a.cells, resolved.b.cells, replicates.codes, replicates.missingCode, this.dataLayer.state.pointCount, replicates.minCellsPerSample);
    const pairs = pairedUnits(units).pairs;
    const blocker = units.unitsA < 2 || units.unitsB < 2
      ? `Each group needs at least 2 samples of ${options.replicates} with ${formatCountOf(replicates.minCellsPerSample, 'cell')} or more`
      : options.paired && pairs < 2
        ? `A paired test needs at least 2 samples of ${options.replicates} with ${formatCountOf(replicates.minCellsPerSample, 'cell')} or more in both groups; ${formatCount(pairs)} ${pairs === 1 ? 'has' : 'have'}`
        : null;
    this._replicateBlocker = { resolved, codes: replicates.codes, minimum: replicates.minCellsPerSample, paired: options.paired, blocker };
    return blocker;
  }

  /** The sample field of a pseudobulk run, or null while it is read. */
  _replicatesOf(options) {
    this._groupsOfField(options.replicates);
    const described = this._fieldGroups.get(options.replicates);
    if (described === undefined) return null;
    return {
      name: options.replicates,
      codes: described.codes,
      missingCode: missingCategoryCode(described.codes),
      minCellsPerSample: options.minCellsPerSample
    };
  }

  /** A swap beside Group A and Group B. */
  _decorateOptionsForm(form) {
    const essentials = form.essentials;
    const swap = document.createElement('button');
    swap.type = 'button';
    swap.className = buttonClassName('quiet', 'de-swap');
    swap.textContent = 'Swap A and B';
    swap.addEventListener('click', () => {
      const options = this._options;
      const before = this._requireOptions();
      this._setOptions(options.compare === 'pages'
        ? { ...options, pageA: options.pageB, pageB: options.pageA }
        : { ...options, categoriesA: options.categoriesB, categoriesB: options.categoriesA });
      this._recordOptionsChange(before);
    });
    essentials.appendChild(swap);
  }

  // ===========================================================================
  // Run
  // ===========================================================================

  /** Every run reads genes (every gene it tests, whatever its options name). @override */
  _readsGenes() {
    return true;
  }

  /** @override */
  _takesCellSample() {
    return true;
  }

  /** Cells: the expression values; samples (pseudobulk): raw counts, whatever the setting. @override */
  _valuesRead(options) {
    if (options.replicates !== '') {
      return { transform: RAW_VALUES, note: `Values: raw counts summed per sample (pseudobulk normalizes the samples, whatever ${placePath(PLACES.dataMapping, PLACES.expressionValues)} says)` };
    }
    return super._valuesRead(options);
  }

  /** Its genes: a run reads every gene it tests (about the matrix's). @override */
  _getRunUnits() {
    return Math.max(1, this.dataLayer.state?.varData?.fields?.length ?? 1);
  }

  async _runAnalysisImpl(options, requestId, job, sample = null) {
    const groups = this._resolveGroups(options);
    if (groups.reason) throw new Error(groups.reason);
    // A first pass: each group's cells in the sample.
    const resolved = sample === null
      ? groups
      : { a: { ...groups.a, cells: sample.cells(groups.a.cells) }, b: { ...groups.b, cells: sample.cells(groups.b.cells) } };
    const helper = this._helperController();
    const genes = await helper.genesToTest(options);
    const pseudobulk = options.replicates !== '';
    // Cells: tested in the expression transform's values; samples: their
    // raw counts summed, each sample's library size from the cells' stored
    // totals when the file has them (never a pass over the genes: null sums
    // each sample's counts over every gene, edgeR's default).
    const transform = pseudobulk ? RAW_VALUES : this.dataLayer.expressionTransformOf(options.matrix);
    const cellTotals = pseudobulk && this.dataLayer.matrixHoldsCounts(options.matrix)
      ? await this.dataLayer.storedCellTotals({ signal: job?.signal ?? null })
      : null;
    const deResults = await this.multiVariableAnalysis.differentialExpression({
      groupA: resolved.a,
      groupB: resolved.b,
      geneList: genes,
      method: options.method,
      pConvention: options.method === 'wilcox' ? options.pConvention : 'exact',
      correction: options.correction,
      foldChange: helper.foldChangeOf(options.foldChange, options.matrix, transform),
      matrix: options.matrix,
      replicates: pseudobulk ? this._replicatesOf(options) : null,
      paired: pseudobulk && options.paired,
      cellTotals,
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
    const { up, down } = this._significantCounts(results, options);
    return up + down;
  }

  /**
   * The genes past the shown cutoffs (Max adjusted p, Min |log2FC|, Min %
   * expressing in either group), up in A and up in B: one count for the
   * status line, the Statistics and an agent's read.
   */
  _significantCounts(results, options) {
    let up = 0;
    let down = 0;
    for (const row of results ?? []) {
      const p = row.adjustedPValue;
      if (!isFiniteNumber(p) || !isFiniteNumber(row.log2FoldChange)) continue;
      if (p <= options.maxAdjP && Math.abs(row.log2FoldChange) >= options.minLog2FC &&
          Math.max(row.pctA ?? 0, row.pctB ?? 0) >= options.minPct) {
        if (row.log2FoldChange > 0) up++;
        else down++;
      }
    }
    return { up, down };
  }

  /** The cutoffs `_significantCounts` applies, in words. */
  _significanceWords(options) {
    return `adj p ≤ ${options.maxAdjP}, |log2FC| ≥ ${options.minLog2FC}${options.minPct > 0 ? `, ≥ ${formatPercent(options.minPct, { figures: 6 })} expressing` : ''}`;
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
        summary.replicates?.paired ? 'Pseudobulk limma, paired' : METHOD_NAMES[summary.method],
        `${formatCountOf(summary.genesTested, 'gene')}`,
        ...(summary.matrix === 'mapped' ? [] : [summary.matrixLabel]),
        ...(summary.values == null ? [] : [transformWords(summary.values)])
      ].join(' · ');
      header.appendChild(line);
      const chips = document.createElement('div');
      chips.className = 'analysis-result-chips';
      if (summary.lowN.length > 0) {
        const chip = document.createElement('span');
        chip.className = 'analysis-chip analysis-chip-warning';
        chip.textContent = 'low n';
        chip.title = `Fewer than ${formatCountOf(summary.minCells, 'cell')}: ${summary.lowN.join(', ')}`;
        chips.appendChild(chip);
      }
      const replicates = summary.replicates;
      const leftOut = replicates === null ? 0 : replicates.smallSamplesA + replicates.smallSamplesB;
      if (leftOut > 0) {
        const chip = document.createElement('span');
        chip.className = 'analysis-chip analysis-chip-info';
        chip.textContent = `${formatCount(leftOut)} small ${countNoun(leftOut, 'sample')} left out`;
        chip.title = `Samples of ${replicates.field} with fewer than ${formatCountOf(replicates.minCellsPerSample, 'cell')} of a group are left out of that side (${formatCount(replicates.smallSamplesA)} of ${summary.groupAName}, ${formatCount(replicates.smallSamplesB)} of ${summary.groupBName}; ${formatCountOf(replicates.cellsInSmallSamples, 'cell')}): their means are mostly noise, and every sample weighs the same.`;
        chips.appendChild(chip);
      }
      const unmeasured = replicates === null ? 0 : replicates.genesWithUnmeasuredSamples;
      if (unmeasured > 0) {
        const chip = document.createElement('span');
        chip.className = 'analysis-chip analysis-chip-info';
        chip.textContent = `${formatCountOf(unmeasured, 'gene')} with fewer samples`;
        chip.title = `For ${formatCountOf(unmeasured, 'gene')}, some samples of ${replicates.field} have fewer than ${formatCountOf(replicates.minCellsPerSample, 'cell')} with a value (cells without one were not measured: NaN), so those samples are left out of that gene's test. Each gene's samples tested are n_a and n_b in the CSV.`;
        chips.appendChild(chip);
      }
      if (chips.childElementCount > 0) header.appendChild(chips);
      container.prepend(header);
    }
    return rendered;
  }

  _renderModalStats(container) {
    const result = this._lastResult;
    const summary = result?.full?.summary;
    if (!summary) {
      container.innerHTML = '<p class="empty-state">Statistics not available</p>';
      return;
    }
    const options = this._options;
    const { up, down } = this._significantCounts(result.data.results, options);
    const rows = [
      ['Genes tested', formatCount(summary.genesTested)],
      [
        summary.replicates === null ? 'Not tested (fewer than 2 cells with a value)' : 'Not tested (not expressed in the samples, or no sample with a value on a side)',
        formatCount(summary.genesUntestable)
      ],
      ...(summary.replicates === null ? [] : [[
        'Replicates',
        `${summary.replicates.field}: ${formatCount(summary.replicates.samplesA)} vs ${formatCountOf(summary.replicates.samplesB, 'sample')}`
      ], [
        'Samples in both groups',
        `${formatCount(summary.replicates.samplesInBoth)}${summary.replicates.paired ? ', tested paired' : ''}`
      ], [
        `Samples left out (fewer than ${formatCountOf(summary.replicates.minCellsPerSample, 'cell')})`,
        `${formatCount(summary.replicates.smallSamplesA)} vs ${formatCount(summary.replicates.smallSamplesB)} (${formatCountOf(summary.replicates.cellsInSmallSamples, 'cell')})`
      ], [
        `Genes with samples left out (fewer than ${formatCountOf(summary.replicates.minCellsPerSample, 'cell')} with a value)`,
        formatCount(summary.replicates.genesWithUnmeasuredSamples)
      ]]),
      [`Significant (${this._significanceWords(options)})`, formatCount(up + down)],
      ['Up in A', formatCount(up)],
      ['Down in A', formatCount(down)],
      ...(summary.method === 'wilcox' ? [['p-values', P_CONVENTION_NAMES[summary.pConvention]]] : []),
      ['Multiple testing', summary.correction === 'bh' ? 'Benjamini–Hochberg' : 'Bonferroni'],
      ['Expression matrix', summary.matrixLabel],
      ['Values', summary.replicates === null
        ? describeValues(summary.values, { counts: summary.counts })
        : describePseudobulkNormalisation(summary.replicates.model)],
      ...(summary.replicates === null ? [] : [['Model', describePseudobulkModel(summary.replicates.model, summary.replicates.field)]]),
      ['Fold change', FOLD_CHANGE_NAMES[summary.foldChange.mode]]
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
        formatPValue(row.adjustedPValue),
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
  tableFile() {
    const full = this._lastResult?.full;
    if (!full) return null;
    // Genes by identifier, the shown name beside it (`geneNameColumns`).
    const { idOf } = geneIdentities(this.dataLayer.state?.varData);
    const shown = full.results.map(row => row.gene);
    const columns = geneNameColumns(shown, shown.map(gene => idOf(gene)));
    // The groups' means name the values the run read ("mean_a · log1p(norm.)").
    const means = ['mean_a', 'mean_b'].map(column => toCSVCell(geneValueLabel(column, full.summary.values)));
    const lines = [`${columns.header},scores,logfoldchanges,pvals,pvals_adj,pct_nz_group,pct_nz_reference,auroc,${means.join(',')},n_a,n_b`];
    for (const [index, row] of full.results.entries()) {
      lines.push([
        columns.cells(index),
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
    return { name: 'differential_expression', csv: lines.join('\n') };
  }

  // ===========================================================================
  // Sessions
  // ===========================================================================

  /**
   * The genes most up in group A, then the most up in group B (top `top`
   * each), as an agent reads the result (`describeResult`).
   * @override
   */
  _resultTable(result, top) {
    const rows = [...(result?.full?.results ?? [])].filter(row => Number.isFinite(row.score));
    rows.sort((a, b) => b.score - a.score);
    const row = (entry, direction) => [direction, entry.gene, finiteOrNull(entry.score), finiteOrNull(entry.log2FoldChange),
      finiteOrNull(entry.adjustedPValue), finiteOrNull(entry.pctA), finiteOrNull(entry.pctB), finiteOrNull(entry.auroc)];
    const up = rows.slice(0, top).filter(entry => entry.score > 0);
    const down = rows.slice(-top).reverse().filter(entry => entry.score < 0);
    return {
      columns: ['higher_in', 'gene', 'score', 'log2_fold_change', 'p_adjusted', 'percent_a', 'percent_b', 'auroc'],
      rows: [...up.map(entry => row(entry, 'A')), ...down.map(entry => row(entry, 'B'))],
      total: rows.length,
      about: this._resultAbout(result, top)
    };
  }

  /**
   * How the result was tested, as its expanded view's header and Statistics
   * say it: the two groups and their cells (samples with replicates), the
   * test, the correction, the matrix (counts said so) and its values, and
   * how many genes pass the shown cutoffs. An agent read the rows alone and
   * had to guess the group sizes and that the values were raw counts.
   */
  _resultAbout(result, top) {
    const summary = result?.full?.summary;
    if (!summary) return null;
    const { up, down } = this._significantCounts(result.data.results, this._options);
    const replicates = summary.replicates;
    return {
      group_a: summary.groupAName,
      cells_a: summary.groupASize,
      group_b: summary.groupBName,
      cells_b: summary.groupBSize,
      test: replicates === null
        ? `${METHOD_NAMES[summary.method]}, cells as observations${summary.method === 'wilcox' ? ` (${P_CONVENTION_NAMES[summary.pConvention]})` : ''}`
        : `pseudobulk: limma moderated t between the samples of ${replicates.field}${replicates.paired ? ', paired (donor blocked)' : ''}, each sample's ${replicates.model.counts ? 'log-CPM' : 'mean'}`,
      ...(replicates === null ? {} : {
        samples_a: replicates.samplesA,
        samples_b: replicates.samplesB,
        samples_left_out: `${replicates.smallSamplesA} of A, ${replicates.smallSamplesB} of B (fewer than ${formatCountOf(replicates.minCellsPerSample, 'cell')})`,
        pairing: replicates.paired
          ? `paired: ${formatCountOf(replicates.samplesInBoth, 'sample')} in both groups; ${replicates.samplesA - replicates.samplesInBoth} of A and ${replicates.samplesB - replicates.samplesInBoth} of B in one group only, left out`
          : replicates.samplesInBoth >= 2
            ? `unpaired; ${formatCountOf(replicates.samplesInBoth, 'sample')} of ${replicates.field} are in both groups: paired: true tests them paired`
            : `unpaired; ${formatCountOf(replicates.samplesInBoth, 'sample')} of ${replicates.field} in both groups, too few to pair`
      }),
      multiple_testing: summary.correction === 'bh' ? 'Benjamini–Hochberg' : 'Bonferroni',
      expression_matrix: summary.matrixLabel,
      values: replicates === null
        ? describeValues(summary.values, { counts: summary.counts })
        : describePseudobulkNormalisation(replicates.model),
      ...(replicates === null ? {} : { model: describePseudobulkModel(replicates.model, replicates.field) }),
      fold_change: FOLD_CHANGE_ABOUT[summary.foldChange.mode],
      genes_tested: summary.genesTested,
      significant_up_in_a: up,
      significant_up_in_b: down,
      significance: this._significanceWords(this._options),
      // `top` counts each direction: an agent asked for 40 each way read top 3,753 first (L14-5).
      rows: `the top ${formatCountOf(top, 'gene')} by score up in A, then the top ${formatCount(top)} up in B: top counts each direction`
    };
  }

  _exportResult() {
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
      typeof full.summary.counts !== 'boolean' || !isValuesRecord(full.summary.values) ||
      full.summary.replicates === undefined ||
      (full.summary.replicates !== null && (
        !Number.isSafeInteger(full.summary.replicates.genesWithUnmeasuredSamples) ||
        !Number.isSafeInteger(full.summary.replicates.samplesInBoth) || typeof full.summary.replicates.paired !== 'boolean' ||
        typeof full.summary.replicates.model !== 'object' || full.summary.replicates.model === null
      ))
    ) {
      throw new TypeError('A differential expression result must hold its gene table, summary and expression matrix');
    }
    await requireDatasetGenes(
      this.dataLayer, full.results.map(row => row?.gene), 'The differential expression result', full.summary.matrix
    );
    await this._restoreAnalysisResult(this._buildResult(full, this._requireOptions()), envelope.provenance);
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

