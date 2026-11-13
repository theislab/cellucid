/**
 * Coding a categorical obs column by the categories its open cells hold
 * (a subsample's "present categories"): whether a read of some positions
 * fetches every chunk anyway (`touchesEveryChunk`, `chunkCount`), a view of
 * an array at those positions (`pickedArray`), the fewest bytes a category
 * is stored in (`leastCategoryBytes`), and merging categories found later
 * into a coding in stored order (`codesMissingFrom`, `mergedCoding`,
 * `positionsAmong`). Functions of their arguments; which coding a field
 * gets, and when, is the reader's (`_categoryCoding`).
 *
 * @module data/anndata/present-categories
 */

import { allocateTypedArray } from '../sparse-column-index.js';
import { isGroup } from '../../formats/store.js';
import { child, elementBytes } from './elements.js';

/**
 * Whether stored positions `positions` (ascending) lie in every chunk of a
 * chunked array: a read of them then fetches every chunk the whole array
 * has (and, for HDF5 strings, nearly every heap collection: a share of the
 * cells of a dictionary in label order names a few labels of each), so it
 * is read as the whole array is -- one plan, no more bytes or requests --
 * and the positions picked (`pickedArray`).
 */
export function touchesEveryChunk(array, positions) {
  const rows = Array.isArray(array?.chunks) && array.chunks.length > 0 ? array.chunks[0] : null;
  if (rows === null || !(rows > 0)) return false;
  const total = Math.ceil(array.shape[0] / rows);
  if (positions.length < total) return false;
  let touched = 0;
  let last = -1;
  for (let i = 0; i < positions.length; i++) {
    const chunk = Math.floor(positions[i] / rows);
    if (chunk !== last) {
      touched++;
      last = chunk;
    }
  }
  return touched === total;
}

/**
 * How many chunks along its rows a dictionary is decoded in (a nullable
 * one's values'), or null when it is read by its bytes (stored in one piece,
 * or unfiltered chunks): a share of its rows then reads only theirs.
 */
export function chunkCount(categories) {
  const node = isGroup(categories) ? child(categories, 'values') : categories;
  const rows = Array.isArray(node?.chunks) && node.chunks.length > 0 && node.partialChunks !== true ? node.chunks[0] : null;
  return rows === null || !(rows > 0) ? null : Math.ceil(node.shape[0] / rows);
}

/** An array read whole, its values at `positions` handed out (`touchesEveryChunk`). */
export function pickedArray(array, positions) {
  return {
    shape: [positions.length],
    dtype: array.dtype,
    async read(selection, options) {
      const [[start, end]] = selection;
      const all = await array.read([[0, array.shape[0]]], options);
      const out = ArrayBuffer.isView(all) ? allocateTypedArray(all.constructor, end - start, 'Picked values') : new Array(end - start);
      for (let i = start; i < end; i++) out[i - start] = all[positions[i]];
      return out;
    },
  };
}

/**
 * The fewest bytes one category of a dictionary is stored in: an HDF5
 * variable-length string's reference and its global heap object's header
 * (the label's own bytes come on top), a Zarr variable-length item's length
 * prefix and one byte, a fixed-size element's size. A nullable dictionary
 * (a group) counts its values array's.
 */
export function leastCategoryBytes(categories) {
  const node = isGroup(categories) ? child(categories, 'values') : categories;
  if (node?.dtype?.variable !== true) return elementBytes(node);
  return node.hdf5 !== undefined ? (node.info?.type?.size ?? 16) + 16 : 5;
}

/**
 * The stored categories `codes` name (each -1, missing, or a stored
 * position) that `known` (ascending stored positions) lacks, ascending.
 *
 * @param {Int32Array} codes
 * @param {Uint32Array} known
 * @returns {Uint32Array}
 */
export function codesMissingFrom(codes, known) {
  const sorted = allocateTypedArray(Int32Array, codes.length, 'Categorical codes');
  sorted.set(codes);
  sorted.sort();
  let count = 0;
  let previous = -1;
  let k = 0;
  for (let i = 0; i < sorted.length; i++) {
    const code = sorted[i];
    if (code < 0 || code === previous) continue;
    previous = code;
    while (k < known.length && known[k] < code) k++;
    if (k < known.length && known[k] === code) continue;
    sorted[count++] = code;
  }
  return Uint32Array.from(sorted.subarray(0, count));
}

/**
 * A present-categories coding (`_categoryCoding`) with the stored categories
 * `added` (ascending, with their `labels` and `colors`) put in stored order
 * among its own; any it holds already (found by a read that ended first)
 * kept as it was. Colors stay only while every category found has one.
 */
export function mergedCoding(coding, added, labels, colors, key) {
  const { stored } = coding;
  const total = stored.length + added.length;
  const mergedStored = allocateTypedArray(Uint32Array, total, `obs['${key}'] categories`);
  const mergedLabels = new Array(total);
  const keepColors = coding.colors !== null || stored.length === 0;
  const mergedColors = keepColors && colors !== null ? new Array(total) : null;
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < stored.length || j < added.length) {
    if (j >= added.length || (i < stored.length && stored[i] <= added[j])) {
      if (j < added.length && stored[i] === added[j]) j++;
      mergedStored[n] = stored[i];
      mergedLabels[n] = coding.labels[i];
      if (mergedColors !== null) mergedColors[n] = coding.colors[i];
      i++;
    } else {
      mergedStored[n] = added[j];
      mergedLabels[n] = labels[j];
      if (mergedColors !== null) mergedColors[n] = colors[j];
      j++;
    }
    n++;
  }
  return {
    present: true,
    count: coding.count,
    stored: mergedStored.slice(0, n),
    labels: Object.freeze(mergedLabels.slice(0, n)),
    colors: mergedColors === null ? null : Object.freeze(mergedColors.slice(0, n)),
  };
}

/** Each stored code's position among `stored` (ascending), -1 missing: a code `stored` lacks is a reader defect. */
export function positionsAmong(codes, stored, key) {
  const positions = allocateTypedArray(Int32Array, codes.length, `obs['${key}'] codes`);
  let lastCode = -1;
  let lastPosition = -1;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code < 0) {
      positions[i] = -1;
      continue;
    }
    if (code !== lastCode) {
      let low = 0;
      let high = stored.length - 1;
      lastPosition = -1;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        if (stored[middle] < code) low = middle + 1;
        else if (stored[middle] > code) high = middle - 1;
        else {
          lastPosition = middle;
          break;
        }
      }
      if (lastPosition < 0) throw new Error(`Categorical code ${code} for '${key}' names a category that was not read`);
      lastCode = code;
    }
    positions[i] = lastPosition;
  }
  return positions;
}
