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
 * - 'light': Simplified lighting, circular point sprites
 * - 'ultralight': Flat shading, square points (fastest)
 *
 * MATRIX REQUIREMENTS:
 * The WebGL shaders require separate viewMatrix, projectionMatrix, and modelMatrix
 * (not just mvpMatrix) because lighting calculations need eye-space positions.
 * If any matrix is missing, the rasterizer returns null and the caller should
 * fall back to Canvas2D rendering (which produces flat circles, not 3D spheres).
 *
 * CROSS-BROWSER NOTES:
 * - Uses OffscreenCanvas when available for better performance
 * - Falls back to HTMLCanvasElement for broader compatibility
 * - preserveDrawingBuffer is enabled for reliable toBlob/convertToBlob
 *
 * ISOLATION:
 * This module is only invoked during export/preview and does not touch the
 * normal render loop. It creates temporary WebGL resources and cleans them up.
 *
 * @module ui/modules/figure-export/utils/webgl-point-rasterizer
 */

import { createProgram } from '../../../../../rendering/gl-utils.js';
import {
  HP_VS_FULL,
  HP_FS_FULL,
  HP_VS_LIGHT,
  HP_FS_LIGHT,
  HP_FS_ULTRALIGHT,
  HP_VS_HIGHLIGHT,
  HP_FS_HIGHLIGHT,
} from '../../../../../rendering/shaders/high-perf-shaders.js';
import { isFiniteNumber } from '../../../../utils/number-utils.js';

const DEFAULT_ALPHA_THRESHOLD = 0.01;
const DEFAULT_HIGHLIGHT_COLOR = [0.4, 0.85, 1.0];

const HIGHLIGHT_STYLE_BY_QUALITY = {
  full: { scale: 1.75, ringWidth: 0.42, haloStrength: 0.65, haloShape: 0.0, ringStyle: 0.0 },
  light: { scale: 1.70, ringWidth: 0.44, haloStrength: 0.60, haloShape: 0.0, ringStyle: 1.0 },
  ultralight: { scale: 1.65, ringWidth: 0.46, haloStrength: 0.55, haloShape: 0.35, ringStyle: 2.0 }
};

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function highlightValueToAlphaByte(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  // Support both 0..1 and 0..255 highlight arrays.
  const a01 = v <= 1.0 ? v : (v >= 255 ? 1.0 : (v / 255));
  return Math.max(0, Math.min(255, Math.round(clamp01(a01) * 255)));
}

function buildHighlightOverlayBuffers({
  positions,
  highlightArray,
  transparency,
  visibilityMask,
  alphaThreshold = DEFAULT_ALPHA_THRESHOLD
}) {
  if (!positions || !highlightArray) return null;

  const n = Math.min(
    Math.floor(positions.length / 3),
    highlightArray.length,
    transparency ? transparency.length : Infinity,
    visibilityMask ? visibilityMask.length : Infinity
  );
  if (!Number.isFinite(n) || n <= 0) return null;

  let count = 0;
  for (let i = 0; i < n; i++) {
    const aByte = highlightValueToAlphaByte(highlightArray[i]);
    if (aByte <= 0) continue;
    if (visibilityMask && (visibilityMask[i] ?? 0) <= 0) continue;
    const baseAlpha = transparency ? (transparency[i] ?? 1.0) : 1.0;
    if (!Number.isFinite(baseAlpha) || baseAlpha < alphaThreshold) continue;
    count++;
  }
  if (count <= 0) return null;

  const outPos = new Float32Array(count * 3);
  const outCol = new Uint8Array(count * 4);

  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const aByte = highlightValueToAlphaByte(highlightArray[i]);
    if (aByte <= 0) continue;
    if (visibilityMask && (visibilityMask[i] ?? 0) <= 0) continue;
    const baseAlpha = transparency ? (transparency[i] ?? 1.0) : 1.0;
    if (!Number.isFinite(baseAlpha) || baseAlpha < alphaThreshold) continue;

    const pi = i * 3;
    const oi = cursor * 3;
    outPos[oi] = positions[pi];
    outPos[oi + 1] = positions[pi + 1];
    outPos[oi + 2] = positions[pi + 2];

    const cj = cursor * 4;
    outCol[cj] = 255;
    outCol[cj + 1] = 255;
    outCol[cj + 2] = 255;
    outCol[cj + 3] = aByte;

    cursor++;
  }

  return { positions: outPos, colors: outCol, count };
}

/**
 * @typedef {object} RenderStateForWebgl
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
 * @property {Float32Array|number[]} [fogColor]
 * @property {Float32Array|number[]} [lightDir]
 * @property {[number, number, number]} [cameraPosition]
 * @property {string} [shaderQuality]
 */

/**
 * Create an (Offscreen)Canvas for WebGL rasterization.
 * @param {number} width
 * @param {number} height
 * @returns {OffscreenCanvas|HTMLCanvasElement|null}
 */
function createRasterCanvas(width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      return new OffscreenCanvas(w, h);
    } catch {
      // Fall through to HTML canvas.
    }
  }
  if (typeof document !== 'undefined' && document?.createElement) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
}

/**
 * @param {OffscreenCanvas|HTMLCanvasElement} canvas
 * @returns {WebGL2RenderingContext|null}
 */
function getWebgl2Context(canvas) {
  try {
    // preserveDrawingBuffer is important for reliable toBlob/convertToBlob across browsers.
    return /** @type {WebGL2RenderingContext|null} */ (canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    }));
  } catch {
    return null;
  }
}

function pickShaderSources(shaderQuality) {
  const q = String(shaderQuality || 'full');
  if (q === 'ultralight') {
    return { vs: HP_VS_LIGHT, fs: HP_FS_ULTRALIGHT, quality: 'ultralight' };
  }
  if (q === 'light') {
    return { vs: HP_VS_LIGHT, fs: HP_FS_LIGHT, quality: 'light' };
  }
  return { vs: HP_VS_FULL, fs: HP_FS_FULL, quality: 'full' };
}

/**
 * Compute a bounding sphere from bounds.
 * Matches HighPerfRenderer.autoComputeFogRange() math.
 * @param {{ minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }} bounds
 */
function boundsToSphere(bounds) {
  const dx = bounds.maxX - bounds.minX;
  const dy = bounds.maxY - bounds.minY;
  const dz = bounds.maxZ - bounds.minZ;
  const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5;
  return {
    center: [
      (bounds.minX + bounds.maxX) * 0.5,
      (bounds.minY + bounds.maxY) * 0.5,
      (bounds.minZ + bounds.maxZ) * 0.5,
    ],
    radius
  };
}

/**
 * Pack colors into a new Uint8Array so we can:
 * - inject transparency into alpha channel (viewer often keeps alpha separate)
 * - optionally apply selection emphasis (mute non-selected)
 *
 * Also returns bounds for fog range computation (scanned over all points).
 *
 * @param {object} options
 * @param {Float32Array} options.positions
 * @param {Uint8Array} options.colors
 * @param {Float32Array|null} options.transparency
 * @param {Float32Array|Uint8Array|null} [options.visibilityMask]
 * @param {Uint8Array|Float32Array|null} options.highlightArray
 * @param {boolean} options.emphasizeSelection
 * @param {number} options.selectionMutedOpacity
 * @param {number} [options.alphaThreshold]
 * @returns {{ positions: Float32Array; colors: Uint8Array; count: number; bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } }}
 */
function packBuffers({
  positions,
  colors,
  transparency,
  visibilityMask,
  highlightArray,
  emphasizeSelection,
  selectionMutedOpacity,
  alphaThreshold = DEFAULT_ALPHA_THRESHOLD,
}) {
  const n = Math.min(Math.floor(positions.length / 3), Math.floor(colors.length / 4));
  const outColors = new Uint8Array(n * 4);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  const mutedAlpha = Math.max(0, Math.min(1, Number(selectionMutedOpacity) || 0.15));

  for (let i = 0; i < n; i++) {
    const pi = i * 3;
    const x = positions[pi];
    const y = positions[pi + 1];
    const z = positions[pi + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;

    const ci = i * 4;
    let r = colors[ci];
    let g = colors[ci + 1];
    let b = colors[ci + 2];

    const baseAlpha = transparency ? (transparency[i] ?? 1.0) : (colors[ci + 3] / 255);
    let a = Math.max(0, Math.min(1, baseAlpha));

    if (visibilityMask && (visibilityMask[i] ?? 0) <= 0) {
      a = 0;
    }

    if (emphasizeSelection && highlightArray && (highlightArray[i] ?? 0) <= 0) {
      r = 160;
      g = 160;
      b = 160;
      a *= mutedAlpha;
    }

    if (a < alphaThreshold) a = 0;
    const ao = Math.max(0, Math.min(255, Math.round(a * 255)));

    outColors[ci] = r;
    outColors[ci + 1] = g;
    outColors[ci + 2] = b;
    outColors[ci + 3] = ao;
  }

  return {
    positions,
    colors: outColors,
    count: n,
    bounds: { minX, maxX, minY, maxY, minZ, maxZ }
  };
}

/**
 * Render a point cloud into a WebGL2 canvas using viewer shader variants.
 *
 * @param {object} options
 * @param {Float32Array|null} options.positions
 * @param {Uint8Array|null} options.colors
 * @param {Float32Array|null} [options.transparency]
 * @param {Float32Array|Uint8Array|null} [options.visibilityMask]
 * @param {RenderStateForWebgl|null} options.renderState
 * @param {number} options.outputWidthPx - target canvas width (pixels)
 * @param {number} options.outputHeightPx - target canvas height (pixels)
 * @param {number} options.pointSizePx - diameter in output pixels
 * @param {{ positions: Float32Array|null; colors: Uint8Array|null; transparency?: Float32Array|null; visibilityMask?: Float32Array|Uint8Array|null; pointSizePx: number; alphaThreshold?: number } | null} [options.overlayPoints]
 * @param {Uint8Array|Float32Array|null} [options.highlightArray]
 * @param {boolean} [options.emphasizeSelection=false]
 * @param {number} [options.selectionMutedOpacity=0.15]
 * @param {number} [options.alphaThreshold=0.01]
 * @returns {OffscreenCanvas|HTMLCanvasElement|null}
 */
export function rasterizePointsWebgl({
  positions,
  colors,
  transparency = null,
  visibilityMask = null,
  renderState,
  outputWidthPx,
  outputHeightPx,
  pointSizePx,
  overlayPoints = null,
  highlightArray = null,
  emphasizeSelection = false,
  selectionMutedOpacity = 0.15,
  alphaThreshold = DEFAULT_ALPHA_THRESHOLD,
}) {
  // ============================================================================
  // VALIDATION: Check all required data is present
  // ============================================================================
  // The WebGL shaders require all three matrices (view, projection, model) because:
  // - Eye-space position is computed as: viewMatrix * modelMatrix * position
  // - Clip-space position is computed as: projectionMatrix * eyePos
  // - Lighting/fog calculations need eye-space distances
  //
  // If any data is missing, we return null and the caller falls back to Canvas2D.
  // This produces flat circles instead of 3D-shaded spheres - a visual downgrade.
  // ============================================================================

  const missing = [];
  if (!positions) missing.push('positions');
  if (!colors) missing.push('colors');
  if (!renderState) {
    missing.push('renderState');
  } else {
    if (!renderState.viewMatrix) missing.push('viewMatrix');
    if (!renderState.projectionMatrix) missing.push('projectionMatrix');
    if (!renderState.modelMatrix) missing.push('modelMatrix');
  }

  if (missing.length > 0) {
    // Log a warning (not just debug) so users can diagnose why 3D shading isn't working
    console.warn(
      `[FigureExport] WebGL rasterizer skipped - missing: ${missing.join(', ')}. ` +
      'Export will use flat circles instead of 3D-shaded spheres. ' +
      'Ensure viewer is fully initialized before exporting.'
    );
    return null;
  }

  const packed = packBuffers({
    positions,
    colors,
    transparency,
    visibilityMask,
    highlightArray,
    emphasizeSelection,
    selectionMutedOpacity,
    alphaThreshold
  });
  if (packed.count <= 0) return null;

  const outW = Math.max(1, Math.round(outputWidthPx));
  const outH = Math.max(1, Math.round(outputHeightPx));

  /** @type {OffscreenCanvas|HTMLCanvasElement|null} */
  let canvas = createRasterCanvas(outW, outH);
  if (!canvas) {
    return null;
  }

  /** @type {WebGL2RenderingContext|null} */
  let gl = getWebgl2Context(canvas);
  if (!gl && typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    // Some browsers expose OffscreenCanvas but only support WebGL2 on HTMLCanvasElement.
    const fallback = typeof document !== 'undefined' && document?.createElement
      ? /** @type {HTMLCanvasElement} */ (document.createElement('canvas'))
      : null;
    if (fallback) {
      fallback.width = outW;
      fallback.height = outH;
      const gl2 = getWebgl2Context(fallback);
      if (gl2) {
        canvas = fallback;
        gl = gl2;
      }
    }
  }
  if (!gl) {
    return null;
  }

  const { vs, fs, quality } = pickShaderSources(renderState.shaderQuality);

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

  try {
    program = createProgram(gl, vs, fs);
    gl.useProgram(program);

    // GL state matches HighPerfRenderer defaults.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const srcViewportW = Math.max(1, Math.round(renderState.viewportWidth || 1));
    const srcViewportH = Math.max(1, Math.round(renderState.viewportHeight || 1));

    // Letterbox the on-screen viewport into the export canvas (preserves projection/aspect).
    const s = Math.min(outW / srcViewportW, outH / srcViewportH);
    const vpW = Math.max(1, Math.round(srcViewportW * s));
    const vpH = Math.max(1, Math.round(srcViewportH * s));
    const vpX = Math.floor((outW - vpW) / 2);
    const vpY = Math.floor((outH - vpH) / 2);

    gl.viewport(vpX, vpY, vpW, vpH);

    // Buffers (separate position + color to keep packing simple).
    positionBuffer = gl.createBuffer();
    colorBuffer = gl.createBuffer();
    if (!positionBuffer || !colorBuffer) {
      return null;
    }

    const packedPositions = packed.positions.subarray(0, packed.count * 3);

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, packedPositions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

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

    setMat4(u('u_mvpMatrix'), renderState.mvpMatrix);
    setMat4(u('u_viewMatrix'), renderState.viewMatrix);
    setMat4(u('u_modelMatrix'), renderState.modelMatrix);
    setMat4(u('u_projectionMatrix'), renderState.projectionMatrix);

    const fov = isFiniteNumber(renderState.fov) ? renderState.fov : (45 * Math.PI / 180);
    const sizeAttenuation = isFiniteNumber(renderState.sizeAttenuation) ? renderState.sizeAttenuation : 0.0;
    const pointSize = isFiniteNumber(pointSizePx) ? pointSizePx : (isFiniteNumber(renderState.pointSize) ? renderState.pointSize : 5.0);

    setF1(u('u_pointSize'), pointSize);
    setF1(u('u_sizeAttenuation'), sizeAttenuation);
    // IMPORTANT: Keep u_viewportHeight in the SOURCE viewport pixel units.
    //
    // We letterbox the source viewport into a differently-sized export canvas by
    // changing gl.viewport(). To produce a *scaled copy* of what the user sees
    // (WYSIWYG), we scale u_pointSize at the callsite and keep u_viewportHeight
    // consistent with the interactive viewer's original projection factor.
    setF1(u('u_viewportHeight'), srcViewportH);
    setF1(u('u_fov'), fov);

    // Disable alpha texture paths for export; alpha is baked into vertex colors.
    // IMPORTANT: Even when disabled, we must bind dummy textures to avoid WebGL errors.
    // The shader uses sampler2D (float) for u_alphaTex and usampler2D (uint) for u_lodIndexTex.
    // If both samplers default to texture unit 0, WebGL throws:
    // "Two textures of different types use the same sampler location"
    setI1(u('u_useAlphaTex'), 0);
    setI1(u('u_alphaTexWidth'), 0);
    setF1(u('u_invAlphaTexWidth'), 0);
    setI1(u('u_useLodIndexTex'), 0);
    setI1(u('u_lodIndexTexWidth'), 0);
    setF1(u('u_invLodIndexTexWidth'), 0);

    // Create and bind dummy textures to separate texture units to prevent type conflicts.
    // IMPORTANT: Configure filters/wraps so textures are "complete" (no mipmaps required),
    // otherwise some browsers will fail the draw even if the texture path is disabled.
    //
    // Unit 0: dummy normalized texture for u_alphaTex (sampler2D)
    dummyAlphaTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dummyAlphaTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    const alphaTexLoc = u('u_alphaTex');
    if (alphaTexLoc) gl.uniform1i(alphaTexLoc, 0);

    // Unit 1: dummy integer texture for u_lodIndexTex (usampler2D)
    dummyLodIndexTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, dummyLodIndexTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array([0]));
    const lodIndexTexLoc = u('u_lodIndexTex');
    if (lodIndexTexLoc) gl.uniform1i(lodIndexTexLoc, 1);

    const cameraPosition = Array.isArray(renderState.cameraPosition) ? renderState.cameraPosition : [0, 0, 3];
    const sphere = boundsToSphere(packed.bounds);
    const dx = (cameraPosition[0] || 0) - sphere.center[0];
    const dy = (cameraPosition[1] || 0) - sphere.center[1];
    const dz = (cameraPosition[2] || 0) - sphere.center[2];
    const distToCenter = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const fogNear = Math.max(0, distToCenter - sphere.radius);
    const fogFar = distToCenter + sphere.radius;
    const fogDensity = isFiniteNumber(renderState.fogDensity) ? renderState.fogDensity : 0.5;
    const fogColor = renderState.fogColor || [1, 1, 1];
    const lightingStrength = isFiniteNumber(renderState.lightingStrength) ? renderState.lightingStrength : 0.6;
    const lightDir = renderState.lightDir || [0.5, 0.7, 0.5];

    if (quality === 'full') {
      setF1(u('u_lightingStrength'), lightingStrength);
      setF1(u('u_fogDensity'), fogDensity);
      setF1(u('u_fogNear'), fogNear);
      setF1(u('u_fogFar'), fogFar);
      setV3(u('u_fogColor'), fogColor);
      setV3(u('u_lightDir'), lightDir);
    }

    gl.drawArrays(gl.POINTS, 0, packed.count);

    // Optional overlay pass (e.g., centroid points rendered larger on top).
    if (overlayPoints?.positions && overlayPoints?.colors) {
      const overlayPacked = packBuffers({
        positions: overlayPoints.positions,
        colors: overlayPoints.colors,
        transparency: overlayPoints.transparency ?? null,
        visibilityMask: overlayPoints.visibilityMask ?? null,
        highlightArray: null,
        emphasizeSelection: false,
        selectionMutedOpacity: 1.0,
        alphaThreshold: overlayPoints.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD,
      });
      if (overlayPacked.count > 0) {
        overlayPosBuffer = gl.createBuffer();
        overlayColorBuffer = gl.createBuffer();
        if (overlayPosBuffer && overlayColorBuffer) {
          const overlayPositions = overlayPacked.positions.subarray(0, overlayPacked.count * 3);
          gl.bindBuffer(gl.ARRAY_BUFFER, overlayPosBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, overlayPositions, gl.STATIC_DRAW);
          gl.enableVertexAttribArray(0);
          gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

          gl.bindBuffer(gl.ARRAY_BUFFER, overlayColorBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, overlayPacked.colors, gl.STATIC_DRAW);
          gl.enableVertexAttribArray(1);
          gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);

          const overlaySize = isFiniteNumber(overlayPoints.pointSizePx)
            ? overlayPoints.pointSizePx
            : pointSize;
          setF1(u('u_pointSize'), overlaySize);
          gl.drawArrays(gl.POINTS, 0, overlayPacked.count);
        }
      }
    }

    // Optional highlight overlay (selection rings / continuous highlights).
    // Matches viewer behavior: depth test ON, but depth writes OFF so highlights appear on top.
    const highlightOverlay = buildHighlightOverlayBuffers({
      positions,
      highlightArray,
      transparency,
      visibilityMask,
      alphaThreshold
    });
    if (highlightOverlay?.count) {
      highlightProgram = createProgram(gl, HP_VS_HIGHLIGHT, HP_FS_HIGHLIGHT);
      gl.useProgram(highlightProgram);

      highlightPosBuffer = gl.createBuffer();
      highlightColorBuffer = gl.createBuffer();
      if (!highlightPosBuffer || !highlightColorBuffer) return canvas;

      gl.bindBuffer(gl.ARRAY_BUFFER, highlightPosBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, highlightOverlay.positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, highlightColorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, highlightOverlay.colors, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);

      const hu = (name) => gl.getUniformLocation(highlightProgram, name);
      const setHMat4 = (loc, mat) => { if (loc) gl.uniformMatrix4fv(loc, false, mat); };
      const setHF1 = (loc, v) => { if (loc) gl.uniform1f(loc, v); };
      const setHV3 = (loc, v) => { if (loc && v) gl.uniform3fv(loc, v); };

      setHMat4(hu('u_mvpMatrix'), renderState.mvpMatrix);
      setHMat4(hu('u_viewMatrix'), renderState.viewMatrix);
      setHMat4(hu('u_modelMatrix'), renderState.modelMatrix);
      setHMat4(hu('u_projectionMatrix'), renderState.projectionMatrix);

      setHF1(hu('u_pointSize'), pointSize);
      setHF1(hu('u_sizeAttenuation'), sizeAttenuation);
      setHF1(hu('u_viewportHeight'), srcViewportH);
      setHF1(hu('u_fov'), fov);

      const style = HIGHLIGHT_STYLE_BY_QUALITY[quality] || HIGHLIGHT_STYLE_BY_QUALITY.full;
      setHF1(hu('u_highlightScale'), style.scale);
      setHV3(hu('u_highlightColor'), DEFAULT_HIGHLIGHT_COLOR);
      setHF1(hu('u_ringWidth'), style.ringWidth);
      setHF1(hu('u_haloStrength'), style.haloStrength);
      setHF1(hu('u_haloShape'), style.haloShape);
      setHF1(hu('u_ringStyle'), style.ringStyle);
      setHF1(hu('u_time'), 0.0);

      setHF1(hu('u_fogDensity'), fogDensity);
      setHF1(hu('u_fogNear'), fogNear);
      setHF1(hu('u_fogFar'), fogFar);
      setHV3(hu('u_fogColor'), fogColor);
      setHF1(hu('u_lightingStrength'), lightingStrength);
      setHV3(hu('u_lightDir'), lightDir);

      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.POINTS, 0, highlightOverlay.count);
      gl.depthMask(true);
    }

    gl.flush();
    return canvas;
  } catch (err) {
    console.warn('[FigureExport] WebGL point rasterization failed, falling back to CPU renderer:', err);
    return null;
  } finally {
    // Clean up GPU objects but keep the canvas pixels alive for encode/drawImage.
    try { gl.bindBuffer(gl.ARRAY_BUFFER, null); } catch {}
    if (positionBuffer) {
      try { gl.deleteBuffer(positionBuffer); } catch {}
    }
    if (colorBuffer) {
      try { gl.deleteBuffer(colorBuffer); } catch {}
    }
    if (overlayPosBuffer) {
      try { gl.deleteBuffer(overlayPosBuffer); } catch {}
    }
    if (overlayColorBuffer) {
      try { gl.deleteBuffer(overlayColorBuffer); } catch {}
    }
    if (highlightPosBuffer) {
      try { gl.deleteBuffer(highlightPosBuffer); } catch {}
    }
    if (highlightColorBuffer) {
      try { gl.deleteBuffer(highlightColorBuffer); } catch {}
    }
    if (dummyAlphaTex) {
      try { gl.deleteTexture(dummyAlphaTex); } catch {}
    }
    if (dummyLodIndexTex) {
      try { gl.deleteTexture(dummyLodIndexTex); } catch {}
    }
    if (highlightProgram) {
      try { gl.useProgram(null); } catch {}
      try { gl.deleteProgram(highlightProgram); } catch {}
    }
    if (program) {
      try { gl.useProgram(null); } catch {}
      try { gl.deleteProgram(program); } catch {}
    }
  }
}
