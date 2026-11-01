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
 * its identity's key and version, or its link's identity with its size and
 * strong `ETag`, `data/sources/identity.js`); a file known by no version is
 * not kept, so bytes of two versions are never mixed. Its address (`rangeCacheAddress`) names it whatever its version:
 * a reader opening a version tells the page to drop the others
 * (`forgetOtherVersionsInMemory`), and one whose file changed on its host
 * while open to drop every version (`forgetFileInMemory`).
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

import { SharedWork, onAbort, throwIfAborted } from '../../utils/abort.js';
import { allocateTypedArray } from '../../data/sparse-column-index.js';
import { planMergeGap } from './byte-reader.js';
import { linkIdentity } from '../../data/sources/link-credentials.js';
import { persistsAcrossVisits, strongEtag } from '../../data/sources/identity.js';

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
    // The page closes its end once it has every range told on this one
    // (`endRangeCachePort`), as when the reader leaves.
    endChannel(old);
    old.port.close?.();
  }
  channel = null;
  if (port === null) return;
  const own = { port, next: 1, waiting: new Map(), files: new Map(), stores: new Map() };
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

/**
 * The channel this realm reaches the page's range cache through now, as a
 * handle for `endRangeCachePort`; null when it reaches none.
 *
 * @returns {object|null}
 */
export function rangeCacheChannel() {
  return channel;
}

/**
 * The reader leaves (`{leave: true}`, `anndata-reader-worker.js`): the page
 * is told it may close its end of `own` (`{end: true}`, a handle taken with
 * `rangeCacheChannel` as the reader was asked to leave), after every range
 * this reader told it to keep (`keep`) on the same port, so none is dropped
 * by a page that closed the channel as the reader closed. Nothing more is
 * asked of the page; the worker ends itself next, and its port with it. A
 * channel adopted since (a realm hosting another reader, as tests run them
 * in one thread) is not this reader's and stays.
 *
 * @param {object|null} own
 */
export function endRangeCachePort(own) {
  if (own === null || own === undefined) return;
  if (channel === own) {
    channel = null;
    for (const answer of [...own.waiting.values()]) answer([]);
    own.waiting.clear();
  }
  endChannel(own);
}

/** Tell the page one channel has ended (`{end: true}`), once. */
function endChannel(own) {
  if (own.ended === true) return;
  own.ended = true;
  try {
    own.port.postMessage({ end: true });
  } catch {
    // The page's end is gone already.
  }
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
  if (identity?.kind === 'remote' && typeof identity.key === 'string' && persistsAcrossVisits(identity)) {
    return JSON.stringify(['remote', identity.key, identity.version, file.size]);
  }
  // Only a strong ETag names the bytes (`strongEtag`); the link by its identity, never its credentials.
  const etag = strongEtag(file?.head?.etag ?? null);
  if (etag !== null && typeof file?.url === 'string') return JSON.stringify(['url', linkIdentity(file.url), file.size, etag]);
  return null;
}

/**
 * What names a remote file whatever its version: its identity's key, or
 * its URL's identity (`linkIdentity`: no credential); null when neither does.
 *
 * @param {{url?: string, identity?: Object|null}} file
 * @returns {string|null}
 */
export function rangeCacheAddress(file) {
  const identity = file?.identity ?? null;
  if (typeof identity?.key === 'string') return JSON.stringify(['remote', identity.key]);
  return typeof file?.url === 'string' ? JSON.stringify(['url', linkIdentity(file.url)]) : null;
}

/** Tell the page to drop what it keeps of the file at `address` under any key but `keep` (null: all). */
function forgetInMemory(address, keep) {
  const own = channel;
  if (own === null || address === null) return;
  for (const [key, file] of own.files) if (key !== keep && file.address === address) own.files.delete(key);
  try {
    own.port.postMessage({ forget: { address, keep } });
  } catch {
    // The page is gone: nothing is kept.
  }
}

/** Opening this version of `file`: the page drops what it keeps of its other versions. */
export function forgetOtherVersionsInMemory(file) {
  forgetInMemory(rangeCacheAddress(file), rangeCacheKey(file));
}

/** `file` changed on its host while open: the page drops what it keeps of every version of it. */
export function forgetFileInMemory(file) {
  forgetInMemory(rangeCacheAddress(file), null);
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

/** Hand bytes fetched of `key` (at `address`) at `start` to the page (a copy of exactly them). */
function keep(key, start, bytes, address) {
  const own = channel;
  if (own === null || bytes.length === 0) return;
  const file = own.files.get(key);
  if (file !== undefined) {
    addRange(file, start, start + bytes.length);
    file.address = address;
  }
  const copy = bytes.slice();
  try {
    own.port.postMessage({ keep: { key, start, bytes: copy, address } }, [copy.buffer]);
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
 * @param {string|null} [address] - `rangeCacheAddress` of the file
 * @returns {import('./byte-source.js').ByteSource}
 */
export function withRangeCache(source, key, address = null) {
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
    throwIfAborted(options.signal);
    // The parts no piece holds, fetched at once.
    let parts = [];
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
    // Each part is a request of its own, and a held piece between two parts
    // splits them: one smaller than the gap worth fetching to save a request
    // on this link (`planMergeGap`, as the byte reader prices its plans) is
    // fetched again with its neighbours. Held chunks scattered through a
    // read (a gene read before, the first view's cells) would otherwise turn
    // one request into as many as there are pieces, a round trip each.
    if (parts.length > 1 && options.link?.measured) {
      const worth = planMergeGap(parts, options.link, options.link.maxRequestBytes);
      const joined = [parts[0]];
      for (const part of parts.slice(1)) {
        const last = joined[joined.length - 1];
        if (part.start - last.end <= worth) last.end = part.end;
        else joined.push(part);
      }
      parts = joined;
    }
    // The request's round trip starts now, not when the page was asked.
    options.onFetch?.();
    // A read made once (a cell export, `keepInMemory: false`) keeps nothing.
    const keeping = options.keepInMemory !== false;
    if (held.length === 0) {
      const bytes = await source.read(offset, length, options);
      if (keeping) keep(key, offset, bytes, address);
      return bytes;
    }
    options.onHeld?.();
    const fetched = await Promise.all(parts.map(part => source.read(part.start, part.end - part.start, options)));
    const out = allocateTypedArray(Uint8Array, length, 'Read bytes');
    for (const piece of held) out.set(piece.bytes, piece.start - offset);
    parts.forEach((part, index) => {
      out.set(fetched[index], part.start - offset);
      if (keeping) keep(key, part.start, fetched[index], address);
    });
    return out;
  };
  return Object.freeze({ ...source, read });
}


/**
 * The prefix a store's objects are kept under in the page (a Zarr folder on
 * a web host, `formats/zarr/stores/http.js`: every object a file of its
 * own), or null when nothing names the store's version: its address by its
 * link's identity (never its credentials) and the validator its host gave
 * its consolidated metadata (`validatorOf`: a strong `ETag`, a
 * `Last-Modified`), which a rewritten store changes. Tab-only, as a file's
 * ranges are: across visits a store is kept only under a content name
 * (`kept-parts.js`).
 *
 * @param {string} url - The store's URL
 * @param {string|null} version
 * @returns {string|null}
 */
export function storeObjectsKey(url, version) {
  if (typeof url !== 'string' || typeof version !== 'string' || version === '') return null;
  return JSON.stringify(['store', linkIdentity(url), version]);
}

/** A file entry of the worker side known without asking the page (`stores`). */
const KNOWN = Object.freeze({ abandoned: false, join: () => Promise.resolve() });

function knownFile(own, key) {
  let file = own.files.get(key);
  if (file === undefined) {
    file = { ranges: [], asked: KNOWN };
    own.files.set(key, file);
  }
  return file;
}

/**
 * Ask the page once a store which of its objects it holds (`holds` by
 * prefix), however many objects are read: a store has thousands, and
 * asking each would cost each first read of an object a wait for the page.
 */
function storeHeld(own, prefix, deadlineMs, signal) {
  let store = own.stores.get(prefix);
  if (store === undefined) {
    store = { asked: null };
    own.stores.set(prefix, store);
  }
  if (store.asked === null || store.asked.abandoned) {
    const learn = held => {
      for (const entry of held) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[0].startsWith(prefix)) continue;
        const [key, start, end] = entry;
        if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start) addRange(knownFile(own, key), start, end);
      }
    };
    store.asked = new SharedWork(askSignal => {
      const id = own.next;
      own.late.set(id, held => {
        own.late.delete(id);
        learn(held);
      });
      return ask(own, { holds: { prefix } }, deadlineMs, askSignal).then(learn);
    });
  }
  return store.asked.join(signal);
}

/**
 * The objects of one store version kept in the page (`storeObjectsKey`):
 * an object read whole is kept as itself, and byte ranges of an object (a
 * shard's inner chunks) as its ranges. A read asks the page only for what
 * it holds, and waits for the page's answer no longer than a round trip of
 * the store's link (as `withRangeCache`); what it fetches it hands the page.
 * Null when the store names no version or this realm reaches no cache.
 *
 * @param {string|null} prefix - `storeObjectsKey`
 * @returns {{whole: Function, range: Function, suffix: Function, keepWhole: Function, keepRange: Function, keepSuffix: Function}|null}
 */
export function storeObjects(prefix) {
  if (prefix === null || channel === null) return null;
  // Whole objects and ranges of objects apart: a range held from an
  // object's start is not the object.
  const wholeKey = key => `${prefix}\u0000${key}`;
  const rangeKey = key => `${prefix}\u0001${key}`;
  // An object's last bytes, asked for by their count (a shard's index, read
  // before its object's size is known): kept as an object of their own.
  const suffixKey = (key, length) => `${prefix}\u0002${length}\u0000${key}`;
  const boundOf = link => {
    const latency = link?.latencyMs;
    return Number.isFinite(latency) ? latency : (link?.responses?.timeoutMs ?? 0);
  };
  /** The page's bytes `[start, end)` under `key` when it holds them all, else null. */
  const piece = async (own, key, start, end, bound, signal) => {
    const pieces = await ask(own, { lookup: { key, offset: start, length: end - start } }, bound, signal);
    const found = pieces.find(candidate => Number.isSafeInteger(candidate?.start) && candidate.bytes instanceof Uint8Array &&
      candidate.start <= start && candidate.start + candidate.bytes.length >= end);
    return found === undefined ? null : found.bytes.subarray(start - found.start, end - found.start);
  };
  /** What the page holds of the store, once known: null when it cannot be asked. */
  const known = async (link, signal) => {
    const own = channel;
    const bound = boundOf(link);
    if (own === null || !(bound > 0) || signal?.aborted) return null;
    await storeHeld(own, prefix, bound, signal);
    return channel === own ? { own, bound } : null;
  };
  return Object.freeze({
    /** Object `key` whole, when the page holds it; else null. */
    async whole(key, { link = null, signal = null } = {}) {
      const at = await known(link, signal);
      const range = at?.own.files.get(wholeKey(key))?.ranges[0];
      if (range === undefined || range[0] !== 0) return null;
      return piece(at.own, wholeKey(key), 0, range[1], at.bound, signal);
    },
    /** Bytes `[start, end)` of object `key`, when the page holds them (the object whole, or those bytes); else null. */
    async range(key, start, end, { link = null, signal = null } = {}) {
      const at = await known(link, signal);
      if (at === null) return null;
      for (const kept of [wholeKey(key), rangeKey(key)]) {
        const ranges = at.own.files.get(kept)?.ranges ?? [];
        if (ranges.some(range => range[0] <= start && range[1] >= end)) {
          const bytes = await piece(at.own, kept, start, end, at.bound, signal);
          if (bytes !== null) return bytes;
        }
      }
      return null;
    },
    /** The last `length` bytes of object `key`, when the page holds them; else null. */
    async suffix(key, length, { link = null, signal = null } = {}) {
      const at = await known(link, signal);
      const range = at?.own.files.get(suffixKey(key, length))?.ranges[0];
      if (range === undefined || range[0] !== 0 || range[1] !== length) return null;
      return piece(at.own, suffixKey(key, length), 0, length, at.bound, signal);
    },
    /** Hand the page the last `bytes.length` bytes of object `key`. */
    keepSuffix(key, bytes) {
      if (channel === null) return;
      knownFile(channel, suffixKey(key, bytes.length));
      keep(suffixKey(key, bytes.length), 0, bytes, null);
    },
    /** Hand the page object `key`, fetched whole. */
    keepWhole(key, bytes) {
      if (channel === null) return;
      knownFile(channel, wholeKey(key));
      keep(wholeKey(key), 0, bytes, null);
    },
    /** Hand the page bytes of object `key` fetched at `start`. */
    keepRange(key, start, bytes) {
      if (channel === null) return;
      knownFile(channel, rangeKey(key));
      keep(rangeKey(key), start, bytes, null);
    },
  });
}
