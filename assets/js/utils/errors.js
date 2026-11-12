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
 * - **Said to a person** (`sayFailure`, `failureDetails`): a failure written as a
 *   sentence is said as it is; a broken invariant of the code is named as such,
 *   its own text left for Details (`failureDetails`) and the console. Every
 *   notification and status line that says a failure goes through these
 *   (`tests/failure-wording-contract.test.mjs`).
 *
 * Crossing a thread or a process, an error keeps its name, kind, code,
 * details, explanation and mark through `utils/error-wire.js`.
 *
 * @module utils/errors
 */

import { isCancellation } from './abort.js';
import { upperFirst } from './text-case.js';

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
 * cancellation is not; the promise returned always fulfills, once `work` has
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
 * Whether a failure is a broken invariant of the code, not a sentence for a
 * person: every check of the code's own contracts throws a `TypeError`, as the
 * engine does for a programming error. Its name survives `error-wire.js`.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isInternalFailure(error) {
  // A subclass (the history model's `HistoryModelError`) is one too, here or as the wire names it.
  return error instanceof TypeError || INTERNAL_NAMES.includes(error?.name);
}

const INTERNAL_NAMES = ['TypeError', 'ReferenceError', 'SyntaxError', 'HistoryModelError', 'InternalError'];

/**
 * A failure of the code's own (a broken invariant, a GPU object the code
 * could not get), whose message names the code ("VelocityOverlay could not
 * allocate…") for a bug report: `sayFailure` says that a problem inside
 * Cellucid stopped it and `failureDetails` folds these words under Details.
 * Any error a code class names in its message is one
 * (`tests/failure-wording-contract.test.mjs`).
 */
export class InternalError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'InternalError';
  }
}

/**
 * A failure as a person reads it: `failureText` when it is written for one
 * (a refusal, a read that says why), else that something inside went wrong.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function sayFailure(error) {
  if (isDamagedFile(error)) return DAMAGED_FILE;
  return isInternalFailure(error) ? INTERNAL_FAILURE : failureText(error);
}

/** What `sayFailure` says of a file that breaks its format (`markDamaged`): what breaks it goes under Details. */
export const DAMAGED_FILE = 'the file is damaged.';

/** The mark of a file that breaks its format (`markDamaged`, `isDamagedFile`). */
const DAMAGED = Symbol.for('cellucid.fileDamaged');

/**
 * Mark `error` as a file that breaks its format (a session file, a library
 * file, a bundle's framing): its message says what, for the console and
 * Details; the person reads that the file is damaged (`sayFailure`), never
 * the ids, offsets and keys it names.
 *
 * @template {Error} E
 * @param {E} error
 * @returns {E}
 */
export function markDamaged(error) {
  Object.defineProperty(error, DAMAGED, { value: true });
  return error;
}

/** Whether `error` (or what it was caused by) says a file breaks its format (`markDamaged`). */
export function isDamagedFile(error) {
  for (let at = error, depth = 0; at !== null && typeof at === 'object' && depth < 8; at = at.cause, depth++) {
    if (at[DAMAGED] === true) return true;
  }
  return false;
}

/** What `sayFailure` says of a broken invariant: its words are for a bug report, not the sentence. */
export const INTERNAL_FAILURE = 'a problem inside Cellucid stopped it.';

/** The same, where the words are folded under the card's Details (`pointToDetails`). */
export const INTERNAL_FAILURE_WITH_DETAILS = 'a problem inside Cellucid stopped it; Details has its words for a bug report.';

/**
 * A message whose card folds a failure's words under Details: the sentence
 * of a broken invariant says where they are. The notification center applies
 * it to every card given `details` (a status line or a chat note has no
 * Details and says the sentence alone).
 *
 * @param {string} message
 * @returns {string}
 */
export function pointToDetails(message) {
  return message
    .replaceAll(INTERNAL_FAILURE, INTERNAL_FAILURE_WITH_DETAILS)
    .replaceAll(`A${INTERNAL_FAILURE.slice(1)}`, `A${INTERNAL_FAILURE_WITH_DETAILS.slice(1)}`);
}

/** The verb phrase a failure's lead ends with ("… could not be opened"), which a sentence after it must not say again. */
const LEAD_VERB = /\b((?:could not|cannot|can not|did not|was not|were not|is not|are not)(?: be)? \w+)(?!.*\b(?:could not|cannot|can not|did not|was not|were not|is not|are not)\b)/i;

/**
 * A failure said after its lead, said once: `lead: said`. When `said` begins
 * by saying what `lead` says ("The linked data could not be opened: the
 * server answered 404." after "\"Beta\" could not be opened"), only what
 * follows its own lead is kept ("\"Beta\" could not be opened: the server
 * answered 404."). Every wrapper of a failure sentence in a lead that names
 * what failed goes through it (`tests/failure-wording-contract.test.mjs`).
 *
 * @param {string} lead - "<what> could not be <done> …" (its last such verb is the one compared), no closing mark
 * @param {string} said - the failure's sentence (`sayFailure`, a summary)
 * @returns {string}
 */
export function joinFailure(lead, said) {
  const verb = lead.match(LEAD_VERB)?.[1];
  if (verb !== undefined) {
    const escaped = verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const repeated = said.match(new RegExp(`^[^:.;]*?\\b${escaped}\\b\\s*([:.;]?)\\s*`, 'i'));
    if (repeated !== null) {
      const rest = said.slice(repeated[0].length);
      // A sentence that is only its own lead is the reason, unless it says nothing more ("it could not be read").
      if (rest === '') return /^\s*(?:it|this|that)\s/i.test(said) ? `${lead}.` : `${lead}: ${said}`;
      const rested = repeated[1] === ':' || repeated[1] === '' ? rest : upperFirst(rest);
      return repeated[1] === ':' || repeated[1] === '' ? `${lead}: ${rested}` : `${lead}. ${rested}`;
    }
  }
  return `${lead}: ${said}`;
}

/**
 * `sayFailure` said on its own, as a notification's whole message: it starts
 * a sentence.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function failureSentence(error) {
  const said = sayFailure(error);
  return upperFirst(said);
}

/**
 * What a failure said with `sayFailure` folds under its notification's
 * Details: the words of a broken invariant (or of the one a refusal names as
 * its `reason`), which the sentence does not say; nothing for a failure the
 * sentence says whole. Spread into the notification's options:
 * `center.error(`${what} failed: ${sayFailure(error)}`, { category, ...failureDetails(error) })`.
 *
 * @param {unknown} error
 * @returns {{details?: string}}
 */
export function failureDetails(error) {
  if (isDamagedFile(error)) return { details: failureDetailsText(error) };
  const internal = isInternalFailure(error) ? error : (isInternalFailure(error?.reason) ? error.reason : null);
  return internal === null ? {} : { details: failureDetailsText(internal) };
}

/**
 * A failure's whole words for Details and the console: `failureText`, and an
 * AggregateError's errors after its own words ("recovery failed: first
 * cause; second cause"), which a sentence for the person leaves out.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function failureDetailsText(error) {
  const said = failureText(error);
  if (!Array.isArray(error?.errors) || error.errors.length === 0) return said;
  const reasons = error.errors.map(failureDetailsText).filter(reason => !said.includes(reason));
  return reasons.length === 0 ? said : `${said}: ${reasons.join('; ')}`;
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
