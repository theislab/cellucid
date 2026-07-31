/**
 * @fileoverview The ink a figure writes its annotations in.
 *
 * WHY THIS EXISTS
 * Every annotation the export draws — title, axis ticks, axis labels, panel
 * letters, legend text, the plot frame, the selection badge, the "No visible
 * cells" notice — used to be hard-coded near-black on a near-white frame. That
 * is correct on white paper and unreadable on anything else. The viewer's
 * `Grid (dark)` and `Black` backgrounds are ordinary choices, and `Background:
 * Viewer` carries them into the figure, so those exports came out with a title
 * and axis numbers the reader cannot see.
 *
 * Ink is therefore derived from the figure's own background rather than
 * assumed. The two palettes are the same grey family the export already used
 * (`#111`, `#6b7280`, `#e5e7eb`), mirrored across the luminance midpoint.
 *
 * A transparent figure keeps the light palette: it will be placed on a page
 * whose colour this file cannot know, and paper is the safe assumption — the
 * same assumption the centroid-label halo already makes.
 *
 * @module ui/modules/figure-export/utils/figure-ink
 */

import { hexToRgb01 } from './color-utils.js';

/** Rec. 709 luma weights, matching the viewer's own background test. */
const LUMA_WEIGHTS = Object.freeze([0.2126, 0.7152, 0.0722]);

/** Backgrounds at or above this luma take the light palette. */
const LIGHT_BACKGROUND_LUMA = 0.5;

/**
 * @typedef {object} FigureInk
 * @property {'light'|'dark'} scheme
 * @property {string} text - titles, tick labels, panel letters, legend entries
 * @property {string} mutedText - secondary notices and hidden-category marks
 * @property {string} frame - plot border, legend border, hairlines
 * @property {string} surface - opaque chips drawn over the plot (badge, gizmo)
 * @property {string} surfaceInk - text drawn on `surface`
 * @property {string} halo - the outline that keeps labels legible over points
 */

const LIGHT_INK = Object.freeze({
  scheme: 'light',
  text: '#111111',
  mutedText: '#6b7280',
  frame: '#e5e7eb',
  surface: '#ffffff',
  surfaceInk: '#111111',
  halo: '#ffffff',
});

const DARK_INK = Object.freeze({
  scheme: 'dark',
  text: '#f3f4f6',
  mutedText: '#9ca3af',
  frame: '#374151',
  surface: '#111827',
  surfaceInk: '#f3f4f6',
  halo: '#111827',
});

/**
 * The ink palette for one figure.
 *
 * @param {object} options
 * @param {string} options.background - the export background mode
 * @param {string} options.backgroundColor - exact #RRGGBB paper colour
 * @returns {FigureInk}
 */
export function resolveFigureInk({ background, backgroundColor }) {
  if (background === 'transparent') return LIGHT_INK;
  const rgb = hexToRgb01(backgroundColor);
  if (rgb === null) {
    throw new TypeError(
      'Figure ink requires an exact #RRGGBB background colour.'
    );
  }
  const luma =
    rgb[0] * LUMA_WEIGHTS[0] + rgb[1] * LUMA_WEIGHTS[1] + rgb[2] * LUMA_WEIGHTS[2];
  return luma >= LIGHT_BACKGROUND_LUMA ? LIGHT_INK : DARK_INK;
}

export { LIGHT_INK, DARK_INK };
