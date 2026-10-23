/**
 * @fileoverview PNG metadata embedding (UTF-8 iTXt chunks) for figure export.
 *
 * Browsers don't provide a native way to write PNG iTXt metadata via Canvas,
 * so we post-process the encoded PNG and inject standard UTF-8 iTXt chunks.
 *
 * It runs in the figure-export worker, beside the encoder, so reading and
 * checksumming the encoded image never occupies the page's main thread.
 *
 * @module ui/modules/figure-export/utils/png-metadata
 */

import { crc32 } from '../../../../../formats/zip/crc32.js';

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function isPng(bytes) {
  if (!bytes || bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

function readU32BE(bytes, offset) {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    (bytes[offset + 3])
  ) >>> 0;
}

function writeU32BE(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function asciiBytes(value, context) {
  if (typeof value !== 'string' || !/^[\x20-\x7e]+$/.test(value)) {
    throw new TypeError(`${context} must be a non-empty printable ASCII string.`);
  }
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i);
  return out;
}

function makeChunk(type, data) {
  const typeBytes = asciiBytes(type, 'PNG chunk type');
  const length = data.length >>> 0;
  const out = new Uint8Array(4 + 4 + length + 4);
  writeU32BE(out, 0, length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + length));
  writeU32BE(out, 8 + length, crc);
  return out;
}

/**
 * Build an uncompressed UTF-8 iTXt chunk.
 * Keyword must already be 1..79 printable ASCII bytes.
 */
function makeTextChunk(keyword, text) {
  if (
    typeof keyword !== 'string' ||
    keyword.length < 1 ||
    keyword.length > 79
  ) {
    throw new TypeError('PNG metadata keyword must contain 1 through 79 characters.');
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw new TypeError('PNG metadata text must be a non-empty string.');
  }
  const keyBytes = asciiBytes(keyword, 'PNG metadata keyword');
  const textBytes = new TextEncoder().encode(text);
  const data = new Uint8Array(keyBytes.length + 5 + textBytes.length);
  data.set(keyBytes, 0);
  data[keyBytes.length] = 0;
  data[keyBytes.length + 1] = 0;
  data[keyBytes.length + 2] = 0;
  data[keyBytes.length + 3] = 0;
  data[keyBytes.length + 4] = 0;
  data.set(textBytes, keyBytes.length + 5);
  return makeChunk('iTXt', data);
}

/**
 * Inject PNG iTXt chunks before IEND.
 *
 * @param {Blob} blob
 * @param {Record<string, string>} textMap
 * @returns {Promise<Blob>}
 */
export async function embedPngTextChunks(blob, textMap) {
  if (!(blob instanceof Blob) || blob.type !== 'image/png') {
    throw new TypeError('PNG metadata input must be an image/png Blob.');
  }
  if (
    textMap === null ||
    typeof textMap !== 'object' ||
    Array.isArray(textMap) ||
    Object.getPrototypeOf(textMap) !== Object.prototype
  ) {
    throw new TypeError('PNG metadata must be a plain object.');
  }
  const entries = Object.entries(textMap);
  if (entries.length === 0) {
    throw new TypeError('PNG metadata must contain at least one entry.');
  }

  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (!isPng(bytes)) {
    throw new Error('PNG metadata input has an invalid PNG signature.');
  }

  // Locate IEND.
  let offset = 8;
  let iendOffset = -1;
  while (offset + 8 <= bytes.length) {
    const len = readU32BE(bytes, offset);
    if (len > bytes.length - offset - 12) {
      throw new Error('PNG metadata input contains a truncated chunk.');
    }
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const chunkSize = 12 + len;
    const expectedCrc = readU32BE(bytes, offset + 8 + len);
    const actualCrc = crc32(bytes.subarray(offset + 4, offset + 8 + len));
    if (expectedCrc !== actualCrc) {
      throw new Error(`PNG metadata input contains an invalid ${type} chunk CRC.`);
    }
    if (type === 'IEND') {
      if (len !== 0 || offset + chunkSize !== bytes.length) {
        throw new Error('PNG metadata input contains an invalid IEND chunk.');
      }
      iendOffset = offset;
      break;
    }
    offset += chunkSize;
  }
  if (iendOffset < 0) {
    throw new Error('PNG metadata input has no IEND chunk.');
  }

  const chunks = entries.map(([keyword, text]) => makeTextChunk(keyword, text));
  return new Blob(
    [bytes.subarray(0, iendOffset), ...chunks, bytes.subarray(iendOffset)],
    { type: 'image/png' }
  );
}
