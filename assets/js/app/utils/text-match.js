/**
 * @fileoverview Ranking a typed query's matches.
 *
 * A search box whose Enter takes the first match must list the match the
 * reader most likely meant first: the name itself, then names that start
 * with what was typed, then names that contain it anywhere. Within each
 * rank the list keeps its own order. Typing `TNF` finds `TNF` before
 * `TNFAIP3`, and both before `C1QTNF1`, wherever they are in the file.
 *
 * @module utils/text-match
 */

/**
 * The positions of `keys` that contain `query`, best match first: equal,
 * then starting with it, then containing it; each rank in list order.
 * `keys` and `query` are compared as given (callers lower-case both).
 *
 * @param {string[]} keys
 * @param {string} query - Non-empty.
 * @returns {number[]}
 */
export function rankedMatchIndices(keys, query) {
  const equal = [];
  const starts = [];
  const contains = [];
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const at = key.indexOf(query);
    if (at < 0) continue;
    if (at > 0) contains.push(index);
    else if (key.length === query.length) equal.push(index);
    else starts.push(index);
  }
  return equal.concat(starts, contains);
}
