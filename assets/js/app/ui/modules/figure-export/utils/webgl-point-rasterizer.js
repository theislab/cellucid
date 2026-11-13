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
 * startup: the difference between the two is a sizeable share of an image's
 * pixels (measured: 36_decisions_figure_export.md).
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
  HIGHLIGHT_COLOR,
  HIGHLIGHT_RING_COLOR,
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
import { PointStore, SegmentedVertexArray } from '../../../../../rendering/high-perf/point-store-segments.js';
import { assertNormalizedRect01 } from './crop.js';
import { POINT_SPRITE_MAX_PX, gpuPointSizeMax } from '../../../../../rendering/point-sprite.js';
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
  requireFigurePointLayers,
} from './lod-membership.js';
import { allocateLargeArray } from '../../../../../utils/large-arrays.js';
import { BENEATH_ALPHA_BYTE, UNREAD_ALPHA_BYTE, requireColorAlphaMeaning } from '../../../../../rendering/alpha-visibility.js';
import { isUnplacedCell, positionsForGpu } from '../../../../../rendering/unplaced-positions.js';

/** @typedef {import('./lod-membership.js').FigurePointLayers} FigurePointLayers */
const DEFAULT_ALPHA_THRESHOLD = POINT_VISIBILITY_THRESHOLD;


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
    // Not placed by the embedding (NaN positions): no ring.
    if (isUnplacedCell(positions, dimension, i)) continue;
    count++;
  }
  if (count <= 0) return null;

  const outPos = allocateLargeArray(Float32Array, count * dimension);
  const outCol = allocateLargeArray(Uint8Array, count * 4);

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
    // Not placed by the embedding (NaN positions): no ring.
    if (isUnplacedCell(positions, dimension, i)) continue;

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
 * @property {number} pointSizeMax - the cap the viewer drew the pane with (rendering/point-sprite.js)
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
 * One pass's points on the GPU as the viewer holds them: segmented position
 * and color stores (`rendering/high-perf/point-store-segments.js`), one
 * buffer a segment, drawn through one vertex array a segment, so no single
 * buffer limits how many points a figure draws. Returns what to draw and
 * delete.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {Float32Array} positions - `count * dimension` floats.
 * @param {number} dimension
 * @param {Uint8Array} colors - `count * 4` bytes.
 * @param {number} count
 * @param {string} label
 * @returns {{positions: PointStore, colors: PointStore, arrays: SegmentedVertexArray}}
 */
function uploadPointPass(gl, positions, dimension, colors, count, label) {
  const pass = {
    positions: new PointStore(gl),
    colors: new PointStore(gl),
    arrays: new SegmentedVertexArray(gl),
  };
  // A store the GPU refuses fails the export by name, never draws nothing.
  const allocate = (refusal, run) => {
    run();
    const code = gl.getError();
    if (code !== gl.NO_ERROR) throw new RangeError(`${refusal} (WebGL error 0x${code.toString(16)}).`);
  };
  pass.positions.allocate(count, dimension * 4, gl.STATIC_DRAW, allocate, `${label} positions`, positions.subarray(0, count * dimension));
  pass.colors.allocate(count, 4, gl.STATIC_DRAW, allocate, `${label} colors`, colors.subarray(0, count * 4));
  pass.arrays.setStores(pass.positions, pass.colors, dimension);
  return pass;
}

/**
 * Draw every point of a pass, one draw a segment in order, its layers
 * (`packBuffers`) as the pane draws them: the first `unread` points (cells
 * not read) with `setUnread(true)` (flat, their own size, no depth writes),
 * then the next `beneath` (a field's no-value gray) yielding in depth as the
 * pane's beneath pass does (`setYield`, `u_yieldDepth`), then the rest.
 */
function drawPointPass(pass, count, { unread = 0, beneath = 0 } = {}, { setYield = null, setUnread = null } = {}) {
  let first = 0;
  if (unread > 0 && setUnread !== null) {
    setUnread(true);
    pass.arrays.drawRange(0, unread, () => {}, drawPointsInSegments);
    setUnread(false);
    first = unread;
  }
  if (beneath > 0 && setYield !== null) {
    setYield(1);
    pass.arrays.drawRange(first, beneath, () => {}, drawPointsInSegments);
    setYield(0);
    first += beneath;
  }
  pass.arrays.drawRange(first, count - first, () => {}, drawPointsInSegments);
}

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
      // at, not an export preference. Requesting a fixed `true` here would
      // publish a smoother cloud than the screen ever drew (the difference is
      // a sizeable share of the pixels; measured: 36_decisions_figure_export.md).
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
 * What this thread's raster context for `antialias` is (made if it is not
 * yet): the renderer and vendor it draws with, the attributes the browser
 * granted (not those asked for), and its drawing buffer's samples. The
 * point pass is the same code on the worker and on the page; two contexts
 * draw the same pixels only where these agree, so a comparison of the two
 * placements records them first (`figure-export.spec.mjs`).
 *
 * @param {boolean} antialias
 * @returns {{renderer: string, vendor: string, version: string, attributes: WebGLContextAttributes|null, samples: number, maxSamples: number}}
 */
export function describeRasterContext(antialias) {
  if (typeof antialias !== 'boolean') {
    throw new TypeError('A figure-export raster context is described for an exact antialiasing boolean.');
  }
  const { gl } = acquireRasterContext(antialias);
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: String(gl.getParameter(debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL)),
    vendor: String(gl.getParameter(debug === null ? gl.VENDOR : debug.UNMASKED_VENDOR_WEBGL)),
    version: String(gl.getParameter(gl.VERSION)),
    attributes: gl.getContextAttributes(),
    samples: gl.getParameter(gl.SAMPLES),
    maxSamples: gl.getParameter(gl.MAX_SAMPLES),
  };
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


let spriteZoomLimit = null;

/**
 * The largest raster scale (export pixels per viewer pixel) at which every
 * sprite the viewer can draw still fits this GPU's point-size range
 * (`ALIASED_POINT_SIZE_RANGE`): a viewer sprite at the cap
 * (`POINT_SPRITE_MAX_PX`, or the GPU's own largest point where smaller,
 * rendering/point-sprite.js) drawn larger than the driver allows would be
 * clamped smaller than the view it reproduces. Read once, from the export
 * context of the thread that draws.
 *
 * @returns {number}
 */
export function exportSpriteZoomLimit() {
  if (spriteZoomLimit !== null) return spriteZoomLimit;
  const { gl } = acquireRasterContext(false);
  const driverMax = gpuPointSizeMax(gl);
  spriteZoomLimit = driverMax === null ? 1 : Math.max(1, driverMax / POINT_SPRITE_MAX_PX);
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
 * - inject transparency into alpha channel (a cell's color carries no
 *   visibility; a marker's alpha byte is its opacity: `colorAlpha`)
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
 * @param {'layer'|'opacity'} options.colorAlpha - What the colors' alpha
 *   byte is (`requireColorAlphaMeaning`): the cells' layer (beneath cells
 *   lead, counted in `beneath`) or a marker's opacity.
 * @param {Uint8Array|null} options.transparency
 * @param {import('../../../../../rendering/high-perf/renderer-contracts.js').LodMembership|null} [options.lodMembership]
 * @param {Uint32Array|null} [options.drawOrder] - The pane's full-detail draw
 *   order (`drawnSequence`); null draws in source order.
 * @param {Uint8Array|Float32Array|null} options.highlightArray
 * @param {boolean} options.emphasizeSelection
 * @param {number} options.selectionMutedOpacity
 * @param {number} [options.alphaThreshold]
 * @param {FigurePointLayers|null} [options.pointLayers] - Cells not read take
 *   its color and lead the sequence; the read layers hold every read cell
 *   when the pane drew them at every level.
 * @returns {{ positions: Float32Array; colors: Uint8Array; count: number; unread: number; beneath: number; dimension: number }}
 */
function packBuffers({
  positions,
  dimension,
  colors,
  colorAlpha,
  transparency,
  lodMembership,
  drawOrder,
  highlightArray,
  emphasizeSelection,
  selectionMutedOpacity,
  alphaThreshold,
  pointLayers = null,
}) {
  const alphaIsLayer = requireColorAlphaMeaning(colorAlpha, 'Figure-export packed colors') === 'layer';
  const n = positions.length / dimension;
  const admittedIndices = drawnSequence(lodMembership, drawOrder, alphaIsLayer ? colors : null, pointLayers?.readEveryLevel === true);
  const unreadRgb = pointLayers === null ? null : pointLayers.unreadColor.map(channel => Math.round(channel * 255));
  const zeroRgb = pointLayers === null ? null : pointLayers.zeroColor.map(channel => Math.round(channel * 255));
  const admittedCount = admittedIndices?.length ?? n;

  const outPositions = admittedIndices === null
    ? positions
    : allocateLargeArray(Float32Array, admittedCount * dimension);
  const outColors = allocateLargeArray(Uint8Array, admittedCount * 4);

  const mutedAlpha = selectionMutedOpacity;
  let cursor = 0;
  // The layers lead the sequence bottom first (`drawnSequence`): cells not
  // read, then the gray beneath.
  let unread = 0;
  let beneath = 0;

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
    const layer = colors[ci + 3];
    if (alphaIsLayer && layer === UNREAD_ALPHA_BYTE) {
      unread++;
      if (unreadRgb !== null) {
        r = unreadRgb[0];
        g = unreadRgb[1];
        b = unreadRgb[2];
      }
    } else if (alphaIsLayer && layer === BENEATH_ALPHA_BYTE) {
      beneath++;
      // The gray of the cells with no value, made from the figure's paper.
      if (zeroRgb !== null) {
        r = zeroRgb[0];
        g = zeroRgb[1];
        b = zeroRgb[2];
      }
    }

    // Visibility is the transparency (null: a cell shown, a marker at the
    // opacity of its alpha byte).
    const baseAlpha = transparency !== null
      ? transparency[i]
      : (alphaIsLayer ? 1 : layer / 255);
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
    unread,
    beneath,
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
 * @param {import('../../../../../rendering/high-perf/renderer-contracts.js').LodMembership|null} [options.lodMembership]
 * @param {Uint32Array|null} [options.drawOrder] - The pane's full-detail draw
 *   order (`drawnSequence`); null draws in source order.
 * @param {RenderStateForWebgl|null} options.renderState
 * @param {number} options.outputWidthPx - target canvas width (pixels)
 * @param {number} options.outputHeightPx - target canvas height (pixels)
 * @param {number} options.pointSizePx - diameter in output pixels
 * @param {{ positions: Float32Array|null; colors: Uint8Array|null; transparency?: Uint8Array|null; lodMembership?: import('../../../../../rendering/high-perf/renderer-contracts.js').LodMembership|null; pointSizePx: number; alphaThreshold?: number } | null} [options.overlayPoints]
 * @param {Uint8Array|Float32Array|null} [options.highlightArray]
 * @param {boolean} [options.emphasizeSelection=false]
 * @param {number} [options.selectionMutedOpacity=0.15]
 * @param {number} [options.alphaThreshold=0.01]
 * @param {{x: number, y: number, width: number, height: number}} options.viewRect01
 *   The figure's source (`sourceRect01` in `plot-fit.js`): the whole
 *   viewport `{0, 0, 1, 1}` or the framing crop (normalized, top-left
 *   origin), drawn over the whole output at the output's resolution -- a
 *   cropped figure at its own pixels rather than a magnified part of the
 *   whole view, and never letterboxed. The caller sizes the output to the
 *   source's aspect (`planPlotRaster`) and scales point sizes by the same
 *   zoom.
 * @returns {ImageBitmap} The frame, `outputWidthPx` × `outputHeightPx`, with
 *   premultiplied alpha; the caller owns it and closes it.
 */
/**
 * The largest sprite this export may ask the shader to draw: the cap the
 * viewer drew the pane with (`renderState.pointSizeMax`), times the raster's
 * scale, within this GPU's largest point.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {number} viewerCap - the pane's `pointSizeMax`, in viewport pixels.
 * @param {number} rasterScale - export pixels per source viewport pixel.
 * @returns {number}
 */
function exportPointSizeMax(gl, viewerCap, rasterScale) {
  const scaled = viewerCap * Math.max(1, rasterScale);
  const driverMax = gpuPointSizeMax(gl);
  return driverMax === null ? scaled : Math.min(scaled, driverMax);
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
  viewRect01,
  pointLayers = null,
}) {
  requireFigurePointLayers(pointLayers, 'Figure-export point layers');
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
  // The sprite cap the pane drew with (rendering/point-sprite.js), checked
  // here as every other field is: a pass without it would ask the driver for
  // a NaN cap.
  if (!Number.isFinite(renderState.pointSizeMax) || renderState.pointSizeMax <= 0) {
    throw new RangeError(
      'Figure-export renderState.pointSizeMax must be a finite positive number.'
    );
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

  // The source the raster shows: the whole viewport `{0, 0, 1, 1}` or the
  // framing crop. Always a rectangle; there is no letterboxed default.
  const viewRect = assertNormalizedRect01(viewRect01, 'Figure-export raster viewRect01');

  const packed = packBuffers({
    positions,
    dimension,
    colors,
    // The cells' colors: the alpha byte is their layer.
    colorAlpha: 'layer',
    transparency,
    lodMembership,
    drawOrder,
    highlightArray,
    emphasizeSelection,
    selectionMutedOpacity,
    alphaThreshold,
    pointLayers,
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
  /** The passes' segmented stores and vertex arrays (`uploadPointPass`). */
  const passes = [];
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

    // The source (the view, or the framing crop) fills the canvas: the
    // projection is mapped onto it in clip space, so every point is placed
    // and drawn at this raster's own resolution. `s` is export pixels per
    // viewer pixel.
    const s = Math.min(
      outW / (viewRect.width * srcViewportW),
      outH / (viewRect.height * srcViewportH)
    );
    const zoom = viewRectClipTransform(viewRect);
    const mvpMatrix = multiplyMat4(zoom, renderState.mvpMatrix);
    const projectionMatrix = multiplyMat4(zoom, renderState.projectionMatrix);
    gl.viewport(0, 0, outW, outH);

    // Positions and colors as separate segmented stores.
    // A cell its embedding does not place (NaN positions) goes up as the
    // stand-in the vertex shader rejects (`unplaced-positions.js`).
    const pointPass = uploadPointPass(gl, positionsForGpu(packed.positions, packed.dimension), packed.dimension, packed.colors, packed.count, 'Figure-export point');
    passes.push(pointPass);

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
    // A viewer pixel is `s` export pixels everywhere in this raster. To
    // produce a *scaled copy* of what the user sees (WYSIWYG), the caller
    // scales u_pointSize by the raster's zoom and the projection factor stays
    // the interactive viewer's own.
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

    // The point pass's size uniform: its layers set it again (`drawPointPass`).
    const pointSizeUniform = u('u_pointSize');
    setF1(pointSizeUniform, pointSize);
    // The shader caps a sprite at the viewer's cap (rendering/point-sprite.js)
    // of whatever it is drawing into. This raster is `s` times the screen, so
    // a point the viewer clamps at the cap must clamp at `s` times it here, or
    // it would occupy a smaller fraction of the exported image than of the
    // view it reproduces. Reachable in an ordinary 3D close-up: with
    // attenuation the size grows as 1/eyeDepth.
    //
    // The driver's own maximum bounds it, because asking for a larger sprite
    // than ALIASED_POINT_SIZE_RANGE allows is undefined rather than clamped.
    const pointSizeMax = exportPointSizeMax(gl, renderState.pointSizeMax, s);
    setF1(u('u_pointSizeMax'), pointSizeMax);
    setF1(u('u_sizeAttenuation'), sizeAttenuation);
    setF1(u('u_pointScale'), pointScale);

    // Disable alpha texture paths for export; alpha is baked into vertex colors.
    // IMPORTANT: Even when disabled, we must bind dummy textures to avoid WebGL errors.
    // The shader uses sampler2DArray (float) for u_alphaTex and usampler2DArray (uint)
    // for u_lodIndexTex. If both samplers default to texture unit 0, WebGL throws:
    // "Two textures of different types use the same sampler location"
    setI1(u('u_useAlphaTex'), 0);
    setI1(u('u_orderedSlots'), 0);

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
      // Only an opaque (sculpted) point mixes toward the fog color, which a
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

    setI1(u('u_drawPass'), 0);
    // The cells read are drawn at their own size while some are not read
    // (`readScale`); the cells not read flat, without depth writes, beneath.
    const readPointSize = pointSize * (pointLayers === null ? 1 : pointLayers.readScale);
    if (packed.unread > 0) setF1(pointSizeUniform, readPointSize);
    drawPointPass(pointPass, packed.count, packed, {
      setYield: value => setI1(u('u_yieldDepth'), value),
      setUnread: unread => {
        setF1(pointSizeUniform, unread ? pointSize : readPointSize);
        if (SHADER_QUALITY_TRAITS[quality].sphere) setF1(u('u_lightingStrength'), unread ? 0 : lightingStrength);
        if (depth) gl.depthMask(!unread);
      },
    });

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
        // A centroid's alpha byte is its opacity (0: its category is hidden).
        colorAlpha: 'opacity',
        transparency: overlayPoints.transparency ?? null,
        lodMembership: overlayLodMembership,
        highlightArray: null,
        emphasizeSelection: false,
        selectionMutedOpacity: 1.0,
        alphaThreshold: overlayPoints.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD,
      });
      if (overlayPacked.count > 0) {
        const overlayPass = uploadPointPass(gl, overlayPacked.positions, 3, overlayPacked.colors, overlayPacked.count, 'Figure-export overlay');
        passes.push(overlayPass);
        setF1(u('u_pointSize'), overlayPoints.pointSizePx);
        setF1(u('u_pointSizeMax'), pointSizeMax);
        drawPointPass(overlayPass, overlayPacked.count);
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

      const highlightPass = uploadPointPass(
        gl, highlightOverlay.positions, highlightOverlay.dimension, highlightOverlay.colors,
        highlightOverlay.count, 'Figure-export highlight'
      );
      passes.push(highlightPass);

      const hu = (name) => gl.getUniformLocation(highlightProgram, name);
      const setHMat4 = (loc, mat) => { if (loc) gl.uniformMatrix4fv(loc, false, mat); };
      const setHF1 = (loc, v) => { if (loc) gl.uniform1f(loc, v); };
      const setHV3 = (loc, v) => { if (loc && v) gl.uniform3fv(loc, v); };

      setHMat4(hu('u_modelViewMatrix'), shaderFrame.modelView);
      setHMat4(hu('u_projectionMatrix'), projectionMatrix);

      setHF1(hu('u_pointSize'), pointSize);
      setHF1(hu('u_pointSizeMax'), pointSizeMax);
      setHF1(hu('u_sizeAttenuation'), sizeAttenuation);
      setHF1(hu('u_pointScale'), pointScale);

      const style = HIGHLIGHT_STYLES_BY_QUALITY[quality];
      // The ring within this GPU's largest point (asking for more is undefined).
      setHF1(hu('u_gpuPointSizeMax'), gpuPointSizeMax(gl) ?? pointSizeMax * style.scale);
      setHF1(hu('u_highlightScale'), style.scale);
      setHV3(hu('u_highlightColor'), HIGHLIGHT_COLOR);
      setHV3(hu('u_highlightRingColor'), HIGHLIGHT_RING_COLOR);
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
        drawPointPass(highlightPass, highlightOverlay.count);
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
  cleanup('vertex-array unbind', () => gl.bindVertexArray(null));
  // Vertex arrays before the buffers they reference.
  for (const pass of passes) cleanup('point vertex-array deletion', () => pass.arrays.delete());
  for (const pass of passes) {
    cleanup('position-buffer deletion', () => pass.positions.delete());
    cleanup('color-buffer deletion', () => pass.colors.delete());
  }
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
