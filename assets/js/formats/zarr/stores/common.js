/**
 * What every store backend shares: the backend interface, a concurrency
 * limit, and finding the store root inside a zipped or picked folder.
 *
 * A store backend serves the keys of one Zarr store (`zarr.json`,
 * `obs/.zarray`, `X/c/0/1`, ...):
 *
 * - `get(key, options)` → the bytes, or null when the key is absent (an
 *   absent chunk reads as the fill value);
 * - `getMany(keys, options)` → the same for many keys, fetched together;
 * - `getRanges(key, ranges, options)` → byte ranges of one key
 *   (`{offset, length}`, or `{suffix}` for the last bytes), or null when the
 *   key is absent: a sharded array reads a shard's index and only the inner
 *   chunks it needs;
 * - `storedSize(key)` → the key's stored bytes, 0 when absent, or null when
 *   the backend cannot tell without fetching (a web host);
 * - `list()` (when the backend can list) → every key;
 * - `stats()` → `{requests, bytes}` fetched so far.
 *
 * `options` is `{signal, activity}`: the signal cancels, and `activity`
 * (`{fetched(bytes, requests), ...}`) hears about every transfer.
 *
 * @module formats/zarr/stores/common
 */

import { isMacOSMetadata } from '../../zip/names.js';

/** Files that mark the root of a Zarr store. */
export const ROOT_MARKERS = Object.freeze(['zarr.json', '.zgroup', '.zarray', '.zmetadata', '.zattrs']);

/** A first-in first-out queue: O(1) at both ends, however long it grows. */
class Fifo {
  constructor() {
    this.items = [];
    this.head = 0;
  }

  get size() {
    return this.items.length - this.head;
  }

  push(item) {
    this.items.push(item);
  }

  peek() {
    return this.items[this.head];
  }

  shift() {
    const item = this.items[this.head];
    this.items[this.head++] = undefined;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }
}

/**
 * Run at most `limit` tasks at once; the rest wait in order. A task of
 * background work (its `activity` is marked `background`, as an index built
 * ahead of need) waits while any other task waits, and never takes the last
 * free slot: a read a view waits for starts at once, however much background
 * work is queued (the byte reader's rule, for stores that fetch on their own).
 * An activity can stop being background while its tasks wait (a view starts
 * waiting for the index): from then on its tasks are served as any other, in
 * the order they were asked for.
 *
 * Waiting tasks are kept per activity, so choosing the next one costs a look
 * at each waiting activity, never a pass over every waiting task: a read of
 * 25,000 chunk files queues 25,000 tasks.
 *
 * `limit` is a number, or a link (`formats/io/link.js`) whose concurrency
 * follows the protocol in use, whose background concurrency bounds the
 * background tasks, and which is told how many tasks wait.
 *
 * @param {number|{concurrency: number, backgroundConcurrency: number, waiting: (count: number) => void}} limit
 * @returns {<T>(task: () => Promise<T>, signal?: AbortSignal|null, activity?: {background?: boolean}|null) => Promise<T>}
 */
export function createLimiter(limit) {
  const link = typeof limit === 'number' ? null : limit;
  const slots = link === null ? () => limit : () => link.concurrency;
  const backgroundSlots = link === null ? () => Math.max(1, limit - 1) : () => link.backgroundConcurrency;
  let running = 0;
  let runningBackground = 0;
  let waitingCount = 0;
  let order = 0;
  /** Tasks of no background activity (they never become background). */
  const foreground = new Fifo();
  /** Tasks of each background activity, by activity, until it is served. */
  const byActivity = new Map();

  /** The earliest waiting queue whose head may start now (null: none may). */
  function chooseQueue() {
    let best = foreground.size > 0 ? foreground : null;
    let bestBackground = null;
    for (const [activity, queue] of byActivity) {
      if (queue.size === 0) {
        byActivity.delete(activity);
        continue;
      }
      if (activity.background !== true) {
        if (best === null || queue.peek().order < best.peek().order) best = queue;
      } else if (bestBackground === null || queue.peek().order < bestBackground.peek().order) {
        bestBackground = queue;
      }
    }
    if (best !== null) return best;
    // Only background work waits: it may use every slot but one.
    if (bestBackground !== null && runningBackground < backgroundSlots()) return bestBackground;
    return null;
  }

  const next = () => {
    while (running < slots() && waitingCount > 0) {
      const queue = chooseQueue();
      if (queue === null) break;
      const job = queue.shift();
      waitingCount--;
      if (job.signal?.aborted) {
        job.reject(job.signal.reason ?? new DOMException('The read was aborted.', 'AbortError'));
        continue;
      }
      const background = job.activity?.background === true;
      running++;
      if (background) runningBackground++;
      job.task().then(job.resolve, job.reject).finally(() => {
        running--;
        if (background) runningBackground--;
        next();
      });
    }
    link?.waiting(waitingCount);
  };
  return (task, signal = null, activity = null) => new Promise((resolve, reject) => {
    const job = { task, resolve, reject, signal, activity, order: order++ };
    if (activity?.background === true) {
      let queue = byActivity.get(activity);
      if (queue === undefined) byActivity.set(activity, queue = new Fifo());
      queue.push(job);
    } else {
      foreground.push(job);
    }
    waitingCount++;
    next();
  });
}

/**
 * Run `callback` on a later macrotask: after the current task and all of its
 * promise continuations, so requests asked for in one burst are planned
 * together.
 */
export const nextTask = (() => {
  if (typeof setImmediate === 'function') return callback => setImmediate(callback);
  if (typeof MessageChannel === 'function') {
    const channel = new MessageChannel();
    const queue = [];
    channel.port1.onmessage = () => queue.shift()();
    return callback => {
      queue.push(callback);
      channel.port2.postMessage(0);
    };
  }
  return callback => setTimeout(callback, 0);
})();

/**
 * Normalise a relative path: `/` separators, no leading `./` or `/`.
 *
 * @param {string} path
 */
export function normalizeKey(path) {
  return String(path).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

/**
 * The folder prefix (`''` or `'name/'`) under which `keys` hold a Zarr store:
 * the top level when a root marker is there, else the one folder every key
 * lies in when the marker is inside it (a zipped or picked `.zarr` folder).
 *
 * @param {Iterable<string>} keys
 * @returns {string|null} null when no store root is found
 */
export function storeRootPrefix(keys) {
  const all = [...keys].filter(key => !isMacOSMetadata(key));
  const set = new Set(all);
  if (ROOT_MARKERS.some(marker => set.has(marker))) return '';
  let folder = null;
  for (const key of all) {
    const slash = key.indexOf('/');
    if (slash <= 0) return null;
    const first = key.slice(0, slash);
    if (folder === null) folder = first;
    else if (folder !== first) return null;
  }
  if (folder === null) return null;
  const prefix = `${folder}/`;
  return ROOT_MARKERS.some(marker => set.has(prefix + marker)) ? prefix : null;
}

/**
 * Merge byte ranges into requests: ranges closer than `gap` share one, and
 * no request grows past `maxBytes`. Returns requests `{start, end, members}`
 * where members are indexes of `ranges`.
 *
 * @param {Array<{offset: number, length: number}>} ranges
 * @param {number} gap
 * @param {number} maxBytes
 */
export function mergeRanges(ranges, gap, maxBytes) {
  const order = ranges.map((range, index) => index).sort((a, b) => ranges[a].offset - ranges[b].offset);
  const requests = [];
  let current = null;
  for (const index of order) {
    const { offset, length } = ranges[index];
    const end = offset + length;
    if (current !== null && offset - current.end <= gap && Math.max(end, current.end) - current.start <= maxBytes) {
      current.end = Math.max(current.end, end);
      current.members.push(index);
    } else {
      current = { start: offset, end, members: [index] };
      requests.push(current);
    }
  }
  return requests;
}
