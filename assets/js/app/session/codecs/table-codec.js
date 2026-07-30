/**
 * @fileoverview Simple columnar table codec for analysis cache artifacts.
 *
 * The session bundle avoids heavyweight deps (Arrow/Parquet). This codec stores:
 * - a small JSON header describing columns + byte lengths
 * - a binary payload containing columnar data blocks
 *
 * Supported current column encodings:
 * - numeric typed arrays (little-endian)
 * - boolean bitset
 * - string dictionary + Uint32 codes
 *
 * @module session/codecs/table-codec
 */

import { bytesToU32LE, u32ToBytesLE } from '../bundle/format.js';
import { decodeUvarint, pushUvarint } from './varint.js';
import { setOwnDataProperty } from '../../../utils/exact-record.js';
import {
  assertArray,
  assertExactKeys,
  assertNonEmptyString,
  assertPlainRecord,
  assertSafeInteger
} from '../schema-contract.js';

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
  if (typeof s !== 'string') {
    throw new TypeError('Table string values must be strings.');
  }
  return new TextEncoder().encode(s);
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

function encodeNumericLittleEndian(dtype, data) {
  const Ctor = typedArrayCtor(dtype);
  if (Ctor === null) {
    throw new TypeError(`Table dtype "${dtype}" is unsupported.`);
  }
  if (!(data instanceof Ctor)) {
    throw new TypeError(
      `Table dtype "${dtype}" requires data to be a ${Ctor.name}.`,
    );
  }
  if (dtype === 'uint8') return new Uint8Array(data);

  const out = new Uint8Array(data.length * bytesPerElement(dtype));
  const view = new DataView(out.buffer);
  for (let i = 0; i < data.length; i++) {
    const offset = i * bytesPerElement(dtype);
    switch (dtype) {
      case 'uint16':
        view.setUint16(offset, data[i], true);
        break;
      case 'uint32':
        view.setUint32(offset, data[i], true);
        break;
      case 'int32':
        view.setInt32(offset, data[i], true);
        break;
      case 'float32':
        view.setFloat32(offset, data[i], true);
        break;
      case 'float64':
        view.setFloat64(offset, data[i], true);
        break;
      default:
        throw new TypeError(`Unsupported numeric table dtype "${dtype}".`);
    }
  }
  return out;
}

function decodeNumericLittleEndian(dtype, payload, rowCount) {
  const Ctor = typedArrayCtor(dtype);
  const bpe = bytesPerElement(dtype);
  if (!Ctor || bpe === 0) {
    throw new TypeError(`Unsupported numeric table dtype "${dtype}".`);
  }
  if (payload.byteLength !== rowCount * bpe) {
    throw new Error(`Table raw "${dtype}" column byte length does not match rowCount.`);
  }
  if (dtype === 'uint8') return new Uint8Array(payload);

  const out = new Ctor(rowCount);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let i = 0; i < rowCount; i++) {
    const offset = i * bpe;
    switch (dtype) {
      case 'uint16':
        out[i] = view.getUint16(offset, true);
        break;
      case 'uint32':
        out[i] = view.getUint32(offset, true);
        break;
      case 'int32':
        out[i] = view.getInt32(offset, true);
        break;
      case 'float32':
        out[i] = view.getFloat32(offset, true);
        break;
      case 'float64':
        out[i] = view.getFloat64(offset, true);
        break;
      default:
        throw new TypeError(`Unsupported numeric table dtype "${dtype}".`);
    }
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
  assertExactKeys(col, ['name', 'dtype', 'data'], 'Table column');
  const name = assertNonEmptyString(col.name, 'Table column name');
  const dtype = /** @type {TableDType} */ (col.dtype);
  const data = col.data;

  if (dtype === 'bool') {
    assertArray(data, `Boolean table column "${name}" data`);
    if (data.length !== rowCount) {
      throw new Error(`encodeTable: column "${name}" length mismatch (${data.length} != ${rowCount}).`);
    }
    // Bitset: 1 bit per row, LSB first.
    const byteLen = Math.ceil(rowCount / 8);
    const out = new Uint8Array(byteLen);
    for (let i = 0; i < rowCount; i++) {
      if (typeof data[i] !== 'boolean') {
        throw new TypeError(`Boolean table column "${name}" row ${i} must be boolean.`);
      }
      if (!data[i]) continue;
      out[(i / 8) | 0] |= (1 << (i & 7));
    }
    return { meta: { name, dtype, encoding: 'bitset', byteLength: out.byteLength }, bytes: out };
  }

  if (dtype === 'string') {
    assertArray(data, `String table column "${name}" data`);
    if (data.length !== rowCount) {
      throw new Error(`encodeTable: column "${name}" length mismatch (${data.length} != ${rowCount}).`);
    }
    // Dictionary encoding: [dictCount uvarint][(len uvarint, bytes)...][codes Uint32Array]
    /** @type {Map<string, number>} */
    const dictIndex = new Map();
    /** @type {string[]} */
    const dict = [];
    const codes = new Uint32Array(rowCount);

    for (let i = 0; i < rowCount; i++) {
      const s = data[i];
      if (typeof s !== 'string') {
        throw new TypeError(`String table column "${name}" row ${i} must be a string.`);
      }
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
    const codeBytes = new Uint8Array(codes.byteLength);
    const codeView = new DataView(codeBytes.buffer);
    for (let i = 0; i < codes.length; i++) {
      codeView.setUint32(i * 4, codes[i], true);
    }
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

  if (!(data instanceof Ctor)) {
    throw new TypeError(`Table dtype "${dtype}" requires data to be a ${Ctor.name}.`);
  }
  if (data.length !== rowCount) {
    throw new Error(`encodeTable: column "${name}" length mismatch (${data.length} != ${rowCount}).`);
  }

  const out = encodeNumericLittleEndian(dtype, data);
  return { meta: { name, dtype, encoding: 'raw', byteLength: out.byteLength }, bytes: out };
}

/**
 * Encode a table into bytes (meta header + column payloads).
 * @param {Table} table
 * @returns {Uint8Array}
 */
export function encodeTable(table) {
  assertExactKeys(table, ['rowCount', 'columns'], 'Table');
  const rowCount = assertSafeInteger(table.rowCount, 'Table rowCount');
  const cols = assertArray(table.columns, 'Table columns');
  if (!cols.length) throw new Error('encodeTable: columns are required.');

  /** @type {any[]} */
  const columnMeta = [];
  /** @type {Uint8Array[]} */
  const payloads = [];

  const names = new Set();
  for (const col of cols) {
    const { meta, bytes } = encodeColumn(col, rowCount);
    if (names.has(meta.name)) {
      throw new TypeError(`encodeTable: duplicate column name "${meta.name}".`);
    }
    names.add(meta.name);
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
  if (metaLen === 0) throw new Error('decodeTable: metadata header must not be empty.');
  const metaStart = 4;
  const metaEnd = metaStart + metaLen;
  if (metaEnd > bytes.byteLength) throw new Error('decodeTable: truncated meta header.');

  const meta = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(metaStart, metaEnd)),
  );
  assertExactKeys(meta, ['rowCount', 'columns'], 'Table metadata');
  const rowCount = assertSafeInteger(meta.rowCount, 'Table metadata rowCount');
  const cols = assertArray(meta.columns, 'Table metadata columns');
  if (cols.length === 0) {
    throw new TypeError('Table metadata columns must not be empty.');
  }

  let offset = metaEnd;
  /** @type {Record<string, any>} */
  const out = {};

  const names = new Set();
  for (const col of cols) {
    assertPlainRecord(col, 'Table column metadata');
    const dtype = /** @type {TableDType} */ (col.dtype);
    const expectedKeys = dtype === 'string'
      ? ['name', 'dtype', 'encoding', 'byteLength', 'dictCount']
      : ['name', 'dtype', 'encoding', 'byteLength'];
    assertExactKeys(col, expectedKeys, 'Table column metadata');
    const name = assertNonEmptyString(col.name, 'Table column metadata name');
    if (names.has(name)) {
      throw new TypeError(`decodeTable: duplicate column name "${name}".`);
    }
    names.add(name);
    const encoding = col.encoding;
    const byteLength = assertSafeInteger(
      col.byteLength,
      `Table column "${name}" byteLength`
    );
    if (offset + byteLength > bytes.byteLength) throw new Error(`decodeTable: truncated column "${name}".`);

    const payload = bytes.subarray(offset, offset + byteLength);
    offset += byteLength;

    if (dtype === 'bool' && encoding === 'bitset') {
      if (byteLength !== Math.ceil(rowCount / 8)) {
        throw new Error(`decodeTable: boolean column "${name}" byte length mismatch.`);
      }
      if (rowCount % 8 !== 0 && byteLength > 0) {
        const usedBits = rowCount % 8;
        const unusedMask = 0xff << usedBits;
        if ((payload[payload.length - 1] & unusedMask) !== 0) {
          throw new Error(`decodeTable: boolean column "${name}" has non-canonical padding bits.`);
        }
      }
      const arr = new Uint8Array(rowCount);
      for (let i = 0; i < rowCount; i++) {
        const b = payload[(i / 8) | 0];
        arr[i] = (b >> (i & 7)) & 1;
      }
      setOwnDataProperty(out, name, arr);
      continue;
    }

    if (dtype === 'string' && encoding === 'dict') {
      // Parse dictionary section.
      let p = 0;
      const dictCountRes = decodeUvarint(payload, p);
      const dictCount = dictCountRes.value;
      p = dictCountRes.nextOffset;
      assertSafeInteger(col.dictCount, `Table string column "${name}" dictCount`);
      if (dictCount !== col.dictCount) {
        throw new Error(`decodeTable: string column "${name}" dictionary count mismatch.`);
      }

      /** @type {string[]} */
      const dict = new Array(dictCount);
      const dictValues = new Set();
      for (let i = 0; i < dictCount; i++) {
        const lenRes = decodeUvarint(payload, p);
        const byteLen = lenRes.value;
        p = lenRes.nextOffset;
        const strEnd = p + byteLen;
        if (strEnd > payload.byteLength) throw new Error('decodeTable: truncated string dict.');
        dict[i] = new TextDecoder('utf-8', { fatal: true }).decode(
          payload.subarray(p, strEnd),
        );
        if (dictValues.has(dict[i])) {
          throw new Error(`decodeTable: string column "${name}" dictionary contains duplicates.`);
        }
        dictValues.add(dict[i]);
        p = strEnd;
      }

      // Remaining bytes are Uint32 codes.
      const codesBytes = payload.subarray(p);
      if (codesBytes.byteLength !== rowCount * 4) {
        throw new Error('decodeTable: string codes length mismatch.');
      }
      const values = new Array(rowCount);
      const codeView = new DataView(
        codesBytes.buffer,
        codesBytes.byteOffset,
        codesBytes.byteLength,
      );
      let nextFirstUseCode = 0;
      for (let i = 0; i < rowCount; i++) {
        const code = codeView.getUint32(i * 4, true);
        if (code >= dict.length) {
          throw new Error(`decodeTable: string column "${name}" code is outside its dictionary.`);
        }
        if (code === nextFirstUseCode) {
          nextFirstUseCode += 1;
        } else if (code > nextFirstUseCode) {
          throw new Error(`decodeTable: string column "${name}" dictionary order is non-canonical.`);
        }
        values[i] = dict[code];
      }
      if (nextFirstUseCode !== dict.length) {
        throw new Error(`decodeTable: string column "${name}" contains unused dictionary entries.`);
      }
      setOwnDataProperty(out, name, values);
      continue;
    }

    if (encoding === 'raw') {
      if (dtype === 'bool' || dtype === 'string') {
        throw new Error(`decodeTable: dtype "${dtype}" requires its current exact encoding.`);
      }
      setOwnDataProperty(
        out,
        name,
        decodeNumericLittleEndian(dtype, payload, rowCount)
      );
      continue;
    }

    throw new Error(`decodeTable: unsupported column encoding "${encoding}" for "${name}".`);
  }

  if (offset !== bytes.byteLength) {
    throw new Error('decodeTable: trailing bytes are not allowed.');
  }
  return { rowCount, columns: out, meta };
}
