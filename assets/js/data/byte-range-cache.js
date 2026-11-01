/**
 * Bytes of remote files kept for the page's reader workers: the page side
 * of `formats/io/range-cache.js`.
 *
 * Every reader worker the page starts is handed a port to one cache
 * (`byteRangeCachePort`). A worker reading a remote file asks it for the
 * bytes it holds of a range, fetches the rest, and hands what it fetched
 * back. So a reader of the same file in a new worker (another cell subset,
 * opened as a new dataset generation while the old one stays shown) fetches
 * nothing the old one fetched: the file's structure, its chunk indexes, the
 * chunks both subsets hold.
 *
 * What is kept is bounded by the page's share of memory for it
 * (`residencyBudgetBytes('fetchedRanges')`, `memory-budget.js`, as it is
 * whenever a range is kept): ranges are dropped least recently used first,
 * whichever file they belong to, and the memory model trims them when the
 * share shrinks or the page is hidden (`trim`). A file
 * is kept under a key naming its bytes exactly (`rangeCacheKey`), and
 * under its address (the same file whatever its version: `rangeCacheAddress`):
 * opening a version of a file drops what is kept of its other versions, and
 * a file that changed on its host while open drops every version
 * (`forgetVersions`). A store whose every object is a file of its own (a
 * Zarr folder on a web host) is kept object by object under a prefix naming
 * the store's version (`storeObjectsKey`), and a worker asks once a store
 * which of its objects are held (`holds` by prefix), not once an object.
 *
 * @module data/byte-range-cache
 */

import { registerResidentHolder, residencyBudgetBytes } from './memory-budget.js';

/**
 * A cache of byte ranges by file key, within `budgetBytes`.
 *
 * @param {{budgetBytes: number|(() => number)}} options - A fixed budget, or
 *   a function read whenever a range is kept
 */
export function createByteRangeCache({ budgetBytes: budget }) {
  if (typeof budget !== 'function' && (!Number.isSafeInteger(budget) || budget < 0)) throw new TypeError('A byte range cache budget is a whole number of bytes.');
  const budgetBytes = typeof budget === 'function' ? budget : () => budget;
  /** key -> ranges `{key, start, end, bytes}`, sorted by start. */
  const files = new Map();
  /** Every range, least recently used first. */
  const order = new Set();
  let bytesKept = 0;
  /** Channels to reader workers not yet ended. */
  let channels = 0;

  /**
   * The index of the first range of `ranges` that starts at or after
   * `start`. No range holds another (`keep`), so ranges sorted by start are
   * sorted by end too, and a binary search finds where any range lies: an
   * export of tens of thousands of scattered chunks kept each in a scan of
   * every range kept (2.8 s of the page's main thread on a 21,285-cell
   * export of HLCA core).
   */
  function firstFrom(ranges, start) {
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ranges[middle].start < start) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function drop(range) {
    const ranges = files.get(range.key);
    if (ranges === undefined) return;
    const index = firstFrom(ranges, range.start);
    if (ranges[index] === range) ranges.splice(index, 1);
    if (ranges.length === 0) {
      files.delete(range.key);
      addresses.delete(range.key);
    }
    order.delete(range);
    bytesKept -= range.bytes.length;
  }

  function touch(range) {
    order.delete(range);
    order.add(range);
  }

  /** The kept pieces of `[offset, offset + length)` of `key`, each its own copy. */
  function lookup(key, offset, length) {
    const ranges = files.get(key);
    if (ranges === undefined) return [];
    const end = offset + length;
    const pieces = [];
    // The range before the first starting at `offset` may reach into it.
    for (let index = Math.max(0, firstFrom(ranges, offset) - 1); index < ranges.length; index++) {
      const range = ranges[index];
      if (range.start >= end) break;
      if (range.end <= offset) continue;
      const from = Math.max(offset, range.start);
      const to = Math.min(end, range.end);
      pieces.push({ start: from, bytes: range.bytes.slice(from - range.start, to - range.start) });
      touch(range);
    }
    return pieces;
  }

  /** Each file key's address (`rangeCacheAddress`), for `forgetVersions`. */
  const addresses = new Map();

  /**
   * Drop every range of the files at `address` whose key is not `keep`
   * (null: every one of them).
   */
  function forgetVersions(address, keep) {
    for (const [key, at] of [...addresses]) {
      if (at !== address || key === keep) continue;
      addresses.delete(key);
      for (const range of (files.get(key) ?? []).slice()) drop(range);
    }
  }

  /** Keep `bytes` of `key` at `start`, unless ranges kept already hold them. */
  function keep(key, start, bytes, address = null) {
    const limit = budgetBytes();
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > limit || !Number.isSafeInteger(start) || start < 0) return;
    const end = start + bytes.length;
    if (address !== null) addresses.set(key, address);
    let ranges = files.get(key);
    if (ranges === undefined) {
      ranges = [];
      files.set(key, ranges);
    }
    // One that holds the new range whole makes it a repeat (the last
    // starting at or before it, the one reaching furthest); ranges it holds
    // whole (those starting in it and ending by its end, one after
    // another) are replaced by it. No range holds another.
    let at = firstFrom(ranges, start);
    const before = at < ranges.length && ranges[at].start === start ? ranges[at] : ranges[at - 1];
    if (before !== undefined && before.start <= start && before.end >= end) {
      touch(before);
      return;
    }
    let past = at;
    while (past < ranges.length && ranges[past].end <= end) past++;
    for (const held of ranges.slice(at, past)) drop(held);
    ranges = files.get(key) ?? [];
    if (!files.has(key)) files.set(key, ranges);
    // (Dropping a file's last range forgets its address: told again.)
    if (address !== null) addresses.set(key, address);
    const range = { key, start, end, bytes };
    at = firstFrom(ranges, start);
    ranges.splice(at, 0, range);
    order.add(range);
    bytesKept += bytes.length;
    trim(limit);
  }

  /** Drop ranges, least recently used first, until no more than `target` bytes are kept. */
  function trim(target) {
    const before = bytesKept;
    for (const oldest of order) {
      if (bytesKept <= target) break;
      drop(oldest);
    }
    return bytesKept < before ? 'fetched bytes of remote files' : null;
  }

  return Object.freeze({
    lookup,
    keep,
    forgetVersions,
    trim,
    /**
     * Answer one reader worker through `port` until the returned function
     * is called (the worker ended): it closes the port.
     */
    connect(port) {
      port.onmessage = event => {
        const message = event.data ?? {};
        // The reader left (`endRangeCachePort`): every range it told this
        // cache to keep came before, so the channel closes now.
        if (message.end === true) {
          close();
          return;
        }
        if (message.keep !== undefined) {
          keep(message.keep.key, message.keep.start, message.keep.bytes, message.keep.address ?? null);
          return;
        }
        if (message.forget !== undefined) {
          forgetVersions(message.forget.address, message.forget.keep ?? null);
          return;
        }
        if (message.holds !== undefined) {
          // A store's objects (a Zarr folder on a web host) are asked for
          // together, by the prefix naming the store's version: each held
          // range as its key and bounds.
          const { prefix } = message.holds;
          if (typeof prefix === 'string') {
            const held = [];
            for (const [key, ranges] of files) {
              if (key.startsWith(prefix)) for (const range of ranges) held.push([key, range.start, range.end]);
            }
            port.postMessage({ id: message.id, held });
            return;
          }
          const ranges = files.get(message.holds.key) ?? [];
          port.postMessage({ id: message.id, held: ranges.map(range => [range.start, range.end]) });
          return;
        }
        if (message.lookup !== undefined) {
          const { key, offset, length } = message.lookup;
          const pieces = lookup(key, offset, length);
          port.postMessage({ id: message.id, pieces }, pieces.map(piece => piece.bytes.buffer));
        }
      };
      port.start?.();
      // As in a browser, where a port keeps nothing alive (its worker is what
      // holds resources, and the reader closes the channel with it): Node's
      // ports would otherwise keep a process running past its last reader.
      port.unref?.();
      channels++;
      let open = true;
      const close = () => {
        if (!open) return;
        open = false;
        channels--;
        port.onmessage = null;
        port.close();
      };
      return close;
    },
    stats: () => ({ bytes: bytesKept, ranges: order.size, files: files.size, channels }),
    clear() {
      files.clear();
      addresses.clear();
      order.clear();
      bytesKept = 0;
    },
  });
}

/** @type {ReturnType<typeof createByteRangeCache>|null} */
let shared = null;

/** The page's cache, made on first use and counted by the memory model. */
export function pageByteRangeCache() {
  if (shared === null) {
    const cache = createByteRangeCache({ budgetBytes: () => residencyBudgetBytes('fetchedRanges') });
    registerResidentHolder('fetchedRanges', { label: 'fetched bytes', bytes: () => cache.stats().bytes, trim: cache.trim });
    shared = cache;
  }
  return shared;
}

/**
 * A channel to the page's cache for one reader worker, or null where this
 * realm has no `MessageChannel`: `port` is posted to the worker (and adopted
 * there with `adoptRangeCachePort`), and `close()` ends the channel when the
 * worker ends (`AnnDataReaderClient` closes it with the worker), so no port
 * outlives its worker.
 *
 * @returns {{port: MessagePort, close: () => void}|null}
 */
export function byteRangeCachePort() {
  if (typeof MessageChannel !== 'function') return null;
  const { port1, port2 } = new MessageChannel();
  const close = pageByteRangeCache().connect(port1);
  return { port: port2, close };
}
