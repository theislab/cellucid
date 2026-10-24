/**
 * Multi-Variable Analysis Module
 *
 * Provides advanced analysis capabilities for comparing multiple variables:
 * - Correlation analysis between two continuous variables
 * - Differential expression analysis between pages
 * - Multi-gene signature scoring
 *
 * Designed for scientists who need deeper insights beyond single-variable comparisons.
 */

import { getComputeManager } from '../compute/compute-manager.js';
import { OperationType } from '../compute/operations.js';
import { formatCount } from '../../ui/components/display-format.js';
import {
  createFrameThrottle,
  createSlicedYield
} from '../shared/concurrency-utils.js';
import { StreamingGeneLoader } from '../data/streaming-gene-loader.js';
import { isFiniteNumber } from '../shared/number-utils.js';
import { benjaminiHochbergTestable, bonferroniAdjusted } from './statistical-tests.js';
import { selectSorted } from '../compute/math-utils.js';
import { SignaturePageScorer } from './signature-score.js';
import { pseudobulkGeneTest, pseudobulkUnits } from './pseudobulk.js';
import { moduleScoreControls } from './module-score.js';
import { computeGeneMoments } from '../compute/operation-handlers.js';
import { geneMomentsFor, momentsMean, momentsStd } from '../shared/gene-moments-cache.js';
import { createRunTunerFor, runGeneStream, taskTiming } from '../shared/gene-stream-runner.js';
import { TUNER_WINDOW_GENES } from '../shared/run-tuner.js';
import { getWorkerPool } from '../compute/worker-pool.js';
import { startMemoryTracking } from '../shared/memory-tracker.js';
import { cleanupAnalysisResources } from '../shared/resource-cleanup.js';

function cleanupPreservingAnalysisFailure(
  operation,
  hasAnalysisFailure,
  analysisFailure
) {
  try {
    operation();
  } catch (cleanupFailure) {
    if (hasAnalysisFailure) {
      throw new AggregateError(
        [analysisFailure, cleanupFailure],
        'Analysis execution and cleanup both failed'
      );
    }
    throw cleanupFailure;
  }
}

function requireCurrentPredicate(value, label) {
  if (value === undefined) return () => true;
  if (typeof value !== 'function') {
    throw new TypeError(`${label} isCurrent must be a function when provided`);
  }
  return value;
}

function resolveRequestOwnership(options, label) {
  const currentPredicate = options.isCurrent;
  const isCurrent = requireCurrentPredicate(currentPredicate, label);
  const registerInvalidationCleanup = options.registerInvalidationCleanup;
  if (
    registerInvalidationCleanup !== undefined &&
    typeof registerInvalidationCleanup !== 'function'
  ) {
    throw new TypeError(
      `${label} registerInvalidationCleanup must be a function when provided`
    );
  }
  if (
    currentPredicate !== undefined &&
    registerInvalidationCleanup === undefined
  ) {
    throw new TypeError(
      `${label} requires registerInvalidationCleanup with isCurrent`
    );
  }
  return { isCurrent, registerInvalidationCleanup };
}

/** Bonferroni over the testable subset, as a boxed list (null where untested). */
function bonferroniTestable(pValues) {
  const { adjustedPValues, testedCount, untestableCount } = bonferroniAdjusted(pValues);
  return {
    adjustedPValues: Array.from(adjustedPValues, value => (Number.isFinite(value) ? value : null)),
    testedCount,
    untestableCount
  };
}

/** Whether two ascending index arrays share an element. */
function sortedIntersect(left, right) {
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) return true;
    if (left[i] < right[j]) i++;
    else j++;
  }
  return false;
}

/** Ascending cells, those in a scope (all when null), as a Uint32Array. */
export function cellsWithin(cells, within) {
  if (within === null) return Uint32Array.from(cells);
  let count = 0;
  for (let i = 0; i < cells.length; i++) if (within[cells[i]] !== 0) count++;
  const out = new Uint32Array(count);
  let k = 0;
  for (let i = 0; i < cells.length; i++) if (within[cells[i]] !== 0) out[k++] = cells[i];
  return out;
}

/** First position of an ascending index array at or past `value`. */
function lowerBoundOf(indices, value) {
  let lo = 0;
  let hi = indices.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (indices[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * UCell workers hold one module-global range context each, so one UCell run
 * owns them at a time; another waits for it.
 */
let ucellLease = Promise.resolve();
async function acquireUcellLease(signal) {
  const previous = ucellLease;
  let release;
  ucellLease = new Promise(resolve => { release = resolve; });
  await previous;
  if (signal?.aborted) {
    release();
    throw signal.reason;
  }
  return release;
}

const DE_PHASES = Object.freeze(['Loading & Computing', 'Multiple Testing Correction']);

/**
 * Progress of one differential expression run: genes done of how many, told
 * to `onProgress` at most once per frame (genes complete by the thousand per
 * second) and to the run's job (`app/jobs/cancellable-job.js`), if any.
 */
function createDifferentialProgress({ total, onProgress, isCurrent, job }) {
  let done = 0;
  let phaseIndex = 0;
  let stopped = false;
  const record = () => ({
    phase: DE_PHASES[phaseIndex],
    progress: Math.round((done / total) * 100),
    loaded: done,
    total,
    message: phaseIndex === 0
      ? `Analyzing genes (${done.toLocaleString()}/${total.toLocaleString()})`
      : 'Applying multiple testing correction...'
  });
  const updates = createFrameThrottle(update => {
    if (!stopped && isCurrent() && onProgress) onProgress(update);
  });
  const publish = () => {
    if (stopped) return;
    if (phaseIndex === 0) job?.items(done, total, 'genes');
    updates.push(record);
  };
  return {
    start() {
      job?.step('Testing genes');
      publish();
      updates.flush();
    },
    itemComplete(count = 1) {
      done += count;
      publish();
    },
    nextPhase() {
      phaseIndex = 1;
      job?.step('Applying multiple testing correction');
      publish();
      updates.flush();
    },
    /** No more updates: the run ended or is no longer wanted. */
    stop() {
      if (stopped) return;
      updates.flush();
      stopped = true;
      updates.cancel();
    }
  };
}

/**
 * Multi-Variable Analysis class
 */
/**
 * Finite values from which an order statistic is selected by an analysis
 * worker instead of on this thread.
 */
const ORDER_STATISTICS_WORKER_MIN = 500_000;

/** Names the two-group context of each differential expression run. */
let differentialContextCounter = 0;

export class MultiVariableAnalysis {
  /**
   * @param {import('../data/data-layer.js').DataLayer} dataLayer - Analysis data layer
   */
  constructor(dataLayer) {
    this.dataLayer = dataLayer;
    this._computeManager = null;
  }

  /**
   * Get the exact-backend compute manager, initialized for this run.
   *
   * `init()` is awaited on every call: it returns immediately while the
   * backends are healthy and discovers a fresh worker pool after a terminal
   * worker failure retired the previous one.
   */
  async _getComputeManager() {
    if (!this._computeManager) {
      this._computeManager = getComputeManager();
    }
    await this._computeManager.init();
    return this._computeManager;
  }

  // =========================================================================
  // Correlation Analysis
  // =========================================================================

  /**
   * Compute correlation between two continuous variables
   *
   * @param {Object} options
   * @param {Object} options.varX - { type: 'continuous_obs'|'gene_expression', key: string }
   * @param {Object} options.varY - { type: 'continuous_obs'|'gene_expression', key: string }
   * @param {string[]} options.pageIds - Pages to analyze
   * @param {string} [options.method='pearson'] - 'pearson' or 'spearman'
   * @param {import('../../jobs/cancellable-job.js').CancellableJob|null} [options.job] -
   *   The run's job: told each step; its signal stops the reads and tasks
   * @returns {Promise<Object[]>} Correlation results per page
  */
  async correlationAnalysis(options) {
    const memScope = startMemoryTracking('Correlation', 'correlationAnalysis', { includeUserAgent: true });
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Correlation analysis options are required');
    }
    const {
      varX,
      varY,
      pageIds,
      method = 'pearson',
      colorBy = null,
      job = null
    } = options;
    const { isCurrent } = resolveRequestOwnership(
      options,
      'Correlation analysis'
    );

    const allowedTypes = new Set([
      'categorical_obs',
      'continuous_obs',
      'gene_expression',
    ]);
    const requireVariable = (variable, owner) => {
      if (
        !variable ||
        typeof variable !== 'object' ||
        Array.isArray(variable) ||
        !allowedTypes.has(variable.type) ||
        typeof variable.key !== 'string' ||
        variable.key.length === 0 ||
        variable.key !== variable.key.trim()
      ) {
        throw new TypeError(
          `${owner} must contain one exact data type and non-empty key`
        );
      }
    };
    try {
      requireVariable(varX, 'varX');
      requireVariable(varY, 'varY');
      // A categorical page holds category codes, which are not quantities.
      for (const [variable, owner] of [[varX, 'varX'], [varY, 'varY']]) {
        if (variable.type === 'categorical_obs') {
          throw new TypeError(`Correlation ${owner} must be a continuous variable or a gene`);
        }
      }
      if (
        !Array.isArray(pageIds) ||
        pageIds.length === 0 ||
        pageIds.some(
          pageId =>
            typeof pageId !== 'string' ||
            pageId.length === 0 ||
            pageId !== pageId.trim()
        ) ||
        new Set(pageIds).size !== pageIds.length
      ) {
        throw new TypeError(
          'Correlation pageIds must be unique non-empty strings'
        );
      }
      if (!['pearson', 'spearman'].includes(method)) {
        throw new TypeError(`Unknown correlation method: ${String(method)}`);
      }
      if (colorBy !== null) requireVariable(colorBy, 'colorBy');
      if (!isCurrent()) {
        memScope.end({ stale: true });
        return null;
      }
    } catch (error) {
      memScope.end({ error: 'Invalid options' });
      throw error;
    }

    const ownedVarX = { type: varX.type, key: varX.key };
    const ownedVarY = { type: varY.type, key: varY.key };
    const ownedColorBy = colorBy === null
      ? null
      : { type: colorBy.type, key: colorBy.key };
    const ownedPageIds = [...pageIds];
    const signal = job?.signal ?? null;
    if (!isCurrent()) {
      memScope.end({ method, stale: true });
      return null;
    }

    try {
      // Fetch data for variables in parallel (including colorBy if specified)
      job?.step('Reading the variables');
      const fetchPromises = [
        this.dataLayer.getDataForPages({
          type: ownedVarX.type,
          variableKey: ownedVarX.key,
          pageIds: ownedPageIds,
          silent: true,
          signal,
          owner: job?.id ?? null,
        }),
        this.dataLayer.getDataForPages({
          type: ownedVarY.type,
          variableKey: ownedVarY.key,
          pageIds: ownedPageIds,
          silent: true,
          signal,
          owner: job?.id ?? null,
        })
      ];

      // Fetch color variable if specified
      if (ownedColorBy !== null) {
        fetchPromises.push(
          this.dataLayer.getDataForPages({
            type: ownedColorBy.type,
            variableKey: ownedColorBy.key,
            pageIds: ownedPageIds,
            silent: true,
            signal,
            owner: job?.id ?? null,
          })
        );
      }

      const [dataX, dataY, dataColor] = await Promise.all(fetchPromises);
      job?.step('Computing the correlation');
      if (!isCurrent()) {
        memScope.end({ method, stale: true });
        return null;
      }

      const results = [];
      const computeManager = await this._getComputeManager();
      if (!isCurrent()) {
        memScope.end({ method, stale: true });
        return null;
      }
      const maxPlotPoints = 50000;

      // Each page is aligned here and its correlation started on a worker
      // before the next page is aligned, so the pages compute at the same time.
      const pending = [];
      try {
        for (let i = 0; i < ownedPageIds.length; i++) {
          if (!isCurrent()) {
                memScope.end({ method, stale: true });
            return null;
          }
          const pageId = ownedPageIds[i];
          const pageX = dataX.find(d => d.pageId === pageId);
          const pageY = dataY.find(d => d.pageId === pageId);
          const pageColor = dataColor?.find(d => d.pageId === pageId);

          if (!pageX || !pageY) {
            throw new Error(
              `Correlation page "${pageId}" is missing one or both selected variables`
            );
          }
          if (ownedColorBy !== null && !pageColor) {
            throw new Error(
              `Correlation page "${pageId}" is missing the selected color variable`
            );
          }

          // Align values by cell index (including color if available)
          const { xAligned, yAligned, xPlot, yPlot, colorPlot, sampled } = await this._alignValuesByIndex(
            pageX.cellIndices, pageX.values,
            pageY.cellIndices, pageY.values,
            {
              maxPlotPoints,
              colorIndices: pageColor?.cellIndices,
              colorValues: pageColor?.values,
              // A categorical colour page holds codes: the plot is coloured by
              // their labels (null for a missing category).
              colorCategories: pageColor?.categories,
              colorMissingCode: pageColor?.missingCode
            }
          );

          if (xAligned.length < 3) {
            throw new RangeError(
              `Correlation page "${pageId}" requires at least 3 paired values; ` +
              `received ${xAligned.length}`
            );
          }

          // If we keep full arrays for plotting, avoid transferring them (so
          // they are not detached). If we sampled for plotting, transfer
          // (frees memory on the calling side).
          pending.push({
            pageId,
            pageName: pageX.pageName,
            xPlot,
            yPlot,
            colorPlot,
            sampled,
            correlation: computeManager.execute(
              OperationType.COMPUTE_CORRELATION,
              { xValues: xAligned, yValues: yAligned, method },
              { transfer: sampled, signal }
            )
          });
        }

        const correlations = await Promise.all(pending.map(page => page.correlation));
        if (!isCurrent()) {
            memScope.end({ method, stale: true });
          return null;
        }
        for (const [index, page] of pending.entries()) {
          const result = {
            pageId: page.pageId,
            pageName: page.pageName,
            ...correlations[index],
            xValues: page.xPlot,
            yValues: page.yPlot,
            xVariable: ownedVarX.key,
            yVariable: ownedVarY.key,
            sampled: page.sampled
          };

          // Include color data if available
          if (ownedColorBy !== null) {
            result.colorValues = page.colorPlot;
            result.colorVariable = ownedColorBy.key;
          }

          results.push(result);
        }
      } finally {
        // A page that failed before every computation was awaited leaves the
        // others observed.
        void Promise.allSettled(pending.map(page => page.correlation));
      }

      memScope.end({ pages: ownedPageIds.length, method });
      return results;

    } catch (error) {
      if (!isCurrent()) {
        memScope.end({ method, stale: true });
        return null;
      }
      memScope.end({ method, error: error.message });
      throw error;
    }
  }

  /**
   * Align two value arrays by matching cell indices.
   *
   * Returns paired finite values as Float32Arrays so they can be transferred to workers
   * without pulling on DataLayer-owned buffers.
   *
   * For plotting, returns either full arrays (when small) or a downsampled copy.
   *
   * @param {ArrayLike<number>} indicesA
   * @param {ArrayLike<number>} valuesA
   * @param {ArrayLike<number>} indicesB
   * @param {ArrayLike<number>} valuesB
   * @param {{ maxPlotPoints?: number, colorIndices?: ArrayLike<number>, colorValues?: ArrayLike<string> }} [options]
   * @returns {Promise<{ xAligned: Float32Array, yAligned: Float32Array, colorAligned?: string[], xPlot: Float32Array, yPlot: Float32Array, colorPlot?: string[], sampled: boolean }>}
  * @private
  */
  async _alignValuesByIndex(indicesA, valuesA, indicesB, valuesB, options = {}) {
    // Every pass walks every paired cell on this thread, so the passes hand
    // the event loop back between slices of a large page.
    const yieldIfSliceSpent = createSlicedYield();
    let steps = 0;
    const pause = () => yieldIfSliceSpent();
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Correlation alignment options must be an object');
    }
    const maxPlotPoints = options.maxPlotPoints === undefined
      ? 50000
      : options.maxPlotPoints;
    if (!Number.isSafeInteger(maxPlotPoints) || maxPlotPoints <= 0) {
      throw new TypeError('maxPlotPoints must be a positive safe integer');
    }
    const requireAlignedPayload = async (indices, values, owner) => {
      if (
        indices === null ||
        indices === undefined ||
        values === null ||
        values === undefined ||
        !Number.isSafeInteger(indices.length) ||
        !Number.isSafeInteger(values.length) ||
        indices.length !== values.length
      ) {
        throw new TypeError(
          `${owner} indices and values must be equal-length array-like collections`
        );
      }
      let previous = -1;
      for (let index = 0; index < indices.length; index++) {
        if ((++steps & 0xfffff) === 0) {
          const pending = pause();
          if (pending !== undefined) await pending;
        }
        const cellIndex = indices[index];
        if (
          !Number.isSafeInteger(cellIndex) ||
          cellIndex < 0 ||
          cellIndex <= previous
        ) {
          throw new TypeError(
            `${owner} cell indices must be sorted unique non-negative integers`
          );
        }
        previous = cellIndex;
      }
    };
    await requireAlignedPayload(indicesA, valuesA, 'varX');
    await requireAlignedPayload(indicesB, valuesB, 'varY');

    const { colorIndices, colorValues, colorCategories, colorMissingCode } = options;
    if (
      colorCategories !== undefined &&
      (!Array.isArray(colorCategories) || !Number.isSafeInteger(colorMissingCode))
    ) {
      throw new TypeError('Categorical correlation colours need their categories and missing code');
    }
    const hasColor =
      colorIndices !== undefined || colorValues !== undefined;
    if (hasColor) {
      await requireAlignedPayload(colorIndices, colorValues, 'colorBy');
      if (colorIndices.length === 0) {
        throw new RangeError(
          'Requested correlation color data cannot be empty'
        );
      }
    }

    // Every index list is sorted and unique (checked above), so the color of
    // a paired cell is found by advancing a third cursor through the color
    // indices alongside the merge — no per-cell lookup table.
    let colorCursor = 0;

    const lenA = indicesA.length;
    const lenB = indicesB.length;

    // First pass: count paired finite values (merge-join on sorted indices).
    let i = 0;
    let j = 0;
    let count = 0;

    while (i < lenA && j < lenB) {
      if ((++steps & 0xfffff) === 0) {
        const pending = pause();
        if (pending !== undefined) await pending;
      }
      const idxA = indicesA[i];
      const idxB = indicesB[j];

      if (idxA === idxB) {
        const x = valuesA[i];
        const y = valuesB[j];
        if (isFiniteNumber(x) && isFiniteNumber(y)) {
          count++;
        }
        i++;
        j++;
      } else if (idxA < idxB) {
        i++;
      } else {
        j++;
      }
    }

    const xAligned = new Float32Array(count);
    const yAligned = new Float32Array(count);
    const colorAligned = hasColor ? new Array(count) : null;

    // Second pass: fill.
    i = 0;
    j = 0;
    let k = 0;

    while (i < lenA && j < lenB) {
      if ((++steps & 0xfffff) === 0) {
        const pending = pause();
        if (pending !== undefined) await pending;
      }
      const idxA = indicesA[i];
      const idxB = indicesB[j];

      if (idxA === idxB) {
        const x = valuesA[i];
        const y = valuesB[j];
        if (isFiniteNumber(x) && isFiniteNumber(y)) {
          xAligned[k] = x;
          yAligned[k] = y;
          if (hasColor) {
            while (
              colorCursor < colorIndices.length &&
              colorIndices[colorCursor] < idxA
            ) {
              colorCursor++;
            }
            if (
              colorCursor === colorIndices.length ||
              colorIndices[colorCursor] !== idxA
            ) {
              throw new RangeError(
                `Correlation color data is missing cell index ${idxA}`
              );
            }
            const color = colorValues[colorCursor];
            colorAligned[k] = colorCategories === undefined
              ? color
              : (color === colorMissingCode ? null : colorCategories[color]);
          }
          k++;
        }
        i++;
        j++;
      } else if (idxA < idxB) {
        i++;
      } else {
        j++;
      }
    }

    const sampled = count > maxPlotPoints;
    if (!sampled) {
      return {
        xAligned,
        yAligned,
        colorAligned,
        xPlot: xAligned,
        yPlot: yAligned,
        colorPlot: colorAligned,
        sampled: false
      };
    }

    // Downsample for plotting (deterministic stride).
    const step = Math.ceil(count / maxPlotPoints);
    const plotCount = Math.min(maxPlotPoints, Math.ceil(count / step));
    const xPlot = new Float32Array(plotCount);
    const yPlot = new Float32Array(plotCount);
    const colorPlot = hasColor ? new Array(plotCount) : null;

    for (let out = 0, idx = 0; out < plotCount && idx < count; out++, idx += step) {
      xPlot[out] = xAligned[idx];
      yPlot[out] = yAligned[idx];
      if (hasColor) {
        colorPlot[out] = colorAligned[idx];
      }
    }

    return { xAligned, yAligned, colorAligned, xPlot, yPlot, colorPlot, sampled: true };
  }

  // =========================================================================
  // Differential Expression Analysis
  // =========================================================================

  /**
   * A page's cells as a differential-expression group: its cells (a "rest
   * of" page's too), within a scope when one is given.
   *
   * @param {string} pageId
   * @param {Uint8Array|null} [within] - 1 for a cell in scope
   * @returns {{name: string, cells: Uint32Array}}
   */
  pageGroup(pageId, within = null) {
    const [{ pageName, cellIndices }] = this.dataLayer.getPageCells([pageId]);
    return { name: pageName, cells: cellsWithin(cellIndices, within) };
  }

  /**
   * Differential expression of every gene between two groups of cells.
   *
   * The groups are disjoint sets of cells (pages, categories, either within
   * a scope: the UI resolves them, `pageGroup`). A group under `minCells`
   * is tested all the same and flagged (`summary.lowN`); a gene is tested
   * when both groups hold at least two cells with a measured value. Genes
   * read by cell when that reads less (a few thousand cells of a large
   * dataset), else streamed by column to the analysis workers, as many in
   * flight as the run's tuner says (`shared/run-tuner.js`).
   *
   * @param {Object} options
   * @param {{name: string, cells: Uint32Array}} options.groupA
   * @param {{name: string, cells: Uint32Array}} options.groupB
   * @param {string[]|null} [options.geneList] - Genes to test (null: every gene)
   * @param {'wilcox'|'ttest'|'ttest_overestim_var'} [options.method='wilcox']
   * @param {'exact'|'normal'|'normal_tie'} [options.pConvention='exact']
   * @param {'bh'|'bonferroni'} [options.correction='bh']
   * @param {{mode: 'stored'|'log1p', base: number|null}} [options.foldChange]
   * @param {string} [options.matrix='mapped'] - The expression matrix read
   *   (`DataLayer.getExpressionMatrices`); `geneList` names its genes
   * @param {{name: string, codes: ArrayLike<number>, missingCode: number}|null} [options.replicates=null] -
   *   A sample field: pseudobulk, each sample's cells of a group one
   *   observation, Welch's t across them (`stats/pseudobulk.js`); `method`
   *   and `pConvention` then do not apply
   * @param {number} [options.minCells=10] - Below it a group is flagged low n
   * @param {Function} [options.onProgress]
   * @param {Function} [options.isCurrent]
   * @param {Function} [options.registerInvalidationCleanup]
   * @param {import('../../jobs/cancellable-job.js').CancellableJob|null} [options.job]
   * @returns {Promise<Object|null>}
   */
  async differentialExpression(options) {
    const memScope = startMemoryTracking('DE', 'differentialExpression', { includeUserAgent: true });
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Differential expression options are required');
    }
    const {
      groupA,
      groupB,
      geneList: requestedGeneList = null,
      method = 'wilcox',
      pConvention = 'exact',
      correction = 'bh',
      foldChange = { mode: 'stored', base: null },
      matrix = 'mapped',
      replicates = null,
      minCells = 10,
      onProgress,
      job = null
    } = options;
    const signal = job?.signal ?? null;
    const { isCurrent, registerInvalidationCleanup } = resolveRequestOwnership(options, 'Differential expression');
    const pointCount = this.dataLayer?.state?.pointCount;
    if (!Number.isSafeInteger(pointCount) || pointCount <= 0) {
      throw new TypeError('Differential expression requires an exact positive dataset pointCount');
    }
    for (const [label, group] of [['A', groupA], ['B', groupB]]) {
      if (!group || typeof group.name !== 'string' || !(group.cells instanceof Uint32Array)) {
        throw new TypeError(`Differential expression group ${label} must be { name, cells: Uint32Array }`);
      }
      let previous = -1;
      for (const cell of group.cells) {
        if (cell <= previous || cell >= pointCount) {
          throw new RangeError(`Differential expression group ${label} cells must be sorted, unique and in the dataset`);
        }
        previous = cell;
      }
    }
    if (sortedIntersect(groupA.cells, groupB.cells)) {
      throw new RangeError('Differential expression groups must be disjoint; their cells overlap');
    }
    if (groupA.cells.length < 2 || groupB.cells.length < 2) {
      throw new RangeError('Differential expression needs at least 2 cells in each group');
    }
    if (!['wilcox', 'ttest', 'ttest_overestim_var'].includes(method)) {
      throw new TypeError(`Unknown differential expression method: ${String(method)}`);
    }
    const units = replicates === null
      ? null
      : pseudobulkUnits(groupA.cells, groupB.cells, replicates.codes, replicates.missingCode, pointCount);
    if (units !== null && (units.unitsA < 2 || units.unitsB < 2)) {
      throw new RangeError(`Pseudobulk needs cells of each group in at least 2 samples of ${replicates.name}`);
    }
    if (!['exact', 'normal', 'normal_tie'].includes(pConvention)) {
      throw new TypeError(`Unknown p-value convention: ${String(pConvention)}`);
    }
    if (correction !== 'bh' && correction !== 'bonferroni') {
      throw new TypeError(`Unknown multiple-testing correction: ${String(correction)}`);
    }
    if (!Number.isSafeInteger(minCells) || minCells < 2) {
      throw new TypeError('minCells must be a safe integer of at least 2');
    }
    if (onProgress !== undefined && typeof onProgress !== 'function') {
      throw new TypeError('onProgress must be a function when provided');
    }
    const matrixLabel = this.dataLayer.resolveExpressionMatrix(matrix).label;
    const allGenes = await this.dataLayer.getGeneKeys(matrix);
    const geneKeys = requestedGeneList === null ? allGenes : [...requestedGeneList];
    if (requestedGeneList !== null) {
      const known = new Set(allGenes);
      const unknown = geneKeys.find(gene => !known.has(gene));
      if (unknown !== undefined) {
        throw new RangeError(`Requested differential expression gene not found: ${unknown}`);
      }
    }
    if (geneKeys.length === 0) {
      memScope.end({ error: 'No genes' });
      throw new Error('No genes available for analysis');
    }
    if (!isCurrent()) {
      memScope.end({ method, stale: true });
      return null;
    }

    const startTime = performance.now();
    const groupASize = groupA.cells.length;
    const groupBSize = groupB.cells.length;
    const lowN = [groupA, groupB].filter(group => group.cells.length < minCells).map(group => group.name);
    const testOptions = { pConvention, foldChange };

    const progressTracker = createDifferentialProgress({ total: geneKeys.length, onProgress, isCurrent, job });
    job?.setPlan(
      `${formatCount(geneKeys.length)} genes in ${groupA.name} (${formatCount(groupASize)} cells) vs ` +
      `${groupB.name} (${formatCount(groupBSize)} cells)` +
      (units === null ? '' : `, ${formatCount(units.unitsA)} vs ${formatCount(units.unitsB)} samples`)
    );
    progressTracker.start();

    let computeManager = null;
    let geneLoader = null;
    let didStartHeavyCompute = false;
    let hasAnalysisFailure = false;
    let analysisFailure;
    if (registerInvalidationCleanup !== undefined) {
      let claimed = false;
      registerInvalidationCleanup(() => {
        if (claimed) return;
        claimed = true;
        progressTracker.stop();
        geneLoader?.abort();
      });
    }
    const stale = () => {
      progressTracker.stop();
      memScope.end({ method, stale: true });
      return null;
    };

    try {
      computeManager = await this._getComputeManager();
      if (!isCurrent()) return stale();
      const backend = computeManager.selectBackend(OperationType.COMPUTE_DIFFERENTIAL);
      didStartHeavyCompute = true;
      const poolSize = backend === 'worker' ? computeManager.getStatus().worker.stats.poolSize : 1;
      const tuner = createRunTunerFor(this.dataLayer, poolSize);
      geneLoader = new StreamingGeneLoader({ dataLayer: this.dataLayer, tuner, signal, owner: job?.id ?? null, matrix });

      /** @type {Array<Object|null>} */
      const resultsByIndex = new Array(geneKeys.length).fill(null);
      const acceptResult = (gene, index, row) => {
        if (
          !row ||
          !Number.isSafeInteger(row.nA) || !Number.isSafeInteger(row.nB) ||
          row.nA < 0 || row.nB < 0 ||
          row.nA > groupASize || row.nB > groupBSize
        ) {
          throw new TypeError(`Differential expression backend returned invalid sample counts for "${gene}"`);
        }
        const tested = row.nA >= 2 && row.nB >= 2 && Number.isFinite(row.pValue);
        if (tested && (row.pValue < 0 || row.pValue > 1)) {
          throw new TypeError(`Differential expression backend returned invalid statistics for "${gene}"`);
        }
        resultsByIndex[index] = {
          gene,
          meanA: row.meanA,
          meanB: row.meanB,
          pctA: row.pctA,
          pctB: row.pctB,
          log2FoldChange: tested ? row.log2FoldChange : NaN,
          pValue: tested ? row.pValue : NaN,
          statistic: tested ? row.statistic : NaN,
          score: tested ? row.score : NaN,
          auroc: tested ? row.auroc : NaN,
          nA: row.nA,
          nB: row.nB,
          method: units === null ? method : 'pseudobulk',
          ...(tested ? {} : {
            error: units === null
              ? `Too few measured cells (A: ${row.nA}, B: ${row.nB})`
              : `Too few samples with a value (A: ${row.nA}, B: ${row.nB})`
          })
        };
      };

      // Two small groups of a large dataset are read by cell, every gene at
      // once, when that reads less than every gene's column. Pseudobulk sums
      // each gene's column per sample unit instead.
      const subset = units === null
        ? await geneLoader.readCellSubset(geneKeys, groupA.cells, groupB.cells)
        : null;
      if (!isCurrent()) return stale();
      if (subset !== null) {
        const { pointers, cellIndex, values, groupOfPosition } = subset;
        const positions = new Uint32Array(cellIndex.buffer, cellIndex.byteOffset, cellIndex.length);
        // Runs of genes, copied out of the block only as a worker is free
        // for one: a run is a large task, so one per worker (none waiting)
        // keeps every copy sent and off this thread, and sixteen short runs
        // per worker even out uneven genes and the last runs.
        const runsInFlight = poolSize;
        const runLength = Math.max(1, Math.ceil(geneKeys.length / (runsInFlight * 16)));
        const inFlight = new Set();
        let failure = null;
        for (let first = 0; first < geneKeys.length && failure === null; first += runLength) {
          while (inFlight.size >= runsInFlight) await Promise.race(inFlight);
          if (!isCurrent()) return stale();
          const last = Math.min(geneKeys.length, first + runLength);
          const from = pointers[first];
          const to = pointers[last];
          const runPointers = new Float64Array(last - first + 1);
          for (let k = 0; k <= last - first; k++) runPointers[k] = pointers[first + k] - from;
          let task;
          task = computeManager.execute(
            OperationType.COMPUTE_DIFFERENTIAL_OF_SUBSET,
            {
              groupOfPosition: groupOfPosition.slice(),
              pointers: runPointers,
              positions: positions.slice(from, to),
              values: values.slice(from, to),
              method,
              ...testOptions
            },
            { backend, timeout: 120000, transfer: true, signal, onTiming: taskTiming(tuner) }
          ).then(run => {
            if (!isCurrent()) return;
            for (let k = 0; k < last - first; k++) {
              acceptResult(geneKeys[first + k], first + k, {
                meanA: run.meanA[k], meanB: run.meanB[k], pctA: run.pctA[k], pctB: run.pctB[k],
                log2FoldChange: run.log2FoldChange[k], pValue: run.pValue[k], statistic: run.statistic[k],
                score: run.score[k], auroc: run.auroc[k], nA: run.nA[k], nB: run.nB[k]
              });
            }
            progressTracker.itemComplete(last - first);
          }).catch(error => { failure ??= error; }).finally(() => inFlight.delete(task));
          inFlight.add(task);
        }
        await Promise.all(inFlight);
        if (failure !== null) throw failure;
      } else if (units !== null) {
        // One O(nnz) pass per gene sums it over each sample unit (the dot
        // plot's per-group kernel, one group a unit); the sample-level test
        // is a few numbers per unit, here.
        const contextId = `pseudobulk-${++differentialContextCounter}`;
        await computeManager.broadcast(
          OperationType.GROUP_SUMMARY_SET_CONTEXT,
          () => ({ contextId, cellGroup: units.cellUnit.slice(), groupCount: units.unitCount }),
          { timeout: 120000, signal, retainAs: contextId }
        );
        try {
          const completed = await runGeneStream({
            loader: geneLoader,
            genes: geneKeys,
            tuner,
            signal,
            isCurrent,
            dispatch: ({ values, owned }, onTiming) => computeManager.execute(
              OperationType.GROUP_SUMMARY_COMPUTE_GENES,
              { contextId, genes: [owned ? values : values.slice()], cutoff: 0, bins: 0 },
              { timeout: 120000, transfer: true, signal, onTiming }
            ),
            onResult: ({ gene, index }, summary) => {
              acceptResult(gene, index, pseudobulkGeneTest(
                summary.sum, summary.expressing, summary.sizes, units.unitSide, foldChange
              ));
              progressTracker.itemComplete(1);
            }
          });
          if (!completed) return stale();
        } finally {
          await computeManager.broadcast(
            OperationType.GROUP_SUMMARY_CLEAR_CONTEXT,
            () => ({ contextId }),
            { releases: contextId }
          );
        }
      } else {
        // Genes read by column are split into the two groups where they are
        // tested: the groups cross to the compute threads once, one byte a
        // cell, and each gene as its column alone.
        const groupOfCell = new Uint8Array(pointCount);
        for (const cell of groupA.cells) groupOfCell[cell] = 1;
        for (const cell of groupB.cells) groupOfCell[cell] = 2;
        const contextId = `de-${++differentialContextCounter}`;
        await computeManager.broadcast(
          OperationType.SET_TWO_GROUP_CONTEXT,
          () => ({ contextId, groupOfCell: groupOfCell.slice() }),
          backend === 'worker'
            ? { backend, timeout: 120000, signal, retainAs: contextId }
            : { backend, timeout: 120000, signal }
        );
        try {
          const completed = await runGeneStream({
            loader: geneLoader,
            genes: geneKeys,
            tuner,
            signal,
            isCurrent,
            dispatch: ({ values, owned }, onTiming) => computeManager.execute(
              OperationType.COMPUTE_DIFFERENTIAL_OF_COLUMN,
              // A column the run does not own is shared with a view or
              // another run: it is copied rather than emptied by transfer.
              { contextId, values: owned ? values : values.slice(), method, ...testOptions },
              { backend, timeout: 120000, transfer: true, signal, onTiming }
            ),
            onResult: ({ gene, index }, row) => {
              acceptResult(gene, index, row);
              progressTracker.itemComplete(1);
            }
          });
          if (!completed) return stale();
        } finally {
          await computeManager.broadcast(
            OperationType.CLEAR_TWO_GROUP_CONTEXT,
            () => ({ contextId }),
            backend === 'worker' ? { backend, releases: contextId } : { backend }
          );
        }
      }
      if (!isCurrent()) return stale();
      if (resultsByIndex.some(result => result === null)) {
        throw new Error('Differential expression completed without a result for every gene');
      }
      const results = resultsByIndex;

      progressTracker.nextPhase();
      const adjust = correction === 'bh' ? benjaminiHochbergTestable : bonferroniTestable;
      const { adjustedPValues, testedCount, untestableCount } = adjust(results.map(result => result.pValue));
      for (let i = 0; i < results.length; i++) results[i].adjustedPValue = adjustedPValues[i];

      // Ranked by p-value; untested genes last.
      results.sort((a, b) => {
        const finiteA = Number.isFinite(a.pValue);
        const finiteB = Number.isFinite(b.pValue);
        if (finiteA && finiteB) return a.pValue - b.pValue;
        if (finiteA) return -1;
        if (finiteB) return 1;
        return 0;
      });

      const duration = performance.now() - startTime;
      progressTracker.stop();
      memScope.end({ genes: results.length, method, groupASize, groupBSize, durationMs: Math.round(duration) });
      return {
        results,
        summary: {
          // genesTested is the multiple-testing family; genesUntestable never
          // produced a p-value (a group held fewer than 2 measured cells).
          genesTested: testedCount,
          genesUntestable: untestableCount,
          minCells,
          lowN,
          method: units === null ? method : 'pseudobulk',
          pConvention,
          correction,
          foldChange,
          matrix,
          matrixLabel,
          replicates: units === null
            ? null
            : { field: replicates.name, samplesA: units.unitsA, samplesB: units.unitsB, cellsLeftOut: units.cellsLeftOut },
          groupAName: groupA.name,
          groupBName: groupB.name,
          groupASize,
          groupBSize,
          duration
        },
        metadata: {
          pageAName: groupA.name,
          pageBName: groupB.name,
          tuning: tuner.snapshot()
        }
      };
    } catch (error) {
      if (!isCurrent()) return stale();
      hasAnalysisFailure = true;
      analysisFailure = error;
      progressTracker.stop();
      memScope.end({ method, error: error.message });
      throw error;
    } finally {
      if (didStartHeavyCompute) {
        cleanupPreservingAnalysisFailure(
          () => cleanupAnalysisResources({
            dataLayer: this.dataLayer,
            clearSourceCaches: false,
            dataLayerCleanup: 'expired'
          }),
          hasAnalysisFailure,
          analysisFailure
        );
      }
    }
  }

  // =========================================================================
  // Gene Signature Scoring
  // =========================================================================

  /**
   * Score every cell by one or more gene sets, and summarize the scores of
   * each page.
   *
   * Methods (`docs …/07_analysis_mode_gene_signature.md`):
   * - `mean`, `median`: of the set genes' values in the cell;
   * - `mean_z`: each gene z-scored over every cell (ddof 1), then averaged;
   *   a gene constant over every cell has no z and is left out (reported);
   * - `module`: scanpy's `score_genes`: the mean of the set genes less the
   *   mean of control genes drawn from the same expression bins (every gene
   *   binned by its mean over all cells into `bins` bins by rank;
   *   `controlSize` drawn per bin with a seeded generator, the set's own
   *   genes removed);
   * - `ucell`: UCell's rank-based score (`_ucellScores`).
   *
   * Genes are read once each, as whole columns. The set genes must already
   * be the dataset's (`shared/gene-sets.js` `resolveGenes`).
   *
   * @param {Object} options
   * @param {Array<{name: string, genes: string[]}>} options.geneSets
   * @param {string[]} options.pageIds
   * @param {'mean'|'median'|'mean_z'|'module'|'ucell'} [options.method='mean']
   * @param {number} [options.controlSize=50]
   * @param {number} [options.bins=25]
   * @param {number} [options.seed=0]
   * @param {number} [options.maxRank=1500]
   * @param {import('../../jobs/cancellable-job.js').CancellableJob|null} [options.job]
   * @returns {Promise<{sets: Array<{name: string, genes: string[], controlGenes: string[], constantGenes: string[], pages: Object[]}>}|null>}
   */
  async computeSignatureScore(options) {
    const memScope = startMemoryTracking('Signature', 'computeSignatureScore', { includeUserAgent: true });
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Signature scoring options are required');
    }
    const {
      geneSets,
      pageIds,
      method = 'mean',
      controlSize = 50,
      bins = 25,
      seed = 0,
      maxRank = 1500,
      job = null
    } = options;
    const { isCurrent, registerInvalidationCleanup } = resolveRequestOwnership(
      options,
      'Signature scoring'
    );
    if (
      !Array.isArray(geneSets) ||
      geneSets.length === 0 ||
      geneSets.some(set =>
        typeof set?.name !== 'string' ||
        !Array.isArray(set.genes) ||
        set.genes.length === 0 ||
        set.genes.some(gene => typeof gene !== 'string' || gene.length === 0) ||
        new Set(set.genes).size !== set.genes.length)
    ) {
      memScope.end({ error: 'No genes' });
      throw new TypeError('Signature gene sets must each hold distinct gene keys');
    }
    if (
      !Array.isArray(pageIds) ||
      pageIds.length === 0 ||
      pageIds.some(pageId => typeof pageId !== 'string' || pageId.length === 0) ||
      new Set(pageIds).size !== pageIds.length
    ) {
      memScope.end({ error: 'Invalid pages' });
      throw new TypeError('Signature page IDs must be unique non-empty strings');
    }
    if (!['mean', 'median', 'mean_z', 'module', 'ucell'].includes(method)) {
      memScope.end({ error: 'Invalid method' });
      throw new RangeError(`Unsupported signature scoring method: ${String(method)}`);
    }
    for (const [label, value, minimum] of [['controlSize', controlSize, 1], ['bins', bins, 2], ['seed', seed, 0], ['maxRank', maxRank, 1]]) {
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw new RangeError(`Signature ${label} must be an integer of at least ${minimum}`);
      }
    }
    if (!isCurrent()) {
      memScope.end({ stale: true });
      return null;
    }

    const sets = geneSets.map(set => ({ name: set.name, genes: [...set.genes] }));
    const ownedPageIds = [...pageIds];
    const signal = job?.signal ?? null;
    let hasAnalysisFailure = false;
    let analysisFailure;
    const stale = () => {
      memScope.end({ method, stale: true });
      return null;
    };

    try {
      const pointCount = this.dataLayer.state?.pointCount;
      const pages = this.dataLayer.getPageCells(ownedPageIds);

      if (method === 'ucell') {
        const scored = await this._ucellScores({ sets, pages, maxRank, job, isCurrent, registerInvalidationCleanup });
        if (scored === null || !isCurrent()) return stale();
        const out = [];
        for (const set of scored) {
          const pagesOut = [];
          for (const page of set.pages) {
            const statistics = await this._computeBasicStats(page.scores, signal);
            if (!isCurrent()) return stale();
            pagesOut.push({ ...page, statistics });
          }
          out.push({ ...set, controlGenes: [], constantGenes: [], pages: pagesOut });
        }
        memScope.end({ sets: out.length, method });
        return { sets: out };
      }

      // Module score: every gene's mean over all cells, its bins, each
      // set's controls.
      let controlsBySet = sets.map(() => []);
      if (method === 'module') {
        const allGenes = this.dataLayer.getAvailableVariables('gene_expression').map(gene => gene.key);
        const moments = await this._ensureGeneMoments(allGenes, { job, isCurrent });
        if (moments === null || !isCurrent()) return stale();
        controlsBySet = sets.map(set => moduleScoreControls({
          genes: allGenes,
          means: allGenes.map(gene => momentsMean(moments.get(gene))),
          setGenes: set.genes,
          controlSize,
          bins,
          seed
        }));
      }

      const union = [...new Set([...sets.flatMap(set => set.genes), ...controlsBySet.flat()])];
      job?.step('Reading genes');
      job?.setPlan(`Reads ${formatCount(union.length)} genes`);
      const columnList = await this.dataLayer.readGeneColumns(union, {
        isCurrent,
        registerInvalidationCleanup,
        signal,
        owner: job?.id ?? null,
      });
      if (!isCurrent()) return stale();
      const columns = new Map(union.map((gene, index) => [gene, columnList[index]]));

      job?.step('Scoring cells');
      const yieldIfSliceSpent = createSlicedYield();
      const resumeAfterYield = async () => {
        const pending = yieldIfSliceSpent();
        if (pending === undefined) return true;
        await pending;
        return isCurrent();
      };

      // A mean z-score needs each gene's mean and spread over every cell.
      const zOf = new Map();
      if (method === 'mean_z') {
        for (const gene of new Set(sets.flatMap(set => set.genes))) {
          const moments = computeGeneMoments({ values: columns.get(gene) });
          const mean = momentsMean(moments);
          const sd = momentsStd(moments);
          zOf.set(gene, Number.isFinite(sd) && sd > 0 ? { scale: 1 / sd, offset: -mean / sd } : null);
        }
      }

      const SLICE = 0x10000;
      const scorePage = async (genes, cellIndices, scorerMethod, affineOf) => {
        const scorer = new SignaturePageScorer({ method: scorerMethod, geneCount: genes.length, cellIndices, pointCount });
        for (const gene of genes) {
          scorer.addGene(columns.get(gene), affineOf(gene));
          if (!(await resumeAfterYield())) return null;
        }
        for (let from = 0; from < cellIndices.length; from += SLICE) {
          scorer.scoreCells(from, Math.min(cellIndices.length, from + SLICE));
          if (!(await resumeAfterYield())) return null;
        }
        return scorer.scores;
      };

      const out = [];
      for (let s = 0; s < sets.length; s++) {
        const set = sets[s];
        const controlGenes = controlsBySet[s];
        let scoredGenes = set.genes;
        let constantGenes = [];
        if (method === 'mean_z') {
          constantGenes = set.genes.filter(gene => zOf.get(gene) === null);
          scoredGenes = set.genes.filter(gene => zOf.get(gene) !== null);
        }
        const pagesOut = [];
        for (const { pageId, pageName, cellIndices } of pages) {
          if (!isCurrent()) return stale();
          if (typeof pageName !== 'string' || pageName.length === 0) {
            throw new TypeError(`Signature page ${pageId} has no name`);
          }
          let scores;
          if (scoredGenes.length === 0) {
            scores = new Float32Array(cellIndices.length).fill(NaN);
          } else if (method === 'mean_z') {
            scores = await scorePage(scoredGenes, cellIndices, 'mean', gene => zOf.get(gene));
          } else if (method === 'module') {
            // The set's per-cell mean less the controls': each mean stored as
            // float32, as scanpy's are for float32 expression.
            const unit = () => ({ scale: 1, offset: 0 });
            const setScores = await scorePage(scoredGenes, cellIndices, 'mean', unit);
            const controlScores = controlGenes.length === 0 ? null : await scorePage(controlGenes, cellIndices, 'mean', unit);
            if (setScores === null || (controlGenes.length > 0 && controlScores === null)) return stale();
            scores = new Float32Array(cellIndices.length);
            for (let p = 0; p < scores.length; p++) {
              scores[p] = controlScores === null ? setScores[p] : setScores[p] - controlScores[p];
            }
          } else {
            scores = await scorePage(scoredGenes, cellIndices, method, () => null);
          }
          if (scores === null || !isCurrent()) return stale();
          const statistics = await this._computeBasicStats(scores, signal);
          if (!isCurrent()) return stale();
          pagesOut.push({ pageId, pageName, scores, cellIndices, statistics, genesUsed: scoredGenes.length, method });
        }
        out.push({ name: set.name, genes: scoredGenes, controlGenes, constantGenes, pages: pagesOut });
      }

      memScope.end({ genes: union.length, pages: ownedPageIds.length, sets: sets.length, method });
      return { sets: out };
    } catch (error) {
      hasAnalysisFailure = true;
      analysisFailure = error;
      if (!isCurrent()) return stale();
      memScope.end({ method, error: error.message });
      throw error;
    } finally {
      cleanupPreservingAnalysisFailure(
        () => cleanupAnalysisResources({
          dataLayer: this.dataLayer,
          clearSourceCaches: false,
          dataLayerCleanup: 'expired'
        }),
        hasAnalysisFailure,
        analysisFailure
      );
    }
  }

  /**
   * Every gene's moments over all cells (`shared/gene-moments-cache.js`):
   * those a marker run already computed, and the rest read once, as one job
   * step, in the analysis workers.
   *
   * @param {string[]} genes
   * @param {{job?: Object|null, isCurrent: () => boolean}} options
   * @returns {Promise<Map<string, {sum: number, sumSq: number, nonZero: number, n: number}>|null>}
   */
  async _ensureGeneMoments(genes, { job = null, isCurrent }) {
    const cache = geneMomentsFor(this.dataLayer.getDatasetGeneration());
    const missing = cache.missing(genes);
    if (missing.length > 0) {
      job?.step('Reading every gene once for its mean');
      job?.items(0, missing.length, 'genes');
      const computeManager = await this._getComputeManager();
      const backend = computeManager.selectBackend(OperationType.COMPUTE_GENE_MOMENTS);
      const poolSize = backend === 'worker' ? computeManager.getStatus().worker.stats.poolSize : 1;
      const tuner = createRunTunerFor(this.dataLayer, poolSize);
      const signal = job?.signal ?? null;
      const loader = new StreamingGeneLoader({ dataLayer: this.dataLayer, tuner, signal, owner: job?.id ?? null });
      let done = 0;
      const completed = await runGeneStream({
        loader,
        genes: missing,
        tuner,
        signal,
        isCurrent,
        dispatch: ({ values, owned }, onTiming) => computeManager.execute(
          OperationType.COMPUTE_GENE_MOMENTS,
          { values: owned ? values : values.slice() },
          { backend, timeout: 120000, transfer: true, signal, onTiming }
        ),
        onResult: ({ gene }, moments) => {
          cache.set(gene, moments);
          done++;
          job?.items(done, missing.length, 'genes');
        }
      });
      if (!completed) return null;
    }
    return new Map(genes.map(gene => [gene, cache.get(gene)]));
  }

  /**
   * UCell scores (`compute/ucell.js`) of every set for the pages' cells, from
   * one pass over every gene: the cells are split into one contiguous range
   * per analysis worker; each worker keeps its range's set-gene values and
   * counts, and each gene read reaches every worker as its range's entries,
   * a run of genes per message.
   *
   * @returns {Promise<Array<{name: string, genes: string[], pages: Object[]}>|null>}
   */
  async _ucellScores({ sets, pages, maxRank, job, isCurrent, registerInvalidationCleanup }) {
    const signal = job?.signal ?? null;
    const pointCount = this.dataLayer.state.pointCount;
    const allGenes = this.dataLayer.getAvailableVariables('gene_expression').map(gene => gene.key);
    const union = [...new Set(sets.flatMap(set => set.genes))];
    const slot = new Map(union.map((gene, index) => [gene, index]));
    const S = union.length;
    job?.setPlan(`Reads all ${formatCount(allGenes.length)} genes once`);
    job?.step('Reading the set genes');
    const setColumns = await this.dataLayer.readGeneColumns(union, {
      isCurrent, registerInvalidationCleanup, signal, owner: job?.id ?? null
    });
    if (!isCurrent()) return null;

    const release = await acquireUcellLease(signal);
    try {
      const pool = getWorkerPool();
      await pool.init();
      const W = Math.min(pool.getStats().poolSize, pointCount);
      const bounds = Array.from({ length: W + 1 }, (_, w) => Math.round((w * pointCount) / W));
      const yieldIfSliceSpent = createSlicedYield();

      // Each range's set values, cell-major: zeros, then each column's
      // stored entries.
      job?.step('Ranking cells');
      const contexts = [];
      for (let w = 0; w < W; w++) {
        const from = bounds[w];
        const to = bounds[w + 1];
        const setValues = new Float32Array((to - from) * S);
        for (let s = 0; s < S; s++) {
          const column = setColumns[s];
          if (ArrayBuffer.isView(column)) {
            for (let c = from; c < to; c++) setValues[(c - from) * S + s] = column[c];
          } else {
            const { indices, values } = column;
            for (let k = lowerBoundOf(indices, from); k < indices.length && indices[k] < to; k++) {
              setValues[(indices[k] - from) * S + s] = values[k];
            }
          }
          const pending = yieldIfSliceSpent();
          if (pending !== undefined) await pending;
        }
        contexts.push(pool.executeOnWorker(w, 'UCELL_SET_CONTEXT', {
          cellCount: to - from,
          setValues,
          setGeneCount: S,
          geneCount: allGenes.length,
          sets: sets.map(set => set.genes.map(gene => slot.get(gene))),
          maxRank
        }, { timeout: 120000, transfer: true, signal }));
      }
      await Promise.all(contexts);
      if (!isCurrent()) return null;

      // Every gene once: each worker gets its range's entries of a run of
      // genes per message.
      const tuner = createRunTunerFor(this.dataLayer, W);
      const loader = new StreamingGeneLoader({ dataLayer: this.dataLayer, tuner, signal, owner: job?.id ?? null });
      job?.items(0, allGenes.length, 'genes');
      const batches = Array.from({ length: W }, () => ({ genes: 0, pointers: [0], cells: [], values: [] }));
      const inFlight = new Set();
      let failure = null;
      const flush = (w, onTiming) => {
        const batch = batches[w];
        if (batch.genes === 0) return;
        batches[w] = { genes: 0, pointers: [0], cells: [], values: [] };
        const task = pool.executeOnWorker(w, 'UCELL_ADD_GENES', {
          pointers: Uint32Array.from(batch.pointers),
          cells: Uint32Array.from(batch.cells),
          values: Float32Array.from(batch.values)
        }, { timeout: 120000, transfer: true, signal, onTiming })
          .catch(error => { failure ??= error; })
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
      };
      let done = 0;
      for await (const { values } of loader.streamGenesRaw(allGenes)) {
        if (signal?.aborted) throw signal.reason;
        if (!isCurrent()) {
          loader.abort();
          return null;
        }
        if (failure !== null) throw failure;
        const dense = ArrayBuffer.isView(values);
        for (let w = 0; w < W; w++) {
          const from = bounds[w];
          const to = bounds[w + 1];
          const batch = batches[w];
          if (dense) {
            for (let c = from; c < to; c++) {
              const v = values[c];
              if (v !== 0) {
                batch.cells.push(c - from);
                batch.values.push(v);
              }
            }
          } else {
            const { indices, values: entries } = values;
            for (let k = lowerBoundOf(indices, from); k < indices.length && indices[k] < to; k++) {
              batch.cells.push(indices[k] - from);
              batch.values.push(entries[k]);
            }
          }
          batch.genes++;
          batch.pointers.push(batch.cells.length);
        }
        done++;
        // A run of genes per message: one full round of the tuner's window.
        if (batches[0].genes >= TUNER_WINDOW_GENES) {
          while (inFlight.size >= tuner.computeInFlight() * W && failure === null) await Promise.race(inFlight);
          for (let w = 0; w < W; w++) flush(w, taskTiming(tuner));
        }
        job?.items(done, allGenes.length, 'genes');
        const pending = yieldIfSliceSpent();
        if (pending !== undefined) await pending;
      }
      for (let w = 0; w < W; w++) flush(w, taskTiming(tuner));
      await Promise.all(inFlight);
      if (failure !== null) throw failure;
      if (!isCurrent()) return null;

      const finished = await Promise.all(Array.from({ length: W }, (_, w) =>
        pool.executeOnWorker(w, 'UCELL_FINISH', {}, { timeout: 120000, signal })));
      if (!isCurrent()) return null;
      const setCount = sets.length;
      const all = sets.map(() => new Float32Array(pointCount));
      for (let w = 0; w < W; w++) {
        const { scores } = finished[w];
        const from = bounds[w];
        for (let c = 0; c < bounds[w + 1] - from; c++) {
          for (let k = 0; k < setCount; k++) all[k][from + c] = scores[c * setCount + k];
        }
      }
      return sets.map((set, k) => ({
        name: set.name,
        genes: set.genes,
        pages: pages.map(({ pageId, pageName, cellIndices }) => {
          const scores = new Float32Array(cellIndices.length);
          for (let p = 0; p < cellIndices.length; p++) scores[p] = all[k][cellIndices[p]];
          return { pageId, pageName, scores, cellIndices, genesUsed: set.genes.length, method: 'ucell' };
        })
      }));
    } finally {
      release();
    }
  }

  /**
   * Exact basic statistics of signature scores: Welford mean and population
   * standard deviation, minimum, maximum and median of the finite scores.
   *
   * The pass over the scores hands the event loop back between slices, and
   * the median of a large page is selected by an analysis worker from a
   * transferred copy of the finite scores — the same `selectSorted` either way.
   *
   * @param {ArrayLike<number>} values
   * @param {AbortSignal|null} [signal] - Cancels the worker selection
   */
  async _computeBasicStats(values, signal = null) {
    if (!values || !Number.isSafeInteger(values.length) || values.length < 0) {
      throw new TypeError('Signature statistics require an array-like value collection');
    }
    let count = 0;
    let meanVal = 0;
    let m2 = 0;
    let min = Infinity;
    let max = -Infinity;

    // The finite values at their own width: a Float32 score array is copied
    // as Float32 (half the bytes, and the order statistics read its bits
    // directly).
    const finiteValues = values instanceof Float32Array
      ? new Float32Array(values.length)
      : new Float64Array(values.length);
    const yieldIfSliceSpent = createSlicedYield();

    for (let i = 0; i < values.length; i++) {
      if ((i & 0xfffff) === 0xfffff) {
        const pending = yieldIfSliceSpent();
        if (pending !== undefined) await pending;
      }
      const x = values[i];
      if (!Number.isFinite(x)) continue;

      count++;

      // Welford online mean/variance
      const delta = x - meanVal;
      meanVal += delta / count;
      const delta2 = x - meanVal;
      m2 += delta * delta2;

      if (x < min) min = x;
      if (x > max) max = x;

      finiteValues[count - 1] = x;
    }

    if (count === 0) {
      return { count: 0, mean: NaN, median: NaN, min: NaN, max: NaN, std: NaN };
    }

    const variance = m2 / count;
    if (variance < 0) {
      throw new RangeError('Signature variance cannot be negative');
    }
    const stdVal = Math.sqrt(variance);

    // The median is two positions of the ascending order.
    const mid = Math.floor(count / 2);
    const positions = [mid > 0 ? mid - 1 : 0, mid];
    const finite = finiteValues.subarray(0, count);
    let lowerMid;
    let upperMid;
    if (count >= ORDER_STATISTICS_WORKER_MIN) {
      const computeManager = await this._getComputeManager();
      ({ selected: [lowerMid, upperMid] } = await computeManager.execute(
        OperationType.COMPUTE_ORDER_STATISTICS,
        { values: finite, positions },
        { transfer: true, signal }
      ));
    } else {
      [lowerMid, upperMid] = selectSorted(finite, positions);
    }
    const medianVal = count % 2 === 0
      ? (lowerMid + upperMid) / 2
      : upperMid;

    return {
      count,
      mean: meanVal,
      median: medianVal,
      min,
      max,
      std: stdVal
    };
  }

}

/**
 * Create a multi-variable analysis instance
 */
export function createMultiVariableAnalysis(dataLayer) {
  return new MultiVariableAnalysis(dataLayer);
}
