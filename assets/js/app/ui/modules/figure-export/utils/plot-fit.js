/**
 * @fileoverview The figure's plot takes the on-screen view's shape.
 *
 * A figure shows exactly what the pane frames on screen: its source is the
 * pane's viewport, or the framing crop inside it. The plot rectangle has the
 * source's aspect — the largest rectangle of that aspect inside the size the
 * person asked for (`fitPlotSize`; the requested width × height is the plot's
 * bounding box) — and the figure is laid out around it (`utils/layout.js`).
 * The source then fills the plot exactly: no letterbox, no blank band, the
 * pane's own projection.
 *
 * Every layer of a figure places itself through `createPlotPlacement` — the
 * point raster (its `viewRect01` and size, `planPlotRaster`), vector points,
 * centroids, labels, the reference grid, the studio backdrop, a backdrop
 * look, the preview — and decides whether a point is drawn with
 * `projectIntoSource`, so the layers stay registered with each other and the
 * axes (`computeSourceAxisBounds` in `coordinate-mapper.js`) frame exactly
 * what is drawn.
 *
 * Point sizes stay WYSIWYG: a viewport pixel is `scale` plot units, so a
 * sprite of d viewer pixels is d·scale plot units, as large relative to the
 * cells around it as on screen.
 *
 * @module ui/modules/figure-export/utils/plot-fit
 */

import { assertCropRect01, cropRect01ToPx } from './crop.js';

/**
 * How far a plot rectangle's aspect may differ from its source's: float
 * rounding of a fitted rectangle, nothing a reader could see.
 */
const ASPECT_TOLERANCE = 1e-6;

/**
 * @typedef {object} FigureSource
 * @property {number} viewportWidth - the pane's viewport (pixels)
 * @property {number} viewportHeight
 * @property {number} x - the source's left edge, viewport pixels
 * @property {number} y - the source's top edge, viewport pixels
 * @property {number} width
 * @property {number} height
 */

function requirePositive(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a finite positive number.`);
  }
  return value;
}

/**
 * What a figure of the pane shows, in its viewport pixels: the whole
 * viewport, or the framing crop.
 *
 * @param {object} options
 * @param {{ viewportWidth: number; viewportHeight: number }} options.renderState
 * @param {object|null} [options.crop] - the framing crop (`assertCropRect01`)
 * @returns {Readonly<FigureSource>}
 */
export function figureSourceRect({ renderState, crop = null }) {
  const viewportWidth = requirePositive(renderState?.viewportWidth, 'Figure source viewport width');
  const viewportHeight = requirePositive(renderState?.viewportHeight, 'Figure source viewport height');
  const cropPx = cropRect01ToPx(assertCropRect01(crop), viewportWidth, viewportHeight);
  return Object.freeze({
    viewportWidth,
    viewportHeight,
    x: cropPx === null ? 0 : cropPx.x,
    y: cropPx === null ? 0 : cropPx.y,
    width: cropPx === null ? viewportWidth : cropPx.width,
    height: cropPx === null ? viewportHeight : cropPx.height,
  });
}

/**
 * The aspect (width / height) a figure's plot of the pane takes.
 *
 * @param {object} options
 * @param {{ viewportWidth: number; viewportHeight: number }} options.renderState
 * @param {object|null} [options.crop]
 * @returns {number}
 */
export function figureSourceAspect({ renderState, crop = null }) {
  const source = figureSourceRect({ renderState, crop });
  return source.width / source.height;
}

/**
 * The largest rectangle of `aspect` inside `width` × `height`: one side is
 * the box's, the other is shorter (never rounded, so the aspect is exact).
 *
 * @param {object} options
 * @param {number} options.aspect - width / height
 * @param {number} options.width - the box (px)
 * @param {number} options.height
 * @returns {{ width: number; height: number }}
 */
export function fitPlotSize({ aspect, width, height }) {
  requirePositive(aspect, 'Figure plot aspect');
  requirePositive(width, 'Figure plot box width');
  requirePositive(height, 'Figure plot box height');
  return width / height <= aspect
    ? { width, height: width / aspect }
    : { width: height * aspect, height };
}

/**
 * The placement of a pane's source on its plot rectangle, which has the
 * source's aspect (`fitPlotSize`): the source fills it exactly.
 *
 * @param {object} options
 * @param {{ viewportWidth: number; viewportHeight: number }} options.renderState
 * @param {{ x: number; y: number; width: number; height: number }} options.plotRect
 * @param {object|null} [options.crop]
 * @returns {{ source: Readonly<FigureSource>, scale: number,
 *   viewportToPlot: (vx: number, vy: number) => { x: number, y: number } }}
 *   `scale` is plot units per viewport pixel.
 */
export function createPlotPlacement({ renderState, plotRect, crop = null }) {
  const source = figureSourceRect({ renderState, crop });
  const scaleX = requirePositive(plotRect?.width, 'Figure plot width') / source.width;
  const scaleY = requirePositive(plotRect?.height, 'Figure plot height') / source.height;
  if (Math.abs(scaleX / scaleY - 1) > ASPECT_TOLERANCE) {
    throw new RangeError(
      'Figure plot rectangle must have its view\'s aspect (fitPlotSize); a figure is never letterboxed.'
    );
  }
  const originX = plotRect.x - source.x * scaleX;
  const originY = plotRect.y - source.y * scaleY;
  return {
    source,
    scale: scaleX,
    viewportToPlot: (vx, vy) => ({ x: originX + vx * scaleX, y: originY + vy * scaleY }),
  };
}

/**
 * Project a model-space point into a source: whether it is drawn (in front of
 * the camera, between the depth planes, inside the source), and where.
 * Writes `out[0]`, `out[1]` (viewport pixels from the source's top-left
 * corner) and `out[2]` (NDC depth).
 *
 * @param {ArrayLike<number>} mvp - column-major
 * @param {Readonly<FigureSource>} source
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {Float64Array|number[]} out
 * @returns {boolean}
 */
export function projectIntoSource(mvp, source, x, y, z, out) {
  const clipW = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
  if (!(clipW > 0) || clipW === Infinity) return false;
  const ndcX = (mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]) / clipW;
  const ndcY = (mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]) / clipW;
  const ndcZ = (mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14]) / clipW;
  if (!(ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1 && ndcZ >= -1 && ndcZ <= 1)) {
    return false;
  }
  const localX = (ndcX * 0.5 + 0.5) * source.viewportWidth - source.x;
  const localY = (0.5 - ndcY * 0.5) * source.viewportHeight - source.y;
  if (!(localX >= 0 && localX <= source.width && localY >= 0 && localY <= source.height)) {
    return false;
  }
  out[0] = localX;
  out[1] = localY;
  out[2] = ndcZ;
  return true;
}

/**
 * The source as a normalized viewport rectangle (top-left origin): what the
 * point rasterizer maps onto its whole output (`viewRect01`).
 *
 * @param {Readonly<FigureSource>} source
 * @returns {{ x: number; y: number; width: number; height: number }}
 */
export function sourceRect01(source) {
  return {
    x: source.x / source.viewportWidth,
    y: source.y / source.viewportHeight,
    width: source.width / source.viewportWidth,
    height: source.height / source.viewportHeight,
  };
}

/**
 * Size the point raster of a source that lands on `deviceWidth` ×
 * `deviceHeight` whole pixels (its plot rectangle on device pixels).
 *
 * The source is rasterized on its own, at the destination's resolution:
 * every point is drawn at the pixels it is shown at. One limit is real: the
 * GPU's largest point sprite. Viewer sprites reach the cap
 * (`POINT_SPRITE_MAX_PX`, 160 pixels, rendering/point-sprite.js), so above
 * `zoomLimit` raster pixels per viewer pixel a large sprite could not be
 * drawn at its size; the source is then rasterized at `zoomLimit` and scaled
 * the rest of the way when it is copied.
 *
 * @param {object} options
 * @param {Readonly<FigureSource>} options.source
 * @param {number} options.deviceWidth - integer device pixels
 * @param {number} options.deviceHeight
 * @param {number} options.zoomLimit - raster pixels per viewer pixel the GPU's
 *   point sprites allow (`exportSpriteZoomLimit`)
 * @returns {{width: number, height: number, zoom: number, exact: boolean}}
 *   raster size, raster pixels per viewer pixel, and whether the raster is
 *   copied one to one
 */
export function planPlotRaster({ source, deviceWidth, deviceHeight, zoomLimit }) {
  requirePositive(zoomLimit, 'Figure raster zoom limit');
  for (const [label, value] of [['width', deviceWidth], ['height', deviceHeight]]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Figure raster device ${label} must be a positive integer.`);
    }
  }
  const zoom = Math.min(deviceWidth / source.width, deviceHeight / source.height);
  if (zoom <= zoomLimit) {
    return { width: deviceWidth, height: deviceHeight, zoom, exact: true };
  }
  const reduce = zoomLimit / zoom;
  const width = Math.max(1, Math.round(deviceWidth * reduce));
  const height = Math.max(1, Math.round(deviceHeight * reduce));
  return {
    width,
    height,
    zoom: Math.min(width / source.width, height / source.height),
    exact: false,
  };
}
