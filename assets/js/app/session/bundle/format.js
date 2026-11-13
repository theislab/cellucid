/**
 * @fileoverview Session bundle container framing constants.
 *
 * A `.cellucid-session` file is a single binary container:
 *  1) MAGIC bytes (ASCII `CELLUCID_SESSION/4\n`: the format version is part
 *     of the signature)
 *  2) manifestByteLength (u32 LE)
 *  3) manifest JSON bytes (UTF-8)
 *  4) repeated chunks: [chunkByteLength (u32 LE), chunkBytes...]
 *
 * What the manifest and the chunks of format 4 hold (the history: trackers,
 * their steps, every value of the history's pool, conversations) is
 * `session/history-file.js`.
 *
 * The framing is shared: a `.cellucid-library` file (My datasets' export,
 * `app/library/library-file.js`) is the same container with its own
 * signature (`CELLUCID_LIBRARY/1\n`). The writer and the reader take the
 * signature of the file they frame ({@link SESSION_SIGNATURE} by default), so
 * a file of one kind given where the other is read is refused naming what it
 * is.
 *
 * Current format constraints:
 * - One format version is read: the one in the signature. A file with the
 *   signature of another format version is refused with the sentence
 *   {@link sessionSignatureRefusal} gives (saved by an earlier, or a newer,
 *   Cellucid); any other file with {@link NOT_A_SESSION_FILE_MESSAGE}.
 * - Format 4 (this one) holds the history of steps; a file of another
 *   format names its version, so it is refused with that version, never
 *   misread. It records the cell-order digest over an embedding's stored
 *   values by original position (`data/cell-order-digest.js`).
 * - Treat session files as untrusted input: every length is checked against
 *   the bytes the file still holds, and every inflate is bounded by the
 *   chunk's declared `uncompressedBytes`.
 * - A frame length is a u32, so the manifest and each stored chunk hold at
 *   most 4 GiB − 1 bytes; that is the format's only size limit.
 *
 * @module session/bundle/format
 */

import { PLACES, placePath } from '../../ui/place-names.js';

/** The session format this release writes and reads. */
export const SESSION_FORMAT_VERSION = 4;

/** The file kind every session format's signature starts with. */
const SESSION_SIGNATURE_PREFIX = 'CELLUCID_SESSION/';

/** Fixed ASCII prelude: the file kind and its format version. */
const SESSION_BUNDLE_MAGIC = `${SESSION_SIGNATURE_PREFIX}${SESSION_FORMAT_VERSION}\n`;

/** @type {Uint8Array} */
export const SESSION_BUNDLE_MAGIC_BYTES = new TextEncoder().encode(SESSION_BUNDLE_MAGIC);

/** Shown verbatim for a file that does not start with a session signature. */
export const NOT_A_SESSION_FILE_MESSAGE =
  `This file is not a Cellucid session file of format ${SESSION_FORMAT_VERSION} `
  + `(it does not start with CELLUCID_SESSION/${SESSION_FORMAT_VERSION}).`;

/** The file kind every library file's signature starts with (`app/library/library-file.js`). */
export const LIBRARY_SIGNATURE_PREFIX = 'CELLUCID_LIBRARY/';

/** Shown verbatim for a library file given where a session file is read. */
export const LIBRARY_FILE_NOT_A_SESSION_MESSAGE =
  'This file is a Cellucid library file (datasets and saved states of My datasets), not a session file. '
  + `Import it with ${placePath(PLACES.session, PLACES.openData, PLACES.myDatasets)} › All… › Import….`;

/**
 * The sentence a session file of another format version is refused with:
 * one saved by an earlier Cellucid (a saved state, where this version keeps
 * the history of every step), or by a newer one.
 *
 * @param {number} version
 * @returns {string}
 */
export function otherSessionFormatMessage(version) {
  return version < SESSION_FORMAT_VERSION
    ? `This session was saved by an earlier version of Cellucid (session format ${version}), `
      + `which this version no longer reads: a session file now holds the history of every step `
      + `(session format ${SESSION_FORMAT_VERSION}). It was not opened. Open it in the version `
      + 'of Cellucid that saved it, or re-create the session in this version.'
    : `This session was saved by a newer version of Cellucid (session format ${version}), `
      + 'which this version cannot read. Open it in that version of Cellucid.';
}

/**
 * Why a file whose first bytes are `magic` (as many as this format's
 * signature holds, or fewer for a shorter file) is not read: another
 * session format's signature, or none.
 *
 * @param {Uint8Array} magic
 * @returns {string}
 */
export function sessionSignatureRefusal(magic) {
  const text = new TextDecoder('ascii').decode(magic);
  if (text.startsWith(LIBRARY_SIGNATURE_PREFIX)) return LIBRARY_FILE_NOT_A_SESSION_MESSAGE;
  const version = otherSessionFormatOf(magic);
  return version === null ? NOT_A_SESSION_FILE_MESSAGE : otherSessionFormatMessage(version);
}

/**
 * The session format a file's first bytes name when it is not this one, or
 * null: a session file of another Cellucid, not a damaged one.
 *
 * @param {Uint8Array} magic
 * @returns {number|null}
 */
export function otherSessionFormatOf(magic) {
  const text = new TextDecoder('ascii').decode(magic);
  if (!text.startsWith(SESSION_SIGNATURE_PREFIX)) return null;
  const match = /^(\d+)(?:\n|$)/.exec(text.slice(SESSION_SIGNATURE_PREFIX.length));
  const version = match === null ? null : Number(match[1]);
  return version === null || version === SESSION_FORMAT_VERSION || version === 0 ? null : version;
}

/**
 * Whether a read was refused because the file is whole but of another session
 * format (`bundle/reader.js`). What a person is told depends on who chose the
 * file: their own file says which format and what to do; a dataset's published
 * sample view, met while the app and the datasets are deployed minutes apart,
 * is only not available yet.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isOtherSessionFormat(error) {
  return Number.isSafeInteger(error?.otherSessionFormat);
}

/**
 * A file kind of this framing, as the writer and the reader take it: its
 * signature (`bytes`), how a sentence names it (`file`, `label`), and the
 * sentence a file whose first bytes are not its signature is refused with
 * (`refusal(magic)`: given the bytes read, as many as the signature holds or
 * fewer for a shorter file); `otherFormat(magic)`, where a kind has versions,
 * names the format version that refusal is about.
 *
 * @typedef {Readonly<{bytes: Uint8Array, file: string, label: string,
 *   refusal: (magic: Uint8Array) => string, otherFormat?: (magic: Uint8Array) => number|null}>} BundleSignature
 */

/** @type {BundleSignature} */
export const SESSION_SIGNATURE = Object.freeze({
  bytes: SESSION_BUNDLE_MAGIC_BYTES,
  file: 'session file',
  label: 'Session',
  refusal: sessionSignatureRefusal,
  otherFormat: otherSessionFormatOf,
});

/** u32 little-endian size in bytes. */
export const U32_BYTES = 4;

/**
 * The most bytes one frame (the manifest, or one stored chunk) can hold: its
 * length is a u32. This is the format's limit, not a policy.
 */
export const MAX_FRAME_BYTES = 0xffff_ffff;

/**
 * Encode a number as u32 little-endian.
 * @param {number} value
 * @returns {Uint8Array}
 */
export function u32ToBytesLE(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new TypeError('u32ToBytesLE: value must be an exact unsigned 32-bit integer.');
  }
  const out = new Uint8Array(U32_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, value, true);
  return out;
}

/**
 * Read a u32 little-endian value from a 4-byte array.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function bytesToU32LE(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== U32_BYTES) {
    throw new Error('bytesToU32LE: expected exactly 4 bytes.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true);
}
