/**
 * A store picked or dropped as a folder: its files, keyed by path.
 *
 * Accepts a `Map` from relative path to `File`, or the `File`s of a folder
 * selection (keyed by `webkitRelativePath`). When every path starts with the
 * picked folder's own name (`pbmc.zarr/obs/.zattrs`), that folder is the
 * store root and its name is dropped from the keys. Nothing is read until a
 * key is asked for; reads of many files run many at a time (a view's ahead
 * of background work's, `createLimiter`), each a `File.slice().arrayBuffer()`
 * of only the bytes needed. Ranges of one file
 * asked for together (the inner chunks of a shard) that touch or overlap are
 * read as one slice: a file read costs a fixed open whatever its length, and
 * merging only touching ranges never reads a byte nobody asked for.
 *
 * @module formats/zarr/stores/directory
 */

import { ZarrFormatError } from '../errors.js';
import { isMacOSMetadata } from '../../zip/names.js';
import { createLimiter, mergeRanges, normalizeKey, storeRootPrefix } from './common.js';

/**
 * Local file reads in flight at once: enough that chunk files arrive faster
 * than the decode workers consume them; more only buffers files ahead of the
 * decoders and takes the reader thread from the work it does on them. A
 * scheduling choice, measured in a Chromium worker on an Apple M1 Pro SSD
 * (best of three): the X chunk files of Suo (1,580 files, 99 MB) arrive in
 * 330 ms four at a time, 155 ms at 8 (640 MB/s), 124 ms at 16 (800 MB/s) and
 * 110 ms at 64, while the decode pool turns them into values at about
 * 670 MB/s of stored bytes (1,501 chunks in 140 ms).
 */
const LOCAL_CONCURRENCY = 16;

/**
 * The longest slice touching ranges are merged into. Merging saves a read's
 * fixed cost; a longer slice only delays decoding its first chunk until its
 * last byte has arrived. A scheduling choice, measured in a Chromium worker
 * (Suo, Zarr v3, shards of 64 inner chunks; best of three): 1,000 cell rows
 * (inner chunks of 60 KB) take 744 ms read chunk by chunk, 519 ms merged to
 * 1 MiB, 510 ms to 32 MiB; the neighbour graph (inner chunks of 1 MB) 587,
 * 554 and 687 ms.
 */
const MERGED_READ_BYTES = 1024 * 1024;

/**
 * @param {Map<string, Blob>|Iterable<File>} files
 * @param {{name?: string, concurrency?: number, maxReadBytes?: number,
 *          readBlob?: (blob: Blob) => Promise<ArrayBuffer>}} [options]
 *   `maxReadBytes` is the longest slice touching ranges are merged into (a
 *   single range longer than it is read as it is); `readBlob`
 *   reads one file or slice (default `blob.arrayBuffer()`).
 */
export function directoryStore(files, {
  name,
  concurrency = LOCAL_CONCURRENCY,
  maxReadBytes = MERGED_READ_BYTES,
  readBlob = blob => blob.arrayBuffer(),
} = {}) {
  const raw = new Map();
  if (files instanceof Map) {
    for (const [path, file] of files) raw.set(normalizeKey(path), file);
  } else {
    for (const file of files) raw.set(normalizeKey(file.webkitRelativePath || file.name), file);
  }
  for (const key of [...raw.keys()]) if (key === '' || isMacOSMetadata(key)) raw.delete(key);
  const prefix = storeRootPrefix(raw.keys());
  if (prefix === null) {
    throw new ZarrFormatError('The selected folder does not hold a Zarr store: it has no zarr.json, .zgroup, .zarray or .zmetadata at its top. Select the .zarr folder itself.');
  }
  const map = new Map();
  for (const [key, file] of raw) if (key.startsWith(prefix)) map.set(key.slice(prefix.length), file);
  const storeName = name ?? (prefix ? prefix.slice(0, -1) : 'store.zarr');
  const limit = createLimiter(concurrency);
  const stats = { requests: 0, bytes: 0 };

  async function readSlice(file, start, end, signal, activity) {
    activity?.planned?.(end - start);
    return limit(async () => {
      const bytes = new Uint8Array(await readBlob(start === 0 && end === file.size ? file : file.slice(start, end)));
      if (bytes.length !== end - start) {
        throw new ZarrFormatError(`${storeName}: a file changed while the store was open; open it again.`);
      }
      stats.requests++;
      stats.bytes += bytes.length;
      activity?.fetched?.(bytes.length, 1);
      return bytes;
    }, signal, activity);
  }

  const get = async (key, { signal = null, activity = null } = {}) => {
    const file = map.get(key);
    if (file === undefined) return null;
    return readSlice(file, 0, file.size, signal, activity);
  };

  return Object.freeze({
    name: storeName,
    get,
    getMany: (keys, options) => Promise.all(keys.map(key => get(key, options))),
    async getRanges(key, ranges, { signal = null, activity = null } = {}) {
      const file = map.get(key);
      if (file === undefined) return null;
      const bounds = ranges.map(range => {
        const start = range.suffix !== undefined ? Math.max(0, file.size - range.suffix) : range.offset;
        const end = range.suffix !== undefined ? file.size : range.offset + range.length;
        if (start < 0 || end > file.size) throw new ZarrFormatError(`${storeName}: '${key}' is shorter than its index says.`);
        return { offset: start, length: end - start };
      });
      const parts = new Array(bounds.length);
      await Promise.all(mergeRanges(bounds, 0, maxReadBytes).map(async ({ start, end, members }) => {
        const bytes = await readSlice(file, start, end, signal, activity);
        for (const member of members) {
          const { offset, length } = bounds[member];
          parts[member] = bytes.subarray(offset - start, offset - start + length);
        }
      }));
      return parts;
    },
    storedSize: key => map.get(key)?.size ?? 0,
    list: () => [...map.keys()],
    stats: () => ({ ...stats }),
  });
}
