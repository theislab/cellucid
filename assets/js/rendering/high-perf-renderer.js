/**
 * HIGH-PERFORMANCE SCATTERPLOT RENDERER (WebGL2 Only)
 * ====================================================
 * Optimized for 20-30+ million points using:
 *
 * 1. WebGL2 with VAOs and GLSL ES 3.0
 * 2. Interleaved vertex buffers (better GPU cache coherency)
 * 3. Level-of-Detail (LOD) with octree spatial indexing
 * 4. Frustum culling - only render visible points
 * 5. GPU-only fog (no CPU distance calculations)
 * 6. Lightweight shader variants
 */

import {
  HP_VS_FULL, HP_FS_FULL,
  HP_VS_LIGHT, HP_FS_LIGHT, HP_FS_ULTRALIGHT
} from './shaders/high-perf-shaders.js';
import { getNotificationCenter } from '../app/notification-center.js';
import { configureStraightAlphaBlending } from './gl-utils.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Dimension threshold for disabling depth testing.
 * For 2D data (dimensionLevel <= this value), depth testing is disabled
 * to prevent draw-order artifacts when all points have the same Z.
 */
const DEPTH_TEST_DIMENSION_THRESHOLD = 2;

/**
 * Debug flag for LOD and frustum culling logs.
 * Set to true to enable verbose console output during rendering.
 * This should be false in production to avoid performance impact.
 */
let DEBUG_LOD_FRUSTUM = false;

const SUPPORTED_DIMENSION_LEVELS = new Set([1, 2, 3]);
const SUPPORTED_SHADER_QUALITIES = new Set(['full', 'light', 'ultralight']);

const HIERARCHICAL_RADIX_BITS = 10;
const HIERARCHICAL_RADIX_SIZE = 1 << HIERARCHICAL_RADIX_BITS;
const HIERARCHICAL_RADIX_MASK = HIERARCHICAL_RADIX_SIZE - 1;
const LOD_MAPPING_SENTINEL = 0xffffffff;
const LOD_MAPPING_VISITED_BIT = 0x80000000;
const LOD_FULL_DETAIL_ADMISSION_LEVEL = 0xff;
const VISIBLE_INDEX_GROWTH_FACTOR = 1.5;
const VISIBLE_INDEX_SHRINK_RATIO = 4;
const VISIBLE_INDEX_MIN_RECLAIM = 256 * 1024;
const EMPTY_LOD_PROJECTION = Object.freeze([]);
const REQUIRED_RENDER_SCALAR_KEYS = Object.freeze([
  'pointSize',
  'sizeAttenuation',
  'viewportHeight',
  'viewportWidth',
  'fov',
  'lightingStrength',
  'fogDensity',
  'cameraDistance',
]);
const REQUIRED_RENDER_VECTOR_CONTRACTS = Object.freeze([
  Object.freeze(['mvpMatrix', 16]),
  Object.freeze(['viewMatrix', 16]),
  Object.freeze(['modelMatrix', 16]),
  Object.freeze(['projectionMatrix', 16]),
  Object.freeze(['fogColor', 3]),
  Object.freeze(['lightDir', 3]),
  Object.freeze(['cameraPosition', 3]),
]);
// Renderer-created LOD projections receive a private readiness certificate
// only after the complete deep CPU/GPU ownership validation succeeds. The
// WeakMap cannot be forged by caller-provided fixtures and lets the render hot
// path prove an unchanged accepted generation with constant-time identity
// checks. Direct/external ensure calls retain the full structural validation.
const LOD_RESOURCE_READINESS_CERTIFICATES = new WeakMap();
const READ_ONLY_LOD_PROJECTIONS = new WeakMap();
const READ_ONLY_SPATIAL_PROJECTIONS = new WeakMap();
const READ_ONLY_SPATIAL_METHODS = new WeakMap();
const READ_ONLY_MUTATOR_METHODS = new Set([
  'add',
  'clear',
  'copyWithin',
  'delete',
  'ensureLODLevels',
  'ensureLodNodeMappings',
  'fill',
  'pop',
  'push',
  'reverse',
  'set',
  'shift',
  'sort',
  'splice',
  'unshift',
]);
const SPATIAL_PRIMITIVE_VISITOR_METHODS = new Set([
  'visitProjectedRectCandidates',
  'visitRadiusCandidates',
  'visitRaySegmentCandidates',
]);

/**
 * Lazily expose a CPU spatial generation without handing callers its accepted
 * mutable graph. Typed arrays are copied only when actually observed; query
 * methods still execute against the exact renderer owner and recursively
 * project every callback/result.
 */
function getReadOnlySpatialProjection(value, owner = 'SpatialIndex') {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    let copy = READ_ONLY_SPATIAL_PROJECTIONS.get(value);
    if (copy === undefined) {
      copy = value instanceof DataView
        ? new DataView(value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength
        ))
        : new value.constructor(value);
      READ_ONLY_SPATIAL_PROJECTIONS.set(value, copy);
    }
    return copy;
  }
  if (value instanceof ArrayBuffer) {
    let copy = READ_ONLY_SPATIAL_PROJECTIONS.get(value);
    if (copy === undefined) {
      copy = value.slice(0);
      READ_ONLY_SPATIAL_PROJECTIONS.set(value, copy);
    }
    return copy;
  }
  const cached = READ_ONLY_SPATIAL_PROJECTIONS.get(value);
  if (cached !== undefined) return cached;
  if (!Reflect.isExtensible(value)) {
    const rawPrototype = Reflect.getPrototypeOf(value);
    const projectedPrototype = rawPrototype === null
      ? null
      : getReadOnlySpatialProjection(
          rawPrototype,
          `${owner} prototype`
        );
    const copy = Array.isArray(value)
      ? []
      : Object.create(projectedPrototype);
    if (Array.isArray(value)) {
      Reflect.setPrototypeOf(copy, projectedPrototype);
    }
    READ_ONLY_SPATIAL_PROJECTIONS.set(value, copy);
    for (const property of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && property === 'length') continue;
      const descriptor =
        Reflect.getOwnPropertyDescriptor(value, property);
      Object.defineProperty(copy, property, {
        configurable: false,
        enumerable: descriptor?.enumerable ?? false,
        writable: false,
        value: getReadOnlySpatialProjection(
          Reflect.get(value, property, value),
          `${owner}.${String(property)}`
        ),
      });
    }
    return Object.freeze(copy);
  }

  const projection = new Proxy(value, {
    get(target, property, receiver) {
      const nested = Reflect.get(target, property, receiver);
      if (typeof nested !== 'function') {
        return getReadOnlySpatialProjection(
          nested,
          `${owner}.${String(property)}`
        );
      }
      let methods = READ_ONLY_SPATIAL_METHODS.get(target);
      if (methods === undefined) {
        methods = new Map();
        READ_ONLY_SPATIAL_METHODS.set(target, methods);
      }
      let method = methods.get(property);
      if (method !== undefined) return method;
      method = function readOnlySpatialMethod(...args) {
        if (
          READ_ONLY_MUTATOR_METHODS.has(property) ||
          (
            typeof property === 'string' &&
            property.startsWith('_')
          )
        ) {
          throw new TypeError(
            `${owner}.${String(property)} is unavailable on a read-only spatial projection.`
          );
        }
        const exactArgs = args.map((arg, index) => {
          if (typeof arg !== 'function') return arg;
          if (SPATIAL_PRIMITIVE_VISITOR_METHODS.has(property)) {
            return function projectedSpatialIndexVisitor(cellIndex) {
              return arg(cellIndex);
            };
          }
          return function projectedSpatialCallback(...callbackArgs) {
            return Reflect.apply(
              arg,
              this,
              callbackArgs.map((callbackArg, callbackIndex) =>
                getReadOnlySpatialProjection(
                  callbackArg,
                  `${owner}.${String(property)} callback argument ${callbackIndex}`
                )
              )
            );
          };
        });
        return getReadOnlySpatialProjection(
          Reflect.apply(nested, target, exactArgs),
          `${owner}.${String(property)} result`
        );
      };
      methods.set(property, method);
      return method;
    },
    set() {
      throw new TypeError(`${owner} is read-only.`);
    },
    defineProperty() {
      throw new TypeError(`${owner} is read-only.`);
    },
    deleteProperty() {
      throw new TypeError(`${owner} is read-only.`);
    },
    setPrototypeOf() {
      throw new TypeError(`${owner} prototype is read-only.`);
    },
    getPrototypeOf(target) {
      const prototype = Reflect.getPrototypeOf(target);
      return prototype === null
        ? null
        : getReadOnlySpatialProjection(
            prototype,
            `${owner} prototype`
          );
    },
    preventExtensions() {
      throw new TypeError(`${owner} cannot be made non-extensible.`);
    },
    getOwnPropertyDescriptor(target, property) {
      const descriptor =
        Reflect.getOwnPropertyDescriptor(target, property);
      if (
        descriptor === undefined ||
        descriptor.configurable === false ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return descriptor;
      }
      return {
        ...descriptor,
        value: getReadOnlySpatialProjection(
          descriptor.value,
          `${owner}.${String(property)}`
        ),
      };
    },
  });
  READ_ONLY_SPATIAL_PROJECTIONS.set(value, projection);
  return projection;
}

function getReadOnlyLodProjection(lodBuffers) {
  if (lodBuffers.length === 0) return EMPTY_LOD_PROJECTION;
  let projection = READ_ONLY_LOD_PROJECTIONS.get(lodBuffers);
  if (projection !== undefined) return projection;
  projection = Object.freeze(
    lodBuffers.map(metadata => Object.freeze({ ...metadata }))
  );
  READ_ONLY_LOD_PROJECTIONS.set(lodBuffers, projection);
  return projection;
}

function createReversedMortonContribution(dimensionLevel, axis) {
  const contributions = new Uint32Array(HIERARCHICAL_RADIX_SIZE);
  const priorityBits = dimensionLevel * HIERARCHICAL_RADIX_BITS;
  for (
    let coordinate = 0;
    coordinate < HIERARCHICAL_RADIX_SIZE;
    coordinate++
  ) {
    let contribution = 0;
    for (let bit = 0; bit < HIERARCHICAL_RADIX_BITS; bit++) {
      const mortonBit = bit * dimensionLevel + axis;
      const priorityBit = priorityBits - mortonBit - 1;
      contribution |=
        ((coordinate >>> bit) & 1) << priorityBit;
    }
    contributions[coordinate] = contribution >>> 0;
  }
  return contributions;
}

// Reversing an interleaved Morton code is a fixed 10-bit coordinate
// transformation. These small, module-owned tables remove all per-point bit
// loops while retaining the exact historical 1D/2D/3D priorities.
const HIERARCHICAL_PRIORITY_CONTRIBUTIONS = Object.freeze([
  null,
  Object.freeze([
    createReversedMortonContribution(1, 0),
  ]),
  Object.freeze([
    createReversedMortonContribution(2, 0),
    createReversedMortonContribution(2, 1),
  ]),
  Object.freeze([
    createReversedMortonContribution(3, 0),
    createReversedMortonContribution(3, 1),
    createReversedMortonContribution(3, 2),
  ]),
]);

function requireDimensionLevel(value, owner = 'Renderer dimensionLevel') {
  if (!Number.isInteger(value) || !SUPPORTED_DIMENSION_LEVELS.has(value)) {
    throw new RangeError(
      `${owner} is required and must be exactly 1, 2, or 3; received ${String(value)}.`
    );
  }
  return value;
}

function requireViewId(value, owner = 'Renderer viewId') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${owner} must be a non-empty string.`);
  }
  return value;
}

function requireShaderQuality(value, owner = 'Renderer quality') {
  if (!SUPPORTED_SHADER_QUALITIES.has(value)) {
    throw new RangeError(
      `${owner} must be exactly "full", "light", or "ultralight"; received ${String(value)}.`
    );
  }
  return value;
}

function requireFiniteNumber(value, owner) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${owner} must be a finite number; received ${String(value)}.`);
  }
  return value;
}

function requireNumericVector(value, length, owner) {
  if (
    (!Array.isArray(value) && !ArrayBuffer.isView(value)) ||
    value.length !== length
  ) {
    throw new TypeError(`${owner} must contain exactly ${length} numeric values.`);
  }
  for (let i = 0; i < length; i++) {
    if (!Number.isFinite(value[i])) {
      throw new TypeError(
        `${owner}[${i}] must be a finite number; received ${String(value[i])}.`
      );
    }
  }
  return value;
}

function describeError(error) {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function settleCalculationNotification(
  notifications,
  notificationId,
  method,
  ...args
) {
  try {
    if (!notifications.hasNotification(notificationId)) return false;
    notifications[method](notificationId, ...args);
    return true;
  } catch {
    // Calculation notifications are observational. Eviction, dismissal, or a
    // terminal UI delivery failure cannot invalidate completed scientific or
    // GPU publication ownership.
    return false;
  }
}

function requireCleanWebGLState(gl, owner) {
  const errorCode = gl.getError();
  if (errorCode !== gl.NO_ERROR) {
    throw new Error(
      `${owner} encountered WebGL error 0x${errorCode.toString(16)}.`
    );
  }
}

function restorePointDrawBaseline(gl, detachElementBuffer) {
  let failures = null;
  if (detachElementBuffer) {
    try {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    } catch (error) {
      failures = [error];
    }
  }
  try {
    gl.bindVertexArray(null);
  } catch (error) {
    if (failures === null) failures = [error];
    else failures.push(error);
  }
  try {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
  } catch (error) {
    if (failures === null) failures = [error];
    else failures.push(error);
  }
  try {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  } catch (error) {
    if (failures === null) failures = [error];
    else failures.push(error);
  }
  if (failures !== null) {
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(
      failures,
      'HighPerfRenderer point-draw baseline restoration failed.'
    );
  }
}

function settlePointDraw(operationError, restorationError, owner) {
  if (operationError !== null) {
    if (restorationError !== null) {
      const restorationFailures =
        restorationError instanceof AggregateError
          ? restorationError.errors
          : null;
      throw new AggregateError(
        restorationFailures === null
          ? [operationError, restorationError]
          : [operationError, ...restorationFailures],
        `${owner} and baseline restoration both failed.`
      );
    }
    throw operationError;
  }
  if (restorationError !== null) throw restorationError;
}

function getRenderContractOwner(snapshotId) {
  return snapshotId === null
    ? 'HighPerfRenderer render'
    : `HighPerfRenderer snapshot "${snapshotId}"`;
}

function hasExactFiniteVector(value, length) {
  if (
    (!Array.isArray(value) && !ArrayBuffer.isView(value)) ||
    value.length !== length
  ) {
    return false;
  }
  for (let index = 0; index < length; index++) {
    if (!Number.isFinite(value[index])) return false;
  }
  return true;
}

function requireRenderContract(params, snapshotId = null) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError(
      `${getRenderContractOwner(snapshotId)} parameters must be an object.`
    );
  }
  for (
    let index = 0;
    index < REQUIRED_RENDER_VECTOR_CONTRACTS.length;
    index++
  ) {
    const contract = REQUIRED_RENDER_VECTOR_CONTRACTS[index];
    if (!hasExactFiniteVector(params[contract[0]], contract[1])) {
      requireNumericVector(
        params[contract[0]],
        contract[1],
        `${getRenderContractOwner(snapshotId)} ${contract[0]}`
      );
    }
  }
  for (const key of REQUIRED_RENDER_SCALAR_KEYS) {
    const value = params[key];
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `${getRenderContractOwner(snapshotId)} ${key} must be a finite number; received ${String(value)}.`
      );
    }
  }
  if (!Number.isInteger(params.forceLOD) || params.forceLOD < -1) {
    throw new RangeError(
      `${getRenderContractOwner(snapshotId)} forceLOD must be an integer greater than or equal to -1.`
    );
  }
  if (typeof params.autoFog !== 'boolean') {
    throw new TypeError(
      `${getRenderContractOwner(snapshotId)} autoFog must be a boolean.`
    );
  }
  if (typeof params.useAlphaTexture !== 'boolean') {
    throw new TypeError(
      `${getRenderContractOwner(snapshotId)} useAlphaTexture must be a boolean.`
    );
  }
  if (!SUPPORTED_SHADER_QUALITIES.has(params.quality)) {
    requireShaderQuality(
      params.quality,
      `${getRenderContractOwner(snapshotId)} quality`
    );
  }
  if (typeof params.viewId !== 'string' || params.viewId.length === 0) {
    requireViewId(
      params.viewId,
      `${getRenderContractOwner(snapshotId)} viewId`
    );
  }
  if (!SUPPORTED_DIMENSION_LEVELS.has(params.dimensionLevel)) {
    requireDimensionLevel(
      params.dimensionLevel,
      `${getRenderContractOwner(snapshotId)} dimensionLevel`
    );
  }
  return params;
}

function requireSnapshotPointData(
  pointCount,
  positions,
  colors,
  alphas,
  owner
) {
  if (
    !(positions instanceof Float32Array) ||
    positions.length !== pointCount * 3
  ) {
    throw new TypeError(
      `${owner} positions must be a Float32Array with exactly ${pointCount * 3} values.`
    );
  }
  if (!(colors instanceof Uint8Array) || colors.length !== pointCount * 4) {
    throw new TypeError(
      `${owner} colors must be an RGBA Uint8Array with exactly ${pointCount * 4} bytes.`
    );
  }
  if (alphas !== null) {
    if (
      !(alphas instanceof Float32Array) ||
      alphas.length !== pointCount
    ) {
      throw new TypeError(
        `${owner} alpha values must be null or a Float32Array with exactly ${pointCount} entries.`
      );
    }
  }

  return {
    alphas,
    colors,
    positions,
  };
}

function requireSnapshotColors(pointCount, colors, owner) {
  if (
    !(colors instanceof Uint8Array) ||
    colors.length !== pointCount * 4
  ) {
    throw new TypeError(
      `${owner} colors must be an RGBA Uint8Array with exactly ${pointCount * 4} bytes.`
    );
  }
  return colors;
}

function requireSnapshotAlphas(pointCount, alphas, owner) {
  if (
    !(alphas instanceof Float32Array) ||
    alphas.length !== pointCount
  ) {
    throw new TypeError(
      `${owner} alpha values must be a Float32Array with exactly ${pointCount} entries.`
    );
  }
  return alphas;
}

// ============================================================================
// SPATIAL INDEX FOR LOD AND FRUSTUM CULLING (1D/2D/3D)
// ============================================================================

/**
 * Unified spatial index that adapts to data dimensionality:
 * - 1D: Binary tree (2 children) - for 1D layouts/histograms
 * - 2D: Quadtree (4 children) - for 2D projections (UMAP, t-SNE)
 * - 3D: Octree (8 children) - for 3D embeddings (PCA, etc.)
 *
 * Enables frustum culling and spatially-uniform LOD sampling in the
 * appropriate dimension space.
 */
export class SpatialIndex {
  /**
   * @param {Float32Array} positions - Position data (x,y,z per point)
   * @param {Uint8Array} colors - RGBA color data
   * @param {number} dimensionLevel - 1, 2, or 3 for tree type
   * @param {number} maxPointsPerNode - Max points before subdivision
   * @param {number} maxDepth - Maximum tree depth
   * @param {Object} options
   * @param {boolean} options.buildLOD - Whether to generate LOD levels.
   * @param {boolean} options.buildLodNodeMappings - Whether to precompute per-node LOD index mappings for fast LOD+frustum culling.
   * @param {boolean} options.computeNodeStats - Whether to compute node centroid/avgColor/avgAlpha.
   */
  constructor(positions, colors, dimensionLevel, maxPointsPerNode, maxDepth, options) {
    if (
      !(positions instanceof Float32Array) ||
      positions.length === 0 ||
      positions.length % 3 !== 0
    ) {
      throw new TypeError(
        'SpatialIndex positions must be a non-empty Float32Array with exactly three values per point.'
      );
    }
    const pointCount = positions.length / 3;
    if (!Number.isInteger(maxPointsPerNode) || maxPointsPerNode <= 0) {
      throw new TypeError('SpatialIndex maxPointsPerNode must be a positive integer.');
    }
    if (!Number.isInteger(maxDepth) || maxDepth <= 0) {
      throw new TypeError('SpatialIndex maxDepth must be a positive integer.');
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('SpatialIndex options must be an object.');
    }
    const { buildLOD, buildLodNodeMappings, computeNodeStats } = options;
    if (
      typeof buildLOD !== 'boolean' ||
      typeof buildLodNodeMappings !== 'boolean' ||
      typeof computeNodeStats !== 'boolean'
    ) {
      throw new TypeError(
        'SpatialIndex buildLOD, buildLodNodeMappings, and computeNodeStats options must be booleans.'
      );
    }
    if (
      colors !== null &&
      (
        !(colors instanceof Uint8Array) ||
        colors.length !== pointCount * 4
      )
    ) {
      throw new TypeError(
        `SpatialIndex colors must be null or an RGBA Uint8Array with exactly ${pointCount * 4} bytes.`
      );
    }
    if (colors === null && computeNodeStats) {
      throw new TypeError(
        'SpatialIndex colors are required when computeNodeStats is enabled.'
      );
    }

    this._buildLOD = buildLOD;
    this._computeNodeStats = computeNodeStats;
    this._lodNodeMappingsBuilt = false;
    this._lodNodeMapping = null;
    this._buildLodNodeMappings = buildLodNodeMappings;
    // Built lazily only when a CPU consumer needs random-access LOD
    // membership (highlights, connectivity, or export). All reduced LODs are
    // nested prefixes of `_hierarchicalOrder`, so one byte per source point is
    // sufficient for every level and every view sharing this spatial owner.
    this._lodMembershipOwner = null;

    this.maxPointsPerNode = maxPointsPerNode;
    this.maxDepth = maxDepth;
    this.positions = positions;
    this.colors = colors;
    this.dimensionLevel = requireDimensionLevel(
      dimensionLevel,
      'SpatialIndex dimensionLevel'
    );
    this.childCount = 1 << this.dimensionLevel; // 2, 4, or 8

    this.pointCount = pointCount;

    const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
    const treeName = treeNames[this.dimensionLevel];

    // Calculate bounds
    this.bounds = this._calculateBounds();

    // Build tree
    console.time(`${treeName} build`);
    this.root = this._buildNode(
      this._createIndexArray(this.pointCount),
      this.bounds,
      0
    );
    console.timeEnd(`${treeName} build`);

    // LOD is optional (many consumers just need the tree for queries/picking).
    if (this._buildLOD) {
      // Generate LOD levels
      console.time('LOD generation');
      this.lodLevels = this._generateLODLevels();
      console.timeEnd('LOD generation');

      if (this._buildLodNodeMappings) {
        // Pre-compute LOD indices per node for fast frustum culling
        this._buildLODNodeMappings();
        this._lodNodeMappingsBuilt = true;
      }
    } else {
      this.lodLevels = [];
    }
  }

  ensureLODLevels() {
    if (this.lodLevels && this.lodLevels.length > 0) return;

    const notifications = getNotificationCenter();
    const notifId = notifications.startCalculation(
      `Generating LOD levels for ${this.pointCount.toLocaleString()} cells`,
      'calculation'
    );
    const startTime = performance.now();

    try {
      console.time('LOD generation');
      this.lodLevels = this._generateLODLevels();
      console.timeEnd('LOD generation');
      this._buildLOD = true;
    } catch (error) {
      console.timeEnd('LOD generation');
      settleCalculationNotification(
        notifications,
        notifId,
        'failCalculation',
        `LOD generation failed: ${describeError(error)}`
      );
      throw error;
    }

    const elapsed = performance.now() - startTime;
    settleCalculationNotification(
      notifications,
      notifId,
      'completeCalculation',
      `LOD ready (${this.lodLevels.length} levels)`,
      elapsed
    );
  }

  ensureLodNodeMappings() {
    if (this._lodNodeMappingsBuilt) return;
    this.ensureLODLevels();

    const notifications = getNotificationCenter();
    const notifId = notifications.startCalculation('Building LOD node mappings', 'calculation');
    const startTime = performance.now();

    try {
      this._buildLODNodeMappings();
      this._lodNodeMappingsBuilt = true;
    } catch (error) {
      settleCalculationNotification(
        notifications,
        notifId,
        'failCalculation',
        `LOD node mappings failed: ${describeError(error)}`
      );
      throw error;
    }

    const elapsed = performance.now() - startTime;
    settleCalculationNotification(
      notifications,
      notifId,
      'completeCalculation',
      'LOD node mappings ready',
      elapsed
    );
  }

  _createIndexArray(count) {
    const indices = new Uint32Array(count);
    for (let i = 0; i < count; i++) indices[i] = i;
    return indices;
  }

  _calculateBounds() {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    const positions = this.positions;
    const count = this.pointCount;

    const CHUNK_SIZE = 10000;
    for (let start = 0; start < count; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE, count);
      for (let i = start; i < end; i++) {
        const idx = i * 3;
        const x = positions[idx];
        const y = positions[idx + 1];
        const z = positions[idx + 2];

        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }

    // Calculate extents
    const extentX = maxX - minX;
    const extentY = maxY - minY;
    const extentZ = maxZ - minZ;

    // Use dynamic padding based on max extent - ensures flat dimensions get meaningful padding
    // This is critical for 1D/2D data where one or more dimensions are essentially zero
    const maxExtent = Math.max(extentX, extentY, extentZ, 0.001);
    const basePad = maxExtent * 0.001; // 0.1% of largest extent

    // For flat dimensions (extent < 1% of max), use LARGE padding (50% of max extent)
    // This ensures frustum culling doesn't clip quadtree nodes at different Z depths
    // causing grid artifacts in 2D views. The large Z padding ensures all nodes
    // span the full camera near-to-far range.
    const flatThreshold = maxExtent * 0.01;
    const flatPad = maxExtent * 0.5; // 50% padding for flat dimensions

    const padX = extentX < flatThreshold ? flatPad : basePad;
    const padY = extentY < flatThreshold ? flatPad : basePad;
    const padZ = extentZ < flatThreshold ? flatPad : basePad;

    return {
      minX: minX - padX, minY: minY - padY, minZ: minZ - padZ,
      maxX: maxX + padX, maxY: maxY + padY, maxZ: maxZ + padZ
    };
  }

  _buildNode(indices, bounds, depth) {
    const node = {
      bounds,
      indices: null,
      children: null,
      centroid: null,
      avgColor: null,
      avgAlpha: 0,
      pointCount: indices.length
    };

    if (indices.length <= this.maxPointsPerNode || depth >= this.maxDepth) {
      node.indices = indices;
      if (this._computeNodeStats) {
        node.centroid = this._computeCentroid(indices);
        node.avgColor = this._computeAvgColor(indices);
        node.avgAlpha = this._computeAvgAlpha(indices);
      }
      return node;
    }

    const midX = (bounds.minX + bounds.maxX) * 0.5;
    const midY = (bounds.minY + bounds.maxY) * 0.5;
    const midZ = (bounds.minZ + bounds.maxZ) * 0.5;

    const dimLevel = this.dimensionLevel;
    const numChildren = this.childCount; // 2, 4, or 8

    // Generate child bounds based on dimension level
    // 1D: 2 children (left/right on X)
    // 2D: 4 children (quadtree on XY)
    // 3D: 8 children (octree on XYZ)
    const childBounds = [];
    for (let c = 0; c < numChildren; c++) {
      const xSplit = (c & 1) !== 0;
      const ySplit = dimLevel >= 2 ? ((c & 2) !== 0) : false;
      const zSplit = dimLevel >= 3 ? ((c & 4) !== 0) : false;

      // For dimensions being split: divide at mid point (upper/lower halves)
      // For dimensions NOT being split: children inherit FULL parent range
      // This is critical for correct frustum culling in lower dimensions
      //
      // When splitting a dimension (e.g., Y in 2D mode):
      //   - split=true means upper half: [mid, max]
      //   - split=false means lower half: [min, mid]
      // When NOT splitting a dimension (e.g., Y in 1D mode):
      //   - full range: [min, max]
      childBounds.push({
        minX: xSplit ? midX : bounds.minX,
        maxX: xSplit ? bounds.maxX : midX,
        // Y bounds: split into halves if dimLevel >= 2, otherwise inherit full range
        minY: ySplit ? midY : bounds.minY,
        maxY: (dimLevel >= 2) ? (ySplit ? bounds.maxY : midY) : bounds.maxY,
        // Z bounds: split into halves if dimLevel >= 3, otherwise inherit full range
        minZ: zSplit ? midZ : bounds.minZ,
        maxZ: (dimLevel >= 3) ? (zSplit ? bounds.maxZ : midZ) : bounds.maxZ
      });
    }

    const positions = this.positions;
    const n = indices.length;

    // Count first, then recompute the child during distribution. Retaining one
    // byte per point at every recursive level creates a large transient-memory
    // multiplier, especially for degenerate inputs.
    const childCounts = new Uint32Array(numChildren);
    let occupiedChildCount = 0;
    let onlyOccupiedChild = -1;

    for (let i = 0; i < n; i++) {
      const idx = indices[i];
      const base = idx * 3;
      const x = positions[base];
      const y = positions[base + 1];
      const z = positions[base + 2];

      // Compute child index based on dimension level (branchless for perf)
      let childIdx = (x >= midX) | 0;
      if (dimLevel >= 2) childIdx += ((y >= midY) | 0) << 1;
      if (dimLevel >= 3) childIdx += ((z >= midZ) | 0) << 2;

      if (childCounts[childIdx] === 0) {
        occupiedChildCount++;
        onlyOccupiedChild = childIdx;
      }
      childCounts[childIdx]++;
    }

    // A unary partition must preserve the exact index owner. Allocating and
    // copying N indices at every depth turns identical-coordinate datasets
    // into O(N * maxDepth) allocation/copy work for no semantic benefit.
    if (occupiedChildCount === 1) {
      node.children = new Array(numChildren).fill(null);
      node.children[onlyOccupiedChild] = this._buildNode(
        indices,
        childBounds[onlyOccupiedChild],
        depth + 1
      );

      if (this._computeNodeStats) {
        node.centroid = this._computeCentroidFromChildren(node);
        node.avgColor = this._computeAvgColorFromChildren(node);
        node.avgAlpha = this._computeAvgAlphaFromChildren(node);
      }
      return node;
    }

    // Pre-allocate child arrays based on counts
    const childIndices = childBounds.map((_, i) =>
      childCounts[i] > 0 ? new Uint32Array(childCounts[i]) : null
    );
    const childOffsets = new Uint32Array(numChildren);

    // Second pass: recompute the child and distribute into exact-size owners.
    // The additional sequential position reads are cheaper than allocating,
    // filling, and collecting an N-byte routing owner per internal node.
    for (let i = 0; i < n; i++) {
      const idx = indices[i];
      const base = idx * 3;
      let childIdx = (positions[base] >= midX) | 0;
      if (dimLevel >= 2) {
        childIdx += ((positions[base + 1] >= midY) | 0) << 1;
      }
      if (dimLevel >= 3) {
        childIdx += ((positions[base + 2] >= midZ) | 0) << 2;
      }
      childIndices[childIdx][childOffsets[childIdx]++] = idx;
    }

    node.children = childBounds.map((cb, i) =>
      childIndices[i] !== null
        ? this._buildNode(childIndices[i], cb, depth + 1)
        : null
    );

    if (this._computeNodeStats) {
      node.centroid = this._computeCentroidFromChildren(node);
      node.avgColor = this._computeAvgColorFromChildren(node);
      node.avgAlpha = this._computeAvgAlphaFromChildren(node);
    }

    return node;
  }

  _computeCentroid(indices) {
    let sx = 0, sy = 0, sz = 0;
    const positions = this.positions;
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i] * 3;
      sx += positions[idx];
      sy += positions[idx + 1];
      sz += positions[idx + 2];
    }
    const n = indices.length;
    return [sx / n, sy / n, sz / n];
  }

  _computeAvgColor(indices) {
    let sr = 0, sg = 0, sb = 0;
    const colors = this.colors;
    const stride = colors.length === this.pointCount * 4 ? 4 : 3;
    const scale = colors.BYTES_PER_ELEMENT === 1 ? (1 / 255) : 1;
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i] * stride;
      sr += colors[idx] * scale;
      sg += colors[idx + 1] * scale;
      sb += colors[idx + 2] * scale;
    }
    const n = indices.length;
    return [sr / n, sg / n, sb / n];
  }

  _computeAvgAlpha(indices) {
    if (!indices.length) return 1.0;
    let sum = 0;
    const colors = this.colors;
    for (let i = 0; i < indices.length; i++) {
      sum += colors[indices[i] * 4 + 3];
    }
    return sum / (indices.length * 255);
  }

  _computeCentroidFromChildren(node) {
    let sx = 0, sy = 0, sz = 0, totalCount = 0;
    for (const child of node.children) {
      if (child && child.centroid) {
        sx += child.centroid[0] * child.pointCount;
        sy += child.centroid[1] * child.pointCount;
        sz += child.centroid[2] * child.pointCount;
        totalCount += child.pointCount;
      }
    }
    return totalCount > 0 ? [sx / totalCount, sy / totalCount, sz / totalCount] : [0, 0, 0];
  }

  _computeAvgColorFromChildren(node) {
    let sr = 0, sg = 0, sb = 0, totalCount = 0;
    for (const child of node.children) {
      if (child && child.avgColor) {
        sr += child.avgColor[0] * child.pointCount;
        sg += child.avgColor[1] * child.pointCount;
        sb += child.avgColor[2] * child.pointCount;
        totalCount += child.pointCount;
      }
    }
    return totalCount > 0 ? [sr / totalCount, sg / totalCount, sb / totalCount] : [0.5, 0.5, 0.5];
  }

  _computeAvgAlphaFromChildren(node) {
    let sum = 0, totalCount = 0;
    for (const child of node.children) {
      if (child) {
        sum += child.avgAlpha * child.pointCount;
        totalCount += child.pointCount;
      }
    }
    return totalCount > 0 ? sum / totalCount : 1.0;
  }

  _generateLODLevels() {
    const levels = [];
    const totalPoints = this.pointCount;

    // Smooth LOD with 1.25x steps for imperceptible transitions (18 levels)
    // Each step increases points by 25%, below human perception threshold
    const reductionFactors = [44, 35, 28, 23, 18, 14.5, 11.5, 9.3, 7.5, 6, 4.8, 3.8, 3, 2.4, 1.95, 1.55, 1.25, 1];

    for (let levelIdx = 0; levelIdx < reductionFactors.length; levelIdx++) {
      const factor = reductionFactors[levelIdx];
      const targetCount = Math.max(1000, Math.ceil(totalPoints / factor));

      if (factor === 1) {
        levels.push({
          depth: levelIdx,
          pointCount: totalPoints,
          positions: this.positions,
          colors: this.colors, // RGBA uint8 with alpha packed
          sizes: null,
          isFullDetail: true
        });
        continue;
      }

      const sampledIndices = this._stratifiedSample(targetCount);
      const pointCount = sampledIndices.length;

      levels.push({
        depth: levelIdx,
        pointCount,
        indices: sampledIndices, // Exact original IDs for source-data lookup
        sizes: null,
        isFullDetail: false,
        sizeMultiplier: Math.sqrt(factor) * 0.2 + 0.8
      });
    }

    const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
    const treeName = treeNames[this.dimensionLevel] || 'Octree';
    console.log(`[${treeName}] Generated ${levels.length} LOD levels (dim=${this.dimensionLevel}):`,
      levels.map(l => `${l.pointCount.toLocaleString()} pts`).join(', '));

    return levels;
  }

  /**
   * Build a stable hierarchical ordering of all points.
   * Points are ranked so that coarser LOD levels are always strict subsets of finer levels.
   * This prevents "popping" when transitioning between LOD levels.
   *
   * Uses Morton code (Z-order curve) + bit-reversal for optimal spatial distribution:
   * - Morton code groups spatially close points together
   * - Bit-reversal ensures coarse samples are evenly distributed across space
   *
   * Dimension-aware: Uses 1D/2D/3D Morton codes based on dimensionLevel.
   */
  _buildHierarchicalOrder() {
    if (this._hierarchicalOrder) return this._hierarchicalOrder;

    const n = this.pointCount;
    const positions = this.positions;
    const bounds = this.bounds;
    const dimLevel = this.dimensionLevel;

    // Normalize positions to 0-1023 range for 10-bit Morton codes
    const scaleX = 1023 / Math.max(bounds.maxX - bounds.minX, 0.0001);
    const scaleY = 1023 / Math.max(bounds.maxY - bounds.minY, 0.0001);
    const scaleZ = 1023 / Math.max(bounds.maxZ - bounds.minZ, 0.0001);

    // One priority array plus two ID arrays bounds peak working memory to
    // 12 bytes per point. Initial ascending IDs preserve the stable reference
    // tie order through every least-significant-digit radix pass.
    let priorities = new Uint32Array(n);
    let sourceIds = new Uint32Array(n);
    let targetIds = new Uint32Array(n);
    let radixOffsets = new Uint32Array(HIERARCHICAL_RADIX_SIZE);
    const contributions =
      HIERARCHICAL_PRIORITY_CONTRIBUTIONS[dimLevel];

    if (dimLevel === 1) {
      const xContributions = contributions[0];
      for (let pointIndex = 0; pointIndex < n; pointIndex++) {
        const positionOffset = pointIndex * 3;
        const x =
          Math.floor(
            (positions[positionOffset] - bounds.minX) * scaleX
          ) & HIERARCHICAL_RADIX_MASK;
        priorities[pointIndex] = xContributions[x];
        sourceIds[pointIndex] = pointIndex;
      }
    } else if (dimLevel === 2) {
      const xContributions = contributions[0];
      const yContributions = contributions[1];
      for (let pointIndex = 0; pointIndex < n; pointIndex++) {
        const positionOffset = pointIndex * 3;
        const x =
          Math.floor(
            (positions[positionOffset] - bounds.minX) * scaleX
          ) & HIERARCHICAL_RADIX_MASK;
        const y =
          Math.floor(
            (positions[positionOffset + 1] - bounds.minY) * scaleY
          ) & HIERARCHICAL_RADIX_MASK;
        priorities[pointIndex] =
          xContributions[x] | yContributions[y];
        sourceIds[pointIndex] = pointIndex;
      }
    } else {
      const xContributions = contributions[0];
      const yContributions = contributions[1];
      const zContributions = contributions[2];
      for (let pointIndex = 0; pointIndex < n; pointIndex++) {
        const positionOffset = pointIndex * 3;
        const x =
          Math.floor(
            (positions[positionOffset] - bounds.minX) * scaleX
          ) & HIERARCHICAL_RADIX_MASK;
        const y =
          Math.floor(
            (positions[positionOffset + 1] - bounds.minY) * scaleY
          ) & HIERARCHICAL_RADIX_MASK;
        const z =
          Math.floor(
            (positions[positionOffset + 2] - bounds.minZ) * scaleZ
          ) & HIERARCHICAL_RADIX_MASK;
        priorities[pointIndex] =
          xContributions[x] |
          yContributions[y] |
          zContributions[z];
        sourceIds[pointIndex] = pointIndex;
      }
    }

    // Priority widths are exactly 10, 20, or 30 bits, so one stable 10-bit
    // pass per active dimension completely orders the IDs.
    for (
      let shift = 0;
      shift < dimLevel * HIERARCHICAL_RADIX_BITS;
      shift += HIERARCHICAL_RADIX_BITS
    ) {
      radixOffsets.fill(0);
      for (let index = 0; index < n; index++) {
        const pointId = sourceIds[index];
        const digit =
          (priorities[pointId] >>> shift) & HIERARCHICAL_RADIX_MASK;
        radixOffsets[digit]++;
      }

      let offset = 0;
      for (
        let digit = 0;
        digit < HIERARCHICAL_RADIX_SIZE;
        digit++
      ) {
        const count = radixOffsets[digit];
        radixOffsets[digit] = offset;
        offset += count;
      }

      for (let index = 0; index < n; index++) {
        const pointId = sourceIds[index];
        const digit =
          (priorities[pointId] >>> shift) & HIERARCHICAL_RADIX_MASK;
        targetIds[radixOffsets[digit]++] = pointId;
      }

      const previousSource = sourceIds;
      sourceIds = targetIds;
      targetIds = previousSource;
    }

    // Only the final ID generation escapes. Explicitly release all build
    // scratch references before atomically publishing the shared LOD owner.
    const hierarchicalOrder = sourceIds;
    priorities = null;
    sourceIds = null;
    targetIds = null;
    radixOffsets = null;
    this._hierarchicalOrder = hierarchicalOrder;
    return this._hierarchicalOrder;
  }

  _stratifiedSample(targetCount) {
    // Use hierarchical ordering for stable, subset-based sampling
    const order = this._buildHierarchicalOrder();

    // Return a stable prefix view into the single typed hierarchical order.
    // Each LOD keeps its own Uint32Array view identity without another backing
    // allocation.
    const count = Math.min(targetCount, order.length);
    return order.subarray(0, count);
  }

  /**
   * Build one exact, shared admission-level owner for every reduced LOD.
   *
   * `admissionLevels[originalId]` is the first reduced LOD level that admits
   * the source point. `0xff` means the point appears only at terminal full
   * detail. Because the LOD index arrays are nested views into one hierarchy,
   * this replaces every per-view Float32 membership mask with one immutable
   * byte owner per spatial generation.
   *
   * Publication is transactional: allocation and complete prefix validation
   * finish off-state before `_lodMembershipOwner` changes.
   *
   * @private
   * @returns {Object}
   */
  _ensureLodMembershipOwner() {
    if (this._lodMembershipOwner !== null) {
      return this._lodMembershipOwner;
    }
    if (
      !Array.isArray(this.lodLevels) ||
      this.lodLevels.length < 1
    ) {
      throw new Error(
        'SpatialIndex LOD membership requires a published LOD inventory.'
      );
    }

    const terminalLevel = this.lodLevels.length - 1;
    if (terminalLevel >= LOD_FULL_DETAIL_ADMISSION_LEVEL) {
      throw new RangeError(
        'SpatialIndex LOD membership exceeds the Uint8 admission-level contract.'
      );
    }
    const fullDetail = this.lodLevels[terminalLevel];
    if (
      fullDetail?.isFullDetail !== true ||
      fullDetail.pointCount !== this.pointCount
    ) {
      throw new Error(
        'SpatialIndex LOD membership requires one exact terminal full-detail level.'
      );
    }

    const hierarchy = this._buildHierarchicalOrder();
    if (
      !(hierarchy instanceof Uint32Array) ||
      hierarchy.length !== this.pointCount
    ) {
      throw new Error(
        'SpatialIndex LOD membership requires one exact full point hierarchy.'
      );
    }

    const admissionLevels = new Uint8Array(this.pointCount);
    admissionLevels.fill(LOD_FULL_DETAIL_ADMISSION_LEVEL);
    const generationToken = Object.freeze({});
    const descriptorsByLevel = new Array(this.lodLevels.length);
    let previousCount = 0;

    for (let lodLevel = 0; lodLevel < terminalLevel; lodLevel++) {
      const level = this.lodLevels[lodLevel];
      const indices = level?.indices;
      if (
        level?.isFullDetail !== false ||
        !(indices instanceof Uint32Array) ||
        !Number.isSafeInteger(level.pointCount) ||
        level.pointCount !== indices.length ||
        level.pointCount < previousCount ||
        level.pointCount > this.pointCount
      ) {
        throw new Error(
          `SpatialIndex LOD ${lodLevel} is not one exact monotonic reduced prefix.`
        );
      }
      if (
        indices.buffer !== hierarchy.buffer ||
        indices.byteOffset !== hierarchy.byteOffset
      ) {
        throw new Error(
          `SpatialIndex LOD ${lodLevel} does not share the exact hierarchical prefix owner.`
        );
      }

      for (
        let compactRank = previousCount;
        compactRank < level.pointCount;
        compactRank++
      ) {
        const originalId = hierarchy[compactRank];
        if (originalId >= this.pointCount) {
          throw new RangeError(
            `SpatialIndex LOD ${lodLevel} contains source ID ${originalId} outside ${this.pointCount} points.`
          );
        }
        if (
          admissionLevels[originalId] !==
          LOD_FULL_DETAIL_ADMISSION_LEVEL
        ) {
          throw new Error(
            `SpatialIndex LOD hierarchy repeats source ID ${originalId}.`
          );
        }
        admissionLevels[originalId] = lodLevel;
      }

      descriptorsByLevel[lodLevel] = Object.freeze({
        admissionLevels,
        dimensionLevel: this.dimensionLevel,
        generationToken,
        indices,
        lodLevel,
        pointCount: this.pointCount,
      });
      previousCount = level.pointCount;
    }

    // Reduced descriptors only expose hierarchy prefixes, but the backing
    // hierarchy must still be one exact full-point permutation. Validate the
    // terminal tail without retaining another point-count allocation: use the
    // unpublished admission candidate as a temporary visited table, then
    // restore terminal-only points to the canonical 0xff sentinel.
    for (
      let compactRank = previousCount;
      compactRank < this.pointCount;
      compactRank++
    ) {
      const originalId = hierarchy[compactRank];
      if (originalId >= this.pointCount) {
        throw new RangeError(
          `SpatialIndex LOD hierarchy tail contains source ID ${originalId} outside ${this.pointCount} points.`
        );
      }
      if (
        admissionLevels[originalId] !==
        LOD_FULL_DETAIL_ADMISSION_LEVEL
      ) {
        throw new Error(
          `SpatialIndex LOD hierarchy repeats source ID ${originalId} in its full-detail tail.`
        );
      }
      admissionLevels[originalId] = terminalLevel;
    }
    for (
      let compactRank = previousCount;
      compactRank < this.pointCount;
      compactRank++
    ) {
      admissionLevels[hierarchy[compactRank]] =
        LOD_FULL_DETAIL_ADMISSION_LEVEL;
    }
    descriptorsByLevel[terminalLevel] = null;

    const candidate = Object.freeze({
      admissionLevels,
      descriptorsByLevel: Object.freeze(descriptorsByLevel),
      generationToken,
    });
    this._lodMembershipOwner = candidate;
    return candidate;
  }

  /**
   * Return the exact shared membership descriptor for one LOD level.
   * Terminal full detail is represented by null (all points admitted).
   *
   * @param {number} lodLevel
   * @returns {Object|null}
   */
  getLodMembership(lodLevel) {
    if (lodLevel === -1) return null;
    if (
      !Number.isInteger(lodLevel) ||
      lodLevel < 0 ||
      lodLevel >= this.lodLevels.length
    ) {
      throw new RangeError(
        `SpatialIndex LOD membership level ${String(lodLevel)} is outside the published inventory.`
      );
    }
    if (this.lodLevels[lodLevel]?.isFullDetail === true) {
      return null;
    }
    const owner = this._ensureLodMembershipOwner();
    const descriptor = owner.descriptorsByLevel[lodLevel];
    if (descriptor === null || descriptor === undefined) {
      throw new Error(
        `SpatialIndex LOD ${lodLevel} has no exact membership descriptor.`
      );
    }
    return descriptor;
  }

  /**
   * Get LOD level for a given camera distance.
   * @param {number} distance - Camera distance from target
   * @param {number} viewportHeight - Viewport height in pixels
   * @param {number} previousLevel - Previous LOD level for this view (for hysteresis). Pass -1 or undefined for first call.
   * @param {number} dimensionLevel - Current dimension level (1, 2, or 3).
   * @param {Object} [overrideBounds] - Optional bounds override for view-specific positions.
   *   When positions differ from octree (e.g., 2D projection), pass actual bounds to get
   *   correct LOD selection. Format: { minX, maxX, minY, maxY, minZ, maxZ }
   * @returns {number} LOD level (0 = highest detail)
   */
  getLODLevel(distance, viewportHeight, previousLevel, dimensionLevel, overrideBounds = null) {
    if (this.lodLevels.length === 0) return -1;

    const validDimLevel = requireDimensionLevel(
      dimensionLevel,
      'SpatialIndex LOD dimensionLevel'
    );

    const numLevels = this.lodLevels.length;

    // Calculate data diagonal size for scale-independent LOD selection
    // Use override bounds if provided (for view-specific positions), otherwise use octree bounds
    // This handles cases where the octree was built from 3D-padded positions but we're viewing in 2D
    const bounds = overrideBounds || this.bounds;
    const dx = bounds.maxX - bounds.minX;
    const dy = bounds.maxY - bounds.minY;
    const dz = bounds.maxZ - bounds.minZ;
    // For lower dimensions, use only the significant extents (data may be along any axis)
    // Sort extents to find the largest ones regardless of which axis they're on
    let dataSize;
    if (validDimLevel === 1) {
      // 1D: use the largest extent (data could be along X, Y, or Z)
      dataSize = Math.max(dx, dy, dz) || 1;
	    } else if (validDimLevel === 2) {
	      // 2D: use the two largest extents (handles XY, XZ, or YZ planes)
	      // Avoid allocation/sort in a hot helper (used when adaptive LOD is enabled).
	      const maxExtent = Math.max(dx, dy, dz);
	      const minExtent = Math.min(dx, dy, dz);
	      const midExtent = dx + dy + dz - maxExtent - minExtent;
	      dataSize = Math.sqrt(maxExtent * maxExtent + midExtent * midExtent) || 1;
	    } else {
	      dataSize = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;  // 3D+: full diagonal
	    }

    // Normalize distance relative to data size
    const distanceRatio = distance / dataSize;

    // Map distance ratio to LOD level
    const minRatio = 0.3;
    const maxRatio = 3.0;
    const clampedRatio = Math.max(minRatio, Math.min(maxRatio, distanceRatio));

    const t = 1.0 - (Math.log(clampedRatio / minRatio) / Math.log(maxRatio / minRatio));
    const targetLevel = t * (numLevels - 1);

    // Apply hysteresis with large dead zone to prevent oscillation
    const HYSTERESIS = 0.7;

    // Use passed previousLevel for per-view hysteresis (instead of global state)
    const currentLevel = previousLevel >= 0 ? previousLevel : Math.round(targetLevel);
    let newLevel = currentLevel;

    if (targetLevel > currentLevel + HYSTERESIS && currentLevel < numLevels - 1) {
      newLevel = currentLevel + 1;
    } else if (targetLevel < currentLevel - HYSTERESIS && currentLevel > 0) {
      newLevel = currentLevel - 1;
    }

    return Math.max(0, Math.min(numLevels - 1, newLevel));
  }

  getVisibleIndices(frustumPlanes, maxPoints = Infinity) {
    const visibleIndices = [];

    const traverse = (node) => {
      if (!node || visibleIndices.length >= maxPoints) return;

      if (!this._boundsInFrustum(node.bounds, frustumPlanes)) {
        return;
      }

      if (node.indices !== null) {
        for (let i = 0; i < node.indices.length && visibleIndices.length < maxPoints; i++) {
          visibleIndices.push(node.indices[i]);
        }
      } else if (node.children) {
        for (const child of node.children) {
          traverse(child);
        }
      }
    };

    traverse(this.root);
    return visibleIndices;
  }

  _boundsInFrustum(bounds, planes) {
    for (let i = 0; i < planes.length; i++) {
      const plane = planes[i];
      const px = plane[0] >= 0 ? bounds.maxX : bounds.minX;
      const py = plane[1] >= 0 ? bounds.maxY : bounds.minY;
      const pz = plane[2] >= 0 ? bounds.maxZ : bounds.minZ;

      if (plane[0] * px + plane[1] * py + plane[2] * pz + plane[3] < 0) {
        return false;
      }
    }
    return true;
  }

  _boundsIntersectsSphere(bounds, center, radius) {
    // Clamp point to AABB and measure distance to sphere center
    const cx = Math.max(bounds.minX, Math.min(center[0], bounds.maxX));
    const cy = Math.max(bounds.minY, Math.min(center[1], bounds.maxY));
    const cz = Math.max(bounds.minZ, Math.min(center[2], bounds.maxZ));
    const dx = cx - center[0];
    const dy = cy - center[1];
    const dz = cz - center[2];
    return (dx * dx + dy * dy + dz * dz) <= radius * radius;
  }

  /**
   * Visit every point in leaves whose bounds intersect a sphere. Node
   * rejection is conservative; the caller owns the exact point-level
   * predicate. Unlike queryRadius(), this traversal has no result cap.
   * Each original point ID is visited at most once.
   *
   * @param {ArrayLike<number>} center
   * @param {number} radius
   * @param {(cellIndex: number) => void} visitor
   */
  visitRadiusCandidates(center, radius, visitor) {
    requireNumericVector(center, 3, 'SpatialIndex radius center');
    if (!Number.isFinite(radius) || radius < 0) {
      throw new RangeError(
        'SpatialIndex radius must be a finite non-negative number.'
      );
    }
    if (typeof visitor !== 'function') {
      throw new TypeError('SpatialIndex radius visitor must be a function.');
    }
    if (!this.root) return;

    const stack = [this.root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (
        !node ||
        !this._boundsIntersectsSphere(node.bounds, center, radius)
      ) {
        continue;
      }
      if (node.indices) {
        for (let index = 0; index < node.indices.length; index++) {
          visitor(node.indices[index]);
        }
      } else if (node.children) {
        for (let index = 0; index < node.children.length; index++) {
          const child = node.children[index];
          if (child) stack.push(child);
        }
      }
    }
  }

  _boundsIntersectsProjectedRect(bounds, mvpMatrix, clipPlanes) {
    // Screen-space division reverses inequalities behind the eye. Only prune
    // boxes proven wholly in front of the clip-W singularity; boxes touching
    // or crossing it are traversed so the caller's exact projection predicate
    // remains authoritative.
    const wa = mvpMatrix[3];
    const wb = mvpMatrix[7];
    const wc = mvpMatrix[11];
    const wd = mvpMatrix[15];
    const minimumClipW =
      wd +
      wa * (wa >= 0 ? bounds.minX : bounds.maxX) +
      wb * (wb >= 0 ? bounds.minY : bounds.maxY) +
      wc * (wc >= 0 ? bounds.minZ : bounds.maxZ);
    if (minimumClipW <= 1e-10) return true;

    for (let planeOffset = 0; planeOffset < 24; planeOffset += 4) {
      const a = clipPlanes[planeOffset];
      const b = clipPlanes[planeOffset + 1];
      const c = clipPlanes[planeOffset + 2];
      const d = clipPlanes[planeOffset + 3];
      const maximum =
        d +
        a * (a >= 0 ? bounds.maxX : bounds.minX) +
        b * (b >= 0 ? bounds.maxY : bounds.minY) +
        c * (c >= 0 ? bounds.maxZ : bounds.minZ);
      if (maximum < 0) return false;
    }
    return true;
  }

  /**
   * Visit every point in leaves that can project into an NDC rectangle while
   * passing the canonical near/far clip planes. The six object-space planes
   * are derived exactly from the captured MVP matrix and rectangle. Boxes
   * crossing clip-W=0 are deliberately retained for exact point testing.
   *
   * @param {ArrayLike<number>} mvpMatrix Column-major MVP matrix.
   * @param {{minX:number,maxX:number,minY:number,maxY:number}} ndcBounds
   * @param {(cellIndex: number) => void} visitor
   */
  visitProjectedRectCandidates(mvpMatrix, ndcBounds, visitor) {
    requireNumericVector(
      mvpMatrix,
      16,
      'SpatialIndex projected-rectangle MVP matrix'
    );
    if (
      ndcBounds === null ||
      typeof ndcBounds !== 'object' ||
      Array.isArray(ndcBounds)
    ) {
      throw new TypeError(
        'SpatialIndex projected-rectangle NDC bounds must be an object.'
      );
    }
    const minX = requireFiniteNumber(
      ndcBounds.minX,
      'SpatialIndex projected-rectangle minX'
    );
    const maxX = requireFiniteNumber(
      ndcBounds.maxX,
      'SpatialIndex projected-rectangle maxX'
    );
    const minY = requireFiniteNumber(
      ndcBounds.minY,
      'SpatialIndex projected-rectangle minY'
    );
    const maxY = requireFiniteNumber(
      ndcBounds.maxY,
      'SpatialIndex projected-rectangle maxY'
    );
    if (minX > maxX || minY > maxY) {
      throw new RangeError(
        'SpatialIndex projected-rectangle NDC bounds must be ordered.'
      );
    }
    if (typeof visitor !== 'function') {
      throw new TypeError(
        'SpatialIndex projected-rectangle visitor must be a function.'
      );
    }
    if (!this.root) return;

    // Column-major clip rows: X=(0,4,8,12), Y=(1,5,9,13),
    // Z=(2,6,10,14), W=(3,7,11,15).
    const planes = new Float64Array(24);
    const setPlane = (offset, xFactor, yFactor, zFactor, wFactor) => {
      planes[offset] =
        xFactor * mvpMatrix[0] +
        yFactor * mvpMatrix[1] +
        zFactor * mvpMatrix[2] +
        wFactor * mvpMatrix[3];
      planes[offset + 1] =
        xFactor * mvpMatrix[4] +
        yFactor * mvpMatrix[5] +
        zFactor * mvpMatrix[6] +
        wFactor * mvpMatrix[7];
      planes[offset + 2] =
        xFactor * mvpMatrix[8] +
        yFactor * mvpMatrix[9] +
        zFactor * mvpMatrix[10] +
        wFactor * mvpMatrix[11];
      planes[offset + 3] =
        xFactor * mvpMatrix[12] +
        yFactor * mvpMatrix[13] +
        zFactor * mvpMatrix[14] +
        wFactor * mvpMatrix[15];
    };
    setPlane(0, 1, 0, 0, -minX);   // clipX >= minX * clipW
    setPlane(4, -1, 0, 0, maxX);   // clipX <= maxX * clipW
    setPlane(8, 0, 1, 0, -minY);   // clipY >= minY * clipW
    setPlane(12, 0, -1, 0, maxY);  // clipY <= maxY * clipW
    setPlane(16, 0, 0, 1, 1);      // clipZ >= -clipW
    setPlane(20, 0, 0, -1, 1);     // clipZ <= clipW

    const stack = [this.root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (
        !node ||
        !this._boundsIntersectsProjectedRect(
          node.bounds,
          mvpMatrix,
          planes
        )
      ) {
        continue;
      }
      if (node.indices) {
        for (let index = 0; index < node.indices.length; index++) {
          visitor(node.indices[index]);
        }
      } else if (node.children) {
        for (let index = 0; index < node.children.length; index++) {
          const child = node.children[index];
          if (child) stack.push(child);
        }
      }
    }
  }

  _boundsIntersectsExpandedRaySegment(
    bounds,
    origin,
    direction,
    maxDistance,
    radius
  ) {
    let minimumDistance = 0;
    let maximumDistance = maxDistance;

    for (let axis = 0; axis < 3; axis++) {
      const axisOrigin = origin[axis];
      const axisDirection = direction[axis];
      let axisMinimum;
      let axisMaximum;
      if (axis === 0) {
        axisMinimum = bounds.minX - radius;
        axisMaximum = bounds.maxX + radius;
      } else if (axis === 1) {
        axisMinimum = bounds.minY - radius;
        axisMaximum = bounds.maxY + radius;
      } else {
        axisMinimum = bounds.minZ - radius;
        axisMaximum = bounds.maxZ + radius;
      }
      if (axisDirection === 0) {
        if (
          axisOrigin < axisMinimum ||
          axisOrigin > axisMaximum
        ) {
          return false;
        }
        continue;
      }

      const inverseDirection = 1 / axisDirection;
      let entryDistance =
        (axisMinimum - axisOrigin) * inverseDirection;
      let exitDistance =
        (axisMaximum - axisOrigin) * inverseDirection;
      if (entryDistance > exitDistance) {
        const swap = entryDistance;
        entryDistance = exitDistance;
        exitDistance = swap;
      }
      minimumDistance = Math.max(minimumDistance, entryDistance);
      maximumDistance = Math.min(maximumDistance, exitDistance);
      if (minimumDistance > maximumDistance) return false;
    }
    return true;
  }

  /**
   * Visit every point in leaves that can intersect a radius-expanded finite
   * ray segment. Node rejection is conservative; the caller owns the exact
   * point-level predicate. Each original point ID is visited at most once.
   *
   * @param {ArrayLike<number>} origin
   * @param {ArrayLike<number>} direction
   * @param {number} maxDistance
   * @param {number} radius
   * @param {(cellIndex: number) => void} visitor
   */
  visitRaySegmentCandidates(
    origin,
    direction,
    maxDistance,
    radius,
    visitor
  ) {
    requireNumericVector(origin, 3, 'SpatialIndex ray origin');
    requireNumericVector(direction, 3, 'SpatialIndex ray direction');
    if (!Number.isFinite(maxDistance) || maxDistance < 0) {
      throw new RangeError(
        'SpatialIndex ray maxDistance must be a finite non-negative number.'
      );
    }
    if (!Number.isFinite(radius) || radius < 0) {
      throw new RangeError(
        'SpatialIndex ray radius must be a finite non-negative number.'
      );
    }
    if (typeof visitor !== 'function') {
      throw new TypeError('SpatialIndex ray visitor must be a function.');
    }
    if (!this.root) return;

    const stack = [this.root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (
        !node ||
        !this._boundsIntersectsExpandedRaySegment(
          node.bounds,
          origin,
          direction,
          maxDistance,
          radius
        )
      ) {
        continue;
      }
      if (node.indices) {
        for (let index = 0; index < node.indices.length; index++) {
          visitor(node.indices[index]);
        }
      } else if (node.children) {
        for (let index = 0; index < node.children.length; index++) {
          const child = node.children[index];
          if (child) stack.push(child);
        }
      }
    }
  }

  queryRadius(center, radius, maxResults = 64) {
    if (!this.root || radius <= 0) return [];
    const results = [];
    const stack = [this.root];
    const r2 = radius * radius;

    while (stack.length && results.length < maxResults) {
      const node = stack.pop();
      if (!node) continue;
      if (!this._boundsIntersectsSphere(node.bounds, center, radius)) continue;

      if (node.indices) {
        for (let i = 0; i < node.indices.length && results.length < maxResults; i++) {
          const idx = node.indices[i];
          const px = this.positions[idx * 3];
          const py = this.positions[idx * 3 + 1];
          const pz = this.positions[idx * 3 + 2];
          const dx = px - center[0];
          const dy = py - center[1];
          const dz = pz - center[2];
          const dist2 = dx * dx + dy * dy + dz * dz;
          if (dist2 <= r2) {
            results.push(idx);
          }
        }
      } else if (node.children) {
        for (const child of node.children) {
          if (child) stack.push(child);
        }
      }
    }

    return results;
  }

  /**
   * Query points within radius at a specific LOD level.
   * Each result's lodIndex is its compact LOD-prefix position, while
   * originalIndex is the exact source-data point ID.
   * @param {Array} center - [x, y, z] center point
   * @param {number} radius - Search radius
   * @param {number} lodLevel - LOD level to query (0 = lowest detail, max = full detail)
   * @param {number} maxResults - Maximum results to return
   * @param {Float32Array} [customPositions] - Optional custom positions array for view-specific queries
   *   (e.g., 2D projected positions). If provided, queries against these positions instead of
   *   the spatial index's source positions. Must have same point count as original data.
   * @returns {Array} Array of { lodIndex, position, originalIndex }
   */
  queryRadiusAtLOD(center, radius, lodLevel, maxResults, customPositions = null) {
    if (radius <= 0) return [];

    const numLevels = this.lodLevels.length;
    if (!Number.isInteger(lodLevel) || lodLevel < 0 || lodLevel >= numLevels) {
      throw new RangeError(
        `SpatialIndex LOD level must be an integer in [0, ${numLevels - 1}].`
      );
    }
    if (!Number.isInteger(maxResults) || maxResults <= 0) {
      throw new TypeError('SpatialIndex maxResults must be a positive integer.');
    }
    if (
      customPositions !== null &&
      (!(customPositions instanceof Float32Array) ||
        customPositions.length !== this.positions.length)
    ) {
      throw new TypeError(
        `SpatialIndex customPositions must be null or a Float32Array with exactly ${this.positions.length} values.`
      );
    }

    const level = this.lodLevels[lodLevel];
    const pointCount = level.pointCount;
    const isFullDetail = level.isFullDetail;
    const sourcePositions = customPositions ?? this.positions;

    const results = [];
    const r2 = radius * radius;

    // Simple brute force over the LOD candidate IDs (reduced levels are small enough).
    for (let i = 0; i < pointCount && results.length < maxResults; i++) {
      const originalIdx = isFullDetail ? i : level.indices[i];
      const sourceOffset = originalIdx * 3;
      const px = sourcePositions[sourceOffset];
      const py = sourcePositions[sourceOffset + 1];
      const pz = sourcePositions[sourceOffset + 2];

      const dx = px - center[0];
      const dy = py - center[1];
      const dz = pz - center[2];
      const dist2 = dx * dx + dy * dy + dz * dz;
      if (dist2 <= r2) {
        results.push({
          lodIndex: i,
          originalIndex: originalIdx,
          position: [px, py, pz]
        });
      }
    }

    return results;
  }

  getBoundingSphere() {
    const b = this.bounds;
    const centerX = (b.minX + b.maxX) * 0.5;
    const centerY = (b.minY + b.maxY) * 0.5;
    const centerZ = (b.minZ + b.maxZ) * 0.5;

    const dx = b.maxX - b.minX;
    const dy = b.maxY - b.minY;
    const dz = b.maxZ - b.minZ;
    const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5;

    return { center: [centerX, centerY, centerZ], radius };
  }

  /**
   * Publish one exact compact-rank-to-leaf mapping shared by every reduced
   * LOD. A query marks its visible leaf ordinals, then scans only [0, K) for
   * the requested prefix. The emitted EBO is therefore globally ordered by
   * compact rank and costs O(visible leaves + K), independent of Kmax.
   */
  _buildLODNodeMappings() {
    console.time('LOD node mapping');
    try {
      if (
        !Array.isArray(this.lodLevels) ||
        this.lodLevels.length === 0 ||
        this.lodLevels.at(-1)?.isFullDetail !== true
      ) {
        throw new Error(
          'SpatialIndex LOD node mapping requires one terminal full-detail level.'
        );
      }

      const reducedLevels = this.lodLevels.slice(0, -1);
      const maximumIndices =
        reducedLevels.at(-1)?.indices ?? null;
      if (
        maximumIndices !== null &&
        !(maximumIndices instanceof Uint32Array)
      ) {
        throw new TypeError(
          'SpatialIndex LOD node mapping requires exact Uint32Array prefix indices.'
        );
      }
      const maximumCount = maximumIndices?.length ?? 0;

      // Staging is deliberately detached from both the tree and this owner.
      // A late leaf read/allocation/publication failure therefore leaves the
      // accepted generation byte-for-byte untouched and retryable.
      const leaves = [];
      const collectLeaves = node => {
        if (!node) return;
        const indices = node.indices;
        if (indices !== null) {
          if (!(indices instanceof Uint32Array)) {
            throw new TypeError(
              'SpatialIndex leaf membership must be an exact Uint32Array.'
            );
          }
          leaves.push({ indices, node });
          return;
        }
        if (node.children) {
          for (const child of node.children) collectLeaves(child);
        }
      };
      collectLeaves(this.root);
      if (leaves.length >= LOD_MAPPING_VISITED_BIT) {
        throw new RangeError(
          'SpatialIndex LOD node mapping exceeds the Uint32 leaf-ordinal contract.'
        );
      }

      // This point-count owner is temporary build scratch. It first proves
      // that the leaves are one exact source-ID partition, then lends its high
      // bit to validate maximum-prefix uniqueness without another N owner.
      const leafOrdinalByOriginalId =
        new Uint32Array(this.pointCount);
      leafOrdinalByOriginalId.fill(LOD_MAPPING_SENTINEL);
      let mappedPointCount = 0;
      for (
        let leafOrdinal = 0;
        leafOrdinal < leaves.length;
        leafOrdinal++
      ) {
        const { indices } = leaves[leafOrdinal];
        for (let index = 0; index < indices.length; index++) {
          const originalId = indices[index];
          if (originalId >= this.pointCount) {
            throw new RangeError(
              `SpatialIndex leaf contains source ID ${originalId} outside ${this.pointCount} points.`
            );
          }
          if (
            leafOrdinalByOriginalId[originalId] !==
            LOD_MAPPING_SENTINEL
          ) {
            throw new Error(
              `SpatialIndex leaves repeat source ID ${originalId}.`
            );
          }
          leafOrdinalByOriginalId[originalId] =
            leafOrdinal;
          mappedPointCount++;
        }
      }
      if (mappedPointCount !== this.pointCount) {
        throw new Error(
          `SpatialIndex leaves own ${mappedPointCount} source IDs but the dataset contains ${this.pointCount}.`
        );
      }

      const leafOrdinalsByCompactRank =
        new Uint32Array(maximumCount);
      for (
        let compactRank = 0;
        compactRank < maximumCount;
        compactRank++
      ) {
        const originalId = maximumIndices[compactRank];
        if (originalId >= this.pointCount) {
          throw new RangeError(
            `SpatialIndex maximum LOD prefix contains source ID ${originalId} outside ${this.pointCount} points.`
          );
        }
        const encodedOrdinal =
          leafOrdinalByOriginalId[originalId];
        if (encodedOrdinal === LOD_MAPPING_SENTINEL) {
          throw new Error(
            `SpatialIndex maximum LOD prefix source ID ${originalId} has no leaf owner.`
          );
        }
        if (
          (encodedOrdinal & LOD_MAPPING_VISITED_BIT) !== 0
        ) {
          throw new Error(
            `SpatialIndex maximum LOD prefix repeats source ID ${originalId}.`
          );
        }
        leafOrdinalsByCompactRank[compactRank] =
          encodedOrdinal;
        leafOrdinalByOriginalId[originalId] =
          encodedOrdinal | LOD_MAPPING_VISITED_BIT;
      }

      const generationToken = Object.freeze({});
      const leafNodes = Object.freeze(
        leaves.map(entry => entry.node)
      );
      const visibleLeafMarks =
        new Uint32Array(leaves.length);
      const queryState = Object.seal({
        generation: 0,
        lastExaminedRanks: 0,
        lastMarkedLeafCount: 0,
      });
      const metadata = leaves.map(
        ({ node }, ordinal) => ({
          descriptor: Object.freeze({
            generationToken,
            ordinal,
          }),
          node,
          previousDescriptor:
            Object.getOwnPropertyDescriptor(
              node,
              'lodMapping'
            ),
        })
      );
      const candidateOwner = Object.freeze({
        generationToken,
        leafNodes,
        leafOrdinalsByCompactRank,
        maximumIndices,
        pointCount: this.pointCount,
        queryState,
        visibleLeafMarks,
      });

      let publishedMetadataCount = 0;
      try {
        for (const entry of metadata) {
          const published = Reflect.defineProperty(
            entry.node,
            'lodMapping',
            {
              configurable: true,
              enumerable: true,
              value: entry.descriptor,
              writable: true,
            }
          );
          if (!published) {
            throw new TypeError(
              'SpatialIndex leaf rejected LOD mapping publication.'
            );
          }
          publishedMetadataCount++;
        }
        this._lodNodeMapping = candidateOwner;
      } catch (error) {
        for (
          let index = publishedMetadataCount - 1;
          index >= 0;
          index--
        ) {
          const entry = metadata[index];
          if (entry.previousDescriptor === undefined) {
            Reflect.deleteProperty(
              entry.node,
              'lodMapping'
            );
          } else {
            Reflect.defineProperty(
              entry.node,
              'lodMapping',
              entry.previousDescriptor
            );
          }
        }
        throw error;
      }
    } finally {
      console.timeEnd('LOD node mapping');
    }
  }

  _validateLodNodeMapping() {
    const owner = this._lodNodeMapping;
    const maximumIndices =
      this.lodLevels.at(-2)?.indices ?? null;
    if (
      owner === null ||
      typeof owner !== 'object' ||
      owner.maximumIndices !== maximumIndices ||
      owner.pointCount !== this.pointCount ||
      !Array.isArray(owner.leafNodes) ||
      !Object.isFrozen(owner.leafNodes) ||
      !(owner.leafOrdinalsByCompactRank instanceof Uint32Array) ||
      owner.leafOrdinalsByCompactRank.length !==
        (maximumIndices?.length ?? 0) ||
      !(owner.visibleLeafMarks instanceof Uint32Array) ||
      owner.visibleLeafMarks.length !==
        owner.leafNodes.length ||
      owner.queryState === null ||
      typeof owner.queryState !== 'object' ||
      !Object.isSealed(owner.queryState) ||
      !Number.isInteger(owner.queryState.generation) ||
      owner.queryState.generation < 0 ||
      owner.queryState.generation > LOD_MAPPING_SENTINEL ||
      owner.generationToken === null ||
      typeof owner.generationToken !== 'object' ||
      !Object.isFrozen(owner.generationToken)
    ) {
      throw new Error(
        'SpatialIndex LOD node mapping has inconsistent generation ownership.'
      );
    }

    let expectedOrdinal = 0;
    const validateLeaves = node => {
      if (!node) return;
      if (node.indices !== null) {
        const metadata = node.lodMapping;
        if (
          metadata === null ||
          typeof metadata !== 'object' ||
          !Object.isFrozen(metadata) ||
          metadata.generationToken !== owner.generationToken ||
          metadata.ordinal !== expectedOrdinal ||
          owner.leafNodes[expectedOrdinal] !== node
        ) {
          throw new Error(
            'SpatialIndex leaf has inconsistent LOD mapping metadata.'
          );
        }
        expectedOrdinal++;
        return;
      }
      if (node.children) {
        for (const child of node.children) validateLeaves(child);
      }
    };
    validateLeaves(this.root);
    if (expectedOrdinal !== owner.leafNodes.length) {
      throw new Error(
        `SpatialIndex tree contains ${expectedOrdinal} leaves but the mapping owns ${owner.leafNodes.length}.`
      );
    }
    for (
      let compactRank = 0;
      compactRank < owner.leafOrdinalsByCompactRank.length;
      compactRank++
    ) {
      if (
        owner.leafOrdinalsByCompactRank[compactRank] >=
        owner.leafNodes.length
      ) {
        throw new RangeError(
          `SpatialIndex compact rank ${compactRank} has an invalid leaf ordinal.`
        );
      }
    }
    return owner.generationToken;
  }

  _reserveLodMappingMarkGeneration(owner, span = 1) {
    if (
      owner !== this._lodNodeMapping ||
      !(owner?.visibleLeafMarks instanceof Uint32Array) ||
      !Number.isInteger(span) ||
      span < 1 ||
      span > 2
    ) {
      throw new Error(
        'SpatialIndex LOD query requires the exact published mark owner.'
      );
    }
    const queryState = owner.queryState;
    let firstGeneration = queryState.generation + 1;
    if (
      firstGeneration >
      LOD_MAPPING_SENTINEL - span + 1
    ) {
      owner.visibleLeafMarks.fill(0);
      firstGeneration = 1;
    }
    queryState.generation =
      firstGeneration + span - 1;
    return firstGeneration;
  }

  _requireLodLeafOrdinal(owner, leaf) {
    const metadata = leaf?.lodMapping;
    const ordinal = metadata?.ordinal;
    if (
      metadata === null ||
      typeof metadata !== 'object' ||
      metadata.generationToken !== owner.generationToken ||
      !Number.isInteger(ordinal) ||
      ordinal < 0 ||
      ordinal >= owner.leafNodes.length ||
      owner.leafNodes[ordinal] !== leaf
    ) {
      throw new Error(
        'SpatialIndex visible leaf does not belong to the exact LOD mapping.'
      );
    }
    return ordinal;
  }

  _markLodVisibleLeaves(owner, visibleLeaves) {
    const generation =
      this._reserveLodMappingMarkGeneration(owner);
    const marks = owner.visibleLeafMarks;
    for (const leaf of visibleLeaves) {
      const ordinal =
        this._requireLodLeafOrdinal(owner, leaf);
      if (marks[ordinal] === generation) {
        throw new Error(
          'SpatialIndex visible LOD leaves contain a duplicate leaf.'
        );
      }
      marks[ordinal] = generation;
    }
    owner.queryState.lastMarkedLeafCount =
      visibleLeaves.length;
    return generation;
  }

  /**
   * LOD EBO order is globally compact-rank ordered, so traversal order is not
   * semantic. Compare exact leaf identity as a set without allocating a Set.
   */
  hasSameLodVisibleLeafSet(accepted, candidate) {
    if (
      !Array.isArray(accepted) ||
      !Array.isArray(candidate) ||
      accepted.length !== candidate.length
    ) {
      return false;
    }
    const owner = this._lodNodeMapping;
    if (
      owner === null ||
      typeof owner !== 'object' ||
      !(owner.visibleLeafMarks instanceof Uint32Array)
    ) {
      throw new Error(
        'SpatialIndex LOD node mapping has not been published.'
      );
    }
    if (accepted.length === 0) return true;

    const acceptedGeneration =
      this._reserveLodMappingMarkGeneration(owner, 2);
    const candidateGeneration = acceptedGeneration + 1;
    const marks = owner.visibleLeafMarks;
    for (const leaf of accepted) {
      const ordinal =
        this._requireLodLeafOrdinal(owner, leaf);
      if (marks[ordinal] === acceptedGeneration) {
        return false;
      }
      marks[ordinal] = acceptedGeneration;
    }
    for (const leaf of candidate) {
      const ordinal =
        this._requireLodLeafOrdinal(owner, leaf);
      if (marks[ordinal] !== acceptedGeneration) {
        return false;
      }
      marks[ordinal] = candidateGeneration;
    }
    owner.queryState.lastExaminedRanks = 0;
    owner.queryState.lastMarkedLeafCount =
      accepted.length + candidate.length;
    return true;
  }

  _requireReducedLodPrefixCount(lodLevel) {
    if (
      !Number.isInteger(lodLevel) ||
      lodLevel < 0 ||
      lodLevel >= this.lodLevels.length - 1
    ) {
      throw new RangeError(
        `SpatialIndex reduced LOD level must be an integer in [0, ${this.lodLevels.length - 2}].`
      );
    }
    const level = this.lodLevels[lodLevel];
    if (
      level?.isFullDetail === true ||
      !(level?.indices instanceof Uint32Array) ||
      level.indices.length !== level.pointCount
    ) {
      throw new Error(
        `SpatialIndex LOD ${lodLevel} is not an exact reduced prefix.`
      );
    }
    return level.pointCount;
  }

  countLodMappedIndices(visibleLeaves, lodLevel) {
    if (!Array.isArray(visibleLeaves)) {
      throw new TypeError(
        'SpatialIndex visible LOD leaves must be an exact array.'
      );
    }
    const prefixCount =
      this._requireReducedLodPrefixCount(lodLevel);
    const owner = this._lodNodeMapping;
    const leafOrdinalsByCompactRank =
      owner?.leafOrdinalsByCompactRank;
    if (
      !(leafOrdinalsByCompactRank instanceof Uint32Array) ||
      !(owner.visibleLeafMarks instanceof Uint32Array)
    ) {
      throw new Error(
        'SpatialIndex LOD node mapping has not been published.'
      );
    }
    if (visibleLeaves.length === 0) {
      owner.queryState.lastExaminedRanks = 0;
      owner.queryState.lastMarkedLeafCount = 0;
      return 0;
    }

    const generation =
      this._markLodVisibleLeaves(owner, visibleLeaves);
    const marks = owner.visibleLeafMarks;
    let visibleCount = 0;
    for (
      let compactRank = 0;
      compactRank < prefixCount;
      compactRank++
    ) {
      if (
        marks[leafOrdinalsByCompactRank[compactRank]] ===
        generation
      ) {
        visibleCount++;
      }
    }
    owner.queryState.lastExaminedRanks = prefixCount;
    return visibleCount;
  }

  writeLodMappedIndices(
    visibleLeaves,
    lodLevel,
    target
  ) {
    if (!(target instanceof Uint32Array)) {
      throw new TypeError(
        'SpatialIndex visible LOD target must be an exact Uint32Array.'
      );
    }
    const prefixCount =
      this._requireReducedLodPrefixCount(lodLevel);
    const owner = this._lodNodeMapping;
    const leafOrdinalsByCompactRank =
      owner?.leafOrdinalsByCompactRank;
    if (
      !(leafOrdinalsByCompactRank instanceof Uint32Array) ||
      !(owner.visibleLeafMarks instanceof Uint32Array)
    ) {
      throw new Error(
        'SpatialIndex LOD node mapping has not been published.'
      );
    }
    if (visibleLeaves.length === 0) {
      owner.queryState.lastExaminedRanks = 0;
      owner.queryState.lastMarkedLeafCount = 0;
      return 0;
    }

    const generation =
      this._markLodVisibleLeaves(owner, visibleLeaves);
    const marks = owner.visibleLeafMarks;
    let writeOffset = 0;
    for (
      let compactRank = 0;
      compactRank < prefixCount;
      compactRank++
    ) {
      if (
        marks[leafOrdinalsByCompactRank[compactRank]] ===
        generation
      ) {
        if (writeOffset >= target.length) {
          throw new RangeError(
            'SpatialIndex visible LOD target capacity is too small.'
          );
        }
        target[writeOffset++] = compactRank;
      }
    }
    owner.queryState.lastExaminedRanks = prefixCount;
    return writeOffset;
  }

  /**
   * Validate that spatial index contains all original points.
   * Returns the total count of points in all leaf nodes.
   */
  validatePointCount() {
    let count = 0;
    const countLeaves = (node) => {
      if (!node) return;
      if (node.indices) {
        count += node.indices.length;
      } else if (node.children) {
        for (const child of node.children) {
          countLeaves(child);
        }
      }
    };
    countLeaves(this.root);
    const valid = count === this.pointCount;
    if (!valid) {
      const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
      console.error(`[${treeNames[this.dimensionLevel]}] Point count mismatch: tree has ${count}, expected ${this.pointCount}`);
    }
    return { count, expected: this.pointCount, valid };
  }
}

// ============================================================================
// HIGH PERFORMANCE RENDERER (WebGL2 Only)
// ============================================================================

/**
 * Configuration options for the renderer
 */
export const RendererConfig = {
  // Quality levels
  QUALITY_ULTRALIGHT: 'ultralight',
  QUALITY_LIGHT: 'light',
  QUALITY_FULL: 'full',

  // Feature flags
  USE_INTERLEAVED_BUFFERS: true,
  USE_LOD: false,
  USE_FRUSTUM_CULLING: false,

  // LOD settings
  LOD_MAX_POINTS_PER_NODE: 1000,
  LOD_MAX_DEPTH: 8,
};

/**
 * High-Performance Renderer Class (WebGL2 Only)
 */
export class HighPerfRendererContextLostError extends Error {
  constructor(operation) {
    super(
      `HighPerfRenderer cannot ${operation} after its WebGL context was lost.`
    );
    this.name = 'HighPerfRendererContextLostError';
  }
}

export class HighPerfRenderer {
  constructor(gl, options = {}) {
    this.options = { ...RendererConfig, ...options };

    // Must be WebGL2
    if (!gl || typeof gl.createVertexArray !== 'function') {
      throw new Error('WebGL2 context required for HighPerfRenderer');
    }

    this.gl = gl;
    this._contextLost = false;
    this._disposed = false;
    console.log('[HighPerfRenderer] Using WebGL2');

    // Shader programs
    this.programs = {
      full: null,
      light: null,
      ultralight: null
    };

    // Current active program
    this.activeProgram = null;
    this.activeQuality = 'full';

    // Uniform locations cache
    this.uniformLocations = new Map();

    // Data buffers
    this.buffers = {
      interleaved: null,
      positions: null,
      colors: null,
      alphas: null,
    };
    // Exact logical store size accepted by WebGL for the live interleaved
    // buffer. Keep this separate from pointCount: failed replacements retain
    // their previous allocation even after semantic draw state is invalidated.
    this._interleavedGpuByteLength = 0;

    // Alpha texture for efficient alpha-only updates (avoids full buffer rebuild)
    // Using a texture allows updating alpha with texSubImage2D instead of bufferData
    this._alphaTexture = null;
    this._alphaTexWidth = 0;
    this._alphaTexHeight = 0;
    this._alphaTexData = null; // Uint8Array for texture upload
    this._alphaTexStagingData = null;
    this._useAlphaTexture = false; // Whether alpha texture is active
    this._currentAlphas = null;
    this._alphaTextureByteLength = 0;

    // LOD index textures for alpha lookup (maps LOD vertex index to original index)
    // Dimension-aware: Map<dimensionLevel, Array<{texture, width, height}>>
    this._lodIndexTexturesByDimension = new Map();
    // Metadata arrays above and lodBuffersByDimension are non-owning draw
    // views. This map is the sole owner of each dimension's compact prefix
    // generation and its shared original-ID topology.
    this._lodResourceOwnersByDimension = new Map();

    // Dummy 1x1 R32UI texture for when LOD index texture is not used
    // Required because usampler2D uniforms must have a valid unsigned int texture bound
    this._dummyLodIndexTexture = null;
    this._dummyLodIndexTextureByteLength = 0;

    // LOD system - dimension-aware spatial indexing
    this.spatialIndices = new Map();  // Per-dimension spatial indices: Map<dimensionLevel, SpatialIndex>
    this.lodBuffersByDimension = new Map();  // Per-dimension LOD buffers: Map<dimensionLevel, lodBuffers[]>
    this.currentDimensionLevel = 3;  // Current active dimension level for live view

    // State
    this.pointCount = 0;
    this.forceLODLevel = -1; // -1 = auto, 0+ = forced level
    this.useAdaptiveLOD = this.options.USE_LOD;
    this.useFrustumCulling = this.options.USE_FRUSTUM_CULLING;
    this.useInterleavedBuffers = this.options.USE_INTERLEAVED_BUFFERS;

    // VAO for WebGL2
    this.vao = null;

    // Snapshot buffers for multi-view rendering (avoids re-uploading per frame).
    // Each snapshot owns one RGB VBO plus one R8 alpha texture while its
    // geometry generation owns the immutable position VBO shared by every
    // same-generation VAO. `buffer` remains a compatibility alias for the
    // snapshot color owner's buffer.
    // Map<snapshotId, { vao, colorOwner, alphaTexture, pointCount, ... }>
    this.snapshotBuffers = new Map();
    // Snapshot point publications are synchronous. One renderer-wide staging
    // owner therefore serves every view without retaining another 3N+N bytes
    // per snapshot at the 30M-point scale.
    this._snapshotColorStagingData = null;
    this._snapshotAlphaStagingData = null;
    // Geometry identity is an explicit publication generation, never an array
    // identity. Callers are allowed to mutate and republish the same typed
    // array, so reference equality cannot prove that two GPU publications own
    // the same coordinates.
    this._liveGeometryGeneration = 0;
    this._nextGeometryGeneration = 1;
    // Snapshot CPU coordinates and GPU positions are immutable renderer-owned
    // publications. Snapshots derived from one geometry generation share
    // exactly one CPU copy and one 12-byte-per-point position VBO.
    // Map<generation, {
    //   generation, positions, positionBuffer, positionBufferByteLength,
    //   refCount, spatialIndices
    // }>
    this._snapshotGeometryPools = new Map();
    // Detached snapshot generations and data publications remain explicitly
    // renderer-owned until every individual GL/geometry retirement succeeds.
    // Records are mutated per handle so retries never double-delete or
    // double-release work that already completed.
    this._pendingSnapshotRetirements = new Set();
    this._pendingDataRetirements = new Set();
    // Programs are not part of byte-addressable data ownership, but deletion
    // can still fail independently. Keep a liveness-aware journal so dispose
    // retries only the handles that remain live.
    this._pendingProgramRetirements = new Set();
    this._pendingShaderRetirements = new Set();
    this._pendingProgramUnbind = false;
    this._validatedLodNodeMappings = new WeakMap();
    this._validatedSpatialIndices = new WeakSet();
    // Lightweight semantic tokens let observers detect a replaced LOD
    // spatial owner without forcing the lazy point-count membership table to
    // materialize on the render hot path.
    this._lodSpatialOwnerTokens = new WeakMap();
    // Sequential consumers (preview/export/overlays) need only the renderer's
    // admitted Uint32 prefix. Cache one constant-size descriptor per LOD
    // level so those paths never force the N-byte random-access table.
    this._lodSequentialMemberships = new WeakMap();

    // Performance stats
    this.stats = {
      lastFrameTime: 0,
      fps: 0,
      visiblePoints: 0,
      lodLevel: -1,
      gpuMemoryMB: 0,
      drawCalls: 0,
      frustumCulled: false,
      cullPercent: 0,
    };

    // Fog bounds
    this.fogNear = 0;
    this.fogFar = 10;

    // Cached bounding sphere (computed from positions, independent of octree)
    this._boundingSphere = null;

    // Dirty flags for lazy buffer rebuilds (avoids double rebuilds)
    this._bufferDirty = false;
    this._dirtyLodDimensions = new Set();
    // Reusable ArrayBuffer to reduce GC pressure
    this._interleavedArrayBuffer = null;
    this._interleavedPositionView = null;
    this._interleavedColorView = null;

    // Pooled visible indices buffer for frustum culling (grows as needed)
    this._visibleIndicesBuffer = null;
    this._visibleIndicesCapacity = 0;

    // Per-view state for multi-view rendering (frustum culling and LOD)
    // Each view needs its own cache to avoid cross-view interference
    this._perViewState = new Map(); // viewId -> { lastFrustumMVP, cachedCulledCount, prevLodLevel }

    this._init();
  }

  _assertOperational(operation) {
    if (this._contextLost === true) {
      throw new HighPerfRendererContextLostError(operation);
    }
    if (this._disposed === true) {
      const error = new Error(
        `HighPerfRenderer cannot ${operation} after disposal.`
      );
      error.name = 'HighPerfRendererDisposedError';
      throw error;
    }
  }

  _init() {
    const gl = this.gl;
    try {
      // Create shader programs
      this._createPrograms();

      // Create VAOs
      const candidateVao = gl.createVertexArray();
      if (!candidateVao) {
        throw new Error(
          'HighPerfRenderer could not allocate its vertex array.'
        );
      }
      this.vao = candidateVao;

      // GL state
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      configureStraightAlphaBlending(gl);

      // Set default quality
      this.setQuality(this.activeQuality);
    } catch (error) {
      // A throwing constructor cannot be disposed by its caller. Detach every
      // published handle first, then attempt all retirements so a late VAO or
      // state failure cannot strand the earlier programs/dummy texture.
      const programs = Object.values(this.programs ?? {});
      this._markProgramUnbindIfOwned(programs);
      this.programs = {
        full: null,
        light: null,
        ultralight: null,
      };
      this.activeProgram = null;
      this.uniformLocations.clear();

      const vao = this.vao;
      const dummyLodIndexTexture = this._dummyLodIndexTexture;
      const dummyLodIndexTextureByteLength =
        this._dummyLodIndexTextureByteLength;
      this.vao = null;
      this._dummyLodIndexTexture = null;
      this._dummyLodIndexTextureByteLength = 0;

      const cleanupFailures = [];
      let unbindFailure = this._attemptProgramUnbind();
      if (unbindFailure) {
        // There is no caller-visible renderer to retry a failed constructor,
        // so give an unsettled transient unbind one final bounded attempt.
        unbindFailure = this._attemptProgramUnbind();
      }
      if (unbindFailure) {
        cleanupFailures.push(unbindFailure);
      }
      this._queueDataRetirement({
        vao,
        dummyLodIndexTexture,
        dummyLodIndexTextureByteLength,
      });
      this._queueProgramRetirement(programs);
      const drainInitializationJournal = (
        drain,
        pending
      ) => {
        let failures = drain.call(this);
        if (failures.length > 0 && pending.size > 0) {
          failures = drain.call(this);
        }
        return failures;
      };
      cleanupFailures.push(
        ...drainInitializationJournal(
          this._drainDataRetirements,
          this._pendingDataRetirements
        ),
        ...drainInitializationJournal(
          this._drainProgramRetirements,
          this._pendingProgramRetirements
        ),
        ...drainInitializationJournal(
          this._drainShaderRetirements,
          this._pendingShaderRetirements
        )
      );

      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          `HighPerfRenderer initialization failed with ${cleanupFailures.length} cleanup error(s).`
        );
      }
      throw error;
    }
  }

  /**
   * Get or create per-view state for multi-view rendering.
   * Each view maintains its own frustum cache, LOD state, index buffer, AND frustum planes to avoid cross-view interference.
   * @param {string} viewId - Exact view identifier.
   * @returns {Object} Per-view state object with lastFrustumMVP, cachedCulledCount, prevLodLevel, indexBuffer, frustumPlanes
   */
  _getViewState(viewId) {
    const vid = requireViewId(viewId);
    if (!this._perViewState.has(vid)) {
      // Create per-view index buffer for frustum culling
      const gl = this.gl;
      const indexBuffer = gl.createBuffer();
      if (!indexBuffer) {
        throw new Error(
          `HighPerfRenderer could not allocate the per-view index buffer for "${vid}".`
        );
      }
      this._perViewState.set(vid, {
        lastFrustumMVP: null,
        lastFrustumBounds: undefined,
        cachedCulledCount: 0,
        cachedVisibleIndices: null,
        cachedLodVisibleIndices: null,  // For LOD + frustum culling combined
        cachedLodLevel: -1,              // LOD level for which indices were cached
        cachedLodDimension: -1,          // Dimension level for which LOD indices were cached
        cachedLodIsCulled: false,        // Whether cached indices are frustum-culled (vs full LOD)
        cachedVisibleNodes: [],          // Accepted ordered octree leaves for the current EBO
        visibleNodesScratch: [],         // Per-view candidate leaves; swapped with cachedVisibleNodes on acceptance
        visibleNodesSpare: null,         // Recovery-only second pool owner while semantic state is invalid
        cachedVisibleSpatialOwner: null, // Exact tree that owns cachedVisibleNodes
        cachedVisibleSpatialRoot: null,  // Exact immutable root traversed for cachedVisibleNodes
        cachedLodMappingGeneration: null,// Exact leaf/rank mapping used by the cached LOD EBO
        prevLodLevel: undefined,         // For logging LOD changes
        lastLodLevel: -1,                // For per-view LOD hysteresis
        lastVisibleCount: undefined,     // For logging visible count changes
        lastDimensionLevel: undefined,   // For cache invalidation on dimension change
        indexBuffer: indexBuffer,        // Per-view index buffer (avoids shared buffer conflicts)
        indexBufferSize: 0,              // Current size of uploaded index buffer
        indexBufferByteLength: 0,        // Last WebGL-accepted backing-store size
        // Pre-cached index buffer support (eliminates upload on LOD level change)
        usePreCachedIndexBuffer: false,  // Whether to use pre-cached buffer vs per-view buffer
        preCachedIndexBuffer: null,      // Reference to pre-cached buffer from lodBuffers
        preCachedGenerationToken: null,
        preCachedSpatialOwner: null,
        // Per-view frustum planes to avoid shared state issues in multi-view rendering
        frustumPlanes: [
          new Float32Array(4), new Float32Array(4), new Float32Array(4),
          new Float32Array(4), new Float32Array(4), new Float32Array(4)
        ],
        // Extraction writes into the rejected owner first. Only a complete,
        // successful extraction swaps it into the accepted visibility state.
        frustumPlaneScratch: [
          new Float32Array(4), new Float32Array(4), new Float32Array(4),
          new Float32Array(4), new Float32Array(4), new Float32Array(4)
        ],
        // Per-view visible indices buffer pool (avoids shared buffer issues in multi-view rendering)
        visibleIndicesBuffer: null,
        visibleIndicesCapacity: 0,
        visibleLodIndicesBuffer: null,
        visibleLodIndicesCapacity: 0,
        // Per-view stats (avoids stats being overwritten by last rendered view in multiview)
        stats: {
          lastFrameTime: 0,
          fps: 0,
          visiblePoints: 0,
          lodLevel: -1,
          drawCalls: 0,
          frustumCulled: false,
          cullPercent: 0
        },
        statsPublished: false
      });
    }
    return this._perViewState.get(vid);
  }

  _invalidateViewStateRecord(viewState) {
    // Retain both leaf-array owners across an invalidation. The accepted array
    // is no longer semantically usable, but dropping it would force a fresh
    // allocation after every filter, geometry, or failed-upload retry.
    const acceptedVisibleNodes =
      Array.isArray(viewState.cachedVisibleNodes)
        ? viewState.cachedVisibleNodes
        : null;
    const visibleNodesScratch =
      Array.isArray(viewState.visibleNodesScratch)
        ? viewState.visibleNodesScratch
        : null;
    const visibleNodesSpare =
      Array.isArray(viewState.visibleNodesSpare)
        ? viewState.visibleNodesSpare
        : null;
    const primaryVisibleNodes =
      visibleNodesScratch ??
      acceptedVisibleNodes ??
      visibleNodesSpare;
    const secondaryVisibleNodes =
      acceptedVisibleNodes !== null &&
      acceptedVisibleNodes !== primaryVisibleNodes
        ? acceptedVisibleNodes
        : (
            visibleNodesSpare !== null &&
            visibleNodesSpare !== primaryVisibleNodes
              ? visibleNodesSpare
              : null
          );
    if (primaryVisibleNodes) {
      primaryVisibleNodes.length = 0;
    }
    if (secondaryVisibleNodes) {
      secondaryVisibleNodes.length = 0;
    }
    viewState.visibleNodesScratch =
      primaryVisibleNodes ?? [];
    viewState.visibleNodesSpare =
      secondaryVisibleNodes;
    viewState.lastFrustumMVP = null;
    viewState.lastFrustumBounds = undefined;
    viewState.cachedCulledCount = 0;
    viewState.cachedVisibleIndices = null;
    viewState.cachedLodVisibleIndices = null;
    viewState.cachedLodLevel = -1;
    viewState.cachedLodDimension = -1;
    viewState.cachedLodIsCulled = false;
    viewState.cachedVisibleNodes = null;
    viewState.cachedVisibleSpatialOwner = null;
    viewState.cachedVisibleSpatialRoot = null;
    viewState.cachedLodMappingGeneration = null;
    viewState.lastDimensionLevel = undefined;
    viewState.lastLodLevel = -1;
    viewState.prevLodLevel = undefined;
    viewState.lastVisibleCount = undefined;
    viewState.indexBufferSize = 0;
    viewState.usePreCachedIndexBuffer = false;
    viewState.preCachedIndexBuffer = null;
    viewState.preCachedGenerationToken = null;
    viewState.preCachedSpatialOwner = null;
    viewState.statsPublished = false;
    if (viewState.stats) {
      viewState.stats.lastFrameTime = 0;
      viewState.stats.fps = 0;
      viewState.stats.visiblePoints = 0;
      viewState.stats.lodLevel = -1;
      viewState.stats.drawCalls = 0;
      viewState.stats.frustumCulled = false;
      viewState.stats.cullPercent = 0;
    }
  }

  /**
   * Invalidate one view's semantic LOD/frustum/filter caches without deleting
   * or reallocating its reusable GPU index buffer and CPU scratch storage.
   *
   * @param {string} viewId
   * @returns {boolean} whether an existing view state was invalidated
   */
  invalidateViewState(viewId) {
    this._assertOperational('invalidate view state');
    const vid = requireViewId(
      viewId,
      'HighPerfRenderer invalidateViewState viewId'
    );
    const viewState = this._perViewState.get(vid);
    if (!viewState) return false;
    this._invalidateViewStateRecord(viewState);
    return true;
  }

  /**
   * Clear per-view state for a specific view (call when view is removed)
   * @param {string|number} viewId - View identifier to clear
   */
  clearViewState(viewId) {
    this._assertOperational('clear view state');
    const vid = requireViewId(viewId, 'HighPerfRenderer clearViewState viewId');
    const viewState = this._perViewState.get(vid);
    if (viewState) {
      // Detach semantic state before fallible cleanup. The retirement journal
      // becomes the sole owner of the EBO until deletion or liveness proof.
      this._perViewState.delete(vid);
      this._queueDataRetirement({
        perViewState: new Map([[vid, viewState]]),
      });
    }
    const failures = this._drainDataRetirements();
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `HighPerfRenderer view "${vid}" is detached but ${failures.length} resource retirement failure(s) remain pending.`
      );
    }
  }

  /**
   * Clear all per-view state (call on data reload or major state reset)
   */
  clearAllViewState() {
    this._assertOperational('clear all view state');
    const detached = new Map(this._perViewState);
    // Detach all observers first so a deletion exception cannot leave a
    // partially active multiview publication.
    this._perViewState.clear();
    if (detached.size > 0) {
      this._queueDataRetirement({ perViewState: detached });
    }
    const failures = this._drainDataRetirements();
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `HighPerfRenderer detached all view state with ${failures.length} resource retirement failure(s) still pending.`
      );
    }
  }

  /**
   * Compute bounds from a positions array.
   * Used for view-specific positions that differ from octree bounds.
   * @param {Float32Array} positions - XYZ positions (length = n * 3)
   * @returns {Object} Bounds object { minX, maxX, minY, maxY, minZ, maxZ }
   */
  static computeBoundsFromPositions(positions) {
    if (
      !(positions instanceof Float32Array) ||
      positions.length < 3 ||
      positions.length % 3 !== 0
    ) {
      throw new TypeError(
        'HighPerfRenderer bounds require a non-empty Float32Array with exactly three values per point.'
      );
    }
    let minX = positions[0], maxX = positions[0];
    let minY = positions[1], maxY = positions[1];
    let minZ = positions[2], maxZ = positions[2];

    for (let i = 3; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (x < minX) minX = x; else if (x > maxX) maxX = x;
      if (y < minY) minY = y; else if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; else if (z > maxZ) maxZ = z;
    }
    return { minX, maxX, minY, maxY, minZ, maxZ };
  }

  _needsLodResources(forceLOD) {
    if (!Number.isInteger(forceLOD) || forceLOD < -1) {
      throw new RangeError(
        'HighPerfRenderer forceLOD must be an integer greater than or equal to -1.'
      );
    }
    return (
      this.useAdaptiveLOD ||
      this.forceLODLevel >= 0 ||
      forceLOD >= 0
    );
  }

  _needsSpatialIndex(forceLOD) {
    if (!Number.isInteger(forceLOD) || forceLOD < -1) {
      throw new RangeError(
        'HighPerfRenderer forceLOD must be an integer greater than or equal to -1.'
      );
    }
    return (
      this.useFrustumCulling ||
      this.useAdaptiveLOD ||
      this.forceLODLevel >= 0 ||
      forceLOD >= 0
    );
  }

  _withNeutralTextureUnpackState(
    alignment,
    owner,
    operation
  ) {
    const gl = this.gl;
    if (
      ![1, 2, 4, 8].includes(alignment) ||
      typeof owner !== 'string' ||
      owner.length === 0 ||
      typeof operation !== 'function'
    ) {
      throw new TypeError(
        'HighPerfRenderer texture unpack transaction received an invalid contract.'
      );
    }

    const pixelStoreParameters = [
      gl.UNPACK_ALIGNMENT,
      gl.UNPACK_ROW_LENGTH,
      gl.UNPACK_IMAGE_HEIGHT,
      gl.UNPACK_SKIP_PIXELS,
      gl.UNPACK_SKIP_ROWS,
      gl.UNPACK_SKIP_IMAGES,
    ];
    const ownsCompleteWebGL2UnpackSurface = (
      typeof gl.pixelStorei === 'function' &&
      Number.isInteger(gl.PIXEL_UNPACK_BUFFER) &&
      Number.isInteger(gl.PIXEL_UNPACK_BUFFER_BINDING) &&
      pixelStoreParameters.every(Number.isInteger)
    );
    // Unit-level GL fixtures that exercise unrelated renderer seams do not
    // model pixel-store state. A real WebGL2 context always enters the exact
    // state transaction below.
    if (!ownsCompleteWebGL2UnpackSurface) {
      return operation();
    }

    const previousPixelUnpackBuffer =
      gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING);
    const previousPixelStore = pixelStoreParameters.map(
      parameter => gl.getParameter(parameter)
    );
    let value;
    let operationError = null;
    try {
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
      value = operation();
    } catch (error) {
      operationError = error;
    }

    let restorationError = null;
    try {
      for (let index = 0; index < pixelStoreParameters.length; index++) {
        gl.pixelStorei(
          pixelStoreParameters[index],
          previousPixelStore[index]
        );
      }
      gl.bindBuffer(
        gl.PIXEL_UNPACK_BUFFER,
        previousPixelUnpackBuffer
      );
      requireCleanWebGLState(
        gl,
        `${owner} unpack-state restoration`
      );
    } catch (error) {
      restorationError = error;
    }

    if (operationError && restorationError) {
      throw new AggregateError(
        [operationError, restorationError],
        `${owner} failed and could not restore exact WebGL unpack state.`
      );
    }
    if (operationError) throw operationError;
    if (restorationError) throw restorationError;
    return value;
  }

  _createPrograms() {
    console.log('[HighPerfRenderer] Creating WebGL2 shader programs');
    const candidatePrograms = {
      full: null,
      light: null,
      ultralight: null,
    };
    const candidateUniformLocations = new Map();
    try {
      candidatePrograms.full =
        this._createProgram(HP_VS_FULL, HP_FS_FULL, 'full');
      candidatePrograms.light =
        this._createProgram(HP_VS_LIGHT, HP_FS_LIGHT, 'light');
      candidatePrograms.ultralight =
        this._createProgram(
          HP_VS_LIGHT,
          HP_FS_ULTRALIGHT,
          'ultralight'
        );

      for (
        const [name, program] of
        Object.entries(candidatePrograms)
      ) {
        this._cacheUniformLocations(
          name,
          program,
          candidateUniformLocations
        );
      }

      // Create dummy 1x1 R32UI texture for usampler2D when LOD index texture is not used
      // This prevents "Two textures of different types use the same sampler location" error
      this._createDummyLodIndexTexture();
    } catch (error) {
      this._queueProgramRetirement(
        Object.values(candidatePrograms)
      );
      const cleanupFailures = this._drainProgramRetirements();
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          `HighPerfRenderer shader setup failed with ${cleanupFailures.length} cleanup error(s).`
        );
      }
      throw error;
    }

    this.programs = candidatePrograms;
    this.uniformLocations = candidateUniformLocations;
    console.log(
      '[HighPerfRenderer] Created programs:',
      Object.keys(this.programs)
    );
  }

  /**
   * Create a dummy 1x1 R32UI texture to bind when LOD index texture is not in use.
   * Required because usampler2D uniforms must have a valid unsigned integer texture bound,
   * even when the shader doesn't use it (u_useLodIndexTex = false).
   * @private
   */
  _createDummyLodIndexTexture() {
    const gl = this.gl;
    const previousTexture = this._dummyLodIndexTexture;
    const previousByteLength =
      Number.isSafeInteger(this._dummyLodIndexTextureByteLength)
        ? this._dummyLodIndexTextureByteLength
        : (
          previousTexture
            ? Uint32Array.BYTES_PER_ELEMENT
            : 0
        );
    const candidateTexture = gl.createTexture();
    if (!candidateTexture) {
      throw new Error('HighPerfRenderer could not allocate the required LOD index texture.');
    }
    let candidateByteLength = 0;
    try {
      gl.bindTexture(gl.TEXTURE_2D, candidateTexture);

      // Create 1x1 R32UI texture with a dummy value.
      const dummyData = new Uint32Array([0]);
      this._withNeutralTextureUnpackState(
        4,
        'HighPerfRenderer candidate dummy LOD texture',
        () => {
          gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.R32UI,
            1, 1, 0,
            gl.RED_INTEGER, gl.UNSIGNED_INT, dummyData
          );
          requireCleanWebGLState(
            gl,
            'HighPerfRenderer candidate dummy LOD texture upload'
          );
        }
      );
      candidateByteLength = dummyData.byteLength;

      // Set filtering to NEAREST (required for integer textures).
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        gl.NEAREST
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MAG_FILTER,
        gl.NEAREST
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_S,
        gl.CLAMP_TO_EDGE
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_T,
        gl.CLAMP_TO_EDGE
      );
      gl.bindTexture(gl.TEXTURE_2D, null);
      requireCleanWebGLState(
        gl,
        'HighPerfRenderer dummy LOD texture publication'
      );
    } catch (error) {
      try {
        gl.bindTexture(gl.TEXTURE_2D, null);
      } catch {
        // The retirement journal below remains authoritative.
      }
      this._queueDataRetirement({
        dummyLodIndexTexture: candidateTexture,
        dummyLodIndexTextureByteLength: candidateByteLength,
      });
      const cleanupFailures = this._drainDataRetirements();
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          `HighPerfRenderer dummy LOD texture publication failed with ${cleanupFailures.length} cleanup error(s).`
        );
      }
      throw error;
    }

    this._dummyLodIndexTexture = candidateTexture;
    this._dummyLodIndexTextureByteLength = candidateByteLength;
    if (previousTexture && previousTexture !== candidateTexture) {
      this._queueDataRetirement({
        dummyLodIndexTexture: previousTexture,
        dummyLodIndexTextureByteLength: previousByteLength,
      });
      this._drainDataRetirements();
    }
    this._refreshGpuMemoryStats();
  }

  _createProgram(vsSource, fsSource, name) {
    const gl = this.gl;
    requireShaderQuality(name, 'HighPerfRenderer shader program name');
    let vertexShader = null;
    let fragmentShader = null;
    let program = null;
    let operationError = null;
    try {
      vertexShader = gl.createShader(gl.VERTEX_SHADER);
      if (!vertexShader) {
        throw new Error(
          `HighPerfRenderer could not allocate the "${name}" vertex shader.`
        );
      }
      gl.shaderSource(vertexShader, vsSource);
      gl.compileShader(vertexShader);
      if (
        !gl.getShaderParameter(
          vertexShader,
          gl.COMPILE_STATUS
        )
      ) {
        const detail =
          gl.getShaderInfoLog(vertexShader) ||
          'no compiler diagnostic';
        throw new Error(
          `HighPerfRenderer "${name}" vertex shader compilation failed: ${detail}`
        );
      }

      fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
      if (!fragmentShader) {
        throw new Error(
          `HighPerfRenderer could not allocate the "${name}" fragment shader.`
        );
      }
      gl.shaderSource(fragmentShader, fsSource);
      gl.compileShader(fragmentShader);
      if (
        !gl.getShaderParameter(
          fragmentShader,
          gl.COMPILE_STATUS
        )
      ) {
        const detail =
          gl.getShaderInfoLog(fragmentShader) ||
          'no compiler diagnostic';
        throw new Error(
          `HighPerfRenderer "${name}" fragment shader compilation failed: ${detail}`
        );
      }

      program = gl.createProgram();
      if (!program) {
        throw new Error(
          `HighPerfRenderer could not allocate the "${name}" shader program.`
        );
      }
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const detail =
          gl.getProgramInfoLog(program) ||
          'no linker diagnostic';
        throw new Error(
          `HighPerfRenderer "${name}" shader link failed: ${detail}`
        );
      }
    } catch (error) {
      operationError = error;
    }

    this._queueShaderRetirement([
      vertexShader,
      fragmentShader,
    ]);
    const shaderCleanupFailures =
      this._drainShaderRetirements();

    if (operationError || shaderCleanupFailures.length > 0) {
      this._queueProgramRetirement([program]);
      const programCleanupFailures =
        this._drainProgramRetirements();
      const cleanupFailures = [
        ...shaderCleanupFailures,
        ...programCleanupFailures,
      ];
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          operationError
            ? [operationError, ...cleanupFailures]
            : cleanupFailures,
          `HighPerfRenderer "${name}" shader program setup failed with ${cleanupFailures.length} cleanup error(s).`
        );
      }
      throw operationError;
    }

    return program;
  }

  _cacheUniformLocations(
    programName,
    program,
    target = this.uniformLocations
  ) {
    const gl = this.gl;
    const uniforms = {};

    const uniformNames = [
      'u_mvpMatrix', 'u_viewMatrix', 'u_modelMatrix', 'u_projectionMatrix',
      'u_pointSize', 'u_sizeAttenuation', 'u_viewportHeight', 'u_fov',
      'u_lightingStrength', 'u_fogDensity', 'u_fogNear', 'u_fogFar',
      'u_fogColor', 'u_lightDir',
      // Alpha texture uniforms for efficient alpha-only updates
      'u_alphaTex', 'u_alphaTexWidth', 'u_invAlphaTexWidth', 'u_useAlphaTex',
      // LOD index texture uniforms (for mapping LOD vertex to original index)
      'u_lodIndexTex', 'u_lodIndexTexWidth', 'u_invLodIndexTexWidth', 'u_useLodIndexTex'
    ];

    for (const name of uniformNames) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }

    target.set(programName, uniforms);
    return uniforms;
  }

  setQuality(quality) {
    this._assertOperational('set shader quality');
    const exactQuality = requireShaderQuality(quality);
    const program = this.programs[exactQuality];
    if (!program) {
      throw new Error(`HighPerfRenderer "${exactQuality}" shader program is unavailable.`);
    }
    this.activeQuality = exactQuality;
    this.activeProgram = program;
    this.gl.useProgram(program);
  }

  _ensureLodResourceOwnershipState() {
    if (!(this._lodResourceOwnersByDimension instanceof Map)) {
      this._lodResourceOwnersByDimension = new Map();
    }
    if (!(this._validatedLodNodeMappings instanceof WeakMap)) {
      this._validatedLodNodeMappings = new WeakMap();
    }
    if (!(this._validatedSpatialIndices instanceof WeakSet)) {
      this._validatedSpatialIndices = new WeakSet();
    }
  }

  _refreshGpuMemoryStats() {
    if (!this.stats) return 0;
    this._ensureLodResourceOwnershipState();
    this._ensureRetirementOwnershipState();

    // Resource metadata contains several deliberate aliases (per-level LOD
    // projections, borrowed topology, pending journals). Inventory by exact
    // WebGL handle so each known logical store is counted once.
    const allocations = new Map();
    const add = (handle, byteLength) => {
      if (
        !handle ||
        !Number.isSafeInteger(byteLength) ||
        byteLength <= 0
      ) {
        return;
      }
      const current = allocations.get(handle) ?? 0;
      if (byteLength > current) allocations.set(handle, byteLength);
    };
    const knownOrDerived = (exact, derived) => (
      Number.isSafeInteger(exact) && exact >= 0
        ? exact
        : derived
    );

    add(
      this.buffers?.interleaved,
      knownOrDerived(
        this._interleavedGpuByteLength,
        Number.isSafeInteger(this.pointCount) && this.pointCount > 0
          ? this.pointCount * 16
          : 0
      )
    );
    add(
      this._alphaTexture,
      knownOrDerived(
        this._alphaTextureByteLength,
        (
          Number.isInteger(this._alphaTexWidth) &&
          this._alphaTexWidth > 0 &&
          Number.isInteger(this._alphaTexHeight) &&
          this._alphaTexHeight > 0
        )
          ? this._alphaTexWidth * this._alphaTexHeight
          : 0
      )
    );
    add(
      this._dummyLodIndexTexture,
      knownOrDerived(
        this._dummyLodIndexTextureByteLength,
        this._dummyLodIndexTexture ? Uint32Array.BYTES_PER_ELEMENT : 0
      )
    );

    for (const owner of this._lodResourceOwnersByDimension.values()) {
      if (
        !Number.isSafeInteger(owner?.gpuByteLength) ||
        owner.gpuByteLength < 0
      ) {
        throw new Error(
          'HighPerfRenderer LOD generation owner has invalid GPU byte accounting.'
        );
      }
      let projectedBytes = 0;
      add(owner.compactBuffer, owner.compactByteLength);
      if (owner.compactBuffer) {
        projectedBytes += Number.isSafeInteger(owner.compactByteLength)
          ? Math.max(0, owner.compactByteLength)
          : 0;
      }
      add(
        owner.topologyOwner?.originalIndexBuffer,
        owner.topologyOwner?.originalIndexByteLength
      );
      if (owner.topologyOwner?.originalIndexBuffer) {
        projectedBytes += Number.isSafeInteger(
          owner.topologyOwner?.originalIndexByteLength
        )
          ? Math.max(0, owner.topologyOwner.originalIndexByteLength)
          : 0;
      }
      add(
        owner.topologyOwner?.indexTexture,
        owner.topologyOwner?.indexTextureByteLength
      );
      if (owner.topologyOwner?.indexTexture) {
        projectedBytes += Number.isSafeInteger(
          owner.topologyOwner?.indexTextureByteLength
        )
          ? Math.max(0, owner.topologyOwner.indexTextureByteLength)
          : 0;
      }
      // Compatibility for an older publication that recorded only the exact
      // aggregate. Current owners always project every component handle.
      if (owner.gpuByteLength > projectedBytes) {
        add(owner, owner.gpuByteLength - projectedBytes);
      }
    }

    if (this.snapshotBuffers instanceof Map) {
      for (const snapshot of this.snapshotBuffers.values()) {
        add(
          snapshot?.colorOwner?.buffer ?? snapshot?.buffer,
          knownOrDerived(
            snapshot?.colorOwner?.byteLength ??
              snapshot?.bufferByteLength,
            Number.isSafeInteger(snapshot?.pointCount)
              ? Math.max(0, snapshot.pointCount) * 3
              : 0
          )
        );
        add(
          snapshot?.alphaTexture,
          knownOrDerived(
            snapshot?.alphaTextureByteLength,
            Number.isSafeInteger(snapshot?.pointCount)
              ? Math.max(0, snapshot.pointCount)
              : 0
          )
        );
      }
    }
    if (this._snapshotGeometryPools instanceof Map) {
      for (const geometry of this._snapshotGeometryPools.values()) {
        add(
          geometry?.positionBuffer,
          knownOrDerived(
            geometry?.positionBufferByteLength,
            geometry?.positions instanceof Float32Array
              ? geometry.positions.byteLength
              : 0
          )
        );
      }
    }
    if (this._perViewState instanceof Map) {
      for (const viewState of this._perViewState.values()) {
        add(
          viewState?.indexBuffer,
          knownOrDerived(
            viewState?.indexBufferByteLength,
            Number.isSafeInteger(viewState?.indexBufferSize)
              ? Math.max(0, viewState.indexBufferSize) *
                Uint32Array.BYTES_PER_ELEMENT
              : 0
          )
        );
      }
    }
    for (const retirement of this._pendingDataRetirements) {
      for (
        const entries of
        [retirement.buffers ?? [], retirement.textures ?? []]
      ) {
        for (const entry of entries) {
          add(entry?.handle, entry?.byteLength);
        }
      }
    }
    for (const retirement of this._pendingSnapshotRetirements) {
      add(
        retirement?.colorOwner?.buffer ?? retirement?.buffer,
        retirement?.colorOwner?.byteLength ??
          retirement?.bufferByteLength
      );
      add(
        retirement?.alphaTexture,
        retirement?.alphaTextureByteLength
      );
      add(
        retirement?.positionBuffer,
        retirement?.positionBufferByteLength
      );
    }

    let bytes = 0;
    for (const byteLength of allocations.values()) {
      bytes += byteLength;
    }
    this.stats.gpuMemoryMB = bytes / (1024 * 1024);
    return bytes;
  }

  _captureDataPublication() {
    this._ensureLodResourceOwnershipState();
    return {
      vao: this.vao,
      buffers: this.buffers,
      interleavedGpuByteLength: this._interleavedGpuByteLength,
      alphaTexture: this._alphaTexture,
      alphaTextureByteLength: this._alphaTextureByteLength,
      alphaTexWidth: this._alphaTexWidth,
      alphaTexHeight: this._alphaTexHeight,
      alphaTexData: this._alphaTexData,
      alphaTexStagingData: this._alphaTexStagingData,
      useAlphaTexture: this._useAlphaTexture,
      currentAlphas: this._currentAlphas,
      lodIndexTexturesByDimension: this._lodIndexTexturesByDimension,
      lodResourceOwnersByDimension:
        this._lodResourceOwnersByDimension,
      spatialIndices: this.spatialIndices,
      lodBuffersByDimension: this.lodBuffersByDimension,
      perViewState: this._perViewState,
      currentDimensionLevel: this.currentDimensionLevel,
      liveGeometryGeneration: this._liveGeometryGeneration,
      pointCount: this.pointCount,
      positions: this._positions,
      colors: this._colors,
      firstRenderDone: this._firstRenderDone,
      boundingSphere: this._boundingSphere,
      bufferDirty: this._bufferDirty,
      dirtyLodDimensions: this._dirtyLodDimensions,
      interleavedArrayBuffer: this._interleavedArrayBuffer,
      interleavedPositionView: this._interleavedPositionView,
      interleavedColorView: this._interleavedColorView,
      gpuMemoryMB: this.stats.gpuMemoryMB,
    };
  }

  _installCandidateDataPublication(previous) {
    const candidateVao = this.gl.createVertexArray();
    if (!candidateVao) {
      throw new Error(
        'HighPerfRenderer could not allocate the candidate data vertex array.'
      );
    }
    this.vao = candidateVao;
    this.buffers = {
      interleaved: null,
      positions: null,
      colors: null,
      alphas: null,
    };
    this._interleavedGpuByteLength = 0;
    this._alphaTexture = null;
    this._alphaTextureByteLength = 0;
    this._alphaTexWidth = 0;
    this._alphaTexHeight = 0;
    this._alphaTexData = null;
    this._alphaTexStagingData = null;
    this._useAlphaTexture = false;
    this._currentAlphas = null;
    this._lodIndexTexturesByDimension = new Map();
    this._lodResourceOwnersByDimension = new Map();
    this.spatialIndices = new Map();
    this.lodBuffersByDimension = new Map();
    this._perViewState = new Map();
    this.currentDimensionLevel = 3;
    this._liveGeometryGeneration = 0;
    this.pointCount = 0;
    this._positions = null;
    this._colors = null;
    this._firstRenderDone = false;
    this._boundingSphere = null;
    this._bufferDirty = false;
    this._dirtyLodDimensions = new Set();
    this._validatedLodNodeMappings = new WeakMap();
    this._validatedSpatialIndices = new WeakSet();

    // Reusing the CPU packing allocation avoids a second 16-byte-per-point
    // allocation on same-size reloads. If publication fails, the restored
    // renderer drops this cache because its bytes may have been overwritten.
    this._interleavedArrayBuffer = previous.interleavedArrayBuffer;
    this._interleavedPositionView = previous.interleavedPositionView;
    this._interleavedColorView = previous.interleavedColorView;
  }

  _restoreDataPublication(publication, { invalidateInterleavedCache = false } = {}) {
    this.vao = publication.vao;
    this.buffers = publication.buffers;
    this._interleavedGpuByteLength =
      publication.interleavedGpuByteLength ?? 0;
    this._alphaTexture = publication.alphaTexture;
    this._alphaTextureByteLength =
      publication.alphaTextureByteLength ?? 0;
    this._alphaTexWidth = publication.alphaTexWidth;
    this._alphaTexHeight = publication.alphaTexHeight;
    this._alphaTexData = publication.alphaTexData;
    this._alphaTexStagingData =
      publication.alphaTexStagingData ?? null;
    this._useAlphaTexture = publication.useAlphaTexture;
    this._currentAlphas = publication.currentAlphas;
    this._lodIndexTexturesByDimension =
      publication.lodIndexTexturesByDimension;
    this._lodResourceOwnersByDimension =
      publication.lodResourceOwnersByDimension ?? new Map();
    this.spatialIndices = publication.spatialIndices;
    this.lodBuffersByDimension = publication.lodBuffersByDimension;
    this._perViewState = publication.perViewState;
    this.currentDimensionLevel = publication.currentDimensionLevel;
    this._liveGeometryGeneration =
      publication.liveGeometryGeneration;
    this.pointCount = publication.pointCount;
    this._positions = publication.positions;
    this._colors = publication.colors;
    this._firstRenderDone = publication.firstRenderDone;
    this._boundingSphere = publication.boundingSphere;
    this._bufferDirty = publication.bufferDirty;
    this._dirtyLodDimensions = publication.dirtyLodDimensions;
    this._interleavedArrayBuffer = invalidateInterleavedCache
      ? null
      : publication.interleavedArrayBuffer;
    this._interleavedPositionView = invalidateInterleavedCache
      ? null
      : publication.interleavedPositionView;
    this._interleavedColorView = invalidateInterleavedCache
      ? null
      : publication.interleavedColorView;
    this.stats.gpuMemoryMB = publication.gpuMemoryMB;
  }

  _ensureRetirementOwnershipState() {
    if (!(this._pendingSnapshotRetirements instanceof Set)) {
      this._pendingSnapshotRetirements = new Set();
    }
    if (!(this._pendingDataRetirements instanceof Set)) {
      this._pendingDataRetirements = new Set();
    }
    if (!(this._pendingProgramRetirements instanceof Set)) {
      this._pendingProgramRetirements = new Set();
    }
    if (!(this._pendingShaderRetirements instanceof Set)) {
      this._pendingShaderRetirements = new Set();
    }
    if (typeof this._pendingProgramUnbind !== 'boolean') {
      this._pendingProgramUnbind = false;
    }
  }

  _attemptProgramUnbind() {
    this._ensureRetirementOwnershipState();
    if (!this._pendingProgramUnbind) return null;
    const gl = this.gl;
    try {
      gl.useProgram(null);
      this._pendingProgramUnbind = false;
      return null;
    } catch (error) {
      if (
        Number.isInteger(gl.CURRENT_PROGRAM) &&
        typeof gl.getParameter === 'function'
      ) {
        try {
          if (gl.getParameter(gl.CURRENT_PROGRAM) === null) {
            this._pendingProgramUnbind = false;
            return null;
          }
        } catch {
          // Without an exact binding proof the unbind remains retryable.
        }
      }
      return error;
    }
  }

  _markProgramUnbindIfOwned(programs) {
    this._ensureRetirementOwnershipState();
    if (this._pendingProgramUnbind) return;
    const ownedPrograms = new Set(
      (programs ?? []).filter(Boolean)
    );
    if (ownedPrograms.size === 0) return;

    const gl = this.gl;
    if (
      Number.isInteger(gl.CURRENT_PROGRAM) &&
      typeof gl.getParameter === 'function'
    ) {
      try {
        this._pendingProgramUnbind = ownedPrograms.has(
          gl.getParameter(gl.CURRENT_PROGRAM)
        );
        return;
      } catch {
        // Consult renderer-owned semantic state below.
      }
    }
    this._pendingProgramUnbind = ownedPrograms.has(
      this.activeProgram
    );
  }

  _queueShaderRetirement(shaders) {
    this._ensureRetirementOwnershipState();
    const alreadyOwned = new Set();
    for (const retirement of this._pendingShaderRetirements) {
      for (const entry of retirement.shaders) {
        if (entry.handle !== null) alreadyOwned.add(entry.handle);
      }
    }
    const entries = [];
    for (const shader of shaders ?? []) {
      if (!shader || alreadyOwned.has(shader)) continue;
      alreadyOwned.add(shader);
      entries.push({ handle: shader });
    }
    if (entries.length > 0) {
      this._pendingShaderRetirements.add({
        shaders: entries,
      });
    }
  }

  _drainShaderRetirements() {
    this._ensureRetirementOwnershipState();
    const failures = [];
    const gl = this.gl;
    for (
      const retirement of
      Array.from(this._pendingShaderRetirements)
    ) {
      for (const entry of retirement.shaders) {
        const shader = entry.handle;
        if (shader === null) continue;
        try {
          gl.deleteShader(shader);
          entry.handle = null;
        } catch (error) {
          let stillAlive = true;
          if (typeof gl.isShader === 'function') {
            try {
              stillAlive = gl.isShader(shader);
            } catch {
              stillAlive = true;
            }
          }
          if (stillAlive) {
            failures.push(error);
          } else {
            entry.handle = null;
          }
        }
      }
      if (
        retirement.shaders.every(
          entry => entry.handle === null
        )
      ) {
        this._pendingShaderRetirements.delete(retirement);
      }
    }
    return failures;
  }

  _queueProgramRetirement(programs) {
    this._ensureRetirementOwnershipState();
    const alreadyOwned = new Set();
    for (const retirement of this._pendingProgramRetirements) {
      for (const entry of retirement.programs) {
        if (entry.handle !== null) alreadyOwned.add(entry.handle);
      }
    }
    const entries = [];
    for (const program of programs ?? []) {
      if (!program || alreadyOwned.has(program)) continue;
      alreadyOwned.add(program);
      entries.push({ handle: program });
    }
    if (entries.length > 0) {
      this._pendingProgramRetirements.add({
        programs: entries,
      });
    }
  }

  _drainProgramRetirements() {
    this._ensureRetirementOwnershipState();
    const failures = [];
    const gl = this.gl;
    for (
      const retirement of
      Array.from(this._pendingProgramRetirements)
    ) {
      for (const entry of retirement.programs) {
        const program = entry.handle;
        if (program === null) continue;
        try {
          gl.deleteProgram(program);
          entry.handle = null;
        } catch (error) {
          let stillAlive = true;
          if (typeof gl.isProgram === 'function') {
            try {
              stillAlive = gl.isProgram(program);
            } catch {
              stillAlive = true;
            }
          }
          if (stillAlive) {
            failures.push(error);
          } else {
            entry.handle = null;
          }
        }
      }
      if (
        retirement.programs.every(
          entry => entry.handle === null
        )
      ) {
        this._pendingProgramRetirements.delete(retirement);
      }
    }
    return failures;
  }

  _createDataRetirement(publication) {
    const buffers = new Map();
    const vertexArrays = new Map();
    const textures = new Map();
    const add = (target, handle, byteLength = 0) => {
      if (!handle) return;
      const exactBytes =
        Number.isSafeInteger(byteLength) && byteLength > 0
          ? byteLength
          : 0;
      const existing = target.get(handle);
      if (existing === undefined || exactBytes > existing) {
        target.set(handle, exactBytes);
      }
    };

    for (const buffer of Object.values(publication.buffers ?? {})) {
      add(
        buffers,
        buffer,
        buffer === publication.buffers?.interleaved
          ? (
            Number.isSafeInteger(
              publication.interleavedGpuByteLength
            )
              ? publication.interleavedGpuByteLength
              : (publication.pointCount ?? 0) * 16
          )
          : 0
      );
    }
    add(vertexArrays, publication.vao);
    if (publication.perViewState instanceof Map) {
      for (const viewState of publication.perViewState.values()) {
        add(
          buffers,
          viewState.indexBuffer,
          Number.isSafeInteger(viewState.indexBufferByteLength)
            ? viewState.indexBufferByteLength
            : (viewState.indexBufferSize ?? 0) *
              Uint32Array.BYTES_PER_ELEMENT
        );
      }
    }
    if (publication.lodResourceOwnersByDimension instanceof Map) {
      for (
        const owner of
        publication.lodResourceOwnersByDimension.values()
      ) {
        add(buffers, owner.compactBuffer, owner.compactByteLength);
        add(vertexArrays, owner.compactVao);
        add(
          buffers,
          owner.topologyOwner?.originalIndexBuffer,
          owner.topologyOwner?.originalIndexByteLength
        );
        add(
          textures,
          owner.topologyOwner?.indexTexture,
          owner.topologyOwner?.indexTextureByteLength
        );
      }
    }
    if (publication.lodBuffersByDimension instanceof Map) {
      // Metadata is non-owning for current publications, but remains a
      // deduplicated compatibility inventory for publications created before
      // explicit generation owners existed. Full detail always borrows main
      // vertex data and must never enter LOD retirement.
      for (const lodBuffers of publication.lodBuffersByDimension.values()) {
        for (const lod of lodBuffers) {
          if (lod.isFullDetail !== true) {
            add(buffers, lod.buffer);
            add(vertexArrays, lod.vao);
          }
          // Current full-detail metadata has no EBO. Owner-map-free
          // publications may still carry a sequential EBO even though their
          // VBO/VAO borrow main data, so retain that deduplicated inventory.
          add(buffers, lod.originalIndexBuffer);
        }
      }
    }
    if (publication.lodIndexTexturesByDimension instanceof Map) {
      for (
        const lodIndexTextures of
        publication.lodIndexTexturesByDimension.values()
      ) {
        for (const entry of lodIndexTextures) {
          add(textures, entry.texture);
        }
      }
    }
    add(
      textures,
      publication.alphaTexture,
      Number.isSafeInteger(publication.alphaTextureByteLength)
        ? publication.alphaTextureByteLength
        : (publication.alphaTexWidth ?? 0) *
          (publication.alphaTexHeight ?? 0)
    );
    add(
      textures,
      publication.dummyLodIndexTexture,
      Number.isSafeInteger(
        publication.dummyLodIndexTextureByteLength
      )
        ? publication.dummyLodIndexTextureByteLength
        : (
          publication.dummyLodIndexTexture
            ? Uint32Array.BYTES_PER_ELEMENT
            : 0
        )
    );

    return {
      buffers: Array.from(
        buffers,
        ([handle, byteLength]) => ({ handle, byteLength })
      ),
      textures: Array.from(
        textures,
        ([handle, byteLength]) => ({ handle, byteLength })
      ),
      vertexArrays: Array.from(
        vertexArrays,
        ([handle]) => ({ handle, byteLength: 0 })
      ),
    };
  }

  _queueDataRetirement(publication) {
    this._ensureRetirementOwnershipState();
    const retirement = this._createDataRetirement(publication);
    const ownedBuffers = new Map();
    const ownedVertexArrays = new Map();
    const ownedTextures = new Map();
    for (const pending of this._pendingDataRetirements) {
      for (const entry of pending.buffers) {
        if (entry.handle !== null) ownedBuffers.set(entry.handle, entry);
      }
      for (const entry of pending.vertexArrays) {
        if (entry.handle !== null) {
          ownedVertexArrays.set(entry.handle, entry);
        }
      }
      for (const entry of pending.textures) {
        if (entry.handle !== null) ownedTextures.set(entry.handle, entry);
      }
    }
    const dedupe = (entries, owned) => entries.filter(entry => {
      const existing = owned.get(entry.handle);
      if (existing === undefined) return true;
      if (entry.byteLength > existing.byteLength) {
        existing.byteLength = entry.byteLength;
      }
      return false;
    });
    retirement.buffers = dedupe(retirement.buffers, ownedBuffers);
    retirement.vertexArrays =
      dedupe(retirement.vertexArrays, ownedVertexArrays);
    retirement.textures = dedupe(retirement.textures, ownedTextures);
    if (
      retirement.buffers.length > 0 ||
      retirement.vertexArrays.length > 0 ||
      retirement.textures.length > 0
    ) {
      this._pendingDataRetirements.add(retirement);
    }
    this._refreshGpuMemoryStats();
    return retirement;
  }

  _drainDataRetirements() {
    this._ensureRetirementOwnershipState();
    const failures = [];
    const gl = this.gl;
    const drainEntries = (
      entries,
      deleteMethod,
      livenessMethod
    ) => {
      for (const entry of entries) {
        const handle = entry.handle;
        if (handle === null) continue;
        try {
          gl[deleteMethod](handle);
          entry.handle = null;
        } catch (error) {
          let stillAlive = true;
          if (typeof gl[livenessMethod] === 'function') {
            try {
              stillAlive = gl[livenessMethod](handle);
            } catch {
              stillAlive = true;
            }
          }
          if (stillAlive) {
            failures.push(error);
          } else {
            entry.handle = null;
          }
        }
      }
    };
    for (const retirement of Array.from(this._pendingDataRetirements)) {
      drainEntries(
        retirement.vertexArrays,
        'deleteVertexArray',
        'isVertexArray'
      );
      // VAOs retain buffer references, including their element-array binding.
      // Delete vertex state first so a retired buffer cannot remain reachable
      // through a still-live VAO on implementations with deferred destruction.
      drainEntries(retirement.buffers, 'deleteBuffer', 'isBuffer');
      drainEntries(retirement.textures, 'deleteTexture', 'isTexture');
      if (
        retirement.buffers.every(entry => entry.handle === null) &&
        retirement.vertexArrays.every(entry => entry.handle === null) &&
        retirement.textures.every(entry => entry.handle === null)
      ) {
        this._pendingDataRetirements.delete(retirement);
      }
    }
    this._refreshGpuMemoryStats();
    return failures;
  }

  _retireDataPublication(publication) {
    this._queueDataRetirement(publication);
    return this._drainDataRetirements();
  }

  _ensureGeometryOwnershipState() {
    if (!(this._snapshotGeometryPools instanceof Map)) {
      this._snapshotGeometryPools = new Map();
    }
    if (
      !Number.isSafeInteger(this._liveGeometryGeneration) ||
      this._liveGeometryGeneration < 0
    ) {
      this._liveGeometryGeneration = 0;
    }
    if (
      !Number.isSafeInteger(this._nextGeometryGeneration) ||
      this._nextGeometryGeneration <= this._liveGeometryGeneration
    ) {
      let maxGeneration = this._liveGeometryGeneration;
      for (const generation of this._snapshotGeometryPools.keys()) {
        if (
          Number.isSafeInteger(generation) &&
          generation > maxGeneration
        ) {
          maxGeneration = generation;
        }
      }
      this._nextGeometryGeneration = maxGeneration + 1;
    }
  }

  _allocateGeometryGeneration() {
    this._ensureGeometryOwnershipState();
    const generation = this._nextGeometryGeneration;
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new RangeError(
        'HighPerfRenderer exhausted exact geometry publication generations.'
      );
    }
    this._nextGeometryGeneration += 1;
    return generation;
  }

  _snapshotUsesLiveGeometry(snapshot) {
    return (
      snapshot !== null &&
      typeof snapshot === 'object' &&
      Number.isSafeInteger(snapshot.geometryGeneration) &&
      snapshot.geometryGeneration > 0 &&
      snapshot.geometryGeneration === this._liveGeometryGeneration
    );
  }

  _ensureSnapshotGeometryGpuOwner(geometry) {
    if (!geometry || !(geometry.positions instanceof Float32Array)) {
      throw new Error(
        'HighPerfRenderer snapshot geometry has no exact Float32 position owner.'
      );
    }
    // Normalize pre-split records defensively. Renderer-created records always
    // publish both fields together, but this keeps an already-live instance
    // upgradeable without inventing a second geometry generation.
    if (!Object.hasOwn(geometry, 'positionBuffer')) {
      geometry.positionBuffer = null;
    }
    if (!Object.hasOwn(geometry, 'positionBufferByteLength')) {
      geometry.positionBufferByteLength =
        geometry.positionBuffer === null
          ? 0
          : geometry.positions.byteLength;
    }
    if (
      geometry.positionBuffer === null
        ? geometry.positionBufferByteLength !== 0
        : (
          !Number.isSafeInteger(geometry.positionBufferByteLength) ||
          geometry.positionBufferByteLength !==
            geometry.positions.byteLength
        )
    ) {
      throw new Error(
        `HighPerfRenderer snapshot geometry generation ${geometry.generation} has invalid position-buffer ownership.`
      );
    }
    return geometry;
  }

  _ensureSnapshotGeometryPositionBuffer(
    geometry,
    owner,
    staging
  ) {
    this._ensureSnapshotGeometryGpuOwner(geometry);
    if (
      !staging ||
      staging.positionBuffer !== null ||
      staging.positionBufferByteLength !== 0
    ) {
      throw new Error(
        `${owner} received a non-empty position-buffer staging owner.`
      );
    }
    if (geometry.positionBuffer !== null) {
      return geometry.positionBuffer;
    }

    requireCleanWebGLState(
      this.gl,
      `${owner} position-buffer publication`
    );
    const positionBuffer = this.gl.createBuffer();
    if (!positionBuffer) {
      throw new Error(
        `${owner} could not allocate its shared position buffer.`
      );
    }
    staging.positionBuffer = positionBuffer;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      geometry.positions,
      this.gl.STATIC_DRAW
    );
    requireCleanWebGLState(
      this.gl,
      `${owner} position-buffer upload`
    );
    staging.positionBufferByteLength =
      geometry.positions.byteLength;

    // Publish only after allocation, upload, and the exact GL error fence all
    // succeed. From this point the geometry pool, rather than the staging
    // record, is the sole owner of the handle.
    geometry.positionBuffer = positionBuffer;
    geometry.positionBufferByteLength =
      staging.positionBufferByteLength;
    staging.positionBuffer = null;
    staging.positionBufferByteLength = 0;
    return positionBuffer;
  }

  _acquireSnapshotGeometryFromSource(sourceViewId, sourcePositions) {
    this._ensureGeometryOwnershipState();
    const exactSourceViewId = requireViewId(
      sourceViewId,
      'HighPerfRenderer snapshot source viewId'
    );
    let generation;
    let expectedPositions;
    const sourceIsLive = exactSourceViewId === 'live';
    if (sourceIsLive) {
      generation = this._liveGeometryGeneration;
      expectedPositions = this._positions;
      if (!Number.isSafeInteger(generation) || generation <= 0) {
        throw new Error(
          'HighPerfRenderer live geometry has no published generation.'
        );
      }
    } else {
      const sourceSnapshot =
        this.snapshotBuffers.get(exactSourceViewId);
      if (!sourceSnapshot) {
        throw new RangeError(
          `HighPerfRenderer snapshot source "${exactSourceViewId}" does not exist.`
        );
      }
      generation = sourceSnapshot.geometryGeneration;
      expectedPositions = sourceSnapshot.positions;
    }
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error(
        `HighPerfRenderer snapshot source "${exactSourceViewId}" has no exact geometry generation.`
      );
    }
    if (sourcePositions !== expectedPositions) {
      throw new Error(
        `HighPerfRenderer snapshot source "${exactSourceViewId}" positions do not match its published geometry owner.`
      );
    }

    let geometry = this._snapshotGeometryPools.get(generation);
    if (geometry === undefined) {
      if (!sourceIsLive) {
        throw new Error(
          `HighPerfRenderer snapshot source "${exactSourceViewId}" has no owned frozen geometry.`
        );
      }
      geometry = {
        generation,
        positions: new Float32Array(sourcePositions),
        positionBuffer: null,
        positionBufferByteLength: 0,
        refCount: 0,
        spatialIndices: new Map(),
      };
      this._snapshotGeometryPools.set(generation, geometry);
    } else if (
      geometry.positions.length !== sourcePositions.length ||
      (!sourceIsLive && geometry.positions !== sourcePositions) ||
      !Number.isSafeInteger(geometry.refCount) ||
      geometry.refCount < 0
    ) {
      throw new Error(
        `HighPerfRenderer snapshot geometry generation ${generation} is inconsistent.`
      );
    }
    this._ensureSnapshotGeometryGpuOwner(geometry);
    geometry.refCount += 1;
    return geometry;
  }

  _acquireIndependentSnapshotGeometry(sourcePositions) {
    this._ensureGeometryOwnershipState();
    const generation = this._allocateGeometryGeneration();
    const geometry = {
      generation,
      positions: new Float32Array(sourcePositions),
      positionBuffer: null,
      positionBufferByteLength: 0,
      refCount: 1,
      spatialIndices: new Map(),
    };
    this._snapshotGeometryPools.set(generation, geometry);
    return geometry;
  }

  _getSnapshotGeometryRecord(
    geometryGeneration,
    positions
  ) {
    this._ensureGeometryOwnershipState();
    const geometry =
      this._snapshotGeometryPools.get(geometryGeneration);
    if (
      geometry === undefined ||
      geometry.positions !== positions ||
      !Number.isSafeInteger(geometry.refCount) ||
      geometry.refCount <= 0
    ) {
      throw new Error(
        `HighPerfRenderer snapshot geometry generation ${geometryGeneration} has invalid spatial ownership.`
      );
    }
    this._ensureSnapshotGeometryGpuOwner(geometry);
    if (!(geometry.spatialIndices instanceof Map)) {
      geometry.spatialIndices = new Map();
    }
    return geometry;
  }

  _snapshotSpatialIndexKey(dimensionLevel, needsLOD) {
    const dimension = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer snapshot spatial-pool dimensionLevel'
    );
    if (typeof needsLOD !== 'boolean') {
      throw new TypeError(
        'HighPerfRenderer snapshot spatial-pool needsLOD must be a boolean.'
      );
    }
    // One geometry generation owns one tree per dimension. LOD is a monotonic
    // in-place promotion of that exact tree, never a parallel pool entry.
    return dimension;
  }

  _getPooledSnapshotSpatialIndex(
    geometryGeneration,
    positions,
    dimensionLevel,
    needsLOD
  ) {
    const geometry = this._getSnapshotGeometryRecord(
      geometryGeneration,
      positions
    );
    const key =
      this._snapshotSpatialIndexKey(dimensionLevel, needsLOD);
    const spatialIndex = geometry.spatialIndices.get(key) ?? null;
    if (
      spatialIndex !== null &&
      (
        spatialIndex.positions !== positions ||
        spatialIndex.dimensionLevel !== dimensionLevel
      )
    ) {
      throw new Error(
        `HighPerfRenderer snapshot geometry generation ${geometryGeneration} has an inconsistent ${dimensionLevel}D spatial owner.`
      );
    }
    if (
      spatialIndex !== null &&
      needsLOD &&
      (
        !Array.isArray(spatialIndex.lodLevels) ||
        spatialIndex.lodLevels.length === 0
      )
    ) {
      // Promotion failure leaves the already accepted tree resident so the
      // same owner can be retried without rebuilding its hierarchy.
      spatialIndex.ensureLODLevels();
    }
    return spatialIndex;
  }

  _publishPooledSnapshotSpatialIndex(
    geometryGeneration,
    positions,
    dimensionLevel,
    needsLOD,
    spatialIndex
  ) {
    if (
      !spatialIndex ||
      spatialIndex.positions !== positions ||
      spatialIndex.dimensionLevel !== dimensionLevel
    ) {
      throw new Error(
        'HighPerfRenderer cannot publish an inconsistent snapshot spatial owner.'
      );
    }
    const geometry = this._getSnapshotGeometryRecord(
      geometryGeneration,
      positions
    );
    const key =
      this._snapshotSpatialIndexKey(dimensionLevel, needsLOD);
    const existing = geometry.spatialIndices.get(key);
    if (existing !== undefined && existing !== spatialIndex) {
      throw new Error(
        `HighPerfRenderer snapshot geometry generation ${geometryGeneration} already owns a different ${dimensionLevel}D spatial index.`
      );
    }
    geometry.spatialIndices.set(key, spatialIndex);
    return spatialIndex;
  }

  _releaseSnapshotGeometry(snapshot, existingPositionBuffer = null) {
    if (
      !snapshot ||
      !Number.isSafeInteger(snapshot.geometryGeneration) ||
      snapshot.geometryGeneration <= 0
    ) {
      return null;
    }
    this._ensureGeometryOwnershipState();
    const geometry = this._snapshotGeometryPools.get(
      snapshot.geometryGeneration
    );
    if (geometry === undefined) {
      throw new Error(
        `HighPerfRenderer snapshot geometry generation ${snapshot.geometryGeneration} is not owned.`
      );
    }
    if (
      geometry.positions !== snapshot.positions ||
      !Number.isSafeInteger(geometry.refCount) ||
      geometry.refCount <= 0
    ) {
      throw new Error(
        `HighPerfRenderer snapshot geometry generation ${snapshot.geometryGeneration} has invalid ownership.`
      );
    }
    this._ensureSnapshotGeometryGpuOwner(geometry);
    if (
      geometry.refCount === 1 &&
      geometry.positionBuffer !== null &&
      existingPositionBuffer !== null &&
      geometry.positionBuffer !== existingPositionBuffer
    ) {
      throw new Error(
        `HighPerfRenderer snapshot geometry generation ${snapshot.geometryGeneration} cannot merge distinct retired position owners.`
      );
    }
    geometry.refCount -= 1;
    if (geometry.refCount === 0) {
      this._snapshotGeometryPools.delete(snapshot.geometryGeneration);
      const positionOwnership = {
        positionBuffer: geometry.positionBuffer,
        positionBufferByteLength:
          geometry.positionBufferByteLength,
      };
      geometry.positionBuffer = null;
      geometry.positionBufferByteLength = 0;
      return positionOwnership;
    }
    return null;
  }

  _ensureSnapshotColorOwner(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new TypeError(
        'HighPerfRenderer snapshot color ownership requires one snapshot record.'
      );
    }
    let owner = snapshot.colorOwner ?? null;
    if (owner === null) {
      if (
        !snapshot.buffer ||
        !Number.isSafeInteger(snapshot.bufferByteLength) ||
        snapshot.bufferByteLength < 0
      ) {
        throw new Error(
          `HighPerfRenderer snapshot "${snapshot.id ?? 'unknown'}" has no exact color-buffer owner.`
        );
      }
      owner = {
        buffer: snapshot.buffer,
        byteLength: snapshot.bufferByteLength,
        pointCount: snapshot.pointCount,
        refCount: 1,
      };
      snapshot.colorOwner = owner;
    }
    if (
      !owner ||
      !owner.buffer ||
      !Number.isSafeInteger(owner.byteLength) ||
      !Number.isSafeInteger(owner.pointCount) ||
      owner.pointCount < 0 ||
      owner.byteLength !== owner.pointCount * 3 ||
      owner.pointCount !== snapshot.pointCount ||
      !Number.isSafeInteger(owner.refCount) ||
      owner.refCount <= 0 ||
      snapshot.buffer !== owner.buffer ||
      snapshot.bufferByteLength !== owner.byteLength
    ) {
      throw new Error(
        `HighPerfRenderer snapshot "${snapshot.id ?? 'unknown'}" has inconsistent color-buffer ownership.`
      );
    }
    return owner;
  }

  _createSnapshotColorOwner(buffer, byteLength) {
    if (
      !buffer ||
      !Number.isSafeInteger(byteLength) ||
      byteLength !== this.pointCount * 3
    ) {
      throw new Error(
        'HighPerfRenderer cannot publish an invalid snapshot color-buffer owner.'
      );
    }
    return {
      buffer,
      byteLength,
      pointCount: this.pointCount,
      refCount: 1,
    };
  }

  _retainSnapshotColorOwner(owner) {
    if (
      !owner ||
      !owner.buffer ||
      !Number.isSafeInteger(owner.byteLength) ||
      !Number.isSafeInteger(owner.pointCount) ||
      owner.pointCount < 0 ||
      owner.byteLength !== owner.pointCount * 3 ||
      !Number.isSafeInteger(owner.refCount) ||
      owner.refCount <= 0 ||
      owner.refCount >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error(
        'HighPerfRenderer cannot retain an invalid snapshot color-buffer owner.'
      );
    }
    owner.refCount += 1;
    return owner;
  }

  _releaseSnapshotColorOwner(owner, existingBuffer = null) {
    if (owner === null) return null;
    if (
      !owner ||
      !owner.buffer ||
      !Number.isSafeInteger(owner.byteLength) ||
      !Number.isSafeInteger(owner.pointCount) ||
      owner.pointCount < 0 ||
      owner.byteLength !== owner.pointCount * 3 ||
      !Number.isSafeInteger(owner.refCount) ||
      owner.refCount <= 0
    ) {
      throw new Error(
        'HighPerfRenderer cannot release an invalid snapshot color-buffer owner.'
      );
    }
    if (
      owner.refCount === 1 &&
      existingBuffer !== null &&
      owner.buffer !== existingBuffer
    ) {
      throw new Error(
        'HighPerfRenderer cannot merge distinct retired snapshot color buffers.'
      );
    }
    owner.refCount -= 1;
    if (owner.refCount !== 0) return null;
    const ownership = {
      buffer: owner.buffer,
      bufferByteLength: owner.byteLength,
    };
    owner.buffer = null;
    owner.byteLength = 0;
    owner.pointCount = 0;
    return ownership;
  }

  _retireSnapshotRecord(snapshot, options) {
    this._queueSnapshotRetirement(snapshot, options);
    return this._drainSnapshotRetirements();
  }

  _drainSnapshotRetirements(id = null) {
    this._ensureRetirementOwnershipState();
    const failures = [];
    const drainHandle = (
      retirement,
      property,
      deleteMethod,
      livenessMethod
    ) => {
      const handle = retirement[property];
      if (handle === null) return;
      try {
        this.gl[deleteMethod](handle);
        retirement[property] = null;
      } catch (error) {
        let stillAlive = true;
        if (typeof this.gl[livenessMethod] === 'function') {
          try {
            stillAlive = this.gl[livenessMethod](handle);
          } catch {
            stillAlive = true;
          }
        }
        if (stillAlive) {
          failures.push(error);
        } else {
          // WebGL deletion can complete before an implementation reports an
          // exception. Settle that exact handle so a retry cannot double-delete
          // it or keep an already-freed generation artificially resident.
          retirement[property] = null;
        }
      }
    };
    for (
      const retirement of
      Array.from(this._pendingSnapshotRetirements)
    ) {
      if (id !== null && retirement.id !== id) continue;

      // Every staged or published snapshot VAO holds attribute bindings to
      // both its color buffer and the geometry pool's position buffer. It is
      // the hard retirement barrier: do not release either storage owner (or
      // its geometry reference) while this VAO is still live.
      drainHandle(
        retirement,
        'vao',
        'deleteVertexArray',
        'isVertexArray'
      );
      if (retirement.vao !== null) continue;

      if (retirement.colorOwner !== null) {
        try {
          const releasedColor =
            this._releaseSnapshotColorOwner(
              retirement.colorOwner,
              retirement.buffer
            );
          retirement.colorOwner = null;
          if (releasedColor?.buffer) {
            retirement.buffer = releasedColor.buffer;
            retirement.bufferByteLength =
              releasedColor.bufferByteLength;
          }
        } catch (error) {
          failures.push(error);
        }
      }
      drainHandle(
        retirement,
        'buffer',
        'deleteBuffer',
        'isBuffer'
      );
      drainHandle(
        retirement,
        'alphaTexture',
        'deleteTexture',
        'isTexture'
      );
      if (retirement.geometryGeneration !== null) {
        try {
          const releasedPosition =
            this._releaseSnapshotGeometry(
              {
                geometryGeneration:
                  retirement.geometryGeneration,
                positions: retirement.positions,
              },
              retirement.positionBuffer
            );
          retirement.geometryGeneration = null;
          retirement.positions = null;
          if (releasedPosition?.positionBuffer) {
            retirement.positionBuffer =
              releasedPosition.positionBuffer;
            retirement.positionBufferByteLength =
              releasedPosition.positionBufferByteLength;
          }
        } catch (error) {
          failures.push(error);
        }
      }
      drainHandle(
        retirement,
        'positionBuffer',
        'deleteBuffer',
        'isBuffer'
      );
      if (
        retirement.alphaTexture === null &&
        retirement.colorOwner === null &&
        retirement.geometryGeneration === null &&
        retirement.buffer === null &&
        retirement.positionBuffer === null &&
        retirement.vao === null
      ) {
        this._pendingSnapshotRetirements.delete(retirement);
      }
    }
    this._refreshGpuMemoryStats();
    return failures;
  }

  _queueSnapshotRetirement(
    snapshot,
    {
      releaseAlpha = true,
      releaseColor = true,
      releaseGeometry = true,
      releaseVao = true,
    } = {}
  ) {
    this._ensureRetirementOwnershipState();
    if (
      typeof releaseAlpha !== 'boolean' ||
      typeof releaseColor !== 'boolean' ||
      typeof releaseGeometry !== 'boolean' ||
      typeof releaseVao !== 'boolean'
    ) {
      throw new TypeError(
        'HighPerfRenderer snapshot retirement options must be exact booleans.'
      );
    }
    const colorOwner = releaseColor
      ? snapshot?.colorOwner ?? null
      : null;
    const unownedBuffer = releaseColor && colorOwner === null
      ? snapshot?.buffer ?? null
      : null;
    const retirement = {
      alphaTexture: releaseAlpha
        ? snapshot?.alphaTexture ?? null
        : null,
      alphaTextureByteLength:
        releaseAlpha &&
        Number.isSafeInteger(snapshot?.alphaTextureByteLength) &&
        snapshot.alphaTextureByteLength >= 0
          ? snapshot.alphaTextureByteLength
          : 0,
      buffer: unownedBuffer,
      bufferByteLength:
        unownedBuffer !== null &&
        Number.isSafeInteger(snapshot?.bufferByteLength) &&
        snapshot.bufferByteLength >= 0
          ? snapshot.bufferByteLength
          : (
            unownedBuffer !== null &&
            Number.isSafeInteger(snapshot?.pointCount) &&
            snapshot.pointCount >= 0
              ? snapshot.pointCount * 3
              : 0
          ),
      colorOwner,
      geometryGeneration: releaseGeometry
        ? snapshot?.geometryGeneration ?? null
        : null,
      id: snapshot?.id ?? null,
      positionBuffer: releaseGeometry
        ? snapshot?.positionBuffer ?? null
        : null,
      positionBufferByteLength:
        releaseGeometry &&
        Number.isSafeInteger(
          snapshot?.positionBufferByteLength
        ) &&
        snapshot.positionBufferByteLength >= 0
          ? snapshot.positionBufferByteLength
          : (
            releaseGeometry &&
            snapshot?.positionBuffer &&
            snapshot?.positions instanceof Float32Array
              ? snapshot.positions.byteLength
              : 0
          ),
      positions: releaseGeometry ? snapshot?.positions ?? null : null,
      vao: releaseVao ? snapshot?.vao ?? null : null,
    };
    if (
      retirement.alphaTexture !== null ||
      retirement.buffer !== null ||
      retirement.colorOwner !== null ||
      retirement.positionBuffer !== null ||
      retirement.vao !== null ||
      retirement.geometryGeneration !== null
    ) {
      this._pendingSnapshotRetirements.add(retirement);
    }
    this._refreshGpuMemoryStats();
    return retirement;
  }

  loadData(positions, colors, options = {}) {
    this._assertOperational('load data');
    const gl = this.gl;
    if (!(positions instanceof Float32Array) || positions.length % 3 !== 0) {
      throw new TypeError(
        'HighPerfRenderer positions must be a Float32Array with exactly three values per point.'
      );
    }
    if (!(colors instanceof Uint8Array)) {
      throw new TypeError('HighPerfRenderer colors must be an RGBA Uint8Array.');
    }
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.getPrototypeOf(options) !== Object.prototype
    ) {
      throw new TypeError(
        'HighPerfRenderer load options must be one exact plain object.'
      );
    }
    const optionKeys = Object.keys(options);
    if (
      !optionKeys.includes('dimensionLevel') ||
      optionKeys.some(
        (key) =>
          key !== 'dimensionLevel' &&
          key !== 'buildSpatialIndex' &&
          key !== 'alphaValues'
      )
    ) {
      throw new TypeError(
        'HighPerfRenderer load options accept exactly dimensionLevel and optional alphaValues/buildSpatialIndex.'
      );
    }
    // Only build spatial index if LOD/frustum culling is currently enabled at runtime
    const defaultBuildSpatialIndex = this.useAdaptiveLOD || this.useFrustumCulling;
    const buildSpatialIndex = options.buildSpatialIndex ?? defaultBuildSpatialIndex;
    if (typeof buildSpatialIndex !== 'boolean') {
      throw new TypeError('HighPerfRenderer buildSpatialIndex must be a boolean.');
    }
    const dimensionLevel = requireDimensionLevel(
      options.dimensionLevel,
      'HighPerfRenderer loadData dimensionLevel'
    );
    const pointCount = positions.length / 3;
    if (
      this.snapshotBuffers instanceof Map &&
      this.snapshotBuffers.size > 0 &&
      pointCount !== this.pointCount
    ) {
      throw new RangeError(
        `HighPerfRenderer cannot replace ${this.pointCount.toLocaleString()} live points with ${pointCount.toLocaleString()} while snapshot views remain published.`
      );
    }
    const expectedRGBA = pointCount * 4;
    if (colors.length !== expectedRGBA) {
      throw new RangeError(
        `HighPerfRenderer colors must contain exactly ${expectedRGBA} RGBA bytes for ${pointCount} points; received ${colors.length}.`
      );
    }
    const alphaValues = Object.hasOwn(options, 'alphaValues')
      ? options.alphaValues
      : null;
    if (alphaValues !== null) {
      if (
        !(alphaValues instanceof Float32Array) ||
        alphaValues.length !== pointCount
      ) {
        throw new TypeError(
          `HighPerfRenderer alphaValues must be a Float32Array with exactly ${pointCount} entries.`
        );
      }
      for (let index = 0; index < alphaValues.length; index++) {
        const value = alphaValues[index];
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          throw new RangeError(
            `HighPerfRenderer alphaValues entry ${index} must be finite and in [0, 1].`
          );
        }
      }
    }

    requireCleanWebGLState(gl, 'HighPerfRenderer data publication');
    const previousPublication = this._captureDataPublication();
    const candidateGeometryGeneration =
      this._allocateGeometryGeneration();
    let candidateInstalled = false;

    try {
      this._installCandidateDataPublication(previousPublication);
      candidateInstalled = true;
      this.currentDimensionLevel = dimensionLevel;
      this._liveGeometryGeneration = candidateGeometryGeneration;
      this.pointCount = pointCount;
      this._positions = positions;
      this._colors = colors;
      this._firstRenderDone = false;
      console.log(
        `[HighPerfRenderer] Loading ${this.pointCount.toLocaleString()} points...`
      );

      const startTime = performance.now();

      // The full-detail buffer and alpha texture are staged first. LOD
      // construction can then reference only candidate resources.
      this._createInterleavedBuffer(positions, colors);
      this._createAlphaTexture(this.pointCount);
      if (alphaValues !== null) {
        this.updateAlphas(alphaValues);
      }
      this._boundingSphere = this._computeBoundingSphere(positions);

      if (buildSpatialIndex && this.pointCount > 10000) {
        console.log(
          `[HighPerfRenderer] Building ${this.currentDimensionLevel}D spatial index for LOD/frustum culling...`
        );
        const spatialIndex =
          this._getOrBuildSpatialIndexForDimension(
            this.currentDimensionLevel,
            false,
            this._needsLodResources(-1)
          );
        if (spatialIndex) {
          spatialIndex._lastLODLevel = undefined;
          this._boundingSphere = spatialIndex.getBoundingSphere();
        }
      }

      requireCleanWebGLState(
        gl,
        'HighPerfRenderer candidate data publication'
      );

      const elapsed = performance.now() - startTime;
      console.log(`[HighPerfRenderer] Data loaded in ${elapsed.toFixed(1)}ms`);

      Object.assign(this.stats, {
        lastFrameTime: 0,
        fps: 0,
        visiblePoints: 0,
        lodLevel: -1,
        drawCalls: 0,
        frustumCulled: false,
        cullPercent: 0,
      });
      this._refreshGpuMemoryStats();
    } catch (error) {
      const cleanupErrors = [];
      if (candidateInstalled) {
        const rejectedPublication = this._captureDataPublication();
        this._restoreDataPublication(previousPublication, {
          invalidateInterleavedCache: true,
        });
        cleanupErrors.push(
          ...this._retireDataPublication(rejectedPublication)
        );
      }
      try {
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        const cleanupGlError = gl.getError();
        if (cleanupGlError !== gl.NO_ERROR) {
          cleanupErrors.push(
            new Error(
              `HighPerfRenderer rollback encountered WebGL error 0x${cleanupGlError.toString(16)}.`
            )
          );
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `HighPerfRenderer data publication failed and rollback reported ${cleanupErrors.length} cleanup error(s).`
        );
      }
      throw error;
    }

    // Candidate state is authoritative once its complete publication passed
    // validation. Prior resources are detached into retryable ownership;
    // hostile retirement must never resurrect a partially destroyed dataset
    // or reject the valid candidate.
    this._retireDataPublication(previousPublication);
    return this.stats;
  }

  /**
   * Get or create a spatial index for a specific dimension level.
   * Spatial indices are cached per dimension for efficient multiview rendering.
   * @param {number} dimensionLevel - Dimension level (1, 2, or 3)
   * @returns {SpatialIndex|null} Spatial index for the dimension, or null if data not available
   */
  getSpatialIndexForDimension(
    dimensionLevel,
    needsLOD = this._needsLodResources(-1)
  ) {
    this._assertOperational('build a spatial index');
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer spatial-index dimensionLevel'
    );
    if (typeof needsLOD !== 'boolean') {
      throw new TypeError(
        'HighPerfRenderer spatial-index needsLOD must be a boolean.'
      );
    }
    const spatialIndex =
      this._getOrBuildSpatialIndexForDimension(
        dim,
        false,
        needsLOD
      );
    return spatialIndex === null
      ? null
      : getReadOnlySpatialProjection(
        spatialIndex,
        `HighPerfRenderer ${dim}D spatial index`
      );
  }

  _getOrBuildSpatialIndexForDimension(
    dim,
    forceReplacement,
    needsLOD = this._needsLodResources(-1)
  ) {
    if (typeof forceReplacement !== 'boolean') {
      throw new TypeError(
        'HighPerfRenderer spatial-index forceReplacement must be a boolean.'
      );
    }
    if (typeof needsLOD !== 'boolean') {
      throw new TypeError(
        'HighPerfRenderer spatial-index needsLOD must be a boolean.'
      );
    }
    const pos = this._positions;
    const col = this._colors;

    if (!pos || !col) {
      return null;
    }

    // Check if we have a cached spatial index for this dimension
    const previousSpatialIndices = this.spatialIndices;
    const cached = previousSpatialIndices.get(dim) ?? null;
    if (cached !== null && !forceReplacement) {
      // Geometry cache reuse requires the exact live publication identity,
      // dimension, and count. A same-sized replacement is a new owner.
      if (
        cached.positions === pos &&
        cached.dimensionLevel === dim &&
        cached.pointCount === pos.length / 3
      ) {
        const cachedLodIsReady = (
          Array.isArray(cached.lodLevels) &&
          cached.lodLevels.length > 0
        );
        if (!needsLOD || cachedLodIsReady) {
          if (needsLOD) {
            this._getCertifiedLodResourcesForDimension(dim, cached);
          }
          return cached;
        }
        // Promote a frustum-only tree by building a complete LOD candidate
        // off-state. Mutating the accepted tree in place would make a failed
        // GPU publication impossible to roll back exactly.
        console.log(
          `[HighPerfRenderer] Replacing the ${dim}D tree with an exact LOD generation...`
        );
      } else {
        console.log(`[HighPerfRenderer] Spatial index for ${dim}D is stale, rebuilding...`);
      }
    } else if (cached !== null) {
      console.log(
        `[HighPerfRenderer] Replacing the exact ${dim}D spatial index...`
      );
    }

    // Build a complete CPU candidate off-state. The prior exact CPU/GPU
    // generation remains authoritative until both candidate stages succeed.
    console.log(`[HighPerfRenderer] Building ${dim}D spatial index...`);
    const notifications = getNotificationCenter();
    const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
    const cellCount = pos.length / 3;
    const notifId = notifications.startCalculation(
      `Building ${dim}D ${treeNames[dim]} for live view (${cellCount.toLocaleString()} cells)`,
      'spatial'
    );

    const startTime = performance.now();
    let candidateSpatialIndex = null;
    let candidateCpuPublished = false;
    try {
      candidateSpatialIndex = new SpatialIndex(
        pos,
        col,
        dim,
        this.options.LOD_MAX_POINTS_PER_NODE,
        this.options.LOD_MAX_DEPTH,
        {
          buildLOD: needsLOD,
          buildLodNodeMappings: false,
          computeNodeStats: false
        }
      );

      const candidateSpatialIndices = new Map(previousSpatialIndices);
      candidateSpatialIndices.set(dim, candidateSpatialIndex);
      // Publish CPU identity before the atomic GPU publisher commits. Its old
      // handle retirement observers must always resolve the matching candidate
      // CPU owner, never an absent or stale generation.
      this.spatialIndices = candidateSpatialIndices;
      candidateCpuPublished = true;
      if (needsLOD) {
        this._ensureLodResourcesForDimension(
          dim,
          candidateSpatialIndex
        );
      } else if (
        this._lodResourceOwnersByDimension?.has(dim) ||
        this.lodBuffersByDimension.has(dim) ||
        this._lodIndexTexturesByDimension.has(dim)
      ) {
        // A tree-only candidate cannot retain topology from a different CPU
        // generation. Detach it only after the new CPU owner is authoritative.
        this._deleteLodResourcesForDimension(dim);
      }

      const elapsed = performance.now() - startTime;
      console.log(
        `[HighPerfRenderer] ${dim}D spatial index built in ${elapsed.toFixed(1)}ms`
      );
      settleCalculationNotification(
        notifications,
        notifId,
        'completeCalculation',
        `${dim}D ${treeNames[dim]} ready (live view)`,
        elapsed
      );
      return candidateSpatialIndex;
    } catch (error) {
      const candidateGpuOwner =
        this._lodResourceOwnersByDimension?.get(dim) ?? null;
      const candidateGpuPublished =
        needsLOD &&
        candidateGpuOwner?.spatialIndex === candidateSpatialIndex;
      if (
        !candidateCpuPublished ||
        (needsLOD && !candidateGpuPublished)
      ) {
        // GPU staging is transactional and preserves its previous owner on
        // failure, so restoring the exact map reference completes rollback.
        this.spatialIndices = previousSpatialIndices;
      }
      settleCalculationNotification(
        notifications,
        notifId,
        'failCalculation',
        `${dim}D ${treeNames[dim]} failed: ${describeError(error)}`
      );
      throw error;
    }
  }

  _certifyLodResourcesForDimension(
    dimensionLevel,
    spatialIndex,
    owner,
    lodBuffers,
    indexTextures
  ) {
    const current =
      LOD_RESOURCE_READINESS_CERTIFICATES.get(owner) ?? null;
    const levels = spatialIndex.lodLevels;
    const topologyOwner = owner.topologyOwner;
    if (
      current !== null &&
      current.dimensionLevel === dimensionLevel &&
      current.spatialIndex === spatialIndex &&
      current.levels === levels &&
      current.levelCount === levels.length &&
      current.ownerGenerationToken === owner.generationToken &&
      current.maximumIndices === owner.maximumIndices &&
      current.topologyOwner === topologyOwner &&
      current.compactBuffer === owner.compactBuffer &&
      current.compactVao === owner.compactVao &&
      current.gpuByteLength === owner.gpuByteLength &&
      current.lodBuffers === lodBuffers &&
      current.lodBufferCount === lodBuffers.length &&
      current.indexTextures === indexTextures &&
      current.indexTextureCount === indexTextures.length &&
      current.liveGeometryGeneration ===
        this._liveGeometryGeneration &&
      current.pointCount === this.pointCount &&
      current.fullDetailVao === this.vao &&
      current.fullDetailBuffer === this.buffers?.interleaved
    ) {
      return;
    }
    LOD_RESOURCE_READINESS_CERTIFICATES.set(
      owner,
      Object.freeze({
        dimensionLevel,
        spatialIndex,
        levels,
        levelCount: levels.length,
        ownerGenerationToken: owner.generationToken,
        maximumIndices: owner.maximumIndices,
        topologyOwner,
        compactBuffer: owner.compactBuffer,
        compactVao: owner.compactVao,
        gpuByteLength: owner.gpuByteLength,
        lodBuffers,
        lodBufferCount: lodBuffers.length,
        indexTextures,
        indexTextureCount: indexTextures.length,
        liveGeometryGeneration: this._liveGeometryGeneration,
        pointCount: this.pointCount,
        fullDetailVao: this.vao,
        fullDetailBuffer: this.buffers?.interleaved,
      })
    );
  }

  /**
   * Return a renderer-certified LOD projection without rescanning every level.
   * Uncertified, replaced, or externally assembled owners take the deep
   * validator path and receive a certificate only after it accepts them.
   */
  _getCertifiedLodResourcesForDimension(
    dimensionLevel,
    spatialIndex
  ) {
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer certified LOD resource dimensionLevel'
    );
    this._ensureLodResourceOwnershipState();
    const owner =
      this._lodResourceOwnersByDimension.get(dim) ?? null;
    const lodBuffers =
      this.lodBuffersByDimension.get(dim) ?? null;
    const indexTextures =
      this._lodIndexTexturesByDimension.get(dim) ?? null;
    const certificate = owner === null
      ? null
      : LOD_RESOURCE_READINESS_CERTIFICATES.get(owner) ?? null;
    if (
      certificate !== null &&
      certificate.dimensionLevel === dim &&
      certificate.spatialIndex === spatialIndex &&
      certificate.levels === spatialIndex?.lodLevels &&
      certificate.levelCount === spatialIndex.lodLevels.length &&
      certificate.ownerGenerationToken === owner.generationToken &&
      certificate.maximumIndices === owner.maximumIndices &&
      certificate.topologyOwner === owner.topologyOwner &&
      certificate.compactBuffer === owner.compactBuffer &&
      certificate.compactVao === owner.compactVao &&
      certificate.gpuByteLength === owner.gpuByteLength &&
      certificate.lodBuffers === lodBuffers &&
      certificate.lodBufferCount === lodBuffers?.length &&
      certificate.indexTextures === indexTextures &&
      certificate.indexTextureCount === indexTextures?.length &&
      certificate.liveGeometryGeneration ===
        this._liveGeometryGeneration &&
      certificate.pointCount === this.pointCount &&
      certificate.fullDetailVao === this.vao &&
      certificate.fullDetailBuffer === this.buffers?.interleaved
    ) {
      return lodBuffers;
    }
    return this._ensureLodResourcesForDimension(dim, spatialIndex);
  }

  _ensureLodResourcesForDimension(
    dimensionLevel,
    spatialIndex,
    deferPublication = false
  ) {
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer LOD resource dimensionLevel'
    );
    if (typeof deferPublication !== 'boolean') {
      throw new TypeError(
        'HighPerfRenderer deferred LOD preparation must be a boolean.'
      );
    }
    if (
      !spatialIndex ||
      spatialIndex.positions !== this._positions ||
      spatialIndex.dimensionLevel !== dim ||
      spatialIndex.pointCount !== this.pointCount
    ) {
      throw new Error(
        `HighPerfRenderer ${dim}D LOD resources require the exact live spatial owner.`
      );
    }
    if (
      !Array.isArray(spatialIndex.lodLevels) ||
      spatialIndex.lodLevels.length === 0
    ) {
      spatialIndex.ensureLODLevels();
    }

    this._ensureLodResourceOwnershipState();
    const owner =
      this._lodResourceOwnersByDimension.get(dim) ?? null;
    const lodBuffers =
      this.lodBuffersByDimension.get(dim) ?? null;
    const indexTextures =
      this._lodIndexTexturesByDimension.get(dim) ?? null;
    const levels = spatialIndex.lodLevels;
    const reducedLevels = levels.slice(0, -1);
    const maximumIndices =
      reducedLevels.at(-1)?.indices ?? null;
    const maximumCount = maximumIndices?.length ?? 0;
    const topologyOwner = owner?.topologyOwner ?? null;
    const ownerTextureLimit = topologyOwner?.maxTextureSize;
    const expectedTextureWidth = maximumCount === 0
      ? 0
      : (
        Number.isInteger(ownerTextureLimit) &&
        ownerTextureLimit > 0
          ? Math.min(maximumCount, ownerTextureLimit)
          : -1
      );
    const expectedTextureHeight = maximumCount === 0
      ? 0
      : Math.ceil(maximumCount / expectedTextureWidth);
    const expectedCompactBytes = maximumCount * 16;
    const expectedIndexBytes =
      maximumCount * Uint32Array.BYTES_PER_ELEMENT;
    const expectedTextureBytes =
      expectedTextureWidth >= 0
        ? expectedTextureWidth *
          expectedTextureHeight *
          Uint32Array.BYTES_PER_ELEMENT
        : -1;
    const hasReducedGeneration = maximumCount > 0;
    const ownerProjectionIsExact = (
      owner !== null &&
      owner.dimensionLevel === dim &&
      owner.spatialIndex === spatialIndex &&
      owner.maximumIndices === maximumIndices &&
      owner.pointCount === this.pointCount &&
      owner.liveGeometryGeneration ===
        this._liveGeometryGeneration &&
      owner.generationToken !== null &&
      typeof owner.generationToken === 'object' &&
      Object.isFrozen(owner.generationToken) &&
      owner.compactBuffer !== null === hasReducedGeneration &&
      owner.compactVao !== null === hasReducedGeneration &&
      owner.compactByteLength === expectedCompactBytes &&
      topologyOwner !== null &&
      typeof topologyOwner === 'object' &&
      topologyOwner.originalIndexBuffer !== null ===
        hasReducedGeneration &&
      topologyOwner.originalIndexByteLength ===
        expectedIndexBytes &&
      topologyOwner.indexTexture !== null ===
        hasReducedGeneration &&
      topologyOwner.textureWidth === expectedTextureWidth &&
      topologyOwner.textureHeight === expectedTextureHeight &&
      topologyOwner.indexTextureByteLength ===
        expectedTextureBytes &&
      owner.gpuByteLength ===
        expectedCompactBytes +
          expectedIndexBytes +
          expectedTextureBytes &&
      Array.isArray(lodBuffers) &&
      lodBuffers.length === levels.length &&
      Array.isArray(indexTextures) &&
      indexTextures.length === levels.length &&
      levels.every((level, levelIndex) => {
        const metadata = lodBuffers[levelIndex];
        const texture = indexTextures[levelIndex];
        if (!metadata || !texture) return false;
        if (levelIndex === levels.length - 1) {
          return (
            level?.isFullDetail === true &&
            metadata.isFullDetail === true &&
            metadata.vao === this.vao &&
            metadata.buffer === this.buffers?.interleaved &&
            metadata.pointCount === level.pointCount &&
            metadata.depth === level.depth &&
            metadata.sizeMultiplier === 1 &&
            metadata.originalIndexBuffer === null &&
            metadata.originalIndexCount === 0 &&
            metadata.generationToken === null &&
            texture.texture === null &&
            texture.width === 0 &&
            texture.height === 0 &&
            texture.generationToken === null
          );
        }
        return (
          level?.isFullDetail !== true &&
          metadata.isFullDetail === false &&
          metadata.vao === owner.compactVao &&
          metadata.buffer === owner.compactBuffer &&
          metadata.pointCount === level.pointCount &&
          metadata.depth === level.depth &&
          metadata.sizeMultiplier === level.sizeMultiplier &&
          metadata.originalIndexBuffer ===
            topologyOwner.originalIndexBuffer &&
          metadata.originalIndexCount === level.pointCount &&
          metadata.generationToken === owner.generationToken &&
          texture.texture === topologyOwner.indexTexture &&
          texture.width === topologyOwner.textureWidth &&
          texture.height === topologyOwner.textureHeight &&
          texture.generationToken === owner.generationToken
        );
      })
    );
    if (
      !ownerProjectionIsExact
    ) {
      if (owner !== null) {
        LOD_RESOURCE_READINESS_CERTIFICATES.delete(owner);
      }
      return this._createLODResourcesForDimension(
        dim,
        spatialIndex,
        deferPublication
      );
    }
    this._certifyLodResourcesForDimension(
      dim,
      spatialIndex,
      owner,
      lodBuffers,
      indexTextures
    );
    return deferPublication ? null : lodBuffers;
  }

  /**
   * Atomically publish one maximum-prefix GPU generation for a dimension.
   * Every reduced LOD is a non-owning view over the same compact VBO/VAO,
   * original-ID EBO, and R32UI lookup texture. Full detail borrows the main
   * publication and therefore owns neither topology nor vertex resources.
   *
   * @param {number} dimensionLevel - Exact dimension level.
   * @param {SpatialIndex} spatialIndex - Exact live spatial generation.
   * @returns {Array} Non-owning LOD buffer metadata.
   */
  _createLODResourcesForDimension(
    dimensionLevel,
    spatialIndex,
    deferPublication = false
  ) {
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer LOD resource dimensionLevel'
    );
    if (typeof deferPublication !== 'boolean') {
      throw new TypeError(
        'HighPerfRenderer deferred LOD publication must be a boolean.'
      );
    }
    this._ensureLodResourceOwnershipState();

    if (
      spatialIndex === null ||
      typeof spatialIndex !== 'object' ||
      !Array.isArray(spatialIndex.lodLevels) ||
      spatialIndex.lodLevels.length === 0
    ) {
      throw new TypeError(
        `HighPerfRenderer ${dim}D LOD publication requires a non-empty exact spatial-index generation.`
      );
    }
    if (spatialIndex.dimensionLevel !== dim) {
      throw new Error(
        `HighPerfRenderer ${dim}D LOD publication received a ${String(spatialIndex.dimensionLevel)}D spatial-index owner.`
      );
    }
    const sourcePositions = spatialIndex.positions;
    if (
      !(sourcePositions instanceof Float32Array) ||
      sourcePositions !== this._positions ||
      sourcePositions.length !== this.pointCount * 3 ||
      spatialIndex.pointCount !== this.pointCount
    ) {
      throw new Error(
        `HighPerfRenderer ${dim}D LOD publication requires the exact ${this.pointCount}-point live position generation.`
      );
    }
    if (
      !(this._colors instanceof Uint8Array) ||
      this._colors.length !== this.pointCount * 4
    ) {
      throw new Error(
        `HighPerfRenderer ${dim}D LOD publication requires the exact live RGBA generation.`
      );
    }
    if (!this.vao || !this.buffers?.interleaved) {
      throw new Error(
        'HighPerfRenderer requires staged full-detail resources before creating LOD resources.'
      );
    }

    const levels = spatialIndex.lodLevels;
    const fullDetail = levels.at(-1);
    if (
      !fullDetail ||
      fullDetail.isFullDetail !== true ||
      fullDetail.pointCount !== this.pointCount ||
      fullDetail.positions !== sourcePositions
    ) {
      throw new Error(
        `HighPerfRenderer ${dim}D LOD publication requires one exact full-detail terminal level.`
      );
    }
    for (let levelIndex = 0; levelIndex < levels.length - 1; levelIndex++) {
      if (levels[levelIndex]?.isFullDetail === true) {
        throw new Error(
          `HighPerfRenderer ${dim}D LOD ${levelIndex} places full detail before the terminal level.`
        );
      }
    }

    const reducedLevels = levels.slice(0, -1);
    let maximumIndices = null;
    let previousCount = 0;
    for (
      let levelIndex = 0;
      levelIndex < reducedLevels.length;
      levelIndex++
    ) {
      const level = reducedLevels[levelIndex];
      const pointCount = level?.pointCount;
      if (
        !Number.isSafeInteger(pointCount) ||
        pointCount < previousCount ||
        pointCount > this.pointCount ||
        !(level.indices instanceof Uint32Array) ||
        level.indices.length !== pointCount
      ) {
        throw new Error(
          `HighPerfRenderer ${dim}D reduced LOD ${levelIndex} must have a non-decreasing exact original-index count no larger than full detail.`
        );
      }
      const sizeMultiplier = requireFiniteNumber(
        level.sizeMultiplier,
        `HighPerfRenderer ${dim}D LOD ${levelIndex} sizeMultiplier`
      );
      if (sizeMultiplier <= 0) {
        throw new RangeError(
          `HighPerfRenderer ${dim}D LOD ${levelIndex} sizeMultiplier must be positive.`
        );
      }
      previousCount = pointCount;
      maximumIndices = level.indices;
    }
    if (maximumIndices !== null) {
      // Every reduced level is a prefix of this maximum order, so one range
      // scan proves the original-ID domain for all of them.
      for (let index = 0; index < maximumIndices.length; index++) {
        if (maximumIndices[index] >= this.pointCount) {
          throw new RangeError(
            `HighPerfRenderer ${dim}D maximum reduced LOD original index ${maximumIndices[index]} is outside ${this.pointCount} points.`
          );
        }
      }
      for (
        let levelIndex = 0;
        levelIndex < reducedLevels.length;
        levelIndex++
      ) {
        const levelIndices = reducedLevels[levelIndex].indices;
        // SpatialIndex's production representation uses typed prefix views
        // over one owner. Their buffer/offset/length tuple proves prefix
        // equality in O(1); retain the value comparison for exact external
        // fixtures or independently materialized compatible generations.
        if (
          levelIndices.buffer === maximumIndices.buffer &&
          levelIndices.byteOffset === maximumIndices.byteOffset
        ) {
          continue;
        }
        for (let index = 0; index < levelIndices.length; index++) {
          if (levelIndices[index] !== maximumIndices[index]) {
            throw new Error(
              `HighPerfRenderer ${dim}D LOD ${levelIndex} is not an exact prefix of the maximum reduced original-ID order.`
            );
          }
        }
      }
    }

    const gl = this.gl;
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (!Number.isInteger(maxTextureSize) || maxTextureSize <= 0) {
      throw new Error(
        'HighPerfRenderer received an invalid MAX_TEXTURE_SIZE capability.'
      );
    }
    const maximumCount = maximumIndices?.length ?? 0;
    const textureWidth = maximumCount === 0
      ? 0
      : Math.min(maximumCount, maxTextureSize);
    const textureHeight = maximumCount === 0
      ? 0
      : Math.ceil(maximumCount / textureWidth);
    if (textureHeight > maxTextureSize) {
      throw new RangeError(
        `HighPerfRenderer ${dim}D maximum reduced LOD requires ${maximumCount.toLocaleString()} indices, exceeding the exact ${textureWidth}x${maxTextureSize} R32UI texture capacity.`
      );
    }

    // All CPU contracts and capabilities are validated before the first GL
    // allocation, so malformed prefix generations cannot perturb live state.
    requireCleanWebGLState(
      gl,
      `HighPerfRenderer ${dim}D LOD publication preflight`
    );

    const compactByteLength = maximumCount * 16;
    const packingScratch = maximumCount > 0
      ? this._ensureSharedPackingScratch(
        compactByteLength,
        `HighPerfRenderer ${dim}D compact LOD packing`
      )
      : null;
    if (maximumCount > 0) {
      for (let compactIndex = 0; compactIndex < maximumCount; compactIndex++) {
        const originalIndex = maximumIndices[compactIndex];
        const sourceOffset = originalIndex * 3;
        const floatOffset = compactIndex * 4;
        const byteOffset = compactIndex * 16 + 12;
        const colorOffset = originalIndex * 4;
        packingScratch.positionView[floatOffset] =
          sourcePositions[sourceOffset];
        packingScratch.positionView[floatOffset + 1] =
          sourcePositions[sourceOffset + 1];
        packingScratch.positionView[floatOffset + 2] =
          sourcePositions[sourceOffset + 2];
        packingScratch.colorView[byteOffset] =
          this._colors[colorOffset];
        packingScratch.colorView[byteOffset + 1] =
          this._colors[colorOffset + 1];
        packingScratch.colorView[byteOffset + 2] =
          this._colors[colorOffset + 2];
        packingScratch.colorView[byteOffset + 3] =
          this._colors[colorOffset + 3];
      }
    }
    const generationToken = Object.freeze({});
    const topologyOwner = {
      originalIndexBuffer: null,
      originalIndexByteLength: 0,
      indexTexture: null,
      indexTextureByteLength: 0,
      maxTextureSize,
      textureWidth,
      textureHeight,
    };
    const candidateOwner = {
      dimensionLevel: dim,
      spatialIndex,
      maximumIndices,
      pointCount: this.pointCount,
      liveGeometryGeneration: this._liveGeometryGeneration,
      generationToken,
      compactBuffer: null,
      compactVao: null,
      compactByteLength: 0,
      topologyOwner,
      gpuByteLength: 0,
    };
    const candidateLodBuffers = [];
    const candidateIndexTextures = [];
    const previousOwner =
      this._lodResourceOwnersByDimension.get(dim) ?? null;
    const previousLodBuffers =
      this.lodBuffersByDimension.get(dim) ?? null;
    const previousIndexTextures =
      this._lodIndexTexturesByDimension.get(dim) ?? null;
    // Prepare complete replacement projections before allocating WebGL
    // resources. Publication later consists only of three non-fallible
    // property assignments, so observers can never see a half-replaced
    // dimension.
    const candidateOwnersByDimension =
      new Map(this._lodResourceOwnersByDimension);
    // Even an all-full-detail tree owns a semantic generation. Retaining its
    // zero-byte owner prevents every subsequent forced-LOD render from
    // rebuilding identical metadata.
    candidateOwnersByDimension.set(dim, candidateOwner);
    const candidateBuffersByDimension =
      new Map(this.lodBuffersByDimension);
    candidateBuffersByDimension.set(dim, candidateLodBuffers);
    const candidateTexturesByDimension =
      new Map(this._lodIndexTexturesByDimension);
    candidateTexturesByDimension.set(dim, candidateIndexTextures);

    try {
      if (maximumCount > 0) {
        candidateOwner.compactBuffer = gl.createBuffer();
        if (!candidateOwner.compactBuffer) {
          throw new Error(
            `HighPerfRenderer could not allocate the ${dim}D compact LOD point buffer.`
          );
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, candidateOwner.compactBuffer);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          packingScratch.buffer.byteLength === compactByteLength
            ? packingScratch.buffer
            : new Uint8Array(
              packingScratch.buffer,
              0,
              compactByteLength
            ),
          gl.STATIC_DRAW
        );
        requireCleanWebGLState(
          gl,
          `HighPerfRenderer ${dim}D compact LOD point upload`
        );
        candidateOwner.compactByteLength = compactByteLength;

        candidateOwner.compactVao = gl.createVertexArray();
        if (!candidateOwner.compactVao) {
          throw new Error(
            `HighPerfRenderer could not allocate the ${dim}D compact LOD vertex state.`
          );
        }
        gl.bindVertexArray(candidateOwner.compactVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, candidateOwner.compactBuffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(
          1,
          4,
          gl.UNSIGNED_BYTE,
          true,
          16,
          12
        );

        topologyOwner.originalIndexBuffer = gl.createBuffer();
        if (!topologyOwner.originalIndexBuffer) {
          throw new Error(
            `HighPerfRenderer could not allocate the ${dim}D maximum-prefix original-index buffer.`
          );
        }
        gl.bindBuffer(
          gl.ELEMENT_ARRAY_BUFFER,
          topologyOwner.originalIndexBuffer
        );
        gl.bufferData(
          gl.ELEMENT_ARRAY_BUFFER,
          maximumIndices,
          gl.STATIC_DRAW
        );
        requireCleanWebGLState(
          gl,
          `HighPerfRenderer ${dim}D maximum-prefix original-index upload`
        );
        topologyOwner.originalIndexByteLength =
          maximumCount * Uint32Array.BYTES_PER_ELEMENT;
        // ELEMENT_ARRAY_BUFFER is VAO state. Detach topology while this exact
        // staging VAO is still bound so later retirement cannot leave a
        // deleted EBO reachable through it.
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        gl.bindVertexArray(null);

        topologyOwner.indexTexture = gl.createTexture();
        if (!topologyOwner.indexTexture) {
          throw new Error(
            `HighPerfRenderer could not allocate the ${dim}D maximum-prefix index texture.`
          );
        }
        gl.bindTexture(gl.TEXTURE_2D, topologyOwner.indexTexture);
        this._withNeutralTextureUnpackState(
          4,
          `HighPerfRenderer ${dim}D maximum-prefix index texture`,
          () => {
            // Allocate immutable logical storage without duplicating the
            // maximum prefix into a padded width*height CPU array.
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              gl.R32UI,
              textureWidth,
              textureHeight,
              0,
              gl.RED_INTEGER,
              gl.UNSIGNED_INT,
              null
            );
            requireCleanWebGLState(
              gl,
              `HighPerfRenderer ${dim}D maximum-prefix index-texture allocation`
            );
            topologyOwner.indexTextureByteLength =
              textureWidth *
              textureHeight *
              Uint32Array.BYTES_PER_ELEMENT;

            const completeRows =
              Math.floor(maximumCount / textureWidth);
            const completeValueCount =
              completeRows * textureWidth;
            if (completeRows > 0) {
              gl.texSubImage2D(
                gl.TEXTURE_2D,
                0,
                0,
                0,
                textureWidth,
                completeRows,
                gl.RED_INTEGER,
                gl.UNSIGNED_INT,
                maximumIndices.subarray(0, completeValueCount)
              );
              requireCleanWebGLState(
                gl,
                `HighPerfRenderer ${dim}D complete index-texture rows`
              );
            }
            const remainingValues =
              maximumCount - completeValueCount;
            if (remainingValues > 0) {
              gl.texSubImage2D(
                gl.TEXTURE_2D,
                0,
                0,
                completeRows,
                remainingValues,
                1,
                gl.RED_INTEGER,
                gl.UNSIGNED_INT,
                maximumIndices.subarray(completeValueCount)
              );
              requireCleanWebGLState(
                gl,
                `HighPerfRenderer ${dim}D terminal index-texture row`
              );
            }
          }
        );
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MIN_FILTER,
          gl.NEAREST
        );
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MAG_FILTER,
          gl.NEAREST
        );
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_WRAP_S,
          gl.CLAMP_TO_EDGE
        );
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_WRAP_T,
          gl.CLAMP_TO_EDGE
        );
        gl.bindTexture(gl.TEXTURE_2D, null);
      }

      for (
        let levelIndex = 0;
        levelIndex < reducedLevels.length;
        levelIndex++
      ) {
        const level = reducedLevels[levelIndex];
        candidateLodBuffers.push({
          vao: candidateOwner.compactVao,
          buffer: candidateOwner.compactBuffer,
          pointCount: level.pointCount,
          depth: level.depth,
          isFullDetail: false,
          sizeMultiplier: level.sizeMultiplier,
          originalIndexBuffer: topologyOwner.originalIndexBuffer,
          originalIndexCount: level.pointCount,
          generationToken,
        });
        candidateIndexTextures.push({
          texture: topologyOwner.indexTexture,
          width: textureWidth,
          height: textureHeight,
          generationToken,
        });
      }
      candidateLodBuffers.push({
        vao: this.vao,
        buffer: this.buffers.interleaved,
        pointCount: fullDetail.pointCount,
        depth: fullDetail.depth,
        isFullDetail: true,
        sizeMultiplier: 1,
        originalIndexBuffer: null,
        originalIndexCount: 0,
        generationToken: null,
      });
      candidateIndexTextures.push({
        texture: null,
        width: 0,
        height: 0,
        generationToken: null,
      });
      candidateOwner.gpuByteLength =
        candidateOwner.compactByteLength +
        topologyOwner.originalIndexByteLength +
        topologyOwner.indexTextureByteLength;
      for (const metadata of candidateLodBuffers) {
        Object.freeze(metadata);
      }
      for (const metadata of candidateIndexTextures) {
        Object.freeze(metadata);
      }
      Object.freeze(candidateLodBuffers);
      Object.freeze(candidateIndexTextures);
      Object.freeze(topologyOwner);
      Object.freeze(candidateOwner);

      requireCleanWebGLState(
        gl,
        `HighPerfRenderer ${dim}D atomic LOD resource publication`
      );
    } catch (error) {
      const cleanupErrors = [];
      try {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (
        candidateOwner.compactBuffer ||
        candidateOwner.compactVao ||
        topologyOwner.originalIndexBuffer ||
        topologyOwner.indexTexture
      ) {
        this._queueDataRetirement({
          buffers: {},
          vao: null,
          pointCount: 0,
          perViewState: null,
          lodResourceOwnersByDimension:
            new Map([[dim, candidateOwner]]),
          lodBuffersByDimension: new Map(),
          lodIndexTexturesByDimension: new Map(),
          alphaTexture: null,
          alphaTexWidth: 0,
          alphaTexHeight: 0,
        });
        cleanupErrors.push(...this._drainDataRetirements());
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `HighPerfRenderer ${dim}D LOD publication failed and cleanup reported ${cleanupErrors.length} error(s).`
        );
      }
      throw error;
    }

    if (deferPublication) {
      return {
        dimensionLevel: dim,
        spatialIndex,
        candidateOwner,
        candidateLodBuffers,
        candidateIndexTextures,
        previousOwner,
        previousLodBuffers,
        previousIndexTextures
      };
    }

    // Staging and cleanup are now finished. From this point forward the
    // candidate is authoritative: later accounting or old-generation
    // retirement can never route through candidate rollback.
    this._lodResourceOwnersByDimension =
      candidateOwnersByDimension;
    this.lodBuffersByDimension = candidateBuffersByDimension;
    this._lodIndexTexturesByDimension =
      candidateTexturesByDimension;
    this._dirtyLodDimensions.delete(dim);
    this._certifyLodResourcesForDimension(
      dim,
      spatialIndex,
      candidateOwner,
      candidateLodBuffers,
      candidateIndexTextures
    );
    this._refreshGpuMemoryStats();

    if (
      previousOwner ||
      previousLodBuffers ||
      previousIndexTextures
    ) {
      this._queueDataRetirement({
        buffers: {},
        vao: null,
        pointCount: 0,
        perViewState: null,
        lodResourceOwnersByDimension: previousOwner
          ? new Map([[dim, previousOwner]])
          : new Map(),
        lodBuffersByDimension: previousLodBuffers
          ? new Map([[dim, previousLodBuffers]])
          : new Map(),
        lodIndexTexturesByDimension: previousIndexTextures
          ? new Map([[dim, previousIndexTextures]])
          : new Map(),
        alphaTexture: null,
        alphaTexWidth: 0,
        alphaTexHeight: 0,
      });
      // The candidate is authoritative. Retirement failures stay retry-owned
      // and byte-accounted; they never roll back a valid generation.
      this._drainDataRetirements();
    }
    console.log(
      `[HighPerfRenderer] Published one shared ${maximumCount.toLocaleString()}-point LOD prefix for ${dim}D (${reducedLevels.length} reduced levels)`
    );
    return candidateLodBuffers;
  }

  /**
   * Get LOD buffers for a specific dimension level.
   * Creates them if they don't exist and spatial index is available.
   * @param {number} dimensionLevel - Dimension level (1, 2, or 3)
   * @returns {Array} LOD buffers array for the dimension (may be empty)
   */
  getLodBuffersForDimension(dimensionLevel) {
    this._assertOperational('get or build LOD buffers');
    return getReadOnlyLodProjection(
      this._getLodBuffersForDimension(dimensionLevel)
    );
  }

  /**
   * Resolve the exact internal draw projection without a public defensive
   * copy/proxy on the pane-cadence path.
   *
   * @private
   */
  _getLodBuffersForDimension(dimensionLevel) {
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer LOD-buffer dimensionLevel'
    );

    // Check if we already have LOD buffers for this dimension
    if (this.lodBuffersByDimension.has(dim)) {
      return this.lodBuffersByDimension.get(dim);
    }

    // Try to create them if spatial index exists
    const spatialIndex = this.spatialIndices.get(dim);
    if (spatialIndex && this._needsLodResources(-1)) {
      return this._ensureLodResourcesForDimension(
        dim,
        spatialIndex
      );
    }

    return EMPTY_LOD_PROJECTION;
  }

  /**
   * Set the current dimension level for the live view.
   * This determines which spatial index is used for rendering.
   * @param {number} dimensionLevel - Dimension level (1, 2, or 3)
   */
  setDimensionLevel(dimensionLevel) {
    this._assertOperational('set the live dimension');
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer active dimensionLevel'
    );
    if (dim !== this.currentDimensionLevel) {
      console.log(`[HighPerfRenderer] Switching from ${this.currentDimensionLevel}D to ${dim}D`);
      this.currentDimensionLevel = dim;
      // Spatial index will be created lazily when needed (LOD/frustum culling enabled)
    }
  }

  /**
   * Update positions only (for dimension switching) - keeps existing colors and transparency
   * More efficient than full loadData when only positions change
   * @param {Float32Array} positions - New positions array (n_points * 3)
   * @param {number} dimensionLevel - Exact dimension level (1, 2, or 3).
   */
  updatePositions(positions, dimensionLevel) {
    this._assertOperational('update positions');
    if (!(positions instanceof Float32Array)) {
      throw new TypeError('HighPerfRenderer positions must be a Float32Array.');
    }
    const newDimLevel = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer updatePositions dimensionLevel'
    );

    const expectedLength = this.pointCount * 3;
    if (positions.length !== expectedLength) {
      throw new RangeError(
        `HighPerfRenderer updatePositions expected ${expectedLength} floats, received ${positions.length}.`
      );
    }

    if (!(this._colors instanceof Uint8Array)) {
      throw new Error(
        'HighPerfRenderer cannot update positions before exact color data is published.'
      );
    }
    const loadOptions = {
      buildSpatialIndex: this._needsSpatialIndex(-1),
      dimensionLevel: newDimLevel,
    };
    if (this._currentAlphas !== null) {
      loadOptions.alphaValues = this._currentAlphas;
    }
    this.loadData(positions, this._colors, loadOptions);
  }

  /**
   * Transactionally rebuild the active dimension's spatial generation.
   * Other exact dimension caches remain reusable for multiview rendering.
   */
  rebuildSpatialIndex() {
    this._assertOperational('rebuild the spatial index');
    if (!this._positions || !this._colors) return;

    // Only rebuild if LOD/frustum culling is currently enabled at runtime
    const needsSpatialIndex = this._needsSpatialIndex(-1);
    if (needsSpatialIndex && this.pointCount > 10000) {
      console.log(`[HighPerfRenderer] Rebuilding ${this.currentDimensionLevel}D spatial index...`);

      // Stage off-state, publish the candidate CPU identity, atomically replace
      // its GPU generation, and only then retire the superseded active owner.
      // A failure preserves all dimension/view/bounds/force-LOD state.
      const spatialIndex = this._getOrBuildSpatialIndexForDimension(
        this.currentDimensionLevel,
        true
      );
      if (spatialIndex) {
        spatialIndex._lastLODLevel = undefined;
        this._boundingSphere = spatialIndex.getBoundingSphere();

        // Clear all per-view caches since spatial index structure changed
        this.clearAllViewState();

        // Reset forced LOD level when spatial index changes - old level may be invalid
        if (this.forceLODLevel >= 0) {
          console.log('[HighPerfRenderer] Resetting forceLODLevel to auto (-1) after spatial index rebuild');
          this.forceLODLevel = -1;
        }

      }
    }
  }

  _createInterleavedBuffer(positions, colors) {
    const gl = this.gl;
    const pointCount = positions.length / 3;
    const requiredSize = pointCount * 16; // 16 bytes per point

    // Main, compact LOD, and recolor packing share this one exact allocation.
    // Every upload consumes its client bytes synchronously before the next
    // sequential pack overwrites them.
    const {
      buffer,
      positionView,
      colorView,
    } = this._ensureSharedPackingScratch(
      requiredSize,
      'HighPerfRenderer full-detail point packing'
    );

    // colors is Uint8Array with RGBA packed (4 bytes per point) - alpha is in 4th byte
    for (let i = 0; i < pointCount; i++) {
      const srcIdx = i * 3;
      const floatOffset = i * 4; // 16 bytes / 4 = 4 floats per point
      const byteOffset = i * 16 + 12; // color starts at byte 12 within each 16-byte block

      // Position (3 floats = 12 bytes)
      positionView[floatOffset] = positions[srcIdx];
      positionView[floatOffset + 1] = positions[srcIdx + 1];
      positionView[floatOffset + 2] = positions[srcIdx + 2];

      // Color RGBA (4 uint8 = 4 bytes) - colors is already Uint8Array with RGBA
      const colorSrcIdx = i * 4;
      colorView[byteOffset] = colors[colorSrcIdx];
      colorView[byteOffset + 1] = colors[colorSrcIdx + 1];
      colorView[byteOffset + 2] = colors[colorSrcIdx + 2];
      colorView[byteOffset + 3] = colors[colorSrcIdx + 3];
    }

    if (!this.buffers.interleaved) {
      this.buffers.interleaved = gl.createBuffer();
      if (!this.buffers.interleaved) {
        throw new Error(
          'HighPerfRenderer could not allocate the interleaved point buffer.'
        );
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.interleaved);
    gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.STATIC_DRAW);
    requireCleanWebGLState(
      gl,
      'HighPerfRenderer interleaved point-buffer upload'
    );
    this._interleavedGpuByteLength = requiredSize;

    // Setup VAO
    gl.bindVertexArray(this.vao);
    this._setupInterleavedAttributes();
    gl.bindVertexArray(null);
    requireCleanWebGLState(
      gl,
      'HighPerfRenderer interleaved point-buffer publication'
    );
  }

  _ensureSharedPackingScratch(requiredSize, owner) {
    if (
      !Number.isSafeInteger(requiredSize) ||
      requiredSize < 0 ||
      typeof owner !== 'string' ||
      owner.length === 0
    ) {
      throw new TypeError(
        'HighPerfRenderer shared packing scratch received an invalid contract.'
      );
    }
    const fullByteLength = this.pointCount * 16;
    if (
      !Number.isSafeInteger(fullByteLength) ||
      fullByteLength < 0 ||
      requiredSize > fullByteLength
    ) {
      throw new RangeError(
        `${owner} requires ${requiredSize} bytes outside the exact ${fullByteLength}-byte full-detail packing owner.`
      );
    }

    let buffer = this._interleavedArrayBuffer;
    if (
      !(buffer instanceof ArrayBuffer) ||
      buffer.byteLength !== fullByteLength
    ) {
      buffer = new ArrayBuffer(fullByteLength);
      this._interleavedArrayBuffer = buffer;
      this._interleavedPositionView = null;
      this._interleavedColorView = null;
    }
    if (
      !(this._interleavedPositionView instanceof Float32Array) ||
      this._interleavedPositionView.buffer !== buffer ||
      this._interleavedPositionView.byteOffset !== 0 ||
      this._interleavedPositionView.byteLength !==
        buffer.byteLength
    ) {
      this._interleavedPositionView =
        new Float32Array(buffer);
    }
    if (
      !(this._interleavedColorView instanceof Uint8Array) ||
      this._interleavedColorView.buffer !== buffer ||
      this._interleavedColorView.byteOffset !== 0 ||
      this._interleavedColorView.byteLength !==
        buffer.byteLength
    ) {
      this._interleavedColorView = new Uint8Array(buffer);
    }
    return {
      buffer,
      positionView: this._interleavedPositionView,
      colorView: this._interleavedColorView,
    };
  }

  _setupInterleavedAttributes() {
    const gl = this.gl;
    const STRIDE = 16; // 12 bytes position + 4 bytes color

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.interleaved);

    // Position (location 0): 3 floats at offset 0
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);

    // Color RGBA (location 1): 4 uint8 at offset 12, normalized to 0.0-1.0
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, STRIDE, 12);

    // Note: Alpha is now packed in color as the 4th component, no separate attribute needed
  }

  /**
   * Create or resize the alpha texture for efficient alpha-only updates.
   * Uses R8 format (1 byte per point) instead of rebuilding the 16-byte interleaved buffer.
   * @param {number} pointCount - Number of points to allocate for
   */
  _createAlphaTexture(pointCount) {
    const gl = this.gl;
    if (!Number.isInteger(pointCount) || pointCount < 0) {
      throw new RangeError(
        `HighPerfRenderer alpha texture point count must be a non-negative integer; received ${String(pointCount)}.`
      );
    }
    const previousTexture = this._alphaTexture ?? null;
    const previousTextureByteLength =
      Number.isSafeInteger(this._alphaTextureByteLength)
        ? this._alphaTextureByteLength
        : (
          (this._alphaTexWidth ?? 0) *
          (this._alphaTexHeight ?? 0)
        );
    if (pointCount === 0) {
      this._alphaTexture = null;
      this._alphaTextureByteLength = 0;
      this._alphaTexData = new Uint8Array();
      this._alphaTexStagingData = new Uint8Array();
      this._alphaTexWidth = 0;
      this._alphaTexHeight = 0;
      this._useAlphaTexture = false;
      if (previousTexture) {
        this._queueDataRetirement({
          alphaTexture: previousTexture,
          alphaTextureByteLength: previousTextureByteLength,
        });
        this._drainDataRetirements();
      }
      this._refreshGpuMemoryStats();
      return;
    }

    const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (!Number.isInteger(maxTexSize) || maxTexSize <= 0) {
      throw new Error(
        'HighPerfRenderer received an invalid MAX_TEXTURE_SIZE capability.'
      );
    }
    // Use the complete runtime texture width. An arbitrary smaller cap cuts
    // the representable point count below the device's real MAX_TEXTURE_SIZE²
    // limit and wastes available hardware on large datasets.
    const candidateWidth = Math.min(pointCount, maxTexSize);
    const candidateHeight =
      Math.ceil(pointCount / candidateWidth);

    if (candidateHeight > maxTexSize) {
      throw new RangeError(
        `HighPerfRenderer cannot represent ${pointCount.toLocaleString()} alpha values in the exact ${maxTexSize}x${maxTexSize} texture capacity.`
      );
    }

    // Stage every fallible CPU/GL operation before changing the accepted
    // publication. This also keeps capability/texture failures from erasing a
    // live alpha generation.
    const requiredSize = candidateWidth * candidateHeight;
    let candidateData = this._alphaTexData;
    if (!candidateData || candidateData.length !== requiredSize) {
      candidateData = new Uint8Array(requiredSize);
      // Initialize to fully opaque
      candidateData.fill(255);
    }
    const candidateTexture = gl.createTexture();
    if (!candidateTexture) {
      throw new Error(
        'HighPerfRenderer could not allocate the required alpha texture.'
      );
    }
    let candidateTextureByteLength = 0;
    try {
      gl.bindTexture(gl.TEXTURE_2D, candidateTexture);

      // Use R8 format (single channel, 1 byte per texel) - WebGL2 only.
      this._withNeutralTextureUnpackState(
        1,
        'HighPerfRenderer candidate alpha texture',
        () => {
          gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.R8,
            candidateWidth, candidateHeight, 0,
            gl.RED, gl.UNSIGNED_BYTE, candidateData
          );
          requireCleanWebGLState(
            gl,
            'HighPerfRenderer candidate alpha-texture upload'
          );
        }
      );
      candidateTextureByteLength = requiredSize;

      // Use NEAREST filtering for exact texel fetch (no interpolation).
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        gl.NEAREST
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MAG_FILTER,
        gl.NEAREST
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_S,
        gl.CLAMP_TO_EDGE
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_T,
        gl.CLAMP_TO_EDGE
      );
      gl.bindTexture(gl.TEXTURE_2D, null);
      requireCleanWebGLState(
        gl,
        'HighPerfRenderer alpha-texture publication'
      );
    } catch (error) {
      try {
        gl.bindTexture(gl.TEXTURE_2D, null);
      } catch {
        // The retirement journal below remains authoritative.
      }
      this._queueDataRetirement({
        alphaTexture: candidateTexture,
        alphaTextureByteLength: candidateTextureByteLength,
      });
      const cleanupFailures = this._drainDataRetirements();
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          `HighPerfRenderer alpha-texture publication failed with ${cleanupFailures.length} cleanup error(s).`
        );
      }
      throw error;
    }

    this._alphaTexture = candidateTexture;
    this._alphaTextureByteLength = candidateTextureByteLength;
    this._alphaTexData = candidateData;
    this._alphaTexStagingData = null;
    this._alphaTexWidth = candidateWidth;
    this._alphaTexHeight = candidateHeight;
    if (previousTexture && previousTexture !== candidateTexture) {
      this._queueDataRetirement({
        alphaTexture: previousTexture,
        alphaTextureByteLength: previousTextureByteLength,
      });
      // The new publication remains authoritative if retirement must retry.
      this._drainDataRetirements();
    }
    this._refreshGpuMemoryStats();

    console.log(`[HighPerfRenderer] Created alpha texture: ${candidateWidth}x${candidateHeight} (${pointCount} points)`);
  }

  _uploadAlphaTextureData(data, label) {
    const gl = this.gl;
    if (
      !(data instanceof Uint8Array) ||
      data.length !== this._alphaTexWidth * this._alphaTexHeight ||
      !this._alphaTexture ||
      this._alphaTexWidth <= 0 ||
      this._alphaTexHeight <= 0
    ) {
      throw new Error(
        'HighPerfRenderer alpha texture upload received incomplete exact state.'
      );
    }
    requireCleanWebGLState(
      gl,
      `${label} preflight`
    );
    gl.bindTexture(gl.TEXTURE_2D, this._alphaTexture);
    try {
      this._withNeutralTextureUnpackState(
        1,
        label,
        () => {
          gl.texSubImage2D(
            gl.TEXTURE_2D, 0,
            0, 0, this._alphaTexWidth, this._alphaTexHeight,
            gl.RED, gl.UNSIGNED_BYTE, data
          );
          requireCleanWebGLState(
            gl,
            label
          );
        }
      );
    } finally {
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  /**
   * Update the alpha texture with new alpha values.
   *
   * The accepted R8 owner is never overwritten before WebGL accepts the new
   * generation. A one-byte-per-texel staging owner keeps transient failures
   * retryable without retaining another Float32 point array.
   *
   * @param {Float32Array} alphas - Alpha values (0.0-1.0) for each point
   */
  _updateAlphaTexture(alphas) {
    if (
      !(alphas instanceof Float32Array) ||
      alphas.length !== this.pointCount ||
      !this._alphaTexture ||
      !(this._alphaTexData instanceof Uint8Array)
    ) {
      throw new Error(
        'HighPerfRenderer alpha texture update received incomplete exact state.'
      );
    }
    const n = this.pointCount;
    const requiredSize = this._alphaTexData.length;
    let candidate = this._alphaTexStagingData;
    if (
      !(candidate instanceof Uint8Array) ||
      candidate.length !== requiredSize
    ) {
      candidate = new Uint8Array(requiredSize);
      candidate.fill(255);
    }

    let changed = false;
    for (let i = 0; i < n; i++) {
      const value = alphas[i];
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new RangeError(
          `HighPerfRenderer alpha value at index ${i} must be finite and in [0, 1]; received ${String(value)}.`
        );
      }
      const byte = Math.round(value * 255);
      candidate[i] = byte;
      if (byte !== this._alphaTexData[i]) changed = true;
    }

    if (!changed) {
      this._alphaTexStagingData = candidate;
      this._useAlphaTexture = true;
      return;
    }

    const accepted = this._alphaTexData;
    try {
      this._uploadAlphaTextureData(
        candidate,
        'HighPerfRenderer alpha-value publication'
      );
    } catch (publicationError) {
      try {
        this._uploadAlphaTextureData(
          accepted,
          'HighPerfRenderer alpha-value restoration'
        );
      } catch (restorationError) {
        const failedTexture = this._alphaTexture;
        const failedTextureByteLength =
          this._alphaTextureByteLength;
        this._alphaTexture = null;
        this._alphaTextureByteLength = 0;
        this._useAlphaTexture = false;
        this._queueDataRetirement({
          alphaTexture: failedTexture,
          alphaTextureByteLength: failedTextureByteLength,
        });
        const cleanupFailures = this._drainDataRetirements();
        throw new AggregateError(
          [
            publicationError,
            restorationError,
            ...cleanupFailures,
          ],
          'HighPerfRenderer alpha-value publication failed with incomplete restoration.'
        );
      }
      throw publicationError;
    }

    this._alphaTexData = candidate;
    this._alphaTexStagingData = accepted;
    this._useAlphaTexture = true;
  }

  /**
   * Get LOD index textures for a specific dimension level.
   * @param {number} dimensionLevel - The dimension level (1, 2, or 3)
   * @returns {Array} LOD index textures array for the dimension (may be empty)
   */
  _getLodIndexTexturesForDimension(dimensionLevel) {
    return (
      this._lodIndexTexturesByDimension.get(dimensionLevel) ??
      EMPTY_LOD_PROJECTION
    );
  }

  /**
   * Clear all LOD index textures (all dimensions).
   * Call this when spatial indices or LOD buffers are cleared.
   */
  _clearLodIndexTextures() {
    // Index textures are part of the indivisible per-dimension generation.
    // Clearing this compatibility surface therefore retires the complete
    // generation instead of deleting aliases behind the owner's back.
    this._clearLodBuffers();
  }

  _deleteLodResourcesForDimension(dimensionLevel) {
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer LOD resource dimensionLevel'
    );
    this._ensureLodResourceOwnershipState();
    const owner =
      this._lodResourceOwnersByDimension.get(dim) ?? null;
    const lodBuffers =
      this.lodBuffersByDimension.get(dim) ?? null;
    const lodIndexTextures =
      this._lodIndexTexturesByDimension.get(dim) ?? null;

    // Detach metadata and the sole owner before any fallible deletion. Failed
    // handles remain in the retryable retirement inventory, never in active
    // maps where a future publication could delete them twice.
    this._lodResourceOwnersByDimension.delete(dim);
    this.lodBuffersByDimension.delete(dim);
    this._lodIndexTexturesByDimension.delete(dim);
    this._dirtyLodDimensions?.delete(dim);
    this._refreshGpuMemoryStats();

    if (!owner && !lodBuffers && !lodIndexTextures) return [];
    this._queueDataRetirement({
      buffers: {},
      vao: null,
      pointCount: 0,
      perViewState: null,
      lodResourceOwnersByDimension: owner
        ? new Map([[dim, owner]])
        : new Map(),
      lodBuffersByDimension: lodBuffers
        ? new Map([[dim, lodBuffers]])
        : new Map(),
      lodIndexTexturesByDimension: lodIndexTextures
        ? new Map([[dim, lodIndexTextures]])
        : new Map(),
      alphaTexture: null,
      alphaTexWidth: 0,
      alphaTexHeight: 0,
    });
    return this._drainDataRetirements();
  }

  /**
   * Clear all LOD buffers (all dimensions), properly deleting GL resources.
   * Call this before clearing spatial indices or when data changes.
   * @private
   */
  _clearLodBuffers() {
    this._ensureLodResourceOwnershipState();
    const dimensions = new Set([
      ...this._lodResourceOwnersByDimension.keys(),
      ...this.lodBuffersByDimension.keys(),
      ...this._lodIndexTexturesByDimension.keys(),
    ]);
    for (const dimensionLevel of dimensions) {
      this._deleteLodResourcesForDimension(dimensionLevel);
    }
  }

  updateColors(colors) {
    this._assertOperational('update colors');
    const expectedRGBA = this.pointCount * 4;
    if (!(colors instanceof Uint8Array)) {
      throw new TypeError('HighPerfRenderer colors must be an RGBA Uint8Array.');
    }
    if (colors.length !== expectedRGBA) {
      throw new RangeError(
        `HighPerfRenderer colors must contain exactly ${expectedRGBA} RGBA bytes; received ${colors.length}.`
      );
    }

    this._colors = colors;
    for (const spatialIndex of this.spatialIndices.values()) {
      // Spatial indices own geometry/sample order, but their color generation
      // follows the renderer. This keeps lazily generated LOD levels current.
      spatialIndex.colors = colors;
      const fullDetailLevel = spatialIndex.lodLevels?.at(-1);
      if (fullDetailLevel?.isFullDetail === true) {
        fullDetailLevel.colors = colors;
      }
    }

    // Mark buffers as dirty - actual rebuild deferred to render() to avoid double rebuilds
    this._bufferDirty = true;
    for (const [dimensionLevel, lodBuffers] of this.lodBuffersByDimension) {
      if (lodBuffers.length > 0) {
        this._dirtyLodDimensions.add(dimensionLevel);
      }
    }
  }

  updateAlphas(alphas) {
    this._assertOperational('update alpha values');
    if (!(alphas instanceof Float32Array)) {
      throw new TypeError('HighPerfRenderer alpha values must be a Float32Array.');
    }
    if (alphas.length !== this.pointCount) {
      throw new RangeError(
        `HighPerfRenderer alpha values must contain exactly ${this.pointCount} entries; received ${alphas.length}.`
      );
    }
    // An exact empty dataset has no alpha texture by construction. Publishing
    // its empty alpha generation is still a valid state transition and must not
    // require a synthetic GPU resource.
    if (this.pointCount === 0) {
      this._useAlphaTexture = false;
      this._currentAlphas = alphas;
      return;
    }

    // Use alpha texture for efficient updates (avoids full buffer rebuild)
    // This is ~16x faster: uploading N bytes vs N*16 bytes
    if (!this._alphaTexture) {
      this._createAlphaTexture(this.pointCount);
    }
    this._updateAlphaTexture(alphas);
    this._currentAlphas = alphas;
  }

  /** Get current colors array reference (for comparison) */
  getCurrentColors() {
    return this._colors;
  }

  /**
   * Adopt an equivalent caller-private Float32 owner after its R8 generation
   * has already been accepted. This performs no GPU work and exists so the
   * viewer can sever aliases to mutable application-state arrays.
   */
  _adoptCurrentAlphasOwner(alphas) {
    if (
      !(alphas instanceof Float32Array) ||
      alphas.length !== this.pointCount
    ) {
      throw new TypeError(
        'HighPerfRenderer alpha owner must be one exact Float32 point array.'
      );
    }
    this._currentAlphas = alphas;
  }

  /** Get current alphas array reference (for comparison) */
  getCurrentAlphas() {
    return this._currentAlphas;
  }

  /**
   * Force immediate buffer rebuild (use sparingly, prefer letting render() handle it)
   */
  flushBufferUpdates(dimensionLevel) {
    this._assertOperational('flush point buffers');
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer buffer-flush dimensionLevel'
    );
    if (this._bufferDirty) {
      this._rebuildInterleavedBuffer();
      this._bufferDirty = false;
    }

    if (this._dirtyLodDimensions.has(dim)) {
      this._rebuildLODBuffersWithCurrentData(dim);
      this._dirtyLodDimensions.delete(dim);
    }
  }

  _rebuildInterleavedBuffer() {
    const gl = this.gl;
    requireCleanWebGLState(
      gl,
      'HighPerfRenderer full-detail color publication preflight'
    );
    const n = this.pointCount;
    const positions = this._positions;
    const colors = this._colors; // Now Uint8Array with RGBA
    const requiredSize = n * 16;

    const {
      buffer,
      positionView,
      colorView,
    } = this._ensureSharedPackingScratch(
      requiredSize,
      'HighPerfRenderer full-detail color packing'
    );

    // Build interleaved data: [x,y,z (float32), r,g,b,a (uint8)] - 16 bytes per point
    for (let i = 0; i < n; i++) {
      const srcIdx = i * 3;
      const floatOffset = i * 4;
      const byteOffset = i * 16 + 12;

      positionView[floatOffset] = positions[srcIdx];
      positionView[floatOffset + 1] = positions[srcIdx + 1];
      positionView[floatOffset + 2] = positions[srcIdx + 2];

      // Colors already in uint8 RGBA format
      const colorSrcIdx = i * 4;
      colorView[byteOffset] = colors[colorSrcIdx];
      colorView[byteOffset + 1] = colors[colorSrcIdx + 1];
      colorView[byteOffset + 2] = colors[colorSrcIdx + 2];
      colorView[byteOffset + 3] = colors[colorSrcIdx + 3];
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.interleaved);
    gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.DYNAMIC_DRAW);
    requireCleanWebGLState(
      gl,
      'HighPerfRenderer full-detail color publication'
    );
    this._interleavedGpuByteLength = requiredSize;
    this._refreshGpuMemoryStats();
  }

  _rebuildLODBuffersWithCurrentData(dimensionLevel) {
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer LOD rebuild dimensionLevel'
    );
    const gl = this.gl;
    const colors = this._colors;
    requireCleanWebGLState(
      gl,
      `HighPerfRenderer ${dim}D LOD color publication preflight`
    );

    this._ensureLodResourceOwnershipState();
    const spatialIndex = this.spatialIndices.get(dim);
    const lodBuffers = this.lodBuffersByDimension.get(dim) || [];
    const owner =
      this._lodResourceOwnersByDimension.get(dim) ?? null;
    if (!spatialIndex || !lodBuffers.length) {
      throw new Error(
        `HighPerfRenderer cannot publish dirty ${dim}D LOD colors without exact spatial-index and buffer owners.`
      );
    }
    const sourcePositions = spatialIndex.positions;
    if (
      !(sourcePositions instanceof Float32Array) ||
      sourcePositions !== this._positions ||
      sourcePositions.length !== this.pointCount * 3
    ) {
      throw new Error(
        `HighPerfRenderer cannot publish dirty ${dim}D LOD colors without the exact ${this.pointCount}-point spatial-index position generation.`
      );
    }
    if (
      !(colors instanceof Uint8Array) ||
      colors.length !== this.pointCount * 4
    ) {
      throw new Error(
        `HighPerfRenderer cannot publish dirty ${dim}D LOD colors without exact RGBA source bytes.`
      );
    }

    const reducedLevels = spatialIndex.lodLevels.slice(0, -1);
    if (reducedLevels.length === 0) return;
    const maximumLevel = reducedLevels.at(-1);
    const maximumIndices = maximumLevel?.indices;
    const requiredSize =
      (maximumLevel?.pointCount ?? -1) * 16;
    if (
      !owner ||
      owner.spatialIndex !== spatialIndex ||
      owner.maximumIndices !== maximumIndices ||
      owner.pointCount !== this.pointCount ||
      owner.liveGeometryGeneration !==
        this._liveGeometryGeneration ||
      !(maximumIndices instanceof Uint32Array) ||
      maximumIndices.length !== maximumLevel.pointCount ||
      owner.compactByteLength !== requiredSize ||
      !owner.compactBuffer ||
      lodBuffers.some((metadata, levelIndex) => (
        metadata.isFullDetail !== true &&
        (
          metadata.generationToken !== owner.generationToken ||
          metadata.buffer !== owner.compactBuffer ||
          metadata.vao !== owner.compactVao ||
          metadata.originalIndexBuffer !==
            owner.topologyOwner?.originalIndexBuffer ||
          metadata.originalIndexCount !==
            spatialIndex.lodLevels[levelIndex]?.pointCount
        )
      ))
    ) {
      throw new Error(
        `HighPerfRenderer ${dim}D dirty LOD color publication has inconsistent generation ownership.`
      );
    }

    // Main and compact uploads are sequential and WebGL consumes client data
    // before returning. Repacking the shared full-detail client allocation
    // therefore preserves both GPU generations without a second 0.8N cache.
    const scratch = this._ensureSharedPackingScratch(
      requiredSize,
      `HighPerfRenderer ${dim}D compact LOD color packing`
    );
    for (let compactIndex = 0; compactIndex < maximumIndices.length; compactIndex++) {
      const originalIndex = maximumIndices[compactIndex];
      if (originalIndex >= this.pointCount) {
        throw new RangeError(
          `HighPerfRenderer ${dim}D maximum-prefix original index ${originalIndex} is outside ${this.pointCount} points.`
        );
      }
      const floatOffset = compactIndex * 4;
      const byteOffset = compactIndex * 16 + 12;
      const positionOffset = originalIndex * 3;
      const colorOffset = originalIndex * 4;
      scratch.positionView[floatOffset] =
        sourcePositions[positionOffset];
      scratch.positionView[floatOffset + 1] =
        sourcePositions[positionOffset + 1];
      scratch.positionView[floatOffset + 2] =
        sourcePositions[positionOffset + 2];
      scratch.colorView[byteOffset] = colors[colorOffset];
      scratch.colorView[byteOffset + 1] = colors[colorOffset + 1];
      scratch.colorView[byteOffset + 2] = colors[colorOffset + 2];
      scratch.colorView[byteOffset + 3] = colors[colorOffset + 3];
    }
    const uploadData = scratch.buffer.byteLength === requiredSize
      ? scratch.buffer
      : new Uint8Array(scratch.buffer, 0, requiredSize);

    try {
      gl.bindBuffer(gl.ARRAY_BUFFER, owner.compactBuffer);
      // WebGL 2 bufferData guarantee: if an error is generated, the buffer's
      // size is unmodified and no data is written. Immediate sticky-error
      // validation therefore makes this in-place recolor a real transaction.
      gl.bufferData(gl.ARRAY_BUFFER, uploadData, gl.DYNAMIC_DRAW);
      requireCleanWebGLState(
        gl,
        `HighPerfRenderer ${dim}D LOD color publication`
      );
    } finally {
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  }

  setFogRange(near, far) {
    this._assertOperational('set the fog range');
    this.fogNear = near;
    this.fogFar = far;
  }

  /**
   * Compute the exact automatic fog range without mutating renderer state.
   *
   * `overrideBounds` is the immutable bounds owner published for a custom
   * snapshot geometry. A null override selects the live geometry's cached
   * bounding sphere. Keeping this calculation pure lets non-render consumers
   * capture the range for one pane without racing the renderer-wide fog
   * scalars that are reused by subsequent panes.
   *
   * @param {Array<number>|Float32Array} cameraPosition
   * @param {{
   *   minX: number,
   *   maxX: number,
   *   minY: number,
   *   maxY: number,
   *   minZ: number,
   *   maxZ: number
   * }|null} [overrideBounds=null]
   * @param {{fogNear: number, fogFar: number}|HighPerfRenderer} target
   * @returns {{fogNear: number, fogFar: number}|HighPerfRenderer}
   */
  _writeFogRange(cameraPosition, overrideBounds, target) {
    let centerX;
    let centerY;
    let centerZ;
    let radius;

    if (overrideBounds !== null) {
      const minX = overrideBounds.minX;
      const maxX = overrideBounds.maxX;
      const minY = overrideBounds.minY;
      const maxY = overrideBounds.maxY;
      const minZ = overrideBounds.minZ;
      const maxZ = overrideBounds.maxZ;
      const dx = maxX - minX;
      const dy = maxY - minY;
      const dz = maxZ - minZ;
      centerX = (minX + maxX) * 0.5;
      centerY = (minY + maxY) * 0.5;
      centerZ = (minZ + maxZ) * 0.5;
      radius = Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5;
    } else {
      const sphere = this._boundingSphere;
      if (!sphere) {
        throw new Error(
          'HighPerfRenderer fog range requires published live point bounds.'
        );
      }
      centerX = sphere.center[0];
      centerY = sphere.center[1];
      centerZ = sphere.center[2];
      radius = sphere.radius;
    }

    const dx = cameraPosition[0] - centerX;
    const dy = cameraPosition[1] - centerY;
    const dz = cameraPosition[2] - centerZ;
    const distToCenter = Math.sqrt(dx * dx + dy * dy + dz * dz);
    target.fogNear = Math.max(0, distToCenter - radius);
    target.fogFar = distToCenter + radius;
    return target;
  }

  /**
   * Return one pane's exact automatic fog range without changing the shared
   * renderer fog uniforms. Snapshot bounds are renderer-owned and remain
   * valid even after the live geometry advances to a later generation.
   *
   * @param {string} viewId
   * @param {Array<number>|Float32Array} cameraPosition
   * @returns {{fogNear: number, fogFar: number}}
   */
  getViewFogRange(viewId, cameraPosition) {
    const exactViewId = requireViewId(
      viewId,
      'HighPerfRenderer fog-range viewId'
    );
    requireNumericVector(
      cameraPosition,
      3,
      'HighPerfRenderer fog camera position'
    );
    if (exactViewId === 'live') {
      if (
        !(this._positions instanceof Float32Array) ||
        !Number.isSafeInteger(this._liveGeometryGeneration) ||
        this._liveGeometryGeneration <= 0
      ) {
        throw new RangeError(
          'HighPerfRenderer live view has no published fog owner.'
        );
      }
      const sphere = this._boundingSphere;
      if (
        sphere === null ||
        typeof sphere !== 'object' ||
        !Array.isArray(sphere.center) ||
        sphere.center.length !== 3
      ) {
        throw new Error(
          'HighPerfRenderer fog range requires published live point bounds.'
        );
      }
      requireNumericVector(
        sphere.center,
        3,
        'HighPerfRenderer live fog center'
      );
      requireFiniteNumber(
        sphere.radius,
        'HighPerfRenderer live fog radius'
      );
      if (sphere.radius < 0) {
        throw new RangeError(
          'HighPerfRenderer live fog radius must be non-negative.'
        );
      }
      return Object.freeze(
        this._writeFogRange(cameraPosition, null, {
          fogNear: 0,
          fogFar: 0
        })
      );
    }
    const snapshot = this.snapshotBuffers.get(exactViewId);
    if (!snapshot) {
      throw new RangeError(
        `HighPerfRenderer view "${exactViewId}" does not exist.`
      );
    }
    if (this._snapshotUsesLiveGeometry(snapshot)) {
      // renderWithSnapshot intentionally uses the live sphere for a snapshot
      // that still aliases the live geometry generation. This preserves exact
      // parity with any dimension-aware padding owned by the live spatial
      // index rather than silently switching export/presentation to the
      // snapshot's unpadded min/max bounds.
      return this.getViewFogRange('live', cameraPosition);
    }
    if (
      snapshot.bounds === null ||
      typeof snapshot.bounds !== 'object' ||
      Array.isArray(snapshot.bounds)
    ) {
      throw new Error(
        `HighPerfRenderer snapshot "${exactViewId}" has no exact fog bounds.`
      );
    }
    const bounds = snapshot.bounds;
    const minX = requireFiniteNumber(
      bounds.minX,
      'HighPerfRenderer fog bounds minX'
    );
    const maxX = requireFiniteNumber(
      bounds.maxX,
      'HighPerfRenderer fog bounds maxX'
    );
    const minY = requireFiniteNumber(
      bounds.minY,
      'HighPerfRenderer fog bounds minY'
    );
    const maxY = requireFiniteNumber(
      bounds.maxY,
      'HighPerfRenderer fog bounds maxY'
    );
    const minZ = requireFiniteNumber(
      bounds.minZ,
      'HighPerfRenderer fog bounds minZ'
    );
    const maxZ = requireFiniteNumber(
      bounds.maxZ,
      'HighPerfRenderer fog bounds maxZ'
    );
    if (minX > maxX || minY > maxY || minZ > maxZ) {
      throw new RangeError(
        'HighPerfRenderer fog bounds minima must not exceed their maxima.'
      );
    }
    return Object.freeze(
      this._writeFogRange(cameraPosition, bounds, {
        fogNear: 0,
        fogFar: 0
      })
    );
  }

  _computeBoundingSphere(positions) {
    const count = positions.length / 3;
    if (count === 0) return { center: [0, 0, 0], radius: 1 };

    // Compute bounding box
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      const x = positions[idx];
      const y = positions[idx + 1];
      const z = positions[idx + 2];

      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    // Compute center and radius from bounding box
    const centerX = (minX + maxX) * 0.5;
    const centerY = (minY + maxY) * 0.5;
    const centerZ = (minZ + maxZ) * 0.5;

    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5;

    return { center: [centerX, centerY, centerZ], radius };
  }

  /**
   * Auto-compute fog range based on camera position and bounding sphere.
   * @param {Array} cameraPosition - Camera position [x, y, z]
   * @param {Object} [overrideBounds] - Optional bounds to use instead of global (for snapshot views with custom positions)
   */
  autoComputeFogRange(cameraPosition, overrideBounds = null) {
    this._assertOperational('compute the automatic fog range');
    this._writeFogRange(
      cameraPosition,
      overrideBounds,
      this
    );
  }

  /**
   * Extract frustum planes from MVP matrix.
   * @param {Float32Array} mvpMatrix - Model-View-Projection matrix
   * @param {Array<Float32Array>} targetPlanes - Exact per-view planes array to write to
   * @param {Object} [overrideBounds] - Optional bounds override for view-specific positions (e.g., 2D views).
   *   Format: { minX, maxX, minY, maxY, minZ, maxZ }. When provided, frustum margins use these bounds
   *   instead of global bounding sphere.
   * @returns {Array<Float32Array>} The 6 frustum planes
   */
  extractFrustumPlanes(mvpMatrix, targetPlanes, overrideBounds = null) {
    this._assertOperational('extract frustum planes');
    const m = mvpMatrix;
    if (
      !Array.isArray(targetPlanes) ||
      targetPlanes.length !== 6
    ) {
      throw new TypeError(
        'HighPerfRenderer frustum extraction requires six exact Float32Array(4) target planes.'
      );
    }
    for (let planeIndex = 0; planeIndex < 6; planeIndex++) {
      const plane = targetPlanes[planeIndex];
      if (!(plane instanceof Float32Array) || plane.length !== 4) {
        throw new TypeError(
          'HighPerfRenderer frustum extraction requires six exact Float32Array(4) target planes.'
        );
      }
    }
    const planes = targetPlanes;

    // Left plane
    planes[0][0] = m[3] + m[0];
    planes[0][1] = m[7] + m[4];
    planes[0][2] = m[11] + m[8];
    planes[0][3] = m[15] + m[12];

    // Right plane
    planes[1][0] = m[3] - m[0];
    planes[1][1] = m[7] - m[4];
    planes[1][2] = m[11] - m[8];
    planes[1][3] = m[15] - m[12];

    // Bottom plane
    planes[2][0] = m[3] + m[1];
    planes[2][1] = m[7] + m[5];
    planes[2][2] = m[11] + m[9];
    planes[2][3] = m[15] + m[13];

    // Top plane
    planes[3][0] = m[3] - m[1];
    planes[3][1] = m[7] - m[5];
    planes[3][2] = m[11] - m[9];
    planes[3][3] = m[15] - m[13];

    // Near plane
    planes[4][0] = m[3] + m[2];
    planes[4][1] = m[7] + m[6];
    planes[4][2] = m[11] + m[10];
    planes[4][3] = m[15] + m[14];

    // Far plane
    planes[5][0] = m[3] - m[2];
    planes[5][1] = m[7] - m[6];
    planes[5][2] = m[11] - m[10];
    planes[5][3] = m[15] - m[14];

    // Compute scale-aware margin based on bounding sphere or override bounds
    // This ensures the margin is appropriate regardless of scene scale
    // For views with custom positions (different dimensions), use overrideBounds
    let sceneScale;
    if (overrideBounds) {
      // Compute radius from override bounds (handles 1D/2D views correctly)
      const dx = overrideBounds.maxX - overrideBounds.minX;
      const dy = overrideBounds.maxY - overrideBounds.minY;
      const dz = overrideBounds.maxZ - overrideBounds.minZ;
      sceneScale = Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5;
    } else {
      let sphere = this._boundingSphere;
      if (!sphere) {
        const spatialIndex = this.spatialIndices.get(this.currentDimensionLevel);
        sphere = spatialIndex ? spatialIndex.getBoundingSphere() : null;
      }
      sceneScale = sphere ? sphere.radius : 1.0;
    }
    // Base margin of 2% of scene scale, minimum 0.1 for small scenes
    // Keep margins small for effective culling
    const baseMargin = Math.max(0.1, sceneScale * 0.02);

    // Normalize planes and apply scale-aware margin
    for (let i = 0; i < 6; i++) {
      const plane = planes[i];
      const len = Math.sqrt(plane[0] * plane[0] + plane[1] * plane[1] + plane[2] * plane[2]);
      if (len > 0) {
        plane[0] /= len;
        plane[1] /= len;
        plane[2] /= len;
        plane[3] /= len;
      }
      // Expand planes outward - positive margin pushes planes away from center, enlarging the frustum
      // Use small margins to allow effective culling while preventing edge-case popping
      let planeMargin;
      if (i === 5) {
        // Far plane: small margin to prevent popping at distance
        planeMargin = baseMargin * 0.5;
      } else if (i === 4) {
        // Near plane: tiny margin
        planeMargin = baseMargin * 0.3;
      } else {
        // Side planes (left, right, top, bottom): tiny margin for edge cases
        planeMargin = baseMargin * 0.2;
      }
      plane[3] += planeMargin;
    }

    return planes;
  }

  render(params, returnStats = true) {
    this._assertOperational('render');
    if (typeof returnStats !== 'boolean') {
      throw new TypeError(
        'HighPerfRenderer render returnStats must be a boolean.'
      );
    }
    requireRenderContract(params);
    if (!this.pointCount || this.pointCount === 0) {
      return returnStats ? this.stats : undefined;
    }

    if (!this.activeProgram) {
      throw new Error('HighPerfRenderer active shader program is unavailable.');
    }

    if (!this.buffers.interleaved) {
      throw new Error('HighPerfRenderer point buffer is unavailable.');
    }

    const dimensionLevel = params.dimensionLevel;
    // Flush any pending buffer updates (deferred from updateColors/updateAlphas)
    // Full detail is shared; reduced LOD data is published only for the exact
    // dimension this render is about to consume.
    if (
      this._bufferDirty ||
      this._dirtyLodDimensions.has(dimensionLevel)
    ) {
      this.flushBufferUpdates(dimensionLevel);
    }

    const {
      mvpMatrix,
      viewMatrix,
      modelMatrix,
      projectionMatrix,
      pointSize,
      sizeAttenuation,
      viewportHeight,
      fov,
      lightingStrength,
      fogDensity,
      fogColor,
      lightDir,
      cameraDistance,
      cameraPosition,
      forceLOD,
      quality,
      viewId,
      overrideBounds
    } = params;

    // Get per-view state for frustum culling and LOD caching
    const viewState = this._getViewState(viewId);

    const gl = this.gl;
    const frameStart = performance.now();
    configureStraightAlphaBlending(gl);

    if (!this._firstRenderDone) {
      console.log('[HighPerfRenderer] First render frame:', {
        pointCount: this.pointCount,
        activeQuality: this.activeQuality,
        pointSize: pointSize,
        viewportHeight: viewportHeight,
        useFrustumCulling: this.useFrustumCulling,
        useAdaptiveLOD: this.useAdaptiveLOD,
        hasSpatialIndex: this.spatialIndices.size > 0
      });
      this._firstRenderDone = true;
    }

    // Auto-compute fog range (use overrideBounds for correct fog in non-3D views)
    if (params.autoFog !== false) {
      this.autoComputeFogRange(cameraPosition, overrideBounds);
    }

    // Set quality if changed
    if (quality !== this.activeQuality) {
      this.setQuality(quality);
    }

    // Get the correct spatial index for this view's dimension level
    // Each dimension (1D, 2D, 3D) needs its own spatial index for correct LOD/frustum culling
    const needsSpatialIndex = this._needsSpatialIndex(forceLOD);
    const spatialIndex = needsSpatialIndex
      ? this._getOrBuildSpatialIndexForDimension(
        dimensionLevel,
        false,
        this._needsLodResources(forceLOD)
      )
      : null;
    const lodBuffersForDim =
      this._getLodBuffersForDimension(dimensionLevel);

    // Select LOD level based on whether LOD is enabled
    // When LOD is disabled, forceLODLevel is ignored - only params.forceLOD is respected
    // This ensures disabling LOD always returns to full detail (unless explicitly overridden per-render)
    let lodLevel;
    if (this.useAdaptiveLOD) {
      // LOD enabled: Priority is this.forceLODLevel > params.forceLOD > adaptive
      lodLevel = this.forceLODLevel >= 0 ? this.forceLODLevel : forceLOD;
      if (lodLevel < 0 && spatialIndex) {
        // Pass per-view lastLodLevel for hysteresis (prevents oscillation per-view)
        lodLevel = spatialIndex.getLODLevel(
          cameraDistance,
          viewportHeight,
          viewState.lastLodLevel,
          dimensionLevel,
          overrideBounds
        );
      }
    } else {
      // LOD disabled: only respect explicit per-render forceLOD, otherwise full detail
      lodLevel = forceLOD >= 0 ? forceLOD : -1;
    }

    // Always update per-view LOD level for highlight rendering and other consumers
    // This must happen after all LOD selection logic (forced, adaptive, or disabled)
    // NOTE: lastDimensionLevel is NOT set here - it's handled inside _checkFrustumCacheValid
    // to properly detect dimension changes and invalidate the frustum cache
    viewState.lastLodLevel = lodLevel;

    if (
      lodLevel >= 0 &&
      (!Number.isInteger(lodLevel) || !lodBuffersForDim[lodLevel])
    ) {
      throw new RangeError(
        `HighPerfRenderer LOD level ${String(lodLevel)} is unavailable for ${dimensionLevel}D view "${viewId}".`
      );
    }
    const useFullDetail =
      lodLevel < 0 || lodBuffersForDim[lodLevel].isFullDetail === true;

    // Debug LOD selection - only log when level changes (per-view tracking)
    if (viewState.prevLodLevel !== lodLevel && spatialIndex && (this.useAdaptiveLOD || this.forceLODLevel >= 0)) {
      const lodBuf = lodBuffersForDim[lodLevel];
      const pointCount = lodBuf ? lodBuf.pointCount : this.pointCount;
      const mode = this.forceLODLevel >= 0 ? 'forced' : 'auto';
      if (DEBUG_LOD_FRUSTUM) console.log(`[LOD] View ${viewId}: level ${viewState.prevLodLevel ?? 'init'} → ${lodLevel} (${pointCount.toLocaleString()} pts, ${mode})`);
      viewState.prevLodLevel = lodLevel;
    }

    // Frustum culling can be combined with LOD for maximum performance
    // Each view gets independent frustum culling via its own per-view state and frustum planes
    if (this.useFrustumCulling && spatialIndex) {
      // For 2D data, disable depth testing
      // entirely to prevent draw-order artifacts. When all points have the same Z, depth testing
      // causes visual differences at quadtree boundaries because frustum culling changes the
      // draw order (spatially grouped vs original). Disabling depth writes alone is insufficient.
      const disableDepth = dimensionLevel <= DEPTH_TEST_DIMENSION_THRESHOLD;
      let frustumChanged = false;
      let operationError = null;
      try {
        // Plane/key publication and every downstream consumer form one
        // transaction. Any failure after publication rejects the new key so
        // the next stable frame recomputes exact visibility.
        frustumChanged = this._prepareFrustumCache(
          mvpMatrix,
          viewState,
          dimensionLevel,
          overrideBounds
        );
        const frustumPlanes = viewState.frustumPlanes;

        // Debug: log render path on first frame or when path changes.
        const renderPath = useFullDetail ? 'frustum-only' : 'LOD+frustum';
        if (viewState._lastRenderPath !== renderPath) {
          console.log(`[Render] View ${viewId}: ${renderPath} (lodLevel=${lodLevel}, useAdaptiveLOD=${this.useAdaptiveLOD}, lodBuffers=${lodBuffersForDim.length}, dim=${dimensionLevel})`);
          viewState._lastRenderPath = renderPath;
        }
        if (disableDepth) {
          gl.disable(gl.DEPTH_TEST);
        }

        if (useFullDetail) {
          this._renderWithFrustumCulling(
            params,
            frustumPlanes,
            viewState,
            spatialIndex,
            frustumChanged
          );
        } else {
          // LOD active: combined LOD + frustum culling for maximum performance
          // Ensure the spatial index owns its shared leaf/rank mapping.
          spatialIndex.ensureLodNodeMappings();
          this._renderLODWithFrustumCulling(
            lodLevel,
            params,
            frustumPlanes,
            viewState,
            spatialIndex,
            lodBuffersForDim,
            frustumChanged
          );
        }
      } catch (error) {
        operationError = error;
        if (frustumChanged) {
          // Plane/key publication precedes traversal by design. A downstream
          // failure must therefore reject that key as well as any partial
          // visibility state, so the next stable frame retries exact culling.
          this._invalidateViewStateRecord(viewState);
        }
      }

      let restorationError = null;
      // DEPTH_TEST enabled is renderer-owned baseline state. Preserve it even
      // when preparation, traversal, upload, shader state, or drawing throws.
      try {
        if (disableDepth) {
          gl.enable(gl.DEPTH_TEST);
        }
      } catch (error) {
        restorationError = error;
      }
      if (operationError !== null) {
        if (restorationError !== null) {
          throw new AggregateError(
            [operationError, restorationError],
            'HighPerfRenderer live frustum render and depth-state restoration both failed.'
          );
        }
        throw operationError;
      }
      if (restorationError !== null) {
        throw restorationError;
      }

      this._publishFrameTiming(viewState, frameStart);
      return returnStats ? this.getStats(viewId) : undefined;
    }

    // Reset frustum culling stats when not using it
    this.stats.frustumCulled = false;
    this.stats.cullPercent = 0;

    // For 2D data, disable depth testing to prevent draw-order artifacts
    // (consistent with frustum culling path)
    const disableDepth = dimensionLevel <= DEPTH_TEST_DIMENSION_THRESHOLD;
    let operationError = null;
    try {
      if (disableDepth) {
        gl.disable(gl.DEPTH_TEST);
      }
      if (useFullDetail) {
        this._renderFullDetail(params, viewState);
      } else {
        this._renderLOD(lodLevel, params, viewState);
      }
    } catch (error) {
      operationError = error;
    }
    let restorationError = null;
    try {
      if (disableDepth) {
        gl.enable(gl.DEPTH_TEST);
      }
    } catch (error) {
      restorationError = error;
    }
    settlePointDraw(
      operationError,
      restorationError,
      'HighPerfRenderer live direct render'
    );

    // Publish the exact dimension used by non-frustum LOD consumers.
    // This is done after rendering to ensure accurate per-view tracking without breaking cache invalidation
    viewState.lastDimensionLevel = dimensionLevel;

    this._publishFrameTiming(viewState, frameStart);
    return returnStats ? this.getStats(viewId) : undefined;
  }

  _renderWithFrustumCulling(
    params,
    frustumPlanes,
    viewState,
    spatialIndex,
    frustumChanged
  ) {
    const gl = this.gl;
    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir,
      viewId,
      dimensionLevel
    } = params;

    // Validate each exact spatial owner once. A renderer-global boolean would
    // incorrectly trust same-sized replacement trees and other dimensions.
    this._ensureLodResourceOwnershipState();
    if (
      spatialIndex &&
      !this._validatedSpatialIndices.has(spatialIndex)
    ) {
      const validation = spatialIndex.validatePointCount();
      if (!validation.valid) {
        console.error(`[FrustumCulling] Spatial index validation failed - some points may be missing`);
      }
      this._validatedSpatialIndices.add(spatialIndex);
    }

    const spatialOwnerChanged =
      viewState.cachedVisibleSpatialOwner !== spatialIndex ||
      viewState.cachedVisibleSpatialRoot !== spatialIndex.root ||
      !Array.isArray(viewState.cachedVisibleNodes);
    const fullDetailCacheChanged =
      viewState.cachedLodIsCulled === true ||
      viewState.cachedLodLevel !== -1 ||
      viewState.cachedLodDimension !== dimensionLevel ||
      viewState.cachedLodMappingGeneration !== null ||
      !(viewState.cachedVisibleIndices instanceof Uint32Array) ||
      viewState.cachedCulledCount !==
        viewState.cachedVisibleIndices?.length ||
      (
        viewState.cachedCulledCount > 0 &&
        viewState.indexBufferSize !== viewState.cachedCulledCount
      );
    let visibleNodes = null;
    let orderedAdmissionChanged = false;

    if (
      frustumChanged ||
      spatialOwnerChanged ||
      fullDetailCacheChanged
    ) {
      const candidate = this._collectVisibleNodeCandidate(
        viewState,
        spatialIndex.root,
        frustumPlanes
      );
      const canReuseAcceptedEbo =
        frustumChanged &&
        !spatialOwnerChanged &&
        !fullDetailCacheChanged &&
        this._hasSameOrderedVisibleNodes(
          viewState.cachedVisibleNodes,
          candidate
        );
      if (canReuseAcceptedEbo) {
        this._recycleVisibleNodeCandidate(viewState, candidate);
      } else {
        visibleNodes = candidate;
        orderedAdmissionChanged = true;
      }
    }

    const needsUpdate =
      spatialOwnerChanged ||
      fullDetailCacheChanged ||
      orderedAdmissionChanged;

    if (needsUpdate) {
      try {
        if (!Array.isArray(visibleNodes)) {
          throw new Error(
            `HighPerfRenderer frustum leaf admission is unavailable for view "${viewId}".`
          );
        }
        if (visibleNodes.length === 0) {
          const emptyIndices =
            viewState.cachedVisibleIndices instanceof Uint32Array &&
            viewState.cachedVisibleIndices.length === 0
              ? viewState.cachedVisibleIndices
              : new Uint32Array(0);
          this._acceptVisibleNodeCandidate(viewState, visibleNodes);
          viewState.cachedVisibleSpatialOwner = spatialIndex;
          viewState.cachedVisibleSpatialRoot = spatialIndex.root;
          viewState.cachedCulledCount = 0;
          viewState.cachedVisibleIndices = emptyIndices;
          viewState.cachedLodVisibleIndices = null;
          viewState.cachedLodLevel = -1;
          viewState.cachedLodDimension = dimensionLevel;
          viewState.cachedLodIsCulled = false;
          viewState.cachedLodMappingGeneration = null;
          this._writeStats(viewState, 0, -1, 0, true, 100);
          return;
        }

        // Count total visible points first to determine buffer size
        let totalVisible = 0;
        for (const node of visibleNodes) {
          if (node.indices) totalVisible += node.indices.length;
        }

        // Per-view full-detail scratch follows the same transactional
        // grow/shrink policy as reduced LOD scratch.
        this._ensureVisibleIndexScratch(
          viewState,
          totalVisible,
          false
        );

        // Fill the pooled buffer with visible indices
        let writeOffset = 0;
        for (const node of visibleNodes) {
          if (node.indices) {
            viewState.visibleIndicesBuffer.set(node.indices, writeOffset);
            writeOffset += node.indices.length;
          }
        }

        // Create a view of only the used portion (no backing-store allocation)
        const visibleIndices = viewState.visibleIndicesBuffer.subarray(0, totalVisible);

        const visibleRatio = totalVisible / this.pointCount;
        const cullPercent = ((1 - visibleRatio) * 100);
        const visibleCount = visibleIndices.length;

        // Log only on significant change (>10% of total points)
        if (DEBUG_LOD_FRUSTUM && this._isSignificantChange(viewState.lastVisibleCount, visibleCount, this.pointCount)) {
          console.log(`[FrustumCulling] View ${viewId}: ${visibleCount.toLocaleString()}/${this.pointCount.toLocaleString()} visible (${cullPercent.toFixed(1)}% culled)`);
          viewState.lastVisibleCount = visibleCount;
        }

        // GPU acceptance is the publication boundary. Until bufferData
        // succeeds, the prior leaf list and CPU view remain authoritative.
        this._uploadToViewIndexBuffer(viewState, visibleIndices);
        this._acceptVisibleNodeCandidate(viewState, visibleNodes);
        viewState.cachedVisibleSpatialOwner = spatialIndex;
        viewState.cachedVisibleSpatialRoot = spatialIndex.root;
        viewState.cachedCulledCount = visibleIndices.length;
        viewState.cachedVisibleIndices = visibleIndices;
        viewState.cachedLodVisibleIndices = null;
        viewState.cachedLodLevel = -1;
        viewState.cachedLodDimension = dimensionLevel;
        viewState.cachedLodIsCulled = false;
        viewState.cachedLodMappingGeneration = null;
        this.stats.frustumCulled = true;
        this.stats.cullPercent = cullPercent;
      } catch (error) {
        this._invalidateViewStateRecord(viewState);
        throw error;
      }
    }

    if (!(viewState.cachedVisibleIndices instanceof Uint32Array)) {
      throw new Error(
        `HighPerfRenderer frustum visibility state is unavailable for view "${viewId}".`
      );
    }
    if (viewState.cachedVisibleIndices.length === 0) {
      this._writeStats(viewState, 0, -1, 0, true, 100);
      return;
    }

    const program = this.activeProgram;
    const uniforms = this.uniformLocations.get(this.activeQuality);

    if (!program || !uniforms) {
      throw new Error(
        `HighPerfRenderer "${this.activeQuality}" full-detail/frustum shader state is unavailable.`
      );
    }

    gl.useProgram(program);

    if (uniforms.u_mvpMatrix !== null) {
      gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    }
    if (uniforms.u_viewMatrix !== null) {
      gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
    }
    if (uniforms.u_modelMatrix !== null) {
      gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
    }
    if (uniforms.u_projectionMatrix !== null && projectionMatrix) {
      gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
    }
    if (uniforms.u_pointSize !== null) {
      gl.uniform1f(uniforms.u_pointSize, pointSize);
    }
    if (uniforms.u_sizeAttenuation !== null) {
      gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    }
    if (uniforms.u_viewportHeight !== null) {
      gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
    }
    if (uniforms.u_fov !== null) {
      gl.uniform1f(uniforms.u_fov, fov);
    }
    if (uniforms.u_lightingStrength !== null) {
      gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    }
    if (uniforms.u_fogDensity !== null) {
      gl.uniform1f(uniforms.u_fogDensity, fogDensity);
    }
    if (uniforms.u_fogNear !== null) {
      gl.uniform1f(uniforms.u_fogNear, this.fogNear);
    }
    if (uniforms.u_fogFar !== null) {
      gl.uniform1f(uniforms.u_fogFar, this.fogFar);
    }
    if (uniforms.u_fogColor !== null) {
      gl.uniform3fv(uniforms.u_fogColor, fogColor);
    }
    if (uniforms.u_lightDir !== null) {
      gl.uniform3fv(uniforms.u_lightDir, lightDir);
    }

    // Defensive check: ensure index buffer is valid before drawing
    // If indexBufferSize doesn't match cachedCulledCount, the buffer might be stale
    if (viewState.indexBufferSize !== viewState.cachedCulledCount) {
      throw new Error(
        `HighPerfRenderer frustum index buffer for view "${viewId}" contains ` +
        `${viewState.indexBufferSize} entries but ${viewState.cachedCulledCount} are required.`
      );
    }

    let operationError = null;
    try {
      // With indexed drawing gl_VertexID is the original point index, which
      // addresses the canonical alpha texture directly.
      this._bindAlphaTexture(gl, uniforms, -1, dimensionLevel);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);
      gl.drawElements(
        gl.POINTS,
        viewState.cachedCulledCount,
        gl.UNSIGNED_INT,
        0
      );
    } catch (error) {
      operationError = error;
    }
    let restorationError = null;
    try {
      restorePointDrawBaseline(gl, true);
    } catch (error) {
      restorationError = error;
    }
    settlePointDraw(
      operationError,
      restorationError,
      'HighPerfRenderer live frustum draw'
    );

    // Update both global and per-view stats
    this._writeStats(
      viewState,
      viewState.cachedCulledCount,
      -1,
      1,
      true,
      this.pointCount === 0
        ? 100
        : 100 * (
            1 -
            viewState.cachedCulledCount / this.pointCount
          )
    );
  }

  /**
   * Prepare exact per-view frustum admission transactionally.
   *
   * The accepted planes and their matrix/dimension/bounds keys advance only
   * after extraction has completed into a rejected scratch owner. Stable
   * frames therefore perform exact scalar comparisons but no normalization,
   * allocation, traversal, or publication work.
   *
   * @param {ArrayLike<number>} mvpMatrix - Exact 4x4 MVP matrix.
   * @param {Object} viewState - Exact per-view state owner.
   * @param {number} dimensionLevel - Exact 1D/2D/3D dimension.
   * @param {Object|null} [overrideBounds=null] - Exact custom geometry bounds.
   * @returns {boolean} Whether accepted frustum admission changed.
   * @private
   */
  _prepareFrustumCache(
    mvpMatrix,
    viewState,
    dimensionLevel,
    overrideBounds = null
  ) {
    if (
      !viewState ||
      (
        !Array.isArray(mvpMatrix) &&
        !ArrayBuffer.isView(mvpMatrix)
      ) ||
      mvpMatrix.length !== 16
    ) {
      throw new TypeError(
        'HighPerfRenderer frustum preparation requires a view state and exactly 16 MVP values.'
      );
    }
    const exactDimensionLevel = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer frustum preparation dimensionLevel'
    );
    const cachedMatrix = viewState.lastFrustumMVP;
    const hasExactMatrix =
      (
        Array.isArray(cachedMatrix) ||
        ArrayBuffer.isView(cachedMatrix)
      ) &&
      cachedMatrix.length === 16;
    let matrixChanged = !hasExactMatrix;
    for (let index = 0; index < 16; index++) {
      const value = mvpMatrix[index];
      if (!Number.isFinite(value)) {
        throw new TypeError(
          `HighPerfRenderer frustum MVP[${index}] must be finite; received ${String(value)}.`
        );
      }
      if (hasExactMatrix && value !== cachedMatrix[index]) {
        matrixChanged = true;
      }
    }

    const hasOverrideBounds =
      overrideBounds !== null &&
      overrideBounds !== undefined;
    let minX = 0;
    let maxX = 0;
    let minY = 0;
    let maxY = 0;
    let minZ = 0;
    let maxZ = 0;
    let boundsChanged;
    const cachedBounds = viewState.lastFrustumBounds;
    if (hasOverrideBounds) {
      if (
        typeof overrideBounds !== 'object' ||
        Array.isArray(overrideBounds)
      ) {
        throw new TypeError(
          'HighPerfRenderer frustum overrideBounds must be an exact bounds object or null.'
        );
      }
      minX = overrideBounds.minX;
      maxX = overrideBounds.maxX;
      minY = overrideBounds.minY;
      maxY = overrideBounds.maxY;
      minZ = overrideBounds.minZ;
      maxZ = overrideBounds.maxZ;
      if (
        !Number.isFinite(minX) ||
        !Number.isFinite(maxX) ||
        !Number.isFinite(minY) ||
        !Number.isFinite(maxY) ||
        !Number.isFinite(minZ) ||
        !Number.isFinite(maxZ)
      ) {
        throw new TypeError(
          'HighPerfRenderer frustum bounds values must all be finite.'
        );
      }
      boundsChanged =
        !(cachedBounds instanceof Float64Array) ||
        cachedBounds.length !== 6 ||
        cachedBounds[0] !== minX ||
        cachedBounds[1] !== maxX ||
        cachedBounds[2] !== minY ||
        cachedBounds[3] !== maxY ||
        cachedBounds[4] !== minZ ||
        cachedBounds[5] !== maxZ;
    } else {
      boundsChanged = cachedBounds !== null;
    }
    const dimensionChanged =
      viewState.lastDimensionLevel !== exactDimensionLevel;
    if (!matrixChanged && !boundsChanged && !dimensionChanged) {
      return false;
    }

    const acceptedPlanes = viewState.frustumPlanes;
    if (!Array.isArray(acceptedPlanes) || acceptedPlanes.length !== 6) {
      throw new TypeError(
        'HighPerfRenderer accepted frustum state must own six planes.'
      );
    }
    for (let index = 0; index < 6; index++) {
      if (
        !(acceptedPlanes[index] instanceof Float32Array) ||
        acceptedPlanes[index].length !== 4
      ) {
        throw new TypeError(
          'HighPerfRenderer accepted frustum state must own six exact Float32Array(4) planes.'
        );
      }
    }

    let scratchPlanes = viewState.frustumPlaneScratch;
    let validScratch =
      Array.isArray(scratchPlanes) &&
      scratchPlanes.length === 6;
    if (validScratch) {
      for (let index = 0; index < 6; index++) {
        if (
          !(scratchPlanes[index] instanceof Float32Array) ||
          scratchPlanes[index].length !== 4
        ) {
          validScratch = false;
          break;
        }
      }
    }
    if (!validScratch) {
      scratchPlanes = [
        new Float32Array(4), new Float32Array(4),
        new Float32Array(4), new Float32Array(4),
        new Float32Array(4), new Float32Array(4)
      ];
    }

    let extractionBounds = null;
    if (hasOverrideBounds) {
      extractionBounds = viewState.frustumBoundsScratch;
      if (
        !extractionBounds ||
        typeof extractionBounds !== 'object'
      ) {
        extractionBounds = {
          minX: 0,
          maxX: 0,
          minY: 0,
          maxY: 0,
          minZ: 0,
          maxZ: 0
        };
        viewState.frustumBoundsScratch = extractionBounds;
      }
      extractionBounds.minX = minX;
      extractionBounds.maxX = maxX;
      extractionBounds.minY = minY;
      extractionBounds.maxY = maxY;
      extractionBounds.minZ = minZ;
      extractionBounds.maxZ = maxZ;
    }

    this.extractFrustumPlanes(
      mvpMatrix,
      scratchPlanes,
      extractionBounds
    );
    for (let planeIndex = 0; planeIndex < 6; planeIndex++) {
      const plane = scratchPlanes[planeIndex];
      for (let valueIndex = 0; valueIndex < 4; valueIndex++) {
        if (!Number.isFinite(plane[valueIndex])) {
          throw new Error(
            `HighPerfRenderer frustum extraction produced a non-finite plane value at ${planeIndex}:${valueIndex}.`
          );
        }
      }
    }

    const acceptedMatrix =
      cachedMatrix instanceof Float64Array &&
      cachedMatrix.length === 16
        ? cachedMatrix
        : new Float64Array(16);
    let acceptedBounds = null;
    if (hasOverrideBounds) {
      acceptedBounds =
        cachedBounds instanceof Float64Array &&
        cachedBounds.length === 6
          ? cachedBounds
          : new Float64Array(6);
    }

    // Allocate every missing key owner before overwriting any accepted key.
    // In particular, a null→custom-bounds allocation failure must leave the
    // previously accepted MVP, planes, dimension, and null bounds coherent.
    for (let index = 0; index < 16; index++) {
      acceptedMatrix[index] = mvpMatrix[index];
    }
    if (acceptedBounds !== null) {
      acceptedBounds[0] = minX;
      acceptedBounds[1] = maxX;
      acceptedBounds[2] = minY;
      acceptedBounds[3] = maxY;
      acceptedBounds[4] = minZ;
      acceptedBounds[5] = maxZ;
    }

    viewState.frustumPlanes = scratchPlanes;
    viewState.frustumPlaneScratch = acceptedPlanes;
    viewState.lastFrustumMVP = acceptedMatrix;
    viewState.lastFrustumBounds = acceptedBounds;
    viewState.lastDimensionLevel = exactDimensionLevel;
    return true;
  }

  /**
   * Check if frustum cache is valid and needs update.
   * @param {Float32Array} mvpMatrix - Current MVP matrix
   * @param {Object} viewState - Per-view state object
   * @param {number} [dimensionLevel] - Current dimension level (triggers invalidation when changed)
   * @returns {boolean} True if cache needs update
   */
  _checkFrustumCacheValid(mvpMatrix, viewState, dimensionLevel = undefined) {
    if (
      !viewState ||
      (
        !Array.isArray(mvpMatrix) &&
        !ArrayBuffer.isView(mvpMatrix)
      ) ||
      mvpMatrix.length !== 16
    ) {
      throw new TypeError(
        'HighPerfRenderer frustum cache requires a view state and exactly 16 MVP values.'
      );
    }

    const cachedMatrix = viewState.lastFrustumMVP;
    const hasExactCache =
      (
        Array.isArray(cachedMatrix) ||
        ArrayBuffer.isView(cachedMatrix)
      ) &&
      cachedMatrix.length === 16;
    let matrixChanged = !hasExactCache;

    // Frustum admission is a hard visibility boundary: any finite matrix
    // element change can move a point across a plane. Exact comparison also
    // keeps the idle fast path allocation-free and avoids the prior
    // subtract/multiply threshold work. Validate before mutating cache keys so
    // NaN/Infinity cannot silently reuse stale visibility.
    for (let index = 0; index < 16; index++) {
      const value = mvpMatrix[index];
      if (!Number.isFinite(value)) {
        throw new TypeError(
          `HighPerfRenderer frustum MVP[${index}] must be finite; received ${String(value)}.`
        );
      }
      if (hasExactCache && value !== cachedMatrix[index]) {
        matrixChanged = true;
      }
    }

    const dimensionChanged =
      dimensionLevel !== undefined &&
      viewState.lastDimensionLevel !== undefined &&
      viewState.lastDimensionLevel !== dimensionLevel;
    if (!matrixChanged && !dimensionChanged) {
      if (dimensionLevel !== undefined) {
        viewState.lastDimensionLevel = dimensionLevel;
      }
      return false;
    }

    // Float64 preserves every JavaScript numeric matrix element exactly,
    // including callers that supply stable Float64Array/Array matrices. The
    // extra 64 bytes per view prevent rounded caches from invalidating every
    // otherwise-idle frame.
    const acceptedMatrix =
      cachedMatrix instanceof Float64Array &&
      cachedMatrix.length === 16
        ? cachedMatrix
        : new Float64Array(16);
    for (let index = 0; index < 16; index++) {
      acceptedMatrix[index] = mvpMatrix[index];
    }
    viewState.lastFrustumMVP = acceptedMatrix;
    if (dimensionLevel !== undefined) {
      viewState.lastDimensionLevel = dimensionLevel;
    }
    return true;
  }

  _collectVisibleNodes(node, frustumPlanes, result) {
    if (!node) return;

    const visibility = this._classifyNodeVisibility(node.bounds, frustumPlanes);

    if (visibility === 'outside') {
      return;
    }

    if (visibility === 'inside' || node.indices !== null) {
      if (node.indices !== null) {
        result.push(node);
      } else if (node.children) {
        this._collectAllLeaves(node, result);
      }
      return;
    }

    if (node.children) {
      for (const child of node.children) {
        this._collectVisibleNodes(child, frustumPlanes, result);
      }
    }
  }

  _collectAllLeaves(node, result) {
    if (!node) return;
    if (node.indices !== null) {
      result.push(node);
      return;
    }
    if (node.children) {
      for (const child of node.children) {
        this._collectAllLeaves(child, result);
      }
    }
  }

  /**
   * Collect one candidate ordered leaf sequence into per-view reusable
   * storage. The candidate must be accepted or recycled by the caller.
   *
   * @param {Object} viewState
   * @param {Object} root
   * @param {Array<Float32Array>} frustumPlanes
   * @returns {Array<Object>}
   * @private
   */
  _collectVisibleNodeCandidate(viewState, root, frustumPlanes) {
    let candidate = viewState.visibleNodesScratch;
    if (
      !Array.isArray(candidate) ||
      candidate === viewState.cachedVisibleNodes
    ) {
      candidate = [];
    } else {
      candidate.length = 0;
    }

    let operationError = null;
    try {
      this._collectVisibleNodes(root, frustumPlanes, candidate);
    } catch (error) {
      candidate.length = 0;
      viewState.visibleNodesScratch = candidate;
      // _checkFrustumCacheValid publishes the candidate MVP before traversal.
      // A failed traversal must therefore invalidate that key or the next
      // stable frame could draw the previously accepted, now-stale EBO.
      this._invalidateViewStateRecord(viewState);
      throw error;
    }
    return candidate;
  }

  /**
   * Ordered leaf identity is the exact CPU/GPU EBO admission contract.
   * Counts alone cannot distinguish reordered or same-sized replacements.
   *
   * @param {Array<Object>|null} accepted
   * @param {Array<Object>} candidate
   * @returns {boolean}
   * @private
   */
  _hasSameOrderedVisibleNodes(accepted, candidate) {
    if (
      !Array.isArray(accepted) ||
      !Array.isArray(candidate) ||
      accepted.length !== candidate.length
    ) {
      return false;
    }
    for (let index = 0; index < accepted.length; index++) {
      if (accepted[index] !== candidate[index]) return false;
    }
    return true;
  }

  /**
   * Publish a candidate leaf sequence and recycle the previously accepted
   * array as the next per-view traversal scratch.
   *
   * @param {Object} viewState
   * @param {Array<Object>} candidate
   * @private
   */
  _acceptVisibleNodeCandidate(viewState, candidate) {
    const previous = viewState.cachedVisibleNodes;
    viewState.cachedVisibleNodes = candidate;
    if (Array.isArray(previous) && previous !== candidate) {
      previous.length = 0;
      viewState.visibleNodesScratch = previous;
      viewState.visibleNodesSpare = null;
      return;
    }
    const spare = viewState.visibleNodesSpare;
    if (Array.isArray(spare) && spare !== candidate) {
      spare.length = 0;
      viewState.visibleNodesScratch = spare;
      viewState.visibleNodesSpare = null;
      return;
    }
    // Hand-built/test states and recovery after invalidation may not own the
    // normal two-array pool yet. Allocate once, never once per frame.
    viewState.visibleNodesScratch = [];
    viewState.visibleNodesSpare = null;
  }

  /**
   * Return an unchanged candidate to the per-view traversal pool.
   *
   * @param {Object} viewState
   * @param {Array<Object>} candidate
   * @private
   */
  _recycleVisibleNodeCandidate(viewState, candidate) {
    candidate.length = 0;
    viewState.visibleNodesScratch = candidate;
    if (viewState.visibleNodesSpare === candidate) {
      viewState.visibleNodesSpare = null;
    }
  }

  _classifyNodeVisibility(bounds, planes) {
    let allInside = true;

    for (const plane of planes) {
      const px = plane[0] >= 0 ? bounds.maxX : bounds.minX;
      const py = plane[1] >= 0 ? bounds.maxY : bounds.minY;
      const pz = plane[2] >= 0 ? bounds.maxZ : bounds.minZ;

      const nx = plane[0] >= 0 ? bounds.minX : bounds.maxX;
      const ny = plane[1] >= 0 ? bounds.minY : bounds.maxY;
      const nz = plane[2] >= 0 ? bounds.minZ : bounds.maxZ;

      const pDist = plane[0] * px + plane[1] * py + plane[2] * pz + plane[3];
      if (pDist < 0) {
        return 'outside';
      }

      const nDist = plane[0] * nx + plane[1] * ny + plane[2] * nz + plane[3];
      if (nDist < 0) {
        allInside = false;
      }
    }

    return allInside ? 'inside' : 'partial';
  }

  /**
   * Upload indices to the per-view index buffer for frustum culling.
   * Each view has its own index buffer to avoid cross-view conflicts.
   * @param {Object} viewState - Per-view state object containing indexBuffer
   * @param {Uint32Array} visibleIndices - Array of visible point indices
   */
  _uploadToViewIndexBuffer(viewState, visibleIndices) {
    const gl = this.gl;
    if (
      !viewState ||
      !viewState.indexBuffer ||
      !(visibleIndices instanceof Uint32Array)
    ) {
      throw new TypeError(
        'HighPerfRenderer per-view index upload requires an owned EBO and exact Uint32Array indices.'
      );
    }

    try {
      requireCleanWebGLState(
        gl,
        'HighPerfRenderer per-view index publication preflight'
      );
      // ELEMENT_ARRAY_BUFFER is VAO state. Upload with no VAO bound so this
      // reusable per-view EBO cannot become an accidental retained binding.
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);
      gl.bufferData(
        gl.ELEMENT_ARRAY_BUFFER,
        visibleIndices,
        gl.DYNAMIC_DRAW
      );
      requireCleanWebGLState(
        gl,
        'HighPerfRenderer per-view index publication'
      );
      // Publish the byte/count contract only after WebGL accepted the complete
      // replacement. A failed bufferData leaves the previous store intact.
      viewState.indexBufferSize = visibleIndices.length;
      viewState.indexBufferByteLength = visibleIndices.byteLength;
      this._refreshGpuMemoryStats();
    } catch (error) {
      // Callers may already have filled reusable CPU scratch or advanced
      // frustum/LOD cache keys. Invalidate all semantic projections so the
      // next frame recomputes and retries instead of drawing stale topology.
      this._invalidateViewStateRecord(viewState);
      throw error;
    } finally {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    }
  }

  /**
   * Return exact per-view scratch for live/snapshot full-detail or LOD
   * visibility indices.
   * Growth has headroom, while shrink requires both a large ratio and at
   * least 1 MiB of reclaimable Uint32 storage. That hysteresis releases a
   * formerly wide pane's material retention without reallocating for ordinary
   * camera jitter, and never shares writable storage between views.
   *
   * @param {Object} viewState
   * @param {number} requiredCount
   * @param {boolean} isLodScratch
   * @returns {Uint32Array}
   * @private
   */
  _ensureVisibleIndexScratch(
    viewState,
    requiredCount,
    isLodScratch
  ) {
    if (
      !viewState ||
      !Number.isSafeInteger(requiredCount) ||
      requiredCount < 0 ||
      typeof isLodScratch !== 'boolean'
    ) {
      throw new TypeError(
        'HighPerfRenderer visible-index scratch requires a view state, a non-negative safe-integer count, and an exact LOD ownership flag.'
      );
    }

    const targetCapacity = Math.ceil(
      requiredCount * VISIBLE_INDEX_GROWTH_FACTOR
    );
    if (!Number.isSafeInteger(targetCapacity)) {
      throw new RangeError(
        `HighPerfRenderer visible-index scratch capacity for ${requiredCount} indices is unsafe.`
      );
    }

    const bufferKey = isLodScratch
      ? 'visibleLodIndicesBuffer'
      : 'visibleIndicesBuffer';
    const capacityKey = isLodScratch
      ? 'visibleLodIndicesCapacity'
      : 'visibleIndicesCapacity';
    const current =
      viewState[bufferKey];
    const hasExactScratch =
      current instanceof Uint32Array;
    const shouldGrow =
      !hasExactScratch || current.length < requiredCount;
    const shouldShrink =
      hasExactScratch &&
      current.length >
        targetCapacity * VISIBLE_INDEX_SHRINK_RATIO &&
      current.length - targetCapacity >=
        VISIBLE_INDEX_MIN_RECLAIM;

    if (shouldGrow || shouldShrink) {
      // Publish only after allocation succeeds. On failure, the accepted
      // scratch remains reachable and the caller's cache transaction aborts.
      const replacement =
        new Uint32Array(targetCapacity);
      viewState[bufferKey] = replacement;
      viewState[capacityKey] =
        replacement.length;
      return replacement;
    }

    viewState[capacityKey] = current.length;
    return current;
  }

  _ensureVisibleLodIndexScratch(viewState, requiredCount) {
    return this._ensureVisibleIndexScratch(
      viewState,
      requiredCount,
      true
    );
  }

  /**
   * Check if visible count change is significant enough to log.
   * Logs on first call and when cull percentage changes by >10 percentage points.
   */
  _isSignificantChange(lastCount, newCount, totalCount) {
    if (lastCount === undefined || lastCount === null) return true;
    if (totalCount === 0) return false;
    const lastPercent = (lastCount / totalCount) * 100;
    const newPercent = (newCount / totalCount) * 100;
    return Math.abs(newPercent - lastPercent) > 10;
  }

  _renderFullDetail(params, viewState) {
    const gl = this.gl;
    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir, dimensionLevel
    } = params;

    const program = this.activeProgram;
    const uniforms = this.uniformLocations.get(this.activeQuality);

    if (!program) {
      throw new Error(
        'HighPerfRenderer full-detail shader program is unavailable.'
      );
    }
    if (!uniforms) {
      throw new Error(
        `HighPerfRenderer "${this.activeQuality}" full-detail uniform state is unavailable.`
      );
    }

    gl.useProgram(program);

    if (uniforms.u_mvpMatrix !== null) {
      gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    }

    if (uniforms.u_viewMatrix !== null) {
      gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
    }
    if (uniforms.u_modelMatrix) {
      gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
    }
    if (uniforms.u_projectionMatrix !== null && projectionMatrix) {
      gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
    }

    if (uniforms.u_pointSize !== null) {
      gl.uniform1f(uniforms.u_pointSize, pointSize);
    }

    if (uniforms.u_sizeAttenuation) {
      gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    }
    if (uniforms.u_viewportHeight) {
      gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
    }
    if (uniforms.u_fov) {
      gl.uniform1f(uniforms.u_fov, fov);
    }
    if (uniforms.u_lightingStrength) {
      gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    }
    if (uniforms.u_fogDensity) {
      gl.uniform1f(uniforms.u_fogDensity, fogDensity);
    }
    if (uniforms.u_fogNear) {
      gl.uniform1f(uniforms.u_fogNear, this.fogNear);
    }
    if (uniforms.u_fogFar) {
      gl.uniform1f(uniforms.u_fogFar, this.fogFar);
    }
    if (uniforms.u_fogColor) {
      gl.uniform3fv(uniforms.u_fogColor, fogColor);
    }
    if (uniforms.u_lightDir) {
      gl.uniform3fv(uniforms.u_lightDir, lightDir);
    }

    let operationError = null;
    try {
      // Bind alpha texture for efficient alpha lookups (texture unit 0).
      this._bindAlphaTexture(gl, uniforms, -1, dimensionLevel);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.POINTS, 0, this.pointCount);
    } catch (error) {
      operationError = error;
    }
    let restorationError = null;
    try {
      restorePointDrawBaseline(gl, false);
    } catch (error) {
      restorationError = error;
    }
    settlePointDraw(
      operationError,
      restorationError,
      'HighPerfRenderer full-detail draw'
    );

    this._writeStats(
      viewState,
      this.pointCount,
      -1,
      1,
      false,
      0
    );
  }

  /**
   * Bind alpha texture and set uniforms for alpha texture lookup.
   * @param {WebGL2RenderingContext} gl
   * @param {Object} uniforms - Cached uniform locations
   * @param {number} lodLevel - LOD level for index texture binding (-1 for full detail)
   * @param {number} dimensionLevel - Exact dimension level for LOD index texture lookup
   */
  _bindAlphaTexture(gl, uniforms, lodLevel, dimensionLevel) {
    if (!Number.isInteger(lodLevel) || lodLevel < -1) {
      throw new RangeError('HighPerfRenderer alpha texture LOD level must be an integer of at least -1.');
    }
    requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer alpha texture dimensionLevel'
    );
    // Bind alpha texture to texture unit 0
    if (this._useAlphaTexture && this._alphaTexture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._alphaTexture);
      if (uniforms.u_alphaTex !== null) {
        gl.uniform1i(uniforms.u_alphaTex, 0); // Texture unit 0
      }
      if (uniforms.u_alphaTexWidth !== null) {
        gl.uniform1i(uniforms.u_alphaTexWidth, this._alphaTexWidth);
      }
      if (uniforms.u_invAlphaTexWidth !== null && this._alphaTexWidth > 0) {
        gl.uniform1f(uniforms.u_invAlphaTexWidth, 1.0 / this._alphaTexWidth);
      }
      if (uniforms.u_useAlphaTex !== null) {
        gl.uniform1i(uniforms.u_useAlphaTex, 1); // true
      }

      // Bind LOD index texture if rendering LOD level (texture unit 1)
      // Use dimension-aware LOD index textures to match LOD buffers
      const lodIndexTextures = this._getLodIndexTexturesForDimension(dimensionLevel);
      if (lodLevel >= 0 && lodIndexTextures[lodLevel]?.texture) {
        const lodIdxTex = lodIndexTextures[lodLevel];
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, lodIdxTex.texture);
        if (uniforms.u_lodIndexTex !== null) {
          gl.uniform1i(uniforms.u_lodIndexTex, 1); // Texture unit 1
        }
        if (uniforms.u_lodIndexTexWidth !== null) {
          gl.uniform1i(uniforms.u_lodIndexTexWidth, lodIdxTex.width);
        }
        if (uniforms.u_invLodIndexTexWidth !== null && lodIdxTex.width > 0) {
          gl.uniform1f(uniforms.u_invLodIndexTexWidth, 1.0 / lodIdxTex.width);
        }
        if (uniforms.u_useLodIndexTex !== null) {
          gl.uniform1i(uniforms.u_useLodIndexTex, 1); // true
        }
      } else {
        // No LOD index texture needed, but must bind dummy R32UI texture to satisfy usampler2D
        // Without this, WebGL throws "Two textures of different types use the same sampler location"
        if (this._dummyLodIndexTexture) {
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, this._dummyLodIndexTexture);
          if (uniforms.u_lodIndexTex !== null) {
            gl.uniform1i(uniforms.u_lodIndexTex, 1); // Texture unit 1
          }
        }
        if (uniforms.u_useLodIndexTex !== null) {
          gl.uniform1i(uniforms.u_useLodIndexTex, 0); // false
        }
      }
    } else {
      // Alpha texture not active - use vertex attribute alpha
      if (uniforms.u_useAlphaTex !== null) {
        gl.uniform1i(uniforms.u_useAlphaTex, 0); // false
      }
      // Still need to bind dummy R32UI texture to satisfy usampler2D uniform
      if (this._dummyLodIndexTexture) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._dummyLodIndexTexture);
        if (uniforms.u_lodIndexTex !== null) {
          gl.uniform1i(uniforms.u_lodIndexTex, 1); // Texture unit 1
        }
      }
      if (uniforms.u_useLodIndexTex !== null) {
        gl.uniform1i(uniforms.u_useLodIndexTex, 0); // false
      }
    }
  }

  /**
   * Bind the exact alpha owner for one snapshot draw. Snapshot EBOs contain
   * source point IDs, so every direct/LOD/frustum branch indexes R8 with
   * gl_VertexID and must keep the LOD remap sampler disabled.
   */
  _bindSnapshotAlphaTexture(
    gl,
    uniforms,
    snapshot,
    useLiveAlpha,
    dimensionLevel
  ) {
    if (typeof useLiveAlpha !== 'boolean') {
      throw new TypeError(
        'HighPerfRenderer snapshot live-alpha override must be a boolean.'
      );
    }
    requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer snapshot alpha dimensionLevel'
    );
    if (useLiveAlpha) {
      if (!this.isAlphaTextureActive()) {
        throw new Error(
          `HighPerfRenderer snapshot "${snapshot?.id ?? 'unknown'}" requested unavailable live alpha state.`
        );
      }
      this._bindAlphaTexture(
        gl,
        uniforms,
        -1,
        dimensionLevel
      );
      return;
    }
    if (
      !snapshot ||
      !snapshot.alphaTexture ||
      !(snapshot.alphaTexData instanceof Uint8Array) ||
      !Number.isSafeInteger(snapshot.alphaTexWidth) ||
      snapshot.alphaTexWidth <= 0 ||
      !Number.isSafeInteger(snapshot.alphaTexHeight) ||
      snapshot.alphaTexHeight <= 0 ||
      snapshot.alphaTexData.length !==
        snapshot.alphaTexWidth * snapshot.alphaTexHeight ||
      snapshot.alphaTextureByteLength !==
        snapshot.alphaTexData.byteLength
    ) {
      throw new Error(
        `HighPerfRenderer snapshot "${snapshot?.id ?? 'unknown'}" has no exact accepted R8 alpha texture.`
      );
    }
    if (!this._dummyLodIndexTexture) {
      throw new Error(
        `HighPerfRenderer snapshot "${snapshot.id}" requires its dummy LOD index texture.`
      );
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, snapshot.alphaTexture);
    if (uniforms.u_alphaTex !== null) {
      gl.uniform1i(uniforms.u_alphaTex, 0);
    }
    if (uniforms.u_alphaTexWidth !== null) {
      gl.uniform1i(
        uniforms.u_alphaTexWidth,
        snapshot.alphaTexWidth
      );
    }
    if (uniforms.u_invAlphaTexWidth !== null) {
      gl.uniform1f(
        uniforms.u_invAlphaTexWidth,
        1.0 / snapshot.alphaTexWidth
      );
    }
    if (uniforms.u_useAlphaTex !== null) {
      gl.uniform1i(uniforms.u_useAlphaTex, 1);
    }

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(
      gl.TEXTURE_2D,
      this._dummyLodIndexTexture
    );
    if (uniforms.u_lodIndexTex !== null) {
      gl.uniform1i(uniforms.u_lodIndexTex, 1);
    }
    if (uniforms.u_lodIndexTexWidth !== null) {
      gl.uniform1i(uniforms.u_lodIndexTexWidth, 1);
    }
    if (uniforms.u_invLodIndexTexWidth !== null) {
      gl.uniform1f(uniforms.u_invLodIndexTexWidth, 1);
    }
    if (uniforms.u_useLodIndexTex !== null) {
      gl.uniform1i(uniforms.u_useLodIndexTex, 0);
    }
  }

  _renderLOD(lodLevel, params, viewState) {
    const gl = this.gl;
    const dimensionLevel = requireDimensionLevel(
      params.dimensionLevel,
      'HighPerfRenderer LOD render dimensionLevel'
    );
    const lodBuffers =
      this._getLodBuffersForDimension(dimensionLevel);
    const lod = lodBuffers[lodLevel];

    if (!lod) {
      throw new RangeError(
        `HighPerfRenderer LOD level ${String(lodLevel)} is unavailable for ${dimensionLevel}D.`
      );
    }
    if (lod.isFullDetail) {
      this._renderFullDetail(params, viewState);
      return;
    }

    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir
    } = params;

    const adjustedPointSize = pointSize * lod.sizeMultiplier;

    const program = this.activeProgram;
    let uniforms = this.uniformLocations.get(this.activeQuality);

    if (!uniforms || !program) {
      throw new Error(
        `HighPerfRenderer "${this.activeQuality}" LOD shader state is unavailable.`
      );
    }

    gl.useProgram(program);

    if (uniforms.u_mvpMatrix !== null) {
      gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    }
    if (uniforms.u_viewMatrix !== null) {
      gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
    }
    if (uniforms.u_modelMatrix !== null) {
      gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
    }
    if (uniforms.u_projectionMatrix !== null && projectionMatrix) {
      gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
    }
    if (uniforms.u_pointSize !== null) {
      gl.uniform1f(uniforms.u_pointSize, adjustedPointSize);
    }
    if (uniforms.u_sizeAttenuation !== null) {
      gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    }
    if (uniforms.u_viewportHeight !== null) {
      gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
    }
    if (uniforms.u_fov !== null) {
      gl.uniform1f(uniforms.u_fov, fov);
    }
    if (uniforms.u_lightingStrength !== null) {
      gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    }
    if (uniforms.u_fogDensity !== null) {
      gl.uniform1f(uniforms.u_fogDensity, fogDensity);
    }
    if (uniforms.u_fogNear !== null) {
      gl.uniform1f(uniforms.u_fogNear, this.fogNear);
    }
    if (uniforms.u_fogFar !== null) {
      gl.uniform1f(uniforms.u_fogFar, this.fogFar);
    }
    if (uniforms.u_fogColor !== null) {
      gl.uniform3fv(uniforms.u_fogColor, fogColor);
    }
    if (uniforms.u_lightDir !== null) {
      gl.uniform3fv(uniforms.u_lightDir, lightDir);
    }

    let operationError = null;
    try {
      // Bind alpha texture with the exact dimension's LOD index texture.
      this._bindAlphaTexture(gl, uniforms, lodLevel, dimensionLevel);
      gl.bindVertexArray(lod.vao);
      gl.drawArrays(gl.POINTS, 0, lod.pointCount);
    } catch (error) {
      operationError = error;
    }
    let restorationError = null;
    try {
      restorePointDrawBaseline(gl, false);
    } catch (error) {
      restorationError = error;
    }
    settlePointDraw(
      operationError,
      restorationError,
      'HighPerfRenderer LOD draw'
    );

    this._writeStats(
      viewState,
      lod.pointCount,
      lodLevel,
      1,
      false,
      0
    );
  }

  /**
   * Render with combined LOD and frustum culling.
   * This provides maximum performance by both reducing point count (LOD) and
   * culling out-of-view points (frustum culling) simultaneously.
   * Uses per-view index buffer to avoid cross-view conflicts.
   * @private
   */
  _renderLODWithFrustumCulling(
    lodLevel,
    params,
    frustumPlanes,
    viewState,
    spatialIndex,
    lodBuffersForDim,
    frustumChanged
  ) {
    const gl = this.gl;
    const lod = lodBuffersForDim[lodLevel];

    if (!lod) {
      throw new RangeError(
        `HighPerfRenderer LOD level ${String(lodLevel)} is unavailable.`
      );
    }
    if (lod.isFullDetail) {
      this._renderWithFrustumCulling(
        params,
        frustumPlanes,
        viewState,
        spatialIndex,
        frustumChanged
      );
      return;
    }

    // Validate the one shared mapping once per exact spatial generation.
    this._ensureLodResourceOwnershipState();
    const mappingToken =
      spatialIndex._lodNodeMapping?.generationToken ?? null;
    if (
      this._validatedLodNodeMappings.get(spatialIndex) !==
      mappingToken
    ) {
      const validatedToken =
        spatialIndex._validateLodNodeMapping();
      this._validatedLodNodeMappings.set(
        spatialIndex,
        validatedToken
      );
    }
    const validatedMappingToken =
      spatialIndex._lodNodeMapping?.generationToken ?? null;

    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir,
      viewId,
      dimensionLevel
    } = params;

    // Check whether the camera needs an exact tree traversal and whether the
    // accepted EBO's LOD/mapping contract changed. A new finite MVP alone is
    // not sufficient reason to refill or upload when traversal admits the
    // same leaf set: global compact-rank order is authoritative for LOD EBOs.
    const spatialOwnerChanged =
      viewState.cachedVisibleSpatialOwner !== spatialIndex ||
      viewState.cachedVisibleSpatialRoot !== spatialIndex.root ||
      !Array.isArray(viewState.cachedVisibleNodes);
    const lodCacheChanged =
      viewState.cachedLodLevel !== lodLevel ||
      viewState.cachedLodDimension !== dimensionLevel ||
      viewState.cachedLodIsCulled !== true ||
      viewState.cachedLodMappingGeneration !==
        validatedMappingToken ||
      !(viewState.cachedLodVisibleIndices instanceof Uint32Array) ||
      viewState.cachedCulledCount !==
        viewState.cachedLodVisibleIndices?.length ||
      (
        viewState.cachedCulledCount > 0 &&
        viewState.indexBufferSize !== viewState.cachedCulledCount
      );
    let visibleNodes = viewState.cachedVisibleNodes;
    let candidateToAccept = null;
    let lodAdmissionChanged = false;

    // Tree traversal remains exact for every finite MVP change, but uses a
    // per-view candidate array and compares exact leaf-set membership before
    // any O(K) mapping scan or GPU upload.
    if (frustumChanged || spatialOwnerChanged) {
      const candidate = this._collectVisibleNodeCandidate(
        viewState,
        spatialIndex.root,
        frustumPlanes
      );
      const sameLodAdmission =
        !spatialOwnerChanged &&
        spatialIndex.hasSameLodVisibleLeafSet(
          viewState.cachedVisibleNodes,
          candidate
        );
      if (sameLodAdmission) {
        this._recycleVisibleNodeCandidate(viewState, candidate);
      } else {
        visibleNodes = candidate;
        candidateToAccept = candidate;
        lodAdmissionChanged = true;
      }
    }

    // Rebuild only when leaf-set admission, LOD mode, mapping generation, or
    // exact spatial ownership changed. LOD-only changes reuse accepted leaves
    // without another traversal.
    // PERFORMANCE NOTE: This block is the main source of lag when zooming with LOD+Frustum enabled.
    // Unlike LOD-only (which uses gl.drawArrays with pre-built VAOs) or Frustum-only (which only
    // updates when camera moves), LOD+Frustum must rebuild index buffers on EVERY LOD level change.
    // Pre-caching is NOT possible here because:
    //   - Pre-cached originalIndexBuffer contains ALL LOD indices for a level
    //   - Frustum culling requires only the SUBSET visible in current frustum
    //   - This subset is view-dependent (each view has different frustum) and LOD-dependent
    //   - When LOD changes during zoom, we must filter the shared maximum
    //     prefix for visible leaves and upload the new EBO contents.
    // With N views, this happens N times per LOD transition.
    if (
      spatialOwnerChanged ||
      lodCacheChanged ||
      lodAdmissionChanged
    ) {
      try {
        if (!Array.isArray(visibleNodes)) {
          throw new Error(
            `HighPerfRenderer LOD leaf admission is unavailable for view "${viewId}".`
          );
        }
        if (visibleNodes.length === 0) {
          const emptyLodScratch =
            this._ensureVisibleLodIndexScratch(viewState, 0);
          if (candidateToAccept) {
            this._acceptVisibleNodeCandidate(
              viewState,
              candidateToAccept
            );
          }
          viewState.cachedVisibleSpatialOwner = spatialIndex;
          viewState.cachedVisibleSpatialRoot = spatialIndex.root;
          viewState.cachedCulledCount = 0;
          viewState.cachedLodVisibleIndices =
            emptyLodScratch.subarray(0, 0);
          viewState.cachedLodLevel = lodLevel;
          viewState.cachedLodDimension = dimensionLevel;
          viewState.cachedLodIsCulled = true;
          viewState.cachedLodMappingGeneration =
            validatedMappingToken;
          this._writeStats(
            viewState,
            0,
            lodLevel,
            0,
            true,
            100
          );
          return;
        }

        // Mark exact visible leaves and scan only this level's compact prefix.
        // The query never walks the larger maximum prefix.
        const visibleCount =
          spatialIndex.countLodMappedIndices(
            visibleNodes,
            lodLevel
          );

        const totalLodPoints = lod.pointCount;
        const visibleRatio = visibleCount / totalLodPoints;
        const cullPercent = ((1 - visibleRatio) * 100);

        const visibleLodIndicesBuffer =
          this._ensureVisibleLodIndexScratch(
            viewState,
            visibleCount
          );

        const writtenCount = spatialIndex.writeLodMappedIndices(
          visibleNodes,
          lodLevel,
          visibleLodIndicesBuffer
        );
        if (writtenCount !== visibleCount) {
          throw new Error(
            `HighPerfRenderer LOD ${lodLevel} mapping counted ${visibleCount} indices but wrote ${writtenCount}.`
          );
        }
        // Create view of used portion (no backing-store allocation)
        const visibleLodIndices =
          visibleLodIndicesBuffer.subarray(0, visibleCount);

        // Log only on significant change (>10% of total points)
        if (DEBUG_LOD_FRUSTUM && this._isSignificantChange(viewState.lastVisibleCount, visibleCount, totalLodPoints)) {
          console.log(`[LOD+Frustum] View ${viewId}: LOD ${lodLevel} - ${visibleCount.toLocaleString()}/${totalLodPoints.toLocaleString()} visible (${cullPercent.toFixed(1)}% culled)`);
          viewState.lastVisibleCount = visibleCount;
        }

        // GPU acceptance is the publication boundary.
        this._uploadToViewIndexBuffer(viewState, visibleLodIndices);
        if (candidateToAccept) {
          this._acceptVisibleNodeCandidate(
            viewState,
            candidateToAccept
          );
        }
        viewState.cachedVisibleSpatialOwner = spatialIndex;
        viewState.cachedVisibleSpatialRoot = spatialIndex.root;
        viewState.cachedLodVisibleIndices = visibleLodIndices;
        viewState.cachedCulledCount = visibleCount;
        viewState.cachedLodLevel = lodLevel;
        viewState.cachedLodDimension = dimensionLevel;
        viewState.cachedLodIsCulled = true;
        viewState.cachedLodMappingGeneration =
          validatedMappingToken;
        this.stats.frustumCulled = true;
        this.stats.cullPercent = cullPercent;
      } catch (error) {
        this._invalidateViewStateRecord(viewState);
        throw error;
      }
    }

    // If no visible points after culling, skip rendering
    if (
      !(viewState.cachedLodVisibleIndices instanceof Uint32Array) ||
      viewState.cachedCulledCount !==
        viewState.cachedLodVisibleIndices.length ||
      viewState.cachedLodLevel !== lodLevel ||
      viewState.cachedLodDimension !== dimensionLevel ||
      viewState.cachedLodIsCulled !== true ||
      viewState.cachedVisibleSpatialOwner !== spatialIndex ||
      viewState.cachedVisibleSpatialRoot !== spatialIndex.root ||
      viewState.cachedLodMappingGeneration !==
        validatedMappingToken
    ) {
      throw new Error(
        `HighPerfRenderer LOD visibility state is inconsistent for view "${viewId}".`
      );
    }
    if (viewState.cachedCulledCount === 0) {
      this._writeStats(
        viewState,
        0,
        lodLevel,
        0,
        true,
        100
      );
      return;
    }

    // Render using LOD buffer with indexed drawing
    const adjustedPointSize = pointSize * lod.sizeMultiplier;

    const program = this.activeProgram;
    const uniforms = this.uniformLocations.get(this.activeQuality);

    if (!uniforms || !program) {
      throw new Error(
        `HighPerfRenderer "${this.activeQuality}" LOD/frustum shader state is unavailable.`
      );
    }

    gl.useProgram(program);

    if (uniforms.u_mvpMatrix !== null) gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    if (uniforms.u_viewMatrix !== null) gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
    if (uniforms.u_modelMatrix !== null) gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
    if (uniforms.u_projectionMatrix !== null && projectionMatrix) gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
    if (uniforms.u_pointSize !== null) gl.uniform1f(uniforms.u_pointSize, adjustedPointSize);
    if (uniforms.u_sizeAttenuation !== null) gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    if (uniforms.u_viewportHeight !== null) gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
    if (uniforms.u_fov !== null) gl.uniform1f(uniforms.u_fov, fov);
    if (uniforms.u_lightingStrength !== null) gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    if (uniforms.u_fogDensity !== null) gl.uniform1f(uniforms.u_fogDensity, fogDensity);
    if (uniforms.u_fogNear !== null) gl.uniform1f(uniforms.u_fogNear, this.fogNear);
    if (uniforms.u_fogFar !== null) gl.uniform1f(uniforms.u_fogFar, this.fogFar);
    if (uniforms.u_fogColor !== null) gl.uniform3fv(uniforms.u_fogColor, fogColor);
    if (uniforms.u_lightDir !== null) gl.uniform3fv(uniforms.u_lightDir, lightDir);

    if (viewState.indexBufferSize !== viewState.cachedCulledCount) {
      throw new Error(
        `HighPerfRenderer LOD index buffer for view "${viewId}" contains ${viewState.indexBufferSize} entries but ${viewState.cachedCulledCount} are required.`
      );
    }

    let operationError = null;
    try {
      this._bindAlphaTexture(gl, uniforms, lodLevel, dimensionLevel);
      gl.bindVertexArray(lod.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);
      gl.drawElements(
        gl.POINTS,
        viewState.cachedCulledCount,
        gl.UNSIGNED_INT,
        0
      );
    } catch (error) {
      operationError = error;
    }
    let restorationError = null;
    try {
      restorePointDrawBaseline(gl, true);
    } catch (error) {
      restorationError = error;
    }
    settlePointDraw(
      operationError,
      restorationError,
      'HighPerfRenderer live LOD/frustum draw'
    );

    // Update both global and per-view stats
    this._writeStats(
      viewState,
      viewState.cachedCulledCount,
      lodLevel,
      1,
      true,
      lod.pointCount === 0
        ? 100
        : 100 * (
            1 -
            viewState.cachedCulledCount / lod.pointCount
          )
    );
  }

  /**
   * Prepare every geometry owner that can be consumed by the currently
   * published live/multiview set. Custom snapshot CPU trees are staged without
   * mutating their accepted pool and are committed only after every build and
   * every required live GPU generation succeeds.
   */
  _prepareSpatialIndicesForFeature(needsLOD) {
    if (typeof needsLOD !== 'boolean') {
      throw new TypeError(
        'HighPerfRenderer feature preparation needsLOD must be a boolean.'
      );
    }
    if (
      this.pointCount === 0 ||
      !this._positions ||
      !this._colors
    ) {
      return;
    }

    const liveDimensions = new Set([requireDimensionLevel(
      this.currentDimensionLevel,
      'HighPerfRenderer feature preparation live dimensionLevel'
    )]);
    const geometryMapPublications = new Map();
    const snapshotPublications = [];
    const stagedLodPublications = [];
    const liveLodRetirements = [];

    for (const [snapshotId, snapshot] of this.snapshotBuffers) {
      const exactId = requireViewId(
        snapshotId,
        'HighPerfRenderer feature preparation snapshot id'
      );
      const dimensionLevel = requireDimensionLevel(
        snapshot?.dimensionLevel,
        `HighPerfRenderer feature preparation snapshot "${exactId}" dimensionLevel`
      );
      if (this._snapshotUsesLiveGeometry(snapshot)) {
        liveDimensions.add(dimensionLevel);
        continue;
      }
      if (
        !(snapshot?.positions instanceof Float32Array) ||
        snapshot.positions.length !== snapshot.pointCount * 3
      ) {
        throw new Error(
          `HighPerfRenderer feature preparation snapshot "${exactId}" has no exact position generation.`
        );
      }
      const geometry =
        this._snapshotGeometryPools.get(
          snapshot.geometryGeneration
        );
      if (
        !geometry ||
        geometry.positions !== snapshot.positions ||
        !(geometry.spatialIndices instanceof Map)
      ) {
        throw new Error(
          `HighPerfRenderer feature preparation snapshot "${exactId}" has no exact geometry-pool owner.`
        );
      }

      let stagedSpatialIndices =
        geometryMapPublications.get(geometry);
      if (stagedSpatialIndices === undefined) {
        stagedSpatialIndices = new Map(geometry.spatialIndices);
        geometryMapPublications.set(
          geometry,
          stagedSpatialIndices
        );
      }
      let candidate =
        stagedSpatialIndices.get(dimensionLevel) ??
        snapshot.spatialIndex ??
        null;
      if (
        candidate !== null &&
        (
          candidate.positions !== snapshot.positions ||
          candidate.dimensionLevel !== dimensionLevel
        )
      ) {
        throw new Error(
          `HighPerfRenderer feature preparation snapshot "${exactId}" has an inconsistent spatial owner.`
        );
      }
      const candidateNeedsReplacement = (
        candidate === null ||
        (
          needsLOD &&
          (
            !Array.isArray(candidate.lodLevels) ||
            candidate.lodLevels.length === 0
          )
        )
      );
      if (candidateNeedsReplacement) {
        candidate = new SpatialIndex(
          snapshot.positions,
          null,
          dimensionLevel,
          this.options.LOD_MAX_POINTS_PER_NODE,
          this.options.LOD_MAX_DEPTH,
          {
            buildLOD: needsLOD,
            buildLodNodeMappings: false,
            computeNodeStats: false,
          }
        );
      }
      stagedSpatialIndices.set(dimensionLevel, candidate);
      snapshotPublications.push({ snapshot, candidate });
    }

    // Custom candidates above are still private. Build every live CPU owner
    // and every required GPU projection off-state as one batch. No dimension
    // may become authoritative while a later dimension can still fail.
    const previousSpatialIndices = this.spatialIndices;
    let candidateSpatialIndices = previousSpatialIndices;
    try {
      for (const dimensionLevel of liveDimensions) {
        const cached =
          candidateSpatialIndices.get(dimensionLevel) ?? null;
        const cachedIsExact = (
          cached !== null &&
          cached.positions === this._positions &&
          cached.dimensionLevel === dimensionLevel &&
          cached.pointCount === this.pointCount
        );
        const cachedLodIsReady = (
          cachedIsExact &&
          Array.isArray(cached.lodLevels) &&
          cached.lodLevels.length > 0
        );
        let candidate = cached;
        if (
          !cachedIsExact ||
          (needsLOD && !cachedLodIsReady)
        ) {
          candidate = new SpatialIndex(
            this._positions,
            this._colors,
            dimensionLevel,
            this.options.LOD_MAX_POINTS_PER_NODE,
            this.options.LOD_MAX_DEPTH,
            {
              buildLOD: needsLOD,
              buildLodNodeMappings: false,
              computeNodeStats: false,
            }
          );
          if (candidateSpatialIndices === previousSpatialIndices) {
            candidateSpatialIndices =
              new Map(previousSpatialIndices);
          }
          candidateSpatialIndices.set(
            dimensionLevel,
            candidate
          );
        }

        if (needsLOD) {
          const staged = this._ensureLodResourcesForDimension(
            dimensionLevel,
            candidate,
            true
          );
          if (staged !== null) {
            stagedLodPublications.push(staged);
          }
        } else {
          const previousOwner =
            this._lodResourceOwnersByDimension.get(
              dimensionLevel
            ) ?? null;
          const previousLodBuffers =
            this.lodBuffersByDimension.get(
              dimensionLevel
            ) ?? null;
          const previousIndexTextures =
            this._lodIndexTexturesByDimension.get(
              dimensionLevel
            ) ?? null;
          if (
            previousOwner?.spatialIndex !== candidate &&
            (
              previousOwner !== null ||
              previousLodBuffers !== null ||
              previousIndexTextures !== null
            )
          ) {
            liveLodRetirements.push({
              dimensionLevel,
              previousOwner,
              previousLodBuffers,
              previousIndexTextures,
            });
          }
        }
      }
    } catch (error) {
      const cleanupFailures = [];
      for (const staged of stagedLodPublications) {
        this._queueDataRetirement({
          buffers: {},
          vao: null,
          pointCount: 0,
          perViewState: null,
          lodResourceOwnersByDimension: new Map([
            [staged.dimensionLevel, staged.candidateOwner],
          ]),
          lodBuffersByDimension: new Map(),
          lodIndexTexturesByDimension: new Map(),
          alphaTexture: null,
          alphaTexWidth: 0,
          alphaTexHeight: 0,
        });
      }
      cleanupFailures.push(...this._drainDataRetirements());
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          `HighPerfRenderer feature preparation failed with ${cleanupFailures.length} staged LOD retirement failure(s).`
        );
      }
      throw error;
    }

    // Allocate every replacement map before the publication boundary.
    let candidateLodOwners =
      this._lodResourceOwnersByDimension;
    let candidateLodBuffers =
      this.lodBuffersByDimension;
    let candidateLodTextures =
      this._lodIndexTexturesByDimension;
    if (
      stagedLodPublications.length > 0 ||
      liveLodRetirements.length > 0
    ) {
      candidateLodOwners =
        new Map(this._lodResourceOwnersByDimension);
      candidateLodBuffers =
        new Map(this.lodBuffersByDimension);
      candidateLodTextures =
        new Map(this._lodIndexTexturesByDimension);
      for (const staged of stagedLodPublications) {
        candidateLodOwners.set(
          staged.dimensionLevel,
          staged.candidateOwner
        );
        candidateLodBuffers.set(
          staged.dimensionLevel,
          staged.candidateLodBuffers
        );
        candidateLodTextures.set(
          staged.dimensionLevel,
          staged.candidateIndexTextures
        );
      }
      for (const retirement of liveLodRetirements) {
        candidateLodOwners.delete(retirement.dimensionLevel);
        candidateLodBuffers.delete(retirement.dimensionLevel);
        candidateLodTextures.delete(retirement.dimensionLevel);
      }
    }

    // All fallible CPU/GL work has completed. These identity publications make
    // every live and custom pane ready before the global feature flag becomes
    // observable.
    this.spatialIndices = candidateSpatialIndices;
    this._lodResourceOwnersByDimension = candidateLodOwners;
    this.lodBuffersByDimension = candidateLodBuffers;
    this._lodIndexTexturesByDimension =
      candidateLodTextures;
    for (
      const [geometry, stagedSpatialIndices]
      of geometryMapPublications
    ) {
      geometry.spatialIndices = stagedSpatialIndices;
    }
    for (const { snapshot, candidate } of snapshotPublications) {
      snapshot.spatialIndex = candidate;
    }
    for (const staged of stagedLodPublications) {
      this._dirtyLodDimensions.delete(staged.dimensionLevel);
      this._certifyLodResourcesForDimension(
        staged.dimensionLevel,
        staged.spatialIndex,
        staged.candidateOwner,
        staged.candidateLodBuffers,
        staged.candidateIndexTextures
      );
    }
    this._refreshGpuMemoryStats();

    // The complete batch is authoritative. Prior handles become retry-owned;
    // cleanup failures cannot roll back the valid feature generation.
    const retiredOwners = new Map();
    const retiredBuffers = new Map();
    const retiredTextures = new Map();
    for (const staged of stagedLodPublications) {
      if (staged.previousOwner !== null) {
        retiredOwners.set(
          staged.dimensionLevel,
          staged.previousOwner
        );
      }
      if (staged.previousLodBuffers !== null) {
        retiredBuffers.set(
          staged.dimensionLevel,
          staged.previousLodBuffers
        );
      }
      if (staged.previousIndexTextures !== null) {
        retiredTextures.set(
          staged.dimensionLevel,
          staged.previousIndexTextures
        );
      }
    }
    for (const retirement of liveLodRetirements) {
      if (retirement.previousOwner !== null) {
        retiredOwners.set(
          retirement.dimensionLevel,
          retirement.previousOwner
        );
      }
      if (retirement.previousLodBuffers !== null) {
        retiredBuffers.set(
          retirement.dimensionLevel,
          retirement.previousLodBuffers
        );
      }
      if (retirement.previousIndexTextures !== null) {
        retiredTextures.set(
          retirement.dimensionLevel,
          retirement.previousIndexTextures
        );
      }
    }
    if (
      retiredOwners.size > 0 ||
      retiredBuffers.size > 0 ||
      retiredTextures.size > 0
    ) {
      this._queueDataRetirement({
        buffers: {},
        vao: null,
        pointCount: 0,
        perViewState: null,
        lodResourceOwnersByDimension: retiredOwners,
        lodBuffersByDimension: retiredBuffers,
        lodIndexTexturesByDimension: retiredTextures,
        alphaTexture: null,
        alphaTexWidth: 0,
        alphaTexHeight: 0,
      });
      this._drainDataRetirements();
    }
  }

  setAdaptiveLOD(enabled) {
    if (typeof enabled !== 'boolean') {
      throw new TypeError(
        'HighPerfRenderer adaptive LOD enabled must be a boolean.'
      );
    }
    this._assertOperational('set adaptive LOD');
    if (enabled === this.useAdaptiveLOD) return;

    // A global feature may become visible only after all live and multiview
    // geometry owners are ready. Preparation failures leave flags, force LOD,
    // per-view state, and unrelated dimension owners untouched.
    if (enabled) {
      this._prepareSpatialIndicesForFeature(true);
    }

    this.useAdaptiveLOD = enabled;
    if (!enabled && this.forceLODLevel >= 0) {
      this.forceLODLevel = -1;
      console.log(
        '[HighPerfRenderer] Resetting forceLODLevel to -1 (LOD disabled)'
      );
    }
    for (const viewState of this._perViewState.values()) {
      this._invalidateViewStateRecord(viewState);
    }
    console.log(
      `[HighPerfRenderer] Adaptive LOD ${enabled ? 'enabled' : 'disabled'}`
    );
  }

  /**
   * Print current renderer status to console for debugging.
   * Call this from console: renderer.debugStatus()
   */
  debugStatus() {
    this._assertOperational('inspect renderer status');
    const dimLevel = this.currentDimensionLevel;
    const spatialIndex = this.spatialIndices.get(dimLevel);
    const lodBuffers =
      this._getLodBuffersForDimension(dimLevel);

    const status = {
      pointCount: this.pointCount,
      currentDimensionLevel: dimLevel,
      useAdaptiveLOD: this.useAdaptiveLOD,
      useFrustumCulling: this.useFrustumCulling,
      forceLODLevel: this.forceLODLevel,
      lodBuffersCount: lodBuffers.length,
      spatialIndicesCount: this.spatialIndices.size,
      hasSpatialIndex: !!spatialIndex,
      spatialIndexPointCount: spatialIndex?.pointCount,
      stats: { ...this.stats }
    };
    console.log('[HighPerfRenderer] Current Status:', status);
    if (spatialIndex) {
      const validation = spatialIndex.validatePointCount();
      console.log('[HighPerfRenderer] Spatial Index Validation:', validation);
    }
    return status;
  }

  setForceLOD(level) {
    this._assertOperational('set forced LOD');
    this.forceLODLevel = level;
    if (level >= 0) {
      console.log(`[HighPerfRenderer] Force LOD level: ${level}`);
    } else {
      console.log('[HighPerfRenderer] LOD mode: Auto');
    }
  }

  setFrustumCulling(enabled) {
    if (typeof enabled !== 'boolean') {
      throw new TypeError(
        'HighPerfRenderer frustum-culling enabled must be a boolean.'
      );
    }
    this._assertOperational('set frustum culling');
    if (enabled === this.useFrustumCulling) return;

    if (enabled) {
      this._prepareSpatialIndicesForFeature(
        this._needsLodResources(-1)
      );
    }

    this.useFrustumCulling = enabled;
    for (const viewState of this._perViewState.values()) {
      this._invalidateViewStateRecord(viewState);
    }
    this.stats.frustumCulled = false;
    this.stats.cullPercent = 0;
    console.log(
      `[HighPerfRenderer] Frustum culling ${enabled ? 'enabled' : 'disabled'}`
    );
  }

  /**
   * Get spatial index for a specific dimension level.
   * Returns null if not yet built - use ensureSpatialIndex() to build first.
   * @param {number} dimensionLevel - The dimension level (1, 2, or 3)
   * @returns {SpatialIndex|null} The spatial index for the dimension, or null if not built
   */
  getSpatialIndex(dimensionLevel) {
    this._assertOperational('get a spatial index');
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer getSpatialIndex dimensionLevel'
    );
    const spatialIndex = this.spatialIndices.get(dim) || null;
    return spatialIndex === null
      ? null
      : getReadOnlySpatialProjection(
        spatialIndex,
        `HighPerfRenderer ${dim}D spatial index`
      );
  }

  /**
   * Check if spatial index exists for a specific dimension level.
   * @param {number} dimensionLevel - The dimension level (1, 2, or 3)
   * @returns {boolean} True if spatial index exists for the dimension
   */
  hasSpatialIndex(dimensionLevel) {
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer hasSpatialIndex dimensionLevel'
    );
    return this.spatialIndices.has(dim);
  }

  /**
   * Ensure spatial index exists for the specified dimension.
   * Creates it if needed. Use for collision detection or other features that need spatial index.
   * @param {number} dimensionLevel - The dimension level (1, 2, or 3) - REQUIRED
   */
  ensureSpatialIndex(dimensionLevel) {
    this._assertOperational('ensure a spatial index');
    const dimLevel = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer ensureSpatialIndex dimensionLevel'
    );

    if (this.pointCount > 0 && this._positions) {
      const existingIndex = this.spatialIndices.get(dimLevel);
      const indexStale = existingIndex && existingIndex.pointCount !== this.pointCount;

      if (!existingIndex || indexStale) {
        if (indexStale) {
          console.log(`[HighPerfRenderer] ${dimLevel}D spatial index stale, rebuilding...`);
          this.clearAllViewState();
          this.spatialIndices.clear();
          this._clearLodBuffers();  // Properly delete GL buffers before clearing
          this._clearLodIndexTextures();  // Clear dimension-aware LOD index textures
        } else {
          console.log(`[HighPerfRenderer] Building ${dimLevel}D spatial index...`);
        }
        this._getOrBuildSpatialIndexForDimension(
          dimLevel,
          false,
          this._needsLodResources(-1)
        );
      }
    }
  }

  getStats(viewId) {
    const vid = requireViewId(viewId, 'HighPerfRenderer stats viewId');
    const viewState = this._perViewState.get(vid);
    if (!viewState?.stats || viewState.statsPublished !== true) {
      throw new Error(
        `HighPerfRenderer has no published render statistics for view "${vid}".`
      );
    }
    return {
      ...viewState.stats,
      gpuMemoryMB: this.stats.gpuMemoryMB
    };
  }

  hasStats(viewId) {
    const vid = requireViewId(viewId, 'HighPerfRenderer stats readiness viewId');
    return this._perViewState.get(vid)?.statsPublished === true;
  }

  /**
   * Publish current-frame and exact per-view render statistics without
   * allocating a temporary record on every pane render.
   * @param {Object} viewState - Exact per-view state object.
   * @param {number} visiblePoints - Number of submitted points.
   * @param {number} lodLevel - Exact selected LOD level.
   * @param {number} drawCalls - Number of point draw calls.
   * @param {boolean} frustumCulled - Whether frustum admission was active.
   * @param {number} cullPercent - Percentage removed by frustum admission.
   * @private
   */
  _writeStats(
    viewState,
    visiblePoints,
    lodLevel,
    drawCalls,
    frustumCulled,
    cullPercent
  ) {
    if (!viewState?.stats) {
      throw new Error('HighPerfRenderer statistics require an exact per-view state.');
    }
    this.stats.visiblePoints = visiblePoints;
    this.stats.lodLevel = lodLevel;
    this.stats.drawCalls = drawCalls;
    this.stats.frustumCulled = frustumCulled;
    this.stats.cullPercent = cullPercent;
    viewState.stats.visiblePoints = visiblePoints;
    viewState.stats.lodLevel = lodLevel;
    viewState.stats.drawCalls = drawCalls;
    viewState.stats.frustumCulled = frustumCulled;
    viewState.stats.cullPercent = cullPercent;
    viewState.statsPublished = true;
  }

  /**
   * Compatibility wrapper for non-rendering callers and focused contracts.
   * @param {Object} viewState - Exact per-view state object.
   * @param {Object} statsUpdate - Object with stats to update (visiblePoints, lodLevel, drawCalls, frustumCulled, cullPercent)
   * @private
   */
  _updateStats(viewState, statsUpdate) {
    if (!viewState?.stats) {
      throw new Error('HighPerfRenderer statistics require an exact per-view state.');
    }
    if (!statsUpdate || typeof statsUpdate !== 'object') {
      throw new TypeError('HighPerfRenderer statistics update must be an object.');
    }
    this._writeStats(
      viewState,
      statsUpdate.visiblePoints,
      statsUpdate.lodLevel,
      statsUpdate.drawCalls,
      statsUpdate.frustumCulled,
      statsUpdate.cullPercent
    );
  }

  /**
   * Publish exact timing for the view rendered by the current call.
   * The global fields remain a last-render diagnostic only; public view stats
   * are always read from the owning per-view state.
   *
   * @param {Object} viewState - Exact per-view state object.
   * @param {number} frameStart - performance.now() captured for this render.
   * @private
   */
  _publishFrameTiming(viewState, frameStart) {
    if (!viewState?.stats) {
      throw new Error('HighPerfRenderer frame timing requires an exact per-view state.');
    }
    const lastFrameTime = performance.now() - frameStart;
    const fps = lastFrameTime > 0
      ? Math.round(1000 / lastFrameTime)
      : 0;
    viewState.stats.lastFrameTime = lastFrameTime;
    viewState.stats.fps = fps;
    viewState.statsPublished = true;
    this.stats.lastFrameTime = lastFrameTime;
    this.stats.fps = fps;
  }

  /**
   * Get aggregated stats across all views (for multiview rendering).
   * Returns sum/average of per-view stats plus a views array with individual stats.
   * @returns {Object} Aggregated stats: { totalVisiblePoints, totalDrawCalls, avgCullPercent, viewCount, views: [...] }
   */
  getAggregatedStats() {
    const views = [];
    let totalVisiblePoints = 0;
    let totalDrawCalls = 0;
    let totalCullPercent = 0;
    let culledViewCount = 0;
    let totalFrameTime = 0;

    for (const [viewId, viewState] of this._perViewState) {
      if (viewState.statsPublished === true) {
        const vs = viewState.stats;
        views.push({
          viewId,
          lastFrameTime: vs.lastFrameTime,
          fps: vs.fps,
          visiblePoints: vs.visiblePoints,
          lodLevel: vs.lodLevel,
          drawCalls: vs.drawCalls,
          frustumCulled: vs.frustumCulled,
          cullPercent: vs.cullPercent
        });
        totalVisiblePoints += vs.visiblePoints;
        totalDrawCalls += vs.drawCalls;
        totalFrameTime += vs.lastFrameTime;
        if (vs.frustumCulled) {
          totalCullPercent += vs.cullPercent;
          culledViewCount++;
        }
      }
    }

    return {
      totalVisiblePoints,
      totalDrawCalls,
      avgCullPercent: culledViewCount > 0 ? totalCullPercent / culledViewCount : 0,
      viewCount: views.length,
      views,
      // A complete grid frame performs each published view render serially.
      lastFrameTime: totalFrameTime,
      fps: totalFrameTime > 0
        ? Math.round(1000 / totalFrameTime)
        : 0,
      gpuMemoryMB: this.stats.gpuMemoryMB
    };
  }

  getPositions() {
    return this._positions;
  }

  /**
   * Return the exact immutable geometry-publication certificate for one view.
   * Consumers may key derived read-only resources by this number without
   * receiving access to the renderer's mutable ownership records.
   *
   * @param {string} viewId - `live` or an exact snapshot ID.
   * @returns {number} Positive safe-integer geometry generation.
   */
  getViewGeometryGeneration(viewId) {
    const exactViewId = requireViewId(
      viewId,
      'HighPerfRenderer geometry-generation viewId'
    );
    let generation;
    if (exactViewId === 'live') {
      generation = this._liveGeometryGeneration;
      if (
        !this._positions ||
        !Number.isSafeInteger(generation) ||
        generation <= 0
      ) {
        throw new RangeError(
          'HighPerfRenderer live view has no published geometry generation.'
        );
      }
    } else {
      const snapshot = this.snapshotBuffers.get(exactViewId);
      if (!snapshot) {
        throw new RangeError(
          `HighPerfRenderer view "${exactViewId}" does not exist.`
        );
      }
      generation = snapshot.geometryGeneration;
      if (!Number.isSafeInteger(generation) || generation <= 0) {
        throw new Error(
          `HighPerfRenderer snapshot "${exactViewId}" has no exact geometry generation.`
        );
      }
    }
    return generation;
  }

  /**
   * Read-only fog range accessors for overlays and export utilities.
   * @returns {number}
   */
  getFogNear() { return this.fogNear; }

  /**
   * @returns {number}
   */
  getFogFar() { return this.fogFar; }

  /**
   * Read-only alpha texture accessors for overlays.
   * The alpha texture is the canonical visibility mask for filters/outliers.
   *
   * @returns {WebGLTexture|null}
   */
  getAlphaTexture() { return this._alphaTexture; }

  /**
   * @returns {number}
   */
  getAlphaTextureWidth() { return this._alphaTexWidth; }

  /**
   * @returns {boolean}
   */
  isAlphaTextureActive() { return Boolean(this._useAlphaTexture && this._alphaTexture && this._alphaTexWidth > 0); }

  /**
   * Resolve the exact accepted alpha texture for one pane. The live view uses
   * its mutable global publication; snapshots use their independent R8 owner.
   */
  getAlphaTextureForView(viewId) {
    const exactViewId = requireViewId(
      viewId,
      'HighPerfRenderer alpha-texture viewId'
    );
    if (exactViewId === 'live') return this.getAlphaTexture();
    return this.snapshotBuffers.get(exactViewId)?.alphaTexture ?? null;
  }

  getAlphaTextureWidthForView(viewId) {
    const exactViewId = requireViewId(
      viewId,
      'HighPerfRenderer alpha-width viewId'
    );
    if (exactViewId === 'live') {
      return this.getAlphaTextureWidth();
    }
    return this.snapshotBuffers.get(exactViewId)?.alphaTexWidth ?? 0;
  }

  isAlphaTextureActiveForView(viewId) {
    const exactViewId = requireViewId(
      viewId,
      'HighPerfRenderer alpha-activity viewId'
    );
    if (exactViewId === 'live') {
      return this.isAlphaTextureActive();
    }
    const snapshot = this.snapshotBuffers.get(exactViewId);
    return Boolean(
      snapshot?.alphaTexture &&
      snapshot?.alphaTexData instanceof Uint8Array &&
      Number.isSafeInteger(snapshot.alphaTexWidth) &&
      snapshot.alphaTexWidth > 0 &&
      Number.isSafeInteger(snapshot.alphaTexHeight) &&
      snapshot.alphaTexHeight > 0 &&
      snapshot.alphaTexData.length ===
        snapshot.alphaTexWidth * snapshot.alphaTexHeight &&
      snapshot.alphaTextureByteLength ===
        snapshot.alphaTexData.byteLength
    );
  }

  /**
   * Resolve the CPU spatial owner for one exact view geometry generation.
   * @param {string} viewId
   * @param {number} dimensionLevel
   * @returns {SpatialIndex|null}
   */
  _getSpatialIndexForViewGeneration(viewId, dimensionLevel) {
    const exactViewId = requireViewId(
      viewId,
      'HighPerfRenderer spatial-owner viewId'
    );
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer spatial-owner dimensionLevel'
    );
    const snapshot = this.snapshotBuffers.get(exactViewId);
    if (snapshot === undefined) {
      return this.spatialIndices.get(dim) || null;
    }
    if (snapshot.dimensionLevel !== dim) {
      throw new Error(
        `HighPerfRenderer snapshot "${exactViewId}" owns ${snapshot.dimensionLevel}D data but received a ${dim}D spatial-owner request.`
      );
    }
    if (this._snapshotUsesLiveGeometry(snapshot)) {
      return this.spatialIndices.get(dim) || null;
    }
    return (
      snapshot.spatialIndex?.positions === snapshot.positions &&
      snapshot.spatialIndex.dimensionLevel === dim
    )
      ? snapshot.spatialIndex
      : null;
  }

  /**
   * Get the original point indices included in the current LOD level for a view.
   * Returns null when LOD is inactive (lodLevel < 0) or unavailable.
   *
   * Useful for overlays that want to downsample spawn sources without scanning
   * the full `pointCount` array on the CPU.
   *
   * @param {string} viewId
   * @param {number} dimensionLevel
   * @returns {Uint32Array|null}
   */
  getCurrentLodIndices(viewId, dimensionLevel) {
    this._assertOperational('get current LOD indices');
    const exactViewId = requireViewId(
      viewId,
      'HighPerfRenderer LOD-index viewId'
    );
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer LOD-index dimensionLevel'
    );
    const lodLevel = this.getCurrentLODLevel(exactViewId);
    if (lodLevel < 0) return null;

    const snapshot = this.snapshotBuffers.get(exactViewId);
    const spatialIndex = this._getSpatialIndexForViewGeneration(
      exactViewId,
      dim
    );

    if (!spatialIndex) {
      if (
        snapshot !== undefined &&
        !this._snapshotUsesLiveGeometry(snapshot)
      ) {
        throw new Error(
          `HighPerfRenderer snapshot "${exactViewId}" has no current ${dim}D spatial index for active LOD level ${lodLevel}.`
        );
      }
      throw new Error(
        `HighPerfRenderer has no ${dim}D spatial index for active LOD level ${lodLevel}.`
      );
    }
    const level = spatialIndex.lodLevels[lodLevel];
    if (level?.isFullDetail === true) {
      return null;
    }
    if (!(level?.indices instanceof Uint32Array)) {
      throw new Error(
        `HighPerfRenderer LOD ${lodLevel} index ownership is unavailable for ${dim}D view "${exactViewId}".`
      );
    }
    return level.indices;
  }

  /**
   * Return the exact shared random-access membership owner for the LOD that
   * one view currently renders. Disabled and terminal full-detail LOD use
   * null, meaning every source point is admitted.
   *
   * Descriptor identity is part of the contract: a different dimension,
   * spatial rebuild, or custom snapshot geometry publishes a different owner
   * even when its numeric LOD level happens to match.
   *
   * @param {string} viewId
   * @param {number} dimensionLevel
   * @returns {{
   *   admissionLevels: Uint8Array,
   *   dimensionLevel: number,
   *   generationToken: Object,
   *   indices: Uint32Array,
   *   lodLevel: number,
   *   pointCount: number
   * }|null}
   */
  getCurrentLodMembership(viewId, dimensionLevel) {
    this._assertOperational('get current LOD membership');
    const exactViewId = requireViewId(
      viewId,
      'HighPerfRenderer LOD-membership viewId'
    );
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer LOD-membership dimensionLevel'
    );
    const lodLevel = this.getCurrentLODLevel(exactViewId);
    if (lodLevel < 0) return null;

    const snapshot = this.snapshotBuffers.get(exactViewId);
    const spatialIndex = this._getSpatialIndexForViewGeneration(
      exactViewId,
      dim
    );
    if (!spatialIndex) {
      if (
        snapshot !== undefined &&
        !this._snapshotUsesLiveGeometry(snapshot)
      ) {
        throw new Error(
          `HighPerfRenderer snapshot "${exactViewId}" has no current ${dim}D spatial index for active LOD level ${lodLevel}.`
        );
      }
      throw new Error(
        `HighPerfRenderer has no ${dim}D spatial index for active LOD level ${lodLevel}.`
      );
    }
    const level = spatialIndex.lodLevels?.[lodLevel];
    if (!level) {
      throw new Error(
        `HighPerfRenderer LOD ${lodLevel} spatial owner is unavailable for ${dim}D view "${exactViewId}".`
      );
    }
    if (level.isFullDetail === true) return null;
    if (typeof spatialIndex.getLodMembership !== 'function') {
      throw new Error(
        `HighPerfRenderer LOD ${lodLevel} membership ownership is unavailable for ${dim}D view "${exactViewId}".`
      );
    }
    const membership = spatialIndex.getLodMembership(lodLevel);
    if (
      membership === null ||
      !Object.isFrozen(membership) ||
      !(membership.admissionLevels instanceof Uint8Array) ||
      membership.admissionLevels.length !== this.pointCount ||
      membership.dimensionLevel !== dim ||
      membership.indices !== level.indices ||
      !(membership.indices instanceof Uint32Array) ||
      membership.indices.length !== level.pointCount ||
      membership.lodLevel !== lodLevel ||
      membership.pointCount !== this.pointCount ||
      membership.generationToken === null ||
      typeof membership.generationToken !== 'object'
    ) {
      throw new Error(
        `HighPerfRenderer LOD ${lodLevel} membership descriptor is invalid for ${dim}D view "${exactViewId}".`
      );
    }
    return membership;
  }

  /**
   * Return the lightweight identity of the spatial owner backing the current
   * reduced LOD. This never constructs the O(N) random-access membership
   * table; full detail is represented by null.
   *
   * @param {string} viewId
   * @param {number} dimensionLevel
   * @returns {Object|null}
   */
  getCurrentLodOwnerToken(viewId, dimensionLevel) {
    this._assertOperational('get the current LOD owner');
    const exactViewId = requireViewId(
      viewId,
      'HighPerfRenderer LOD-owner viewId'
    );
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer LOD-owner dimensionLevel'
    );
    const lodLevel = this.getCurrentLODLevel(exactViewId);
    if (lodLevel < 0) return null;
    const spatialIndex = this._getSpatialIndexForViewGeneration(
      exactViewId,
      dim
    );
    const level = spatialIndex?.lodLevels?.[lodLevel];
    if (!level) {
      throw new Error(
        `HighPerfRenderer LOD ${lodLevel} spatial owner is unavailable for ${dim}D view "${exactViewId}".`
      );
    }
    if (level.isFullDetail === true) return null;
    let token = this._lodSpatialOwnerTokens.get(spatialIndex);
    if (token === undefined) {
      token = Object.freeze({});
      this._lodSpatialOwnerTokens.set(spatialIndex, token);
    }
    return token;
  }

  /**
   * Return the exact immutable descriptor for sequential consumers of the
   * current reduced LOD. Unlike getCurrentLodMembership(), this path never
   * constructs the point-count admission table: membership is represented by
   * the renderer-owned admitted index prefix and a stable spatial-generation
   * token. Disabled and terminal full-detail LOD use null.
   *
   * @param {string} viewId
   * @param {number} dimensionLevel
   * @returns {{
   *   dimensionLevel: number,
   *   generationToken: Object,
   *   indices: Uint32Array,
   *   lodLevel: number,
   *   pointCount: number
   * }|null}
   */
  getCurrentLodSequentialMembership(viewId, dimensionLevel) {
    this._assertOperational('get sequential LOD membership');
    const exactViewId = requireViewId(
      viewId,
      'HighPerfRenderer sequential LOD viewId'
    );
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer sequential LOD dimensionLevel'
    );
    const lodLevel = this.getCurrentLODLevel(exactViewId);
    if (lodLevel < 0) return null;
    const spatialIndex = this._getSpatialIndexForViewGeneration(
      exactViewId,
      dim
    );
    const level = spatialIndex?.lodLevels?.[lodLevel];
    if (!level) {
      throw new Error(
        `HighPerfRenderer LOD ${lodLevel} spatial owner is unavailable for ${dim}D view "${exactViewId}".`
      );
    }
    if (level.isFullDetail === true) return null;
    if (
      level.isFullDetail !== false ||
      !(level.indices instanceof Uint32Array) ||
      !Number.isSafeInteger(level.pointCount) ||
      level.pointCount !== level.indices.length ||
      !Number.isSafeInteger(spatialIndex.pointCount) ||
      spatialIndex.pointCount < level.pointCount
    ) {
      throw new Error(
        `HighPerfRenderer LOD ${lodLevel} sequential membership is invalid for ${dim}D view "${exactViewId}".`
      );
    }
    let membership = this._lodSequentialMemberships.get(level);
    if (membership !== undefined) return membership;
    const generationToken = this.getCurrentLodOwnerToken(
      exactViewId,
      dim
    );
    if (generationToken === null) {
      throw new Error(
        `HighPerfRenderer LOD ${lodLevel} has no sequential generation owner for ${dim}D view "${exactViewId}".`
      );
    }
    membership = Object.freeze({
      dimensionLevel: dim,
      generationToken,
      indices: level.indices,
      lodLevel,
      pointCount: spatialIndex.pointCount,
    });
    this._lodSequentialMemberships.set(level, membership);
    return membership;
  }

  /**
   * Get the number of LOD levels for the current dimension.
   * @param {number} dimensionLevel - Exact dimension level.
   * @returns {number} Number of LOD levels
   */
  getLODLevelCount(dimensionLevel) {
    this._assertOperational('get the LOD level count');
    const lodBuffers =
      this._getLodBuffersForDimension(dimensionLevel);
    return lodBuffers.length;
  }

  /**
   * Get the current LOD level being rendered (-1 = full detail)
   * @param {string} viewId - Exact view ID.
   * @returns {number} LOD level (-1 = full detail or LOD disabled)
   */
  getCurrentLODLevel(viewId) {
    const exactViewId = requireViewId(
      viewId,
      'HighPerfRenderer LOD-level viewId'
    );
    const viewState = this._perViewState.get(exactViewId);
    if (viewState === undefined) return -1;
    if (!Number.isInteger(viewState.lastLodLevel) || viewState.lastLodLevel < -1) {
      throw new Error(
        `HighPerfRenderer LOD state is invalid for view "${exactViewId}".`
      );
    }
    return viewState.lastLodLevel;
  }

  /**
   * Get the size multiplier for the current LOD level (1.0 for full detail).
   * @param {string} viewId - Exact view ID.
   * @param {number} dimensionLevel - Exact dimension level.
   * @returns {number} Size multiplier (1.0 for full detail)
   */
  getCurrentLODSizeMultiplier(viewId, dimensionLevel) {
    const exactViewId = requireViewId(
      viewId,
      'HighPerfRenderer LOD-size viewId'
    );
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer LOD-size dimensionLevel'
    );
    const lodLevel = this.getCurrentLODLevel(exactViewId);
    if (lodLevel < 0) return 1.0;
    const spatialIndex = this._getSpatialIndexForViewGeneration(
      exactViewId,
      dim
    );
    const level = spatialIndex?.lodLevels?.[lodLevel];
    if (!level) {
      throw new Error(
        `HighPerfRenderer LOD ${lodLevel} spatial owner is unavailable for ${dim}D view "${exactViewId}".`
      );
    }
    if (level.isFullDetail) return 1.0;
    const sizeMultiplier = level.sizeMultiplier;
    if (!Number.isFinite(sizeMultiplier)) {
      throw new TypeError(
        `HighPerfRenderer LOD ${lodLevel} sizeMultiplier for view "${exactViewId}" must be a finite number; received ${String(sizeMultiplier)}.`
      );
    }
    if (sizeMultiplier <= 0) {
      throw new RangeError(
        `HighPerfRenderer LOD ${lodLevel} sizeMultiplier for view "${exactViewId}" must be positive.`
      );
    }
    return sizeMultiplier;
  }

  // ===========================================================================
  // SNAPSHOT BUFFER MANAGEMENT (for multi-view rendering without re-uploads)
  // ===========================================================================

  _getSnapshotAlphaTextureLayout(pointCount, owner) {
    if (!Number.isSafeInteger(pointCount) || pointCount <= 0) {
      throw new RangeError(
        `${owner} point count must be a positive safe integer.`
      );
    }
    const maxTextureSize = this.gl.getParameter(
      this.gl.MAX_TEXTURE_SIZE
    );
    if (
      !Number.isSafeInteger(maxTextureSize) ||
      maxTextureSize <= 0
    ) {
      throw new Error(
        `${owner} received an invalid MAX_TEXTURE_SIZE capability.`
      );
    }
    const width = Math.min(pointCount, maxTextureSize);
    const height = Math.ceil(pointCount / width);
    if (height > maxTextureSize) {
      throw new RangeError(
        `${owner} cannot represent ${pointCount.toLocaleString()} alpha values in the exact ${maxTextureSize}x${maxTextureSize} texture capacity.`
      );
    }
    return {
      height,
      requiredSize: width * height,
      width,
    };
  }

  _packSnapshotRgb(colors, owner) {
    const exactColors = requireSnapshotColors(
      this.pointCount,
      colors,
      owner
    );
    const requiredSize = this.pointCount * 3;
    let staging = this._snapshotColorStagingData;
    if (
      !(staging instanceof Uint8Array) ||
      staging.length !== requiredSize
    ) {
      staging = new Uint8Array(requiredSize);
      this._snapshotColorStagingData = staging;
    }
    for (
      let pointIndex = 0, rgbIndex = 0;
      pointIndex < this.pointCount;
      pointIndex++, rgbIndex += 3
    ) {
      const rgbaIndex = pointIndex * 4;
      staging[rgbIndex] = exactColors[rgbaIndex];
      staging[rgbIndex + 1] = exactColors[rgbaIndex + 1];
      staging[rgbIndex + 2] = exactColors[rgbaIndex + 2];
    }
    return staging;
  }

  _packSnapshotRgbAndAlpha(
    colors,
    alphas,
    alphaTarget,
    owner
  ) {
    const exactColors = requireSnapshotColors(
      this.pointCount,
      colors,
      owner
    );
    const exactAlphas = alphas === null
      ? null
      : requireSnapshotAlphas(
          this.pointCount,
          alphas,
          owner
        );
    if (
      !(alphaTarget instanceof Uint8Array) ||
      alphaTarget.length < this.pointCount
    ) {
      throw new TypeError(
        `${owner} R8 target must contain at least one byte per point.`
      );
    }
    const requiredRgbSize = this.pointCount * 3;
    let rgb = this._snapshotColorStagingData;
    if (
      !(rgb instanceof Uint8Array) ||
      rgb.length !== requiredRgbSize
    ) {
      rgb = new Uint8Array(requiredRgbSize);
      this._snapshotColorStagingData = rgb;
    }

    for (
      let pointIndex = 0, rgbIndex = 0;
      pointIndex < this.pointCount;
      pointIndex++, rgbIndex += 3
    ) {
      const rgbaIndex = pointIndex * 4;
      rgb[rgbIndex] = exactColors[rgbaIndex];
      rgb[rgbIndex + 1] = exactColors[rgbaIndex + 1];
      rgb[rgbIndex + 2] = exactColors[rgbaIndex + 2];
      if (exactAlphas === null) {
        alphaTarget[pointIndex] =
          exactColors[rgbaIndex + 3];
      } else {
        const value = exactAlphas[pointIndex];
        if (
          !Number.isFinite(value) ||
          value < 0 ||
          value > 1
        ) {
          throw new RangeError(
            `${owner} alpha value at index ${pointIndex} must be finite and in [0, 1].`
          );
        }
        alphaTarget[pointIndex] =
          Math.round(value * 255);
      }
    }
    alphaTarget.fill(255, this.pointCount);
    return rgb;
  }

  _encodeSnapshotAlphaData(
    target,
    colors,
    alphas,
    owner,
    accepted = null
  ) {
    if (
      !(target instanceof Uint8Array) ||
      target.length < this.pointCount
    ) {
      throw new TypeError(
        `${owner} R8 target must contain at least one byte per point.`
      );
    }
    if (
      accepted !== null &&
      (
        !(accepted instanceof Uint8Array) ||
        accepted.length !== target.length
      )
    ) {
      throw new TypeError(
        `${owner} accepted R8 owner must match the padded target length.`
      );
    }
    const exactColors = alphas === null
      ? requireSnapshotColors(
          this.pointCount,
          colors,
          owner
        )
      : null;
    const exactAlphas = alphas === null
      ? null
      : requireSnapshotAlphas(
        this.pointCount,
        alphas,
        owner
      );
    let changed = false;
    for (let index = 0; index < this.pointCount; index++) {
      let byte;
      if (exactAlphas === null) {
        byte = exactColors[index * 4 + 3];
      } else {
        const value = exactAlphas[index];
        if (
          !Number.isFinite(value) ||
          value < 0 ||
          value > 1
        ) {
          throw new RangeError(
            `${owner} alpha value at index ${index} must be finite and in [0, 1].`
          );
        }
        byte = Math.round(value * 255);
      }
      if (
        accepted === null
          ? target[index] !== byte
          : accepted[index] !== byte
      ) {
        changed = true;
      }
      target[index] = byte;
    }
    for (
      let index = this.pointCount;
      index < target.length;
      index++
    ) {
      if (
        accepted === null
          ? target[index] !== 255
          : accepted[index] !== 255
      ) {
        changed = true;
      }
      target[index] = 255;
    }
    return changed;
  }

  _acquireSnapshotAlphaStaging(requiredSize) {
    if (
      !Number.isSafeInteger(requiredSize) ||
      requiredSize < this.pointCount
    ) {
      throw new RangeError(
        'HighPerfRenderer snapshot alpha staging requires an exact padded texture size.'
      );
    }
    let staging = this._snapshotAlphaStagingData;
    this._snapshotAlphaStagingData = null;
    if (
      !(staging instanceof Uint8Array) ||
      staging.length !== requiredSize
    ) {
      staging = new Uint8Array(requiredSize);
      staging.fill(255);
    }
    for (const snapshot of this.snapshotBuffers.values()) {
      if (snapshot.alphaTexData === staging) {
        throw new Error(
          'HighPerfRenderer snapshot alpha staging aliases an accepted view owner.'
        );
      }
    }
    return staging;
  }

  _donateSnapshotAlphaStaging(data) {
    if (!(data instanceof Uint8Array)) return;
    for (const snapshot of this.snapshotBuffers.values()) {
      if (snapshot.alphaTexData === data) return;
    }
    if (
      !(this._snapshotAlphaStagingData instanceof Uint8Array) ||
      this._snapshotAlphaStagingData.length !== data.length
    ) {
      this._snapshotAlphaStagingData = data;
    }
  }

  _releaseSnapshotScratchIfUnused() {
    if (
      !(this.snapshotBuffers instanceof Map) ||
      this.snapshotBuffers.size !== 0
    ) {
      return;
    }
    this._snapshotColorStagingData = null;
    this._snapshotAlphaStagingData = null;
  }

  _uploadNewSnapshotAlphaTexture(
    data,
    width,
    height,
    label,
    staging
  ) {
    if (
      !(data instanceof Uint8Array) ||
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      !Number.isSafeInteger(height) ||
      height <= 0 ||
      data.length !== width * height ||
      !staging ||
      staging.alphaTexture !== null ||
      staging.alphaTextureByteLength !== 0
    ) {
      throw new Error(
        `${label} received incomplete R8 texture staging.`
      );
    }
    const gl = this.gl;
    requireCleanWebGLState(gl, `${label} preflight`);
    const texture = gl.createTexture();
    if (!texture) {
      throw new Error(
        `${label} could not allocate its R8 texture.`
      );
    }
    staging.alphaTexture = texture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    try {
      this._withNeutralTextureUnpackState(1, label, () => {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.R8,
          width,
          height,
          0,
          gl.RED,
          gl.UNSIGNED_BYTE,
          data
        );
        requireCleanWebGLState(gl, `${label} upload`);
      });
      staging.alphaTextureByteLength = data.byteLength;
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        gl.NEAREST
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MAG_FILTER,
        gl.NEAREST
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_S,
        gl.CLAMP_TO_EDGE
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_T,
        gl.CLAMP_TO_EDGE
      );
      requireCleanWebGLState(gl, `${label} parameters`);
    } finally {
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    return texture;
  }

  _uploadSnapshotAlphaTextureData(
    snapshot,
    data,
    label
  ) {
    if (
      !snapshot?.alphaTexture ||
      !(data instanceof Uint8Array) ||
      !Number.isSafeInteger(snapshot.alphaTexWidth) ||
      snapshot.alphaTexWidth <= 0 ||
      !Number.isSafeInteger(snapshot.alphaTexHeight) ||
      snapshot.alphaTexHeight <= 0 ||
      data.length !==
        snapshot.alphaTexWidth * snapshot.alphaTexHeight
    ) {
      throw new Error(
        `${label} received incomplete accepted snapshot R8 state.`
      );
    }
    const gl = this.gl;
    requireCleanWebGLState(gl, `${label} preflight`);
    gl.bindTexture(gl.TEXTURE_2D, snapshot.alphaTexture);
    try {
      this._withNeutralTextureUnpackState(1, label, () => {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          snapshot.alphaTexWidth,
          snapshot.alphaTexHeight,
          gl.RED,
          gl.UNSIGNED_BYTE,
          data
        );
        requireCleanWebGLState(gl, label);
      });
    } finally {
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  /**
   * Create a GPU buffer for a snapshot view. Call this once when snapshot is created.
   * The snapshot owns one RGB VBO plus one R8 alpha texture and references its
   * geometry generation's shared immutable position VBO through its VAO.
   * @param {string} id - Unique snapshot identifier
   * @param {Uint8Array} colors - Exact RGBA colors.
   * @param {Float32Array|null} alphas - Exact alpha values or null to use RGBA alpha.
   * @param {Float32Array} viewPositions - Exact positions owned by this view.
   * @param {number} dimensionLevel - Exact published view dimension.
   * @param {string} sourceViewId - Exact view that owns viewPositions.
   * @returns {boolean} Success
   */
  createSnapshotBuffer(
    id,
    colors,
    alphas,
    viewPositions,
    dimensionLevel,
    sourceViewId
  ) {
    this._assertOperational('create a snapshot buffer');
    const exactId = requireViewId(id, 'HighPerfRenderer snapshot id');
    const exactDimensionLevel = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer snapshot dimensionLevel'
    );
    if (!this._positions || this.pointCount === 0) {
      throw new Error('HighPerfRenderer cannot create a snapshot before point data is loaded.');
    }
    if (this.snapshotBuffers.has(exactId)) {
      throw new Error(`HighPerfRenderer snapshot "${exactId}" already exists.`);
    }

    const gl = this.gl;
    const n = this.pointCount;
    const pointData = requireSnapshotPointData(
      n,
      viewPositions,
      colors,
      alphas,
      `HighPerfRenderer snapshot "${exactId}"`
    );
    const owner = `HighPerfRenderer snapshot "${exactId}"`;
    const alphaLayout =
      this._getSnapshotAlphaTextureLayout(n, owner);
    const alphaData = this._acquireSnapshotAlphaStaging(
      alphaLayout.requiredSize
    );
    let snapshotRgb;
    try {
      snapshotRgb = this._packSnapshotRgbAndAlpha(
        pointData.colors,
        pointData.alphas,
        alphaData,
        owner
      );
    } catch (error) {
      this._donateSnapshotAlphaStaging(alphaData);
      this._releaseSnapshotScratchIfUnused();
      throw error;
    }
    let geometry;
    try {
      geometry = this._acquireSnapshotGeometryFromSource(
        sourceViewId,
        pointData.positions
      );
    } catch (error) {
      this._donateSnapshotAlphaStaging(alphaData);
      this._releaseSnapshotScratchIfUnused();
      throw error;
    }
    const positions = geometry.positions;

    // Snapshot positions are an immutable renderer-owned CPU publication.
    // Generation equality, not array identity, proves whether main LOD/frustum
    // resources index the same coordinates.
    const hasCustomPositions =
      geometry.generation !== this._liveGeometryGeneration;

    const needsSpatialIndex = this._needsSpatialIndex(-1);

    // Build spatial index for custom positions (enables fast frustum culling/LOD for 2D/1D views)
    // This replaces brute-force O(n) culling with O(log n) hierarchical culling.
    // IMPORTANT: Only build when frustum culling or LOD is enabled; otherwise this is wasted work
    // (especially during 3D↔2D switching in multiview).
    let spatialIndex = null;
    let colorBuffer = null;
    let colorBufferByteLength = 0;
    let colorOwner = null;
    let vao = null;
    const alphaStaging = {
      alphaTexture: null,
      alphaTextureByteLength: 0,
    };
    const positionStaging = {
      positionBuffer: null,
      positionBufferByteLength: 0,
    };
    let notification = null;
    let notificationCompleted = false;
    let snapshotBounds = null;
    try {
      snapshotBounds =
        HighPerfRenderer.computeBoundsFromPositions(positions);

      if (hasCustomPositions && needsSpatialIndex) {
        const needsLOD = this._needsLodResources(-1);
        spatialIndex = this._getPooledSnapshotSpatialIndex(
          geometry.generation,
          positions,
          exactDimensionLevel,
          needsLOD
        );
        if (spatialIndex === null) {
          console.log(`[HighPerfRenderer] Building ${exactDimensionLevel}D spatial index for snapshot "${exactId}"...`);

          const notifications = getNotificationCenter();
          const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
          const treeName = treeNames[exactDimensionLevel];
          const notifId = notifications.startCalculation(
            `Building ${exactDimensionLevel}D ${treeName} for view "${exactId}" (${n.toLocaleString()} cells)`,
            'spatial'
          );
          notification = {
            notifications,
            notifId,
            treeName,
            startTime: performance.now()
          };

          spatialIndex = new SpatialIndex(
            positions,
            null,
            exactDimensionLevel,
            this.options.LOD_MAX_POINTS_PER_NODE,
            this.options.LOD_MAX_DEPTH,
            {
              buildLOD: needsLOD,
              buildLodNodeMappings: false,
              computeNodeStats: false
            }
          );
          this._publishPooledSnapshotSpatialIndex(
            geometry.generation,
            positions,
            exactDimensionLevel,
            needsLOD,
            spatialIndex
          );
        }
      }

      requireCleanWebGLState(
        gl,
        `HighPerfRenderer snapshot "${exactId}" publication`
      );
      const positionBuffer =
        this._ensureSnapshotGeometryPositionBuffer(
          geometry,
          `HighPerfRenderer snapshot "${exactId}"`,
          positionStaging
        );
      colorBuffer = gl.createBuffer();
      if (!colorBuffer) {
        throw new Error(
          `HighPerfRenderer could not allocate snapshot "${exactId}" color resources.`
        );
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        snapshotRgb,
        gl.STATIC_DRAW
      );
      requireCleanWebGLState(
        gl,
        `HighPerfRenderer candidate snapshot "${exactId}" color-buffer upload`
      );
      colorBufferByteLength = snapshotRgb.byteLength;

      this._uploadNewSnapshotAlphaTexture(
        alphaData,
        alphaLayout.width,
        alphaLayout.height,
        `HighPerfRenderer snapshot "${exactId}" alpha`,
        alphaStaging
      );

      vao = gl.createVertexArray();
      if (!vao) {
        throw new Error(
          `HighPerfRenderer could not allocate snapshot "${exactId}" vertex resources.`
        );
      }
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
      gl.enableVertexAttribArray(1);
      colorOwner = this._createSnapshotColorOwner(
        colorBuffer,
        colorBufferByteLength
      );
      gl.vertexAttribPointer(1, 3, gl.UNSIGNED_BYTE, true, 3, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      requireCleanWebGLState(
        gl,
        `HighPerfRenderer candidate snapshot "${exactId}" publication`
      );

      if (notification !== null) {
        const elapsed = performance.now() - notification.startTime;
        settleCalculationNotification(
          notification.notifications,
          notification.notifId,
          'completeCalculation',
          `${exactDimensionLevel}D ${notification.treeName} ready (view "${exactId}")`,
          elapsed
        );
        notificationCompleted = true;
      }
    } catch (error) {
      const rollbackFailures = [];
      const rollback = operation => {
        try {
          operation();
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      };
      rollback(() => gl.bindVertexArray(null));
      rollback(() => gl.bindBuffer(gl.ARRAY_BUFFER, null));
      this._queueSnapshotRetirement({
        alphaTexture: alphaStaging.alphaTexture,
        alphaTextureByteLength:
          alphaStaging.alphaTextureByteLength,
        id: exactId,
        vao,
        buffer: colorOwner === null ? colorBuffer : null,
        bufferByteLength: colorBufferByteLength,
        colorOwner,
        geometryGeneration: geometry.generation,
        positionBuffer: positionStaging.positionBuffer,
        positionBufferByteLength:
          positionStaging.positionBufferByteLength,
        positions,
      }, {
        releaseAlpha: true,
        releaseColor: true,
        releaseGeometry: true,
        releaseVao: true,
      });
      rollbackFailures.push(
        ...this._drainSnapshotRetirements(exactId)
      );
      rollback(() => gl.getError());
      if (notification !== null && !notificationCompleted) {
        settleCalculationNotification(
          notification.notifications,
          notification.notifId,
          'failCalculation',
          `${exactDimensionLevel}D ${notification.treeName} failed for view "${exactId}": ${describeError(error)}`
        );
      }
      if (rollbackFailures.length > 0) {
        this._donateSnapshotAlphaStaging(alphaData);
        this._releaseSnapshotScratchIfUnused();
        throw new AggregateError(
          [error, ...rollbackFailures],
          `HighPerfRenderer snapshot "${exactId}" creation failed with ${rollbackFailures.length} rollback error(s).`
        );
      }
      this._donateSnapshotAlphaStaging(alphaData);
      this._releaseSnapshotScratchIfUnused();
      throw error;
    }

    this.snapshotBuffers.set(exactId, {
      alphaTexData: alphaData,
      alphaTexHeight: alphaLayout.height,
      alphaTexWidth: alphaLayout.width,
      alphaTexture: alphaStaging.alphaTexture,
      alphaTextureByteLength:
        alphaStaging.alphaTextureByteLength,
      id: exactId,
      vao,
      buffer: colorBuffer,
      bufferByteLength: colorBufferByteLength,
      colorOwner,
      pointCount: n,
      // Store positions reference for future updates (dimension switching)
      positions,
      geometryGeneration: geometry.generation,
      // Store exact owned bounds for fog, LOD, and later live-array replacement.
      bounds: snapshotBounds,
      // Spatial index for fast frustum culling on custom positions (null if using main octree)
      spatialIndex: spatialIndex,
      // Store dimension level used to build the spatial index (for correct LOD/frustum calculations)
      dimensionLevel: exactDimensionLevel
    });
    this._refreshGpuMemoryStats();
    // A prior failed rollback for this ID remains independent of the new
    // publication; retry it opportunistically without making cleanup
    // authoritative over the valid snapshot.
    this._drainSnapshotRetirements(exactId);

    console.log(
      `[HighPerfRenderer] Created snapshot buffer "${exactId}" ` +
      `(${n.toLocaleString()} points, ` +
      `${(colorBufferByteLength / 1024 / 1024).toFixed(1)} MB RGB, ` +
      `${(alphaStaging.alphaTextureByteLength / 1024 / 1024).toFixed(1)} MB R8 alpha, ` +
      `${(positions.byteLength / 1024 / 1024).toFixed(1)} MB shared positions` +
      `${spatialIndex ? ', with spatial index' : ''})`
    );
    return true;
  }

  /**
   * Transactionally replace any requested snapshot RGB, R8, and geometry
   * owners while retaining unchanged publications by exact reference count.
   * @param {string} id - Snapshot identifier
   * @param {Uint8Array} colors - Exact RGBA colors.
   * @param {Float32Array|null} alphas - Exact alpha values or null.
   * @param {Float32Array} viewPositions - Exact positions owned by this view.
   * @param {number} dimensionLevel - Exact published view dimension.
   * @param {boolean} [forceGeometryPublication=false] - Treat even the same
   *   input identity as a new immutable geometry publication.
   * @returns {boolean} Success
   */
  _replaceSnapshotResources(
    id,
    colors,
    alphas,
    viewPositions,
    dimensionLevel,
    forceGeometryPublication,
    replaceColor,
    replaceAlpha
  ) {
    const exactId = requireViewId(id, 'HighPerfRenderer snapshot id');
    const exactDimensionLevel = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer snapshot dimensionLevel'
    );
    const snapshot = this.snapshotBuffers.get(exactId);
    if (!snapshot) {
      throw new Error(`HighPerfRenderer snapshot "${exactId}" does not exist.`);
    }
    if (typeof forceGeometryPublication !== 'boolean') {
      throw new TypeError(
        'HighPerfRenderer forceGeometryPublication must be a boolean.'
      );
    }
    if (
      typeof replaceColor !== 'boolean' ||
      typeof replaceAlpha !== 'boolean'
    ) {
      throw new TypeError(
        'HighPerfRenderer snapshot replacement flags must be exact booleans.'
      );
    }
    if (!replaceColor && replaceAlpha) {
      throw new Error(
        'HighPerfRenderer isolated alpha replacement must use updateSnapshotAlphas().'
      );
    }

    const gl = this.gl;
    const n = this.pointCount;
    const owner = `HighPerfRenderer snapshot "${exactId}"`;
    if (
      !(viewPositions instanceof Float32Array) ||
      viewPositions.length !== n * 3
    ) {
      throw new TypeError(
        `${owner} positions must be a Float32Array with exactly ${n * 3} values.`
      );
    }
    let snapshotRgb = null;
    let alphaData = null;
    let alphaLayout = null;
    if (replaceAlpha) {
      alphaLayout = this._getSnapshotAlphaTextureLayout(
        n,
        owner
      );
      alphaData = this._acquireSnapshotAlphaStaging(
        alphaLayout.requiredSize
      );
      try {
        snapshotRgb = this._packSnapshotRgbAndAlpha(
          colors,
          alphas,
          alphaData,
          owner
        );
      } catch (error) {
        this._donateSnapshotAlphaStaging(alphaData);
        throw error;
      }
    } else if (replaceColor) {
      snapshotRgb = this._packSnapshotRgb(
        colors,
        owner
      );
    }
    const acceptedColorOwner =
      this._ensureSnapshotColorOwner(snapshot);

    const positionsChanged =
      forceGeometryPublication ||
      viewPositions !== snapshot.positions;
    let candidateGeometry;
    try {
      candidateGeometry = positionsChanged
        ? this._acquireIndependentSnapshotGeometry(viewPositions)
        : this._acquireSnapshotGeometryFromSource(
            exactId,
            viewPositions
          );
    } catch (error) {
      this._donateSnapshotAlphaStaging(alphaData);
      throw error;
    }
    const positions = candidateGeometry.positions;
    const nextGeometryGeneration = candidateGeometry.generation;
    const dimensionChanged =
      snapshot.dimensionLevel !== exactDimensionLevel;
    const geometryChanged = positionsChanged || dimensionChanged;

    let nextBounds = snapshot.bounds;
    let nextSpatialIndex = snapshot.spatialIndex;
    let nextDimensionLevel = snapshot.dimensionLevel;
    let notification = null;
    let notificationCompleted = false;
    let candidateBuffer = null;
    let candidateBufferByteLength = 0;
    let candidateColorOwner = null;
    let candidateVao = null;
    const candidateAlpha = {
      alphaTexture: null,
      alphaTextureByteLength: 0,
    };
    const positionStaging = {
      positionBuffer: null,
      positionBufferByteLength: 0,
    };
    try {
      if (geometryChanged) {
        const needsSpatialIndex = this._needsSpatialIndex(-1);
        const hasCustomPositions =
          nextGeometryGeneration !== this._liveGeometryGeneration;
        if (positionsChanged || nextBounds === null) {
          nextBounds =
            HighPerfRenderer.computeBoundsFromPositions(positions);
        }

        if (hasCustomPositions) {
          if (needsSpatialIndex) {
            const needsLOD = this._needsLodResources(-1);
            nextSpatialIndex = this._getPooledSnapshotSpatialIndex(
              nextGeometryGeneration,
              positions,
              exactDimensionLevel,
              needsLOD
            );
            if (nextSpatialIndex === null) {
              const notifications = getNotificationCenter();
              const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
              const treeName = treeNames[exactDimensionLevel];
              const notifId = notifications.startCalculation(
                `Rebuilding ${exactDimensionLevel}D ${treeName} for view "${exactId}" (${n.toLocaleString()} cells)`,
                'spatial'
              );
              notification = {
                notifications,
                notifId,
                treeName,
                startTime: performance.now()
              };
              nextSpatialIndex = new SpatialIndex(
                positions,
                null,
                exactDimensionLevel,
                this.options.LOD_MAX_POINTS_PER_NODE,
                this.options.LOD_MAX_DEPTH,
                {
                  buildLOD: needsLOD,
                  buildLodNodeMappings: false,
                  computeNodeStats: false
                }
              );
              this._publishPooledSnapshotSpatialIndex(
                nextGeometryGeneration,
                positions,
                exactDimensionLevel,
                needsLOD,
                nextSpatialIndex
              );
            }
          } else {
            nextSpatialIndex = null;
          }
        } else {
          nextSpatialIndex = null;
        }
        nextDimensionLevel = exactDimensionLevel;
      }

      requireCleanWebGLState(
        gl,
        `HighPerfRenderer snapshot "${exactId}" publication`
      );
      const positionBuffer =
        this._ensureSnapshotGeometryPositionBuffer(
          candidateGeometry,
          `HighPerfRenderer candidate snapshot "${exactId}"`,
          positionStaging
        );
      if (replaceColor) {
        candidateBuffer = gl.createBuffer();
        if (!candidateBuffer) {
          throw new Error(
            `HighPerfRenderer could not allocate candidate snapshot "${exactId}" color resources.`
          );
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, candidateBuffer);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          snapshotRgb,
          gl.STATIC_DRAW
        );
        requireCleanWebGLState(
          gl,
          `HighPerfRenderer candidate snapshot "${exactId}" color-buffer upload`
        );
        candidateBufferByteLength = snapshotRgb.byteLength;
      } else {
        candidateBuffer = acceptedColorOwner.buffer;
        candidateBufferByteLength =
          acceptedColorOwner.byteLength;
      }
      if (replaceAlpha) {
        this._uploadNewSnapshotAlphaTexture(
          alphaData,
          alphaLayout.width,
          alphaLayout.height,
          `HighPerfRenderer candidate snapshot "${exactId}" alpha`,
          candidateAlpha
        );
      }
      candidateVao = gl.createVertexArray();
      if (!candidateVao) {
        throw new Error(
          `HighPerfRenderer could not allocate candidate snapshot "${exactId}" vertex resources.`
        );
      }
      gl.bindVertexArray(candidateVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, candidateBuffer);
      gl.enableVertexAttribArray(1);
      candidateColorOwner = replaceColor
        ? this._createSnapshotColorOwner(
            candidateBuffer,
            candidateBufferByteLength
          )
        : this._retainSnapshotColorOwner(
            acceptedColorOwner
          );
      gl.vertexAttribPointer(
        1,
        3,
        gl.UNSIGNED_BYTE,
        true,
        3,
        0
      );
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      requireCleanWebGLState(
        gl,
        `HighPerfRenderer candidate snapshot "${exactId}" publication`
      );

      if (notification !== null) {
        const elapsed = performance.now() - notification.startTime;
        settleCalculationNotification(
          notification.notifications,
          notification.notifId,
          'completeCalculation',
          `${exactDimensionLevel}D ${notification.treeName} ready (view "${exactId}")`,
          elapsed
        );
        notificationCompleted = true;
      }
    } catch (error) {
      const rollbackFailures = [];
      const rollback = operation => {
        try {
          operation();
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      };
      rollback(() => gl.bindVertexArray(null));
      rollback(() => gl.bindBuffer(gl.ARRAY_BUFFER, null));
      this._queueSnapshotRetirement({
        alphaTexture: candidateAlpha.alphaTexture,
        alphaTextureByteLength:
          candidateAlpha.alphaTextureByteLength,
        id: exactId,
        vao: candidateVao,
        buffer:
          candidateColorOwner === null && replaceColor
            ? candidateBuffer
            : null,
        bufferByteLength: candidateBufferByteLength,
        colorOwner: candidateColorOwner,
        geometryGeneration: candidateGeometry.generation,
        positionBuffer: positionStaging.positionBuffer,
        positionBufferByteLength:
          positionStaging.positionBufferByteLength,
        positions: candidateGeometry.positions,
      }, {
        releaseAlpha: replaceAlpha,
        releaseColor: true,
        releaseGeometry: true,
        releaseVao: true,
      });
      rollbackFailures.push(
        ...this._drainSnapshotRetirements(exactId)
      );
      rollback(() => gl.getError());
      if (notification !== null && !notificationCompleted) {
        settleCalculationNotification(
          notification.notifications,
          notification.notifId,
          'failCalculation',
          `${exactDimensionLevel}D ${notification.treeName} failed for view "${exactId}": ${describeError(error)}`
        );
      }
      if (rollbackFailures.length > 0) {
        this._donateSnapshotAlphaStaging(alphaData);
        throw new AggregateError(
          [error, ...rollbackFailures],
          `HighPerfRenderer snapshot "${exactId}" publication failed with ${rollbackFailures.length} rollback error(s).`
        );
      }
      this._donateSnapshotAlphaStaging(alphaData);
      throw error;
    }

    const previousRecord = {
      alphaTexture: snapshot.alphaTexture,
      alphaTextureByteLength:
        snapshot.alphaTextureByteLength,
      id: exactId,
      buffer: snapshot.buffer,
      bufferByteLength: snapshot.bufferByteLength,
      colorOwner: acceptedColorOwner,
      vao: snapshot.vao,
      geometryGeneration: snapshot.geometryGeneration,
      positions: snapshot.positions,
    };
    const previousAlphaData = snapshot.alphaTexData;
    snapshot.buffer = candidateBuffer;
    snapshot.bufferByteLength = candidateBufferByteLength;
    snapshot.colorOwner = candidateColorOwner;
    snapshot.vao = candidateVao;
    snapshot.positions = positions;
    snapshot.geometryGeneration = nextGeometryGeneration;
    if (replaceAlpha) {
      snapshot.alphaTexData = alphaData;
      snapshot.alphaTexHeight = alphaLayout.height;
      snapshot.alphaTexWidth = alphaLayout.width;
      snapshot.alphaTexture = candidateAlpha.alphaTexture;
      snapshot.alphaTextureByteLength =
        candidateAlpha.alphaTextureByteLength;
    }
    snapshot.bounds = nextBounds;
    snapshot.spatialIndex = nextSpatialIndex;
    snapshot.dimensionLevel = nextDimensionLevel;
    this._retireSnapshotRecord(
      previousRecord,
      {
        releaseAlpha: replaceAlpha,
        releaseColor: true,
        releaseGeometry: true,
        releaseVao: true,
      }
    );
    if (replaceAlpha) {
      this._donateSnapshotAlphaStaging(previousAlphaData);
    }

    if (geometryChanged) {
      this.invalidateViewState(exactId);
    }
    if (notification !== null) {
      console.log(
        `[HighPerfRenderer] Rebuilt ${exactDimensionLevel}D spatial index for snapshot "${exactId}"`
      );
    }
    return true;
  }

  updateSnapshotBuffer(
    id,
    colors,
    alphas,
    viewPositions,
    dimensionLevel,
    forceGeometryPublication = false
  ) {
    this._assertOperational('update a snapshot buffer');
    return this._replaceSnapshotResources(
      id,
      colors,
      alphas,
      viewPositions,
      dimensionLevel,
      forceGeometryPublication,
      true,
      true
    );
  }

  /**
   * Replace only one snapshot's RGB publication. RGBA alpha is deliberately
   * ignored because the accepted R8 texture is an independent owner.
   */
  updateSnapshotColors(id, colors) {
    this._assertOperational('update snapshot colors');
    const exactId = requireViewId(
      id,
      'HighPerfRenderer snapshot id'
    );
    const snapshot = this.snapshotBuffers.get(exactId);
    if (!snapshot) {
      throw new Error(
        `HighPerfRenderer snapshot "${exactId}" does not exist.`
      );
    }
    return this._replaceSnapshotResources(
      exactId,
      colors,
      null,
      snapshot.positions,
      snapshot.dimensionLevel,
      false,
      true,
      false
    );
  }

  /**
   * Replace only one snapshot's source-order R8 alpha publication. The
   * accepted CPU bytes remain authoritative across failed GPU writes.
   */
  updateSnapshotAlphas(id, alphas) {
    this._assertOperational('update snapshot alpha values');
    const exactId = requireViewId(
      id,
      'HighPerfRenderer snapshot id'
    );
    const snapshot = this.snapshotBuffers.get(exactId);
    if (!snapshot) {
      throw new Error(
        `HighPerfRenderer snapshot "${exactId}" does not exist.`
      );
    }
    const owner =
      `HighPerfRenderer snapshot "${exactId}" alpha update`;
    requireSnapshotAlphas(this.pointCount, alphas, owner);
    // Creation capability-validates and publishes these exact dimensions.
    // Reuse that accepted layout so frequent filter/slider updates never
    // introduce a synchronous driver capability query.
    const width = snapshot.alphaTexWidth;
    const height = snapshot.alphaTexHeight;
    const requiredSize = width * height;
    const layout = { height, requiredSize, width };
    if (
      snapshot.pointCount !== this.pointCount ||
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      width > this.pointCount ||
      !Number.isSafeInteger(height) ||
      height !== Math.ceil(this.pointCount / width) ||
      !Number.isSafeInteger(requiredSize) ||
      !(snapshot.alphaTexData instanceof Uint8Array) ||
      snapshot.alphaTexData.length !== requiredSize ||
      (
        snapshot.alphaTexture === null
          ? snapshot.alphaTextureByteLength !== 0
          : (
            !snapshot.alphaTexture ||
            snapshot.alphaTextureByteLength !==
              requiredSize
          )
      )
    ) {
      throw new Error(
        `${owner} found inconsistent accepted R8 ownership.`
      );
    }

    const accepted = snapshot.alphaTexData;
    const candidate = this._acquireSnapshotAlphaStaging(
      layout.requiredSize
    );
    let changed;
    try {
      changed = this._encodeSnapshotAlphaData(
        candidate,
        null,
        alphas,
        owner,
        accepted
      );
    } catch (error) {
      this._donateSnapshotAlphaStaging(candidate);
      throw error;
    }

    if (snapshot.alphaTexture === null) {
      const recovery = {
        alphaTexture: null,
        alphaTextureByteLength: 0,
      };
      try {
        this._uploadNewSnapshotAlphaTexture(
          accepted,
          layout.width,
          layout.height,
          `${owner} recovery`,
          recovery
        );
      } catch (error) {
        this._queueSnapshotRetirement({
          alphaTexture: recovery.alphaTexture,
          alphaTextureByteLength:
            recovery.alphaTextureByteLength,
          id: exactId,
        }, {
          releaseAlpha: true,
          releaseColor: false,
          releaseGeometry: false,
          releaseVao: false,
        });
        const failures =
          this._drainSnapshotRetirements(exactId);
        this._donateSnapshotAlphaStaging(candidate);
        if (failures.length > 0) {
          throw new AggregateError(
            [error, ...failures],
            `${owner} recovery failed with ${failures.length} retirement error(s).`
          );
        }
        throw error;
      }
      snapshot.alphaTexture = recovery.alphaTexture;
      snapshot.alphaTextureByteLength =
        recovery.alphaTextureByteLength;
      this._refreshGpuMemoryStats();
      // A detached poisoned texture from the prior failed generation is
      // independent of this accepted recovery. Retry its retirement without
      // making cleanup authoritative over the restored pane.
      this._drainSnapshotRetirements(exactId);
    }

    if (!changed) {
      this._donateSnapshotAlphaStaging(candidate);
      return true;
    }

    try {
      this._uploadSnapshotAlphaTextureData(
        snapshot,
        candidate,
        `${owner} publication`
      );
    } catch (publicationError) {
      try {
        this._uploadSnapshotAlphaTextureData(
          snapshot,
          accepted,
          `${owner} restoration`
        );
      } catch (restorationError) {
        const poisonedTexture = snapshot.alphaTexture;
        const poisonedTextureByteLength =
          snapshot.alphaTextureByteLength;
        snapshot.alphaTexture = null;
        snapshot.alphaTextureByteLength = 0;
        this._queueSnapshotRetirement({
          alphaTexture: poisonedTexture,
          alphaTextureByteLength:
            poisonedTextureByteLength,
          id: exactId,
        }, {
          releaseAlpha: true,
          releaseColor: false,
          releaseGeometry: false,
          releaseVao: false,
        });
        const retirementFailures =
          this._drainSnapshotRetirements(exactId);
        this._donateSnapshotAlphaStaging(candidate);
        throw new AggregateError(
          [
            publicationError,
            restorationError,
            ...retirementFailures,
          ],
          `${owner} failed and its accepted GPU bytes could not be restored.`
        );
      }
      this._donateSnapshotAlphaStaging(candidate);
      throw publicationError;
    }

    snapshot.alphaTexData = candidate;
    this._donateSnapshotAlphaStaging(accepted);
    return true;
  }

  /**
   * Update only the positions for a snapshot buffer (for dimension switching).
   * The existing RGB VBO and R8 texture remain independent accepted owners.
   * @param {string} id - Snapshot identifier
   * @param {Float32Array} viewPositions - New positions for the view
   * @param {number} dimensionLevel - Exact published view dimension.
   * @returns {boolean} Success
   */
  updateSnapshotPositions(id, viewPositions, dimensionLevel) {
    this._assertOperational('update snapshot positions');
    const exactId = requireViewId(id, 'HighPerfRenderer snapshot id');
    const exactDimensionLevel = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer snapshot dimensionLevel'
    );
    const snapshot = this.snapshotBuffers.get(exactId);
    if (!snapshot) {
      throw new Error(`HighPerfRenderer snapshot "${exactId}" does not exist.`);
    }

    if (
      !(viewPositions instanceof Float32Array) ||
      viewPositions.length !== this.pointCount * 3
    ) {
      throw new TypeError(
        `HighPerfRenderer snapshot "${exactId}" positions must contain exactly ${this.pointCount * 3} Float32 values.`
      );
    }

    this._replaceSnapshotResources(
      exactId,
      null,
      null,
      viewPositions,
      exactDimensionLevel,
      true,
      false,
      false
    );
    console.log(`[HighPerfRenderer] Updated positions for snapshot "${exactId}"`);
    return true;
  }

  /**
   * Delete a snapshot's GPU resources.
   * @param {string} id - Snapshot identifier
   */
  deleteSnapshotBuffer(id) {
    this._assertOperational('delete a snapshot buffer');
    const exactId = requireViewId(
      id,
      'HighPerfRenderer snapshot id'
    );
    const snapshot = this.snapshotBuffers.get(exactId);
    if (snapshot) {
      // Detach inventory before fallible cleanup. The pending record remains
      // the exact owner of every handle/geometry release that has not yet
      // completed.
      this.snapshotBuffers.delete(exactId);
      this._donateSnapshotAlphaStaging(
        snapshot.alphaTexData
      );
      this._releaseSnapshotScratchIfUnused();
      this._queueSnapshotRetirement(snapshot, {
        releaseAlpha: true,
        releaseColor: true,
        releaseGeometry: true,
        releaseVao: true,
      });
    }
    const retirementFailures =
      this._drainSnapshotRetirements(exactId);
    if (retirementFailures.length > 0) {
      throw new AggregateError(
        retirementFailures,
        `HighPerfRenderer snapshot "${exactId}" is detached but resource retirement remains pending.`
      );
    }
    if (!snapshot) return;
    console.log(`[HighPerfRenderer] Deleted snapshot buffer "${exactId}"`);
  }

  /**
   * Delete all snapshot buffers. Call when clearing all snapshots.
   */
  deleteAllSnapshotBuffers() {
    this._assertOperational('delete all snapshot buffers');
    const snapshots = Array.from(this.snapshotBuffers.values());
    this.snapshotBuffers.clear();
    this._releaseSnapshotScratchIfUnused();
    for (const snapshot of snapshots) {
      this._queueSnapshotRetirement(snapshot, {
        releaseAlpha: true,
        releaseColor: true,
        releaseGeometry: true,
        releaseVao: true,
      });
    }
    const failures = this._drainSnapshotRetirements();
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `HighPerfRenderer detached all snapshots with ${failures.length} pending retirement failure(s).`
      );
    }
  }

  /**
   * Check if a snapshot buffer exists.
   * @param {string} id - Snapshot identifier
   * @returns {boolean}
   */
  hasSnapshotBuffer(id) {
    return this.snapshotBuffers.has(id);
  }

  /**
   * Return the renderer-owned immutable CPU positions for a snapshot.
   * Consumers must treat this reference as read-only.
   * @param {string} id - Snapshot identifier.
   * @returns {Float32Array}
   */
  getSnapshotPositions(id) {
    const exactId = requireViewId(
      id,
      'HighPerfRenderer snapshot id'
    );
    const snapshot = this.snapshotBuffers.get(exactId);
    if (!snapshot || !(snapshot.positions instanceof Float32Array)) {
      throw new RangeError(
        `HighPerfRenderer snapshot "${exactId}" does not exist.`
      );
    }
    return snapshot.positions;
  }

  /**
   * Get a snapshot's spatial index for picking/queries.
   * Returns a stable read-only projection of the exact main or snapshot
   * spatial owner when already available.
   * @param {string} id - Snapshot identifier
   * @param {number} dimensionLevel - Exact published view dimension.
   * @returns {SpatialIndex|null}
   */
  getSnapshotSpatialIndex(id, dimensionLevel) {
    this._assertOperational('get a snapshot spatial index');
    const exactId = requireViewId(
      id,
      'HighPerfRenderer snapshot id'
    );
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer snapshot spatial-index dimensionLevel'
    );
    const snapshot = this.snapshotBuffers.get(exactId);
    if (!snapshot) return null;
    if (snapshot.dimensionLevel !== dim) {
      throw new Error(
        `HighPerfRenderer snapshot "${exactId}" owns ${snapshot.dimensionLevel}D data but received a ${dim}D spatial-index request.`
      );
    }
    const spatialIndex =
      this._getSpatialIndexForViewGeneration(exactId, dim);
    return spatialIndex === null
      ? null
      : getReadOnlySpatialProjection(
        spatialIndex,
        `HighPerfRenderer snapshot "${exactId}" ${dim}D spatial index`
      );
  }

  /**
   * Publish dimension metadata for immutable snapshot geometry without
   * re-uploading its unchanged GPU point buffer.
   * @param {string} id - Snapshot identifier.
   * @param {number} dimensionLevel - Exact published view dimension.
   * @returns {boolean}
   */
  setSnapshotDimensionLevel(id, dimensionLevel) {
    this._assertOperational('set a snapshot dimension');
    const exactId = requireViewId(
      id,
      'HighPerfRenderer snapshot id'
    );
    const exactDimensionLevel = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer snapshot dimensionLevel'
    );
    const snapshot = this.snapshotBuffers.get(exactId);
    if (!snapshot) {
      throw new Error(
        `HighPerfRenderer snapshot "${exactId}" does not exist.`
      );
    }
    if (snapshot.dimensionLevel === exactDimensionLevel) {
      return true;
    }

    if (
      !this._snapshotUsesLiveGeometry(snapshot) &&
      this._needsSpatialIndex(-1)
    ) {
      // The builder publishes only after its exact spatial owner completes.
      // Terminal UI delivery is observational and cannot invalidate it.
      this.rebuildSnapshotSpatialIndex(
        exactId,
        exactDimensionLevel
      );
    } else {
      snapshot.spatialIndex = null;
      snapshot.dimensionLevel = exactDimensionLevel;
    }

    this.invalidateViewState(exactId);
    return true;
  }

  /**
   * Rebuild a snapshot's spatial index for a new dimension level.
   * Call this when changing a view's dimension to ensure LOD/frustum culling works correctly.
   * @param {string} id - Snapshot identifier
   * @param {number} dimensionLevel - New dimension level (1, 2, or 3)
   * @param {boolean} [needsLOD] - Whether the exact tree must own LOD prefixes.
   * @returns {boolean} Success
   */
  rebuildSnapshotSpatialIndex(
    id,
    dimensionLevel,
    needsLOD = this._needsLodResources(-1)
  ) {
    this._assertOperational('rebuild a snapshot spatial index');
    const exactId = requireViewId(id, 'HighPerfRenderer snapshot id');
    const exactDimensionLevel = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer snapshot dimensionLevel'
    );
    if (typeof needsLOD !== 'boolean') {
      throw new TypeError(
        'HighPerfRenderer snapshot spatial-index needsLOD must be a boolean.'
      );
    }
    const snapshot = this.snapshotBuffers.get(exactId);
    if (!snapshot) {
      throw new Error(`HighPerfRenderer snapshot "${exactId}" does not exist.`);
    }

    // A matching geometry generation uses the dimension-specific main index.
    // Snapshot CPU arrays are immutable copies, so reference equality is never
    // an ownership signal.
    if (this._snapshotUsesLiveGeometry(snapshot)) {
      // Clear any existing spatial index since it should use main index
      snapshot.spatialIndex = null;
      snapshot.dimensionLevel = exactDimensionLevel;
      return true;
    }

    // If we already have a valid spatial index for this positions array and dimension, don't rebuild.
    // This prevents duplicate quadtree builds when a dimension change updates positions first and then
    // calls rebuildSnapshotSpatialIndex() (common in multiview switching flows).
    if (snapshot.spatialIndex &&
        snapshot.spatialIndex.positions === snapshot.positions &&
        snapshot.dimensionLevel === exactDimensionLevel) {
      if (
        !needsLOD ||
        (
          Array.isArray(snapshot.spatialIndex.lodLevels) &&
          snapshot.spatialIndex.lodLevels.length > 0
        )
      ) {
        const pooled = this._getPooledSnapshotSpatialIndex(
          snapshot.geometryGeneration,
          snapshot.positions,
          exactDimensionLevel,
          needsLOD
        );
        if (pooled === null) {
          this._publishPooledSnapshotSpatialIndex(
            snapshot.geometryGeneration,
            snapshot.positions,
            exactDimensionLevel,
            needsLOD,
            snapshot.spatialIndex
          );
        } else {
          snapshot.spatialIndex = pooled;
        }
        return true;
      }
    }

    let candidateSpatialIndex = this._getPooledSnapshotSpatialIndex(
      snapshot.geometryGeneration,
      snapshot.positions,
      exactDimensionLevel,
      needsLOD
    );
    if (candidateSpatialIndex === null) {
      console.log(`[HighPerfRenderer] Rebuilding ${exactDimensionLevel}D spatial index for snapshot "${exactId}"...`);

      const notifications = getNotificationCenter();
      const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
      const treeName = treeNames[exactDimensionLevel];
      const cellCount = snapshot.pointCount;
      const notifId = notifications.startCalculation(
        `Rebuilding ${exactDimensionLevel}D ${treeName} for view "${exactId}" (${cellCount.toLocaleString()} cells)`,
        'spatial'
      );
      const startTime = performance.now();

      try {
        candidateSpatialIndex = new SpatialIndex(
          snapshot.positions,
          null,
          exactDimensionLevel,
          this.options.LOD_MAX_POINTS_PER_NODE,
          this.options.LOD_MAX_DEPTH,
          {
            buildLOD: needsLOD,
            buildLodNodeMappings: false,
            computeNodeStats: false
          }
        );
        this._publishPooledSnapshotSpatialIndex(
          snapshot.geometryGeneration,
          snapshot.positions,
          exactDimensionLevel,
          needsLOD,
          candidateSpatialIndex
        );
        const elapsed = performance.now() - startTime;
        settleCalculationNotification(
          notifications,
          notifId,
          'completeCalculation',
          `${exactDimensionLevel}D ${treeName} ready (view "${exactId}")`,
          elapsed
        );
      } catch (error) {
        settleCalculationNotification(
          notifications,
          notifId,
          'failCalculation',
          `${exactDimensionLevel}D ${treeName} failed for view "${exactId}": ${describeError(error)}`
        );
        throw error;
      }
    }
    snapshot.spatialIndex = candidateSpatialIndex;
    snapshot.dimensionLevel = exactDimensionLevel;
    this.invalidateViewState(exactId);
    console.log(`[HighPerfRenderer] Built ${exactDimensionLevel}D spatial index${needsLOD ? ` with ${candidateSpatialIndex.lodLevels.length} LOD levels` : ''}`);
    return true;
  }

  /**
   * Render using a snapshot's pre-uploaded buffer. No data upload occurs.
   * Supports frustum culling and LOD for all views (not just the live view).
   * @param {string} id - Snapshot identifier
   * @param {Object} params - Render parameters (same as render())
   * @param {boolean} [params.useAlphaTexture=false] - If true, explicitly use
   *   the current live alpha publication instead of this snapshot's R8 owner.
   * @param {boolean} [returnStats=true] - Whether to allocate and return a
   *   detached statistics record.
   * @returns {Object|undefined} Stats when requested.
  */
  renderWithSnapshot(id, params, returnStats = true) {
    this._assertOperational('render a snapshot');
    if (typeof returnStats !== 'boolean') {
      throw new TypeError(
        'HighPerfRenderer snapshot render returnStats must be a boolean.'
      );
    }
    const exactId = requireViewId(id, 'HighPerfRenderer snapshot id');
    const exactParams = requireRenderContract(params, exactId);
    if (exactParams.viewId !== exactId) {
      throw new Error(
        `HighPerfRenderer snapshot id "${exactId}" must match render viewId "${exactParams.viewId}".`
      );
    }
    const snapshot = this.snapshotBuffers.get(exactId);
    if (!snapshot) {
      throw new Error(`HighPerfRenderer snapshot "${exactId}" does not exist.`);
    }

    const gl = this.gl;
    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity,
      fogColor, lightDir,
      cameraPosition, cameraDistance,
      forceLOD,
      quality,
      viewId,
      dimensionLevel,
      useAlphaTexture,
      autoFog
    } = exactParams;

    const frameStart = performance.now();
    configureStraightAlphaBlending(gl);

    // Get per-view state for frustum culling and LOD caching
    const viewState = this._getViewState(viewId);

    // Geometry-generation equality proves whether the main spatial/LOD
    // resources index this snapshot. Snapshot arrays are immutable copies and
    // therefore intentionally never share the live array identity.
    const hasCustomPositions =
      !this._snapshotUsesLiveGeometry(snapshot);

    const needsSpatialIndex = this._needsSpatialIndex(forceLOD);
    const needsLOD = this._needsLodResources(forceLOD);
    if (useAlphaTexture && !this.isAlphaTextureActive()) {
      throw new Error(
        `HighPerfRenderer snapshot "${exactId}" requested the alpha texture before exact alpha state was published.`
      );
    }
    if (
      !useAlphaTexture &&
      !this.isAlphaTextureActiveForView(exactId)
    ) {
      throw new Error(
        `HighPerfRenderer snapshot "${exactId}" has no accepted R8 alpha texture.`
      );
    }

    // Ensure bounds for custom-position snapshots (fog + LOD/frustum calculations).
    if (snapshot.dimensionLevel !== dimensionLevel) {
      throw new Error(
        `HighPerfRenderer snapshot "${exactId}" owns ${snapshot.dimensionLevel}D data but received a ${dimensionLevel}D render contract.`
      );
    }
    if (hasCustomPositions && !snapshot.bounds) {
      throw new Error(
        `HighPerfRenderer snapshot "${exactId}" is missing its exact position bounds.`
      );
    }

    if (hasCustomPositions && needsSpatialIndex) {
      const indexStale =
        !snapshot.spatialIndex ||
        snapshot.spatialIndex.positions !== snapshot.positions ||
        snapshot.spatialIndex.dimensionLevel !== dimensionLevel;

      const lodMissing =
        needsLOD &&
        (
          !Array.isArray(snapshot.spatialIndex?.lodLevels) ||
          snapshot.spatialIndex.lodLevels.length === 0
        );
      if (indexStale || lodMissing) {
        this.rebuildSnapshotSpatialIndex(
          exactId,
          dimensionLevel,
          needsLOD
        );
      }
    }

    const effectiveDimLevel = dimensionLevel;
    const effectiveParams = exactParams;

    // Auto-compute fog range using snapshot bounds when available (for correct fog in custom dimension views)
    if (autoFog) {
      this.autoComputeFogRange(cameraPosition, hasCustomPositions ? snapshot.bounds : null);
    }

    // Set quality if changed
    if (quality !== this.activeQuality) {
      this.setQuality(quality);
    }

    // Get the correct spatial index for this view's dimension level (for non-custom positions)
    // Custom positions use snapshot.spatialIndex instead
    const mainSpatialIndex = (!hasCustomPositions && needsSpatialIndex)
      ? this._getOrBuildSpatialIndexForDimension(
        effectiveDimLevel,
        false,
        needsLOD
      )
      : null;

    // For adaptive LOD, use snapshot's spatial index for custom positions (if available)
    // This enables LOD for 1D/2D views that have their own spatial index built from custom positions
    const lodSpatialIndex = hasCustomPositions ? snapshot.spatialIndex : mainSpatialIndex;
    const lodBuffersForDim =
      this._getLodBuffersForDimension(effectiveDimLevel);

    // Select LOD level based on whether LOD is enabled (consistent with render())
    // When LOD is disabled, forceLODLevel is ignored - only params.forceLOD is respected
    // This ensures disabling LOD always returns to full detail (unless explicitly overridden per-render)
    let lodLevel;
    if (this.useAdaptiveLOD) {
      // LOD enabled: Priority is this.forceLODLevel > params.forceLOD > adaptive
      lodLevel = this.forceLODLevel >= 0 ? this.forceLODLevel : forceLOD;
      if (lodLevel < 0 && lodSpatialIndex) {
        // Pass effectiveDimLevel for correct 2D/3D diagonal calculation (uses snapshot's stored dimension for custom positions)
        // Pass snapshot bounds when available (for custom positions that differ from octree)
        lodLevel = lodSpatialIndex.getLODLevel(cameraDistance, viewportHeight, viewState.lastLodLevel, effectiveDimLevel, snapshot.bounds);
      }
    } else {
      // LOD disabled: only respect explicit per-render forceLOD, otherwise full detail
      lodLevel = forceLOD >= 0 ? forceLOD : -1;
    }

    // Always update per-view LOD level for highlight rendering and other consumers
    // NOTE: lastDimensionLevel is NOT set here - it's handled inside _checkFrustumCacheValid
    // to properly detect dimension changes and invalidate the frustum cache
    viewState.lastLodLevel = lodLevel;

    if (!Number.isInteger(lodLevel) || lodLevel < -1) {
      throw new Error(
        `HighPerfRenderer selected an invalid LOD level for snapshot "${exactId}".`
      );
    }
    const selectedSpatialLevel = lodLevel >= 0
      ? lodSpatialIndex?.lodLevels?.[lodLevel]
      : null;
    if (lodLevel >= 0 && !selectedSpatialLevel) {
      throw new RangeError(
        `HighPerfRenderer snapshot "${exactId}" has no LOD level ${lodLevel} for ${effectiveDimLevel}D.`
      );
    }
    let sizeMultiplier = 1.0;
    if (lodLevel >= 0 && selectedSpatialLevel.isFullDetail !== true) {
      sizeMultiplier = selectedSpatialLevel.sizeMultiplier;
      if (!Number.isFinite(sizeMultiplier)) {
        throw new TypeError(
          `HighPerfRenderer snapshot "${exactId}" LOD sizeMultiplier must be a finite number; received ${String(sizeMultiplier)}.`
        );
      }
    }

    // Debug LOD selection for snapshots - only log when level changes (per-view)
    if (viewState.prevLodLevel !== lodLevel && lodSpatialIndex && (this.useAdaptiveLOD || this.forceLODLevel >= 0)) {
      const pointCount = lodLevel < 0
        ? snapshot.pointCount
        : selectedSpatialLevel.pointCount;
      const mode = this.forceLODLevel >= 0 ? 'forced' : 'auto';
      if (DEBUG_LOD_FRUSTUM) console.log(`[LOD] Snapshot ${viewId}: level ${viewState.prevLodLevel ?? 'init'} → ${lodLevel} (${pointCount.toLocaleString()} pts, ${mode}, dim=${effectiveDimLevel})`);
      viewState.prevLodLevel = lodLevel;
    }

    // Determine if we should use full detail or LOD
    // Check both global LOD buffers AND the spatial index's LOD levels
    // This allows snapshots with custom positions (and their own spatial index) to use LOD
    // even if no global LOD buffers exist for that dimension
    const useFullDetail =
      lodLevel < 0 ||
      selectedSpatialLevel.isFullDetail === true;

    // Frustum culling for snapshots:
    // - When positions match main buffer: use main octree for culling
    // - When positions are custom (2D/1D views): use snapshot's spatial index (quadtree/binary tree)
    if (this.useFrustumCulling) {
      // Determine which spatial index to use
      // and validate it before publishing a new frustum cache key.
      const spatialIndex = hasCustomPositions
        ? (
        // Use snapshot's spatial index only if it exists and was built from current positions
            snapshot.spatialIndex &&
            snapshot.spatialIndex.positions === snapshot.positions
              ? snapshot.spatialIndex
              : null
          )
        : (
        // Use the dimension-appropriate spatial index (quadtree for 2D, octree for 3D)
            mainSpatialIndex
          );

      if (!spatialIndex) {
        throw new Error(
          `HighPerfRenderer snapshot "${exactId}" is missing the required ${effectiveDimLevel}D spatial index for frustum culling.`
        );
      }

      // For 2D data (effectiveDimLevel <= DEPTH_TEST_DIMENSION_THRESHOLD), disable depth testing entirely
      // to prevent draw-order artifacts. When all points have the same Z, depth testing causes visual
      // differences at quadtree boundaries because frustum culling changes the draw order.
      const disableDepth = effectiveDimLevel <= DEPTH_TEST_DIMENSION_THRESHOLD;
      let frustumChanged = false;
      let operationError = null;
      try {
        // Pass snapshot bounds for correct frustum margin calculation in
        // 2D/1D views. Cache publication and all downstream work are atomic.
        const boundsForFrustum =
          hasCustomPositions ? snapshot.bounds : null;
        frustumChanged = this._prepareFrustumCache(
          mvpMatrix,
          viewState,
          effectiveDimLevel,
          boundsForFrustum
        );
        const frustumPlanes = viewState.frustumPlanes;
        if (disableDepth) {
          gl.disable(gl.DEPTH_TEST);
        }

        if (useFullDetail) {
          this._renderSnapshotWithFrustumCulling(
            snapshot,
            effectiveParams,
            frustumPlanes,
            viewState,
            sizeMultiplier,
            useAlphaTexture,
            spatialIndex,
            frustumChanged
          );
        } else {
          this._renderSnapshotLODWithFrustumCulling(
            snapshot,
            lodLevel,
            effectiveParams,
            frustumPlanes,
            viewState,
            useAlphaTexture,
            spatialIndex,
            lodBuffersForDim,
            frustumChanged
          );
        }
      } catch (error) {
        operationError = error;
        if (frustumChanged) {
          this._invalidateViewStateRecord(viewState);
        }
      }

      let restorationError = null;
      try {
        if (disableDepth) {
          gl.enable(gl.DEPTH_TEST);
        }
      } catch (error) {
        restorationError = error;
      }
      if (operationError !== null) {
        if (restorationError !== null) {
          throw new AggregateError(
            [operationError, restorationError],
            'HighPerfRenderer snapshot frustum render and depth-state restoration both failed.'
          );
        }
        throw operationError;
      }
      if (restorationError !== null) {
        throw restorationError;
      }
      this._publishFrameTiming(viewState, frameStart);
      return returnStats ? this.getStats(viewId) : undefined;
    }

    // For 2D data (effectiveDimLevel <= 2), disable depth testing to prevent draw-order artifacts
    // This is consistent with the frustum culling path and the main render() function
    const disableDepth = effectiveDimLevel <= DEPTH_TEST_DIMENSION_THRESHOLD;

    // No frustum culling - check if we should use LOD
    if (!useFullDetail) {
      let operationError = null;
      try {
        if (disableDepth) {
          gl.disable(gl.DEPTH_TEST);
        }
        // Render with LOD using indexed drawing into snapshot buffer
        // Use lodSpatialIndex for custom positions (snapshot.spatialIndex) or main spatial index
        // Pass effectiveParams to ensure correct dimensionLevel is used
        this._renderSnapshotWithLOD(snapshot, lodLevel, effectiveParams, viewState, useAlphaTexture, lodSpatialIndex, lodBuffersForDim);
      } catch (error) {
        operationError = error;
      }
      let restorationError = null;
      try {
        if (disableDepth) {
          gl.enable(gl.DEPTH_TEST);
        }
      } catch (error) {
        restorationError = error;
      }
      settlePointDraw(
        operationError,
        restorationError,
        'HighPerfRenderer snapshot LOD render'
      );

      this._publishFrameTiming(viewState, frameStart);
      return returnStats ? this.getStats(viewId) : undefined;
    }

    let operationError = null;
    let renderResult;
    try {
      if (disableDepth) {
        gl.disable(gl.DEPTH_TEST);
      }
      // No frustum culling - render all points with snapshot VAO
      const program = this.activeProgram;
      const uniforms = this.uniformLocations.get(this.activeQuality);

      if (!program || !uniforms) {
        throw new Error(
          `HighPerfRenderer "${this.activeQuality}" snapshot shader state is unavailable.`
        );
      }

      gl.useProgram(program);

      // Set uniforms
      const adjustedPointSize = pointSize * sizeMultiplier;
      if (uniforms.u_mvpMatrix !== null) gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
      if (uniforms.u_viewMatrix !== null) gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
      if (uniforms.u_modelMatrix !== null) gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
      if (uniforms.u_projectionMatrix !== null && projectionMatrix) gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
      if (uniforms.u_pointSize !== null) gl.uniform1f(uniforms.u_pointSize, adjustedPointSize);
      if (uniforms.u_sizeAttenuation !== null) gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
      if (uniforms.u_viewportHeight !== null) gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
      if (uniforms.u_fov !== null) gl.uniform1f(uniforms.u_fov, fov);
      if (uniforms.u_lightingStrength !== null) gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
      if (uniforms.u_fogDensity !== null) gl.uniform1f(uniforms.u_fogDensity, fogDensity);
      if (uniforms.u_fogNear !== null) gl.uniform1f(uniforms.u_fogNear, this.fogNear);
      if (uniforms.u_fogFar !== null) gl.uniform1f(uniforms.u_fogFar, this.fogFar);
      if (uniforms.u_fogColor !== null) gl.uniform3fv(uniforms.u_fogColor, fogColor);
      if (uniforms.u_lightDir !== null) gl.uniform3fv(uniforms.u_lightDir, lightDir);

      this._bindSnapshotAlphaTexture(
        gl,
        uniforms,
        snapshot,
        useAlphaTexture,
        effectiveDimLevel
      );

      // Reset frustum culling stats
      this.stats.frustumCulled = false;
      this.stats.cullPercent = 0;

      // Bind snapshot's VAO (no data upload!)
      gl.bindVertexArray(snapshot.vao);
      gl.drawArrays(gl.POINTS, 0, snapshot.pointCount);

      // Publish the exact dimension used by non-frustum LOD consumers.
      // This is done after rendering to ensure accurate per-view tracking without breaking cache invalidation
      viewState.lastDimensionLevel = effectiveDimLevel;

      this._writeStats(
        viewState,
        snapshot.pointCount,
        lodLevel,
        1,
        false,
        0
      );
      this._publishFrameTiming(viewState, frameStart);

      renderResult =
        returnStats ? this.getStats(viewId) : undefined;
    } catch (error) {
      operationError = error;
    }
    let cleanupFailures = null;
    try {
      restorePointDrawBaseline(gl, false);
    } catch (error) {
      cleanupFailures = [error];
    }
    try {
      if (disableDepth) {
        gl.enable(gl.DEPTH_TEST);
      }
    } catch (error) {
      if (cleanupFailures === null) cleanupFailures = [error];
      else cleanupFailures.push(error);
    }
    const restorationError = cleanupFailures === null
      ? null
      : (
          cleanupFailures.length === 1
            ? cleanupFailures[0]
            : new AggregateError(
                cleanupFailures,
                'HighPerfRenderer snapshot direct-draw restoration failed.'
              )
        );
    settlePointDraw(
      operationError,
      restorationError,
      'HighPerfRenderer snapshot direct draw'
    );
    return renderResult;
  }

  /**
   * Render snapshot with frustum culling using indexed drawing.
   * The caller supplies the spatial index for the snapshot's exact geometry
   * generation. Uses a per-view index buffer to avoid cross-view conflicts.
   * @param {boolean} [useAlphaTexture=false] - If true, use the live alpha texture as an explicit override.
   * @param {SpatialIndex} [spatialIndex] - Spatial index to use (snapshot's own or main octree)
   * @private
   */
  _renderSnapshotWithFrustumCulling(
    snapshot,
    params,
    frustumPlanes,
    viewState,
    sizeMultiplier,
    useAlphaTexture,
    spatialIndex,
    frustumChanged
  ) {
    const gl = this.gl;
    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir,
      viewId,
      dimensionLevel
    } = params;

    const tree = spatialIndex;
    if (!tree) {
      throw new Error(
        `HighPerfRenderer snapshot "${viewId}" frustum render requires an exact spatial index.`
      );
    }

    const spatialOwnerChanged =
      viewState.cachedVisibleSpatialOwner !== tree ||
      viewState.cachedVisibleSpatialRoot !== tree.root ||
      !Array.isArray(viewState.cachedVisibleNodes);
    const fullDetailCacheChanged =
      viewState.cachedLodIsCulled === true ||
      viewState.cachedLodLevel !== -1 ||
      viewState.cachedLodDimension !== dimensionLevel ||
      viewState.cachedLodMappingGeneration !== null ||
      !(viewState.cachedVisibleIndices instanceof Uint32Array) ||
      viewState.cachedCulledCount !==
        viewState.cachedVisibleIndices?.length ||
      (
        viewState.cachedCulledCount > 0 &&
        viewState.indexBufferSize !== viewState.cachedCulledCount
      );
    let visibleNodes = null;
    let orderedAdmissionChanged = false;

    if (
      frustumChanged ||
      spatialOwnerChanged ||
      fullDetailCacheChanged
    ) {
      const candidate = this._collectVisibleNodeCandidate(
        viewState,
        tree.root,
        frustumPlanes
      );
      const canReuseAcceptedEbo =
        frustumChanged &&
        !spatialOwnerChanged &&
        !fullDetailCacheChanged &&
        this._hasSameOrderedVisibleNodes(
          viewState.cachedVisibleNodes,
          candidate
        );
      if (canReuseAcceptedEbo) {
        this._recycleVisibleNodeCandidate(viewState, candidate);
      } else {
        visibleNodes = candidate;
        orderedAdmissionChanged = true;
      }
    }

    const needsUpdate =
      spatialOwnerChanged ||
      fullDetailCacheChanged ||
      orderedAdmissionChanged;

    if (needsUpdate) {
      try {
        if (!Array.isArray(visibleNodes)) {
          throw new Error(
            `HighPerfRenderer snapshot "${viewId}" frustum leaf admission is unavailable.`
          );
        }
        if (visibleNodes.length === 0) {
          const emptyIndices =
            viewState.cachedVisibleIndices instanceof Uint32Array &&
            viewState.cachedVisibleIndices.length === 0
              ? viewState.cachedVisibleIndices
              : new Uint32Array(0);
          this._acceptVisibleNodeCandidate(viewState, visibleNodes);
          viewState.cachedVisibleSpatialOwner = tree;
          viewState.cachedVisibleSpatialRoot = tree.root;
          viewState.cachedCulledCount = 0;
          viewState.cachedVisibleIndices = emptyIndices;
          viewState.cachedLodVisibleIndices = null;
          viewState.cachedLodLevel = -1;
          viewState.cachedLodDimension = dimensionLevel;
          viewState.cachedLodIsCulled = false;
          viewState.cachedLodMappingGeneration = null;
          viewState._noVisibleNodesWarned = false;
          this._writeStats(viewState, 0, -1, 0, true, 100);
          return;
        }

        // Count total visible points
        let totalVisible = 0;
        for (const node of visibleNodes) {
          if (node.indices) totalVisible += node.indices.length;
        }

        this._ensureVisibleIndexScratch(
          viewState,
          totalVisible,
          false
        );

        let writeOffset = 0;
        for (const node of visibleNodes) {
          if (node.indices) {
            viewState.visibleIndicesBuffer.set(node.indices, writeOffset);
            writeOffset += node.indices.length;
          }
        }

        const visibleIndices = viewState.visibleIndicesBuffer.subarray(0, totalVisible);
        const visibleRatio = snapshot.pointCount === 0
          ? 0
          : totalVisible / snapshot.pointCount;
        const cullPercent = ((1 - visibleRatio) * 100);

        // Log only on significant change (>10% of total points)
        if (DEBUG_LOD_FRUSTUM && this._isSignificantChange(viewState.lastVisibleCount, visibleIndices.length, snapshot.pointCount)) {
          console.log(`[FrustumCulling] Snapshot ${viewId}: ${visibleIndices.length.toLocaleString()}/${snapshot.pointCount.toLocaleString()} visible (${cullPercent.toFixed(1)}% culled)`);
          viewState.lastVisibleCount = visibleIndices.length;
        }

        // GPU acceptance is the publication boundary.
        this._uploadToViewIndexBuffer(viewState, visibleIndices);
        this._acceptVisibleNodeCandidate(viewState, visibleNodes);
        viewState.cachedVisibleSpatialOwner = tree;
        viewState.cachedVisibleSpatialRoot = tree.root;
        viewState.cachedCulledCount = visibleIndices.length;
        viewState._noVisibleNodesWarned = false;
        viewState.cachedVisibleIndices = visibleIndices;
        viewState.cachedLodVisibleIndices = null;
        viewState.cachedLodLevel = -1;
        viewState.cachedLodDimension = dimensionLevel;
        viewState.cachedLodIsCulled = false;
        viewState.cachedLodMappingGeneration = null;
        this.stats.frustumCulled = true;
        this.stats.cullPercent = cullPercent;
      } catch (error) {
        this._invalidateViewStateRecord(viewState);
        throw error;
      }
    }

    if (viewState.cachedCulledCount === 0) {
      this._writeStats(viewState, 0, -1, 0, true, 100);
      return;
    }

    const program = this.activeProgram;
    const uniforms = this.uniformLocations.get(this.activeQuality);

    if (!program || !uniforms) {
      throw new Error(
        `HighPerfRenderer "${this.activeQuality}" snapshot frustum shader state is unavailable.`
      );
    }

    gl.useProgram(program);

    const adjustedPointSize = pointSize * sizeMultiplier;
    if (uniforms.u_mvpMatrix !== null) gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    if (uniforms.u_viewMatrix !== null) gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
    if (uniforms.u_modelMatrix !== null) gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
    if (uniforms.u_projectionMatrix !== null && projectionMatrix) gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
    if (uniforms.u_pointSize !== null) gl.uniform1f(uniforms.u_pointSize, adjustedPointSize);
    if (uniforms.u_sizeAttenuation !== null) gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    if (uniforms.u_viewportHeight !== null) gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
    if (uniforms.u_fov !== null) gl.uniform1f(uniforms.u_fov, fov);
    if (uniforms.u_lightingStrength !== null) gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    if (uniforms.u_fogDensity !== null) gl.uniform1f(uniforms.u_fogDensity, fogDensity);
    if (uniforms.u_fogNear !== null) gl.uniform1f(uniforms.u_fogNear, this.fogNear);
    if (uniforms.u_fogFar !== null) gl.uniform1f(uniforms.u_fogFar, this.fogFar);
    if (uniforms.u_fogColor !== null) gl.uniform3fv(uniforms.u_fogColor, fogColor);
    if (uniforms.u_lightDir !== null) gl.uniform3fv(uniforms.u_lightDir, lightDir);

    // Defensive check: ensure index buffer is valid before drawing
    if (viewState.indexBufferSize !== viewState.cachedCulledCount) {
      throw new Error(
        `HighPerfRenderer snapshot "${viewId}" frustum index buffer contains ${viewState.indexBufferSize} entries but ${viewState.cachedCulledCount} are required.`
      );
    }

    let operationError = null;
    try {
      this._bindSnapshotAlphaTexture(
        gl,
        uniforms,
        snapshot,
        useAlphaTexture,
        dimensionLevel
      );
      gl.bindVertexArray(snapshot.vao);
      gl.bindBuffer(
        gl.ELEMENT_ARRAY_BUFFER,
        viewState.indexBuffer
      );
      gl.drawElements(
        gl.POINTS,
        viewState.cachedCulledCount,
        gl.UNSIGNED_INT,
        0
      );
    } catch (error) {
      operationError = error;
    }
    let restorationError = null;
    try {
      restorePointDrawBaseline(gl, true);
    } catch (error) {
      restorationError = error;
    }
    settlePointDraw(
      operationError,
      restorationError,
      'HighPerfRenderer snapshot frustum draw'
    );

    // Update both global and per-view stats
    this._writeStats(
      viewState,
      viewState.cachedCulledCount,
      -1,
      1,
      true,
      snapshot.pointCount === 0
        ? 100
        : 100 * (
            1 -
            viewState.cachedCulledCount / snapshot.pointCount
          )
    );
  }

  /**
   * Render snapshot with LOD (no frustum culling).
   * Uses indexed drawing into the snapshot buffer with LOD-selected indices.
   * @param {boolean} [useAlphaTexture=false] - If true, use alpha texture for real-time filter updates
   * @param {SpatialIndex} [spatialIndex] - Spatial index to use (for LOD levels)
   * @param {Array} [lodBuffersForDim] - LOD buffers for the view's dimension level
   * @private
   */
  _renderSnapshotWithLOD(
    snapshot,
    lodLevel,
    params,
    viewState,
    useAlphaTexture,
    spatialIndex,
    lodBuffersForDim
  ) {
    const gl = this.gl;
    const dimensionLevel = requireDimensionLevel(
      params.dimensionLevel,
      'HighPerfRenderer snapshot LOD dimensionLevel'
    );
    if (!Array.isArray(lodBuffersForDim)) {
      throw new TypeError(
        'HighPerfRenderer snapshot LOD buffers must be an exact array.'
      );
    }
    const lodBuffers = lodBuffersForDim;
    const tree = spatialIndex;
    if (!tree) {
      throw new Error(
        `HighPerfRenderer snapshot "${params.viewId}" LOD render requires an exact spatial index.`
      );
    }

    // Main-position snapshots may use their pre-uploaded LOD index buffer.
    const lod = lodBuffers[lodLevel];

    const treeLevel = tree.lodLevels[lodLevel];
    if (
      !treeLevel ||
      treeLevel.isFullDetail ||
      !(treeLevel.indices instanceof Uint32Array)
    ) {
      throw new Error(
        `HighPerfRenderer snapshot "${params.viewId}" LOD ${lodLevel} is not an exact indexed LOD level.`
      );
    }

    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir
    } = params;

    // Check structural selection first; exact resource/spatial ownership is
    // included below so same-level replacement generations cannot be missed.
    const lodLevelChanged = viewState.cachedLodLevel !== lodLevel;
    const wasFrustumCulled = viewState.cachedLodIsCulled;
    const dimensionChanged = viewState.cachedLodDimension !== -1 && viewState.cachedLodDimension !== dimensionLevel;

    // Determine if we can use pre-cached index buffer (main spatial index, not snapshot-specific)
    // Pre-cached buffers are stored in lodBuffers and match the main spatial index
    const usingMainSpatialIndex =
      spatialIndex === this.spatialIndices.get(dimensionLevel);
    const hasPreCachedBuffer = lod && lod.originalIndexBuffer && lod.originalIndexCount > 0;
    const canUsePreCachedBuffer = usingMainSpatialIndex && hasPreCachedBuffer;
    const generationToken =
      canUsePreCachedBuffer
        ? lod.generationToken ?? null
        : null;
    const borrowedGenerationChanged =
      canUsePreCachedBuffer &&
      (
        viewState.usePreCachedIndexBuffer !== true ||
        viewState.preCachedIndexBuffer !==
          lod.originalIndexBuffer ||
        viewState.preCachedGenerationToken !== generationToken ||
        viewState.preCachedSpatialOwner !== spatialIndex
      );
    const perViewOwnerChanged =
      !canUsePreCachedBuffer &&
      (
        viewState.usePreCachedIndexBuffer === true ||
        viewState.preCachedSpatialOwner !== spatialIndex
      );
    const needsBufferUpdate =
      lodLevelChanged ||
      wasFrustumCulled ||
      dimensionChanged ||
      borrowedGenerationChanged ||
      perViewOwnerChanged;

    if (needsBufferUpdate) {
      if (canUsePreCachedBuffer) {
        // USE PRE-CACHED INDEX BUFFER: No upload needed, just bind directly during draw
        // This eliminates the expensive gl.bufferData call on LOD level change
        viewState.cachedCulledCount = lod.originalIndexCount;
        viewState.cachedLodLevel = lodLevel;
        viewState.cachedLodDimension = dimensionLevel;
        viewState.cachedLodIsCulled = false;
        viewState.usePreCachedIndexBuffer = true;  // Flag to use pre-cached buffer during draw
        viewState.preCachedIndexBuffer = lod.originalIndexBuffer;
        viewState.preCachedGenerationToken = generationToken;
        viewState.preCachedSpatialOwner = spatialIndex;
      } else {
        const lodOriginalIndices = treeLevel.indices;
        this._uploadToViewIndexBuffer(viewState, lodOriginalIndices);
        viewState.cachedCulledCount = lodOriginalIndices.length;
        viewState.cachedLodLevel = lodLevel;
        viewState.cachedLodDimension = dimensionLevel;
        viewState.cachedLodIsCulled = false;
        viewState.usePreCachedIndexBuffer = false;
        viewState.preCachedIndexBuffer = null;
        viewState.preCachedGenerationToken = null;
        viewState.preCachedSpatialOwner = spatialIndex;
      }
    }

    const sizeMultiplier = treeLevel.sizeMultiplier;
    if (!Number.isFinite(sizeMultiplier)) {
      throw new TypeError(
        `HighPerfRenderer snapshot "${params.viewId}" LOD sizeMultiplier must be a finite number; received ${String(sizeMultiplier)}.`
      );
    }
    const adjustedPointSize = pointSize * sizeMultiplier;

    const program = this.activeProgram;
    const uniforms = this.uniformLocations.get(this.activeQuality);

    if (!program || !uniforms) {
      throw new Error(
        `HighPerfRenderer "${this.activeQuality}" snapshot LOD shader state is unavailable.`
      );
    }

    gl.useProgram(program);

    if (uniforms.u_mvpMatrix !== null) gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    if (uniforms.u_viewMatrix !== null) gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
    if (uniforms.u_modelMatrix !== null) gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
    if (uniforms.u_projectionMatrix !== null && projectionMatrix) gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
    if (uniforms.u_pointSize !== null) gl.uniform1f(uniforms.u_pointSize, adjustedPointSize);
    if (uniforms.u_sizeAttenuation !== null) gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    if (uniforms.u_viewportHeight !== null) gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
    if (uniforms.u_fov !== null) gl.uniform1f(uniforms.u_fov, fov);
    if (uniforms.u_lightingStrength !== null) gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    if (uniforms.u_fogDensity !== null) gl.uniform1f(uniforms.u_fogDensity, fogDensity);
    if (uniforms.u_fogNear !== null) gl.uniform1f(uniforms.u_fogNear, this.fogNear);
    if (uniforms.u_fogFar !== null) gl.uniform1f(uniforms.u_fogFar, this.fogFar);
    if (uniforms.u_fogColor !== null) gl.uniform3fv(uniforms.u_fogColor, fogColor);
    if (uniforms.u_lightDir !== null) gl.uniform3fv(uniforms.u_lightDir, lightDir);

    // Use pre-cached index buffer if available (eliminates upload on LOD change)
    let drawIndexBuffer;
    if (viewState.usePreCachedIndexBuffer) {
      if (
        !viewState.preCachedIndexBuffer ||
        viewState.cachedCulledCount !== treeLevel.indices.length
      ) {
        throw new Error(
          `HighPerfRenderer snapshot "${params.viewId}" pre-uploaded LOD index ownership is invalid.`
        );
      }
      drawIndexBuffer = viewState.preCachedIndexBuffer;
    } else {
      if (
        !viewState.indexBuffer ||
        viewState.indexBufferSize !== viewState.cachedCulledCount
      ) {
        throw new Error(
          `HighPerfRenderer snapshot "${params.viewId}" per-view LOD index ownership is invalid.`
        );
      }
      drawIndexBuffer = viewState.indexBuffer;
    }
    // Snapshot EBOs contain source IDs, so alpha uses gl_VertexID directly.
    let operationError = null;
    try {
      this._bindSnapshotAlphaTexture(
        gl,
        uniforms,
        snapshot,
        useAlphaTexture,
        dimensionLevel
      );
      gl.bindVertexArray(snapshot.vao);
      gl.bindBuffer(
        gl.ELEMENT_ARRAY_BUFFER,
        drawIndexBuffer
      );
      gl.drawElements(
        gl.POINTS,
        viewState.cachedCulledCount,
        gl.UNSIGNED_INT,
        0
      );
    } catch (error) {
      operationError = error;
    }
    let restorationError = null;
    try {
      restorePointDrawBaseline(gl, true);
    } catch (error) {
      restorationError = error;
    }
    settlePointDraw(
      operationError,
      restorationError,
      'HighPerfRenderer snapshot LOD draw'
    );

    // Update both global and per-view stats
    this._writeStats(
      viewState,
      viewState.cachedCulledCount,
      lodLevel,
      1,
      false,
      0
    );
  }

  /**
   * Render snapshot with combined LOD and frustum culling.
   * Uses indexed drawing into the snapshot buffer with filtered indices.
   * @param {boolean} useAlphaTexture - Whether the exact alpha texture contract is active
   * @param {SpatialIndex} spatialIndex - Spatial index owned by this snapshot render
   * @param {Array} lodBuffersForDim - LOD buffers for the exact view dimension
   * @private
   */
  _renderSnapshotLODWithFrustumCulling(
    snapshot,
    lodLevel,
    params,
    frustumPlanes,
    viewState,
    useAlphaTexture,
    spatialIndex,
    lodBuffersForDim,
    frustumChanged
  ) {
    const gl = this.gl;
    const dimLevel = requireDimensionLevel(
      params.dimensionLevel,
      'HighPerfRenderer snapshot LOD/frustum dimensionLevel'
    );
    if (!Array.isArray(lodBuffersForDim)) {
      throw new TypeError(
        'HighPerfRenderer snapshot LOD/frustum buffers must be an exact array.'
      );
    }
    if (typeof frustumChanged !== 'boolean') {
      throw new TypeError(
        'HighPerfRenderer snapshot LOD/frustum cache state must be a boolean.'
      );
    }

    const tree = spatialIndex;
    if (!tree) {
      throw new Error(
        `HighPerfRenderer snapshot "${params.viewId}" LOD/frustum render requires an exact spatial index.`
      );
    }

    if (!Number.isInteger(lodLevel) || lodLevel < 0) {
      throw new RangeError(
        `HighPerfRenderer snapshot "${params.viewId}" LOD level must be a non-negative integer.`
      );
    }

    const treeLevel = tree.lodLevels[lodLevel];
    if (
      !treeLevel ||
      treeLevel.isFullDetail ||
      !(treeLevel.indices instanceof Uint32Array) ||
      treeLevel.indices.length !== treeLevel.pointCount
    ) {
      throw new Error(
        `HighPerfRenderer snapshot "${params.viewId}" LOD ${lodLevel} is not an exact indexed LOD level.`
      );
    }

    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir,
      viewId,
      dimensionLevel
    } = params;

    // Snapshot EBOs address the full source-order VAO, while the live LOD VAO
    // is compact. Reuse its exact leaf/rank mapping, then translate only the
    // admitted compact ranks through the one maximum-prefix original-ID
    // owner. This avoids both a potentially multi-million-entry Set and two
    // whole-prefix scans on every camera/LOD transition.
    tree.ensureLodNodeMappings();
    this._ensureLodResourceOwnershipState();
    const unvalidatedMappingToken =
      tree._lodNodeMapping?.generationToken ?? null;
    if (
      this._validatedLodNodeMappings.get(tree) !==
      unvalidatedMappingToken
    ) {
      const validatedToken = tree._validateLodNodeMapping();
      this._validatedLodNodeMappings.set(tree, validatedToken);
    }
    const mappingOwner = tree._lodNodeMapping;
    const mappingToken = mappingOwner?.generationToken ?? null;
    const maximumOriginalIndices = mappingOwner?.maximumIndices;
    if (
      mappingToken === null ||
      this._validatedLodNodeMappings.get(tree) !== mappingToken ||
      !(maximumOriginalIndices instanceof Uint32Array)
    ) {
      throw new Error(
        `HighPerfRenderer snapshot "${viewId}" LOD mapping generation is unavailable.`
      );
    }

    const spatialOwnerChanged =
      viewState.cachedVisibleSpatialOwner !== tree ||
      viewState.cachedVisibleSpatialRoot !== tree.root ||
      !Array.isArray(viewState.cachedVisibleNodes);
    const lodCacheChanged =
      viewState.cachedLodLevel !== lodLevel ||
      viewState.cachedLodDimension !== dimLevel ||
      viewState.cachedLodIsCulled !== true ||
      viewState.cachedLodMappingGeneration !== mappingToken ||
      !(viewState.cachedLodVisibleIndices instanceof Uint32Array) ||
      viewState.cachedCulledCount !==
        viewState.cachedLodVisibleIndices?.length ||
      (
        viewState.cachedCulledCount > 0 &&
        viewState.indexBufferSize !== viewState.cachedCulledCount
      );
    let visibleNodes = viewState.cachedVisibleNodes;
    let candidateToAccept = null;
    let lodAdmissionChanged = false;

    if (frustumChanged || spatialOwnerChanged) {
      const candidate = this._collectVisibleNodeCandidate(
        viewState,
        tree.root,
        frustumPlanes
      );
      const sameLodAdmission =
        !spatialOwnerChanged &&
        tree.hasSameLodVisibleLeafSet(
          viewState.cachedVisibleNodes,
          candidate
        );
      if (sameLodAdmission) {
        this._recycleVisibleNodeCandidate(viewState, candidate);
      } else {
        visibleNodes = candidate;
        candidateToAccept = candidate;
        lodAdmissionChanged = true;
      }
    }

    if (
      spatialOwnerChanged ||
      lodCacheChanged ||
      lodAdmissionChanged
    ) {
      try {
        if (!Array.isArray(visibleNodes)) {
          throw new Error(
            `HighPerfRenderer snapshot "${viewId}" LOD leaf admission is unavailable.`
          );
        }
        if (visibleNodes.length === 0) {
          const emptyLodScratch =
            this._ensureVisibleLodIndexScratch(viewState, 0);
          if (candidateToAccept) {
            this._acceptVisibleNodeCandidate(
              viewState,
              candidateToAccept
            );
          }
          viewState.cachedVisibleSpatialOwner = tree;
          viewState.cachedVisibleSpatialRoot = tree.root;
          viewState.cachedLodMappingGeneration = mappingToken;
          viewState.cachedCulledCount = 0;
          viewState.cachedLodVisibleIndices =
            emptyLodScratch.subarray(0, 0);
          viewState.cachedLodLevel = lodLevel;
          viewState.cachedLodDimension = dimLevel;
          viewState.cachedLodIsCulled = true;
          viewState.usePreCachedIndexBuffer = false;
          viewState.preCachedIndexBuffer = null;
          viewState.preCachedGenerationToken = null;
          viewState.preCachedSpatialOwner = null;
          viewState._noVisibleNodesWarned = false;
          this._writeStats(
            viewState,
            0,
            lodLevel,
            0,
            true,
            100
          );
          return;
        }

        const visibleCount = tree.countLodMappedIndices(
          visibleNodes,
          lodLevel
        );
        const totalLodPoints = treeLevel.pointCount;
        if (
          !Number.isSafeInteger(visibleCount) ||
          visibleCount < 0 ||
          visibleCount > totalLodPoints
        ) {
          throw new RangeError(
            `HighPerfRenderer snapshot LOD ${lodLevel} mapping counted invalid visibility ${String(visibleCount)} for prefix ${totalLodPoints}.`
          );
        }
        const visibleRatio = totalLodPoints === 0
          ? 0
          : visibleCount / totalLodPoints;
        const cullPercent = ((1 - visibleRatio) * 100);

        // This per-view scratch is the only visibility-sized CPU owner. Its
        // shared live/snapshot policy grows from admitted points and releases
        // materially oversized wide-frustum retention with hysteresis.
        const visibleLodIndices =
          this._ensureVisibleLodIndexScratch(
            viewState,
            visibleCount
          );

        const writtenCount = tree.writeLodMappedIndices(
          visibleNodes,
          lodLevel,
          visibleLodIndices
        );
        if (writtenCount !== visibleCount) {
          throw new Error(
            `HighPerfRenderer snapshot LOD ${lodLevel} mapping counted ${visibleCount} indices but wrote ${writtenCount}.`
          );
        }

        // writeLodMappedIndices emits compact ranks in the same deterministic
        // order consumed by live rendering. Translate in place so the
        // snapshot's full source-order VAO receives the corresponding
        // original IDs without allocating another O(N) projection.
        for (let index = 0; index < visibleCount; index++) {
          const compactRank = visibleLodIndices[index];
          if (
            compactRank >= totalLodPoints ||
            compactRank >= maximumOriginalIndices.length
          ) {
            throw new RangeError(
              `HighPerfRenderer snapshot LOD ${lodLevel} mapping emitted compact rank ${compactRank} outside prefix ${totalLodPoints}.`
            );
          }
          visibleLodIndices[index] =
            maximumOriginalIndices[compactRank];
        }
        const visibleLodIndicesView =
          visibleLodIndices.subarray(0, visibleCount);

        if (DEBUG_LOD_FRUSTUM && this._isSignificantChange(viewState.lastVisibleCount, visibleCount, totalLodPoints)) {
          console.log(`[LOD+Frustum] Snapshot ${viewId}: LOD ${lodLevel} - ${visibleCount.toLocaleString()}/${totalLodPoints.toLocaleString()} visible (${cullPercent.toFixed(1)}% culled)`);
          viewState.lastVisibleCount = visibleCount;
        }

        // GPU acceptance is the publication boundary. A failure invalidates
        // the advanced MVP/LOD keys, so the next frame re-traverses and
        // retries instead of drawing the previously accepted topology.
        this._uploadToViewIndexBuffer(
          viewState,
          visibleLodIndicesView
        );
        if (candidateToAccept) {
          this._acceptVisibleNodeCandidate(
            viewState,
            candidateToAccept
          );
        }
        viewState.cachedVisibleSpatialOwner = tree;
        viewState.cachedVisibleSpatialRoot = tree.root;
        viewState.cachedLodMappingGeneration = mappingToken;
        viewState.cachedLodVisibleIndices =
          visibleLodIndicesView;
        viewState.cachedCulledCount = visibleCount;
        viewState.cachedLodLevel = lodLevel;
        viewState.cachedLodDimension = dimLevel;
        viewState.cachedLodIsCulled = true;
        viewState.usePreCachedIndexBuffer = false;
        viewState.preCachedIndexBuffer = null;
        viewState.preCachedGenerationToken = null;
        viewState.preCachedSpatialOwner = null;
        viewState._noVisibleNodesWarned = false;
        this.stats.frustumCulled = true;
        this.stats.cullPercent = cullPercent;
      } catch (error) {
        this._invalidateViewStateRecord(viewState);
        throw error;
      }
    }

    if (
      !(viewState.cachedLodVisibleIndices instanceof Uint32Array) ||
      viewState.cachedCulledCount !==
        viewState.cachedLodVisibleIndices.length ||
      viewState.cachedLodLevel !== lodLevel ||
      viewState.cachedLodDimension !== dimLevel ||
      viewState.cachedLodIsCulled !== true ||
      viewState.cachedVisibleSpatialOwner !== tree ||
      viewState.cachedVisibleSpatialRoot !== tree.root ||
      viewState.cachedLodMappingGeneration !== mappingToken
    ) {
      throw new Error(
        `HighPerfRenderer snapshot "${viewId}" LOD/frustum visibility state is inconsistent.`
      );
    }

    if (viewState.cachedCulledCount === 0) {
      this._writeStats(
        viewState,
        0,
        lodLevel,
        0,
        true,
        100
      );
      return;
    }

    const sizeMultiplier = treeLevel.sizeMultiplier;
    if (!Number.isFinite(sizeMultiplier)) {
      throw new TypeError(
        `HighPerfRenderer snapshot "${viewId}" LOD sizeMultiplier must be a finite number; received ${String(sizeMultiplier)}.`
      );
    }
    const adjustedPointSize = pointSize * sizeMultiplier;

    const program = this.activeProgram;
    const uniforms = this.uniformLocations.get(this.activeQuality);

    if (!program || !uniforms) {
      throw new Error(
        `HighPerfRenderer "${this.activeQuality}" snapshot LOD/frustum shader state is unavailable.`
      );
    }

    gl.useProgram(program);

    if (uniforms.u_mvpMatrix !== null) gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    if (uniforms.u_viewMatrix !== null) gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
    if (uniforms.u_modelMatrix !== null) gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
    if (uniforms.u_projectionMatrix !== null && projectionMatrix) gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
    if (uniforms.u_pointSize !== null) gl.uniform1f(uniforms.u_pointSize, adjustedPointSize);
    if (uniforms.u_sizeAttenuation !== null) gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    if (uniforms.u_viewportHeight !== null) gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
    if (uniforms.u_fov !== null) gl.uniform1f(uniforms.u_fov, fov);
    if (uniforms.u_lightingStrength !== null) gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    if (uniforms.u_fogDensity !== null) gl.uniform1f(uniforms.u_fogDensity, fogDensity);
    if (uniforms.u_fogNear !== null) gl.uniform1f(uniforms.u_fogNear, this.fogNear);
    if (uniforms.u_fogFar !== null) gl.uniform1f(uniforms.u_fogFar, this.fogFar);
    if (uniforms.u_fogColor !== null) gl.uniform3fv(uniforms.u_fogColor, fogColor);
    if (uniforms.u_lightDir !== null) gl.uniform3fv(uniforms.u_lightDir, lightDir);

    if (
      !viewState.indexBuffer ||
      viewState.indexBufferSize !== viewState.cachedCulledCount
    ) {
      throw new Error(
        `HighPerfRenderer snapshot "${viewId}" per-view LOD/frustum index ownership is invalid.`
      );
    }

    let operationError = null;
    try {
      this._bindSnapshotAlphaTexture(
        gl,
        uniforms,
        snapshot,
        useAlphaTexture,
        dimensionLevel
      );
      gl.bindVertexArray(snapshot.vao);
      gl.bindBuffer(
        gl.ELEMENT_ARRAY_BUFFER,
        viewState.indexBuffer
      );
      gl.drawElements(
        gl.POINTS,
        viewState.cachedCulledCount,
        gl.UNSIGNED_INT,
        0
      );
    } catch (error) {
      operationError = error;
    }
    let restorationError = null;
    try {
      restorePointDrawBaseline(gl, true);
    } catch (error) {
      restorationError = error;
    }
    settlePointDraw(
      operationError,
      restorationError,
      'HighPerfRenderer snapshot LOD/frustum draw'
    );

    // Update both global and per-view stats
    this._writeStats(
      viewState,
      viewState.cachedCulledCount,
      lodLevel,
      1,
      true,
      treeLevel.indices.length === 0
        ? 100
        : 100 * (
            1 -
            viewState.cachedCulledCount / treeLevel.indices.length
          )
    );
  }

  /**
   * Terminally detach every CPU/GPU ownership projection after the browser has
   * reported `webglcontextlost`. WebGL invalidates and releases the underlying
   * objects itself; issuing binds, deletes, liveness queries, or error checks
   * from this point is both unnecessary and observably unsafe.
   *
   * @returns {boolean} true only for the first accepted context-loss transition
   */
  handleContextLost() {
    if (
      this._contextLost === true ||
      this._disposed === true
    ) {
      return false;
    }
    // Publish the terminal fence before touching any ownership record so an
    // unexpected reentrant caller cannot reach the invalid context.
    this._contextLost = true;
    this._detachContextLostOwnership();
    return true;
  }

  /**
   * Idempotently drop every invalid browser and CPU ownership handle without
   * consulting WebGL. Disposal calls this again so partially instrumented or
   * externally perturbed loss handling still converges to the same terminal
   * publication.
   *
   * @private
   */
  _detachContextLostOwnership() {
    this.programs = {
      full: null,
      light: null,
      ultralight: null,
    };
    this.activeProgram = null;
    this.uniformLocations = new Map();
    this.vao = null;
    this.buffers = {
      interleaved: null,
      positions: null,
      colors: null,
      alphas: null,
    };
    this._interleavedGpuByteLength = 0;
    this._alphaTexture = null;
    this._alphaTextureByteLength = 0;
    this._alphaTexWidth = 0;
    this._alphaTexHeight = 0;
    this._alphaTexData = null;
    this._alphaTexStagingData = null;
    this._useAlphaTexture = false;
    this._currentAlphas = null;
    this._dummyLodIndexTexture = null;
    this._dummyLodIndexTextureByteLength = 0;

    this._lodIndexTexturesByDimension = new Map();
    this._lodResourceOwnersByDimension = new Map();
    this.spatialIndices = new Map();
    this.lodBuffersByDimension = new Map();
    this._dirtyLodDimensions = new Set();
    this._perViewState = new Map();
    this.snapshotBuffers = new Map();
    this._snapshotGeometryPools = new Map();

    this._pendingSnapshotRetirements = new Set();
    this._pendingDataRetirements = new Set();
    this._pendingProgramRetirements = new Set();
    this._pendingShaderRetirements = new Set();
    this._pendingProgramUnbind = false;

    this.pointCount = 0;
    this.forceLODLevel = -1;
    this.useAdaptiveLOD = false;
    this.useFrustumCulling = false;
    this._positions = null;
    this._colors = null;
    this._liveGeometryGeneration = 0;
    this._nextGeometryGeneration = 1;
    this._boundingSphere = null;
    this._bufferDirty = false;
    this._firstRenderDone = false;

    this._interleavedArrayBuffer = null;
    this._interleavedPositionView = null;
    this._interleavedColorView = null;
    this._snapshotColorStagingData = null;
    this._snapshotAlphaStagingData = null;
    this._visibleIndicesBuffer = null;
    this._visibleIndicesCapacity = 0;
    this._validatedLodNodeMappings = new WeakMap();
    this._validatedSpatialIndices = new WeakSet();
    this._lodSpatialOwnerTokens = new WeakMap();
    this._lodSequentialMemberships = new WeakMap();
    if (this.stats && typeof this.stats === 'object') {
      this.stats.lastFrameTime = 0;
      this.stats.fps = 0;
      this.stats.visiblePoints = 0;
      this.stats.lodLevel = -1;
      this.stats.gpuMemoryMB = 0;
      this.stats.drawCalls = 0;
      this.stats.frustumCulled = false;
      this.stats.cullPercent = 0;
    }

    // Drop even the context reference last. No property above invokes it.
    this.gl = null;
  }

  dispose() {
    if (this._disposed === true) return;
    if (this._contextLost === true) {
      // Re-run the idempotent, GL-silent detach so disposal converges even if
      // a diagnostic or hostile caller perturbed public fields after loss.
      this._detachContextLostOwnership();
      this._disposed = true;
      return;
    }
    const gl = this.gl;
    const failures = [];
    this._ensureRetirementOwnershipState();

    // Detach program ownership before any fallible context operation. A
    // currently bound program must be unbound before deletion can retire its
    // implementation storage, and failed deletions remain journaled for an
    // exact subsequent dispose retry.
    const programs = Object.values(this.programs ?? {});
    this._markProgramUnbindIfOwned(programs);
    this.programs = {
      full: null,
      light: null,
      ultralight: null,
    };
    this.activeProgram = null;
    this.uniformLocations.clear();
    this._queueProgramRetirement(programs);
    const unbindFailure = this._attemptProgramUnbind();
    if (unbindFailure) failures.push(unbindFailure);

    // Capture and detach the complete current data publication before any
    // fallible deletion. Pending records own every resource across retries.
    this._queueDataRetirement(this._captureDataPublication());
    this.vao = null;
    this.buffers = {
      interleaved: null,
      positions: null,
      colors: null,
      alphas: null,
    };
    this._interleavedGpuByteLength = 0;
    this._alphaTexture = null;
    this._alphaTextureByteLength = 0;
    this._alphaTexWidth = 0;
    this._alphaTexHeight = 0;
    this._alphaTexData = null;
    this._alphaTexStagingData = null;
    this._useAlphaTexture = false;
    this._currentAlphas = null;
    this._lodIndexTexturesByDimension = new Map();
    this._lodResourceOwnersByDimension = new Map();
    this.spatialIndices = new Map();
    this.lodBuffersByDimension = new Map();
    this._perViewState = new Map();
    this._dirtyLodDimensions = new Set();
    this.pointCount = 0;
    this._positions = null;
    this._colors = null;
    this._liveGeometryGeneration = 0;
    this._boundingSphere = null;
    this._bufferDirty = false;
    this._validatedLodNodeMappings = new WeakMap();
    this._validatedSpatialIndices = new WeakSet();

    const snapshots = Array.from(this.snapshotBuffers.values());
    this.snapshotBuffers.clear();
    this._releaseSnapshotScratchIfUnused();
    for (const snapshot of snapshots) {
      this._queueSnapshotRetirement(snapshot, {
        releaseAlpha: true,
        releaseColor: true,
        releaseGeometry: true,
        releaseVao: true,
      });
    }

    if (this._dummyLodIndexTexture) {
      this._queueDataRetirement({
        dummyLodIndexTexture: this._dummyLodIndexTexture,
        dummyLodIndexTextureByteLength:
          this._dummyLodIndexTextureByteLength,
      });
      this._dummyLodIndexTexture = null;
      this._dummyLodIndexTextureByteLength = 0;
    }

    failures.push(...this._drainDataRetirements());
    failures.push(...this._drainSnapshotRetirements());
    failures.push(...this._drainProgramRetirements());
    failures.push(...this._drainShaderRetirements());
    this._interleavedArrayBuffer = null;
    this._interleavedPositionView = null;
    this._interleavedColorView = null;
    this._refreshGpuMemoryStats();

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `HighPerfRenderer disposal retains ${failures.length} pending resource failure(s).`
      );
    }
    this._disposed = true;
  }
}

export default HighPerfRenderer;
