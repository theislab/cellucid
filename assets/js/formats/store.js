/**
 * The array store: one model of a hierarchical array file, whatever the
 * format it is stored in.
 *
 * An `.h5ad` (HDF5) and an AnnData `.zarr` store hold the same things: groups
 * of named children, arrays with a shape and an element type, and small
 * attributes. `formats/hdf5` and `formats/zarr` each open their format as this
 * model, and everything above them (the AnnData reader) is written once
 * against it. Both packages are tested to give the same answer as the
 * format's reference implementation.
 *
 * ## Nodes
 *
 * Navigation is synchronous: a store is opened with its whole node tree
 * (names, shapes, element types, attributes) already read, in as few round
 * trips as the format allows. Only array values are read on demand, with
 * `read()`.
 *
 * - `Group`: `kind: 'group'`, `keys()` (child names, sorted by code point),
 *   `get(name)` (a child, or a `/`-separated path below this group; `null`
 *   when absent), `has(name)`.
 * - `ArrayNode`: `kind: 'array'`, `shape`, `dtype`, `chunks`, `fillValue`,
 *   `read(selection, options)`, `storedBytes(selection, options)`, and for
 *   compound element types `readField(field, selection, options)`.
 *   `chunks` is the shape of one stored chunk, or `null` when the array is
 *   stored in one piece (any range of it costs only its own bytes).
 *   `storedBytes` resolves to the number of stored (compressed) bytes a read
 *   of the selection fetches, so a caller can say what a read will cost
 *   before making it.
 * - Both: `path` (absolute, `/` for the root), `name`, `attrs`.
 *
 * ## Attributes
 *
 * `attrs` is a frozen plain object of decoded values, the way JSON would hold
 * them: a string, a number (a 64-bit integer outside the safe range is a
 * `BigInt`), a boolean, or an array of those (nested for more than one
 * dimension). HDF5 attributes keep their stored type in `attributeType(name)`
 * (`{dtype, shape}`); a Zarr attribute is JSON and has none (`null`).
 *
 * ## Element types (`Dtype`)
 *
 * `kind` is one of `int`, `uint`, `float`, `bool`, `string`, `compound`,
 * `enum`, `opaque`; `name` the NumPy-style name (`int8` … `uint64`,
 * `float16` … `float64`, `bool`, `string`, `compound`, `enum`, `opaque`);
 * `bytes` the stored size of one element (`null` for variable-length
 * strings); `littleEndian` the stored byte order (`null` where it does not
 * apply). Strings add `variable` and `encoding` (`'utf-8'` or `'ascii'`);
 * compounds add `fields` (`{name, offset, dtype, shape}`, `shape` non-empty
 * for an array member); enums add `base` and `members` (name → number).
 * HDF5's boolean enum (`FALSE = 0`, `TRUE = 1`, as h5py writes NumPy
 * booleans) is `kind: 'bool'`.
 *
 * ## Values
 *
 * `read()` returns the selected elements in row-major order:
 *
 * | kind | value |
 * | --- | --- |
 * | `int`, `uint` | the matching typed array (`Int8Array` … `BigUint64Array`) |
 * | `float` | `Float32Array` (`float16` and `float32`) or `Float64Array` |
 * | `bool` | `Uint8Array` of 0 and 1 |
 * | `enum` | the typed array of its base integer type |
 * | `string` | an `Array` of strings (fixed-length strings end at the first NUL) |
 * | `compound` | an `Array` of row arrays, one value per field (see `readField`) |
 * | `opaque` | a `Uint8Array` of the raw elements |
 *
 * `readField(field, selection)` reads one member of a compound array as its
 * own values (the value of the member's type, as above). The selection covers
 * the compound array's own dimensions. For an array member (`shape` non-empty,
 * e.g. an embedding of 3 numbers per row), each element's member values
 * follow one another: a member of shape `[3]` read for 10 rows is 30 values,
 * row-major.
 *
 * A value returned by `read()` or `readField()` belongs to the caller: it is
 * never a view of a cache or of another result, so the caller may keep,
 * change or transfer it (to another thread) freely.
 *
 * Values are always in host (little-endian) order, whatever the stored order.
 * A scalar array (`shape: []`) reads as the single value, not an array.
 * Elements never written read as the array's fill value.
 *
 * ## Selections
 *
 * A selection has one `[start, stop]` pair per dimension (half-open, step 1);
 * dimensions left out are read whole; `undefined` reads everything. Reading
 * touches only the chunks the selection intersects, fetching them in
 * parallel and decoding each once.
 *
 * @module formats/store
 */

/**
 * @typedef {Object} Dtype
 * @property {'int'|'uint'|'float'|'bool'|'string'|'compound'|'enum'|'opaque'} kind
 * @property {string} name
 * @property {number|null} bytes
 * @property {boolean|null} littleEndian
 * @property {boolean} [variable]
 * @property {'utf-8'|'ascii'} [encoding]
 * @property {ReadonlyArray<{name: string, offset: number, dtype: Dtype, shape: ReadonlyArray<number>}>} [fields]
 * @property {Dtype} [base]
 * @property {Readonly<Record<string, number>>} [members]
 */

/**
 * @typedef {ReadonlyArray<readonly [number, number]>} Selection
 */

/**
 * @typedef {Object} ReadOptions
 * @property {AbortSignal|null} [signal]
 */

/**
 * @typedef {Object} StoreNode
 * @property {'group'|'array'} kind
 * @property {string} path
 * @property {string} name
 * @property {Readonly<Record<string, unknown>>} attrs
 * @property {(name: string) => ({dtype: Dtype, shape: ReadonlyArray<number>}|null)} attributeType
 */

/** Element type names by kind and size in bytes. */
const INTEGER_NAMES = Object.freeze({
  int: Object.freeze({ 1: 'int8', 2: 'int16', 4: 'int32', 8: 'int64' }),
  uint: Object.freeze({ 1: 'uint8', 2: 'uint16', 4: 'uint32', 8: 'uint64' }),
});
const FLOAT_NAMES = Object.freeze({ 2: 'float16', 4: 'float32', 8: 'float64' });

const INTEGER_ARRAYS = Object.freeze({
  int: Object.freeze({ 1: Int8Array, 2: Int16Array, 4: Int32Array, 8: BigInt64Array }),
  uint: Object.freeze({ 1: Uint8Array, 2: Uint16Array, 4: Uint32Array, 8: BigUint64Array }),
});

/**
 * A numeric element type.
 *
 * @param {'int'|'uint'|'float'} kind
 * @param {number} bytes
 * @param {boolean} [littleEndian]
 * @returns {Dtype}
 */
export function numericDtype(kind, bytes, littleEndian = true) {
  const name = kind === 'float' ? FLOAT_NAMES[bytes] : INTEGER_NAMES[kind]?.[bytes];
  if (name === undefined) {
    throw new TypeError(`There is no ${bytes}-byte ${kind} element type.`);
  }
  return Object.freeze({ kind, name, bytes, littleEndian: bytes === 1 ? null : littleEndian });
}

/** The boolean element type (one byte, 0 or 1). */
export const BOOL_DTYPE = Object.freeze({ kind: 'bool', name: 'bool', bytes: 1, littleEndian: null });

/**
 * A string element type.
 *
 * @param {{variable: boolean, encoding: 'utf-8'|'ascii', bytes?: number|null}} options
 * @returns {Dtype}
 */
export function stringDtype({ variable, encoding, bytes = null }) {
  if (encoding !== 'utf-8' && encoding !== 'ascii') {
    throw new TypeError(`Unknown string encoding '${encoding}'.`);
  }
  if (!variable && (!Number.isSafeInteger(bytes) || bytes < 0)) {
    throw new TypeError('A fixed-length string type needs its size in bytes.');
  }
  return Object.freeze({
    kind: 'string',
    name: 'string',
    bytes: variable ? null : bytes,
    littleEndian: null,
    variable,
    encoding,
  });
}

/**
 * The typed array class that holds values of a numeric, boolean or enum type.
 *
 * @param {Dtype} dtype
 * @returns {Int8ArrayConstructor|Uint8ArrayConstructor|Int16ArrayConstructor|Uint16ArrayConstructor|Int32ArrayConstructor|Uint32ArrayConstructor|BigInt64ArrayConstructor|BigUint64ArrayConstructor|Float32ArrayConstructor|Float64ArrayConstructor}
 */
export function valueArrayClass(dtype) {
  if (dtype.kind === 'bool') return Uint8Array;
  if (dtype.kind === 'enum') return valueArrayClass(dtype.base);
  if (dtype.kind === 'float') return dtype.bytes === 8 ? Float64Array : Float32Array;
  const constructor = INTEGER_ARRAYS[dtype.kind]?.[dtype.bytes];
  if (constructor === undefined) {
    throw new TypeError(`Values of a ${dtype.name} type are not held in a typed array.`);
  }
  return constructor;
}

/**
 * The selection `selection` of an array of `shape`, as one `[start, stop]`
 * per dimension: missing dimensions are whole, and every pair is checked.
 *
 * @param {ReadonlyArray<number>} shape
 * @param {Selection|undefined|null} selection
 * @param {string} label - What is read, for messages
 * @returns {Array<[number, number]>}
 */
export function normalizeSelection(shape, selection, label) {
  if (selection === undefined || selection === null) {
    return shape.map(extent => [0, extent]);
  }
  if (!Array.isArray(selection) || selection.length > shape.length) {
    throw new RangeError(`${label}: a selection needs at most one [start, stop] per dimension (${shape.length}).`);
  }
  return shape.map((extent, axis) => {
    const pair = selection[axis];
    if (pair === undefined || pair === null) return [0, extent];
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new RangeError(`${label}: dimension ${axis} needs a [start, stop] pair.`);
    }
    const [start, stop] = pair.map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(stop) || start < 0 || stop < start || stop > extent) {
      throw new RangeError(`${label}: [${pair[0]}, ${pair[1]}] is outside dimension ${axis} of length ${extent}.`);
    }
    return [start, stop];
  });
}

/** The number of elements a normalized selection holds. */
export function selectionSize(selection) {
  let count = 1;
  for (const [start, stop] of selection) count *= stop - start;
  return count;
}

/**
 * Split an absolute or relative `/`-separated path into its parts, refusing
 * empty, `.` and `..` parts.
 *
 * @param {string} path
 * @returns {string[]}
 */
export function pathParts(path) {
  if (typeof path !== 'string') throw new TypeError('A store path must be a string.');
  const parts = path.split('/').filter(part => part !== '');
  for (const part of parts) {
    if (part === '.' || part === '..') {
      throw new RangeError(`Store paths do not use '${part}': ${path}`);
    }
  }
  return parts;
}

/** Compare two names by code point, the order `keys()` lists children in. */
export function compareNames(left, right) {
  const a = [...left];
  const b = [...right];
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const difference = a[i].codePointAt(0) - b[i].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/** Whether `value` is a store group. */
export function isGroup(value) {
  return value !== null && typeof value === 'object' && value.kind === 'group' &&
    typeof value.keys === 'function' && typeof value.get === 'function';
}

/** Whether `value` is a store array. */
export function isArrayNode(value) {
  return value !== null && typeof value === 'object' && value.kind === 'array' &&
    Array.isArray(value.shape) && typeof value.read === 'function';
}
