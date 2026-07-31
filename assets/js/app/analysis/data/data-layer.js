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
 * Data loading coverage (large dataset support):
 * This layer delegates all actual I/O to the core dataset loaders in
 * `cellucid/assets/js/data/data-loaders.js`, which cover:
 * - Points: `loadPointsBinary`
 * - Manifests: `loadObsManifest`, `loadVarManifest`, `loadConnectivityManifest`
 * - Fields: `loadObsFieldData`, `loadVarFieldData`
 * - Graph edges: `loadEdges`
 * - Dataset identity: `loadDatasetIdentity` (+ embeddings metadata helpers)
 * - Analysis payloads: `loadAnalysisBulkData`, `loadAnalysisBulkObsData`, `loadAnalysisSubset`
 * - Latents: `loadLatentEmbeddings`
 *
 * The Genes Panel feature relies specifically on:
 * - `ensureObsFieldLoaded()` → categorical obs codes/categories (grouping)
 * - `ensureGeneExpressionLoaded()` → per-gene per-cell Float32 arrays (streamed)
 *
 * @module data/data-layer
 */

import { LRUCache } from '../shared/lru-cache.js';
import { getNotificationCenter } from '../../notification-center.js';
import { getMemoryMonitor } from '../shared/memory-monitor.js';
import {
  isRestOfPageId,
  getBasePageIdFromRestOf,
  getRestOfPageName
} from '../shared/page-derivation-utils.js';
import {
  loadAnalysisBulkData,
  loadLatentEmbeddings,
  loadAnalysisBulkObsData
} from '../../../data/data-loaders.js';
import { setOwnDataProperty } from '../../../utils/exact-record.js';
import { filterFiniteNumbers } from '../shared/number-utils.js';
import { debugWarn } from '../shared/debug-utils.js';

// =============================================================================
// PAGE MEMBERSHIP DIGEST
// =============================================================================
//
// A page's cache identity is the *set* of its cell indices — never its
// cardinality and never a fixed-size sample of it. Two pages that differ by a
// single cell must produce different digests, so every index is folded in.
//
// The digest is emitted as 32 lowercase hex characters (four 32-bit lanes).
// Hex keeps the digest free of ':', ',', '|' and '@', which are the separators
// used by the cache key formats and by `invalidatePages()`.

/**
 * Finalizing 32-bit avalanche mix (MurmurHash3 `fmix32` constants).
 * @param {number} value
 * @returns {number} Well-mixed uint32
 */
function mixDigestLane(value) {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Create the four independent digest lanes with distinct offset bases.
 * @returns {Uint32Array}
 */
function createDigestLanes() {
  return new Uint32Array([0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]);
}

/**
 * Fold one 32-bit word into every lane.
 *
 * The lanes use different constructions (FNV-1a, a position-weighted
 * polynomial, an avalanche mix, and a shifted multiply) so that a collision
 * would have to occur in all four simultaneously.
 *
 * @param {Uint32Array} lanes
 * @param {number} word
 */
function foldDigestWord(lanes, word) {
  const w = word >>> 0;
  lanes[0] = Math.imul(lanes[0] ^ w, 0x01000193);
  lanes[1] = Math.imul(lanes[1], 0x27220a95) + w + 1;
  lanes[2] = mixDigestLane(lanes[2] ^ Math.imul(w + 0x9e3779b9, 0x85ebca6b));
  lanes[3] = Math.imul(lanes[3] ^ w, 0x1b873593) + (lanes[3] >>> 7);
}

/**
 * Fold an exact non-negative safe integer (both halves, so nothing is lost).
 * @param {Uint32Array} lanes
 * @param {number} value
 */
function foldDigestNumber(lanes, value) {
  foldDigestWord(lanes, value >>> 0);
  foldDigestWord(lanes, Math.floor(value / 0x100000000) >>> 0);
}

/**
 * Fold arbitrary text followed by a field separator.
 * @param {Uint32Array} lanes
 * @param {string} text
 */
function foldDigestText(lanes, text) {
  for (let i = 0; i < text.length; i++) {
    foldDigestWord(lanes, text.charCodeAt(i));
  }
  foldDigestWord(lanes, 0xffffffff);
}

/**
 * Fold the exact cell index set, then its cardinality as a separate field.
 * @param {Uint32Array} lanes
 * @param {ArrayLike<number>} cellIndices - Deduplicated, ascending index set.
 */
function foldDigestIndexSet(lanes, cellIndices) {
  const count = cellIndices.length;
  foldDigestNumber(lanes, count);
  for (let i = 0; i < count; i++) {
    foldDigestNumber(lanes, cellIndices[i]);
  }
}

/**
 * Emit the finalized digest.
 * @param {Uint32Array} lanes
 * @returns {string} 32 lowercase hex characters
 */
function finalizeDigest(lanes) {
  let out = '';
  for (let i = 0; i < lanes.length; i++) {
    out += mixDigestLane(lanes[i]).toString(16).padStart(8, '0');
  }
  return out;
}

/**
 * Digest the exact per-cell category-code assignment a grouped analysis was
 * computed over.
 *
 * Grouped analyses — marker discovery is the one that caches — are addressed by
 * observation-field key, but a field's codes can be rewritten in place while the
 * key stays the same: merging two categories and moving one to "unassigned" both
 * do exactly that to a user-defined field. The key therefore does not identify
 * the grouping, and a cache keyed on it alone would serve results computed for a
 * different partition of the same cells — a plausible answer to a question
 * nobody asked.
 *
 * Every code is folded, so two groupings differing in a single cell produce
 * different digests. Cardinality is folded as its own field, so a grouping is
 * never identified by how many cells it covers. The output is 32 lowercase hex
 * characters, which keeps it free of the separators the cache key formats use.
 *
 * @param {Uint16Array} codes - Per-cell category codes (65535 = missing)
 * @returns {string} 32 lowercase hex characters
 */
export function computeCategoryGroupingDigest(codes) {
  if (!(codes instanceof Uint16Array) || codes.length === 0) {
    throw new TypeError(
      'Category grouping digest requires a non-empty Uint16Array of per-cell codes'
    );
  }
  const lanes = createDigestLanes();
  foldDigestNumber(lanes, codes.length);
  for (let index = 0; index < codes.length; index++) {
    foldDigestWord(lanes, codes[index]);
  }
  return finalizeDigest(lanes);
}

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
 * @property {boolean} [noCache=false] - If true, bypass DataLayer caches for this call
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

    // Fast key->fieldIndex lookups (critical for streaming loaders).
    // Built lazily and treated as immutable for the lifetime of this DataLayer
    // instance (a new DataLayer is created per dataset/state).
    /** @type {Map<string, number>|null} */
    this._geneFieldIndexByKey = null;
    /** @type {Map<string, number>|null} */
    this._obsFieldIndexByKey = null;

    // LRU cache for page data (if enabled)
    this._dataCache = enableCache
      ? new LRUCache({ maxSize: cacheSize, maxAge: cacheMaxAge })
      : null;

    // Pending requests for deduplication
    this._pendingRequests = enableDedup ? new Map() : null;
    // Dataset identity invalidates returned data; cache identity invalidates only
    // publication. Keeping these generations separate lets an explicit cache
    // cleanup avoid corrupting or rejecting otherwise valid in-flight work.
    this._datasetGeneration = 0;
    this._cacheGeneration = 0;
    this._fieldLoadLifecycle = new AbortController();
    this._destroyed = false;
    this._destroyPromise = null;

    // Prefetch queue
    this._prefetchQueue = [];
    this._prefetchTimeout = null;

    // Bulk gene data cache (separate due to size)
    this._bulkGeneCache = new Map();
    this._bulkGeneCacheMaxAge = bulkCacheMaxAge;
    this._bulkGeneCacheMaxSize = bulkCacheMaxSize;
    this._bulkGeneCacheAccessOrder = [];
    this._bulkGeneCacheGeneration = 0;
    this._bulkGeneCacheReplacementOwner = null;

    // Page version tracking for cache correctness
    this._pageVersions = enableVersionTracking ? new Map() : null;

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

  // ===========================================================================
  // FAST FIELD INDEX LOOKUPS (PERFORMANCE-CRITICAL)
  // ===========================================================================

  /**
   * Build (or reuse) a geneKey -> var fieldIndex map.
   * @private
   */
  _getGeneFieldIndexMap() {
    if (this._geneFieldIndexByKey) return this._geneFieldIndexByKey;
    const fields = this.state?.varData?.fields || [];
    const map = new Map();
    for (let i = 0; i < fields.length; i++) {
      const key = fields[i]?.key;
      if (typeof key === 'string' && key.length > 0) {
        map.set(key, i);
      }
    }
    this._geneFieldIndexByKey = map;
    return map;
  }

  /**
   * Build (or reuse) an obsKey -> obs fieldIndex map.
   * @private
   */
  _getObsFieldIndexMap() {
    if (this._obsFieldIndexByKey) return this._obsFieldIndexByKey;
    const fields = this.state?.obsData?.fields || [];
    const map = new Map();
    for (let i = 0; i < fields.length; i++) {
      const key = fields[i]?.key;
      if (typeof key === 'string' && key.length > 0) {
        map.set(key, i);
      }
    }
    this._obsFieldIndexByKey = map;
    return map;
  }

  /**
   * Handle memory cleanup triggered by MemoryMonitor
   * Clears caches to free memory under pressure
   * @private
   */
  _handleMemoryCleanup() {
    const beforeMemory = this.estimateMemoryUsage();
    this._cacheGeneration += 1;
    this._bulkGeneCacheGeneration += 1;

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
        throw new TypeError(`Unknown variable type: ${String(type)}`);
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
    if (typeof this.state?.getHighlightPages !== 'function') {
      throw new TypeError('DataLayer state.getHighlightPages is required');
    }
    const pages = this.state.getHighlightPages();
    if (!Array.isArray(pages)) {
      throw new TypeError('DataLayer state.getHighlightPages must return an array');
    }
    return pages;
  }

  /**
   * Get the currently active highlight page ID.
   * Used by Quick Insights for "Dynamic" mode that follows the active page.
   * @returns {string|null}
   */
  getActiveHighlightPageId() {
    if (typeof this.state?.getActivePageId !== 'function') {
      throw new TypeError(
        'DataLayer state.getActivePageId is required as the active page owner'
      );
    }
    const pageId = this.state.getActivePageId();
    if (pageId !== null && (typeof pageId !== 'string' || pageId.length === 0)) {
      throw new TypeError('DataLayer active page ID must be a non-empty string or null');
    }
    return pageId;
  }

  /**
   * Get the current persistent color for a highlight page.
   * @param {string} pageId
   * @returns {string|null}
   */
  getPageColor(pageId) {
    if (typeof this.state?.getHighlightPageColor !== 'function') {
      throw new TypeError('DataLayer state.getHighlightPageColor is required');
    }
    const color = this.state.getHighlightPageColor(pageId);
    if (color !== null && (typeof color !== 'string' || color.length === 0)) {
      throw new TypeError('DataLayer page color must be a non-empty string or null');
    }
    return color;
  }

  /**
   * Set the persistent color for a highlight page.
   * @param {string} pageId
   * @param {string} color
   * @returns {boolean}
   */
  setPageColor(pageId, color) {
    if (typeof this.state?.setHighlightPageColor !== 'function') {
      throw new TypeError('DataLayer state.setHighlightPageColor is required');
    }
    return this.state.setHighlightPageColor(pageId, color);
  }

  /**
   * Get display information for a page ID (supports derived pages).
   *
   * @param {string} pageId
   * @returns {{ id: string, name: string, derived?: { kind: string, baseId: string } } | null}
   */
  getPageInfo(pageId) {
    if (!pageId) return null;

    if (isRestOfPageId(pageId)) {
      const baseId = getBasePageIdFromRestOf(pageId);
      const basePage = baseId ? (this.getPages().find(p => p.id === baseId) || null) : null;
      const baseName = basePage?.name || baseId || 'page';
      return {
        id: pageId,
        name: getRestOfPageName(baseName),
        derived: { kind: 'rest_of', baseId: baseId || '' }
      };
    }

    const page = this.getPages().find(p => p.id === pageId) || null;
    if (!page) return null;
    return { id: pageId, name: page.name };
  }

  /**
   * Get cell count for a page ID (supports derived pages).
   * Useful for UI display without needing to build large derived index arrays.
   *
   * @param {string} pageId
   * @returns {number}
   */
  getCellCountForPageId(pageId) {
    if (!pageId) return 0;

    if (isRestOfPageId(pageId)) {
      const baseId = getBasePageIdFromRestOf(pageId);
      const total = this.state?.pointCount || 0;
      const baseCount = baseId ? this.getCellCountForPageId(baseId) : 0;
      return Math.max(0, total - baseCount);
    }

    const page = this.getPages().find(p => p.id === pageId);
    if (!page) return 0;

    const indices = new Set();
    for (const group of (page.highlightedGroups || [])) {
      if (group.enabled === false) continue;
      if (!group.cellIndices) continue;
      for (const idx of group.cellIndices) {
        indices.add(idx);
      }
    }
    return indices.size;
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
    if (typeof pageId !== 'string' || pageId.length === 0) {
      throw new TypeError('pageId must be exact non-empty text');
    }

    // Derived "rest-of" page: complement of base page indices
    if (isRestOfPageId(pageId)) {
      const baseId = getBasePageIdFromRestOf(pageId);
      if (!baseId) return [];

      const total = this.state?.pointCount || 0;
      if (!Number.isFinite(total) || total <= 0) {
        debugWarn('DataLayer', `Cannot compute derived page indices without pointCount (pageId=${pageId})`);
        return [];
      }

      const baseIndices = this.getCellIndicesForPage(baseId);
      if (!baseIndices || baseIndices.length === 0) {
        // Rest-of empty base page => all cells
        const all = new Array(total);
        for (let i = 0; i < total; i++) all[i] = i;
        return all;
      }

      const complementCount = Math.max(0, total - baseIndices.length);
      if (complementCount === 0) return [];

      const complement = new Array(complementCount);
      let write = 0;
      let basePtr = 0;

      for (let i = 0; i < total; i++) {
        if (basePtr < baseIndices.length && baseIndices[basePtr] === i) {
          basePtr++;
          continue;
        }
        complement[write++] = i;
      }

      return complement;
    }

    const page = this.getPages().find(p => p.id === pageId);
    if (!page) {
      throw new Error(`Page not found: ${pageId}`);
    }

    // Collect all cell indices from enabled highlight groups
    const cellIndices = new Set();
    for (const group of (page.highlightedGroups || [])) {
      if (group.enabled === false) continue;
      if (!group.cellIndices) continue;
      for (const idx of group.cellIndices) {
        cellIndices.add(idx);
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
    const datasetGeneration = this._datasetGeneration;
    const lifecycle = this._fieldLoadLifecycle;
    if (!(lifecycle instanceof AbortController)) {
      throw new TypeError(
        'DataLayer field-load lifecycle owner must be an AbortController'
      );
    }
    this._requireCurrentDatasetGeneration(datasetGeneration);
    if (lifecycle.signal.aborted) {
      throw lifecycle.signal.reason;
    }

    if (field.loaded) return;

    // Always enter through DataState, even when a core load already exists.
    // Its shared loader registers this analysis call as an independent lease;
    // directly awaiting field._loadingPromise would let an unrelated UI abort
    // cancel the core while analysis still needs it.
    if (source === 'obs') {
      if (typeof this.state.ensureFieldLoaded !== 'function') {
        throw new Error('Observation field loader is unavailable');
      }
      await this.state.ensureFieldLoaded(fieldIndex, {
        signal: lifecycle.signal,
        silent
      });
      this._requireCurrentDatasetGeneration(datasetGeneration);
      if (
        lifecycle !== this._fieldLoadLifecycle
        || this.state.obsData?.fields?.[fieldIndex] !== field
      ) {
        throw this._createAnalysisDataInvalidationError(
          'a dataset lifecycle change'
        );
      }
      return;
    }
    if (source === 'var') {
      if (typeof this.state.ensureVarFieldLoaded !== 'function') {
        throw new Error('Gene field loader is unavailable');
      }
      await this.state.ensureVarFieldLoaded(fieldIndex, {
        signal: lifecycle.signal,
        silent
      });
      this._requireCurrentDatasetGeneration(datasetGeneration);
      if (
        lifecycle !== this._fieldLoadLifecycle
        || this.state.varData?.fields?.[fieldIndex] !== field
      ) {
        throw this._createAnalysisDataInvalidationError(
          'a dataset lifecycle change'
        );
      }
      return;
    }
    throw new TypeError(`Field source must be exactly "obs" or "var"; received ${String(source)}`);
  }

  // ===========================================================================
  // GENE FIELD LIFECYCLE (MEMORY CONTROL)
  // ===========================================================================

  /**
   * Ensure a gene expression field is loaded and return the raw per-cell values.
   * This is useful for streaming/low-memory analyses that want to avoid building
   * PageData objects and avoid repeated page-index computation.
   *
   * @param {string} geneKey
   * @param {Object} [options]
   * @param {boolean} [options.silent=true] - Suppress notifications
   * @returns {Promise<{ fieldIndex: number, values: ArrayLike<number>, wasLoaded: boolean }>}
   */
  async ensureGeneExpressionLoaded(geneKey, options = {}) {
    const { silent = true } = options;
    const datasetGeneration = this._datasetGeneration;
    this._requireCurrentDatasetGeneration(datasetGeneration);

    const fields = this.state.varData?.fields;
    if (!fields) {
      throw new Error('[DataLayer] No var fields available (gene expression disabled)');
    }

    const fieldIndex = this._getGeneFieldIndexMap().get(geneKey);
    if (typeof fieldIndex !== 'number') {
      throw new Error(`[DataLayer] Gene not found: ${geneKey}`);
    }

    const field = fields[fieldIndex];
    if (!field) {
      throw new Error(`[DataLayer] Var field not found for gene: ${geneKey}`);
    }

    const wasLoaded = !!field.loaded;
    await this._ensureFieldLoaded(field, fieldIndex, 'var', { silent });
    this._requireCurrentDatasetGeneration(datasetGeneration);
    if (
      this.state.varData?.fields !== fields
      || fields[fieldIndex] !== field
    ) {
      throw this._createAnalysisDataInvalidationError(
        'a dataset lifecycle change'
      );
    }

    return { fieldIndex, values: field.values, wasLoaded };
  }

  /**
   * Unload a loaded gene expression field to free memory.
   *
   * @param {string} geneKey
   * @param {Object} [options]
   * @param {boolean} [options.preserveActive=true] - If true, do not unload an active gene field
   * @returns {boolean} True if unloaded
   */
  unloadGeneExpression(geneKey, options = {}) {
    const fieldIndex = this._getGeneFieldIndexMap().get(geneKey);
    if (typeof fieldIndex !== 'number') return false;
    if (typeof this.state.unloadVarField !== 'function') return false;
    return this.state.unloadVarField(fieldIndex, options);
  }

  /**
   * Ensure an observation field is loaded and return its data.
   * For categorical fields, returns codes and categories arrays.
   * For continuous fields, returns values array.
   *
   * @param {string} obsKey - Observation field key (e.g., 'cell_type')
   * @param {Object} [options]
   * @param {boolean} [options.silent=true] - Suppress notifications
   * @returns {Promise<{ fieldIndex: number, kind: string, codes?: Uint16Array, categories?: string[], values?: Float32Array, colors?: Object }>}
   */
  async ensureObsFieldLoaded(obsKey, options = {}) {
    const { silent = true } = options;
    const datasetGeneration = this._datasetGeneration;
    this._requireCurrentDatasetGeneration(datasetGeneration);

    const obsData = this.state.obsData;
    if (!obsData || !obsData.fields) {
      throw new Error(`[DataLayer] No observation data available`);
    }

    const fieldIndex = this._getObsFieldIndexMap().get(obsKey);
    if (typeof fieldIndex !== 'number') {
      throw new Error(`[DataLayer] Observation field not found: ${obsKey}`);
    }

    const field = obsData.fields[fieldIndex];
    await this._ensureFieldLoaded(field, fieldIndex, 'obs', { silent });
    this._requireCurrentDatasetGeneration(datasetGeneration);
    if (
      this.state.obsData !== obsData
      || obsData.fields[fieldIndex] !== field
    ) {
      throw this._createAnalysisDataInvalidationError(
        'a dataset lifecycle change'
      );
    }

    if (field.kind === 'category') {
      return {
        fieldIndex,
        kind: 'category',
        codes: field.codes,
        categories: field.categories || [],
        colors: field.colors || {}
      };
    } else {
      return {
        fieldIndex,
        kind: 'continuous',
        values: field.values
      };
    }
  }

  /**
   * Invalidate cached PageData entries for a specific variable.
   * Useful after unloading a field to ensure no large arrays remain referenced by caches.
   *
   * @param {DataType} type
   * @param {string} variableKey
   */
  invalidateVariable(type, variableKey) {
    if (!this._dataCache) return;
    const prefix = `${type}:${variableKey}:`;
    for (const key of this._dataCache.keys()) {
      if (key.startsWith(prefix)) {
        this._dataCache.delete(key);
      }
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
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Page-data fetch options must be an object');
    }
    const {
      type,
      variableKey,
      pageIds: requestedPageIds,
      silent = false,
      noCache = false
    } = options;
    const pageIds = Array.isArray(requestedPageIds)
      ? [...requestedPageIds]
      : requestedPageIds;
    const ownedOptions = {
      ...options,
      type,
      variableKey,
      pageIds,
      silent,
      noCache
    };
    const datasetGeneration = this._datasetGeneration;
    const cacheGeneration = this._cacheGeneration;
    this._requireCurrentDatasetGeneration(datasetGeneration);

    if (!pageIds || pageIds.length === 0) {
      return [];
    }

    // Keep cache keys correct as highlight pages change.
    // Without refreshing page versions, cached results can become stale and plots lag behind
    // (e.g., a newly created page remains "empty" in analysis until another page change occurs).
    const uniquePageIds = Array.from(new Set(pageIds));
    this.refreshPageVersions(uniquePageIds.filter(id => !isRestOfPageId(id)));

    // Check cache first (if enabled)
    if (this._dataCache && !noCache) {
      const cacheKey = this._getCacheKey(ownedOptions);

      if (this._dataCache.has(cacheKey)) {
        return this._dataCache.get(cacheKey);
      }

      // Check for pending request (deduplication)
      if (this._pendingRequests && this._pendingRequests.has(cacheKey)) {
        return this._pendingRequests.get(cacheKey);
      }

      // Create new request
      const requestPromise = this._fetchDataForPages(
        ownedOptions,
        datasetGeneration
      );

      if (this._pendingRequests) {
        this._pendingRequests.set(cacheKey, requestPromise);
      }

      try {
        const result = await requestPromise;
        this._requireCurrentDatasetGeneration(datasetGeneration);
        if (this._cacheGeneration === cacheGeneration) {
          this._dataCache.set(cacheKey, result);
        }
        return result;
      } finally {
        if (this._pendingRequests?.get(cacheKey) === requestPromise) {
          this._pendingRequests.delete(cacheKey);
        }
      }
    }

    // No caching, fetch directly
    const result = await this._fetchDataForPages(
      ownedOptions,
      datasetGeneration
    );
    this._requireCurrentDatasetGeneration(datasetGeneration);
    return result;
  }

  _requireCurrentDatasetGeneration(generation) {
    if (
      this._destroyed ||
      generation !== this._datasetGeneration
    ) {
      throw this._createAnalysisDataInvalidationError(
        'a dataset lifecycle change'
      );
    }
  }

  /**
   * Create the one exact error contract used for invalidated analysis reads.
   * @param {string} reason
   * @returns {Error & {code: string}}
   * @private
   */
  _createAnalysisDataInvalidationError(reason) {
    const error = new Error(
      `Analysis data request was invalidated by ${reason}`
    );
    error.code = 'ANALYSIS_DATA_REQUEST_INVALIDATED';
    return error;
  }

  /**
   * Internal fetch implementation (without caching)
   * @param {FetchOptions} options - Fetch options
   * @param {boolean} [options.silent=false] - Suppress loading notifications
   * @returns {Promise<PageData[]>}
   * @private
   */
  async _fetchDataForPages(
    options,
    datasetGeneration = this._datasetGeneration
  ) {
    const { type, variableKey, pageIds, silent = false } = options;
    this._requireCurrentDatasetGeneration(datasetGeneration);

    // Get the variable info and field
    const variableInfo = this.getVariableInfo(type, variableKey);
    if (!variableInfo) {
      throw new Error(
        `Variable not found: ${String(variableKey)} (type: ${String(type)})`
      );
    }

    // Get the source and field
    const source = type === 'gene_expression' ? 'var' : 'obs';
    const fields = source === 'var'
      ? this.state.varData?.fields
      : this.state.obsData?.fields;

    if (!fields) {
      throw new Error(`No ${source} fields are available`);
    }

    const fieldIndex = variableInfo._fieldIndex;
    const field = fields[fieldIndex];

    if (!field) {
      throw new Error(`Field not found at index ${String(fieldIndex)}`);
    }

    // Ensure field is loaded - show notification if not already loaded (unless silent)
    let loadingNotificationId = null;
    let loadStartTime = null;
    const MIN_NOTIFICATION_DURATION = 800; // Minimum time to show notification (ms)

    const notifications = this._notifications;
    if (!field.loaded && notifications && !silent) {
      loadStartTime = performance.now();
      loadingNotificationId = notifications.show({
        type: 'loading',
        category: 'data',
        message: `Loading ${variableKey}...`
      });
    }

    try {
      await this._ensureFieldLoaded(field, fieldIndex, source);
    } finally {
      if (loadingNotificationId && notifications) {
        // Ensure notification is visible for minimum duration
        const elapsed = performance.now() - loadStartTime;
        const remainingTime = MIN_NOTIFICATION_DURATION - elapsed;

        if (remainingTime > 0) {
          setTimeout(() => {
            notifications.dismiss(loadingNotificationId);
          }, remainingTime);
        } else {
          notifications.dismiss(loadingNotificationId);
        }
      }
    }
    this._requireCurrentDatasetGeneration(datasetGeneration);

    // Get values array
    const rawValues = field.kind === 'category'
      ? field.codes
      : field.values;

    if (!rawValues || rawValues.length === 0) {
      throw new Error(`No values are available for field: ${variableKey}`);
    }

    // Categories for decoding (if categorical)
    const categories = field.categories || [];

    // Process each page
    const results = [];

    for (const pageId of pageIds) {
      const pageInfo = this.getPageInfo(pageId);
      if (!pageInfo) {
        throw new Error(`Page not found: ${pageId}`);
      }

      const cellIndices = this.getCellIndicesForPage(pageId);

      if (cellIndices.length === 0) {
        results.push({
          pageId,
          pageName: pageInfo.name,
          variableInfo: { ...variableInfo },
          values: [],
          cellIndices: [],
          cellCount: 0
        });
        continue;
      }

      // Extract values for cells in this page
      const values = [];
      const exactIndices = [];

      for (const idx of cellIndices) {
        if (
          !Number.isSafeInteger(idx) ||
          idx < 0 ||
          idx >= rawValues.length
        ) {
          throw new RangeError(
            `Cell index ${String(idx)} is outside field "${variableKey}" ` +
            `length ${rawValues.length}`
          );
        }
        let value = rawValues[idx];
        if (field.kind === 'category') {
          if (!Number.isSafeInteger(value) || value < 0) {
            throw new TypeError(
              `Category code at cell ${idx} for "${variableKey}" must be a non-negative integer`
            );
          }
          if (value === 65_535) {
            value = null;
          } else if (value >= categories.length) {
            throw new RangeError(
              `Category code ${value} for "${variableKey}" is outside ` +
              `${categories.length} categories`
            );
          } else {
            value = categories[value];
          }
        } else if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new TypeError(
            `Continuous value at cell ${idx} for "${variableKey}" must be finite`
          );
        }
        values.push(value);
        exactIndices.push(idx);
      }

      results.push({
        pageId,
        pageName: pageInfo.name,
        variableInfo: {
          ...variableInfo,
          categories: field.kind === 'category' ? categories : undefined
        },
        values,
        cellIndices: exactIndices,
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
      const validValues = filterFiniteNumbers(allValues);

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
        setOwnDataProperty(counts, cat, 0);
      }
      for (const value of pd.values) {
        counts[value] += 1;
      }
      setOwnDataProperty(result.pages, pd.pageId, {
        name: pd.pageName,
        counts,
        total: pd.cellCount
      });
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

    // Include page version digests for cache correctness
    if (this._pageVersions) {
      return `${type}:${variableKey}:${sortedPageIds.join(',')}`
        + `:v=${this._buildVersionKey(sortedPageIds)}`;
    }

    return `${type}:${variableKey}:${sortedPageIds.join(',')}`;
  }

  /**
   * Build the version component shared by every cache key format.
   *
   * Each page contributes its *complete* version digest as `pageId@digest`.
   * Nothing is sampled and nothing is truncated, so pages whose cell sets
   * differ can never collapse onto the same component — including cell sets of
   * identical cardinality.
   *
   * @param {string[]} sortedPageIds - Page IDs, already sorted and unique
   * @returns {string} A ':'-free version component
   * @private
   */
  _buildVersionKey(sortedPageIds) {
    return sortedPageIds.map(pageId => {
      const hash = this._getPageVersion(pageId);
      const separator = hash.indexOf(':');
      return separator === -1
        ? `${pageId}@${hash}`
        : `${hash.slice(0, separator)}@${hash.slice(separator + 1)}`;
    }).join('|');
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
   * Compute the exact version hash for a page.
   *
   * The hash is `pageId:digest`, where the digest covers the page name and
   * *every* cell index in the page's exact (deduplicated, ascending) index set
   * — the same set analysis results are computed over. Nothing is sampled, so
   * a page whose membership changes always changes its hash, even when its
   * cell count is unchanged.
   *
   * @param {string} pageId - Page ID
   * @returns {string} `pageId:digest`
   * @private
   */
  _computePageHash(pageId) {
    const lanes = createDigestLanes();

    if (isRestOfPageId(pageId)) {
      // A derived "rest of" page is the exact complement of its base page
      // within the dataset, so its identity is fully determined by the base
      // page's version and the dataset size. Deriving it keeps the derived
      // version exact without materialising the complement.
      const baseId = getBasePageIdFromRestOf(pageId);
      foldDigestText(lanes, baseId ? this._getPageVersion(baseId) : '');
      foldDigestNumber(lanes, this.state?.pointCount || 0);
      return `${pageId}:${finalizeDigest(lanes)}`;
    }

    const pageName = this.getPages().find(p => p.id === pageId)?.name || '';
    foldDigestText(lanes, pageName);
    foldDigestIndexSet(lanes, this.getCellIndicesForPage(pageId));
    return `${pageId}:${finalizeDigest(lanes)}`;
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

    // Derived pages are not stored in the version map; their exact version is
    // derived from the base page's version on demand.
    if (isRestOfPageId(pageId)) {
      return this._computePageHash(pageId);
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

    const idsToRefresh = (pageIds || this.getPages().map(p => p.id))
      .filter(id => !isRestOfPageId(id));

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
    this._cacheGeneration += 1;
    this._bulkGeneCacheGeneration += 1;
    if (this._pendingRequests !== null) {
      this._pendingRequests.clear();
    }

    const pageIdSet = new Set(uniquePageIds);

    // Both cache key formats end with the page IDs, optionally followed by a
    // ':v=' version component:
    //   data cache: type:variableKey:page_1,page_2[:v=...]
    //   bulk genes: bulk_genes:page_1,page_2[:v=...]
    const keyReferencesAnyPage = (key) => {
      if (!key) return false;

      const parts = key.split(':');
      if (parts.length < 2) return false;

      const last = parts[parts.length - 1];
      const pageIdsPart = last.startsWith('v=') ? parts[parts.length - 2] : last;
      const ids = (pageIdsPart || '').split(',').filter(Boolean);
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
    this._cacheGeneration += 1;
    if (this._pendingRequests !== null) {
      this._pendingRequests.clear();
    }
    this._variableCache.clear();
    if (this._dataCache) {
      this._dataCache.clear();
    }
  }

  /**
   * Clear only the bulk gene cache (largest memory consumer).
   * Useful after gene-heavy analyses that shouldn't keep multi-gene page caches alive.
   */
  clearBulkGeneCache() {
    this._bulkGeneCacheGeneration += 1;
    this._bulkGeneCache.clear();
    this._bulkGeneCacheAccessOrder = [];
  }

  /**
   * Clear all caches including bulk gene cache
   */
  clearAllCaches() {
    this._cacheGeneration += 1;
    if (this._pendingRequests !== null) {
      this._pendingRequests.clear();
    }
    this._variableCache.clear();
    if (this._dataCache) {
      this._dataCache.clear();
    }
    this.clearBulkGeneCache();
    this._prefetchQueue = [];

    if (this._prefetchTimeout) {
      clearTimeout(this._prefetchTimeout);
      this._prefetchTimeout = null;
    }
  }

  /**
   * Reset internal state for an in-place dataset reload.
   *
   * Some flows (notably `local-user`) reload a new dataset into the same `DataState`
   * instance without a full page refresh. In those cases, any cached field-index
   * lookups and cached page data must be cleared to avoid cross-dataset cache hits.
   *
   */
  resetForDatasetReload() {
    if (this._destroyed) {
      throw new Error('Cannot reset a destroyed DataLayer.');
    }
    this._fieldLoadLifecycle.abort(
      this._createAnalysisDataInvalidationError(
        'a dataset lifecycle change'
      )
    );
    this._fieldLoadLifecycle = new AbortController();
    this._datasetGeneration += 1;
    this._bulkGeneCacheReplacementOwner = null;
    this.clearAllCaches();
    if (this._pendingRequests !== null) {
      this._pendingRequests.clear();
    }
    this._geneFieldIndexByKey = null;
    this._obsFieldIndexByKey = null;
    if (this._pageVersions !== null) {
      this._pageVersions.clear();
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
    if (
      this._destroyed ||
      !this._options.enablePrefetch ||
      !this._dataCache
    ) {
      return;
    }

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
    if (this._destroyed) {
      this._prefetchQueue = [];
      return;
    }

    const batch = this._prefetchQueue.splice(0, 3);

    for (const options of batch) {
      try {
        await this.getDataForPages(options);
      } catch (err) {
        if (!this._destroyed) {
          console.debug('[DataLayer] Prefetch failed:', err.message);
        }
      }
    }

    if (this._destroyed) {
      this._prefetchQueue = [];
    } else if (this._prefetchQueue.length > 0) {
      this._prefetchTimeout = setTimeout(() => {
        this._processPrefetchQueue();
      }, 500);
    }
  }

  // ===========================================================================
  // BULK GENE EXPRESSION LOADING
  // ===========================================================================

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
   *
   * Carries the same complete page version component as `_getCacheKey()`, so a
   * bulk-gene entry can never be served for a page whose cell membership has
   * changed since it was computed.
   *
   * @param {string[]} pageIds
   * @returns {string}
   * @private
   */
  _getBulkGeneCacheKey(pageIds) {
    const sortedUnique = Array.from(new Set(pageIds || [])).sort();
    const idsPart = sortedUnique.join(',');

    if (this._pageVersions) {
      return `bulk_genes:${idsPart}:v=${this._buildVersionKey(sortedUnique)}`;
    }

    return `bulk_genes:${idsPart}`;
  }

  // ===========================================================================
  // SESSION CACHE EXPORT/IMPORT (for session bundles)
  // ===========================================================================

  /**
   * Replace the bulk session cache transactionally without copying retained
   * scientific arrays. Rollback restores the exact prior Map and LRU order
   * identities; a successful transaction releases them with its owner.
   *
   * @returns {Readonly<{commit: () => void, rollback: () => void}>}
   */
  beginSessionCacheReplacement() {
    if (this._bulkGeneCacheReplacementOwner !== null) {
      throw new Error(
        'A session cache replacement is already active.'
      );
    }
    const previousCache = this._bulkGeneCache;
    const previousAccessOrder = this._bulkGeneCacheAccessOrder;
    const replacementOwner = {};
    const datasetGeneration = this._datasetGeneration;
    this._bulkGeneCacheReplacementOwner = replacementOwner;
    this._bulkGeneCacheGeneration += 1;
    this._bulkGeneCache = new Map();
    this._bulkGeneCacheAccessOrder = [];
    let committed = false;
    let rolledBack = false;
    const requireCurrentLifecycle = () => {
      if (
        this._destroyed ||
        this._datasetGeneration !== datasetGeneration
      ) {
        throw new Error(
          'Session cache replacement was invalidated by a dataset lifecycle change.'
        );
      }
    };

    return Object.freeze({
      commit: () => {
        if (committed || rolledBack) return;
        requireCurrentLifecycle();
        if (this._bulkGeneCacheReplacementOwner !== replacementOwner) {
          throw new Error(
            'Session cache replacement ownership changed before commit.'
          );
        }
        this._bulkGeneCacheReplacementOwner = null;
        this._bulkGeneCacheGeneration += 1;
        committed = true;
      },
      rollback: () => {
        if (rolledBack) return;
        requireCurrentLifecycle();
        if (
          this._bulkGeneCacheReplacementOwner !== null
          && this._bulkGeneCacheReplacementOwner !== replacementOwner
        ) {
          throw new Error(
            'Session cache replacement cannot roll back across a newer owner.'
          );
        }
        this._bulkGeneCache = previousCache;
        this._bulkGeneCacheAccessOrder = previousAccessOrder;
        this._bulkGeneCacheReplacementOwner = null;
        this._bulkGeneCacheGeneration += 1;
        rolledBack = true;
      }
    });
  }

  /**
   * Export portable analysis caches for inclusion in a session bundle.
   *
   * IMPORTANT:
   * - This API intentionally avoids exposing private cache internals directly.
   * - Callers (session contributors) are responsible for chunking/encoding.
   * - Dev-phase: we currently export the bulk gene cache only (the largest, most
   *   expensive-to-recompute analysis cache in typical workflows).
   *
   * @returns {Array<{ kind: 'bulk-gene', cacheKey: string, gene: string, pageId: string, pageName: string, cellCount: number, timestamp: number, geneCount: number, values: Float32Array, cellIndices: Uint32Array }>}
   */
  exportSessionCache() {
    /** @type {Array<{ kind: 'bulk-gene', cacheKey: string, gene: string, pageId: string, pageName: string, cellCount: number, timestamp: number, geneCount: number, values: Float32Array, cellIndices: Uint32Array }>} */
    const artifacts = [];

    for (const [cacheKey, entry] of this._bulkGeneCache.entries()) {
      const ts = Number(entry?.timestamp ?? 0) || 0;
      const geneCount = Number(entry?.geneCount ?? 0) || 0;
      const data = entry?.data || null;
      if (!data || typeof data !== 'object') continue;

      for (const [gene, genePages] of Object.entries(data)) {
        if (!genePages || typeof genePages !== 'object') continue;

        for (const [pageId, pd] of Object.entries(genePages)) {
          const valuesIn = pd?.values;
          const indicesIn = pd?.cellIndices;
          if (!valuesIn || !indicesIn) continue;

          const cellCount = Number(pd?.cellCount ?? (Array.isArray(indicesIn) ? indicesIn.length : indicesIn.length)) || 0;
          const pageName = String(pd?.pageName || pageId);

          // Convert values to Float32Array (portable, compact, renderer-friendly).
          let values = valuesIn instanceof Float32Array ? valuesIn : null;
          if (!values) {
            const n = valuesIn.length >>> 0;
            values = new Float32Array(n);
            for (let i = 0; i < n; i++) values[i] = Number(valuesIn[i] ?? NaN);
          }

          // Convert indices to Uint32Array.
          let cellIndices = indicesIn instanceof Uint32Array ? indicesIn : null;
          if (!cellIndices) {
            const n = indicesIn.length >>> 0;
            cellIndices = new Uint32Array(n);
            for (let i = 0; i < n; i++) cellIndices[i] = Number(indicesIn[i] ?? 0) >>> 0;
          }

          artifacts.push({
            kind: 'bulk-gene',
            cacheKey,
            gene,
            pageId,
            pageName,
            cellCount,
            timestamp: ts,
            geneCount,
            values,
            cellIndices
          });
        }
      }
    }

    return artifacts;
  }

  /**
   * Import a session cache artifact (or array of artifacts) into this DataLayer.
   *
   * This is used by the session-bundle lazy restore path to incrementally
   * populate caches without reaching into private fields from session code.
   *
   * @param {any} artifactOrArtifacts
   * @returns {number} Number of artifacts applied
   */
  importSessionCache(artifactOrArtifacts) {
    const artifacts = Array.isArray(artifactOrArtifacts) ? artifactOrArtifacts : [artifactOrArtifacts];
    let applied = 0;

    for (const artifact of artifacts) {
      if (!artifact || artifact.kind !== 'bulk-gene') continue;

      const cacheKey = String(artifact.cacheKey || '').trim();
      const gene = String(artifact.gene || '').trim();
      const pageId = String(artifact.pageId || '').trim();
      if (!cacheKey || !gene || !pageId) continue;

      const values = artifact.values instanceof Float32Array ? artifact.values : null;
      const cellIndices = artifact.cellIndices instanceof Uint32Array ? artifact.cellIndices : null;
      if (!values || !cellIndices) continue;

      const pageName = String(artifact.pageName || pageId);
      const cellCount = Number(artifact.cellCount ?? cellIndices.length) || cellIndices.length;
      const timestamp = Number(artifact.timestamp ?? Date.now()) || Date.now();
      const geneCount = Number(artifact.geneCount ?? 0) || 0;

      // Merge into the existing cache entry (or create one).
      const existing = this._bulkGeneCache.get(cacheKey);
      const entry = existing && typeof existing === 'object'
        ? existing
        : { data: {}, timestamp, geneCount };

      if (
        !Object.hasOwn(entry, 'data') ||
        !entry.data ||
        typeof entry.data !== 'object'
      ) {
        entry.data = {};
      }
      let genePages;
      if (
        Object.hasOwn(entry.data, gene) &&
        entry.data[gene] &&
        typeof entry.data[gene] === 'object'
      ) {
        genePages = entry.data[gene];
      } else {
        genePages = {};
        setOwnDataProperty(entry.data, gene, genePages);
      }

      setOwnDataProperty(genePages, pageId, {
        values,
        cellIndices,
        pageName,
        cellCount
      });

      // Preserve the newest timestamp/geneCount seen for the entry.
      entry.timestamp = Math.max(Number(entry.timestamp ?? 0) || 0, timestamp);
      entry.geneCount = Math.max(
        Number(entry.geneCount ?? 0) || 0,
        geneCount,
        Object.keys(entry.data || {}).length
      );

      // Use the canonical setter so eviction/access order are maintained.
      this._setBulkGeneCache(cacheKey, entry);
      applied += 1;
    }

    return applied;
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
   * @param {Function} [options.isCurrent] - Cooperative request ownership predicate
   * @param {Function} [options.registerInvalidationCleanup] - Required when isCurrent is provided
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
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Bulk gene fetch options must be an object');
    }
    const {
      pageIds: requestedPageIds,
      geneList: requestedGeneList = null,
      forceReload = false,
      onProgress,
      isCurrent: currentPredicate,
      registerInvalidationCleanup
    } = options;
    const hasCooperativeOwner = currentPredicate !== undefined;
    if (hasCooperativeOwner && typeof currentPredicate !== 'function') {
      throw new TypeError(
        'Bulk gene fetch isCurrent must be a function when provided'
      );
    }
    if (
      hasCooperativeOwner &&
      typeof registerInvalidationCleanup !== 'function'
    ) {
      throw new TypeError(
        'Bulk gene fetch registerInvalidationCleanup must be a function ' +
        'when isCurrent is provided'
      );
    }
    if (
      !hasCooperativeOwner &&
      registerInvalidationCleanup !== undefined
    ) {
      throw new TypeError(
        'Bulk gene fetch registerInvalidationCleanup requires isCurrent'
      );
    }
    const pageIds = Array.isArray(requestedPageIds)
      ? [...requestedPageIds]
      : requestedPageIds;
    const geneList = Array.isArray(requestedGeneList)
      ? [...requestedGeneList]
      : requestedGeneList;
    const datasetGeneration = this._datasetGeneration;
    const cacheGeneration = this._bulkGeneCacheGeneration;
    const notifications = this._notifications;
    let ownershipInvalidated = false;
    let notificationId = null;
    let notificationSettled = false;

    const settleNotification = (method, message) => {
      if (notificationSettled) return;
      notificationSettled = true;
      if (
        notifications === null ||
        notifications === undefined ||
        notificationId === null
      ) {
        return;
      }
      notifications[method](notificationId, message);
    };
    const requireCurrentOwnership = () => {
      this._requireCurrentDatasetGeneration(datasetGeneration);
      if (
        ownershipInvalidated ||
        (hasCooperativeOwner && !currentPredicate())
      ) {
        throw this._createAnalysisDataInvalidationError(
          'an analysis request ownership change'
        );
      }
    };

    if (hasCooperativeOwner) {
      registerInvalidationCleanup(() => {
        ownershipInvalidated = true;
        settleNotification('dismiss');
      });
    }
    requireCurrentOwnership();

    if (!pageIds || pageIds.length === 0) {
      return {};
    }

    // Ensure bulk gene cache stays correct as highlight pages change.
    // (If versions are stale, bulk caches can return results for an old page membership.)
    this.refreshPageVersions(Array.from(new Set(pageIds)).filter(id => !isRestOfPageId(id)));

    const cacheKey = this._getBulkGeneCacheKey(pageIds);

    // Check cache
    if (!forceReload) {
      const cached = this._getBulkGeneCache(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < this._bulkGeneCacheMaxAge) {
        requireCurrentOwnership();
        if (geneList) {
          const missingGenes = geneList.filter(
            gene => !Object.hasOwn(cached.data, gene)
          );
          if (missingGenes.length > 0) {
            throw new Error(
              `Cached bulk gene data is missing requested genes: ${missingGenes.join(', ')}`
            );
          }
          const filtered = {};
          for (const gene of geneList) {
            setOwnDataProperty(filtered, gene, cached.data[gene]);
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
    if (notifications) {
      notificationId = notifications.show({
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

        requireCurrentOwnership();
        if (notifications && notificationId !== null) {
          notifications.updateProgress(notificationId, progress, {
            message: `Loading genes ${i + 1}-${Math.min(i + batchSize, genesToFetch.length)} of ${genesToFetch.length}...`
          });
        }

        if (onProgress) {
          onProgress(progress);
        }

        await Promise.all(batch.map(async (geneInfo) => {
          requireCurrentOwnership();
          const geneData = await this.getDataForPages({
            type: 'gene_expression',
            variableKey: geneInfo.key,
            pageIds,
            silent: true // Suppress individual notifications during bulk load
          });
          requireCurrentOwnership();

          const genePages = {};
          setOwnDataProperty(results, geneInfo.key, genePages);
          for (const pd of geneData) {
            setOwnDataProperty(genePages, pd.pageId, {
              values: pd.values,
              cellIndices: pd.cellIndices,
              pageName: pd.pageName,
              cellCount: pd.cellCount
            });
          }
        }));
        requireCurrentOwnership();

        // Yield to event loop
        await new Promise(resolve => setTimeout(resolve, 0));
        requireCurrentOwnership();
      }

      requireCurrentOwnership();
      if (
        this._bulkGeneCacheReplacementOwner === null
        && this._bulkGeneCacheGeneration === cacheGeneration
      ) {
        this._setBulkGeneCache(cacheKey, {
          data: results,
          timestamp: Date.now(),
          geneCount: genesToFetch.length
        });
      }

      const duration = performance.now() - startTime;
      requireCurrentOwnership();
      settleNotification(
        'complete',
        `Loaded ${genesToFetch.length} genes (${(duration / 1000).toFixed(1)}s)`
      );

      return results;

    } catch (error) {
      if (
        error?.code === 'ANALYSIS_DATA_REQUEST_INVALIDATED'
      ) {
        settleNotification('dismiss');
      } else {
        settleNotification(
          'fail',
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
   * @param {Object} [options] - Cooperative request ownership
   * @param {Function} [options.isCurrent] - Exact request ownership predicate
   * @param {Function} [options.registerInvalidationCleanup] - Required with isCurrent
   * @returns {Promise<Object>} Gene data by gene name
   */
  async getGeneExpressionSubset(geneList, pageIds, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Gene expression subset options must be an object');
    }
    const {
      isCurrent: currentPredicate,
      registerInvalidationCleanup
    } = options;
    const hasCooperativeOwner = currentPredicate !== undefined;
    if (hasCooperativeOwner && typeof currentPredicate !== 'function') {
      throw new TypeError(
        'Gene expression subset isCurrent must be a function when provided'
      );
    }
    if (
      hasCooperativeOwner &&
      typeof registerInvalidationCleanup !== 'function'
    ) {
      throw new TypeError(
        'Gene expression subset registerInvalidationCleanup must be a function ' +
        'when isCurrent is provided'
      );
    }
    if (
      !hasCooperativeOwner &&
      registerInvalidationCleanup !== undefined
    ) {
      throw new TypeError(
        'Gene expression subset registerInvalidationCleanup requires isCurrent'
      );
    }
    const ownedGeneList = Array.isArray(geneList)
      ? [...geneList]
      : geneList;
    const ownedPageIds = Array.isArray(pageIds)
      ? [...pageIds]
      : pageIds;
    const datasetGeneration = this._datasetGeneration;
    let ownershipInvalidated = false;
    const requireCurrentOwnership = () => {
      this._requireCurrentDatasetGeneration(datasetGeneration);
      if (
        ownershipInvalidated ||
        (hasCooperativeOwner && !currentPredicate())
      ) {
        throw this._createAnalysisDataInvalidationError(
          'an analysis request ownership change'
        );
      }
    };
    if (hasCooperativeOwner) {
      registerInvalidationCleanup(() => {
        ownershipInvalidated = true;
      });
    }
    requireCurrentOwnership();

    // This path can return cached expression values directly, so its key must
    // be built from current page versions rather than the last-refreshed ones.
    this.refreshPageVersions(
      Array.from(new Set(ownedPageIds)).filter(id => !isRestOfPageId(id))
    );

    const cacheKey = this._getBulkGeneCacheKey(ownedPageIds);
    const cached = this._getBulkGeneCache(cacheKey);

    if (cached && (Date.now() - cached.timestamp) < this._bulkGeneCacheMaxAge) {
      const results = {};
      for (const gene of ownedGeneList) {
        requireCurrentOwnership();
        if (Object.hasOwn(cached.data, gene)) {
          setOwnDataProperty(results, gene, cached.data[gene]);
        } else {
          const geneData = await this.getDataForPages({
            type: 'gene_expression',
            variableKey: gene,
            pageIds: ownedPageIds,
            silent: true
          });
          requireCurrentOwnership();

          const genePages = {};
          setOwnDataProperty(results, gene, genePages);
          for (const pd of geneData) {
            setOwnDataProperty(genePages, pd.pageId, {
              values: pd.values,
              cellIndices: pd.cellIndices,
              pageName: pd.pageName,
              cellCount: pd.cellCount
            });
          }
        }
      }
      requireCurrentOwnership();
      return results;
    }

    const fetchOptions = {
      pageIds: ownedPageIds,
      geneList: ownedGeneList,
      forceReload: false
    };
    if (hasCooperativeOwner) {
      fetchOptions.isCurrent = currentPredicate;
      fetchOptions.registerInvalidationCleanup = registerInvalidationCleanup;
    }
    const result = await this.fetchBulkGeneExpression(fetchOptions);
    requireCurrentOwnership();
    return result;
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
      onProgress
    } = options;

    const startTime = performance.now();

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
      setOwnDataProperty(result.pageData, pageId, {
        name: page?.name || pageId,
        cellIndices,
        cellCount: cellIndices.length
      });
      result.stats.cellsTotal += cellIndices.length;
    }

    const needsLoad = genes && genes.length > 0;

    if (needsLoad) {
      const varManifest = this.state?.varManifest || null;
      const manifestUrl = this.state?.manifestUrl || null;

      if (varManifest && manifestUrl) {
        const bulkData = await loadAnalysisBulkData({
          manifestUrl,
          varManifest,
          geneList: genes,
          batchSize: 20,
          suppressNotifications: true,
          onProgress: (p) => {
            const adjustedProgress = includeLatent ? Math.round(p * 0.8) : p;
            if (onProgress) onProgress(adjustedProgress);
          }
        });

        for (const [geneName, values] of Object.entries(bulkData.genes)) {
          const genePages = {};
          setOwnDataProperty(result.genes, geneName, genePages);

          for (const pageId of pageIds) {
            const cellIndices = result.pageData[pageId].cellIndices;
            const pageValues = new Float32Array(cellIndices.length);

            for (let i = 0; i < cellIndices.length; i++) {
              const cellIdx = cellIndices[i];
              if (
                !Number.isSafeInteger(cellIdx) ||
                cellIdx < 0 ||
                cellIdx >= values.length
              ) {
                throw new RangeError(
                  `Page "${pageId}" cell index ${String(cellIdx)} is outside ` +
                  `gene "${geneName}" values length ${values.length}`
                );
              }
              pageValues[i] = values[cellIdx];
            }

            setOwnDataProperty(genePages, pageId, {
              values: pageValues,
              cellIndices,
              pageName: result.pageData[pageId].name,
              cellCount: cellIndices.length
            });
          }

          result.stats.genesLoaded++;
        }
      } else {
        await this._loadGenesSequentially(genes, pageIds, result);
      }
    }

    // Load latent embeddings if requested
    if (includeLatent) {
      const baseUrl = this.state?.manifestUrl;
      const identity = this.state?.datasetIdentity;
      if (
        typeof baseUrl !== 'string' ||
        baseUrl.length === 0 ||
        !identity ||
        typeof identity !== 'object' ||
        Array.isArray(identity)
      ) {
        throw new Error(
          'Requested latent data requires exact manifestUrl and datasetIdentity state'
        );
      }
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
          if (
            !Number.isSafeInteger(cellIdx) ||
            cellIdx < 0 ||
            cellIdx >= latentData.cellCount
          ) {
            throw new RangeError(
              `Page "${pageId}" cell index ${String(cellIdx)} is outside ` +
              `latent cell count ${latentData.cellCount}`
            );
          }
          for (let d = 0; d < dim; d++) {
            pageCoords[i * dim + d] = latentData.points[cellIdx * dim + d];
          }
        }

        setOwnDataProperty(result.latent.pages, pageId, {
          coordinates: pageCoords,
          cellCount: cellIndices.length
        });
      }

      if (onProgress) onProgress(100);
    }

    result.stats.loadTimeMs = performance.now() - startTime;
    return result;
  }

  /**
   * Load genes sequentially when no bulk manifest is available.
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
      const geneData = await this.getDataForPages({
        type: 'gene_expression',
        variableKey: gene,
        pageIds,
        silent: true
      });

      if (onProgress) {
        onProgress(Math.round(((i + 1) / totalGenes) * 100));
      }

      const genePages = {};
      setOwnDataProperty(result.genes, gene, genePages);
      for (const pd of geneData) {
        setOwnDataProperty(genePages, pd.pageId, {
          values: pd.values,
          cellIndices: pd.cellIndices,
          pageName: pd.pageName,
          cellCount: pd.cellCount
        });
      }
      result.stats.genesLoaded++;
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
    const {
      pageIds,
      obsFields,
      onProgress,
      subsetPages = true,
      includeCategoricalValues = true
    } = options || {};

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

    const publishField = (fieldKey, fieldData) => {
      if (
        fieldData === null ||
        typeof fieldData !== 'object' ||
        Array.isArray(fieldData)
      ) {
        throw new TypeError(
          `Observation field "${fieldKey}" must load as an object`
        );
      }
      const rawFieldValues = fieldData.kind === 'continuous'
        ? fieldData.values
        : fieldData.kind === 'category'
          ? fieldData.codes
          : null;
      if (
        fieldData.kind === 'continuous' &&
        !(rawFieldValues instanceof Float32Array)
      ) {
        throw new TypeError(
          `Continuous observation field "${fieldKey}" must load as Float32Array`
        );
      }
      if (
        fieldData.kind === 'category' &&
        (!(rawFieldValues instanceof Uint16Array) ||
          !Array.isArray(fieldData.categories))
      ) {
        throw new TypeError(
          `Categorical observation field "${fieldKey}" must load exact codes and categories`
        );
      }
      if (!rawFieldValues) {
        throw new TypeError(
          `Observation field "${fieldKey}" must declare the exact current kind`
        );
      }

      for (const pageId of pageIds) {
        for (const cellIdx of result.pageData[pageId].cellIndices) {
          if (
            !Number.isSafeInteger(cellIdx) ||
            cellIdx < 0 ||
            cellIdx >= rawFieldValues.length
          ) {
            throw new RangeError(
              `Cell index ${String(cellIdx)} is outside observation field ` +
              `"${fieldKey}" length ${rawFieldValues.length}`
            );
          }
          if (
            fieldData.kind === 'category' &&
            rawFieldValues[cellIdx] !== 65_535 &&
            rawFieldValues[cellIdx] >= fieldData.categories.length
          ) {
            throw new RangeError(
              `Category code ${rawFieldValues[cellIdx]} for observation field ` +
              `"${fieldKey}" is outside ${fieldData.categories.length} categories`
            );
          }
        }
      }

      const published = {
        kind: fieldData.kind,
        categories: fieldData.kind === 'category'
          ? fieldData.categories
          : null
      };
      if (!subsetPages) {
        if (fieldData.kind === 'continuous') {
          published.values = rawFieldValues;
        } else {
          published.codes = rawFieldValues;
        }
        setOwnDataProperty(result.fields, fieldKey, published);
        result.stats.fieldsLoaded++;
        return;
      }

      for (const pageId of pageIds) {
        const cellIndices = result.pageData[pageId].cellIndices;
        if (fieldData.kind === 'continuous') {
          const pageValues = new Float32Array(cellIndices.length);
          for (let i = 0; i < cellIndices.length; i++) {
            pageValues[i] = rawFieldValues[cellIndices[i]];
          }
          setOwnDataProperty(published, pageId, {
            values: pageValues,
            cellCount: cellIndices.length
          });
          continue;
        }

        const pageCodes = new Uint16Array(cellIndices.length);
        for (let i = 0; i < cellIndices.length; i++) {
          pageCodes[i] = rawFieldValues[cellIndices[i]];
        }
        const pageEntry = {
          codes: pageCodes,
          cellCount: cellIndices.length
        };
        if (includeCategoricalValues) {
          const pageValues = [];
          for (const code of pageCodes) {
            if (code === 65_535) {
              pageValues.push(null);
              continue;
            }
            if (code >= fieldData.categories.length) {
              throw new RangeError(
                `Category code ${code} for observation field "${fieldKey}" ` +
                `is outside ${fieldData.categories.length} categories`
              );
            }
            pageValues.push(fieldData.categories[code]);
          }
          pageEntry.values = pageValues;
        }
        setOwnDataProperty(published, pageId, pageEntry);
      }

      setOwnDataProperty(result.fields, fieldKey, published);
      result.stats.fieldsLoaded++;
    };

    // Get cell indices for each page
    for (const pageId of pageIds) {
      const cellIndices = this.getCellIndicesForPage(pageId);
      const page = this.getPages().find(p => p.id === pageId);
      setOwnDataProperty(result.pageData, pageId, {
        name: page?.name || pageId,
        cellIndices,
        cellCount: cellIndices.length
      });
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
        const bulkData = await loadAnalysisBulkObsData({
            manifestUrl,
            obsManifest,
            fieldList: obsFields,
            batchSize: 10,
            onProgress: handleProgress,
            // DataLayer already owns the progress notification for bulk loading.
            suppressNotifications: true
        });

        for (const fieldKey of obsFields) {
          if (!Object.hasOwn(bulkData.fields, fieldKey)) {
            throw new Error(
              `Bulk observation loader omitted requested field "${fieldKey}"`
            );
          }
          publishField(fieldKey, bulkData.fields[fieldKey]);
        }
      } else {
        await this._loadObsFieldsSequentially(
          obsFields,
          handleProgress,
          publishField
        );
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
   * Load obs fields sequentially when no bulk manifest is available.
   * @param {string[]} obsFields - Field keys to load
   * @param {Function} [onProgress] - Progress callback
   * @param {Function} publishField - Exact field publication callback
   * @private
   */
  async _loadObsFieldsSequentially(obsFields, onProgress, publishField) {
    const totalFields = obsFields.length;

    for (let i = 0; i < obsFields.length; i++) {
      const fieldKey = obsFields[i];
      const catFields = this.getAvailableVariables('categorical_obs');
      const continuousFields = this.getAvailableVariables('continuous_obs');
      const isCategorical = catFields.some(field => field.key === fieldKey);
      const isContinuous = continuousFields.some(field => field.key === fieldKey);
      if (isCategorical === isContinuous) {
        throw new Error(
          `Observation field "${fieldKey}" must have exactly one categorical ` +
          'or continuous declaration'
        );
      }
      const fieldData = await this.ensureObsFieldLoaded(
        fieldKey,
        { silent: true }
      );
      publishField(fieldKey, fieldData);

      if (onProgress) {
        onProgress(Math.round(((i + 1) / totalFields) * 100));
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
      setOwnDataProperty(result.pageData, pageId, {
        name: page?.name || pageId,
        cellIndices,
        cellCount: cellIndices.length
      });
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
      const baseUrl = this.state?.manifestUrl;
      const identity = this.state?.datasetIdentity;
      if (
        typeof baseUrl !== 'string' ||
        baseUrl.length === 0 ||
        !identity ||
        typeof identity !== 'object' ||
        Array.isArray(identity)
      ) {
        throw new Error(
          'Requested latent data requires exact manifestUrl and datasetIdentity state'
        );
      }
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
          if (
            !Number.isSafeInteger(cellIdx) ||
            cellIdx < 0 ||
            cellIdx >= latentData.cellCount
          ) {
            throw new RangeError(
              `Page "${pageId}" cell index ${String(cellIdx)} is outside ` +
              `latent cell count ${latentData.cellCount}`
            );
          }
          for (let d = 0; d < dim; d++) {
            pageCoords[i * dim + d] = latentData.points[cellIdx * dim + d];
          }
        }

        setOwnDataProperty(result.latent.pages, pageId, {
          coordinates: pageCoords,
          cellCount: cellIndices.length
        });
      }
      completedSteps++;
    }

    if (onProgress) onProgress(100);

    result.stats.loadTimeMs = performance.now() - startTime;
    return result;
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
    if (this._destroyPromise != null) return this._destroyPromise;
    this._destroyed = true;
    this._fieldLoadLifecycle.abort(
      this._createAnalysisDataInvalidationError(
        'DataLayer destruction'
      )
    );
    this._datasetGeneration += 1;
    this._cacheGeneration += 1;
    this._bulkGeneCacheGeneration += 1;
    this._bulkGeneCacheReplacementOwner = null;
    // Stop background admission immediately. Cache contents remain owned by
    // a running memory-pressure handler until unregister drains below, but no
    // timer may start new work against the terminal generation.
    this._prefetchQueue = [];
    if (this._prefetchTimeout !== null) {
      clearTimeout(this._prefetchTimeout);
      this._prefetchTimeout = null;
    }

    const memoryMonitor = this._memoryMonitor;
    const instanceId = this._instanceId;
    this._destroyPromise = Promise.resolve().then(async () => {
      let unregisterError = null;
      if (memoryMonitor && instanceId) {
        try {
          await memoryMonitor.unregisterCleanupHandler(instanceId);
        } catch (error) {
          unregisterError = error;
        }
      }

      // A running memory-pressure handler may still own these caches. Clear
      // them only after unregisterCleanupHandler() has drained that owner.
      if (this._dataCache) {
        this._dataCache.clear();
      }
      this._bulkGeneCache.clear();
      this._bulkGeneCacheAccessOrder = [];
      this._variableCache.clear();

      if (this._pendingRequests) {
        this._pendingRequests.clear();
      }

      this._notifications = null;
      this._memoryMonitor = null;

      console.debug('[DataLayer] Instance destroyed');
      if (unregisterError !== null) throw unregisterError;
    });
    void this._destroyPromise.catch(() => {});
    return this._destroyPromise;
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
