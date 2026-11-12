/**
 * @fileoverview Model space → figure plot space, for the vector reference layers.
 *
 * The reference grid (`components/reference-grid.js`) and the studio backdrop
 * (`components/studio-backdrop-export.js`) both reproduce a viewer layer as
 * vectors: they project model-space geometry through the pane's MVP matrix,
 * clip it against the near and far planes exactly, and place the viewport —
 * or the framing crop inside it — onto the plot rectangle the way the point
 * layer is placed (`createPlotPlacement`: the plot has the view's aspect and
 * the view fills it). One mapping keeps every layer of a figure registered
 * with the others.
 *
 * @module ui/modules/figure-export/utils/plot-projection
 */

import { createPlotPlacement } from './plot-fit.js';

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
 * The viewport-to-plot placement of one pane (`createPlotPlacement`): its
 * source — the whole viewport, or the framing crop inside it — fills the plot
 * rectangle, which has the source's aspect.
 *
 * `srcX0`, `srcY0`, `srcW`, `srcH` are the source in the pane's viewport
 * pixels; `scale` is plot units per viewport pixel.
 *
 * @param {object} options
 * @param {{ viewportWidth: number; viewportHeight: number }} options.renderState
 * @param {{ x: number; y: number; width: number; height: number }} options.plotRect
 * @param {object|null} [options.crop]
 */
export function createPlotProjection({ renderState, plotRect, crop = null }) {
  const { source, scale, viewportToPlot } = createPlotPlacement({ renderState, plotRect, crop });
  const viewportW = source.viewportWidth;
  const viewportH = source.viewportHeight;

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
    srcX0: source.x,
    srcY0: source.y,
    srcW: source.width,
    srcH: source.height,
    scale,
    viewportToPlot,
    clipToViewport,
    toPlot,
  };
}

/** Inverse of a column-major 4x4 matrix, or null when it is singular. */
export function invertMatrix4(m) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(det) || det === 0) return null;
  const inv = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * inv,
    (a02 * b10 - a01 * b11 - a03 * b09) * inv,
    (a31 * b05 - a32 * b04 + a33 * b03) * inv,
    (a22 * b04 - a21 * b05 - a23 * b03) * inv,
    (a12 * b08 - a10 * b11 - a13 * b07) * inv,
    (a00 * b11 - a02 * b08 + a03 * b07) * inv,
    (a32 * b02 - a30 * b05 - a33 * b01) * inv,
    (a20 * b05 - a22 * b02 + a23 * b01) * inv,
    (a10 * b10 - a11 * b08 + a13 * b06) * inv,
    (a01 * b08 - a00 * b10 - a03 * b06) * inv,
    (a30 * b04 - a31 * b02 + a33 * b00) * inv,
    (a21 * b02 - a20 * b04 - a23 * b00) * inv,
    (a11 * b07 - a10 * b09 - a12 * b06) * inv,
    (a00 * b09 - a01 * b07 + a02 * b06) * inv,
    (a31 * b01 - a30 * b03 - a32 * b00) * inv,
    (a20 * b03 - a21 * b01 + a22 * b00) * inv,
  ];
}
