/**
 * @fileoverview Cancellable jobs: the one way the app runs expensive work the
 * person may stop — an analysis (differential expression, marker genes,
 * clustering, correlation, a signature score, a plot's data), the outlier
 * quantiles of a field. Each feature says what its job does; this module
 * owns how every job starts, reports, stops and ends:
 *
 * - **Cancel.** A job owns one `AbortController`; its `signal` goes to every
 *   read and compute task of the job, so cancelling stops them where they
 *   are (reads in the reader worker, tasks in the analysis workers).
 *   Cancelling rejects with `cancelledError()`, an `AbortError`, and is never
 *   a failure: it is not logged as one, not shown as one, and leaves nothing
 *   half-applied (the feature applies a result only once its job is done).
 * - **Shared work.** `awaitWithSignal` lets one caller stop waiting while the
 *   work goes on for others; one piece of work run for many callers is a
 *   `SharedWork` (`formats/io/abort.js`), stopped only when the last of
 *   them has gone.
 * - **States.** `running` (with the cost, when it was known before starting:
 *   `plan`), then `done`, `failed` (with why) or `cancelled` (the view offers
 *   Run again). A job that has not started is the feature's own state.
 * - **What is happening.** A step (`Reading genes`), items done of how many
 *   (`1,240 of 20,000 genes`), and the job's reads from the read activity log
 *   (bytes read, how fast, how long is left), in one line (`describe`).
 * - **One notification.** A job running longer than a moment shows one
 *   progress notification, with Cancel, updated as it goes and closed with
 *   the outcome. Its reads carry a read kind of `JOB_READ_KINDS`, which the
 *   generic read notifications skip (`app/read-progress-notifications.js`),
 *   so a job never shows twice.
 *
 * @module app/jobs/cancellable-job
 */

import { getNotificationCenter } from '../notification-center.js';
import { describeReadProgress, getReadActivityLog } from '../../data/read-activity-log.js';
import { formatBytes, formatDuration, formatRemaining, formatCount } from '../../utils/format-units.js';
import { trackCellWork } from '../../data/open-cells-work.js';

/**
 * Read kinds a job owns (`ReadActivity.kind`): an analysis's gene reads, the
 * latent space read for outlier quantiles. Their job shows them; the generic
 * read notifications do not.
 */
export const JOB_READ_KINDS = Object.freeze(new Set(['analysis', 'outliers']));

/**
 * Whether a read activity belongs to a job, which shows it itself: a read of
 * a job's kind, or one a job adopted by joining the load it reads for
 * (`data/read-activity-log.js`, `adopt`).
 */
export function isJobRead(activity) {
  return JOB_READ_KINDS.has(activity?.kind) || (activity?.adoptedBy?.length ?? 0) > 0;
}

/** A job is shown as a progress notification once it has run this long. */
const NOTIFY_AFTER_MS = 700;

/** Notification and view updates are coalesced to at most this often. */
const UPDATE_EVERY_MS = 200;

/**
 * The error a cancelled job rejects with: an `AbortError` naming the work.
 *
 * @param {string} [what] - What was cancelled, as a sentence subject
 * @returns {DOMException}
 */
export function cancelledError(what = 'The work') {
  return new DOMException(`${what} was cancelled.`, 'AbortError');
}

/** Whether `error` is a cancellation (any `AbortError`), never a failure. */
export function isCancellation(error) {
  return error?.name === 'AbortError';
}

/** Why `signal` aborted, as an error: its reason, else an AbortError. */
export function abortReasonOf(signal) {
  return signal?.reason instanceof Error || isCancellation(signal?.reason)
    ? signal.reason
    : cancelledError();
}

/** Throw the abort reason when `signal` has aborted. */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReasonOf(signal);
}

/**
 * Wait for `task`, or reject at once when `signal` aborts. The task goes on:
 * other callers may still be waiting for it.
 *
 * @template T
 * @param {Promise<T>} task
 * @param {AbortSignal|null|undefined} signal
 * @returns {Promise<T>}
 */
export function awaitWithSignal(task, signal) {
  const work = Promise.resolve(task);
  if (signal === null || signal === undefined) return work;
  if (signal.aborted) {
    // The work's own outcome is observed: nobody else may wait for it.
    work.catch(() => {});
    return Promise.reject(abortReasonOf(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReasonOf(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/**
 * A request generation: each `next()` supersedes every earlier one, so work
 * of an older request can tell it is no longer wanted.
 *
 * @returns {{ next: () => number, isCurrent: (id: number) => boolean }}
 */
export function createRequestIdTracker() {
  let currentId = 0;
  return {
    next() {
      return ++currentId;
    },
    isCurrent(id) {
      return id === currentId;
    }
  };
}

let nextJobId = 1;

/**
 * One cancellable job (module overview).
 *
 * @example
 * const job = new CancellableJob({ title: 'Differential expression', readKind: 'analysis' });
 * job.step('Reading genes');
 * job.items(0, genes.length, 'genes');
 * try {
 *   const result = await run({ signal: job.signal, readOwner: job.id });
 *   apply(result);
 *   job.succeed('Differential expression: 412 significant genes');
 * } catch (error) {
 *   job.settle(error); // cancelled, or failed with why
 * }
 */
export class CancellableJob {
  /**
   * @param {Object} options
   * @param {string} options.title - What the job is, as people name it
   * @param {string} [options.category='calculation'] - Notification category
   * @param {string|null} [options.plan=null] - What the job costs, when known
   *   before it starts (`20,000 genes × 45,000 cells`)
   * @param {string|null} [options.readKind=null] - The read kind of its reads
   *   (one of `JOB_READ_KINDS`), followed in the read activity log
   * @param {((activity: Object, job: CancellableJob) => boolean)|null} [options.ownsRead]
   *   Which reads of `readKind` are this job's; by default those whose
   *   `owner` is the job's `id` (pass `job.id` as the reads' owner)
   * @param {() => void} [options.onCancel] - Called once when the job is
   *   cancelled, by whatever means (Cancel, the notification, its owner)
   * @param {number} [options.notifyAfterMs=NOTIFY_AFTER_MS] - When the
   *   progress notification appears; `Infinity` never shows one
   * @param {boolean} [options.failureNotice=true] - Whether a failure before
   *   the progress notification appeared gets an error notification of its
   *   own (false where the feature's own view always says why)
   * @param {Object} [options.notifications] - Notification center
   * @param {Object} [options.log] - Read activity log
   */
  constructor({
    title,
    category = 'calculation',
    plan = null,
    readKind = null,
    ownsRead = null,
    onCancel = () => {},
    notifyAfterMs = NOTIFY_AFTER_MS,
    failureNotice = true,
    notifications = getNotificationCenter(),
    log = getReadActivityLog(),
  }) {
    if (typeof title !== 'string' || title.length === 0) throw new TypeError('A job needs a title.');
    if (readKind !== null && !JOB_READ_KINDS.has(readKind)) {
      throw new RangeError(`Unknown job read kind '${String(readKind)}'.`);
    }
    /** Unique id: the `owner` of the job's reads. */
    this.id = `job-${nextJobId++}`;
    this.title = title;
    this.category = category;
    this._controller = new AbortController();
    /** @type {'running'|'done'|'failed'|'cancelled'} */
    this.state = 'running';
    this.plan = plan;
    this.stepText = null;
    this.itemsDone = null;
    this.itemsTotal = null;
    this.itemsUnit = '';
    this.message = null;
    this.startedAt = performance.now();
    this.endedAt = null;
    this._itemsStartedAt = null;
    this._onCancel = onCancel;
    this._failureNotice = failureNotice;
    this._notifications = notifications;
    this._notificationId = null;
    this._listeners = new Set();
    this._updateTimer = null;
    /** @type {Map<number, Object>} The job's reads, latest report of each */
    this._reads = new Map();
    /** @type {Object|null} The latest report of any of the job's reads */
    this.latestRead = null;
    this._firstReadAt = null;
    this._unsubscribeReads = null;
    if (readKind !== null) {
      const owns = ownsRead ?? (activity => activity.owner === this.id);
      this._unsubscribeReads = log.subscribe(activity => {
        // Its own reads, and the reads of a load it joined (`adopt`).
        const adopted = activity.adoptedBy?.includes(this.id) === true;
        if (!adopted && (activity.kind !== readKind || !owns(activity, this))) return;
        this._firstReadAt ??= activity.startedAt;
        this._reads.set(activity.id, activity);
        this.latestRead = activity;
        this._changed();
      });
    }
    this._notifyTimer = Number.isFinite(notifyAfterMs)
      ? setTimeout(() => this._notify(), notifyAfterMs)
      : null;
    // A job works on the open cells: changing them in place waits for it
    // to end (`data/open-cells-work.js`).
    trackCellWork(new Promise(resolve => { this._ended = resolve; }));
  }

  /** Aborts when the job is cancelled: pass it to every read and task. */
  get signal() {
    return this._controller.signal;
  }

  /** Whether the job still runs. */
  get running() {
    return this.state === 'running';
  }

  /** Name the step under way (`Reading genes`, `Clustering`). */
  step(text) {
    if (!this.running) return this;
    this.stepText = text;
    this._changed();
    return this;
  }

  /** Items done of how many (`unit`: `genes`, `pages`). */
  items(done, total, unit = this.itemsUnit) {
    if (!this.running) return this;
    if (this.itemsTotal !== total) this._itemsStartedAt = null;
    this._itemsStartedAt ??= done === 0 ? performance.now() : this.startedAt;
    this.itemsDone = done;
    this.itemsTotal = total;
    this.itemsUnit = unit;
    this._changed();
    return this;
  }

  /** Say what the job costs (shown with the running state). */
  setPlan(text) {
    this.plan = text;
    this._changed();
    return this;
  }

  /** Bytes the job's reads fetched, the running ones' totals, and the rate. */
  readTotals() {
    let fetched = 0;
    let running = null;
    let runningCount = 0;
    for (const activity of this._reads.values()) {
      fetched += activity.bytesFetched;
      if (activity.status === 'running') {
        runningCount += 1;
        running = activity;
      }
    }
    const since = this._firstReadAt === null ? 0 : performance.now() - this._firstReadAt;
    const bytesPerSecond = since >= 500 && fetched > 0 ? (fetched * 1000) / since : null;
    return { fetched, bytesPerSecond, single: runningCount === 1 ? running : null };
  }

  /** How far the job has come, 0–100, or null when not known. */
  percent() {
    if (this.itemsTotal > 0) return Math.min(100, (100 * this.itemsDone) / this.itemsTotal);
    const single = this.readTotals().single;
    if (single?.bytesTotal > 0) return Math.min(100, (100 * single.bytesFetched) / single.bytesTotal);
    return null;
  }

  /** Estimated time left, or null when it cannot be said yet. */
  remainingMs() {
    if (this.itemsTotal > 0 && this.itemsDone > 0 && this._itemsStartedAt !== null) {
      const spent = performance.now() - this._itemsStartedAt;
      if (spent < 1000) return null;
      return (spent * (this.itemsTotal - this.itemsDone)) / this.itemsDone;
    }
    return this.readTotals().single?.remainingMs ?? null;
  }

  /**
   * What the job is doing, in one line: `Reading genes: 1,240 of 20,000
   * genes, 38 MB read, 12 MB/s, ~40 s left`.
   */
  describe() {
    const parts = [];
    if (this.itemsTotal > 0) {
      parts.push(`${formatCount(this.itemsDone)} of ${formatCount(this.itemsTotal)}${this.itemsUnit ? ` ${this.itemsUnit}` : ''}`);
    }
    const { fetched, bytesPerSecond, single } = this.readTotals();
    if (this.itemsTotal > 0 || single === null) {
      if (fetched > 0) parts.push(`${formatBytes(fetched)} read`);
      if (bytesPerSecond !== null) parts.push(`${formatBytes(Math.round(bytesPerSecond))}/s`);
      const left = this.remainingMs();
      if (left !== null) parts.push(`${formatRemaining(left)} left`);
    } else {
      const reading = describeReadProgress(single);
      if (reading !== null) parts.push(reading);
    }
    const step = this.stepText ?? 'Working';
    return parts.length === 0 ? `${step}…` : `${step}: ${parts.join(', ')}`;
  }

  /**
   * Cancel the job: its signal aborts (its reads and tasks stop), its
   * notification goes, and `onCancel` is told. Nothing happens once the job
   * has ended.
   *
   * @returns {boolean} Whether the job was running
   */
  cancel() {
    if (!this.running) return false;
    this._end('cancelled');
    this._controller.abort(cancelledError(this.title));
    if (this._notificationId !== null) {
      this._closeNotification(id => this._notifications.dismiss(id));
    }
    this._onCancel();
    return true;
  }

  /** The job finished; `message` closes its notification. */
  succeed(message = `${this.title} done (${formatDuration(performance.now() - this.startedAt)})`) {
    if (!this.running) return;
    this.message = message;
    this._end('done');
    if (this._notificationId !== null) {
      this._closeNotification(id => this._notifications.complete(id, message));
    }
  }

  /**
   * The job failed: `error` says why, shown in its notification (or one of
   * its own when none was shown yet, unless `failureNotice` is off). A
   * cancellation is not a failure: it ends the job as cancelled.
   *
   * @param {unknown} error
   * @param {string} [text] - What the notification says (`<title> failed: <why>`)
   */
  fail(error, text = undefined) {
    if (!this.running) return;
    if (isCancellation(error)) {
      this.cancel();
      return;
    }
    const why = error instanceof Error ? error.message : String(error);
    this.message = why;
    this._end('failed');
    const said = text ?? `${this.title} failed: ${why}`;
    if (this._notificationId !== null) {
      this._closeNotification(id => this._notifications.fail(id, said));
    } else if (this._failureNotice) {
      this._notifications.error(said, { category: this.category });
    }
  }

  /** End the job by an outcome: null is done, a cancellation cancels, else it failed. */
  settle(error = null, message = undefined) {
    if (error === null) this.succeed(message);
    else this.fail(error);
  }

  /**
   * Be told when anything about the job changes (at most every
   * `UPDATE_EVERY_MS`, and at once when it ends).
   *
   * @param {(job: CancellableJob) => void} listener
   * @returns {() => void} Unsubscribe
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** @private */
  _end(state) {
    this.state = state;
    this.endedAt = performance.now();
    this._ended();
    clearTimeout(this._notifyTimer);
    this._notifyTimer = null;
    this._unsubscribeReads?.();
    this._unsubscribeReads = null;
    clearTimeout(this._updateTimer);
    this._updateTimer = null;
    this._publish();
  }

  /** @private */
  _changed() {
    if (!this.running || this._updateTimer !== null) return;
    this._updateTimer = setTimeout(() => {
      this._updateTimer = null;
      if (this.running) this._publish();
    }, UPDATE_EVERY_MS);
  }

  /** @private */
  _publish() {
    if (this.running && this._notificationId !== null) {
      try {
        this._notifications.updateProgress(this._notificationId, this.percent() ?? 0, {
          message: this._notificationText(),
        });
      } catch (error) {
        // Dismissed by hand: no longer updated.
        if (!(error instanceof RangeError)) throw error;
        this._notificationId = null;
      }
    }
    for (const listener of this._listeners) {
      try {
        listener(this);
      } catch (error) {
        console.error(`[cellucid:jobs] A listener of "${this.title}" failed:`, error);
      }
    }
  }

  /** @private */
  _notificationText() {
    return `${this.title}: ${this.describe()}`;
  }

  /** @private */
  _notify() {
    this._notifyTimer = null;
    if (!this.running || this._notificationId !== null) return;
    this._notificationId = this._notifications.progress(this._notificationText(), this.percent() ?? 0, {
      category: this.category,
      onCancel: () => {
        this.cancel();
      },
    });
  }

  /** @private */
  _closeNotification(close) {
    const id = this._notificationId;
    this._notificationId = null;
    try {
      close(id);
    } catch (error) {
      // Dismissed by hand meanwhile.
      if (!(error instanceof RangeError)) throw error;
    }
  }
}
