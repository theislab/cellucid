/**
 * Base AnnData Adapter for Cellucid
 *
 * Shared base class for H5adDataAdapter and ZarrDataAdapter.
 * Contains common logic for:
 * - Embedding normalization
 * - Obs manifest generation
 * - Var manifest generation
 * - Obs field data processing
 * - Connectivity edge extraction
 *
 * Subclasses must implement:
 * - _getLoader() - Returns the underlying loader (H5adLoader or ZarrLoader)
 * - _computeObsFieldsMetadata() - Compute obs field metadata (may have format-specific logic)
 *
 * This eliminates ~500 lines of duplicated code between h5ad.js and zarr.js.
 */

import { extractConnectivityEdges } from './sparse-utils.js';
import { validateDatasetIdentity } from './data-source.js';
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
  requireCategoricalCategoryCount,
} from './categorical-storage-contract.js';

const CONNECTIVITY_EDGE_LABEL = 'Direct AnnData connectivity edge loading';
const DEFAULT_MAX_MATERIALIZED_BYTES = 512 * 1024 * 1024;
const JS_ARRAY_ELEMENT_BYTES = 8n;
const ESTIMATED_JS_STRING_VALUE_BYTES = 64n;
const ESTIMATED_JS_SET_ENTRY_BYTES = 48n;

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

function validateFiniteCoordinateComponents(values, label) {
  const length = Number(values?.length);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`${label} has an invalid coordinate length`);
  }
  for (let index = 0; index < length; index++) {
    if (!Number.isFinite(values[index])) {
      throw new Error(
        `${label} contains a non-finite component at flat index ${index}`
      );
    }
  }
}

function estimateCategoryRetainedBytes(categories) {
  let bytes = BigInt(categories.length) * JS_ARRAY_ELEMENT_BYTES;
  for (const category of categories) {
    if (typeof category === 'string') {
      bytes +=
        ESTIMATED_JS_STRING_VALUE_BYTES +
        BigInt(category.length) * 2n;
    } else if (typeof category === 'number') {
      bytes += 16n;
    }
  }
  return bytes;
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
   * @param {number} [options.maxMaterializedBytes]
   */
  constructor(loader, options = {}) {
    /** @protected */
    this._loader = loader;

    /** @type {Object|null} */
    this._metadata = null;

    /** @type {Object<string, string>|null} Private obsm embedding resolution */
    this._embeddingKeysByDimension = null;

    /** @type {Map<string, Object<string, string>>} Private obsm vector resolution */
    this._vectorFieldKeysById = new Map();

    /** @type {boolean} */
    this._directIdentityFinalized = false;

    /** @type {Map<number, Float32Array>} Cached embeddings per dimension */
    this._embeddingCache = new Map();

    /** @type {Map<string, Map<number, Float32Array>>} Cached vector fields per fieldId + dimension */
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

    /** @type {Object|undefined|null} undefined = not computed, null = no connectivity, object = has data */
    this._connectivityCache = undefined;

    /** @type {Readonly<Object>|undefined|null} Finalized direct manifest summary */
    this._connectivityManifest = undefined;

    /** @type {Map<number, Object>} Normalization info per dimension */
    this._normInfo = new Map();

    /** @type {Map<number, Promise<Float32Array>>} */
    this._embeddingInFlight = new Map();

    /** @type {Map<string, Promise<Object>>} */
    this._obsFieldDataInFlight = new Map();

    /** @type {Map<string, Promise<Float32Array>>} */
    this._vectorFieldInFlight = new Map();

    /** @type {Map<string, Promise<Object|null>>} */
    this._connectivityInFlight = new Map();

    /** @type {Map<string, Promise<Float32Array>>} */
    this._geneExpressionInFlight = new Map();

    /** @type {number} Invalidates results from asynchronous work after cache lifecycle changes */
    this._lifecycleGeneration = 0;

    /** @type {boolean} Closed adapters cannot start or publish new work */
    this._closed = false;

    const maxMaterializedBytes =
      options.maxMaterializedBytes ?? DEFAULT_MAX_MATERIALIZED_BYTES;
    if (
      !Number.isSafeInteger(maxMaterializedBytes) ||
      maxMaterializedBytes <= 0
    ) {
      throw new TypeError(
        'AnnData adapter materialization limit must be a positive safe integer.'
      );
    }
    this._maxMaterializedBytes = BigInt(maxMaterializedBytes);
    this._obsMetadataRetainedBytes = 0n;
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
   * @param {number} dim
   * @returns {string}
   * @private
   */
  _embeddingCoordinateCacheKey(dim) {
    return JSON.stringify(['embedding', dim]);
  }

  /**
   * @param {string} fieldId
   * @param {number} dim
   * @returns {string}
   * @private
   */
  _vectorCoordinateCacheKey(fieldId, dim) {
    return JSON.stringify(['vector', fieldId, dim]);
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
   * Calculate normalized embedding bytes without reading coordinates.
   *
   * @param {Object} data
   * @param {number} srcDim
   * @param {number} targetDim
   * @param {string} label
   * @returns {bigint}
   * @private
   */
  _checkedNormalizedEmbeddingBytes(data, srcDim, targetDim, label) {
    const rawLength = Number(data?.length);
    if (
      !Number.isSafeInteger(rawLength) ||
      rawLength < 0 ||
      !Number.isSafeInteger(srcDim) ||
      srcDim <= 0 ||
      !Number.isSafeInteger(targetDim) ||
      targetDim <= 0 ||
      rawLength % srcDim !== 0
    ) {
      throw new Error(`${label} has an invalid embedding shape.`);
    }
    const outputLength =
      BigInt(rawLength / srcDim) * BigInt(targetDim);
    return outputLength * BigInt(Float32Array.BYTES_PER_ELEMENT);
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
      if (this._embeddingCache.get(entry.dim) === entry.value) {
        this._embeddingCache.delete(entry.dim);
      }
    } else {
      const perField = this._vectorFieldCache.get(entry.fieldId);
      if (perField?.get(entry.dim) === entry.value) {
        perField.delete(entry.dim);
        if (perField.size === 0) {
          this._vectorFieldCache.delete(entry.fieldId);
        }
      }
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
  _makeCoordinateCacheRoom(additionalBytes, label) {
    if (additionalBytes > this._maxMaterializedBytes) {
      throw new Error(
        `${label} retained cache requires ` +
        `${additionalBytes.toString()} bytes and exceeds the ` +
        `${this._maxMaterializedBytes.toString()}-byte browser limit; ` +
        'use the Cellucid server or prepared format'
      );
    }

    while (
      this._coordinateCacheBytes +
        this._coordinateReservedOutputBytes +
        additionalBytes >
      this._maxMaterializedBytes
    ) {
      let victimKey = null;
      for (const cacheKey of this._coordinateCacheLru.keys()) {
        if (!this._isCoordinateCacheKeyPinned(cacheKey)) {
          victimKey = cacheKey;
          break;
        }
      }
      if (victimKey == null) {
        throw new Error(
          `${label} retained cache cannot fit within the ` +
          `${this._maxMaterializedBytes.toString()}-byte browser limit ` +
          'while current coordinate results are in use; ' +
          'use the Cellucid server or prepared format'
        );
      }
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
    if (outputBytes > this._maxMaterializedBytes) {
      this._makeCoordinateCacheRoom(outputBytes, label);
    }

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
      this._makeCoordinateCacheRoom(outputBytes, label);
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
   * @param {number} options.dim
   * @param {string} [options.fieldId]
   * @param {Float32Array} options.value
   * @param {string} options.label
   * @private
   */
  _retainCoordinateCacheEntry({
    cacheKey,
    kind,
    dim,
    fieldId = null,
    value,
    label
  }) {
    const descriptor = this._describeCoordinateBuffer(value);
    const existingRef =
      this._coordinateBufferRefs.get(descriptor.identity);
    const additionalBytes = existingRef ? 0n : descriptor.bytes;
    this._makeCoordinateCacheRoom(additionalBytes, label);

    this._deleteCoordinateCacheEntry(cacheKey);
    if (kind === 'embedding') {
      this._embeddingCache.set(dim, value);
    } else {
      let perField = this._vectorFieldCache.get(fieldId);
      if (!perField) {
        perField = new Map();
        this._vectorFieldCache.set(fieldId, perField);
      }
      perField.set(dim, value);
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
      dim,
      fieldId,
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
   * Initialize the adapter and compute metadata
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
      const embeddingKeys = metadata?.embeddings?.obsm_keys;
      if (
        !embeddingKeys ||
        typeof embeddingKeys !== 'object' ||
        Array.isArray(embeddingKeys)
      ) {
        throw new Error(
          'AnnData loader metadata must provide exact private obsm embedding keys'
        );
      }
      this._embeddingKeysByDimension = { ...embeddingKeys };
      this._metadata = metadata;
      await this._computeObsFieldsMetadata(generation);
      this._assertLifecycleGeneration(generation);
      await this._computeVectorFieldsMetadata(generation);
      this._assertLifecycleGeneration(generation);

      // Candidate sources are adopted only after initialize() resolves.
      // Validate the required default embedding payload here so corrupt bytes
      // cannot replace and close a still-working dataset.
      const defaultDimension =
        Number(this._metadata?.embeddings?.default_dimension);
      if (
        Number.isInteger(defaultDimension) &&
        defaultDimension >= 1 &&
        defaultDimension <= 3
      ) {
        await this.getEmbedding(defaultDimension);
        this._assertLifecycleGeneration(generation);
      }
    } catch (error) {
      if (
        !this._closed &&
        generation === this._lifecycleGeneration
      ) {
        this._metadata = null;
        this._embeddingKeysByDimension = null;
        this._vectorFieldKeysById.clear();
        this._obsFieldsMetadata = null;
        this._obsMetadataRetainedBytes = 0n;
        this.clearCaches();
      }
      throw error;
    }
  }

  /**
   * Detect available vector fields in `obsm` and attach a compact metadata
   * summary onto the dataset identity.
   *
   * This keeps the UI fast: we can show/hide the vector field overlay controls
   * without loading the full vector arrays upfront.
   *
   * Naming convention (UMAP basis):
   * - Exact per-dimension keys: `<field>_umap_<dim>d`
   * - Examples: `velocity_umap_2d`, `T_fwd_umap_3d`
   *
   * Notes:
   * - Keys starting with `X_` are reserved for embeddings and are ignored here.
   * - This does not compute or validate semantics; it only validates shapes.
   *
   * @protected
   */
  async _computeVectorFieldsMetadata(
    generation = this._captureLifecycleGeneration()
  ) {
    const obsmKeys = Array.isArray(this._loader?.obsmKeys) ? this._loader.obsmKeys : [];
    if (!this._metadata || obsmKeys.length === 0) return;

    const getShapeDims = async (key) => {
      if (typeof this._loader.getEmbeddingShape !== 'function') {
        throw new Error(
          `Direct AnnData loader cannot validate vector field '${key}'`
        );
      }
      const shapeMaybe = this._loader.getEmbeddingShape(key);
      const shapeInfo = typeof shapeMaybe?.then === 'function'
        ? await shapeMaybe
        : shapeMaybe;
      this._assertLifecycleGeneration(generation);
      const nDims = shapeInfo?.nDims;
      if (!Number.isInteger(nDims)) {
        throw new Error(
          `Vector field '${key}' is missing an exact dimension`
        );
      }
      return nDims;
    };

    const isEmbeddingKey = (key) => String(key || '').startsWith('X_');
    const isUmapKey = (key) => String(key || '').endsWith('_umap');

    const fields = new Map();
    const ensureField = (id) => {
      const key = String(id || '');
      if (!fields.has(key)) {
        fields.set(key, { dims: new Set(), keysByDim: {} });
      }
      return fields.get(key);
    };

    for (const key of obsmKeys) {
      const match = String(key).match(/^(.*)_([123])d$/);
      if (!match) continue;
      const baseId = match[1];
      const dim = Number.parseInt(match[2], 10);
      if (!Number.isInteger(dim) || dim < 1 || dim > 3) continue;
      if (!isUmapKey(baseId) || isEmbeddingKey(baseId)) continue;

      const nDims = await getShapeDims(key);
      if (nDims !== dim) {
        throw new Error(
          `Vector field '${key}' has ${nDims} columns, but its ${dim}D suffix requires exactly ${dim}`
        );
      }

      const entry = ensureField(baseId);
      entry.keysByDim[`${dim}d`] = key;
      entry.dims.add(dim);
    }

    const buildLabel = (fieldId) => {
      const id = String(fieldId || '');
      if (!id) return '';
      const base = id.endsWith('_umap') ? id.slice(0, -5) : id;
      const pretty = base.replace(/_/g, ' ').trim();
      const titled = pretty ? (pretty[0].toUpperCase() + pretty.slice(1)) : id;
      return id.endsWith('_umap') ? `${titled} (UMAP)` : titled;
    };

    const fieldsObj = {};
    for (const [id, entry] of fields.entries()) {
      const dims = Array.from(entry.dims).sort((a, b) => a - b);
      if (!dims.length) continue;
      fieldsObj[id] = {
        label: buildLabel(id),
        basis: 'umap',
        available_dimensions: dims,
        default_dimension: Math.max(...dims),
        obsm_keys: entry.keysByDim,
      };
      this._vectorFieldKeysById.set(id, { ...entry.keysByDim });
    }

    const ids = Object.keys(fieldsObj);
    if (!ids.length) return;

    const defaultField = ids.length === 1 ? ids[0] : null;

    this._assertLifecycleGeneration(generation);
    this._metadata.vector_fields = {
      default_field: defaultField,
      fields: fieldsObj,
    };
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
    this._obsMetadataRetainedBytes = 0n;

    for (const key of this._loader.obsKeys) {
      const fieldInfo = await this._loader.getObsFieldInfo(key);
      this._assertLifecycleGeneration(generation);

      if (fieldInfo.dtype === 'categorical') {
        validateCellucidCategories(fieldInfo.categories, key);
        this._reserveObservationCategories(fieldInfo.categories, key);
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
          this._reserveObservationCategories(categories, key);
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
    let rawBytes = BigInt(length) * JS_ARRAY_ELEMENT_BYTES;
    let discoveryBytes = 0n;
    this._assertObservationBudget(
      this._obsMetadataRetainedBytes + rawBytes,
      `Observation field '${key}' category discovery`
    );

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

      if (type === 'string') {
        rawBytes +=
          ESTIMATED_JS_STRING_VALUE_BYTES +
          BigInt(value.length) * 2n;
        this._assertObservationBudget(
          this._obsMetadataRetainedBytes +
            rawBytes +
            discoveryBytes,
          `Observation field '${key}' category discovery`
        );
      }

      if (seen.has(value)) continue;
      validateCellucidCategoryCount(categories.length + 1, key);

      discoveryBytes +=
        JS_ARRAY_ELEMENT_BYTES +
        ESTIMATED_JS_SET_ENTRY_BYTES;
      this._assertObservationBudget(
        this._obsMetadataRetainedBytes +
          rawBytes +
          discoveryBytes,
        `Observation field '${key}' category discovery`
      );
      seen.add(value);
      categories.push(value);
    }

    // Model a conservative reference-sized in-place sort workspace.
    this._assertObservationBudget(
      this._obsMetadataRetainedBytes +
        rawBytes +
        discoveryBytes +
      BigInt(categories.length) * JS_ARRAY_ELEMENT_BYTES,
      `Observation field '${key}' category discovery`
    );
    if (categories.every(category => typeof category === 'string')) {
      categories.sort();
    } else {
      categories.sort(comparePrimitiveCategories);
    }
    validateCellucidCategories(categories, key);
    return categories;
  }

  /**
   * Reserve persistent category metadata across every observation field.
   *
   * @param {Array} categories
   * @param {string} key
   * @private
   */
  _reserveObservationCategories(categories, key) {
    const nextBytes =
      this._obsMetadataRetainedBytes +
      estimateCategoryRetainedBytes(categories);
    this._assertObservationBudget(
      nextBytes,
      `Cumulative observation metadata for '${key}'`
    );
    this._obsMetadataRetainedBytes = nextBytes;
  }

  /**
   * @param {bigint} bytes
   * @param {string} label
   * @private
   */
  _assertObservationBudget(bytes, label) {
    if (bytes > this._maxMaterializedBytes) {
      throw new Error(
        `${label} working set exceeds the ` +
        `${this._maxMaterializedBytes.toString()}-byte browser limit; ` +
        'use the Cellucid server or prepared format'
      );
    }
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
   * Release only the exact loader-owned raw coordinate result consumed by the
   * adapter. Loader implementations identity-check the cache entry so a clear,
   * replacement, or newer independent result cannot be invalidated by stale
   * cleanup.
   *
   * @param {string} key
   * @param {Object|null} embedding
   * @private
   */
  _releaseLoaderEmbedding(key, embedding) {
    if (!embedding) return;
    this._loader.releaseEmbedding?.(key, embedding);
  }

  /**
   * Estimate bytes uniquely retained by one lazy observation result. Category
   * dictionaries are excluded because their canonical arrays are already
   * accounted for in `_obsMetadataRetainedBytes`.
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
   * Retain one lazy result within the shared observation-memory ceiling.
   * Entries are least-recently-used in Map iteration order.
   *
   * @param {string} key
   * @param {Object} result
   * @private
   */
  _cacheObsFieldData(key, result) {
    const resultBytes = this._estimateObsFieldDataBytes(result);
    this._assertObservationBudget(
      this._obsMetadataRetainedBytes + resultBytes,
      `Observation field '${key}' retained data`
    );

    this._deleteObsFieldDataCache(key);
    while (
      this._obsFieldDataCache.size > 0 &&
      this._obsMetadataRetainedBytes +
        this._obsFieldDataCacheBytes +
        resultBytes >
        this._maxMaterializedBytes
    ) {
      const oldestKey = this._obsFieldDataCache.keys().next().value;
      this._deleteObsFieldDataCache(oldestKey);
    }

    this._obsFieldDataCache.set(key, result);
    this._obsFieldDataCacheBytes += resultBytes;
  }

  /**
   * Make room for a transient observation operation before allocating its
   * workspace. Existing lazy entries are expendable LRU state; canonical
   * category metadata is not.
   *
   * @param {bigint} workspaceBytes
   * @param {string} label
   * @private
   */
  _prepareObsFieldWorkspace(workspaceBytes, label) {
    this._assertObservationBudget(
      this._obsMetadataRetainedBytes + workspaceBytes,
      label
    );
    while (
      this._obsFieldDataCache.size > 0 &&
      this._obsMetadataRetainedBytes +
        this._obsFieldDataCacheBytes +
        workspaceBytes >
        this._maxMaterializedBytes
    ) {
      const oldestKey = this._obsFieldDataCache.keys().next().value;
      this._deleteObsFieldDataCache(oldestKey);
    }
    this._assertObservationBudget(
      this._obsMetadataRetainedBytes +
        this._obsFieldDataCacheBytes +
        workspaceBytes,
      label
    );
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
          const mapBytes =
            BigInt(categories.length) * ESTIMATED_JS_SET_ENTRY_BYTES;
          const codesBytes =
            BigInt(valueCount) *
            BigInt(Int32Array.BYTES_PER_ELEMENT);
          let rawBytes =
            BigInt(valueCount) * JS_ARRAY_ELEMENT_BYTES;
          if (field.dtype === 'string') {
            rawBytes +=
              BigInt(valueCount) * ESTIMATED_JS_STRING_VALUE_BYTES;
          }
          let workspaceBytes = rawBytes + mapBytes + codesBytes;
          const workspaceLabel =
            `Observation field '${key}' category conversion`;
          this._prepareObsFieldWorkspace(
            workspaceBytes,
            workspaceLabel
          );

          // String payload lengths are available only after the loader has
          // decoded the source array. Measure them before Map/code allocation.
          if (field.dtype === 'string') {
            let payloadBytes = 0n;
            for (let index = 0; index < valueCount; index++) {
              const value = field.values[index];
              if (value == null) continue;
              if (typeof value !== 'string') {
                throw new Error(
                  `Observation field '${key}' declared string storage but ` +
                  `value ${index} is not a string`
                );
              }
              payloadBytes += BigInt(value.length) * 2n;
            }
            workspaceBytes += payloadBytes;
            this._prepareObsFieldWorkspace(
              workspaceBytes,
              workspaceLabel
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

  _getEmbeddingObsmKey(dim) {
    return this._embeddingKeysByDimension?.[`${dim}d`];
  }

  _getVectorFieldObsmKey(fieldId, dim) {
    return this._vectorFieldKeysById.get(fieldId)?.[`${dim}d`];
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

    const internalMetadata = this._metadata;
    const internalEmbeddings = internalMetadata?.embeddings;
    const dimensions = internalEmbeddings?.available_dimensions;
    if (!Array.isArray(dimensions) || dimensions.length === 0) {
      throw new Error(
        'Direct AnnData identity requires at least one embedding dimension'
      );
    }
    const availableDimensions = [...dimensions];
    availableDimensions.sort((left, right) => left - right);
    if (
      availableDimensions.some(
        (dimension, index) =>
          !Number.isSafeInteger(dimension) ||
          dimension < 1 ||
          dimension > 3 ||
          (index > 0 && availableDimensions[index - 1] === dimension)
      )
    ) {
      throw new Error(
        'Direct AnnData embedding dimensions must be unique 1D, 2D, or 3D integers'
      );
    }
    const defaultDimension =
      availableDimensions[availableDimensions.length - 1];
    const embeddingFiles = {};
    for (const dimension of availableDimensions) {
      const key = `${dimension}d`;
      const obsmKey = this._embeddingKeysByDimension?.[key];
      if (typeof obsmKey !== 'string' || obsmKey.length === 0) {
        throw new Error(
          `Direct AnnData identity is missing private ${dimension}D obsm resolution`
        );
      }
      embeddingFiles[key] = `points_${dimension}d.bin`;
    }

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
    const hasExpressionMatrix =
      this._loader.hasExpressionMatrix !== false;
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
    const internalVectorFields = internalMetadata.vector_fields;
    if (internalVectorFields) {
      const fields = {};
      let fieldIndex = 0;
      for (const [
        fieldId,
        internalField,
      ] of Object.entries(internalVectorFields.fields)) {
        const files = {};
        for (const dimension of internalField.available_dimensions) {
          const key = `${dimension}d`;
          const obsmKey =
            this._vectorFieldKeysById.get(fieldId)?.[key];
          if (typeof obsmKey !== 'string' || obsmKey.length === 0) {
            throw new Error(
              `Direct AnnData vector field "${fieldId}" is missing ` +
              `private ${dimension}D obsm resolution`
            );
          }
          files[key] =
            `vectors/${fieldIndex}_${dimension}d.bin`;
        }
        fields[fieldId] = {
          label: internalField.label,
          basis: internalField.basis,
          available_dimensions: [
            ...internalField.available_dimensions
          ],
          default_dimension: internalField.default_dimension,
          files,
        };
        fieldIndex++;
      }
      vectorFields = {
        default_field: internalVectorFields.default_field,
        fields,
      };
    }

    const identity = {
      version: 2,
      id,
      name,
      description,
      cellucid_data_version: cellucidDataVersion,
      stats: {
        n_cells: this._loader.nObs,
        n_genes: hasExpressionMatrix ? this._loader.nVars : 0,
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
        available_dimensions: availableDimensions,
        default_dimension: defaultDimension,
        files: embeddingFiles,
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
    this._directIdentityFinalized = true;
    return identity;
  }

  /**
   * Get embedding coordinates for a dimension
   * @param {number} dim - Dimension (1, 2, or 3)
   * @returns {Promise<Float32Array>}
   */
  async getEmbedding(dim) {
    const generation = this._captureLifecycleGeneration();
    const coordinateCacheKey =
      this._embeddingCoordinateCacheKey(dim);
    const releasePin =
      this._pinCoordinateCacheKey(coordinateCacheKey);

    try {
      if (this._embeddingCache.has(dim)) {
        const cached = this._embeddingCache.get(dim);
        this._touchCoordinateCacheEntry(
          coordinateCacheKey,
          cached
        );
        await Promise.resolve();
        this._assertLifecycleGeneration(generation);
        return cached;
      }

      return await this._coalesceInFlight(
        this._embeddingInFlight,
        dim,
        generation,
        async () => {
          if (this._embeddingCache.has(dim)) {
            const cached = this._embeddingCache.get(dim);
            this._touchCoordinateCacheEntry(
              coordinateCacheKey,
              cached
            );
            this._assertLifecycleGeneration(generation);
            return cached;
          }

          const embKey =
            this._getEmbeddingObsmKey(dim);
          if (typeof embKey !== 'string' || embKey.length === 0) {
            throw new Error(
              `Dataset metadata does not advertise an exact ${dim}D embedding key`
            );
          }
          if (!this._loader.obsmKeys.includes(embKey)) {
            throw new Error(
              `Metadata advertises '${embKey}' for ${dim}D, but it is missing from obsm`
            );
          }

          const emb = await this._loader.getEmbedding(embKey);
          let materialization = null;
          try {
            this._assertLifecycleGeneration(generation);

            // The exact suffixed obsm key must match the requested dimension.
            if (emb.nDims !== dim) {
              throw new Error(
                `Embedding '${embKey}' has ${emb.nDims} dimensions, expected ${dim}`
              );
            }

            const cacheLabel = `Embedding '${embKey}'`;
            const outputBytes =
              this._checkedNormalizedEmbeddingBytes(
                emb.data,
                emb.nDims,
                dim,
                cacheLabel
              );
            materialization =
              this._reserveCoordinateMaterialization(
                emb.data,
                outputBytes,
                cacheLabel
              );

            validateFiniteCoordinateComponents(
              emb.data,
              cacheLabel
            );

            // Normalize to [-1, 1] range only after the full raw + output
            // materialization is reserved under the shared coordinate owner.
            let normalized;
            try {
              normalized =
                this._normalizeEmbedding(
                  emb.data,
                  emb.nDims,
                  dim,
                  true
                );
              this._assertLifecycleGeneration(generation);
              this._consumeCoordinateOutputReservation(
                materialization
              );
              this._retainCoordinateCacheEntry({
                cacheKey: coordinateCacheKey,
                dim,
                kind: 'embedding',
                label: cacheLabel,
                value: normalized
              });
              return normalized;
            } catch (error) {
              if (!this._embeddingCache.has(dim)) {
                this._normInfo.delete(dim);
              }
              throw error;
            }
          } finally {
            this._releaseCoordinateMaterialization(
              materialization
            );
            this._releaseLoaderEmbedding(embKey, emb);
          }
        }
      );
    } finally {
      releasePin();
    }
  }

  /**
   * Get per-cell displacement vectors for a vector field in `obsm`.
   *
   * Returns a flat Float32Array with `dim` components per cell, scaled by the
   * same normalization scale as the embedding (so vectors live in the same
   * normalized coordinate space as positions).
   *
   * The fieldId should match a `vector_fields.fields` key in dataset identity
   * (e.g. `velocity_umap`, `T_fwd_umap`).
   *
   * @param {string} fieldId
   * @param {number} dim
   * @returns {Promise<Float32Array>}
   */
  async getVectorField(fieldId, dim) {
    const generation = this._captureLifecycleGeneration();
    const id = String(fieldId || '');
    if (!Number.isInteger(dim) || dim < 1 || dim > 3) {
      throw new TypeError(
        'Vector field dimension must be exactly 1, 2, or 3'
      );
    }
    const d = dim;
    if (!id) {
      throw new Error('BaseAnnDataAdapter.getVectorField: fieldId is required');
    }

    const inFlightKey = JSON.stringify([id, d]);
    const coordinateCacheKey =
      this._vectorCoordinateCacheKey(id, d);
    const releasePin =
      this._pinCoordinateCacheKey(coordinateCacheKey);

    try {
      let perField = this._vectorFieldCache.get(id);
      if (perField?.has(d)) {
        const cached = perField.get(d);
        this._touchCoordinateCacheEntry(
          coordinateCacheKey,
          cached
        );
        await Promise.resolve();
        this._assertLifecycleGeneration(generation);
        return cached;
      }

      return await this._coalesceInFlight(
        this._vectorFieldInFlight,
        inFlightKey,
        generation,
        async () => {
          let currentPerField = this._vectorFieldCache.get(id);
          if (currentPerField?.has(d)) {
            const cached = currentPerField.get(d);
            this._touchCoordinateCacheEntry(
              coordinateCacheKey,
              cached
            );
            this._assertLifecycleGeneration(generation);
            return cached;
          }

          // Ensure we have the embedding scale for this dimension.
          if (!this._normInfo.has(d)) {
            await this.getEmbedding(d);
            this._assertLifecycleGeneration(generation);
          }
          const scale = this._normInfo.get(d)?.scale;
          if (!Number.isFinite(scale) || scale <= 0) {
            throw new Error(
              `Embedding normalization for ${d}D has no finite positive scale`
            );
          }

          const obsmKeys = Array.isArray(this._loader?.obsmKeys)
            ? this._loader.obsmKeys
            : [];

          const metaEntry =
            this._metadata?.vector_fields?.fields?.[id] || null;
          const keyFromMeta =
            this._getVectorFieldObsmKey(id, d);
          if (
            typeof keyFromMeta !== 'string' ||
            keyFromMeta.length === 0
          ) {
            throw new Error(
              `Dataset metadata does not advertise an exact ${d}D vector field key for "${id}"`
            );
          }
          if (!obsmKeys.includes(keyFromMeta)) {
            throw new Error(
              `Metadata advertises '${keyFromMeta}' for ${d}D vector field "${id}", but it is missing from obsm`
            );
          }
          const key = keyFromMeta;

          const vel = await this._loader.getEmbedding(key);
          let materialization = null;
          try {
            this._assertLifecycleGeneration(generation);
            if (vel?.nDims !== d) {
              throw new Error(
                `Vector field '${key}' has ${vel?.nDims} dimensions, expected ${d}`
              );
            }

            const raw = vel?.data;
            const cacheLabel = `Vector field '${key}'`;
            const outputBytes =
              this._checkedCoordinateResultBytes(
                raw?.length,
                cacheLabel
              );
            materialization =
              this._reserveCoordinateMaterialization(
                raw,
                outputBytes,
                cacheLabel
              );
            validateFiniteCoordinateComponents(raw, cacheLabel);

            const len = raw.length;
            const data = new Float32Array(len);
            for (let i = 0; i < len; i++) {
              const scaled = raw[i] * scale;
              const narrowed = Math.fround(scaled);
              if (!Number.isFinite(scaled) ||
                  !Number.isFinite(narrowed)) {
                throw new Error(
                  `${cacheLabel} component at flat index ${i} is outside the finite Float32 range after normalization`
                );
              }
              data[i] = narrowed;
            }
            this._assertLifecycleGeneration(generation);

            this._consumeCoordinateOutputReservation(
              materialization
            );
            this._retainCoordinateCacheEntry({
              cacheKey: coordinateCacheKey,
              dim: d,
              fieldId: id,
              kind: 'vector',
              label: cacheLabel,
              value: data
            });
            return data;
          } finally {
            this._releaseCoordinateMaterialization(
              materialization
            );
            this._releaseLoaderEmbedding(key, vel);
          }
        }
      );
    } finally {
      releasePin();
    }
  }

  /**
   * Normalize finite embedding coordinates to [-1, 1] range with uniform
   * scaling across all axes.
   *
   * @param {Float32Array} data - Raw embedding data (flattened, row-major)
   * @param {number} srcDim - Source dimensions
   * @param {number} targetDim - Target dimensions
   * @param {boolean} coordinatesValidated - Internal one-pass validation marker
   * @returns {Float32Array}
   * @protected
   */
  _normalizeEmbedding(
    data,
    srcDim,
    targetDim,
    coordinatesValidated = false
  ) {
    if (!coordinatesValidated) {
      validateFiniteCoordinateComponents(
        data,
        'Embedding coordinates'
      );
    }
    const nCells = data.length / srcDim;

    // Edge case: empty data
    if (nCells === 0) {
      return new Float32Array(0);
    }

    const result = new Float32Array(nCells * targetDim);

    // Find min/max for each finite axis.
    const mins = new Array(srcDim).fill(Infinity);
    const maxs = new Array(srcDim).fill(-Infinity);

    for (let i = 0; i < nCells; i++) {
      const baseIdx = i * srcDim;
      for (let d = 0; d < srcDim; d++) {
        const value = data[baseIdx + d];
        if (value < mins[d]) mins[d] = value;
        if (value > maxs[d]) maxs[d] = value;
      }
    }

    // Find max range across all axes for uniform scaling
    let maxRange = 0;
    for (let d = 0; d < srcDim; d++) {
      const range = maxs[d] - mins[d];
      if (range > maxRange) maxRange = range;
    }

    // Edge case: all values are identical
    if (maxRange < 1e-8) maxRange = 1;

    // Compute centers
    const centers = mins.map((min, d) => (min + maxs[d]) / 2);

    // Normalize
    const scale = 2 / maxRange;
    for (let i = 0; i < nCells; i++) {
      for (let d = 0; d < Math.min(srcDim, targetDim); d++) {
        const v = data[i * srcDim + d];
        result[i * targetDim + d] =
          (v - centers[d]) * scale;
      }
      // Zero-fill extra dimensions if targetDim > srcDim
      for (let d = srcDim; d < targetDim; d++) {
        result[i * targetDim + d] = 0;
      }
    }

    this._normInfo.set(targetDim, { maxRange, centers, scale });
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
      _format: 'compact_v1',
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
   * Get var manifest in Cellucid compact format
   * @returns {Object}
   */
  getVarManifest() {
    if (
      !Number.isSafeInteger(this._loader.nObs) ||
      this._loader.nObs <= 0
    ) {
      throw new Error(
        'AnnData datasets must contain at least one observation'
      );
    }
    const fields = this._loader.hasExpressionMatrix === false
      ? []
      : this._loader.varNames.map((name, payloadIndex) => [payloadIndex, name]);
    return {
      _format: 'compact_v1',
      n_points: this._loader.nObs,
      var_gene_id_column: null,
      compression: null,
      quantization: null,
      _varSchema: {
        kind: 'continuous',
        pathPattern: 'var/{index}.values.f32',
        ext: 'f32',
        dtype: 'float32',
        quantized: false,
      },
      fields,
    };
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

        const sourceBytes = this._estimateObsFieldDataBytes(fieldData);
        const outputBytes =
          BigInt(fieldData.codes.length) *
          BigInt(TypedArrayClass.BYTES_PER_ELEMENT);
        this._assertObservationBudget(
          this._obsMetadataRetainedBytes + sourceBytes + outputBytes,
          `Observation field '${key}' categorical conversion`
        );
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
   * Get gene expression values
   * @param {string} geneName - Gene name
   * @returns {Promise<Float32Array>}
   */
  async getGeneExpression(geneName) {
    const generation = this._captureLifecycleGeneration();
    if (this._loader.hasExpressionMatrix === false) {
      throw new Error(
        'This AnnData dataset does not contain an X expression matrix; gene expression is unavailable.'
      );
    }
    return this._coalesceInFlight(
      this._geneExpressionInFlight,
      geneName,
      generation,
      async () => {
        const result =
          await this._loader.getGeneExpression(geneName);
        this._assertLifecycleGeneration(generation);
        return result;
      }
    );
  }

  /**
   * Get connectivity edges
   *
   * Edge extraction is the most expensive read this adapter performs, so it
   * observes its caller's cancellation at every asynchronous boundary: a
   * cancelled request is released immediately and its extraction never starts,
   * leaving no partial payload and no retained working set behind.
   *
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<{sources: Uint32Array, destinations: Uint32Array, weights: Float64Array, nEdges: number}|null>}
   */
  async getConnectivityEdges(options = {}) {
    const signal = getMetadataLoadSignal(
      options,
      'Direct AnnData connectivity edges'
    );
    throwIfMetadataAborted(signal, CONNECTIVITY_EDGE_LABEL);
    const generation = this._captureLifecycleGeneration();
    // Check if already computed.
    if (this._connectivityCache !== undefined) {
      const cached = this._connectivityCache;
      await Promise.resolve();
      this._assertLifecycleGeneration(generation);
      throwIfMetadataAborted(signal, CONNECTIVITY_EDGE_LABEL);
      return cached;
    }

    return waitForMetadata(
      this._coalesceInFlight(
        this._connectivityInFlight,
        'edges',
        generation,
        async workSignal => {
          if (this._connectivityCache !== undefined) {
            this._assertLifecycleGeneration(generation);
            return this._connectivityCache;
          }
          throwIfMetadataAborted(workSignal, CONNECTIVITY_EDGE_LABEL);

          console.log(
            '[BaseAnnDataAdapter] Loading connectivity edges...'
          );

          const conn = await this._loader.getConnectivities();
          this._assertLifecycleGeneration(generation);
          // The only asynchronous boundary before extraction: past this point
          // the matrix is walked and the edge payloads are allocated, so a
          // cancelled request releases the loader payload here instead of
          // materializing a graph nobody is waiting for.
          throwIfMetadataAborted(workSignal, CONNECTIVITY_EDGE_LABEL);

          if (conn === null) {
            console.log(
              '[BaseAnnDataAdapter] No connectivity data available'
            );
            this._connectivityCache = null;
            return null;
          }
          if (
            !conn ||
            typeof conn !== 'object' ||
            Array.isArray(conn)
          ) {
            throw new TypeError(
              'Connectivity loader must return an exact null absence or one matrix object'
            );
          }

          const isDense = conn.format === 'dense';

          const storedEntries =
            isDense ? conn.data?.length : conn.indices.length;
          console.log(
            `[BaseAnnDataAdapter] Connectivity matrix: ` +
            `${conn.shape?.[0] || 'unknown'}x` +
            `${conn.shape?.[1] || 'unknown'}, ` +
            `${storedEntries ?? 'unknown'} stored values`
          );

          // Use shared utility for edge extraction.
          const edges =
            extractConnectivityEdges(conn, this._loader.nObs);

          console.log(
            `[BaseAnnDataAdapter] Extracted ${edges.nEdges} unique edges`
          );

          this._connectivityCache = {
            sources: edges.sources,
            destinations: edges.destinations,
            weights: edges.weights,
            nCells: edges.nCells,
            nEdges: edges.nEdges,
            maxNeighbors: edges.maxNeighbors,
          };

          return this._connectivityCache;
        },
        signal
      ),
      signal,
      CONNECTIVITY_EDGE_LABEL
    );
  }

  /**
   * Get gene names
   * @returns {string[]}
   */
  getGeneNames() {
    return this._loader.hasExpressionMatrix === false
      ? []
      : this._loader.varNames;
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
    this._embeddingCache.clear();
    this._vectorFieldCache.clear();
    this._resetCoordinateCacheOwner();
    this._obsFieldDataCache.clear();
    this._obsFieldDataCacheBytes = 0n;
    this._connectivityCache = undefined;
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
    this._obsMetadataRetainedBytes = 0n;
    this._loader.close();
  }
}
