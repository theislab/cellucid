/**
 * @fileoverview Coordinate mapping utilities for figure export.
 *
 * Cellucid renders normalized positions in [-1, 1]. For publication figures we
 * often want "real" coordinates, so we reverse the normalization transform
 * captured by the DimensionManager.
 *
 * A figure's axes are rulers of its plot (`computeSourceAxisBounds` in
 * `components/axes-builder.js`, which denormalizes with `denormalizeXY`).
 * Whether any cell is drawn at all is a pass over the cells, run in the
 * figure-export worker (`sourceHasDrawnCells`).
 *
 * @module ui/modules/figure-export/utils/coordinate-mapper
 */

import { requirePositionArray } from '../../../../../rendering/position-layout.js';
import { figureSourceRect, projectIntoSource } from './plot-fit.js';
import {
  assertLodMembership,
  POINT_VISIBILITY_THRESHOLD,
} from './lod-membership.js';

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
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError('Figure-export coordinates must be finite numbers.');
  }
  if (
    transform === null ||
    typeof transform !== 'object' ||
    Array.isArray(transform) ||
    Object.getPrototypeOf(transform) !== Object.prototype ||
    Object.keys(transform).sort().join(',') !== 'center,scale' ||
    !Array.isArray(transform.center) ||
    transform.center.length !== 3 ||
    transform.center.some((value) => !Number.isFinite(value)) ||
    !Number.isFinite(transform.scale) ||
    transform.scale <= 0
  ) {
    throw new TypeError(
      'Figure-export normalization transform must contain exact finite center and positive scale values.'
    );
  }
  const { scale, center } = transform;
  return {
    x: (x / scale) + center[0],
    y: (y / scale) + center[1],
  };
}

/**
 * Whether a figure of the pane draws any cell: one visible, admitted cell
 * that projects inside the view or the framing crop (`projectIntoSource`).
 * Stops at the first.
 *
 * @param {object} options
 * @param {Float32Array|null} options.positions - normalized positions (n*dimension)
 * @param {1|2|3} options.dimension - components per position
 * @param {Uint8Array|null} [options.transparency] - per-point visibility (0 or 1)
 * @param {import('../../../../../rendering/high-perf/renderer-contracts.js').LodMembership|null} [options.lodMembership]
 * @param {Float32Array} options.mvpMatrix
 * @param {number} options.viewportWidth
 * @param {number} options.viewportHeight
 * @param {object|null} [options.crop]
 * @returns {boolean}
 */
export function sourceHasDrawnCells({
  positions,
  dimension,
  transparency = null,
  lodMembership = null,
  mvpMatrix,
  viewportWidth,
  viewportHeight,
  crop = null,
}) {
  if (!positions || !mvpMatrix) return false;
  const source = figureSourceRect({ renderState: { viewportWidth, viewportHeight }, crop });
  const n = requirePositionArray(
    positions,
    dimension,
    'Figure-export positions',
    { allowEmpty: true }
  );
  assertLodMembership(lodMembership, { pointCount: n });
  const admittedIndices = lodMembership?.indices ?? null;
  const candidateCount = admittedIndices?.length ?? n;
  const local = new Float64Array(3);
  for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex++) {
    const i = admittedIndices === null ? candidateIndex : admittedIndices[candidateIndex];
    const rawAlpha = transparency ? (transparency[i] ?? 1.0) : 1.0;
    const alpha = Number.isFinite(rawAlpha) ? rawAlpha : 1.0;
    if (alpha < POINT_VISIBILITY_THRESHOLD) continue;
    const ix = i * dimension;
    const x = positions[ix];
    const y = dimension > 1 ? positions[ix + 1] : 0;
    const z = dimension > 2 ? positions[ix + 2] : 0;
    if (projectIntoSource(mvpMatrix, source, x, y, z, local)) return true;
  }
  return false;
}
