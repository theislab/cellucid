/**
 * @fileoverview PNG metadata embedding (tEXt chunks) for figure export.
 *
 * Browsers don't provide a native way to write PNG tEXt metadata via Canvas,
 * so we post-process the encoded PNG and inject standard tEXt chunks.
 *
 * This is only executed on export and does not affect the render loop.
 *
 * @module ui/modules/figure-export/utils/png-metadata
 */

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

let crcTable = null;
function getCrcTable() {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(bytes) {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function asciiBytes(str) {
  const s = String(str || '');
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function latin1Bytes(str) {
  const s = String(str || '');
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out[i] = code <= 255 ? code : 63; // '?'
  }
  return out;
}

function makeChunk(type, data) {
  const typeBytes = asciiBytes(type);
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
 * Build a tEXt chunk.
 * Keyword must be 1..79 bytes and Latin-1; we sanitize to ASCII.
 */
function makeTextChunk(keyword, text) {
  const keyRaw = String(keyword || '').trim() || 'Comment';
  const key = keyRaw.replace(/[^\x20-\x7E]/g, '').slice(0, 79) || 'Comment';
  const keyBytes = asciiBytes(key);
  const textBytes = latin1Bytes(String(text ?? ''));
  const data = new Uint8Array(keyBytes.length + 1 + textBytes.length);
  data.set(keyBytes, 0);
  data[keyBytes.length] = 0;
  data.set(textBytes, keyBytes.length + 1);
  return makeChunk('tEXt', data);
}

/**
 * Inject PNG tEXt chunks before IEND.
 *
 * @param {Blob} blob
 * @param {Record<string, string>} textMap
 * @returns {Promise<Blob>}
 */
export async function embedPngTextChunks(blob, textMap) {
  if (!blob) return blob;
  let bytes;
  try {
    bytes = new Uint8Array(await blob.arrayBuffer());
  } catch {
    return blob;
  }
  if (!isPng(bytes)) return blob;

  // Locate IEND.
  let offset = 8;
  let iendOffset = -1;
  while (offset + 8 <= bytes.length) {
    const len = readU32BE(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const chunkSize = 12 + len;
    if (offset + chunkSize > bytes.length) break;
    if (type === 'IEND') {
      iendOffset = offset;
      break;
    }
    offset += chunkSize;
  }
  if (iendOffset < 0) return blob;

  const entries = Object.entries(textMap || {}).filter(([k, v]) => k && v != null && String(v).length);
  if (!entries.length) return blob;

  const chunks = entries.map(([k, v]) => makeTextChunk(k, String(v)));
  const insertLen = chunks.reduce((sum, c) => sum + c.length, 0);

  const out = new Uint8Array(bytes.length + insertLen);
  out.set(bytes.subarray(0, iendOffset), 0);
  let cursor = iendOffset;
  for (const c of chunks) {
    out.set(c, cursor);
    cursor += c.length;
  }
  out.set(bytes.subarray(iendOffset), cursor);

  return new Blob([out], { type: 'image/png' });
}

