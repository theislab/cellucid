/**
 * Waiting on an `AbortSignal` from many reads at once, and work many reads
 * share (`SharedWork`, `SharedWorks`, `sharedOnce`): cancelled only once
 * every read waiting on it has withdrawn.
 *
 * Thousands of reads often share one signal (the rows of every cell of a
 * selection, the chunks of every gene of an analysis). An `abort` listener
 * per read would make each `addEventListener` scan every listener already on
 * the signal (the DOM checks for duplicates), so registering n reads would
 * cost O(n^2). `onAbort` keeps one listener per signal and a set of the
 * callbacks waiting on it: registering and releasing a callback is O(1), and
 * an abort still calls every waiting callback at once, in registration
 * order, exactly once.
 *
 * @module formats/io/abort
 */

/** @type {WeakMap<AbortSignal, {entries: Set<{callback: () => void}>, fire: () => void}>} */
const registries = new WeakMap();

const NOTHING = () => {};

/**
 * Call `callback` when `signal` aborts (not when it already has: check
 * `signal.aborted` first, as with `addEventListener`). Returns the function
 * that stops waiting; call it once the work is settled.
 *
 * @param {AbortSignal|null|undefined} signal
 * @param {() => void} callback
 * @returns {() => void}
 */
export function onAbort(signal, callback) {
  if (signal === null || signal === undefined) return NOTHING;
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

/** Why `signal` aborted: its reason, else an AbortError. */
function reasonOf(signal) {
  return signal.reason ?? new DOMException('The read was aborted.', 'AbortError');
}

/**
 * One piece of work many waiters share, the one rule every shared piece of
 * work of the readers follows (a merged byte request, a chunk decoded once
 * for several reads, a chunk index leaf, a heap collection, a modality's
 * cell map): the work runs with a signal of its own, which aborts once
 * every waiter has withdrawn (its own signal aborted) and never before, so
 * cancelling one read never fails another; a waiter whose signal aborts is
 * answered at once, with its own signal's reason. A waiter whose signal did
 * not fire therefore never sees an AbortError of another's.
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
        this._controller.abort(new DOMException('No one waits for this work any more.', 'AbortError'));
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
    if (signal?.aborted) return Promise.reject(reasonOf(signal));
    if (this.abandoned) return Promise.reject(new TypeError('Work every waiter left is not joined again: start it anew.'));
    const leave = this.hold();
    if (signal === null || this.settled) return this.promise;
    return new Promise((resolve, reject) => {
      const stopWaiting = onAbort(signal, () => {
        reject(reasonOf(signal));
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
    work.signal.addEventListener('abort', forget, { once: true });
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
