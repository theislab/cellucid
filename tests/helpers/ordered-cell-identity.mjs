/**
 * The cell identity contract tests build: open cells never in their
 * original order, as a file stored in priority order (`prepare()`,
 * `cellucid_prepare()`, a served store) and every subsample open them. A
 * test that names cells through an identity in original order cannot tell a
 * consumer that reads `kept` alone from one that maps through the identity.
 *
 * The open order is the cells (every cell, or `kept`) taken from both ends
 * in turn: last, first, second last, second, ... — not ascending for any
 * two cells or more.
 */

import { createCellIdentity } from '../../assets/js/data/cell-identity.js';

/**
 * @param {{nObs: number, kept?: ArrayLike<number>|null}} options
 * @returns {import('../../assets/js/data/cell-identity.js').CellIdentity}
 */
export function orderedCellIdentity({ nObs, kept = null }) {
  const open = kept === null ? Uint32Array.from({ length: nObs }, (_, i) => i) : Uint32Array.from(kept);
  const openOrder = new Uint32Array(open.length);
  for (let i = 0, low = 0, high = open.length - 1; i < open.length; i++) {
    openOrder[i] = i % 2 === 0 ? open[high--] : open[low++];
  }
  return createCellIdentity({ nObs, kept: kept === null ? null : open, openOrder });
}
