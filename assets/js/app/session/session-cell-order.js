/**
 * The order a session stores per-cell data in: the open cells by ascending
 * **original position** (`data/cell-identity.js`), whatever order the file
 * stores them in and the app opened them in.
 *
 * Everything that leaves the app names cells by original position. A
 * session's per-cell chunks — highlight memberships, user-defined codes and
 * values — and its cell-order digest (`session-context.js`) follow that rule:
 * cell `s` of a chunk is the open cell with the `s`-th smallest original
 * position. Every cell open: cell `s` is original position `s`. A subsample
 * (`cells` in the manifest, `cell-subset-record.js`): cell `s` is
 * `kept[s]`, the kept positions ascending. So a session saved on a file in
 * priority order (`data/anndata/priority-layout.js`), opened in any order, or
 * laid out again later, holds the same bytes, and Python and R apply it to an
 * object in its original order without knowing any layout.
 *
 * Inside the app, cells are in **open order** (`openOrder` of the identity:
 * the original position of each open cell; null when open order is already
 * ascending original order, and nothing is translated).
 *
 * @module session/session-cell-order
 */

/**
 * How open cells and session cells correspond, or null when they are the
 * same order: the identity's `ascendingOrder`, in a session's words.
 *
 * @param {import('../../data/cell-identity.js').CellIdentity|null|undefined} identity
 * @returns {{toSession: Uint32Array, toOpen: Uint32Array}|null} `toSession[i]`:
 *   the session position of open cell `i`; `toOpen[s]`: the open cell at
 *   session position `s`
 */
export function sessionCellOrder(identity) {
  const order = identity?.ascendingOrder ?? null;
  return order === null ? null : { toSession: order.toAscending, toOpen: order.toOpen };
}

/** A cell list mapped through `map` (`toSession` or `toOpen`), ascending. */
export function mapCells(cells, map) {
  if (map === null) return cells;
  const out = new Uint32Array(cells.length);
  for (let i = 0; i < cells.length; i++) out[i] = map[cells[i]];
  return out.sort();
}

/**
 * Per-cell values (one per cell, in the order `from` names) in the other
 * order: `out[map[i]] = values[i]`.
 *
 * @template {ArrayLike<number>} T
 * @param {T} values
 * @param {Uint32Array|null} map - `toSession` (open → session) or `toOpen` (session → open)
 * @returns {T}
 */
export function mapValues(values, map) {
  if (map === null) return values;
  const out = new values.constructor(values.length);
  for (let i = 0; i < values.length; i++) out[map[i]] = values[i];
  return out;
}
