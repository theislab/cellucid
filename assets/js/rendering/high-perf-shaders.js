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
 * Alpha is fetched from a separate texture for efficient updates (avoids full buffer rebuild)
 */
export const HP_VS_FULL = `#version 300 es
precision highp float;

// Interleaved vertex data: pos.xyz (float32) + color.rgba (uint8 normalized)
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color; // RGBA packed, auto-normalized by WebGL

uniform mat4 u_mvpMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_modelMatrix;
uniform mat4 u_projectionMatrix;
uniform float u_pointSize;
uniform float u_sizeAttenuation;
uniform float u_viewportHeight;
uniform float u_fov;

// Alpha texture for efficient alpha-only updates (avoids full buffer rebuild)
uniform sampler2D u_alphaTex;
uniform int u_alphaTexWidth;
uniform float u_invAlphaTexWidth;
uniform bool u_useAlphaTex;

out vec3 v_color;
out float v_viewDistance;
out float v_alpha;

void main() {
  vec4 eyePos = u_viewMatrix * u_modelMatrix * vec4(a_position, 1.0);
  gl_Position = u_projectionMatrix * eyePos;

  float eyeDepth = -eyePos.z;
  v_viewDistance = length(eyePos.xyz);

  // Fetch alpha from texture if enabled, otherwise use vertex attribute
  float alpha;
  if (u_useAlphaTex && u_alphaTexWidth > 0) {
    int y = int(float(gl_VertexID) * u_invAlphaTexWidth);
    int x = gl_VertexID - y * u_alphaTexWidth;
    alpha = texelFetch(u_alphaTex, ivec2(x, y), 0).r;
  } else {
    alpha = a_color.a;
  }

  // Perspective point size with attenuation
  float projectionFactor = u_viewportHeight / (2.0 * tan(u_fov * 0.5));
  float worldSize = u_pointSize * 0.01;
  float perspectiveSize = (worldSize * projectionFactor) / max(eyeDepth, 0.001);
  gl_PointSize = mix(u_pointSize, perspectiveSize, u_sizeAttenuation);
  gl_PointSize = clamp(gl_PointSize, 0.5, 128.0);

  // Early discard for invisible points
  if (alpha < 0.01) {
    gl_PointSize = 0.0;
  }

  v_color = a_color.rgb;
  v_alpha = alpha;
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
 * Alpha is fetched from a separate texture for efficient updates
 */
export const HP_VS_LIGHT = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color; // RGBA packed, auto-normalized by WebGL

uniform mat4 u_mvpMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_modelMatrix;
uniform mat4 u_projectionMatrix;
uniform float u_pointSize;
uniform float u_sizeAttenuation;
uniform float u_viewportHeight;
uniform float u_fov;

// Alpha texture for efficient alpha-only updates
uniform sampler2D u_alphaTex;
uniform int u_alphaTexWidth;
uniform float u_invAlphaTexWidth;
uniform bool u_useAlphaTex;

out vec3 v_color;
out float v_alpha;

void main() {
  vec4 eyePos = u_viewMatrix * u_modelMatrix * vec4(a_position, 1.0);
  gl_Position = u_projectionMatrix * eyePos;

  float eyeDepth = -eyePos.z;

  // Fetch alpha from texture if enabled
  float alpha;
  if (u_useAlphaTex && u_alphaTexWidth > 0) {
    int y = int(float(gl_VertexID) * u_invAlphaTexWidth);
    int x = gl_VertexID - y * u_alphaTexWidth;
    alpha = texelFetch(u_alphaTex, ivec2(x, y), 0).r;
  } else {
    alpha = a_color.a;
  }

  float projectionFactor = u_viewportHeight / (2.0 * tan(u_fov * 0.5));
  float worldSize = u_pointSize * 0.01;
  float perspectiveSize = (worldSize * projectionFactor) / max(eyeDepth, 0.001);
  gl_PointSize = mix(u_pointSize, perspectiveSize, u_sizeAttenuation);
  gl_PointSize = clamp(gl_PointSize, 1.0, 192.0);

  if (alpha < 0.01) gl_PointSize = 0.0;

  v_color = a_color.rgb;
  v_alpha = alpha;
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
 * Uses alpha texture with index remapping for LOD levels
 */
export const HP_VS_LOD = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color; // RGBA packed, auto-normalized by WebGL
layout(location = 2) in float a_lodSize;

uniform mat4 u_mvpMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_modelMatrix;
uniform mat4 u_projectionMatrix;
uniform float u_pointSize;
uniform float u_viewportHeight;
uniform float u_fov;

// Alpha texture for efficient alpha-only updates
uniform sampler2D u_alphaTex;
uniform int u_alphaTexWidth;
uniform float u_invAlphaTexWidth;
uniform bool u_useAlphaTex;
// For LOD: maps LOD vertex index to original point index for alpha lookup
uniform sampler2D u_lodIndexTex;
uniform int u_lodIndexTexWidth;
uniform float u_invLodIndexTexWidth;
uniform bool u_useLodIndexTex;

out vec3 v_color;
out float v_viewDistance;
out float v_alpha;

void main() {
  vec4 eyePos = u_viewMatrix * u_modelMatrix * vec4(a_position, 1.0);
  gl_Position = u_projectionMatrix * eyePos;

  float eyeDepth = -eyePos.z;
  v_viewDistance = length(eyePos.xyz);

  // Fetch alpha from texture if enabled
  float alpha;
  if (u_useAlphaTex && u_alphaTexWidth > 0) {
    int origIdx;
    if (u_useLodIndexTex && u_lodIndexTexWidth > 0) {
      // LOD mode: lookup original index from index texture
      int iy = int(float(gl_VertexID) * u_invLodIndexTexWidth);
      int ix = gl_VertexID - iy * u_lodIndexTexWidth;
      origIdx = int(texelFetch(u_lodIndexTex, ivec2(ix, iy), 0).r);
    } else {
      origIdx = gl_VertexID;
    }
    int y = int(float(origIdx) * u_invAlphaTexWidth);
    int x = origIdx - y * u_alphaTexWidth;
    alpha = texelFetch(u_alphaTex, ivec2(x, y), 0).r;
  } else {
    alpha = a_color.a;
  }

  // Size based on LOD level (aggregated points are larger)
  float projectionFactor = u_viewportHeight / (2.0 * tan(u_fov * 0.5));
  float worldSize = u_pointSize * 0.01 * a_lodSize;
  float perspectiveSize = (worldSize * projectionFactor) / max(eyeDepth, 0.001);
  gl_PointSize = clamp(perspectiveSize, 1.0, 256.0);

  if (alpha < 0.01) gl_PointSize = 0.0;

  v_color = a_color.rgb;
  v_alpha = alpha;
}
`;

/**
 * Instanced rendering vertex shader - for rendering many identical point sprites
 * Uses RGBA uint8 packed color (auto-normalized by WebGL)
 */
export const HP_VS_INSTANCED = `#version 300 es
precision highp float;

// Per-vertex attributes (unit quad)
layout(location = 0) in vec2 a_quadPos;

// Per-instance attributes
layout(location = 1) in vec3 a_instancePos;
layout(location = 2) in vec4 a_instanceColor; // RGBA packed as uint8, auto-normalized

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
  v_color = a_instanceColor.rgb;
  v_alpha = a_instanceColor.a;
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
uniform sampler2D u_colorTex; // Now stores RGBA
uniform int u_texWidth;
uniform float u_invTexWidth;
uniform mat4 u_mvpMatrix;
uniform float u_pointSize;

out vec3 v_color;
out float v_alpha;

vec4 fetchFromTexture(sampler2D tex, int idx, int width, float invWidth) {
  int y = int(float(idx) * invWidth);
  int x = idx - y * width;
  return texelFetch(tex, ivec2(x, y), 0);
}

void main() {
  int idx = int(a_pointIndex);
  vec4 pos = fetchFromTexture(u_positionTex, idx, u_texWidth, u_invTexWidth);
  vec4 col = fetchFromTexture(u_colorTex, idx, u_texWidth, u_invTexWidth);

  gl_Position = u_mvpMatrix * vec4(pos.xyz, 1.0);
  gl_PointSize = u_pointSize;

  if (col.a < 0.01) gl_PointSize = 0.0;

  v_color = col.rgb;
  v_alpha = col.a;
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

// ============================================================================
// HIGHLIGHT RING SHADERS - for rendering selection highlights
// ============================================================================

/**
 * Highlight vertex shader - renders highlighted points with a ring effect
 * Uses same interleaved layout as main points
 */
export const HP_VS_HIGHLIGHT = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color; // RGBA packed - we only use alpha for visibility

uniform mat4 u_mvpMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_modelMatrix;
uniform mat4 u_projectionMatrix;
uniform float u_pointSize;
uniform float u_sizeAttenuation;
uniform float u_viewportHeight;
uniform float u_fov;
uniform float u_highlightScale; // How much larger the highlight ring is (e.g., 1.5)

out float v_alpha;

void main() {
  vec4 eyePos = u_viewMatrix * u_modelMatrix * vec4(a_position, 1.0);
  gl_Position = u_projectionMatrix * eyePos;

  float eyeDepth = -eyePos.z;

  // Perspective point size with attenuation - scaled up for highlight ring
  float projectionFactor = u_viewportHeight / (2.0 * tan(u_fov * 0.5));
  float worldSize = u_pointSize * 0.01 * u_highlightScale;
  float perspectiveSize = (worldSize * projectionFactor) / max(eyeDepth, 0.001);
  gl_PointSize = mix(u_pointSize * u_highlightScale, perspectiveSize, u_sizeAttenuation);
  gl_PointSize = clamp(gl_PointSize, 1.0, 192.0);

  // Discard if not highlighted (alpha channel stores highlight state)
  if (a_color.a < 0.01) {
    gl_PointSize = 0.0;
  }

  v_alpha = a_color.a;
}
`;

/**
 * Highlight fragment shader - draws a ring/glow effect
 */
export const HP_FS_HIGHLIGHT = `#version 300 es
precision highp float;

in float v_alpha;

uniform vec3 u_highlightColor;
uniform float u_ringWidth; // Width of the ring as fraction of radius (e.g., 0.15)
uniform float u_haloStrength;
uniform float u_haloShape; // 0 = circle, 1 = square

out vec4 fragColor;

void main() {
  if (v_alpha < 0.01) discard;

  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float axisMax = max(abs(coord.x), abs(coord.y));
  float r = mix(length(coord), axisMax, step(0.5, u_haloShape));
  if (r > 1.0) discard; // enforce circular or square bounds based on shape

  float innerRadius = 1.0 - u_ringWidth;

  // Crisp rim that hugs the boundary
  float rim = smoothstep(innerRadius - 0.05, innerRadius + 0.02, r);

  // Soft fill so highlighted cells stay legible
  float fill = 1.0 - smoothstep(innerRadius - 0.10, innerRadius + 0.12, r);

  // Outer halo that fades before the sprite edge
  float halo = smoothstep(0.55, 0.9, r) * (1.0 - smoothstep(0.9, 1.02, r));
  halo *= u_haloStrength;

  float alpha = rim * 0.92 + fill * 0.30 + halo;
  if (alpha < 0.01) discard;

  // Keep the core golden and avoid washing out to white
  vec3 color = mix(u_highlightColor, vec3(1.0, 0.9, 0.45), fill * 0.18);
  fragColor = vec4(color, alpha * v_alpha);
}
`;

/**
 * Alternative highlight shader with pulsing glow effect
 */
export const HP_FS_HIGHLIGHT_GLOW = `#version 300 es
precision highp float;

in float v_alpha;

uniform vec3 u_highlightColor;
uniform float u_time;

out vec4 fragColor;

void main() {
  if (v_alpha < 0.01) discard;

  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r = length(coord);

  if (r > 1.0) discard;

  // Pulsing glow effect
  float pulse = 0.7 + 0.3 * sin(u_time * 3.0);

  // Outer ring
  float ring = smoothstep(0.7, 0.85, r) * smoothstep(1.0, 0.9, r);

  // Inner glow (subtle fill)
  float innerGlow = (1.0 - r) * 0.15;

  float alpha = (ring + innerGlow) * pulse * v_alpha;

  fragColor = vec4(u_highlightColor, alpha);
}
`;

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
  HP_VS_HIGHLIGHT,
  HP_FS_HIGHLIGHT,
  HP_FS_HIGHLIGHT_GLOW,
  getShaders
};
