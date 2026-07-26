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
import {
  assertArray,
  assertPlainRecord,
  assertSafeInteger
} from '../schema-contract.js';

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
  assertPlainRecord(manifest, 'Bundle manifest');
  assertArray(manifest.chunks, 'Bundle manifest chunks');
  assertArray(chunks, 'Bundle stored chunks');
  if (manifest.chunks.length !== chunks.length) {
    throw new Error(
      `writeBundle: manifest/stored chunk count mismatch (${manifest.chunks.length} != ${chunks.length}).`,
    );
  }

  for (let index = 0; index < chunks.length; index++) {
    const chunkBytes = chunks[index];
    if (!(chunkBytes instanceof Uint8Array)) {
      throw new TypeError(`writeBundle: stored chunk ${index} must be a Uint8Array.`);
    }
    const meta = manifest.chunks[index];
    assertPlainRecord(meta, `Bundle manifest chunk ${index}`);
    const storedBytes = assertSafeInteger(
      meta.storedBytes,
      `Bundle manifest chunk ${index} storedBytes`,
      { maximum: 0xffff_ffff },
    );
    if (storedBytes !== chunkBytes.byteLength) {
      throw new Error(
        `writeBundle: chunk ${index} storedBytes mismatch (${storedBytes} != ${chunkBytes.byteLength}).`,
      );
    }
  }

  const encoder = new TextEncoder();
  const manifestBytes = encoder.encode(JSON.stringify(manifest));

  /** @type {BlobPart[]} */
  const parts = [];
  parts.push(SESSION_BUNDLE_MAGIC_BYTES);
  parts.push(u32ToBytesLE(manifestBytes.byteLength));
  parts.push(manifestBytes);

  for (const chunkBytes of chunks) {
    parts.push(u32ToBytesLE(chunkBytes.byteLength));
    parts.push(chunkBytes);
  }

  return new Blob(parts, { type: 'application/octet-stream' });
}
