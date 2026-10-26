/**
 * Waits on the person: a sign-in window, a consent screen, Google's file
 * picker, the question which object of an R file to open. While one is open,
 * nothing the page waits for is the network's to deliver, so a deadline
 * that measures a request's silence (a startup step, `app/startup-phase.js`)
 * stands still and starts over, whole, once the person has answered.
 *
 * Whatever asks the person registers its wait here (`whileWaitingOnPerson`),
 * for as long as it lasts; whatever measures silence listens
 * (`onWaitingOnPerson`).
 *
 * @module utils/person-wait
 */

let open = 0;
const listeners = new Set();

function publish(waiting) {
  for (const listener of listeners) {
    try {
      listener(waiting);
    } catch (error) {
      console.error('[cellucid:person-wait] A listener failed:', error);
    }
  }
}

/**
 * Hold `promise` as a wait on the person until it settles; returns it.
 *
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T>}
 */
export function whileWaitingOnPerson(promise) {
  if (typeof promise?.then !== 'function') throw new TypeError('A wait on the person is a promise.');
  open += 1;
  if (open === 1) publish(true);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    open -= 1;
    if (open === 0) publish(false);
  };
  promise.then(end, end);
  return promise;
}

/** Whether the page waits on the person now. */
export function isWaitingOnPerson() {
  return open > 0;
}

/**
 * Be told whenever the page starts or stops waiting on the person; the
 * listener hears the current state at once.
 *
 * @param {(waiting: boolean) => void} listener
 * @returns {() => void} Stops listening
 */
export function onWaitingOnPerson(listener) {
  if (typeof listener !== 'function') throw new TypeError('A person-wait listener is a function.');
  listeners.add(listener);
  listener(open > 0);
  return () => listeners.delete(listener);
}
