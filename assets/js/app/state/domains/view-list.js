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

/** The `inEachView` visits under way (the page's one state). */
let visits = 0;

/**
 * Whether a restore is visiting views one by one now (`inEachView`). Until
 * it ends, the focused view is the visit's cursor, not the person's focus:
 * it may be a live view the person removed (hidden while kept views remain,
 * its own coloring and filters still restored), and an apply awaits field
 * reads, so a frame can come in between. What redraws the view list and the
 * sidebar from the focused view waits for the visit's end
 * (`ui-coordinator.js`, `view-controls.js`): a frame in a visit of a hidden
 * live view would throw "A hidden live view cannot be the active view".
 */
export function visitingViews() {
  return visits > 0;
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
  visits += 1;
  try {
    for (const index of order) {
      const viewId = ids[index];
      if (state.getActiveViewId() !== viewId) state.setActiveView(viewId);
      await apply(viewId, index);
    }
  } finally {
    try {
      if (state.getActiveViewId() !== focused) state.setActiveView(focused);
    } finally {
      visits -= 1;
    }
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

/**
 * The part of a per-view value (`{views: [...]}`) the view a step acted in
 * reads: its entry at the `focus` of `views` (the `views` value the step ran
 * with), or undefined when there is none. An owner's `readPart`
 * (`actions/domains.js`): staleness compares this part, so keeping another
 * view or changing another view's state never makes a step stale.
 *
 * @param {{views?: unknown[]}|null|undefined} value
 * @param {{focus?: number}|null|undefined} views
 * @returns {unknown}
 */
export function viewReadPart(value, views) {
  const focus = views?.focus;
  return Number.isInteger(focus) && Array.isArray(value?.views) ? value.views[focus] : undefined;
}
