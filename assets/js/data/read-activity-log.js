/**
 * The read activity log: every read operation of the open dataset's files,
 * live — what is read (an obs field, a batch of genes, an embedding, a gene
 * index, the neighbour graph), how many requests it made, how many bytes it
 * fetched, how many chunks it decoded and to how many bytes, how far a long
 * one has come, and how it ended. Local files and remote ones alike.
 *
 * The AnnData reader worker reports each operation while it runs and when it
 * ends (`anndata-reader-worker.js`); this log keeps them for the open dataset
 * (cleared when another opens), tells subscribers, and writes to the console
 * as `[cellucid:read]`: a long operation every few seconds while it runs
 * (how much of how much, how fast, how long is left), and every operation
 * when it ends — at info level when it took a while or built an index, at
 * debug level otherwise, so streaming many genes does not flood the console.
 *
 * Reports are taken in at once and acted on once per frame: a run over every
 * gene reports thousands of operations, and describing, freezing and
 * announcing each as it arrived cost the page 83–129 ms per run. A flush
 * keeps each operation's latest report, tells subscribers about it once, and
 * writes the operations that ended quietly as one debug entry. Reading the
 * log (`entries`, `totals`) flushes first, so it is always current.
 *
 * @module data/read-activity-log
 */

import { formatTransferBytes } from './transfer-log.js';

/** Operations at least this long are written at info level. */
const NOTABLE_MS = 1000;

/** A running operation is written once it has run this long, then this often. */
const RUNNING_LINE_AFTER_MS = 1000;
const RUNNING_LINE_EVERY_MS = 2000;

/** A duration as people say it: `850 ms`, `4.2 s`, `3 min 10 s`. */
export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min ${seconds % 60} s`;
}

/** The time left, rounded as an estimate: `<1 s`, `~12 s`, `~3 min 10 s`. */
function formatRemaining(ms) {
  if (ms < 1000) return '<1 s';
  if (ms < 60_000) return `~${Math.ceil(ms / 1000)} s`;
  return `~${formatDuration(ms)}`;
}

/**
 * How far a running operation has come: `12 MB of 40 MB (31%), 8.2 MB/s,
 * ~4 s left`, or in steps when no byte total is known. Null when nothing
 * can be said yet.
 */
export function describeReadProgress(activity) {
  const parts = [];
  const total = activity.bytesTotal ?? null;
  if (total !== null && total > 0) {
    const share = Math.min(100, Math.floor((100 * activity.bytesFetched) / total));
    parts.push(`${formatTransferBytes(activity.bytesFetched)} of ${formatTransferBytes(total)} (${share}%)`);
  } else if (activity.progress && activity.progress.total > 0) {
    parts.push(`${Math.floor((100 * activity.progress.done) / activity.progress.total)}%`);
  } else if (activity.bytesFetched > 0) {
    parts.push(`${formatTransferBytes(activity.bytesFetched)} so far`);
  }
  if (activity.bytesPerSecond) parts.push(`${formatTransferBytes(Math.round(activity.bytesPerSecond))}/s`);
  if (activity.remainingMs !== null && activity.remainingMs !== undefined) {
    parts.push(`${formatRemaining(activity.remainingMs)} left`);
  }
  return parts.length === 0 ? null : parts.join(', ');
}

/** One line describing a finished or running operation. */
export function describeReadActivity(activity) {
  const parts = [];
  if (activity.status === 'running') {
    const progress = describeReadProgress(activity);
    if (progress !== null) parts.push(progress);
  } else if (activity.bytesFetched > 0) {
    parts.push(`${formatTransferBytes(activity.bytesFetched)} read`);
  }
  parts.push(`${activity.requests} request${activity.requests === 1 ? '' : 's'}`);
  if (activity.cacheHits > 0) parts.push(`${activity.cacheHits} from cache`);
  if (activity.chunks > 0) {
    parts.push(`${activity.chunks} chunk${activity.chunks === 1 ? '' : 's'} decoded to ${formatTransferBytes(activity.decodedBytes)}`);
  }
  const status = activity.status === 'failed'
    ? `failed: ${activity.detail}`
    : activity.status === 'cancelled' ? 'cancelled' : activity.status === 'running' ? 'reading' : 'done';
  return `${activity.label} — ${parts.join(', ')}, ${formatDuration(activity.elapsedMs)} (${status})`;
}

/** How long reports wait to be acted on together: one frame at 60 Hz. */
const FLUSH_DELAY_MS = 16;

class ReadActivityLog {
  constructor() {
    /** @type {Map<number, Object>} By activity id, in the order they started */
    this._activities = new Map();
    this._listeners = new Set();
    /** @type {Map<number, number>} When a running operation was last written */
    this._written = new Map();
    /** @type {Map<number, Object>} The latest report of each operation since the last flush */
    this._pending = new Map();
    this._flushTimer = null;
    /** @type {Map<string, Set<string>>} The jobs that joined each shared load, by its key */
    this._adopted = new Map();
  }

  /**
   * A job (`owner`, `app/jobs/cancellable-job.js`) joined the shared load
   * `key` that something else started (a view's gene): the operations that
   * read for that load are the job's too (`adoptedBy`), shown in the job's
   * notification and not as reads of their own, from now on and for those
   * still to come.
   *
   * @param {string} key
   * @param {string} owner
   */
  adopt(key, owner) {
    if (typeof key !== 'string' || typeof owner !== 'string') return;
    let owners = this._adopted.get(key);
    if (owners === undefined) {
      owners = new Set();
      this._adopted.set(key, owners);
    }
    if (owners.has(owner)) return;
    owners.add(owner);
    // The operations under way are told again, as the job's now.
    for (const activity of this._activities.values()) {
      if (activity.status === 'running' && activity.keys?.includes(key) && !this._pending.has(activity.id)) this.record(activity);
    }
  }

  /** The jobs that adopted an operation, through the shared loads it reads for. */
  _adoptersOf(report) {
    const adopters = new Set();
    for (const key of report.keys ?? []) for (const owner of this._adopted.get(key) ?? []) adopters.add(owner);
    return [...adopters];
  }

  /** Record one report from the reader worker; it is acted on with the frame's others. */
  record(activity) {
    if (activity === null || typeof activity !== 'object' || !Number.isSafeInteger(activity.id)) return;
    this._pending.set(activity.id, activity);
    this._flushTimer ??= setTimeout(() => this.flush(), FLUSH_DELAY_MS);
  }

  /** Act on the reports taken in since the last flush: keep, write, announce. */
  flush() {
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._pending.size === 0) return;
    const reports = [...this._pending.values()];
    this._pending.clear();
    const now = performance.now();
    const quiet = [];
    for (const report of reports) {
      const activity = Object.freeze({ ...report, adoptedBy: this._adoptersOf(report) });
      this._activities.set(activity.id, activity);
      if (activity.status === 'running') {
        const last = this._written.get(activity.id) ?? null;
        if (activity.elapsedMs >= RUNNING_LINE_AFTER_MS && (last === null || now - last >= RUNNING_LINE_EVERY_MS)) {
          this._written.set(activity.id, now);
          console.info(`[cellucid:read] ${describeReadActivity(activity)}`);
        }
      } else {
        this._written.delete(activity.id);
        const line = `[cellucid:read] ${describeReadActivity(activity)}`;
        if (activity.status === 'failed') console.warn(line);
        else if (activity.elapsedMs >= NOTABLE_MS || activity.kind === 'index' || activity.kind === 'open') console.info(line);
        else quiet.push(line);
      }
      for (const listener of this._listeners) {
        try {
          listener(activity);
        } catch (error) {
          console.error('[cellucid:read] An activity listener failed:', error);
        }
      }
    }
    if (quiet.length > 0) console.debug(quiet.join('\n'));
  }

  /** Every operation of the open dataset, oldest first. */
  entries() {
    this.flush();
    return [...this._activities.values()];
  }

  /** Totals over the open dataset: requests, bytes fetched, bytes decoded. */
  totals() {
    this.flush();
    let requests = 0;
    let bytesFetched = 0;
    let decodedBytes = 0;
    for (const activity of this._activities.values()) {
      requests += activity.requests;
      bytesFetched += activity.bytesFetched;
      decodedBytes += activity.decodedBytes;
    }
    return { operations: this._activities.size, requests, bytesFetched, decodedBytes };
  }

  /** Forget everything: another dataset opened. */
  clear() {
    if (this._flushTimer !== null) clearTimeout(this._flushTimer);
    this._flushTimer = null;
    this._pending.clear();
    this._activities.clear();
    this._written.clear();
    this._adopted.clear();
  }

  /**
   * Be told about every report.
   *
   * @param {(activity: Object) => void} listener
   * @returns {() => void} Unsubscribe
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }
}

let log = null;

/** The one read activity log of the page. */
export function getReadActivityLog() {
  log ??= new ReadActivityLog();
  return log;
}
