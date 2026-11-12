/**
 * @fileoverview A figure's size, one model for every way it is drawn.
 *
 * A figure is laid out in figure pixels: 1/96 inch, the CSS pixel, so a
 * layout length is a physical length (`utils/layout.js`). The person sets
 * the figure's width physically (millimetres, or a journal's column) and the
 * figure fills it, at its own height (each plot keeps its view's or its
 * frame's shape); text is set in points (1/72 inch) and keeps its printed size
 * at any width or resolution. Every output is that one size:
 *
 * - a PNG at D dpi is the figure at D / 96 device pixels a figure pixel, and
 *   says D dpi (`pHYs`), so a layout program places it at its size;
 * - an SVG states its width and height in millimetres (its `viewBox` in
 *   figure pixels), so an editor opens it at its size (a bare pixel size is
 *   read as 1/72 inch by some);
 * - `view.picture` with source "export" draws that PNG and says the size in
 *   millimetres and pixels.
 *
 * Nobody converts pixels to points by hand: the settings hold millimetres
 * and points, and this module turns them into figure pixels (an agent once
 * set 1800 px for "180 mm" and got a figure 476 mm wide; live-7 L25-10).
 *
 * @module ui/modules/figure-export/utils/figure-size
 */

/** Figure pixels an inch: the CSS pixel. */
export const FIGURE_PX_PER_INCH = 96;
const MM_PER_INCH = 25.4;
const PT_PER_INCH = 72;

/**
 * The column widths journals print figures at (millimetres): Nature's
 * single, 1.5 and double column (89, 120–136 and 183 mm); Cell, Science and
 * PLOS print within a few millimetres of them (85/114/174, 57/121/184,
 * 83/132/173). `custom` is any other width.
 */
export const FIGURE_WIDTH_PRESETS = Object.freeze({
  'single-column': 89,
  'one-and-half-column': 120,
  'double-column': 183,
});

/** The preset a figure opens with: a two-column figure, room for a grid of views. */
export const FIGURE_DEFAULT_WIDTH_PRESET = 'double-column';

/** What each preset is called in the panel and to an agent. */
export const FIGURE_WIDTH_PRESET_LABELS = Object.freeze({
  'single-column': 'Single column',
  'one-and-half-column': '1.5 column',
  'double-column': 'Double column',
  custom: 'Custom width',
});

/**
 * The text sizes (points) Auto text sets: what journals ask of figure text
 * (5–8 pt at print size: Nature, Cell, Science), the same at any width.
 */
export const FIGURE_STANDARD_TEXT_PT = Object.freeze({
  base: 7,
  legend: 7,
  ticks: 6,
  axisLabel: 7,
  title: 8,
  centroidLabel: 6,
});

/** Figure pixels of a length in millimetres. */
export function figurePxOfMm(mm) {
  return (mm / MM_PER_INCH) * FIGURE_PX_PER_INCH;
}

/** Millimetres of a length in figure pixels. */
export function mmOfFigurePx(px) {
  return (px / FIGURE_PX_PER_INCH) * MM_PER_INCH;
}

/** Figure pixels of a text size in points. */
export function figurePxOfPt(pt) {
  return (pt / PT_PER_INCH) * FIGURE_PX_PER_INCH;
}

/** Points of a text size in figure pixels. */
export function ptOfFigurePx(px) {
  return (px / FIGURE_PX_PER_INCH) * PT_PER_INCH;
}

/**
 * The figure's width in whole figure pixels: what the layout fills (to half a
 * figure pixel, 0.13 mm).
 *
 * @param {number} widthMm
 * @returns {number}
 */
export function figureWidthPxOf(widthMm) {
  if (!(Number.isFinite(widthMm) && widthMm > 0)) {
    throw new RangeError('A figure width is a positive number of millimetres.');
  }
  return Math.max(1, Math.round(figurePxOfMm(widthMm)));
}

/** The device pixels of a figure length drawn at `dpi` (a PNG's). */
export function devicePxOf(figurePx, dpi) {
  return Math.max(1, Math.round((figurePx * dpi) / FIGURE_PX_PER_INCH));
}

/**
 * A length in millimetres as the panel and the notes write it: whole
 * millimetres (as journals give column widths), to a tenth below 20 mm. A
 * figure is laid out in whole figure pixels (0.26 mm), so an 89 mm column is
 * 88.9 mm of them: said as the 89 mm it was asked as.
 */
export function formatMm(mm) {
  const rounded = mm >= 20 ? Math.round(mm) : Math.round(mm * 10) / 10;
  return `${rounded}`;
}

/**
 * The figure's size in words: "183 × 124 mm", with the PNG's pixels at a
 * resolution when one is given ("183 × 124 mm, 2161 × 1465 px at 300 dpi").
 *
 * @param {{width: number, height: number}} figure - figure pixels
 * @param {number|null} [dpi]
 * @returns {string}
 */
export function figureSizeText(figure, dpi = null) {
  const mm = `${formatMm(mmOfFigurePx(figure.width))} × ${formatMm(mmOfFigurePx(figure.height))} mm`;
  if (dpi === null) return mm;
  return `${mm}, ${devicePxOf(figure.width, dpi)} × ${devicePxOf(figure.height, dpi)} px at ${dpi} dpi`;
}
