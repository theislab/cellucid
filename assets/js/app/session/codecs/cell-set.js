/**
 * @fileoverview Cell-set codec: one exact set of cell indices, stored in the
 * encoding that is smallest for that set.
 *
 * Payload (before the chunk's gzip), byte 0 is the encoding:
 *
 * | byte 0 | name           | body                                                        |
 * |--------|----------------|-------------------------------------------------------------|
 * | 0      | sorted-delta   | uvarint count, then `count` uvarint deltas (first = index)  |
 * | 1      | bitset         | ceil(cellCount / 8) bytes; cell i is bit (i & 7) of byte i>>3 |
 * | 2      | runs           | uvarint runCount, then runCount × (uvarint gap, uvarint length); gap counts from the end of the previous run (from 0 for the first) |
 * | 3      | reference-mask | uvarint referenceCount, u32 LE referenceDigest, then ceil(referenceCount / 8) bytes: bit k marks the k-th reference cell (ascending) |
 * | 4      | reference-all  | uvarint referenceCount, u32 LE referenceDigest              |
 *
 * A reference is a set both sides can derive from the dataset: the cells of
 * one category of one observation field (a category highlight). Encodings 3
 * and 4 store the selection relative to it, so a whole category costs a few
 * bytes instead of one per cell. The reference count and digest
 * ({@link digestCellSet}) are checked when decoding, so a dataset whose
 * category no longer holds the same cells is refused instead of silently
 * selecting other cells.
 *
 * Measured on Suo (562k cells, 22 highlight groups of 5–170k cells): the
 * per-set choice among 0–2 stores 188 KB where sorted-delta alone stored
 * 197 KB (both gzipped); a whole category stores 9 bytes.
 *
 * @module session/codecs/cell-set
 */

import { yieldToMacrotask } from '../../../utils/yield-macrotask.js';
import { decodeUvarint, uvarintLength, writeUvarint } from './varint.js';
import { formatCountOf } from '../../../utils/format-units.js';

export const CELL_SET_SORTED_DELTA = 0;
export const CELL_SET_BITSET = 1;
export const CELL_SET_RUNS = 2;
export const CELL_SET_REFERENCE_MASK = 3;
export const CELL_SET_REFERENCE_ALL = 4;

/** Cells decoded between yields to the interface. */
const COOPERATIVE_DECODE_BUDGET = 64 * 1024;

function throwIfAborted(signal) {
  if (signal !== null && signal.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }
}

/**
 * Order-independent 32-bit digest of a set of cell indices: the sum, modulo
 * 2^32, of one avalanche-mixed word per index. Python computes the same value
 * vectorized (`session_codecs.digest_cell_set`).
 *
 * @param {Uint32Array} indices
 * @returns {number} Unsigned 32-bit digest.
 */
export function digestCellSet(indices) {
  let sum = 0;
  for (let i = 0; i < indices.length; i++) {
    let x = indices[i];
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x ^= x >>> 16;
    sum = (sum + (x >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

/**
 * The indices as one strictly increasing Uint32Array, validated against the
 * cell count. A sorted Uint32Array is used as it is; anything else is copied
 * once and sorted natively.
 *
 * @param {ArrayLike<number>} indices
 * @param {number} cellCount
 * @returns {Uint32Array}
 */
function toSortedCellIndices(indices, cellCount) {
  if (
    indices === null
    || typeof indices !== 'object'
    || !Number.isSafeInteger(indices.length)
  ) {
    throw new TypeError('Cell-set indices must be an exact array-like collection.');
  }
  let sorted = indices instanceof Uint32Array ? indices : null;
  if (sorted !== null) {
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] <= sorted[i - 1]) { sorted = null; break; }
    }
  }
  if (sorted === null) {
    sorted = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i++) {
      const value = indices[i];
      if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
        throw new TypeError(`Cell-set index at ${i} must be an unsigned 32-bit integer.`);
      }
      sorted[i] = value;
    }
    sorted.sort();
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1]) {
        throw new TypeError('Cell-set indices must be a set without duplicates.');
      }
    }
  }
  if (sorted.length > 0 && sorted[sorted.length - 1] >= cellCount) {
    throw new RangeError('Cell-set index exceeds the dataset cell count.');
  }
  return sorted;
}

/**
 * Sizes of the sorted-delta and runs encodings of one set, in one pass.
 * @param {Uint32Array} sorted
 * @returns {{deltaLength: number, runsLength: number, runCount: number}}
 */
function measureEncodings(sorted) {
  let deltaLength = uvarintLength(sorted.length);
  let runCount = 0;
  let runBytes = 0;
  let runStart = 0;
  let previousEnd = 0;
  for (let i = 0; i < sorted.length; i++) {
    const cell = sorted[i];
    deltaLength += uvarintLength(i === 0 ? cell : cell - sorted[i - 1]);
    if (i + 1 === sorted.length || sorted[i + 1] !== cell + 1) {
      runBytes += uvarintLength(sorted[runStart] - previousEnd) + uvarintLength(i - runStart + 1);
      runCount += 1;
      previousEnd = cell + 1;
      runStart = i + 1;
    }
  }
  return { deltaLength, runsLength: runBytes + uvarintLength(runCount), runCount };
}

/**
 * Positions of `sorted` inside `reference`, or null when `sorted` is not a
 * subset of it.
 */
function referencePositions(sorted, reference) {
  const positions = new Uint32Array(sorted.length);
  let r = 0;
  for (let i = 0; i < sorted.length; i++) {
    const cell = sorted[i];
    while (r < reference.length && reference[r] < cell) r++;
    if (r === reference.length || reference[r] !== cell) return null;
    positions[i] = r;
  }
  return positions;
}

function writeU32(out, offset, value) {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
  out[offset + 2] = (value >>> 16) & 0xff;
  out[offset + 3] = (value >>> 24) & 0xff;
  return offset + 4;
}

function readU32(bytes, offset) {
  if (offset + 4 > bytes.byteLength) {
    throw new Error('Cell set is truncated.');
  }
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

/**
 * Encode one cell set in its smallest encoding.
 *
 * @param {ArrayLike<number>} indices
 * @param {{ cellCount: number, reference: Uint32Array|null }} options -
 *   `reference` is the sorted set the selection may be stored relative to.
 * @returns {Uint8Array}
 */
export function encodeCellSet(indices, { cellCount, reference }) {
  if (!Number.isSafeInteger(cellCount) || cellCount < 0) {
    throw new TypeError('Cell-set cellCount must be a non-negative safe integer.');
  }
  const sorted = toSortedCellIndices(indices, cellCount);

  if (reference !== null) {
    if (!(reference instanceof Uint32Array)) {
      throw new TypeError('Cell-set reference must be a sorted Uint32Array.');
    }
    const positions = referencePositions(sorted, reference);
    if (positions !== null) {
      const digest = digestCellSet(reference);
      const head = 1 + uvarintLength(reference.length) + 4;
      if (positions.length === reference.length) {
        const out = new Uint8Array(head);
        out[0] = CELL_SET_REFERENCE_ALL;
        writeU32(out, writeUvarint(out, 1, reference.length), digest);
        return out;
      }
      const maskBytes = Math.ceil(reference.length / 8);
      const sizes = measureEncodings(sorted);
      if (head + maskBytes < 1 + Math.min(sizes.deltaLength, sizes.runsLength, Math.ceil(cellCount / 8))) {
        const out = new Uint8Array(head + maskBytes);
        out[0] = CELL_SET_REFERENCE_MASK;
        const body = writeU32(out, writeUvarint(out, 1, reference.length), digest);
        for (let i = 0; i < positions.length; i++) {
          const k = positions[i];
          out[body + (k >>> 3)] |= 1 << (k & 7);
        }
        return out;
      }
    }
  }

  const { deltaLength, runsLength, runCount } = measureEncodings(sorted);
  const bitsetLength = Math.ceil(cellCount / 8);
  const smallest = Math.min(deltaLength, bitsetLength, runsLength);

  if (smallest === deltaLength) {
    const out = new Uint8Array(1 + deltaLength);
    out[0] = CELL_SET_SORTED_DELTA;
    let offset = writeUvarint(out, 1, sorted.length);
    let previous = 0;
    for (let i = 0; i < sorted.length; i++) {
      offset = writeUvarint(out, offset, i === 0 ? sorted[i] : sorted[i] - previous);
      previous = sorted[i];
    }
    return out;
  }
  if (smallest === bitsetLength) {
    const out = new Uint8Array(1 + bitsetLength);
    out[0] = CELL_SET_BITSET;
    for (let i = 0; i < sorted.length; i++) {
      const cell = sorted[i];
      out[1 + (cell >>> 3)] |= 1 << (cell & 7);
    }
    return out;
  }
  const out = new Uint8Array(1 + runsLength);
  out[0] = CELL_SET_RUNS;
  let offset = writeUvarint(out, 1, runCount);
  let previousEnd = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    offset = writeUvarint(out, offset, sorted[i] - previousEnd);
    offset = writeUvarint(out, offset, j - i + 1);
    previousEnd = sorted[j] + 1;
    i = j + 1;
  }
  return out;
}

/**
 * Whether a payload stores its cells relative to a reference set, so the
 * caller has to derive that reference before decoding.
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function cellSetNeedsReference(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new TypeError('Cell set must be a non-empty Uint8Array.');
  }
  return bytes[0] === CELL_SET_REFERENCE_MASK || bytes[0] === CELL_SET_REFERENCE_ALL;
}

/**
 * Decode one cell set into a strictly increasing Uint32Array.
 *
 * @param {Uint8Array} bytes
 * @param {{ cellCount: number, reference: Uint32Array|null, signal: AbortSignal|null }} options
 * @returns {Promise<Uint32Array>}
 */
export async function decodeCellSet(bytes, { cellCount, reference, signal }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new TypeError('Cell set must be a non-empty Uint8Array.');
  }
  if (!Number.isSafeInteger(cellCount) || cellCount < 0) {
    throw new TypeError('Cell-set cellCount must be a non-negative safe integer.');
  }
  if (signal !== null && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean')) {
    throw new TypeError('Cell-set signal must be an AbortSignal or null.');
  }
  throwIfAborted(signal);
  const encoding = bytes[0];

  if (encoding === CELL_SET_REFERENCE_MASK || encoding === CELL_SET_REFERENCE_ALL) {
    if (!(reference instanceof Uint32Array)) {
      throw new TypeError('This cell set is stored relative to a category; its cells are required.');
    }
    const { value: referenceCount, nextOffset } = decodeUvarint(bytes, 1);
    const digest = readU32(bytes, nextOffset);
    if (referenceCount !== reference.length || digest !== digestCellSet(reference)) {
      throw new RangeError(
        'The category this selection was saved relative to no longer holds the same cells.'
      );
    }
    const body = nextOffset + 4;
    if (encoding === CELL_SET_REFERENCE_ALL) {
      if (body !== bytes.byteLength) throw new Error('Cell set has trailing bytes.');
      return reference.slice();
    }
    if (body + Math.ceil(referenceCount / 8) !== bytes.byteLength) {
      throw new Error('Cell-set reference mask has the wrong length.');
    }
    let count = 0;
    for (let k = 0; k < referenceCount; k++) {
      if (bytes[body + (k >>> 3)] & (1 << (k & 7))) count++;
    }
    if (referenceCount % 8 !== 0 && (bytes[bytes.byteLength - 1] >>> (referenceCount % 8)) !== 0) {
      throw new Error('Cell-set reference mask sets bits past its reference.');
    }
    const out = new Uint32Array(count);
    let n = 0;
    for (let k = 0; k < referenceCount; k++) {
      if (bytes[body + (k >>> 3)] & (1 << (k & 7))) out[n++] = reference[k];
    }
    return out;
  }

  if (encoding === CELL_SET_BITSET) {
    const bitsetLength = Math.ceil(cellCount / 8);
    if (bytes.byteLength !== 1 + bitsetLength) {
      throw new Error('Cell-set bitset has the wrong length for the dataset cell count.');
    }
    if (cellCount % 8 !== 0 && (bytes[bytes.byteLength - 1] >>> (cellCount % 8)) !== 0) {
      throw new Error('Cell-set bitset sets bits past the dataset cell count.');
    }
    let count = 0;
    for (let b = 1; b < bytes.byteLength; b++) {
      let v = bytes[b];
      while (v !== 0) { v &= v - 1; count++; }
    }
    const out = new Uint32Array(count);
    let n = 0;
    for (let b = 1; b < bytes.byteLength; b++) {
      const v = bytes[b];
      if (v === 0) continue;
      const base = (b - 1) * 8;
      for (let bit = 0; bit < 8; bit++) {
        if (v & (1 << bit)) out[n++] = base + bit;
      }
      if (b % COOPERATIVE_DECODE_BUDGET === 0) {
        await yieldToMacrotask();
        throwIfAborted(signal);
      }
    }
    return out;
  }

  if (encoding === CELL_SET_SORTED_DELTA) {
    let { value: count, nextOffset: offset } = decodeUvarint(bytes, 1);
    if (count > cellCount) {
      throw new RangeError(`Cell set holds ${formatCountOf(count, 'cell')}; the dataset has ${cellCount}.`);
    }
    const out = new Uint32Array(count);
    let acc = 0;
    for (let i = 0; i < count; i++) {
      // Inline uvarint read: this loop runs once per cell.
      let delta = 0;
      let scale = 1;
      let b;
      do {
        if (offset >= bytes.byteLength) throw new Error('Cell set is truncated.');
        b = bytes[offset++];
        delta += (b & 0x7f) * scale;
        scale *= 0x80;
      } while ((b & 0x80) !== 0 && scale <= 0x8000_0000_0000);
      if ((b & 0x80) !== 0) throw new Error('Cell-set delta is too long.');
      if (i > 0 && delta === 0) {
        throw new Error('Cell-set indices must be strictly increasing.');
      }
      acc += delta;
      if (acc >= cellCount) {
        throw new RangeError('Cell-set index exceeds the dataset cell count.');
      }
      out[i] = acc;
      if ((i + 1) % COOPERATIVE_DECODE_BUDGET === 0 && i + 1 < count) {
        await yieldToMacrotask();
        throwIfAborted(signal);
      }
    }
    if (offset !== bytes.byteLength) throw new Error('Cell set has trailing bytes.');
    return out;
  }

  if (encoding === CELL_SET_RUNS) {
    let { value: runCount, nextOffset: offset } = decodeUvarint(bytes, 1);
    const runs = new Float64Array(runCount * 2);
    let total = 0;
    let previousEnd = 0;
    for (let r = 0; r < runCount; r++) {
      const gap = decodeUvarint(bytes, offset);
      const length = decodeUvarint(bytes, gap.nextOffset);
      offset = length.nextOffset;
      if (length.value < 1 || (r > 0 && gap.value < 1)) {
        throw new Error('Cell-set runs must be non-empty and separated.');
      }
      const start = previousEnd + gap.value;
      previousEnd = start + length.value;
      if (previousEnd > cellCount) {
        throw new RangeError('Cell-set run exceeds the dataset cell count.');
      }
      runs[r * 2] = start;
      runs[r * 2 + 1] = length.value;
      total += length.value;
    }
    if (offset !== bytes.byteLength) throw new Error('Cell set has trailing bytes.');
    const out = new Uint32Array(total);
    let n = 0;
    for (let r = 0; r < runCount; r++) {
      const start = runs[r * 2];
      const end = start + runs[r * 2 + 1];
      for (let cell = start; cell < end; cell++) out[n++] = cell;
    }
    return out;
  }

  throw new TypeError(`Cell-set encoding ${encoding} is not one this version reads.`);
}
