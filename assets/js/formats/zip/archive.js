/**
 * A ZIP archive read in place, through a byte reader.
 *
 * Opening reads the end of the file once: the end-of-central-directory record
 * (and its ZIP64 extension), and with it, for most archives, the whole
 * central directory. Nothing else is read until an entry is asked for, so the
 * same code serves a local `File` and a remote archive read with HTTP range
 * requests. Entries lying in that end are served from it: an archive no
 * longer than it (256 KiB) is read once, in one request, and a larger one's
 * last entries cost no request.
 *
 * Reading an entry costs one range: its local header and its bytes are
 * fetched together, sized from the central directory plus the entry's
 * central extra field (the usual size of its local one); a local header that
 * turns out longer costs one more read. Entries read in the same task go out
 * together, and the byte reader merges neighbours into one request and runs
 * the rest in parallel.
 *
 * Every entry is checked before its bytes are returned: the local header must
 * agree with the central directory, a deflated entry must inflate to exactly
 * its declared size (inflation stops at that size, so a DEFLATE bomb cannot
 * grow memory), and the result must match its CRC-32. The archive itself is
 * checked when opened: entries must lie inside it, before the central
 * directory, without overlapping; paths must be relative and unique; a
 * declared size must be one DEFLATE can produce from the stored bytes.
 * Encrypted entries, compression methods other than stored and deflate, and
 * archives split over several disks are refused with `ZipUnsupportedError`.
 *
 * Bytes before the archive (a self-extracting stub, a prefix) are allowed:
 * the offsets the central directory records are corrected by where it really
 * starts.
 *
 * @module formats/zip/archive
 */

import { inflate } from '../io/inflate.js';
import { crc32 } from './crc32.js';
import { ZipFormatError, ZipUnsupportedError } from './errors.js';
import { decodeEntryName, entryPath, isMacOSMetadata } from './names.js';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

const END_BYTES = 22;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_END_BYTES = 56;
const CENTRAL_BYTES = 46;
const LOCAL_BYTES = 30;
const MAX_COMMENT_BYTES = 0xffff;

const DATA_DESCRIPTOR_FLAG = 0x0008;
/** Traditional encryption (bit 0), strong encryption (6), masked header (13). */
const ENCRYPTION_FLAGS = 0x2041;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const ZIP64_EXTRA_ID = 0x0001;

/**
 * The end of the file read when an archive opens: the footer (at most 64 KiB
 * of comment) and, in the same request, the central directory of most
 * archives. A larger directory is read with one more request.
 */
const TAIL_BYTES = 256 * 1024;

/**
 * DEFLATE's largest expansion: one 258-byte match per two bits, 1032 output
 * bytes per input byte (RFC 1951). An entry declaring more is not real.
 */
const DEFLATE_MAX_EXPANSION = 1032;

const STORED = 0;
const DEFLATED = 8;

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function uint64(dataView, offset, what) {
  const value = dataView.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipFormatError(`The archive's ${what} is larger than any file this browser can address.`);
  }
  return Number(value);
}

/** The bytes `[start, start + length)` of the file, from `tail` when it holds them. */
async function bytesAt(reader, tail, tailStart, start, length, io) {
  if (start >= tailStart && start + length <= tailStart + tail.length) {
    return tail.subarray(start - tailStart, start - tailStart + length);
  }
  return reader.read(start, length, io);
}

/** The end-of-central-directory record, searched from the end of `tail`. */
function findEnd(tail, tailStart, label) {
  const data = view(tail);
  const lowest = Math.max(0, tail.length - END_BYTES - MAX_COMMENT_BYTES);
  for (let at = tail.length - END_BYTES; at >= lowest; at--) {
    if (data.getUint32(at, true) !== END_SIGNATURE) continue;
    const commentLength = data.getUint16(at + 20, true);
    // A signature inside the comment is not the record: the real one's
    // comment ends exactly at the end of the file.
    if (at + END_BYTES + commentLength !== tail.length) continue;
    return {
      offset: tailStart + at,
      disk: data.getUint16(at + 4, true),
      directoryDisk: data.getUint16(at + 6, true),
      entriesOnDisk: data.getUint16(at + 8, true),
      entries: data.getUint16(at + 10, true),
      directorySize: data.getUint32(at + 12, true),
      directoryOffset: data.getUint32(at + 16, true),
      comment: tail.slice(at + END_BYTES, at + END_BYTES + commentLength),
    };
  }
  throw new ZipFormatError(`${label} is not a ZIP archive, or its end is missing (no end-of-central-directory record).`);
}

function refuseMultiDisk(label) {
  return new ZipUnsupportedError(
    'multi-disk archive',
    `${label} is one part of an archive split over several files; join the parts into one ZIP first.`
  );
}

/**
 * Resolve the footer: its ZIP64 extension when any field overflowed, and
 * where the central directory really starts (bytes may precede the archive).
 */
async function resolveFooter(reader, tail, tailStart, end, label, io) {
  const zip64 = end.entriesOnDisk === UINT16_MAX || end.entries === UINT16_MAX ||
    end.directorySize === UINT32_MAX || end.directoryOffset === UINT32_MAX;
  if (!zip64) {
    if (end.disk !== 0 || end.directoryDisk !== 0 || end.entriesOnDisk !== end.entries) throw refuseMultiDisk(label);
    const start = end.offset - end.directorySize;
    if (start < 0 || start < end.directoryOffset) {
      throw new ZipFormatError(`${label}: the central directory does not fit before the end record.`);
    }
    return {
      entries: end.entries,
      directoryStart: start,
      directorySize: end.directorySize,
      shift: start - end.directoryOffset,
    };
  }
  const locatorOffset = end.offset - ZIP64_LOCATOR_BYTES;
  if (locatorOffset < 0) throw new ZipFormatError(`${label}: the ZIP64 end-of-central-directory locator is missing.`);
  const locator = view(await bytesAt(reader, tail, tailStart, locatorOffset, ZIP64_LOCATOR_BYTES, io));
  if (locator.getUint32(0, true) !== ZIP64_LOCATOR_SIGNATURE) {
    throw new ZipFormatError(`${label}: the ZIP64 end-of-central-directory locator is missing.`);
  }
  if (locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) !== 1) throw refuseMultiDisk(label);
  const declared = uint64(locator, 8, 'ZIP64 end-record offset');
  // The record usually ends at the locator; with a prefix before the
  // archive, it is found there rather than at its declared offset.
  let recordOffset = declared;
  let record = null;
  for (const candidate of [declared, locatorOffset - ZIP64_END_BYTES]) {
    if (candidate < 0 || candidate + ZIP64_END_BYTES > locatorOffset) continue;
    const bytes = view(await bytesAt(reader, tail, tailStart, candidate, ZIP64_END_BYTES, io));
    if (bytes.getUint32(0, true) === ZIP64_END_SIGNATURE) {
      recordOffset = candidate;
      record = bytes;
      break;
    }
  }
  if (record === null) throw new ZipFormatError(`${label}: the ZIP64 end-of-central-directory record is missing.`);
  const recordSize = uint64(record, 4, 'ZIP64 end-record size') + 12;
  if (recordSize < ZIP64_END_BYTES || recordOffset + recordSize !== locatorOffset) {
    throw new ZipFormatError(`${label}: the ZIP64 end-of-central-directory record has an invalid size.`);
  }
  const disk = record.getUint32(16, true);
  const directoryDisk = record.getUint32(20, true);
  const entriesOnDisk = uint64(record, 24, 'entry count');
  const entries = uint64(record, 32, 'entry count');
  const directorySize = uint64(record, 40, 'central directory size');
  const directoryOffset = uint64(record, 48, 'central directory offset');
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entries) throw refuseMultiDisk(label);
  const agrees = (classic, max, value) => classic === max || classic === value;
  if (!agrees(end.entries, UINT16_MAX, entries) || !agrees(end.entriesOnDisk, UINT16_MAX, entriesOnDisk) ||
      !agrees(end.directorySize, UINT32_MAX, directorySize)) {
    throw new ZipFormatError(`${label}: the ZIP64 end record contradicts the classic one.`);
  }
  const start = recordOffset - directorySize;
  if (start < 0 || start < directoryOffset) {
    throw new ZipFormatError(`${label}: the central directory does not fit before the end record.`);
  }
  return { entries, directoryStart: start, directorySize, shift: start - directoryOffset };
}

/** The data of extra field `id` in `extra`, or null. */
function extraField(extra, id, path) {
  const data = view(extra);
  let found = null;
  for (let at = 0; at < extra.length;) {
    if (at + 4 > extra.length) throw new ZipFormatError(`The extra field of '${path}' is truncated.`);
    const fieldId = data.getUint16(at, true);
    const length = data.getUint16(at + 2, true);
    if (at + 4 + length > extra.length) throw new ZipFormatError(`The extra field of '${path}' is truncated.`);
    if (fieldId === id) {
      if (found !== null) throw new ZipFormatError(`'${path}' has two ZIP64 extra fields.`);
      found = extra.subarray(at + 4, at + 4 + length);
    }
    at += 4 + length;
  }
  return found;
}

/**
 * The 64-bit values a ZIP64 extra field holds for the 32-bit fields that
 * overflowed, in the specification's order.
 */
function zip64Values(extra, path, fields) {
  if (!fields.some(field => field.overflowed)) return fields.map(field => field.value);
  const data = extraField(extra, ZIP64_EXTRA_ID, path);
  if (data === null) throw new ZipFormatError(`'${path}' needs a ZIP64 extra field and has none.`);
  const dataView = view(data);
  let at = 0;
  return fields.map(field => {
    if (!field.overflowed) return field.value;
    const bytes = field.bytes ?? 8;
    if (at + bytes > data.length) throw new ZipFormatError(`The ZIP64 extra field of '${path}' is truncated.`);
    const value = bytes === 8 ? uint64(dataView, at, `size of '${path}'`) : dataView.getUint32(at, true);
    at += bytes;
    return value;
  });
}

/** Parse every central-directory record. */
function parseDirectory(bytes, footer, label) {
  const data = view(bytes);
  const records = [];
  const byPath = new Map();
  const dataLimit = footer.directoryStart;
  let at = 0;
  for (let index = 0; index < footer.entries; index++) {
    if (at + CENTRAL_BYTES > bytes.length || data.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new ZipFormatError(`${label}: central-directory entry ${index + 1} is damaged.`);
    }
    const versionMadeBy = data.getUint16(at + 4, true);
    const flags = data.getUint16(at + 8, true);
    const method = data.getUint16(at + 10, true);
    const checksum = data.getUint32(at + 16, true);
    const compressed32 = data.getUint32(at + 20, true);
    const size32 = data.getUint32(at + 24, true);
    const nameLength = data.getUint16(at + 28, true);
    const extraLength = data.getUint16(at + 30, true);
    const commentLength = data.getUint16(at + 32, true);
    const disk16 = data.getUint16(at + 34, true);
    const externalAttributes = data.getUint32(at + 38, true);
    const offset32 = data.getUint32(at + 42, true);
    const recordLength = CENTRAL_BYTES + nameLength + extraLength + commentLength;
    if (at + recordLength > bytes.length) {
      throw new ZipFormatError(`${label}: central-directory entry ${index + 1} is truncated.`);
    }
    const nameBytes = bytes.slice(at + CENTRAL_BYTES, at + CENTRAL_BYTES + nameLength);
    const name = decodeEntryName(nameBytes, flags);
    const { path, isDirectory } = entryPath(name);
    const extra = bytes.subarray(at + CENTRAL_BYTES + nameLength, at + CENTRAL_BYTES + nameLength + extraLength);
    const [size, compressedSize, declaredOffset, disk] = zip64Values(extra, path, [
      { value: size32, overflowed: size32 === UINT32_MAX },
      { value: compressed32, overflowed: compressed32 === UINT32_MAX },
      { value: offset32, overflowed: offset32 === UINT32_MAX },
      { value: disk16, overflowed: disk16 === UINT16_MAX, bytes: 4 },
    ]);
    at += recordLength;

    if (disk !== 0) throw refuseMultiDisk(label);
    if (byPath.has(path)) throw new ZipFormatError(`${label} has two entries named '${path}'.`);
    byPath.set(path, true);
    if (isDirectory) {
      if (size !== 0 || compressedSize !== 0) {
        throw new ZipFormatError(`${label}: the folder entry '${path}' holds data.`);
      }
      continue;
    }
    if ((flags & ENCRYPTION_FLAGS) !== 0) {
      throw new ZipUnsupportedError('encryption', `${label}: '${path}' is encrypted; encrypted ZIP entries cannot be read.`);
    }
    if (method !== STORED && method !== DEFLATED) {
      throw new ZipUnsupportedError(
        `compression method ${method}`,
        `${label}: '${path}' uses ZIP compression method ${method}; only stored and deflate entries can be read. Create the archive again with standard (deflate) compression.`
      );
    }
    // Unix symbolic links and devices are not files of the archive.
    if ((versionMadeBy >>> 8) === 3) {
      const type = (externalAttributes >>> 16) & 0xf000;
      if (type !== 0 && type !== 0x8000 && type !== 0x4000) {
        throw new ZipUnsupportedError('symbolic link', `${label}: '${path}' is a symbolic link or special file, not a file.`);
      }
    }
    if (method === STORED && size !== compressedSize) {
      throw new ZipFormatError(`${label}: the stored entry '${path}' declares two different sizes.`);
    }
    if (method === DEFLATED && size > compressedSize * DEFLATE_MAX_EXPANSION + 64) {
      throw new ZipFormatError(
        `${label}: '${path}' declares ${size} bytes, more than DEFLATE can produce from ${compressedSize}.`
      );
    }
    const offset = declaredOffset + footer.shift;
    if (offset + LOCAL_BYTES + nameLength + compressedSize > dataLimit) {
      throw new ZipFormatError(`${label}: '${path}' declares more bytes than the archive holds.`);
    }
    records.push({
      path, nameBytes, flags, method, checksum, size, compressedSize, offset, extraLength, dataOffset: null,
    });
  }
  if (at !== bytes.length) throw new ZipFormatError(`${label}: unexpected bytes follow the central directory.`);

  // Entries may not share or overlap bytes (overlapping entries are how a
  // small archive pretends to hold far more than it does).
  const byOffset = records.slice().sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < byOffset.length; i++) {
    const previous = byOffset[i - 1];
    if (previous.offset + LOCAL_BYTES + previous.nameBytes.length + previous.compressedSize > byOffset[i].offset) {
      throw new ZipFormatError(`${label}: the entries '${previous.path}' and '${byOffset[i].path}' overlap.`);
    }
  }
  return records;
}

/**
 * Check an entry's local header against the central directory and return
 * where its data starts, relative to the header. `header` holds at least the
 * fixed header and the name.
 */
function checkLocalHeader(record, header, label) {
  const data = view(header);
  if (header.length < LOCAL_BYTES || data.getUint32(0, true) !== LOCAL_SIGNATURE) {
    throw new ZipFormatError(`${label}: the local header of '${record.path}' is missing.`);
  }
  const flags = data.getUint16(6, true);
  const method = data.getUint16(8, true);
  const nameLength = data.getUint16(26, true);
  const extraLength = data.getUint16(28, true);
  if (method !== record.method || (flags & ENCRYPTION_FLAGS) !== 0) {
    throw new ZipFormatError(`${label}: the local header of '${record.path}' contradicts the central directory.`);
  }
  if (nameLength !== record.nameBytes.length || header.length < LOCAL_BYTES + nameLength) {
    throw new ZipFormatError(`${label}: the local header name of '${record.path}' does not match the central directory.`);
  }
  const name = header.subarray(LOCAL_BYTES, LOCAL_BYTES + nameLength);
  for (let i = 0; i < nameLength; i++) {
    if (name[i] !== record.nameBytes[i]) {
      throw new ZipFormatError(`${label}: the local header name of '${record.path}' does not match the central directory.`);
    }
  }
  return { dataStart: LOCAL_BYTES + nameLength + extraLength, flags, extraLength };
}

/**
 * Check the sizes and CRC a local header repeats (absent when the entry was
 * written with a data descriptor). `header` holds the whole local header.
 */
function checkLocalSizes(record, header, local, label) {
  if (((local.flags | record.flags) & DATA_DESCRIPTOR_FLAG) !== 0) return;
  const data = view(header);
  const checksum = data.getUint32(14, true);
  const compressed32 = data.getUint32(18, true);
  const size32 = data.getUint32(22, true);
  const extra = header.subarray(LOCAL_BYTES + record.nameBytes.length, local.dataStart);
  const [size, compressedSize] = zip64Values(extra, record.path, [
    { value: size32, overflowed: size32 === UINT32_MAX },
    { value: compressed32, overflowed: compressed32 === UINT32_MAX },
  ]);
  if (checksum !== record.checksum || size !== record.size || compressedSize !== record.compressedSize) {
    throw new ZipFormatError(`${label}: the local header of '${record.path}' contradicts the central directory's sizes or CRC.`);
  }
}

/**
 * @typedef {Object} ZipEntry
 * @property {string} path - Normalised, relative, `/`-separated
 * @property {number} size - Bytes once decompressed
 * @property {number} compressedSize - Bytes stored in the archive
 * @property {number} method - 0 (stored) or 8 (deflate)
 * @property {number} crc32
 * @property {(options?: {signal?: AbortSignal|null, activity?: Object|null}) => Promise<Uint8Array>} read
 *   The whole entry, checked. A stored entry may be a view into a buffer
 *   shared with neighbouring reads: copy what is kept.
 * @property {(offset: number, length: number, options?: {signal?: AbortSignal|null, activity?: Object|null}) => Promise<Uint8Array>} readRange
 *   Bytes `[offset, offset + length)` of the entry. A stored entry reads only
 *   that range (no CRC can cover a part); a deflated one is read whole.
 */

/**
 * @typedef {Object} ZipArchive
 * @property {string} name
 * @property {number} size - Bytes of the archive file
 * @property {string} comment
 * @property {ReadonlyArray<ZipEntry>} entries - File entries, in central-directory order
 * @property {(path: string) => (ZipEntry|null)} entry
 * @property {() => Object} stats - The byte reader's transfer counts
 */

/**
 * Open a ZIP archive.
 *
 * @param {import('../io/byte-reader.js').ByteReader} reader
 * @param {{name?: string, verifyCrc?: boolean, signal?: AbortSignal|null, activity?: Object|null}} [options]
 *   `verifyCrc` (default true) checks every whole-entry read against its CRC-32.
 *   `signal` and `activity` are passed to every read of the byte reader, here
 *   and in each entry's `read` / `readRange` options.
 * @returns {Promise<ZipArchive>}
 */
export async function openZipArchive(reader, { name, verifyCrc = true, signal = null, activity = null } = {}) {
  if (reader === null || typeof reader !== 'object' || typeof reader.read !== 'function' ||
      !Number.isSafeInteger(reader.size)) {
    throw new TypeError('openZipArchive reads through a byte reader (createByteReader).');
  }
  const label = name ?? reader.name ?? 'The archive';
  if (reader.size < END_BYTES) {
    throw new ZipFormatError(`${label} is not a ZIP archive: it is too short to hold one.`);
  }
  const tailLength = Math.min(reader.size, TAIL_BYTES);
  const tailStart = reader.size - tailLength;
  const io = { signal, activity };
  const tail = await reader.read(tailStart, tailLength, io);
  const end = findEnd(tail, tailStart, label);
  const footer = await resolveFooter(reader, tail, tailStart, end, label, io);
  if (footer.directorySize < footer.entries * CENTRAL_BYTES) {
    throw new ZipFormatError(`${label}: the central directory is too small for its ${footer.entries} entries.`);
  }
  const directory = await bytesAt(reader, tail, tailStart, footer.directoryStart, footer.directorySize, io);
  const records = parseDirectory(directory, footer, label);
  const dataLimit = footer.directoryStart;

  /**
   * Bytes of the archive: from the end read at open when they lie in it (a
   * small archive is read once, whole; a large one's last entries cost
   * nothing more), else through the byte reader.
   */
  const readAt = (offset, length, options) => bytesAt(reader, tail, tailStart, offset, length, options);

  async function localHeader(record, options) {
    const length = Math.min(dataLimit - record.offset, LOCAL_BYTES + record.nameBytes.length + record.extraLength);
    // Read exactly the header: it is read once per entry (its data offset is
    // kept), so caching the block around it would only cost bandwidth.
    let header = await readAt(record.offset, length, options);
    const local = checkLocalHeader(record, header, label);
    if (local.dataStart > header.length) {
      if (record.offset + local.dataStart > dataLimit) {
        throw new ZipFormatError(`${label}: the local header of '${record.path}' runs into the central directory.`);
      }
      header = await readAt(record.offset, local.dataStart, options);
    }
    return { header, local };
  }

  function placeData(record, local) {
    const dataOffset = record.offset + local.dataStart;
    if (dataOffset + record.compressedSize > dataLimit) {
      throw new ZipFormatError(`${label}: the data of '${record.path}' runs into the central directory.`);
    }
    record.dataOffset = dataOffset;
  }

  /** The stored (possibly compressed) bytes of an entry, checked. */
  async function storedBytes(record, options) {
    if (record.dataOffset !== null) return readAt(record.dataOffset, record.compressedSize, options);
    // One range: local header (sized like the central extra field) and data.
    const guess = LOCAL_BYTES + record.nameBytes.length + record.extraLength;
    const length = Math.min(dataLimit - record.offset, guess + record.compressedSize);
    const bytes = await readAt(record.offset, length, options);
    const local = checkLocalHeader(record, bytes, label);
    placeData(record, local);
    if (local.dataStart + record.compressedSize <= bytes.length) {
      checkLocalSizes(record, bytes, local, label);
      return bytes.subarray(local.dataStart, local.dataStart + record.compressedSize);
    }
    // The local extra field is longer than the central one.
    const header = local.dataStart <= bytes.length ? bytes : (await localHeader(record, options)).header;
    checkLocalSizes(record, header, local, label);
    return readAt(record.dataOffset, record.compressedSize, options);
  }

  async function decode(record, stored) {
    if (record.method === STORED) return stored;
    try {
      return await inflate(stored, {
        format: 'deflate-raw',
        expectedSize: record.size,
        label: `${label}: '${record.path}'`,
      });
    } catch (cause) {
      if (cause?.name === 'InflateError') throw new ZipFormatError(cause.message, { cause });
      throw cause;
    }
  }

  function makeEntry(record) {
    async function read({ signal: entrySignal = null, activity: entryActivity = null } = {}) {
      const options = { signal: entrySignal, activity: entryActivity };
      const bytes = await decode(record, await storedBytes(record, options));
      if (verifyCrc && crc32(bytes) !== record.checksum) {
        throw new ZipFormatError(`${label}: '${record.path}' is damaged (its CRC-32 does not match).`);
      }
      return bytes;
    }

    async function readRange(offset, length, { signal: rangeSignal = null, activity: rangeActivity = null } = {}) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
          offset + length > record.size) {
        throw new RangeError(`${label}: cannot read ${length} bytes at ${offset} of '${record.path}' (${record.size} bytes).`);
      }
      const options = { signal: rangeSignal, activity: rangeActivity };
      if (record.method !== STORED) return (await read(options)).subarray(offset, offset + length);
      if (record.dataOffset === null) {
        // Read the header and, assuming its extra field is as long as the
        // central one, the range itself, in parallel: one round trip.
        const guess = record.offset + LOCAL_BYTES + record.nameBytes.length + record.extraLength;
        const speculative = guess + offset + length <= dataLimit
          ? readAt(guess + offset, length, options)
          : null;
        speculative?.catch(() => {});
        const { header, local } = await localHeader(record, options);
        checkLocalSizes(record, header, local, label);
        placeData(record, local);
        if (speculative !== null && record.dataOffset === guess) return speculative;
      }
      return readAt(record.dataOffset + offset, length, options);
    }

    return Object.freeze({
      path: record.path,
      size: record.size,
      compressedSize: record.compressedSize,
      method: record.method,
      crc32: record.checksum,
      read,
      readRange,
    });
  }

  const entries = Object.freeze(records.map(makeEntry));
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  return Object.freeze({
    name: label,
    size: reader.size,
    comment: new TextDecoder().decode(end.comment),
    entries,
    entry: path => byPath.get(path) ?? null,
    stats: () => reader.stats(),
  });
}

/**
 * The entries below `prefix` (a folder path ending in `/`, or `''` for the
 * whole archive), keyed by their path relative to it. Metadata macOS adds
 * when zipping a folder is left out.
 *
 * @param {ZipArchive} archive
 * @param {string} [prefix]
 * @returns {Map<string, ZipEntry>}
 */
export function entryMap(archive, prefix = '') {
  const map = new Map();
  for (const entry of archive.entries) {
    if (isMacOSMetadata(entry.path) || !entry.path.startsWith(prefix)) continue;
    map.set(entry.path.slice(prefix.length), entry);
  }
  return map;
}

/**
 * The one top-level folder every entry lies in (a zipped folder), or null
 * when entries sit at the top level or in several folders. macOS metadata is
 * not counted.
 *
 * @param {ZipArchive} archive
 * @returns {string|null}
 */
export function singleRootFolder(archive) {
  let root = null;
  for (const entry of archive.entries) {
    if (isMacOSMetadata(entry.path)) continue;
    const slash = entry.path.indexOf('/');
    if (slash < 0) return null;
    const folder = entry.path.slice(0, slash);
    if (root === null) root = folder;
    else if (root !== folder) return null;
  }
  return root;
}
