/**
 * Category colors and visibility as the app holds them
 * (`assets/js/app/utils/category-state.js`: RGB bytes, three a category, and
 * a byte a category, 1 shown), made from and read back as the lists a test
 * writes.
 */

/** RGB bytes from `[r, g, b]` triplets with channels from 0 to 1. */
export function colorsOf(rgbList) {
  const bytes = new Uint8Array(rgbList.length * 3);
  rgbList.forEach((rgb, index) => {
    for (let channel = 0; channel < 3; channel++) bytes[index * 3 + channel] = Math.round(rgb[channel] * 255);
  });
  return bytes;
}

/** Visibility bytes from booleans (or an object of booleans by index). */
export function visibleOf(flags) {
  const list = Array.isArray(flags) ? flags : Object.keys(flags).sort((a, b) => a - b).map(key => flags[key]);
  return Uint8Array.from(list, flag => (flag ? 1 : 0));
}

/** A field's colors as `[r, g, b]` triplets, channels from 0 to 1 (bytes over 255). */
export function rgbListOf(field) {
  const colors = field._categoryColors;
  return Array.from({ length: colors.length / 3 }, (_, index) => [colors[index * 3] / 255, colors[index * 3 + 1] / 255, colors[index * 3 + 2] / 255]);
}

/** A field's colors as byte triplets. */
export function byteListOf(field) {
  const colors = field._categoryColors;
  return Array.from({ length: colors.length / 3 }, (_, index) => [colors[index * 3], colors[index * 3 + 1], colors[index * 3 + 2]]);
}

/** A field's visibility as booleans. */
export function visibleListOf(field) {
  return Array.from(field._categoryVisible, flag => flag === 1);
}

/** Category `index`'s color of `field`, channels from 0 to 1 (its bytes over 255). */
export function rgbAt(field, index) {
  return rgbListOf(field)[index];
}

/** `[r, g, b]` as a category holds it: each channel to its byte, over 255. */
export function drawn(rgb) {
  return rgb.map(channel => Math.round(channel * 255) / 255);
}
