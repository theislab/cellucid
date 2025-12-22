/**
 * @fileoverview Hot-path point projection helper for figure export.
 *
 * PURPOSE:
 * Projects 3D points to 2D viewport coordinates for Canvas2D rendering.
 * This is the fallback renderer when WebGL2 rasterization is unavailable.
 *
 * PERFORMANCE DESIGN:
 * - Zero per-point allocations (all arrays pre-allocated)
 * - Manual mat4 × vec4 multiply (glMatrix-compatible column-major layout)
 * - Optional depth sorting with O(n) binned approach instead of O(n log n) sort
 * - Early culling of clipped points
 *
 * TRANSPARENCY HANDLING:
 * - Accepts separate Float32 transparency array (0..1) OR uses RGBA alpha (0..255)
 * - Transparency array takes precedence when provided
 * - Points with alpha < 0.01 are skipped for performance
 *
 * DEPTH SORTING:
 * For 3D views, back-to-front rendering is crucial for correct alpha blending.
 * Uses binned depth sorting (default 256 bins) which is:
 * - O(n) instead of O(n log n)
 * - Memory efficient (only allocates for visible points)
 * - Configurable bin count for quality/performance tradeoff
 *
 * LETTERBOXING:
 * The viewer's viewport is letterboxed into the plot rectangle to maintain
 * aspect ratio without distortion. This matches the viewer's on-screen appearance.
 *
 * @module ui/modules/figure-export/utils/point-projector
 */

/**
 * @typedef {object} RenderStateLike
 * @property {Float32Array} mvpMatrix
 * @property {number} viewportWidth
 * @property {number} viewportHeight
 * @property {number} pointSize
 */

/**
 * @typedef {object} PlotRect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * Iterate visible points and call a callback with plot-space coordinates and RGBA.
 *
 * @param {object} options
 * @param {Float32Array|null} options.positions - length = n*3
 * @param {Uint8Array|null} options.colors - length = n*4 (RGBA)
 * @param {Float32Array|null} [options.transparency] - optional length = n (0..1)
 * @param {RenderStateLike} options.renderState
 * @param {PlotRect} options.plotRect
 * @param {number} [options.radiusPx]
 * @param {Float32Array|null} [options.visibilityMask] - optional per-point mask (0..1), e.g. LOD visibility
 * @param {boolean} [options.sortByDepth] - if true, draw back-to-front using binned depth ordering
 * @param {number} [options.depthBins]
 * @param {number} [options.maxSortedPoints]
 * @param {(x: number, y: number, r: number, g: number, b: number, a: number, radius: number, index: number) => void} options.onPoint
 * @returns {{ drawn: number, skipped: number }}
 */
export function forEachProjectedPoint({
  positions,
  colors,
  transparency = null,
  renderState,
  plotRect,
  radiusPx = 1.5,
  visibilityMask = null,
  sortByDepth = false,
  depthBins = 256,
  maxSortedPoints = 200000,
  onPoint
}) {
  if (!positions || !colors || !renderState?.mvpMatrix) {
    return { drawn: 0, skipped: 0 };
  }

  const n = Math.min(Math.floor(positions.length / 3), Math.floor(colors.length / 4));
  const mvp = renderState.mvpMatrix;
  const viewportW = Math.max(1, renderState.viewportWidth || 1);
  const viewportH = Math.max(1, renderState.viewportHeight || 1);

  // Fit current viewport into plotRect without distortion (letterbox/pillarbox).
  const scale = Math.min(plotRect.width / viewportW, plotRect.height / viewportH);
  const offsetX = plotRect.x + (plotRect.width - viewportW * scale) / 2;
  const offsetY = plotRect.y + (plotRect.height - viewportH * scale) / 2;

  let drawn = 0;
  let skipped = 0;

  const wantsDepthSort = Boolean(sortByDepth) && n <= Math.max(1, maxSortedPoints | 0);

  if (wantsDepthSort) {
    let bins = depthBins | 0;
    if (bins < 16) bins = 16;
    else if (bins > 1024) bins = 1024;
    const counts = new Uint32Array(bins);
    let total = 0;

    // Pass 1: count visible points per depth bin.
    for (let i = 0; i < n; i++) {
      const alpha = transparency ? (transparency[i] ?? 1.0) : (colors[i * 4 + 3] / 255);
      if (alpha < 0.01) continue;
      if (visibilityMask && (visibilityMask[i] ?? 0) <= 0) continue;

      const ix = i * 3;
      const x = positions[ix];
      const y = positions[ix + 1];
      const z = positions[ix + 2];

      const clipX = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
      const clipY = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
      const clipZ = mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14];
      const clipW = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
      if (!Number.isFinite(clipW) || clipW === 0) continue;

      const ndcX = clipX / clipW;
      const ndcY = clipY / clipW;
      const ndcZ = clipZ / clipW;
      if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1 || ndcZ < -1 || ndcZ > 1) continue;
      let bin = (((ndcZ + 1) * 0.5) * bins) | 0;
      if (bin < 0) bin = 0;
      else if (bin >= bins) bin = bins - 1;
      counts[bin]++;
      total++;
    }

    if (total === 0) return { drawn: 0, skipped: n };

    // Prefix sums -> offsets.
    const offsets = new Uint32Array(bins);
    let cursor = 0;
    for (let b = 0; b < bins; b++) {
      offsets[b] = cursor;
      cursor += counts[b];
      counts[b] = 0; // reuse as "filled" counter
    }

    const outX = new Float32Array(total);
    const outY = new Float32Array(total);
    const outRGBA = new Uint8Array(total * 4);
    const outA = new Float32Array(total);
    const outIndex = new Uint32Array(total);

    // Pass 2: fill packed arrays in bin order.
    for (let i = 0; i < n; i++) {
      const alpha = transparency ? (transparency[i] ?? 1.0) : (colors[i * 4 + 3] / 255);
      if (alpha < 0.01) continue;
      if (visibilityMask && (visibilityMask[i] ?? 0) <= 0) continue;

      const ix = i * 3;
      const x = positions[ix];
      const y = positions[ix + 1];
      const z = positions[ix + 2];

      const clipX = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
      const clipY = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
      const clipZ = mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14];
      const clipW = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
      if (!Number.isFinite(clipW) || clipW === 0) continue;

      const ndcX = clipX / clipW;
      const ndcY = clipY / clipW;
      const ndcZ = clipZ / clipW;
      if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1 || ndcZ < -1 || ndcZ > 1) continue;
      let bin = (((ndcZ + 1) * 0.5) * bins) | 0;
      if (bin < 0) bin = 0;
      else if (bin >= bins) bin = bins - 1;
      const slot = offsets[bin] + counts[bin]++;

      const viewportX = (ndcX * 0.5 + 0.5) * viewportW;
      const viewportY = (-ndcY * 0.5 + 0.5) * viewportH;
      outX[slot] = offsetX + viewportX * scale;
      outY[slot] = offsetY + viewportY * scale;

      const cj = i * 4;
      const oj = slot * 4;
      outRGBA[oj] = colors[cj];
      outRGBA[oj + 1] = colors[cj + 1];
      outRGBA[oj + 2] = colors[cj + 2];
      outRGBA[oj + 3] = colors[cj + 3];
      outA[slot] = alpha;
      outIndex[slot] = i;
    }

    // We built slots grouped by bin ascending; draw descending by iterating bins.
    for (let b = bins - 1; b >= 0; b--) {
      const start = offsets[b];
      const end = start + counts[b];
      for (let s = start; s < end; s++) {
        const a = outA[s];
        if (a < 0.01) continue;
        const oj = s * 4;
        onPoint(outX[s], outY[s], outRGBA[oj], outRGBA[oj + 1], outRGBA[oj + 2], a, radiusPx, outIndex[s]);
        drawn++;
      }
    }

    skipped = Math.max(0, n - drawn);
    return { drawn, skipped };
  }

  for (let i = 0; i < n; i++) {
    if (visibilityMask && (visibilityMask[i] ?? 0) <= 0) {
      skipped++;
      continue;
    }
    const alpha = transparency ? (transparency[i] ?? 1.0) : (colors[i * 4 + 3] / 255);
    if (alpha < 0.01) {
      skipped++;
      continue;
    }

    const ix = i * 3;
    const x = positions[ix];
    const y = positions[ix + 1];
    const z = positions[ix + 2];

    // Column-major mat4 × vec4 (x,y,z,1).
    const clipX = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
    const clipY = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
    const clipW = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];

    if (!Number.isFinite(clipW) || clipW === 0) {
      skipped++;
      continue;
    }

    const clipZ = mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14];
    const ndcX = clipX / clipW;
    const ndcY = clipY / clipW;
    const ndcZ = clipZ / clipW;

    // Outside clip-space; skip for export speed and smaller files.
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1 || ndcZ < -1 || ndcZ > 1) {
      skipped++;
      continue;
    }

    const viewportX = (ndcX * 0.5 + 0.5) * viewportW;
    const viewportY = (-ndcY * 0.5 + 0.5) * viewportH;

    const px = offsetX + viewportX * scale;
    const py = offsetY + viewportY * scale;

    const j = i * 4;
    onPoint(px, py, colors[j], colors[j + 1], colors[j + 2], alpha, radiusPx, i);
    drawn++;
  }

  return { drawn, skipped };
}
