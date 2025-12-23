/**
 * @fileoverview State serializer - save/load dynamic app state snapshots.
 *
 * This module coordinates snapshot creation/restoration by delegating to
 * focused submodules (UI controls, filters, highlights, multiview, IO).
 *
 * @module state-serializer/core
 */

import { getDataSourceManager } from '../../data/data-source-manager.js';
import { debug } from '../../utils/debug.js';
import { createUiControlSerializer } from './ui-controls.js';
import { createFilterSerializer } from './filters.js';
import { serializeHighlightPages, restoreHighlightPages } from './highlights.js';
import { serializeActiveFields, restoreActiveFields, syncFieldSelectsToActiveField } from './active-fields.js';
import { serializeMultiview, restoreMultiview } from './multiview.js';
import { createSerializerIO } from './io.js';

export function createStateSerializer({ state, viewer, sidebar }) {
  // v4: field operation registries (rename/delete/user-defined) + dev-phase strict versioning
  const VERSION = 4;
  const dataSourceManager = getDataSourceManager();

  const buildAnalyticsContext = () => ({
    datasetId: dataSourceManager.getCurrentDatasetId?.(),
    datasetName: dataSourceManager.getCurrentMetadata?.()?.name,
    sourceType: dataSourceManager.getCurrentSourceType?.()
  });

  const ui = createUiControlSerializer({ sidebar });
  const filters = createFilterSerializer({ state });

  function serialize() {
    const activePageId = state.getActivePageId ? state.getActivePageId() : state.activePageId;
    const activePageName = state.getActivePage ? state.getActivePage()?.name : null;

    const dataSource = dataSourceManager?.getStateSnapshot?.() || null;

    return {
      version: VERSION,
      timestamp: new Date().toISOString(),
      dataSource,
      camera: viewer.getCameraState?.() || null,
      // Capture active dimension level for proper restoration (don't assume 3D)
      activeDimensionLevel: state.activeDimensionLevel ?? null,
      // Field operation registries
      renames: state.getRenameRegistry?.()?.toJSON?.() || null,
      deletedFields: state.getDeleteRegistry?.()?.toJSON?.() || [],
      userDefinedFields: state.getUserDefinedFieldsRegistry?.()?.toJSON?.() || [],
      uiControls: ui.collectUIControls(),
      highlightPages: serializeHighlightPages(state),
      activePageId,
      activePageName,
      filters: filters.serializeFilters(),
      activeFields: serializeActiveFields(state),
      multiview: serializeMultiview({ state, viewer, serializeFiltersForFields: filters.serializeFiltersForFields })
    };
  }

  /**
   * Validate that a parsed JSON object looks like a real state snapshot.
   * Helps avoid silently "loading" unrelated files (e.g., the manifest itself).
   */
  function validateSnapshotShape(snapshot, label = 'state file') {
    const isObject = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot);
    if (!isObject) {
      throw new Error(`Invalid ${label}: expected a state JSON object.`);
    }
    const hasStateFields = snapshot.version != null
      || snapshot.camera
      || snapshot.filters
      || snapshot.activeFields
      || snapshot.uiControls
      || snapshot.multiview;
    if (!hasStateFields) {
      const keys = Object.keys(snapshot || {}).slice(0, 5).join(', ') || 'none';
      throw new Error(`File ${label} does not look like a cellucid state (found keys: ${keys}).`);
    }
  }

  function pushViewerState() {
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
   * Restore state from a snapshot.
   * Comprehensive restoration of all application state.
   */
  async function deserialize(snapshot, options = {}) {
    if (!snapshot) return;

    debug.log('[StateSerializer] Restoring state from snapshot:', snapshot.timestamp);

    // Development phase: strict snapshot format (no migrations).
    if (snapshot.version !== VERSION) {
      throw new Error(`Unsupported state snapshot version: ${snapshot.version ?? 'missing'} (expected ${VERSION})`);
    }

    // Check data source compatibility
    if (snapshot.dataSource) {
      const currentSource = dataSourceManager?.getStateSnapshot?.();

      if (currentSource?.sourceType !== snapshot.dataSource.sourceType ||
          currentSource?.datasetId !== snapshot.dataSource.datasetId) {
        console.warn(
          `[StateSerializer] State was saved with dataset '${snapshot.dataSource.datasetId}' ` +
          `(${snapshot.dataSource.sourceType}) but current dataset is '${currentSource?.datasetId}' ` +
          `(${currentSource?.sourceType}). Some state may not restore correctly.`
        );

        if (snapshot.dataSource.userPath) {
          debug.log(`[StateSerializer] Original user data path: ${snapshot.dataSource.userPath}`);
        }
      }
    }

    // 0. Restore field operation registries FIRST, then apply overlays to metadata.
    const renameRegistry = state.getRenameRegistry?.();
    const deleteRegistry = state.getDeleteRegistry?.();
    const userDefinedRegistry = state.getUserDefinedFieldsRegistry?.();

    renameRegistry?.clear?.();
    deleteRegistry?.clear?.();
    userDefinedRegistry?.clear?.();

    if (snapshot.renames) {
      renameRegistry?.fromJSON?.(snapshot.renames);
    }
    if (snapshot.deletedFields) {
      deleteRegistry?.fromJSON?.(snapshot.deletedFields);
    }

    state.applyFieldOverlays?.();

    if (snapshot.userDefinedFields) {
      userDefinedRegistry?.fromJSON?.(snapshot.userDefinedFields, state);
      state.applyFieldOverlays?.();
    }

    const controls = snapshot.uiControls || {};

    // 1. Restore UI controls first (checkboxes, selects, ranges)
    debug.log('[StateSerializer] Restoring UI controls (count: ' + Object.keys(controls).length + ')');
    ui.restoreUIControls(controls);

    // 1b. Restore dimension level if saved (don't assume 3D)
    if (snapshot.activeDimensionLevel != null && state.setDimensionLevel) {
      debug.log('[StateSerializer] Restoring dimension level:', snapshot.activeDimensionLevel);
      await state.setDimensionLevel(snapshot.activeDimensionLevel);
      const dimensionSelect = document.getElementById('dimension-select');
      if (dimensionSelect) {
        dimensionSelect.value = String(snapshot.activeDimensionLevel);
      }
    }

    // 2. Restore filters (field-level filter settings)
    if (snapshot.filters) {
      const { restored, skippedNoop } = await filters.restoreFilters(snapshot.filters);
      if (restored > 0) {
        debug.log(`[StateSerializer] Restored filters (${restored} field${restored === 1 ? '' : 's'}${skippedNoop ? `, skipped ${skippedNoop} no-op` : ''})`);
      } else if (skippedNoop > 0) {
        debug.log(`[StateSerializer] No filter changes to restore (skipped ${skippedNoop} no-op entries)`);
      }
    }

    // 3. Restore active fields and update field selects
    if (snapshot.activeFields) {
      debug.log('[StateSerializer] Restoring active fields:', snapshot.activeFields);
      await restoreActiveFields(state, snapshot.activeFields);
    }

    // 3b. Sync outlier filter slider to active field's threshold (AFTER active field is set)
    const activeField = state.getActiveField?.();
    if (activeField && activeField.outlierQuantiles?.length > 0) {
      const outlierSlider = document.getElementById('outlier-filter');
      const outlierDisplay = document.getElementById('outlier-filter-display');
      if (outlierSlider) {
        const pct = Math.round((activeField._outlierThreshold ?? 1.0) * 100);
        outlierSlider.value = String(pct);
        if (outlierDisplay) {
          outlierDisplay.textContent = pct + '%';
        }
      }
    }

    // 3c. Sync field select dropdowns to match active field
    syncFieldSelectsToActiveField(state);

    // 4. Restore highlight pages (AFTER fields so cellIndices make sense)
    if (snapshot.highlightPages && snapshot.highlightPages.length > 0) {
      debug.log('[StateSerializer] Restoring highlight pages (count: ' + snapshot.highlightPages.length + ')');
      restoreHighlightPages(state, snapshot.highlightPages, { id: snapshot.activePageId, name: snapshot.activePageName });
    }

    // 5. Restore multiview snapshots/layout
    if (snapshot.multiview) {
      debug.log('[StateSerializer] Restoring multiview snapshots/layout');
      const restoreActiveFieldsForMultiview = (activeFields) => restoreActiveFields(state, activeFields);
      await restoreMultiview(
        {
          state,
          viewer,
          restoreFilters: filters.restoreFilters,
          restoreActiveFields: restoreActiveFieldsForMultiview,
          pushViewerState
        },
        snapshot.multiview
      );
    }

    // 6. Restore camera state LAST
    if (snapshot.camera) {
      debug.log('[StateSerializer] Restoring camera:', snapshot.camera);
      viewer.setCameraState?.(snapshot.camera);

      // Update the navigation mode UI to match (without triggering event that would reset camera)
      const navSelect = document.getElementById('navigation-mode');
      if (navSelect && snapshot.camera.navigationMode) {
        navSelect.value = snapshot.camera.navigationMode;
        const freeflyControls = document.getElementById('freefly-controls');
        const orbitControls = document.getElementById('orbit-controls');
        const planarControls = document.getElementById('planar-controls');
        if (freeflyControls && orbitControls && planarControls) {
          const mode = snapshot.camera.navigationMode;
          freeflyControls.style.display = mode === 'free' ? 'block' : 'none';
          orbitControls.style.display = mode === 'orbit' ? 'block' : 'none';
          planarControls.style.display = mode === 'planar' ? 'block' : 'none';
        }
      }
    }

    // Final: ensure state + viewer are in sync even if no active field
    pushViewerState();

    debug.log('[StateSerializer] Triggering state updates');

    if (state._notifyVisibilityChange) {
      state._notifyVisibilityChange();
    }
    if (state.updateFilteredCount) {
      state.updateFilteredCount();
    }
    if (state.updateFilterSummary) {
      state.updateFilterSummary();
    }
    if (state._notifyHighlightPageChange) {
      state._notifyHighlightPageChange();
    }
    if (state._notifyHighlightChange) {
      state._notifyHighlightChange();
    }
    if (state._pushColorsToViewer) {
      state._pushColorsToViewer();
    }

    debug.log('[StateSerializer] Restore complete');
  }

  const io = createSerializerIO({
    serialize,
    deserialize,
    validateSnapshotShape,
    buildAnalyticsContext
  });

  return {
    serialize,
    deserialize,
    ...io,
    collectUIControls: ui.collectUIControls,
    restoreUIControls: ui.restoreUIControls
  };
}
