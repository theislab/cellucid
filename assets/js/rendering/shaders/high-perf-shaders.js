/**
 * HIGH-PERFORMANCE SHADERS (WebGL2 Only)
 * =======================================
 * Optimized shaders for rendering 5-10+ million points.
 *
 * Features:
 * - WebGL2 with GLSL ES 3.0
 * - Instancing support for efficient rendering
 * - GPU-only fog calculations (no CPU distance sampling)
 * - Lightweight variants for maximum FPS
 * - Separate position (Float32, 1-3 components) and color (RGBA8) vertex
 *   streams; a 1-D or 2-D stream feeds the vec3 input, and WebGL supplies 0
 *   for the axes it does not carry
 */

import { FOG_GLSL } from './fog-shaders.js';
import { LINEAR_TEXEL_GLSL } from '../linear-texture.js';

// ============================================================================
// WEBGL2 SHADERS (GLSL ES 3.0)
// ============================================================================

/**
 * Highest dimension level drawn without depth. Every 1-D and 2-D view lies in
 * one plane, where a depth test would only turn submission order into
 * artefacts, so those passes neither test nor write depth and draw with a
 * quality's `_NO_DEPTH` fragment shader. The viewer and the figure export
 * both decide by this one value, so an exported 2-D figure is drawn the way
 * the screen draws it.
 */
export const NO_DEPTH_MAX_DIMENSION = 2;

/**
 * The `full` quality's lighting: a lit sphere is `ambient + diffuse · N·L`
 * times its colour, plus a white highlight. The two weights sum to 1, so the
 * side facing the light shows the colour itself and the side away from it
 * keeps `ambient` of it. Shared by the point passes, the `full` highlight
 * ring and the centroid markers, so they shade alike.
 */
export const FULL_LIGHTING = Object.freeze({ ambient: 0.5, diffuse: 0.5 });
const FULL_AMBIENT_GLSL = FULL_LIGHTING.ambient.toFixed(2);
const FULL_DIFFUSE_GLSL = FULL_LIGHTING.diffuse.toFixed(2);

/**
 * Uniforms every point vertex shader shares, derived once per draw on the CPU
 * by `writePointShaderFrame` below rather than once per vertex on the GPU.
 *
 * A vertex shader runs once per point, ten million times a frame for a large
 * dataset, and in a 3-D view it is most of the frame: depth testing kills
 * nearly every fragment before it is shaded, so what remains is per-vertex
 * work. Anything that depends only on uniforms is therefore computed here:
 *
 *  - `u_modelViewMatrix` replaces `u_viewMatrix *
 *    u_modelMatrix * position`, which GLSL evaluates left to right as a full
 *    4x4 matrix product per vertex before the matrix-vector one;
 *  - `u_pointScale` replaces `u_viewportHeight / (2 tan(u_fov / 2)) * 0.01`,
 *    a tangent and two divisions per vertex;
 *  - `u_halfDir` replaces the per-fragment `normalize(u_lightDir + view)`.
 */

/**
 * Full-featured vertex shader: sphere lighting and fog.
 * Alpha is fetched from a separate texture for efficient updates (avoids full buffer rebuild)
 *
 * Fog depends only on the point's distance from the camera, so it is
 * evaluated here, once per point, with the shared model in fog-shaders.js, and
 * handed to every fragment of the sprite as a flat value instead of being
 * recomputed (an exponential and a division) for each of them.
 */
export const HP_VS_FULL = `#version 300 es
precision highp float;

// Two vertex streams: position (float32, 1-3 components; missing axes read as 0)
// and color.rgba (uint8 normalized)
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color; // RGBA packed, auto-normalized by WebGL

uniform mat4 u_modelViewMatrix;
uniform mat4 u_projectionMatrix;
uniform float u_pointSize;
// The largest sprite this pass may draw, in the pixels it is drawing into.
// A figure export rasterises the same scene at a multiple of the screen
// size, so a fixed cap would clamp a point at a different fraction of the
// image than it occupies on screen, and the exported figure would stop
// being the view it claims to reproduce. Zero means unset, and the floor
// below keeps that behaving exactly as the fixed cap did.
uniform float u_pointSizeMax;
uniform float u_sizeAttenuation;
// Pixels per world unit of point size at unit eye depth:
// viewportHeight / (2 tan(fov / 2)) * 0.01.
uniform float u_pointScale;

${FOG_GLSL}
// Alpha in source order, one R8 texel a point, as a linear texture
// (rendering/linear-texture.js), for alpha-only updates.
uniform lowp sampler2DArray u_alphaTex;
uniform ivec2 u_alphaLayout;
uniform bool u_useAlphaTex;
// The store order's slot map (slot -> source point), R32UI, so the alpha of
// a point drawn from a reordered store is found exactly at any index. Slots
// from u_orderedSlots on hold their own point (rendering/high-perf/
// store-order.js); 0 for a store in source order.
uniform highp usampler2DArray u_lodIndexTex;
uniform ivec2 u_lodIndexLayout;
uniform int u_orderedSlots;
// The first slot of the store segment drawn: gl_VertexID counts from it
// (rendering/high-perf/point-store-segments.js).
uniform int u_slotBase;
${LINEAR_TEXEL_GLSL}

flat out vec3 v_color;
flat out float v_alpha;
flat out float v_radiusPx;
// Fog transmittance (1 is unfogged), and the opacity it leaves a translucent
// point (fog-shaders.js). Full thins the point by the opacity; Sculpted is
// opaque and mixes its colour by the transmittance.
flat out float v_fogT;
flat out float v_fogOpacity;

void main() {
  vec4 eyePos = u_modelViewMatrix * vec4(a_position, 1.0);
  gl_Position = u_projectionMatrix * eyePos;

  float eyeDepth = -eyePos.z;

  // Fetch alpha from texture if enabled, otherwise use vertex attribute
  float alpha;
  if (u_useAlphaTex) {
    // Integer addressing throughout: a float index loses exactness at 2^24.
    int slot = u_slotBase + gl_VertexID;
    int origIdx = slot < u_orderedSlots
      ? int(texelFetch(u_lodIndexTex, linearTexel(slot, u_lodIndexLayout), 0).r)
      : slot;
    alpha = texelFetch(u_alphaTex, linearTexel(origIdx, u_alphaLayout), 0).r;
  } else {
    alpha = a_color.a;
  }

  // Perspective point size with attenuation
  float perspectiveSize = (u_pointSize * u_pointScale) / max(eyeDepth, 0.001);
  gl_PointSize = mix(u_pointSize, perspectiveSize, u_sizeAttenuation);
  gl_PointSize = clamp(gl_PointSize, 0.5, max(u_pointSizeMax, 128.0));

  // Reject invisible points before rasterisation.
  //
  // Shrinking the point is not enough: ALIASED_POINT_SIZE_RANGE starts at 1.0
  // on this driver, so gl_PointSize = 0.0 is clamped back to one pixel and the
  // point is assembled, rasterised, and shaded before the fragment discard
  // throws it away. Moving the vertex outside the clip volume rejects it up
  // front, which is what makes hiding cells cheaper than showing them instead
  // of more expensive. The size is still zeroed as a second line of defence.
  if (alpha < 0.01) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }

  v_fogT = fogTransmittance(length(eyePos.xyz));
  v_fogOpacity = fogOpacity(v_fogT);

  v_color = a_color.rgb;
  v_alpha = alpha;
  // Sprite radius in pixels, for the antialiased rim of the no-depth fragment
  // shaders (see HP_FS_FULL_NO_DEPTH).
  v_radiusPx = 0.5 * gl_PointSize;
}
`;

/**
 * Full-featured fragment shader: Blinn-Phong sphere and fog, for passes that
 * test and write depth (3-D views). HP_FS_FULL_NO_DEPTH draws 1-D and 2-D
 * views.
 *
 * The disc edge here stays hard. A partially covered rim fragment would still
 * write depth, so every point drawn after it and behind it is rejected from
 * that pixel and the background shows through: in a dense cloud each disc
 * grew a light ring of background colour. Only a pass without depth can
 * soften the edge, and the no-depth variants do.
 */
export const HP_FS_FULL = `#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;
flat in float v_fogOpacity;

uniform float u_lightingStrength;
uniform vec3 u_lightDir;
uniform vec3 u_halfDir;

out vec4 fragColor;

void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  // One discard for both cases — a hidden point (second line of defence
  // behind HP_VS_FULL's clip-volume rejection) and a sprite corner outside the
  // disc. Two separate discards, the first ahead of everything else, cost 12 %
  // of a dense antialiased 2-D frame (1M points, 4x MSAA, ANGLE Metal on an
  // Apple M1 Pro: 35.6 ms against 31.4 ms) for the same pixels.
  if (v_alpha < 0.01 || r2 > 1.0) discard;

  // Sphere normal for lighting
  vec3 normal = vec3(coord.x, -coord.y, sqrt(1.0 - r2));

  // Blinn-Phong (FULL_LIGHTING), white specular of exponent 32 (five
  // squarings) and weight 0.3.
  float NdotL = max(dot(normal, u_lightDir), 0.0);
  float specular = max(dot(normal, u_halfDir), 0.0);
  specular *= specular; specular *= specular; specular *= specular;
  specular *= specular; specular *= specular;
  vec3 litColor = v_color * (${FULL_AMBIENT_GLSL} + ${FULL_DIFFUSE_GLSL} * NdotL) + vec3(specular * 0.3);
  vec3 shadedColor = mix(v_color, litColor, u_lightingStrength);

  // Fog thins the point toward whatever is behind it (fog-shaders.js).
  fragColor = vec4(shadedColor, v_alpha * v_fogOpacity);
}
`;

/**
 * HP_FS_FULL for a pass that neither tests nor writes depth — every 1-D and
 * 2-D view. No discard: see HP_FS_LIGHT_NO_DEPTH for why a zero-alpha fragment
 * is the same pixel and cheaper.
 *
 * The rim is antialiased. Coverage is 1 inside the disc, falls across one
 * pixel centred on the edge, and is 0 beyond it. MSAA cannot smooth this edge
 * itself, because a fragment shader runs once per pixel and a discard (or a
 * zero alpha) removes every sample of it, so the disc used to be a hard,
 * jagged staircase on a DPR-1 screen, antialiasing on or off. `(1 - r^2) / 2`
 * is the distance from the edge in sprite units to first order, exact at the
 * rim where it matters. The ramp is one pixel wide from a radius of four pixels
 * up and narrows below that (`rimSharpness`): a disc of a few pixels has no
 * edge to smooth, and softening it would only fade the smallest points of a
 * dense embedding. The radius comes from the vertex shader rather than from
 * screen-space derivatives, which are undefined along a sprite's edge, where
 * a 2x2 quad straddles pixels the point does not cover.
 */
export const HP_FS_FULL_NO_DEPTH = `#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;
flat in float v_fogOpacity;

uniform float u_lightingStrength;
uniform vec3 u_lightDir;
uniform vec3 u_halfDir;

out vec4 fragColor;

// Pixels per unit of (1 - r^2) / 2 across the disc rim: one pixel wide from a
// radius of four pixels, narrower below so the smallest points stay crisp.
float rimSharpness(float radiusPx) {
  return 0.5 * max(radiusPx, 8.0 - radiusPx);
}

void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  float coverage = clamp((1.0 - r2) * rimSharpness(v_radiusPx) + 0.5, 0.0, 1.0);
  // The cases in which HP_FS_FULL discards, as a fragment that blends to
  // nothing: a hidden point and the sprite corners outside the disc.
  bool covered = v_alpha >= 0.01 && coverage > 0.0;

  vec3 normal = vec3(coord.x, -coord.y, sqrt(max(1.0 - r2, 0.0)));
  float NdotL = max(dot(normal, u_lightDir), 0.0);
  float specular = max(dot(normal, u_halfDir), 0.0);
  specular *= specular; specular *= specular; specular *= specular;
  specular *= specular; specular *= specular;
  vec3 litColor = v_color * (${FULL_AMBIENT_GLSL} + ${FULL_DIFFUSE_GLSL} * NdotL) + vec3(specular * 0.3);
  vec3 shadedColor = mix(v_color, litColor, u_lightingStrength);

  // Fog thins the point toward whatever is behind it (fog-shaders.js).
  fragColor = covered ? vec4(shadedColor, v_alpha * v_fogOpacity * coverage) : vec4(0.0);
}
`;

/**
 * LIGHTWEIGHT vertex shader - minimal calculations for maximum FPS
 * Alpha is fetched from a separate texture for efficient updates
 */
export const HP_VS_LIGHT = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color; // RGBA packed, auto-normalized by WebGL

uniform mat4 u_modelViewMatrix;
uniform mat4 u_projectionMatrix;
uniform float u_pointSize;
// The largest sprite this pass may draw, in the pixels it is drawing into.
// A figure export rasterises the same scene at a multiple of the screen
// size, so a fixed cap would clamp a point at a different fraction of the
// image than it occupies on screen, and the exported figure would stop
// being the view it claims to reproduce. Zero means unset, and the floor
// below keeps that behaving exactly as the fixed cap did.
uniform float u_pointSizeMax;
uniform float u_sizeAttenuation;
// Pixels per world unit of point size at unit eye depth; see HP_VS_FULL.
uniform float u_pointScale;

// Alpha in source order, one R8 texel a point, as a linear texture
// (rendering/linear-texture.js), for alpha-only updates.
uniform lowp sampler2DArray u_alphaTex;
uniform ivec2 u_alphaLayout;
uniform bool u_useAlphaTex;
// The store order's slot map (slot -> source point), R32UI, so the alpha of
// a point drawn from a reordered store is found exactly at any index. Slots
// from u_orderedSlots on hold their own point (rendering/high-perf/
// store-order.js); 0 for a store in source order.
uniform highp usampler2DArray u_lodIndexTex;
uniform ivec2 u_lodIndexLayout;
uniform int u_orderedSlots;
// The first slot of the store segment drawn: gl_VertexID counts from it
// (rendering/high-perf/point-store-segments.js).
uniform int u_slotBase;
${LINEAR_TEXEL_GLSL}

flat out vec3 v_color;
flat out float v_alpha;
flat out float v_radiusPx;

void main() {
  // The same two products as HP_VS_FULL, not one model-view-projection
  // product: depth is then bit-identical across qualities, so the same point
  // wins every near-tie in every quality.
  vec4 eyePos = u_modelViewMatrix * vec4(a_position, 1.0);
  gl_Position = u_projectionMatrix * eyePos;

  float eyeDepth = -eyePos.z;

  // Fetch alpha from texture if enabled
  float alpha;
  if (u_useAlphaTex) {
    // Integer addressing throughout: a float index loses exactness at 2^24.
    int slot = u_slotBase + gl_VertexID;
    int origIdx = slot < u_orderedSlots
      ? int(texelFetch(u_lodIndexTex, linearTexel(slot, u_lodIndexLayout), 0).r)
      : slot;
    alpha = texelFetch(u_alphaTex, linearTexel(origIdx, u_alphaLayout), 0).r;
  } else {
    alpha = a_color.a;
  }

  float perspectiveSize = (u_pointSize * u_pointScale) / max(eyeDepth, 0.001);
  gl_PointSize = mix(u_pointSize, perspectiveSize, u_sizeAttenuation);
  // Identical bounds to HP_VS_FULL, and to the copy HP_VS_HIGHLIGHT keeps of
  // this formula. Shader quality selects shading, never geometry: a higher
  // ceiling here made "light" and "ultralight" draw larger points than "full"
  // at close range, which is both a different picture and — because point area
  // is quadratic in the size — more fill. The old 192.0 measured 1.23x the GPU
  // frame time of this at point size 40 and 1.90x at 60, so the two faster
  // shaders were the slower ones exactly where speed is wanted.
  gl_PointSize = clamp(gl_PointSize, 0.5, max(u_pointSizeMax, 128.0));

  // Reject invisible points before rasterisation — see HP_VS_FULL. This shader
  // also backs the ultralight program, whose fragment shader does not discard,
  // so without the clip rejection a hidden point still writes depth and
  // occludes the visible points behind it.
  if (alpha < 0.01) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }

  v_color = a_color.rgb;
  v_alpha = alpha;
  // Sprite radius in pixels, for the antialiased rim of the no-depth fragment
  // shaders (see HP_FS_FULL_NO_DEPTH).
  v_radiusPx = 0.5 * gl_PointSize;
}
`;

/**
 * LIGHTWEIGHT fragment shader - flat disc, no lighting, no fog. Hard edge for
 * the reason HP_FS_FULL gives; HP_FS_LIGHT_NO_DEPTH antialiases it.
 */
export const HP_FS_LIGHT = `#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;

out vec4 fragColor;

void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  // One discard for a hidden point and a corner outside the disc; see
  // HP_FS_FULL.
  if (v_alpha < 0.01 || r2 > 1.0) discard;

  fragColor = vec4(v_color, v_alpha);
}
`;

/**
 * HP_FS_LIGHT for a pass that neither tests nor writes depth — every 1-D and
 * 2-D view, which the renderer draws with DEPTH_TEST disabled.
 *
 * It covers exactly the pixels HP_FS_LIGHT covers, with the same color, but
 * never discards: where HP_FS_LIGHT discards, it writes alpha 0 instead. Under
 * the straight-alpha blend every point pass uses (SRC_ALPHA, ONE_MINUS_SRC_ALPHA
 * for color; ONE, ONE_MINUS_SRC_ALPHA for alpha) a zero-alpha fragment leaves
 * the destination exactly as it was, so the frame is byte-identical. What
 * changes is the cost: a shader that may discard makes the GPU resolve each
 * fragment's coverage before it can blend the next one into the same pixel,
 * and in a dense 2-D embedding drawn with antialiasing that serialisation was
 * most of the frame (1M points, 4x MSAA: 30 ms with the discard, 17 ms
 * without, ANGLE Metal on an Apple M1 Pro).
 *
 * Only a pass without depth may use it. With depth writes on, the zero-alpha
 * corners and hidden points would write depth and occlude what lies behind
 * them, which is why HP_FS_LIGHT keeps its discards.
 */
export const HP_FS_LIGHT_NO_DEPTH = `#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;

out vec4 fragColor;

// Pixels per unit of (1 - r^2) / 2 across the disc rim: one pixel wide from a
// radius of four pixels, narrower below so the smallest points stay crisp.
float rimSharpness(float radiusPx) {
  return 0.5 * max(radiusPx, 8.0 - radiusPx);
}

void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  float coverage = clamp((1.0 - r2) * rimSharpness(v_radiusPx) + 0.5, 0.0, 1.0);
  // The cases in which HP_FS_LIGHT discards, as a fragment that blends to
  // nothing: a hidden point (the vertex shader has already moved it out of
  // the clip volume, so this is the second line of defence), and the sprite
  // corners outside the disc. The rim between is antialiased; see
  // HP_FS_FULL_NO_DEPTH.
  bool covered = v_alpha >= 0.01 && coverage > 0.0;
  fragColor = covered ? vec4(v_color, v_alpha * coverage) : vec4(0.0);
}
`;

/**
 * ULTRA-LIGHTWEIGHT fragment shader - square points for absolute maximum FPS
 */
export const HP_FS_ULTRALIGHT = `#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;

out vec4 fragColor;

void main() {
  fragColor = vec4(v_color, v_alpha);
}
`;

// ============================================================================
// SCULPTED: soft studio lighting on antialiased sphere impostors
// ============================================================================

/**
 * The sculpted look's lighting constants, shared by the shaders below and by
 * `sculptedCenterShade`, which normalises the lighting so a sphere's centre
 * shows exactly the colour the legend shows.
 *
 * Lighting is evaluated on linear colour, approximated as the square of the
 * display value and encoded back with a square root: an exact round trip, so
 * the centre's colour survives untouched, and two multiplies instead of two
 * `pow` calls per fragment.
 */
const SCULPTED = Object.freeze({
  // Hemisphere ambient: a neutral sky above, a dimmer bounce below.
  skyAmbient: 1.0,
  groundAmbient: 0.5,
  ambientWeight: 0.25,
  // Wrapped Lambert keyed to the scene light: the terminator rolls off softly
  // instead of cutting the sphere in half.
  wrap: 0.25,
  diffuseWeight: 1.0,
  // The sphere's own occlusion toward its silhouette: what makes a dot read as
  // a ball and separates touching balls in a dense cloud.
  edgeOcclusion: 0.22,
  // A soft gloss in place of a hard white specular. It fades out on sprites
  // too small to show it, where it would only glitter.
  sheenWeight: 0.45,
});

const GLSL_FLOAT = value => {
  const text = String(value);
  return text.includes('.') || text.includes('e') ? text : `${text}.0`;
};

const SCULPTED_SHADING_GLSL = `
// Pixels per unit of (1 - r^2) / 2 across the disc rim; see
// HP_FS_FULL_NO_DEPTH.
float rimSharpness(float radiusPx) {
  return 0.5 * max(radiusPx, 8.0 - radiusPx);
}

// Sculpted lighting of one sphere normal, in linear light, before the
// centre normalisation. Mirrors sculptedCenterShade() in JavaScript.
float sculptedShade(vec3 normal, out float sky) {
  sky = normal.y * 0.5 + 0.5;
  float ambient = mix(${GLSL_FLOAT(SCULPTED.groundAmbient)}, ${GLSL_FLOAT(SCULPTED.skyAmbient)}, sky);
  float wrapped = clamp(
    (dot(normal, u_lightDir) + ${GLSL_FLOAT(SCULPTED.wrap)}) * ${GLSL_FLOAT(1 / (1 + SCULPTED.wrap))},
    0.0,
    1.0
  );
  float occlusion = mix(${GLSL_FLOAT(SCULPTED.edgeOcclusion)}, 1.0, smoothstep(0.0, 0.75, normal.z));
  return (
    ${GLSL_FLOAT(SCULPTED.ambientWeight)} * ambient +
    ${GLSL_FLOAT(SCULPTED.diffuseWeight)} * wrapped * wrapped
  ) * occlusion;
}

vec3 sculptedColor(vec2 coord, float r2) {
  // The antialiased rim reaches half a pixel past the silhouette; there the
  // normal is the silhouette's own, not a longer-than-unit vector that would
  // light the rim brighter than the sphere.
  vec2 disc = coord * inversesqrt(max(r2, 1.0));
  vec3 normal = vec3(disc.x, -disc.y, sqrt(max(1.0 - r2, 0.0)));
  vec3 albedo = v_color * v_color;
  float sky;
  float shade = sculptedShade(normal, sky) * u_invCenterShade;
  // Gloss: exponent 32 (five squarings), faded in between sprite radii of two
  // and six pixels.
  float gloss = max(dot(normal, u_halfDir), 0.0);
  gloss *= gloss; gloss *= gloss; gloss *= gloss; gloss *= gloss; gloss *= gloss;
  gloss *= smoothstep(2.0, 6.0, v_radiusPx);
  vec3 lit = albedo * shade
    + (${GLSL_FLOAT(SCULPTED.sheenWeight)} * gloss) * mix(vec3(1.0), albedo, 0.25);
  vec3 shaded = sqrt(lit);
  return mix(u_fogColor, mix(v_color, shaded, u_lightingStrength), v_fogT);
}
`;

/**
 * Sculpted fragment shader for passes that test and write depth (3-D views).
 *
 * A sculpted point is opaque, so its depth pass replaces the colour rather
 * than blending it (`enterOpaquePointBlending`), and fog fades the colour
 * toward the fog colour rather than thinning the point. That is what lets the
 * edge be antialiased with depth on.
 * With multisampling the pass enables SAMPLE_ALPHA_TO_COVERAGE and the
 * fragment's coverage of the disc becomes its sample mask: every sample keeps
 * its own depth, so the soft rim never lets the background through behind a
 * nearer point, which is exactly what a blended rim does (see HP_FS_FULL).
 * `u_coverageFloor` is 0 there. Single-sampled, there is no mask to write,
 * and the floor of 0.5 discards the outer half of the ramp: the same hard edge
 * as every other quality, written at full alpha.
 */
export const HP_FS_SCULPTED = `#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;
flat in float v_fogT;

uniform float u_lightingStrength;
uniform vec3 u_fogColor;
uniform vec3 u_lightDir;
uniform vec3 u_halfDir;
uniform float u_invCenterShade;
uniform float u_coverageFloor;

out vec4 fragColor;
${SCULPTED_SHADING_GLSL}
void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  float coverage = clamp((1.0 - r2) * rimSharpness(v_radiusPx) + 0.5, 0.0, 1.0);
  // One discard: a hidden point (second line of defence behind HP_VS_FULL's
  // clip-volume rejection) and a fragment outside the disc's coverage.
  if (v_alpha < 0.01 || coverage <= u_coverageFloor) discard;
  fragColor = vec4(
    sculptedColor(coord, r2),
    u_coverageFloor > 0.0 ? 1.0 : coverage
  );
}
`;

/**
 * HP_FS_SCULPTED for a pass that neither tests nor writes depth — every 1-D
 * and 2-D view. Blended like every no-depth pass, with the antialiased rim as
 * alpha; no discard, for the reason HP_FS_LIGHT_NO_DEPTH gives.
 */
export const HP_FS_SCULPTED_NO_DEPTH = `#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;
flat in float v_fogT;

uniform float u_lightingStrength;
uniform vec3 u_fogColor;
uniform vec3 u_lightDir;
uniform vec3 u_halfDir;
uniform float u_invCenterShade;

out vec4 fragColor;
${SCULPTED_SHADING_GLSL}
void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  float coverage = clamp((1.0 - r2) * rimSharpness(v_radiusPx) + 0.5, 0.0, 1.0);
  bool covered = v_alpha >= 0.01 && coverage > 0.0;
  fragColor = covered ? vec4(sculptedColor(coord, r2), v_alpha * coverage) : vec4(0.0);
}
`;

/**
 * The sculpted shading of a sphere's centre (normal (0, 0, 1)) for this
 * light: its reciprocal is `u_invCenterShade`, which makes the centre of every
 * sculpted point exactly the colour the legend shows. Mirrors
 * `sculptedShade` in SCULPTED_SHADING_GLSL.
 *
 * @param {ArrayLike<number>} lightDir - Unit light direction in eye space.
 * @returns {number}
 */
export function sculptedCenterShade(lightDir) {
  const sky = 0.5;
  const ambient =
    SCULPTED.groundAmbient + (SCULPTED.skyAmbient - SCULPTED.groundAmbient) * sky;
  const wrapped = Math.min(
    1,
    Math.max(0, (lightDir[2] + SCULPTED.wrap) / (1 + SCULPTED.wrap))
  );
  return (
    SCULPTED.ambientWeight * ambient +
    SCULPTED.diffuseWeight * wrapped * wrapped
  );
}

const FOV_SCALE_FLOOR = 1e-6;

/**
 * Derive the per-draw uniforms the point shaders share (see the top of this
 * section) into caller-owned scratch, so a frame allocates nothing.
 *
 * @param {{modelView: Float32Array, halfDir: Float32Array, invCenterShade: number}} target
 *   `modelView` is a Float32Array(16), `halfDir` a Float32Array(3);
 *   `invCenterShade` receives `u_invCenterShade` (see sculptedCenterShade).
 * @param {ArrayLike<number>} viewMatrix - Column-major 4x4.
 * @param {ArrayLike<number>} modelMatrix - Column-major 4x4.
 * @param {ArrayLike<number>} lightDir - Unit light direction in eye space.
 * @param {number} viewportHeight - Pixels the projection maps the fov onto.
 * @param {number} fov - Vertical field of view in radians.
 * @returns {number} `u_pointScale`.
 */
export function writePointShaderFrame(
  target,
  viewMatrix,
  modelMatrix,
  lightDir,
  viewportHeight,
  fov
) {
  const out = target.modelView;
  const a = viewMatrix;
  const b = modelMatrix;
  for (let column = 0; column < 4; column++) {
    const b0 = b[column * 4];
    const b1 = b[column * 4 + 1];
    const b2 = b[column * 4 + 2];
    const b3 = b[column * 4 + 3];
    out[column * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[column * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[column * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[column * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  // Blinn half vector for a viewer looking down -z: normalize(L + (0, 0, 1)).
  const hx = lightDir[0];
  const hy = lightDir[1];
  const hz = lightDir[2] + 1;
  const length = Math.hypot(hx, hy, hz);
  const half = target.halfDir;
  if (length > 0) {
    half[0] = hx / length;
    half[1] = hy / length;
    half[2] = hz / length;
  } else {
    half[0] = 0;
    half[1] = 0;
    half[2] = 1;
  }
  target.invCenterShade = 1 / sculptedCenterShade(lightDir);
  return (
    viewportHeight /
    Math.max(2 * Math.tan(fov * 0.5), FOV_SCALE_FLOOR)
  ) * 0.01;
}

/**
 * The highlight ring style each shader quality draws with, shared by the
 * viewer's highlight renderer and the figure export. `ringStyle` selects the
 * branch of HP_FS_HIGHLIGHT (0 torus, 1 flat circle, 2 flat square);
 * `animated` says whether the torus pulses and shimmers with time. Only an
 * animated style keeps the viewer redrawing while cells are highlighted;
 * `sculpted` draws the torus at its mid-pulse glow and holds still, so a
 * selection costs nothing while the view is idle.
 */
export const HIGHLIGHT_STYLES_BY_QUALITY = Object.freeze({
  full: Object.freeze({ scale: 1.75, ringWidth: 0.42, haloStrength: 0.65, haloShape: 0.0, ringStyle: 0.0, animated: true }),
  sculpted: Object.freeze({ scale: 1.75, ringWidth: 0.42, haloStrength: 0.65, haloShape: 0.0, ringStyle: 0.0, animated: false }),
  light: Object.freeze({ scale: 1.70, ringWidth: 0.44, haloStrength: 0.60, haloShape: 0.0, ringStyle: 1.0, animated: false }),
  ultralight: Object.freeze({ scale: 1.65, ringWidth: 0.46, haloStrength: 0.55, haloShape: 0.35, ringStyle: 2.0, animated: false }),
});

/**
 * The highlight pulse at `timeSeconds`: 0 is the resting look (it matches an
 * unhighlighted cell), 1 the full glow. HP_FS_HIGHLIGHT reads it as `u_glow`;
 * it depends only on time, so it is evaluated once per draw instead of once
 * per fragment.
 *
 * @param {number} timeSeconds
 * @returns {number}
 */
export function highlightGlowAt(timeSeconds) {
  return 0.5 + 0.5 * Math.sin(timeSeconds * 4);
}

// ============================================================================
// HIGHLIGHT RING SHADERS - for rendering selection highlights
// ============================================================================

/**
 * Highlight vertex shader - renders highlighted points with a ring effect
 * Reads the highlight renderer's own compact records: Float32 XYZ at offset 0
 * and RGBA8 at offset 12 of each 16-byte record, on the same attribute
 * locations as the point shaders
 */
export const HP_VS_HIGHLIGHT = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color; // RGBA packed - we only use alpha for visibility

uniform mat4 u_modelViewMatrix;
uniform mat4 u_projectionMatrix;
uniform float u_pointSize;
// The largest sprite this pass may draw, in the pixels it is drawing into.
// A figure export rasterises the same scene at a multiple of the screen
// size, so a fixed cap would clamp a point at a different fraction of the
// image than it occupies on screen, and the exported figure would stop
// being the view it claims to reproduce. Zero means unset, and the floor
// below keeps that behaving exactly as the fixed cap did.
uniform float u_pointSizeMax;
uniform float u_sizeAttenuation;
// Pixels per world unit of point size at unit eye depth; see HP_VS_FULL.
uniform float u_pointScale;
uniform float u_highlightScale; // How much larger the highlight ring is (e.g., 1.5)

${FOG_GLSL}
flat out float v_alpha;
flat out float v_fogOpacity; // The opacity fog leaves this ring (fog-shaders.js)

void main() {
  vec4 eyePos = u_modelViewMatrix * vec4(a_position, 1.0);
  gl_Position = u_projectionMatrix * eyePos;

  float eyeDepth = -eyePos.z;

  // Calculate what the DOT size would be (same formula as main dot shader)
  float dotPerspective = (u_pointSize * u_pointScale) / max(eyeDepth, 0.001);
  float dotSize = mix(u_pointSize, dotPerspective, u_sizeAttenuation);
  dotSize = clamp(dotSize, 0.5, max(u_pointSizeMax, 128.0)); // Same clamp as main dots!

  // Highlight sprite scales proportionally with dot using constant multiplier
  // This ensures consistent visual appearance at all zoom levels
  float highlightSize = dotSize * u_highlightScale;
  highlightSize = clamp(highlightSize, 1.0, 256.0);
  gl_PointSize = highlightSize;

  v_fogOpacity = fogOpacity(fogTransmittance(length(eyePos.xyz)));

  // Reject unhighlighted points before rasterisation — see HP_VS_FULL. Zeroing
  // the size alone does not hide anything: the driver clamps it back to one
  // pixel, so the point is still assembled, rasterised and shaded.
  //
  // Two facts elsewhere used to make that harmless, and this shader relies on
  // neither. Both producers pack only points at or above MIN_VISIBLE_ALPHA_BYTE
  // — 3/255 = 0.0118, above this 0.01 threshold — so nothing can reach this
  // branch today (highlight-renderer.js, and the figure-export path in
  // app/ui/modules/figure-export/utils/webgl-point-rasterizer.js); and both draw
  // sites run depthMask(false). A producer that stops compacting, or a pass that
  // starts writing depth, is then a change to those files and not to this one.
  if (a_color.a < 0.01) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }

  v_alpha = a_color.a;
}
`;

/**
 * Highlight fragment shader - draws a beautiful 3D torus ring with metallic sheen
 * Features:
 * - True 3D torus cross-section with proper normals
 * - Metallic/iridescent shading with rim lighting
 * - Accurate inner radius matching actual dot size at all zoom levels
 * - Ethereal glow emanating from the ring
 */
export const HP_FS_HIGHLIGHT = `#version 300 es
precision highp float;

flat in float v_alpha;
flat in float v_fogOpacity; // The opacity fog leaves this ring (HP_VS_HIGHLIGHT)

uniform vec3 u_highlightColor;
uniform float u_ringWidth;
uniform float u_haloStrength;
uniform float u_haloShape; // 0 = circle, 1 = square
uniform float u_highlightScale;
uniform float u_ringStyle; // 0 = 3D torus, 1 = flat circle, 2 = flat square
uniform float u_time; // For the ring shimmer
// The pulse: 0.5 + 0.5 sin(4 t), evaluated once per draw on the CPU.
uniform float u_glow;


// Lighting uniforms (same as HP_FS_FULL)
uniform float u_lightingStrength;
uniform vec3 u_lightDir;
uniform vec3 u_halfDir;

out vec4 fragColor;

void main() {
  if (v_alpha < 0.01) discard;

  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float rCircle = length(coord);
  float rSquare = max(abs(coord.x), abs(coord.y));
  float baseR = (u_ringStyle > 1.5) ? rSquare : rCircle;
  float shapeR = (u_ringStyle > 1.5) ? rSquare : mix(rCircle, rSquare, u_haloShape);

  if (shapeR > 1.0) discard;

  // === CONSTANT MULTIPLIER RING GEOMETRY ===
  // Inner radius = where the dot ends (1/highlightScale) with small gap
  // Outer radius = innerRadius * constant ring ratio
  // This ensures consistent proportions at ALL zoom levels

  const float INNER_GAP = 1.08;      // 8% gap between dot edge and ring inner edge
  const float RING_RATIO = 1.65;     // Outer radius is 55% larger than inner radius

  // The dot occupies radius (1/u_highlightScale) in normalized sprite coords
  // Add small gap so ring doesn't touch the dot
  float innerRadius = (1.0 / u_highlightScale) * INNER_GAP;

  // Outer radius is constant multiple of inner
  float outerRadius = innerRadius * RING_RATIO;

  // Derive tube geometry from inner/outer
  float tubeRadius = (outerRadius - innerRadius) * 0.5;
  float majorRadius = innerRadius + tubeRadius;

  // Apply u_ringWidth as a scaling factor on tube thickness
  tubeRadius *= (0.5 + u_ringWidth * 0.5);
  // Recalculate outer after adjusting tube
  outerRadius = innerRadius + tubeRadius * 2.0;
  majorRadius = innerRadius + tubeRadius;

  // Clamp to ensure ring stays within sprite bounds
  if (outerRadius > 0.95) {
    float scale = 0.95 / outerRadius;
    innerRadius *= scale;
    outerRadius *= scale;
    tubeRadius *= scale;
    majorRadius = innerRadius + tubeRadius;
  }

  float radial = length(coord);
  float aa = fwidth(radial) * 1.5 + 0.003;

  // The dot radius in normalized coords (where the actual dot ends)
  float dotRadius = 1.0 / u_highlightScale;

  if (u_ringStyle < 0.5) {
    // ============================================
    // 3D TORUS RING + DOT - Full quality
    // Renders BOTH the dot and the ring around it
    // ============================================

    // Check if we're inside the DOT area (extends to innerRadius to fill gap)
    // This prevents underlying main point colors bleeding through when zoomed in close
    bool inDot = radial < innerRadius;

    // Distance from the ring's center circle
    float distFromRing = abs(radial - majorRadius);

    // Check if we're within the ring tube
    bool inRing = distFromRing <= tubeRadius + aa * 2.0;

    // Discard if outside both dot and ring (no outer glow)
    if (!inDot && !inRing) discard;

    vec3 finalColor;
    float finalAlpha;

    if (inDot) {
      // === RENDER THE DOT (including gap region up to innerRadius) ===
      // Scale coord to dot's local space, same approach as HP_FS_FULL
      // Gap region (radial > dotRadius) gets z=0 edge lighting naturally
      vec2 localCoord = coord / dotRadius;
      float localR2 = dot(localCoord, localCoord);
      float z = sqrt(max(1.0 - localR2, 0.0));
      vec3 normal = vec3(localCoord.x, -localCoord.y, z);

      // Glow factor: 0.0 = normal (matches unhighlighted cells), 1.0 = full glow
      float glowFactor = u_glow;

      // === BASE LIGHTING (exactly matches HP_FS_FULL at glowFactor=0) ===
      float NdotL = max(dot(normal, u_lightDir), 0.0);
      float ambient = ${FULL_AMBIENT_GLSL};
      float diffuse = ${FULL_DIFFUSE_GLSL} * NdotL;
      float specularBase = max(dot(normal, u_halfDir), 0.0);
      specularBase *= specularBase; specularBase *= specularBase;
      specularBase *= specularBase; specularBase *= specularBase;
      specularBase *= specularBase;
      float specular = specularBase * 0.3;

      // Lit color (same formula as HP_FS_FULL)
      vec3 litColor = u_highlightColor * (ambient + diffuse) + vec3(specular);
      // Apply lighting strength (same as HP_FS_FULL)
      vec3 baseColor = mix(u_highlightColor, litColor, u_lightingStrength);

      // === GLOW ADDITIONS (only when glowFactor > 0) ===
      // Extra brightness
      float extraBrightness = glowFactor * 0.3;
      // Extra specular
      float extraSpecular = glowFactor * 0.2 * specularBase;
      // Rim glow
      float rimFactor = 1.0 - z;
      float rimGlow = glowFactor * rimFactor * 0.25;
      // Subtle emission
      float emission = glowFactor * 0.1;

      vec3 dotColor = baseColor * (1.0 + extraBrightness) + vec3(extraSpecular) + u_highlightColor * (rimGlow + emission);

      finalColor = dotColor;

      // Hard edge at dot boundary - no soft fade
      finalAlpha = (radial <= dotRadius) ? v_alpha : 0.0;

    } else if (inRing) {
      // === RENDER THE RING ===
      // Calculate the "height" on the torus surface (circular cross-section)
      float tubeT = distFromRing / tubeRadius;
      float zNorm = sqrt(max(1.0 - tubeT * tubeT, 0.0));

      // Normal calculation for torus surface
      vec2 radialDir = coord / max(radial, 0.001);
      float radialSign = sign(radial - majorRadius);

      vec3 normal = normalize(vec3(
        radialDir * radialSign * tubeT,
        zNorm
      ));

      // Glow factor synced with dot (0.0 = dim, 1.0 = full glow)
      float glowFactor = u_glow;
      float shimmer = 0.5 + 0.5 * sin(u_time * 8.0 + radial * 3.14159);

      // === BASE LIGHTING (same formula as HP_FS_FULL at glowFactor=0) ===
      float NdotL = max(dot(normal, u_lightDir), 0.0);
      float ambient = ${FULL_AMBIENT_GLSL};
      float diffuse = ${FULL_DIFFUSE_GLSL} * NdotL;
      float specularBase = max(dot(normal, u_halfDir), 0.0);
      specularBase *= specularBase; specularBase *= specularBase;
      specularBase *= specularBase; specularBase *= specularBase;
      specularBase *= specularBase;
      float specular = specularBase * 0.3;

      // Lit color (same formula as HP_FS_FULL)
      vec3 litColor = u_highlightColor * (ambient + diffuse) + vec3(specular);
      // Apply lighting strength (same as HP_FS_FULL)
      vec3 baseColor = mix(u_highlightColor, litColor, u_lightingStrength);

      // === GLOW ADDITIONS (only when glowFactor > 0) ===
      float facing = 1.0 - max(normal.z, 0.0);
      float fresnel = facing * facing * facing;
      vec3 warmWhite = vec3(1.0, 0.98, 0.95);

      // Extra brightness
      float extraBrightness = glowFactor * 0.4;
      // Extra specular with shimmer
      float extraSpec = glowFactor * shimmer * specularBase * 0.5;
      // Rim glow
      float rimGlow = glowFactor * fresnel * 0.4;
      // Subtle emission
      float emission = glowFactor * 0.15;

      vec3 ringColor = baseColor * (1.0 + extraBrightness) + warmWhite * extraSpec;
      ringColor = mix(ringColor, u_highlightColor * 1.3, rimGlow);
      ringColor += u_highlightColor * emission;

      // Hard edge on tube boundary - no soft fade that creates white outline
      bool withinTube = distFromRing <= tubeRadius;

      finalColor = ringColor;
      finalAlpha = withinTube ? (0.95 * v_alpha) : 0.0;
    }

    if (finalAlpha < 0.01) discard;

    // Fog thins the ring toward whatever is behind it (fog-shaders.js).
    fragColor = vec4(finalColor, v_fogOpacity * finalAlpha);
    return;
  }

  // ============================================
  // FLAT RING + DOT VARIANTS (Light/Ultralight quality)
  // Minimal cost: flat colors, no shading calculations
  // High-contrast center for popup effect
  // ============================================

  // Center highlight radius (40% of dot for visible pop)
  float centerRadius = innerRadius * 0.4;

  // CENTER - high contrast bright spot (circle or square based on mode)
  if (baseR < centerRadius) {
    // Bright center: boost highlight color
    vec3 centerColor = min(u_highlightColor * 1.4 + vec3(0.15), vec3(1.0));
    fragColor = vec4(centerColor, v_alpha);
    return;
  }

  // DOT AREA - standard highlight color
  if (baseR < innerRadius) {
    fragColor = vec4(u_highlightColor, v_alpha);
    return;
  }

  // RING AREA - flat fill, slightly darker than dot
  if (baseR <= outerRadius) {
    fragColor = vec4(u_highlightColor * 0.75, v_alpha * 0.95);
    return;
  }

  discard;
}
`;
