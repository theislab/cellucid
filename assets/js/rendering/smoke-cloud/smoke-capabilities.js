// What the volumetric smoke pipeline needs from WebGL2 beyond the core
// specification, checked once against the real context before anything is
// built. A device that lacks one of these cannot show smoke at all; the app
// says so in plain words and stays in Points.
//
// Requirements, and where each is used:
// - EXT_color_buffer_float: the density build renders into R32F and RGBA32F
//   atlases and the lighting volume into RG16F; core WebGL2 cannot render to
//   any float format.
// - EXT_float_blend: the density build sums every cell's weight and colour
//   with additive blending into those float32 atlases. Core WebGL2 forbids
//   blending into a float32 target, and iOS and many Android GPUs do not
//   offer the extension. A half-float sum would silently lose small
//   contributions in dense regions, so there is no lower-precision substitute.
// - MAX_3D_TEXTURE_SIZE >= 128 and MAX_TEXTURE_SIZE >= 1536 for the largest
//   grid's volume and slice atlas. WebGL2 guarantees 256 and 2048, so these
//   only fail on a non-conforming driver.
//
// Not required: OES_texture_float_linear. Every float32 texture the pipeline
// creates is NEAREST and read with texelFetch; the volumes it samples with
// LINEAR are RGBA8 and RG16F, both filterable in core WebGL2.

import { MAX_SMOKE_GRID_SIZE } from './smoke-density-contract.js';

const NOT_AVAILABLE = "Volumetric smoke isn't available on this device:";
const POINTS_WORK = 'Points rendering works as usual.';

function largestAtlasEdge() {
  const slicesPerRow = Math.ceil(Math.sqrt(MAX_SMOKE_GRID_SIZE));
  return MAX_SMOKE_GRID_SIZE * slicesPerRow;
}

function unsupported(reason, message, detail) {
  return Object.freeze({ supported: false, reason, message, detail });
}

const SUPPORTED = Object.freeze({
  supported: true,
  reason: null,
  message: null,
  detail: null,
});

/**
 * Whether this WebGL2 context can run volumetric smoke. Cheap: extension and
 * limit queries only, no allocation. The result names the first missing
 * capability with a user-facing `message` and a technical `detail`.
 *
 * @param {WebGL2RenderingContext} gl
 * @returns {Readonly<{supported: boolean, reason: string|null,
 *   message: string|null, detail: string|null}>}
 */
export function detectSmokeSupport(gl) {
  if (!gl || typeof gl.getExtension !== 'function') {
    throw new TypeError('Smoke support detection requires a WebGL2 context.');
  }
  if (gl.getExtension('EXT_color_buffer_float') === null) {
    return unsupported(
      'color-buffer-float',
      `${NOT_AVAILABLE} its graphics driver can't draw into the high-precision `
        + `colour buffers the smoke cloud is built in. ${POINTS_WORK}`,
      'WebGL2 extension EXT_color_buffer_float is unavailable.'
    );
  }
  if (gl.getExtension('EXT_float_blend') === null) {
    return unsupported(
      'float-blend',
      `${NOT_AVAILABLE} its graphics driver can't blend high-precision `
        + `colour, which the smoke cloud needs to add up the cells. ${POINTS_WORK}`,
      'WebGL2 extension EXT_float_blend is unavailable.'
    );
  }
  const max3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
  if (!(max3D >= MAX_SMOKE_GRID_SIZE)) {
    return unsupported(
      'texture-3d-size',
      `${NOT_AVAILABLE} its graphics driver can't hold the smoke cloud's `
        + `volume. ${POINTS_WORK}`,
      `MAX_3D_TEXTURE_SIZE is ${max3D}; smoke needs ${MAX_SMOKE_GRID_SIZE}.`
    );
  }
  const max2D = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (!(max2D >= largestAtlasEdge())) {
    return unsupported(
      'texture-size',
      `${NOT_AVAILABLE} its graphics driver's textures are too small for the `
        + `smoke cloud. ${POINTS_WORK}`,
      `MAX_TEXTURE_SIZE is ${max2D}; smoke needs ${largestAtlasEdge()}.`
    );
  }
  return SUPPORTED;
}
