/**
 * A transcoded store as kept: its entries (`formats/zarr/stores/mapped.js`)
 * written into a manifest, and read back from one, so a file opened again
 * in the same tab opens from what its first pass kept.
 *
 * @module data/anndata/transcode/kept-store
 */

import { mappedStore } from '../../../formats/zarr/stores/mapped.js';

function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Entries as plain JSON. */
export function entriesToJson(entries) {
  const out = {};
  for (const [key, entry] of entries) {
    out[key] = entry.bytes !== undefined
      ? { b: toBase64(entry.bytes) }
      : { blob: entry.blob, offset: entry.offset, length: entry.length, size: entry.size ?? entry.length };
  }
  return out;
}

/** Entries from their JSON. */
export function entriesFromJson(json) {
  const entries = new Map();
  for (const [key, entry] of Object.entries(json ?? {})) {
    entries.set(key, entry.b !== undefined ? { bytes: fromBase64(entry.b) } : { ...entry });
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
