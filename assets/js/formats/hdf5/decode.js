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

import { decodeText, readUintLE } from './binary.js';
import { isBooleanEnum, storeDtype } from './datatype.js';
import { collectionEntryBytes, findCollection, objectStart } from './heaps.js';
import { formatError } from './errors.js';
import { valueArrayClass } from '../store.js';

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

/** Reverse the byte order of every `size`-byte element of `bytes`, in place. */
export function swapBytes(bytes, size) {
  if (size === 1) return;
  const aligned = bytes.byteOffset % size === 0 && bytes.length % size === 0;
  if (aligned && size === 2) {
    const words = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
    for (let i = 0; i < words.length; i++) {
      const v = words[i];
      words[i] = ((v & 0xff) << 8) | (v >>> 8);
    }
    return;
  }
  if (aligned && (size === 4 || size === 8)) {
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
    for (let i = 0; i < words.length; i++) {
      const v = words[i];
      words[i] = ((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24);
    }
    if (size === 8) {
      for (let i = 0; i < words.length; i += 2) {
        const low = words[i];
        words[i] = words[i + 1];
        words[i + 1] = low;
      }
    }
    return;
  }
  for (let start = 0; start + size <= bytes.length; start += size) {
    for (let a = start, b = start + size - 1; a < b; a++, b--) {
      const t = bytes[a];
      bytes[a] = bytes[b];
      bytes[b] = t;
    }
  }
}

/** Bytes of `bytes` that a typed array of `size`-byte elements can view in place. */
function ownedAligned(bytes, size) {
  return bytes.byteOffset % size === 0 ? bytes : bytes.slice();
}

/* ---------- heap references ---------- */

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
    let lastAddress = -1;
    let lastBytes = 0;
    for (let i = 0; i < count; i++) {
      const at = i * size;
      const length = readUintLE(bytes, at, 4, fail);
      if (length === 0) continue;
      const address = readUintLE(bytes, at + 4, file.offsetSize, fail);
      if (address === null || address === 0) continue;
      // Neighbouring elements usually share a collection: sum locally.
      if (address !== lastAddress) {
        if (lastAddress >= 0) into.set(lastAddress, lastBytes);
        lastAddress = address;
        lastBytes = into.get(address) ?? 8 + file.lengthSize;
      }
      lastBytes += collectionEntryBytes(file, length * unit);
    }
    if (lastAddress >= 0) into.set(lastAddress, lastBytes);
  } else if (type.class === 'compound') {
    for (const member of type.members) {
      if (!hasHeapData(member.type)) continue;
      const width = member.type.size;
      const perElement = member.shape.reduce((a, b) => a * b, 1);
      const column = new Uint8Array(count * perElement * width);
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
        // Neighbouring strings are usually in the same collection: remember the last.
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
          throw formatError('Variable-length sequence', NaN, `${length} elements do not fit its ${size}-byte heap object`);
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
    const out = new Float32Array(count);
    const source = ownedAligned(bytes, 2);
    if (dtype.littleEndian === false) swapBytes(source, 2);
    const words = new Uint16Array(source.buffer, source.byteOffset, count);
    for (let i = 0; i < count; i++) out[i] = table[words[i]];
    return out;
  }
  const Type = valueArrayClass(dtype);
  const owned = ownedAligned(bytes, size);
  if (dtype.littleEndian === false) swapBytes(owned.subarray(0, count * size), size);
  return new Type(owned.buffer, owned.byteOffset, count);
}

function booleanValues(dtype, bytes, count) {
  const out = dtype.bytes === 1 ? bytes.subarray(0, count) : new Uint8Array(count);
  if (dtype.bytes === 1) {
    for (let i = 0; i < count; i++) if (out[i] > 1) out[i] = 1;
    if (out.byteOffset === 0 && out.length === out.buffer.byteLength) return out;
    return out.slice();
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
  const column = new Uint8Array(count * width);
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
    throw formatError('Attribute', NaN, `its ${count} elements need ${count * size} bytes but it holds ${bytes.length}`);
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
