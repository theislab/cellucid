/**
 * Data Abstraction Layer for Page Analysis
 *
 * Provides a unified interface for accessing any variable from pages:
 * - Categorical obs fields (cell type, cluster, patient ID, etc.)
 * - Continuous obs fields (pseudotime, QC metrics, age)
 * - Gene expression values
 *
 * Features (configurable via options):
 * - LRU caching for fetched data
 * - Request deduplication (prevents duplicate fetches)
 * - Prefetching for likely next selections
 * - Bulk gene expression fetching with progress
 * - Page version tracking for cache correctness
 * - Worker integration for heavy computations
 * - Notification center integration for user feedback
 *
 * @module data/data-layer
 */

import { LRUCache } from '../shared/lru-cache.js';
import { getComputeManager } from '../compute/compute-manager.js';
import { getNotificationCenter } from '../../notification-center.js';
import { getMemoryMonitor } from '../shared/memory-monitor.js';
import {
  loadAnalysisBulkData,
  loadLatentEmbeddings,
  loadAnalysisBulkObsData
} from '../../../data/data-loaders.js';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * @typedef {'categorical_obs' | 'continuous_obs' | 'gene_expression'} DataType
 */

/**
 * @typedef {Object} VariableInfo
 * @property {string} key - Variable identifier
 * @property {string} name - Display name
 * @property {'category' | 'continuous'} kind - Data kind
 * @property {string[]} [categories] - Category names for categorical variables
 * @property {number} [categoryCount] - Number of categories
 * @property {number} [min] - Minimum value for continuous variables
 * @property {number} [max] - Maximum value for continuous variables
 * @property {number} [mean] - Mean value for continuous variables
 * @property {boolean} loaded - Whether data is fully loaded
 * @property {number} [_fieldIndex] - Internal field index
 * @property {boolean} [_isGene] - Whether this is a gene expression variable
 */

/**
 * @typedef {Object} PageData
 * @property {string} pageId - Page identifier
 * @property {string} pageName - Human-readable page name
 * @property {VariableInfo} variableInfo - Information about the variable
 * @property {(string|number)[]} values - Decoded values for each cell
 * @property {number[]} cellIndices - Original cell indices in the dataset
 * @property {number} cellCount - Total number of cells in this page data
 */

/**
 * @typedef {Object} FetchOptions
 * @property {DataType} type - Type of data to fetch
 * @property {string} variableKey - Variable key/name to fetch
 * @property {string[]} pageIds - Array of page IDs to include
 */

/**
 * @typedef {Object} DataLayerOptions
 * @property {boolean} [enableCache=true] - Enable LRU caching
 * @property {number} [cacheSize=100] - Maximum cache size
 * @property {number} [cacheMaxAge=0] - Cache entry max age in ms (0 = no expiration)
 * @property {boolean} [enableDedup=true] - Enable request deduplication
 * @property {boolean} [enablePrefetch=false] - Enable prefetching
 * @property {boolean} [enableVersionTracking=true] - Track page versions for cache correctness
 * @property {boolean} [enableNotifications=true] - Show notifications for long operations
 * @property {number} [bulkCacheMaxAge=300000] - Bulk gene cache max age (5 minutes default)
 * @property {number} [bulkCacheMaxSize=5] - Maximum bulk cache entries
 */

/**
 * @typedef {Object} BasicStats
 * @property {number} count - Number of valid values
 * @property {number|null} min - Minimum value
 * @property {number|null} max - Maximum value
 * @property {number|null} mean - Mean value
 * @property {number|null} median - Median value
 * @property {number|null} std - Standard deviation
 * @property {number} [q1] - First quartile
 * @property {number} [q3] - Third quartile
 */

/**
 * @typedef {Object} CategoryAggregation
 * @property {string[]} categories - Category names sorted by count
 * @property {number[]} counts - Counts for each category
 * @property {number[]} [percentages] - Percentages if normalized
 * @property {number} total - Total count
 */

/**
 * @typedef {Object} CacheStats
 * @property {Object} dataCache - Data cache statistics
 * @property {Object} bulkGeneCache - Bulk gene cache statistics
 * @property {number} pendingRequests - Number of pending requests
 * @property {number} prefetchQueue - Size of prefetch queue
 */

// =============================================================================
// DATALAYER CLASS
// =============================================================================

/**
 * Unified Data Layer for Page Analysis
 *
 * Provides a complete interface for accessing cell data with optional
 * caching, deduplication, prefetching, and bulk loading capabilities.
 *
 * @example
 * // Basic usage
 * const dataLayer = new DataLayer(state);
 * const pageData = await dataLayer.getDataForPages({
 *   type: 'gene_expression',
 *   variableKey: 'BRCA1',
 *   pageIds: ['page1', 'page2']
 * });
 *
 * @example
 * // With custom options
 * const dataLayer = new DataLayer(state, {
 *   enableCache: true,
 *   cacheSize: 200,
 *   enablePrefetch: true
 * });
 */
export class DataLayer {
  /**
   * Create a new DataLayer instance
   *
   * @param {Object} state - Reference to DataState instance
   * @param {DataLayerOptions} [options={}] - Configuration options
   */
  constructor(state, options = {}) {
    const {
      enableCache = true,
      cacheSize = 100,
      cacheMaxAge = 0,
      enableDedup = true,
      enablePrefetch = false,
      enableVersionTracking = true,
      enableNotifications = true,
      bulkCacheMaxAge = 5 * 60 * 1000, // 5 minutes
      bulkCacheMaxSize = 5
    } = options;

    /** @type {Object} Reference to DataState */
    this.state = state;

    /** @type {DataLayerOptions} Configuration options */
    this._options = {
      enableCache,
      cacheSize,
      cacheMaxAge,
      enableDedup,
      enablePrefetch,
      enableVersionTracking,
      enableNotifications,
      bulkCacheMaxAge,
      bulkCacheMaxSize
    };

    // Simple variable cache (for variable info lookups)
    this._variableCache = new Map();

    // LRU cache for page data (if enabled)
    this._dataCache = enableCache
      ? new LRUCache({ maxSize: cacheSize, maxAge: cacheMaxAge })
      : null;

    // Pending requests for deduplication
    this._pendingRequests = enableDedup ? new Map() : null;

    // Prefetch queue
    this._prefetchQueue = [];
    this._prefetchTimeout = null;

    // Bulk gene data cache (separate due to size)
    this._bulkGeneCache = new Map();
    this._bulkGeneCacheMaxAge = bulkCacheMaxAge;
    this._bulkGeneCacheMaxSize = bulkCacheMaxSize;
    this._bulkGeneCacheAccessOrder = [];

    // Page version tracking for cache correctness
    this._pageVersions = enableVersionTracking ? new Map() : null;

    // Compute manager reference (lazy initialized)
    this._computeManager = null;

    // Notification center reference
    this._notifications = enableNotifications ? getNotificationCenter() : null;

    // Memory monitor integration for automatic cleanup under memory pressure
    this._instanceId = `data-layer-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    this._memoryMonitor = getMemoryMonitor();
    this._memoryMonitor.registerCleanupHandler(this._instanceId, () => {
      this._handleMemoryCleanup();
    });

    // Initialize page version tracking
    if (enableVersionTracking) {
      this._initPageVersionTracking();
    }
  }

  /**
   * Handle memory cleanup triggered by MemoryMonitor
   * Clears caches to free memory under pressure
   * @private
   */
  _handleMemoryCleanup() {
    const beforeMemory = this.estimateMemoryUsage();

    // Clear bulk gene cache first (largest memory consumer)
    this._bulkGeneCache.clear();
    this._bulkGeneCacheAccessOrder = [];

    // Prune data cache (remove oldest entries)
    if (this._dataCache) {
      // Clear half the cache to free memory while preserving recent data
      const targetSize = Math.floor(this._options.cacheSize / 2);
      while (this._dataCache.size() > targetSize) {
        // LRU cache automatically removes oldest entries
        const keys = Array.from(this._dataCache.keys());
        if (keys.length > 0) {
          this._dataCache.delete(keys[0]);
        } else {
          break;
        }
      }
    }

    // Clear pending requests that are stale
    if (this._pendingRequests) {
      this._pendingRequests.clear();
    }

    // Clear prefetch queue
    this._prefetchQueue = [];
    if (this._prefetchTimeout) {
      clearTimeout(this._prefetchTimeout);
      this._prefetchTimeout = null;
    }

    const afterMemory = this.estimateMemoryUsage();
    const freedMB = (parseFloat(beforeMemory.megabytes) - parseFloat(afterMemory.megabytes)).toFixed(2);

    console.debug(`[DataLayer] Memory cleanup: freed ~${freedMB}MB (bulk cache cleared, data cache pruned to 50%)`);
  }

  // ===========================================================================
  // VARIABLE LISTING
  // ===========================================================================

  /**
   * Get list of available variables by type
   *
   * @param {DataType} type - Type of variables to list
   * @returns {VariableInfo[]} Array of variable information objects
   *
   * @example
   * const genes = dataLayer.getAvailableVariables('gene_expression');
   * console.log(`Found ${genes.length} genes`);
   */
  getAvailableVariables(type) {
    switch (type) {
      case 'categorical_obs':
        return this._getCategoricalObsVariables();
      case 'continuous_obs':
        return this._getContinuousObsVariables();
      case 'gene_expression':
        return this._getGeneExpressionVariables();
      default:
        console.warn(`[DataLayer] Unknown variable type: ${type}`);
        return [];
    }
  }

  /**
   * Get categorical obs variables
   * @returns {VariableInfo[]}
   * @private
   */
  _getCategoricalObsVariables() {
    const obsData = this.state.obsData;
    if (!obsData || !obsData.fields) return [];

    const results = [];
    for (let i = 0; i < obsData.fields.length; i++) {
      const field = obsData.fields[i];
      if (field.kind === 'category') {
        results.push({
          key: field.key,
          name: field.key,
          kind: 'category',
          categories: field.categories || [],
          categoryCount: (field.categories || []).length,
          loaded: field.loaded || false,
          _fieldIndex: i
        });
      }
    }
    return results;
  }

  /**
   * Get continuous obs variables
   * @returns {VariableInfo[]}
   * @private
   */
  _getContinuousObsVariables() {
    const obsData = this.state.obsData;
    if (!obsData || !obsData.fields) return [];

    const results = [];
    for (let i = 0; i < obsData.fields.length; i++) {
      const field = obsData.fields[i];
      if (field.kind === 'continuous') {
        const stats = field._continuousStats || {};
        results.push({
          key: field.key,
          name: field.key,
          kind: 'continuous',
          min: stats.min ?? null,
          max: stats.max ?? null,
          mean: stats.mean ?? null,
          loaded: field.loaded || false,
          _fieldIndex: i
        });
      }
    }
    return results;
  }

  /**
   * Get gene expression variables
   * @returns {VariableInfo[]}
   * @private
   */
  _getGeneExpressionVariables() {
    const varData = this.state.varData;
    if (!varData || !varData.fields) return [];

    return varData.fields.map((field, index) => {
      const stats = field._continuousStats || {};
      return {
        key: field.key,
        name: field.key,
        kind: 'continuous',
        min: stats.min ?? 0,
        max: stats.max ?? null,
        mean: stats.mean ?? null,
        loaded: field.loaded || false,
        _fieldIndex: index,
        _isGene: true
      };
    });
  }

  /**
   * Get variable info for a specific variable
   *
   * @param {DataType} type - Type of data
   * @param {string} key - Variable key
   * @returns {VariableInfo|null} Variable info or null if not found
   *
   * @example
   * const geneInfo = dataLayer.getVariableInfo('gene_expression', 'BRCA1');
   */
  getVariableInfo(type, key) {
    const variables = this.getAvailableVariables(type);
    return variables.find(v => v.key === key) || null;
  }

  // ===========================================================================
  // PAGE ACCESS
  // ===========================================================================

  /**
   * Get all highlight pages
   * @returns {Object[]} Array of page objects
   */
  getPages() {
    return this.state.getHighlightPages() || [];
  }

  /**
   * Get cell indices for a specific page
   *
   * @param {string} pageId - Page identifier
   * @returns {number[]} Array of cell indices
   *
   * @example
   * const cellIndices = dataLayer.getCellIndicesForPage('page1');
   * console.log(`Page has ${cellIndices.length} cells`);
   */
  getCellIndicesForPage(pageId) {
    const pages = this.state.getHighlightPages() || [];
    const page = pages.find(p => p.id === pageId);

    if (!page) {
      console.warn(`[DataLayer] Page not found: ${pageId}`);
      return [];
    }

    // Collect all cell indices from enabled highlight groups
    const cellIndices = new Set();
    for (const group of (page.highlightedGroups || [])) {
      if (group.enabled === false) continue;
      if (group.cellIndices) {
        for (const idx of group.cellIndices) {
          cellIndices.add(idx);
        }
      }
    }

    return Array.from(cellIndices).sort((a, b) => a - b);
  }

  // ===========================================================================
  // DATA FETCHING
  // ===========================================================================

  /**
   * Ensure a field is loaded
   * @param {Object} field - Field object
   * @param {number} fieldIndex - Index of the field
   * @param {string} source - 'obs' or 'var'
   * @param {Object} [options] - Options
   * @param {boolean} [options.silent=true] - Suppress per-field notifications
   * @returns {Promise<void>}
   * @private
   */
  async _ensureFieldLoaded(field, fieldIndex, source, options = {}) {
    const { silent = true } = options;

    if (field.loaded) return;

    // If there's a loading promise in progress, wait for it
    if (field._loadingPromise) {
      await field._loadingPromise;
      return;
    }

    try {
      if (source === 'obs' && this.state.ensureFieldLoaded) {
        await this.state.ensureFieldLoaded(fieldIndex, { silent });
      } else if (source === 'var' && this.state.ensureVarFieldLoaded) {
        await this.state.ensureVarFieldLoaded(fieldIndex, { silent });
      }
    } catch (err) {
      console.warn(`[DataLayer] Failed to load field at index ${fieldIndex}:`, err);
    }
  }

  /**
   * Fetch data for a specific variable and page(s)
   *
   * This is the main method for retrieving data. It handles caching,
   * deduplication, and lazy loading automatically.
   *
   * @param {FetchOptions} options - Fetch options
   * @param {boolean} [options.silent=false] - Suppress loading notifications (for bulk operations)
   * @returns {Promise<PageData[]>} Array of page data objects
   *
   * @example
   * const pageData = await dataLayer.getDataForPages({
   *   type: 'gene_expression',
   *   variableKey: 'BRCA1',
   *   pageIds: ['page1', 'page2']
   * });
   *
   * for (const pd of pageData) {
   *   console.log(`${pd.pageName}: ${pd.cellCount} cells`);
   * }
   */
  async getDataForPages(options) {
    const { type, variableKey, pageIds, silent = false } = options;

    if (!pageIds || pageIds.length === 0) {
      return [];
    }

    // Keep cache keys correct as highlight pages change.
    // Without refreshing page versions, cached results can become stale and plots lag behind
    // (e.g., a newly created page remains "empty" in analysis until another page change occurs).
    this.refreshPageVersions(Array.from(new Set(pageIds)));

    // Check cache first (if enabled)
    if (this._dataCache) {
      const cacheKey = this._getCacheKey(options);

      if (this._dataCache.has(cacheKey)) {
        return this._dataCache.get(cacheKey);
      }

      // Check for pending request (deduplication)
      if (this._pendingRequests && this._pendingRequests.has(cacheKey)) {
        return this._pendingRequests.get(cacheKey);
      }

      // Create new request
      const requestPromise = this._fetchDataForPages(options);

      if (this._pendingRequests) {
        this._pendingRequests.set(cacheKey, requestPromise);
      }

      try {
        const result = await requestPromise;
        this._dataCache.set(cacheKey, result);
        return result;
      } finally {
        if (this._pendingRequests) {
          this._pendingRequests.delete(cacheKey);
        }
      }
    }

    // No caching, fetch directly
    return this._fetchDataForPages(options);
  }

  /**
   * Internal fetch implementation (without caching)
   * @param {FetchOptions} options - Fetch options
   * @param {boolean} [options.silent=false] - Suppress loading notifications
   * @returns {Promise<PageData[]>}
   * @private
   */
  async _fetchDataForPages(options) {
    const { type, variableKey, pageIds, silent = false } = options;

    // Get the variable info and field
    const variableInfo = this.getVariableInfo(type, variableKey);
    if (!variableInfo) {
      console.warn(`[DataLayer] Variable not found: ${variableKey} (type: ${type})`);
      return [];
    }

    // Get the source and field
    const source = type === 'gene_expression' ? 'var' : 'obs';
    const fields = source === 'var'
      ? this.state.varData?.fields
      : this.state.obsData?.fields;

    if (!fields) {
      console.warn(`[DataLayer] No ${source} fields available`);
      return [];
    }

    const fieldIndex = variableInfo._fieldIndex;
    const field = fields[fieldIndex];

    if (!field) {
      console.warn(`[DataLayer] Field not found at index ${fieldIndex}`);
      return [];
    }

    // Ensure field is loaded - show notification if not already loaded (unless silent)
    let loadingNotificationId = null;
    let loadStartTime = null;
    const MIN_NOTIFICATION_DURATION = 800; // Minimum time to show notification (ms)

    if (!field.loaded && this._notifications && !silent) {
      loadStartTime = performance.now();
      loadingNotificationId = this._notifications.show({
        type: 'loading',
        category: 'data',
        message: `Loading ${variableKey}...`
      });
    }

    try {
      await this._ensureFieldLoaded(field, fieldIndex, source);
    } finally {
      if (loadingNotificationId && this._notifications) {
        // Ensure notification is visible for minimum duration
        const elapsed = performance.now() - loadStartTime;
        const remainingTime = MIN_NOTIFICATION_DURATION - elapsed;

        if (remainingTime > 0) {
          setTimeout(() => {
            this._notifications.dismiss(loadingNotificationId);
          }, remainingTime);
        } else {
          this._notifications.dismiss(loadingNotificationId);
        }
      }
    }

    // Get values array
    const rawValues = field.kind === 'category'
      ? field.codes
      : field.values;

    if (!rawValues || rawValues.length === 0) {
      console.warn(`[DataLayer] No values for field: ${variableKey}`);
      return [];
    }

    // Categories for decoding (if categorical)
    const categories = field.categories || [];

    // Process each page
    const results = [];
    const allPages = this.getPages();

    for (const pageId of pageIds) {
      const page = allPages.find(p => p.id === pageId);
      if (!page) {
        console.warn(`[DataLayer] Page not found: ${pageId}`);
        continue;
      }

      const cellIndices = this.getCellIndicesForPage(pageId);

      if (cellIndices.length === 0) {
        results.push({
          pageId,
          pageName: page.name,
          variableInfo: { ...variableInfo },
          values: [],
          cellIndices: [],
          cellCount: 0
        });
        continue;
      }

      // Extract values for cells in this page
      const values = [];
      const validIndices = [];

      for (const idx of cellIndices) {
        if (idx >= 0 && idx < rawValues.length) {
          let value = rawValues[idx];

          // Handle missing values
          if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
            continue;
          }

          // Decode categorical values
          if (field.kind === 'category') {
            value = categories[value] ?? `Unknown (${value})`;
          }

          values.push(value);
          validIndices.push(idx);
        }
      }

      results.push({
        pageId,
        pageName: page.name,
        variableInfo: {
          ...variableInfo,
          categories: field.kind === 'category' ? categories : undefined
        },
        values,
        cellIndices: validIndices,
        cellCount: values.length
      });
    }

    return results;
  }

  /**
   * Batch fetch multiple variables
   *
   * @param {FetchOptions[]} requests - Array of fetch requests
   * @returns {Promise<Map<string, PageData[]>>} Map of results keyed by "type:variableKey"
   *
   * @example
   * const results = await dataLayer.batchFetch([
   *   { type: 'gene_expression', variableKey: 'BRCA1', pageIds: ['p1', 'p2'] },
   *   { type: 'gene_expression', variableKey: 'TP53', pageIds: ['p1', 'p2'] }
   * ]);
   * const brca1Data = results.get('gene_expression:BRCA1');
   */
  async batchFetch(requests) {
    const results = new Map();

    // Process in parallel
    await Promise.all(
      requests.map(async (request) => {
        const key = `${request.type}:${request.variableKey}`;
        const data = await this.getDataForPages(request);
        results.set(key, data);
      })
    );

    return results;
  }

  // ===========================================================================
  // AGGREGATION & STATISTICS
  // ===========================================================================

  /**
   * Get aggregated statistics for a variable across pages
   *
   * @param {DataType} type - Data type
   * @param {string} variableKey - Variable key
   * @param {string[]} pageIds - Page IDs
   * @returns {Promise<Object|null>} Aggregated statistics
   *
   * @example
   * const stats = await dataLayer.getAggregatedStats(
   *   'gene_expression', 'BRCA1', ['page1', 'page2']
   * );
   * console.log(`Mean expression: ${stats.mean}`);
   */
  async getAggregatedStats(type, variableKey, pageIds) {
    const pageData = await this.getDataForPages({ type, variableKey, pageIds });

    const variableInfo = this.getVariableInfo(type, variableKey);
    if (!variableInfo) return null;

    if (variableInfo.kind === 'category') {
      // Aggregate category counts
      const categoryCounts = new Map();
      let totalCount = 0;

      for (const pd of pageData) {
        for (const value of pd.values) {
          categoryCounts.set(value, (categoryCounts.get(value) || 0) + 1);
          totalCount++;
        }
      }

      return {
        kind: 'category',
        variableKey,
        categoryCounts: Object.fromEntries(categoryCounts),
        categories: Array.from(categoryCounts.keys()),
        totalCount
      };
    } else {
      // Aggregate continuous statistics
      const allValues = pageData.flatMap(pd => pd.values);
      const validValues = allValues.filter(v => typeof v === 'number' && Number.isFinite(v));

      if (validValues.length === 0) {
        return {
          kind: 'continuous',
          variableKey,
          count: 0,
          min: null,
          max: null,
          mean: null,
          median: null
        };
      }

      validValues.sort((a, b) => a - b);
      const sum = validValues.reduce((acc, v) => acc + v, 0);
      const mid = Math.floor(validValues.length / 2);
      const median = validValues.length % 2 === 0
        ? (validValues[mid - 1] + validValues[mid]) / 2
        : validValues[mid];

      return {
        kind: 'continuous',
        variableKey,
        count: validValues.length,
        min: validValues[0],
        max: validValues[validValues.length - 1],
        mean: sum / validValues.length,
        median
      };
    }
  }

  /**
   * Get category counts per page for comparison
   *
   * @param {string} variableKey - Categorical variable key
   * @param {string[]} pageIds - Page IDs to compare
   * @returns {Promise<Object>} Category counts by page
   *
   * @example
   * const counts = await dataLayer.getCategoryCountsByPage('cell_type', ['p1', 'p2']);
   * console.log(counts.pages.p1.counts); // { 'T cell': 100, 'B cell': 50, ... }
   */
  async getCategoryCountsByPage(variableKey, pageIds) {
    const pageData = await this.getDataForPages({
      type: 'categorical_obs',
      variableKey,
      pageIds
    });

    // Get all unique categories
    const allCategories = new Set();
    for (const pd of pageData) {
      for (const value of pd.values) {
        allCategories.add(value);
      }
    }

    // Count per page per category
    const result = {
      categories: Array.from(allCategories),
      pages: {}
    };

    for (const pd of pageData) {
      const counts = {};
      for (const cat of allCategories) {
        counts[cat] = 0;
      }
      for (const value of pd.values) {
        counts[value] = (counts[value] || 0) + 1;
      }
      result.pages[pd.pageId] = {
        name: pd.pageName,
        counts,
        total: pd.cellCount
      };
    }

    return result;
  }

  // ===========================================================================
  // CACHING & VERSION TRACKING
  // ===========================================================================

  /**
   * Generate cache key for a request
   * @param {FetchOptions} options - Fetch options
   * @returns {string} Cache key
   * @private
   */
  _getCacheKey(options) {
    const { type, variableKey, pageIds } = options;
    const sortedPageIds = [...pageIds].sort();

    // Include page version hashes for cache correctness
    if (this._pageVersions) {
      const versionHashes = sortedPageIds.map(id => this._getPageVersion(id));
      const versionKey = versionHashes.map(h => {
        const parts = h.split(':');
        return `${parts[0]}@${parts[1] || 'e'}`;
      }).join('|');
      return `${type}:${variableKey}:${sortedPageIds.join(',')}:v=${versionKey}`;
    }

    return `${type}:${variableKey}:${sortedPageIds.join(',')}`;
  }

  /**
   * Initialize page version tracking
   * @private
   */
  _initPageVersionTracking() {
    const pages = this.getPages();
    for (const page of pages) {
      this._updatePageVersion(page.id);
    }
  }

  /**
   * Compute a hash for page cell indices
   * @param {string} pageId - Page ID
   * @returns {string} Hash of the page state
   * @private
   */
  _computePageHash(pageId) {
    const pageName = this.getPages().find(p => p.id === pageId)?.name || '';
    const cellIndices = this.getCellIndicesForPage(pageId);
    if (!cellIndices || cellIndices.length === 0) {
      return `${pageId}:empty:${pageName}`;
    }

    const count = cellIndices.length;
    const firstFew = cellIndices.slice(0, Math.min(5, count));
    const lastFew = cellIndices.slice(-Math.min(5, count));

    let middleSample = [];
    if (count > 100) {
      const step = Math.floor(count / 10);
      for (let i = step; i < count - step; i += step) {
        middleSample.push(cellIndices[i]);
      }
    }

    return `${pageId}:${count}:${pageName}:${firstFew.join(',')}:${lastFew.join(',')}:${middleSample.join(',')}`;
  }

  /**
   * Update the version hash for a page
   * @param {string} pageId - Page ID
   * @returns {string} New hash
   * @private
   */
  _updatePageVersion(pageId) {
    const hash = this._computePageHash(pageId);
    if (this._pageVersions) {
      this._pageVersions.set(pageId, hash);
    }
    return hash;
  }

  /**
   * Get the current version hash for a page
   * @param {string} pageId - Page ID
   * @returns {string} Version hash
   * @private
   */
  _getPageVersion(pageId) {
    if (!this._pageVersions) {
      return `${pageId}:notrack`;
    }
    if (!this._pageVersions.has(pageId)) {
      return this._updatePageVersion(pageId);
    }
    return this._pageVersions.get(pageId);
  }

  /**
   * Check if a page's data has changed since the last cache
   * @param {string} pageId - Page ID
   * @returns {boolean} True if page has changed
   */
  hasPageChanged(pageId) {
    if (!this._pageVersions) return false;
    const currentHash = this._computePageHash(pageId);
    const cachedHash = this._pageVersions.get(pageId);
    return currentHash !== cachedHash;
  }

  /**
   * Refresh version tracking for pages that may have changed
   *
   * @param {string[]} [pageIds] - Page IDs to refresh (null for all)
   */
  refreshPageVersions(pageIds = null) {
    if (!this._pageVersions) return;

    const idsToRefresh = pageIds || this.getPages().map(p => p.id);

    for (const pageId of idsToRefresh) {
      const oldHash = this._pageVersions.get(pageId);
      const newHash = this._updatePageVersion(pageId);

      if (oldHash && oldHash !== newHash) {
        console.debug(`[DataLayer] Page ${pageId} changed, invalidating cache`);
        this.invalidatePages([pageId]);
      }
    }
  }

  /**
   * Invalidate cache for specific pages
   *
   * @param {string[]} pageIds - Page IDs to invalidate
   */
  invalidatePages(pageIds) {
    const uniquePageIds = Array.from(new Set(pageIds || []));
    if (uniquePageIds.length === 0) return;

    const pageIdSet = new Set(uniquePageIds);

    const keyReferencesAnyPage = (key) => {
      if (!key) return false;

      // Bulk gene cache keys look like: bulk_genes:page_1,page_2
      if (key.startsWith('bulk_genes:')) {
        const idsPart = key.slice('bulk_genes:'.length);
        const ids = idsPart.split(',').filter(Boolean);
        return ids.some(id => pageIdSet.has(id));
      }

      // Data cache keys look like: type:variableKey:page_1,page_2[:v=...]
      const parts = key.split(':');
      if (parts.length < 3) return false;

      const last = parts[parts.length - 1];
      const pageIdsPart = last.startsWith('v=') ? parts[parts.length - 2] : last;
      const ids = pageIdsPart.split(',').filter(Boolean);
      return ids.some(id => pageIdSet.has(id));
    };

    if (this._dataCache) {
      for (const key of this._dataCache.keys()) {
        if (keyReferencesAnyPage(key)) {
          this._dataCache.delete(key);
        }
      }
    }

    // Also clear bulk gene cache entries
    for (const [key] of this._bulkGeneCache) {
      if (keyReferencesAnyPage(key)) {
        this._bulkGeneCache.delete(key);
      }
    }
  }

  /**
   * Clear internal caches
   */
  clearCache() {
    this._variableCache.clear();
    if (this._dataCache) {
      this._dataCache.clear();
    }
  }

  /**
   * Clear all caches including bulk gene cache
   */
  clearAllCaches() {
    this._variableCache.clear();
    if (this._dataCache) {
      this._dataCache.clear();
    }
    this._bulkGeneCache.clear();
    this._bulkGeneCacheAccessOrder = [];
    this._prefetchQueue = [];

    if (this._prefetchTimeout) {
      clearTimeout(this._prefetchTimeout);
      this._prefetchTimeout = null;
    }
  }

  // ===========================================================================
  // PREFETCHING
  // ===========================================================================

  /**
   * Prefetch data for likely next selections (runs in background)
   *
   * @param {FetchOptions} options - Fetch options for prefetch
   */
  prefetch(options) {
    if (!this._options.enablePrefetch || !this._dataCache) return;

    const cacheKey = this._getCacheKey(options);

    // Skip if already cached or pending
    if (this._dataCache.has(cacheKey)) return;
    if (this._pendingRequests && this._pendingRequests.has(cacheKey)) return;

    this._prefetchQueue.push(options);

    if (!this._prefetchTimeout) {
      this._prefetchTimeout = setTimeout(() => {
        this._processPrefetchQueue();
      }, 100);
    }
  }

  /**
   * Process prefetch queue in background
   * @private
   */
  async _processPrefetchQueue() {
    this._prefetchTimeout = null;

    const batch = this._prefetchQueue.splice(0, 3);

    for (const options of batch) {
      try {
        await this.getDataForPages(options);
      } catch (err) {
        console.debug('[DataLayer] Prefetch failed:', err.message);
      }
    }

    if (this._prefetchQueue.length > 0) {
      this._prefetchTimeout = setTimeout(() => {
        this._processPrefetchQueue();
      }, 500);
    }
  }

  // ===========================================================================
  // BULK GENE EXPRESSION LOADING
  // ===========================================================================

  /**
   * Get or initialize compute manager
   * @returns {Promise<Object>}
   * @private
   */
  async _getComputeManager() {
    if (!this._computeManager) {
      this._computeManager = getComputeManager();
      await this._computeManager.init();
    }
    return this._computeManager;
  }

  /**
   * Evict old/expired entries from bulk gene cache
   * @private
   */
  _evictBulkGeneCacheIfNeeded() {
    const now = Date.now();

    // Remove expired entries
    for (const [key, entry] of this._bulkGeneCache) {
      if ((now - entry.timestamp) >= this._bulkGeneCacheMaxAge) {
        this._bulkGeneCache.delete(key);
        const orderIdx = this._bulkGeneCacheAccessOrder.indexOf(key);
        if (orderIdx >= 0) {
          this._bulkGeneCacheAccessOrder.splice(orderIdx, 1);
        }
      }
    }

    // Evict oldest if over limit
    while (this._bulkGeneCache.size >= this._bulkGeneCacheMaxSize && this._bulkGeneCacheAccessOrder.length > 0) {
      const oldestKey = this._bulkGeneCacheAccessOrder.shift();
      if (this._bulkGeneCache.has(oldestKey)) {
        console.debug(`[DataLayer] Evicting bulk gene cache entry: ${oldestKey.substring(0, 30)}...`);
        this._bulkGeneCache.delete(oldestKey);
      }
    }
  }

  /**
   * Add entry to bulk gene cache with LRU tracking
   * @param {string} key - Cache key
   * @param {Object} value - Value to cache
   * @private
   */
  _setBulkGeneCache(key, value) {
    this._evictBulkGeneCacheIfNeeded();

    const existingIdx = this._bulkGeneCacheAccessOrder.indexOf(key);
    if (existingIdx >= 0) {
      this._bulkGeneCacheAccessOrder.splice(existingIdx, 1);
    }

    this._bulkGeneCache.set(key, value);
    this._bulkGeneCacheAccessOrder.push(key);
  }

  /**
   * Get entry from bulk gene cache and update access order
   * @param {string} key - Cache key
   * @returns {Object|undefined}
   * @private
   */
  _getBulkGeneCache(key) {
    const entry = this._bulkGeneCache.get(key);
    if (entry) {
      const idx = this._bulkGeneCacheAccessOrder.indexOf(key);
      if (idx >= 0) {
        this._bulkGeneCacheAccessOrder.splice(idx, 1);
        this._bulkGeneCacheAccessOrder.push(key);
      }
    }
    return entry;
  }

  /**
   * Build a stable bulk-gene cache key without mutating caller-owned arrays.
   * @param {string[]} pageIds
   * @returns {string}
   * @private
   */
  _getBulkGeneCacheKey(pageIds) {
    const sortedUnique = Array.from(new Set(pageIds || [])).sort();
    return `bulk_genes:${sortedUnique.join(',')}`;
  }

  /**
   * Fetch all gene expression data for given pages
   *
   * Used for differential expression analysis. Shows progress notification.
   *
   * @param {Object} options - Fetch options
   * @param {string[]} options.pageIds - Page IDs to fetch for
   * @param {string[]} [options.geneList] - Optional subset of genes
   * @param {boolean} [options.forceReload=false] - Bypass cache
   * @param {Function} [options.onProgress] - Progress callback (0-100)
   * @returns {Promise<Object>} Map of geneName -> { pageId: values[] }
   *
   * @example
   * const geneData = await dataLayer.fetchBulkGeneExpression({
   *   pageIds: ['page1', 'page2'],
   *   geneList: ['BRCA1', 'TP53', 'EGFR'],
   *   onProgress: (p) => console.log(`${p}% complete`)
   * });
   */
  async fetchBulkGeneExpression(options) {
    const { pageIds, geneList = null, forceReload = false, onProgress } = options;

    if (!pageIds || pageIds.length === 0) {
      return {};
    }

    // Ensure bulk gene cache stays correct as highlight pages change.
    // (If versions are stale, bulk caches can return results for an old page membership.)
    this.refreshPageVersions(Array.from(new Set(pageIds)));

    const cacheKey = this._getBulkGeneCacheKey(pageIds);

    // Check cache
    if (!forceReload) {
      const cached = this._getBulkGeneCache(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < this._bulkGeneCacheMaxAge) {
        if (geneList) {
          const filtered = {};
          for (const gene of geneList) {
            if (cached.data[gene]) {
              filtered[gene] = cached.data[gene];
            }
          }
          return filtered;
        }
        return cached.data;
      }
    }

    const allGenes = this.getAvailableVariables('gene_expression');
    const genesToFetch = geneList
      ? allGenes.filter(g => geneList.includes(g.key))
      : allGenes;

    if (genesToFetch.length === 0) {
      return {};
    }

    // Show loading notification
    let notificationId = null;
    if (this._notifications) {
      notificationId = this._notifications.show({
        type: 'progress',
        category: 'data',
        title: 'Loading Gene Expression',
        message: `Preparing to load ${genesToFetch.length} genes...`,
        progress: 0
      });
    }

    const results = {};
    const batchSize = 10;
    const startTime = performance.now();

    try {
      for (let i = 0; i < genesToFetch.length; i += batchSize) {
        const batch = genesToFetch.slice(i, i + batchSize);
        const progress = Math.round((i / genesToFetch.length) * 100);

        if (this._notifications && notificationId) {
          this._notifications.updateProgress(notificationId, progress, {
            message: `Loading genes ${i + 1}-${Math.min(i + batchSize, genesToFetch.length)} of ${genesToFetch.length}...`
          });
        }

        if (onProgress) {
          onProgress(progress);
        }

        await Promise.all(batch.map(async (geneInfo) => {
          const geneData = await this.getDataForPages({
            type: 'gene_expression',
            variableKey: geneInfo.key,
            pageIds,
            silent: true // Suppress individual notifications during bulk load
          });

          results[geneInfo.key] = {};
          for (const pd of geneData) {
            results[geneInfo.key][pd.pageId] = {
              values: pd.values,
              cellIndices: pd.cellIndices,
              pageName: pd.pageName,
              cellCount: pd.cellCount
            };
          }
        }));

        // Yield to event loop
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      this._setBulkGeneCache(cacheKey, {
        data: results,
        timestamp: Date.now(),
        geneCount: genesToFetch.length
      });

      const duration = performance.now() - startTime;
      if (this._notifications && notificationId) {
        this._notifications.complete(notificationId,
          `Loaded ${genesToFetch.length} genes (${(duration / 1000).toFixed(1)}s)`
        );
      }

      return results;

    } catch (error) {
      if (this._notifications && notificationId) {
        this._notifications.fail(notificationId,
          `Failed to load gene expression: ${error.message}`
        );
      }
      throw error;
    }
  }

  /**
   * Get subset of bulk gene data (from cache or fetch)
   *
   * @param {string[]} geneList - Genes to get
   * @param {string[]} pageIds - Page IDs
   * @returns {Promise<Object>} Gene data by gene name
   */
  async getGeneExpressionSubset(geneList, pageIds) {
    const cacheKey = this._getBulkGeneCacheKey(pageIds);
    const cached = this._getBulkGeneCache(cacheKey);

    if (cached && (Date.now() - cached.timestamp) < this._bulkGeneCacheMaxAge) {
      const results = {};
      for (const gene of geneList) {
        if (cached.data[gene]) {
          results[gene] = cached.data[gene];
        } else {
          const geneData = await this.getDataForPages({
            type: 'gene_expression',
            variableKey: gene,
            pageIds
          });

          results[gene] = {};
          for (const pd of geneData) {
            results[gene][pd.pageId] = {
              values: pd.values,
              cellIndices: pd.cellIndices,
              pageName: pd.pageName,
              cellCount: pd.cellCount
            };
          }
        }
      }
      return results;
    }

    return this.fetchBulkGeneExpression({
      pageIds,
      geneList,
      forceReload: false
    });
  }

  /**
   * Check if bulk gene data is cached
   * @param {string[]} pageIds - Page IDs
   * @returns {boolean}
   */
  hasBulkGeneCache(pageIds) {
    const cacheKey = this._getBulkGeneCacheKey(pageIds);
    const cached = this._bulkGeneCache.get(cacheKey);
    return cached && (Date.now() - cached.timestamp) < this._bulkGeneCacheMaxAge;
  }

  /**
   * Get cached bulk gene count
   * @param {string[]} pageIds - Page IDs
   * @returns {number}
   */
  getCachedGeneCount(pageIds) {
    const cacheKey = this._getBulkGeneCacheKey(pageIds);
    const cached = this._bulkGeneCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < this._bulkGeneCacheMaxAge) {
      return cached.geneCount;
    }
    return 0;
  }

  // ===========================================================================
  // HIGH-PERFORMANCE ANALYSIS DATA LOADING
  // ===========================================================================

  /**
   * Fetch analysis data optimized for bulk operations.
   *
   * @param {Object} options - Fetch options
   * @param {string[]} options.pageIds - Page IDs to fetch for
   * @param {string[]} options.genes - Gene names to load
   * @param {boolean} [options.includeLatent=false] - Also load latent embeddings
   * @param {number} [options.latentDimension=2] - Dimension for latent space
   * @param {boolean} [options.usePoolMode=true] - Enable worker pool
   * @param {Function} [options.onProgress] - Progress callback
   * @returns {Promise<Object>} { genes, latent?, pageData, stats }
   */
  async fetchAnalysisData(options) {
    const {
      pageIds,
      genes,
      includeLatent = false,
      latentDimension = 2,
      usePoolMode = true, // kept for backward compatibility, ComputeManager handles this automatically
      onProgress
    } = options;

    const startTime = performance.now();

    // Initialize compute manager (handles GPU -> Worker -> CPU fallback automatically)
    if (usePoolMode) {
      await this._getComputeManager();
    }

    const result = {
      genes: {},
      pageData: {},
      stats: {
        genesLoaded: 0,
        cellsTotal: 0,
        loadTimeMs: 0
      }
    };

    // Get cell indices for each page
    for (const pageId of pageIds) {
      const cellIndices = this.getCellIndicesForPage(pageId);
      const page = this.getPages().find(p => p.id === pageId);
      result.pageData[pageId] = {
        name: page?.name || pageId,
        cellIndices,
        cellCount: cellIndices.length
      };
      result.stats.cellsTotal += cellIndices.length;
    }

    const needsLoad = genes && genes.length > 0;

    if (needsLoad) {
      const varManifest = this.state?.varManifest || null;
      const manifestUrl = this.state?.manifestUrl || null;

      if (varManifest && manifestUrl) {
        try {
          const bulkData = await loadAnalysisBulkData({
            manifestUrl,
            varManifest,
            geneList: genes,
            batchSize: 20,
            onProgress: (p) => {
              const adjustedProgress = includeLatent ? Math.round(p * 0.8) : p;
              if (onProgress) onProgress(adjustedProgress);
            }
          });

          for (const [geneName, values] of Object.entries(bulkData.genes)) {
            result.genes[geneName] = {};

            for (const pageId of pageIds) {
              const cellIndices = result.pageData[pageId].cellIndices;
              const pageValues = new Float32Array(cellIndices.length);

              for (let i = 0; i < cellIndices.length; i++) {
                const cellIdx = cellIndices[i];
                pageValues[i] = cellIdx < values.length ? values[cellIdx] : NaN;
              }

              result.genes[geneName][pageId] = {
                values: pageValues,
                cellIndices,
                pageName: result.pageData[pageId].name,
                cellCount: cellIndices.length
              };
            }

            result.stats.genesLoaded++;
          }
        } catch (error) {
          console.warn('[DataLayer] Bulk loader failed, falling back to sequential:', error.message);
          await this._loadGenesSequentially(genes, pageIds, result);
        }
      } else {
        await this._loadGenesSequentially(genes, pageIds, result);
      }
    }

    // Load latent embeddings if requested
    if (includeLatent) {
      try {
        const baseUrl = this.state?.manifestUrl || null;
        const identity = this.state?.datasetIdentity || null;

        if (baseUrl && identity) {
          if (onProgress) onProgress(85);

          const latentData = await loadLatentEmbeddings({
            baseUrl,
            identity,
            dimension: latentDimension
          });

          result.latent = {
            dimension: latentData.dimension,
            pages: {}
          };

          for (const pageId of pageIds) {
            const cellIndices = result.pageData[pageId].cellIndices;
            const dim = latentData.dimension;
            const pageCoords = new Float32Array(cellIndices.length * dim);

            for (let i = 0; i < cellIndices.length; i++) {
              const cellIdx = cellIndices[i];
              for (let d = 0; d < dim; d++) {
                pageCoords[i * dim + d] = latentData.points[cellIdx * dim + d];
              }
            }

            result.latent.pages[pageId] = {
              coordinates: pageCoords,
              cellCount: cellIndices.length
            };
          }

          if (onProgress) onProgress(100);
        }
      } catch (error) {
        console.warn('[DataLayer] Failed to load latent embeddings:', error.message);
      }
    }

    result.stats.loadTimeMs = performance.now() - startTime;
    return result;
  }

  /**
   * Load genes sequentially (fallback method)
   * @param {string[]} genes - Gene names to load
   * @param {string[]} pageIds - Page IDs
   * @param {Object} result - Result object to populate
   * @param {Function} [onProgress] - Progress callback
   * @private
   */
  async _loadGenesSequentially(genes, pageIds, result, onProgress) {
    const totalGenes = genes.length;

    for (let i = 0; i < genes.length; i++) {
      const gene = genes[i];
      try {
        const geneData = await this.getDataForPages({
          type: 'gene_expression',
          variableKey: gene,
          pageIds,
          silent: true // Suppress individual notifications during bulk load
        });

        if (onProgress) {
          onProgress(Math.round(((i + 1) / totalGenes) * 100));
        }

        result.genes[gene] = {};
        for (const pd of geneData) {
          result.genes[gene][pd.pageId] = {
            values: pd.values,
            cellIndices: pd.cellIndices,
            pageName: pd.pageName,
            cellCount: pd.cellCount
          };
        }
        result.stats.genesLoaded++;
      } catch (err) {
        console.warn(`[DataLayer] Failed to load gene ${gene}:`, err.message);
      }
    }
  }

  /**
   * Fetch bulk observation field data for analysis
   *
   * @param {Object} options - Fetch options
   * @param {string[]} options.pageIds - Page IDs
   * @param {string[]} options.obsFields - Observation field keys
   * @param {Function} [options.onProgress] - Progress callback
   * @returns {Promise<Object>} { fields, pageData, stats }
   */
  async fetchBulkObsFields(options) {
    const { pageIds, obsFields, onProgress } = options;

    const startTime = performance.now();

    const obsManifest = this.state?.obsManifest || null;
    const manifestUrl = this.state?.manifestUrl || null;

    const result = {
      fields: {},
      pageData: {},
      stats: {
        fieldsLoaded: 0,
        cellsTotal: 0,
        loadTimeMs: 0
      }
    };

    // Get cell indices for each page
    for (const pageId of pageIds) {
      const cellIndices = this.getCellIndicesForPage(pageId);
      const page = this.getPages().find(p => p.id === pageId);
      result.pageData[pageId] = {
        name: page?.name || pageId,
        cellIndices,
        cellCount: cellIndices.length
      };
      result.stats.cellsTotal += cellIndices.length;
    }

    if (!obsFields || obsFields.length === 0) {
      return result;
    }

    // Show progress notification for bulk obs loading
    let notificationId = null;
    if (this._notifications && obsFields.length > 1) {
      notificationId = this._notifications.show({
        type: 'progress',
        category: 'data',
        message: `Loading ${obsFields.length} observation fields...`,
        progress: 0
      });
    }

    // Progress handler that updates both notification and external callback
    const handleProgress = (progress) => {
      if (notificationId && this._notifications) {
        this._notifications.updateProgress(notificationId, progress, {
          message: `Loading observation fields... ${progress}%`
        });
      }
      if (onProgress) {
        onProgress(progress);
      }
    };

    try {
      if (obsManifest && manifestUrl) {
        try {
          const bulkData = await loadAnalysisBulkObsData({
            manifestUrl,
            obsManifest,
            fieldList: obsFields,
            batchSize: 10,
            onProgress: handleProgress
          });

          for (const [fieldKey, fieldData] of Object.entries(bulkData.fields)) {
            result.fields[fieldKey] = {
              kind: fieldData.kind,
              categories: fieldData.categories
            };

            for (const pageId of pageIds) {
              const cellIndices = result.pageData[pageId].cellIndices;

              if (fieldData.kind === 'continuous' && fieldData.values) {
                const pageValues = new Float32Array(cellIndices.length);
                for (let i = 0; i < cellIndices.length; i++) {
                  const cellIdx = cellIndices[i];
                  pageValues[i] = cellIdx < fieldData.values.length
                    ? fieldData.values[cellIdx]
                    : NaN;
                }
                result.fields[fieldKey][pageId] = {
                  values: pageValues,
                  cellCount: cellIndices.length
                };
              } else if (fieldData.codes) {
                const pageCodes = new Uint16Array(cellIndices.length);
                for (let i = 0; i < cellIndices.length; i++) {
                  const cellIdx = cellIndices[i];
                  pageCodes[i] = cellIdx < fieldData.codes.length
                    ? fieldData.codes[cellIdx]
                    : 65535;
                }
                const pageValues = [];
                for (let i = 0; i < pageCodes.length; i++) {
                  const code = pageCodes[i];
                  if (code === 65535 || !fieldData.categories) {
                    pageValues.push(null);
                  } else {
                    pageValues.push(fieldData.categories[code] || `Unknown (${code})`);
                  }
                }
                result.fields[fieldKey][pageId] = {
                  values: pageValues,
                  codes: pageCodes,
                  cellCount: cellIndices.length
                };
              }
            }

            result.stats.fieldsLoaded++;
          }
        } catch (error) {
          console.warn('[DataLayer] Bulk obs loader failed, falling back to sequential:', error.message);
          await this._loadObsFieldsSequentially(obsFields, pageIds, result, handleProgress);
        }
      } else {
        await this._loadObsFieldsSequentially(obsFields, pageIds, result, handleProgress);
      }

      // Complete notification
      const duration = performance.now() - startTime;
      if (notificationId && this._notifications) {
        this._notifications.complete(notificationId,
          `Loaded ${result.stats.fieldsLoaded} fields (${(duration / 1000).toFixed(1)}s)`
        );
      }
    } catch (error) {
      // Fail notification on error
      if (notificationId && this._notifications) {
        this._notifications.fail(notificationId, `Failed to load observation fields: ${error.message}`);
      }
      throw error;
    }

    result.stats.loadTimeMs = performance.now() - startTime;
    return result;
  }

  /**
   * Load obs fields sequentially (fallback method)
   * @param {string[]} obsFields - Field keys to load
   * @param {string[]} pageIds - Page IDs
   * @param {Object} result - Result object to populate
   * @param {Function} [onProgress] - Progress callback
   * @private
   */
  async _loadObsFieldsSequentially(obsFields, pageIds, result, onProgress) {
    const totalFields = obsFields.length;

    for (let i = 0; i < obsFields.length; i++) {
      const fieldKey = obsFields[i];
      try {
        const catFields = this.getAvailableVariables('categorical_obs');
        const isCat = catFields.some(f => f.key === fieldKey);
        const type = isCat ? 'categorical_obs' : 'continuous_obs';

        const fieldDataList = await this.getDataForPages({
          type,
          variableKey: fieldKey,
          pageIds,
          silent: true // Suppress individual notifications during bulk load
        });

        if (onProgress) {
          onProgress(Math.round(((i + 1) / totalFields) * 100));
        }

        result.fields[fieldKey] = {
          kind: isCat ? 'category' : 'continuous'
        };

        for (const pd of fieldDataList) {
          result.fields[fieldKey][pd.pageId] = {
            values: pd.values,
            cellCount: pd.cellCount
          };
        }
        result.stats.fieldsLoaded++;
      } catch (err) {
        console.warn(`[DataLayer] Failed to load obs field ${fieldKey}:`, err.message);
      }
    }
  }

  /**
   * Fetch comprehensive analysis data: genes + obs fields + optional latent
   *
   * @param {Object} options - Fetch options
   * @param {string[]} options.pageIds - Page IDs
   * @param {string[]} [options.genes=[]] - Gene names
   * @param {string[]} [options.obsFields=[]] - Observation field keys
   * @param {boolean} [options.includeLatent=false] - Include latent embeddings
   * @param {number} [options.latentDimension=2] - Latent space dimension
   * @param {Function} [options.onProgress] - Progress callback
   * @returns {Promise<Object>} { genes, obsFields, latent?, pageData, stats }
   */
  async fetchComprehensiveAnalysisData(options) {
    const {
      pageIds,
      genes = [],
      obsFields = [],
      includeLatent = false,
      latentDimension = 2,
      onProgress
    } = options;

    const startTime = performance.now();
    const totalSteps = (genes.length > 0 ? 1 : 0) + (obsFields.length > 0 ? 1 : 0) + (includeLatent ? 1 : 0);
    let completedSteps = 0;

    const result = {
      genes: {},
      obsFields: {},
      pageData: {},
      stats: {
        genesLoaded: 0,
        obsFieldsLoaded: 0,
        cellsTotal: 0,
        loadTimeMs: 0
      }
    };

    for (const pageId of pageIds) {
      const cellIndices = this.getCellIndicesForPage(pageId);
      const page = this.getPages().find(p => p.id === pageId);
      result.pageData[pageId] = {
        name: page?.name || pageId,
        cellIndices,
        cellCount: cellIndices.length
      };
      result.stats.cellsTotal += cellIndices.length;
    }

    if (genes.length > 0) {
      const geneData = await this.fetchAnalysisData({
        pageIds,
        genes,
        onProgress: (p) => {
          if (onProgress && totalSteps > 0) {
            const baseProgress = (completedSteps / totalSteps) * 100;
            const stepProgress = (p / 100) * (100 / totalSteps);
            onProgress(Math.round(baseProgress + stepProgress));
          }
        }
      });
      result.genes = geneData.genes;
      result.stats.genesLoaded = geneData.stats.genesLoaded;
      completedSteps++;
    }

    if (obsFields.length > 0) {
      const obsData = await this.fetchBulkObsFields({
        pageIds,
        obsFields,
        onProgress: (p) => {
          if (onProgress && totalSteps > 0) {
            const baseProgress = (completedSteps / totalSteps) * 100;
            const stepProgress = (p / 100) * (100 / totalSteps);
            onProgress(Math.round(baseProgress + stepProgress));
          }
        }
      });
      result.obsFields = obsData.fields;
      result.stats.obsFieldsLoaded = obsData.stats.fieldsLoaded;
      completedSteps++;
    }

    if (includeLatent) {
      try {
        const baseUrl = this.state?.manifestUrl || null;
        const identity = this.state?.datasetIdentity || null;

        if (baseUrl && identity) {
          const latentData = await loadLatentEmbeddings({
            baseUrl,
            identity,
            dimension: latentDimension
          });

          result.latent = {
            dimension: latentData.dimension,
            pages: {}
          };

          for (const pageId of pageIds) {
            const cellIndices = result.pageData[pageId].cellIndices;
            const dim = latentData.dimension;
            const pageCoords = new Float32Array(cellIndices.length * dim);

            for (let i = 0; i < cellIndices.length; i++) {
              const cellIdx = cellIndices[i];
              for (let d = 0; d < dim; d++) {
                pageCoords[i * dim + d] = latentData.points[cellIdx * dim + d];
              }
            }

            result.latent.pages[pageId] = {
              coordinates: pageCoords,
              cellCount: cellIndices.length
            };
          }
        }
      } catch (error) {
        console.warn('[DataLayer] Failed to load latent embeddings:', error.message);
      }
      completedSteps++;
    }

    if (onProgress) onProgress(100);

    result.stats.loadTimeMs = performance.now() - startTime;
    return result;
  }

  // ===========================================================================
  // GPU/WORKER/CPU ACCELERATED COMPUTATIONS
  // ===========================================================================

  /**
   * Compute statistics using GPU/Worker/CPU backends
   *
   * @param {PageData} pageData - Page data object
   * @returns {Promise<BasicStats>} Statistics object
   */
  async computeStatsForPage(pageData) {
    // Always use ComputeManager for consistent GPU -> Worker -> CPU fallback
    try {
      const computeManager = await this._getComputeManager();
      const result = await computeManager.computeStats(pageData.values);
      return result;
    } catch (err) {
      console.warn('[DataLayer] Compute stats failed, using local fallback:', err.message);
      return this._computeStatsLocal(pageData.values);
    }
  }

  /**
   * Local stats computation fallback
   * @param {number[]} values - Values to compute stats for
   * @returns {BasicStats}
   * @private
   */
  _computeStatsLocal(values) {
    const numericValues = values.filter(v => typeof v === 'number' && Number.isFinite(v));

    if (numericValues.length === 0) {
      return { count: 0, min: null, max: null, mean: null, median: null, std: null };
    }

    const sorted = [...numericValues].sort((a, b) => a - b);
    const n = sorted.length;
    const sum = numericValues.reduce((a, b) => a + b, 0);
    const mean = sum / n;
    const variance = numericValues.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n;

    const mid = Math.floor(n / 2);
    const median = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

    return {
      count: n,
      min: sorted[0],
      max: sorted[n - 1],
      mean,
      median,
      std: Math.sqrt(variance),
      q1: sorted[Math.floor(n * 0.25)],
      q3: sorted[Math.floor(n * 0.75)]
    };
  }

  /**
   * Aggregate categories using GPU/Worker/CPU backends
   *
   * @param {PageData} pageData - Page data object
   * @param {boolean} [normalize=false] - Include percentages
   * @returns {Promise<CategoryAggregation>} Aggregation result
   */
  async aggregateCategoriesForPage(pageData, normalize = false) {
    // Always use ComputeManager for consistent GPU -> Worker -> CPU fallback
    try {
      const computeManager = await this._getComputeManager();
      const result = await computeManager.aggregateCategories(pageData.values, normalize);
      return result;
    } catch (err) {
      console.warn('[DataLayer] Compute aggregation failed, using local fallback:', err.message);
      return this._aggregateCategoriesLocal(pageData.values, normalize);
    }
  }

  /**
   * Local category aggregation fallback
   * @param {string[]} values - Values to aggregate
   * @param {boolean} normalize - Include percentages
   * @returns {CategoryAggregation}
   * @private
   */
  _aggregateCategoriesLocal(values, normalize = false) {
    const counts = new Map();
    let total = 0;

    for (const value of values) {
      counts.set(value, (counts.get(value) || 0) + 1);
      total++;
    }

    const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);

    return {
      categories: entries.map(e => e[0]),
      counts: entries.map(e => e[1]),
      percentages: normalize && total > 0 ? entries.map(e => (e[1] / total) * 100) : undefined,
      total
    };
  }

  /**
   * Compute differential expression using GPU/Worker/CPU backends
   *
   * @param {Object} options - Options
   * @param {string} options.pageA - Reference page ID
   * @param {string} options.pageB - Test page ID
   * @param {string[]} options.genes - Genes to test
   * @param {string} [options.method='wilcox'] - Statistical test
   * @param {Function} [options.onProgress] - Progress callback
   * @returns {Promise<Object[]>} DE results
   */
  async computeDifferentialExpressionParallel(options) {
    const { pageA, pageB, genes, method = 'wilcox', onProgress } = options;

    const analysisData = await this.fetchAnalysisData({
      pageIds: [pageA, pageB],
      genes,
      usePoolMode: true,
      onProgress: (p) => {
        if (onProgress) onProgress(Math.round(p * 0.5));
      }
    });

    const computeManager = await this._getComputeManager();

    if (onProgress) onProgress(55);

    // Process genes sequentially with ComputeManager's automatic backend selection
    const deResults = [];
    const geneNames = Object.keys(analysisData.genes);
    const totalGenes = geneNames.length;

    for (let i = 0; i < totalGenes; i++) {
      const gene = geneNames[i];
      const dataA = analysisData.genes[gene]?.[pageA]?.values || [];
      const dataB = analysisData.genes[gene]?.[pageB]?.values || [];

      // Filter valid numeric values
      const valsA = Array.from(dataA).filter(v => typeof v === 'number' && Number.isFinite(v));
      const valsB = Array.from(dataB).filter(v => typeof v === 'number' && Number.isFinite(v));

      try {
        const result = await computeManager.computeDifferential(valsA, valsB, method);
        deResults.push({ gene, ...result });
      } catch (error) {
        deResults.push({ gene, error: error.message, pValue: NaN, log2FoldChange: NaN });
      }

      // Update progress
      if (onProgress && i % 10 === 0) {
        const progressPercent = 55 + Math.round((i / totalGenes) * 45);
        onProgress(progressPercent);
      }
    }

    if (onProgress) onProgress(100);

    return deResults;
  }

  // ===========================================================================
  // UTILITY METHODS
  // ===========================================================================

  /**
   * Get cache statistics
   * @returns {CacheStats} Cache statistics object
   */
  getCacheStats() {
    return {
      dataCache: {
        size: this._dataCache ? this._dataCache.size() : 0,
        maxSize: this._options.cacheSize,
        stats: this._dataCache ? this._dataCache.getStats() : null
      },
      bulkGeneCache: {
        size: this._bulkGeneCache.size,
        entries: Array.from(this._bulkGeneCache.entries()).map(([key, entry]) => ({
          key: key.substring(0, 50),
          geneCount: entry.geneCount,
          ageMs: Date.now() - entry.timestamp
        }))
      },
      pendingRequests: this._pendingRequests ? this._pendingRequests.size : 0,
      prefetchQueue: this._prefetchQueue.length
    };
  }

  /**
   * Estimate memory usage of caches
   * @returns {{bytes: number, megabytes: string}} Memory estimate
   */
  estimateMemoryUsage() {
    let totalBytes = 0;

    // Data cache
    if (this._dataCache) {
      for (const [key, value] of this._dataCache.entries()) {
        totalBytes += key.length * 2;
        if (Array.isArray(value)) {
          for (const pageData of value) {
            if (pageData.values) {
              totalBytes += pageData.values.length * 8;
            }
            if (pageData.cellIndices) {
              totalBytes += pageData.cellIndices.length * 4;
            }
          }
        }
      }
    }

    // Bulk gene cache
    for (const [key, entry] of this._bulkGeneCache) {
      totalBytes += key.length * 2;
      if (entry.data) {
        for (const geneData of Object.values(entry.data)) {
          for (const pageData of Object.values(geneData)) {
            if (pageData.values) {
              totalBytes += pageData.values.length * 8;
            }
          }
        }
      }
    }

    return {
      bytes: totalBytes,
      megabytes: (totalBytes / (1024 * 1024)).toFixed(2)
    };
  }

  /**
   * Perform periodic cleanup of expired cache entries
   * @returns {{cleaned: number, remaining: number}}
   */
  performCacheCleanup() {
    let cleaned = 0;
    const now = Date.now();

    // Clean expired bulk gene entries
    for (const [key, entry] of this._bulkGeneCache) {
      if ((now - entry.timestamp) >= this._bulkGeneCacheMaxAge) {
        this._bulkGeneCache.delete(key);
        const orderIdx = this._bulkGeneCacheAccessOrder.indexOf(key);
        if (orderIdx >= 0) {
          this._bulkGeneCacheAccessOrder.splice(orderIdx, 1);
        }
        cleaned++;
      }
    }

    // Prune data cache if it supports it
    if (this._dataCache && this._dataCache.prune) {
      cleaned += this._dataCache.prune();
    }

    const remaining = (this._dataCache ? this._dataCache.size() : 0) + this._bulkGeneCache.size;

    if (cleaned > 0) {
      console.debug(`[DataLayer] Cache cleanup removed ${cleaned} entries`);
    }

    return { cleaned, remaining };
  }

  /**
   * Destroy the DataLayer instance and release all resources
   *
   * Call this when the DataLayer is no longer needed to:
   * - Unregister memory cleanup handler
   * - Clear all caches
   * - Cancel pending operations
   */
  destroy() {
    // Unregister memory cleanup handler
    if (this._memoryMonitor && this._instanceId) {
      this._memoryMonitor.unregisterCleanupHandler(this._instanceId);
    }

    // Clear all caches
    if (this._dataCache) {
      this._dataCache.clear();
    }
    this._bulkGeneCache.clear();
    this._bulkGeneCacheAccessOrder = [];
    this._variableCache.clear();

    // Clear pending requests
    if (this._pendingRequests) {
      this._pendingRequests.clear();
    }

    // Clear prefetch queue
    this._prefetchQueue = [];
    if (this._prefetchTimeout) {
      clearTimeout(this._prefetchTimeout);
      this._prefetchTimeout = null;
    }

    // Clear references
    this._computeManager = null;
    this._notifications = null;
    this._memoryMonitor = null;

    console.debug('[DataLayer] Instance destroyed');
  }
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create a new DataLayer instance
 *
 * @param {Object} state - DataState instance
 * @param {DataLayerOptions} [options={}] - Configuration options
 * @returns {DataLayer} New DataLayer instance
 *
 * @example
 * const dataLayer = createDataLayer(state);
 *
 * @example
 * const dataLayer = createDataLayer(state, {
 *   enableCache: true,
 *   cacheSize: 200,
 *   enablePrefetch: true
 * });
 */
export function createDataLayer(state, options = {}) {
  return new DataLayer(state, options);
}

export default DataLayer;
