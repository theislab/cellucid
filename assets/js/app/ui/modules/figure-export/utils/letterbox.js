/**
 * @fileoverview Letterbox / pillarbox mapping helpers.
 *
 * Computes the largest axis-aligned rectangle of aspect `srcWidth/srcHeight`
 * that fits inside `dstWidth/dstHeight`, centered.
 *
 * @module ui/modules/figure-export/utils/letterbox
 */

/**
 * @typedef {object} PixelRect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @param {object} options
 * @param {number} options.srcWidth
 * @param {number} options.srcHeight
 * @param {number} options.dstWidth
 * @param {number} options.dstHeight
 * @returns {PixelRect & { scale: number }}
 */
export function computeLetterboxedRect({ srcWidth, srcHeight, dstWidth, dstHeight }) {
  const sw = Math.max(1, Number(srcWidth) || 1);
  const sh = Math.max(1, Number(srcHeight) || 1);
  const dw = Math.max(1, Number(dstWidth) || 1);
  const dh = Math.max(1, Number(dstHeight) || 1);

  const scale = Math.min(dw / sw, dh / sh);
  const width = Math.max(1, sw * scale);
  const height = Math.max(1, sh * scale);
  const x = (dw - width) / 2;
  const y = (dh - height) / 2;
  return { x, y, width, height, scale };
}

