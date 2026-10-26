/**
 * The HDF5 datatype message, and its element type in the array store.
 *
 * `parseDatatype` reads a datatype message (any version, any class, nested
 * types included) into a plain description of how one element is stored.
 * `storeDtype` maps that description to the store's `Dtype` (see
 * formats/store.js):
 *
 * - integers and IEEE floats of 1, 2, 4 and 8 bytes, either byte order;
 * - strings, fixed or variable length, ASCII or UTF-8;
 * - compounds (array members keep their shape), enums (HDF5's
 *   `FALSE = 0, TRUE = 1` enum, as h5py writes NumPy booleans, is `bool`);
 * - bitfields read as unsigned integers of the same size;
 * - an array datatype at the top level reads as its base type, with the
 *   array's shape in `dtype.arrayShape` (each element holds that many
 *   values, in row-major order);
 * - variable-length sequences read as one array of values per element;
 * - every other class (time, references, complex numbers, non-IEEE floats,
 *   integers with padding bits) reads as `opaque`: the raw element bytes.
 *
 * @module formats/hdf5/datatype
 */

import { Hdf5UnsupportedError } from './errors.js';
import { limitEncodedSize } from './binary.js';
import { BOOL_DTYPE, numericDtype, stringDtype } from '../store.js';
import { formatCountOf } from '../../utils/format-units.js';

export const DATATYPE_CLASSES = Object.freeze([
  'fixed-point', 'floating-point', 'time', 'string', 'bitfield', 'opaque',
  'compound', 'reference', 'enum', 'variable-length', 'array', 'complex',
]);

/**
 * @typedef {Object} Hdf5Type
 * @property {string} class - One of DATATYPE_CLASSES
 * @property {number} size - Bytes per element
 * @property {number} version
 * @property {boolean} [littleEndian]
 * @property {boolean} [signed]
 * @property {'utf-8'|'ascii'} [encoding]
 * @property {Array<{name: string, offset: number, type: Hdf5Type, shape: number[]}>} [members]
 * @property {Hdf5Type} [base]
 * @property {string[]} [names]
 * @property {Array<number|bigint>} [values]
 * @property {number[]} [dims]
 * @property {'string'|'sequence'} [variable]
 * @property {string} [tag]
 * @property {string|null} [opaqueReason] - Why the type reads as opaque bytes
 */

/**
 * Parse one datatype message at the cursor's position; leaves the cursor
 * after it.
 *
 * @param {import('./binary.js').Cursor} cursor
 * @returns {Hdf5Type}
 */
export function parseDatatype(cursor) {
  const classAndVersion = cursor.u8();
  const version = classAndVersion >> 4;
  const classId = classAndVersion & 0x0f;
  const bits = cursor.u8() | (cursor.u8() << 8) | (cursor.u8() << 16);
  const size = cursor.u32();
  if (version < 1 || version > 5) throw cursor.error(`datatype message version ${version} is unknown`);
  const className = DATATYPE_CLASSES[classId];
  if (className === undefined) throw cursor.error(`datatype class ${classId} is unknown`);
  const type = { class: className, size, version };

  switch (className) {
    case 'fixed-point':
    case 'bitfield': {
      type.littleEndian = (bits & 1) === 0;
      type.signed = className === 'fixed-point' && (bits & 0x08) !== 0;
      type.bitOffset = cursor.u16();
      type.precision = cursor.u16();
      break;
    }
    case 'floating-point': {
      const order = (bits & 1) | ((bits >> 5) & 2);
      type.littleEndian = order === 0;
      type.vax = order === 3;
      type.bitOffset = cursor.u16();
      type.precision = cursor.u16();
      type.exponentLocation = cursor.u8();
      type.exponentSize = cursor.u8();
      type.mantissaLocation = cursor.u8();
      type.mantissaSize = cursor.u8();
      type.exponentBias = cursor.u32();
      type.signLocation = (bits >> 8) & 0xff;
      type.normalization = (bits >> 4) & 3;
      break;
    }
    case 'time': {
      type.littleEndian = (bits & 1) === 0;
      type.precision = cursor.u16();
      break;
    }
    case 'string': {
      type.padding = bits & 0x0f;
      type.encoding = ((bits >> 4) & 0x0f) === 1 ? 'utf-8' : 'ascii';
      break;
    }
    case 'opaque': {
      const tagLength = bits & 0xff;
      const tagBytes = cursor.take(tagLength);
      let end = 0;
      while (end < tagBytes.length && tagBytes[end] !== 0) end++;
      type.tag = String.fromCharCode(...tagBytes.subarray(0, end));
      break;
    }
    case 'compound': {
      const count = bits & 0xffff;
      type.members = [];
      for (let i = 0; i < count; i++) {
        const name = cursor.cstring({ padTo: version < 3 ? 8 : 1 });
        const offset = version < 3 ? cursor.u32() : cursor.uint(limitEncodedSize(size));
        let shape = [];
        if (version === 1) {
          const rank = cursor.u8();
          cursor.skip(3 + 4 + 4);
          const dims = [cursor.u32(), cursor.u32(), cursor.u32(), cursor.u32()];
          if (rank > 4) throw cursor.error(`compound member '${name}' has ${rank} array dimensions; at most 4 are allowed`);
          shape = dims.slice(0, rank);
        }
        let memberType = parseDatatype(cursor);
        // An array-typed member is its base type with the array's shape.
        if (memberType.class === 'array') {
          shape = shape.concat(memberType.dims);
          memberType = memberType.base;
        }
        const width = memberType.size * shape.reduce((a, b) => a * b, 1);
        if (offset + width > size) {
          throw cursor.error(`compound member '${name}' (${formatCountOf(width, 'byte')} at ${offset}) does not fit the ${size}-byte element`);
        }
        type.members.push({ name, offset, type: memberType, shape });
      }
      break;
    }
    case 'reference': {
      type.referenceType = bits & 0x0f;
      break;
    }
    case 'enum': {
      const count = bits & 0xffff;
      type.base = parseDatatype(cursor);
      type.names = [];
      for (let i = 0; i < count; i++) type.names.push(cursor.cstring({ padTo: version < 3 ? 8 : 1 }));
      const valueBytes = cursor.take(count * type.base.size);
      type.values = [];
      for (let i = 0; i < count; i++) {
        type.values.push(readScalarInteger(valueBytes, i * type.base.size, type.base));
      }
      break;
    }
    case 'variable-length': {
      const kind = bits & 0x0f;
      type.variable = kind === 1 ? 'string' : 'sequence';
      if (kind > 1) throw cursor.error(`variable-length type ${kind} is unknown`);
      type.padding = (bits >> 4) & 0x0f;
      type.encoding = ((bits >> 8) & 0x0f) === 1 ? 'utf-8' : 'ascii';
      type.base = parseDatatype(cursor);
      break;
    }
    case 'array': {
      const rank = cursor.u8();
      if (version < 3) cursor.skip(3);
      type.dims = [];
      for (let i = 0; i < rank; i++) type.dims.push(cursor.u32());
      if (version < 3) cursor.skip(4 * rank);
      type.base = parseDatatype(cursor);
      break;
    }
    case 'complex': {
      type.base = parseDatatype(cursor);
      break;
    }
    default:
      break;
  }
  return type;
}

/** An enum member's value (a number, or a BigInt beyond the safe range). */
function readScalarInteger(bytes, offset, type) {
  if (type.class !== 'fixed-point' && type.class !== 'bitfield') return null;
  const size = type.size;
  let value = 0n;
  for (let i = 0; i < size; i++) {
    const byte = bytes[offset + (type.littleEndian ? i : size - 1 - i)];
    value |= BigInt(byte) << BigInt(8 * i);
  }
  if (type.signed && size > 0 && (value >> BigInt(8 * size - 1)) & 1n) value -= 1n << BigInt(8 * size);
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

const IEEE_LAYOUTS = Object.freeze({
  2: { exponentSize: 5, mantissaSize: 10, exponentLocation: 10, signLocation: 15, bias: 15 },
  4: { exponentSize: 8, mantissaSize: 23, exponentLocation: 23, signLocation: 31, bias: 127 },
  8: { exponentSize: 11, mantissaSize: 52, exponentLocation: 52, signLocation: 63, bias: 1023 },
});

/**
 * Why a numeric type cannot be read as a plain typed-array value, or null.
 *
 * @param {Hdf5Type} type
 */
function numericProblem(type) {
  if (type.class === 'floating-point') {
    const layout = IEEE_LAYOUTS[type.size];
    if (type.vax) return 'it is stored in VAX byte order';
    if (layout === undefined || type.bitOffset !== 0 || type.precision !== type.size * 8 ||
        type.exponentSize !== layout.exponentSize || type.mantissaSize !== layout.mantissaSize ||
        type.exponentLocation !== layout.exponentLocation || type.mantissaLocation !== 0 ||
        type.signLocation !== layout.signLocation || type.exponentBias !== layout.bias) {
      return `it is a ${type.size * 8}-bit floating-point format other than IEEE half, single or double precision`;
    }
    return null;
  }
  if (![1, 2, 4, 8].includes(type.size)) return `it is a ${type.size}-byte integer`;
  if (type.bitOffset !== 0 || type.precision !== type.size * 8) {
    return `its ${type.precision}-bit integers are padded within ${formatCountOf(type.size, 'byte')}`;
  }
  return null;
}

/** An opaque store dtype for a type the store has no value for. */
function opaqueDtype(type, reason) {
  return Object.freeze({
    kind: 'opaque',
    name: 'opaque',
    bytes: type.size,
    littleEndian: null,
    reason,
  });
}

const typeDtypes = new WeakMap();

/**
 * The store `Dtype` of an HDF5 type.
 *
 * @param {Hdf5Type} type
 * @returns {import('../store.js').Dtype}
 */
export function storeDtype(type) {
  let dtype = typeDtypes.get(type);
  if (dtype === undefined) {
    dtype = buildDtype(type);
    typeDtypes.set(type, dtype);
  }
  return dtype;
}

function buildDtype(type) {
  switch (type.class) {
    case 'fixed-point':
    case 'bitfield': {
      const problem = numericProblem(type);
      if (problem !== null) return opaqueDtype(type, problem);
      return numericDtype(type.signed ? 'int' : 'uint', type.size, type.littleEndian);
    }
    case 'floating-point': {
      const problem = numericProblem(type);
      if (problem !== null) return opaqueDtype(type, problem);
      return numericDtype('float', type.size, type.littleEndian);
    }
    case 'string':
      return stringDtype({ variable: false, encoding: type.encoding, bytes: type.size });
    case 'variable-length': {
      if (type.variable === 'string') return stringDtype({ variable: true, encoding: type.encoding });
      if (containsVariableLength(type.base)) {
        return opaqueDtype(type, 'it is a variable-length sequence of variable-length values');
      }
      // A sequence: each element reads as an array of values of the base type.
      return Object.freeze({
        kind: 'opaque',
        name: 'opaque',
        bytes: type.size,
        littleEndian: null,
        sequence: storeDtype(type.base),
      });
    }
    case 'compound': {
      const fields = type.members.map(member => Object.freeze({
        name: member.name,
        offset: member.offset,
        dtype: storeDtype(member.type),
        shape: Object.freeze(member.shape.slice()),
      }));
      return Object.freeze({
        kind: 'compound',
        name: 'compound',
        bytes: type.size,
        littleEndian: null,
        fields: Object.freeze(fields),
      });
    }
    case 'enum': {
      const base = storeDtype(type.base);
      if (base.kind !== 'int' && base.kind !== 'uint') return opaqueDtype(type, 'its enum base type is not an integer');
      if (isBooleanEnum(type)) {
        return type.size === 1
          ? BOOL_DTYPE
          : Object.freeze({ kind: 'bool', name: 'bool', bytes: type.size, littleEndian: base.littleEndian, base });
      }
      const members = {};
      type.names.forEach((name, index) => {
        members[name] = type.values[index];
      });
      return Object.freeze({
        kind: 'enum',
        name: 'enum',
        bytes: type.size,
        littleEndian: base.littleEndian,
        base,
        members: Object.freeze(members),
      });
    }
    case 'array': {
      const base = storeDtype(type.base);
      if (base.kind === 'compound' || base.kind === 'opaque' || base.sequence !== undefined) {
        return opaqueDtype(type, 'it is an array of compound or opaque values');
      }
      return Object.freeze({ ...base, arrayShape: Object.freeze(type.dims.slice()) });
    }
    case 'time':
      return opaqueDtype(type, 'it is an HDF5 time type');
    case 'reference':
      return opaqueDtype(type, 'it holds object references');
    case 'complex':
      return opaqueDtype(type, 'it holds complex numbers');
    case 'opaque':
      return Object.freeze({ kind: 'opaque', name: 'opaque', bytes: type.size, littleEndian: null, tag: type.tag });
    default:
      return opaqueDtype(type, `it is of HDF5 class ${type.class}`);
  }
}

/** HDF5's FALSE = 0, TRUE = 1 enum, which h5py writes for NumPy booleans. */
export function isBooleanEnum(type) {
  return type.class === 'enum' && type.names.length === 2 &&
    type.values[type.names.indexOf('FALSE')] === 0 && type.values[type.names.indexOf('TRUE')] === 1;
}

/** Whether values of `type` reference the global heap anywhere inside. */
export function containsVariableLength(type) {
  switch (type.class) {
    case 'variable-length': return true;
    case 'compound': return type.members.some(member => containsVariableLength(member.type));
    case 'array':
    case 'enum': return containsVariableLength(type.base);
    default: return false;
  }
}

/** Fail with a plain message when values of `type` cannot be decoded at all. */
export function requireDecodable(type, what) {
  if (type.class === 'variable-length' && type.variable === 'sequence' && containsVariableLength(type.base)) {
    throw new Hdf5UnsupportedError(
      'nested-variable-length',
      `${what} holds variable-length sequences of variable-length values, which this reader does not read.`
    );
  }
}
