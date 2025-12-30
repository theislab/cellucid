/**
 * @fileoverview Multiview (snapshot views) restoration helpers.
 *
 * Used by the session bundle eager restore path to rebuild snapshot view
 * structure by replaying filters/active-fields per view.
 *
 * @module state-serializer/multiview
 */

import { debug } from '../../utils/debug.js';

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

  // Restore camera lock state and per-view camera states *before* creating snapshots.
  // NOTE: viewer.setCamerasLocked(false) overwrites existing snapshot cameraState objects,
  // so this must happen before snapshot creation.
  if (typeof multiview.camerasLocked === 'boolean' && typeof viewer.setCamerasLocked === 'function') {
    viewer.setCamerasLocked(multiview.camerasLocked);
  }
  if (multiview.camerasLocked === false && multiview.liveCameraState && typeof viewer.setViewCameraState === 'function') {
    viewer.setViewCameraState('live', multiview.liveCameraState);
  }

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
        debug.log(`[SessionSerializer] Restored ${restored} filter${restored === 1 ? '' : 's'} for view ${snap.label || snap.id}`);
      }
    }
    if (snap.activeFields) {
      await restoreActiveFields(snap.activeFields);
    }

    pushViewerState();

    // Build snapshot payload from the current state, then apply descriptor overrides.
    const payload = state.getSnapshotPayload ? state.getSnapshotPayload() : {};
    const config = {
      ...payload,
      label: snap.label || payload.label,
      fieldKey: snap.fieldKey ?? payload.fieldKey,
      fieldKind: snap.fieldKind ?? payload.fieldKind,
      meta: snap.meta || payload.meta
    };
    if (typeof snap.outlierThreshold === 'number') config.outlierThreshold = snap.outlierThreshold;
    // Restore dimension level for this snapshot (don't assume 3D)
    if (snap.dimensionLevel != null) config.dimensionLevel = snap.dimensionLevel;
    // Restore per-view camera state when cameras are unlocked.
    if (snap.cameraState) config.cameraState = snap.cameraState;

    const created = viewer.createSnapshotView ? viewer.createSnapshotView(config) : null;
    const newId = created?.id;
    if (created?.id && state.createViewFromActive) {
      state.createViewFromActive(created.id);
    }
    if (newId) {
      idMap.set(String(snap.id), String(newId));
    }

    // Restore per-snapshot dimension positions/centroids in DataState + Viewer.
    // This is required so each view renders the correct embedding after session restore.
    if (newId && snap.dimensionLevel != null && typeof state.setDimensionLevel === 'function') {
      try {
        await state.setDimensionLevel(snap.dimensionLevel, { viewId: newId, updateViewer: true });
      } catch (err) {
        console.warn(`[SessionSerializer] Failed to restore dimension ${snap.dimensionLevel} for view ${newId}:`, err);
      }
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

  // When cameras are unlocked, `setViewLayout()` only applies a camera change if the
  // focused view id changes. If the active view is already focused (common after a
  // fresh clear), force-apply the active view camera to the global camera state.
  const camerasLocked = typeof viewer.getCamerasLocked === 'function' ? viewer.getCamerasLocked() : true;
  if (!camerasLocked && typeof viewer.getViewCameraState === 'function' && typeof viewer.setCameraState === 'function') {
    const cam = viewer.getViewCameraState(resolvedActiveId || 'live');
    if (cam) viewer.setCameraState(cam);
  }
}
