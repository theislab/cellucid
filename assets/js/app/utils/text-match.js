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
 * `aliases`, when given, is a second name per position (a gene's identifier
 * beside its symbol): a position ranks by the better of its two matches.
 *
 * @param {string[]} keys
 * @param {string} query - Non-empty.
 * @param {ReadonlyArray<string>|null} [aliases]
 * @returns {number[]}
 */
export function rankedMatchIndices(keys, query, aliases = null) {
  const equal = [];
  const starts = [];
  const contains = [];
  const rankOf = key => {
    const at = key.indexOf(query);
    if (at < 0) return 3;
    if (at > 0) return 2;
    return key.length === query.length ? 0 : 1;
  };
  for (let index = 0; index < keys.length; index++) {
    let rank = rankOf(keys[index]);
    if (aliases !== null && rank > 0 && aliases[index]) rank = Math.min(rank, rankOf(aliases[index]));
    if (rank === 0) equal.push(index);
    else if (rank === 1) starts.push(index);
    else if (rank === 2) contains.push(index);
  }
  return equal.concat(starts, contains);
}
