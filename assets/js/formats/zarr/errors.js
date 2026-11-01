/**
 * Why a Zarr store could not be read.
 *
 * - `ZarrFormatError`: the store is damaged or contradicts itself (metadata
 *   that is not valid JSON or misses a required field, a chunk that does not
 *   decode to its declared size).
 * - `ZarrUnsupportedError`: a valid store uses something this reader does not
 *   read (a codec, a data type, a chunk grid). `feature` names it, and the
 *   message says so in plain words.
 *
 * @module formats/zarr/errors
 */

/** The store is damaged or contradicts itself. */
export class ZarrFormatError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ZarrFormatError';
  }
}

/** The store is valid but uses a feature this reader does not read. */
export class ZarrUnsupportedError extends Error {
  /**
   * @param {string} feature - What is not supported, in a few words
   * @param {string} message
   */
  constructor(feature, message, options) {
    super(message, options);
    this.name = 'ZarrUnsupportedError';
    this.feature = feature;
  }
}
