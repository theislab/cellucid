/**
 * Highlight page colors (shared between main UI + analysis).
 *
 * Centralizes the default page color palette so:
 * - Highlighted Cells tabs show the same colors as analysis plots
 * - Page colors can be persisted on the highlight page objects
 *
 * @module page-colors
 */

import { distinctColor } from '../../data/distinct-colors.js';
import { getCategoryColor, getCategoryColorSeedCount } from '../../data/palettes.js';
import { hexOfRgb01, rgb01OfHex } from '../../utils/hex-color.js';

export const PAGE_COLORS = [
  '#2563eb', // blue-600
  '#dc2626', // red-600
  '#16a34a', // green-600
  '#9333ea', // purple-600
  '#ea580c', // orange-600
  '#0891b2', // cyan-600
  '#c026d3', // fuchsia-600
  '#65a30d', // lime-600
  '#e11d48', // rose-600
  '#0d9488', // teal-600
  '#7c3aed', // violet-600
  '#ca8a04'  // yellow-600
];

/**
 * Get a default color for a page by index.
 * @param {number} pageIndex
 * @returns {string} Hex color (#RRGGBB)
 */
export function getPageColor(pageIndex) {
  const idx = Number.isFinite(pageIndex) ? pageIndex : 0;
  return PAGE_COLORS[idx % PAGE_COLORS.length];
}

/**
 * The color a new highlight page takes beside the pages there are: the
 * default of its place (`getPageColor`) when it can be told apart from every
 * page's color (`distinct-colors.js`), else the first of the page colors,
 * then of the category colors, that can. (The default of the page count would
 * repeat a remaining page's color after a page was removed, repeat the first
 * on the thirteenth, and make the ninth (rose) read as the second (red).)
 *
 * @param {ReadonlyArray<string>} pageColors - The pages' `#rrggbb` colors
 * @returns {string} `#rrggbb`
 */
export function nextPageColor(pageColors) {
  const taken = pageColors.map(color => rgb01OfHex(color)).filter(color => color !== null);
  const sequence = index => (index < PAGE_COLORS.length
    ? rgb01OfHex(PAGE_COLORS[index])
    : getCategoryColor(index - PAGE_COLORS.length));
  const preferred = rgb01OfHex(getPageColor(pageColors.length));
  return hexOfRgb01(distinctColor(taken, preferred, sequence, PAGE_COLORS.length + getCategoryColorSeedCount()));
}

