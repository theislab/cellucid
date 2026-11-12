/**
 * @fileoverview The `visibility` state domain: the cells each view hides one
 * by one (the cell visibility mask, `setCellVisibility`), apart from what its
 * filters hide.
 *
 * Value: `{views: [Uint32Array, …]}` (live first, then kept views:
 * `view-list.js`), each the original positions (`cell-positions.js`) of the cells
 * that view hides by hand, ascending; empty when it hides none.
 *
 * The mask is written in place, so a capture is cached by the mask, its
 * write count (`per-cell-array-ownership.js`) and the open cells: an
 * unchanged mask costs nothing to capture again and gives the same array.
 *
 * Restore shows every cell of a view and hides the value's, through
 * `setCellVisibility`, view by view.
 *
 * @module app/state/domains/visibility
 */

import { openCellList, originalCellList } from './cell-positions.js';
import { differingViews, inEachView, requireViewsFit, viewIdsOf, viewOwner, viewReadPart } from './view-list.js';
import { viewNameInValue } from '../../actions/targets/views.js';
import { cellVisibilityMaskWrites, isAllShownCellVisibilityMask } from '../managers/per-cell-array-ownership.js';
import { formatCountOf } from '../../../utils/format-units.js';

const NONE = new Uint32Array(0);
/** mask → {writes, identity, cells}. */
const CAPTURED = new WeakMap();

/** The cells one view hides by hand, by original position. */
export function captureViewHidden(owner, identity) {
  const mask = owner.cellVisibilityMask;
  if (!(mask instanceof Uint8Array) || mask.length === 0 || isAllShownCellVisibilityMask(mask)) return NONE;
  const writes = cellVisibilityMaskWrites(mask);
  const cached = CAPTURED.get(mask);
  if (cached !== undefined && cached.writes === writes && cached.identity === identity) return cached.cells;
  let hidden = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 0) hidden++;
  let cells = NONE;
  if (hidden > 0) {
    const positions = new Uint32Array(hidden);
    let at = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] === 0) positions[at++] = i;
    cells = originalCellList(identity, positions);
  }
  CAPTURED.set(mask, { writes, identity, cells });
  return cells;
}

function sameCells(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * @param {{state: object, viewer: object, refreshUi: () => void}} options
 */
export function createVisibilityDomain({ state, viewer, refreshUi }) {
  return {
    // A step read the view it acted in: staleness compares that view's part alone (F156).
    readPart: viewReadPart,
    capture() {
      return { views: viewIdsOf(viewer).map(id => captureViewHidden(viewOwner(state, id), state.cellIdentity)) };
    },
    async restore(value) {
      const ids = viewIdsOf(viewer);
      requireViewsFit(value, ids, 'cells hidden by hand');
      const identity = state.cellIdentity;
      const current = ids.map(id => captureViewHidden(viewOwner(state, id), identity));
      const indices = differingViews(current, value.views, sameCells);
      await inEachView(state, ids, indices, (_viewId, index) => {
        const positions = openCellList(identity, value.views[index]);
        state.setCellVisibility(null, true);
        if (positions.length > 0) state.setCellVisibility(positions, false);
        state.updateFilterSummary();
      });
      if (indices.length > 0) refreshUi();
    },
    /** `context.liveHidden`: the live view is hidden at the later value (`views` domain), so the list numbers the kept views from 1; `context.viewLabels`: the views' names there (`viewLabelsInValue`). */
    describe(a, b, { liveHidden = false, viewLabels = null } = {}) {
      const lines = [];
      const count = Math.max(a.views.length, b.views.length);
      for (let v = 0; v < count; v++) {
        const before = a.views[v] ?? NONE;
        const after = b.views[v] ?? NONE;
        if (sameCells(before, after)) continue;
        const prefix = count > 1 ? `${viewNameInValue(v, liveHidden, viewLabels)}: ` : '';
        lines.push(after.length === 0
          ? `${prefix}every cell shown again`
          : `${prefix}${formatCountOf(after.length, 'cell')} hidden by hand (was ${before.length})`);
      }
      return lines;
    },
  };
}
