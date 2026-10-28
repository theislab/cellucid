/**
 * A store inside a ZIP archive (`.zarr.zip`), read through `formats/zip`.
 *
 * The store may sit at the top of the archive or inside one folder (a zipped
 * `.zarr` folder); keys are paths relative to the store root either way.
 * Every read goes through the archive's byte reader, so reads asked for
 * together (all chunks of a selection) are planned together: neighbouring
 * entries are fetched in one request, the rest in parallel. A stored
 * (uncompressed) entry can be read by range, which is what lets a sharded
 * Zarr v3 array fetch only the inner chunks it needs.
 *
 * @module formats/zarr/stores/zip
 */

import { ZarrFormatError } from '../errors.js';
import { entryMap } from '../../zip/archive.js';
import { storeRootPrefix } from './common.js';

/**
 * @param {import('../../zip/archive.js').ZipArchive} archive
 * @param {{name?: string}} [options]
 */
export function zipStore(archive, { name } = {}) {
  const all = entryMap(archive);
  const prefix = storeRootPrefix(all.keys());
  if (prefix === null) {
    throw new ZarrFormatError(`${archive.name} does not hold a Zarr store: no zarr.json, .zgroup, .zarray or .zmetadata at its top or inside its one folder.`);
  }
  const map = prefix === '' ? all : entryMap(archive, prefix);
  const storeName = name ?? (prefix ? prefix.slice(0, -1) : archive.name.replace(/\.zip$/i, ''));

  const get = async (key, options = {}) => {
    const entry = map.get(key);
    return entry === undefined ? null : entry.read(options);
  };

  return Object.freeze({
    name: storeName,
    archive,
    get,
    getMany: (keys, options) => Promise.all(keys.map(key => get(key, options))),
    async getRanges(key, ranges, options = {}) {
      const entry = map.get(key);
      if (entry === undefined) return null;
      const bounds = ranges.map(range => (range.suffix !== undefined
        ? [Math.max(0, entry.size - range.suffix), entry.size]
        : [range.offset, range.offset + range.length]));
      if (entry.method !== 0) {
        // A deflated entry cannot be read in part: inflate it once for all ranges.
        const whole = await entry.read(options);
        return bounds.map(([start, end]) => whole.subarray(start, end));
      }
      return Promise.all(bounds.map(([start, end]) => {
        if (end > entry.size) throw new ZarrFormatError(`${storeName}: '${key}' is shorter than its index says.`);
        return entry.readRange(start, end - start, options);
      }));
    },
    storedSize: key => map.get(key)?.compressedSize ?? 0,
    /** What one more request costs on the archive's link, in bytes (its merge gap). */
    ...(archive.link == null ? {} : { mergeGapBytes: () => archive.link.mergeGapBytes }),
    list: () => [...map.keys()],
    stats: () => {
      const { bytes, requests } = archive.stats();
      return { bytes, requests };
    },
  });
}
