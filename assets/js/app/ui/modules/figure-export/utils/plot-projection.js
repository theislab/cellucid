/**
 * @fileoverview Model space → figure plot space, for the vector reference layers.
 *
 * The reference grid (`components/reference-grid.js`) and the studio backdrop
 * (`components/studio-backdrop-export.js`) both reproduce a viewer layer as
 * vectors: they project model-space geometry through the pane's MVP matrix,
 * clip it against the near and far planes exactly, and place the viewport —
 * or the framing crop inside it — into the plot rectangle the way the point
 * layer is placed (uniform scale, centred). One mapping keeps every layer of
 * a figure registered with the others.
 *
 * @module ui/modules/figure-export/utils/plot-projection
 */

import { assertCropRect01, cropRect01ToPx } from './crop.js';

/**
 * Project a model-space point with a column-major MVP matrix.
 *
 * @param {Float32Array} mvp
 * @param {readonly number[]} p
 * @returns {{ x: number; y: number; z: number; w: number }}
 */
export function toClipSpace(mvp, p) {
  const [x, y, z] = p;
  return {
    x: mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12],
    y: mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13],
    z: mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14],
    w: mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15],
  };
}

/**
 * The sub-range of a segment that survives the near and far clip planes.
 * Clip coordinates are linear in the model-space parameter, so clipping in `t`
 * is exact rather than an approximation.
 *
 * @returns {[number, number]|null}
 */
export function clipSegmentDepthRange(c0, c1) {
  let tMin = 0;
  let tMax = 1;
  const distances = [
    [c0.z + c0.w, c1.z + c1.w],
    [c0.w - c0.z, c1.w - c1.z],
  ];
  for (const [d0, d1] of distances) {
    if (d0 < 0 && d1 < 0) return null;
    if (d0 === d1) continue;
    const t = d0 / (d0 - d1);
    if (d0 < 0) {
      if (t > tMin) tMin = t;
    } else if (d1 < 0) {
      if (t < tMax) tMax = t;
    }
  }
  if (!(tMax > tMin)) return null;
  return [tMin, tMax];
}

/** Linear interpolation between two 3-D points. */
export function lerpPoint(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/**
 * The viewport-to-plot placement of one pane.
 *
 * `viewportWidth`/`viewportHeight` are the pane's framebuffer pixels; the
 * source rectangle is the whole viewport, or the framing crop inside it.
 * `scale` is plot units per viewport pixel.
 *
 * @param {object} options
 * @param {{ viewportWidth: number; viewportHeight: number }} options.renderState
 * @param {{ x: number; y: number; width: number; height: number }} options.plotRect
 * @param {object|null} [options.crop]
 */
export function createPlotProjection({ renderState, plotRect, crop = null }) {
  const viewportW = Math.max(1, renderState.viewportWidth || 1);
  const viewportH = Math.max(1, renderState.viewportHeight || 1);

  const crop01 = assertCropRect01(crop);
  const cropPx = cropRect01ToPx(crop01, viewportW, viewportH);
  const hasCrop = Boolean(
    cropPx &&
    (
      cropPx.width < viewportW - 0.5 ||
      cropPx.height < viewportH - 0.5 ||
      cropPx.x > 0.5 ||
      cropPx.y > 0.5
    )
  );
  const srcX0 = hasCrop && cropPx ? cropPx.x : 0;
  const srcY0 = hasCrop && cropPx ? cropPx.y : 0;
  const srcW = hasCrop && cropPx ? cropPx.width : viewportW;
  const srcH = hasCrop && cropPx ? cropPx.height : viewportH;
  const scale = Math.min(plotRect.width / srcW, plotRect.height / srcH);
  const offsetX = plotRect.x + (plotRect.width - srcW * scale) / 2;
  const offsetY = plotRect.y + (plotRect.height - srcH * scale) / 2;

  /** Viewport pixel (top-left origin) → plot point. */
  const viewportToPlot = (vx, vy) => ({
    x: offsetX + (vx - srcX0) * scale,
    y: offsetY + (vy - srcY0) * scale,
  });

  /** Clip-space point → viewport pixel, or null behind the camera. */
  const clipToViewport = (clip) => {
    if (!(clip.w > 1e-9)) return null;
    return {
      x: (clip.x / clip.w * 0.5 + 0.5) * viewportW,
      y: (-clip.y / clip.w * 0.5 + 0.5) * viewportH,
    };
  };

  /** Clip-space point → plot point, or null behind the camera. */
  const toPlot = (clip) => {
    const viewport = clipToViewport(clip);
    return viewport === null ? null : viewportToPlot(viewport.x, viewport.y);
  };

  return {
    viewportW,
    viewportH,
    srcX0,
    srcY0,
    srcW,
    srcH,
    scale,
    viewportToPlot,
    clipToViewport,
    toPlot,
  };
}
