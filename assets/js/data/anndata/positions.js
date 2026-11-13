/**
 * Positions a caller names, checked before anything is read: open cells or
 * genes as positions within their extent (`requirePositions`), the distinct
 * cells of a cell subset as one typed array (`requireDistinctCells`), and
 * whether two lists name the same cells in the same order (`sameCells`).
 * Pure functions of their arguments: what the positions are read for is the
 * reader's (`reader.js`).
 *
 * @module data/anndata/positions
 */

import { allocateTypedArray } from '../sparse-column-index.js';

/** Distinct-or-repeated whole positions within `[0, extent)`, as an array. */
export function requirePositions(values, extent, label) {
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) {
    throw new TypeError(`${label} positions must be an array`);
  }
  const positions = Array.from(values, Number);
  for (const position of positions) {
    if (!Number.isSafeInteger(position) || position < 0 || position >= extent) {
      throw new RangeError(`${label} ${String(position)} is outside [0, ${extent})`);
    }
  }
  return positions;
}

/**
 * The distinct cells of a cell subset (an analysis's groups: up to every
 * open cell) as one `Uint32Array`, checked without a JavaScript array or set
 * of them (a set of ten million positions held hundreds of megabytes of the
 * reader's heap, on every read of a run's genes): ascending cells in one
 * pass, any other order against a byte a cell.
 *
 * @param {ArrayLike<number>} values
 * @param {number} extent - Cells of the dataset
 * @param {string} label - The matrix, for errors
 * @returns {Uint32Array}
 */
export function requireDistinctCells(values, extent, label) {
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) {
    throw new TypeError(`${label} cell row positions must be an array`);
  }
  const cells = allocateTypedArray(Uint32Array, values.length, `${label} cell subset`);
  let ascending = true;
  let previous = -1;
  for (let k = 0; k < values.length; k++) {
    const position = Number(values[k]);
    if (!Number.isSafeInteger(position) || position < 0 || position >= extent) {
      throw new RangeError(`${label} cell row ${String(values[k])} is outside [0, ${extent})`);
    }
    if (position <= previous) ascending = false;
    previous = position;
    cells[k] = position;
  }
  if (!ascending) {
    const seen = allocateTypedArray(Uint8Array, extent, `${label} cell subset`);
    for (let k = 0; k < cells.length; k++) {
      if (seen[cells[k]] === 1) throw new RangeError(`A cell subset of ${label} names a cell more than once`);
      seen[cells[k]] = 1;
    }
  }
  return cells;
}

/** Whether two lists of cell positions are the same cells in the same order. */
export function sameCells(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
