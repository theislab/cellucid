/**
 * GLSL for the backdrop looks (`backdrop-looks.js` describes them).
 *
 * Two kinds of program:
 * - **Bake** programs run once per look, in idle slices: one cube face or one
 *   periodic tile per slice. They hold all the expensive noise (domain-warped
 *   fBm, ridges, cloud ray marches, star halos).
 * - **Draw** programs run once per pane per drawn frame: one full-pane
 *   triangle that reconstructs the view ray and composites the baked fields
 *   with analytic detail that has to be crisp at any resolution (star cores,
 *   paper grain, the cyclorama's light), then grades, vignettes and dithers.
 *
 * Every draw program works in linear light and writes sRGB.
 *
 * PARALLAX
 * - 3-D panes: the far layer is a sky at infinity (it turns with the camera);
 *   a near layer at a finite distance (dust shell, cloud sea, the studio
 *   floor, marine snow) slides against it as the camera orbits, pans or zooms.
 * - Planar panes (1-D/2-D data, or planar navigation): the far layer is the
 *   same sky seen through a virtual camera that turns slowly as the view pans;
 *   the near layer is a periodic tile on a plane behind the data, so the depth
 *   cue is true perspective parallax and the pan is seamless forever.
 */

// One triangle covering the target. v_ndc is the pane NDC the fragment shows:
// the target itself on screen (u_ndcTransform = 1, 1, 0, 0), or the pane NDC
// a figure-export raster pixel maps to (scale xy, offset zw).
const COMMON_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
uniform vec4 u_ndcTransform;
out vec2 v_ndc;
void main() {
  v_ndc = a_corner * u_ndcTransform.xy + u_ndcTransform.zw;
  gl_Position = vec4(a_corner, 1.0, 1.0);
}
`;

/** Hashes and periodic gradient noise. `per` is the period in x and y. */
const NOISE_GLSL = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
vec3 noiseGrad(vec3 c, vec2 per) {
  c.xy = mod(c.xy, per);
  return hash33(c) * 2.0 - 1.0;
}
// Gradient noise, about -1..1, periodic in x and y with period per.
float gnoise(vec3 p, vec2 per) {
  vec3 i = floor(p);
  vec3 f = p - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(noiseGrad(i, per), f);
  float n100 = dot(noiseGrad(i + vec3(1, 0, 0), per), f - vec3(1, 0, 0));
  float n010 = dot(noiseGrad(i + vec3(0, 1, 0), per), f - vec3(0, 1, 0));
  float n110 = dot(noiseGrad(i + vec3(1, 1, 0), per), f - vec3(1, 1, 0));
  float n001 = dot(noiseGrad(i + vec3(0, 0, 1), per), f - vec3(0, 0, 1));
  float n101 = dot(noiseGrad(i + vec3(1, 0, 1), per), f - vec3(1, 0, 1));
  float n011 = dot(noiseGrad(i + vec3(0, 1, 1), per), f - vec3(0, 1, 1));
  float n111 = dot(noiseGrad(i + vec3(1, 1, 1), per), f - vec3(1, 1, 1));
  return 1.7 * mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z
  );
}
// Fractal sum; every octave doubles the frequency and the period, so a
// periodic input stays periodic.
float fbm(vec3 p, vec2 per, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 9; i++) {
    if (i >= octaves) break;
    sum += amp * gnoise(p, per);
    norm += amp;
    p = vec3(p.xy * 2.0, p.z * 2.0 + 1.31);
    per *= 2.0;
    amp *= 0.5;
  }
  return sum / norm;
}
float ridged(vec3 p, vec2 per, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  float prev = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(gnoise(p, per));
    n *= n;
    sum += amp * n * prev;
    prev = clamp(n * 1.6, 0.0, 1.0);
    norm += amp;
    p = vec3(p.xy * 2.0, p.z * 2.0 + 0.77);
    per *= 2.0;
    amp *= 0.5;
  }
  return sum / norm;
}
`;

/**
 * Cube-face helpers. Face order and (u, v) orientation are OpenGL's:
 * texel (s, t) on face f is the direction cubeFaceDir(f, 2 s - 1, 2 t - 1).
 */
const CUBE_GLSL = `
vec3 cubeFaceDir(int face, vec2 uv) {
  if (face == 0) return vec3(1.0, -uv.y, -uv.x);
  if (face == 1) return vec3(-1.0, -uv.y, uv.x);
  if (face == 2) return vec3(uv.x, 1.0, uv.y);
  if (face == 3) return vec3(uv.x, -1.0, -uv.y);
  if (face == 4) return vec3(uv.x, -uv.y, 1.0);
  return vec3(-uv.x, -uv.y, -1.0);
}
// Inverse of cubeFaceDir: the face and its uv (-1..1) of a direction.
int cubeFaceOf(vec3 d, out vec2 uv) {
  vec3 a = abs(d);
  if (a.x >= a.y && a.x >= a.z) {
    uv = d.x > 0.0 ? vec2(-d.z, -d.y) / a.x : vec2(d.z, -d.y) / a.x;
    return d.x > 0.0 ? 0 : 1;
  }
  if (a.y >= a.z) {
    uv = d.y > 0.0 ? vec2(d.x, d.z) / a.y : vec2(d.x, -d.z) / a.y;
    return d.y > 0.0 ? 2 : 3;
  }
  uv = d.z > 0.0 ? vec2(d.x, -d.y) / a.z : vec2(-d.x, -d.y) / a.z;
  return d.z > 0.0 ? 4 : 5;
}
`;

/**
 * Star field on a cube-face cell grid. A cell holds at most one star, kept
 * inside the middle half of the cell, so a fragment only tests its own cell.
 * The bake evaluates the same stars (with neighbours) for their halos.
 */
const STARS_GLSL = `
// x: present (0/1), y: magnitude 0..1, z: colour temperature 0..1; dir out.
vec3 starInCell(int face, vec2 cell, float cells, float probability, float seed, out vec3 dir) {
  vec3 key = vec3(cell, float(face) * 131.0 + seed);
  float h = hash13(key);
  vec2 jitter = 0.25 + 0.5 * hash22(cell + vec2(float(face) * 17.0 + seed, seed * 3.1));
  vec2 st = (cell + jitter) / cells;
  vec2 uv = st * 2.0 - 1.0;
  dir = normalize(cubeFaceDir(face, uv));
  float present = step(h, probability);
  float magnitude = hash13(key + 19.7);
  return vec3(present, magnitude, hash13(key + 5.3));
}
vec3 starTint(float temperature) {
  return mix(vec3(0.62, 0.74, 1.0), vec3(1.0, 0.80, 0.58), temperature);
}
`;

// ---------------------------------------------------------------------------
// Bake programs
// ---------------------------------------------------------------------------

const BAKE_HEADER = `#version 300 es
precision highp float;
uniform int u_face;      // cube face 0..5, or -1 for the periodic tile
uniform float u_size;    // texels per side
out vec4 fragColor;
${NOISE_GLSL}
${CUBE_GLSL}
${STARS_GLSL}
`;

const NEBULA_BAKE_FS = `${BAKE_HEADER}
const vec3 BAND_NORMAL = vec3(0.3283, 0.8536, -0.4048);
const float BRIGHT_CELLS = 40.0;

// Halos of the bright stars around a direction: the 3x3 cells of its face.
float starHalos(vec3 d) {
  vec2 uv;
  int face = cubeFaceOf(d, uv);
  vec2 st = uv * 0.5 + 0.5;
  vec2 base = floor(st * BRIGHT_CELLS);
  float band = exp(-pow(dot(d, BAND_NORMAL) / 0.34, 2.0));
  float halo = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 cell = base + vec2(x, y);
      if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= BRIGHT_CELLS || cell.y >= BRIGHT_CELLS) continue;
      vec3 sd;
      vec3 star = starInCell(face, cell, BRIGHT_CELLS, 0.05 + 0.16 * band, 3.0, sd);
      if (star.x < 0.5) continue;
      float m = pow(star.y, 5.0);
      float ang = length(sd - d);
      float sigma = 0.0035 + 0.006 * m;
      halo += m * (exp(-ang * ang / (sigma * sigma)) * 2.4
        + 0.10 / (1.0 + pow(ang / (0.010 + 0.02 * m), 2.0)));
    }
  }
  return halo;
}

vec4 nebulaField(vec3 p, vec2 per, float band) {
  vec3 w = vec3(
    fbm(p + vec3(3.1, 7.7, 1.3), per, 5),
    fbm(p + vec3(8.4, 2.2, 5.9), per, 5),
    fbm(p + vec3(1.9, 4.6, 9.3), per, 5)
  );
  vec3 pw = p + w * 1.15;
  float large = fbm(pw, per, 7);
  float cloudA = smoothstep(-0.10, 0.70, large + band * 0.38 - 0.08);
  cloudA *= cloudA;
  float second = fbm(vec3(pw.xy * 2.0, pw.z * 2.0) + vec3(11.1, 3.3, 7.7), per * 2.0, 6);
  float cloudB = smoothstep(-0.05, 0.6, second) * smoothstep(-0.45, 0.35, large);
  float filaments = ridged(vec3(pw.xy * 3.0, pw.z * 3.0) + vec3(5.0, 1.0, 2.0), per * 3.0, 6);
  filaments = pow(filaments, 3.0) * smoothstep(-0.35, 0.45, large);
  float dustNoise = fbm(vec3(p.xy * 2.0, p.z * 2.0) + w * 1.6 + vec3(4.2, 0.4, 2.9), per * 2.0, 7);
  float dust = smoothstep(0.02, 0.5, dustNoise) * (0.4 + 0.6 * band);
  return vec4(cloudA, clamp(cloudB * 0.75 + filaments * 1.4, 0.0, 2.0), dust, 0.0);
}

void main() {
  vec2 st = gl_FragCoord.xy / u_size;
  if (u_face < 0) {
    // Periodic tile for the near layer of planar panes: wisps and dust.
    vec2 per = vec2(4.0);
    vec3 p = vec3(st * per, 0.37);
    vec4 field = nebulaField(p, per, 0.3);
    fragColor = vec4(clamp(field.r, 0.0, 1.0), clamp(field.g * 0.5, 0.0, 1.0), field.b, 1.0);
    return;
  }
  vec3 d = normalize(cubeFaceDir(u_face, st * 2.0 - 1.0));
  float band = exp(-pow(dot(d, BAND_NORMAL) / 0.34, 2.0));
  vec4 field = nebulaField(d * 2.1, vec2(1e4), band);
  // RGBA8: filaments (0..2) stored halved, halo glow (HDR) as g / (1 + g).
  float halo = starHalos(d);
  fragColor = vec4(field.r, clamp(field.g * 0.5, 0.0, 1.0), field.b, halo / (1.0 + halo));
}
`;

const ABYSS_BAKE_FS = `${BAKE_HEADER}
const vec3 SUN = vec3(0.2357, 0.9428, 0.2357);

// Shafts: noise around the sun axis, so every shaft converges on the sun.
vec4 abyssSky(vec3 d) {
  vec3 t1 = normalize(cross(SUN, vec3(0.0, 0.0, 1.0)));
  vec3 t2 = cross(SUN, t1);
  float ang = acos(clamp(dot(d, SUN), -1.0, 1.0));
  vec2 around = normalize(vec2(dot(d, t1), dot(d, t2)) + 1e-6);
  vec2 per = vec2(1e4);
  // Shaft pattern: noise on a circle, stretched along the shaft.
  float broad = fbm(vec3(around * 3.2, ang * 0.35), per, 4);
  float fine = fbm(vec3(around * 11.0, ang * 0.6 + 4.0), per, 4);
  float shaftsBroad = smoothstep(0.0, 0.55, broad);
  float shaftsFine = smoothstep(0.05, 0.6, fine);
  // Shafts fade away from the sun and break up along their length.
  float along = 0.6 + 0.4 * fbm(d * 3.0 + vec3(2.0, 7.0, 1.0), per, 3);
  float fade = exp(-ang * 1.15);
  // Caustic net near the surface: ridged noise on the plane above.
  float caustic = 0.0;
  if (d.y > 0.05) {
    vec2 plane = d.xz / d.y;
    caustic = pow(ridged(vec3(plane * 2.4, 0.5), per, 4), 3.0) * smoothstep(0.05, 0.6, d.y);
  }
  float murk = fbm(d * 1.6 + vec3(9.0, 3.0, 5.0), per, 6);
  return vec4(
    shaftsBroad * fade * along,
    caustic,
    murk * 0.5 + 0.5,
    shaftsFine * fade * along
  );
}

// A periodic caustic web: the bright borders of a domain-warped cellular
// pattern with "cells" cells per tile side.
float causticWeb(vec2 st, float cells) {
  vec2 per = vec2(cells);
  vec2 p = st * cells;
  vec2 w = p + 0.38 * vec2(gnoise(vec3(p, 1.3), per), gnoise(vec3(p, 7.1), per));
  vec2 i = floor(w);
  vec2 f = w - i;
  float f1 = 8.0;
  float f2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 h = hash22(mod(i + o, per) + 0.5);
      vec2 r = o + 0.5 + 0.42 * sin(6.2831 * h) - f;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return exp(-(sqrt(f2) - sqrt(f1)) * 10.0);
}

void main() {
  vec2 st = gl_FragCoord.xy / u_size;
  if (u_face < 0) {
    vec2 per = vec2(4.0);
    vec3 p = vec3(st * per, 0.61);
    float murk = fbm(p, per, 6) * 0.5 + 0.5;
    fragColor = vec4(murk, causticWeb(st, 8.0), causticWeb(st + 0.37, 5.0), 1.0);
    return;
  }
  vec3 d = normalize(cubeFaceDir(u_face, st * 2.0 - 1.0));
  fragColor = clamp(abyssSky(d), 0.0, 1.0);
}
`;

const AURORA_BAKE_FS = `${BAKE_HEADER}
const vec3 SUN = vec3(0.7894, 0.1105, -0.6039);

float cloudDensity(vec3 p, vec2 per) {
  // Offset so the field is not centred on a gap: the sky straight overhead
  // (all a camera below the data sees) carries clouds too.
  p += vec3(4.7, 0.0, 2.3);
  float base = fbm(p * vec3(0.55, 1.4, 0.55), per, 6);
  float detail = fbm(p * 1.9 + vec3(3.0, 1.0, 7.0), per, 4);
  return clamp((base * 0.85 + detail * 0.25 + 0.13) * 2.4, 0.0, 1.0);
}

// The upper clouds: a slab between heights 1.0 and 1.35, ray-marched.
vec2 upperClouds(vec3 d) {
  if (d.y < 0.015) return vec2(0.0, 0.0);
  vec2 per = vec2(1e4);
  float t0 = 1.0 / d.y;
  float t1 = 1.35 / d.y;
  float steps = 10.0;
  float dt = (t1 - t0) / steps;
  float transmittance = 1.0;
  float light = 0.0;
  for (int i = 0; i < 10; i++) {
    float t = t0 + (float(i) + 0.5) * dt;
    vec3 p = d * t;
    float far = smoothstep(4.0, 22.0, t);
    float dens = cloudDensity(p * 1.6, per) * (1.0 - far * 0.75);
    if (dens < 0.01) continue;
    float toward = cloudDensity(p * 1.6 + SUN * 0.3, per);
    float lit = exp(-toward * 2.2) * 0.85 + 0.15;
    float absorb = 1.0 - exp(-dens * dt * 7.0);
    light += transmittance * absorb * lit;
    transmittance *= 1.0 - absorb;
    if (transmittance < 0.02) break;
  }
  float opacity = (1.0 - transmittance) * smoothstep(0.015, 0.12, d.y);
  return vec2(opacity, opacity > 1e-3 ? light / (1.0 - transmittance) : 0.0);
}

// Aurora curtains: luminous vertical sheets hanging between two heights,
// whose ground tracks are wavy curves, ray-marched from below so their
// folds and rays read in true perspective. x: emission, y: mean height
// fraction (0 at the bright lower edge, 1 at the top).
vec2 curtains(vec3 d) {
  if (d.y < 0.02) return vec2(0.0);
  vec2 per = vec2(1e4);
  const float BASE = 1.7;
  const float TOP = 3.6;
  float t0 = BASE / d.y;
  float t1 = TOP / d.y;
  float dt = (t1 - t0) / 24.0;
  float glow = 0.0;
  float heightSum = 0.0;
  for (int i = 0; i < 24; i++) {
    float t = t0 + (float(i) + 0.5) * dt;
    vec3 p = d * t;
    float h = (p.y - BASE) / (TOP - BASE);
    float sheet = 0.0;
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      float z0 = k == 0 ? -1.4 : (k == 1 ? -5.5 : 4.0);
      float curve = z0
        + 1.5 * sin(p.x * 0.33 + fk * 2.1)
        + 1.3 * fbm(vec3(p.x * 0.22, fk * 4.0, 0.5), per, 2);
      float dist = abs(p.z - curve);
      float width = 0.10 + 0.015 * t;
      float rays = 0.25 + 0.75 * smoothstep(-0.25, 0.6, fbm(vec3(p.x * 5.0 + fk * 9.0, fk * 3.0, h * 0.7), per, 3));
      sheet += exp(-dist * dist / (width * width)) * rays * (1.0 - 0.25 * fk);
    }
    float profile = exp(-h * 2.4) * (1.0 - exp(-h * 30.0));
    float e = sheet * profile * dt;
    glow += e;
    heightSum += e * h;
  }
  float fade = smoothstep(0.02, 0.14, d.y);
  return vec2(clamp(glow * 5.0, 0.0, 1.0) * fade, glow > 1e-4 ? heightSum / glow : 0.0);
}

void main() {
  vec2 st = gl_FragCoord.xy / u_size;
  if (u_face < 0) {
    // Periodic cloud tile: density, top-lit shading, a second layer.
    vec2 per = vec2(4.0);
    vec3 p = vec3(st * per, 0.29);
    float dens = clamp(fbm(p, per, 7) * 1.9 + 0.12, 0.0, 1.0);
    float lit = clamp(0.55 + (dens - clamp(fbm(p + vec3(0.06, 0.09, 0.0), per, 7) * 1.9 + 0.12, 0.0, 1.0)) * 6.0, 0.0, 1.0);
    float second = clamp(fbm(vec3(st * per * 2.0, 3.7), per * 2.0, 6) * 1.8 + 0.05, 0.0, 1.0);
    fragColor = vec4(dens, lit, second, 1.0);
    return;
  }
  vec3 d = normalize(cubeFaceDir(u_face, st * 2.0 - 1.0));
  vec2 clouds = upperClouds(d);
  vec2 aurora = curtains(d);
  fragColor = vec4(clouds, aurora);
}
`;

// ---------------------------------------------------------------------------
// Draw programs
// ---------------------------------------------------------------------------

const DRAW_HEADER = `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform mat4 u_invMvp;        // pane NDC -> model space
uniform vec3 u_eye;           // camera, model space
uniform float u_pixelRatio;   // device px per CSS px
uniform vec2 u_viewport;      // pane size, device px
uniform float u_glowCenterX;  // NDC x of the presented area's centre
uniform float u_opacity;      // fade-in 0..1
uniform vec3 u_surface;       // clear colour (sRGB)
uniform float u_planar;       // 1: planar pane (virtual sky camera + near tile)
uniform vec3 u_stageCenter;
uniform vec3 u_stageExtent;
uniform float u_floorY;
uniform float u_time;         // ambient clock, seconds (frozen when still)
uniform float u_ambient;      // 1 while ambient motion runs
uniform float u_dark;         // 1: dark twin
uniform vec3 u_tint0;         // data tints, linear, luminance 1
uniform vec3 u_tint1;
uniform vec3 u_tint2;
out vec4 fragColor;
${NOISE_GLSL}
${CUBE_GLSL}
${STARS_GLSL}

vec3 toSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// Soft knee on luminance: large areas can approach but never pass cap.
vec3 kneeLuminance(vec3 c, float cap) {
  float y = luma(c);
  float target = cap * (1.0 - exp(-y / cap));
  return c * (target / max(y, 1e-7));
}
// Light twins: the floor is the mirror image, measured down from white.
vec3 floorLuminance(vec3 c, float floorY) {
  float y = luma(c);
  float lifted = 1.0 - (1.0 - floorY) * (1.0 - exp(-(1.0 - y) / (1.0 - floorY)));
  return c * (max(lifted, 0.0) / max(y, 1e-7));
}
vec3 viewRay() {
  vec4 far = u_invMvp * vec4(v_ndc, 1.0, 1.0);
  return normalize(far.xyz / far.w - u_eye);
}
// 0 at the centre of the presented area, 1 at its corners.
float vignetteRadius() {
  vec2 q = vec2(
    (v_ndc.x - u_glowCenterX) / max(1.0 - u_glowCenterX, 1e-3),
    v_ndc.y
  );
  return clamp(length(q) / 1.41421, 0.0, 1.5);
}
// The planar far layer: the sky seen through a virtual camera that turns
// slowly as the pane pans (yaw with x, a bounded pitch with y) and widens a
// little with zoom, so a pan is seamless forever.
vec3 virtualSkyRay(float pitchBias) {
  float aspect = u_viewport.x / max(u_viewport.y, 1.0);
  float zoom = clamp(pow(max(u_eye.z - u_stageCenter.z, 0.05) / 3.0, 0.12), 0.7, 1.4);
  float tanHalf = 0.42 * zoom;
  vec3 r = normalize(vec3(v_ndc.x * aspect * tanHalf, v_ndc.y * tanHalf, -1.0));
  float yaw = (u_eye.x - u_stageCenter.x) / 9.0;
  float pitch = pitchBias + 0.45 * tanh((u_eye.y - u_stageCenter.y) / 12.0);
  float cp = cos(pitch), sp = sin(pitch);
  // Pitch up: the forward axis (-z) turns toward +y.
  r = vec3(r.x, cp * r.y - sp * r.z, sp * r.y + cp * r.z);
  float cy = cos(yaw), sy = sin(yaw);
  return vec3(cy * r.x + sy * r.z, r.y, -sy * r.x + cy * r.z);
}
// Where the view ray meets the plane z = (back of the data) - depth.
vec2 planarLayer(vec3 ray, float depth) {
  float z = u_stageCenter.z - u_stageExtent.z - depth;
  float rz = abs(ray.z) < 1e-5 ? -1e-5 : ray.z;
  float t = max((z - u_eye.z) / rz, 0.0);
  return (u_eye + ray * t).xy;
}
// A horizon dip: the sky's horizon sits below the eye, as it does from
// altitude, so a camera looking down on the data still sees sky.
vec3 dipped(vec3 d, float k) {
  return normalize(d + vec3(0.0, k, 0.0));
}
// How far a view ray passes from the data, in units of the data's size:
// below 1 the ray crosses the cloud.
float stageMiss(vec3 ray) {
  vec3 toStage = u_stageCenter - u_eye;
  float along = max(dot(toStage, ray), 0.0);
  return length(toStage - ray * along) / (length(u_stageExtent) * 1.05 + 0.15);
}
// Two-hash triangular dither of about one code value.
vec3 dither(vec3 srgb, float amount) {
  float a = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float b = hash12(gl_FragCoord.xy + 71.3);
  return srgb + (a + b - 1.0) * amount / 255.0;
}
vec4 finish(vec3 linear, float grain) {
  vec3 srgb = toSrgb(linear);
  srgb = mix(u_surface, srgb, u_opacity);
  return vec4(dither(srgb, grain), 1.0);
}
// Crisp star cores of one cell layer around a direction, round on screen,
// never narrower than one device pixel.
vec3 starCores(vec3 d, float cells, float probability, float seed, float gain, float pixelAngle, float twinkle) {
  vec2 uv;
  int face = cubeFaceOf(d, uv);
  vec2 cell = floor((uv * 0.5 + 0.5) * cells);
  vec3 sd;
  vec3 star = starInCell(face, cell, cells, probability, seed, sd);
  if (star.x < 0.5) return vec3(0.0);
  float ang = length(sd - d);
  float m = pow(star.y, 3.0);
  float sigma = max(pixelAngle * 0.62, pixelAngle * u_pixelRatio * (0.38 + 0.55 * m));
  float core = exp(-0.5 * ang * ang / (sigma * sigma));
  float flicker = 1.0 + twinkle * 0.45 * sin(u_time * (1.1 + 2.3 * star.z) + 40.0 * star.y);
  return starTint(star.z) * core * (0.08 + m) * gain * flicker;
}
`;

const NEBULA_DRAW_FS = `${DRAW_HEADER}
uniform samplerCube u_sky;
uniform sampler2D u_tile;

const vec3 BAND_NORMAL = vec3(0.3283, 0.8536, -0.4048);
const vec3 DEEP = vec3(0.0011, 0.0013, 0.0034);
const vec3 BAND_LIFT = vec3(0.0042, 0.0040, 0.0062);

// Data tints graded toward the classic emission palette (H-alpha rose,
// O-III teal), so a field of warm colours never turns the sky to mud.
vec3 grade(vec3 tint, vec3 cosmic) {
  vec3 t = mix(tint, cosmic, 0.5);
  return t / max(luma(t), 1e-3);
}

// detail: fine fBm evaluated per fragment, finer than the cube's texels, so
// the clouds stay crisp at 4K and DPR 2 (-1..1, faded out where it would alias).
vec3 nebulaColour(vec4 s, float band, float detail) {
  float a = s.r * (1.0 + 0.45 * detail);
  float b = s.g * 2.0 * (1.0 + 0.6 * detail);
  float dust = clamp(s.b * (1.0 - 0.35 * detail), 0.0, 1.0);
  vec3 t0 = grade(u_tint0, vec3(1.0, 0.32, 0.45) / 0.49);
  vec3 t1 = grade(u_tint1, vec3(0.25, 0.75, 1.0) / 0.66);
  vec3 t2 = grade(u_tint2, vec3(0.75, 0.55, 1.0) / 0.62);
  vec3 col = DEEP + BAND_LIFT * band * (1.0 - 0.8 * dust);
  vec3 emission = t0 * (a * 0.012 + a * a * 0.060)
    + t1 * (b * 0.010 + b * b * 0.042)
    + t2 * a * b * 0.034
    + vec3(1.0, 0.95, 0.92) * pow(a * b, 2.0) * 0.050;
  emission *= 1.0 - 0.92 * dust;
  col *= 1.0 - 0.6 * dust;
  col += emission;
  return kneeLuminance(col, 0.042);
}

// Fine filament structure below the cube's resolution: two octaves of
// gradient noise on the sphere, faded out where a pixel spans an octave.
float nebulaDetail(vec3 d, float pixelAngle) {
  vec2 per = vec2(1e4);
  float n = gnoise(d * 22.0 + vec3(3.1, 1.7, 5.3), per) * 0.65
    + gnoise(d * 47.0 + vec3(9.2, 4.4, 0.6), per) * 0.35 * (1.0 - smoothstep(0.004, 0.012, pixelAngle));
  return n * (1.0 - smoothstep(0.012, 0.04, pixelAngle));
}

vec3 nebulaStars(vec3 d, float band, float pixelAngle, float twinkle) {
  return starCores(d, 40.0, 0.05 + 0.16 * band, 3.0, 1.0, pixelAngle, twinkle)
    + starCores(d, 130.0, 0.05 + 0.12 * band, 11.0, 0.22, pixelAngle, twinkle)
    + starCores(d, 360.0, 0.03 + 0.20 * band, 23.0, 0.05, pixelAngle * 1.4, 0.0);
}

void main() {
  vec3 ray = viewRay();
  float twinkle = u_ambient;
  // Stars dim behind the data cloud, so no star can pass for a cell.
  float behind = mix(0.35, 1.0, smoothstep(0.55, 1.5, stageMiss(ray)));
  vec3 col;
  if (u_planar < 0.5) {
    float pixelAngle = max(length(fwidth(ray)), 1e-6);
    vec3 d = ray;
    vec4 s = texture(u_sky, d);
    float band = exp(-pow(dot(d, BAND_NORMAL) / 0.34, 2.0));
    col = nebulaColour(s, band, nebulaDetail(d, pixelAngle));
    // Near layer: a dust shell around the stage, which slides against the
    // sky as the camera moves.
    vec3 oc = u_eye - u_stageCenter;
    float radius = max(7.5, length(u_stageExtent) * 3.0);
    float bq = dot(oc, ray);
    float cq = dot(oc, oc) - radius * radius;
    float disc = bq * bq - cq;
    if (disc > 0.0) {
      float t = -bq + sqrt(disc);
      vec3 shell = normalize(oc + ray * t);
      vec4 near = texture(u_sky, vec3(shell.z, shell.x, -shell.y));
      float wisp = smoothstep(0.3, 0.9, near.b) * (0.4 + 0.6 * near.r);
      col *= 1.0 - 0.45 * wisp;
    }
    float glow = s.a / max(1.0 - s.a, 1e-3);
    col += kneeLuminance(vec3(0.85, 0.90, 1.0) * glow * 0.020, 0.045) * behind;
    col += nebulaStars(d, band, pixelAngle, twinkle) * behind;
  } else {
    // Far: the sky through the virtual camera. Near: wisps and stars on a
    // plane behind the data, with true parallax.
    vec3 d = virtualSkyRay(0.0);
    float skyPixel = max(length(fwidth(d)), 1e-6);
    vec4 s = texture(u_sky, d);
    float band = exp(-pow(dot(d, BAND_NORMAL) / 0.34, 2.0));
    col = nebulaColour(s, band, nebulaDetail(d, skyPixel));
    float glow = s.a / max(1.0 - s.a, 1e-3);
    col += kneeLuminance(vec3(0.85, 0.90, 1.0) * glow * 0.020, 0.045) * behind;
    col += (starCores(d, 40.0, 0.05 + 0.16 * band, 3.0, 1.0, skyPixel, twinkle)
      + starCores(d, 130.0, 0.05 + 0.12 * band, 11.0, 0.22, skyPixel, twinkle)) * behind;
    vec2 nearUv = planarLayer(ray, 2.6) / 7.0;
    vec4 tile = texture(u_tile, nearUv);
    float wisp = smoothstep(0.3, 0.95, tile.b);
    col *= 1.0 - 0.40 * wisp;
    col += grade(u_tint0, vec3(1.0, 0.32, 0.45) / 0.49) * 0.0035 * smoothstep(0.4, 1.0, tile.r) * (1.0 - wisp);
    // Near stars on the same plane: cells in plane units.
    vec2 p = planarLayer(ray, 2.6) * 6.0;
    float px = max(length(fwidth(p)), 1e-6);
    vec2 cell = floor(p);
    float h = hash12(cell + 7.0);
    if (h < 0.05) {
      vec2 centre = cell + 0.25 + 0.5 * hash22(cell + 3.0);
      float m = pow(hash12(cell + 13.0), 3.0);
      float sigma = max(px * 0.62, px * u_pixelRatio * (0.4 + 0.5 * m));
      float dist = length(p - centre);
      float flicker = 1.0 + twinkle * 0.45 * sin(u_time * (1.3 + 24.0 * h) + 9.0 * m);
      col += starTint(hash12(cell + 29.0)) * exp(-0.5 * dist * dist / (sigma * sigma)) * (0.06 + 0.6 * m) * flicker * behind;
    }
  }
  // Vignette: the frame falls off toward its corners.
  float v = vignetteRadius();
  col *= 1.0 - 0.55 * smoothstep(0.35, 1.15, v);
  fragColor = finish(col, 1.0);
}
`;

const ATELIER_DRAW_FS = `${DRAW_HEADER}
uniform sampler2D u_shadow;    // r: cast shadow, g: ambient occlusion, 0..1
uniform vec3 u_shadowWindow;   // centre u, centre v, half size
uniform float u_shadowReady;
uniform vec3 u_keyLight;       // toward the key light, unit
uniform float u_paperGap;

const vec3 PAPER = vec3(0.880, 0.858, 0.822);   // warm paper
const vec3 KEY = vec3(1.0, 0.962, 0.900);
const vec3 FILL = vec3(0.925, 0.950, 1.0);

vec2 shadowAt(vec2 uv) {
  vec2 st = (uv - u_shadowWindow.xy) / (2.0 * u_shadowWindow.z) + 0.5;
  float inside = smoothstep(0.0, 0.04, st.x) * smoothstep(0.0, 0.04, st.y)
    * smoothstep(1.0, 0.96, st.x) * smoothstep(1.0, 0.96, st.y);
  return texture(u_shadow, st).rg * inside * u_shadowReady;
}

// Paper tooth anchored to the surface: fades out before it can alias.
float paperGrain(vec2 uv) {
  vec2 p = uv * 190.0;
  float footprint = length(fwidth(p));
  float fibres = gnoise(vec3(p * vec2(1.0, 0.35), 0.5), vec2(1e4)) * 0.6
    + gnoise(vec3(p * 2.3, 2.5), vec2(1e4)) * 0.4;
  return fibres * (1.0 - smoothstep(0.35, 0.9, footprint));
}

// A shadowed patch of paper: darker, and cooler (lit by the fill only).
vec3 applyShadow(vec3 c, vec2 s) {
  float occlusion = clamp(0.30 * s.r + 0.20 * s.g, 0.0, 0.42);
  vec3 shaded = c * mix(vec3(1.0), vec3(0.97, 0.985, 1.0), smoothstep(0.0, 0.3, occlusion));
  return shaded * (1.0 - occlusion);
}

void main() {
  vec3 ray = viewRay();
  vec3 col;
  float reach = max(max(u_stageExtent.x, u_stageExtent.z), 0.6) * 2.4;
  if (u_planar < 0.5) {
    // An infinite cyclorama: the floor sweeps up into the wall at the
    // horizon with no edge; both meet the same horizon colour.
    float height = u_eye.y - u_floorY;
    float rise = clamp(ray.y, -1.0, 1.0);
    vec2 keyDir = normalize(u_keyLight.xz + 1e-5);
    vec2 heading = normalize(ray.xz + 1e-5);
    float keySide = 0.5 + 0.5 * dot(heading, keyDir);
    vec3 horizon = PAPER * mix(FILL, KEY, keySide) * 0.90;
    // The wall: a soft key-lit sweep, brightest low on the key side, falling
    // off upward (and, seen from below the floor, downward) into a cool top.
    float sweep = exp(-pow((abs(rise) - 0.12) / 0.45, 2.0));
    float keyLobe = pow(max(dot(heading, keyDir), 0.0), 3.0);
    vec3 wall = horizon * (0.93 + 0.07 * sweep + 0.07 * keyLobe * sweep)
      * mix(vec3(1.0), FILL * 0.86, smoothstep(0.1, 1.0, abs(rise)));
    col = wall;
    // The floor point, and its grain, in uniform control flow so the
    // grain's derivatives are defined.
    float t = min(abs(height) / max(abs(rise), 1e-4), 1e4);
    vec2 uv = (u_eye + ray * t).xz;
    float grain = paperGrain(uv);
    if (rise < 0.0 && height > 0.0) {
      // A key pool on the floor, off-centre toward the light, falling away
      // to the horizon tone; the side away from the key is cooler.
      vec2 poolCentre = u_stageCenter.xz + u_keyLight.xz * reach * 0.35;
      vec2 offset = uv - poolCentre;
      float pool = exp(-dot(offset, offset) / (reach * reach));
      float wide = exp(-dot(offset, offset) / (reach * reach * 9.0));
      float side = dot(normalize(offset + 1e-5), keyDir) * smoothstep(0.0, reach, length(offset));
      vec3 lightColour = mix(FILL, KEY, 0.55 + 0.45 * side);
      vec3 floorColour = PAPER * lightColour * (0.86 + 0.08 * wide + 0.12 * pool);
      floorColour = applyShadow(floorColour, shadowAt(uv));
      floorColour *= 1.0 + 0.010 * grain;
      // The cove: the floor blends into the horizon colour as it nears
      // grazing, so floor and wall meet without an edge.
      float cove = 1.0 - smoothstep(0.0, 0.30, -rise);
      col = mix(floorColour, horizon, cove);
    } else if (rise > 0.0 && height < 0.0) {
      // Below the stage, looking up: the floor is a sheet of paper lit from
      // above, glowing through, with the data's shadow showing through it as
      // a soft, cool silhouette.
      vec2 offset = uv - (u_stageCenter.xz + u_keyLight.xz * reach * 0.35);
      float glowPool = exp(-dot(offset, offset) / (reach * reach * 2.2));
      vec3 backlit = PAPER * mix(vec3(1.0), KEY, 0.6) * (0.93 + 0.11 * glowPool);
      vec2 s = shadowAt(uv);
      float through = clamp(0.24 * s.r + 0.12 * s.g, 0.0, 0.32);
      backlit = mix(backlit, backlit * FILL * 0.92, smoothstep(0.0, 0.25, through));
      backlit *= 1.0 - through;
      backlit *= 1.0 + 0.012 * grain;
      float cove = 1.0 - smoothstep(0.0, 0.30, rise);
      col = mix(backlit, horizon, cove);
    }
  } else {
    // Paper behind the data with true parallax; the data hovers above it.
    vec2 uv = planarLayer(ray, u_paperGap);
    float grain = paperGrain(uv * 0.8);
    float extent = max(max(u_stageExtent.x, u_stageExtent.y), 0.6);
    vec2 centre = u_stageCenter.xy + vec2(-0.30, 0.38) * extent;
    vec2 offset = (uv - centre) / extent;
    float pool = exp(-dot(offset, offset) / 2.2);
    float wide = exp(-dot(offset, offset) / 14.0);
    vec2 keyDir = normalize(vec2(-0.45, 0.55));
    float side = dot(normalize(offset + 1e-5), keyDir) * smoothstep(0.0, 2.0, length(offset));
    col = PAPER * mix(FILL, KEY, 0.55 + 0.45 * side) * (0.86 + 0.08 * wide + 0.11 * pool);
    col = applyShadow(col, shadowAt(uv));
    col *= 1.0 + 0.012 * grain;
  }
  float v = vignetteRadius();
  col *= 1.0 - 0.07 * smoothstep(0.3, 1.2, v);
  col = floorLuminance(col, 0.62);
  // Fine paper grain over the whole frame doubles as the anti-banding dither.
  fragColor = finish(col, 1.6);
}
`;

const ABYSS_DRAW_FS = `${DRAW_HEADER}
uniform samplerCube u_sky;     // r: broad shafts, g: caustics, b: murk, a: fine shafts
uniform sampler2D u_tile;      // r: murk, g: caustics (periodic)

const vec3 SUN = vec3(0.2357, 0.9428, 0.2357);
const float DIP = 0.55;

vec3 water(vec3 d, vec4 s, float planarMurk) {
  float rise = d.y;
  vec3 top, horizon, depth, shaftColour, causticColour;
  if (u_dark > 0.5) {
    top = vec3(0.012, 0.050, 0.068);
    horizon = vec3(0.0035, 0.0160, 0.0250);
    depth = vec3(0.0005, 0.0018, 0.0036);
    shaftColour = vec3(0.020, 0.080, 0.085);
    causticColour = vec3(0.012, 0.050, 0.050);
  } else {
    top = vec3(0.90, 0.98, 0.96);
    horizon = vec3(0.56, 0.81, 0.83);
    depth = vec3(0.40, 0.69, 0.74);
    shaftColour = vec3(0.36, 0.28, 0.18);
    causticColour = vec3(0.20, 0.17, 0.12);
  }
  vec3 col = rise > 0.0
    ? mix(horizon, top, pow(smoothstep(0.0, 1.0, rise), 0.7))
    : mix(horizon, depth, smoothstep(0.0, 0.75, -rise));
  float murk = mix(s.b, planarMurk, u_planar);
  col *= 0.84 + 0.32 * murk;
  float shafts = s.r * 0.85 + s.a * 0.6;
  shafts *= smoothstep(-0.55, 0.15, rise);
  float sunAngle = acos(clamp(dot(d, SUN), -1.0, 1.0));
  float sunGlow = exp(-sunAngle * sunAngle / 0.20);
  if (u_dark > 0.5) {
    col += shaftColour * shafts;
    col += causticColour * s.g;
    col += shaftColour * 0.7 * sunGlow;
    col = kneeLuminance(col, 0.046);
  } else {
    col += shaftColour * shafts * 0.40;
    col += causticColour * s.g * 0.8;
    // The sunlit surface overhead, rippled: darker troughs between the
    // bright caustic crests.
    col = mix(col, col * vec3(0.84, 0.93, 0.96), (1.0 - s.g) * smoothstep(0.25, 0.8, rise) * 0.55);
    col += vec3(0.14, 0.10, 0.05) * sunGlow;
    col = floorLuminance(col, 0.62);
  }
  return col;
}

// Sunlit shallows only: a sandy floor below the stage under a caustic web,
// sliding with true parallax and fading into turquoise water.
vec3 sandFloor(vec2 uv, float distance, vec3 waterColour) {
  // Two baked web layers (tile .g and .b) drifting against each other.
  float drift = u_time * 0.02;
  float caustic = texture(u_tile, uv * 1.3 / 8.0 + vec2(drift, 0.3 * drift)).g * 0.65
    + texture(u_tile, uv * 2.3 / 5.0 + vec2(0.37 - 0.7 * drift, drift)).b * 0.35;
  float ripple = texture(u_tile, uv / 6.0).r;
  vec3 sand = vec3(0.94, 0.86, 0.70) * (0.92 + 0.10 * ripple);
  vec3 lit = sand + vec3(0.18, 0.18, 0.14) * pow(caustic, 1.5);
  // Shallow water over the sand: a light turquoise cast, deepening with distance.
  lit *= vec3(0.90, 0.98, 0.97);
  float fog = 1.0 - exp(-distance / 11.0);
  return mix(lit, waterColour, clamp(fog, 0.0, 1.0));
}

vec3 seaFloor(vec3 ray, vec3 waterColour) {
  // The sand lies under the stage, and sinks under a camera that dives
  // below the data, so there is always a sea floor beneath the viewer.
  float floorY = min(u_floorY - 1.2, u_eye.y - 1.2);
  if (u_dark > 0.5 || ray.y >= -0.01) return waterColour;
  float t = (floorY - u_eye.y) / ray.y;
  vec2 uv = (u_eye + ray * t).xz;
  return sandFloor(uv, t, waterColour);
}

void main() {
  vec3 ray = viewRay();
  vec3 col;
  vec3 tint = u_tint0 * 0.6 + u_tint1 * 0.4;
  tint /= max(luma(tint), 1e-3);
  if (u_planar < 0.5) {
    vec3 d = dipped(ray, DIP);
    vec4 s = texture(u_sky, d);
    col = water(d, s, 0.5);
    col = seaFloor(ray, col);
  } else {
    // Looking up toward the surface, where the rays converge.
    vec3 d = virtualSkyRay(0.85);
    vec4 s = texture(u_sky, d);
    vec2 near = planarLayer(ray, 3.5) / 9.0;
    vec4 tile = texture(u_tile, near);
    col = water(d, s, tile.r);
    if (u_dark > 0.5) {
      float ca = texture(u_tile, planarLayer(ray, 1.2) / 3.0).b;
      float fromTop = smoothstep(-1.2, 1.0, v_ndc.y);
      col += vec3(0.004, 0.018, 0.018) * ca * fromTop;
    } else {
      // Looking straight down into the shallows: sand under the data.
      vec2 sand = planarLayer(ray, 1.4);
      float depth = max(u_eye.z - (u_stageCenter.z - u_stageExtent.z - 1.4), 0.5);
      col = sandFloor(sand, depth * 0.6, col);
    }
  }
  // A faint bioluminescent haze behind the data, in the data's own hues.
  float miss = stageMiss(ray);
  float haze = exp(-miss * miss * 1.4);
  if (u_dark > 0.5) {
    col += mix(vec3(0.010, 0.040, 0.042), tint * 0.022, 0.5) * haze * 0.6;
  } else {
    col = mix(col, col * mix(vec3(1.0), tint, 0.08), haze * 0.7);
  }
  float v = vignetteRadius();
  col *= 1.0 - (u_dark > 0.5 ? 0.6 : 0.08) * smoothstep(0.3, 1.2, v);
  fragColor = finish(col, u_dark > 0.5 ? 1.0 : 1.4);
}
`;

const AURORA_DRAW_FS = `${DRAW_HEADER}
uniform samplerCube u_sky;    // r: cloud opacity, g: cloud lit, b: curtain, a: curtain height
uniform sampler2D u_tile;     // r: cloud density, g: top-lit, b: second layer

const vec3 SUN = vec3(0.7894, 0.1105, -0.6039);
const float DIP = 0.55;

vec3 sky(vec3 d, vec4 s, float pixelAngle, float behind) {
  float rise = d.y;
  float sunAngle = acos(clamp(dot(d, SUN), -1.0, 1.0));
  vec3 col;
  if (u_dark > 0.5) {
    vec3 zenith = vec3(0.0010, 0.0017, 0.0050);
    vec3 horizon = vec3(0.0055, 0.0085, 0.0165);
    col = mix(horizon, zenith, pow(smoothstep(0.0, 1.0, abs(rise)), 0.6));
    // Moon haze where the sun would be.
    col += vec3(0.010, 0.013, 0.020) * exp(-sunAngle / 0.35);
    // Stars, hidden behind clouds and fading into the horizon haze.
    float starVis = (1.0 - 0.6 * s.r) * smoothstep(0.02, 0.25, rise) * behind;
    col += starCores(d, 120.0, 0.14, 41.0, 0.22, pixelAngle, u_ambient) * starVis;
    col += starCores(d, 44.0, 0.10, 7.0, 0.85, pixelAngle, u_ambient) * starVis;
    // The curtains: green at the foot, violet into the top; the data's
    // hue nudges the green.
    vec3 green = mix(vec3(0.020, 0.115, 0.060), u_tint0 * 0.08, 0.2);
    vec3 violet = mix(vec3(0.055, 0.018, 0.090), u_tint1 * 0.06, 0.2);
    vec3 aurora = mix(green, violet, smoothstep(0.12, 0.55, s.a)) * s.b * 1.8;
    // Airglow: a faint green band along the horizon under the curtains.
    col += vec3(0.002, 0.007, 0.004) * exp(-abs(rise) / 0.08);
    // Night clouds are thin veils: the curtains show through them.
    float veil = s.r * 0.6;
    col += aurora * (1.0 - 0.6 * veil);
    // Night clouds: dark, rimmed by aurora light.
    vec3 cloud = vec3(0.0028, 0.0038, 0.0068) + green * 0.22 * s.g;
    col = mix(col, cloud, veil * 0.85);
    col = kneeLuminance(col, 0.046);
  } else {
    vec3 zenith = vec3(0.50, 0.65, 0.92);
    vec3 horizon = vec3(1.0, 0.82, 0.66);
    col = mix(horizon, zenith, pow(smoothstep(0.0, 1.0, max(rise, 0.0)), 0.5));
    // A rose band just above the horizon, as at dawn.
    col += vec3(0.10, 0.015, 0.06) * exp(-pow((rise - 0.10) / 0.09, 2.0));
    // Sun haze: a wide warm bloom and a soft core.
    col += vec3(0.30, 0.15, 0.03) * exp(-sunAngle / 0.38);
    col += vec3(0.30, 0.24, 0.14) * exp(-sunAngle * sunAngle / 0.004);
    // Clouds lit pink-gold on the sun side, lavender in their shade.
    float sunSide = 0.5 + 0.5 * dot(normalize(d.xz + 1e-5), normalize(SUN.xz));
    vec3 litColour = mix(vec3(1.0, 0.96, 0.97), vec3(1.0, 0.85, 0.70), sunSide * sunSide);
    vec3 shadeColour = vec3(0.62, 0.62, 0.80);
    vec3 cloud = mix(shadeColour, litColour, smoothstep(0.15, 0.85, s.g));
    col = mix(col, cloud, clamp(s.r * 1.25, 0.0, 0.95));
    col = floorLuminance(col, 0.62);
  }
  return col;
}

// The sea of clouds below the horizon: two world-anchored tiles on planes
// under the stage, so it slides with parallax; it melts into the haze.
vec3 cloudSea(vec3 d, vec3 haze) {
  // Under the stage, and always under the camera: seen from below the data
  // the sea of clouds stays below the horizon.
  float seaY = min(u_floorY - 2.5, u_eye.y - 2.0);
  float drop = max(u_eye.y - seaY, 0.5);
  float t = drop / max(-d.y, 1e-3);
  vec2 uv = u_eye.xz + d.xz * t;
  vec4 a = texture(u_tile, uv / 14.0);
  vec4 b = texture(u_tile, uv / 5.5 + 0.31);
  float dens = smoothstep(0.18, 0.70, a.r * 0.75 + b.b * 0.35);
  float lit = mix(a.g, b.g, 0.35);
  float fog = 1.0 - exp(-t / 26.0);
  vec3 col;
  if (u_dark > 0.5) {
    vec3 gap = vec3(0.0016, 0.0024, 0.0052);
    vec3 top = vec3(0.0050, 0.0085, 0.0125) + vec3(0.003, 0.020, 0.011) * lit;
    col = mix(gap, top, dens);
  } else {
    vec3 gap = vec3(0.64, 0.68, 0.84);
    float sunSide = 0.5 + 0.5 * dot(normalize(d.xz + 1e-5), normalize(SUN.xz));
    vec3 top = mix(vec3(0.76, 0.75, 0.86), mix(vec3(1.0, 0.96, 0.94), vec3(1.0, 0.88, 0.76), sunSide), smoothstep(0.2, 0.8, lit));
    col = mix(gap, top, dens);
  }
  return mix(col, haze, clamp(fog, 0.0, 1.0));
}

void main() {
  vec3 ray = viewRay();
  vec3 col;
  float behind = mix(0.35, 1.0, smoothstep(0.55, 1.5, stageMiss(ray)));
  if (u_planar < 0.5) {
    vec3 d = dipped(ray, DIP);
    float pixelAngle = max(length(fwidth(d)), 1e-6);
    vec4 s = texture(u_sky, d);
    vec3 skyColour = sky(d, s, pixelAngle, behind);
    if (d.y >= 0.0) {
      col = skyColour;
    } else {
      vec3 horizonDir = normalize(vec3(d.x, 0.004, d.z));
      vec3 haze = sky(horizonDir, texture(u_sky, horizonDir), pixelAngle, 0.0);
      col = cloudSea(d, haze);
    }
  } else {
    vec3 d = virtualSkyRay(0.30);
    float pixelAngle = max(length(fwidth(d)), 1e-6);
    vec4 s = texture(u_sky, d);
    col = sky(d, s, pixelAngle, behind);
    // A drifting cloud layer on a plane behind the data.
    vec2 near = planarLayer(ray, 3.2) / 8.0;
    vec4 tile = texture(u_tile, near);
    float dens = smoothstep(0.42, 0.95, tile.r) * smoothstep(-1.1, 0.4, v_ndc.y);
    vec3 cloud = u_dark > 0.5
      ? vec3(0.0035, 0.0050, 0.0085) + vec3(0.002, 0.014, 0.008) * tile.g
      : mix(vec3(0.78, 0.77, 0.85), vec3(1.0, 0.94, 0.89), tile.g);
    col = mix(col, cloud, dens * 0.55);
  }
  float v = vignetteRadius();
  col *= 1.0 - (u_dark > 0.5 ? 0.5 : 0.07) * smoothstep(0.3, 1.2, v);
  fragColor = finish(col, u_dark > 0.5 ? 1.0 : 1.4);
}
`;

// ---------------------------------------------------------------------------
// Marine snow (Abyss): point sprites around the stage and around the camera.
// ---------------------------------------------------------------------------

const MOTE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_seed;   // xyz: -1..1, w: 0..1 (population, size)
uniform mat4 u_mvp;
uniform vec3 u_eye;
uniform vec3 u_stageCenter;
uniform vec3 u_stageExtent;
uniform float u_projScale;     // projection[5]
uniform float u_viewportHeight;
uniform float u_pixelRatio;
uniform float u_time;
uniform float u_planar;
uniform float u_maxPointSize;
uniform vec4 u_ndcTransform;   // pane NDC = raster NDC * xy + zw (see COMMON_VS)
out float v_glow;
out float v_alpha;
out float v_hue;
out float v_blur;
void main() {
  vec3 ext = max(u_stageExtent, vec3(0.25));
  vec3 pos;
  float attendant = step(a_seed.w, 0.28);
  float drift = u_time * (0.010 + 0.012 * fract(a_seed.w * 7.0));
  float boxFade = 1.0;
  if (attendant > 0.5) {
    // Attendants: a loose shell hugging the data cloud.
    vec3 dir = normalize(a_seed.xyz + 1e-4);
    float r = 0.9 + 0.9 * fract(a_seed.w * 13.7);
    pos = u_stageCenter + dir * ext * r * 1.2;
    pos.y -= mod(drift, 0.6) - 0.3;
  } else {
    // Ambient: a box that wraps around the camera, so the snow never ends.
    float box = 12.0;
    vec3 p = a_seed.xyz * box * 0.5;
    p.y -= drift * 3.0;
    vec3 rel = mod(p - u_eye + box * 0.5, box) - box * 0.5;
    pos = u_eye + rel;
    boxFade = 1.0 - smoothstep(0.30, 0.5, max(max(abs(rel.x), abs(rel.y)), abs(rel.z)) / box);
  }
  if (u_planar > 0.5) {
    // Keep planar snow behind the data plane.
    float back = u_stageCenter.z - u_stageExtent.z - 0.15;
    pos.z = min(pos.z, back - 0.05 - 3.0 * fract(a_seed.w * 31.3));
  }
  vec4 clip = u_mvp * vec4(pos, 1.0);
  float worldSize = 0.006 + 0.012 * fract(a_seed.w * 53.1);
  float size = worldSize * u_projScale * u_viewportHeight * 0.5 / max(clip.w, 1e-3);
  float minimum = 1.0 * u_pixelRatio;
  float device = max(size, minimum);
  // Near motes turn into soft bokeh: bigger, blurrier, fainter.
  float blur = smoothstep(1.6, 0.3, clip.w);
  float bokeh = device * (1.0 + 5.0 * blur);
  float drawn = min(bokeh * 2.6, u_maxPointSize);
  gl_PointSize = drawn;
  // Into the target's own clip space (identity on screen).
  gl_Position = vec4((clip.xy - u_ndcTransform.zw * clip.w) / u_ndcTransform.xy, clip.zw);
  // Energy kept roughly constant as a mote grows; dimmed when below 1 px.
  float coverage = clamp(size / minimum, 0.2, 1.0) * (device * device) / (bokeh * bokeh);
  vec3 rel = (pos - u_stageCenter) / (ext * 1.1 + 0.15);
  float spread = length(rel);
  v_glow = exp(-max(spread - 0.8, 0.0) * 2.2);
  float tooNear = smoothstep(0.12, 0.45, clip.w);
  v_alpha = coverage * tooNear * boxFade * (clip.w > 0.0 ? 1.0 : 0.0);
  v_hue = fract(a_seed.w * 97.3);
  v_blur = blur;
}
`;

const MOTE_FS = `#version 300 es
precision highp float;
in float v_glow;
in float v_alpha;
in float v_hue;
in float v_blur;
uniform float u_dark;
uniform float u_opacity;
uniform vec3 u_tint0;
uniform vec3 u_tint1;
out vec4 fragColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c) * 6.76;     // sprite is 2.6x the mote
  float sharpness = mix(2.2, 0.55, v_blur);
  float core = exp(-r2 * sharpness);
  float halo = exp(-r2 * 0.35) * 0.25;
  vec3 tint = mix(u_tint0, u_tint1, step(0.5, v_hue));
  tint /= max(dot(tint, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
  if (u_dark > 0.5) {
    // Additive light: faint cyan snow that blooms in the data's hues
    // near the cloud.
    vec3 snow = vec3(0.09, 0.20, 0.22);
    vec3 bloom = mix(vec3(0.15, 0.85, 0.85), tint * 0.5, 0.55);
    vec3 col = snow * core * 0.32 + bloom * (core + halo) * v_glow * 0.22;
    fragColor = vec4(sqrt(col) * 0.55 * v_alpha * u_opacity, 1.0);
  } else {
    // Sunlit specks: soft and slightly darker; near the data they catch its hue.
    vec3 speck = mix(vec3(0.42, 0.56, 0.57), sqrt(tint * 0.25), v_glow * 0.6);
    float a = (core * 0.22 + halo * 0.10 * v_glow) * v_alpha * u_opacity;
    fragColor = vec4(speck * a, a);
  }
}
`;

export const BACKDROP_LOOK_PROGRAMS = Object.freeze({
  'bake:nebula': Object.freeze({ vs: COMMON_VS, fs: NEBULA_BAKE_FS }),
  'bake:abyss': Object.freeze({ vs: COMMON_VS, fs: ABYSS_BAKE_FS }),
  'bake:aurora': Object.freeze({ vs: COMMON_VS, fs: AURORA_BAKE_FS }),
  'draw:nebula': Object.freeze({ vs: COMMON_VS, fs: NEBULA_DRAW_FS }),
  'draw:atelier': Object.freeze({ vs: COMMON_VS, fs: ATELIER_DRAW_FS }),
  'draw:abyss': Object.freeze({ vs: COMMON_VS, fs: ABYSS_DRAW_FS }),
  'draw:aurora': Object.freeze({ vs: COMMON_VS, fs: AURORA_DRAW_FS }),
  'draw:motes': Object.freeze({ vs: MOTE_VS, fs: MOTE_FS }),
});
