/**
 * @fileoverview Coordinate mapping utilities for figure export.
 *
 * Cellucid renders normalized positions in [-1, 1]. For publication figures we
 * often want "real" coordinates, so we reverse the normalization transform
 * captured by the DimensionManager.
 *
 * @module ui/modules/figure-export/utils/coordinate-mapper
 */

import { cropRect01ToPx, normalizeCropRect01 } from './crop.js';

/**
 * @typedef {object} NormTransform
 * @property {[number, number, number]} center
 * @property {number} scale
 */

/**
 * @param {number} x
 * @param {number} y
 * @param {NormTransform} transform
 * @returns {{ x: number, y: number }}
 */
export function denormalizeXY(x, y, transform) {
  const scale = transform?.scale || 1;
  const center = transform?.center || [0, 0, 0];
  return {
    x: (x / scale) + (center[0] || 0),
    y: (y / scale) + (center[1] || 0),
  };
}

/**
 * Compute coordinate bounds for the currently visible region by scanning points
 * that fall within clip space.
 *
 * If `normTransform` is available, bounds are reported in "real" (denormalized)
 * coordinates; otherwise bounds fall back to the normalized coordinate space.
 *
 * This is conservative and fast: it does not attempt to reconstruct viewport
 * corners, but matches what is actually drawn (after filtering + clipping).
 *
 * @param {object} options
 * @param {Float32Array|null} options.positions - normalized positions (n*3)
 * @param {Float32Array|null} [options.transparency] - per-point alpha (0..1)
 * @param {Float32Array|null} [options.visibilityMask] - optional LOD visibility mask (1 = visible)
 * @param {Float32Array} options.mvpMatrix
 * @param {number} [options.viewportWidth]
 * @param {number} [options.viewportHeight]
 * @param {{ enabled?: boolean; x?: number; y?: number; width?: number; height?: number } | null} [options.crop]
 * @param {NormTransform|null} [options.normTransform]
 * @returns {{ minX: number, maxX: number, minY: number, maxY: number } | null}
 */
export function computeVisibleRealBounds({
  positions,
  transparency = null,
  visibilityMask = null,
  mvpMatrix,
  viewportWidth = 1,
  viewportHeight = 1,
  crop = null,
  normTransform = null
}) {
  if (!positions || !mvpMatrix) return null;

  const n = Math.floor(positions.length / 3);
  const m = mvpMatrix;
  const vw = Math.max(1, Number(viewportWidth) || 1);
  const vh = Math.max(1, Number(viewportHeight) || 1);
  const crop01 = normalizeCropRect01(crop);
  const cropPx = cropRect01ToPx(crop01, vw, vh);
  const hasCrop = Boolean(
    cropPx &&
    (cropPx.width < vw - 0.5 || cropPx.height < vh - 0.5 || cropPx.x > 0.5 || cropPx.y > 0.5)
  );

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let any = false;

  for (let i = 0; i < n; i++) {
    if (visibilityMask && (visibilityMask[i] ?? 0) <= 0) continue;
    const rawAlpha = transparency ? (transparency[i] ?? 1.0) : 1.0;
    let alpha = Number.isFinite(rawAlpha) ? rawAlpha : 1.0;
    if (alpha < 0) alpha = 0;
    else if (alpha > 1) alpha = 1;
    if (alpha < 0.01) continue;

    const ix = i * 3;
    const x = positions[ix];
    const y = positions[ix + 1];
    const z = positions[ix + 2];

    const clipX = m[0] * x + m[4] * y + m[8] * z + m[12];
    const clipY = m[1] * x + m[5] * y + m[9] * z + m[13];
    const clipW = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!Number.isFinite(clipW) || clipW === 0) continue;

    const ndcX = clipX / clipW;
    const ndcY = clipY / clipW;
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;

    if (hasCrop && cropPx) {
      const vx = (ndcX * 0.5 + 0.5) * vw;
      const vy = (-ndcY * 0.5 + 0.5) * vh;
      if (vx < cropPx.x || vx > cropPx.x + cropPx.width || vy < cropPx.y || vy > cropPx.y + cropPx.height) continue;
    }

    const real = denormalizeXY(x, y, normTransform);
    if (!Number.isFinite(real.x) || !Number.isFinite(real.y)) continue;
    if (real.x < minX) minX = real.x;
    if (real.x > maxX) maxX = real.x;
    if (real.y < minY) minY = real.y;
    if (real.y > maxY) maxY = real.y;
    any = true;
  }

  if (!any) return null;
  return { minX, maxX, minY, maxY };
}

/**
 * Compute camera-space (view-space) bounds for the currently visible region.
 *
 * Useful for 3D views where the screen-space X/Y axes are not aligned to the
 * underlying embedding axes. Bounds are computed from `viewMatrix * position`
 * (before perspective projection).
 *
 * @param {object} options
 * @param {Float32Array|null} options.positions - normalized positions (n*3)
 * @param {Float32Array|null} [options.transparency] - per-point alpha (0..1)
 * @param {Float32Array|null} [options.visibilityMask] - optional LOD visibility mask (1 = visible)
 * @param {Float32Array} options.mvpMatrix
 * @param {Float32Array} options.viewMatrix
 * @param {number} [options.viewportWidth]
 * @param {number} [options.viewportHeight]
 * @param {{ enabled?: boolean; x?: number; y?: number; width?: number; height?: number } | null} [options.crop]
 * @returns {{ minX: number, maxX: number, minY: number, maxY: number } | null}
 */
export function computeVisibleCameraBounds({
  positions,
  transparency = null,
  visibilityMask = null,
  mvpMatrix,
  viewMatrix,
  viewportWidth = 1,
  viewportHeight = 1,
  crop = null,
}) {
  if (!positions || !mvpMatrix || !viewMatrix) return null;

  const n = Math.floor(positions.length / 3);
  const m = mvpMatrix;
  const v = viewMatrix;
  const vw = Math.max(1, Number(viewportWidth) || 1);
  const vh = Math.max(1, Number(viewportHeight) || 1);
  const crop01 = normalizeCropRect01(crop);
  const cropPx = cropRect01ToPx(crop01, vw, vh);
  const hasCrop = Boolean(
    cropPx &&
    (cropPx.width < vw - 0.5 || cropPx.height < vh - 0.5 || cropPx.x > 0.5 || cropPx.y > 0.5)
  );

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let any = false;

  for (let i = 0; i < n; i++) {
    if (visibilityMask && (visibilityMask[i] ?? 0) <= 0) continue;
    const rawAlpha = transparency ? (transparency[i] ?? 1.0) : 1.0;
    let alpha = Number.isFinite(rawAlpha) ? rawAlpha : 1.0;
    if (alpha < 0) alpha = 0;
    else if (alpha > 1) alpha = 1;
    if (alpha < 0.01) continue;

    const ix = i * 3;
    const x = positions[ix];
    const y = positions[ix + 1];
    const z = positions[ix + 2];

    const clipX = m[0] * x + m[4] * y + m[8] * z + m[12];
    const clipY = m[1] * x + m[5] * y + m[9] * z + m[13];
    const clipW = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!Number.isFinite(clipW) || clipW === 0) continue;

    const ndcX = clipX / clipW;
    const ndcY = clipY / clipW;
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;

    if (hasCrop && cropPx) {
      const vx = (ndcX * 0.5 + 0.5) * vw;
      const vy = (-ndcY * 0.5 + 0.5) * vh;
      if (vx < cropPx.x || vx > cropPx.x + cropPx.width || vy < cropPx.y || vy > cropPx.y + cropPx.height) continue;
    }

    const camX = v[0] * x + v[4] * y + v[8] * z + v[12];
    const camY = v[1] * x + v[5] * y + v[9] * z + v[13];
    if (!Number.isFinite(camX) || !Number.isFinite(camY)) continue;
    if (camX < minX) minX = camX;
    if (camX > maxX) maxX = camX;
    if (camY < minY) minY = camY;
    if (camY > maxY) maxY = camY;
    any = true;
  }

  if (!any) return null;
  return { minX, maxX, minY, maxY };
}
