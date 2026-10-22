/**
 * @fileoverview A set of cell indices as a bitset.
 *
 * A JavaScript `Set` or `Map` refuses more than 16,777,216 entries in V8
 * (Chromium: "Set maximum size exceeded"), so a selection of a large cluster
 * at 30M+ cells failed outright. `CellSet` holds the same set of integers as
 * one bit a cell of the dataset (125 KB a million cells), at any size, with
 * the `Set` surface the selection tools use (`has`, `add`, `delete`, `size`,
 * ascending iteration) plus word-wise set algebra.
 *
 * Iteration is in ascending cell order, whatever the insertion order.
 *
 * @module utils/cell-set
 */

function popcount32(value) {
  let x = value - ((value >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

export class CellSet {
  /**
   * @param {number} cellCount - Cells in the dataset (the index bound).
   */
  constructor(cellCount) {
    if (!Number.isSafeInteger(cellCount) || cellCount < 0 || cellCount > 0x1_0000_0000) {
      throw new RangeError(`CellSet needs a cell count in [0, 2^32], not ${String(cellCount)}.`);
    }
    this.cellCount = cellCount;
    this.words = new Uint32Array(Math.ceil(cellCount / 32));
    this.size = 0;
  }

  /**
   * @param {Iterable<number>} indices
   * @param {number} cellCount
   * @returns {CellSet}
   */
  static from(indices, cellCount) {
    const set = new CellSet(cellCount);
    for (const index of indices) set.add(index);
    return set;
  }

  _require(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.cellCount) {
      throw new RangeError(
        `Cell index ${String(index)} is outside the dataset of ${this.cellCount} cells.`
      );
    }
  }

  has(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.cellCount) return false;
    return ((this.words[index >>> 5] >>> (index & 31)) & 1) === 1;
  }

  add(index) {
    this._require(index);
    const word = index >>> 5;
    const bit = 1 << (index & 31);
    if ((this.words[word] & bit) === 0) {
      this.words[word] |= bit;
      this.size += 1;
    }
    return this;
  }

  delete(index) {
    if (!this.has(index)) return false;
    this.words[index >>> 5] &= ~(1 << (index & 31));
    this.size -= 1;
    return true;
  }

  clear() {
    this.words.fill(0);
    this.size = 0;
  }

  clone() {
    const copy = new CellSet(this.cellCount);
    copy.words.set(this.words);
    copy.size = this.size;
    return copy;
  }

  _requireCompatible(other) {
    if (!(other instanceof CellSet) || other.cellCount !== this.cellCount) {
      throw new TypeError('CellSet algebra needs another CellSet over the same cells.');
    }
  }

  _recount() {
    let size = 0;
    for (let word = 0; word < this.words.length; word++) {
      if (this.words[word] !== 0) size += popcount32(this.words[word]);
    }
    this.size = size;
    return this;
  }

  /** Add every member of `other` (in place). */
  unionWith(other) {
    this._requireCompatible(other);
    for (let word = 0; word < this.words.length; word++) this.words[word] |= other.words[word];
    return this._recount();
  }

  /** Keep only members also in `other` (in place). */
  intersectWith(other) {
    this._requireCompatible(other);
    for (let word = 0; word < this.words.length; word++) this.words[word] &= other.words[word];
    return this._recount();
  }

  /** Remove every member of `other` (in place). */
  subtract(other) {
    this._requireCompatible(other);
    for (let word = 0; word < this.words.length; word++) this.words[word] &= ~other.words[word];
    return this._recount();
  }

  /** Members in ascending order as a plain array. */
  toArray() {
    const out = new Array(this.size);
    let next = 0;
    const words = this.words;
    for (let word = 0; word < words.length; word++) {
      let bits = words[word];
      while (bits !== 0) {
        const low = bits & -bits;
        out[next++] = word * 32 + (31 - Math.clz32(low));
        bits ^= low;
      }
    }
    return out;
  }

  /** Members in ascending order as a Uint32Array. */
  toUint32Array() {
    const out = new Uint32Array(this.size);
    let next = 0;
    const words = this.words;
    for (let word = 0; word < words.length; word++) {
      let bits = words[word];
      while (bits !== 0) {
        const low = bits & -bits;
        out[next++] = word * 32 + (31 - Math.clz32(low));
        bits ^= low;
      }
    }
    return out;
  }

  *values() {
    const words = this.words;
    for (let word = 0; word < words.length; word++) {
      let bits = words[word];
      while (bits !== 0) {
        const low = bits & -bits;
        yield word * 32 + (31 - Math.clz32(low));
        bits ^= low;
      }
    }
  }

  keys() {
    return this.values();
  }

  [Symbol.iterator]() {
    return this.values();
  }

  forEach(callback) {
    for (const index of this.values()) callback(index, index, this);
  }
}

/**
 * Whether `values` (valid indices below `cellCount`) repeat an index: one bit
 * a cell, no Set, so any number of indices can be checked.
 *
 * @param {ArrayLike<number>} values
 * @param {number} cellCount
 * @returns {boolean}
 */
export function hasDuplicateCellIndex(values, cellCount) {
  const seen = new Uint32Array(Math.ceil(cellCount / 32));
  for (let index = 0; index < values.length; index++) {
    const cell = values[index];
    const word = cell >>> 5;
    const bit = 1 << (cell & 31);
    if ((seen[word] & bit) !== 0) return true;
    seen[word] |= bit;
  }
  return false;
}

/**
 * Whether non-negative integer `values` repeat one, when no cell count bounds
 * them: ascending input is checked in one pass, anything else on a sorted
 * copy (no Set, so any number of values can be checked).
 *
 * @param {ArrayLike<number>} values
 * @returns {boolean}
 */
export function hasDuplicateIndex(values) {
  let ascending = true;
  for (let index = 1; index < values.length; index++) {
    if (values[index] <= values[index - 1]) {
      ascending = false;
      break;
    }
  }
  if (ascending) return false;
  const sorted = Float64Array.from(values).sort();
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index] === sorted[index - 1]) return true;
  }
  return false;
}
