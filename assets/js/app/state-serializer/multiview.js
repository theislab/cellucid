/**
 * @fileoverview Multiview (snapshot) serialization helpers.
 *
 * @module state-serializer/multiview
 */

import { debug } from '../../utils/debug.js';

export function serializeMultiview({ state, viewer, serializeFiltersForFields }) {
  const viewLayout = viewer.getViewLayout?.() || { mode: 'single', activeId: 'live' };
  const snapshots = viewer.getSnapshotViews?.() || [];
  const viewContexts = state.viewContexts instanceof Map ? state.viewContexts : null;

  const serializedSnapshots = snapshots.map((s) => {
    const ctx = viewContexts?.get?.(String(s.id)) || null;
    const activeFieldKey =
      ctx?.activeFieldIndex >= 0 ? ctx?.obsData?.fields?.[ctx.activeFieldIndex]?.key : null;
    const activeVarFieldKey =
      ctx?.activeVarFieldIndex >= 0 ? ctx?.varData?.fields?.[ctx.activeVarFieldIndex]?.key : null;
    const activeFieldSource = ctx?.activeFieldSource || (activeVarFieldKey ? 'var' : activeFieldKey ? 'obs' : null);

    const ctxFilters = ctx
      ? {
          ...serializeFiltersForFields(ctx?.obsData?.fields, 'obs'),
          ...serializeFiltersForFields(ctx?.varData?.fields, 'var')
        }
      : null;

    let ctxOutlierThreshold = null;
    if (activeFieldSource === 'var' && ctx?.varData?.fields?.[ctx.activeVarFieldIndex]) {
      ctxOutlierThreshold = ctx.varData.fields[ctx.activeVarFieldIndex]._outlierThreshold ?? null;
    } else if (activeFieldSource === 'obs' && ctx?.obsData?.fields?.[ctx.activeFieldIndex]) {
      ctxOutlierThreshold = ctx.obsData.fields[ctx.activeFieldIndex]._outlierThreshold ?? null;
    }

    return {
      id: s.id,
      label: s.label,
      fieldKey: s.fieldKey,
      fieldKind: s.fieldKind,
      meta: s.meta,
      // Capture dimension level for proper restoration (don't assume 3D)
      dimensionLevel: s.dimensionLevel ?? ctx?.dimensionLevel ?? null,
      activeFields: {
        activeFieldKey,
        activeVarFieldKey,
        activeFieldSource
      },
      filters: ctxFilters,
      colors: ctx?.colorsArray ? Array.from(ctx.colorsArray) : null,
      transparency: ctx?.categoryTransparency ? Array.from(ctx.categoryTransparency) : null,
      outlierQuantiles: ctx?.outlierQuantilesArray ? Array.from(ctx.outlierQuantilesArray) : null,
      centroidPositions: ctx?.centroidPositions ? Array.from(ctx.centroidPositions) : null,
      centroidColors: ctx?.centroidColors ? Array.from(ctx.centroidColors) : null,
      centroidOutliers: ctx?.centroidOutliers ? Array.from(ctx.centroidOutliers) : null,
      outlierThreshold: ctxOutlierThreshold
    };
  });

  return {
    layout: viewLayout,
    snapshots: serializedSnapshots
  };
}

/**
 * Restore multiview snapshots and layout.
 * Replays each saved snapshot by reapplying its filters/active fields and freezing a view.
 */
export async function restoreMultiview({
  state,
  viewer,
  restoreFilters,
  restoreActiveFields,
  pushViewerState
}, multiview) {
  if (!multiview) return;

  // Start clean
  if (viewer.clearSnapshotViews) viewer.clearSnapshotViews();
  if (state.clearSnapshotViews) state.clearSnapshotViews();

  // Ensure current live state is fully synced before cloning it
  pushViewerState();

  const baseContext = state.captureCurrentContext ? state.captureCurrentContext() : null;
  const idMap = new Map();
  const snapshots = multiview.snapshots || [];

  for (const snap of snapshots) {
    // Reset to the base live state before applying this snapshot
    if (baseContext && state.restoreContext) {
      state.restoreContext(baseContext);
    }

    if (snap.filters) {
      const { restored } = await restoreFilters(snap.filters);
      if (restored > 0) {
        debug.log(`[StateSerializer] Restored ${restored} filter${restored === 1 ? '' : 's'} for snapshot ${snap.label || snap.id}`);
      }
    }
    if (snap.activeFields) {
      await restoreActiveFields(snap.activeFields);
    }

    pushViewerState();

    // Build snapshot payload (allow overriding with saved arrays for exact match)
    const payload = state.getSnapshotPayload ? state.getSnapshotPayload() : {};
    const config = {
      ...payload,
      label: snap.label || payload.label,
      fieldKey: snap.fieldKey ?? payload.fieldKey,
      fieldKind: snap.fieldKind ?? payload.fieldKind,
      meta: snap.meta || payload.meta
    };
    if (snap.colors) config.colors = new Uint8Array(snap.colors);
    if (snap.transparency) config.transparency = new Float32Array(snap.transparency);
    if (snap.outlierQuantiles) config.outlierQuantiles = new Float32Array(snap.outlierQuantiles);
    if (snap.centroidPositions) config.centroidPositions = new Float32Array(snap.centroidPositions);
    if (snap.centroidColors) config.centroidColors = new Uint8Array(snap.centroidColors);
    if (snap.centroidOutliers) config.centroidOutliers = new Float32Array(snap.centroidOutliers);
    if (typeof snap.outlierThreshold === 'number') config.outlierThreshold = snap.outlierThreshold;
    // Restore dimension level for this snapshot (don't assume 3D)
    if (snap.dimensionLevel != null) config.dimensionLevel = snap.dimensionLevel;

    const created = viewer.createSnapshotView ? viewer.createSnapshotView(config) : null;
    const newId = created?.id;
    if (created?.id && state.createViewFromActive) {
      state.createViewFromActive(created.id);
    }
    if (newId) {
      idMap.set(String(snap.id), String(newId));
    }
  }

  // Restore the original live state
  if (baseContext && state.restoreContext) {
    state.restoreContext(baseContext);
  }

  // Apply layout and active view
  const layout = multiview.layout || { mode: 'single', activeId: 'live' };
  const resolvedActiveId = layout.activeId && idMap.has(String(layout.activeId))
    ? idMap.get(String(layout.activeId))
    : layout.activeId;

  // Restore liveViewHidden state
  if (typeof viewer.setLiveViewHidden === 'function') {
    viewer.setLiveViewHidden(Boolean(layout.liveViewHidden));
  }

  if (viewer.setViewLayout) {
    viewer.setViewLayout(layout.mode, resolvedActiveId);
  }
  if (resolvedActiveId) {
    state.setActiveView?.(resolvedActiveId);
  }
}
