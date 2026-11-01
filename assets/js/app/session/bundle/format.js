/**
 * @fileoverview Session bundle container framing constants.
 *
 * A `.cellucid-session` file is a single binary container:
 *  1) MAGIC bytes (ASCII `CELLUCID_SESSION/3\n`: the format version is part
 *     of the signature)
 *  2) manifestByteLength (u32 LE)
 *  3) manifest JSON bytes (UTF-8)
 *  4) repeated chunks: [chunkByteLength (u32 LE), chunkBytes...]
 *
 * Current format constraints:
 * - One format version is read: the one in the signature. A file with the
 *   signature of another format version is refused with the sentence
 *   {@link sessionSignatureRefusal} gives (saved by an earlier, or a newer,
 *   Cellucid); any other file with {@link NOT_A_SESSION_FILE_MESSAGE}.
 * - Format 3 (this one) records the cell-order digest over an embedding's
 *   stored values by original position (`data/cell-order-digest.js`); a
 *   format-2 file's digest was taken over display coordinates, which no
 *   later version can recompute, so it is refused, never compared.
 * - Treat session files as untrusted input: every length is checked against
 *   the bytes the file still holds, and every inflate is bounded by the
 *   chunk's declared `uncompressedBytes`.
 * - A frame length is a u32, so the manifest and each stored chunk hold at
 *   most 4 GiB − 1 bytes; that is the format's only size limit.
 *
 * @module session/bundle/format
 */

/** The session format this release writes and reads. */
export const SESSION_FORMAT_VERSION = 3;

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

/**
 * The sentence a session file of another format version is refused with:
 * one saved by an earlier Cellucid (whose cell check this version cannot
 * verify), or by a newer one.
 *
 * @param {number} version
 * @returns {string}
 */
export function otherSessionFormatMessage(version) {
  return version < SESSION_FORMAT_VERSION
    ? `This session was saved by an earlier version of Cellucid (session format ${version}): `
      + 'the check that it marks the same cells cannot be verified, so it was not opened. '
      + 'Re-create it in this version of Cellucid.'
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
  const match = text.startsWith(SESSION_SIGNATURE_PREFIX)
    ? /^(\d+)(?:\n|$)/.exec(text.slice(SESSION_SIGNATURE_PREFIX.length))
    : null;
  const version = match === null ? null : Number(match[1]);
  return version === null || version === SESSION_FORMAT_VERSION || version === 0
    ? NOT_A_SESSION_FILE_MESSAGE
    : otherSessionFormatMessage(version);
}

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
