import { requireCleanWebGLState, requireLiveContext } from './gl-errors.js';
import { CellSet } from '../app/utils/cell-set.js';
import {
  KnnExpansion,
  LassoHitTest,
  ProximityHitTest,
  requireKnnGraph,
  SELECTION_SLICE_MS,
} from './selection-gesture-queries.js';
import { yieldToMacrotask } from '../utils/yield-macrotask.js';
import { readPositionXYZ } from './position-layout.js';
import {
  configureStraightAlphaBlending,
  createProgram,
  deleteProgramReleasingUse,
  deleteTextureTracked,
  drawPointsInSegments,
  restorableTexture,
} from './gl-utils.js';
import { glStateOf } from './gl-state-shadow.js';
import {
  HIGHLIGHT_STYLES_BY_QUALITY,
  HP_VS_HIGHLIGHT,
  HP_FS_HIGHLIGHT,
  highlightGlowAt,
  writePointShaderFrame,
} from './shaders/high-perf-shaders.js';
import { writeFogUniforms } from './shaders/fog-shaders.js';
import { GpuPermuter } from './high-perf/gpu-permute.js';
import {
  allocateLinearTexture,
  planLinearTextureFor,
  writeLinearTextureRows,
} from './linear-texture.js';
import {
  describeShaderQualities,
  isShaderQuality,
} from './shader-quality.js';
import {
  MIN_VISIBLE_ALPHA_BYTE,
  POINT_VISIBILITY_THRESHOLD,
} from './alpha-visibility.js';
import {
  requireSelectMode,
  resolveSelectionGestureCombine,
  SELECT_MODE_OFF,
} from './select-mode.js';
import { formatCountOf } from '../utils/format-units.js';

/**
 * The kind of field one pane is colored by, as the annotation tool reads it.
 *
 * There is no single "highlight mode": in a grid of views every pane may be
 * colored by a different field, or by none, and an annotation gesture is read
 * on the pane it lands in without moving focus. So the renderer asks for the
 * kind of the pane under the pointer, every time it needs it, instead of
 * caching one kind derived from the focused view.
 */
const VIEW_FIELD_KINDS = Object.freeze([
  'none',
  'continuous',
  'categorical',
]);
/** Every pane reads as colored by no field until the app wires its source. */
const NO_VIEW_FIELD_KIND_SOURCE = () => 'none';
/**
 * The cursor an armed annotation tool shows over a pane of each field kind:
 * a vertical drag selects a value range, a click selects a category, and a
 * pane with no field has nothing to select (the press is consumed and
 * answered with a notice, so it does not rotate the camera either).
 */
const ANNOTATION_CURSOR_BY_FIELD_KIND = Object.freeze({
  none: 'not-allowed',
  continuous: 'ns-resize',
  categorical: 'cell',
});
const HIGHLIGHT_CANVAS_CLASSES = Object.freeze([
  'selecting',
  'selecting-continuous',
  'lassoing',
  'lasso-mode',
  'proximity-dragging',
  'proximity-mode',
  'knn-dragging',
  'knn-mode',
]);
function requireViewFieldKind(kind, viewId) {
  if (!VIEW_FIELD_KINDS.includes(kind)) {
    throw new RangeError(
      `Field kind of view "${viewId}" must be exactly "none", "continuous", `
      + 'or "categorical".'
    );
  }
  return kind;
}

function requireExactBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be an exact boolean.`);
  }
  return value;
}

function requireCallback(value, label) {
  if (typeof value !== 'function') {
    throw new TypeError(`${label} must be one function.`);
  }
  return value;
}


function requireHighlightQuality(quality) {
  if (!isShaderQuality(quality)) {
    throw new RangeError(
      `Highlight renderer quality must be one of ${describeShaderQualities()}.`
    );
  }
  return quality;
}

function requireHighlightViewId(viewId, label = 'Highlight viewId') {
  if (typeof viewId !== 'string' || viewId.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return viewId;
}

function requireHighlightDimension(dimensionLevel) {
  if (
    !Number.isInteger(dimensionLevel) ||
    dimensionLevel < 1 ||
    dimensionLevel > 3
  ) {
    throw new RangeError(
      'Highlight dimensionLevel is required and must be exactly 1, 2, or 3.'
    );
  }
  return dimensionLevel;
}

/**
 * Positions hold exactly `dimensionLevel` components per cell (x, xy or xyz;
 * see rendering/position-layout.js). Returns the point count.
 */
function requireHighlightPositions(
  positions,
  dimensionLevel,
  label = 'Highlight positions'
) {
  const dimension = requireHighlightDimension(dimensionLevel);
  if (
    !(positions instanceof Float32Array) ||
    positions.length % dimension !== 0
  ) {
    throw new TypeError(
      `${label} must be a Float32Array containing ${formatCountOf(dimension, 'value')} per cell.`
    );
  }
  return positions.length / dimension;
}

function requireHighlightTransparency(transparency, pointCount) {
  if (
    !(transparency instanceof Uint8Array) ||
    transparency.length !== pointCount
  ) {
    throw new TypeError(
      `Highlight view transparency must be a Uint8Array with exactly ${formatCountOf(pointCount, 'entry', 'entries')}.`
    );
  }
  return transparency;
}

function requireSpatialQueryOwner(owner, expectedViewId) {
  const exactViewId = requireHighlightViewId(
    expectedViewId,
    'Spatial-query owner viewId'
  );
  if (
    owner === null ||
    typeof owner !== 'object' ||
    Array.isArray(owner) ||
    owner.viewId !== exactViewId
  ) {
    throw new Error(
      `Spatial-query owner must match exact view "${exactViewId}".`
    );
  }
  const dimensionLevel = requireHighlightDimension(owner.dimensionLevel);
  const positions = owner.positions;
  const pointCount = requireHighlightPositions(
    positions,
    dimensionLevel,
    `Spatial-query owner positions for view "${exactViewId}"`
  );
  const publishedPositions = owner.publishedPositions ?? positions;
  requireHighlightPositions(
    publishedPositions,
    dimensionLevel,
    `Spatial-query published positions for view "${exactViewId}"`
  );
  if (publishedPositions.length !== positions.length) {
    throw new Error(
      `Spatial-query positions for view "${exactViewId}" must have one exact point count.`
    );
  }
  const transparency = requireHighlightTransparency(
    owner.transparency,
    pointCount
  );
  const spatialIndex = owner.spatialIndex ?? null;
  if (
    spatialIndex !== null &&
    (
      typeof spatialIndex !== 'object' ||
      spatialIndex.pointCount !== pointCount ||
      spatialIndex.positions !== positions ||
      spatialIndex.dimensionLevel !== dimensionLevel ||
      typeof spatialIndex.visitRadiusCandidates !== 'function' ||
      typeof spatialIndex.visitProjectedRectCandidates !== 'function'
    )
  ) {
    throw new Error(
      `Spatial-query owner for view "${exactViewId}" has no exact matching index.`
    );
  }
  return {
    viewId: exactViewId,
    positions,
    publishedPositions,
    transparency,
    dimensionLevel,
    spatialIndex,
  };
}

function requireHighlightMatrix(matrix, label) {
  if (!(matrix instanceof Float32Array) || matrix.length !== 16) {
    throw new TypeError(`${label} must be a Float32Array with exactly 16 entries.`);
  }
  for (let i = 0; i < matrix.length; i++) {
    if (!Number.isFinite(matrix[i])) {
      throw new TypeError(`${label} must contain only finite numbers.`);
    }
  }
  return matrix;
}

function requireHighlightDirection(direction, label) {
  if (!(direction instanceof Float32Array) || direction.length !== 3) {
    throw new TypeError(`${label} must be a Float32Array with exactly 3 entries.`);
  }
  const squaredLength =
    direction[0] * direction[0] +
    direction[1] * direction[1] +
    direction[2] * direction[2];
  if (
    !Number.isFinite(squaredLength) ||
    Math.abs(squaredLength - 1) > 1e-5
  ) {
    throw new TypeError(`${label} must be a normalized finite direction.`);
  }
  return direction;
}

function requireFiniteHighlightNumber(value, label, positive = false) {
  if (!Number.isFinite(value) || (positive && value <= 0)) {
    const qualifier = positive ? 'positive finite' : 'finite';
    throw new TypeError(`${label} must be a ${qualifier} number.`);
  }
  return value;
}

/**
 * Clip an overlay drawing to the part of the canvas its pane presents, as
 * the WebGL scissor clips the pane's points: an indicator never spills under
 * the sidebar or into a neighbouring grid cell.
 */
function clipToPresentedPane(ctx, viewport) {
  ctx.beginPath();
  ctx.rect(
    viewport.visibleOffsetX,
    viewport.visibleOffsetY,
    viewport.visibleWidth,
    viewport.visibleHeight
  );
  ctx.clip();
}

function requireHighlightViewport(viewport, label) {
  if (!viewport || typeof viewport !== 'object' || Array.isArray(viewport)) {
    throw new TypeError(`${label} must be an exact viewport object.`);
  }

  requireHighlightViewId(viewport.viewId, `${label} viewId`);
  requireFiniteHighlightNumber(viewport.vpWidth, `${label} width`, true);
  requireFiniteHighlightNumber(viewport.vpHeight, `${label} height`, true);
  requireFiniteHighlightNumber(viewport.vpAspect, `${label} aspect`, true);
  requireFiniteHighlightNumber(viewport.vpOffsetX, `${label} X offset`);
  requireFiniteHighlightNumber(viewport.vpOffsetY, `${label} Y offset`);
  requireFiniteHighlightNumber(viewport.vpLocalX, `${label} local X`);
  requireFiniteHighlightNumber(viewport.vpLocalY, `${label} local Y`);
  requireFiniteHighlightNumber(
    viewport.visibleOffsetX,
    `${label} visible X offset`
  );
  requireFiniteHighlightNumber(
    viewport.visibleOffsetY,
    `${label} visible Y offset`
  );
  requireFiniteHighlightNumber(
    viewport.visibleWidth,
    `${label} visible width`,
    true
  );
  requireFiniteHighlightNumber(
    viewport.visibleHeight,
    `${label} visible height`,
    true
  );
  requireFiniteHighlightNumber(
    viewport.projectionCenterNdcX,
    `${label} projection center`
  );
  requireHighlightMatrix(viewport.projectionMatrix, `${label} projection matrix`);
  requireHighlightDirection(viewport.cameraForward, `${label} camera forward`);
  requireFiniteHighlightNumber(
    viewport.cameraTargetRadius,
    `${label} camera target radius`,
    true
  );
  if (viewport.effectiveViewMatrix !== null) {
    requireHighlightMatrix(
      viewport.effectiveViewMatrix,
      `${label} effective view matrix`
    );
  }
  return viewport;
}

function captureHighlightViewport(viewport, mat4, label) {
  const exactViewport = requireHighlightViewport(viewport, label);
  const projectionMatrix = mat4.create();
  mat4.copy(projectionMatrix, exactViewport.projectionMatrix);
  let effectiveViewMatrix = null;
  if (exactViewport.effectiveViewMatrix !== null) {
    effectiveViewMatrix = mat4.create();
    mat4.copy(
      effectiveViewMatrix,
      exactViewport.effectiveViewMatrix
    );
  }
  const cameraForward = new Float32Array(exactViewport.cameraForward);
  return {
    ...exactViewport,
    projectionMatrix,
    effectiveViewMatrix,
    cameraForward
  };
}

function requireHighlightData(highlightData, pointCount = null) {
  if (!(highlightData instanceof Uint8Array)) {
    throw new TypeError('Highlight data must be a Uint8Array.');
  }
  if (pointCount !== null && highlightData.length !== pointCount) {
    throw new RangeError(
      `Highlight data must contain exactly ${formatCountOf(pointCount, 'entry', 'entries')}.`
    );
  }
  return highlightData;
}

function requireHighlightGeometryGeneration(generation) {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new RangeError(
      'Highlight geometry generation must be a positive safe integer.'
    );
  }
  return generation;
}

function requireHighlightTransparencyGeneration(generation) {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError(
      'Highlight transparency generation must be a non-negative safe integer.'
    );
  }
  return generation;
}

function requireHighlightLodMembership(
  membership,
  pointCount,
  dimensionLevel
) {
  if (membership === null) return null;
  if (
    typeof membership !== 'object' ||
    Array.isArray(membership) ||
    !Object.isFrozen(membership) ||
    !(membership.admissionLevels instanceof Uint8Array) ||
    membership.admissionLevels.length !== pointCount ||
    !(membership.indices instanceof Uint32Array) ||
    membership.indices.length > pointCount ||
    membership.pointCount !== pointCount ||
    membership.dimensionLevel !== dimensionLevel ||
    !Number.isInteger(membership.lodLevel) ||
    membership.lodLevel < 0 ||
    membership.lodLevel >= 0xff ||
    membership.generationToken === null ||
    typeof membership.generationToken !== 'object' ||
    !Object.isFrozen(membership.generationToken)
  ) {
    throw new TypeError(
      'Highlight LOD membership must be null or one exact frozen renderer descriptor.'
    );
  }
  return membership;
}

const EMPTY_HIGHLIGHT_INDICES = new Uint32Array(0);
// Fixed staging block (1 MiB) every highlight store is packed through, so a
// publication allocates nothing proportional to the selection.
const HIGHLIGHT_STAGING_POINTS = 65_536;

function createHighlightStaging() {
  const buffer = new ArrayBuffer(HIGHLIGHT_STAGING_POINTS * 16);
  return {
    colorView: new Uint8Array(buffer),
    posView: new Float32Array(buffer),
    wordView: new Uint32Array(buffer),
  };
}

/**
 * A highlight record's colour word (RGB white, alpha the cell's intensity)
 * for each intensity byte, built from its bytes so either byte order holds.
 */
const HIGHLIGHT_COLOR_WORDS = (() => {
  const bytes = new Uint8Array(256 * 4);
  for (let intensity = 0; intensity < 256; intensity++) {
    bytes[intensity * 4] = 255;
    bytes[intensity * 4 + 1] = 255;
    bytes[intensity * 4 + 2] = 255;
    bytes[intensity * 4 + 3] = intensity;
  }
  return new Uint32Array(bytes.buffer);
})();

/**
 * Pack the admitted highlighted cells of `candidateIndices[from, ...)` into
 * the staging block, a record a cell (XYZ, the axes the embedding does not
 * have written as the zero they are, then the colour word), until the block
 * is full or the candidates end. The admission test is `rebuildBuffer`'s.
 * A function of its own so its loop is compiled for itself alone.
 *
 * @returns {number} The next candidate; the records written are in
 *   `packed[0]`.
 */
function packHighlightRecords(
  candidateIndices,
  from,
  iterateLodPrefix,
  highlightData,
  admissionLevels,
  activeLodLevel,
  transparency,
  positions,
  dimension,
  posView,
  wordView,
  packed
) {
  const capacity = HIGHLIGHT_STAGING_POINTS;
  const checkAdmission = !iterateLodPrefix && admissionLevels !== null;
  let slot = 0;
  let j = from;
  for (; j < candidateIndices.length && slot < capacity; j++) {
    const i = candidateIndices[j];
    if (iterateLodPrefix && highlightData[i] < MIN_VISIBLE_ALPHA_BYTE) continue;
    if (checkAdmission && admissionLevels[i] > activeLodLevel) continue;
    if (transparency[i] < POINT_VISIBILITY_THRESHOLD) continue;
    const record = slot * 4;
    const base = i * dimension;
    posView[record] = positions[base];
    posView[record + 1] = dimension > 1 ? positions[base + 1] : 0;
    posView[record + 2] = dimension > 2 ? positions[base + 2] : 0;
    wordView[record + 3] = HIGHLIGHT_COLOR_WORDS[highlightData[i]];
    slot++;
  }
  packed[0] = slot;
  return j;
}

/** How many of `candidateIndices` `packHighlightRecords` admits. */
function countHighlightRecords(
  candidateIndices,
  iterateLodPrefix,
  highlightData,
  admissionLevels,
  activeLodLevel,
  transparency
) {
  const checkAdmission = !iterateLodPrefix && admissionLevels !== null;
  let count = 0;
  for (let j = 0; j < candidateIndices.length; j++) {
    const i = candidateIndices[j];
    if (iterateLodPrefix && highlightData[i] < MIN_VISIBLE_ALPHA_BYTE) continue;
    if (checkAdmission && admissionLevels[i] > activeLodLevel) continue;
    if (transparency[i] < POINT_VISIBILITY_THRESHOLD) continue;
    count++;
  }
  return count;
}

/**
 * Bytes a highlight costs drawn from its own records (XYZ and a colour word)
 * and drawn from the point store (a colour word a slot of the store).
 */
const HIGHLIGHT_RECORD_BYTES = 16;
const HIGHLIGHT_SLOT_BYTES = 4;

/**
 * How many cells `packHighlightRecords` admits, counted in source order (a
 * sequential pass): highlighted, shown, and, with a reduced level of detail,
 * members of the level (`admissionLevels`, or null at full detail).
 * A function of its own so its loop is compiled for itself alone.
 */
function countAdmittedCells(highlightData, transparency, admissionLevels, activeLodLevel) {
  let count = 0;
  const n = highlightData.length;
  if (admissionLevels === null) {
    for (let i = 0; i < n; i++) {
      if (highlightData[i] >= MIN_VISIBLE_ALPHA_BYTE && transparency[i] >= POINT_VISIBILITY_THRESHOLD) count++;
    }
    return count;
  }
  for (let i = 0; i < n; i++) {
    if (
      highlightData[i] >= MIN_VISIBLE_ALPHA_BYTE
      && transparency[i] >= POINT_VISIBILITY_THRESHOLD
      && admissionLevels[i] <= activeLodLevel
    ) {
      count++;
    }
  }
  return count;
}

/** Records written by the last `packHighlightRecords`. */
const PACKED_RECORDS = new Int32Array(1);

export class HighlightRenderer {
  constructor(gl, hpRenderer, startTime) {
    this.gl = gl;
    this.hpRenderer = hpRenderer;
    this.startTime = startTime != null ? startTime : performance.now();

    // Shader program and locations
    this.program = createProgram(gl, HP_VS_HIGHLIGHT, HP_FS_HIGHLIGHT);
    this.attribLocations = {
      position: gl.getAttribLocation(this.program, 'a_position'),
      color: gl.getAttribLocation(this.program, 'a_color'),
    };
    this.uniformLocations = {
      modelViewMatrix: gl.getUniformLocation(this.program, 'u_modelViewMatrix'),
      projectionMatrix: gl.getUniformLocation(this.program, 'u_projectionMatrix'),
      pointSize: gl.getUniformLocation(this.program, 'u_pointSize'),
      sizeAttenuation: gl.getUniformLocation(this.program, 'u_sizeAttenuation'),
      pointScale: gl.getUniformLocation(this.program, 'u_pointScale'),
      highlightScale: gl.getUniformLocation(this.program, 'u_highlightScale'),
      highlightColor: gl.getUniformLocation(this.program, 'u_highlightColor'),
      ringWidth: gl.getUniformLocation(this.program, 'u_ringWidth'),
      haloStrength: gl.getUniformLocation(this.program, 'u_haloStrength'),
      haloShape: gl.getUniformLocation(this.program, 'u_haloShape'),
      ringStyle: gl.getUniformLocation(this.program, 'u_ringStyle'),
      time: gl.getUniformLocation(this.program, 'u_time'),
      glow: gl.getUniformLocation(this.program, 'u_glow'),
      fogNear: gl.getUniformLocation(this.program, 'u_fogNear'),
      fogScale: gl.getUniformLocation(this.program, 'u_fogScale'),
      lightingStrength: gl.getUniformLocation(this.program, 'u_lightingStrength'),
      lightDir: gl.getUniformLocation(this.program, 'u_lightDir'),
      halfDir: gl.getUniformLocation(this.program, 'u_halfDir'),
    };
    // Scratch for the per-draw products the shaders no longer form per vertex.
    this._shaderFrame = {
      modelView: new Float32Array(16),
      halfDir: new Float32Array(3),
      invCenterShade: 1,
    };

    // Per-view GPU buffer/VAO pairs + bookkeeping (fixes multi-view races and
    // keeps highlight attributes out of the viewer's shared default VAO).
    // LOD membership itself is shared by the spatial generation.
    this._viewBuffers = new Map();
    this._stagingBuffer = null;
    this._pendingBufferDeletes = new Set();
    this._pendingVertexArrayDeletes = new Set();
    this._pendingProgramDeletes = new Set();
    this._disposeStarted = false;
    this._disposed = false;

    // Track total highlighted count across all views (for UI feedback)
    this._totalHighlightedCount = 0;

    // Cache for highlighted cell indices - avoids scanning all cells on every rebuildBuffer
    // This dramatically improves performance when only a small fraction of cells are highlighted
    this._highlightedIndicesCache = null;  // Uint32Array (or adopted index list) of highlighted cells
    this._highlightDataRef = null;         // Reference to last highlightData array
    this._highlightDataVersion = 0;        // Incremented when cache is invalidated
    // Whether the cached publication set every listed cell to full intensity
    // (what the highlight state always publishes); see setHighlightedIndicesCache.
    this._cacheAtFullIntensity = false;

    // Visual style state (defaults mirror previous viewer.js values)
    this.highlightColor = [0.4, 0.85, 1.0];
    this.highlightScale = 1.8;
    this.highlightRingWidth = 0.40;
    this.highlightHaloStrength = 0.7;
    this.highlightHaloShape = 0.0;
    this.highlightRingStyle = 0.0;
    this.highlightAnimated = true;
    this._styleGeneration = 0;
    // A draw from a point store (`rebuildBuffer`): its slot-word pass and the
    // highlight bytes as a texture, both made on first use.
    this._slotWords = null;
    this._highlightTexture = null;
    // Off draws every highlight from records of its own: the reference the
    // draw from a point store is compared with (`setStoreDrawing`).
    this._storeDrawing = true;
    // Hands out `drawSerial`s: a view's serial changes whenever what its
    // highlight pass draws can change (see drawSerial).
    this._drawSerials = 0;

    this.highlightStylesByQuality = HIGHLIGHT_STYLES_BY_QUALITY;

    // The reported GPU total is only useful if it describes the whole context,
    // and these per-view buffers are the second largest allocation in it.
    this._gpuAllocationReporter = (add) => this.collectGpuAllocations(add);
    hpRenderer?.registerGpuAllocationReporter?.(this._gpuAllocationReporter);
  }

  _releaseGpuAllocationReporter() {
    this.hpRenderer?.unregisterGpuAllocationReporter?.(
      this._gpuAllocationReporter
    );
    this._gpuAllocationReporter = null;
  }

  /**
   * Tell the memory inventory that this renderer's accepted bytes moved.
   *
   * Called from exactly the two places `gpuByteLength` changes, so the figure
   * the stats display and the benchmark panel read is current without either
   * recomputing on every read or walking anything dataset-sized.
   */
  _publishGpuAllocationChange() {
    this.hpRenderer?.notifyGpuAllocationsChanged?.();
  }

  setQuality(quality) {
    const style = this.highlightStylesByQuality[requireHighlightQuality(quality)];
    const changed =
      this.highlightScale !== style.scale ||
      this.highlightRingWidth !== style.ringWidth ||
      this.highlightHaloStrength !== style.haloStrength ||
      this.highlightHaloShape !== style.haloShape ||
      this.highlightRingStyle !== style.ringStyle ||
      this.highlightAnimated !== style.animated;
    this.highlightScale = style.scale;
    this.highlightRingWidth = style.ringWidth;
    this.highlightHaloStrength = style.haloStrength;
    this.highlightHaloShape = style.haloShape;
    this.highlightRingStyle = style.ringStyle;
    this.highlightAnimated = style.animated;
    if (changed) this._styleGeneration++;
    return changed;
  }

  setStyle(options = {}) {
    let changed = false;
    if (options.color && this.highlightColor !== options.color) {
      this.highlightColor = options.color;
      changed = true;
    }
    if (
      options.scale != null &&
      this.highlightScale !== options.scale
    ) {
      this.highlightScale = options.scale;
      changed = true;
    }
    if (
      options.ringWidth != null &&
      this.highlightRingWidth !== options.ringWidth
    ) {
      this.highlightRingWidth = options.ringWidth;
      changed = true;
    }
    if (
      options.haloStrength != null &&
      this.highlightHaloStrength !== options.haloStrength
    ) {
      this.highlightHaloStrength = options.haloStrength;
      changed = true;
    }
    if (
      options.haloShape != null &&
      this.highlightHaloShape !== options.haloShape
    ) {
      this.highlightHaloShape = options.haloShape;
      changed = true;
    }
    if (changed) this._styleGeneration++;
    return changed;
  }

  /**
   * Update or invalidate the highlighted indices cache.
   * Call this when highlight data changes to enable fast iteration in rebuildBuffer.
   * @param {Uint8Array} highlightData - Highlight intensity per cell
   * @param {boolean} [forceRebuild=false] - Force full cache rebuild
   */
  updateHighlightCache(highlightData, forceRebuild = false) {
    // Handle null/undefined highlight data
    if (!highlightData) {
      if (this._highlightedIndicesCache !== null || this._highlightDataRef !== null) {
        this._highlightedIndicesCache = EMPTY_HIGHLIGHT_INDICES;
        this._highlightDataRef = null;
        this._cacheAtFullIntensity = false;
        this._highlightDataVersion++;
      }
      return;
    }

    // Check if we need to rebuild the cache:
    // 1. Force rebuild requested
    // 2. Cache doesn't exist
    // 3. Reference changed (different array)
    const needsRebuild = forceRebuild ||
      this._highlightedIndicesCache === null ||
      this._highlightDataRef !== highlightData;

    if (!needsRebuild) return;

    // Build new cache by scanning all cells: count, then fill an exact typed
    // owner, so a whole-dataset selection costs 4 bytes a cell with no growth.
    const len = highlightData.length;
    let count = 0;
    for (let i = 0; i < len; i++) {
      if (highlightData[i] >= MIN_VISIBLE_ALPHA_BYTE) count++;
    }
    const indices = new Uint32Array(count);
    let write = 0;
    for (let i = 0; i < len && write < count; i++) {
      if (highlightData[i] >= MIN_VISIBLE_ALPHA_BYTE) {
        indices[write++] = i;
      }
    }

    this._highlightedIndicesCache = indices;
    this._highlightDataRef = highlightData;
    this._cacheAtFullIntensity = false;
    this._highlightDataVersion++;
  }

  /**
   * Invalidate the highlight cache (call when highlight array contents change in-place)
   * The public updateHighlight lifecycle is the exact mutation boundary for
   * the caller-owned Uint8Array, so invalidation is generation-based rather
   * than an inaccurate sampled content hash.
   */
  invalidateHighlightCache() {
    this._highlightedIndicesCache = null;
    this._cacheAtFullIntensity = false;
    this._highlightDataVersion++;
  }

  /**
   * Directly set the highlighted indices cache (avoids O(n) full-array scan).
   * Call this when you already know which indices are highlighted (e.g., from state.js groups).
   *
   * Both the index list and `highlightData` are adopted by reference. That is
   * the same ownership rule the caller-owned `Uint8Array` has always followed:
   * `updateHighlight` is the exact mutation boundary, and a publication that
   * changes the set publishes a new list rather than editing the accepted one.
   * Copying the list here instead would allocate a second whole-dataset array
   * on every apply for no additional protection.
   *
   * @param {number[]|Uint32Array} indices - Highlighted cell indices, validated
   *   by the caller and not mutated after publication.
   * @param {Uint8Array} highlightData - Reference to the highlight data array
   */
  setHighlightedIndicesCache(indices, highlightData, fullIntensity = false) {
    // A lasso, proximity or KNN preview republishes on every pointer move,
    // mostly with the same cells. A publication into the same data array,
    // listing the same cells in the same order, every one at full intensity
    // as before, is the same picture: keep the generation, so no view
    // repacks or re-uploads its buffer and nothing redraws. The list must be
    // a new array to be compared; the same array object may have been
    // rewritten in place.
    const previous = this._highlightedIndicesCache;
    if (
      fullIntensity &&
      this._cacheAtFullIntensity &&
      this._highlightDataRef === highlightData &&
      previous !== null &&
      previous !== indices &&
      previous.length === indices.length
    ) {
      let same = true;
      for (let i = 0; i < indices.length; i++) {
        if (previous[i] !== indices[i]) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }
    this._highlightedIndicesCache = indices;
    this._highlightDataRef = highlightData;
    this._cacheAtFullIntensity = fullIntensity;
    this._highlightDataVersion++;
    return true;
  }

  _createViewBufferRecord() {
    return {
      buffer: null,
      dimensionLevel: 0,
      drawFailure: null,
      // Vertices the draw submits: the records, or every slot of the point
      // store the highlight is drawn from (`storeBuffer`, in the order
      // `storeSlotSources`), most of them rejected.
      drawCount: 0,
      storeBuffer: null,
      storeSlotSources: null,
      // The view's visibility bytes as a texture, for a draw from the store.
      visibleTexture: null,
      // What the VAO's attributes point at: the record buffer, or the store
      // (of `layoutDimension` components a point).
      layoutSource: null,
      layoutDimension: 0,
      // See drawSerial.
      drawSerial: 0,
      drawStyleGeneration: -1,
      failedPublication: null,
      geometryGeneration: 0,
      // Byte length of the accepted GPU data store, tracked separately from
      // `pointCount` because a failed publication revokes the draw count while
      // deliberately retaining the allocation for a later retry.
      gpuByteLength: 0,
      // Largest store size WebGL has accepted for this buffer with the error
      // queue checked; see `rebuildBuffer`.
      verifiedByteLength: 0,
      highlightGeneration: -1,
      lodMembership: null,
      pointCount: 0,
      published: false,
      transparencyGeneration: -1,
      vertexArray: null,
    };
  }

  /**
   * Report every GPU data store this renderer owns to a memory inventory.
   *
   * The highlight buffers are per view and hold sixteen bytes for every
   * selected and visible cell, which at whole-dataset selections is larger
   * than either of the renderer's point streams (12 and 4 bytes a point). They
   * are reported here because `HighPerfRenderer._refreshGpuMemoryStats` — which
   * feeds `stats.gpuMemoryMB`, the stats display and the benchmark panel — can
   * only inventory handles it owns, and these are not among them.
   *
   * Retired buffers are deliberately not reported: every path that detaches one
   * flushes the deletion inside the same synchronous operation and throws if
   * WebGL refuses, so there is no steady state in which a retired highlight
   * buffer is resident but unreported.
   *
   * @param {(handle: unknown, byteLength: number) => void} add - Inventory sink
   *   that deduplicates by WebGL handle.
   */
  collectGpuAllocations(add) {
    if (typeof add !== 'function') {
      throw new TypeError(
        'Highlight GPU allocation inventory requires an exact sink function.'
      );
    }
    for (const viewBuffer of this._viewBuffers.values()) {
      const visible = viewBuffer.visibleTexture ?? null;
      if (visible !== null) add(visible.texture, visible.byteLength);
      if (viewBuffer.buffer === null) continue;
      add(viewBuffer.buffer, viewBuffer.gpuByteLength);
    }
    if (this._highlightTexture) add(this._highlightTexture.texture, this._highlightTexture.byteLength);
  }

  _queueViewResourceHandles(buffer, vertexArray) {
    if (vertexArray !== null) {
      this._pendingVertexArrayDeletes.add(vertexArray);
    }
    if (buffer !== null) {
      this._pendingBufferDeletes.add(buffer);
    }
  }

  _detachViewResources(viewBuffer) {
    const buffer = viewBuffer.buffer;
    const vertexArray = viewBuffer.vertexArray;
    const visible = viewBuffer.visibleTexture ?? null;
    if (visible !== null) {
      viewBuffer.visibleTexture = null;
      deleteTextureTracked(this.gl, visible.texture);
    }
    // Detach the complete logical pair before either deletion can fail.
    viewBuffer.buffer = null;
    viewBuffer.vertexArray = null;
    viewBuffer.gpuByteLength = 0;
    viewBuffer.verifiedByteLength = 0;
    this._queueViewResourceHandles(buffer, vertexArray);
    this._publishGpuAllocationChange();
  }

  _publicationFailureMatches(
    viewBuffer,
    lodMembership,
    geometryGeneration,
    dimensionLevel,
    transparencyGeneration
  ) {
    const failed = viewBuffer?.failedPublication;
    return (
      failed !== null &&
      failed !== undefined &&
      failed.highlightGeneration === this._highlightDataVersion &&
      failed.geometryGeneration === geometryGeneration &&
      failed.dimensionLevel === dimensionLevel &&
      failed.lodMembership === lodMembership &&
      failed.transparencyGeneration === transparencyGeneration
    );
  }

  /**
   * Fence one failed compact-buffer publication until a meaningful semantic
   * generation changes. Failure records are allocated only on the exceptional
   * path; successful animation frames compare scalar/reference certificates.
   */
  recordPublicationFailure(
    lodMembership,
    viewId,
    geometryGeneration,
    dimensionLevel,
    transparencyGeneration
  ) {
    const vid = requireHighlightViewId(viewId);
    const exactDimensionLevel =
      requireHighlightDimension(dimensionLevel);
    const exactGeometryGeneration =
      requireHighlightGeometryGeneration(geometryGeneration);
    const exactTransparencyGeneration =
      requireHighlightTransparencyGeneration(transparencyGeneration);
    const pointCount = this._highlightDataRef?.length ?? null;
    const exactMembership = requireHighlightLodMembership(
      lodMembership,
      pointCount,
      exactDimensionLevel
    );
    let viewBuffer = this._viewBuffers.get(vid);
    if (viewBuffer === undefined) {
      viewBuffer = this._createViewBufferRecord();
      this._viewBuffers.set(vid, viewBuffer);
    }
    viewBuffer.failedPublication = {
      dimensionLevel: exactDimensionLevel,
      geometryGeneration: exactGeometryGeneration,
      highlightGeneration: this._highlightDataVersion,
      lodMembership: exactMembership,
      transparencyGeneration: exactTransparencyGeneration,
    };
    // Retain the accepted buffer/VAO allocation for a later semantic retry,
    // but revoke its draw count immediately. Drawing the previous generation
    // after a failed geometry/LOD/filter publication would present stale cells.
    viewBuffer.drawFailure = null;
    viewBuffer.pointCount = 0;
    viewBuffer.drawCount = 0;
    viewBuffer.drawSerial = ++this._drawSerials;
    this._recomputeTotalHighlightedCount();
  }

  _commitEmptyViewBuffer(
    viewBuffer,
    lodMembership,
    geometryGeneration,
    dimensionLevel,
    transparencyGeneration
  ) {
    if (
      viewBuffer.buffer !== null ||
      viewBuffer.vertexArray !== null
    ) {
      // Commit the non-drawable state before the first fallible GL call. Even
      // hostile deletion failures must never leave stale highlights dispatchable.
      this._detachViewResources(viewBuffer);
    }

    viewBuffer.dimensionLevel = dimensionLevel;
    viewBuffer.drawFailure = null;
    viewBuffer.failedPublication = null;
    viewBuffer.geometryGeneration = geometryGeneration;
    viewBuffer.highlightGeneration = this._highlightDataVersion;
    viewBuffer.lodMembership = lodMembership;
    viewBuffer.pointCount = 0;
    viewBuffer.drawCount = 0;
    viewBuffer.storeBuffer = null;
    viewBuffer.storeSlotSources = null;
    viewBuffer.published = true;
    viewBuffer.transparencyGeneration = transparencyGeneration;
    viewBuffer.drawSerial = ++this._drawSerials;
  }

  _publishEmptyViewBuffer(
    viewBuffer,
    viewId,
    lodMembership,
    geometryGeneration,
    dimensionLevel,
    transparencyGeneration
  ) {
    this._commitEmptyViewBuffer(
      viewBuffer,
      lodMembership,
      geometryGeneration,
      dimensionLevel,
      transparencyGeneration
    );
    this._recomputeTotalHighlightedCount();

    // A semantic publication retries any previously retained GPU owner once.
    // Exact cache-hit frames below do not turn hostile cleanup into a RAF storm.
    if (
      this._pendingBufferDeletes.size > 0 ||
      this._pendingVertexArrayDeletes.size > 0
    ) {
      const failures = this._flushPendingResourceDeletes();
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Empty highlight publication for view "${viewId}" retains ${failures.length} pending GPU retirement failure(s).`
        );
      }
    }
  }

  /**
   * Return whether one exact per-view compact buffer generation is stale.
   */
  needsRefresh(
    lodMembership,
    viewId,
    geometryGeneration,
    dimensionLevel,
    transparencyGeneration
  ) {
    const vid = requireHighlightViewId(viewId);
    const exactDimensionLevel =
      requireHighlightDimension(dimensionLevel);
    const exactGeometryGeneration =
      requireHighlightGeometryGeneration(geometryGeneration);
    const exactTransparencyGeneration =
      requireHighlightTransparencyGeneration(transparencyGeneration);
    const pointCount = this._highlightDataRef?.length ?? null;
    const exactMembership = requireHighlightLodMembership(
      lodMembership,
      pointCount,
      exactDimensionLevel
    );
    const viewBuffer = this._viewBuffers.get(vid);

    if (
      this._publicationFailureMatches(
        viewBuffer,
        exactMembership,
        exactGeometryGeneration,
        exactDimensionLevel,
        exactTransparencyGeneration
      )
    ) {
      return false;
    }

    return (
      viewBuffer === undefined ||
      viewBuffer.published !== true ||
      this._pointStoreMoved(vid, viewBuffer) ||
      viewBuffer.highlightGeneration !== this._highlightDataVersion ||
      viewBuffer.geometryGeneration !== exactGeometryGeneration ||
      viewBuffer.dimensionLevel !== exactDimensionLevel ||
      viewBuffer.lodMembership !== exactMembership ||
      viewBuffer.transparencyGeneration !==
        exactTransparencyGeneration ||
      (
        viewBuffer.pointCount > 0 &&
        (
          viewBuffer.buffer === null ||
          viewBuffer.vertexArray === null
        )
      )
    );
  }

  /**
   * Publish an exact empty highlight generation without consulting LOD or
   * geometry owners. This retires stale draw counts and remains a cache hit on
   * subsequent empty frames while allocating no CPU/GPU point storage.
   */
  publishEmptyView(viewId) {
    const vid = requireHighlightViewId(viewId);
    let viewBuffer = this._viewBuffers.get(vid);
    if (
      viewBuffer?.published === true &&
      viewBuffer.pointCount === 0 &&
      viewBuffer.highlightGeneration === this._highlightDataVersion &&
      viewBuffer.dimensionLevel === 0 &&
      viewBuffer.geometryGeneration === 0 &&
      viewBuffer.lodMembership === null &&
      viewBuffer.transparencyGeneration === -1
    ) {
      return false;
    }
    if (viewBuffer === undefined) {
      viewBuffer = this._createViewBufferRecord();
      this._viewBuffers.set(vid, viewBuffer);
    }
    this._publishEmptyViewBuffer(
      viewBuffer,
      vid,
      null,
      0,
      0,
      -1
    );
    return true;
  }

  /**
   * Publish the current empty highlight generation to every existing view.
   *
   * Hidden/focused-out panes do not participate in the render loop, so waiting
   * for their next frame can retain one dataset-sized compact buffer per pane.
   * Detach every logical owner before attempting any fallible WebGL deletion.
   */
  publishEmptyViews() {
    const pendingPublications = [];
    for (const [viewId, viewBuffer] of this._viewBuffers) {
      if (
        viewBuffer.published === true &&
        viewBuffer.pointCount === 0 &&
        viewBuffer.highlightGeneration === this._highlightDataVersion &&
        viewBuffer.dimensionLevel === 0 &&
        viewBuffer.geometryGeneration === 0 &&
        viewBuffer.lodMembership === null &&
        viewBuffer.transparencyGeneration === -1
      ) continue;
      pendingPublications.push([viewId, viewBuffer]);
    }
    if (pendingPublications.length === 0) return false;

    // `_publishEmptyViewBuffer` normally flushes after committing one view.
    // Temporarily detach all buffers first so one hostile delete cannot leave a
    // later hidden pane drawable under the superseded highlight generation.
    for (const [viewId, viewBuffer] of pendingPublications) {
      this._commitEmptyViewBuffer(
        viewBuffer,
        null,
        0,
        0,
        -1
      );
    }
    this._recomputeTotalHighlightedCount();

    const failures = this._flushPendingResourceDeletes();
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Empty highlight publication across ${formatCountOf(pendingPublications.length, 'view')} retains ${failures.length} pending GPU retirement failure(s).`
      );
    }
    return true;
  }

  /**
   * Rebuild the highlight buffer with positions of highlighted cells.
   * Only includes cells that are both highlighted AND visible (LOD + frustum + filtering).
   *
   * Per-view transparency is now respected: cells filtered out in a view will NOT
   * show highlights in that view. This ensures View A's highlights don't leak into
   * View B when those cells are filtered out in View B.
   *
   * Now supports per-view buffers for multi-view rendering.
   * @param {Uint8Array} highlightData - Highlight intensity per cell
   * @param {Float32Array} positions - Position data
   * @param {Object|null} lodMembership - Shared exact LOD descriptor, or null
   * @param {string} viewId - Exact view ID
   * @param {Uint8Array} viewTransparency - Exact per-view transparency
   * @param {number} geometryGeneration - Exact renderer geometry generation
   * @param {number} dimensionLevel - Exact view dimension
   * @param {number} transparencyGeneration - Exact filtering generation
   */
  rebuildBuffer(
    highlightData,
    positions,
    lodMembership,
    viewId,
    viewTransparency,
    geometryGeneration,
    dimensionLevel,
    transparencyGeneration
  ) {
    const gl = this.gl;
    const vid = requireHighlightViewId(viewId);
    const exactDimensionLevel =
      requireHighlightDimension(dimensionLevel);
    const exactPositions = positions;
    const pointCount = requireHighlightPositions(
      exactPositions,
      exactDimensionLevel
    );
    const exactHighlightData = requireHighlightData(highlightData, pointCount);
    const exactMembership = requireHighlightLodMembership(
      lodMembership,
      pointCount,
      exactDimensionLevel
    );
    const exactTransparency = requireHighlightTransparency(
      viewTransparency,
      pointCount
    );
    const exactGeometryGeneration =
      requireHighlightGeometryGeneration(geometryGeneration);
    const exactTransparencyGeneration =
      requireHighlightTransparencyGeneration(transparencyGeneration);

    // Use cached highlighted indices for fast iteration (avoids scanning all 10M+ cells)
    // Cache is rebuilt only at the exact updateHighlight publication boundary.
    this.updateHighlightCache(exactHighlightData);
    const highlightedIndices = this._highlightedIndicesCache;
    const admissionLevels =
      exactMembership?.admissionLevels ?? null;
    const activeLodLevel =
      exactMembership?.lodLevel ?? -1;
    const lodIndices = exactMembership?.indices ?? null;
    const iterateLodPrefix =
      lodIndices !== null &&
      lodIndices.length < highlightedIndices.length;
    const candidateIndices = iterateLodPrefix
      ? lodIndices
      : highlightedIndices;

    // Get or create per-view buffer entry
    let viewBuffer = this._viewBuffers.get(vid);
    if (!viewBuffer) {
      viewBuffer = this._createViewBufferRecord();
      this._viewBuffers.set(vid, viewBuffer);
    }

    // Two exact ways to draw the same rings: from records of their own (XYZ
    // gathered from the source positions, a colour word), in the candidates'
    // order, or from the view's point store, in the store's order (with a
    // reduced level of detail the candidates are the level's members in that
    // very order), with a colour word for each of its slots, written on the GPU
    // from the highlight and visibility bytes, and the cells not admitted
    // rejected by the vertex shader. The second is taken when it writes no
    // more bytes than the first: gathering millions of positions on the CPU
    // is most of a highlight of every cell (10M: 72 ms, and the store is
    // cleared by the GPU process before it is written: 54 ms more).
    const store = this._storeDrawing
      ? this._slotStoreFor(vid, exactPositions, exactDimensionLevel, exactMembership)
      : null;
    const fromStore = store !== null
      && candidateIndices.length * HIGHLIGHT_RECORD_BYTES >= store.slots * HIGHLIGHT_SLOT_BYTES;
    let count;
    if (fromStore) {
      count = countAdmittedCells(
        exactHighlightData,
        exactTransparency,
        exactMembership === null ? null : admissionLevels,
        activeLodLevel
      );
    } else {
      // Count visible highlighted cells using cached indices
      // Frustum clipping remains GPU-owned; CPU packing applies only the shared
      // LOD prefix and the exact point-shader alpha boundary.
      count = countHighlightRecords(
        candidateIndices,
        iterateLodPrefix,
        exactHighlightData,
        admissionLevels,
        activeLodLevel,
        exactTransparency
      );
    }

    if (count === 0) {
      this._publishEmptyViewBuffer(
        viewBuffer,
        vid,
        exactMembership,
        exactGeometryGeneration,
        exactDimensionLevel,
        exactTransparencyGeneration
      );
      return;
    }

    const BYTES_PER_POINT = HIGHLIGHT_RECORD_BYTES;
    const byteLength = fromStore ? store.slots * HIGHLIGHT_SLOT_BYTES : count * BYTES_PER_POINT;

    const hasBuffer = viewBuffer.buffer !== null;
    const hasVertexArray = viewBuffer.vertexArray !== null;
    if (hasBuffer !== hasVertexArray) {
      throw new Error(
        `Highlight view "${vid}" has an incomplete GPU buffer/VAO pair.`
      );
    }

    const isInitialPublication = !hasBuffer;
    // `gl.getError()` is a synchronous round trip to the GPU process that
    // waits for every queued command, including the previous frame's point
    // draws: three checks here cost 104 ms of a 199 ms highlight at
    // 10,000,000 points. One is taken, after the store is sized, where the
    // failure it detects can appear -- a first allocation, or one larger than
    // any this buffer has already been verified to hold, which is where
    // OUT_OF_MEMORY lives -- and none when the same store is re-sized at or
    // below a size WebGL has already accepted for it. The writes around it
    // allocate nothing, so only a lost context can refuse them. Any failed
    // publication resets the watermark, so the next one verifies again.
    const verifyPublication =
      isInitialPublication || byteLength > viewBuffer.verifiedByteLength;
    // A store drawn from keeps its size when it is large enough: the pass
    // writes the slots it needs.
    const resize = !fromStore || isInitialPublication || viewBuffer.gpuByteLength < byteLength;
    const storeBytes = resize ? byteLength : viewBuffer.gpuByteLength;
    let candidateBuffer = viewBuffer.buffer;
    let candidateVertexArray = viewBuffer.vertexArray;
    let publicationError = null;
    const restorationFailures = [];
    requireLiveContext(
      gl,
      `Highlight buffer publication for view "${vid}" preflight`
    );
    try {
      if (isInitialPublication) {
        candidateBuffer = gl.createBuffer();
        if (!candidateBuffer) {
          requireCleanWebGLState(
            gl,
            `Highlight buffer allocation for view "${vid}"`
          );
          throw new Error(
            `Unable to allocate the highlight buffer for view "${vid}".`
          );
        }
        candidateVertexArray = gl.createVertexArray();
        if (!candidateVertexArray) {
          requireCleanWebGLState(
            gl,
            `Highlight vertex-array allocation for view "${vid}"`
          );
          throw new Error(
            `Unable to allocate the highlight vertex array for view "${vid}".`
          );
        }
      }

      gl.bindVertexArray(candidateVertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, candidateBuffer);
      if (fromStore) {
        if (resize) {
          gl.bufferData(gl.ARRAY_BUFFER, byteLength, gl.DYNAMIC_DRAW);
          if (verifyPublication) {
            requireCleanWebGLState(
              gl,
              `Highlight buffer allocation for view "${vid}"`
            );
          }
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindVertexArray(null);
        this._slotWordWriter().writeHighlightWords(
          candidateBuffer,
          store.slots,
          store.order,
          this._highlightByteTexture(exactHighlightData),
          this._visibleByteTexture(viewBuffer, exactTransparency, exactTransparencyGeneration),
          MIN_VISIBLE_ALPHA_BYTE
        );
        gl.bindVertexArray(candidateVertexArray);
        gl.bindBuffer(gl.ARRAY_BUFFER, candidateBuffer);
      } else {
        // Size the store first. WebGL 2 leaves the accepted data store untouched
        // when this call fails, and the size is validated before any chunk is
        // written into it, so replacement OOM remains retryable without
        // retaining a second GPU buffer.
        gl.bufferData(gl.ARRAY_BUFFER, byteLength, gl.DYNAMIC_DRAW);
        if (verifyPublication) {
          requireCleanWebGLState(
            gl,
            `Highlight buffer allocation for view "${vid}"`
          );
        }
        this._uploadHighlightChunks(
          candidateIndices,
          iterateLodPrefix,
          exactHighlightData,
          admissionLevels,
          activeLodLevel,
          exactTransparency,
          exactPositions,
          exactDimensionLevel
        );
      }
      // The attribute layout of the source drawn from, set when the VAO is
      // new or its source changed (records, or which store).
      const layoutSource = fromStore ? store.buffer : candidateBuffer;
      if (isInitialPublication || viewBuffer.layoutSource !== layoutSource
        || viewBuffer.layoutDimension !== exactDimensionLevel) {
        if (fromStore) {
          // The axes a store does not have read as 0, as records write them.
          gl.bindBuffer(gl.ARRAY_BUFFER, store.buffer);
          gl.enableVertexAttribArray(this.attribLocations.position);
          gl.vertexAttribPointer(
            this.attribLocations.position,
            exactDimensionLevel,
            gl.FLOAT,
            false,
            exactDimensionLevel * 4,
            0
          );
          gl.bindBuffer(gl.ARRAY_BUFFER, candidateBuffer);
          gl.enableVertexAttribArray(this.attribLocations.color);
          gl.vertexAttribPointer(
            this.attribLocations.color,
            4,
            gl.UNSIGNED_BYTE,
            true,
            HIGHLIGHT_SLOT_BYTES,
            0
          );
        } else {
          gl.enableVertexAttribArray(this.attribLocations.position);
          gl.vertexAttribPointer(
            this.attribLocations.position,
            3,
            gl.FLOAT,
            false,
            BYTES_PER_POINT,
            0
          );
          gl.enableVertexAttribArray(this.attribLocations.color);
          gl.vertexAttribPointer(
            this.attribLocations.color,
            4,
            gl.UNSIGNED_BYTE,
            true,
            BYTES_PER_POINT,
            12
          );
        }
      }
      requireLiveContext(
        gl,
        `Highlight buffer publication for view "${vid}"`
      );
    } catch (error) {
      publicationError = error;
    } finally {
      try {
        gl.bindVertexArray(null);
      } catch (error) {
        restorationFailures.push(error);
      }
      try {
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
      } catch (error) {
        restorationFailures.push(error);
      }
    }

    if (
      publicationError !== null ||
      restorationFailures.length > 0
    ) {
      viewBuffer.verifiedByteLength = 0;
      if (isInitialPublication) {
        this._queueViewResourceHandles(
          candidateBuffer,
          candidateVertexArray
        );
      }
      const cleanupFailures = isInitialPublication
        ? this._flushPendingResourceDeletes()
        : [];
      const failures = [
        ...(publicationError === null ? [] : [publicationError]),
        ...restorationFailures,
        ...cleanupFailures,
      ];
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(
        failures,
        `Highlight buffer/VAO publication for view "${vid}" failed with ${failures.length - 1} restoration or retirement failure(s).`
      );
    }

    if (isInitialPublication) {
      viewBuffer.buffer = candidateBuffer;
      viewBuffer.vertexArray = candidateVertexArray;
    }

    viewBuffer.dimensionLevel = exactDimensionLevel;
    viewBuffer.drawFailure = null;
    viewBuffer.failedPublication = null;
    viewBuffer.geometryGeneration = exactGeometryGeneration;
    // `bufferData` replaced the whole data store, so the accepted allocation is
    // exactly the bytes just uploaded.
    const gpuByteLengthChanged =
      viewBuffer.gpuByteLength !== storeBytes;
    viewBuffer.gpuByteLength = storeBytes;
    if (verifyPublication && resize) viewBuffer.verifiedByteLength = byteLength;
    viewBuffer.highlightGeneration = this._highlightDataVersion;
    viewBuffer.lodMembership = exactMembership;
    viewBuffer.pointCount = count;
    viewBuffer.drawCount = fromStore ? store.slots : count;
    viewBuffer.layoutSource = fromStore ? store.buffer : viewBuffer.buffer;
    viewBuffer.layoutDimension = exactDimensionLevel;
    viewBuffer.storeBuffer = fromStore ? store.buffer : null;
    viewBuffer.storeSlotSources = fromStore ? store.slotSources : null;
    viewBuffer.published = true;
    viewBuffer.transparencyGeneration =
      exactTransparencyGeneration;
    viewBuffer.drawSerial = ++this._drawSerials;

    // Recompute total count across all views for UI feedback
    this._recomputeTotalHighlightedCount();
    // A republication at the same size is the common case during camera motion
    // and leaves the reported total unchanged, so it is not worth an inventory.
    if (gpuByteLengthChanged) this._publishGpuAllocationChange();
  }

  /**
   * Pack the admitted highlighted cells into the bound, already sized store
   * through one fixed staging block, in candidate order. The admission test is
   * the one `rebuildBuffer` counted with, so exactly `count` cells are written.
   * @private
   */
  _uploadHighlightChunks(
    candidateIndices,
    iterateLodPrefix,
    highlightData,
    admissionLevels,
    activeLodLevel,
    transparency,
    positions,
    dimension
  ) {
    const gl = this.gl;
    this._stagingBuffer ??= createHighlightStaging();
    const { colorView, posView, wordView } = this._stagingBuffer;
    let writtenBytes = 0;
    let next = 0;
    while (next < candidateIndices.length) {
      next = packHighlightRecords(
        candidateIndices,
        next,
        iterateLodPrefix,
        highlightData,
        admissionLevels,
        activeLodLevel,
        transparency,
        positions,
        dimension,
        posView,
        wordView,
        PACKED_RECORDS
      );
      const slots = PACKED_RECORDS[0];
      if (slots > 0) {
        gl.bufferSubData(gl.ARRAY_BUFFER, writtenBytes, colorView, 0, slots * 16);
        writtenBytes += slots * 16;
      }
    }
  }


  /**
   * Recompute total highlighted count across all views.
   * Called when a view's buffer is rebuilt.
   * @private
   */
  _recomputeTotalHighlightedCount() {
    let total = 0;
    for (const viewBuffer of this._viewBuffers.values()) {
      total += viewBuffer.pointCount || 0;
    }
    this._totalHighlightedCount = total;
  }

  /**
   * Get point count for a specific view, or total count if no viewId specified
   * @param {string} [viewId] - View ID (optional, returns total count if not specified)
   */
  getPointCount(viewId) {
    const viewBuffer = this._viewBuffers.get(requireHighlightViewId(viewId));
    return viewBuffer ? viewBuffer.pointCount : 0;
  }

  getTotalPointCount() {
    return this._totalHighlightedCount;
  }

  /**
   * Whether the drawn highlights change with time. Only an animated style
   * (HIGHLIGHT_STYLES_BY_QUALITY) pulses and shimmers (`u_glow`, `u_time` in
   * HP_FS_HIGHLIGHT); the others are a still picture, and a still picture must
   * not keep the viewer redrawing every point every frame.
   */
  isAnimated() {
    return this._totalHighlightedCount > 0 && this.highlightAnimated === true;
  }

  /**
   * A number that changes whenever what this view's highlight pass draws can
   * change other than by the frame time: its records (published, emptied,
   * revoked after a failed publication) or the style. Equal serials mean
   * equal draws at equal times; the antialiased pulse relies on it to know
   * the rings it drew last frame (pulse-sample-mask.js).
   */
  drawSerial(viewId) {
    const viewBuffer = this._viewBuffers.get(requireHighlightViewId(viewId));
    if (viewBuffer === undefined) return 0;
    if (viewBuffer.drawStyleGeneration !== this._styleGeneration) {
      viewBuffer.drawStyleGeneration = this._styleGeneration;
      viewBuffer.drawSerial = ++this._drawSerials;
    }
    return viewBuffer.drawSerial;
  }

  /**
   * Start compiling the pass that writes a point store's slot words, so the
   * first highlight drawn from a store does not wait for it.
   */
  prepareStoreDrawing() {
    this._slotWordWriter().prewarm(['highlight']);
  }

  /**
   * Draw highlights from point stores where that is cheaper (on, the
   * default), or always from records of their own. Every view republishes.
   */
  setStoreDrawing(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Highlight store drawing must be an exact boolean.');
    this._storeDrawing = enabled;
    for (const viewBuffer of this._viewBuffers.values()) viewBuffer.published = false;
  }

  /** Views whose highlights are drawn from their point store now. */
  getStoreDrawnViewCount() {
    let count = 0;
    for (const viewBuffer of this._viewBuffers.values()) {
      if ((viewBuffer.storeBuffer ?? null) !== null && viewBuffer.pointCount > 0) count++;
    }
    return count;
  }

  /**
   * The view's point store, when the highlights can be drawn from it: it
   * holds exactly `positions` (`dimension` components a point) and, with a
   * reduced level of detail, the level's members are its first slots, in
   * their order. `slots` is what the draw submits. Null otherwise.
   * @private
   */
  _slotStoreFor(viewId, positions, dimension, membership) {
    const store = this.hpRenderer?.getViewPointStore?.(viewId) ?? null;
    if (store === null || store.positions !== positions || store.dimension !== dimension) return null;
    if (membership === null) {
      return {
        buffer: store.buffer,
        slotSources: store.slotSources,
        order: store.order,
        slots: positions.length / dimension,
      };
    }
    const prefix = membership.indices;
    const sources = store.slotSources;
    if (sources === null || prefix.buffer !== sources.buffer || prefix.byteOffset !== sources.byteOffset) {
      return null;
    }
    return { buffer: store.buffer, slotSources: sources, order: store.order, slots: prefix.length };
  }

  /** The transform-feedback pass that writes slot words (created on first use). @private */
  _slotWordWriter() {
    this._slotWords ??= new GpuPermuter(this.gl);
    return this._slotWords;
  }

  /**
   * An R8UI linear texture holding `bytes` (a byte a source point), written
   * again only when `bytes` or `version` changed. `record` is the texture
   * kept so far, or null; returns the one now kept.
   * @private
   */
  _byteTexture(record, bytes, version) {
    const gl = this.gl;
    if (record !== null && record.bytes === bytes && record.version === version) return record;
    let texture = record?.texture ?? null;
    let plan = record?.plan ?? null;
    const activeTexture = glStateOf(gl).activeTexture;
    gl.activeTexture(gl.TEXTURE0);
    const boundTexture = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
    if (texture === null || plan.itemCount !== bytes.length) {
      if (texture !== null) deleteTextureTracked(gl, texture);
      texture = gl.createTexture();
      if (!texture) throw new Error('Highlight byte texture could not be created.');
      plan = planLinearTextureFor(gl, bytes.length);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      allocateLinearTexture(gl, gl.R8UI, plan);
    } else {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    }
    // A row of bytes is any number of bytes long.
    const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    try {
      writeLinearTextureRows(gl, plan, gl.RED_INTEGER, gl.UNSIGNED_BYTE, bytes, 1);
    } finally {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, restorableTexture(boundTexture));
      gl.activeTexture(activeTexture);
    }
    const kept = { texture, plan, bytes, version, byteLength: plan.texels };
    if (record?.byteLength !== kept.byteLength) this._publishGpuAllocationChange();
    return kept;
  }

  /** The highlight bytes as a texture (`_byteTexture`). @private */
  _highlightByteTexture(highlightData) {
    this._highlightTexture = this._byteTexture(this._highlightTexture ?? null, highlightData, this._highlightDataVersion);
    return this._highlightTexture;
  }

  /** One view's visibility bytes as a texture (`_byteTexture`). @private */
  _visibleByteTexture(viewBuffer, transparency, transparencyGeneration) {
    viewBuffer.visibleTexture = this._byteTexture(viewBuffer.visibleTexture ?? null, transparency, transparencyGeneration);
    return viewBuffer.visibleTexture;
  }

  /**
   * Whether the point store a view's highlights are drawn from is no longer
   * the one they were written for (another buffer, or the same one re-ordered
   * in place).
   * @private
   */
  _pointStoreMoved(viewId, viewBuffer) {
    if ((viewBuffer.storeBuffer ?? null) === null) return false;
    const store = this.hpRenderer?.getViewPointStore?.(viewId) ?? null;
    return store === null
      || store.buffer !== viewBuffer.storeBuffer
      || store.slotSources !== viewBuffer.storeSlotSources;
  }

  /**
   * Clear buffer for a specific view (e.g., when view is removed)
   * @param {string} viewId - View ID to clear
   */
  clearViewBuffer(viewId) {
    const vid = requireHighlightViewId(viewId);
    const viewBuffer = this._viewBuffers.get(vid);
    // Detach the logical view and its complete GPU pair first. A failed WebGL
    // deletion must never leave a half-retired view dispatchable.
    this._viewBuffers.delete(vid);
    if (viewBuffer !== undefined) {
      this._detachViewResources(viewBuffer);
    }
    this._recomputeTotalHighlightedCount();

    const failures = this._flushPendingResourceDeletes();
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Highlight view "${vid}" retirement retains ${failures.length} pending resource failure(s).`
      );
    }
    return viewBuffer !== undefined;
  }

  _flushPendingResourceDeletes({ includePrograms = false } = {}) {
    const failures = [];
    for (const vertexArray of this._pendingVertexArrayDeletes) {
      try {
        this.gl.deleteVertexArray(vertexArray);
        this._pendingVertexArrayDeletes.delete(vertexArray);
      } catch (error) {
        failures.push(
          error instanceof Error
            ? error
            : new Error(
              'Highlight vertex-array deletion failed with a non-Error value.',
              { cause: error }
            )
        );
      }
    }
    for (const buffer of this._pendingBufferDeletes) {
      try {
        this.gl.deleteBuffer(buffer);
        this._pendingBufferDeletes.delete(buffer);
      } catch (error) {
        failures.push(
          error instanceof Error
            ? error
            : new Error(
              'Highlight buffer deletion failed with a non-Error value.',
              { cause: error }
            )
        );
      }
    }
    if (includePrograms) {
      for (const program of this._pendingProgramDeletes) {
        try {
          deleteProgramReleasingUse(this.gl, program);
          this._pendingProgramDeletes.delete(program);
        } catch (error) {
          failures.push(
            error instanceof Error
              ? error
              : new Error(
                'Highlight program deletion failed with a non-Error value.',
                { cause: error }
              )
          );
        }
      }
    }
    return failures;
  }

  /**
   * Drop handles invalidated by context loss without issuing WebGL work.
   */
  handleContextLost() {
    if (this._disposed) return false;
    this._disposeStarted = true;
    this._releaseGpuAllocationReporter();
    this._viewBuffers.clear();
    this._pendingBufferDeletes.clear();
    this._pendingVertexArrayDeletes.clear();
    this._pendingProgramDeletes.clear();
    this.program = null;
    this._highlightTexture = null;
    this._slotWords?.abandon();
    this._slotWords = null;
    this._totalHighlightedCount = 0;
    this._highlightedIndicesCache = null;
    this._highlightDataRef = null;
    this._stagingBuffer = null;
    this.attribLocations = null;
    this.uniformLocations = null;
    this.hpRenderer = null;
    this.gl = null;
    this._disposed = true;
    return true;
  }

  /**
   * Dispose all GPU resources.
   */
  dispose() {
    if (this._disposed) return false;

    if (!this._disposeStarted) {
      this._disposeStarted = true;
      this._releaseGpuAllocationReporter();

      // Detach the complete live publication before the first fallible GL
      // operation. Pending sets remain authoritative across disposal retries.
      for (const viewBuffer of this._viewBuffers.values()) {
        this._detachViewResources(viewBuffer);
      }
      this._viewBuffers.clear();
      if (this.program) this._pendingProgramDeletes.add(this.program);
      this.program = null;
      if (this._highlightTexture) deleteTextureTracked(this.gl, this._highlightTexture.texture);
      this._highlightTexture = null;
      this._slotWords?.dispose();
      this._slotWords = null;

      this._totalHighlightedCount = 0;
      this._highlightedIndicesCache = null;
      this._highlightDataRef = null;
      this._stagingBuffer = null;
      this.attribLocations = null;
      this.uniformLocations = null;
      this.hpRenderer = null;
    }

    const failures = this._flushPendingResourceDeletes({
      includePrograms: true,
    });
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `HighlightRenderer disposal retains ${failures.length} pending resource failure(s).`
      );
    }

    this._disposed = true;
    this.gl = null;
    return true;
  }

  /**
   * Draw highlight rings for the specified view's buffer.
   * Uses per-view buffers for multi-view rendering with correct LOD sizes.
   * @param {string} viewId - Required view ID for per-view buffer and LOD size lookup
   */
  _readFrameTimeSeconds() {
    return performance.now() * 0.001;
  }

  _drawFailureMatches(
    viewBuffer,
    requestedDimensionLevel
  ) {
    const failed = viewBuffer.drawFailure;
    return (
      failed !== null &&
      failed !== undefined &&
      failed.buffer === viewBuffer.buffer &&
      failed.vertexArray === viewBuffer.vertexArray &&
      failed.pointCount === viewBuffer.pointCount &&
      failed.geometryGeneration ===
        viewBuffer.geometryGeneration &&
      failed.highlightGeneration ===
        viewBuffer.highlightGeneration &&
      failed.lodMembership === viewBuffer.lodMembership &&
      failed.transparencyGeneration ===
        viewBuffer.transparencyGeneration &&
      failed.publishedDimensionLevel ===
        viewBuffer.dimensionLevel &&
      failed.requestedDimensionLevel ===
        requestedDimensionLevel &&
      failed.program === this.program &&
      failed.uniformLocations === this.uniformLocations &&
      failed.hpRenderer === this.hpRenderer &&
      failed.styleGeneration ===
        (this._styleGeneration ?? 0) &&
      failed.highlightColor === this.highlightColor &&
      failed.highlightColor0 === this.highlightColor?.[0] &&
      failed.highlightColor1 === this.highlightColor?.[1] &&
      failed.highlightColor2 === this.highlightColor?.[2] &&
      failed.highlightScale === this.highlightScale &&
      failed.highlightRingWidth === this.highlightRingWidth &&
      failed.highlightHaloStrength ===
        this.highlightHaloStrength &&
      failed.highlightHaloShape === this.highlightHaloShape &&
      failed.highlightRingStyle === this.highlightRingStyle
    );
  }

  _recordDrawFailure(
    viewBuffer,
    requestedDimensionLevel
  ) {
    // Allocated only after an exceptional draw. The exact accepted
    // publication/style/program certificate prevents one deterministic fault
    // from becoming an error and driver-call storm on every animation frame.
    // The view stops drawing its rings: a different draw.
    viewBuffer.drawSerial = ++this._drawSerials;
    viewBuffer.drawFailure = {
      buffer: viewBuffer.buffer,
      geometryGeneration: viewBuffer.geometryGeneration,
      highlightColor: this.highlightColor,
      highlightColor0: this.highlightColor?.[0],
      highlightColor1: this.highlightColor?.[1],
      highlightColor2: this.highlightColor?.[2],
      highlightGeneration: viewBuffer.highlightGeneration,
      highlightHaloShape: this.highlightHaloShape,
      highlightHaloStrength: this.highlightHaloStrength,
      highlightRingStyle: this.highlightRingStyle,
      highlightRingWidth: this.highlightRingWidth,
      highlightScale: this.highlightScale,
      hpRenderer: this.hpRenderer,
      lodMembership: viewBuffer.lodMembership,
      pointCount: viewBuffer.pointCount,
      program: this.program,
      publishedDimensionLevel: viewBuffer.dimensionLevel,
      requestedDimensionLevel,
      styleGeneration: this._styleGeneration ?? 0,
      transparencyGeneration: viewBuffer.transparencyGeneration,
      uniformLocations: this.uniformLocations,
      vertexArray: viewBuffer.vertexArray,
    };
  }

  draw({
    mvpMatrix,
    viewMatrix,
    modelMatrix,
    projectionMatrix,
    viewportHeight,
    pointSize,
    sizeAttenuation,
    fov,
    fogDensity,
    lightingStrength,
    lightDir,
    viewId,  // Required for per-view buffer lookup and LOD size multiplier
    dimensionLevel
  }, frameTimeSeconds = this._readFrameTimeSeconds()) {
    const gl = this.gl;
    const vid = requireHighlightViewId(viewId);
    const exactDimensionLevel = requireHighlightDimension(dimensionLevel);

    // Get the exact per-view buffer/VAO pair.
    const viewBuffer = this._viewBuffers.get(vid);
    if (!viewBuffer || viewBuffer.pointCount === 0) return;
    if (this._drawFailureMatches(viewBuffer, exactDimensionLevel)) return;
    const exactFrameTimeSeconds = requireFiniteHighlightNumber(
      frameTimeSeconds,
      'Highlight frame timeSeconds'
    );
    if (
      viewBuffer.buffer === null ||
      viewBuffer.vertexArray === null
    ) {
      throw new Error(
        `Highlight view "${vid}" has no complete drawable GPU pair.`
      );
    }

    const vertexArray = viewBuffer.vertexArray;
    const drawCount = viewBuffer.drawCount;

    let drawFailure = null;
    let restorationFailures = null;
    try {
      // Enable depth test and disable depth writes for highlight rendering.
      // These calls are part of the fenced transaction: hostile wrappers may
      // throw before depthMask(false), and must still be reported only once
      // for the exact accepted draw generation.
      gl.enable(gl.DEPTH_TEST);
      configureStraightAlphaBlending(gl);

      // Keep the publication inside the transaction so an exceptional WebGL
      // implementation or test double cannot strand depth writes disabled.
      gl.depthMask(false);
      gl.useProgram(this.program);

      // Use per-view LOD size multiplier if viewId is provided.
      // Pass dimensionLevel for the exact multi-dimension LOD buffer lookup.
      const lodSizeMultiplier = this.hpRenderer.getCurrentLODSizeMultiplier(
        vid,
        exactDimensionLevel
      );
      const highlightPointSize = pointSize * lodSizeMultiplier;

      const pointScale = writePointShaderFrame(
        this._shaderFrame,
        viewMatrix,
        modelMatrix,
        lightDir,
        viewportHeight,
        fov
      );
      gl.uniformMatrix4fv(this.uniformLocations.modelViewMatrix, false, this._shaderFrame.modelView);
      gl.uniformMatrix4fv(this.uniformLocations.projectionMatrix, false, projectionMatrix);

      let effectiveScale = this.highlightScale;
      let effectiveRingWidth = this.highlightRingWidth;
      let effectiveHaloStrength = this.highlightHaloStrength;
      if (this.highlightHaloShape > 0.5) {
        const haloBoost = Math.min(1.5, Math.max(0, pointSize * (0.01 + sizeAttenuation * 0.02)));
        effectiveScale = this.highlightScale + haloBoost * 0.5;
        effectiveRingWidth = Math.min(0.5, this.highlightRingWidth + haloBoost * 0.02);
        effectiveHaloStrength = Math.min(1.0, this.highlightHaloStrength + haloBoost * 0.1);
      }

      gl.uniform1f(this.uniformLocations.pointSize, highlightPointSize);
      gl.uniform1f(this.uniformLocations.sizeAttenuation, sizeAttenuation);
      gl.uniform1f(this.uniformLocations.pointScale, pointScale);
      gl.uniform1f(this.uniformLocations.highlightScale, effectiveScale);
      gl.uniform3fv(this.uniformLocations.highlightColor, this.highlightColor);
      gl.uniform1f(this.uniformLocations.ringWidth, effectiveRingWidth);
      gl.uniform1f(this.uniformLocations.haloStrength, effectiveHaloStrength);
      gl.uniform1f(this.uniformLocations.haloShape, this.highlightHaloShape);
      gl.uniform1f(this.uniformLocations.ringStyle, this.highlightRingStyle);

      // A still style is drawn at time zero: its mid-pulse glow and a fixed
      // shimmer phase, the same picture on every frame.
      const highlightTime = this.highlightAnimated === true
        ? exactFrameTimeSeconds - this.startTime * 0.001
        : 0;
      gl.uniform1f(this.uniformLocations.time, highlightTime);
      gl.uniform1f(
        this.uniformLocations.glow,
        highlightGlowAt(highlightTime)
      );

      writeFogUniforms(
        gl,
        this.uniformLocations.fogNear,
        this.uniformLocations.fogScale,
        fogDensity,
        this.hpRenderer.getFogNear(),
        this.hpRenderer.getFogFar()
      );

      gl.uniform1f(this.uniformLocations.lightingStrength, lightingStrength);
      gl.uniform3fv(this.uniformLocations.lightDir, lightDir);
      gl.uniform3fv(this.uniformLocations.halfDir, this._shaderFrame.halfDir);

      // Attribute layout is immutable for the lifetime of the resource pair;
      // each frame needs one VAO bind instead of reconfiguring two attributes.
      gl.bindVertexArray(vertexArray);
      drawPointsInSegments(gl, 0, drawCount);
    } catch (error) {
      drawFailure = error;
    } finally {
      try {
        gl.bindVertexArray(null);
      } catch (error) {
        (restorationFailures ??= []).push(error);
      }
      try {
        // depthMask(true) is renderer-owned baseline state. Restore it even
        // when shader state, VAO binding, or drawing fails mid-pass.
        gl.depthMask(true);
      } catch (error) {
        (restorationFailures ??= []).push(error);
      }
    }
    if (drawFailure !== null) {
      this._recordDrawFailure(viewBuffer, exactDimensionLevel);
      if (restorationFailures !== null) {
        throw new AggregateError(
          [drawFailure, ...restorationFailures],
          `Highlight draw for view "${vid}" failed with incomplete state restoration.`
        );
      }
      throw drawFailure;
    }
    if (restorationFailures !== null) {
      this._recordDrawFailure(viewBuffer, exactDimensionLevel);
      throw new AggregateError(
        restorationFailures,
        `Highlight draw for view "${vid}" could not restore renderer-owned state.`
      );
    }
    if (viewBuffer.drawFailure !== null) {
      viewBuffer.drawFailure = null;
      viewBuffer.drawSerial = ++this._drawSerials;
    }
  }
}

// ============================================================================
// 2D OVERLAY & HIGHLIGHT TOOLS (LASSO, PROXIMITY, KNN)
// ============================================================================

const lassoParentPositionOwners = new WeakMap();

function acquireLassoParentPosition(parentElement) {
  const existing = lassoParentPositionOwners.get(parentElement);
  if (existing) {
    existing.ownerCount++;
    return { parentElement, record: existing, released: false };
  }

  const previousInlinePosition = parentElement.style.position;
  const computedPosition = window.getComputedStyle(parentElement).position;
  const changedInlinePosition = computedPosition === 'static';
  if (changedInlinePosition) {
    parentElement.style.position = 'relative';
  }
  const record = {
    ownerCount: 1,
    previousInlinePosition,
    changedInlinePosition,
  };
  lassoParentPositionOwners.set(parentElement, record);
  return { parentElement, record, released: false };
}

function releaseLassoParentPosition(lease) {
  if (!lease || lease.released) return;
  const { parentElement, record } = lease;
  const current = lassoParentPositionOwners.get(parentElement);
  if (current !== record) {
    lease.released = true;
    return;
  }
  if (record.ownerCount > 1) {
    record.ownerCount--;
    lease.released = true;
    return;
  }

  // Restore only the inline value owned by this overlay generation. If another
  // component changed the parent meanwhile, its newer publication wins.
  if (
    record.changedInlinePosition &&
    parentElement.style.position === 'relative'
  ) {
    parentElement.style.position = record.previousInlinePosition;
  }
  lassoParentPositionOwners.delete(parentElement);
  lease.released = true;
}

/**
 * Create a 2D overlay canvas attached to the same parent as the main canvas.
 * Returns the canvas, context, resize subscription, and parent-style lease.
 */
export function createLassoOverlay(canvas) {
  const parentElement = canvas.parentElement;
  if (!parentElement) {
    throw new Error(
      'Highlight lasso overlay requires the main canvas to have a parent element.'
    );
  }

  const lassoCanvas = document.createElement('canvas');
  lassoCanvas.id = 'lasso-overlay';
  lassoCanvas.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 10;
    display: none;
  `;
  const parentPositionLease = acquireLassoParentPosition(parentElement);
  let lassoCtx = null;
  let observer = null;
  let activeDprRegistration = null;
  const dprRegistrations = new Set();
  let resizeSubscriptionActive = true;

  function syncLassoCanvasSize() {
    if (!resizeSubscriptionActive) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    lassoCanvas.width = Math.floor(rect.width * dpr);
    lassoCanvas.height = Math.floor(rect.height * dpr);
    lassoCanvas.style.width = rect.width + 'px';
    lassoCanvas.style.height = rect.height + 'px';
    lassoCtx.setTransform(1, 0, 0, 1, 0, 0);
    lassoCtx.scale(dpr, dpr);
  }

  function retireDprRegistration(registration) {
    registration.mediaQuery.removeEventListener(
      'change',
      registration.handler
    );
    dprRegistrations.delete(registration);
  }

  function armDprMonitor() {
    if (!resizeSubscriptionActive) return;
    const dpr = window.devicePixelRatio || 1;
    const registration = {
      handler: null,
      mediaQuery: window.matchMedia(`(resolution: ${dpr}dppx)`),
    };
    registration.handler = () => {
      if (
        !resizeSubscriptionActive ||
        activeDprRegistration !== registration
      ) {
        return;
      }
      syncLassoCanvasSize();
      armDprMonitor();
    };
    // Record candidate ownership before the fallible external subscription so
    // a host that attaches and then throws can still be rolled back exactly.
    dprRegistrations.add(registration);
    try {
      registration.mediaQuery.addEventListener(
        'change',
        registration.handler
      );
    } catch (error) {
      try {
        retireDprRegistration(registration);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Highlight lasso DPR-listener setup and rollback both failed.'
        );
      }
      throw error;
    }

    const previousRegistration = activeDprRegistration;
    activeDprRegistration = registration;
    if (previousRegistration !== null) {
      // Retire every stale generation, including an older generation whose
      // prior external removal failed. Identity fencing keeps all retained
      // handlers inert until one of these bounded retries succeeds.
      for (const staleRegistration of dprRegistrations) {
        if (staleRegistration === registration) continue;
        try {
          retireDprRegistration(staleRegistration);
        } catch {
          // Explicit disposal owns the final retry if the host remains hostile.
        }
      }
    }
  }

  function disconnectResizeSources() {
    // Fence already-queued ResizeObserver and media-query callbacks before
    // attempting any fallible external cleanup.
    resizeSubscriptionActive = false;
    activeDprRegistration = null;
    const failures = [];
    if (observer !== null) {
      try {
        observer.disconnect();
        observer = null;
      } catch (error) {
        failures.push(error);
      }
    }
    for (const registration of dprRegistrations) {
      try {
        retireDprRegistration(registration);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Highlight lasso resize subscription retains ${failures.length} pending cleanup failure(s).`
      );
    }
  }

  try {
    parentElement.appendChild(lassoCanvas);
    lassoCtx = lassoCanvas.getContext('2d');
    if (!lassoCtx) {
      throw new Error('Unable to allocate the highlight lasso 2D context.');
    }
    syncLassoCanvasSize();
    observer = new ResizeObserver(syncLassoCanvasSize);
    observer.observe(canvas);
    armDprMonitor();
  } catch (error) {
    const cleanupFailures = [];
    try {
      disconnectResizeSources();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    try {
      lassoCanvas.remove();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    try {
      releaseLassoParentPosition(parentPositionLease);
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Highlight lasso overlay construction and rollback both failed.'
      );
    }
    throw error;
  }

  const resizeSubscription = {
    disconnect() {
      disconnectResizeSources();
    },
  };
  return {
    lassoCanvas,
    lassoCtx,
    resizeSubscription,
    parentPositionLease,
  };
}

/**
 * Show or hide the overlay canvas. Hidden whenever nothing is drawn on it, so
 * a full-window transparent layer is not composited over the scene every
 * frame.
 */
function setOverlayShown(lassoCtx, shown) {
  const style = lassoCtx?.canvas?.style;
  if (!style) return;
  const display = shown ? '' : 'none';
  if (style.display !== display) style.display = display;
}

function drawLasso({ canvas, lassoCtx, lassoPath }) {
  const rect = canvas.getBoundingClientRect();
  lassoCtx.setTransform(1, 0, 0, 1, 0, 0);
  const dpr = window.devicePixelRatio || 1;
  lassoCtx.scale(dpr, dpr);
  lassoCtx.clearRect(0, 0, rect.width, rect.height);

  if (!lassoPath || lassoPath.length < 2) {
    setOverlayShown(lassoCtx, false);
    return;
  }
  setOverlayShown(lassoCtx, true);

  lassoCtx.beginPath();
  lassoCtx.moveTo(lassoPath[0].x, lassoPath[0].y);
  for (let i = 1; i < lassoPath.length; i++) {
    lassoCtx.lineTo(lassoPath[i].x, lassoPath[i].y);
  }
  lassoCtx.closePath();

  lassoCtx.fillStyle = 'rgba(17, 24, 39, 0.08)';
  lassoCtx.fill();

  lassoCtx.strokeStyle = 'rgba(17, 24, 39, 0.7)';
  lassoCtx.lineWidth = 2;
  lassoCtx.setLineDash([4, 3]);
  lassoCtx.stroke();

  lassoCtx.setLineDash([]);
  lassoCtx.fillStyle = 'rgba(17, 24, 39, 0.9)';
  for (const pt of lassoPath) {
    lassoCtx.beginPath();
    lassoCtx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
    lassoCtx.fill();
  }
}

function clearLassoOverlay({ canvas, lassoCtx }) {
  const rect = canvas.getBoundingClientRect();
  lassoCtx.setTransform(1, 0, 0, 1, 0, 0);
  const dpr = window.devicePixelRatio || 1;
  lassoCtx.scale(dpr, dpr);
  lassoCtx.clearRect(0, 0, rect.width, rect.height);
  setOverlayShown(lassoCtx, false);
}

export function drawProximityIndicator({
  canvas,
  lassoCtx,
  proximityCenter,
  proximityCurrentRadius,
  mat4,
  viewMatrix,
  modelMatrix
}) {
  if (!proximityCenter || proximityCurrentRadius <= 0) return;

  const rect = canvas.getBoundingClientRect();
  lassoCtx.setTransform(1, 0, 0, 1, 0, 0);
  const dpr = window.devicePixelRatio || 1;
  lassoCtx.scale(dpr, dpr);
  lassoCtx.clearRect(0, 0, rect.width, rect.height);
  setOverlayShown(lassoCtx, true);

  const vp = requireHighlightViewport(
    proximityCenter.viewport,
    'Proximity indicator viewport'
  );
  const vpWidth = vp.vpWidth;
  const vpHeight = vp.vpHeight;
  const vpOffsetX = vp.vpOffsetX;
  const vpOffsetY = vp.vpOffsetY;

  const localMvp = mat4.create();
  const effectiveView = vp.effectiveViewMatrix === null
    ? requireHighlightMatrix(viewMatrix, 'Proximity indicator view matrix')
    : vp.effectiveViewMatrix;
  mat4.multiply(localMvp, vp.projectionMatrix, effectiveView);
  mat4.multiply(localMvp, localMvp, modelMatrix);

  const centerScreen = projectPointToScreen(
    proximityCenter.worldPos[0],
    proximityCenter.worldPos[1],
    proximityCenter.worldPos[2],
    localMvp, vpWidth, vpHeight
  );
  if (!centerScreen) return;

  const edgeX = proximityCenter.worldPos[0] + proximityCurrentRadius;
  const edgeScreen = projectPointToScreen(
    edgeX,
    proximityCenter.worldPos[1],
    proximityCenter.worldPos[2],
    localMvp, vpWidth, vpHeight
  );

  let screenRadius = 50;
  if (edgeScreen) {
    const dx = edgeScreen.x - centerScreen.x;
    const dy = edgeScreen.y - centerScreen.y;
    screenRadius = Math.sqrt(dx * dx + dy * dy);
  }

  const drawX = centerScreen.x + vpOffsetX;
  const drawY = centerScreen.y + vpOffsetY;

  lassoCtx.save();
  try {
  clipToPresentedPane(lassoCtx, vp);
  lassoCtx.beginPath();
  lassoCtx.arc(drawX, drawY, screenRadius, 0, Math.PI * 2);
  lassoCtx.fillStyle = 'rgba(17, 24, 39, 0.08)';
  lassoCtx.fill();
  lassoCtx.strokeStyle = 'rgba(17, 24, 39, 0.7)';
  lassoCtx.lineWidth = 2;
  lassoCtx.setLineDash([4, 3]);
  lassoCtx.stroke();

  lassoCtx.setLineDash([]);
  lassoCtx.beginPath();
  lassoCtx.arc(drawX, drawY, 3, 0, Math.PI * 2);
  lassoCtx.fillStyle = 'rgba(17, 24, 39, 0.9)';
  lassoCtx.fill();
  } finally {
    lassoCtx.restore();
  }
}

function clearProximityOverlay({ canvas, lassoCtx }) {
  clearLassoOverlay({ canvas, lassoCtx });
}

// HighlightTools encapsulates highlight rendering and interactive tools.
export class HighlightTools {
  constructor({
    gl,
    canvas,
    hpRenderer,
    mat4,
    vec3,
    pickCellAtScreen,
    screenToRay,
    getViewportInfoAtScreen,
    getViewIdAtCanvasPoint,
    getRenderContext,
    getNavigationState,
    getViewTransparency,
    getSpatialQueryOwner,
    startTime = performance.now(),
    shaderQuality = 'full'
  }) {
    for (const [name, callback] of [
      ['pickCellAtScreen', pickCellAtScreen],
      ['screenToRay', screenToRay],
      ['getViewportInfoAtScreen', getViewportInfoAtScreen],
      ['getViewIdAtCanvasPoint', getViewIdAtCanvasPoint],
      ['getRenderContext', getRenderContext],
      ['getNavigationState', getNavigationState],
      ['getViewTransparency', getViewTransparency],
      ['getSpatialQueryOwner', getSpatialQueryOwner],
    ]) {
      if (typeof callback !== 'function') {
        throw new TypeError(`HighlightTools ${name} must be a function.`);
      }
    }
    this.gl = gl;
    this.canvas = canvas;
    this.hpRenderer = hpRenderer;
    this.mat4 = mat4;
    this.vec3 = vec3;
    this.pickCellAtScreen = pickCellAtScreen;
    this.screenToRay = screenToRay;
    this.getViewportInfoAtScreen = getViewportInfoAtScreen;
    this.getViewIdAtCanvasPoint = getViewIdAtCanvasPoint;
    this.getRenderContext = getRenderContext;
    this.getNavigationState = getNavigationState;
    this.getViewTransparency = getViewTransparency;
    this.getSpatialQueryOwner = getSpatialQueryOwner;

    this.highlightRenderer = new HighlightRenderer(gl, hpRenderer, startTime);
    let lassoOverlay;
    try {
      this.highlightRenderer.setQuality(shaderQuality);
      lassoOverlay = createLassoOverlay(canvas);
    } catch (error) {
      try {
        this.highlightRenderer.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'HighlightTools construction and renderer rollback both failed.'
        );
      }
      throw error;
    }

    const {
      lassoCanvas,
      lassoCtx,
      resizeSubscription,
      parentPositionLease,
    } = lassoOverlay;
    this.lassoCanvas = lassoCanvas;
    this.lassoCtx = lassoCtx;
    this._lassoResizeSubscription = resizeSubscription;
    this._lassoParentPositionLease = parentPositionLease;
    this._previousCanvasCursor = canvas.style.cursor;
    this._disposeState = null;
    this._disposed = false;

    this.highlightArray = null;
    // viewId -> 'none'|'continuous'|'categorical'; see setViewFieldKindSource.
    this.getViewFieldKind = NO_VIEW_FIELD_KIND_SOURCE;
    this.cellSelectionEnabled = true;
    this.cellSelectionCallback = null;
    this.selectionPreviewCallback = null;
    this.selectionStepCallback = null;
    this.selectionDragStart = null;
    this.selectionDragCurrent = null;
    this.annotationStepCount = 0;
    this.annotationLastMode = 'intersect';

    // Unified candidate set shared across all selection tools (lasso, proximity, KNN)
    // This allows users to start with one tool and refine with another
    this._unifiedCandidateSet = null;
    this._unifiedStepCount = 0;

    this.lassoEnabled = false;
    this.lassoPath = [];
    this.isLassoing = false;
    this.lassoViewContext = null;
    this.lassoCallback = null;
    this.lassoPreviewCallback = null;
    this.lassoStepCallback = null;
    this.lassoMode = 'intersect';
    this._lassoPreviewPublished = false;

    this.proximityEnabled = false;
    this.isProximityDragging = false;
    this.proximityCenter = null;
    this.proximityCurrentRadius = 0;
    this.proximityCallback = null;
    this.proximityPreviewCallback = null;
    this.proximityStepCallback = null;
    this._proximityPreviewPublished = false;

    this.knnEnabled = false;
    this.isKnnDragging = false;
    this.knnSeedCell = null;
    this.knnCurrentDegree = 0;
    this.knnCallback = null;
    this.knnPreviewCallback = null;
    this.knnStepCallback = null;
    this.knnGraph = null;
    this.knnEdgesLoaded = false;
    this.knnEdgeLoadCallback = null;

    // The cell query of the gesture in flight (selection-gesture-queries.js),
    // with what it was built from; rebuilt when any of that changes.
    this._lassoHitTest = null;
    this._proximityHitTest = null;
    this._knnExpansion = null;
    this._selectionWorkScheduled = false;

    this.altKeyDown = false;
    // The on-screen stand-in for a held Alt key; see `select-mode.js`.
    this.selectMode = SELECT_MODE_OFF;

    // Where the pointer last was, so the armed cursor can follow the pane
    // under it (see `updateSelectionCursor`). Client coordinates are stored
    // on every move and turned into canvas-local ones with an origin read
    // once per arming, so following the pane costs no layout read per move.
    this._pointerClientX = Number.NaN;
    this._pointerClientY = Number.NaN;
    this._canvasOriginX = 0;
    this._canvasOriginY = 0;
    // Field kind of the pane the armed annotation cursor was last drawn for;
    // null while the annotation tool is not armed or the pointer is off every
    // pane.
    this._pointerPaneFieldKind = null;

    // Filtering changes are explicit viewer publications. One exact scalar
    // generation per view replaces sampled Float32 fingerprints.
    this._transparencyGenerations = new Map();
  }

  // === Unified candidate set accessors ===
  // All tools (lasso, proximity, KNN) share the same candidate set
  // This allows switching tools mid-selection to refine with different methods

  get lassoCandidateSet() { return this._unifiedCandidateSet; }
  set lassoCandidateSet(value) { this._unifiedCandidateSet = value; }

  get lassoStepCount() { return this._unifiedStepCount; }
  set lassoStepCount(value) { this._unifiedStepCount = value; }

  get proximityCandidateSet() { return this._unifiedCandidateSet; }
  set proximityCandidateSet(value) { this._unifiedCandidateSet = value; }

  get proximityStepCount() { return this._unifiedStepCount; }
  set proximityStepCount(value) { this._unifiedStepCount = value; }

  get knnCandidateSet() { return this._unifiedCandidateSet; }
  set knnCandidateSet(value) { this._unifiedCandidateSet = value; }

  get knnStepCount() { return this._unifiedStepCount; }
  set knnStepCount(value) { this._unifiedStepCount = value; }

  /**
   * Get unified selection state across all tools.
   * @returns {Object} State object with inProgress, stepCount, candidateCount, candidates
   */
  getUnifiedSelectionState() {
    return {
      inProgress: this._unifiedCandidateSet !== null,
      stepCount: this._unifiedStepCount,
      candidateCount: this._unifiedCandidateSet ? this._unifiedCandidateSet.size : 0,
      candidates: this._unifiedCandidateSet ? this._unifiedCandidateSet.toUint32Array() : new Uint32Array(0)
    };
  }

  /**
   * Confirm unified selection and clear state.
   * @param {Function} [callback] - Optional callback to receive final selection
   * @returns {Uint32Array} The selected cells, ascending
   */
  confirmUnifiedSelection(callback = null) {
    const finalIndices = this._unifiedCandidateSet ? this._unifiedCandidateSet.toUint32Array() : new Uint32Array(0);
    if (callback && finalIndices.length > 0) {
      callback({
        type: 'unified',
        cellIndices: finalIndices,
        cellCount: finalIndices.length,
        steps: this._unifiedStepCount
      });
    }
    this._unifiedCandidateSet = null;
    this._unifiedStepCount = 0;
    return finalIndices;
  }

  /**
   * Cancel unified selection and clear state.
   */
  cancelUnifiedSelection() {
    this._unifiedCandidateSet = null;
    this._unifiedStepCount = 0;
  }

  /**
   * Restore unified selection state.
   * @param {Uint32Array} candidates - Cell list (ascending cell indices)
   * @param {number} step - Step count
   */
  restoreUnifiedState(candidates, step) {
    if (candidates && candidates.length > 0) {
      this._unifiedCandidateSet = CellSet.fromCellList(candidates, this.getViewTransparency('live').length);
      this._unifiedStepCount = step;
    } else {
      this._unifiedCandidateSet = null;
      this._unifiedStepCount = 0;
    }
  }

  // === Highlight rendering ===
  setQuality(quality) {
    this.highlightRenderer.setQuality(quality);
  }

  /**
   * Update highlight data. In multi-view mode, buffers are rebuilt with
   * view-specific positions and transparency when each view next draws
   * (`syncHighlightBufferForLod`, then `drawHighlights`).
   *
   * IMPORTANT: Highlight display respects per-view filtering. Cells that are filtered
   * out in a view will NOT show highlights in that view, even if they're highlighted
   * in another view. This ensures consistent behavior across main and snapshot views.
   *
   * @param {Uint8Array} highlightData - Highlight intensity per point (0-255)
   * @param {number[]|Uint32Array} [highlightedIndices] - Optional pre-computed
   *   list of highlighted cell indices. If provided, skips the expensive O(n)
   *   full-array scan. Pass this when you already know which cells are
   *   highlighted (e.g., from state.js highlight groups).
   * @returns {boolean} Whether the published highlight changed; an identical
   *   republication (same array, same cells, full intensity) changes nothing.
   */
  updateHighlight(highlightData, highlightedIndices = null) {
    this.highlightArray = requireHighlightData(highlightData);

    // If pre-computed indices provided, set cache directly (avoids O(n) scan)
    // Otherwise, invalidate cache to trigger scan on next rebuildBuffer
    if (highlightedIndices !== null) {
      // An indexed loop rather than `.some()`: this validates every cell of a
      // selection that can be the whole dataset, so it must not allocate a
      // closure result per element, and it must visit array holes rather than
      // skipping them the way the callback iterators do -- an unset entry
      // reaches the packer as `undefined` and produces a NaN vertex.
      const typedIndices = highlightedIndices instanceof Uint32Array;
      if (!typedIndices && !Array.isArray(highlightedIndices)) {
        throw new RangeError(
          'Highlighted indices must be an array of valid highlight-data indices.'
        );
      }
      const dataLength = highlightData.length;
      let fullIntensity = true;
      for (let i = 0; i < highlightedIndices.length; i++) {
        const index = highlightedIndices[i];
        // A Uint32Array entry is a non-negative integer by construction; the
        // remaining bounds are checked identically for both shapes.
        if (
          (!typedIndices && !Number.isInteger(index)) ||
          index < 0 ||
          index >= dataLength ||
          highlightData[index] < MIN_VISIBLE_ALPHA_BYTE
        ) {
          throw new RangeError(
            'Highlighted indices must be an array of valid highlight-data indices.'
          );
        }
        if (highlightData[index] !== 255) fullIntensity = false;
      }
      const changed = this.highlightRenderer.setHighlightedIndicesCache(
        highlightedIndices,
        highlightData,
        fullIntensity
      );
      if (!changed) return false;
    } else {
      this.highlightRenderer.invalidateHighlightCache();
    }

    if (
      highlightData.length === 0 ||
      (
        this.highlightRenderer._highlightedIndicesCache !== null &&
        this.highlightRenderer._highlightedIndicesCache.length === 0
      )
    ) {
      // Empty publications retire hidden/focused-out pane buffers immediately;
      // those panes may not receive another render frame for an arbitrary time.
      this.highlightRenderer.publishEmptyViews();
    }
    // Non-empty per-view buffers compare the renderer-owned highlight
    // generation on their next render. No O(view-count) invalidation walk is
    // required for the normal update path.
    return true;
  }

  _getTransparencyGenerations() {
    if (this._disposed === true) {
      throw new Error(
        'HighlightTools cannot access filtering generations after disposal.'
      );
    }
    if (!(this._transparencyGenerations instanceof Map)) {
      // Upgrade an already-live instance created before exact filtering
      // generations were introduced. New instances publish this in the
      // constructor.
      this._transparencyGenerations = new Map();
    }
    return this._transparencyGenerations;
  }

  /**
   * Handle transparency changes for any view.
   *
   * @param {string} viewId - Exact view whose transparency changed.
   */
  handleTransparencyChange(viewId) {
    const vid = requireHighlightViewId(viewId);
    const generations = this._getTransparencyGenerations();
    const previous = generations.get(vid) ?? 0;
    if (!Number.isSafeInteger(previous) || previous < 0) {
      throw new Error(
        `Highlight transparency generation is invalid for view "${vid}".`
      );
    }
    const next = previous + 1;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError(
        `Highlight transparency generations are exhausted for view "${vid}".`
      );
    }
    generations.set(vid, next);
    // Filtering arrays are updated in place, so their reference cannot
    // certify that a gesture's cell query still holds. Each query records the
    // generation it was built at and is rebuilt when this one differs.
    return next;
  }

  _retireActiveSpatialInteractions(viewId = null) {
    const exactViewId = viewId === null
      ? null
      : requireHighlightViewId(viewId);
    let retired = false;
    let lassoRetirementEvent = null;
    let proximityRetirementEvent = null;
    if (
      this.isLassoing &&
      (
        exactViewId === null ||
        this.lassoViewContext?.viewId === exactViewId
      )
    ) {
      if (
        this._lassoPreviewPublished &&
        this.lassoPreviewCallback &&
        this.lassoPath.length >= 3
      ) {
        lassoRetirementEvent = {
          type: 'lasso-preview',
          cellIndices: new Uint32Array(0),
          cellCount: 0,
          newCellCount: 0,
          mode: this.lassoMode || 'intersect',
          polygon: this.lassoPath.map(point => ({
            x: point.x,
            y: point.y,
          })),
        };
      }
      this.isLassoing = false;
      this.canvas.classList.remove('lassoing');
      clearLassoOverlay({ canvas: this.canvas, lassoCtx: this.lassoCtx });
      this.lassoPath = [];
      this.lassoViewContext = null;
      this._lassoHitTest = null;
      this._lassoPreviewPublished = false;
      retired = true;
    }
    if (
      this.isProximityDragging &&
      (
        exactViewId === null ||
        this.proximityCenter?.viewId === exactViewId
      )
    ) {
      if (
        this._proximityPreviewPublished &&
        this.proximityPreviewCallback
      ) {
        proximityRetirementEvent = {
          type: 'proximity-preview',
          cellIndices: new Uint32Array(0),
          cellCount: 0,
          newCellCount: 0,
          centerCellIndex:
            this.proximityCenter?.cellIndex ?? -1,
          radius: this.proximityCurrentRadius,
          mode:
            this.proximityCenter?.mode ?? 'intersect',
        };
      }
      this.isProximityDragging = false;
      this.canvas.classList.remove('proximity-dragging');
      clearProximityOverlay({
        canvas: this.canvas,
        lassoCtx: this.lassoCtx
      });
      this.proximityCenter = null;
      this.proximityCurrentRadius = 0;
      this._proximityHitTest = null;
      this._proximityPreviewPublished = false;
      retired = true;
    }
    if (retired) this.updateSelectionCursor();
    if (lassoRetirementEvent !== null) {
      this.lassoPreviewCallback(lassoRetirementEvent);
    }
    if (proximityRetirementEvent !== null) {
      this.proximityPreviewCallback(proximityRetirementEvent);
    }
    return retired;
  }

  retireSpatialInteractions(viewId) {
    return this._retireActiveSpatialInteractions(
      requireHighlightViewId(viewId)
    );
  }

  _spatialQueryOwnerIsCurrent(capturedOwner) {
    try {
      const currentOwner = requireSpatialQueryOwner(
        this.getSpatialQueryOwner(capturedOwner.viewId, false),
        capturedOwner.viewId
      );
      // The lasso and proximity queries read the published positions and
      // transparency; a spatial index finishing its build mid-gesture
      // changes neither.
      return (
        currentOwner.publishedPositions ===
          capturedOwner.publishedPositions &&
        currentOwner.transparency === capturedOwner.transparency &&
        currentOwner.dimensionLevel === capturedOwner.dimensionLevel
      );
    } catch {
      return false;
    }
  }

  clearViewState(viewId) {
    const vid = requireHighlightViewId(viewId);
    this._retireActiveSpatialInteractions(vid);
    this._getTransparencyGenerations().delete(vid);
    this.highlightRenderer.clearViewBuffer(vid);
  }

  /**
   * Sync highlight buffer for LOD + frustum visibility AND per-view filtering.
   *
   * Per-view transparency is now respected: cells filtered out in a view will NOT
   * show highlights in that view. This ensures View A's highlights don't leak into
   * View B when those cells are filtered out in View B.
   *
   * @param {Float32Array} viewPositions - Exact positions owned by the view.
   * @param {string} viewId - Exact view ID.
   * @param {Uint8Array} viewTransparency - Exact per-view transparency.
   * @param {number} dimensionLevel - Exact dimension level.
   */
  syncHighlightBufferForLod(
    viewPositions,
    viewId,
    viewTransparency,
    dimensionLevel
  ) {
    if (this.highlightArray === null) return;
    const vid = requireHighlightViewId(viewId);
    const exactDimensionLevel = requireHighlightDimension(dimensionLevel);
    const positions = viewPositions;
    const pointCount = requireHighlightPositions(
      positions,
      exactDimensionLevel
    );
    requireHighlightData(this.highlightArray, pointCount);
    const transparency = requireHighlightTransparency(
      viewTransparency,
      pointCount
    );

    // Resolve the exact highlighted-index generation before any dataset-sized
    // LOD owner. Empty highlights retire stale draw counts without allocating
    // or even constructing the shared membership map.
    this.highlightRenderer.updateHighlightCache(this.highlightArray);
    if (this.highlightRenderer._highlightedIndicesCache.length === 0) {
      this.highlightRenderer.publishEmptyView(vid);
      return;
    }

    const geometryGeneration =
      this.hpRenderer.getViewGeometryGeneration(vid);
    const lodMembership =
      this.hpRenderer.getCurrentLodMembership(
        vid,
        exactDimensionLevel
      );
    const transparencyGeneration =
      this._getTransparencyGenerations().get(vid) ?? 0;

    if (
      this.highlightRenderer.needsRefresh(
        lodMembership,
        vid,
        geometryGeneration,
        exactDimensionLevel,
        transparencyGeneration
      )
    ) {
      try {
        this.highlightRenderer.rebuildBuffer(
          this.highlightArray,
          positions,
          lodMembership,
          vid,
          transparency,
          geometryGeneration,
          exactDimensionLevel,
          transparencyGeneration
        );
      } catch (error) {
        // Keep the last accepted per-view GPU generation drawable, but do not
        // repeat an impossible allocation on every animation frame. Its GPU
        // allocation remains reusable, while its stale draw count is revoked
        // until an exact geometry/LOD/highlight/filter change enables one retry.
        this.highlightRenderer.recordPublicationFailure(
          lodMembership,
          vid,
          geometryGeneration,
          exactDimensionLevel,
          transparencyGeneration
        );
        throw error;
      }
    }
  }

  drawHighlights(drawParams, timeSeconds = null) {
    if (!drawParams || typeof drawParams !== 'object') {
      throw new TypeError('Highlight draw parameters are required.');
    }
    const frameTimeSeconds = timeSeconds === null
      ? performance.now() * 0.001
      : requireFiniteHighlightNumber(
          timeSeconds,
          'HighlightTools frame timeSeconds'
        );
    // Viewer renderParams are stable per-view records. Forward the exact owner
    // instead of allocating and copying a draw object for every pane and frame.
    this.highlightRenderer.draw(
      drawParams,
      frameTimeSeconds
    );
  }

  setHighlightStyle(options = {}) {
    if (this.highlightRenderer) {
      this.highlightRenderer.setStyle(options);
    }
  }

  getHighlightedCount() {
    return this.highlightRenderer.getTotalPointCount();
  }

  /** Whether the highlights on screen animate; see HighlightRenderer.isAnimated. */
  isHighlightAnimating() {
    return this.highlightRenderer.isAnimated();
  }

  /** See HighlightRenderer.drawSerial. */
  highlightDrawSerial(viewId) {
    return this.highlightRenderer.drawSerial(viewId);
  }

  getLassoCtx() {
    return this.lassoCtx;
  }

  // === Per-pane field kind and annotation ===

  /**
   * Publish where each pane's field kind is read from.
   *
   * `source(viewId)` returns the kind of the field that pane is colored by,
   * `'none'`, `'continuous'` or `'categorical'`. It is called whenever the
   * renderer needs an answer — on an annotation press, and while the tool is
   * armed, when the pointer crosses into another pane — so a field change
   * anywhere is seen at the next gesture with nothing to republish and no
   * cached copy to fall behind.
   *
   * @param {(viewId: string) => 'none'|'continuous'|'categorical'} source
   */
  setViewFieldKindSource(source) {
    this.getViewFieldKind = requireCallback(source, 'View field kind source');
    this.updateSelectionCursor();
  }

  /**
   * @param {string} viewId
   * @returns {'none'|'continuous'|'categorical'}
   */
  _fieldKindForView(viewId) {
    return requireViewFieldKind(this.getViewFieldKind(viewId), viewId);
  }

  /**
   * Field kind of the pane under the last known pointer position, or null
   * when the pointer has not been seen or is over no pane (an empty grid
   * slot).
   *
   * @returns {'none'|'continuous'|'categorical'|null}
   */
  _fieldKindAtPointer() {
    if (Number.isNaN(this._pointerClientX)) return null;
    const viewId = this.getViewIdAtCanvasPoint(
      this._pointerClientX - this._canvasOriginX,
      this._pointerClientY - this._canvasOriginY
    );
    return viewId === null ? null : this._fieldKindForView(viewId);
  }

  /** Read the canvas origin once, as a selection gesture becomes armed. */
  _refreshCanvasOrigin() {
    const rect = this.canvas.getBoundingClientRect();
    this._canvasOriginX = rect.left;
    this._canvasOriginY = rect.top;
  }

  /** Is the annotation tool the one an armed press would run? */
  _annotationToolArmed() {
    return (
      this.isSelectionGestureArmed()
      && this.cellSelectionEnabled
      && !this.lassoEnabled
      && !this.proximityEnabled
      && !this.knnEnabled
    );
  }

  setCellSelectionEnabled(enabled) {
    this.cellSelectionEnabled = requireExactBoolean(
      enabled,
      'Cell selection state'
    );
  }

  getCellSelectionEnabled() {
    return this.cellSelectionEnabled;
  }

  setCellSelectionCallback(callback) {
    this.cellSelectionCallback = requireCallback(
      callback,
      'Cell selection callback'
    );
  }

  setSelectionStepCallback(callback) {
    this.selectionStepCallback = requireCallback(
      callback,
      'Selection step callback'
    );
  }

  setSelectionPreviewCallback(callback) {
    this.selectionPreviewCallback = requireCallback(
      callback,
      'Selection preview callback'
    );
  }

  getAnnotationState() {
    return {
      inProgress: this.annotationStepCount > 0,
      stepCount: this.annotationStepCount,
      lastMode: this.annotationLastMode
    };
  }

  confirmAnnotationSelection() {
    this.annotationStepCount = 0;
    this.annotationLastMode = 'intersect';
  }

  cancelAnnotationSelection() {
    this.annotationStepCount = 0;
    this.annotationLastMode = 'intersect';
    if (this.selectionStepCallback) {
      this.selectionStepCallback({
        cancelled: true,
        step: 0,
        candidateCount: 0
      });
    }
  }

  // === Lasso ===
  setLassoEnabled(enabled) {
    this.lassoEnabled = requireExactBoolean(enabled, 'Lasso selection state');
    if (!this.lassoEnabled) {
      if (this.isLassoing) {
        this._retireActiveSpatialInteractions(
          this.lassoViewContext?.viewId ?? null
        );
      }
    }
    if (this.lassoEnabled) {
      this.canvas.classList.add('lasso-mode');
    } else {
      this.canvas.classList.remove('lasso-mode');
    }
    this.updateSelectionCursor();
  }

  getLassoEnabled() {
    return this.lassoEnabled;
  }

  setLassoCallback(callback) {
    this.lassoCallback = requireCallback(callback, 'Lasso selection callback');
  }

  setLassoPreviewCallback(callback) {
    this.lassoPreviewCallback = requireCallback(
      callback,
      'Lasso preview callback'
    );
  }

  clearLasso() {
    if (this.isLassoing) {
      this._retireActiveSpatialInteractions(
        this.lassoViewContext?.viewId ?? null
      );
      return;
    }
    clearLassoOverlay({ canvas: this.canvas, lassoCtx: this.lassoCtx });
    this.lassoPath = [];
    this.lassoViewContext = null;
  }

  setLassoStepCallback(callback) {
    this.lassoStepCallback = requireCallback(callback, 'Lasso step callback');
  }

  getLassoState() {
    return {
      inProgress: this.lassoCandidateSet !== null,
      stepCount: this.lassoStepCount,
      candidateCount: this.lassoCandidateSet ? this.lassoCandidateSet.size : 0
    };
  }

  confirmLassoSelection() {
    if (this.lassoCandidateSet && this.lassoCandidateSet.size > 0) {
      const finalIndices = this.lassoCandidateSet.toUint32Array();
      if (this.lassoCallback) {
        this.lassoCallback({
          type: 'lasso',
          cellIndices: finalIndices,
          cellCount: finalIndices.length,
          steps: this.lassoStepCount
        });
      }
    }
    this.lassoCandidateSet = null;
    this.lassoStepCount = 0;
  }

  cancelLassoSelection() {
    if (this.isLassoing) {
      this._retireActiveSpatialInteractions(
        this.lassoViewContext?.viewId ?? null
      );
    }
    this.lassoCandidateSet = null;
    this.lassoStepCount = 0;
    if (this.lassoStepCallback) {
      this.lassoStepCallback({
        step: 0,
        candidateCount: 0,
        candidates: new Uint32Array(0),
        cancelled: true
      });
    }
  }

  restoreLassoState(candidates, step) {
    if (candidates && candidates.length > 0) {
      this.lassoCandidateSet = CellSet.fromCellList(candidates, this.getViewTransparency('live').length);
      this.lassoStepCount = step;
    } else {
      this.lassoCandidateSet = null;
      this.lassoStepCount = 0;
    }
  }

  // === Proximity ===
  setProximityEnabled(enabled) {
    this.proximityEnabled = requireExactBoolean(
      enabled,
      'Proximity selection state'
    );
    if (!this.proximityEnabled) {
      if (this.isProximityDragging) {
        this._retireActiveSpatialInteractions(
          this.proximityCenter?.viewId ?? null
        );
      }
    }
    if (this.proximityEnabled) {
      this.canvas.classList.add('proximity-mode');
    } else {
      this.canvas.classList.remove('proximity-mode');
    }
    this.updateSelectionCursor();
  }

  getProximityEnabled() {
    return this.proximityEnabled;
  }

  setProximityCallback(callback) {
    this.proximityCallback = requireCallback(
      callback,
      'Proximity selection callback'
    );
  }

  setProximityPreviewCallback(callback) {
    this.proximityPreviewCallback = requireCallback(
      callback,
      'Proximity preview callback'
    );
  }

  setProximityStepCallback(callback) {
    this.proximityStepCallback = requireCallback(
      callback,
      'Proximity step callback'
    );
  }

  getProximityState() {
    return {
      inProgress: this.proximityCandidateSet !== null,
      stepCount: this.proximityStepCount,
      candidateCount: this.proximityCandidateSet ? this.proximityCandidateSet.size : 0
    };
  }

  confirmProximitySelection() {
    if (this.proximityCandidateSet && this.proximityCandidateSet.size > 0) {
      const finalIndices = this.proximityCandidateSet.toUint32Array();
      if (this.proximityCallback) {
        this.proximityCallback({
          type: 'proximity',
          cellIndices: finalIndices,
          cellCount: finalIndices.length,
          steps: this.proximityStepCount
        });
      }
    }
    this.proximityCandidateSet = null;
    this.proximityStepCount = 0;
  }

  cancelProximitySelection() {
    if (this.isProximityDragging) {
      this._retireActiveSpatialInteractions(
        this.proximityCenter?.viewId ?? null
      );
    }
    this.proximityCandidateSet = null;
    this.proximityStepCount = 0;
    if (this.proximityStepCallback) {
      this.proximityStepCallback({
        step: 0,
        candidateCount: 0,
        candidates: new Uint32Array(0),
        cancelled: true
      });
    }
  }

  restoreProximityState(candidates, step) {
    if (candidates && candidates.length > 0) {
      this.proximityCandidateSet = CellSet.fromCellList(candidates, this.getViewTransparency('live').length);
      this.proximityStepCount = step;
    } else {
      this.proximityCandidateSet = null;
      this.proximityStepCount = 0;
    }
  }

  // === KNN ===
  setKnnEnabled(enabled) {
    this.knnEnabled = requireExactBoolean(enabled, 'KNN selection state');
    if (!this.knnEnabled) {
      if (this.isKnnDragging) {
        this.isKnnDragging = false;
        clearKnnOverlay({ canvas: this.canvas, lassoCtx: this.lassoCtx });
        this._knnExpansion = null;
        this.canvas.classList.remove('knn-dragging');
      }
    } else if (!this.knnEdgesLoaded && this.knnEdgeLoadCallback) {
      this.knnEdgeLoadCallback();
    }
    if (this.knnEnabled) {
      this.canvas.classList.add('knn-mode');
    } else {
      this.canvas.classList.remove('knn-mode');
    }
    this.updateSelectionCursor();
  }

  getKnnEnabled() {
    return this.knnEnabled;
  }

  setKnnCallback(callback) {
    this.knnCallback = requireCallback(callback, 'KNN selection callback');
  }

  setKnnPreviewCallback(callback) {
    this.knnPreviewCallback = requireCallback(
      callback,
      'KNN preview callback'
    );
  }

  setKnnStepCallback(callback) {
    this.knnStepCallback = requireCallback(callback, 'KNN step callback');
  }

  setKnnEdgeLoadCallback(callback) {
    this.knnEdgeLoadCallback = requireCallback(
      callback,
      'KNN edge-load callback'
    );
  }

  getKnnState() {
    return {
      inProgress: this.knnCandidateSet !== null,
      stepCount: this.knnStepCount,
      candidateCount: this.knnCandidateSet ? this.knnCandidateSet.size : 0,
      edgesLoaded: this.knnEdgesLoaded
    };
  }

  /**
   * Load the k-NN tool's graph: the adjacency the reader worker built with
   * the edges (`ConnectivityEdges` of `data/connectivity-edges.js`), used as it is.
   *
   * @param {import('../data/connectivity-edges.js').ConnectivityEdges} graph
   * @param {number} cellCount - Cells of the published views.
   * @returns {true}
   */
  loadKnnEdges(graph, cellCount) {
    requireKnnGraph(graph);
    if (graph.nCells !== cellCount) {
      throw new RangeError(
        `The KNN graph covers ${formatCountOf(graph.nCells, 'cell')}; the views hold ${cellCount}.`
      );
    }
    this._knnExpansion = null;
    this.knnGraph = graph;
    this.knnEdgesLoaded = true;
    return true;
  }

  clearKnnEdges() {
    const hadActiveOverlay =
      this.isKnnDragging || this.knnSeedCell !== null;

    this.isKnnDragging = false;
    this.canvas.classList.remove('knn-dragging');
    if (hadActiveOverlay) {
      clearKnnOverlay({ canvas: this.canvas, lassoCtx: this.lassoCtx });
    }
    this._knnExpansion = null;
    this.knnSeedCell = null;
    this.knnCurrentDegree = 0;
    this.knnCandidateSet = null;
    this.knnStepCount = 0;
    this.knnGraph = null;
    this.knnEdgesLoaded = false;
    this.updateSelectionCursor();
  }

  isKnnEdgesLoaded() {
    return this.knnEdgesLoaded;
  }

  confirmKnnSelection() {
    if (this.knnCandidateSet && this.knnCandidateSet.size > 0) {
      const finalIndices = this.knnCandidateSet.toUint32Array();
      if (this.knnCallback) {
        this.knnCallback({
          type: 'knn',
          cellIndices: finalIndices,
          cellCount: finalIndices.length,
          steps: this.knnStepCount
        });
      }
    }
    this.knnCandidateSet = null;
    this.knnStepCount = 0;
  }

  cancelKnnSelection() {
    this.knnCandidateSet = null;
    this.knnStepCount = 0;
    if (this.knnStepCallback) {
      this.knnStepCallback({
        step: 0,
        candidateCount: 0,
        candidates: new Uint32Array(0),
        cancelled: true
      });
    }
    if (this.isKnnDragging) {
      this.isKnnDragging = false;
      this.canvas.classList.remove('knn-dragging');
      clearKnnOverlay({ canvas: this.canvas, lassoCtx: this.lassoCtx });
      this._knnExpansion = null;
      this.knnSeedCell = null;
      this.knnCurrentDegree = 0;
      this.updateSelectionCursor();
    }
  }

  restoreKnnState(candidates, step) {
    if (candidates && candidates.length > 0) {
      this.knnCandidateSet = CellSet.fromCellList(candidates, this.getViewTransparency('live').length);
      this.knnStepCount = step;
    } else {
      this.knnCandidateSet = null;
      this.knnStepCount = 0;
    }
  }

  // === Cursor helpers ===
  isInteractionActive() {
    return this.isLassoing || this.isProximityDragging || this.isKnnDragging || this.selectionDragStart;
  }

  /**
   * Show the cursor of the gesture a press would start right now.
   *
   * The spatial tools draw the same cursor everywhere. The annotation tool's
   * depends on the field of the pane under the pointer — the pane a press
   * would read — so in a grid of views it changes as the pointer crosses from
   * a continuous pane to a categorical one, whatever the focused view shows.
   */
  updateSelectionCursor() {
    const armed = this.isSelectionGestureArmed();
    const annotationArmed = this._annotationToolArmed();
    // Recorded before the early returns, so the pointer-move check in
    // `handlePointerMove` compares against what was resolved, and calls back
    // here only when the pointer reaches a pane of another kind.
    this._pointerPaneFieldKind = annotationArmed
      ? this._fieldKindAtPointer()
      : null;

    const navState = this.getNavigationState();
    if (navState.navigationMode === 'free') return;
    if (navState.isDragging) return;
    if (this.selectionDragStart) return;
    if (this.isLassoing) return;
    if (this.isProximityDragging) return;

    if (armed && this.lassoEnabled) {
      this.canvas.style.cursor = 'crosshair';
    } else if (armed && this.proximityEnabled) {
      this.canvas.style.cursor = 'crosshair';
    } else if (armed && this.knnEnabled) {
      this.canvas.style.cursor = 'ns-resize';
    } else if (annotationArmed && this._pointerPaneFieldKind !== null) {
      this.canvas.style.cursor =
        ANNOTATION_CURSOR_BY_FIELD_KIND[this._pointerPaneFieldKind];
    } else {
      this.canvas.style.cursor = 'grab';
    }
  }

  /**
   * Would a plain primary press start a selection gesture right now?
   *
   * @returns {boolean}
   */
  isSelectionGestureArmed() {
    return this.altKeyDown || this.selectMode.enabled;
  }

  /**
   * Publish select mode, the on-screen stand-in for a held Alt key.
   *
   * @param {{enabled: boolean, combine: 'intersect'|'union'|'subtract'}} selectMode
   */
  setSelectMode(selectMode) {
    const exactSelectMode = requireSelectMode(selectMode);
    if (!this.isSelectionGestureArmed() && exactSelectMode.enabled) {
      this._refreshCanvasOrigin();
    }
    this.selectMode = exactSelectMode;
    this.updateSelectionCursor();
  }

  /** @returns {Readonly<{enabled: boolean, combine: string}>} */
  getSelectMode() {
    return this.selectMode;
  }

  handleAltKeyDown() {
    // A held key repeats its keydown; the origin is read once, on arming.
    if (!this.isSelectionGestureArmed()) this._refreshCanvasOrigin();
    this.altKeyDown = true;
    this.updateSelectionCursor();
  }

  handleAltKeyUp() {
    this.altKeyDown = false;
    this.updateSelectionCursor();
  }

  handleWindowBlur() {
    this._retireActiveSpatialInteractions();
    this.altKeyDown = false;
    this.updateSelectionCursor();
  }

  /**
   * Report a selection gesture this renderer consumed but turned into no step.
   *
   * An input gesture the renderer consumes has to produce an outcome the app
   * can observe. A pick that finds no cell — points draw around a pixel wide,
   * so missing is constant — and a release that lands off the view both used
   * to return without publishing anything, which left no code anywhere able to
   * tell that a click had even happened. The reason is all the renderer
   * decides; the wording belongs to the tool that owns the panel.
   *
   * @param {'annotation'|'knn'|'proximity'|'lasso'} tool
   * @param {'no-cell-under-pointer'|'no-field-in-pane'|'released-off-view'|'interrupted'} reason
   * @returns {boolean} true when a listening tool was told
   */
  _publishAbandonedGesture(tool, reason) {
    const callback = {
      annotation: this.selectionStepCallback,
      knn: this.knnStepCallback,
      proximity: this.proximityStepCallback,
      lasso: this.lassoStepCallback
    }[tool];
    if (!callback) return false;
    callback({ abandoned: reason, step: 0, candidateCount: 0 });
    return true;
  }

  // === Gesture cell queries ===
  //
  // Each drag tool answers its pointer moves from one cell query built for
  // the gesture (selection-gesture-queries.js). Building it is a pass over
  // the cells; that pass, like a deep k-NN expansion, runs in slices of
  // SELECTION_SLICE_MS, the first one in the input event and the rest as
  // separate tasks, and the preview is published when it completes. A
  // release finishes whatever is left before committing.

  _transparencyGeneration(viewId) {
    return this._getTransparencyGenerations().get(viewId) ?? 0;
  }

  /**
   * The lasso's hit test for the gesture in flight, holding every vertex of
   * `lassoPath`; built when missing or when the pane's filtering changed.
   *
   * @returns {LassoHitTest}
   */
  _lassoQuery() {
    const context = this.lassoViewContext;
    const owner = context.spatialOwner;
    const generation = this._transparencyGeneration(context.viewId);
    let record = this._lassoHitTest;
    if (!record || record.owner !== owner || record.generation !== generation) {
      const viewport = requireHighlightViewport(
        context.viewport,
        'Lasso-selection viewport'
      );
      const mvpMatrix = this.mat4.create();
      this.mat4.multiply(
        mvpMatrix,
        viewport.projectionMatrix,
        requireHighlightMatrix(context.viewMatrix, 'Lasso-selection view matrix')
      );
      this.mat4.multiply(
        mvpMatrix,
        mvpMatrix,
        requireHighlightMatrix(context.modelMatrix, 'Lasso-selection model matrix')
      );
      record = {
        owner,
        generation,
        query: new LassoHitTest({
          positions: owner.publishedPositions,
          dimensionLevel: owner.dimensionLevel,
          transparency: owner.transparency,
          mvpMatrix,
          viewport,
        }),
      };
      this._lassoHitTest = record;
    }
    const query = record.query;
    for (let index = query.vertexCount; index < this.lassoPath.length; index++) {
      query.appendVertex(this.lassoPath[index].x, this.lassoPath[index].y);
    }
    return query;
  }

  /**
   * The proximity hit test for the gesture in flight, at the current radius;
   * built when missing or when the pane's filtering changed.
   *
   * @returns {ProximityHitTest}
   */
  _proximityQuery() {
    const center = this.proximityCenter;
    const owner = center.spatialOwner;
    const generation = this._transparencyGeneration(center.viewId);
    let record = this._proximityHitTest;
    if (
      !record ||
      record.center !== center ||
      record.owner !== owner ||
      record.generation !== generation
    ) {
      record = {
        center,
        owner,
        generation,
        query: new ProximityHitTest({
          positions: owner.publishedPositions,
          dimensionLevel: owner.dimensionLevel,
          transparency: owner.transparency,
          center: center.worldPos,
        }),
      };
      this._proximityHitTest = record;
    }
    record.query.setRadius(this.proximityCurrentRadius);
    return record.query;
  }

  /**
   * The k-NN expansion of the gesture in flight, through the cells its view
   * draws; built when missing or when the graph or the view's filtering
   * changed.
   *
   * @returns {KnnExpansion}
   */
  _knnQuery() {
    const seed = this.knnSeedCell;
    const viewId = requireHighlightViewId(seed.viewId, 'KNN-selection viewId');
    const transparency = this.getViewTransparency(viewId);
    const generation = this._transparencyGeneration(viewId);
    const graph = this.knnGraph;
    const record = this._knnExpansion;
    if (
      record &&
      record.seed === seed &&
      record.graph === graph &&
      record.transparency === transparency &&
      record.generation === generation
    ) {
      return record.query;
    }
    const query = new KnnExpansion({ graph, seed: seed.cellIndex, transparency });
    this._knnExpansion = { seed, graph, transparency, generation, query };
    return query;
  }

  /** Continue the gesture's pending pass as a separate task. */
  _scheduleSelectionWork() {
    if (this._selectionWorkScheduled === true) return;
    this._selectionWorkScheduled = true;
    void yieldToMacrotask().then(() => {
      this._selectionWorkScheduled = false;
      if (this._disposed !== true) this._advanceSelectionWork();
    });
  }

  /**
   * Run one slice of the pending pass of the gesture in flight; publish its
   * preview when the pass completes, or schedule the next slice.
   */
  _advanceSelectionWork() {
    const deadline = performance.now() + SELECTION_SLICE_MS;
    if (this.isLassoing && this.lassoViewContext) {
      if (!this._spatialQueryOwnerIsCurrent(this.lassoViewContext.spatialOwner)) {
        this._retireActiveSpatialInteractions(this.lassoViewContext.viewId);
        return;
      }
      const query = this._lassoQuery();
      if (!query.prepare(deadline)) {
        this._scheduleSelectionWork();
      } else if (this.lassoPreviewCallback && this.lassoPath.length >= 3) {
        this._publishLassoPreview(query);
      }
      return;
    }
    if (this.isProximityDragging && this.proximityCenter) {
      if (!this._spatialQueryOwnerIsCurrent(this.proximityCenter.spatialOwner)) {
        this._retireActiveSpatialInteractions(this.proximityCenter.viewId);
        return;
      }
      const query = this._proximityQuery();
      if (!query.prepare(deadline)) {
        this._scheduleSelectionWork();
      } else if (this.proximityPreviewCallback && this.proximityCurrentRadius > 0) {
        this._publishProximityPreview(query);
      }
      return;
    }
    if (this.isKnnDragging && this.knnSeedCell && this.knnGraph && this.knnPreviewCallback) {
      const query = this._knnQuery();
      if (!query.expandTo(this.knnCurrentDegree, deadline)) {
        this._scheduleSelectionWork();
      } else {
        this._publishKnnPreview(query);
      }
    }
  }

  _publishLassoPreview(query) {
    const hits = query.hits();
    // Combine against the accumulated candidates exactly as the KNN and
    // proximity previews do: the preview shows what the release would leave
    // selected, not the polygon's own hits.
    const mode = this.lassoMode || 'intersect';
    const combinedIndices = combineCandidatePreview(this.lassoCandidateSet, hits, mode);
    this._lassoPreviewPublished = true;
    this.lassoPreviewCallback({
      type: 'lasso-preview',
      cellIndices: combinedIndices,
      cellCount: combinedIndices.length,
      newCellCount: hits.size,
      mode: mode,
      polygon: [...this.lassoPath]
    });
  }

  _publishProximityPreview(query) {
    const hits = query.hits();
    const mode = this.proximityCenter.mode || 'intersect';
    const combinedIndices = combineCandidatePreview(this.proximityCandidateSet, hits, mode);
    this._proximityPreviewPublished = true;
    this.proximityPreviewCallback({
      type: 'proximity-preview',
      cellIndices: combinedIndices,
      cellCount: combinedIndices.length,
      newCellCount: hits.size,
      centerCellIndex: this.proximityCenter.cellIndex,
      radius: this.proximityCurrentRadius,
      mode: mode
    });
  }

  _publishKnnPreview(query) {
    const cells = query.cells();
    const mode = this.knnSeedCell.mode || 'intersect';
    const combinedIndices = combineCandidatePreview(this.knnCandidateSet, cells, mode);
    this.knnPreviewCallback({
      type: 'knn-preview',
      cellIndices: combinedIndices,
      cellCount: combinedIndices.length,
      newCellCount: cells.size,
      seedCellIndex: this.knnSeedCell.cellIndex,
      degree: this.knnCurrentDegree,
      mode: mode
    });
  }

  // === Event handling ===
  //
  // One press, move, release pipeline serves every pointer. The viewer feeds it
  // mouse events and the PointerEvents of a finger or pen alike, and
  // `resolveSelectionGestureCombine` is the single place that decides whether a
  // press is a selection gesture (Alt held, or select mode on) and how it
  // combines (Ctrl/Cmd, Shift, or select mode's choice).
  handlePointerDown(e) {
    const combine = resolveSelectionGestureCombine(e, this.selectMode);
    if (combine === null) return false;
    this._pointerClientX = e.clientX;
    this._pointerClientY = e.clientY;
    const ctx = this.getRenderContext();

    if (this.lassoEnabled) {
      const rect = this.canvas.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;

      const vpInfo = captureHighlightViewport(
        this.getViewportInfoAtScreen(e.clientX, e.clientY),
        this.mat4,
        'Lasso interaction viewport'
      );
      const viewId = requireHighlightViewId(
        vpInfo.viewId,
        'Lasso interaction viewId'
      );
      const spatialOwner = requireSpatialQueryOwner(
        this.getSpatialQueryOwner(viewId, false),
        viewId
      );
      const capturedViewMatrix = this.mat4.create();
      const sourceViewMatrix = vpInfo.effectiveViewMatrix === null
        ? requireHighlightMatrix(ctx.viewMatrix, 'Lasso interaction view matrix')
        : vpInfo.effectiveViewMatrix;
      this.mat4.copy(capturedViewMatrix, sourceViewMatrix);
      const capturedModelMatrix = this.mat4.create();
      this.mat4.copy(
        capturedModelMatrix,
        requireHighlightMatrix(
          ctx.modelMatrix,
          'Lasso interaction model matrix'
        )
      );

      this.isLassoing = true;
      this.lassoMode = combine;
      this.lassoPath = [{ x: localX, y: localY }];
      this._lassoPreviewPublished = false;
      this.lassoViewContext = {
        viewId,
        viewport: vpInfo,
        viewMatrix: capturedViewMatrix,
        modelMatrix: capturedModelMatrix,
        spatialOwner
      };
      // Project the cells while the gesture begins.
      this._lassoHitTest = null;
      if (!this._lassoQuery().prepare(performance.now() + SELECTION_SLICE_MS)) {
        this._scheduleSelectionWork();
      }

      this.canvas.style.cursor = 'crosshair';
      this.canvas.classList.add('lassoing');
      drawLasso({ canvas: this.canvas, lassoCtx: this.lassoCtx, lassoPath: this.lassoPath });
      e.preventDefault();
      return true;
    }

    if (this.proximityEnabled) {
      const cellIdx = this.pickCellAtScreen(e.clientX, e.clientY);

      // Get view-specific positions for multi-dimensional support
      const vpInfo = captureHighlightViewport(
        this.getViewportInfoAtScreen(e.clientX, e.clientY),
        this.mat4,
        'Proximity interaction viewport'
      );
      const viewId = requireHighlightViewId(
        vpInfo.viewId,
        'Proximity interaction viewId'
      );
      const spatialOwner = requireSpatialQueryOwner(
        this.getSpatialQueryOwner(viewId, false),
        viewId
      );
      const positions = spatialOwner.publishedPositions;
      const capturedViewMatrix = this.mat4.create();
      const sourceViewMatrix = vpInfo.effectiveViewMatrix === null
        ? requireHighlightMatrix(
          ctx.viewMatrix,
          'Proximity interaction view matrix'
        )
        : vpInfo.effectiveViewMatrix;
      this.mat4.copy(capturedViewMatrix, sourceViewMatrix);
      const capturedModelMatrix = this.mat4.create();
      this.mat4.copy(
        capturedModelMatrix,
        requireHighlightMatrix(
          ctx.modelMatrix,
          'Proximity interaction model matrix'
        )
      );

      let worldPos = null;
      let clickedCellIdx = cellIdx;

      const positionDimension = spatialOwner.dimensionLevel;
      if (cellIdx >= 0) {
        worldPos = readPositionXYZ(
          positions,
          positionDimension,
          cellIdx,
          [0, 0, 0]
        );
      } else if (this.proximityCandidateSet && this.proximityCandidateSet.size > 0) {
        let cx = 0, cy = 0, cz = 0;
        const point = [0, 0, 0];
        this.proximityCandidateSet.forEach(idx => {
          readPositionXYZ(positions, positionDimension, idx, point);
          cx += point[0];
          cy += point[1];
          cz += point[2];
        });
        const count = this.proximityCandidateSet.size;
        cx /= count; cy /= count; cz /= count;

        const rayViewMatrix = vpInfo.effectiveViewMatrix === null
          ? requireHighlightMatrix(
            ctx.viewMatrix,
            'Proximity interaction view matrix'
          )
          : vpInfo.effectiveViewMatrix;
        const ray = this.screenToRay(
          vpInfo.vpLocalX,
          vpInfo.vpLocalY,
          vpInfo.vpWidth,
          vpInfo.vpHeight,
          vpInfo.vpAspect,
          rayViewMatrix,
          vpInfo.projectionCenterNdcX
        );

        if (ray) {
          const viewDir = vpInfo.cameraForward;
          const centroid = [cx, cy, cz];
          const denom = viewDir[0] * ray.direction[0] + viewDir[1] * ray.direction[1] + viewDir[2] * ray.direction[2];

          if (Math.abs(denom) > 1e-6) {
            const diff = [centroid[0] - ray.origin[0], centroid[1] - ray.origin[1], centroid[2] - ray.origin[2]];
            const t = (viewDir[0] * diff[0] + viewDir[1] * diff[1] + viewDir[2] * diff[2]) / denom;

            if (t > 0) {
              worldPos = [
                ray.origin[0] + t * ray.direction[0],
                ray.origin[1] + t * ray.direction[1],
                ray.origin[2] + t * ray.direction[2]
              ];
              clickedCellIdx = -1;
            }
          }
        }
      }

      if (worldPos) {
        this.proximityCenter = {
          screenX: e.clientX,
          screenY: e.clientY,
          worldPos: worldPos,
          cellIndex: clickedCellIdx,
          mode: combine,
          viewport: vpInfo,
          viewId,
          viewMatrix: capturedViewMatrix,
          modelMatrix: capturedModelMatrix,
          spatialOwner
        };
        this.proximityCurrentRadius = 0;
        this._proximityPreviewPublished = false;
        this.isProximityDragging = true;
        // Measure the cells' distances while the gesture begins.
        this._proximityHitTest = null;
        if (!this._proximityQuery().prepare(performance.now() + SELECTION_SLICE_MS)) {
          this._scheduleSelectionWork();
        }
        this.canvas.style.cursor = 'crosshair';
        this.canvas.classList.add('proximity-dragging');
        drawProximityIndicator({
          canvas: this.canvas,
          lassoCtx: this.lassoCtx,
          proximityCenter: this.proximityCenter,
          proximityCurrentRadius: this.proximityCurrentRadius,
          mat4: this.mat4,
          viewMatrix: capturedViewMatrix,
          modelMatrix: capturedModelMatrix
        });
        e.preventDefault();
        return true;
      }
      this._publishAbandonedGesture('proximity', 'no-cell-under-pointer');
    }

    if (this.knnEnabled) {
      const cellIdx = this.pickCellAtScreen(e.clientX, e.clientY);

      if (cellIdx >= 0) {
        if (!this.knnEdgesLoaded && this.knnEdgeLoadCallback) {
          this.knnEdgeLoadCallback();
          return true;
        }

        const vpInfo = captureHighlightViewport(
          this.getViewportInfoAtScreen(e.clientX, e.clientY),
          this.mat4,
          'KNN interaction viewport'
        );
        const viewId = requireHighlightViewId(
          vpInfo.viewId,
          'KNN interaction viewId'
        );
        this.knnSeedCell = {
          screenX: e.clientX,
          screenY: e.clientY,
          cellIndex: cellIdx,
          mode: combine,
          viewport: vpInfo,
          viewId: viewId  // Store viewId for multi-dimensional support
        };
        this.knnCurrentDegree = 0;
        this._knnExpansion = null;
        this.isKnnDragging = true;
        this.canvas.style.cursor = 'ns-resize';
        this.canvas.classList.add('knn-dragging');
        // Get view-specific positions for multi-dimensional support
        const knnOwner = requireSpatialQueryOwner(
          this.getSpatialQueryOwner(viewId, false),
          viewId
        );
        drawKnnIndicator({
          canvas: this.canvas,
          lassoCtx: this.lassoCtx,
          knnSeedCell: this.knnSeedCell,
          knnCurrentDegree: this.knnCurrentDegree,
          mat4: this.mat4,
          viewMatrix: ctx.viewMatrix,
          modelMatrix: ctx.modelMatrix,
          viewPositions: knnOwner.publishedPositions,
          dimensionLevel: knnOwner.dimensionLevel
        });
        e.preventDefault();
        return true;
      }
      this._publishAbandonedGesture('knn', 'no-cell-under-pointer');
    }

    if (this.cellSelectionEnabled) {
      e.preventDefault();
      // A spatial tool reaches here only after a press it could not start,
      // and has already reported that miss itself; the annotation tool owns
      // the panel only when none of them is enabled.
      if (this.proximityEnabled || this.knnEnabled) return false;
      return this._beginAnnotationGesture(e, combine);
    }

    return false;
  }

  /**
   * Start an annotation gesture on the pane under the press, read on that
   * pane's own field.
   *
   * A selection gesture never moves view focus, so the pane pressed need not
   * be the focused one, and whether it can select anything is that pane's
   * question alone: a press in a pane colored by a field starts even when the
   * focused view is colored by none, and a press in a pane colored by none is
   * consumed and reported, whatever the focused view shows.
   *
   * @returns {boolean} true when the press was consumed
   */
  _beginAnnotationGesture(e, combine) {
    const vpInfo = this.getViewportInfoAtScreen(e.clientX, e.clientY);
    const viewId = vpInfo === -1
      ? null
      : requireHighlightViewId(vpInfo.viewId, 'Cell-selection viewId');
    const fieldKind = viewId === null ? null : this._fieldKindForView(viewId);
    if (fieldKind === 'none') {
      this._publishAbandonedGesture('annotation', 'no-field-in-pane');
      return true;
    }
    const cellIdx = this.pickCellAtScreen(e.clientX, e.clientY);
    if (cellIdx < 0 || viewId === null) {
      this._publishAbandonedGesture('annotation', 'no-cell-under-pointer');
      return false;
    }
    this.selectionDragStart = {
      x: e.clientX,
      y: e.clientY,
      cellIndex: cellIdx,
      mode: combine,
      viewId
    };
    this.selectionDragCurrent = { x: e.clientX, y: e.clientY };
    this.canvas.style.cursor = ANNOTATION_CURSOR_BY_FIELD_KIND[fieldKind];
    this.canvas.classList.add(
      fieldKind === 'continuous' ? 'selecting-continuous' : 'selecting'
    );
    return true;
  }

  handlePointerMove(e) {
    this._pointerClientX = e.clientX;
    this._pointerClientY = e.clientY;
    const ctx = this.getRenderContext();

    if (this.isLassoing) {
      const spatialOwner = this.lassoViewContext?.spatialOwner;
      if (
        !spatialOwner ||
        !this._spatialQueryOwnerIsCurrent(spatialOwner)
      ) {
        this._retireActiveSpatialInteractions(
          this.lassoViewContext?.viewId ?? null
        );
        return true;
      }
      const rect = this.canvas.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;

      const lastPt = this.lassoPath[this.lassoPath.length - 1];
      const dx = localX - lastPt.x;
      const dy = localY - lastPt.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= 3) {
        this.lassoPath.push({ x: localX, y: localY });
        drawLasso({ canvas: this.canvas, lassoCtx: this.lassoCtx, lassoPath: this.lassoPath });

        const query = this._lassoQuery();
        if (!query.prepare(performance.now() + SELECTION_SLICE_MS)) {
          this._scheduleSelectionWork();
        } else if (this.lassoPreviewCallback && this.lassoPath.length >= 3) {
          this._publishLassoPreview(query);
        }
      }
      return true;
    }

    if (this.isProximityDragging && this.proximityCenter) {
      const spatialOwner = this.proximityCenter.spatialOwner;
      if (
        !spatialOwner ||
        !this._spatialQueryOwnerIsCurrent(spatialOwner)
      ) {
        this._retireActiveSpatialInteractions(
          this.proximityCenter.viewId
        );
        return true;
      }
      const dx = e.clientX - this.proximityCenter.screenX;
      const dy = e.clientY - this.proximityCenter.screenY;
      const pixelDist = Math.sqrt(dx * dx + dy * dy);

      this.proximityCurrentRadius = pixelDistanceToWorldRadius(
        pixelDist,
        this.proximityCenter.viewport.cameraTargetRadius
      );

      drawProximityIndicator({
        canvas: this.canvas,
        lassoCtx: this.lassoCtx,
        proximityCenter: this.proximityCenter,
        proximityCurrentRadius: this.proximityCurrentRadius,
        mat4: this.mat4,
        viewMatrix: this.proximityCenter.viewMatrix,
        modelMatrix: this.proximityCenter.modelMatrix
      });

      const query = this._proximityQuery();
      if (!query.prepare(performance.now() + SELECTION_SLICE_MS)) {
        this._scheduleSelectionWork();
      } else if (this.proximityPreviewCallback && this.proximityCurrentRadius > 0) {
        this._publishProximityPreview(query);
      }
      return true;
    }

    if (this.isKnnDragging && this.knnSeedCell && this.knnGraph) {
      const dx = e.clientX - this.knnSeedCell.screenX;
      const dy = e.clientY - this.knnSeedCell.screenY;
      const pixelDist = Math.sqrt(dx * dx + dy * dy);

      const newDegree = pixelDistanceToKnnDegree(pixelDist);

      if (newDegree !== this.knnCurrentDegree) {
        this.knnCurrentDegree = newDegree;

        // Get view-specific positions for multi-dimensional support
        const knnViewId = requireHighlightViewId(
          this.knnSeedCell.viewId,
          'KNN-preview viewId'
        );
        const knnOwner = requireSpatialQueryOwner(
          this.getSpatialQueryOwner(knnViewId, false),
          knnViewId
        );
        drawKnnIndicator({
          canvas: this.canvas,
          lassoCtx: this.lassoCtx,
          knnSeedCell: this.knnSeedCell,
          knnCurrentDegree: this.knnCurrentDegree,
          mat4: this.mat4,
          viewMatrix: ctx.viewMatrix,
          modelMatrix: ctx.modelMatrix,
          viewPositions: knnOwner.publishedPositions,
          dimensionLevel: knnOwner.dimensionLevel
        });

        if (this.knnPreviewCallback) {
          // The expansion runs through the cells this view draws.
          const query = this._knnQuery();
          if (!query.expandTo(this.knnCurrentDegree, performance.now() + SELECTION_SLICE_MS)) {
            this._scheduleSelectionWork();
          } else {
            this._publishKnnPreview(query);
          }
        }
      }
      return true;
    }

    if (this.selectionDragStart) {
      this.selectionDragCurrent = { x: e.clientX, y: e.clientY };
      if (this.selectionPreviewCallback) {
        this.selectionPreviewCallback({
          type: 'preview',
          cellIndex: this.selectionDragStart.cellIndex,
          dragDeltaY: this.selectionDragCurrent.y - this.selectionDragStart.y,
          startX: this.selectionDragStart.x,
          startY: this.selectionDragStart.y,
          endX: this.selectionDragCurrent.x,
          endY: this.selectionDragCurrent.y,
          mode: this.selectionDragStart.mode || 'intersect',
          viewId: this.selectionDragStart.viewId  // Pass viewId for per-view filtering
        });
      }
      return true;
    }

    // Armed and idle: the annotation cursor follows the pane under the
    // pointer. One pane lookup and one field-kind read per move, and a cursor
    // write only when the pointer reaches a pane of another kind.
    if (
      this._annotationToolArmed()
      && this._fieldKindAtPointer() !== this._pointerPaneFieldKind
    ) {
      this.updateSelectionCursor();
    }

    return false;
  }

  /**
   * Retire the gesture in flight without committing it, and say why.
   *
   * @param {'released-off-view'|'interrupted'} reason
   * @returns {boolean} true when a gesture was in flight and was abandoned
   */
  _abandonInFlightGesture(reason) {
    let tool = null;
    if (this.isLassoing) tool = 'lasso';
    else if (this.isProximityDragging) tool = 'proximity';
    else if (this.isKnnDragging) tool = 'knn';
    else if (this.selectionDragStart) tool = 'annotation';
    if (tool === null) return false;

    this._retireActiveSpatialInteractions();
    if (this.isKnnDragging) {
      this.isKnnDragging = false;
      this.canvas.classList.remove('knn-dragging');
      clearKnnOverlay({ canvas: this.canvas, lassoCtx: this.lassoCtx });
      this._knnExpansion = null;
      this.knnSeedCell = null;
      this.knnCurrentDegree = 0;
      this.updateSelectionCursor();
    }
    if (this.selectionDragStart) {
      this.selectionDragStart = null;
      this.selectionDragCurrent = null;
      this.canvas.classList.remove('selecting');
      this.canvas.classList.remove('selecting-continuous');
      this.updateSelectionCursor();
    }
    this._publishAbandonedGesture(tool, reason);
    return true;
  }

  /**
   * Abandon the gesture in flight because the input that drew it was taken
   * away before it was released.
   *
   * A second finger landing turns a one-finger selection into a two-finger
   * camera gesture, and the browser cancels a pointer it claims for itself.
   * Neither is a release the user aimed, so neither may commit a step.
   *
   * @returns {boolean} true when a gesture was in flight and was abandoned
   */
  interruptPointerGesture() {
    return this._abandonInFlightGesture('interrupted');
  }

  /**
   * Finish the gesture in flight at the element the pointer was released over.
   *
   * The canvas fills the window and the controls float over it, so a drag that
   * wanders onto the sidebar keeps appending canvas-local points behind the
   * panel. Committing that release turned a gesture aimed at a button into a
   * selection of cells the sidebar was covering — cells the user never saw,
   * let alone enclosed. A release that lands off the render surface belongs to
   * whatever it landed on, so the gesture is retired and reported rather than
   * committed.
   *
   * The caller names the element because only it knows where a release
   * landed: a mouse release targets the element under the cursor, while a
   * finger's events stay with the canvas the touch began on, so the viewer
   * looks the element up at the release point instead.
   *
   * @param {Element|null|undefined} releaseTarget the element under the
   *   release point; `null` when the release is outside the document, and
   *   `undefined` only for a synthetic release that cannot be located, which is
   *   treated as landing on the view
   * @returns {boolean} true when the release finished a selection gesture
   */
  handlePointerUp(releaseTarget) {
    if (
      releaseTarget !== undefined
      && releaseTarget !== this.canvas
      && releaseTarget !== this.lassoCanvas
      && this._abandonInFlightGesture('released-off-view')
    ) {
      return true;
    }

    if (this.isLassoing) {
      const spatialOwner = this.lassoViewContext?.spatialOwner;
      if (
        !spatialOwner ||
        !this._spatialQueryOwnerIsCurrent(spatialOwner)
      ) {
        this._retireActiveSpatialInteractions(
          this.lassoViewContext?.viewId ?? null
        );
        return true;
      }
      this.isLassoing = false;
      this.canvas.classList.remove('lassoing');
      if (this.lassoPath.length >= 3) {
        const query = this._lassoQuery();
        query.prepare(Infinity);
        // Every closed polygon publishes its step, including one that encloses
        // nothing: intersecting a standing selection down to zero is an
        // outcome the user drew on purpose, and a subtract with nothing
        // selected yet is answered by the tool, exactly as proximity already
        // does. Dropping either left the drag preview's wiped highlight
        // standing under a panel still reporting the previous step.
        this.lassoCandidateSet = commitCandidateStep(
          this.lassoCandidateSet,
          query.hits(),
          this.lassoMode,
          spatialOwner.transparency.length
        );

        this.lassoStepCount++;
        if (this.lassoStepCallback) {
          this.lassoStepCallback({
            step: this.lassoStepCount,
            candidateCount: this.lassoCandidateSet.size,
            candidates: this.lassoCandidateSet.toUint32Array(),
            mode: this.lassoMode
          });
        }
      }
      clearLassoOverlay({ canvas: this.canvas, lassoCtx: this.lassoCtx });
      this.lassoPath = [];
      this.lassoViewContext = null;
      this._lassoHitTest = null;
      this._lassoPreviewPublished = false;
      this.updateSelectionCursor();
      return true;
    }

    if (this.isProximityDragging && this.proximityCenter) {
      const spatialOwner = this.proximityCenter.spatialOwner;
      if (
        !spatialOwner ||
        !this._spatialQueryOwnerIsCurrent(spatialOwner)
      ) {
        this._retireActiveSpatialInteractions(
          this.proximityCenter.viewId
        );
        return true;
      }
      this.isProximityDragging = false;
      this.canvas.classList.remove('proximity-dragging');

      if (this.proximityCurrentRadius > 0) {
        const query = this._proximityQuery();
        query.prepare(Infinity);
        const mode = this.proximityCenter.mode || 'intersect';
        this.proximityCandidateSet = commitCandidateStep(
          this.proximityCandidateSet,
          query.hits(),
          mode,
          spatialOwner.transparency.length
        );

        if (this.proximityCandidateSet) {
          this.proximityStepCount++;
          if (this.proximityStepCallback) {
            this.proximityStepCallback({
              step: this.proximityStepCount,
              candidateCount: this.proximityCandidateSet.size,
              candidates: this.proximityCandidateSet.toUint32Array(),
              mode: mode,
              centerCellIndex: this.proximityCenter.cellIndex,
              radius: this.proximityCurrentRadius
            });
          }
        }
      }

      clearProximityOverlay({ canvas: this.canvas, lassoCtx: this.lassoCtx });
      this.proximityCenter = null;
      this.proximityCurrentRadius = 0;
      this._proximityHitTest = null;
      this._proximityPreviewPublished = false;
      this.updateSelectionCursor();
      return true;
    }

    if (this.isKnnDragging && this.knnSeedCell) {
      this.isKnnDragging = false;
      this.canvas.classList.remove('knn-dragging');

      if (this.knnGraph && this.knnSeedCell) {
        const mode = this.knnSeedCell.mode || 'intersect';
        // The expansion runs through the cells this view draws.
        const query = this._knnQuery();
        query.expandTo(this.knnCurrentDegree, Infinity);
        const allCells = query.cells();
        // A subtract with nothing selected yet leaves an empty set, exactly
        // as proximity does, so the release still publishes a step the tool
        // can answer instead of vanishing under a wiped drag preview.
        this.knnCandidateSet = commitCandidateStep(
          this.knnCandidateSet,
          allCells,
          mode,
          allCells.cellCount
        );

        this.knnStepCount++;

        if (this.knnStepCallback) {
          this.knnStepCallback({
            step: this.knnStepCount,
            candidateCount: this.knnCandidateSet.size,
            candidates: this.knnCandidateSet.toUint32Array(),
            mode: mode,
            seedCellIndex: this.knnSeedCell.cellIndex,
            degree: this.knnCurrentDegree
          });
        }
      }

      clearKnnOverlay({ canvas: this.canvas, lassoCtx: this.lassoCtx });
      this._knnExpansion = null;
      this.knnSeedCell = null;
      this.knnCurrentDegree = 0;
      this.updateSelectionCursor();
      return true;
    }

    if (this.selectionDragStart) {
      const dragDistance = this.selectionDragCurrent
        ? Math.abs(this.selectionDragCurrent.y - this.selectionDragStart.y)
        : 0;
      const mode = this.selectionDragStart.mode || 'intersect';

      if (this.selectionStepCallback) {
        this.selectionStepCallback({
          type: dragDistance > 10 ? 'range' : 'click',
          cellIndex: this.selectionDragStart.cellIndex,
          dragDeltaY: this.selectionDragCurrent ? this.selectionDragCurrent.y - this.selectionDragStart.y : 0,
          startX: this.selectionDragStart.x,
          startY: this.selectionDragStart.y,
          endX: this.selectionDragCurrent?.x ?? this.selectionDragStart.x,
          endY: this.selectionDragCurrent?.y ?? this.selectionDragStart.y,
          mode: mode,
          viewId: this.selectionDragStart.viewId  // Pass viewId for per-view transparency filtering
        });
      }

      this.annotationStepCount++;
      this.annotationLastMode = mode;

      this.selectionDragStart = null;
      this.selectionDragCurrent = null;
      this.canvas.classList.remove('selecting');
      this.canvas.classList.remove('selecting-continuous');
      this.updateSelectionCursor();
      return true;
    }

    return false;
  }

  /**
   * Fence GPU handles first, then reuse ordinary DOM/CPU retirement.
   */
  handleContextLost() {
    if (this._disposed) return false;
    const failures = [];
    try {
      this.highlightRenderer?.handleContextLost();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Highlight context-loss retirement was incomplete.'
      );
    }
    return true;
  }

  /**
   * Release every DOM, callback, CPU, and GPU owner held by the highlight
   * interaction stack. Logical publications are detached before any fallible
   * external cleanup, while the private disposal record retains only failed
   * owners for an exact retry.
   *
   * @returns {boolean} true when this call completes disposal, false if already disposed
   */
  dispose() {
    if (this._disposed) return false;

    if (!this._disposeState) {
      const canvas = this.canvas ?? null;
      this._disposeState = {
        renderer: this.highlightRenderer ?? null,
        resizeSubscription: this._lassoResizeSubscription ?? null,
        lassoCanvas: this.lassoCanvas ?? null,
        parentPositionLease: this._lassoParentPositionLease ?? null,
        canvas,
        canvasClasses: canvas
          ? new Set(HIGHLIGHT_CANVAS_CLASSES)
          : new Set(),
        cursorPending: Boolean(canvas?.style),
        previousCanvasCursor: this._previousCanvasCursor ?? '',
      };

      // Fence every interaction and detach all public/live references before
      // disconnecting observers, removing DOM, or deleting WebGL resources.
      this.highlightRenderer = null;
      this._lassoResizeSubscription = null;
      this._lassoParentPositionLease = null;
      this._previousCanvasCursor = null;
      this.lassoCanvas = null;
      this.lassoCtx = null;
      this.canvas = null;

      this.highlightArray = null;
      this.cellSelectionEnabled = false;
      this.selectionDragStart = null;
      this.selectionDragCurrent = null;
      this.annotationStepCount = 0;
      this.annotationLastMode = 'intersect';
      this._unifiedCandidateSet = null;
      this._unifiedStepCount = 0;
      this.lassoEnabled = false;
      this.lassoPath = [];
      this.isLassoing = false;
      this.lassoViewContext = null;
      this.lassoMode = 'intersect';
      this._lassoPreviewPublished = false;
      this.proximityEnabled = false;
      this.isProximityDragging = false;
      this.proximityCenter = null;
      this.proximityCurrentRadius = 0;
      this._proximityPreviewPublished = false;
      this.knnEnabled = false;
      this.isKnnDragging = false;
      this.knnSeedCell = null;
      this.knnCurrentDegree = 0;
      this.knnGraph = null;
      this.knnEdgesLoaded = false;
      this._lassoHitTest = null;
      this._proximityHitTest = null;
      this._knnExpansion = null;
      this.altKeyDown = false;
      this.selectMode = SELECT_MODE_OFF;

      for (const callbackName of [
        'cellSelectionCallback',
        'selectionPreviewCallback',
        'selectionStepCallback',
        'lassoCallback',
        'lassoPreviewCallback',
        'lassoStepCallback',
        'proximityCallback',
        'proximityPreviewCallback',
        'proximityStepCallback',
        'knnCallback',
        'knnPreviewCallback',
        'knnStepCallback',
        'knnEdgeLoadCallback',
        'pickCellAtScreen',
        'screenToRay',
        'getViewportInfoAtScreen',
        'getViewIdAtCanvasPoint',
        'getViewFieldKind',
        'getRenderContext',
        'getNavigationState',
        'getViewTransparency',
        'getSpatialQueryOwner',
      ]) {
        this[callbackName] = null;
      }

      this._transparencyGenerations = null;
      this.gl = null;
      this.hpRenderer = null;
      this.mat4 = null;
      this.vec3 = null;
    }

    const pending = this._disposeState;
    const failures = [];
    const attempt = (operation, onSuccess, nonErrorMessage) => {
      try {
        operation();
        onSuccess();
      } catch (error) {
        failures.push(
          error instanceof Error
            ? error
            : new Error(nonErrorMessage, { cause: error })
        );
      }
    };

    if (pending.resizeSubscription) {
      const subscription = pending.resizeSubscription;
      attempt(
        () => subscription.disconnect(),
        () => {
          if (pending.resizeSubscription === subscription) {
            pending.resizeSubscription = null;
          }
        },
        'Highlight lasso resize-listener cleanup failed with a non-Error value.'
      );
    }

    if (pending.canvas) {
      for (const className of pending.canvasClasses) {
        attempt(
          () => pending.canvas.classList.remove(className),
          () => pending.canvasClasses.delete(className),
          `Highlight canvas class "${className}" cleanup failed with a non-Error value.`
        );
      }
      if (pending.cursorPending) {
        attempt(
          () => {
            pending.canvas.style.cursor = pending.previousCanvasCursor;
          },
          () => {
            pending.cursorPending = false;
          },
          'Highlight canvas cursor cleanup failed with a non-Error value.'
        );
      }
      if (
        pending.canvasClasses.size === 0 &&
        !pending.cursorPending
      ) {
        pending.canvas = null;
      }
    }

    if (pending.lassoCanvas) {
      const lassoCanvas = pending.lassoCanvas;
      attempt(
        () => {
          if (typeof lassoCanvas.remove === 'function') {
            lassoCanvas.remove();
          } else if (lassoCanvas.parentNode) {
            lassoCanvas.parentNode.removeChild(lassoCanvas);
          }
        },
        () => {
          if (pending.lassoCanvas === lassoCanvas) {
            pending.lassoCanvas = null;
          }
        },
        'Highlight lasso DOM cleanup failed with a non-Error value.'
      );
    }

    if (pending.parentPositionLease && pending.lassoCanvas === null) {
      const lease = pending.parentPositionLease;
      attempt(
        () => releaseLassoParentPosition(lease),
        () => {
          if (pending.parentPositionLease === lease) {
            pending.parentPositionLease = null;
          }
        },
        'Highlight lasso parent-style cleanup failed with a non-Error value.'
      );
    }

    if (pending.renderer) {
      const renderer = pending.renderer;
      attempt(
        () => renderer.dispose(),
        () => {
          if (pending.renderer === renderer) pending.renderer = null;
        },
        'Highlight renderer cleanup failed with a non-Error value.'
      );
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `HighlightTools disposal retains ${failures.length} pending owner failure(s).`
      );
    }

    this._disposeState = null;
    this._disposed = true;
    return true;
  }
}

function pixelDistanceToWorldRadius(pixelDist, targetRadius) {
  const scaleFactor = targetRadius * 0.001;
  return pixelDist * scaleFactor;
}

/**
 * The cells a selection gesture would leave selected, for its preview: the
 * gesture's cells combined with the standing candidates by the gesture's
 * mode. Candidates are a CellSet (a JS Set refuses more than 2^24 cells).
 *
 * @param {CellSet|null} candidates
 * @param {CellSet} gesture - The gesture's cells; read, never kept.
 * @param {'union'|'subtract'|'intersect'} mode
 * @returns {Uint32Array} The cell list the release would leave selected.
 */
function combineCandidatePreview(candidates, gesture, mode) {
  if (candidates === null) {
    return mode === 'subtract' ? new Uint32Array(0) : gesture.toUint32Array();
  }
  if (candidates.size === 0) {
    return mode === 'union' ? gesture.toUint32Array() : new Uint32Array(0);
  }
  const combined = candidates.clone();
  if (mode === 'union') combined.unionWith(gesture);
  else if (mode === 'subtract') combined.subtract(gesture);
  else combined.intersectWith(gesture);
  return combined.toUint32Array();
}

/**
 * Apply one committed gesture to the standing candidates (in place when they
 * exist). The first gesture of a selection starts it; a subtract with
 * nothing selected yet leaves an empty set.
 *
 * @param {CellSet|null} candidates
 * @param {CellSet} gesture - The gesture's cells; read, never kept.
 * @param {'union'|'subtract'|'intersect'} mode
 * @param {number} cellCount
 * @returns {CellSet}
 */
function commitCandidateStep(candidates, gesture, mode, cellCount) {
  if (candidates === null) {
    return mode === 'subtract' ? new CellSet(cellCount) : gesture.clone();
  }
  if (mode === 'union') return candidates.unionWith(gesture);
  if (mode === 'subtract') return candidates.subtract(gesture);
  return candidates.intersectWith(gesture);
}

function pixelDistanceToKnnDegree(pixelDist) {
  return Math.max(0, Math.floor(pixelDist / 30));
}

export function drawKnnIndicator({
  canvas,
  lassoCtx,
  knnSeedCell,
  knnCurrentDegree,
  mat4,
  viewMatrix,
  modelMatrix,
  viewPositions,
  dimensionLevel
}) {
  if (!knnSeedCell) return;
  const positions = viewPositions;
  requireHighlightPositions(
    positions,
    dimensionLevel,
    'KNN-indicator view positions'
  );

  const rect = canvas.getBoundingClientRect();
  lassoCtx.setTransform(1, 0, 0, 1, 0, 0);
  const dpr = window.devicePixelRatio;
  if (!Number.isFinite(dpr) || dpr <= 0) {
    throw new Error('window.devicePixelRatio must be a positive finite number.');
  }
  lassoCtx.scale(dpr, dpr);
  lassoCtx.clearRect(0, 0, rect.width, rect.height);
  setOverlayShown(lassoCtx, true);

  const vp = requireHighlightViewport(
    knnSeedCell.viewport,
    'KNN indicator viewport'
  );
  const vpWidth = vp.vpWidth;
  const vpHeight = vp.vpHeight;
  const vpOffsetX = vp.vpOffsetX;
  const vpOffsetY = vp.vpOffsetY;

  const localMvp = mat4.create();
  const effectiveView = vp.effectiveViewMatrix === null
    ? requireHighlightMatrix(viewMatrix, 'KNN indicator view matrix')
    : vp.effectiveViewMatrix;
  mat4.multiply(localMvp, vp.projectionMatrix, effectiveView);
  mat4.multiply(localMvp, localMvp, modelMatrix);

  const [px, py, pz] = readPositionXYZ(
    positions,
    dimensionLevel,
    knnSeedCell.cellIndex,
    [0, 0, 0]
  );

  const centerScreen = projectPointToScreen(px, py, pz, localMvp, vpWidth, vpHeight);
  if (!centerScreen) return;

  const drawX = centerScreen.x + vpOffsetX;
  const drawY = centerScreen.y + vpOffsetY;

  const baseRadius = 20;
  const ringSpacing = 15;

  lassoCtx.save();
  try {
  clipToPresentedPane(lassoCtx, vp);

  for (let d = knnCurrentDegree; d >= 0; d--) {
    const ringRadius = baseRadius + d * ringSpacing;
    const alpha = d === knnCurrentDegree ? 0.7 : 0.15;

    lassoCtx.beginPath();
    lassoCtx.arc(drawX, drawY, ringRadius, 0, Math.PI * 2);

    if (d === knnCurrentDegree) {
      lassoCtx.fillStyle = `rgba(17, 24, 39, 0.08)`;
      lassoCtx.fill();
      lassoCtx.strokeStyle = `rgba(17, 24, 39, ${alpha})`;
      lassoCtx.lineWidth = 2;
      lassoCtx.setLineDash([4, 3]);
      lassoCtx.stroke();
    } else {
      lassoCtx.strokeStyle = `rgba(17, 24, 39, ${alpha})`;
      lassoCtx.lineWidth = 1;
      lassoCtx.setLineDash([]);
      lassoCtx.stroke();
    }
  }

  lassoCtx.setLineDash([]);
  lassoCtx.beginPath();
  lassoCtx.arc(drawX, drawY, 4, 0, Math.PI * 2);
  lassoCtx.fillStyle = 'rgba(17, 24, 39, 0.9)';
  lassoCtx.fill();

  lassoCtx.font = 'bold 12px system-ui, sans-serif';
  lassoCtx.textAlign = 'center';
  lassoCtx.textBaseline = 'middle';
  lassoCtx.fillStyle = 'rgba(17, 24, 39, 0.9)';
  const labelY = drawY - baseRadius - knnCurrentDegree * ringSpacing - 12;
  const degreeLabel = knnCurrentDegree === 0 ? 'seed' : `${knnCurrentDegree}°`;
  lassoCtx.fillText(degreeLabel, drawX, labelY);
  } finally {
    lassoCtx.restore();
  }
}

function clearKnnOverlay({ canvas, lassoCtx }) {
  clearLassoOverlay({ canvas, lassoCtx });
}

function projectPointToScreen(px, py, pz, mvp, vpWidth, vpHeight) {
  const clipX = mvp[0] * px + mvp[4] * py + mvp[8] * pz + mvp[12];
  const clipY = mvp[1] * px + mvp[5] * py + mvp[9] * pz + mvp[13];
  const clipZ = mvp[2] * px + mvp[6] * py + mvp[10] * pz + mvp[14];
  const clipW = mvp[3] * px + mvp[7] * py + mvp[11] * pz + mvp[15];

  if (Math.abs(clipW) < 1e-10) return null;
  const ndcX = clipX / clipW;
  const ndcY = clipY / clipW;
  const ndcZ = clipZ / clipW;
  if (ndcZ < -1 || ndcZ > 1) return null;

  const screenX = (ndcX + 1) * 0.5 * vpWidth;
  const screenY = (1 - ndcY) * 0.5 * vpHeight;
  return { x: screenX, y: screenY, depth: ndcZ };
}
