/**
 * @fileoverview When two colors can be told apart, and the color a new or
 * inherited category takes so that it can be: one rule for every place the
 * app gives a category or a highlight page a color of its own choosing.
 *
 * Distance is Euclidean in OKLab (Ottosson 2020), a perceptually uniform
 * space: equal distances look about equally different across hues and
 * lightness, which RGB distances do not (gold and orange are far apart in
 * RGB, close to the eye). Two colors closer than
 * `MIN_DISTINCT_COLOR_DISTANCE` are taken for one. The threshold is 0.08,
 * measured on the colors the app has: an inherited amber (#ECB100) and a
 * bright orange (#FF9900) are 0.063 apart, the default highlight pages' red and rose
 * (#dc2626, #e11d48) 0.039, purple and violet 0.044, green and lime 0.057;
 * red and orange pages (#dc2626, #ea580c), which read as two, are 0.087
 * apart, and the ten colors of Scanpy's default palette (Matplotlib's tab10,
 * the palette most files carry) at least 0.131, so a field colored by it
 * keeps every color.
 *
 * Where it applies (each says why in its own module):
 * - a grouped field's groups inherit their first category's color only when
 *   it stays apart from the colors kept and given before
 *   (`categorical-ops.js` `carryCategoryStateThroughGroup`);
 * - a category a field gains (Unassigned after a deletion, a label a
 *   relabel adds) and a field made from highlight pages' categories beyond
 *   its pages (`category-state.js` `carriedCategoryState`,
 *   `user-defined-fields.js` `pageFieldPalette`, `overlay-internals.js`);
 * - a new highlight page (`highlight-manager.js`).
 *
 * It does not apply to a file's categories opening in Cellucid's category
 * sequence by their place (`palettes.js` `getCategoryColor`): a category's
 * color there must not depend on which others were found first, so a share
 * of the cells and all of them show it alike. Nor does it change a color a
 * person or a file chose: those stay, and the colors given are kept apart
 * from them.
 *
 * @module data/distinct-colors
 */

import { getCategoryColor, getCategoryColorSeedCount } from './palettes.js';

/** OKLab distance below which two colors are taken for one. */
export const MIN_DISTINCT_COLOR_DISTANCE = 0.08;

const toLinear = channel => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);

/**
 * An sRGB color (channels from 0 to 1) in OKLab.
 *
 * @param {ArrayLike<number>} rgb
 * @returns {[number, number, number]} L, a, b
 */
function oklabOf(rgb) {
  const r = toLinear(rgb[0]);
  const g = toLinear(rgb[1]);
  const b = toLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995289 * g + 0.1073969729 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  ];
}

/**
 * How different two sRGB colors (channels from 0 to 1) look: their OKLab
 * distance.
 *
 * @param {ArrayLike<number>} first
 * @param {ArrayLike<number>} second
 * @returns {number}
 */
export function colorDistance(first, second) {
  const a = oklabOf(first);
  const b = oklabOf(second);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function nearest(color, taken) {
  let closest = Infinity;
  for (const other of taken) closest = Math.min(closest, colorDistance(color, other));
  return closest;
}

/**
 * Whether `color` can be told apart from every color in `taken`.
 *
 * @param {ArrayLike<number>} color
 * @param {Iterable<ArrayLike<number>>} taken
 * @returns {boolean}
 */
export function isDistinctColor(color, taken) {
  return nearest(color, taken) >= MIN_DISTINCT_COLOR_DISTANCE;
}

/**
 * The color a category (or page) takes beside `taken`: `preferred` (the one
 * it inherits, or the palette's of its place) when it can be told apart from
 * every taken color, else the first color of `sequence` that can, in the
 * sequence's order. The sequence is searched through its designed colors and
 * as many of the colors after them as there are taken ones and more; when
 * none of those can be told apart (more colors than the eye separates), the
 * one farthest from the taken colors. A fresh `[r, g, b]` the caller owns.
 *
 * @param {ReadonlyArray<ArrayLike<number>>} taken - Colors in use, channels 0 to 1
 * @param {ArrayLike<number>|null} preferred
 * @param {(index: number) => ArrayLike<number>} [sequence] - Cellucid's category colors by default
 * @param {number} [designed] - How many of `sequence`'s colors are designed (searched first)
 * @returns {[number, number, number]}
 */
export function distinctColor(taken, preferred, sequence = getCategoryColor, designed = getCategoryColorSeedCount()) {
  if (preferred !== null && isDistinctColor(preferred, taken)) return [preferred[0], preferred[1], preferred[2]];
  const candidates = designed + 2 * taken.length + 2;
  let best = null;
  let bestDistance = -1;
  for (let index = 0; index < candidates; index++) {
    const candidate = sequence(index);
    const distance = nearest(candidate, taken);
    if (distance >= MIN_DISTINCT_COLOR_DISTANCE) return [candidate[0], candidate[1], candidate[2]];
    if (distance > bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return [best[0], best[1], best[2]];
}

/**
 * Give every category `settle(index)` marks a color that can be told apart
 * from the others, in place: the categories it does not mark keep theirs
 * (a person's or a file's choice); each marked one, in index order, keeps
 * its color when it can be told apart from the kept ones and the marked ones
 * before it, else takes `distinctColor`'s.
 *
 * @param {Uint8Array} colors - RGB bytes, three a category
 * @param {(index: number) => boolean} settle
 * @returns {Uint8Array} `colors`
 */
export function settleDistinctCategoryColors(colors, settle) {
  const count = colors.length / 3;
  const rgbAt = index => [colors[index * 3] / 255, colors[index * 3 + 1] / 255, colors[index * 3 + 2] / 255];
  const taken = [];
  const settled = [];
  for (let index = 0; index < count; index++) {
    if (settle(index)) settled.push(index);
    else taken.push(rgbAt(index));
  }
  for (const index of settled) {
    const color = distinctColor(taken, rgbAt(index));
    colors[index * 3] = Math.round(color[0] * 255);
    colors[index * 3 + 1] = Math.round(color[1] * 255);
    colors[index * 3 + 2] = Math.round(color[2] * 255);
    taken.push(color);
  }
  return colors;
}
