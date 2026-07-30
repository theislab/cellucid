/**
 * @fileoverview Deterministic ZIP32 writer for atomic figure-export batches.
 *
 * Batch exports use one stored (uncompressed) ZIP archive so every supported
 * browser receives one download initiated by one user action. Entry bytes are
 * preserved exactly. Fixed ZIP timestamps and stable input order make the
 * archive deterministic for identical filenames and blobs.
 *
 * @module ui/modules/figure-export/utils/zip-archive
 */

import {
  awaitFigureExportAbortable,
  throwIfFigureExportAborted,
} from '../figure-export-contract.js';

const MAX_U16 = 0xffff;
const MAX_U32 = 0xffff_ffff;
const UTF8_FLAG = 0x0800;
const STORED_METHOD = 0;
const DOS_TIME_MIDNIGHT = 0;
const DOS_DATE_1980_01_01 = 0x0021;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_RECORD_SIZE = 22;
const ENTRY_KEYS = new Set(['filename', 'blob']);

let crcTable = null;

function getCrcTable() {
  if (crcTable !== null) return crcTable;
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1)
        ? (0xedb8_8320 ^ (value >>> 1))
        : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(bytes) {
  const table = getCrcTable();
  let value = 0xffff_ffff;
  for (let index = 0; index < bytes.length; index++) {
    value = table[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function assertExactEntry(entry, index) {
  if (
    entry === null ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    Object.getPrototypeOf(entry) !== Object.prototype
  ) {
    throw new TypeError(`Figure export ZIP entry ${index} must be a plain object.`);
  }
  const keys = Object.keys(entry);
  if (
    keys.length !== ENTRY_KEYS.size ||
    keys.some(key => !ENTRY_KEYS.has(key))
  ) {
    throw new TypeError(
      `Figure export ZIP entry ${index} must contain exactly filename and blob.`
    );
  }
  if (
    typeof entry.filename !== 'string' ||
    entry.filename.length === 0 ||
    entry.filename.includes('\0') ||
    entry.filename.includes('/') ||
    entry.filename.includes('\\')
  ) {
    throw new TypeError(
      `Figure export ZIP entry ${index} filename must be one non-empty basename.`
    );
  }
  if (!(entry.blob instanceof Blob)) {
    throw new TypeError(`Figure export ZIP entry ${index} must contain a Blob.`);
  }
}

function makeLocalHeader({ crc, size, filenameLength }) {
  const header = new Uint8Array(LOCAL_HEADER_SIZE);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x0403_4b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(8, STORED_METHOD, true);
  view.setUint16(10, DOS_TIME_MIDNIGHT, true);
  view.setUint16(12, DOS_DATE_1980_01_01, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, filenameLength, true);
  view.setUint16(28, 0, true);
  return header;
}

function makeCentralHeader({
  crc,
  size,
  filenameLength,
  localOffset,
}) {
  const header = new Uint8Array(CENTRAL_HEADER_SIZE);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x0201_4b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, UTF8_FLAG, true);
  view.setUint16(10, STORED_METHOD, true);
  view.setUint16(12, DOS_TIME_MIDNIGHT, true);
  view.setUint16(14, DOS_DATE_1980_01_01, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, filenameLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, localOffset, true);
  return header;
}

function makeEndRecord({ entryCount, centralSize, centralOffset }) {
  const record = new Uint8Array(END_RECORD_SIZE);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x0605_4b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return record;
}

/**
 * Create one deterministic, uncompressed ZIP32 Blob.
 *
 * @param {{ filename: string; blob: Blob }[]} entries
 * @param {object} [options]
 * @param {AbortSignal|null} [options.signal]
 * @returns {Promise<Blob>}
 */
export async function createFigureExportZip(
  entries,
  { signal = null } = {}
) {
  throwIfFigureExportAborted(signal);
  if (!Array.isArray(entries) || entries.length < 2) {
    throw new TypeError(
      'Figure export ZIP requires at least two staged artifacts.'
    );
  }
  if (entries.length > MAX_U16) {
    throw new RangeError('Figure export ZIP exceeds the ZIP32 entry limit.');
  }

  const encoder = new TextEncoder();
  const names = new Set();
  const plans = entries.map((entry, index) => {
    assertExactEntry(entry, index);
    if (names.has(entry.filename)) {
      throw new Error(
        `Figure export ZIP contains duplicate filename "${entry.filename}".`
      );
    }
    names.add(entry.filename);

    const filenameBytes = encoder.encode(entry.filename);
    if (filenameBytes.length > MAX_U16) {
      throw new RangeError(
        `Figure export ZIP filename ${index} exceeds the ZIP32 limit.`
      );
    }
    if (entry.blob.size > MAX_U32) {
      throw new RangeError(
        `Figure export ZIP entry ${index} exceeds the ZIP32 size limit.`
      );
    }
    return {
      filenameBytes,
      blob: entry.blob,
      size: entry.blob.size,
    };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const plan of plans) {
    localSize += LOCAL_HEADER_SIZE + plan.filenameBytes.length + plan.size;
    centralSize += CENTRAL_HEADER_SIZE + plan.filenameBytes.length;
    if (localSize > MAX_U32 || centralSize > MAX_U32) {
      throw new RangeError('Figure export ZIP exceeds the ZIP32 archive limit.');
    }
  }
  if (localSize + centralSize + END_RECORD_SIZE > MAX_U32) {
    throw new RangeError('Figure export ZIP exceeds the ZIP32 archive limit.');
  }

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const plan of plans) {
    throwIfFigureExportAborted(signal);
    const buffer = await awaitFigureExportAbortable(
      signal,
      plan.blob.arrayBuffer()
    );
    throwIfFigureExportAborted(signal);
    const bytes = new Uint8Array(buffer);
    if (bytes.length !== plan.size) {
      throw new Error('Figure export ZIP Blob size changed during staging.');
    }
    const crc = crc32(bytes);
    localParts.push(
      makeLocalHeader({
        crc,
        size: plan.size,
        filenameLength: plan.filenameBytes.length,
      }),
      plan.filenameBytes,
      bytes,
    );
    centralParts.push(
      makeCentralHeader({
        crc,
        size: plan.size,
        filenameLength: plan.filenameBytes.length,
        localOffset,
      }),
      plan.filenameBytes,
    );
    localOffset += LOCAL_HEADER_SIZE + plan.filenameBytes.length + plan.size;
  }

  throwIfFigureExportAborted(signal);
  return new Blob(
    [
      ...localParts,
      ...centralParts,
      makeEndRecord({
        entryCount: plans.length,
        centralSize,
        centralOffset: localSize,
      }),
    ],
    { type: 'application/zip' },
  );
}
