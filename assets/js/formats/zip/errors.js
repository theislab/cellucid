/**
 * Why a ZIP archive could not be read.
 *
 * - `ZipFormatError`: the archive is damaged or contradicts itself (a footer
 *   that points outside the file, an entry whose bytes fail their CRC-32).
 * - `ZipUnsupportedError`: a valid archive uses something this reader does
 *   not read (encryption, a compression method other than stored or deflate,
 *   an archive split over several disks). `feature` names it.
 *
 * @module formats/zip/errors
 */

/** The archive is damaged or contradicts itself. */
export class ZipFormatError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ZipFormatError';
  }
}

/** The archive is valid but uses a feature this reader does not read. */
export class ZipUnsupportedError extends Error {
  /**
   * @param {string} feature - What is not supported, in a few words
   * @param {string} message
   */
  constructor(feature, message, options) {
    super(message, options);
    this.name = 'ZipUnsupportedError';
    this.feature = feature;
  }
}
