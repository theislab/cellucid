/**
 * Waiting on an `AbortSignal` from many reads at once.
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
