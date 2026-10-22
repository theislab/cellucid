/**
 * GLSL Shader Sources (WebGL2 / GLSL ES 3.0)
 * ==========================================
 * Shaders for instanced edge rendering and grid background.
 * Point rendering is handled by the high-performance renderer.
 */

import { FOG_GLSL } from './fog-shaders.js';

// ============================================================================
// GPU-INSTANCED EDGE SHADER
// ============================================================================
// One 4-vertex triangle strip per shown edge. A pane's shown edges are
// gathered on the CPU into one instance record each (both endpoints'
// positions and the edge's relative strength, rendering/connectivity-edge-layer.js),
// so the vertex shader fetches nothing: no texture reads, no index
// arithmetic, and no per-instance visibility test (hidden edges are never in
// the records). Fog is evaluated per vertex with the shared model
// (fog-shaders.js): it depends only on distance, which a line's two
// endpoints bound, and it thins the line toward what is behind it rather than
// tinting it.

export const LINE_INSTANCED_VS_SOURCE = `#version 300 es
precision highp float;

// Shared quad geometry (4 vertices of one triangle strip)
// x: -1 = source endpoint, +1 = destination endpoint
// y: -1 = left side of line, +1 = right side of line
// Location 0 explicitly: a draw whose attribute 0 is not an enabled array
// makes Firefox on desktop OpenGL emulate one per vertex, at real cost.
layout(location = 0) in vec2 a_quadPos;
// Per instance: the endpoints (missing axes are 0) and the relative edge
// strength, derived from canonical Float64 weights by dividing every weight
// by the graph maximum.
layout(location = 1) in vec3 a_source;
layout(location = 2) in vec3 a_destination;
layout(location = 3) in float a_strength;

// Transform uniforms
uniform mat4 u_mvpMatrix;
uniform mat4 u_modelViewMatrix;
uniform vec2 u_viewportSize;
uniform float u_lineWidth;

// Line opacity, thinned by the shared fog model at each endpoint.
uniform float u_lineAlpha;
${FOG_GLSL}
// The final opacity, linear along the line.
out float v_alpha;

void main() {
  // Determine which endpoint this vertex belongs to
  // a_quadPos.x: -1 = source, +1 = destination
  vec3 myPos = a_quadPos.x < 0.0 ? a_source : a_destination;
  vec3 otherPos = a_quadPos.x < 0.0 ? a_destination : a_source;

  // Project both endpoints to clip space
  vec4 clipMy = u_mvpMatrix * vec4(myPos, 1.0);
  vec4 clipOther = u_mvpMatrix * vec4(otherPos, 1.0);

  // Convert to screen space for consistent line width
  vec2 ndcMy = clipMy.xy / clipMy.w;
  vec2 ndcOther = clipOther.xy / clipOther.w;
  vec2 screenMy = (ndcMy * 0.5 + 0.5) * u_viewportSize;
  vec2 screenOther = (ndcOther * 0.5 + 0.5) * u_viewportSize;

  // Build perpendicular direction for line thickness
  vec2 dir = screenOther - screenMy;
  float len = length(dir);
  vec2 normal = len > 0.001 ? vec2(-dir.y, dir.x) / len : vec2(0.0, 1.0);

  // Offset perpendicular to line direction
  // a_quadPos.y: -1 = left side, +1 = right side
  float halfWidth = max(u_lineWidth * 0.5, 0.5);
  vec2 offsetScreen = normal * a_quadPos.y * halfWidth;
  vec2 offsetNdc = (offsetScreen / u_viewportSize) * 2.0;

  // Apply offset in clip space
  gl_Position = clipMy;
  gl_Position.xy += offsetNdc * clipMy.w;

  // Fog from this endpoint's distance to the eye
  vec4 eyePos = u_modelViewMatrix * vec4(myPos, 1.0);
  v_alpha = u_lineAlpha * a_strength * fogOpacity(fogTransmittance(length(eyePos.xyz)));
}
`;

// Fragment shader for instanced edges
export const LINE_INSTANCED_FS_SOURCE = `#version 300 es
precision mediump float;

in float v_alpha;

uniform vec3 u_lineColor;

out vec4 fragColor;

void main() {
  fragColor = vec4(u_lineColor, v_alpha);
}
`;

// Grid background shaders - renders 3D grid walls like matplotlib (WebGL2)
export const GRID_VS_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;

uniform mat4 u_mvpMatrix;
uniform mat4 u_modelMatrix;
uniform float u_gridSize;

out vec3 v_worldPos;
out vec3 v_localPos;

void main() {
  vec4 worldPos = u_modelMatrix * vec4(a_position, 1.0);
  v_worldPos = worldPos.xyz;
  v_localPos = a_position / u_gridSize; // Normalized -1 to 1

  gl_Position = u_mvpMatrix * vec4(a_position, 1.0);
}
`;

export const GRID_FS_SOURCE = `#version 300 es
precision highp float;

in vec3 v_worldPos;
in vec3 v_localPos;

uniform vec3 u_gridColor;
uniform vec3 u_bgColor;
uniform float u_gridSpacing;
uniform float u_gridLineWidth;
uniform float u_gridOpacity;
uniform float u_planeAlpha;      // Per-plane visibility (smooth fade)
uniform int u_planeType;         // 0=XY, 1=XZ, 2=YZ
uniform vec3 u_axisXColor;       // Axis colors for scientific look
uniform vec3 u_axisYColor;
uniform vec3 u_axisZColor;
uniform float u_gridSize;

out vec4 fragColor;

float gridLine(float coord, float spacing, float lineWidth) {
  float f = abs(fract(coord / spacing + 0.5) - 0.5) * spacing;
  float lineHalf = lineWidth * 0.5;
  float derivative = fwidth(coord);
  return 1.0 - smoothstep(lineHalf - derivative, lineHalf + derivative, f);
}

float edgeLine(float coord, float gridSize, float lineWidth) {
  float edgeDist = min(abs(coord + gridSize), abs(coord - gridSize));
  float derivative = fwidth(coord);
  float edgeWidth = lineWidth * 1.4;
  return 1.0 - smoothstep(edgeWidth - derivative, edgeWidth + derivative, edgeDist);
}

float originLine(float coord, float lineWidth) {
  float d = abs(coord);
  float derivative = fwidth(coord);
  // Keep origin axes slightly emphasized, but avoid thick "shaded" bands.
  float w = lineWidth * 1.55;
  return 1.0 - smoothstep(w - derivative, w + derivative, d);
}

void main() {
  float minor = 0.0;
  float major = 0.0;
  float frame = 0.0;
  float xAxis = 0.0;
  float yAxis = 0.0;
  float zAxis = 0.0;

  float mainLineWidth = u_gridLineWidth;
  float majorSpacing = u_gridSpacing * 5.0; // e.g. 0.2 -> 1.0
  float majorLineWidth = mainLineWidth * 1.20;

  vec2 planeUv = vec2(0.0);

  if (u_planeType == 0) {
    // XY plane
    planeUv = v_localPos.xy;
    minor = max(gridLine(v_worldPos.x, u_gridSpacing, mainLineWidth),
                gridLine(v_worldPos.y, u_gridSpacing, mainLineWidth));
    major = max(gridLine(v_worldPos.x, majorSpacing, majorLineWidth),
                gridLine(v_worldPos.y, majorSpacing, majorLineWidth));
    frame = max(edgeLine(v_worldPos.x, u_gridSize, mainLineWidth),
                edgeLine(v_worldPos.y, u_gridSize, mainLineWidth));
    xAxis = originLine(v_worldPos.y, mainLineWidth);
    yAxis = originLine(v_worldPos.x, mainLineWidth);
  } else if (u_planeType == 1) {
    // XZ plane
    planeUv = v_localPos.xz;
    minor = max(gridLine(v_worldPos.x, u_gridSpacing, mainLineWidth),
                gridLine(v_worldPos.z, u_gridSpacing, mainLineWidth));
    major = max(gridLine(v_worldPos.x, majorSpacing, majorLineWidth),
                gridLine(v_worldPos.z, majorSpacing, majorLineWidth));
    frame = max(edgeLine(v_worldPos.x, u_gridSize, mainLineWidth),
                edgeLine(v_worldPos.z, u_gridSize, mainLineWidth));
    xAxis = originLine(v_worldPos.z, mainLineWidth);
    zAxis = originLine(v_worldPos.x, mainLineWidth);
  } else {
    // YZ plane
    planeUv = v_localPos.yz;
    minor = max(gridLine(v_worldPos.y, u_gridSpacing, mainLineWidth),
                gridLine(v_worldPos.z, u_gridSpacing, mainLineWidth));
    major = max(gridLine(v_worldPos.y, majorSpacing, majorLineWidth),
                gridLine(v_worldPos.z, majorSpacing, majorLineWidth));
    frame = max(edgeLine(v_worldPos.y, u_gridSize, mainLineWidth),
                edgeLine(v_worldPos.z, u_gridSize, mainLineWidth));
    yAxis = originLine(v_worldPos.z, mainLineWidth);
    zAxis = originLine(v_worldPos.y, mainLineWidth);
  }

  float effectiveOpacity = u_gridOpacity * u_planeAlpha;

  // Subtle surface shading (vignette) to avoid a flat "sheet" look.
  float r = clamp(length(planeUv), 0.0, 1.41421356);
  float vignette = smoothstep(1.35, 0.15, r);
  float bgLuma = dot(u_bgColor, vec3(0.2126, 0.7152, 0.0722));
  float isDarkBg = 1.0 - step(0.55, bgLuma);
  float isLightBg = 1.0 - isDarkBg;
  float shadeAmount = mix(0.012, 0.020, isDarkBg);
  vec3 surfaceColor = clamp(u_bgColor + vec3((vignette - 0.5) * shadeAmount), 0.0, 1.0);

  // Perceptual curves: keep thin lines readable while staying subtle overall.
  float minorStrength = (0.35 + 0.16 * isLightBg) * pow(effectiveOpacity, 0.60);
  float majorStrength = 0.58 * pow(effectiveOpacity, 0.50);
  float frameStrength = 0.18 * pow(effectiveOpacity, 0.65);

  float gridMix = clamp(minor * minorStrength + major * majorStrength + frame * frameStrength, 0.0, 1.0);

  vec3 finalColor = mix(surfaceColor, u_gridColor, gridMix);

  float axisStrength = (0.32 + 0.03 * isLightBg) * pow(effectiveOpacity, 0.55);
  finalColor = mix(finalColor, u_axisXColor, xAxis * axisStrength);
  finalColor = mix(finalColor, u_axisYColor, yAxis * axisStrength);
  finalColor = mix(finalColor, u_axisZColor, zAxis * axisStrength);

  // Alpha emphasizes lines while keeping surfaces airy (no fog dependence).
  float lineMask = max(max(minor, major), max(frame, max(xAxis, max(yAxis, zAxis))));
  float alpha = effectiveOpacity * (0.55 + 0.45 * lineMask);

  // Discard nearly invisible fragments
  if (alpha < 0.01) discard;

  fragColor = vec4(finalColor, alpha);
}
`;
