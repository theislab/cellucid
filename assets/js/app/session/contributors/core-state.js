/**
 * @fileoverview Session contributor: core state (camera/filters/active field/UI controls/multiview).
 *
 * EAGER chunk (dataset-dependent): enough for "first pixels + UI-ready".
 *
 * Restore order (per session-serializer-plan.md):
 *  1) restore UI controls
 *  2) restore live-view dimension level
 *  3) restore filters
 *  4) restore active fields
 *  5) restore multiview descriptors (incl. per-view camera/dimension)
 *  6) restore camera (locked-cam mode only)
 *  7) push state → viewer sync
 *
 * @module session/contributors/core-state
 */

import { createUiControlSerializer } from '../../state-serializer/ui-controls.js';
import { createFilterSerializer } from '../../state-serializer/filters.js';
import { serializeActiveFields, restoreActiveFields, syncFieldSelectsToActiveField } from '../../state-serializer/active-fields.js';
import { restoreMultiview } from '../../state-serializer/multiview.js';

export const id = 'core-state';

/**
 * @param {AbortSignal | null | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

/**
 * Session-bundle multiview descriptor serialization.
 *
 * This intentionally omits heavy per-cell arrays (colors/transparency/etc)
 * so the eager stage stays small; multiview restore replays filters/fields.
 *
 * @param {object} options
 * @param {object} options.state
 * @param {object} options.viewer
 * @param {(fields: any[], source: string) => any} options.serializeFiltersForFields
 * @returns {any}
 */
function serializeMultiviewDescriptors({ state, viewer, serializeFiltersForFields, camerasLocked }) {
  const viewLayout = viewer.getViewLayout?.() || { mode: 'single', activeId: 'live' };
  const snapshots = viewer.getSnapshotViews?.() || [];
  const viewContexts = state.viewContexts instanceof Map ? state.viewContexts : null;

  const liveCameraState = viewer.getViewCameraState?.('live') || null;

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
      dimensionLevel: s.dimensionLevel ?? ctx?.dimensionLevel ?? null,
      cameraState: viewer.getViewCameraState?.(String(s.id)) || null,
      activeFields: {
        activeFieldKey,
        activeVarFieldKey,
        activeFieldSource
      },
      filters: ctxFilters,
      outlierThreshold: ctxOutlierThreshold
    };
  });

  return {
    layout: viewLayout,
    camerasLocked: camerasLocked === true,
    liveCameraState,
    snapshots: serializedSnapshots
  };
}

/**
 * Push state buffers to the viewer (keeps restore fast without reloading data).
 * @param {object} state
 */
function pushViewerState(state) {
  // These methods are intentionally "private-ish" on DataState but are the
  // canonical way to sync the viewer without reloading data.
  if (state.updateOutlierQuantiles) state.updateOutlierQuantiles();
  if (state.computeGlobalVisibility) state.computeGlobalVisibility();
  if (state._pushColorsToViewer) state._pushColorsToViewer();
  if (state._pushTransparencyToViewer) state._pushTransparencyToViewer();
  if (state._pushOutliersToViewer) state._pushOutliersToViewer();
  if (state._pushCentroidsToViewer) state._pushCentroidsToViewer();
  if (state._pushOutlierThresholdToViewer && state.getCurrentOutlierThreshold) {
    state._pushOutlierThresholdToViewer(state.getCurrentOutlierThreshold());
  }
}

/**
 * Capture minimal core state for "first pixels + UI-ready".
 * @param {object} ctx
 * @returns {import('../session-serializer.js').SessionChunk[]}
 */
export function capture(ctx) {
  const state = ctx?.state;
  const viewer = ctx?.viewer;
  const sidebar = ctx?.sidebar;
  if (!state || !viewer) return [];

  const ui = createUiControlSerializer({ sidebar });
  const filters = createFilterSerializer({ state });
  const camerasLocked = viewer.getCamerasLocked?.() ?? true;
  const liveDimensionLevel = state.getViewDimensionLevel?.('live') ?? state.activeDimensionLevel ?? null;

  return [
    {
      id: 'core/state',
      contributorId: id,
      priority: 'eager',
      kind: 'json',
      codec: 'gzip',
      label: 'Core state',
      datasetDependent: true,
      payload: {
        camera: viewer.getCameraState?.() || null,
        camerasLocked: camerasLocked === true,
        activeDimensionLevel: state.activeDimensionLevel ?? null,
        liveDimensionLevel,
        uiControls: ui.collectUIControls(),
        filters: filters.serializeFilters(),
        activeFields: serializeActiveFields(state),
        multiview: serializeMultiviewDescriptors({
          state,
          viewer,
          camerasLocked,
          serializeFiltersForFields: filters.serializeFiltersForFields
        })
      }
    }
  ];
}

/**
 * Restore minimal core state for "first pixels + UI-ready".
 * @param {object} ctx
 * @param {any} _chunkMeta
 * @param {any} payload
 */
export async function restore(ctx, _chunkMeta, payload) {
  const state = ctx?.state;
  const viewer = ctx?.viewer;
  const sidebar = ctx?.sidebar;
  if (!state || !viewer || !payload) return;

  const ui = createUiControlSerializer({ sidebar });
  const filters = createFilterSerializer({ state });
  const signal = ctx.abortSignal ?? null;

  // 1) Restore UI controls first (checkboxes, selects, ranges)
  ui.restoreUIControls(payload.uiControls || {}, { abortSignal: signal });
  throwIfAborted(signal);

  // 2) Restore dimension level (don’t assume 3D)
  if (payload.liveDimensionLevel != null && state.setDimensionLevel) {
    await state.setDimensionLevel(payload.liveDimensionLevel);
    const dimensionSelect = document.getElementById('dimension-select');
    if (dimensionSelect) {
      dimensionSelect.value = String(payload.liveDimensionLevel);
    }
  }
  throwIfAborted(signal);

  // 3) Restore filters (modified-only)
  if (payload.filters) {
    await filters.restoreFilters(payload.filters);
  }
  throwIfAborted(signal);

  // 4) Restore active fields and sync UI selectors
  if (payload.activeFields) {
    await restoreActiveFields(state, payload.activeFields);
  }

  // Sync outlier slider (AFTER active field is set)
  const activeField = state.getActiveField?.();
  if (activeField && activeField.outlierQuantiles?.length > 0) {
    const outlierSlider = document.getElementById('outlier-filter');
    const outlierDisplay = document.getElementById('outlier-filter-display');
    if (outlierSlider) {
      const pct = Math.round((activeField._outlierThreshold ?? 1.0) * 100);
      outlierSlider.value = String(pct);
      if (outlierDisplay) outlierDisplay.textContent = pct + '%';
    }
  }

  // Sync dropdowns to match active field without triggering a camera reset.
  syncFieldSelectsToActiveField(state);
  throwIfAborted(signal);

  // 5) Restore multiview descriptors/layout (replay logic; no heavy arrays).
  if (payload.multiview) {
    const restoreActiveFieldsForMultiview = (af) => restoreActiveFields(state, af);
    await restoreMultiview(
      {
        state,
        viewer,
        restoreFilters: filters.restoreFilters,
        restoreActiveFields: restoreActiveFieldsForMultiview,
        pushViewerState: () => pushViewerState(state)
      },
      payload.multiview
    );
  }
  throwIfAborted(signal);

  // 6) Restore camera state LAST (locked-cam only; unlocked mode uses per-view camera states)
  const camerasLocked = payload.multiview?.camerasLocked ?? payload.camerasLocked ?? true;
  if (camerasLocked === true && payload.camera) {
    viewer.setCameraState?.(payload.camera);

    // Update the navigation mode UI to match (without triggering an event reset).
    const navSelect = document.getElementById('navigation-mode');
    if (navSelect && payload.camera.navigationMode) {
      navSelect.value = payload.camera.navigationMode;
      const freeflyControls = document.getElementById('freefly-controls');
      const orbitControls = document.getElementById('orbit-controls');
      const planarControls = document.getElementById('planar-controls');
      if (freeflyControls && orbitControls && planarControls) {
        const mode = payload.camera.navigationMode;
        freeflyControls.style.display = mode === 'free' ? 'block' : 'none';
        orbitControls.style.display = mode === 'orbit' ? 'block' : 'none';
        planarControls.style.display = mode === 'planar' ? 'block' : 'none';
      }
    }
  }

  // Final: ensure state + viewer are in sync even if no active field.
  pushViewerState(state);

  // Trigger lightweight UI/state updates.
  if (state._notifyVisibilityChange) state._notifyVisibilityChange();
  if (state.updateFilteredCount) state.updateFilteredCount();
  if (state.updateFilterSummary) state.updateFilterSummary();
}
