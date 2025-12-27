/**
 * Genes Panel Controller
 *
 * Main orchestrator for the Marker Genes Panel feature.
 * Coordinates marker discovery, matrix building, clustering, and caching.
 *
 * Features:
 * - Unified API for complete marker gene analysis workflow
 * - Automatic cache management
 * - Progressive results streaming
 * - Configuration management
 * - Memory-aware operation
 *
 * Usage Patterns:
 * 1. Full analysis: discoverAndBuildMatrix()
 * 2. Cached results: getCachedOrCompute()
 * 3. Custom genes: buildCustomMatrix()
 * 4. Re-clustering: recluster()
 *
 * @module genes-panel/genes-panel-controller
 */

import { MarkerDiscoveryEngine } from './marker-discovery-engine.js';
import { ExpressionMatrixBuilder } from './expression-matrix-builder.js';
import { ClusteringEngine } from './clustering-engine.js';
import { MarkerCache } from './marker-cache.js';
import { DEFAULTS, ANALYSIS_PHASES, ERROR_MESSAGES, formatError } from './constants.js';
import { getDataSourceManager } from '../../../data/data-source-manager.js';

// =============================================================================
// GENES PANEL CONTROLLER
// =============================================================================

/**
 * Genes Panel Controller
 *
 * High-level orchestrator for marker genes analysis.
 *
 * @example
 * const controller = new GenesPanelController({ dataLayer });
 * await controller.init();
 *
 * const result = await controller.runAnalysis({
 *   obsCategory: 'cell_type',
 *   mode: 'clustered',
 *   topNPerGroup: 10,
 *   onProgress: updateUI
 * });
 */
export class GenesPanelController {
  /**
   * Create a GenesPanelController
   *
   * @param {Object} options
   * @param {Object} options.dataLayer - DataLayer instance
   * @param {Object} [options.config] - Configuration overrides
   */
  constructor(options) {
    const { dataLayer, config = {} } = options;

    if (!dataLayer) {
      throw new Error('[GenesPanelController] dataLayer is required');
    }

    /** @type {Object} DataLayer instance */
    this.dataLayer = dataLayer;

    /** @type {Object} Configuration */
    this._config = { ...DEFAULTS, ...config };

    /** @type {MarkerDiscoveryEngine|null} */
    this._discoveryEngine = null;

    /** @type {ExpressionMatrixBuilder|null} */
    this._matrixBuilder = null;

    /** @type {ClusteringEngine|null} */
    this._clusteringEngine = null;

    /** @type {MarkerCache|null} */
    this._cache = null;

    /** @type {boolean} */
    this._initialized = false;

    /** @type {AbortController|null} Current operation abort controller */
    this._currentAbortController = null;
  }

  /**
   * Initialize the controller and all engines
   * @returns {Promise<void>}
   */
  async init() {
    if (this._initialized) return;

    // Initialize engines
    this._discoveryEngine = new MarkerDiscoveryEngine({
      dataLayer: this.dataLayer,
      config: this._config
    });

    this._matrixBuilder = new ExpressionMatrixBuilder({
      dataLayer: this.dataLayer,
      config: this._config
    });

    this._clusteringEngine = new ClusteringEngine({
      config: this._config
    });

    // Initialize cache
    this._cache = new MarkerCache({
      maxCategories: this._config.cacheMaxCategories,
      maxAgeDays: this._config.cacheMaxAgeDays,
      cacheVersion: this._config.cacheVersion,
      datasetId: this._getDatasetId()
    });
    await this._cache.init();
    this._initialized = true;
  }

  /**
   * Run full marker genes analysis
   *
   * @param {Object} options
   * @param {string} options.obsCategory - Observation category to analyze (e.g., 'cell_type')
   * @param {'ranked'|'clustered'|'custom'} [options.mode='clustered'] - Display mode
   * @param {string[]} [options.customGenes] - For custom mode: genes to display
   * @param {number} [options.topNPerGroup] - Top markers per group
   * @param {'wilcox'|'ttest'} [options.method] - Statistical method
   * @param {'none'|'zscore'|'log1p'} [options.transform] - Heatmap transform
   * @param {'correlation'|'euclidean'|'cosine'} [options.distance] - Clustering distance
   * @param {'average'|'complete'|'single'} [options.linkage] - Clustering linkage
   * @param {boolean} [options.clusterRows] - Whether to cluster genes
   * @param {boolean} [options.clusterCols] - Whether to cluster groups
   * @param {number} [options.pValueThreshold] - P-value cutoff
   * @param {number} [options.foldChangeThreshold] - Fold change cutoff
   * @param {boolean} [options.useAdjustedPValue] - Use FDR-corrected p-values
   * @param {boolean} [options.useCache=true] - Whether to use cached results
   * @param {Function} [options.onProgress] - Progress callback
   * @param {Function} [options.onPartialResults] - Partial results callback
   * @returns {Promise<GenesPanelResult>} Complete analysis result
   */
  async runAnalysis(options) {
    await this.init();
    this._syncCacheDatasetId();

    const {
      obsCategory,
      mode = 'clustered',
      customGenes = null,
      topNPerGroup = this._config.topNPerGroup,
      method = this._config.method,
      transform = this._config.transform,
      distance = this._config.distance,
      linkage = this._config.linkage,
      clusterRows = this._config.clusterRows,
      clusterCols = this._config.clusterCols,
      pValueThreshold = this._config.pValueThreshold,
      foldChangeThreshold = this._config.foldChangeThreshold,
      useAdjustedPValue = this._config.useAdjustedPValue,
      useCache = true,
      parallelism = 'auto',
      batchConfig = {},
      onProgress,
      onPartialResults
    } = options;

    // Cancel any previous operation
    this.abort();
    const abortController = new AbortController();
    this._currentAbortController = abortController;
    const signal = abortController.signal;

    const startTime = performance.now();

    try {
      // Report init phase
      if (onProgress) {
        onProgress({
          phase: ANALYSIS_PHASES.INIT,
          progress: 0,
          message: 'Initializing analysis...'
        });
      }

      const throwIfAborted = () => {
        if (signal?.aborted) {
          throw new DOMException('Request aborted', 'AbortError');
        }
      };

      // Get groups from observation category
      if (onProgress) {
        onProgress({
          phase: ANALYSIS_PHASES.INIT,
          progress: 5,
          message: `Loading groups for "${obsCategory}"...`
        });
      }
      const { groups, obsCodes } = await this._getGroupsFromCategory(obsCategory, { onProgress, signal });
      throwIfAborted();

      // Handle custom mode
      if (mode === 'custom' && customGenes) {
        return await this._runCustomAnalysis({
          groups,
          genes: customGenes,
          transform,
          distance,
          linkage,
          clusterRows,
          clusterCols,
          onProgress,
          signal
        });
      }

      // Check cache for markers
      const cacheParams = { method, topNPerGroup, pValueThreshold, foldChangeThreshold };
      let markers = null;
      let cacheHit = false;

      if (useCache) {
        markers = await this._cache.get(obsCategory, cacheParams);
        if (markers) {
          cacheHit = true;
          if (onProgress) {
            onProgress({
              phase: ANALYSIS_PHASES.DISCOVERY,
              progress: 100,
              message: 'Using cached markers'
            });
          }
        }
      }
      throwIfAborted();

      // Discover markers if not cached
      if (!markers) {
        markers = await this._discoveryEngine.discoverMarkers({
          obsCategory,
          groups,
          obsCodes,
          method,
          topNPerGroup,
          pValueThreshold,
          foldChangeThreshold,
          useAdjustedPValue,
          parallelism,
          batchConfig,
          onProgress,
          onPartialResults,
          signal
        });
        throwIfAborted();

        // Cache results
        if (useCache) {
          await this._cache.set(obsCategory, markers, cacheParams);
        }
      }

      // Extract unique genes from all groups
      const allGenes = this._extractUniqueGenes(markers);

      if (allGenes.length === 0) {
        throw new Error(formatError(ERROR_MESSAGES.EMPTY_RESULTS, {
          pValue: pValueThreshold,
          fc: foldChangeThreshold
        }));
      }

      // Build expression matrix.
      // For interactive thresholding + browsing, we only need a small panel by default.
      // The figure modal can request larger sets (Top 10/20/100/All) and rebuild the matrix.
      const DEFAULT_HEATMAP_TOP_N = 5;
      const genesForMatrix = this._extractTopNGenes(markers, DEFAULT_HEATMAP_TOP_N);

      const matrix = await this._matrixBuilder.buildMatrix({
        genes: genesForMatrix.length > 0 ? genesForMatrix : allGenes,
        groups,
        transform,
        batchConfig,
        onProgress,
        signal
      });
      throwIfAborted();

      // Cluster if requested
      let clustering = null;
      let orderedMatrix = matrix;

      if (mode === 'clustered' && (clusterRows || clusterCols)) {
        try {
          clustering = await this._clusteringEngine.clusterMatrix({
            matrix,
            clusterRows,
            clusterCols,
            distance,
            linkage,
            onProgress,
            signal
          });
          throwIfAborted();

          // Apply ordering
          orderedMatrix = this._clusteringEngine.applyOrdering(matrix, clustering);
        } catch (err) {
          // If clustering fails (or is cancelled), keep the unclustered matrix
          // so the panel remains usable.
          if (signal?.aborted) throw err;
          console.warn('[GenesPanelController] Clustering failed, showing unclustered heatmap:', err?.message || err);
          clustering = null;
          orderedMatrix = matrix;
        }
      }

      // Report render phase
      if (onProgress) {
        onProgress({
          phase: ANALYSIS_PHASES.RENDER,
          progress: 100,
          message: 'Analysis complete'
        });
      }

      const duration = performance.now() - startTime;

      return {
        markers,
        matrix: orderedMatrix,
        clustering,
        metadata: {
          obsCategory,
          mode,
          method,
          transform,
          distance,
          linkage,
          topNPerGroup,
          pValueThreshold,
          foldChangeThreshold,
          useAdjustedPValue,
          parallelism,
          batchConfig,
          geneCount: allGenes.length,
          matrixGeneCount: genesForMatrix.length > 0 ? genesForMatrix.length : allGenes.length,
          groupCount: groups.length,
          duration,
          cached: !!(useCache && cacheHit)
        }
      };

    } catch (error) {
      if (error.name === 'AbortError' || signal.aborted) {
        throw new Error(ERROR_MESSAGES.CANCELLED);
      }
      throw error;
    } finally {
      // Ensure repeated runs don't keep stale controllers alive.
      if (this._currentAbortController === abortController) {
        this._currentAbortController = null;
      }
    }
  }

  /**
   * Public helper: get groups + obsCodes for a category (for post-run re-filtering).
   *
   * @param {string} obsCategory
   * @param {{ onProgress?: Function, signal?: AbortSignal }} [options]
   * @returns {Promise<{ groups: any[], obsCodes: Uint16Array }>}
   */
  async getGroupsAndCodes(obsCategory, options = {}) {
    await this.init();
    return this._getGroupsFromCategory(obsCategory, options);
  }

  /**
   * Public helper: build an expression matrix for a given gene list.
   * This lets the UI rebuild the heatmap after post-run threshold changes
   * without re-running marker discovery.
   *
   * @param {Object} options
   * @param {string[]} options.genes
   * @param {any[]} options.groups
   * @param {'none'|'zscore'|'log1p'} [options.transform]
   * @param {Object} [options.batchConfig]
   * @param {Function} [options.onProgress]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<any>}
   */
  async buildMatrixForGenes(options) {
    await this.init();
    if (!this._matrixBuilder) {
      throw new Error('[GenesPanelController] Matrix builder not initialized');
    }
    return this._matrixBuilder.buildMatrix(options);
  }

  /**
   * Recluster an existing result with different parameters
   *
   * @param {GenesPanelResult} result - Previous result
   * @param {Object} options
   * @param {'correlation'|'euclidean'|'cosine'} [options.distance]
   * @param {'average'|'complete'|'single'} [options.linkage]
   * @param {boolean} [options.clusterRows]
   * @param {boolean} [options.clusterCols]
   * @returns {Promise<GenesPanelResult>} Updated result
   */
  async recluster(result, options) {
    await this.init();

    const {
      distance = result.metadata?.distance || this._config.distance,
      linkage = result.metadata?.linkage || this._config.linkage,
      clusterRows = result.metadata?.clusterRows ?? this._config.clusterRows,
      clusterCols = result.metadata?.clusterCols ?? this._config.clusterCols
    } = options;

    // Get original (unordered) matrix
    const matrix = result.matrix;

    // Recluster
    const clustering = await this._clusteringEngine.clusterMatrix({
      matrix,
      clusterRows,
      clusterCols,
      distance,
      linkage
    });

    // Apply ordering
    const orderedMatrix = this._clusteringEngine.applyOrdering(matrix, clustering);

    return {
      ...result,
      matrix: orderedMatrix,
      clustering,
      metadata: {
        ...result.metadata,
        distance,
        linkage
      }
    };
  }

  /**
   * Re-transform an existing result with different transformation
   *
   * @param {GenesPanelResult} result - Previous result
   * @param {'none'|'zscore'|'log1p'} transform - New transform
   * @returns {GenesPanelResult} Updated result
   */
  retransform(result, transform) {
    const newMatrix = this._matrixBuilder.retransform(result.matrix, transform);

    return {
      ...result,
      matrix: newMatrix,
      metadata: {
        ...result.metadata,
        transform
      }
    };
  }

  /**
   * Get available observation categories for analysis
   * @returns {string[]}
   */
  getAvailableCategories() {
    return this.dataLayer.getAvailableVariables('categorical_obs').map(v => v.key);
  }

  /**
   * Abort current operation
   */
  abort() {
    if (this._currentAbortController) {
      this._currentAbortController.abort();
      this._currentAbortController = null;
    }
  }

  /**
   * Clear all caches
   * @returns {Promise<void>}
   */
  async clearCache() {
    if (this._cache) {
      await this._cache.clear();
    }
  }

  /**
   * Close and cleanup
   */
  close() {
    this.abort();
    if (this._cache) {
      this._cache.close();
    }
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Get dataset identifier for cache keys
   * @private
   */
  _getDatasetId() {
    const state = this.dataLayer?.state || null;
    const fromDataLayer = String(state?.datasetId || '').trim();
    if (fromDataLayer) return fromDataLayer;

    try {
      const manager = getDataSourceManager?.();
      const fromManager = String(manager?.getCurrentDatasetId?.() || '').trim();
      if (fromManager) return fromManager;
    } catch {
      // ignore
    }

    // Fallback: include point count to reduce collision risk when datasetId is missing.
    const count = state?.pointCount;
    const countPart = Number.isFinite(Number(count)) ? String(Math.max(0, Math.floor(Number(count)))) : '';
    return countPart ? `unknown_${countPart}` : 'unknown';
  }

  _syncCacheDatasetId() {
    const id = this._getDatasetId();
    try {
      this._cache?.setDatasetId?.(id);
    } catch {
      // ignore
    }
  }

  _extractTopNGenes(markers, topNPerGroup) {
    const groups = markers?.groups || {};
    const n = Number.isFinite(topNPerGroup) ? Math.max(1, Math.floor(topNPerGroup)) : 5;
    const wanted = new Set();

    for (const group of Object.values(groups)) {
      const list = group?.markers || [];
      const limit = Math.min(list.length, n);
      for (let i = 0; i < limit; i++) {
        if (list[i]?.gene) wanted.add(list[i].gene);
      }
    }

    return Array.from(wanted);
  }

  /**
   * Get group specifications from an observation category
   *
   * Uses dataLayer.ensureObsFieldLoaded() to get the categorical observation
   * field data (codes and categories), then builds group specifications.
   *
   * @private
   * @param {string} obsCategory - The observation category key (e.g., 'cell_type')
   * @returns {Promise<GroupSpec[]>} Array of group specifications
   */
  async _getGroupsFromCategory(obsCategory, options = {}) {
    const { onProgress, signal } = options || {};
    if (signal?.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }

    // If the field is not yet loaded, allow DataLayer/state to show a notification.
    // This prevents "stuck at initialization" perception on first load for large datasets.
    let silent = true;
    const obsFields = this.dataLayer?.state?.obsData?.fields;
    if (Array.isArray(obsFields)) {
      const field = obsFields.find(f => f?.key === obsCategory);
      silent = !!field?.loaded;
    }

    if (onProgress) {
      onProgress({
        phase: ANALYSIS_PHASES.INIT,
        progress: 10,
        message: silent ? 'Preparing groups...' : 'Loading observation field...'
      });
    }

    // Load the observation field data
    const fieldData = await this.dataLayer.ensureObsFieldLoaded(obsCategory, { silent });
    if (signal?.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }

    if (!fieldData || fieldData.kind !== 'category') {
      throw new Error(formatError(ERROR_MESSAGES.NO_CATEGORICAL_OBS));
    }

    const { codes, categories, colors = {} } = fieldData;

    if (!codes || codes.length === 0) {
      throw new Error(formatError(ERROR_MESSAGES.NO_CATEGORICAL_OBS));
    }

    const catCount = Array.isArray(categories) ? categories.length : 0;
    if (catCount <= 0) {
      throw new Error(formatError(ERROR_MESSAGES.NO_CATEGORICAL_OBS));
    }

    // Two-pass, typed-array group index construction:
    // 1) count cells per category code
    // 2) allocate fixed-size Uint32Array per group
    // 3) fill indices without per-cell push overhead
    const countsByCode = new Uint32Array(catCount);
    const missingCode = 65535;

    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === missingCode) continue;
      if (code < 0 || code >= catCount) continue;
      if (!categories[code]) continue;
      countsByCode[code]++;
    }

    /** @type {{ code: number, name: string, count: number }[]} */
    const present = [];
    for (let code = 0; code < catCount; code++) {
      const count = countsByCode[code];
      if (count > 0 && categories[code]) {
        present.push({ code, name: categories[code], count });
      }
    }

    if (present.length < 2) {
      throw new Error(formatError(ERROR_MESSAGES.TOO_FEW_GROUPS, { n: present.length }));
    }

    // Sort groups by size (descending) for a stable and intuitive UI.
    present.sort((a, b) => b.count - a.count);

    // Map code -> group index (in `present` order)
    const codeToGroupIdx = new Int32Array(catCount);
    codeToGroupIdx.fill(-1);
    for (let i = 0; i < present.length; i++) {
      codeToGroupIdx[present[i].code] = i;
    }

    /** @type {Uint32Array[]} */
    const indicesByGroup = present.map((p) => new Uint32Array(p.count));
    const writePtr = new Uint32Array(present.length);

    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === missingCode) continue;
      if (code < 0 || code >= catCount) continue;
      const gi = codeToGroupIdx[code];
      if (gi < 0) continue;
      const w = writePtr[gi]++;
      indicesByGroup[gi][w] = i;
    }

    // Build groups array
    const groups = present.map((p, idx) => ({
      groupId: p.name,
      groupName: p.name,
      groupCode: p.code,
      cellIndices: indicesByGroup[idx],
      cellCount: p.count,
      color: colors[p.name] || this._generateColor(idx)
    }));

    return { groups, obsCodes: codes, categories };
  }

  /**
   * Extract unique genes from marker results
   * @private
   */
  _extractUniqueGenes(markers) {
    const geneSet = new Set();

    for (const groupData of Object.values(markers.groups)) {
      for (const marker of groupData.markers) {
        geneSet.add(marker.gene);
      }
    }

    return Array.from(geneSet);
  }

  /**
   * Run analysis with custom gene list
   * @private
   */
  async _runCustomAnalysis(options) {
    const {
      groups,
      genes,
      transform,
      distance,
      linkage,
      clusterRows,
      clusterCols,
      onProgress,
      signal
    } = options;

    // Validate genes exist
    const availableGenes = new Set(this.dataLayer.getAvailableVariables('gene_expression').map(v => v.key));
    const validGenes = genes.filter(g => availableGenes.has(g));
    const invalidGenes = genes.filter(g => !availableGenes.has(g));

    if (invalidGenes.length > 0) {
      console.warn(`[GenesPanelController] Genes not found: ${invalidGenes.join(', ')}`);
    }

    if (validGenes.length === 0) {
      throw new Error(ERROR_MESSAGES.GENE_NOT_FOUND);
    }

    // Build expression matrix
    const matrix = await this._matrixBuilder.buildMatrix({
      genes: validGenes,
      groups,
      transform,
      onProgress,
      signal
    });

    // Cluster if requested
    let clustering = null;
    let orderedMatrix = matrix;

    if (clusterRows || clusterCols) {
      clustering = await this._clusteringEngine.clusterMatrix({
        matrix,
        clusterRows,
        clusterCols,
        distance,
        linkage,
        onProgress,
        signal
      });

      orderedMatrix = this._clusteringEngine.applyOrdering(matrix, clustering);
    }

    return {
      markers: null, // No marker discovery for custom genes
      matrix: orderedMatrix,
      clustering,
      metadata: {
        mode: 'custom',
        transform,
        distance,
        linkage,
        geneCount: validGenes.length,
        groupCount: groups.length,
        invalidGenes: invalidGenes.length > 0 ? invalidGenes : null
      }
    };
  }

  /**
   * Generate a color for a group
   * @private
   */
  _generateColor(index) {
    const palette = [
      '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
      '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'
    ];
    return palette[index % palette.length];
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a GenesPanelController instance
 *
 * @param {Object} options - Same options as GenesPanelController constructor
 * @returns {GenesPanelController}
 */
export function createGenesPanelController(options) {
  return new GenesPanelController(options);
}

export default GenesPanelController;
