/**
 * @fileoverview Hot-path point projection helper for figure export.
 *
 * PURPOSE:
 * Projects 3D points to 2D viewport coordinates for Canvas2D rendering.
 * This is the explicitly selected vector-projection renderer.
 *
 * PERFORMANCE DESIGN:
 * - Zero per-point allocations (all arrays pre-allocated)
 * - Manual mat4 × vec4 multiply (glMatrix-compatible column-major layout)
 * - Optional depth sorting with O(n) binned approach instead of O(n log n) sort
 * - Early culling of clipped points
 *
 * TRANSPARENCY HANDLING:
 * - The caller names what the colors' alpha byte is (`colorAlpha`,
 *   `requireColorAlphaMeaning`): the cells' layer (visibility is then the
 *   Uint8 transparency, 0 or 1, every cell shown without one) or a marker's
 *   own opacity (0..255; a transparency, when given, takes precedence)
 * - Points with alpha < 0.01 are skipped for performance
 *
 * DEPTH SORTING:
 * For 3D views, back-to-front rendering is crucial for correct alpha blending.
 * Uses binned depth sorting (default 256 bins) which is:
 * - O(n) instead of O(n log n)
 * - Memory efficient (only allocates for visible points)
 * - Configurable bin count for quality/performance tradeoff
 *
 * PLACEMENT:
 * The plot rectangle has the view's aspect (or the framing crop's), and the
 * view fills it exactly (`createPlotPlacement`, `projectIntoSource` in
 * `plot-fit.js`): the same placement every figure layer uses.
 *
 * SIZE:
 * Each point's radius is the sprite the viewer draws it as, at its own depth
 * (`createViewportPointDiameter` in `point-size.js`: size attenuation makes a
 * near point larger than a far one), times the plot's scale.
 *
 * @module ui/modules/figure-export/utils/point-projector
 */

import { requirePositionArray } from '../../../../../rendering/position-layout.js';
import { BENEATH_ALPHA_BYTE, UNREAD_ALPHA_BYTE, requireColorAlphaMeaning } from '../../../../../rendering/alpha-visibility.js';
import { createPlotPlacement, projectIntoSource } from './plot-fit.js';
import { createViewportPointDiameter } from './point-size.js';
import {
  assertDrawOrder,
  assertLodMembership,
  drawnSequence,
  requireFigurePointLayers,
  POINT_VISIBILITY_THRESHOLD,
} from './lod-membership.js';

/**
 * @typedef {object} RenderStateLike
 * @property {Float32Array} mvpMatrix
 * @property {Float32Array} viewMatrix
 * @property {Float32Array} modelMatrix
 * @property {Float32Array} lightDir
 * @property {number} fov
 * @property {number} sizeAttenuation
 * @property {number} viewportWidth
 * @property {number} viewportHeight
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
 * @param {Float32Array|null} options.positions - length = n*dimension
 * @param {1|2|3} options.dimension - components per position (axes the
 *   embedding does not have are zero)
 * @param {Uint8Array|null} options.colors - length = n*4 (RGBA)
 * @param {'layer'|'opacity'} options.colorAlpha - What the colors' alpha
 *   byte is (`requireColorAlphaMeaning`): the cells' layer, drawn beneath
 *   first, or a marker's opacity.
 * @param {Uint8Array|null} [options.transparency] - optional length = n (0 or 1)
 * @param {RenderStateLike} options.renderState
 * @param {PlotRect} options.plotRect
 * @param {number} options.pointDiameterViewportPx - the points' `u_pointSize`
 *   (the pane's point size times its level's multiplier); each point's
 *   radius is the sprite the viewer draws at its depth, in plot units
 * @param {import('../../../../../rendering/high-perf/renderer-contracts.js').LodMembership|null} [options.lodMembership]
 * @param {Uint32Array|null} [options.drawOrder] - The pane's full-detail draw
 *   order (`drawnSequence`); null draws in source order.
 * @param {{ enabled?: boolean; x?: number; y?: number; width?: number; height?: number } | null} [options.crop] - optional framing crop in normalized viewport coords
 * @param {boolean} [options.sortByDepth] - if true, draw back-to-front using binned depth ordering
 * @param {number} [options.depthBins]
 * @param {import('./lod-membership.js').FigurePointLayers|null} [options.pointLayers] -
 *   While some cells are not read: they come first in their own color at
 *   `pointDiameterViewportPx` (before every depth-sorted cell, as the pane
 *   draws them without depth writes), the cells read at
 *   `pointDiameterViewportPx * readScale`.
 * @param {(x: number, y: number, r: number, g: number, b: number, a: number, radius: number, index: number) => void} options.onPoint
 * @returns {{ drawn: number, skipped: number }}
 */
export function forEachProjectedPoint({
  positions,
  dimension,
  colors,
  colorAlpha,
  transparency = null,
  renderState,
  plotRect,
  pointDiameterViewportPx,
  lodMembership = null,
  drawOrder = null,
  crop = null,
  sortByDepth = false,
  depthBins = 256,
  pointLayers = null,
  onPoint
}) {
  const alphaIsOpacity = requireColorAlphaMeaning(colorAlpha, 'Figure-export projected colors') === 'opacity';
  const layers = alphaIsOpacity ? null : requireFigurePointLayers(pointLayers, 'Figure-export projected point layers');
  const unreadRgb = layers === null ? null : layers.unreadColor.map(channel => Math.round(channel * 255));
  const zeroRgb = layers === null ? null : layers.zeroColor.map(channel => Math.round(channel * 255));
  if (!(typeof pointDiameterViewportPx === 'number' && Number.isFinite(pointDiameterViewportPx) && pointDiameterViewportPx > 0)) {
    throw new RangeError('Figure-export point diameter must be a finite positive number.');
  }
  const readDiameter = pointDiameterViewportPx * (layers === null ? 1 : layers.readScale);
  const isUnread = i => layers !== null && colors[i * 4 + 3] === UNREAD_ALPHA_BYTE;
  // The gray of the cells with no value is drawn in the figure's own (`zeroCellColor`).
  const isZero = i => zeroRgb !== null && colors[i * 4 + 3] === BENEATH_ALPHA_BYTE;
  if (!positions || !colors || !renderState?.mvpMatrix) {
    return { drawn: 0, skipped: 0 };
  }
  // A point's opacity: its transparency, else (a marker's) its alpha byte,
  // else shown.
  const opacityOf = i => (
    transparency ? (transparency[i] ?? 1.0) : (alphaIsOpacity ? colors[i * 4 + 3] / 255 : 1.0)
  );

  const positionCount = requirePositionArray(
    positions,
    dimension,
    'Figure-export projected positions',
    { allowEmpty: true }
  );
  const n = Math.min(positionCount, Math.floor(colors.length / 4));
  assertLodMembership(lodMembership, {
    pointCount: positionCount,
  });
  assertDrawOrder(drawOrder, { pointCount: positionCount });
  const admittedIndices = drawnSequence(lodMembership, drawOrder, alphaIsOpacity ? null : colors, layers?.readEveryLevel === true);
  const candidateCount = admittedIndices?.length ?? n;
  const mvp = renderState.mvpMatrix;
  const { source, viewportToPlot } = createPlotPlacement({ renderState, plotRect, crop });
  const origin = viewportToPlot(source.x, source.y);
  const plotX0 = origin.x;
  const plotY0 = origin.y;
  const scaleX = plotRect.width / source.width;
  const scaleY = plotRect.height / source.height;
  // A projected point: source-local x, y (viewport pixels) and NDC depth.
  const local = new Float64Array(3);
  // The radius (plot units) of a point drawn with `u_pointSize` = `pointSize`.
  const diameterAt = createViewportPointDiameter(renderState);
  const radiusAt = (x, y, z, pointSize) => diameterAt(x, y, z, pointSize) * scaleX * 0.5;

  let drawn = 0;
  let skipped = n - candidateCount;

  // A point at index `i` projected into the plot, or false where it is not
  // drawn: x, y in `projected`, and its model position in `at`.
  const projected = [0, 0];
  const at = [0, 0, 0];
  const project = i => {
    const rawAlpha = opacityOf(i);
    let alpha = Number.isFinite(rawAlpha) ? rawAlpha : 1.0;
    if (alpha < 0) alpha = 0;
    else if (alpha > 1) alpha = 1;
    if (alpha < POINT_VISIBILITY_THRESHOLD) return 0;
    const ix = i * dimension;
    const x = positions[ix];
    const y = dimension > 1 ? positions[ix + 1] : 0;
    const z = dimension > 2 ? positions[ix + 2] : 0;
    if (!projectIntoSource(mvp, source, x, y, z, local)) return 0;
    projected[0] = plotX0 + local[0] * scaleX;
    projected[1] = plotY0 + local[1] * scaleY;
    at[0] = x;
    at[1] = y;
    at[2] = z;
    return alpha;
  };

  // The binned sort is O(n) in time and memory, so a requested depth sort is
  // honored at every point count.
  if (sortByDepth) {
    // Cells not read lead the sequence (`drawnSequence`) and lie under every
    // cell read whatever their depth: drawn first, in sequence order.
    let unreadDrawn = 0;
    if (layers !== null) {
      for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex++) {
        const i = admittedIndices === null ? candidateIndex : admittedIndices[candidateIndex];
        if (!isUnread(i)) break;
        const alpha = project(i);
        if (alpha === 0) continue;
        onPoint(projected[0], projected[1], unreadRgb[0], unreadRgb[1], unreadRgb[2], alpha, radiusAt(at[0], at[1], at[2], pointDiameterViewportPx), i);
        unreadDrawn++;
      }
    }
    let bins = depthBins | 0;
    if (bins < 16) bins = 16;
    else if (bins > 1024) bins = 1024;
    const counts = new Uint32Array(bins);
    let total = 0;

    // Pass 1: count visible points per depth bin.
    for (
      let candidateIndex = 0;
      candidateIndex < candidateCount;
      candidateIndex++
    ) {
      const i = admittedIndices === null
        ? candidateIndex
        : admittedIndices[candidateIndex];
      if (isUnread(i)) continue;
      const rawAlpha = opacityOf(i);
      let alpha = Number.isFinite(rawAlpha) ? rawAlpha : 1.0;
      if (alpha < 0) alpha = 0;
      else if (alpha > 1) alpha = 1;
      if (alpha < POINT_VISIBILITY_THRESHOLD) continue;

      const ix = i * dimension;
      const x = positions[ix];
      const y = dimension > 1 ? positions[ix + 1] : 0;
      const z = dimension > 2 ? positions[ix + 2] : 0;

      if (!projectIntoSource(mvp, source, x, y, z, local)) continue;
      const ndcZ = local[2];
      let bin = (((ndcZ + 1) * 0.5) * bins) | 0;
      if (bin < 0) bin = 0;
      else if (bin >= bins) bin = bins - 1;
      counts[bin]++;
      total++;
    }

    if (total === 0) return { drawn: unreadDrawn, skipped: n - unreadDrawn };

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
    const outRadius = new Float32Array(total);
    const outIndex = new Uint32Array(total);

    // Pass 2: fill packed arrays in bin order.
    for (
      let candidateIndex = 0;
      candidateIndex < candidateCount;
      candidateIndex++
    ) {
      const i = admittedIndices === null
        ? candidateIndex
        : admittedIndices[candidateIndex];
      if (isUnread(i)) continue;
      const rawAlpha = opacityOf(i);
      let alpha = Number.isFinite(rawAlpha) ? rawAlpha : 1.0;
      if (alpha < 0) alpha = 0;
      else if (alpha > 1) alpha = 1;
      if (alpha < POINT_VISIBILITY_THRESHOLD) continue;

      const ix = i * dimension;
      const x = positions[ix];
      const y = dimension > 1 ? positions[ix + 1] : 0;
      const z = dimension > 2 ? positions[ix + 2] : 0;

      if (!projectIntoSource(mvp, source, x, y, z, local)) continue;
      const ndcZ = local[2];

      let bin = (((ndcZ + 1) * 0.5) * bins) | 0;
      if (bin < 0) bin = 0;
      else if (bin >= bins) bin = bins - 1;
      const slot = offsets[bin] + counts[bin]++;

      outX[slot] = plotX0 + local[0] * scaleX;
      outY[slot] = plotY0 + local[1] * scaleY;

      const cj = i * 4;
      const oj = slot * 4;
      const zero = isZero(i);
      outRGBA[oj] = zero ? zeroRgb[0] : colors[cj];
      outRGBA[oj + 1] = zero ? zeroRgb[1] : colors[cj + 1];
      outRGBA[oj + 2] = zero ? zeroRgb[2] : colors[cj + 2];
      outRGBA[oj + 3] = colors[cj + 3];
      outA[slot] = alpha;
      outRadius[slot] = radiusAt(x, y, z, readDiameter);
      outIndex[slot] = i;
    }

    // We built slots grouped by bin ascending; draw descending by iterating bins.
    for (let b = bins - 1; b >= 0; b--) {
      const start = offsets[b];
      const end = start + counts[b];
      for (let s = start; s < end; s++) {
        const a = outA[s];
        if (a < POINT_VISIBILITY_THRESHOLD) continue;
        const oj = s * 4;
        onPoint(outX[s], outY[s], outRGBA[oj], outRGBA[oj + 1], outRGBA[oj + 2], a, outRadius[s], outIndex[s]);
        drawn++;
      }
    }

    drawn += unreadDrawn;
    skipped = Math.max(0, n - drawn);
    return { drawn, skipped };
  }

  for (
    let candidateIndex = 0;
    candidateIndex < candidateCount;
    candidateIndex++
  ) {
    const i = admittedIndices === null
      ? candidateIndex
      : admittedIndices[candidateIndex];
    const rawAlpha = opacityOf(i);
    let alpha = Number.isFinite(rawAlpha) ? rawAlpha : 1.0;
    if (alpha < 0) alpha = 0;
    else if (alpha > 1) alpha = 1;
    if (alpha < POINT_VISIBILITY_THRESHOLD) {
      skipped++;
      continue;
    }

    const ix = i * dimension;
    const x = positions[ix];
    const y = dimension > 1 ? positions[ix + 1] : 0;
    const z = dimension > 2 ? positions[ix + 2] : 0;

    if (!projectIntoSource(mvp, source, x, y, z, local)) {
      skipped++;
      continue;
    }
    const px = plotX0 + local[0] * scaleX;
    const py = plotY0 + local[1] * scaleY;

    const j = i * 4;
    if (isUnread(i)) onPoint(px, py, unreadRgb[0], unreadRgb[1], unreadRgb[2], alpha, radiusAt(x, y, z, pointDiameterViewportPx), i);
    else if (isZero(i)) onPoint(px, py, zeroRgb[0], zeroRgb[1], zeroRgb[2], alpha, radiusAt(x, y, z, readDiameter), i);
    else onPoint(px, py, colors[j], colors[j + 1], colors[j + 2], alpha, radiusAt(x, y, z, readDiameter), i);
    drawn++;
  }

  return { drawn, skipped };
}
