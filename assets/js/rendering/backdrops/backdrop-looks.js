/**
 * Backdrop looks: the procedural backgrounds behind the data, beyond the
 * plain, grid and studio ones.
 *
 * There are six variants in three families, each with a light and a dark twin:
 *
 * | Id            | Family  | Tone  | What it is                                         |
 * | ------------- | ------- | ----- | -------------------------------------------------- |
 * | `atelier`     | atelier | light | Infinite paper cyclorama with a baked contact shadow |
 * | `nebula`      | atelier | dark  | Deep-field nebula skybox, tinted by the data colours |
 * | `abyss`       | abyss   | light | Sunlit shallows: rays, caustics, drifting motes    |
 * | `abyss-dark`  | abyss   | dark  | Deep ocean: god rays and glowing marine snow       |
 * | `aurora`      | aurora  | light | Aurora Dawn: high-key sky, clouds and sun haze     |
 * | `aurora-dark` | aurora  | dark  | Night aurora over a sea of clouds                  |
 *
 * Atelier and Nebula form one family (the light and the dark pole of the
 * "deep field / studio" idea); they share nothing on the GPU.
 *
 * THE DATA STAYS THE HERO
 * The category palettes span CIE L* 41..90 (`data/palettes.js`, the first 24
 * category colours). Every look keeps its large areas outside that band:
 * dark looks below `DARK_BAND_MAX_LSTAR`, light looks above
 * `LIGHT_BAND_MIN_LSTAR`. Only point-like highlights (star cores, motes) may
 * cross it, and they cover a negligible fraction of the frame. Twins share
 * the same contrast budget: about 14 units of L* across a frame.
 *
 * Everything in this file is pure: no WebGL, no DOM, no viewer state.
 */

/** Large areas of a dark look stay at or below this L*. */
export const DARK_BAND_MAX_LSTAR = 24;
/** Large areas of a light look stay at or above this L*. */
export const LIGHT_BAND_MIN_LSTAR = 86;

/** Seconds a look takes to fade in once its bake has landed. */
export const BACKDROP_LOOK_FADE_SECONDS = 0.35;
/** Ambient motion (twinkle, mote drift) is capped at this frame rate. */
export const BACKDROP_AMBIENT_MAX_HZ = 30;

/**
 * One look.
 *
 * - `surface`: exact 8-bit sRGB colour of the canvas clear, the CSS page and
 *   the look before its bake lands.
 * - `defaultTints`: sRGB 0..1 tints used before (or without) data colours.
 *
 * Figure export redraws a look with the same renderer from the screen's
 * frozen state (`components/backdrop-look-export.js`).
 */
export const BACKDROP_LOOKS = Object.freeze({
  atelier: Object.freeze({
    id: 'atelier',
    family: 'atelier',
    program: 'atelier',
    tone: 'light',
    label: 'Atelier (light)',
    surface: Object.freeze([238, 235, 230]),
    defaultTints: Object.freeze([
      Object.freeze([0.55, 0.52, 0.48]),
      Object.freeze([0.50, 0.52, 0.56]),
      Object.freeze([0.52, 0.50, 0.50]),
    ]),
  }),
  nebula: Object.freeze({
    id: 'nebula',
    family: 'atelier',
    program: 'nebula',
    tone: 'dark',
    label: 'Nebula (dark)',
    surface: Object.freeze([7, 8, 14]),
    defaultTints: Object.freeze([
      Object.freeze([0.36, 0.42, 0.95]),
      Object.freeze([0.85, 0.32, 0.62]),
      Object.freeze([0.20, 0.75, 0.80]),
    ]),
  }),
  abyss: Object.freeze({
    id: 'abyss',
    family: 'abyss',
    program: 'abyss',
    tone: 'light',
    label: 'Abyss (light)',
    surface: Object.freeze([214, 234, 234]),
    defaultTints: Object.freeze([
      Object.freeze([0.20, 0.70, 0.75]),
      Object.freeze([0.30, 0.55, 0.85]),
      Object.freeze([0.55, 0.80, 0.60]),
    ]),
  }),
  'abyss-dark': Object.freeze({
    id: 'abyss-dark',
    family: 'abyss',
    program: 'abyss',
    tone: 'dark',
    label: 'Abyss (dark)',
    surface: Object.freeze([3, 14, 21]),
    defaultTints: Object.freeze([
      Object.freeze([0.15, 0.85, 0.85]),
      Object.freeze([0.25, 0.55, 1.00]),
      Object.freeze([0.45, 1.00, 0.70]),
    ]),
  }),
  aurora: Object.freeze({
    id: 'aurora',
    family: 'aurora',
    program: 'aurora',
    tone: 'light',
    label: 'Aurora (light)',
    surface: Object.freeze([236, 234, 236]),
    defaultTints: Object.freeze([
      Object.freeze([1.00, 0.72, 0.55]),
      Object.freeze([0.62, 0.72, 0.95]),
      Object.freeze([0.95, 0.65, 0.75]),
    ]),
  }),
  'aurora-dark': Object.freeze({
    id: 'aurora-dark',
    family: 'aurora',
    program: 'aurora',
    tone: 'dark',
    label: 'Aurora (dark)',
    surface: Object.freeze([6, 10, 22]),
    defaultTints: Object.freeze([
      Object.freeze([0.25, 1.00, 0.60]),
      Object.freeze([0.65, 0.35, 1.00]),
      Object.freeze([0.20, 0.80, 0.95]),
    ]),
  }),
});

/** Every look id, in menu order within its tone. */
export const BACKDROP_LOOK_IDS = Object.freeze(Object.keys(BACKDROP_LOOKS));

/**
 * @param {unknown} value
 * @returns {value is keyof typeof BACKDROP_LOOKS}
 */
export function isBackdropLook(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BACKDROP_LOOKS, value);
}

/** A look's surface colour as the 0..1 triple WebGL takes. */
export function backdropLookSurface01(id) {
  const rgb = BACKDROP_LOOKS[id].surface;
  return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

/** sRGB channel (0..1) to linear. */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a linear RGB triple. */
export function linearLuminance(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/** CIE L* of an sRGB 0..1 triple. */
export function lstarOfSrgb(rgb) {
  const y = linearLuminance(rgb.map(srgbToLinear));
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}

/**
 * A data colour shaped into a backdrop tint: its hue kept, its saturation
 * scaled by `saturation`, its luminance normalised to 1, in linear RGB. The
 * shader scales it to the look's own brightness, so a tint can never push a
 * large area into the palette band.
 *
 * @param {readonly number[]} srgb - 0..1
 * @param {number} saturation - 0 (grey) .. 1 (the colour's own)
 * @param {number[]} [out]
 * @returns {number[]}
 */
export function shapeBackdropTint(srgb, saturation, out = [0, 0, 0]) {
  const linear = [srgbToLinear(srgb[0]), srgbToLinear(srgb[1]), srgbToLinear(srgb[2])];
  const y = Math.max(linearLuminance(linear), 1e-4);
  for (let i = 0; i < 3; i++) {
    const normalized = linear[i] / y;
    out[i] = 1 + (normalized - 1) * saturation;
  }
  // Renormalise: mixing with grey keeps luminance at 1 only approximately.
  const y2 = Math.max(linearLuminance(out), 1e-4);
  for (let i = 0; i < 3; i++) out[i] = Math.max(0, out[i] / y2);
  return out;
}

/**
 * The dominant colours of a view's points: a weighted 5-bit-per-channel
 * histogram over at most `maxSamples` evenly strided visible points, peaks
 * picked greedily with neighbouring bins suppressed, so three distinct
 * colours come back even when one category dominates. Near-grey colours
 * (the "unassigned" greys) are down-weighted.
 *
 * Pure and allocation-bounded: one 32768-bin Float32Array.
 *
 * @param {Uint8Array} colors - RGBA per point
 * @param {Uint8Array|null} visibility - per-point transparency, exactly 0
 *   (filtered out) or 1 (shown)
 * @param {number} [count]
 * @param {number} [maxSamples]
 * @returns {{ colors: number[][]; weights: number[]; sampled: number }}
 */
export function extractDominantColors(colors, visibility, count = 3, maxSamples = 65536) {
  const pointCount = Math.floor(colors.length / 4);
  const histogram = new Float32Array(32768);
  const sums = new Float32Array(32768 * 3);
  const stride = Math.max(1, Math.floor(pointCount / maxSamples));
  let sampled = 0;
  for (let i = 0; i < pointCount; i += stride) {
    // Point transparency is exactly 0 (filtered out) or 1 (shown).
    if (visibility === null ? colors[i * 4 + 3] === 0 : visibility[i] === 0) continue;
    const r = colors[i * 4];
    const g = colors[i * 4 + 1];
    const b = colors[i * 4 + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    // Chroma weighting: greys say little about the field's hue.
    const chroma = (max - min) / 255;
    const weight = 0.15 + chroma;
    const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    histogram[bin] += weight;
    sums[bin * 3] += r * weight;
    sums[bin * 3 + 1] += g * weight;
    sums[bin * 3 + 2] += b * weight;
    sampled += 1;
  }
  const picked = [];
  const weights = [];
  for (let k = 0; k < count; k++) {
    let best = -1;
    let bestWeight = 0;
    for (let bin = 0; bin < 32768; bin++) {
      if (histogram[bin] > bestWeight) {
        bestWeight = histogram[bin];
        best = bin;
      }
    }
    if (best < 0) break;
    const w = histogram[best];
    picked.push([
      sums[best * 3] / w / 255,
      sums[best * 3 + 1] / w / 255,
      sums[best * 3 + 2] / w / 255,
    ]);
    weights.push(w);
    // Suppress the neighbourhood so the next pick is a distinct colour.
    const br = best >> 10;
    const bg = (best >> 5) & 31;
    const bb = best & 31;
    const radius = 5;
    for (let r = Math.max(0, br - radius); r <= Math.min(31, br + radius); r++) {
      for (let g = Math.max(0, bg - radius); g <= Math.min(31, bg + radius); g++) {
        for (let b = Math.max(0, bb - radius); b <= Math.min(31, bb + radius); b++) {
          histogram[(r << 10) | (g << 5) | b] = 0;
        }
      }
    }
  }
  return { colors: picked, weights, sampled };
}

// ---------------------------------------------------------------------------
// Contact shadow (Atelier)
// ---------------------------------------------------------------------------

/** Resolution of the baked contact-shadow / AO map (texels per side). */
export const SHADOW_MAP_SIZE = 512;

/**
 * Direction toward the key light (unit, model space): high, from the front
 * left. The shadow falls back and to the right of the data.
 */
export const ATELIER_KEY_LIGHT = Object.freeze((() => {
  const v = [-0.42, 1.0, 0.38];
  const length = Math.hypot(v[0], v[1], v[2]);
  return v.map((c) => c / length);
})());

/**
 * The floor window the shadow map covers, from the pane geometry
 * (`resolveStudioPaneGeometry`): centred on the stage, wide enough for the
 * cast shadow of the highest cell and the blur. For a flat pane the "floor"
 * is the paper plane behind the data and the map is in x/y.
 *
 * @returns {{ centerU: number; centerV: number; halfSize: number }}
 */
export function resolveShadowWindow(geometry) {
  if (geometry.flat) {
    const half = Math.max(geometry.extentX, geometry.extentY) * 1.35 + 0.25;
    return { centerU: geometry.stageX, centerV: geometry.centerY, halfSize: half };
  }
  const height = geometry.extentY * 2 + 0.12;
  const reach = height * Math.hypot(ATELIER_KEY_LIGHT[0], ATELIER_KEY_LIGHT[2]) / ATELIER_KEY_LIGHT[1];
  const half = Math.max(geometry.extentX, geometry.extentZ) * 1.25 + reach + 0.35;
  return { centerU: geometry.stageX, centerV: geometry.stageZ, halfSize: half };
}

/** Paper depth behind a flat embedding's data plane (data units). */
export const ATELIER_PAPER_GAP = 0.32;
