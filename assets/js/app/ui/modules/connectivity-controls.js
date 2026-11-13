/**
 * @fileoverview The connectivity controls (Show edges, color, opacity, width,
 * Max edges) and the owner of the neighbor graph's edges on the page: when
 * they are read (`loadEdges`), which of them each view shows at its level of
 * detail and visibility, the k-NN tool's graph and its row reader, and what
 * a dataset replacement or a data mapping's new graph does to them.
 *
 * It owns the edges read and shown, the controls' listeners and the KNN
 * callbacks it gives the viewer. Which graph is in use, the dataset's base
 * and its publication generation are the publication's
 * (`app/dataset/publication.js`), read through the getters it is given; the
 * edges drawn are the viewer's.
 *
 * @module app/ui/modules/connectivity-controls
 */

import { CONNECTIVITY_DEFAULT_VISIBLE_TARGET } from '../../../rendering/connectivity-edge-layer.js';
import { requireLodMembership } from '../../../rendering/high-perf/renderer-contracts.js';
import { forwardEdgeRows } from '../../../data/connectivity-edges.js';
import { loadConnectivityRows, loadEdges } from '../../../data/data-loaders.js';
import { DataSourceErrorCode } from '../../../data/data-source.js';
import { setWorkingSet, typedArrayBytes } from '../../../data/memory-budget.js';
import { getReadActivityLog } from '../../../data/read-activity-log.js';
import { cancelled, isCancellation, onAbort } from '../../../utils/abort.js';
import { debug } from '../../../utils/debug.js';
import { joinFailure, sayFailure } from '../../../utils/errors.js';
import { formatBytes, formatCountOf, formatCompactCount as formatNumber } from '../../../utils/format-units.js';
import { bytesOfHex } from '../../../utils/hex-color.js';
import { clamp } from '../../utils/number-utils.js';
import { setControlAvailability } from '../core/control-availability.js';
import { defineControlReadout } from '../core/control-readout.js';
import { noDatasetOpenTo } from '../no-dataset.js';


/**
 * Edges a millisecond one pass of `forwardEdgeRows` walks, before this page
 * has timed one (`knnRowReader`): about 100,000, a prior replaced by the
 * first pass's own rate, never a limit (measured:
 * 24_decisions_graph_edges_at_scale.md).
 */
const KNN_SCAN_EDGES_PER_MS = 100_000;

/**
 * Make the connectivity controls and the edge owner, once, before the first
 * publication. Every DOM element it uses is looked up now.
 *
 * @param {{
 *   viewer: Object, state: Object, notifications: Object, dataSourceManager: Object,
 *   userSource: Object, applicationSignal: AbortSignal,
 *   getDatasetBaseUrl: () => string, getPublicationGeneration: () => number,
 *   getGraphSummary: () => Object|null, getGraphUrl: () => string|null,
 *   setGraph: (summary: Object|null, url: string|null) => void,
 *   onEdgesShown: (edges: number) => void,
 * }} options - The getters read the publication's values; `setGraph` replaces the graph in use;
 *   `onEdgesShown` tells the interface how many edges were read; `applicationSignal` ends
 *   the controls' listeners and timers with the application.
 */
export function initializeConnectivityControls({
  viewer,
  state,
  notifications,
  dataSourceManager,
  userSource,
  applicationSignal,
  getDatasetBaseUrl,
  getPublicationGeneration,
  getGraphSummary,
  getGraphUrl,
  setGraph,
  onEdgesShown
}) {
  const connectivityControls = document.getElementById('connectivity-controls');
  const connectivityCheckbox = document.getElementById('toggle-connectivity');
  const connectivitySliders = document.getElementById('connectivity-sliders');
  const connectivityAlphaInput = document.getElementById('connectivity-alpha');
  const connectivityAlphaDisplay = document.getElementById('connectivity-alpha-display');
  const connectivityWidthInput = document.getElementById('connectivity-width');
  const connectivityWidthDisplay = document.getElementById('connectivity-width-display');
  const connectivityColorInput = document.getElementById('connectivity-color');
  const connectivityLimitInput = document.getElementById('connectivity-limit');
  const connectivityLimitDisplay = document.getElementById('connectivity-limit-display');
  const connectivityInfo = document.getElementById('connectivity-info');
  // The current graph's edge count. A graph read straight from a file is
  // counted when its edges are read: until then its summary has none,
  // and the count is the published edges'.
  let publishedEdgeCount = null;
  const getTotalEdges = () =>
    getGraphSummary() === null
      ? 0
      : getGraphSummary().n_edges ?? publishedEdgeCount ?? 0;

  // UI statistics describe only the active pane, while every pane owns its
  // own selection of shown edges inside the viewer.
  let activeConnectivityStatsViewId = null;
  let actualVisibleEdges = getTotalEdges();

  /**
   * Resolve one exact compositional visibility owner.
   * An endpoint is visible only when its per-view transparency passes the
   * scatter threshold and its current level of detail draws it
   * (`LodMembership`).
   *
   * @param {string} viewId - Exact live or snapshot view ID.
   * @param {number} dimensionLevel - Exact view dimension.
   * @returns {{transparency: Uint8Array, lodMembership: object|null, pointCount: number}}
   */
  function getConnectivityVisibilityOwner(viewId, dimensionLevel) {
    if (typeof viewId !== 'string' || viewId.length === 0) {
      throw new TypeError(
        'Connectivity visibility requires one exact non-empty view id.'
      );
    }
    if (
      !Number.isInteger(dimensionLevel) ||
      dimensionLevel < 1 ||
      dimensionLevel > 3
    ) {
      throw new TypeError(
        'Connectivity visibility requires an exact 1D, 2D, or 3D dimension.'
      );
    }
    // The view's published transparency already carries every filter,
    // the outlier filter included, for the live view and snapshots alike.
    const transparency = viewer.getViewTransparency(viewId);

    if (
      !(transparency instanceof Uint8Array) ||
      getGraphSummary() === null ||
      transparency.length !== getGraphSummary().n_cells
    ) {
      throw new TypeError(
        'Connectivity filtering requires one exact Uint8 visibility ' +
        'value per cell.'
      );
    }

    const pointCount = transparency.length;
    const lodMembership = requireLodMembership(
      viewer.getCurrentLodMembership(viewId, dimensionLevel),
      { pointCount, dimensionLevel, owner: 'Connectivity level of detail' }
    );

    return Object.freeze({
      transparency,
      lodMembership,
      pointCount
    });
  }

  // Format edge count for display (compact): `formatCompactCount` (250K, 1.5M).
  function formatEdgeCount(n) {
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new TypeError(
        'Connectivity edge counts must be non-negative safe integers.'
      );
    }
    return formatNumber(n);
  }

  // Track current state - user's preference, NOT auto-adjusted by visibility changes
  // The number of edges the person asked to see, or null until they move
  // the slider. The default is applied against the graph's edge count
  // when it is used, not when the dataset is published: a graph read
  // from a file has no count until its edges are read, and a default
  // fixed at publication would be min(default, 0) -- edges on, none shown.
  let userEdgeLimit = null;
  const currentEdgeLimit = () => Math.min(
    userEdgeLimit ?? CONNECTIVITY_DEFAULT_VISIBLE_TARGET,
    getTotalEdges()
  );
  /**
   * Set the person's edge preference (null: the default), and what a
   * session records of the slider (`data-session-preference`,
   * `state-serializer/ui-controls.js`): the preference, not the value the
   * slider shows, whose range follows the visible edges of a graph that
   * may not be read yet.
   */
  function setUserEdgeLimit(limit) {
    userEdgeLimit = limit;
    if (connectivityLimitInput) {
      connectivityLimitInput.dataset.sessionPreference = String(limit ?? CONNECTIVITY_DEFAULT_VISIBLE_TARGET);
    }
  }

  /**
   * Update slider range based on visible edges.
   * - Slider max = visible edges (dynamic)
   * - User's preference (currentEdgeLimit()) stays stable
   * - Slider value = min(preference, visible) to show what's achievable
   */
  function updateSliderRange(visibleEdges) {
    if (!connectivityLimitInput) return;
    const maxEdges = visibleEdges;
    if (maxEdges === 0) {
      connectivityLimitInput.max = 0;
      connectivityLimitInput.min = 0;
      connectivityLimitInput.value = 0;
      // The readout is the preference within the graph, as everywhere
      // (`defineControlReadout` above); the info line says none is shown.
      if (connectivityLimitDisplay) {
        connectivityLimitDisplay.textContent = formatEdgeCount(currentEdgeLimit());
      }
      return;
    }
    const minVal = Math.min(
      maxEdges,
      clamp(Math.round(maxEdges * 0.01), 100, 1000)
    );

    connectivityLimitInput.max = maxEdges;
    connectivityLimitInput.min = minVal;

    // Slider shows achievable value, but preference stays unchanged
    const achievable = Math.min(currentEdgeLimit(), maxEdges);
    connectivityLimitInput.value = Math.max(minVal, achievable);

    if (connectivityLimitDisplay) {
      connectivityLimitDisplay.textContent = formatEdgeCount(currentEdgeLimit());
    }
  }

  /**
   * Update the connectivity info display with edge statistics.
   * Shows total, visible (after filters), and shown (after LOD limit) edge counts.
   */
  function updateConnectivityInfo(visibleEdges, shownEdges) {
    if (!connectivityInfo) return;
    connectivityInfo.textContent = `${formatEdgeCount(getTotalEdges())} total · ${formatEdgeCount(visibleEdges)} visible · ${formatEdgeCount(shownEdges)} shown`;
  }

  /**
   * What the shown graph holds on the page: its forward adjacency, and
   * what showing K of its edges keeps (the shown-order prefix, the
   * selection's buffers, each pane's records), all of it the working set
   * while edges are shown or the k-NN tool uses the graph.
   */
  function connectivityWorkingBytes(edgeData) {
    const memory = viewer.getConnectivityMemoryStats();
    let bytes = memory.graphBytes + memory.selectionBytes;
    for (const pane of memory.panes) bytes += pane.cpuBytes;
    return Math.max(bytes, typedArrayBytes(edgeData));
  }

  /**
   * Apply the current edge limit to the viewer.
   * Uses accurate LOD calculation based on actual visible edges.
   *
   * Edge visibility is based on BOTH filter state AND point LOD.
   * Only edges where both endpoints pass filters AND are visible at current LOD are shown.
   */
  function applyEdgeLodLimit() {
    const activeViewId = state.getActiveViewId();
    // One stable user target: every pane shows the first
    // `currentEdgeLimit()` of its own visible edges.
    viewer.setEdgeVisibleTarget(currentEdgeLimit());
    if (loadedEdgeData !== null) {
      setWorkingSet('graph', connectivityWorkingBytes(loadedEdgeData), loadedEdgeData);
    }
    const acceptedStats =
      viewer.getEdgeSelectionStatsForView(activeViewId);
    if (acceptedStats === null || acceptedStats.current !== true) {
      throw new Error(
        `Connectivity target publication for view "${activeViewId}" was incomplete.`
      );
    }
    updateConnectivityInfo(
      actualVisibleEdges,
      acceptedStats.shownCount
    );
  }

  // A pane's visible-edge count lands after its selection (it is one
  // pass over the graph, run in slices); the active pane's count sets the
  // slider's range when it does.
  viewer.onConnectivityVisibleCount((viewId, stats) => {
    if (
      !edgesLoaded ||
      viewId !== state.getActiveViewId() ||
      stats.visibleCount === null
    ) {
      return;
    }
    activeConnectivityStatsViewId = viewId;
    actualVisibleEdges = stats.visibleCount;
    updateSliderRange(actualVisibleEdges);
    updateConnectivityInfo(actualVisibleEdges, stats.shownCount);
  });

  // Initial slider setup and info display
  updateSliderRange(actualVisibleEdges);
  updateConnectivityInfo(actualVisibleEdges, Math.min(currentEdgeLimit(), actualVisibleEdges));

  // Edge loading state
  let edgesLoaded = false;
  // Bumped whenever the data mapping replaces the graph in use, so a KNN
  // load started on the previous graph is never published.
  let connectivityGraphGeneration = 0;
  let loadedEdgeData = null;
  let edgeLoadOwner = null;
  /** How many neighbor-graph reads began: each one's read key. */
  let connectivityReadCount = 0;
  let connectivityToggleGeneration = 0;
  let knnLoadPromise = null;
  // The graph in use was read and checked once (its edges built: bounds,
  // order, exact symmetry): `{generation, nCells, nEdges}`, kept after
  // its edges are let go, so the k-NN tool, which reads rows from the
  // file, never holds them (null until then, and for a replaced graph).
  let checkedConnectivity = null;

  function createConnectivitySupersededError() {
    return cancelled('superseded',
      'Connectivity edge loading was superseded by a newer dataset generation.'
    );
  }

  function abortConnectivityLoad() {
    if (edgeLoadOwner === null) {
      return;
    }
    const owner = edgeLoadOwner;
    edgeLoadOwner = null;
    owner.controller.abort(createConnectivitySupersededError());
  }

  function captureConnectivityLoadOwner() {
    if (getGraphSummary() === null) {
      throw new Error(
        'Connectivity edge loading requires a published neighbor graph.'
      );
    }

    const sourceType = dataSourceManager.getCurrentSourceType();
    const datasetId = dataSourceManager.getCurrentDatasetId();
    const identityId = dataSourceManager.getCurrentIdentityId();
    const managerBaseUrl = dataSourceManager.getCurrentBaseUrl();
    if (
      getPublicationGeneration() === 0 ||
      sourceType === null ||
      datasetId === null ||
      identityId === null ||
      managerBaseUrl !== getDatasetBaseUrl()
    ) {
      throw createConnectivitySupersededError();
    }

    return {
      controller: new AbortController(),
      publicationGeneration: getPublicationGeneration(),
      summary: getGraphSummary(),
      url: getGraphUrl(),
      datasetBaseUrl: getDatasetBaseUrl(),
      sourceType,
      datasetId,
      identityId,
      managerBaseUrl,
      localSelectionIdentity: userSource.getSelectionIdentity(),
      localAdoptionIdentity: userSource.getAdoptionIdentity(),
      promise: null
    };
  }

  function assertCurrentConnectivityLoadOwner(owner) {
    if (
      owner !== edgeLoadOwner ||
      owner.controller.signal.aborted ||
      owner.publicationGeneration !== getPublicationGeneration() ||
      owner.summary !== getGraphSummary() ||
      owner.url !== getGraphUrl() ||
      owner.datasetBaseUrl !== getDatasetBaseUrl() ||
      owner.sourceType !== dataSourceManager.getCurrentSourceType() ||
      owner.datasetId !== dataSourceManager.getCurrentDatasetId() ||
      owner.identityId !== dataSourceManager.getCurrentIdentityId() ||
      owner.managerBaseUrl !== dataSourceManager.getCurrentBaseUrl() ||
      owner.localSelectionIdentity !== userSource.getSelectionIdentity() ||
      owner.localAdoptionIdentity !== userSource.getAdoptionIdentity()
    ) {
      throw createConnectivitySupersededError();
    }
  }

  function prepareDatasetReplacement() {
    const errors = [];
    for (const cleanup of [
      () => viewer.setShowConnectivity(false),
      () => viewer.clearEdgesV2(),
      () => viewer.clearKnnEdges(),
      () => abortConnectivityLoad()
    ]) {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    connectivityToggleGeneration++;
    knnLoadPromise = null;
    checkedConnectivity = null;
    edgesLoaded = false;
    loadedEdgeData = null;
    setWorkingSet('graph', 0);
    publishedEdgeCount = null;
    activeConnectivityStatsViewId = null;
    actualVisibleEdges = 0;
    setUserEdgeLimit(null);
    stopLodTracking();
    if (edgeVisibilityThrottleTimer !== null) {
      clearTimeout(edgeVisibilityThrottleTimer);
      edgeVisibilityThrottleTimer = null;
    }
    edgeVisibilityPending = false;
    if (errors.length > 0) {
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(
            errors,
            'Connectivity dataset cleanup failed.'
          );
    }
  }

  function synchronizeDatasetPublication() {
    actualVisibleEdges = getTotalEdges();
    setUserEdgeLimit(null);
    if (connectivityCheckbox) {
      connectivityCheckbox.checked = false;
      setControlAvailability(connectivityCheckbox, null);
    }
    if (connectivitySliders) {
      connectivitySliders.hidden = true;
    }
    updateSliderRange(actualVisibleEdges);
    updateConnectivityInfo(actualVisibleEdges, Math.min(currentEdgeLimit(), actualVisibleEdges));
    if (connectivityControls) {
      connectivityControls.hidden = getGraphSummary() === null;
    }
  }

  function publishConnectivityEdges(owner, edgeData) {
    assertCurrentConnectivityLoadOwner(owner);
    publishedEdgeCount = edgeData.nEdges;
    // The viewer keeps the payload's arrays as they are (the shown order
    // is computed, not stored): endpoints, strengths and, for the k-NN
    // tool, the adjacency the reader worker built.
    if (
      viewer.setupEdgesV2(
        edgeData
      ) !== true
    ) {
      throw new Error(
        'The viewer rejected an exact connectivity edge payload.'
      );
    }

    const existingSnapshots = viewer.getSnapshotViews();
    for (const snapshot of existingSnapshots) {
      if (
        viewer.setupEdgesV2ForView(snapshot.id) !== true
      ) {
        throw new Error(
          `The viewer rejected connectivity positions for view "${snapshot.id}".`
        );
      }
    }

    const activeViewId = state.getActiveViewId();
    const liveVisibility = getConnectivityVisibilityOwner(
      'live',
      viewer.getViewDimension('live')
    );
    if (
      viewer.updateEdgeVisibilityV2FromLod(
        liveVisibility.transparency,
        liveVisibility.lodMembership
      ) !== true
    ) {
      throw new Error(
        'The viewer rejected live connectivity visibility.'
      );
    }
    const liveStats = viewer.refreshEdgeSelectionForView('live');
    let activeStats =
      activeViewId === 'live' ? liveStats : null;
    for (const snapshot of existingSnapshots) {
      const snapshotDimension = viewer.getViewDimension(
        snapshot.id
      );
      const snapshotVisibility = getConnectivityVisibilityOwner(
        snapshot.id,
        snapshotDimension
      );
      if (
        viewer.updateEdgeVisibilityV2ForViewFromLod(
          snapshot.id,
          snapshotVisibility.transparency,
          snapshotVisibility.lodMembership
        ) !== true
      ) {
        throw new Error(
          `The viewer rejected connectivity visibility for view ` +
          `"${snapshot.id}".`
        );
      }
      const snapshotStats =
        viewer.refreshEdgeSelectionForView(snapshot.id);
      if (snapshot.id === activeViewId) {
        activeStats = snapshotStats;
      }
    }
    if (activeStats === null || activeStats.current !== true) {
      throw new Error(
        `Connectivity publication cannot resolve active view ` +
        `"${activeViewId}".`
      );
    }
    activeConnectivityStatsViewId = activeViewId;
    // The count may still be running; it lands through
    // onConnectivityVisibleCount.
    actualVisibleEdges = activeStats.visibleCount ?? actualVisibleEdges;
    updateSliderRange(actualVisibleEdges);
    applyEdgeLodLimit();

    // The lifecycle and k-NN owner is the payload itself (no copy). While
    // edges are shown or the k-NN tool uses it, it is drawn: counted in
    // the working set, never as a cached copy (`memory-budget.js`).
    const publishedEdgeData = edgeData;
    loadedEdgeData = publishedEdgeData;
    recordConnectivityCheck(edgeData);
    setWorkingSet('graph', connectivityWorkingBytes(edgeData), edgeData);
    edgesLoaded = true;
    onEdgesShown(edgeData.nEdges);
    debug.log(
      `[Main] Connectivity generation published: ` +
      `${formatCountOf(edgeData.nEdges, 'edge')}, ${formatCountOf(edgeData.nCells, 'cell')}, ` +
      `${actualVisibleEdges} visible.`
    );
    return publishedEdgeData;
  }

  /** The graph in use was read and checked: what the k-NN tool needs of it. */
  function recordConnectivityCheck(edgeData) {
    checkedConnectivity = Object.freeze({
      generation: `${getPublicationGeneration()}:${connectivityGraphGeneration}`,
      nCells: edgeData.nCells,
      nEdges: edgeData.nEdges,
    });
  }

  /**
   * The k-NN tool's rows of a checked graph (`KnnRowSource.readRows`):
   * from the file by row (`loadConnectivityRows`, the reader worker), or,
   * while the page holds the graph's edges (shown in a view), from them
   * (`forwardEdgeRows`: two passes over every edge) when that is
   * cheaper. Each way is priced by its rate measured here (milliseconds
   * a row from the file, edges a millisecond of a pass), the passes
   * before their first by `KNN_SCAN_EDGES_PER_MS`; the file's first
   * rows (the seed's) are always read, so a pass is never chosen
   * against an unmeasured file.
   */
  function knnRowReader(rowsUrl, check) {
    let fileMsPerRow = null;
    let scanEdgesPerMs = KNN_SCAN_EDGES_PER_MS;
    return async (cells, { signal }) => {
      const held = loadedEdgeData;
      const current = currentConnectivityCheck();
      const usable = held !== null && current !== null && current.generation === check.generation &&
        held.nCells === check.nCells && held.nEdges === check.nEdges;
      if (usable && fileMsPerRow !== null && held.nEdges / scanEdgesPerMs < cells.length * fileMsPerRow) {
        const started = performance.now();
        const rows = await forwardEdgeRows(held, cells, { signal });
        scanEdgesPerMs = held.nEdges / Math.max(1, performance.now() - started);
        return rows;
      }
      const started = performance.now();
      const rows = await loadConnectivityRows(rowsUrl, cells, { signal });
      if (cells.length > 0) fileMsPerRow = (performance.now() - started) / cells.length;
      return rows;
    };
  }

  function currentConnectivityCheck() {
    return checkedConnectivity !== null &&
      checkedConnectivity.generation === `${getPublicationGeneration()}:${connectivityGraphGeneration}`
      ? checkedConnectivity
      : null;
  }

  /**
   * Let the shown edges go. The k-NN tool keeps its graph: it reads rows
   * from the file, and the graph stays checked until it is replaced
   * (`prepareDatasetReplacement`).
   */
  function clearPublishedConnectivityEdges() {
    viewer.setShowConnectivity(false);
    viewer.clearEdgesV2();
    edgesLoaded = false;
    loadedEdgeData = null;
    setWorkingSet('graph', 0);
    publishedEdgeCount = currentConnectivityCheck()?.nEdges ?? null;
    activeConnectivityStatsViewId = null;
    actualVisibleEdges = getTotalEdges();
    setUserEdgeLimit(null);
    stopLodTracking();
    if (edgeVisibilityThrottleTimer !== null) {
      clearTimeout(edgeVisibilityThrottleTimer);
      edgeVisibilityThrottleTimer = null;
    }
    edgeVisibilityPending = false;
    updateSliderRange(actualVisibleEdges);
    updateConnectivityInfo(
      actualVisibleEdges,
      Math.min(currentEdgeLimit(), actualVisibleEdges)
    );
  }

  function ensureConnectivityEdgesLoaded() {
    if (edgesLoaded) {
      if (loadedEdgeData === null) {
        throw new Error(
          'Connectivity edge state is loaded without its exact payload.'
        );
      }
      return Promise.resolve(loadedEdgeData);
    }
    if (edgeLoadOwner !== null) {
      return edgeLoadOwner.promise;
    }

    const owner = captureConnectivityLoadOwner();
    edgeLoadOwner = owner;
    let rendererPublicationStarted = false;
    // One read, one notice: whoever waits for the graph (KNN
    // drag, Show connectivity edges, both at once) sees this card, which
    // shows the read's progress itself; the read is told under its key,
    // so no read card of its own appears beside it.
    const readKey = `neighbor-graph-read-${++connectivityReadCount}`;
    const notice = notifications.loading('Reading the neighbor graph', { category: 'connectivity' });
    getReadActivityLog().adopt(readKey, `connectivity-notification-${notice}`);
    const stopNoticeProgress = getReadActivityLog().subscribe(activity => {
      if (activity.status !== 'running' || !activity.keys?.includes(readKey) || !notifications.hasNotification(notice)) return;
      const read = activity.bytesTotal > 0 && activity.bytesTotal > activity.bytesFetched
        ? `${formatBytes(activity.bytesFetched)} of ${formatBytes(activity.bytesTotal)}`
        : activity.bytesFetched > 0 ? `${formatBytes(activity.bytesFetched)} read` : null;
      const said = activity.waiting?.text ?? read;
      notifications.loading(said === null ? 'Reading the neighbor graph' : `Reading the neighbor graph · ${said}`, { id: notice, category: 'connectivity' });
    });
    owner.promise = (async () => {
      try {
        const edgeData = await loadEdges(
          owner.url,
          owner.summary,
          { signal: owner.controller.signal, readKey }
        );
        assertCurrentConnectivityLoadOwner(owner);
        rendererPublicationStarted = true;
        const published = publishConnectivityEdges(owner, edgeData);
        stopNoticeProgress();
        notifications.complete(notice, `Neighbor graph read: ${formatCountOf(edgeData.nEdges, 'edge')}`);
        return published;
      } catch (error) {
        stopNoticeProgress();
        if (owner.controller.signal.aborted || isCancellation(error)) {
          notifications.dismiss(notice);
          throw owner.controller.signal.aborted ? createConnectivitySupersededError() : error;
        }
        // Said once, here, for every request that waited for it.
        notifications.fail(
          notice,
          error?.code === DataSourceErrorCode.TOO_LARGE || error instanceof RangeError
            ? 'The neighbor graph needs more memory than this browser could allocate; the dataset stays loaded without it'
            : `${joinFailure('The neighbor graph could not be read', sayFailure(error))}`
        );
        if (owner.controller.signal.aborted) {
          throw createConnectivitySupersededError();
        }
        assertCurrentConnectivityLoadOwner(owner);
        if (
          rendererPublicationStarted &&
          edgeLoadOwner === owner
        ) {
          edgeLoadOwner = null;
          clearPublishedConnectivityEdges();
        }
        throw error;
      } finally {
        if (edgeLoadOwner === owner) {
          edgeLoadOwner = null;
        }
      }
    })();
    Object.freeze(owner);
    return owner.promise;
  }

  if (connectivityCheckbox) {
    connectivityCheckbox.addEventListener('change', async () => {
      const show = connectivityCheckbox.checked;
      const toggleGeneration = ++connectivityToggleGeneration;

      // Check if a neighbor graph is available
      if (getGraphSummary() === null) {
        console.warn('[Main] Connectivity checkbox toggled but no neighbor graph available');
        connectivityCheckbox.checked = false;
        return;
      }

      // Load edge data on first toggle (or after the graph was replaced)
      if (show && !edgesLoaded) {
        // The read's own card says how it goes and how it ended.
        try {
          debug.log('[Main] Loading GPU-optimized edges...');
          const edgeData = await ensureConnectivityEdgesLoaded();
          if (
            toggleGeneration !== connectivityToggleGeneration ||
            connectivityCheckbox.checked !== true ||
            edgesLoaded !== true ||
            loadedEdgeData !== edgeData
          ) {
            return;
          }

        } catch (err) {
          if (
            isCancellation(err) ||
            toggleGeneration !== connectivityToggleGeneration
          ) {
            return;
          }
          // Said on the read's card; a graph larger than the memory the
          // browser grants leaves the dataset loaded.
          console.error('Failed to load connectivity data:', err);
          connectivityCheckbox.checked = false;
          return;
        }
      } else if (show && edgesLoaded) {
        // Already loaded - just update combined visibility for all views
        try {
          updateEdgeVisibilityCore();
        } catch (error) {
          console.error(
            'Failed to refresh connectivity visibility:',
            error
          );
          connectivityCheckbox.checked = false;
          viewer.setShowConnectivity(false);
          if (connectivitySliders) {
            connectivitySliders.hidden = true;
          }
          stopLodTracking();
          notifications.error(
            'Connectivity could not be enabled because GPU visibility upload failed.',
            { category: 'connectivity' }
          );
          return;
        }
      }

      viewer.setShowConnectivity(show);
      if (connectivitySliders) {
        connectivitySliders.hidden = !show;
      }

      // Start/stop LOD tracking based on visibility
      if (show && edgesLoaded) {
        startLodTracking();
      } else {
        stopLodTracking();
        // Edges off: their arrays go (the k-NN tool reads the file).
        releaseUnusedConnectivityEdges();
      }
    }, { signal: applicationSignal });
  }

  /**
   * Let the neighbor graph's edges go once no view shows them: what the
   * viewer built from them, and this page's hold. The k-NN tool never
   * needs them (it reads rows from the file). The reader's adapter may
   * keep a copy within its cache budget; showing the edges again reads
   * it from there, or from the file.
   */
  function releaseUnusedConnectivityEdges() {
    if (!edgesLoaded || connectivityCheckbox?.checked === true) return;
    clearPublishedConnectivityEdges();
  }
  viewer.setKnnEdgeReleaseCallback(() => releaseUnusedConnectivityEdges());
  viewer.setKnnFailureCallback(() => {
    notifications.warning(
      'KNN selection stopped: the neighbor graph could not be read',
      { category: 'connectivity' }
    );
  });

  function updateEdgeVisibilityForView(
    viewId,
    publishActive = true
  ) {
    if (!edgesLoaded) return;
    const visibility = getConnectivityVisibilityOwner(
      viewId,
      viewer.getViewDimension(viewId)
    );
    if (viewId === 'live') {
      if (
        viewer.updateEdgeVisibilityV2FromLod(
          visibility.transparency,
          visibility.lodMembership
        ) !== true
      ) {
        throw new Error(
          'The viewer rejected live connectivity visibility.'
        );
      }
    } else if (
      viewer.updateEdgeVisibilityV2ForViewFromLod(
        viewId,
        visibility.transparency,
        visibility.lodMembership
      ) !== true
    ) {
      throw new Error(
        `The viewer rejected connectivity visibility for view ` +
        `"${viewId}".`
      );
    }
    const stats = viewer.refreshEdgeSelectionForView(viewId);
    if (publishActive) {
      publishActiveConnectivityCounts(viewId, stats);
    }
    return stats;
  }

  function publishActiveConnectivityCounts(viewId, stats) {
    if (viewId !== state.getActiveViewId()) return;
    if (
      stats === null ||
      stats.current !== true ||
      stats.viewId !== viewId
    ) {
      throw new Error(
        `Connectivity UI requires current edge statistics for view "${viewId}".`
      );
    }
    activeConnectivityStatsViewId = viewId;
    actualVisibleEdges = stats.visibleCount ?? actualVisibleEdges;
    updateSliderRange(actualVisibleEdges);
    if (connectivityCheckbox?.checked) {
      applyEdgeLodLimit();
    }
  }

  function updateActiveConnectivityCounts() {
    if (!edgesLoaded) return;
    const activeViewId = state.getActiveViewId();
    const stats = viewer.refreshEdgeSelectionForView(activeViewId);
    publishActiveConnectivityCounts(
      activeViewId,
      stats
    );
  }

  /**
   * Update edge visibility with combined filter + LOD visibility.
   * Re-enabling connectivity may follow hidden LOD changes in any pane, so
   * that lifecycle refreshes every exact texture. Ordinary filter
   * publications are already synchronized directly by the viewer and only
   * need the active view's edge prefix/count below.
   */
  function updateEdgeVisibilityCore() {
    if (!edgesLoaded) return;
    const activeViewId = state.getActiveViewId();
    let activeStats = null;
    const liveStats = updateEdgeVisibilityForView('live', false);
    if (activeViewId === 'live') activeStats = liveStats;
    for (const snapshot of viewer.getSnapshotViews()) {
      const snapshotStats =
        updateEdgeVisibilityForView(snapshot.id, false);
      if (snapshot.id === activeViewId) {
        activeStats = snapshotStats;
      }
    }
    if (activeStats === null) {
      throw new Error(
        `Connectivity refresh cannot resolve active view "${activeViewId}".`
      );
    }
    publishActiveConnectivityCounts(activeViewId, activeStats);
  }

  // Throttled active-view edge counting: executes immediately, then
  // ignores calls for 32ms with a trailing call if any were skipped.
  let edgeVisibilityThrottleTimer = null;
  let edgeVisibilityPending = false;
  function updateEdgeVisibility() {
    if (edgeVisibilityThrottleTimer) {
      // Already throttling, mark pending for trailing execution
      edgeVisibilityPending = true;
      return;
    }
    // Execute immediately
    updateActiveConnectivityCounts();
    // Start throttle period
    edgeVisibilityThrottleTimer = setTimeout(() => {
      edgeVisibilityThrottleTimer = null;
      if (edgeVisibilityPending) {
        edgeVisibilityPending = false;
        updateActiveConnectivityCounts();
      }
    }, 32); // ~2 frames at 60fps
  }

  // Point transparency publication has already updated the active view's
  // connectivity texture transactionally inside the viewer. Recompute only
  // the edge-prefix/UI owner here, avoiding a duplicate point-count scan
  // and upload attempt on every slider event.
  const onVisibilityChange = () => {
    if (
      edgesLoaded &&
      activeConnectivityStatsViewId !== state.getActiveViewId()
    ) {
      // Active-view switches are synchronous state transitions. Publish
      // their exact prefix immediately so a slider event can never consume
      // the prior view's edge count during the throttle window.
      updateActiveConnectivityCounts();
      return;
    }
    updateEdgeVisibility();
  };

  // LOD publications occur inside the render stack. Defer connectivity
  // texture work until that stack has restored its GL baseline, and retain
  // exact per-view ownership instead of polling only the active view.
  let lodTrackingActive = false;
  let lodVisibilityTimer = null;
  const pendingLodViewIds = new Set();
  const lodVisibilityRetryCounts = new Map();
  const MAX_LOD_VISIBILITY_RETRIES = 2;
  function startLodTracking() {
    lodTrackingActive = true;
  }

  function stopLodTracking() {
    lodTrackingActive = false;
    pendingLodViewIds.clear();
    lodVisibilityRetryCounts.clear();
    if (lodVisibilityTimer !== null) {
      clearTimeout(lodVisibilityTimer);
      lodVisibilityTimer = null;
    }
  }
  // The application's teardown ends both timers: a count they publish
  // after it would ask a viewer that is gone.
  onAbort(applicationSignal, () => {
    if (edgeVisibilityThrottleTimer !== null) {
      clearTimeout(edgeVisibilityThrottleTimer);
      edgeVisibilityThrottleTimer = null;
    }
    stopLodTracking();
  });

  function scheduleLodVisibilityRefresh(delayMs = 0) {
    if (
      !lodTrackingActive ||
      lodVisibilityTimer !== null ||
      pendingLodViewIds.size === 0
    ) return;
    lodVisibilityTimer = setTimeout(() => {
      lodVisibilityTimer = null;
      const pendingViews = [...pendingLodViewIds];
      pendingLodViewIds.clear();
      const currentSnapshots = new Set(
        viewer.getSnapshotViews().map(snapshot => snapshot.id)
      );
      let terminalError = null;
      for (const viewId of pendingViews) {
        if (
          viewId !== 'live' &&
          !currentSnapshots.has(viewId)
        ) {
          lodVisibilityRetryCounts.delete(viewId);
          continue;
        }
        debug.log(
          `[Edges] LOD publication for ${viewId}; refreshing connectivity.`
        );
        try {
          updateEdgeVisibilityForView(viewId);
          lodVisibilityRetryCounts.delete(viewId);
        } catch (error) {
          const attempts =
            (lodVisibilityRetryCounts.get(viewId) ?? 0) + 1;
          lodVisibilityRetryCounts.set(viewId, attempts);
          if (
            attempts <= MAX_LOD_VISIBILITY_RETRIES &&
            lodTrackingActive &&
            edgesLoaded &&
            connectivityCheckbox?.checked
          ) {
            pendingLodViewIds.add(viewId);
          } else if (terminalError === null) {
            terminalError = error;
          }
        }
      }
      if (terminalError !== null) {
        console.error(
          'Connectivity LOD visibility refresh failed:',
          terminalError
        );
        connectivityCheckbox.checked = false;
        viewer.setShowConnectivity(false);
        if (connectivitySliders) {
          connectivitySliders.hidden = true;
        }
        stopLodTracking();
        notifications.error(
          'Connectivity was disabled after repeated GPU visibility upload failures.',
          { category: 'connectivity' }
        );
        return;
      }
      scheduleLodVisibilityRefresh(16);
    }, delayMs);
  }

  viewer.onLodChanged(event => {
    if (
      !lodTrackingActive ||
      !edgesLoaded ||
      !connectivityCheckbox?.checked
    ) return;
    pendingLodViewIds.add(event.viewId);
    scheduleLodVisibilityRefresh();
  });
  state.on('visibility:changed', onVisibilityChange);

  // Wire up color picker
  if (connectivityColorInput) {
    connectivityColorInput.addEventListener('input', () => {
      const [r, g, b] = bytesOfHex(connectivityColorInput.value);
      viewer.setConnectivityColor(r, g, b);
    }, { signal: applicationSignal });
  }

  // Wire up alpha slider (its readout also names a value of the past in
  // the history, `core/control-readout.js`)
  if (connectivityAlphaInput && connectivityAlphaDisplay) {
    const alphaReadout = defineControlReadout(connectivityAlphaInput, value => (parseFloat(value) / 100).toFixed(2));
    connectivityAlphaInput.addEventListener('input', () => {
      const alpha = parseFloat(connectivityAlphaInput.value) / 100;
      viewer.setConnectivityAlpha(alpha);
      connectivityAlphaDisplay.textContent = alphaReadout(connectivityAlphaInput.value);
    }, { signal: applicationSignal });
  }

  // Wire up width slider
  if (connectivityWidthInput && connectivityWidthDisplay) {
    const widthReadout = defineControlReadout(connectivityWidthInput, value => (parseFloat(value) / 10).toFixed(1));
    connectivityWidthInput.addEventListener('input', () => {
      const width = parseFloat(connectivityWidthInput.value) / 10;
      viewer.setConnectivityLineWidth(width);
      connectivityWidthDisplay.textContent = widthReadout(connectivityWidthInput.value);
    }, { signal: applicationSignal });
  }

  // A session's preference (`session-preference`, `ui-controls.js`): kept
  // whatever the graph shows now; the slider shows what it can of it
  // once the graph's edges are read.
  if (connectivityLimitInput && connectivityLimitDisplay) {
    connectivityLimitInput.addEventListener('session-preference', () => {
      const limit = Number(connectivityLimitInput.dataset.sessionPreference);
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new TypeError('A restored edge preference is a positive whole number of edges.');
      }
      setUserEdgeLimit(limit);
      connectivityLimitDisplay.textContent = formatEdgeCount(currentEdgeLimit());
      if (loadedEdgeData !== null) {
        updateSliderRange(actualVisibleEdges);
        applyEdgeLodLimit();
      }
    }, { signal: applicationSignal });
  }

  // Wire up limit slider (LOD control)
  if (connectivityLimitInput && connectivityLimitDisplay) {
    // The person's preference, as the readout shows it: within the edges
    // the graph has (0 while none is read; the line under it says how
    // many are shown).
    defineControlReadout(connectivityLimitInput, value => formatEdgeCount(Math.min(Number(value), getTotalEdges())));
    connectivityLimitInput.addEventListener('input', () => {
      const max = Number(connectivityLimitInput.max);
      const min = Number(connectivityLimitInput.min);
      const requested = Number(connectivityLimitInput.value);
      if (
        !Number.isSafeInteger(max) ||
        !Number.isSafeInteger(min) ||
        !Number.isSafeInteger(requested) ||
        min < 0 ||
        max < min ||
        requested < min ||
        requested > max
      ) {
        throw new TypeError(
          'Connectivity edge limit controls require exact integer bounds.'
        );
      }
      setUserEdgeLimit(clamp(requested, min, max));
      connectivityLimitInput.value = userEdgeLimit;
      connectivityLimitDisplay.textContent = formatEdgeCount(userEdgeLimit);

      // Apply LOD limit using accurate visible edge calculation
      applyEdgeLodLimit();
    }, { signal: applicationSignal });
  }

  // Whether a dataset has a neighbor graph changes only with its
  // publication or its data mapping, so it is worth saying exactly once
  // per graph. The renderer asks for KNN edges when the mode is entered
  // and again on every Alt+drag, so announcing the absence per call stacks
  // identical toasts over one unchanged fact. This records the publication
  // and graph generation the absence was announced for; the next
  // publication, or a mapping that changes the graph, arms the
  // announcement again, including when there is still no graph.
  let announcedMissingConnectivityGeneration = null;

  // Set up KNN edge load callback - triggers when KNN mode needs edges
  // This loads edges on-demand when user first tries to use KNN drag
  viewer.setKnnEdgeLoadCallback(() => {
    // No dataset: said as such, not as a dataset without a graph.
    if (!(state.pointCount > 0)) {
      notifications.info(noDatasetOpenTo('select cells by their neighbors'), { category: 'connectivity' });
      return;
    }
    if (getGraphSummary() === null) {
      const graphGeneration =
        `${getPublicationGeneration()}:${connectivityGraphGeneration}`;
      if (announcedMissingConnectivityGeneration !== graphGeneration) {
        announcedMissingConnectivityGeneration = graphGeneration;
        console.warn(
          '[Main] KNN mode requested but no neighbor graph available'
        );
        notifications.warning(
          'This dataset has no neighbor graph, so KNN drag cannot select by neighbors; use Proximity drag or Lasso.',
          { category: 'connectivity' }
        );
      }
      return;
    }
    if (viewer.isKnnEdgesLoaded()) {
      return;
    }
    if (knnLoadPromise !== null) {
      return;
    }

    const requestGeneration = getPublicationGeneration();
    const requestGraphGeneration = connectivityGraphGeneration;
    const rowsUrl = getGraphUrl();
    // The graph's read has its own card (`ensureConnectivityEdgesLoaded`):
    // one read, one notice, whoever asked for it.
    let readFailed = false;
    const operation = (async () => {
      try {
        debug.log('[Main] Checking the neighbor graph for KNN mode...');
        // The graph is read and checked once (its edges: bounds, order,
        // exact symmetry; `publishConnectivityEdges` records the check);
        // the tool then reads the rows it expands through from the file,
        // by cell, and holds no edge: the edges go again unless a view
        // shows them.
        let check = currentConnectivityCheck();
        if (check === null) {
          try {
            await ensureConnectivityEdgesLoaded();
          } catch (error) {
            readFailed = true;
            throw error;
          }
          releaseUnusedConnectivityEdges();
          check = currentConnectivityCheck();
        }
        if (
          check === null ||
          requestGeneration !== getPublicationGeneration() ||
          requestGraphGeneration !== connectivityGraphGeneration
        ) {
          return;
        }
        const rowSource = Object.freeze({
          nCells: check.nCells,
          readRows: knnRowReader(rowsUrl, check),
        });
        if (
          viewer.loadKnnEdges(rowSource) !== true
        ) {
          throw new Error(
            'The viewer rejected the KNN graph\'s row source.'
          );
        }
      } catch (err) {
        if (
          isCancellation(err) ||
          requestGeneration !== getPublicationGeneration() ||
          requestGraphGeneration !== connectivityGraphGeneration
        ) {
          return;
        }
        console.error('[Main] Failed to check the neighbor graph for KNN:', err);
        // A failed read is said on its card; what failed after it here.
        if (!readFailed) {
          notifications.error(`${joinFailure('KNN drag could not use the neighbor graph', sayFailure(err))}`, { category: 'connectivity' });
        }
      }
    })();
    knnLoadPromise = operation;
    operation.finally(() => {
      if (knnLoadPromise === operation) {
        knnLoadPromise = null;
      }
    });
  });

  /**
   * The neighbor graph in use: its summary (null for none), where it is
   * read from, and its edge count (a graph read straight from a file is
   * counted once its edges are read; null until then).
   */
  function getConnectivityGraph() {
    return Object.freeze({
      summary: getGraphSummary(),
      url: getGraphUrl(),
      edges: getGraphSummary() === null ? null : (getGraphSummary().n_edges ?? publishedEdgeCount)
    });
  }

  /**
   * Replace the neighbor graph in use, as one step of a data-mapping
   * transaction: the edges and the KNN tool's graph are released, the
   * new summary is published, and the edges are drawn again from the new
   * graph if they were shown. Applying the previous graph rolls it back.
   *
   * @param {{summary: Object|null, url: string|null}} graph
   */
  function replaceConnectivityGraph({ summary, url }) {
    if ((summary === null) !== (url === null)) {
      throw new TypeError(
        'A neighbor graph is a summary with its URL, or neither.'
      );
    }
    const wasShown = connectivityCheckbox?.checked === true;
    // The same dataset's graph read again: the person's Max edges stays
    // (a publication's reset of it is for another dataset).
    const preference = userEdgeLimit;
    prepareDatasetReplacement();
    setGraph(summary, url);
    connectivityGraphGeneration++;
    synchronizeDatasetPublication();
    setUserEdgeLimit(preference);
    updateSliderRange(actualVisibleEdges);
    if (wasShown && summary !== null && connectivityCheckbox) {
      connectivityCheckbox.checked = true;
      connectivityCheckbox.dispatchEvent(new Event('change'));
    }
  }

  /**
   * The graph shown goes, the person's choices stay (edges shown, Max
   * edges): the same dataset's graph is read again, on other cells
   * (`replaceConnectivityGraph`) or for cells changed in place. The
   * viewer drops its graph with the cells it was drawn on (`loadData`
   * clears the edge layer), so the open cells changing in place retire
   * it here in the same synchronous step (`app/open-cells-resize.js`):
   * kept "loaded" while the viewer had none, every visibility change of
   * the commit would refresh edges of no graph and throw, and the cells
   * would stay half changed.
   */
  function retireGraphKeepingChoices() {
    const preference = userEdgeLimit;
    prepareDatasetReplacement();
    setUserEdgeLimit(preference);
  }

  return Object.freeze({
    getConnectivityGraph,
    prepareDatasetReplacement,
    replaceConnectivityGraph,
    retireGraphKeepingChoices,
    synchronizeDatasetPublication
  });
}
