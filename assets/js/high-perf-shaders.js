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
 * - Interleaved vertex attribute support
 */

// ============================================================================
// WEBGL2 SHADERS (GLSL ES 3.0)
// ============================================================================

/**
 * Full-featured vertex shader with all lighting and fog calculations on GPU
 */
export const HP_VS_FULL = `#version 300 es
precision highp float;

// Interleaved vertex data: pos.xyz + color.rgb + alpha
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_color;
layout(location = 2) in float a_alpha;

uniform mat4 u_mvpMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_modelMatrix;
uniform float u_pointSize;
uniform float u_sizeAttenuation;
uniform float u_viewportHeight;
uniform float u_fov;

out vec3 v_color;
out float v_viewDistance;
out float v_alpha;

void main() {
  vec4 worldPos = u_modelMatrix * vec4(a_position, 1.0);
  vec4 eyePos = u_viewMatrix * worldPos;
  gl_Position = u_mvpMatrix * vec4(a_position, 1.0);

  float eyeDepth = -eyePos.z;
  v_viewDistance = length(eyePos.xyz);

  // Perspective point size with attenuation
  float projectionFactor = u_viewportHeight / (2.0 * tan(u_fov * 0.5));
  float worldSize = u_pointSize * 0.01;
  float perspectiveSize = (worldSize * projectionFactor) / max(eyeDepth, 0.001);
  gl_PointSize = mix(u_pointSize, perspectiveSize, u_sizeAttenuation);
  gl_PointSize = clamp(gl_PointSize, 0.5, 128.0);

  // Early discard for invisible points
  if (a_alpha < 0.01) {
    gl_PointSize = 0.0;
  }

  v_color = a_color;
  v_alpha = a_alpha;
}
`;

/**
 * Full-featured fragment shader with lighting and fog
 */
export const HP_FS_FULL = `#version 300 es
precision highp float;

in vec3 v_color;
in float v_viewDistance;
in float v_alpha;

uniform float u_lightingStrength;
uniform float u_fogDensity;
uniform float u_fogNear;
uniform float u_fogFar;
uniform vec3 u_fogColor;
uniform vec3 u_lightDir;

out vec4 fragColor;

void main() {
  if (v_alpha < 0.01) discard;

  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  if (r2 > 1.0) discard;

  // Sphere normal for lighting
  float z = sqrt(1.0 - r2);
  vec3 normal = vec3(coord.x, -coord.y, z);

  // Lighting calculation
  float NdotL = max(dot(normal, u_lightDir), 0.0);
  float ambient = 0.4;
  float diffuse = 0.6 * NdotL;
  vec3 viewDir = vec3(0.0, 0.0, 1.0);
  vec3 halfDir = normalize(u_lightDir + viewDir);
  float specular = pow(max(dot(normal, halfDir), 0.0), 32.0) * 0.3;
  vec3 litColor = v_color * (ambient + diffuse) + vec3(specular);
  vec3 shadedColor = mix(v_color, litColor, u_lightingStrength);

  // GPU-computed fog using Beer-Lambert law
  float fogSpan = max(u_fogFar - u_fogNear, 0.0001);
  float normalizedDistance = max(v_viewDistance - u_fogNear, 0.0) / fogSpan;
  float extinction = u_fogDensity * u_fogDensity * 0.6;
  float transmittance = exp(-extinction * normalizedDistance);
  vec3 finalColor = mix(u_fogColor, shadedColor, transmittance);

  float alpha = (0.1 + 0.9 * transmittance) * v_alpha;
  fragColor = vec4(finalColor, alpha);
}
`;

/**
 * LIGHTWEIGHT vertex shader - minimal calculations for maximum FPS
 */
export const HP_VS_LIGHT = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_color;
layout(location = 2) in float a_alpha;

uniform mat4 u_mvpMatrix;
uniform float u_pointSize;

out vec3 v_color;
out float v_alpha;

void main() {
  gl_Position = u_mvpMatrix * vec4(a_position, 1.0);
  gl_PointSize = u_pointSize;

  if (a_alpha < 0.01) gl_PointSize = 0.0;

  v_color = a_color;
  v_alpha = a_alpha;
}
`;

/**
 * LIGHTWEIGHT fragment shader - flat shading, no lighting, no fog
 */
export const HP_FS_LIGHT = `#version 300 es
precision highp float;

in vec3 v_color;
in float v_alpha;

out vec4 fragColor;

void main() {
  if (v_alpha < 0.01) discard;

  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  if (r2 > 1.0) discard;

  fragColor = vec4(v_color, v_alpha);
}
`;

/**
 * ULTRA-LIGHTWEIGHT fragment shader - square points for absolute maximum FPS
 */
export const HP_FS_ULTRALIGHT = `#version 300 es
precision mediump float;

in vec3 v_color;
in float v_alpha;

out vec4 fragColor;

void main() {
  fragColor = vec4(v_color, v_alpha);
}
`;

/**
 * LOD vertex shader - supports variable point sizes based on aggregation level
 */
export const HP_VS_LOD = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_color;
layout(location = 2) in float a_alpha;
layout(location = 3) in float a_lodSize;

uniform mat4 u_mvpMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_modelMatrix;
uniform float u_pointSize;
uniform float u_viewportHeight;
uniform float u_fov;

out vec3 v_color;
out float v_viewDistance;
out float v_alpha;

void main() {
  vec4 eyePos = u_viewMatrix * u_modelMatrix * vec4(a_position, 1.0);
  gl_Position = u_mvpMatrix * vec4(a_position, 1.0);

  float eyeDepth = -eyePos.z;
  v_viewDistance = length(eyePos.xyz);

  // Size based on LOD level (aggregated points are larger)
  float projectionFactor = u_viewportHeight / (2.0 * tan(u_fov * 0.5));
  float worldSize = u_pointSize * 0.01 * a_lodSize;
  float perspectiveSize = (worldSize * projectionFactor) / max(eyeDepth, 0.001);
  gl_PointSize = clamp(perspectiveSize, 1.0, 256.0);

  v_color = a_color;
  v_alpha = a_alpha;
}
`;

/**
 * Instanced rendering vertex shader - for rendering many identical point sprites
 */
export const HP_VS_INSTANCED = `#version 300 es
precision highp float;

// Per-vertex attributes (unit quad)
layout(location = 0) in vec2 a_quadPos;

// Per-instance attributes
layout(location = 1) in vec3 a_instancePos;
layout(location = 2) in vec3 a_instanceColor;
layout(location = 3) in float a_instanceAlpha;

uniform mat4 u_mvpMatrix;
uniform mat4 u_viewMatrix;
uniform float u_pointSize;
uniform float u_viewportHeight;

out vec3 v_color;
out vec2 v_quadCoord;
out float v_alpha;

void main() {
  vec4 eyePos = u_viewMatrix * vec4(a_instancePos, 1.0);
  float eyeDepth = -eyePos.z;

  // Billboard quad in clip space
  vec4 clipPos = u_mvpMatrix * vec4(a_instancePos, 1.0);

  float size = u_pointSize / u_viewportHeight;
  vec2 offset = a_quadPos * size * clipPos.w;
  clipPos.xy += offset;

  gl_Position = clipPos;
  v_quadCoord = a_quadPos;
  v_color = a_instanceColor;
  v_alpha = a_instanceAlpha;
}
`;

export const HP_FS_INSTANCED = `#version 300 es
precision highp float;

in vec3 v_color;
in vec2 v_quadCoord;
in float v_alpha;

out vec4 fragColor;

void main() {
  float r2 = dot(v_quadCoord, v_quadCoord);
  if (r2 > 1.0) discard;

  fragColor = vec4(v_color, v_alpha);
}
`;

// ============================================================================
// 16-BIT FLOAT SHADERS (for texture-based attribute storage)
// ============================================================================

/**
 * Vertex shader that fetches position/color from textures
 * Enables massive datasets with texture-based storage
 */
export const HP_VS_TEXTURE = `#version 300 es
precision highp float;

layout(location = 0) in float a_pointIndex;

uniform sampler2D u_positionTex;
uniform sampler2D u_colorTex;
uniform sampler2D u_alphaTex;
uniform int u_texWidth;
uniform mat4 u_mvpMatrix;
uniform float u_pointSize;

out vec3 v_color;
out float v_alpha;

vec4 fetchFromTexture(sampler2D tex, float index, int width) {
  int idx = int(index);
  int y = idx / width;
  int x = idx - y * width;
  return texelFetch(tex, ivec2(x, y), 0);
}

void main() {
  vec4 pos = fetchFromTexture(u_positionTex, a_pointIndex, u_texWidth);
  vec4 col = fetchFromTexture(u_colorTex, a_pointIndex, u_texWidth);
  vec4 alpha = fetchFromTexture(u_alphaTex, a_pointIndex, u_texWidth);

  gl_Position = u_mvpMatrix * vec4(pos.xyz, 1.0);
  gl_PointSize = u_pointSize;

  if (alpha.r < 0.01) gl_PointSize = 0.0;

  v_color = col.rgb;
  v_alpha = alpha.r;
}
`;

// ============================================================================
// SHADER SELECTION HELPERS
// ============================================================================

/**
 * Get the appropriate shaders based on quality settings (WebGL2 only)
 */
export function getShaders(quality = 'full') {
  switch (quality) {
    case 'ultralight':
      return { vs: HP_VS_LIGHT, fs: HP_FS_ULTRALIGHT };
    case 'light':
      return { vs: HP_VS_LIGHT, fs: HP_FS_LIGHT };
    case 'lod':
      return { vs: HP_VS_LOD, fs: HP_FS_FULL };
    case 'instanced':
      return { vs: HP_VS_INSTANCED, fs: HP_FS_INSTANCED };
    case 'texture':
      return { vs: HP_VS_TEXTURE, fs: HP_FS_LIGHT };
    case 'full':
    default:
      return { vs: HP_VS_FULL, fs: HP_FS_FULL };
  }
}

export default {
  HP_VS_FULL,
  HP_FS_FULL,
  HP_VS_LIGHT,
  HP_FS_LIGHT,
  HP_FS_ULTRALIGHT,
  HP_VS_LOD,
  HP_VS_INSTANCED,
  HP_FS_INSTANCED,
  HP_VS_TEXTURE,
  getShaders
};
