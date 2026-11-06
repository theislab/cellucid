/**
 * @fileoverview Deterministic ZIP archive for atomic figure-export batches.
 *
 * Batch exports use one stored (uncompressed) ZIP archive so every supported
 * browser receives one download initiated by one user action. Entry bytes are
 * preserved exactly. The archive is the app's one ZIP writer's
 * (`formats/zip/writer.js`: fixed timestamps, ZIP64 fields where a size or
 * offset needs them), and stable input order makes it deterministic for
 * identical filenames and blobs.
 *
 * Each entry is checksummed `CRC_SLICE_BYTES` at a time, read from its Blob
 * slice by slice, and the archive takes the entry Blobs themselves as its
 * parts. The bytes are never copied or held whole, and no slice's checksum
 * (about 2 ms on an M1 Pro) keeps the main thread busy: every slice is a
 * separate task.
 *
 * @module ui/modules/figure-export/utils/zip-archive
 */

import {
  awaitFigureExportAbortable,
  throwIfFigureExportAborted,
} from '../figure-export-contract.js';
import { crc32 } from '../../../../../formats/zip/crc32.js';
import { createZipWriter } from '../../../../../formats/zip/writer.js';

const ENTRY_KEYS = new Set(['filename', 'blob']);
/** Bytes of an entry read and checksummed per task. */
const CRC_SLICE_BYTES = 4 * 1024 * 1024;

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

/**
 * The CRC-32 of a staged Blob, read one slice per task.
 *
 * @param {Blob} blob
 * @param {number} size - the size the entry was planned with
 * @param {AbortSignal|null} signal
 * @returns {Promise<number>}
 */
async function checksumBlob(blob, size, signal) {
  let crc = 0;
  for (let start = 0; start < size; start += CRC_SLICE_BYTES) {
    const end = Math.min(size, start + CRC_SLICE_BYTES);
    const buffer = await awaitFigureExportAbortable(
      signal,
      blob.slice(start, end).arrayBuffer()
    );
    throwIfFigureExportAborted(signal);
    if (buffer.byteLength !== end - start) {
      throw new Error('Figure export ZIP Blob size changed during staging.');
    }
    crc = crc32(new Uint8Array(buffer), crc);
  }
  return crc;
}

/**
 * Create one deterministic, uncompressed ZIP Blob.
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

  const names = new Set();
  entries.forEach((entry, index) => {
    assertExactEntry(entry, index);
    if (names.has(entry.filename)) {
      throw new Error(
        `Figure export ZIP contains duplicate filename "${entry.filename}".`
      );
    }
    names.add(entry.filename);
  });

  const parts = [];
  const zip = createZipWriter({ write: part => { parts.push(part); } });
  for (const entry of entries) {
    throwIfFigureExportAborted(signal);
    const crc = await checksumBlob(entry.blob, entry.blob.size, signal);
    await zip.add(entry.filename, entry.blob, { crc });
  }
  throwIfFigureExportAborted(signal);
  await zip.finish();
  return new Blob(parts, { type: 'application/zip' });
}
