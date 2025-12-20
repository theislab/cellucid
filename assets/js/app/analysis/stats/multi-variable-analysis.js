/**
 * Multi-Variable Analysis Module
 *
 * Provides advanced analysis capabilities for comparing multiple variables:
 * - Correlation analysis between two continuous variables
 * - Differential expression analysis between pages
 * - Multi-gene signature scoring
 * - Co-expression analysis
 *
 * Designed for scientists who need deeper insights beyond single-variable comparisons.
 */

import { getComputeManager } from '../compute/compute-manager.js';
import { getNotificationCenter } from '../../notification-center.js';
import { getBasePageIdFromRestOf, isRestOfPageId } from '../shared/page-derivation-utils.js';
import { waitForAvailableSlot } from '../shared/concurrency-utils.js';
import { StreamingGeneLoader } from '../data/streaming-gene-loader.js';
import { PerformanceConfig } from '../shared/performance-config.js';
import { ProgressTracker } from '../shared/progress-tracker.js';
import { isFiniteNumber, mean } from '../shared/number-utils.js';
import { startMemoryTracking } from '../shared/memory-tracker.js';
import { bestEffortCleanupAnalysisResources } from '../shared/resource-cleanup.js';

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
   * Get or initialize compute manager (GPU -> Worker -> CPU fallback)
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
    const { varX, varY, pageIds, method = 'pearson' } = options;

    if (!varX || !varY || !pageIds || pageIds.length === 0) {
      memScope.end({ error: 'Invalid options' });
      throw new Error('Invalid correlation analysis options');
    }

    const notificationId = this._notifications.loading(
      `Computing ${method} correlation...`,
      { category: 'calculation' }
    );

    try {
      // Fetch data for both variables in parallel
      const [dataX, dataY] = await Promise.all([
        this.dataLayer.getDataForPages({
          type: varX.type,
          variableKey: varX.key,
          pageIds
        }),
        this.dataLayer.getDataForPages({
          type: varY.type,
          variableKey: varY.key,
          pageIds
        })
      ]);

      const results = [];
      const computeManager = await this._getComputeManager();
      const maxPlotPoints = 50000;

      // Compute correlation for each page
      for (let i = 0; i < pageIds.length; i++) {
        const pageX = dataX.find(d => d.pageId === pageIds[i]);
        const pageY = dataY.find(d => d.pageId === pageIds[i]);

        if (!pageX || !pageY) {
          results.push({
            pageId: pageIds[i],
            pageName: pageX?.pageName || pageY?.pageName || `Page ${i + 1}`,
            error: 'Data not available'
          });
          continue;
        }

        // Align values by cell index
        const { xAligned, yAligned, xPlot, yPlot, sampled } = this._alignValuesByIndex(
          pageX.cellIndices, pageX.values,
          pageY.cellIndices, pageY.values,
          { maxPlotPoints }
        );

        if (xAligned.length < 3) {
          results.push({
            pageId: pageIds[i],
            pageName: pageX.pageName,
            error: 'Insufficient paired values',
            n: xAligned.length
          });
          continue;
        }

        // Use worker for correlation computation.
        // If we keep full arrays for plotting, avoid transferring them (so they are not detached).
        // If we sampled for plotting, prefer transferring (frees memory on the calling side).
        const correlation = await computeManager.computeCorrelation(xAligned, yAligned, method, {
          transfer: sampled
        });

        results.push({
          pageId: pageIds[i],
          pageName: pageX.pageName,
          ...correlation,
          xValues: xPlot,
          yValues: yPlot,
          xVariable: varX.key,
          yVariable: varY.key,
          sampled
        });
      }

      this._notifications.complete(notificationId,
        `Correlation analysis complete (${method})`
      );

      memScope.end({ pages: pageIds.length, method });
      return results;

    } catch (error) {
      this._notifications.fail(notificationId, `Correlation failed: ${error.message}`);
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
   * @param {{ maxPlotPoints?: number }} [options]
   * @returns {{ xAligned: Float32Array, yAligned: Float32Array, xPlot: Float32Array, yPlot: Float32Array, sampled: boolean }}
   * @private
   */
  _alignValuesByIndex(indicesA, valuesA, indicesB, valuesB, options = {}) {
    const maxPlotPoints = Number.isFinite(options.maxPlotPoints)
      ? Math.max(1, Math.floor(options.maxPlotPoints))
      : 50000;

    const lenA = indicesA?.length || 0;
    const lenB = indicesB?.length || 0;

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
      return { xAligned, yAligned, xPlot: xAligned, yPlot: yAligned, sampled: false };
    }

    // Downsample for plotting (deterministic stride).
    const step = Math.ceil(count / maxPlotPoints);
    const plotCount = Math.min(maxPlotPoints, Math.ceil(count / step));
    const xPlot = new Float32Array(plotCount);
    const yPlot = new Float32Array(plotCount);

    for (let out = 0, idx = 0; out < plotCount && idx < count; out++, idx += step) {
      xPlot[out] = xAligned[idx];
      yPlot[out] = yAligned[idx];
    }

    return { xAligned, yAligned, xPlot, yPlot, sampled: true };
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
   * @returns {Promise<Object>} Differential expression results
   */
  async differentialExpression(options) {
    const memScope = startMemoryTracking('DE', 'differentialExpression', { includeUserAgent: true });
    const {
      pageA,
      pageB,
      geneList = null,
      method = 'wilcox',
      minCells = 10,
      parallelism = 'auto',
      onProgress,
      // Batch configuration options for optimized loading
      batchConfig = {}
    } = options;

    if (!pageA || !pageB) {
      memScope.end({ error: 'Missing pages' });
      throw new Error('Two pages required for differential expression');
    }

    const startTime = performance.now();

    // Get data characteristics for recommended settings
    const pointCount = Number.isFinite(this.dataLayer?.state?.pointCount)
      ? this.dataLayer.state.pointCount
      : 100000; // Conservative fallback

    // Get available genes
    const allGenes = this.dataLayer.getAvailableVariables('gene_expression');
    const genesToTest = geneList
      ? (() => {
        const keep = new Set(geneList);
        return allGenes.filter(g => keep.has(g.key));
      })()
      : allGenes;

    if (genesToTest.length === 0) {
      memScope.end({ error: 'No genes' });
      throw new Error('No genes available for analysis');
    }

    // Get recommended settings based on data size
    const recommended = PerformanceConfig.getRecommendedSettings(pointCount, genesToTest.length, { method });

    // Merge user batch config with recommended settings
    const effectiveBatchConfig = {
      preloadCount: batchConfig.preloadCount || recommended.preloadCount,
      memoryBudgetMB: batchConfig.memoryBudgetMB || recommended.memoryBudgetMB,
      networkConcurrency: batchConfig.networkConcurrency || recommended.networkConcurrency
    };

    console.log('[DE] Effective config:', {
      preloadCount: effectiveBatchConfig.preloadCount,
      memoryBudgetMB: effectiveBatchConfig.memoryBudgetMB,
      networkConcurrency: effectiveBatchConfig.networkConcurrency,
      genes: genesToTest.length,
      cells: pointCount
    });

    // Create progress tracker with ETA
    const progressTracker = new ProgressTracker({
      totalItems: genesToTest.length,
      title: 'Differential Expression',
      phases: ['Loading & Computing', 'Multiple Testing Correction'],
      onUpdate: (stats) => {
        if (onProgress) {
          onProgress(stats.progress);
        }
      }
    });

    progressTracker.start();

    /** @type {import('../compute/compute-manager.js').ComputeManager|null} */
    let computeManager = null;
    let didStartHeavyCompute = false;

    try {
      const pageAInfo = this.dataLayer.getPageInfo(pageA) || { id: pageA, name: pageA };
      const pageBInfo = this.dataLayer.getPageInfo(pageB) || { id: pageB, name: pageB };

      /**
       * Build group specification for a page
       * @param {string} pageId
       * @returns {Object} Group specification
       */
      const buildGroupSpec = (pageId) => {
        const pageInfo = this.dataLayer.getPageInfo(pageId);
        const pageName = pageInfo?.name || pageId;

        if (isRestOfPageId(pageId)) {
          const baseId = getBasePageIdFromRestOf(pageId);
          if (!baseId) {
            return { kind: 'explicit', pageId, pageName, cellIndices: [], isRestOf: false };
          }
          const excludedCellIndices = this.dataLayer.getCellIndicesForPage(baseId);
          return { kind: 'rest_of', pageId, pageName, baseId, excludedCellIndices, isRestOf: true };
        }

        const cellIndices = this.dataLayer.getCellIndicesForPage(pageId);
        return { kind: 'explicit', pageId, pageName, cellIndices, isRestOf: false };
      };

      const groupA = buildGroupSpec(pageA);
      const groupB = buildGroupSpec(pageB);

      const getGroupSize = (group, totalCells) => {
        if (group.kind === 'rest_of') {
          return Number.isFinite(totalCells) ? Math.max(0, totalCells - group.excludedCellIndices.length) : null;
        }
        return group.cellIndices.length;
      };

      const groupASize = getGroupSize(groupA, pointCount);
      const groupBSize = getGroupSize(groupB, pointCount);

      progressTracker.setMessage(
        `${pageAInfo.name} (${groupASize?.toLocaleString() ?? '—'}) vs ${pageBInfo.name} (${groupBSize?.toLocaleString() ?? '—'})`
      );

      // Compute differential expression for each gene
      computeManager = await this._getComputeManager();
      didStartHeavyCompute = true;

      const workerPoolSize = computeManager.getStatus?.().worker?.stats?.poolSize || 1;
      const workersAvailable = typeof computeManager.isWorkerAvailable === 'function'
        ? computeManager.isWorkerAvailable()
        : false;

      // Calculate max in-flight computations based on memory and workers
      const groupTotalSize = Number.isFinite(groupASize) && Number.isFinite(groupBSize)
        ? groupASize + groupBSize
        : null;

      let maxInFlightGenes = 1;
      if (workersAvailable && workerPoolSize > 0) {
        const requested = parallelism === 'auto' ? workerPoolSize : Number(parallelism);
        maxInFlightGenes = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 1;

        if (Number.isFinite(groupTotalSize) && groupTotalSize > 0) {
          const baseBytes = groupTotalSize * 4;
          const overheadFactor = method === 'wilcox' ? 5 : 2;
          const estimatedBytesPerGene = baseBytes * overheadFactor;
          const budget = effectiveBatchConfig.memoryBudgetMB * 1024 * 1024;
          const maxByMemory = Math.max(1, Math.floor(budget / Math.max(1, estimatedBytesPerGene)));
          maxInFlightGenes = Math.min(maxInFlightGenes, maxByMemory);
        }

        maxInFlightGenes = Math.max(1, Math.min(maxInFlightGenes, workerPoolSize, 8));
      }

      // Create streaming gene loader with optimized prefetching
      const geneLoader = new StreamingGeneLoader({
        dataLayer: this.dataLayer,
        config: effectiveBatchConfig
        // Note: Progress is handled by progressTracker, not the loader
      });

      /** @type {Array<Object|null>} */
      const resultsByIndex = new Array(genesToTest.length).fill(null);
      /** @type {Set<Promise<void>>} */
      const inFlight = new Set();

      // Stream genes with optimized prefetching
      const geneKeys = genesToTest.map(g => g.key);

      for await (const { gene, valuesA, valuesB, index } of
        geneLoader.streamGenes(geneKeys, groupA, groupB)) {

        // Keep a bounded number of in-flight worker computations
        await waitForAvailableSlot(inFlight, maxInFlightGenes);

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
            nB
          };
          progressTracker.itemComplete();
          continue;
        }

        // Fire-and-forget compute on worker
        let taskPromise;
        taskPromise = computeManager.computeDifferential(valuesA, valuesB, method)
          .then((deResult) => {
            if ((deResult.nA ?? 0) < minCells || (deResult.nB ?? 0) < minCells) {
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
            resultsByIndex[index] = { gene, ...deResult };
          })
          .catch((err) => {
            resultsByIndex[index] = {
              gene,
              error: err?.message || String(err),
              meanA: NaN,
              meanB: NaN,
              log2FoldChange: NaN,
              pValue: NaN
            };
          })
          .finally(() => {
            inFlight.delete(taskPromise);
            progressTracker.itemComplete();
          });

        inFlight.add(taskPromise);
      }

      // Wait for all pending worker computations
      if (inFlight.size > 0) {
        await Promise.all(inFlight);
      }

      const results = resultsByIndex.map((r, idx) => r || ({
        gene: genesToTest[idx]?.key || `gene_${idx}`,
        error: 'No result',
        meanA: NaN,
        meanB: NaN,
        log2FoldChange: NaN,
        pValue: NaN
      }));

      // Move to next phase
      progressTracker.nextPhase('Applying multiple testing correction...');

      // Apply multiple testing correction (Benjamini-Hochberg)
      const correctedResults = this._benjaminiHochberg(results);

      // Sort by p-value
      correctedResults.sort((a, b) => {
        const pA = Number.isFinite(a.pValue) ? a.pValue : 1;
        const pB = Number.isFinite(b.pValue) ? b.pValue : 1;
        return pA - pB;
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
          pageAName: pageAInfo.name || pageA,
          pageBName: pageBInfo.name || pageB,
          recommendedSettings: recommended
        }
      };

    } catch (error) {
      progressTracker.fail(`DE analysis failed: ${error.message}`);
      memScope.end({ method, error: error.message });
      throw error;
    } finally {
      if (didStartHeavyCompute) {
        bestEffortCleanupAnalysisResources({
          computeManager,
          dataLayer: this.dataLayer,
          clearSourceCaches: true,
          keepAtLeastIdleWorkers: 0
        });
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
   * @param {string} [options.method='mean'] - 'mean', 'sum', or 'weighted'
   * @param {Object} [options.weights] - Gene weights for weighted method
   * @returns {Promise<Object[]>} Signature scores per page
   */
  async computeSignatureScore(options) {
    const memScope = startMemoryTracking('Signature', 'computeSignatureScore', { includeUserAgent: true });
    const { genes, pageIds, method = 'mean', weights = null } = options;

    if (!genes || genes.length === 0) {
      memScope.end({ error: 'No genes' });
      throw new Error('At least one gene required for signature');
    }

    const notificationId = this._notifications.loading(
      `Computing signature score (${genes.length} genes)...`,
      { category: 'calculation' }
    );

    try {
      // Fetch gene expression for signature genes
      const geneData = await this.dataLayer.getGeneExpressionSubset(genes, pageIds);

      const results = [];

      for (const pageId of pageIds) {
        // Get cell indices from first gene (should be same for all)
        const firstGeneData = geneData[genes[0]]?.[pageId];
        if (!firstGeneData) {
          results.push({
            pageId,
            error: 'No data available',
            scores: []
          });
          continue;
        }

        const cellCount = firstGeneData.values.length;
        const scores = new Float32Array(cellCount);
        const validCounts = genes.length > 65535 ? new Uint32Array(cellCount) : new Uint16Array(cellCount);

        // Aggregate gene values
        for (const gene of genes) {
          const genePageData = geneData[gene]?.[pageId];
          if (!genePageData) continue;

          const weight = weights?.[gene] ?? 1;
          const useWeight = method === 'weighted' && weight !== 1;

          for (let i = 0; i < genePageData.values.length; i++) {
            const val = genePageData.values[i];
            if (isFiniteNumber(val)) {
              scores[i] += useWeight ? (val * weight) : val;
              validCounts[i]++;
            }
          }
        }

        // Compute final scores in-place based on method (avoid duplicating huge arrays)
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

        // Compute statistics
        const stats = this._computeBasicStats(scores);

        results.push({
          pageId,
          pageName: firstGeneData.pageName,
          scores,
          cellIndices: firstGeneData.cellIndices,
          statistics: stats,
          genesUsed: genes.length,
          method
        });
      }

      this._notifications.complete(notificationId, 'Signature score computed');

      memScope.end({ genes: genes.length, pages: pageIds.length, method });
      return results;

    } catch (error) {
      this._notifications.fail(notificationId, `Signature scoring failed: ${error.message}`);
      memScope.end({ method, error: error.message });
      throw error;
    } finally {
      bestEffortCleanupAnalysisResources({
        computeManager: this._computeManager,
        dataLayer: this.dataLayer,
        clearSourceCaches: true,
        dataLayerCleanup: 'bulk',
        keepAtLeastIdleWorkers: 0
      });
    }
  }

  /**
   * Basic statistics helper
   * Uses reservoir sampling for median to avoid sorting giant arrays.
   * @param {ArrayLike<number>} values
   * @param {{ maxSampleSize?: number }} [options]
   */
  _computeBasicStats(values, options = {}) {
    const maxSampleSize = Number.isFinite(options.maxSampleSize)
      ? Math.max(10, Math.floor(options.maxSampleSize))
      : 10000;

    let count = 0;
    let meanVal = 0;
    let m2 = 0;
    let min = Infinity;
    let max = -Infinity;

    /** @type {number[]} */
    const reservoir = [];

    for (let i = 0; i < (values?.length || 0); i++) {
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

      // Reservoir sample for median approximation
      if (reservoir.length < maxSampleSize) {
        reservoir.push(x);
      } else {
        const j = Math.floor(Math.random() * count);
        if (j < maxSampleSize) {
          reservoir[j] = x;
        }
      }
    }

    if (count === 0) {
      return { count: 0, mean: NaN, median: NaN, min: NaN, max: NaN, std: NaN };
    }

    const variance = m2 / count;
    const stdVal = Math.sqrt(Math.max(0, variance));

    reservoir.sort((a, b) => a - b);
    const sampleLen = reservoir.length;
    const mid = Math.floor(sampleLen / 2);
    const medianVal = sampleLen % 2 === 0
      ? (reservoir[mid - 1] + reservoir[mid]) / 2
      : reservoir[mid];

    return {
      count,
      mean: meanVal,
      median: medianVal,
      min,
      max,
      std: stdVal,
      approximate: sampleLen < count,
      sampleSize: sampleLen
    };
  }

  // =========================================================================
  // Co-expression Analysis
  // =========================================================================

  /**
   * Compute co-expression matrix for a set of genes
   *
   * @param {Object} options
   * @param {string[]} options.genes - Genes to analyze
   * @param {string[]} options.pageIds - Pages to include
   * @param {string} [options.method='pearson'] - Correlation method
   * @returns {Promise<Object>} Co-expression matrix and clustering
   */
  async coexpressionAnalysis(options) {
    const memScope = startMemoryTracking('Coexpression', 'coexpressionAnalysis', { includeUserAgent: true });
    const { genes, pageIds, method = 'pearson' } = options;

    if (!genes || genes.length < 2) {
      memScope.end({ error: 'Insufficient genes' });
      throw new Error('At least 2 genes required for co-expression analysis');
    }

    const notificationId = this._notifications.show({
      type: 'progress',
      category: 'calculation',
      title: 'Co-expression Analysis',
      message: `Analyzing ${genes.length} genes...`,
      progress: 0
    });

    try {
      // Fetch gene expression data
      const geneData = await this.dataLayer.getGeneExpressionSubset(genes, pageIds);

      // Combine all cells from all pages
      const combinedValues = {};
      const allCellIndices = new Set();

      for (const gene of genes) {
        combinedValues[gene] = new Map();
        for (const pageId of pageIds) {
          const pageData = geneData[gene]?.[pageId];
          if (!pageData) continue;

          for (let i = 0; i < pageData.cellIndices.length; i++) {
            const globalIdx = `${pageId}:${pageData.cellIndices[i]}`;
            combinedValues[gene].set(globalIdx, pageData.values[i]);
            allCellIndices.add(globalIdx);
          }
        }
      }

      // Build expression matrix
      const cellIndexList = Array.from(allCellIndices);
      const expressionMatrix = genes.map(gene => {
        return cellIndexList.map(idx => combinedValues[gene].get(idx) ?? NaN);
      });

      // Compute pairwise correlations
      const n = genes.length;
      const correlationMatrix = [];
      const pValueMatrix = [];
      const computeManager = await this._getComputeManager();

      let computedPairs = 0;
      const totalPairs = (n * (n - 1)) / 2;

      for (let i = 0; i < n; i++) {
        correlationMatrix[i] = new Array(n).fill(0);
        pValueMatrix[i] = new Array(n).fill(1);
        correlationMatrix[i][i] = 1; // Self-correlation
        pValueMatrix[i][i] = 0;
      }

      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const result = await computeManager.computeCorrelation(
            expressionMatrix[i],
            expressionMatrix[j],
            method
          );

          correlationMatrix[i][j] = result.r;
          correlationMatrix[j][i] = result.r;
          pValueMatrix[i][j] = result.pValue;
          pValueMatrix[j][i] = result.pValue;

          computedPairs++;
          const progress = Math.round((computedPairs / totalPairs) * 100);
          this._notifications.updateProgress(notificationId, progress, {
            message: `Computing correlations (${computedPairs}/${totalPairs})...`
          });
        }
      }

      this._notifications.complete(notificationId,
        `Co-expression: ${genes.length} genes analyzed`
      );

      memScope.end({ genes: genes.length, pages: pageIds.length, method });
      return {
        genes,
        correlationMatrix,
        pValueMatrix,
        method,
        cellCount: cellIndexList.length
      };

    } catch (error) {
      this._notifications.fail(notificationId, `Co-expression failed: ${error.message}`);
      memScope.end({ method, error: error.message });
      throw error;
    } finally {
      bestEffortCleanupAnalysisResources({
        computeManager: this._computeManager,
        dataLayer: this.dataLayer,
        clearSourceCaches: true,
        dataLayerCleanup: 'bulk',
        keepAtLeastIdleWorkers: 0
      });
    }
  }

  // =========================================================================
  // Comparative Statistics
  // =========================================================================

  /**
   * Compare a continuous variable between all pairs of pages
   *
   * @param {Object} options
   * @param {Object} options.variable - { type, key }
   * @param {string[]} options.pageIds - Pages to compare
   * @param {string} [options.method='wilcox'] - Statistical test
   * @returns {Promise<Object>} Pairwise comparison results
   */
  async pairwiseComparison(options) {
    const { variable, pageIds, method = 'wilcox' } = options;

    if (pageIds.length < 2) {
      throw new Error('At least 2 pages required for pairwise comparison');
    }

    const notificationId = this._notifications.loading(
      'Computing pairwise comparisons...',
      { category: 'calculation' }
    );

    try {
      // Fetch data for all pages
      const pageData = await this.dataLayer.getDataForPages({
        type: variable.type,
        variableKey: variable.key,
        pageIds
      });

      const comparisons = [];
      const computeManager = await this._getComputeManager();

      // Compare all pairs
      for (let i = 0; i < pageData.length; i++) {
        for (let j = i + 1; j < pageData.length; j++) {
          const dataA = pageData[i];
          const dataB = pageData[j];

          const valsA = dataA.values.filter(v => isFiniteNumber(v));
          const valsB = dataB.values.filter(v => isFiniteNumber(v));

          const result = await computeManager.computeDifferential(valsA, valsB, method);

          comparisons.push({
            pageA: dataA.pageId,
            pageB: dataB.pageId,
            pageAName: dataA.pageName,
            pageBName: dataB.pageName,
            ...result
          });
        }
      }

      // Apply multiple testing correction
      const corrected = this._benjaminiHochberg(comparisons);

      this._notifications.complete(notificationId,
        `Pairwise comparisons complete (${comparisons.length} pairs)`
      );

      return {
        comparisons: corrected,
        variable: variable.key,
        method,
        pageCount: pageIds.length
      };

    } catch (error) {
      this._notifications.fail(notificationId, `Comparison failed: ${error.message}`);
      throw error;
    }
  }
}

/**
 * Create a multi-variable analysis instance
 */
export function createMultiVariableAnalysis(dataLayer) {
  return new MultiVariableAnalysis(dataLayer);
}

export default MultiVariableAnalysis;
