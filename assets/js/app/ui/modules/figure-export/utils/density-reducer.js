/**
 * @fileoverview Density-preserving point reduction for large exports.
 *
 * PURPOSE:
 * Reduces the number of points while preserving visual appearance.
 * Essential for exporting large datasets (50k-200k points) as SVG without
 * creating massive files that are slow to render.
 *
 * ALGORITHM:
 * Uses viewport-space grid-based reservoir sampling:
 * 1. Project all visible points to viewport coordinates
 * 2. Divide viewport into grid cells (default 160×160)
 * 3. For each cell, sample up to ceil(targetCount/visibleCells) points
 * 4. Sampling uses deterministic Mulberry32 PRNG with per-cell seeding
 *
 * WHY THIS APPROACH:
 * - Preserves density: dense clusters remain dense, sparse regions remain sparse
 * - Deterministic: same seed produces same output (reproducible exports)
 * - Memory efficient: O(n) two-pass algorithm (count then sample)
 * - Fast: no sorting required, linear time complexity
 *
 * OUTPUT:
 * Returns viewport-space coordinates (not clip-space or NDC) for direct
 * use in Canvas2D rendering without additional projection.
 *
 * @module ui/modules/figure-export/utils/density-reducer
 */

import { clamp } from '../../../../utils/number-utils.js';
import { createMulberry32 } from '../../../../utils/random-utils.js';
import { cropRect01ToPx, normalizeCropRect01 } from './crop.js';

/**
 * @typedef {object} ReducedViewportPoints
 * @property {Float32Array} x - viewport-space x (0..viewportWidth)
 * @property {Float32Array} y - viewport-space y (0..viewportHeight)
 * @property {Uint8Array} rgba - packed RGBA uint8 (n*4), alpha is NOT premultiplied
 * @property {Float32Array} alpha - per-point alpha (0..1)
 * @property {Uint32Array} index - source point index for each reduced point
 * @property {number} viewportWidth
 * @property {number} viewportHeight
 */

function clampInt(value, lo, hi) {
  return clamp(value | 0, lo, hi);
}

/**
 * Reduce points by density in viewport space.
 *
 * @param {object} options
 * @param {Float32Array|null} options.positions - n*3
 * @param {Uint8Array|null} options.colors - n*4
 * @param {Float32Array|null} [options.transparency] - n (0..1)
 * @param {Float32Array|null} [options.visibilityMask] - n (0..1), e.g. LOD visibility
 * @param {{ mvpMatrix: Float32Array; viewportWidth: number; viewportHeight: number }} options.renderState
 * @param {number} options.targetCount
 * @param {{ enabled?: boolean; x?: number; y?: number; width?: number; height?: number } | null} [options.crop]
 * @param {number} [options.gridSize=160]
 * @param {number|null} [options.maxScanPoints=null] - Optional cap for preview-mode sampling (skips points by stride)
 * @param {number} [options.seed=1337]
 * @returns {ReducedViewportPoints}
 */
export function reducePointsByDensity({
  positions,
  colors,
  transparency = null,
  visibilityMask = null,
  renderState,
  targetCount,
  crop = null,
  gridSize = 160,
  maxScanPoints = null,
  seed = 1337
}) {
  if (!positions || !colors || !renderState?.mvpMatrix) {
    return {
      x: new Float32Array(0),
      y: new Float32Array(0),
      rgba: new Uint8Array(0),
      alpha: new Float32Array(0),
      index: new Uint32Array(0),
      viewportWidth: renderState?.viewportWidth || 1,
      viewportHeight: renderState?.viewportHeight || 1
    };
  }

  const n = Math.min(Math.floor(positions.length / 3), Math.floor(colors.length / 4));
  const stride = maxScanPoints && maxScanPoints > 0 && maxScanPoints < n
    ? Math.max(1, Math.ceil(n / maxScanPoints))
    : 1;
  const viewportW = Math.max(1, renderState.viewportWidth || 1);
  const viewportH = Math.max(1, renderState.viewportHeight || 1);
  const mvp = renderState.mvpMatrix;

  const crop01 = normalizeCropRect01(crop);
  const cropPx = cropRect01ToPx(crop01, viewportW, viewportH);
  const hasCrop = Boolean(
    cropPx &&
    (cropPx.width < viewportW - 0.5 || cropPx.height < viewportH - 0.5 || cropPx.x > 0.5 || cropPx.y > 0.5)
  );
  const effW = hasCrop ? cropPx.width : viewportW;
  const effH = hasCrop ? cropPx.height : viewportH;

  const cols = clampInt(gridSize, 32, 512);
  const rows = clampInt(gridSize, 32, 512);
  const cellCount = cols * rows;

  const counts = new Uint32Array(cellCount);
  let visibleTotal = 0;

  // Pass 1: count points per cell (only visible + within clip).
  for (let i = 0; i < n; i += stride) {
    if (visibilityMask && (visibilityMask[i] ?? 0) <= 0) continue;
    const rawAlpha = transparency ? (transparency[i] ?? 1.0) : (colors[i * 4 + 3] / 255);
    let a = Number.isFinite(rawAlpha) ? rawAlpha : 1.0;
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    if (a < 0.01) continue;

    const ix = i * 3;
    const x = positions[ix];
    const y = positions[ix + 1];
    const z = positions[ix + 2];

    const clipX = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
    const clipY = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
    const clipW = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
    if (!Number.isFinite(clipW) || clipW === 0) continue;

    const ndcX = clipX / clipW;
    const ndcY = clipY / clipW;
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;

    let vx = (ndcX * 0.5 + 0.5) * viewportW;
    let vy = (-ndcY * 0.5 + 0.5) * viewportH;
    if (hasCrop && cropPx) {
      if (vx < cropPx.x || vx > cropPx.x + cropPx.width || vy < cropPx.y || vy > cropPx.y + cropPx.height) continue;
      vx -= cropPx.x;
      vy -= cropPx.y;
    }

    const cx = clampInt((vx / effW) * cols, 0, cols - 1);
    const cy = clampInt((vy / effH) * rows, 0, rows - 1);
    counts[cy * cols + cx]++;
    visibleTotal++;
  }

  if (visibleTotal <= 0) {
    return {
      x: new Float32Array(0),
      y: new Float32Array(0),
      rgba: new Uint8Array(0),
      alpha: new Float32Array(0),
      index: new Uint32Array(0),
      viewportWidth: viewportW,
      viewportHeight: viewportH
    };
  }

  const desiredTotal = clampInt(Math.floor(targetCount || 0), 1, visibleTotal);

  // Desired points per cell (proportional + at least 1 for non-empty cells).
  const desired = new Uint32Array(cellCount);
  let desiredSum = 0;
  for (let c = 0; c < cellCount; c++) {
    const count = counts[c];
    if (!count) continue;
    const keep = Math.max(1, Math.round((count / visibleTotal) * desiredTotal));
    desired[c] = keep;
    desiredSum += keep;
  }

  // Normalize if rounding pushed us above the target.
  if (desiredSum > desiredTotal) {
    const scale = desiredTotal / desiredSum;
    desiredSum = 0;
    for (let c = 0; c < cellCount; c++) {
      const count = counts[c];
      if (!count) continue;
      const keep = Math.max(1, Math.floor(desired[c] * scale));
      desired[c] = keep;
      desiredSum += keep;
    }
  }

  // Compute per-cell offsets into packed output arrays.
  const offsets = new Uint32Array(cellCount);
  let cursor = 0;
  for (let c = 0; c < cellCount; c++) {
    offsets[c] = cursor;
    cursor += desired[c];
  }
  const outCount = cursor;

  const outX = new Float32Array(outCount);
  const outY = new Float32Array(outCount);
  const outRGBA = new Uint8Array(outCount * 4);
  const outA = new Float32Array(outCount);
  const outIndex = new Uint32Array(outCount);

  const seen = new Uint32Array(cellCount);
  const rnd = createMulberry32(seed);

  // Pass 2: per-cell reservoir sampling.
  for (let i = 0; i < n; i += stride) {
    if (visibilityMask && (visibilityMask[i] ?? 0) <= 0) continue;
    const rawAlpha = transparency ? (transparency[i] ?? 1.0) : (colors[i * 4 + 3] / 255);
    let a = Number.isFinite(rawAlpha) ? rawAlpha : 1.0;
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    if (a < 0.01) continue;

    const ix = i * 3;
    const x = positions[ix];
    const y = positions[ix + 1];
    const z = positions[ix + 2];

    const clipX = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
    const clipY = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
    const clipW = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
    if (!Number.isFinite(clipW) || clipW === 0) continue;

    const ndcX = clipX / clipW;
    const ndcY = clipY / clipW;
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;

    let vx = (ndcX * 0.5 + 0.5) * viewportW;
    let vy = (-ndcY * 0.5 + 0.5) * viewportH;
    if (hasCrop && cropPx) {
      if (vx < cropPx.x || vx > cropPx.x + cropPx.width || vy < cropPx.y || vy > cropPx.y + cropPx.height) continue;
      vx -= cropPx.x;
      vy -= cropPx.y;
    }

    const cx = clampInt((vx / effW) * cols, 0, cols - 1);
    const cy = clampInt((vy / effH) * rows, 0, rows - 1);
    const cell = cy * cols + cx;
    const want = desired[cell];
    if (!want) continue;

    const k = ++seen[cell];
    let slot;
    if (k <= want) {
      slot = offsets[cell] + (k - 1);
    } else {
      const j = Math.floor(rnd() * k);
      if (j >= want) continue;
      slot = offsets[cell] + j;
    }

    outX[slot] = vx;
    outY[slot] = vy;
    const cj = i * 4;
    const oj = slot * 4;
    outRGBA[oj] = colors[cj];
    outRGBA[oj + 1] = colors[cj + 1];
    outRGBA[oj + 2] = colors[cj + 2];
    outRGBA[oj + 3] = 255;
    outA[slot] = a;
    outIndex[slot] = i;
  }

  return {
    x: outX,
    y: outY,
    rgba: outRGBA,
    alpha: outA,
    index: outIndex,
    viewportWidth: effW,
    viewportHeight: effH
  };
}
