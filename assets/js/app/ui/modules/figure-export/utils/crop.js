/**
 * @fileoverview Crop/framing helpers for figure export.
 *
 * Crop is represented in normalized viewport coordinates (0..1):
 * - `x`, `y` are the top-left corner
 * - `width`, `height` are the size
 *
 * The crop is applied in export by mapping the selected viewport sub-rectangle
 * to the full plot rectangle. This lets the user “frame” a sub-region of the
 * current view without changing the camera.
 *
 * @module ui/modules/figure-export/utils/crop
 */

import { clamp } from '../../../../utils/number-utils.js';

const MIN_NORM_SIZE = 0.02;

function clamp01(v) {
  return clamp(Number(v) || 0, 0, 1);
}

/**
 * @typedef {object} NormalizedCropRect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * Normalize a crop rect to a safe 0..1 box (or return null if disabled).
 *
 * @param {any} crop
 * @returns {NormalizedCropRect|null}
 */
export function normalizeCropRect01(crop) {
  if (!crop || crop.enabled !== true) return null;

  let x = clamp01(crop.x);
  let y = clamp01(crop.y);
  let width = clamp01(crop.width ?? crop.w);
  let height = clamp01(crop.height ?? crop.h);

  width = Math.max(MIN_NORM_SIZE, width);
  height = Math.max(MIN_NORM_SIZE, height);

  if (x + width > 1) x = Math.max(0, 1 - width);
  if (y + height > 1) y = Math.max(0, 1 - height);

  return { x, y, width, height };
}

/**
 * @typedef {object} PixelRect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * Convert a normalized crop rect to a pixel rect.
 *
 * @param {NormalizedCropRect|null} crop01
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 * @returns {PixelRect|null}
 */
export function cropRect01ToPx(crop01, viewportWidth, viewportHeight) {
  if (!crop01) return null;
  const vw = Math.max(1, Number(viewportWidth) || 1);
  const vh = Math.max(1, Number(viewportHeight) || 1);
  return {
    x: crop01.x * vw,
    y: crop01.y * vh,
    width: Math.max(1, crop01.width * vw),
    height: Math.max(1, crop01.height * vh),
  };
}

