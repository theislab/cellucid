/**
 * @fileoverview Panel letters for multi-panel figure exports.
 *
 * The drawn panel label ("A. Live") and the embedded provenance record must
 * name the same panel with the same letter, otherwise a reader cannot map a
 * metadata entry back to the panel it describes. One function owns the
 * sequence so the figure and its metadata can never disagree, and so a figure
 * with more than 26 panels keeps producing letters (AA, AB, …) instead of the
 * punctuation `String.fromCharCode(65 + index)` runs into past 'Z'.
 *
 * @module ui/modules/figure-export/utils/panel-label
 */

const ALPHABET_LENGTH = 26;

/**
 * The spreadsheet-style letter for a zero-based panel index.
 *
 * @param {number} index
 * @returns {string} 'A'…'Z', 'AA', 'AB', …
 */
export function panelLetter(index) {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError('Figure export panel index must be a non-negative integer.');
  }
  let remaining = index;
  let letters = '';
  do {
    letters = String.fromCharCode(65 + (remaining % ALPHABET_LENGTH)) + letters;
    remaining = Math.floor(remaining / ALPHABET_LENGTH) - 1;
  } while (remaining >= 0);
  return letters;
}
