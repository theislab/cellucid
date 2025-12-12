// noise-shaders.js - GPU-based 3D Noise Texture Generator Shaders
// Professional-quality noise generation for volumetric clouds
// Based on techniques from:
// - Horizon Zero Dawn (Guerrilla Games)
// - Frostbite Engine (EA DICE)
// - GPU Gems 3

// Vertex shader for fullscreen quad
export const NOISE_VS = `#version 300 es
precision highp float;
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Fragment shader for Shape Noise (128³ RGBA)
// R: Perlin-Worley blend (billowy clouds), G: Medium Worley, B: High Worley, A: Erosion Worley
export const SHAPE_NOISE_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform float u_slice;      // Current Z slice [0, 1]
uniform float u_size;       // Texture size (128)

out vec4 fragColor;

// ============================================================================
// High-quality hash functions (better distribution than sin-based)
// ============================================================================

// PCG-based hash for better randomness
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
  v ^= v >> 16u;
  v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
  return v;
}

vec3 hash3(vec3 p) {
  uvec3 u = uvec3(ivec3(p * 1000.0) + ivec3(10000));
  uvec3 h = pcg3d(u);
  return vec3(h) / float(0xffffffffu);
}

// Gradient vectors for Perlin noise (better quality than random)
vec3 grad3(vec3 p) {
  vec3 h = hash3(p);
  // Map to unit sphere for better gradient distribution
  float theta = h.x * 6.28318530718;
  float phi = acos(h.y * 2.0 - 1.0);
  return vec3(
    sin(phi) * cos(theta),
    sin(phi) * sin(theta),
    cos(phi)
  );
}

// ============================================================================
// Ken Perlin's Improved Noise (2002)
// ============================================================================

// Quintic interpolation (smoother than cubic)
vec3 fade(vec3 t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

float gradientNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = fade(f);

  // Use gradient vectors instead of random vectors
  float n000 = dot(grad3(i + vec3(0,0,0)), f - vec3(0,0,0));
  float n100 = dot(grad3(i + vec3(1,0,0)), f - vec3(1,0,0));
  float n010 = dot(grad3(i + vec3(0,1,0)), f - vec3(0,1,0));
  float n110 = dot(grad3(i + vec3(1,1,0)), f - vec3(1,1,0));
  float n001 = dot(grad3(i + vec3(0,0,1)), f - vec3(0,0,1));
  float n101 = dot(grad3(i + vec3(1,0,1)), f - vec3(1,0,1));
  float n011 = dot(grad3(i + vec3(0,1,1)), f - vec3(0,1,1));
  float n111 = dot(grad3(i + vec3(1,1,1)), f - vec3(1,1,1));

  // Trilinear interpolation
  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  float nxy0 = mix(nx00, nx10, u.y);
  float nxy1 = mix(nx01, nx11, u.y);

  return mix(nxy0, nxy1, u.z);
}

// FBM (Fractal Brownian Motion) with lacunarity and gain control
float perlinFBM(vec3 p, int octaves, float lacunarity, float gain) {
  float value = 0.0;
  float amplitude = 0.5;
  float frequency = 1.0;
  float maxValue = 0.0;

  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    value += amplitude * gradientNoise(p * frequency);
    maxValue += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }

  return (value / maxValue + 1.0) * 0.5;
}

// ============================================================================
// Enhanced Worley Noise (Cellular) with F1/F2 distances
// ============================================================================

vec2 worleyNoise2(vec3 p, float freq, float seed) {
  p *= freq;
  vec3 cellId = floor(p);
  vec3 cellPos = fract(p);

  float minDist1 = 10000.0;  // F1: closest
  float minDist2 = 10000.0;  // F2: second closest

  // Check 3x3x3 neighborhood
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      for (int z = -1; z <= 1; z++) {
        vec3 neighbor = vec3(float(x), float(y), float(z));
        vec3 cellOffset = cellId + neighbor;

        // Wrap for seamless tiling
        vec3 wrappedCell = mod(cellOffset + freq, freq);

        // Random point in cell using better hash
        vec3 randomPoint = hash3(wrappedCell + seed * 17.0);
        vec3 pointPos = neighbor + randomPoint - cellPos;

        float dist = length(pointPos);

        // Track F1 and F2 distances
        if (dist < minDist1) {
          minDist2 = minDist1;
          minDist1 = dist;
        } else if (dist < minDist2) {
          minDist2 = dist;
        }
      }
    }
  }

  return vec2(minDist1, minDist2);
}

float worleyNoise(vec3 p, float freq, float seed) {
  return worleyNoise2(p, freq, seed).x;
}

// Worley FBM - multiple octaves for more natural look
float worleyFBM(vec3 p, float baseFreq, float seed) {
  float w1 = 1.0 - worleyNoise(p, baseFreq, seed);
  float w2 = 1.0 - worleyNoise(p, baseFreq * 2.0, seed + 1.0);
  float w3 = 1.0 - worleyNoise(p, baseFreq * 4.0, seed + 2.0);

  // FBM weights (standard 1/f distribution)
  return w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
}

// ============================================================================
// Main - Generate High-Quality Shape Noise
// ============================================================================

void main() {
  vec3 uvw = vec3(v_uv, u_slice);

  // Scale for noise sampling
  float scale = 4.0;
  vec3 scaledPos = uvw * scale;

  // === R Channel: Perlin-Worley Blend (Billowy Cloud Shapes) ===
  // This is the key technique from Horizon Zero Dawn
  float perlin = perlinFBM(scaledPos, 5, 2.0, 0.5);

  // Multi-octave Worley for cloud billows
  float worleyFbm = worleyFBM(uvw, 4.0, 0.0);

  // The magic blend: Perlin provides smooth base, Worley adds billowy structure
  // Perlin "remaps" the Worley to create defined edges
  float perlinWorley = perlin;
  perlinWorley = perlinWorley - (1.0 - worleyFbm) * 0.35;
  perlinWorley = max(0.0, perlinWorley);
  // Remap to use full range
  perlinWorley = perlinWorley / 0.65;
  perlinWorley = clamp(perlinWorley, 0.0, 1.0);

  // === G Channel: Medium Frequency Worley ===
  // Used for medium-scale shape modulation
  float worleyMed = 1.0 - worleyNoise(uvw, 8.0, 3.0);

  // Add slight Perlin modulation for more organic look
  float perlinMod = perlinFBM(scaledPos * 2.0, 3, 2.0, 0.5);
  worleyMed = mix(worleyMed, worleyMed * perlinMod, 0.3);

  // === B Channel: High Frequency Worley ===
  // Used for fine detail and edge definition
  float worleyHigh = 1.0 - worleyNoise(uvw, 16.0, 4.0);

  // === A Channel: Very High Frequency Worley (Erosion) ===
  // Used for wispy edge erosion
  float worleyVeryHigh = 1.0 - worleyNoise(uvw, 32.0, 5.0);

  // Mix in some mid-frequency for better erosion pattern
  float worleyErosion = 1.0 - worleyNoise(uvw, 24.0, 6.0);
  worleyVeryHigh = mix(worleyVeryHigh, worleyErosion, 0.3);

  fragColor = vec4(perlinWorley, worleyMed, worleyHigh, worleyVeryHigh);
}
`;

// Fragment shader for Detail Noise (128³ RGBA)
// R: Detail Worley FBM, G: Fine Worley, B: Curl X, A: Curl Y
// Enhanced for better close-up detail
export const DETAIL_NOISE_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform float u_slice;
uniform float u_size;

out vec4 fragColor;

// PCG-based hash for better randomness (same as shape noise)
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
  v ^= v >> 16u;
  v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
  return v;
}

vec3 hash3(vec3 p) {
  uvec3 u = uvec3(ivec3(p * 1000.0) + ivec3(10000));
  uvec3 h = pcg3d(u);
  return vec3(h) / float(0xffffffffu);
}

vec3 grad3(vec3 p) {
  vec3 h = hash3(p);
  float theta = h.x * 6.28318530718;
  float phi = acos(h.y * 2.0 - 1.0);
  return vec3(
    sin(phi) * cos(theta),
    sin(phi) * sin(theta),
    cos(phi)
  );
}

vec3 fade(vec3 t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

float gradientNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = fade(f);

  float n000 = dot(grad3(i + vec3(0,0,0)), f - vec3(0,0,0));
  float n100 = dot(grad3(i + vec3(1,0,0)), f - vec3(1,0,0));
  float n010 = dot(grad3(i + vec3(0,1,0)), f - vec3(0,1,0));
  float n110 = dot(grad3(i + vec3(1,1,0)), f - vec3(1,1,0));
  float n001 = dot(grad3(i + vec3(0,0,1)), f - vec3(0,0,1));
  float n101 = dot(grad3(i + vec3(1,0,1)), f - vec3(1,0,1));
  float n011 = dot(grad3(i + vec3(0,1,1)), f - vec3(0,1,1));
  float n111 = dot(grad3(i + vec3(1,1,1)), f - vec3(1,1,1));

  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  float nxy0 = mix(nx00, nx10, u.y);
  float nxy1 = mix(nx01, nx11, u.y);

  return mix(nxy0, nxy1, u.z);
}

float worleyNoise(vec3 p, float freq, float seed) {
  p *= freq;
  vec3 cellId = floor(p);
  vec3 cellPos = fract(p);
  float minDist = 10000.0;

  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      for (int z = -1; z <= 1; z++) {
        vec3 neighbor = vec3(float(x), float(y), float(z));
        vec3 cellOffset = cellId + neighbor;
        vec3 wrappedCell = mod(cellOffset + freq, freq);
        vec3 randomPoint = hash3(wrappedCell + seed * 17.0);
        vec3 pointPos = neighbor + randomPoint - cellPos;
        minDist = min(minDist, length(pointPos));
      }
    }
  }

  return clamp(minDist, 0.0, 1.0);
}

// Multi-octave Worley for richer detail
float worleyFBM(vec3 p, float baseFreq, float seed) {
  float w1 = 1.0 - worleyNoise(p, baseFreq, seed);
  float w2 = 1.0 - worleyNoise(p, baseFreq * 2.0, seed + 1.0);
  float w3 = 1.0 - worleyNoise(p, baseFreq * 4.0, seed + 2.0);
  float w4 = 1.0 - worleyNoise(p, baseFreq * 8.0, seed + 3.0);

  return w1 * 0.5 + w2 * 0.25 + w3 * 0.15 + w4 * 0.1;
}

// High-quality curl noise via analytical derivatives
// This creates divergence-free turbulent flow
vec3 curlNoise(vec3 p) {
  float eps = 0.0005;  // Smaller epsilon for more accurate derivatives

  // Sample gradient noise at 6 offset positions
  float n1 = gradientNoise(p + vec3(0, eps, 0));
  float n2 = gradientNoise(p - vec3(0, eps, 0));
  float n3 = gradientNoise(p + vec3(0, 0, eps));
  float n4 = gradientNoise(p - vec3(0, 0, eps));
  float n5 = gradientNoise(p + vec3(eps, 0, 0));
  float n6 = gradientNoise(p - vec3(eps, 0, 0));

  // Second noise field with different offset for 3D curl
  vec3 offset = vec3(31.416, 17.23, -47.853);
  float m1 = gradientNoise(p + offset + vec3(0, eps, 0));
  float m2 = gradientNoise(p + offset - vec3(0, eps, 0));
  float m3 = gradientNoise(p + offset + vec3(0, 0, eps));
  float m4 = gradientNoise(p + offset - vec3(0, 0, eps));
  float m5 = gradientNoise(p + offset + vec3(eps, 0, 0));
  float m6 = gradientNoise(p + offset - vec3(eps, 0, 0));

  float eps2 = 2.0 * eps;

  // Compute curl components from cross product of gradients
  vec3 curl = vec3(
    ((n1 - n2) / eps2 - (m3 - m4) / eps2),
    ((n3 - n4) / eps2 - (n5 - n6) / eps2),
    ((m5 - m6) / eps2 - (m1 - m2) / eps2)
  );

  // Normalize and remap to [0, 1]
  return curl * 0.5 + 0.5;
}

// Simplified curl for second field
vec3 curlNoiseSimple(vec3 p) {
  float eps = 0.001;

  float n1 = gradientNoise(p + vec3(0, eps, 0));
  float n2 = gradientNoise(p - vec3(0, eps, 0));
  float n3 = gradientNoise(p + vec3(0, 0, eps));
  float n4 = gradientNoise(p - vec3(0, 0, eps));
  float n5 = gradientNoise(p + vec3(eps, 0, 0));
  float n6 = gradientNoise(p - vec3(eps, 0, 0));

  vec3 offset = vec3(31.416, 0.0, -47.853);
  float m1 = gradientNoise(p + offset + vec3(0, eps, 0));
  float m2 = gradientNoise(p + offset - vec3(0, eps, 0));
  float m3 = gradientNoise(p + offset + vec3(0, 0, eps));
  float m4 = gradientNoise(p + offset - vec3(0, 0, eps));
  float m5 = gradientNoise(p + offset + vec3(eps, 0, 0));
  float m6 = gradientNoise(p + offset - vec3(eps, 0, 0));

  float eps2 = 2.0 * eps;
  return vec3(
    ((n1 - n2) / eps2 - (m3 - m4) / eps2) * 0.5 + 0.5,
    ((n3 - n4) / eps2 - (n5 - n6) / eps2) * 0.5 + 0.5,
    ((m5 - m6) / eps2 - (m1 - m2) / eps2) * 0.5 + 0.5
  );
}

void main() {
  vec3 uvw = vec3(v_uv, u_slice);
  float scale = 8.0;
  vec3 scaledPos = uvw * scale;

  // R: Multi-octave Detail Worley (for rich close-up erosion)
  float worleyDetail = worleyFBM(uvw, 8.0, 10.0);

  // Add some Perlin modulation for more organic look
  float perlinMod = (gradientNoise(scaledPos * 1.5) + 1.0) * 0.5;
  worleyDetail = mix(worleyDetail, worleyDetail * perlinMod, 0.2);

  // G: Very Fine Worley (highest frequency detail)
  float worleyFine = 1.0 - worleyNoise(uvw, 24.0, 11.0);
  float worleyUltraFine = 1.0 - worleyNoise(uvw, 32.0, 12.0);
  worleyFine = worleyFine * 0.7 + worleyUltraFine * 0.3;

  // B, A: Curl noise XY components for turbulent flow
  vec3 curl = curlNoiseSimple(scaledPos * 0.4);

  fragColor = vec4(worleyDetail, worleyFine, curl.x, curl.y);
}
`;

// Blue Noise shader (R2 sequence)
export const BLUE_NOISE_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  // R2 sequence - quasi-random with excellent blue noise properties
  float g = 1.32471795724474602596;  // Plastic constant
  float a1 = 1.0 / g;
  float a2 = 1.0 / (g * g);

  // Convert UV to index
  ivec2 coord = ivec2(gl_FragCoord.xy);
  int idx = coord.y * 128 + coord.x;

  float r = fract(0.5 + a1 * float(idx));
  float g_val = fract(0.5 + a2 * float(idx));

  fragColor = vec4(r, g_val, 0.0, 1.0);
}
`;
