/**
 * Opening progress: what is being opened, from the moment it starts until
 * its first view is drawn, as one state every entry point reports into: a
 * link (`?data=` or the address bar), a file, a `.zarr.zip` or a folder, a
 * sample, a catalog dataset, a `cellucid serve` server, a notebook.
 *
 * Opening one dataset passes through several layers, and each says what it
 * does: whoever starts it (startup, a Session panel control) names what is
 * opened; the link source names the provider step (`Finding the file on
 * NCBI GEO…`); the AnnData file loaders join while they read; the dataset
 * change that draws the first view joins last. A layer `begin()`s, and when
 * an opening is already under way it joins it instead of starting another:
 * there is one opening on screen, whose title the outermost layer gave.
 *
 * While it runs, the opening follows the read activity log (the reads of
 * the file: its structure, the embedding, the default field) and the
 * Transfers log (a request being made again): the step names the read under
 * way, the detail says how much has arrived, how fast and how long is left,
 * when that is known, and a retry shows as a calm `Retrying…` with why.
 *
 * Every layer may give a way to stop its part (`onCancel`). Cancel stops all
 * of them at once and ends the opening as cancelled; what was open before
 * stays open.
 *
 * This module holds state only. `app/opening-progress-view.js` shows it: the
 * startup overlay while no dataset is shown, a notification with Cancel
 * otherwise.
 *
 * @module data/opening-progress
 */

import { getReadActivityLog } from './read-activity-log.js';
import { getTransferLog, formatTransferBytes } from './transfer-log.js';

/**
 * Read kinds an opening reads before its first view: the file's structure,
 * an embedding, a field, the gene names, the neighbour graph.
 */
const OPENING_READ_KINDS = new Set(['open', 'embedding', 'field', 'names', 'graph']);

/** A duration as people say it: `850 ms`, `4.2 s`, `3 min 10 s`. */
export function formatOpeningDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `${minutes} min ${seconds % 60} s`;
}

/** The time left, rounded as an estimate: `<1 s`, `~12 s`, `~3 min 10 s`. */
function formatRemaining(ms) {
  if (ms < 1000) return '<1 s';
  if (ms < 60_000) return `~${Math.ceil(ms / 1000)} s`;
  return `~${formatOpeningDuration(ms)}`;
}

/**
 * What a read under way is doing, as the opening's step says it.
 *
 * @param {{kind: string, label: string}} activity
 * @returns {string}
 */
export function describeOpeningRead(activity) {
  switch (activity.kind) {
    case 'open':
      return "Reading the file's structure";
    case 'embedding': {
      const key = /obsm\['([^']+)'\]/.exec(activity.label)?.[1] ?? null;
      return key === null ? 'Reading the embedding' : `Reading embedding ${key}`;
    }
    case 'field': {
      const key = /obs\['([^']+)'\]/.exec(activity.label)?.[1] ?? null;
      return key === null ? 'Reading a field' : `Reading field ${key}`;
    }
    case 'names':
      return 'Reading gene names';
    case 'graph':
      return 'Reading the neighbour graph';
    default:
      return `Reading ${activity.label}`;
  }
}

/** Why an opening was cancelled, as the error each layer stops with. */
export function openingCancelledError(title) {
  return new DOMException(`Opening ${title} was cancelled.`, 'AbortError');
}

/**
 * @typedef {Object} OpeningSnapshot
 * @property {number} id
 * @property {string} title - What is opened, as the person named it
 * @property {'running'|'done'|'failed'|'cancelled'|'dismissed'} state - `dismissed`:
 *   ended with nothing to say (superseded by a newer choice)
 * @property {string} step - What is happening now (`Reading embedding X_umap`)
 * @property {string|null} detail - How far: bytes, rate, time left; or why a request is made again
 * @property {boolean} retrying - Whether a request is being made again
 * @property {number|null} percent - 0–100 when known
 * @property {number} bytes - Bytes the opening's reads fetched
 * @property {number} elapsedMs
 * @property {string|null} message - The outcome, once it ended
 * @property {unknown} error - The failure, for a failed opening
 * @property {string|null} summary - A failed opening: what it means for the
 *   person, in one plain sentence (the failure's own message is the detail)
 * @property {ReadonlyArray<{label: string, run: () => void}>} actions - A
 *   failed opening: the ways on its layer offers (Try again, …)
 */

class Opening {
  constructor(id, step) {
    this.id = id;
    /** The title the opening was last shown with. */
    this.shownTitle = '';
    this.state = 'running';
    this.step = step;
    this.startedAt = performance.now();
    this.endedAt = null;
    this.message = null;
    this.error = null;
    /** A failed opening: one plain sentence, and the ways on. */
    this.summary = null;
    this.actions = [];
    /**
     * A layer that finished while others were still under way: the opening
     * ends opened when the others only let go. `{message}` or null.
     */
    this.finished = null;
    /** @type {Array<{title: string}>} The layers still under way, outermost first */
    this.holders = [];
    /** @type {Set<() => void>} */
    this.cancels = new Set();
    /** @type {Map<number, Object>} The opening's reads, latest report of each */
    this.reads = new Map();
    this.firstByteAt = null;
    /** @type {string|null} Why a request is being made again */
    this.retrying = null;
    /** @type {{bytes: number, total: number|null}|null} A whole-file read under way (a host that serves no ranges) */
    this.wholeFileRead = null;
    /** Transfers log keys that were active before the opening began. */
    this.knownTransfers = new Set();
  }

  /** What is opened: as the outermost layer still under way names it. */
  get title() {
    if (this.holders.length > 0) this.shownTitle = this.holders[0].title;
    return this.shownTitle;
  }
}

export class OpeningProgress {
  /**
   * @param {{log?: Object, transfers?: Object}} [options]
   */
  constructor({ log = getReadActivityLog(), transfers = getTransferLog() } = {}) {
    this._log = log;
    this._transfers = transfers;
    /** @type {Opening|null} */
    this._current = null;
    this._nextId = 1;
    this._listeners = new Set();
    this._unsubscribe = [];
  }

  /** Whether an opening is under way. */
  get active() {
    return this._current !== null && this._current.state === 'running';
  }

  /**
   * Begin opening `title`, or join the opening under way.
   *
   * @param {{title: string, step?: string, onCancel?: (() => void)|null}} options
   * @returns {{
   *   id: number,
   *   joined: boolean,
   *   step: (text: string) => void,
   *   rename: (title: string) => void,
   *   onCancel: (cancel: () => void) => () => void,
   *   readonly cancelled: boolean,
   *   end: (message?: string) => void,
   *   fail: (error: unknown, outcome?: {summary: string, actions: Array<{label: string, run: () => void}>}) => void,
   *   dismiss: () => void
   * }}
   */
  begin({ title, step = 'Starting', onCancel = null }) {
    if (typeof title !== 'string' || title.trim() === '') {
      throw new TypeError('An opening needs a title: what is opened.');
    }
    let opening = this.active ? this._current : null;
    const joined = opening !== null;
    if (opening === null) {
      opening = new Opening(this._nextId++, step);
      this._current = opening;
      for (const entry of this._transfers.entries()) {
        if (entry.status === 'active') opening.knownTransfers.add(entry.key);
      }
      this._follow(opening);
    } else if (step !== 'Starting') {
      opening.step = step;
    }
    const holder = { title: title.trim() };
    opening.holders.push(holder);
    const removeCancel = onCancel === null ? () => {} : this._addCancel(opening, onCancel);
    let released = false;
    const release = () => {
      if (released) return false;
      released = true;
      removeCancel();
      const index = opening.holders.indexOf(holder);
      if (index >= 0) opening.holders.splice(index, 1);
      return true;
    };
    const handle = {
      id: opening.id,
      joined,
      step: text => {
        if (opening.state !== 'running' || typeof text !== 'string' || text === '') return;
        opening.step = text;
        this._publish();
      },
      rename: text => {
        if (opening.state !== 'running' || typeof text !== 'string' || text.trim() === '') return;
        holder.title = text.trim();
        this._publish();
      },
      onCancel: cancel => this._addCancel(opening, cancel),
      get cancelled() {
        return opening.state === 'cancelled';
      },
      // The opening ends with its last layer. A layer that ends while others
      // are still under way only lets go: an inner layer's outcome reaches
      // the layer around it, and an outer layer replaced by a newer choice
      // leaves the opening to that choice.
      end: message => {
        if (!release()) return;
        if (opening.holders.length === 0) {
          this._settle(opening, 'done', message ?? opening.finished?.message ?? null);
        } else {
          // The layer around one that finished says it last: its message,
          // when it has one, is the opening's.
          opening.finished = { message: message ?? opening.finished?.message ?? null };
          this._publish();
        }
      },
      // A failure ends the opening as failed when it is the outermost
      // layer's or the last one's. The layer may say what the failure means
      // for the person and offer ways on (`outcome`); the failure's own
      // message stays the detail.
      fail: (error, outcome = null) => {
        if (outcome !== null) requireFailureOutcome(outcome);
        const outermost = opening.holders[0] === holder;
        if (!release()) return;
        // Stopped (Cancel, or a newer choice): it only lets go.
        if (error?.name === 'AbortError') {
          this._letGo(opening);
        } else if (outermost || opening.holders.length === 0) {
          if (outcome !== null) {
            opening.summary = outcome.summary;
            opening.actions = Object.freeze(outcome.actions.map(action => Object.freeze({ ...action })));
          }
          this._settle(opening, 'failed', describeFailure(error), error);
        } else {
          // Its outcome reaches the layer around it, which says it.
          this._publish();
        }
      },
      // Ended with nothing to say (superseded, or the outcome is shown
      // elsewhere).
      dismiss: () => {
        if (!release()) return;
        this._letGo(opening);
      },
    };
    this._publish();
    return handle;
  }

  /**
   * Whether a read belongs to the opening under way, which shows it: the
   * read notifications leave it out (`app/read-progress-notifications.js`).
   *
   * @param {{kind: string, background?: boolean}} activity
   */
  shows(activity) {
    return this.active && activity?.background !== true && OPENING_READ_KINDS.has(activity?.kind);
  }

  /** Cancel the opening under way: every layer's part stops. */
  cancel() {
    const opening = this._current;
    if (opening === null || opening.state !== 'running') return false;
    const cancels = [...opening.cancels];
    opening.cancels.clear();
    this._settle(opening, 'cancelled', `Opening ${opening.title} was cancelled.`);
    for (const cancel of cancels) {
      try {
        cancel();
      } catch (error) {
        console.error('[cellucid:opening] A layer could not stop its part of the opening:', error);
      }
    }
    return true;
  }

  /** The opening under way or the one that just ended, or null. */
  snapshot() {
    const opening = this._current;
    if (opening === null) return null;
    const now = opening.endedAt ?? performance.now();
    const reads = [...opening.reads.values()];
    const running = reads.filter(read => read.status === 'running');
    const wholeFile = running.length === 0 ? opening.wholeFileRead : null;
    const bytes = reads.reduce((sum, read) => sum + read.bytesFetched, 0) + (opening.wholeFileRead?.bytes ?? 0);
    const latest = running.at(-1) ?? null;
    const step = latest === null ? opening.step : describeOpeningRead(latest);
    const parts = [];
    let percent = null;
    let left = null;
    if (wholeFile !== null && wholeFile.total > 0) {
      percent = Math.min(100, (100 * wholeFile.bytes) / wholeFile.total);
      parts.push(`${formatTransferBytes(wholeFile.bytes)} of ${formatTransferBytes(wholeFile.total)}`);
    } else if (latest !== null && running.length === 1 && latest.bytesTotal > latest.bytesFetched) {
      percent = Math.min(100, (100 * latest.bytesFetched) / latest.bytesTotal);
      parts.push(`${formatTransferBytes(latest.bytesFetched)} of ${formatTransferBytes(latest.bytesTotal)}`);
    } else if (bytes > 0) {
      // A read whose planned bytes have all arrived and that still runs is
      // waiting for what it asks for next: how much is left is not known.
      parts.push(`${formatTransferBytes(bytes)} read`);
    }
    const since = opening.firstByteAt === null ? 0 : now - opening.firstByteAt;
    if (bytes > 0 && since >= 500) parts.push(`${formatTransferBytes(Math.round((bytes * 1000) / since))}/s`);
    if (wholeFile !== null && wholeFile.total > wholeFile.bytes && bytes > 0 && since >= 500) {
      left = ((wholeFile.total - wholeFile.bytes) * since) / bytes;
    }
    left = running.reduce(
      (most, read) => (
        Number.isFinite(read.remainingMs) && read.bytesTotal > read.bytesFetched
          ? Math.max(most ?? 0, read.remainingMs)
          : most
      ),
      left
    );
    if (left !== null) parts.push(`${formatRemaining(left)} left`);
    if (parts.length === 0) parts.push(formatOpeningDuration(now - opening.startedAt));
    const retrying = opening.state === 'running' && opening.retrying !== null;
    return Object.freeze({
      id: opening.id,
      title: opening.title,
      state: opening.state,
      step: retrying ? 'Retrying' : step,
      detail: retrying ? opening.retrying : parts.join(' · '),
      retrying,
      percent,
      bytes,
      elapsedMs: now - opening.startedAt,
      message: opening.message,
      error: opening.error ?? null,
      summary: opening.summary,
      actions: opening.actions,
    });
  }

  /**
   * Be told whenever the opening changes.
   *
   * @param {(snapshot: OpeningSnapshot|null) => void} listener
   * @returns {() => void}
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** @private */
  _addCancel(opening, cancel) {
    if (typeof cancel !== 'function') throw new TypeError('An opening cancel must be a function.');
    if (opening.state === 'cancelled') {
      cancel();
      return () => {};
    }
    opening.cancels.add(cancel);
    return () => opening.cancels.delete(cancel);
  }

  /** Follow the reads and transfers of one opening while it runs. @private */
  _follow(opening) {
    this._unfollow();
    this._unsubscribe.push(this._log.subscribe(activity => {
      if (this._current !== opening || opening.state !== 'running') return;
      if (activity.background || !OPENING_READ_KINDS.has(activity.kind)) return;
      if ((activity.adoptedBy?.length ?? 0) > 0) return;
      opening.reads.set(activity.id, activity);
      if (activity.bytesFetched > 0) opening.firstByteAt ??= performance.now();
      this._publish();
    }));
    this._unsubscribe.push(this._transfers.subscribe(entries => {
      if (this._current !== opening || opening.state !== 'running') return;
      const ours = entries.filter(entry => entry.status === 'active' && !opening.knownTransfers.has(entry.key));
      const retrying = ours.find(entry => entry.retrying !== null)?.retrying ?? null;
      if (ours.some(entry => entry.bytes > 0)) opening.firstByteAt ??= performance.now();
      const whole = ours.find(entry => entry.mode === 'download') ?? null;
      const wholeChanged = whole === null
        ? opening.wholeFileRead !== null
        : opening.wholeFileRead?.bytes !== whole.bytes;
      opening.wholeFileRead = whole === null ? null : { bytes: whole.bytes, total: whole.total };
      if (retrying !== opening.retrying || wholeChanged) {
        opening.retrying = retrying;
        this._publish();
      }
    }));
  }

  /**
   * A layer let go without an outcome of its own (superseded, or its failure
   * is said where it happened): the opening ends with the last layer, opened
   * if one of them finished, else with nothing to say.
   * @private
   */
  _letGo(opening) {
    if (opening.holders.length > 0) {
      this._publish();
    } else if (opening.finished !== null) {
      this._settle(opening, 'done', opening.finished.message);
    } else {
      this._settle(opening, 'dismissed', null);
    }
  }

  /** @private */
  _unfollow() {
    for (const unsubscribe of this._unsubscribe.splice(0)) unsubscribe();
  }

  /** @private */
  _settle(opening, state, message, error = null) {
    if (opening.state !== 'running') return;
    opening.state = state;
    opening.message = message;
    opening.error = error;
    opening.endedAt = performance.now();
    opening.cancels.clear();
    if (this._current === opening) this._unfollow();
    this._publish();
  }

  /** @private */
  _publish() {
    const snapshot = this.snapshot();
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('[cellucid:opening] An opening display failed:', error);
      }
    }
  }
}

function requireFailureOutcome(outcome) {
  if (
    outcome === null ||
    typeof outcome !== 'object' ||
    typeof outcome.summary !== 'string' ||
    outcome.summary.trim() === '' ||
    !Array.isArray(outcome.actions) ||
    outcome.actions.some(action => (
      action === null ||
      typeof action !== 'object' ||
      typeof action.label !== 'string' ||
      action.label.trim() === '' ||
      typeof action.run !== 'function'
    ))
  ) {
    throw new TypeError('A failed opening outcome is one summary sentence and its {label, run} actions.');
  }
}

/** The message of a failure, as the person reads it. */
function describeFailure(error) {
  if (typeof error === 'string') return error;
  return error instanceof Error && error.message ? error.message : String(error);
}

let progress = null;

/** The one opening progress of the page. */
export function getOpeningProgress() {
  progress ??= new OpeningProgress();
  return progress;
}

/**
 * Begin opening `title` on the page's opening progress, or join the one
 * under way (`OpeningProgress.begin`).
 *
 * @param {{title: string, step?: string, onCancel?: (() => void)|null}} options
 */
export function beginOpening(options) {
  return getOpeningProgress().begin(options);
}

/**
 * One layer of an opening that can be stopped where it is: by Cancel, or by
 * `signal` (the caller's own reason to stop, such as a newer choice). `stop`
 * ends the layer's work at once (a file loader closes its reader, which ends
 * its worker and every request it had open); the layer then rejects with
 * `outcome(error)`: why it was stopped, not the error stopping it caused.
 *
 * @param {{title: string, step?: string, signal?: AbortSignal|null, stop: () => void}} options
 */
export function stoppableOpening({ title, step, signal = null, stop }) {
  if (typeof stop !== 'function') throw new TypeError('A stoppable opening needs stop().');
  const handle = beginOpening({ title, ...(step === undefined ? {} : { step }) });
  let reason = null;
  const halt = why => {
    if (reason !== null) return;
    reason = why;
    stop();
  };
  const removeCancel = handle.onCancel(() => halt(openingCancelledError(title)));
  const onAbort = () => halt(signal.reason ?? openingCancelledError(title));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    handle,
    /** Whether it was stopped. */
    get stopped() {
      return reason !== null;
    },
    /** Throw why it was stopped, if it was. */
    throwIfStopped() {
      if (reason !== null) throw reason;
    },
    /** The error the layer rejects with: why it was stopped, else `error`. */
    outcome(error) {
      return reason ?? error;
    },
    /** The layer is done: neither Cancel nor `signal` reach it any more. */
    release() {
      removeCancel();
      signal?.removeEventListener('abort', onAbort);
    },
  };
}
