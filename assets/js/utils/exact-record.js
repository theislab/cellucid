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
