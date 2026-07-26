/**
 * Exact numeric parsing for browser form boundaries.
 *
 * HTML numeric and range controls expose strings. These helpers accept only a
 * complete decimal string within one declared closed range. They never parse
 * prefixes, clamp, coerce, or replace malformed input.
 */

const DECIMAL_STRING = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const RANGE_OPTION_KEYS = ['label', 'maximum', 'minimum'];

function assertRangeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Numeric range parsing options must be an object.');
  }
  const keys = Object.keys(options).sort();
  if (
    keys.length !== RANGE_OPTION_KEYS.length ||
    keys.some((key, index) => key !== RANGE_OPTION_KEYS[index])
  ) {
    throw new TypeError(
      `Numeric range parsing options must contain exactly ${RANGE_OPTION_KEYS.join(', ')}.`
    );
  }
  const { minimum, maximum, label } = options;
  if (
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    minimum > maximum ||
    typeof label !== 'string' ||
    label.length === 0
  ) {
    throw new TypeError('Numeric range parsing requires finite bounds and a non-empty label.');
  }
}

/**
 * @param {unknown} raw
 * @param {{ minimum: number, maximum: number, label: string }} options
 * @returns {number}
 */
export function parseRangeInput(raw, options) {
  assertRangeOptions(options);
  const { minimum, maximum, label } = options;

  if (typeof raw !== 'string' || !DECIMAL_STRING.test(raw)) {
    throw new TypeError(`${label} must be a complete decimal input string; received ${String(raw)}.`);
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${label} must be a finite number from ${minimum} through ${maximum}; received ${raw}.`
    );
  }
  return value;
}

/**
 * @param {unknown} raw
 * @param {{ minimum: number, maximum: number, label: string }} options
 * @returns {number}
 */
export function parseIntegerInput(raw, options) {
  const value = parseRangeInput(raw, options);
  if (!Number.isInteger(value)) {
    throw new TypeError(`${options.label} must be an integer; received ${raw}.`);
  }
  return value;
}
