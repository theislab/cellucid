/**
 * @fileoverview Closed current-schema assertions for session capture/restore.
 *
 * Session files are untrusted input. Every session owner validates its complete
 * current record before mutating application state.
 *
 * @module session/schema-contract
 */


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
 * One category name, for a message a person reads.
 *
 * @param {string|number|boolean} value
 * @returns {string}
 */
export function describeCategory(value) {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

/** Position recorded for a category name that a field lists more than once. */
export const DUPLICATE_CATEGORY_POSITION = -2;

/**
 * Index one category inventory by name in a single pass, so resolving every
 * saved category of a field costs one lookup each instead of a scan.
 * A name listed more than once maps to {@link DUPLICATE_CATEGORY_POSITION};
 * a name not listed is absent.
 *
 * @param {readonly (string|number|boolean)[]} categories
 * @returns {Map<string|number|boolean, number>}
 */
export function indexCategoryPositions(categories) {
  const positions = new Map();
  for (let index = 0; index < categories.length; index++) {
    const name = categories[index];
    positions.set(
      name,
      positions.has(name) ? DUPLICATE_CATEGORY_POSITION : index
    );
  }
  return positions;
}

export function assertFiniteNumber(value, context) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${context} must be a finite number.`);
  }
  return value;
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
