/**
 * @fileoverview Strikingly beautiful 3D velocity flow visualization shaders.
 *
 * RENDERING ARCHITECTURE:
 * =======================
 * This implements a premium Windy.com-style visualization with:
 *
 * 1. 3D COMET PARTICLES - Velocity-aligned quads with head-to-tail gradients
 * 2. TEMPORAL PERSISTENCE - Chromatic frame fading for beautiful trail persistence
 * 3. MULTI-LAYER GLOW - Core + inner + outer + ambient glow layers
 * 4. ANAMORPHIC BLOOM - Cinematic horizontal-stretched bloom
 * 5. HDR COMPOSITING - Filmic tone mapping with advanced color grading
 *
 * The key insight: Trail beauty comes from temporal chromatic persistence,
 * particle beauty comes from velocity-aligned elongation and layered glow.
 *
 * PIPELINE:
 * 1. SIMULATION: Transform feedback advances particles with organic motion
 * 2. FADE: Chromatic multiply of previous frame (differential RGB decay)
 * 3. DRAW: Render velocity-aligned comet particles with layered glow
 * 4. BLOOM: Multi-pass anamorphic bloom for cinematic glow
 * 5. COMPOSITE: HDR tone mapping + color grading + film grain
 *
 * @module rendering/overlays/velocity/velocity-shaders
 */

// =============================================================================
// PASS 1: GPU PARTICLE SIMULATION (Transform Feedback)
// =============================================================================

/**
 * Vertex shader for GPU particle simulation with organic motion.
 * Each particle: position (vec3), velocity cache (vec3), age (float), cell index (uint)
 */
export const PARTICLE_UPDATE_VS = `#version 300 es
precision highp float;
precision highp int;

// Particle state
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_velocity;
layout(location = 2) in float a_age;
layout(location = 3) in uint a_cellIndex;

// Simulation parameters
uniform float u_dt;
uniform float u_time;
uniform float u_speedMultiplier;
uniform float u_lifetime;
uniform float u_dropRate;
uniform float u_dropRateBump;
uniform float u_turbulence;

// Velocity field texture
uniform sampler2D u_velocityTex;
uniform int u_velocityTexWidth;

// Cell position texture (for spawning)
uniform sampler2D u_positionTex;
uniform int u_positionTexWidth;

// Spawn table texture (visibility-filtered indices)
uniform highp usampler2D u_spawnTableTex;
uniform int u_spawnTableWidth;
uniform int u_spawnTableSize;

// Transform feedback outputs
out vec3 v_position;
out vec3 v_velocity;
out float v_age;
flat out uint v_cellIndex;

// High-quality PCG hash for randomness
uint pcgHash(uint x) {
  uint state = x * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

float rand01(inout uint seed) {
  seed = pcgHash(seed);
  return float(seed) / 4294967296.0;
}

vec2 rand2(inout uint seed) {
  return vec2(rand01(seed), rand01(seed));
}

vec3 rand3(inout uint seed) {
  return vec3(rand01(seed), rand01(seed), rand01(seed));
}

// Simplex noise for organic turbulence
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// Curl noise for divergence-free turbulence
vec3 curlNoise(vec3 p, float scale) {
  float eps = 0.0001;
  vec3 dx = vec3(eps, 0.0, 0.0);
  vec3 dy = vec3(0.0, eps, 0.0);
  vec3 dz = vec3(0.0, 0.0, eps);

  vec3 ps = p * scale;

  float x0 = snoise(ps + dy) - snoise(ps - dy);
  float x1 = snoise(ps + dz) - snoise(ps - dz);
  float y0 = snoise(ps + dz) - snoise(ps - dz);
  float y1 = snoise(ps + dx) - snoise(ps - dx);
  float z0 = snoise(ps + dx) - snoise(ps - dx);
  float z1 = snoise(ps + dy) - snoise(ps - dy);

  return vec3(x0 - x1, y0 - y1, z0 - z1) / (2.0 * eps);
}

uint sampleSpawnIndex(inout uint seed) {
  int size = u_spawnTableSize;
  if (size <= 0) return a_cellIndex;

  float r = rand01(seed);
  int flatIdx = clamp(int(floor(r * float(size))), 0, size - 1);
  int y = flatIdx / u_spawnTableWidth;
  int x = flatIdx - y * u_spawnTableWidth;
  return texelFetch(u_spawnTableTex, ivec2(x, y), 0).r;
}

vec3 fetchCellPosition(uint cellIndex) {
  int idx = int(cellIndex);
  int y = idx / u_positionTexWidth;
  int x = idx - y * u_positionTexWidth;
  return texelFetch(u_positionTex, ivec2(x, y), 0).rgb;
}

vec3 fetchVelocity(uint cellIndex) {
  int idx = int(cellIndex);
  int y = idx / u_velocityTexWidth;
  int x = idx - y * u_velocityTexWidth;
  return texelFetch(u_velocityTex, ivec2(x, y), 0).rgb;
}

void main() {
  float dt = clamp(u_dt, 0.0, 0.05);
  float life = max(u_lifetime, 0.1);

  // Initialize random seed from vertex ID and time
  uint seed = uint(gl_VertexID) ^ pcgHash(uint(u_time * 10000.0));

  // Fetch current velocity
  vec3 velocity = fetchVelocity(a_cellIndex);
  float speed = length(velocity);

  // Windy.com-style: slow particles drop faster (creates visual density variation)
  float speedNorm = clamp(speed * 2.0, 0.0, 1.0);
  float dropChance = u_dropRate + u_dropRateBump * (1.0 - speedNorm);
  bool randomDrop = rand01(seed) < dropChance * dt * 60.0;

  // Age the particle
  float newAge = a_age + dt / life;
  bool expired = newAge >= 1.0;
  bool respawn = expired || randomDrop;

  if (respawn) {
    // Respawn at a random visible cell
    uint newCell = sampleSpawnIndex(seed);
    vec3 newPos = fetchCellPosition(newCell);
    vec3 newVel = fetchVelocity(newCell);

    // Add tiny random offset to prevent clustering
    vec3 jitter = (rand3(seed) - 0.5) * 0.002;
    newPos += jitter;

    v_position = newPos;
    v_velocity = newVel;
    v_age = rand01(seed) * 0.1; // Stagger ages for natural look
    v_cellIndex = newCell;
  } else {
    // Add organic turbulence for more natural motion
    vec3 turbulenceOffset = vec3(0.0);
    if (u_turbulence > 0.0) {
      turbulenceOffset = curlNoise(a_position + u_time * 0.1, 3.0) * u_turbulence * 0.01;
    }

    // Advect along velocity field with smooth interpolation
    vec3 newPos = a_position + (velocity + turbulenceOffset) * dt * u_speedMultiplier;

    // Smooth velocity update (blend old and new for continuity)
    vec3 newVel = mix(a_velocity, velocity, 0.25);

    v_position = newPos;
    v_velocity = newVel;
    v_age = newAge;
    v_cellIndex = a_cellIndex;
  }
}
`;

/**
 * Fragment shader for simulation pass (outputs discarded - transform feedback only)
 */
export const PARTICLE_UPDATE_FS = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.0);
}
`;

// =============================================================================
// PASS 2: CHROMATIC TRAIL FADE (The Secret to Beautiful Trails!)
// =============================================================================

/**
 * Fullscreen quad vertex shader for post-processing passes
 */
export const FULLSCREEN_VS = `#version 300 es
precision highp float;

out vec2 v_uv;

void main() {
  // Generate fullscreen quad from vertex ID
  vec2 positions[4] = vec2[4](
    vec2(-1.0, -1.0),
    vec2( 1.0, -1.0),
    vec2(-1.0,  1.0),
    vec2( 1.0,  1.0)
  );
  vec2 pos = positions[gl_VertexID];
  v_uv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

/**
 * CHROMATIC trail fade - different decay rates per channel for beautiful persistence!
 * Red fades slowest, blue fades fastest - creates warm-to-cool trail gradient.
 *
 * Enhanced with:
 * - Smoother chromatic color transitions
 * - Subtle color temperature shift over time
 * - Preserved HDR information in trails
 * - Gentle bloom/glow preservation
 */
export const TRAIL_FADE_FS = `#version 300 es
precision highp float;

in vec2 v_uv;

uniform sampler2D u_previousFrame;
uniform float u_fadeAmount;
uniform float u_chromaticFade; // 0 = uniform, 1 = full chromatic

out vec4 fragColor;

// Soft color temperature shift for more natural trail aging
vec3 temperatureShift(vec3 color, float amount) {
  // Shift towards cooler (blue) as trails age - mimics natural light behavior
  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  vec3 cool = vec3(luma * 0.9, luma * 0.95, luma * 1.1);
  return mix(color, cool, amount * 0.15);
}

void main() {
  vec4 prev = texture(u_previousFrame, v_uv);

  // Early out for very dark pixels
  if (prev.a < 0.001) {
    fragColor = vec4(0.0);
    return;
  }

  // Chromatic fade: R fades slowest, B fades fastest
  // This creates beautiful warm-to-cool trailing gradients
  float baseFade = u_fadeAmount;

  // Enhanced differential fade with smoother curves
  // Using non-linear fade for more organic trail decay
  float fadeStrength = u_chromaticFade;

  // Red channel: persists longest, gives trails warm "heat" look
  float fadeR = baseFade * mix(1.0, 1.025, fadeStrength);

  // Green channel: slight boost for natural color preservation
  float fadeG = baseFade * mix(1.0, 1.005, fadeStrength);

  // Blue channel: fades faster, but not too aggressively
  float fadeB = baseFade * mix(1.0, 0.965, fadeStrength);

  // Apply chromatic fade
  vec3 faded = vec3(
    prev.r * fadeR,
    prev.g * fadeG,
    prev.b * fadeB
  );

  // Apply subtle temperature shift based on brightness
  // Brighter areas stay warmer, dimmer areas cool down
  float brightness = max(max(faded.r, faded.g), faded.b);
  float tempShiftAmount = (1.0 - brightness) * fadeStrength;
  faded = temperatureShift(faded, tempShiftAmount);

  // Luminance-based glow preservation
  // Helps maintain beautiful soft edges on trails
  float luminance = dot(faded, vec3(0.299, 0.587, 0.114));

  // Subtle ambient glow that prevents harsh cutoff
  // Uses smooth hermite interpolation for natural falloff
  float glowFactor = smoothstep(0.0, 0.15, luminance);
  vec3 ambientGlow = vec3(0.0008, 0.0006, 0.0015) * glowFactor;

  // Preserve HDR information for bloom
  // Bright particles maintain their glow character longer
  float hdrBoost = smoothstep(0.5, 1.5, luminance) * 0.02;
  faded *= 1.0 + hdrBoost;

  // Final output with preserved alpha for compositing
  float alphaFade = baseFade * mix(1.0, 0.995, fadeStrength);
  fragColor = vec4(faded + ambientGlow, prev.a * alphaFade);
}
`;

// =============================================================================
// PASS 3: 3D COMET PARTICLE RENDERING (Velocity-Aligned Beauty)
// =============================================================================

/**
 * Vertex shader for rendering particles as glowing point sprites.
 * High-quality soft particles with velocity-based sizing.
 *
 * Enhanced with:
 * - Better perspective size attenuation matching the main renderer
 * - Smoother fog integration
 * - Improved age-based effects
 */
export const PARTICLE_RENDER_VS = `#version 300 es
precision highp float;
precision highp int;

// Particle attributes (from simulation buffer)
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_velocity;
layout(location = 2) in float a_age;
layout(location = 3) in uint a_cellIndex;

// Transform matrices
uniform mat4 u_mvpMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_modelMatrix;

// Camera and viewport
uniform vec3 u_cameraPosition;
uniform float u_viewportHeight;
uniform float u_fov;
uniform float u_sizeAttenuation;

// Particle appearance
uniform float u_particleSize;
uniform float u_minSize;
uniform float u_maxSize;
uniform float u_cometStretch; // Velocity-based elongation amount

// Velocity normalization
uniform float u_invMaxMagnitude;

// Visibility texture
uniform sampler2D u_alphaTex;
uniform int u_alphaTexWidth;
uniform bool u_useAlphaTex;

// Fog parameters
uniform float u_fogNear;
uniform float u_fogFar;
uniform float u_fogDensity;

// Outputs to fragment shader
out float v_age;
out float v_speedNorm;
out float v_alpha;
out float v_fogFactor;
out float v_depth;
out vec3 v_velocity;
out float v_pointSize;

float fetchAlpha(uint cellIndex) {
  if (!u_useAlphaTex || u_alphaTexWidth <= 0) return 1.0;
  int idx = int(cellIndex);
  int y = idx / u_alphaTexWidth;
  int x = idx - y * u_alphaTexWidth;
  return texelFetch(u_alphaTex, ivec2(x, y), 0).r;
}

void main() {
  // Calculate visibility
  v_alpha = fetchAlpha(a_cellIndex);

  // Calculate speed for coloring
  float speed = length(a_velocity);
  v_speedNorm = clamp(speed * u_invMaxMagnitude, 0.0, 1.0);
  v_age = a_age;
  v_velocity = a_velocity;

  // Discard invisible or extremely slow particles
  if (v_alpha < 0.01 || speed < 0.00001) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    gl_PointSize = 0.0;
    v_pointSize = 0.0;
    return;
  }

  // Transform to view space for depth calculations
  vec4 worldPos = u_modelMatrix * vec4(a_position, 1.0);
  vec4 viewPos = u_viewMatrix * worldPos;

  // Transform to clip space
  gl_Position = u_mvpMatrix * vec4(a_position, 1.0);

  // Calculate depth
  float eyeDepth = -viewPos.z;
  v_depth = eyeDepth;

  // === FOG CALCULATION (matches main renderer) ===
  // Use exponential squared fog for smooth atmospheric effect
  float fogRange = max(u_fogFar - u_fogNear, 0.001);
  float normalizedDist = clamp((eyeDepth - u_fogNear) / fogRange, 0.0, 1.0);

  // Exponential squared - creates natural atmospheric falloff
  float fogExponent = u_fogDensity * u_fogDensity * normalizedDist * normalizedDist;
  v_fogFactor = exp(-fogExponent);
  v_fogFactor = clamp(v_fogFactor, 0.0, 1.0);

  // === DYNAMIC PARTICLE SIZING ===

  // Speed factor: faster particles are larger
  float speedFactor = 0.5 + 0.7 * v_speedNorm;

  // Age-based effects with smooth curves
  // Particles shrink as they age
  float ageFade = 1.0 - smoothstep(0.5, 1.0, a_age) * 0.5;

  // Birth burst: particles start larger and quickly shrink to normal
  float birthPhase = 1.0 - smoothstep(0.0, 0.12, a_age);
  float birthBurst = 1.0 + birthPhase * birthPhase * 0.4;

  // Combine factors
  float baseSize = u_particleSize * speedFactor * ageFade * birthBurst;

  // === PERSPECTIVE SIZE ATTENUATION ===
  // This matches the main point renderer's size calculation
  float tanHalfFov = tan(u_fov * 0.5);
  float projectionFactor = u_viewportHeight / (2.0 * tanHalfFov);

  // Convert to world-space size
  float worldSize = baseSize * 0.012; // Slightly larger scale factor

  // Calculate perspective size (objects shrink with distance)
  float perspectiveSize = (worldSize * projectionFactor) / max(eyeDepth, 0.001);

  // Blend between fixed screen-space size and perspective size
  // u_sizeAttenuation: 0 = fixed size, 1 = full perspective
  float finalSize = mix(baseSize, perspectiveSize, u_sizeAttenuation);

  // Apply depth-based size boost for far particles
  // This helps maintain visibility of distant particles
  float depthBoost = mix(1.3, 1.0, v_fogFactor);
  finalSize *= depthBoost;

  // === VELOCITY-BASED STRETCHING ===
  // Comet effect: particles stretch along velocity direction
  float stretchFactor = 1.0 + v_speedNorm * u_cometStretch;
  // Square root preserves visual area while stretching
  finalSize *= sqrt(stretchFactor);

  // Apply min/max constraints
  gl_PointSize = clamp(finalSize, u_minSize, u_maxSize);
  v_pointSize = gl_PointSize;
}
`;

/**
 * Fragment shader for stunning particle sprites with multi-layer glow.
 * Creates beautiful soft particles with depth-aware coloring.
 *
 * Enhanced with:
 * - 6-layer glow system for silky smooth falloff
 * - Physically-inspired energy distribution
 * - Enhanced comet shape with natural tail gradient
 * - Better color handling for vibrant trails
 */
export const PARTICLE_RENDER_FS = `#version 300 es
precision highp float;

in float v_age;
in float v_speedNorm;
in float v_alpha;
in float v_fogFactor;
in float v_depth;
in vec3 v_velocity;
in float v_pointSize;

uniform sampler2D u_colormapTex;
uniform float u_intensity;
uniform float u_glowAmount;
uniform float u_coreSharpness;
uniform float u_cometStretch;
uniform vec3 u_fogColor;

out vec4 fragColor;

// Soft exponential falloff for natural glow
float softGlow(float dist, float falloff) {
  return exp(-dist * dist * falloff);
}

// Smooth hermite for butter-smooth transitions
float smoothFalloff(float x, float edge0, float edge1) {
  float t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

void main() {
  if (v_alpha < 0.01) discard;

  // Distance from center of point sprite
  vec2 coord = gl_PointCoord * 2.0 - 1.0;

  // === VELOCITY-ALIGNED COMET SHAPE ===
  // More sophisticated velocity direction calculation
  vec3 velNorm = v_velocity;
  float velLen = length(velNorm);
  if (velLen > 0.0001) velNorm /= velLen;

  vec2 velDir2D = normalize(velNorm.xy + vec2(0.00001));
  float stretch = 1.0 + v_speedNorm * u_cometStretch * 1.5;

  // Transform to velocity-aligned space
  float alongVel = dot(coord, velDir2D);
  float perpVel = dot(coord, vec2(-velDir2D.y, velDir2D.x));

  // Enhanced comet shape with asymmetric falloff
  // Head is round, tail is elongated
  float tailStretch = 1.0 + max(0.0, -alongVel) * v_speedNorm * u_cometStretch * 0.8;
  vec2 cometCoord = vec2(
    alongVel / (stretch * tailStretch),
    perpVel * mix(stretch * 0.6, stretch * 0.4, max(0.0, -alongVel))
  );
  float dist = length(cometCoord);

  // Head-to-tail gradient with smooth falloff
  float headTail = smoothstep(-0.8, 0.6, alongVel);
  float tailFade = 1.0 - smoothstep(0.0, 1.5, -alongVel) * 0.6;

  // Discard outside with soft edge
  if (dist > 1.4) discard;

  // === PREMIUM 6-LAYER GLOW SYSTEM ===
  // Inspired by real light physics - energy drops off exponentially

  // Layer 1: Super-hot plasma core (very sharp, very bright)
  float coreSize = mix(0.12, 0.05, u_coreSharpness);
  float plasmaCore = 1.0 - smoothFalloff(dist, 0.0, coreSize);
  plasmaCore = plasmaCore * plasmaCore * plasmaCore; // Cubic for sharp falloff

  // Layer 2: Hot inner core (bright center)
  float hotCore = softGlow(dist, 12.0);

  // Layer 3: Inner bright glow
  float innerGlow = softGlow(dist, 5.0) * 0.8;

  // Layer 4: Medium energy glow
  float midGlow = softGlow(dist, 2.2) * 0.5;

  // Layer 5: Soft outer glow
  float outerGlow = softGlow(dist, 0.9) * 0.25;

  // Layer 6: Atmospheric halo (very soft, very wide)
  float halo = softGlow(dist, 0.35) * 0.12;

  // Combine layers with artistic weighting
  float coreEnergy = plasmaCore + hotCore;
  float glowEnergy = innerGlow + midGlow + outerGlow + halo;

  // Blend based on glow amount parameter
  float totalGlow = coreEnergy + glowEnergy * u_glowAmount;

  // Apply head-to-tail gradient for natural comet look
  totalGlow *= mix(0.25, 1.3, headTail) * tailFade;

  // Speed-based energy boost (faster = more energetic)
  totalGlow *= 0.7 + 0.5 * v_speedNorm;

  // === BEAUTIFUL VELOCITY-BASED COLORING ===
  vec3 baseColor = texture(u_colormapTex, vec2(v_speedNorm, 0.5)).rgb;

  // Vibrance boost - more saturated colors
  float luma = dot(baseColor, vec3(0.299, 0.587, 0.114));
  float vibrance = 1.6;
  vec3 vibrantColor = mix(vec3(luma), baseColor, vibrance);
  vibrantColor = clamp(vibrantColor, 0.0, 1.0);

  // === WHITE-HOT CORE EFFECT ===
  // Core glows white-hot, fading to colormap color at edges
  float coreWhiteness = (plasmaCore + hotCore * 0.5) * (0.6 + 0.5 * v_speedNorm);
  vec3 whiteHot = vec3(1.0, 0.98, 0.94); // Slightly warm white
  vec3 particleColor = mix(vibrantColor, whiteHot, coreWhiteness);

  // High-speed particles shift towards pure white
  particleColor = mix(particleColor, vec3(1.0), v_speedNorm * plasmaCore * 0.4);

  // === AGE-BASED COLOR EVOLUTION ===
  // Fresh particles are warm, old particles cool down
  float ageFactor = smoothstep(0.0, 1.0, v_age);

  // Brightness fades as particle ages
  float ageBrightness = 1.0 - smoothstep(0.4, 1.0, v_age) * 0.5;

  // Color temperature shifts cooler with age
  vec3 coolerColor = particleColor * vec3(0.88, 0.93, 1.08);
  particleColor = mix(particleColor, coolerColor, ageFactor * 0.4);

  // Slight desaturation with age
  float ageLuma = dot(particleColor, vec3(0.299, 0.587, 0.114));
  particleColor = mix(particleColor, vec3(ageLuma), ageFactor * 0.2);

  // === DEPTH-BASED ATMOSPHERIC EFFECTS ===
  // Fog affects both brightness and color temperature
  float depthBrightness = mix(0.35, 1.0, v_fogFactor);

  // Distant particles have slightly boosted intensity to remain visible
  float depthBoost = mix(1.4, 1.0, v_fogFactor);

  // === FINAL INTENSITY CALCULATION ===
  float intensity = totalGlow * u_intensity * v_alpha * ageBrightness * depthBrightness * depthBoost;

  // Soft HDR curve - prevents harsh clipping while allowing bright peaks
  intensity = intensity * (1.0 + intensity * 0.4);

  // Apply atmospheric fog color blending
  vec3 finalColor = mix(u_fogColor * 0.08, particleColor, v_fogFactor);

  // Final output - premultiplied alpha for additive blending
  fragColor = vec4(finalColor * intensity, intensity);
}
`;

// =============================================================================
// PASS 4: ANAMORPHIC BLOOM (Cinematic Horizontal-Stretched Glow)
// =============================================================================

/**
 * Soft threshold extraction with luminance-preserving algorithm
 */
export const THRESHOLD_FS = `#version 300 es
precision highp float;

in vec2 v_uv;

uniform sampler2D u_source;
uniform float u_threshold;
uniform float u_softness;
uniform float u_knee;

out vec4 fragColor;

void main() {
  vec4 color = texture(u_source, v_uv);

  // Calculate perceptual luminance
  float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));

  // Soft knee threshold for natural-looking bloom
  float knee = u_threshold * u_knee;
  float soft = luma - u_threshold + knee;
  soft = clamp(soft * soft / (4.0 * knee + 0.00001), 0.0, 1.0);

  float contribution = max(soft, luma - u_threshold) / max(luma, 0.00001);
  contribution = clamp(contribution, 0.0, 1.0);

  // Preserve color while applying threshold
  fragColor = vec4(color.rgb * contribution, color.a * contribution);
}
`;

/**
 * High-quality separable Gaussian blur with configurable kernel
 */
export const BLUR_FS = `#version 300 es
precision highp float;

in vec2 v_uv;

uniform sampler2D u_source;
uniform vec2 u_direction;
uniform float u_blurSize;

out vec4 fragColor;

void main() {
  vec2 texelSize = 1.0 / vec2(textureSize(u_source, 0));
  vec2 offset = u_direction * texelSize * u_blurSize;

  // 13-tap Gaussian blur weights for high quality
  const float weights[7] = float[7](
    0.1964825501511404,
    0.2969069646728344,
    0.09447039785044732,
    0.010381362401148057,
    0.0003951489674184668,
    0.000005226574605564482,
    0.0
  );

  vec4 result = texture(u_source, v_uv) * weights[0];

  for (int i = 1; i < 7; i++) {
    vec2 offsetI = offset * float(i);
    result += texture(u_source, v_uv + offsetI) * weights[i];
    result += texture(u_source, v_uv - offsetI) * weights[i];
  }

  fragColor = result;
}
`;

/**
 * Anamorphic blur - horizontal stretch for cinematic look
 */
export const ANAMORPHIC_BLUR_FS = `#version 300 es
precision highp float;

in vec2 v_uv;

uniform sampler2D u_source;
uniform float u_anamorphicRatio; // > 1.0 = more horizontal stretch
uniform float u_blurSize;

out vec4 fragColor;

void main() {
  vec2 texelSize = 1.0 / vec2(textureSize(u_source, 0));

  // Anamorphic: stretch horizontally more than vertically
  vec2 offset = texelSize * u_blurSize * vec2(u_anamorphicRatio, 1.0 / u_anamorphicRatio);

  // 9-tap separable blur with anamorphic weighting
  const float weights[5] = float[5](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);

  vec4 result = texture(u_source, v_uv) * weights[0];

  for (int i = 1; i < 5; i++) {
    // Horizontal samples (more weight)
    vec2 offsetH = vec2(offset.x * float(i), 0.0);
    result += texture(u_source, v_uv + offsetH) * weights[i] * 0.7;
    result += texture(u_source, v_uv - offsetH) * weights[i] * 0.7;

    // Vertical samples (less weight for anamorphic look)
    vec2 offsetV = vec2(0.0, offset.y * float(i));
    result += texture(u_source, v_uv + offsetV) * weights[i] * 0.3;
    result += texture(u_source, v_uv - offsetV) * weights[i] * 0.3;
  }

  fragColor = result;
}
`;

// =============================================================================
// PASS 5: HDR COMPOSITE WITH CINEMATIC COLOR GRADING
// =============================================================================

/**
 * Final composite shader with premium HDR tone mapping and film-inspired color grading.
 * Includes vignette, film grain, and chromatic aberration options.
 *
 * Enhanced with:
 * - Smoother ACES tone mapping variant
 * - Better bloom integration
 * - Enhanced color grading pipeline
 * - Subtle lens effects for cinematic feel
 */
export const COMPOSITE_FS = `#version 300 es
precision highp float;

in vec2 v_uv;

uniform sampler2D u_trailTex;
uniform sampler2D u_bloomTex;
uniform float u_opacity;
uniform float u_gamma;
uniform float u_bloomStrength;
uniform float u_exposure;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_time;

// Advanced options
uniform float u_vignette;
uniform float u_filmGrain;
uniform float u_chromaticAberration;
uniform vec3 u_colorTint; // RGB multiplier for color grading
uniform float u_highlights;
uniform float u_shadows;

out vec4 fragColor;

// Enhanced ACES Filmic Tone Mapping with better shadow detail preservation
vec3 ACESFilmEnhanced(vec3 x) {
  // More nuanced ACES approximation that preserves shadow detail
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  vec3 result = (x * (a * x + b)) / (x * (c * x + d) + e);

  // Subtle shadow lift to prevent crushing blacks
  float shadowBoost = 0.02;
  result = result + shadowBoost * (1.0 - result) * (1.0 - result);

  return clamp(result, 0.0, 1.0);
}

// Soft S-curve for contrast - more filmic than linear
vec3 softContrast(vec3 color, float amount) {
  // Centered at 0.5, uses smooth hermite interpolation
  vec3 t = clamp(color, 0.0, 1.0);
  vec3 curved = t * t * (3.0 - 2.0 * t); // Hermite curve
  return mix(color, mix(vec3(0.5), curved, 1.5), (amount - 1.0) * 0.5);
}

// High-quality hash for film grain
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Film grain with temporal stability
float filmGrainNoise(vec2 uv, float time) {
  // Slower time variation for more subtle grain
  float t = floor(time * 24.0) / 24.0; // 24fps-like grain refresh
  vec2 seed = uv * 800.0 + t * 100.0;
  float noise = hash12(seed) * 2.0 - 1.0;
  // Softer Gaussian-like distribution
  noise = sign(noise) * pow(abs(noise), 0.6);
  return noise;
}

// Cinematic vignette with natural falloff
float vignetteEffect(vec2 uv, float strength) {
  vec2 center = uv - 0.5;
  float dist = length(center) * 1.2; // Adjusted for wider coverage
  // Smooth polynomial falloff
  float vig = 1.0 - dist * dist * strength * 1.5;
  return clamp(vig, 0.0, 1.0);
}

// Subtle lens glow at edges (anamorphic-style)
vec3 lensGlow(vec2 uv, vec3 color, float strength) {
  vec2 center = uv - 0.5;
  float dist = length(center);
  // Soft blue-ish edge glow
  vec3 glowColor = vec3(0.4, 0.6, 1.0);
  float glow = smoothstep(0.3, 0.8, dist) * strength * 0.15;
  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  return color + glowColor * glow * luma;
}

void main() {
  vec2 uv = v_uv;

  // === CHROMATIC ABERRATION (Enhanced) ===
  vec4 trail, bloom;
  if (u_chromaticAberration > 0.0) {
    vec2 center = uv - 0.5;
    float dist = length(center);
    vec2 dir = normalize(center + 0.0001);

    // Non-linear aberration - stronger at edges
    float aberration = u_chromaticAberration * 0.008 * dist * dist;

    // Sample each channel with offset
    trail.r = texture(u_trailTex, uv + dir * aberration * 1.1).r;
    trail.g = texture(u_trailTex, uv).g;
    trail.b = texture(u_trailTex, uv - dir * aberration).b;
    trail.a = texture(u_trailTex, uv).a;

    // Bloom gets slightly more aberration for dreamy effect
    bloom.r = texture(u_bloomTex, uv + dir * aberration * 1.8).r;
    bloom.g = texture(u_bloomTex, uv).g;
    bloom.b = texture(u_bloomTex, uv - dir * aberration * 1.5).b;
    bloom.a = texture(u_bloomTex, uv).a;
  } else {
    trail = texture(u_trailTex, uv);
    bloom = texture(u_bloomTex, uv);
  }

  // Early discard for empty pixels
  float totalAlpha = trail.a + bloom.a * u_bloomStrength;
  if (totalAlpha < 0.001) discard;

  // === BLOOM INTEGRATION ===
  // Soft blend bloom with additive + screen mix for natural look
  vec3 bloomColor = bloom.rgb * u_bloomStrength;
  vec3 color = trail.rgb;

  // Screen blend for bloom (prevents over-brightening)
  vec3 screenBlend = 1.0 - (1.0 - color) * (1.0 - bloomColor * 0.5);
  color = color + bloomColor * 0.7 + (screenBlend - color) * 0.3;

  // === EXPOSURE ===
  color *= u_exposure;

  // === SHADOWS / HIGHLIGHTS (Improved) ===
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));

  // Smoother shadow/highlight masking
  float shadowMask = 1.0 - smoothstep(0.0, 0.4, luma);
  shadowMask = shadowMask * shadowMask; // Quadratic for softer blend
  float highlightMask = smoothstep(0.4, 0.9, luma);

  // Apply shadow/highlight adjustments
  vec3 shadowAdjust = color * u_shadows;
  vec3 highlightAdjust = color * u_highlights;
  color = mix(color, shadowAdjust, shadowMask * 0.4);
  color = mix(color, highlightAdjust, highlightMask * 0.25);

  // === CONTRAST (Soft S-curve) ===
  color = softContrast(color, u_contrast);

  // === TONE MAPPING ===
  color = ACESFilmEnhanced(color);

  // === COLOR TINT ===
  color *= u_colorTint;

  // === SATURATION (with vibrance) ===
  luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  // Vibrance-style saturation - boosts less saturated colors more
  float sat = max(max(color.r, color.g), color.b) - min(min(color.r, color.g), color.b);
  float vibranceWeight = 1.0 - sat; // Less saturated = more boost
  float effectiveSat = mix(u_saturation, u_saturation * 1.2, vibranceWeight * 0.3);
  color = mix(vec3(luma), color, effectiveSat);

  // === GAMMA CORRECTION ===
  color = pow(max(color, 0.0), vec3(1.0 / u_gamma));

  // === LENS EFFECTS ===
  if (u_vignette > 0.0) {
    // Vignette
    color *= vignetteEffect(uv, u_vignette);

    // Subtle edge glow (anamorphic look)
    color = lensGlow(uv, color, u_vignette);
  }

  // === FILM GRAIN ===
  if (u_filmGrain > 0.0) {
    float grain = filmGrainNoise(uv, u_time) * u_filmGrain * 0.08;
    // Apply grain weighted by luminance (more visible in midtones)
    luma = dot(color, vec3(0.299, 0.587, 0.114));
    float grainMask = smoothstep(0.0, 0.3, luma) * (1.0 - smoothstep(0.7, 1.0, luma));
    color += grain * grainMask;
  }

  // === FINAL OUTPUT ===
  // Subtle highlight compression for smooth clipping
  color = color - max(vec3(0.0), color - 0.95) * 0.5;

  float alpha = clamp(totalAlpha * u_opacity, 0.0, 1.0);

  fragColor = vec4(clamp(color, 0.0, 1.0), alpha);
}
`;

// =============================================================================
// BONUS: VELOCITY-ALIGNED STREAK PARTICLES (Alternative Renderer)
// =============================================================================

/**
 * Vertex shader for velocity-aligned quad particles (higher quality than point sprites).
 * Creates proper comet shapes with head-to-tail geometry.
 */
export const PARTICLE_STREAK_VS = `#version 300 es
precision highp float;
precision highp int;

// Particle attributes
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_velocity;
layout(location = 2) in float a_age;
layout(location = 3) in uint a_cellIndex;

// Quad vertex (instanced)
layout(location = 4) in vec2 a_quadVertex; // (-1,-1), (1,-1), (-1,1), (1,1)

// Transform matrices
uniform mat4 u_viewMatrix;
uniform mat4 u_modelMatrix;
uniform mat4 u_projectionMatrix;

// Camera
uniform vec3 u_cameraPosition;
uniform float u_viewportHeight;

// Appearance
uniform float u_streakLength;
uniform float u_streakWidth;
uniform float u_invMaxMagnitude;

// Visibility
uniform sampler2D u_alphaTex;
uniform int u_alphaTexWidth;
uniform bool u_useAlphaTex;

// Fog
uniform float u_fogNear;
uniform float u_fogFar;
uniform float u_fogDensity;

// Outputs
out vec2 v_quadPos;
out float v_age;
out float v_speedNorm;
out float v_alpha;
out float v_fogFactor;
out float v_headTail;

float fetchAlpha(uint cellIndex) {
  if (!u_useAlphaTex || u_alphaTexWidth <= 0) return 1.0;
  int idx = int(cellIndex);
  int y = idx / u_alphaTexWidth;
  int x = idx - y * u_alphaTexWidth;
  return texelFetch(u_alphaTex, ivec2(x, y), 0).r;
}

void main() {
  v_alpha = fetchAlpha(a_cellIndex);

  float speed = length(a_velocity);
  v_speedNorm = clamp(speed * u_invMaxMagnitude, 0.0, 1.0);
  v_age = a_age;
  v_quadPos = a_quadVertex;

  // Head-to-tail: y=1 is head (front), y=-1 is tail (back)
  v_headTail = a_quadVertex.y * 0.5 + 0.5;

  if (v_alpha < 0.01 || speed < 0.00001) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    return;
  }

  // Transform to world space
  vec4 worldPos = u_modelMatrix * vec4(a_position, 1.0);
  vec3 worldVel = mat3(u_modelMatrix) * a_velocity;

  // Calculate billboard axes
  vec3 toCamera = normalize(u_cameraPosition - worldPos.xyz);
  vec3 velDir = normalize(worldVel);

  // Cross product for perpendicular direction
  vec3 right = normalize(cross(toCamera, velDir));
  if (length(cross(toCamera, velDir)) < 0.001) {
    right = normalize(cross(toCamera, vec3(0.0, 1.0, 0.0)));
  }

  // Streak dimensions based on speed
  float speedBoost = 0.5 + 1.0 * v_speedNorm;
  float streakLen = u_streakLength * speedBoost;
  float streakWid = u_streakWidth * (0.4 + 0.6 * v_speedNorm);

  // Age-based shrinking
  float ageFactor = 1.0 - smoothstep(0.6, 1.0, a_age) * 0.5;
  streakLen *= ageFactor;
  streakWid *= ageFactor;

  // Offset: tail behind particle, head in front
  // quadVertex.y: -1 = tail, +1 = head
  vec3 offset = velDir * a_quadVertex.y * streakLen + right * a_quadVertex.x * streakWid;
  vec3 finalWorld = worldPos.xyz + offset;

  // Project
  vec4 viewPos = u_viewMatrix * vec4(finalWorld, 1.0);
  gl_Position = u_projectionMatrix * viewPos;

  // Fog
  float eyeDepth = -viewPos.z;
  float fogRange = max(u_fogFar - u_fogNear, 0.001);
  float normalizedDist = max(eyeDepth - u_fogNear, 0.0) / fogRange;
  v_fogFactor = exp(-u_fogDensity * u_fogDensity * normalizedDist * normalizedDist);
  v_fogFactor = clamp(v_fogFactor, 0.0, 1.0);
}
`;

/**
 * Fragment shader for velocity-aligned streak particles with premium effects.
 */
export const PARTICLE_STREAK_FS = `#version 300 es
precision highp float;

in vec2 v_quadPos;
in float v_age;
in float v_speedNorm;
in float v_alpha;
in float v_fogFactor;
in float v_headTail;

uniform sampler2D u_colormapTex;
uniform float u_intensity;
uniform vec3 u_fogColor;
uniform float u_glowAmount;

out vec4 fragColor;

void main() {
  if (v_alpha < 0.01) discard;

  // Comet shape falloff
  float distX = abs(v_quadPos.x);
  float distY = abs(v_quadPos.y);

  // Edge falloff (perpendicular to velocity)
  float edgeFalloff = 1.0 - smoothstep(0.4, 1.0, distX);
  edgeFalloff = pow(edgeFalloff, 1.5);

  // Length falloff with head-to-tail gradient
  // Head (v_headTail=1) is bright, tail (v_headTail=0) fades
  float tailFade = mix(0.2, 1.0, v_headTail);
  float lengthFalloff = 1.0 - smoothstep(0.2, 1.0, distY * (1.0 - v_headTail * 0.5));

  // Combine for comet alpha
  float alpha = edgeFalloff * lengthFalloff * tailFade;
  alpha = pow(alpha, 1.2);

  if (alpha < 0.01) discard;

  // Core brightness at head center
  float coreX = 1.0 - smoothstep(0.0, 0.3, distX);
  float coreY = smoothstep(0.5, 1.0, v_headTail);
  float core = coreX * coreY;

  // Color from colormap
  vec3 baseColor = texture(u_colormapTex, vec2(v_speedNorm, 0.5)).rgb;

  // Boost saturation
  float luma = dot(baseColor, vec3(0.299, 0.587, 0.114));
  vec3 saturatedColor = mix(vec3(luma), baseColor, 1.4);
  saturatedColor = clamp(saturatedColor, 0.0, 1.0);

  // White-hot core at head
  float whiteMix = core * 0.6;
  vec3 color = mix(saturatedColor, vec3(1.0, 0.98, 0.92), whiteMix);

  // Cool shift towards tail
  color = mix(color, color * vec3(0.85, 0.9, 1.1), (1.0 - v_headTail) * 0.4);

  // Age fade
  float ageFade = 1.0 - smoothstep(0.6, 1.0, v_age) * 0.5;

  // Outer glow
  float glowAlpha = exp(-distX * distX * 2.0) * exp(-distY * distY * 0.5);
  alpha = mix(alpha, alpha + glowAlpha * 0.3, u_glowAmount);

  // Final intensity
  float intensity = alpha * u_intensity * v_alpha * ageFade;

  // Apply fog
  vec3 finalColor = mix(u_fogColor * 0.05, color, v_fogFactor);

  // HDR boost
  intensity *= 1.0 + intensity * 0.3;

  fragColor = vec4(finalColor * intensity, intensity);
}
`;

// =============================================================================
// UTILITY: SIMPLE COPY SHADER
// =============================================================================

/**
 * Simple copy/blit shader for debug or intermediate copies
 */
export const COPY_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_source;
uniform float u_opacity;

out vec4 fragColor;

void main() {
  vec4 color = texture(u_source, v_uv);
  fragColor = vec4(color.rgb, color.a * u_opacity);
}
`;
