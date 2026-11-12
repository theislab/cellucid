/**
 * @module rendering/point-sprite
 *
 * How every cell's sprite is sized, one rule for the point shaders
 * (`POINT_SPRITE_GLSL` in every vertex shader that draws cells, highlight
 * rings and centroids), picking (`rendering/picking.js`) and the figure
 * export (`app/ui/modules/figure-export/utils/point-size.js`, and the export
 * rasterizer, which runs the same shaders): its size and the cap on it.
 *
 * A sprite is `mix(u_pointSize, u_pointSize · pointScale / eyeDepth, a)`
 * pixels (a: the perspective size scaling), clamped to
 * `[POINT_SPRITE_MIN_PX, cap]`. `POINT_SPRITE_MAX_PX` (160 px; 128 until
 * 2026-11-11, raised by the owner, F97) bounds the sprite of a cell near the
 * camera. It is the only fixed number; the GPU's own largest point
 * (`ALIASED_POINT_SIZE_RANGE`) bounds it from above wherever that is smaller
 * (`pointSpriteCap`), never more: asking for a larger point than the driver
 * allows is undefined, not clamped. Every pass sets the cap it draws with as
 * `u_pointSizeMax`; a figure export raster `s` times the screen sets `s`
 * times the viewer's cap (bounded by its own GPU), so a capped cell fills the
 * same share of the figure as of the screen.
 *
 * Nothing else depends on the camera's distance: a cell near the camera is
 * drawn whole and opaque, and picked, like any other. A near fade toward the
 * orbit target (an ordered-dither opacity from 0.5 to 0.2 of the focus
 * distance, F97) was shipped and removed the same day on the owner's
 * decision (2026-11-11: near cells must not fade); the browser spec
 * `point-near-camera-solid.spec.mjs` fails if any distance-based fade or
 * shrink returns.
 */

/** The smallest sprite drawn, in the pixels drawn into. */
export const POINT_SPRITE_MIN_PX = 0.5;

/**
 * The largest sprite the viewer draws, in device pixels, where the GPU
 * allows it (`pointSpriteCap`).
 */
export const POINT_SPRITE_MAX_PX = 160;

/**
 * Pixels per world unit of point size at unit eye depth (`u_pointScale`) for
 * a viewport `viewportHeight` pixels tall and a vertical field of view of
 * `fov` radians.
 *
 * @param {number} viewportHeight
 * @param {number} fov
 * @returns {number}
 */
export function pointScaleFor(viewportHeight, fov) {
  return (viewportHeight / Math.max(2 * Math.tan(fov * 0.5), 1e-6)) * 0.01;
}

/**
 * The GPU's largest point (`ALIASED_POINT_SIZE_RANGE[1]`), or null when the
 * context does not say.
 *
 * @param {WebGL2RenderingContext} gl
 * @returns {number|null}
 */
export function gpuPointSizeMax(gl) {
  const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
  const max = Array.isArray(range) || ArrayBuffer.isView(range) ? Number(range[1]) : Number.NaN;
  return Number.isFinite(max) && max > 0 ? max : null;
}

/**
 * The cap a viewer on this GPU draws with: `POINT_SPRITE_MAX_PX`, or the
 * GPU's largest point where that is smaller.
 *
 * @param {WebGL2RenderingContext} gl
 * @returns {number}
 */
export function pointSpriteCap(gl) {
  const gpu = gpuPointSizeMax(gl);
  return gpu === null ? POINT_SPRITE_MAX_PX : Math.min(POINT_SPRITE_MAX_PX, gpu);
}

/**
 * The diameter, in the pixels drawn into, the shaders draw a point at
 * (`pointSpriteSize` in `POINT_SPRITE_GLSL`).
 *
 * @param {number} eyeDepth - Distance in front of the camera (clip w)
 * @param {{pointSize: number, pointScale: number, sizeAttenuation: number, pointSizeMax: number}} sprite -
 *   `pointScale`: pixels per world unit of point size at unit depth
 *   (`writePointShaderFrame`)
 * @returns {number}
 */
export function pointSpriteSize(eyeDepth, { pointSize, pointScale, sizeAttenuation, pointSizeMax }) {
  const perspective = (pointSize * pointScale) / Math.max(eyeDepth, 0.001);
  // GLSL's mix(a, b, t) = a (1 - t) + b t, written as GLSL defines it.
  const mixed = pointSize * (1 - sizeAttenuation) + perspective * sizeAttenuation;
  return Math.min(Math.max(mixed, POINT_SPRITE_MIN_PX), pointSizeMax);
}

/**
 * GLSL for every vertex shader that sizes a point sprite. Declares
 * `u_pointSize`, `u_pointSizeMax`, `u_sizeAttenuation` and `u_pointScale`;
 * splice it at global scope, after the precision statement.
 * `pointSpriteSize(eyeDepth)` is the sprite's diameter.
 */
export const POINT_SPRITE_GLSL = `
// Point sprite sizing, shared by every point shader (rendering/point-sprite.js).
uniform float u_pointSize;
// The largest sprite this pass draws, in the pixels it draws into: the
// viewer's cap (rendering/point-sprite.js, bounded by the GPU), times a
// figure export's raster scale.
uniform float u_pointSizeMax;
uniform float u_sizeAttenuation;
// Pixels per world unit of point size at unit eye depth:
// viewportHeight / (2 tan(fov / 2)) * 0.01.
uniform float u_pointScale;

float pointSpriteSize(float eyeDepth) {
  float perspectiveSize = (u_pointSize * u_pointScale) / max(eyeDepth, 0.001);
  return clamp(mix(u_pointSize, perspectiveSize, u_sizeAttenuation), ${POINT_SPRITE_MIN_PX.toFixed(1)}, u_pointSizeMax);
}
`;
