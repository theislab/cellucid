/**
 * Cancellation: the one module every thread (the page, the reader, decode,
 * analysis and figure-export workers) stops work with.
 *
 * **A cancellation is never a failure.** It is an `AbortError` (a
 * `DOMException`) that says what stopped and why (`kind`):
 *
 * | kind         | what happened                                              | a surface shows   |
 * |--------------|------------------------------------------------------------|-------------------|
 * | `user`       | the person stopped it (Cancel, Dismiss, closed a window)   | nothing           |
 * | `superseded` | a newer choice of the same thing replaced it               | nothing           |
 * | `closed`     | what it belonged to went away (the dataset, a control)     | nothing           |
 * | `released`   | memory was given back under it; asked again it works       | nothing, re-asks  |
 * | `page-left`  | the page was left (or put in the back/forward cache)       | nothing, re-asks  |
 *
 * Work is stopped only through `cancel(controller, kind, words)` (or a
 * controller aborted with `cancelled(...)`); `isCancellation` answers by the
 * error's name alone, so an abort from the platform (a `fetch`, a stream) is
 * one too, and `cancellationKind` tells the kinds apart (`user` for one
 * without a kind). A deadline's `TimeoutError` (`utils/deadline.js`) is not
 * a cancellation: work that went silent failed.
 *
 * **Waiting on a signal.** Thousands of reads often share one signal (the
 * rows of every cell of a selection, the chunks of every gene of an
 * analysis). An `abort` listener per read would make each
 * `addEventListener` scan every listener already on the signal (the DOM
 * checks for duplicates), so registering n reads would cost O(n^2).
 * `onAbort` keeps one listener per signal and a set of the callbacks
 * waiting on it: registering and releasing a callback is O(1), and an abort
 * still calls every waiting callback at once, in registration order,
 * exactly once. `awaitWithSignal` waits for a task through it.
 *
 * **A signal that has already aborted is answered at once.** An `abort`
 * event is dispatched once, when the signal aborts, and never again: a
 * listener added to a signal that has already aborted never runs, so work
 * handed a stopped signal would run to its end (a whole matrix read, a
 * whole export) with nothing to stop it. `onAbort` calls the callback at
 * once, before returning, when the signal has already aborted, so every
 * site that waits on a signal is right whichever it is handed. It is the
 * only place that listens for `abort` on a signal: `addEventListener('abort',
 * ...)` appears nowhere else under `assets/js`
 * (`tests/abort-listener-contract.test.mjs`).
 *
 * **A lifetime** (`withinLifetime`): a read made through something that can
 * be closed (an open Zarr store, an HDF5 file) runs with a signal that also
 * aborts when that thing's lifetime does, so closing it stops every read
 * still under way, background reads with no signal of their own included.
 *
 * **Shared work** (`SharedWork`, `SharedWorks`, `sharedOnce`): work several
 * callers wait for stops only once every one of them has withdrawn, and a
 * caller whose own signal did not fire never sees another's cancellation.
 *
 * Crossing a thread or a process, a cancellation keeps its kind through
 * `utils/error-wire.js`.
 *
 * @module utils/abort
 */

/** The kinds of cancellation (module overview). */
export const CANCEL_KINDS = Object.freeze(['user', 'superseded', 'closed', 'released', 'page-left']);

const KINDS = new Set(CANCEL_KINDS);

/**
 * A cancellation: an `AbortError` saying what stopped (`words`, a sentence)
 * and why (`kind`), with what led to it as its `cause`.
 *
 * @param {'user'|'superseded'|'closed'|'released'|'page-left'} kind
 * @param {string} words
 * @param {unknown} [cause]
 * @returns {DOMException & {kind: string}}
 */
export function cancelled(kind, words, cause = undefined) {
  if (!KINDS.has(kind)) throw new RangeError(`Unknown cancellation kind '${String(kind)}'.`);
  if (typeof words !== 'string' || words.length === 0) throw new TypeError('A cancellation says what stopped.');
  const error = new DOMException(words, 'AbortError');
  Object.defineProperty(error, 'kind', { value: kind, enumerable: true, configurable: true });
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause, configurable: true, writable: true });
  return error;
}

/**
 * Stop the work `controller` owns: aborts it with `cancelled(kind, words,
 * cause)`. Nothing happens when it was stopped already.
 *
 * @param {AbortController|null|undefined} controller
 * @param {'user'|'superseded'|'closed'|'released'|'page-left'} kind
 * @param {string} words
 * @param {unknown} [cause]
 * @returns {boolean} Whether this call stopped it
 */
export function cancel(controller, kind, words, cause = undefined) {
  if (controller === null || controller === undefined || controller.signal.aborted) return false;
  controller.abort(cancelled(kind, words, cause));
  return true;
}

/** Whether `error` is a cancellation (any `AbortError`), never a failure. */
export function isCancellation(error) {
  return error?.name === 'AbortError';
}

/**
 * What kind of cancellation `error` is (module overview): its kind, `user`
 * for an `AbortError` without one (the platform's own), or null when it is
 * not a cancellation.
 *
 * @param {unknown} error
 * @returns {'user'|'superseded'|'closed'|'released'|'page-left'|null}
 */
export function cancellationKind(error) {
  if (!isCancellation(error)) return null;
  return KINDS.has(error.kind) ? error.kind : 'user';
}

/**
 * Whether `error` is a cancellation the work's owner asks again without the
 * person seeing anything (`released`, `page-left`): the work itself was
 * wanted, only what held it went.
 */
export function isTransientCancellation(error) {
  const kind = cancellationKind(error);
  return kind === 'released' || kind === 'page-left';
}

/**
 * Why `signal` aborted, as what to throw: its reason when that is an error
 * (a cancellation, a deadline's `TimeoutError`, a failure the work was
 * stopped for), else a `user` cancellation carrying it.
 *
 * @param {AbortSignal} signal
 * @returns {Error|DOMException}
 */
export function abortReason(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error || (typeof reason?.name === 'string' && typeof reason?.message === 'string')) return reason;
  return cancelled('user', 'The work was cancelled.', reason);
}

/** Throw why `signal` aborted, when it has (`abortReason`). */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

/** @type {WeakMap<AbortSignal, {entries: Set<{callback: () => void}>, fire: () => void}>} */
const registries = new WeakMap();

const NOTHING = () => {};

/**
 * Call `callback` when `signal` aborts, or at once (before returning) when
 * it has already aborted: an `abort` event is never dispatched again, so a
 * plain listener would never hear a signal stopped before it was added.
 * Returns the function that stops waiting (it does nothing once the callback
 * ran, or when there was nothing to wait for); call it once the work is
 * settled, so a long-lived signal keeps no callback of work that is done.
 *
 * A callback that may run at once must not reach what is set up after the
 * call (the remover it returns, a queue entry pushed later): register it
 * once what it undoes exists.
 *
 * @param {AbortSignal|null|undefined} signal
 * @param {() => void} callback
 * @returns {() => void}
 */
export function onAbort(signal, callback) {
  if (signal === null || signal === undefined) return NOTHING;
  if (signal.aborted) {
    callback();
    return NOTHING;
  }
  let registry = registries.get(signal);
  if (registry === undefined) {
    const entries = new Set();
    const fire = () => {
      if (registries.get(signal) === registry) registries.delete(signal);
      for (const entry of [...entries]) {
        try {
          entry.callback();
        } catch (error) {
          // As for an event listener: reported, and the others still run.
          queueMicrotask(() => {
            throw error;
          });
        }
      }
      entries.clear();
    };
    registry = { entries, fire };
    registries.set(signal, registry);
    signal.addEventListener('abort', fire, { once: true });
  }
  const entry = { callback };
  const owner = registry;
  owner.entries.add(entry);
  return () => {
    if (!owner.entries.delete(entry) || owner.entries.size > 0) return;
    // Nothing waits any more: the signal carries no listener of ours.
    if (registries.get(signal) === owner) registries.delete(signal);
    signal.removeEventListener('abort', owner.fire);
  };
}

/** The listeners `onAbort` keeps on `signal`: 1 while anything waits, else 0 (tests). */
export function abortListenerCount(signal) {
  return registries.get(signal)?.entries.size > 0 ? 1 : 0;
}

/** The callbacks waiting on `signal` (tests). */
export function abortWaiterCount(signal) {
  return registries.get(signal)?.entries.size ?? 0;
}

/**
 * Wait for `task`, or reject at once with why `signal` aborted. The task
 * goes on: other callers may still be waiting for it. A null signal never
 * withdraws.
 *
 * @template T
 * @param {Promise<T>|T} task
 * @param {AbortSignal|null|undefined} signal
 * @returns {Promise<T>}
 */
export function awaitWithSignal(task, signal) {
  const work = Promise.resolve(task);
  if (signal === null || signal === undefined) return work;
  if (signal.aborted) {
    // The work's own outcome is observed: nobody else may wait for it.
    work.catch(NOTHING);
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const stop = onAbort(signal, () => {
      work.catch(NOTHING);
      reject(abortReason(signal));
    });
    work.then(
      value => {
        stop();
        resolve(value);
      },
      error => {
        stop();
        reject(error);
      }
    );
  });
}

/**
 * Run `work` with a signal that aborts when its caller's `signal` does or
 * when `lifetime` does: the lifetime of what the work reads through (an
 * open store or file, aborted by its `close()`), so closing it stops every
 * read made through it wherever that read is -- a fetch, a wait to retry
 * one, a read queued behind others -- whoever asked for it and whether or
 * not they passed a signal of their own (a background pass, a check that
 * runs beside the reads). `work` is called at once, in this task, so reads
 * asked for together are still planned together; the joined signal's
 * callbacks are released once its promise settles, so a long-lived
 * lifetime carries none of a read that is done. Either signal may be null.
 *
 * @template T
 * @param {AbortSignal|null} lifetime
 * @param {AbortSignal|null|undefined} signal
 * @param {(signal: AbortSignal|null) => Promise<T>} work
 * @returns {Promise<T>}
 */
export function withinLifetime(lifetime, signal, work) {
  if (lifetime === null || lifetime === undefined || lifetime === signal) return work(signal ?? null);
  if (lifetime.aborted) return Promise.reject(abortReason(lifetime));
  if (signal === null || signal === undefined) return work(lifetime);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  const joined = new AbortController();
  const stopLifetime = onAbort(lifetime, () => joined.abort(abortReason(lifetime)));
  const stopSignal = onAbort(signal, () => joined.abort(abortReason(signal)));
  const release = () => {
    stopLifetime();
    stopSignal();
  };
  let running;
  try {
    running = Promise.resolve(work(joined.signal));
  } catch (error) {
    running = Promise.reject(error);
  }
  running.then(release, release);
  return running;
}

/**
 * One piece of work many waiters share, the one rule every shared piece of
 * work follows (a merged byte request, a chunk decoded once for several
 * reads, a chunk index leaf, a heap collection, a modality's cell map, a
 * field or gene load several views wait for): the work runs with a signal
 * of its own, which aborts once every waiter has withdrawn (its own signal
 * aborted) and never before, so cancelling one read never fails another; a
 * waiter whose signal aborts is answered at once, with its own signal's
 * reason. A waiter whose signal did not fire therefore never sees an
 * AbortError of another's, and the work's own abort names no waiter's
 * reason: it is `superseded` -- nobody waits for it any more.
 *
 * Work that every waiter left is `abandoned`: nothing joins it any more
 * (`SharedWorks` starts it again for the next that asks).
 */
export class SharedWork {
  /**
   * @param {(signal: AbortSignal) => Promise<*>|*} start - Starts the work
   *   at once (in this task, so reads it asks for are planned with those
   *   of the task), with the signal it is to stop on
   */
  constructor(start) {
    this._controller = new AbortController();
    this._live = 0;
    /** Waiters that ever joined (more than one: the work's result is shared). */
    this.joins = 0;
    this.settled = false;
    let promise;
    try {
      promise = Promise.resolve(start(this._controller.signal));
    } catch (error) {
      promise = Promise.reject(error);
    }
    this.promise = promise;
    const settle = () => {
      this.settled = true;
    };
    // A rejection nobody waits for any more is not unhandled.
    promise.then(settle, settle);
  }

  /** What the work runs with: aborts once every waiter has withdrawn. */
  get signal() {
    return this._controller.signal;
  }

  /** Whether every waiter withdrew before the work was done, and it was stopped. */
  get abandoned() {
    return this._controller.signal.aborted;
  }

  /**
   * One waiter that withdraws by calling the function returned (once; later
   * calls do nothing), for work whose waiters are followed elsewhere (the
   * reads of a merged request).
   *
   * @returns {() => void}
   */
  hold() {
    this._live++;
    this.joins++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (--this._live === 0 && !this.settled) {
        cancel(this._controller, 'superseded', 'No one waits for this work any more.');
      }
    };
  }

  /**
   * Wait for the work as one waiter: its result, or this waiter's own
   * signal's reason as soon as that aborts. A waiter without a signal never
   * withdraws.
   *
   * @param {AbortSignal|null} [signal]
   * @returns {Promise<*>}
   */
  join(signal = null) {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.abandoned) return Promise.reject(new TypeError('Work every waiter left is not joined again: start it anew.'));
    const leave = this.hold();
    if (signal === null || this.settled) return this.promise;
    return new Promise((resolve, reject) => {
      const stopWaiting = onAbort(signal, () => {
        reject(abortReason(signal));
        leave();
      });
      this.promise.then(
        value => {
          stopWaiting();
          resolve(value);
        },
        error => {
          stopWaiting();
          reject(error);
        }
      );
    });
  }
}

/**
 * Shared work by key (`SharedWork`): `run` joins the work running under a
 * key, or starts it when none runs or the one there was abandoned. Work is
 * forgotten once it fails or is abandoned, and once it is done unless
 * `keep` (a memo: its result is the key's from then on).
 */
export class SharedWorks {
  /** @param {{keep?: boolean}} [options] */
  constructor({ keep = false } = {}) {
    this._keep = keep;
    /** @type {Map<*, SharedWork>} */
    this._works = new Map();
  }

  /** The work under `key` a waiter may still join (running, or kept), else undefined. */
  get(key) {
    const work = this._works.get(key);
    return work === undefined || work.abandoned ? undefined : work;
  }

  /** Whether work a waiter may join is under `key`. */
  has(key) {
    return this.get(key) !== undefined;
  }

  /**
   * The work under `key`: the one there, else `start(options)` begun now,
   * `options` being the asker's with the work's own `signal`.
   *
   * @param {*} key
   * @param {(options: Object) => Promise<*>|*} start
   * @param {Object} [options] - The asker's read options (its `activity` and the like)
   * @returns {SharedWork}
   */
  work(key, start, options = {}) {
    const running = this.get(key);
    if (running !== undefined) return running;
    const work = new SharedWork(signal => start({ ...options, signal }));
    this._works.set(key, work);
    const forget = () => {
      if (this._works.get(key) === work) this._works.delete(key);
    };
    work.promise.then(this._keep ? undefined : forget, forget);
    // Abandoned: the next asker starts it anew.
    onAbort(work.signal, forget);
    return work;
  }

  /**
   * Join the work under `key` (starting it when none runs) as a waiter
   * with `options.signal`.
   *
   * @returns {Promise<*>}
   */
  run(key, start, options = {}) {
    return this.work(key, start, options).join(options.signal ?? null);
  }

  /** Forget the work under `key` (what joined it still gets its result). */
  delete(key) {
    this._works.delete(key);
  }

  /** Forget every work. */
  clear() {
    this._works.clear();
  }
}

/**
 * Work started by the first that asks and shared by every later ask
 * (`SharedWorks` of one key, kept): `ask(options)` resolves its result,
 * each asker waiting with its own `options.signal`; `start` is given the
 * first asker's options with the work's own signal. `ask.asked()`: whether
 * the work is under way or done (not failed, not abandoned).
 *
 * @param {(options: Object) => Promise<*>|*} start
 * @returns {((options?: Object) => Promise<*>) & {asked: () => boolean}}
 */
export function sharedOnce(start) {
  const works = new SharedWorks({ keep: true });
  const ask = (options = {}) => works.run(0, start, options ?? {});
  ask.asked = () => works.has(0);
  return ask;
}
