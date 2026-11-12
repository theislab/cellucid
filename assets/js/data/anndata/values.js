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

import { HOST_LITTLE_ENDIAN } from '../../formats/io/byte-order.js';
import { allocateTypedArray } from '../sparse-column-index.js';
import { AnnDataFormatError, elementBytes } from './elements.js';

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

/**
 * Rows `[rowStart, rowEnd)` of an array in slabs, in whatever order the
 * store reads them fastest: a view's array presenting rows in another order
 * than stored (a subsample's priority order, `views/cell-subset.js`
 * `readInSourceOrder`) hands them out in the stored order, each slab's rows
 * wherever they belong; any other array slab by slab (`readRowSlabs`). For
 * a reader that puts every row in its place (`readConvertedRange`): one in
 * which the order matters (a sum, `forEachObsmRowSlab`) reads
 * `readRowSlabs`.
 *
 * Each slab is `{values, runs}`: its value rows `[runs.offsets[r],
 * runs.offsets[r + 1])` are rows `runs.starts[r]` on (`scatterRows`); or,
 * read row by row (a view's whole rows in their file order,
 * `cell-subset.js` `rowWaves`), `runs` is `{rows}`: value row `i` is row
 * `rows[i]` (`slabRows` counts either).
 *
 * @param {import('../../formats/store.js').StoreNode & {read: Function, shape: number[]}} array
 * @param {number} rowStart
 * @param {number} rowEnd
 * @param {{columns?: [number, number]|null, signal?: AbortSignal|null, activity?: Object|null}} [options]
 * @returns {AsyncGenerator<{values: any, runs: {count: number, starts: ArrayLike<number>, offsets: ArrayLike<number>}}>}
 */
export async function* readRowsInStoreOrder(array, rowStart, rowEnd, { columns = null, ...readOptions } = {}) {
  if (typeof array.readInSourceOrder !== 'function') {
    for await (const slab of readRowSlabs(array, rowStart, rowEnd, { columns, ...readOptions })) {
      yield { values: slab.values, runs: { count: 1, starts: [slab.rowStart], offsets: [0, slab.rowEnd - slab.rowStart] } };
    }
    return;
  }
  if (rowEnd <= rowStart) return;
  const selection = columns === null ? [[rowStart, rowEnd]] : [[rowStart, rowEnd], columns];
  if (readOptions.activity && typeof array.storedBytes === 'function') {
    array.storedBytes(selection, readOptions).then(bytes => readOptions.activity.expect(bytes), () => {});
  }
  yield* array.readInSourceOrder(selection, readOptions);
}

/** How many value rows a slab's `runs` (`readRowsInStoreOrder`) hold. */
export function slabRowCount(runs) {
  return runs.rows !== undefined ? runs.rows.length : runs.offsets[runs.count];
}

/**
 * Rows of `source` (`width` elements a row) put where a slab's `runs` say
 * (`readRowsInStoreOrder`: runs, or a row a value row), into `output`
 * holding rows from `origin` on.
 */
export function scatterRows(source, width, runs, output, origin) {
  if (runs.rows !== undefined) {
    const rows = runs.rows;
    if (width === 1) {
      for (let i = 0; i < rows.length; i++) output[rows[i] - origin] = source[i];
      return;
    }
    for (let i = 0; i < rows.length; i++) {
      const at = (rows[i] - origin) * width;
      for (let j = 0; j < width; j++) output[at + j] = source[i * width + j];
    }
    return;
  }
  for (let r = 0; r < runs.count; r++) {
    const from = runs.offsets[r] * width;
    const to = runs.offsets[r + 1] * width;
    const at = (runs.starts[r] - origin) * width;
    if (to - from > 32 && ArrayBuffer.isView(source) && ArrayBuffer.isView(output)) output.set(source.subarray(from, to), at);
    else for (let i = from; i < to; i++) output[at + i - from] = source[i];
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
const LOW_WORD = HOST_LITTLE_ENDIAN ? 0 : 1;
const HIGH_WORD = HOST_LITTLE_ENDIAN ? 1 : 0;

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
        throw new AnnDataFormatError(`${label} ${values[i]} is outside the Int32 range`);
      }
      output[offset + i] = value;
    }
    return;
  }
  for (let i = 0; i < length; i++) {
    const raw = values[i];
    if (typeof raw === 'bigint') {
      if (raw < -2147483648n || raw > 2147483647n) {
        throw new AnnDataFormatError(`${label} ${raw} is outside the Int32 range`);
      }
      output[offset + i] = Number(raw);
      continue;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647) {
      throw new AnnDataFormatError(`${label} ${String(raw)} is outside the Int32 range`);
    }
    output[offset + i] = value;
  }
}

/**
 * A writer (`readConvertedRange`) of positions along an axis of `bound`
 * entries as int32: each must be an integer in `[0, bound)`, else the read is
 * refused, never narrowed. 64-bit integers go through their words.
 *
 * @param {number} bound
 * @returns {(values: ArrayLike<number|bigint>, output: Int32Array, offset: number, label: string) => void}
 */
export function axisPositionWriter(bound) {
  const outside = (label, raw) => new Error(`${label} ${String(raw)} is outside axis bounds [0, ${bound})`);
  return (values, output, offset, label) => {
    const length = values.length;
    if (is64BitIntegers(values)) {
      const words = wordsOf(values);
      const signed = values instanceof BigInt64Array;
      for (let i = 0; i < length; i++) {
        const value = valueOfWords(words, i, signed);
        if (!(value >= 0 && value < bound)) throw outside(label, values[i]);
        output[offset + i] = value;
      }
      return;
    }
    // Integers already (a graph's or matrix's int32 indices): a bound check each.
    if (values instanceof Int32Array || values instanceof Uint32Array || values instanceof Int16Array ||
        values instanceof Uint16Array || values instanceof Int8Array || values instanceof Uint8Array) {
      for (let i = 0; i < length; i++) {
        const value = values[i];
        if (!(value >= 0 && value < bound)) throw outside(label, value);
        output[offset + i] = value;
      }
      return;
    }
    for (let i = 0; i < length; i++) {
      const value = Number(values[i]);
      if (!(value >= 0 && value < bound) || !Number.isInteger(value)) throw outside(label, values[i]);
      output[offset + i] = value;
    }
  };
}

/** Write `values` as exact numbers (64-bit integers checked against the safe range). */
export function writeExactNumbers(values, output, offset, label) {
  const length = values.length;
  if (is64BitIntegers(values)) {
    const words = wordsOf(values);
    const signed = values instanceof BigInt64Array;
    for (let i = 0; i < length; i++) {
      const value = valueOfWords(words, i, signed);
      if (!Number.isSafeInteger(value)) {
        throw new AnnDataFormatError(`${label} ${values[i]} is outside the safe integer range`);
      }
      output[offset + i] = value;
    }
    return;
  }
  for (let i = 0; i < length; i++) {
    const raw = values[i];
    if (raw > 9007199254740991n || raw < -9007199254740991n) {
      throw new AnnDataFormatError(`${label} ${raw} is outside the safe integer range`);
    }
    output[offset + i] = Number(raw);
  }
}

/**
 * Rows `[start, end)` of a one-dimensional array, written slab by slab with
 * `write(values, output, offset, label)` into one output allocated once,
 * in the order the store reads them fastest (`readRowsInStoreOrder`).
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
  for await (const { values, runs } of readRowsInStoreOrder(array, start, end, options)) {
    const rows = slabRowCount(runs);
    if (!values || values.length !== rows) throw lengthMismatch(label);
    if (runs.rows === undefined && runs.count === 1) {
      write(values, output, runs.starts[0] - start, label);
      continue;
    }
    // Rows in the store's order: converted together, then put in place.
    const converted = allocateTypedArray(OutputType, rows, label);
    write(values, converted, 0, label);
    scatterRows(converted, 1, runs, output, start);
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

/**
 * Write `values` into a float64 `output` at `offset`: exact for every
 * integer up to 2^53 (64-bit integers through their words), the nearest
 * double beyond.
 */
function writeFloat64(values, output, offset) {
  if (ArrayBuffer.isView(values) && !is64BitIntegers(values)) {
    output.set(values, offset);
    return;
  }
  const numbers = asNumbers(values, 'Values');
  for (let i = 0; i < numbers.length; i++) output[offset + i] = Number(numbers[i]);
}

/**
 * Whether the values of an integer dtype need float64 to be held exactly:
 * float32 holds every integer up to 2^24 exactly, so 8- and 16-bit integers
 * fit it, and wider ones may not (cell or donor ids, deep cells' counts);
 * so does a view presenting such integers as float64 (a MuData modality's
 * column placed on the cells, `wideIntegers`).
 */
export function exactIntegersNeedFloat64(array) {
  const kind = array?.dtype?.kind;
  return ((kind === 'int' || kind === 'uint') && array.dtype.bytes > 2) || array?.wideIntegers === true;
}

/**
 * Rows `[start, end)` of a one-dimensional numeric array as the values a
 * continuous field holds: an integer dtype wider than 16 bits as float64,
 * so every integer up to 2^53 stays exact (`exactIntegersNeedFloat64`);
 * every other numeric dtype as float32 (`readFloat32`).
 */
export async function readContinuous(array, start, end, label, options = {}) {
  if (!exactIntegersNeedFloat64(array)) return readFloat32(array, start, end, label, options);
  return readConvertedRange(array, start, end, Float64Array, label, writeFloat64, options);
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
  return asNumbers(values, label);
}

/**
 * Values read from a store as numbers: 64-bit integers (BigInts) as their
 * nearest doubles through their words (never a BigInt per element), every
 * other typed array as read.
 *
 * @param {ArrayLike<number|bigint>} values
 * @param {string} label
 * @returns {ArrayLike<number>}
 */
export function asNumbers(values, label) {
  if (!is64BitIntegers(values)) return values;
  const numbers = allocateTypedArray(Float64Array, values.length, label);
  const words = wordsOf(values);
  const signed = values instanceof BigInt64Array;
  for (let i = 0; i < values.length; i++) numbers[i] = valueOfWords(words, i, signed);
  return numbers;
}

/**
 * Whether 64-bit integers (BigInts) hold a value no double holds exactly:
 * one past the safe integers (beyond ±(2^53 − 1)). Such integers are
 * identifiers (a database id, a barcode hashed to an integer), never
 * measurements, so a column of them is read as their exact decimal text
 * (`readExactIntegers`), as a categorical's labels are (`dataframe.js`
 * `categoryLabels`). Positions `mask` marks (a nullable column's missing
 * values) are not data and are passed over. Read through the values' 32-bit
 * words, never a BigInt per value.
 *
 * @param {ArrayLike<number|bigint>} values
 * @param {ArrayLike<number>|null} [mask]
 * @returns {boolean}
 */
export function holdsUnsafeIntegers(values, mask = null) {
  if (!is64BitIntegers(values)) return false;
  const words = wordsOf(values);
  const signed = values instanceof BigInt64Array;
  for (let i = 0; i < values.length; i++) {
    if (mask !== null && mask[i]) continue;
    if (!Number.isSafeInteger(valueOfWords(words, i, signed))) return true;
  }
  return false;
}

/** Why a column of integers is read as text: one line, said with the column (`readExactIntegers`). */
export const UNSAFE_INTEGERS_AS_TEXT = 'Read as text: it holds whole numbers past 2^53, which are identifiers, not measurements, and no number holds them exactly.';

/**
 * Rows `[start, end)` of a one-dimensional integer array of 64 bits, exactly:
 * `{values}`, a Float64Array (NaN where `mask` marks a missing value), when
 * every value is a safe integer; otherwise `{text}`, every value as its
 * decimal text (null where missing), the column then being identifiers
 * (`holdsUnsafeIntegers`). One read of the stored values; `mask` (1 =
 * missing) is a nullable column's, already read for these rows.
 *
 * `as` is how a column already shown reads more rows: `'text'` (it was
 * found to be identifiers: these rows too, whatever they hold) or
 * `'numbers'` (it was found to be numbers: these rows as their nearest
 * doubles); `'decide'` decides from these rows.
 *
 * @param {'decide'|'text'|'numbers'} [as]
 * @returns {Promise<{values: Float64Array}|{text: Array<string|null>}>}
 */
export async function readExactIntegers(array, start, end, label, options = {}, mask = null, as = 'decide') {
  const raw = await readStored(array, start, end, label, options);
  if (as === 'text' || (as === 'decide' && holdsUnsafeIntegers(raw, mask))) {
    const text = new Array(raw.length);
    for (let i = 0; i < raw.length; i++) text[i] = mask !== null && mask[i] ? null : raw[i].toString();
    return { text };
  }
  const values = allocateTypedArray(Float64Array, raw.length, label);
  writeFloat64(raw, values, 0);
  if (mask !== null) for (let i = 0; i < values.length; i++) if (mask[i]) values[i] = Number.NaN;
  return { values };
}

/** Whether `array` stores integers of 64 bits (read exactly by `readExactIntegers`). */
export function stores64BitIntegers(array) {
  const kind = array?.dtype?.kind;
  return (kind === 'int' || kind === 'uint') && array.dtype.bytes === 8;
}

/** Rows `[start, end)` exactly as stored (typed array, strings, 0/1 booleans). */
export async function readStored(array, start, end, label, options = {}) {
  const values = await array.read([[start, end]], options);
  if (!values || values.length !== end - start) throw lengthMismatch(label);
  return values;
}
