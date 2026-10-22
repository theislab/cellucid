/**
 * HIGH-PERFORMANCE SCATTERPLOT RENDERER (WebGL2 Only)
 * ====================================================
 * Optimized for 20-30+ million points using:
 *
 * 1. WebGL2 with VAOs and GLSL ES 3.0
 * 2. Split vertex streams: Float32 positions (only the embedding's own
 *    components: x, xy or xyz) and RGBA8 live in separate buffers, so a
 *    recolor uploads 4 bytes a point and a position switch 4 per embedding
 *    axis, each straight from the published typed array
 * 3. Level-of-Detail (LOD) with octree spatial indexing
 * 4. Frustum culling - only render visible points
 * 5. GPU-only fog (no CPU distance calculations)
 * 6. Lightweight shader variants
 */

import {
  HP_VS_FULL, HP_FS_FULL, HP_FS_FULL_NO_DEPTH,
  HP_VS_LIGHT, HP_FS_LIGHT, HP_FS_LIGHT_NO_DEPTH, HP_FS_ULTRALIGHT,
  HP_FS_SCULPTED, HP_FS_SCULPTED_NO_DEPTH,
  NO_DEPTH_MAX_DIMENSION,
  writePointShaderFrame
} from './shaders/high-perf-shaders.js';
import { writeFogUniforms } from './shaders/fog-shaders.js';
import { getNotificationCenter } from '../app/notification-center.js';
import { configureStraightAlphaBlending, drawPointsInSegments } from './gl-utils.js';
import {
  requireDimensionLevel,
  requireFiniteNumber,
  requireNumericVector,
  requireRenderContract,
  requireShaderQuality,
  requireSnapshotAlphas,
  requireSnapshotColors,
  requireSnapshotPointData,
  requireViewId,
} from './high-perf/renderer-contracts.js';
import {
  describeError,
  settleCalculationNotification,
} from './high-perf/calculation-notifications.js';
import {
  CONTEXT_LOST_ERROR_NAME,
  contextLostError,
  requireCleanWebGLState,
  requireLiveContext,
} from './gl-errors.js';
import {
  enterOpaquePointBlending,
  restorePointDrawBaseline,
  settlePointDraw,
} from './high-perf/gl-point-draw-state.js';
import { SpatialIndex } from './high-perf/spatial-index.js';
import { buildSpatialTreeJob } from './high-perf/spatial-tree-job.js';
import { GpuPermuter } from './high-perf/gpu-permute.js';
import {
  allocateLinearTexture,
  planLinearTextureFor,
  setLinearLayoutUniform,
  writeLinearTextureRows,
} from './linear-texture.js';
import {
  bindPositionAttribute,
  positionByteLength,
  readPositionBounds,
  requirePositionArray,
} from './position-layout.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Dimension threshold for disabling depth testing.
 * For 2D data (dimensionLevel <= this value), depth testing is disabled
 * to prevent draw-order artifacts when all points have the same Z.
 */
/**
 * Positions sent to the tree worker per message, in floats (64 MiB). A
 * geometry of any size goes to the worker in slices like this, one task
 * each, so no main-thread task copies more than this and the main thread
 * never holds a second full copy.
 */
const WORKER_POSITION_SLICE_FLOATS = 16 * 1024 * 1024;
const DEPTH_TEST_DIMENSION_THRESHOLD = NO_DEPTH_MAX_DIMENSION;

/**
 * Every point program the renderer links, keyed by name. Each shader quality
 * has one; a quality listed in `NO_DEPTH_POINT_PROGRAMS` has a second for the
 * passes that run without depth.
 */
const POINT_PROGRAM_NAMES = Object.freeze([
  'full',
  'fullNoDepth',
  'light',
  'lightNoDepth',
  'ultralight',
  'sculpted',
  'sculptedNoDepth',
]);

/**
 * Programs whose points are opaque and draw without blending, so that their
 * antialiased edge can become a multisample coverage mask with depth on (see
 * HP_FS_SCULPTED and `enterOpaquePointBlending`).
 */
const OPAQUE_POINT_PROGRAMS = Object.freeze(new Set(['sculpted']));

/**
 * The program a quality draws with when the pass does not use the depth
 * buffer (dimension level <= DEPTH_TEST_DIMENSION_THRESHOLD). A quality whose
 * fragment shader discards has one: the no-depth variant replaces each discard
 * with a zero-alpha fragment that blends to an identical pixel without
 * serialising the blend (see HP_FS_LIGHT_NO_DEPTH). `full` gained nothing from
 * this while it evaluated fog per fragment, because that was what bound its
 * dense 2-D frame; with fog evaluated per point it is bound by the same
 * serialisation as `light`. `ultralight` never discards.
 */
const NO_DEPTH_POINT_PROGRAMS = Object.freeze({
  full: 'fullNoDepth',
  light: 'lightNoDepth',
  sculpted: 'sculptedNoDepth',
});

function createEmptyPointPrograms() {
  return {
    full: null,
    fullNoDepth: null,
    light: null,
    lightNoDepth: null,
    ultralight: null,
    sculpted: null,
    sculptedNoDepth: null,
  };
}

/**
 * Debug flag for LOD and frustum culling logs.
 * Set to true to enable verbose console output during rendering.
 * This should be false in production to avoid performance impact.
 */
let DEBUG_LOD_FRUSTUM = false;


const VISIBLE_INDEX_GROWTH_FACTOR = 1.5;
const VISIBLE_INDEX_SHRINK_RATIO = 4;
const VISIBLE_INDEX_MIN_RECLAIM = 256 * 1024;
/**
 * Largest number of separate row regions one alpha publication may send.
 *
 * The alpha texture is a 2-D layout over a linear point index, so a change that
 * touches few points touches few rows and is worth addressing directly. A
 * change scattered across many rows is not: past this many regions the runs
 * collapse into the single range that bounds them, which costs one call and at
 * most the bytes a full upload always cost.
 */
const MAX_ALPHA_UPLOAD_REGIONS = 32;

/**
 * The row regions of an alpha texture that moved: one region per maximal run
 * of rows marked in `dirtyRows`, written into `regions` as (first row, row
 * count) pairs. Past `MAX_ALPHA_UPLOAD_REGIONS` the runs collapse into the
 * one range that bounds them.
 *
 * @param {Uint8Array} dirtyRows - 1 for a row that moved, one entry a row
 * @param {number} height - rows
 * @param {Int32Array} regions - at least `2 * height` entries
 * @returns {number} regions written
 */
function collectAlphaUploadRegions(dirtyRows, height, regions) {
  let regionCount = 0;
  let runStart = -1;
  for (let y = 0; y < height; y++) {
    if (dirtyRows[y] === 1) {
      if (runStart === -1) runStart = y;
      continue;
    }
    if (runStart !== -1) {
      regions[regionCount * 2] = runStart;
      regions[regionCount * 2 + 1] = y - runStart;
      regionCount++;
      runStart = -1;
    }
  }
  if (runStart !== -1) {
    regions[regionCount * 2] = runStart;
    regions[regionCount * 2 + 1] = height - runStart;
    regionCount++;
  }
  if (regionCount > MAX_ALPHA_UPLOAD_REGIONS) {
    const firstRow = regions[0];
    const lastRowEnd =
      regions[(regionCount - 1) * 2] + regions[(regionCount - 1) * 2 + 1];
    regions[0] = firstRow;
    regions[1] = lastRowEnd - firstRow;
    regionCount = 1;
  }
  return regionCount;
}
/*
 * Point streams.
 *
 * A store in source order is the published Float32 position array
 * (`dimension` components a point, never padded to three) and the published
 * RGBA8 colour array, each handed to `bufferData` / `bufferSubData` as-is, so
 * the renderer never holds a client-side copy of either. A store in a tree's
 * draw order -- slot `k` holds point `indices[k]` -- is gathered on the GPU
 * (`GpuPermuter`), so no client allocation proportional to the point count
 * exists for it either.
 *
 * The two streams are also what makes a recolor cheap. Position and color
 * used to share one 16-byte record, so every color change repacked and
 * re-uploaded the positions beside it; now a recolor writes only the 4-byte
 * color stores and a dimension switch only the position stores (4 bytes per
 * embedding axis a point: 4, 8 or 12).
 * Splitting costs no vertex throughput: measured on Chromium/Metal with 5M
 * points, the split full-detail draw was within noise of the interleaved one.
 *
 * WebGL's per-buffer caps are byte caps. They were measured on all three
 * engines by bisecting to the exact refusing byte count -- Chromium 2^31 - 2^21,
 * WebKit 2^32 - 1, Firefox 2^31 - 1 -- and the largest store is the position
 * stream, 12 bytes a point for a 3-D embedding: 178,782,208 points on
 * Chromium, 178,956,970 on Firefox, 357,913,941 on WebKit. Per-point textures
 * (alpha, permutation, the permute source) are linear textures
 * (`linear-texture.js`): layers of `MAX_TEXTURE_SIZE` rows, so they bind no
 * lower than the position stream on any engine, including those that report
 * an 8192 texture size (Firefox). Every point draw is split into calls of at
 * most 2^24 vertices (`drawPointsInSegments`), under Firefox's 30,000,000
 * vertices a call. Those are engine and API caps; the host's own memory is a
 * separate and much lower practical bound.
 */
/**
 * Most draw ranges one frustum-culled draw issues where each range is its
 * own `drawArrays` (engines without `WEBGL_multi_draw`: Firefox). Ranges are
 * coarsened to fit by bridging the gaps that hide the fewest points: drawing
 * a few points outside the frustum costs less than another draw call. At 10M
 * points, 252 coarsened ranges drew a zoomed view in 7 ms on all three
 * engines, against 21-31 ms for the per-point index path they replace.
 */
const MAX_CULLED_DRAW_RANGES = 256;
/**
 * The range budget where one `multiDrawArraysWEBGL` call draws them all: a
 * range costs about 0.2 us there, so a finer cut draws fewer hidden points.
 */
const MAX_CULLED_DRAW_RANGES_MULTI_DRAW = 1024;
/** The live geometry's store, as `_ensureStoreDrawOrder` names a store. */
const LIVE_STORE = Object.freeze({ kind: 'live' });








/**
 * JS heap the level-of-detail build adds per point, over and above what the
 * loaded dataset already occupies, and the transient peak it reaches on top of
 * that.
 *
 * Fitted from a 5M/10M/20M/30M curve measured on Chromium: the settled heap is
 * 79.8 B a point plus 24 MiB with the LOD index built and 51.9 B a point plus
 * 20 MiB without it, so the build *retains* 27.9 B a point plus 4 MiB. The
 * transient term is the scratch that is live simultaneously during the build
 * and enumerable from the code: three `Uint32Array(pointCount)` in the
 * hierarchical ordering pass (12 B), the leaves and the geometric child chain
 * `_buildNode` holds (~8.6 B), and 16 B that at calibration time was a
 * point-count-sized packing scratch. Stores are now gathered on the GPU, so
 * that scratch no longer exists; the 16 B stays in the projection as margin
 * until the 40M Chromium hang is measured again.
 *
 * A build that fits its settled size but not its peak is the worst outcome
 * available: the engine neither completes nor throws, it collects a multi-GiB
 * heap indefinitely. The peak is therefore what is admitted against, not the
 * settled size.
 */
const LOD_BUILD_RETAINED_HEAP_BYTES_PER_POINT = 27.9;
const LOD_BUILD_TRANSIENT_HEAP_BYTES_PER_POINT = 36.6;
const LOD_BUILD_HEAP_FIXED_BYTES = 4 * 1024 * 1024;

/** Peak JS heap a level-of-detail build adds for `pointCount` points. */
function projectLodBuildHeapBytes(pointCount) {
  return Math.ceil(
    pointCount * (
      LOD_BUILD_RETAINED_HEAP_BYTES_PER_POINT +
      LOD_BUILD_TRANSIENT_HEAP_BYTES_PER_POINT
    ) + LOD_BUILD_HEAP_FIXED_BYTES
  );
}

function describeHeapMebibytes(bytes) {
  return `${Math.round(bytes / (1024 * 1024)).toLocaleString()} MiB`;
}

/**
 * Refuse a level-of-detail build this tab's heap cannot finish.
 *
 * The texture ceiling above is checked the same way and for the same reason,
 * but it is not the ceiling that bites first: a device reports
 * `MAX_TEXTURE_SIZE` and the renderer can compare against it, whereas the JS
 * heap gives no error at all when it is exceeded during a build. The engine
 * simply mark-compacts a multi-GiB heap for as long as the tab is open --
 * alive, busy, no exception, no console message, nothing ever returned. An
 * unbounded hang is worse than either a clean render or a stated refusal, so
 * the count is admitted before the first allocation instead.
 *
 * The check is skipped where the engine publishes no heap limit. Only
 * Chromium exposes `performance.memory`; WebKit completes the build that
 * Chromium hangs on, and Firefox refuses it through `requireCleanWebGLState`
 * with a real WebGL error, so neither needs a projection and neither may be
 * given a fabricated limit.
 *
 * @param {number} pointCount Points the candidate index will cover.
 * @param {boolean} buildLOD Whether this build produces LOD levels.
 * @param {string} label Owner named in the refusal.
 */
/**
 * Whether a spatial index has its LOD levels.
 * @param {SpatialIndex|null|undefined} index
 * @returns {boolean}
 */
function spatialIndexHasLod(index) {
  return Array.isArray(index?.lodLevels) && index.lodLevels.length > 0;
}

function requireLodBuildHeapHeadroom(pointCount, buildLOD, label) {
  if (buildLOD !== true) return;
  if (!Number.isFinite(pointCount) || pointCount <= 0) return;
  const memory =
    typeof performance !== 'undefined' && performance !== null
      ? performance.memory
      : null;
  if (memory === null || typeof memory !== 'object') return;
  const limitBytes = memory.jsHeapSizeLimit;
  const usedBytes = memory.usedJSHeapSize;
  if (
    !Number.isFinite(limitBytes) ||
    !Number.isFinite(usedBytes) ||
    limitBytes <= 0 ||
    usedBytes < 0
  ) {
    return;
  }
  const projectedBytes = projectLodBuildHeapBytes(pointCount);
  if (usedBytes + projectedBytes <= limitBytes) return;
  const affordableBytes =
    limitBytes - usedBytes - LOD_BUILD_HEAP_FIXED_BYTES;
  const affordablePoints = Math.max(
    0,
    Math.floor(
      affordableBytes / (
        LOD_BUILD_RETAINED_HEAP_BYTES_PER_POINT +
        LOD_BUILD_TRANSIENT_HEAP_BYTES_PER_POINT
      )
    )
  );
  throw new RangeError(
    `${label} cannot build a level-of-detail index for ` +
    `${pointCount.toLocaleString()} points on this device: the build peaks at ` +
    `about ${describeHeapMebibytes(projectedBytes)} of JavaScript heap on top ` +
    `of the ${describeHeapMebibytes(usedBytes)} already in use, and this ` +
    `browser caps the tab at ${describeHeapMebibytes(limitBytes)}. Turn off ` +
    'adaptive level of detail and frustum culling to render this dataset at ' +
    `full detail, or subset it to at most ` +
    `${affordablePoints.toLocaleString()} points.`
  );
}

/**
 * Refuse an RGBA8 array that does not start on a 4-byte boundary.
 *
 * Colors go to the GPU as one 32-bit word each (the R32UI source texture the
 * draw-order gather reads), which needs a Uint32 view over the published
 * bytes. Every array the application publishes is its own allocation and so
 * starts at offset 0; a subarray at an odd offset is the only way to fail this.
 *
 * @param {Uint8Array} colors
 */
function requireWordAlignedColors(colors) {
  if (colors.byteOffset % 4 !== 0) {
    throw new TypeError(
      `HighPerfRenderer colors must start on a 4-byte boundary of their buffer; received byte offset ${colors.byteOffset}.`
    );
  }
}

/**
 * A colour store is written in a draw order only when that order places
 * every point: one slot a colour.
 *
 * @param {{drawOrder: {indices: Uint32Array}}|null} order
 * @param {Uint8Array} colors
 * @param {string} owner
 */
function requireOrderCoversColors(order, colors, owner) {
  if (order === null) return;
  const slots = order.drawOrder.indices.length;
  const count = colors.length >>> 2;
  if (slots !== count) {
    throw new RangeError(`${owner} has a draw order of ${slots} slots for ${count} colours.`);
  }
}

/**
 * One Uint32 word per RGBA8 color, aliasing the published bytes. Byte order is
 * irrelevant because words are only ever copied.
 *
 * @param {Uint8Array} colors - Word-aligned RGBA8 colors.
 * @returns {Uint32Array}
 */
function colorWordsOf(colors) {
  requireWordAlignedColors(colors);
  return new Uint32Array(
    colors.buffer,
    colors.byteOffset,
    colors.length >>> 2
  );
}

/**
 * One view's frustum-cull state: the leaf runs inside the frustum (pairs of
 * `[leafStart, leafEnd)`), the draw ranges they make for one band limit, and
 * the tree and draw order they were computed for. Scratch arrays grow and are
 * reused; nothing here is per point.
 *
 * @returns {object}
 */
function createCullState() {
  return {
    tree: null,
    drawOrder: null,
    runs: new Uint32Array(256),
    runCount: 0,
    gaps: new Uint32Array(0),
    stack: [],
    band: -1,
    starts: new Int32Array(MAX_CULLED_DRAW_RANGES),
    counts: new Int32Array(MAX_CULLED_DRAW_RANGES),
    rangeCount: 0,
    elementCount: 0,
  };
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
  QUALITY_SCULPTED: 'sculpted',

  // Feature flags
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
    // The shared marker from `gl-errors.js`, so this fence and every GL-error
    // preflight raise one recognisable condition; `isContextLostError()` there
    // is what the frame loop tests against.
    this.name = CONTEXT_LOST_ERROR_NAME;
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
    this.programs = createEmptyPointPrograms();

    // Current active program
    this.activeProgram = null;
    this.activeQuality = 'full';

    // Uniform locations cache
    this.uniformLocations = new Map();

    // Full-detail vertex streams: Float32 positions with the live dimension's
    // components (attribute 0) and RGBA8 (attribute 1), one buffer each,
    // bound into `this.vao`.
    this.buffers = {
      positions: null,
      colors: null,
    };
    // Exact logical store sizes accepted by WebGL for the two live streams.
    // Keep these separate from pointCount: failed replacements retain their
    // previous allocation even after semantic draw state is invalidated.
    this._positionGpuByteLength = 0;
    this._colorGpuByteLength = 0;

    // Alpha texture for efficient alpha-only updates (avoids full buffer rebuild)
    // Using a texture allows updating alpha with texSubImage2D instead of bufferData
    this._alphaTexture = null;
    this._alphaTexWidth = 0;
    this._alphaTexHeight = 0;
    this._alphaTexPlan = null;
    this._alphaTexData = null; // Uint8Array for texture upload
    this._alphaTexStagingData = null;
    // Scratch for the region-addressed alpha upload: one dirty flag per texture
    // row, and the interleaved (rowStart, rowCount) pairs derived from it. Both
    // are re-derived on every publication and sized against the current
    // texture, so they are not part of the accepted alpha generation.
    this._alphaDirtyRows = null;
    this._alphaUploadRegions = null;
    this._useAlphaTexture = false; // Whether alpha texture is active
    this._currentAlphas = null;
    this._alphaTextureByteLength = 0;

    // The draw order the live position store holds (see "DRAW ORDER"):
    // null while it holds source order, else `{ drawOrder, texture, width,
    // height, byteLength }`, the texture mapping a stored slot back to its
    // source index. `_liveColorOrder` is the draw order the live colour store
    // holds; it follows `_liveOrder` at the next render.
    this._liveOrder = null;
    this._liveColorOrder = null;
    // Live colour stores kept per draw order (see "COLOUR STORES KEPT PER
    // DRAW ORDER").
    this._liveColorCache = new Map();
    // `WEBGL_multi_draw`, looked up once (undefined until then).
    this._multiDraw = undefined;

    // Dummy 1x1 R32UI texture bound while no draw order is: usampler2D
    // uniforms must have a valid unsigned int texture bound.
    this._dummyLodIndexTexture = null;
    this._dummyLodIndexTextureByteLength = 0;
    // Gathers stores into a draw order on the GPU (created on first use).
    this._permuter = null;
    // Called when a tree built off the main thread is installed, so the
    // embedder draws a frame (the viewer invalidates its frame).
    this.onAsyncTreeReady = null;
    // Tree builds in flight and failed, per positions array.
    this._treeBuilds = new WeakMap();
    this._treeBuildFailures = new WeakMap();

    // LOD system - dimension-aware spatial indexing
    this.spatialIndices = new Map();  // Per-dimension spatial indices: Map<dimensionLevel, SpatialIndex>
    this.currentDimensionLevel = 3;  // Current active dimension level for live view

    // State
    this.pointCount = 0;
    this.forceLODLevel = -1; // -1 = auto, 0+ = forced level
    this.useAdaptiveLOD = this.options.USE_LOD;
    this.useFrustumCulling = this.options.USE_FRUSTUM_CULLING;

    // VAO for WebGL2
    this.vao = null;

    // Snapshot buffers for multi-view rendering (avoids re-uploading per frame).
    // Each snapshot owns one RGBA8 colour VBO plus one R8 alpha texture while its
    // geometry generation owns the immutable position VBO shared by every
    // same-generation VAO. `buffer` remains a compatibility alias for the
    // snapshot color owner's buffer.
    // Map<snapshotId, { vao, colorOwner, alphaTexture, pointCount, ... }>
    this.snapshotBuffers = new Map();
    // Snapshot point publications are synchronous. One renderer-wide R8
    // staging owner therefore serves every view without retaining another N
    // bytes per snapshot.
    this._snapshotAlphaStagingData = null;
    this._snapshotAlphaDirtyRows = null;
    this._snapshotAlphaUploadRegions = null;
    // The views the viewer presents this frame (`setPresentedViews`); null
    // until it says, which keeps every view resident. A kept view that is not
    // presented gives up its colour store and R8 texture when an allocation
    // is refused (`_releaseDormantSnapshotStores`) and gets them back from
    // its own colours and alpha bytes when it is next drawn or edited.
    this._presentedViewIds = null;
    // The kept view a public operation is working on: never released under it.
    this._snapshotInOperation = null;
    // Geometry identity is an explicit publication generation, never an array
    // identity: one published array can be published again as a new
    // generation (a view switched back to a dimension it showed before), and
    // each publication owns its own GPU store and spatial generation.
    this._liveGeometryGeneration = 0;
    this._nextGeometryGeneration = 1;
    // A published positions array is the geometry it describes: nothing
    // writes it after publication (a changed embedding is a new array), so a
    // snapshot adopts the array it is given instead of copying it. Snapshots
    // derived from one geometry generation share that one array and one
    // position VBO; snapshots of the live generation borrow the live
    // publication's own VBO (`borrowsLivePositionBuffer`), which passes to the
    // pool when the live publication retires.
    // Map<generation, {
    //   generation, positions, positionBuffer, positionBufferByteLength,
    //   borrowsLivePositionBuffer, refCount, spatialIndices
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
    // Collaborators that allocate GPU storage against this context but own
    // their own handles, so `stats.gpuMemoryMB` can describe the whole context.
    this._gpuAllocationReporters = new Set();
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

    // Per-draw products the point shaders read (see writePointShaderFrame),
    // and whether the current pass draws into a multisampled target.
    this._pointShaderFrame = {
      modelView: new Float32Array(16),
      halfDir: new Float32Array(3),
      invCenterShade: 1,
    };
    this._pointPassMultisampled = false;

    // Fog bounds
    this.fogNear = 0;
    this.fogFar = 10;

    // Cached bounding sphere (computed from positions, independent of octree)
    this._boundingSphere = null;

    // Deferred color publication: `updateColors` marks the live color
    // stream dirty, and the next render uploads it once, however many
    // recolors arrived in between.
    this._colorsDirty = false;

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
      this.programs = createEmptyPointPrograms();
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
   * Get or create per-view state for multi-view rendering. Each view keeps
   * its own frustum key and planes, cull ranges, LOD hysteresis and stats, so
   * views never disturb one another. It holds no GPU object.
   * @param {string} viewId - Exact view identifier.
   * @returns {Object} Per-view state.
   */
  _getViewState(viewId) {
    const vid = requireViewId(viewId);
    if (!this._perViewState.has(vid)) {
      this._perViewState.set(vid, {
        lastFrustumMVP: null,
        lastFrustumBounds: undefined,
        // The leaf runs inside the frustum and the draw ranges they make for
        // one band limit, for one tree and its draw order.
        cull: createCullState(),
        prevLodLevel: undefined,         // For logging LOD changes
        lastLodLevel: -1,                // For per-view LOD hysteresis
        lodConverging: false,            // Adaptive LOD still stepping toward its target level
        lastDimensionLevel: undefined,   // For cache invalidation on dimension change
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
    // The cull scratch is kept for reuse; only its keys are dropped.
    const cull = viewState.cull ?? createCullState();
    cull.tree = null;
    cull.drawOrder = null;
    cull.runCount = 0;
    cull.band = -1;
    cull.rangeCount = 0;
    cull.elementCount = 0;
    viewState.cull = cull;
    viewState.lastFrustumMVP = null;
    viewState.lastFrustumBounds = undefined;
    viewState.lastDimensionLevel = undefined;
    viewState.lastLodLevel = -1;
    viewState.lodConverging = false;
    viewState.prevLodLevel = undefined;
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
    // Per-view state owns no GPU object, so forgetting it is the whole job.
    this._perViewState.delete(vid);
  }

  /**
   * Clear all per-view state (call on data reload or major state reset)
   */
  clearAllViewState() {
    this._assertOperational('clear all view state');
    this._perViewState.clear();
  }

  /**
   * Compute bounds from a positions array.
   * Used for view-specific positions that differ from octree bounds.
   * @param {Float32Array} positions - `dimension` components per point
   * @param {number} dimension - Components per point (1, 2 or 3); the axes
   *   the embedding does not have are exactly zero.
   * @returns {Object} Bounds object { minX, maxX, minY, maxY, minZ, maxZ }
   */
  static computeBoundsFromPositions(positions, dimension) {
    requirePositionArray(
      positions,
      dimension,
      'HighPerfRenderer bounds positions'
    );
    // Scanned once per published array (`readPositionBounds`); a fresh record
    // for the caller to own.
    const { min, max } = readPositionBounds(positions, dimension);
    return {
      minX: min[0], maxX: max[0],
      minY: min[1], maxY: max[1],
      minZ: min[2], maxZ: max[2]
    };
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
      // Setting pixel-store state and a binding cannot be refused; only a
      // lost context ends the transaction here.
      requireLiveContext(gl, `${owner} unpack-state restoration`);
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
    const candidatePrograms = createEmptyPointPrograms();
    const candidateUniformLocations = new Map();
    try {
      Object.assign(candidatePrograms, this._createPointPrograms([
        ['full', HP_VS_FULL, HP_FS_FULL],
        ['fullNoDepth', HP_VS_FULL, HP_FS_FULL_NO_DEPTH],
        ['light', HP_VS_LIGHT, HP_FS_LIGHT],
        ['lightNoDepth', HP_VS_LIGHT, HP_FS_LIGHT_NO_DEPTH],
        ['ultralight', HP_VS_LIGHT, HP_FS_ULTRALIGHT],
        ['sculpted', HP_VS_FULL, HP_FS_SCULPTED],
        ['sculptedNoDepth', HP_VS_FULL, HP_FS_SCULPTED_NO_DEPTH],
      ]));

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
   * Create a dummy one-texel R32UI linear texture to bind when no permutation
   * is in use. Required because a usampler2DArray uniform must have a valid
   * unsigned integer texture bound even when the shader does not read it
   * (u_useLodIndexTex = false).
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
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, candidateTexture);
      // One R32UI texel with a dummy value, as a linear texture like every
      // permutation the point programs read.
      const dummyData = new Uint32Array([0]);
      const plan = planLinearTextureFor(gl, 1);
      this._withNeutralTextureUnpackState(
        4,
        'HighPerfRenderer candidate dummy LOD texture',
        () => {
          allocateLinearTexture(gl, gl.R32UI, plan);
          writeLinearTextureRows(gl, plan, gl.RED_INTEGER, gl.UNSIGNED_INT, dummyData, 1);
          requireCleanWebGLState(
            gl,
            'HighPerfRenderer candidate dummy LOD texture upload'
          );
        }
      );
      candidateByteLength = dummyData.byteLength;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      requireCleanWebGLState(
        gl,
        'HighPerfRenderer dummy LOD texture publication'
      );
    } catch (error) {
      try {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
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

  /**
   * Compile and link every point program in one batch: each distinct shader
   * source is compiled once (the full and light vertex shaders serve several
   * programs), every program is linked before any status is read, and a
   * status is read once per program at the end. Reading status after each
   * step made the driver finish every compile and link one after another
   * (14 compiles, 7 links, 21 waits); batched, the driver overlaps them and
   * the page waits once. A failure names the program and its diagnostic.
   *
   * @param {Array<[string, string, string]>} specs - [name, vertex, fragment].
   * @returns {Record<string, WebGLProgram>}
   * @private
   */
  _createPointPrograms(specs) {
    const gl = this.gl;
    const shaders = new Map();
    const programs = {};
    let operationError = null;
    const compile = (type, source, label) => {
      const key = `${type}:${source}`;
      let shader = shaders.get(key);
      if (shader !== undefined) return shader;
      shader = gl.createShader(type);
      if (!shader) {
        throw new Error(`HighPerfRenderer could not allocate the ${label} shader.`);
      }
      shaders.set(key, shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };
    const describe = (shader, kind, name) => (
      gl.getShaderParameter(shader, gl.COMPILE_STATUS)
        ? null
        : `HighPerfRenderer "${name}" ${kind} shader compilation failed: ${gl.getShaderInfoLog(shader) || 'no compiler diagnostic'}`
    );
    try {
      for (const [name, vsSource, fsSource] of specs) {
        if (!POINT_PROGRAM_NAMES.includes(name)) {
          throw new TypeError(
            `HighPerfRenderer shader program name must be one of ${POINT_PROGRAM_NAMES.join(', ')}; received ${String(name)}.`
          );
        }
        const vertexShader = compile(gl.VERTEX_SHADER, vsSource, `"${name}" vertex`);
        const fragmentShader = compile(gl.FRAGMENT_SHADER, fsSource, `"${name}" fragment`);
        const program = gl.createProgram();
        if (!program) {
          throw new Error(`HighPerfRenderer could not allocate the "${name}" shader program.`);
        }
        programs[name] = program;
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
      }
      // One wait, after every compile and link has been issued.
      for (const [name, vsSource, fsSource] of specs) {
        if (gl.getProgramParameter(programs[name], gl.LINK_STATUS)) continue;
        throw new Error(
          describe(shaders.get(`${gl.VERTEX_SHADER}:${vsSource}`), 'vertex', name)
            ?? describe(shaders.get(`${gl.FRAGMENT_SHADER}:${fsSource}`), 'fragment', name)
            ?? `HighPerfRenderer "${name}" shader link failed: ${gl.getProgramInfoLog(programs[name]) || 'no linker diagnostic'}`
        );
      }
    } catch (error) {
      operationError = error;
    }

    // Linked programs keep what they need: the shaders go now.
    this._queueShaderRetirement([...shaders.values()]);
    const shaderCleanupFailures = this._drainShaderRetirements();
    if (operationError || shaderCleanupFailures.length > 0) {
      this._queueProgramRetirement(Object.values(programs));
      const cleanupFailures = [...shaderCleanupFailures, ...this._drainProgramRetirements()];
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          operationError ? [operationError, ...cleanupFailures] : cleanupFailures,
          `HighPerfRenderer shader program setup failed with ${cleanupFailures.length} cleanup error(s).`
        );
      }
      throw operationError;
    }
    return programs;
  }

  _cacheUniformLocations(
    programName,
    program,
    target = this.uniformLocations
  ) {
    const gl = this.gl;
    const uniforms = {};

    const uniformNames = [
      'u_mvpMatrix', 'u_modelViewMatrix', 'u_projectionMatrix',
      'u_pointSize', 'u_sizeAttenuation', 'u_pointScale',
      'u_lightingStrength', 'u_fogNear', 'u_fogScale',
      'u_fogColor', 'u_lightDir', 'u_halfDir',
      // Sculpted lighting normalisation and coverage floor
      'u_invCenterShade', 'u_coverageFloor',
      // Alpha texture uniforms for efficient alpha-only updates
      'u_alphaTex', 'u_alphaLayout', 'u_useAlphaTex',
      // LOD index texture uniforms (for mapping LOD vertex to original index)
      'u_lodIndexTex', 'u_lodIndexLayout', 'u_useLodIndexTex'
    ];

    for (const name of uniformNames) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    uniforms.opaque = OPAQUE_POINT_PROGRAMS.has(programName);

    target.set(programName, uniforms);
    return uniforms;
  }

  /**
   * The program the active quality draws one point pass with. A pass at or
   * below DEPTH_TEST_DIMENSION_THRESHOLD runs with DEPTH_TEST disabled, and a
   * quality with a no-depth program uses it there (NO_DEPTH_POINT_PROGRAMS).
   * The two programs of a quality produce identical pixels for such a pass.
   *
   * @param {number} dimensionLevel - Dimension the pass draws.
   * @returns {string} Key into `programs` and `uniformLocations`.
   */
  _pointProgramName(dimensionLevel) {
    if (dimensionLevel <= DEPTH_TEST_DIMENSION_THRESHOLD) {
      const noDepthProgram = NO_DEPTH_POINT_PROGRAMS[this.activeQuality];
      if (noDepthProgram !== undefined) return noDepthProgram;
    }
    return this.activeQuality;
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

  _ensureGpuAllocationReporters() {
    if (!(this._gpuAllocationReporters instanceof Set)) {
      this._gpuAllocationReporters = new Set();
    }
    return this._gpuAllocationReporters;
  }

  /**
   * Include one collaborator's GPU allocations in `stats.gpuMemoryMB`.
   *
   * This renderer can only inventory handles it owns, but it is the sole
   * publisher of the GPU memory figure the stats display and the benchmark
   * panel show. A collaborator that allocates GPU storage against the same
   * context — the highlight renderer's per-view compact buffers are the case
   * this exists for — registers here so that figure describes the context
   * rather than one owner of it.
   *
   * The reporter is called with the inventory sink, which deduplicates by
   * WebGL handle, so a handle reported by two owners is still counted once.
   *
   * @param {(add: (handle: unknown, byteLength: number) => void) => void} reporter
   */
  registerGpuAllocationReporter(reporter) {
    if (typeof reporter !== 'function') {
      throw new TypeError(
        'HighPerfRenderer GPU allocation reporter must be a function.'
      );
    }
    this._ensureGpuAllocationReporters().add(reporter);
    this._refreshGpuMemoryStats();
  }

  /**
   * Stop including a collaborator's allocations. Its resources are its own to
   * retire; this only removes them from the reported total.
   *
   * @param {Function} reporter - The exact function passed to
   *   `registerGpuAllocationReporter`.
   * @returns {boolean} Whether a registration was removed.
   */
  unregisterGpuAllocationReporter(reporter) {
    const removed = this._ensureGpuAllocationReporters().delete(reporter);
    if (removed) this._refreshGpuMemoryStats();
    return removed;
  }

  /**
   * Recompute the reported GPU total after a collaborator's allocation changed.
   *
   * `getStats` publishes the last computed figure rather than recomputing on
   * read, because reads happen per stats tick and per benchmark frame. Every
   * owner therefore refreshes at its own publication points, exactly as the
   * alpha texture, the two point streams and the snapshot resources do. The
   * inventory is proportional to the number of views, dimensions and pending
   * retirements — never to the dataset.
   *
   * @returns {number} The recomputed total in bytes.
   */
  notifyGpuAllocationsChanged() {
    return this._refreshGpuMemoryStats();
  }

  _refreshGpuMemoryStats() {
    if (!this.stats) return 0;
    this._ensureRetirementOwnershipState();
    this._ensureGpuAllocationReporters();

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

    const livePointCount =
      Number.isSafeInteger(this.pointCount) && this.pointCount > 0
        ? this.pointCount
        : 0;
    add(
      this.buffers?.positions,
      knownOrDerived(
        this._positionGpuByteLength,
        positionByteLength(livePointCount, this.currentDimensionLevel)
      )
    );
    add(
      this.buffers?.colors,
      knownOrDerived(this._colorGpuByteLength, livePointCount * 4)
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

    // The live geometry's draw-order permutation texture.
    add(this._liveOrder?.texture, this._liveOrder?.byteLength);

    if (this.snapshotBuffers instanceof Map) {
      for (const snapshot of this.snapshotBuffers.values()) {
        add(
          snapshot?.colorOwner?.buffer ?? snapshot?.buffer,
          knownOrDerived(
            snapshot?.colorOwner?.byteLength ??
              snapshot?.bufferByteLength,
            Number.isSafeInteger(snapshot?.pointCount)
              ? Math.max(0, snapshot.pointCount) * 4
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
        add(geometry?.order?.texture, geometry?.order?.byteLength);
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
    // Collaborators that allocate against this context but hold their own
    // handles -- the highlight renderer's per-view compact buffers.
    for (const reporter of this._gpuAllocationReporters) {
      reporter(add);
    }

    let bytes = 0;
    for (const byteLength of allocations.values()) {
      bytes += byteLength;
    }
    this.stats.gpuMemoryMB = bytes / (1024 * 1024);
    return bytes;
  }

  _captureDataPublication() {
    return {
      vao: this.vao,
      buffers: this.buffers,
      positionGpuByteLength: this._positionGpuByteLength,
      colorGpuByteLength: this._colorGpuByteLength,
      alphaTexture: this._alphaTexture,
      alphaTextureByteLength: this._alphaTextureByteLength,
      alphaTexWidth: this._alphaTexWidth,
      alphaTexHeight: this._alphaTexHeight,
      alphaTexPlan: this._alphaTexPlan,
      alphaTexData: this._alphaTexData,
      alphaTexStagingData: this._alphaTexStagingData,
      useAlphaTexture: this._useAlphaTexture,
      currentAlphas: this._currentAlphas,
      liveOrder: this._liveOrder,
      liveColorOrder: this._liveColorOrder,
      spatialIndices: this.spatialIndices,
      perViewState: this._perViewState,
      currentDimensionLevel: this.currentDimensionLevel,
      liveGeometryGeneration: this._liveGeometryGeneration,
      pointCount: this.pointCount,
      positions: this._positions,
      colors: this._colors,
      firstRenderDone: this._firstRenderDone,
      boundingSphere: this._boundingSphere,
      colorsDirty: this._colorsDirty,
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
      positions: null,
      colors: null,
    };
    this._positionGpuByteLength = 0;
    this._colorGpuByteLength = 0;
    this._alphaTexture = null;
    this._alphaTextureByteLength = 0;
    this._alphaTexWidth = 0;
    this._alphaTexHeight = 0;
    this._alphaTexPlan = null;
    this._alphaTexData = null;
    this._alphaTexStagingData = null;
    this._alphaDirtyRows = null;
    this._alphaUploadRegions = null;
    this._useAlphaTexture = false;
    this._currentAlphas = null;
    this._liveOrder = null;
    this._liveColorOrder = null;
    this.spatialIndices = new Map();
    this._perViewState = new Map();
    this.currentDimensionLevel = 3;
    this._liveGeometryGeneration = 0;
    this.pointCount = 0;
    this._positions = null;
    this._colors = null;
    this._firstRenderDone = false;
    this._boundingSphere = null;
    this._colorsDirty = false;
    this._validatedSpatialIndices = new WeakSet();
  }

  _restoreDataPublication(publication) {
    this.vao = publication.vao;
    this.buffers = publication.buffers;
    this._positionGpuByteLength =
      publication.positionGpuByteLength ?? 0;
    this._colorGpuByteLength = publication.colorGpuByteLength ?? 0;
    this._alphaTexture = publication.alphaTexture;
    this._alphaTextureByteLength =
      publication.alphaTextureByteLength ?? 0;
    this._alphaTexWidth = publication.alphaTexWidth;
    this._alphaTexHeight = publication.alphaTexHeight;
    this._alphaTexPlan = publication.alphaTexPlan ?? null;
    this._alphaTexData = publication.alphaTexData;
    this._alphaTexStagingData =
      publication.alphaTexStagingData ?? null;
    this._useAlphaTexture = publication.useAlphaTexture;
    this._currentAlphas = publication.currentAlphas;
    this._liveOrder = publication.liveOrder ?? null;
    this._liveColorOrder = publication.liveColorOrder ?? null;
    this.spatialIndices = publication.spatialIndices;
    this._perViewState = publication.perViewState;
    this.currentDimensionLevel = publication.currentDimensionLevel;
    this._liveGeometryGeneration =
      publication.liveGeometryGeneration;
    this.pointCount = publication.pointCount;
    this._positions = publication.positions;
    this._colors = publication.colors;
    this._firstRenderDone = publication.firstRenderDone;
    this._boundingSphere = publication.boundingSphere;
    this._colorsDirty = publication.colorsDirty;
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

    const publishedPointCount = publication.pointCount ?? 0;
    add(
      buffers,
      publication.buffers?.positions,
      Number.isSafeInteger(publication.positionGpuByteLength)
        ? publication.positionGpuByteLength
        : positionByteLength(
          publishedPointCount,
          publication.currentDimensionLevel
        )
    );
    add(
      buffers,
      publication.buffers?.colors,
      Number.isSafeInteger(publication.colorGpuByteLength)
        ? publication.colorGpuByteLength
        : publishedPointCount * 4
    );
    add(vertexArrays, publication.vao);
    // The live draw order's permutation texture.
    add(
      textures,
      publication.liveOrder?.texture,
      publication.liveOrder?.byteLength
    );
    // Explicit handle lists (a draw-order texture retired on its own).
    for (const entry of Array.isArray(publication.textures) ? publication.textures : []) {
      add(textures, entry?.handle, entry?.byteLength);
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

  /**
   * A live position VBO that snapshot geometry borrows changes owner instead of
   * being deleted when its publication retires: the pool record that borrows it
   * becomes its sole owner and deletes it when its last snapshot goes.
   *
   * @param {Object} publication
   * @returns {Object} The publication, without a borrowed position VBO.
   * @private
   */
  _transferBorrowedLivePositionBuffer(publication) {
    const positionBuffer = publication?.buffers?.positions ?? null;
    if (
      positionBuffer === null ||
      !(this._snapshotGeometryPools instanceof Map)
    ) {
      return publication;
    }
    let borrowed = false;
    for (const geometry of this._snapshotGeometryPools.values()) {
      if (
        geometry?.borrowsLivePositionBuffer === true &&
        geometry.positionBuffer === positionBuffer
      ) {
        geometry.borrowsLivePositionBuffer = false;
        // The store keeps its draw order, so its permutation goes with it.
        geometry.order = publication.liveOrder ?? null;
        borrowed = true;
      }
    }
    if (!borrowed) return publication;
    return {
      ...publication,
      buffers: { ...publication.buffers, positions: null },
      liveOrder: null,
    };
  }

  _queueDataRetirement(publication) {
    this._ensureRetirementOwnershipState();
    const retirement = this._createDataRetirement(
      this._transferBorrowedLivePositionBuffer(publication)
    );
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
          // GPU memory was released: a tree build refused for memory may
          // succeed now (`_requestSpatialIndex`).
          this._releaseEpoch = (this._releaseEpoch ?? 0) + 1;
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
    // VAOs retain buffer references, including their element-array binding.
    // Every pending VAO, of every retirement, is deleted before any buffer:
    // a buffer evicted later (a retained geometry) can be referenced by a VAO
    // an earlier retirement still holds, so the order is global, not per
    // retirement. While any VAO is still alive, no buffer or texture is
    // deleted; the retry deletes them once it is gone.
    const pending = Array.from(this._pendingDataRetirements);
    for (const retirement of pending) {
      drainEntries(
        retirement.vertexArrays,
        'deleteVertexArray',
        'isVertexArray'
      );
    }
    const vertexArraysAlive = pending.some(retirement =>
      retirement.vertexArrays.some(entry => entry.handle !== null)
    );
    for (const retirement of pending) {
      if (!vertexArraysAlive) {
        drainEntries(retirement.buffers, 'deleteBuffer', 'isBuffer');
        drainEntries(retirement.textures, 'deleteTexture', 'isTexture');
      }
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
    this._allocateGpu(`${owner} could not allocate its position buffer`, () => {
      this.gl.bufferData(
        this.gl.ARRAY_BUFFER,
        geometry.positions,
        this.gl.STATIC_DRAW
      );
    });
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
    let sourceDimension;
    const sourceIsLive = exactSourceViewId === 'live';
    if (sourceIsLive) {
      generation = this._liveGeometryGeneration;
      expectedPositions = this._positions;
      sourceDimension = this.currentDimensionLevel;
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
      sourceDimension = sourceSnapshot.dimensionLevel;
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
      if (
        !this.buffers.positions ||
        this._positionGpuByteLength !== sourcePositions.byteLength
      ) {
        throw new Error(
          'HighPerfRenderer live geometry has no exact position VBO to share.'
        );
      }
      // The live generation already is this geometry, on the CPU and on the
      // GPU. Copying it cost the snapshot a second array and a second VBO of
      // the same coordinates: 4 bytes per axis per point twice over, 240 MB
      // for one kept view of a 10,000,000-point 3D embedding.
      geometry = {
        generation,
        // Components per point of `positions` (the embedding dimension).
        dimension: sourceDimension,
        positions: sourcePositions,
        positionBuffer: this.buffers.positions,
        positionBufferByteLength: this._positionGpuByteLength,
        borrowsLivePositionBuffer: true,
        // The borrowed store's order is the live view's (`_liveOrder`).
        order: null,
        refCount: 0,
        retained: false,
        lastUsed: performance.now(),
        spatialIndices: new Map(),
      };
      this._snapshotGeometryPools.set(generation, geometry);
    } else if (
      geometry.positions.length !== sourcePositions.length ||
      geometry.dimension !== sourceDimension ||
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
    geometry.retained = false;
    return geometry;
  }

  /**
   * The geometry of one representation's positions for a snapshot: the live
   * geometry when the live view shows the same positions, a pooled geometry
   * (shown by another kept view, or retained since none shows it) when one
   * holds them, else a new one. Views of one representation therefore share
   * one position VBO and one spatial tree; only a representation no view has
   * shown recently is uploaded.
   *
   * @param {Float32Array} positions
   * @param {number} dimension
   * @returns {Object} The acquired pool record (its refCount includes this use).
   * @private
   */
  _acquireSnapshotGeometryForPositions(positions, dimension) {
    this._ensureGeometryOwnershipState();
    if (
      positions === this._positions &&
      dimension === this.currentDimensionLevel &&
      Number.isSafeInteger(this._liveGeometryGeneration) &&
      this._liveGeometryGeneration > 0
    ) {
      return this._acquireSnapshotGeometryFromSource('live', positions);
    }
    const pooled = this._findPooledGeometry(positions, dimension);
    if (pooled !== null) {
      this._ensureSnapshotGeometryGpuOwner(pooled);
      pooled.refCount += 1;
      pooled.retained = false;
      return pooled;
    }
    return this._acquireIndependentSnapshotGeometry(positions, dimension);
  }

  /**
   * The pooled geometry holding exactly these positions, or null.
   * @private
   */
  _findPooledGeometry(positions, dimension) {
    if (!(this._snapshotGeometryPools instanceof Map)) return null;
    for (const geometry of this._snapshotGeometryPools.values()) {
      if (geometry.positions === positions && geometry.dimension === dimension) {
        return geometry;
      }
    }
    return null;
  }

  /**
   * GPU bytes kept for geometries no view shows: twice the largest geometry a
   * view shows now, between 64 MiB and 768 MiB, so switching back to a
   * representation shown a moment ago costs no upload and no tree build,
   * while a dataset near the device limit keeps nothing extra.
   * @private
   */
  _geometryRetentionBudget() {
    let largest = Number.isSafeInteger(this._positionGpuByteLength)
      ? this._positionGpuByteLength
      : 0;
    for (const geometry of this._snapshotGeometryPools?.values() ?? []) {
      if (geometry.refCount > 0) {
        largest = Math.max(largest, geometry.positionBufferByteLength ?? 0);
      }
    }
    const MIB = 1024 * 1024;
    return Math.min(768 * MIB, Math.max(64 * MIB, 2 * largest));
  }

  /**
   * Drop retained geometry built over one positions array (its CPU copy was
   * evicted, so the geometry could never be matched again).
   *
   * @param {Float32Array} positions
   * @returns {number} Bytes freed.
   */
  releaseRetainedGeometryFor(positions) {
    let freed = 0;
    for (const geometry of [...(this._snapshotGeometryPools?.values() ?? [])]) {
      if (geometry.positions === positions && geometry.refCount === 0) {
        freed += this._evictGeometryRecord(geometry);
      }
    }
    if (freed > 0) this._drainDataRetirements();
    return freed;
  }

  /**
   * Bytes of position buffers held by geometries no view shows.
   * @returns {number}
   */
  getRetainedGeometryBytes() {
    let bytes = 0;
    for (const geometry of this._snapshotGeometryPools?.values() ?? []) {
      if (geometry.refCount === 0 && geometry.borrowsLivePositionBuffer !== true) {
        bytes += geometry.positionBufferByteLength ?? 0;
        if (geometry.order?.texture) bytes += geometry.order.byteLength;
      }
    }
    return bytes;
  }

  /**
   * Evict geometries no view shows, least recently used first, until their
   * bytes plus `headroomBytes` fit the retention budget (`Infinity` evicts
   * every one). Called before any large allocation, so retention never costs
   * a dataset its maximum cell count, and after any geometry is retained.
   *
   * @param {number} [headroomBytes=0]
   * @returns {number} Bytes freed.
   */
  evictRetainedGeometry(headroomBytes = 0) {
    if (!(this._snapshotGeometryPools instanceof Map)) return 0;
    const retained = [...this._snapshotGeometryPools.values()]
      .filter(geometry => geometry.refCount === 0)
      .sort((left, right) => (left.lastUsed ?? 0) - (right.lastUsed ?? 0));
    const evictAll = headroomBytes === Infinity;
    const budget = evictAll
      ? 0
      : Math.max(0, this._geometryRetentionBudget() - headroomBytes);
    // Kept colour stores share the budget and go first: they are the
    // cheaper to rebuild.
    let held = this.getRetainedGeometryBytes() + this.getKeptColorBytes();
    let freed = 0;
    if (held > budget) {
      const colorFreed = this._evictKeptColorStores(evictAll ? Infinity : held - budget);
      held -= colorFreed;
      freed += colorFreed;
    }
    for (const geometry of retained) {
      if (!evictAll && held <= budget) break;
      const bytes = this._evictGeometryRecord(geometry);
      held -= bytes;
      freed += bytes;
    }
    if (freed > 0) this._drainDataRetirements();
    return freed;
  }

  /**
   * Remove one unshown geometry from the pool and queue its buffer for
   * deletion (a buffer the live view uses stays the live view's).
   * @returns {number} Bytes queued for deletion.
   * @private
   */
  _evictGeometryRecord(geometry) {
    this._snapshotGeometryPools.delete(geometry.generation);
    geometry.spatialIndices = new Map();
    geometry.retained = false;
    if (geometry.borrowsLivePositionBuffer === true || geometry.positionBuffer === null) {
      return 0;
    }
    const orderBytes = geometry.order?.texture ? geometry.order.byteLength : 0;
    this._retireDrawOrderRecord(geometry.order ?? null);
    geometry.order = null;
    const bytes = (geometry.positionBufferByteLength ?? 0) + orderBytes;
    this._queueDataRetirement({
      buffers: { positions: geometry.positionBuffer, colors: null },
      positionGpuByteLength: geometry.positionBufferByteLength ?? 0,
      pointCount: 0,
    });
    geometry.positionBuffer = null;
    geometry.positionBufferByteLength = 0;
    return bytes;
  }

  _acquireIndependentSnapshotGeometry(sourcePositions, dimension) {
    this._ensureGeometryOwnershipState();
    const generation = this._allocateGeometryGeneration();
    const geometry = {
      generation,
      dimension,
      // Adopted, not copied: a published positions array is never written.
      positions: sourcePositions,
      positionBuffer: null,
      positionBufferByteLength: 0,
      borrowsLivePositionBuffer: false,
      // The draw order its store holds (null: source order).
      order: null,
      refCount: 1,
      retained: false,
      lastUsed: performance.now(),
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
    return spatialIndex;
  }

  _publishPooledSnapshotSpatialIndex(
    geometryGeneration,
    positions,
    dimensionLevel,
    needsLOD,
    spatialIndex,
    replace = false
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
    if (existing !== undefined && existing !== spatialIndex && !replace) {
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
    if (geometry.refCount === 0 && geometry.positionBuffer === null) {
      // Nothing was uploaded for it (a publication that failed before its
      // upload, or one that never drew): there is nothing worth keeping.
      this._snapshotGeometryPools.delete(snapshot.geometryGeneration);
      return null;
    }
    if (geometry.refCount === 0) {
      // No view shows this representation now. Its position buffer and trees
      // stay retained, within the retention budget, so showing it again costs
      // no upload and no rebuild; the budget evicts the least recently used.
      geometry.retained = true;
      geometry.lastUsed = performance.now();
      this.evictRetainedGeometry();
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
      owner.byteLength !== owner.pointCount * 4 ||
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

  /**
   * The draw order a geometry's position store holds, or null for source
   * order. A geometry the live view shows holds the live store's order.
   *
   * @param {object} geometry - A pool record.
   * @returns {object|null}
   * @private
   */
  _geometryDrawOrder(geometry) {
    return this._geometryOrderRecord(geometry)?.drawOrder ?? null;
  }

  /**
   * The draw-order record (order plus permutation texture) of a geometry's
   * position store, or null for source order.
   *
   * @param {object} geometry - A pool record.
   * @returns {object|null}
   * @private
   */
  _geometryOrderRecord(geometry) {
    if (geometry.generation === this._liveGeometryGeneration) {
      return this._liveOrder ?? null;
    }
    return geometry.order ?? null;
  }

  _createSnapshotColorOwner(buffer, byteLength, drawOrder = null) {
    if (
      !buffer ||
      !Number.isSafeInteger(byteLength) ||
      byteLength !== this.pointCount * 4
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
      // The draw order the colours are stored in (null: source order).
      order: drawOrder,
    };
  }

  _retainSnapshotColorOwner(owner) {
    if (
      !owner ||
      !owner.buffer ||
      !Number.isSafeInteger(owner.byteLength) ||
      !Number.isSafeInteger(owner.pointCount) ||
      owner.pointCount < 0 ||
      owner.byteLength !== owner.pointCount * 4 ||
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
      owner.byteLength !== owner.pointCount * 4 ||
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
    // A retiring view takes the colour stores it kept with it.
    if (releaseColor && releaseVao && snapshot?.colorCache instanceof Map) {
      this._clearKeptColorStores(snapshot.colorCache);
    }
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
              ? snapshot.pointCount * 4
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
    if (!(positions instanceof Float32Array)) {
      throw new TypeError(
        'HighPerfRenderer positions must be a Float32Array.'
      );
    }
    if (!(colors instanceof Uint8Array)) {
      throw new TypeError('HighPerfRenderer colors must be an RGBA Uint8Array.');
    }
    requireWordAlignedColors(colors);
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
          key !== 'alphaValues'
      )
    ) {
      throw new TypeError(
        'HighPerfRenderer load options accept exactly dimensionLevel and optional alphaValues.'
      );
    }
    const dimensionLevel = requireDimensionLevel(
      options.dimensionLevel,
      'HighPerfRenderer loadData dimensionLevel'
    );
    // Positions carry exactly the embedding's components per point, so the
    // published dimension is also the position stride.
    const pointCount = requirePositionArray(
      positions,
      dimensionLevel,
      'HighPerfRenderer positions',
      { allowEmpty: true }
    );
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
    // Refuse, before anything is allocated, only a dataset the device cannot
    // address at all: per-point textures are linear textures, so this is the
    // layer capacity (`MAX_TEXTURE_SIZE^2 x MAX_ARRAY_TEXTURE_LAYERS`, at
    // least 2^34 points), not a fixed size.
    planLinearTextureFor(gl, pointCount);
    const alphaValues = Object.hasOwn(options, 'alphaValues')
      ? options.alphaValues
      : null;
    if (alphaValues !== null) {
      if (
        !(alphaValues instanceof Uint8Array) ||
        alphaValues.length !== pointCount
      ) {
        throw new TypeError(
          `HighPerfRenderer alphaValues must be a Uint8Array with exactly ${pointCount} entries.`
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

    // A new dataset: geometry retained for the previous one is stale, and its
    // memory belongs to this upload. So is a re-order in progress.
    this._clearKeptColorStores(this._liveColorCache);
    this.evictRetainedGeometry(Infinity);
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

      // The streams go up in source order; a tree LOD or culling needs is
      // built off the main thread when the view first draws, and the store
      // adopts its order then.
      this._boundingSphere = this._computeBoundingSphere(
        positions,
        dimensionLevel
      );
      this._createPointStreams(positions, colors, dimensionLevel);
      this._createAlphaTexture(this.pointCount);
      if (alphaValues !== null) {
        this.updateAlphas(alphaValues);
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
        this._restoreDataPublication(previousPublication);
        cleanupErrors.push(
          ...this._retireDataPublication(rejectedPublication)
        );
      }
      try {
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
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

  _getOrBuildSpatialIndexForDimension(
    dim,
    forceReplacement,
    needsLOD = this._needsLodResources(-1),
    prebuiltTree = null,
    prebuiltOrder = null
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
    // The live positions hold exactly the live dimension's components, so
    // only that dimension's tree can be built over them.
    if (dim !== this.currentDimensionLevel) {
      throw new Error(
        `HighPerfRenderer live positions are ${this.currentDimensionLevel}D; ` +
        `a ${dim}D spatial index cannot be built over them.`
      );
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
        cached.pointCount === this.pointCount
      ) {
        if (!needsLOD || spatialIndexHasLod(cached)) {
          return cached;
        }
        // A tree without levels where they are needed is replaced by one
        // built with them (its draw order is banded, so it is a new order).
        console.log(`[HighPerfRenderer] Replacing the ${dim}D spatial index with one carrying LOD levels...`);
      } else {
        console.log(`[HighPerfRenderer] Spatial index for ${dim}D is stale, rebuilding...`);
      }
    } else if (cached !== null) {
      console.log(
        `[HighPerfRenderer] Replacing the exact ${dim}D spatial index...`
      );
    }

    // A tree built off the main thread was announced by its request.
    const announce = prebuiltTree === null;
    if (announce) {
      requireLodBuildHeapHeadroom(
        this.pointCount,
        needsLOD,
        `HighPerfRenderer ${dim}D live view`
      );
    }
    // Build a complete CPU candidate off-state. The prior exact CPU/GPU
    // generation remains authoritative until both candidate stages succeed.
    const notifications = getNotificationCenter();
    const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
    const cellCount = this.pointCount;
    const notifId = announce
      ? notifications.startCalculation(
        `Building ${dim}D ${treeNames[dim]} for live view (${cellCount.toLocaleString()} cells)`,
        'spatial'
      )
      : null;

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
          prebuiltTree,
          prebuiltOrder,
        }
      );

      // Publishing the tree is the whole publication: the live store adopts
      // its draw order at the next render (`_ensureStoreDrawOrder`), and until
      // then still holds a complete, consistent order of its own.
      const candidateSpatialIndices = new Map(previousSpatialIndices);
      candidateSpatialIndices.set(dim, candidateSpatialIndex);
      this.spatialIndices = candidateSpatialIndices;
      candidateCpuPublished = true;

      if (announce) {
        settleCalculationNotification(
          notifications,
          notifId,
          'completeCalculation',
          `${dim}D ${treeNames[dim]} ready (live view)`,
          performance.now() - startTime
        );
      }
      return candidateSpatialIndex;
    } catch (error) {
      if (!candidateCpuPublished) {
        this.spatialIndices = previousSpatialIndices;
      }
      if (announce) {
        settleCalculationNotification(
          notifications,
          notifId,
          'failCalculation',
          `${dim}D ${treeNames[dim]} failed: ${describeError(error)}`
        );
      }
      throw error;
    }
  }

  /**
   * Show another representation in the live view: replace only its
   * positions, keeping the published colours, transparency and alpha texture
   * (they are per cell, not per representation). The live dimension is the
   * dimension of the published positions, so this is the only way the live
   * view changes dimension.
   *
   * The position stream and spatial tree come from the representation's
   * pooled geometry when a kept view shows it or it was shown lately (no
   * upload, no tree build); otherwise the positions are uploaded once. The
   * geometry the live view leaves is retained (see `evictRetainedGeometry`),
   * so switching back is as cheap. Everything else is one transactional
   * publication like `loadData`: a failure restores the previous one exactly.
   *
   * @param {Float32Array} positions - New positions (n_points * dimensionLevel)
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

    const expectedLength = this.pointCount * newDimLevel;
    if (positions.length !== expectedLength) {
      throw new RangeError(
        `HighPerfRenderer updatePositions expected ${expectedLength} floats, received ${positions.length}.`
      );
    }

    if (!(this._colors instanceof Uint8Array) || !this.buffers?.colors) {
      throw new Error(
        'HighPerfRenderer cannot update positions before exact color data is published.'
      );
    }
    if (positions === this._positions && newDimLevel === this.currentDimensionLevel) {
      return this.stats;
    }
    const gl = this.gl;
    requireCleanWebGLState(gl, 'HighPerfRenderer position publication');
    this._ensureGeometryOwnershipState();
    const previous = this._captureDataPublication();
    const donor = this._findPooledGeometry(positions, newDimLevel);
    let candidateInstalled = false;
    let uploadedPositionBuffer = null;
    const startTime = performance.now();
    try {
      this._installCandidateDataPublication(previous);
      candidateInstalled = true;
      // Per-cell state moves to the candidate unchanged.
      this.buffers.colors = previous.buffers.colors;
      this._colorGpuByteLength = previous.colorGpuByteLength;
      this._alphaTexture = previous.alphaTexture;
      this._alphaTextureByteLength = previous.alphaTextureByteLength;
      this._alphaTexWidth = previous.alphaTexWidth;
      this._alphaTexHeight = previous.alphaTexHeight;
      this._alphaTexPlan = previous.alphaTexPlan;
      this._alphaTexData = previous.alphaTexData;
      this._alphaTexStagingData = previous.alphaTexStagingData;
      this._useAlphaTexture = previous.useAlphaTexture;
      this._currentAlphas = previous.currentAlphas;
      this._colors = previous.colors;
      this._colorsDirty = previous.colorsDirty;
      this._firstRenderDone = previous.firstRenderDone;
      this.pointCount = previous.pointCount;
      this.currentDimensionLevel = newDimLevel;
      this._positions = positions;

      const donorTree = donor?.spatialIndices?.get(newDimLevel) ?? null;
      if (donorTree !== null && donorTree.positions === positions) {
        // The tree follows the renderer's colour generation, as on recolour.
        donorTree.colors = this._colors;
        const fullDetailLevel = donorTree.lodLevels?.at(-1);
        if (fullDetailLevel?.isFullDetail === true) fullDetailLevel.colors = this._colors;
        this.spatialIndices = new Map([[newDimLevel, donorTree]]);
      }
      // New positions go up in source order. A tree LOD or culling needs is
      // built off the main thread when the view next draws.
      if (donor !== null && donor.positionBuffer !== null) {
        // The donor's store, in the draw order it holds.
        this.buffers.positions = donor.positionBuffer;
        this._positionGpuByteLength = donor.positionBufferByteLength;
        this._liveGeometryGeneration = donor.generation;
        this._liveOrder = donor.order ?? null;
      } else {
        uploadedPositionBuffer = gl.createBuffer();
        if (!uploadedPositionBuffer) {
          throw new Error('HighPerfRenderer could not allocate the point position buffer.');
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, uploadedPositionBuffer);
        this._liveOrder = null;
        this._positionGpuByteLength = this._allocateVertexStore(
          positions,
          gl.STATIC_DRAW,
          this.pointCount,
          'HighPerfRenderer point-position upload'
        );
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        this.buffers.positions = uploadedPositionBuffer;
        this._liveGeometryGeneration = donor !== null
          ? donor.generation
          : this._allocateGeometryGeneration();
      }
      // The moved colour store keeps the order it holds; the next render
      // regathers it into the new geometry's order when they differ.
      this._liveColorOrder = previous.liveColorOrder ?? null;
      gl.bindVertexArray(this.vao);
      this._bindPointAttributes(this.buffers.positions, this.buffers.colors, newDimLevel);
      gl.bindVertexArray(null);
      this._boundingSphere = donor?.boundingSphere
        ?? this._computeBoundingSphere(positions, newDimLevel);
      requireCleanWebGLState(gl, 'HighPerfRenderer candidate position publication');
      Object.assign(this.stats, {
        lastFrameTime: 0,
        fps: 0,
        visiblePoints: 0,
        lodLevel: -1,
        drawCalls: 0,
        frustumCulled: false,
        cullPercent: 0,
      });
    } catch (error) {
      const cleanupErrors = [];
      if (candidateInstalled) {
        const rejected = this._captureDataPublication();
        this._restoreDataPublication(previous);
        // Only what the candidate created is retired: the moved colour and
        // alpha owners and a donor's buffer belong to their owners.
        cleanupErrors.push(...this._retireDataPublication({
          ...rejected,
          // A donor's order stays the donor's.
          liveOrder: uploadedPositionBuffer === null ? null : rejected.liveOrder,
          buffers: { positions: uploadedPositionBuffer, colors: null },
          positionGpuByteLength: uploadedPositionBuffer === null ? 0 : rejected.positionGpuByteLength,
          colorGpuByteLength: 0,
          alphaTexture: null,
          alphaTextureByteLength: 0,
        }));
      }
      try {
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.getError();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `HighPerfRenderer position publication failed and rollback reported ${cleanupErrors.length} cleanup error(s).`
        );
      }
      throw error;
    }

    // Commit. The donor's buffer is now the live view's; its pool record
    // borrows it back (and owns it again when the live view moves on).
    if (donor !== null) {
      if (donor.positionBuffer === null) {
        donor.positionBuffer = uploadedPositionBuffer;
        donor.positionBufferByteLength = this._positionGpuByteLength;
      }
      // Its store's order is the live view's while it lends the store.
      donor.order = null;
      donor.borrowsLivePositionBuffer = true;
      donor.retained = false;
      donor.lastUsed = performance.now();
      donor.boundingSphere = this._boundingSphere;
    }
    this._retireDataPublication(this._retainLeavingLiveGeometry(previous));
    // Kept views of the geometry the live view left draw it with their own
    // tree now (the pooled one); those of the geometry it adopted draw from
    // the live owner. Both start from fresh per-view state.
    for (const [snapshotId, snapshot] of this.snapshotBuffers) {
      if (
        snapshot.geometryGeneration === previous.liveGeometryGeneration ||
        snapshot.geometryGeneration === this._liveGeometryGeneration
      ) {
        this.invalidateViewState(snapshotId);
      }
    }
    this._refreshGpuMemoryStats();
    console.log(
      `[HighPerfRenderer] Live view shows ${newDimLevel}D positions ` +
      `(${donor !== null ? 'cached geometry' : 'uploaded'}) in ${(performance.now() - startTime).toFixed(1)}ms`
    );
    return this.stats;
  }

  /**
   * The geometry the live view leaves stays available: a pool record that
   * borrows its buffer takes it over (with the live tree); otherwise a new
   * retained record owns buffer and tree. Returns the publication to retire
   * without the moved colour/alpha owners and without that buffer.
   *
   * @param {Object} previous - The captured previous publication.
   * @returns {Object}
   * @private
   */
  _retainLeavingLiveGeometry(previous) {
    const positionBuffer = previous.buffers?.positions ?? null;
    const dimension = previous.currentDimensionLevel;
    const tree = previous.spatialIndices?.get(dimension) ?? null;
    let record = null;
    for (const geometry of this._snapshotGeometryPools.values()) {
      if (geometry.positionBuffer === positionBuffer && positionBuffer !== null) {
        record = geometry;
        break;
      }
    }
    if (record === null && positionBuffer !== null && previous.positions instanceof Float32Array) {
      record = {
        generation: previous.liveGeometryGeneration,
        dimension,
        positions: previous.positions,
        positionBuffer,
        // A publication records its exact store size; its positions' byte
        // length is the same store when the record is older than that field.
        positionBufferByteLength: Number.isSafeInteger(previous.positionGpuByteLength)
          ? previous.positionGpuByteLength
          : previous.positions.byteLength,
        borrowsLivePositionBuffer: false,
        refCount: 0,
        retained: true,
        lastUsed: performance.now(),
        spatialIndices: new Map(),
      };
      this._snapshotGeometryPools.set(record.generation, record);
    }
    if (record !== null) {
      record.borrowsLivePositionBuffer = false;
      record.boundingSphere = previous.boundingSphere;
      // The store keeps the order it holds, and its permutation with it.
      record.order = previous.liveOrder ?? null;
      if (tree !== null && tree.positions === record.positions) {
        record.spatialIndices.set(dimension, tree);
      }
      if (record.refCount === 0) {
        record.retained = true;
        record.lastUsed = performance.now();
      }
    }
    const retirement = {
      ...previous,
      liveOrder: record === null ? previous.liveOrder : null,
      buffers: { positions: record === null ? positionBuffer : null, colors: null },
      colorGpuByteLength: 0,
      alphaTexture: null,
      alphaTextureByteLength: 0,
      // The trees move to the pool; only GPU LOD projections retire.
      spatialIndices: new Map(),
    };
    queueMicrotask(() => {
      if (!this._disposed) this.evictRetainedGeometry();
    });
    return retirement;
  }

  /**
   * Publish the vertex streams for one dataset generation, in source order:
   * each store is allocated straight from the published typed array -- the
   * Float32 positions with exactly `dimension` components per point, and the
   * RGBA8 colors -- so nothing is repacked, padded or copied on the client.
   * A tree's order is adopted when a frame first needs it (`_ensureStoreDrawOrder`). The color
   * stream is `DYNAMIC_DRAW` because a recolor rewrites it in place;
   * positions change only through a new publication.
   *
   * @param {Float32Array} positions
   * @param {Uint8Array} colors
   * @param {number} dimension - Components per position (1, 2 or 3).
   */
  _createPointStreams(positions, colors, dimension) {
    const gl = this.gl;
    const pointCount = positions.length / dimension;
    this._liveOrder = null;

    if (!this.buffers.positions) {
      this.buffers.positions = gl.createBuffer();
      if (!this.buffers.positions) {
        throw new Error(
          'HighPerfRenderer could not allocate the point position buffer.'
        );
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.positions);
    this._positionGpuByteLength = this._allocateVertexStore(
      positions,
      gl.STATIC_DRAW,
      pointCount,
      'HighPerfRenderer point-position upload'
    );

    if (!this.buffers.colors) {
      this.buffers.colors = gl.createBuffer();
      if (!this.buffers.colors) {
        throw new Error(
          'HighPerfRenderer could not allocate the point color buffer.'
        );
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.colors);
    this._colorGpuByteLength = this._allocateVertexStore(
      colors,
      gl.DYNAMIC_DRAW,
      pointCount,
      'HighPerfRenderer point-color upload'
    );
    this._liveColorOrder = null;

    gl.bindVertexArray(this.vao);
    this._bindPointAttributes(
      this.buffers.positions,
      this.buffers.colors,
      dimension
    );
    gl.bindVertexArray(null);
    requireCleanWebGLState(
      gl,
      'HighPerfRenderer point-stream publication'
    );
  }


  /**
   * Allocate the bound `ARRAY_BUFFER` store, either from `data` (a typed array,
   * uploaded as-is) or as `data` zero-filled bytes.
   *
   * WebGL 2 leaves the previous store untouched when the allocation is
   * refused, so a refusal is reported here, naming the dataset, before any
   * caller writes into a store that does not exist.
   *
   * @param {ArrayBufferView|number} data
   * @param {number} usage
   * @param {number} pointCount
   * @param {string} owner
   * @returns {number} the accepted store's byte length
   */
  _allocateVertexStore(data, usage, pointCount, owner) {
    const gl = this.gl;
    const byteLength = typeof data === 'number' ? data : data.byteLength;
    this._allocateGpu(
      `${owner} could not allocate ${byteLength.toLocaleString()} bytes of point storage for ${pointCount.toLocaleString()} points`,
      () => gl.bufferData(gl.ARRAY_BUFFER, data, usage)
    );
    return byteLength;
  }

  /**
   * Say which views are presented this frame. A kept view that is not
   * presented is dormant: its colour store and R8 texture are the first
   * thing released when an allocation is refused, and come back when it is
   * next drawn or edited.
   *
   * @param {string[]} viewIds - Read, not copied: the caller's per-frame
   *   list, rewritten in place each frame.
   */
  setPresentedViews(viewIds) {
    if (!Array.isArray(viewIds)) {
      throw new TypeError('HighPerfRenderer presented views must be an array of view ids.');
    }
    this._presentedViewIds = viewIds;
  }

  /** @private */
  _isPresentedView(viewId) {
    return this._presentedViewIds === null || this._presentedViewIds.includes(viewId);
  }

  /**
   * Whether every presented view draws from its final geometry.
   *
   * With culling or level of detail on, a view's spatial tree (with levels
   * when LOD needs them) is built off the main thread and lands in a later
   * frame, and the store it serves then adopts the tree's draw order: a GPU
   * re-order of positions and colours, with the error reads a publication
   * owes. A benchmark window that contains that landing measures the
   * landing, not the configuration, so the benchmark starts a window only
   * once this holds. Reads the state and asks for nothing: no tree is
   * requested and no order built.
   *
   * @returns {boolean}
   */
  isPresentedGeometrySettled() {
    if (!this._needsSpatialIndex(-1)) return true;
    const needsLOD = this._needsLodResources(-1);
    const drawsFinalGeometry = (index, positions, dimensionLevel, order) => (
      index !== null &&
      index !== undefined &&
      index.positions === positions &&
      index.dimensionLevel === dimensionLevel &&
      (!needsLOD || spatialIndexHasLod(index)) &&
      index.drawOrder !== null &&
      order !== null &&
      order !== undefined &&
      order.drawOrder === index.drawOrder
    );
    if (
      this._positions instanceof Float32Array &&
      this.pointCount > 0 &&
      this._isPresentedView('live')
    ) {
      const index = this.spatialIndices.get(this.currentDimensionLevel) ?? null;
      if (index === null || index.pointCount !== this.pointCount) return false;
      if (!drawsFinalGeometry(index, this._positions, this.currentDimensionLevel, this._liveOrder)) {
        return false;
      }
    }
    for (const snapshot of this.snapshotBuffers.values()) {
      if (!this._isPresentedView(snapshot.id) || snapshot.storesReleased === true) continue;
      // A kept view of the live geometry draws from the live store, above.
      if (this._snapshotUsesLiveGeometry(snapshot)) continue;
      const geometry = this._snapshotGeometryPools?.get(snapshot.geometryGeneration) ?? null;
      if (geometry === null || geometry.positions !== snapshot.positions) return false;
      const index = snapshot.spatialIndex ??
        geometry.spatialIndices.get(
          this._snapshotSpatialIndexKey(snapshot.dimensionLevel, needsLOD)
        ) ??
        null;
      if (!drawsFinalGeometry(index, snapshot.positions, snapshot.dimensionLevel, geometry.order)) {
        return false;
      }
    }
    return true;
  }

  /** @private */
  _isDormantSnapshot(snapshot) {
    return (
      !this._isPresentedView(snapshot.id) &&
      snapshot.id !== this._snapshotInOperation &&
      snapshot.storesReleased !== true &&
      snapshot.colorOwner?.refCount === 1
    );
  }

  /**
   * Bytes the dormant kept views' colour stores and R8 textures hold.
   * @returns {number}
   * @private
   */
  _dormantSnapshotStoreBytes() {
    let bytes = 0;
    if (!(this.snapshotBuffers instanceof Map)) return 0;
    for (const snapshot of this.snapshotBuffers.values()) {
      if (!this._isDormantSnapshot(snapshot)) continue;
      bytes += snapshot.colorOwner.byteLength + (snapshot.alphaTextureByteLength ?? 0);
    }
    return bytes;
  }

  /**
   * Release the colour store, kept colour stores and R8 texture of every
   * dormant kept view (not presented, not being worked on, its store its
   * own). The view keeps its colours and alpha bytes, its geometry and its
   * vertex array, so `_restoreSnapshotStores` rebuilds exactly what it drew.
   * @returns {number} Bytes released.
   * @private
   */
  _releaseDormantSnapshotStores() {
    if (!(this.snapshotBuffers instanceof Map)) return 0;
    const gl = this.gl;
    let released = 0;
    for (const snapshot of this.snapshotBuffers.values()) {
      if (!this._isDormantSnapshot(snapshot)) continue;
      released += snapshot.colorOwner.byteLength + (snapshot.alphaTextureByteLength ?? 0);
      if (snapshot.colorCache instanceof Map) this._clearKeptColorStores(snapshot.colorCache);
      // A vertex array keeps a deleted buffer alive while it references it.
      gl.bindVertexArray(snapshot.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 4, 0);
      gl.bindVertexArray(null);
      this._queueSnapshotRetirement(snapshot, {
        releaseAlpha: true,
        releaseColor: true,
        releaseGeometry: false,
        releaseVao: false,
      });
      snapshot.colorOwner = null;
      snapshot.buffer = null;
      snapshot.bufferByteLength = 0;
      snapshot.alphaTexture = null;
      snapshot.alphaTextureByteLength = 0;
      snapshot.storesReleased = true;
      this._drainSnapshotRetirements(snapshot.id);
    }
    if (released > 0) {
      console.log(
        `[HighPerfRenderer] Released ${(released / 1024 / 1024).toFixed(1)} MB of colour and alpha stores of views not shown; they are rebuilt when shown.`
      );
      this._refreshGpuMemoryStats();
    }
    return released;
  }

  /**
   * Rebuild a released kept view's colour store (in its geometry's current
   * order) and R8 texture from its own colours and alpha bytes, and point
   * its vertex array at the new store. A failure leaves it released.
   * @private
   */
  _restoreSnapshotStores(snapshot) {
    if (snapshot.storesReleased !== true) return;
    const gl = this.gl;
    const label = `HighPerfRenderer view "${snapshot.id}" restore`;
    const order = this._snapshotUsesLiveGeometry(snapshot)
      ? (this._liveOrder ?? null)
      : (this._getSnapshotGeometryRecord(snapshot.geometryGeneration, snapshot.positions).order ?? null);
    const previousOperation = this._snapshotInOperation;
    this._snapshotInOperation = snapshot.id;
    const alpha = { alphaTexture: null, alphaTextureByteLength: 0 };
    let buffer = null;
    let byteLength = 0;
    try {
      buffer = gl.createBuffer();
      if (!buffer) throw new Error(`${label} could not allocate its colour store.`);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      byteLength = this._uploadSnapshotColors(buffer, snapshot.colors, label, order);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      this._uploadNewSnapshotAlphaTexture(snapshot.alphaTexData, snapshot.alphaTexPlan, label, alpha);
      gl.bindVertexArray(snapshot.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 4, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    } catch (error) {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      if (buffer) this._retireBuffer(buffer, byteLength);
      if (alpha.alphaTexture) {
        this._queueDataRetirement({ textures: [{ handle: alpha.alphaTexture, byteLength: alpha.alphaTextureByteLength }] });
      }
      this._drainDataRetirements();
      this._snapshotInOperation = previousOperation;
      throw error;
    }
    snapshot.colorOwner = this._createSnapshotColorOwner(buffer, byteLength, order?.drawOrder ?? null);
    snapshot.buffer = buffer;
    snapshot.bufferByteLength = byteLength;
    snapshot.alphaTexture = alpha.alphaTexture;
    snapshot.alphaTextureByteLength = alpha.alphaTextureByteLength;
    snapshot.storesReleased = false;
    this._snapshotInOperation = previousOperation;
    this._refreshGpuMemoryStats();
  }

  /**
   * Run one GPU allocation on the target its caller bound (`allocate` may
   * run twice; the binding is restored before the second run). Memory kept only for speed -- geometry of representations no
   * view shows, colour stores kept for switching back -- never costs an
   * allocation: when the driver refuses one while any is kept, all of it is
   * released and the allocation runs once more. Nothing is evicted while an
   * allocation fits, so a switch back stays free whenever memory allows.
   *
   * The caller enters with an empty error queue.
   *
   * @param {string} refusal - The message when it cannot be allocated.
   * @param {() => void} allocate
   * @private
   */
  _allocateGpu(refusal, allocate) {
    const gl = this.gl;
    allocate();
    let code = gl.getError();
    // Only a refusal for memory is retried. Any other code is a defect (this
    // allocation's, or an earlier unchecked write's: sub-uploads into
    // accepted storage read nothing back) and is reported, not retried.
    if (
      code === gl.OUT_OF_MEMORY &&
      !(typeof gl.isContextLost === 'function' && gl.isContextLost()) &&
      this.getRetainedGeometryBytes() + this.getKeptColorBytes() +
        this._dormantSnapshotStoreBytes() > 0
    ) {
      const buffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
      const texture = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
      const vertexArray = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
      this.evictRetainedGeometry(Infinity);
      this._releaseDormantSnapshotStores();
      gl.bindVertexArray(vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      allocate();
      code = gl.getError();
    }
    if (code === gl.NO_ERROR) return;
    if (typeof gl.isContextLost === 'function' && gl.isContextLost()) throw contextLostError(refusal);
    throw new RangeError(`${refusal} (WebGL error 0x${code.toString(16)}).`);
  }

  /**
   * Point the bound vertex array's two point attributes at their streams:
   * location 0 is tightly packed Float32 with `dimension` components per
   * point, location 1 tightly packed RGBA8 normalized to [0, 1].
   *
   * The shader declares `a_position` as a `vec3`; WebGL fills the components
   * a 1-D or 2-D stream does not supply with 0, which is exactly the value of
   * an axis the embedding does not have.
   *
   * @param {WebGLBuffer} positionBuffer
   * @param {WebGLBuffer} colorBuffer
   * @param {number} dimension - Components per position (1, 2 or 3).
   */
  _bindPointAttributes(positionBuffer, colorBuffer, dimension) {
    const gl = this.gl;
    bindPositionAttribute(gl, positionBuffer, dimension);
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 4, 0);
  }

  /**
   * Create or resize the alpha texture for efficient alpha-only updates.
   * Uses R8 format (1 byte per point), so an alpha change touches neither vertex stream.
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
      this._alphaTexPlan = null;
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

    // A linear texture holds any count the engine can allocate (layers of
    // MAX_TEXTURE_SIZE rows), so no point count is refused here.
    const candidatePlan = planLinearTextureFor(gl, pointCount);
    const candidateWidth = candidatePlan.width;
    const candidateHeight = candidatePlan.rows;

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
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, candidateTexture);

      // R8 (single channel, 1 byte per texel), nearest-filtered for exact
      // texel fetch.
      this._withNeutralTextureUnpackState(
        1,
        'HighPerfRenderer candidate alpha texture',
        () => {
          this._allocateGpu('HighPerfRenderer could not allocate the alpha texture', () => {
            allocateLinearTexture(gl, gl.R8, candidatePlan);
          });
          writeLinearTextureRows(gl, candidatePlan, gl.RED, gl.UNSIGNED_BYTE, candidateData, 1);
          requireCleanWebGLState(
            gl,
            'HighPerfRenderer candidate alpha-texture upload'
          );
        }
      );
      candidateTextureByteLength = candidatePlan.texels;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      requireCleanWebGLState(
        gl,
        'HighPerfRenderer alpha-texture publication'
      );
    } catch (error) {
      try {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
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
    this._alphaTexPlan = candidatePlan;
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

  /**
   * Publish full-row regions of an accepted alpha texture (the live view's or
   * a snapshot's), laid out as `plan`.
   *
   * `regions` is an interleaved `(rowStart, rowCount)` Int32Array holding
   * `regionCount` pairs in strictly increasing, non-overlapping row order. All
   * of them are sent inside one unpack transaction; rows written into accepted
   * storage read no error back (`requireLiveContext`).
   *
   * Rows are complete, so `UNPACK_ROW_LENGTH` stays neutral and the source
   * range for a region is exactly `rowStart * width` through
   * `(rowStart + rowCount) * width` — addressed with `srcOffset` rather than a
   * subarray so a publication allocates nothing.
   */
  _uploadAlphaRegions(texture, plan, data, regions, regionCount, label) {
    const gl = this.gl;
    const width = plan?.width;
    const height = plan?.rows;
    if (
      !texture ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      !(data instanceof Uint8Array) ||
      data.length !== width * height ||
      !(regions instanceof Int32Array) ||
      !Number.isSafeInteger(regionCount) ||
      regionCount <= 0 ||
      regions.length < regionCount * 2
    ) {
      throw new Error(
        'HighPerfRenderer alpha texture upload received incomplete exact state.'
      );
    }
    let previousRowEnd = 0;
    for (let index = 0; index < regionCount; index++) {
      const rowStart = regions[index * 2];
      const rowCount = regions[index * 2 + 1];
      if (
        rowCount <= 0 ||
        rowStart < previousRowEnd ||
        rowStart + rowCount > height
      ) {
        throw new Error(
          'HighPerfRenderer alpha texture upload received an invalid row region.'
        );
      }
      previousRowEnd = rowStart + rowCount;
    }
    // Rows of an accepted texture: no allocation, so nothing to read back.
    requireLiveContext(gl, `${label} preflight`);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    try {
      this._withNeutralTextureUnpackState(
        1,
        label,
        () => {
          for (let index = 0; index < regionCount; index++) {
            const rowStart = regions[index * 2];
            const rowCount = regions[index * 2 + 1];
            writeLinearTextureRows(
              gl, plan, gl.RED, gl.UNSIGNED_BYTE, data, 1, rowStart, rowStart + rowCount
            );
          }
          requireLiveContext(gl, label);
        }
      );
    } finally {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    }
  }


  /**
   * Update the alpha texture with new alpha values.
   *
   * The accepted R8 owner is never overwritten before WebGL accepts the new
   * generation. A one-byte-per-texel staging owner keeps transient failures
   * retryable without retaining another Float32 point array.
   *
   * Only the rows whose bytes moved are sent. Every other byte of the resident
   * texture is, by the comparison that decided it, already the byte this
   * generation would have written, so a region-addressed publication and a
   * whole-texture one leave the same image.
   *
   * @param {Uint8Array} alphas - Point transparency, exactly 0 or 1 a point
   * @returns {boolean} Whether any accepted R8 byte moved. Point visibility is
   *   defined on exactly these bytes (`alpha-visibility.js`: a point is visible
   *   iff `Math.round(alpha * 255) >= 3`), so `false` certifies that no
   *   consumer of the visibility boundary can have changed.
   */
  _updateAlphaTexture(alphas) {
    const width = this._alphaTexWidth;
    const height = this._alphaTexHeight;
    if (
      !(alphas instanceof Uint8Array) ||
      alphas.length !== this.pointCount ||
      !this._alphaTexture ||
      !(this._alphaTexData instanceof Uint8Array) ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      this._alphaTexData.length !== width * height
    ) {
      throw new Error(
        'HighPerfRenderer alpha texture update received incomplete exact state.'
      );
    }
    const n = this.pointCount;
    const accepted = this._alphaTexData;
    const requiredSize = accepted.length;
    let candidate = this._alphaTexStagingData;
    if (
      !(candidate instanceof Uint8Array) ||
      candidate.length !== requiredSize
    ) {
      candidate = new Uint8Array(requiredSize);
      candidate.fill(255);
    }
    // Scratch owned by this method alone. Both are re-derived from scratch on
    // every call and sized against the current texture, so they carry nothing
    // across a texture replacement and stay out of the publication transaction.
    let dirtyRows = this._alphaDirtyRows;
    if (!(dirtyRows instanceof Uint8Array) || dirtyRows.length !== height) {
      dirtyRows = new Uint8Array(height);
      this._alphaDirtyRows = dirtyRows;
    } else {
      dirtyRows.fill(0);
    }
    let regions = this._alphaUploadRegions;
    if (!(regions instanceof Int32Array) || regions.length !== height * 2) {
      regions = new Int32Array(height * 2);
      this._alphaUploadRegions = regions;
    }

    // Row-major traversal. It visits exactly the same indices in exactly the
    // same order as a flat scan — same first rejection, same bytes written —
    // and records which rows moved without a division per point.
    let dirtyRowCount = 0;
    for (let y = 0; y < height; y++) {
      const rowStart = y * width;
      const rowEnd = rowStart + width < n ? rowStart + width : n;
      let rowChanged = false;
      for (let i = rowStart; i < rowEnd; i++) {
        const value = alphas[i];
        // One comparison pair rejects NaN, infinities and out-of-range values.
        if (!(value >= 0 && value <= 1)) {
          throw new RangeError(
            `HighPerfRenderer alpha value at index ${i} must be finite and in [0, 1]; received ${String(value)}.`
          );
        }
        const byte = Math.round(value * 255);
        candidate[i] = byte;
        rowChanged ||= byte !== accepted[i];
      }
      if (rowChanged) {
        dirtyRows[y] = 1;
        dirtyRowCount++;
      }
    }

    if (dirtyRowCount === 0) {
      this._alphaTexStagingData = candidate;
      this._useAlphaTexture = true;
      return false;
    }

    const regionCount = collectAlphaUploadRegions(dirtyRows, height, regions);

    try {
      this._uploadAlphaRegions(
        this._alphaTexture,
        this._alphaTexPlan,
        candidate,
        regions,
        regionCount,
        'HighPerfRenderer alpha-value publication'
      );
    } catch (publicationError) {
      try {
        // Exactly the regions the failed publication could have touched, so
        // restoring them restores the whole accepted image.
        this._uploadAlphaRegions(
          this._alphaTexture,
          this._alphaTexPlan,
          accepted,
          regions,
          regionCount,
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
    return true;
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
    requireWordAlignedColors(colors);

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

    // Publication is deferred to the next render, so back-to-back recolors
    // upload once. Stores kept for other orders hold the old colours.
    this._colorsDirty = true;
    this._clearKeptColorStores(this._liveColorCache);
  }

  /**
   * Publish one exact per-point alpha generation.
   *
   * @param {Uint8Array} alphas - Point transparency, exactly 0 or 1 a point.
   * @returns {boolean} Whether the accepted R8 generation moved. Callers that
   *   only care about *visibility* — which cells the highlight packer, the KNN
   *   traversal and the category selectors admit — may skip their invalidation
   *   when this is `false`: those predicates are exactly `Math.round(alpha *
   *   255) >= MIN_VISIBLE_ALPHA_BYTE`, so an unmoved byte is an unmoved
   *   visibility. A newly created texture reports `true` regardless, because a
   *   fresh R8 owner is a new generation whatever its bytes hold.
   */
  updateAlphas(alphas) {
    this._assertOperational('update alpha values');
    if (!(alphas instanceof Uint8Array)) {
      throw new TypeError('HighPerfRenderer alpha values must be a Uint8Array.');
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
      return false;
    }

    // Use alpha texture for efficient updates (avoids full buffer rebuild)
    // This is ~16x faster: uploading N bytes vs N*16 bytes
    let createdTexture = false;
    if (!this._alphaTexture) {
      this._createAlphaTexture(this.pointCount);
      createdTexture = true;
    }
    const changed = this._updateAlphaTexture(alphas);
    this._currentAlphas = alphas;
    return createdTexture || changed;
  }

  /**
   * Adopt an equivalent caller-private Uint8 owner after its R8 generation
   * has already been accepted. This performs no GPU work and exists so the
   * viewer can sever aliases to mutable application-state arrays.
   */
  _adoptCurrentAlphasOwner(alphas) {
    if (
      !(alphas instanceof Uint8Array) ||
      alphas.length !== this.pointCount
    ) {
      throw new TypeError(
        'HighPerfRenderer alpha owner must be one exact Uint8 point array.'
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
    if (dim !== this.currentDimensionLevel) return;
    // The flag clears only after the publication returns, so a rejected
    // upload stays dirty and is retried whole on the next flush.
    if (this._colorsDirty) {
      this._publishLiveColors();
    }
  }

  /**
   * Rewrite the live color stream in place from the live colors, in the
   * order the live positions are stored in.
   *
   * The store's size is fixed by the publication, so this is one upload of
   * 4 bytes a point -- straight into the store in source order, or into a
   * transient texture the GPU gathers into the store in a draw order (see
   * `_writeOrderedColors`) -- with no reallocation, and the position stream
   * is not touched.
   */
  _publishLiveColors() {
    const gl = this.gl;
    const colors = this._colors;
    if (
      !this.buffers?.colors ||
      !(colors instanceof Uint8Array) ||
      colors.byteLength !== this.pointCount * 4 ||
      this._colorGpuByteLength !== colors.byteLength
    ) {
      throw new Error(
        'HighPerfRenderer full-detail color publication has no exact accepted color store.'
      );
    }
    // The store is accepted; a gather allocates through `_allocateGpu`.
    requireLiveContext(gl, 'HighPerfRenderer full-detail color publication preflight');
    const drawOrder = this._liveOrder?.drawOrder ?? null;
    this._writeOrderedColors(
      this.buffers.colors,
      colors,
      this._liveOrder,
      'HighPerfRenderer full-detail color publication'
    );
    this._liveColorOrder = drawOrder;
    this._colorsDirty = false;
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

  _computeBoundingSphere(positions, dimension) {
    if (positions.length === 0) return { center: [0, 0, 0], radius: 1 };

    const {
      minX, maxX, minY, maxY, minZ, maxZ
    } = HighPerfRenderer.computeBoundsFromPositions(positions, dimension);

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

    if (!this.buffers.positions || !this.buffers.colors) {
      throw new Error('HighPerfRenderer point buffers are unavailable.');
    }

    const dimensionLevel = params.dimensionLevel;

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
    // Whether this pass draws into a multisampled target, which decides how an
    // opaque program antialiases its edge (`enterOpaquePointBlending`).
    this._pointPassMultisampled = params.multisampled === true;

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
    // A tree still building in a worker leaves the view at full detail (or
    // with the tree it has) until it lands; nothing is built here.
    const needsSpatialIndex = this._needsSpatialIndex(forceLOD);
    const spatialIndex = needsSpatialIndex
      ? this._liveSpatialIndexForDraw(dimensionLevel, this._needsLodResources(forceLOD))
      : null;
    // Select LOD level based on whether LOD is enabled
    // When LOD is disabled, forceLODLevel is ignored - only params.forceLOD is respected
    // This ensures disabling LOD always returns to full detail (unless explicitly overridden per-render)
    let lodLevel;
    viewState.lodConverging = false;
    if (this.useAdaptiveLOD) {
      // LOD enabled: Priority is this.forceLODLevel > params.forceLOD > adaptive
      lodLevel = this.forceLODLevel >= 0 ? this.forceLODLevel : forceLOD;
      if (lodLevel < 0 && spatialIndex) {
        // Pass per-view lastLodLevel for hysteresis (prevents oscillation per-view)
        lodLevel = spatialIndex.getLODLevel(
          cameraDistance,
          viewState.lastLodLevel,
          dimensionLevel,
          overrideBounds
        );
        viewState.lodConverging = spatialIndex.getLODLevel(
          cameraDistance,
          lodLevel,
          dimensionLevel,
          overrideBounds
        ) !== lodLevel;
      }
    } else {
      // LOD disabled: only respect explicit per-render forceLOD, otherwise full detail
      lodLevel = forceLOD >= 0 ? forceLOD : -1;
    }

    if (lodLevel >= 0 && !spatialIndexHasLod(spatialIndex)) {
      // The levels are still building: full detail until they land.
      lodLevel = -1;
    }
    if (
      lodLevel >= 0 &&
      (!Number.isInteger(lodLevel) || !spatialIndex?.lodLevels?.[lodLevel])
    ) {
      throw new RangeError(
        `HighPerfRenderer LOD level ${String(lodLevel)} is unavailable for ${dimensionLevel}D view "${viewId}".`
      );
    }

    // The live geometry is stored in the draw order of its tree whenever the
    // tree exists (a hover tree counts too): the order alone draws a 10M
    // full-detail frame about 3x faster in 2D and in 3D. The store adopts
    // that order in this frame, before it draws.
    const orderTree = spatialIndex ?? this._currentLiveTree();
    const order = orderTree !== null
      ? this._ensureStoreDrawOrder(LIVE_STORE, orderTree)
      : this._liveOrder;
    const ordered = spatialIndex !== null && order?.drawOrder === spatialIndex.drawOrder;
    if (!ordered) lodLevel = -1;
    // Always update per-view LOD level for highlight rendering and other
    // consumers: the level actually drawn.
    viewState.lastLodLevel = lodLevel;
    this._ensureLiveColorsInOrder();
    const cull = this.useFrustumCulling && ordered;
    if (!cull) {
      this.stats.frustumCulled = false;
      this.stats.cullPercent = 0;
    }

    // For 2D data, disable depth testing to prevent draw-order artifacts:
    // every point has the same depth.
    const disableDepth = dimensionLevel <= DEPTH_TEST_DIMENSION_THRESHOLD;
    let frustumChanged = false;
    let operationError = null;
    try {
      if (cull) {
        frustumChanged = this._prepareFrustumCache(
          mvpMatrix,
          viewState,
          dimensionLevel,
          overrideBounds
        );
      }
      if (disableDepth) {
        gl.disable(gl.DEPTH_TEST);
      }
      this._drawPoints({
        params,
        viewState,
        vao: this.vao,
        pointCount: this.pointCount,
        order,
        tree: spatialIndex,
        lodLevel,
        cull,
        frustumChanged,
        alphaTexture: this._useAlphaTexture ? this._alphaTexture : null,
        alphaPlan: this._alphaTexPlan,
        label: `HighPerfRenderer live view "${viewId}"`,
      });
    } catch (error) {
      operationError = error;
      if (frustumChanged) {
        // The accepted frustum key must not outlive a failed draw.
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
    settlePointDraw(
      operationError,
      restorationError,
      'HighPerfRenderer live render'
    );
    viewState.lastDimensionLevel = dimensionLevel;

    this._publishFrameTiming(viewState, frameStart);
    return returnStats ? this.getStats(viewId) : undefined;
  }

  /**
   * Validate each exact spatial owner once, live or snapshot. A
   * renderer-global boolean would incorrectly trust same-sized replacement
   * trees and other dimensions.
   */
  _validateSpatialOwnerOnce(spatialIndex) {
    if (!(this._validatedSpatialIndices instanceof WeakSet)) {
      this._validatedSpatialIndices = new WeakSet();
    }
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
   * Publish the per-draw point uniforms every point pass shares. A location the
   * active quality's shader does not declare is null and skipped. The fog range
   * is the renderer-wide value the current frame computed. The products the
   * shaders used to form per vertex or per fragment (model-view matrix, point
   * scale, Blinn half vector) are derived here once per draw into renderer
   * scratch, see `writePointShaderFrame`.
   */
  _applyPointUniforms(
    gl,
    uniforms,
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
    lightDir
  ) {
    const frame = this._pointShaderFrame ??= {
      modelView: new Float32Array(16),
      halfDir: new Float32Array(3),
      invCenterShade: 1,
    };
    const pointScale = writePointShaderFrame(
      frame,
      viewMatrix,
      modelMatrix,
      lightDir,
      viewportHeight,
      fov
    );
    if (uniforms.u_mvpMatrix !== null) gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    if (uniforms.u_modelViewMatrix !== null) gl.uniformMatrix4fv(uniforms.u_modelViewMatrix, false, frame.modelView);
    if (uniforms.u_projectionMatrix !== null && projectionMatrix) gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
    if (uniforms.u_pointSize !== null) gl.uniform1f(uniforms.u_pointSize, pointSize);
    if (uniforms.u_sizeAttenuation !== null) gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    if (uniforms.u_pointScale !== null) gl.uniform1f(uniforms.u_pointScale, pointScale);
    if (uniforms.u_lightingStrength !== null) gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    writeFogUniforms(
      gl,
      uniforms.u_fogNear,
      uniforms.u_fogScale,
      fogDensity,
      this.fogNear,
      this.fogFar
    );
    if (uniforms.u_fogColor !== null) gl.uniform3fv(uniforms.u_fogColor, fogColor);
    if (uniforms.u_lightDir !== null) gl.uniform3fv(uniforms.u_lightDir, lightDir);
    if (uniforms.u_halfDir !== null) gl.uniform3fv(uniforms.u_halfDir, frame.halfDir);
    if (uniforms.u_invCenterShade !== null) gl.uniform1f(uniforms.u_invCenterShade, frame.invCenterShade);
    if (uniforms.opaque === true) {
      // Undone by restorePointDrawBaseline(..., true) after the draw.
      const multisampled = this._pointPassMultisampled === true;
      enterOpaquePointBlending(gl, multisampled);
      if (uniforms.u_coverageFloor !== null) {
        gl.uniform1f(uniforms.u_coverageFloor, multisampled ? 0 : 0.5);
      }
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

  // ==========================================================================
  // DRAW ORDER
  //
  // A geometry's points are stored on the GPU in the draw order of the tree
  // over them (`SpatialIndex#drawOrder`): grouped by LOD band, then by tree
  // leaf, then by ascending source index. Every reduced LOD level is a prefix
  // of that order and every run of tree leaves is one contiguous range per
  // band, so a reduced level is one `drawArrays` prefix and frustum culling
  // draws node ranges -- no per-point index ever leaves the CPU after the
  // order is built. Neighbouring points are also neighbours in memory and on
  // screen, which is what makes the stored order faster to draw at full
  // detail than source order (10M points: 18 ms against 68 ms on Chromium,
  // 15 against 57 on WebKit, 14 against 57 on Firefox).
  //
  // Positions are per geometry, so each geometry carries its order; colours
  // are per view and are gathered into the order of the geometry the view
  // draws. Alpha stays in source order, read through the order's R32UI
  // permutation texture (`u_useLodIndexTex`). Before a tree exists a geometry
  // is stored in source order and draws at full detail only.
  // ==========================================================================

  /**
   * Create the permutation texture of one draw order: texel `k` holds the
   * source index of the point stored in slot `k`.
   *
   * @param {Readonly<{indices: Uint32Array, pointCount: number}>} drawOrder
   * @param {string} owner
   * @returns {{drawOrder: object, texture: WebGLTexture, plan: object, byteLength: number}}
   * @private
   */
  _createDrawOrderRecord(drawOrder, owner) {
    const gl = this.gl;
    const indices = drawOrder?.indices;
    if (!(indices instanceof Uint32Array) || indices.length !== drawOrder.pointCount) {
      throw new TypeError(`${owner} requires an exact draw order.`);
    }
    const plan = planLinearTextureFor(gl, indices.length);
    const byteLength = plan.texels * Uint32Array.BYTES_PER_ELEMENT;
    // The allocation below is checked by `_allocateGpu`; the rows written
    // into it need no read-back.
    requireLiveContext(gl, `${owner} draw-order preflight`);
    const texture = gl.createTexture();
    if (!texture) {
      throw new Error(`${owner} could not allocate its draw-order texture.`);
    }
    try {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      this._withNeutralTextureUnpackState(4, `${owner} draw order`, () => {
        // Immutable storage: no zero-fill pass before the rows are written.
        this._allocateGpu(`${owner} could not allocate its draw-order texture`, () => {
          allocateLinearTexture(gl, gl.R32UI, plan);
        });
        writeLinearTextureRows(gl, plan, gl.RED_INTEGER, gl.UNSIGNED_INT, indices, 1);
      });
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      requireLiveContext(gl, `${owner} draw-order upload`);
    } catch (error) {
      try {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      } catch {
        // The retirement below remains authoritative.
      }
      this._queueDataRetirement({ textures: [{ handle: texture, byteLength }] });
      const failures = this._drainDataRetirements();
      if (failures.length > 0) {
        throw new AggregateError([error, ...failures], `${owner} draw-order upload failed with cleanup errors.`);
      }
      throw error;
    }
    return { drawOrder, texture, plan, byteLength };
  }

  /**
   * Queue one draw-order record's texture for deletion.
   * @param {object|null} record
   * @private
   */
  _retireDrawOrderRecord(record) {
    if (record === null || record === undefined || !record.texture) return;
    this._queueDataRetirement({
      textures: [{ handle: record.texture, byteLength: record.byteLength }],
    });
    record.texture = null;
    // Colour stores kept for this order can never be drawn again: no store
    // holds it any more.
    for (const [cache, drawOrder, entry] of this._keptColorStores()) {
      if (drawOrder !== record.drawOrder) continue;
      cache.delete(drawOrder);
      this._retireBuffer(entry.buffer, entry.byteLength);
    }
  }

  /** @private */
  _getPermuter() {
    this._permuter ??= new GpuPermuter(this.gl, (refusal, allocate) => this._allocateGpu(refusal, allocate));
    return this._permuter;
  }

  /**
   * Rewrite an RGBA8 colour store (already sized) with one view's colours in
   * the order of draw-order record `order`, or in source order when `order`
   * is null. A draw order is gathered on the GPU through its permutation
   * texture (`GpuPermuter`): the CPU uploads the source-order colours
   * once, as a source-order store would, and never reads them at random.
   *
   * @param {WebGLBuffer} buffer
   * @param {Uint8Array} colors - Word-aligned RGBA8, 4 bytes a point.
   * @param {{texture: WebGLTexture, width: number}|null} order
   * @param {string} owner
   * @private
   */
  _writeOrderedColors(buffer, colors, order, owner) {
    const gl = this.gl;
    requireOrderCoversColors(order, colors, owner);
    if (order === null) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      try {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, colors);
      } finally {
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
      }
    } else {
      this._getPermuter().writeWords(buffer, colorWordsOf(colors), order, 1);
    }
    requireLiveContext(gl, owner);
  }



  /**
   * The live tree of the live view's current positions, or null.
   * @returns {SpatialIndex|null}
   * @private
   */
  _currentLiveTree() {
    const tree = this.spatialIndices.get(this.currentDimensionLevel) ?? null;
    return tree !== null && tree.positions === this._positions ? tree : null;
  }

  /**
   * Bring one position store to `tree`'s draw order, in the frame that first
   * needs it: the permutation is uploaded, then the store's positions and
   * the colours of every view that draws it are gathered on the GPU
   * (`GpuPermuter`), in place, before the frame draws. The CPU only uploads
   * the source-order words; it never reads them at random.
   *
   * Returns the record the store holds now.
   *
   * @param {{kind: 'live'}|{kind: 'geometry', geometry: object}} store
   * @param {SpatialIndex} tree
   * @returns {object}
   * @private
   */
  _ensureStoreDrawOrder(store, tree) {
    const drawOrder = tree.ensureDrawOrder();
    const current = this._storeOrder(store);
    if (current?.drawOrder === drawOrder) return current;
    // One adoption a frame: when several trees land together (four panes of
    // four representations), each store adopts in its own frame instead of
    // all in one long frame. A deferred store draws as it is this frame.
    if (this._frameAdoptions !== undefined && this._frameAdoptions >= 1) {
      this.onAsyncTreeReady?.();
      return current;
    }
    if (this._frameAdoptions !== undefined) this._frameAdoptions += 1;
    return this._adoptDrawOrder(store, drawOrder);
  }

  /**
   * Start one frame (every pane): resets the per-frame adoption budget.
   */
  beginFrame() {
    this._frameAdoptions = 0;
    this._snapshotInOperation = null;
  }

  /** @private */
  _storeLabel(store) {
    return store.kind === 'live'
      ? 'HighPerfRenderer live draw order'
      : `HighPerfRenderer geometry ${store.geometry.generation} draw order`;
  }

  /**
   * Write one colour target's colours into `buffer` in `order`.
   * @private
   */
  _writeTargetColors(target, buffer, order, label) {
    this._writeOrderedColors(buffer, target.source, order, label);
  }

  /** @private */
  _storeOrder(store) {
    return store.kind === 'live' ? this._liveOrder : (store.geometry.order ?? null);
  }

  /**
   * The colour streams that must follow a store's order: the live colours
   * and every kept view of the live geometry for the live store; every kept
   * view of a pooled geometry for that geometry.
   *
   * @returns {Array<{key: object, source: Uint8Array, buffer: WebGLBuffer, byteLength: number}>}
   * @private
   */
  _colorTargetsOf(store) {
    const targets = [];
    if (store.kind === 'live') {
      targets.push({
        key: this,
        source: this._colors,
        buffer: this.buffers.colors,
        byteLength: this._colorGpuByteLength,
      });
    }
    for (const snapshot of this.snapshotBuffers.values()) {
      const onStore = store.kind === 'live'
        ? this._snapshotUsesLiveGeometry(snapshot)
        : snapshot.geometryGeneration === store.geometry.generation
          && !this._snapshotUsesLiveGeometry(snapshot);
      if (!onStore) continue;
      // A released view regathers when restored; a view not presented
      // regathers when next drawn (`_ensureSnapshotColorsInOrder`).
      if (snapshot.storesReleased === true || !this._isPresentedView(snapshot.id)) {
        continue;
      }
      const owner = this._ensureSnapshotColorOwner(snapshot);
      targets.push({
        key: owner,
        source: snapshot.colors,
        buffer: owner.buffer,
        byteLength: owner.byteLength,
      });
    }
    return targets;
  }

  /**
   * Re-order a store and every colour stream of its views in place, now.
   * Each stream records its own order as it is written, so a failure part
   * way leaves every stream consistent with the order it says it holds (a
   * colour store left behind is regathered by the next frame).
   * @private
   */
  _adoptDrawOrder(store, drawOrder) {
    const label = this._storeLabel(store);
    const previous = this._storeOrder(store);
    const record = this._createDrawOrderRecord(drawOrder, label);
    const positions = store.kind === 'live' ? this._positions : store.geometry.positions;
    const dimension = store.kind === 'live' ? this.currentDimensionLevel : store.geometry.dimension;
    const buffer = store.kind === 'live' ? this.buffers.positions : store.geometry.positionBuffer;
    const targets = this._colorTargetsOf(store);
    try {
      this._getPermuter().writeWords(
        buffer,
        new Uint32Array(positions.buffer, positions.byteOffset, positions.length),
        record,
        dimension
      );
      // A gather into the accepted position store: nothing to read back.
      requireLiveContext(this.gl, `${label} positions`);
    } catch (error) {
      this._retireDrawOrderRecord(record);
      this._drainDataRetirements();
      throw error;
    }
    if (store.kind === 'live') {
      this._liveOrder = record;
    } else {
      store.geometry.order = record;
    }
    this._retireDrawOrderRecord(previous);
    for (const target of targets) {
      this._writeTargetColors(target, target.buffer, record, label);
      if (target.key === this) {
        this._liveColorOrder = drawOrder;
        this._colorsDirty = false;
      } else {
        target.key.order = drawOrder;
      }
    }
    this._drainDataRetirements();
    this._refreshGpuMemoryStats();
    return record;
  }

  // ==========================================================================
  // COLOUR STORES KEPT PER DRAW ORDER
  //
  // A view's colours are stored in the draw order of the geometry it shows.
  // When a view switches to another representation, the store it leaves is
  // kept (keyed by that order) instead of being regathered, so switching
  // back costs no upload while the colours are unchanged. Kept stores count
  // against the retention budget with retained geometry
  // (`evictRetainedGeometry`) and are evicted first, least recently used
  // first; a recolour drops every store kept for the old colours.
  // ==========================================================================

  /**
   * Queue one buffer for deletion.
   * @private
   */
  _retireBuffer(handle, byteLength) {
    if (!handle) return;
    this._queueDataRetirement({
      buffers: { positions: handle, colors: null },
      positionGpuByteLength: byteLength,
      pointCount: 0,
    });
  }

  /**
   * Every kept colour store: `[cache, drawOrder, entry]` triples.
   * @private
   */
  _keptColorStores() {
    const out = [];
    const visit = cache => {
      if (!(cache instanceof Map)) return;
      for (const [drawOrder, entry] of cache) out.push([cache, drawOrder, entry]);
    };
    visit(this._liveColorCache);
    if (this.snapshotBuffers instanceof Map) {
      for (const snapshot of this.snapshotBuffers.values()) visit(snapshot.colorCache);
    }
    return out;
  }

  /**
   * Bytes of kept colour stores.
   * @returns {number}
   */
  getKeptColorBytes() {
    let bytes = 0;
    for (const [, , entry] of this._keptColorStores()) bytes += entry.byteLength;
    return bytes;
  }

  /**
   * Drop kept colour stores, least recently used first, until `bytes` are
   * freed (`Infinity`: all of them).
   * @returns {number} Bytes freed.
   * @private
   */
  _evictKeptColorStores(bytes) {
    const kept = this._keptColorStores()
      .sort((left, right) => left[2].lastUsed - right[2].lastUsed);
    let freed = 0;
    for (const [cache, drawOrder, entry] of kept) {
      if (freed >= bytes) break;
      cache.delete(drawOrder);
      this._retireBuffer(entry.buffer, entry.byteLength);
      freed += entry.byteLength;
    }
    return freed;
  }

  /**
   * Drop every store a cache keeps (the colours they hold were replaced).
   * @private
   */
  _clearKeptColorStores(cache) {
    if (!(cache instanceof Map) || cache.size === 0) return;
    for (const entry of cache.values()) this._retireBuffer(entry.buffer, entry.byteLength);
    cache.clear();
    this._drainDataRetirements();
  }

  /**
   * Swap a view's colour store for the one holding `source` in `drawOrder`:
   * a kept store when there is one, else a new store gathered now. The store
   * left is kept under its own order.
   *
   * @param {Map} cache - The view's kept stores.
   * @param {{buffer: WebGLBuffer, byteLength: number, order: object|null, source: Uint8Array}} current
   * @param {object|null} order - Draw-order record of the order wanted.
   * @param {string} label
   * @returns {WebGLBuffer} The store to draw with.
   * @private
   */
  _swapColorStore(cache, current, order, label) {
    const gl = this.gl;
    const now = performance.now();
    const drawOrder = order?.drawOrder ?? null;
    let entry = cache.get(drawOrder) ?? null;
    if (entry !== null && entry.source !== current.source) {
      cache.delete(drawOrder);
      this._retireBuffer(entry.buffer, entry.byteLength);
      entry = null;
    }
    // Keep the store being left, unless it already is the one wanted.
    cache.set(current.order, {
      buffer: current.buffer,
      byteLength: current.byteLength,
      source: current.source,
      lastUsed: now,
    });
    let buffer;
    if (entry !== null) {
      cache.delete(drawOrder);
      buffer = entry.buffer;
    } else {
      buffer = gl.createBuffer();
      if (!buffer) {
        cache.delete(current.order);
        throw new Error(`${label} could not allocate a colour store.`);
      }
      try {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        try {
          this._allocateVertexStore(current.byteLength, gl.DYNAMIC_DRAW, current.byteLength / 4, label);
        } finally {
          gl.bindBuffer(gl.ARRAY_BUFFER, null);
        }
        this._writeTargetColors({ source: current.source }, buffer, order, label);
      } catch (error) {
        cache.delete(current.order);
        this._retireBuffer(buffer, current.byteLength);
        this._drainDataRetirements();
        throw error;
      }
    }
    // Retention never exceeds its budget.
    this.evictRetainedGeometry();
    this._drainDataRetirements();
    return buffer;
  }

  /**
   * Make the live colour store follow the live position order.
   * @private
   */
  _ensureLiveColorsInOrder() {
    const drawOrder = this._liveOrder?.drawOrder ?? null;
    if (this._liveColorOrder === drawOrder && !this._colorsDirty) return;
    if (this._liveColorOrder !== drawOrder && !this._colorsDirty) {
      // The live view now shows another geometry: keep the store it leaves,
      // and draw with the one kept for this order (or a new one).
      const gl = this.gl;
      const buffer = this._swapColorStore(
        this._liveColorCache,
        {
          buffer: this.buffers.colors,
          byteLength: this._colorGpuByteLength,
          order: this._liveColorOrder,
          source: this._colors,
        },
        this._liveOrder,
        'HighPerfRenderer live colour store'
      );
      this.buffers = { ...this.buffers, colors: buffer };
      gl.bindVertexArray(this.vao);
      this._bindPointAttributes(this.buffers.positions, buffer, this.currentDimensionLevel);
      gl.bindVertexArray(null);
      this._liveColorOrder = drawOrder;
      return;
    }
    this._publishLiveColors();
  }

  /**
   * The draw-order record of the geometry a snapshot draws now: the live
   * store's for a snapshot of the live geometry, else its pooled geometry's,
   * re-ordered into `tree`'s order first when given.
   *
   * @param {object} snapshot
   * @param {SpatialIndex|null} tree
   * @returns {object|null}
   * @private
   */
  _ensureSnapshotDrawOrder(snapshot, tree) {
    if (this._snapshotUsesLiveGeometry(snapshot)) {
      return tree === null
        ? this._liveOrder
        : this._ensureStoreDrawOrder(LIVE_STORE, tree);
    }
    const geometry = this._getSnapshotGeometryRecord(snapshot.geometryGeneration, snapshot.positions);
    return tree === null
      ? geometry.order ?? null
      : this._ensureStoreDrawOrder({ kind: 'geometry', geometry }, tree);
  }

  /**
   * Make one snapshot's colour store follow the order of its geometry.
   * @param {object} snapshot
   * @param {object|null} order - The geometry's draw-order record.
   * @private
   */
  _ensureSnapshotColorsInOrder(snapshot, order) {
    const owner = this._ensureSnapshotColorOwner(snapshot);
    const drawOrder = order?.drawOrder ?? null;
    if ((owner.order ?? null) === drawOrder) return;
    if (!(snapshot.colorCache instanceof Map)) snapshot.colorCache = new Map();
    // The view now shows another geometry: keep the store it leaves, and
    // draw with the one kept for this order (or a new one).
    const gl = this.gl;
    const buffer = this._swapColorStore(
      snapshot.colorCache,
      {
        buffer: owner.buffer,
        byteLength: owner.byteLength,
        order: owner.order ?? null,
        source: snapshot.colors,
      },
      order,
      `HighPerfRenderer view "${snapshot.id}" colour store`
    );
    owner.buffer = buffer;
    owner.order = drawOrder;
    snapshot.buffer = buffer;
    gl.bindVertexArray(snapshot.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 4, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /**
   * Bind the source-order alpha texture and, when the points are stored in a
   * draw order, the permutation that maps a stored slot back to its source
   * index (texture unit 1); otherwise the dummy R32UI texture.
   *
   * @param {WebGL2RenderingContext} gl
   * @param {object} uniforms
   * @param {WebGLTexture|null} alphaTexture - null: per-vertex alpha.
   * @param {object|null} alphaPlan - Linear-texture layout of `alphaTexture`.
   * @param {object|null} order - Draw-order record of the drawn geometry.
   * @private
   */
  _bindPointAlpha(gl, uniforms, alphaTexture, alphaPlan, order) {
    // Both samplers always have a texture of their own type bound: a texture
    // whose fetch is skipped (u_use* off) still has to be complete.
    const alpha = alphaTexture ?? this._alphaTexture;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, alpha);
    if (uniforms.u_alphaTex !== null) gl.uniform1i(uniforms.u_alphaTex, 0);
    if (alphaTexture !== null) setLinearLayoutUniform(gl, uniforms.u_alphaLayout, alphaPlan);
    if (uniforms.u_useAlphaTex !== null) gl.uniform1i(uniforms.u_useAlphaTex, alphaTexture !== null ? 1 : 0);
    const permutation = alphaTexture !== null && order !== null ? order : null;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, permutation !== null ? permutation.texture : this._dummyLodIndexTexture);
    if (uniforms.u_lodIndexTex !== null) gl.uniform1i(uniforms.u_lodIndexTex, 1);
    if (permutation !== null) setLinearLayoutUniform(gl, uniforms.u_lodIndexLayout, permutation.plan);
    if (uniforms.u_useLodIndexTex !== null) {
      gl.uniform1i(uniforms.u_useLodIndexTex, permutation !== null ? 1 : 0);
    }
  }


  /**
   * Collect the runs of consecutive draw units (tree leaves, or coarse nodes
   * in 1D/2D) inside the frustum into the view's cull state, as
   * `[leafStart, leafEnd)` pairs in unit order. A subtree wholly inside is one
   * run, read from its node without visiting its units; a unit partly inside
   * is drawn whole.
   *
   * @param {object} cull - The view's cull state.
   * @param {object} root
   * @param {Float32Array[]} planes
   * @private
   */
  _collectVisibleLeafRuns(cull, root, planes) {
    let runs = cull.runs;
    let count = 0;
    let openStart = -1;
    let openEnd = -1;
    const stack = cull.stack;
    stack.length = 0;
    stack.push(root);
    while (stack.length > 0) {
      const node = stack.pop();
      const visibility = this._classifyNodeVisibility(node.bounds, planes);
      if (visibility === 'outside') continue;
      if (visibility === 'partial' && node.drawUnit !== true && node.children) {
        // Children are pushed in reverse so they pop in leaf order.
        for (let child = node.children.length - 1; child >= 0; child--) {
          if (node.children[child]) stack.push(node.children[child]);
        }
        continue;
      }
      if (node.leafStart === openEnd) {
        openEnd = node.leafEnd;
        continue;
      }
      if (openEnd > openStart) {
        if ((count + 1) * 2 > runs.length) {
          const grown = new Uint32Array(runs.length * 2);
          grown.set(runs);
          runs = grown;
        }
        runs[count * 2] = openStart;
        runs[count * 2 + 1] = openEnd;
        count++;
      }
      openStart = node.leafStart;
      openEnd = node.leafEnd;
    }
    if (openEnd > openStart) {
      if ((count + 1) * 2 > runs.length) {
        const grown = new Uint32Array(runs.length * 2);
        grown.set(runs);
        runs = grown;
      }
      runs[count * 2] = openStart;
      runs[count * 2 + 1] = openEnd;
      count++;
    }
    cull.runs = runs;
    cull.runCount = count;
  }

  /**
   * Turn the view's leaf runs into draw ranges for every band up to
   * `lastBand`, coarsened to the engine's range budget by bridging the gaps
   * that hide the fewest points (`SpatialIndex#writeDrawRanges`): drawing a
   * few points outside the frustum costs less than another draw call.
   *
   * @param {object} cull
   * @param {SpatialIndex} tree
   * @param {number} lastBand
   * @private
   */
  _writeCulledRanges(cull, tree, lastBand) {
    const cap = this._getMultiDraw() !== null ? MAX_CULLED_DRAW_RANGES_MULTI_DRAW : MAX_CULLED_DRAW_RANGES;
    if (cull.starts.length < cap) {
      cull.starts = new Int32Array(cap);
      cull.counts = new Int32Array(cap);
    }
    const { rangeCount, elementCount } = tree.writeDrawRanges(
      cull.runs, cull.runCount, lastBand, cull.starts, cull.counts, cap, cull
    );
    cull.rangeCount = rangeCount;
    cull.elementCount = elementCount;
    cull.band = lastBand;
  }

  /**
   * Draw one view's points from a vertex array holding them in `order`.
   *
   * Full detail without culling draws every stored point; a reduced level
   * draws the prefix the level admits; with culling, the leaf runs inside
   * the frustum are drawn as node ranges (one call through
   * `WEBGL_multi_draw`, else one `drawArrays` a range).
   *
   * @param {object} draw
   * @param {object} draw.params - The render contract.
   * @param {object} draw.viewState
   * @param {WebGLVertexArrayObject} draw.vao
   * @param {number} draw.pointCount
   * @param {object|null} draw.order - Draw-order record of the geometry.
   * @param {SpatialIndex|null} draw.tree - The tree `order` comes from.
   * @param {number} draw.lodLevel - -1 or a level of `tree`.
   * @param {boolean} draw.cull - Whether frustum culling applies.
   * @param {boolean} draw.frustumChanged
   * @param {WebGLTexture|null} draw.alphaTexture
   * @param {object|null} draw.alphaPlan
   * @param {string} draw.label
   * @private
   */
  _drawPoints(draw) {
    const gl = this.gl;
    const { params, viewState, order, tree, lodLevel, cull } = draw;
    const level = lodLevel >= 0 ? tree?.lodLevels?.[lodLevel] ?? null : null;
    if (lodLevel >= 0 && level === null) {
      throw new RangeError(`${draw.label} has no LOD level ${lodLevel}.`);
    }
    const reduced = level !== null && level.isFullDetail !== true;
    if ((reduced || cull) && (order === null || tree === null || order.drawOrder !== tree.drawOrder)) {
      throw new Error(`${draw.label} draws a reduced level or culled ranges without its tree's draw order.`);
    }
    const sizeMultiplier = reduced ? requireFiniteNumber(level.sizeMultiplier, `${draw.label} LOD size`) : 1;
    const drawn = reduced ? level.pointCount : draw.pointCount;

    let ranges = null;
    if (cull) {
      const state = viewState.cull;
      const lastBand = reduced ? lodLevel : order.drawOrder.bandCount - 1;
      const treeChanged = state.tree !== tree || state.drawOrder !== order.drawOrder;
      if (draw.frustumChanged || treeChanged) {
        this._validateSpatialOwnerOnce(tree);
        this._collectVisibleLeafRuns(state, tree.root, viewState.frustumPlanes);
        state.tree = tree;
        state.drawOrder = order.drawOrder;
        state.band = -1;
      }
      if (state.band !== lastBand) {
        this._writeCulledRanges(state, tree, lastBand);
      }
      ranges = state;
    }

    const programName = this._pointProgramName(params.dimensionLevel);
    const program = this.programs[programName];
    const uniforms = this.uniformLocations.get(programName);
    if (!program || !uniforms) {
      throw new Error(`HighPerfRenderer "${this.activeQuality}" point shader state is unavailable.`);
    }
    gl.useProgram(program);
    this._applyPointUniforms(
      gl, uniforms,
      params.mvpMatrix, params.viewMatrix, params.modelMatrix, params.projectionMatrix,
      params.pointSize * sizeMultiplier, params.sizeAttenuation, params.viewportHeight, params.fov,
      params.lightingStrength, params.fogDensity, params.fogColor, params.lightDir
    );

    let drawCalls = 0;
    let operationError = null;
    try {
      this._bindPointAlpha(gl, uniforms, draw.alphaTexture, draw.alphaPlan, order);
      gl.bindVertexArray(draw.vao);
      if (ranges === null) {
        drawCalls = drawPointsInSegments(gl, 0, drawn);
      } else if (ranges.rangeCount > 0) {
        const multiDraw = this._getMultiDraw();
        if (multiDraw !== null) {
          multiDraw.multiDrawArraysWEBGL(gl.POINTS, ranges.starts, 0, ranges.counts, 0, ranges.rangeCount);
          drawCalls = 1;
        } else {
          for (let range = 0; range < ranges.rangeCount; range++) {
            drawCalls += drawPointsInSegments(gl, ranges.starts[range], ranges.counts[range]);
          }
        }
      }
    } catch (error) {
      operationError = error;
    }
    let restorationError = null;
    try {
      restorePointDrawBaseline(gl, false, uniforms.opaque === true);
    } catch (error) {
      restorationError = error;
    }
    settlePointDraw(operationError, restorationError, `${draw.label} draw`);

    const visible = ranges === null ? drawn : ranges.elementCount;
    this._writeStats(
      viewState,
      visible,
      // Full detail reports -1, whichever ladder entry selected it.
      reduced ? lodLevel : -1,
      drawCalls,
      cull,
      cull && drawn > 0 ? 100 * (1 - Math.min(visible, drawn) / drawn) : 0
    );
  }

  /**
   * `WEBGL_multi_draw`, or null where the engine does not expose it (Firefox).
   * @returns {object|null}
   * @private
   */
  _getMultiDraw() {
    if (this._multiDraw === undefined) {
      this._multiDraw = this.gl.getExtension('WEBGL_multi_draw') ?? null;
    }
    return this._multiDraw;
  }

  setAdaptiveLOD(enabled) {
    if (typeof enabled !== 'boolean') {
      throw new TypeError(
        'HighPerfRenderer adaptive LOD enabled must be a boolean.'
      );
    }
    this._assertOperational('set adaptive LOD');
    if (enabled === this.useAdaptiveLOD) return;

    // Nothing is built here: each view's levels are built off the main
    // thread when it next draws (`_requestSpatialIndex`), and the view draws
    // full detail until they land. A build that failed is retried.
    this._treeBuildFailures = new WeakMap();
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
    const status = {
      pointCount: this.pointCount,
      currentDimensionLevel: dimLevel,
      useAdaptiveLOD: this.useAdaptiveLOD,
      useFrustumCulling: this.useFrustumCulling,
      forceLODLevel: this.forceLODLevel,
      lodLevelCount: spatialIndex?.lodLevels?.length ?? 0,
      drawOrder: this._liveOrder === null ? 'source' : `${this._liveOrder.drawOrder.bandCount} bands`,
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

    // As for LOD: trees are built off the main thread when views next draw.
    this._treeBuildFailures = new WeakMap();
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
        } else {
          console.log(`[HighPerfRenderer] Building ${dimLevel}D spatial index...`);
        }
        // A query needs the tree, not its levels: those are built off the
        // main thread for drawing and replace this tree when they land.
        this._getOrBuildSpatialIndexForDimension(dimLevel, false, false);
      }
    }
  }

  // ==========================================================================
  // SPATIAL TREES OFF THE MAIN THREAD
  //
  // Every tree the renderer needs for drawing -- for LOD, frustum culling, or
  // a 3D view's stored order -- is built with its draw order in a worker
  // (`spatial-tree-worker.js`, the same `buildSpatialTreeJob` either way), so
  // turning LOD or culling on, loading a dataset, keeping a view or showing
  // another representation never blocks a frame. Until a view's tree lands,
  // the view draws full detail from its store as it is; when it lands, it is
  // installed through the same publication a direct build takes and
  // `onAsyncTreeReady` asks the viewer for a frame, in which the store adopts
  // the tree's order (`_ensureStoreDrawOrder`). A build whose positions
  // were replaced before it returned is dropped, never installed.
  // ==========================================================================

  /**
   * Build a view's spatial tree in a worker, then install it. A hover reader
   * asks for this instead of building on the main thread.
   *
   * Resolves true when the view has an index for its current positions, built
   * now or already there; false when the positions changed before the tree
   * came back, or are too large to copy to a worker.
   *
   * @param {string} viewId - 'live' or a snapshot id.
   * @returns {Promise<boolean>}
   */
  buildSpatialIndexInBackground(viewId) {
    this._assertOperational('build a spatial index in the background');
    const exactId = requireViewId(viewId, 'HighPerfRenderer background spatial-index view id');
    const target = this._spatialIndexTarget(exactId);
    if (target === null) return Promise.resolve(true);
    return new Promise(resolve => {
      this._requestSpatialIndex(
        target.live ? { kind: 'live' } : { kind: 'snapshot', id: exactId },
        this._needsLodResources(-1),
        installed => resolve(installed)
      );
    });
  }

  /**
   * The positions a view's index would be built over, or null when it already
   * has one for them. A snapshot drawn with the live geometry uses the live
   * index.
   */
  _spatialIndexTarget(viewId) {
    if (viewId !== 'live') {
      const snapshot = this.snapshotBuffers.get(viewId);
      if (!snapshot) {
        throw new Error(`HighPerfRenderer snapshot "${viewId}" does not exist.`);
      }
      if (!this._snapshotUsesLiveGeometry(snapshot)) {
        if (snapshot.spatialIndex && snapshot.spatialIndex.positions === snapshot.positions) return null;
        return { positions: snapshot.positions, dimensionLevel: snapshot.dimensionLevel, live: false };
      }
    }
    const positions = this._positions;
    if (!positions || this.pointCount === 0) return null;
    const dimensionLevel = this.currentDimensionLevel;
    const existing = this.spatialIndices.get(dimensionLevel);
    if (existing && existing.positions === positions && existing.pointCount === this.pointCount) return null;
    return { positions, dimensionLevel, live: true };
  }

  /**
   * The live view's tree for drawing: the published one when it serves
   * (`needsLOD` asks for its LOD levels too), else whatever is published
   * for the live positions while a worker builds the rest (null for none).
   *
   * @param {number} dimensionLevel - The live dimension.
   * @param {boolean} needsLOD
   * @returns {SpatialIndex|null}
   * @private
   */
  _liveSpatialIndexForDraw(dimensionLevel, needsLOD) {
    const current = () => {
      const index = this.spatialIndices.get(dimensionLevel) ?? null;
      return index !== null && index.positions === this._positions && index.pointCount === this.pointCount
        ? index
        : null;
    };
    const index = current();
    if (index !== null && (!needsLOD || spatialIndexHasLod(index))) return index;
    this._requestSpatialIndex({ kind: 'live' }, needsLOD);
    // An inline build (no worker) has installed it already.
    return current();
  }

  /**
   * A custom-position snapshot's tree for drawing, as `_liveSpatialIndexForDraw`:
   * its pooled geometry's tree when one serves, else a worker builds it.
   *
   * @param {string} id
   * @param {object} snapshot
   * @param {number} dimensionLevel
   * @param {boolean} needsLOD
   * @returns {SpatialIndex|null}
   * @private
   */
  _snapshotSpatialIndexForDraw(id, snapshot, dimensionLevel, needsLOD) {
    const serves = index => (
      index !== null &&
      index !== undefined &&
      index.positions === snapshot.positions &&
      index.dimensionLevel === dimensionLevel &&
      (!needsLOD || spatialIndexHasLod(index))
    );
    if (serves(snapshot.spatialIndex)) return snapshot.spatialIndex;
    // Another view of the same geometry may have its tree already.
    const geometry = this._getSnapshotGeometryRecord(snapshot.geometryGeneration, snapshot.positions);
    const pooled = geometry.spatialIndices.get(this._snapshotSpatialIndexKey(dimensionLevel, needsLOD)) ?? null;
    if (serves(pooled)) {
      snapshot.spatialIndex = pooled;
      return pooled;
    }
    this._requestSpatialIndex({ kind: 'snapshot', id }, needsLOD);
    const now = snapshot.spatialIndex;
    return now !== null && now !== undefined && now.positions === snapshot.positions && now.dimensionLevel === dimensionLevel
      ? now
      : null;
  }

  /**
   * Ask for the tree of a view's positions (with LOD levels when `needsLOD`)
   * to be built off the main thread and installed. One build per positions
   * array is in flight at a time; a build without LOD does not satisfy a
   * request with it. A failed build is reported once and not retried until
   * LOD or culling is toggled.
   *
   * @param {{kind: 'live'}|{kind: 'snapshot', id: string}} target
   * @param {boolean} needsLOD
   * @param {(installed: boolean) => void} [settled] - Called once with
   *   whether a tree for the target's current positions is installed.
   * @private
   */
  _requestSpatialIndex(target, needsLOD, settled = null) {
    const snapshot = target.kind === 'snapshot' ? this.snapshotBuffers.get(target.id) : null;
    const positions = target.kind === 'live' ? this._positions : snapshot?.positions;
    const dimensionLevel = target.kind === 'live' ? this.currentDimensionLevel : snapshot?.dimensionLevel;
    if (!(positions instanceof Float32Array) || positions.length === 0) {
      settled?.(false);
      return;
    }
    this._treeBuilds ??= new WeakMap();
    this._treeBuildFailures ??= new WeakMap();
    const inflight = this._treeBuilds.get(positions);
    if (inflight && (inflight.needsLOD || !needsLOD)) {
      if (settled) inflight.settled.push(settled);
      return;
    }
    // A failed build is not retried for the same positions until memory has
    // been released since it failed; then the next request tries again.
    const failed = this._treeBuildFailures.get(positions);
    if (
      failed !== undefined &&
      (failed.needsLOD || !needsLOD) &&
      failed.epoch === (this._releaseEpoch ?? 0)
    ) {
      settled?.(false);
      return;
    }
    const pointCount = target.kind === 'live' ? this.pointCount : snapshot.pointCount;
    const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
    const label = target.kind === 'live' ? 'live view' : 'a kept view';
    const notifications = getNotificationCenter();
    const build = { needsLOD, settled: settled ? [settled] : [] };
    const finish = installed => {
      if (this._treeBuilds?.get(positions) === build) this._treeBuilds.delete(positions);
      for (const callback of build.settled) callback(installed);
    };
    let notifId = null;
    try {
      requireLodBuildHeapHeadroom(pointCount, needsLOD, `HighPerfRenderer ${dimensionLevel}D ${label}`);
    } catch (error) {
      this._treeBuildFailures.set(positions, { needsLOD, epoch: this._releaseEpoch ?? 0 });
      notifications.error(describeError(error));
      finish(false);
      return;
    }
    this._treeBuilds.set(positions, build);
    notifId = notifications.startCalculation(
      `Building ${dimensionLevel}D ${treeNames[dimensionLevel]}${needsLOD ? ' and levels of detail' : ''} for ${label} (${pointCount.toLocaleString()} cells)`,
      'spatial'
    );
    const startTime = performance.now();
    this._buildSpatialTreeJob(positions, dimensionLevel, needsLOD, result => {
      if (this._disposed === true || this._contextLost === true) {
        finish(false);
        return;
      }
      let installed = false;
      try {
        installed = this._installBuiltSpatialIndex(target, positions, dimensionLevel, needsLOD, result);
      } catch (error) {
        this._treeBuildFailures.set(positions, { needsLOD, epoch: this._releaseEpoch ?? 0 });
        settleCalculationNotification(notifications, notifId, 'failCalculation',
          `${dimensionLevel}D ${treeNames[dimensionLevel]} failed: ${describeError(error)}`);
        finish(false);
        return;
      }
      settleCalculationNotification(notifications, notifId, 'completeCalculation',
        `${dimensionLevel}D ${treeNames[dimensionLevel]} ready (${label})`, performance.now() - startTime);
      finish(installed);
      if (installed) this.onAsyncTreeReady?.();
    }, error => {
      this._treeBuildFailures.set(positions, { needsLOD, epoch: this._releaseEpoch ?? 0 });
      settleCalculationNotification(notifications, notifId, 'failCalculation',
        `${dimensionLevel}D ${treeNames[dimensionLevel]} failed: ${describeError(error)}`);
      finish(false);
    });
  }

  /**
   * Install a tree built off the main thread, if its positions are still
   * the target's. Returns whether it was installed.
   * @private
   */
  _installBuiltSpatialIndex(target, positions, dimensionLevel, needsLOD, { tree, order }) {
    if (target.kind === 'live') {
      if (this._positions !== positions || this.currentDimensionLevel !== dimensionLevel) return false;
      const cached = this.spatialIndices.get(dimensionLevel) ?? null;
      const cachedServes = cached !== null && cached.positions === positions &&
        (!needsLOD || spatialIndexHasLod(cached));
      if (cachedServes) return true;
      this._getOrBuildSpatialIndexForDimension(dimensionLevel, cached !== null, needsLOD, tree, order);
      return true;
    }
    const snapshot = this.snapshotBuffers.get(target.id);
    if (!snapshot || snapshot.positions !== positions || snapshot.dimensionLevel !== dimensionLevel) return false;
    this.rebuildSnapshotSpatialIndex(target.id, dimensionLevel, needsLOD, tree, order);
    return true;
  }

  /**
   * Run one tree build: in the worker, or inline where there is no worker
   * or the positions are too large to copy to one. `onDone` gets
   * `{tree, order}`; an inline build calls it before returning.
   * @private
   */
  _buildSpatialTreeJob(positions, dimensionLevel, buildLOD, onDone, onError) {
    const request = {
      dimensionLevel,
      buildLOD,
      maxPointsPerNode: this.options.LOD_MAX_POINTS_PER_NODE,
      maxDepth: this.options.LOD_MAX_DEPTH,
    };
    if (typeof Worker !== 'function') {
      let result;
      try {
        result = buildSpatialTreeJob({ ...request, positions });
      } catch (error) {
        onError(error);
        return;
      }
      onDone(result);
      return;
    }
    if (!this._spatialTreeWorker) {
      this._spatialTreeWorker = new Worker(
        new URL('./high-perf/spatial-tree-worker.js', import.meta.url),
        { type: 'module' }
      );
      this._spatialTreeRequests = new Map();
      this._spatialTreeRequestId = 0;
      this._spatialTreeWorker.onmessage = ({ data }) => {
        const pending = this._spatialTreeRequests.get(data.id);
        if (!pending) return;
        this._spatialTreeRequests.delete(data.id);
        if (data.error) pending.onError(new Error(`Background spatial index failed: ${data.error}`));
        else pending.onDone({ tree: data.tree, order: data.order });
      };
      this._spatialTreeWorker.onerror = event => {
        const error = new Error(`Background spatial index worker failed: ${event.message || 'unknown error'}`);
        const pending = [...this._spatialTreeRequests.values()];
        this._spatialTreeRequests.clear();
        for (const entry of pending) entry.onError(error);
      };
    }
    const id = ++this._spatialTreeRequestId;
    const worker = this._spatialTreeWorker;
    this._spatialTreeRequests.set(id, { onDone, onError });
    // The worker gets its own copy, sent in slices of at most
    // WORKER_POSITION_SLICE_FLOATS, one task each and each transferred: the
    // renderer keeps drawing from the original, no task copies the whole
    // geometry, and the main thread never holds a second full copy.
    const total = positions.length;
    let offset = 0;
    const sendSlice = () => {
      if (this._spatialTreeWorker !== worker || !this._spatialTreeRequests.has(id)) return;
      const end = Math.min(total, offset + WORKER_POSITION_SLICE_FLOATS);
      const slice = positions.slice(offset, end);
      worker.postMessage({ id, kind: 'positions', offset, total, slice }, [slice.buffer]);
      offset = end;
      if (offset < total) {
        setTimeout(sendSlice, 0);
        return;
      }
      worker.postMessage({ id, kind: 'build', ...request });
    };
    if (total === 0) {
      worker.postMessage({ id, kind: 'positions', offset: 0, total: 0, slice: new Float32Array(0) });
      worker.postMessage({ id, kind: 'build', ...request });
    } else {
      sendSlice();
    }
  }

  _retireSpatialTreeWorker() {
    if (!this._spatialTreeWorker) return;
    this._spatialTreeWorker.terminate();
    this._spatialTreeWorker = null;
    const error = new Error('HighPerfRenderer was disposed before the background spatial index finished.');
    const pending = [...this._spatialTreeRequests.values()];
    this._spatialTreeRequests.clear();
    for (const entry of pending) entry.onError(error);
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
   * Components per point of the positions published for one view: the
   * view's dimension level, which is also its position stride.
   *
   * @param {string} viewId - `live` or an exact snapshot ID.
   * @returns {1|2|3}
   */
  getViewPositionDimension(viewId) {
    const exactViewId = requireViewId(
      viewId,
      'HighPerfRenderer position-dimension viewId'
    );
    if (exactViewId === 'live') {
      if (!this._positions) {
        throw new RangeError(
          'HighPerfRenderer live view has no published positions.'
        );
      }
      return this.currentDimensionLevel;
    }
    const snapshot = this.snapshotBuffers.get(exactViewId);
    if (!snapshot) {
      throw new RangeError(
        `HighPerfRenderer view "${exactViewId}" does not exist.`
      );
    }
    return snapshot.dimensionLevel;
  }

  /**
   * The order one view's points are drawn in at full detail: the source
   * indices of its geometry's stored draw order, or null while the geometry
   * is stored in source order. A reduced LOD level draws a prefix of it
   * (`getCurrentLodSequentialMembership`). Renderer-owned and never written;
   * a new order is a new array. Figure export draws in this order so a
   * figure overlaps translucent points exactly as the pane does.
   *
   * @param {string} viewId - `live` or an exact snapshot ID.
   * @returns {Uint32Array|null}
   */
  getViewDrawOrder(viewId) {
    const exactViewId = requireViewId(viewId, 'HighPerfRenderer draw-order viewId');
    if (exactViewId === 'live') {
      return this._liveOrder?.drawOrder.indices ?? null;
    }
    const snapshot = this.snapshotBuffers.get(exactViewId);
    if (!snapshot) {
      throw new RangeError(`HighPerfRenderer view "${exactViewId}" does not exist.`);
    }
    const geometry = this._snapshotGeometryPools.get(snapshot.geometryGeneration);
    if (geometry === undefined) {
      throw new Error(`HighPerfRenderer view "${exactViewId}" has no geometry owner.`);
    }
    return this._geometryDrawOrder(geometry)?.indices ?? null;
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
   * @returns {boolean}
   */
  isAlphaTextureActive() { return Boolean(this._useAlphaTexture && this._alphaTexture && this._alphaTexWidth > 0); }



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
      snapshot.alphaTextureByteLength === snapshot.alphaTexPlan?.texels
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
    const dim = requireDimensionLevel(
      dimensionLevel,
      'HighPerfRenderer LOD level count dimensionLevel'
    );
    if (dim !== this.currentDimensionLevel) return 0;
    const tree = this._currentLiveTree();
    return Array.isArray(tree?.lodLevels) ? tree.lodLevels.length : 0;
  }

  /**
   * Whether the view's adaptive LOD is still stepping toward the level its
   * camera distance asks for. Hysteresis moves one level per drawn frame, so
   * the viewer keeps drawing while this holds, and only while it holds.
   * @param {string} viewId - Exact view ID.
   * @returns {boolean}
   */
  isViewLodConverging(viewId) {
    const viewState = this._perViewState.get(
      requireViewId(viewId, 'HighPerfRenderer LOD convergence viewId')
    );
    return viewState !== undefined && viewState.lodConverging === true;
  }

  /**
   * The LOD ladder length of the tree one view draws with: the live tree for
   * the live view and the views sharing its geometry, the view's own tree for
   * a view of another representation. Zero when that view has no LOD tree.
   *
   * @param {string} viewId
   * @param {number} dimensionLevel - The view's dimension.
   * @returns {number}
   */
  getViewLODLevelCount(viewId, dimensionLevel) {
    this._assertOperational('get a view LOD level count');
    const spatialIndex = this._getSpatialIndexForViewGeneration(viewId, dimensionLevel);
    return Array.isArray(spatialIndex?.lodLevels) ? spatialIndex.lodLevels.length : 0;
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
    // A linear texture (layers of MAX_TEXTURE_SIZE rows) holds any count.
    const plan = planLinearTextureFor(this.gl, pointCount);
    return {
      height: plan.rows,
      plan,
      requiredSize: plan.width * plan.rows,
      width: plan.width,
    };
  }


  /**
   * Size the bound `ARRAY_BUFFER` as one snapshot's RGBA8 colour store, 4
   * bytes a point like the live store, and fill it from the snapshot's
   * colors (gathered on the GPU for a draw order, `_writeOrderedColors`).
   * Four bytes a vertex keep the attribute on the 4-byte stride Metal needs:
   * a 3-byte RGB store made ANGLE keep a converted 4-byte copy of its own and
   * convert it again after every write. Only the sizing call can fail for
   * want of memory. A snapshot's alpha is its R8 texture; the store's alpha
   * byte is never read.
   *
   * @param {WebGLBuffer} buffer - The store, bound to `ARRAY_BUFFER`.
   * @param {Uint8Array} colors - Exact RGBA colors, 4 bytes a point.
   * @param {string} owner
   * @param {object|null} order - Draw-order record of the geometry the
   *   snapshot draws; null stores source order.
   * @returns {number} The store's byte length.
   * @private
   */
  _uploadSnapshotColors(buffer, colors, owner, order) {
    const gl = this.gl;
    const exactColors = requireSnapshotColors(
      this.pointCount,
      colors,
      owner
    );
    const byteLength = this.pointCount * 4;
    this._allocateGpu(`${owner} could not allocate its color buffer`, () => {
      gl.bufferData(gl.ARRAY_BUFFER, byteLength, gl.STATIC_DRAW);
    });
    this._writeOrderedColors(
      buffer,
      exactColors,
      order,
      `${owner} color-buffer upload`
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    return byteLength;
  }


  /**
   * Encode one snapshot R8 generation into `target` and report whether any
   * byte differs from `accepted` (or from `target` itself when null). With
   * `dirtyRows` (one entry a row of `rowWidth` texels, cleared by the caller)
   * the rows that differ are marked, so only they are uploaded.
   */
  _encodeSnapshotAlphaData(
    target,
    colors,
    alphas,
    owner,
    accepted = null,
    dirtyRows = null,
    rowWidth = 0
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
    if (dirtyRows !== null) {
      if (
        accepted === null ||
        !Number.isSafeInteger(rowWidth) ||
        rowWidth <= 0 ||
        !(dirtyRows instanceof Uint8Array) ||
        dirtyRows.length * rowWidth !== target.length
      ) {
        throw new TypeError(
          `${owner} dirty-row tracking needs the accepted owner and its exact row layout.`
        );
      }
    }
    // Row-major, so a moved row is marked without a division per point; the
    // same indices are visited in the same order as a flat scan (same first
    // rejection, same bytes). Texels past the last point are padding, 255.
    const reference = accepted === null ? target : accepted;
    const pointCount = this.pointCount;
    const width = dirtyRows === null ? target.length : rowWidth;
    let changed = false;
    for (let rowStart = 0, row = 0; rowStart < target.length; rowStart += width, row++) {
      const rowEnd = Math.min(rowStart + width, target.length);
      let rowChanged = false;
      for (let index = rowStart; index < rowEnd; index++) {
        let byte = 255;
        if (index < pointCount) {
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
        }
        if (reference[index] !== byte) rowChanged = true;
        target[index] = byte;
      }
      if (rowChanged) {
        changed = true;
        if (dirtyRows !== null) dirtyRows[row] = 1;
      }
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
    this._snapshotAlphaStagingData = null;
  }

  _uploadNewSnapshotAlphaTexture(
    data,
    plan,
    label,
    staging
  ) {
    if (
      !(data instanceof Uint8Array) ||
      !plan ||
      data.length !== plan.width * plan.rows ||
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
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    try {
      this._withNeutralTextureUnpackState(1, label, () => {
        this._allocateGpu(`${label} could not allocate its R8 texture`, () => {
          allocateLinearTexture(gl, gl.R8, plan);
        });
        writeLinearTextureRows(gl, plan, gl.RED, gl.UNSIGNED_BYTE, data, 1);
        requireCleanWebGLState(gl, `${label} upload`);
      });
      staging.alphaTextureByteLength = plan.texels;
    } finally {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    }
    return texture;
  }



  /**
   * Create a GPU buffer for a snapshot view. Call this once when snapshot is created.
   * The snapshot owns one RGBA8 colour VBO plus one R8 alpha texture and references its
   * geometry generation's shared immutable position VBO through its VAO.
   * @param {string} id - Unique snapshot identifier
   * @param {Uint8Array} colors - Exact RGBA colors.
   * @param {Uint8Array|null} alphas - Exact 0/1 point transparency or null to use RGBA alpha.
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
      exactDimensionLevel,
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
    try {
      this._encodeSnapshotAlphaData(
        alphaData,
        pointData.colors,
        pointData.alphas,
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
    // `requireSnapshotPointData` proved the source holds exactly
    // `exactDimensionLevel` components a point, so the geometry it names is
    // that dimension's.
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
    let snapshotBounds = null;
    try {
      snapshotBounds = HighPerfRenderer.computeBoundsFromPositions(
        positions,
        exactDimensionLevel
      );

      if (hasCustomPositions && needsSpatialIndex) {
        // The geometry's tree when another view built it; otherwise the
        // view's first frame asks a worker for it (`_snapshotSpatialIndexForDraw`).
        spatialIndex = geometry.spatialIndices.get(
          this._snapshotSpatialIndexKey(exactDimensionLevel, this._needsLodResources(-1))
        ) ?? null;
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
      colorBufferByteLength = this._uploadSnapshotColors(
        colorBuffer,
        pointData.colors,
        `HighPerfRenderer candidate snapshot "${exactId}"`,
        this._geometryOrderRecord(geometry)
      );

      this._uploadNewSnapshotAlphaTexture(
        alphaData,
        alphaLayout.plan,
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
      bindPositionAttribute(gl, positionBuffer, geometry.dimension);
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
      gl.enableVertexAttribArray(1);
      colorOwner = this._createSnapshotColorOwner(
        colorBuffer,
        colorBufferByteLength,
        this._geometryDrawOrder(geometry)
      );
      gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 4, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      requireCleanWebGLState(
        gl,
        `HighPerfRenderer candidate snapshot "${exactId}" publication`
      );

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
      // The published RGBA array, kept by reference: a published color array
      // is never written (a recolor publishes a new one), and it is what the
      // colour store is gathered from when its geometry's draw order changes.
      colors: pointData.colors,
      alphaTexData: alphaData,
      alphaTexHeight: alphaLayout.height,
      alphaTexPlan: alphaLayout.plan,
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
      `${(colorBufferByteLength / 1024 / 1024).toFixed(1)} MB colour, ` +
      `${(alphaStaging.alphaTextureByteLength / 1024 / 1024).toFixed(1)} MB R8 alpha, ` +
      `${(positions.byteLength / 1024 / 1024).toFixed(1)} MB shared positions` +
      `${spatialIndex ? ', with spatial index' : ''})`
    );
    return true;
  }

  /**
   * Transactionally replace any requested snapshot colour, R8, and geometry
   * owners while retaining unchanged publications by exact reference count.
   * @param {string} id - Snapshot identifier
   * @param {Uint8Array} colors - Exact RGBA colors.
   * @param {Uint8Array|null} alphas - Exact 0/1 point transparency or null.
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

    // A released view is rebuilt before its stores are replaced.
    this._snapshotInOperation = exactId;
    this._restoreSnapshotStores(snapshot);
    const gl = this.gl;
    const n = this.pointCount;
    const owner = `HighPerfRenderer snapshot "${exactId}"`;
    if (
      !(viewPositions instanceof Float32Array) ||
      viewPositions.length !== n * exactDimensionLevel
    ) {
      throw new TypeError(
        `${owner} positions must be a Float32Array with exactly ${n * exactDimensionLevel} values (${exactDimensionLevel} per point).`
      );
    }
    let alphaData = null;
    let alphaLayout = null;
    if (replaceColor) {
      requireSnapshotColors(n, colors, owner);
    }
    if (replaceAlpha) {
      alphaLayout = this._getSnapshotAlphaTextureLayout(
        n,
        owner
      );
      alphaData = this._acquireSnapshotAlphaStaging(
        alphaLayout.requiredSize
      );
      try {
        this._encodeSnapshotAlphaData(
          alphaData,
          colors,
          alphas,
          owner
        );
      } catch (error) {
        this._donateSnapshotAlphaStaging(alphaData);
        throw error;
      }
    }
    const acceptedColorOwner =
      this._ensureSnapshotColorOwner(snapshot);

    const positionsChanged =
      forceGeometryPublication ||
      viewPositions !== snapshot.positions;
    let candidateGeometry;
    try {
      // A forced publication re-uploads its own copy; otherwise a view
      // switched to a representation another view shows (or showed lately)
      // shares that geometry.
      candidateGeometry = !positionsChanged
        ? this._acquireSnapshotGeometryFromSource(
            exactId,
            viewPositions
          )
        : forceGeometryPublication
          ? this._acquireIndependentSnapshotGeometry(
              viewPositions,
              exactDimensionLevel
            )
          : this._acquireSnapshotGeometryForPositions(
              viewPositions,
              exactDimensionLevel
            );
    } catch (error) {
      this._donateSnapshotAlphaStaging(alphaData);
      throw error;
    }
    // The length check above proved `viewPositions` holds exactly
    // `exactDimensionLevel` components a point, so unchanged positions keep
    // the snapshot's dimension: the published dimension is the position
    // layout and changes only with a new position publication.
    const positions = candidateGeometry.positions;
    const nextGeometryGeneration = candidateGeometry.generation;
    const dimensionChanged =
      snapshot.dimensionLevel !== exactDimensionLevel;
    const geometryChanged = positionsChanged || dimensionChanged;

    let nextBounds = snapshot.bounds;
    let nextSpatialIndex = snapshot.spatialIndex;
    let nextDimensionLevel = snapshot.dimensionLevel;
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
          nextBounds = HighPerfRenderer.computeBoundsFromPositions(
            positions,
            exactDimensionLevel
          );
        }

        // The geometry's tree when another view built it; otherwise the
        // view's next frame asks a worker for it.
        nextSpatialIndex = hasCustomPositions && needsSpatialIndex
          ? this._getSnapshotGeometryRecord(nextGeometryGeneration, positions).spatialIndices.get(
            this._snapshotSpatialIndexKey(exactDimensionLevel, this._needsLodResources(-1))
          ) ?? null
          : null;
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
        candidateBufferByteLength = this._uploadSnapshotColors(
          candidateBuffer,
          colors,
          `HighPerfRenderer candidate snapshot "${exactId}"`,
          this._geometryOrderRecord(candidateGeometry)
        );
      } else {
        candidateBuffer = acceptedColorOwner.buffer;
        candidateBufferByteLength =
          acceptedColorOwner.byteLength;
      }
      if (replaceAlpha) {
        this._uploadNewSnapshotAlphaTexture(
          alphaData,
          alphaLayout.plan,
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
      bindPositionAttribute(gl, positionBuffer, candidateGeometry.dimension);
      gl.bindBuffer(gl.ARRAY_BUFFER, candidateBuffer);
      gl.enableVertexAttribArray(1);
      candidateColorOwner = replaceColor
        ? this._createSnapshotColorOwner(
            candidateBuffer,
            candidateBufferByteLength,
            this._geometryDrawOrder(candidateGeometry)
          )
        : this._retainSnapshotColorOwner(
            acceptedColorOwner
          );
      gl.vertexAttribPointer(
        1,
        4,
        gl.UNSIGNED_BYTE,
        true,
        4,
        0
      );
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      requireCleanWebGLState(
        gl,
        `HighPerfRenderer candidate snapshot "${exactId}" publication`
      );

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
    if (replaceColor) {
      snapshot.colors = colors;
      // Stores kept for other orders hold the old colours.
      this._clearKeptColorStores(snapshot.colorCache);
    }
    snapshot.buffer = candidateBuffer;
    snapshot.bufferByteLength = candidateBufferByteLength;
    snapshot.colorOwner = candidateColorOwner;
    snapshot.vao = candidateVao;
    snapshot.positions = positions;
    snapshot.geometryGeneration = nextGeometryGeneration;
    if (replaceAlpha) {
      snapshot.alphaTexData = alphaData;
      snapshot.alphaTexHeight = alphaLayout.height;
      snapshot.alphaTexPlan = alphaLayout.plan;
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
   * Replace only one snapshot's colour publication. The colours' alpha byte is
   * never read: the accepted R8 texture is the snapshot's alpha.
   *
   * A store this snapshot alone owns, already in the order it draws with, is
   * rewritten in place (one gather, as an adoption rewrites it): no new
   * buffer or vertex array per recolour. A shared store, or one in another
   * order, is replaced.
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
    if (snapshot.storesReleased === true) {
      // Nothing on the GPU to rewrite: the view is rebuilt from these
      // colours when it is next drawn.
      requireSnapshotColors(this.pointCount, colors, `HighPerfRenderer snapshot "${exactId}" recolour`);
      snapshot.colors = colors;
      return true;
    }
    const owner = this._ensureSnapshotColorOwner(snapshot);
    const orderRecord = this._snapshotUsesLiveGeometry(snapshot)
      ? (this._liveOrder ?? null)
      : (this._getSnapshotGeometryRecord(
          snapshot.geometryGeneration,
          snapshot.positions
        ).order ?? null);
    if (
      owner.refCount === 1 &&
      (owner.order ?? null) === (orderRecord?.drawOrder ?? null)
    ) {
      const label = `HighPerfRenderer snapshot "${exactId}" recolour`;
      requireSnapshotColors(this.pointCount, colors, label);
      this._writeOrderedColors(owner.buffer, colors, orderRecord, label);
      snapshot.colors = colors;
      // Stores kept for other orders hold the old colours.
      this._clearKeptColorStores(snapshot.colorCache);
      return true;
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
    const layout = { height, plan: snapshot.alphaTexPlan, requiredSize, width };
    const plan = snapshot.alphaTexPlan;
    if (
      snapshot.pointCount !== this.pointCount ||
      !plan ||
      plan.itemCount !== this.pointCount ||
      width !== plan.width ||
      height !== plan.rows ||
      !(snapshot.alphaTexData instanceof Uint8Array) ||
      snapshot.alphaTexData.length !== requiredSize ||
      (
        snapshot.alphaTexture === null
          ? snapshot.alphaTextureByteLength !== 0
          : (
            !snapshot.alphaTexture ||
            snapshot.alphaTextureByteLength !== plan.texels
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
    // Scratch owned by this method alone, re-derived on every call.
    let dirtyRows = this._snapshotAlphaDirtyRows;
    if (!(dirtyRows instanceof Uint8Array) || dirtyRows.length !== height) {
      dirtyRows = new Uint8Array(height);
      this._snapshotAlphaDirtyRows = dirtyRows;
    } else {
      dirtyRows.fill(0);
    }
    let regions = this._snapshotAlphaUploadRegions;
    if (!(regions instanceof Int32Array) || regions.length !== height * 2) {
      regions = new Int32Array(height * 2);
      this._snapshotAlphaUploadRegions = regions;
    }
    let changed;
    try {
      changed = this._encodeSnapshotAlphaData(
        candidate,
        null,
        alphas,
        owner,
        accepted,
        dirtyRows,
        width
      );
    } catch (error) {
      this._donateSnapshotAlphaStaging(candidate);
      throw error;
    }

    if (snapshot.storesReleased === true) {
      // Nothing on the GPU to rewrite: the accepted bytes move, and the view
      // is rebuilt from them when it is next drawn.
      snapshot.alphaTexData = candidate;
      this._donateSnapshotAlphaStaging(accepted);
      return changed;
    }

    if (snapshot.alphaTexture === null) {
      const recovery = {
        alphaTexture: null,
        alphaTextureByteLength: 0,
      };
      try {
        this._uploadNewSnapshotAlphaTexture(
          accepted,
          snapshot.alphaTexPlan,
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
      // No byte moved, so no consumer of the visibility boundary can see a
      // difference: the caller skips its highlight and edge work.
      this._donateSnapshotAlphaStaging(candidate);
      return false;
    }

    // Only the rows that moved are sent; every other row of the resident
    // texture already holds the bytes this generation would write.
    const regionCount = collectAlphaUploadRegions(dirtyRows, height, regions);
    try {
      this._uploadAlphaRegions(
        snapshot.alphaTexture,
        plan,
        candidate,
        regions,
        regionCount,
        `${owner} publication`
      );
    } catch (publicationError) {
      try {
        // Exactly the regions the failed publication could have touched.
        this._uploadAlphaRegions(
          snapshot.alphaTexture,
          plan,
          accepted,
          regions,
          regionCount,
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
   * The existing colour VBO and R8 texture remain independent accepted owners.
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
      viewPositions.length !== this.pointCount * exactDimensionLevel
    ) {
      throw new TypeError(
        `HighPerfRenderer snapshot "${exactId}" positions must contain exactly ${this.pointCount * exactDimensionLevel} Float32 values.`
      );
    }

    // Not forced: positions another view shows, or a retained geometry holds,
    // are shared rather than uploaded again (`_acquireSnapshotGeometryForPositions`);
    // a published array is immutable, so the same array is the same geometry.
    this._replaceSnapshotResources(
      exactId,
      null,
      null,
      viewPositions,
      exactDimensionLevel,
      false,
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
   * Return a snapshot's immutable CPU positions: its geometry generation's
   * published array, which a snapshot of the live generation shares with the
   * live view. Consumers must treat this reference as read-only.
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
   * Build (or promote to LOD) a snapshot's spatial index for its published
   * dimension. A snapshot's dimension is the layout of its positions, so it
   * changes only through `updateSnapshotPositions`.
   * @param {string} id - Snapshot identifier
   * @param {number} dimensionLevel - The snapshot's published dimension (1, 2, or 3)
   * @param {boolean} [needsLOD] - Whether the exact tree must own LOD prefixes.
   * @returns {boolean} Success
   */
  rebuildSnapshotSpatialIndex(
    id,
    dimensionLevel,
    needsLOD = this._needsLodResources(-1),
    prebuiltTree = null,
    prebuiltOrder = null
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
    if (snapshot.dimensionLevel !== exactDimensionLevel) {
      throw new Error(
        `HighPerfRenderer snapshot "${exactId}" owns ${snapshot.dimensionLevel}D positions; a ${exactDimensionLevel}D spatial index cannot be built over them.`
      );
    }

    // A matching geometry generation uses the dimension-specific main index.
    // Generation, not array identity, is the ownership signal: one published
    // array can back more than one geometry generation.
    if (this._snapshotUsesLiveGeometry(snapshot)) {
      // Clear any existing spatial index since it should use main index
      snapshot.spatialIndex = null;
      return true;
    }

    // If we already have a valid spatial index for this positions array, don't rebuild.
    // This prevents duplicate quadtree builds when a dimension change updates positions first and then
    // calls rebuildSnapshotSpatialIndex() (common in multiview switching flows).
    if (snapshot.spatialIndex &&
        snapshot.spatialIndex.positions === snapshot.positions) {
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

    // A tree built off the main thread replaces a pooled one that does not
    // serve (no LOD levels where they are needed); a direct rebuild
    // promotes the pooled tree in place.
    const pooledServing = () => {
      const pooled = this._getSnapshotGeometryRecord(snapshot.geometryGeneration, snapshot.positions)
        .spatialIndices.get(this._snapshotSpatialIndexKey(exactDimensionLevel, needsLOD)) ?? null;
      return pooled !== null && (!needsLOD || spatialIndexHasLod(pooled)) ? pooled : null;
    };
    let candidateSpatialIndex = prebuiltTree === null
      ? this._getPooledSnapshotSpatialIndex(
        snapshot.geometryGeneration,
        snapshot.positions,
        exactDimensionLevel,
        needsLOD
      )
      : pooledServing();
    if (candidateSpatialIndex === null) {
      const announce = prebuiltTree === null;
      if (announce) {
        requireLodBuildHeapHeadroom(
          snapshot.pointCount,
          needsLOD,
          `HighPerfRenderer ${exactDimensionLevel}D view "${exactId}"`
        );
      }
      const notifications = getNotificationCenter();
      const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
      const treeName = treeNames[exactDimensionLevel];
      const cellCount = snapshot.pointCount;
      const notifId = announce
        ? notifications.startCalculation(
          `Rebuilding ${exactDimensionLevel}D ${treeName} for a kept view (${cellCount.toLocaleString()} cells)`,
          'spatial'
        )
        : null;
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
            prebuiltTree,
            prebuiltOrder,
          }
        );
        this._publishPooledSnapshotSpatialIndex(
          snapshot.geometryGeneration,
          snapshot.positions,
          exactDimensionLevel,
          needsLOD,
          candidateSpatialIndex,
          !announce
        );
        if (announce) {
          settleCalculationNotification(
            notifications,
            notifId,
            'completeCalculation',
            `${exactDimensionLevel}D ${treeName} ready for a kept view`,
            performance.now() - startTime
          );
        }
      } catch (error) {
        if (announce) settleCalculationNotification(
          notifications,
          notifId,
          'failCalculation',
          `${exactDimensionLevel}D ${treeName} failed for a kept view: ${describeError(error)}`
        );
        throw error;
      }
    }
    snapshot.spatialIndex = candidateSpatialIndex;
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
    // Drawing a view makes it the one being worked on: nothing it draws
    // with is released under it, and a released view is rebuilt first.
    this._snapshotInOperation = exactId;
    this._restoreSnapshotStores(snapshot);

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
    // Whether this pass draws into a multisampled target, which decides how an
    // opaque program antialiases its edge (`enterOpaquePointBlending`).
    this._pointPassMultisampled = params.multisampled === true;

    // Get per-view state for frustum culling and LOD caching
    const viewState = this._getViewState(viewId);

    // Geometry-generation equality proves whether the main spatial/LOD
    // resources index this snapshot. Array identity does not: one published
    // array can back more than one geometry generation.
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

    const customSpatialIndex = hasCustomPositions && needsSpatialIndex
      ? this._snapshotSpatialIndexForDraw(exactId, snapshot, dimensionLevel, needsLOD)
      : null;

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
      ? this._liveSpatialIndexForDraw(effectiveDimLevel, needsLOD)
      : null;

    // A custom-position view draws with its own geometry's tree.
    const lodSpatialIndex = hasCustomPositions ? customSpatialIndex : mainSpatialIndex;

    // Select LOD level based on whether LOD is enabled (consistent with render())
    // When LOD is disabled, forceLODLevel is ignored - only params.forceLOD is respected
    let lodLevel;
    viewState.lodConverging = false;
    if (this.useAdaptiveLOD) {
      // LOD enabled: Priority is this.forceLODLevel > params.forceLOD > adaptive
      lodLevel = this.forceLODLevel >= 0 ? this.forceLODLevel : forceLOD;
      if (lodLevel < 0 && lodSpatialIndex) {
        // The view's own dimension and bounds decide the level of its tree.
        lodLevel = lodSpatialIndex.getLODLevel(cameraDistance, viewState.lastLodLevel, effectiveDimLevel, snapshot.bounds);
        viewState.lodConverging =
          lodSpatialIndex.getLODLevel(cameraDistance, lodLevel, effectiveDimLevel, snapshot.bounds) !== lodLevel;
      }
    } else {
      // LOD disabled: only respect explicit per-render forceLOD, otherwise full detail
      lodLevel = forceLOD >= 0 ? forceLOD : -1;
    }
    if (!Number.isInteger(lodLevel) || lodLevel < -1) {
      throw new Error(
        `HighPerfRenderer selected an invalid LOD level for snapshot "${exactId}".`
      );
    }
    if (lodLevel >= 0 && !spatialIndexHasLod(lodSpatialIndex)) {
      // The levels are still building: full detail until they land.
      lodLevel = -1;
    }
    if (lodLevel >= 0 && !lodSpatialIndex?.lodLevels?.[lodLevel]) {
      throw new RangeError(
        `HighPerfRenderer snapshot "${exactId}" has no LOD level ${lodLevel} for ${effectiveDimLevel}D.`
      );
    }

    // The geometry is stored in the draw order of its tree whenever one
    // exists, and the view's colours follow it. Until the store has adopted
    // that order the frame draws full detail from it as it is.
    const orderTree = lodSpatialIndex ?? (
      hasCustomPositions
        ? (snapshot.spatialIndex?.positions === snapshot.positions ? snapshot.spatialIndex : null)
        : this._currentLiveTree()
    );
    const order = this._ensureSnapshotDrawOrder(snapshot, orderTree);
    this._ensureSnapshotColorsInOrder(snapshot, order);
    const ordered = lodSpatialIndex !== null && order?.drawOrder === lodSpatialIndex.drawOrder;
    if (!ordered) lodLevel = -1;
    viewState.lastLodLevel = lodLevel;
    const cull = this.useFrustumCulling && ordered;
    if (!cull) {
      this.stats.frustumCulled = false;
      this.stats.cullPercent = 0;
    }

    // 2D/1D views draw without depth: every point has the same depth.
    const disableDepth = effectiveDimLevel <= DEPTH_TEST_DIMENSION_THRESHOLD;
    let frustumChanged = false;
    let operationError = null;
    try {
      if (cull) {
        frustumChanged = this._prepareFrustumCache(
          mvpMatrix,
          viewState,
          effectiveDimLevel,
          hasCustomPositions ? snapshot.bounds : null
        );
      }
      if (disableDepth) {
        gl.disable(gl.DEPTH_TEST);
      }
      this._drawPoints({
        params: effectiveParams,
        viewState,
        vao: snapshot.vao,
        pointCount: snapshot.pointCount,
        order,
        tree: lodSpatialIndex,
        lodLevel,
        cull,
        frustumChanged,
        alphaTexture: useAlphaTexture ? this._alphaTexture : snapshot.alphaTexture,
        alphaPlan: useAlphaTexture ? this._alphaTexPlan : snapshot.alphaTexPlan,
        label: `HighPerfRenderer view "${exactId}"`,
      });
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
    settlePointDraw(
      operationError,
      restorationError,
      'HighPerfRenderer snapshot render'
    );
    viewState.lastDimensionLevel = effectiveDimLevel;
    this._publishFrameTiming(viewState, frameStart);
    return returnStats ? this.getStats(viewId) : undefined;
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
    this.programs = createEmptyPointPrograms();
    this.activeProgram = null;
    this.uniformLocations = new Map();
    this.vao = null;
    this.buffers = {
      positions: null,
      colors: null,
    };
    this._positionGpuByteLength = 0;
    this._colorGpuByteLength = 0;
    this._alphaTexture = null;
    this._alphaTextureByteLength = 0;
    this._alphaTexWidth = 0;
    this._alphaTexHeight = 0;
    this._alphaTexPlan = null;
    this._alphaTexData = null;
    this._alphaTexStagingData = null;
    this._alphaDirtyRows = null;
    this._alphaUploadRegions = null;
    this._useAlphaTexture = false;
    this._currentAlphas = null;
    this._dummyLodIndexTexture = null;
    this._dummyLodIndexTextureByteLength = 0;
    this._permuter?.abandon();
    this._permuter = null;
    // The handles died with the context; drop them without deleting.
    this._liveColorCache = new Map();

    this._liveOrder = null;
    this._liveColorOrder = null;
    this.spatialIndices = new Map();
    this._perViewState = new Map();
    this.snapshotBuffers = new Map();
    this._snapshotGeometryPools = new Map();

    this._pendingSnapshotRetirements = new Set();
    this._pendingDataRetirements = new Set();
    this._pendingProgramRetirements = new Set();
    this._pendingShaderRetirements = new Set();
    this._pendingProgramUnbind = false;
    // A lost context invalidates every collaborator's handles too; each one
    // detaches its own ownership, so no allocation remains to report.
    this._gpuAllocationReporters = new Set();

    this.pointCount = 0;
    this.forceLODLevel = -1;
    this.useAdaptiveLOD = false;
    this.useFrustumCulling = false;
    this._positions = null;
    this._colors = null;
    this._liveGeometryGeneration = 0;
    this._nextGeometryGeneration = 1;
    this._boundingSphere = null;
    this._colorsDirty = false;
    this._firstRenderDone = false;

    this._snapshotAlphaStagingData = null;
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
    this._retireSpatialTreeWorker();
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
    this.programs = createEmptyPointPrograms();
    this.activeProgram = null;
    this.uniformLocations.clear();
    this._queueProgramRetirement(programs);
    const unbindFailure = this._attemptProgramUnbind();
    if (unbindFailure) failures.push(unbindFailure);

    // A re-order in progress owns staging buffers of its own.
    // Capture and detach the complete current data publication before any
    // fallible deletion. Pending records own every resource across retries.
    this._queueDataRetirement(this._captureDataPublication());
    this.vao = null;
    this.buffers = {
      positions: null,
      colors: null,
    };
    this._positionGpuByteLength = 0;
    this._colorGpuByteLength = 0;
    this._alphaTexture = null;
    this._alphaTextureByteLength = 0;
    this._alphaTexWidth = 0;
    this._alphaTexHeight = 0;
    this._alphaTexPlan = null;
    this._alphaTexData = null;
    this._alphaTexStagingData = null;
    this._alphaDirtyRows = null;
    this._alphaUploadRegions = null;
    this._useAlphaTexture = false;
    this._currentAlphas = null;
    // Kept colour stores are deleted with the rest (queued, drained below).
    this._evictKeptColorStores(Infinity);
    this._liveOrder = null;
    this._liveColorOrder = null;
    this.spatialIndices = new Map();
    this._perViewState = new Map();
    this.pointCount = 0;
    this._positions = null;
    this._colors = null;
    this._liveGeometryGeneration = 0;
    this._boundingSphere = null;
    this._colorsDirty = false;
    this._validatedSpatialIndices = new WeakSet();
    // Collaborators retire their own GPU handles. Drop the registrations so a
    // disposed renderer neither reports their bytes nor keeps them reachable.
    this._ensureGpuAllocationReporters().clear();

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
    if (this._permuter) {
      try {
        this._permuter.dispose();
      } catch (error) {
        failures.push(error);
      }
      this._permuter = null;
    }

    // Snapshots retire first: releasing their geometry leaves it retained
    // (refCount 0), and a disposed renderer retains nothing, so every such
    // geometry -- and one the live publication handed to the pool -- is
    // queued for deletion behind every VAO that drew it, then drained once.
    failures.push(...this._drainSnapshotRetirements());
    for (const geometry of [...this._snapshotGeometryPools.values()]) {
      if (geometry.refCount === 0) this._evictGeometryRecord(geometry);
    }
    failures.push(...this._drainDataRetirements());
    failures.push(...this._drainProgramRetirements());
    failures.push(...this._drainShaderRetirements());
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
