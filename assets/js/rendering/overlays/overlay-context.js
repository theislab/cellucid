/**
 * @fileoverview Overlay context builder.
 *
 * Overlays consume a read-only view context derived from the viewer's current
 * render params + high-perf renderer state. Keep this context lightweight:
 * - No per-frame typed-array copies
 * - Prefer stable references (matrices, textures)
 *
 * @module rendering/overlays/overlay-context
 */

/**
 * @typedef {object} OverlayContext
 * @property {WebGL2RenderingContext} gl
 * @property {string} viewId
 * @property {number} time
 * @property {number} deltaTime
 * @property {boolean} isSnapshot
 * @property {number} dimensionLevel
 * @property {number} devicePixelRatio
 * @property {Float32Array} mvpMatrix
 * @property {Float32Array} viewMatrix
 * @property {Float32Array} modelMatrix
 * @property {Float32Array} projectionMatrix
 * @property {number} viewportWidth
 * @property {number} viewportHeight
 * @property {number} fov
 * @property {number} sizeAttenuation
 * @property {number} fogDensity
 * @property {Float32Array|number[]} fogColor
 * @property {number} fogNear
 * @property {number} fogFar
 * @property {number[]} cameraPosition
 * @property {number} cameraDistance
 * @property {WebGLTexture|null} alphaTexture
 * @property {number} alphaTexWidth
 * @property {boolean} useAlphaTexture
 * @property {() => Float32Array|null} getViewPositions
 * @property {() => Float32Array|null} getViewTransparency
 * @property {() => number} getLodLevel
 * @property {() => Uint32Array|null} getLodIndices
 */

/**
 * Build an overlay context from the viewer's render params.
 *
 * NOTE: This function is intentionally allocation-light. It references the
 * matrices and arrays from the render loop rather than copying them.
 *
 * @param {object} options
 * @param {WebGL2RenderingContext} options.gl
 * @param {string} options.viewId
 * @param {object} options.renderParams - The object passed into HighPerfRenderer.render()
 * @param {number} options.timeSeconds
 * @param {number} options.deltaTimeSeconds
 * @param {boolean} options.isSnapshot
 * @param {number} options.dimensionLevel
 * @param {object} options.hpRenderer
 * @param {() => Float32Array|null} options.getViewPositions
 * @param {() => Float32Array|null} options.getViewTransparency
 * @returns {OverlayContext}
 */
export function buildOverlayContext(options) {
  const {
    gl,
    viewId,
    renderParams,
    timeSeconds,
    deltaTimeSeconds,
    isSnapshot,
    dimensionLevel,
    hpRenderer,
    getViewPositions,
    getViewTransparency
  } = options || {};

  // Backwards-compatible: allow callers to pass an existing context object to reuse
  // allocations (critical for per-frame render loops).
  const out = options?.reuse || null;
  const ctx = out || {};

  ctx.gl = gl;
  ctx.viewId = String(viewId);
  ctx.time = Number(timeSeconds) || 0;
  ctx.deltaTime = Number(deltaTimeSeconds) || 0;
  ctx.isSnapshot = Boolean(isSnapshot);
  ctx.dimensionLevel = Number(dimensionLevel) || 3;
  ctx.devicePixelRatio = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;

  ctx.mvpMatrix = renderParams.mvpMatrix;
  ctx.viewMatrix = renderParams.viewMatrix;
  ctx.modelMatrix = renderParams.modelMatrix;
  ctx.projectionMatrix = renderParams.projectionMatrix;

  ctx.viewportWidth = renderParams.viewportWidth;
  ctx.viewportHeight = renderParams.viewportHeight;
  ctx.fov = renderParams.fov;
  ctx.sizeAttenuation = renderParams.sizeAttenuation;

  ctx.fogDensity = renderParams.fogDensity;
  ctx.fogColor = renderParams.fogColor;

  ctx.cameraPosition = renderParams.cameraPosition;
  ctx.cameraDistance = renderParams.cameraDistance;

  const alphaTexture = typeof hpRenderer?.getAlphaTexture === 'function'
    ? hpRenderer.getAlphaTexture()
    : (hpRenderer?._alphaTexture || null);
  const alphaTexWidth = typeof hpRenderer?.getAlphaTextureWidth === 'function'
    ? hpRenderer.getAlphaTextureWidth()
    : (hpRenderer?._alphaTexWidth || 0);
  const alphaActive = typeof hpRenderer?.isAlphaTextureActive === 'function'
    ? hpRenderer.isAlphaTextureActive()
    : Boolean(hpRenderer?._useAlphaTexture && alphaTexture && alphaTexWidth);

  // Snapshots may render with their own transparency buffers; only use the alpha
  // texture when the view explicitly opts-in (e.g., sharesLiveTransparency).
  const viewWantsAlphaTex = Boolean(renderParams?.useAlphaTexture);
  ctx.useAlphaTexture = Boolean(alphaActive && (!isSnapshot || viewWantsAlphaTex));
  ctx.alphaTexture = alphaTexture;
  ctx.alphaTexWidth = alphaTexWidth;

  ctx.fogNear = typeof hpRenderer?.getFogNear === 'function' ? hpRenderer.getFogNear() : (hpRenderer?.fogNear ?? 0);
  ctx.fogFar = typeof hpRenderer?.getFogFar === 'function' ? hpRenderer.getFogFar() : (hpRenderer?.fogFar ?? 10);

  if (typeof getViewPositions === 'function') ctx.getViewPositions = getViewPositions;
  if (typeof getViewTransparency === 'function') ctx.getViewTransparency = getViewTransparency;

  // Stable LOD helpers (avoid allocating new closures per frame).
  ctx._hpRenderer = hpRenderer || null;
  if (typeof ctx.getLodLevel !== 'function') {
    ctx.getLodLevel = () => (
      typeof ctx._hpRenderer?.getCurrentLODLevel === 'function' ? ctx._hpRenderer.getCurrentLODLevel(ctx.viewId) : -1
    );
  }
  if (typeof ctx.getLodIndices !== 'function') {
    ctx.getLodIndices = () => (
      typeof ctx._hpRenderer?.getCurrentLodIndices === 'function'
        ? (ctx._hpRenderer.getCurrentLodIndices(ctx.viewId, ctx.dimensionLevel) || null)
        : null
    );
  }

  return ctx;
}
