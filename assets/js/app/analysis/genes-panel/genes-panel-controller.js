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
import { computeCategoryGroupingDigest } from '../data/data-layer.js';
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

    /** @type {Promise<void>|null} Exact shared initialization owner */
    this._initPromise = null;

    /** @type {AbortController|null} Current operation abort controller */
    this._currentAbortController = null;

    /** @type {Set<Promise<unknown>>} Public operations that still own cache state */
    this._activeOperations = new Set();

    /** @type {boolean} */
    this._closed = false;

    /** @type {boolean} */
    this._cacheClosed = false;

    /** @type {Promise<void>|null} */
    this._closePromise = null;
  }

  /**
   * Initialize the controller and all engines
   * @returns {Promise<void>}
   */
  init() {
    this._assertOpen();
    if (this._initialized) return Promise.resolve();
    if (this._initPromise !== null) return this._initPromise;

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
    const ownedCache = this._cache;

    const initTask = (async () => {
      try {
        await ownedCache.init();
        this._assertOpen();
        this._initialized = true;
      } catch (error) {
        if (!this._closed && this._cache === ownedCache) {
          let closeError;
          try {
            ownedCache.close();
          } catch (candidate) {
            closeError = candidate;
          }
          this._discoveryEngine = null;
          this._matrixBuilder = null;
          this._clusteringEngine = null;
          this._cache = null;
          this._initPromise = null;
          if (closeError !== undefined) {
            throw new AggregateError(
              [error, closeError],
              'Genes Panel initialization and cache cleanup both failed'
            );
          }
        }
        throw error;
      }
    })();
    this._initPromise = initTask;
    return initTask;
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
  runAnalysis(options) {
    return this._trackPublicOperation(() => {
      // Supersession ownership must be installed before the first await so an
      // immediate abort/close can cancel the operation in the same turn.
      this.abort();
      const abortController = new AbortController();
      this._currentAbortController = abortController;
      return this._runAnalysis(options, abortController);
    });
  }

  async _runAnalysis(options, abortController) {
    const signal = abortController.signal;
    const throwIfAborted = () => {
      if (signal.aborted) {
        throw signal.reason ??
          new DOMException('Request aborted', 'AbortError');
      }
      this._assertOpen();
    };

    try {
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('[GenesPanelController] analysis options must be an object');
      }
      const {
        obsCategory,
        mode = 'clustered',
        customGenes: requestedCustomGenes = null,
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
        batchConfig: requestedBatchConfig = {},
        onProgress,
        onPartialResults
      } = options;
      for (const [name, callback] of [
        ['onProgress', onProgress],
        ['onPartialResults', onPartialResults]
      ]) {
        if (callback !== undefined && typeof callback !== 'function') {
          throw new TypeError(
            `[GenesPanelController] ${name} must be a function when provided`
          );
        }
      }
      if (
        requestedBatchConfig === null ||
        typeof requestedBatchConfig !== 'object' ||
        Array.isArray(requestedBatchConfig)
      ) {
        throw new TypeError(
          '[GenesPanelController] batchConfig must be an object'
        );
      }
      const customGenes = Array.isArray(requestedCustomGenes)
        ? [...requestedCustomGenes]
        : requestedCustomGenes;
      const batchConfig = structuredClone(requestedBatchConfig);

      await this.init();
      throwIfAborted();
      this._syncCacheDatasetId();

      const reportProgress = onProgress === undefined
        ? undefined
        : update => {
          if (!signal.aborted) onProgress(update);
        };
      const reportPartialResults = onPartialResults === undefined
        ? undefined
        : update => {
          if (!signal.aborted) onPartialResults(update);
        };

      const startTime = performance.now();

      // Report init phase
      if (reportProgress) {
        reportProgress({
          phase: ANALYSIS_PHASES.INIT,
          progress: 0,
          message: 'Initializing analysis...'
        });
      }

      // Get groups from observation category
      if (reportProgress) {
        reportProgress({
          phase: ANALYSIS_PHASES.INIT,
          progress: 5,
          message: `Loading groups for "${obsCategory}"...`
        });
      }
      const { groups, obsCodes } = await this._getGroupsFromCategory(
        obsCategory,
        { onProgress: reportProgress, signal }
      );
      throwIfAborted();

      // Handle custom mode
      if (mode === 'custom' && customGenes) {
        const customResult = await this._runCustomAnalysis({
          groups,
          genes: customGenes,
          transform,
          distance,
          linkage,
          clusterRows,
          clusterCols,
          batchConfig,
          onProgress: reportProgress,
          signal
        });
        throwIfAborted();
        return customResult;
      }

      // Check cache for markers.
      //
      // `groupingDigest` is the cache's identity for *which cells were compared*.
      // The observation-field key alone is not: an in-place category merge or a
      // move to "unassigned" rewrites a field's codes while its key is unchanged,
      // and without the digest the panel would answer the new grouping with the
      // markers computed for the old one.
      const cacheParams = {
        method,
        topNPerGroup,
        pValueThreshold,
        foldChangeThreshold,
        useAdjustedPValue,
        minCells: this._config.minCells,
        groupingDigest: computeCategoryGroupingDigest(obsCodes)
      };
      let markers = null;
      let cacheHit = false;

      if (useCache) {
        markers = await this._cache.get(obsCategory, cacheParams);
        if (markers) {
          cacheHit = true;
          if (reportProgress) {
            reportProgress({
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
          onProgress: reportProgress,
          onPartialResults: reportPartialResults,
          signal
        });
        throwIfAborted();

        // Cache results
        if (useCache) {
          await this._cache.set(obsCategory, markers, cacheParams);
          throwIfAborted();
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
        genes: genesForMatrix,
        groups,
        transform,
        batchConfig,
        onProgress: reportProgress,
        signal
      });
      throwIfAborted();

      // Cluster if requested
      let clustering = null;
      let orderedMatrix = matrix;

      if (mode === 'clustered' && (clusterRows || clusterCols)) {
        clustering = await this._clusteringEngine.clusterMatrix({
          matrix,
          clusterRows,
          clusterCols,
          distance,
          linkage,
          onProgress: reportProgress,
          signal
        });
        throwIfAborted();
        orderedMatrix = this._clusteringEngine.applyOrdering(matrix, clustering);
      }

      // Report render phase
      if (reportProgress) {
        reportProgress({
          phase: ANALYSIS_PHASES.RENDER,
          progress: 100,
          message: 'Analysis complete'
        });
      }
      throwIfAborted();

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
          matrixGeneCount: genesForMatrix.length,
          groupCount: groups.length,
          duration,
          cached: useCache && cacheHit
        }
      };

    } catch (error) {
      if (error.name === 'AbortError' || signal.aborted) {
        throw error;
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
  getGroupsAndCodes(obsCategory, options = {}) {
    return this._trackPublicOperation(() => {
      const ownedOptions =
        options !== null &&
        typeof options === 'object' &&
        !Array.isArray(options)
          ? {
              onProgress: options.onProgress,
              signal: options.signal
            }
          : options;
      return (async () => {
        await this.init();
        return this._getGroupsFromCategory(obsCategory, ownedOptions);
      })();
    });
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
  buildMatrixForGenes(options) {
    return this._trackPublicOperation(() => {
      let ownedOptions = options;
      if (
        options !== null &&
        typeof options === 'object' &&
        !Array.isArray(options)
      ) {
        const ownedGroups = Array.isArray(options.groups)
          ? options.groups.map(group => (
              group !== null &&
              typeof group === 'object' &&
              !Array.isArray(group)
                ? { ...group }
                : group
            ))
          : options.groups;
        const ownedBatchConfig =
          options.batchConfig !== null &&
          typeof options.batchConfig === 'object' &&
          !Array.isArray(options.batchConfig)
            ? { ...options.batchConfig }
            : options.batchConfig;
        ownedOptions = {
          genes: Array.isArray(options.genes)
            ? [...options.genes]
            : options.genes,
          groups: ownedGroups,
          transform: options.transform,
          batchConfig: ownedBatchConfig,
          onProgress: options.onProgress,
          signal: options.signal
        };
      }

      return (async () => {
        await this.init();
        if (!this._matrixBuilder) {
          throw new Error('[GenesPanelController] Matrix builder not initialized');
        }
        return this._matrixBuilder.buildMatrix(ownedOptions);
      })();
    });
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
  recluster(result, options) {
    return this._trackPublicOperation(() => {
      const {
        distance = result.metadata?.distance || this._config.distance,
        linkage = result.metadata?.linkage || this._config.linkage,
        clusterRows = result.metadata?.clusterRows ?? this._config.clusterRows,
        clusterCols = result.metadata?.clusterCols ?? this._config.clusterCols
      } = options;

      // Get original (unordered) matrix
      const requestedMatrix = result.matrix;
      const matrix =
        requestedMatrix !== null &&
        typeof requestedMatrix === 'object' &&
        !Array.isArray(requestedMatrix)
          ? {
              ...requestedMatrix,
              genes: Array.isArray(requestedMatrix.genes)
                ? [...requestedMatrix.genes]
                : requestedMatrix.genes,
              groupIds: Array.isArray(requestedMatrix.groupIds)
                ? [...requestedMatrix.groupIds]
                : requestedMatrix.groupIds,
              groupNames: Array.isArray(requestedMatrix.groupNames)
                ? [...requestedMatrix.groupNames]
                : requestedMatrix.groupNames,
              groupColors: Array.isArray(requestedMatrix.groupColors)
                ? [...requestedMatrix.groupColors]
                : requestedMatrix.groupColors
            }
          : requestedMatrix;
      const metadata =
        result.metadata !== null &&
        typeof result.metadata === 'object' &&
        !Array.isArray(result.metadata)
          ? { ...result.metadata }
          : result.metadata;
      const ownedResult = {
        ...result,
        matrix,
        metadata
      };

      return (async () => {
        await this.init();

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
          ...ownedResult,
          matrix: orderedMatrix,
          clustering,
          metadata: {
            ...metadata,
            distance,
            linkage
          }
        };
      })();
    });
  }

  /**
   * Re-transform an existing result with different transformation
   *
   * @param {GenesPanelResult} result - Previous result
   * @param {'none'|'zscore'|'log1p'} transform - New transform
   * @returns {GenesPanelResult} Updated result
   */
  retransform(result, transform) {
    this._assertOpen();
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
    this._assertOpen();
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
  clearCache() {
    return this._trackPublicOperation(async () => {
      await this.init();
      await this._cache.clear();
    });
  }

  /**
   * Close and cleanup
   */
  close() {
    if (this._closePromise !== null) return this._closePromise;

    this._closed = true;
    this.abort();
    const pending = [...this._activeOperations];
    if (
      !this._initialized &&
      this._initPromise !== null &&
      !pending.includes(this._initPromise)
    ) {
      pending.push(this._initPromise);
    }

    if (pending.length === 0) {
      if (!this._cacheClosed && this._cache !== null) {
        this._cache.close();
        this._cacheClosed = true;
      }
      this._closePromise = Promise.resolve();
      return this._closePromise;
    }

    this._closePromise = Promise.allSettled(pending).then(() => {
      if (this._cacheClosed || this._cache === null) return;
      this._cache.close();
      this._cacheClosed = true;
    });
    return this._closePromise;
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  _assertOpen() {
    if (this._closed) {
      throw new Error('[GenesPanelController] controller is closed');
    }
  }

  _trackPublicOperation(operation) {
    this._assertOpen();
    if (typeof operation !== 'function') {
      throw new TypeError('Tracked Genes Panel operation must be a function');
    }

    let task;
    try {
      task = Promise.resolve(operation());
    } catch (error) {
      task = Promise.reject(error);
    }
    this._activeOperations.add(task);
    const release = () => {
      this._activeOperations.delete(task);
    };
    task.then(release, release);
    return task;
  }

  /**
   * Get dataset identifier for cache keys
   * @private
   */
  _getDatasetId() {
    const manager = getDataSourceManager();
    if (!manager || typeof manager.getCurrentDatasetId !== 'function') {
      throw new TypeError('The active dataset owner getCurrentDatasetId is required');
    }
    const datasetId = manager.getCurrentDatasetId();
    if (
      typeof datasetId !== 'string' ||
      datasetId.length === 0 ||
      datasetId.trim().length === 0
    ) {
      throw new TypeError('An exact active datasetId is required for marker analysis');
    }
    return datasetId;
  }

  _syncCacheDatasetId() {
    if (!this._cache || typeof this._cache.setDatasetId !== 'function') {
      throw new TypeError('Marker cache setDatasetId is required');
    }
    const id = this._getDatasetId();
    this._cache.setDatasetId(id);
  }

  _extractTopNGenes(markers, topNPerGroup) {
    if (!markers || !markers.groups || typeof markers.groups !== 'object') {
      throw new TypeError('Marker groups are required');
    }
    if (!Number.isSafeInteger(topNPerGroup) || topNPerGroup < 1) {
      throw new RangeError('topNPerGroup must be a positive integer');
    }
    const groups = markers.groups;
    const wanted = new Set();

    for (const group of Object.values(groups)) {
      if (!group || !Array.isArray(group.markers)) {
        throw new TypeError('Every marker group must own a markers array');
      }
      const list = group.markers;
      const limit = Math.min(list.length, topNPerGroup);
      for (let i = 0; i < limit; i++) {
        const gene = list[i]?.gene;
        if (typeof gene !== 'string' || gene.length === 0) {
          throw new TypeError('Every selected marker must own a non-empty gene name');
        }
        wanted.add(gene);
      }
    }

    const genes = Array.from(wanted);
    if (genes.length === 0) {
      throw new Error('Marker groups did not provide any genes for the expression matrix');
    }
    return genes;
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
    if (
      typeof obsCategory !== 'string' ||
      obsCategory.length === 0 ||
      obsCategory !== obsCategory.trim()
    ) {
      throw new TypeError('obsCategory must be a non-empty string');
    }
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options)
    ) {
      throw new TypeError('Group-loading options must be an object');
    }
    const { onProgress, signal } = options;
    if (onProgress !== undefined && typeof onProgress !== 'function') {
      throw new TypeError('Group-loading onProgress must be a function');
    }
    if (
      signal !== undefined &&
      (
        signal === null ||
        typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function'
      )
    ) {
      throw new TypeError('Group-loading signal must implement AbortSignal');
    }
    if (signal?.aborted) {
      throw signal.reason;
    }

    // If the field is not yet loaded, allow DataLayer/state to show a notification.
    // This prevents "stuck at initialization" perception on first load for large datasets.
    let silent = true;
    const obsFields = this.dataLayer?.state?.obsData?.fields;
    if (Array.isArray(obsFields)) {
      const field = obsFields.find(f => f?.key === obsCategory);
      if (field !== undefined) {
        if (typeof field.loaded !== 'boolean') {
          throw new TypeError(
            `Observation field "${obsCategory}" loaded state must be boolean`
          );
        }
        silent = field.loaded;
      }
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
      throw signal.reason;
    }

    if (
      fieldData === null ||
      typeof fieldData !== 'object' ||
      fieldData.kind !== 'category'
    ) {
      throw new Error(formatError(ERROR_MESSAGES.NO_CATEGORICAL_OBS));
    }

    const { codes, categories, colors = {} } = fieldData;

    if (!(codes instanceof Uint16Array) || codes.length === 0) {
      throw new Error(formatError(ERROR_MESSAGES.NO_CATEGORICAL_OBS));
    }

    if (!Array.isArray(categories)) {
      throw new TypeError(
        `Observation field "${obsCategory}" categories must be an array`
      );
    }
    const catCount = categories.length;
    if (catCount <= 0) {
      throw new Error(formatError(ERROR_MESSAGES.NO_CATEGORICAL_OBS));
    }
    const categorySet = new Set();
    for (let code = 0; code < categories.length; code++) {
      const category = categories[code];
      if (
        (
          typeof category !== 'string' &&
          typeof category !== 'number' &&
          typeof category !== 'boolean'
        ) ||
        (typeof category === 'number' && !Number.isFinite(category))
      ) {
        throw new TypeError(
          `Observation category ${code} must be an exact primitive label`
        );
      }
      if (categorySet.has(category)) {
        throw new Error(
          `Observation category label at code ${code} is duplicated`
        );
      }
      categorySet.add(category);
    }
    if (
      colors === null ||
      typeof colors !== 'object' ||
      Array.isArray(colors)
    ) {
      throw new TypeError(
        `Observation field "${obsCategory}" colors must be an object`
      );
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
      if (code >= catCount) {
        throw new RangeError(
          `Observation code ${code} at cell ${i} exceeds the category inventory`
        );
      }
      countsByCode[code]++;
    }

    /** @type {{ code: number, name: string|number|boolean, count: number }[]} */
    const present = [];
    for (let code = 0; code < catCount; code++) {
      const count = countsByCode[code];
      if (count > 0) {
        present.push({ code, name: categories[code], count });
      }
    }

    if (present.length < 2) {
      throw new Error(formatError(ERROR_MESSAGES.TOO_FEW_GROUPS, { n: present.length }));
    }

    // Sort groups by size (descending) for a stable and intuitive UI.
    present.sort((a, b) => b.count - a.count || a.code - b.code);

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
      if (code >= catCount) {
        throw new RangeError(
          `Observation code ${code} at cell ${i} exceeds the category inventory`
        );
      }
      const gi = codeToGroupIdx[code];
      if (gi < 0) {
        throw new Error(
          `Observation code ${code} has no present marker group`
        );
      }
      const w = writePtr[gi]++;
      indicesByGroup[gi][w] = i;
    }

    // Build groups array
    const groups = present.map((p, idx) => {
      const declaredColor =
        typeof p.name === 'string' && Object.hasOwn(colors, p.name)
          ? colors[p.name]
          : undefined;
      if (
        declaredColor !== undefined &&
        (typeof declaredColor !== 'string' || declaredColor.length === 0)
      ) {
        throw new TypeError(
          `Category "${p.name}" color must be a non-empty string`
        );
      }
      return {
        groupId: `category-code:${p.code}`,
        groupName: p.name,
        groupCode: p.code,
        cellIndices: indicesByGroup[idx],
        cellCount: p.count,
        color: declaredColor === undefined
          ? this._generateColor(idx)
          : declaredColor
      };
    });

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
      batchConfig,
      onProgress,
      signal
    } = options;
    const throwIfAborted = () => {
      if (signal?.aborted) {
        throw signal.reason ??
          new DOMException('Request aborted', 'AbortError');
      }
      this._assertOpen();
    };
    throwIfAborted();

    if (
      !Array.isArray(genes) ||
      genes.length === 0 ||
      genes.some(
        gene =>
          typeof gene !== 'string' ||
          gene.length === 0 ||
          gene !== gene.trim()
      ) ||
      new Set(genes).size !== genes.length
    ) {
      throw new TypeError(
        'Custom marker genes must be unique non-empty strings'
      );
    }
    const availableVariables =
      this.dataLayer.getAvailableVariables('gene_expression');
    if (!Array.isArray(availableVariables) || availableVariables.length === 0) {
      throw new Error(formatError(ERROR_MESSAGES.NO_GENES_AVAILABLE));
    }
    const availableGenes = new Set();
    for (const [index, variable] of availableVariables.entries()) {
      if (
        variable === null ||
        typeof variable !== 'object' ||
        typeof variable.key !== 'string' ||
        variable.key.length === 0
      ) {
        throw new TypeError(
          `Available gene entry ${index} must own a non-empty key`
        );
      }
      if (availableGenes.has(variable.key)) {
        throw new Error(
          `Available gene inventory contains duplicate key "${variable.key}"`
        );
      }
      availableGenes.add(variable.key);
    }
    for (const gene of genes) {
      if (!availableGenes.has(gene)) {
        throw new Error(
          formatError(ERROR_MESSAGES.GENE_NOT_FOUND, { symbol: gene })
        );
      }
    }

    // Build expression matrix
    const matrix = await this._matrixBuilder.buildMatrix({
      genes: [...genes],
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
      throwIfAborted();

      orderedMatrix = this._clusteringEngine.applyOrdering(matrix, clustering);
    }
    throwIfAborted();

    return {
      markers: null, // No marker discovery for custom genes
      matrix: orderedMatrix,
      clustering,
      metadata: {
        mode: 'custom',
        transform,
        distance,
        linkage,
        geneCount: genes.length,
        groupCount: groups.length
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
