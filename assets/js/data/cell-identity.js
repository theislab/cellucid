/**
 * Which of a dataset's cells are open, and how a cell is named across every
 * boundary.
 *
 * A dataset may be opened whole or as a subsample (`subsample.js`). Inside
 * the app every per-cell array is in **subset positions**: cell `i` is the
 * `i`-th open cell, `0 <= i < n`. Everything that leaves the app — viewer
 * protocol events and commands, a session's per-cell chunks, exports, what
 * Python and R pull — names a cell by its **original position**, its row in
 * the file's `obs`, `0 <= p < nOriginal`. A cell identity is the one map
 * between the two:
 *
 * - `kept` is `null` when every cell is open (`toOriginal` and
 *   `fromOriginal` are then the identity), else an ascending `Uint32Array`
 *   of the original positions of the open cells, `kept[i]` being cell `i`.
 * - `toOriginal(positions)` names subset positions by original position
 *   (`originalAt(position)` one, unchecked, for a tight loop).
 * - `fromOriginal(originals)` finds the subset positions of the original
 *   positions that are open, as a cell list (ascending); `dropped` counts
 *   those that are not (a selection saved on more cells than are open now).
 * - `openPositionsOf(originals)` finds the open position of each original
 *   position, entry by entry (-1 where the cell is not open).
 * - `openValues(column, ArrayType, missing)` lays a per-cell column named by
 *   original position (a value per cell of the dataset, or `cells` and their
 *   values) out over the open cells.
 * - `originalValues(positions, values)` names the values of open cells by
 *   original position, ascending: the inverse of `openValues`.
 * - `ascendingOrder` relates open order to the open cells by ascending
 *   original position (the order a session stores per-cell data in).
 * - `digest` names the open set: equal digests mean the same cells of a
 *   dataset of the same size. It is specified with the subsampling
 *   algorithms (docs: "Subsampling specification", "Cell set digest") and
 *   computed the same way in Python and R.
 *
 * `encodeCellSet`/`decodeCellSet` write and read the open set as the
 * compact bytes a session stores (specification: "Cell set encoding").
 *
 * Every per-cell value that crosses between open positions and original
 * positions goes through these functions, never through `kept` or
 * `openOrder` read on their own: the open cells may be a subset (`kept`), in
 * another order than their original one (`openOrder`), or both.
 *
 * @module data/cell-identity
 */

import { formatCountOf } from '../utils/format-units.js';
import { allocateTypedArray } from './sparse-column-index.js';

/**
 * The 32-bit finaliser every subsampling hash uses (MurmurHash3 `fmix32`):
 * a bijection on uint32 with full avalanche.
 *
 * @param {number} h
 * @returns {number} uint32
 */
export function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function assertCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} must be an integer in [0, 2^32 - 1]; got ${value}.`);
  }
}

/**
 * Digest of a cell set: the open cells' original positions, ascending, of a
 * dataset of `nObs` cells, as 16 lowercase hex digits (two 32-bit lanes).
 * `kept` null is every cell.
 *
 * @param {number} nObs
 * @param {Uint32Array|null} kept
 * @returns {string}
 */
export function cellSetDigest(nObs, kept) {
  assertCount(nObs, 'Cell set size');
  const k = kept === null ? nObs : kept.length;
  let a = (0x811c9dc5 ^ nObs) >>> 0;
  let b = (0x9e3779b9 ^ k) >>> 0;
  for (let i = 0; i < k; i++) {
    const p = kept === null ? i : kept[i];
    a = Math.imul(a ^ p, 0x01000193) >>> 0;
    const x = (b ^ p) >>> 0;
    b = (Math.imul((x << 13) | (x >>> 19), 5) + 0xe6546b64) >>> 0;
  }
  a = fmix32(a ^ k);
  b = fmix32(b ^ nObs);
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

function validateKept(kept, nObs) {
  if (!(kept instanceof Uint32Array)) {
    throw new TypeError('A cell subset must be a Uint32Array of original positions.');
  }
  if (kept.length === 0) throw new RangeError('A cell subset must keep at least one cell.');
  let previous = -1;
  for (let i = 0; i < kept.length; i++) {
    const p = kept[i];
    if (p <= previous || p >= nObs) {
      throw new RangeError(
        `A cell subset must list original positions in [0, ${nObs}) strictly ascending; `
        + `entry ${i} is ${p}.`
      );
    }
    previous = p;
  }
}

/** The set bits of a 32-bit word. */
function popcount32(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/**
 * A bit per cell of a dataset of `nObs` cells, set for the open ones
 * (`kept`, null for every cell): a word per 32 cells or, `counted`, two
 * (the word and how many open cells come before it).
 */
function openCellBits(nObs, kept, { counted = false } = {}) {
  const words = Math.ceil(nObs / 32);
  const stride = counted ? 2 : 1;
  const bits = allocateTypedArray(Uint32Array, words * stride, 'Open cell bits');
  if (kept === null) {
    for (let w = 0; w < words; w++) bits[w * stride] = 0xffffffff;
    if (nObs % 32 !== 0) bits[(words - 1) * stride] = (2 ** (nObs % 32) - 1) >>> 0;
  } else {
    for (let j = 0; j < kept.length; j++) bits[(kept[j] >>> 5) * stride] |= 1 << (kept[j] & 31);
  }
  if (counted) {
    let count = 0;
    for (let w = 0; w < words; w++) {
      bits[2 * w + 1] = count;
      count += popcount32(bits[2 * w]);
    }
  }
  return bits;
}

/**
 * @typedef {object} CellIdentity
 * @property {number} n - Open cells
 * @property {number} nOriginal - Cells in the file
 * @property {boolean} isSubset - Whether some cells are not open
 * @property {Uint32Array|null} kept - Original positions of the open cells, ascending; null when all are open
 * @property {Uint32Array|null} openOrder - Original position of each open cell in open order, when the
 *   file stores its cells in another order than their original one (`priority-layout.js`); null when
 *   open cell `i` is `kept[i]` (or original position `i`)
 * @property {(position: number) => number} originalAt - The original position of open cell `position` (unchecked)
 * @property {(positions: ArrayLike<number>) => Uint32Array} toOriginal
 * @property {(originals: ArrayLike<number>) => {positions: Uint32Array, dropped: number}} fromOriginal
 * @property {(originals: ArrayLike<number>) => Int32Array} openPositionsOf
 * @property {<T extends ArrayLike<number>>(column: {cells: ArrayLike<number>|null, values: ArrayLike<number>},
 *   ArrayType: {new (length: number): T}, missing: number) => T} openValues
 * @property {(positions: ArrayLike<number>|null, values: ArrayLike<number>|null)
 *   => {cells: Uint32Array|null, values: ArrayLike<number>|null}} originalValues
 * @property {{toAscending: Uint32Array, toOpen: Uint32Array}|null} ascendingOrder
 * @property {string} digest
 */

/**
 * Create the identity of the open cells of a dataset of `nObs` cells.
 * A `kept` that lists every cell is the same as `null`.
 *
 * Open cells are in file order. A file that stores its cells in another
 * order than their original one (a priority-ordered file: `priority-layout.js`)
 * passes `openOrder`, the original position of each open cell in open
 * order (a permutation of `kept`, or of every position); every boundary
 * still speaks original positions.
 *
 * @param {{nObs: number, kept?: Uint32Array|null, openOrder?: Uint32Array|null}} options
 * @returns {CellIdentity}
 */
export function createCellIdentity({ nObs, kept = null, openOrder = null }) {
  assertCount(nObs, 'Cell count');
  if (kept !== null) {
    validateKept(kept, nObs);
    if (kept.length === nObs) kept = null;
  }
  const n = kept === null ? nObs : kept.length;
  let digest = null;
  if (openOrder !== null) {
    if (!(openOrder instanceof Uint32Array) || openOrder.length !== n) {
      throw new TypeError(`A cell order must be a Uint32Array of the ${formatCountOf(n, 'open cell')}.`);
    }
    // Each open cell once: a bit per cell of the file, set for the open
    // ones and cleared as the order names each -- a read of a small table,
    // not a search of `kept` per cell (10M cells of 20M: 0.08 s, not 3.3 s).
    const open = openCellBits(nObs, kept);
    for (let i = 0; i < n; i++) {
      const original = openOrder[i];
      const word = original >>> 5;
      const bit = 1 << (original & 31);
      if (!(original < nObs) || (open[word] & bit) === 0) {
        throw new RangeError('A cell order must list exactly the open cells, each once.');
      }
      open[word] ^= bit;
    }
  }
  // Open position of each `kept` (or original) position, through
  // `openOrder`: made when first asked (`openPositionsOf`,
  // `ascendingOrder`), not with the identity (an opening, a resize).
  let openOf = openOrder === null ? null : undefined;
  function placeOf() {
    if (openOf !== undefined) return openOf;
    const order = allocateTypedArray(Uint32Array, n, 'Open cell order');
    if (kept === null) {
      for (let i = 0; i < n; i++) order[openOrder[i]] = i;
    } else {
      // An open cell's place in `kept` is how many kept cells come before
      // it: the bits of each 32 cells of the file and the count before them.
      const ranks = openCellBits(nObs, kept, { counted: true });
      for (let i = 0; i < n; i++) {
        const original = openOrder[i];
        const at = 2 * (original >>> 5);
        order[ranks[at + 1] + popcount32(ranks[at] & ((1 << (original & 31)) - 1))] = i;
      }
    }
    return (openOf = order);
  }

  /** The original position of open cell `i`. */
  function originalAt(i) {
    return openOrder !== null ? openOrder[i] : kept === null ? i : kept[i];
  }

  function toOriginal(positions) {
    const out = allocateTypedArray(Uint32Array, positions.length, 'Original cell positions');
    for (let i = 0; i < positions.length; i++) {
      const position = positions[i];
      if (!(Number.isInteger(position) && position >= 0 && position < n)) {
        throw new RangeError(`Cell position ${position} is outside the ${n} open cells.`);
      }
      out[i] = originalAt(position);
    }
    return out;
  }

  /**
   * The open position of each original position, -1 where the cell is not
   * open. Ascending input walks `kept` once; any other order searches it.
   */
  function openPositionsOf(originals) {
    const openOf = placeOf();
    const out = allocateTypedArray(Int32Array, originals.length, 'Open cell positions');
    let cursor = 0;
    let previous = -1;
    for (let i = 0; i < originals.length; i++) {
      const original = originals[i];
      if (!(Number.isInteger(original) && original >= 0 && original < nObs)) {
        throw new RangeError(`Original cell position ${original} is outside the ${formatCountOf(nObs, 'cell')} of the dataset.`);
      }
      if (kept === null) {
        out[i] = openOf === null ? original : openOf[original];
        continue;
      }
      let lo = original > previous ? cursor : 0;
      let hi = kept.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (kept[mid] < original) lo = mid + 1;
        else hi = mid;
      }
      cursor = lo;
      previous = original;
      out[i] = lo < kept.length && kept[lo] === original ? (openOf === null ? lo : openOf[lo]) : -1;
    }
    return out;
  }

  function fromOriginal(originals) {
    const open = openPositionsOf(originals);
    const found = allocateTypedArray(Uint32Array, open.length, 'Open cell positions');
    let at = 0;
    for (let i = 0; i < open.length; i++) if (open[i] >= 0) found[at++] = open[i];
    // A cell list, ascending, whatever the order asked: open order need not
    // follow original order either (a subsample opens in priority order).
    const positions = at === found.length ? found : found.slice(0, at);
    if (positions.some((position, i) => i > 0 && position < positions[i - 1])) positions.sort();
    return { positions, dropped: originals.length - at };
  }

  /**
   * A per-cell column named by original position, over the open cells (open
   * order): `cells` null is a value per cell of the dataset (`values[p]` of
   * original position `p`); else `values[j]` is the value of original
   * position `cells[j]`, and an open cell `cells` does not name gets
   * `missing`.
   */
  function openValues({ cells, values }, ArrayType, missing) {
    const out = allocateTypedArray(ArrayType, n, 'Open cell values');
    if (cells === null) {
      if (values.length !== nObs) {
        throw new RangeError(`A column of ${formatCountOf(values.length, 'value')} does not cover the ${formatCountOf(nObs, 'cell')} of the dataset.`);
      }
      if (kept === null && openOrder === null) out.set(values);
      else for (let i = 0; i < n; i++) out[i] = values[originalAt(i)];
      return out;
    }
    if (values.length !== cells.length) {
      throw new RangeError(`A column names ${formatCountOf(cells.length, 'cell')} with ${formatCountOf(values.length, 'value')}.`);
    }
    out.fill(missing);
    const positions = openPositionsOf(cells);
    for (let j = 0; j < positions.length; j++) if (positions[j] >= 0) out[positions[j]] = values[j];
    return out;
  }

  let ascending;
  /** Open order and ascending original order of the open cells (`ascendingOrder`). */
  function ascendingOf() {
    if (ascending !== undefined) return ascending;
    const openOf = placeOf();
    if (openOf === null) return (ascending = null);
    const toAscending = allocateTypedArray(Uint32Array, n, 'Ascending cell order');
    for (let j = 0; j < n; j++) toAscending[openOf[j]] = j;
    return (ascending = Object.freeze({ toAscending, toOpen: openOf }));
  }

  /**
   * The values of open cells named by original position, ascending: cells
   * `positions` (open positions, any order) with `values[j]` the value of
   * `positions[j]`, or, `positions` null, every open cell with its value in
   * open order. `cells` is null when that is every cell of the dataset (the
   * values then are one per original position, in order); `values` may be
   * null (a cell set).
   */
  function originalValues(positions, values) {
    if (values !== null && positions !== null && values.length !== positions.length) {
      throw new RangeError(`${formatCountOf(positions.length, 'cell')} named with ${formatCountOf(values.length, 'value')}.`);
    }
    if (positions === null) {
      const order = ascendingOf();
      if (order === null || values === null) return { cells: kept, values };
      if (values.length !== n) {
        throw new RangeError(`${formatCountOf(values.length, 'value')} for the ${formatCountOf(n, 'open cell')}.`);
      }
      const out = allocateTypedArray(values.constructor, n, 'Cell values');
      for (let i = 0; i < n; i++) out[order.toAscending[i]] = values[i];
      return { cells: kept, values: out };
    }
    const originals = toOriginal(positions);
    let sorted = true;
    for (let i = 1; i < originals.length && sorted; i++) sorted = originals[i - 1] < originals[i];
    if (sorted) return { cells: originals, values };
    const order = allocateTypedArray(Uint32Array, originals.length, 'Cell order');
    for (let i = 0; i < order.length; i++) order[i] = i;
    order.sort((a, b) => originals[a] - originals[b]);
    const cells = allocateTypedArray(Uint32Array, order.length, 'Original cell positions');
    const ordered = values === null ? null : allocateTypedArray(values.constructor, order.length, 'Cell values');
    for (let k = 0; k < order.length; k++) {
      cells[k] = originals[order[k]];
      if (ordered !== null) ordered[k] = values[order[k]];
    }
    return { cells, values: ordered };
  }

  return Object.freeze({
    n,
    nOriginal: nObs,
    isSubset: kept !== null,
    kept,
    openOrder,
    originalAt,
    toOriginal,
    fromOriginal,
    openPositionsOf,
    openValues,
    originalValues,
    get ascendingOrder() {
      return ascendingOf();
    },
    get digest() {
      if (digest === null) digest = cellSetDigest(nObs, kept);
      return digest;
    }
  });
}

/**
 * Encode an open cell set as the bytes a session stores: the gaps between
 * consecutive kept original positions (the first from -1), each minus one,
 * as unsigned LEB128 varints. All cells open encodes as no bytes.
 *
 * @param {CellIdentity} identity
 * @returns {Uint8Array}
 */
export function encodeCellSet(identity) {
  const kept = identity.kept;
  if (kept === null) return new Uint8Array(0);
  const out = allocateTypedArray(Uint8Array, kept.length * 5, 'Cell set');
  let at = 0;
  let previous = -1;
  for (let i = 0; i < kept.length; i++) {
    let gap = kept[i] - previous - 1;
    previous = kept[i];
    while (gap >= 0x80) {
      out[at++] = (gap & 0x7f) | 0x80;
      gap = Math.floor(gap / 128);
    }
    out[at++] = gap;
  }
  const encoded = allocateTypedArray(Uint8Array, at, 'Cell set');
  encoded.set(out.subarray(0, at));
  return encoded;
}

/**
 * Decode `encodeCellSet` bytes of a dataset of `nObs` cells into its identity.
 *
 * @param {Uint8Array} bytes
 * @param {number} nObs
 * @returns {CellIdentity}
 */
export function decodeCellSet(bytes, nObs) {
  assertCount(nObs, 'Cell count');
  if (bytes.length === 0) return createCellIdentity({ nObs });
  const positions = allocateTypedArray(Uint32Array, Math.min(bytes.length, nObs), 'Cell set positions');
  let count = 0;
  let previous = -1;
  let at = 0;
  while (at < bytes.length) {
    let gap = 0;
    let scale = 1;
    let byte;
    do {
      if (at >= bytes.length || scale > 2 ** 35) throw new RangeError('A stored cell set is truncated or malformed.');
      byte = bytes[at++];
      gap += (byte & 0x7f) * scale;
      scale *= 128;
    } while (byte & 0x80);
    const position = previous + 1 + gap;
    if (position >= nObs || count >= positions.length) {
      throw new RangeError(`A stored cell set names a cell beyond the ${formatCountOf(nObs, 'cell')} of the dataset.`);
    }
    positions[count++] = position;
    previous = position;
  }
  return createCellIdentity({ nObs, kept: positions.slice(0, count) });
}
