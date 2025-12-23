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

  const devicePixelRatio = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;

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
  const useAlphaTexture = Boolean(alphaActive && (!isSnapshot || viewWantsAlphaTex));

  const fogNear = typeof hpRenderer?.getFogNear === 'function' ? hpRenderer.getFogNear() : (hpRenderer?.fogNear ?? 0);
  const fogFar = typeof hpRenderer?.getFogFar === 'function' ? hpRenderer.getFogFar() : (hpRenderer?.fogFar ?? 10);

  const getLodLevel = () => (typeof hpRenderer?.getCurrentLODLevel === 'function' ? hpRenderer.getCurrentLODLevel(viewId) : -1);
  const getLodIndices = () => (typeof hpRenderer?.getCurrentLodIndices === 'function'
    ? (hpRenderer.getCurrentLodIndices(viewId, dimensionLevel) || null)
    : null);

  return {
    gl,
    viewId: String(viewId),
    time: Number(timeSeconds) || 0,
    deltaTime: Number(deltaTimeSeconds) || 0,
    isSnapshot: Boolean(isSnapshot),
    dimensionLevel: Number(dimensionLevel) || 3,
    devicePixelRatio,

    mvpMatrix: renderParams.mvpMatrix,
    viewMatrix: renderParams.viewMatrix,
    modelMatrix: renderParams.modelMatrix,
    projectionMatrix: renderParams.projectionMatrix,

    viewportWidth: renderParams.viewportWidth,
    viewportHeight: renderParams.viewportHeight,
    fov: renderParams.fov,
    sizeAttenuation: renderParams.sizeAttenuation,

    fogDensity: renderParams.fogDensity,
    fogColor: renderParams.fogColor,
    fogNear,
    fogFar,

    cameraPosition: renderParams.cameraPosition,
    cameraDistance: renderParams.cameraDistance,

    alphaTexture,
    alphaTexWidth,
    useAlphaTexture,

    getViewPositions,
    getViewTransparency,
    getLodLevel,
    getLodIndices
  };
}
