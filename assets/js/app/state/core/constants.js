/**
 * @fileoverview State-layer shared constants.
 *
 * Keep small constants here when they are used across multiple state modules.
 *
 * @module state/core/constants
 */

/**
 * Light gray default when no field is selected (0-255).
 * Used by categorical coloring paths.
 */
export const NEUTRAL_GRAY_UINT8 = 211;


/**
 * Fill an RGBA8 color array with opaque neutral gray, one 32-bit word a cell.
 *
 * Color arrays start on a 4-byte boundary (the renderer requires it), so the
 * fill is one typed-array `fill` instead of four byte stores a cell; the word
 * is built from its own bytes, so platform byte order is moot.
 *
 * @param {Uint8Array} colors - RGBA8, word-aligned.
 * @returns {Uint8Array} `colors`.
 */
export function fillNeutralGray(colors) {
  if (colors.byteOffset % 4 !== 0 || colors.length % 4 !== 0) {
    throw new TypeError('Neutral gray fill requires a word-aligned RGBA8 array.');
  }
  const word = new Uint32Array(
    Uint8Array.of(NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, 255).buffer
  )[0];
  new Uint32Array(colors.buffer, colors.byteOffset, colors.length >>> 2).fill(word);
  return colors;
}
