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
    const { varX, varY, pageIds, method = 'pearson' } = options;

    if (!varX || !varY || !pageIds || pageIds.length === 0) {
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
        const { xAligned, yAligned } = this._alignValuesByIndex(
          pageX.cellIndices, pageX.values,
          pageY.cellIndices, pageY.values
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

        // Use worker for correlation computation
        const correlation = await computeManager.computeCorrelation(xAligned, yAligned, method);

        results.push({
          pageId: pageIds[i],
          pageName: pageX.pageName,
          ...correlation,
          xValues: xAligned,
          yValues: yAligned,
          xVariable: varX.key,
          yVariable: varY.key
        });
      }

      this._notifications.complete(notificationId,
        `Correlation analysis complete (${method})`
      );

      return results;

    } catch (error) {
      this._notifications.fail(notificationId, `Correlation failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Align two value arrays by matching cell indices
   */
  _alignValuesByIndex(indicesA, valuesA, indicesB, valuesB) {
    const mapA = new Map();
    for (let i = 0; i < indicesA.length; i++) {
      mapA.set(indicesA[i], valuesA[i]);
    }

    const xAligned = [];
    const yAligned = [];

    for (let i = 0; i < indicesB.length; i++) {
      const idx = indicesB[i];
      if (mapA.has(idx)) {
        const xVal = mapA.get(idx);
        const yVal = valuesB[i];

        // Only include valid numeric pairs
        if (typeof xVal === 'number' && Number.isFinite(xVal) &&
            typeof yVal === 'number' && Number.isFinite(yVal)) {
          xAligned.push(xVal);
          yAligned.push(yVal);
        }
      }
    }

    return { xAligned, yAligned };
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
   * @param {Function} [options.onProgress] - Progress callback
   * @returns {Promise<Object>} Differential expression results
   */
  async differentialExpression(options) {
    const {
      pageA,
      pageB,
      geneList = null,
      method = 'wilcox',
      minCells = 10,
      onProgress
    } = options;

    if (!pageA || !pageB) {
      throw new Error('Two pages required for differential expression');
    }

    // Show loading notification
    const notificationId = this._notifications.show({
      type: 'progress',
      category: 'calculation',
      title: 'Differential Expression',
      message: 'Loading gene expression data...',
      progress: 0
    });

    const startTime = performance.now();

    try {
      // Get available genes
      const allGenes = this.dataLayer.getAvailableVariables('gene_expression');
      const genesToTest = geneList
        ? allGenes.filter(g => geneList.includes(g.key))
        : allGenes;

      if (genesToTest.length === 0) {
        throw new Error('No genes available for analysis');
      }

      this._notifications.updateProgress(notificationId, 5, {
        message: `Analyzing ${genesToTest.length} genes...`
      });

      // Fetch bulk gene expression data
      const geneData = await this.dataLayer.fetchBulkGeneExpression({
        pageIds: [pageA, pageB],
        geneList: genesToTest.map(g => g.key),
        onProgress: (p) => {
          const adjustedProgress = 5 + (p * 0.5); // 5-55%
          this._notifications.updateProgress(notificationId, adjustedProgress, {
            message: `Loading gene data (${Math.round(p)}%)...`
          });
          if (onProgress) onProgress(adjustedProgress);
        }
      });

      // Compute differential expression for each gene
      const results = [];
      const computeManager = await this._getComputeManager();
      const batchSize = 20;

      for (let i = 0; i < genesToTest.length; i += batchSize) {
        const batch = genesToTest.slice(i, i + batchSize);
        const batchProgress = 55 + ((i / genesToTest.length) * 40); // 55-95%

        this._notifications.updateProgress(notificationId, batchProgress, {
          message: `Computing statistics (${i + 1}/${genesToTest.length})...`
        });

        if (onProgress) onProgress(batchProgress);

        // Process batch in parallel
        const batchResults = await Promise.all(batch.map(async (geneInfo) => {
          const gene = geneInfo.key;
          const genePageData = geneData[gene];

          if (!genePageData) {
            return {
              gene,
              error: 'No data available',
              meanA: NaN,
              meanB: NaN,
              log2FoldChange: NaN,
              pValue: NaN
            };
          }

          const dataA = genePageData[pageA];
          const dataB = genePageData[pageB];

          if (!dataA || !dataB) {
            return {
              gene,
              error: 'Missing page data',
              meanA: NaN,
              meanB: NaN,
              log2FoldChange: NaN,
              pValue: NaN
            };
          }

          // Filter to valid values
          const valsA = dataA.values.filter(v => typeof v === 'number' && Number.isFinite(v));
          const valsB = dataB.values.filter(v => typeof v === 'number' && Number.isFinite(v));

          if (valsA.length < minCells || valsB.length < minCells) {
            return {
              gene,
              error: `Insufficient cells (A: ${valsA.length}, B: ${valsB.length})`,
              meanA: valsA.length > 0 ? mean(valsA) : NaN,
              meanB: valsB.length > 0 ? mean(valsB) : NaN,
              log2FoldChange: NaN,
              pValue: NaN,
              nA: valsA.length,
              nB: valsB.length
            };
          }

          // Compute differential expression using worker
          const deResult = await computeManager.computeDifferential(valsA, valsB, method);

          return {
            gene,
            ...deResult
          };
        }));

        results.push(...batchResults);

        // Yield to event loop
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      // Apply multiple testing correction (Benjamini-Hochberg)
      const correctedResults = this._benjaminiHochberg(results);

      // Sort by p-value
      correctedResults.sort((a, b) => {
        const pA = Number.isFinite(a.pValue) ? a.pValue : 1;
        const pB = Number.isFinite(b.pValue) ? b.pValue : 1;
        return pA - pB;
      });

      // Calculate summary statistics
      const significantCount = correctedResults.filter(r =>
        r.adjustedPValue !== null && r.adjustedPValue < 0.05
      ).length;

      const upregulated = correctedResults.filter(r =>
        r.adjustedPValue !== null && r.adjustedPValue < 0.05 && r.log2FoldChange > 0
      ).length;

      const downregulated = correctedResults.filter(r =>
        r.adjustedPValue !== null && r.adjustedPValue < 0.05 && r.log2FoldChange < 0
      ).length;

      const duration = performance.now() - startTime;

      this._notifications.complete(notificationId,
        `DE analysis: ${significantCount} significant (${(duration / 1000).toFixed(1)}s)`
      );

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
          duration
        },
        metadata: {
          pageAName: geneData[genesToTest[0]?.key]?.[pageA]?.pageName || pageA,
          pageBName: geneData[genesToTest[0]?.key]?.[pageB]?.pageName || pageB
        }
      };

    } catch (error) {
      this._notifications.fail(notificationId, `DE analysis failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Benjamini-Hochberg procedure for FDR correction
   */
  _benjaminiHochberg(results) {
    // Get valid p-values with indices
    const validResults = results
      .map((r, idx) => ({ ...r, originalIndex: idx }))
      .filter(r => Number.isFinite(r.pValue));

    if (validResults.length === 0) {
      return results.map(r => ({ ...r, adjustedPValue: null }));
    }

    // Sort by p-value
    validResults.sort((a, b) => a.pValue - b.pValue);

    // Calculate adjusted p-values
    const m = validResults.length;
    const adjustedPValues = new Array(m);

    // BH procedure
    adjustedPValues[m - 1] = validResults[m - 1].pValue;
    for (let i = m - 2; i >= 0; i--) {
      const rawP = validResults[i].pValue * m / (i + 1);
      adjustedPValues[i] = Math.min(rawP, adjustedPValues[i + 1]);
    }

    // Ensure adjusted p-values don't exceed 1
    for (let i = 0; i < m; i++) {
      adjustedPValues[i] = Math.min(adjustedPValues[i], 1);
    }

    // Map back to original results
    const resultsCopy = results.map(r => ({ ...r, adjustedPValue: null }));
    for (let i = 0; i < m; i++) {
      resultsCopy[validResults[i].originalIndex].adjustedPValue = adjustedPValues[i];
    }

    return resultsCopy;
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
    const { genes, pageIds, method = 'mean', weights = null } = options;

    if (!genes || genes.length === 0) {
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
        const scores = new Array(cellCount).fill(0);
        const validCounts = new Array(cellCount).fill(0);

        // Aggregate gene values
        for (const gene of genes) {
          const genePageData = geneData[gene]?.[pageId];
          if (!genePageData) continue;

          const weight = weights?.[gene] ?? 1;

          for (let i = 0; i < genePageData.values.length; i++) {
            const val = genePageData.values[i];
            if (typeof val === 'number' && Number.isFinite(val)) {
              if (method === 'weighted') {
                scores[i] += val * weight;
              } else {
                scores[i] += val;
              }
              validCounts[i]++;
            }
          }
        }

        // Compute final scores based on method
        const finalScores = [];
        for (let i = 0; i < cellCount; i++) {
          if (validCounts[i] === 0) {
            finalScores.push(NaN);
          } else if (method === 'mean') {
            finalScores.push(scores[i] / validCounts[i]);
          } else {
            finalScores.push(scores[i]);
          }
        }

        // Compute statistics
        const validScores = finalScores.filter(s => Number.isFinite(s));
        const stats = this._computeBasicStats(validScores);

        results.push({
          pageId,
          pageName: firstGeneData.pageName,
          scores: finalScores,
          cellIndices: firstGeneData.cellIndices,
          statistics: stats,
          genesUsed: genes.length,
          method
        });
      }

      this._notifications.complete(notificationId, 'Signature score computed');

      return results;

    } catch (error) {
      this._notifications.fail(notificationId, `Signature scoring failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Basic statistics helper
   */
  _computeBasicStats(values) {
    if (values.length === 0) {
      return { count: 0, mean: NaN, median: NaN, min: NaN, max: NaN, std: NaN };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    const sum = values.reduce((a, b) => a + b, 0);
    const meanVal = sum / n;
    const variance = values.reduce((a, b) => a + Math.pow(b - meanVal, 2), 0) / n;

    const mid = Math.floor(n / 2);
    const median = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

    return {
      count: n,
      mean: meanVal,
      median,
      min: sorted[0],
      max: sorted[n - 1],
      std: Math.sqrt(variance)
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
    const { genes, pageIds, method = 'pearson' } = options;

    if (!genes || genes.length < 2) {
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

      return {
        genes,
        correlationMatrix,
        pValueMatrix,
        method,
        cellCount: cellIndexList.length
      };

    } catch (error) {
      this._notifications.fail(notificationId, `Co-expression failed: ${error.message}`);
      throw error;
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

          const valsA = dataA.values.filter(v => typeof v === 'number' && Number.isFinite(v));
          const valsB = dataB.values.filter(v => typeof v === 'number' && Number.isFinite(v));

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
 * Helper: compute mean
 */
function mean(arr) {
  if (!arr || arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Create a multi-variable analysis instance
 */
export function createMultiVariableAnalysis(dataLayer) {
  return new MultiVariableAnalysis(dataLayer);
}

export default MultiVariableAnalysis;
