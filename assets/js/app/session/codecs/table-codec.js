/**
 * @fileoverview Simple columnar table codec for analysis cache artifacts.
 *
 * The session bundle avoids heavyweight deps (Arrow/Parquet). This codec stores:
 * - a small JSON header describing columns + byte lengths
 * - a binary payload containing columnar data blocks
 *
 * Supported column encodings (dev-phase):
 * - numeric typed arrays (little-endian)
 * - boolean bitset
 * - string dictionary + Uint32 codes
 *
 * @module session/codecs/table-codec
 */

import { bytesToU32LE, u32ToBytesLE } from '../bundle/format.js';
import { decodeUvarint, pushUvarint } from './varint.js';

/**
 * @typedef {'uint8'|'uint16'|'uint32'|'int32'|'float32'|'float64'|'bool'|'string'} TableDType
 *
 * @typedef {object} TableColumn
 * @property {string} name
 * @property {TableDType} dtype
 * @property {ArrayLike<any>|TypedArray} data
 *
 * @typedef {object} Table
 * @property {number} rowCount
 * @property {TableColumn[]} columns
 */

/**
 * @param {unknown} value
 * @returns {value is Uint8Array|Uint16Array|Uint32Array|Int32Array|Float32Array|Float64Array}
 */
function isSupportedTypedArray(value) {
  return value instanceof Uint8Array
    || value instanceof Uint16Array
    || value instanceof Uint32Array
    || value instanceof Int32Array
    || value instanceof Float32Array
    || value instanceof Float64Array;
}

/**
 * @param {TableDType} dtype
 * @returns {number}
 */
function bytesPerElement(dtype) {
  switch (dtype) {
    case 'uint8': return 1;
    case 'uint16': return 2;
    case 'uint32': return 4;
    case 'int32': return 4;
    case 'float32': return 4;
    case 'float64': return 8;
    default: return 0;
  }
}

/**
 * @param {TableDType} dtype
 * @returns {any}
 */
function typedArrayCtor(dtype) {
  switch (dtype) {
    case 'uint8': return Uint8Array;
    case 'uint16': return Uint16Array;
    case 'uint32': return Uint32Array;
    case 'int32': return Int32Array;
    case 'float32': return Float32Array;
    case 'float64': return Float64Array;
    default: return null;
  }
}

/**
 * Encode a JS string to UTF-8 bytes.
 * @param {string} s
 * @returns {Uint8Array}
 */
function utf8(s) {
  return new TextEncoder().encode(String(s));
}

/**
 * @param {Uint8Array[]} chunks
 * @returns {Uint8Array}
 */
function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Encode a column as binary bytes + metadata.
 * @param {TableColumn} col
 * @param {number} rowCount
 * @returns {{ meta: any, bytes: Uint8Array }}
 */
function encodeColumn(col, rowCount) {
  const name = String(col?.name || '').trim();
  const dtype = /** @type {TableDType} */ (col?.dtype);
  const data = col?.data;
  if (!name) throw new Error('encodeTable: column name is required.');

  if (dtype === 'bool') {
    // Bitset: 1 bit per row, LSB first.
    const byteLen = Math.ceil(rowCount / 8);
    const out = new Uint8Array(byteLen);
    for (let i = 0; i < rowCount; i++) {
      const v = Boolean(data?.[i]);
      if (!v) continue;
      out[(i / 8) | 0] |= (1 << (i & 7));
    }
    return { meta: { name, dtype, encoding: 'bitset', byteLength: out.byteLength }, bytes: out };
  }

  if (dtype === 'string') {
    // Dictionary encoding: [dictCount uvarint][(len uvarint, bytes)...][codes Uint32Array]
    /** @type {Map<string, number>} */
    const dictIndex = new Map();
    /** @type {string[]} */
    const dict = [];
    const codes = new Uint32Array(rowCount);

    for (let i = 0; i < rowCount; i++) {
      const s = String(data?.[i] ?? '');
      let idx = dictIndex.get(s);
      if (idx == null) {
        idx = dict.length;
        dictIndex.set(s, idx);
        dict.push(s);
      }
      codes[i] = idx;
    }

    /** @type {number[]} */
    const bytes = [];
    pushUvarint(dict.length, bytes);
    for (const entry of dict) {
      const b = utf8(entry);
      pushUvarint(b.byteLength, bytes);
      for (let i = 0; i < b.byteLength; i++) bytes.push(b[i]);
    }

    const dictBytes = new Uint8Array(bytes);
    const codeBytes = new Uint8Array(codes.buffer, codes.byteOffset, codes.byteLength);
    const out = concatBytes([dictBytes, codeBytes]);

    return {
      meta: {
        name,
        dtype,
        encoding: 'dict',
        byteLength: out.byteLength,
        dictCount: dict.length
      },
      bytes: out
    };
  }

  // Numeric columns: raw typed arrays.
  const bpe = bytesPerElement(dtype);
  const Ctor = typedArrayCtor(dtype);
  if (!Ctor || !bpe) {
    throw new Error(`encodeTable: unsupported dtype "${dtype}" for column "${name}".`);
  }

  let arr = data;
  if (!isSupportedTypedArray(arr)) {
    // Convert array-like to a typed array (best-effort).
    const tmp = new Ctor(rowCount);
    for (let i = 0; i < rowCount; i++) tmp[i] = Number(arr?.[i] ?? 0);
    arr = tmp;
  }

  if (arr.length !== rowCount) {
    throw new Error(`encodeTable: column "${name}" length mismatch (${arr.length} != ${rowCount}).`);
  }

  const out = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  return { meta: { name, dtype, encoding: 'raw', byteLength: out.byteLength }, bytes: out };
}

/**
 * Encode a table into bytes (meta header + column payloads).
 * @param {Table} table
 * @returns {Uint8Array}
 */
export function encodeTable(table) {
  const rowCount = Number(table?.rowCount ?? 0);
  if (!Number.isFinite(rowCount) || rowCount < 0) throw new Error('encodeTable: invalid rowCount.');

  const cols = Array.isArray(table?.columns) ? table.columns : [];
  if (!cols.length) throw new Error('encodeTable: columns are required.');

  /** @type {any[]} */
  const columnMeta = [];
  /** @type {Uint8Array[]} */
  const payloads = [];

  for (const col of cols) {
    const { meta, bytes } = encodeColumn(col, rowCount);
    columnMeta.push(meta);
    payloads.push(bytes);
  }

  const metaObj = { rowCount, columns: columnMeta };
  const metaBytes = utf8(JSON.stringify(metaObj));

  return concatBytes([
    u32ToBytesLE(metaBytes.byteLength),
    metaBytes,
    ...payloads
  ]);
}

/**
 * Decode a table from bytes produced by encodeTable().
 * @param {Uint8Array} bytes
 * @returns {{ rowCount: number, columns: Record<string, any>, meta: any }}
 */
export function decodeTable(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4) {
    throw new Error('decodeTable: invalid payload.');
  }

  const metaLen = bytesToU32LE(bytes.subarray(0, 4));
  const metaStart = 4;
  const metaEnd = metaStart + metaLen;
  if (metaEnd > bytes.byteLength) throw new Error('decodeTable: truncated meta header.');

  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(metaStart, metaEnd)));
  const rowCount = Number(meta?.rowCount ?? 0);
  const cols = Array.isArray(meta?.columns) ? meta.columns : [];
  if (!Number.isFinite(rowCount) || rowCount < 0) throw new Error('decodeTable: invalid rowCount.');

  let offset = metaEnd;
  /** @type {Record<string, any>} */
  const out = {};

  for (const col of cols) {
    const name = String(col?.name || '').trim();
    const dtype = /** @type {TableDType} */ (col?.dtype);
    const encoding = String(col?.encoding || 'raw');
    const byteLength = Number(col?.byteLength ?? 0);
    if (!name) throw new Error('decodeTable: column name missing.');
    if (!Number.isFinite(byteLength) || byteLength < 0) throw new Error(`decodeTable: invalid byteLength for "${name}".`);
    if (offset + byteLength > bytes.byteLength) throw new Error(`decodeTable: truncated column "${name}".`);

    const payload = bytes.subarray(offset, offset + byteLength);
    offset += byteLength;

    if (dtype === 'bool' && encoding === 'bitset') {
      const arr = new Uint8Array(rowCount);
      for (let i = 0; i < rowCount; i++) {
        const b = payload[(i / 8) | 0];
        arr[i] = (b >> (i & 7)) & 1;
      }
      out[name] = arr;
      continue;
    }

    if (dtype === 'string' && encoding === 'dict') {
      // Parse dictionary section.
      let p = 0;
      const dictCountRes = decodeUvarint(payload, p);
      const dictCount = dictCountRes.value >>> 0;
      p = dictCountRes.nextOffset;

      /** @type {string[]} */
      const dict = new Array(dictCount);
      for (let i = 0; i < dictCount; i++) {
        const lenRes = decodeUvarint(payload, p);
        const byteLen = lenRes.value >>> 0;
        p = lenRes.nextOffset;
        const strEnd = p + byteLen;
        if (strEnd > payload.byteLength) throw new Error('decodeTable: truncated string dict.');
        dict[i] = new TextDecoder().decode(payload.subarray(p, strEnd));
        p = strEnd;
      }

      // Remaining bytes are Uint32 codes.
      const codesBytes = payload.subarray(p);
      if (codesBytes.byteLength !== rowCount * 4) {
        throw new Error('decodeTable: string codes length mismatch.');
      }
      const codes = new Uint32Array(codesBytes.slice().buffer);
      const values = new Array(rowCount);
      for (let i = 0; i < rowCount; i++) values[i] = dict[codes[i]] ?? '';
      out[name] = values;
      continue;
    }

    if (encoding === 'raw') {
      const Ctor = typedArrayCtor(dtype);
      if (!Ctor) throw new Error(`decodeTable: unsupported dtype "${dtype}" for "${name}".`);
      // Copy into a tight buffer to avoid alignment/offset issues.
      const buf = payload.slice().buffer;
      const arr = new Ctor(buf);
      out[name] = arr;
      continue;
    }

    throw new Error(`decodeTable: unsupported column encoding "${encoding}" for "${name}".`);
  }

  return { rowCount, columns: out, meta };
}

