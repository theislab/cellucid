/**
 * Element types: what a Zarr v2 `dtype` or a Zarr v3 `data_type` stores, how
 * its bytes become values, and its fill value.
 *
 * Each array's type is read into a `StoredType`:
 *
 * - `dtype`: the store contract's element type (`formats/store.js`);
 * - `itemSize`: stored bytes per element (`null` for variable-length strings);
 * - `form`: how decoded chunk bytes become values:
 *   `numeric` (a typed array, swapped to host order), `float16` (widened to
 *   `Float32Array`), `bool` (bytes that must be 0 or 1), `bytes-string`
 *   (NumPy `S`: UTF-8, trailing NULs trimmed), `utf32` (NumPy `U`: UTF-32
 *   code points), `vlen` (variable-length strings, decoded by their codec),
 *   `opaque` (raw element bytes) and `compound` (structured, by field).
 *
 * Fixed-width text, opaque and compound elements are assembled as raw bytes
 * and decoded only for the elements a read selects.
 *
 * NumPy `datetime64` / `timedelta64` are 64-bit integers (their unit is in
 * the metadata); complex numbers are `opaque` (two floats per element, raw).
 *
 * @module formats/zarr/dtypes
 */

import { BOOL_DTYPE, numericDtype, stringDtype, valueArrayClass } from '../store.js';
import { ZarrFormatError, ZarrUnsupportedError } from './errors.js';
import { decodeUtf8 } from './codecs/vlen.js';
import { formatCountOf } from '../../utils/format-units.js';

/**
 * @typedef {Object} StoredType
 * @property {import('../store.js').Dtype} dtype
 * @property {number|null} itemSize
 * @property {'numeric'|'float16'|'bool'|'bytes-string'|'utf32'|'vlen'|'opaque'|'compound'} form
 * @property {boolean} littleEndian - Stored byte order of multi-byte numbers and UTF-32
 * @property {Function} [valueClass] - Typed array class of numeric, float16 and bool values
 * @property {Array<{name: string, offset: number, type: StoredType, shape: number[], count: number}>} [fields]
 * @property {'utf-8'|'bytes'} [vlen]
 * @property {ZarrUnsupportedError} [unsupported] - Why values cannot be read
 */

let float16Table = null;

/** Float32 value of every float16 bit pattern (256 KiB, built on first use). */
export function float16Values() {
  if (float16Table === null) {
    float16Table = new Float32Array(65536);
    for (let bits = 0; bits < 65536; bits++) {
      const sign = bits & 0x8000 ? -1 : 1;
      const exponent = (bits >>> 10) & 0x1f;
      const fraction = bits & 0x3ff;
      let value;
      if (exponent === 0) value = sign * fraction * 2 ** -24;
      else if (exponent === 0x1f) value = fraction === 0 ? sign * Infinity : NaN;
      else value = sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
      float16Table[bits] = value;
    }
  }
  return float16Table;
}

/** The float16 value nearest to `value` (round half to even), as a number. */
function toFloat16(value) {
  if (Number.isNaN(value) || !Number.isFinite(value) || value === 0) return value;
  const magnitude = Math.abs(value);
  if (magnitude >= 65520) return value > 0 ? Infinity : -Infinity;
  const exponent = Math.max(Math.floor(Math.log2(magnitude)), -14);
  const quantum = 2 ** (exponent - 10);
  let steps = magnitude / quantum;
  const floor = Math.floor(steps);
  const rest = steps - floor;
  steps = rest > 0.5 || (rest === 0.5 && floor % 2 === 1) ? floor + 1 : floor;
  return Math.sign(value) * steps * quantum;
}

function numericType(kind, bytes, littleEndian) {
  if (kind === 'float' && bytes === 2) {
    return { dtype: numericDtype('float', 2, littleEndian), itemSize: 2, form: 'float16', littleEndian, valueClass: Float32Array };
  }
  const dtype = numericDtype(kind, bytes, littleEndian);
  return { dtype, itemSize: bytes, form: 'numeric', littleEndian, valueClass: valueArrayClass(dtype) };
}

function boolType() {
  return { dtype: BOOL_DTYPE, itemSize: 1, form: 'bool', littleEndian: true, valueClass: Uint8Array };
}

function bytesStringType(size) {
  return { dtype: stringDtype({ variable: false, encoding: 'ascii', bytes: size }), itemSize: size, form: 'bytes-string', littleEndian: true };
}

function utf32Type(size, littleEndian) {
  return { dtype: stringDtype({ variable: false, encoding: 'utf-8', bytes: size }), itemSize: size, form: 'utf32', littleEndian };
}

function opaqueType(size, complex = false) {
  return { dtype: Object.freeze({ kind: 'opaque', name: 'opaque', bytes: size, littleEndian: null }), itemSize: size, form: 'opaque', littleEndian: true, complex };
}

/** Raw bytes of a complex fill value: a number (real part) or [real, imaginary]. */
function complexFill(json, type, what) {
  const parts = Array.isArray(json) ? json : [json, 0];
  const numbers = parts.map(part => (part === 'NaN' ? NaN : part === 'Infinity' ? Infinity : part === '-Infinity' ? -Infinity : part));
  if (numbers.length !== 2 || !numbers.every(part => typeof part === 'number')) {
    throw new ZarrFormatError(`${what}: the fill_value ${JSON.stringify(json)} is not a complex number.`);
  }
  const raw = new Uint8Array(type.itemSize);
  const data = new DataView(raw.buffer);
  const half = type.itemSize / 2;
  numbers.forEach((part, i) => (half === 4 ? data.setFloat32(i * 4, part, true) : data.setFloat64(i * 8, part, true)));
  return raw;
}

/** A variable-length string type; `vlen` is `'utf-8'` (text) or `'bytes'`. */
export function vlenType(vlen) {
  return {
    dtype: stringDtype({ variable: true, encoding: vlen === 'utf-8' ? 'utf-8' : 'ascii' }),
    itemSize: null,
    form: 'vlen',
    littleEndian: true,
    vlen,
  };
}

function unsupportedType(feature, message) {
  return {
    dtype: Object.freeze({ kind: 'opaque', name: 'opaque', bytes: null, littleEndian: null }),
    itemSize: null,
    form: 'opaque',
    littleEndian: true,
    unsupported: new ZarrUnsupportedError(feature, message),
  };
}

/**
 * An element size in bytes the reader can address (a safe integer), or a
 * format error naming the array and its type.
 */
function elementBytes(bytes, what, type) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new ZarrFormatError(`${what}: the type '${type}' has an element size that is not a whole number of bytes below 2^53.`);
  }
  return bytes;
}

function compoundType(fields, what) {
  let offset = 0;
  const stored = fields.map(({ name, type, shape }) => {
    if (type.itemSize === null || type.unsupported) {
      throw new ZarrUnsupportedError('variable-length field', `${what} has a structured field '${name}' of variable length, which this reader does not read.`);
    }
    const count = elementBytes(shape.reduce((product, extent) => product * extent, 1), what, `field '${name}'`);
    const field = { name, offset, type, shape, count };
    offset = elementBytes(offset + type.itemSize * count, what, 'structured');
    return field;
  });
  const dtype = Object.freeze({
    kind: 'compound',
    name: 'compound',
    bytes: offset,
    littleEndian: null,
    fields: Object.freeze(stored.map(field => Object.freeze({
      name: field.name,
      offset: field.offset,
      dtype: field.type.dtype,
      shape: Object.freeze(field.shape.slice()),
    }))),
  });
  return { dtype, itemSize: offset, form: 'compound', littleEndian: true, fields: stored };
}

const V2_PATTERN = /^([<>|=]?)([a-zA-Z])(\d*)(?:\[(\w+)\])?$/;

/**
 * The stored type of a Zarr v2 `dtype` (a NumPy type string, or a list of
 * fields for a structured type). An object type (`|O`) is variable-length
 * text until its filter says otherwise.
 *
 * @param {unknown} descr
 * @param {string} what - The array, for messages
 * @returns {StoredType}
 */
export function parseV2Dtype(descr, what) {
  if (Array.isArray(descr)) {
    const fields = descr.map(field => {
      if (!Array.isArray(field) || field.length < 2 || field.length > 3 || typeof field[0] !== 'string') {
        throw new ZarrFormatError(`${what}: a structured dtype field must be [name, dtype] or [name, dtype, shape].`);
      }
      const shape = field[2] ?? [];
      if (!Array.isArray(shape) || !shape.every(extent => Number.isSafeInteger(extent) && extent >= 0)) {
        throw new ZarrFormatError(`${what}: the field '${field[0]}' has an invalid shape.`);
      }
      return { name: field[0], type: parseV2Dtype(field[1], what), shape };
    });
    return compoundType(fields, what);
  }
  if (typeof descr !== 'string') throw new ZarrFormatError(`${what}: the dtype ${JSON.stringify(descr)} is not a NumPy type.`);
  const match = V2_PATTERN.exec(descr);
  if (match === null) throw new ZarrFormatError(`${what}: '${descr}' is not a NumPy type.`);
  const [, order, code, digits] = match;
  const littleEndian = order !== '>';
  const size = digits === '' ? null : Number(digits);
  switch (code) {
    case 'b':
      if (size === 1) return boolType();
      break;
    case 'i':
    case 'u':
      if (size === 1 || size === 2 || size === 4 || size === 8) return numericType(code === 'i' ? 'int' : 'uint', size, littleEndian);
      break;
    case 'f':
      if (size === 2 || size === 4 || size === 8) return numericType('float', size, littleEndian);
      break;
    case 'c':
      if (size === 8 || size === 16) return opaqueType(size, true);
      break;
    case 'M':
    case 'm':
      if (size === 8) return numericType('int', 8, littleEndian);
      break;
    case 'S':
      if (size !== null) return bytesStringType(elementBytes(size, what, descr));
      break;
    case 'U':
      if (size !== null) return utf32Type(elementBytes(size * 4, what, descr), littleEndian);
      break;
    case 'V':
      if (size !== null) return opaqueType(elementBytes(size, what, descr));
      break;
    case 'O':
      return vlenType('utf-8');
    default:
      break;
  }
  return unsupportedType(`dtype ${descr}`, `${what} stores elements of NumPy type '${descr}', which this reader does not read.`);
}

const V3_NUMERIC = {
  int8: ['int', 1], int16: ['int', 2], int32: ['int', 4], int64: ['int', 8],
  uint8: ['uint', 1], uint16: ['uint', 2], uint32: ['uint', 4], uint64: ['uint', 8],
  float16: ['float', 2], float32: ['float', 4], float64: ['float', 8],
};

function lengthBytes(configuration, what, name) {
  const bytes = configuration?.length_bytes ?? (configuration?.length_bits !== undefined ? configuration.length_bits / 8 : undefined);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new ZarrFormatError(`${what}: the data type '${name}' needs a whole length in bytes.`);
  }
  return bytes;
}

/**
 * The stored type of a Zarr v3 `data_type`, before its byte order is known
 * (that comes from the `bytes` codec; see `withByteOrder`).
 *
 * @param {unknown} dataType
 * @param {string} what
 * @returns {StoredType}
 */
export function parseV3DataType(dataType, what) {
  let name = dataType;
  let configuration = null;
  if (dataType !== null && typeof dataType === 'object' && !Array.isArray(dataType)) {
    name = dataType.name;
    configuration = dataType.configuration ?? {};
  }
  if (typeof name !== 'string') throw new ZarrFormatError(`${what}: the data_type ${JSON.stringify(dataType)} is not a Zarr data type.`);
  if (name === 'bool') return boolType();
  if (Object.hasOwn(V3_NUMERIC, name)) return numericType(V3_NUMERIC[name][0], V3_NUMERIC[name][1], true);
  if (name === 'complex64') return opaqueType(8, true);
  if (name === 'complex128') return opaqueType(16, true);
  if (name === 'string') return vlenType('utf-8');
  if (name === 'bytes' || name === 'variable_length_bytes') return vlenType('bytes');
  const raw = /^r(\d+)$/.exec(name);
  if (raw !== null && Number(raw[1]) % 8 === 0 && Number(raw[1]) > 0) return opaqueType(elementBytes(Number(raw[1]) / 8, what, name));
  switch (name) {
    case 'fixed_length_utf32': {
      const bytes = lengthBytes(configuration, what, name);
      if (bytes % 4 !== 0) throw new ZarrFormatError(`${what}: a UTF-32 string length must be a multiple of 4 bytes.`);
      return utf32Type(bytes, true);
    }
    case 'null_terminated_bytes':
    case 'fixed_length_ascii':
    case 'fixed_length_bytes':
      return bytesStringType(lengthBytes(configuration, what, name));
    case 'raw_bytes':
      return opaqueType(lengthBytes(configuration, what, name));
    case 'numpy.datetime64':
    case 'numpy.timedelta64':
      return numericType('int', 8, true);
    case 'struct':
    case 'structured': {
      const fields = configuration?.fields;
      if (!Array.isArray(fields)) throw new ZarrFormatError(`${what}: a structured data type needs its fields.`);
      return compoundType(fields.map(field => {
        const [fieldName, fieldType] = Array.isArray(field) ? field : [field?.name, field?.data_type];
        if (typeof fieldName !== 'string') throw new ZarrFormatError(`${what}: a structured field has no name.`);
        return { name: fieldName, type: parseV3DataType(fieldType, what), shape: [] };
      }), what);
    }
    default:
      return unsupportedType(`data type ${name}`, `${what} stores elements of Zarr data type '${name}', which this reader does not read.`);
  }
}

/**
 * The same type stored in another byte order (the Zarr v3 `bytes` codec's
 * `endian`).
 *
 * @param {StoredType} type
 * @param {boolean} littleEndian
 * @returns {StoredType}
 */
export function withByteOrder(type, littleEndian) {
  if (type.form === 'compound') {
    return compoundType(type.fields.map(field => ({
      name: field.name, type: withByteOrder(field.type, littleEndian), shape: field.shape,
    })), 'array');
  }
  if (type.form === 'numeric' || type.form === 'float16') {
    if (type.itemSize === 1) return type;
    return numericType(type.dtype.kind, type.itemSize, littleEndian);
  }
  if (type.form === 'utf32') return utf32Type(type.itemSize, littleEndian);
  return type;
}

/** Whether a stored type needs a byte order (more than one byte per number). */
export function hasByteOrder(type) {
  if (type.form === 'compound') return type.fields.some(field => hasByteOrder(field.type));
  return ((type.form === 'numeric' || type.form === 'float16') && type.itemSize > 1) || type.form === 'utf32';
}

// ---------------------------------------------------------------------------
// Raw element bytes to values.

/** NumPy `S`: strict UTF-8 with trailing NULs trimmed. */
function bytesString(raw, offset, size, what) {
  let end = offset + size;
  while (end > offset && raw[end - 1] === 0) end--;
  return decodeUtf8(raw, offset, end, what);
}

/** NumPy `U`: UTF-32 code points, trailing NULs trimmed. */
function utf32String(raw, offset, size, littleEndian, what) {
  const count = size >>> 2;
  let end = count;
  const point = index => {
    const at = offset + index * 4;
    return littleEndian
      ? (raw[at] | (raw[at + 1] << 8) | (raw[at + 2] << 16) | (raw[at + 3] << 24)) >>> 0
      : ((raw[at] << 24) | (raw[at + 1] << 16) | (raw[at + 2] << 8) | raw[at + 3]) >>> 0;
  };
  while (end > 0 && point(end - 1) === 0) end--;
  let text = '';
  for (let i = 0; i < end; i++) {
    const code = point(i);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      throw new ZarrFormatError(`${what} holds a UTF-32 string with an invalid code point (${code}).`);
    }
    text += String.fromCodePoint(code);
  }
  return text;
}

function numericValue(data, offset, type) {
  const le = type.littleEndian;
  if (type.form === 'bool') return data.getUint8(offset);
  if (type.form === 'float16') return float16Values()[data.getUint16(offset, le)];
  const { kind, bytes } = type.dtype;
  if (kind === 'float') return bytes === 4 ? data.getFloat32(offset, le) : data.getFloat64(offset, le);
  if (kind === 'int') {
    if (bytes === 1) return data.getInt8(offset);
    if (bytes === 2) return data.getInt16(offset, le);
    if (bytes === 4) return data.getInt32(offset, le);
    return data.getBigInt64(offset, le);
  }
  if (bytes === 1) return data.getUint8(offset);
  if (bytes === 2) return data.getUint16(offset, le);
  if (bytes === 4) return data.getUint32(offset, le);
  return data.getBigUint64(offset, le);
}

/**
 * The values of `count` consecutive elements of a fixed-size `type`, read
 * from raw stored bytes at `offset`: a typed array for numbers and booleans,
 * an Array of strings or rows, or the raw bytes of opaque elements.
 *
 * @param {Uint8Array} raw
 * @param {number} offset
 * @param {number} count
 * @param {StoredType} type
 * @param {string} what
 */
export function decodeRaw(raw, offset, count, type, what) {
  const size = type.itemSize;
  switch (type.form) {
    case 'opaque':
      return raw.slice(offset, offset + count * size);
    case 'bytes-string': {
      const values = new Array(count);
      for (let i = 0; i < count; i++) values[i] = bytesString(raw, offset + i * size, size, what);
      return values;
    }
    case 'utf32': {
      const values = new Array(count);
      for (let i = 0; i < count; i++) values[i] = utf32String(raw, offset + i * size, size, type.littleEndian, what);
      return values;
    }
    case 'compound': {
      const values = new Array(count);
      for (let i = 0; i < count; i++) {
        const base = offset + i * size;
        values[i] = type.fields.map(field => {
          const value = decodeRaw(raw, base + field.offset, field.count, field.type, what);
          return field.shape.length === 0 ? (field.type.form === 'opaque' ? value : value[0]) : value;
        });
      }
      return values;
    }
    default: {
      const values = new type.valueClass(count);
      const data = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let i = 0; i < count; i++) {
        const value = numericValue(data, offset + i * size, type);
        if (type.form === 'bool' && value > 1) throw new ZarrFormatError(`${what} holds a boolean byte that is neither 0 nor 1 (${value}).`);
        values[i] = value;
      }
      return values;
    }
  }
}

/**
 * One field of every element of raw compound bytes: `count` elements of
 * `itemSize` bytes, each giving `field.count` values.
 */
export function decodeRawField(raw, count, type, field, what) {
  const perElement = field.count;
  const fieldSize = field.type.itemSize * perElement;
  if (field.type.form === 'opaque') {
    const out = new Uint8Array(count * fieldSize);
    for (let i = 0; i < count; i++) out.set(raw.subarray(i * type.itemSize + field.offset, i * type.itemSize + field.offset + fieldSize), i * fieldSize);
    return out;
  }
  const values = field.type.valueClass ? new field.type.valueClass(count * perElement) : new Array(count * perElement);
  for (let i = 0; i < count; i++) {
    const part = decodeRaw(raw, i * type.itemSize + field.offset, perElement, field.type, what);
    for (let k = 0; k < perElement; k++) values[i * perElement + k] = part[k];
  }
  return values;
}

// ---------------------------------------------------------------------------
// Fill values.

function base64Bytes(text, what) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) {
    throw new ZarrFormatError(`${what}: the fill_value ${JSON.stringify(text)} is not Base64.`);
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function floatFromBits(text, size, what) {
  const hex = text.slice(2);
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== size * 2) {
    throw new ZarrFormatError(`${what}: the fill_value ${text} is not a ${size}-byte float bit pattern.`);
  }
  const bits = BigInt(text);
  if (size === 2) return float16Values()[Number(bits)];
  const data = new DataView(new ArrayBuffer(8));
  if (size === 4) {
    data.setUint32(0, Number(bits));
    return data.getFloat32(0);
  }
  data.setBigUint64(0, bits);
  return data.getFloat64(0);
}

function numericFill(json, type, what) {
  const { kind, bytes, name } = type.dtype;
  const invalid = () => new ZarrFormatError(`${what}: the fill_value ${JSON.stringify(typeof json === 'bigint' ? String(json) : json)} is not a valid ${name}.`);
  if (type.form === 'bool') {
    if (json === true || json === 1) return 1;
    if (json === false || json === 0) return 0;
    throw invalid();
  }
  if (kind === 'float') {
    let value;
    if (json === 'NaN') value = NaN;
    else if (json === 'Infinity') value = Infinity;
    else if (json === '-Infinity') value = -Infinity;
    else if (typeof json === 'string' && /^0x/i.test(json)) return floatFromBits(json, bytes, what);
    else if (typeof json === 'number') value = json;
    else if (typeof json === 'bigint') value = Number(json);
    else throw invalid();
    if (bytes === 2) {
      const narrowed = toFloat16(value);
      if (Number.isFinite(value) && !Number.isFinite(narrowed)) throw new ZarrFormatError(`${what}: the fill_value ${value} is outside the float16 range.`);
      return narrowed;
    }
    if (bytes === 4) {
      const narrowed = Math.fround(value);
      if (Number.isFinite(value) && !Number.isFinite(narrowed)) throw new ZarrFormatError(`${what}: the fill_value ${value} is outside the float32 range.`);
      return narrowed;
    }
    return value;
  }
  let value;
  if (typeof json === 'bigint') value = json;
  else if (typeof json === 'number' && Number.isSafeInteger(json)) value = BigInt(json);
  else if (typeof json === 'boolean') value = BigInt(json ? 1 : 0);
  else throw invalid();
  const bits = BigInt(bytes * 8);
  const min = kind === 'uint' ? 0n : -(1n << (bits - 1n));
  const max = kind === 'uint' ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n;
  if (value < min || value > max) throw new ZarrFormatError(`${what}: the fill_value ${value} is outside the range of ${name}.`);
  return bytes === 8 ? value : Number(value);
}

/** The raw bytes of one element of `type` holding `value` (fixed-size types). */
function encodeElement(value, type, what) {
  const out = new Uint8Array(type.itemSize);
  const data = new DataView(out.buffer);
  const le = type.littleEndian;
  switch (type.form) {
    case 'bool':
      out[0] = numericFill(value, type, what);
      return out;
    case 'float16': {
      const target = numericFill(value, type, what);
      const table = float16Values();
      let bits = 0;
      if (Number.isNaN(target)) bits = 0x7e00;
      else for (let b = 0; b < 65536; b++) if (Object.is(table[b], target)) { bits = b; break; }
      data.setUint16(0, bits, le);
      return out;
    }
    case 'numeric': {
      const fill = numericFill(value, type, what);
      const { kind, bytes } = type.dtype;
      if (kind === 'float') bytes === 4 ? data.setFloat32(0, fill, le) : data.setFloat64(0, fill, le);
      else if (bytes === 8) kind === 'int' ? data.setBigInt64(0, fill, le) : data.setBigUint64(0, fill, le);
      else if (bytes === 1) out[0] = fill & 0xff;
      else if (bytes === 2) data.setUint16(0, fill & 0xffff, le);
      else data.setUint32(0, fill >>> 0, le);
      return out;
    }
    case 'bytes-string':
      if (typeof value !== 'string') break;
      out.set(new TextEncoder().encode(value).subarray(0, type.itemSize));
      return out;
    case 'utf32': {
      if (typeof value !== 'string') break;
      let at = 0;
      for (const char of value) {
        if (at + 4 > out.length) break;
        data.setUint32(at, char.codePointAt(0), le);
        at += 4;
      }
      return out;
    }
    case 'compound':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) break;
      for (const field of type.fields) {
        if (Object.hasOwn(value, field.name) && field.count === 1) out.set(encodeElement(value[field.name], field.type, what), field.offset);
      }
      return out;
    default:
      break;
  }
  throw new ZarrFormatError(`${what}: the fill_value ${JSON.stringify(value)} does not fit the array's type.`);
}

/**
 * Decode a fill value.
 *
 * @param {unknown} json - `fill_value` as stored
 * @param {StoredType} type
 * @param {2|3} version
 * @param {string} what
 * @returns {{value: unknown, raw: Uint8Array|null}} The value as reads return
 *   it (null: undefined contents), and for raw-assembled types its bytes
 */
export function decodeFill(json, type, version, what) {
  if (json === null) {
    if (version === 3) throw new ZarrFormatError(`${what}: a Zarr v3 array needs a fill_value.`);
    return { value: null, raw: null };
  }
  if (type.unsupported) return { value: null, raw: null };
  switch (type.form) {
    case 'numeric':
    case 'float16':
    case 'bool':
      return { value: numericFill(json, type, what), raw: null };
    case 'vlen':
      if (json === 0 || json === '') return { value: '', raw: null };
      if (typeof json === 'string') return { value: json, raw: null };
      throw new ZarrFormatError(`${what}: the fill_value ${JSON.stringify(json)} is not a string.`);
    default:
      break;
  }
  let raw;
  if (type.complex && (typeof json === 'number' || Array.isArray(json))) {
    raw = complexFill(json, type, what);
  } else if (type.form === 'utf32' && typeof json === 'string') {
    raw = encodeElement(json, type, what);
  } else if (typeof json === 'string') {
    // Fixed bytes, raw bytes and structured fills are Base64 in both versions.
    const bytes = base64Bytes(json, what);
    if (bytes.length > type.itemSize) throw new ZarrFormatError(`${what}: the fill_value holds more bytes than one element.`);
    raw = new Uint8Array(type.itemSize);
    raw.set(bytes);
  } else if (Array.isArray(json) && type.form === 'opaque') {
    if (json.length !== type.itemSize || !json.every(byte => Number.isInteger(byte) && byte >= 0 && byte < 256)) {
      throw new ZarrFormatError(`${what}: the fill_value must list ${formatCountOf(type.itemSize, 'byte')}.`);
    }
    raw = Uint8Array.from(json);
  } else {
    raw = encodeElement(json, type, what);
  }
  const decoded = decodeRaw(raw, 0, 1, type, what);
  return { value: type.form === 'opaque' ? decoded : decoded[0], raw };
}
