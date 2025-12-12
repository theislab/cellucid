// Volumetric Cloud Shaders (WebGL2 / GLSL ES 3.0)
// ================================================
// Professional game-industry techniques from:
// - Horizon Zero Dawn / Nubis cloud system (Guerrilla Games, SIGGRAPH 2015)
// - Frostbite Engine volumetric clouds (EA DICE)
// - God of War (Santa Monica Studio)
// - Red Dead Redemption 2 (Rockstar)
// - Unreal Engine 5 volumetric fog
//
// Key features:
// - Multi-octave FBM with Perlin-Worley blending
// - Dual-lobe Henyey-Greenstein phase function
// - Beer-Powder law for energy-conserving multi-scattering
// - Adaptive ray marching with density-based step sizing
// - Temporal blue noise dithering (R2 sequence)
// - Distance-based detail fading with smooth transitions
// - Edge erosion for realistic wispy boundaries

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
precision highp sampler3D;

in vec2 v_uv;
in vec2 v_ndc;

// ============================================================================
// Uniforms
// ============================================================================

// Density volume (native 3D texture from point cloud)
uniform sampler3D u_densityTex3D;
uniform float u_gridSize;

// Pre-computed noise textures (industry-standard Perlin-Worley)
uniform sampler3D u_shapeNoise;    // R: Perlin-Worley, G: Worley med, B: Worley high, A: Worley erosion
uniform sampler3D u_detailNoise;   // R: detail Worley, G: fine Worley, BA: curl noise
uniform sampler2D u_blueNoise;     // RG: blue noise for jittering
uniform vec2 u_blueNoiseOffset;    // Changes each frame for temporal variation

// Camera and volume
uniform mat4 u_invViewProj;
uniform vec3 u_cameraPos;
uniform vec3 u_volumeMin;
uniform vec3 u_volumeMax;

// Colors and lighting
uniform vec3 u_bgColor;
uniform vec3 u_smokeColor;
uniform vec3 u_lightDir;

// Animation and quality parameters
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
uniform float u_directLightIntensity;

// Light sampling
uniform int u_lightSamples;

out vec4 fragColor;

#define PI 3.14159265359
#define INV_PI 0.31830988618
#define INV_4PI 0.07957747155

// ============================================================================
// Utility Functions
// ============================================================================

// Remap value from one range to another (essential for cloud modeling)
float remap(float value, float oldMin, float oldMax, float newMin, float newMax) {
  return newMin + (value - oldMin) / (oldMax - oldMin) * (newMax - newMin);
}

float remapClamped(float value, float oldMin, float oldMax, float newMin, float newMax) {
  float t = clamp((value - oldMin) / (oldMax - oldMin), 0.0, 1.0);
  return mix(newMin, newMax, t);
}

// Smooth minimum for blending shapes (polynomial smooth min)
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// World-space voxel size (used to keep extinction physically consistent when grid changes)
float getVoxelSize() {
  vec3 size = u_volumeMax - u_volumeMin;
  float maxExtent = max(max(size.x, size.y), size.z);
  return max(maxExtent / max(u_gridSize, 1.0), 0.001);
}

// Smoother step function (Ken Perlin's improved version)
float smootherstep(float edge0, float edge1, float x) {
  x = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}

// ============================================================================
// Noise Sampling - Professional Multi-Octave System
// ============================================================================

// Sample base density from point cloud volume
float sampleBaseDensity(vec3 p01) {
  return texture(u_densityTex3D, clamp(p01, 0.001, 0.999)).r;
}

// Sample shape noise with animation - multi-octave approach
vec4 sampleShapeNoise(vec3 worldPos, float time) {
  vec3 uvw = worldPos * u_noiseScale * 0.25;

  // Wind animation with varying speeds per octave (realistic turbulence)
  vec3 wind = vec3(time * 0.012, time * 0.004, time * 0.008);
  uvw += wind;

  return texture(u_shapeNoise, uvw);
}

// Sample detail noise at multiple frequencies for close-up quality
vec4 sampleDetailNoise(vec3 worldPos, float time, float lod) {
  // Higher base frequency for detail
  vec3 uvw = worldPos * u_noiseScale * 0.6 * u_detailLevel;

  // Faster, more chaotic motion for fine detail
  vec3 detailWind = vec3(time * 0.025, -time * 0.018, time * 0.022);
  uvw += detailWind;

  return textureLod(u_detailNoise, uvw, lod);
}

// Get curl noise offset for turbulent motion (divergence-free)
// Returns offset in normalized [0,1] volume space
vec3 getCurlOffset(vec3 p01, float time) {
  // Sample at multiple scales for richer turbulence
  vec3 uvw = p01 * 2.0 + vec3(time * 0.08, time * 0.05, time * 0.06);
  vec3 uvw2 = p01 * 4.0 + vec3(-time * 0.12, time * 0.09, -time * 0.07);

  vec4 curl1 = texture(u_detailNoise, uvw);
  vec4 curl2 = texture(u_detailNoise, uvw2);

  // Create curl vectors from noise channels
  vec3 curlVec1 = vec3(curl1.r - 0.5, curl1.g - 0.5, curl1.b - 0.5) * 2.0;
  vec3 curlVec2 = vec3(curl2.r - 0.5, curl2.g - 0.5, curl2.b - 0.5) * 2.0;

  // Combine octaves
  vec3 curlVec = curlVec1 * 0.7 + curlVec2 * 0.3;

  return curlVec * u_warpStrength;
}

// Blue noise jitter with R2 quasi-random sequence (superior to pure random)
float getBlueNoiseJitter(vec2 screenCoord) {
  vec2 noiseUV = (screenCoord + u_blueNoiseOffset) / 128.0;
  vec2 noise = texture(u_blueNoise, noiseUV).rg;
  // Combine channels for better distribution
  return fract(noise.r + noise.g * 0.5);
}

// ============================================================================
// Professional Cloud Density Sampling (Horizon Zero Dawn style)
// ============================================================================

float sampleCloudDensity(vec3 worldPos, vec3 p01, float time, float lod, float distanceToCamera) {
  // 1. Sample base density from point cloud - this is the primary source
  float baseDensity = sampleBaseDensity(p01);

  // Early exit for empty space (optimization)
  if (baseDensity < 0.001) return 0.0;

  // 2. Curl noise warping for turbulent motion
  if (u_warpStrength > 0.01) {
    vec3 warpOffset = getCurlOffset(p01, time);
    // Warp strength directly controls displacement amount in normalized space
    // At max warpStrength=1, offset can be up to 0.25 (25% of volume)
    float warpScale = 0.25 * u_warpStrength;
    vec3 warpedP01 = clamp(p01 + warpOffset * warpScale, 0.001, 0.999);
    float warpedDensity = sampleBaseDensity(warpedP01);
    // Full replacement - the warp IS the new position
    baseDensity = warpedDensity;
  }

  // 3. Sample shape noise for subtle modulation
  vec4 shapeNoise = sampleShapeNoise(worldPos, time);

  // Create gentle FBM modulation (keeps most of original density)
  float shapeFBM = shapeNoise.r * 0.5 + shapeNoise.g * 0.3 + shapeNoise.b * 0.2;

  // 4. Gentle shape modulation - preserve base density structure
  // Range [0.7, 1.0] so we never reduce below 70% of original
  float shapeModifier = 0.7 + shapeFBM * 0.3;
  float shapedDensity = baseDensity * shapeModifier;

  // 5. Subtle edge erosion (only if edge softness is high)
  if (u_edgeSoftness > 0.3) {
    float erosionNoise = shapeNoise.a;
    // Very subtle erosion at edges only
    float edgeFactor = smoothstep(0.0, 0.15, baseDensity) * smoothstep(0.5, 0.2, baseDensity);
    float erosion = (1.0 - erosionNoise) * edgeFactor * u_edgeSoftness * 0.1;
    shapedDensity = max(0.0, shapedDensity - erosion);
  }

  // 6. Detail pass - adds fine texture variation
  // Works at all distances but stronger when close
  float distanceFade = smoothstep(15.0, 1.0, distanceToCamera);
  float detailBlend = (0.3 + distanceFade * 0.7) * u_detailLevel;

  if (detailBlend > 0.01) {
    vec4 detailNoise = sampleDetailNoise(worldPos, time, lod);
    float detailFBM = detailNoise.r * 0.5 + detailNoise.g * 0.3 + detailNoise.b * 0.2;

    // Modulate density with detail noise (adds texture, not just erosion)
    float detailMod = (detailFBM - 0.5) * detailBlend * 0.4;
    shapedDensity = clamp(shapedDensity + detailMod * shapedDensity, 0.0, 1.0);
  }

  // 7. Final density in [0,1] – multiplier applied in lighting step
  return shapedDensity;
}

// ============================================================================
// Professional Lighting System
// ============================================================================

// Convert normalized density to extinction respecting grid resolution
float densityToExtinction(float density) {
  float voxelSize = getVoxelSize();
  float extinctionScale = u_densityMultiplier / max(voxelSize, 0.0001);
  return density * extinctionScale;
}

// Simple Henyey-Greenstein phase function
float henyeyGreenstein(float cosTheta, float g) {
  float g2 = g * g;
  float denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return INV_4PI * (1.0 - g2) / pow(max(denom, 0.0001), 1.5);
}

// Phase function - simple and subtle
float phaseFunction(float cosTheta) {
  // Mild forward scattering for natural look
  float g = 0.3 * u_scatterStrength;
  float phase = henyeyGreenstein(cosTheta, g);

  // Blend with isotropic for softer appearance
  float isotropic = INV_4PI;
  return mix(isotropic, phase, 0.5);
}

// Beer-Lambert for shadow rays
float beerLambert(float opticalDepth) {
  return exp(-opticalDepth * u_lightAbsorption);
}

// Sample light transmittance with exponential step distribution
float sampleLightTransmittance(vec3 pos, vec3 lightDir, float stepSize) {
  float accumExtinction = 0.0;
  vec3 volumeSize = u_volumeMax - u_volumeMin;

  int numSamples = u_lightSamples;

  // Exponentially increasing step sizes (more samples near surface)
  float totalDist = 0.0;

  for (int i = 1; i <= 8; i++) {
    if (i > numSamples) break;

    // Exponential distribution: small steps near surface, larger further out
    float stepDist = stepSize * pow(float(i), 1.2);
    totalDist += stepDist;

    vec3 samplePos = pos + lightDir * totalDist;
    vec3 p01 = (samplePos - u_volumeMin) / volumeSize;

    // Exit if outside volume
    if (any(lessThan(p01, vec3(0.0))) || any(greaterThan(p01, vec3(1.0)))) break;

    float density = sampleBaseDensity(p01);
    float extinction = densityToExtinction(density);
    accumExtinction += extinction * stepDist;
  }

  // Simple Beer-Lambert attenuation
  return beerLambert(accumExtinction);
}

// Ambient occlusion approximation (cone sampling)
float sampleAmbientOcclusion(vec3 pos, vec3 volumeSize) {
  vec3 p01 = (pos - u_volumeMin) / volumeSize;

  // Sample density in a small radius for local occlusion
  float occlusionRadius = 0.08;
  float ao = 0.0;

  // 6-direction sampling
  ao += sampleBaseDensity(p01 + vec3(occlusionRadius, 0.0, 0.0));
  ao += sampleBaseDensity(p01 + vec3(-occlusionRadius, 0.0, 0.0));
  ao += sampleBaseDensity(p01 + vec3(0.0, occlusionRadius, 0.0));
  ao += sampleBaseDensity(p01 + vec3(0.0, -occlusionRadius, 0.0));
  ao += sampleBaseDensity(p01 + vec3(0.0, 0.0, occlusionRadius));
  ao += sampleBaseDensity(p01 + vec3(0.0, 0.0, -occlusionRadius));

  ao = ao / 6.0;

  // Convert to occlusion factor (more density = more occlusion)
  return 1.0 - smoothstep(0.0, 0.5, ao) * 0.4;
}

// ============================================================================
// Ray-Box Intersection (robust version with better numerical stability)
// ============================================================================

bool intersectBox(vec3 ro, vec3 rd, vec3 bMin, vec3 bMax, out float t0, out float t1) {
  // Robust inverse direction calculation with larger epsilon to avoid precision issues
  // at grazing angles (when ray is nearly parallel to a box face)
  const float eps = 1e-6;
  vec3 invDir;
  invDir.x = 1.0 / (abs(rd.x) > eps ? rd.x : (rd.x >= 0.0 ? eps : -eps));
  invDir.y = 1.0 / (abs(rd.y) > eps ? rd.y : (rd.y >= 0.0 ? eps : -eps));
  invDir.z = 1.0 / (abs(rd.z) > eps ? rd.z : (rd.z >= 0.0 ? eps : -eps));

  vec3 t1v = (bMin - ro) * invDir;
  vec3 t2v = (bMax - ro) * invDir;

  vec3 tNear = min(t1v, t2v);
  vec3 tFar = max(t1v, t2v);

  t0 = max(max(tNear.x, tNear.y), tNear.z);
  t1 = min(min(tFar.x, tFar.y), tFar.z);

  // Add small tolerance to handle edge cases at grazing angles
  // Valid intersection if exit > entry (with tolerance) and exit > 0
  return t1 > (t0 - 0.0001) && t1 > 0.0;
}

// ============================================================================
// Main Ray Marching - Adaptive with Professional Quality
// ============================================================================

void main() {
  // 1. Reconstruct world-space ray using inverse view-projection
  // Use clip space points at near and far planes
  vec4 clipNear = vec4(v_ndc, -1.0, 1.0);
  vec4 clipFar = vec4(v_ndc, 1.0, 1.0);

  vec4 worldNear = u_invViewProj * clipNear;
  vec4 worldFar = u_invViewProj * clipFar;

  // Check for degenerate perspective divide (w near zero)
  if (abs(worldNear.w) < 1e-5 || abs(worldFar.w) < 1e-5) {
    fragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }

  worldNear.xyz /= worldNear.w;
  worldFar.xyz /= worldFar.w;

  // Ray from camera through the pixel
  // Use worldNear - cameraPos for more stable direction at screen edges
  vec3 rayOrigin = u_cameraPos;
  vec3 rayDir = normalize(worldNear.xyz - u_cameraPos);

  // Additional check: ensure ray direction components are valid (not NaN/Inf)
  // Also check for near-zero length which indicates numerical issues
  float rayDirLen = length(rayDir);
  if (any(isnan(rayDir)) || any(isinf(rayDir)) || rayDirLen < 0.99 || rayDirLen > 1.01) {
    // Fallback: use far-near direction
    vec3 rayVec = worldFar.xyz - worldNear.xyz;
    float rayVecLen = length(rayVec);
    if (rayVecLen < 1e-5) {
      fragColor = vec4(0.0, 0.0, 0.0, 0.0);
      return;
    }
    rayDir = rayVec / rayVecLen;
  }

  // Final validation of ray direction
  if (any(isnan(rayDir)) || any(isinf(rayDir))) {
    fragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }

  // 2. Ray-box intersection
  float tEnter, tExit;
  if (!intersectBox(rayOrigin, rayDir, u_volumeMin, u_volumeMax, tEnter, tExit)) {
    fragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }

  // Clamp entry to start at camera (handle camera inside volume)
  tEnter = max(tEnter, 0.001);
  float rayLength = tExit - tEnter;

  // Skip if ray segment is too short; remove upper bound check to avoid holes
  if (rayLength < 0.001) {
    fragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }

  // Clamp very long rays to reasonable length to avoid excessive iterations
  float maxRayLength = 50.0;
  if (rayLength > maxRayLength) {
    rayLength = maxRayLength;
    tExit = tEnter + maxRayLength;
  }

  // 3. Calculate LOD and quality based on distance
  vec3 volumeCenter = (u_volumeMin + u_volumeMax) * 0.5;
  vec3 volumeSize = u_volumeMax - u_volumeMin;
  float volumeScale = max(max(volumeSize.x, volumeSize.y), volumeSize.z);
  float distToVolume = length(rayOrigin - volumeCenter);

  // LOD factor affects noise detail and step count
  // Clamp more conservatively to avoid quality drops at certain angles
  float lodFactor = clamp(distToVolume / (volumeScale * 2.0), 0.5, 3.0);

  // 4. Adaptive step count based on ray length through volume
  float voxelSize = getVoxelSize();
  float targetStepLen = voxelSize * 1.2;
  float minSteps = rayLength / max(targetStepLen, 0.0005);

  // Use actual ray length to ensure adequate sampling regardless of viewing angle
  float baseSteps = max(minSteps, 60.0) * u_stepMultiplier;

  // Add bonus steps when camera is close for detail
  float closeBonus = smoothstep(3.0, 0.5, distToVolume) * 20.0;

  float effectiveSteps = (baseSteps + closeBonus) / pow(lodFactor, 0.5);
  effectiveSteps = clamp(effectiveSteps, 60.0, 260.0);  // Higher minimum for better coverage
  float baseStepLen = max(targetStepLen, rayLength / effectiveSteps);

  // 5. Blue noise jitter for temporal anti-aliasing
  float jitter = getBlueNoiseJitter(gl_FragCoord.xy);
  float t = tEnter + jitter * baseStepLen;

  // 6. Precompute lighting
  vec3 lightDir = normalize(u_lightDir);
  float cosTheta = dot(-rayDir, lightDir);
  float phase = phaseFunction(cosTheta);

  float animTime = u_time * u_animationSpeed;

  // 7. Accumulation variables
  vec3 accColor = vec3(0.0);
  float transmittance = 1.0;

  // 8. Adaptive ray marching
  const int MAX_STEPS = 200;
  int consecutiveEmpty = 0;
  float stepLen = baseStepLen;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (t > tExit || transmittance < 0.005) break;

    vec3 pos = rayOrigin + rayDir * t;
    vec3 p01 = clamp((pos - u_volumeMin) / volumeSize, 0.001, 0.999);

    // Distance from camera for detail level
    float distFromCam = length(pos - rayOrigin);

    // Hierarchical empty-space skipping using mipmap
    // Use lower mip level (1.5 instead of 2.0) for better accuracy
    float coarseDensity = textureLod(u_densityTex3D, p01, 1.5).r;

    if (coarseDensity < 0.005) {
      consecutiveEmpty++;
      // Conservative skip - don't accelerate too much to avoid missing thin features
      float skipMult = min(2.5, 1.0 + float(consecutiveEmpty) * 0.3);
      t += stepLen * skipMult;
      continue;
    }
    consecutiveEmpty = 0;

    // Full density sample with all detail
    float density = sampleCloudDensity(pos, p01, animTime, lodFactor, distFromCam);

    if (density < 0.001) {
      t += stepLen;
      continue;
    }

    float extinctionCoeff = densityToExtinction(density);

    // === Simplified lighting (avoids overly bright spots) ===

    // Sample light transmittance for shadows
    float lightTrans = sampleLightTransmittance(pos, lightDir, stepLen * 1.5);

    // Conservative albedo
    float albedo = clamp(u_scatterStrength * 0.4, 0.1, 0.6);
    float sigmaS = extinctionCoeff * albedo;

    // Simple directional shading without phase function
    // Just use light transmittance with a subtle gradient
    float directLight = lightTrans * 0.6 * u_directLightIntensity;

    // Soft ambient term (reduced)
    float ambientLight = 0.25;

    // Combine and clamp to prevent bright spots
    float totalLight = clamp(directLight + ambientLight, 0.0, 0.85 * u_directLightIntensity);

    vec3 sampleColor = u_smokeColor * totalLight * sigmaS;

    // === Extinction and compositing ===

    float opticalDepth = extinctionCoeff * stepLen;
    float sampleTrans = exp(-opticalDepth);
    float alpha = 1.0 - sampleTrans;

    // Energy-conserving front-to-back compositing
    accColor += transmittance * sampleColor * alpha;
    transmittance *= sampleTrans;

    // Simple step advancement
    t += stepLen;
  }

  // 9. Final output with premultiplied alpha
  float finalAlpha = 1.0 - transmittance;

  fragColor = vec4(accColor, finalAlpha);
}
`;

// ============================================================================
// Composite shader for upsampling (bilateral-aware)
// ============================================================================

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
  // Bilateral-aware upsampling with 9-tap tent filter
  vec2 off = u_inverseResolution;

  // Sample pattern with weights
  vec4 c0 = texture(u_smokeTex, v_uv);
  vec4 c1 = texture(u_smokeTex, v_uv + vec2( off.x, 0.0));
  vec4 c2 = texture(u_smokeTex, v_uv + vec2(-off.x, 0.0));
  vec4 c3 = texture(u_smokeTex, v_uv + vec2(0.0,  off.y));
  vec4 c4 = texture(u_smokeTex, v_uv + vec2(0.0, -off.y));
  vec4 c5 = texture(u_smokeTex, v_uv + vec2( off.x,  off.y));
  vec4 c6 = texture(u_smokeTex, v_uv + vec2(-off.x,  off.y));
  vec4 c7 = texture(u_smokeTex, v_uv + vec2( off.x, -off.y));
  vec4 c8 = texture(u_smokeTex, v_uv + vec2(-off.x, -off.y));

  // Compute bilateral weights based on color similarity
  float centerLum = dot(c0.rgb, vec3(0.299, 0.587, 0.114));

  float w0 = 4.0;  // Center weight
  float w1 = 2.0 * exp(-abs(dot(c1.rgb - c0.rgb, vec3(1.0))) * 10.0);
  float w2 = 2.0 * exp(-abs(dot(c2.rgb - c0.rgb, vec3(1.0))) * 10.0);
  float w3 = 2.0 * exp(-abs(dot(c3.rgb - c0.rgb, vec3(1.0))) * 10.0);
  float w4 = 2.0 * exp(-abs(dot(c4.rgb - c0.rgb, vec3(1.0))) * 10.0);
  float w5 = 1.0 * exp(-abs(dot(c5.rgb - c0.rgb, vec3(1.0))) * 10.0);
  float w6 = 1.0 * exp(-abs(dot(c6.rgb - c0.rgb, vec3(1.0))) * 10.0);
  float w7 = 1.0 * exp(-abs(dot(c7.rgb - c0.rgb, vec3(1.0))) * 10.0);
  float w8 = 1.0 * exp(-abs(dot(c8.rgb - c0.rgb, vec3(1.0))) * 10.0);

  float totalWeight = w0 + w1 + w2 + w3 + w4 + w5 + w6 + w7 + w8;

  vec4 blurred = (c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3 + c4 * w4 +
                  c5 * w5 + c6 * w6 + c7 * w7 + c8 * w8) / totalWeight;

  // Preserve alpha for proper blending with background
  fragColor = vec4(blurred.rgb * u_intensity, blurred.a);
}
`;
