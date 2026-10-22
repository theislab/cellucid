/**
 * Bounded Zarr v2 codec support used by the browser-side AnnData reader.
 *
 * The goal here is deliberately narrower than a general NumCodecs registry:
 * support the encodings emitted by standard AnnData/Zarr writers without ever
 * treating unknown metadata or malformed compressed bytes as usable data.
 */

import { createSlicedInputStream } from '../app/session/codecs/gzip.js';

/**
 * DEFLATE's maximum expansion: one 258-byte match per two bits at best gives
 * 1032 output bytes per input byte (RFC 1951). The decoded size of a chunk
 * whose array does not declare one (variable-length strings) is bounded by
 * it, which is the codec's own limit, not a chosen number.
 */
const DEFLATE_MAX_EXPANSION = 1032;

/**
 * LZ4's maximum expansion: a 4-bit token plus 255-byte length extensions
 * reach just under 255 output bytes per input byte. Blosc frames declare
 * their decoded size, which may not exceed this times the compressed size.
 */
const LZ4_MAX_EXPANSION = 255;

const NUMERIC_DTYPES = new Map([
  ['|b1', { ArrayType: Uint8Array, bytes: 1, kind: 'boolean' }],
  ['<i1', { ArrayType: Int8Array, bytes: 1, kind: 'integer' }],
  ['>i1', { ArrayType: Int8Array, bytes: 1, kind: 'integer' }],
  ['|i1', { ArrayType: Int8Array, bytes: 1, kind: 'integer' }],
  ['<i2', { ArrayType: Int16Array, bytes: 2, kind: 'integer' }],
  ['>i2', { ArrayType: Int16Array, bytes: 2, kind: 'integer' }],
  ['<i4', { ArrayType: Int32Array, bytes: 4, kind: 'integer' }],
  ['>i4', { ArrayType: Int32Array, bytes: 4, kind: 'integer' }],
  ['<i8', { ArrayType: BigInt64Array, bytes: 8, kind: 'bigint' }],
  ['>i8', { ArrayType: BigInt64Array, bytes: 8, kind: 'bigint' }],
  ['<u1', { ArrayType: Uint8Array, bytes: 1, kind: 'integer' }],
  ['>u1', { ArrayType: Uint8Array, bytes: 1, kind: 'integer' }],
  ['|u1', { ArrayType: Uint8Array, bytes: 1, kind: 'integer' }],
  ['<u2', { ArrayType: Uint16Array, bytes: 2, kind: 'integer' }],
  ['>u2', { ArrayType: Uint16Array, bytes: 2, kind: 'integer' }],
  ['<u4', { ArrayType: Uint32Array, bytes: 4, kind: 'integer' }],
  ['>u4', { ArrayType: Uint32Array, bytes: 4, kind: 'integer' }],
  ['<u8', { ArrayType: BigUint64Array, bytes: 8, kind: 'bigint' }],
  ['>u8', { ArrayType: BigUint64Array, bytes: 8, kind: 'bigint' }],
  ['<f2', {
    ArrayType: Float32Array,
    bytes: 2,
    materializedBytes: 4,
    kind: 'float',
    halfFloat: true
  }],
  ['>f2', {
    ArrayType: Float32Array,
    bytes: 2,
    materializedBytes: 4,
    kind: 'float',
    halfFloat: true
  }],
  ['<f4', { ArrayType: Float32Array, bytes: 4, kind: 'float' }],
  ['>f4', { ArrayType: Float32Array, bytes: 4, kind: 'float' }],
  ['<f8', { ArrayType: Float64Array, bytes: 8, kind: 'float' }],
  ['>f8', { ArrayType: Float64Array, bytes: 8, kind: 'float' }]
]);

function asBytes(value) {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('Zarr chunk payload must be an ArrayBuffer or typed-array view');
}

function exactArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function checkedProduct(values, label) {
  let product = 1;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid Zarr ${label}: dimensions must be non-negative safe integers`);
    }
    product *= value;
    if (!Number.isSafeInteger(product)) {
      throw new Error(`Invalid Zarr ${label}: element count exceeds safe integer range`);
    }
  }
  return product;
}

export function getZarrDtypeInfo(dtype) {
  if (typeof dtype !== 'string') {
    throw new Error(`Unsupported Zarr dtype: ${JSON.stringify(dtype)}`);
  }

  const numeric = NUMERIC_DTYPES.get(dtype);
  if (numeric) {
    return {
      ...numeric,
      dtype,
      category: 'numeric',
      bigEndian: dtype.startsWith('>') && numeric.bytes > 1
    };
  }

  const byteString = dtype.match(/^\|S([1-9]\d*)$/);
  if (byteString) {
    const charCount = Number(byteString[1]);
    if (!Number.isSafeInteger(charCount)) {
      throw new Error(`Unsupported Zarr dtype '${dtype}': fixed string is too large`);
    }
    return {
      dtype,
      category: 'fixed-string',
      encoding: 'bytes',
      charCount,
      bytes: charCount,
      bigEndian: false
    };
  }

  const unicodeString = dtype.match(/^([<>])U([1-9]\d*)$/);
  if (unicodeString) {
    const charCount = Number(unicodeString[2]);
    const bytes = charCount * 4;
    if (!Number.isSafeInteger(bytes)) {
      throw new Error(`Unsupported Zarr dtype '${dtype}': fixed string is too large`);
    }
    return {
      dtype,
      category: 'fixed-string',
      encoding: 'utf32',
      charCount,
      bytes,
      bigEndian: unicodeString[1] === '>'
    };
  }

  if (dtype === '|O') {
    return {
      dtype,
      category: 'object',
      bytes: null,
      bigEndian: false
    };
  }

  throw new Error(`Unsupported Zarr dtype '${dtype}'`);
}

export function validateZarrArrayMetadata(meta, context = 'Zarr') {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error('Invalid Zarr array metadata');
  }
  if (meta.zarr_format !== 2) {
    throw new Error(`Unsupported Zarr format '${meta.zarr_format}'; browser loading supports Zarr v2`);
  }
  for (const key of ['compressor', 'fill_value', 'filters']) {
    if (!Object.hasOwn(meta, key)) {
      throw new Error(`Zarr v2 array metadata '${key}' is required`);
    }
  }
  if (!Array.isArray(meta.shape) || !Array.isArray(meta.chunks) ||
      meta.shape.length === 0 || meta.shape.length !== meta.chunks.length) {
    throw new Error('Invalid Zarr shape/chunks metadata');
  }
  if (meta.shape.length > 2) {
    throw new Error(`Unsupported Zarr array rank ${meta.shape.length}; AnnData browser loading supports 1D and 2D arrays`);
  }

  checkedProduct(meta.shape, 'shape');
  const chunkElementCount = checkedProduct(meta.chunks, 'chunk shape');
  if (meta.chunks.some(value => value <= 0)) {
    throw new Error('Invalid Zarr chunk shape: dimensions must be positive');
  }
  checkedProduct(
    meta.shape.map((dimension, index) => Math.ceil(dimension / meta.chunks[index])),
    'chunk count'
  );
  if (meta.order !== 'C' && meta.order !== 'F') {
    throw new Error(`Unsupported Zarr array order '${meta.order}'`);
  }

  const separator = meta.dimension_separator ?? '.';
  if (separator !== '.' && separator !== '/') {
    throw new Error(`Unsupported Zarr dimension_separator '${separator}'`);
  }

  const dtypeInfo = getZarrDtypeInfo(meta.dtype);
  if (dtypeInfo.bytes != null) {
    checkedProduct([chunkElementCount, dtypeInfo.bytes], 'decoded chunk size');
  }
  validateFilters(meta.filters, dtypeInfo);
  validateCompressor(meta.compressor);
  return dtypeInfo;
}

/**
 * The element count of one array (the product of its shape).
 *
 * @param {Object} meta
 * @returns {number}
 */
export function zarrElementCount(meta) {
  return checkedProduct(meta.shape, 'shape');
}

export function zarrChunkKey(indices, dimensionSeparator = '.') {
  if (!Array.isArray(indices) || indices.length === 0 ||
      indices.some(index => !Number.isSafeInteger(index) || index < 0)) {
    throw new Error('Invalid Zarr chunk coordinates');
  }
  if (dimensionSeparator !== '.' && dimensionSeparator !== '/') {
    throw new Error(`Unsupported Zarr dimension_separator '${dimensionSeparator}'`);
  }
  return indices.join(dimensionSeparator);
}

function validateFilters(filters, dtypeInfo) {
  const normalized = filters ?? [];
  if (!Array.isArray(normalized)) {
    throw new Error('Invalid Zarr filters metadata');
  }

  if (dtypeInfo.category === 'object') {
    if (normalized.length !== 1 || normalized[0]?.id !== 'vlen-utf8') {
      const ids = normalized.map(filter => filter?.id ?? 'invalid').join(', ') || 'none';
      throw new Error(
        `Unsupported Zarr filter chain '${ids}' for object dtype; expected vlen-utf8`
      );
    }
    return;
  }

  if (normalized.length > 0) {
    const ids = normalized.map(filter => filter?.id ?? 'invalid').join(', ');
    throw new Error(`Unsupported Zarr filter chain '${ids}'`);
  }
}

function validateCompressor(compressor) {
  if (compressor === null) {
    return;
  }
  if (typeof compressor !== 'object' || Array.isArray(compressor) ||
      typeof compressor.id !== 'string') {
    throw new Error('Invalid Zarr compressor metadata');
  }
  if (compressor.id === 'null') {
    throw new Error(
      "Unsupported Zarr compressor 'null'; uncompressed arrays must declare compressor: null"
    );
  }

  if (compressor.id === 'gzip' || compressor.id === 'zlib') {
    return;
  }
  if (compressor.id === 'blosc') {
    if (compressor.cname !== 'lz4' && compressor.cname !== 'lz4hc') {
      throw new Error(
        `Unsupported Blosc codec '${compressor.cname}'; browser loading supports lz4 and lz4hc`
      );
    }
    if (compressor.shuffle != null && compressor.shuffle !== 0 && compressor.shuffle !== 1) {
      throw new Error('Unsupported Blosc bit-shuffle encoding');
    }
    if (compressor.blocksize != null &&
        (!Number.isSafeInteger(compressor.blocksize) || compressor.blocksize < 0)) {
      throw new Error('Invalid Blosc block size');
    }
    return;
  }

  throw new Error(
    `Unsupported Zarr compressor '${compressor.id}'; supported compressors are null, gzip, zlib, and Blosc/LZ4`
  );
}

function readExtendedLz4Length(input, cursor, initialLength, maximumLength) {
  let length = initialLength;
  if (length > maximumLength) {
    throw new Error('Malformed LZ4 block: length exceeds output bounds');
  }
  if (initialLength !== 15) {
    return { length, cursor };
  }

  while (true) {
    if (cursor >= input.length) {
      throw new Error('Malformed LZ4 block: truncated extended length');
    }
    const next = input[cursor++];
    if (next > maximumLength - length) {
      throw new Error('Malformed LZ4 block: length exceeds output bounds');
    }
    length += next;
    if (next !== 255) {
      return { length, cursor };
    }
  }
}

/**
 * Decode one raw LZ4 block to an exact output size.
 */
export function decodeLz4Block(inputValue, outputLength) {
  const input = asBytes(inputValue);
  if (!Number.isSafeInteger(outputLength) || outputLength < 0 ||
      outputLength > input.length * LZ4_MAX_EXPANSION + 64) {
    throw new Error('Invalid LZ4 output size');
  }

  const output = new Uint8Array(outputLength);
  let inputOffset = 0;
  let outputOffset = 0;
  let endedWithFinalLiterals = false;

  while (inputOffset < input.length) {
    const token = input[inputOffset++];

    let literal = readExtendedLz4Length(
      input,
      inputOffset,
      token >>> 4,
      output.length - outputOffset
    );
    inputOffset = literal.cursor;
    if (inputOffset + literal.length > input.length ||
        outputOffset + literal.length > output.length) {
      throw new Error('Malformed LZ4 block: literal run exceeds its bounds');
    }
    output.set(input.subarray(inputOffset, inputOffset + literal.length), outputOffset);
    inputOffset += literal.length;
    outputOffset += literal.length;

    if (inputOffset === input.length) {
      endedWithFinalLiterals = true;
      break;
    }
    if (inputOffset + 2 > input.length) {
      throw new Error('Malformed LZ4 block: missing match offset');
    }

    const matchOffset = input[inputOffset] | (input[inputOffset + 1] << 8);
    inputOffset += 2;
    if (matchOffset === 0 || matchOffset > outputOffset) {
      throw new Error('Malformed LZ4 block: invalid match offset');
    }

    const remainingMatchOutput = output.length - outputOffset;
    if (remainingMatchOutput < 4) {
      throw new Error('Malformed LZ4 block: length exceeds output bounds');
    }
    let match = readExtendedLz4Length(
      input,
      inputOffset,
      token & 0x0f,
      remainingMatchOutput - 4
    );
    inputOffset = match.cursor;
    const matchLength = match.length + 4;
    if (outputOffset + matchLength > output.length) {
      throw new Error('Malformed LZ4 block: match run exceeds its bounds');
    }

    let sourceOffset = outputOffset - matchOffset;
    for (let index = 0; index < matchLength; index++) {
      output[outputOffset++] = output[sourceOffset++];
    }
  }

  if (!endedWithFinalLiterals) {
    throw new Error('Malformed LZ4 block: missing final literal sequence');
  }
  if (inputOffset !== input.length || outputOffset !== output.length) {
    throw new Error(
      `Malformed LZ4 block: decoded ${outputOffset} of ${output.length} expected bytes`
    );
  }
  return output;
}

function unshuffleBytes(shuffled, typesize) {
  if (typesize <= 1) {
    return shuffled;
  }

  const output = new Uint8Array(shuffled.length);
  const elementCount = Math.floor(shuffled.length / typesize);
  const shuffledLength = elementCount * typesize;

  for (let byteIndex = 0; byteIndex < typesize; byteIndex++) {
    const laneOffset = byteIndex * elementCount;
    for (let elementIndex = 0; elementIndex < elementCount; elementIndex++) {
      output[elementIndex * typesize + byteIndex] = shuffled[laneOffset + elementIndex];
    }
  }
  output.set(shuffled.subarray(shuffledLength), shuffledLength);
  return output;
}

/**
 * Decode the bounded Blosc v1 frame subset produced by NumCodecs with LZ4.
 */
function decodeBloscLz4(
  inputValue,
  compressor,
  expectedByteLength = null,
  expectedTypesize = null
) {
  validateCompressor(compressor);
  const input = asBytes(inputValue);
  if (input.byteLength < 16) {
    throw new Error('Malformed Blosc frame: header is truncated');
  }

  const header = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const version = header.getUint8(0);
  const codecVersion = header.getUint8(1);
  const flags = header.getUint8(2);
  const typesize = header.getUint8(3);
  const nbytes = header.getUint32(4, true);
  const blocksize = header.getUint32(8, true);
  const ctbytes = header.getUint32(12, true);

  if (version !== 2) {
    throw new Error(`Unsupported Blosc frame version '${version}'`);
  }
  if (typesize === 0) {
    throw new Error('Malformed Blosc frame: typesize is zero');
  }
  if (expectedByteLength == null && nbytes > input.byteLength * LZ4_MAX_EXPANSION + 64) {
    throw new Error(
      `Malformed Blosc frame: declares ${nbytes} decoded bytes, more than LZ4 can encode in ${input.byteLength}`
    );
  }
  if (expectedByteLength != null && nbytes !== expectedByteLength) {
    throw new Error(
      `Malformed Blosc frame: decoded size ${nbytes} does not match expected ${expectedByteLength}`
    );
  }
  if (ctbytes !== input.byteLength || ctbytes < 16) {
    throw new Error('Malformed Blosc frame: compressed-size header does not match the chunk');
  }
  if ((flags & 0x08) !== 0) {
    throw new Error('Unsupported Blosc frame flags');
  }

  const isShuffled = (flags & 0x01) !== 0;
  const isMemcpy = (flags & 0x02) !== 0;
  const isBitShuffled = (flags & 0x04) !== 0;
  const dontSplit = (flags & 0x10) !== 0;
  const codecFormat = flags >>> 5;

  if (isBitShuffled) {
    throw new Error('Unsupported Blosc bit-shuffle encoding');
  }
  if (codecFormat !== 1) {
    throw new Error(
      `Unsupported Blosc codec format '${codecFormat}'; expected LZ4-compatible format`
    );
  }
  if (codecVersion !== 1) {
    throw new Error(`Unsupported Blosc LZ4 format version '${codecVersion}'`);
  }
  if (compressor.shuffle != null && Boolean(compressor.shuffle) !== isShuffled) {
    throw new Error('Malformed Blosc frame: shuffle flag contradicts compressor metadata');
  }
  if (expectedTypesize != null && typesize !== expectedTypesize) {
    throw new Error(
      `Malformed Blosc frame: typesize ${typesize} does not match dtype size ${expectedTypesize}`
    );
  }

  if (isMemcpy) {
    if (ctbytes !== 16 + nbytes) {
      throw new Error('Malformed Blosc MEMCPY frame');
    }
    return exactArrayBuffer(input.subarray(16));
  }

  if (nbytes === 0) {
    if (ctbytes !== 16) {
      throw new Error('Malformed empty Blosc frame');
    }
    return new ArrayBuffer(0);
  }
  if (blocksize === 0 || blocksize > nbytes) {
    throw new Error('Malformed Blosc frame: invalid block size');
  }

  const blockCount = Math.ceil(nbytes / blocksize);
  const tableEnd = 16 + blockCount * 4;
  if (tableEnd > ctbytes) {
    throw new Error('Malformed Blosc frame: block table is truncated');
  }

  const blockStarts = new Array(blockCount);
  const uniqueStarts = new Set();
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    const start = header.getUint32(16 + blockIndex * 4, true);
    if (start < tableEnd || start >= ctbytes || uniqueStarts.has(start)) {
      throw new Error('Malformed Blosc frame: invalid block offset table');
    }
    uniqueStarts.add(start);
    blockStarts[blockIndex] = start;
  }
  const physicalStarts = [...blockStarts].sort((left, right) => left - right);
  if (physicalStarts[0] !== tableEnd) {
    throw new Error('Malformed Blosc frame: invalid block offset table');
  }
  const physicalEnds = new Map();
  for (let physicalIndex = 0; physicalIndex < physicalStarts.length; physicalIndex++) {
    physicalEnds.set(
      physicalStarts[physicalIndex],
      physicalIndex + 1 < physicalStarts.length
        ? physicalStarts[physicalIndex + 1]
        : ctbytes
    );
  }

  const output = new Uint8Array(nbytes);
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    const outputStart = blockIndex * blocksize;
    const blockBytes = Math.min(blocksize, nbytes - outputStart);
    const blockStart = blockStarts[blockIndex];
    const blockEnd = physicalEnds.get(blockStart);
    const isLeftoverBlock = blockBytes !== blocksize;
    const canSplit = !dontSplit && !isLeftoverBlock && typesize <= 16 &&
      Math.floor(blocksize / typesize) >= 128;
    const splitCount = canSplit ? typesize : 1;

    if (blockBytes % splitCount !== 0) {
      throw new Error('Malformed Blosc frame: block cannot be divided into codec streams');
    }

    const splitBytes = blockBytes / splitCount;
    const shuffledBlock = new Uint8Array(blockBytes);
    let cursor = blockStart;

    for (let splitIndex = 0; splitIndex < splitCount; splitIndex++) {
      if (cursor + 4 > blockEnd) {
        throw new Error('Malformed Blosc frame: codec-stream length is truncated');
      }
      const compressedLength = header.getUint32(cursor, true);
      cursor += 4;
      if (compressedLength === 0 || compressedLength > splitBytes ||
          cursor + compressedLength > blockEnd) {
        throw new Error('Malformed Blosc frame: invalid codec-stream length');
      }

      const compressed = input.subarray(cursor, cursor + compressedLength);
      cursor += compressedLength;
      const decoded = compressedLength === splitBytes
        ? compressed
        : decodeLz4Block(compressed, splitBytes);
      shuffledBlock.set(decoded, splitIndex * splitBytes);
    }

    if (cursor !== blockEnd) {
      throw new Error('Malformed Blosc frame: trailing bytes in block');
    }

    const decodedBlock = isShuffled ? unshuffleBytes(shuffledBlock, typesize) : shuffledBlock;
    output.set(decodedBlock, outputStart);
  }

  return output.buffer;
}

/**
 * Inflate one chunk. With a declared size the output is allocated once at
 * exactly that size and inflation stops the moment it would pass it; without
 * one (variable-length strings) the output is bounded by DEFLATE's own
 * maximum expansion of the input.
 */
async function decompressStream(input, format, expectedByteLength) {
  if (typeof DecompressionStream === 'undefined' ||
      typeof ReadableStream === 'undefined') {
    throw new Error(
      `${format} decompression is unavailable in this browser; use Blosc/LZ4 or an uncompressed Zarr store`
    );
  }
  const outputLimit = expectedByteLength ?? input.byteLength * DEFLATE_MAX_EXPANSION + 64;

  let stream;
  try {
    // Sliced input keeps native inflation paced by this reader, so the limit
    // below cancels a DEFLATE bomb within one slice instead of after the
    // whole chunk has expanded.
    stream = createSlicedInputStream([input])
      .pipeThrough(new DecompressionStream(format));
  } catch (error) {
    throw new Error(`Unable to initialize ${format} decompression`, { cause: error });
  }

  const reader = stream.getReader();
  const exact = expectedByteLength != null ? new Uint8Array(expectedByteLength) : null;
  const pieces = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const bytes = asBytes(value);
      if (total + bytes.byteLength > outputLimit) {
        throw new Error(`Decompressed Zarr chunk exceeds its ${outputLimit}-byte declared size`);
      }
      if (exact !== null) exact.set(bytes, total);
      else pieces.push(bytes);
      total += bytes.byteLength;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    if (/exceeds its/.test(error?.message ?? '')) throw error;
    throw new Error(`Invalid or unsupported ${format} Zarr chunk`, { cause: error });
  }
  if (exact !== null) {
    return total === exact.length ? exact.buffer : exact.slice(0, total).buffer;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    output.set(piece, offset);
    offset += piece.byteLength;
  }
  return output.buffer;
}

async function decompressChunk(
  inputValue,
  compressor,
  expectedByteLength,
  expectedTypesize
) {
  validateCompressor(compressor);
  const input = asBytes(inputValue);

  let output;
  if (compressor === null) {
    output = exactArrayBuffer(input);
  } else if (compressor.id === 'blosc') {
    output = decodeBloscLz4(
      input,
      compressor,
      expectedByteLength,
      expectedTypesize
    );
  } else {
    const format = compressor.id === 'zlib' ? 'deflate' : 'gzip';
    output = await decompressStream(input, format, expectedByteLength);
  }

  if (expectedByteLength != null && output.byteLength !== expectedByteLength) {
    throw new Error(
      `Invalid Zarr chunk: decoded ${output.byteLength} bytes; expected ${expectedByteLength}`
    );
  }
  return output;
}

export function decodeVLenUtf8(inputValue, expectedItems) {
  const input = asBytes(inputValue);
  if (input.byteLength < 4) {
    throw new Error('Malformed VLenUTF8 payload: item count is truncated');
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const itemCount = view.getUint32(0, true);
  if (itemCount !== expectedItems) {
    throw new Error(
      `Malformed VLenUTF8 payload: contains ${itemCount} items; expected ${expectedItems}`
    );
  }
  if (itemCount > Math.floor((input.byteLength - 4) / 4)) {
    throw new Error('Malformed VLenUTF8 payload: item count exceeds payload bounds');
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const values = new Array(itemCount);
  let cursor = 4;
  for (let index = 0; index < itemCount; index++) {
    if (cursor + 4 > input.byteLength) {
      throw new Error('Malformed VLenUTF8 payload: string length is truncated');
    }
    const length = view.getUint32(cursor, true);
    cursor += 4;
    if (cursor + length > input.byteLength) {
      throw new Error('Malformed VLenUTF8 payload: string bytes are truncated');
    }
    try {
      values[index] = decoder.decode(input.subarray(cursor, cursor + length));
    } catch (error) {
      throw new Error('Malformed VLenUTF8 payload: invalid UTF-8', { cause: error });
    }
    cursor += length;
  }
  if (cursor !== input.byteLength) {
    throw new Error('Malformed VLenUTF8 payload: trailing bytes');
  }
  return values;
}

export async function decodeZarrChunk(inputValue, meta, dtypeInfo, chunkElementCount) {
  validateFilters(meta.filters, dtypeInfo);
  validateCompressor(meta.compressor);
  if (!Number.isSafeInteger(chunkElementCount) || chunkElementCount < 0) {
    throw new Error('Invalid Zarr chunk element count');
  }

  // The decoded size every chunk of a fixed-width array must have: its
  // declared shape times its item size. Nothing else bounds a chunk.
  const expectedByteLength = dtypeInfo.bytes == null
    ? null
    : checkedProduct([chunkElementCount, dtypeInfo.bytes], 'chunk byte size');

  const decoded = await decompressChunk(
    inputValue,
    meta.compressor,
    expectedByteLength,
    dtypeInfo.category === 'numeric' ? dtypeInfo.bytes : null
  );

  if (dtypeInfo.category === 'object') {
    return decodeVLenUtf8(decoded, chunkElementCount);
  }
  return decoded;
}
