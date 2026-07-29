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
import { debug } from '../../../utils/debug.js';

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

  initSidebarControls({
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
  let visibilityUiScheduled = false;

  function scheduleVisibilityUiUpdate() {
    if (visibilityUiScheduled) return;
    visibilityUiScheduled = true;
    scheduleFrame(() => {
      visibilityUiScheduled = false;
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

  const { showSessionStatus } = initSessionControls({
    dom: dom.session,
    sessionSerializer,
    onAfterLoad: refreshUiAfterStateLoad
  });

  const {
    catalogReady: datasetCatalogReady,
    refreshDatasetUI
  } = initDatasetControls({
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

  initFigureExport({
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

  initVisualizationReset({
    viewer,
    renderDom: dom.render,
    cameraDom: dom.camera,
    renderControls,
    cameraControls
  });

  // State change wiring
  state.on('visibility:changed', handleVisibilityChange);
  state.on('field:changed', () => {
    fieldSelector.renderFieldSelects?.();
    fieldSelector.renderDeletedFieldsSection?.();
    fieldSelector.initGeneExpressionDropdown?.();
    fieldSelector.syncFromState?.();
    legend.render?.(state.getActiveField());
    legend.handleOutlierUI?.(state.getActiveField());
    highlightControls.updateHighlightMode?.();
    communityAnnotationControls.render?.();
    handleVisibilityChange();
  });
  state.on('dimension:changed', () => {
    statsDisplay.updateStats?.(buildStatsInfoFromState());
    viewControls?.renderSplitViewBadges?.();
  });

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

  return {
    activateField: fieldSelector.activateField,
    applyRenderMode: renderControls.applyRenderMode,
    prepareDatasetReplacement: fieldSelector.prepareDatasetReplacement,
    refreshUiAfterStateLoad,
    showSessionStatus,
    refreshDatasetUI,
    settleFieldInteractions: fieldSelector.settleAllInteractions,
    datasetCatalogReady,
    cinematicCamera
  };
}
