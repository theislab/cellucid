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
import { getBasePageIdFromRestOf, isRestOfPageId } from '../shared/page-derivation-utils.js';
import {
  createFrameThrottle,
  createSlicedYield,
  waitForAvailableSlot
} from '../shared/concurrency-utils.js';
import { StreamingGeneLoader } from '../data/streaming-gene-loader.js';
import { PerformanceConfig } from '../shared/performance-config.js';
import { isFiniteNumber } from '../shared/number-utils.js';
import { benjaminiHochbergTestable } from './statistical-tests.js';
import { selectSorted } from '../compute/math-utils.js';
import { SignaturePageScorer } from './signature-score.js';
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
   * Perform differential expression analysis between two pages
   *
   * @param {Object} options
   * @param {string} options.pageA - First page ID (reference/control)
   * @param {string} options.pageB - Second page ID (test/treatment)
   * @param {string[]} [options.geneList] - Subset of genes to test (null = all)
   * @param {string} [options.method='wilcox'] - 'wilcox' or 'ttest'
   * @param {number} [options.minCells=10] - Minimum cells required per group
   * @param {number|'auto'} [options.parallelism='auto'] - Max concurrent genes in-flight (worker-backed)
   * @param {Object} [options.batchConfig] - Batch settings (preloadCount, memoryBudgetMB, networkConcurrency)
   * @param {Function} [options.onProgress] - Progress callback
   * @param {Function} [options.isCurrent] - Exact request ownership predicate
   * @param {Function} [options.registerInvalidationCleanup] - Required with isCurrent
   * @param {import('../../jobs/cancellable-job.js').CancellableJob|null} [options.job] -
   *   The run's job: told the cost and every gene done; its signal stops the
   *   run's reads and worker tasks, and its reads are its own
   * @returns {Promise<Object>} Differential expression results
  */
  async differentialExpression(options) {
    const memScope = startMemoryTracking('DE', 'differentialExpression', { includeUserAgent: true });
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Differential expression options are required');
    }
    const {
      pageA: requestedPageA,
      pageB: requestedPageB,
      geneList: requestedGeneList = null,
      method = 'wilcox',
      minCells = 10,
      parallelism = 'auto',
      onProgress,
      job = null,
      // Batch configuration options for optimized loading
      batchConfig: requestedBatchConfig = {}
    } = options;
    const signal = job?.signal ?? null;
    const { isCurrent, registerInvalidationCleanup } = resolveRequestOwnership(
      options,
      'Differential expression'
    );
    const pageA = requestedPageA;
    const pageB = requestedPageB;
    const geneList = Array.isArray(requestedGeneList)
      ? [...requestedGeneList]
      : requestedGeneList;
    const batchConfig = (
      requestedBatchConfig &&
      typeof requestedBatchConfig === 'object' &&
      !Array.isArray(requestedBatchConfig)
    )
      ? {
        preloadCount: requestedBatchConfig.preloadCount,
        memoryBudgetMB: requestedBatchConfig.memoryBudgetMB,
        networkConcurrency: requestedBatchConfig.networkConcurrency,
      }
      : requestedBatchConfig;

    if (
      typeof pageA !== 'string' ||
      pageA.length === 0 ||
      pageA !== pageA.trim() ||
      typeof pageB !== 'string' ||
      pageB.length === 0 ||
      pageB !== pageB.trim() ||
      pageA === pageB
    ) {
      memScope.end({ error: 'Missing pages' });
      throw new TypeError(
        'Differential expression requires two distinct non-empty page IDs'
      );
    }
    if (!['wilcox', 'ttest'].includes(method)) {
      throw new TypeError(`Unknown differential expression method: ${String(method)}`);
    }
    if (!Number.isSafeInteger(minCells) || minCells < 2) {
      throw new TypeError('minCells must be a safe integer of at least 2');
    }
    if (
      parallelism !== 'auto' &&
      (!Number.isSafeInteger(parallelism) || parallelism <= 0)
    ) {
      throw new TypeError(
        'parallelism must be "auto" or a positive safe integer'
      );
    }
    if (onProgress !== undefined && typeof onProgress !== 'function') {
      throw new TypeError('onProgress must be a function when provided');
    }
    if (
      !batchConfig ||
      typeof batchConfig !== 'object' ||
      Array.isArray(batchConfig)
    ) {
      throw new TypeError('batchConfig must be an object');
    }
    if (
      geneList !== null &&
      (
        !Array.isArray(geneList) ||
        geneList.length === 0 ||
        geneList.some(
          gene =>
            typeof gene !== 'string' ||
            gene.length === 0 ||
            gene !== gene.trim()
        ) ||
        new Set(geneList).size !== geneList.length
      )
    ) {
      throw new TypeError(
        'geneList must be null or unique non-empty gene keys'
      );
    }
    if (!isCurrent()) {
      memScope.end({ method, stale: true });
      return null;
    }

    const startTime = performance.now();

    const pointCount = this.dataLayer?.state?.pointCount;
    if (!Number.isSafeInteger(pointCount) || pointCount <= 0) {
      throw new TypeError(
        'Differential expression requires an exact positive dataset pointCount'
      );
    }

    // Get available genes
    const allGenes = this.dataLayer.getAvailableVariables('gene_expression');
    if (!Array.isArray(allGenes)) {
      throw new TypeError('Available gene variables must be an array');
    }
    const genesByKey = new Map();
    for (const gene of allGenes) {
      if (
        !gene ||
        typeof gene !== 'object' ||
        typeof gene.key !== 'string' ||
        gene.key.length === 0 ||
        genesByKey.has(gene.key)
      ) {
        throw new TypeError(
          'Available genes must have unique non-empty keys'
        );
      }
      genesByKey.set(gene.key, gene);
    }
    const genesToTest = geneList === null
      ? allGenes
      : geneList.map(geneKey => {
        if (!genesByKey.has(geneKey)) {
          throw new RangeError(
            `Requested differential expression gene not found: ${geneKey}`
          );
        }
        return genesByKey.get(geneKey);
      });

    if (genesToTest.length === 0) {
      memScope.end({ error: 'No genes' });
      throw new Error('No genes available for analysis');
    }

    // Get recommended settings based on data size
    const recommended = PerformanceConfig.getRecommendedSettings(pointCount, genesToTest.length);

    // Merge user batch config with recommended settings
    const effectiveBatchConfig = {
      preloadCount: batchConfig.preloadCount ?? recommended.preloadCount,
      memoryBudgetMB: batchConfig.memoryBudgetMB ?? recommended.memoryBudgetMB,
      networkConcurrency: batchConfig.networkConcurrency ?? recommended.networkConcurrency
    };
    if (
      !Number.isSafeInteger(effectiveBatchConfig.preloadCount) ||
      effectiveBatchConfig.preloadCount <= 0 ||
      typeof effectiveBatchConfig.memoryBudgetMB !== 'number' ||
      !Number.isFinite(effectiveBatchConfig.memoryBudgetMB) ||
      effectiveBatchConfig.memoryBudgetMB <= 0 ||
      !Number.isSafeInteger(effectiveBatchConfig.networkConcurrency) ||
      effectiveBatchConfig.networkConcurrency <= 0
    ) {
      throw new TypeError(
        'Differential expression batch settings must be positive exact numbers'
      );
    }

    console.log('[DE] Effective config:', {
      preloadCount: effectiveBatchConfig.preloadCount,
      memoryBudgetMB: effectiveBatchConfig.memoryBudgetMB,
      networkConcurrency: effectiveBatchConfig.networkConcurrency,
      genes: genesToTest.length,
      cells: pointCount
    });

    const progressTracker = createDifferentialProgress({
      total: genesToTest.length,
      onProgress,
      isCurrent,
      job
    });
    progressTracker.start();

    /** @type {import('../compute/compute-manager.js').ComputeManager|null} */
    let computeManager = null;
    /** @type {StreamingGeneLoader|null} */
    let geneLoader = null;
    let didStartHeavyCompute = false;
    let hasAnalysisFailure = false;
    let analysisFailure;
    let invalidationCleanupClaimed = false;
    if (registerInvalidationCleanup !== undefined) {
      registerInvalidationCleanup(() => {
        if (invalidationCleanupClaimed) return;
        invalidationCleanupClaimed = true;
        progressTracker.stop();
        geneLoader?.abort();
      });
    }

    try {
      if (!isCurrent()) {
        progressTracker.stop();
        memScope.end({ method, stale: true });
        return null;
      }
      const pageAInfo = this.dataLayer.getPageInfo(pageA);
      const pageBInfo = this.dataLayer.getPageInfo(pageB);
      for (const [pageId, pageInfo] of [
        [pageA, pageAInfo],
        [pageB, pageBInfo],
      ]) {
        if (
          !pageInfo ||
          typeof pageInfo !== 'object' ||
          typeof pageInfo.name !== 'string' ||
          pageInfo.name.length === 0
        ) {
          throw new Error(
            `Differential expression page metadata is missing for "${pageId}"`
          );
        }
      }

      /**
       * Build group specification for a page
       * @param {string} pageId
       * @returns {Object} Group specification
       */
      const requireSortedUniqueIndices = (indices, owner) => {
        if (
          indices === null ||
          indices === undefined ||
          !Number.isSafeInteger(indices.length) ||
          indices.length < 0
        ) {
          throw new TypeError(`${owner} must provide an array-like cell index set`);
        }
        let previous = -1;
        for (let index = 0; index < indices.length; index++) {
          const cellIndex = indices[index];
          if (
            !Number.isSafeInteger(cellIndex) ||
            cellIndex < 0 ||
            cellIndex >= pointCount ||
            cellIndex <= previous
          ) {
            throw new RangeError(
              `${owner} cell indices must be sorted, unique, and inside the dataset`
            );
          }
          previous = cellIndex;
        }
        return indices;
      };
      const buildGroupSpec = (pageId) => {
        const pageInfo = this.dataLayer.getPageInfo(pageId);
        if (
          !pageInfo ||
          typeof pageInfo.name !== 'string' ||
          pageInfo.name.length === 0
        ) {
          throw new Error(
            `Differential expression page metadata is missing for "${pageId}"`
          );
        }
        const pageName = pageInfo.name;

        if (isRestOfPageId(pageId)) {
          const baseId = getBasePageIdFromRestOf(pageId);
          if (typeof baseId !== 'string' || baseId.length === 0) {
            throw new TypeError(
              `Malformed rest-of page ID: ${pageId}`
            );
          }
          const excludedCellIndices = requireSortedUniqueIndices(
            this.dataLayer.getCellIndicesForPage(baseId),
            `Rest-of page "${pageId}"`
          );
          return { kind: 'rest_of', pageId, pageName, baseId, excludedCellIndices, isRestOf: true };
        }

        const cellIndices = requireSortedUniqueIndices(
          this.dataLayer.getCellIndicesForPage(pageId),
          `Page "${pageId}"`
        );
        return { kind: 'explicit', pageId, pageName, cellIndices, isRestOf: false };
      };

      const groupA = buildGroupSpec(pageA);
      const groupB = buildGroupSpec(pageB);

      const getGroupSize = (group, totalCells) => {
        if (group.kind === 'rest_of') {
          if (group.excludedCellIndices.length > totalCells) {
            throw new RangeError(
              'Rest-of exclusions exceed the dataset point count'
            );
          }
          return totalCells - group.excludedCellIndices.length;
        }
        return group.cellIndices.length;
      };

      const groupASize = getGroupSize(groupA, pointCount);
      const groupBSize = getGroupSize(groupB, pointCount);
      const hasSortedIntersection = (left, right) => {
        let leftIndex = 0;
        let rightIndex = 0;
        while (leftIndex < left.length && rightIndex < right.length) {
          const leftCell = left[leftIndex];
          const rightCell = right[rightIndex];
          if (leftCell === rightCell) return true;
          if (leftCell < rightCell) leftIndex++;
          else rightIndex++;
        }
        return false;
      };
      const isSortedSubset = (candidate, owner) => {
        let candidateIndex = 0;
        let ownerIndex = 0;
        while (
          candidateIndex < candidate.length &&
          ownerIndex < owner.length
        ) {
          const candidateCell = candidate[candidateIndex];
          const ownerCell = owner[ownerIndex];
          if (candidateCell === ownerCell) {
            candidateIndex++;
            ownerIndex++;
          } else if (candidateCell > ownerCell) {
            ownerIndex++;
          } else {
            return false;
          }
        }
        return candidateIndex === candidate.length;
      };
      const sortedUnionSize = (left, right) => {
        let leftIndex = 0;
        let rightIndex = 0;
        let size = 0;
        while (leftIndex < left.length || rightIndex < right.length) {
          if (leftIndex >= left.length) {
            size += right.length - rightIndex;
            break;
          }
          if (rightIndex >= right.length) {
            size += left.length - leftIndex;
            break;
          }
          const leftCell = left[leftIndex];
          const rightCell = right[rightIndex];
          size++;
          if (leftCell === rightCell) {
            leftIndex++;
            rightIndex++;
          } else if (leftCell < rightCell) {
            leftIndex++;
          } else {
            rightIndex++;
          }
        }
        return size;
      };
      let groupsOverlap;
      if (groupA.kind === 'explicit' && groupB.kind === 'explicit') {
        groupsOverlap = hasSortedIntersection(
          groupA.cellIndices,
          groupB.cellIndices
        );
      } else if (groupA.kind === 'explicit') {
        groupsOverlap = !isSortedSubset(
          groupA.cellIndices,
          groupB.excludedCellIndices
        );
      } else if (groupB.kind === 'explicit') {
        groupsOverlap = !isSortedSubset(
          groupB.cellIndices,
          groupA.excludedCellIndices
        );
      } else {
        groupsOverlap = sortedUnionSize(
          groupA.excludedCellIndices,
          groupB.excludedCellIndices
        ) < pointCount;
      }
      if (groupsOverlap) {
        throw new RangeError(
          'Differential expression comparison groups must be disjoint; ' +
          'their cell memberships overlap'
        );
      }
      if (groupASize < minCells || groupBSize < minCells) {
        throw new RangeError(
          `Differential expression requires at least ${minCells} cells per group; ` +
          `received ${groupASize} and ${groupBSize}`
        );
      }

      job?.setPlan(
        `${formatCount(genesToTest.length)} genes in ` +
        `${pageAInfo.name} (${formatCount(groupASize)} cells) vs ` +
        `${pageBInfo.name} (${formatCount(groupBSize)} cells)`
      );

      computeManager = await this._getComputeManager();
      if (!isCurrent()) {
        progressTracker.stop();
        memScope.end({ method, stale: true });
        return null;
      }
      const backend = computeManager.selectBackend(OperationType.COMPUTE_DIFFERENTIAL);
      didStartHeavyCompute = true;

      // Select the backend once for the complete analysis run. CPU and worker
      // routes share operation-handlers.js and therefore the same DE contract.
      const workerStats = backend === 'worker'
        ? computeManager.getStatus().worker.stats
        : null;
      if (
        backend === 'worker' &&
        (
          !workerStats ||
          !Number.isSafeInteger(workerStats.poolSize) ||
          workerStats.poolSize <= 0
        )
      ) {
        throw new TypeError(
          'Worker differential expression requires an exact positive pool size'
        );
      }
      const poolSize = backend === 'worker' ? workerStats.poolSize : 1;
      // One gene per worker keeps every worker busy; more in flight only
      // queues. Each in-flight gene holds at most one column (4 bytes per
      // cell) on its way to a worker, which the run's budget bounds.
      const bytesPerGene = pointCount * 4;
      const budget = effectiveBatchConfig.memoryBudgetMB * 1024 * 1024;
      const maxByMemory = Math.max(1, Math.floor(budget / bytesPerGene));
      const maxInFlightGenes = Math.max(1, Math.min(
        parallelism === 'auto' ? poolSize : parallelism,
        poolSize,
        maxByMemory
      ));

      // Create streaming gene loader with optimized prefetching
      geneLoader = new StreamingGeneLoader({
        dataLayer: this.dataLayer,
        config: effectiveBatchConfig,
        signal,
        owner: job?.id ?? null
      });

      /** @type {Array<Object|null>} */
      const resultsByIndex = new Array(genesToTest.length).fill(null);
      /** @type {Set<Promise<void>>} */
      const inFlight = new Set();
      let executionError = null;
      let stale = false;
      let streamError = null;

      // Genes read by column are split into the two groups where they are
      // tested: the groups cross to the compute threads once, as one byte per
      // cell, and each gene crosses as its column alone (transferred when the
      // run owns it). Nothing is gathered on this thread.
      const groupOfCell = new Uint8Array(pointCount);
      const membership = group => {
        const mask = new Uint8Array(pointCount);
        if (group.kind === 'rest_of') {
          mask.fill(1);
          for (const cell of group.excludedCellIndices) mask[cell] = 0;
        } else {
          for (const cell of group.cellIndices) mask[cell] = 1;
        }
        return mask;
      };
      {
        // The groups are disjoint (checked above).
        const inA = membership(groupA);
        const inB = membership(groupB);
        for (let cell = 0; cell < pointCount; cell++) {
          groupOfCell[cell] = inA[cell] === 1 ? 1 : (inB[cell] === 1 ? 2 : 0);
        }
      }
      const contextId = `de-${++differentialContextCounter}`;
      let contextHeld = null;
      const holdContext = () => {
        contextHeld ??= computeManager.broadcast(
          OperationType.SET_TWO_GROUP_CONTEXT,
          () => ({ contextId, groupOfCell: groupOfCell.slice() }),
          backend === 'worker'
            ? { backend, timeout: 120000, signal, retainAs: contextId }
            : { backend, timeout: 120000, signal }
        );
        return contextHeld;
      };

      const geneKeys = genesToTest.map(g => g.key);

      /** Check one gene's backend result and record its row. */
      const acceptResult = (gene, index, deResult) => {
        if (
          !deResult ||
          !Number.isSafeInteger(deResult.nA) ||
          !Number.isSafeInteger(deResult.nB) ||
          deResult.nA < 0 ||
          deResult.nB < 0 ||
          deResult.nA > groupASize ||
          deResult.nB > groupBSize
        ) {
          throw new TypeError(
            `Differential expression backend returned invalid sample counts for "${gene}"`
          );
        }
        if (deResult.nA < minCells || deResult.nB < minCells) {
          resultsByIndex[index] = {
            gene,
            error: `Insufficient valid cells (A: ${deResult.nA}, B: ${deResult.nB})`,
            meanA: deResult.meanA,
            meanB: deResult.meanB,
            log2FoldChange: NaN,
            pValue: NaN,
            statistic: NaN,
            nA: deResult.nA,
            nB: deResult.nB,
            method
          };
          return;
        }
        if (
          deResult.method !== method ||
          !Number.isFinite(deResult.meanA) ||
          !Number.isFinite(deResult.meanB) ||
          !Number.isFinite(deResult.log2FoldChange) ||
          !Number.isFinite(deResult.statistic) ||
          !Number.isFinite(deResult.pValue) ||
          deResult.pValue < 0 ||
          deResult.pValue > 1
        ) {
          throw new TypeError(
            `Differential expression backend returned invalid statistics for "${gene}"`
          );
        }
        resultsByIndex[index] = { gene, ...deResult };
      };

      /** Track one dispatched task until it settles. */
      const track = (request, onResult, completedItems) => {
        let taskPromise;
        taskPromise = request
          .then(result => {
            if (isCurrent()) onResult(result);
          })
          .catch((error) => {
            executionError ||= error;
          })
          .finally(() => {
            inFlight.delete(taskPromise);
            if (isCurrent()) progressTracker.itemComplete(completedItems);
          });
        inFlight.add(taskPromise);
      };

      try {
        try {
          // Two named groups of a large dataset are read by cell, every gene
          // at once, when that reads less than every gene's column; the genes
          // are then tested in runs, a run of genes per worker message.
          const subset = groupA.kind === 'explicit' && groupB.kind === 'explicit'
            ? await geneLoader.readCellSubset(geneKeys, groupA.cellIndices, groupB.cellIndices)
            : null;
          if (!isCurrent()) {
            stale = true;
          } else if (subset !== null) {
            const { pointers, cellIndex, values, groupOfPosition } = subset;
            // Cell positions are non-negative, so the Int32 entries read as
            // Uint32 are the same numbers.
            const positions = new Uint32Array(cellIndex.buffer, cellIndex.byteOffset, cellIndex.length);
            // A few runs per worker even out uneven genes.
            const runLength = Math.max(1, Math.ceil(geneKeys.length / (maxInFlightGenes * 4)));
            for (let first = 0; first < geneKeys.length; first += runLength) {
              await waitForAvailableSlot(inFlight, maxInFlightGenes);
              if (!isCurrent()) {
                stale = true;
                break;
              }
              if (executionError) throw executionError;
              const last = Math.min(geneKeys.length, first + runLength);
              const from = pointers[first];
              const to = pointers[last];
              const runPointers = new Float64Array(last - first + 1);
              for (let k = 0; k <= last - first; k++) runPointers[k] = pointers[first + k] - from;
              track(
                computeManager.execute(
                  OperationType.COMPUTE_DIFFERENTIAL_OF_SUBSET,
                  {
                    groupOfPosition: groupOfPosition.slice(),
                    pointers: runPointers,
                    positions: positions.slice(from, to),
                    values: values.slice(from, to),
                    method
                  },
                  { backend, timeout: 120000, transfer: true, signal }
                ),
                run => {
                  for (let k = 0; k < last - first; k++) {
                    acceptResult(geneKeys[first + k], first + k, {
                      meanA: run.meanA[k],
                      meanB: run.meanB[k],
                      log2FoldChange: run.log2FoldChange[k],
                      pValue: run.pValue[k],
                      statistic: run.statistic[k],
                      nA: run.nA[k],
                      nB: run.nB[k],
                      method: run.method
                    });
                  }
                },
                last - first
              );
            }
          } else {
            for await (const { gene, index, values, owned } of geneLoader.streamGenesRaw(geneKeys)) {
              if (!isCurrent()) {
                stale = true;
                geneLoader.abort();
                break;
              }
              await waitForAvailableSlot(inFlight, maxInFlightGenes);
              if (!isCurrent()) {
                stale = true;
                geneLoader.abort();
                break;
              }
              if (executionError) {
                geneLoader.abort();
                throw executionError;
              }
              await holdContext();
              track(
                computeManager.execute(
                  OperationType.COMPUTE_DIFFERENTIAL_OF_COLUMN,
                  {
                    contextId,
                    // A column the run does not own is shared with a view or
                    // another run: it is copied rather than emptied by transfer.
                    values: owned ? values : values.slice(),
                    method
                  },
                  { backend, timeout: 120000, transfer: true, signal }
                ),
                deResult => acceptResult(gene, index, deResult),
                1
              );
            }
          }
        } catch (error) {
          streamError = error;
        }

        // Wait for all pending computations and propagate the first backend error.
        if (inFlight.size > 0) {
          await Promise.all(inFlight);
        }
      } finally {
        if (contextHeld !== null) {
          await contextHeld.then(
            () => computeManager.broadcast(
              OperationType.CLEAR_TWO_GROUP_CONTEXT,
              () => ({ contextId }),
              backend === 'worker' ? { backend, releases: contextId } : { backend }
            ),
            () => {}
          ).catch(error => {
            executionError ||= error;
          });
        }
      }
      if (stale || !isCurrent()) {
        progressTracker.stop();
        memScope.end({ method, stale: true });
        return null;
      }
      if (streamError) throw streamError;
      if (executionError) throw executionError;

      if (resultsByIndex.some(result => result === null)) {
        throw new Error('Differential expression completed without a result for every gene');
      }
      const results = resultsByIndex;

      // Move to next phase
      progressTracker.nextPhase();
      if (!isCurrent()) {
        progressTracker.stop();
        memScope.end({ method, stale: true });
        return null;
      }

      // Apply multiple testing correction (Benjamini-Hochberg)
      const { testedCount, untestableCount } =
        this._applyBenjaminiHochberg(results);
      const correctedResults = results;

      // Sort by p-value
      correctedResults.sort((a, b) => {
        const finiteA = Number.isFinite(a.pValue);
        const finiteB = Number.isFinite(b.pValue);
        if (finiteA && finiteB) return a.pValue - b.pValue;
        if (finiteA) return -1;
        if (finiteB) return 1;
        return 0;
      });

      // Calculate summary statistics
      let significantCount = 0;
      let upregulated = 0;
      let downregulated = 0;

      // The Benjamini-Hochberg rejection rule is inclusive: an adjusted value
      // of exactly alpha is a rejection, which is what `benjaminiHochberg`
      // reports in `significant` and what the volcano and marker filters use.
      for (const r of correctedResults) {
        const adj = r.adjustedPValue;
        if (adj === null || !Number.isFinite(adj) || adj > 0.05) continue;

        significantCount++;
        if (r.log2FoldChange > 0) upregulated++;
        else if (r.log2FoldChange < 0) downregulated++;
      }

      const duration = performance.now() - startTime;
      progressTracker.stop();
      const genesPerSecond = duration > 0
        ? Math.round((genesToTest.length * 10_000) / duration) / 10
        : null;

      memScope.end({
        genes: correctedResults.length,
        method,
        groupASize,
        groupBSize,
        durationMs: Math.round(duration)
      });

      return {
        results: correctedResults,
        summary: {
          // genesTested is the Benjamini-Hochberg denominator; genesUntestable
          // are the panel genes that never produced a p-value because a group
          // held fewer than `minCells` cells with a measured value. Reporting
          // them separately is what makes the FDR reconstructable — see
          // docs/user_guide/web_app/h_analysis/06_analysis_mode_differential_expression_de.md
          genesTested: testedCount,
          genesUntestable: untestableCount,
          minCells,
          significantGenes: significantCount,
          upregulated,
          downregulated,
          method,
          pageA,
          pageB,
          duration,
          // Include performance stats
          throughput: genesPerSecond,
          batchConfig: effectiveBatchConfig
        },
        metadata: {
          pageAName: pageAInfo.name,
          pageBName: pageBInfo.name,
          recommendedSettings: recommended
        }
      };

    } catch (error) {
      if (!isCurrent()) {
        progressTracker.stop();
        memScope.end({ method, stale: true });
        return null;
      }
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

  /**
   * Apply Benjamini-Hochberg FDR correction in place.
   *
   * Genes that never reached a test (min-cell check) carry `pValue: NaN` and
   * are excluded from the correction family, so the denominator `m` is the
   * testable subset rather than the panel size. The returned counts are the
   * two numbers the UI has to report so a reader can reconstruct the FDR.
   *
   * @param {Object[]} results - DE rows, mutated with `adjustedPValue`
   * @returns {{ testedCount: number, untestableCount: number }}
   */
  _applyBenjaminiHochberg(results) {
    const {
      adjustedPValues,
      testedCount,
      untestableCount
    } = benjaminiHochbergTestable(results.map(result => result.pValue));

    for (let i = 0; i < results.length; i++) {
      results[i].adjustedPValue = adjustedPValues[i];
    }

    return { testedCount, untestableCount };
  }

  // =========================================================================
  // Gene Signature Scoring
  // =========================================================================

  /**
   * Compute gene signature score for each cell
   *
   * @param {Object} options
   * @param {string[]} options.genes - List of genes in signature
   * @param {string[]} options.pageIds - Pages to analyze
   * @param {string} [options.method='mean'] - 'mean', 'sum', or 'median'
   * @param {import('../../jobs/cancellable-job.js').CancellableJob|null} [options.job] -
   *   The run's job: told each step; its signal stops the gene reads, which
   *   are its own
   * @returns {Promise<Object[]>} Signature scores per page
   */
  async computeSignatureScore(options) {
    const memScope = startMemoryTracking('Signature', 'computeSignatureScore', { includeUserAgent: true });
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Signature scoring options are required');
    }
    const {
      genes,
      pageIds,
      method = 'mean',
      job = null
    } = options;
    const { isCurrent, registerInvalidationCleanup } = resolveRequestOwnership(
      options,
      'Signature scoring'
    );

    if (
      !Array.isArray(genes) ||
      genes.length === 0 ||
      genes.some(gene => typeof gene !== 'string' || gene.length === 0) ||
      new Set(genes).size !== genes.length
    ) {
      memScope.end({ error: 'No genes' });
      throw new TypeError('Signature genes must be unique non-empty strings');
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
    if (!['mean', 'sum', 'median'].includes(method)) {
      memScope.end({ error: 'Invalid method' });
      throw new RangeError(`Unsupported signature scoring method: ${String(method)}`);
    }
    if (!isCurrent()) {
      memScope.end({ stale: true });
      return null;
    }

    const ownedGenes = [...genes];
    const ownedPageIds = [...pageIds];
    let hasAnalysisFailure = false;
    let analysisFailure;
    if (!isCurrent()) {
      memScope.end({ method, stale: true });
      return null;
    }

    try {
      // Each gene once, as a whole column: its sparse entries from the source
      // (or a loaded field's dense values), never gathered page by page.
      job?.step('Reading genes');
      const columns = await this.dataLayer.readGeneColumns(ownedGenes, {
        isCurrent,
        registerInvalidationCleanup,
        signal: job?.signal ?? null,
        owner: job?.id ?? null,
      });
      job?.step('Scoring cells');
      if (!isCurrent()) {
        memScope.end({ method, stale: true });
        return null;
      }
      const pointCount = this.dataLayer.state?.pointCount;
      const pages = this.dataLayer.getPageCells(ownedPageIds);

      const results = [];
      // Scoring hands the event loop back between genes and between slices
      // of cells.
      const yieldIfSliceSpent = createSlicedYield();
      const resumeAfterYield = async () => {
        const pending = yieldIfSliceSpent();
        if (pending === undefined) return true;
        await pending;
        return isCurrent();
      };

      for (const { pageId, pageName, cellIndices } of pages) {
        if (!isCurrent()) {
            memScope.end({ method, stale: true });
          return null;
        }
        if (typeof pageName !== 'string' || pageName.length === 0) {
          throw new TypeError(`Signature page ${pageId} has no name`);
        }
        const scorer = new SignaturePageScorer({
          method,
          geneCount: ownedGenes.length,
          cellIndices,
          pointCount,
        });
        for (const column of columns) {
          scorer.addGene(column);
          if (!(await resumeAfterYield())) {
                memScope.end({ method, stale: true });
            return null;
          }
        }
        const SLICE = 0x10000;
        for (let from = 0; from < cellIndices.length; from += SLICE) {
          scorer.scoreCells(from, Math.min(cellIndices.length, from + SLICE));
          if (!(await resumeAfterYield())) {
                memScope.end({ method, stale: true });
            return null;
          }
        }
        const { scores } = scorer;

        // Compute statistics
        const stats = await this._computeBasicStats(scores, job?.signal ?? null);
        if (!isCurrent()) {
            memScope.end({ method, stale: true });
          return null;
        }

        results.push({
          pageId,
          pageName,
          scores,
          cellIndices,
          statistics: stats,
          genesUsed: ownedGenes.length,
          method
        });
      }

      memScope.end({
        genes: ownedGenes.length,
        pages: ownedPageIds.length,
        method,
      });
      return results;

    } catch (error) {
      hasAnalysisFailure = true;
      analysisFailure = error;
      if (!isCurrent()) {
        memScope.end({ method, stale: true });
        return null;
      }
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
