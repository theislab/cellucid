/**
 * Offscreen rendering of a backdrop look, for figure export.
 *
 * The look is drawn by the same renderer and shaders as the screen, in a
 * private WebGL2 context, from the screen's frozen state for the pane
 * (`renderer.getExportState()`: the look, its data tints, the ambient clock
 * and Atelier's baked contact-shadow map) and the pane's presented camera.
 * The cube and tile bakes are deterministic, so they are re-baked here and
 * match the screen's texel for texel. Only the target differs: the raster
 * covers the figure's plot rectangle at the figure's own pixel density, so
 * star cores, grain and motes keep their on-screen size in CSS pixels.
 *
 * One context is kept for the page's life and reused by every export and by
 * the export preview; it holds at most one look family's bake.
 */

import { createBackdropLookRenderer } from './backdrop-look-renderer.js';
import { isBackdropLook } from './backdrop-looks.js';

let shared = null;

function getSharedContext() {
  if (shared !== null && !shared.gl.isContextLost()) return shared;
  if (typeof document === 'undefined') {
    throw new Error('Figure export needs a document to draw the background look.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) {
    throw new Error('Figure export needs WebGL2 to draw the background look.');
  }
  const renderer = createBackdropLookRenderer(gl, {
    invalidate: () => {},
    // The export is a still: no fade, no ambient motion of its own.
    prefersReducedMotion: () => true,
    readViewSource: () => null,
  });
  shared = { canvas, gl, renderer };
  return shared;
}

function invert4(m) {
  const out = new Float32Array(16);
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) return null;
  const inv = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * inv;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * inv;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * inv;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * inv;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * inv;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * inv;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * inv;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * inv;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * inv;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * inv;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * inv;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * inv;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * inv;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * inv;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * inv;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * inv;
  return out;
}

/**
 * Draw one pane's look into a new 2D canvas of `width` × `height` pixels.
 *
 * @param {object} options
 * @param {object} options.renderState - the pane's presented render state;
 *   `renderState.backdrop.look` is the screen's frozen look state
 * @param {number} options.width - raster pixels
 * @param {number} options.height
 * @param {number[]} options.ndcTransform - pane NDC = raster NDC * xy + zw
 * @param {number} options.pixelScale - raster pixels per pane pixel
 * @param {AbortSignal|null} [options.signal]
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderBackdropLookRaster({
  renderState,
  width,
  height,
  ndcTransform,
  pixelScale,
  signal = null,
}) {
  const frozen = renderState?.backdrop?.look ?? null;
  if (frozen === null || !isBackdropLook(frozen.id)) {
    throw new TypeError('Figure export render state names no background look.');
  }
  if (!(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0)) {
    throw new TypeError('Figure export background-look raster needs a positive integer size.');
  }
  const { canvas, gl, renderer } = getSharedContext();
  renderer.setLook(frozen.id);
  await renderer.whenReady();
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');

  // The context draws at most its largest renderbuffer; a larger figure is
  // drawn at that size and scaled up (every look is smooth at that scale).
  const limit = Math.min(
    gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    ...gl.getParameter(gl.MAX_VIEWPORT_DIMS)
  );
  const fit = Math.min(1, limit / width, limit / height);
  const drawWidth = Math.max(1, Math.floor(width * fit));
  const drawHeight = Math.max(1, Math.floor(height * fit));
  canvas.width = drawWidth;
  canvas.height = drawHeight;
  gl.viewport(0, 0, drawWidth, drawHeight);

  const mvp = Float32Array.from(renderState.mvpMatrix);
  const invMvp = invert4(mvp);
  if (invMvp === null) {
    throw new Error('Figure export cannot draw the background look: the camera is singular.');
  }
  const backdrop = renderState.backdrop;
  const scale = pixelScale * fit;
  const drawn = renderer.draw({
    viewId: 'figure-export',
    invMvp,
    mvp,
    projection: Float32Array.from(renderState.projectionMatrix),
    eye: Float32Array.from(renderState.cameraPosition),
    pixelRatio: backdrop.pixelRatio * scale,
    glowCenterX: backdrop.glowCenterX,
    viewportWidth: renderState.viewportWidth * scale,
    viewportHeight: renderState.viewportHeight * scale,
    planar: backdrop.planarity >= 0.5 ? 1 : 0,
    geometry: backdrop,
    ndcTransform: ndcTransform,
    frozen,
  });
  if (!drawn) {
    throw new Error(`Figure export could not draw the "${frozen.id}" background look.`);
  }
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, width, height);
  return out;
}
