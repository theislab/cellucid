/**
 * Sidebar sizing constants & helpers.
 *
 * Centralized here to keep sidebar width behavior consistent across features
 * (sidebar resize, floating panels that mimic sidebar modules, etc.).
 */

export const SIDEBAR_MIN_WIDTH_PX = 280;
export const SIDEBAR_MAX_WIDTH_PX = 560; // 2x the minimum width

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Clamp a width to the sidebar's resize limits.
 * @param {number} widthPx
 * @returns {number}
 */
export function clampSidebarWidthPx(widthPx) {
  const width = isFiniteNumber(widthPx) ? widthPx : SIDEBAR_MIN_WIDTH_PX;
  return Math.max(SIDEBAR_MIN_WIDTH_PX, Math.min(SIDEBAR_MAX_WIDTH_PX, width));
}

/**
 * Returns the current sidebar border-box width in pixels.
 * @param {HTMLElement|null} [sidebarEl]
 * @returns {number}
 */
export function getSidebarWidthPx(sidebarEl) {
  const sidebar = sidebarEl || document.getElementById('sidebar');
  const rectWidth = sidebar?.getBoundingClientRect?.().width;
  if (isFiniteNumber(rectWidth) && rectWidth > 0) return Math.round(rectWidth);
  const offsetWidth = sidebar?.offsetWidth;
  if (isFiniteNumber(offsetWidth) && offsetWidth > 0) return Math.round(offsetWidth);
  return SIDEBAR_MIN_WIDTH_PX;
}

