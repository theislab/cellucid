/**
 * @fileoverview Coordinate mapping utilities for figure export.
 *
 * Cellucid renders normalized positions in [-1, 1]. For publication figures we
 * often want "real" coordinates, so we reverse the normalization transform
 * captured by the DimensionManager.
 *
 * @module ui/modules/figure-export/utils/coordinate-mapper
 */

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
 * Compute real-coordinate bounds for the currently visible region by scanning
 * points that fall within clip space.
 *
 * This is conservative and fast: it does not attempt to reconstruct viewport
 * corners, but matches what is actually drawn (after filtering + clipping).
 *
 * @param {object} options
 * @param {Float32Array|null} options.positions - normalized positions (n*3)
 * @param {Float32Array|null} [options.transparency] - per-point alpha (0..1)
 * @param {Float32Array} options.mvpMatrix
 * @param {NormTransform|null} options.normTransform
 * @returns {{ minX: number, maxX: number, minY: number, maxY: number } | null}
 */
export function computeVisibleRealBounds({
  positions,
  transparency = null,
  mvpMatrix,
  normTransform
}) {
  if (!positions || !mvpMatrix || !normTransform) return null;

  const n = Math.floor(positions.length / 3);
  const m = mvpMatrix;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let any = false;

  for (let i = 0; i < n; i++) {
    const alpha = transparency ? (transparency[i] ?? 1.0) : 1.0;
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

