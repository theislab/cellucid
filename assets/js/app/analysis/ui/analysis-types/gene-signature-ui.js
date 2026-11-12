/**
 * Gene signature: score every cell by one or more gene sets and compare the
 * scores across pages, or across the categories of a field ("Group by": one
 * run scores a program per cell type, where pages needed one highlight
 * page per type).
 *
 * The form is the options schema's (`options/signature-options.js`): the
 * gene sets (`ui/components/gene-set-editor.js`), the pages, Run; scoring
 * and display under More options. Typing never runs: a change after a run
 * dims the result with "Stale · Run". Genes the dataset does not have are
 * left out of the score and named in the result ("2 not found").
 *
 * @module analysis-types/gene-signature-ui
 */

import { PLACES, placePath } from '../../../ui/place-names.js';
import { formatCount, formatCountOf } from '../../../../utils/format-units.js';
import { FormBasedAnalysisUI } from './base/form-based-analysis.js';
import { isFiniteNumber } from '../../shared/number-utils.js';
import { PageSelectorComponent } from '../shared/page-selector.js';
import {
  preparePageStatistics,
  renderSummaryStats,
  renderStatisticalAnnotations
} from '../components/stats-display.js';
import { createSlicedYield } from '../../shared/concurrency-utils.js';
import {
  createResultEnvelope,
  readResultEnvelope,
  requireDatasetGenes,
  requireDatasetPages
} from '../../shared/analysis-result-session.js';
import { SIGNATURE_DISPLAY_KEYS, SIGNATURE_OPTIONS } from '../../options/signature-options.js';
import { createGeneIndex, geneIdentities, notebookGeneSets, resolveGenes } from '../../shared/gene-sets.js';
import { writePerCellCSV } from '../base-analysis-ui.js';
import { cellsReadFor } from '../../shared/gene-sample-cells.js';
import { listNames, namedError, quoteName } from '../../../actions/targets/names.js';
import { runStatisticalTests } from '../../stats/statistical-tests.js';
import { sharedCellsReason } from '../../shared/page-overlap.js';
import { createFieldGroups } from './field-groups.js';
import { missingCategoryCode } from '../../../../data/categorical-storage-contract.js';
import { fieldCategoryCss } from '../../../utils/category-state.js';
import { failureDetails, sayFailure } from '../../../../utils/errors.js';
import { RAW_VALUES, describeValues, isValuesRecord, transformWords } from '../../../../data/expression-transform.js';

/** A category's group id in a result scored by a field ("Group by"). */
const categoryGroupId = name => `category:${name}`;

const METHOD_LABELS = Object.freeze({
  mean: 'mean',
  median: 'median',
  mean_z: 'mean z-score',
  module: 'module score',
  ucell: 'UCell'
});

/**
 * Gene signature UI
 * @extends FormBasedAnalysisUI
 */
export class GeneSignatureUI extends FormBasedAnalysisUI {
  constructor(options) {
    super(options);
    this._pageSelector = null;
    this._pageSelectContainer = null;
    /** Which set "One at a time" shows. */
    this._shownSet = 0;
    this._geneIndex = null;
    this._geneIndexOf = null;
    this._fieldGroups = createFieldGroups({
      dataLayer: this.dataLayer,
      onReady: () => this._refreshOptionsContext(),
      onError: error => this._notifications.error(`Gene signature groups: ${sayFailure(error)}`, { ...failureDetails(error), category: 'analysis' })
    });
  }

  /** Another set of open cells: the categories' counts are counted again on them. @override */
  _onOpenCellsChanged() {
    this._fieldGroups.reset();
  }

  /** Scored by a field's categories, the result does not depend on the pages chosen. @override */
  _currentProvenance(options, pageIds, genesReadFor) {
    return super._currentProvenance(options, options.groupBy === '' ? pageIds : [], genesReadFor);
  }

  static getRequirements() {
    return {
      // Gene signature has its own page selector.
      minPages: 0,
      maxPages: null,
      description: 'Select pages to analyze',
      geneExpression: true
    };
  }

  /** The mapped matrix's values; UCell ranks within each cell, which they leave unchanged. @override */
  _valuesRead(options) {
    if (options.method === 'ucell') return { transform: RAW_VALUES, note: 'Values: as stored (UCell ranks within each cell: normalizing and log1p change no rank)' };
    return super._valuesRead(options);
  }

  /** Its values line, though it has no "Expression matrix" option (it reads the mapped one). @override */
  _valuesNote(options) {
    const read = this._valuesRead(options);
    if (read === null) return null;
    return read.note ?? `Values: ${transformWords(read.transform)} (${placePath(PLACES.dataMapping, PLACES.expressionValues)})`;
  }

  _getTitle() {
    return 'Gene signature';
  }

  _getClassName() {
    return 'gene-signature';
  }

  _getSuccessMessage() {
    return 'Signature scoring complete';
  }

  // ===========================================================================
  // Options
  // ===========================================================================

  _getOptionsSchema() {
    return SIGNATURE_OPTIONS;
  }

  _getOptionsContext() {
    return {
      categoricalFields: this.dataLayer.getAvailableVariables('categorical_obs').map(info => ({ key: info.key })),
      groupsFor: (_entry, record) => this._fieldGroups.groups(record.groupBy),
      pages: this.dataLayer.getPages().map(page => ({ id: page.id, name: page.name })),
      getGenes: () => this._geneNames(),
      getGeneIdentities: () => geneIdentities(this.dataLayer.state?.varData),
      getMarkerSets: () => {
        // Read without making the marker genes' analysis (a read makes no state).
        const sets = this.comparisonModule?.getUIManager?.()?.peekUI?.('genesPanel')?.getMarkerGeneSets?.() ?? [];
        return sets.length > 0 ? sets : null;
      },
      getNotebookSets: () => notebookGeneSets(this.dataLayer.state)
    };
  }

  _isDisplayOption(key) {
    return SIGNATURE_DISPLAY_KEYS.includes(key);
  }

  /** The dataset's gene names (shared with the gene index). */
  _geneNames() {
    const variables = this.dataLayer.getAvailableVariables('gene_expression');
    if (this._geneIndexOf !== variables) {
      this._geneIndexOf = variables;
      this._names = variables.map(variable => variable.key);
      this._geneIndex = createGeneIndex(this._names, geneIdentities(this.dataLayer.state?.varData));
    }
    return this._names;
  }

  /** Each set's genes matched to the dataset. */
  _resolveSets(geneSets) {
    this._geneNames();
    return geneSets.map(set => ({ name: set.name, ...resolveGenes(set.genes, this._geneIndex) }));
  }

  _getRunBlocker(options) {
    if (options.groupBy === '' && this._selectedPages.length === 0) return 'Select at least one page, or group by a field';
    if (options.groupBy !== '' && options.groups.mode === 'subset' && options.groups.ids.length === 0) return 'Choose at least one group';
    const resolved = this._resolveSets(options.geneSets);
    if (options.geneSets.every(set => set.genes.length === 0)) return 'Add genes to a set';
    if (resolved.every(set => set.resolved.length === 0)) return 'None of the genes are in this dataset';
    return null;
  }

  // ===========================================================================
  // Form
  // ===========================================================================

  _renderFormLead(wrapper) {
    const pages = this.dataLayer.getPages();
    if (!Array.isArray(pages) || pages.length === 0) return;
    this._pageSelectContainer = document.createElement('div');
    wrapper.appendChild(this._pageSelectContainer);
    this._pageSelector?.destroy();
    this._pageSelector = new PageSelectorComponent({
      dataLayer: this.dataLayer,
      container: this._pageSelectContainer,
      onSelectionChange: pageIds => {
        this._assignPages(pageIds || []);
        this._recordPersonChange('pages', { pageIds: [...this._selectedPages] });
        this._updateRunRow();
        this._updateStale();
      },
      onColorChange: (pageId, color) => this.dataLayer?.setPageColor?.(pageId, color),
      showColorPicker: true,
      showCellCounts: true,
      showSelectAll: true,
      initialSelection: this._pageSelectionToShow(),
      includeDerivedPages: true,
      getCellCountForPageId: pageId => this.dataLayer.getCellCountForPageId(pageId),
      label: 'Pages'
    });
    this._adoptSelectorDefault();
    this._showPageSelector();
  }

  /** The pages are what is scored only while Group by names no field. */
  _showPageSelector() {
    if (this._pageSelectContainer) this._pageSelectContainer.hidden = (this._options?.groupBy ?? '') !== '';
  }

  /** @override */
  _handleOptionsChanged(key) {
    this._showPageSelector();
    super._handleOptionsChanged(key);
  }

  /**
   * Each category of the Group by field with cells in the chosen cells (of
   * "Groups to score"), in the field's order: `{id, name, cellIndices}`,
   * the cells ascending; a first pass's sample of them.
   */
  async _categoryGroups(options, sample, signal) {
    const field = await this.dataLayer.ensureObsFieldLoaded(options.groupBy, { signal });
    const { codes } = field;
    const categories = field.categories.map(String);
    const scope = this._scopeMask(options.cells, codes.length);
    const shown = options.groups.mode === 'subset' ? new Set(options.groups.ids) : null;
    const missing = missingCategoryCode(codes);
    const counts = new Uint32Array(categories.length);
    for (let cell = 0; cell < codes.length; cell++) {
      const code = codes[cell];
      if (code !== missing && code < categories.length && (scope === null || scope[cell] !== 0)) counts[code] += 1;
    }
    const cellsOf = categories.map((_, code) => new Uint32Array(counts[code]));
    const filled = new Uint32Array(categories.length);
    for (let cell = 0; cell < codes.length; cell++) {
      const code = codes[cell];
      if (code !== missing && code < categories.length && (scope === null || scope[cell] !== 0)) cellsOf[code][filled[code]++] = cell;
    }
    const groups = [];
    categories.forEach((name, code) => {
      if (counts[code] === 0 || (shown !== null && !shown.has(name))) return;
      const cellIndices = sample === null ? cellsOf[code] : sample.cells(cellsOf[code]);
      if (cellIndices.length > 0) groups.push({ id: categoryGroupId(name), name, cellIndices });
    });
    if (groups.length === 0) throw new Error(`No cells of the chosen groups of ${options.groupBy} are in the chosen cells`);
    return groups;
  }

  /** A cell scope (All, Visible, a page) as one byte a cell; null for every cell. */
  _scopeMask(cells, cellCount) {
    if (cells === 'all') return null;
    if (cells === 'visible') return this.dataLayer.getVisibleCellMask();
    if (!cells.startsWith('page:')) throw new RangeError(`Unknown cell scope "${cells}"`);
    const mask = new Uint8Array(cellCount);
    for (const index of this.dataLayer.getCellIndicesForPage(cells.slice('page:'.length))) mask[index] = 1;
    return mask;
  }

  // ===========================================================================
  // Run
  // ===========================================================================

  /** @override */
  _takesCellSample() {
    return true;
  }

  async _runAnalysisImpl(options, requestId, job, sample = null) {
    // A first pass scores each page's (each group's) cells in the sample.
    const byField = options.groupBy !== '';
    const groups = byField ? await this._categoryGroups(options, sample, job.signal) : null;
    if (!this._isCurrentAnalysisRequest(requestId)) return null;
    const pageIds = byField ? null : sample === null ? [...this._selectedPages] : sample.pageIds([...this._selectedPages]);
    const resolution = this._resolveSets(options.geneSets);
    const scored = resolution.filter(set => set.resolved.length > 0);
    const counts = this.dataLayer.matrixHoldsCounts('mapped');
    const result = await this.multiVariableAnalysis.computeSignatureScore({
      geneSets: scored.map(set => ({ name: set.name, genes: set.resolved })),
      ...(byField ? { groups } : { pageIds }),
      method: options.method,
      controlSize: options.controlSize,
      bins: options.bins,
      seed: options.seed,
      maxRank: options.maxRank,
      job,
      isCurrent: () => this._isCurrentAnalysisRequest(requestId),
      registerInvalidationCleanup: cleanup => this._registerAnalysisInvalidationCleanup(requestId, cleanup)
    });
    if (result === null || !this._isCurrentAnalysisRequest(requestId)) return null;

    const sets = result.sets.map(set => {
      const resolved = resolution.find(entry => entry.name === set.name);
      return {
        name: set.name,
        genes: set.genes,
        controlGenes: set.controlGenes,
        constantGenes: set.constantGenes,
        unmatched: [...resolved.unmatched, ...resolved.ambiguous.map(entry => entry.requested)],
        pages: set.pages.map(page => ({
          pageId: sample === null || byField ? page.pageId : sample.basePageId(page.pageId),
          pageName: page.pageName,
          scores: page.scores,
          cellIndices: page.cellIndices
        }))
      };
    });
    // Sets with no gene of this dataset are named, not scored.
    const unscored = resolution
      .filter(set => set.resolved.length === 0)
      .map(set => ({ name: set.name, unmatched: [...set.unmatched, ...set.ambiguous.map(entry => entry.requested)] }));
    // Genes read for a sample of the open cells: each page was scored on its
    // cells among them (`cellIndices`), and the result keeps which.
    const built = await this._buildResult({
      sets,
      unscored,
      method: options.method,
      geneSample: result.geneSample ?? null,
      // The field whose categories were scored, null for pages.
      groupBy: byField ? options.groupBy : null,
      counts,
      values: result.values
    }, options);
    return this._isCurrentAnalysisRequest(requestId) ? built : null;
  }

  /**
   * The drawn result from the raw scores: rescaled, laid out per the display
   * options. The raw scores are kept, so a display change redraws from them.
   */
  async _buildResult(raw, options) {
    const { plotType, rescale, layout } = options;
    const multiple = raw.sets.length > 1;
    const shown = layout === 'each' && multiple
      ? [raw.sets[Math.min(this._shownSet, raw.sets.length - 1)]]
      : raw.sets;
    const data = [];
    // One set: each page in its swatch's color (each category in its
    // field's); several: each page and set its own color.
    const pageColors = multiple ? new Map() : raw.groupBy === null
      ? new Map(this._pageSelector?.getPageColors?.() || [])
      : this._categoryColors(raw.groupBy);
    for (const set of shown) {
      for (const page of set.pages) {
        data.push({
          pageId: multiple ? `${page.pageId}::${set.name}` : page.pageId,
          ...(pageColors.has(page.pageId) ? { pageColor: pageColors.get(page.pageId) } : {}),
          pageName: multiple && layout === 'side' ? `${page.pageName} · ${set.name}` : page.pageName,
          values: page.scores.slice(),
          cellIndices: page.cellIndices,
          setName: set.name,
          variableInfo: { name: 'Signature score', kind: 'continuous' }
        });
      }
    }
    await rescaleScores(data, rescale);
    await preparePageStatistics(data, 'continuous_obs');
    const geneCount = raw.sets.reduce((sum, set) => sum + set.genes.length, 0);
    return {
      type: 'signature',
      plotType,
      data,
      raw,
      geneSample: raw.geneSample ?? null,
      options: { showPoints: 'outliers', showMean: true },
      title: 'Gene signature',
      subtitle: raw.sets.length === 1
        ? `${raw.sets[0].name} · ${formatCountOf(raw.sets[0].genes.length, 'gene')} · ${METHOD_LABELS[raw.method]}`
        : `${formatCountOf(raw.sets.length, 'set')} · ${formatCountOf(geneCount, 'gene')} · ${METHOD_LABELS[raw.method]}`,
      metadata: { method: raw.method }
    };
  }

  /** Each category group's color, the field's own (by group id). */
  _categoryColors(fieldKey) {
    const field = this.dataLayer.state?.obsData?.fields?.find(candidate => candidate.key === fieldKey);
    if (!field || !Array.isArray(field.categories)) return new Map();
    return new Map(field.categories.map((category, index) => [categoryGroupId(String(category)), fieldCategoryCss(field, index)]));
  }

  _rebuildForDisplay(options) {
    const raw = this._lastResult?.raw;
    return raw === undefined ? null : this._buildResult(raw, options);
  }

  // ===========================================================================
  // Result
  // ===========================================================================

  async _showResult(result, requestId) {
    const plotContainerId = this._instanceId ? `${this._instanceId}-signature-analysis-plot` : 'signature-analysis-plot';
    const rendered = await this._renderPreviewPlot({
      result,
      requestId,
      containerId: plotContainerId,
      expandable: true
    });
    if (rendered !== null && this._isCurrentAnalysisRequest(requestId)) this._renderResultHeader(result);
    return rendered;
  }

  /** Chips above the plot: genes not found, constant genes, the shown set. */
  _renderResultHeader(result) {
    const container = this._resultContainer;
    container.querySelector(':scope > .analysis-result-header')?.remove();
    const header = document.createElement('div');
    header.className = 'analysis-result-header';
    // Chips sit in one wrapping row, each its own width.
    const chips = document.createElement('div');
    chips.className = 'analysis-result-chips';
    const { raw } = result;
    const notFound = [
      ...raw.sets.flatMap(set => set.unmatched),
      ...raw.unscored.flatMap(set => set.unmatched)
    ];
    if (notFound.length > 0) {
      const chip = document.createElement('span');
      chip.className = 'analysis-chip analysis-chip-warning';
      chip.textContent = `${formatCount(notFound.length)} not found`;
      chip.title = `Not in this dataset, left out of the score: ${notFound.join(', ')}`;
      chips.appendChild(chip);
    }
    const constant = raw.sets.flatMap(set => set.constantGenes);
    if (constant.length > 0) {
      const chip = document.createElement('span');
      chip.className = 'analysis-chip';
      chip.textContent = `${formatCount(constant.length)} constant`;
      chip.title = `The same in every cell, so without a z-score; left out: ${constant.join(', ')}`;
      chips.appendChild(chip);
    }
    if (raw.sets.length > 1 && this._options?.layout === 'each') {
      raw.sets.forEach((set, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'analysis-flag';
        button.textContent = set.name;
        button.setAttribute('aria-pressed', String(index === this._shownSet));
        button.addEventListener('click', () => {
          this._shownSet = index;
          // Which set is shown is how the result is shown: a step (`analysis.view.set`).
          this._recordPersonChange('view', { view: { set: set.name } });
          this._trackInteractiveTask(this._redrawForDisplay(), 'Gene signature set');
        });
        chips.appendChild(button);
      });
    }
    if (chips.childElementCount > 0) header.appendChild(chips);
    if (header.childElementCount > 0) container.prepend(header);
  }

  _renderModalStats(container) {
    const pageData = this._lastResult?.data;
    if (!pageData || pageData.length === 0) {
      container.innerHTML = '<p class="empty-state">Statistics not available</p>';
      return;
    }
    renderSummaryStats(container, pageData, 'Signature score');
  }

  _renderModalAnnotations(container) {
    const result = this._lastResult;
    const pageData = result?.data;
    container.innerHTML = '';
    if (pageData && pageData.length >= 2) {
      const section = document.createElement('div');
      section.className = 'modal-statistical-analysis';
      const title = document.createElement('h5');
      title.textContent = 'Statistical analysis';
      section.appendChild(title);
      const stats = document.createElement('div');
      renderStatisticalAnnotations(stats, pageData, 'continuous_obs');
      section.appendChild(stats);
      container.appendChild(section);
    }
    for (const set of result?.raw?.sets ?? []) {
      const section = document.createElement('div');
      section.className = 'modal-gene-section';
      const title = document.createElement('h5');
      title.textContent = `${set.name} (${formatCountOf(set.genes.length, 'gene')})`;
      section.appendChild(title);
      const chips = document.createElement('div');
      chips.className = 'gene-chips modal-gene-chips';
      for (const [genes, className, hint] of [
        [set.genes, 'gene-chip', null],
        [set.unmatched, 'gene-chip gene-chip-missing', 'Not in this dataset'],
        [set.constantGenes, 'gene-chip gene-chip-missing', 'Constant: no z-score']
      ]) {
        for (const gene of genes) {
          const chip = document.createElement('span');
          chip.className = className;
          chip.textContent = gene;
          if (hint !== null) chip.title = hint;
          chips.appendChild(chip);
        }
      }
      section.appendChild(chips);
      if (set.controlGenes.length > 0) {
        const controls = document.createElement('p');
        controls.className = 'analysis-run-reason';
        controls.textContent = `Controls: ${formatCountOf(set.controlGenes.length, 'gene')}`;
        controls.title = set.controlGenes.join(', ');
        section.appendChild(controls);
      }
      container.appendChild(section);
    }
    if (container.childElementCount === 0) {
      container.innerHTML = '<p class="empty-state">No annotations available</p>';
    }
  }

  /**
   * CSV: `page,set,cell_index,score`, every finite score of every set; with
   * a Group by field `group,…` (its rows are categories, not pages, as the
   * result's table names them).
   */
  async tableFile() {
    const raw = this._lastResult?.raw;
    if (!raw) return null;
    const pages = raw.sets.flatMap(set => set.pages.map(page => ({
      pageName: page.pageName,
      setName: set.name,
      values: page.scores,
      cellIndices: page.cellIndices
    })));
    return { name: 'gene_signature_scores', csv: await writePerCellCSV('signature-scores', pages, raw.groupBy === null ? 'page' : 'group', this.dataLayer.state.cellIdentity) };
  }

  // ===========================================================================
  // Sessions
  // ===========================================================================

  _getExtraSettingKeys() {
    return ['customPageColors'];
  }

  _exportExtraSettings() {
    return {
      customPageColors: this._pageSelector === null
        ? []
        : Array.from(this._pageSelector.getCustomColors().entries())
    };
  }

  _importExtraSettings(settings) {
    if (this._pageSelector !== null) {
      this._applyCustomPageColors(this._requireCustomPageColors(settings.customPageColors));
    }
  }

  _exportViewState() {
    return { shownSet: this._shownSet };
  }

  _importViewState(view) {
    const keys = Object.keys(view);
    if (keys.length !== 1 || !Number.isSafeInteger(view.shownSet) || view.shownSet < 0) {
      throw new TypeError('Gene signature view must hold exactly shownSet');
    }
    this._shownSet = view.shownSet;
  }

  /** The gene sets of the shown result, as scored. */
  _resultSets() {
    return this._lastResult?.raw?.sets ?? null;
  }

  /** The set a result of one score per set shows, by its name (null with no result). @override */
  _viewParams() {
    const sets = this._resultSets();
    return { set: sets === null || sets.length === 0 ? null : sets[Math.min(this._shownSet, sets.length - 1)].name };
  }

  /** @override */
  _prepareViewParams(rest) {
    for (const key of Object.keys(rest)) {
      if (key !== 'set') throw new TypeError(`Gene signature has no view "${key}"; it takes "more", "groups", "plot" and "set".`);
    }
    if (rest.set === undefined) return () => false;
    const sets = this._resultSets();
    if (sets === null) throw new RangeError('Gene signature has no result yet: run it, then choose the set it shows.');
    const index = sets.findIndex(set => set.name === rest.set);
    if (index < 0) {
      throw namedError(RangeError, `There is no gene set ${quoteName(rest.set)} in the gene signature result; its sets are ${listNames(sets.map(set => set.name))}.`);
    }
    return () => {
      if (index === this._shownSet) return false;
      this._shownSet = index;
      void this._trackInteractiveTask(this._redrawForDisplay(), 'Gene signature set');
      return true;
    };
  }

  /**
   * The shown result's scores and sets reach the dataset's derived results
   * (and from there a notebook): one score per set over every scored cell
   * (a cell in two pages has one score), and each set's genes as scored.
   */
  _publishDerivedResults(result) {
    const state = this.dataLayer?.state;
    if (state === null || state === undefined) return;
    const registry = state.getDerivedResults();
    const raw = result?.raw;
    if (!raw) {
      registry.replaceOwned('signature', {});
      return;
    }
    const pointCount = state.pointCount;
    const scores = raw.sets.map(set => {
      const byCell = new Float32Array(pointCount).fill(NaN);
      const scored = new Uint8Array(pointCount);
      let count = 0;
      for (const page of set.pages) {
        for (let index = 0; index < page.cellIndices.length; index++) {
          const cell = page.cellIndices[index];
          if (scored[cell] === 1) continue;
          scored[cell] = 1;
          byCell[cell] = page.scores[index];
          count++;
        }
      }
      const cells = new Uint32Array(count);
      const values = new Float32Array(count);
      let at = 0;
      for (let cell = 0; cell < pointCount; cell++) {
        if (scored[cell] === 1) {
          cells[at] = cell;
          values[at++] = byCell[cell];
        }
      }
      return { key: `${set.name} score`, cells, values };
    });
    const geneSets = raw.sets.map(set => ({ name: set.name, description: 'Gene signature', genes: [...set.genes] }));
    registry.replaceOwned('signature', { geneSets, scores });
  }

  /**
   * The shown result for a session: every set's raw scores per page (typed
   * columns), its genes, controls and genes not found.
   * @returns {null|{kind: 'signature', version: number, payload: unknown}}
   */
  /**
   * Each gene set's score per page (cells scored, mean, median), as an agent
   * reads the result (`describeResult`).
   * @override
   */
  _resultTable(result, top) {
    const sets = result?.raw?.sets ?? [];
    const rows = [];
    for (const set of sets) {
      for (const page of set.pages) {
        const scores = Array.from(page.scores ?? []).filter(Number.isFinite).sort((a, b) => a - b);
        const m = scores.length;
        const mean = m === 0 ? null : scores.reduce((sum, value) => sum + value, 0) / m;
        const median = m === 0 ? null : (m % 2 === 1 ? scores[(m - 1) / 2] : (scores[m / 2 - 1] + scores[m / 2]) / 2);
        rows.push([String(set.name), String(page.pageName ?? ''), m, mean, median]);
      }
    }
    return {
      columns: ['gene_set', result?.raw?.groupBy === null ? 'page' : 'group', 'cells_scored', 'mean_score', 'median_score'],
      rows: rows.slice(0, top),
      total: rows.length,
      about: this._resultAbout(result)
    };
  }

  /**
   * How the scores were made and compared: the method, each set's genes used
   * and left out, and the expanded view's tests between the pages (t-test
   * and Mann–Whitney for two, ANOVA and Kruskal–Wallis for more; none when
   * the pages share cells): an agent had means alone and could not say
   * whether a difference between pages held.
   */
  _resultAbout(result) {
    const raw = result?.raw;
    if (!raw) return null;
    const testsOf = set => {
      const pages = set.pages.map(page => ({ pageName: page.pageName, values: page.scores, cellIndices: page.cellIndices }));
      if (pages.length < 2) return raw.groupBy === null ? 'one page: nothing to compare' : 'one group: nothing to compare';
      const shared = sharedCellsReason(pages);
      if (shared !== null) return shared;
      return runStatisticalTests(pages, 'continuous_obs').map(test => ({
        test: test.testName,
        statistic: Number.isFinite(test.statistic) ? test.statistic : null,
        p_value: Number.isFinite(test.pValue) ? test.pValue : null,
        effect_size: Number.isFinite(test.effectSize) ? test.effectSize : null,
        effect_size_type: test.effectSizeType
      }));
    };
    return {
      method: METHOD_LABELS[raw.method] ?? raw.method,
      group_by: raw.groupBy === null ? 'pages (the highlight pages chosen)' : raw.groupBy,
      values: raw.method === 'ucell'
        ? 'as stored: UCell ranks the genes within each cell, which library-size scaling and log1p leave unchanged'
        : describeValues(raw.values, { counts: raw.counts }),
      sets: raw.sets.map(set => ({
        name: String(set.name),
        genes: set.genes.length,
        not_found: [...(set.unmatched ?? [])],
        constant: [...(set.constantGenes ?? [])],
        tests: testsOf(set)
      }))
    };
  }

  _exportResult() {
    const raw = this._lastResult?.raw;
    if (!raw) return null;
    return createResultEnvelope('signature', raw);
  }

  async importResult(envelope) {
    if (envelope === null) {
      await this._discardFormResult();
      return;
    }
    const raw = readResultEnvelope(envelope, 'signature');
    if (
      !Array.isArray(raw?.sets) || !Array.isArray(raw.unscored) || typeof raw.method !== 'string' ||
      (raw.groupBy !== null && (typeof raw.groupBy !== 'string' || raw.groupBy.length === 0)) ||
      typeof raw.counts !== 'boolean' || !isValuesRecord(raw.values)
    ) {
      throw new TypeError('A gene signature result must hold its sets, what they were scored by and their values');
    }
    const categories = raw.groupBy === null ? null : await this._requireGroupField(raw.groupBy);
    // The gene sample the pages were scored on (`computeSignatureScore`):
    // each page's cells among the first `cells` open cells; null when every
    // open cell's genes were read.
    const geneSample = raw.geneSample ?? null;
    if (geneSample !== null && (typeof geneSample !== 'object' || !Number.isSafeInteger(geneSample.cells) || geneSample.cells < 1
      || !Number.isSafeInteger(geneSample.of) || geneSample.of < geneSample.cells || !Array.isArray(geneSample.groups))) {
      throw new TypeError('A gene signature result\'s gene sample must name its cells, of how many, and its groups');
    }
    for (const set of raw.sets) {
      await requireDatasetGenes(this.dataLayer, [...set.genes, ...set.controlGenes], 'The gene signature result');
      if (categories !== null) {
        this._requireCategoryGroups(set.pages, categories, raw.groupBy);
        continue;
      }
      requireDatasetPages(this.dataLayer, set.pages.map(page => page?.pageId), 'The gene signature result');
      for (const page of set.pages) {
        if (!ArrayBuffer.isView(page.scores) || !ArrayBuffer.isView(page.cellIndices)) {
          throw new TypeError(`Gene signature scores of "${page.pageId}" and their cells must be typed arrays`);
        }
        // The cells it was scored on: the page's, or those of them genes were read for.
        const [asked] = this.dataLayer.getPageCells([page.pageId]);
        const cells = cellsReadFor(asked.cellIndices, geneSample);
        const among = geneSample === null ? '' : ` among the first ${formatCountOf(geneSample.cells, 'open cell')}, those genes were read for`;
        if (page.scores.length !== cells.length || page.cellIndices.length !== cells.length) {
          throw new RangeError(
            `Gene signature result holds ${page.scores.length} scores for cell group ` +
            `"${page.pageId}", which now has ${formatCountOf(cells.length, 'cell')}${among}`
          );
        }
        for (let index = 0; index < cells.length; index++) {
          if (page.cellIndices[index] !== cells[index]) {
            throw new RangeError(`Gene signature result scored other cells of cell group "${page.pageId}" than it holds now${among}`);
          }
        }
      }
    }
    const result = await this._buildResult(raw, this._requireOptions());
    await this._restoreAnalysisResult(result, envelope.provenance);
  }

  /** The categories of a result's Group by field, which the dataset must still have. */
  async _requireGroupField(fieldKey) {
    if (this.dataLayer.getVariableInfo('categorical_obs', fieldKey) === null) {
      throw new Error(`The gene signature result groups by "${fieldKey}", which this dataset lacks`);
    }
    return this.dataLayer.ensureObsFieldLoaded(fieldKey);
  }

  /**
   * A result's category groups, checked against the field: each a category
   * it has, its scores one a cell, its cells ascending and each of that
   * category now.
   */
  _requireCategoryGroups(groups, field, fieldKey) {
    const codeOf = new Map(field.categories.map((category, code) => [categoryGroupId(String(category)), code]));
    const pointCount = field.codes.length;
    for (const group of groups) {
      const code = codeOf.get(group?.pageId);
      if (code === undefined) {
        throw new Error(`The gene signature result scores group "${group?.pageName}", which field "${fieldKey}" lacks`);
      }
      if (!ArrayBuffer.isView(group.scores) || !(group.cellIndices instanceof Uint32Array) || group.scores.length !== group.cellIndices.length) {
        throw new TypeError(`Gene signature scores of "${group.pageName}" and their cells must be typed arrays of one length`);
      }
      let previous = -1;
      for (const cell of group.cellIndices) {
        if (cell <= previous || cell >= pointCount || field.codes[cell] !== code) {
          throw new RangeError(`The gene signature result scored cells of group "${group.pageName}" that are not of it now`);
        }
        previous = cell;
      }
    }
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  destroy() {
    if (this._destroyPromise != null) return this._destroyPromise;
    this._isDestroyed = true;
    const errors = [];
    try {
      this._pageSelector?.destroy();
    } catch (error) {
      errors.push(error);
    }
    this._pageSelector = null;
    this._pageSelectContainer = null;
    const parentTask = super.destroy();
    if (errors.length === 0) return parentTask;
    const destruction = Promise.resolve(parentTask).then(
      () => {
        throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Gene signature UI cleanup failed');
      },
      parentError => {
        throw new AggregateError([...errors, parentError], 'Gene signature UI cleanup failed');
      }
    );
    this._destroyPromise = destruction;
    void destruction.catch(() => {});
    return destruction;
  }
}

/**
 * Rescale the drawn scores: z-score (population sd) or 0–1, per set over
 * every page it was scored on, sliced so a large page does not hold the
 * thread.
 */
async function rescaleScores(data, method) {
  if (method === 'none') return;
  const yieldIfSliceSpent = createSlicedYield();
  const pause = async () => {
    const pending = yieldIfSliceSpent();
    if (pending !== undefined) await pending;
  };
  // Each set on its own scale, over every page it was scored on: pages stay
  // comparable, and two sets' scores are not mixed into one mean.
  const pagesBySet = new Map();
  for (const page of data) {
    const pages = pagesBySet.get(page.setName) ?? [];
    pages.push(page);
    pagesBySet.set(page.setName, pages);
  }
  for (const pages of pagesBySet.values()) {
    let count = 0;
    let mean = 0;
    let m2 = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const page of pages) {
      const values = page.values;
      for (let i = 0; i < values.length; i++) {
        if ((i & 0xffff) === 0xffff) await pause();
        const x = values[i];
        if (!isFiniteNumber(x)) continue;
        count++;
        const delta = x - mean;
        mean += delta / count;
        m2 += delta * (x - mean);
        if (x < min) min = x;
        if (x > max) max = x;
      }
    }
    if (count === 0) continue;
    const scale = method === 'zscore' ? (Math.sqrt(m2 / count) || 1) : ((max - min) || 1);
    const shift = method === 'zscore' ? mean : min;
    for (const page of pages) {
      const values = page.values;
      for (let i = 0; i < values.length; i++) {
        if ((i & 0xffff) === 0xffff) await pause();
        const x = values[i];
        values[i] = isFiniteNumber(x) ? (x - shift) / scale : NaN;
      }
    }
  }
}

/**
 * Factory function to create the gene signature UI
 * @param {Object} options
 * @returns {GeneSignatureUI}
 */
export function createGeneSignatureUI(options) {
  const ui = new GeneSignatureUI(options);
  ui.init(options.container);
  return ui;
}
