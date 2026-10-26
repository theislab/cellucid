/**
 * @fileoverview Exact records: the one place the app's modules check that a
 * value is a record and holds exactly the keys it may.
 *
 * - `isPlainRecord` / `requirePlainRecord` / `requireKeys` /
 *   `requireExactKeys`: data from JSON, a session file or a host (prototype
 *   `Object.prototype` or null).
 * - `isObjectRecord` / `requireObjectRecord` / `requireObjectKeys` /
 *   `requireExactObjectKeys`: an owner or options object the app built (any
 *   prototype: a `DataState`, a viewer), whose own fields are read.
 * - `requireClonedRecord`: worker payloads and options (prototype exactly
 *   `Object.prototype`, what `postMessage` delivers).
 *
 * Every key mismatch reads the same: "<label> must contain exactly: a, b
 * (missing: b; unexpected: c)." A caller with its own error class passes a
 * factory (`RecordFailure`). `tests/exact-record-owner-checks-contract.test.mjs`
 * keeps owners out of the plain checks.
 *
 * @module utils/exact-record
 */

/**
 * Publish a dynamic key on an ordinary record with CreateDataProperty semantics.
 *
 * Assignment already creates the required own enumerable, writable, and
 * configurable data property for every standard Object.prototype data name.
 * `__proto__` is the sole standard inherited accessor and needs the explicit
 * slow path to avoid changing the record's prototype instead.
 *
 * Keep this helper at record-publication boundaries. It must not be moved into
 * per-cell or per-frame loops.
 *
 * @template T
 * @param {Record<string, T>} record
 * @param {string} key
 * @param {T} value
 * @returns {T}
 */
export function setOwnDataProperty(record, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(record, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  } else {
    record[key] = value;
  }
  return value;
}

/**
 * Build the error a record check throws. Callers with their own error class
 * (a refusal that carries a source type, an HTTP status, a domain code) pass
 * a factory; `reason` is `'type'` for a non-record and `'keys'` for a key
 * mismatch, and `missing` / `unexpected` name the offending keys.
 *
 * @callback RecordFailure
 * @param {string} message
 * @param {{reason: 'type'|'keys', missing: string[], unexpected: string[]}} detail
 * @returns {Error}
 */

const EMPTY_KEYS = Object.freeze([]);

/** @type {RecordFailure} */
function typeFailure(message) {
  return new TypeError(message);
}

/**
 * A JSON-shaped record: a non-array object whose prototype is
 * `Object.prototype` or `null`. Class instances, arrays, boxed values and
 * functions are not records.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Any non-array object, whatever its prototype: a code-defined contract
 * (an analysis plugin, an option schema, a DOM-backed owner) whose own fields
 * are read and whose prototype is not part of the contract.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isObjectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @template T
 * @param {T} value
 * @param {string} label
 * @param {RecordFailure} [fail]
 * @returns {T & Record<string, unknown>}
 */
export function requirePlainRecord(value, label, fail = typeFailure) {
  if (!isPlainRecord(value)) {
    throw fail(`${label} must be a plain object; got ${describeValue(value)}.`, {
      reason: 'type',
      missing: [],
      unexpected: [],
    });
  }
  return /** @type {T & Record<string, unknown>} */ (value);
}

/**
 * A record whose prototype is exactly `Object.prototype`: the shape
 * `structuredClone` and `postMessage` deliver. Worker payloads and options
 * use it, so a worker checks the same record its sender checked (a
 * null-prototype record would arrive as an ordinary one).
 *
 * @template T
 * @param {T} value
 * @param {string} label
 * @param {RecordFailure} [fail]
 * @returns {T & Record<string, unknown>}
 */
export function requireClonedRecord(value, label, fail = typeFailure) {
  if (isPlainRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return /** @type {T & Record<string, unknown>} */ (value);
  }
  throw fail(`${label} must be a plain object; got ${describeValue(value)}.`, {
    reason: 'type',
    missing: [],
    unexpected: [],
  });
}

function describeValue(value) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') {
    const name = Object.getPrototypeOf(value)?.constructor?.name;
    return name ? `a ${name}` : 'an object';
  }
  return `a ${typeof value}`;
}

function includesKey(keys, key) {
  return keys instanceof Set ? keys.has(key) : keys.includes(key);
}

function sortedKeys(keys) {
  return [...keys].sort();
}

function describeAllowedKeys(required, optional) {
  if (optional.length === 0) {
    return required.length === 0
      ? 'must be empty'
      : `must contain exactly: ${required.join(', ')}`;
  }
  if (required.length === 0) return `may contain only: ${optional.join(', ')}`;
  return `must contain ${required.join(', ')} and may also contain ${optional.join(', ')}`;
}

/**
 * Require a plain record holding every `required` key and nothing outside
 * `required` and `optional` (arrays or Sets). One message names the allowed
 * keys and the missing and unexpected ones, in code-unit order.
 *
 * @template T
 * @param {T} value
 * @param {Iterable<string>} required
 * @param {Iterable<string>} optional
 * @param {string} label
 * @param {RecordFailure} [fail]
 * @returns {T & Record<string, unknown>}
 */
export function requireKeys(value, required, optional, label, fail = typeFailure) {
  return checkKeys(requirePlainRecord(value, label, fail), required, optional, label, fail);
}

/** The key check shared by plain records and object records. */
function checkKeys(record, required, optional, label, fail) {
  const requiredKeys = Array.isArray(required) || required instanceof Set ? required : [...required];
  const optionalKeys = Array.isArray(optional) || optional instanceof Set ? optional : [...optional];
  let missing = null;
  for (const key of requiredKeys) {
    if (!Object.hasOwn(record, key)) (missing ??= []).push(key);
  }
  let unexpected = null;
  for (const key of Object.keys(record)) {
    if (!includesKey(requiredKeys, key) && !includesKey(optionalKeys, key)) {
      (unexpected ??= []).push(key);
    }
  }
  if (missing === null && unexpected === null) return record;
  const missingKeys = missing === null ? [] : missing.sort();
  const unexpectedKeys = unexpected === null ? [] : unexpected.sort();
  const details = [
    ...(missingKeys.length > 0 ? [`missing: ${missingKeys.join(', ')}`] : []),
    ...(unexpectedKeys.length > 0 ? [`unexpected: ${unexpectedKeys.join(', ')}`] : []),
  ];
  throw fail(
    `${label} ${describeAllowedKeys(
      sortedKeys(requiredKeys),
      sortedKeys(optionalKeys).filter(key => !includesKey(requiredKeys, key))
    )} (${details.join('; ')}).`,
    { reason: 'keys', missing: missingKeys, unexpected: unexpectedKeys }
  );
}

/**
 * Require a plain record holding exactly `keys` (an array or a Set).
 *
 * @template T
 * @param {T} value
 * @param {Iterable<string>} keys
 * @param {string} label
 * @param {RecordFailure} [fail]
 * @returns {T & Record<string, unknown>}
 */
export function requireExactKeys(value, keys, label, fail = typeFailure) {
  return requireKeys(value, keys, EMPTY_KEYS, label, fail);
}

/**
 * Require any non-array object (`isObjectRecord`): an owner or a state
 * object the caller built, a class instance included, whose own fields are
 * read. A record from JSON or a session file is checked with
 * `requirePlainRecord` instead.
 *
 * @template T
 * @param {T} value
 * @param {string} label
 * @param {RecordFailure} [fail]
 * @returns {T & Record<string, unknown>}
 */
export function requireObjectRecord(value, label, fail = typeFailure) {
  if (!isObjectRecord(value)) {
    throw fail(`${label} must be an object; got ${describeValue(value)}.`, {
      reason: 'type',
      missing: [],
      unexpected: [],
    });
  }
  return /** @type {T & Record<string, unknown>} */ (value);
}

/**
 * `requireKeys` for any non-array object (`requireObjectRecord`): its own
 * enumerable keys are held to `required` and `optional`.
 *
 * @template T
 * @param {T} value
 * @param {Iterable<string>} required
 * @param {Iterable<string>} optional
 * @param {string} label
 * @param {RecordFailure} [fail]
 * @returns {T & Record<string, unknown>}
 */
export function requireObjectKeys(value, required, optional, label, fail = typeFailure) {
  return checkKeys(requireObjectRecord(value, label, fail), required, optional, label, fail);
}

/**
 * `requireExactKeys` for any non-array object (`requireObjectRecord`).
 *
 * @template T
 * @param {T} value
 * @param {Iterable<string>} keys
 * @param {string} label
 * @param {RecordFailure} [fail]
 * @returns {T & Record<string, unknown>}
 */
export function requireExactObjectKeys(value, keys, label, fail = typeFailure) {
  return requireObjectKeys(value, keys, EMPTY_KEYS, label, fail);
}
