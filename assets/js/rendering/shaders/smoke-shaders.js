// Volumetric Cloud Shaders (WebGL2 / GLSL ES 3.0)
// ================================================
// A single-scattering ray march through the cells' density volume:
// - the volume carries density and the active field's display colour
//   (smoke-density.js), so the cloud is coloured like the points it replaces;
// - shadowing and sky occlusion are pre-integrated once per density build
//   into a coarse lighting volume (LIGHT_VOLUME_FS) and read with one fetch;
// - a Henyey-Greenstein phase lobe and a multiple-scattering approximation
//   keep thick regions lit rather than black;
// - procedural Perlin-Worley noise and curl warping add structure and motion;
// - empty space is skipped block by block through the occupancy volume, rays
//   stop once the cloud is opaque, and the step length follows the grid so
//   `Ray quality` means samples per voxel.

import { OCCUPANCY_BLOCK } from './density-shaders.js';

// Largest sample count one ray may take. With empty-space skipping the bound
// is reached only by rays that cross the whole occupied volume at Ultra.
export const MAX_SMOKE_MARCH_STEPS = 512;

export const SMOKE_VS_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_position;
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

// Density volume: r = density, gba = display colour premultiplied by density.
uniform sampler3D u_densityTex3D;
uniform float u_gridSize;
// Lighting volume: r = optical depth to the key light, g = sky occlusion.
uniform sampler3D u_lightTex3D;
// Occupancy: per 4x4x4 block of voxels, the largest density a sample inside
// it can read. Zero proves the block empty.
uniform sampler3D u_occupancyTex3D;

// Pre-computed noise textures (Perlin-Worley)
uniform sampler3D u_shapeNoise;    // R: Perlin-Worley, G: Worley med, B: Worley high, A: Worley erosion
uniform sampler3D u_detailNoise;   // R: detail Worley, G: fine Worley, BA: curl noise
uniform sampler2D u_blueNoise;     // RG: blue noise for ray-start jitter

// Camera and volume
uniform mat4 u_invViewProj;
uniform vec3 u_cameraPos;
uniform vec3 u_volumeMin;
uniform vec3 u_volumeMax;
uniform vec3 u_lightDir;

// Animation and quality parameters
// Procedural time in seconds, already scaled by the animation speed.
uniform float u_time;
uniform float u_densityMultiplier;
uniform float u_stepMultiplier;   // samples per voxel along the ray
uniform float u_noiseScale;
uniform float u_warpStrength;
uniform float u_detailLevel;
uniform float u_lightAbsorption;
uniform float u_scatterStrength;
uniform float u_edgeSoftness;
uniform float u_directLightIntensity;

out vec4 fragColor;

#define PI 3.14159265359
const int MAX_STEPS = ${MAX_SMOKE_MARCH_STEPS};

// Shadow and sky optical depths are stored in density x world units and are
// turned into extinction with the same per-density coefficient the view ray
// uses, so a denser cloud also casts deeper shadows. These are the fractions
// of it light sees at Light absorption 1: light is scattered forward through
// a cloud, so it is attenuated less than the view ray.
const float KEY_SHADOW_SCALE = 0.5;
const float SKY_SHADOW_SCALE = 0.6;
const float AMBIENT_LIGHT = 0.4;
const float DIRECT_LIGHT = 0.85;
// Exposure of the soft tone curve that maps radiance into [0, 1).
const float EXPOSURE = 1.6;

// World-space voxel size (keeps extinction consistent when the grid changes)
float getVoxelSize() {
  vec3 size = u_volumeMax - u_volumeMin;
  float maxExtent = max(max(size.x, size.y), size.z);
  return max(maxExtent / max(u_gridSize, 1.0), 0.001);
}

// Map a normalized volume position to the density texture coordinate that
// addresses the voxel the splat actually wrote there.
//
// The splat maps a point p in [-1,1] to index space (p + 1) / 2 * (gridSize-1),
// so voxel i carries the density of normalized position i / (gridSize - 1). A
// 3D texture's texel i is centred at (i + 0.5) / gridSize instead. Feeding the
// normalized position straight to the sampler therefore read the volume through
// the wrong affine map: every feature was reconstructed at (gridSize-1)/gridSize
// of its true size -- 0.79% small at 128 -- and displaced towards the volume
// centre by up to half a texel. This is the exact inverse of the splat's map,
// so the smoke now sits on the cells it represents.
//
// The map is affine, scale (grid - 1) / grid and offset 0.5 / grid; main()
// derives both once per pixel into these globals instead of every sample
// dividing by the grid again.
vec2 g_densityTexMap;

vec3 densityTexCoord(vec3 p01) {
  return clamp(p01, 0.0, 1.0) * g_densityTexMap.x + g_densityTexMap.y;
}

// Density and premultiplied colour at one volume position.
//
// textureLod, not texture: every caller runs inside the march loop, which
// contains break and continue, and GLSL ES 3.00 leaves screen-space derivatives
// -- and therefore the implicit mip level -- undefined in non-uniform control
// flow. The volume is LINEAR_MIPMAP_LINEAR because the lighting pass reads its
// level 1 (LIGHT_VOLUME_FS), so an undefined level answered with a coarser mip whose
// support is wider than the data's: density was reported outside the true
// support and inflated the silhouette. Level 0 is the data.
vec4 sampleVolume(vec3 p01) {
  return textureLod(u_densityTex3D, densityTexCoord(p01), 0.0);
}

// Sample shape noise with animation.
// Explicit level for the same reason as sampleVolume: this runs inside the
// march loop, the noise volume is LINEAR_MIPMAP_LINEAR, and an implicit level
// is undefined there.
vec4 sampleShapeNoise(vec3 worldPos, float time, float lod) {
  vec3 uvw = worldPos * u_noiseScale * 0.25;
  uvw += vec3(time * 0.012, time * 0.004, time * 0.008);
  return textureLod(u_shapeNoise, uvw, lod);
}

// Sample detail noise for close-up structure
vec4 sampleDetailNoise(vec3 worldPos, float time, float lod) {
  vec3 uvw = worldPos * u_noiseScale * 0.6 * u_detailLevel;
  uvw += vec3(time * 0.025, -time * 0.018, time * 0.022);
  return textureLod(u_detailNoise, uvw, lod);
}

// Curl-noise offset for turbulent motion, in normalized [0,1] volume space.
// One octave: the displacement is at most a few voxels, so a second, finer
// octave changed nothing visible and cost a texture fetch per sample.
vec3 getCurlOffset(vec3 p01, float time, float lod) {
  vec3 uvw = p01 * 2.6 + vec3(time * 0.08, time * 0.05, time * 0.06);
  vec3 curlVec = (textureLod(u_detailNoise, uvw, lod).rgb - 0.5) * 2.0;
  return curlVec * u_warpStrength;
}

// Per-pixel ray-start offset from a fixed blue-noise tile. It is stable from
// frame to frame on purpose: there is no temporal accumulation to average a
// moving offset, so a moving one only shimmered, and a still camera must give
// the same image twice (which is also what lets the viewer stop drawing).
float getBlueNoiseJitter(vec2 screenCoord) {
  vec2 noise = textureLod(u_blueNoise, screenCoord / 128.0, 0.0).rg;
  return fract(noise.r + noise.g * 0.5);
}

// Shaped density in [0,1] and the field colour, at one march position.
// Returns density 0 for empty space.
vec4 sampleCloud(vec3 worldPos, vec3 p01, float time, float lod, float distanceToCamera) {
  vec4 base = sampleVolume(p01);
  if (base.r < 0.002) return vec4(0.0);

  // Curl warping: the warp IS the new sample position.
  if (u_warpStrength > 0.01) {
    vec3 warpedP01 = clamp(p01 + getCurlOffset(p01, time, lod) * 0.25 * u_warpStrength, 0.0, 1.0);
    base = sampleVolume(warpedP01);
    if (base.r < 0.002) return vec4(0.0);
  }
  vec3 color = base.gba / base.r;

  vec4 shapeNoise = sampleShapeNoise(worldPos, time, lod);
  float shapeFBM = shapeNoise.r * 0.5 + shapeNoise.g * 0.3 + shapeNoise.b * 0.2;
  // Gentle modulation that never removes more than 30% of the data's density.
  float density = base.r * (0.7 + shapeFBM * 0.3);

  // Edge erosion: wisps where the density thins out.
  if (u_edgeSoftness > 0.0) {
    float edgeFactor = smoothstep(0.0, 0.15, base.r) * smoothstep(0.5, 0.2, base.r);
    density = max(0.0, density - (1.0 - shapeNoise.a) * edgeFactor * u_edgeSoftness * 0.1);
  }

  // Detail pass, stronger when close.
  float detailBlend = (0.3 + smoothstep(15.0, 1.0, distanceToCamera) * 0.7) * u_detailLevel;
  if (detailBlend > 0.01) {
    vec4 detailNoise = sampleDetailNoise(worldPos, time, lod);
    float detailFBM = detailNoise.r * 0.5 + detailNoise.g * 0.3 + detailNoise.b * 0.2;
    density = clamp(density + (detailFBM - 0.5) * detailBlend * 0.4 * density, 0.0, 1.0);
  }
  return vec4(clamp(color, 0.0, 1.0), density);
}

float henyeyGreenstein(float cosTheta, float g) {
  float g2 = g * g;
  float denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (1.0 - g2) / (4.0 * PI * pow(max(denom, 0.0001), 1.5));
}

bool intersectBox(vec3 ro, vec3 rd, vec3 bMin, vec3 bMax, out float t0, out float t1) {
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
  return t1 > (t0 - 0.0001) && t1 > 0.0;
}

void main() {
  {
    float grid = max(u_gridSize, 1.0);
    g_densityTexMap = vec2((grid - 1.0) / grid, 0.5 / grid);
  }

  // 1. Reconstruct the world-space ray.
  vec4 worldNear = u_invViewProj * vec4(v_ndc, -1.0, 1.0);
  if (abs(worldNear.w) < 1e-5) {
    fragColor = vec4(0.0);
    return;
  }
  worldNear.xyz /= worldNear.w;
  vec3 rayOrigin = u_cameraPos;
  vec3 rayVec = worldNear.xyz - u_cameraPos;
  float rayDirLen = length(rayVec);
  if (
    any(isnan(rayVec)) ||
    any(isinf(rayVec)) ||
    isnan(rayDirLen) ||
    isinf(rayDirLen) ||
    rayDirLen < 1e-5
  ) {
    fragColor = vec4(0.0);
    return;
  }
  vec3 rayDir = rayVec / rayDirLen;

  // 2. Clip to the volume; a camera inside it starts at the eye.
  float tEnter, tExit;
  if (!intersectBox(rayOrigin, rayDir, u_volumeMin, u_volumeMax, tEnter, tExit)) {
    fragColor = vec4(0.0);
    return;
  }
  tEnter = max(tEnter, 0.0);
  if (tExit - tEnter < 0.0001) {
    fragColor = vec4(0.0);
    return;
  }

  vec3 volumeCenter = (u_volumeMin + u_volumeMax) * 0.5;
  vec3 volumeSize = u_volumeMax - u_volumeMin;
  float volumeScale = max(max(volumeSize.x, volumeSize.y), volumeSize.z);
  float lodFactor = clamp(length(rayOrigin - volumeCenter) / (volumeScale * 2.0), 0.5, 3.0);

  // 3. Step length: Ray quality samples per voxel, never more steps than the
  //    loop can take.
  float voxelSize = getVoxelSize();
  float rayLength = tExit - tEnter;
  float stepLen = max(
    voxelSize / max(u_stepMultiplier, 0.25),
    rayLength / float(MAX_STEPS)
  );
  // Extinction per unit density and world length. Opacity per step is
  // density * u_densityMultiplier / samples-per-voxel: independent of the grid.
  float sigmaScale = u_densityMultiplier / voxelSize;

  float jitter = getBlueNoiseJitter(gl_FragCoord.xy);
  float t = tEnter + jitter * stepLen;
  const float OCCUPANCY_BLOCK = ${OCCUPANCY_BLOCK}.0;

  // 4. Lighting that is constant along the ray.
  vec3 lightDir = normalize(u_lightDir);
  float cosTheta = dot(rayDir, lightDir);
  float g = clamp(0.3 * u_scatterStrength, 0.0, 0.85);
  // Forward lobe (silver lining when looking towards the light) blended with
  // a back lobe, normalized so an isotropic medium has phase 1.
  float phase = 4.0 * PI * mix(
    henyeyGreenstein(cosTheta, -0.25),
    henyeyGreenstein(cosTheta, g),
    0.7
  );
  float animTime = u_time;

  vec3 accColor = vec3(0.0);
  float transmittance = 1.0;
  // Splat index space: index = p01 * (grid - 1); one occupancy block spans
  // OCCUPANCY_BLOCK indices. The world size of one block along each axis:
  float grid = max(u_gridSize, 1.0);
  vec3 indexToWorld = volumeSize / (grid - 1.0);
  vec3 invVolumeSize = 1.0 / volumeSize;
  ivec3 occupancyMax = textureSize(u_occupancyTex3D, 0) - 1;
  for (int i = 0; i < MAX_STEPS; i++) {
    if (t > tExit || transmittance < 0.01) break;

    vec3 pos = rayOrigin + rayDir * t;
    vec3 p01 = (pos - u_volumeMin) * invVolumeSize;

    // Empty-space skipping: leap over a whole empty block to its far face,
    // then resume on this pixel's jittered sample phase.
    vec3 index = clamp(p01, 0.0, 1.0) * (grid - 1.0);
    vec3 block = floor(index / OCCUPANCY_BLOCK);
    if (texelFetch(u_occupancyTex3D, min(ivec3(block), occupancyMax), 0).r == 0.0) {
      vec3 farIndex = (block + step(0.0, rayDir)) * OCCUPANCY_BLOCK;
      vec3 farWorld = u_volumeMin + farIndex * indexToWorld;
      vec3 axisT = (farWorld - rayOrigin) / mix(vec3(1e-6), rayDir, greaterThan(abs(rayDir), vec3(1e-6)));
      axisT = mix(vec3(1e9), axisT, greaterThan(abs(rayDir), vec3(1e-6)));
      float blockExit = min(min(axisT.x, axisT.y), axisT.z);
      t = max(t + stepLen * 0.25, blockExit + jitter * stepLen);
      continue;
    }

    vec4 cloud = sampleCloud(pos, p01, animTime, lodFactor, t);
    float density = cloud.a;
    if (density <= 0.0) {
      t += stepLen;
      continue;
    }

    // Pre-integrated shadow towards the key light and sky occlusion.
    vec2 depths = textureLod(u_lightTex3D, p01, 0.0).rg
      * (sigmaScale * u_lightAbsorption);
    float keyDepth = depths.r * KEY_SHADOW_SCALE;
    // Multiple scattering (Wrenninge et al.): successive octaves see a thinner
    // medium, so dense regions are dimmed rather than blacked out.
    // exp(-d/16) raised to the 4th and 16th powers gives the other two octaves
    // with four multiplications instead of two more exponentials.
    float octave3 = exp(-keyDepth * 0.0625);
    float octave2 = octave3 * octave3;
    octave2 *= octave2;
    float octave1 = octave2 * octave2;
    octave1 *= octave1;
    float keyLight = (octave1 + 0.5 * octave2 + 0.25 * octave3) * (1.0 / 1.75);
    float skyLight = exp(-depths.g * SKY_SHADOW_SCALE);
    // Powder term: the sunlit rim of a dense region scatters less towards the
    // viewer than its depth, which is what reads as volume.
    float powder = 1.0 - exp(-density * 6.0);
    // Light bounced in from the rest of the cloud keeps occluded regions
    // from going black: the sky term dims to a floor, never to zero.
    float radiance = AMBIENT_LIGHT * (0.5 + 0.5 * skyLight)
      + DIRECT_LIGHT * u_directLightIntensity * keyLight * phase * mix(1.0, powder, 0.5);
    // A soft shoulder instead of a clamp: lit faces keep their gradient
    // rather than flattening at 1, and rgb still never exceeds alpha.
    vec3 sampleColor = cloud.rgb * (1.0 - exp(-EXPOSURE * radiance));

    // Adaptive step: behind already-dense smoke a sample can change the
    // pixel by at most the remaining transmittance, so the march lengthens
    // its stride as the ray fills (up to 2.5x). Opacity uses the stride the
    // sample stands for, so the integral is unchanged.
    float stride = stepLen * (1.0 + 1.5 * (1.0 - transmittance));
    float alpha = 1.0 - exp(-density * sigmaScale * stride);
    accColor += transmittance * alpha * sampleColor;
    transmittance *= 1.0 - alpha;
    t += stride;
  }

  // Premultiplied output: rgb never exceeds alpha because the tone curve < 1.
  fragColor = vec4(accColor, 1.0 - transmittance);
}
`;

// ============================================================================
// Composite shader for upsampling (alpha-bilateral)
// ============================================================================
//
// The offscreen smoke target holds no geometry, so there is nothing for a
// depth-aware upsample to key on: the ray march runs with the depth test off,
// never reads scene depth, and writes no depth of its own -- a volumetric
// integral along a whole ray has no single depth to compare. Binding a scene
// depth texture here would gate on a discontinuity that cannot appear in this
// buffer. The one discontinuity that can appear is the smoke's own silhouette,
// and on premultiplied output that lives entirely in alpha.

export const SMOKE_COMPOSITE_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_position;
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
  // Alpha-bilateral upsampling with a 9-tap tent filter
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

  // Range weights keyed on alpha, because alpha is where the silhouette is.
  //
  // The offscreen target is premultiplied: rgb = alpha * smokeColor *
  // totalLight * albedo, so rgb carries no edge that alpha does not, and its
  // magnitude is set by the lighting sliders rather than by the geometry. With
  // the shipped defaults that factor is about 0.005, which collapsed an rgb
  // gate to a constant: empty space and faint smoke both sat at rgb ~ 0, so the
  // weight stayed near 1 exactly across the silhouette the filter exists to
  // protect, and the tent blurred straight through it. Raising the light or the
  // scattering pushed the same factor towards 1 and the gate suddenly slammed
  // shut, so the width of the smoke's edge tracked the light instead of the
  // data. Summing signed channel differences before taking the absolute value
  // let opposite-signed differences cancel on top of that.
  //
  // ALPHA_TOLERANCE is the alpha difference a tap may show before it is treated
  // as belonging to a different part of the volume. The dither this filter
  // exists to smooth moves alpha by one or two 8-bit steps (0.4%-0.8% of the
  // range); a silhouette moves it by far more. One percent separates them.
  const float ALPHA_TOLERANCE = 0.01;
  float gate = 1.0 / ALPHA_TOLERANCE;

  float w0 = 4.0;  // Center weight
  float w1 = 2.0 * exp(-abs(c1.a - c0.a) * gate);
  float w2 = 2.0 * exp(-abs(c2.a - c0.a) * gate);
  float w3 = 2.0 * exp(-abs(c3.a - c0.a) * gate);
  float w4 = 2.0 * exp(-abs(c4.a - c0.a) * gate);
  float w5 = 1.0 * exp(-abs(c5.a - c0.a) * gate);
  float w6 = 1.0 * exp(-abs(c6.a - c0.a) * gate);
  float w7 = 1.0 * exp(-abs(c7.a - c0.a) * gate);
  float w8 = 1.0 * exp(-abs(c8.a - c0.a) * gate);

  float totalWeight = w0 + w1 + w2 + w3 + w4 + w5 + w6 + w7 + w8;

  vec4 blurred = (c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3 + c4 * w4 +
                  c5 * w5 + c6 * w6 + c7 * w7 + c8 * w8) / totalWeight;

  // Preserve alpha for proper blending with background
  fragColor = vec4(blurred.rgb * u_intensity, blurred.a);
}
`;
