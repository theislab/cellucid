/**
 * A store whose keys are held in memory or map to byte ranges of other
 * files: what a transcoder builds (`data/anndata/transcode`). A key is
 *
 * - `{bytes}`: its bytes, held (metadata, small arrays);
 * - `{blob, offset, length, size}`: `length` bytes at `offset` of one of
 *   the store's blobs (a file in the origin-private file system, a `Blob`
 *   in memory, or the file the store was transcoded from), then zeros up to
 *   `size` (an uncompressed Zarr chunk at an array's edge is stored whole).
 *
 * A blob is anything with `read(offset, length, options) → Promise<Uint8Array>`
 * (`blobReader` wraps a `Blob`). Reads of many keys run many at a time; reads
 * of one key's ranges that touch are one read.
 *
 * @module formats/zarr/stores/mapped
 */

import { createLimiter, mergeRanges } from './common.js';

/** Reads of the store's blobs in flight at once (as a picked folder's, `directory.js`). */
const CONCURRENCY = 16;

/**
 * A blob reader over a `Blob` (or `File`).
 *
 * @param {Blob} blob
 * @returns {{size: number, read: (offset: number, length: number) => Promise<Uint8Array>}}
 */
export function blobReader(blob) {
  return {
    size: blob.size,
    async read(offset, length) {
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    },
  };
}

/**
 * @param {Map<string, {bytes: Uint8Array}|{blob: string, offset: number, length: number, size?: number}>} entries
 * @param {Record<string, {read: Function}>|Map<string, {read: Function}>} blobs - The blobs, by name
 * @param {{name?: string, concurrency?: number}} [options]
 */
export function mappedStore(entries, blobs, { name = 'store', concurrency = CONCURRENCY } = {}) {
  const blobOf = blobs instanceof Map ? key => blobs.get(key) : key => blobs[key];
  const limit = createLimiter(concurrency);
  const stats = { requests: 0, bytes: 0 };

  async function readRange(entry, start, end, signal, activity) {
    const blob = blobOf(entry.blob);
    if (blob === undefined) throw new Error(`${name}: the blob '${entry.blob}' is missing.`);
    activity?.planned?.(end - start);
    return limit(async () => {
      const bytes = await blob.read(entry.offset + start, end - start, { signal, activity });
      stats.requests++;
      stats.bytes += bytes.length;
      activity?.fetched?.(bytes.length, 1);
      return bytes;
    }, signal, activity);
  }

  /** The bytes `[start, end)` of one entry's stored value (zeros past its range). */
  async function readEntry(entry, start, end, signal, activity) {
    if (entry.bytes !== undefined) return entry.bytes.subarray(start, end);
    const stored = Math.min(end, entry.length);
    const head = start < stored ? await readRange(entry, start, stored, signal, activity) : new Uint8Array(0);
    if (head.length === end - start) return head;
    const whole = new Uint8Array(end - start);
    whole.set(head);
    return whole;
  }

  const sizeOf = entry => (entry.bytes !== undefined ? entry.bytes.length : entry.size ?? entry.length);

  const get = async (key, { signal = null, activity = null } = {}) => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The read was aborted.', 'AbortError');
    const entry = entries.get(key);
    if (entry === undefined) return null;
    return readEntry(entry, 0, sizeOf(entry), signal, activity);
  };

  return Object.freeze({
    name,
    get,
    getMany: (keys, options) => Promise.all(keys.map(key => get(key, options))),
    async getRanges(key, ranges, { signal = null, activity = null } = {}) {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      const size = sizeOf(entry);
      const bounds = ranges.map(range => (range.suffix !== undefined
        ? { offset: Math.max(0, size - range.suffix), length: Math.min(size, range.suffix) }
        : { offset: range.offset, length: range.length }));
      const parts = new Array(bounds.length);
      await Promise.all(mergeRanges(bounds, 0, Infinity).map(async ({ start, end, members }) => {
        const bytes = await readEntry(entry, start, end, signal, activity);
        for (const member of members) {
          const { offset, length } = bounds[member];
          parts[member] = bytes.subarray(offset - start, offset - start + length);
        }
      }));
      return parts;
    },
    storedSize: key => {
      const entry = entries.get(key);
      return entry === undefined ? 0 : sizeOf(entry);
    },
    list: () => [...entries.keys()],
    stats: () => ({ ...stats }),
  });
}
