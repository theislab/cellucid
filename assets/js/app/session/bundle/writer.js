/**
 * @fileoverview Session bundle writer.
 *
 * Writes a single-file `.cellucid-session` bundle containing:
 * - A small JSON manifest (gzip'd or plain, chosen by orchestrator per-chunk)
 * - Length-prefixed chunk payloads in manifest order
 *
 * The writer is intentionally dumb: it assumes chunks are already encoded
 * (JSON stringified + UTF-8, and gzip applied if requested).
 *
 * @module session/bundle/writer
 */

import {
  SESSION_BUNDLE_MAGIC_BYTES,
  u32ToBytesLE
} from './format.js';

/**
 * @typedef {object} BundleWriteInput
 * @property {any} manifest - JSON-serializable manifest object.
 * @property {Uint8Array[]} chunks - Stored chunk bytes in manifest order.
 */

/**
 * Write a bundle to a Blob.
 *
 * @param {BundleWriteInput} input
 * @returns {Blob}
 */
export function writeBundle({ manifest, chunks }) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('writeBundle: manifest is required.');
  }
  if (!Array.isArray(chunks)) {
    throw new Error('writeBundle: chunks must be an array of Uint8Array.');
  }

  const encoder = new TextEncoder();
  const manifestBytes = encoder.encode(JSON.stringify(manifest));

  /** @type {BlobPart[]} */
  const parts = [];
  parts.push(SESSION_BUNDLE_MAGIC_BYTES);
  parts.push(u32ToBytesLE(manifestBytes.byteLength));
  parts.push(manifestBytes);

  for (const chunkBytes of chunks) {
    if (!(chunkBytes instanceof Uint8Array)) {
      throw new Error('writeBundle: each chunk must be a Uint8Array.');
    }
    parts.push(u32ToBytesLE(chunkBytes.byteLength));
    parts.push(chunkBytes);
  }

  return new Blob(parts, { type: 'application/octet-stream' });
}

