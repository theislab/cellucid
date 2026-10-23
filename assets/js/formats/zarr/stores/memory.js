/**
 * A store held in memory: a `Map` (or plain object) from key to bytes. For
 * stores built in code, and tests.
 *
 * @module formats/zarr/stores/memory
 */

import { normalizeKey } from './common.js';

/**
 * @param {Map<string, Uint8Array>|Record<string, Uint8Array>} entries
 * @param {{name?: string}} [options]
 */
export function memoryStore(entries, { name = 'memory' } = {}) {
  const map = new Map();
  for (const [key, bytes] of entries instanceof Map ? entries : Object.entries(entries)) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError(`memoryStore: '${key}' must be a Uint8Array.`);
    map.set(normalizeKey(key), bytes);
  }
  const stats = { requests: 0, bytes: 0 };
  const get = async (key, { signal = null, activity = null } = {}) => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The read was aborted.', 'AbortError');
    const bytes = map.get(key) ?? null;
    if (bytes !== null) {
      stats.requests++;
      stats.bytes += bytes.length;
      activity?.fetched?.(bytes.length, 1);
    }
    return bytes;
  };
  return Object.freeze({
    name,
    get,
    getMany: (keys, options) => Promise.all(keys.map(key => get(key, options))),
    async getRanges(key, ranges, options) {
      const bytes = await get(key, options);
      if (bytes === null) return null;
      return ranges.map(range => (range.suffix !== undefined
        ? bytes.subarray(Math.max(0, bytes.length - range.suffix))
        : bytes.subarray(range.offset, range.offset + range.length)));
    },
    storedSize: key => map.get(key)?.length ?? 0,
    list: () => [...map.keys()],
    stats: () => ({ ...stats }),
  });
}
