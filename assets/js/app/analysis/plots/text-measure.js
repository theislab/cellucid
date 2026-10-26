/**
 * The size text takes when Plotly draws it, measured before the plot is
 * drawn: a layout that places labels, legends and colour bars side by side
 * reserves the room each one needs instead of guessing it from a character
 * count, so no label lands on another at any size of the plot.
 *
 * Plotly draws SVG text in the font a layout names; the canvas measures the
 * same font, so the widths agree to a fraction of a pixel.
 *
 * @module plots/text-measure
 */

/** Plotly's spacing of the lines of one text (`svg_text_utils` LINE_SPACING). */
export const PLOTLY_LINE_SPACING = 1.3;

/** @type {CanvasRenderingContext2D|null} */
let context = null;

/**
 * The width of one line of text, in CSS pixels.
 *
 * @param {string} text
 * @param {{size: number, family: string, weight?: 'normal'|'bold'}} font
 * @returns {number}
 */
export function textWidth(text, { size, family, weight = 'normal' }) {
  context ??= document.createElement('canvas').getContext('2d');
  context.font = `${weight} ${size}px ${family}`;
  return context.measureText(text).width;
}

/**
 * The height of `lines` lines of text in one Plotly label, in CSS pixels.
 *
 * @param {number} lines
 * @param {number} size - The font size in px
 */
export function textHeight(lines, size) {
  return lines * size * PLOTLY_LINE_SPACING;
}
