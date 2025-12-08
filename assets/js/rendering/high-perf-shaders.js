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
out float v_pointSize;    // Highlight sprite size
out float v_dotSize;      // What the actual dot size would be (for accurate inner radius)
out float v_viewDistance; // For atmospheric fog

void main() {
  vec4 eyePos = u_viewMatrix * u_modelMatrix * vec4(a_position, 1.0);
  gl_Position = u_projectionMatrix * eyePos;

  float eyeDepth = -eyePos.z;
  v_viewDistance = length(eyePos.xyz);

  // Calculate what the DOT size would be (same formula as main dot shader)
  float projectionFactor = u_viewportHeight / (2.0 * tan(u_fov * 0.5));
  float dotWorldSize = u_pointSize * 0.01;
  float dotPerspective = (dotWorldSize * projectionFactor) / max(eyeDepth, 0.001);
  float dotSize = mix(u_pointSize, dotPerspective, u_sizeAttenuation);
  dotSize = clamp(dotSize, 0.5, 128.0); // Same clamp as main dots!
  v_dotSize = dotSize;

  // Highlight sprite scales proportionally with dot using constant multiplier
  // This ensures consistent visual appearance at all zoom levels
  float highlightSize = dotSize * u_highlightScale;
  highlightSize = clamp(highlightSize, 1.0, 256.0);
  gl_PointSize = highlightSize;
  v_pointSize = highlightSize;

  // Discard if not highlighted (alpha channel stores highlight state)
  if (a_color.a < 0.01) {
    gl_PointSize = 0.0;
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

in float v_alpha;
in float v_pointSize; // Highlight sprite size
in float v_dotSize;   // Actual dot size for accurate inner radius
in float v_viewDistance; // For atmospheric fog

uniform vec3 u_highlightColor;
uniform float u_ringWidth;
uniform float u_haloStrength;
uniform float u_haloShape; // 0 = circle, 1 = square
uniform float u_highlightScale;
uniform float u_ringStyle; // 0 = 3D torus, 1 = flat circle, 2 = flat square
uniform float u_time; // For animated glow

// Atmospheric fog uniforms (same as HP_FS_FULL)
uniform float u_fogDensity;
uniform float u_fogNear;
uniform float u_fogFar;
uniform vec3 u_fogColor;

// Lighting uniforms (same as HP_FS_FULL)
uniform float u_lightingStrength;
uniform vec3 u_lightDir;

out vec4 fragColor;

// Helper function to apply atmospheric fog (Beer-Lambert law)
vec3 applyFog(vec3 color) {
  float fogSpan = max(u_fogFar - u_fogNear, 0.0001);
  float normalizedDistance = max(v_viewDistance - u_fogNear, 0.0) / fogSpan;
  float extinction = u_fogDensity * u_fogDensity * 0.6;
  float transmittance = exp(-extinction * normalizedDistance);
  return mix(u_fogColor, color, transmittance);
}

float getFogTransmittance() {
  float fogSpan = max(u_fogFar - u_fogNear, 0.0001);
  float normalizedDistance = max(v_viewDistance - u_fogNear, 0.0) / fogSpan;
  float extinction = u_fogDensity * u_fogDensity * 0.6;
  return exp(-extinction * normalizedDistance);
}

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
      float glowFactor = 0.5 + 0.5 * sin(u_time * 4.0);

      // === BASE LIGHTING (exactly matches HP_FS_FULL at glowFactor=0) ===
      vec3 lightDir = normalize(u_lightDir);
      float NdotL = max(dot(normal, lightDir), 0.0);
      float ambient = 0.4;
      float diffuse = 0.6 * NdotL;
      vec3 viewDir = vec3(0.0, 0.0, 1.0);
      vec3 halfDir = normalize(lightDir + viewDir);
      float specular = pow(max(dot(normal, halfDir), 0.0), 32.0) * 0.3;

      // Lit color (same formula as HP_FS_FULL)
      vec3 litColor = u_highlightColor * (ambient + diffuse) + vec3(specular);
      // Apply lighting strength (same as HP_FS_FULL)
      vec3 baseColor = mix(u_highlightColor, litColor, u_lightingStrength);

      // === GLOW ADDITIONS (only when glowFactor > 0) ===
      // Extra brightness
      float extraBrightness = glowFactor * 0.3;
      // Extra specular
      float extraSpecular = glowFactor * 0.2 * pow(max(dot(normal, halfDir), 0.0), 32.0);
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
      float glowFactor = 0.5 + 0.5 * sin(u_time * 4.0);
      float shimmer = 0.5 + 0.5 * sin(u_time * 8.0 + radial * 3.14159);

      // === LIGHTING using u_lightDir ===
      vec3 lightDir = normalize(u_lightDir);
      vec3 viewDir = vec3(0.0, 0.0, 1.0);

      // === BASE LIGHTING (same formula as HP_FS_FULL at glowFactor=0) ===
      float NdotL = max(dot(normal, lightDir), 0.0);
      float ambient = 0.4;
      float diffuse = 0.6 * NdotL;
      vec3 halfVec = normalize(lightDir + viewDir);
      float specular = pow(max(dot(normal, halfVec), 0.0), 32.0) * 0.3;

      // Lit color (same formula as HP_FS_FULL)
      vec3 litColor = u_highlightColor * (ambient + diffuse) + vec3(specular);
      // Apply lighting strength (same as HP_FS_FULL)
      vec3 baseColor = mix(u_highlightColor, litColor, u_lightingStrength);

      // === GLOW ADDITIONS (only when glowFactor > 0) ===
      float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);
      vec3 warmWhite = vec3(1.0, 0.98, 0.95);

      // Extra brightness
      float extraBrightness = glowFactor * 0.4;
      // Extra specular with shimmer
      float extraSpec = glowFactor * shimmer * pow(max(dot(normal, halfVec), 0.0), 32.0) * 0.5;
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

    // Apply atmospheric fog
    vec3 foggedColor = applyFog(finalColor);
    float transmittance = getFogTransmittance();
    float foggedAlpha = (0.1 + 0.9 * transmittance) * finalAlpha;

    fragColor = vec4(foggedColor, foggedAlpha);
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
