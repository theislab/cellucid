/**
 * Failures: how each reaches the person exactly once, and how background
 * work that nobody awaits is still observed. Cancellations are not failures
 * (`utils/abort.js`): nothing here reports one.
 *
 * - **Reported once** (`markReported`, `isReported`): the surface that shows
 *   a failure (a loading notification, a restore's progress card) marks the
 *   error; a caller further up that would show the same failure again skips
 *   a marked one. The mark is a property of the error, so it holds whichever
 *   path the error travels.
 * - **Settled quietly** (`settleQuietly`): work started and not awaited (a
 *   kept journal's removal, a store's discard) is observed, so a failure is
 *   logged with what was being done instead of surfacing as an unhandled
 *   rejection, and never stops the work that follows it.
 *
 * - **Said to a person** (`sayFailure`): a failure written as a sentence is said
 *   as it is; a broken invariant of the code is named as such, its own text left
 *   for Details and the console.
 *
 * Crossing a thread or a process, an error keeps its name, kind, code,
 * details, explanation and mark through `utils/error-wire.js`.
 *
 * @module utils/errors
 */

import { isCancellation } from './abort.js';

/** The mark of a failure already shown to the person (survives `error-wire.js`). */
const REPORTED = Symbol.for('cellucid.failureReported');

/**
 * Mark `error` as shown to the person: whoever else would show it skips it
 * (`isReported`). Returns `error`.
 *
 * @template E
 * @param {E} error
 * @returns {E}
 */
export function markReported(error) {
  if (error !== null && typeof error === 'object' && Object.isExtensible(error)) {
    Object.defineProperty(error, REPORTED, { value: true, configurable: true });
  }
  return error;
}

/** Whether `error` was already shown to the person (`markReported`). */
export function isReported(error) {
  return error !== null && typeof error === 'object' && error[REPORTED] === true;
}

/**
 * Observe `work` (a promise, or anything else, taken as done) that nobody
 * awaits for its result: a failure is logged with `doing` (what was being
 * done, a phrase: `discarding the journal of a changed file`), a
 * cancellation is not; the promise returned always fulfils, once `work` has
 * settled, so whatever is awaited after it still runs.
 *
 * @param {Promise<unknown>|unknown} work
 * @param {string} doing
 * @returns {Promise<void>}
 */
export function settleQuietly(work, doing) {
  return Promise.resolve(work).then(
    () => {},
    error => {
      if (!isCancellation(error)) console.warn(`[cellucid] Failed ${doing}:`, error);
    }
  );
}

/**
 * A failure in words for the person: its message, else its class and its
 * cause's words -- never empty. An error whose message is empty (a
 * browser's bare `Error`, an exception thrown without words, a structured
 * clone that kept only the name) still says what kind it is, and why
 * (`cause`, as `utils/error-wire.js` carries it across a thread), so a
 * failure is never shown as "failed: " and nothing more. A cause adds its
 * words when the message does not hold them already.
 *
 * @param {unknown} error
 * @returns {string}
 */
/**
 * Whether a failure is a broken invariant of the code, not a sentence for a
 * person: every check of the code's own contracts throws a `TypeError`, as the
 * engine does for a programming error. Its name survives `error-wire.js`.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isInternalFailure(error) {
  return ['TypeError', 'ReferenceError', 'SyntaxError'].includes(error?.name);
}

/**
 * A failure as a person reads it: `failureText` when it is written for one
 * (a refusal, a read that says why), else that something inside went wrong.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function sayFailure(error) {
  return isInternalFailure(error) ? 'a problem inside Cellucid stopped it.' : failureText(error);
}

export function failureText(error) {
  const seen = new Set();
  const words = [];
  for (let at = error; at !== undefined && at !== null && !seen.has(at) && words.length < 4; at = at?.cause) {
    seen.add(at);
    if (typeof at !== 'object') {
      const text = String(at).trim();
      if (text !== '') words.push(text);
      break;
    }
    const message = typeof at.message === 'string' ? at.message.trim() : '';
    const name = typeof at.name === 'string' && at.name !== '' ? at.name : 'Error';
    if (message !== '') {
      if (!words.some(said => said.includes(message))) words.push(message);
    } else if (Array.isArray(at.errors) && at.errors.length > 0) {
      words.push(`${name}: ${at.errors.map(failureText).join('; ')}`);
    } else {
      words.push(`${name} (no message given)`);
    }
  }
  return words.length === 0 ? 'Error (no message given)' : words.join(': ');
}
