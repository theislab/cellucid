/**
 * @fileoverview PNG metadata for figure export: the resolution (`pHYs`) and
 * UTF-8 text (`iTXt`).
 *
 * Browsers write neither when they encode a canvas, so the encoded PNG is
 * post-processed: without `pHYs` a layout program places a 300 dpi figure at
 * 72 dpi, four times its size.
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

/**
 * A PNG's width and height from its header (`IHDR`, the first chunk), or
 * null when the bytes do not begin as a PNG's (24 bytes are enough): the one
 * reader of a picture's sides, for the views a tool returns and the pictures
 * a chat is sent.
 *
 * @param {Uint8Array} bytes
 * @returns {{width: number, height: number}|null}
 */
export function pngSidesOf(bytes) {
  if (!isPng(bytes) || bytes.length < 24) return null;
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null;
  return { width: readU32BE(bytes, 16) >>> 0, height: readU32BE(bytes, 20) >>> 0 };
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

/** Meters per inch: `pHYs` counts pixels per meter. */
const METRES_PER_INCH = 0.0254;

/**
 * The `pHYs` chunk of a resolution: the same pixels per meter across and
 * down, unit meter (1), so a layout program places the image at its size.
 *
 * @param {number} dpi
 */
function makeResolutionChunk(dpi) {
  const perMetre = Math.round(dpi / METRES_PER_INCH);
  const data = new Uint8Array(9);
  writeU32BE(data, 0, perMetre);
  writeU32BE(data, 4, perMetre);
  data[8] = 1;
  return makeChunk('pHYs', data);
}

/**
 * Write a figure's metadata into its encoded PNG: its resolution (`pHYs`,
 * right after `IHDR`: the format wants it before the image data; one the
 * encoder wrote is replaced) and its text (UTF-8 `iTXt` chunks, before
 * `IEND`). Every chunk's CRC is checked on the way.
 *
 * @param {Blob} blob
 * @param {{text: Record<string, string>, dpi: number}} metadata
 * @returns {Promise<Blob>}
 */
export async function embedPngMetadata(blob, { text, dpi }) {
  if (!(blob instanceof Blob) || blob.type !== 'image/png') {
    throw new TypeError('PNG metadata input must be an image/png Blob.');
  }
  if (
    text === null ||
    typeof text !== 'object' ||
    Array.isArray(text) ||
    Object.getPrototypeOf(text) !== Object.prototype
  ) {
    throw new TypeError('PNG metadata must be a plain object.');
  }
  const entries = Object.entries(text);
  if (entries.length === 0) {
    throw new TypeError('PNG metadata must contain at least one entry.');
  }
  if (!Number.isFinite(dpi) || dpi <= 0) {
    throw new RangeError('PNG metadata needs the resolution in dots per inch.');
  }

  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (!isPng(bytes)) {
    throw new Error('PNG metadata input has an invalid PNG signature.');
  }

  // Walk the chunks: IHDR first, any pHYs (replaced), IEND last.
  const kept = [];
  let offset = 8;
  let headerEnd = -1;
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
    if (offset === 8) {
      if (type !== 'IHDR') throw new Error('PNG metadata input does not start with IHDR.');
      headerEnd = offset + chunkSize;
    } else if (type === 'IEND') {
      if (len !== 0 || offset + chunkSize !== bytes.length) {
        throw new Error('PNG metadata input contains an invalid IEND chunk.');
      }
      iendOffset = offset;
      break;
    } else if (type !== 'pHYs') {
      kept.push(bytes.subarray(offset, offset + chunkSize));
    }
    offset += chunkSize;
  }
  if (iendOffset < 0) {
    throw new Error('PNG metadata input has no IEND chunk.');
  }

  return new Blob(
    [
      bytes.subarray(0, headerEnd),
      makeResolutionChunk(dpi),
      ...kept,
      ...entries.map(([keyword, value]) => makeTextChunk(keyword, value)),
      bytes.subarray(iendOffset)
    ],
    { type: 'image/png' }
  );
}
