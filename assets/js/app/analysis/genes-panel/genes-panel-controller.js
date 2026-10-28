/**
 * Genes Panel Controller
 *
 * Turns the marker options (`options/marker-options.js`) into a run: the
 * groups of the field in the cell scope, which are tested and against what
 * (the small-group policy decides, never an error), the genes tested, the
 * fold-change mode; then runs marker discovery, or answers from the cache.
 * Filters, ranking and the number shown are the UI's, applied to the full
 * statistics a run returns (`marker-selection.js`).
 *
 * @module genes-panel/genes-panel-controller
 */

import { MarkerDiscoveryEngine, describeMarkerRun } from './marker-discovery-engine.js';
import { ClusteringEngine } from './clustering-engine.js';
import { MarkerCache } from './marker-cache.js';
import { computeCategoryGroupingDigest } from '../data/data-layer.js';
import {
  isCategoricalCodes,
  missingCategoryCode
} from '../../../data/categorical-storage-contract.js';
import { ANALYSIS_PHASES, ERROR_MESSAGES, formatError } from './constants.js';
import { getDataSourceManager } from '../../../data/data-source-manager.js';
import { residencyBudgetBytes } from '../../../data/memory-budget.js';
import { getMemoryMonitor } from '../shared/memory-monitor.js';
import { createGeneIndex, filterGenes, geneIdentities, parseGeneText, resolveGenes } from '../shared/gene-sets.js';
import { geneMomentsFor } from '../shared/gene-moments-cache.js';
import { formatCount, formatCountOf } from '../../../utils/format-units.js';

/** Synthetic id of a category's group. */
export const GROUP_ID_PREFIX = 'category-code:';
/** Synthetic id of the pooled small groups. */
export const POOLED_GROUP_ID = 'pooled:small';

const DEFAULT_GROUP_PALETTE = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'
];

/** A short digest of a cell scope (null: every cell). */
function scopeDigest(scope) {
  if (scope === null) return 'all';
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let count = 0;
  for (let i = 0; i < scope.length; i++) {
    if (scope[i] === 0) continue;
    count++;
    h1 = Math.imul(h1 ^ i, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (i >>> 3), 0x5bd1e995) >>> 0;
  }
  return `${count}:${h1.toString(16)}:${h2.toString(16)}`;
}

/** The label a category is chosen by in the options (`testGroups`, `referenceGroup`). */
export function categoryOptionId(label) {
  return String(label);
}

export class GenesPanelController {
  /**
   * @param {Object} options
   * @param {Object} options.dataLayer - DataLayer instance
   */
  constructor({ dataLayer }) {
    if (!dataLayer) throw new Error('[GenesPanelController] dataLayer is required');
    this.dataLayer = dataLayer;
    this._engine = new MarkerDiscoveryEngine({ dataLayer });
    this._clusteringEngine = new ClusteringEngine();
    this._cache = new MarkerCache({ identity: this._getCacheIdentity() });
    this._closed = false;
    this._pressureUnsubscribe = getMemoryMonitor().onMemoryPressure(event => {
      if (event?.level === 'warning' || event?.level === 'cleanup' || event?.level === 'critical') {
        this._cache.trim();
      }
    });
  }

  _assertOpen() {
    if (this._closed) throw new Error('[GenesPanelController] controller is closed');
  }

  // ===========================================================================
  // Groups
  // ===========================================================================

  /**
   * The cells a "Cells" choice scopes a run to: null for every cell, else one
   * byte a cell.
   * @param {string} cells - 'all', 'visible' or 'page:<id>'
   * @returns {Uint8Array|null}
   */
  scopeOf(cells) {
    if (cells === 'all') return null;
    if (cells === 'visible') return this.dataLayer.getVisibleCellMask();
    if (typeof cells === 'string' && cells.startsWith('page:')) {
      const [{ cellIndices }] = this.dataLayer.getPageCells([cells.slice('page:'.length)]);
      const scope = new Uint8Array(this.dataLayer.state.pointCount);
      for (let i = 0; i < cellIndices.length; i++) scope[cellIndices[i]] = 1;
      return scope;
    }
    throw new RangeError(`Unknown cell scope ${String(cells)}`);
  }

  /**
   * The categories of a field with their cells in a scope, largest first.
   *
   * @param {string} field
   * @param {Uint8Array|null} scope
   * @returns {Promise<{codes: Uint8Array|Uint16Array|Uint32Array, categories: Array, groups: Array<{groupId: string, optionId: string, groupName: unknown, code: number, count: number, color: string}>}>}
   */
  async describeGroups(field, scope = null) {
    this._assertOpen();
    const fieldData = await this.dataLayer.ensureObsFieldLoaded(field, { silent: true });
    if (fieldData === null || typeof fieldData !== 'object' || fieldData.kind !== 'category') {
      throw new Error(formatError(ERROR_MESSAGES.NO_CATEGORICAL_OBS));
    }
    const { codes, categories, colors = {} } = fieldData;
    if (!isCategoricalCodes(codes) || codes.length === 0 || !Array.isArray(categories)) {
      throw new Error(formatError(ERROR_MESSAGES.NO_CATEGORICAL_OBS));
    }
    const missing = missingCategoryCode(codes);
    const counts = new Uint32Array(categories.length);
    if (scope === null) {
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code !== missing && code < counts.length) counts[code]++;
      }
    } else {
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (scope[i] !== 0 && code !== missing && code < counts.length) counts[code]++;
      }
    }
    const groups = [];
    for (let code = 0; code < categories.length; code++) {
      if (counts[code] === 0) continue;
      const label = categories[code];
      const declared = typeof label === 'string' && Object.hasOwn(colors, label) ? colors[label] : undefined;
      groups.push({
        groupId: `${GROUP_ID_PREFIX}${code}`,
        optionId: categoryOptionId(label),
        groupName: label,
        code,
        count: counts[code],
        color: typeof declared === 'string' && declared.length > 0 ? declared : DEFAULT_GROUP_PALETTE[code % DEFAULT_GROUP_PALETTE.length]
      });
    }
    groups.sort((a, b) => b.count - a.count || a.code - b.code);
    return { codes, categories, groups };
  }

  /**
   * Who is tested against what, by the options: never an error. A small
   * group is skipped (it stays in the rest), pooled, or tested and flagged;
   * `blocker` says why nothing can run.
   *
   * @param {Object} options - The marker options record
   * @param {{codes: ArrayLike<number>, groups: Object[]}} described - `describeGroups`
   */
  plan(options, described) {
    const { groups: present } = described;
    const minCells = options.minCells;
    const selected = options.testGroups.mode === 'all'
      ? null
      : new Set(options.testGroups.ids);
    const isSelected = group => selected === null || selected.has(group.optionId);
    const restMode = options.compareAgainst === 'rest';
    // No reference group chosen ('') is the largest group (`present` is
    // sorted largest first).
    const referenceGroup = restMode
      ? null
      : (options.referenceGroup === ''
        ? present[0] ?? null
        : present.find(group => group.optionId === options.referenceGroup) ?? null);
    const restOnlySelected = restMode && selected !== null && options.restIncludes === 'selected';
    const policy = options.smallGroups;

    const columns = [];
    const pooledMembers = [];
    const skipped = [];
    const lowN = [];
    for (const group of present) {
      // With the reference a group, only it and the tested groups are compared.
      if (!restMode && group !== referenceGroup && !isSelected(group)) continue;
      if (restOnlySelected && !isSelected(group)) continue;
      const small = group.count < minCells;
      const candidate = isSelected(group) && group !== referenceGroup;
      let tested = candidate;
      let smallFate = null;
      if (candidate && small) {
        if (policy === 'skip') {
          tested = false;
          smallFate = 'skipped';
          skipped.push(group);
        } else if (policy === 'pool') {
          pooledMembers.push(group);
          continue;
        } else if (group.count < 2) {
          tested = false;
          smallFate = 'skipped';
          skipped.push(group);
        } else {
          lowN.push(group);
        }
      }
      columns.push({ ...group, tested, small, smallFate, members: [group.code] });
    }
    let pooled = null;
    if (pooledMembers.length > 0) {
      const count = pooledMembers.reduce((sum, group) => sum + group.count, 0);
      const tested = count >= minCells;
      pooled = {
        groupId: POOLED_GROUP_ID,
        optionId: POOLED_GROUP_ID,
        groupName: `Other small groups (${pooledMembers.length})`,
        code: -1,
        count,
        color: '#9e9e9e',
        tested,
        small: !tested,
        smallFate: tested ? 'pooled' : 'skipped',
        members: pooledMembers.map(group => group.code)
      };
      if (!tested) skipped.push(pooled);
      columns.push(pooled);
    }

    const testedCount = columns.filter(group => group.tested).length;
    let blocker = null;
    if (present.length < 2 && restMode) {
      blocker = formatError(ERROR_MESSAGES.TOO_FEW_GROUPS, { n: present.length });
    } else if (!restMode && referenceGroup === null) {
      blocker = 'Choose the reference group';
    } else if (!restMode && referenceGroup.count < Math.max(2, policy === 'test' ? 2 : minCells)) {
      blocker = `The reference group has fewer than ${formatCountOf(policy === 'test' ? 2 : minCells, 'cell')}`;
    } else if (selected !== null && selected.size === 0) {
      blocker = 'Choose groups to test';
    } else if (testedCount === 0) {
      blocker = `No group to test has ${formatCountOf(minCells, 'cell')} or more`;
    } else if (columns.length < 2) {
      blocker = formatError(ERROR_MESSAGES.TOO_FEW_GROUPS, { n: columns.length });
    }

    return {
      columns,
      skipped,
      pooled: pooled === null ? [] : pooledMembers,
      lowN,
      referenceIndex: referenceGroup === null ? -1 : columns.findIndex(group => group.groupId === referenceGroup.groupId),
      minCellsPerSide: policy === 'test' ? 2 : Math.max(2, minCells),
      testedCount,
      blocker
    };
  }

  // ===========================================================================
  // Genes
  // ===========================================================================

  /**
   * The genes a run tests, by the gene filters: those of its expression
   * matrix, named on that matrix's axis (`options.matrix`).
   * @param {Object} options
   * @returns {Promise<string[]>}
   */
  async genesToTest(options) {
    const all = await this.dataLayer.getGeneKeys(options.matrix);
    if (all.length === 0) throw new Error(formatError(ERROR_MESSAGES.NO_GENES_AVAILABLE));
    let only = null;
    if (options.onlyGenes === 'hvg') {
      const hvg = await this.dataLayer.state.varFieldLoader.highlyVariableGenes();
      only = new Set(Array.isArray(hvg) ? hvg : []);
    } else if (options.onlyGenes === 'list') {
      only = new Set(resolveGenes(parseGeneText(options.onlyGenesList), createGeneIndex(all, geneIdentities(this.dataLayer.state?.varData))).resolved);
    }
    return filterGenes(all, { exclude: options.excludeGenes, pattern: options.excludePattern, only });
  }

  /**
   * The fold change a run reports: undoing log1p when asked, or when the
   * file says its matrix is log1p'd (`uns['log1p']`) and "Automatic" is
   * chosen; as stored otherwise.
   * @param {'auto'|'log1p'|'stored'} choice
   * @param {string} [matrix='mapped'] - The expression matrix read: its own
   *   log1p record is the one that counts
   * @returns {{mode: 'stored'|'log1p', base: number|null}}
   */
  foldChangeOf(choice, matrix = 'mapped') {
    const loader = this.dataLayer.state?.varFieldLoader ?? null;
    const read = matrix === 'mapped' ? null : this.dataLayer.resolveExpressionMatrix(matrix).matrix;
    const log1p = loader === null ? null : loader.log1p(read === null ? {} : { matrix: read });
    if (choice === 'log1p') return { mode: 'log1p', base: log1p?.base ?? null };
    if (choice === 'auto' && log1p !== null) return { mode: 'log1p', base: log1p.base ?? null };
    return { mode: 'stored', base: null };
  }

  // ===========================================================================
  // Run
  // ===========================================================================

  /**
   * Run marker discovery for an options record.
   *
   * @param {Object} params
   * @param {Object} params.options - The marker options record
   * @param {import('../../jobs/cancellable-job.js').CancellableJob|null} [params.job]
   * @param {AbortSignal|null} [params.signal]
   * @param {Object|null} [params.sample] - A first pass's cells
   *   (`shared/progressive-cells.js`); null for every cell
   * @returns {Promise<{stats: Object, plan: Object, metadata: Object}>}
   */
  async runAnalysis({ options, job = null, signal = job?.signal ?? null, sample = null }) {
    this._assertOpen();
    this._cache.setIdentity(this._getCacheIdentity());
    const startTime = performance.now();
    job?.step(ANALYSIS_PHASES.INIT);
    // A first pass (`shared/progressive-cells.js`): the scope's cells in the sample.
    const scope = sample === null ? this.scopeOf(options.cells) : sample.mask(this.scopeOf(options.cells));
    const described = await this.describeGroups(options.groupBy, scope);
    if (signal?.aborted) throw signal.reason;
    const plan = this.plan(options, described);
    if (plan.blocker !== null) throw new Error(plan.blocker);
    const genes = await this.genesToTest(options);
    if (genes.length === 0) throw new Error(formatError(ERROR_MESSAGES.NO_GENES_TO_TEST));
    const foldChange = this.foldChangeOf(options.foldChange, options.matrix);
    const matrix = this.dataLayer.resolveExpressionMatrix(options.matrix);
    const allGenes = await this.dataLayer.getGeneKeys(options.matrix);

    const { columns } = plan;
    const codeToGroupIndex = new Int32Array(described.categories.length).fill(-1);
    columns.forEach((group, index) => {
      for (const code of group.members) codeToGroupIndex[code] = index;
    });
    const tested = Uint8Array.from(columns, group => (group.tested ? 1 : 0));
    const method = options.method;
    const pConvention = method === 'wilcox' ? options.pConvention : 'exact';

    const cacheParams = {
      field: options.groupBy,
      grouping: computeCategoryGroupingDigest(described.codes),
      scope: scopeDigest(scope),
      columns: columns.map(group => [group.groupId, group.tested, group.members]),
      reference: plan.referenceIndex,
      minCellsPerSide: plan.minCellsPerSide,
      method,
      pConvention,
      correction: options.correction,
      foldChange,
      matrix: matrix.read ?? 'mapped',
      genes: genes.length === allGenes.length ? 'all' : genes
    };
    job?.setPlan(describeMarkerRun({ geneCount: genes.length, testedCount: plan.testedCount, groupCount: columns.length }));

    let stats = this._cache.get(cacheParams);
    const cached = stats !== null;
    if (!cached) {
      // Gene moments of the mapped matrix serve the module score later.
      const moments = matrix.read === null ? geneMomentsFor(this.dataLayer.getDatasetGeneration()) : null;
      stats = await this._engine.discoverMarkers({
        grouping: {
          codes: described.codes,
          codeToGroupIndex,
          groupCount: columns.length,
          tested,
          reference: plan.referenceIndex,
          scope
        },
        genes,
        method,
        pConvention,
        correction: options.correction,
        foldChange,
        minCellsPerSide: plan.minCellsPerSide,
        job,
        signal,
        readOwner: job?.id ?? null,
        matrix: options.matrix,
        onGeneMoments: moments === null ? null : (gene, value) => moments.set(gene, value)
      });
      stats.groups = columns.map(group => ({
        groupId: group.groupId,
        groupName: group.groupName,
        cellCount: group.count,
        color: group.color,
        tested: group.tested,
        small: group.small,
        smallFate: group.smallFate,
        reference: plan.referenceIndex >= 0 && columns[plan.referenceIndex] === group
      }));
      this._cache.set(cacheParams, stats);
    }
    if (signal?.aborted) throw signal.reason;

    return {
      stats,
      plan,
      metadata: {
        groupBy: options.groupBy,
        matrix: options.matrix,
        matrixLabel: matrix.label,
        method,
        pConvention,
        correction: options.correction,
        foldChange,
        minCellsPerSide: plan.minCellsPerSide,
        geneCount: genes.length,
        groupCount: columns.length,
        testedCount: plan.testedCount,
        skippedGroups: plan.skipped.map(group => ({ name: String(group.groupName), cells: group.count })),
        pooledGroups: plan.pooled.map(group => ({ name: String(group.groupName), cells: group.count })),
        lowNGroups: plan.lowN.map(group => ({ name: String(group.groupName), cells: group.count })),
        cached,
        durationMs: Math.round(performance.now() - startTime),
        tuning: cached ? null : stats.tuning
      }
    };
  }

  /**
   * Cluster a heatmap matrix.
   * @param {Object} matrix
   * @param {{distance: string, linkage: string, clusterRows: boolean, clusterCols: boolean, signal?: AbortSignal|null}} options
   *   `signal` stops the clustering's worker tasks (a superseded run or redraw).
   */
  cluster(matrix, { distance, linkage, clusterRows, clusterCols, signal = null }) {
    this._assertOpen();
    return this._clusteringEngine.clusterMatrix({
      matrix,
      distance,
      linkage,
      clusterRows,
      clusterCols,
      signal,
      memoryBudgetBytes: Math.max(1, Math.floor(residencyBudgetBytes('analysis')))
    });
  }

  /** Apply a clustering's order to its matrix. */
  applyOrdering(matrix, clustering) {
    return this._clusteringEngine.applyOrdering(matrix, clustering);
  }

  /** Forget cached runs. */
  clearCache() {
    this._cache.clear();
  }

  close() {
    if (this._closed) return Promise.resolve();
    this._closed = true;
    this._cache.close();
    this._pressureUnsubscribe?.();
    this._pressureUnsubscribe = null;
    return Promise.resolve();
  }

  // ===========================================================================
  // Identity
  // ===========================================================================

  _getCacheIdentity() {
    const manager = getDataSourceManager();
    const datasetId = manager.getCurrentDatasetId();
    if (typeof datasetId !== 'string' || datasetId.trim().length === 0) {
      throw new TypeError('An exact active datasetId is required for marker analysis');
    }
    const revision = manager.getCurrentSelectionRevision();
    const mapping = this.dataLayer.state?.getDataMapping?.();
    if (mapping === null || typeof mapping !== 'object' || typeof mapping.geneNames !== 'string') {
      throw new TypeError('Marker analysis requires the data mapping of the open dataset');
    }
    return {
      key: JSON.stringify(['load', datasetId, revision, mapping.expression ?? null, mapping.geneNames])
    };
  }
}
