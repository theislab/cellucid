/**
 * @fileoverview The views a per-view domain value covers, and the one way a
 * per-view domain changes a view that is not focused.
 *
 * A per-view value (`active-field`, `filters`, `colors`, `visibility`,
 * `camera`) is `{views: [live, kept 1, kept 2, …]}`: the live view first,
 * then the kept views in the order the viewer lists them, by position. A
 * kept view's viewer id (`snap_<n>`) is not part of any value: the viewer
 * numbers views for the lifetime of the page, so a view the history puts
 * back is a new id at the same position, and a value keyed by id would
 * never match again. The `views` domain is restored before every per-view
 * domain (`app/actions/domains.js` order), so the views a value names exist,
 * in its order, when it is applied.
 *
 * A view that is not focused holds its field state in its view context;
 * DataState's top level is the focused view's (`view-context-core.js`). A
 * restore changes a view the way the app does: it focuses the view, changes
 * it through the state methods, and focuses the view it found focused again
 * (`overlay-internals.js` `_redrawViewsUsingUserDefinedField` does the
 * same).
 *
 * @module app/state/domains/view-list
 */

import { sameValue } from './same-value.js';
import { countNoun, formatCountOf } from '../../../utils/format-units.js';

export const LIVE_VIEW_ID = 'live';

/**
 * The viewer ids of every view, live first, then kept views in order.
 *
 * @param {object} viewer
 * @returns {string[]}
 */
export function viewIdsOf(viewer) {
  return [LIVE_VIEW_ID, ...viewer.getSnapshotViews().map(snapshot => snapshot.id)];
}

/**
 * The record that holds one view's field state now: the state itself for the
 * focused view, its view context for any other.
 *
 * @param {object} state
 * @param {string} viewId
 * @returns {{obsData: object|null, varData: object|null, activeFieldIndex: number,
 *   activeVarFieldIndex: number, activeFieldSource: 'obs'|'var'|null, cellVisibilityMask: Uint8Array}}
 */
export function viewOwner(state, viewId) {
  if (viewId === state.getActiveViewId()) return state;
  const context = state.viewContexts.get(viewId);
  if (context === undefined) throw new RangeError(`View "${viewId}" has no state context.`);
  return context;
}

/**
 * Check that a per-view value fits the views shown.
 *
 * @param {{views: unknown[]}} value
 * @param {string[]} ids
 * @param {string} what - The domain, as a person says it ("filters")
 */
export function requireViewsFit(value, ids, what) {
  if (value === null || typeof value !== 'object' || !Array.isArray(value.views)) {
    throw new TypeError(`The ${what} to restore must list each view's.`);
  }
  if (value.views.length !== ids.length) {
    throw new RangeError(
      `The ${what} to restore are for ${formatCountOf(value.views.length, 'view')}, `
      + `and ${ids.length} ${countNoun(ids.length, 'is', 'are')} shown.`
    );
  }
}

/**
 * Run `apply(viewId, index)` for each view `indices` names, each while that
 * view is focused, then focus the view that was focused before. The focus
 * is put back even when an apply fails.
 *
 * @param {object} state
 * @param {string[]} ids - Every view id (`viewIdsOf`)
 * @param {number[]} indices - The views to change
 * @param {(viewId: string, index: number) => (void|Promise<void>)} apply
 */
export async function inEachView(state, ids, indices, apply) {
  if (indices.length === 0) return;
  const focused = state.getActiveViewId();
  // The focused view last: it is the one left focused, so it is drawn once.
  const order = [...indices].sort((a, b) => (ids[a] === focused) - (ids[b] === focused) || a - b);
  try {
    for (const index of order) {
      const viewId = ids[index];
      if (state.getActiveViewId() !== viewId) state.setActiveView(viewId);
      await apply(viewId, index);
    }
  } finally {
    if (state.getActiveViewId() !== focused) state.setActiveView(focused);
  }
}

/**
 * The indices of the views whose part of two per-view values differs
 * (`sameValue`, or `same`).
 *
 * @param {unknown[]} current
 * @param {unknown[]} target
 * @param {(a: unknown, b: unknown) => boolean} [same]
 * @returns {number[]}
 */
export function differingViews(current, target, same = sameValue) {
  const out = [];
  for (let i = 0; i < target.length; i++) if (!same(current[i], target[i])) out.push(i);
  return out;
}
