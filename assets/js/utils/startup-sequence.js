/**
 * The one order of what a start puts in front of the person: the welcome
 * dialog first, as on every ordinary start,
 * then, once it is closed, whatever else the start asks or tells — the
 * dataset's "Continue where you left off?", a sample view's notices, the
 * question an opening of the link asks (which object of an R file to open).
 * Nothing is put on top of the welcome; nothing waits when no welcome is
 * shown (a notebook's viewer, a link that opens an agent's approval).
 *
 * The start says when its welcome is up (`holdStartupFor`); everything that
 * would show itself during the start waits its turn (`afterWelcome`).
 *
 * @module utils/startup-sequence
 */

/** @type {Promise<void>} */
let welcomeClosed = Promise.resolve();

/**
 * The welcome is up until `closed` settles: what `afterWelcome` waits for.
 * @param {Promise<unknown>} closed
 */
export function holdStartupFor(closed) {
  if (typeof closed?.then !== 'function') throw new TypeError('The welcome is held until a promise settles.');
  // A hold while another is up (the welcome shown again) waits for both.
  const before = welcomeClosed;
  welcomeClosed = Promise.all([before, Promise.resolve(closed).then(() => {}, () => {})]).then(() => {});
}

/** Resolves once the welcome is closed (at once when none is up). */
export function afterWelcome() {
  return welcomeClosed;
}

