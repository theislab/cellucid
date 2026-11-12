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
import { writePointShaderFrame } from '../../../../../rendering/shaders/high-perf-shaders.js';
import { pointSpriteSize } from '../../../../../rendering/point-sprite.js';

/**
 * The point diameter to rasterize with, for a raster that is `viewportScale`
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
 * (`POINT_SPRITE_MIN_PX`, rendering/point-sprite.js), which is applied to
 * the rendered size where it belongs. The PNG renderer floored and the hybrid-SVG renderer did
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

/** The pane's model-view matrix (`writePointShaderFrame`), and its point scale. */
function paneFrame(renderState) {
  const frame = { modelView: new Float32Array(16), halfDir: new Float32Array(3), invCenterShade: 1 };
  const pointScale = writePointShaderFrame(
    frame,
    renderState.viewMatrix,
    renderState.modelMatrix,
    renderState.lightDir,
    renderState.viewportHeight,
    renderState.fov
  );
  return { modelView: frame.modelView, pointScale };
}

/**
 * The diameter, in the pane's viewport pixels, at which the viewer draws a
 * point sprite: the point shaders' sizing (`pointSpriteSize`,
 * rendering/point-sprite.js, the GLSL of `HP_VS_*` and `CENTROID_VS`)
 * evaluated for one point.
 *
 * `u_pointSize` is a scale: with size attenuation `a` the sprite is
 * `mix(u_pointSize, u_pointSize · pointScale / eyeDepth, a)` pixels, where
 * `pointScale` is the viewport height over `2 tan(fov / 2)` (`· 0.01`,
 * `writePointShaderFrame`) and `eyeDepth` the point's distance in front of the
 * camera, clamped to the pane's cap (`renderState.pointSizeMax`). A point near
 * the camera is drawn larger than one far away. The vector strategies draw
 * their circles at this size (times the plot's scale), as the shader-drawn
 * PNG and Hybrid points are, so a 3-D figure keeps the sizes the screen
 * shows. (Found 2026-11-11, L6-1: the vector circles took `u_pointSize` as
 * the pixel diameter, so with the default attenuation of 0.8 a 3-D figure's
 * cells were specks where the screen showed spheres several times larger.)
 *
 * @param {{ viewMatrix: ArrayLike<number>, modelMatrix: ArrayLike<number>,
 *   lightDir: ArrayLike<number>, viewportHeight: number, fov: number,
 *   sizeAttenuation: number, pointSizeMax: number }} renderState -
 *   the pane's presented render state
 * @returns {(x: number, y: number, z: number, pointSize: number) => number}
 *   the sprite diameter (viewport pixels) of a point at model (x, y, z) drawn
 *   with `u_pointSize` = `pointSize`
 */
export function createViewportPointDiameter(renderState) {
  const attenuation = renderState?.sizeAttenuation;
  if (!isFiniteNumber(attenuation) || attenuation < 0 || attenuation > 1) {
    throw new RangeError('Figure-export size attenuation must be a number from 0 to 1.');
  }
  if (!isFiniteNumber(renderState.pointSizeMax) || renderState.pointSizeMax <= 0) {
    throw new RangeError('Figure-export point size cap must be a finite positive number.');
  }
  const { modelView: mv, pointScale } = paneFrame(renderState);
  const sprite = { pointSize: 0, pointScale, sizeAttenuation: attenuation, pointSizeMax: renderState.pointSizeMax };
  return (x, y, z, pointSize) => {
    sprite.pointSize = pointSize;
    return pointSpriteSize(-(mv[2] * x + mv[6] * y + mv[10] * z + mv[14]), sprite);
  };
}
