/**
 * @fileoverview One scheduler for dataset field reads: what the user is
 * looking at goes first, and the same field is never read twice at once.
 *
 * Every read is one of four kinds:
 * - `high`: what the user just asked for and is waiting to see (a chosen gene,
 *   the field a view is coloured by);
 * - `normal`: work the user started and is watching (a gene signature, a
 *   correlation);
 * - `bulk`: one of many requests of a long run (differential expression,
 *   marker discovery), which bounds its own concurrency;
 * - `low`: speculative (prefetch on intent).
 *
 * `high` and `normal` reads start at once. `bulk` and `low` reads wait while
 * any `high` or `normal` read is in flight: the reads a long run already
 * started finish, but no new one competes with the user's, so a gene chosen
 * during a 5,000-gene run is not shared out among a dozen of the run's reads.
 * Waiting reads start in priority order (`bulk` before `low`), each kind first
 * come, first served, and no more of them run at once than requests the
 * dataset's source answers at once (`backgroundConcurrency`): every read
 * needs at most that many requests' worth of the link, and more would only
 * queue behind the reader's slots, where priority no longer applies. The
 * bound is the source's, reported by its reader (`setSourceRequestConcurrency`):
 * six to an HTTP/1.1 host until a reader says otherwise, the host's streams
 * over HTTP/2 or HTTP/3, and no bound (Infinity) for a source whose reads
 * cost no request (a local file, or reads answered from memory).
 *
 * Downloads are keyed (by URL, or by the object of a load that already shares
 * itself among its callers). A request for a key already queued or in flight
 * joins it, raising its priority if the newcomer's is higher (a prefetched
 * gene the user then chooses becomes `high`); one shared download serves every
 * caller, and it is cancelled only when every caller has cancelled. Each
 * caller's own signal still ends that caller's wait at once. `raise` raises a
 * download's priority without joining it, for a load whose callers share it
 * before they reach the scheduler.
 *
 * A scheduler belongs to one dataset generation (`field/loading.js` keeps one
 * per generation): when the dataset is replaced it is closed, which aborts and
 * rejects everything it holds, so a download of the old dataset that never
 * settles cannot count as in flight for the new one.
 *
 * @module data/fetch-scheduler
 */

import { onAbort } from '../formats/io/abort.js';
import { REMOTE_POLICY } from '../formats/io/byte-source.js';

/** @typedef {'high'|'normal'|'bulk'|'low'} DownloadPriority */

/** Requests the open dataset's source answers at once, as its reader last reported. */
let sourceRequestConcurrency = REMOTE_POLICY.concurrency;
/** Schedulers that follow it, drained again when it rises. */
const followers = new Set();

function requireConcurrency(value) {
  if (!(value === Infinity || (Number.isSafeInteger(value) && value >= 1))) {
    throw new TypeError('Background concurrency must be a positive whole number or Infinity.');
  }
  return value;
}

/**
 * Report how many requests the open dataset's source answers at once (the
 * reader's link: its concurrency, or Infinity when reads cost no request).
 * Every scheduler created without its own bound follows it at once.
 *
 * @param {number} value
 */
export function setSourceRequestConcurrency(value) {
  sourceRequestConcurrency = requireConcurrency(value);
  for (const scheduler of followers) scheduler._drain();
}

const RANK = Object.freeze({ high: 0, normal: 1, bulk: 2, low: 3 });

/**
 * Whether a download of this priority starts without waiting.
 * @param {DownloadPriority} priority
 */
function isForeground(priority) {
  return RANK[priority] <= RANK.normal;
}

/**
 * @param {unknown} priority
 * @returns {DownloadPriority}
 */
export function requirePriority(priority) {
  if (typeof priority !== 'string' || !Object.hasOwn(RANK, priority)) {
    throw new TypeError(
      'Download priority must be exactly "high", "normal", "bulk" or "low".'
    );
  }
  return /** @type {DownloadPriority} */ (priority);
}

function abortReason(signal) {
  return signal.reason ?? new DOMException('The download was cancelled.', 'AbortError');
}

/**
 * @template T
 * @typedef {{
 *   key: string|object,
 *   priority: DownloadPriority,
 *   sequence: number,
 *   start: (signal: AbortSignal, priority: DownloadPriority) => Promise<T>,
 *   controller: AbortController,
 *   waiters: number,
 *   promise: Promise<T>,
 *   resolve: (value: T) => void,
 *   reject: (reason: unknown) => void,
 *   state: 'queued'|'running',
 * }} Download
 */

/** Whether `left` starts before `right`: higher priority, then first come. */
function startsBefore(left, right) {
  return left.rank - right.rank || left.sequence - right.sequence;
}

export class FetchScheduler {
  /**
   * @param {{backgroundConcurrency?: number}} [options] - Background reads in
   *   flight at once; without it, the source's (`setSourceRequestConcurrency`).
   */
  constructor({ backgroundConcurrency } = {}) {
    this._ownConcurrency = backgroundConcurrency === undefined ? null : requireConcurrency(backgroundConcurrency);
    if (this._ownConcurrency === null) followers.add(this);
    /** @type {Map<string|object, Download<unknown>>} */
    this._downloads = new Map();
    /**
     * Queued downloads as a binary heap of `{download, rank, sequence}`, best
     * first; an entry whose download started or changed priority since is
     * skipped when it comes up.
     * @type {Array<{download: Download<unknown>, rank: number, sequence: number}>}
     */
    this._queued = [];
    this._backgroundInFlight = 0;
    this._foregroundInFlight = 0;
    this._sequence = 0;
    /** @type {unknown} Why the scheduler was closed, once it is. */
    this._closedReason = null;
  }

  /**
   * End every download, queued or in flight, and refuse new ones: the dataset
   * these downloads belong to was replaced. Each download is aborted (its
   * `start` signal fires) and every waiter is rejected with `reason` at once,
   * whether or not the download honours its signal, so nothing of one dataset
   * can hold back another's downloads.
   *
   * @param {unknown} reason
   */
  close(reason) {
    if (this._closedReason !== null) return;
    this._closedReason = reason ?? new DOMException('The downloads were closed.', 'AbortError');
    followers.delete(this);
    for (const download of [...this._downloads.values()]) {
      download.controller.abort(this._closedReason);
      download.reject(this._closedReason);
    }
    this._downloads.clear();
    this._queued = [];
    this._foregroundInFlight = 0;
    this._backgroundInFlight = 0;
  }

  /** Downloads in flight and waiting, for diagnostics and tests. */
  get stats() {
    let queued = 0;
    let running = 0;
    for (const download of this._downloads.values()) {
      if (download.state === 'queued') queued += 1;
      else running += 1;
    }
    return {
      queued,
      running,
      foregroundInFlight: this._foregroundInFlight,
      backgroundInFlight: this._backgroundInFlight,
    };
  }

  /**
   * Run (or join) the download of `key`.
   *
   * @template T
   * @param {{
   *   key: string|object,
   *   priority: DownloadPriority,
   *   signal?: AbortSignal|null,
   *   start: (signal: AbortSignal, priority: DownloadPriority) => Promise<T>,
   * }} request - `start` performs the download under the shared signal, at
   *   the download's priority when it starts; it is called at most once per
   *   key and download.
   * @returns {Promise<T>}
   */
  run({ key, priority, signal = null, start }) {
    if (
      !(typeof key === 'string' && key.length > 0) &&
      !(key !== null && typeof key === 'object')
    ) {
      throw new TypeError('A download needs a non-empty string or object key.');
    }
    requirePriority(priority);
    if (typeof start !== 'function') {
      throw new TypeError('A download needs a start function.');
    }
    if (signal !== null && !(signal instanceof AbortSignal)) {
      throw new TypeError('A download signal must be an AbortSignal or null.');
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this._closedReason !== null) return Promise.reject(this._closedReason);

    let download = this._downloads.get(key);
    if (download === undefined) {
      download = this._create(key, priority, start);
    } else if (RANK[priority] < RANK[download.priority]) {
      this._promote(download, priority);
    }
    return this._wait(download, signal);
  }

  /**
   * Raise the priority of the download of `key`, if it is queued or in flight
   * at a lower one.
   *
   * @param {string|object} key
   * @param {DownloadPriority} priority
   */
  raise(key, priority) {
    requirePriority(priority);
    if (this._closedReason !== null) return;
    const download = this._downloads.get(key);
    if (download !== undefined && RANK[priority] < RANK[download.priority]) {
      this._promote(download, priority);
    }
  }

  _create(key, priority, start) {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // Nobody may be left to observe a cancelled shared download.
    promise.catch(() => {});
    /** @type {Download<unknown>} */
    const download = {
      key,
      priority,
      sequence: this._sequence++,
      start,
      controller: new AbortController(),
      waiters: 0,
      promise,
      resolve,
      reject,
      state: 'queued',
    };
    this._downloads.set(key, download);
    if (isForeground(priority)) this._start(download);
    else this._enqueue(download);
    return download;
  }

  /** Put a queued download in the heap at its priority. @private */
  _enqueue(download) {
    const heap = this._queued;
    const entry = { download, rank: RANK[download.priority], sequence: download.sequence };
    heap.push(entry);
    let at = heap.length - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (startsBefore(heap[parent], entry) <= 0) break;
      heap[at] = heap[parent];
      at = parent;
    }
    heap[at] = entry;
  }

  /** The best queued download still waiting at the priority it was queued with, removed; or null. @private */
  _dequeue() {
    const heap = this._queued;
    while (heap.length > 0) {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length > 0) {
        let at = 0;
        for (;;) {
          const left = 2 * at + 1;
          if (left >= heap.length) break;
          const right = left + 1;
          const child = right < heap.length && startsBefore(heap[right], heap[left]) < 0 ? right : left;
          if (startsBefore(heap[child], last) >= 0) break;
          heap[at] = heap[child];
          at = child;
        }
        heap[at] = last;
      }
      const { download } = top;
      if (download.state === 'queued' && this._downloads.get(download.key) === download &&
          RANK[download.priority] === top.rank) {
        return download;
      }
    }
    return null;
  }

  _promote(download, priority) {
    const wasForeground = isForeground(download.priority);
    download.priority = priority;
    if (download.state === 'queued') {
      if (isForeground(priority)) this._start(download);
      else this._enqueue(download);
    } else if (!wasForeground && isForeground(priority)) {
      // A running background download the user now waits for holds the
      // background back like any foreground download.
      this._foregroundInFlight += 1;
      download.countedForeground = true;
    }
  }

  _start(download) {
    download.state = 'running';
    if (isForeground(download.priority)) {
      this._foregroundInFlight += 1;
      download.countedForeground = true;
    } else {
      this._backgroundInFlight += 1;
      download.countedBackground = true;
    }
    const signal = download.controller.signal;
    // Started in the caller's own turn: the download begins exactly when it
    // would have without the scheduler.
    let started;
    try {
      started = download.start(signal, download.priority);
    } catch (error) {
      started = Promise.reject(error);
    }
    Promise.resolve(started)
      .then(download.resolve, download.reject)
      .finally(() => this._finish(download));
  }

  _finish(download) {
    if (this._closedReason !== null) return;
    if (this._downloads.get(download.key) === download) {
      this._downloads.delete(download.key);
    }
    if (download.countedForeground) {
      download.countedForeground = false;
      this._foregroundInFlight -= 1;
    }
    if (download.countedBackground) {
      download.countedBackground = false;
      this._backgroundInFlight -= 1;
    }
    this._drain();
  }

  /**
   * Start waiting downloads, best first, while nothing in the foreground runs
   * and fewer background downloads run than the source answers at once.
   */
  _drain() {
    const bound = this._ownConcurrency ?? sourceRequestConcurrency;
    while (this._foregroundInFlight === 0 && this._backgroundInFlight < bound) {
      const download = this._dequeue();
      if (download === null) return;
      this._start(download);
    }
  }

  _wait(download, signal) {
    download.waiters += 1;
    if (download.state === 'queued') this._drain();
    let settled = false;
    // The last caller to leave ends the download with its own reason.
    const leave = reason => {
      if (settled) return;
      settled = true;
      download.waiters -= 1;
      if (download.waiters === 0) {
        download.controller.abort(reason);
        if (download.state === 'queued') {
          // It never started: settle it here and free its key.
          download.reject(abortReason(download.controller.signal));
          this._finish(download);
        }
      }
    };
    if (signal === null) {
      return download.promise.finally(() => {
        settled = true;
      });
    }
    return new Promise((resolve, reject) => {
      const stopWaiting = onAbort(signal, () => {
        leave(abortReason(signal));
        reject(abortReason(signal));
      });
      download.promise.then(
        value => {
          stopWaiting();
          settled = true;
          resolve(value);
        },
        error => {
          stopWaiting();
          settled = true;
          reject(error);
        }
      );
    });
  }
}

