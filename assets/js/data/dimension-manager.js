/**
 * Dimension Manager - Handles multi-dimensional embeddings for cellucid viewer
 *
 * Supports 1D, 2D, and 3D embeddings with:
 * - Lazy loading of dimension-specific position data
 * - Automatic padding of 1D/2D data to work in 3D viewer
 * - Normalization of positions to [-1,1] range for consistent rendering
 * - Per-view dimension state tracking
 * - Efficient index-based operations (no data duplication)
 */

import { loadPointsBinary } from './data-loaders.js';
import { normalizePositions } from '../rendering/gl-utils.js';
import { getNotificationCenter } from '../app/notification-center.js';

const SUPPORTED_DIMENSIONS = new Set([1, 2, 3]);
const DEFAULT_MAX_POSITION_BYTES = 512 * 1024 * 1024;
const FLOAT32_BYTES = Float32Array.BYTES_PER_ELEMENT;

function toSupportedDimension(value) {
  if (!Number.isInteger(value) || !SUPPORTED_DIMENSIONS.has(value)) {
    return null;
  }
  return value;
}

function requireViewId(viewId) {
  if (typeof viewId !== 'string' || viewId.length === 0) {
    throw new TypeError('View id must be a non-empty string.');
  }
  return viewId;
}

/**
 * Parse the sole current embeddings metadata contract without mutating a
 * DimensionManager. Callers may commit the returned values only after this
 * function has validated the complete candidate.
 *
 * @param {unknown} meta
 * @returns {{
 *   availableDimensions: readonly number[],
 *   defaultDimension: number,
 *   dimensionFiles: Readonly<Record<string, string>>,
 *   pathMapKind: 'files'|'obsm_keys'
 * }}
 */
export function parseEmbeddingMetadata(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error(
      'Embeddings metadata must be an object using the current contract.'
    );
  }

  const rawAvailable = meta.available_dimensions;
  if (!Array.isArray(rawAvailable) || rawAvailable.length === 0) {
    throw new Error(
      'Embeddings metadata must declare a non-empty available_dimensions array.'
    );
  }
  const availableSet = new Set();
  for (let index = 0; index < rawAvailable.length; index++) {
    const value = rawAvailable[index];
    const dimension = toSupportedDimension(value);
    if (
      dimension == null ||
      availableSet.has(dimension) ||
      (
        index > 0 &&
        dimension <= rawAvailable[index - 1]
      )
    ) {
      throw new Error(
        'available_dimensions must contain strictly increasing unique ' +
        'integer dimensions 1, 2, or 3.'
      );
    }
    availableSet.add(dimension);
  }
  const availableDimensions = [...rawAvailable];

  const defaultDimension = toSupportedDimension(meta.default_dimension);
  if (defaultDimension == null || !availableSet.has(defaultDimension)) {
    throw new Error(
      'default_dimension must be one of the advertised available_dimensions.'
    );
  }

  const hasFiles = Object.hasOwn(meta, 'files');
  const hasObsmKeys = Object.hasOwn(meta, 'obsm_keys');
  if (hasFiles === hasObsmKeys) {
    throw new Error(
      'Embeddings metadata must declare exactly one path map: files or obsm_keys.'
    );
  }
  const pathMapKind = hasFiles ? 'files' : 'obsm_keys';
  const rawDimensionFiles = meta[pathMapKind];
  if (
    !rawDimensionFiles ||
    typeof rawDimensionFiles !== 'object' ||
    Array.isArray(rawDimensionFiles)
  ) {
    throw new Error('The embedding path map must be an object.');
  }

  const expectedKeys =
    availableDimensions.map(dimension => `${dimension}d`);
  const actualKeys = Object.keys(rawDimensionFiles);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some(key => !expectedKeys.includes(key))
  ) {
    throw new Error(
      'The embedding path map must contain exactly one advertised dimension path.'
    );
  }
  const dimensionFiles = {};
  for (const key of expectedKeys) {
    const path = rawDimensionFiles[key];
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error(
        `Embedding path map must declare one non-empty path for ${key}.`
      );
    }
    dimensionFiles[key] = path;
  }

  const allowedKeys = new Set([
    'available_dimensions',
    'default_dimension',
    pathMapKind,
  ]);
  for (const key of Object.keys(meta)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `Embeddings metadata contains unsupported field "${key}".`
      );
    }
  }

  return Object.freeze({
    availableDimensions: Object.freeze(availableDimensions),
    defaultDimension,
    dimensionFiles: Object.freeze(dimensionFiles),
    pathMapKind,
  });
}

/**
 * Create a dimension manager instance
 * @param {Object} options - Configuration options
 * @param {string} options.baseUrl - Base URL for loading dimension files
 * @param {Object} options.embeddingsMetadata - Embeddings metadata from dataset_identity.json
 * @param {boolean} options.keepRawPositions - Keep raw coordinate buffers after normalization
 * @param {number} options.maxPositionBytes - Maximum retained/transient position bytes
 * @returns {DimensionManager}
 */
export function createDimensionManager(options = {}) {
  return new DimensionManager(options);
}

/**
 * Create the exact single-dimension owner used by an in-memory dataset.
 *
 * The supplied positions are already normalized XYZ coordinates. They remain
 * owned by the caller and are published directly from the padded-position
 * cache; no URL or synthetic file entry is fabricated.
 *
 * @param {{ positions: Float32Array, dimension: number }} candidate
 * @returns {DimensionManager}
 */
export function createInMemoryDimensionManager(candidate) {
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate)
  ) {
    throw new TypeError(
      'In-memory dimension data must be an exact object.'
    );
  }
  const keys = Object.keys(candidate);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(candidate, 'positions') ||
    !Object.hasOwn(candidate, 'dimension')
  ) {
    throw new TypeError(
      'In-memory dimension data must contain exactly positions and dimension.'
    );
  }
  const dimension = toSupportedDimension(candidate.dimension);
  if (dimension === null) {
    throw new RangeError(
      'In-memory dimension must be exactly 1, 2, or 3.'
    );
  }
  const positions = candidate.positions;
  if (
    !(positions instanceof Float32Array) ||
    positions.length === 0 ||
    positions.length % 3 !== 0 ||
    positions.byteLength !==
      positions.length * Float32Array.BYTES_PER_ELEMENT
  ) {
    throw new TypeError(
      'In-memory positions must be a non-empty exact Float32 XYZ array.'
    );
  }
  for (let index = 0; index < positions.length; index += 1) {
    if (!Number.isFinite(positions[index])) {
      throw new RangeError(
        `In-memory position ${index} must be finite.`
      );
    }
  }

  const manager = new DimensionManager();
  manager.availableDimensions = [dimension];
  manager.defaultDimension = dimension;
  manager.dimensionFiles = {};
  manager.nCells = positions.length / 3;
  manager.paddedPositionCache.set(dimension, positions);
  manager.viewDimensions.set('live', dimension);
  return manager;
}

class DimensionManager {
  constructor({
    candidateAnnDataBinding = null,
    baseUrl = '',
    embeddingsMetadata = null,
    keepRawPositions = false,
    maxPositionBytes = DEFAULT_MAX_POSITION_BYTES,
    stagedSource = null
  } = {}) {
    if (
      !Number.isSafeInteger(maxPositionBytes) ||
      maxPositionBytes <= 0
    ) {
      throw new TypeError(
        'DimensionManager maxPositionBytes must be a positive safe integer.'
      );
    }
    if (typeof keepRawPositions !== 'boolean') {
      throw new TypeError(
        'DimensionManager keepRawPositions must be a boolean.'
      );
    }
    if (
      candidateAnnDataBinding !== null &&
      (
        typeof candidateAnnDataBinding !== 'object' ||
        stagedSource !== null
      )
    ) {
      throw new TypeError(
        'DimensionManager requires at most one candidate AnnData binding or ' +
        'staged custom-protocol source.'
      );
    }
    if (
      stagedSource !== null &&
      typeof stagedSource !== 'object'
    ) {
      throw new TypeError(
        'DimensionManager stagedSource must be an object or exact null.'
      );
    }
    this.baseUrl = baseUrl;
    this.candidateAnnDataBinding = candidateAnnDataBinding;
    this.keepRawPositions = keepRawPositions;
    this._maxPositionBytes = BigInt(maxPositionBytes);
    this.stagedSource = stagedSource;

    // Available dimensions from metadata
    this.availableDimensions = [];
    this.defaultDimension = 3;
    this.dimensionFiles = {};

    // Loaded position data cache: dimension -> Float32Array
    this.positionCache = new Map();

    // Loading promises to prevent duplicate fetches
    this.loadingPromises = new Map();

    // Active network controllers. Cache invalidation aborts the underlying
    // request instead of merely discarding its eventual result.
    this.loadingControllers = new Map();

    // Per-view dimension state: viewId -> dimension
    this.viewDimensions = new Map();

    // Normalized/padded positions for 3D rendering: dimension -> Float32Array (n_cells * 3)
    this.paddedPositionCache = new Map();

    // In-flight padding/normalization transactions. All concurrent callers for
    // a dimension share one result and one progress/cancellation owner.
    this.paddedLoadingPromises = new Map();

    // Normalization transforms per dimension: dimension -> { center: [x,y,z], scale: number }
    // Used to apply the same transform to centroids in state.js
    this.normTransformCache = new Map();

    // Number of cells (consistent across all dimensions)
    this.nCells = 0;

    // Lifecycle generation. Clearing the manager invalidates every result that
    // started against the previous dataset, including overridden load seams.
    this._generation = 0;

    // Parse metadata if provided
    if (embeddingsMetadata) {
      this.initFromMetadata(embeddingsMetadata);
    }
  }

  /**
   * Initialize from dataset_identity.json embeddings metadata
   * @param {Object} meta - Embeddings metadata object
   */
  initFromMetadata(meta) {
    const parsed = parseEmbeddingMetadata(meta);
    this.clearCache();
    this.viewDimensions.clear();
    this.availableDimensions = [...parsed.availableDimensions];
    this.defaultDimension = parsed.defaultDimension;
    this.dimensionFiles = { ...parsed.dimensionFiles };

    console.log(`[DimensionManager] Available dimensions: ${this.availableDimensions.join(', ')}D`);
    console.log(`[DimensionManager] Default dimension: ${this.defaultDimension}D`);
  }

  /**
   * Set the base URL for loading files
   * @param {string} url - Base URL (should end with /)
   */
  setBaseUrl(url) {
    this.baseUrl = url.endsWith('/') ? url : `${url}/`;
  }

  /**
   * Check if a dimension is available
   * @param {number} dim - Dimension (1, 2, or 3)
   * @returns {boolean}
   */
  hasDimension(dim) {
    const supported = toSupportedDimension(dim);
    if (supported == null) return false;
    return this.availableDimensions.includes(supported);
  }

  /**
   * Get the list of available dimensions
   * @returns {number[]} Array of available dimensions
   */
  getAvailableDimensions() {
    return [...this.availableDimensions];
  }

  /**
   * Get the default dimension
   * @returns {number}
   */
  getDefaultDimension() {
    return this.defaultDimension;
  }

  /**
   * Load raw position data for a dimension (lazy load)
   * @param {number} dim - Dimension to load
   * @param {Object} options - Loading options
   * @param {boolean} options.showProgress - Show progress notification (default: true)
   * @returns {Promise<Float32Array>} Raw position data
   */
  async loadDimension(dim, options = {}) {
    const generation = this._generation;
    const {
      showProgress = true,
      progressTrackerId = null
    } = options;
    const supportedDim = toSupportedDimension(dim);
    if (supportedDim == null) {
      throw new Error(`Dimension ${dim}D is not supported (supported: 1D/2D/3D).`);
    }
    dim = supportedDim;

    // Check if dimension is available
    if (!this.hasDimension(dim)) {
      throw new Error(`Dimension ${dim}D is not available. Available: ${this.availableDimensions.join(', ')}D`);
    }

    // Return cached data if available
    if (this.positionCache.has(dim)) {
      const cached = this.positionCache.get(dim);
      await Promise.resolve();
      this._assertGeneration(generation);
      return cached;
    }

    // Return existing loading promise if in progress
    if (this.loadingPromises.has(dim)) {
      return this.loadingPromises.get(dim);
    }

    // Start loading
    const dimensionKey = `${dim}d`;
    const filename = this.dimensionFiles[dimensionKey];
    if (
      !Object.hasOwn(this.dimensionFiles, dimensionKey) ||
      typeof filename !== 'string' ||
      filename.length === 0
    ) {
      throw new Error(
        `No embedding path is advertised for dimension ${dim}D.`
      );
    }
    const url = `${this.baseUrl}${filename}`;

    console.log(`[DimensionManager] Loading ${dim}D positions from ${url}`);

    const controller = new AbortController();
    this.loadingControllers.set(dim, controller);
    const notifications = getNotificationCenter();
    const ownsTracker = showProgress && !progressTrackerId;
    const trackerId = ownsTracker
      ? notifications.startDownload(
          `${dim}D cell positions`,
          null,
          { onCancel: () => controller.abort() }
        )
      : progressTrackerId;

    let promise;
    promise = loadPointsBinary(url, {
      candidateAnnDataBinding: this.candidateAnnDataBinding,
      dimension: dim,
      displayName: `${dim}D cell positions`,
      progressTrackerId: trackerId,
      showProgress: false,
      signal: controller.signal,
      stagedSource: this.stagedSource
    })
      .then(positions => {
        this._assertGeneration(generation, dim, promise);

        // Validate and cache
        if (positions.length % dim !== 0) {
          throw new Error(
            `Invalid positions length for ${dim}D: ${positions.length} values not divisible by ${dim}.`
          );
        }
        const nCells = positions.length / dim;
        if (!Number.isInteger(nCells)) {
          throw new Error(
            `Invalid positions length for ${dim}D: ${positions.length} produced non-integer cell count (${nCells}).`
          );
        }
        if (this.nCells === 0) {
          this.nCells = nCells;
        } else if (nCells !== this.nCells) {
          throw new Error(
            `Dimension ${dim}D has ${nCells} cells, but expected ${this.nCells} cells.`
          );
        }

        this.positionCache.set(dim, positions);
        if (this.loadingPromises.get(dim) === promise) {
          this.loadingPromises.delete(dim);
        }
        console.log(`[DimensionManager] Loaded ${dim}D: ${nCells.toLocaleString()} cells`);
        if (ownsTracker) {
          notifications.completeDownload(trackerId);
        }
        return positions;
      })
      .catch(err => {
        if (ownsTracker) {
          if (err?.name === 'AbortError' || controller.signal.aborted) {
            notifications.dismissDownload(trackerId);
          } else {
            notifications.failDownload(
              trackerId,
              err?.message || String(err)
            );
          }
        }
        if (err?.name !== 'AbortError') {
          console.error(`[DimensionManager] Failed to load ${dim}D:`, err);
        }
        throw err;
      })
      .finally(() => {
        if (this.loadingPromises.get(dim) === promise) {
          this.loadingPromises.delete(dim);
        }
        if (this.loadingControllers.get(dim) === controller) {
          this.loadingControllers.delete(dim);
        }
      });

    this.loadingPromises.set(dim, promise);
    return promise;
  }

  /**
   * Get 3D-padded positions for a dimension (for rendering in 3D viewer)
   * This pads 1D and 2D data with zeros to create valid 3D coordinates.
   *
   * @param {number} dim - Dimension (1, 2, or 3)
   * @param {Object} [options]
   * @param {boolean} [options.showProgress=true]
   * @returns {Promise<Float32Array>} 3D positions (n_cells * 3)
   */
  async getPositions3D(dim, options = {}) {
    const generation = this._generation;
    const { showProgress = true } = options;
    const supportedDim = toSupportedDimension(dim);
    if (supportedDim == null) {
      throw new Error(`Unsupported dimension ${dim}D (supported: 1D/2D/3D).`);
    }
    dim = supportedDim;

    // Check cache first (cached positions are already normalized)
    if (this.paddedPositionCache.has(dim)) {
      const cached = this.paddedPositionCache.get(dim);
      // Refresh least-recently-used order without changing byte ownership.
      this.paddedPositionCache.delete(dim);
      this.paddedPositionCache.set(dim, cached);
      await Promise.resolve();
      this._assertGeneration(generation);
      return cached;
    }

    // First caller owns the transaction's progress policy. Later callers share
    // its padding, normalization, result, and cancellation outcome.
    if (this.paddedLoadingPromises.has(dim)) {
      return this.paddedLoadingPromises.get(dim);
    }

    let promise;
    promise = this._loadPositions3DTransaction(dim, {
      generation,
      showProgress
    }).finally(() => {
      if (this.paddedLoadingPromises.get(dim) === promise) {
        this.paddedLoadingPromises.delete(dim);
      }
    });
    this.paddedLoadingPromises.set(dim, promise);
    return promise;
  }

  /**
   * Run the single shared padding/normalization transaction for a dimension.
   *
   * @param {number} dim
   * @param {Object} options
   * @param {number} options.generation
   * @param {boolean} options.showProgress
   * @returns {Promise<Float32Array>}
   * @private
   */
  async _loadPositions3DTransaction(dim, { generation, showProgress }) {
    const notifications = getNotificationCenter();
    const trackerId = showProgress
      ? notifications.startDownload(
          `${dim}D cell positions`,
          null,
          {
            onCancel: () => {
              this.loadingControllers.get(dim)?.abort();
            }
          }
        )
      : null;
    let rawPositions = null;

    try {
      // The outer padded-position transaction owns the terminal progress
      // state. The raw loader only contributes byte updates to its tracker.
      rawPositions = await this.loadDimension(dim, {
        progressTrackerId: trackerId,
        showProgress: false
      });
      this._assertGeneration(generation);
      const positionPlan = this._planPositionPadding(rawPositions, dim);
      const allocatesPaddedBuffer = dim !== 3 || this.keepRawPositions;
      this._preparePositionWorkspace(
        dim,
        rawPositions,
        allocatesPaddedBuffer ? positionPlan.paddedBytes : 0n
      );
      const nCells = positionPlan.nCells;

      let positions3D;

      if (dim === 3) {
        // For 3D, normalize in-place unless the caller explicitly requests keeping raw positions.
        positions3D = this.keepRawPositions ? new Float32Array(rawPositions) : rawPositions;
      } else if (dim === 1) {
        // 1D: X values only, Y and Z are zero
        positions3D = new Float32Array(positionPlan.paddedLength);
        for (let i = 0; i < nCells; i++) {
          positions3D[i * 3] = rawPositions[i];     // X
          positions3D[i * 3 + 1] = 0;                // Y = 0
          positions3D[i * 3 + 2] = 0;                // Z = 0
        }
      } else if (dim === 2) {
        // 2D: X and Y values, Z is zero
        positions3D = new Float32Array(positionPlan.paddedLength);
        for (let i = 0; i < nCells; i++) {
          positions3D[i * 3] = rawPositions[i * 2];     // X
          positions3D[i * 3 + 1] = rawPositions[i * 2 + 1]; // Y
          positions3D[i * 3 + 2] = 0;                    // Z = 0
        }
      }

      // Normalize positions to [-1,1] range for consistent rendering
      // This ensures all dimensions render at the same scale regardless of original data range
      // Note: For 1D/2D, only the used dimensions will affect normalization scale
      const normTransform = normalizePositions(positions3D);
      this._assertGeneration(generation);
      console.log(`[DimensionManager] Created normalized 3D positions for ${dim}D (scale: ${normTransform.scale.toFixed(4)})`);

      // Store both the normalized positions and the transform used
      // The transform is needed by state.js to normalize centroids consistently
      this.paddedPositionCache.set(dim, positions3D);
      this.normTransformCache.set(dim, normTransform);

      // Policy: keep raw positions only if explicitly requested.
      if (!this.keepRawPositions) {
        this.positionCache.delete(dim);
      }

      if (trackerId) {
        notifications.completeDownload(trackerId);
      }
      return positions3D;
    } catch (error) {
      if (
        rawPositions &&
        this.positionCache.get(dim) === rawPositions &&
        !this.paddedPositionCache.has(dim)
      ) {
        this.positionCache.delete(dim);
      }
      if (trackerId) {
        if (
          error?.name === 'AbortError' ||
          generation !== this._generation
        ) {
          notifications.dismissDownload(trackerId);
        } else {
          notifications.failDownload(
            trackerId,
            error?.message || String(error)
          );
        }
      }
      throw error;
    }
  }

  /**
   * Validate raw position shape and calculate the padded allocation without
   * touching coordinate values.
   *
   * @param {Float32Array} rawPositions
   * @param {number} dim
   * @returns {{ nCells: number, paddedBytes: bigint, paddedLength: number }}
   * @private
   */
  _planPositionPadding(rawPositions, dim) {
    const rawLength = Number(rawPositions?.length);
    const rawByteLength = Number(rawPositions?.byteLength);
    if (
      !Number.isSafeInteger(rawLength) ||
      rawLength < 0 ||
      rawLength % dim !== 0 ||
      !Number.isSafeInteger(rawByteLength) ||
      rawByteLength !== rawLength * FLOAT32_BYTES
    ) {
      throw new Error(
        `${dim}D positions have an invalid Float32 shape or byte length.`
      );
    }

    const nCells = rawLength / dim;
    const paddedLengthBigInt = BigInt(nCells) * 3n;
    const paddedBytes =
      paddedLengthBigInt * BigInt(FLOAT32_BYTES);
    if (paddedLengthBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `${dim}D positions require an unsafe padded coordinate count.`
      );
    }
    return {
      nCells,
      paddedBytes,
      paddedLength: Number(paddedLengthBigInt)
    };
  }

  /**
   * Return a stable allocation identity and retained byte count. Typed-array
   * views keep their complete backing buffer alive, so views of one buffer are
   * charged once and by the backing buffer's full size.
   *
   * @param {ArrayBufferView|Object} positions
   * @returns {{ identity: Object, bytes: bigint }}
   * @private
   */
  _describePositionBuffer(positions) {
    if (!positions || typeof positions !== 'object') {
      throw new Error('Position cache contains an invalid buffer.');
    }

    const backingBuffer = positions.buffer;
    const identity = (
      backingBuffer &&
      typeof backingBuffer === 'object'
    ) ? backingBuffer : positions;
    const byteLength = Number(
      identity === backingBuffer
        ? backingBuffer.byteLength
        : positions.byteLength
    );
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error('Position cache contains an invalid byte length.');
    }
    return { identity, bytes: BigInt(byteLength) };
  }

  /**
   * Count uniquely retained coordinate backing buffers.
   *
   * @param {Array<ArrayBufferView|Object>} [extraBuffers=[]]
   * @returns {bigint}
   * @private
   */
  _getRetainedPositionBytes(extraBuffers = []) {
    const uniqueBuffers = new Map();
    const add = positions => {
      const descriptor = this._describePositionBuffer(positions);
      if (!uniqueBuffers.has(descriptor.identity)) {
        uniqueBuffers.set(descriptor.identity, descriptor.bytes);
      }
    };

    for (const positions of this.positionCache.values()) add(positions);
    for (const positions of this.paddedPositionCache.values()) add(positions);
    for (const positions of extraBuffers) add(positions);

    let total = 0n;
    for (const bytes of uniqueBuffers.values()) total += bytes;
    return total;
  }

  /**
   * Release least-recently-used caches that are not assigned to a view, then
   * enforce the raw-plus-new-output peak before any coordinate iteration or
   * typed-array allocation.
   *
   * @param {number} dim
   * @param {Float32Array} rawPositions
   * @param {bigint} additionalOutputBytes
   * @private
   */
  _preparePositionWorkspace(dim, rawPositions, additionalOutputBytes) {
    const protectedDimensions = new Set([dim]);
    for (const viewDimension of this.viewDimensions.values()) {
      protectedDimensions.add(viewDimension);
    }

    const candidateDimensions = [];
    const seen = new Set();
    const addCandidate = candidateDim => {
      if (
        protectedDimensions.has(candidateDim) ||
        seen.has(candidateDim)
      ) {
        return;
      }
      seen.add(candidateDim);
      candidateDimensions.push(candidateDim);
    };
    for (const candidateDim of this.paddedPositionCache.keys()) {
      addCandidate(candidateDim);
    }
    for (const candidateDim of this.positionCache.keys()) {
      addCandidate(candidateDim);
    }

    const plannedBytes = () => (
      this._getRetainedPositionBytes([rawPositions]) +
      additionalOutputBytes
    );
    let workingBytes = plannedBytes();
    for (const candidateDim of candidateDimensions) {
      if (workingBytes <= this._maxPositionBytes) break;
      this.paddedPositionCache.delete(candidateDim);
      this.positionCache.delete(candidateDim);
      workingBytes = plannedBytes();
    }

    if (workingBytes > this._maxPositionBytes) {
      throw new Error(
        `${dim}D position raw-plus-padded working set ` +
        `(${workingBytes.toString()} bytes) exceeds the ` +
        `${this._maxPositionBytes.toString()}-byte browser limit; ` +
        'use the Cellucid server or reduce the embedding size.'
      );
    }
  }

  /**
   * Get dimension for a specific view
   * @param {string} viewId - View identifier
   * @returns {number} Dimension for this view
   */
  getViewDimension(viewId) {
    requireViewId(viewId);
    if (!this.viewDimensions.has(viewId)) {
      throw new RangeError(
        `Dimension state is not published for view "${viewId}".`
      );
    }
    const dimension = this.viewDimensions.get(viewId);
    if (!this.hasDimension(dimension)) {
      throw new Error(
        `Published dimension state for view "${viewId}" is invalid.`
      );
    }
    return dimension;
  }

  /**
   * Set dimension for a specific view
   * @param {string} viewId - View identifier
   * @param {number} dim - Dimension to set
   */
  setViewDimension(viewId, dim) {
    requireViewId(viewId);
    if (!this.hasDimension(dim)) {
      throw new Error(
        `Dimension ${String(dim)}D is not available. ` +
        `Available: ${this.availableDimensions.join(', ')}D`
      );
    }
    this.viewDimensions.set(viewId, dim);
  }

  /**
   * Copy dimension from one view to another (for "Keep View" feature)
   * @param {string} sourceViewId - Source view ID
   * @param {string} targetViewId - Target view ID
   */
  copyViewDimension(sourceViewId, targetViewId) {
    const dim = this.getViewDimension(sourceViewId);
    this.setViewDimension(targetViewId, dim);
  }

  /**
   * Remove dimension state for a view
   * @param {string} viewId - View identifier
   */
  removeView(viewId) {
    requireViewId(viewId);
    this.viewDimensions.delete(viewId);
  }

  /**
   * Clear all view dimension states
   */
  clearViewDimensions() {
    this.viewDimensions.clear();
  }

  /**
   * Get number of cells
   * @returns {number}
   */
  getCellCount() {
    return this.nCells;
  }

  /**
   * Get the normalization transform used for a dimension.
   * This is needed to apply the same transform to centroids.
   * @param {number} dim - Dimension (1, 2, or 3)
   * @returns {Object|null} Transform object { center: [x,y,z], scale: number } or null if not loaded
   */
  getNormTransform(dim) {
    return this.normTransformCache.get(dim) || null;
  }

  /**
   * Check if any dimension is currently loading
   * @returns {boolean}
   */
  isLoading() {
    return (
      this.loadingPromises.size > 0 ||
      this.paddedLoadingPromises.size > 0
    );
  }

  /**
   * Clear all cached data
   */
  clearCache() {
    this._generation += 1;
    for (const controller of this.loadingControllers.values()) {
      controller.abort();
    }
    this.positionCache.clear();
    this.paddedPositionCache.clear();
    this.paddedLoadingPromises.clear();
    this.normTransformCache.clear();
    this.loadingPromises.clear();
    this.loadingControllers.clear();
    this.nCells = 0;
  }

  /**
   * Reject work that belongs to a cleared/replaced dataset.
   *
   * @param {number} generation
   * @param {number|null} [dim=null]
   * @param {Promise<Float32Array>|null} [promise=null]
   * @private
   */
  _assertGeneration(generation, dim = null, promise = null) {
    const promiseIsCurrent = (
      dim == null ||
      promise == null ||
      this.loadingPromises.get(dim) === promise
    );
    if (generation !== this._generation || !promiseIsCurrent) {
      const error = new Error(
        'Dimension load was superseded because the dataset cache changed.'
      );
      error.name = 'AbortError';
      throw error;
    }
  }

}

export { DimensionManager };
