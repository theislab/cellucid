/**
 * Bytes of a remote file kept beyond one reader: the worker side.
 *
 * Opening the same file again in a new reader worker (another cell subset of
 * it, read as a new dataset generation while the old one stays shown) would
 * fetch again every byte the old one fetched: the file's structure, its
 * chunk indexes, the chunks both subsets share. The page keeps the ranges
 * its readers fetched (`data/byte-range-cache.js`, bounded by the page's
 * memory budget) and each reader worker reaches it through a `MessagePort`
 * (`adoptRangeCachePort`, posted when the worker starts). A source read
 * through it (`withRangeCache`) asks the page for the bytes it holds of a
 * range first, fetches only the parts it does not hold, and hands those to
 * the page to keep.
 *
 * A file is kept under a key that names its bytes exactly (`rangeCacheKey`:
 * its identity's key and version, or its URL with its size and `ETag`); a
 * file known by no validator is not kept, so bytes of two versions are never
 * mixed.
 *
 * The page answers from its main thread, which a long task may hold, so a
 * read asks it only for ranges it is known to hold: the worker asks once a
 * file which ranges the page holds of it (`holds`), and adds the ranges it
 * hands the page itself; a read that touches none of them is fetched at
 * once (opening a file nothing read before waited a round trip for the page
 * at each of its dependent reads -- 99 of HLCA's 245 first reads, the page
 * busy opening). A read that touches them waits for the page's pieces no
 * longer than one round trip of the file's link (asking the page is never
 * to cost more than asking the host; before the link is measured, no longer
 * than the host is given to answer), and fetches the whole range when they
 * have not come by then; a late answer is dropped. Without a link the page
 * is not asked. A read's cancellation ends the wait at once.
 *
 * @module formats/io/range-cache
 */

import { SharedWork, onAbort } from './abort.js';
import { allocateTypedArray } from '../../data/sparse-column-index.js';

/** @type {{port: MessagePort, next: number, waiting: Map<number, (pieces: Array<{start: number, bytes: Uint8Array}>) => void>}|null} */
let channel = null;

/**
 * Reach the page's range cache through `port` (null: no longer). Requests
 * waiting on an earlier port are answered empty.
 *
 * @param {MessagePort|null} port
 */
export function adoptRangeCachePort(port) {
  if (port !== null && (typeof port !== 'object' || typeof port.postMessage !== 'function')) {
    throw new TypeError('A range cache port is a MessagePort or null.');
  }
  if (channel !== null) {
    const old = channel;
    channel = null;
    for (const answer of [...old.waiting.values()]) answer([]);
    old.waiting.clear();
    old.port.onmessage = null;
    old.port.close?.();
  }
  channel = null;
  if (port === null) return;
  const own = { port, next: 1, waiting: new Map(), files: new Map() };
  port.onmessage = event => {
    const { id, pieces, held } = event.data ?? {};
    // The waiter settles itself (and stops its deadline); a late answer of
    // pieces finds none. A late answer of what the page holds is still
    // learnt.
    const waiter = own.waiting.get(id);
    if (waiter !== undefined) {
      own.late.delete(id);
      waiter(Array.isArray(held) ? held : Array.isArray(pieces) ? pieces : []);
    }
    else if (Array.isArray(held)) own.late.get(id)?.(held);
  };
  own.late = new Map();
  // The page ended the channel (its reader closed): nothing more is asked of it.
  port.addEventListener?.('close', () => {
    if (channel === own) adoptRangeCachePort(null);
  });
  port.start?.();
  // As in a browser, a port keeps nothing alive (`data/byte-range-cache.js`).
  port.unref?.();
  channel = own;
}

/** Whether this realm reaches a range cache. */
export function hasRangeCache() {
  return channel !== null;
}

/**
 * The key a remote file's ranges are kept under, or null when nothing names
 * its version (it may change under the same address and size).
 *
 * @param {{url: string, size: number, identity?: Object|null, head?: {etag?: string|null}|null}} file
 * @returns {string|null}
 */
export function rangeCacheKey(file) {
  const identity = file?.identity ?? null;
  const version = typeof identity?.version === 'string' && !identity.version.startsWith('size:') ? identity.version : null;
  if (typeof identity?.key === 'string' && version !== null) {
    return JSON.stringify(['remote', identity.key, version, file.size]);
  }
  const etag = file?.head?.etag ?? null;
  if (typeof etag === 'string' && typeof file?.url === 'string') return JSON.stringify(['url', file.url, file.size, etag]);
  return null;
}

/**
 * Ask the page through `own`; resolves its answer, or `[]` when it does not
 * answer within `deadlineMs` or `signal` aborts first.
 */
function ask(own, message, deadlineMs, signal) {
  if (!(deadlineMs > 0) || signal?.aborted) return Promise.resolve([]);
  return new Promise(resolve => {
    const id = own.next++;
    let timer = null;
    let stopWaiting = () => {};
    const finish = pieces => {
      if (!own.waiting.has(id)) return;
      own.waiting.delete(id);
      clearTimeout(timer);
      stopWaiting();
      resolve(pieces);
    };
    own.waiting.set(id, finish);
    timer = setTimeout(() => finish([]), deadlineMs);
    stopWaiting = onAbort(signal, () => finish([]));
    try {
      own.port.postMessage({ id, ...message });
    } catch {
      finish([]);
    }
  });
}

/**
 * What this worker knows the page holds of `key`: ranges `[start, end)`,
 * sorted and joined. Asked of the page once (`holds`, waited for no longer
 * than `deadlineMs`; a later answer is learnt when it comes), then grown by
 * the ranges this worker hands it.
 */
function heldRanges(own, key, deadlineMs, signal) {
  let file = own.files.get(key);
  if (file === undefined) {
    file = { ranges: [], asked: null };
    own.files.set(key, file);
  }
  // Asked once for every read of the file (`SharedWork`): the question is
  // let go only once every read waiting for it withdrew, and is then asked
  // again by the next read.
  if (file.asked === null || file.asked.abandoned) {
    const learn = held => {
      for (const range of held) {
        if (Array.isArray(range) && Number.isSafeInteger(range[0]) && Number.isSafeInteger(range[1]) && range[1] > range[0]) addRange(file, range[0], range[1]);
      }
    };
    file.asked = new SharedWork(askSignal => {
      const id = own.next;
      own.late.set(id, held => {
        own.late.delete(id);
        learn(held);
      });
      return ask(own, { holds: { key } }, deadlineMs, askSignal).then(learn);
    });
  }
  return file.asked.join(signal).then(() => file.ranges);
}

/** Join `[start, end)` into a file's known ranges. */
function addRange(file, start, end) {
  const ranges = file.ranges;
  let at = 0;
  while (at < ranges.length && ranges[at][1] < start) at++;
  let last = at;
  while (last < ranges.length && ranges[last][0] <= end) {
    start = Math.min(start, ranges[last][0]);
    end = Math.max(end, ranges[last][1]);
    last++;
  }
  ranges.splice(at, last - at, [start, end]);
}

/** Whether `[offset, offset + length)` touches any of `ranges`. */
function touches(ranges, offset, length) {
  const end = offset + length;
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle][1] <= offset) low = middle + 1;
    else high = middle;
  }
  return low < ranges.length && ranges[low][0] < end;
}

/**
 * The pieces of `[offset, offset + length)` the page holds of `key`, or none
 * when it has no cache, is not known to hold any of them, does not answer
 * within `deadlineMs`, or `signal` aborts first.
 */
async function lookup(key, offset, length, deadlineMs, signal) {
  const own = channel;
  if (own === null || !(deadlineMs > 0) || signal?.aborted) return [];
  const ranges = await heldRanges(own, key, deadlineMs, signal);
  if (!touches(ranges, offset, length)) return [];
  return ask(own, { lookup: { key, offset, length } }, deadlineMs, signal);
}

/** Hand bytes fetched of `key` at `start` to the page (a copy of exactly them). */
function keep(key, start, bytes) {
  const own = channel;
  if (own === null || bytes.length === 0) return;
  const file = own.files.get(key);
  if (file !== undefined) addRange(file, start, start + bytes.length);
  const copy = bytes.slice();
  try {
    own.port.postMessage({ keep: { key, start, bytes: copy } }, [copy.buffer]);
  } catch {
    // The page is gone: nothing is kept.
  }
}

/**
 * `source`, read through the page's range cache under `key`: each read is
 * answered from the bytes the page holds where it holds them, and fetched
 * from `source` where it does not (only those parts), which the page then
 * keeps. Without a cache in this realm, or without a key, `source` itself.
 *
 * @param {import('./byte-source.js').ByteSource} source
 * @param {string|null} key - `rangeCacheKey` of the file
 * @returns {import('./byte-source.js').ByteSource}
 */
export function withRangeCache(source, key) {
  if (key === null || channel === null) return source;
  const read = async (offset, length, options = {}) => {
    if (length === 0) return source.read(offset, length, options);
    // No longer than a round trip of the link; before one is measured, no
    // longer than the host itself is given to answer (`ResponseClock`).
    const latency = options.link?.latencyMs;
    const bound = Number.isFinite(latency) ? latency : (options.link?.responses?.timeoutMs ?? 0);
    const pieces = (await lookup(key, offset, length, bound, options.signal ?? null))
      .filter(piece => Number.isSafeInteger(piece?.start) && piece.bytes instanceof Uint8Array &&
        piece.start >= offset && piece.start + piece.bytes.length <= offset + length)
      .sort((left, right) => left.start - right.start);
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('The read was aborted.', 'AbortError');
    // The parts no piece holds, fetched at once.
    const parts = [];
    let at = offset;
    const held = [];
    for (const piece of pieces) {
      if (piece.start + piece.bytes.length <= at) continue;
      if (piece.start > at) parts.push({ start: at, end: piece.start });
      const from = Math.max(at, piece.start);
      held.push({ start: from, bytes: piece.bytes.subarray(from - piece.start) });
      at = piece.start + piece.bytes.length;
    }
    if (at < offset + length) parts.push({ start: at, end: offset + length });
    // The request's round trip starts now, not when the page was asked.
    options.onFetch?.();
    if (held.length === 0) {
      const bytes = await source.read(offset, length, options);
      keep(key, offset, bytes);
      return bytes;
    }
    options.onHeld?.();
    const fetched = await Promise.all(parts.map(part => source.read(part.start, part.end - part.start, options)));
    const out = allocateTypedArray(Uint8Array, length, 'Read bytes');
    for (const piece of held) out.set(piece.bytes, piece.start - offset);
    parts.forEach((part, index) => {
      out.set(fetched[index], part.start - offset);
      keep(key, part.start, fetched[index]);
    });
    return out;
  };
  return Object.freeze({ ...source, read });
}
