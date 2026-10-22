/**
 * @fileoverview Helpers for matching point size to the interactive viewer.
 *
 * The interactive viewer may apply a per-LOD size multiplier so that density
 * reduction keeps visual coverage consistent. For WYSIWYG figure export we
 * must apply the same multiplier, otherwise exported dots will not match the
 * on-screen appearance.
 *
 * @module ui/modules/figure-export/utils/point-size
 */

import { isFiniteNumber } from '../../../../utils/number-utils.js';

/**
 * The point diameter to rasterise with, for a raster that is `viewportScale`
 * times the on-screen viewport.
 *
 * The shaders take `u_pointSize` as a *scale*, not as a pixel count: with size
 * attenuation on it is a world size that the projection turns into pixels, and
 * with attenuation off it is the pixel diameter directly. Either way the
 * rendered size is linear in it, so a raster `s` times the viewport reproduces
 * the screen exactly when `u_pointSize` is multiplied by `s` — and by nothing
 * else.
 *
 * Flooring the result at one pixel therefore does not "keep points visible": it
 * inflates them. A dataset of around 400,000 cells opens at a point size of 0.75 and the default export
 * is half the viewport, so a 150-DPI export asks for 0.586 and a floor of 1
 * draws every cell 1.7x too large; at the smallest point size the same floor is
 * 5.1x. The minimum that does keep a point visible is the shaders' own
 * `clamp(gl_PointSize, 0.5, 128.0)`, which is applied to the rendered size
 * where it belongs. The PNG renderer floored and the hybrid-SVG renderer did
 * not, so the same view exported twice disagreed with itself; both now resolve
 * the size here.
 *
 * @param {number} diameterViewportPx - `pointSize x lodSizeMultiplier`
 * @param {number} viewportScale - raster pixels per viewport pixel
 * @returns {number}
 */
export function scalePointDiameterToRaster(diameterViewportPx, viewportScale) {
  if (!isFiniteNumber(diameterViewportPx) || diameterViewportPx <= 0) {
    throw new RangeError(
      'Figure-export point diameter must be a finite positive number.'
    );
  }
  if (!isFiniteNumber(viewportScale) || viewportScale <= 0) {
    throw new RangeError(
      'Figure-export viewport scale must be a finite positive number.'
    );
  }
  return diameterViewportPx * viewportScale;
}
