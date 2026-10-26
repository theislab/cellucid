/**
 * Reading AnnData arrays into the value types the app uses.
 *
 * A store `read()` already fetches and decodes the chunks of one selection in
 * parallel. What this module adds is the shape of large reads:
 *
 * - **Slabs.** A long array is read in row slabs of about `SLAB_BYTES`
 *   decoded bytes, aligned to the array's chunk rows (a chunk is decoded
 *   once, never once per slab it straddles), so a conversion never holds a
 *   second full copy of the array.
 * - **Read-ahead.** The next slab is requested before the current one is
 *   converted, so fetching and decoding overlap with conversion.
 * - **Exact conversions.** Values become float32 (expression, continuous
 *   fields), int32 (codes, indices) or exact numbers (64-bit pointers) with
 *   range checks, written straight into one output allocated once.
 *
 * @module data/anndata/values
 */

import { allocateTypedArray } from '../sparse-column-index.js';
import { elementBytes } from './elements.js';

/** Decoded bytes per slab. A scheduling choice, not a limit on what is read. */
export const SLAB_BYTES = 32 * 1024 * 1024;


/**
 * Rows per slab of an array whose rows hold `rowElements` elements, aligned
 * down to whole chunk rows.
 */
export function slabRows(array, rowElements) {
  const bytesPerRow = Math.max(1, rowElements * elementBytes(array));
  let rows = Math.max(1, Math.floor(SLAB_BYTES / bytesPerRow));
  const chunkRows = Number(array?.chunks?.[0]);
  if (Number.isSafeInteger(chunkRows) && chunkRows > 0 && rows > chunkRows) {
    rows -= rows % chunkRows;
  }
  return rows;
}

/**
 * Rows `[rowStart, rowEnd)` of an array in slabs, each requested before the
 * previous one is handed out. With `columns`, a two-dimensional array is read
 * in that column range only.
 *
 * @param {import('../../formats/store.js').StoreNode & {read: Function, shape: number[]}} array
 * @param {number} rowStart
 * @param {number} rowEnd
 * @param {{columns?: [number, number]|null, signal?: AbortSignal|null, activity?: Object|null}} [options]
 * @returns {AsyncGenerator<{rowStart: number, rowEnd: number, values: any}>}
 */
export async function* readRowSlabs(array, rowStart, rowEnd, { columns = null, ...readOptions } = {}) {
  let width = 1;
  if (columns !== null) width = columns[1] - columns[0];
  else for (const extent of array.shape.slice(1)) width *= extent;
  const step = slabRows(array, width);
  if (readOptions.activity && rowEnd - rowStart > step && typeof array.storedBytes === 'function') {
    // Slabs are planned one ahead; the whole read's stored size says up
    // front how much is left.
    const selection = columns === null ? [[rowStart, rowEnd]] : [[rowStart, rowEnd], columns];
    array.storedBytes(selection, readOptions).then(bytes => readOptions.activity.expect(bytes), () => {});
  }
  const read = (from, to) => {
    const promise = array.read(columns === null ? [[from, to]] : [[from, to], columns], readOptions);
    promise.catch(() => {});
    return promise;
  };
  let next = rowStart < rowEnd ? read(rowStart, Math.min(rowEnd, rowStart + step)) : null;
  for (let at = rowStart; at < rowEnd; at += step) {
    const stop = Math.min(rowEnd, at + step);
    const current = next;
    next = stop < rowEnd ? read(stop, Math.min(rowEnd, stop + step)) : null;
    yield { rowStart: at, rowEnd: stop, values: await current };
  }
}

function lengthMismatch(label) {
  return new Error(`${label} payload length does not match its metadata`);
}

/**
 * 64-bit integer arrays are converted through their 32-bit words, not a
 * BigInt per element: a 10x `.h5`'s int64 indices (44 million at 100,000
 * cells) took 0.5 s through BigInt comparisons and `Number()`, and take a
 * few tens of milliseconds this way. The word order is the host's (the
 * typed array holds host-order values).
 */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const LOW_WORD = LITTLE_ENDIAN ? 0 : 1;
const HIGH_WORD = LITTLE_ENDIAN ? 1 : 0;

function is64BitIntegers(values) {
  return values instanceof BigInt64Array || values instanceof BigUint64Array;
}

/** The 32-bit words of a 64-bit integer array, two per value. */
function wordsOf(values) {
  return new Uint32Array(values.buffer, values.byteOffset, values.length * 2);
}

/**
 * Value `i` of a 64-bit integer array from its words: exact while it is a
 * safe integer, else the nearest double (as `Number()` of the BigInt).
 */
function valueOfWords(words, i, signed) {
  const high = words[2 * i + HIGH_WORD];
  return (signed ? high | 0 : high) * 4294967296 + words[2 * i + LOW_WORD];
}

/**
 * Write `values` into `output` at `offset` as float32: exact for every
 * integer type up to 16 bits, rounded to the nearest float32 for wider
 * integers (64-bit ones included) and float64, as numpy's
 * `astype(float32)` does: a finite value beyond the float32 range becomes
 * an infinity, so one outlier never makes a whole column unreadable.
 */
export function writeFloat32(values, output, offset) {
  if (is64BitIntegers(values)) {
    const words = wordsOf(values);
    const signed = values instanceof BigInt64Array;
    for (let i = 0; i < values.length; i++) output[offset + i] = valueOfWords(words, i, signed);
    return;
  }
  if (ArrayBuffer.isView(values)) {
    output.set(values, offset);
    return;
  }
  // 64-bit integers (BigInts) and plain arrays: the nearest double, then the
  // nearest float32 as it is stored.
  for (let i = 0; i < values.length; i++) output[offset + i] = Number(values[i]);
}

/** Write `values` into `output` at `offset` as int32, refusing anything outside it. */
export function writeInt32(values, output, offset, label) {
  if (values instanceof Int32Array || values instanceof Int8Array || values instanceof Uint8Array ||
      values instanceof Int16Array || values instanceof Uint16Array) {
    output.set(values, offset);
    return;
  }
  const length = values.length;
  if (is64BitIntegers(values)) {
    const words = wordsOf(values);
    const signed = values instanceof BigInt64Array;
    for (let i = 0; i < length; i++) {
      const value = valueOfWords(words, i, signed);
      if (!(value >= -2147483648 && value <= 2147483647)) {
        throw new Error(`${label} ${values[i]} is outside the Int32 range`);
      }
      output[offset + i] = value;
    }
    return;
  }
  for (let i = 0; i < length; i++) {
    const raw = values[i];
    if (typeof raw === 'bigint') {
      if (raw < -2147483648n || raw > 2147483647n) {
        throw new Error(`${label} ${raw} is outside the Int32 range`);
      }
      output[offset + i] = Number(raw);
      continue;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647) {
      throw new Error(`${label} ${String(raw)} is outside the Int32 range`);
    }
    output[offset + i] = value;
  }
}

/** Write `values` as exact numbers (64-bit integers checked against the safe range). */
function writeExactNumbers(values, output, offset, label) {
  const length = values.length;
  if (is64BitIntegers(values)) {
    const words = wordsOf(values);
    const signed = values instanceof BigInt64Array;
    for (let i = 0; i < length; i++) {
      const value = valueOfWords(words, i, signed);
      if (!Number.isSafeInteger(value)) {
        throw new RangeError(`${label} ${values[i]} is outside the safe integer range`);
      }
      output[offset + i] = value;
    }
    return;
  }
  for (let i = 0; i < length; i++) {
    const raw = values[i];
    if (raw > 9007199254740991n || raw < -9007199254740991n) {
      throw new RangeError(`${label} ${raw} is outside the safe integer range`);
    }
    output[offset + i] = Number(raw);
  }
}

/**
 * Rows `[start, end)` of a one-dimensional array, written slab by slab with
 * `write(values, output, offset, label)` into one output allocated once.
 *
 * @template T
 * @param {Object} array
 * @param {number} start
 * @param {number} end
 * @param {new (length: number) => T} OutputType
 * @param {string} label
 * @param {(values: any, output: T, offset: number, label: string) => void} write
 * @param {{signal?: AbortSignal|null, activity?: Object|null}} [options] - Passed to every read
 * @returns {Promise<T>}
 */
export async function readConvertedRange(array, start, end, OutputType, label, write, options = {}) {
  const output = allocateTypedArray(OutputType, end - start, label);
  for await (const slab of readRowSlabs(array, start, end, options)) {
    if (!slab.values || slab.values.length !== slab.rowEnd - slab.rowStart) throw lengthMismatch(label);
    write(slab.values, output, slab.rowStart - start, label);
  }
  return output;
}

/**
 * Rows `[start, end)` of a one-dimensional numeric array as float32. A
 * float32 array read in one slab is returned as read, without a copy.
 */
export async function readFloat32(array, start, end, label, options = {}) {
  if (array.dtype.kind === 'float' && array.dtype.bytes === 4 &&
      end - start <= slabRows(array, 1)) {
    const values = await array.read([[start, end]], options);
    if (values.length !== end - start) throw lengthMismatch(label);
    return values;
  }
  return readConvertedRange(array, start, end, Float32Array, label, writeFloat32, options);
}

/** Rows `[start, end)` of a one-dimensional integer array as int32. */
export async function readInt32(array, start, end, label, options = {}) {
  return readConvertedRange(array, start, end, Int32Array, label, writeInt32, options);
}

/**
 * Rows `[start, end)` of a one-dimensional integer array as plain numbers:
 * 64-bit integers become an exact Float64Array, every narrower type is kept
 * as read.
 */
export async function readIntegers(array, start, end, label, options = {}) {
  if (array.dtype.bytes !== 8 || array.dtype.kind === 'float') {
    const values = await array.read([[start, end]], options);
    if (values.length !== end - start) throw lengthMismatch(label);
    return values;
  }
  return readConvertedRange(array, start, end, Float64Array, label, writeExactNumbers, options);
}

/**
 * Rows `[start, end)` of a one-dimensional numeric array as numbers, without
 * a conversion pass: the stored typed array as read, or for 64-bit integers
 * (BigInts) their nearest doubles. For values that are written straight
 * into a float32 destination (a gene index, a gene column), which rounds
 * each one as it is stored.
 */
export async function readNumbers(array, start, end, label, options = {}) {
  const values = await array.read([[start, end]], options);
  if (!values || values.length !== end - start) throw lengthMismatch(label);
  if (values instanceof BigInt64Array || values instanceof BigUint64Array) return Float64Array.from(values, Number);
  return values;
}

/** Rows `[start, end)` exactly as stored (typed array, strings, 0/1 booleans). */
export async function readStored(array, start, end, label, options = {}) {
  const values = await array.read([[start, end]], options);
  if (!values || values.length !== end - start) throw lengthMismatch(label);
  return values;
}
