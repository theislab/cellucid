/**
 * Color Utilities (Small, UI-focused)
 *
 * Provides minimal helpers for deriving visually related colors
 * (e.g., for "Rest of <Page>" derived pages).
 *
 * @module shared/color-utils
 */

/**
 * Parse a hex color (#RRGGBB) into RGB ints.
 * @param {string} hex
 * @returns {{r: number, g: number, b: number} | null}
 */
export function parseHexColor(hex) {
  if (typeof hex !== 'string') return null;
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!match) return null;
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16)
  };
}

/**
 * Convert RGB ints (0-255) to #RRGGBB.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string}
 */
export function rgbToHex(r, g, b) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const toHex = (v) => clamp(v).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Mix two hex colors.
 * @param {string} hexA
 * @param {string} hexB
 * @param {number} t - 0..1, where 0 => A, 1 => B
 * @returns {string}
 */
export function mixHex(hexA, hexB, t) {
  const a = parseHexColor(hexA);
  const b = parseHexColor(hexB);
  if (!a || !b) return typeof hexA === 'string' ? hexA : '#888888';
  const tt = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0.5;
  return rgbToHex(
    a.r + (b.r - a.r) * tt,
    a.g + (b.g - a.g) * tt,
    a.b + (b.b - a.b) * tt
  );
}

/**
 * Derive a visually-related "rest-of" color from a base color.
 * Default strategy: mix base with white.
 * @param {string} baseHex
 * @param {Object} [options]
 * @param {number} [options.mix=0.55] - 0..1 mix ratio towards white
 * @returns {string}
 */
export function deriveRestOfColor(baseHex, options = {}) {
  const { mix = 0.55 } = options;
  return mixHex(baseHex, '#ffffff', mix);
}

/**
 * Default qualitative color palette for categorical data.
 * Based on D3's category10/category20 for good visual distinction.
 */
export const CATEGORY_PALETTE = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
  '#aec7e8', '#ffbb78', '#98df8a', '#ff9896', '#c5b0d5'
];

/**
 * Generate a color map for categorical values.
 * Assigns consistent colors from a qualitative palette.
 *
 * @param {string[]} categories - Array of category names
 * @param {Object} [options]
 * @param {string[]} [options.palette] - Custom color palette (defaults to CATEGORY_PALETTE)
 * @returns {Map<string, string>} Map of category name to hex color
 */
export function generateCategoryColors(categories, options = {}) {
  const { palette = CATEGORY_PALETTE } = options;
  const colorMap = new Map();

  categories.forEach((cat, idx) => {
    colorMap.set(cat, palette[idx % palette.length]);
  });

  return colorMap;
}

export default {
  parseHexColor,
  rgbToHex,
  mixHex,
  deriveRestOfColor,
  CATEGORY_PALETTE,
  generateCategoryColors
};

