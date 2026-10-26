/**
 * Atmospheric fog: the one model every fogged layer draws with.
 *
 * Points, highlight rings, connectivity edges, the orbit anchor and the
 * velocity overlay all used to restate the fog law inline, each with slightly
 * different terms (one by eye depth instead of distance, one squared, one with
 * its own alpha floor), so the layers of one scene faded at different rates.
 * They now splice in `FOG_GLSL` and read the same two uniforms, which the CPU
 * derives once per pane with `writeFogUniforms`.
 *
 * Fog depends only on the distance from the camera. That is constant across a
 * point sprite and linear enough along an edge's segment, so every shader
 * evaluates it in the vertex stage, once per point or endpoint, and hands the
 * transmittance on as a varying: no `exp`, no distance and no division runs
 * per fragment. The exponential is an `exp2` whose constant
 * (`log2(e) * extinction / span`) is pre-multiplied on the CPU, and fog that
 * is off sends a scale of zero, for which the term is exactly one.
 *
 * Fog fades a translucent layer toward whatever lies behind it, through its
 * opacity, rather than mixing its colour toward one constant fog colour. A
 * backdrop is not one colour — a grid, a vignette, the points further back —
 * and mixing toward a constant tinted every fogged point with a colour that
 * was not behind it. `fogOpacity(T) = T * (0.1 + 0.9 T)` is chosen so that
 * over a backdrop of the fog colour the picture is exactly the one the old
 * colour-mixing law drew: `a T c + (1 - a T) bg` with `a = 0.1 + 0.9 T`.
 * Only an opaque layer (the `sculpted` points, which antialias through a
 * multisample coverage mask and cannot be thinned) still mixes toward the fog
 * colour.
 */

/** `extinction = density^2 * FOG_EXTINCTION_SCALE`, per unit of the fog span. */
export const FOG_EXTINCTION_SCALE = 0.6;

/** The fog span never collapses below this, in world units. */
export const MIN_FOG_SPAN = 0.0001;

/**
 * GLSL for every fogged shader. Declares `u_fogNear` and `u_fogScale`; splice
 * it at global scope, after the precision statement.
 */
export const FOG_GLSL = `
// Atmospheric fog (Beer-Lambert), shared by every fogged layer (fog-shaders.js).
// u_fogScale = log2(e) * extinction / span, zero when fog is off.
uniform float u_fogNear;
uniform float u_fogScale;

float fogTransmittance(float viewDistance) {
  return exp2(-u_fogScale * max(viewDistance - u_fogNear, 0.0));
}

// The opacity fog leaves a translucent layer: it fades toward what is behind.
float fogOpacity(float transmittance) {
  return transmittance * (0.1 + 0.9 * transmittance);
}
`;

/**
 * The scale `fogTransmittance` multiplies distance by.
 *
 * @param {number} fogDensity - The `Atmospheric fog` slider value.
 * @param {number} fogNear - Distance at which fog begins.
 * @param {number} fogFar - Distance at which the fog span ends.
 * @returns {number}
 */
export function fogScale(fogDensity, fogNear, fogFar) {
  const span = Math.max(fogFar - fogNear, MIN_FOG_SPAN);
  return (fogDensity * fogDensity * FOG_EXTINCTION_SCALE * Math.LOG2E) / span;
}

/**
 * Publish one pane's fog to a program that splices `FOG_GLSL`. A location the
 * program does not declare (null) is skipped.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLUniformLocation|null} nearLocation - `u_fogNear`.
 * @param {WebGLUniformLocation|null} scaleLocation - `u_fogScale`.
 * @param {number} fogDensity
 * @param {number} fogNear
 * @param {number} fogFar
 */
export function writeFogUniforms(
  gl,
  nearLocation,
  scaleLocation,
  fogDensity,
  fogNear,
  fogFar
) {
  if (nearLocation !== null) gl.uniform1f(nearLocation, fogNear);
  if (scaleLocation !== null) {
    gl.uniform1f(scaleLocation, fogScale(fogDensity, fogNear, fogFar));
  }
}

/** `fogOpacity` in JavaScript. */
export function fogOpacityAt(transmittance) {
  return transmittance * (0.1 + 0.9 * transmittance);
}
