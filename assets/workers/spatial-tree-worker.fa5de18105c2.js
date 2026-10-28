// assets/js/utils/format-units.js
var BYTE_UNITS = Object.freeze(["B", "KB", "MB", "GB", "TB", "PB"]);
var GROUPED_INTEGER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});
function formatCount(value) {
  requireCount(value);
  return GROUPED_INTEGER.format(value);
}
function requireCount(value) {
  if (typeof value === "bigint") return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Count must be a finite number");
  }
}
function formatCountOf(value, singular, plural = `${singular}s`) {
  return `${formatCount(value)} ${countNoun(value, singular, plural)}`;
}
function countNoun(value, singular, plural = `${singular}s`) {
  if (typeof singular !== "string" || singular.length === 0) {
    throw new TypeError("A counted noun must be non-empty text");
  }
  requireCount(value);
  return Number(value) === 1 ? singular : plural;
}

// assets/js/rendering/high-perf/spatial-tree.js
function createIndexArray(count) {
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;
  return indices;
}
function calculateBounds(tree) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const positions = tree.positions;
  const count = tree.pointCount;
  const stride = tree.dimensionLevel;
  for (let i = 0; i < count; i++) {
    const x = positions[i * stride];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  if (stride >= 2) {
    for (let i = 0; i < count; i++) {
      const y = positions[i * stride + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  } else {
    minY = 0;
    maxY = 0;
  }
  if (stride >= 3) {
    for (let i = 0; i < count; i++) {
      const z = positions[i * stride + 2];
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  } else {
    minZ = 0;
    maxZ = 0;
  }
  const extentX = maxX - minX;
  const extentY = maxY - minY;
  const extentZ = maxZ - minZ;
  const maxExtent = Math.max(extentX, extentY, extentZ, 1e-3);
  const basePad = maxExtent * 1e-3;
  const flatThreshold = maxExtent * 0.01;
  const flatPad = maxExtent * 0.5;
  const padX = extentX < flatThreshold ? flatPad : basePad;
  const padY = extentY < flatThreshold ? flatPad : basePad;
  const padZ = extentZ < flatThreshold ? flatPad : basePad;
  return {
    minX: minX - padX,
    minY: minY - padY,
    minZ: minZ - padZ,
    maxX: maxX + padX,
    maxY: maxY + padY,
    maxZ: maxZ + padZ
  };
}
function buildNode(tree, indices, bounds, depth) {
  const node = {
    bounds,
    indices: null,
    children: null,
    pointCount: indices.length
  };
  if (indices.length <= tree.maxPointsPerNode || depth >= tree.maxDepth) {
    node.indices = indices;
    return node;
  }
  const midX = (bounds.minX + bounds.maxX) * 0.5;
  const midY = (bounds.minY + bounds.maxY) * 0.5;
  const midZ = (bounds.minZ + bounds.maxZ) * 0.5;
  const dimLevel = tree.dimensionLevel;
  const numChildren = tree.childCount;
  const childBounds = [];
  for (let c = 0; c < numChildren; c++) {
    const xSplit = (c & 1) !== 0;
    const ySplit = dimLevel >= 2 ? (c & 2) !== 0 : false;
    const zSplit = dimLevel >= 3 ? (c & 4) !== 0 : false;
    childBounds.push({
      minX: xSplit ? midX : bounds.minX,
      maxX: xSplit ? bounds.maxX : midX,
      // Y bounds: split into halves if dimLevel >= 2, otherwise inherit full range
      minY: ySplit ? midY : bounds.minY,
      maxY: dimLevel >= 2 ? ySplit ? bounds.maxY : midY : bounds.maxY,
      // Z bounds: split into halves if dimLevel >= 3, otherwise inherit full range
      minZ: zSplit ? midZ : bounds.minZ,
      maxZ: dimLevel >= 3 ? zSplit ? bounds.maxZ : midZ : bounds.maxZ
    });
  }
  const positions = tree.positions;
  const n = indices.length;
  const childCounts = new Uint32Array(numChildren);
  let occupiedChildCount = 0;
  let onlyOccupiedChild = -1;
  for (let i = 0; i < n; i++) {
    const idx = indices[i];
    const base = idx * dimLevel;
    let childIdx = positions[base] >= midX | 0;
    if (dimLevel >= 2) childIdx += (positions[base + 1] >= midY | 0) << 1;
    if (dimLevel >= 3) childIdx += (positions[base + 2] >= midZ | 0) << 2;
    if (childCounts[childIdx] === 0) {
      occupiedChildCount++;
      onlyOccupiedChild = childIdx;
    }
    childCounts[childIdx]++;
  }
  if (occupiedChildCount === 1) {
    node.children = new Array(numChildren).fill(null);
    node.children[onlyOccupiedChild] = buildNode(
      tree,
      indices,
      childBounds[onlyOccupiedChild],
      depth + 1
    );
    return node;
  }
  const childIndices = childBounds.map(
    (_, i) => childCounts[i] > 0 ? new Uint32Array(childCounts[i]) : null
  );
  const childOffsets = new Uint32Array(numChildren);
  for (let i = 0; i < n; i++) {
    const idx = indices[i];
    const base = idx * dimLevel;
    let childIdx = positions[base] >= midX | 0;
    if (dimLevel >= 2) {
      childIdx += (positions[base + 1] >= midY | 0) << 1;
    }
    if (dimLevel >= 3) {
      childIdx += (positions[base + 2] >= midZ | 0) << 2;
    }
    childIndices[childIdx][childOffsets[childIdx]++] = idx;
  }
  node.children = childBounds.map(
    (cb, i) => childIndices[i] !== null ? buildNode(tree, childIndices[i], cb, depth + 1) : null
  );
  return node;
}
function buildSpatialTree(positions, dimensionLevel, maxPointsPerNode, maxDepth) {
  const tree = {
    positions,
    dimensionLevel,
    pointCount: positions.length / dimensionLevel,
    childCount: 1 << dimensionLevel,
    maxPointsPerNode,
    maxDepth
  };
  const bounds = calculateBounds(tree);
  const root = buildNode(tree, createIndexArray(tree.pointCount), bounds, 0);
  return { bounds, root };
}
function encodeSpatialTree(tree, dimensionLevel) {
  const childCount = 1 << dimensionLevel;
  const nodes = [];
  const stack = [tree.root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null) continue;
    nodes.push(node);
    if (node.children) for (const child of node.children) stack.push(child);
  }
  const count = nodes.length;
  const ids = /* @__PURE__ */ new Map();
  for (let id = 0; id < count; id++) ids.set(nodes[id], id);
  const bounds = new Float64Array(count * 6);
  const pointCounts = new Float64Array(count);
  const leafRanges = new Float64Array(count * 2).fill(-1);
  const drawUnits = new Int8Array(count).fill(-1);
  const hasChildren = new Uint8Array(count);
  const children = new Int32Array(count * childCount).fill(-1);
  const indexStarts = new Float64Array(count).fill(-1);
  let packed = null;
  for (let id = 0; id < count; id++) {
    const node = nodes[id];
    const b = node.bounds;
    bounds.set([b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ], id * 6);
    pointCounts[id] = node.pointCount;
    if (node.leafStart !== void 0) {
      leafRanges[id * 2] = node.leafStart;
      leafRanges[id * 2 + 1] = node.leafEnd;
    }
    if (node.drawUnit !== void 0) drawUnits[id] = node.drawUnit ? 1 : 0;
    if (node.children) {
      hasChildren[id] = 1;
      for (let slot = 0; slot < node.children.length; slot++) {
        const child = node.children[slot];
        if (child !== null) children[id * childCount + slot] = ids.get(child);
      }
    }
    if (node.indices) {
      if (packed === null) packed = node.indices.buffer;
      if (node.indices.buffer !== packed) {
        throw new Error("A spatial tree to encode must keep every leaf's ids in one buffer.");
      }
      indexStarts[id] = node.indices.byteOffset / 4;
    }
  }
  const indices = packed === null ? new Uint32Array(0) : new Uint32Array(packed);
  const encoded = {
    nodeCount: count,
    childCount,
    bounds,
    pointCounts,
    leafRanges,
    drawUnits,
    hasChildren,
    children,
    indexStarts,
    indices
  };
  const transfer = [bounds, pointCounts, leafRanges, drawUnits, hasChildren, children, indexStarts, indices].map((array) => array.buffer);
  return { encoded, transfer };
}

// assets/js/formats/io/link.js
var READ_AHEAD_BYTES_PER_MS = 64 * 1e3;

// assets/js/formats/zip/crc32.js
var TABLES = (() => {
  const tables = new Uint32Array(16 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    tables[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = tables[n];
    for (let t = 1; t < 16; t++) {
      c = tables[c & 255] ^ c >>> 8;
      tables[t * 256 + n] = c >>> 0;
    }
  }
  return tables;
})();
var LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

// assets/js/formats/io/page-checks.js
var CHECK_PAGE_BYTES = 16 * 1024;

// assets/js/formats/io/byte-source.js
var BYTE_SOURCE_FAILURES = Object.freeze({
  NETWORK: "network",
  STALLED: "stalled",
  RANGE_IGNORED: "range-ignored",
  RATE_LIMITED: "rate-limited",
  UNAVAILABLE: "unavailable",
  HTTP: "http",
  SHORT_READ: "short-read",
  CHANGED: "changed",
  UNREADABLE: "unreadable",
  SIZE_UNKNOWN: "size-unknown",
  /** A copy kept in this browser whose bytes do not match their checksums (`page-checks.js`). */
  DAMAGED: "damaged"
});
var KiB = 1024;
var MiB = 1024 * KiB;
var REMOTE_POLICY = Object.freeze({
  blockBytes: 16 * KiB,
  mergeGapBytes: 64 * KiB,
  maxRequestBytes: 8 * MiB,
  concurrency: 6,
  streams: 100,
  cacheBytes: 64 * MiB,
  // Nothing is assumed of a web host: it is read ahead only once measured.
  bytesPerMs: 0
});
var LOCAL_POLICY = Object.freeze({
  blockBytes: 64 * KiB,
  mergeGapBytes: 4 * KiB,
  maxRequestBytes: 32 * MiB,
  concurrency: 4,
  cacheBytes: 32 * MiB,
  // A disk (1 GB/s), read ahead from the start.
  bytesPerMs: 1e6
});
var HEAD_BYTES = 512 * KiB;
var RETRY_DELAYS_MS = Object.freeze([250, 500, 1e3, 2e3, 4e3, 8e3]);
var TRANSIENT_FAILURES = /* @__PURE__ */ new Set([
  BYTE_SOURCE_FAILURES.NETWORK,
  BYTE_SOURCE_FAILURES.STALLED,
  BYTE_SOURCE_FAILURES.RATE_LIMITED,
  BYTE_SOURCE_FAILURES.UNAVAILABLE
]);

// assets/js/data/memory-budget.js
var GIB = 1024 ** 3;
var DEVICE_MEMORY_TOP_BUCKET_GIB = 8;
var HEAP_TO_PHYSICAL_RATIO = 4;
var UNREPORTED_DEVICE_BYTES = DEVICE_MEMORY_TOP_BUCKET_GIB * GIB;
var ALLOWANCE_OF_DEVICE = 1 / 2;
var RESIDENCY_SHARES = Object.freeze({
  /** A gene-column index held in memory before it spills to disk (8 bytes per stored entry). */
  columnIndex: 3 / 8,
  /** Decoded embedding positions of layouts no view shows. */
  positions: 1 / 8,
  /** Loaded but unused field arrays kept for fast re-selection. */
  inactiveFields: 1 / 8,
  /** Genes an analysis run buffers by default (marker discovery, differential expression). */
  analysis: 1 / 8,
  /** The AnnData adapter's normalized coordinates and obs field payloads. */
  adapterCache: 1 / 16,
  /** A latent space the reader worker holds for outlier quantiles. */
  latentHold: 1 / 16,
  /**
   * Decoded chunks of the open store, every cache of them together (`formats/io/decoded-budget.js`):
   * the store's own (dense strips shared by their genes, chunks read in part) and the whole chunks a
   * subsample is read through (`anndata/decoded-chunks.js`).
   */
  decodedBlocks: 1 / 32,
  /** Bytes of remote files the page keeps for its reader workers, whichever worker fetched them (`byte-range-cache.js`). */
  fetchedRanges: 1 / 32,
  /** Decode workers while they decompress chunks (`formats/io/decode-pool.js`). */
  decodeWorkers: 1 / 32,
  /** Earlier selection steps a highlight tool can undo to (every tool together). */
  undoHistory: 1 / 32
});
var allowanceScale = 1;
function estimatedDeviceMemory(environment = globalThis) {
  const deviceMemory = environment?.navigator?.deviceMemory;
  const reported = typeof deviceMemory === "number" && Number.isFinite(deviceMemory) && deviceMemory > 0 ? Math.floor(deviceMemory * GIB) : null;
  const heapLimit = environment?.performance?.memory?.jsHeapSizeLimit;
  const fromHeap = typeof heapLimit === "number" && Number.isFinite(heapLimit) && heapLimit > 0 ? Math.floor(heapLimit * HEAP_TO_PHYSICAL_RATIO) : null;
  if (reported !== null && (reported < DEVICE_MEMORY_TOP_BUCKET_GIB * GIB || fromHeap === null || fromHeap <= reported)) {
    return { bytes: reported, source: "deviceMemory" };
  }
  if (fromHeap !== null) return { bytes: fromHeap, source: "jsHeapSizeLimit" };
  return { bytes: UNREPORTED_DEVICE_BYTES, source: "unreported" };
}
function memoryAllowanceBytes(environment = globalThis) {
  return Math.floor(estimatedDeviceMemory(environment).bytes * ALLOWANCE_OF_DEVICE * allowanceScale);
}
function recordAllocationFailure(bytes, environment = globalThis) {
  if (!(bytes > 0) || bytes >= memoryAllowanceBytes(environment)) return false;
  allowanceScale /= 2;
  return true;
}

// assets/js/utils/large-arrays.js
var MEMORY_PAGE_BYTES = 65536;
var MEMORY_MAX_BYTES = 2 ** 32;
var ARRAY_PIECE_BYTES = 2 ** 24 * 3 * 4;
var TYPED_ARRAYS = Object.freeze({
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array
});
var memoryBuffers = /* @__PURE__ */ new WeakSet();
function allocateInMemory(ArrayType, length) {
  const bytes = length * ArrayType.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`A typed array holds a non-negative whole number of elements, not ${length}.`);
  }
  if (bytes > MEMORY_MAX_BYTES) {
    throw new RangeError(
      `${formatCountOf(bytes, "byte")} is more than one WebAssembly memory holds (${formatCountOf(MEMORY_MAX_BYTES, "byte")}), the largest array a browser page can allocate.`
    );
  }
  const pages = Math.ceil(bytes / MEMORY_PAGE_BYTES);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
  memoryBuffers.add(memory.buffer);
  return new ArrayType(memory.buffer, 0, length);
}
function allocateLargeArray(ArrayType, length) {
  try {
    return new ArrayType(length);
  } catch (refused) {
    if (!(refused instanceof RangeError) || typeof WebAssembly?.Memory !== "function" || !(length * ArrayType.BYTES_PER_ELEMENT <= MEMORY_MAX_BYTES)) throw refused;
    try {
      return allocateInMemory(ArrayType, length);
    } catch {
      throw refused;
    }
  }
}
var ArrayAssembly = class {
  /**
   * @param {new (length: number) => ArrayBufferView} ArrayType
   * @param {number} length
   */
  constructor(ArrayType, length) {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`An assembled array holds a non-negative whole number of elements, not ${length}.`);
    }
    this.ArrayType = ArrayType;
    this.length = length;
    this.array = null;
    this.filled = 0;
  }
  /**
   * Copy one piece in.
   *
   * @param {number} offset - Its first element in the whole array
   * @param {ArrayBufferView} values
   */
  put(offset, values) {
    if (!(values instanceof this.ArrayType)) {
      throw new TypeError(`A piece of a ${this.ArrayType.name} is one too, not ${values?.constructor?.name}.`);
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + values.length > this.length) {
      throw new RangeError(`A piece at ${offset} of ${formatCountOf(values.length, "element")} lies outside an array of ${formatCountOf(this.length, "element")}.`);
    }
    if (this.array === null && offset === 0 && values.length === this.length) {
      this.array = values;
    } else {
      this.array ??= allocateLargeArray(this.ArrayType, this.length);
      this.array.set(values, offset);
    }
    this.filled += values.length;
  }
  /** The whole array, once every element arrived. */
  get result() {
    if (this.filled !== this.length) {
      throw new RangeError(`An array of ${formatCountOf(this.length, "element")} was assembled from ${formatCountOf(this.filled, "element")}.`);
    }
    return this.array ?? new this.ArrayType(0);
  }
};

// assets/js/data/sparse-column-index.js
var SEGMENT_ELEMENTS = 2 ** 27;
function allocateTypedArray(ArrayType, length, label) {
  try {
    return allocateLargeArray(ArrayType, length);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const bytes = length * ArrayType.BYTES_PER_ELEMENT;
    recordAllocationFailure(bytes);
    const failure = new RangeError(
      `${label} needs ${formatCountOf(bytes, "byte")}, more memory than the browser could allocate.`
    );
    failure.code = "TOO_LARGE";
    failure.bytes = bytes;
    throw failure;
  }
}
var PRIOR_COSTS = Object.freeze({
  mergeGapBytes: REMOTE_POLICY.mergeGapBytes,
  roundTripBytes: null,
  concurrency: REMOTE_POLICY.concurrency
});
var WHOLE_VALUES_STEP = 1 << 20;
var DISK_GROUP_BUFFER_ENTRIES = 1 << 18;
var DISK_BUFFER_BUDGET_ENTRIES = 1 << 24;
var KEPT_PIECE_BYTES = 16 * 1024 * 1024;
var KEPT_TYPES = Object.freeze({ f64: Float64Array, u32: Uint32Array, f32: Float32Array });

// assets/js/data/cell-identity.js
function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

// assets/js/data/subsample.js
var SUBSAMPLE_METHODS = Object.freeze(["uniform", "blocks", "stratified", "spatial"]);
var STRATIFIED_ALLOCATIONS = Object.freeze(["proportional", "balanced"]);
var DEFAULT_SUBSAMPLE_SEED = 0;
var MAX_CELLS = 4294967295;
function requireUint32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CELLS) {
    throw new RangeError(`${label} must be an integer in [0, 2^32 - 1]; got ${String(value)}.`);
  }
  return value;
}
function seedKey(seed) {
  return fmix32((requireUint32(seed, "A subsample seed") ^ 2654435769) >>> 0);
}

// assets/js/data/cell-priority.js
var OPEN_ORDER_PRIORITY = Object.freeze({ seed: null, originals: null });
var DEFAULT_CELL_PRIORITY = Object.freeze({ seed: DEFAULT_SUBSAMPLE_SEED, originals: null });
function rankedCellPriority(seed, originals = null) {
  seedKey(seed);
  if (originals !== null && !(originals instanceof Uint32Array)) {
    throw new TypeError("A cell priority names original positions as a Uint32Array.");
  }
  return seed === DEFAULT_SUBSAMPLE_SEED && originals === null ? DEFAULT_CELL_PRIORITY : Object.freeze({ seed, originals });
}
function reviveCellPriority(message) {
  if (message === null || typeof message !== "object") throw new TypeError("A cell priority message must be an object.");
  return message.seed === null && message.originals === null ? OPEN_ORDER_PRIORITY : rankedCellPriority(message.seed, message.originals ?? null);
}
function requireCellPriority(priority, n) {
  if (priority === null || typeof priority !== "object" || !Object.isFrozen(priority)) {
    throw new TypeError("A cell priority must be a frozen descriptor (data/cell-priority.js).");
  }
  if (priority.seed === null) {
    if (priority.originals !== null) throw new TypeError("An open-order cell priority names no original positions.");
    return priority;
  }
  seedKey(priority.seed);
  if (priority.originals !== null) {
    if (!(priority.originals instanceof Uint32Array)) {
      throw new TypeError("A cell priority names original positions as a Uint32Array.");
    }
    if (priority.originals.length !== n) {
      throw new RangeError(`A cell priority names ${formatCountOf(priority.originals.length, "cell")}, not the ${formatCountOf(n, "open cell")}.`);
    }
  }
  return priority;
}
var RADIX_BITS = 16;
var RADIX_SIZE = 1 << RADIX_BITS;
var RADIX_MASK = RADIX_SIZE - 1;
function inverseFmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 2127672349);
  h ^= h >>> 13 ^ h >>> 26;
  h = Math.imul(h, 2781581891);
  h ^= h >>> 16;
  return h >>> 0;
}
function digitOffsets(keys) {
  const low = new Uint32Array(RADIX_SIZE);
  const high = new Uint32Array(RADIX_SIZE);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    low[key & RADIX_MASK]++;
    high[key >>> RADIX_BITS]++;
  }
  let lowAt = 0;
  let highAt = 0;
  for (let digit = 0; digit < RADIX_SIZE; digit++) {
    const lowCount = low[digit];
    low[digit] = lowAt;
    lowAt += lowCount;
    const highCount = high[digit];
    high[digit] = highAt;
    highAt += highCount;
  }
  return { low, high };
}
function buildPriorityOrder(n, priority) {
  requireCellPriority(priority, n);
  if (priority.seed === null) {
    const order = allocateTypedArray(Uint32Array, n, "Cell priority order");
    for (let i = 0; i < n; i++) order[i] = i;
    return order;
  }
  const key = seedKey(priority.seed);
  const originals = priority.originals;
  let keys = allocateTypedArray(Uint32Array, n, "Cell priority ranks");
  if (originals === null) {
    for (let i = 0; i < n; i++) keys[i] = fmix32((i ^ key) >>> 0);
  } else {
    for (let i = 0; i < n; i++) keys[i] = fmix32((originals[i] ^ key) >>> 0);
  }
  const { low, high } = digitOffsets(keys);
  let scratch = allocateTypedArray(Uint32Array, n, "Cell priority ranks");
  if (originals === null) {
    for (let i = 0; i < n; i++) {
      const value = keys[i];
      scratch[low[value & RADIX_MASK]++] = value;
    }
    for (let i = 0; i < n; i++) {
      const value = scratch[i];
      keys[high[value >>> RADIX_BITS]++] = value;
    }
    for (let i = 0; i < n; i++) keys[i] = (inverseFmix32(keys[i]) ^ key) >>> 0;
    scratch = null;
    return keys;
  }
  const ids = allocateTypedArray(Uint32Array, n, "Cell priority order");
  let scratchIds = allocateTypedArray(Uint32Array, n, "Cell priority order");
  for (let i = 0; i < n; i++) {
    const at = low[keys[i] & RADIX_MASK]++;
    scratch[at] = keys[i];
    scratchIds[at] = i;
  }
  keys = null;
  for (let i = 0; i < n; i++) ids[high[scratch[i] >>> RADIX_BITS]++] = scratchIds[i];
  scratch = null;
  scratchIds = null;
  return ids;
}

// assets/js/rendering/high-perf/draw-order.js
var LOD_FULL_DETAIL_ADMISSION_LEVEL = 255;
var DRAW_UNIT_DEPTH_BY_DIMENSION = Object.freeze([0, 6, 3, Infinity]);
function numberDrawUnits(root, dimensionLevel) {
  const unitDepth = DRAW_UNIT_DEPTH_BY_DIMENSION[dimensionLevel];
  const units = [];
  const visit = (node, depth) => {
    node.leafStart = units.length;
    if (node.indices !== null || node.children === null || depth >= unitDepth) {
      if (node.indices !== null && !(node.indices instanceof Uint32Array)) {
        throw new TypeError("Spatial tree leaf membership must be an exact Uint32Array.");
      }
      node.drawUnit = true;
      units.push(node);
    } else if (node.children) {
      node.drawUnit = false;
      for (const child of node.children) {
        if (child) visit(child, depth + 1);
      }
    }
    node.leafEnd = units.length;
  };
  visit(root, 0);
  return units;
}
function leafIdsFollowDrawOrder(dimensionLevel) {
  return DRAW_UNIT_DEPTH_BY_DIMENSION[dimensionLevel] === Infinity;
}
function dropDerivableLeafIds(root, dimensionLevel) {
  if (!leafIdsFollowDrawOrder(dimensionLevel)) return;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null) continue;
    if (node.children === null) {
      if (node.drawUnit !== true) throw new Error("A tree's leaf ids are dropped only after its draw order numbered its leaves.");
      node.indices = null;
    } else {
      for (const child of node.children) stack.push(child);
    }
  }
}
var LOD_LADDER_FIRST_COUNT = 1e3;
var DRAW_BAND_POINTS = 2 ** 21;
function lodLadder(pointCount) {
  if (!Number.isSafeInteger(pointCount) || pointCount < 0) {
    throw new RangeError(`A level-of-detail ladder needs a cell count, not ${pointCount}.`);
  }
  const counts = [];
  for (let count = LOD_LADDER_FIRST_COUNT; count < pointCount; count = Math.floor(count * 5 / 4)) {
    counts.push(count);
  }
  counts.push(pointCount);
  return counts;
}
function drawBands(pointCount, bandPoints = DRAW_BAND_POINTS) {
  if (!Number.isSafeInteger(bandPoints) || bandPoints <= 0) {
    throw new RangeError(`A draw band holds a positive number of cells, not ${bandPoints}.`);
  }
  const ladder = lodLadder(pointCount);
  const ends = [];
  const levelBands = new Uint8Array(ladder.length);
  let previous = 0;
  for (let level = 0; level < ladder.length; level++) {
    const end = ladder[level];
    for (let split = (Math.floor(previous / bandPoints) + 1) * bandPoints; split < end; split += bandPoints) {
      ends.push(split);
    }
    if (end > previous || ends.length === 0) ends.push(end);
    if (ends.length > LOD_FULL_DETAIL_ADMISSION_LEVEL) {
      throw new RangeError(`A draw order of ${formatCountOf(pointCount, "cell")} needs more than ${LOD_FULL_DETAIL_ADMISSION_LEVEL} bands.`);
    }
    levelBands[level] = ends.length - 1;
    previous = end;
  }
  return { bandEnds: Uint32Array.from(ends), levelBands, ladder };
}
function buildDrawOrder(root, dimensionLevel, pointCount, bands, priorityOrder) {
  const n = pointCount;
  const leaves = numberDrawUnits(root, dimensionLevel);
  const leafCount = leaves.length;
  const bandEnds = bands === null ? Uint32Array.of(n) : bands.bandEnds;
  const bandCount = bandEnds.length;
  if (bandCount > LOD_FULL_DETAIL_ADMISSION_LEVEL) {
    throw new RangeError(`Draw order supports at most ${LOD_FULL_DETAIL_ADMISSION_LEVEL} bands.`);
  }
  let previousEnd = 0;
  for (let band = 0; band < bandCount; band++) {
    const end = bandEnds[band];
    if (end < previousEnd || end > n || end === previousEnd && band > 0) {
      throw new RangeError(`Draw order: band ${band} is not one monotonic run of ranks.`);
    }
    previousEnd = end;
  }
  if (previousEnd !== n) {
    throw new RangeError("Draw order: bands must end with every point.");
  }
  let bandOf = null;
  if (bands !== null && bandCount > 1) {
    bandOf = new Uint8Array(n);
    if (priorityOrder === null) {
      let rank = 0;
      for (let band = 0; band < bandCount; band++) {
        bandOf.fill(band, rank, bandEnds[band]);
        rank = bandEnds[band];
      }
    } else {
      if (!(priorityOrder instanceof Uint32Array) || priorityOrder.length !== n) {
        throw new Error("Draw order requires one exact priority order of every point.");
      }
      let rank = 0;
      for (let band = 0; band < bandCount; band++) {
        const end = bandEnds[band];
        for (; rank < end; rank++) bandOf[priorityOrder[rank]] = band;
      }
    }
  }
  const unitOf = new Uint32Array(n);
  let placed = 0;
  const assign = (node, unit) => {
    if (node.children === null && node.indices === null && node.pointCount > 0) {
      throw new Error("Draw order: the tree's leaf ids follow its published draw order (`dropDerivableLeafIds`); a new order needs a new tree.");
    }
    if (node.indices !== null) {
      const leafIndices = node.indices;
      for (let i = 0; i < leafIndices.length; i++) {
        const id = leafIndices[i];
        if (id >= n) {
          throw new RangeError(`Draw order: leaf contains source ID ${id} outside ${formatCountOf(n, "point")}.`);
        }
        unitOf[id] = unit;
      }
      placed += leafIndices.length;
      return;
    }
    if (node.children) {
      for (const child of node.children) {
        if (child) assign(child, unit);
      }
    }
  };
  for (let unit = 0; unit < leafCount; unit++) assign(leaves[unit], unit);
  if (placed !== n) {
    throw new Error(`Draw order: leaves own ${placed} source IDs but the dataset contains ${n}.`);
  }
  const stride = leafCount + 1;
  const leafOffsets = new Uint32Array(bandCount * stride);
  for (let id = 0; id < n; id++) {
    const band = bandOf === null ? 0 : bandOf[id];
    leafOffsets[band * stride + unitOf[id] + 1]++;
  }
  for (let band = 0; band < bandCount; band++) {
    const base = band * stride;
    let running = band === 0 ? 0 : bandEnds[band - 1];
    leafOffsets[base] = running;
    for (let unit = 1; unit <= leafCount; unit++) {
      running += leafOffsets[base + unit];
      leafOffsets[base + unit] = running;
    }
    if (running !== bandEnds[band]) {
      throw new Error(`Draw order: units place ${formatCountOf(running, "point")} in band ${band}, not ${bandEnds[band]}.`);
    }
  }
  const indices = priorityOrder ?? new Uint32Array(n);
  const cursors = leafOffsets.slice();
  for (let id = 0; id < n; id++) {
    const band = bandOf === null ? 0 : bandOf[id];
    indices[cursors[band * stride + unitOf[id]]++] = id;
  }
  return {
    indices,
    bandCount,
    bandEnds,
    levelBands: bands === null ? null : bands.levelBands,
    leafCount,
    leafOffsets,
    pointCount: n
  };
}
function computeTreeDrawOrder(pointCount, tree, dimensionLevel, buildLOD, priority) {
  const inPriorityOrder = priority.seed === null;
  if (!buildLOD && !inPriorityOrder) return { ...buildDrawOrder(tree.root, dimensionLevel, pointCount, null, null), ranked: false };
  const order = buildDrawOrder(
    tree.root,
    dimensionLevel,
    pointCount,
    drawBands(pointCount),
    inPriorityOrder ? null : buildPriorityOrder(pointCount, priority)
  );
  return { ...order, ranked: inPriorityOrder };
}
function drawOrderTransferList(order) {
  const list = [order.indices.buffer, order.bandEnds.buffer, order.leafOffsets.buffer];
  if (order.levelBands !== null) list.push(order.levelBands.buffer);
  return list;
}

// assets/js/rendering/high-perf/spatial-tree-job.js
function buildSpatialTreeJob(request, { releasePositions = false } = {}) {
  const { dimensionLevel, maxPointsPerNode, maxDepth, buildLOD, priority = DEFAULT_CELL_PRIORITY } = request;
  const pointCount = request.positions.length / dimensionLevel;
  const tree = buildSpatialTree(request.positions, dimensionLevel, maxPointsPerNode, maxDepth);
  if (releasePositions) request.positions = null;
  const derivable = leafIdsFollowDrawOrder(dimensionLevel);
  if (!derivable) packLeafIndices(tree, pointCount);
  const order = computeTreeDrawOrder(pointCount, tree, dimensionLevel, buildLOD === true, reviveCellPriority(priority));
  if (derivable) dropDerivableLeafIds(tree.root, dimensionLevel);
  return { tree, order };
}
function packLeafIndices(tree, pointCount) {
  const packed = new Uint32Array(pointCount);
  let offset = 0;
  const stack = [tree.root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null) continue;
    if (node.indices) {
      packed.set(node.indices, offset);
      node.indices = packed.subarray(offset, offset + node.indices.length);
      offset += node.indices.length;
    }
    if (node.children) for (const child of node.children) stack.push(child);
  }
}
function encodeSpatialTreeJobResult(result, dimensionLevel) {
  const { encoded, transfer } = encodeSpatialTree(result.tree, dimensionLevel);
  return {
    reply: { tree: encoded, order: result.order },
    transfer: [...transfer, ...drawOrderTransferList(result.order)]
  };
}

// assets/js/rendering/high-perf/spatial-tree-worker.js
var pendingPositions = /* @__PURE__ */ new Map();
self.onmessage = ({ data }) => {
  const { id } = data;
  try {
    if (data.kind === "positions") {
      let positions = pendingPositions.get(id);
      if (positions === void 0) {
        positions = new ArrayAssembly(Float32Array, data.total);
        pendingPositions.set(id, positions);
      }
      if (data.slice.length > 0) positions.put(data.offset, data.slice);
      return;
    }
    const assembly = pendingPositions.get(id);
    pendingPositions.delete(id);
    if (assembly === void 0) throw new Error("build request arrived without its positions");
    const request = { ...data, positions: assembly.result };
    delete request.kind;
    const { reply, transfer } = encodeSpatialTreeJobResult(
      buildSpatialTreeJob(request, { releasePositions: true }),
      request.dimensionLevel
    );
    self.postMessage({ id, ...reply }, transfer);
  } catch (error) {
    pendingPositions.delete(id);
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
//# sourceMappingURL=spatial-tree-worker.fa5de18105c2.js.map
