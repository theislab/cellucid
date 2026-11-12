/**
 * Turning stored element bytes into the store's values.
 *
 * `decodeElements` turns the bytes of `count` elements (gathered in row-major
 * order, in a buffer the caller owns) into the value `read()` returns (see
 * formats/store.js): numbers become a typed array over the same buffer
 * (byte-swapped in place when stored big-endian; no copy), half floats
 * become a `Float32Array`, strings an `Array`, compounds an `Array` of rows.
 * `decodeField` takes one compound member out of whole elements as its own
 * column, and `attributeValue` gives an attribute's JSON-like value.
 *
 * Variable-length values point into global heap collections: the caller
 * finds them with `heapAddresses`, loads them (heaps.js), and passes them in.
 *
 * @module formats/hdf5/decode
 */

import { needsSwap, swapBytes } from '../io/byte-order.js';
import { decodeText, readUintLE } from './binary.js';
import { isBooleanEnum, storeDtype } from './datatype.js';
import { collectionEntryBytes, findCollection, objectStart } from './heaps.js';
import { formatError } from './errors.js';
import { valueArrayClass } from '../store.js';
import { formatCountOf } from '../../utils/format-units.js';
import { allocateTypedArray, copyTypedArray } from '../../data/sparse-column-index.js';

/* ---------- half precision ---------- */

let halfTable = null;

/** Float32 value of every 16-bit IEEE half-precision pattern. */
function halfToFloatTable() {
  if (halfTable !== null) return halfTable;
  halfTable = new Float32Array(65536);
  for (let bits = 0; bits < 65536; bits++) {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const fraction = bits & 0x3ff;
    let value;
    if (exponent === 0) value = sign * fraction * 2 ** -24;
    else if (exponent === 31) value = fraction === 0 ? sign * Infinity : NaN;
    else value = sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
    halfTable[bits] = value;
  }
  return halfTable;
}

/* ---------- byte order ---------- */

/** Bytes of `bytes` that a typed array of `size`-byte elements can view in place. */
function ownedAligned(bytes, size) {
  return bytes.byteOffset % size === 0 ? bytes : copyTypedArray(Uint8Array, bytes, 'HDF5 values');
}

/* ---------- heap references ---------- */

/**
 * How much more than the referenced objects' mean size the objects before
 * the furthest one are taken to take, on average: strings of one column vary
 * in length around their mean.
 */
const PREFIX_SPREAD = 1.125;

/**
 * The global heap collections the elements `rows` (`[from, to, ...]`, in
 * elements of `bytes`) of a variable-length `type` point to, with the bytes
 * of each they need, measured from every element of `bytes` (`count`).
 *
 * A collection is parsed from its start, so what is read of it is its
 * prefix up to the furthest object asked for. The elements around the rows
 * asked for (the rest of their chunk of references) point into the same
 * collections and name the other objects' lengths: the bytes before an
 * object are those of the objects of lower index (objects lie in index
 * order), known exactly where these elements name them, and taken at the
 * named ones' mean size (with `PREFIX_SPREAD`) where not. A column's
 * elements need not name their objects in index order (libhdf5 numbers a
 * conversion buffer's objects from its end: a chunk's first element names
 * the highest index of its collection), so the furthest object asked for is
 * found by index, not by element. An object past what is read still decodes:
 * the collection is completed for it (`IncompleteCollectionError`).
 *
 * @param {import('./context.js').FileContext} file
 * @param {Object} type - A variable-length datatype
 * @param {Uint8Array} bytes - The references of `count` elements
 * @param {number} count
 * @param {ArrayLike<number>} rows - Element ranges asked for, `[from, to, ...]`
 * @param {Array<{bytes: Uint8Array, count: number}>} [beside] - Other
 *   references (the neighboring chunks'), naming objects only
 * @returns {Map<number, number> & {unnamed: number}} Collection address ->
 *   bytes of it to read; `unnamed`: the objects asked for some of whose
 *   predecessors no element names (their bytes taken from the mean)
 */
export function rowHeapNeeds(file, type, bytes, count, rows, beside = []) {
  const size = type.size;
  const unit = type.variable === 'string' ? 1 : type.base.size;
  const fail = problem => {
    throw formatError('Variable-length data', NaN, problem);
  };
  const header = 8 + file.lengthSize;
  // Every element's object, by collection: its index and the bytes it takes;
  // the elements beside (`beside`: the neighboring chunks' references) name
  // more objects of the collections these point into (one collection holds
  // the end of a chunk's strings and the start of the next's).
  const objects = new Map();
  const name = (from, n, only) => {
    for (let i = 0; i < n; i++) {
      const at = i * size;
      const address = readUintLE(from, at + 4, file.offsetSize, fail);
      if (address === null || address === 0) continue;
      let list = objects.get(address);
      if (list === undefined) {
        if (only) continue;
        objects.set(address, list = []);
      }
      const length = readUintLE(from, at, 4, fail);
      const index = readUintLE(from, at + 4 + file.offsetSize, 4, fail) ?? 0;
      list.push(index, collectionEntryBytes(file, length * unit));
    }
  };
  name(bytes, count, false);
  for (const other of beside) name(other.bytes, other.count, true);
  // Per collection: its named indexes ascending, and the bytes before each.
  const placed = new Map();
  for (const [address, list] of objects) {
    const n = list.length / 2;
    // Object indexes are 16-bit, as are a collection's objects: (index,
    // element) in one 32-bit key, sorted as numbers (elements naming
    // anything else are ordered one by one).
    let order;
    let small = n <= 65536;
    for (let k = 0; small && k < n; k++) small = list[2 * k] <= 0xffff;
    if (small) {
      const keys = allocateTypedArray(Uint32Array, n, 'Heap object order');
      for (let k = 0; k < n; k++) keys[k] = list[2 * k] * 65536 + k;
      keys.sort();
      order = k => keys[k] & 0xffff;
    } else {
      const sorted = Array.from({ length: n }, (_, k) => k).sort((a, b) => list[2 * a] - list[2 * b]);
      order = k => sorted[k];
    }
    const indexes = allocateTypedArray(Float64Array, n, 'Heap object order');
    const before = allocateTypedArray(Float64Array, n + 1, 'Heap object order');
    // An object named twice (rows read twice) counts once.
    let m = 0;
    for (let k = 0; k < n; k++) {
      const element = order(k);
      if (m > 0 && indexes[m - 1] === list[2 * element]) continue;
      indexes[m] = list[2 * element];
      before[m + 1] = before[m] + list[2 * element + 1];
      m++;
    }
    placed.set(address, { indexes: indexes.subarray(0, m), before: before.subarray(0, m + 1), mean: before[m] / m });
  }
  const needs = new Map();
  /** Objects asked for whose bytes before them were taken in part from the mean. */
  needs.unnamed = 0;
  for (let r = 0; r < rows.length; r += 2) {
    for (let i = rows[r]; i < rows[r + 1]; i++) {
      const at = i * size;
      const length = readUintLE(bytes, at, 4, fail);
      if (length === 0) continue;
      const address = readUintLE(bytes, at + 4, file.offsetSize, fail);
      if (address === null || address === 0) continue;
      const index = readUintLE(bytes, at + 4 + file.offsetSize, 4, fail) ?? 0;
      const { indexes, before, mean } = placed.get(address);
      // Named objects of lower index, and how many lower indexes none names.
      let lo = 0;
      let hi = indexes.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (indexes[mid] < index) lo = mid + 1;
        else hi = mid;
      }
      const unnamed = Math.max(0, index - 1 - lo);
      if (unnamed > 0) needs.unnamed++;
      const end = header + before[lo] + Math.ceil(unnamed * mean * PREFIX_SPREAD) + collectionEntryBytes(file, length * unit);
      if (end > (needs.get(address) ?? 0)) needs.set(address, end);
    }
  }
  return needs;
}

/**
 * Add to `into` every global heap collection the `count` elements of `type`
 * in `bytes` point to, with the bytes of it they need.
 */
export function heapAddresses(file, type, bytes, count, into = new Map()) {
  if (type.class === 'variable-length') {
    const size = type.size;
    // Bytes per element of the referenced data: a string's are its bytes.
    const unit = type.variable === 'string' ? 1 : type.base.size;
    const fail = problem => {
      throw formatError('Variable-length data', NaN, problem);
    };
    // Per collection: the bytes of the objects referenced, and how far into
    // the collection the furthest of them lies. A collection is parsed from
    // its start (objects have no index), so what is read of it is its prefix
    // up to the furthest object: estimated from that object's index and the
    // referenced objects' mean size (objects are written in order, so the
    // ones before it are like them), a little more for the spread of sizes.
    // One read then usually holds every object asked for, without reading a
    // large collection whole (a string column's) or a second, dependent
    // round trip for what lies past the objects' own bytes.
    const seen = new Map();
    let last = null;
    let lastAddress = -1;
    for (let i = 0; i < count; i++) {
      const at = i * size;
      const length = readUintLE(bytes, at, 4, fail);
      if (length === 0) continue;
      const address = readUintLE(bytes, at + 4, file.offsetSize, fail);
      if (address === null || address === 0) continue;
      const index = readUintLE(bytes, at + 4 + file.offsetSize, 4, fail) ?? 0;
      // Neighboring elements usually share a collection.
      if (address !== lastAddress) {
        last = seen.get(address);
        if (last === undefined) {
          last = { bytes: 0, objects: 0, maxIndex: 0 };
          seen.set(address, last);
        }
        lastAddress = address;
      }
      last.bytes += collectionEntryBytes(file, length * unit);
      last.objects++;
      if (index > last.maxIndex) last.maxIndex = index;
    }
    for (const [address, entry] of seen) {
      const header = 8 + file.lengthSize;
      const prefix = header + Math.ceil(entry.maxIndex * (entry.bytes / entry.objects) * PREFIX_SPREAD);
      into.set(address, Math.max(into.get(address) ?? 0, header + entry.bytes, prefix));
    }
  } else if (type.class === 'compound') {
    for (const member of type.members) {
      if (!hasHeapData(member.type)) continue;
      const width = member.type.size;
      const perElement = member.shape.reduce((a, b) => a * b, 1);
      const column = allocateTypedArray(Uint8Array, count * perElement * width, 'HDF5 compound member');
      for (let i = 0; i < count; i++) {
        column.set(bytes.subarray(i * type.size + member.offset, i * type.size + member.offset + perElement * width), i * perElement * width);
      }
      heapAddresses(file, member.type, column, count * perElement, into);
    }
  } else if (type.class === 'array') {
    heapAddresses(file, type.base, bytes, count * type.dims.reduce((a, b) => a * b, 1), into);
  }
  return into;
}

function hasHeapData(type) {
  if (type.class === 'variable-length') return true;
  if (type.class === 'compound') return type.members.some(member => hasHeapData(member.type));
  if (type.class === 'array') return hasHeapData(type.base);
  return false;
}

/* ---------- scalar readers (compound members, attributes) ---------- */

/**
 * A function reading one value of `type` at a byte offset:
 * `(bytes, view, offset) => value`. Built once per type and read.
 *
 * @param {Object} type - Hdf5Type
 * @param {{file: Object, collections: Map, booleans: boolean, exactIntegers: boolean}} context
 */
function scalarReader(type, context) {
  const dtype = storeDtype(type);
  switch (type.class) {
    case 'fixed-point':
    case 'bitfield':
    case 'floating-point': {
      if (dtype.kind === 'opaque') return opaqueReader(type.size);
      return numberReader(dtype, context.exactIntegers);
    }
    case 'enum': {
      const base = scalarReader(type.base, context);
      if (context.booleans && isBooleanEnum(type)) return (bytes, view, offset) => base(bytes, view, offset) !== 0;
      return base;
    }
    case 'string': {
      const size = type.size;
      return (bytes, view, offset) => {
        let end = offset;
        const limit = offset + size;
        while (end < limit && bytes[end] !== 0) end++;
        return decodeText(bytes.subarray(offset, end));
      };
    }
    case 'variable-length': {
      const { file, collections } = context;
      const O = file.offsetSize;
      const fail = problem => {
        throw formatError('Variable-length data', NaN, problem);
      };
      if (type.variable === 'string') {
        // Neighboring strings are usually in the same collection: remember the last.
        let lastAddress = -1;
        let last = null;
        return (bytes, view, offset) => {
          const length = view.getUint32(offset, true);
          if (length === 0) return '';
          const address = readUintLE(bytes, offset + 4, O, fail);
          if (address !== lastAddress) {
            last = findCollection(file, collections, address, 'Variable-length string');
            lastAddress = address;
          }
          if (last === null) return '';
          const index = view.getUint32(offset + 4 + O, true);
          const start = objectStart(file, last, address, index, 'Variable-length string');
          const heap = last.bytes;
          const limit = start + Math.min(length, last.sizes[index]);
          let end = start;
          while (end < limit && heap[end] !== 0) end++;
          return decodeText(heap.subarray(start, end));
        };
      }
      const baseType = type.base;
      const baseSize = baseType.size;
      return (bytes, view, offset) => {
        const length = view.getUint32(offset, true);
        const address = length === 0 ? null : readUintLE(bytes, offset + 4, O, fail);
        const collection = findCollection(file, collections, address, 'Variable-length sequence');
        if (collection === null) return decodeElements(file, baseType, new Uint8Array(0), 0, collections);
        const index = view.getUint32(offset + 4 + O, true);
        const start = objectStart(file, collection, address, index, 'Variable-length sequence');
        const heap = collection.bytes;
        const size = collection.sizes[index];
        if (length * baseSize > size) {
          throw formatError('Variable-length sequence', NaN, `${formatCountOf(length, 'element')} do not fit its ${size}-byte heap object`);
        }
        return decodeElements(file, baseType, heap.slice(start, start + length * baseSize), length, collections);
      };
    }
    case 'compound': {
      const members = type.members.map(member => memberReader(member, context));
      return (bytes, view, offset) => members.map(read => read(bytes, view, offset));
    }
    case 'array': {
      const base = scalarReader(type.base, context);
      return nestedReader(base, type.dims, type.base.size);
    }
    default:
      return opaqueReader(type.size);
  }
}

function opaqueReader(size) {
  return (bytes, view, offset) => bytes.slice(offset, offset + size);
}

function numberReader(dtype, exactIntegers) {
  const le = dtype.littleEndian !== false;
  switch (dtype.name) {
    case 'int8': return (bytes, view, offset) => view.getInt8(offset);
    case 'uint8': return (bytes, view, offset) => bytes[offset];
    case 'int16': return (bytes, view, offset) => view.getInt16(offset, le);
    case 'uint16': return (bytes, view, offset) => view.getUint16(offset, le);
    case 'int32': return (bytes, view, offset) => view.getInt32(offset, le);
    case 'uint32': return (bytes, view, offset) => view.getUint32(offset, le);
    case 'int64': return exactIntegers
      ? (bytes, view, offset) => view.getBigInt64(offset, le)
      : (bytes, view, offset) => safeNumber(view.getBigInt64(offset, le));
    case 'uint64': return exactIntegers
      ? (bytes, view, offset) => view.getBigUint64(offset, le)
      : (bytes, view, offset) => safeNumber(view.getBigUint64(offset, le));
    case 'float16': {
      const table = halfToFloatTable();
      return (bytes, view, offset) => table[view.getUint16(offset, le)];
    }
    case 'float32': return (bytes, view, offset) => view.getFloat32(offset, le);
    case 'float64': return (bytes, view, offset) => view.getFloat64(offset, le);
    default: throw new TypeError(`No reader for ${dtype.name}.`);
  }
}

/** A JSON-like number: a BigInt only when the value is outside the safe range. */
function safeNumber(value) {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function memberReader(member, context) {
  const base = scalarReader(member.type, context);
  const offset = member.offset;
  if (member.shape.length === 0) return (bytes, view, at) => base(bytes, view, at + offset);
  const nested = nestedReader(base, member.shape, member.type.size);
  return (bytes, view, at) => nested(bytes, view, at + offset);
}

/** Read `dims` values of `size` bytes each as nested arrays. */
function nestedReader(base, dims, size) {
  const strides = new Array(dims.length);
  let stride = size;
  for (let d = dims.length - 1; d >= 0; d--) {
    strides[d] = stride;
    stride *= dims[d];
  }
  const build = (bytes, view, offset, depth) => {
    const out = new Array(dims[depth]);
    for (let i = 0; i < dims[depth]; i++) {
      out[i] = depth === dims.length - 1
        ? base(bytes, view, offset + i * size)
        : build(bytes, view, offset + i * strides[depth], depth + 1);
    }
    return out;
  };
  return (bytes, view, offset) => build(bytes, view, offset, 0);
}

/* ---------- bulk decoding ---------- */

/**
 * The store value of `count` elements of `type` in `bytes`.
 *
 * `bytes` must be owned by the caller and not used afterwards: numeric values
 * are returned as a typed array over it.
 *
 * @param {Object} file - FileContext (sizes)
 * @param {Object} type - Hdf5Type
 * @param {Uint8Array} bytes
 * @param {number} count
 * @param {Map} collections - Loaded global heap collections
 */
export function decodeElements(file, type, bytes, count, collections) {
  const dtype = storeDtype(type);
  if (type.class === 'array' && dtype.arrayShape !== undefined) {
    const per = type.dims.reduce((a, b) => a * b, 1);
    return decodeElements(file, type.base, bytes, count * per, collections);
  }
  switch (dtype.kind) {
    case 'int':
    case 'uint':
    case 'float':
    case 'enum':
      return numericValues(dtype.kind === 'enum' ? dtype.base : dtype, bytes, count);
    case 'bool':
      return booleanValues(dtype, bytes, count);
    case 'string': {
      const read = scalarReader(type, { file, collections, booleans: false, exactIntegers: true });
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const size = type.size;
      const out = new Array(count);
      for (let i = 0; i < count; i++) out[i] = read(bytes, view, i * size);
      return out;
    }
    case 'compound': {
      const read = scalarReader(type, { file, collections, booleans: false, exactIntegers: true });
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const out = new Array(count);
      for (let i = 0; i < count; i++) out[i] = read(bytes, view, i * type.size);
      return out;
    }
    default: {
      if (dtype.sequence !== undefined) {
        const read = scalarReader(type, { file, collections, booleans: false, exactIntegers: true });
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const out = new Array(count);
        for (let i = 0; i < count; i++) out[i] = read(bytes, view, i * type.size);
        return out;
      }
      return bytes.length === count * type.size ? bytes : bytes.slice(0, count * type.size);
    }
  }
}

/** A numeric dtype's typed array over `bytes`, in host order. */
export function numericValues(dtype, bytes, count) {
  const size = dtype.bytes;
  if (dtype.name === 'float16') {
    const table = halfToFloatTable();
    const out = allocateTypedArray(Float32Array, count, 'HDF5 float16 values');
    const source = ownedAligned(bytes, 2);
    if (needsSwap(dtype.littleEndian !== false, 2)) swapBytes(source, 2);
    const words = new Uint16Array(source.buffer, source.byteOffset, count);
    for (let i = 0; i < count; i++) out[i] = table[words[i]];
    return out;
  }
  const Type = valueArrayClass(dtype);
  const owned = ownedAligned(bytes, size);
  if (needsSwap(dtype.littleEndian !== false, size)) swapBytes(owned.subarray(0, count * size), size);
  return new Type(owned.buffer, owned.byteOffset, count);
}

function booleanValues(dtype, bytes, count) {
  const out = dtype.bytes === 1 ? bytes.subarray(0, count) : allocateTypedArray(Uint8Array, count, 'HDF5 booleans');
  if (dtype.bytes === 1) {
    for (let i = 0; i < count; i++) if (out[i] > 1) out[i] = 1;
    if (out.byteOffset === 0 && out.length === out.buffer.byteLength) return out;
    return copyTypedArray(Uint8Array, out, 'HDF5 booleans');
  }
  const base = numericValues(dtype.base, bytes, count);
  for (let i = 0; i < count; i++) out[i] = base[i] ? 1 : 0;
  return out;
}

/**
 * One member of `count` compound elements in `bytes`, as its own values: a
 * typed array for numbers (array members' values one after another per
 * element), an `Array` otherwise.
 */
export function decodeField(file, type, member, bytes, count, collections) {
  const perElement = member.shape.reduce((a, b) => a * b, 1);
  const width = member.type.size * perElement;
  const stride = type.size;
  const column = allocateTypedArray(Uint8Array, count * width, 'HDF5 compound member');
  // Strided gather of the member's bytes: short members copy byte by byte,
  // long ones by subarray.
  if (width <= 16) {
    for (let i = 0, from = member.offset, to = 0; i < count; i++, from += stride) {
      for (let b = 0; b < width; b++) column[to++] = bytes[from + b];
    }
  } else {
    for (let i = 0; i < count; i++) {
      const from = i * stride + member.offset;
      column.set(bytes.subarray(from, from + width), i * width);
    }
  }
  return decodeElements(file, member.type, column, count * perElement, collections);
}

/* ---------- attributes ---------- */

/**
 * An attribute's JSON-like value: a string, number (BigInt beyond the safe
 * range), boolean, row array, or nested arrays by `shape`; `null` for a null
 * dataspace.
 */
export function attributeValue(file, type, space, bytes, collections) {
  if (space.kind === 'null') return null;
  let elementType = type;
  let shape = space.dims;
  if (type.class === 'array' && storeDtype(type).arrayShape !== undefined) {
    elementType = type.base;
    shape = shape.concat(type.dims);
  }
  const count = shape.reduce((a, b) => a * b, 1);
  const size = elementType.size;
  if (bytes.length < count * size) {
    throw formatError('Attribute', NaN, `its ${formatCountOf(count, 'element')} need ${formatCountOf(count * size, 'byte')} but it holds ${bytes.length}`);
  }
  const read = scalarReader(elementType, { file, collections, booleans: true, exactIntegers: false });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (space.kind === 'scalar' && shape.length === 0) return freezeDeep(read(bytes, view, 0));
  const flat = new Array(count);
  for (let i = 0; i < count; i++) flat[i] = read(bytes, view, i * size);
  return freezeDeep(nest(flat, shape, 0, 0));
}

function nest(flat, shape, depth, start) {
  if (depth === shape.length - 1) return flat.slice(start, start + shape[depth]);
  let stride = 1;
  for (let d = depth + 1; d < shape.length; d++) stride *= shape[d];
  const out = new Array(shape[depth]);
  for (let i = 0; i < shape[depth]; i++) out[i] = nest(flat, shape, depth + 1, start + i * stride);
  return out;
}

function freezeDeep(value) {
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
    return Object.freeze(value);
  }
  return value;
}
