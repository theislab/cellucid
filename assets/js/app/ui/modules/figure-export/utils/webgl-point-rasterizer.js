/**
 * @fileoverview WebGL2 point rasterizer for figure export.
 *
 * PURPOSE:
 * This module renders points into an offscreen WebGL2 canvas using the SAME
 * high-performance shader variants as the interactive viewer, ensuring that
 * exported figures have identical 3D sphere shading with lighting and fog.
 *
 * WHY THIS EXISTS:
 * - The interactive viewer renders points with GPU shaders (lighting/fog/point sprites).
 * - Pure SVG circles (or Canvas2D arcs) cannot reproduce the 3D "sphere" shader look.
 * - This helper ensures PNG and "hybrid SVG" exports stay WYSIWYG (What You See Is What You Get).
 *
 * SHADER QUALITY MATCHING:
 * The rasterizer respects the viewer's current shaderQuality setting:
 * - 'full': 3D sphere lighting, specular highlights, Beer-Lambert fog
 * - 'sculpted': soft studio-lit spheres with fog, opaque, edges antialiased
 *   as a multisample coverage mask when the export context multisamples
 * - 'light': Simplified lighting, circular point sprites
 * - 'ultralight': Flat shading, square points (fastest)
 *
 * MATRIX REQUIREMENTS:
 * The WebGL shaders require separate viewMatrix, projectionMatrix, and modelMatrix
 * (not just mvpMatrix) because lighting calculations need eye-space positions.
 * Missing render state is a contract error; export never changes fidelity.
 *
 * ANTIALIASING:
 * The viewer draws antialiased or not according to a live setting that also
 * follows the dataset's cell count. The export requests whatever is in force at
 * the moment of the export rather than a fixed `true` or a value read once at
 * startup; the viewer's own control measures the difference at 18% of pixels at
 * point size 0.75 and 32% with ultra-light square points.
 *
 * WHERE IT RUNS:
 * In the figure-export worker's handler (`figure-export-worker.js`), on
 * OffscreenCanvas WebGL2 contexts that thread owns. A pass returns its frame
 * as an ImageBitmap (`transferToImageBitmap`), which the page composites or
 * the worker encodes. The handler runs in the module worker wherever a worker
 * can create a WebGL2 context, so packing, upload and drawing never occupy
 * the page's main thread; where it cannot (WebKitGTK and WPE have no WebGL
 * in workers, https://bugs.webkit.org/show_bug.cgi?id=209809, nor did Safari
 * 16.4-16.6, or 17.0-17.1 on macOS Ventura,
 * https://bugs.webkit.org/show_bug.cgi?id=183720), the same
 * handler draws on the page (`figure-export-worker-client.js`,
 * `webgl2RasterAvailable`).
 *
 * ISOLATION:
 * This module is only invoked during export and does not touch the normal
 * render loop. It creates temporary WebGL resources and cleans them up.
 *
 * @module ui/modules/figure-export/utils/webgl-point-rasterizer
 */

import {
  configureStraightAlphaBlending,
  createProgram,
  deleteProgramReleasingUse,
  deleteTextureTracked,
  drawPointsInSegments,
} from '../../../../../rendering/gl-utils.js';
import {
  HP_VS_FULL,
  HP_FS_FULL,
  HP_FS_FULL_NO_DEPTH,
  HP_VS_LIGHT,
  HP_FS_LIGHT,
  HP_FS_LIGHT_NO_DEPTH,
  HP_FS_ULTRALIGHT,
  NO_DEPTH_MAX_DIMENSION,
  HIGHLIGHT_STYLES_BY_QUALITY,
  HP_VS_HIGHLIGHT,
  HP_FS_HIGHLIGHT,
  HP_FS_SCULPTED,
  HP_FS_SCULPTED_NO_DEPTH,
  highlightGlowAt,
  writePointShaderFrame,
} from '../../../../../rendering/shaders/high-perf-shaders.js';
import { writeFogUniforms } from '../../../../../rendering/shaders/fog-shaders.js';
import { enterOpaquePointBlending } from '../../../../../rendering/high-perf/gl-point-draw-state.js';
import { assertCropRect01 } from './crop.js';
import {
  describeShaderQualities,
  SHADER_QUALITY_TRAITS,
} from '../../../../../rendering/shader-quality.js';
import {
  assertDrawOrder,
  assertLodMembership,
  drawnSequence,
  MIN_VISIBLE_ALPHA_BYTE,
  POINT_VISIBILITY_THRESHOLD,
} from './lod-membership.js';
const DEFAULT_ALPHA_THRESHOLD = POINT_VISIBILITY_THRESHOLD;
const DEFAULT_HIGHLIGHT_COLOR = [0.4, 0.85, 1.0];


function highlightValueToAlphaByte(value) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(
      'Figure-export highlight values must be exact Uint8 intensities.'
    );
  }
  return value;
}

function buildHighlightOverlayBuffers({
  positions,
  dimension,
  highlightArray,
  transparency,
  lodMembership,
  drawOrder,
  alphaThreshold
}) {
  if (highlightArray === null) return null;
  const n = positions.length / dimension;
  const admittedIndices = drawnSequence(lodMembership, drawOrder);
  const candidateCount = admittedIndices?.length ?? n;

  let count = 0;
  for (
    let candidateIndex = 0;
    candidateIndex < candidateCount;
    candidateIndex++
  ) {
    const i = admittedIndices === null
      ? candidateIndex
      : admittedIndices[candidateIndex];
    const aByte = highlightValueToAlphaByte(highlightArray[i]);
    if (aByte < MIN_VISIBLE_ALPHA_BYTE) continue;
    const baseAlpha = transparency === null ? 1 : transparency[i];
    if (baseAlpha < alphaThreshold) continue;
    count++;
  }
  if (count <= 0) return null;

  const outPos = new Float32Array(count * dimension);
  const outCol = new Uint8Array(count * 4);

  let cursor = 0;
  for (
    let candidateIndex = 0;
    candidateIndex < candidateCount;
    candidateIndex++
  ) {
    const i = admittedIndices === null
      ? candidateIndex
      : admittedIndices[candidateIndex];
    const aByte = highlightValueToAlphaByte(highlightArray[i]);
    if (aByte < MIN_VISIBLE_ALPHA_BYTE) continue;
    const baseAlpha = transparency === null ? 1 : transparency[i];
    if (baseAlpha < alphaThreshold) continue;

    const pi = i * dimension;
    const oi = cursor * dimension;
    for (let axis = 0; axis < dimension; axis++) {
      outPos[oi + axis] = positions[pi + axis];
    }

    const cj = cursor * 4;
    outCol[cj] = 255;
    outCol[cj + 1] = 255;
    outCol[cj + 2] = 255;
    outCol[cj + 3] = aByte;

    cursor++;
  }

  return { positions: outPos, colors: outCol, count, dimension };
}

/**
 * @typedef {object} RenderStateForWebgl
 * @property {boolean} antialias
 * @property {Float32Array} mvpMatrix
 * @property {Float32Array} viewMatrix
 * @property {Float32Array} modelMatrix
 * @property {Float32Array} projectionMatrix
 * @property {number} viewportWidth
 * @property {number} viewportHeight
 * @property {number} fov
 * @property {number} pointSize
 * @property {number} sizeAttenuation
 * @property {number} [lightingStrength]
 * @property {number} [fogDensity]
 * @property {number} fogNear
 * @property {number} fogFar
 * @property {Float32Array|number[]} [fogColor]
 * @property {Float32Array|number[]} [lightDir]
 * @property {[number, number, number]} [cameraPosition]
 * @property {string} [shaderQuality]
 */

/**
 * The export's WebGL2 contexts, one per antialiasing setting, kept for the
 * worker's lifetime and reused by every raster pass. A pass is synchronous, so
 * no two passes ever share a context at once; after each one the canvas
 * shrinks to one pixel, so an export-sized buffer is not kept. Creating and
 * losing a context for every pass made WebKitGTK/WPE abort on a GL call with
 * no current context during the teardown, and costs a context creation and a
 * shader compile per pass everywhere.
 *
 * @type {Map<boolean, {canvas: OffscreenCanvas, gl: WebGL2RenderingContext}>}
 */
const rasterContexts = new Map();

/**
 * Put a reused context back into the state a new context starts in, for every
 * piece of state a pass relies on without setting (a pass that failed part
 * way may have left any of these behind).
 * @param {WebGL2RenderingContext} gl
 */
function resetRasterState(gl) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.useProgram(null);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  gl.colorMask(true, true, true, true);
  gl.depthMask(true);
  for (const unit of [gl.TEXTURE0, gl.TEXTURE1]) {
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }
  gl.activeTexture(gl.TEXTURE0);
}

/**
 * The raster canvas and context for one pass.
 * @param {boolean} antialias
 * @returns {{canvas: OffscreenCanvas, gl: WebGL2RenderingContext}}
 */
function acquireRasterContext(antialias) {
  const existing = rasterContexts.get(antialias);
  if (existing !== undefined && !existing.gl.isContextLost()) {
    resetRasterState(existing.gl);
    return existing;
  }
  if (typeof OffscreenCanvas !== 'function') {
    throw new Error(
      'Figure-export WebGL2 rasterization requires OffscreenCanvas.'
    );
  }
  // A minimal drawing buffer first, so hardware limits can be checked before
  // the requested export allocation is attempted.
  const canvas = new OffscreenCanvas(1, 1);
  const gl = getWebgl2Context(canvas, antialias);
  const entry = { canvas, gl };
  rasterContexts.set(antialias, entry);
  return entry;
}

/**
 * @param {OffscreenCanvas} canvas
 * @param {boolean} antialias - the multisampling the viewer's buffer has
 * @returns {WebGL2RenderingContext}
 */
function getWebgl2Context(canvas, antialias) {
  let gl;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: true,
      // Multisampling is a property of the drawing buffer the user is looking
      // at, not an export preference. The viewer's antialiasing control
      // measures the difference at 18% of pixels at point size 0.75 and
      // 32% with ultra-light square points, so requesting a fixed `true` here
      // would publish a smoother cloud than the screen ever drew.
      antialias,
      // Source-over blending stores premultiplied RGB in transparent pixels.
      // Publish that exact ownership to canvas compositing and PNG encoding;
      // declaring the buffer unpremultiplied would apply alpha a second time.
      premultipliedAlpha: true,
      // The frame leaves by `transferToImageBitmap`, which resolves and hands
      // over the drawing buffer; nothing reads it afterwards.
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    });
  } catch (error) {
    throw new Error(
      `Figure-export WebGL2 context creation failed: ${error.message}`,
      { cause: error }
    );
  }
  if (!gl) {
    throw new Error('Figure export requires WebGL2 rasterization support.');
  }
  return gl;
}

/**
 * Whether this thread can draw an export: an OffscreenCanvas with a WebGL2
 * context. Measured once by the figure-export worker client, which draws on
 * the page where a worker cannot.
 *
 * @returns {boolean}
 */
export function webgl2RasterAvailable() {
  try {
    acquireRasterContext(false);
    return true;
  } catch {
    return false;
  }
}

/** Shrink a raster canvas after its pass: an export-sized buffer is not kept. */
function shrinkRasterCanvas(canvas) {
  canvas.width = 1;
  canvas.height = 1;
}

// Viewer sprites are clamped at this many pixels (HP_VS_*: u_pointSizeMax
// is never below it).
const VIEWER_POINT_SIZE_MAX = 128;

let spriteZoomLimit = null;

/**
 * The largest raster scale (export pixels per viewer pixel) at which every
 * sprite the viewer can draw still fits this GPU's point-size range
 * (`ALIASED_POINT_SIZE_RANGE`): a 128-pixel viewer sprite drawn larger than
 * the driver allows would be clamped smaller than the view it reproduces.
 * Read once, from the export context of the thread that draws.
 *
 * @returns {number}
 */
export function exportSpriteZoomLimit() {
  if (spriteZoomLimit !== null) return spriteZoomLimit;
  const { gl } = acquireRasterContext(false);
  const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
  const driverMax = Array.isArray(range) || ArrayBuffer.isView(range)
    ? Number(range[1])
    : Number.NaN;
  spriteZoomLimit = Number.isFinite(driverMax) && driverMax > 0
    ? Math.max(1, driverMax / VIEWER_POINT_SIZE_MAX)
    : 1;
  return spriteZoomLimit;
}

/**
 * Column-major clip-space transform that maps the viewport sub-rectangle
 * `rect01` (normalized, top-left origin) onto the whole clip square.
 *
 * @param {{x: number, y: number, width: number, height: number}} rect01
 * @returns {Float32Array}
 */
export function viewRectClipTransform(rect01) {
  const sx = 1 / rect01.width;
  const sy = 1 / rect01.height;
  const centerX = 2 * (rect01.x + rect01.width / 2) - 1;
  const centerY = 1 - 2 * (rect01.y + rect01.height / 2);
  const out = new Float32Array(16);
  out[0] = sx;
  out[5] = sy;
  out[10] = 1;
  out[15] = 1;
  out[12] = -centerX * sx;
  out[13] = -centerY * sy;
  return out;
}

function multiplyMat4(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

function configureExactDrawingBuffer(gl, canvas, width, height) {
  const viewportDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  const maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
  if (
    !(viewportDims instanceof Int32Array) ||
    viewportDims.length < 2 ||
    !Number.isSafeInteger(maxRenderbufferSize) ||
    maxRenderbufferSize <= 0
  ) {
    throw new Error(
      'Figure-export WebGL2 hardware limits are unavailable.'
    );
  }
  const maxWidth = Math.min(viewportDims[0], maxRenderbufferSize);
  const maxHeight = Math.min(viewportDims[1], maxRenderbufferSize);
  if (width > maxWidth || height > maxHeight) {
    throw new RangeError(
      `Figure export ${width}×${height} exceeds this GPU's exact ` +
      `${maxWidth}×${maxHeight} raster limit.`
    );
  }
  canvas.width = width;
  canvas.height = height;
  if (
    gl.drawingBufferWidth !== width ||
    gl.drawingBufferHeight !== height
  ) {
    throw new RangeError(
      `Figure export could not allocate the exact ${width}×${height} ` +
      'WebGL2 drawing buffer.'
    );
  }
}

/**
 * The program the viewer draws this quality with at this dimension: a 1-D or
 * 2-D pass draws without depth and with the quality's no-depth fragment
 * shader (`NO_DEPTH_MAX_DIMENSION`), exactly as HighPerfRenderer does.
 */
function pickShaderSources(shaderQuality, dimension) {
  const depth = dimension > NO_DEPTH_MAX_DIMENSION;
  if (shaderQuality === 'ultralight') {
    return { vs: HP_VS_LIGHT, fs: HP_FS_ULTRALIGHT, quality: 'ultralight', depth };
  }
  if (shaderQuality === 'light') {
    return {
      vs: HP_VS_LIGHT,
      fs: depth ? HP_FS_LIGHT : HP_FS_LIGHT_NO_DEPTH,
      quality: 'light',
      depth,
    };
  }
  if (shaderQuality === 'full') {
    return {
      vs: HP_VS_FULL,
      fs: depth ? HP_FS_FULL : HP_FS_FULL_NO_DEPTH,
      quality: 'full',
      depth,
    };
  }
  if (shaderQuality === 'sculpted') {
    return {
      vs: HP_VS_FULL,
      fs: depth ? HP_FS_SCULPTED : HP_FS_SCULPTED_NO_DEPTH,
      quality: 'sculpted',
      depth,
    };
  }
  throw new RangeError(
    `Figure-export shaderQuality must be ${describeShaderQualities()}.`
  );
}

/**
 * Pack colors into a new Uint8Array so we can:
 * - inject transparency into alpha channel (viewer often keeps alpha separate)
 * - optionally apply selection emphasis (mute non-selected)
 * - compact an active LOD membership before GPU upload/draw
 *
 * Fog is owned by the exact presented render state. Recomputing it here would
 * add a redundant O(N) scan for every pane, format, and DPI and can disagree
 * with snapshot bounds used by the interactive renderer.
 *
 * @param {object} options
 * @param {Float32Array} options.positions - `dimension` values per point
 * @param {1|2|3} options.dimension - Components per position; the packed
 *   positions keep it, and the shader's vec3 input receives 0 for the rest.
 * @param {Uint8Array} options.colors
 * @param {Uint8Array|null} options.transparency
 * @param {import('./lod-membership.js').LodMembership|null} [options.lodMembership]
 * @param {Uint32Array|null} [options.drawOrder] - The pane's full-detail draw
 *   order (`drawnSequence`); null draws in source order.
 * @param {Uint8Array|Float32Array|null} options.highlightArray
 * @param {boolean} options.emphasizeSelection
 * @param {number} options.selectionMutedOpacity
 * @param {number} [options.alphaThreshold]
 * @returns {{ positions: Float32Array; colors: Uint8Array; count: number; dimension: number }}
 */
function packBuffers({
  positions,
  dimension,
  colors,
  transparency,
  lodMembership,
  drawOrder,
  highlightArray,
  emphasizeSelection,
  selectionMutedOpacity,
  alphaThreshold,
}) {
  const n = positions.length / dimension;
  const admittedIndices = drawnSequence(lodMembership, drawOrder);
  const admittedCount = admittedIndices?.length ?? n;

  const outPositions = admittedIndices === null
    ? positions
    : new Float32Array(admittedCount * dimension);
  const outColors = new Uint8Array(admittedCount * 4);

  const mutedAlpha = selectionMutedOpacity;
  let cursor = 0;

  for (
    let candidateIndex = 0;
    candidateIndex < admittedCount;
    candidateIndex++
  ) {
    const i = admittedIndices === null
      ? candidateIndex
      : admittedIndices[candidateIndex];
    const pi = i * dimension;

    const ci = i * 4;
    const outPi = cursor * dimension;
    const outCi = cursor * 4;
    let r = colors[ci];
    let g = colors[ci + 1];
    let b = colors[ci + 2];

    const baseAlpha = transparency === null
      ? colors[ci + 3] / 255
      : transparency[i];
    let a = baseAlpha;

    if (admittedIndices !== null) {
      for (let axis = 0; axis < dimension; axis++) {
        outPositions[outPi + axis] = positions[pi + axis];
      }
    }

    if (
      emphasizeSelection &&
      highlightArray !== null &&
      highlightArray[i] < MIN_VISIBLE_ALPHA_BYTE
    ) {
      r = 160;
      g = 160;
      b = 160;
      a *= mutedAlpha;
    }

    if (a < alphaThreshold) a = 0;
    const ao = Math.round(a * 255);

    outColors[outCi] = r;
    outColors[outCi + 1] = g;
    outColors[outCi + 2] = b;
    outColors[outCi + 3] = ao;
    cursor++;
  }

  return {
    positions: outPositions,
    colors: outColors,
    count: admittedCount,
    dimension
  };
}

/**
 * Render a point cloud into a WebGL2 canvas using viewer shader variants.
 *
 * @param {object} options
 * @param {Float32Array|null} options.positions - `dimension` values per point
 * @param {1|2|3} options.dimension - The view's dimension level
 * @param {Uint8Array|null} options.colors
 * @param {Uint8Array|null} [options.transparency]
 * @param {import('./lod-membership.js').LodMembership|null} [options.lodMembership]
 * @param {Uint32Array|null} [options.drawOrder] - The pane's full-detail draw
 *   order (`drawnSequence`); null draws in source order.
 * @param {RenderStateForWebgl|null} options.renderState
 * @param {number} options.outputWidthPx - target canvas width (pixels)
 * @param {number} options.outputHeightPx - target canvas height (pixels)
 * @param {number} options.pointSizePx - diameter in output pixels
 * @param {{ positions: Float32Array|null; colors: Uint8Array|null; transparency?: Uint8Array|null; lodMembership?: import('./lod-membership.js').LodMembership|null; pointSizePx: number; alphaThreshold?: number } | null} [options.overlayPoints]
 * @param {Uint8Array|Float32Array|null} [options.highlightArray]
 * @param {boolean} [options.emphasizeSelection=false]
 * @param {number} [options.selectionMutedOpacity=0.15]
 * @param {number} [options.alphaThreshold=0.01]
 * @param {{x: number, y: number, width: number, height: number}|null} [options.viewRect01]
 *   A sub-rectangle of the viewport (normalized, top-left origin) to draw
 *   over the whole output, at the output's resolution -- a cropped figure
 *   drawn at its own pixels rather than a magnified part of the whole view.
 *   The caller sizes the output to the rectangle's aspect and scales point
 *   sizes by the same zoom. Null draws the whole viewport, letterboxed.
 * @returns {ImageBitmap} The frame, `outputWidthPx` × `outputHeightPx`, with
 *   premultiplied alpha; the caller owns it and closes it.
 */
/**
 * The largest sprite this export may ask the shader to draw.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {number} rasterScale - export pixels per source viewport pixel.
 * @returns {number}
 */
function exportPointSizeMax(gl, rasterScale) {
  const scaled = VIEWER_POINT_SIZE_MAX * Math.max(1, rasterScale);
  const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
  const driverMax = Array.isArray(range) || ArrayBuffer.isView(range)
    ? Number(range[1])
    : Number.NaN;
  if (!Number.isFinite(driverMax) || driverMax <= 0) return scaled;
  return Math.min(scaled, driverMax);
}

export function rasterizePointsWebgl({
  positions,
  dimension,
  colors,
  transparency = null,
  lodMembership = null,
  drawOrder = null,
  renderState,
  outputWidthPx,
  outputHeightPx,
  pointSizePx,
  overlayPoints = null,
  highlightArray = null,
  emphasizeSelection = false,
  selectionMutedOpacity = 0.15,
  alphaThreshold = DEFAULT_ALPHA_THRESHOLD,
  viewRect01 = null,
}) {
  const viewRect = viewRect01 === null
    ? null
    : assertCropRect01({ enabled: true, ...viewRect01 });
  if (!renderState || typeof renderState !== 'object') {
    throw new TypeError('Figure-export renderState is required.');
  }
  if (dimension !== 1 && dimension !== 2 && dimension !== 3) {
    throw new RangeError(
      'Figure-export position dimension must be exactly 1, 2, or 3.'
    );
  }
  if (
    !(positions instanceof Float32Array) ||
    positions.length % dimension !== 0
  ) {
    throw new TypeError(
      'Figure-export positions must be a Float32Array with dimension values per point.'
    );
  }
  const pointCount = positions.length / dimension;
  assertLodMembership(lodMembership, { pointCount });
  assertDrawOrder(drawOrder, { pointCount });
  if (!(colors instanceof Uint8Array) || colors.length !== pointCount * 4) {
    throw new TypeError(
      'Figure-export colors must be a Uint8Array with exactly four values per point.'
    );
  }
  if (
    transparency !== null &&
    (!(transparency instanceof Uint8Array) || transparency.length !== pointCount)
  ) {
    throw new TypeError(
      'Figure-export transparency must be null or one Uint8 value per point.'
    );
  }
  if (
    highlightArray !== null &&
    (!(highlightArray instanceof Uint8Array) || highlightArray.length !== pointCount)
  ) {
    throw new TypeError(
      'Figure-export highlightArray must be null or one Uint8 value per point.'
    );
  }
  for (const key of ['mvpMatrix', 'viewMatrix', 'modelMatrix', 'projectionMatrix']) {
    if (
      !(renderState[key] instanceof Float32Array) ||
      renderState[key].length !== 16
    ) {
      throw new TypeError(
        `Figure-export renderState.${key} must be a 16-value Float32Array.`
      );
    }
  }
  for (const key of [
    'fov',
    'pointSize',
    'sizeAttenuation',
    'lightingStrength',
    'fogDensity',
    'fogNear',
    'fogFar'
  ]) {
    if (!Number.isFinite(renderState[key])) {
      throw new TypeError(
        `Figure-export renderState.${key} must be a finite number.`
      );
    }
  }
  if (typeof renderState.antialias !== 'boolean') {
    throw new TypeError(
      'Figure-export renderState.antialias must be an exact boolean.'
    );
  }
  if (
    renderState.fogNear < 0 ||
    renderState.fogFar < renderState.fogNear
  ) {
    throw new RangeError(
      'Figure-export renderState fog range must satisfy 0 <= fogNear <= fogFar.'
    );
  }
  for (const key of ['viewportWidth', 'viewportHeight']) {
    if (!Number.isInteger(renderState[key]) || renderState[key] <= 0) {
      throw new RangeError(
        `Figure-export renderState.${key} must be a positive integer.`
      );
    }
  }
  for (const key of ['fogColor', 'lightDir', 'cameraPosition']) {
    const value = renderState[key];
    if (
      !(Array.isArray(value) || value instanceof Float32Array) ||
      value.length !== 3 ||
      Array.from(value).some((entry) => !Number.isFinite(entry))
    ) {
      throw new TypeError(
        `Figure-export renderState.${key} must contain exactly three finite numbers.`
      );
    }
  }
  pickShaderSources(renderState.shaderQuality, dimension);
  for (const [name, value] of [
    ['outputWidthPx', outputWidthPx],
    ['outputHeightPx', outputHeightPx]
  ]) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`Figure-export ${name} must be a positive integer.`);
    }
  }
  if (!Number.isFinite(pointSizePx) || pointSizePx <= 0) {
    throw new RangeError('Figure-export pointSizePx must be a finite positive number.');
  }
  if (typeof emphasizeSelection !== 'boolean') {
    throw new TypeError('Figure-export emphasizeSelection must be a boolean.');
  }
  if (
    !Number.isFinite(selectionMutedOpacity) ||
    selectionMutedOpacity < 0 ||
    selectionMutedOpacity > 1
  ) {
    throw new RangeError(
      'Figure-export selectionMutedOpacity must be between 0 and 1.'
    );
  }
  if (!Number.isFinite(alphaThreshold) || alphaThreshold < 0 || alphaThreshold > 1) {
    throw new RangeError('Figure-export alphaThreshold must be between 0 and 1.');
  }

  const packed = packBuffers({
    positions,
    dimension,
    colors,
    transparency,
    lodMembership,
    drawOrder,
    highlightArray,
    emphasizeSelection,
    selectionMutedOpacity,
    alphaThreshold
  });
  const outW = outputWidthPx;
  const outH = outputHeightPx;
  const { canvas, gl } = acquireRasterContext(renderState.antialias);
  try {
    configureExactDrawingBuffer(gl, canvas, outW, outH);
  } catch (error) {
    shrinkRasterCanvas(canvas);
    throw error;
  }

  const { vs, fs, quality, depth } = pickShaderSources(
    renderState.shaderQuality,
    dimension
  );

  /** @type {WebGLProgram|null} */
  let program = null;
  /** @type {WebGLProgram|null} */
  let highlightProgram = null;
  /** @type {WebGLBuffer|null} */
  let positionBuffer = null;
  /** @type {WebGLBuffer|null} */
  let colorBuffer = null;
  /** @type {WebGLBuffer|null} */
  let highlightPosBuffer = null;
  /** @type {WebGLBuffer|null} */
  let highlightColorBuffer = null;
  /** @type {WebGLBuffer|null} */
  let overlayPosBuffer = null;
  /** @type {WebGLBuffer|null} */
  let overlayColorBuffer = null;
  /** @type {WebGLTexture|null} */
  let dummyAlphaTex = null;
  /** @type {WebGLTexture|null} */
  let dummyLodIndexTex = null;
  /** @type {Error|null} */
  let rasterizationError = null;

  try {
    program = createProgram(gl, vs, fs);
    gl.useProgram(program);

    // GL state matches HighPerfRenderer: depth for a 3-D pass, none for a
    // 1-D or 2-D one.
    if (depth) {
      gl.enable(gl.DEPTH_TEST);
    } else {
      gl.disable(gl.DEPTH_TEST);
    }
    gl.depthFunc(gl.LEQUAL);
    configureStraightAlphaBlending(gl);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const srcViewportW = renderState.viewportWidth;
    const srcViewportH = renderState.viewportHeight;

    // Export pixels per viewer pixel, and the projection that draws them.
    let s;
    let mvpMatrix = renderState.mvpMatrix;
    let projectionMatrix = renderState.projectionMatrix;
    if (viewRect === null) {
      // Letterbox the on-screen viewport into the export canvas (preserves projection/aspect).
      s = Math.min(outW / srcViewportW, outH / srcViewportH);
      const vpW = Math.max(1, Math.round(srcViewportW * s));
      const vpH = Math.max(1, Math.round(srcViewportH * s));
      const vpX = Math.floor((outW - vpW) / 2);
      const vpY = Math.floor((outH - vpH) / 2);
      gl.viewport(vpX, vpY, vpW, vpH);
    } else {
      // The sub-rectangle fills the canvas: the projection is zoomed onto it
      // in clip space, so every point is placed and drawn at this raster's
      // own resolution.
      s = Math.min(
        outW / (viewRect.width * srcViewportW),
        outH / (viewRect.height * srcViewportH)
      );
      const zoom = viewRectClipTransform(viewRect);
      mvpMatrix = multiplyMat4(zoom, renderState.mvpMatrix);
      projectionMatrix = multiplyMat4(zoom, renderState.projectionMatrix);
      gl.viewport(0, 0, outW, outH);
    }

    // Buffers (separate position + color to keep packing simple).
    positionBuffer = gl.createBuffer();
    colorBuffer = gl.createBuffer();
    if (!positionBuffer || !colorBuffer) {
      throw new Error('Figure-export point-buffer allocation failed.');
    }

    const packedPositions = packed.positions.subarray(
      0,
      packed.count * packed.dimension
    );

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, packedPositions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, packed.dimension, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, packed.colors, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    // Uniform helpers.
    const u = (name) => gl.getUniformLocation(program, name);
    const setMat4 = (loc, mat) => { if (loc) gl.uniformMatrix4fv(loc, false, mat); };
    const setF1 = (loc, v) => { if (loc) gl.uniform1f(loc, v); };
    const setI1 = (loc, v) => { if (loc) gl.uniform1i(loc, v); };
    const setV3 = (loc, v) => { if (loc && v) gl.uniform3fv(loc, v); };

    const fov = renderState.fov;
    const sizeAttenuation = renderState.sizeAttenuation;
    const pointSize = pointSizePx;
    // IMPORTANT: The point scale is derived from the SOURCE viewport height.
    //
    // We letterbox the source viewport into a differently-sized export canvas by
    // changing gl.viewport(). To produce a *scaled copy* of what the user sees
    // (WYSIWYG), we scale u_pointSize at the callsite and keep the projection
    // factor consistent with the interactive viewer's original one.
    const shaderFrame = {
      modelView: new Float32Array(16),
      halfDir: new Float32Array(3),
    };
    const pointScale = writePointShaderFrame(
      shaderFrame,
      renderState.viewMatrix,
      renderState.modelMatrix,
      renderState.lightDir,
      srcViewportH,
      fov
    );

    setMat4(u('u_mvpMatrix'), mvpMatrix);
    setMat4(u('u_modelViewMatrix'), shaderFrame.modelView);
    setMat4(u('u_projectionMatrix'), projectionMatrix);

    setF1(u('u_pointSize'), pointSize);
    // The shader caps a sprite at 128 pixels of whatever it is drawing into.
    // This raster is `s` times the screen, so a point that the viewer clamps at
    // 128 must clamp at 128 * s here, or it would occupy a smaller fraction of
    // the exported image than of the view it reproduces. Reachable in an
    // ordinary 3D close-up: with attenuation the size grows as 1/eyeDepth.
    //
    // The driver's own maximum bounds it, because asking for a larger sprite
    // than ALIASED_POINT_SIZE_RANGE allows is undefined rather than clamped.
    setF1(u('u_pointSizeMax'), exportPointSizeMax(gl, s));
    setF1(u('u_sizeAttenuation'), sizeAttenuation);
    setF1(u('u_pointScale'), pointScale);

    // Disable alpha texture paths for export; alpha is baked into vertex colors.
    // IMPORTANT: Even when disabled, we must bind dummy textures to avoid WebGL errors.
    // The shader uses sampler2DArray (float) for u_alphaTex and usampler2DArray (uint)
    // for u_lodIndexTex. If both samplers default to texture unit 0, WebGL throws:
    // "Two textures of different types use the same sampler location"
    setI1(u('u_useAlphaTex'), 0);
    setI1(u('u_useLodIndexTex'), 0);

    // Create and bind dummy textures to separate texture units to prevent type conflicts.
    // IMPORTANT: Configure filters/wraps so textures are "complete" (no mipmaps required),
    // otherwise some browsers will fail the draw even if the texture path is disabled.
    //
    // Unit 0: dummy normalized texture for u_alphaTex (sampler2DArray)
    dummyAlphaTex = gl.createTexture();
    if (!dummyAlphaTex) {
      throw new Error('Figure-export dummy alpha-texture allocation failed.');
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, dummyAlphaTex);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, 1, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
    const alphaTexLoc = u('u_alphaTex');
    if (alphaTexLoc) gl.uniform1i(alphaTexLoc, 0);

    // Unit 1: dummy integer texture for u_lodIndexTex (usampler2DArray)
    dummyLodIndexTex = gl.createTexture();
    if (!dummyLodIndexTex) {
      throw new Error('Figure-export dummy LOD-texture allocation failed.');
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, dummyLodIndexTex);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R32UI, 1, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, new Uint32Array([0]));
    const lodIndexTexLoc = u('u_lodIndexTex');
    if (lodIndexTexLoc) gl.uniform1i(lodIndexTexLoc, 1);

    const fogNear = renderState.fogNear;
    const fogFar = renderState.fogFar;
    const fogDensity = renderState.fogDensity;
    const lightingStrength = renderState.lightingStrength;
    const lightDir = renderState.lightDir;

    if (SHADER_QUALITY_TRAITS[quality].sphere) {
      setF1(u('u_lightingStrength'), lightingStrength);
      writeFogUniforms(gl, u('u_fogNear'), u('u_fogScale'), fogDensity, fogNear, fogFar);
      setV3(u('u_lightDir'), lightDir);
      setV3(u('u_halfDir'), shaderFrame.halfDir);
      setF1(u('u_invCenterShade'), shaderFrame.invCenterShade);
      // Only an opaque (sculpted) point mixes toward the fog colour, which a
      // figure sets to its paper.
      setV3(u('u_fogColor'), renderState.fogColor);
    }

    // An opaque program's depth pass draws without blending and, where the
    // export context multisamples, turns its edge coverage into a sample mask,
    // exactly as HighPerfRenderer does (`enterOpaquePointBlending`).
    const opaquePass = quality === 'sculpted' && depth;
    if (opaquePass) {
      const multisampled = gl.getParameter(gl.SAMPLES) > 0;
      enterOpaquePointBlending(gl, multisampled);
      setF1(u('u_coverageFloor'), multisampled ? 0 : 0.5);
    }

    drawPointsInSegments(gl, 0, packed.count);

    // Optional overlay pass (e.g., centroid points rendered larger on top).
    if (overlayPoints !== null) {
      if (!overlayPoints || typeof overlayPoints !== 'object') {
        throw new TypeError('Figure-export overlayPoints must be null or an object.');
      }
      const overlayCount = overlayPoints.positions?.length / 3;
      if (
        !(overlayPoints.positions instanceof Float32Array) ||
        overlayPoints.positions.length === 0 ||
        overlayPoints.positions.length % 3 !== 0 ||
        !(overlayPoints.colors instanceof Uint8Array) ||
        overlayPoints.colors.length !== overlayCount * 4
      ) {
        throw new TypeError(
          'Figure-export overlayPoints require exact Float32 XYZ and Uint8 RGBA arrays.'
        );
      }
      if (!Number.isFinite(overlayPoints.pointSizePx) || overlayPoints.pointSizePx <= 0) {
        throw new RangeError(
          'Figure-export overlayPoints.pointSizePx must be a finite positive number.'
        );
      }
      const overlayLodMembership = overlayPoints.lodMembership ?? null;
      assertLodMembership(overlayLodMembership, { pointCount: overlayCount });
      // Overlay points (centroids) are XYZ triples.
      const overlayPacked = packBuffers({
        positions: overlayPoints.positions,
        dimension: 3,
        colors: overlayPoints.colors,
        transparency: overlayPoints.transparency ?? null,
        lodMembership: overlayLodMembership,
        highlightArray: null,
        emphasizeSelection: false,
        selectionMutedOpacity: 1.0,
        alphaThreshold: overlayPoints.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD,
      });
      if (overlayPacked.count > 0) {
        overlayPosBuffer = gl.createBuffer();
        overlayColorBuffer = gl.createBuffer();
        if (!overlayPosBuffer || !overlayColorBuffer) {
          throw new Error('Figure-export overlay-buffer allocation failed.');
        }
        const overlayPositions = overlayPacked.positions.subarray(0, overlayPacked.count * 3);
        gl.bindBuffer(gl.ARRAY_BUFFER, overlayPosBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, overlayPositions, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, overlayColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, overlayPacked.colors, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);

        setF1(u('u_pointSize'), overlayPoints.pointSizePx);
        setF1(u('u_pointSizeMax'), exportPointSizeMax(gl, s));
        drawPointsInSegments(gl, 0, overlayPacked.count);
      }
    }

    if (opaquePass) {
      gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      configureStraightAlphaBlending(gl);
    }

    // Optional highlight overlay (selection rings / continuous highlights).
    // Matches viewer behavior: depth test ON, but depth writes OFF so highlights appear on top.
    const highlightOverlay = buildHighlightOverlayBuffers({
      positions,
      dimension,
      highlightArray,
      transparency,
      lodMembership,
      drawOrder,
      alphaThreshold
    });
    if (highlightOverlay?.count) {
      highlightProgram = createProgram(gl, HP_VS_HIGHLIGHT, HP_FS_HIGHLIGHT);
      gl.useProgram(highlightProgram);

      highlightPosBuffer = gl.createBuffer();
      highlightColorBuffer = gl.createBuffer();
      if (!highlightPosBuffer || !highlightColorBuffer) {
        throw new Error('Figure-export highlight-buffer allocation failed.');
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, highlightPosBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, highlightOverlay.positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(
        0,
        highlightOverlay.dimension,
        gl.FLOAT,
        false,
        0,
        0
      );

      gl.bindBuffer(gl.ARRAY_BUFFER, highlightColorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, highlightOverlay.colors, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);

      const hu = (name) => gl.getUniformLocation(highlightProgram, name);
      const setHMat4 = (loc, mat) => { if (loc) gl.uniformMatrix4fv(loc, false, mat); };
      const setHF1 = (loc, v) => { if (loc) gl.uniform1f(loc, v); };
      const setHV3 = (loc, v) => { if (loc && v) gl.uniform3fv(loc, v); };

      setHMat4(hu('u_modelViewMatrix'), shaderFrame.modelView);
      setHMat4(hu('u_projectionMatrix'), projectionMatrix);

      setHF1(hu('u_pointSize'), pointSize);
      setHF1(hu('u_pointSizeMax'), exportPointSizeMax(gl, s));
      setHF1(hu('u_sizeAttenuation'), sizeAttenuation);
      setHF1(hu('u_pointScale'), pointScale);

      const style = HIGHLIGHT_STYLES_BY_QUALITY[quality];
      setHF1(hu('u_highlightScale'), style.scale);
      setHV3(hu('u_highlightColor'), DEFAULT_HIGHLIGHT_COLOR);
      setHF1(hu('u_ringWidth'), style.ringWidth);
      setHF1(hu('u_haloStrength'), style.haloStrength);
      setHF1(hu('u_haloShape'), style.haloShape);
      setHF1(hu('u_ringStyle'), style.ringStyle);
      setHF1(hu('u_time'), 0.0);
      setHF1(hu('u_glow'), highlightGlowAt(0.0));

      writeFogUniforms(gl, hu('u_fogNear'), hu('u_fogScale'), fogDensity, fogNear, fogFar);
      setHF1(hu('u_lightingStrength'), lightingStrength);
      setHV3(hu('u_lightDir'), lightDir);
      setHV3(hu('u_halfDir'), shaderFrame.halfDir);

      gl.enable(gl.DEPTH_TEST);
      configureStraightAlphaBlending(gl);
      try {
        gl.depthMask(false);
        drawPointsInSegments(gl, 0, highlightOverlay.count);
      } finally {
        gl.depthMask(true);
      }
    }

    gl.flush();
  } catch (error) {
    rasterizationError = new Error(
      `Figure-export WebGL2 point rasterization failed: ${error.message}`,
      { cause: error }
    );
  }

  // Clean up every allocated GPU object and report all cleanup failures.
  /** @type {Error[]} */
  const cleanupErrors = [];
  const cleanup = (operation, fn) => {
    try {
      fn();
    } catch (error) {
      cleanupErrors.push(new Error(
        `Figure-export WebGL2 cleanup failed during ${operation}: ${error.message}`,
        { cause: error }
      ));
    }
  };
  cleanup('array-buffer unbind', () => gl.bindBuffer(gl.ARRAY_BUFFER, null));
  if (positionBuffer) cleanup('position-buffer deletion', () => gl.deleteBuffer(positionBuffer));
  if (colorBuffer) cleanup('color-buffer deletion', () => gl.deleteBuffer(colorBuffer));
  if (overlayPosBuffer) cleanup('overlay-position-buffer deletion', () => gl.deleteBuffer(overlayPosBuffer));
  if (overlayColorBuffer) cleanup('overlay-color-buffer deletion', () => gl.deleteBuffer(overlayColorBuffer));
  if (highlightPosBuffer) cleanup('highlight-position-buffer deletion', () => gl.deleteBuffer(highlightPosBuffer));
  if (highlightColorBuffer) cleanup('highlight-color-buffer deletion', () => gl.deleteBuffer(highlightColorBuffer));
  if (dummyAlphaTex) cleanup('alpha-texture deletion', () => deleteTextureTracked(gl, dummyAlphaTex));
  if (dummyLodIndexTex) cleanup('LOD-index-texture deletion', () => deleteTextureTracked(gl, dummyLodIndexTex));
  if (highlightProgram) cleanup('highlight-program deletion', () => deleteProgramReleasingUse(gl, highlightProgram));
  if (program) cleanup('point-program deletion', () => deleteProgramReleasingUse(gl, program));

  const failures = [
    ...(rasterizationError ? [rasterizationError] : []),
    ...cleanupErrors,
  ];
  let frame = null;
  if (failures.length === 0) {
    try {
      // Resolves multisampling and hands the drawing buffer over: the frame
      // is not copied, and the canvas starts its next pass empty.
      frame = canvas.transferToImageBitmap();
    } catch (error) {
      failures.push(new Error(
        `Figure-export WebGL2 frame transfer failed: ${error.message}`,
        { cause: error }
      ));
    }
  }
  shrinkRasterCanvas(canvas);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'Figure-export WebGL2 rasterization and cleanup failed.'
    );
  }
  return frame;
}
