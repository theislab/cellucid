/**
 * @fileoverview Atmospheric fog, reproduced for the vector export strategies.
 *
 * WHY THIS EXISTS
 * The viewer's `full` point shader fades every point toward `u_fogColor` and
 * lowers its alpha with distance from the camera (`HP_FS_FULL`,
 * `rendering/shaders/high-perf-shaders.js`). Fog is on by default —
 * `fogDensity` starts at 0.5 — and it is the strongest depth cue a 3D scatter
 * has: near points read saturated and opaque, far points read washed out.
 *
 * The PNG and hybrid-SVG paths run that shader, so they carry the cue. The
 * `full-vector` and `optimized-vector` SVG strategies project points in
 * JavaScript and used to emit every circle at its raw colour, producing a
 * figure in which foreground and background cells are indistinguishable. That
 * is not a cosmetic simplification: it flattens the depth axis of the data.
 *
 * WHAT IS AND IS NOT REPRODUCED
 * Reproduced exactly: the Beer-Lambert extinction, the colour blend toward the
 * fog colour, and the `(0.1 + 0.9 * transmittance)` alpha law.
 *
 * Not reproduced: the sphere-impostor lighting term (`u_lightingStrength`),
 * which varies across each point sprite and has no flat-disc equivalent. It is
 * applied identically to every point regardless of depth, so it changes the
 * figure's overall shading but never the relative reading of one cell against
 * another. The export dialog states this beside the strategy control.
 *
 * @module ui/modules/figure-export/utils/fog
 */

/** Only the `full` shader variant carries fog; `light`/`ultralight` have none. */
const FOGGED_SHADER_QUALITY = 'full';

/** `alpha = (FOG_ALPHA_FLOOR + FOG_ALPHA_RANGE * transmittance) * v_alpha`. */
const FOG_ALPHA_FLOOR = 0.1;
const FOG_ALPHA_RANGE = 0.9;

/** `extinction = u_fogDensity * u_fogDensity * FOG_EXTINCTION_SCALE`. */
const FOG_EXTINCTION_SCALE = 0.6;

/** `fogSpan = max(u_fogFar - u_fogNear, MIN_FOG_SPAN)`. */
const MIN_FOG_SPAN = 0.0001;

/**
 * @typedef {object} FogEvaluator
 * @property {number} fogR - 0..255
 * @property {number} fogG - 0..255
 * @property {number} fogB - 0..255
 * @property {(x: number, y: number, z: number) => number} transmittanceAt
 */

/**
 * Build the fog evaluator for one render state, or null when the state carries
 * no fog at all — in which case the shader's own output is the raw colour and
 * an unfogged vector circle is already exact.
 *
 * @param {object|null} renderState
 * @returns {FogEvaluator|null}
 */
export function createFogEvaluator(renderState) {
  if (renderState === null || typeof renderState !== 'object') return null;
  if (renderState.shaderQuality !== FOGGED_SHADER_QUALITY) return null;

  const fogDensity = renderState.fogDensity;
  const fogNear = renderState.fogNear;
  const fogFar = renderState.fogFar;
  const fogColor = renderState.fogColor;
  const view = renderState.viewMatrix;
  const model = renderState.modelMatrix;
  if (
    !Number.isFinite(fogDensity) ||
    !Number.isFinite(fogNear) ||
    !Number.isFinite(fogFar) ||
    !(fogColor?.length >= 3) ||
    !(view?.length === 16) ||
    !(model?.length === 16)
  ) {
    return null;
  }

  const extinction = fogDensity * fogDensity * FOG_EXTINCTION_SCALE;
  if (extinction === 0) return null;

  // The shader reads `length(eyePos.xyz)` where `eyePos = u_viewMatrix *
  // u_modelMatrix * position`; folding the two matrices keeps that one
  // multiply per point.
  const mv = new Float64Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += view[k * 4 + row] * model[column * 4 + k];
      }
      mv[column * 4 + row] = sum;
    }
  }

  const fogSpan = Math.max(fogFar - fogNear, MIN_FOG_SPAN);

  return {
    fogR: Math.round(Math.max(0, Math.min(1, fogColor[0])) * 255),
    fogG: Math.round(Math.max(0, Math.min(1, fogColor[1])) * 255),
    fogB: Math.round(Math.max(0, Math.min(1, fogColor[2])) * 255),
    transmittanceAt(x, y, z) {
      const ex = mv[0] * x + mv[4] * y + mv[8] * z + mv[12];
      const ey = mv[1] * x + mv[5] * y + mv[9] * z + mv[13];
      const ez = mv[2] * x + mv[6] * y + mv[10] * z + mv[14];
      const distance = Math.sqrt(ex * ex + ey * ey + ez * ez);
      const normalized = Math.max(distance - fogNear, 0) / fogSpan;
      return Math.exp(-extinction * normalized);
    },
  };
}

/**
 * The alpha the viewer shows for a point at the given transmittance.
 *
 * @param {number} transmittance
 * @param {number} alpha
 * @returns {number}
 */
export function applyFogAlpha(transmittance, alpha) {
  return (FOG_ALPHA_FLOOR + FOG_ALPHA_RANGE * transmittance) * alpha;
}

/**
 * `mix(fogColor, channel, transmittance)` on one 0..255 channel.
 *
 * @param {number} fogChannel
 * @param {number} channel
 * @param {number} transmittance
 * @returns {number}
 */
export function applyFogChannel(fogChannel, channel, transmittance) {
  return Math.round(fogChannel + (channel - fogChannel) * transmittance);
}
