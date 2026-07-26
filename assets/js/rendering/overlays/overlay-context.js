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
 * @param {number} options.devicePixelRatio
 * @param {object} options.hpRenderer
 * @param {() => Float32Array|null} options.getViewPositions
 * @param {() => Float32Array|null} options.getViewTransparency
 * @param {OverlayContext|object} options.target - Stable output object owned by this view
 * @returns {OverlayContext}
 */
export function buildOverlayContext(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Overlay context options are required.');
  }
  const {
    gl,
    viewId,
    renderParams,
    timeSeconds,
    deltaTimeSeconds,
    isSnapshot,
    dimensionLevel,
    devicePixelRatio,
    hpRenderer,
    getViewPositions,
    getViewTransparency,
    target
  } = options;

  if (!Number.isInteger(dimensionLevel) || dimensionLevel < 1 || dimensionLevel > 3) {
    throw new RangeError(
      `Overlay context dimensionLevel is required and must be exactly 1, 2, or 3; received ${String(dimensionLevel)}.`
    );
  }
  if (typeof viewId !== 'string' || viewId.length === 0) {
    throw new TypeError('Overlay context viewId must be a non-empty string.');
  }
  if (!gl || typeof gl !== 'object') {
    throw new TypeError('Overlay context WebGL2 state is required.');
  }
  if (!renderParams || typeof renderParams !== 'object') {
    throw new TypeError('Overlay context renderParams are required.');
  }
  if (typeof isSnapshot !== 'boolean') {
    throw new TypeError('Overlay context isSnapshot must be a boolean.');
  }
  if (!Number.isFinite(timeSeconds)) {
    throw new TypeError('Overlay context timeSeconds must be a finite number.');
  }
  if (!Number.isFinite(deltaTimeSeconds) || deltaTimeSeconds < 0) {
    throw new RangeError(
      'Overlay context deltaTimeSeconds must be a finite non-negative number.'
    );
  }
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    throw new RangeError('Overlay context devicePixelRatio must be a finite positive number.');
  }
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError('Overlay context target must be the exact stable per-view object.');
  }
  if (!hpRenderer || typeof hpRenderer !== 'object') {
    throw new TypeError('Overlay context hpRenderer is required.');
  }
  for (const method of [
    'getAlphaTexture',
    'getAlphaTextureWidth',
    'isAlphaTextureActive',
    'getFogNear',
    'getFogFar',
    'getCurrentLODLevel',
    'getCurrentLodIndices'
  ]) {
    if (typeof hpRenderer[method] !== 'function') {
      throw new TypeError(`Overlay context hpRenderer.${method}() is required.`);
    }
  }
  if (typeof getViewPositions !== 'function') {
    throw new TypeError('Overlay context getViewPositions() is required.');
  }
  if (typeof getViewTransparency !== 'function') {
    throw new TypeError('Overlay context getViewTransparency() is required.');
  }

  const matrixKeys = [
    'mvpMatrix',
    'viewMatrix',
    'modelMatrix',
    'projectionMatrix'
  ];
  for (const key of matrixKeys) {
    const matrix = renderParams[key];
    if (!(matrix instanceof Float32Array) || matrix.length !== 16) {
      throw new TypeError(
        `Overlay context renderParams.${key} must be a 16-value Float32Array.`
      );
    }
  }
  for (const key of [
    'viewportWidth',
    'viewportHeight',
    'fov',
    'sizeAttenuation',
    'fogDensity',
    'cameraDistance'
  ]) {
    if (!Number.isFinite(renderParams[key])) {
      throw new TypeError(`Overlay context renderParams.${key} must be a finite number.`);
    }
  }
  if (typeof renderParams.useAlphaTexture !== 'boolean') {
    throw new TypeError(
      'Overlay context renderParams.useAlphaTexture must be a boolean.'
    );
  }
  for (const key of ['fogColor', 'cameraPosition']) {
    const value = renderParams[key];
    if (
      !(Array.isArray(value) || value instanceof Float32Array) ||
      value.length !== 3 ||
      Array.from(value).some((entry) => !Number.isFinite(entry))
    ) {
      throw new TypeError(
        `Overlay context renderParams.${key} must contain exactly three finite numbers.`
      );
    }
  }

  const ctx = target;

  ctx.gl = gl;
  ctx.viewId = viewId;
  ctx.time = timeSeconds;
  ctx.deltaTime = deltaTimeSeconds;
  ctx.isSnapshot = isSnapshot;
  ctx.dimensionLevel = dimensionLevel;
  ctx.devicePixelRatio = devicePixelRatio;

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

  const alphaTexture = hpRenderer.getAlphaTexture();
  const alphaTexWidth = hpRenderer.getAlphaTextureWidth();
  const alphaActive = hpRenderer.isAlphaTextureActive();
  if (typeof alphaActive !== 'boolean') {
    throw new TypeError('Overlay context alpha-texture activity must be a boolean.');
  }
  if (!Number.isInteger(alphaTexWidth) || alphaTexWidth < 0) {
    throw new RangeError(
      'Overlay context alpha texture width must be a non-negative integer.'
    );
  }
  if (
    renderParams.useAlphaTexture &&
    (!alphaActive || !alphaTexture || alphaTexWidth === 0)
  ) {
    throw new Error(
      `Overlay context for view "${viewId}" requires the published alpha texture.`
    );
  }
  ctx.useAlphaTexture = renderParams.useAlphaTexture;
  ctx.alphaTexture = alphaTexture;
  ctx.alphaTexWidth = alphaTexWidth;

  ctx.fogNear = hpRenderer.getFogNear();
  ctx.fogFar = hpRenderer.getFogFar();
  if (!Number.isFinite(ctx.fogNear) || !Number.isFinite(ctx.fogFar)) {
    throw new TypeError('Overlay context fog bounds must be finite numbers.');
  }

  ctx.getViewPositions = getViewPositions;
  ctx.getViewTransparency = getViewTransparency;
  ctx._hpRenderer = hpRenderer;
  if (typeof ctx.getLodLevel !== 'function') {
    ctx.getLodLevel = () => ctx._hpRenderer.getCurrentLODLevel(ctx.viewId);
  }
  if (typeof ctx.getLodIndices !== 'function') {
    ctx.getLodIndices = () => (
      ctx._hpRenderer.getCurrentLodIndices(ctx.viewId, ctx.dimensionLevel)
    );
  }

  return ctx;
}
