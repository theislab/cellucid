/**
 * @fileoverview Hex colors: the one place a color is read from or written as
 * `#rrggbb` text. The state holds a color as an RGB triplet of channels from
 * 0 to 1 (or as its bytes, as drawn); sessions, exports, the color inputs and
 * Scanpy's `uns['<key>_colors']` hold it as hex text.
 *
 * @module utils/hex-color
 */

/** `#rrggbb` in lowercase: the one form Cellucid writes a color in. */
export const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** `#rrggbb` in either case: what a color input gives or a person types. */
const HEX_COLOR_EITHER_CASE = /^#[0-9a-f]{6}$/i;

/** `#rgb`, `#rrggbb` or `#rrggbbaa` in either case: a color as a file may hold it. */
const HEX_COLOR_ANY_FORM = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Whether `text` is `#rrggbb` (either case).
 * @param {unknown} text
 * @returns {text is string}
 */
export function isHexColor(text) {
  return typeof text === 'string' && HEX_COLOR_EITHER_CASE.test(text);
}

/**
 * Three bytes (integers 0–255) as `#rrggbb`.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string}
 */
export function hexOfBytes(r, g, b) {
  let text = '#';
  for (const byte of [r, g, b]) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new TypeError(`A color byte must be an integer from 0 through 255, not ${byte}.`);
    }
    text += byte.toString(16).padStart(2, '0');
  }
  return text;
}

/**
 * An RGB triplet of channels from 0 to 1 as `#rrggbb`: each channel as the
 * byte it is drawn in (`round(channel × 255)`).
 * @param {ArrayLike<number>} rgb
 * @returns {string}
 */
export function hexOfRgb01(rgb) {
  if (rgb == null || rgb.length !== 3) throw new TypeError('A color must be an RGB triplet.');
  return hexOfBytes(Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255));
}

/**
 * A hex color's bytes `[r, g, b]`, or null for any other text. Reads `#rgb`,
 * `#rrggbb` and `#rrggbbaa` in either case (alpha dropped: a category's
 * opacity is the view's), as a file (Scanpy's palette) may hold them.
 * @param {unknown} text
 * @returns {[number, number, number]|null}
 */
export function bytesOfHex(text) {
  if (typeof text !== 'string' || !HEX_COLOR_ANY_FORM.test(text)) return null;
  const digits = text.length === 4
    ? [...text.slice(1)].map(digit => digit + digit).join('')
    : text.slice(1, 7);
  return [
    Number.parseInt(digits.slice(0, 2), 16),
    Number.parseInt(digits.slice(2, 4), 16),
    Number.parseInt(digits.slice(4, 6), 16),
  ];
}

/**
 * A hex color as an RGB triplet of channels from 0 to 1, or null for any
 * other text (the forms `bytesOfHex` reads).
 * @param {unknown} text
 * @returns {[number, number, number]|null}
 */
export function rgb01OfHex(text) {
  const bytes = bytesOfHex(text);
  return bytes === null ? null : [bytes[0] / 255, bytes[1] / 255, bytes[2] / 255];
}
