/**
 * @fileoverview The case of a sentence's first letter, written one way: a
 * phrase that starts a sentence (`upperFirst`), and one that continues it
 * (`lowerFirst`, which leaves a name alone: "PCA", "CD3E", "HTTP"). A copy of
 * `text.charAt(0).toUpperCase() + text.slice(1)` or its lower-case twin would
 * lower an acronym's first letter ("pCA computed on …");
 * `tests/one-implementation-contract.test.mjs` refuses a new copy.
 *
 * @module utils/text-case
 */

/**
 * `text` with its first letter upper case: "colored by x" → "Colored by x".
 *
 * @param {string} text
 * @returns {string}
 */
export function upperFirst(text) {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/**
 * `text` with its first letter lower case, to go on inside a sentence
 * ("Colored by x" → "colored by x"), unless its first word is written in
 * capitals, a name ("PCA computed on 2,000 genes" stays).
 *
 * @param {string} text
 * @returns {string}
 */
export function lowerFirst(text) {
  if (text.length === 0) return text;
  const first = text.split(/\s/, 1)[0];
  if (first.length > 1 && first === first.toUpperCase() && first !== first.toLowerCase()) return text;
  return text[0].toLowerCase() + text.slice(1);
}
