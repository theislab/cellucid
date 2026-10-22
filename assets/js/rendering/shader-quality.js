/**
 * The shader qualities the point renderer offers: one list, read by every
 * layer that names them (the renderer's validators, the sidebar control, the
 * session publication, the highlight styles and the figure export), so adding
 * or removing a quality is a change to this file and to the shaders, not a
 * hunt for the copies.
 *
 * The order is the order of the sidebar control. `full` is first because it is
 * the default.
 */

/** Every accepted value of `#hp-shader-quality`, in control order. */
export const SHADER_QUALITIES = Object.freeze([
  'full',
  'sculpted',
  'light',
  'ultralight',
]);

/** The quality a new viewer starts in. */
export const DEFAULT_SHADER_QUALITY = 'full';

/**
 * What each quality draws, for the consumers that reproduce or depend on it
 * outside the shaders:
 *
 * - `fog`: points fade toward the fog colour with distance (the figure export's
 *   vector strategies reproduce it);
 * - `fogAlpha`: fog also thins the point, by `(0.1 + 0.9 * transmittance)`;
 *   a sculpted point is opaque and fog only recolours it;
 * - `sphere`: points are shaded as lit spheres (the orbit anchor draws its 3-D
 *   compass to match).
 */
export const SHADER_QUALITY_TRAITS = Object.freeze({
  full: Object.freeze({ fog: true, fogAlpha: true, sphere: true }),
  sculpted: Object.freeze({ fog: true, fogAlpha: false, sphere: true }),
  light: Object.freeze({ fog: false, fogAlpha: false, sphere: false }),
  ultralight: Object.freeze({ fog: false, fogAlpha: false, sphere: false }),
});

const DESCRIBED_QUALITIES = `${SHADER_QUALITIES.slice(0, -1)
  .map(quality => `"${quality}"`)
  .join(', ')}, or "${SHADER_QUALITIES.at(-1)}"`;

/** Whether `value` is exactly one of the shader qualities. */
export function isShaderQuality(value) {
  return SHADER_QUALITIES.includes(value);
}

/**
 * The quality list as prose, for refusals: `"full", "sculpted", "light", or
 * "ultralight"`.
 */
export function describeShaderQualities() {
  return DESCRIBED_QUALITIES;
}
