/**
 * Highlight page colors (shared between main UI + analysis).
 *
 * Centralizes the default page color palette so:
 * - Highlighted Cells tabs show the same colors as analysis plots
 * - Page colors can be persisted on the highlight page objects
 *
 * @module page-colors
 */

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

