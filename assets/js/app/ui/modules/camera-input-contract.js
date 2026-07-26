/**
 * Exact option validation for camera command boundaries.
 */

/**
 * Read a required one-field boolean options object.
 *
 * @param {unknown} options
 * @param {string} property
 * @param {string} label
 * @returns {boolean}
 */
export function readCameraBooleanOption(options, property, label) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).length !== 1 ||
    !Object.hasOwn(options, property) ||
    typeof options[property] !== 'boolean'
  ) {
    throw new TypeError(`${label} requires an exact boolean "${property}" option.`);
  }
  return options[property];
}
