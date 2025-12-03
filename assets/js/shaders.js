/**
 * GLSL Shader Sources (WebGL2 / GLSL ES 3.0)
 * ==========================================
 * Shaders for line rendering and grid background.
 * Point rendering is handled by the high-performance renderer.
 */

// Line shader for connectivity edges (WebGL2)
export const LINE_VS_SOURCE = `#version 300 es
precision highp float;

in vec3 a_position;
in vec3 a_otherPosition;
in float a_side;

uniform mat4 u_mvpMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_modelMatrix;
uniform vec2 u_viewportSize;
uniform float u_lineWidth;

out float v_viewDistance;

void main() {
  // Project both endpoints to clip space
  vec4 clipStart = u_mvpMatrix * vec4(a_position, 1.0);
  vec4 clipEnd = u_mvpMatrix * vec4(a_otherPosition, 1.0);

  // Convert to screen space (pixels)
  vec2 ndcStart = clipStart.xy / clipStart.w;
  vec2 ndcEnd = clipEnd.xy / clipEnd.w;
  vec2 screenStart = (ndcStart * 0.5 + 0.5) * u_viewportSize;
  vec2 screenEnd = (ndcEnd * 0.5 + 0.5) * u_viewportSize;

  // Build a screen-space normal for consistent thickness
  vec2 dir = screenEnd - screenStart;
  float dirLen = length(dir);
  vec2 normal = dirLen > 1e-5 ? vec2(-dir.y, dir.x) / dirLen : vec2(0.0, 1.0);

  // Offset in screen space, then convert back to clip space
  float halfWidth = max(u_lineWidth * 0.5, 0.0);
  vec2 offsetScreen = normal * a_side * halfWidth;
  vec2 offsetNdc = (offsetScreen / u_viewportSize) * 2.0;

  vec4 clipPos = clipStart;
  clipPos.xy += offsetNdc * clipPos.w;

  vec4 eyePos = u_viewMatrix * u_modelMatrix * vec4(a_position, 1.0);
  v_viewDistance = length(eyePos.xyz);
  gl_Position = clipPos;
}
`;

export const LINE_FS_SOURCE = `#version 300 es
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
  // Apply fog to lines for depth perception
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

out vec3 v_worldPos;
out float v_viewDistance;

void main() {
  vec4 worldPos = u_modelMatrix * vec4(a_position, 1.0);
  v_worldPos = worldPos.xyz;

  vec4 eyePos = u_viewMatrix * worldPos;
  v_viewDistance = length(eyePos.xyz);

  gl_Position = u_mvpMatrix * vec4(a_position, 1.0);
}
`;

export const GRID_FS_SOURCE = `#version 300 es
precision highp float;

in vec3 v_worldPos;
in float v_viewDistance;

uniform vec3 u_gridColor;
uniform vec3 u_bgColor;
uniform float u_gridSpacing;
uniform float u_gridLineWidth;
uniform float u_gridOpacity;
uniform int u_planeType; // 0=XY, 1=XZ, 2=YZ
uniform float u_fogDensity;
uniform float u_fogNearMean;
uniform float u_fogFarMean;

out vec4 fragColor;

float gridLine(float coord, float spacing, float lineWidth) {
  float f = abs(fract(coord / spacing + 0.5) - 0.5) * spacing;
  float lineHalf = lineWidth * 0.5;
  // Smooth anti-aliased line using screen-space derivatives
  float derivative = fwidth(coord);
  return 1.0 - smoothstep(lineHalf - derivative, lineHalf + derivative, f);
}

void main() {
  float line = 0.0;

  // Select coordinates based on plane type
  if (u_planeType == 0) {
    // XY plane (back wall) - grid on X and Y
    line = max(gridLine(v_worldPos.x, u_gridSpacing, u_gridLineWidth),
               gridLine(v_worldPos.y, u_gridSpacing, u_gridLineWidth));
  } else if (u_planeType == 1) {
    // XZ plane (floor) - grid on X and Z
    line = max(gridLine(v_worldPos.x, u_gridSpacing, u_gridLineWidth),
               gridLine(v_worldPos.z, u_gridSpacing, u_gridLineWidth));
  } else {
    // YZ plane (side wall) - grid on Y and Z
    line = max(gridLine(v_worldPos.y, u_gridSpacing, u_gridLineWidth),
               gridLine(v_worldPos.z, u_gridSpacing, u_gridLineWidth));
  }

  // Apply fog for depth
  float fogSpan = max(u_fogFarMean - u_fogNearMean, 0.0001);
  float normalizedDistance = max(v_viewDistance - u_fogNearMean, 0.0) / fogSpan;
  float extinction = u_fogDensity * u_fogDensity * 0.4;
  float transmittance = exp(-extinction * normalizedDistance);

  // Mix grid with background
  vec3 gridColorFogged = mix(u_bgColor, u_gridColor, transmittance);
  vec3 finalColor = mix(u_bgColor, gridColorFogged, line * u_gridOpacity);
  float alpha = mix(0.95, 1.0, line * u_gridOpacity * transmittance);

  fragColor = vec4(finalColor, alpha);
}
`;
