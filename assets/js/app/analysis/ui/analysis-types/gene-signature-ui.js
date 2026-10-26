/**
 * Gene signature: score every cell by one or more gene sets and compare the
 * scores across pages.
 *
 * The form is the options schema's (`options/signature-options.js`): the
 * gene sets (`ui/components/gene-set-editor.js`), the pages, Run; scoring
 * and display under More options. Typing never runs: a change after a run
 * dims the result with "Stale · Run". Genes the dataset does not have are
 * left out of the score and named in the result ("2 not found").
 *
 * @module analysis-types/gene-signature-ui
 */

import { formatCount, formatCountOf } from '../../../../utils/format-units.js';
import { FormBasedAnalysisUI } from './base/form-based-analysis.js';
import { downloadCSV } from '../../shared/analysis-utils.js';
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
import { createGeneIndex, resolveGenes } from '../../shared/gene-sets.js';
import { writePerCellCSV } from '../base-analysis-ui.js';

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
      getGenes: () => this._geneNames(),
      getMarkerSets: () => {
        const sets = this.comparisonModule?.getUIManager?.()?.getUI?.('genesPanel')?.getMarkerGeneSets?.() ?? [];
        return sets.length > 0 ? sets : null;
      }
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
      this._geneIndex = createGeneIndex(this._names);
    }
    return this._names;
  }

  /** Each set's genes matched to the dataset. */
  _resolveSets(geneSets) {
    this._geneNames();
    return geneSets.map(set => ({ name: set.name, ...resolveGenes(set.genes, this._geneIndex) }));
  }

  _getRunBlocker(options) {
    if (this._selectedPages.length === 0) return 'Select at least one page';
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
        this._selectedPages = pageIds || [];
        this._currentConfig.pages = this._selectedPages;
        this._updateRunRow();
        this._updateStale();
      },
      onColorChange: (pageId, color) => this.dataLayer?.setPageColor?.(pageId, color),
      showColorPicker: true,
      showCellCounts: true,
      showSelectAll: true,
      initialSelection: this._selectedPages.length > 0 ? this._selectedPages : undefined,
      includeDerivedPages: true,
      getCellCountForPageId: pageId => this.dataLayer.getCellCountForPageId(pageId),
      label: 'Pages'
    });
    this._selectedPages = this._pageSelector.getSelectedPages();
    this._currentConfig.pages = [...this._selectedPages];
  }

  // ===========================================================================
  // Run
  // ===========================================================================

  async _runAnalysisImpl(options, requestId, job) {
    const pageIds = [...this._selectedPages];
    const resolution = this._resolveSets(options.geneSets);
    const scored = resolution.filter(set => set.resolved.length > 0);
    const result = await this.multiVariableAnalysis.computeSignatureScore({
      geneSets: scored.map(set => ({ name: set.name, genes: set.resolved })),
      pageIds,
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
          pageId: page.pageId,
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
    const built = await this._buildResult({ sets, unscored, method: options.method }, options);
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
    for (const set of shown) {
      for (const page of set.pages) {
        data.push({
          pageId: multiple ? `${page.pageId}::${set.name}` : page.pageId,
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
      options: { showPoints: 'outliers', showMean: true },
      title: 'Gene signature',
      subtitle: raw.sets.length === 1
        ? `${raw.sets[0].name} · ${formatCountOf(raw.sets[0].genes.length, 'gene')} · ${METHOD_LABELS[raw.method]}`
        : `${formatCountOf(raw.sets.length, 'set')} · ${formatCountOf(geneCount, 'gene')} · ${METHOD_LABELS[raw.method]}`,
      metadata: { method: raw.method }
    };
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

  /** CSV: `page,set,cell_index,score`, every finite score of every set. */
  async _exportModalCSV() {
    const raw = this._lastResult?.raw;
    if (!raw) return;
    try {
      const pages = raw.sets.flatMap(set => set.pages.map(page => ({
        pageName: page.pageName,
        setName: set.name,
        values: page.scores,
        cellIndices: page.cellIndices
      })));
      const csv = await writePerCellCSV('signature-scores', pages);
      downloadCSV(csv, 'gene_signature_scores', this._notifications);
    } catch (err) {
      this._notifications.error(`CSV export failed: ${err.message}`, { category: 'download' });
    }
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

  /**
   * The shown result for a session: every set's raw scores per page (typed
   * columns), its genes, controls and genes not found.
   * @returns {null|{kind: 'signature', version: number, payload: unknown}}
   */
  exportResult() {
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
    if (!Array.isArray(raw?.sets) || !Array.isArray(raw.unscored) || typeof raw.method !== 'string') {
      throw new TypeError('A gene signature result must hold its sets');
    }
    for (const set of raw.sets) {
      await requireDatasetGenes(this.dataLayer, [...set.genes, ...set.controlGenes], 'The gene signature result');
      requireDatasetPages(this.dataLayer, set.pages.map(page => page?.pageId), 'The gene signature result');
      for (const page of set.pages) {
        if (!ArrayBuffer.isView(page.scores)) {
          throw new TypeError(`Gene signature scores of "${page.pageId}" must be a typed array`);
        }
        const cellCount = this.dataLayer.getCellCountForPageId(page.pageId);
        if (page.scores.length !== cellCount) {
          throw new RangeError(
            `Gene signature result holds ${page.scores.length} scores for cell group ` +
            `"${page.pageId}", which now has ${formatCountOf(cellCount, 'cell')}`
          );
        }
      }
    }
    const result = await this._buildResult(raw, this._requireOptions());
    await this._restoreAnalysisResult(result);
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
