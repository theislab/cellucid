/**
 * @fileoverview Crop/framing helpers for figure export.
 *
 * Crop is represented in normalized viewport coordinates (0..1):
 * - `x`, `y` are the top-left corner
 * - `width`, `height` are the size
 *
 * The crop is applied in export by fitting the selected viewport sub-rectangle
 * into the plot rectangle without distortion (letterbox/pillarbox, centered).
 * This lets the user “frame” a sub-region of the current view without changing
 * the camera.
 *
 * @module ui/modules/figure-export/utils/crop
 */

import { computeLetterboxedRect } from './letterbox.js';

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

function assertPositiveFinite(value, context) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${context} must be a finite positive number.`);
  }
}

/**
 * Where a crop lands in `destRect`: fitted without distortion and centred --
 * the same letterbox the vector point projector, the preview, the reference
 * grid and the centroid labels apply to the crop, so raster and vector
 * exports place every point identically.
 *
 * @param {object} options
 * @param {NormalizedCropRect} options.crop01
 * @param {number} options.viewportWidth
 * @param {number} options.viewportHeight
 * @param {PixelRect} options.destRect
 * @returns {PixelRect}
 */
export function fitCropIntoRect({
  crop01,
  viewportWidth,
  viewportHeight,
  destRect,
}) {
  assertExactKeys(crop01, CROP_RECT_KEYS, 'Normalized figure export crop');
  assertRectNumbers(crop01, 'Normalized figure export crop');
  assertPositiveFinite(viewportWidth, 'Figure export crop viewport width');
  assertPositiveFinite(viewportHeight, 'Figure export crop viewport height');
  if (destRect === null || typeof destRect !== 'object') {
    throw new TypeError('Figure export crop destination must be a rectangle.');
  }
  for (const key of ['x', 'y']) {
    if (typeof destRect[key] !== 'number' || !Number.isFinite(destRect[key])) {
      throw new TypeError(`Figure export crop destination ${key} must be finite.`);
    }
  }
  assertPositiveFinite(destRect.width, 'Figure export crop destination width');
  assertPositiveFinite(destRect.height, 'Figure export crop destination height');
  const sourceWidth = crop01.width * viewportWidth;
  const sourceHeight = crop01.height * viewportHeight;
  const scale = Math.min(
    destRect.width / sourceWidth,
    destRect.height / sourceHeight
  );
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: destRect.x + (destRect.width - width) / 2,
    y: destRect.y + (destRect.height - height) / 2,
    width,
    height,
  };
}

/**
 * Size the point raster of a crop that lands on `deviceRect` (whole pixels).
 *
 * The crop is rasterized on its own, at the destination's resolution (the
 * rasterizer zooms its projection onto the crop): every point is drawn at
 * the pixels it is shown at, not magnified out of a raster of the whole
 * view. One limit is real: the GPU's largest point sprite. Viewer sprites
 * reach 128 pixels, so above `zoomLimit` raster pixels per viewer pixel a
 * large sprite could not be drawn at its size; the crop is then rasterized
 * at `zoomLimit` and scaled the rest of the way when it is copied.
 *
 * @param {object} options
 * @param {NormalizedCropRect} options.crop01
 * @param {number} options.viewportWidth
 * @param {number} options.viewportHeight
 * @param {PixelRect} options.deviceRect - integer device pixels
 * @param {number} options.zoomLimit - raster pixels per viewer pixel the GPU's
 *   point sprites allow (`exportSpriteZoomLimit`)
 * @returns {{width: number, height: number, zoom: number, exact: boolean}}
 *   raster size, raster pixels per viewer pixel, and whether the raster is
 *   copied one to one
 */
export function planCropRaster({
  crop01,
  viewportWidth,
  viewportHeight,
  deviceRect,
  zoomLimit,
}) {
  assertExactKeys(crop01, CROP_RECT_KEYS, 'Normalized figure export crop');
  assertRectNumbers(crop01, 'Normalized figure export crop');
  assertPositiveFinite(viewportWidth, 'Figure export crop viewport width');
  assertPositiveFinite(viewportHeight, 'Figure export crop viewport height');
  assertPositiveFinite(zoomLimit, 'Figure export crop zoom limit');
  for (const key of ['width', 'height']) {
    if (!Number.isSafeInteger(deviceRect?.[key]) || deviceRect[key] <= 0) {
      throw new TypeError(`Figure export crop device ${key} must be a positive integer.`);
    }
  }
  const sourceWidth = crop01.width * viewportWidth;
  const sourceHeight = crop01.height * viewportHeight;
  const zoom = Math.min(
    deviceRect.width / sourceWidth,
    deviceRect.height / sourceHeight
  );
  if (zoom <= zoomLimit) {
    return { width: deviceRect.width, height: deviceRect.height, zoom, exact: true };
  }
  const reduce = zoomLimit / zoom;
  const width = Math.max(1, Math.round(deviceRect.width * reduce));
  const height = Math.max(1, Math.round(deviceRect.height * reduce));
  return {
    width,
    height,
    zoom: Math.min(width / sourceWidth, height / sourceHeight),
    exact: false,
  };
}
