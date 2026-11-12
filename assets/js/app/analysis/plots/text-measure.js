/**
 * The size text takes when Plotly draws it, measured before the plot is
 * drawn: a layout that places labels, legends and color bars side by side
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

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The one hidden SVG label `lineBoxHeight` measures with. @type {SVGTextElement|null} */
let svgLabel = null;

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
 * The height of the box one line of a label is drawn in, in CSS pixels: its
 * font's ascent and descent as this engine draws them, never less than
 * Plotly's spacing of a line. What a label takes beside another (a name
 * turned to run down, a row's name): each engine sizes the box its own way
 * (found 2026-11-10: a 7 px gene name was 9 px wide turned in Chromium and
 * 10.8 px in Firefox, where the names overlapped). Measured as Plotly draws
 * it, the box an SVG label takes on the page: neither the canvas's font box
 * nor the label's `getBBox()` (9 px and 9.1 px in Firefox) is it.
 *
 * @param {{size: number, family: string, weight?: 'normal'|'bold'}} font
 * @returns {number}
 */
export function lineBoxHeight({ size, family, weight = 'normal' }) {
  if (svgLabel === null) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;left:-10000px;top:0;width:0;height:0;overflow:hidden;visibility:hidden';
    svgLabel = document.createElementNS(SVG_NS, 'text');
    svg.appendChild(svgLabel);
    document.body.appendChild(svg);
  }
  svgLabel.setAttribute('font-family', family);
  svgLabel.setAttribute('font-size', `${size}px`);
  svgLabel.setAttribute('font-weight', weight);
  svgLabel.textContent = 'Mg';
  return Math.max(svgLabel.getBoundingClientRect().height, textHeight(1, size));
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
