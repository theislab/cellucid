/**
 * A kept journal's records: what the downloaded parts of a remote file are
 * kept as (`formats/io/kept-parts.js`). A journal is the one kind of kept
 * directory written as it grows (`space.js` `openKeptJournal`): each piece
 * of bytes is appended to its `d.bin`, then a record of it to its `j.bin`,
 * framed by its length and CRC-32 and carrying the piece's page checksums;
 * whoever opens it later reads its records as far as they are whole
 * (`parseKeptJournal`). Every function here is pure: none reads or writes
 * storage.
 *
 * **The code fingerprint of kept parts covers this module**, with
 * `kept-format.js` and the page checksums
 * (`scripts/kept-code-fingerprints.mjs`); no other kind's does. A change to
 * its code (comments aside) makes this browser remove the parts it kept and
 * download them again as they are read; files downloaded whole, converted
 * stores and gene indexes stay.
 *
 * @module data/anndata/transcode/kept-journal
 */

import { CHECK_PAGE_BYTES, checksumOf, pageChecksumsOf } from '../../../formats/io/page-checks.js';
import { allocateTypedArray } from '../../sparse-column-index.js';

/** What a file's kept parts are filed under (`space.js` keeps every journal of it under this). */
export function keptPartsIdentity(identity, size) {
  return { parts: identity, size };
}

/** What a journal's keeper says of it, as its manifest holds it: its contents are its records, not a list of files. */
export const journalSaid = said => ({ ...said, journal: true });

/** Whether a manifest is a kept journal's (its contents are its records, not a list of files). */
export const isJournal = manifest => manifest?.journal === true;

/** What a record of a kept journal is (its first byte). */
const RECORD_RANGE = 1;
const RECORD_OBJECT = 2;
const RECORD_CONFIRMED = 3;
const RECORD_ABSENT = 4;

/** A record's frame: its body's length and its body's CRC-32, before the body. */
const RECORD_FRAME_BYTES = 8;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** One framed record of `type`, its body written by `write(view, at)` after the type byte. */
function framedRecord(type, bodyBytes, write) {
  const out = allocateTypedArray(Uint8Array, RECORD_FRAME_BYTES + bodyBytes, 'A kept journal record');
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, bodyBytes, true);
  out[RECORD_FRAME_BYTES] = type;
  write(view, RECORD_FRAME_BYTES + 1);
  view.setUint32(4, checksumOf(out.subarray(RECORD_FRAME_BYTES)), true);
  return out;
}

/**
 * The record of a piece of an object's bytes kept: the object (`''`, a
 * file), where the piece starts in it, where its bytes are in `d.bin`, how
 * many there are, and the CRC-32 of each `CHECK_PAGE_BYTES` of them (from
 * the piece's first byte), against which every read of them is checked.
 */
export function rangeRecord(key, start, offset, bytes) {
  const name = utf8.encode(key);
  const sums = pageChecksumsOf(bytes);
  return framedRecord(RECORD_RANGE, 1 + 24 + 4 + name.length + 4 * sums.length, (view, at) => {
    view.setFloat64(at, start, true);
    view.setFloat64(at + 8, offset, true);
    view.setFloat64(at + 16, bytes.length, true);
    view.setUint32(at + 24, name.length, true);
    new Uint8Array(view.buffer, view.byteOffset + at + 28, name.length).set(name);
    for (let i = 0, to = at + 28 + name.length; i < sums.length; i++, to += 4) view.setUint32(to, sums[i], true);
  });
}

/** The record of what an object's host said of it: its exact size (−1: not known) and validator (its ETag or date). */
export function objectRecord(key, { size = null, validator = null }) {
  const name = utf8.encode(key);
  const tag = utf8.encode(validator ?? '');
  return framedRecord(RECORD_OBJECT, 1 + 4 + name.length + 8 + 1 + 4 + tag.length, (view, at) => {
    view.setUint32(at, name.length, true);
    new Uint8Array(view.buffer, view.byteOffset + at + 4, name.length).set(name);
    const to = at + 4 + name.length;
    view.setFloat64(to, Number.isSafeInteger(size) && size >= 0 ? size : -1, true);
    view.setUint8(to + 8, validator === null ? 0 : 1);
    view.setUint32(to + 9, tag.length, true);
    new Uint8Array(view.buffer, view.byteOffset + to + 13, tag.length).set(tag);
  });
}

/** The record of an object of a folder its host answered as absent (404, 410): under a content name, it stays absent. */
export function absentRecord(key) {
  const name = utf8.encode(key);
  return framedRecord(RECORD_ABSENT, 1 + 4 + name.length, (view, at) => {
    view.setUint32(at, name.length, true);
    new Uint8Array(view.buffer, view.byteOffset + at + 4, name.length).set(name);
  });
}

/**
 * The record that every range recorded before it is confirmed (a source
 * whose reads name no version: its provider confirmed the version still
 * holds).
 */
export function confirmedRecord() {
  return framedRecord(RECORD_CONFIRMED, 1, () => {});
}

/**
 * The records of a kept journal, read from its bytes in order, as far as
 * they are whole and what they say holds: reading stops at the first record
 * that is cut short (a write the browser or the machine stopped), does not
 * match its CRC-32, or names bytes `d.bin` (of `dataSize` bytes) does not
 * hold. `confirmed`: how many of the first ranges a confirmation follows
 * (`confirmedRecord`); `absent`: the objects of a folder its host answered
 * as absent (`absentRecord`).
 *
 * @param {Uint8Array} bytes - The journal's records
 * @param {number} dataSize - The bytes of its `d.bin`
 * @returns {{ranges: Array<{key: string, start: number, offset: number, length: number, sums: Uint32Array}>,
 *   objects: Map<string, {size: number|null, validator: string|null}>, absent: Set<string>, confirmed: number}}
 */
export function parseKeptJournal(bytes, dataSize) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ranges = [];
  const objects = new Map();
  const absent = new Set();
  let confirmed = 0;
  let at = 0;
  const safe = value => Number.isSafeInteger(value) && value >= 0;
  while (at + RECORD_FRAME_BYTES < bytes.length) {
    const bodyBytes = view.getUint32(at, true);
    const end = at + RECORD_FRAME_BYTES + bodyBytes;
    if (bodyBytes < 1 || end > bytes.length) break;
    const body = bytes.subarray(at + RECORD_FRAME_BYTES, end);
    if (checksumOf(body) !== view.getUint32(at + 4, true)) break;
    const type = body[0];
    const from = at + RECORD_FRAME_BYTES + 1;
    if (type === RECORD_RANGE) {
      if (bodyBytes < 29) break;
      const start = view.getFloat64(from, true);
      const offset = view.getFloat64(from + 8, true);
      const length = view.getFloat64(from + 16, true);
      const nameBytes = view.getUint32(from + 24, true);
      const pages = Math.ceil(length / CHECK_PAGE_BYTES);
      if (!safe(start) || !safe(offset) || !safe(length) || length === 0 || offset + length > dataSize ||
          29 + nameBytes + 4 * pages !== bodyBytes) break;
      const key = fromUtf8.decode(bytes.subarray(from + 28, from + 28 + nameBytes));
      const sums = allocateTypedArray(Uint32Array, pages, 'A kept piece\'s page checksums');
      for (let i = 0, to = from + 28 + nameBytes; i < pages; i++, to += 4) sums[i] = view.getUint32(to, true);
      ranges.push({ key, start, offset, length, sums });
    } else if (type === RECORD_OBJECT) {
      if (bodyBytes < 18) break;
      const nameBytes = view.getUint32(from, true);
      if (1 + 4 + nameBytes + 13 > bodyBytes) break;
      const key = fromUtf8.decode(bytes.subarray(from + 4, from + 4 + nameBytes));
      const to = from + 4 + nameBytes;
      const size = view.getFloat64(to, true);
      const hasValidator = view.getUint8(to + 8) === 1;
      const tagBytes = view.getUint32(to + 9, true);
      if (1 + 4 + nameBytes + 13 + tagBytes !== bodyBytes) break;
      objects.set(key, {
        size: safe(size) ? size : null,
        validator: hasValidator ? fromUtf8.decode(bytes.subarray(to + 13, to + 13 + tagBytes)) : null,
      });
    } else if (type === RECORD_CONFIRMED && bodyBytes === 1) {
      confirmed = ranges.length;
    } else if (type === RECORD_ABSENT && bodyBytes >= 5 && 5 + view.getUint32(from, true) === bodyBytes) {
      absent.add(fromUtf8.decode(bytes.subarray(from + 4, from + 4 + view.getUint32(from, true))));
    } else {
      break;
    }
    at = end;
  }
  return { ranges, objects, absent, confirmed };
}
