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
 * (`residencyBudgetBytes('fetchedRanges')`, `memory-budget.js`): ranges are
 * dropped least recently used first, whichever file they belong to. A file
 * is kept under a key naming its bytes exactly (`rangeCacheKey`).
 *
 * @module data/byte-range-cache
 */

import { residencyBudgetBytes } from './memory-budget.js';

/**
 * A cache of byte ranges by file key, within `budgetBytes`.
 *
 * @param {{budgetBytes: number}} options
 */
export function createByteRangeCache({ budgetBytes }) {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) throw new TypeError('A byte range cache budget is a whole number of bytes.');
  /** key -> ranges `{key, start, end, bytes}`, sorted by start. */
  const files = new Map();
  /** Every range, least recently used first. */
  const order = new Set();
  let bytesKept = 0;
  /** Channels to reader workers not yet ended. */
  let channels = 0;

  function drop(range) {
    const ranges = files.get(range.key);
    if (ranges === undefined) return;
    const index = ranges.indexOf(range);
    if (index >= 0) ranges.splice(index, 1);
    if (ranges.length === 0) files.delete(range.key);
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
    for (const range of ranges) {
      if (range.start >= end) break;
      if (range.end <= offset) continue;
      const from = Math.max(offset, range.start);
      const to = Math.min(end, range.end);
      pieces.push({ start: from, bytes: range.bytes.slice(from - range.start, to - range.start) });
      touch(range);
    }
    return pieces;
  }

  /** Keep `bytes` of `key` at `start`, unless ranges kept already hold them. */
  function keep(key, start, bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > budgetBytes || !Number.isSafeInteger(start) || start < 0) return;
    const end = start + bytes.length;
    let ranges = files.get(key);
    if (ranges === undefined) {
      ranges = [];
      files.set(key, ranges);
    }
    // Ranges the new one holds whole are replaced by it; one that holds it
    // whole makes it a repeat.
    for (const range of ranges.slice()) {
      if (range.start <= start && range.end >= end) {
        touch(range);
        return;
      }
      if (range.start >= start && range.end <= end) drop(range);
    }
    ranges = files.get(key) ?? [];
    if (!files.has(key)) files.set(key, ranges);
    const range = { key, start, end, bytes };
    let at = ranges.findIndex(other => other.start > start);
    if (at < 0) at = ranges.length;
    ranges.splice(at, 0, range);
    order.add(range);
    bytesKept += bytes.length;
    for (const oldest of order) {
      if (bytesKept <= budgetBytes) break;
      drop(oldest);
    }
  }

  return Object.freeze({
    lookup,
    keep,
    /**
     * Answer one reader worker through `port` until the returned function
     * is called (the worker ended): it closes the port.
     */
    connect(port) {
      port.onmessage = event => {
        const message = event.data ?? {};
        if (message.keep !== undefined) {
          keep(message.keep.key, message.keep.start, message.keep.bytes);
          return;
        }
        if (message.holds !== undefined) {
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
      return () => {
        if (!open) return;
        open = false;
        channels--;
        port.onmessage = null;
        port.close();
      };
    },
    stats: () => ({ bytes: bytesKept, ranges: order.size, files: files.size, channels }),
    clear() {
      files.clear();
      order.clear();
      bytesKept = 0;
    },
  });
}

/** @type {ReturnType<typeof createByteRangeCache>|null} */
let shared = null;

/** The page's cache, made on first use. */
export function pageByteRangeCache() {
  shared ??= createByteRangeCache({ budgetBytes: residencyBudgetBytes('fetchedRanges') });
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
