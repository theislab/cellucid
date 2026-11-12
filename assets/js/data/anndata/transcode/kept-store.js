/**
 * A transcoded store as kept: its entries (`formats/zarr/stores/mapped.js`)
 * written into a manifest, and read back from one, so a file opened again
 * in the same tab opens from what its first pass kept.
 *
 * @module data/anndata/transcode/kept-store
 */

import { mappedStore } from '../../../formats/zarr/stores/mapped.js';
import { allocateTypedArray } from '../../sparse-column-index.js';
import { base64OfBytes, bytesOfBase64 } from '../../../utils/byte-text.js';

/** The bytes an entry holds, allocated as the memory model counts them. */
function entryBytesOf(text) {
  return bytesOfBase64(text, length => allocateTypedArray(Uint8Array, length, 'Kept store entries'));
}

/** Entries as plain JSON. */
export function entriesToJson(entries) {
  const out = {};
  for (const [key, entry] of entries) {
    out[key] = entry.bytes !== undefined
      ? { b: base64OfBytes(entry.bytes) }
      : { blob: entry.blob, offset: entry.offset, length: entry.length, size: entry.size ?? entry.length };
  }
  return out;
}

/** Entries from their JSON. */
export function entriesFromJson(json) {
  const entries = new Map();
  for (const [key, entry] of Object.entries(json ?? {})) {
    entries.set(key, entry.b !== undefined ? { bytes: entryBytesOf(entry.b) } : { ...entry });
  }
  return entries;
}

/**
 * The store of one kept object.
 *
 * @param {Map<string, Object>} entries
 * @param {Map<string, {read: Function}>} blobs
 * @param {string} name
 */
export function keptStore(entries, blobs, name) {
  return mappedStore(entries, blobs, { name });
}
