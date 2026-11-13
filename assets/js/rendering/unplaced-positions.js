/**
 * Cells an embedding does not place.
 *
 * A modality that did not measure every cell (MuData), or any embedding with
 * non-finite rows, gives those cells NaN positions in every axis: the one mark
 * of an unplaced cell, which survives growth, cuts, reorders, caches and
 * sessions with nothing beside it (the readers' contract). They are
 * still cells: filters count them, analyses and other embeddings keep them.
 * In a view of that embedding they are not drawn, picked, selected or joined
 * by an edge, and NaN never reaches the GPU:
 *
 * - **CPU.** NaN fails every comparison, so bounds and projections leave the
 *   cells out by themselves; a tree holds placed cells only
 *   (`buildSpatialTree`), so picking and culled draws never reach them; a
 *   consumer that walks the positions itself asks `isUnplacedCell`.
 * - **GPU.** A position store, an edge position texture or a smoke splat
 *   holds `UNPLACED_GPU_POSITION` for them (`positionsForGpu`, made only for
 *   a geometry that has unplaced cells, for the upload alone), and every
 *   vertex shader that reads a cell's position rejects it before
 *   rasterization (`UNPLACED_GLSL`): no per-frame work beyond the compare,
 *   and nothing per cell is kept.
 *
 * @module rendering/unplaced-positions
 */

import { allocateLargeArray } from '../utils/large-arrays.js';

/**
 * What a cell the embedding does not place holds on the GPU: finite, and far
 * beyond any coordinate an embedding or its transform produces.
 */
export const UNPLACED_GPU_POSITION = 3.0e38;

/**
 * GLSL: whether a position read from a store is an unplaced cell's
 * (`UNPLACED_GPU_POSITION`).
 */
export const UNPLACED_GLSL = `
// A cell its embedding does not place (rendering/unplaced-positions.js):
// rejected before rasterization.
bool isUnplacedPosition(vec3 position) { return abs(position.x) > 1.0e38; }
`;

/** Whether `cell` is unplaced in `positions` (`dimension` values a cell). */
export function isUnplacedCell(positions, dimension, cell) {
  const x = positions[cell * dimension];
  return x !== x;
}

/** Unplaced-cell counts of published position arrays (never written after). */
const UNPLACED_COUNTS = new WeakMap();

/**
 * Arrays of cell rows (positions, vectors) proven finite in every value or
 * NaN in every value of a row: scanned once (`requirePlacedOrUnplacedRows`),
 * or proven where they were made (the reader worker, `publishPositionBounds`,
 * `VectorFieldManager`). Not a proof of finiteness: a consumer that needs
 * every value finite checks `isProvenFiniteFloat32Array` instead.
 */
const PROVEN_CELL_ROWS = new WeakSet();

/** Whether `rows` was proven finite-or-unplaced row by row. */
export function isProvenCellRows(rows) {
  return PROVEN_CELL_ROWS.has(rows);
}

/** Record `rows` as proven finite-or-unplaced row by row (never written after publication). */
export function markProvenCellRows(rows) {
  PROVEN_CELL_ROWS.add(rows);
}

/**
 * Record how many cells of `positions` are unplaced, counted where they were
 * made (the reader worker's payload, `embedding-payload.js` `unplacedCount`):
 * `unplacedCountOf` then answers without a pass over the array (10M cells:
 * a pass of the page's first picture).
 *
 * @param {Float32Array} positions
 * @param {number} count
 */
export function publishUnplacedCount(positions, count) {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`An unplaced-cell count is a whole number of cells, not ${String(count)}.`);
  UNPLACED_COUNTS.set(positions, count);
}

/**
 * How many cells of `positions` are unplaced, counted once per array.
 *
 * @param {Float32Array} positions
 * @param {number} dimension
 * @returns {number}
 */
export function unplacedCountOf(positions, dimension) {
  let count = UNPLACED_COUNTS.get(positions);
  if (count === undefined) {
    count = 0;
    for (let at = 0; at < positions.length; at += dimension) {
      const x = positions[at];
      if (x !== x) count++;
    }
    UNPLACED_COUNTS.set(positions, count);
  }
  return count;
}

/**
 * Require every cell's row of `positions` to be finite in every axis, or NaN
 * in every axis (unplaced). Counts the unplaced cells on the way.
 *
 * @param {Float32Array} positions
 * @param {number} dimension
 * @param {string} label
 * @returns {Float32Array}
 */
export function requirePlacedOrUnplacedRows(positions, dimension, label) {
  let unplaced = 0;
  for (let at = 0; at < positions.length; at += dimension) {
    const x = positions[at];
    if (x !== x) {
      for (let axis = 1; axis < dimension; axis++) {
        const value = positions[at + axis];
        if (value === value) {
          throw new RangeError(`${label}: cell ${at / dimension} is NaN in one axis but not in every axis.`);
        }
      }
      unplaced++;
      continue;
    }
    for (let axis = 0; axis < dimension; axis++) {
      if (!Number.isFinite(positions[at + axis])) {
        throw new RangeError(`${label} value ${at + axis} must be finite, or NaN in every axis of an unplaced cell.`);
      }
    }
  }
  UNPLACED_COUNTS.set(positions, unplaced);
  PROVEN_CELL_ROWS.add(positions);
  return positions;
}

/**
 * The positions to upload: `positions` itself when every cell is placed,
 * else a copy (for the upload alone) with `UNPLACED_GPU_POSITION` in every
 * axis of an unplaced cell.
 *
 * @param {Float32Array} positions
 * @param {number} dimension
 * @returns {Float32Array}
 */
export function positionsForGpu(positions, dimension) {
  return rowsForGpu(positions, dimension, UNPLACED_GPU_POSITION);
}

/**
 * The vectors to upload (`components` values a cell): `vectors` itself when
 * every row is finite, else a copy (for the upload alone) with a zero vector
 * for a cell its embedding does not place (NaN components): no motion.
 *
 * @param {Float32Array} vectors
 * @param {number} components
 * @returns {Float32Array}
 */
export function vectorsForGpu(vectors, components) {
  return rowsForGpu(vectors, components, 0);
}

function rowsForGpu(rows, width, standIn) {
  if (unplacedCountOf(rows, width) === 0) return rows;
  const out = allocateLargeArray(Float32Array, rows.length);
  out.set(rows);
  for (let at = 0; at < out.length; at += width) {
    const x = out[at];
    if (x !== x) out.fill(standIn, at, at + width);
  }
  return out;
}
