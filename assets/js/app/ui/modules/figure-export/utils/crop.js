/**
 * @fileoverview Crop/framing helpers for figure export.
 *
 * Crop is represented in normalized viewport coordinates (0..1):
 * - `x`, `y` are the top-left corner
 * - `width`, `height` are the size
 *
 * A crop is the figure's source in place of the whole viewport: the plot
 * rectangle takes the crop's aspect and the crop fills it (`plot-fit.js`).
 * This lets the user “frame” a sub-region of the current view without changing
 * the camera.
 *
 * @module ui/modules/figure-export/utils/crop
 */

import { requireExactKeys } from '../../../../../utils/exact-record.js';

/** The least width and height of a frame, as a share of the viewport. */
export const MIN_NORM_SIZE = 0.02;
const CROP_INPUT_KEYS = Object.freeze([
  'enabled',
  'height',
  'width',
  'x',
  'y',
]);
const CROP_RECT_KEYS = Object.freeze(['height', 'width', 'x', 'y']);

function assertRectNumbers(rect, context) {
  for (const key of CROP_RECT_KEYS) {
    if (typeof rect[key] !== 'number' || !Number.isFinite(rect[key])) {
      throw new TypeError(`${context}.${key} must be a finite number.`);
    }
  }
  if (rect.x < 0 || rect.y < 0) {
    throw new RangeError(`${context} origin must be within the viewport.`);
  }
  if (rect.width < MIN_NORM_SIZE || rect.height < MIN_NORM_SIZE) {
    throw new RangeError(
      `${context} width and height must each be at least ${MIN_NORM_SIZE}.`
    );
  }
  if (rect.x + rect.width > 1 || rect.y + rect.height > 1) {
    throw new RangeError(`${context} must be fully contained in the viewport.`);
  }
}

/**
 * @typedef {object} NormalizedCropRect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * Assert the exact current crop contract.
 *
 * `null` means cropping is disabled. Enabled crop objects are validated but
 * never coerced, clamped, resized, or translated.
 *
 * @param {unknown} crop
 * @returns {NormalizedCropRect|null}
 */
export function assertCropRect01(crop) {
  if (crop === null) return null;
  requireExactKeys(crop, CROP_INPUT_KEYS, 'Figure export crop');
  if (crop.enabled !== true) {
    throw new TypeError(
      'Figure export crop.enabled must be true; use null when cropping is disabled.'
    );
  }
  assertRectNumbers(crop, 'Figure export crop');
  return {
    x: crop.x,
    y: crop.y,
    width: crop.width,
    height: crop.height,
  };
}

/**
 * Assert an exact normalized viewport rectangle (top-left origin), such as a
 * point raster's source (`viewRect01`): exactly `x`, `y`, `width`, `height`,
 * inside the viewport. Never coerced.
 *
 * @param {unknown} rect
 * @param {string} context - names the rectangle in the error
 * @returns {NormalizedCropRect}
 */
export function assertNormalizedRect01(rect, context) {
  requireExactKeys(rect, CROP_RECT_KEYS, context);
  assertRectNumbers(rect, context);
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
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
  if (crop01 === null) return null;
  assertNormalizedRect01(crop01, 'Normalized figure export crop');
  if (
    typeof viewportWidth !== 'number' ||
    !Number.isFinite(viewportWidth) ||
    viewportWidth <= 0 ||
    typeof viewportHeight !== 'number' ||
    !Number.isFinite(viewportHeight) ||
    viewportHeight <= 0
  ) {
    throw new TypeError(
      'Figure export crop viewport dimensions must be finite positive numbers.'
    );
  }
  return {
    x: crop01.x * viewportWidth,
    y: crop01.y * viewportHeight,
    width: crop01.width * viewportWidth,
    height: crop01.height * viewportHeight,
  };
}
