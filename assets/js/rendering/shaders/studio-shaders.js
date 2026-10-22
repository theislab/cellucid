/**
 * GLSL Shader Sources (WebGL2 / GLSL ES 3.0)
 * ==========================================
 * The studio backdrop: one procedural full-pane pass that paints the
 * background, the floor and the dot surface (`rendering/studio-backdrop.js`
 * describes the design and owns every constant interpolated below).
 *
 * The pass draws a single triangle that covers the pane and casts a view ray
 * per fragment. Both surfaces are intersected analytically, so the floor has
 * no geometry, no far edge and no near-plane clipping, and a free-fly camera
 * can pass through it. Lattice coordinates are differentiated before any
 * branch, so every derivative is taken in uniform control flow.
 */

import {
  STUDIO_LATTICE,
  STUDIO_MARKS,
  STUDIO_STAGE,
  STUDIO_SURFACES,
} from '../studio-backdrop.js';

/** A JS number as a GLSL float literal. */
function glslFloat(value) {
  if (!Number.isFinite(value)) {
    throw new RangeError('Studio shader constants must be finite numbers.');
  }
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

/** The farthest a view ray is followed, in normalized data units. */
const STUDIO_RAY_LIMIT = 1000;

/**
 * Lattice helpers shared by both surfaces. `studioFamilyWeights` mirrors the
 * function of the same name in `studio-backdrop.js`.
 */
const STUDIO_GLSL_LATTICE = `
const float LATTICE_BASE = ${glslFloat(STUDIO_LATTICE.base)};
const float LATTICE_RATIO = ${glslFloat(STUDIO_LATTICE.ratio)};
const float LOG_LATTICE_RATIO = ${glslFloat(Math.log(STUDIO_LATTICE.ratio))};
const float FADE_IN_FRACTION = ${glslFloat(STUDIO_LATTICE.fadeInFraction)};
const float LINE_WIDTH_CSS = ${glslFloat(STUDIO_MARKS.lineWidthCssPx)};
const float MAJOR_LINE_WIDTH_CSS = ${glslFloat(STUDIO_MARKS.majorLineWidthCssPx)};
const float DOT_RADIUS_CSS = ${glslFloat(STUDIO_MARKS.dotRadiusCssPx)};
const float MAJOR_DOT_RADIUS_CSS = ${glslFloat(STUDIO_MARKS.majorDotRadiusCssPx)};

// x: presence, y: majorness, from a family's spacing in data units and on
// screen in CSS px, on a surface with minimum cell minCellCss.
vec2 studioFamilyWeights(
  float spacing, float spacingCss, float minCellCss, float maxSpacing
) {
  return vec2(
    smoothstep(minCellCss * FADE_IN_FRACTION, minCellCss, spacingCss)
      * (1.0 - smoothstep(maxSpacing * 0.5, maxSpacing, spacing)),
    smoothstep(minCellCss, minCellCss * LATTICE_RATIO, spacingCss)
  );
}

// Coverage of the lattice marks at one fragment, 0..1. uv is the lattice
// coordinate on the plane; ddx/ddy its screen derivatives. lineMix and dotMix
// weigh hairlines against dots; minCellCss and maxSpacing are the surface's
// (STUDIO_SURFACES). Only
// the three families around this fragment's footprint can be visible: the
// finer ones have not faded in, and every coarser one coincides with the
// coarsest of the three at no more than its weight.
float studioLatticeMarks(
  vec2 uv, vec2 ddx, vec2 ddy, float lineMix, float dotMix,
  float minCellCss, float maxSpacing
) {
  // World units per device pixel across each family of rules.
  vec2 axisFootprint = max(
    sqrt(vec2(ddx.x * ddx.x + ddy.x * ddy.x, ddx.y * ddx.y + ddy.y * ddy.y)),
    vec2(1e-9)
  );
  float footprint = max(axisFootprint.x, axisFootprint.y);
  float minCellDevice = minCellCss * u_pixelRatio;
  float level = floor(log(footprint * minCellDevice / LATTICE_BASE) / LOG_LATTICE_RATIO);

  // Screen offset of a lattice offset: the inverse of the uv Jacobian.
  float det = ddx.x * ddy.y - ddy.x * ddx.y;
  det = abs(det) < 1e-18 ? 1e-18 : det;
  mat2 screenFromUv = mat2(ddy.y, -ddx.y, -ddy.x, ddx.x) / det;

  float marks = 0.0;
  for (int family = 0; family < 3; family++) {
    float spacing = LATTICE_BASE * pow(LATTICE_RATIO, level + float(family));
    vec2 weights = studioFamilyWeights(
      spacing, spacing / footprint / u_pixelRatio, minCellCss, maxSpacing
    );
    vec2 offset = uv - spacing * floor(uv / spacing + 0.5);

    // Hairlines: constant CSS width. Narrower than one device pixel they are
    // drawn one pixel wide at proportionally lower intensity, which reads the
    // same and cannot alias.
    float width = mix(LINE_WIDTH_CSS, MAJOR_LINE_WIDTH_CSS, weights.y) * u_pixelRatio;
    float drawnWidth = max(width, 1.0);
    vec2 lineDistance = abs(offset) / axisFootprint;
    vec2 lineCoverage = clamp(drawnWidth * 0.5 + 0.5 - lineDistance, 0.0, 1.0);
    float line = max(lineCoverage.x, lineCoverage.y) * (width / drawnWidth)
      * mix(u_lineMinorAlpha, u_lineMajorAlpha, weights.y);

    // Dots: round on screen whatever the plane's slant.
    float radius = mix(DOT_RADIUS_CSS, MAJOR_DOT_RADIUS_CSS, weights.y) * u_pixelRatio;
    float dotDistance = length(screenFromUv * offset);
    float dotMark = clamp(radius + 0.5 - dotDistance, 0.0, 1.0)
      * mix(u_dotMinorAlpha, u_dotMajorAlpha, weights.y);

    marks = max(marks, weights.x * max(line * lineMix, dotMark * dotMix));
  }
  return marks;
}
`;

export const STUDIO_VS_SOURCE = `#version 300 es
precision highp float;

// One triangle covering the pane: (-1,-1), (3,-1), (-1,3). A real attribute
// at location 0 rather than corners derived from gl_VertexID: a draw with no
// enabled attribute 0 makes Firefox on desktop OpenGL emulate one per vertex.
layout(location = 0) in vec2 a_corner;

out vec2 v_ndc;

void main() {
  v_ndc = a_corner;
  gl_Position = vec4(a_corner, 1.0, 1.0);
}
`;

export const STUDIO_FS_SOURCE = `#version 300 es
precision highp float;

in vec2 v_ndc;

uniform mat4 u_invMvpMatrix;   // pane NDC -> model space
uniform vec3 u_eye;            // camera position, model space
uniform float u_pixelRatio;    // device pixels per CSS pixel
uniform vec3 u_surfaceColor;   // clear colour; the backdrop at every pane edge
uniform vec3 u_glowColor;      // backdrop at the centre of the presented area
uniform float u_glowCenterX;   // NDC x of that centre; the area spans [2c - 1, 1]
uniform vec3 u_inkColor;
uniform float u_lineMinorAlpha;
uniform float u_lineMajorAlpha;
uniform float u_dotMinorAlpha;
uniform float u_dotMajorAlpha;
uniform float u_opacity;       // background fade-in/out, 0..1
uniform float u_floorWeight;   // resolveStudioSurfaceWeights().floor
uniform float u_floorY;
uniform vec2 u_stageCenter;    // floor point under the data centre (x, z)
uniform float u_backdropWeight; // resolveStudioSurfaceWeights().backdrop
uniform vec3 u_backNormal;     // dot surface: normal, away from the camera
uniform float u_backOffset;    // ...normal . p = offset
uniform vec3 u_backU;          // ...lattice axes in the plane
uniform vec3 u_backV;
uniform vec2 u_poolCenter;     // pool ellipse centre, pane NDC
uniform mat2 u_poolInverse;    // pane NDC offset -> unit pool circle
uniform float u_poolStrength;  // 0 when the pool is not drawn

out vec4 fragColor;

${STUDIO_GLSL_LATTICE}

const float RAY_LIMIT = ${glslFloat(STUDIO_RAY_LIMIT)};
const float STAGE_INNER = ${glslFloat(STUDIO_STAGE.innerRadius)};
const float STAGE_OUTER = ${glslFloat(STUDIO_STAGE.outerRadius)};
const float GRAZING_START = ${glslFloat(STUDIO_STAGE.grazingFadeStart)};
const float GRAZING_END = ${glslFloat(STUDIO_STAGE.grazingFadeEnd)};
const float CLEARANCE_FADE = ${glslFloat(STUDIO_STAGE.clearanceFade)};
const float FLOOR_MIN_CELL_CSS = ${glslFloat(STUDIO_SURFACES.floor.minCellCssPx)};
const float FLOOR_MAX_SPACING = ${glslFloat(STUDIO_SURFACES.floor.maxFamilySpacing)};
const float BACKDROP_MIN_CELL_CSS = ${glslFloat(STUDIO_SURFACES.backdrop.minCellCssPx)};
// STUDIO_SURFACES.backdrop.maxFamilySpacing is unbounded.
const float UNBOUNDED_SPACING = 1e30;

// The glow's and the pool's falloff at a radius normalized to their ellipse.
// Mirrors studioFalloff() in studio-backdrop.js.
float studioFalloff(float radius) {
  return 1.0 - smoothstep(0.0, 1.0, radius);
}

// Distance along a ray to a plane, clamped to a finite range so no derivative
// in the fragment's quad can become infinite.
float rayPlaneDistance(float gap, float rate) {
  float safeRate = abs(rate) < 1e-6 ? (rate < 0.0 ? -1e-6 : 1e-6) : rate;
  return clamp(gap / safeRate, 0.0, RAY_LIMIT);
}

void main() {
  vec4 farPoint = u_invMvpMatrix * vec4(v_ndc, 1.0, 1.0);
  vec3 ray = normalize(farPoint.xyz / farPoint.w - u_eye);

  // Floor: y = u_floorY, seen from above.
  float floorGap = u_eye.y - u_floorY;
  vec2 floorUv = u_eye.xz + ray.xz * rayPlaneDistance(-floorGap, ray.y);
  vec2 floorDdx = dFdx(floorUv);
  vec2 floorDdy = dFdy(floorUv);

  // Dot surface (resolveStudioBackdropPlane), seen from either side.
  float backGap = u_backOffset - dot(u_backNormal, u_eye);
  float backRate = dot(u_backNormal, ray);
  vec3 backHit = u_eye + ray * rayPlaneDistance(backGap, backRate);
  vec2 backUv = vec2(dot(backHit, u_backU), dot(backHit, u_backV));
  vec2 backDdx = dFdx(backUv);
  vec2 backDdy = dFdy(backUv);

  float marks = 0.0;
  if (u_floorWeight > 0.0) {
    float fade = u_floorWeight
      * (1.0 - smoothstep(STAGE_INNER, STAGE_OUTER, length(floorUv - u_stageCenter)))
      * smoothstep(GRAZING_START, GRAZING_END, -ray.y)
      * smoothstep(0.0, CLEARANCE_FADE, floorGap);
    if (fade > 0.0) {
      marks = fade * studioLatticeMarks(
        floorUv, floorDdx, floorDdy, 1.0, 0.0,
        FLOOR_MIN_CELL_CSS, FLOOR_MAX_SPACING
      );
    }
  }
  if (u_backdropWeight > 0.0) {
    float fade = u_backdropWeight
      * step(0.0, backGap * backRate)
      * smoothstep(GRAZING_START, GRAZING_END, abs(backRate))
      * smoothstep(0.0, CLEARANCE_FADE, abs(backGap));
    if (fade > 0.0) {
      marks = max(marks, fade * studioLatticeMarks(
        backUv, backDdx, backDdy, 0.0, 1.0, BACKDROP_MIN_CELL_CSS, UNBOUNDED_SPACING
      ));
    }
  }

  // A soft rise in lightness over the ellipse inscribed in the presented
  // area; outside it, and so along every pane edge, the backdrop is exactly
  // the surface colour.
  float glow = studioFalloff(length(vec2(
    (v_ndc.x - u_glowCenterX) / max(1.0 - u_glowCenterX, 1e-3),
    v_ndc.y
  )));
  // The pool of ink on the floor under the data: a contact shadow on a light
  // stage, a pool of light on a dark one.
  float pool = studioFalloff(length(u_poolInverse * (v_ndc - u_poolCenter)));

  vec3 color = mix(u_surfaceColor, u_glowColor, glow * u_opacity);
  color = mix(color, u_inkColor, pool * u_poolStrength * u_opacity);
  color = mix(color, u_inkColor, clamp(marks, 0.0, 1.0) * u_opacity);

  // Interleaved-gradient dither of under half a code value: it breaks 8-bit
  // banding in the glow and leaves an exact surface colour unchanged.
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  color += (noise - 0.5) * (0.98 / 255.0);

  fragColor = vec4(color, 1.0);
}
`;
