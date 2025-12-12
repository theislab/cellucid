import { createProgram } from './gl-utils.js';
import { HP_VS_HIGHLIGHT, HP_FS_HIGHLIGHT } from './high-perf-shaders.js';

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

    // Track total highlighted count across all views (for UI feedback)
    this._totalHighlightedCount = 0;

    // Cache for highlighted cell indices - avoids scanning all cells on every rebuildBuffer
    // This dramatically improves performance when only a small fraction of cells are highlighted
    this._highlightedIndicesCache = null;  // Array of highlighted cell indices
    this._highlightDataRef = null;         // Reference to last highlightData array
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
    const style = this.highlightStylesByQuality[quality] || this.highlightStylesByQuality.full;
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
    if (!positions || positions.length === 0) return 0;
    const len = positions.length;
    // Sample every ~300th triplet and sum for a quick fingerprint
    const step = Math.max(3, Math.floor(len / 300)) * 3;
    let sparseSum = 0;
    for (let i = 0; i < len; i += step) {
      sparseSum += positions[i] + (positions[i + 1] || 0) + (positions[i + 2] || 0);
    }
    return len * 31 + sparseSum;
  }

  /**
   * Update or invalidate the highlighted indices cache.
   * Call this when highlight data changes to enable fast iteration in rebuildBuffer.
   * @param {Uint8Array} highlightData - Highlight intensity per cell
   * @param {boolean} [forceRebuild=false] - Force full cache rebuild
   */
  updateHighlightCache(highlightData, forceRebuild = false) {
    // Check if we need to rebuild the cache
    const needsRebuild = forceRebuild ||
      !this._highlightedIndicesCache ||
      this._highlightDataRef !== highlightData;

    if (!needsRebuild) return;

    // Build new cache by scanning all cells (only done when highlight data reference changes)
    if (!highlightData) {
      this._highlightedIndicesCache = [];
      this._highlightDataRef = null;
      this._highlightDataVersion++;
      return;
    }

    const indices = [];
    const len = highlightData.length;
    for (let i = 0; i < len; i++) {
      if (highlightData[i] > 0) {
        indices.push(i);
      }
    }

    this._highlightedIndicesCache = indices;
    this._highlightDataRef = highlightData;
    this._highlightDataVersion++;
  }

  /**
   * Invalidate the highlight cache (call when highlight array contents change in-place)
   */
  invalidateHighlightCache() {
    this._highlightedIndicesCache = null;
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
    this._highlightDataVersion++;
  }

  /**
   * Returns true if the GPU buffer should be rebuilt for the given LOD signature and view.
   * @param {number} lodSignature - LOD signature for cache validation
   * @param {string} [viewId='default'] - View ID for per-view buffer lookup
   * @param {Float32Array} [positions] - Optional positions to check for changes
   */
  needsRefresh(lodSignature, viewId = 'default', positions = null) {
    const vid = String(viewId);
    const viewBuffer = this._viewBuffers.get(vid);

    if (!viewBuffer || !viewBuffer.buffer) return true;
    if (viewBuffer.lodSignature !== lodSignature) return true;

    // Check if positions changed (for multi-dimensional views)
    if (positions) {
      const currentFingerprint = this._computePositionsFingerprint(positions);
      if (viewBuffer.positionsFingerprint !== currentFingerprint) return true;
    }

    return false;
  }

  /**
   * Rebuild the highlight buffer with positions of highlighted cells.
   * Only includes cells that are both highlighted AND visible (LOD + frustum).
   *
   * IMPORTANT: This does NOT check transparency/filtering. Highlights should display
   * in ALL views regardless of each view's filters. Selection tools check filtering
   * separately to prevent selecting filtered-out cells.
   *
   * Now supports per-view buffers for multi-view rendering.
   * @param {Uint8Array} highlightData - Highlight intensity per cell
   * @param {Float32Array} positions - Position data
   * @param {Float32Array|null} visibility - Combined LOD+frustum visibility mask (1.0 = visible, 0.0 = hidden), or null for all visible
   * @param {number} [visibilitySignature] - Signature for cache key (LOD level + frustum state)
   * @param {string} [viewId='default'] - View ID for per-view buffer
   */
  rebuildBuffer(highlightData, positions, visibility = null, visibilitySignature = null, viewId = 'default') {
    const gl = this.gl;
    const vid = String(viewId);

    const sigValue = visibility ? (visibilitySignature ?? -2) : -1;
    const positionsFingerprint = this._computePositionsFingerprint(positions);

    if (!highlightData || !positions) {
      // Clear this view's buffer state
      const viewBuffer = this._viewBuffers.get(vid);
      if (viewBuffer) {
        viewBuffer.pointCount = 0;
        viewBuffer.lodSignature = sigValue;
        viewBuffer.positionsFingerprint = positionsFingerprint;
      }
      return;
    }

    // Use cached highlighted indices for fast iteration (avoids scanning all 10M+ cells)
    // Cache is rebuilt only when highlightData reference changes
    this.updateHighlightCache(highlightData);
    const highlightedIndices = this._highlightedIndicesCache;

    // Count visible highlighted cells using cached indices (visibility = LOD + frustum, NOT filtering)
    let count = 0;
    if (!visibility) {
      // No visibility filter - all highlighted cells are visible
      count = highlightedIndices.length;
    } else {
      // Count only highlighted cells that pass visibility check
      for (let j = 0; j < highlightedIndices.length; j++) {
        const i = highlightedIndices[j];
        if (visibility[i] > 0) count++;
      }
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
      // Only check LOD+frustum visibility for display
      if (visibility && visibility[i] <= 0) continue;

      const posOffset = outIdx * 4;
      const colorOffset = outIdx * BYTES_PER_POINT + 12;

      posView[posOffset] = positions[i * 3];
      posView[posOffset + 1] = positions[i * 3 + 1];
      posView[posOffset + 2] = positions[i * 3 + 2];

      colorView[colorOffset] = 255;
      colorView[colorOffset + 1] = 255;
      colorView[colorOffset + 2] = 255;
      colorView[colorOffset + 3] = highlightData[i];

      outIdx++;
    }

    // Create GPU buffer for this view if needed
    if (!viewBuffer.buffer) {
      viewBuffer.buffer = gl.createBuffer();
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, viewBuffer.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, bufferData, gl.DYNAMIC_DRAW);

    viewBuffer.pointCount = count;
    viewBuffer.lodSignature = sigValue;
    viewBuffer.positionsFingerprint = positionsFingerprint;

    // Update total count for UI feedback
    this._totalHighlightedCount = count;
  }

  /**
   * Get point count for a specific view, or total count if no viewId specified
   * @param {string} [viewId] - View ID (optional, returns total count if not specified)
   */
  getPointCount(viewId) {
    if (viewId) {
      const viewBuffer = this._viewBuffers.get(String(viewId));
      return viewBuffer ? viewBuffer.pointCount : 0;
    }
    // Return total highlighted count across all views for UI feedback
    return this._totalHighlightedCount;
  }

  /**
   * Clear buffer for a specific view (e.g., when view is removed)
   * @param {string} viewId - View ID to clear
   */
  clearViewBuffer(viewId) {
    const vid = String(viewId);
    const viewBuffer = this._viewBuffers.get(vid);
    if (viewBuffer && viewBuffer.buffer) {
      this.gl.deleteBuffer(viewBuffer.buffer);
    }
    this._viewBuffers.delete(vid);
  }

  /**
   * Dispose all GPU resources
   */
  dispose() {
    const gl = this.gl;
    for (const [, viewBuffer] of this._viewBuffers) {
      if (viewBuffer.buffer) {
        gl.deleteBuffer(viewBuffer.buffer);
      }
    }
    this._viewBuffers.clear();
    this._totalHighlightedCount = 0;
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
    basePointSize,
    sizeAttenuation,
    fov,
    fogDensity,
    fogColor,
    lightingStrength,
    lightDir,
    viewId  // Required for per-view buffer lookup and LOD size multiplier
  }) {
    const gl = this.gl;
    const vid = String(viewId || 'default');

    // Get the per-view buffer
    const viewBuffer = this._viewBuffers.get(vid);
    if (!viewBuffer || !viewBuffer.buffer || viewBuffer.pointCount === 0) return;

    const buffer = viewBuffer.buffer;
    const pointCount = viewBuffer.pointCount;

    const depthWasEnabled = gl.isEnabled(gl.DEPTH_TEST);
    const depthMaskWasEnabled = gl.getParameter(gl.DEPTH_WRITEMASK);
    if (!depthWasEnabled) gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);

    gl.useProgram(this.program);

    // Use per-view LOD size multiplier if viewId is provided
    const lodSizeMultiplier = this.hpRenderer && this.hpRenderer.getCurrentLODSizeMultiplier
      ? this.hpRenderer.getCurrentLODSizeMultiplier(viewId)
      : 1.0;
    const highlightPointSize = basePointSize * lodSizeMultiplier;

    gl.uniformMatrix4fv(this.uniformLocations.mvpMatrix, false, mvpMatrix);
    gl.uniformMatrix4fv(this.uniformLocations.viewMatrix, false, viewMatrix);
    gl.uniformMatrix4fv(this.uniformLocations.modelMatrix, false, modelMatrix);
    gl.uniformMatrix4fv(this.uniformLocations.projectionMatrix, false, projectionMatrix);

    let effectiveScale = this.highlightScale;
    let effectiveRingWidth = this.highlightRingWidth;
    let effectiveHaloStrength = this.highlightHaloStrength;
    if (this.highlightHaloShape > 0.5) {
      const haloBoost = Math.min(1.5, Math.max(0, basePointSize * (0.01 + sizeAttenuation * 0.02)));
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
    if (this.hpRenderer) {
      gl.uniform1f(this.uniformLocations.fogNear, this.hpRenderer.fogNear);
      gl.uniform1f(this.uniformLocations.fogFar, this.hpRenderer.fogFar);
    }
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
    gl.depthMask(depthMaskWasEnabled);
    if (!depthWasEnabled) gl.disable(gl.DEPTH_TEST);
  }
}

// ============================================================================
// 2D OVERLAY & HIGHLIGHT TOOLS (LASSO, PROXIMITY, KNN)
// ============================================================================

/**
 * Create a 2D overlay canvas attached to the same parent as the main canvas.
 * Returns { lassoCanvas, lassoCtx }.
 */
export function createLassoOverlay(canvas) {
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
  canvas.parentElement.style.position = 'relative';
  canvas.parentElement.appendChild(lassoCanvas);
  const lassoCtx = lassoCanvas.getContext('2d');

  function syncLassoCanvasSize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    lassoCanvas.width = rect.width * dpr;
    lassoCanvas.height = rect.height * dpr;
    lassoCanvas.style.width = rect.width + 'px';
    lassoCanvas.style.height = rect.height + 'px';
    lassoCtx.setTransform(1, 0, 0, 1, 0, 0);
    lassoCtx.scale(dpr, dpr);
  }

  syncLassoCanvasSize();
  const observer = new ResizeObserver(syncLassoCanvasSize);
  observer.observe(canvas);

  return { lassoCanvas, lassoCtx };
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
  fov,
  near,
  far,
  viewMatrix,
  modelMatrix
}) {
  if (!proximityCenter || proximityCurrentRadius <= 0) return;

  const rect = canvas.getBoundingClientRect();
  lassoCtx.setTransform(1, 0, 0, 1, 0, 0);
  const dpr = window.devicePixelRatio || 1;
  lassoCtx.scale(dpr, dpr);
  lassoCtx.clearRect(0, 0, rect.width, rect.height);

  const vp = proximityCenter.viewport;
  const vpWidth = vp ? vp.vpWidth : rect.width;
  const vpHeight = vp ? vp.vpHeight : rect.height;
  const vpOffsetX = vp ? vp.vpOffsetX : 0;
  const vpOffsetY = vp ? vp.vpOffsetY : 0;

  const localMvp = mat4.create();
  const localProj = mat4.create();
  mat4.perspective(localProj, fov, vpWidth / vpHeight, near, far);
  const effectiveView = (vp && vp.effectiveViewMatrix) ? vp.effectiveViewMatrix : viewMatrix;
  mat4.multiply(localMvp, localProj, effectiveView);
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

export function findCellsInProximity({ hpRenderer, transparencyArray, centerPos, radius3D, viewPositions = null, highlightArray = null }) {
  if (!centerPos || radius3D <= 0) return [];

  // Use view-specific positions if provided, otherwise fall back to main positions
  const mainPositions = hpRenderer.getPositions();
  const positions = viewPositions || mainPositions;
  if (!positions) return [];

  const selectedIndices = [];
  const alphas = transparencyArray;
  const radiusSq = radius3D * radius3D;

  // Brute-force search - fast enough for interactive brush selection
  const n = positions.length / 3;
  for (let i = 0; i < n; i++) {
    // Cell is selectable if: visible (alpha > 0) OR already highlighted
    const isVisible = !alphas || alphas[i] > 0;
    const isHighlighted = highlightArray && highlightArray[i] > 0;
    if (!isVisible && !isHighlighted) continue;
    const dx = positions[i * 3] - centerPos[0];
    const dy = positions[i * 3 + 1] - centerPos[1];
    const dz = positions[i * 3 + 2] - centerPos[2];
    if (dx * dx + dy * dy + dz * dz <= radiusSq) {
      selectedIndices.push(i);
    }
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
    getNavigationState = () => ({ navigationMode: 'orbit', isDragging: false }),
    getViewPositions = null,  // Optional: (viewId) => Float32Array of positions
    startTime = performance.now(),
    shaderQuality = 'full'
  }) {
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

    this.highlightRenderer = new HighlightRenderer(gl, hpRenderer, startTime);
    this.highlightRenderer.setQuality(shaderQuality);

    const { lassoCanvas, lassoCtx } = createLassoOverlay(canvas);
    this.lassoCanvas = lassoCanvas;
    this.lassoCtx = lassoCtx;

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

    this.proximityEnabled = false;
    this.isProximityDragging = false;
    this.proximityCenter = null;
    this.proximityCurrentRadius = 0;
    this.proximityCallback = null;
    this.proximityPreviewCallback = null;
    this.proximityStepCallback = null;

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
    if (this.highlightRenderer) {
      this.highlightRenderer.setQuality(quality);
    }
  }

  /**
   * Update highlight data. In multi-view mode, the buffer will be rebuilt with
   * view-specific positions during the next renderHighlights call.
   *
   * NOTE: Highlight display ignores filtering (transparency). Highlights show in ALL
   * views regardless of per-view filters. This allows highlighting cells in one view
   * and seeing them highlighted in all views, even if filtered out there.
   *
   * @param {Uint8Array} highlightData - Highlight intensity per point (0-255)
   * @param {Float32Array} [viewPositions] - Optional view-specific positions. If not provided,
   *   uses global positions as fallback (will be corrected during next renderHighlights call).
   * @param {number[]} [highlightedIndices] - Optional pre-computed array of highlighted cell indices.
   *   If provided, skips the expensive O(n) full-array scan. Pass this when you already know
   *   which cells are highlighted (e.g., from state.js highlight groups).
   * @param {string} [viewId='default'] - View ID for per-view LOD level in multi-view rendering
   */
  updateHighlight(highlightData, viewPositions = null, highlightedIndices = null, viewId = 'default') {
    this.highlightArray = highlightData;
    if (!this.highlightRenderer) return;

    // If pre-computed indices provided, set cache directly (avoids O(n) scan)
    // Otherwise, invalidate cache to trigger scan on next rebuildBuffer
    if (highlightedIndices) {
      this.highlightRenderer.setHighlightedIndicesCache(highlightedIndices, highlightData);
    } else {
      this.highlightRenderer.invalidateHighlightCache();
    }

    // Use view-specific positions if provided, otherwise use global positions as initial fallback
    // The buffer will be rebuilt with correct positions during renderHighlights
    const positions = viewPositions || (this.hpRenderer.getPositions ? this.hpRenderer.getPositions() : null);
    // Get combined LOD+frustum visibility (NOT filtering/transparency)
    // This ensures highlights show regardless of per-view filters
    const visibility = this.hpRenderer.getCombinedVisibilityForView
      ? this.hpRenderer.getCombinedVisibilityForView(viewId)
      : this.hpRenderer.getLodVisibilityArray?.(undefined, viewId) ?? null;
    const lodLevel = this.hpRenderer.getCurrentLODLevel ? this.hpRenderer.getCurrentLODLevel(viewId) : -1;
    const visibilitySignature = visibility ? (lodLevel ?? -1) : -1;
    this.highlightRenderer.rebuildBuffer(highlightData, positions, visibility, visibilitySignature, viewId);
    // Clear all position caches so next renderHighlights will rebuild with view-specific positions
    this._lastUsedPositionsMap.clear();
    this._lastPositionFingerprintMap.clear();
  }

  /**
   * Handle transparency changes. This does NOT affect highlight display visibility.
   *
   * IMPORTANT: Highlight display ignores filtering. Highlights show in all views
   * regardless of each view's filters. Selection tools check filtering separately.
   *
   * The buffer will be rebuilt with correct view-specific positions during the next
   * renderHighlights call.
   *
   * @param {Float32Array} _transparencyArray - Transparency values per point (ignored for display)
   * @param {Float32Array} [viewPositions] - Optional view-specific positions for multi-dimensional support.
   *   If not provided, uses global positions (will be corrected during next renderHighlights call).
   * @param {string} [viewId='default'] - View ID for per-view LOD level in multi-view rendering
   */
  handleTransparencyChange(_transparencyArray, viewPositions = null, viewId = 'default') {
    if (!this.highlightArray || !this.highlightRenderer) return;
    // Note: We intentionally do NOT use transparencyArray for highlight display.
    // Highlights should show in all views regardless of per-view filtering.
    // Only LOD+frustum visibility affects highlight display.
    const positions = viewPositions || (this.hpRenderer.getPositions ? this.hpRenderer.getPositions() : null);
    // Get combined LOD+frustum visibility (NOT filtering/transparency)
    const visibility = this.hpRenderer.getCombinedVisibilityForView
      ? this.hpRenderer.getCombinedVisibilityForView(viewId)
      : this.hpRenderer.getLodVisibilityArray?.(undefined, viewId) ?? null;
    const lodLevel = this.hpRenderer.getCurrentLODLevel ? this.hpRenderer.getCurrentLODLevel(viewId) : -1;
    const visibilitySignature = visibility ? (lodLevel ?? -1) : -1;
    this.highlightRenderer.rebuildBuffer(this.highlightArray, positions, visibility, visibilitySignature, viewId);
    // Clear all position caches so next renderHighlights will rebuild with view-specific positions
    this._lastUsedPositionsMap.clear();
    this._lastPositionFingerprintMap.clear();
  }

  /**
   * Compute a quick fingerprint of positions array by sampling multiple positions.
   * Samples at 5 positions (first, 25%, 50%, 75%, last) plus a sparse sum for better change detection.
   * @param {Float32Array} positions - Positions array to fingerprint
   * @returns {string|null} Fingerprint string or null if invalid
   */
  _computePositionFingerprint(positions) {
    if (!positions || positions.length < 6) return null;
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
   * Sync highlight buffer for LOD + frustum visibility.
   *
   * IMPORTANT: This uses combined LOD + frustum visibility, NOT filtering.
   * Highlights show in all views regardless of per-view filters.
   *
   * @param {Float32Array} [viewPositions] - Optional view-specific positions for multi-dimensional support
   * @param {string} [viewId] - Optional view ID for per-view LOD level in multi-view rendering
   */
  syncHighlightBufferForLod(viewPositions = null, viewId = undefined) {
    if (!this.highlightArray || !this.highlightRenderer) return;
    // Normalize viewId to string for consistent map key
    const vid = String(viewId || 'default');

    // Use combined LOD + frustum visibility for this view (NOT filtering/transparency)
    // This ensures highlights show regardless of per-view filters
    const visibility = this.hpRenderer.getCombinedVisibilityForView
      ? this.hpRenderer.getCombinedVisibilityForView(viewId)
      : this.hpRenderer.getLodVisibilityArray?.(undefined, viewId) ?? null;
    const lodLevel = this.hpRenderer.getCurrentLODLevel ? this.hpRenderer.getCurrentLODLevel(viewId) : -1;
    const visibilitySignature = visibility ? (lodLevel ?? -1) : -1;

    // Check if positions changed using per-view fingerprint (handles in-place mutations)
    // Reference check is fast path; fingerprint catches in-place array mutations
    const positions = viewPositions || (this.hpRenderer.getPositions ? this.hpRenderer.getPositions() : null);
    const currentFingerprint = positions ? this._computePositionFingerprint(positions) : null;
    const lastUsedPositions = this._lastUsedPositionsMap.get(vid);
    const lastFingerprint = this._lastPositionFingerprintMap.get(vid);
    const positionsChanged = positions && (
      positions !== lastUsedPositions ||
      currentFingerprint !== lastFingerprint
    );

    if (this.highlightRenderer.needsRefresh(visibilitySignature, vid, positions) || positionsChanged) {
      this.highlightRenderer.rebuildBuffer(this.highlightArray, positions, visibility, visibilitySignature, vid);
      this._lastUsedPositionsMap.set(vid, positions);
      this._lastPositionFingerprintMap.set(vid, currentFingerprint);
    }
  }

  drawHighlights(drawParams = {}) {
    if (!this.highlightRenderer) return;
    const normalizedParams = {
      mvpMatrix: drawParams.mvpMatrix,
      viewMatrix: drawParams.viewMatrix,
      modelMatrix: drawParams.modelMatrix,
      projectionMatrix: drawParams.projectionMatrix,
      viewportHeight: drawParams.viewportHeight,
      basePointSize: drawParams.basePointSize ?? drawParams.pointSize ?? 1.0,
      sizeAttenuation: drawParams.sizeAttenuation,
      fov: drawParams.fov,
      fogDensity: drawParams.fogDensity,
      fogColor: drawParams.fogColor,
      lightingStrength: drawParams.lightingStrength,
      lightDir: drawParams.lightDir,
      viewId: drawParams.viewId  // Pass viewId for per-view LOD size multiplier
    };
    this.highlightRenderer.draw(normalizedParams);
  }

  /**
   * Sync LOD visibility and draw highlights in one call (used by viewer render loop)
   * @param {Object} drawParams - Draw parameters (includes viewId for per-view LOD)
   * @param {Float32Array} [viewPositions] - Optional per-view positions for multi-dimensional support
   */
  renderHighlights(drawParams = {}, viewPositions = null) {
    // Pass viewId for per-view LOD level lookup
    this.syncHighlightBufferForLod(viewPositions, drawParams.viewId);
    this.drawHighlights(drawParams);
  }

  setHighlightStyle(options = {}) {
    if (this.highlightRenderer) {
      this.highlightRenderer.setStyle(options);
    }
  }

  getHighlightedCount() {
    return this.highlightRenderer ? this.highlightRenderer.getPointCount() : 0;
  }

  getLassoCtx() {
    return this.lassoCtx;
  }

  // === Highlight mode and annotation ===
  setHighlightMode(mode) {
    this.highlightMode = mode || 'none';
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
    this.cellSelectionEnabled = enabled;
  }

  getCellSelectionEnabled() {
    return this.cellSelectionEnabled;
  }

  setCellSelectionCallback(callback) {
    this.cellSelectionCallback = callback;
  }

  setSelectionStepCallback(callback) {
    this.selectionStepCallback = callback;
  }

  setSelectionPreviewCallback(callback) {
    this.selectionPreviewCallback = callback;
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
    this.lassoEnabled = Boolean(enabled);
    if (!this.lassoEnabled) {
      if (this.isLassoing) {
        this.isLassoing = false;
        clearLassoOverlay({ canvas: this.canvas, lassoCtx: this.lassoCtx });
        this.lassoPath = [];
        this.lassoViewContext = null;
        this.canvas.classList.remove('lassoing');
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
    this.lassoCallback = callback;
  }

  setLassoPreviewCallback(callback) {
    this.lassoPreviewCallback = callback;
  }

  clearLasso() {
    if (this.isLassoing) {
      this.isLassoing = false;
      this.canvas.classList.remove('lassoing');
    }
    clearLassoOverlay({ canvas: this.canvas, lassoCtx: this.lassoCtx });
    this.lassoPath = [];
    this.lassoViewContext = null;
  }

  setLassoStepCallback(callback) {
    this.lassoStepCallback = callback;
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
    this.proximityEnabled = Boolean(enabled);
    if (!this.proximityEnabled) {
      if (this.isProximityDragging) {
        this.isProximityDragging = false;
        clearProximityOverlay({ canvas: this.canvas, lassoCtx: this.lassoCtx });
        this.canvas.classList.remove('proximity-dragging');
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
    this.proximityCallback = callback;
  }

  setProximityPreviewCallback(callback) {
    this.proximityPreviewCallback = callback;
  }

  setProximityStepCallback(callback) {
    this.proximityStepCallback = callback;
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
    if (this.isProximityDragging) {
      this.isProximityDragging = false;
      this.canvas.classList.remove('proximity-dragging');
      clearProximityOverlay({ canvas: this.canvas, lassoCtx: this.lassoCtx });
      this.proximityCenter = null;
      this.proximityCurrentRadius = 0;
      this.updateCursorForHighlightMode();
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
    this.knnEnabled = Boolean(enabled);
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
    this.knnCallback = callback;
  }

  setKnnPreviewCallback(callback) {
    this.knnPreviewCallback = callback;
  }

  setKnnStepCallback(callback) {
    this.knnStepCallback = callback;
  }

  setKnnEdgeLoadCallback(callback) {
    this.knnEdgeLoadCallback = callback;
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
    if (!sources || !destinations || sources.length === 0) {
      console.warn('[HighlightTools] Invalid edge data for KNN');
      return false;
    }
    resetKnnCache();
    const start = performance.now();
    this.knnAdjacencyList = buildKnnAdjacencyList(sources, destinations);
    this.knnEdgesLoaded = true;
    const elapsed = performance.now() - start;
    console.log(`[HighlightTools] KNN adjacency list built in ${elapsed.toFixed(1)}ms (${this.knnAdjacencyList.size} nodes)`);
    return true;
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
    const navState = this.getNavigationState ? this.getNavigationState() : {};
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
    this.altKeyDown = false;
    this.updateCursorForHighlightMode();
  }

  // === Event handling ===
  handleMouseDown(e) {
    const ctx = this.getRenderContext?.() || {};

    if (e.altKey && this.lassoEnabled && e.button === 0) {
      const rect = this.canvas.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;

      this.isLassoing = true;
      if (e.ctrlKey || e.metaKey) {
        this.lassoMode = 'subtract';
      } else if (e.shiftKey) {
        this.lassoMode = 'union';
      } else {
        this.lassoMode = 'intersect';
      }
      this.lassoPath = [{ x: localX, y: localY }];

      const vpInfo = this.getViewportInfoAtScreen ? this.getViewportInfoAtScreen(e.clientX, e.clientY) : null;
      const capturedViewMatrix = this.mat4?.create ? this.mat4.create() : null;
      if (capturedViewMatrix) {
        const sourceViewMatrix = (vpInfo && vpInfo.effectiveViewMatrix) ? vpInfo.effectiveViewMatrix : ctx.viewMatrix;
        this.mat4.copy(capturedViewMatrix, sourceViewMatrix);
      }
      this.lassoViewContext = {
        viewId: vpInfo?.viewId,
        viewport: vpInfo,
        viewMatrix: capturedViewMatrix || ctx.viewMatrix
      };

      this.canvas.style.cursor = 'crosshair';
      this.canvas.classList.add('lassoing');
      drawLasso({ canvas: this.canvas, lassoCtx: this.lassoCtx, lassoPath: this.lassoPath });
      e.preventDefault();
      return true;
    }

    if (e.altKey && this.proximityEnabled && e.button === 0) {
      const cellIdx = this.pickCellAtScreen ? this.pickCellAtScreen(e.clientX, e.clientY) : -1;

      // Get view-specific positions for multi-dimensional support
      const vpInfo = this.getViewportInfoAtScreen ? this.getViewportInfoAtScreen(e.clientX, e.clientY) : null;
      const viewId = vpInfo?.viewId;
      const positions = this.getViewPositions ? this.getViewPositions(viewId) : (this.hpRenderer.getPositions ? this.hpRenderer.getPositions() : null);

      let proximityMode = 'intersect';
      if (e.ctrlKey || e.metaKey) {
        proximityMode = 'subtract';
      } else if (e.shiftKey) {
        proximityMode = 'union';
      }

      let worldPos = null;
      let clickedCellIdx = cellIdx;

      if (cellIdx >= 0 && positions) {
        worldPos = [
          positions[cellIdx * 3],
          positions[cellIdx * 3 + 1],
          positions[cellIdx * 3 + 2]
        ];
      } else if (this.proximityCandidateSet && this.proximityCandidateSet.size > 0 && positions) {
        let cx = 0, cy = 0, cz = 0;
        for (const idx of this.proximityCandidateSet) {
          cx += positions[idx * 3];
          cy += positions[idx * 3 + 1];
          cz += positions[idx * 3 + 2];
        }
        const count = this.proximityCandidateSet.size;
        cx /= count; cy /= count; cz /= count;

        const rect = this.canvas.getBoundingClientRect();
        const localX = e.clientX - rect.left;
        const localY = e.clientY - rect.top;
        const ray = this.screenToRay ? this.screenToRay(localX, localY, rect.width, rect.height) : null;

        if (ray && this.vec3 && ctx.target && ctx.eye) {
          const viewDir = this.vec3.sub(this.vec3.create(), ctx.target, ctx.eye);
          this.vec3.normalize(viewDir, viewDir);

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
          viewId: viewId  // Store viewId for multi-dimensional support
        };
        this.proximityCurrentRadius = 0;
        this.isProximityDragging = true;
        this.canvas.style.cursor = 'crosshair';
        this.canvas.classList.add('proximity-dragging');
        drawProximityIndicator({
          canvas: this.canvas,
          lassoCtx: this.lassoCtx,
          proximityCenter: this.proximityCenter,
          proximityCurrentRadius: this.proximityCurrentRadius,
          mat4: this.mat4,
          fov: ctx.fov,
          near: ctx.near,
          far: ctx.far,
          viewMatrix: ctx.viewMatrix,
          modelMatrix: ctx.modelMatrix
        });
        e.preventDefault();
        return true;
      }
    }

    if (e.altKey && this.knnEnabled && e.button === 0) {
      const cellIdx = this.pickCellAtScreen ? this.pickCellAtScreen(e.clientX, e.clientY) : -1;

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

        const vpInfo = this.getViewportInfoAtScreen ? this.getViewportInfoAtScreen(e.clientX, e.clientY) : null;
        const viewId = vpInfo?.viewId;
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
        const knnViewPositions = this.getViewPositions ? this.getViewPositions(viewId) : null;
        drawKnnIndicator({
          canvas: this.canvas,
          lassoCtx: this.lassoCtx,
          knnSeedCell: this.knnSeedCell,
          knnCurrentDegree: this.knnCurrentDegree,
          hpRenderer: this.hpRenderer,
          mat4: this.mat4,
          fov: ctx.fov,
          near: ctx.near,
          far: ctx.far,
          viewMatrix: ctx.viewMatrix,
          modelMatrix: ctx.modelMatrix,
          viewPositions: knnViewPositions
        });
        e.preventDefault();
        return true;
      }
    }

    if (e.altKey && this.cellSelectionEnabled && e.button === 0 && this.highlightMode !== 'none') {
      const cellIdx = this.pickCellAtScreen ? this.pickCellAtScreen(e.clientX, e.clientY) : -1;
      if (cellIdx >= 0) {
        let selectionMode = 'intersect';
        if (e.shiftKey) {
          selectionMode = 'union';
        } else if (e.ctrlKey || e.metaKey) {
          selectionMode = 'subtract';
        }
        this.selectionDragStart = {
          x: e.clientX,
          y: e.clientY,
          cellIndex: cellIdx,
          mode: selectionMode
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
    const ctx = this.getRenderContext?.() || {};

    if (this.isLassoing) {
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
          // Get view-specific positions for multi-dimensional support
          const viewId = this.lassoViewContext?.viewId;
          const viewPositions = this.getViewPositions ? this.getViewPositions(viewId) : null;
          const previewIndices = findCellsInLasso({
            lassoPath: this.lassoPath,
            lassoViewContext: this.lassoViewContext,
            canvas: this.canvas,
            hpRenderer: this.hpRenderer,
            mat4: this.mat4,
            fov: ctx.fov,
            near: ctx.near,
            far: ctx.far,
            modelMatrix: ctx.modelMatrix,
            viewMatrix: ctx.viewMatrix,
            liveViewHidden: ctx.liveViewHidden,
            snapshotViews: ctx.snapshotViews || [],
            viewLayoutMode: ctx.viewLayoutMode,
            transparencyArray: ctx.transparencyArray,
            viewPositions,
            highlightArray: this.highlightArray  // Allow selecting highlighted cells even if filtered
          });
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
      const dx = e.clientX - this.proximityCenter.screenX;
      const dy = e.clientY - this.proximityCenter.screenY;
      const pixelDist = Math.sqrt(dx * dx + dy * dy);

      this.proximityCurrentRadius = pixelDistanceToWorldRadius(pixelDist, ctx.targetRadius);

      drawProximityIndicator({
        canvas: this.canvas,
        lassoCtx: this.lassoCtx,
        proximityCenter: this.proximityCenter,
        proximityCurrentRadius: this.proximityCurrentRadius,
        mat4: this.mat4,
        fov: ctx.fov,
        near: ctx.near,
        far: ctx.far,
        viewMatrix: ctx.viewMatrix,
        modelMatrix: ctx.modelMatrix
      });

      if (this.proximityPreviewCallback && this.proximityCurrentRadius > 0) {
        // Get view-specific positions for multi-dimensional support
        const viewId = this.proximityCenter?.viewId;
        const viewPositions = this.getViewPositions ? this.getViewPositions(viewId) : null;
        const newIndices = findCellsInProximity({
          hpRenderer: this.hpRenderer,
          transparencyArray: ctx.transparencyArray,
          centerPos: this.proximityCenter.worldPos,
          radius3D: this.proximityCurrentRadius,
          viewPositions,
          highlightArray: this.highlightArray  // Allow selecting highlighted cells even if filtered
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
        const knnViewPositions = this.getViewPositions ? this.getViewPositions(this.knnSeedCell?.viewId) : null;
        drawKnnIndicator({
          canvas: this.canvas,
          lassoCtx: this.lassoCtx,
          knnSeedCell: this.knnSeedCell,
          knnCurrentDegree: this.knnCurrentDegree,
          hpRenderer: this.hpRenderer,
          mat4: this.mat4,
          fov: ctx.fov,
          near: ctx.near,
          far: ctx.far,
          viewMatrix: ctx.viewMatrix,
          modelMatrix: ctx.modelMatrix,
          viewPositions: knnViewPositions
        });

        if (this.knnPreviewCallback) {
          const { allCells } = findKnnNeighborsUpToDegree(
            this.knnSeedCell.cellIndex,
            this.knnCurrentDegree,
            this.knnAdjacencyList,
            ctx.transparencyArray,
            this.highlightArray  // Allow selecting highlighted cells even if filtered
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
          mode: this.selectionDragStart.mode || 'intersect'
        });
      }
      return true;
    }

    return false;
  }

  handleMouseUp(e) {
    const ctx = this.getRenderContext?.() || {};

    if (this.isLassoing) {
      this.isLassoing = false;
      this.canvas.classList.remove('lassoing');
      if (this.lassoPath.length >= 3) {
        // Get view-specific positions for multi-dimensional support
        const viewId = this.lassoViewContext?.viewId;
        const viewPositions = this.getViewPositions ? this.getViewPositions(viewId) : null;
        const selectedIndices = findCellsInLasso({
          lassoPath: this.lassoPath,
          lassoViewContext: this.lassoViewContext,
          canvas: this.canvas,
          hpRenderer: this.hpRenderer,
          mat4: this.mat4,
          fov: ctx.fov,
          near: ctx.near,
          far: ctx.far,
          modelMatrix: ctx.modelMatrix,
          viewMatrix: ctx.viewMatrix,
          liveViewHidden: ctx.liveViewHidden,
          snapshotViews: ctx.snapshotViews || [],
          viewLayoutMode: ctx.viewLayoutMode,
          transparencyArray: ctx.transparencyArray,
          viewPositions,
          highlightArray: this.highlightArray  // Allow selecting highlighted cells even if filtered
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
      this.updateCursorForHighlightMode();
      return true;
    }

    if (this.isProximityDragging && this.proximityCenter) {
      this.isProximityDragging = false;
      this.canvas.classList.remove('proximity-dragging');

      if (this.proximityCurrentRadius > 0) {
        // Get view-specific positions for multi-dimensional support
        const viewId = this.proximityCenter?.viewId;
        const viewPositions = this.getViewPositions ? this.getViewPositions(viewId) : null;
        const newIndices = findCellsInProximity({
          hpRenderer: this.hpRenderer,
          transparencyArray: ctx.transparencyArray,
          centerPos: this.proximityCenter.worldPos,
          radius3D: this.proximityCurrentRadius,
          viewPositions,
          highlightArray: this.highlightArray  // Allow selecting highlighted cells even if filtered
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
      this.updateCursorForHighlightMode();
      return true;
    }

    if (this.isKnnDragging && this.knnSeedCell) {
      this.isKnnDragging = false;
      this.canvas.classList.remove('knn-dragging');

      if (this.knnAdjacencyList && this.knnSeedCell) {
        const mode = this.knnSeedCell.mode || 'intersect';
        const { allCells } = findKnnNeighborsUpToDegree(
          this.knnSeedCell.cellIndex,
          this.knnCurrentDegree,
          this.knnAdjacencyList,
          ctx.transparencyArray,
          this.highlightArray  // Allow selecting highlighted cells even if filtered
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
          mode: mode
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

export function findKnnNeighborsUpToDegree(seedCell, maxDegree, adjacency, alphas, highlightArray = null) {
  // Seed cell must be visible OR highlighted
  const seedVisible = !alphas || alphas[seedCell] > 0;
  const seedHighlighted = highlightArray && highlightArray[seedCell] > 0;
  if (!seedVisible && !seedHighlighted) {
    return { allCells: new Set(), byDegree: new Map(), frontier: [] };
  }

  if (!adjacency || maxDegree < 0) {
    return { allCells: new Set([seedCell]), byDegree: new Map([[0, new Set([seedCell])]]), frontier: [seedCell] };
  }

  // Check if cache is valid: same seed cell, same alphas (reference AND fingerprint), and can extend to requested degree
  // Fingerprint check catches in-place mutations that reference checks would miss
  // Note: We don't cache based on highlightArray since it changes frequently during selection
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
          // Neighbor is traversable if: visible (alpha > 0) OR highlighted
          const neighborVisible = !alphas || alphas[neighbor] > 0;
          const neighborHighlighted = highlightArray && highlightArray[neighbor] > 0;
          if (!neighborVisible && !neighborHighlighted) continue;

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
        // Neighbor is traversable if: visible (alpha > 0) OR highlighted
        const neighborVisible = !alphas || alphas[neighbor] > 0;
        const neighborHighlighted = highlightArray && highlightArray[neighbor] > 0;
        if (!neighborVisible && !neighborHighlighted) continue;

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
  hpRenderer,
  mat4,
  fov,
  near,
  far,
  viewMatrix,
  modelMatrix,
  viewPositions = null  // Optional: view-specific positions for multi-dimensional support
}) {
  if (!knnSeedCell) return;

  const rect = canvas.getBoundingClientRect();
  lassoCtx.setTransform(1, 0, 0, 1, 0, 0);
  const dpr = window.devicePixelRatio || 1;
  lassoCtx.scale(dpr, dpr);
  lassoCtx.clearRect(0, 0, rect.width, rect.height);

  // Use view-specific positions if provided, otherwise fall back to main positions
  const positions = viewPositions || hpRenderer.getPositions();
  if (!positions) return;

  const vp = knnSeedCell.viewport;
  const vpWidth = vp ? vp.vpWidth : rect.width;
  const vpHeight = vp ? vp.vpHeight : rect.height;
  const vpOffsetX = vp ? vp.vpOffsetX : 0;
  const vpOffsetY = vp ? vp.vpOffsetY : 0;

  const localMvp = mat4.create();
  const localProj = mat4.create();
  mat4.perspective(localProj, fov, vpWidth / vpHeight, near, far);
  const effectiveView = (vp && vp.effectiveViewMatrix) ? vp.effectiveViewMatrix : viewMatrix;
  mat4.multiply(localMvp, localProj, effectiveView);
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

export function findCellsInLasso({
  lassoPath,
  lassoViewContext,
  canvas,
  hpRenderer,
  mat4,
  fov,
  near,
  far,
  modelMatrix,
  viewMatrix,
  liveViewHidden,
  snapshotViews,
  viewLayoutMode,
  transparencyArray,
  viewPositions = null,  // Optional: view-specific positions for multi-dimensional support
  highlightArray = null  // Optional: allow selecting highlighted cells even if filtered
}) {
  if (!lassoPath || lassoPath.length < 3) return [];

  // Use view-specific positions if provided, otherwise fall back to main positions
  const positions = viewPositions || hpRenderer.getPositions();
  if (!positions) return [];

  const rect = canvas.getBoundingClientRect();

  let vpOffsetX = 0;
  let vpOffsetY = 0;
  let vpWidth = rect.width;
  let vpHeight = rect.height;
  let lassoViewMatrixLocal = viewMatrix;

  if (lassoViewContext && lassoViewContext.viewport) {
    const vp = lassoViewContext.viewport;
    vpOffsetX = vp.vpOffsetX;
    vpOffsetY = vp.vpOffsetY;
    vpWidth = vp.vpWidth;
    vpHeight = vp.vpHeight;
    lassoViewMatrixLocal = lassoViewContext.viewMatrix;
  } else {
    const viewCount = (liveViewHidden ? 0 : 1) + snapshotViews.length;
    if (viewLayoutMode === 'grid' && viewCount > 1) {
      const cols = viewCount <= 3 ? viewCount : Math.ceil(Math.sqrt(viewCount));
      const rows = Math.ceil(viewCount / cols);
      vpWidth = rect.width / cols;
      vpHeight = rect.height / rows;

      const firstPt = lassoPath[0];
      const col = Math.floor(firstPt.x / vpWidth);
      const row = Math.floor(firstPt.y / vpHeight);

      const clampedCol = Math.max(0, Math.min(col, cols - 1));
      const clampedRow = Math.max(0, Math.min(row, rows - 1));

      vpOffsetX = clampedCol * vpWidth;
      vpOffsetY = clampedRow * vpHeight;
    }
  }

  const localLassoPath = lassoPath.map(pt => ({
    x: pt.x - vpOffsetX,
    y: pt.y - vpOffsetY
  }));

  const vpAspect = vpWidth / vpHeight;
  const vpProjection = mat4.create();
  mat4.perspective(vpProjection, fov, vpAspect, near, far);

  const vpMvpMatrix = mat4.create();
  mat4.multiply(vpMvpMatrix, vpProjection, lassoViewMatrixLocal);
  mat4.multiply(vpMvpMatrix, vpMvpMatrix, modelMatrix);

  const selectedIndices = [];
  const n = positions.length / 3;
  const alphas = transparencyArray;

  for (let i = 0; i < n; i++) {
    // Cell is selectable if: visible (alpha > 0) OR already highlighted
    // This allows interacting with highlighted cells even if filtered in current view
    const isVisible = !alphas || alphas[i] > 0;
    const isHighlighted = highlightArray && highlightArray[i] > 0;
    if (!isVisible && !isHighlighted) continue;

    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];

    const screenPos = projectPointToScreen(px, py, pz, vpMvpMatrix, vpWidth, vpHeight);
    if (!screenPos) continue;

    if (pointInPolygon(screenPos.x, screenPos.y, localLassoPath)) {
      selectedIndices.push(i);
    }
  }

  return selectedIndices;
}
