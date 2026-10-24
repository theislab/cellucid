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
 * - Whole gene columns for computations (sparse entries or a loaded field)
 * - Page version tracking for cache correctness
 * - Worker integration for heavy computations
 * - Notification center integration for user feedback
 *
 * Data loading coverage (large dataset support):
 * This layer delegates all actual I/O to the core dataset loaders in
 * `cellucid/assets/js/data/data-loaders.js`, which cover:
 * - Points: `loadPointsBinary`
 * - Field lists and graph summary: `loadObsFields`, `loadGeneList`, `loadConnectivitySummary`
 * - Fields: `loadObsFieldData`, `loadVarFieldData`
 * - Graph edges: `loadEdges`
 * - Dataset identity: `loadDatasetIdentity` (+ embeddings metadata helpers)
 *
 * The Genes Panel feature relies specifically on:
 * - `ensureObsFieldLoaded()` → categorical obs codes/categories (grouping)
 * - `readGeneColumn()` → one gene's sparse entries, or a loaded field's values (streamed)
 *
 * @module data/data-layer
 */

import { LRUCache } from '../shared/lru-cache.js';
import { getNotificationCenter } from '../../notification-center.js';
import { SharedWork, abortReasonOf, throwIfAborted } from '../../jobs/cancellable-job.js';
import { formatDuration } from '../../notification-center/formatters.js';
import { getMemoryMonitor } from '../shared/memory-monitor.js';
import {
  isRestOfPageId,
  getBasePageIdFromRestOf,
  getRestOfPageName
} from '../shared/page-derivation-utils.js';
import { setOwnDataProperty } from '../../../utils/exact-record.js';
import {
  isCategoricalCodes,
  missingCategoryCode
} from '../../../data/categorical-storage-contract.js';
import { debugWarn } from '../shared/debug-utils.js';
import { adoptCategoryCounts, categoryCounts } from '../shared/category-counts.js';
import {
  createSlicedYield,
  waitForAvailableSlot
} from '../shared/concurrency-utils.js';

// =============================================================================
// PARALLEL LOADING
// =============================================================================
//
// The fields a single analysis needs are independent of one another, and the
// AnnData reader reads those asked for together as one batch. Awaiting each
// one before asking for the next makes the wall clock the *sum* of the round
// trips on a remote file instead of the deepest one. Every field a request
// needs is asked for at once: the reader's fetch scheduler holds the reads to
// what the link carries (`backgroundConcurrency`, measured), which no number
// here could know.


/** An expression matrix (`X`, `raw`, `layer:<key>`) as results name it. */
function matrixName(matrix) {
  return matrix.startsWith('layer:') ? `layers['${matrix.slice('layer:'.length)}']` : matrix;
}

/**
 * A gene an expression matrix does not have, refused by name: `code`
 * `GENE_NOT_IN_MATRIX`, `gene` the key.
 *
 * @param {string} gene
 * @param {string} label - The matrix as its choice names it
 * @returns {RangeError}
 */
function geneNotInMatrixError(gene, label) {
  const error = new RangeError(`${gene} is not a gene of ${label}`);
  error.code = 'GENE_NOT_IN_MATRIX';
  error.gene = gene;
  return error;
}

/**
 * The categorical codes of an observation field, exactly as the field holds
 * them.
 *
 * Analysis reads codes at their own width (Uint8Array, Uint16Array or
 * Uint32Array) and asks each array for its missing code
 * (`missingCategoryCode`), so no field is copied to another width: a copy into
 * Uint16Array truncated every code above 65,535 of a uint32 field to another
 * category, and widened a uint8 field for nothing.
 *
 * @param {unknown} codes
 * @param {string} fieldKey
 * @returns {Uint8Array|Uint16Array|Uint32Array}
 */
function requireAnalysisCategoryCodes(codes, fieldKey) {
  if (!isCategoricalCodes(codes)) {
    throw new TypeError(
      `Categorical observation field "${fieldKey}" must hold Uint8Array, ` +
      'Uint16Array or Uint32Array codes'
    );
  }
  return codes;
}

/**
 * Drop cells whose category is missing (the page's `missingCode`) from
 * single-variable categorical page data, keeping `values`, `cellIndices` and
 * `cellCount` aligned. Missing values are excluded per variable: counts,
 * percentages and the categorical tests are computed over the cells that have
 * a category. A page with no missing cell is returned unchanged.
 *
 * @param {Array<{values: Uint8Array|Uint16Array|Uint32Array, categories: string[], missingCode: number, cellIndices: ArrayLike<number>, cellCount: number}>} pageData
 * @returns {Array<Object>}
 */
export function excludeMissingCategoricalValues(pageData) {
  if (!Array.isArray(pageData)) {
    throw new TypeError('Categorical page data must be an array');
  }
  return pageData.map((page, pageIndex) => {
    if (
      page === null
      || typeof page !== 'object'
      || !isCategoricalCodes(page.values)
      || !Array.isArray(page.categories)
      || !Number.isSafeInteger(page.missingCode)
      || page.cellIndices === null
      || typeof page.cellIndices !== 'object'
      || page.cellIndices.length !== page.values.length
    ) {
      throw new TypeError(
        `Categorical page ${pageIndex + 1} requires aligned codes, categories, ` +
        'missingCode and cellIndices'
      );
    }
    const counts = categoryCounts(page.values);
    const missing = counts.get(null) ?? 0;
    if (missing === 0) return page;
    const kept = page.values.length - missing;
    const values = new page.values.constructor(kept);
    const cellIndices = new Uint32Array(kept);
    let write = 0;
    for (let index = 0; index < page.values.length; index++) {
      const code = page.values[index];
      if (code === page.missingCode) continue;
      values[write] = code;
      cellIndices[write] = page.cellIndices[index];
      write++;
    }
    // The same counts without the missing label, in the same order.
    const keptCounts = new Map(counts);
    keptCounts.delete(null);
    adoptCategoryCounts(values, keptCounts);
    return {
      ...page,
      values,
      cellIndices,
      cellCount: kept
    };
  });
}

/**
 * The array type a page's continuous values are gathered into: the field's own
 * typed-array type, so each value is the exact number the field stores. A
 * categorical field decodes codes to category names, and a field held in a
 * plain array has no element type to keep; both gather into a plain array.
 *
 * @param {string} kind - Field kind
 * @param {ArrayLike<number>} rawValues - The field's per-cell values or codes
 * @returns {(new (length: number) => ArrayLike<number>)|null}
 */
function continuousPageValueStorage(kind, rawValues) {
  if (kind === 'category') return null;
  if (!ArrayBuffer.isView(rawValues) || rawValues instanceof DataView) return null;
  return rawValues.constructor;
}

/**
 * Byte budget of the page-data cache. Entry count alone does not bound it: one
 * entry holds a variable's values for every page it was read for, which is
 * 8 MB for a two-million-cell page of Float32 expression, so a hundred entries
 * could otherwise pin well over a gigabyte.
 */
const PAGE_DATA_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Bytes of per-cell values one cached `getDataForPages` result holds. Cell
 * index arrays are not counted: they are the page membership snapshots every
 * result for the same page shares. A plain array is counted at 8 bytes a slot,
 * and a record without values at none.
 *
 * @param {Array<{values: ArrayLike<unknown>}>} pageData
 * @returns {number}
 */
function pageDataValueBytes(pageData) {
  let bytes = 0;
  for (const page of pageData) {
    if (page?.values) bytes += arrayLikeBytes(page.values);
  }
  return bytes;
}

/**
 * Storage bytes of a per-cell array: a typed array's own byte length, or
 * 8 bytes a slot for a plain array.
 * @param {ArrayLike<unknown>} values
 * @returns {number}
 */
function arrayLikeBytes(values) {
  return ArrayBuffer.isView(values) ? values.byteLength : values.length * 8;
}

/**
 * Register a task with the slot gate without making the gate a second owner of
 * its rejection.
 *
 * `waitForAvailableSlot` races the set, so a rejected member would reject the
 * race *and* stay unhandled if the caller had already stopped waiting. The
 * guarded copy settles for the gate; the caller keeps and awaits the original.
 *
 * @param {Set<Promise<unknown>>} inFlight
 * @param {Promise<unknown>} task
 */
function trackSettlement(inFlight, task) {
  const guarded = task.then(() => {}, () => {});
  inFlight.add(guarded);
  void guarded.then(() => inFlight.delete(guarded));
}

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
 * @typedef {Object} PageMembershipRecord
 * @property {Object} page - The page object the record was derived from
 * @property {Object[]} groups - Its group list, by identity
 * @property {number} groupCount
 * @property {Array} structure - Per group: the group, its contributing
 *   `cellIndices` array (null when disabled or absent), and that array's length
 * @property {number[]} indices - The exact, deduplicated, ascending union
 * @property {string|null} digestName - Page name the digest was folded with
 * @property {string|null} digest - `pageId:digest`, or null until computed
 */

/**
 * @param {ArrayLike<number>} list
 * @param {number} total
 * @returns {boolean} Whether `list` holds strictly ascending safe integers
 *   inside `[0, total)`.
 */
function isAscendingIndexList(list, total) {
  let previous = -1;
  for (let i = 0; i < list.length; i++) {
    const index = list[i];
    if (!Number.isSafeInteger(index) || index <= previous || index >= total) {
      return false;
    }
    previous = index;
  }
  return true;
}

/**
 * The deduplicated, ascending union of several cell-index lists.
 *
 * A single list that is already strictly ascending is copied as is — a
 * category highlight is exactly that. Several lists, or an unordered one, are
 * united through a dataset-sized membership mask scanned in index order, which
 * is linear and runs no comparator. Lists carrying anything other than safe
 * integers inside the dataset (a page left over from before a reload) keep
 * the general set-and-sort union, so they are reported exactly as before.
 *
 * @param {ArrayLike<number>[]} lists
 * @param {number|undefined} pointCount
 * @returns {number[]}
 */
function collectSortedUnion(lists, pointCount) {
  if (lists.length === 0) return [];
  const total = Number.isSafeInteger(pointCount) && pointCount > 0
    ? pointCount
    : 0;
  if (lists.length === 1 && isAscendingIndexList(lists[0], total)) {
    return Array.from(lists[0]);
  }

  const mask = new Uint8Array(total);
  let count = 0;
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const index = list[i];
      if (!Number.isSafeInteger(index) || index < 0 || index >= total) {
        const union = new Set();
        for (const each of lists) for (const value of each) union.add(value);
        return Array.from(union).sort((a, b) => a - b);
      }
      if (mask[index] === 0) {
        mask[index] = 1;
        count++;
      }
    }
  }
  // Appended rather than preallocated, so the array stays packed: every
  // per-cell consumer reads it without hole checks.
  const union = [];
  for (let index = 0; union.length < count; index++) {
    if (mask[index] !== 0) union.push(index);
  }
  return union;
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
 * The codes are read at their own width. The missing code of each width is
 * folded as 0xffffffff, a value no real code of any width takes (the largest
 * real uint32 code is 4,294,967,294), so one partition of the cells has one
 * digest whatever width its field is stored at.
 *
 * @param {Uint8Array|Uint16Array|Uint32Array} codes - Per-cell category codes
 * @returns {string} 32 lowercase hex characters
 */
export function computeCategoryGroupingDigest(codes) {
  if (!isCategoricalCodes(codes) || codes.length === 0) {
    throw new TypeError(
      'Category grouping digest requires non-empty per-cell categorical codes'
    );
  }
  const missing = missingCategoryCode(codes);
  const lanes = createDigestLanes();
  foldDigestNumber(lanes, codes.length);
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    foldDigestWord(lanes, code === missing ? 0xffffffff : code);
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
 * @property {number} [cacheSize=100] - Maximum page-data cache entries
 * @property {number} [cacheMaxBytes=268435456] - Page-data cache budget for the
 *   bytes of cached per-cell values (256 MiB)
 * @property {number} [cacheMaxAge=0] - Cache entry max age in ms (0 = no expiration)
 * @property {boolean} [enableDedup=true] - Enable request deduplication
 * @property {boolean} [enablePrefetch=false] - Enable prefetching
 * @property {boolean} [enableVersionTracking=true] - Track page versions for cache correctness
 * @property {boolean} [enableNotifications=true] - Show notifications for long operations
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
/**
 * The variable record of one gene field.
 *
 * @param {Object} field
 * @param {number} index - The field's position in `varData.fields`
 */
function categoricalVariableInfo(field, index) {
  return {
    key: field.key,
    name: field.key,
    kind: 'category',
    // Null until loaded for a column whose categories are found when
    // it is first read (a direct AnnData string or boolean column).
    categories: field.categories ?? null,
    categoryCount: field.categories === null ? null : (field.categories || []).length,
    loaded: field.loaded || false,
    _fieldIndex: index
  };
}

function continuousVariableInfo(field, index) {
  const stats = field._continuousStats || {};
  return {
    key: field.key,
    name: field.key,
    kind: 'continuous',
    min: stats.min ?? null,
    max: stats.max ?? null,
    mean: stats.mean ?? null,
    loaded: field.loaded || false,
    _fieldIndex: index
  };
}

function geneVariableInfo(field, index) {
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
}

/**
 * Index sets already checked against a field length: an index array and the
 * largest length it was found inside.
 * @type {WeakMap<ArrayLike<number>, number>}
 */
const indicesCheckedWithin = new WeakMap();

/**
 * Throw unless every index is a non-negative integer below `length`; an
 * index set checked once is not walked again for a field at least as long.
 *
 * @param {ArrayLike<number>} indices
 * @param {number} length
 * @param {string} variableKey
 */
function requireIndicesWithin(indices, length, variableKey) {
  const checked = indicesCheckedWithin.get(indices);
  if (checked !== undefined && checked <= length) return;
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= length) {
      throw new RangeError(
        `Cell index ${String(idx)} is outside field "${variableKey}" length ${length}`
      );
    }
  }
  if (typeof indices === 'object' && indices !== null) indicesCheckedWithin.set(indices, length);
}

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
      cacheMaxBytes = PAGE_DATA_CACHE_MAX_BYTES,
      cacheMaxAge = 0,
      enableDedup = true,
      enablePrefetch = false,
      enableVersionTracking = true,
      enableNotifications = true
    } = options;

    /** @type {Object} Reference to DataState */
    this.state = state;

    /** @type {DataLayerOptions} Configuration options */
    this._options = {
      enableCache,
      cacheSize,
      cacheMaxBytes,
      cacheMaxAge,
      enableDedup,
      enablePrefetch,
      enableVersionTracking,
      enableNotifications
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

    // LRU cache for page data (if enabled), bounded by entries and by the
    // bytes of the per-cell values it holds.
    this._dataCache = enableCache
      ? new LRUCache({
        maxSize: cacheSize,
        maxAge: cacheMaxAge,
        maxBytes: cacheMaxBytes,
        sizeOf: pageDataValueBytes
      })
      : null;

    // Pending requests for deduplication
    this._pendingRequests = enableDedup ? new Map() : null;
    // Dataset identity invalidates returned data; cache identity invalidates only
    // publication. Keeping these generations separate lets an explicit cache
    // cleanup avoid corrupting or rejecting otherwise valid in-flight work.
    this._datasetGeneration = 0;
    this._cacheGeneration = 0;
    this._fieldLoadLifecycle = new AbortController();
    /**
     * The expression matrices other than the mapped one an analysis has read
     * this generation (`_openMatrix`), by matrix and gene-name source.
     * @type {Map<string, Promise<{handle: Object, indexOf: Map<string, number>, keys: string[]}>>}
     */
    this._matrixHandles = new Map();
    this._destroyed = false;
    this._destroyPromise = null;

    // Prefetch queue
    this._prefetchQueue = [];
    this._prefetchTimeout = null;

    // Page version tracking for cache correctness
    this._pageVersions = enableVersionTracking ? new Map() : null;

    // The exact index set each recorded page version was computed from.
    //
    // Computing a page version is already a full pass over that page's cell
    // indices, and the fetch that follows needs the very same set. Keeping the
    // set beside its digest means the pass happens once instead of twice, and
    // — more importantly — it makes the values a cache entry holds provably
    // the values its key describes: the two used to be built by separate
    // traversals with an `await` between them, so a membership change in that
    // window was cached under the version it no longer matched.
    /** @type {Map<string, {hash: string, indices: number[]}>} */
    this._pageIndexSnapshots = new Map();

    // Each page's exact membership and digest, recorded with the structure
    // they were derived from. See `_getPageMembership`.
    /** @type {Map<string, PageMembershipRecord>} */
    this._pageMemberships = new Map();

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
   * A key -> field index lookup over `fields`, kept until a lookup finds it
   * out of date: an answer is checked against the field it names, and a key
   * that is absent or names another field (a field added, renamed or
   * replaced since) rebuilds the index once before answering.
   *
   * @param {() => Array<{key?: string}>} fieldsOf
   * @returns {{get: (key: string) => number|undefined}}
   * @private
   */
  _createFieldIndexLookup(fieldsOf) {
    let map = null;
    let indexedFields = null;
    const build = fields => {
      map = new Map();
      for (let i = 0; i < fields.length; i++) {
        const key = fields[i]?.key;
        if (typeof key === 'string' && key.length > 0) map.set(key, i);
      }
      indexedFields = fields;
    };
    return {
      get(key) {
        const fields = fieldsOf() || [];
        if (map === null || indexedFields !== fields) build(fields);
        let index = map.get(key);
        if (index === undefined || fields[index]?.key !== key) {
          build(fields);
          index = map.get(key);
        }
        return index;
      }
    };
  }

  /**
   * The geneKey -> var fieldIndex lookup.
   * @private
   */
  _getGeneFieldIndexMap() {
    this._geneFieldIndexByKey ??= this._createFieldIndexLookup(() => this.state?.varData?.fields);
    return this._geneFieldIndexByKey;
  }

  /**
   * The obsKey -> obs fieldIndex lookup.
   * @private
   */
  _getObsFieldIndexMap() {
    this._obsFieldIndexByKey ??= this._createFieldIndexLookup(() => this.state?.obsData?.fields);
    return this._obsFieldIndexByKey;
  }

  /**
   * Handle memory cleanup triggered by MemoryMonitor
   * Clears caches to free memory under pressure
   * @private
   */
  _handleMemoryCleanup() {
    const beforeMemory = this.estimateMemoryUsage();
    this._cacheGeneration += 1;
    // A retained index set is per page rather than per cached entry, so it is
    // small — but after a prune it can be the only thing still holding one.
    this._pageIndexSnapshots.clear();
    this._pageMemberships.clear();

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
      if (field.kind === 'category') results.push(categoricalVariableInfo(field, i));
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
      if (field.kind === 'continuous') results.push(continuousVariableInfo(field, i));
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

    return varData.fields.map(geneVariableInfo);
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
    if (type === 'gene_expression') {
      // One gene's record, found through the key index: describing every gene
      // of an 8,192-gene panel to read one cost a record per gene per read.
      const index = this._getGeneFieldIndexMap().get(key);
      const field = index === undefined ? undefined : this.state.varData?.fields?.[index];
      return field === undefined ? null : geneVariableInfo(field, index);
    }
    if (type !== 'categorical_obs' && type !== 'continuous_obs') {
      throw new TypeError(`Unknown variable type: ${String(type)}`);
    }
    // One field's record, found through the key index.
    const index = this._getObsFieldIndexMap().get(key);
    const field = index === undefined ? undefined : this.state.obsData?.fields?.[index];
    if (field === undefined) return null;
    if (type === 'categorical_obs') {
      return field.kind === 'category' ? categoricalVariableInfo(field, index) : null;
    }
    return field.kind === 'continuous' ? continuousVariableInfo(field, index) : null;
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

    return this._getPageMembership(page).indices.length;
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

    // A fresh array, as before: callers own what this returns.
    return this._getPageMembership(page).indices.slice();
  }

  /**
   * The exact membership of one base page, recomputed only when the structure
   * it is derived from changes.
   *
   * A page's membership is the union of its enabled groups' cell indices. The
   * analysis paths ask for it on every read — `getDataForPages` refreshes the
   * page version for every gene a signature or correlation loads, and the page
   * selectors ask for counts on every render — and each ask used to rebuild a
   * `Set` of every index, sort it through a comparator and digest it again:
   * 26 ms for one 250,000-cell page, 1.3 s of a 1.8 s fifty-gene signature.
   *
   * The record is reused while the page, its group list, every group object,
   * each group's `enabled` flag, its `cellIndices` array and that array's length
   * are all the very same — every way the application changes a page
   * (creating, removing or toggling a group, replacing a group's indices on
   * restore, replacing the group list, renaming) replaces or edits one of
   * those, and highlight index arrays are never edited in place once
   * published. The page name is recorded too, because it is part of the
   * digest.
   *
   * @param {Object} page
   * @returns {PageMembershipRecord}
   * @private
   */
  _getPageMembership(page) {
    const groups = Array.isArray(page.highlightedGroups)
      ? page.highlightedGroups
      : [];
    const cached = this._pageMemberships.get(page.id);
    if (
      cached !== undefined &&
      cached.page === page &&
      cached.groups === groups &&
      cached.groupCount === groups.length &&
      cached.structure.length === groups.length * 3
    ) {
      let unchanged = true;
      for (let i = 0; i < groups.length && unchanged; i++) {
        const group = groups[i];
        unchanged =
          cached.structure[i * 3] === group &&
          cached.structure[i * 3 + 1] === (group.enabled !== false
            ? group.cellIndices ?? null
            : null) &&
          cached.structure[i * 3 + 2] === (group.cellIndices?.length ?? -1);
      }
      if (unchanged) return cached;
    }

    const structure = [];
    const lists = [];
    for (const group of groups) {
      const active = group.enabled !== false && group.cellIndices
        ? group.cellIndices
        : null;
      structure.push(
        group,
        group.enabled !== false ? group.cellIndices ?? null : null,
        group.cellIndices?.length ?? -1
      );
      if (active !== null) lists.push(active);
    }
    const record = {
      page,
      groups,
      groupCount: groups.length,
      structure,
      indices: collectSortedUnion(lists, this.state?.pointCount),
      digestName: null,
      digest: null,
    };
    // A record holds its page's index array, so records of pages that no
    // longer exist are dropped whenever a new one is made.
    const livePageIds = new Set(this.getPages().map(livePage => livePage.id));
    for (const pageId of this._pageMemberships.keys()) {
      if (!livePageIds.has(pageId)) this._pageMemberships.delete(pageId);
    }
    this._pageMemberships.set(page.id, record);
    return record;
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
   * @param {AbortSignal|null} [options.signal=null] - Ends this caller's lease
   * @param {'high'|'normal'|'bulk'|'low'} [options.priority='normal']
   * @param {string|null} [options.owner=null] - The job a gene load it starts
   *   is read for
   * @returns {Promise<void>}
   * @private
   */
  async _ensureFieldLoaded(field, fieldIndex, source, options = {}) {
    const {
      silent = true,
      signal: callerSignal = null,
      priority = 'normal',
      owner = null
    } = options;
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
    // A caller's own signal (a prefetch that may be cancelled) ends this
    // caller's lease as well as the analysis lifecycle does.
    const loadSignal = callerSignal === null
      ? lifecycle.signal
      : AbortSignal.any([lifecycle.signal, callerSignal]);

    // Always enter through DataState, even when a core load already exists.
    // Its shared loader registers this analysis call as an independent lease;
    // directly awaiting field._loadingPromise would let an unrelated UI abort
    // cancel the core while analysis still needs it.
    if (source === 'obs') {
      if (typeof this.state.ensureFieldLoaded !== 'function') {
        throw new Error('Observation field loader is unavailable');
      }
      await this.state.ensureFieldLoaded(fieldIndex, {
        signal: loadSignal,
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
        signal: loadSignal,
        silent,
        priority,
        owner
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
   * @param {AbortSignal|null} [options.signal=null] - Ends this caller's
   *   interest in the load (the load itself stops when no caller remains)
   * @param {'high'|'normal'|'bulk'|'low'} [options.priority='normal'] - How
   *   urgently the gene is needed (data/fetch-scheduler.js)
   * @returns {Promise<{ fieldIndex: number, values: ArrayLike<number>, wasLoaded: boolean }>}
   */
  async ensureGeneExpressionLoaded(geneKey, options = {}) {
    const { silent = true, signal = null, priority = 'normal' } = options;
    if (signal !== null && !(signal instanceof AbortSignal)) {
      throw new TypeError('Gene load signal must be an AbortSignal or null');
    }
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
    await this._ensureFieldLoaded(field, fieldIndex, 'var', { silent, signal, priority });
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
   * One gene's values for a computation, in the cheaper of two forms, never
   * installed in field state: the field's own dense array when it is already
   * loaded (a gene a view shows, a user-defined copy) -- shared, so read it
   * only -- else its non-zero entries `{length, indices, values}` read from
   * the source, owned by the caller (`DataState.readVarSparseColumn`). The
   * analysis kernels take either (`compute/gene-statistics.js`).
   *
   * `owner` is the job the read is for (`app/jobs/cancellable-job.js`).
   *
   * `matrix` is an analysis's "Expression matrix" (`getExpressionMatrices`):
   * `mapped` (the one shown), or another matrix of the file, whose genes are
   * named on its own axis (`getGeneKeys`) and always read from the source; a
   * gene that matrix lacks is refused by name (`GENE_NOT_IN_MATRIX`).
   *
   * @param {string} geneKey
   * @param {{signal?: AbortSignal|null, priority?: 'high'|'normal'|'bulk'|'low', owner?: string|null, matrix?: string}} [options]
   * @returns {Promise<{fieldIndex: number, values: Float32Array|{length: number, indices: Uint32Array, values: Float32Array}, owned: boolean}>}
   */
  async readGeneColumn(geneKey, options = {}) {
    const { signal = null, priority = 'normal', owner = null, matrix = 'mapped' } = options;
    if (signal !== null && !(signal instanceof AbortSignal)) {
      throw new TypeError('Gene read signal must be an AbortSignal or null');
    }
    const datasetGeneration = this._datasetGeneration;
    this._requireCurrentDatasetGeneration(datasetGeneration);
    const expression = matrix === 'mapped' ? null : this.resolveExpressionMatrix(matrix).read;
    if (expression !== null) {
      const opened = await this._openMatrix(expression);
      this._requireCurrentDatasetGeneration(datasetGeneration);
      const gene = opened.indexOf.get(geneKey);
      if (gene === undefined) throw geneNotInMatrixError(geneKey, opened.label);
      const sample = await this.state.readMatrixSparseColumn(opened.handle, gene, {
        priority,
        owner,
        signal: signal === null
          ? this._fieldLoadLifecycle.signal
          : AbortSignal.any([this._fieldLoadLifecycle.signal, signal])
      });
      this._requireCurrentDatasetGeneration(datasetGeneration);
      return { fieldIndex: gene, values: sample, owned: true };
    }
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
    if (field.loaded && field.values) {
      return { fieldIndex, values: field.values, owned: false };
    }
    const sample = typeof this.state.readVarSparseColumn === 'function'
      ? await this.state.readVarSparseColumn(fieldIndex, {
        priority,
        owner,
        signal: signal === null
          ? this._fieldLoadLifecycle.signal
          : AbortSignal.any([this._fieldLoadLifecycle.signal, signal])
      })
      : null;
    this._requireCurrentDatasetGeneration(datasetGeneration);
    if (sample !== null) return { fieldIndex, values: sample, owned: true };
    // No source to read entries from (a field with no payload of its own):
    // its values are loaded into field state, and let go of again unless
    // something else had them loaded, so the caller then owns them.
    const loaded = await this.ensureGeneExpressionLoaded(geneKey, { silent: true, signal, priority });
    const released = !loaded.wasLoaded && this.unloadGeneExpression(geneKey, { preserveActive: true });
    if (released) this.invalidateVariable('gene_expression', geneKey);
    return { fieldIndex, values: loaded.values, owned: released };
  }

  /**
   * The expression matrices an analysis can read its genes from (its
   * "Expression matrix" option): `mapped`, the matrix the Data mapping shows
   * (named in its label), then every other usable matrix of the file (`X`,
   * each layer, `raw`). `reason` says why only the mapped one is listed: the
   * dataset cannot change its expression matrix, or has no expression matrix.
   *
   * @returns {{choices: Array<{value: string, label: string}>, reason: string|null}}
   */
  getExpressionMatrices() {
    const mapping = this.state.getDataMapping?.() ?? null;
    const mapped = mapping?.expression ?? null;
    const menu = mapped === null ? null : (this.state.getMappingGroupChoices?.('expression') ?? null);
    const choices = [{ value: 'mapped', label: mapped === null ? 'Mapped' : `Mapped (${matrixName(mapped)})` }];
    if (menu === null) {
      return {
        choices,
        reason: mapped === null ? 'This dataset has no expression matrix.' : 'This dataset reads only its mapped expression matrix.'
      };
    }
    for (const choice of menu) {
      if (choice.value !== null && choice.value !== mapped && choice.usable) {
        choices.push({ value: choice.value, label: choice.label });
      }
    }
    return { choices, reason: null };
  }

  /**
   * What one "Expression matrix" value reads: `matrix` the matrix it names
   * (`X`, `raw`, `layer:<key>`; the mapping's for `mapped`), `read` null when
   * that is the mapped matrix (read through the shown gene list) else the
   * matrix, and its short `label` (`Mapped (X)`, `raw`, `layers['counts']`).
   *
   * @param {string} matrix
   * @returns {{matrix: string|null, read: string|null, label: string}}
   */
  resolveExpressionMatrix(matrix) {
    const mapped = this.state.getDataMapping?.()?.expression ?? null;
    const { choices } = this.getExpressionMatrices();
    if (matrix === 'mapped' || matrix === mapped) {
      return { matrix: mapped, read: null, label: choices[0].label };
    }
    const choice = choices.find(entry => entry.value === matrix);
    if (choice === undefined) {
      throw new RangeError(`This dataset has no expression matrix ${String(matrix)} to read`);
    }
    return { matrix, read: matrix, label: matrixName(matrix) };
  }

  /**
   * The gene keys of one "Expression matrix", in its order: the shown genes
   * for the mapped one, else that matrix's genes on its own axis.
   *
   * @param {string} [matrix='mapped']
   * @returns {Promise<string[]>}
   */
  async getGeneKeys(matrix = 'mapped') {
    const expression = this.resolveExpressionMatrix(matrix).read;
    if (expression === null) return this.getAvailableVariables('gene_expression').map(gene => gene.key);
    return (await this._openMatrix(expression)).keys;
  }

  /**
   * A matrix other than the mapped one, opened once per generation and gene
   * name source (`DataState.openExpressionMatrix`).
   * @private
   */
  _openMatrix(expression) {
    const geneNames = this.state.getDataMapping?.()?.geneNames ?? 'index';
    const key = JSON.stringify([this._datasetGeneration, expression, geneNames]);
    let opened = this._matrixHandles.get(key);
    if (opened === undefined) {
      const label = this.resolveExpressionMatrix(expression).label;
      opened = this.state.openExpressionMatrix(expression).then(handle => {
        const keys = handle.fields.map(field => field.key);
        return { handle, label, keys, indexOf: new Map(keys.map((gene, index) => [gene, index])) };
      });
      opened.catch(() => this._matrixHandles.delete(key));
      this._matrixHandles.set(key, opened);
    }
    return opened;
  }

  /**
   * The load the data layer reads from: it changes whenever the dataset (or
   * its expression mapping) is replaced, so what was computed from one load
   * is never served for another (`shared/gene-moments-cache.js`).
   * @returns {number}
   */
  getDatasetGeneration() {
    return this._datasetGeneration;
  }

  /**
   * The cells the active view shows (its filters applied), one byte a cell:
   * 1 shown, 0 hidden. A copy: an analysis scoped to the visible cells keeps
   * the cells it started with whatever the filters do next.
   *
   * @returns {Uint8Array}
   */
  getVisibleCellMask() {
    const pointCount = this.state?.pointCount;
    const visibility = this.state?.categoryTransparency;
    if (!(visibility instanceof Uint8Array) || visibility.length !== pointCount) {
      throw new Error('The view has no visibility of every cell to scope an analysis by');
    }
    return visibility.slice();
  }

  /**
   * The open dataset's link as the reader measured it
   * (`{latencyMs, bytesPerMs, backgroundConcurrency, protocol}`), or null
   * before a measurement or when the source reports none. A run's tuner
   * sizes its read-ahead by it (`shared/run-tuner.js`).
   *
   * @returns {{latencyMs: number, bytesPerMs: number, backgroundConcurrency: number, protocol: string|null}|null}
   */
  linkMeasurement() {
    const measure = this.state?.varFieldLoader?.linkMeasurement;
    return typeof measure === 'function' ? (measure() ?? null) : null;
  }

  /**
   * Some genes' values in some cells, read by cell or by gene, whichever
   * costs less (see DataState.readVarCellSubset); null when the source
   * cannot.
   *
   * @param {string[]} geneKeys - Distinct gene keys (of `matrix`)
   * @param {ArrayLike<number>} cellIndices - Distinct cell positions
   * @param {{signal?: AbortSignal|null, owner?: string|null, matrix?: string}} [options] -
   *   `owner`: the job the read is for; `matrix` as `readGeneColumn`
   * @returns {Promise<{pointers: Float64Array, cellIndex: Int32Array, values: Float32Array}|null>}
   */
  async readGeneCellSubset(geneKeys, cellIndices, options = {}) {
    const matrix = options.matrix ?? 'mapped';
    const expression = matrix === 'mapped' ? null : this.resolveExpressionMatrix(matrix).read;
    if (expression !== null) {
      const datasetGeneration = this._datasetGeneration;
      const opened = await this._openMatrix(expression);
      this._requireCurrentDatasetGeneration(datasetGeneration);
      const genes = geneKeys.map(geneKey => {
        const gene = opened.indexOf.get(geneKey);
        if (gene === undefined) throw geneNotInMatrixError(geneKey, opened.label);
        return gene;
      });
      const signal = options.signal ?? null;
      const block = await this.state.readMatrixCellSubset(opened.handle, genes, cellIndices, {
        owner: options.owner ?? null,
        signal: signal === null
          ? this._fieldLoadLifecycle.signal
          : AbortSignal.any([this._fieldLoadLifecycle.signal, signal])
      });
      this._requireCurrentDatasetGeneration(datasetGeneration);
      return block;
    }
    if (typeof this.state.readVarCellSubset !== 'function') return null;
    const indexOf = this._getGeneFieldIndexMap();
    const fieldIndices = geneKeys.map(geneKey => {
      const fieldIndex = indexOf.get(geneKey);
      if (typeof fieldIndex !== 'number') {
        throw new Error(`[DataLayer] Gene not found: ${geneKey}`);
      }
      return fieldIndex;
    });
    const signal = options.signal ?? null;
    return this.state.readVarCellSubset(fieldIndices, cellIndices, {
      owner: options.owner ?? null,
      signal: signal === null
        ? this._fieldLoadLifecycle.signal
        : AbortSignal.any([this._fieldLoadLifecycle.signal, signal])
    });
  }

  /**
   * Whole gene columns for a computation, in gene order: each the cheaper form
   * `readGeneColumn` gives (a loaded field's shared dense array -- read it
   * only -- or the gene's sparse entries). Every gene is asked for at once;
   * the reader's fetch scheduler paces them. `signal` stops the reads in flight and rejects with its
   * `AbortError`; `owner` is the job they are for. A request that stops
   * being current is refused at its next step; one that registers an
   * invalidation cleanup also aborts the reads in flight the moment it is
   * invalidated.
   *
   * @param {string[]} geneKeys
   * @param {{isCurrent?: () => boolean, registerInvalidationCleanup?: (cleanup: () => void) => void, priority?: 'high'|'normal'|'bulk'|'low', signal?: AbortSignal|null, owner?: string|null, matrix?: string}} [options]
   * @returns {Promise<Array<ArrayLike<number>|{length: number, indices: Uint32Array, values: Float32Array}>>}
   */
  async readGeneColumns(geneKeys, options = {}) {
    if (!Array.isArray(geneKeys)) {
      throw new TypeError('Gene column keys must be an array');
    }
    const {
      isCurrent,
      registerInvalidationCleanup,
      priority = 'normal',
      signal = null,
      owner: readOwner = null,
      matrix = 'mapped'
    } = options;
    if (signal !== null && !(signal instanceof AbortSignal)) {
      throw new TypeError('Gene column signal must be an AbortSignal or null');
    }
    if (isCurrent !== undefined && typeof isCurrent !== 'function') {
      throw new TypeError('Gene column isCurrent must be a function when provided');
    }
    if (
      registerInvalidationCleanup !== undefined &&
      typeof registerInvalidationCleanup !== 'function'
    ) {
      throw new TypeError('Gene column registerInvalidationCleanup must be a function when provided');
    }
    const datasetGeneration = this._datasetGeneration;
    const owner = new AbortController();
    registerInvalidationCleanup?.(() => owner.abort());
    const stopReads = () => owner.abort(abortReasonOf(signal));
    signal?.addEventListener('abort', stopReads, { once: true });
    const requireCurrent = () => {
      throwIfAborted(signal);
      this._requireCurrentDatasetGeneration(datasetGeneration);
      if (owner.signal.aborted || (isCurrent !== undefined && !isCurrent())) {
        throw this._createAnalysisDataInvalidationError('an analysis request ownership change');
      }
    };
    requireCurrent();
    const columns = new Array(geneKeys.length);
    const inFlight = new Set();
    const tasks = [];
    const maxInFlight = Math.max(1, geneKeys.length);
    for (let index = 0; index < geneKeys.length; index++) {
      await waitForAvailableSlot(inFlight, maxInFlight);
      requireCurrent();
      const task = this.readGeneColumn(geneKeys[index], { signal: owner.signal, priority, owner: readOwner, matrix })
        .then(({ values }) => {
          columns[index] = values;
        });
      tasks.push(task);
      trackSettlement(inFlight, task);
    }
    try {
      await Promise.all(tasks);
    } catch (error) {
      // Whether the request still owned its reads is decided before this
      // catch stops the others: aborting `owner` here is the read failure's
      // own cleanup, not an ownership change, and must not hide the failure.
      const lostOwnership = owner.signal.aborted || (isCurrent !== undefined && !isCurrent());
      owner.abort();
      await Promise.allSettled(tasks);
      throwIfAborted(signal);
      this._requireCurrentDatasetGeneration(datasetGeneration);
      if (lostOwnership) {
        throw this._createAnalysisDataInvalidationError('an analysis request ownership change');
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', stopReads);
    }
    requireCurrent();
    return columns;
  }

  /**
   * The exact cells of pages, as the snapshots page data is read with: each
   * page's distinct cell indices in ascending order (shared: read only).
   *
   * @param {string[]} pageIds
   * @returns {Array<{pageId: string, pageName: string, cellIndices: ArrayLike<number>}>}
   */
  getPageCells(pageIds) {
    if (!Array.isArray(pageIds)) {
      throw new TypeError('Page cell IDs must be an array');
    }
    this.refreshPageVersions(
      Array.from(new Set(pageIds)).filter(id => !isRestOfPageId(id))
    );
    return pageIds.map(pageId => {
      const pageInfo = this.getPageInfo(pageId);
      if (!pageInfo) {
        throw new Error(`Page not found: ${pageId}`);
      }
      return {
        pageId,
        pageName: pageInfo.name,
        cellIndices: this._getVersionedCellIndices(pageId)
      };
    });
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
   * @param {AbortSignal|null} [options.signal=null] - Ends this caller's wait
   *   (the load goes on for other callers)
   * @returns {Promise<{ fieldIndex: number, kind: string, codes?: Uint8Array|Uint16Array|Uint32Array, categories?: string[], values?: Float32Array, colors?: Object }>}
   *   Categorical codes are the field's own array, at its own width (read its
   *   missing code with `missingCategoryCode`); callers must not modify it.
   */
  async ensureObsFieldLoaded(obsKey, options = {}) {
    const { silent = true, signal = null } = options;
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
    await this._ensureFieldLoaded(field, fieldIndex, 'obs', { silent, signal });
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
        codes: requireAnalysisCategoryCodes(field.codes, obsKey),
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
   * One request is made once however many callers ask for it at the same
   * time. `signal` ends this caller's wait at once (an `AbortError`); the
   * request goes on for the other callers and stops when none is left, and
   * a stopped request is never cached.
   *
   * @param {FetchOptions} options - Fetch options
   * @param {boolean} [options.silent=false] - Suppress loading notifications (for bulk operations)
   * @param {AbortSignal|null} [options.signal=null] - Ends this caller's wait
   * @param {string|null} [options.owner=null] - The job a gene read it starts
   *   is for (`app/jobs/cancellable-job.js`)
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
      noCache = false,
      signal = null
    } = options;
    if (signal !== null && !(signal instanceof AbortSignal)) {
      throw new TypeError('Page-data fetch signal must be an AbortSignal or null');
    }
    throwIfAborted(signal);
    const pageIds = Array.isArray(requestedPageIds)
      ? [...requestedPageIds]
      : requestedPageIds;
    // The request is shared: its options never carry one caller's signal.
    const requestOptions = { ...options };
    delete requestOptions.signal;
    const ownedOptions = {
      ...requestOptions,
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

      // Join a pending request (deduplication) unless every caller of it
      // has gone and it was stopped.
      const pending = this._pendingRequests?.get(cacheKey);
      if (pending !== undefined && !pending.abandoned) {
        return pending.join(signal);
      }

      // Create new request: cached only once it completes.
      const work = new SharedWork(async workSignal => {
        const result = await this._fetchDataForPages(
          ownedOptions,
          datasetGeneration,
          workSignal
        );
        this._requireCurrentDatasetGeneration(datasetGeneration);
        if (this._cacheGeneration === cacheGeneration) {
          this._dataCache.set(cacheKey, result);
        }
        return result;
      });
      if (this._pendingRequests) {
        this._pendingRequests.set(cacheKey, work);
      }
      const release = () => {
        if (this._pendingRequests?.get(cacheKey) === work) {
          this._pendingRequests.delete(cacheKey);
        }
      };
      work.promise.then(release, release);
      return work.join(signal);
    }

    // No caching, fetch directly
    const result = await this._fetchDataForPages(
      ownedOptions,
      datasetGeneration,
      signal
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
   * @param {number} [datasetGeneration]
   * @param {AbortSignal|null} [signal=null] - Stops the request's field load
   * @returns {Promise<PageData[]>}
   * @private
   */
  async _fetchDataForPages(
    options,
    datasetGeneration = this._datasetGeneration,
    signal = null
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
      await this._ensureFieldLoaded(field, fieldIndex, source, {
        signal,
        owner: options.owner ?? null
      });
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
      ? requireAnalysisCategoryCodes(field.codes, variableKey)
      : field.values;
    const missingCode = field.kind === 'category'
      ? missingCategoryCode(rawValues)
      : null;

    if (!rawValues || rawValues.length === 0) {
      throw new Error(`No values are available for field: ${variableKey}`);
    }

    // A categorical page holds its cells' codes at the field's own width,
    // with the field's categories and missing code beside them.
    const isCategory = field.kind === 'category';
    const categories = field.categories || [];
    const ValueStorage = isCategory
      ? rawValues.constructor
      : continuousPageValueStorage(field.kind, rawValues);
    const categoricalRecord = isCategory ? { categories, missingCode } : {};

    // Process each page
    const results = [];

    for (const pageId of pageIds) {
      const pageInfo = this.getPageInfo(pageId);
      if (!pageInfo) {
        throw new Error(`Page not found: ${pageId}`);
      }

      const cellIndices = this._getVersionedCellIndices(pageId);

      if (cellIndices.length === 0) {
        const values = ValueStorage === null ? [] : new ValueStorage(0);
        if (isCategory) adoptCategoryCounts(values, new Map());
        results.push({
          pageId,
          pageName: pageInfo.name,
          variableInfo: { ...variableInfo },
          values,
          ...categoricalRecord,
          cellIndices: [],
          cellCount: 0
        });
        continue;
      }

      // Extract values for cells in this page.
      //
      // `cellIndices` is already the exact, deduplicated, ascending index set
      // this page owns, and the loop below validates every entry before any
      // result is published, so copying it into a second array of the same
      // contents bought nothing and cost one full allocation per page per
      // variable — 60 of them for a 60-gene signature over one page.
      //
      // Continuous values keep the field's own element type, so every value
      // is exactly the number the field holds, at its width: a Float32 field
      // gives 4 bytes per cell instead of a JavaScript number array's 8, which
      // halves what the page-data cache holds.
      const values = ValueStorage === null
        ? []
        : new ValueStorage(cellIndices.length);
      let position = 0;
      // A typed continuous field is gathered in one tight loop: its values are
      // numbers by type, and the page's indices are checked against the field
      // once per index set (a page's index array is shared by every variable
      // read for it — 50 genes of a signature check it once, not 50 times).
      if (field.kind !== 'category' && ValueStorage !== null && ArrayBuffer.isView(rawValues)) {
        requireIndicesWithin(cellIndices, rawValues.length, variableKey);
        const yieldIfSliceSpent = createSlicedYield();
        for (let from = 0; from < cellIndices.length; from += 0x10000) {
          const to = Math.min(cellIndices.length, from + 0x10000);
          for (let i = from; i < to; i++) values[i] = rawValues[cellIndices[i]];
          const pending = yieldIfSliceSpent();
          if (pending !== undefined) {
            await pending;
            this._requireCurrentDatasetGeneration(datasetGeneration);
          }
        }
        results.push({
          pageId,
          pageName: pageInfo.name,
          variableInfo: { ...variableInfo, categories: undefined },
          values,
          cellIndices,
          cellCount: values.length
        });
        continue;
      }
      if (isCategory) {
        // Codes are gathered in one typed loop and counted by code as they
        // are; the label counts are adopted for the published codes, so no
        // categorical consumer walks the cells again
        // (shared/category-counts.js).
        requireIndicesWithin(cellIndices, rawValues.length, variableKey);
        const categoryCount = categories.length;
        const codeCounts = new Float64Array(categoryCount + 1);
        const codesInOrder = [];
        const yieldIfSliceSpent = createSlicedYield();
        for (let from = 0; from < cellIndices.length; from += 0x10000) {
          const to = Math.min(cellIndices.length, from + 0x10000);
          for (let i = from; i < to; i++) {
            const code = rawValues[cellIndices[i]];
            values[i] = code;
            if (code === missingCode) {
              if (codeCounts[categoryCount]++ === 0) codesInOrder.push(categoryCount);
            } else if (code >= categoryCount) {
              throw new RangeError(
                `Category code ${code} for "${variableKey}" is outside ` +
                `${categoryCount} categories`
              );
            } else if (codeCounts[code]++ === 0) {
              codesInOrder.push(code);
            }
          }
          const pending = yieldIfSliceSpent();
          if (pending !== undefined) {
            await pending;
            this._requireCurrentDatasetGeneration(datasetGeneration);
          }
        }
        const counts = new Map();
        for (const code of codesInOrder) {
          counts.set(code === categoryCount ? null : categories[code], codeCounts[code]);
        }
        adoptCategoryCounts(values, counts);
        results.push({
          pageId,
          pageName: pageInfo.name,
          variableInfo: { ...variableInfo, categories },
          values,
          categories,
          missingCode,
          cellIndices,
          cellCount: values.length
        });
        continue;
      }

      // A field held in a plain array is gathered value by value, handing the
      // event loop back between slices of a large page.
      const yieldIfSliceSpent = createSlicedYield();
      for (const idx of cellIndices) {
        if ((position & 0xffff) === 0xffff) {
          const pending = yieldIfSliceSpent();
          if (pending !== undefined) {
            await pending;
            this._requireCurrentDatasetGeneration(datasetGeneration);
          }
        }
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
        const value = rawValues[idx];
        if (typeof value !== 'number') {
          // NaN is the missing value of a continuous field. It stays in place
          // so values remain aligned with cellIndices (correlation pairs two
          // variables by cell); every statistic drops it per variable.
          throw new TypeError(
            `Continuous value at cell ${idx} for "${variableKey}" must be a number`
          );
        }
        if (ValueStorage === null) values.push(value);
        else values[position] = value;
        position++;
      }

      results.push({
        pageId,
        pageName: pageInfo.name,
        variableInfo: { ...variableInfo, categories: undefined },
        values,
        cellIndices,
        cellCount: values.length
      });
    }

    return results;
  }

  // ===========================================================================
  // AGGREGATION & STATISTICS
  // ===========================================================================

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

    // Every category any page holds, in first-occurrence order, from the
    // counts each page was published with.
    const pageCounts = pageData.map(pd => categoryCounts(pd.values));
    const allCategories = new Set();
    for (const counts of pageCounts) {
      for (const category of counts.keys()) allCategories.add(category);
    }

    // Count per page per category
    const result = {
      categories: Array.from(allCategories),
      pages: {}
    };

    for (const [index, pd] of pageData.entries()) {
      const counts = {};
      for (const cat of allCategories) {
        setOwnDataProperty(counts, cat, pageCounts[index].get(cat) ?? 0);
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

    const page = this.getPages().find(p => p.id === pageId);
    if (!page) {
      throw new Error(`Page not found: ${pageId}`);
    }
    const pageName = page.name || '';
    const membership = this._getPageMembership(page);
    if (membership.digestName !== pageName) {
      foldDigestText(lanes, pageName);
      foldDigestIndexSet(lanes, membership.indices);
      membership.digestName = pageName;
      membership.digest = `${pageId}:${finalizeDigest(lanes)}`;
    }
    const hash = membership.digest;
    // Keep the set this digest describes, so the fetch that follows reads the
    // same membership instead of rebuilding it.
    this._pageIndexSnapshots.set(pageId, { hash, indices: membership.indices });
    return hash;
  }

  /**
   * The exact index set behind a page's *current* recorded version.
   *
   * Returns the snapshot only when it still describes the recorded version, so
   * a caller can never be handed a set the current cache key does not cover.
   *
   * @param {string} pageId - Page ID
   * @returns {number[]} The page's exact, deduplicated, ascending index set
   * @private
   */
  _getVersionedCellIndices(pageId) {
    if (this._pageVersions === null) {
      return this.getCellIndicesForPage(pageId);
    }
    // A derived "rest of" page never reaches `_computePageHash`'s index branch
    // — its digest is derived from the base page's version — so it has no
    // snapshot until the first fetch builds one. Recording it here covers that
    // case too, and materialising the complement is exactly the work the fetch
    // is about to do anyway.
    const version = this._getPageVersion(pageId);
    const snapshot = this._pageIndexSnapshots.get(pageId);
    if (snapshot !== undefined && snapshot.hash === version) {
      return snapshot.indices;
    }
    const indices = this.getCellIndicesForPage(pageId);
    this._pageIndexSnapshots.set(pageId, { hash: version, indices });
    return indices;
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
    if (this._pendingRequests !== null) {
      this._pendingRequests.clear();
    }

    const pageIdSet = new Set(uniquePageIds);
    for (const pageId of pageIdSet) {
      this._pageIndexSnapshots.delete(pageId);
      this._pageMemberships.delete(pageId);
    }

    // Cache keys end with the page IDs, optionally followed by a ':v='
    // version component: type:variableKey:page_1,page_2[:v=...]
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
    this._pageIndexSnapshots.clear();
    this._pageMemberships.clear();
  }

  /**
   * Clear every cache, the prefetch queue included
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
    this._pageIndexSnapshots.clear();
    this._pageMemberships.clear();
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
    this._matrixHandles.clear();
    this.clearAllCaches();
    if (this._pendingRequests !== null) {
      this._pendingRequests.clear();
    }
    this._geneFieldIndexByKey = null;
    this._obsFieldIndexByKey = null;
    this._pageIndexSnapshots.clear();
    this._pageMemberships.clear();
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
   * Fetch bulk observation field data for analysis
   *
   * @param {Object} options - Fetch options
   * @param {string[]} options.pageIds - Page IDs
   * @param {string[]} options.obsFields - Observation field keys
   * @param {Function} [options.onProgress] - Progress callback
   * @param {AbortSignal|null} [options.signal=null] - Stops the reads (a
   *   job's; its job then owns the notification)
   * @returns {Promise<Object>} { fields, pageData, stats }
   */
  async fetchBulkObsFields(options) {
    const {
      pageIds,
      obsFields,
      onProgress,
      subsetPages = true,
      signal = null
    } = options || {};

    const startTime = performance.now();

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
        (!isCategoricalCodes(rawFieldValues) ||
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
      const missingCode = fieldData.kind === 'category'
        ? missingCategoryCode(rawFieldValues)
        : null;

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
            rawFieldValues[cellIdx] !== missingCode &&
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

        // A page's codes keep the field's width, and so its missing code.
        const pageCodes = new rawFieldValues.constructor(cellIndices.length);
        for (let i = 0; i < cellIndices.length; i++) {
          pageCodes[i] = rawFieldValues[cellIndices[i]];
        }
        const pageEntry = {
          codes: pageCodes,
          cellCount: cellIndices.length
        };
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
    if (this._notifications && obsFields.length > 1 && signal === null) {
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
      await this._loadObsFieldsConcurrently(
        obsFields,
        handleProgress,
        publishField,
        signal
      );

      // Complete notification
      const duration = performance.now() - startTime;
      if (notificationId && this._notifications) {
        this._notifications.complete(notificationId,
          `Loaded ${result.stats.fieldsLoaded} fields (${formatDuration(duration)})`
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
   * Load the requested observation fields together.
   *
   * Awaiting each field before asking for the next would make a run's wall
   * clock the *sum* of its reads on a remote file. The fields are
   * independent, so they are asked for together, and the reader batches and
   * paces them.
   *
   * Fields are still *published* in request order, because `result.fields` is
   * an ordered record the callers read positionally.
   *
   * @param {string[]} obsFields - Field keys to load
   * @param {Function} [onProgress] - Progress callback
   * @param {Function} publishField - Exact field publication callback
   * @param {AbortSignal|null} [signal] - Stops the loads still to start and
   *   ends the wait for those under way
   * @private
   */
  async _loadObsFieldsConcurrently(obsFields, onProgress, publishField, signal = null) {
    const totalFields = obsFields.length;
    const loaded = new Array(totalFields);
    const tasks = [];
    const inFlight = new Set();
    let completed = 0;

    const maxInFlight = Math.max(1, totalFields);

    for (let index = 0; index < totalFields; index++) {
      const fieldKey = obsFields[index];
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

      await waitForAvailableSlot(inFlight, maxInFlight);
      throwIfAborted(signal);

      const task = this.ensureObsFieldLoaded(fieldKey, { silent: true, signal })
        .then(fieldData => {
          loaded[index] = fieldData;
          completed++;
          if (onProgress) {
            onProgress(Math.round((completed / totalFields) * 100));
          }
        });
      tasks.push(task);
      trackSettlement(inFlight, task);
    }

    // Every started load is awaited, so a rejection can never outlive this
    // call as an unhandled rejection, and the first failure is the one thrown.
    await Promise.all(tasks);

    for (let index = 0; index < totalFields; index++) {
      publishField(obsFields[index], loaded[index]);
    }
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
              totalBytes += arrayLikeBytes(pageData.values);
            }
            if (pageData.cellIndices) {
              totalBytes += pageData.cellIndices.length * 4;
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

    // Prune data cache if it supports it
    if (this._dataCache && this._dataCache.prune) {
      cleaned += this._dataCache.prune();
    }

    const remaining = this._dataCache ? this._dataCache.size() : 0;

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
