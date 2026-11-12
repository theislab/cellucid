/**
 * Errors across a thread boundary: the one wire format every worker of the
 * app answers a failed request with (the reader, decode, analysis and
 * figure-export workers). An error keeps there what decides how it is
 * shown, so the page tells it apart exactly as the thread that raised it did:
 *
 * - its class (`name`: `RangeError` for a refused allocation, `TypeError`,
 *   a class the receiver names in `classes`) and its words;
 * - a cancellation's kind (`utils/abort.js`): rebuilt as the same kind of
 *   cancellation, never as a failure;
 * - its code, details (an explained failure's mark among them,
 *   `data/data-source.js`), what it is about (`key`, `columns`, `feature`,
 *   `offset`, `bytes`, `status`, `url`) and whether it was already shown
 *   (`utils/errors.js`);
 * - its cause chain and an AggregateError's errors.
 *
 * Structured clone alone drops all of this but the name and message.
 *
 * @module utils/error-wire
 */

import { cancellationKind, cancelled, isCancellation } from './abort.js';
import { isReported, markReported } from './errors.js';

/** The properties an error keeps across the wire (cloned; text when not clonable). */
const KEPT = ['code', 'key', 'reason', 'bytes', 'details', 'columns', 'feature', 'offset', 'status', 'url'];

const STANDARD = { RangeError, TypeError, SyntaxError, EvalError, ReferenceError, URIError };

/**
 * One error as a plain, structured-clonable record.
 *
 * @param {unknown} error
 * @returns {Object}
 */
export function toWire(error, seen = new Set()) {
  if (error === null || typeof error !== 'object' || typeof error.message !== 'string') {
    return { name: 'Error', message: String(error) };
  }
  const record = { name: typeof error.name === 'string' ? error.name : 'Error', message: error.message };
  // A cause chain crosses whole; an error met again (a cycle) is not followed.
  seen.add(error);
  const kind = cancellationKind(error);
  if (kind !== null) record.kind = kind;
  if (isReported(error)) record.reported = true;
  if (typeof error.source === 'string') record.sourceType = error.source;
  for (const key of KEPT) {
    // A DOMException's `code` is the platform's number for its name (20 for AbortError), not a code of ours.
    if (key === 'code' && typeof DOMException === 'function' && error instanceof DOMException) continue;
    if (error[key] === undefined) continue;
    try {
      record[key] = structuredClone(error[key]);
    } catch {
      record[key] = String(error[key]);
    }
  }
  if (error.cause !== undefined && !seen.has(error.cause)) record.cause = toWire(error.cause, seen);
  if (Array.isArray(error.errors)) record.errors = error.errors.filter(item => !seen.has(item)).map(item => toWire(item, seen));
  return record;
}

/**
 * The error `record` (`toWire`) describes, rebuilt: a cancellation of its
 * kind, a `TimeoutError`, a standard error class, or a class of `classes`
 * (`{name: (record, cause) => Error}`, for the receiver's own classes).
 *
 * @param {Object} record
 * @param {Object<string, (record: Object, cause: Error|undefined) => Error>} [classes]
 * @returns {Error}
 */
export function fromWire(record, classes = {}) {
  if (record === null || typeof record !== 'object') return new Error(String(record));
  const cause = record.cause === undefined ? undefined : fromWire(record.cause, classes);
  const message = typeof record.message === 'string' ? record.message : String(record.message);
  let error;
  if (isCancellation(record)) {
    error = cancelled(typeof record.kind === 'string' ? record.kind : 'user', message || 'The work was canceled.', cause);
  } else if (record.name === 'TimeoutError' && typeof DOMException === 'function') {
    error = new DOMException(message, 'TimeoutError');
  } else if (Object.hasOwn(classes, record.name)) {
    error = classes[record.name](record, cause);
  } else if (record.name === 'AggregateError') {
    error = new AggregateError((record.errors ?? []).map(item => fromWire(item, classes)), message, cause === undefined ? undefined : { cause });
  } else {
    const Type = STANDARD[record.name] ?? Error;
    error = new Type(message, cause === undefined ? undefined : { cause });
    if (!(record.name in STANDARD) && record.name !== 'Error' && typeof record.name === 'string') error.name = record.name;
  }
  if (cause !== undefined && error.cause === undefined) {
    Object.defineProperty(error, 'cause', { value: cause, configurable: true, writable: true });
  }
  if (typeof record.sourceType === 'string' && error.source === undefined) error.source = record.sourceType;
  for (const key of KEPT) {
    if (record[key] === undefined || error[key] !== undefined) continue;
    if (key === 'code' && typeof DOMException === 'function' && error instanceof DOMException) continue;
    error[key] = record[key];
  }
  if (record.reported === true) markReported(error);
  return error;
}
