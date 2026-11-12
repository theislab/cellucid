/**
 * @fileoverview FNV-1a, 32 bits, over a string's UTF-16 code units: the one
 * quick hash of text that is the same on every engine. A string table's slot
 * (`string-index.js`), the spread of a request's retry waits
 * (`formats/io/byte-source.js` `spreadOf`), a figure's seed and SVG id prefix,
 * and a contributor's pull-request branch (`community-annotations/github-sync.js`)
 * all hash with it. Not a digest: `sha256.js` is the one for integrity.
 *
 * @module utils/fnv1a
 */

/**
 * @param {string} text
 * @returns {number} An unsigned 32-bit integer.
 */
export function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
