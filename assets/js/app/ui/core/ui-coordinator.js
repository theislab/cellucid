/**
 * @fileoverview UI coordinator (thin orchestrator).
 *
 * Initializes DOM cache + UI modules, wires cross-module callbacks, and exposes
 * a small public API consumed by `main.js`.
 *
 * The goal is to keep module boundaries crisp while preserving existing
 * performance characteristics (no extra rendering work on large datasets).
 *
 * @module ui/core/ui-coordinator
 */

import { collectDOMReferences } from './dom-cache.js';
import { initSidebarControls } from '../modules/sidebar-controls.js';
import { initStatsDisplay } from '../modules/stats-display.js';
import { initRenderControls } from '../modules/render-controls.js';
import { initVelocityOverlayControls } from '../modules/velocity-overlay-controls.js';
import { initCameraControls } from '../modules/camera-controls.js';
import { initLegendRenderer } from '../modules/legend-renderer.js';
import { initFilterControls } from '../modules/filter-controls.js';
import { initHighlightControls } from '../modules/highlight-controls.js';
import { initFieldSelector } from '../modules/field-selector.js';
import { initViewControls } from '../modules/view-controls.js';
import { initDimensionControls } from '../modules/dimension-controls.js';
import { initDatasetControls } from '../modules/dataset-controls.js';
import { initSessionControls } from '../modules/session-controls.js';
import { initCommunityAnnotationControls } from '../modules/community-annotation-controls.js';
import { initVisualizationReset } from '../modules/visualization-reset.js';
import { initFigureExport } from '../modules/figure-export/index.js';
import { initCinematicCamera } from '../modules/cinematic-camera/index.js';
import { initInfoPopovers } from '../components/info-popovers.js';
import {
  clearPublishedSnapshotViews,
  publishSnapshotView,
  retireSnapshotView,
} from '../../view-snapshot-publication.js';
import { debug } from '../../../utils/debug.js';

/**
 * Build one terminal cleanup owner whose Promise identity is stable even when
 * a child cleanup synchronously re-enters the returned destroy function.
 *
 * @param {object} options
 * @param {() => void} options.closeAdmission
 * @param {() => Array<() => unknown>} options.getOperations
 * @param {string} options.failureMessage
 * @returns {() => Promise<void>}
 */
export function createStableTerminalDestroy({
  closeAdmission,
  getOperations,
  failureMessage,
}) {
  if (typeof closeAdmission !== 'function') {
    throw new TypeError(
      'Terminal cleanup requires a synchronous admission closer.'
    );
  }
  if (typeof getOperations !== 'function') {
    throw new TypeError(
      'Terminal cleanup requires an operation-list owner.'
    );
  }
  if (typeof failureMessage !== 'string' || failureMessage.length === 0) {
    throw new TypeError(
      'Terminal cleanup requires a non-empty aggregate failure message.'
    );
  }

  let terminalPromise = null;
  return function destroy() {
    if (terminalPromise !== null) return terminalPromise;

    let resolveTerminal;
    let rejectTerminal;
    terminalPromise = new Promise((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });

    const failures = [];
    const pending = [];
    const cleanup = operation => {
      try {
        const result = operation();
        if (result !== null && typeof result?.then === 'function') {
          pending.push(result);
        }
      } catch (error) {
        failures.push(error);
      }
    };

    cleanup(closeAdmission);
    let operations = [];
    try {
      operations = getOperations();
      if (
        !Array.isArray(operations)
        || operations.some(operation => typeof operation !== 'function')
      ) {
        throw new TypeError(
          'Terminal cleanup operations must be an array of functions.'
        );
      }
    } catch (error) {
      failures.push(error);
      operations = [];
    }
    for (const operation of operations) cleanup(operation);

    void Promise.allSettled(pending).then(outcomes => {
      try {
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') failures.push(outcome.reason);
        }
        const exactFailures = [...new Set(failures)];
        if (exactFailures.length === 1) {
          rejectTerminal(exactFailures[0]);
          return;
        }
        if (exactFailures.length > 1) {
          rejectTerminal(new AggregateError(
            exactFailures,
            failureMessage
          ));
          return;
        }
        resolveTerminal();
      } catch (error) {
        rejectTerminal(error);
      }
    });
    return terminalPromise;
  };
}

/**
 * Initialize the full app UI.
 *
 * @param {object} options
 * @param {import('../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {{ rebuildSmokeDensity?: (gridSize?: number) => void } | null} [options.smoke]
 * @param {import('../../../data/data-source-manager.js').DataSourceManager | null} [options.dataSourceManager]
 * @param {() => Promise<boolean>} options.clearActiveDataset
 * @param {(selection: Object) => Promise<boolean>} options.reloadActiveDataset
 * @param {object|null} [options.sessionSerializer]
 * @param {any|null} [options.jupyterSource]
 */
export function initUI({
  state,
  viewer,
  smoke = null,
  dataSourceManager = null,
  clearActiveDataset,
  reloadActiveDataset = null,
  sessionSerializer = null,
  jupyterSource = null
}) {
  debug.log('[UI] initUI');

  const dom = collectDOMReferences(document);
  const infoPopovers = initInfoPopovers({ root: document });
  let viewControls = null;
  let cinematicCamera = null;
  let destroyed = false;

  const sidebarControls = initSidebarControls({
    dom: dom.sidebar,
    onViewportOcclusionChange: viewer.setViewportLeftOcclusionRatio,
  });

  const statsDisplay = initStatsDisplay({ dom: dom.stats });
  const renderControls = initRenderControls({
    viewer,
    dom: dom.render,
    smoke
  });
  const velocityOverlayControls = initVelocityOverlayControls({
    state,
    viewer,
    dom: dom.render
  });
  const cameraControls = initCameraControls({
    viewer,
    dom: dom.camera,
    callbacks: {
      onViewBadgesMaybeChanged: () => viewControls?.renderSplitViewBadges?.()
    }
  });

  const legend = initLegendRenderer({ state, viewer, dom: dom.display, dataSourceManager });
  const filterControls = initFilterControls({
    state,
    viewer,
    dom: dom.filter,
    callbacks: {
      onViewBadgesMaybeChanged: () => viewControls?.renderSplitViewBadges?.()
    }
  });
  const highlightControls = initHighlightControls({ state, viewer, dom: dom.highlight, jupyterSource });
  const communityAnnotationControls = initCommunityAnnotationControls({
    state,
    dom: dom.communityAnnotation,
    dataSourceManager,
    infoPopovers
  });

  const dimensionControls = initDimensionControls({
    state,
    dom: dom.dimension,
    callbacks: {
      onViewBadgesMaybeChanged: () => viewControls?.renderSplitViewBadges?.()
    }
  });

  const scheduleFrame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 0);
  const cancelFrame = typeof cancelAnimationFrame === 'function'
    ? cancelAnimationFrame
    : clearTimeout;
  let visibilityUiFrame = null;

  function scheduleVisibilityUiUpdate() {
    if (destroyed || visibilityUiFrame !== null) return;
    visibilityUiFrame = scheduleFrame(() => {
      visibilityUiFrame = null;
      if (destroyed) return;
      // Field activation publishes visibility before the selector can commit
      // the replacement legend. Refreshing counts in the same frame keeps the
      // DOM and active model in one completed UI generation.
      legend.refreshCategoryCounts?.();
      filterControls.render?.();
      highlightControls.renderHighlightSummary?.();
      viewControls?.renderSplitViewBadges?.();
    });
  }

  function buildStatsInfoFromState() {
    const field = state.getActiveField();
    const centroidInfo =
      field && field.kind === 'category' && (state.centroidCount || 0) > 0
        ? ` • Centroids: ${state.centroidCount}`
        : '';
    return {
      field: field || null,
      pointCount: state.pointCount || 0,
      centroidInfo
    };
  }

  function syncNavigationUiForView(viewId) {
    if (destroyed) return;
    const navSelect = dom.camera.navigationModeSelect;
    const mode = viewer.getViewNavigationMode(viewId);

    if (navSelect.value !== mode) {
      navSelect.value = mode;
    }
    cameraControls.toggleNavigationPanels(mode);
    if (cinematicCamera !== null) {
      cinematicCamera.syncNavigationMode(mode);
    }
  }
  viewer.setNavigationModeChangeHandler((viewId) => {
    syncNavigationUiForView(viewId);
  });

  function handleVisibilityChange() {
    renderControls.markSmokeDirty?.();
    scheduleVisibilityUiUpdate();
  }

  function handleActiveFieldChanged(fieldInfo) {
    const info = fieldInfo || buildStatsInfoFromState();
    statsDisplay.updateStats?.(info);
    legend.render?.(info.field);
    legend.handleOutlierUI?.(info.field);
    highlightControls.updateHighlightMode?.();
    communityAnnotationControls.render?.();
  }

  const fieldSelector = initFieldSelector({
    state,
    dom: dom.fieldSelector,
    dataSourceManager,
    callbacks: {
      onActiveFieldChanged: handleActiveFieldChanged
    }
  });
  if (sessionSerializer !== null) {
    if (
      typeof sessionSerializer.setCaptureSettlement !== 'function'
      || typeof sessionSerializer.setRestoreSettlement !== 'function'
    ) {
      throw new TypeError(
        'Session serializer must implement capture and restore settlement.'
      );
    }
    sessionSerializer.setCaptureSettlement(
      fieldSelector.acquireSessionCaptureOperation
    );
    sessionSerializer.setRestoreSettlement(
      fieldSelector.acquireSessionRestoreOperation
    );
  }

  viewControls = initViewControls({
    state,
    viewer,
    dom: dom.view,
    renderDom: dom.render,
    callbacks: {
      onActiveViewChanged: (viewId) => {
        fieldSelector.syncFromState?.();
        legend.render?.(state.getActiveField());
        legend.handleOutlierUI?.(state.getActiveField());
        highlightControls.updateHighlightMode?.();
        filterControls.render?.();
        highlightControls.renderHighlightSummary?.();
        dimensionControls.updateDimensionSelectUI?.();
        syncNavigationUiForView(viewId);
        renderControls.markSmokeDirty?.();
      },
      onCycleViewDimension: async (viewId, nextDim) => {
        await dimensionControls.handleDimensionChange(
          nextDim,
          viewId,
          { silent: false }
        );
      },
      onNavigationUiSyncRequested: (viewId) => syncNavigationUiForView(viewId)
    }
  });
  renderControls.setRenderModeChangeHandler((mode) => {
    viewControls.syncRenderModeUI(mode);
  });
  viewer.setSmokeRenderFailureHandler((error) => {
    renderControls.settleSmokeRenderFailure(error);
  });
  viewer.setVelocityRenderFailureHandler?.((error) => {
    velocityOverlayControls.settleRenderFailure(error);
  });

  function refreshUiAfterStateLoad() {
    viewControls?.syncFromStateAndViewer?.();
    fieldSelector.renderFieldSelects?.();
    fieldSelector.renderDeletedFieldsSection?.();
    fieldSelector.initGeneExpressionDropdown?.();
    fieldSelector.syncFromState?.();

    legend.render?.(state.getActiveField());
    legend.handleOutlierUI?.(state.getActiveField());
    filterControls.render?.();
    highlightControls.renderHighlightPages?.();
    highlightControls.renderHighlightSummary?.();
    communityAnnotationControls.render?.();
    dimensionControls.updateDimensionSelectUI?.();
    syncNavigationUiForView(state.getActiveViewId());
  }

  const sessionControls = initSessionControls({
    dom: dom.session,
    sessionSerializer,
    onAfterLoad: refreshUiAfterStateLoad
  });
  const { showSessionStatus } = sessionControls;

  const datasetControls = initDatasetControls({
    dom: dom.dataset,
    dataSourceManager,
    clearDataset: clearActiveDataset,
    reloadDataset: reloadActiveDataset,
    callbacks: {
      renderFieldSelects: fieldSelector.renderFieldSelects,
      renderDeletedFieldsSection: fieldSelector.renderDeletedFieldsSection,
      initGeneExpressionDropdown: fieldSelector.initGeneExpressionDropdown,
      clearGeneSelection: fieldSelector.clearGeneSelection,
      refreshUIForActiveView: () => {
        viewControls?.syncFromStateAndViewer?.();
        fieldSelector.syncFromState?.();
        legend.render?.(state.getActiveField());
        legend.handleOutlierUI?.(state.getActiveField());
        highlightControls.updateHighlightMode?.();
        filterControls.render?.();
        highlightControls.renderHighlightSummary?.();
        dimensionControls.updateDimensionSelectUI?.();
        syncNavigationUiForView(state.getActiveViewId());
        renderControls.markSmokeDirty?.();
      },
      updateDimensionSelectUI: dimensionControls.updateDimensionSelectUI,
      showSessionStatus
    }
  });
  const {
    catalogReady: datasetCatalogReady,
    refreshDatasetUI
  } = datasetControls;

  const figureExportControls = initFigureExport({
    state,
    viewer,
    dom: dom.figureExport,
    dataSourceManager
  });

  cinematicCamera = initCinematicCamera({
    viewer,
    dom: dom.cinematicCamera,
    dataSourceManager
  });
  syncNavigationUiForView(state.getActiveViewId());

  const visualizationReset = initVisualizationReset({
    viewer,
    renderDom: dom.render,
    cameraDom: dom.camera,
    renderControls,
    cameraControls
  });

  // State change wiring
  const unsubscribeVisibility = state.on(
    'visibility:changed',
    handleVisibilityChange
  );
  const handleFieldChanged = () => {
    fieldSelector.renderFieldSelects?.();
    fieldSelector.renderDeletedFieldsSection?.();
    fieldSelector.initGeneExpressionDropdown?.();
    fieldSelector.syncFromState?.();
    legend.render?.(state.getActiveField());
    legend.handleOutlierUI?.(state.getActiveField());
    highlightControls.updateHighlightMode?.();
    communityAnnotationControls.render?.();
    handleVisibilityChange();
  };
  const unsubscribeField = state.on(
    'field:changed',
    handleFieldChanged
  );
  const handleDimensionChanged = () => {
    statsDisplay.updateStats?.(buildStatsInfoFromState());
    viewControls?.renderSplitViewBadges?.();
  };
  const unsubscribeDimension = state.on(
    'dimension:changed',
    handleDimensionChanged
  );

  // Initial render pass
  fieldSelector.renderFieldSelects?.();
  fieldSelector.initGeneExpressionDropdown?.();
  fieldSelector.renderDeletedFieldsSection?.();
  dimensionControls.updateDimensionSelectUI?.();
  filterControls.render?.();
  highlightControls.renderHighlightPages?.();
  highlightControls.renderHighlightSummary?.();
  communityAnnotationControls.render?.();
  viewControls?.renderSplitViewBadges?.();
  viewControls?.updateSplitViewUI?.();
  handleActiveFieldChanged(buildStatsInfoFromState());
  syncNavigationUiForView(state.getActiveViewId());

  function assertAlive() {
    if (destroyed) {
      throw new Error('The application UI is unavailable after destroy().');
    }
  }

  function publishOwnedSnapshot(config) {
    assertAlive();
    const created = publishSnapshotView({ state, viewer, config });
    try {
      viewControls.syncFromStateAndViewer();
      return created;
    } catch (error) {
      const rollbackFailures = [];
      try {
        retireSnapshotView({
          state,
          viewer,
          snapshotId: created.id,
        });
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
      try {
        viewControls.syncFromStateAndViewer();
      } catch (reconciliationError) {
        rollbackFailures.push(reconciliationError);
      }
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          'Snapshot publication succeeded but UI synchronization and rollback reconciliation failed.'
        );
      }
      throw error;
    }
  }

  function retireOwnedSnapshot(snapshotId) {
    assertAlive();
    let remaining;
    let retirementError = null;
    try {
      remaining = retireSnapshotView({
        state,
        viewer,
        snapshotId,
      });
    } catch (error) {
      retirementError = error;
    }
    try {
      viewControls.syncFromStateAndViewer();
    } catch (reconciliationError) {
      if (retirementError !== null) {
        throw new AggregateError(
          [retirementError, reconciliationError],
          `Snapshot "${snapshotId}" retirement failed and its UI could not be reconciled.`
        );
      }
      throw reconciliationError;
    }
    if (retirementError !== null) throw retirementError;
    return remaining;
  }

  function clearOwnedSnapshots() {
    assertAlive();
    let remaining;
    let clearingError = null;
    try {
      remaining = clearPublishedSnapshotViews({ state, viewer });
    } catch (error) {
      clearingError = error;
    }
    try {
      viewControls.syncFromStateAndViewer();
    } catch (reconciliationError) {
      if (clearingError !== null) {
        throw new AggregateError(
          [clearingError, reconciliationError],
          'Snapshot clearing failed and its UI could not be reconciled.'
        );
      }
      throw reconciliationError;
    }
    if (clearingError !== null) throw clearingError;
    return remaining;
  }

  const destroy = createStableTerminalDestroy({
    closeAdmission: () => {
      destroyed = true;
      if (visibilityUiFrame !== null) {
        cancelFrame(visibilityUiFrame);
        visibilityUiFrame = null;
      }
    },
    getOperations: () => [
      unsubscribeVisibility,
      unsubscribeField,
      unsubscribeDimension,
      () => renderControls.destroy(),
      () => cameraControls.destroy(),
      () => legend.destroy(),
      () => filterControls.destroy(),
      () => highlightControls.destroy(),
      () => sessionControls.destroy(),
      () => visualizationReset.destroy(),
      () => viewer.setNavigationModeChangeHandler(() => {}),
      () => viewer.setSmokeRenderFailureHandler(() => {}),
      () => viewer.setVelocityRenderFailureHandler?.(() => {}),
      () => viewer.setPointerLockChangeHandler(() => {}),
      () => viewer.setViewFocusHandler(() => {}),
      () => velocityOverlayControls.destroy(),
      () => dimensionControls.destroy(),
      () => datasetControls.destroy(),
      () => {
        if (typeof figureExportControls.destroy === 'function') {
          return figureExportControls.destroy();
        }
      },
      () => sidebarControls.destroy(),
      () => viewControls.destroy(),
      () => cinematicCamera?.destroy?.(),
      () => communityAnnotationControls.destroy?.(),
      () => infoPopovers.destroy(),
      () => fieldSelector.destroy(),
    ],
    failureMessage: 'Application UI teardown was incomplete.',
  });

  return {
    activateField: fieldSelector.activateField,
    applyRenderMode: renderControls.applyRenderMode,
    prepareDatasetReplacement: fieldSelector.prepareDatasetReplacement,
    refreshUiAfterStateLoad,
    showSessionStatus,
    refreshDatasetUI,
    settleFieldInteractions: fieldSelector.settleAllInteractions,
    datasetCatalogReady,
    cinematicCamera,
    publishSnapshotView: publishOwnedSnapshot,
    retireSnapshotView: retireOwnedSnapshot,
    clearSnapshotViews: clearOwnedSnapshots,
    destroy,
  };
}
