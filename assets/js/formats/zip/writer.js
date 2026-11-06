/**
 * A ZIP archive written as a stream: every entry stored (no ZIP
 * compression), each entry's bytes handed to the sink as they are added,
 * the central directory and the end records last. The mirror of
 * `archive.js`, which reads what this writes (and every check it makes
 * holds of it).
 *
 * - **Stored entries.** Whatever goes in a store is compressed already (a
 *   Zarr chunk by its codec, a PNG, an SVG a figure export staged); a stored
 *   entry is read with one range request at its offset (`archive.js`
 *   `readRange`). An entry's CRC-32 is computed here from its bytes, or
 *   given by the caller (a `Blob` the caller checksummed slice by slice).
 * - **ZIP64 when, and only where, a field overflows** (APPNOTE 6.3.10,
 *   4.5.3): an entry of 4 GiB or more carries the ZIP64 extra field in its
 *   local header (both sizes) and in its central record; an entry starting
 *   at 4 GiB or more carries its offset in its central record's extra field;
 *   an archive of 65,535 entries or more, or whose central directory starts
 *   or ends past 4 GiB, ends with the ZIP64 end record and its locator
 *   before the classic one, whose overflowing fields hold their maximum.
 *   No size or count limit is set here: an archive is as large as its sink
 *   takes (the File System Access API, a Blob's parts).
 * - **Deterministic bytes.** Every entry is a regular `0644` file of a Unix
 *   writer, dated 1980-01-01 00:00 (the earliest a ZIP carries), with its
 *   name in UTF-8 (flag 11) exactly as given (never normalised: a Zarr
 *   store's keys name its entries byte for byte), two names that are one
 *   once normalised refused: an archive's bytes depend on its entries alone,
 *   as cellucid-python's `_zip_folder` and cellucid-r's writer make them.
 * - **Streaming.** Nothing is held but the central directory being built
 *   (46 bytes, the name and any ZIP64 field per entry, packed into segments
 *   as each entry is added): an entry's bytes go to the sink as soon as they
 *   are added. The sink is `{write(part)}`, `part` a `Uint8Array` (owned by
 *   the sink from then on: never changed or reused by this writer) or a
 *   `Blob`; its promise, when it returns one, is awaited before the next
 *   write, so a slow disk paces the writer.
 *
 * @module formats/zip/writer
 */

import { crc32 } from './crc32.js';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

const LOCAL_BYTES = 30;
const CENTRAL_BYTES = 46;
const END_BYTES = 22;
const ZIP64_END_BYTES = 56;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_EXTRA_ID = 0x0001;

/** A ZIP field of 16 bits holds at most this; the value itself means "see the ZIP64 record". */
const UINT16_MAX = 0xffff;
/** A ZIP field of 32 bits holds at most this; the value itself means "see the ZIP64 field". */
const UINT32_MAX = 0xffffffff;

/** Version 2.0 (stored entries, folders); 4.5 where any ZIP64 field is written. */
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
/** Made by a Unix writer (high byte 3), as Python's `zipfile` and R's writer mark entries. */
const MADE_BY_UNIX = 3 << 8;
/** A regular file, mode 0644, in the high 16 bits of the external attributes. */
const REGULAR_FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;
/** General-purpose flag 11: the name is UTF-8. */
const UTF8_FLAG = 0x0800;
const STORED = 0;
/** 1980-01-01 in MS-DOS date form; 00:00 is time 0. */
const DOS_DATE_1980_01_01 = 0x0021;
const DOS_TIME_MIDNIGHT = 0;

/** Bytes of each segment the central directory is packed into as it grows. */
const DIRECTORY_SEGMENT_BYTES = 1024 * 1024;

const encoder = new TextEncoder();

/** Write a whole number of up to 64 bits (safe integers only) at `offset`. */
function setUint64(view, offset, value) {
  view.setUint32(offset, value % 0x1_0000_0000, true);
  view.setUint32(offset + 4, Math.floor(value / 0x1_0000_0000), true);
}

/** The ZIP64 extra field holding `values` (each 8 bytes), or an empty field. */
function zip64Extra(values) {
  if (values.length === 0) return new Uint8Array(0);
  const extra = new Uint8Array(4 + 8 * values.length);
  const view = new DataView(extra.buffer);
  view.setUint16(0, ZIP64_EXTRA_ID, true);
  view.setUint16(2, 8 * values.length, true);
  values.forEach((value, index) => setUint64(view, 4 + 8 * index, value));
  return extra;
}

/**
 * The name of an entry as stored: a relative `/`-separated path with no
 * empty, `.` or `..` part, no backslash and no control character (what
 * `names.js` `entryPath` refuses to read), in UTF-8, at most 65,535 bytes.
 */
function nameBytesOf(path) {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(path) || /^[A-Za-z]:/.test(path)) {
    throw new TypeError(`'${path}' cannot name a ZIP entry: an entry is named by a relative path.`);
  }
  const parts = path.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new TypeError(`'${path}' cannot name a ZIP entry: no part of its path may be empty, '.' or '..'.`);
  }
  // The name exactly as given: a reader matches it against the names the
  // archive's own documents use (a Zarr store's keys), byte for byte.
  const bytes = encoder.encode(path);
  if (bytes.length > UINT16_MAX) throw new RangeError(`The ZIP entry name '${path.slice(0, 40)}…' is longer than a ZIP name field holds (65,535 bytes).`);
  return bytes;
}

/** The local header of a stored entry, with its name (and ZIP64 sizes when it needs them). */
function localHeader(nameBytes, crc, size) {
  const large = size >= UINT32_MAX;
  const extra = zip64Extra(large ? [size, size] : []);
  const header = new Uint8Array(LOCAL_BYTES + nameBytes.length + extra.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, LOCAL_SIGNATURE, true);
  view.setUint16(4, large ? VERSION_ZIP64 : VERSION_DEFAULT, true);
  view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(8, STORED, true);
  view.setUint16(10, DOS_TIME_MIDNIGHT, true);
  view.setUint16(12, DOS_DATE_1980_01_01, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, large ? UINT32_MAX : size, true);
  view.setUint32(22, large ? UINT32_MAX : size, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, extra.length, true);
  header.set(nameBytes, LOCAL_BYTES);
  header.set(extra, LOCAL_BYTES + nameBytes.length);
  return header;
}

/** The central-directory record of a stored entry: ZIP64 fields for its size and offset where they overflow. */
function centralRecord(nameBytes, crc, size, offset) {
  const largeSize = size >= UINT32_MAX;
  const largeOffset = offset >= UINT32_MAX;
  // The overflowing fields, in the specification's order: size, compressed size, offset.
  const extra = zip64Extra([...(largeSize ? [size, size] : []), ...(largeOffset ? [offset] : [])]);
  const version = largeSize || largeOffset ? VERSION_ZIP64 : VERSION_DEFAULT;
  const record = new Uint8Array(CENTRAL_BYTES + nameBytes.length + extra.length);
  const view = new DataView(record.buffer);
  view.setUint32(0, CENTRAL_SIGNATURE, true);
  view.setUint16(4, MADE_BY_UNIX | version, true);
  view.setUint16(6, version, true);
  view.setUint16(8, UTF8_FLAG, true);
  view.setUint16(10, STORED, true);
  view.setUint16(12, DOS_TIME_MIDNIGHT, true);
  view.setUint16(14, DOS_DATE_1980_01_01, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, largeSize ? UINT32_MAX : size, true);
  view.setUint32(24, largeSize ? UINT32_MAX : size, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, extra.length, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, REGULAR_FILE_ATTRIBUTES, true);
  view.setUint32(42, largeOffset ? UINT32_MAX : offset, true);
  record.set(nameBytes, CENTRAL_BYTES);
  record.set(extra, CENTRAL_BYTES + nameBytes.length);
  return record;
}

/**
 * The end of the archive after a central directory of `entries` records,
 * `size` bytes at `offset`: the ZIP64 end record and its locator when any
 * classic field overflows, then the classic record.
 */
function endRecords(entries, size, offset) {
  const zip64 = entries >= UINT16_MAX || size >= UINT32_MAX || offset >= UINT32_MAX;
  const end = new Uint8Array((zip64 ? ZIP64_END_BYTES + ZIP64_LOCATOR_BYTES : 0) + END_BYTES);
  const view = new DataView(end.buffer);
  let at = 0;
  if (zip64) {
    view.setUint32(0, ZIP64_END_SIGNATURE, true);
    // The record's size after its first 12 bytes.
    setUint64(view, 4, ZIP64_END_BYTES - 12);
    view.setUint16(12, MADE_BY_UNIX | VERSION_ZIP64, true);
    view.setUint16(14, VERSION_ZIP64, true);
    view.setUint32(16, 0, true);
    view.setUint32(20, 0, true);
    setUint64(view, 24, entries);
    setUint64(view, 32, entries);
    setUint64(view, 40, size);
    setUint64(view, 48, offset);
    view.setUint32(56, ZIP64_LOCATOR_SIGNATURE, true);
    view.setUint32(60, 0, true);
    setUint64(view, 64, offset + size);
    view.setUint32(72, 1, true);
    at = ZIP64_END_BYTES + ZIP64_LOCATOR_BYTES;
  }
  view.setUint32(at, END_SIGNATURE, true);
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, 0, true);
  view.setUint16(at + 8, Math.min(entries, UINT16_MAX), true);
  view.setUint16(at + 10, Math.min(entries, UINT16_MAX), true);
  view.setUint32(at + 12, Math.min(size, UINT32_MAX), true);
  view.setUint32(at + 16, Math.min(offset, UINT32_MAX), true);
  view.setUint16(at + 20, 0, true);
  return end;
}

/**
 * @typedef {Object} ZipSink
 * @property {(part: Uint8Array|Blob) => (void|Promise<void>)} write
 *   One more part of the archive, in order. A `Uint8Array` is the sink's from
 *   then on (transfer it, keep it); the writer never touches it again.
 */

/**
 * @typedef {Object} ZipWriter
 * @property {(path: string, data: Uint8Array|Blob, options?: {crc?: number|null}) => Promise<void>} add
 *   One stored entry. `crc`, when given, is the CRC-32 of `data` (required
 *   for a `Blob`, whose bytes are not read here). A `Uint8Array` is handed to
 *   the sink as it is: the caller gives it up.
 * @property {() => Promise<{bytes: number, entries: number, zip64: boolean}>} finish
 *   The central directory and the end records; the archive is then whole.
 * @property {number} bytes - Bytes handed to the sink so far
 * @property {number} entries - Entries added so far
 */

/**
 * A ZIP archive written to `sink` as entries are added.
 *
 * @param {ZipSink} sink
 * @returns {ZipWriter}
 */
export function createZipWriter(sink) {
  if (sink === null || typeof sink !== 'object' || typeof sink.write !== 'function') {
    throw new TypeError('A ZIP writer writes to a sink with write(part).');
  }
  let offset = 0;
  let count = 0;
  let finished = false;
  /** Paths added, by their normalised form, so no entry is named twice (`archive.js` refuses an archive that has one). */
  const paths = new Map();
  /** The central directory, packed into segments of `DIRECTORY_SEGMENT_BYTES`. */
  const directory = [];
  let segment = new Uint8Array(DIRECTORY_SEGMENT_BYTES);
  let segmentUsed = 0;
  let directoryBytes = 0;
  /** A write under way: entries are added one at a time, in order. */
  let queue = Promise.resolve();

  function keepRecord(record) {
    if (record.length > segment.length - segmentUsed) {
      if (segmentUsed > 0) directory.push(segment.subarray(0, segmentUsed));
      segment = new Uint8Array(Math.max(DIRECTORY_SEGMENT_BYTES, record.length));
      segmentUsed = 0;
    }
    segment.set(record, segmentUsed);
    segmentUsed += record.length;
    directoryBytes += record.length;
  }

  async function write(part) {
    const size = part instanceof Blob ? part.size : part.byteLength;
    await sink.write(part);
    offset += size;
  }

  function add(path, data, { crc = null } = {}) {
    if (finished) return Promise.reject(new Error('The ZIP archive is finished: no entry can be added.'));
    const isBlob = typeof Blob !== 'undefined' && data instanceof Blob;
    if (!isBlob && !(data instanceof Uint8Array)) return Promise.reject(new TypeError('A ZIP entry holds a Uint8Array or a Blob.'));
    if (isBlob && !Number.isInteger(crc)) return Promise.reject(new TypeError('A Blob entry needs its CRC-32 (crc).'));
    let nameBytes;
    try {
      nameBytes = nameBytesOf(path);
    } catch (error) {
      return Promise.reject(error);
    }
    // Two names that are one once normalised (NFC) are one entry to a reader
    // that normalises (`names.js` `entryPath`, macOS's unzip): refused.
    const key = path.normalize('NFC');
    if (paths.has(key)) {
      return Promise.reject(new Error(paths.get(key) === path
        ? `The ZIP archive already has an entry '${path}'.`
        : `The ZIP entry '${path}' is the entry '${paths.get(key)}' written in another Unicode form; readers that normalise names would take them for one.`));
    }
    paths.set(key, path);
    const run = queue.then(async () => {
      const size = isBlob ? data.size : data.byteLength;
      const checksum = crc ?? crc32(data);
      const at = offset;
      await write(localHeader(nameBytes, checksum, size));
      if (size > 0) await write(data);
      keepRecord(centralRecord(nameBytes, checksum, size, at));
      count++;
    });
    // A failed write fails this entry and every later one: the archive is broken.
    queue = run;
    return run;
  }

  async function finish() {
    if (finished) throw new Error('The ZIP archive is finished already.');
    finished = true;
    await queue;
    if (segmentUsed > 0) directory.push(segment.subarray(0, segmentUsed));
    const start = offset;
    for (const part of directory) await write(part);
    const end = endRecords(count, directoryBytes, start);
    await write(end);
    directory.length = 0;
    return { bytes: offset, entries: count, zip64: end.length > END_BYTES };
  }

  return {
    add,
    finish,
    get bytes() {
      return offset;
    },
    get entries() {
      return count;
    },
  };
}
