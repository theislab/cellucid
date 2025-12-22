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
import { initCameraControls } from '../modules/camera-controls.js';
import { initLegendRenderer } from '../modules/legend-renderer.js';
import { initFilterControls } from '../modules/filter-controls.js';
import { initHighlightControls } from '../modules/highlight-controls.js';
import { initFieldSelector } from '../modules/field-selector.js';
import { initViewControls } from '../modules/view-controls.js';
import { initDimensionControls } from '../modules/dimension-controls.js';
import { initDatasetControls } from '../modules/dataset-controls.js';
import { initSessionControls } from '../modules/session-controls.js';
import { initVisualizationReset } from '../modules/visualization-reset.js';
import { initFigureExport } from '../modules/figure-export/index.js';
import { debug } from '../../utils/debug.js';

const LIVE_VIEW_ID = 'live';

/**
 * Initialize the full app UI.
 *
 * @param {object} options
 * @param {import('../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {{ rebuildSmokeDensity?: (gridSize?: number) => void } | null} [options.smoke]
 * @param {import('../../../data/data-source-manager.js').DataSourceManager | null} [options.dataSourceManager]
 * @param {(metadata: any) => Promise<void> | void} [options.reloadActiveDataset]
 * @param {object|null} [options.stateSerializer]
 */
export function initUI({
  state,
  viewer,
  smoke = null,
  dataSourceManager = null,
  reloadActiveDataset = null,
  stateSerializer = null
}) {
  debug.log('[UI] initUI');

  const dom = collectDOMReferences(document);

  initSidebarControls({ dom: dom.sidebar });

  const statsDisplay = initStatsDisplay({ dom: dom.stats });
  const renderControls = initRenderControls({
    viewer,
    dom: dom.render,
    smoke
  });
  const cameraControls = initCameraControls({
    viewer,
    dom: dom.camera,
    callbacks: {
      onViewBadgesMaybeChanged: () => viewControls?.renderSplitViewBadges?.()
    }
  });

  const legend = initLegendRenderer({ state, dom: dom.display });
  const filterControls = initFilterControls({
    state,
    viewer,
    dom: dom.filter,
    callbacks: {
      onViewBadgesMaybeChanged: () => viewControls?.renderSplitViewBadges?.()
    }
  });
  const highlightControls = initHighlightControls({ state, viewer, dom: dom.highlight });

  let viewControls = null;

  const dimensionControls = initDimensionControls({
    state,
    viewer,
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
    const navSelect = dom.camera?.navigationModeSelect || null;
    if (!navSelect) return;
    const targetViewId = String(viewId || LIVE_VIEW_ID);
    const mode = typeof viewer.getViewNavigationMode === 'function'
      ? viewer.getViewNavigationMode(targetViewId)
      : (typeof viewer.getNavigationMode === 'function' ? viewer.getNavigationMode() : navSelect.value);

    if (mode && navSelect.value !== mode) {
      navSelect.value = mode;
    }
    cameraControls.toggleNavigationPanels?.(navSelect.value || 'orbit');
  }

  function handleVisibilityChange() {
    renderControls.markSmokeDirty?.();
    legend.refreshCategoryCounts?.();
    scheduleVisibilityUiUpdate();
  }

  function handleActiveFieldChanged(fieldInfo) {
    const info = fieldInfo || buildStatsInfoFromState();
    statsDisplay.updateStats?.(info);
    legend.render?.(info.field);
    legend.handleOutlierUI?.();
    highlightControls.updateHighlightMode?.();
  }

  const fieldSelector = initFieldSelector({
    state,
    dom: dom.fieldSelector,
    callbacks: {
      onActiveFieldChanged: handleActiveFieldChanged
    }
  });

  viewControls = initViewControls({
    state,
    viewer,
    dom: dom.view,
    renderDom: dom.render,
    callbacks: {
      onActiveViewChanged: (viewId) => {
        fieldSelector.syncFromState?.();
        legend.render?.(state.getActiveField());
        legend.handleOutlierUI?.();
        highlightControls.updateHighlightMode?.();
        filterControls.render?.();
        highlightControls.renderHighlightSummary?.();
        dimensionControls.updateDimensionSelectUI?.();
        syncNavigationUiForView(viewId);
        renderControls.markSmokeDirty?.();
      },
      onCycleViewDimension: async (viewId, nextDim) => {
        await dimensionControls.handleDimensionChange?.(nextDim, viewId, { silent: true });
      },
      onNavigationUiSyncRequested: (viewId) => syncNavigationUiForView(viewId)
    }
  });

  function refreshUiAfterStateLoad() {
    viewControls?.syncFromStateAndViewer?.();
    fieldSelector.renderFieldSelects?.();
    fieldSelector.renderDeletedFieldsSection?.();
    fieldSelector.initGeneExpressionDropdown?.();
    fieldSelector.syncFromState?.();

    legend.render?.(state.getActiveField());
    legend.handleOutlierUI?.();
    filterControls.render?.();
    highlightControls.renderHighlightPages?.();
    highlightControls.renderHighlightSummary?.();
    dimensionControls.updateDimensionSelectUI?.();
    viewControls?.renderSplitViewBadges?.();
    viewControls?.updateSplitViewUI?.();
    syncNavigationUiForView(state.getActiveViewId() || LIVE_VIEW_ID);
    renderControls.markSmokeDirty?.();
  }

  const { showSessionStatus } = initSessionControls({
    dom: dom.session,
    stateSerializer,
    onAfterLoad: refreshUiAfterStateLoad
  });

  const { refreshDatasetUI } = initDatasetControls({
    state,
    viewer,
    dom: dom.dataset,
    dataSourceManager,
    reloadDataset: reloadActiveDataset,
    callbacks: {
      renderFieldSelects: fieldSelector.renderFieldSelects,
      renderDeletedFieldsSection: fieldSelector.renderDeletedFieldsSection,
      initGeneExpressionDropdown: fieldSelector.initGeneExpressionDropdown,
      clearGeneSelection: fieldSelector.clearGeneSelection,
      refreshUIForActiveView: () => {
        fieldSelector.syncFromState?.();
        legend.render?.(state.getActiveField());
        legend.handleOutlierUI?.();
        highlightControls.updateHighlightMode?.();
        filterControls.render?.();
        highlightControls.renderHighlightSummary?.();
        dimensionControls.updateDimensionSelectUI?.();
        syncNavigationUiForView(state.getActiveViewId() || LIVE_VIEW_ID);
        renderControls.markSmokeDirty?.();
        viewControls?.renderSplitViewBadges?.();
        viewControls?.updateSplitViewUI?.();
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
    legend.handleOutlierUI?.();
    highlightControls.updateHighlightMode?.();
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
  viewControls?.renderSplitViewBadges?.();
  viewControls?.updateSplitViewUI?.();
  handleActiveFieldChanged(buildStatsInfoFromState());
  syncNavigationUiForView(state.getActiveViewId() || LIVE_VIEW_ID);

  return {
    activateField: fieldSelector.activateField,
    refreshUiAfterStateLoad,
    showSessionStatus,
    refreshDatasetUI
  };
}
