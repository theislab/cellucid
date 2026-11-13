import { formatBytes, formatDuration, formatPercent, formatRemaining, formatCountOf } from '../utils/format-units.js';
import { createListenerSet } from '../utils/listener-set.js';
/**
 * The read activity log: every read operation of the open dataset's files,
 * live — what is read (an obs field, a batch of genes, an embedding, a gene
 * index, the neighbor graph), how many requests it made, how many bytes it
 * fetched, how many chunks it decoded and to how many bytes, how far a long
 * one has come, and how it ended. Local files and remote ones alike.
 *
 * The AnnData reader worker reports each operation while it runs and when it
 * ends (`anndata-reader-worker.js`); this log keeps the operations under way
 * and, for the open dataset (cleared when another opens), the totals of
 * every one that ended (`totals`): an analysis over every gene ends
 * thousands, and none is kept once it is counted. It tells subscribers
 * every report, and writes to the console
 * as `[cellucid:read]`: a long operation every few seconds while it runs
 * (how much of how much, how fast, how long is left), and every operation
 * when it ends — at info level when it took a while or built an index, at
 * debug level otherwise, so streaming many genes does not flood the console.
 *
 * Reports are taken in at once and acted on once per frame: a run over every
 * gene reports thousands of operations, and describing, freezing and
 * announcing each as it arrived costs the page too much per run (measured:
 * 23_decisions_partial_reading.md). A flush
 * keeps each operation's latest report, tells subscribers about it once, and
 * writes the operations that ended quietly as one debug entry. Reading the
 * log (`entries`, `totals`) flushes first, so it is always current; what an
 * operation was is told to subscribers (`subscribe`), the log's only memory
 * of it once it ended.
 *
 * @module data/read-activity-log
 */


/**
 * The purpose a read of the cells added to a growing opening names at the end
 * of its label (`<what> (embedding, cells added)`, `embedding-payload.js`):
 * the Dataset box says how such a growth goes, so no read notification does
 * (`app/read-progress-notifications.js`).
 */
export const GROWTH_READ_REASON = 'cells added';

/** Operations at least this long are written at info level. */
const NOTABLE_MS = 1000;

/** A running operation is written once it has run this long, then this often. */
const RUNNING_LINE_AFTER_MS = 1000;
const RUNNING_LINE_EVERY_MS = 2000;

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
    parts.push(`${formatBytes(activity.bytesFetched)} of ${formatBytes(total)} (${formatPercent(share)})`);
  } else if (activity.progress && activity.progress.total > 0) {
    parts.push(formatPercent(Math.floor((100 * activity.progress.done) / activity.progress.total)));
  } else if (activity.bytesFetched > 0) {
    parts.push(`${formatBytes(activity.bytesFetched)} so far`);
  }
  if (activity.bytesPerSecond) parts.push(`${formatBytes(Math.round(activity.bytesPerSecond))}/s`);
  if (activity.remainingMs !== null && activity.remainingMs !== undefined) {
    parts.push(`${formatRemaining(activity.remainingMs)} left`);
  }
  // A wait its host named (`formats/io/activity.js` `waiting`): what it waits for.
  if (activity.waiting) parts.push(`waiting: ${activity.waiting.text}`);
  return parts.length === 0 ? null : parts.join(', ');
}

/** One line describing a finished or running operation. */
export function describeReadActivity(activity) {
  const parts = [];
  if (activity.status === 'running') {
    const progress = describeReadProgress(activity);
    if (progress !== null) parts.push(progress);
  } else if (activity.bytesFetched > 0) {
    parts.push(`${formatBytes(activity.bytesFetched)} read`);
  }
  parts.push(`${formatCountOf(activity.requests, 'request')}`);
  if (activity.cacheHits > 0) parts.push(`${activity.cacheHits} from cache`);
  if (activity.chunks > 0) {
    parts.push(`${formatCountOf(activity.chunks, 'chunk')} decoded to ${formatBytes(activity.decodedBytes)}`);
  }
  const status = activity.status === 'failed'
    ? `failed: ${activity.detail}`
    : activity.status === 'cancelled' ? 'canceled' : activity.status === 'running' ? 'reading' : 'done';
  return `${activity.label} — ${parts.join(', ')}, ${formatDuration(activity.elapsedMs)} (${status})`;
}

/** How long reports wait to be acted on together: one frame at 60 Hz. */
const FLUSH_DELAY_MS = 16;

class ReadActivityLog {
  constructor() {
    /** @type {Map<number, Object>} The operations under way, by activity id, in the order they started */
    this._activities = new Map();
    /** Totals of the operations that ended, for the open dataset. */
    this._ended = { operations: 0, requests: 0, bytesFetched: 0, decodedBytes: 0 };
    this._listeners = createListenerSet('the read activity');
    /** @type {Map<number, number>} When a running operation was last written */
    this._written = new Map();
    /** @type {Map<number, Object>} The latest report of each operation since the last flush */
    this._pending = new Map();
    this._flushTimer = null;
    /** @type {Map<string, Set<string>>} The jobs that joined each shared load, by its key */
    this._adopted = new Map();
  }

  /**
   * An owner that shows the reads of the shared load `key` itself took it
   * (`owner`): a job (`app/jobs/cancellable-job.js`) that joined a load
   * something else started (a view's gene), or the gene's own loading
   * notification (`state/managers/field/loading.js`). The operations that
   * read for that load are the owner's (`adoptedBy`), shown in its
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
      if (activity.status === 'running') {
        this._activities.set(activity.id, activity);
      } else {
        // Ended: counted, and kept no longer.
        this._activities.delete(activity.id);
        this._ended.operations += 1;
        this._ended.requests += activity.requests;
        this._ended.bytesFetched += activity.bytesFetched;
        this._ended.decodedBytes += activity.decodedBytes;
      }
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
      this._listeners.notify(activity);
    }
    if (quiet.length > 0) console.debug(quiet.join('\n'));
  }

  /** The operations under way, oldest first. */
  entries() {
    this.flush();
    return [...this._activities.values()];
  }

  /** Totals over the open dataset, every operation that ended and those under way: requests, bytes fetched, bytes decoded. */
  totals() {
    this.flush();
    const totals = { ...this._ended };
    for (const activity of this._activities.values()) {
      totals.operations += 1;
      totals.requests += activity.requests;
      totals.bytesFetched += activity.bytesFetched;
      totals.decodedBytes += activity.decodedBytes;
    }
    return totals;
  }

  /** Forget everything: another dataset opened. */
  clear() {
    if (this._flushTimer !== null) clearTimeout(this._flushTimer);
    this._flushTimer = null;
    this._pending.clear();
    this._activities.clear();
    this._ended = { operations: 0, requests: 0, bytesFetched: 0, decodedBytes: 0 };
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
    return this._listeners.add(listener);
  }
}

let log = null;

/** The one read activity log of the page. */
export function getReadActivityLog() {
  log ??= new ReadActivityLog();
  return log;
}
