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
 * (`blobReader` wraps a `Blob`), and a `link` when it measures its own reads
 * (a byte reader of the file transcoded from). Reads of many keys run many
 * at a time; ranges of one blob asked for in the same task, by any number of
 * reads and keys (the chunks of a kept array, the few counted entries of
 * many genes), are one read where they lie within what one more read costs
 * on the blob's link (its merge gap; a blob without one is measured here as
 * a file on this computer), as a web host's are (`batchedRanges`).
 *
 * @module formats/zarr/stores/mapped
 */

import { LOCAL_MERGED_READ_BYTES, batchedRanges, createLimiter } from './common.js';
import { LinkMeter } from '../../io/link.js';
import { LOCAL_POLICY } from '../../io/byte-source.js';

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

  /** Each blob's link: its own, else one measured here (a file on this computer). */
  const meters = new Map();
  const linkOf = blobName => {
    const own = blobOf(blobName)?.link ?? null;
    if (own !== null) return { link: own, measured: false };
    let meter = meters.get(blobName);
    if (meter === undefined) meters.set(blobName, meter = { link: new LinkMeter(LOCAL_POLICY), measured: true });
    return meter;
  };

  /** Bytes `[start, end)` of blob `blobName`, one read. */
  function readBlobRange(blobName, start, end, signal, activity) {
    const blob = blobOf(blobName);
    if (blob === undefined) return Promise.reject(new Error(`${name}: the blob '${blobName}' is missing.`));
    activity?.planned?.(end - start);
    const meter = linkOf(blobName);
    return limit(async () => {
      const begun = meter.measured ? meter.link.begin() : 0;
      let bytes;
      try {
        bytes = await blob.read(start, end - start, { signal, activity });
      } catch (error) {
        if (meter.measured) meter.link.end(begun, null);
        throw error;
      }
      if (meter.measured) meter.link.end(begun, bytes.length);
      stats.requests++;
      stats.bytes += bytes.length;
      activity?.fetched?.(bytes.length, 1);
      return bytes;
    }, signal, activity);
  }
  const ranged = batchedRanges({
    read: (blobName, start, end, { signal, activity }) => readBlobRange(blobName, start, end, signal, activity),
    gap: blobName => linkOf(blobName).link.mergeGapBytes,
    maxBytes: () => LOCAL_MERGED_READ_BYTES,
  });

  /** Bytes `[start, end)` of one entry's stored bytes. */
  function readRange(entry, start, end, signal, activity) {
    return ranged(entry.blob, entry.offset + start, end - start, { signal, activity });
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
      return Promise.all(bounds.map(({ offset, length }) => readEntry(entry, offset, offset + length, signal, activity)));
    },
    storedSize: key => {
      const entry = entries.get(key);
      return entry === undefined ? 0 : sizeOf(entry);
    },
    list: () => [...entries.keys()],
    stats: () => ({ ...stats }),
  });
}
