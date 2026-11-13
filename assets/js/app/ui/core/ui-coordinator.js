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
import { viewerNeedsUiRetirement } from './viewer-lifecycle.js';
import { initStatsDisplay } from '../modules/stats-display.js';
import { initRenderControls } from '../modules/render-controls.js';
import { initVelocityOverlayControls } from '../modules/velocity-overlay-controls.js';
import { initCameraControls } from '../modules/camera-controls.js';
import { initCellInfo } from '../modules/cell-info.js';
import { initCiteDialog } from '../modules/cite-dialog.js';
import { initLicenseDialog } from '../modules/license-dialog.js';
import { initShareDialog } from '../modules/share-dialog.js';
import { initGroupCategoriesDialog } from '../modules/group-categories-dialog.js';
import { initLegendRenderer } from '../modules/legend-renderer.js';
import { initFilterControls } from '../modules/filter-controls.js';
import { initHighlightControls } from '../modules/highlight-controls.js';
import { initFieldSelector } from '../modules/field-selector.js';
import { initCellExportsUi } from '../modules/cell-exports-ui.js';
import { FieldSource } from '../../utils/field-constants.js';
import { initViewControls } from '../modules/view-controls.js';
import { initRepresentationControls } from '../modules/representation-controls.js';
import { initDataMappingControls } from '../modules/data-mapping-controls.js';
import { modalityScope } from '../../../data/data-mapping-candidates.js';
import { initDatasetControls } from '../modules/dataset-controls.js';
import { initDatasetCard } from '../modules/dataset-card.js';
import { initKeptStoresLine } from '../modules/kept-stores-line.js';
import { initKeptStoresDialog } from '../modules/kept-stores-dialog.js';
import { initMyDatasets } from '../modules/my-datasets/index.js';
import { installDatasetOpenActions } from '../modules/dataset-open-action.js';
import { initAgentConnect } from '../../agent/connect/index.js';
import { geneCostFacts, initSubsampleControl } from '../modules/subsample-control.js';
import { getNotificationCenter } from '../../notification-center.js';
import { initSessionControls } from '../modules/session-controls.js';
import { requestOfOpenCells } from '../../../data/cell-subset-policy.js';
import { initGeneReadControl, readGenesForMoreCellsSaid } from '../modules/gene-read-control.js';
import { initSessionSections, subsamplingSummary } from '../modules/session-sections.js';
import { geneSampleDigest } from '../../session/cell-subset-record.js';
import { geneSampleCostText } from '../../../data/gene-read-plan.js';
import { initCommunityAnnotationControls } from '../modules/community-annotation-controls.js';
import { initVisualizationReset } from '../modules/visualization-reset.js';
import { initFigureExport } from '../modules/figure-export/index.js';
import { initCinematicCamera } from '../modules/cinematic-camera/index.js';
import { initStateSection } from '../modules/state/index.js';
import { initAgents } from '../../agent/index.js';
import { createBranchComparison } from '../modules/state/compare.js';
import { datasetFactsOf } from '../modules/state/dataset-facts.js';
import { initInfoPopovers } from '../components/info-popovers.js';
import { initFullTextReveal } from '../components/full-text-reveal.js';
import { bindDisclosure } from '../components/controls.js';
import {
  clearPublishedSnapshotViews,
  publishSnapshotView,
  retireSnapshotView,
} from '../../view-snapshot-publication.js';
import { debug } from '../../../utils/debug.js';
import { installFieldActions } from '../../state/actions/field-actions.js';
import { getActions } from '../../actions/index.js';
import { openCellsKey } from '../../state/domains/cells.js';
import { visitingViews } from '../../state/domains/view-list.js';
import { promiseWithResolvers } from '../../../utils/promise-resolvers.js';

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

    const { promise, resolve: resolveTerminal, reject: rejectTerminal } = promiseWithResolvers();
    terminalPromise = promise;

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
 * The status line that explains why the data-source controls are inert, and
 * the two states it publishes.
 *
 * `index.html` ships every data-source control disabled and this line visible,
 * because the listeners that act on those controls are attached by `initUI()`
 * — which runs only once startup has read its health endpoint and dataset
 * catalog. A control offered before its listener exists takes a click and
 * discards it without a request, a message or a record, so no control is
 * offered until this line says the listeners are there. Saying it through a
 * live region is what makes the change announced rather than merely drawn.
 *
 * The startup dataset itself loads only after this, as an ordinary dataset
 * change, so every control here is live while it loads and a choice made
 * then replaces it (`dataset-controls.js`).
 */
const DATA_SOURCE_STATUS_ID = 'data-source-status';
const DATA_SOURCE_STATUS_READY =
  'Data sources are ready. Load your own data, a server, or open a '
  + 'link below.';

/**
 * @param {Document} documentOwner
 * @returns {HTMLElement}
 */
function requireDataSourceStatus(documentOwner) {
  const status = documentOwner.getElementById(DATA_SOURCE_STATUS_ID);
  if (status === null) {
    throw new Error(
      'The data source controls require their readiness status line.'
    );
  }
  return status;
}

/**
 * Announce that the data-source controls now do what they offer.
 *
 * The line stays in the accessibility tree as a live region so the change is
 * spoken, and leaves the layout so a ready sidebar is not carrying a paragraph
 * about starting up.
 *
 * @param {Document} documentOwner
 * @returns {() => void} Restores the starting state
 */
function publishDataSourceReadiness(documentOwner) {
  const status = requireDataSourceStatus(documentOwner);
  const startingClassName = status.className;
  const startingText = status.textContent;
  status.className = 'sr-only';
  status.textContent = DATA_SOURCE_STATUS_READY;
  return () => {
    status.className = startingClassName;
    status.textContent = startingText;
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
 * @param {(transaction: Object) => Promise<boolean>} options.clearActiveDataset
 * @param {(selection: Object) => Promise<boolean>} options.reloadActiveDataset
 * @param {(options: {annData: Object, cellSubset: Object, signal: AbortSignal|null}) => Promise<{inPlace: boolean}>} options.resizeOpenCells
 *   The open cells grown or cut in place (`app/open-cells-resize.js`)
 * @param {object} options.datasetChanges The dataset-change coordinator every
 *   dataset change begins its transaction with
 *   (`createLatestDatasetReloadCoordinator`).
 * @param {object|null} [options.sessionSerializer]
 * @param {object|null} [options.datasetHistories] The history of the dataset
 *   shown and the saved states (`app/history/dataset-history.js`)
 * @param {{capture: Function, restore: Function}|null} [options.viewCarry] What a
 *   re-read of the open cells keeps (`app/session/view-carry.js`)
 * @param {any|null} [options.viewerHostSource]
 */
export function initUI({
  state,
  viewer,
  smoke = null,
  dataSourceManager = null,
  clearActiveDataset,
  reloadActiveDataset = null,
  resizeOpenCells,
  datasetChanges,
  sessionSerializer = null,
  datasetHistories = null,
  viewCarry = null,
  viewerHostSource = null
}) {
  debug.log('[UI] initUI');

  const dom = collectDOMReferences(document);
  const infoPopovers = initInfoPopovers({ root: document });
  const fullTextReveal = initFullTextReveal({ root: document });
  // The Session panel's collapsible sections (Subsampling, Data mapping):
  // collapsed by default, each a one-line summary while collapsed.
  const sessionSections = initSessionSections(document);
  // Collapsible sub-sections written in index.html share the builder's
  // behavior: aria-expanded on the header, `hidden` on the region.
  const staticDisclosures = new AbortController();
  for (const header of document.querySelectorAll(
    '[data-static-disclosure] > .disclosure-header'
  )) {
    bindDisclosure({
      header,
      content: document.getElementById(header.getAttribute('aria-controls')),
      expanded: header.getAttribute('aria-expanded') === 'true',
      signal: staticDisclosures.signal
    });
  }
  let viewControls = null;
  let cinematicCamera = null;
  let destroyed = false;

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

  const cellInfo = initCellInfo({
    viewer,
    state,
    toggle: dom.cellInfo.toggle,
    categoriesToggle: dom.cellInfo.categoriesToggle,
    canvas: dom.cellInfo.canvas
  });

  // The outlier filter's "Choose latent space" opens the Data mapping
  // setting (created below, so it is looked up when clicked).
  let dataMappingControls = null;
  const legend = initLegendRenderer({
    state,
    viewer,
    dom: dom.display,
    dataSourceManager,
    onChooseLatent: () => dataMappingControls?.reveal({ openSidebar: true, focusGroup: 'latent' }),
  });
  const filterControls = initFilterControls({
    state,
    viewer,
    dom: dom.filter,
    callbacks: {
      // Enabling, disabling or removing a filter from Active filters changes
      // state the legend's own controls display (range sliders, category
      // checkboxes, the outlier slider). Without a redraw they kept the old
      // bound, and the next slider nudge re-applied the removed filter. The
      // one active-field publication redraws every surface from state.
      onFiltersChanged: () => {
        if (!destroyed) handleActiveFieldChanged();
      },
      onViewBadgesMaybeChanged: () => viewControls?.renderSplitViewBadges?.()
    }
  });
  const highlightControls = initHighlightControls({ state, viewer, dom: dom.highlight, viewerHostSource });
  const communityAnnotationControls = initCommunityAnnotationControls({
    state,
    dom: dom.communityAnnotation,
    dataSourceManager,
    infoPopovers,
    actions: getActions(),
  });

  const representationControls = initRepresentationControls({
    state,
    viewer,
    dom: dom.representation,
    callbacks: {
      viewLabel: viewId => viewControls?.describeViewPosition?.(viewId) ?? null,
      onViewBadgesMaybeChanged: () => viewControls?.renderSplitViewBadges?.()
    }
  });
  dataMappingControls = initDataMappingControls({
    state,
    root: dom.dataMapping.root,
    onSummary: text => sessionSections.setSummary('dataMapping', text),
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
    visibilityUiFrame = scheduleFrame(function update() {
      visibilityUiFrame = null;
      if (destroyed) return;
      // A restore visiting the views one by one (`visitingViews`): the
      // focused view is its cursor, not the person's; redrawn once it ends.
      if (visitingViews()) {
        visibilityUiFrame = scheduleFrame(update);
        return;
      }
      // Field activation publishes visibility before the selector can commit
      // the replacement legend. Refreshing counts in the same frame keeps the
      // DOM and active model in one completed UI generation.
      publishStatsLine();
      legend.refreshCategoryCounts?.();
      filterControls.render?.();
      highlightControls.renderHighlightSummary?.();
      viewControls?.renderSplitViewBadges?.();
    });
  }

  function buildStatsInfoFromState() {
    const field = state.getActiveField();
    // Count the centroids the way every other reader of them does — from the
    // position array, as `view-controls.js`, `figure-export-contract.js` and the
    // renderer all do. `state.centroidCount` is a cached scalar that
    // `setActiveView` does not carry with the rest of a view's context, so it
    // reported whatever was last built rather than what this view holds: after
    // coloring another view by a continuous field it read zero, and the line
    // dropped the centroid count for a view that still had three.
    const centroids = state.centroidPositions;
    const centroidCount = centroids ? centroids.length / 3 : 0;
    const centroidInfo =
      field && field.kind === 'category' && centroidCount > 0
        ? ` • Centroids: ${centroidCount}`
        : '';
    return {
      field: field || null,
      pointCount: state.pointCount || 0,
      cellTotal: state.cellIdentity?.nOriginal ?? null,
      centroidInfo
    };
  }

  /**
   * Publish the statistics line from current state.
   *
   * `#stats` is `sr-only`, so a sighted user reads the legend and never sees
   * it: a stale line misinforms screen-reader users and nobody else notices.
   * It therefore follows the signals it depends on instead of being republished
   * from refresh lists, because a list that every caller must remember is what
   * left it reading "Field: None" over a fully colored plot.
   *
   * DataState announces no "the active field changed", but `setActiveField`,
   * `setActiveVarField` and `clearActiveField` all end in
   * `computeGlobalVisibility()` and `setActiveView` ends in
   * `_notifyVisibilityChange()`, so every activation — a click, a published
   * dataset's advertised state, Load State, a viewer host command, a switch to a
   * kept view — arrives as `visibility:changed`. That is the same signal
   * `highlight-controls.js` follows for the renderer's highlight mode. A
   * dimension change is the other input, because it moves the centroid count.
   */
  function publishStatsLine() {
    statsDisplay.updateStats?.(buildStatsInfoFromState());
  }

  function syncNavigationUiForView(viewId) {
    if (destroyed) return;
    cameraControls.syncNavigationMode(viewer.getViewNavigationMode(viewId));
  }
  viewer.setNavigationModeChangeHandler((viewId) => {
    syncNavigationUiForView(viewId);
  });

  function handleVisibilityChange() {
    renderControls.markSmokeDirty?.();
    scheduleVisibilityUiUpdate();
  }

  /**
   * The single publication of "the active field changed".
   *
   * Every surface that draws the active field is refreshed here, and only here.
   * A second, partial copy of this list would leave the sidebar disagreeing
   * with itself: a state-driven activation (a dataset's advertised starting
   * state, Load State, a viewer host command) would refresh the legend and the
   * selectors but not the rest, and a switch to a kept view — which restores
   * that view's own active field — would refresh a third, shorter set.
   *
   * The statistics line is not in this list. It follows `visibility:changed`
   * instead (see `publishStatsLine`), which reaches paths that never call this.
   *
   * @param {object|null} [fieldInfo] Field info from the activating call, or
   *   nothing to recompute it from current state.
   */
  function handleActiveFieldChanged(fieldInfo) {
    const info = fieldInfo || buildStatsInfoFromState();
    legend.render?.(info.field);
    legend.handleOutlierUI?.(info.field);
    communityAnnotationControls.render?.();
    // The field actions' Export follows the field the selectors now show.
    cellExports.refresh();
  }

  /**
   * The surfaces that describe whichever view is active.
   *
   * Two callers need exactly this sequence, so it has one copy: a second,
   * partial copy of a refresh list leaves a surface stale (see the comment
   * above `handleActiveFieldChanged`).
   *
   * The view id is a parameter because the two callers know it differently: the
   * view-controls callback is told which view it activated, while an outside
   * caller has to ask the state.
   *
   * @param {string} viewId
   */
  function refreshViewDependentSurfaces(viewId) {
    fieldSelector.syncFromState?.();
    handleActiveFieldChanged();
    filterControls.render?.();
    highlightControls.renderHighlightSummary?.();
    representationControls.render();
    syncNavigationUiForView(viewId);
    renderControls.markSmokeDirty?.();
  }

  // Before the field selector: its first activation refreshes the exports' buttons.
  const cellExports = initCellExportsUi({
    state,
    dom: dom.cellExports,
    getAnnDataSource: activeAnnDataSource,
    notifications: getNotificationCenter(),
    // The buttons' exports as actions (`cells.export`, `field.export`).
    actions: getActions(),
  });
  // Group categories (the categorical toolbar's Group): a new field of groups of its categories.
  const groupCategoriesDialog = initGroupCategoriesDialog({ ownerDocument: document, state, actions: getActions() });
  const fieldSelector = initFieldSelector({
    state,
    dom: dom.fieldSelector,
    dataSourceManager,
    callbacks: {
      onActiveFieldChanged: handleActiveFieldChanged,
      // A gene search that finds nothing offers the gene names column (Data mapping).
      onChooseGeneNames: () => dataMappingControls?.reveal({ openSidebar: true, focusGroup: 'geneNames' }),
      onGroupCategories: (fieldIndex, opener) => groupCategoriesDialog.open(fieldIndex, opener)
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
    // A dataset just shown reads its genes after its first view
    // (`DataState.listPublishedGenes`): a session records them (its
    // mapping's gene names, its gene count, its gene colorings), so a
    // capture or a restore waits for them before it holds the fields.
    sessionSerializer.setCaptureSettlement(async () => {
      await state.whenGenesListed();
      return fieldSelector.acquireSessionCaptureOperation();
    });
    sessionSerializer.setRestoreSettlement(async () => {
      await state.whenGenesListed();
      return fieldSelector.acquireSessionRestoreOperation();
    });
  }

  viewControls = initViewControls({
    state,
    viewer,
    dom: dom.view,
    renderDom: dom.render,
    callbacks: {
      onActiveViewChanged: (viewId) => refreshViewDependentSurfaces(viewId),
      onNavigationUiSyncRequested: (viewId) => syncNavigationUiForView(viewId)
    }
  });
  renderControls.setRenderModeChangeHandler((mode) => {
    viewControls.syncRenderModeUI(mode);
  });
  viewer.setSmokeRenderFailureHandler((error) => {
    renderControls.settleSmokeRenderFailure(error);
  });
  // Recoloring (a colormap, a category color) and dimension switches reach
  // the viewer without a visibility change; the smoke volume carries both.
  viewer.setSmokeSourceChangeHandler(() => {
    renderControls.markSmokeDirty();
  });
  viewer.setVelocityRenderFailureHandler?.((error) => {
    velocityOverlayControls.settleRenderFailure(error);
  });
  // The velocity overlay keeps no CPU copy of its field: on a restored
  // graphics context it is drawn again from the field's owner.
  const stopFollowingGraphicsReset = viewer.onGraphicsReset((phase) => {
    if (phase === 'restored') velocityOverlayControls.redraw();
  });

  function refreshUiAfterStateLoad() {
    viewControls?.syncFromStateAndViewer?.();
    fieldSelector.renderFieldSelects?.();
    fieldSelector.renderDeletedFieldsSection?.();
    fieldSelector.initGeneExpressionDropdown?.();
    fieldSelector.syncFromState?.();

    handleActiveFieldChanged();
    filterControls.render?.();
    highlightControls.renderHighlightPages?.();
    highlightControls.renderHighlightSummary?.();
    representationControls.render();
    syncNavigationUiForView(state.getActiveViewId());
  }

  // Agents (app/agent/): the presence every agent acting here goes through
  // (the confirm card, the activity line), the chat bar, and whether a saved
  // session carries the conversations.
  const agents = initAgents({
    dom: dom.agent,
    viewer,
    actions: getActions(),
    // The chat attaches the highlighted cells as a reference (agent/chat/selection.js).
    state,
    notify: sentence => getNotificationCenter().info(sentence, { category: 'session' }),
  });

  const sessionControls = initSessionControls({
    dom: dom.session,
    sessionSerializer,
    datasetChanges,
    currentDatasetIdentityId: () =>
      dataSourceManager?.getCurrentIdentityId() ?? null,
    // The dataset controls are made below; a session is only loaded later.
    openDatasetSource: record => datasetControls.openDatasetSource(record),
    localFiles: {
      kept: datasetId => datasetControls.keptLocalFile(datasetId),
      reopen: datasetId => datasetControls.reopenLocalFile(datasetId)
    },
    currentCellIdentity: () => (dataSourceManager?.getCurrentDatasetId?.() == null ? null : state.cellIdentity),
    reopenDataset: cellSubset => datasetControls.reopenOpenDataset(cellSubset),
    restoreGeneSample: genes => restoreSessionGeneSample(genes),
    // Saved states (the autosave, named saves) open like a session file: their dataset first.
    savedStates: datasetHistories === null
      ? null
      : { read: id => datasetHistories.savedStates.read(id), load: (source, options) => datasetHistories.loadSaved(source, options) },
    // A session load opens its dataset without offering to continue another history there.
    holdHistoryOffers: datasetHistories === null ? null : task => datasetHistories.holdOffersUntil(task),
    onAfterLoad: refreshUiAfterStateLoad
  });

  /**
   * Read genes for the open cells a session read them for (its `genes`,
   * `session/cell-subset-record.js`), on the cells already open: the same
   * cells in the same order (its digest) read for at least as many, else
   * the open cells read again in the session's order with its sample
   * (`requestOfOpenCells`). Every open cell's genes read already: nothing.
   */
  async function restoreSessionGeneSample(genes) {
    if (genes === null) return;
    const annData = activeAnnDataSource();
    const subset = annData?.getCellSubset?.() ?? null;
    const identity = annData?.getCellIdentity?.() ?? null;
    if (subset === null || identity === null || subset.genes == null) return;
    const sameCells = genes.cells <= identity.n && geneSampleDigest(identity, genes.cells) === genes.digest;
    if (!sameCells) {
      await datasetControls.reopenOpenDataset({ ...requestOfOpenCells(subset), ...(genes.order === null ? {} : { order: genes.order }), genes: genes.cells });
      return;
    }
    if (genes.cells <= subset.genes.cells) return;
    const cost = await state.geneSampleCost(genes.cells).catch(() => null);
    await readGenesForMoreCellsSaid(state, genes.cells, cost === null ? null : geneSampleCostText(cost), 'the session\'s cells');
  }
  const { showSessionStatus } = sessionControls;

  /** The direct AnnData source of the open dataset, or null. */
  function activeAnnDataSource() {
    const sourceType = dataSourceManager?.getCurrentSourceType?.() ?? null;
    const datasetId = dataSourceManager?.getCurrentDatasetId?.() ?? null;
    if (sourceType === null || datasetId === null) return null;
    const source = dataSourceManager.getSource(sourceType);
    return typeof source?.getAnnDataSource === 'function' ? source.getAnnDataSource(datasetId) : null;
  }

  // The Dataset box describes the open dataset from its identity, where it
  // is stored, and what its data mapping uses.
  const datasetCard = initDatasetCard({
    dom: dom.datasetCard,
    describeStorage: (sourceType, datasetId) => {
      const source = dataSourceManager?.getSource(sourceType) ?? null;
      const annData = typeof source?.getAnnDataSource === 'function'
        ? source.getAnnDataSource(datasetId)
        : null;
      return typeof annData?.describeStorage === 'function'
        ? annData.describeStorage()
        : null;
    },
    describeCells: (sourceType, datasetId) => {
      const source = dataSourceManager?.getSource(sourceType) ?? null;
      const annData = typeof source?.getAnnDataSource === 'function'
        ? source.getAnnDataSource(datasetId)
        : null;
      return typeof annData?.getCellSubset === 'function' ? annData.getCellSubset() : null;
    },
    // How much of the graph in use a subsample keeps, once it was read.
    describeGraphShare: (sourceType, datasetId) => {
      const source = dataSourceManager?.getSource(sourceType) ?? null;
      const annData = typeof source?.getAnnDataSource === 'function'
        ? source.getAnnDataSource(datasetId)
        : null;
      return typeof annData?.subsampleGraphShare === 'function'
        ? annData.subsampleGraphShare(state.getDataMapping()?.knn ?? null)
        : Promise.resolve(null);
    },
    describeHost: sourceType => {
      const source = dataSourceManager?.getSource(sourceType) ?? null;
      return typeof source?.getHostLabel === 'function' ? source.getHostLabel() : null;
    },
    describeMapping: () => {
      const mapping = state.getDataMapping();
      if (mapping === null) return null;
      const candidates = state.getMappingCandidates();
      const scope = candidates === null ? null : (modalityScope(candidates, mapping.modality ?? null)?.scope ?? candidates);
      const shown = state.getRepresentationChoices()
        .filter(choice => choice.enabled && choice.usable)
        .map(choice => `${choice.name} ${choice.dimension}D`);
      return {
        // While the gene list is read after the first view, the count the
        // identity published from metadata stands (null here).
        genes: state.areGenesPending() ? null : state.getVarAxisGeneCount(),
        graph: state.getConnectivityGraphFact(),
        embeddings: {
          shown,
          arrays: candidates === null
            ? shown.length
            : candidates.obsm.filter(item => item.usable).length,
        },
        // A multimodal dataset's layers and raw are its modality's.
        modality: mapping.modality ?? null,
        layers: scope === null ? null : scope.layers.map(layer => layer.key),
        raw: scope === null ? null : (scope.raw === null ? false : scope.raw.n_vars),
        latent: mapping.latent,
        vectorFields: mapping.vectorFields.map(binding => binding.key),
      };
    }
  });
  // My datasets (Open data): the datasets opened in this browser, each opened
  // again in one click; its openers are the dataset and session controls'.
  const myDatasets = dataSourceManager === null || dom.myDatasets.menu.root === null
    ? null
    : initMyDatasets(dom.myDatasets, {
        currentId: () => dataSourceManager.getCurrentIdentityId(),
        onDatasetChange: listener => {
          dataSourceManager.onDatasetChange(listener);
          return () => dataSourceManager.offDatasetChange(listener);
        },
        openDatasetSource: record => datasetControls.openDatasetSource(record),
        reopenLocalFile: datasetId => datasetControls.reopenLocalFile(datasetId),
        openSavedState: id => sessionControls.openSavedState(id),
        // Forgetting a dataset by name (`my-datasets.forget`): the row's Forget.
        actions: getActions(),
      });
  // What is kept in this browser (Open data › Stored), and the dialog that lists and removes it.
  const keptStoresLine = initKeptStoresLine(dom.keptStores, { onManage: opener => void keptStoresDialog.open(opener) });
  const keptStoresDialog = initKeptStoresDialog(dom.keptStoresDialog, {
    onRemoved: () => void keptStoresLine.refresh(),
    onShowLibrary: myDatasets === null ? null : opener => myDatasets.openAll(opener),
    // Its rows and their removal as actions (`stored.list`, `stored.remove`).
    actions: getActions(),
  });
  const datasetControls = initDatasetControls({
    dom: dom.dataset,
    datasetCard,
    dataSourceManager,
    clearDataset: clearActiveDataset,
    reloadDataset: reloadActiveDataset,
    resizeOpenCells,
    datasetChanges,
    callbacks: {
      renderFieldSelects: fieldSelector.renderFieldSelects,
      renderDeletedFieldsSection: fieldSelector.renderDeletedFieldsSection,
      initGeneExpressionDropdown: fieldSelector.initGeneExpressionDropdown,
      clearGeneSelection: fieldSelector.clearGeneSelection,
      refreshUIForActiveView: () => {
        // Only this caller syncs the view controls: the callback above is
        // invoked *by* them, so doing it there would be re-entrant.
        viewControls?.syncFromStateAndViewer?.();
        refreshViewDependentSurfaces(state.getActiveViewId());
      },
      renderRepresentationPicker: representationControls.render,
      showSessionStatus
    }
  });
  const { refreshDatasetUI: refreshDatasetControls } = datasetControls;
  // Opening a dataset by name (`dataset.open`, `datasets.list`): the Open data controls' own paths.
  const uninstallDatasetOpenActions = dataSourceManager === null
    ? () => {}
    : installDatasetOpenActions({ actions: getActions(), dataSourceManager, state, datasetControls });
  // Agents › Claude and ChatGPT: this page's connection to the Cellucid relay, and its approvals.
  const agentConnect = dom.agentConnect.section === null
    ? null
    : initAgentConnect(dom.agentConnect, {
      actions: getActions(), dataSourceManager, notifications: getNotificationCenter(),
      // Each connection's tool list says what the person's permission settings make of each kind.
      permissionFor: question => agents.presence.permissionFor(question),
    });
  const citeDialog = initCiteDialog({ ownerDocument: document });
  const licenseDialog = initLicenseDialog({ ownerDocument: document });
  const shareDialog = dataSourceManager === null
    ? null
    : initShareDialog({ ownerDocument: document, dataSourceManager, actions: getActions() });
  // How much of a dataset is read, and how (Open data, Cells to open).
  const subsampleControl = initSubsampleControl({
    dom: dom.subsample,
    state,
    getCellSubset: () => activeAnnDataSource()?.getCellSubset?.() ?? null,
    reopen: (cellSubset, how) => datasetControls.reopenOpenDataset(cellSubset, how),
    notify: text => getNotificationCenter().info(text, { category: 'data' }),
    representation: key => activeAnnDataSource()?.subsampleRepresentation?.(key) ?? Promise.resolve(null),
    // What a gene of the matrix genes are read from costs now (Details): its first gene's read plan.
    geneCost: async () => {
      const loader = state.varFieldLoader;
      const gene = state._varFieldDescriptors?.[0];
      if (typeof loader?.readPlan !== 'function' || gene == null) return null;
      return geneCostFacts(await loader.readPlan(gene));
    },
    // Cameras, fields, filters and analysis windows stay across a re-read.
    viewCarry: viewCarry === null
      ? null
      : {
          capture: () => viewCarry.capture(),
          // The dataset read again lists its genes after its first view: a
          // view colored by a gene is given back once they are listed.
          restore: async carry => {
            await state.whenGenesListed();
            return viewCarry.restore(carry);
          },
        },
  });
  // Genes read for, below Cells to open: the one place the gene sample changes.
  const geneReadControl = initGeneReadControl({
    dom: dom.geneRead,
    state,
    openCellsKey: () => openCellsKey(activeAnnDataSource()?.getCellSubset?.() ?? null),
  });
  // What the `cells` state domain reads and puts back (`state/domains/cells.js`):
  // the cells open, the genes asked for on them, a reading of the dataset
  // again on other cells that keeps what was made, and genes read for more cells.
  const openCells = Object.freeze({
    subset: () => activeAnnDataSource()?.getCellSubset?.() ?? null,
    geneSample: () => state.getGeneSample?.() ?? null,
    genesAsked: () => geneReadControl.genesAsked(),
    setGenesAsked: cells => geneReadControl.setGenesAsked(cells),
    reopen: (request, { heavy = null, signal = null } = {}) => subsampleControl.reopenKeeping(request, { heavy, signal }),
    readGenes: (cells, { heavy = null, signal = null } = {}) => readGenesForMoreCellsSaid(state, cells, null, 'the cells of the step shown', { heavy, signal }),
  });
  // The field, label, color, filter and mapping actions the state alone
  // implements (`state/actions/field-actions.js`), refused while community
  // annotation voting locks a field.
  const uninstallFieldActions = installFieldActions({ state, fieldLock: fieldSelector.fieldLock });
  // A progressive opening growing in place (`{cells, target}`), or null.
  let openingGrowth = null;
  // Subsampling's header, collapsed: the cells open (or, while an opening
  // grows, the share it grows to and the cells read so far) and the share
  // genes are read for.
  function refreshSubsamplingSummary() {
    if (destroyed) return;
    sessionSections.setSummary('subsampling', subsamplingSummary(
      activeAnnDataSource()?.getCellSubset?.() ?? null,
      state.getGeneSample?.() ?? null,
      state.getGeneSampleGrowth?.() ?? null,
      openingGrowth
    ));
  }
  const stopSubsamplingSummary = state.on('gene-sample:changed', refreshSubsamplingSummary);
  // The dataset shown, its cells grown or cut in place: what says how many
  // cells are open, and nothing the person set up.
  function refreshOpenCells(metadata) {
    datasetControls.refreshOpenCells(metadata);
    subsampleControl.showOpenCells();
    refreshSubsamplingSummary();
  }
  // A newly published dataset decides whether there is anything to share.
  function refreshDatasetUI(...args) {
    const result = refreshDatasetControls(...args);
    shareDialog?.refresh();
    dataMappingControls.datasetPublished();
    subsampleControl.refresh();
    refreshSubsamplingSummary();
    return result;
  }

  const figureExportControls = initFigureExport({
    state,
    viewer,
    dom: dom.figureExport,
    dataSourceManager
  });

  cinematicCamera = initCinematicCamera({
    viewer,
    dom: dom.cinematicCamera,
    navigation: cameraControls,
    dataSourceManager,
    // What the focused view shows, for keyframes to record: its embedding
    // reference and short name, or null without a dataset mapping.
    focusedRepresentation: () => {
      const viewId = viewer.getFocusedViewId();
      const shown = state.describeViewEmbedding(viewId);
      if (shown === null || state.getDataMapping() === null) return null;
      return { ref: state.getViewEmbeddingRef(viewId), name: `${shown.name} ${shown.dimension}D` };
    },
    representationNameOf: layout => state.representationNameOf(layout),
  });
  syncNavigationUiForView(state.getActiveViewId());
  // While a camera path plays, the chat over the plot's foot folds to its
  // button and comes back when the path stops (app/agent/chat, dock.js).
  // While it plays, the path moves the camera, not a gesture of the person's
  // (camera-controls.js `setCameraPathPlaying`).
  cinematicCamera.getPlaybackController().on('stateChange', playbackState => {
    cameraControls.setCameraPathPlaying(playbackState === 'PLAYING');
    agents.chat?.setFilmPlaying(playbackState === 'PLAYING');
  });

  const visualizationReset = initVisualizationReset({
    viewer,
    renderDom: dom.render,
    cameraDom: dom.camera,
    renderControls,
    cameraControls
  });

  // The State panel: the session file (above, sessionControls) and the
  // history of the dataset shown (ui/modules/state/). Branches are compared
  // in kept views through the owned publication below. The report draws no
  // pictures until the figure export can return one without downloading.
  const stateSection = initStateSection({
    dom: dom.state,
    dispatch: (type, params, meta) => getActions().dispatch(type, params, meta),
    // The tour and the report as actions (`history.tour.start`, `history.tour.stop`, `history.report`).
    provide: (type, handler) => getActions().provide(type, handler),
    datasetFacts: datasetFactsOf({ state, dataSourceManager }),
    compareBranches: createBranchComparison({ dispatch: (type, params) => getActions().dispatch(type, params) }),
    camera: viewer,
    // The report's pictures are the agent's: the figure export's drawing of the selected view.
    pictures: async () => (await getActions().dispatch('view.picture', { width: 720, height: 540, legend: true })).outcome,
    // A session file of any dataset replayed on the one shown: read and checked as a file, its steps by name.
    replaySessionFile: sessionSerializer === null || datasetHistories === null ? null : {
      pick: () => sessionSerializer.pickSessionFile(),
      replay: (file, options) => datasetHistories.replay(() => sessionSerializer.openSessionFile(file, options), { ...options, choice: { file: file.name } }),
    },
    // A replay's names mapped (its report's "Replay again with these names"): from the same source, in a new tracker.
    replayAgain: datasetHistories === null ? null : {
      can: trackerId => datasetHistories.replaySource(trackerId) !== null,
      replay: (trackerId, mapping, options) => datasetHistories.replayAgain(trackerId, mapping, options),
    }
  });

  // State change wiring
  const unsubscribeVisibility = state.on(
    'visibility:changed',
    handleVisibilityChange
  );
  // A field change names its source: one obs field's change leaves the gene
  // list as it is, and one gene's leaves the obs field selects as they are.
  const handleFieldChanged = ({ source }) => {
    if (source !== FieldSource.VAR) fieldSelector.renderFieldSelects?.();
    fieldSelector.renderDeletedFieldsSection?.();
    if (source !== FieldSource.OBS) fieldSelector.initGeneExpressionDropdown?.();
    fieldSelector.syncFromState?.();
    handleActiveFieldChanged();
    handleVisibilityChange();
  };
  const unsubscribeField = state.on(
    'field:changed',
    handleFieldChanged
  );
  const handleRepresentationChanged = ({ viewId, dimension }) => {
    if (viewId === state.activeViewId) {
      renderControls.applyViewDimensionAntialiasing(dimension);
      publishStatsLine();
    }
    viewControls?.renderSplitViewBadges?.();
  };
  const unsubscribeDimension = state.on(
    'view:representation-changed',
    handleRepresentationChanged
  );
  // A changed mapping (an embedding turned on or off, another default)
  // relabels the rows of the views that show or follow it, and a changed
  // graph or gene list is the one the dataset facts count.
  const unsubscribeMapping = state.on(
    'mapping:changed',
    () => {
      viewControls?.renderSplitViewBadges?.();
      datasetControls.updateMappedDatasetFacts();
    }
  );
  // A new gene list (another expression matrix or other gene names) is
  // listed, searched and shown exactly as after a session load.
  const unsubscribeVarAxis = state.on(
    'var-axis:changed',
    () => refreshUiAfterStateLoad()
  );
  // The gene list of a dataset just shown, read after its first view (or
  // why it could not be): everything that showed it loading lists it now.
  const unsubscribeGenesListed = state.on(
    'genes:listed',
    () => {
      refreshUiAfterStateLoad();
      datasetControls.updateMappedDatasetFacts();
    }
  );
  // Another latent space adds or removes outlier filters.
  const unsubscribeLatentSpace = state.on(
    'latent-space:changed',
    () => refreshUiAfterStateLoad()
  );

  // Initial render pass
  fieldSelector.renderFieldSelects?.();
  fieldSelector.initGeneExpressionDropdown?.();
  fieldSelector.renderDeletedFieldsSection?.();
  representationControls.render();
  filterControls.render?.();
  highlightControls.renderHighlightPages?.();
  highlightControls.renderHighlightSummary?.();
  communityAnnotationControls.render?.();
  viewControls?.renderSplitViewBadges?.();
  viewControls?.updateSplitViewUI?.();
  // The markup ships "Loading data…", and the load that finished before this
  // module existed published its `visibility:changed` to nobody, so the first
  // statistics line is written here rather than waiting for the next signal.
  publishStatsLine();
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

  // Every module above has attached its listeners, so the controls that were
  // shipped disabled can now be offered.
  const retireDataSourceReadiness = publishDataSourceReadiness(document);

  const destroy = createStableTerminalDestroy({
    closeAdmission: () => {
      destroyed = true;
      if (visibilityUiFrame !== null) {
        cancelFrame(visibilityUiFrame);
        visibilityUiFrame = null;
      }
    },
    getOperations: () => [
      retireDataSourceReadiness,
      () => staticDisclosures.abort(),
      unsubscribeVisibility,
      unsubscribeField,
      unsubscribeDimension,
      unsubscribeMapping,
      unsubscribeVarAxis,
      unsubscribeGenesListed,
      unsubscribeLatentSpace,
      () => renderControls.destroy(),
      () => cameraControls.destroy(),
      () => cellInfo.destroy(),
      () => citeDialog.destroy(),
      () => licenseDialog.destroy(),
      () => shareDialog?.destroy(),
      () => groupCategoriesDialog.destroy(),
      () => legend.destroy(),
      () => filterControls.destroy(),
      () => highlightControls.destroy(),
      () => cellExports.destroy(),
      () => sessionControls.destroy(),
      () => stateSection.destroy(),
      () => agents.destroy(),
      () => visualizationReset.destroy(),
      () => {
        if (viewerNeedsUiRetirement(viewer)) {
          viewer.setNavigationModeChangeHandler(() => {});
        }
      },
      () => {
        if (viewerNeedsUiRetirement(viewer)) {
          viewer.setSmokeRenderFailureHandler(() => {});
          viewer.setSmokeSourceChangeHandler(() => {});
        }
      },
      () => {
        if (viewerNeedsUiRetirement(viewer)) {
          viewer.setVelocityRenderFailureHandler?.(() => {});
        }
      },
      () => stopFollowingGraphicsReset(),
      () => {
        if (viewerNeedsUiRetirement(viewer)) {
          viewer.setPointerLockChangeHandler(() => {});
        }
      },
      () => {
        if (viewerNeedsUiRetirement(viewer)) {
          viewer.setViewFocusHandler(() => {});
        }
      },
      () => velocityOverlayControls.destroy(),
      () => representationControls.destroy(),
      () => dataMappingControls.destroy(),
      () => datasetControls.destroy(),
      () => datasetCard.destroy(),
      () => keptStoresLine.destroy(),
      () => keptStoresDialog.destroy(),
      () => myDatasets?.destroy(),
      () => uninstallFieldActions(),
      () => uninstallDatasetOpenActions(),
      () => agentConnect?.destroy(),
      () => subsampleControl.destroy(),
      () => geneReadControl.destroy(),
      () => stopSubsamplingSummary(),
      () => sessionSections.destroy(),
      () => {
        if (typeof figureExportControls.destroy === 'function') {
          return figureExportControls.destroy();
        }
      },
      () => viewControls.destroy(),
      () => cinematicCamera?.destroy?.(),
      () => communityAnnotationControls.destroy?.(),
      () => infoPopovers.destroy(),
      () => fullTextReveal.destroy(),
      () => fieldSelector.destroy(),
    ],
    failureMessage: 'Application UI teardown was incomplete.',
  });

  /**
   * Publish whether the runtime has cells: a dataset or synthetic benchmark
   * data, rather than the empty runtime None leaves. Keeping a view, exporting
   * a figure and saving a session all act on cells, so without them they are
   * unavailable and say why.
   *
   * @param {boolean} present
   */
  function publishCellPresence(present) {
    if (typeof present !== 'boolean') {
      throw new TypeError('Runtime cell presence must be one boolean.');
    }
    // A retired UI has no controls left to gate.
    if (destroyed) return;
    viewControls.setCellsPresent(present);
    figureExportControls.setCellsPresent?.(present);
  }

  /**
   * Open a newly published dataset with the render settings its size wants.
   *
   * Two settings depend on nothing but the cell count, and both were single
   * shipped constants that could not be right for a 3,696-cell trajectory and an
   * 18-million-cell atlas at once: the point size, and whether to antialias.
   *
   * Called once per dataset publication, while it synchronizes the controls and
   * before any saved state is replayed, so a session or a published preset
   * still overrides the point size. `Reset` is re-captured afterwards: a reset
   * should return to what this dataset opened with, not to the markup, which
   * belongs to no dataset.
   *
   * @param {number} cellCount
   * @param {1|2|3} dimension The dimension the dataset opens in.
   * @returns {{pointSize: number, antialiasing: boolean}}
   */
  function applyDatasetRenderDefaults(cellCount, dimension) {
    const pointSize = renderControls.applyAutomaticPointSize(cellCount);
    const antialiasing = renderControls.applyDatasetAntialiasing(cellCount, dimension);
    renderControls.applyDatasetLodRange(cellCount);
    visualizationReset.captureInitialState();
    return { pointSize, antialiasing };
  }

  return {
    activateField: fieldSelector.activateField,
    colorByGene: fieldSelector.colorByGene,
    applyRenderMode: renderControls.applyRenderMode,
    applyDatasetRenderDefaults,
    // A progressive opening's growth: `{cells, target}`, or null when done.
    showOpenCellsGrowth: progress => {
      openingGrowth = progress;
      subsampleControl.showGrowth(progress);
      refreshSubsamplingSummary();
    },
    loadStartupDataset: datasetControls.loadStartupDataset,
    prepareDatasetReplacement: fieldSelector.prepareDatasetReplacement,
    publishCellPresence,
    refreshUiAfterStateLoad,
    showSessionStatus,
    // A saved state from the lists or the Continue offer: its dataset, then its history.
    openSavedState: sessionControls.openSavedState,
    refreshDatasetUI,
    refreshOpenCells,
    showLoadedConnectivityEdges: datasetControls.showLoadedConnectivityEdges,
    refreshDataMapping: dataMappingControls.datasetPublished,
    cycleRepresentation: representationControls.cycle,
    settleFieldInteractions: fieldSelector.settleAllInteractions,
    cinematicCamera,
    figureExport: figureExportControls,
    openCells,
    publishSnapshotView: publishOwnedSnapshot,
    retireSnapshotView: retireOwnedSnapshot,
    clearSnapshotViews: clearOwnedSnapshots,
    agents,
    destroy,
  };
}
