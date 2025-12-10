/**
 * GLSL Shader Sources (WebGL2 / GLSL ES 3.0)
 * ==========================================
 * Shaders for instanced edge rendering and grid background.
 * Point rendering is handled by the high-performance renderer.
 */

// ============================================================================
// GPU-INSTANCED EDGE SHADER
// ============================================================================
// Optimized for rendering millions of edges with:
// - Edge data stored in texture (no per-edge vertex buffer)
// - Position lookup from texture
// - Visibility filtering in shader (no CPU filtering)
// - Instanced rendering (6 vertices shared across all edges)

export const LINE_INSTANCED_VS_SOURCE = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

// Shared quad geometry (6 vertices for 2 triangles)
// x: -1 = source endpoint, +1 = destination endpoint
// y: -1 = left side of line, +1 = right side of line
in vec2 a_quadPos;

// Edge data texture (RG32UI: source index, dest index)
uniform highp usampler2D u_edgeTexture;
uniform ivec2 u_edgeTexDims;

// Position texture (RGB32F: x, y, z)
uniform highp sampler2D u_positionTexture;
uniform ivec2 u_posTexDims;

// Visibility texture (R8 or R32F: 0.0 = hidden, 1.0 = visible)
uniform highp sampler2D u_visibilityTexture;

// Transform uniforms
uniform mat4 u_mvpMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_modelMatrix;
uniform vec2 u_viewportSize;
uniform float u_lineWidth;

// LOD control - limit number of edges rendered
uniform int u_maxEdges;

out float v_viewDistance;

// Convert linear index to 2D texture coordinate
ivec2 idxToCoord(int idx, ivec2 dims) {
  return ivec2(idx % dims.x, idx / dims.x);
}

void main() {
  int edgeIdx = gl_InstanceID;

  // LOD: skip edges beyond limit (degenerate triangle)
  if (edgeIdx >= u_maxEdges) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  // Fetch edge (source, destination cell indices)
  ivec2 edgeCoord = idxToCoord(edgeIdx, u_edgeTexDims);
  uvec4 edgeData = texelFetch(u_edgeTexture, edgeCoord, 0);
  int srcIdx = int(edgeData.r);
  int dstIdx = int(edgeData.g);

  // Fetch visibility for both endpoints
  ivec2 srcCoord = idxToCoord(srcIdx, u_posTexDims);
  ivec2 dstCoord = idxToCoord(dstIdx, u_posTexDims);
  float srcVis = texelFetch(u_visibilityTexture, srcCoord, 0).r;
  float dstVis = texelFetch(u_visibilityTexture, dstCoord, 0).r;

  // Skip if either endpoint is hidden (degenerate triangle)
  if (srcVis < 0.5 || dstVis < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  // Fetch positions
  vec3 srcPos = texelFetch(u_positionTexture, srcCoord, 0).rgb;
  vec3 dstPos = texelFetch(u_positionTexture, dstCoord, 0).rgb;

  // Determine which endpoint this vertex belongs to
  // a_quadPos.x: -1 = source, +1 = destination
  vec3 myPos = a_quadPos.x < 0.0 ? srcPos : dstPos;
  vec3 otherPos = a_quadPos.x < 0.0 ? dstPos : srcPos;

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

  // Compute view distance for fog
  vec4 eyePos = u_viewMatrix * u_modelMatrix * vec4(myPos, 1.0);
  v_viewDistance = length(eyePos.xyz);
}
`;

// Fragment shader for instanced edges
export const LINE_INSTANCED_FS_SOURCE = `#version 300 es
precision highp float;

in float v_viewDistance;

uniform vec3 u_lineColor;
uniform float u_lineAlpha;
uniform float u_fogDensity;
uniform float u_fogNearMean;
uniform float u_fogFarMean;
uniform vec3 u_fogColor;

out vec4 fragColor;

void main() {
  // Apply fog for depth perception
  float fogSpan = max(u_fogFarMean - u_fogNearMean, 0.0001);
  float normalizedDistance = max(v_viewDistance - u_fogNearMean, 0.0) / fogSpan;
  float extinction = u_fogDensity * u_fogDensity * 0.6;
  float transmittance = exp(-extinction * normalizedDistance);

  vec3 finalColor = mix(u_fogColor, u_lineColor, transmittance);
  float alpha = u_lineAlpha * (0.2 + 0.8 * transmittance);

  fragColor = vec4(finalColor, alpha);
}
`;

// Grid background shaders - renders 3D grid walls like matplotlib (WebGL2)
export const GRID_VS_SOURCE = `#version 300 es
precision highp float;

in vec3 a_position;

uniform mat4 u_mvpMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_modelMatrix;
uniform float u_gridSize;

out vec3 v_worldPos;
out vec3 v_localPos;
out float v_viewDistance;

void main() {
  vec4 worldPos = u_modelMatrix * vec4(a_position, 1.0);
  v_worldPos = worldPos.xyz;
  v_localPos = a_position / u_gridSize; // Normalized -1 to 1

  vec4 eyePos = u_viewMatrix * worldPos;
  v_viewDistance = length(eyePos.xyz);

  gl_Position = u_mvpMatrix * vec4(a_position, 1.0);
}
`;

export const GRID_FS_SOURCE = `#version 300 es
precision highp float;

in vec3 v_worldPos;
in vec3 v_localPos;
in float v_viewDistance;

uniform vec3 u_gridColor;
uniform vec3 u_bgColor;
uniform float u_gridSpacing;
uniform float u_gridLineWidth;
uniform float u_gridOpacity;
uniform float u_planeAlpha;      // Per-plane visibility (smooth fade)
uniform int u_planeType;         // 0=XY, 1=XZ, 2=YZ
uniform float u_fogDensity;
uniform float u_fogNearMean;
uniform float u_fogFarMean;
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

// Axis line detection - thicker lines at edges where planes meet
float axisLine(float coord, float gridSize, float lineWidth) {
  float edgeDist = min(abs(coord + gridSize), abs(coord - gridSize));
  float derivative = fwidth(coord);
  float axisWidth = lineWidth * 2.5;
  return 1.0 - smoothstep(axisWidth - derivative, axisWidth + derivative, edgeDist);
}

void main() {
  float line = 0.0;
  float axisLine1 = 0.0, axisLine2 = 0.0;

  // Grid line width for main grid
  float mainLineWidth = u_gridLineWidth;

  // Select coordinates based on plane type
  if (u_planeType == 0) {
    // XY plane (front/back wall) - grid on X and Y
    line = max(gridLine(v_worldPos.x, u_gridSpacing, mainLineWidth),
               gridLine(v_worldPos.y, u_gridSpacing, mainLineWidth));
    // Edge lines at boundaries
    axisLine1 = axisLine(v_worldPos.y, u_gridSize, mainLineWidth);
    axisLine2 = axisLine(v_worldPos.x, u_gridSize, mainLineWidth);
  } else if (u_planeType == 1) {
    // XZ plane (floor/ceiling) - grid on X and Z
    line = max(gridLine(v_worldPos.x, u_gridSpacing, mainLineWidth),
               gridLine(v_worldPos.z, u_gridSpacing, mainLineWidth));
    // Edge lines at boundaries
    axisLine1 = axisLine(v_worldPos.z, u_gridSize, mainLineWidth);
    axisLine2 = axisLine(v_worldPos.x, u_gridSize, mainLineWidth);
  } else {
    // YZ plane (side wall) - grid on Y and Z
    line = max(gridLine(v_worldPos.y, u_gridSpacing, mainLineWidth),
               gridLine(v_worldPos.z, u_gridSpacing, mainLineWidth));
    // Edge lines at boundaries
    axisLine1 = axisLine(v_worldPos.z, u_gridSize, mainLineWidth);
    axisLine2 = axisLine(v_worldPos.y, u_gridSize, mainLineWidth);
  }

  // Combine axis lines uniformly (max instead of additive blend)
  float combinedAxis = max(axisLine1, axisLine2);

  // === Perceptual Synchronization for Grid Lines and Surfaces ===
  // Problem: Thin grid lines become imperceptible before thick axis lines
  // due to line thinness reducing perceptual contrast at low alpha values.
  // Solution: Decouple color intensity from alpha fading using perceptual curves.

  // Base effective opacity for all grid elements
  float effectiveOpacity = u_gridOpacity * u_planeAlpha;

  // Perceptual compensation curves:
  // - Thin lines need boosted color to remain visible at low opacity
  // - Thick axis lines need less boost (their thickness provides visibility)
  // - Use power curves: lower exponent = more boost at low values

  // Grid line color curve: aggressive boost for thin lines
  // pow(x, 0.55) keeps lines visible longer as opacity drops
  float lineColorStrength = pow(effectiveOpacity, 0.55);

  // Axis line color curve: moderate boost to sync with grid lines
  // pow(x, 0.7) provides less boost since axis lines are 2.5x thicker
  float axisColorStrength = pow(effectiveOpacity, 0.7);

  // Grid line color mixing - uses boosted color strength
  vec3 finalColor = mix(u_bgColor, u_gridColor, line * lineColorStrength);

  // Axis lines use unified opacity base with perceptual curve
  // (Previously used u_planeAlpha alone, causing desync with grid lines)
  float axisIntensity = 0.6 * axisColorStrength;
  finalColor = mix(finalColor, u_axisXColor, combinedAxis * axisIntensity);

  // === Surface Alpha for Smooth Background Blending ===
  // Surface alpha uses linear effectiveOpacity for smooth fade to background
  // Line/axis presence adds slight alpha boost for edge definition
  float linePresence = max(line, combinedAxis * 0.7);
  float alpha = effectiveOpacity * (0.85 + 0.15 * linePresence);

  // Discard nearly invisible fragments
  if (alpha < 0.01) discard;

  fragColor = vec4(finalColor, alpha);
}
`;
