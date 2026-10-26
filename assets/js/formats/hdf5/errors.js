/**
 * The two ways reading an HDF5 file can fail on the file's account.
 *
 * - `Hdf5FormatError`: the bytes are not what the format says they must be
 *   (a wrong signature, a pointer past the end of the file, a checksum that
 *   does not match). The message names the structure and its file offset.
 * - `Hdf5UnsupportedError`: the file is valid, but uses a feature this reader
 *   does not read (a compression filter, an external link, a datatype with no
 *   counterpart in the array store). `feature` says which, as a short
 *   identifier a caller can act on; the message says it in plain language.
 *
 * Errors from the byte source (network, file changed) and aborts pass
 * through unchanged.
 *
 * @module formats/hdf5/errors
 */

/** The file is not valid HDF5 where the reader looked. */
export class Hdf5FormatError extends Error {
  /**
   * @param {string} message
   * @param {{cause?: unknown, offset?: number|null}} [options]
   */
  constructor(message, { cause, offset = null } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'Hdf5FormatError';
    this.offset = offset;
  }
}

/** The file uses a part of HDF5 this reader does not read. */
export class Hdf5UnsupportedError extends Error {
  /**
   * @param {string} feature - Short identifier, e.g. `'filter:szip'`
   * @param {string} message
   * @param {{cause?: unknown}} [options]
   */
  constructor(feature, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'Hdf5UnsupportedError';
    this.feature = feature;
  }
}

/** A format error about the structure `what` at absolute file offset `offset`. */
export function formatError(what, offset, problem, options = {}) {
  const where = Number.isFinite(offset) ? ` at offset ${offset}` : '';
  return new Hdf5FormatError(`${what}${where}: ${problem}`, { ...options, offset });
}

/** Throw the abort reason when `signal` has been aborted. */
export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The read was aborted.', 'AbortError');
  }
}
