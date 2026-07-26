/**
 * Bounded Zarr v2 codec support used by the browser-side AnnData reader.
 *
 * The goal here is deliberately narrower than a general NumCodecs registry:
 * support the encodings emitted by standard AnnData/Zarr writers without ever
 * treating unknown metadata or malformed compressed bytes as usable data.
 */

export const MAX_ZARR_CHUNK_BYTES = 64 * 1024 * 1024;
export const MAX_ZARR_ENCODED_CHUNK_BYTES = MAX_ZARR_CHUNK_BYTES + 64 * 1024;
export const MAX_ZARR_METADATA_BYTES = 4 * 1024 * 1024;
export const MAX_ZARR_MATERIALIZED_ARRAY_BYTES = 512 * 1024 * 1024;
export const MAX_ZARR_STRING_ITEMS = 16 * 1024 * 1024;
export const MAX_ZARR_CHUNKS_PER_ARRAY = 100_000;

// Conservative cross-engine estimate for the allocation owned by each
// materialized JavaScript string, excluding its UTF-16 payload and array slot.
// This intentionally covers V8, JavaScriptCore, and SpiderMonkey rather than
// relying on one engine's compact-string representation.
const ESTIMATED_JS_STRING_OVERHEAD_BYTES = 64;

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
  const chunkCount = checkedProduct(
    meta.shape.map((dimension, index) => Math.ceil(dimension / meta.chunks[index])),
    'chunk count'
  );
  if (chunkCount > MAX_ZARR_CHUNKS_PER_ARRAY) {
    throw new Error(
      `Zarr chunk count exceeds the ${MAX_ZARR_CHUNKS_PER_ARRAY}-chunk browser limit; use the Cellucid server or prepared format`
    );
  }
  if (meta.order !== 'C' && meta.order !== 'F') {
    throw new Error(`Unsupported Zarr array order '${meta.order}'`);
  }

  const separator = meta.dimension_separator ?? '.';
  if (separator !== '.' && separator !== '/') {
    throw new Error(`Unsupported Zarr dimension_separator '${separator}'`);
  }

  const dtypeInfo = getZarrDtypeInfo(meta.dtype);
  if (dtypeInfo.bytes != null) {
    const decodedChunkBytes = checkedProduct(
      [chunkElementCount, dtypeInfo.bytes],
      'decoded chunk size'
    );
    if (decodedChunkBytes > MAX_ZARR_CHUNK_BYTES) {
      throw new Error(
        `${context} decoded chunk exceeds the ${MAX_ZARR_CHUNK_BYTES}-byte browser limit; use the Cellucid server or prepared format`
      );
    }
  }
  validateFilters(meta.filters, dtypeInfo);
  validateCompressor(meta.compressor);
  return dtypeInfo;
}

export function estimateZarrChunkWorkingBytes(meta, dtypeInfo) {
  const chunkElementCount = BigInt(checkedProduct(
    meta.chunks,
    'chunk shape'
  ));
  const decodedChunkBytes = dtypeInfo.bytes == null
    ? BigInt(MAX_ZARR_CHUNK_BYTES)
    : chunkElementCount * BigInt(dtypeInfo.bytes);
  const compressorId = meta.compressor?.id ?? null;

  // Account for the encoded File buffer plus decoder-owned output/scratch:
  // - null: one decoded copy/view
  // - gzip/zlib streams: retained pieces plus their combined output
  // - Blosc: output, shuffled block, unshuffled block, and an LZ4 split
  let decodedCopies = compressorId === 'blosc'
    ? 4n
    : (compressorId === 'gzip' || compressorId === 'zlib' ? 2n : 1n);
  // With no compressor, the encoded File buffer and its decoded copy remain
  // live while endian conversion allocates one more native-order buffer.
  if (compressorId == null && dtypeInfo.bigEndian) {
    decodedCopies += 1n;
  }
  const expandedMaterializationBytes = dtypeInfo.materializedBytes != null
    ? chunkElementCount * BigInt(dtypeInfo.materializedBytes)
    : 0n;
  return BigInt(MAX_ZARR_ENCODED_CHUNK_BYTES) +
    decodedChunkBytes * decodedCopies +
    expandedMaterializationBytes;
}

function normalizeMinimumChunkWorkingBytes(value) {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error('Invalid Zarr chunk working-set plan');
    return value;
  }
  if (Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new Error('Invalid Zarr chunk working-set plan');
}

export function validateZarrMaterialization(
  meta,
  dtypeInfo,
  minimumChunkWorkingBytes = 0n
) {
  const elementCount = checkedProduct(meta.shape, 'shape');
  const materializedBytesPerElement = dtypeInfo.category === 'numeric'
    ? (dtypeInfo.materializedBytes ?? dtypeInfo.bytes)
    : 8;
  const estimatedBytes = checkedProduct(
    [elementCount, materializedBytesPerElement],
    'materialized array size'
  );
  if (estimatedBytes > MAX_ZARR_MATERIALIZED_ARRAY_BYTES ||
      (dtypeInfo.bytes == null && elementCount > MAX_ZARR_STRING_ITEMS)) {
    throw new Error(
      `Zarr array exceeds the ${MAX_ZARR_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
    );
  }

  const limit = BigInt(MAX_ZARR_MATERIALIZED_ARRAY_BYTES);
  const estimatedChunkWorkingBytes =
    estimateZarrChunkWorkingBytes(meta, dtypeInfo);
  const requestedChunkWorkingBytes =
    normalizeMinimumChunkWorkingBytes(minimumChunkWorkingBytes);
  const chunkWorkingBytes =
    requestedChunkWorkingBytes > estimatedChunkWorkingBytes
      ? requestedChunkWorkingBytes
      : estimatedChunkWorkingBytes;
  const zipExtractionDominates =
    requestedChunkWorkingBytes > estimatedChunkWorkingBytes;
  if (dtypeInfo.category === 'numeric') {
    const peakWorkingBytes = BigInt(estimatedBytes) + chunkWorkingBytes;
    if (peakWorkingBytes > limit) {
      throw new Error(
        zipExtractionDominates
          ? `Zarr array plus ZIP extraction peak working set exceeds the ${MAX_ZARR_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
          : `Zarr array peak working set exceeds the ${MAX_ZARR_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
      );
    }
  } else {
    const chunkElementCount = BigInt(checkedProduct(meta.chunks, 'chunk shape'));
    const resultPointerBytes = BigInt(elementCount) * 8n;
    const chunkPointerBytes = chunkElementCount * 8n;
    const retainedStringObjectBytes =
      BigInt(elementCount) * BigInt(ESTIMATED_JS_STRING_OVERHEAD_BYTES);
    const temporaryStringObjectBytes =
      chunkElementCount * BigInt(ESTIMATED_JS_STRING_OVERHEAD_BYTES);
    let retainedStringPayloadBytes = 0n;
    let temporaryStringPayloadBytes;
    if (dtypeInfo.category === 'fixed-string') {
      const utf16Multiplier = dtypeInfo.encoding === 'bytes' ? 2n : 1n;
      retainedStringPayloadBytes =
        BigInt(elementCount) * BigInt(dtypeInfo.bytes) * utf16Multiplier;
      temporaryStringPayloadBytes =
        chunkElementCount * BigInt(dtypeInfo.bytes) * utf16Multiplier;
    } else {
      // A valid VLenUTF8 decoded chunk is bounded by MAX_ZARR_CHUNK_BYTES.
      // ASCII can expand to two-byte UTF-16 storage in a portable worst case.
      temporaryStringPayloadBytes = BigInt(MAX_ZARR_CHUNK_BYTES) * 2n;
    }
    const peakWorkingBytes =
      resultPointerBytes +
      retainedStringObjectBytes +
      retainedStringPayloadBytes +
      chunkPointerBytes +
      temporaryStringObjectBytes +
      temporaryStringPayloadBytes +
      chunkWorkingBytes;
    if (peakWorkingBytes > BigInt(MAX_ZARR_MATERIALIZED_ARRAY_BYTES)) {
      throw new Error(
        zipExtractionDominates
          ? `Zarr string array plus ZIP extraction peak working set exceeds the ${MAX_ZARR_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
          : `Zarr string array peak working set exceeds the ${MAX_ZARR_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
      );
    }
  }
  return elementCount;
}

export function accountZarrStringStorage(
  currentBytes,
  values,
  reservedBytes = 0,
  valueCount = values?.length
) {
  if (!Number.isSafeInteger(currentBytes) || currentBytes < 0 ||
      !Number.isSafeInteger(reservedBytes) || reservedBytes < 0 ||
      reservedBytes > MAX_ZARR_MATERIALIZED_ARRAY_BYTES ||
      !Array.isArray(values) ||
      !Number.isSafeInteger(valueCount) ||
      valueCount < 0 ||
      valueCount > values.length) {
    throw new Error('Invalid Zarr string storage accounting input');
  }

  let totalBytes = currentBytes;
  for (let index = 0; index < valueCount; index++) {
    const value = values[index];
    if (typeof value !== 'string') {
      throw new Error('Invalid non-string value in Zarr string array');
    }
    const stringBytes =
      ESTIMATED_JS_STRING_OVERHEAD_BYTES + value.length * 2;
    if (!Number.isSafeInteger(stringBytes) ||
        stringBytes >
          MAX_ZARR_MATERIALIZED_ARRAY_BYTES - reservedBytes - totalBytes) {
      throw new Error(
        `Zarr string array exceeds the ${MAX_ZARR_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
      );
    }
    totalBytes += stringBytes;
  }
  return totalBytes;
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
      outputLength > MAX_ZARR_CHUNK_BYTES) {
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
export function decodeBloscLz4(
  inputValue,
  compressor,
  expectedByteLength = null,
  expectedTypesize = null
) {
  validateCompressor(compressor);
  const input = asBytes(inputValue);
  if (input.byteLength > MAX_ZARR_ENCODED_CHUNK_BYTES) {
    throw new Error(
      `Compressed Zarr chunk exceeds the ${MAX_ZARR_ENCODED_CHUNK_BYTES}-byte browser limit`
    );
  }
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
  if (nbytes > MAX_ZARR_CHUNK_BYTES) {
    throw new Error(`Blosc chunk exceeds the ${MAX_ZARR_CHUNK_BYTES}-byte browser limit`);
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

async function decompressStream(input, format, outputLimit) {
  if (typeof DecompressionStream === 'undefined' ||
      typeof ReadableStream === 'undefined') {
    throw new Error(
      `${format} decompression is unavailable in this browser; use Blosc/LZ4, an uncompressed Zarr store, or the Cellucid server`
    );
  }

  let stream;
  try {
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(input);
        controller.close();
      }
    });
    stream = source.pipeThrough(new DecompressionStream(format));
  } catch (error) {
    throw new Error(`Unable to initialize ${format} decompression`, { cause: error });
  }

  const reader = stream.getReader();
  const pieces = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const bytes = asBytes(value);
      total += bytes.byteLength;
      if (total > outputLimit || total > MAX_ZARR_CHUNK_BYTES) {
        await reader.cancel();
        throw new Error(`Decompressed Zarr chunk exceeds the ${outputLimit}-byte limit`);
      }
      pieces.push(bytes);
    }
  } catch (error) {
    if (/exceeds the/.test(error?.message ?? '')) throw error;
    throw new Error(`Invalid or unsupported ${format} Zarr chunk`, { cause: error });
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
  if (input.byteLength > MAX_ZARR_ENCODED_CHUNK_BYTES) {
    throw new Error(`Compressed Zarr chunk exceeds the ${MAX_ZARR_ENCODED_CHUNK_BYTES}-byte browser limit`);
  }

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
    output = await decompressStream(
      input,
      format,
      expectedByteLength ?? MAX_ZARR_CHUNK_BYTES
    );
  }

  if (output.byteLength > MAX_ZARR_CHUNK_BYTES) {
    throw new Error(
      `Decompressed Zarr chunk exceeds the ${MAX_ZARR_CHUNK_BYTES}-byte browser limit`
    );
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
  if (itemCount > MAX_ZARR_STRING_ITEMS ||
      itemCount > Math.floor((input.byteLength - 4) / 4)) {
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

  const expectedByteLength = dtypeInfo.bytes == null
    ? null
    : checkedProduct([chunkElementCount, dtypeInfo.bytes], 'chunk byte size');
  if (expectedByteLength != null && expectedByteLength > MAX_ZARR_CHUNK_BYTES) {
    throw new Error(`Zarr chunk exceeds the ${MAX_ZARR_CHUNK_BYTES}-byte browser limit`);
  }

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
