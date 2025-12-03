// Volumetric smoke shaders (WebGL2 / GLSL ES 3.0)
// Based on original, with added parameters for better customization

export const SMOKE_VS_SOURCE = `#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_uv;
out vec2 v_ndc;

void main() {
  v_ndc = a_position;
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const SMOKE_FS_SOURCE = `#version 300 es
precision highp float;

in vec2 v_uv;
in vec2 v_ndc;

uniform sampler2D u_densityTex;
uniform float u_gridSize;
uniform float u_slicesPerRow;
uniform vec2 u_tileUVSize;

uniform mat4 u_invViewProj;
uniform vec3 u_cameraPos;

uniform vec3 u_volumeMin;
uniform vec3 u_volumeMax;

uniform vec3 u_bgColor;
uniform vec3 u_smokeColor;
uniform vec3 u_lightDir;

uniform float u_time;
uniform float u_animationSpeed;
uniform float u_densityMultiplier;
uniform float u_stepMultiplier;
uniform float u_noiseScale;
uniform float u_warpStrength;
uniform float u_detailLevel;
uniform float u_lightAbsorption;
uniform float u_scatterStrength;
uniform float u_edgeSoftness;

out vec4 fragColor;

// --- 3D value noise / FBM ---

float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p += dot(p, p.yzx + 19.19);
  return fract(p.x * p.y * p.z * 93.5453);
}

float valueNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);

  float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));

  vec3 u = f * f * (3.0 - 2.0 * f);

  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);

  float nxy0 = mix(nx00, nx10, u.y);
  float nxy1 = mix(nx01, nx11, u.y);

  return mix(nxy0, nxy1, u.z);
}

float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += valueNoise(p) * amp;
    p *= 2.02;
    amp *= 0.5;
  }
  return sum;
}

// --- Volume sampling from 3D atlas stored as a 2D texture ---

float sampleSlice(vec2 xy01, float sliceIdx) {
  float col = mod(sliceIdx, u_slicesPerRow);
  float row = floor(sliceIdx / u_slicesPerRow);
  vec2 uvBase = vec2(col, row) * u_tileUVSize;
  vec2 uv = uvBase + xy01 * u_tileUVSize;
  return texture(u_densityTex, uv).r;
}

float sampleDensity(vec3 p01) {
  float z = clamp(p01.z * (u_gridSize - 1.0), 0.0, u_gridSize - 1.001);
  float slice = floor(z);
  float fz = fract(z);

  float d0 = sampleSlice(p01.xy, slice);
  float d1 = sampleSlice(p01.xy, min(slice + 1.0, u_gridSize - 1.0));

  return mix(d0, d1, fz);
}

// --- Ray / box intersection ---

bool intersectBox(vec3 ro, vec3 rd, vec3 bMin, vec3 bMax, out float t0, out float t1) {
  vec3 invDir = 1.0 / rd;

  vec3 tMin = (bMin - ro) * invDir;
  vec3 tMax = (bMax - ro) * invDir;

  vec3 t1v = min(tMin, tMax);
  vec3 t2v = max(tMin, tMax);

  t0 = max(max(t1v.x, t1v.y), t1v.z);
  t1 = min(min(t2v.x, t2v.y), t2v.z);

  return t1 > max(t0, 0.0);
}

void main() {
  // 1. Reconstruct world-space ray from NDC.
  vec2 ndc = v_ndc;
  vec4 clipFar = vec4(ndc, 1.0, 1.0);
  vec4 worldFar = u_invViewProj * clipFar;
  worldFar.xyz /= worldFar.w;

  vec3 rayOrigin = u_cameraPos;
  vec3 rayDir = normalize(worldFar.xyz - rayOrigin);

  // 2. Ray-box intersection.
  float tEnter, tExit;
  if (!intersectBox(rayOrigin, rayDir, u_volumeMin, u_volumeMax, tEnter, tExit)) {
    fragColor = vec4(u_bgColor, 1.0);
    return;
  }

  tEnter = max(tEnter, 0.0);
  float segmentLength = max(tExit - tEnter, 0.0001);

  // Calculate distance for LOD
  vec3 volumeCenter = (u_volumeMin + u_volumeMax) * 0.5;
  float distToVolume = length(rayOrigin - volumeCenter);
  vec3 volumeSize = u_volumeMax - u_volumeMin;
  float volumeScale = max(max(volumeSize.x, volumeSize.y), volumeSize.z);
  float lodFactor = clamp(distToVolume / (volumeScale * 2.0), 0.5, 2.0);

  // Adaptive step count
  const int MAX_STEPS = 64;
  float effectiveSteps = 48.0 * u_stepMultiplier / lodFactor;
  effectiveSteps = max(24.0, min(64.0, effectiveSteps));
  float stepLen = segmentLength / effectiveSteps;

  vec4 acc = vec4(0.0);

  // Phase function for scattering
  float mu = max(dot(normalize(-rayDir), normalize(u_lightDir)), 0.0);
  float phase = 0.25 + 0.75 * mu * mu * u_scatterStrength;

  // Animated time with speed control
  float animTime = u_time * u_animationSpeed;

  float t = tEnter;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (t > tExit) break;
    if (acc.a > 0.98) break;

    vec3 pos = rayOrigin + rayDir * t;
    vec3 p01 = (pos - u_volumeMin) / (u_volumeMax - u_volumeMin);
    p01 = clamp(p01, 0.0, 1.0);

    // Use WORLD SPACE position for noise (view-independent)
    vec3 worldPos = pos;
    vec3 q = worldPos * u_noiseScale;

    // Domain-warped noise for motion
    float n1 = fbm(q + vec3(0.0,  0.0,  animTime * 0.20));
    float n2 = fbm(q + vec3(5.2,  1.3,  animTime * 0.15));
    float n3 = fbm(q + vec3(8.5,  3.7,  animTime * 0.10));

    vec3 warp = (vec3(n1, n2, n3) - 0.5) * u_warpStrength;
    vec3 pWarp = clamp(p01 + warp, 0.0, 1.0);

    float baseDensity = sampleDensity(pWarp);

    // Skip low density for performance
    if (baseDensity < 0.01) {
      t += stepLen;
      continue;
    }

    // Detail noise (more when close)
    float detailScale = 1.0 + u_detailLevel / lodFactor;
    float detail = fbm(q * detailScale + vec3(0.0, 0.0, animTime * 0.05));

    // Combine density with detail
    float noiseTerm = 0.6 + 0.4 * detail;
    float density = baseDensity * noiseTerm * u_densityMultiplier;

    // Soft threshold for wispy edges
    float threshold = 0.02 * u_edgeSoftness;
    density = max(density - threshold, 0.0);

    // Convert density to per-step opacity with absorption control
    float alphaStep = 1.0 - exp(-density * stepLen * 18.0 * u_lightAbsorption);

    if (alphaStep <= 0.0001) {
      t += stepLen;
      continue;
    }

    // Shade: brighter where denser
    float shade = clamp(density * 1.8, 0.0, 1.0);
    vec3 sampleColor = mix(u_bgColor, u_smokeColor, shade);
    sampleColor *= phase;

    // Front-to-back compositing
    float oneMinusA = 1.0 - acc.a;
    acc.rgb += sampleColor * alphaStep * oneMinusA;
    acc.a   += alphaStep * oneMinusA;

    t += stepLen;
  }

  vec3 outColor = mix(u_bgColor, acc.rgb, acc.a);
  fragColor = vec4(outColor, 1.0);
}
`;

// Second pass: upsample + slight blur for half-resolution smoke
export const SMOKE_COMPOSITE_VS = `#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const SMOKE_COMPOSITE_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_smokeTex;
uniform vec2 u_inverseResolution;
uniform float u_intensity;

out vec4 fragColor;

void main() {
  vec4 c0 = texture(u_smokeTex, v_uv);
  vec2 off = u_inverseResolution;

  vec4 c1 = texture(u_smokeTex, v_uv + vec2( off.x, 0.0));
  vec4 c2 = texture(u_smokeTex, v_uv + vec2(-off.x, 0.0));
  vec4 c3 = texture(u_smokeTex, v_uv + vec2(0.0,  off.y));
  vec4 c4 = texture(u_smokeTex, v_uv + vec2(0.0, -off.y));

  // Simple 5-tap blur, good enough for smoke
  vec4 blurred = c0 * 0.4 + (c1 + c2 + c3 + c4) * 0.15;
  fragColor = vec4(blurred.rgb * u_intensity, 1.0);
}
`;
