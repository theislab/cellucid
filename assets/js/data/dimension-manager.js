/**
 * Dimension Manager - the layout registry of the cellucid viewer.
 *
 * A *layout* is one embedding the viewer can place cells with: an exact
 * `layoutKey`, its dimension (1, 2 or 3), and where its coordinates come from.
 * The layout key, not the dimension, is the identity of a view's geometry:
 * every cache below is keyed by it, and every view publishes the layout it
 * shows.
 *
 * A layout that can be shown is a *representation*. The data mapping (see
 * `data-mapping.js`) decides which registered layouts are *enabled* -- any
 * number, of any mix of dimensions -- and names at most one *default* per
 * dimension; `setRepresentations` publishes both here. A view shows exactly
 * one enabled layout; its dimension is the layout's.
 *
 * The embeddings metadata contract (dataset identity version 3) declares any
 * number of embeddings per dimension: `initFromMetadata` registers one layout
 * per declared embedding, keyed by its embedding id, enables every one, and
 * makes the embedding `defaults` names for a dimension its default.
 *
 * A source that can read any `obsm` array on request (an `.h5ad` or Zarr file
 * opened in the browser) installs a *layout provider*: a reference to an array
 * and columns that no registered layout plots is then registered on demand,
 * with origin `mapping`, the first time a mapping, a view or a session names
 * it. Registering reads nothing; positions are loaded when a view shows the
 * layout.
 *
 * Supports:
 * - Lazy loading of layout positions
 * - Positions kept with exactly the layout's components per cell (x, xy or
 *   xyz; see `rendering/position-layout.js`) — nothing is padded to 3D
 * - In-place normalization of positions to [-1,1] range for consistent rendering
 * - Per-view layout state tracking
 * - A least-recently-used position cache bounded by `maxPositionBytes` (by
 *   default the `positions` residency budget of `memory-budget.js`, a share
 *   of the device memory the browser reports), in which every layout a view
 *   shows, or a caller pinned, is never evicted. The budget only decides
 *   what is evicted: a layout of any size is loaded and shown.
 * - Memory pressure: a JS heap above 85 % of its limit (Chromium reports it),
 *   or a failed typed-array allocation (every engine), evicts every unpinned
 *   layout -- and tells the renderer to drop the geometry it retains -- before
 *   one retry
 */

import { loadPointsBinary } from './data-loaders.js';
import { MappingLoadError } from './data-mapping-candidates.js';
import { normalizePositions } from '../rendering/gl-utils.js';
import { publishPositionBounds } from '../rendering/position-layout.js';
import { residencyBudgetBytes } from './memory-budget.js';

const SUPPORTED_DIMENSIONS = new Set([1, 2, 3]);
const LAYOUT_ORIGINS = new Set(['identity', 'mapping']);
const LAYOUT_DESCRIPTOR_KEYS = Object.freeze([
  'dimension',
  'label',
  'layoutKey',
  'origin',
  'path',
  'provenance',
]);
const MIB = 1024 * 1024;

/**
 * Whether one error is the engine refusing an allocation (a typed array or
 * ArrayBuffer too large for the memory left), as every engine reports it.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAllocationFailure(error) {
  return error instanceof RangeError &&
    /alloc|out of memory|array buffer|invalid array length/i.test(String(error.message));
}

function heapUnderPressure() {
  const memory = globalThis.performance?.memory;
  if (
    !memory ||
    !Number.isFinite(memory.usedJSHeapSize) ||
    !Number.isFinite(memory.jsHeapSizeLimit) ||
    memory.jsHeapSizeLimit <= 0
  ) {
    return false;
  }
  return memory.usedJSHeapSize > 0.85 * memory.jsHeapSizeLimit;
}
const FLOAT32_BYTES = Float32Array.BYTES_PER_ELEMENT;

function toSupportedDimension(value) {
  if (!Number.isInteger(value) || !SUPPORTED_DIMENSIONS.has(value)) {
    return null;
  }
  return value;
}

function requireSupportedDimension(value, label = 'Layout dimension') {
  const dimension = toSupportedDimension(value);
  if (dimension === null) {
    throw new RangeError(`${label} must be exactly 1, 2, or 3.`);
  }
  return dimension;
}

function requireViewId(viewId) {
  if (typeof viewId !== 'string' || viewId.length === 0) {
    throw new TypeError('View id must be a non-empty string.');
  }
  return viewId;
}

function requireLayoutKey(layoutKey, label = 'Layout key') {
  if (typeof layoutKey !== 'string' || layoutKey.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return layoutKey;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

/**
 * Validate the provenance of a layout: the stored array and the columns of it
 * that the layout plots, or exact null when the layout has no addressable
 * source array.
 *
 * @param {unknown} provenance
 * @param {number} dimension
 * @param {string} label
 * @returns {Readonly<{key: string, columns: readonly number[]|null}>|null}
 */
function requireLayoutProvenance(provenance, dimension, label) {
  if (provenance === null) return null;
  if (
    typeof provenance !== 'object' ||
    Array.isArray(provenance) ||
    Object.keys(provenance).sort().join(',') !== 'columns,key'
  ) {
    throw new TypeError(
      `${label} provenance must be null or exactly { key, columns }.`
    );
  }
  const key = requireNonEmptyString(provenance.key, `${label} provenance key`);
  const columns = provenance.columns;
  if (columns === null) {
    return Object.freeze({ key, columns: null });
  }
  if (!Array.isArray(columns) || columns.length !== dimension) {
    throw new TypeError(
      `${label} provenance columns must be null or exactly ${dimension} column indices.`
    );
  }
  const seen = new Set();
  for (const column of columns) {
    if (!Number.isSafeInteger(column) || column < 0 || seen.has(column)) {
      throw new TypeError(
        `${label} provenance columns must be distinct non-negative integers.`
      );
    }
    seen.add(column);
  }
  return Object.freeze({ key, columns: Object.freeze([...columns]) });
}

/**
 * Validate one layout descriptor without mutating any registry.
 *
 * `path` locates the layout's stored coordinates relative to the manager's
 * base URL; exact null marks a layout whose positions exist only in memory
 * and were published directly into the normalized-position cache.
 *
 * @param {unknown} descriptor
 * @returns {Readonly<{
 *   layoutKey: string,
 *   dimension: 1|2|3,
 *   label: string,
 *   path: string|null,
 *   provenance: Readonly<{key: string, columns: readonly number[]|null}>|null,
 *   origin: 'identity'|'mapping'
 * }>}
 */
function requireLayoutDescriptor(descriptor) {
  if (
    descriptor === null ||
    typeof descriptor !== 'object' ||
    Array.isArray(descriptor) ||
    Object.keys(descriptor).sort().join(',') !==
      LAYOUT_DESCRIPTOR_KEYS.join(',')
  ) {
    throw new TypeError(
      'A layout descriptor must contain exactly layoutKey, dimension, ' +
      'label, path, provenance, and origin.'
    );
  }
  const layoutKey = requireLayoutKey(descriptor.layoutKey);
  const label = `Layout "${layoutKey}"`;
  const dimension = requireSupportedDimension(
    descriptor.dimension,
    `${label} dimension`
  );
  if (!LAYOUT_ORIGINS.has(descriptor.origin)) {
    throw new TypeError(`${label} origin must be "identity" or "mapping".`);
  }
  return Object.freeze({
    layoutKey,
    dimension,
    label: requireNonEmptyString(descriptor.label, `${label} label`),
    path: descriptor.path === null
      ? null
      : requireNonEmptyString(descriptor.path, `${label} path`),
    provenance: requireLayoutProvenance(
      descriptor.provenance,
      dimension,
      label
    ),
    origin: descriptor.origin,
  });
}

/**
 * Validate one embedding reference as this registry resolves it: an AnnData
 * array key with its 0-based columns (1 to 3 of them, distinct), or a key with
 * exact null columns for a layout that reads no obsm columns (one generated in
 * memory, or an obsm array that cannot be plotted).
 *
 * @param {unknown} ref
 * @returns {Readonly<{key: string, columns: readonly number[]|null}>}
 */
export function requireRepresentationRef(ref) {
  if (
    ref === null ||
    typeof ref !== 'object' ||
    Array.isArray(ref) ||
    Object.keys(ref).sort().join(',') !== 'columns,key'
  ) {
    throw new TypeError('A representation reference must be exactly { key, columns }.');
  }
  const key = requireNonEmptyString(ref.key, 'Representation key');
  const columns = ref.columns;
  if (columns === null) return Object.freeze({ key, columns: null });
  if (
    !Array.isArray(columns) ||
    columns.length < 1 ||
    columns.length > 3 ||
    columns.some(column => !Number.isSafeInteger(column) || column < 0) ||
    new Set(columns).size !== columns.length
  ) {
    throw new TypeError(
      'Representation columns must be null or 1 to 3 distinct non-negative integers.'
    );
  }
  return Object.freeze({ key, columns: Object.freeze([...columns]) });
}

/**
 * Parse the embeddings metadata of a dataset identity without mutating a
 * DimensionManager. Callers may commit the returned values only after this
 * function has validated the complete candidate.
 *
 * Every item of `embeddings.items` becomes one layout, keyed by its embedding
 * id, in item order; `defaults` names each dimension's default. The exact route
 * and ordering rules are enforced by `validateDatasetIdentity`,
 * which every identity passes before its embeddings reach this parser; this
 * parser checks the structure it relies on.
 *
 * @param {unknown} meta
 * @returns {{
 *   defaultDimension: number,
 *   layouts: readonly ReturnType<typeof requireLayoutDescriptor>[],
 *   defaults: ReadonlyMap<number, string>
 * }}
 */
export function parseEmbeddingMetadata(meta) {
  if (
    !meta ||
    typeof meta !== 'object' ||
    Array.isArray(meta) ||
    Object.keys(meta).sort().join(',') !== 'default_dimension,defaults,items'
  ) {
    throw new Error(
      'Embeddings metadata must be an object with exactly default_dimension, ' +
      'defaults, and items.'
    );
  }
  const items = meta.items;
  if (
    !items ||
    typeof items !== 'object' ||
    Array.isArray(items) ||
    Object.keys(items).length === 0
  ) {
    throw new Error('Embeddings metadata items must be a non-empty object.');
  }
  const layouts = [];
  for (const [id, item] of Object.entries(items)) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(',') !== 'dimension,label,path,source'
    ) {
      throw new Error(
        `Embedding "${id}" must contain exactly label, dimension, path, and source.`
      );
    }
    const source = item.source;
    if (
      !source ||
      typeof source !== 'object' ||
      Array.isArray(source) ||
      Object.keys(source).sort().join(',') !== 'columns,key'
    ) {
      throw new Error(`Embedding "${id}" source must be exactly { key, columns }.`);
    }
    if (typeof item.path !== 'string' || item.path.length === 0) {
      throw new Error(`Embedding "${id}" path must be a non-empty route.`);
    }
    if (typeof source.key !== 'string' || source.key.length === 0) {
      throw new Error(`Embedding "${id}" source key must be a non-empty string.`);
    }
    const dimension = requireSupportedDimension(item.dimension, `Embedding "${id}" dimension`);
    if (
      !Array.isArray(source.columns) ||
      source.columns.length !== dimension ||
      source.columns.some(column => !Number.isSafeInteger(column) || column < 0) ||
      new Set(source.columns).size !== source.columns.length
    ) {
      throw new Error(
        `Embedding "${id}" source columns must be ${dimension} distinct 0-based indices.`
      );
    }
    layouts.push(requireLayoutDescriptor({
      layoutKey: id,
      dimension: item.dimension,
      label: item.label,
      path: item.path,
      provenance: { key: source.key, columns: source.columns },
      origin: 'identity',
    }));
  }

  const defaults = meta.defaults;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new Error('Embeddings metadata defaults must be an object.');
  }
  const dimensions = [...new Set(layouts.map(layout => layout.dimension))]
    .sort((left, right) => left - right);
  const expectedSlots = dimensions.map(dimension => `${dimension}d`);
  if (Object.keys(defaults).join(',') !== expectedSlots.join(',')) {
    throw new Error(
      'Embeddings metadata defaults must name exactly one embedding per ' +
      `dimension the items cover (${expectedSlots.join(', ')}).`
    );
  }
  const defaultLayouts = new Map();
  for (const dimension of dimensions) {
    const layoutKey = defaults[`${dimension}d`];
    const layout = layouts.find(candidate => candidate.layoutKey === layoutKey);
    if (layout === undefined || layout.dimension !== dimension) {
      throw new Error(
        `Embeddings metadata default for ${dimension}D must name a ` +
        `${dimension}D embedding item.`
      );
    }
    defaultLayouts.set(dimension, layoutKey);
  }

  const defaultDimension = toSupportedDimension(meta.default_dimension);
  if (defaultDimension == null || !defaultLayouts.has(defaultDimension)) {
    throw new Error(
      'default_dimension must be a dimension the embeddings defaults name.'
    );
  }

  return Object.freeze({
    defaultDimension,
    layouts: Object.freeze(layouts),
    defaults: defaultLayouts,
  });
}

/**
 * Create a dimension manager instance
 * @param {Object} options - Configuration options
 * @param {string} options.baseUrl - Base URL for loading layout files
 * @param {Object} options.embeddingsMetadata - The dataset identity's embeddings metadata
 * @param {number} options.maxPositionBytes - Maximum retained/transient position bytes
 * @returns {DimensionManager}
 */
export function createDimensionManager(options = {}) {
  return new DimensionManager(options);
}

/**
 * Create the exact single-layout owner used by an in-memory dataset.
 *
 * The supplied positions are already normalized coordinates with `dimension`
 * components per cell. They remain owned by the caller and are published
 * directly from the normalized-position cache, pinned for the manager's
 * lifetime because the caller holds them anyway; no URL or synthetic file
 * entry is fabricated. That layout is keyed by its dimension ("1d", "2d" or
 * "3d"); it is enabled and is its dimension's default.
 *
 * `representations` adds further in-memory representations (the synthetic
 * benchmark's multi-representation datasets): each is produced on demand by
 * `produce()` -- raw coordinates, normalized here -- the first time a view
 * shows it, is enabled, and is evictable like any loaded layout. The first one
 * of a dimension the primary layout does not cover is that dimension's
 * default.
 *
 * @param {{
 *   positions: Float32Array,
 *   dimension: number,
 *   representations?: ReadonlyArray<{layoutKey: string, label: string, dimension: number, produce: () => Float32Array}>
 * }} candidate
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
  const representations = Object.hasOwn(candidate, 'representations')
    ? candidate.representations
    : [];
  if (
    keys.length !== (Object.hasOwn(candidate, 'representations') ? 3 : 2) ||
    !Object.hasOwn(candidate, 'positions') ||
    !Object.hasOwn(candidate, 'dimension') ||
    !Array.isArray(representations)
  ) {
    throw new TypeError(
      'In-memory dimension data must contain exactly positions, dimension and ' +
      'optionally a list of representations.'
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
    positions.length % dimension !== 0 ||
    positions.byteLength !==
      positions.length * Float32Array.BYTES_PER_ELEMENT
  ) {
    throw new TypeError(
      `In-memory positions must be a non-empty exact Float32 array with ${dimension} values per cell.`
    );
  }
  for (let index = 0; index < positions.length; index += 1) {
    if (!Number.isFinite(positions[index])) {
      throw new RangeError(
        `In-memory position ${index} must be finite.`
      );
    }
  }

  const layoutKey = `${dimension}d`;
  const manager = new DimensionManager();
  const descriptors = [{
    layoutKey,
    dimension,
    label: 'Generated',
    path: null,
    provenance: null,
    origin: 'identity',
  }];
  const defaults = new Map([[dimension, layoutKey]]);
  for (const [index, representation] of representations.entries()) {
    if (
      representation === null ||
      typeof representation !== 'object' ||
      typeof representation.produce !== 'function'
    ) {
      throw new TypeError(`In-memory representation ${index} must provide produce().`);
    }
    const repDimension = requireSupportedDimension(
      representation.dimension,
      `In-memory representation ${index} dimension`
    );
    descriptors.push({
      layoutKey: requireLayoutKey(representation.layoutKey),
      dimension: repDimension,
      label: requireNonEmptyString(representation.label, `In-memory representation ${index} label`),
      path: null,
      provenance: null,
      origin: 'identity',
    });
    if (!defaults.has(repDimension)) defaults.set(repDimension, representation.layoutKey);
  }
  const keysInOrder = manager.registerLayouts(descriptors);
  for (const representation of representations) {
    manager._memorySources.set(representation.layoutKey, representation.produce);
  }
  manager.setRepresentations(keysInOrder, defaults);
  manager._openingDimension = dimension;
  manager.publishCellCount(positions.length / dimension);
  manager.normalizedPositionCache.set(layoutKey, positions);
  // The coordinates are published as given: the layout's normalization is
  // the identity, and saying so is what lets figure export, centroids and
  // vectors map them (`getNormTransform`) like any other layout.
  manager.normTransformCache.set(layoutKey, { center: [0, 0, 0], scale: 1 });
  // The caller owns these coordinates for the dataset's lifetime, so evicting
  // them would free nothing and lose the only copy.
  manager._layoutPins.set(layoutKey, 1);
  manager.viewLayouts.set('live', layoutKey);
  return manager;
}

class DimensionManager {
  constructor({
    candidateAnnDataBinding = null,
    baseUrl = '',
    embeddingsMetadata = null,
    maxPositionBytes = residencyBudgetBytes('positions')
  } = {}) {
    if (
      !Number.isSafeInteger(maxPositionBytes) ||
      maxPositionBytes <= 0
    ) {
      throw new TypeError(
        'DimensionManager maxPositionBytes must be a positive safe integer.'
      );
    }
    if (
      candidateAnnDataBinding !== null &&
      typeof candidateAnnDataBinding !== 'object'
    ) {
      throw new TypeError(
        'DimensionManager candidateAnnDataBinding must be one binding or exact null.'
      );
    }
    this.baseUrl = baseUrl;
    this.candidateAnnDataBinding = candidateAnnDataBinding;
    this._maxPositionBytes = BigInt(maxPositionBytes);

    // Registered layouts: layoutKey -> frozen descriptor, in registration
    // order.
    this._layouts = new Map();

    // The representations a view can show: enabled layout keys, in the data
    // mapping's order. A dimension is available exactly when one of its
    // layouts is enabled.
    this._enabledLayouts = Object.freeze([]);

    // Dataset-level default layout of each dimension: dimension -> layoutKey,
    // always an enabled layout of that dimension.
    this._defaultLayouts = new Map();

    // The dimension the dataset opens on, as its identity states it; when the
    // mapping leaves that dimension without a default, the highest dimension
    // that has one.
    this._openingDimension = 3;

    // Told when positions leave the cache (so a renderer can drop geometry it
    // keeps for them) and when memory runs short. See setResidencyListener().
    this._residencyListener = null;

    // In-memory layouts produced on demand (synthetic datasets): layoutKey ->
    // () => raw Float32Array coordinates.
    this._memorySources = new Map();

    // Builds the descriptor of a layout for an AnnData `{key, columns}`
    // reference that no registered layout plots, or null when this dataset's
    // source cannot read arrays on request. See setLayoutProvider().
    this._layoutProvider = null;

    // Loaded positions not yet published: layoutKey -> Float32Array, already
    // in display coordinates (the reader worker normalized an AnnData
    // embedding; an in-memory layout is fitted as it is produced). An entry
    // lives only between load and publication; every reader of coordinates
    // reads normalizedPositionCache.
    this.positionCache = new Map();

    // The display transform of each loaded layout, published with it:
    // layoutKey -> { center: [x,y,z], scale: number }.
    this.loadedTransformCache = new Map();

    // Loading promises to prevent duplicate fetches: layoutKey -> Promise
    this.loadingPromises = new Map();

    // Active network controllers. Cache invalidation aborts the underlying
    // request instead of merely discarding its eventual result.
    this.loadingControllers = new Map();

    // Per-view layout state: viewId -> layoutKey
    this.viewLayouts = new Map();

    // Normalized positions for rendering: layoutKey -> Float32Array
    // (n_cells * dimension). For a layout the loader read, this is the
    // loaded array itself.
    this.normalizedPositionCache = new Map();

    // In-flight normalization transactions. All concurrent callers for a
    // layout share one result and one progress/cancellation owner.
    this.normalizedLoadingPromises = new Map();

    // Normalization transforms per layout:
    // layoutKey -> { center: [x,y,z], scale: number }. Centroids, vectors and
    // figure axes apply the same transform as the layout's positions.
    this.normTransformCache = new Map();

    // Layouts a caller holds resident regardless of view use:
    // layoutKey -> number of unreleased pins.
    this._layoutPins = new Map();

    // Number of cells (consistent across all layouts). Zero means the axis
    // is not known yet: either `publishCellCount` states it from the dataset
    // identity, or the first decoded embedding teaches it.
    this.nCells = 0;

    // Whether the axis above came from `publishCellCount` rather than from a
    // decoded payload. Only the published form pins the ordering against
    // `initFromMetadata`; a learned axis is already downstream of it.
    this._cellAxisPublished = false;

    // Lifecycle generation. Clearing the manager invalidates every result that
    // started against the previous dataset, including overridden load seams.
    this._generation = 0;

    // Parse metadata if provided
    if (embeddingsMetadata) {
      this.initFromMetadata(embeddingsMetadata);
    }
  }

  /**
   * Publish the dataset's canonical cell axis before any embedding loads.
   *
   * `loadLayout` bounds a payload at `nCells * dim * 4` bytes, but it can
   * only do that once some embedding has landed and taught it the count. The
   * *first* embedding would therefore have no exact length to check unless
   * the axis is published up front from `stats.n_cells`, which the dataset
   * identity already states. This is the sole seam for doing
   * that: it exists so the invariant lives in the module that owns it rather
   * than in each construction site's memory.
   *
   * Ordering is enforced rather than documented. `initFromMetadata` clears the
   * cache and a cache clear resets the axis, so publishing first would be
   * silently discarded; that sequence now throws instead.
   *
   * @param {number} nCells - Exact cell count from the dataset identity.
   * @returns {number} The published count.
   */
  publishCellCount(nCells) {
    if (!Number.isSafeInteger(nCells) || nCells < 1) {
      throw new TypeError(
        'Dimension cell axis must be published as a positive safe integer, ' +
        `received ${typeof nCells === 'number' ? nCells : typeof nCells}.`
      );
    }
    if (this.nCells !== 0 && this.nCells !== nCells) {
      throw new RangeError(
        `Dimension cell axis is already ${this.nCells}; refusing to republish ` +
        `it as ${nCells}. Clear the manager before reusing it for another dataset.`
      );
    }
    this.nCells = nCells;
    this._cellAxisPublished = true;
    return nCells;
  }

  /**
   * Initialize from the dataset identity's embeddings metadata: register one
   * layout per declared embedding, enable every one, and make each
   * dimension's declared default its default.
   * @param {Object} meta - Embeddings metadata object
   */
  initFromMetadata(meta) {
    const parsed = parseEmbeddingMetadata(meta);
    if (this._cellAxisPublished) {
      throw new Error(
        'Dimension embedding metadata must be installed before the cell axis ' +
        'is published: replacing the metadata clears the cache, which would ' +
        'discard the published axis and leave the first embedding bounded ' +
        'only by the browser byte ceiling.'
      );
    }
    this.clearCache();
    this.viewLayouts.clear();
    this._layoutPins.clear();
    this._layouts.clear();
    this._memorySources.clear();
    this._enabledLayouts = Object.freeze([]);
    this._defaultLayouts = new Map();
    this._layoutProvider = null;
    const keys = this.registerLayouts(parsed.layouts);
    this.setRepresentations(keys, parsed.defaults);
    this._openingDimension = parsed.defaultDimension;

    console.log(
      `[DimensionManager] ${keys.length} representation(s), ` +
      `dimensions ${this.getAvailableDimensions().join(', ')}D, opening on ${this.getDefaultDimension()}D`
    );
  }

  /**
   * Register layouts. The whole batch is validated before any is published:
   * a key may be registered only once.
   *
   * @param {readonly object[]} descriptors - See `requireLayoutDescriptor`.
   * @returns {readonly string[]} The registered layout keys, in order.
   */
  registerLayouts(descriptors) {
    if (!Array.isArray(descriptors) || descriptors.length === 0) {
      throw new TypeError(
        'Layout registration requires a non-empty array of descriptors.'
      );
    }
    const staged = [];
    const stagedKeys = new Set();
    for (const descriptor of descriptors) {
      const layout = requireLayoutDescriptor(descriptor);
      if (
        this._layouts.has(layout.layoutKey) ||
        stagedKeys.has(layout.layoutKey)
      ) {
        throw new Error(
          `Layout "${layout.layoutKey}" is already registered.`
        );
      }
      stagedKeys.add(layout.layoutKey);
      staged.push(layout);
    }
    for (const layout of staged) {
      this._layouts.set(layout.layoutKey, layout);
    }
    return Object.freeze(staged.map(layout => layout.layoutKey));
  }

  /**
   * @param {string} layoutKey
   * @returns {boolean}
   */
  hasLayout(layoutKey) {
    return this._layouts.has(requireLayoutKey(layoutKey));
  }

  /**
   * @param {string} layoutKey
   * @returns {ReturnType<typeof requireLayoutDescriptor>}
   */
  getLayout(layoutKey) {
    const key = requireLayoutKey(layoutKey);
    const layout = this._layouts.get(key);
    if (layout === undefined) {
      throw new RangeError(`Layout "${key}" is not registered.`);
    }
    return layout;
  }

  /**
   * Every registered layout, in registration order.
   * @returns {ReturnType<typeof requireLayoutDescriptor>[]}
   */
  getRegisteredLayouts() {
    return [...this._layouts.values()];
  }

  /**
   * Registered layouts of one dimension, in registration order.
   * @param {number} dim
   * @returns {ReturnType<typeof requireLayoutDescriptor>[]}
   */
  getLayoutsForDimension(dim) {
    const dimension = requireSupportedDimension(dim);
    const layouts = [];
    for (const layout of this._layouts.values()) {
      if (layout.dimension === dimension) layouts.push(layout);
    }
    return layouts;
  }

  /**
   * Publish the representations a view can show and the default of each
   * dimension, as one replacement. Every key must be registered and listed
   * once; every default must be an enabled layout of its dimension; at least
   * one default must be named. Views are not checked here: the data state
   * moves every view off a layout before disabling it.
   *
   * @param {readonly string[]} enabledLayoutKeys
   * @param {ReadonlyMap<number, string>} defaultLayouts - dimension -> layoutKey
   */
  setRepresentations(enabledLayoutKeys, defaultLayouts) {
    if (!Array.isArray(enabledLayoutKeys) || enabledLayoutKeys.length === 0) {
      throw new TypeError('At least one representation must be enabled.');
    }
    const enabled = enabledLayoutKeys.map(key => this.getLayout(key).layoutKey);
    if (new Set(enabled).size !== enabled.length) {
      throw new RangeError('A representation is enabled twice.');
    }
    if (!(defaultLayouts instanceof Map) || defaultLayouts.size === 0) {
      throw new TypeError('Representation defaults must be a non-empty Map of dimension to layout.');
    }
    const defaults = new Map();
    for (const [dim, layoutKey] of defaultLayouts) {
      const dimension = requireSupportedDimension(dim, 'Default representation dimension');
      const layout = this.getLayout(layoutKey);
      if (layout.dimension !== dimension) {
        throw new RangeError(
          `Layout "${layout.layoutKey}" is ${layout.dimension}D and cannot be the ${dimension}D default.`
        );
      }
      if (!enabled.includes(layout.layoutKey)) {
        throw new RangeError(`The ${dimension}D default "${layout.layoutKey}" is not enabled.`);
      }
      defaults.set(dimension, layout.layoutKey);
    }
    this._enabledLayouts = Object.freeze(enabled);
    this._defaultLayouts = defaults;
  }

  /**
   * The enabled layout keys, in the data mapping's order.
   * @returns {readonly string[]}
   */
  getEnabledLayoutKeys() {
    return this._enabledLayouts;
  }

  /**
   * @param {string} layoutKey
   * @returns {boolean}
   */
  isEnabled(layoutKey) {
    return this._enabledLayouts.includes(requireLayoutKey(layoutKey));
  }

  /**
   * The enabled layouts of one dimension, in the data mapping's order.
   * @param {number} dim
   * @returns {ReturnType<typeof requireLayoutDescriptor>[]}
   */
  getEnabledLayoutsForDimension(dim) {
    const dimension = requireSupportedDimension(dim);
    return this._enabledLayouts
      .map(key => this._layouts.get(key))
      .filter(layout => layout.dimension === dimension);
  }

  /**
   * The dataset-level default layout of a dimension, or null when the mapping
   * names none for it.
   * @param {number} dim
   * @returns {string|null}
   */
  getDefaultLayout(dim) {
    const dimension = requireSupportedDimension(dim);
    return this._defaultLayouts.get(dimension) ?? null;
  }

  /**
   * The layout a view of one dimension shows when no layout of it was
   * chosen: the dimension's default, else its first enabled layout, else
   * null when no layout of that dimension is enabled.
   * @param {number} dim
   * @returns {string|null}
   */
  getOpeningLayout(dim) {
    return this.getDefaultLayout(dim)
      ?? this.getEnabledLayoutsForDimension(dim)[0]?.layoutKey
      ?? null;
  }

  /**
   * Install the provider that registers layouts on demand for AnnData
   * `{key, columns}` references, or remove it with null.
   *
   * @param {((ref: {key: string, columns: number[]}) => Object)|null} provider
   *   Returns a layout descriptor (see `requireLayoutDescriptor`) whose
   *   provenance is exactly the reference, or throws a RangeError naming why
   *   the reference cannot be plotted.
   */
  setLayoutProvider(provider) {
    if (provider !== null && typeof provider !== 'function') {
      throw new TypeError('A layout provider must be a function or null.');
    }
    this._layoutProvider = provider;
  }

  /**
   * Whether layouts can be registered on demand for this dataset.
   * @returns {boolean}
   */
  hasLayoutProvider() {
    return this._layoutProvider !== null;
  }

  /**
   * The registered layout plotting exactly these columns of one source array,
   * registering it through the layout provider when none does yet. Returns
   * null when no layout plots them and none can be registered.
   *
   * @param {string} key
   * @param {readonly number[]} columns
   * @returns {string|null}
   */
  resolveProvenanceLayout(key, columns) {
    const registered = this.findLayoutByProvenance(key, columns);
    if (registered !== null || this._layoutProvider === null) return registered;
    let descriptor;
    try {
      descriptor = this._layoutProvider({ key, columns: [...columns] });
    } catch (error) {
      if (error instanceof RangeError) return null;
      throw error;
    }
    const layout = requireLayoutDescriptor(descriptor);
    if (
      layout.origin !== 'mapping' ||
      layout.provenance === null ||
      layout.provenance.key !== key ||
      layout.provenance.columns === null ||
      layout.provenance.columns.join(',') !== columns.join(',')
    ) {
      throw new TypeError(
        'A layout provider must describe exactly the requested reference as a mapping layout.'
      );
    }
    this.registerLayouts([layout]);
    return layout.layoutKey;
  }

  /**
   * The registered layout an embedding reference names: an AnnData obsm
   * array read at `columns`, which is the provenance of the layout that plots
   * them -- registered through the layout provider when none does yet. A
   * reference without columns names no layout. Registering reads nothing.
   *
   * @param {{key: string, columns: readonly number[]|null}} ref
   * @returns {string} The layout key.
   * @throws {RangeError} When this dataset cannot plot the reference.
   */
  resolveRepresentation(ref) {
    const exact = requireRepresentationRef(ref);
    // Every embedding reference names the obsm array and the columns it
    // plots (see data/dataset-mapping.js `layoutEmbeddingRef`); a layout is
    // found by that provenance, never by a bare key.
    if (exact.columns === null) {
      throw new TypeError(
        `The embedding reference to obsm['${exact.key}'] must list the columns it plots.`
      );
    }
    const layoutKey = this.resolveProvenanceLayout(exact.key, exact.columns);
    if (layoutKey === null) {
      throw new RangeError(
        `This dataset cannot plot obsm['${exact.key}'] columns [${exact.columns.join(', ')}].`
      );
    }
    return layoutKey;
  }

  /**
   * The registered layout plotting exactly these columns of one source array,
   * or null when none does.
   *
   * @param {string} key - The source array (an AnnData obsm key).
   * @param {readonly number[]} columns - 0-based columns, one per axis.
   * @returns {string|null}
   */
  findLayoutByProvenance(key, columns) {
    requireNonEmptyString(key, 'Layout provenance key');
    if (!Array.isArray(columns)) {
      throw new TypeError('Layout provenance columns must be an array.');
    }
    for (const layout of this._layouts.values()) {
      const provenance = layout.provenance;
      if (
        provenance !== null &&
        provenance.key === key &&
        provenance.columns !== null &&
        provenance.columns.length === columns.length &&
        provenance.columns.every((column, index) => column === columns[index])
      ) {
        return layout.layoutKey;
      }
    }
    return null;
  }

  /**
   * Whether a layout of this dimension is enabled.
   * @param {number} dim - Dimension (1, 2, or 3)
   * @returns {boolean}
   */
  hasDimension(dim) {
    const supported = toSupportedDimension(dim);
    if (supported == null) return false;
    return this._enabledLayouts.some(key => this._layouts.get(key).dimension === supported);
  }

  /**
   * The dimensions of the enabled layouts, ascending.
   * @returns {number[]}
   */
  getAvailableDimensions() {
    return [...new Set(this._enabledLayouts.map(key => this._layouts.get(key).dimension))]
      .sort((left, right) => left - right);
  }

  /**
   * The dimension the dataset opens on: the one its identity names when that
   * dimension has a default, else the highest dimension that has one.
   * @returns {number}
   */
  getDefaultDimension() {
    if (
      this._defaultLayouts.size === 0 ||
      this._defaultLayouts.has(this._openingDimension)
    ) {
      return this._openingDimension;
    }
    return Math.max(...this._defaultLayouts.keys());
  }

  /**
   * The layout the dataset opens on: the default of `getDefaultDimension()`,
   * or null before any representation is published.
   * @returns {string|null}
   */
  getDefaultLayoutKey() {
    return this._defaultLayouts.get(this.getDefaultDimension()) ?? null;
  }

  /**
   * Load raw position data for a layout (lazy load). Positions are read from
   * the AnnData file, whose reads are in the Transfers panel.
   * @param {string} layoutKey - Layout to load
   * @returns {Promise<Float32Array>} Raw position data
   */
  async loadLayout(layoutKey) {
    const generation = this._generation;
    const layout = this.getLayout(layoutKey);
    const key = layout.layoutKey;
    const dim = layout.dimension;

    // Return cached data if available
    if (this.positionCache.has(key)) {
      const cached = this.positionCache.get(key);
      await Promise.resolve();
      this._assertGeneration(generation);
      return cached;
    }

    // Return existing loading promise if in progress
    if (this.loadingPromises.has(key)) {
      return this.loadingPromises.get(key);
    }

    if (layout.path === null) {
      const produce = this._memorySources.get(key);
      if (produce === undefined) {
        throw new Error(
          `Layout "${key}" has no stored coordinates to load; its positions ` +
          'exist only in memory.'
        );
      }
      const produced = Promise.resolve().then(() => {
        const positions = produce();
        this._assertGeneration(generation, key, produced);
        if (
          !(positions instanceof Float32Array) ||
          (this.nCells !== 0 && positions.length !== this.nCells * dim)
        ) {
          throw new TypeError(
            `In-memory layout "${key}" must produce exactly ${this.nCells * dim} Float32 values.`
          );
        }
        // Produced coordinates are fitted to the view in place, as they are
        // made, with the transform that maps them.
        this.loadedTransformCache.set(key, normalizePositions(positions, dim));
        this.positionCache.set(key, positions);
        return positions;
      }).finally(() => {
        if (this.loadingPromises.get(key) === produced) {
          this.loadingPromises.delete(key);
        }
      });
      this.loadingPromises.set(key, produced);
      return produced;
    }
    const url = `${this.baseUrl}${layout.path}`;

    console.log(`[DimensionManager] Loading ${dim}D positions from ${url}`);

    const controller = new AbortController();
    this.loadingControllers.set(key, controller);

    let promise;
    promise = loadPointsBinary(url, {
      candidateAnnDataBinding: this.candidateAnnDataBinding,
      dimension: dim,
      signal: controller.signal
    })
      .then(({ positions, transform, bounds }) => {
        this._assertGeneration(generation, key, promise);

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

        // The reader worker scanned the coordinates: their bounds are known.
        if (bounds !== null) publishPositionBounds(positions, dim, bounds);
        this.loadedTransformCache.set(key, transform);
        this.positionCache.set(key, positions);
        if (this.loadingPromises.get(key) === promise) {
          this.loadingPromises.delete(key);
        }
        console.log(`[DimensionManager] Loaded ${dim}D: ${nCells.toLocaleString()} cells`);
        return positions;
      })
      .catch(err => {
        if (err instanceof MappingLoadError) {
          // A refused mapping choice: the panel names it and keeps the rest.
          console.warn(`[DimensionManager] ${err.message}`);
        } else if (err?.name !== 'AbortError') {
          console.error(`[DimensionManager] Failed to load ${dim}D:`, err);
        }
        throw err;
      })
      .finally(() => {
        if (this.loadingPromises.get(key) === promise) {
          this.loadingPromises.delete(key);
        }
        if (this.loadingControllers.get(key) === controller) {
          this.loadingControllers.delete(key);
        }
      });

    this.loadingPromises.set(key, promise);
    return promise;
  }

  /**
   * Get normalized positions for a layout, with exactly the layout's
   * dimension of components per cell (x, xy or xyz).
   *
   * @param {string} layoutKey
   * @returns {Promise<Float32Array>} Normalized positions (n_cells * dim)
   */
  async getPositions(layoutKey) {
    const generation = this._generation;
    const key = this.getLayout(layoutKey).layoutKey;

    // Check cache first (cached positions are already normalized)
    if (this.normalizedPositionCache.has(key)) {
      const cached = this.normalizedPositionCache.get(key);
      // Refresh least-recently-used order without changing byte ownership.
      this.normalizedPositionCache.delete(key);
      this.normalizedPositionCache.set(key, cached);
      await Promise.resolve();
      this._assertGeneration(generation);
      return cached;
    }

    // Later callers share the first caller's normalization, result, and
    // cancellation outcome.
    if (this.normalizedLoadingPromises.has(key)) {
      return this.normalizedLoadingPromises.get(key);
    }

    let promise;
    promise = this._loadNormalizedPositionsTransaction(key, {
      generation
    }).finally(() => {
      if (this.normalizedLoadingPromises.get(key) === promise) {
        this.normalizedLoadingPromises.delete(key);
      }
    });
    this.normalizedLoadingPromises.set(key, promise);
    return promise;
  }

  /**
   * Run the single shared publication transaction for a layout.
   *
   * The loaded array arrives in display coordinates (normalized once, where
   * it was read or produced) and is published as is, so a layout costs
   * exactly `n_cells * dim * 4` bytes once loaded and no pass over it runs
   * here. Centroids and figure axes are expressed in the display space
   * through `getNormTransform` where their source is the layout's own
   * coordinates; vector fields arrive scaled into it.
   *
   * @param {string} layoutKey
   * @param {Object} options
   * @param {number} options.generation
   * @returns {Promise<Float32Array>}
   * @private
   */
  async _loadNormalizedPositionsTransaction(
    layoutKey,
    { generation }
  ) {
    const dim = this.getLayout(layoutKey).dimension;
    let rawPositions = null;

    try {
      try {
        rawPositions = await this.loadLayout(layoutKey);
      } catch (error) {
        if (!isAllocationFailure(error)) throw error;
        // Out of memory: release everything not shown, then try once more.
        this._assertGeneration(generation);
        console.warn(
          `[DimensionManager] Allocation failed loading "${layoutKey}"; releasing cached positions and retrying once.`
        );
        this.releaseUnderPressure();
        rawPositions = await this.loadLayout(layoutKey);
      }
      this._assertGeneration(generation);
      this._requirePositionShape(rawPositions, dim);
      this._preparePositionWorkspace(layoutKey, rawPositions);

      // The loaded array is already in display coordinates: it is published
      // as it is, with the transform that maps the layout's own coordinates
      // (centroids, figure axes) into them.
      const positions = rawPositions;
      const normTransform = this.loadedTransformCache.get(layoutKey);
      this.normalizedPositionCache.set(layoutKey, positions);
      this.normTransformCache.set(layoutKey, normTransform);

      this.positionCache.delete(layoutKey);
      this.loadedTransformCache.delete(layoutKey);
      return positions;
    } catch (error) {
      if (
        rawPositions &&
        this.positionCache.get(layoutKey) === rawPositions &&
        !this.normalizedPositionCache.has(layoutKey)
      ) {
        this.positionCache.delete(layoutKey);
      }
      throw error;
    }
  }

  /**
   * Validate the raw position shape without touching coordinate values.
   *
   * @param {Float32Array} rawPositions
   * @param {number} dim
   * @private
   */
  _requirePositionShape(rawPositions, dim) {
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
    for (const positions of this.normalizedPositionCache.values()) add(positions);
    for (const positions of extraBuffers) add(positions);

    let total = 0n;
    for (const bytes of uniqueBuffers.values()) total += bytes;
    return total;
  }

  /**
   * Bytes of the positions the views show now, plus `extra`.
   *
   * @param {Float32Array} extra
   * @returns {bigint}
   * @private
   */
  _shownPositionBytes(extra) {
    const shown = [extra];
    for (const layoutKey of new Set(this.viewLayouts.values())) {
      const positions = this.normalizedPositionCache.get(layoutKey) ?? this.positionCache.get(layoutKey);
      if (positions) shown.push(positions);
    }
    const unique = new Map();
    for (const positions of shown) {
      const descriptor = this._describePositionBuffer(positions);
      unique.set(descriptor.identity, descriptor.bytes);
    }
    let total = 0n;
    for (const bytes of unique.values()) total += bytes;
    return total;
  }

  /**
   * Layouts whose cached positions may be released, least recently used
   * first: everything cached that no view shows and no caller pinned.
   *
   * @param {Set<string>} [alsoProtected]
   * @returns {string[]}
   * @private
   */
  _evictableLayouts(alsoProtected = new Set()) {
    const protectedLayouts = new Set(alsoProtected);
    for (const layoutKey of this.viewLayouts.values()) {
      protectedLayouts.add(layoutKey);
    }
    for (const layoutKey of this._layoutPins.keys()) {
      protectedLayouts.add(layoutKey);
    }
    const candidates = [];
    const seen = new Set();
    const addCandidate = layoutKey => {
      if (protectedLayouts.has(layoutKey) || seen.has(layoutKey)) return;
      seen.add(layoutKey);
      candidates.push(layoutKey);
    };
    for (const layoutKey of this.normalizedPositionCache.keys()) {
      addCandidate(layoutKey);
    }
    for (const layoutKey of this.positionCache.keys()) {
      addCandidate(layoutKey);
    }
    return candidates;
  }

  /**
   * Release least-recently-used caches that no view shows and no caller
   * pinned, then enforce the retained-plus-decoded peak before any
   * coordinate iteration. Normalization runs in place, so the decoded array
   * is the only new allocation.
   *
   * @param {string} layoutKey
   * @param {Float32Array} rawPositions
   * @private
   */
  _preparePositionWorkspace(layoutKey, rawPositions) {
    const plannedBytes = () => (
      this._getRetainedPositionBytes([rawPositions])
    );
    let workingBytes = plannedBytes();
    const underPressure = heapUnderPressure();
    if (underPressure) this._residencyListener?.onPressure?.();
    for (const candidate of this._evictableLayouts(new Set([layoutKey]))) {
      if (!underPressure && workingBytes <= this._maxPositionBytes) break;
      this._evictLayout(candidate);
      workingBytes = plannedBytes();
    }

    // The budget never refuses: what the views show, what callers pinned
    // and the layout just decoded are always admitted (a real allocation
    // failure is a RangeError at the decode, handled there).
  }

  /**
   * Keep a layout's positions resident until the returned release runs,
   * whether or not a view shows it. Releasing twice is a no-op.
   *
   * @param {string} layoutKey
   * @returns {() => void} release
   */
  pinLayout(layoutKey) {
    const key = this.getLayout(layoutKey).layoutKey;
    const generation = this._generation;
    this._layoutPins.set(key, (this._layoutPins.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // A cleared manager already dropped every pin of its generation.
      if (generation !== this._generation) return;
      const count = this._layoutPins.get(key) ?? 0;
      if (count <= 1) {
        this._layoutPins.delete(key);
      } else {
        this._layoutPins.set(key, count - 1);
      }
    };
  }

  /**
   * Release the cached positions of every layout no view shows and no caller
   * pinned.
   *
   * @returns {string[]} The layouts whose positions were released.
   */
  evictUnpinned() {
    const evicted = this._evictableLayouts();
    for (const layoutKey of evicted) {
      this._evictLayout(layoutKey);
    }
    return evicted;
  }

  /**
   * Install the listener told when cached positions are evicted
   * (`onEvict(positions)`, the released array) and when memory runs short
   * (`onPressure()`), or remove it with null.
   *
   * @param {{onEvict?: (positions: Float32Array) => void, onPressure?: () => void}|null} listener
   */
  setResidencyListener(listener) {
    if (listener !== null && (typeof listener !== 'object' || Array.isArray(listener))) {
      throw new TypeError('A residency listener must be an object or null.');
    }
    this._residencyListener = listener;
  }

  /**
   * Release everything not shown or pinned, CPU and (through the listener)
   * GPU: the response to memory pressure, and to a page left hidden.
   *
   * @returns {string[]} The layouts whose positions were released.
   */
  releaseUnderPressure() {
    this._residencyListener?.onPressure?.();
    return this.evictUnpinned();
  }

  /** @private */
  _evictLayout(layoutKey) {
    const positions = this.normalizedPositionCache.get(layoutKey) ?? null;
    this.normalizedPositionCache.delete(layoutKey);
    this.positionCache.delete(layoutKey);
    this.loadedTransformCache.delete(layoutKey);
    if (positions !== null) this._residencyListener?.onEvict?.(positions);
  }

  /**
   * Get the layout a view shows.
   * @param {string} viewId - View identifier
   * @returns {string} Layout key
   */
  getViewLayout(viewId) {
    requireViewId(viewId);
    if (!this.viewLayouts.has(viewId)) {
      throw new RangeError(
        `Layout state is not published for view "${viewId}".`
      );
    }
    const layoutKey = this.viewLayouts.get(viewId);
    if (!this._layouts.has(layoutKey)) {
      throw new Error(
        `Published layout state for view "${viewId}" is invalid.`
      );
    }
    return layoutKey;
  }

  /**
   * Get the dimension of the layout a view shows.
   * @param {string} viewId - View identifier
   * @returns {number}
   */
  getViewDimension(viewId) {
    return this._layouts.get(this.getViewLayout(viewId)).dimension;
  }

  /**
   * Publish the layout a view shows.
   * @param {string} viewId - View identifier
   * @param {string} layoutKey - Registered layout
   */
  setViewLayout(viewId, layoutKey) {
    requireViewId(viewId);
    const key = this.getLayout(layoutKey).layoutKey;
    this.viewLayouts.set(viewId, key);
  }

  /**
   * Copy the layout from one view to another (for "Keep View" feature)
   * @param {string} sourceViewId - Source view ID
   * @param {string} targetViewId - Target view ID
   */
  copyViewLayout(sourceViewId, targetViewId) {
    this.setViewLayout(targetViewId, this.getViewLayout(sourceViewId));
  }

  /**
   * Remove layout state for a view
   * @param {string} viewId - View identifier
   */
  removeView(viewId) {
    requireViewId(viewId);
    this.viewLayouts.delete(viewId);
  }

  /**
   * Get number of cells
   * @returns {number}
   */
  getCellCount() {
    return this.nCells;
  }

  /**
   * The normalized positions of a layout that are resident now, or `null`.
   *
   * These are the coordinates the viewer draws. The read is synchronous and
   * never loads, so a caller that needs a layout which is not resident awaits
   * `getPositions` instead.
   *
   * @param {string} layoutKey
   * @returns {Float32Array|null} Normalized positions (n_cells * dim)
   */
  getResidentPositions(layoutKey) {
    const key = this.getLayout(layoutKey).layoutKey;
    return this.normalizedPositionCache.get(key) ?? null;
  }

  /**
   * Get the normalization transform used for a layout's positions.
   * Centroids, vectors and figure axes apply the same transform.
   * @param {string} layoutKey
   * @returns {Object|null} Transform object { center: [x,y,z], scale: number } or null if not loaded
   */
  getNormTransform(layoutKey) {
    return this.normTransformCache.get(this.getLayout(layoutKey).layoutKey) || null;
  }

  /**
   * Check if any layout is currently loading
   * @returns {boolean}
   */
  isLoading() {
    return (
      this.loadingPromises.size > 0 ||
      this.normalizedLoadingPromises.size > 0
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
    this.loadedTransformCache.clear();
    this.normalizedPositionCache.clear();
    this.normalizedLoadingPromises.clear();
    this.normTransformCache.clear();
    this.loadingPromises.clear();
    this.loadingControllers.clear();
    this._layoutPins.clear();
    this.nCells = 0;
    this._cellAxisPublished = false;
  }

  /**
   * Reject work that belongs to a cleared/replaced dataset.
   *
   * @param {number} generation
   * @param {string|null} [layoutKey=null]
   * @param {Promise<Float32Array>|null} [promise=null]
   * @private
   */
  _assertGeneration(generation, layoutKey = null, promise = null) {
    const promiseIsCurrent = (
      layoutKey == null ||
      promise == null ||
      this.loadingPromises.get(layoutKey) === promise
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
