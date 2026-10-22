/**
 * @fileoverview Session bundle container framing constants.
 *
 * A `.cellucid-session` file is a single binary container:
 *  1) MAGIC bytes (ASCII)
 *  2) manifestByteLength (u32 LE)
 *  3) manifest JSON bytes (UTF-8)
 *  4) repeated chunks: [chunkByteLength (u32 LE), chunkBytes...]
 *
 * Current format constraints:
 * - No version, compatibility, or migration fields.
 * - Treat session files as untrusted input: every length is checked against
 *   the bytes the file still holds, and every inflate is bounded by the
 *   chunk's declared `uncompressedBytes`.
 * - A frame length is a u32, so the manifest and each stored chunk hold at
 *   most 4 GiB − 1 bytes; that is the format's only size limit.
 *
 * @module session/bundle/format
 */

/** Fixed ASCII prelude used to reject non-session files quickly. */
const SESSION_BUNDLE_MAGIC = 'CELLUCID_SESSION\n';

/** @type {Uint8Array} */
export const SESSION_BUNDLE_MAGIC_BYTES = new TextEncoder().encode(SESSION_BUNDLE_MAGIC);

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
