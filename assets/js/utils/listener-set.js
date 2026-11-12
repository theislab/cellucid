/**
 * @fileoverview The one set of listeners: whoever must be told when
 * something changes subscribes here, and the owner of the change tells them
 * all (`notify`). Every listener hears every notice, whatever another one
 * does: a listener that throws is reported, once, as `console.error` naming
 * the set ("[cellucid] A listener of the history failed: …"), and the others
 * still run, as they do for a DOM event listener.
 *
 * Why `console.error`, not a rethrow: a rethrow in a microtask or
 * `reportError` is an uncaught error of the realm, which in a worker reaches
 * the page as the worker's `error` event, read there as the worker failing
 * (the pools retire it). One listener's mistake is not its notifier's
 * failure: the change it was told of did happen, so it is not thrown back
 * at whoever made it. The console names the set and keeps the listener's own
 * stack, on the page, in every worker and in Node alike.
 *
 * What a notice reaches is fixed when it starts: a listener added during it
 * hears the next one, a listener removed during it (by itself or by another)
 * hears nothing more, so a listener tearing a view down never calls into the
 * view it tore down. A listener added again while it is in is in once (as
 * with `addEventListener`), and an unsubscribe only ever removes the
 * subscription it was returned for: calling it twice, or after the listener
 * was added again since, does nothing.
 *
 * Callbacks whose results are used (awaited in order, a first that answers
 * wins, a value passed on) are not listeners: they keep their own loops
 * (`tests/one-implementation-contract.test.mjs` names them).
 *
 * @module utils/listener-set
 */

/**
 * @template {unknown[]} A
 * @typedef {Object} ListenerSet
 * @property {(listener: (...args: A) => void) => () => void} add
 *   Subscribe; returns the unsubscribe (idempotent).
 * @property {(listener: (...args: A) => void) => boolean} delete
 *   Unsubscribe by the function itself; whether it was in.
 * @property {(...args: A) => void} notify
 *   Tell every listener in now, in the order they were added.
 * @property {(isCurrent: () => boolean, ...args: A) => boolean} notifyWhile
 *   Tell them while `isCurrent()` holds after each: a listener that makes the
 *   news stale (it changed what is told, telling everyone the newer news)
 *   stops the rest hearing the older. Returns `isCurrent()` at the end.
 * @property {() => void} clear
 * @property {number} size
 */

/**
 * Report a listener's failure, the one way (the others still run): for a
 * registry of its own that cannot be a listener set (`onAbort`'s waits).
 *
 * @param {string} name - What the listener heard of
 * @param {unknown} error
 */
export function reportListenerFailure(name, error) {
  console.error(`[cellucid] A listener of ${name} failed:`, error);
}

/**
 * @template {unknown[]} [A=unknown[]]
 * @param {string} name - What its listeners hear of, as the report names it ("the history")
 * @returns {ListenerSet<A>}
 */
export function createListenerSet(name) {
  if (typeof name !== 'string' || name.trim() === '') throw new TypeError('A listener set has a name.');
  /** listener → its subscription (a token): an unsubscribe removes only its own. */
  const listeners = new Map();

  function tell(isCurrent, args) {
    if (listeners.size === 0) return true;
    for (const [listener, subscription] of [...listeners]) {
      if (listeners.get(listener) !== subscription) continue;
      try {
        listener(...args);
      } catch (error) {
        reportListenerFailure(name, error);
      }
      if (isCurrent !== null && !isCurrent()) return false;
    }
    return true;
  }

  return Object.freeze({
    add(listener) {
      if (typeof listener !== 'function') throw new TypeError(`A listener of ${name} is a function.`);
      let subscription = listeners.get(listener);
      if (subscription === undefined) {
        subscription = {};
        listeners.set(listener, subscription);
      }
      const own = subscription;
      return () => {
        if (listeners.get(listener) === own) listeners.delete(listener);
      };
    },
    delete(listener) {
      return listeners.delete(listener);
    },
    notify(...args) {
      tell(null, args);
    },
    notifyWhile(isCurrent, ...args) {
      if (typeof isCurrent !== 'function') throw new TypeError(`What keeps a notice of ${name} current is a function.`);
      return tell(isCurrent, args) && isCurrent();
    },
    clear() {
      listeners.clear();
    },
    get size() {
      return listeners.size;
    },
  });
}
