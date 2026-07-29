import { createProgram } from './gl-utils.js';
import { HP_VS_HIGHLIGHT, HP_FS_HIGHLIGHT } from './shaders/high-perf-shaders.js';

const HIGHLIGHT_QUALITY_VALUES = Object.freeze(['full', 'light', 'ultralight']);
const HIGHLIGHT_MODE_VALUES = Object.freeze([
  'none',
  'continuous',
  'categorical',
]);
const HIGHLIGHT_CANVAS_CLASSES = Object.freeze([
  'selecting',
  'selecting-continuous',
  'highlight-continuous',
  'highlight-categorical',
  'lassoing',
  'lasso-mode',
  'proximity-dragging',
  'proximity-mode',
  'knn-dragging',
  'knn-mode',
]);
// CPU transparency is Float32Array-backed and GLSL `0.01` is a float. Use the
// same representable boundary so a point is selectable exactly when the point
// shader keeps it visible.
const HIGHLIGHT_VISIBILITY_THRESHOLD = Math.fround(0.01);

function requireHighlightMode(mode) {
  if (!HIGHLIGHT_MODE_VALUES.includes(mode)) {
    throw new RangeError(
      'Highlight mode must be exactly "none", "continuous", or "categorical".'
    );
  }
  return mode;
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
  if (!HIGHLIGHT_QUALITY_VALUES.includes(quality)) {
    throw new RangeError(
      'Highlight renderer quality must be one of "full", "light", or "ultralight".'
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

function requireHighlightPositions(positions, label = 'Highlight positions') {
  if (
    !(positions instanceof Float32Array) ||
    positions.length % 3 !== 0
  ) {
    throw new TypeError(
      `${label} must be a Float32Array containing packed XYZ triplets.`
    );
  }
  return positions;
}

function requireHighlightTransparency(transparency, pointCount) {
  if (
    !(transparency instanceof Float32Array) ||
    transparency.length !== pointCount
  ) {
    throw new TypeError(
      `Highlight view transparency must be a Float32Array with exactly ${pointCount} entries.`
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
  const positions = requireHighlightPositions(
    owner.positions,
    `Spatial-query owner positions for view "${exactViewId}"`
  );
  const publishedPositions = requireHighlightPositions(
    owner.publishedPositions ?? positions,
    `Spatial-query published positions for view "${exactViewId}"`
  );
  const pointCount = positions.length / 3;
  if (publishedPositions.length !== positions.length) {
    throw new Error(
      `Spatial-query positions for view "${exactViewId}" must have one exact point count.`
    );
  }
  const transparency = requireHighlightTransparency(
    owner.transparency,
    pointCount
  );
  const dimensionLevel = requireHighlightDimension(owner.dimensionLevel);
  const spatialIndex = owner.spatialIndex ?? null;
  if (
    spatialIndex !== null &&
    (
      typeof spatialIndex !== 'object' ||
      spatialIndex.pointCount !== pointCount ||
      spatialIndex.positions !== positions ||
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

function requireFiniteHighlightNumber(value, label, { positive = false } = {}) {
  if (!Number.isFinite(value) || (positive && value <= 0)) {
    const qualifier = positive ? 'positive finite' : 'finite';
    throw new TypeError(`${label} must be a ${qualifier} number.`);
  }
  return value;
}

function requireHighlightViewport(viewport, label) {
  if (!viewport || typeof viewport !== 'object' || Array.isArray(viewport)) {
    throw new TypeError(`${label} must be an exact viewport object.`);
  }

  requireHighlightViewId(viewport.viewId, `${label} viewId`);
  requireFiniteHighlightNumber(viewport.vpWidth, `${label} width`, { positive: true });
  requireFiniteHighlightNumber(viewport.vpHeight, `${label} height`, { positive: true });
  requireFiniteHighlightNumber(viewport.vpAspect, `${label} aspect`, { positive: true });
  requireFiniteHighlightNumber(viewport.vpOffsetX, `${label} X offset`);
  requireFiniteHighlightNumber(viewport.vpOffsetY, `${label} Y offset`);
  requireFiniteHighlightNumber(viewport.vpLocalX, `${label} local X`);
  requireFiniteHighlightNumber(viewport.vpLocalY, `${label} local Y`);
  requireFiniteHighlightNumber(
    viewport.projectionCenterNdcX,
    `${label} projection center`
  );
  requireHighlightMatrix(viewport.projectionMatrix, `${label} projection matrix`);
  requireHighlightDirection(viewport.cameraForward, `${label} camera forward`);
  requireFiniteHighlightNumber(
    viewport.cameraTargetRadius,
    `${label} camera target radius`,
    { positive: true }
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
      `Highlight data must contain exactly ${pointCount} entries.`
    );
  }
  return highlightData;
}

function requireHighlightVisibility(visibility, pointCount) {
  if (visibility === null) return null;
  if (
    !(visibility instanceof Float32Array) ||
    visibility.length !== pointCount
  ) {
    throw new TypeError(
      `Highlight LOD visibility must be null or a Float32Array with exactly ${pointCount} entries.`
    );
  }
  return visibility;
}

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
      mvpMatrix: gl.getUniformLocation(this.program, 'u_mvpMatrix'),
      viewMatrix: gl.getUniformLocation(this.program, 'u_viewMatrix'),
      modelMatrix: gl.getUniformLocation(this.program, 'u_modelMatrix'),
      projectionMatrix: gl.getUniformLocation(this.program, 'u_projectionMatrix'),
      pointSize: gl.getUniformLocation(this.program, 'u_pointSize'),
      sizeAttenuation: gl.getUniformLocation(this.program, 'u_sizeAttenuation'),
      viewportHeight: gl.getUniformLocation(this.program, 'u_viewportHeight'),
      fov: gl.getUniformLocation(this.program, 'u_fov'),
      highlightScale: gl.getUniformLocation(this.program, 'u_highlightScale'),
      highlightColor: gl.getUniformLocation(this.program, 'u_highlightColor'),
      ringWidth: gl.getUniformLocation(this.program, 'u_ringWidth'),
      haloStrength: gl.getUniformLocation(this.program, 'u_haloStrength'),
      haloShape: gl.getUniformLocation(this.program, 'u_haloShape'),
      ringStyle: gl.getUniformLocation(this.program, 'u_ringStyle'),
      time: gl.getUniformLocation(this.program, 'u_time'),
      fogDensity: gl.getUniformLocation(this.program, 'u_fogDensity'),
      fogNear: gl.getUniformLocation(this.program, 'u_fogNear'),
      fogFar: gl.getUniformLocation(this.program, 'u_fogFar'),
      fogColor: gl.getUniformLocation(this.program, 'u_fogColor'),
      lightingStrength: gl.getUniformLocation(this.program, 'u_lightingStrength'),
      lightDir: gl.getUniformLocation(this.program, 'u_lightDir'),
    };

    // Per-view GPU buffers + bookkeeping (fixes multi-view race condition)
    // Map<viewId, { buffer, pointCount, lodSignature, positionsFingerprint }>
    this._viewBuffers = new Map();
    this._pendingBufferDeletes = new Set();
    this._pendingProgramDeletes = new Set();
    this._disposeStarted = false;
    this._disposed = false;

    // Track total highlighted count across all views (for UI feedback)
    this._totalHighlightedCount = 0;

    // Cache for highlighted cell indices - avoids scanning all cells on every rebuildBuffer
    // This dramatically improves performance when only a small fraction of cells are highlighted
    this._highlightedIndicesCache = null;  // Array of highlighted cell indices
    this._highlightDataRef = null;         // Reference to last highlightData array
    this._highlightDataFingerprint = 0;    // Content-based fingerprint for in-place modification detection
    this._highlightDataVersion = 0;        // Incremented when cache is invalidated

    // Visual style state (defaults mirror previous viewer.js values)
    this.highlightColor = [0.4, 0.85, 1.0];
    this.highlightScale = 1.8;
    this.highlightRingWidth = 0.40;
    this.highlightHaloStrength = 0.7;
    this.highlightHaloShape = 0.0;
    this.highlightRingStyle = 0.0;

    this.highlightStylesByQuality = {
      full: { scale: 1.75, ringWidth: 0.42, haloStrength: 0.65, haloShape: 0.0, ringStyle: 0.0 },
      light: { scale: 1.70, ringWidth: 0.44, haloStrength: 0.60, haloShape: 0.0, ringStyle: 1.0 },
      ultralight: { scale: 1.65, ringWidth: 0.46, haloStrength: 0.55, haloShape: 0.35, ringStyle: 2.0 }
    };
  }

  setQuality(quality) {
    const style = this.highlightStylesByQuality[requireHighlightQuality(quality)];
    this.highlightScale = style.scale;
    this.highlightRingWidth = style.ringWidth;
    this.highlightHaloStrength = style.haloStrength;
    this.highlightHaloShape = style.haloShape;
    this.highlightRingStyle = style.ringStyle;
  }

  setStyle(options = {}) {
    if (options.color) this.highlightColor = options.color;
    if (options.scale != null) this.highlightScale = options.scale;
    if (options.ringWidth != null) this.highlightRingWidth = options.ringWidth;
    if (options.haloStrength != null) this.highlightHaloStrength = options.haloStrength;
    if (options.haloShape != null) this.highlightHaloShape = options.haloShape;
  }

  /**
   * Compute a fingerprint for positions array (for cache invalidation)
   * @private
   */
  _computePositionsFingerprint(positions) {
    requireHighlightPositions(positions);
    if (positions.length === 0) return 0;
    const len = positions.length;
    // Sample every ~300th triplet and sum for a quick fingerprint
    const step = Math.max(3, Math.floor(len / 300)) * 3;
    let sparseSum = 0;
    for (let i = 0; i < len; i += step) {
      sparseSum += positions[i] + positions[i + 1] + positions[i + 2];
    }
    return len * 31 + sparseSum;
  }

  /**
   * Compute a fingerprint for transparency array (for cache invalidation)
   * Detects filter changes that require highlight buffer rebuild.
   * @private
   */
  _computeTransparencyFingerprint(transparency) {
    if (!transparency || transparency.length === 0) return 'null';
    const len = transparency.length;
    // Sample at multiple positions for better change detection
    const q1 = Math.floor(len * 0.25);
    const mid = Math.floor(len * 0.5);
    const q3 = Math.floor(len * 0.75);
    // Count zeros (filtered-out cells) with sparse sampling
    let zeroCount = 0;
    let sumSample = 0;
    const step = Math.max(1, Math.floor(len / 500));
    for (let i = 0; i < len; i += step) {
      if (transparency[i] <= 0) zeroCount++;
      sumSample += transparency[i];
    }
    return `${transparency[0]},${transparency[q1]},${transparency[mid]},${transparency[q3]},${transparency[len-1]},${zeroCount},${sumSample.toFixed(2)},${len}`;
  }

  /**
   * Compute a fingerprint for highlight data array (for content-based cache invalidation).
   * Detects in-place modifications to the highlight array.
   * @private
   */
  _computeHighlightDataFingerprint(highlightData) {
    if (!highlightData || highlightData.length === 0) return 0;
    const len = highlightData.length;
    // Count highlighted cells with sparse sampling for quick detection
    let highlightCount = 0;
    let sumSample = 0;
    const step = Math.max(1, Math.floor(len / 500));
    for (let i = 0; i < len; i += step) {
      if (highlightData[i] > 0) highlightCount++;
      sumSample += highlightData[i];
    }
    // Combine length, highlight count estimate, and sum for fingerprint
    return len * 31 + highlightCount * 17 + sumSample;
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
        this._highlightedIndicesCache = [];
        this._highlightDataRef = null;
        this._highlightDataFingerprint = 0;
        this._highlightDataVersion++;
      }
      return;
    }

    // Compute fingerprint for content-based invalidation (detects in-place modifications)
    const newFingerprint = this._computeHighlightDataFingerprint(highlightData);

    // Check if we need to rebuild the cache:
    // 1. Force rebuild requested
    // 2. Cache doesn't exist
    // 3. Reference changed (different array)
    // 4. Content changed (same array, but modified in-place - detected via fingerprint)
    const needsRebuild = forceRebuild ||
      !this._highlightedIndicesCache ||
      this._highlightDataRef !== highlightData ||
      this._highlightDataFingerprint !== newFingerprint;

    if (!needsRebuild) return;

    // Build new cache by scanning all cells
    const indices = [];
    const len = highlightData.length;
    for (let i = 0; i < len; i++) {
      if (highlightData[i] > 0) {
        indices.push(i);
      }
    }

    this._highlightedIndicesCache = indices;
    this._highlightDataRef = highlightData;
    this._highlightDataFingerprint = newFingerprint;
    this._highlightDataVersion++;
  }

  /**
   * Invalidate the highlight cache (call when highlight array contents change in-place)
   * Note: With content-based fingerprinting, this is now rarely needed as in-place
   * modifications are automatically detected. Still useful for forcing immediate invalidation.
   */
  invalidateHighlightCache() {
    this._highlightedIndicesCache = null;
    this._highlightDataFingerprint = -1;  // Force mismatch on next update
    this._highlightDataVersion++;
  }

  /**
   * Directly set the highlighted indices cache (avoids O(n) full-array scan).
   * Call this when you already know which indices are highlighted (e.g., from state.js groups).
   * @param {number[]} indices - Array of highlighted cell indices
   * @param {Uint8Array} highlightData - Reference to the highlight data array
   */
  setHighlightedIndicesCache(indices, highlightData) {
    this._highlightedIndicesCache = indices;
    this._highlightDataRef = highlightData;
    this._highlightDataFingerprint = this._computeHighlightDataFingerprint(highlightData);
    this._highlightDataVersion++;
  }

  /**
   * Returns true if the GPU buffer should be rebuilt for the given LOD signature and view.
   * @param {number} lodSignature - LOD signature for cache validation
   * @param {string} [viewId='default'] - View ID for per-view buffer lookup
   * @param {Float32Array} [positions] - Optional positions to check for changes
   */
  needsRefresh(lodSignature, viewId, positions) {
    if (!Number.isInteger(lodSignature) || lodSignature < -1) {
      throw new RangeError(
        'Highlight LOD signature must be an integer greater than or equal to -1.'
      );
    }
    const vid = requireHighlightViewId(viewId);
    const exactPositions = requireHighlightPositions(positions);
    const viewBuffer = this._viewBuffers.get(vid);

    if (!viewBuffer || !viewBuffer.buffer) return true;
    if (viewBuffer.lodSignature !== lodSignature) return true;

    // Check if positions changed (for multi-dimensional views)
    const currentFingerprint = this._computePositionsFingerprint(exactPositions);
    if (viewBuffer.positionsFingerprint !== currentFingerprint) return true;

    return false;
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
   * @param {Float32Array|null} visibility - Combined LOD+frustum visibility mask (1.0 = visible, 0.0 = hidden), or null for all visible
   * @param {number} [visibilitySignature] - Signature for cache key (LOD level + frustum state)
   * @param {string} [viewId='default'] - View ID for per-view buffer
   * @param {Float32Array|null} [viewTransparency=null] - Per-view transparency array (cells with transparency <= 0 are hidden)
   */
  rebuildBuffer(
    highlightData,
    positions,
    visibility,
    visibilitySignature,
    viewId,
    viewTransparency
  ) {
    const gl = this.gl;
    const vid = requireHighlightViewId(viewId);
    const exactPositions = requireHighlightPositions(positions);
    const pointCount = exactPositions.length / 3;
    const exactHighlightData = requireHighlightData(highlightData, pointCount);
    const exactVisibility = requireHighlightVisibility(visibility, pointCount);
    const exactTransparency = requireHighlightTransparency(
      viewTransparency,
      pointCount
    );
    if (!Number.isInteger(visibilitySignature) || visibilitySignature < -1) {
      throw new RangeError(
        'Highlight LOD signature must be an integer greater than or equal to -1.'
      );
    }
    const sigValue = visibilitySignature;
    const positionsFingerprint = this._computePositionsFingerprint(exactPositions);

    // Use cached highlighted indices for fast iteration (avoids scanning all 10M+ cells)
    // Cache is rebuilt only when highlightData reference changes
    this.updateHighlightCache(exactHighlightData);
    const highlightedIndices = this._highlightedIndicesCache;

    // Count visible highlighted cells using cached indices
    // Now respects both LOD+frustum visibility AND per-view transparency (filtering)
    let count = 0;
    for (let j = 0; j < highlightedIndices.length; j++) {
      const i = highlightedIndices[j];
      // Skip if culled by LOD+frustum
      if (exactVisibility && exactVisibility[i] <= 0) continue;
      // Skip if filtered out in this view (per-view transparency)
      if (exactTransparency[i] <= 0) continue;
      count++;
    }

    // Get or create per-view buffer entry
    let viewBuffer = this._viewBuffers.get(vid);
    if (!viewBuffer) {
      viewBuffer = { buffer: null, pointCount: 0, lodSignature: -999, positionsFingerprint: 0 };
      this._viewBuffers.set(vid, viewBuffer);
    }

    if (count === 0) {
      viewBuffer.pointCount = 0;
      viewBuffer.lodSignature = sigValue;
      viewBuffer.positionsFingerprint = positionsFingerprint;
      this._recomputeTotalHighlightedCount();
      return;
    }

    const BYTES_PER_POINT = 16;
    const bufferData = new ArrayBuffer(count * BYTES_PER_POINT);
    const posView = new Float32Array(bufferData);
    const colorView = new Uint8Array(bufferData);

    // Pack buffer using cached indices (fast - only iterates over highlighted cells)
    let outIdx = 0;
    for (let j = 0; j < highlightedIndices.length; j++) {
      const i = highlightedIndices[j];
      // Skip if culled by LOD+frustum
      if (exactVisibility && exactVisibility[i] <= 0) continue;
      // Skip if filtered out in this view (per-view transparency)
      if (exactTransparency[i] <= 0) continue;

      const posOffset = outIdx * 4;
      const colorOffset = outIdx * BYTES_PER_POINT + 12;

      posView[posOffset] = exactPositions[i * 3];
      posView[posOffset + 1] = exactPositions[i * 3 + 1];
      posView[posOffset + 2] = exactPositions[i * 3 + 2];

      colorView[colorOffset] = 255;
      colorView[colorOffset + 1] = 255;
      colorView[colorOffset + 2] = 255;
      colorView[colorOffset + 3] = exactHighlightData[i];

      outIdx++;
    }

    // Create GPU buffer for this view if needed
    if (!viewBuffer.buffer) {
      viewBuffer.buffer = gl.createBuffer();
      if (!viewBuffer.buffer) {
        throw new Error(
          `Unable to allocate the highlight buffer for view "${vid}".`
        );
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, viewBuffer.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, bufferData, gl.DYNAMIC_DRAW);

    viewBuffer.pointCount = count;
    viewBuffer.lodSignature = sigValue;
    viewBuffer.positionsFingerprint = positionsFingerprint;

    // Recompute total count across all views for UI feedback
    this._recomputeTotalHighlightedCount();
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
   * Clear buffer for a specific view (e.g., when view is removed)
   * @param {string} viewId - View ID to clear
   */
  clearViewBuffer(viewId) {
    const vid = requireHighlightViewId(viewId);
    const viewBuffer = this._viewBuffers.get(vid);
    // Detach the logical view first. A failed WebGL deletion must never leave a
    // half-retired buffer dispatchable through the view map.
    this._viewBuffers.delete(vid);
    if (viewBuffer?.buffer) {
      this._pendingBufferDeletes.add(viewBuffer.buffer);
      viewBuffer.buffer = null;
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
          this.gl.deleteProgram(program);
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
   * Dispose all GPU resources
   */
  dispose() {
    if (this._disposed) return false;

    if (!this._disposeStarted) {
      this._disposeStarted = true;

      // Detach the complete live publication before the first fallible GL
      // operation. Pending sets remain authoritative across disposal retries.
      for (const viewBuffer of this._viewBuffers.values()) {
        if (viewBuffer.buffer) {
          this._pendingBufferDeletes.add(viewBuffer.buffer);
          viewBuffer.buffer = null;
        }
      }
      this._viewBuffers.clear();
      if (this.program) this._pendingProgramDeletes.add(this.program);
      this.program = null;

      this._totalHighlightedCount = 0;
      this._highlightedIndicesCache = null;
      this._highlightDataRef = null;
      this._highlightDataFingerprint = 0;
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
    fogColor,
    lightingStrength,
    lightDir,
    viewId,  // Required for per-view buffer lookup and LOD size multiplier
    dimensionLevel
  }) {
    const gl = this.gl;
    const vid = requireHighlightViewId(viewId);
    const exactDimensionLevel = requireHighlightDimension(dimensionLevel);

    // Get the per-view buffer
    const viewBuffer = this._viewBuffers.get(vid);
    if (!viewBuffer || !viewBuffer.buffer || viewBuffer.pointCount === 0) return;

    const buffer = viewBuffer.buffer;
    const pointCount = viewBuffer.pointCount;

    // Enable depth test and disable depth writes for highlight rendering
    // Assumes caller (HighPerfRenderer) maintains DEPTH_TEST enabled and depthMask true as defaults
    // This avoids expensive gl.isEnabled() and gl.getParameter() queries every frame
    gl.enable(gl.DEPTH_TEST);  // Ensure enabled (usually already is from main renderer)
    gl.depthMask(false);       // Disable writes so highlights render on top of existing geometry

    gl.useProgram(this.program);

    // Use per-view LOD size multiplier if viewId is provided
    // Pass dimensionLevel to ensure correct LOD buffer lookup for multi-dimension views
    const lodSizeMultiplier = this.hpRenderer.getCurrentLODSizeMultiplier(
      vid,
      exactDimensionLevel
    );
    const highlightPointSize = pointSize * lodSizeMultiplier;

    gl.uniformMatrix4fv(this.uniformLocations.mvpMatrix, false, mvpMatrix);
    gl.uniformMatrix4fv(this.uniformLocations.viewMatrix, false, viewMatrix);
    gl.uniformMatrix4fv(this.uniformLocations.modelMatrix, false, modelMatrix);
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
    gl.uniform1f(this.uniformLocations.viewportHeight, viewportHeight);
    gl.uniform1f(this.uniformLocations.fov, fov);
    gl.uniform1f(this.uniformLocations.highlightScale, effectiveScale);
    gl.uniform3fv(this.uniformLocations.highlightColor, this.highlightColor);
    gl.uniform1f(this.uniformLocations.ringWidth, effectiveRingWidth);
    gl.uniform1f(this.uniformLocations.haloStrength, effectiveHaloStrength);
    gl.uniform1f(this.uniformLocations.haloShape, this.highlightHaloShape);
    gl.uniform1f(this.uniformLocations.ringStyle, this.highlightRingStyle);

    const highlightTime = (performance.now() - this.startTime) * 0.001;
    gl.uniform1f(this.uniformLocations.time, highlightTime);

    gl.uniform1f(this.uniformLocations.fogDensity, fogDensity);
    gl.uniform1f(this.uniformLocations.fogNear, this.hpRenderer.getFogNear());
    gl.uniform1f(this.uniformLocations.fogFar, this.hpRenderer.getFogFar());
    gl.uniform3fv(this.uniformLocations.fogColor, fogColor);

    gl.uniform1f(this.uniformLocations.lightingStrength, lightingStrength);
    gl.uniform3fv(this.uniformLocations.lightDir, lightDir);

    const BYTES_PER_POINT = 16;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(this.attribLocations.position);
    gl.vertexAttribPointer(this.attribLocations.position, 3, gl.FLOAT, false, BYTES_PER_POINT, 0);
    gl.enableVertexAttribArray(this.attribLocations.color);
    gl.vertexAttribPointer(this.attribLocations.color, 4, gl.UNSIGNED_BYTE, true, BYTES_PER_POINT, 12);

    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.drawArrays(gl.POINTS, 0, pointCount);

    // Restore depth mask to default (true) - main renderer expects this state
    gl.depthMask(true);
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
  `;
  const parentPositionLease = acquireLassoParentPosition(parentElement);
  let lassoCtx = null;
  let observer = null;
  let resizeSubscriptionActive = true;

  function syncLassoCanvasSize() {
    if (!resizeSubscriptionActive) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    lassoCanvas.width = rect.width * dpr;
    lassoCanvas.height = rect.height * dpr;
    lassoCanvas.style.width = rect.width + 'px';
    lassoCanvas.style.height = rect.height + 'px';
    lassoCtx.setTransform(1, 0, 0, 1, 0, 0);
    lassoCtx.scale(dpr, dpr);
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
  } catch (error) {
    resizeSubscriptionActive = false;
    const cleanupFailures = [];
    try {
      observer?.disconnect();
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
      // Fence an already-queued callback before the fallible observer cleanup.
      resizeSubscriptionActive = false;
      observer.disconnect();
    },
  };
  return {
    lassoCanvas,
    lassoCtx,
    resizeSubscription,
    parentPositionLease,
  };
}

export function drawLasso({ canvas, lassoCtx, lassoPath }) {
  const rect = canvas.getBoundingClientRect();
  lassoCtx.setTransform(1, 0, 0, 1, 0, 0);
  const dpr = window.devicePixelRatio || 1;
  lassoCtx.scale(dpr, dpr);
  lassoCtx.clearRect(0, 0, rect.width, rect.height);

  if (!lassoPath || lassoPath.length < 2) return;

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

export function clearLassoOverlay({ canvas, lassoCtx }) {
  const rect = canvas.getBoundingClientRect();
  lassoCtx.setTransform(1, 0, 0, 1, 0, 0);
  const dpr = window.devicePixelRatio || 1;
  lassoCtx.scale(dpr, dpr);
  lassoCtx.clearRect(0, 0, rect.width, rect.height);
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
}

export function clearProximityOverlay({ canvas, lassoCtx }) {
  clearLassoOverlay({ canvas, lassoCtx });
}

/**
 * Return the exact proximity-selection cell-ID set. With a spatial index the
 * array follows spatial traversal order; callers must treat cell IDs as an
 * unordered selection set (there is no distance/rank meaning in this API).
 */
export function findCellsInProximity({
  transparencyArray,
  centerPos,
  radius3D,
  viewPositions,
  spatialIndex = null,
  queryStats = null
}) {
  const positions = requireHighlightPositions(
    viewPositions,
    'Proximity-selection view positions'
  );
  const pointCount = positions.length / 3;
  const alphas = requireHighlightTransparency(
    transparencyArray,
    pointCount
  );
  if (
    !Array.isArray(centerPos) ||
    centerPos.length !== 3 ||
    !centerPos.every(Number.isFinite)
  ) {
    throw new TypeError(
      'Proximity-selection centerPos must be an array of three finite numbers.'
    );
  }
  if (!Number.isFinite(radius3D) || radius3D < 0) {
    throw new RangeError(
      'Proximity-selection radius3D must be a finite non-negative number.'
    );
  }
  if (radius3D === 0) return [];
  if (
    spatialIndex !== null &&
    (
      typeof spatialIndex !== 'object' ||
      spatialIndex.pointCount !== pointCount ||
      spatialIndex.positions !== positions ||
      typeof spatialIndex.visitRadiusCandidates !== 'function'
    )
  ) {
    throw new TypeError(
      'Proximity-selection spatialIndex must be null or an exact matching spatial owner.'
    );
  }
  if (
    queryStats !== null &&
    (
      typeof queryStats !== 'object' ||
      Array.isArray(queryStats)
    )
  ) {
    throw new TypeError('Proximity-selection queryStats must be null or an object.');
  }

  const selectedIndices = [];
  const radiusSq = radius3D * radius3D;
  let examinedPointCount = 0;
  const evaluatePoint = i => {
    examinedPointCount++;
    // Cell is selectable only if visible (not filtered out in this view)
    // Filtered-out cells cannot be interacted with, even if highlighted in another view
    if (!(alphas[i] >= HIGHLIGHT_VISIBILITY_THRESHOLD)) return;
    const dx = positions[i * 3] - centerPos[0];
    const dy = positions[i * 3 + 1] - centerPos[1];
    const dz = positions[i * 3 + 2] - centerPos[2];
    if (dx * dx + dy * dy + dz * dz <= radiusSq) {
      selectedIndices.push(i);
    }
  };

  if (spatialIndex === null) {
    for (let i = 0; i < pointCount; i++) {
      evaluatePoint(i);
    }
  } else {
    spatialIndex.visitRadiusCandidates(
      centerPos,
      radius3D,
      evaluatePoint
    );
  }
  if (queryStats !== null) {
    queryStats.examinedPointCount = examinedPointCount;
  }

  return selectedIndices;
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
    getRenderContext,
    getNavigationState,
    getViewPositions,
    getViewTransparency,
    getSpatialQueryOwner,
    startTime = performance.now(),
    shaderQuality = 'full'
  }) {
    for (const [name, callback] of [
      ['pickCellAtScreen', pickCellAtScreen],
      ['screenToRay', screenToRay],
      ['getViewportInfoAtScreen', getViewportInfoAtScreen],
      ['getRenderContext', getRenderContext],
      ['getNavigationState', getNavigationState],
      ['getViewPositions', getViewPositions],
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
    this.getRenderContext = getRenderContext;
    this.getNavigationState = getNavigationState;
    this.getViewPositions = getViewPositions;
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
    this.highlightMode = 'none';
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
    this.knnAdjacencyList = null;
    this.knnEdgesLoaded = false;
    this.knnEdgeLoadCallback = null;

    this.altKeyDown = false;

    // Track last used positions per-view for multiview dimension support
    // Each view may have different positions (e.g., 2D vs 3D), so we track separately
    this._lastUsedPositionsMap = new Map();      // viewId -> positions reference
    this._lastPositionFingerprintMap = new Map(); // viewId -> fingerprint string

    // Track transparency fingerprint per-view to detect filter changes
    // When filters change, highlight buffer must be rebuilt to exclude filtered-out cells
    this._lastTransparencyFingerprintMap = new Map(); // viewId -> fingerprint string
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
      candidates: this._unifiedCandidateSet ? [...this._unifiedCandidateSet] : []
    };
  }

  /**
   * Confirm unified selection and clear state.
   * @param {Function} [callback] - Optional callback to receive final selection
   * @returns {number[]} Array of selected cell indices
   */
  confirmUnifiedSelection(callback = null) {
    const finalIndices = this._unifiedCandidateSet ? [...this._unifiedCandidateSet] : [];
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
   * @param {number[]} candidates - Array of cell indices
   * @param {number} step - Step count
   */
  restoreUnifiedState(candidates, step) {
    if (candidates && candidates.length > 0) {
      this._unifiedCandidateSet = new Set(candidates);
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
   * Update highlight data. In multi-view mode, buffers will be rebuilt with
   * view-specific positions and transparency during the next renderHighlights call.
   *
   * IMPORTANT: Highlight display respects per-view filtering. Cells that are filtered
   * out in a view will NOT show highlights in that view, even if they're highlighted
   * in another view. This ensures consistent behavior across main and snapshot views.
   *
   * @param {Uint8Array} highlightData - Highlight intensity per point (0-255)
   * @param {number[]} [highlightedIndices] - Optional pre-computed array of highlighted cell indices.
   *   If provided, skips the expensive O(n) full-array scan. Pass this when you already know
   *   which cells are highlighted (e.g., from state.js highlight groups).
   */
  updateHighlight(highlightData, highlightedIndices = null) {
    this.highlightArray = requireHighlightData(highlightData);

    // If pre-computed indices provided, set cache directly (avoids O(n) scan)
    // Otherwise, invalidate cache to trigger scan on next rebuildBuffer
    if (highlightedIndices !== null) {
      if (
        !Array.isArray(highlightedIndices) ||
        highlightedIndices.some(
          (index) =>
            !Number.isInteger(index) ||
            index < 0 ||
            index >= highlightData.length
        )
      ) {
        throw new RangeError(
          'Highlighted indices must be an array of valid highlight-data indices.'
        );
      }
      this.highlightRenderer.setHighlightedIndicesCache(highlightedIndices, highlightData);
    } else {
      this.highlightRenderer.invalidateHighlightCache();
    }

    // Clear all per-view caches to force buffer rebuild during next renderHighlights call.
    // This ensures each view's buffer is rebuilt with its own transparency (filtering state).
    // We do NOT pre-build buffers here because we don't have per-view transparency info -
    // the correct per-view transparency will be passed during renderHighlights.
    this._lastUsedPositionsMap.clear();
    this._lastPositionFingerprintMap.clear();
    this._lastTransparencyFingerprintMap.clear();

    // Also clear all view buffers to ensure they're rebuilt with correct transparency
    // This prevents stale buffers from showing filtered-out cells
    for (const vid of this.highlightRenderer._viewBuffers.keys()) {
      const viewBuffer = this.highlightRenderer._viewBuffers.get(vid);
      if (viewBuffer) {
        viewBuffer.lodSignature = -999; // Force rebuild
      }
    }
  }

  /**
   * Handle transparency changes for any view.
   *
   * This clears the transparency fingerprint cache so the next renderHighlights call
   * will rebuild buffers with the new filtering state for all views.
   *
   * @param {string} viewId - Exact view whose transparency changed.
   */
  handleTransparencyChange(viewId) {
    const vid = requireHighlightViewId(viewId);
    this._lastTransparencyFingerprintMap.delete(vid);
    const viewBuffer = this.highlightRenderer._viewBuffers.get(vid);
    if (viewBuffer) {
      viewBuffer.lodSignature = -1;
    }
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
          cellIndices: [],
          cellCount: 0,
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
          cellIndices: [],
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
      this._proximityPreviewPublished = false;
      retired = true;
    }
    if (retired) this.updateCursorForHighlightMode();
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
      return (
        currentOwner.positions === capturedOwner.positions &&
        currentOwner.publishedPositions ===
          capturedOwner.publishedPositions &&
        currentOwner.transparency === capturedOwner.transparency &&
        currentOwner.dimensionLevel === capturedOwner.dimensionLevel &&
        currentOwner.spatialIndex === capturedOwner.spatialIndex
      );
    } catch {
      return false;
    }
  }

  clearViewState(viewId) {
    const vid = requireHighlightViewId(viewId);
    this._retireActiveSpatialInteractions(vid);
    this._lastUsedPositionsMap.delete(vid);
    this._lastPositionFingerprintMap.delete(vid);
    this._lastTransparencyFingerprintMap.delete(vid);
    this.highlightRenderer.clearViewBuffer(vid);
  }

  /**
   * Compute a quick fingerprint of positions array by sampling multiple positions.
   * Samples at 5 positions (first, 25%, 50%, 75%, last) plus a sparse sum for better change detection.
   * @param {Float32Array} positions - Positions array to fingerprint
   * @returns {string|null} Fingerprint string or null if invalid
   */
  _computePositionFingerprint(positions) {
    requireHighlightPositions(positions);
    if (positions.length === 0) return 'empty';
    const len = positions.length;
    const numPoints = len / 3;

    // Sample at 5 positions: start, 25%, 50%, 75%, end (aligned to XYZ triplets)
    const q1Idx = Math.floor(numPoints * 0.25) * 3;
    const midIdx = Math.floor(numPoints * 0.5) * 3;
    const q3Idx = Math.floor(numPoints * 0.75) * 3;
    const lastIdx = len - 3;

    // Compute a sparse sum for additional change detection (every 100th point's X value)
    let sparseSum = 0;
    const step = Math.max(3, Math.floor(len / 300)) * 3;  // ~100 samples, aligned to triplets
    for (let i = 0; i < len; i += step) {
      sparseSum += positions[i];
    }

    return `${positions[0]},${positions[1]},${positions[2]},` +
           `${positions[q1Idx]},${positions[midIdx]},${positions[q3Idx]},` +
           `${positions[lastIdx]},${positions[lastIdx+1]},${positions[lastIdx+2]},` +
           `${sparseSum.toFixed(2)},${len}`;
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
   * @param {Float32Array} viewTransparency - Exact per-view transparency.
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
    const positions = requireHighlightPositions(viewPositions);
    const pointCount = positions.length / 3;
    requireHighlightData(this.highlightArray, pointCount);
    const transparency = requireHighlightTransparency(
      viewTransparency,
      pointCount
    );

    // LOD owns point inclusion; filtering is owned by this view's exact transparency.
    const visibility = this.hpRenderer.getLodVisibilityArray(
      vid,
      exactDimensionLevel
    );
    const lodLevel = this.hpRenderer.getCurrentLODLevel(vid);
    const visibilitySignature = lodLevel;

    // Check if positions changed using per-view fingerprint (handles in-place mutations)
    // Reference check is fast path; fingerprint catches in-place array mutations
    const currentPositionFingerprint = this._computePositionFingerprint(positions);
    const lastUsedPositions = this._lastUsedPositionsMap.get(vid);
    const lastPositionFingerprint = this._lastPositionFingerprintMap.get(vid);
    const positionsChanged = (
      positions !== lastUsedPositions ||
      currentPositionFingerprint !== lastPositionFingerprint
    );

    // Check if transparency/filtering changed using fingerprint
    // This ensures highlights are rebuilt when filters change, hiding filtered-out cells
    const currentTransparencyFingerprint =
      this.highlightRenderer._computeTransparencyFingerprint(transparency);
    const lastTransparencyFingerprint = this._lastTransparencyFingerprintMap.get(vid);
    const transparencyChanged = currentTransparencyFingerprint !== lastTransparencyFingerprint;

    if (this.highlightRenderer.needsRefresh(visibilitySignature, vid, positions) || positionsChanged || transparencyChanged) {
      // Pass view-specific transparency so highlights respect per-view filtering
      this.highlightRenderer.rebuildBuffer(
        this.highlightArray,
        positions,
        visibility,
        visibilitySignature,
        vid,
        transparency
      );
      this._lastUsedPositionsMap.set(vid, positions);
      this._lastPositionFingerprintMap.set(vid, currentPositionFingerprint);
      this._lastTransparencyFingerprintMap.set(vid, currentTransparencyFingerprint);
    }
  }

  drawHighlights(drawParams) {
    if (!drawParams || typeof drawParams !== 'object') {
      throw new TypeError('Highlight draw parameters are required.');
    }
    const exactParams = {
      mvpMatrix: drawParams.mvpMatrix,
      viewMatrix: drawParams.viewMatrix,
      modelMatrix: drawParams.modelMatrix,
      projectionMatrix: drawParams.projectionMatrix,
      viewportHeight: drawParams.viewportHeight,
      pointSize: drawParams.pointSize,
      sizeAttenuation: drawParams.sizeAttenuation,
      fov: drawParams.fov,
      fogDensity: drawParams.fogDensity,
      fogColor: drawParams.fogColor,
      lightingStrength: drawParams.lightingStrength,
      lightDir: drawParams.lightDir,
      viewId: drawParams.viewId,  // Pass viewId for per-view LOD size multiplier
      dimensionLevel: drawParams.dimensionLevel  // Pass dimensionLevel for correct LOD buffer lookup
    };
    this.highlightRenderer.draw(exactParams);
  }

  /**
   * Sync LOD visibility and draw highlights in one call (used by viewer render loop)
   * @param {Object} drawParams - Draw parameters (includes viewId for per-view LOD)
   * @param {Float32Array} viewPositions - Exact per-view positions.
   * @param {Float32Array} viewTransparency - Exact per-view transparency.
   */
  renderHighlights(drawParams, viewPositions, viewTransparency) {
    this.syncHighlightBufferForLod(
      viewPositions,
      drawParams.viewId,
      viewTransparency,
      drawParams.dimensionLevel
    );
    this.drawHighlights(drawParams);
  }

  setHighlightStyle(options = {}) {
    if (this.highlightRenderer) {
      this.highlightRenderer.setStyle(options);
    }
  }

  getHighlightedCount() {
    return this.highlightRenderer.getTotalPointCount();
  }

  getLassoCtx() {
    return this.lassoCtx;
  }

  // === Highlight mode and annotation ===
  setHighlightMode(mode) {
    this.highlightMode = requireHighlightMode(mode);
    this.selectionDragStart = null;
    this.selectionDragCurrent = null;
    this.annotationStepCount = 0;
    this.annotationLastMode = 'intersect';
    this.canvas.classList.remove('selecting');
    this.canvas.classList.remove('selecting-continuous');
    if (this.highlightMode === 'continuous') {
      this.canvas.classList.add('highlight-continuous');
      this.canvas.classList.remove('highlight-categorical');
    } else if (this.highlightMode === 'categorical') {
      this.canvas.classList.add('highlight-categorical');
      this.canvas.classList.remove('highlight-continuous');
    } else {
      this.canvas.classList.remove('highlight-categorical');
      this.canvas.classList.remove('highlight-continuous');
    }
    this.updateCursorForHighlightMode();
  }

  getHighlightMode() {
    return this.highlightMode;
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
    this.updateCursorForHighlightMode();
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
      const finalIndices = [...this.lassoCandidateSet];
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
        candidates: [],
        cancelled: true
      });
    }
  }

  restoreLassoState(candidates, step) {
    if (candidates && candidates.length > 0) {
      this.lassoCandidateSet = new Set(candidates);
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
    this.updateCursorForHighlightMode();
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
      const finalIndices = [...this.proximityCandidateSet];
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
        candidates: [],
        cancelled: true
      });
    }
  }

  restoreProximityState(candidates, step) {
    if (candidates && candidates.length > 0) {
      this.proximityCandidateSet = new Set(candidates);
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
    this.updateCursorForHighlightMode();
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

  loadKnnEdges(sources, destinations) {
    if (
      !(sources instanceof Uint32Array) ||
      !(destinations instanceof Uint32Array)
    ) {
      throw new TypeError(
        'KNN edges require Uint32Array sources and destinations.'
      );
    }
    if (sources.length !== destinations.length) {
      throw new RangeError(
        'KNN edge source and destination arrays must have equal length.'
      );
    }
    resetKnnCache();
    const start = performance.now();
    this.knnAdjacencyList = buildKnnAdjacencyList(sources, destinations);
    this.knnEdgesLoaded = true;
    const elapsed = performance.now() - start;
    console.log(`[HighlightTools] KNN adjacency list built in ${elapsed.toFixed(1)}ms (${this.knnAdjacencyList.size} nodes)`);
    return true;
  }

  clearKnnEdges() {
    const hadActiveOverlay =
      this.isKnnDragging || this.knnSeedCell !== null;

    this.isKnnDragging = false;
    this.canvas.classList.remove('knn-dragging');
    if (hadActiveOverlay) {
      clearKnnOverlay({ canvas: this.canvas, lassoCtx: this.lassoCtx });
    } else {
      resetKnnCache();
    }
    this.knnSeedCell = null;
    this.knnCurrentDegree = 0;
    this.knnCandidateSet = null;
    this.knnStepCount = 0;
    this.knnAdjacencyList = null;
    this.knnEdgesLoaded = false;
    this.updateCursorForHighlightMode();
  }

  isKnnEdgesLoaded() {
    return this.knnEdgesLoaded;
  }

  confirmKnnSelection() {
    if (this.knnCandidateSet && this.knnCandidateSet.size > 0) {
      const finalIndices = [...this.knnCandidateSet];
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
        candidates: [],
        cancelled: true
      });
    }
    if (this.isKnnDragging) {
      this.isKnnDragging = false;
      this.canvas.classList.remove('knn-dragging');
      clearKnnOverlay({ canvas: this.canvas, lassoCtx: this.lassoCtx });
      this.knnSeedCell = null;
      this.knnCurrentDegree = 0;
      this.updateCursorForHighlightMode();
    }
  }

  restoreKnnState(candidates, step) {
    if (candidates && candidates.length > 0) {
      this.knnCandidateSet = new Set(candidates);
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

  updateCursorForHighlightMode() {
    const navState = this.getNavigationState();
    if (navState.navigationMode === 'free') return;
    if (navState.isDragging) return;
    if (this.selectionDragStart) return;
    if (this.isLassoing) return;
    if (this.isProximityDragging) return;

    if (this.altKeyDown && this.lassoEnabled) {
      this.canvas.style.cursor = 'crosshair';
    } else if (this.altKeyDown && this.proximityEnabled) {
      this.canvas.style.cursor = 'crosshair';
    } else if (this.altKeyDown && this.knnEnabled) {
      this.canvas.style.cursor = 'ns-resize';
    } else if (this.altKeyDown && this.highlightMode === 'continuous') {
      this.canvas.style.cursor = 'ns-resize';
    } else if (this.altKeyDown && this.highlightMode === 'categorical') {
      this.canvas.style.cursor = 'cell';
    } else {
      this.canvas.style.cursor = 'grab';
    }
  }

  handleAltKeyDown() {
    this.altKeyDown = true;
    this.updateCursorForHighlightMode();
  }

  handleAltKeyUp() {
    this.altKeyDown = false;
    this.updateCursorForHighlightMode();
  }

  handleWindowBlur() {
    this._retireActiveSpatialInteractions();
    this.altKeyDown = false;
    this.updateCursorForHighlightMode();
  }

  // === Event handling ===
  handleMouseDown(e) {
    const ctx = this.getRenderContext();

    if (e.altKey && this.lassoEnabled && e.button === 0) {
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
        this.getSpatialQueryOwner(viewId, true),
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
      if (e.ctrlKey || e.metaKey) {
        this.lassoMode = 'subtract';
      } else if (e.shiftKey) {
        this.lassoMode = 'union';
      } else {
        this.lassoMode = 'intersect';
      }
      this.lassoPath = [{ x: localX, y: localY }];
      this._lassoPreviewPublished = false;
      this.lassoViewContext = {
        viewId,
        viewport: vpInfo,
        viewMatrix: capturedViewMatrix,
        modelMatrix: capturedModelMatrix,
        spatialOwner
      };

      this.canvas.style.cursor = 'crosshair';
      this.canvas.classList.add('lassoing');
      drawLasso({ canvas: this.canvas, lassoCtx: this.lassoCtx, lassoPath: this.lassoPath });
      e.preventDefault();
      return true;
    }

    if (e.altKey && this.proximityEnabled && e.button === 0) {
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
        this.getSpatialQueryOwner(viewId, true),
        viewId
      );
      const positions = spatialOwner.positions;
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

      let proximityMode = 'intersect';
      if (e.ctrlKey || e.metaKey) {
        proximityMode = 'subtract';
      } else if (e.shiftKey) {
        proximityMode = 'union';
      }

      let worldPos = null;
      let clickedCellIdx = cellIdx;

      if (cellIdx >= 0) {
        worldPos = [
          positions[cellIdx * 3],
          positions[cellIdx * 3 + 1],
          positions[cellIdx * 3 + 2]
        ];
      } else if (this.proximityCandidateSet && this.proximityCandidateSet.size > 0) {
        let cx = 0, cy = 0, cz = 0;
        for (const idx of this.proximityCandidateSet) {
          cx += positions[idx * 3];
          cy += positions[idx * 3 + 1];
          cz += positions[idx * 3 + 2];
        }
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
          mode: proximityMode,
          viewport: vpInfo,
          viewId,
          viewMatrix: capturedViewMatrix,
          modelMatrix: capturedModelMatrix,
          spatialOwner
        };
        this.proximityCurrentRadius = 0;
        this._proximityPreviewPublished = false;
        this.isProximityDragging = true;
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
    }

    if (e.altKey && this.knnEnabled && e.button === 0) {
      const cellIdx = this.pickCellAtScreen(e.clientX, e.clientY);

      let knnMode = 'intersect';
      if (e.ctrlKey || e.metaKey) {
        knnMode = 'subtract';
      } else if (e.shiftKey) {
        knnMode = 'union';
      }

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
          mode: knnMode,
          viewport: vpInfo,
          viewId: viewId  // Store viewId for multi-dimensional support
        };
        this.knnCurrentDegree = 0;
        resetKnnCache();
        this.isKnnDragging = true;
        this.canvas.style.cursor = 'ns-resize';
        this.canvas.classList.add('knn-dragging');
        // Get view-specific positions for multi-dimensional support
        const knnViewPositions = this.getViewPositions(viewId);
        drawKnnIndicator({
          canvas: this.canvas,
          lassoCtx: this.lassoCtx,
          knnSeedCell: this.knnSeedCell,
          knnCurrentDegree: this.knnCurrentDegree,
          mat4: this.mat4,
          viewMatrix: ctx.viewMatrix,
          modelMatrix: ctx.modelMatrix,
          viewPositions: knnViewPositions
        });
        e.preventDefault();
        return true;
      }
    }

    if (e.altKey && this.cellSelectionEnabled && e.button === 0 && this.highlightMode !== 'none') {
      const cellIdx = this.pickCellAtScreen(e.clientX, e.clientY);
      if (cellIdx >= 0) {
        let selectionMode = 'intersect';
        if (e.shiftKey) {
          selectionMode = 'union';
        } else if (e.ctrlKey || e.metaKey) {
          selectionMode = 'subtract';
        }
        // Get viewport info to know which view the selection is happening in
        const vpInfo = this.getViewportInfoAtScreen(e.clientX, e.clientY);
        const selectionViewId = requireHighlightViewId(
          vpInfo?.viewId,
          'Cell-selection viewId'
        );
        this.selectionDragStart = {
          x: e.clientX,
          y: e.clientY,
          cellIndex: cellIdx,
          mode: selectionMode,
          viewId: selectionViewId
        };
        this.selectionDragCurrent = { x: e.clientX, y: e.clientY };
        if (this.highlightMode === 'continuous') {
          this.canvas.style.cursor = 'ns-resize';
          this.canvas.classList.add('selecting-continuous');
        } else if (this.highlightMode === 'categorical') {
          this.canvas.style.cursor = 'cell';
          this.canvas.classList.add('selecting');
        }
      }
      e.preventDefault();
      return !!this.selectionDragStart;
    }

    return false;
  }

  handleMouseMove(e) {
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

        if (this.lassoPreviewCallback && this.lassoPath.length >= 3) {
          const previewIndices = findCellsInLasso({
            lassoPath: this.lassoPath,
            lassoViewContext: this.lassoViewContext,
            mat4: this.mat4,
            modelMatrix: this.lassoViewContext.modelMatrix,
            transparencyArray: spatialOwner.transparency,
            viewPositions: spatialOwner.positions,
            spatialIndex: spatialOwner.spatialIndex
          });
          this._lassoPreviewPublished = true;
          this.lassoPreviewCallback({
            type: 'lasso-preview',
            cellIndices: previewIndices,
            cellCount: previewIndices.length,
            polygon: [...this.lassoPath]
          });
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

      if (this.proximityPreviewCallback && this.proximityCurrentRadius > 0) {
        const newIndices = findCellsInProximity({
          transparencyArray: spatialOwner.transparency,
          centerPos: this.proximityCenter.worldPos,
          radius3D: this.proximityCurrentRadius,
          viewPositions: spatialOwner.positions,
          spatialIndex: spatialOwner.spatialIndex
        });
        const mode = this.proximityCenter.mode || 'intersect';

        let combinedIndices;
        if (this.proximityCandidateSet === null) {
          combinedIndices = mode === 'subtract' ? [] : newIndices;
        } else if (this.proximityCandidateSet.size === 0) {
          combinedIndices = mode === 'union' ? newIndices : [];
        } else if (mode === 'union') {
          const combined = new Set(this.proximityCandidateSet);
          for (const idx of newIndices) combined.add(idx);
          combinedIndices = [...combined];
        } else if (mode === 'subtract') {
          const newSet = new Set(newIndices);
          combinedIndices = [...this.proximityCandidateSet].filter(idx => !newSet.has(idx));
        } else {
          const newSet = new Set(newIndices);
          combinedIndices = [...this.proximityCandidateSet].filter(idx => newSet.has(idx));
        }

        this._proximityPreviewPublished = true;
        this.proximityPreviewCallback({
          type: 'proximity-preview',
          cellIndices: combinedIndices,
          cellCount: combinedIndices.length,
          newCellCount: newIndices.length,
          centerCellIndex: this.proximityCenter.cellIndex,
          radius: this.proximityCurrentRadius,
          mode: mode
        });
      }
      return true;
    }

    if (this.isKnnDragging && this.knnSeedCell && this.knnAdjacencyList) {
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
        const knnViewPositions = this.getViewPositions(knnViewId);
        drawKnnIndicator({
          canvas: this.canvas,
          lassoCtx: this.lassoCtx,
          knnSeedCell: this.knnSeedCell,
          knnCurrentDegree: this.knnCurrentDegree,
          mat4: this.mat4,
          viewMatrix: ctx.viewMatrix,
          modelMatrix: ctx.modelMatrix,
          viewPositions: knnViewPositions
        });

        if (this.knnPreviewCallback) {
          // Use view-specific transparency so each view's filters are respected
          const viewId = knnViewId;
          const viewTransparency = this.getViewTransparency(viewId);
          const { allCells } = findKnnNeighborsUpToDegree(
            this.knnSeedCell.cellIndex,
            this.knnCurrentDegree,
            this.knnAdjacencyList,
            viewTransparency
          );
          const newIndices = [...allCells];
          const mode = this.knnSeedCell.mode || 'intersect';

          let combinedIndices;
          if (this.knnCandidateSet === null) {
            combinedIndices = mode === 'subtract' ? [] : newIndices;
          } else if (this.knnCandidateSet.size === 0) {
            combinedIndices = mode === 'union' ? newIndices : [];
          } else if (mode === 'union') {
            const combined = new Set(this.knnCandidateSet);
            for (const idx of newIndices) combined.add(idx);
            combinedIndices = [...combined];
          } else if (mode === 'subtract') {
            const newSet = new Set(newIndices);
            combinedIndices = [...this.knnCandidateSet].filter(idx => !newSet.has(idx));
          } else {
            const newSet = new Set(newIndices);
            combinedIndices = [...this.knnCandidateSet].filter(idx => newSet.has(idx));
          }

          this.knnPreviewCallback({
            type: 'knn-preview',
            cellIndices: combinedIndices,
            cellCount: combinedIndices.length,
            newCellCount: newIndices.length,
            seedCellIndex: this.knnSeedCell.cellIndex,
            degree: this.knnCurrentDegree,
            mode: mode
          });
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

    return false;
  }

  handleMouseUp(_e) {
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
        const selectedIndices = findCellsInLasso({
          lassoPath: this.lassoPath,
          lassoViewContext: this.lassoViewContext,
          mat4: this.mat4,
          modelMatrix: this.lassoViewContext.modelMatrix,
          transparencyArray: spatialOwner.transparency,
          viewPositions: spatialOwner.positions,
          spatialIndex: spatialOwner.spatialIndex
        });
        if (selectedIndices.length > 0 || this.lassoMode === 'subtract') {
          const newSet = new Set(selectedIndices);

          if (this.lassoCandidateSet === null) {
            if (this.lassoMode !== 'subtract') {
              this.lassoCandidateSet = new Set(selectedIndices);
            }
          } else if (this.lassoMode === 'union') {
            for (const idx of selectedIndices) {
              this.lassoCandidateSet.add(idx);
            }
          } else if (this.lassoMode === 'subtract') {
            for (const idx of selectedIndices) {
              this.lassoCandidateSet.delete(idx);
            }
          } else {
            this.lassoCandidateSet = new Set([...this.lassoCandidateSet].filter(idx => newSet.has(idx)));
          }

          if (this.lassoCandidateSet) {
            this.lassoStepCount++;
            if (this.lassoStepCallback) {
              this.lassoStepCallback({
                step: this.lassoStepCount,
                candidateCount: this.lassoCandidateSet.size,
                candidates: [...this.lassoCandidateSet],
                mode: this.lassoMode
              });
            }
          }
        }
      }
      clearLassoOverlay({ canvas: this.canvas, lassoCtx: this.lassoCtx });
      this.lassoPath = [];
      this.lassoViewContext = null;
      this._lassoPreviewPublished = false;
      this.updateCursorForHighlightMode();
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
        const newIndices = findCellsInProximity({
          transparencyArray: spatialOwner.transparency,
          centerPos: this.proximityCenter.worldPos,
          radius3D: this.proximityCurrentRadius,
          viewPositions: spatialOwner.positions,
          spatialIndex: spatialOwner.spatialIndex
        });
        const mode = this.proximityCenter.mode || 'intersect';
        const newSet = new Set(newIndices);

        if (this.proximityCandidateSet === null) {
          if (mode !== 'subtract') {
            this.proximityCandidateSet = new Set(newIndices);
          } else {
            this.proximityCandidateSet = new Set();
          }
        } else if (mode === 'union') {
          for (const idx of newIndices) {
            this.proximityCandidateSet.add(idx);
          }
        } else if (mode === 'subtract') {
          for (const idx of newIndices) {
            this.proximityCandidateSet.delete(idx);
          }
        } else {
          this.proximityCandidateSet = new Set([...this.proximityCandidateSet].filter(idx => newSet.has(idx)));
        }

        if (this.proximityCandidateSet) {
          this.proximityStepCount++;
          if (this.proximityStepCallback) {
            this.proximityStepCallback({
              step: this.proximityStepCount,
              candidateCount: this.proximityCandidateSet.size,
              candidates: [...this.proximityCandidateSet],
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
      this._proximityPreviewPublished = false;
      this.updateCursorForHighlightMode();
      return true;
    }

    if (this.isKnnDragging && this.knnSeedCell) {
      this.isKnnDragging = false;
      this.canvas.classList.remove('knn-dragging');

      if (this.knnAdjacencyList && this.knnSeedCell) {
        const mode = this.knnSeedCell.mode || 'intersect';
        // Use view-specific transparency so each view's filters are respected
        const viewId = requireHighlightViewId(
          this.knnSeedCell.viewId,
          'KNN-selection viewId'
        );
        const viewTransparency = this.getViewTransparency(viewId);
        const { allCells } = findKnnNeighborsUpToDegree(
          this.knnSeedCell.cellIndex,
          this.knnCurrentDegree,
          this.knnAdjacencyList,
          viewTransparency
        );
        const selectedIndices = [...allCells];
        const newSet = new Set(selectedIndices);

        if (this.knnCandidateSet === null) {
          if (mode !== 'subtract') {
            this.knnCandidateSet = new Set(selectedIndices);
          }
        } else if (mode === 'union') {
          for (const idx of selectedIndices) {
            this.knnCandidateSet.add(idx);
          }
        } else if (mode === 'subtract') {
          for (const idx of selectedIndices) {
            this.knnCandidateSet.delete(idx);
          }
        } else {
          this.knnCandidateSet = new Set([...this.knnCandidateSet].filter(idx => newSet.has(idx)));
        }

        if (this.knnCandidateSet) {
          this.knnStepCount++;

          if (this.knnStepCallback) {
            this.knnStepCallback({
              step: this.knnStepCount,
              candidateCount: this.knnCandidateSet.size,
              candidates: [...this.knnCandidateSet],
              mode: mode,
              seedCellIndex: this.knnSeedCell.cellIndex,
              degree: this.knnCurrentDegree
            });
          }
        }
      }

      clearKnnOverlay({ canvas: this.canvas, lassoCtx: this.lassoCtx });
      this.knnSeedCell = null;
      this.knnCurrentDegree = 0;
      this.updateCursorForHighlightMode();
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
      this.updateCursorForHighlightMode();
      return true;
    }

    return false;
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
      this.highlightMode = 'none';
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
      this.knnAdjacencyList = null;
      this.knnEdgesLoaded = false;
      this.altKeyDown = false;

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
        'getRenderContext',
        'getNavigationState',
        'getViewPositions',
        'getViewTransparency',
        'getSpatialQueryOwner',
      ]) {
        this[callbackName] = null;
      }

      this._lastUsedPositionsMap = null;
      this._lastPositionFingerprintMap = null;
      this._lastTransparencyFingerprintMap = null;
      this.gl = null;
      this.hpRenderer = null;
      this.mat4 = null;
      this.vec3 = null;
      resetKnnCache();
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

export function pixelDistanceToWorldRadius(pixelDist, targetRadius) {
  const scaleFactor = targetRadius * 0.001;
  return pixelDist * scaleFactor;
}

export function buildKnnAdjacencyList(sources, destinations) {
  const nEdges = sources.length;
  const neighborCounts = new Map();
  for (let i = 0; i < nEdges; i++) {
    const src = sources[i];
    const dst = destinations[i];
    neighborCounts.set(src, (neighborCounts.get(src) || 0) + 1);
    neighborCounts.set(dst, (neighborCounts.get(dst) || 0) + 1);
  }

  const adjacency = new Map();
  const fillIndex = new Map();

  for (const [cell, count] of neighborCounts) {
    adjacency.set(cell, new Uint32Array(count));
    fillIndex.set(cell, 0);
  }

  for (let i = 0; i < nEdges; i++) {
    const src = sources[i];
    const dst = destinations[i];

    const srcArr = adjacency.get(src);
    const dstArr = adjacency.get(dst);
    const srcIdx = fillIndex.get(src);
    const dstIdx = fillIndex.get(dst);

    srcArr[srcIdx] = dst;
    dstArr[dstIdx] = src;

    fillIndex.set(src, srcIdx + 1);
    fillIndex.set(dst, dstIdx + 1);
  }

  return adjacency;
}

let knnDegreesCache = null;
let knnMaxCachedDegree = -1;
let knnCachedAlphasRef = null;  // Track alphas reference to invalidate cache on filter change
let knnCachedAlphasFingerprint = null;  // Track alphas fingerprint to detect in-place mutations

/**
 * Compute a quick fingerprint of alphas array by sampling values.
 * Detects in-place mutations that reference checks would miss.
 * Samples multiple positions and uses finer-grained zero counting for better detection.
 * @param {Uint8Array|Float32Array} alphas - Alpha/transparency values
 * @returns {string|null} Fingerprint string or null if invalid
 */
function computeAlphasFingerprint(alphas) {
  if (!alphas || alphas.length < 3) return null;
  const len = alphas.length;
  // Sample at 5 positions: start, 25%, 50%, 75%, end (better coverage)
  const q1 = Math.floor(len * 0.25);
  const mid = Math.floor(len * 0.5);
  const q3 = Math.floor(len * 0.75);

  let zeroCount = 0;
  let sumSample = 0;
  // Sample every 100th element for better zero detection and value sum
  // This catches more filter state changes while remaining fast
  const step = Math.max(1, Math.floor(len / 500));  // ~500 samples max
  for (let i = 0; i < len; i += step) {
    if (alphas[i] === 0) zeroCount++;
    sumSample += alphas[i];
  }
  return `${alphas[0]},${alphas[q1]},${alphas[mid]},${alphas[q3]},${alphas[len-1]},${zeroCount},${sumSample},${len}`;
}

export function resetKnnCache() {
  knnDegreesCache = null;
  knnMaxCachedDegree = -1;
  knnCachedAlphasRef = null;
  knnCachedAlphasFingerprint = null;
}

export function findKnnNeighborsUpToDegree(seedCell, maxDegree, adjacency, alphas) {
  // Note: highlightArray parameter removed - cells must be visible (not filtered out) to be selectable
  // Seed cell must be visible (not filtered out in this view)
  const seedVisible = !alphas || alphas[seedCell] > 0;
  if (!seedVisible) {
    return { allCells: new Set(), byDegree: new Map(), frontier: [] };
  }

  if (!adjacency || maxDegree < 0) {
    return { allCells: new Set([seedCell]), byDegree: new Map([[0, new Set([seedCell])]]), frontier: [seedCell] };
  }

  // Check if cache is valid: same seed cell, same alphas (reference AND fingerprint), and can extend to requested degree
  // Fingerprint check catches in-place mutations that reference checks would miss
  const currentFingerprint = computeAlphasFingerprint(alphas);
  const alphasMatches = alphas === knnCachedAlphasRef && currentFingerprint === knnCachedAlphasFingerprint;

  if (knnDegreesCache &&
      knnDegreesCache.seedCell === seedCell &&
      alphasMatches &&
      knnMaxCachedDegree >= 0 &&
      maxDegree >= knnMaxCachedDegree) {

    if (maxDegree === knnMaxCachedDegree) {
      return {
        allCells: knnDegreesCache.visited,
        byDegree: knnDegreesCache.byDegree,
        frontier: knnDegreesCache.frontier
      };
    }

    let currentFrontier = knnDegreesCache.frontier;
    const visited = knnDegreesCache.visited;
    const byDegree = knnDegreesCache.byDegree;

    for (let degree = knnMaxCachedDegree + 1; degree <= maxDegree; degree++) {
      const nextFrontier = [];
      const degreeCells = new Set();

      for (let i = 0; i < currentFrontier.length; i++) {
        const cell = currentFrontier[i];
        const neighbors = adjacency.get(cell);
        if (!neighbors) continue;

        const len = neighbors.length;
        for (let j = 0; j < len; j++) {
          const neighbor = neighbors[j];
          if (visited.has(neighbor)) continue;
          // Neighbor is traversable only if visible (not filtered out in this view)
          const neighborVisible = !alphas || alphas[neighbor] > 0;
          if (!neighborVisible) continue;

          visited.add(neighbor);
          degreeCells.add(neighbor);
          nextFrontier.push(neighbor);
        }
      }

      if (degreeCells.size > 0) {
        byDegree.set(degree, degreeCells);
      }

      currentFrontier = nextFrontier;
      knnDegreesCache.frontier = currentFrontier;
      knnMaxCachedDegree = degree;

      if (nextFrontier.length === 0) break;
    }

    return { allCells: visited, byDegree, frontier: currentFrontier };
  }

  const visited = new Set([seedCell]);
  const byDegree = new Map();
  byDegree.set(0, new Set([seedCell]));

  knnDegreesCache = {
    seedCell,
    visited,
    byDegree,
    frontier: [seedCell]
  };
  knnMaxCachedDegree = 0;
  knnCachedAlphasRef = alphas;  // Track which alphas array was used for this cache
  knnCachedAlphasFingerprint = currentFingerprint;  // Track fingerprint to detect in-place mutations

  if (maxDegree === 0) {
    return { allCells: visited, byDegree, frontier: [seedCell] };
  }

  let currentFrontier = [seedCell];

  for (let degree = 1; degree <= maxDegree; degree++) {
    const nextFrontier = [];
    const degreeCells = new Set();

    for (let i = 0; i < currentFrontier.length; i++) {
      const cell = currentFrontier[i];
      const neighbors = adjacency.get(cell);
      if (!neighbors) continue;

      const len = neighbors.length;
      for (let j = 0; j < len; j++) {
        const neighbor = neighbors[j];
        if (visited.has(neighbor)) continue;
        // Neighbor is traversable only if visible (not filtered out in this view)
        const neighborVisible = !alphas || alphas[neighbor] > 0;
        if (!neighborVisible) continue;

        visited.add(neighbor);
        degreeCells.add(neighbor);
        nextFrontier.push(neighbor);
      }
    }

    if (degreeCells.size > 0) {
      byDegree.set(degree, degreeCells);
    }

    currentFrontier = nextFrontier;
    knnDegreesCache.frontier = currentFrontier;
    knnMaxCachedDegree = degree;

    if (nextFrontier.length === 0) break;
  }

  return { allCells: visited, byDegree, frontier: currentFrontier };
}

export function pixelDistanceToKnnDegree(pixelDist) {
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
  viewPositions
}) {
  if (!knnSeedCell) return;
  const positions = requireHighlightPositions(
    viewPositions,
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

  const px = positions[knnSeedCell.cellIndex * 3];
  const py = positions[knnSeedCell.cellIndex * 3 + 1];
  const pz = positions[knnSeedCell.cellIndex * 3 + 2];

  const centerScreen = projectPointToScreen(px, py, pz, localMvp, vpWidth, vpHeight);
  if (!centerScreen) return;

  const drawX = centerScreen.x + vpOffsetX;
  const drawY = centerScreen.y + vpOffsetY;

  const baseRadius = 20;
  const ringSpacing = 15;

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
}

export function clearKnnOverlay({ canvas, lassoCtx }) {
  clearLassoOverlay({ canvas, lassoCtx });
  resetKnnCache();
}

export function projectPointToScreen(px, py, pz, mvp, vpWidth, vpHeight) {
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

export function pointInPolygon(x, y, polygon) {
  if (!polygon || polygon.length < 3) return false;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;

    if (((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Return the exact lasso-selection cell-ID set. With a spatial index the array
 * follows spatial traversal order; callers must treat cell IDs as an unordered
 * selection set (there is no polygon/rank meaning in this API).
 */
export function findCellsInLasso({
  lassoPath,
  lassoViewContext,
  mat4,
  modelMatrix,
  transparencyArray,
  viewPositions,
  spatialIndex = null,
  queryStats = null
}) {
  if (!lassoPath || lassoPath.length < 3) return [];

  const positions = requireHighlightPositions(
    viewPositions,
    'Lasso-selection view positions'
  );
  const pointCount = positions.length / 3;
  const alphas = requireHighlightTransparency(
    transparencyArray,
    pointCount
  );

  if (
    !lassoViewContext ||
    typeof lassoViewContext !== 'object' ||
    !lassoViewContext.viewport ||
    !lassoViewContext.viewMatrix
  ) {
    throw new Error('Lasso selection requires its captured per-view render context.');
  }
  requireHighlightViewId(
    lassoViewContext.viewId,
    'Lasso-selection viewId'
  );
  const vp = requireHighlightViewport(
    lassoViewContext.viewport,
    'Lasso-selection viewport'
  );
  const vpOffsetX = vp.vpOffsetX;
  const vpOffsetY = vp.vpOffsetY;
  const vpWidth = vp.vpWidth;
  const vpHeight = vp.vpHeight;
  const lassoViewMatrixLocal = requireHighlightMatrix(
    lassoViewContext.viewMatrix,
    'Lasso-selection view matrix'
  );
  const exactModelMatrix = requireHighlightMatrix(
    modelMatrix,
    'Lasso-selection model matrix'
  );
  if (
    spatialIndex !== null &&
    (
      typeof spatialIndex !== 'object' ||
      spatialIndex.pointCount !== pointCount ||
      spatialIndex.positions !== positions ||
      typeof spatialIndex.visitProjectedRectCandidates !== 'function'
    )
  ) {
    throw new TypeError(
      'Lasso-selection spatialIndex must be null or an exact matching spatial owner.'
    );
  }
  if (
    queryStats !== null &&
    (
      typeof queryStats !== 'object' ||
      Array.isArray(queryStats)
    )
  ) {
    throw new TypeError('Lasso-selection queryStats must be null or an object.');
  }

  const localLassoPath = new Array(lassoPath.length);
  let minimumScreenX = Infinity;
  let maximumScreenX = -Infinity;
  let minimumScreenY = Infinity;
  let maximumScreenY = -Infinity;
  for (let index = 0; index < lassoPath.length; index++) {
    const x = lassoPath[index].x - vpOffsetX;
    const y = lassoPath[index].y - vpOffsetY;
    localLassoPath[index] = { x, y };
    minimumScreenX = Math.min(minimumScreenX, x);
    maximumScreenX = Math.max(maximumScreenX, x);
    minimumScreenY = Math.min(minimumScreenY, y);
    maximumScreenY = Math.max(maximumScreenY, y);
  }

  const vpMvpMatrix = mat4.create();
  mat4.multiply(vpMvpMatrix, vp.projectionMatrix, lassoViewMatrixLocal);
  mat4.multiply(vpMvpMatrix, vpMvpMatrix, exactModelMatrix);

  const selectedIndices = [];
  let examinedPointCount = 0;
  const evaluatePoint = i => {
    examinedPointCount++;
    // Cell is selectable only if visible (not filtered out in this view)
    // Filtered-out cells cannot be interacted with, even if highlighted in another view
    if (!(alphas[i] >= HIGHLIGHT_VISIBILITY_THRESHOLD)) return;

    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];

    // Keep the exact projectPointToScreen predicate/equations while avoiding
    // one short-lived object allocation per candidate at 10M+ scale.
    const clipX =
      vpMvpMatrix[0] * px +
      vpMvpMatrix[4] * py +
      vpMvpMatrix[8] * pz +
      vpMvpMatrix[12];
    const clipY =
      vpMvpMatrix[1] * px +
      vpMvpMatrix[5] * py +
      vpMvpMatrix[9] * pz +
      vpMvpMatrix[13];
    const clipZ =
      vpMvpMatrix[2] * px +
      vpMvpMatrix[6] * py +
      vpMvpMatrix[10] * pz +
      vpMvpMatrix[14];
    const clipW =
      vpMvpMatrix[3] * px +
      vpMvpMatrix[7] * py +
      vpMvpMatrix[11] * pz +
      vpMvpMatrix[15];
    if (Math.abs(clipW) < 1e-10) return;
    const ndcZ = clipZ / clipW;
    if (ndcZ < -1 || ndcZ > 1) return;
    const screenX = (clipX / clipW + 1) * 0.5 * vpWidth;
    const screenY = (1 - clipY / clipW) * 0.5 * vpHeight;

    if (pointInPolygon(screenX, screenY, localLassoPath)) {
      selectedIndices.push(i);
    }
  };

  if (spatialIndex === null) {
    for (let i = 0; i < pointCount; i++) {
      evaluatePoint(i);
    }
  } else {
    spatialIndex.visitProjectedRectCandidates(
      vpMvpMatrix,
      {
        minX: minimumScreenX * 2 / vpWidth - 1,
        maxX: maximumScreenX * 2 / vpWidth - 1,
        minY: 1 - maximumScreenY * 2 / vpHeight,
        maxY: 1 - minimumScreenY * 2 / vpHeight,
      },
      evaluatePoint
    );
  }
  if (queryStats !== null) {
    queryStats.examinedPointCount = examinedPointCount;
  }

  return selectedIndices;
}
