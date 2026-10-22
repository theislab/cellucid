/**
 * Base AnnData Adapter for Cellucid
 *
 * Shared base class for H5adDataAdapter and ZarrDataAdapter.
 * Contains common logic for:
 * - Resolving which `obsm` embedding each dimension shows, and the
 *   data-mapping candidate catalog (`data-mapping-candidates.js`)
 * - Embedding reads, load-time checks and normalization, by embedding id
 * - Obs manifest generation
 * - Var manifest generation
 * - Obs field data processing
 * - Connectivity edge extraction
 *
 * The loader (H5adLoader or ZarrLoader) provides `getDatasetMetadata()`, whose
 * `probes` describe the file from metadata alone, and `readObsmColumns(key,
 * columns)`, which reads the selected columns of one dense `obsm` array.
 * Subclasses may override `_computeObsFieldsMetadata()`.
 */

import {
  DataSourceError,
  DataSourceErrorCode,
  embeddingPayloadPath,
  validateDatasetIdentity,
  vectorPayloadPath,
} from './data-source.js';
import {
  DIMENSION_SLOTS,
  VECTOR_KEY_PATTERN,
  canonicalEmbeddingId,
  compareCodePoints,
  describeObsmEntry,
  dimensionSlot,
  makeUniqueNames,
  nothingPlottableMessage,
  obsmEntryDefect,
} from './data-mapping.js';
import {
  EmbeddingLoadError,
  MappingLoadError,
  assembleAnnDataCandidates,
  axisVarColumns,
  expressionAxisRoute,
  geneNamesRoute,
  parseMappingGenesPath,
  describeAnnDataProbes,
  embeddingLoadDefect,
  obsmEntries,
  obsmWidth,
  parseMappingEmbeddingPath,
  parseMappingLatentPath,
  parseMappingVectorPath,
  resolveVectorBinding,
  LATENT_OUTLIER_MIN_POINTS,
  latentCandidateReason,
  valueLoadDefect,
  resolveCandidateRef,
  DEFAULT_KNN_KEY,
  requireObspKey,
  resolveEmbeddingSlotsAsync,
} from './data-mapping-candidates.js';
import {
  CONNECTIVITY_MANIFEST_CONTEXT,
  validateConnectivityManifest,
} from './connectivity-manifest-contract.js';
import {
  getMetadataLoadSignal,
  throwIfMetadataAborted,
  waitForMetadata,
} from './metadata-load-contract.js';
import {
  categoricalStorageForCount,
  categoricalStorageForDtype,
  requireCategoricalCategoryCount,
} from './categorical-storage-contract.js';

import { residencyBudgetBytes } from './memory-budget.js';

const CONNECTIVITY_EDGE_LABEL = 'Direct AnnData connectivity edge loading';
/** Bytes a JavaScript array slot takes, for an obs field held as an Array. */
const JS_ARRAY_ELEMENT_BYTES = 8n;

/**
 * The refusal of one neighbour graph that fails its load-time check, in the
 * words `cellucid serve` uses for the same graph.
 *
 * @param {string} key
 * @param {unknown} error
 * @returns {MappingLoadError}
 */
function connectivityRefusal(key, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/symmetric/i.test(message)) {
    const reason = 'not symmetric — choose a connectivities matrix';
    return new MappingLoadError(key, reason, `obsp['${key}'] is ${reason}.`);
  }
  const reason = message.replace(/\.\s*$/, '');
  return new MappingLoadError(key, reason, `obsp['${key}']: ${reason}.`);
}

function validateCellucidCategoryCount(nCategories, fieldKey) {
  return requireCategoricalCategoryCount(
    nCategories,
    `Categorical observation field "${fieldKey}"`
  );
}

function validateCellucidCategories(categories, fieldKey) {
  if (!Array.isArray(categories)) {
    throw new Error(
      `Categorical observation field "${fieldKey}" is missing its category labels`
    );
  }
  const nCategories = categories.length;
  validateCellucidCategoryCount(nCategories, fieldKey);

  const seen = new Set();
  for (const category of categories) {
    const type = typeof category;
    if (
      type !== 'string' &&
      type !== 'number' &&
      type !== 'boolean'
    ) {
      throw new Error(
        `Categorical observation field "${fieldKey}" has an unsupported category label type`
      );
    }
    if (type === 'number' && !Number.isFinite(category)) {
      throw new Error(
        `Categorical observation field "${fieldKey}" has a non-finite numeric category label`
      );
    }
    if (seen.has(category)) {
      throw new Error(
        `Categorical observation field "${fieldKey}" has a duplicate category label`
      );
    }
    seen.add(category);
  }
  return nCategories;
}

function comparePrimitiveCategories(left, right) {
  const leftType = typeof left;
  const rightType = typeof right;
  if (leftType !== rightType) {
    const leftOrder =
      leftType === 'boolean' ? 0 : (leftType === 'number' ? 1 : 2);
    const rightOrder =
      rightType === 'boolean' ? 0 : (rightType === 'number' ? 1 : 2);
    return leftOrder - rightOrder;
  }
  if (leftType === 'boolean') {
    return Number(left) - Number(right);
  }
  if (leftType === 'number') {
    return left - right;
  }
  return left < right ? -1 : (left > right ? 1 : 0);
}

function getCellucidCategoryStorage(categories, fieldKey) {
  return categoricalStorageForCount(
    validateCellucidCategories(categories, fieldKey),
    `Categorical observation field "${fieldKey}"`
  );
}

/**
 * One cancellation owner shared by the callers of a coalesced computation.
 *
 * Coalesced callers run a single computation, so no individual caller may
 * cancel it. The shared work observes a child signal that is aborted only once
 * every caller that joined it has cancelled: one caller walking away can never
 * strand another, and a request nobody is waiting for can never keep running.
 */
class CoalescedCancellationOwner {
  constructor() {
    this._controller = new AbortController();
    this._abandoned = 0;
    this._joined = 0;
    this._uncancellable = 0;
  }

  /** @returns {boolean} */
  get cancelled() {
    return this._controller.signal.aborted;
  }

  /** @returns {AbortSignal} */
  get signal() {
    return this._controller.signal;
  }

  /**
   * Attach one caller to the shared work.
   *
   * @param {AbortSignal|null} callerSignal - Exact owner signal or no owner
   * @returns {() => void} Detach the caller once its result has settled
   */
  join(callerSignal) {
    this._joined++;
    if (callerSignal === null) {
      // A caller without an owner signal can never abandon the work, so the
      // shared computation stays uncancellable while it is attached.
      this._uncancellable++;
      return () => {};
    }

    let counted = false;
    const onAbort = () => {
      if (counted) return;
      counted = true;
      this._abandoned++;
      if (
        this._uncancellable === 0 &&
        this._abandoned >= this._joined
      ) {
        this._controller.abort();
      }
    };
    callerSignal.addEventListener('abort', onAbort, { once: true });
    if (callerSignal.aborted) onAbort();
    return () => {
      callerSignal.removeEventListener('abort', onAbort);
    };
  }
}

/**
 * Base adapter class for AnnData file formats
 * @abstract
 */
export class BaseAnnDataAdapter {
  /**
   * @param {Object} loader - The underlying loader (H5adLoader or ZarrLoader)
   * @param {Object} [options]
   * @param {number} [options.cacheBudgetBytes] - Residency budget of the coordinate and obs caches
   */
  constructor(loader, options = {}) {
    /** @protected */
    this._loader = loader;

    /** @type {Object|null} */
    this._metadata = null;

    /**
     * The embedding each dimension slot shows, as `{key, columns}` per slot
     * (null when unused): the default rule, else the best guess.
     * @type {Readonly<Object>|null}
     */
    this._slots = null;

    /** @type {Object|null} The frozen data-mapping candidate catalog */
    this._candidates = null;

    /**
     * The described `obsm` entries, set before the catalog is assembled so the
     * best guess can load its candidates.
     * @type {ReadonlyArray<Object>|null}
     */
    this._describedObsm = null;

    /**
     * The embeddings of the published identity, in item order: their embedding
     * id and `{key, columns}`. A payload path `embeddings/{i}_{d}d.bin` names
     * item `i`.
     * @type {ReadonlyArray<{id: string, dimension: number, ref: {key: string, columns: number[]}}>|null}
     */
    this._identityEmbeddings = null;

    /**
     * Vector fields: field id -> (bound embedding id -> obsm vector key).
     * @type {Map<string, Map<string, string>>}
     */
    this._vectorBindings = new Map();

    /** @type {boolean} */
    this._directIdentityFinalized = false;

    /** @type {Map<string, Float32Array>} Normalized embeddings per embedding id */
    this._embeddingCache = new Map();

    /** @type {Map<string, Float32Array>} Scaled vector payloads by mapping route */
    this._vectorFieldCache = new Map();

    /**
     * One LRU/byte owner shared by normalized embeddings and vector fields.
     * Buffer reference counts make aliased typed-array views exact.
     */
    this._coordinateCacheLru = new Map();
    this._coordinateBufferRefs = new Map();
    this._coordinateCacheBytes = 0n;
    this._coordinateCachePins = new Map();
    this._coordinateReservedOutputBytes = 0n;
    this._coordinateReservationState = {};

    /** @type {Array|null} Obs field metadata (kind, categories, etc.) */
    this._obsFieldsMetadata = null;

    /** @type {Map<string, Object>} Lazy-loaded obs field data */
    this._obsFieldDataCache = new Map();

    /** @type {bigint} Retained bytes owned by the lazy obs field cache */
    this._obsFieldDataCacheBytes = 0n;

    /**
     * Extracted neighbour graphs by obsp key (null for an absent key): the
     * default graph, and at most one other.
     * @type {Map<string, Object|null>}
     */
    this._connectivityCache = new Map();

    /** @type {Readonly<Object>|undefined|null} Finalized direct manifest summary */
    this._connectivityManifest = undefined;

    /** @type {Map<string, Object>} Normalization info per embedding id */
    this._normInfo = new Map();

    /** @type {Map<string, Promise<Float32Array>>} */
    this._embeddingInFlight = new Map();

    /** @type {Map<string, Promise<Object>>} */
    this._obsFieldDataInFlight = new Map();

    /** @type {Map<string, Promise<Float32Array>>} */
    this._vectorFieldInFlight = new Map();

    /** @type {Map<string, Promise<Object|null>>} */
    this._connectivityInFlight = new Map();

    /** @type {Map<string, Promise<Float32Array>>} */
    this._geneExpressionInFlight = new Map();

    /** @type {Map<string, Promise<Float32Array>>} Outlier quantiles by route. */
    this._latentOutlierInFlight = new Map();

    /**
     * Unique gene names by var axis and name source, read once.
     * @type {Map<string, Readonly<Object>>}
     */
    this._geneNameSets = new Map();

    /** @type {number} Invalidates results from asynchronous work after cache lifecycle changes */
    this._lifecycleGeneration = 0;

    /** @type {boolean} Closed adapters cannot start or publish new work */
    this._closed = false;

    // A residency budget: it decides what the caches keep, never what loads.
    const cacheBudgetBytes =
      options.cacheBudgetBytes ?? residencyBudgetBytes('adapterCache');
    if (
      !Number.isSafeInteger(cacheBudgetBytes) ||
      cacheBudgetBytes < 0
    ) {
      throw new TypeError(
        'AnnData adapter cache budget must be a non-negative safe integer.'
      );
    }
    this._cacheBudgetBytes = BigInt(cacheBudgetBytes);
  }

  /**
   * Capture the active adapter generation before starting asynchronous work.
   * @returns {number}
   * @private
   */
  _captureLifecycleGeneration() {
    if (this._closed) {
      throw new Error(
        'AnnData adapter is closed; reopen the dataset before requesting data'
      );
    }
    return this._lifecycleGeneration;
  }

  /**
   * Reject work that completed after its adapter was cleared or closed.
   * @param {number} generation
   * @private
   */
  _assertLifecycleGeneration(generation) {
    if (this._closed || generation !== this._lifecycleGeneration) {
      throw new Error(
        'AnnData adapter dataset changed, was cleared, or was closed while loading; start a new request against the active dataset'
      );
    }
  }

  /**
   * Share one cold computation per public key while preserving lifecycle
   * invalidation and independent later-caller ownership.
   *
   * Settlement cleanup is identity-checked because clearCaches() detaches the
   * stale registry immediately. A later caller may install a new promise for
   * the same key before the earlier promise settles.
   *
   * The operation receives the shared cancellation signal of its callers so a
   * cancelled request stops its work instead of only stopping its wait. A
   * cancelled entry is never joined by a later caller: that caller starts a
   * fresh computation, so cancelling one request can never poison the next.
   *
   * @param {Map<any, {cancellation: CoalescedCancellationOwner, promise: Promise<any>}>} registry
   * @param {any} key
   * @param {number} generation
   * @param {(workSignal: AbortSignal) => Promise<any>|any} operation
   * @param {AbortSignal|null} [callerSignal] - Exact owner signal or no owner
   * @returns {Promise<any>}
   * @private
   */
  _coalesceInFlight(
    registry,
    key,
    generation,
    operation,
    callerSignal = null
  ) {
    const existing = registry.get(key);
    let entry = existing;
    if (!entry || entry.cancellation.cancelled) {
      const cancellation = new CoalescedCancellationOwner();
      const pending = Promise.resolve().then(() => {
        this._assertLifecycleGeneration(generation);
        return operation(cancellation.signal);
      });
      entry = { cancellation, promise: pending };
      registry.set(key, entry);

      const removeSettled = () => {
        if (registry.get(key) === entry) {
          registry.delete(key);
        }
      };
      pending.then(removeSettled, removeSettled);
    }

    const release = entry.cancellation.join(callerSignal);
    return entry.promise.then(
      result => {
        release();
        return result;
      },
      error => {
        release();
        throw error;
      }
    );
  }

  /**
   * @param {string} embeddingId
   * @returns {string}
   * @private
   */
  _embeddingCoordinateCacheKey(embeddingId) {
    return JSON.stringify(['embedding', embeddingId]);
  }

  /**
   * @param {string} vectorPath - A mapping vector route.
   * @returns {string}
   * @private
   */
  _vectorCoordinateCacheKey(vectorPath) {
    return JSON.stringify(['vector', vectorPath]);
  }

  /**
   * Keep an exact cache entry from being evicted while a public request is
   * constructing or returning it. The captured state identity makes releases
   * from an invalidated generation harmless after clearCaches().
   *
   * @param {string} cacheKey
   * @returns {() => void}
   * @private
   */
  _pinCoordinateCacheKey(cacheKey) {
    let pinState = this._coordinateCachePins.get(cacheKey);
    if (!pinState) {
      pinState = new Set();
      this._coordinateCachePins.set(cacheKey, pinState);
    }
    const token = {};
    pinState.add(token);

    return () => {
      if (this._coordinateCachePins.get(cacheKey) !== pinState) {
        return;
      }
      pinState.delete(token);
      if (pinState.size === 0) {
        this._coordinateCachePins.delete(cacheKey);
      }
    };
  }

  /**
   * @param {string} cacheKey
   * @returns {boolean}
   * @private
   */
  _isCoordinateCacheKeyPinned(cacheKey) {
    return (this._coordinateCachePins.get(cacheKey)?.size || 0) > 0;
  }

  /**
   * @param {Float32Array|ArrayBufferView} value
   * @returns {{ identity: Object, bytes: bigint }}
   * @private
   */
  _describeCoordinateBuffer(value) {
    if (!value || typeof value !== 'object') {
      throw new Error('Coordinate cache result is not a typed buffer.');
    }
    const backingBuffer = value.buffer;
    const identity = (
      backingBuffer &&
      typeof backingBuffer === 'object'
    ) ? backingBuffer : value;
    const byteLength = Number(
      identity === backingBuffer
        ? backingBuffer.byteLength
        : value.byteLength
    );
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error(
        'Coordinate cache result has an invalid retained byte length.'
      );
    }
    return { identity, bytes: BigInt(byteLength) };
  }

  /**
   * @param {number} length
   * @param {string} label
   * @returns {bigint}
   * @private
   */
  _checkedCoordinateResultBytes(length, label) {
    const valueCount = Number(length);
    if (!Number.isSafeInteger(valueCount) || valueCount < 0) {
      throw new Error(`${label} has an invalid result length.`);
    }
    return BigInt(valueCount) *
      BigInt(Float32Array.BYTES_PER_ELEMENT);
  }

  /**
   * @param {string} cacheKey
   * @param {Float32Array} [expected]
   * @returns {boolean}
   * @private
   */
  _deleteCoordinateCacheEntry(cacheKey, expected = undefined) {
    const entry = this._coordinateCacheLru.get(cacheKey);
    if (!entry || (expected !== undefined && entry.value !== expected)) {
      return false;
    }
    this._coordinateCacheLru.delete(cacheKey);

    if (entry.kind === 'embedding') {
      if (this._embeddingCache.get(entry.embeddingId) === entry.value) {
        this._embeddingCache.delete(entry.embeddingId);
      }
    } else if (this._vectorFieldCache.get(entry.vectorPath) === entry.value) {
      this._vectorFieldCache.delete(entry.vectorPath);
    }

    const bufferRef =
      this._coordinateBufferRefs.get(entry.bufferIdentity);
    if (bufferRef) {
      bufferRef.references--;
      if (bufferRef.references <= 0) {
        this._coordinateBufferRefs.delete(entry.bufferIdentity);
        this._coordinateCacheBytes -= bufferRef.bytes;
        if (this._coordinateCacheBytes < 0n) {
          this._coordinateCacheBytes = 0n;
        }
      }
    }
    return true;
  }

  /**
   * Refresh one exact entry in the cross-kind LRU.
   *
   * @param {string} cacheKey
   * @param {Float32Array} value
   * @private
   */
  _touchCoordinateCacheEntry(cacheKey, value) {
    const entry = this._coordinateCacheLru.get(cacheKey);
    if (!entry || entry.value !== value) return;
    this._coordinateCacheLru.delete(cacheKey);
    this._coordinateCacheLru.set(cacheKey, entry);
  }

  /**
   * Evict unpinned LRU entries until the requested distinct bytes fit.
   *
   * @param {bigint} additionalBytes
   * @param {string} label
   * @private
   */
  _makeCoordinateCacheRoom(additionalBytes) {
    // The budget decides what is evicted, never what loads: coordinates in
    // use stay pinned, and an entry larger than the budget is still admitted.
    while (
      this._coordinateCacheBytes +
        this._coordinateReservedOutputBytes +
        additionalBytes >
      this._cacheBudgetBytes
    ) {
      let victimKey = null;
      for (const cacheKey of this._coordinateCacheLru.keys()) {
        if (!this._isCoordinateCacheKeyPinned(cacheKey)) {
          victimKey = cacheKey;
          break;
        }
      }
      if (victimKey == null) return;
      this._deleteCoordinateCacheEntry(victimKey);
    }
  }

  /**
   * Register one loader-owned raw coordinate buffer and reserve the exact
   * normalized Float32 output before normalization allocates it. Raw buffers
   * that alias a retained or concurrent buffer share one reference-counted
   * byte owner.
   *
   * @param {ArrayBufferView} raw
   * @param {bigint} outputBytes
   * @param {string} label
   * @returns {Object}
   * @private
   */
  _reserveCoordinateMaterialization(raw, outputBytes, label) {

    const descriptor = this._describeCoordinateBuffer(raw);
    let bufferRef =
      this._coordinateBufferRefs.get(descriptor.identity);
    if (bufferRef) {
      bufferRef.references++;
    } else {
      bufferRef = {
        bytes: descriptor.bytes,
        references: 1
      };
      this._coordinateBufferRefs.set(
        descriptor.identity,
        bufferRef
      );
      this._coordinateCacheBytes += descriptor.bytes;
    }

    const reservation = {
      active: true,
      bufferIdentity: descriptor.identity,
      bufferRef,
      outputBytes,
      outputReserved: false,
      state: this._coordinateReservationState
    };

    try {
      this._makeCoordinateCacheRoom(outputBytes);
      this._coordinateReservedOutputBytes += outputBytes;
      reservation.outputReserved = true;
      return reservation;
    } catch (error) {
      this._releaseCoordinateMaterialization(reservation);
      throw error;
    }
  }

  /**
   * Convert a planned output reservation into an identity-accounted retained
   * buffer without exposing an unreserved scheduling gap.
   *
   * @param {Object} reservation
   * @private
   */
  _consumeCoordinateOutputReservation(reservation) {
    if (
      !reservation?.active ||
      !reservation.outputReserved ||
      reservation.state !== this._coordinateReservationState
    ) {
      throw new Error(
        'Coordinate materialization reservation was invalidated'
      );
    }
    this._coordinateReservedOutputBytes -=
      reservation.outputBytes;
    if (this._coordinateReservedOutputBytes < 0n) {
      this._coordinateReservedOutputBytes = 0n;
    }
    reservation.outputReserved = false;
  }

  /**
   * Release one exact transient reservation. State and buffer identities keep
   * stale finally blocks harmless after clearCaches() replaces the owner.
   *
   * @param {Object|null} reservation
   * @private
   */
  _releaseCoordinateMaterialization(reservation) {
    if (!reservation?.active) return;
    reservation.active = false;
    if (reservation.state !== this._coordinateReservationState) {
      return;
    }

    if (reservation.outputReserved) {
      this._coordinateReservedOutputBytes -=
        reservation.outputBytes;
      if (this._coordinateReservedOutputBytes < 0n) {
        this._coordinateReservedOutputBytes = 0n;
      }
      reservation.outputReserved = false;
    }

    const bufferRef = this._coordinateBufferRefs.get(
      reservation.bufferIdentity
    );
    if (bufferRef !== reservation.bufferRef) return;
    bufferRef.references--;
    if (bufferRef.references <= 0) {
      this._coordinateBufferRefs.delete(
        reservation.bufferIdentity
      );
      this._coordinateCacheBytes -= bufferRef.bytes;
      if (this._coordinateCacheBytes < 0n) {
        this._coordinateCacheBytes = 0n;
      }
    }
  }

  /**
   * Publish one result into its public cache and the shared byte/LRU owner.
   *
   * @param {Object} options
   * @param {string} options.cacheKey
   * @param {'embedding'|'vector'} options.kind
   * @param {string} options.embeddingId
   * @param {string} [options.vectorPath]
   * @param {Float32Array} options.value
   * @param {string} options.label
   * @private
   */
  _retainCoordinateCacheEntry({
    cacheKey,
    kind,
    embeddingId,
    vectorPath = null,
    value,
    label
  }) {
    const descriptor = this._describeCoordinateBuffer(value);
    const existingRef =
      this._coordinateBufferRefs.get(descriptor.identity);
    const additionalBytes = existingRef ? 0n : descriptor.bytes;
    this._makeCoordinateCacheRoom(additionalBytes);

    this._deleteCoordinateCacheEntry(cacheKey);
    if (kind === 'embedding') {
      this._embeddingCache.set(embeddingId, value);
    } else {
      this._vectorFieldCache.set(vectorPath, value);
    }

    const bufferRef =
      this._coordinateBufferRefs.get(descriptor.identity);
    if (bufferRef) {
      bufferRef.references++;
    } else {
      this._coordinateBufferRefs.set(descriptor.identity, {
        bytes: descriptor.bytes,
        references: 1
      });
      this._coordinateCacheBytes += descriptor.bytes;
    }
    this._coordinateCacheLru.set(cacheKey, {
      bufferIdentity: descriptor.identity,
      cacheKey,
      embeddingId,
      vectorPath,
      kind,
      value
    });
  }

  /**
   * Reset all coordinate-cache ownership after lifecycle invalidation.
   *
   * @private
   */
  _resetCoordinateCacheOwner() {
    this._coordinateCacheLru.clear();
    this._coordinateBufferRefs.clear();
    this._coordinateCachePins.clear();
    this._coordinateCacheBytes = 0n;
    this._coordinateReservedOutputBytes = 0n;
    this._coordinateReservationState = {};
  }

  /**
   * Initialize the adapter and compute metadata.
   *
   * The loader describes the file from metadata alone. The adapter then
   * resolves which embedding each dimension shows -- the default rule, else
   * the best guess, whose candidates must pass the load-time check -- and
   * assembles the data-mapping candidate catalog the panel lists.
   *
   * @returns {Promise<void>}
   */
  async initialize() {
    const generation = this._captureLifecycleGeneration();
    try {
      const metadata = await this._loader.getDatasetMetadata();
      this._assertLifecycleGeneration(generation);
      if (
        !Number.isSafeInteger(this._loader.nObs) ||
        this._loader.nObs <= 0
      ) {
        throw new Error(
          'AnnData datasets must contain at least one observation'
        );
      }
      const described = describeAnnDataProbes(metadata?.probes);
      if (described.nObs !== this._loader.nObs) {
        throw new Error(
          'AnnData mapping probes must describe the loader cell axis exactly'
        );
      }
      this._metadata = metadata;
      this._describedObsm = described.obsm;
      await this._computeObsFieldsMetadata(generation);
      this._assertLifecycleGeneration(generation);

      const resolution = await this._resolveEmbeddingSlots(described, generation);
      this._slots = Object.freeze({ ...resolution.slots });
      this._candidates = assembleAnnDataCandidates(described, resolution);
      await this._computeVectorFieldsMetadata(generation);
      this._assertLifecycleGeneration(generation);

      // Candidate sources are adopted only after initialize() resolves.
      // Validate the default dimension's embedding payload here so corrupt
      // bytes cannot replace and close a still-working dataset.
      const defaultSlot = [...DIMENSION_SLOTS]
        .reverse()
        .find(slot => this._slots[slot] !== null);
      await this.getEmbeddingForRef(this._slots[defaultSlot]);
      this._assertLifecycleGeneration(generation);
    } catch (error) {
      if (
        !this._closed &&
        generation === this._lifecycleGeneration
      ) {
        this._metadata = null;
        this._slots = null;
        this._candidates = null;
        this._describedObsm = null;
        this._vectorBindings.clear();
        this._obsFieldsMetadata = null;
        this.clearCaches();
      }
      throw error;
    }
  }

  /**
   * Resolve the embedding of every dimension slot, or refuse the file when
   * nothing in `obsm` can be plotted.
   *
   * @param {ReturnType<typeof describeAnnDataProbes>} described
   * @param {number} generation
   * @returns {Promise<{slots: Object, guessed: string[], rejected: Array<[string, string]>}>}
   * @private
   */
  async _resolveEmbeddingSlots(described, generation) {
    const loadCheck = async (key, columns) => {
      try {
        await this.getEmbeddingForRef({ key, columns });
        return null;
      } catch (error) {
        if (error instanceof EmbeddingLoadError) return error.reason;
        throw error;
      }
    };
    const resolution = await resolveEmbeddingSlotsAsync(
      obsmEntries(described.obsm),
      loadCheck
    );
    this._assertLifecycleGeneration(generation);
    if (DIMENSION_SLOTS.every(slot => resolution.slots[slot] === null)) {
      const rejected = new Map(resolution.rejected);
      const descriptions = described.obsm.map(item => describeObsmEntry({
        key: item.key,
        storage: item.storage,
        shape: item.shape,
        defect: obsmEntryDefect(item, { latentKey: null, rejected }),
      }));
      throw new DataSourceError(
        nothingPlottableMessage({ nObs: described.nObs, descriptions }),
        DataSourceErrorCode.NO_PLOTTABLE_EMBEDDING,
        this.constructor.sourceType ?? undefined
      );
    }
    return resolution;
  }

  /**
   * Record the vector fields the data-mapping default binds, without loading
   * the vector arrays.
   *
   * The rule is the data-mapping default (`defaultVectorBindings` in
   * `data-mapping.js`, the same rule `cellucid serve` applies): a key
   * `<field>_umap_<d>d` is the vector field `<field>_umap`, bound to the
   * `d`-dimensional slot embedding only when that slot shows `X_umap_<d>d` or
   * `X_umap`. A bound key must be a dense array of exactly `d` columns.
   *
   * @param {number} [generation]
   * @protected
   */
  async _computeVectorFieldsMetadata(
    generation = this._captureLifecycleGeneration()
  ) {
    this._vectorBindings.clear();
    const bindings = this._candidates.defaults.vectorFields;
    const byField = new Map();
    for (const binding of bindings) {
      const match = VECTOR_KEY_PATTERN.exec(binding.key);
      const fieldId = match.groups.field;
      const dimension = binding.embedding.columns.length;
      const item = this._candidates.obsm.find(entry => entry.key === binding.key);
      if (obsmWidth(item) !== dimension) {
        throw new Error(
          `Vector field '${binding.key}' has ${obsmWidth(item)} columns, ` +
          `but its ${dimension}D suffix requires exactly ${dimension}`
        );
      }
      const embeddingId = this._embeddingIdOf(binding.embedding);
      let keys = byField.get(fieldId);
      if (keys === undefined) {
        keys = new Map();
        byField.set(fieldId, keys);
      }
      keys.set(embeddingId, binding.key);
    }
    this._assertLifecycleGeneration(generation);
    for (const fieldId of [...byField.keys()].sort(compareCodePoints)) {
      this._vectorBindings.set(fieldId, byField.get(fieldId));
    }
  }

  /**
   * The embedding id of one `{key, columns}` reference: the key when the
   * array is read whole, else `key[c0,c1]`.
   *
   * @param {{key: string, columns: ReadonlyArray<number>}} ref
   * @returns {string}
   * @private
   */
  _embeddingIdOf(ref) {
    const item = this._describedObsm?.find(entry => entry.key === ref.key);
    if (item === undefined) {
      throw new RangeError(`obsm['${ref.key}'] does not exist in this file`);
    }
    return canonicalEmbeddingId(ref.key, ref.columns, { width: obsmWidth(item) });
  }

  /**
   * The data-mapping candidate catalog of this file, the same document
   * `cellucid serve` publishes at `_cellucid/mapping/candidates.json`.
   *
   * @returns {Object}
   */
  getMappingCandidates() {
    if (this._candidates === null) {
      throw new Error('AnnData data-mapping candidates are not initialized');
    }
    return this._candidates;
  }

  /**
   * Compute obs field metadata (to be overridden by subclasses if needed)
   * @protected
   * @returns {Promise<void>}
   */
  async _computeObsFieldsMetadata(
    generation = this._captureLifecycleGeneration()
  ) {
    const obsFieldsMetadata = [];
    this._obsFieldsMetadata = null;

    for (const key of this._loader.obsKeys) {
      const fieldInfo = await this._loader.getObsFieldInfo(key);
      this._assertLifecycleGeneration(generation);

      if (fieldInfo.dtype === 'categorical') {
        validateCellucidCategories(fieldInfo.categories, key);
        obsFieldsMetadata.push({
          key,
          kind: 'category',
          categories: fieldInfo.categories,
          ordered: fieldInfo.ordered,
        });
      } else if (fieldInfo.dtype === 'float' || fieldInfo.dtype === 'int' || fieldInfo.dtype === 'uint') {
        obsFieldsMetadata.push({
          key,
          kind: 'continuous',
          min: null,
          max: null,
        });
      } else if (fieldInfo.dtype === 'string' || fieldInfo.dtype === 'bool') {
        // String/bool treated as categorical. Loading is part of validation:
        // malformed supported fields must abort candidate source adoption.
        let field = null;
        try {
          field = await this._loader.getObsField(key);
          this._assertLifecycleGeneration(generation);
          const categories =
            this._discoverPrimitiveCategories(field.values, key);
          validateCellucidCategories(categories, key);
          obsFieldsMetadata.push({
            key,
            kind: 'category',
            categories,
            _needsCodeComputation: true,
          });
        } finally {
          this._releaseLoaderObsField(key, field);
        }
      } else {
        throw new Error(
          `Observation field '${key}' has unsupported dtype '${fieldInfo.dtype}'`
        );
      }
    }

    this._assertLifecycleGeneration(generation);
    this._obsFieldsMetadata = obsFieldsMetadata;

    // Update metadata with field info
    this._metadata.obs_fields = obsFieldsMetadata.map(f => ({
      key: f.key,
      kind: f.kind,
      n_categories: f.kind === 'category' ? f.categories?.length : undefined,
      ...(typeof f.ordered === 'boolean'
        ? { ordered: f.ordered }
        : {}),
    }));

    const nCategorical = obsFieldsMetadata.filter(f => f.kind === 'category').length;
    const nContinuous = obsFieldsMetadata.filter(f => f.kind === 'continuous').length;
    this._metadata.stats.n_categorical_fields = nCategorical;
    this._metadata.stats.n_continuous_fields = nContinuous;
  }

  /**
   * Discover primitive categories without whole-column filter/spread/map
   * copies. The scan stops at the first unsupported unique count and accounts
   * for the raw values plus Set/array/sort workspace as it grows.
   *
   * @param {ArrayLike<unknown>} values
   * @param {string} key
   * @returns {(string|number|boolean)[]}
   * @private
   */
  _discoverPrimitiveCategories(values, key) {
    const length = Number(values?.length);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error(
        `Observation field '${key}' has an invalid values length`
      );
    }

    const categories = [];
    const seen = new Set();

    for (let index = 0; index < length; index++) {
      const value = values[index];
      if (value == null) continue;

      const type = typeof value;
      if (
        type !== 'string' &&
        type !== 'number' &&
        type !== 'boolean'
      ) {
        throw new Error(
          `Observation field '${key}' has an unsupported category label type`
        );
      }
      if (type === 'number' && !Number.isFinite(value)) {
        throw new Error(
          `Observation field '${key}' has a non-finite numeric category label`
        );
      }

      if (seen.has(value)) continue;
      validateCellucidCategoryCount(categories.length + 1, key);
      seen.add(value);
      categories.push(value);
    }

    if (categories.every(category => typeof category === 'string')) {
      categories.sort();
    } else {
      categories.sort(comparePrimitiveCategories);
    }
    validateCellucidCategories(categories, key);
    return categories;
  }

  /**
   * Release a loader-owned observation payload only if it is still the exact
   * value returned to this operation.
   *
   * @param {string} key
   * @param {Object|null} field
   * @private
   */
  _releaseLoaderObsField(key, field) {
    if (!field) return;
    this._loader.releaseObsField?.(key, field);
  }

  /**
   * Estimate bytes uniquely retained by one lazy observation result (its
   * per-cell array; category dictionaries are shared with the metadata).
   *
   * @param {Object} result
   * @returns {bigint}
   * @private
   */
  _estimateObsFieldDataBytes(result) {
    const values = result?.kind === 'category'
      ? result.codes
      : result?.values;
    if (!values) return 0n;
    if (Number.isSafeInteger(values.byteLength)) {
      return BigInt(values.byteLength);
    }
    const length = Number(values.length);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error('Observation field has an invalid retained length');
    }
    return BigInt(length) * JS_ARRAY_ELEMENT_BYTES;
  }

  /**
   * Remove one exact cache entry and its accounting. Identity checking keeps
   * an older operation from evicting a newer independent result.
   *
   * @param {string} key
   * @param {Object} [expected]
   * @private
   */
  _deleteObsFieldDataCache(key, expected = undefined) {
    const cached = this._obsFieldDataCache.get(key);
    if (expected !== undefined && cached !== expected) return false;
    if (cached === undefined && !this._obsFieldDataCache.has(key)) {
      return false;
    }
    this._obsFieldDataCache.delete(key);
    this._obsFieldDataCacheBytes -=
      this._estimateObsFieldDataBytes(cached);
    if (this._obsFieldDataCacheBytes < 0n) {
      this._obsFieldDataCacheBytes = 0n;
    }
    return true;
  }

  /**
   * Retain one lazy result, evicting least-recently-used entries (Map
   * iteration order) while the cache is over its residency budget.
   *
   * @param {string} key
   * @param {Object} result
   * @private
   */
  _cacheObsFieldData(key, result) {
    const resultBytes = this._estimateObsFieldDataBytes(result);

    this._deleteObsFieldDataCache(key);
    while (
      this._obsFieldDataCache.size > 0 &&
      this._obsFieldDataCacheBytes + resultBytes > this._cacheBudgetBytes
    ) {
      const oldestKey = this._obsFieldDataCache.keys().next().value;
      this._deleteObsFieldDataCache(oldestKey);
    }

    this._obsFieldDataCache.set(key, result);
    this._obsFieldDataCacheBytes += resultBytes;
  }

  /**
   * Get or compute full field data (lazy loading)
   * @param {string} key - Field name
   * @returns {Promise<Object>}
   * @protected
   */
  async _getOrLoadFieldData(key) {
    const generation = this._captureLifecycleGeneration();
    if (this._obsFieldDataCache.has(key)) {
      const cached = this._obsFieldDataCache.get(key);
      // Refresh least-recently-used order without changing byte ownership.
      this._obsFieldDataCache.delete(key);
      this._obsFieldDataCache.set(key, cached);
      return cached;
    }

    const meta = this._obsFieldsMetadata.find(f => f.key === key);
    if (!meta) {
      throw new Error(`Obs field '${key}' not found`);
    }

    if (
      meta.kind === 'category' &&
      !meta._needsCodeComputation &&
      Array.isArray(meta.categories)
    ) {
      this._loader.seedObsFieldCategories?.(
        key,
        meta.categories,
        meta.ordered
      );
    }
    const field = await this._loader.getObsField(key);
    try {
      this._assertLifecycleGeneration(generation);
      let result;

      if (meta.kind === 'continuous') {
        const values = field.values;
        let min = Infinity, max = -Infinity;

        const len = values.length;
        for (let i = 0; i < len; i++) {
          const v = values[i];
          if (Number.isFinite(v)) {
            if (v < min) min = v;
            if (v > max) max = v;
          }
        }

        if (min === Infinity || max === -Infinity) {
          throw new Error(
            `Continuous observation field '${key}' contains no finite values`
          );
        }
        meta.min = min;
        meta.max = max;

        result = {
          kind: 'continuous',
          values: values instanceof Float32Array ? values : new Float32Array(values),
          min: meta.min,
          max: meta.max,
        };
      } else {
        // Categorical
        let codes, categories;
        if (
          !meta._needsCodeComputation &&
          (field.dtype !== 'categorical' || !field.codes)
        ) {
          throw new Error(
            `Categorical observation field '${key}' no longer matches its ` +
            'adopted categorical storage'
          );
        }
        if (
          meta._needsCodeComputation &&
          (
            (field.dtype !== 'string' && field.dtype !== 'bool') ||
            !field.values
          )
        ) {
          throw new Error(
            `Categorical observation field '${key}' no longer matches its ` +
            'adopted primitive storage'
          );
        }
        if (!meta._needsCodeComputation) {
          validateCellucidCategories(field.categories, key);
          if (
            field.categories.length !== meta.categories.length ||
            field.categories.some(
              (category, index) => category !== meta.categories[index]
            )
          ) {
            throw new Error(
              `Categorical observation field '${key}' changed its category ` +
              'dictionary after metadata adoption'
            );
          }
          codes = field.codes;
          categories = meta.categories;
        } else {
          // Need to compute codes from values
          categories = meta.categories;
          const valueCount = Number(field.values?.length);
          if (!Number.isSafeInteger(valueCount) || valueCount < 0) {
            throw new Error(
              `Observation field '${key}' has an invalid values length`
            );
          }
          const categoryMap = new Map();
          for (let index = 0; index < categories.length; index++) {
            categoryMap.set(categories[index], index);
          }
          codes = new Int32Array(valueCount);
          for (let i = 0; i < valueCount; i++) {
            const v = field.values[i];
            if (v == null) {
              codes[i] = -1;
              continue;
            }
            const code = categoryMap.get(v);
            if (code === undefined) {
              throw new Error(
                `Observation field '${key}' contains undeclared category ` +
                `at index ${i}`
              );
            }
            codes[i] = code;
          }
        }

        result = {
          kind: 'category',
          categories,
          codes,
          ...(typeof field.ordered === 'boolean'
            ? { ordered: field.ordered }
            : {}),
        };
      }

      this._cacheObsFieldData(key, result);
      return result;
    } finally {
      this._releaseLoaderObsField(key, field);
    }
  }

  /**
   * Get dataset metadata
   * @returns {Object}
   */
  getMetadata() {
    return this._metadata;
  }

  /**
   * Return the immutable connectivity summary owned by finalized identity
   * validation. This method never reads or populates the edge cache.
   *
   * @returns {Readonly<Object>|null}
   */
  getConnectivityManifest() {
    if (
      !this._directIdentityFinalized ||
      this._connectivityManifest === undefined
    ) {
      throw new Error(
        'Direct AnnData connectivity metadata is not finalized'
      );
    }
    return this._connectivityManifest;
  }

  /**
   * Build and validate the one public direct-AnnData dataset identity.
   * Loader-only obsm resolution remains private to this adapter.
   *
   * @param {Object} descriptor
   * @param {string} descriptor.id
   * @param {string} descriptor.name
   * @param {string} descriptor.description
   * @param {string} descriptor.cellucidDataVersion
   * @param {Object} descriptor.source
   * @returns {Promise<Object>}
   */
  async finalizeDirectIdentity({
    id,
    name,
    description,
    cellucidDataVersion,
    source,
  }) {
    const generation = this._captureLifecycleGeneration();
    if (this._directIdentityFinalized) {
      throw new Error(
        'Direct AnnData identity is already finalized for this adapter'
      );
    }
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof name !== 'string' ||
      name.length === 0 ||
      typeof description !== 'string' ||
      typeof cellucidDataVersion !== 'string' ||
      cellucidDataVersion.length === 0 ||
      !source ||
      typeof source !== 'object' ||
      Array.isArray(source)
    ) {
      throw new TypeError(
        'Direct AnnData identity descriptor is incomplete'
      );
    }

    if (this._slots === null) {
      throw new Error('Direct AnnData embeddings are not resolved');
    }
    const resolved = [];
    for (const slot of DIMENSION_SLOTS) {
      const ref = this._slots[slot];
      if (ref === null) continue;
      resolved.push({
        id: this._embeddingIdOf(ref),
        dimension: ref.columns.length,
        key: ref.key,
        columns: [...ref.columns],
      });
    }
    if (resolved.length === 0) {
      throw new Error(
        'Direct AnnData identity requires at least one embedding'
      );
    }
    resolved.sort((left, right) =>
      left.dimension - right.dimension || compareCodePoints(left.id, right.id)
    );
    // A dataset opened straight from AnnData is not an export and records no
    // export_settings, so its payload paths are uncompressed.
    const items = {};
    const defaults = {};
    resolved.forEach((embedding, index) => {
      items[embedding.id] = {
        label: embedding.id,
        dimension: embedding.dimension,
        file: embeddingPayloadPath(index, embedding.dimension, null),
        source: { key: embedding.key, columns: [...embedding.columns] },
      };
      defaults[dimensionSlot(embedding.dimension)] = embedding.id;
    });
    const embeddingIndexById = new Map(
      resolved.map((embedding, index) => [embedding.id, index])
    );

    const edges = await this.getConnectivityEdges();
    this._assertLifecycleGeneration(generation);
    const hasConnectivity = edges !== null;
    const connectivityManifest = hasConnectivity
      ? {
          format: 'edge_pairs',
          n_cells: edges.nCells,
          n_edges: edges.nEdges,
          max_neighbors: edges.maxNeighbors,
          index_dtype: 'uint32',
          index_bytes: Uint32Array.BYTES_PER_ELEMENT,
        }
      : null;
    validateConnectivityManifest(
      connectivityManifest,
      CONNECTIVITY_MANIFEST_CONTEXT.DIRECT
    );
    // The gene count of the gene list the file opens with (raw.X has its own).
    const varManifest = await this.getVarManifest();
    this._assertLifecycleGeneration(generation);
    const obsManifest = this.getObsManifest();
    const obsFields = [
      // Element 0 of every entry is the payload index; the key is element 1.
      ...obsManifest._continuousFields.map(([, key]) => ({
        key,
        kind: 'continuous',
      })),
      ...obsManifest._categoricalFields.map(([
        ,
        key,
        categories,
      ]) => {
        return {
          key,
          kind: 'category',
          n_categories: categories.length,
        };
      }),
    ];

    let vectorFields;
    if (this._vectorBindings.size > 0) {
      const fields = {};
      let fieldIndex = 0;
      for (const [fieldId, keysByEmbedding] of this._vectorBindings) {
        const bound = [...keysByEmbedding.keys()]
          .sort((left, right) =>
            embeddingIndexById.get(left) - embeddingIndexById.get(right)
          );
        const files = {};
        for (const embeddingId of bound) {
          files[embeddingId] = vectorPayloadPath(
            fieldIndex,
            embeddingIndexById.get(embeddingId),
            null
          );
        }
        fields[fieldId] = { label: fieldId, files };
        fieldIndex++;
      }
      const fieldIds = Object.keys(fields);
      vectorFields = {
        default_field: fieldIds.length === 1 ? fieldIds[0] : null,
        fields,
      };
    }

    const identity = {
      version: 3,
      id,
      name,
      description,
      cellucid_data_version: cellucidDataVersion,
      stats: {
        n_cells: this._loader.nObs,
        n_genes: varManifest.fields.length,
        n_obs_fields: obsFields.length,
        n_categorical_fields: obsFields.filter(
          field => field.kind === 'category'
        ).length,
        n_continuous_fields: obsFields.filter(
          field => field.kind === 'continuous'
        ).length,
        has_connectivity: hasConnectivity,
        n_edges: hasConnectivity ? edges.nEdges : null,
      },
      embeddings: {
        default_dimension: resolved[resolved.length - 1].dimension,
        defaults,
        items,
      },
      obs_fields: obsFields,
      source: { ...source },
      ...(vectorFields ? { vector_fields: vectorFields } : {}),
    };
    validateDatasetIdentity(identity, id, 'direct-anndata');
    this._assertLifecycleGeneration(generation);
    this._connectivityManifest = connectivityManifest === null
      ? null
      : Object.freeze(connectivityManifest);
    this._metadata = identity;
    this._identityEmbeddings = Object.freeze(resolved.map(embedding => Object.freeze({
      id: embedding.id,
      dimension: embedding.dimension,
      ref: Object.freeze({ key: embedding.key, columns: Object.freeze([...embedding.columns]) }),
    })));
    this._directIdentityFinalized = true;
    return identity;
  }

  /**
   * The normalized coordinates of one stored embedding payload, by its path
   * under the dataset base: `embeddings/{i}_{d}d.bin` names item `i` of the
   * published identity, and `_cellucid/mapping/embeddings/{obsm}/{cols}.bin`
   * names `obsm` entry `obsm` of the candidate catalog read at `cols`. The
   * bytes are the ones a prepared export or `cellucid serve` publishes for the
   * same array.
   *
   * The caller owns the returned array, exactly as it owns a fetched payload:
   * the DimensionManager normalizes it in place for display and releases it
   * when it evicts the layout. The adapter therefore hands over its cached
   * copy and drops its own reference, so it never keeps (or hands out again)
   * an array a caller may already have rewritten, and an eviction frees the
   * memory instead of leaving it held here.
   *
   * @param {string} path
   * @param {number} dimension - The dimension the caller's layout declares.
   * @returns {Promise<Float32Array>}
   */
  async getEmbeddingPayload(path, dimension) {
    let ref;
    const identityMatch = /^embeddings\/(0|[1-9][0-9]*)_([123])d\.bin$/.exec(path);
    if (identityMatch !== null) {
      const item = this._identityEmbeddings?.[Number(identityMatch[1])];
      if (item === undefined || item.dimension !== Number(identityMatch[2])) {
        throw new RangeError(`This dataset has no embedding payload '${path}'.`);
      }
      ref = item.ref;
    } else {
      const route = parseMappingEmbeddingPath(path);
      const item = route === null ? undefined : this._candidates?.obsm[route.obsmIndex];
      if (item === undefined) {
        throw new RangeError(`This dataset has no embedding payload '${path}'.`);
      }
      ref = { key: item.key, columns: route.columns };
    }
    if (ref.columns.length !== dimension) {
      throw new RangeError(
        `Embedding payload '${path}' holds ${ref.columns.length}D coordinates, not ${dimension}D.`
      );
    }
    const embedding = await this.getEmbeddingForRef(ref);
    const coordinateCacheKey = this._embeddingCoordinateCacheKey(
      this._resolveEmbeddingRef(ref).embeddingId
    );
    if (this._deleteCoordinateCacheEntry(coordinateCacheKey, embedding)) {
      return embedding;
    }
    // Another caller of the same computation was handed the cached array
    // first. Every caller sharing one computation resumes in the same turn,
    // before any of them can write to it, so this copy is still the payload.
    return new Float32Array(embedding);
  }

  /**
   * The checked columns and canonical embedding id of one `obsm` reference.
   *
   * @param {{key: string, columns: ReadonlyArray<number>}} ref
   * @returns {{columns: ReadonlyArray<number>, dimension: number, embeddingId: string}}
   * @private
   */
  _resolveEmbeddingRef(ref) {
    if (this._describedObsm === null) {
      throw new Error('AnnData obsm entries are not described yet');
    }
    const dimension = ref.columns.length;
    const resolved = resolveCandidateRef({ obsm: this._describedObsm }, ref, dimension);
    if (!resolved.ok) {
      throw new RangeError(`Cannot plot this embedding: ${resolved.reason}.`);
    }
    const columns = resolved.columns;
    return {
      columns,
      dimension,
      embeddingId: canonicalEmbeddingId(ref.key, columns, { width: resolved.width })
    };
  }

  /**
   * Read, check and normalize the selected columns of one `obsm` array.
   *
   * The columns must be finite, representable as float32 and span a non-zero
   * range (`embeddingLoadDefect`); otherwise an `EmbeddingLoadError` names the
   * first offending cell. The normalized result is cached by its embedding id.
   *
   * @param {{key: string, columns: ReadonlyArray<number>}} ref
   * @returns {Promise<Float32Array>}
   */
  async getEmbeddingForRef(ref) {
    const generation = this._captureLifecycleGeneration();
    const { columns, dimension, embeddingId } = this._resolveEmbeddingRef(ref);
    const coordinateCacheKey = this._embeddingCoordinateCacheKey(embeddingId);
    const releasePin = this._pinCoordinateCacheKey(coordinateCacheKey);

    try {
      if (this._embeddingCache.has(embeddingId)) {
        const cached = this._embeddingCache.get(embeddingId);
        this._touchCoordinateCacheEntry(coordinateCacheKey, cached);
        await Promise.resolve();
        this._assertLifecycleGeneration(generation);
        return cached;
      }

      return await this._coalesceInFlight(
        this._embeddingInFlight,
        embeddingId,
        generation,
        async () => {
          if (this._embeddingCache.has(embeddingId)) {
            const cached = this._embeddingCache.get(embeddingId);
            this._touchCoordinateCacheEntry(coordinateCacheKey, cached);
            this._assertLifecycleGeneration(generation);
            return cached;
          }
          const values = await this._loader.readObsmColumns(ref.key, columns);
          this._assertLifecycleGeneration(generation);
          const label = `Embedding '${embeddingId}'`;
          if (!(values instanceof Float64Array) || values.length !== this._loader.nObs * dimension) {
            throw new Error(`${label} read did not return one row per cell`);
          }
          const defect = embeddingLoadDefect(values, dimension);
          if (defect !== null) {
            throw new EmbeddingLoadError(ref.key, columns, defect);
          }
          const outputBytes = this._checkedCoordinateResultBytes(values.length, label);
          const materialization = this._reserveCoordinateMaterialization(
            values,
            outputBytes,
            label
          );
          try {
            const normalized = this._normalizeEmbedding(values, dimension, embeddingId);
            this._assertLifecycleGeneration(generation);
            this._consumeCoordinateOutputReservation(materialization);
            this._retainCoordinateCacheEntry({
              cacheKey: coordinateCacheKey,
              embeddingId,
              kind: 'embedding',
              label,
              value: normalized
            });
            return normalized;
          } catch (error) {
            if (!this._embeddingCache.has(embeddingId)) {
              this._normInfo.delete(embeddingId);
            }
            throw error;
          } finally {
            this._releaseCoordinateMaterialization(materialization);
          }
        }
      );
    } finally {
      releasePin();
    }
  }

  /**
   * The per-cell displacement vectors of one vector field bound to one
   * embedding, by its route
   * `_cellucid/mapping/vectors/{vector}/{vcols}/{embedding}/{ecols}.bin`
   * (`resolveVectorBinding`): the vector array read at `vcols`, checked
   * (finite, representable as float32) and scaled by the bound embedding's
   * normalization scale, so the vectors live in the same normalized space as
   * its positions -- the payload `cellucid serve` answers the same route with.
   *
   * @param {string} path
   * @param {number} dimension - The bound embedding's dimension, as the caller's layout declares it.
   * @returns {Promise<Float32Array>} `dimension` components per cell.
   */
  async getVectorPayload(path, dimension) {
    const generation = this._captureLifecycleGeneration();
    const route = parseMappingVectorPath(path);
    const vectorItem = route === null ? undefined : this._candidates?.obsm[route.vectorIndex];
    const embeddingItem = route === null ? undefined : this._candidates?.obsm[route.embeddingIndex];
    if (vectorItem === undefined || embeddingItem === undefined) {
      throw new RangeError(`This dataset has no vector payload '${path}'.`);
    }
    const embeddingRef = { key: embeddingItem.key, columns: route.embeddingColumns };
    const resolved = resolveVectorBinding(this._candidates, { key: vectorItem.key, embedding: embeddingRef });
    if (!resolved.ok) {
      throw new RangeError(`Cannot draw this vector field: ${resolved.reason}.`);
    }
    if (resolved.path !== path) {
      throw new RangeError(
        `obsm['${vectorItem.key}'] cannot be bound to obsm['${embeddingItem.key}'] at these columns.`
      );
    }
    if (resolved.dimension !== dimension) {
      throw new RangeError(
        `Vector payload '${path}' holds ${resolved.dimension}D vectors, not ${dimension}D.`
      );
    }
    const embeddingId = resolved.layoutKey;
    const coordinateCacheKey = this._vectorCoordinateCacheKey(path);
    const releasePin = this._pinCoordinateCacheKey(coordinateCacheKey);

    try {
      if (this._vectorFieldCache.has(path)) {
        const cached = this._vectorFieldCache.get(path);
        this._touchCoordinateCacheEntry(coordinateCacheKey, cached);
        await Promise.resolve();
        this._assertLifecycleGeneration(generation);
        return cached;
      }

      return await this._coalesceInFlight(
        this._vectorFieldInFlight,
        path,
        generation,
        async () => {
          if (this._vectorFieldCache.has(path)) {
            const cached = this._vectorFieldCache.get(path);
            this._touchCoordinateCacheEntry(coordinateCacheKey, cached);
            this._assertLifecycleGeneration(generation);
            return cached;
          }

          // The vectors share their embedding's normalization scale.
          if (!this._normInfo.has(embeddingId)) {
            await this.getEmbeddingForRef(embeddingRef);
            this._assertLifecycleGeneration(generation);
          }
          const scale = this._normInfo.get(embeddingId)?.scale;
          if (!Number.isFinite(scale) || scale <= 0) {
            throw new Error(
              `Embedding "${embeddingId}" normalization has no finite positive scale`
            );
          }

          const raw = await this._loader.readObsmColumns(vectorItem.key, route.vectorColumns);
          this._assertLifecycleGeneration(generation);
          const cacheLabel = `Vector field '${vectorItem.key}'`;
          const defect = valueLoadDefect(raw, dimension);
          if (defect !== null) {
            throw new MappingLoadError(
              vectorItem.key,
              defect,
              `${cacheLabel} cannot be drawn: ${defect}.`
            );
          }
          const outputBytes = this._checkedCoordinateResultBytes(raw.length, cacheLabel);
          const materialization = this._reserveCoordinateMaterialization(
            raw,
            outputBytes,
            cacheLabel
          );
          try {
            const data = new Float32Array(raw.length);
            for (let i = 0; i < raw.length; i++) {
              const scaled = raw[i] * scale;
              const narrowed = Math.fround(scaled);
              if (!Number.isFinite(scaled) || !Number.isFinite(narrowed)) {
                throw new Error(
                  `${cacheLabel} component at flat index ${i} is outside the finite Float32 range after normalization`
                );
              }
              data[i] = narrowed;
            }
            this._assertLifecycleGeneration(generation);
            this._consumeCoordinateOutputReservation(materialization);
            this._retainCoordinateCacheEntry({
              cacheKey: coordinateCacheKey,
              embeddingId,
              vectorPath: path,
              kind: 'vector',
              label: cacheLabel,
              value: data
            });
            return data;
          } finally {
            this._releaseCoordinateMaterialization(materialization);
          }
        }
      );
    } finally {
      releasePin();
    }
  }

  /**
   * Normalize checked embedding coordinates with the export format's rule --
   * centred per axis, one `2 / max(axis ranges)` scale for every axis,
   * computed at the input's precision and rounded to float32 once -- so the
   * payload is byte-identical to the one `cellucid-python`/`cellucid-r`
   * write and `cellucid serve` answers for the same array. The transform is
   * recorded under the embedding's id so its vector fields share its scale.
   *
   * @param {Float64Array} data - Checked coordinates, row-major
   * @param {number} dimension - Components per cell
   * @param {string} embeddingId
   * @returns {Float32Array}
   * @protected
   */
  _normalizeEmbedding(data, dimension, embeddingId) {
    const nCells = data.length / dimension;
    const result = new Float32Array(nCells * dimension);
    if (nCells === 0) return result;

    const mins = new Array(dimension).fill(Infinity);
    const maxs = new Array(dimension).fill(-Infinity);
    for (let i = 0; i < nCells; i++) {
      const baseIdx = i * dimension;
      for (let d = 0; d < dimension; d++) {
        const value = data[baseIdx + d];
        if (value < mins[d]) mins[d] = value;
        if (value > maxs[d]) maxs[d] = value;
      }
    }

    // One range for all axes keeps the layout's aspect ratio. The load-time
    // check (`embeddingLoadDefect`) already refused a zero range, and any
    // positive range is used as is: the format's rule has no floor, so a
    // narrow embedding gets the scale every writer gives it.
    let maxRange = 0;
    for (let d = 0; d < dimension; d++) {
      const range = maxs[d] - mins[d];
      if (range > maxRange) maxRange = range;
    }

    const centers = mins.map((min, d) => (min + maxs[d]) / 2);
    const scale = 2 / maxRange;
    for (let i = 0; i < nCells; i++) {
      for (let d = 0; d < dimension; d++) {
        result[i * dimension + d] = (data[i * dimension + d] - centers[d]) * scale;
      }
    }

    this._normInfo.set(embeddingId, { maxRange, centers, scale });
    return result;
  }

  /**
   * Get obs manifest in Cellucid compact format
   * @returns {Object}
   */
  getObsManifest() {
    if (
      !Number.isSafeInteger(this._loader.nObs) ||
      this._loader.nObs <= 0
    ) {
      throw new Error(
        'AnnData datasets must contain at least one observation'
      );
    }
    const continuousFields = [];
    const categoricalFields = [];

    // obs/ carries both arrays, so one payload-index space spans them, taken
    // from each field's position in the single served obs field list.
    for (
      let payloadIndex = 0;
      payloadIndex < this._obsFieldsMetadata.length;
      payloadIndex++
    ) {
      const field = this._obsFieldsMetadata[payloadIndex];
      if (field.kind === 'continuous') {
        continuousFields.push([payloadIndex, field.key]);
      } else {
        const { dtype, missingValue } = getCellucidCategoryStorage(
          field.categories,
          field.key
        );

        categoricalFields.push([
          payloadIndex,
          field.key,
          field.categories,
          dtype,
          missingValue,
          {},
        ]);
      }
    }

    const obsSchemas = {};
    if (continuousFields.length > 0) {
      obsSchemas.continuous = {
        pathPattern: 'obs/{index}.values.f32',
        ext: 'f32',
        dtype: 'float32',
        quantized: false,
      };
    }
    if (categoricalFields.length > 0) {
      obsSchemas.categorical = {
        codesPathPattern: 'obs/{index}.codes.{ext}',
        outlierPathPattern: null,
        outlierExt: null,
        outlierDtype: null,
        outlierQuantized: false,
      };
    }

    return {
      _format: 'compact_v2',
      n_points: this._loader.nObs,
      centroid_outlier_quantile: null,
      latent_key: null,
      compression: null,
      _obsSchemas: obsSchemas,
      _continuousFields: continuousFields,
      _categoricalFields: categoricalFields,
    };
  }

  /**
   * The gene list of one var axis named by one name source, in Cellucid's
   * compact var-manifest format: `var_manifest.json` is the gene list this
   * file opens with (the default expression matrix and gene names), and
   * `_cellucid/mapping/genes/{axis}/{names}/var_manifest.json` any other. The
   * names are made unique with `makeUniqueNames`, exactly as `cellucid serve`
   * does; the manifest records what that changed.
   *
   * @param {string} [path='var_manifest.json']
   * @returns {Promise<Object>}
   */
  async getVarManifest(path = 'var_manifest.json') {
    const generation = this._captureLifecycleGeneration();
    if (
      !Number.isSafeInteger(this._loader.nObs) ||
      this._loader.nObs <= 0
    ) {
      throw new Error(
        'AnnData datasets must contain at least one observation'
      );
    }
    const route = this._resolveGeneRoute(path, 'var_manifest');
    const names = route === null ? null : await this._geneNames(route);
    this._assertLifecycleGeneration(generation);
    // The genes listed here come from this matrix: let a reader that must
    // index it by gene start now, in the background, so the first gene shown
    // does not wait for the whole index.
    if (route !== null) this._loader.prepareMatrix?.(route.element);
    return {
      _format: 'compact_v2',
      n_points: this._loader.nObs,
      compression: null,
      quantization: null,
      _varSchema: {
        kind: 'continuous',
        pathPattern: 'var/{index}.values.f32',
        ext: 'f32',
        dtype: 'float32',
        quantized: false,
      },
      fields: names === null
        ? []
        : names.names.map((name, payloadIndex) => [payloadIndex, name]),
      gene_name_sets: [
        names === null
          ? { source: null, filled_from_index: 0, renamed: [], names: null }
          : {
              source: names.source,
              filled_from_index: names.filledFromIndex,
              renamed: names.renamed.map(pair => [...pair]),
              names: null,
            },
      ],
    };
  }

  /**
   * Resolve one gene path -- the file's own (`var_manifest.json`,
   * `var/{g}.values.f32`) or a mapped one -- to the matrix and name source it
   * reads. Null for the file's own gene list when it has no expression
   * matrix.
   *
   * @param {string} path
   * @param {'var_manifest'|'gene'} kind
   * @returns {{axisRoute: string, namesRoute: string, element: string, varAxis: 'X'|'raw', column: string|null, gene: number|null}|null}
   * @private
   */
  _resolveGeneRoute(path, kind) {
    const candidates = this.getMappingCandidates();
    let axisRoute;
    let namesRoute;
    let gene = null;
    const mapped = parseMappingGenesPath(path);
    if (mapped !== null) {
      ({ axisRoute, namesRoute, gene } = mapped);
    } else {
      const own = kind === 'var_manifest'
        ? (path === 'var_manifest.json' ? {} : null)
        : /^var\/(0|[1-9][0-9]*)\.values\.f32$/.exec(path);
      if (own === null) {
        throw new RangeError(`This file has no gene payload '${path}'.`);
      }
      const defaults = candidates.defaults;
      if (defaults.expression === null) {
        if (kind === 'gene') {
          throw new Error('This AnnData file has no expression matrix; gene expression is unavailable.');
        }
        return null;
      }
      axisRoute = expressionAxisRoute(candidates, defaults.expression);
      namesRoute = geneNamesRoute(candidates, axisRoute, defaults.geneNames);
      gene = kind === 'gene' ? Number(own[1]) : null;
    }
    if ((kind === 'gene') !== (gene !== null)) {
      throw new RangeError(`This file has no gene payload '${path}'.`);
    }
    let element;
    let varAxis = 'X';
    if (axisRoute === 'X') {
      if (candidates.X === null) throw new RangeError('This file has no X.');
      element = 'X';
    } else if (axisRoute === 'raw') {
      if (candidates.raw === null) throw new RangeError('This file has no raw.');
      element = 'raw/X';
      varAxis = 'raw';
    } else {
      const layer = candidates.layers[Number(axisRoute.slice('layer-'.length))];
      if (layer === undefined) throw new RangeError(`This file has no layer ${axisRoute}.`);
      if (!layer.usable) {
        throw new MappingLoadError(layer.key, layer.reason, `layers['${layer.key}'] ${layer.reason}.`);
      }
      element = `layers/${layer.key}`;
    }
    let column = null;
    if (namesRoute !== 'index') {
      const entry = axisVarColumns(candidates, axisRoute)[Number(namesRoute.slice('column-'.length))];
      if (entry === undefined) throw new RangeError(`This file has no var column ${namesRoute}.`);
      if (!entry.usable) {
        throw new MappingLoadError(entry.key, entry.reason, `var column '${entry.key}': ${entry.reason}.`);
      }
      column = entry.key;
    }
    return { axisRoute, namesRoute, element, varAxis, column, gene };
  }

  /**
   * The unique gene names of one axis and name source, read once and kept:
   * the var index, or one var column whose empty values take the index name.
   *
   * @param {{varAxis: 'X'|'raw', column: string|null}} route
   * @returns {Promise<{names: string[], renamed: Array<[string, string]>, filledFromIndex: number, source: string|null}>}
   * @private
   */
  async _geneNames(route) {
    const cacheKey = JSON.stringify([route.varAxis, route.column]);
    const cached = this._geneNameSets.get(cacheKey);
    if (cached !== undefined) return cached;
    const generation = this._captureLifecycleGeneration();
    const { index, values } = await this._loader.readVarNames(route.varAxis, route.column);
    this._assertLifecycleGeneration(generation);
    let unique;
    try {
      unique = makeUniqueNames(values, { index: route.column === null ? null : index });
    } catch (error) {
      const key = route.column ?? 'index';
      throw new MappingLoadError(key, error.message.replace(/\.\s*$/, ''), error.message);
    }
    const result = Object.freeze({
      names: unique.names,
      renamed: unique.renamed,
      filledFromIndex: unique.filledFromIndex,
      source: route.column,
    });
    this._geneNameSets.set(cacheKey, result);
    return result;
  }

  /**
   * Get obs field data as binary (lazy loaded)
   * @param {string} key - Field name
   * @returns {Promise<{data: ArrayBuffer, kind: string, categories?: string[], min?: number, max?: number}>}
   */
  async getObsFieldData(key) {
    const generation = this._captureLifecycleGeneration();
    return this._coalesceInFlight(
      this._obsFieldDataInFlight,
      key,
      generation,
      async () => {
        // Lazy load the field data.
        const fieldData = await this._getOrLoadFieldData(key);
        this._assertLifecycleGeneration(generation);

        if (fieldData.kind === 'continuous') {
          return {
            data: fieldData.values.buffer,
            kind: 'continuous',
            min: fieldData.min,
            max: fieldData.max,
          };
        }

        // Categorical - convert codes to the compact public dtype.
        const {
          TypedArrayClass,
          missingValue,
          dtype: dtypeStr
        } = getCellucidCategoryStorage(fieldData.categories, key);

        const codes = new TypedArrayClass(fieldData.codes.length);
        for (let i = 0; i < fieldData.codes.length; i++) {
          const code = fieldData.codes[i];
          if (
            !Number.isInteger(code) ||
            code < -1 ||
            code >= fieldData.categories.length
          ) {
            throw new Error(
              `Categorical observation field '${key}' has invalid code ` +
              `${String(code)} at index ${i}; expected -1 or an integer ` +
              `from 0 to ${fieldData.categories.length - 1}`
            );
          }
          if (code === -1) {
            codes[i] = missingValue;
          } else {
            codes[i] = code;
          }
        }

        // The compact public buffer owns the result after this point. Do not
        // retain a second full-width categorical code array in the adapter.
        this._deleteObsFieldDataCache(key, fieldData);
        return {
          data: codes.buffer,
          kind: 'category',
          categories: fieldData.categories,
          dtype: dtypeStr,
          missingValue,
          ...(typeof fieldData.ordered === 'boolean'
            ? { ordered: fieldData.ordered }
            : {}),
        };
      }
    );
  }

  /**
   * One gene's value in every cell, by its payload path: `var/{g}.values.f32`
   * for the file's own gene list, or
   * `_cellucid/mapping/genes/{axis}/{names}/var/{g}.values.f32`. The values
   * depend only on the matrix and the gene's position on it, never on the
   * name source.
   *
   * @param {string} path
   * @returns {Promise<Float32Array>}
   */
  async getGeneValues(path) {
    const generation = this._captureLifecycleGeneration();
    const route = this._resolveGeneRoute(path, 'gene');
    const names = await this._geneNames(route);
    this._assertLifecycleGeneration(generation);
    if (route.gene >= names.names.length) {
      throw new RangeError(`This file has no gene ${route.gene} in ${route.element}.`);
    }
    return this._coalesceInFlight(
      this._geneExpressionInFlight,
      JSON.stringify([route.element, route.gene]),
      generation,
      async () => {
        const result = await this._loader.getMatrixColumn(route.element, route.gene);
        this._assertLifecycleGeneration(generation);
        return result;
      }
    );
  }

  /**
   * The outlier quantiles of one categorical obs field in one latent space,
   * by its route `_cellucid/mapping/latent/{obsm}/obs/{field}.outliers.f32`:
   * `obsm` is the latent space's catalog position and `field` the field's
   * payload index. The latent space is read once, checked (every value finite
   * and representable as float32) as the reader worker streams it from the
   * file, of any size; the reader keeps it while it fits its memory budget.
   * The quantiles are the rule `cellucid serve` computes
   * (`data/latent-outliers.js`).
   *
   * @param {string} path
   * @returns {Promise<Float32Array>}
   */
  async getLatentOutlierQuantiles(path) {
    const generation = this._captureLifecycleGeneration();
    const route = parseMappingLatentPath(path);
    const item = route === null ? undefined : this._candidates?.obsm[route.obsmIndex];
    if (item === undefined) {
      throw new RangeError(`This dataset has no outlier payload '${path}'.`);
    }
    const reason = latentCandidateReason(item);
    if (reason !== null) {
      throw new MappingLoadError(item.key, reason, `obsm['${item.key}'] ${reason}.`);
    }
    const field = this._obsFieldsMetadata?.[route.fieldIndex];
    if (field === undefined || field.kind !== 'category') {
      throw new RangeError(`This dataset has no categorical obs field ${route.fieldIndex}.`);
    }
    return this._coalesceInFlight(
      this._latentOutlierInFlight,
      path,
      generation,
      async () => {
        const fieldData = await this.getObsFieldData(field.key);
        this._assertLifecycleGeneration(generation);
        const { TypedArrayClass } = categoricalStorageForDtype(
          fieldData.dtype,
          `Categorical field '${field.key}'`
        );
        const quantiles = await this._loader.latentOutlierQuantiles(item.key, obsmWidth(item), {
          codes: new TypedArrayClass(fieldData.data),
          nCategories: fieldData.categories.length,
          minPoints: LATENT_OUTLIER_MIN_POINTS,
        });
        this._assertLifecycleGeneration(generation);
        return quantiles;
      }
    );
  }

  /**
   * Get the edges of one neighbour graph, `obsp[key]`.
   *
   * Edge extraction is the most expensive read this adapter performs, so it
   * observes its caller's cancellation at every asynchronous boundary: a
   * cancelled request is released immediately and its extraction never starts,
   * leaving no partial payload and no retained working set behind.
   *
   * The graph is checked as it is extracted (finite, non-negative, zero
   * diagonal, exactly symmetric) and never repaired. The default graph's
   * edges are kept for the life of the file; of every other graph only the
   * one asked for last is kept, so switching graphs never holds more than two
   * (the viewer holds the graph it shows, so it is not read again).
   * A graph other than the default that fails its check is a
   * `MappingLoadError` naming the key, so that one choice is refused and the
   * rest stay available.
   *
   * @param {{signal?: AbortSignal|null, key?: string}} [options] - `key`
   *   defaults to the graph the file opens with, `obsp['connectivities']`.
   * @returns {Promise<{sources: Uint32Array, destinations: Uint32Array, weights: Float64Array, nCells: number, nEdges: number, maxNeighbors: number}|null>}
   *   Null when `obsp` has no such key.
   */
  async getConnectivityEdges(options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Connectivity edge options must be an object.');
    }
    const { key = DEFAULT_KNN_KEY, ...rest } = options;
    requireObspKey(key);
    const signal = getMetadataLoadSignal(
      rest,
      'Direct AnnData connectivity edges'
    );
    throwIfMetadataAborted(signal, CONNECTIVITY_EDGE_LABEL);
    const generation = this._captureLifecycleGeneration();
    // Check if already computed.
    if (this._connectivityCache.has(key)) {
      const cached = this._connectivityCache.get(key);
      await Promise.resolve();
      this._assertLifecycleGeneration(generation);
      throwIfMetadataAborted(signal, CONNECTIVITY_EDGE_LABEL);
      return cached;
    }

    const isDefault = key === DEFAULT_KNN_KEY;
    return waitForMetadata(
      this._coalesceInFlight(
        this._connectivityInFlight,
        key,
        generation,
        async workSignal => {
          if (this._connectivityCache.has(key)) {
            this._assertLifecycleGeneration(generation);
            return this._connectivityCache.get(key);
          }
          throwIfMetadataAborted(workSignal, CONNECTIVITY_EDGE_LABEL);

          console.log(
            `[BaseAnnDataAdapter] Loading connectivity edges of obsp['${key}']...`
          );

          // The reader extracts the edges where it holds the matrix (the
          // AnnData reader worker), so checking and walking a graph of tens of
          // millions of stored values never holds the page.
          let edges;
          try {
            edges = await this._loader.getConnectivityEdges(key);
          } catch (error) {
            this._assertLifecycleGeneration(generation);
            if (isDefault) throw error;
            throw connectivityRefusal(key, error);
          }
          this._assertLifecycleGeneration(generation);
          throwIfMetadataAborted(workSignal, CONNECTIVITY_EDGE_LABEL);

          if (edges === null) {
            console.log(
              `[BaseAnnDataAdapter] obsp['${key}'] is absent`
            );
            this._retainConnectivity(key, null, isDefault);
            return null;
          }
          if (!edges || typeof edges !== 'object' || Array.isArray(edges)) {
            throw new TypeError(
              'Connectivity loader must return an exact null absence or one edge list'
            );
          }
          console.log(
            `[BaseAnnDataAdapter] Extracted ${edges.nEdges} unique edges`
          );

          const result = {
            sources: edges.sources,
            destinations: edges.destinations,
            weights: edges.weights,
            nCells: edges.nCells,
            nEdges: edges.nEdges,
            maxNeighbors: edges.maxNeighbors,
          };
          this._retainConnectivity(key, result, isDefault);
          return result;
        },
        signal
      ),
      signal,
      CONNECTIVITY_EDGE_LABEL
    );
  }

  /**
   * Keep one extracted graph: the default for the life of the file, any
   * other in the single slot of the graph asked for last.
   *
   * @param {string} key
   * @param {Object|null} edges
   * @param {boolean} isDefault
   * @private
   */
  _retainConnectivity(key, edges, isDefault) {
    if (!isDefault) {
      for (const cachedKey of [...this._connectivityCache.keys()]) {
        if (cachedKey !== DEFAULT_KNN_KEY) {
          this._connectivityCache.delete(cachedKey);
        }
      }
    }
    this._connectivityCache.set(key, edges);
  }

  /**
   * The edge-pair manifest of one neighbour graph the candidate catalog
   * lists, by its position in `candidates.obsp`
   * (`_cellucid/mapping/knn/{p}/connectivity_manifest.json`). The graph is
   * read and checked to count its edges; a graph that is unusable, absent or
   * fails its check is a `MappingLoadError` naming the key.
   *
   * @param {number} obspIndex
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Readonly<Object>>}
   */
  async getMappedConnectivityManifest(obspIndex, options = {}) {
    const item = this.getMappingCandidates().obsp[obspIndex];
    if (item === undefined) {
      throw new RangeError(`This file has no obsp entry ${obspIndex}.`);
    }
    if (!item.usable) {
      throw new MappingLoadError(
        item.key,
        item.reason,
        `obsp['${item.key}'] ${item.reason}.`
      );
    }
    const edges = await this.getConnectivityEdges({
      signal: options.signal ?? null,
      key: item.key,
    });
    if (edges === null) {
      throw new MappingLoadError(
        item.key,
        'not present in this file',
        `obsp['${item.key}'] is not present in this file.`
      );
    }
    return Object.freeze(validateConnectivityManifest({
      format: 'edge_pairs',
      n_cells: edges.nCells,
      n_edges: edges.nEdges,
      max_neighbors: edges.maxNeighbors,
      index_dtype: 'uint32',
      index_bytes: Uint32Array.BYTES_PER_ELEMENT,
    }, CONNECTIVITY_MANIFEST_CONTEXT.DIRECT));
  }

  /**
   * Invalidate in-flight reads and release all computed adapter caches while
   * retaining the open loader and dataset metadata.
   */
  clearCaches() {
    this._lifecycleGeneration++;
    this._embeddingInFlight.clear();
    this._obsFieldDataInFlight.clear();
    this._vectorFieldInFlight.clear();
    this._connectivityInFlight.clear();
    this._geneExpressionInFlight.clear();
    this._geneNameSets.clear();
    this._latentOutlierInFlight.clear();
    this._embeddingCache.clear();
    this._vectorFieldCache.clear();
    this._resetCoordinateCacheOwner();
    this._obsFieldDataCache.clear();
    this._obsFieldDataCacheBytes = 0n;
    this._connectivityCache.clear();
    this._normInfo.clear();
  }

  /**
   * Close and release resources
   */
  close() {
    if (this._closed) return;
    this.clearCaches();
    this._closed = true;
    this._obsFieldsMetadata = null;
    this._loader.close();
  }
}
