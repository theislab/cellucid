/**
 * Why an R serialization stream could not be read.
 *
 * - `RdsFormatError`: the stream is damaged, truncated or not what it claims
 *   (a length larger than what remains, an unknown item type, a reference to
 *   an item never read). `slot` names where in the object it happened
 *   (`@assays$RNA@counts@x`), when that is known.
 * - `RdsUnsupportedError`: a valid stream uses something this reader does not
 *   read (ASCII or native-binary serialization, zstd compression, an ALTREP
 *   class of a package). `feature` names it, and the message says what to do.
 *
 * @module formats/rds/errors
 */

/** The stream is damaged or contradicts itself. */
export class RdsFormatError extends Error {
  /**
   * @param {string} message
   * @param {{slot?: string|null, cause?: unknown}} [options]
   */
  constructor(message, { slot = null, cause } = {}) {
    super(slot === null ? message : `${message} (at ${slot})`, cause === undefined ? undefined : { cause });
    this.name = 'RdsFormatError';
    this.slot = slot;
  }
}

/** The stream is valid but uses something this reader does not read. */
export class RdsUnsupportedError extends Error {
  /**
   * @param {string} feature - What is not supported, in a few words
   * @param {string} message - What it is and what to do, in plain words
   * @param {{slot?: string|null, cause?: unknown}} [options]
   */
  constructor(feature, message, { slot = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RdsUnsupportedError';
    this.feature = feature;
    this.slot = slot;
  }
}
