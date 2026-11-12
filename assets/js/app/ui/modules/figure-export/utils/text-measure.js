/**
 * @fileoverview The one text measurement a figure's legend and axes are laid out with.
 *
 * The layout reserves a legend's columns from the widths this returns, and the
 * legend builders draw exactly the columns the layout reserved
 * (`planLegend()` in `components/legend-builder.js`), so the box can never be
 * narrower than what is drawn in it and no label is ever shortened to fit.
 *
 * In the browser the width is the canvas's own `measureText` for the figure's
 * font (an `OffscreenCanvas` context, which every browser Cellucid runs in
 * has): the PNG draws with that font on a canvas, and the SVG is written by
 * the same page, so both formats are sized by the glyphs the browser draws.
 * Where no canvas exists (the Node contract tests) a conservative estimate
 * stands in: every character is given at least the advance of the widest
 * glyph of its class in common sans-serif and serif faces, so the estimate is
 * never narrower than real text.
 *
 * @module ui/modules/figure-export/utils/text-measure
 */

/** @typedef {(text: string, fontPx: number, weight?: number) => number} MeasureText */

/** Ems per character of the conservative estimate, by character class. */
const ESTIMATE_EM = {
  /** `M`, `W`, `m`, `w`, `@`, `%`, `&`, and any non-ASCII character. */
  wide: 1.3,
  upper: 0.85,
  lowerOrDigit: 0.7,
  /** Space and ASCII punctuation. */
  narrow: 0.45,
};

/** A bold (600+) run is up to this much wider than regular text. */
const BOLD_ESTIMATE_FACTOR = 1.1;

/**
 * The conservative estimate (see the file header): never narrower than real
 * text in the faces a figure is drawn with.
 *
 * @type {MeasureText}
 */
export function estimateTextWidth(text, fontPx, weight = 400) {
  let ems = 0;
  for (const char of String(text ?? '')) {
    if (/[MWmw@%&]/.test(char) || char.codePointAt(0) > 0x7e) ems += ESTIMATE_EM.wide;
    else if (/[A-Z]/.test(char)) ems += ESTIMATE_EM.upper;
    else if (/[a-z0-9]/.test(char)) ems += ESTIMATE_EM.lowerOrDigit;
    else ems += ESTIMATE_EM.narrow;
  }
  return ems * fontPx * (weight >= 600 ? BOLD_ESTIMATE_FACTOR : 1);
}

/** @type {OffscreenCanvasRenderingContext2D|null} */
let measuringContext = null;
let measuringFont = '';

/** The page's measuring context, or null where there is no canvas. */
function canvasContext() {
  if (measuringContext !== null) return measuringContext;
  if (typeof OffscreenCanvas !== 'function') return null;
  let context = null;
  try {
    context = new OffscreenCanvas(1, 1).getContext('2d');
  } catch {
    return null;
  }
  if (context === null || typeof context.measureText !== 'function') return null;
  measuringContext = context;
  measuringFont = '';
  return measuringContext;
}

/**
 * The text measurement for one font family: `(text, fontPx, weight) => px`.
 *
 * @param {string} fontFamily - CSS font family list, as the figure draws with
 * @returns {MeasureText}
 */
export function figureTextMeasure(fontFamily) {
  const family = String(fontFamily || 'Arial, Helvetica, sans-serif');
  return (text, fontPx, weight = 400) => {
    const context = canvasContext();
    if (context === null) return estimateTextWidth(text, fontPx, weight);
    const font = `${weight === 400 ? '' : `${weight} `}${fontPx}px ${family}`;
    if (font !== measuringFont) {
      context.font = font;
      measuringFont = font;
    }
    return context.measureText(String(text ?? '')).width;
  };
}
