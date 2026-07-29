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
import { getNotificationCenter } from '../../notification-center.js';
import { getBasePageIdFromRestOf, isRestOfPageId } from '../shared/page-derivation-utils.js';
import { waitForAvailableSlot } from '../shared/concurrency-utils.js';
import { StreamingGeneLoader } from '../data/streaming-gene-loader.js';
import { PerformanceConfig } from '../shared/performance-config.js';
import { ProgressTracker } from '../shared/progress-tracker.js';
import { isFiniteNumber, mean } from '../shared/number-utils.js';
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

function createNotificationOwner({
  notifications,
  notificationId,
  label,
  registerInvalidationCleanup,
}) {
  let settled = false;
  const settle = (operation, ...args) => {
    if (settled) return false;
    const handler = notifications?.[operation];
    if (typeof handler !== 'function') {
      throw new TypeError(
        `${label} notifications must implement ${operation}()`
      );
    }
    // Claim the terminal state before invoking external notification code.
    // A throwing handler must never permit a second terminal transition.
    settled = true;
    handler.call(notifications, notificationId, ...args);
    return true;
  };
  const owner = {
    complete: message => settle('complete', message),
    fail: message => settle('fail', message),
    dismiss: () => settle('dismiss'),
  };
  if (registerInvalidationCleanup !== undefined) {
    registerInvalidationCleanup(owner.dismiss);
  }
  return owner;
}

/**
 * Multi-Variable Analysis class
 */
export class MultiVariableAnalysis {
  /**
   * @param {EnhancedDataLayer} dataLayer - Enhanced data layer instance
   */
  constructor(dataLayer) {
    this.dataLayer = dataLayer;
    this._notifications = getNotificationCenter();
    this._computeManager = null;
  }

  /**
   * Get or initialize the exact-backend compute manager.
   */
  async _getComputeManager() {
    if (!this._computeManager) {
      this._computeManager = getComputeManager();
      await this._computeManager.init();
    }
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
      colorBy = null
    } = options;
    const { isCurrent, registerInvalidationCleanup } = resolveRequestOwnership(
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
    const notificationId = this._notifications.loading(
      `Computing ${method} correlation...`,
      { category: 'calculation' }
    );
    const notification = createNotificationOwner({
      notifications: this._notifications,
      notificationId,
      label: 'Correlation analysis',
      registerInvalidationCleanup,
    });
    if (!isCurrent()) {
      notification.dismiss();
      memScope.end({ method, stale: true });
      return null;
    }

    try {
      // Fetch data for variables in parallel (including colorBy if specified)
      const fetchPromises = [
        this.dataLayer.getDataForPages({
          type: ownedVarX.type,
          variableKey: ownedVarX.key,
          pageIds: ownedPageIds,
          silent: true,
        }),
        this.dataLayer.getDataForPages({
          type: ownedVarY.type,
          variableKey: ownedVarY.key,
          pageIds: ownedPageIds,
          silent: true,
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
          })
        );
      }

      const [dataX, dataY, dataColor] = await Promise.all(fetchPromises);
      if (!isCurrent()) {
        notification.dismiss();
        memScope.end({ method, stale: true });
        return null;
      }

      const results = [];
      const computeManager = await this._getComputeManager();
      if (!isCurrent()) {
        notification.dismiss();
        memScope.end({ method, stale: true });
        return null;
      }
      const maxPlotPoints = 50000;

      // Compute correlation for each page
      for (let i = 0; i < ownedPageIds.length; i++) {
        if (!isCurrent()) {
          notification.dismiss();
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
        const { xAligned, yAligned, colorAligned, xPlot, yPlot, colorPlot, sampled } = this._alignValuesByIndex(
          pageX.cellIndices, pageX.values,
          pageY.cellIndices, pageY.values,
          { maxPlotPoints, colorIndices: pageColor?.cellIndices, colorValues: pageColor?.values }
        );

        if (xAligned.length < 3) {
          throw new RangeError(
            `Correlation page "${pageId}" requires at least 3 paired values; ` +
            `received ${xAligned.length}`
          );
        }

        // Use worker for correlation computation.
        // If we keep full arrays for plotting, avoid transferring them (so they are not detached).
        // If we sampled for plotting, prefer transferring (frees memory on the calling side).
        const correlation = await computeManager.execute(
          OperationType.COMPUTE_CORRELATION,
          { xValues: xAligned, yValues: yAligned, method },
          { transfer: sampled }
        );
        if (!isCurrent()) {
          notification.dismiss();
          memScope.end({ method, stale: true });
          return null;
        }

        const result = {
          pageId,
          pageName: pageX.pageName,
          ...correlation,
          xValues: xPlot,
          yValues: yPlot,
          xVariable: ownedVarX.key,
          yVariable: ownedVarY.key,
          sampled
        };

        // Include color data if available
        if (ownedColorBy !== null) {
          result.colorValues = colorPlot;
          result.colorVariable = ownedColorBy.key;
        }

        results.push(result);
      }

      notification.complete(
        `Correlation analysis complete (${method})`
      );

      memScope.end({ pages: ownedPageIds.length, method });
      return results;

    } catch (error) {
      if (!isCurrent()) {
        notification.dismiss();
        memScope.end({ method, stale: true });
        return null;
      }
      notification.fail(`Correlation failed: ${error.message}`);
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
   * @returns {{ xAligned: Float32Array, yAligned: Float32Array, colorAligned?: string[], xPlot: Float32Array, yPlot: Float32Array, colorPlot?: string[], sampled: boolean }}
  * @private
  */
  _alignValuesByIndex(indicesA, valuesA, indicesB, valuesB, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Correlation alignment options must be an object');
    }
    const maxPlotPoints = options.maxPlotPoints === undefined
      ? 50000
      : options.maxPlotPoints;
    if (!Number.isSafeInteger(maxPlotPoints) || maxPlotPoints <= 0) {
      throw new TypeError('maxPlotPoints must be a positive safe integer');
    }
    const requireAlignedPayload = (indices, values, owner) => {
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
    requireAlignedPayload(indicesA, valuesA, 'varX');
    requireAlignedPayload(indicesB, valuesB, 'varY');

    const { colorIndices, colorValues } = options;
    const hasColor =
      colorIndices !== undefined || colorValues !== undefined;
    if (hasColor) {
      requireAlignedPayload(colorIndices, colorValues, 'colorBy');
      if (colorIndices.length === 0) {
        throw new RangeError(
          'Requested correlation color data cannot be empty'
        );
      }
    }

    // Build color lookup map if colorBy is provided
    const colorMap = new Map();
    if (hasColor) {
      for (let c = 0; c < colorIndices.length; c++) {
        colorMap.set(colorIndices[c], colorValues[c]);
      }
    }

    const lenA = indicesA.length;
    const lenB = indicesB.length;

    // First pass: count paired finite values (merge-join on sorted indices).
    let i = 0;
    let j = 0;
    let count = 0;

    while (i < lenA && j < lenB) {
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
      const idxA = indicesA[i];
      const idxB = indicesB[j];

      if (idxA === idxB) {
        const x = valuesA[i];
        const y = valuesB[j];
        if (isFiniteNumber(x) && isFiniteNumber(y)) {
          xAligned[k] = x;
          yAligned[k] = y;
          if (hasColor) {
            if (!colorMap.has(idxA)) {
              throw new RangeError(
                `Correlation color data is missing cell index ${idxA}`
              );
            }
            colorAligned[k] = colorMap.get(idxA);
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
      // Batch configuration options for optimized loading
      batchConfig: requestedBatchConfig = {}
    } = options;
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
    const recommended = PerformanceConfig.getRecommendedSettings(pointCount, genesToTest.length, { method });

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

    // Create progress tracker with ETA.
    // UI layers (e.g., DEAnalysisUI) may create their own ProgressTracker to
    // unify progress UX across analysis types, so keep this tracker silent.
    const progressTracker = new ProgressTracker({
      totalItems: genesToTest.length,
      title: 'Differential Expression',
      phases: ['Loading & Computing', 'Multiple Testing Correction'],
      showNotification: false,
      onUpdate: (stats) => {
        if (isCurrent() && onProgress) {
          onProgress({
            phase: stats.phase,
            progress: stats.progress,
            loaded: stats.completed,
            total: stats.total,
            message: stats.phaseIndex === 0
              ? `Analyzing genes (${stats.completed.toLocaleString()}/${stats.total.toLocaleString()})`
              : 'Applying multiple testing correction...'
          });
        }
      }
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
        progressTracker.cancel();
        geneLoader?.abort();
      });
    }

    try {
      if (!isCurrent()) {
        progressTracker.cancel();
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

      progressTracker.setMessage(
        `${pageAInfo.name} (${groupASize.toLocaleString()}) vs ` +
        `${pageBInfo.name} (${groupBSize.toLocaleString()})`
      );

      computeManager = await this._getComputeManager();
      if (!isCurrent()) {
        progressTracker.cancel();
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
      let maxInFlightGenes =
        parallelism === 'auto' ? poolSize : parallelism;

      const bytesPerGene = pointCount * 4 * (method === 'wilcox' ? 2 : 1);
      const budget = effectiveBatchConfig.memoryBudgetMB * 1024 * 1024;
      const maxByMemory = Math.max(1, Math.floor(budget / Math.max(1, bytesPerGene)));

      maxInFlightGenes = Math.max(1, Math.min(maxInFlightGenes, maxByMemory, poolSize, 8));

      // Create streaming gene loader with optimized prefetching
      geneLoader = new StreamingGeneLoader({
        dataLayer: this.dataLayer,
        config: effectiveBatchConfig
        // Note: Progress is handled by progressTracker, not the loader
      });

      /** @type {Array<Object|null>} */
      const resultsByIndex = new Array(genesToTest.length).fill(null);
      /** @type {Set<Promise<void>>} */
      const inFlight = new Set();
      let executionError = null;
      let stale = false;
      let streamError = null;

      // Stream genes with optimized prefetching
      const geneKeys = genesToTest.map(g => g.key);

      try {
        for await (const { gene, valuesA, valuesB, index } of
          geneLoader.streamGenes(geneKeys, groupA, groupB)) {
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

          const nA = valuesA.length;
          const nB = valuesB.length;

          if (nA < minCells || nB < minCells) {
            resultsByIndex[index] = {
              gene,
              error: `Insufficient cells (A: ${nA}, B: ${nB})`,
              meanA: nA > 0 ? mean(valuesA) : NaN,
              meanB: nB > 0 ? mean(valuesB) : NaN,
              log2FoldChange: NaN,
              pValue: NaN,
              nA,
              nB,
              method
            };
            if (isCurrent()) progressTracker.itemComplete();
            continue;
          }

          let taskPromise;
          taskPromise = computeManager.execute(
            OperationType.COMPUTE_DIFFERENTIAL,
            { groupAValues: valuesA, groupBValues: valuesB, method },
            { backend, timeout: 120000, transfer: true }
          )
            .then((deResult) => {
              if (!isCurrent()) return;
              if (
                !deResult ||
                !Number.isSafeInteger(deResult.nA) ||
                !Number.isSafeInteger(deResult.nB) ||
                deResult.nA < 0 ||
                deResult.nB < 0 ||
                deResult.nA > nA ||
                deResult.nB > nB
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
            })
            .catch((error) => {
              executionError ||= error;
            })
            .finally(() => {
              inFlight.delete(taskPromise);
              if (isCurrent()) progressTracker.itemComplete();
            });

          inFlight.add(taskPromise);
        }
      } catch (error) {
        streamError = error;
      }

      // Wait for all pending computations and propagate the first backend error.
      if (inFlight.size > 0) {
        await Promise.all(inFlight);
      }
      if (stale || !isCurrent()) {
        progressTracker.cancel();
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
      progressTracker.nextPhase('Applying multiple testing correction...');
      if (!isCurrent()) {
        progressTracker.cancel();
        memScope.end({ method, stale: true });
        return null;
      }

      // Apply multiple testing correction (Benjamini-Hochberg)
      const correctedResults = this._benjaminiHochberg(results);

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

      for (const r of correctedResults) {
        const adj = r.adjustedPValue;
        if (adj === null || !Number.isFinite(adj) || adj >= 0.05) continue;

        significantCount++;
        if (r.log2FoldChange > 0) upregulated++;
        else if (r.log2FoldChange < 0) downregulated++;
      }

      const duration = performance.now() - startTime;
      const stats = progressTracker.complete(
        `${significantCount} significant genes found (${(duration / 1000).toFixed(1)}s)`
      );

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
          totalGenes: correctedResults.length,
          significantGenes: significantCount,
          upregulated,
          downregulated,
          method,
          pageA,
          pageB,
          duration,
          // Include performance stats
          throughput: stats.throughputPerSecond,
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
        progressTracker.cancel();
        memScope.end({ method, stale: true });
        return null;
      }
      hasAnalysisFailure = true;
      analysisFailure = error;
      progressTracker.fail(`DE analysis failed: ${error.message}`);
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
   * Benjamini-Hochberg procedure for FDR correction
   */
  _benjaminiHochberg(results) {
    // Initialize adjusted p-values (in-place to avoid duplicating large result arrays).
    for (let i = 0; i < results.length; i++) {
      results[i].adjustedPValue = null;
    }

    // Collect valid p-values with indices.
    const valid = [];
    for (let i = 0; i < results.length; i++) {
      const pValue = results[i]?.pValue;
      if (Number.isFinite(pValue)) {
        valid.push({ index: i, pValue });
      }
    }

    if (valid.length === 0) {
      return results;
    }

    // Sort by p-value.
    valid.sort((a, b) => a.pValue - b.pValue);

    // Benjamini-Hochberg procedure (in-place assignment).
    const m = valid.length;
    let nextAdj = valid[m - 1].pValue;
    results[valid[m - 1].index].adjustedPValue = Math.min(nextAdj, 1);

    for (let i = m - 2; i >= 0; i--) {
      const rawP = valid[i].pValue * m / (i + 1);
      nextAdj = Math.min(rawP, nextAdj);
      results[valid[i].index].adjustedPValue = Math.min(nextAdj, 1);
    }

    return results;
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
      method = 'mean'
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
    const notificationId = this._notifications.loading(
      `Computing signature score (${ownedGenes.length} genes)...`,
      { category: 'calculation' }
    );
    const notification = createNotificationOwner({
      notifications: this._notifications,
      notificationId,
      label: 'Signature scoring',
      registerInvalidationCleanup,
    });
    let hasAnalysisFailure = false;
    let analysisFailure;
    if (!isCurrent()) {
      notification.dismiss();
      memScope.end({ method, stale: true });
      return null;
    }

    try {
      // Fetch gene expression for signature genes
      const geneData = await this.dataLayer.getGeneExpressionSubset(
        ownedGenes,
        ownedPageIds,
        {
          isCurrent: options.isCurrent,
          registerInvalidationCleanup,
        }
      );
      if (!isCurrent()) {
        notification.dismiss();
        memScope.end({ method, stale: true });
        return null;
      }

      const results = [];

      for (const pageId of ownedPageIds) {
        if (!isCurrent()) {
          notification.dismiss();
          memScope.end({ method, stale: true });
          return null;
        }
        const firstGeneData = geneData?.[ownedGenes[0]]?.[pageId];
        if (!firstGeneData || !firstGeneData.values || !firstGeneData.cellIndices) {
          throw new Error(
            `Signature data is missing for gene ${ownedGenes[0]} on page ${pageId}`
          );
        }
        if (
          firstGeneData.values.length !== firstGeneData.cellIndices.length ||
          typeof firstGeneData.pageName !== 'string' ||
          firstGeneData.pageName.length === 0
        ) {
          throw new TypeError(
            `Signature data for gene ${ownedGenes[0]} on page ${pageId} is malformed`
          );
        }

        const cellCount = firstGeneData.values.length;
        const scores = new Float32Array(cellCount);
        const validCounts = method === 'median'
          ? null
          : (
            ownedGenes.length > 65535
              ? new Uint32Array(cellCount)
              : new Uint16Array(cellCount)
          );
        const pageGeneData = ownedGenes.map(gene => {
          const genePageData = geneData?.[gene]?.[pageId];
          if (!genePageData || !genePageData.values || !genePageData.cellIndices) {
            throw new Error(`Signature data is missing for gene ${gene} on page ${pageId}`);
          }
          if (
            genePageData.values.length !== cellCount ||
            genePageData.cellIndices.length !== cellCount
          ) {
            throw new RangeError(
              `Signature gene ${gene} does not align with page ${pageId}`
            );
          }
          for (let index = 0; index < cellCount; index++) {
            if (genePageData.cellIndices[index] !== firstGeneData.cellIndices[index]) {
              throw new RangeError(
                `Signature gene ${gene} has a different cell order on page ${pageId}`
              );
            }
          }
          return genePageData;
        });

        if (method === 'median') {
          const valuesForCell = [];
          for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
            valuesForCell.length = 0;
            for (const genePageData of pageGeneData) {
              const value = genePageData.values[cellIndex];
              if (isFiniteNumber(value)) valuesForCell.push(value);
            }
            if (valuesForCell.length === 0) {
              scores[cellIndex] = NaN;
              continue;
            }
            valuesForCell.sort((a, b) => a - b);
            const middle = Math.floor(valuesForCell.length / 2);
            scores[cellIndex] = valuesForCell.length % 2 === 0
              ? (valuesForCell[middle - 1] + valuesForCell[middle]) / 2
              : valuesForCell[middle];
          }
        } else {
          for (const genePageData of pageGeneData) {
            for (let i = 0; i < genePageData.values.length; i++) {
              const val = genePageData.values[i];
              if (isFiniteNumber(val)) {
                scores[i] += val;
                validCounts[i]++;
              }
            }
          }

          for (let i = 0; i < cellCount; i++) {
            const count = validCounts[i];
            if (count === 0) {
              scores[i] = NaN;
              continue;
            }
            if (method === 'mean') {
              scores[i] = scores[i] / count;
            }
          }
        }

        // Compute statistics
        const stats = this._computeBasicStats(scores);

        results.push({
          pageId,
          pageName: firstGeneData.pageName,
          scores,
          cellIndices: firstGeneData.cellIndices,
          statistics: stats,
          genesUsed: ownedGenes.length,
          method
        });
      }

      notification.complete('Signature score computed');

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
        notification.dismiss();
        memScope.end({ method, stale: true });
        return null;
      }
      notification.fail(`Signature scoring failed: ${error.message}`);
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
   * Exact basic statistics helper.
   * @param {ArrayLike<number>} values
   */
  _computeBasicStats(values) {
    if (!values || !Number.isSafeInteger(values.length) || values.length < 0) {
      throw new TypeError('Signature statistics require an array-like value collection');
    }
    let count = 0;
    let meanVal = 0;
    let m2 = 0;
    let min = Infinity;
    let max = -Infinity;

    /** @type {number[]} */
    const finiteValues = [];

    for (let i = 0; i < values.length; i++) {
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

      finiteValues.push(x);
    }

    if (count === 0) {
      return { count: 0, mean: NaN, median: NaN, min: NaN, max: NaN, std: NaN };
    }

    const variance = m2 / count;
    if (variance < 0) {
      throw new RangeError('Signature variance cannot be negative');
    }
    const stdVal = Math.sqrt(variance);

    finiteValues.sort((a, b) => a - b);
    const mid = Math.floor(finiteValues.length / 2);
    const medianVal = finiteValues.length % 2 === 0
      ? (finiteValues[mid - 1] + finiteValues[mid]) / 2
      : finiteValues[mid];

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

export default MultiVariableAnalysis;
