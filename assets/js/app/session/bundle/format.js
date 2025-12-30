/**
 * @fileoverview Session bundle container framing constants.
 *
 * A `.cellucid-session` file is a single binary container:
 *  1) MAGIC bytes (ASCII)
 *  2) manifestByteLength (u32 LE)
 *  3) manifest JSON bytes (UTF-8)
 *  4) repeated chunks: [chunkByteLength (u32 LE), chunkBytes...]
 *
 * IMPORTANT (dev-phase constraints from session-serializer-plan.md):
 * - No version fields and no migration logic.
 * - Treat session files as untrusted input; enforce strict bounds.
 *
 * @module session/bundle/format
 */

/** Fixed ASCII prelude used to reject non-session files quickly. */
export const SESSION_BUNDLE_MAGIC = 'CELLUCID_SESSION\n';

/** @type {Uint8Array} */
export const SESSION_BUNDLE_MAGIC_BYTES = new TextEncoder().encode(SESSION_BUNDLE_MAGIC);

/** u32 little-endian size in bytes. */
export const U32_BYTES = 4;

/**
 * Hard cap for manifest size to avoid pathological allocations on corrupt input.
 * The plan recommends 8–16MB; choose 16MB for dev-phase flexibility.
 */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

/**
 * Default hard cap for decompressed chunk size when `uncompressedBytes` is missing.
 * This is a zip-bomb guard; contributors should also validate decoded content.
 */
export const DEFAULT_MAX_UNCOMPRESSED_CHUNK_BYTES = 512 * 1024 * 1024;

/**
 * Hard cap for stored chunk size (after codec, before decompression/JSON parse).
 *
 * This is primarily a guard for streamed inputs where total file size may be
 * unknown or unreliable (e.g., `Content-Encoding` makes `Content-Length` a hint).
 * Without this, a corrupt file could request multi‑GB allocations.
 */
export const MAX_STORED_CHUNK_BYTES = 512 * 1024 * 1024;

/**
 * Encode a number as u32 little-endian.
 * @param {number} value
 * @returns {Uint8Array}
 */
export function u32ToBytesLE(value) {
  const out = new Uint8Array(U32_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, value >>> 0, true);
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
