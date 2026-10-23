/**
 * @fileoverview Typed JSON: a JSON value whose leaves may also be typed
 * numeric arrays, stored compactly.
 *
 * Analysis settings are JSON; analysis results are mostly long numeric
 * columns (a statistic per gene). Written as JSON text a float takes about
 * twenty characters; here it takes its four or eight bytes.
 *
 * Layout:
 *
 *   u32 LE jsonByteLength
 *   UTF-8 JSON, where the k-th typed array met in depth-first key order is
 *   replaced by the object {"$typed": k}
 *   then, for each array k in order:
 *     u8 dtype (1 Uint8, 2 Uint16, 3 Uint32, 4 Int32, 5 Float32, 6 Float64)
 *     uvarint element count
 *     the elements, little-endian
 *
 * An object of the value itself may not have a "$typed" key; the writer
 * refuses one rather than produce an ambiguous file.
 *
 * @module session/codecs/typed-json
 */

import { decodeUvarint, uvarintLength, writeUvarint } from './varint.js';

const TYPED_KEY = '$typed';
const DTYPES = Object.freeze([
  null,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array
]);

if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
  throw new Error('Typed JSON requires a little-endian platform.');
}

function dtypeOf(value) {
  for (let code = 1; code < DTYPES.length; code++) {
    if (value instanceof DTYPES[code]) return code;
  }
  return 0;
}

/**
 * Set an own data property. A plain assignment of "__proto__" would replace
 * the object's prototype; a session file is untrusted input.
 */
function defineOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * @param {unknown} value - JSON values and typed numeric arrays.
 * @returns {Uint8Array}
 */
export function encodeTypedJson(value) {
  const arrays = [];
  const ancestors = new Set();
  function replace(node, path) {
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return node;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new TypeError(`${path} must be a finite number.`);
      return node;
    }
    if (ArrayBuffer.isView(node)) {
      if (dtypeOf(node) === 0) throw new TypeError(`${path} is a typed array of an unsupported type.`);
      arrays.push(node);
      return { [TYPED_KEY]: arrays.length - 1 };
    }
    if (typeof node !== 'object') throw new TypeError(`${path} must be a JSON value or a typed array.`);
    if (ancestors.has(node)) throw new TypeError(`${path} must not contain cyclic references.`);
    ancestors.add(node);
    let out;
    if (Array.isArray(node)) {
      out = node.map((item, index) => replace(item, `${path}[${index}]`));
    } else {
      if (!isPlainRecord(node)) throw new TypeError(`${path} must be a plain object.`);
      if (Object.hasOwn(node, TYPED_KEY)) {
        throw new TypeError(`${path} must not use the reserved key "${TYPED_KEY}".`);
      }
      out = {};
      for (const [key, child] of Object.entries(node)) defineOwn(out, key, replace(child, `${path}.${key}`));
    }
    ancestors.delete(node);
    return out;
  }
  const json = new TextEncoder().encode(JSON.stringify(replace(value, 'Typed JSON value')));
  let length = 4 + json.byteLength;
  for (const array of arrays) length += 1 + uvarintLength(array.length) + array.byteLength;
  const out = new Uint8Array(length);
  new DataView(out.buffer).setUint32(0, json.byteLength, true);
  out.set(json, 4);
  let offset = 4 + json.byteLength;
  for (const array of arrays) {
    out[offset++] = dtypeOf(array);
    offset = writeUvarint(out, offset, array.length);
    out.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offset);
    offset += array.byteLength;
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {unknown}
 */
export function decodeTypedJson(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4) {
    throw new TypeError('Typed JSON must be a Uint8Array of at least 4 bytes.');
  }
  const jsonLength = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  if (4 + jsonLength > bytes.byteLength) throw new Error('Typed JSON is truncated.');
  const json = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + jsonLength))
  );
  const arrays = [];
  let offset = 4 + jsonLength;
  while (offset < bytes.byteLength) {
    const code = bytes[offset++];
    const ArrayType = DTYPES[code] ?? null;
    if (ArrayType === null) throw new TypeError(`Typed JSON dtype ${code} is not one this version reads.`);
    const { value: count, nextOffset } = decodeUvarint(bytes, offset);
    const byteLength = count * ArrayType.BYTES_PER_ELEMENT;
    if (nextOffset + byteLength > bytes.byteLength) throw new Error('Typed JSON array is truncated.');
    const array = new ArrayType(count);
    new Uint8Array(array.buffer).set(bytes.subarray(nextOffset, nextOffset + byteLength));
    arrays.push(array);
    offset = nextOffset + byteLength;
  }
  const used = new Set();
  function restore(node, path) {
    if (node === null || typeof node !== 'object') {
      if (typeof node === 'number' && !Number.isFinite(node)) {
        throw new TypeError(`${path} must be a finite number.`);
      }
      return node;
    }
    if (Array.isArray(node)) return node.map((item, index) => restore(item, `${path}[${index}]`));
    if (Object.hasOwn(node, TYPED_KEY)) {
      const k = node[TYPED_KEY];
      if (Object.keys(node).length !== 1 || !Number.isSafeInteger(k) || k < 0 || k >= arrays.length || used.has(k)) {
        throw new TypeError(`${path} names a typed array the payload does not hold.`);
      }
      used.add(k);
      return arrays[k];
    }
    const out = {};
    for (const [key, child] of Object.entries(node)) defineOwn(out, key, restore(child, `${path}.${key}`));
    return out;
  }
  const value = restore(json, 'Typed JSON value');
  if (used.size !== arrays.length) throw new Error('Typed JSON holds arrays its value does not name.');
  return value;
}
