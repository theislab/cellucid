/**
 * Safe, lazy ZIP indexing for browser-loaded Zarr v2 stores.
 *
 * Directory pickers may omit dotfiles on some engines. A ZIP keeps Zarr's
 * required .zgroup/.zarray/.zattrs entries visible to an ordinary file picker,
 * while this adapter presents them through ZarrLoader.openFileMap's existing
 * file-like contract.
 */

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const MAX_EOCD_SEARCH_BYTES =
  END_OF_CENTRAL_DIRECTORY_BYTES + MAX_ZIP_COMMENT_BYTES;

const MAX_ZIP_ARCHIVE_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES = 32 * 1024 * 1024;
const MAX_ZIP64_END_RECORD_BYTES = 64 * 1024;
const MAX_ZIP_ENTRIES = 200_000;
const MAX_ZIP_PATH_BYTES = 4096;
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024 + 64 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 64n * 1024n * 1024n * 1024n;

const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const ENCRYPTION_FLAGS = 0x2041;
const ZIP64_UINT16 = 0xffff;
const ZIP64_UINT32 = 0xffffffff;
const ZIP64_EXTRA_FIELD_ID = 0x0001;

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const textDecoder = new TextDecoder();
const zipEntryExtractionWorkingBytes = new WeakMap();

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function asUint8Array(value, label) {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`${label} must be an ArrayBuffer or typed-array view`);
}

function exactArrayBuffer(bytes) {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  );
}

/**
 * Model the archive-only peak while one entry is materialized. Stored entries
 * retain only their payload buffer. Raw-DEFLATE entries retain the compressed
 * payload while stream output is copied into pieces and those pieces are
 * joined into the returned buffer.
 *
 * @param {{method: number, compressedSize: number, uncompressedSize: number}} record
 * @returns {bigint}
 */
export function estimateZarrZipEntryExtractionWorkingBytes(record) {
  if (!record || typeof record !== 'object' ||
      !Number.isSafeInteger(record.compressedSize) ||
      record.compressedSize < 0 ||
      !Number.isSafeInteger(record.uncompressedSize) ||
      record.uncompressedSize < 0 ||
      (record.method !== 0 && record.method !== 8)) {
    throw new Error('Invalid ZIP entry extraction plan');
  }
  const compressedBytes = BigInt(record.compressedSize);
  const uncompressedBytes = BigInt(record.uncompressedSize);
  return record.method === 8
    ? compressedBytes + (2n * uncompressedBytes)
    : uncompressedBytes;
}

/**
 * Return the archive-only extraction peak attached to a file-like value
 * produced by readZarrZipArchive(). Ordinary File objects return zero.
 *
 * @param {Object} file
 * @returns {bigint}
 */
export function getZarrZipEntryExtractionWorkingBytes(file) {
  return zipEntryExtractionWorkingBytes.get(file) ?? 0n;
}

function validateReadRange(size, start, length, label) {
  if (!Number.isSafeInteger(start) || start < 0 ||
      !Number.isSafeInteger(length) || length < 0 ||
      start > size || length > size - start) {
    throw new Error(`Invalid ${label} range in ZIP archive`);
  }
}

function createRandomAccessReader(source) {
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    const sourceBytes = asUint8Array(source, 'ZIP source');
    return {
      size: sourceBytes.byteLength,
      name: '',
      async read(start, length, label = 'ZIP') {
        validateReadRange(sourceBytes.byteLength, start, length, label);
        return sourceBytes.slice(start, start + length);
      }
    };
  }

  if (!source || !Number.isSafeInteger(source.size) || source.size < 0 ||
      typeof source.slice !== 'function') {
    throw new TypeError(
      'Zarr ZIP source must be a Blob, File, ArrayBuffer, or typed-array view'
    );
  }

  return {
    size: source.size,
    name: typeof source.name === 'string' ? source.name : '',
    async read(start, length, label = 'ZIP') {
      validateReadRange(source.size, start, length, label);
      const part = source.slice(start, start + length);
      if (!part || typeof part.arrayBuffer !== 'function') {
        throw new TypeError('ZIP Blob slices must support arrayBuffer()');
      }
      const buffer = await part.arrayBuffer();
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== length) {
        throw new Error(`Short ${label} read in ZIP archive`);
      }
      return new Uint8Array(buffer);
    }
  };
}

function readUint16(view, offset) {
  return view.getUint16(offset, true);
}

function readUint32(view, offset) {
  return view.getUint32(offset, true);
}

function readSafeUint64(view, offset, label) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the browser safe-integer range`);
  }
  return Number(value);
}

async function findEndOfCentralDirectory(reader) {
  if (reader.size < END_OF_CENTRAL_DIRECTORY_BYTES) {
    throw new Error('Invalid ZIP archive: end-of-central-directory record is missing');
  }
  if (reader.size > MAX_ZIP_ARCHIVE_BYTES) {
    throw new Error(
      `ZIP archive exceeds the ${MAX_ZIP_ARCHIVE_BYTES}-byte browser limit`
    );
  }

  const tailLength = Math.min(reader.size, MAX_EOCD_SEARCH_BYTES);
  const tailOffset = reader.size - tailLength;
  const tail = await reader.read(tailOffset, tailLength, 'ZIP footer');
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  for (let offset = tailLength - END_OF_CENTRAL_DIRECTORY_BYTES;
       offset >= 0;
       offset--) {
    if (readUint32(view, offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }
    const commentLength = readUint16(view, offset + 20);
    if (offset + END_OF_CENTRAL_DIRECTORY_BYTES + commentLength !== tailLength) {
      continue;
    }
    return {
      offset: tailOffset + offset,
      diskNumber: readUint16(view, offset + 4),
      centralDirectoryDisk: readUint16(view, offset + 6),
      entriesOnDisk: readUint16(view, offset + 8),
      entryCount: readUint16(view, offset + 10),
      centralDirectorySize: readUint32(view, offset + 12),
      centralDirectoryOffset: readUint32(view, offset + 16)
    };
  }

  throw new Error('Invalid ZIP archive: end-of-central-directory record is missing');
}

function classicFieldMatches(classicValue, sentinel, zip64Value) {
  return classicValue === sentinel || classicValue === zip64Value;
}

async function resolveCentralDirectoryFooter(reader, footer) {
  const needsZip64 =
    footer.entriesOnDisk === ZIP64_UINT16 ||
    footer.entryCount === ZIP64_UINT16 ||
    footer.centralDirectorySize === ZIP64_UINT32 ||
    footer.centralDirectoryOffset === ZIP64_UINT32;
  if (!needsZip64) {
    return {
      ...footer,
      centralDirectoryEnd: footer.offset,
      zip64: false
    };
  }

  const locatorOffset = footer.offset - 20;
  if (locatorOffset < 0) {
    throw new Error('Invalid ZIP64 archive: end-of-central-directory locator is missing');
  }
  const locator = await reader.read(
    locatorOffset,
    20,
    'ZIP64 end-of-central-directory locator'
  );
  const locatorView = new DataView(
    locator.buffer,
    locator.byteOffset,
    locator.byteLength
  );
  if (readUint32(locatorView, 0) !==
      ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE) {
    throw new Error('Invalid ZIP64 archive: end-of-central-directory locator is missing');
  }
  const zip64Disk = readUint32(locatorView, 4);
  const zip64Offset = readSafeUint64(
    locatorView,
    8,
    'ZIP64 end-of-central-directory offset'
  );
  const diskCount = readUint32(locatorView, 16);
  if (zip64Disk !== 0 || diskCount !== 1) {
    throw new Error('Multi-disk ZIP archives are not supported');
  }
  if (zip64Offset > locatorOffset - 56) {
    throw new Error('Invalid ZIP64 end-of-central-directory offset');
  }

  const record = await reader.read(
    zip64Offset,
    56,
    'ZIP64 end-of-central-directory record'
  );
  const view = new DataView(
    record.buffer,
    record.byteOffset,
    record.byteLength
  );
  if (readUint32(view, 0) !== ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
    throw new Error('Invalid ZIP64 end-of-central-directory record');
  }
  const remainingRecordSize = readSafeUint64(
    view,
    4,
    'ZIP64 end-of-central-directory record size'
  );
  const totalRecordSize = remainingRecordSize + 12;
  if (remainingRecordSize < 44 ||
      totalRecordSize > MAX_ZIP64_END_RECORD_BYTES ||
      zip64Offset + totalRecordSize !== locatorOffset) {
    throw new Error('Invalid ZIP64 end-of-central-directory record size');
  }

  const diskNumber = readUint32(view, 16);
  const centralDirectoryDisk = readUint32(view, 20);
  const entriesOnDisk = readSafeUint64(
    view,
    24,
    'ZIP64 entries-on-disk count'
  );
  const entryCount = readSafeUint64(view, 32, 'ZIP64 entry count');
  const centralDirectorySize = readSafeUint64(
    view,
    40,
    'ZIP64 central-directory size'
  );
  const centralDirectoryOffset = readSafeUint64(
    view,
    48,
    'ZIP64 central-directory offset'
  );
  if (!classicFieldMatches(
        footer.entriesOnDisk,
        ZIP64_UINT16,
        entriesOnDisk
      ) ||
      !classicFieldMatches(
        footer.entryCount,
        ZIP64_UINT16,
        entryCount
      ) ||
      !classicFieldMatches(
        footer.centralDirectorySize,
        ZIP64_UINT32,
        centralDirectorySize
      ) ||
      !classicFieldMatches(
        footer.centralDirectoryOffset,
        ZIP64_UINT32,
        centralDirectoryOffset
      )) {
    throw new Error('ZIP64 metadata contradicts the classic ZIP footer');
  }
  return {
    ...footer,
    diskNumber,
    centralDirectoryDisk,
    entriesOnDisk,
    entryCount,
    centralDirectorySize,
    centralDirectoryOffset,
    centralDirectoryEnd: zip64Offset,
    zip64: true
  };
}

function decodeEntryName(nameBytes, flags) {
  if (nameBytes.byteLength === 0 ||
      nameBytes.byteLength > MAX_ZIP_PATH_BYTES) {
    throw new Error(
      `Unsafe ZIP entry path: names must contain 1-${MAX_ZIP_PATH_BYTES} bytes`
    );
  }

  if ((flags & UTF8_FLAG) !== 0) {
    try {
      return utf8Decoder.decode(nameBytes);
    } catch (error) {
      throw new Error('Unsafe ZIP entry path: invalid UTF-8 filename', {
        cause: error
      });
    }
  }

  let result = '';
  for (const byte of nameBytes) {
    if (byte > 0x7f) {
      throw new Error(
        'Unsupported non-UTF-8 ZIP filename; recreate the archive with UTF-8 paths'
      );
    }
    result += String.fromCharCode(byte);
  }
  return result;
}

function validateEntryPath(path) {
  if (!path || path.includes('\\') || path.startsWith('/') ||
      /^[A-Za-z]:\//.test(path) ||
      /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error(`Unsafe ZIP entry path '${path}'`);
  }

  const isDirectory = path.endsWith('/');
  const pathWithoutTrailingSlash = isDirectory ? path.slice(0, -1) : path;
  const segments = pathWithoutTrailingSlash.split('/');
  if (segments.length === 0 ||
      segments.some(segment =>
        segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe ZIP entry path '${path}'`);
  }

  const normalized = segments
    .map(segment => segment.normalize('NFC'))
    .join('/');
  return {
    path: isDirectory ? `${normalized}/` : normalized,
    isDirectory
  };
}

function validateEntryType(versionMadeBy, externalAttributes, path) {
  const hostSystem = versionMadeBy >>> 8;
  if (hostSystem !== 3) return;
  const mode = externalAttributes >>> 16;
  const fileType = mode & 0xf000;
  if (fileType !== 0 && fileType !== 0x4000 && fileType !== 0x8000) {
    throw new Error(
      `Unsupported special or symbolic-link ZIP entry '${path}'`
    );
  }
}

function findExtraField(extraBytes, fieldId, path) {
  const view = new DataView(
    extraBytes.buffer,
    extraBytes.byteOffset,
    extraBytes.byteLength
  );
  let cursor = 0;
  let match = null;
  while (cursor < extraBytes.byteLength) {
    if (cursor > extraBytes.byteLength - 4) {
      throw new Error(`Truncated ZIP extra field for '${path}'`);
    }
    const currentId = readUint16(view, cursor);
    const fieldLength = readUint16(view, cursor + 2);
    cursor += 4;
    if (fieldLength > extraBytes.byteLength - cursor) {
      throw new Error(`Truncated ZIP extra field for '${path}'`);
    }
    if (currentId === fieldId) {
      if (match) {
        throw new Error(`Duplicate ZIP64 extra field for '${path}'`);
      }
      match = extraBytes.subarray(cursor, cursor + fieldLength);
    }
    cursor += fieldLength;
  }
  return match;
}

function resolveCentralZip64Fields(
  extraBytes,
  path,
  compressedSize32,
  uncompressedSize32,
  localHeaderOffset32,
  diskStart16
) {
  const needsZip64 =
    compressedSize32 === ZIP64_UINT32 ||
    uncompressedSize32 === ZIP64_UINT32 ||
    localHeaderOffset32 === ZIP64_UINT32 ||
    diskStart16 === ZIP64_UINT16;
  if (!needsZip64) {
    return {
      compressedSize: compressedSize32,
      uncompressedSize: uncompressedSize32,
      localHeaderOffset: localHeaderOffset32,
      diskStart: diskStart16
    };
  }

  const field = findExtraField(extraBytes, ZIP64_EXTRA_FIELD_ID, path);
  if (!field) {
    throw new Error(`ZIP64 entry '${path}' is missing its 0x0001 extra field`);
  }
  const view = new DataView(field.buffer, field.byteOffset, field.byteLength);
  let cursor = 0;
  const read64 = label => {
    if (cursor > field.byteLength - 8) {
      throw new Error(`Truncated ZIP64 ${label} for '${path}'`);
    }
    const value = readSafeUint64(view, cursor, `ZIP64 ${label} for '${path}'`);
    cursor += 8;
    return value;
  };
  const uncompressedSize =
    uncompressedSize32 === ZIP64_UINT32
      ? read64('uncompressed size')
      : uncompressedSize32;
  const compressedSize =
    compressedSize32 === ZIP64_UINT32
      ? read64('compressed size')
      : compressedSize32;
  const localHeaderOffset =
    localHeaderOffset32 === ZIP64_UINT32
      ? read64('local-header offset')
      : localHeaderOffset32;
  let diskStart = diskStart16;
  if (diskStart16 === ZIP64_UINT16) {
    if (cursor > field.byteLength - 4) {
      throw new Error(`Truncated ZIP64 disk number for '${path}'`);
    }
    diskStart = readUint32(view, cursor);
    cursor += 4;
  }
  if (cursor !== field.byteLength) {
    throw new Error(`Unexpected data in ZIP64 extra field for '${path}'`);
  }
  return {
    compressedSize,
    uncompressedSize,
    localHeaderOffset,
    diskStart
  };
}

function validateCentralDirectoryRecord({
  flags,
  method,
  compressedSize,
  uncompressedSize,
  localHeaderOffset,
  diskStart,
  path
}, centralDirectoryOffset) {
  if (diskStart !== 0) {
    throw new Error('Multi-disk ZIP archives are not supported');
  }
  if ((flags & ENCRYPTION_FLAGS) !== 0) {
    throw new Error(
      `Encrypted ZIP entries are not supported ('${path}')`
    );
  }
  if (method !== 0 && method !== 8) {
    throw new Error(
      `Unsupported ZIP compression method ${method} for '${path}'; use stored or deflate entries`
    );
  }
  if (compressedSize > MAX_ZIP_ENTRY_BYTES) {
    throw new Error(
      `ZIP entry '${path}' compressed size exceeds the ${MAX_ZIP_ENTRY_BYTES}-byte browser limit`
    );
  }
  if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
    throw new Error(
      `ZIP entry '${path}' uncompressed size exceeds the ${MAX_ZIP_ENTRY_BYTES}-byte browser limit`
    );
  }
  if (method === 0 && compressedSize !== uncompressedSize) {
    throw new Error(
      `Stored ZIP entry '${path}' has contradictory compressed and uncompressed sizes`
    );
  }
  if (path.endsWith('/') &&
      (compressedSize !== 0 || uncompressedSize !== 0)) {
    throw new Error(`ZIP directory entry '${path}' must be empty`);
  }
  if (localHeaderOffset > centralDirectoryOffset - 30) {
    throw new Error(`ZIP entry '${path}' has an invalid local-header offset`);
  }
}

async function parseCentralDirectory(reader) {
  const classicFooter = await findEndOfCentralDirectory(reader);
  const footer = await resolveCentralDirectoryFooter(
    reader,
    classicFooter
  );
  if (footer.diskNumber !== 0 ||
      footer.centralDirectoryDisk !== 0 ||
      footer.entriesOnDisk !== footer.entryCount) {
    throw new Error('Multi-disk ZIP archives are not supported');
  }
  if (footer.entryCount === 0) {
    throw new Error('ZIP archive contains no entries');
  }
  if (footer.entryCount > MAX_ZIP_ENTRIES) {
    throw new Error(
      `ZIP archive contains more than ${MAX_ZIP_ENTRIES} entries`
    );
  }
  if (footer.centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new Error(
      `ZIP central directory exceeds the ${MAX_CENTRAL_DIRECTORY_BYTES}-byte browser limit`
    );
  }
  if (footer.centralDirectoryOffset > footer.centralDirectoryEnd ||
      footer.centralDirectorySize !==
        footer.centralDirectoryEnd - footer.centralDirectoryOffset) {
    throw new Error('Invalid ZIP central-directory bounds');
  }

  const bytes = await reader.read(
    footer.centralDirectoryOffset,
    footer.centralDirectorySize,
    'ZIP central directory'
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = [];
  const paths = new Set();
  const localOffsets = new Set();
  let cursor = 0;
  let totalUncompressedBytes = 0n;

  for (let entryIndex = 0; entryIndex < footer.entryCount; entryIndex++) {
    if (cursor > bytes.byteLength - 46 ||
        readUint32(view, cursor) !== CENTRAL_FILE_SIGNATURE) {
      throw new Error(
        `Invalid ZIP central-directory entry ${entryIndex + 1}`
      );
    }

    const versionMadeBy = readUint16(view, cursor + 4);
    const flags = readUint16(view, cursor + 8);
    const method = readUint16(view, cursor + 10);
    const checksum = readUint32(view, cursor + 16);
    const compressedSize32 = readUint32(view, cursor + 20);
    const uncompressedSize32 = readUint32(view, cursor + 24);
    const nameLength = readUint16(view, cursor + 28);
    const extraLength = readUint16(view, cursor + 30);
    const commentLength = readUint16(view, cursor + 32);
    const diskStart16 = readUint16(view, cursor + 34);
    const externalAttributes = readUint32(view, cursor + 38);
    const localHeaderOffset32 = readUint32(view, cursor + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (recordLength > bytes.byteLength - cursor) {
      throw new Error(
        `Truncated ZIP central-directory entry ${entryIndex + 1}`
      );
    }

    const rawName = bytes.slice(cursor + 46, cursor + 46 + nameLength);
    const decodedName = decodeEntryName(rawName, flags);
    const { path, isDirectory } = validateEntryPath(decodedName);
    const extraBytes = bytes.subarray(
      cursor + 46 + nameLength,
      cursor + 46 + nameLength + extraLength
    );
    const {
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      diskStart
    } = resolveCentralZip64Fields(
      extraBytes,
      path,
      compressedSize32,
      uncompressedSize32,
      localHeaderOffset32,
      diskStart16
    );
    const record = {
      versionMadeBy,
      flags,
      method,
      checksum,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      diskStart,
      rawName,
      path,
      isDirectory
    };
    validateCentralDirectoryRecord(record, footer.centralDirectoryOffset);
    validateEntryType(versionMadeBy, externalAttributes, path);

    if (paths.has(path)) {
      throw new Error(`Duplicate ZIP entry '${path}'`);
    }
    paths.add(path);
    if (!isDirectory) {
      if (localOffsets.has(localHeaderOffset)) {
        throw new Error(
          `ZIP entries cannot share local-header offset ${localHeaderOffset}`
        );
      }
      localOffsets.add(localHeaderOffset);
      totalUncompressedBytes += BigInt(uncompressedSize);
      if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        throw new Error(
          'ZIP archive declared uncompressed size exceeds the 64 GiB browser limit'
        );
      }
      records.push(record);
    }
    cursor += recordLength;
  }

  if (cursor !== bytes.byteLength) {
    throw new Error('Unexpected data after ZIP central-directory entries');
  }
  return {
    records,
    centralDirectoryOffset: footer.centralDirectoryOffset
  };
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function resolveLocalZip64Sizes(
  extraBytes,
  path,
  compressedSize32,
  uncompressedSize32
) {
  const needsZip64 =
    compressedSize32 === ZIP64_UINT32 ||
    uncompressedSize32 === ZIP64_UINT32;
  if (!needsZip64) {
    return {
      compressedSize: compressedSize32,
      uncompressedSize: uncompressedSize32
    };
  }
  const field = findExtraField(extraBytes, ZIP64_EXTRA_FIELD_ID, path);
  if (!field) {
    throw new Error(
      `ZIP64 local header for '${path}' is missing its 0x0001 extra field`
    );
  }
  const view = new DataView(field.buffer, field.byteOffset, field.byteLength);
  let cursor = 0;
  const read64 = label => {
    if (cursor > field.byteLength - 8) {
      throw new Error(`Truncated ZIP64 local ${label} for '${path}'`);
    }
    const value = readSafeUint64(
      view,
      cursor,
      `ZIP64 local ${label} for '${path}'`
    );
    cursor += 8;
    return value;
  };
  const uncompressedSize =
    uncompressedSize32 === ZIP64_UINT32
      ? read64('uncompressed size')
      : uncompressedSize32;
  const compressedSize =
    compressedSize32 === ZIP64_UINT32
      ? read64('compressed size')
      : compressedSize32;
  if (cursor !== field.byteLength) {
    throw new Error(
      `Unexpected data in ZIP64 local extra field for '${path}'`
    );
  }
  return { compressedSize, uncompressedSize };
}

function createGzipEnvelopeParts(compressed, checksum, expectedSize) {
  const header = Uint8Array.of(
    0x1f, 0x8b, // gzip signature
    0x08,       // DEFLATE
    0x00,       // no optional header fields
    0x00, 0x00, 0x00, 0x00, // deterministic modification time
    0x00,       // no compression-level claim
    0xff        // unknown operating system
  );
  const trailer = new Uint8Array(8);
  const trailerView = new DataView(trailer.buffer);
  trailerView.setUint32(0, checksum, true);
  trailerView.setUint32(4, expectedSize >>> 0, true);
  return [header, compressed, trailer];
}

async function browserInflateRaw(
  compressed,
  { expectedSize, checksum, path }
) {
  if (typeof globalThis.DecompressionStream !== 'function' ||
      typeof globalThis.Blob !== 'function') {
    throw new Error(
      `This browser cannot decompress deflate ZIP entry '${path}'. ` +
      'A current browser with gzip DecompressionStream support is required.'
    );
  }

  let decompressor;
  try {
    decompressor = new globalThis.DecompressionStream('gzip');
  } catch (error) {
    throw new Error(
      `This browser cannot decompress deflate ZIP entry '${path}'. ` +
      'A current browser with gzip DecompressionStream support is required.',
      { cause: error }
    );
  }

  let stream;
  try {
    stream = new globalThis.Blob(
      createGzipEnvelopeParts(compressed, checksum, expectedSize)
    )
      .stream()
      .pipeThrough(decompressor);
  } catch (error) {
    throw new Error(`Failed to start ZIP decompression for '${path}'`, {
      cause: error
    });
  }

  const reader = stream.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = asUint8Array(value, 'DecompressionStream output');
      if (chunk.byteLength > expectedSize - totalBytes) {
        await reader.cancel();
        throw new Error(
          `ZIP entry '${path}' decompressed beyond its declared size`
        );
      }
      chunks.push(chunk.slice());
      totalBytes += chunk.byteLength;
    }
  } catch (error) {
    if (error?.message?.includes(`ZIP entry '${path}'`)) throw error;
    throw new Error(`Failed to decompress ZIP entry '${path}'`, {
      cause: error
    });
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readEntryBytes(
  reader,
  record,
  internalPath,
  centralDirectoryOffset,
  inflateRaw
) {
  const header = await reader.read(
    record.localHeaderOffset,
    30,
    `local header for '${internalPath}'`
  );
  const view = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength
  );
  if (readUint32(view, 0) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`Invalid local header for ZIP entry '${internalPath}'`);
  }

  const localFlags = readUint16(view, 6);
  const localMethod = readUint16(view, 8);
  const localChecksum = readUint32(view, 14);
  const localCompressedSize32 = readUint32(view, 18);
  const localUncompressedSize32 = readUint32(view, 22);
  const localNameLength = readUint16(view, 26);
  const localExtraLength = readUint16(view, 28);
  if (localFlags !== record.flags || localMethod !== record.method) {
    throw new Error(
      `ZIP local header contradicts the central directory for '${internalPath}'`
    );
  }

  const localVariableFields = await reader.read(
    record.localHeaderOffset + 30,
    localNameLength + localExtraLength,
    `local name and extra fields for '${internalPath}'`
  );
  const localName = localVariableFields.subarray(0, localNameLength);
  const localExtra = localVariableFields.subarray(localNameLength);
  if (!bytesEqual(localName, record.rawName)) {
    throw new Error(
      `ZIP local header name does not match the central directory for '${internalPath}'`
    );
  }

  if ((record.flags & DATA_DESCRIPTOR_FLAG) === 0) {
    const {
      compressedSize: localCompressedSize,
      uncompressedSize: localUncompressedSize
    } = resolveLocalZip64Sizes(
      localExtra,
      internalPath,
      localCompressedSize32,
      localUncompressedSize32
    );
    if (localChecksum !== record.checksum ||
        localCompressedSize !== record.compressedSize ||
        localUncompressedSize !== record.uncompressedSize) {
      throw new Error(
        `ZIP local header sizes or CRC contradict the central directory for '${internalPath}'`
      );
    }
  }

  const dataOffset =
    record.localHeaderOffset + 30 + localNameLength + localExtraLength;
  if (!Number.isSafeInteger(dataOffset) ||
      dataOffset > centralDirectoryOffset ||
      record.compressedSize > centralDirectoryOffset - dataOffset) {
    throw new Error(
      `ZIP entry '${internalPath}' payload overlaps the central directory`
    );
  }
  const compressed = await reader.read(
    dataOffset,
    record.compressedSize,
    `payload for '${internalPath}'`
  );

  let result;
  if (record.method === 0) {
    result = compressed;
  } else {
    const inflated = await inflateRaw(compressed, {
      expectedSize: record.uncompressedSize,
      checksum: record.checksum,
      path: internalPath
    });
    result = asUint8Array(inflated, `Inflater result for '${internalPath}'`);
  }

  if (result.byteLength !== record.uncompressedSize) {
    throw new Error(
      `ZIP entry '${internalPath}' decompressed size ${result.byteLength} ` +
      `does not match declared size ${record.uncompressedSize}`
    );
  }
  if (crc32(result) !== record.checksum) {
    throw new Error(`CRC-32 mismatch for ZIP entry '${internalPath}'`);
  }
  return result;
}

function deriveArchiveRoot(records, archiveName) {
  if (records.length === 0) {
    throw new Error('ZIP archive contains no file entries');
  }

  const rootMarkers = new Set(['.zgroup', '.zarray']);
  let prefix = '';
  if (!records.some(record => rootMarkers.has(record.path))) {
    const firstSegments = new Set();
    for (const record of records) {
      const separator = record.path.indexOf('/');
      if (separator <= 0) {
        throw new Error(
          'ZIP archive does not contain Zarr v2 root metadata (.zgroup or .zarray)'
        );
      }
      firstSegments.add(record.path.slice(0, separator));
    }
    if (firstSegments.size !== 1) {
      throw new Error(
        'ZIP archive must contain exactly one Zarr root directory'
      );
    }
    prefix = `${firstSegments.values().next().value}/`;
  }

  const strippedPaths = records.map(record =>
    prefix ? record.path.slice(prefix.length) : record.path
  );
  if (!strippedPaths.some(path => rootMarkers.has(path))) {
    throw new Error(
      'ZIP archive does not contain Zarr v2 root metadata (.zgroup or .zarray)'
    );
  }
  if (strippedPaths.some(path => path === '' || path.startsWith('/'))) {
    throw new Error('ZIP archive contains an invalid Zarr root entry');
  }

  let rootName;
  if (prefix) {
    rootName = prefix.slice(0, -1);
  } else {
    const normalizedName = String(archiveName || '')
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      .replace(/\.zip$/i, '');
    rootName = normalizedName || 'archive';
    if (!/\.zarr$/i.test(rootName)) rootName += '.zarr';
  }
  return { prefix, rootName, strippedPaths };
}

function isMacOSAncillaryRecord(record) {
  const segments = record.path.split('/');
  return segments[0] === '__MACOSX' ||
    segments[segments.length - 1] === '.DS_Store';
}

function createFileLike(
  reader,
  record,
  internalPath,
  rootName,
  centralDirectoryOffset,
  inflateRaw
) {
  const file = Object.freeze({
    name: internalPath.split('/').pop(),
    webkitRelativePath: `${rootName}/${internalPath}`,
    size: record.uncompressedSize,
    async arrayBuffer() {
      const bytes = await readEntryBytes(
        reader,
        record,
        internalPath,
        centralDirectoryOffset,
        inflateRaw
      );
      return exactArrayBuffer(bytes);
    },
    async text() {
      const buffer = await this.arrayBuffer();
      return textDecoder.decode(buffer);
    }
  });
  zipEntryExtractionWorkingBytes.set(
    file,
    estimateZarrZipEntryExtractionWorkingBytes(record)
  );
  return file;
}

/**
 * Index a classic ZIP containing exactly one Zarr v2 store.
 *
 * The archive is read lazily when `source` is a Blob/File: only the bounded
 * footer and central directory are loaded during indexing, and each entry is
 * read/decompressed when its file-like `arrayBuffer()` or `text()` is called.
 *
 * Integration:
 * `const { files, rootName } = await readZarrZipArchive(file);`
 * `await zarrLoader.openFileMap(files, rootName);`
 *
 * @param {Blob|ArrayBuffer|ArrayBufferView} source
 * @param {Object} [options]
 * @param {string} [options.archiveName] Name used for a rootless archive.
 * @param {(compressed: Uint8Array, context: {
 *   expectedSize: number, checksum: number, path: string
 * }) =>
 *   Promise<ArrayBuffer|ArrayBufferView>|ArrayBuffer|ArrayBufferView}
 *   [options.inflateRaw] Test/host raw-DEFLATE implementation. Browsers frame
 *   the ZIP-owned raw stream as one gzip member and use
 *   DecompressionStream('gzip') when omitted.
 * @returns {Promise<{files: Map<string, Object>, rootName: string}>}
 */
export async function readZarrZipArchive(source, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Zarr ZIP options must be an object');
  }
  if (options.inflateRaw != null &&
      typeof options.inflateRaw !== 'function') {
    throw new TypeError('inflateRaw must be a function when provided');
  }
  if (options.archiveName != null &&
      typeof options.archiveName !== 'string') {
    throw new TypeError('archiveName must be a string when provided');
  }

  const reader = createRandomAccessReader(source);
  const { records, centralDirectoryOffset } =
    await parseCentralDirectory(reader);
  const archiveName = options.archiveName ?? reader.name;
  const storeRecords = records.filter(record =>
    !isMacOSAncillaryRecord(record)
  );
  const { rootName, strippedPaths } =
    deriveArchiveRoot(storeRecords, archiveName);
  const inflateRaw = options.inflateRaw ?? browserInflateRaw;
  const files = new Map();

  for (let index = 0; index < storeRecords.length; index++) {
    const internalPath = strippedPaths[index];
    if (files.has(internalPath)) {
      throw new Error(`Duplicate ZIP entry '${internalPath}'`);
    }
    files.set(
      internalPath,
      createFileLike(
        reader,
        storeRecords[index],
        internalPath,
        rootName,
        centralDirectoryOffset,
        inflateRaw
      )
    );
  }
  return { files, rootName };
}
