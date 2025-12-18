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

export default {
  parseHexColor,
  rgbToHex,
  mixHex,
  deriveRestOfColor
};

