/**
 * The cell-order digest: what binds a session to the cells it was saved on
 * and their coordinates (`datasetFingerprint.cellOrder.digest`,
 * `app/session/session-context.js`).
 *
 * It is taken over **one embedding's stored values** (an `obsm` array's
 * selected columns, each value rounded to float32), each cell named by its
 * **original position** (`cell-identity.js`), and nothing else: not the
 * display coordinates (whose frame depends on which cells were read first),
 * not the order a file stores the cells in or the app opens them in. So the
 * same cells of the same file digest alike whether they were opened whole,
 * grown step by step, cut by Apply, opened in priority order or as given,
 * and a session saved on `k` of them checks against any opening of those
 * `k` cells.
 *
 * Specification (session format 3; the documentation's "Cell-order
 * digest"):
 *
 * - Each cell contributes a 64-bit hash, two 32-bit lanes: MurmurHash3
 *   (x86, 32-bit) of four little-endian 32-bit words -- the cell's original
 *   position, then the float32 bit patterns of its values on axes 0, 1 and
 *   2 (`+0.0`, the zero word, for an axis the embedding does not have; every
 *   NaN as `0x7fc00000`) -- under seed `0x9e3779b1` (low lane) and
 *   `0x85ebca6b` (high lane).
 * - A set of cells sums its cells' lanes, each modulo 2^32: the order of
 *   the cells does not matter, and a set's sums are the sums of its parts.
 * - The digest of a set of `n` cells is `fmix32(high ^ fmix32(n ^
 *   0x297a2d39))` then `fmix32(low ^ fmix32(n ^ 0x2c1b3c6d))`, as 16
 *   lowercase hexadecimal digits.
 *
 * Because sums add, the reader worker digests an embedding as it reads it
 * (`embedding-payload.js`): a growth step adds only the rows it reads, a cut
 * keeps the sums of the blocks of rows it keeps (`CellOrderSums`), and
 * saving a session asks for the digest instead of folding every cell on the
 * page.
 *
 * @module data/cell-order-digest
 */

import { fmix32 } from './cell-identity.js';
import { allocateTypedArray } from './sparse-column-index.js';

const SEED_LOW = 0x9e3779b1;
const SEED_HIGH = 0x85ebca6b;
const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;
const CANONICAL_NAN = 0x7fc00000;

/**
 * Open rows a block of sums covers: an opening cut in place keeps the sums
 * of the whole blocks below its last row and reads the rows of the block it
 * cuts through again (fewer than this many) when its digest is asked for.
 */
export const CELL_ORDER_BLOCK_ROWS = 4096;

/** MurmurHash3's per-word scramble. */
function scramble(word) {
  word = Math.imul(word, C1);
  word = (word << 15) | (word >>> 17);
  return Math.imul(word, C2);
}

/** MurmurHash3's per-word step. */
function step(h, k) {
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

/** A float32 bit pattern with every NaN made the one NaN. */
function canonical(word) {
  return (word & 0x7f800000) === 0x7f800000 && (word & 0x007fffff) !== 0 ? CANONICAL_NAN : word;
}

const SCRATCH = new Float32Array(1);
const SCRATCH_BITS = new Uint32Array(SCRATCH.buffer);

/** The float32 bit pattern of a stored value, rounded to float32. */
function float32Bits(value) {
  SCRATCH[0] = value;
  return canonical(SCRATCH_BITS[0]);
}

/**
 * Add cells to running lane sums.
 *
 * @param {{low: number, high: number}} sums - Updated in place
 * @param {Float32Array|Float64Array} values - `width` stored values per cell, row-major
 * @param {number} width - 1, 2 or 3
 * @param {(row: number) => number} originalOf - The original position of row `row` of `values`
 */
export function addCellOrderSums(sums, values, width, originalOf) {
  if (!Number.isSafeInteger(width) || width < 1 || width > 3) {
    throw new RangeError('A cell-order digest is taken over 1, 2 or 3 columns.');
  }
  if (values.length % width !== 0) throw new RangeError('Values do not fill whole cells.');
  const bits = values instanceof Float32Array
    ? new Uint32Array(values.buffer, values.byteOffset, values.length)
    : null;
  const cells = values.length / width;
  let low = sums.low | 0;
  let high = sums.high | 0;
  // An axis' word, scrambled; the words in locals (an array of three costs a
  // third of the digest's time at 10M cells).
  const word = index => scramble(bits === null ? float32Bits(values[index]) : canonical(bits[index]));
  for (let row = 0, index = 0; row < cells; row++) {
    const w0 = word(index);
    const w1 = width > 1 ? word(index + 1) : 0;
    const w2 = width > 2 ? word(index + 2) : 0;
    index += width;
    const position = scramble(originalOf(row) >>> 0);
    // An axis the embedding does not have is the zero word, scrambled.
    const a = step(step(step(step(SEED_LOW, position), w0), w1), w2);
    const b = step(step(step(step(SEED_HIGH, position), w0), w1), w2);
    low = (low + fmix32(a ^ 16)) | 0;
    high = (high + fmix32(b ^ 16)) | 0;
  }
  sums.low = low >>> 0;
  sums.high = high >>> 0;
  return sums;
}

/**
 * The digest of `cells` cells from their lane sums.
 *
 * @param {{low: number, high: number}} sums
 * @param {number} cells
 * @returns {string} 16 lowercase hexadecimal characters
 */
export function cellOrderDigestOf({ low, high }, cells) {
  if (!Number.isSafeInteger(cells) || cells < 0 || cells > 0xffffffff) {
    throw new RangeError(`A cell-order digest counts 0 to 2^32 - 1 cells, not ${cells}.`);
  }
  const first = fmix32((high ^ fmix32(cells ^ 0x297a2d39)) >>> 0);
  const second = fmix32((low ^ fmix32(cells ^ 0x2c1b3c6d)) >>> 0);
  return first.toString(16).padStart(8, '0') + second.toString(16).padStart(8, '0');
}

/**
 * The digest of some cells' stored values in one pass (a dataset read whole
 * by a tool, a test).
 *
 * @param {Float32Array|Float64Array} values - `width` values per cell, row-major
 * @param {number} width
 * @param {Uint32Array|null} [originals=null] - The original position of each
 *   row; null when row `i` is original position `i`
 * @returns {string}
 */
export function cellOrderDigest(values, width, originals = null) {
  const cells = values.length / width;
  if (originals !== null && originals.length !== cells) {
    throw new RangeError('A cell-order digest names one original position per cell.');
  }
  const sums = addCellOrderSums({ low: 0, high: 0 }, values, width, originals === null ? row => row : row => originals[row]);
  return cellOrderDigestOf(sums, cells);
}

/**
 * The lane sums of an embedding over the first `covered` open rows of an
 * opening, in blocks of `CELL_ORDER_BLOCK_ROWS` rows, so the sums of any
 * shorter prefix are known to its last whole block. A state made for the
 * same cells in another order knows only its total (`blocks` null).
 */
export class CellOrderSums {
  constructor() {
    /** @type {Uint32Array|null} Two lanes per block; null: only the total is known */
    this._blocks = new Uint32Array(0);
    /** Rows `[0, covered)` are summed. */
    this.covered = 0;
    /** @type {{low: number, high: number}} */
    this._total = { low: 0, high: 0 };
  }

  /**
   * The sums of every open cell of an opening of the same cells in another
   * order: their total, without blocks.
   *
   * @param {CellOrderSums} sums - Of the earlier opening, complete over `cells`
   * @returns {CellOrderSums}
   */
  static reordered(sums) {
    const next = new CellOrderSums();
    next._blocks = null;
    next.covered = sums.covered;
    next._total = { ...sums._total };
    return next;
  }

  /** Whether rows can be added after `covered` (a reordered total cannot be cut or grown). */
  get extendable() {
    return this._blocks !== null;
  }

  /** The lane sums of rows `[0, covered)`. */
  get total() {
    return { ...this._total };
  }

  /**
   * Add rows `[first, first + values.length / width)`; `first` must be
   * `covered`.
   *
   * @param {Float32Array|Float64Array} values
   * @param {number} width
   * @param {number} first - Open row of `values`' first cell
   * @param {Uint32Array|null} originals - The original position of each open row; null: row `i` is `i`
   */
  add(values, width, first, originals) {
    if (this._blocks === null || first !== this.covered) {
      throw new RangeError(`Cell-order sums cover rows to ${this.covered}; rows from ${first} cannot be added.`);
    }
    const cells = values.length / width;
    const end = first + cells;
    const blocks = Math.ceil(end / CELL_ORDER_BLOCK_ROWS);
    if (this._blocks.length < 2 * blocks) {
      const grown = allocateTypedArray(Uint32Array, Math.max(2 * blocks, 2 * this._blocks.length), 'Cell-order sums');
      grown.set(this._blocks);
      this._blocks = grown;
    }
    const originalOf = originals === null ? row => row : row => originals[row];
    for (let row = first; row < end;) {
      const block = Math.floor(row / CELL_ORDER_BLOCK_ROWS);
      const stop = Math.min(end, (block + 1) * CELL_ORDER_BLOCK_ROWS);
      const part = values.subarray((row - first) * width, (stop - first) * width);
      const start = row;
      const added = addCellOrderSums({ low: 0, high: 0 }, part, width, at => originalOf(start + at));
      this._blocks[2 * block] = (this._blocks[2 * block] + added.low) >>> 0;
      this._blocks[2 * block + 1] = (this._blocks[2 * block + 1] + added.high) >>> 0;
      this._total.low = (this._total.low + added.low) >>> 0;
      this._total.high = (this._total.high + added.high) >>> 0;
      row = stop;
    }
    this.covered = end;
  }

  /**
   * The sums of the first `rows` open rows, as far as they are known: every
   * whole block below `rows`, and the rows of the block `rows` cuts through
   * when this state covers exactly to `rows`. The rest is read again.
   *
   * @param {number} rows
   * @returns {CellOrderSums}
   */
  prefix(rows) {
    const next = new CellOrderSums();
    if (this._blocks === null) return next;
    const end = Math.min(rows, this.covered);
    const kept = end === this.covered ? end : Math.floor(end / CELL_ORDER_BLOCK_ROWS) * CELL_ORDER_BLOCK_ROWS;
    const blocks = Math.ceil(kept / CELL_ORDER_BLOCK_ROWS);
    next._blocks = this._blocks.slice(0, 2 * blocks);
    let low = 0;
    let high = 0;
    for (let block = 0; block < blocks; block++) {
      low = (low + next._blocks[2 * block]) | 0;
      high = (high + next._blocks[2 * block + 1]) | 0;
    }
    next._total = { low: low >>> 0, high: high >>> 0 };
    next.covered = kept;
    return next;
  }

  /** A copy that can be added to without changing this one. */
  clone() {
    const next = new CellOrderSums();
    next._blocks = this._blocks === null ? null : this._blocks.slice();
    next.covered = this.covered;
    next._total = { ...this._total };
    return next;
  }

  /** The digest of rows `[0, covered)`. */
  digest() {
    return cellOrderDigestOf(this._total, this.covered);
  }
}
