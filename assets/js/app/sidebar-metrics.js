/**
 * Sidebar sizing constants & helpers.
 *
 * Centralized here to keep sidebar width behavior consistent across features
 * (sidebar resize, floating panels that mimic sidebar modules, etc.).
 */

import { clamp } from './utils/number-utils.js';

export const SIDEBAR_MIN_WIDTH_PX = 280;
export const SIDEBAR_MAX_WIDTH_PX = 560; // 2x the minimum width

/**
 * Clamp a width to the sidebar's resize limits.
 * @param {number} widthPx
 * @returns {number}
 */
export function clampSidebarWidthPx(widthPx) {
  if (typeof widthPx !== 'number' || !Number.isFinite(widthPx)) {
    throw new TypeError('Sidebar width must be a finite number.');
  }
  return clamp(widthPx, SIDEBAR_MIN_WIDTH_PX, SIDEBAR_MAX_WIDTH_PX);
}
