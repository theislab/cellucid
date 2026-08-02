/**
 * @fileoverview Closed current-schema assertions for session capture/restore.
 *
 * Session files are untrusted input. Every session owner validates its complete
 * current record before mutating application state.
 *
 * @module session/schema-contract
 */

export function assertPlainRecord(value, context) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new TypeError(`${context} must be a plain object.`);
  }
  return value;
}

export function assertExactKeys(record, expectedKeys, context) {
  assertPlainRecord(record, context);
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(
      `${context} must contain the exact keys ${expected.join(', ')}.`,
    );
  }
  return record;
}

export function assertNonEmptyString(value, context) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
  ) {
    throw new TypeError(`${context} must be a nonempty trimmed string.`);
  }
  return value;
}

export function assertNullableString(value, context) {
  if (value === null) return value;
  return assertNonEmptyString(value, context);
}

export function assertBoolean(value, context) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${context} must be boolean.`);
  }
  return value;
}

/**
 * One value from a categorical field's `categories` inventory.
 *
 * A category name is the stable identity of a category: its position moves
 * whenever a dataset is exported again with a category added or removed, so
 * everything a session persists about a category is keyed by this value.
 * Categories are not always strings — an obs column can be categorical over
 * numbers or booleans — so the accepted set is exactly the primitives an
 * export can carry.
 *
 * @param {any} value
 * @param {string} context
 * @returns {string|number|boolean}
 */
export function assertCategoryPrimitive(value, context) {
  if (
    typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  throw new TypeError(
    `${context} must be a string, finite number, or boolean.`
  );
}

/**
 * One category name, for a message a person reads.
 *
 * @param {string|number|boolean} value
 * @returns {string}
 */
export function describeCategory(value) {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

export function assertFiniteNumber(value, context) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${context} must be a finite number.`);
  }
  return value;
}

export function assertNullableFiniteNumber(value, context) {
  if (value === null) return value;
  return assertFiniteNumber(value, context);
}

export function assertSafeInteger(value, context, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new TypeError(
      `${context} must be a safe integer from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}

export function assertNullableSafeInteger(value, context, bounds) {
  if (value === null) return value;
  return assertSafeInteger(value, context, bounds);
}

export function assertArray(value, context) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${context} must be an array.`);
  }
  return value;
}

export function requireMethod(owner, methodName, context) {
  if (
    owner === null
    || typeof owner !== 'object'
    || typeof owner[methodName] !== 'function'
  ) {
    throw new TypeError(`${context} requires ${methodName}().`);
  }
  return owner[methodName];
}
