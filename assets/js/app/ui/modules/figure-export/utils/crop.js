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

const MIN_NORM_SIZE = 0.02;
const CROP_INPUT_KEYS = Object.freeze([
  'enabled',
  'height',
  'width',
  'x',
  'y',
]);
const CROP_RECT_KEYS = Object.freeze(['height', 'width', 'x', 'y']);

function assertExactKeys(value, expectedKeys, context) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${context} must be a plain object.`);
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(
      `${context} must contain exactly: ${expectedKeys.join(', ')}.`
    );
  }
}

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
  assertExactKeys(crop, CROP_INPUT_KEYS, 'Figure export crop');
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
  assertExactKeys(crop01, CROP_RECT_KEYS, 'Normalized figure export crop');
  assertRectNumbers(crop01, 'Normalized figure export crop');
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
