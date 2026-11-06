/**
 * @fileoverview The `views` state domain: the kept views, how the views are
 * laid out, which one is focused, whether cameras are linked, and what each
 * view shows.
 *
 * Value:
 *
 *     {layout: 'single'|'grid',      // one view at a time, or every view
 *      focus: number,                // the focused view's position (0 = the live view)
 *      liveHidden: boolean,          // the live view is removed from the grid
 *      camerasLinked: boolean,       // views of one embedding share one camera
 *      views: [{                     // live first, then kept views (view-list.js)
 *        embedding: {key, columns}   // the obsm array and columns the view shows
 *                 | {layout} | null, // a layout with no obsm name; null: no dataset
 *        followsDefault: boolean,    // it moves with its dimension's default
 *        centroids: {points, labels} // centroid points and labels shown
 *      }, …]}
 *
 * A kept view is named by its position, never by the viewer's id
 * (`view-list.js`). What each view is coloured by, filters, colours, hidden
 * cells and camera are the per-view domains', restored after this one.
 *
 * Restore removes the kept views past the value's count (from the end) and
 * keeps new ones from the live view (as Keep view does,
 * `view-snapshot-publication.js`); the per-view domains then give each its
 * own state. It sets each view's representation (`setViewRepresentation`),
 * centroid toggles, the camera link, the layout and the focus. A kept view
 * needs the Points render mode: restoring kept views while Smoke is shown
 * switches the render mode to Points through its control first (the
 * `settings` domain, restored later, then holds the mode the value's state
 * had, which is Points whenever there are kept views). What is shown
 * afterwards is checked against the value: a part that did not come back is
 * named in the failure, so a jump never shows other views than it says.
 *
 * @module app/state/domains/views
 */

import { publishSnapshotView, retireSnapshotView } from '../../view-snapshot-publication.js';
import { layoutEmbeddingRef } from '../../../data/dataset-mapping.js';
import { LIVE_VIEW_ID, viewIdsOf } from './view-list.js';
import { viewNameInValue } from '../../actions/targets/views.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { sameValue } from './same-value.js';

function embeddingOf(state, viewId) {
  const dimensionManager = state.dimensionManager;
  if (dimensionManager === null || dimensionManager === undefined || !dimensionManager.viewLayouts?.has(viewId)) return null;
  const layoutKey = state.getViewLayoutKey(viewId);
  const layout = dimensionManager.getLayout(layoutKey);
  if (layout.provenance === null || layout.provenance?.columns == null) return { layout: layoutKey };
  return layoutEmbeddingRef(dimensionManager, layoutKey);
}

function layoutKeyOf(state, embedding) {
  return embedding.layout ?? state.dimensionManager.resolveRepresentation(embedding);
}

/** Switch the render mode to Points through its control, as choosing it does. */
function requirePointsRenderMode() {
  const select = document.getElementById('render-mode');
  if (!(select instanceof HTMLSelectElement) || select.value === 'points') return;
  select.value = 'points';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  if (select.value !== 'points') throw new Error('The Points render mode, which kept views need, could not be chosen.');
}

/** Keep one more view, from the live view as it stands. */
function keepViewFromLive(state, viewer) {
  const payload = state.getSnapshotPayload();
  return publishSnapshotView({
    state,
    viewer,
    config: {
      label: payload.label,
      fieldKey: payload.fieldKey,
      fieldKind: payload.fieldKind,
      colors: payload.colors,
      transparency: payload.transparency,
      centroidPositions: payload.centroidPositions,
      centroidColors: payload.centroidColors,
      dimensionLevel: payload.dimensionLevel,
      sourceViewId: LIVE_VIEW_ID,
      meta: { filtersText: [...payload.filtersText] },
      cameraState: viewer.getViewCameraState(LIVE_VIEW_ID),
    },
  });
}

/**
 * @param {{state: object, viewer: object, refreshUi: () => void}} options
 */
export function createViewsDomain({ state, viewer, refreshUi }) {
  function capture() {
    const ids = viewIdsOf(viewer);
    const layout = viewer.getViewLayout();
    return {
      layout: layout.mode,
      focus: Math.max(0, ids.indexOf(state.getActiveViewId())),
      liveHidden: layout.liveViewHidden === true,
      camerasLinked: viewer.getCamerasLocked() === true,
      views: ids.map(id => {
        const flags = viewer.getCentroidFlags(id);
        return {
          embedding: embeddingOf(state, id),
          followsDefault: state.viewContexts.has(id) ? state.viewFollowsDefault(id) : true,
          centroids: { points: flags?.points === true, labels: flags?.labels === true },
        };
      }),
    };
  }

  async function restore(value) {
    if (value === null || typeof value !== 'object' || !Array.isArray(value.views) || value.views.length === 0) {
      throw new TypeError('The views to restore must list the live view and each kept view.');
    }
    if (!Number.isSafeInteger(value.focus) || value.focus < 0 || value.focus >= value.views.length) {
      throw new RangeError(`The focused view to restore, ${value.focus}, is not among the ${formatCountOf(value.views.length, 'view')} it lists.`);
    }
    if (!['single', 'grid'].includes(value.layout) || typeof value.liveHidden !== 'boolean' || typeof value.camerasLinked !== 'boolean'
      || value.views.some(view => view === null || typeof view !== 'object' || typeof view.followsDefault !== 'boolean'
        || typeof view.centroids?.points !== 'boolean' || typeof view.centroids?.labels !== 'boolean')) {
      throw new TypeError('The views to restore must give the layout, the focus, the camera link and each view\'s embedding and centroids.');
    }
    const before = capture();
    if (JSON.stringify(before) === JSON.stringify(value)) return;
    let ids = viewIdsOf(viewer);
    const keptWanted = value.views.length - 1;
    if (keptWanted !== ids.length - 1) {
      // Views are added and removed with the live view shown and focused.
      viewer.setLiveViewHidden(false);
      if (state.getActiveViewId() !== LIVE_VIEW_ID) state.setActiveView(LIVE_VIEW_ID);
      for (let i = ids.length - 1; i > keptWanted; i--) retireSnapshotView({ state, viewer, snapshotId: ids[i] });
      if (ids.length - 1 < keptWanted) requirePointsRenderMode();
      for (let i = ids.length - 1; i < keptWanted; i++) keepViewFromLive(state, viewer);
      ids = viewIdsOf(viewer);
    }
    for (let i = 0; i < ids.length; i++) {
      const wanted = value.views[i];
      const id = ids[i];
      if (wanted.embedding !== null
        && (JSON.stringify(embeddingOf(state, id)) !== JSON.stringify(wanted.embedding) || state.viewFollowsDefault(id) !== wanted.followsDefault)) {
        await state.setViewRepresentation(id, layoutKeyOf(state, wanted.embedding), { followsDefault: wanted.followsDefault });
      }
      const flags = viewer.getCentroidFlags(id);
      if (flags.points !== wanted.centroids.points) viewer.setShowCentroidPoints(wanted.centroids.points, id);
      if (flags.labels !== wanted.centroids.labels) viewer.setShowCentroidLabels(wanted.centroids.labels, id);
    }
    if (viewer.getCamerasLocked() !== value.camerasLinked) viewer.setCamerasLocked(value.camerasLinked);
    const focusId = ids[value.focus];
    if (!value.liveHidden) viewer.setLiveViewHidden(false);
    if (state.getActiveViewId() !== focusId) state.setActiveView(focusId);
    const layoutSelect = document.getElementById('view-layout-mode');
    if (layoutSelect instanceof HTMLSelectElement) layoutSelect.value = value.layout;
    viewer.setViewLayout(value.layout, focusId);
    if (value.liveHidden) viewer.setLiveViewHidden(true);
    refreshUi();
    const shown = capture();
    if (!sameValue(shown, value)) {
      const missing = describeViews(shown, value);
      throw new Error(`The views could not be put back as they were. Not back: ${missing.length > 0 ? missing.join('; ') : 'the views'}.`);
    }
  }

  /** Lines for what differs from `a` to `b`, views named as the list numbers them at `b`. */
  function describeViews(a, b) {
    const lines = [];
    if (a.views.length !== b.views.length) {
      const kept = b.views.length - 1;
      lines.push(kept === 0 ? 'No kept views' : `${formatCountOf(kept, 'kept view')} (was ${a.views.length - 1})`);
    }
    if (a.layout !== b.layout) lines.push(b.layout === 'grid' ? 'Every view shown side by side' : 'One view at a time');
    if (a.focus !== b.focus) lines.push(`${viewNameInValue(b.focus, b.liveHidden)} focused`);
    if (a.liveHidden !== b.liveHidden) lines.push(b.liveHidden ? 'The live view removed (the kept views numbered from View 1)' : 'The live view shown again as View 1');
    if (a.camerasLinked !== b.camerasLinked) lines.push(b.camerasLinked ? 'Cameras linked' : 'Cameras unlinked');
    const shared = Math.min(a.views.length, b.views.length);
    for (let v = 0; v < shared; v++) {
      const x = a.views[v];
      const y = b.views[v];
      if (JSON.stringify(x.embedding) !== JSON.stringify(y.embedding) && y.embedding !== null) {
        const name = y.embedding.key === undefined ? y.embedding.layout : `${y.embedding.key} ${y.embedding.columns.length}D`;
        lines.push(`${viewNameInValue(v, b.liveHidden)} shows ${name}`);
      }
      if (x.centroids.points !== y.centroids.points) lines.push(`${viewNameInValue(v, b.liveHidden)}: centroids ${y.centroids.points ? 'shown' : 'hidden'}`);
      if (x.centroids.labels !== y.centroids.labels) lines.push(`${viewNameInValue(v, b.liveHidden)}: centroid labels ${y.centroids.labels ? 'shown' : 'hidden'}`);
      if (x.followsDefault !== y.followsDefault && y.embedding !== null) {
        lines.push(`${viewNameInValue(v, b.liveHidden)} ${y.followsDefault ? 'follows its dimension\'s default embedding' : 'keeps its own embedding'}`);
      }
    }
    return lines;
  }

  return {
    capture,
    restore,
    describe: describeViews,
  };
}
