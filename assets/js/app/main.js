/**
 * @fileoverview Application entry point.
 *
 * Orchestrates:
 * - Dataset + data source selection (URL params, local AnnData files, sample and linked catalogs, remote/viewer host sources)
 * - Data loading (points, fields, connectivity)
 * - Initialization wiring (Viewer, DataState, UI coordinator, state serializer, analysis module)
 *
 * Performance note:
 * Keep per-frame and per-point work inside the viewer and state managers.
 * `main.js` should stay orchestration-only (no hot-path allocations).
 *
 * @module main
 */
import { createViewer } from '../rendering/viewer.js';
import { CONNECTIVITY_DEFAULT_VISIBLE_TARGET } from '../rendering/connectivity-edge-layer.js';
import { initSidebarLayout } from './ui/core/sidebar-layout.js';
import {
  MAX_SMOKE_GRID_SIZE
} from '../rendering/smoke-cloud/smoke-density-contract.js';
import { createDataState } from './state/index.js';
import {
  createStableTerminalDestroy,
  initUI
} from './ui/core/ui-coordinator.js';
import {
  createSessionSerializer
} from './session/index.js';
import {
  classifyAdvertisedDatasetStateRestoreError,
  restoreCurrentDatasetState
} from './session/catalog-default-session.js';
import {
  createDatasetRuntimeRetirementOwner,
  createLatestDatasetPublicationContinuationOwner,
  createLatestDatasetReloadCoordinator,
  handleDatasetReloadFailure,
  settlePublishedDatasetStateOutcome,
  settlePublishedDatasetUi,
  stageDatasetPositionPayload
} from './dataset-reload-outcome.js';
import { initDockableAccordions } from './dockable-accordions.js';
import { setDockableAccordions } from './dockable-accordions-registry.js';
import { getNotificationCenter } from './notification-center.js';
import { showReadProgress } from './read-progress-notifications.js';
import { showOpeningProgress } from './opening-progress-view.js';
import { showSourceSignIn } from './source-sign-in-view.js';
import { beginOpening } from '../data/opening-progress.js';
import {
  createObsFieldLoader,
  createVarFieldLoader,
  varLoaderMappingOf,
  loadEdges,
  loadDatasetGeneration,
  loadMappingCandidates,
  getEmbeddingsMetadata
} from '../data/data-loaders.js';
import {
  MAPPING_CANDIDATES_ROUTE,
  resolveAnnDataMapping
} from '../data/dataset-mapping.js';
import {
  createDimensionManager,
  createInMemoryDimensionManager
} from '../data/dimension-manager.js';
import { syntheticRepresentations } from './ui/modules/benchmark/representations.js';
import { describeOpeningFailure } from './ui/modules/dataset-connections.js';
import { createMappingLayoutProvider } from './state/managers/mapping-manager.js';
import { createVectorFieldManager, resolveVectorFields } from '../data/vector-field-manager.js';
import { createCandidateAnnDataBinding } from '../data/anndata-provider.js';
import {
  createDatasetReloadSupersededError,
  isDatasetReloadSupersededError
} from '../data/dataset-lifecycle-errors.js';
import { getDataSourceManager } from '../data/data-source-manager.js';
import { getTransferLog } from '../data/transfer-log.js';
import { getReadActivityLog } from '../data/read-activity-log.js';
import { sweepAbandonedIndexes } from '../data/column-store-placement.js';
import { sweepAbandonedTranscodes } from '../data/anndata/transcode/space.js';
import { createLocalUserDirDataSource } from '../data/local-user-source.js';
import { createRemoteDataSource } from '../data/remote-source.js';
import {
  createViewerHostBridgeDataSource,
  getViewerHostConfig
} from '../data/viewer-host-source.js';
import {
  createViewerHostCommandHandlers
} from './viewer-host-command-handler.js';
import {
  createViewerHostPointerDelivery
} from './viewer-host-pointer-delivery.js';
// benchmark module is lazy-loaded when needed
import {
  DataSourceError,
  DataSourceErrorCode,
  fetchCatalogFile,
  isExplainedFailure
} from '../data/data-source.js';
import { formatCompactCount as formatNumber } from './ui/components/display-format.js';
import { createComparisonModule } from './analysis/comparison-module.js';
import { ThemeManager } from '../utils/theme-manager.js';
import { debug } from '../utils/debug.js';
import { clamp } from './utils/number-utils.js';
import { getGitHubAuthSession } from './community-annotations/github-auth.js';
import {
  hideWelcomeModal,
  initKeyboardShortcuts,
  initWelcomeModal,
  isWelcomeModalVisible,
  showWelcomeModal
} from './ui/onboarding/index.js';
import { publishWebBuildVersion } from './ui/core/build-version.js';
import { retireDeferredControls } from './ui/core/deferred-control-readiness.js';
import { DATA_LOAD_METHODS } from './data-load-methods.js';
import { analytics } from './optional-analytics.js';
import {
  classifySameOriginHealthAdvertisement,
  resolveStartupUrlIntent,
  selectConnectedDatasetId,
  selectIntentDatasetId
} from './startup-url-intent.js';
import {
  normalizeStartupError,
  publishStartupFailure
} from './startup-failure.js';
import {
  STARTUP_STALL_CODE,
  createStartupPhaseOwner
} from './startup-phase.js';
import {
  prepareUrlForDatasetSelection,
  prepareUrlForDataSource
} from './url-state.js';
import { yieldToMacrotask } from '../utils/yield-macrotask.js';
import { PLACES } from './ui/place-names.js';
import { loadAppCode } from './app-code.js';
import { formatCountOf, countNoun } from '../utils/format-units.js';

// The whole static graph has loaded, linked and run: the code-load watch
// (ui/core/code-load-watch.js) reads an uncaught error before this mark as
// the graph failing to run.
document.documentElement.dataset.codeStarted = 'true';

debug.log('Starting…');

const BENCHMARK_GPU_ESTIMATE_BYTES_PER_POINT = 28;
const MEBIBYTE = 1024 * 1024;

function estimateBenchmarkGpuMemoryMB(pointCount) {
  return Number.isSafeInteger(pointCount) && pointCount >= 0
    ? (
      pointCount *
      BENCHMARK_GPU_ESTIMATE_BYTES_PER_POINT /
      MEBIBYTE
    )
    : null;
}

function formatBenchmarkGpuMemory(rendererStats, pointCount) {
  const exactGpuMemoryMB = rendererStats?.gpuMemoryMB;
  if (
    Number.isFinite(exactGpuMemoryMB) &&
    exactGpuMemoryMB >= 0
  ) {
    return `${exactGpuMemoryMB.toFixed(1)} MB`;
  }
  const estimatedGpuMemoryMB =
    estimateBenchmarkGpuMemoryMB(pointCount);
  return estimatedGpuMemoryMB === null
    ? 'Unavailable'
    : `~${estimatedGpuMemoryMB.toFixed(1)} MB (estimate)`;
}

// The base URL of the dataset shown (`anndata://<id>/`):
// the data loaders address its parts under it.
let DATASET_BASE_URL = '';

// The parts of a dataset, as the data loaders address them under its base.
function getObsUrl(baseUrl) { return `${baseUrl}obs`; }
function getGeneListUrl(baseUrl) { return `${baseUrl}var`; }
function getConnectivityUrl(baseUrl) { return `${baseUrl}obsp`; }

// Requested before anything else so it loads in parallel with startup. It is
// never awaited: calls made before it arrives are queued, so it never blocks
// or breaks startup.
void analytics.load();
// A closed or crashed tab's spilled gene-column index (OPFS) is removed now,
// not only when this tab first spills one of its own; so are the stores a
// closed tab read single-stream files into (R objects, MatrixMarket folders).
void sweepAbandonedIndexes();
void sweepAbandonedTranscodes();

(async function bootstrap() {
  let statsEl = null;
  let destroyApplication = null;
  // The opening of the startup dataset, shown from the first moment.
  let startupOpening = null;
  // Every startup await on the network runs through this owner: it publishes
  // `data-startup-phase` and bounds request/response steps with a deadline.
  const startup = createStartupPhaseOwner({
    root: document.documentElement
  });

  try {
    ThemeManager.init();
    publishWebBuildVersion();

    const urlParams = new URLSearchParams(window.location.search);
    const viewerHostConfig = getViewerHostConfig();
    const {
      remoteUrlParam,
      dataLinkParam,
      sourceParam,
      requestedDataset,
      isAnndataMode,
      inViewerHost,
      shouldShowWelcome
    } = resolveStartupUrlIntent(urlParams, viewerHostConfig);

    const canvas = document.getElementById('glcanvas');
    const labelLayer = document.getElementById('label-layer');
    const viewTitleLayer = document.getElementById('view-title-layer');
    statsEl = document.getElementById('stats');
    const themeSelect = document.getElementById('theme-select');
    const sidebar = document.getElementById('sidebar');
    const renderModeSelect = document.getElementById('render-mode');

    setDockableAccordions(initDockableAccordions({ sidebar }));

    // The notification center is created before the first yield below, so
    // it is on the page by DOMContentLoaded and whatever fails or reports
    // from here on has somewhere to be announced.
    const notifications = getNotificationCenter();
    notifications.init();

    // The renderer and benchmark controls are wired at the far end of this
    // bootstrap, past every await below. They are painted and offered long
    // before that, so they are taken out of service here and admitted at the
    // one point where their listeners exist.
    const admitDeferredControls = retireDeferredControls(document);

    if (themeSelect instanceof HTMLSelectElement) {
      themeSelect.value = ThemeManager.getTheme();
      themeSelect.addEventListener('change', () => {
        ThemeManager.setTheme(themeSelect.value);
      });
    }

    const sessionSection = document.getElementById('session-section');
    const sessionSummary = sessionSection?.querySelector(':scope > summary');
    if (
      !(sessionSection instanceof HTMLDetailsElement) ||
      !(sessionSummary instanceof HTMLElement)
    ) {
      throw new Error('Onboarding requires the Session panel and its heading.');
    }
    initWelcomeModal({
      // "Choose a dataset" leads to the data controls without choosing for
      // the user: the Session panel opens. The Sample dataset dropdown is
      // never focused or opened for them. A keyboard user's focus lands on the
      // panel heading, one Tab before its controls; a pointer user's stays
      // where the dialog leaves it, so nothing on the page is ringed.
      onExplore({ fromKeyboard }) {
        sessionSection.open = true;
        if (fromKeyboard) sessionSummary.focus();
      }
    });
    if (shouldShowWelcome) {
      showWelcomeModal();
    }
    // The startup work before the first network wait ran as one task of
    // ~90 ms (module evaluation, the WebGL programs, the interface). It
    // yields to the event loop between its stages, so the page paints and
    // answers input between them.
    await yieldToMacrotask();

    // Connectivity controls
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
    let ui = null;
    let sidebarLayout = null;
    let comparisonModule = null;
    // The owner of every dataset change (`createLatestDatasetReloadCoordinator`),
    // once it exists.
    let datasetReloadCoordinator = null;
    let applicationRetired = false;
    let stopPerfMonitoring = () => {};

    debug.log('[Main] Creating viewer...');
    // Antialiasing is not a construction argument. It is a live setting owned by
    // `render-controls.js`, which reads the stored preference, resolves it
    // against each dataset as that dataset is published — see
    // `ui/core/antialias-preference.js`.
    const viewer = createViewer({
      canvas,
      labelLayer,
      viewTitleLayer
    });
    debug.log('[Main] Viewer created successfully');
    await yieldToMacrotask();

    // Expose viewer globally for dev tools (benchmark, debugging)
    window._cellucidViewer = viewer;

    // Browser page closure is not guaranteed to run asynchronous cleanup, so
    // publish one terminal owner as soon as the viewer exists. It remains
    // valid while the later UI and analysis owners are adopted, and always
    // fences the render loop and releases WebGL synchronously before its
    // returned task waits for asynchronous child teardown.
    destroyApplication = createStableTerminalDestroy({
      closeAdmission: () => {
        applicationRetired = true;
        window.removeEventListener(
          'pagehide',
          retireApplicationOnPageHide
        );
      },
      getOperations: () => [
        // The dataset change in flight is stopped first, so the owners
        // below wait only for work that has been told to stop: a read that
        // never answers cannot hold the teardown.
        ...(datasetReloadCoordinator === null
          ? []
          : [() => datasetReloadCoordinator.retire()]),
        () => stopPerfMonitoring(),
        ...(comparisonModule === null
          ? []
          : [() => comparisonModule.destroy()]),
        ...(ui === null ? [] : [() => ui.destroy()]),
        ...(sidebarLayout === null ? [] : [() => sidebarLayout.destroy()]),
        () => viewer.dispose()
      ],
      failureMessage: 'Application teardown was incomplete.'
    });
    function retireApplicationOnPageHide(event) {
      if (event.persisted === true) return;
      void destroyApplication().catch(error => {
        console.error('[Main] Application teardown failed:', error);
      });
    }
    window._cellucidDispose = destroyApplication;
    window.addEventListener('pagehide', retireApplicationOnPageHide);

    // The sidebar toggle is painted with the first frame, and on a phone it is
    // the only way out of the full-screen menu, so it works from now on rather
    // than from the end of the first dataset load.
    sidebarLayout = initSidebarLayout({ documentOwner: document, viewer });

    const state = createDataState({ viewer, labelLayer });

    // A page left hidden for ten minutes gives back the positions and GPU
    // geometry of every representation no view shows; they load again when
    // shown.
    const HIDDEN_RELEASE_MS = 10 * 60 * 1000;
    let hiddenReleaseTimer = null;
    document.addEventListener('visibilitychange', () => {
      clearTimeout(hiddenReleaseTimer);
      hiddenReleaseTimer = null;
      if (document.visibilityState === 'hidden') {
        hiddenReleaseTimer = setTimeout(() => {
          state.dimensionManager?.releaseUnderPressure?.();
        }, HIDDEN_RELEASE_MS);
      }
    });
    debug.log('[Main] State created successfully');

    // Expose state globally for dev tools
    window._cellucidState = state;

    // benchmarkReporter will be created lazily when benchmark report is requested
    let benchmarkReporter = null;

    // Long reads of an AnnData file say how much is left while they run.
    showReadProgress({ notifications });
    // Every opening is shown from its first moment: over the empty viewer
    // while no dataset is shown, as a notification with Cancel otherwise.
    showOpeningProgress({ hasDataset: () => state.pointCount > 0, notifications });
    // A Google Drive or OneDrive file waiting on a sign-in says so, with its button.
    showSourceSignIn({ notifications });
    // The startup dataset is being opened from now on: the layers that
    // resolve and read it join this opening, which ends once its first view
    // is drawn (or startup chose none).
    startupOpening = beginOpening({
      title: dataLinkParam
        ?? (remoteUrlParam !== null ? `the datasets at ${remoteUrlParam}` : null)
        ?? (inViewerHost ? "the notebook's dataset" : null)
        ?? requestedDataset
        ?? 'the sample dataset',
      step: 'Starting Cellucid'
    });
    // Data the address names (`?data=`, `?remote=`, `?dataset=`) that does
    // not open leaves Cellucid running without it: the startup opening fails
    // over the empty viewer with one plain sentence, the failure's message
    // under Details, Try again, and Open without this link, which drops those
    // parameters from the address. Only a failure of the app itself is the
    // startup failure screen.
    let startupDataFailed = false;
    // The address parameters that name a startup dataset of each source.
    const STARTUP_LAUNCH_PARAMETERS = Object.freeze({
      link: ['data', 'dataset'],
      remote: ['remote', 'dataset'],
      'local-demo': ['sampleCatalog', 'dataset']
    });
    function failStartupData(error, summary, launchParameters) {
      startupDataFailed = true;
      console.error('[Main] The data the address names did not open:', error);
      // What the address asked for comes first; onboarding would cover it.
      if (isWelcomeModalVisible()) hideWelcomeModal();
      analytics.trackStartupFailure({ phase: startup.phase, error });
      const withoutLink = launchParameters.some(name => urlParams.has(name));
      // The reason itself is said; a refusal trying again cannot change
      // (a file without an embedding, a folder without datasets.json) leads
      // with opening Cellucid without the link.
      const { summary: said, settled } = describeOpeningFailure(summary, error, { withoutLink });
      const tryAgain = { label: 'Try again', run: () => window.location.reload() };
      const actions = [tryAgain];
      if (withoutLink) {
        const openWithout = {
          label: 'Open without this link',
          run: () => {
            const address = new URL(window.location.href);
            for (const name of launchParameters) address.searchParams.delete(name);
            window.history.replaceState(window.history.state, '', address);
          }
        };
        if (settled) actions.unshift(openWithout);
        else actions.push(openWithout);
      }
      startupOpening.fail(error, { summary: said, actions });
    }

    // Construct the optional GitHub annotation session inside the startup
    // boundary so storage/configuration failures cannot leave a blank page.
    const githubAuthSession = getGitHubAuthSession();
    try {
      const signInResult = await startup.step(
        'sign-in',
        'the GitHub sign-in exchange',
        () => githubAuthSession.completeSignInFromRedirect()
      );
      if (signInResult !== null) {
        notifications.success(
          `Signed in with GitHub as @${signInResult.user.login}.`,
          {
            category: 'annotation',
            duration: 2800
          }
        );
      }
    } catch (error) {
      if (!(error instanceof Error)) {
        throw new TypeError(
          'GitHub redirect completion rejected with a non-Error value.'
        );
      }
      console.error('[GitHubAuth] Redirect completion failed:', error);
      notifications.error(error.message, {
        category: 'annotation',
        duration: 8000
      });
    }

    // Initialize DataSourceManager
    const dataSourceManager = getDataSourceManager();
    datasetReloadCoordinator = createLatestDatasetReloadCoordinator(
      () => {
        const source = dataSourceManager.activeSource;
        if (source === null) {
          return {
            source: null,
            baseUrl: null,
            datasetId: null,
            selectionIdentity: null
          };
        }
        const sourceType = dataSourceManager.getCurrentSourceType();
        return {
          source,
          baseUrl: dataSourceManager.getCurrentBaseUrl(),
          datasetId: dataSourceManager.getCurrentDatasetId(),
          selectionIdentity: sourceType === 'local-user'
            ? source.getAdoptionIdentity()
            : null
        };
      }
    );
    // The one dataset startup opens. The catalog phase below only resolves
    // it; it is loaded once the interface and every control exist, through
    // the same dataset-change transaction as every later choice, so a choice
    // the user makes while it is still loading replaces it instead of being
    // discarded behind it. When two startup intents resolve, the later one is
    // the selection, exactly as successive switches would have left it.
    let startupSelection = null;
    function selectStartupDataset(sourceType, datasetId, loadMethod) {
      for (const [label, value] of [
        ['source type', sourceType],
        ['id', datasetId],
        ['load method', loadMethod]
      ]) {
        if (typeof value !== 'string' || value.length === 0) {
          throw new TypeError(
            `Startup dataset ${label} must be a non-empty string.`
          );
        }
      }
      startupSelection = Object.freeze({ datasetId, loadMethod, sourceType });
      debug.log(
        `[Main] Startup dataset selection: ${sourceType}/${datasetId}`
      );
    }
    analytics.init();
    const startPerfAnalytics = () => {
      analytics.startPerformance({ dataSourceManager });
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(startPerfAnalytics, { timeout: 2000 });
    } else {
      setTimeout(startPerfAnalytics, 1200);
    }

    // Helper functions for onboarding callbacks (defined early, used later)
    let toggleSidebarVisibility = null;
    let cycleRepresentation = null;
    let clearActivePageHighlights = null;
    let setNavigationMode = null;

    // Initialize keyboard shortcuts after exact startup onboarding policy is set.
    initKeyboardShortcuts({
      onToggleSidebar: () => {
        if (toggleSidebarVisibility) toggleSidebarVisibility();
      },
      onCycleRepresentation: (dim) => {
        if (cycleRepresentation) cycleRepresentation(dim);
      },
      onShowHelp: () => {
        const shortcutsSection = document.getElementById('shortcuts-section');
        if (shortcutsSection) {
          shortcutsSection.open = true;
          shortcutsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      },
      onClearHighlights: () => {
        if (clearActivePageHighlights) clearActivePageHighlights();
      },
      onSetNavigationMode: (mode) => {
        if (setNavigationMode) setNavigationMode(mode);
      }
    });

    // Always register the user directory source through browser-independent file inputs.
    const userSource = createLocalUserDirDataSource();
    dataSourceManager.registerSource('local-user', userSource);

    // Register remote server source
    const remoteSource = createRemoteDataSource();
    dataSourceManager.registerSource('remote', remoteSource);

    // Check if a viewer host (Python, Jupyter or R) opened this page
    let viewerHostSource = null;
    if (inViewerHost) {
      debug.log('[Main] Detected a viewer host, initializing the viewer channel...');
      viewerHostSource = createViewerHostBridgeDataSource(viewerHostConfig);
      dataSourceManager.registerSource('jupyter', viewerHostSource);

      const viewerHostInitialized = await startup.step(
        'health',
        "the viewer's host",
        () => viewerHostSource.initialize()
      );
      if (viewerHostInitialized !== true) {
        throw new Error(
          'Viewer host context must initialize one authenticated Python server'
        );
      }
      debug.log('[Main] viewer channel initialized successfully');

      if (viewerHostConfig === null) {
        throw new Error(
          'Initialized viewer host mode requires its authenticated configuration'
        );
      }

      // Freeze support: keep the last fully rendered view when Python stops.
      let viewerHostFrozen = false;
      let viewerHostPointerDelivery = null;
      let retireViewerHostPointerInputs = () => {};
      const reportViewerHostConsoleError = (...args) => {
        try {
          console.error(...args);
        } catch {
          // Terminal/error reporting is observational and cannot reopen input
          // or turn a listener path into a thrown failure.
        }
      };
      const freezeViewerHostView = () => {
        if (viewerHostFrozen) return false;
        // Publish the terminal fence before any fallible observer, renderer,
        // timer, or DOM work.
        viewerHostFrozen = true;
        const failures = [];
        const attempt = operation => {
          try {
            operation();
          } catch (error) {
            failures.push(error);
          }
        };
        attempt(() => retireViewerHostPointerInputs());
        attempt(() => viewerHostPointerDelivery?.freeze());
        attempt(() => viewer.pause());
        attempt(() => {
          let overlay = document.getElementById(
            'cellucid-viewer-host-freeze-overlay'
          );
          if (overlay === null) {
            overlay = document.createElement('div');
            overlay.id = 'cellucid-viewer-host-freeze-overlay';
            overlay.style.position = 'fixed';
            overlay.style.inset = '0';
            overlay.style.zIndex = '999999';
            overlay.style.pointerEvents = 'all';
            overlay.style.background = 'transparent';
            overlay.setAttribute('aria-hidden', 'true');
            document.body.appendChild(overlay);
          }
          overlay.style.display = 'block';
        });
        for (const failure of failures) {
          reportViewerHostConsoleError(
            '[Main] Viewer host freeze cleanup failed:',
            failure
          );
        }
        return true;
      };

      viewerHostSource.onMessage(message => {
        if (message.type === 'freeze') {
          freezeViewerHostView();
        }
      });

      // The viewer channel ends when the host stops this viewer (or stops
      // altogether), when the viewer was opened again in another page, or
      // when the host cannot be reached any more. The host closing the
      // channel is the signal; nothing is polled.
      viewerHostSource.onChannelEnd(end => {
        if (end.kind === 'closed') return;
        freezeViewerHostView();
        try {
          const replaced = end.kind === 'replaced';
          notifications[replaced ? 'info' : 'error'](end.message, {
            category: 'connectivity',
            title: replaced
              ? 'Viewer opened elsewhere'
              : end.kind === 'stopped'
                ? 'Viewer stopped'
                : 'Viewer disconnected',
            duration: 0
          });
        } catch (notificationError) {
          reportViewerHostConsoleError(
            '[Main] Viewer host disconnect notification failed:',
            notificationError
          );
        }
      });

      if (
        typeof viewer.pickCellRecordAtScreen !== 'function'
      ) {
        throw new TypeError(
          'Viewer host pointer hooks require exact per-view picking records'
        );
      }

      let lastHoverAt = 0;
      const HOVER_THROTTLE_MS = 50;
      const reportViewerHostPointerError = (error, channel) => {
        reportViewerHostConsoleError(
          `[Main] Viewer host ${channel} pointer delivery failed:`,
          error
        );
      };
      viewerHostPointerDelivery = createViewerHostPointerDelivery({
        notifyHover: (cellIndex, position) =>
          viewerHostSource.notifyHover(cellIndex, position),
        notifyClick: (cellIndex, modifiers) =>
          viewerHostSource.notifyClick(cellIndex, modifiers),
        reportError: reportViewerHostPointerError,
      });
      const retireViewerHostView = event => {
        if (event.persisted === true) return;
        window.removeEventListener('pagehide', retireViewerHostView);
        freezeViewerHostView();
      };
      window.addEventListener('pagehide', retireViewerHostView);

      let pendingHoverClientX = 0;
      let pendingHoverClientY = 0;
      let hasPendingHoverPoint = false;
      let hoverSampleTimer = null;
      const clearHoverSampleTimer = () => {
        if (hoverSampleTimer !== null) {
          clearTimeout(hoverSampleTimer);
          hoverSampleTimer = null;
        }
      };
      retireViewerHostPointerInputs = () => {
        hasPendingHoverPoint = false;
        clearHoverSampleTimer();
      };
      const sampleLatestViewerHostHover = () => {
        hoverSampleTimer = null;
        try {
          if (viewerHostFrozen || !hasPendingHoverPoint) return;
          const now = performance.now();
          const remaining =
            HOVER_THROTTLE_MS - (now - lastHoverAt);
          if (remaining > 0) {
            hoverSampleTimer = setTimeout(
              sampleLatestViewerHostHover,
              remaining
            );
            return;
          }
          const clientX = pendingHoverClientX;
          const clientY = pendingHoverClientY;
          hasPendingHoverPoint = false;
          lastHoverAt = now;

          const pickRecord = viewer.pickCellRecordAtScreen(
            clientX,
            clientY
          );
          if (
            pickRecord !== null &&
            (
              !Object.isFrozen(pickRecord) ||
              typeof pickRecord.viewId !== 'string' ||
              pickRecord.viewId.length === 0 ||
              !Number.isSafeInteger(pickRecord.cellIndex) ||
              pickRecord.cellIndex < 0 ||
              pickRecord.position === null ||
              typeof pickRecord.position !== 'object'
            )
          ) {
            throw new TypeError(
              'Viewer host cell picking must return null or one exact frozen per-view record'
            );
          }
          if (pickRecord !== null) {
            const activePosition = pickRecord.position;
            if (
              !Object.isFrozen(activePosition) ||
              !Number.isFinite(activePosition.x) ||
              !Number.isFinite(activePosition.y) ||
              !Number.isFinite(activePosition.z)
            ) {
              throw new TypeError(
                'Viewer host hover requires one complete finite XYZ position'
              );
            }
          }
          viewerHostPointerDelivery.requestHover(pickRecord);
        } catch (error) {
          reportViewerHostPointerError(error, 'hover');
        }
      };

      canvas.addEventListener('mousemove', event => {
        pendingHoverClientX = event.clientX;
        pendingHoverClientY = event.clientY;
        hasPendingHoverPoint = true;
        if (hoverSampleTimer === null) {
          sampleLatestViewerHostHover();
        }
      });

      canvas.addEventListener('mouseleave', () => {
        try {
          if (!viewerHostFrozen) {
            hasPendingHoverPoint = false;
            clearHoverSampleTimer();
            viewerHostPointerDelivery.requestHover(null);
          }
        } catch (error) {
          reportViewerHostPointerError(error, 'hover');
        }
      });

      canvas.addEventListener('click', event => {
        try {
          if (viewerHostFrozen) return;
          const pickRecord = viewer.pickCellRecordAtScreen(
            event.clientX,
            event.clientY
          );
          if (
            pickRecord !== null &&
            (
              !Object.isFrozen(pickRecord) ||
              typeof pickRecord.viewId !== 'string' ||
              pickRecord.viewId.length === 0 ||
              !Number.isSafeInteger(pickRecord.cellIndex) ||
              pickRecord.cellIndex < 0
            )
          ) {
            throw new TypeError(
              'Viewer host cell picking must return null or one exact frozen per-view record'
            );
          }
          if (pickRecord === null) return;
          viewerHostPointerDelivery.requestClick({
            cellIndex: pickRecord.cellIndex,
            button: event.button,
            shift: event.shiftKey,
            ctrl: event.ctrlKey || event.metaKey,
          });
        } catch (error) {
          reportViewerHostPointerError(error, 'click');
        }
      });

      const viewerHostDatasets = await startup.step(
        'catalog',
        "the viewer host's dataset",
        () => viewerHostSource.listDatasets()
      );
      const viewerHostDatasetId = selectIntentDatasetId(
        viewerHostDatasets,
        requestedDataset,
        "The viewer's host"
      );
      selectStartupDataset(
        'jupyter',
        viewerHostDatasetId,
        DATA_LOAD_METHODS.VIEWER_HOST_AUTO
      );
    }

    // An explicit remote URL: a server that cannot be reached, or that does
    // not hold the requested dataset, leaves Cellucid running without it.
    if (remoteUrlParam !== null) {
      debug.log(`[Main] Remote server URL from param: ${remoteUrlParam}`);
      try {
        await startup.step(
          'health',
          remoteUrlParam,
          () => remoteSource.connect({ url: remoteUrlParam })
        );
        if (remoteSource.isConnected() !== true) {
          throw new Error(
            'The requested remote source did not publish a connected state.'
          );
        }
        const remoteDatasets = await startup.step(
          'catalog',
          remoteUrlParam,
          () => remoteSource.listDatasets()
        );
        const remoteDatasetId = selectIntentDatasetId(
          remoteDatasets,
          requestedDataset,
          'The requested remote source'
        );
        selectStartupDataset(
          'remote',
          remoteDatasetId,
          DATA_LOAD_METHODS.REMOTE_URL_PARAM
        );
      } catch (error) {
        failStartupData(
          error,
          'Cellucid could not open the server this link points to.',
          ['remote', 'dataset']
        );
      }
    }

    // Auto-connect to a same-origin Cellucid server when the web app is being
    // served by the Python package itself (CLI/Python server mode).
    //
    // Without this, the app may auto-load the demo dataset and ignore the
    // server-hosted dataset, especially when a sample catalog is configured.
    if (
      !inViewerHost &&
      remoteUrlParam === null &&
      (sourceParam === null || sourceParam === 'remote')
    ) {
      const protocol = window.location.protocol;
      if (protocol !== 'http:' && protocol !== 'https:') {
        if (sourceParam === 'remote') {
          throw new Error(
            'Same-origin remote startup requires an HTTP(S) page.'
          );
        }
      } else {
        const selfBase = new URL('.', window.location.href)
          .toString()
          .replace(/\/$/, '');
        const healthUrl = `${selfBase}/_cellucid/health`;
        const healthResponse = await startup.step(
          'health',
          healthUrl,
          signal => fetch(healthUrl, { cache: 'no-store', signal })
        );
        if (
          healthResponse.status === 404 &&
          sourceParam === null &&
          !isAnndataMode
        ) {
          debug.log(
            '[Main] Current origin does not advertise a Cellucid server.'
          );
        } else {
          if (!healthResponse.ok) {
            throw new Error(
              `Same-origin Cellucid health request failed with HTTP ` +
              `${healthResponse.status}.`
            );
          }
          const healthAdvertisement = await startup.step(
            'health',
            healthUrl,
            () => healthResponse.json()
          );
          const healthKind = classifySameOriginHealthAdvertisement(
            healthAdvertisement
          );
          if (healthKind === 'static') {
            if (sourceParam === 'remote' || isAnndataMode) {
              throw new Error(
                'This origin is the static Cellucid viewer and does not provide the requested Python server source.'
              );
            }
            debug.log(
              '[Main] Current origin advertises the static Cellucid viewer.'
            );
          } else {
            debug.log(
              `[Main] Cellucid server endpoint detected at ${selfBase}; ` +
              'validating the complete remote contract.'
            );
            await startup.step(
              'health',
              selfBase,
              () => remoteSource.connect({ url: selfBase })
            );
            if (remoteSource.isConnected() !== true) {
              throw new Error(
                'Same-origin Cellucid source did not publish a connected state.'
              );
            }
            const datasets = await startup.step(
              'catalog',
              selfBase,
              () => remoteSource.listDatasets()
            );
            const remoteDatasetId = selectConnectedDatasetId(
              datasets,
              requestedDataset,
              'The same-origin Cellucid source'
            );
            if (remoteDatasetId === null) {
              notifications.info(
                `Connected to ${datasets.length} server datasets. Choose one ` +
                `from Sample datasets.`,
                {
                  category: 'connectivity',
                  duration: 0,
                  title: 'Choose a dataset'
                }
              );
            } else {
              selectStartupDataset(
                'remote',
                remoteDatasetId,
                DATA_LOAD_METHODS.SERVER_AUTO
              );
            }
          }
        }
      }
    }

    // Register current sources before resolving the exact startup selection.
    await startup.step(
      'catalog',
      'the dataset source registry',
      () => dataSourceManager.initialize({
        // Viewer host mode owns one authenticated dataset source, so it
        // does not register the unrelated sample catalog.
        registerDemoCatalog: !inViewerHost
      })
    );

    const useDefaultDemo =
      !inViewerHost
      && remoteUrlParam === null
      && dataLinkParam === null
      && requestedDataset === null
      && (sourceParam === null || sourceParam === 'local-demo')
      && startupSelection === null;
    if (useDefaultDemo) {
      const localDemoSource = dataSourceManager.getSource('local-demo');
      if (
        localDemoSource === null
        || typeof localDemoSource.isAvailable !== 'function'
        || typeof localDemoSource.getDefaultDatasetId !== 'function'
      ) {
        throw new TypeError(
          'Default sample startup requires the registered catalog default owner.'
        );
      }
      const sampleCatalog =
        localDemoSource.catalogUrl ?? 'the sample catalog';
      let demoCatalogAvailable = false;
      try {
        demoCatalogAvailable = await startup.step(
          'catalog',
          sampleCatalog,
          () => localDemoSource.isAvailable()
        );
      } catch (error) {
        if (!(error instanceof Error)) {
          throw new TypeError(
            'Default sample catalog availability rejected with a non-Error value.'
          );
        }
        // An unreachable catalog only leaves startup without a default; a
        // stalled one is a startup failure that names where it stopped.
        if (error.code === STARTUP_STALL_CODE) throw error;
        debug.log(
          `[Main] Default sample catalog is unavailable: ${error.message}`
        );
      }
      if (demoCatalogAvailable) {
        const defaultDatasetId = await startup.step(
          'catalog',
          sampleCatalog,
          () => localDemoSource.getDefaultDatasetId()
        );
        selectStartupDataset(
          'local-demo',
          defaultDatasetId,
          DATA_LOAD_METHODS.DEFAULT_DEMO
        );
      }
    }

    // A data link in the query (?data=): GitHub, CELLxGENE, GEO, any web
    // address. Must be after initialize(), which registers the link source.
    let linkConnection = null;
    if (dataLinkParam !== null) {
      debug.log(`[Main] Data link from param: ${dataLinkParam}`);
      const linkSource = dataSourceManager.getSource('link');
      if (linkSource === null) {
        throw new Error(
          'Data link startup requires the registered link source.'
        );
      }
      // Opening a linked file reads as much of it as the first view needs,
      // which grows with the file: the step stalls only when no byte arrives
      // for a whole deadline, as the Transfers log records them; while it
      // waits on the person (a sign-in, Google's file picker), the clock
      // stands still (`startup-phase.js`).
      try {
        linkConnection = await startup.step(
          'catalog',
          dataLinkParam,
          () => linkSource.connect(dataLinkParam),
          {
            progress: onProgress => getTransferLog().subscribe(onProgress),
            doing: 'opening the data link'
          }
        );
      } catch (error) {
        // Cancelled while it opened: Cellucid starts without a dataset, as it
        // does when the link did not open.
        if (!startupOpening.cancelled) {
          failStartupData(
            error,
            'Cellucid could not read the data this link points to.',
            ['data', 'dataset']
          );
        }
      }
    }
    if (linkConnection !== null) {
      if (
        typeof linkConnection !== 'object' ||
        Array.isArray(linkConnection) ||
        !Object.hasOwn(linkConnection, 'datasets')
      ) {
        throw new TypeError(
          'Link source connection must publish its dataset inventory.'
        );
      }
      // Without `dataset=`, a link opens on the dataset its catalog names as
      // its default, as the sample catalog does.
      try {
        const linkDatasetId = selectIntentDatasetId(
          linkConnection.datasets,
          requestedDataset ?? linkConnection.defaultDatasetId,
          'The requested data link'
        );
        selectStartupDataset(
          'link',
          linkDatasetId,
          DATA_LOAD_METHODS.DATA_URL_PARAM
        );
      } catch (error) {
        failStartupData(
          error,
          'This link does not hold the dataset it names.',
          ['data', 'dataset']
        );
      }

      const dataLinkInput = document.getElementById('data-address');
      if (!(dataLinkInput instanceof HTMLInputElement)) {
        throw new Error(
          'Data link startup requires the address bar.'
        );
      }
      dataLinkInput.value = linkConnection.locator;
    }

    // Check URL parameters for dataset selection
    // Only process if we haven't already connected via remote/jupyter/a link
    const requestedSource = sourceParam === null
      ? 'local-demo'
      : sourceParam;
    const currentSourceType = startupSelection?.sourceType ?? null;
    // A link names its own dataset (`dataset=` picks one of its catalog's),
    // also when its opening was cancelled.
    const skipUrlDataset = currentSourceType === 'remote' || currentSourceType === 'jupyter' || dataLinkParam !== null;

    if (requestedDataset !== null && !skipUrlDataset && !startupDataFailed) {
      const targetSource = dataSourceManager.getSource(requestedSource);
      if (targetSource === null) {
        throw new Error(
          `Requested source '${requestedSource}' is not registered.`
        );
      }
      if (typeof targetSource.hasDataset !== 'function') {
        throw new TypeError(
          `Requested source '${requestedSource}' must implement hasDataset().`
        );
      }
      const requestedCatalog = `the ${requestedSource} dataset catalog`;
      try {
        const requestedExists = await startup.step(
          'catalog',
          requestedCatalog,
          () => targetSource.hasDataset(requestedDataset)
        );
        if (!requestedExists) {
          throw new Error(
            `Requested dataset '${requestedDataset}' was not found in '${requestedSource}'.`
          );
        }
        selectStartupDataset(
          requestedSource,
          requestedDataset,
          DATA_LOAD_METHODS.DATASET_URL_PARAM
        );
      } catch (error) {
        failStartupData(
          error,
          'The dataset this link names could not be found.',
          ['dataset']
        );
      }
    }

    // The live manager is replaced only when a complete dataset generation and
    // its default position payload have been staged successfully.
    let dimensionManager = createDimensionManager({ baseUrl: DATASET_BASE_URL });
    let activeRuntimeStage = null;
    const runtimeRetirementOwner =
      createDatasetRuntimeRetirementOwner();
    const datasetPublicationOwner =
      createLatestDatasetPublicationContinuationOwner();
    let datasetPublicationGeneration = 0;
    let activeDatasetPublication = null;

    // The empty runtime publishes `{runtimeKind: 'empty'}`; a dataset or a
    // synthetic benchmark publishes the stage that carries its cells.
    function publicationHasCells(publication) {
      if (publication === null || typeof publication !== 'object') {
        throw new TypeError('Cell presence requires one runtime publication.');
      }
      const runtimeKind = publication.stage?.runtimeKind
        ?? publication.runtimeKind;
      if (!['dataset', 'empty', 'synthetic'].includes(runtimeKind)) {
        throw new TypeError(
          `Runtime publication has unknown kind "${runtimeKind}".`
        );
      }
      return runtimeKind !== 'empty';
    }

    function publishRuntimeContinuation(details) {
      const publication = datasetPublicationOwner.publish(details);
      datasetPublicationGeneration = publication.generation;
      activeDatasetPublication = publication;
      ui?.publishCellPresence(publicationHasCells(publication));
      return publication;
    }

    // The dimension manager each publication replaced, retired once that
    // publication's interface has settled. It is kept beside the publication,
    // not in it: a publication lives as long as its dataset is shown, and
    // anything of the replaced dataset it held (its stage held every
    // position) stayed in memory as long.
    const replacedDimensionManagers = new WeakMap();

    function publishDatasetReplacement(stage, previousDimensionManager) {
      const publication = publishRuntimeContinuation({ stage });
      replacedDimensionManagers.set(publication, previousDimensionManager);
      return publication;
    }

    function retireReplacedDimensionManager(publication) {
      const replaced = replacedDimensionManagers.get(publication);
      replacedDimensionManagers.delete(publication);
      if (replaced !== undefined) runtimeRetirementOwner.retire(replaced);
    }

    function requireRestorablePublication(expectedPublication) {
      if (
        expectedPublication === null ||
        typeof expectedPublication !== 'object' ||
        activeDatasetPublication !== expectedPublication ||
        expectedPublication.isCurrent() !== true
      ) {
        throw new Error(
          'Runtime restoration requires its exact current publication continuation.'
        );
      }
      return expectedPublication;
    }

    // An unconfirmed highlight selection is owned by the renderer (one unified
    // candidate set shared by the lasso, proximity, and KNN tools) and by the
    // highlight UI (the annotation candidate set plus every undo/redo stack).
    // Neither belongs to DataState, so `state.initScene()` cannot clear them:
    // a selection started on the outgoing dataset would survive replacement and
    // be intersected with candidates from the incoming one, saving a highlight
    // group of rows nobody ever selected. Every dataset replacement retires the
    // selection first. The per-tool cancels publish their exact cancelled-step
    // events, which is what resets the highlight UI's selection state, its step
    // controls, and the preview highlight; the unified cancel clears the shared
    // candidate set for the tool that is not currently active.
    function retireInProgressHighlightSelection() {
      const failures = [];
      for (const retire of [
        () => viewer.cancelAnnotationSelection(),
        () => viewer.cancelLassoSelection(),
        () => viewer.cancelProximitySelection(),
        () => viewer.cancelKnnSelection(),
        () => viewer.cancelUnifiedSelection()
      ]) {
        try {
          retire();
        } catch (error) {
          failures.push(error);
        }
      }
      const exactFailures = [...new Set(failures)];
      if (exactFailures.length === 1) throw exactFailures[0];
      if (exactFailures.length > 1) {
        throw new AggregateError(
          exactFailures,
          'Dataset replacement failed to retire every in-progress highlight selection.'
        );
      }
    }

    // Everything that shows or acts on the shown cells outside the live
    // scene: kept views, the in-progress selection, open field interactions,
    // and the connectivity edges. Each goes before the replacement touches
    // DataState or the viewer. Kept views go first, so the live view is the
    // focused one when the rest retire. The viewer drops its edge graph when
    // new points are loaded, so an edge owner retired any later still answers
    // the replacement's first visibility notification and asks the viewer
    // about a graph it no longer has.
    function retireDatasetInteractions() {
      retireKeptViews();
      retireInProgressHighlightSelection();
      ui?.prepareDatasetReplacement?.();
      connectivityRuntimeOwner.prepareDatasetReplacement();
    }

    function publishEmptyDatasetRuntime({
      restorationPublication = null
    } = {}) {
      if (
        restorationPublication !== null &&
        typeof restorationPublication !== 'object'
      ) {
        throw new TypeError(
          'Empty dataset runtime publication takes an optional restoration publication.'
        );
      }
      if (restorationPublication !== null) {
        requireRestorablePublication(restorationPublication);
      }
      retireDatasetInteractions();
      DATASET_BASE_URL = '';
      dimensionManager = createDimensionManager({ baseUrl: '' });
      obs = null;
      connectivitySummary = null;
      connectivityUrl = null;
      positions = null;
      state.setDimensionManager(dimensionManager);
      state.setFieldLoader(null);
      state.setVarFieldLoader(null);
      state.initVarData({ fields: [] });
      state.setVectorFieldManager(null);
      state.publishDatasetMapping({ mapping: null, candidates: null, origin: null });
      state.initScene(new Float32Array(), { fields: [], count: 0 });
      state.clearActiveField();
      state.clearActivePageHighlights();
      viewer.updateHighlight(new Uint8Array());
      if (statsEl) statsEl.textContent = 'No dataset selected';
      activeRuntimeStage = null;
      return restorationPublication !== null
        ? requireRestorablePublication(restorationPublication)
        : publishRuntimeContinuation({ runtimeKind: 'empty' });
    }

    // A reload is bounded by its own transaction signal and publishes no
    // startup phase; only the startup load runs under the startup owner.
    /**
     * Evidence that a dataset's reads are alive (a startup step's
     * `progress`): bytes or requests counted, or bytes of a request still
     * under way arriving, as the Transfers log hears them. A request being
     * made again after a failure is not progress: nothing arrived.
     */
    const datasetReadProgress = onProgress => {
      const arrivals = entries => entries
        .map(entry => `${entry.key}:${entry.bytes}:${entry.requests}:${entry.lastArrivalAt}`)
        .join('|');
      let seen = arrivals(getTransferLog().entries());
      return getTransferLog().subscribe(entries => {
        const now = arrivals(entries);
        if (now === seen) return;
        seen = now;
        onProgress();
      });
    };

    /**
     * The reads still open, as the read activity log names them, and the
     * request being made again after a failure, naming its URL; null when
     * nothing is open.
     */
    function openDatasetReads() {
      const open = getReadActivityLog().entries()
        .filter(activity => activity.status === 'running')
        .map(activity => activity.label);
      const failing = getTransferLog().entries()
        .filter(entry => entry.status === 'active' && entry.retrying !== null)
        .map(entry => entry.retrying);
      const parts = [
        ...(open.length === 0 ? [] : [open.join('; ')]),
        ...(failing.length === 0 ? [] : [`last failure: ${failing.join('; ')}`]),
      ];
      return parts.length === 0 ? null : parts.join(' (') + (parts.length > 1 ? ')' : '');
    }

    const RELOAD_STAGE_PHASES = Object.freeze({
      enter() {},
      step: (_phase, _target, operation) => operation(null)
    });
    const UNCHANGED_URL_PUBLICATION = Object.freeze({
      commit() {},
      rollback() {}
    });

    /**
     * `work`'s outcome, or `signal`'s reason as soon as it aborts. A value
     * `work` produces after that is handed to `discard`, so nothing staged
     * for a superseded change is left behind.
     *
     * @template T
     * @param {Promise<T>} work
     * @param {AbortSignal} signal
     * @param {(value: T) => void} discard
     * @returns {Promise<T>}
     */
    function untilSuperseded(work, signal, discard) {
      const discardLate = () => {
        work.then(value => {
          try {
            discard(value);
          } catch (error) {
            console.error('[Main] A superseded dataset stage could not be discarded:', error);
          }
        }, () => {});
      };
      if (signal.aborted) {
        discardLate();
        return Promise.reject(signal.reason);
      }
      return new Promise((resolve, reject) => {
        const onSuperseded = () => {
          discardLate();
          reject(signal.reason);
        };
        signal.addEventListener('abort', onSuperseded, { once: true });
        work.then(
          value => {
            signal.removeEventListener('abort', onSuperseded);
            resolve(value);
          },
          error => {
            signal.removeEventListener('abort', onSuperseded);
            reject(error);
          }
        );
      });
    }

    function requireDatasetChangeTransaction(transaction) {
      if (
        transaction === null ||
        typeof transaction !== 'object' ||
        !(transaction.signal instanceof AbortSignal) ||
        typeof transaction.assertCurrent !== 'function' ||
        typeof transaction.isCurrent !== 'function' ||
        typeof transaction.isLatest !== 'function'
      ) {
        throw new TypeError(
          'A dataset change requires the transaction its caller began.'
        );
      }
      return transaction;
    }

    /**
     * The data mapping one staged generation is shown with, the AnnData
     * candidate catalog it was resolved from, and whether it was guessed.
     * Every dataset is an AnnData file -- read in the browser, whether opened
     * here, from a link or a catalog, or served by Python -- and states its
     * mapping in its candidate catalog, because its graph and expression
     * matrix are not visible in the identity.
     */
    async function resolveStagedDataMapping({
      baseUrl,
      candidateAnnDataBinding,
      generation,
      signal
    }) {
      const candidates = await loadMappingCandidates(
        `${baseUrl}${MAPPING_CANDIDATES_ROUTE}`,
        { candidateAnnDataBinding, signal }
      );
      return Object.freeze({
        mapping: resolveAnnDataMapping(candidates, generation.identity),
        candidates,
        origin: candidates.guessed.some(group => group.startsWith('embeddings.'))
          ? 'best_guess'
          : 'default'
      });
    }

    async function stageDatasetRuntime({
      baseUrl,
      candidateAnnDataBinding,
      datasetSource,
      expectedIdentityId,
      phases,
      signal
    }) {
      if (
        typeof baseUrl !== 'string' ||
        baseUrl.length === 0 ||
        !baseUrl.endsWith('/')
      ) {
        throw new Error(
          'Selected dataset base URL must be a non-empty string ending in "/".'
        );
      }
      if (
        typeof expectedIdentityId !== 'string' ||
        expectedIdentityId.length === 0
      ) {
        throw new Error(
          'Selected dataset identity id must be a non-empty string.'
        );
      }
      if (!(signal instanceof AbortSignal)) {
        throw new TypeError(
          'Dataset runtime staging requires one owner AbortSignal.'
        );
      }
      if (datasetSource === null || typeof datasetSource !== 'object') {
        throw new TypeError(
          'Dataset runtime staging requires the source the dataset is staged from.'
        );
      }
      const candidateDimensionManager = createDimensionManager({
        baseUrl,
        candidateAnnDataBinding
      });

      try {
        const generation = await phases.step(
          'dataset',
          baseUrl,
          stepSignal => loadDatasetGeneration(baseUrl, {
            candidateAnnDataBinding,
            expectedIdentityId,
            signal: stepSignal === null
              ? signal
              : AbortSignal.any([signal, stepSignal])
          }),
          { progress: datasetReadProgress, pending: openDatasetReads }
        );
        const mapping = await resolveStagedDataMapping({
          baseUrl,
          candidateAnnDataBinding,
          generation,
          signal
        });
        phases.enter('positions');
        const embeddingsMetadata = getEmbeddingsMetadata(generation.identity);
        candidateDimensionManager.initFromMetadata(embeddingsMetadata);
        // An AnnData file can plot any obsm array on request
        // (`obsm/{i}/{cols}`), so the embeddings its mapping
        // turns on beyond the identity's are registered as layouts by
        // reference.
        candidateDimensionManager.setLayoutProvider(
          createMappingLayoutProvider(mapping.candidates)
        );
        // loadDatasetGeneration has already proved this count against the obs
        // and var field lists and the graph summary, so it is the dataset's
        // exact cell axis. publishCellCount must follow initFromMetadata,
        // which clears the cache and zeroes the axis.
        candidateDimensionManager.publishCellCount(generation.identity.stats.n_cells);
        const positionStage = await stageDatasetPositionPayload({
          generation,
          dimensionManager: candidateDimensionManager,
          signal
        });

        // Every obs and var field is one value per cell, and the generation
        // has already proved both field lists declare exactly stats.n_cells
        // points: each field read is checked against that count.
        const fieldLoader = createObsFieldLoader(
          getObsUrl(baseUrl),
          {
            pointCount: generation.obsFields.n_points,
            outlierMinPoints: generation.obsFields.outlier_min_points,
            storedOutlierLatentKey: generation.obsFields.stored_outlier_latent_key,
          }
        );
        const varFieldLoader = generation.geneList
          ? createVarFieldLoader(
              getGeneListUrl(baseUrl),
              {
                pointCount: generation.geneList.n_points,
                // How its genes' values are transformed and which are highly
                // variable, as the mapping it opens with says.
                mapping: varLoaderMappingOf(mapping.mapping),
              }
            )
          : null;
        const vectorFieldManager = createVectorFieldManager({
          baseUrl,
          vectorFields: resolveVectorFields({
            mapping: mapping.mapping,
            candidates: mapping.candidates,
            dimensionManager: candidateDimensionManager,
            defaultField: generation.identity.vector_field_default ?? null
          }),
          dimensionManager: candidateDimensionManager
        });

        return Object.freeze({
          baseUrl,
          dimensionManager: candidateDimensionManager,
          mapping,
          embeddingsMetadata,
          fieldLoader,
          generation,
          positions: positionStage.positions,
          runtimeKind: 'dataset',
          defaultDimension: positionStage.defaultDimension,
          varFieldLoader,
          vectorFieldManager
        });
      } catch (error) {
        try {
          runtimeRetirementOwner.retire(candidateDimensionManager);
        } catch (retirementError) {
          throw new AggregateError(
            [error, retirementError],
            'Dataset runtime staging and candidate retirement failed.'
          );
        }
        throw error;
      }
    }

    let obs = null;
    let connectivitySummary = null;
    // Where the graph in use is read from: the dataset's own (`obsp`), or a
    // mapped graph's (`obsp/{p}`) once the data mapping names another one.
    let connectivityUrl = null;
    let positions = null;
    const connectivityRuntimeOwner = initializeConnectivityControls();
    // A data-mapping transaction reads the chosen arrays under the open
    // dataset's base and publishes a new neighbour graph through its owner.
    state.setMappingRuntime({
      getBaseUrl: () => DATASET_BASE_URL,
      // The vector fields one mapping uses, for the dataset that is shown.
      createVectorFieldManager: mapping => {
        if (activeRuntimeStage === null) {
          throw new Error('No dataset is shown to draw vector fields for.');
        }
        const dimensionManager = state.getDimensionManager();
        return createVectorFieldManager({
          baseUrl: DATASET_BASE_URL,
          vectorFields: resolveVectorFields({
            mapping,
            candidates: state.getMappingCandidates(),
            dimensionManager,
            defaultField: activeRuntimeStage.generation.identity.vector_field_default ?? null
          }),
          dimensionManager
        });
      },
      getConnectivityGraph: connectivityRuntimeOwner.getConnectivityGraph,
      replaceConnectivityGraph: connectivityRuntimeOwner.replaceConnectivityGraph,
      // Results computed from the previous gene list are not kept: analysis
      // windows close and their caches clear, as for a new dataset.
      resetGeneAnalysis: () => {
        const comparisonModule = window._comparisonModule ?? null;
        if (comparisonModule === null) return;
        void comparisonModule.resetForDatasetReload({ reason: 'var-axis' })
          .catch(error => {
            console.error('[Main] Analysis reset after a gene-list change failed:', error);
          });
      }
    });
    if (
      typeof connectivityRuntimeOwner.prepareDatasetReplacement !==
      'function' ||
      typeof connectivityRuntimeOwner.synchronizeDatasetPublication !==
      'function'
    ) {
      throw new TypeError(
        'Dataset runtime requires one initialized connectivity owner.'
      );
    }

    function commitDatasetRuntimeStage(
      stage,
      { restorationPublication = null } = {}
    ) {
      if (
        stage === null ||
        typeof stage !== 'object' ||
        stage.runtimeKind !== 'dataset'
      ) {
        throw new TypeError(
          'Dataset runtime publication requires one exact staged generation.'
        );
      }
      if (
        restorationPublication !== null &&
        typeof restorationPublication !== 'object'
      ) {
        throw new TypeError(
          'Dataset runtime restoration publication must be an object or null.'
        );
      }
      if (restorationPublication !== null) {
        requireRestorablePublication(restorationPublication);
      }
      const previousDimensionManager = dimensionManager;

      // This function is intentionally synchronous. The reload transaction is
      // checked immediately before this sole publication call, so no newer
      // selection can interleave with the dataset-owned state replacement.
      retireDatasetInteractions();
      DATASET_BASE_URL = stage.baseUrl;
      dimensionManager = stage.dimensionManager;
      obs = stage.generation.obsFields;
      positions = stage.positions;
      connectivitySummary = stage.generation.connectivitySummary;
      connectivityUrl = connectivitySummary === null
        ? null
        : getConnectivityUrl(stage.baseUrl);

      state.setDimensionManager(dimensionManager);
      state.setFieldLoader(stage.fieldLoader);
      state.setVarFieldLoader(stage.varFieldLoader);
      // A dataset without genes publishes no gene list; it still has a var
      // inventory, an empty one, so everything that reads it (session
      // capture, filters, user-defined fields) treats it like any dataset.
      state.initVarData(stage.generation.geneList ?? { fields: [] });
      state.initScene(positions, obs);
      state.clearActiveField();
      state.clearActivePageHighlights();
      state.setVectorFieldManager(stage.vectorFieldManager);
      state.publishDatasetMapping(stage.mapping);
      activeRuntimeStage = stage;

      return restorationPublication !== null
        ? requireRestorablePublication(restorationPublication)
        : publishDatasetReplacement(stage, previousDimensionManager);
    }

    function commitSyntheticRuntimeStage(
      stage,
      { restorationPublication = null } = {}
    ) {
      if (
        stage === null ||
        typeof stage !== 'object' ||
        stage.runtimeKind !== 'synthetic' ||
        !(stage.positions instanceof Float32Array) ||
        !(stage.colors instanceof Uint8Array)
      ) {
        throw new TypeError(
          'Synthetic runtime publication requires one exact staged scene.'
        );
      }
      if (
        restorationPublication !== null &&
        typeof restorationPublication !== 'object'
      ) {
        throw new TypeError(
          'Synthetic runtime restoration publication must be an object or null.'
        );
      }
      if (restorationPublication !== null) {
        requireRestorablePublication(restorationPublication);
      }
      const previousDimensionManager = dimensionManager;
      retireDatasetInteractions();
      state.initSyntheticScene({
        positions: stage.positions,
        colors: stage.colors,
        dimensionLevel: stage.dimensionLevel,
        dimensionManager: stage.dimensionManager
      });
      // The opening point size and the antialiasing decision are derived from
      // how many points are being drawn, and a synthetic publication replaces
      // the whole cloud. Deriving them only where a dataset *identity* is
      // published left this path wearing the previous dataset's answer: the
      // browser-test fixture publishes 120 cells, so its 120,000-point
      // benchmark cloud was drawn at the size chosen for 120 of them. The count
      // is authoritative here — `initSyntheticScene` measures the same
      // `positions.length / dimensionLevel`.
      ui?.applyDatasetRenderDefaults?.(
        stage.positions.length / stage.dimensionLevel,
        stage.dimensionLevel
      );
      DATASET_BASE_URL = '';
      dimensionManager = stage.dimensionManager;
      obs = state.obsData;
      positions = stage.positions;
      connectivitySummary = null;
      connectivityUrl = null;
      activeRuntimeStage = stage;
      return restorationPublication !== null
        ? requireRestorablePublication(restorationPublication)
        : publishDatasetReplacement(stage, previousDimensionManager);
    }

    // A failed publication puts back the runtime that was shown, empty or
    // not. Its connectivity edges were retired with the attempt (they are
    // read again when edges are next turned on), so the controls are
    // republished for the restored graph.
    function restorePreviousRuntime(stage, restorationPublication) {
      if (stage === null) {
        publishEmptyDatasetRuntime({ restorationPublication });
      } else if (stage.runtimeKind === 'synthetic') {
        commitSyntheticRuntimeStage(stage, { restorationPublication });
      } else {
        commitDatasetRuntimeStage(stage, { restorationPublication });
      }
      connectivityRuntimeOwner.synchronizeDatasetPublication();
    }

    function assertCurrentDatasetPublication(publication) {
      if (
        publication === null ||
        typeof publication !== 'object' ||
        !Number.isSafeInteger(publication.generation) ||
        publication.generation < 1 ||
        !(publication.signal instanceof AbortSignal) ||
        typeof publication.isCurrent !== 'function' ||
        typeof publication.assertCurrent !== 'function'
      ) {
        throw new TypeError(
          'Dataset continuation requires one exact publication token.'
        );
      }
      publication.assertCurrent();
      if (publication.generation !== datasetPublicationGeneration) {
        throw createDatasetReloadSupersededError(
          'Dataset continuation was superseded by a newer runtime publication.'
        );
      }
    }

    // Kept views show the shown dataset's cells: their GPU buffers and their
    // DataState contexts are sized and indexed by it, and the renderer will
    // not replace its live points with another count while any is published.
    // They go first, before the replacement touches anything else. A failed
    // replacement cannot give them back either way: restoring the previous
    // dataset republishes its scene, which starts with the live view alone.
    function retireKeptViews() {
      const hadSnapshots = viewer.hasSnapshots();
      if (typeof hadSnapshots !== 'boolean') {
        throw new TypeError(
          'Dataset view retirement requires an exact viewer snapshot inventory.'
        );
      }
      const retirementFailures = [];
      if (hadSnapshots) {
        try {
          viewer.clearSnapshotViews();
        } catch (error) {
          retirementFailures.push(error);
        }
      }
      // Clear the state's own inventory whatever the renderer did, so a prior
      // partial failure cannot preserve a stale active-view identity.
      try {
        state.clearSnapshotViews();
      } catch (error) {
        retirementFailures.push(error);
      }

      const hasSnapshots = viewer.hasSnapshots();
      const activeViewId = state.getActiveViewId();
      const layout = viewer.getViewLayout();
      if (
        hasSnapshots !== false ||
        activeViewId !== 'live' ||
        layout === null ||
        typeof layout !== 'object' ||
        layout.activeId !== 'live' ||
        layout.liveViewHidden !== false
      ) {
        retirementFailures.push(
          new Error(
            'Kept-view retirement did not restore the visible live view.'
          )
        );
      }
      if (retirementFailures.length === 1) {
        throw retirementFailures[0];
      }
      if (retirementFailures.length > 1) {
        throw new AggregateError(
          retirementFailures,
          'Kept-view retirement was incomplete.'
        );
      }
    }

    async function synchronizePublishedDatasetUi(
      activeMetadata,
      publication
    ) {
      if (
        publication === null ||
        typeof publication !== 'object' ||
        publication.stage?.runtimeKind !== 'dataset'
      ) {
        throw new TypeError(
          'Published dataset UI synchronization requires one dataset publication.'
        );
      }
      return await settlePublishedDatasetUi({
        synchronize: async () => {
          assertCurrentDatasetPublication(publication);
          try {
            await ui?.settleFieldInteractions?.();
          } finally {
            assertCurrentDatasetPublication(publication);
          }
          connectivityRuntimeOwner.synchronizeDatasetPublication();
          if (window._comparisonModule) {
            try {
              await window._comparisonModule.resetForDatasetReload({
                reason: 'dataset-publication'
              });
            } finally {
              assertCurrentDatasetPublication(publication);
            }
          }
          debug.log(
            `[Main] Published dataset "${publication.stage.generation.identity.id}"`
          );
          if (publication.stage.generation.geneList) {
            debug.log(
              `Loaded a gene list of ` +
              `${formatCountOf(publication.stage.generation.geneList.fields.length, 'gene')}.`
            );
          }
          const publishedGraph = publication.stage.generation.connectivitySummary;
          if (publishedGraph) {
            debug.log(publishedGraph.n_edges === null
              ? 'Loaded the neighbour graph summary; its edges are counted when they are read.'
              : `Loaded a neighbour graph of ${formatCountOf(publishedGraph.n_edges, 'edge')}.`);
          }
          ui.refreshDatasetUI(activeMetadata);
          // The notebook learns the mapping each dataset opens with.
          if (viewerHostSource !== null && state.getDataMapping() !== null) {
            void viewerHostSource.notifyDataMapping({
              origin: state.getDataMappingOrigin(),
              requestId: null,
              mapping: state.getDataMapping()
            }).catch(error => {
              console.error('[Main] Viewer host data-mapping report failed:', error);
            });
          }
          // The cell count is the one thing a sensible opening point size
          // depends on, and it is known here for the first time. Applied before
          // `restoreAdvertisedDatasetState`, so a saved session or a published
          // preset still overrides it.
          ui.applyDatasetRenderDefaults(
            publication.stage.generation.identity.stats.n_cells,
            publication.stage.generation.identity.embeddings.default_dimension
          );
        },
        finalize: () => {
          retireReplacedDimensionManager(publication);
        },
        reportFailure: error => {
          if (publication.isCurrent() !== true) return;
          const errorMessage = error instanceof Error
            ? error.message
            : String(error);
          console.error(
            '[Main] Dataset was published, but UI synchronization failed:',
            error
          );
          notifications.error(
            `The dataset is loaded, but its controls could not be ` +
            `synchronized: ${errorMessage}`,
            {
              category: 'data',
              title: 'Dataset controls unavailable',
              duration: 0
            }
          );
        }
      });
    }

    // Startup publishes the empty runtime and builds the whole interface
    // before any dataset is staged. The startup selection is then loaded as
    // one ordinary dataset change (see the end of this bootstrap), so every
    // data control is live while it loads and can replace it.
    const unusedDimensionManager = dimensionManager;
    publishEmptyDatasetRuntime();
    runtimeRetirementOwner.retire(unusedDimensionManager);

    // Stage one exact manager/source/runtime/URL generation before publishing
    // any of it. This also activates not-yet-registered Remote/link
    // connection candidates without replacing the prior transport early.
    //
    // `transaction` is the dataset-change transaction the caller began when
    // the user acted (see createLatestDatasetReloadCoordinator), so work the
    // caller did before this call — reading a file, connecting a server — is
    // already owned by it. `startup` marks the one load the bootstrap starts:
    // its network awaits run as deadline-bound startup steps, its progress is
    // shown, it does not rewrite the address the page was opened with, and a
    // failure that no newer choice superseded is startup's to explain.
    //
    // `step` names each wait that is not a read of the dataset (reads name
    // themselves in the opening), so an opening that stalls says which one
    // it is in (`data/opening-progress.js`).
    async function reloadActiveDatasetInPlace(selection, { step = () => {} } = {}) {
      const activationKeys = [
        'datasetId',
        'loadMethod',
        'source',
        'sourceType',
        'startup',
        'transaction'
      ];
      const activationShapeMessage =
        'Dataset activation must contain exactly datasetId, loadMethod, ' +
        'source, sourceType, startup, and transaction.';
      if (
        selection === null ||
        typeof selection !== 'object' ||
        Array.isArray(selection) ||
        Object.getPrototypeOf(selection) !== Object.prototype
      ) {
        throw new TypeError(activationShapeMessage);
      }
      const ownActivationKeys = Reflect.ownKeys(selection);
      if (
        ownActivationKeys.length !== activationKeys.length ||
        ownActivationKeys.some(
          key =>
            typeof key !== 'string' ||
            !activationKeys.includes(key)
        )
      ) {
        throw new TypeError(activationShapeMessage);
      }
      for (const key of activationKeys) {
        const descriptor =
          Object.getOwnPropertyDescriptor(selection, key);
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !Object.hasOwn(descriptor, 'value')
        ) {
          throw new TypeError(
            `Dataset activation ${key} must be an enumerable own data field.`
          );
        }
      }
      const {
        datasetId,
        loadMethod,
        source,
        sourceType,
        startup: isStartupLoad,
        transaction: reloadTransaction
      } = selection;
      if (typeof isStartupLoad !== 'boolean') {
        throw new TypeError('Dataset activation startup must be a boolean.');
      }
      requireDatasetChangeTransaction(reloadTransaction);
      reloadTransaction.assertCurrent();

      const dataLoad = isStartupLoad
        ? analytics.beginDataLoad(loadMethod, sourceType, {
            fromNavigation: true,
            datasetId
          })
        : analytics.beginDataLoad(loadMethod, sourceType);
      const stagePhases = isStartupLoad ? startup : RELOAD_STAGE_PHASES;
      let selectionStage = null;
      let runtimeStage = null;
      let urlPublication = null;

      try {
        // A newer dataset change ends this step at once: a catalog dataset
        // being opened for it stops (the stage's signal), a served store
        // finishes opening, and startup must not wait out its deadline behind
        // a choice the user already replaced. A stage that lands later is
        // discarded.
        // Opening reads the dataset's metadata, field lists and the embedding
        // its first view draws; every request of it bounds itself, so the
        // step stalls only when nothing at all arrives for a whole deadline,
        // and then names the reads still open.
        selectionStage = await stagePhases.step(
          'dataset',
          `the host of dataset "${datasetId}"`,
          () => untilSuperseded(
            dataSourceManager.stageDatasetSelection(
              sourceType,
              datasetId,
              { loadMethod, source, signal: reloadTransaction.signal }
            ),
            reloadTransaction.signal,
            stage => dataSourceManager.discardDatasetSelection(stage)
          ),
          { progress: datasetReadProgress, pending: openDatasetReads }
        );
        reloadTransaction.assertCurrent();
        // The address the page was opened with already names the startup
        // selection (or names nothing, for the catalog default), except a
        // link's: `?data=` then names it in its provider's form (a pasted
        // Drive link as `gdrive:<id>`), as opening it from the bar does.
        urlPublication = isStartupLoad && sourceType !== 'link'
          ? UNCHANGED_URL_PUBLICATION
          : prepareUrlForDatasetSelection({
              datasetId,
              source,
              sourceType
            });
        const candidateAnnDataBinding = createCandidateAnnDataBinding(
          selectionStage.baseUrl,
          source ?? dataSourceManager.getSource(sourceType)
        );
        step('Preparing the first view');
        runtimeStage = await stageDatasetRuntime({
          baseUrl: selectionStage.baseUrl,
          candidateAnnDataBinding,
          // The same source `stageDatasetSelection` staged the dataset from.
          datasetSource: source ?? dataSourceManager.getSource(sourceType),
          expectedIdentityId: selectionStage.identityId,
          phases: stagePhases,
          signal: reloadTransaction.signal
        });
        reloadTransaction.assertCurrent();
        step("Stopping the previous dataset's saved-state restore");
        await cancelPublishedDatasetStateAndWait();
        reloadTransaction.assertCurrent();
        // The dataset's GPU stores are allocated here, in a task of their
        // own, once the GPU has done the work queued before (startup's
        // programs, the frames drawn so far; waited for between tasks): the
        // publication below then reads nothing back, and a dataset the
        // device cannot hold is refused before anything is replaced.
        step('Waiting for the GPU to finish the frames already queued');
        await viewer.whenGpuIdle();
        reloadTransaction.assertCurrent();
        // The layout the live view opens on (`setDimensionManager`), whose
        // positions the stage holds.
        const stagedLayout = runtimeStage.dimensionManager.getDefaultLayoutKey();
        const stagedDimension = stagedLayout === null
          ? 0
          : runtimeStage.dimensionManager.getLayout(stagedLayout).dimension;
        const stagedPointCount = stagedDimension === 0
          ? 0
          : runtimeStage.positions.length / stagedDimension;
        // Positions that are not whole cells are refused by the publication
        // itself, with its own message.
        if (Number.isSafeInteger(stagedPointCount) && stagedPointCount > 0) {
          step('Allocating the GPU memory for the cells');
          viewer.prepareDataStores(stagedPointCount, stagedDimension);
          // The publication runs in a task of its own.
          await yieldToMacrotask();
          reloadTransaction.assertCurrent();
        }
      } catch (err) {
        const stagingErrors = [err];
        try {
          viewer.releasePreparedDataStores();
        } catch (releaseError) {
          stagingErrors.push(releaseError);
        }
        if (runtimeStage !== null) {
          try {
            runtimeRetirementOwner.retire(
              runtimeStage.dimensionManager
            );
          } catch (retirementError) {
            stagingErrors.push(retirementError);
          }
        }
        if (selectionStage !== null) {
          try {
            dataSourceManager.discardDatasetSelection(selectionStage);
          } catch (discardError) {
            stagingErrors.push(discardError);
          }
        }
        const exactError = stagingErrors.length === 1
          ? err
          : new AggregateError(
              stagingErrors,
              'Dataset staging failure, retirement, or selection discard failed.'
            );
        return handleDatasetReloadFailure({
          error: exactError,
          transaction: reloadTransaction,
          cancel: () => dataLoad.cancel(),
          reportFailure: failure => {
            // A failed startup load is logged once, by the startup that
            // explains it (its failed opening, or the startup failure).
            if (!isStartupLoad) {
              console.error(
                '[Main] Failed to reload dataset in-place:',
                failure
              );
            }
            dataLoad.fail(failure, {
              datasetId,
              metadata: selectionStage?.metadata ?? null
            });
          }
        });
      }

      // All fallible dataset I/O and validation has completed, and the owner
      // was rechecked. Publication is one synchronous, non-interleavable step.
      let managerPublication;
      let publishedUrl = false;
      let managerCommitStarted = false;
      try {
        urlPublication.commit();
        publishedUrl = true;
        managerCommitStarted = true;
        managerPublication =
          dataSourceManager.commitDatasetSelection(selectionStage);
      } catch (error) {
        const publicationErrors = [error];
        if (publishedUrl) {
          try {
            urlPublication.rollback();
          } catch (rollbackError) {
            publicationErrors.push(rollbackError);
          }
        }
        if (!managerCommitStarted) {
          try {
            dataSourceManager.discardDatasetSelection(selectionStage);
          } catch (discardError) {
            publicationErrors.push(discardError);
          }
        }
        try {
          runtimeRetirementOwner.retire(
            runtimeStage.dimensionManager
          );
        } catch (retirementError) {
          publicationErrors.push(retirementError);
        }
        const exactError = publicationErrors.length === 1
          ? error
          : new AggregateError(
              publicationErrors,
              'Dataset selection publication, rollback, or staged-runtime retirement failed.'
            );
        return handleDatasetReloadFailure({
          error: exactError,
          transaction: reloadTransaction,
          cancel: () => dataLoad.cancel(),
          reportFailure: failure => {
            console.error('[Main] Failed to publish dataset selection:', failure);
            dataLoad.fail(failure, {
              datasetId,
              metadata: selectionStage.metadata
            });
          }
        });
      }

      let publication;
      const previousRuntimeStage = activeRuntimeStage;
      const previousPublication = activeDatasetPublication;
      try {
        publication = commitDatasetRuntimeStage(runtimeStage);
      } catch (runtimeError) {
        let restorationError = null;
        try {
          restorePreviousRuntime(previousRuntimeStage, previousPublication);
        } catch (error) {
          restorationError = error;
        }
        let managerRollbackError = null;
        try {
          dataSourceManager.rollbackDatasetSelection(managerPublication);
        } catch (error) {
          managerRollbackError = error;
        }
        let urlRollbackError = null;
        try {
          urlPublication.rollback();
        } catch (error) {
          urlRollbackError = error;
        }
        let retirementError = null;
        try {
          runtimeRetirementOwner.retire(
            runtimeStage.dimensionManager
          );
        } catch (error) {
          retirementError = error;
        }
        const rollbackErrors = [
          runtimeError,
          restorationError,
          managerRollbackError,
          urlRollbackError,
          retirementError
        ].filter(error => error !== null);
        const exactError = rollbackErrors.length === 1
          ? runtimeError
          : new AggregateError(
              rollbackErrors,
              'Dataset runtime publication and rollback failed.'
            );
        return handleDatasetReloadFailure({
          error: exactError,
          transaction: reloadTransaction,
          cancel: () => dataLoad.cancel(),
          reportFailure: failure => {
            console.error(
              '[Main] Failed to publish dataset runtime:',
              failure
            );
            dataLoad.fail(failure, {
              datasetId,
              metadata: selectionStage.metadata
            });
          }
        });
      }
      let managerListenerError = null;
      try {
        dataSourceManager.publishDatasetSelection(managerPublication);
      } catch (error) {
        managerListenerError = error;
      }
      step('Drawing the first view');
      const synchronizationOutcome = await synchronizePublishedDatasetUi(
        selectionStage.metadata,
        publication
      );
      let managerFinalizationError = null;
      try {
        dataSourceManager.finalizeDatasetSelection(managerPublication);
      } catch (error) {
        managerFinalizationError = error;
      }
      if (
        synchronizationOutcome.status === 'superseded' ||
        publication.isCurrent() !== true
      ) {
        return handleDatasetReloadFailure({
          error: createDatasetReloadSupersededError(
            'Dataset reload was superseded during UI synchronization.'
          ),
          transaction: publication,
          cancel: () => dataLoad.cancel(),
          reportFailure() {
            throw new Error(
              'A superseded publication must not report reload failure.'
            );
          }
        });
      }
      assertCurrentDatasetPublication(publication);
      if (managerListenerError !== null) {
        console.error(
          '[Main] Dataset loaded, but manager listeners failed:',
          managerListenerError
        );
        notifications.error(
          `The dataset is loaded, but a selection control could not be ` +
          `synchronized: ${managerListenerError instanceof Error
            ? managerListenerError.message
            : String(managerListenerError)}`,
          {
            category: 'data',
            title: 'Dataset controls unavailable',
            duration: 0
          }
        );
      }
      if (managerFinalizationError !== null) {
        console.error(
          '[Main] Dataset loaded, but prior-source cleanup failed:',
          managerFinalizationError
        );
        notifications.error(
          `The new dataset is loaded, but prior-source resources could not ` +
          `be fully released: ${managerFinalizationError instanceof Error
            ? managerFinalizationError.message
            : String(managerFinalizationError)}`,
          {
            category: 'data',
            title: 'Prior dataset cleanup failed',
            duration: 0
          }
        );
      }
      // The published sample view belongs to the dataset now on screen, so
      // it ends with that publication — not with a newer request, which may
      // still fail and leave this dataset in place. Startup's sidecar
      // requests are deadline-bound startup steps; an interactive switch's
      // end with the publication that owns them.
      const stateOutcome = await restoreAdvertisedDatasetState({
        requestStep: isStartupLoad
          ? (url, operation) => startup.step('session', url, operation)
          : (_url, operation) => operation(publication.signal),
        signal: publication.signal
      });
      const settledStateOutcome =
        await settlePublishedDatasetStateOutcome({
          outcome: stateOutcome,
          transaction: publication,
          cancel: () => dataLoad.cancel(),
          complete: () => dataLoad.succeed({
            datasetId,
            metadata: selectionStage.metadata,
            stateStatus: stateOutcome.status,
            mapping: state.getMappingAnalytics(),
            // The input format it was read as (a server or catalog names
            // only where; the reader found what).
            dataFormat: getDataSourceManager().getSource(sourceType)
              ?.getAnnDataSource?.(datasetId)?.describeStorage?.()?.format ?? null
          })
        });
      debug.log(
        `[Main] Published dataset state outcome: ` +
        `${settledStateOutcome.status}`
      );
      return synchronizationOutcome.status === 'ready' ||
        synchronizationOutcome.status === 'ready-ui-error';
    }

    /**
     * A dataset change, shown from its first moment by the opening progress
     * (`data/opening-progress.js`; the layers that read the dataset join
     * it): Cancel stops the change, and the dataset on screen stays. A
     * failure is explained by the dataset controls (or, at startup, by
     * startup), so the opening only lets go of it.
     */
    async function reloadActiveDatasetShown(selection) {
      const opening = beginOpening({
        title: selection.datasetId,
        step: 'Opening the dataset',
        onCancel: () => selection.transaction.cancel()
      });
      // Named as the dataset list names it, once that is read.
      const source = selection.source ?? dataSourceManager.getSource(selection.sourceType);
      Promise.resolve(source?.listDatasets?.())
        .then(datasets => {
          const name = datasets?.find?.(dataset => dataset.id === selection.datasetId)?.name;
          if (typeof name === 'string') opening.rename(name);
        })
        .catch(() => {});
      // A newer choice replaces this change at once: the opening is left to
      // it (and so is the startup opening, when this change was startup's)
      // even while this change's own reads are still unwinding, which a
      // read that never answers would otherwise hold on screen.
      // (A malformed selection is refused by the reload itself.)
      const signal = selection?.transaction?.signal ?? null;
      const letGo = () => {
        opening.dismiss();
        if (selection.startup === true) startupOpening?.dismiss();
      };
      if (signal?.aborted) letGo();
      else signal?.addEventListener('abort', letGo, { once: true });
      try {
        const ready = await reloadActiveDatasetInPlace(selection, {
          step: text => opening.step(text)
        });
        if (ready === true) opening.end();
        else opening.dismiss();
        return ready;
      } catch (error) {
        opening.dismiss();
        throw error;
      } finally {
        signal?.removeEventListener('abort', letGo);
      }
    }

    async function clearActiveDatasetInPlace(reloadTransaction) {
      requireDatasetChangeTransaction(reloadTransaction);
      reloadTransaction.assertCurrent();
      await cancelPublishedDatasetStateAndWait();
      reloadTransaction.assertCurrent();
      const clearStage = dataSourceManager.stageDatasetClear({
        loadMethod: DATA_LOAD_METHODS.DATASET_DROPDOWN
      });
      const urlPublication = prepareUrlForDataSource(null, {});

      urlPublication.commit();
      let managerPublication;
      try {
        managerPublication = dataSourceManager.commitDatasetClear(clearStage);
      } catch (error) {
        urlPublication.rollback();
        throw error;
      }

      const previousRuntimeStage = activeRuntimeStage;
      const previousDimensionManager = dimensionManager;
      const previousPublication = activeDatasetPublication;
      let emptyPublication = null;
      try {
        emptyPublication =
          publishEmptyDatasetRuntime();
      } catch (runtimeError) {
        const rollbackErrors = [runtimeError];
        const rejectedEmptyDimensionManager =
          dimensionManager === previousDimensionManager
            ? null
            : dimensionManager;
        try {
          restorePreviousRuntime(previousRuntimeStage, previousPublication);
        } catch (error) {
          rollbackErrors.push(error);
        }
        if (managerPublication !== null) {
          try {
            dataSourceManager.rollbackDatasetSelection(managerPublication);
          } catch (error) {
            rollbackErrors.push(error);
          }
        }
        try {
          urlPublication.rollback();
        } catch (error) {
          rollbackErrors.push(error);
        }
        if (rejectedEmptyDimensionManager !== null) {
          try {
            runtimeRetirementOwner.retire(
              rejectedEmptyDimensionManager
            );
          } catch (error) {
            rollbackErrors.push(error);
          }
        }
        throw rollbackErrors.length === 1
          ? runtimeError
          : new AggregateError(
              rollbackErrors,
              'Dataset clear runtime publication and rollback failed.'
            );
      }
      let managerListenerError = null;
      if (managerPublication !== null) {
        try {
          dataSourceManager.publishDatasetSelection(managerPublication);
        } catch (error) {
          managerListenerError = error;
        }
      }
      const synchronizationOutcome = await settlePublishedDatasetUi({
        synchronize: async () => {
          assertCurrentDatasetPublication(emptyPublication);
          try {
            await ui?.settleFieldInteractions?.();
          } finally {
            assertCurrentDatasetPublication(emptyPublication);
          }
          connectivityRuntimeOwner.synchronizeDatasetPublication();
          if (window._comparisonModule) {
            try {
              await window._comparisonModule.resetForDatasetReload({
                reason: 'dataset-clear'
              });
            } finally {
              assertCurrentDatasetPublication(emptyPublication);
            }
          }
          ui.refreshDatasetUI(null);
        },
        finalize: () => {
          runtimeRetirementOwner.retire(previousDimensionManager);
        },
        reportFailure: error => {
          if (emptyPublication.isCurrent() !== true) return;
          console.error(
            '[Main] Dataset cleared, but UI synchronization failed:',
            error
          );
          notifications.error(
            `The dataset was cleared, but its controls could not be ` +
            `synchronized: ${error instanceof Error ? error.message : String(error)}`,
            {
              category: 'data',
              title: 'Dataset controls unavailable',
              duration: 0
            }
          );
        }
      });
      let managerFinalizationError = null;
      if (managerPublication !== null) {
        try {
          dataSourceManager.finalizeDatasetSelection(managerPublication);
        } catch (error) {
          managerFinalizationError = error;
        }
      }
      if (
        synchronizationOutcome.status === 'superseded' ||
        emptyPublication.isCurrent() !== true
      ) {
        return handleDatasetReloadFailure({
          error: createDatasetReloadSupersededError(
            'Dataset clear was superseded during UI synchronization.'
          ),
          transaction: emptyPublication,
          cancel() {},
          reportFailure() {
            throw new Error(
              'A superseded clear must not report dataset failure.'
            );
          }
        });
      }
      assertCurrentDatasetPublication(emptyPublication);
      if (managerListenerError !== null) {
        console.error(
          '[Main] Empty dataset published, but manager listeners failed:',
          managerListenerError
        );
        notifications.error(
          `The dataset was cleared, but a selection control could not be ` +
          `synchronized: ${managerListenerError instanceof Error
            ? managerListenerError.message
            : String(managerListenerError)}`,
          {
            category: 'data',
            title: 'Dataset controls unavailable',
            duration: 0
          }
        );
      }
      if (managerFinalizationError !== null) {
        console.error(
          '[Main] Dataset cleared, but prior-source cleanup failed:',
          managerFinalizationError
        );
        notifications.error(
          `The dataset was cleared, but prior-source resources could not ` +
          `be fully released: ${managerFinalizationError instanceof Error
            ? managerFinalizationError.message
            : String(managerFinalizationError)}`,
          {
            category: 'data',
            title: 'Prior dataset cleanup failed',
            duration: 0
          }
        );
      }
      return true;
    }
    // One-time helper to rebuild density from current visibility + grid
    function rebuildSmokeDensity(gridSize) {
      if (
        !Number.isInteger(gridSize)
        || gridSize < 8
        || gridSize > MAX_SMOKE_GRID_SIZE
      ) {
        throw new RangeError(
          `Smoke density rebuild requires an exact gridSize integer from 8 through ${MAX_SMOKE_GRID_SIZE}.`
        );
      }
      if (typeof state.getSmokeDensitySource !== 'function') {
        throw new TypeError(
          'Smoke density rebuild requires getSmokeDensitySource().'
        );
      }
      const source = state.getSmokeDensitySource();
      if (
        source === null
        || typeof source !== 'object'
        || Array.isArray(source)
        || Object.getPrototypeOf(source) !== Object.prototype
        || Object.keys(source).sort().join(',') !==
          'alpha,colors,dimension,outlierQuantiles,outlierThreshold,positions'
        || !(source.positions instanceof Float32Array)
        || ![1, 2, 3].includes(source.dimension)
        || source.positions.length % source.dimension !== 0
      ) {
        throw new TypeError(
          'Smoke density rebuild requires one exact zero-copy dataset source.'
        );
      }
      if (source.positions.length === 0) {
        viewer.clearSmokeVolume();
        debug.log('Cleared smoke volume because the dataset is empty.');
        return;
      }

      debug.log(
        `Building smoke volume at ${gridSize}^3 from ` +
        `${source.positions.length / source.dimension} dataset points with bounded ` +
        `visibility streaming (GPU)…`
      );
      viewer.buildSmokeVolumeGPU(source.positions, {
        colors: source.colors,
        dimension: source.dimension,
        gridSize,
        gamma: 0.7,
        visibility: {
          alpha: source.alpha,
          outlierQuantiles: source.outlierQuantiles,
          outlierThreshold: source.outlierThreshold,
        },
      });
    }

    // Smoke volume is built lazily when switching to smoke mode
    // (no initial build to save startup time)

    const sessionSerializer = createSessionSerializer({
      state,
      viewer,
      sidebar,
      dataSourceManager
    });
    let activePublishedStateController = null;
    let activePublishedStateTask = null;

    async function cancelPublishedDatasetStateAndWait() {
      const task = activePublishedStateTask;
      activePublishedStateController?.abort();
      await sessionSerializer.cancelRestoreAndWait();
      if (task !== null) {
        await task;
      }
    }

    async function restoreAdvertisedDatasetState({ requestStep, signal }) {
      if (!(signal instanceof AbortSignal)) {
        throw new TypeError(
          'Published dataset state requires one owner AbortSignal.'
        );
      }
      if (typeof requestStep !== 'function') {
        throw new TypeError(
          'Published dataset state requires one request step runner.'
        );
      }
      if (activePublishedStateTask !== null) {
        throw new Error(
          'Published dataset state replacement must await its prior owner.'
        );
      }

      const controller = new AbortController();
      const relayAbort = () => controller.abort();
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener('abort', relayAbort, { once: true });
      }
      activePublishedStateController = controller;

      const task = (async () => {
        try {
          const restored = await restoreCurrentDatasetState({
            dataSourceManager,
            fetchArtifact: fetchCatalogFile,
            getPublicationRevision: () => datasetPublicationGeneration,
            refreshUi: ui.refreshUiAfterStateLoad,
            requestStep,
            sessionSerializer,
            signal: controller.signal
          });
          return {
            status: restored ? 'ready-state-restored' : 'ready'
          };
        } catch (error) {
          const classified =
            classifyAdvertisedDatasetStateRestoreError(error, {
              ownerAborted: controller.signal.aborted
            });
          if (classified !== null) return classified;
          // A startup request that stalled ends startup on its failure
          // surface, naming the phase and URL, not as a missing sample view.
          if (error?.code === STARTUP_STALL_CODE) throw error;
          const message = error instanceof Error
            ? error.message
            : String(error);
          console.error(
            '[Main] Dataset loaded, but its advertised default state failed:',
            error
          );
          notifications.error(
            'The dataset is open, but its published sample view could not be applied.',
            {
              category: 'data',
              duration: 0,
              title: 'Sample view unavailable',
              details: message
            }
          );
          return {
            error,
            status: 'ready-state-error'
          };
        } finally {
          signal.removeEventListener('abort', relayAbort);
        }
      })();
      activePublishedStateTask = task;
      try {
        return await task;
      } finally {
        if (activePublishedStateTask === task) {
          activePublishedStateTask = null;
          activePublishedStateController = null;
        }
      }
    }

    // -----------------------------------------------------------------------
    // Session capture for the host ("no download"): the bundle goes to the
    // host on the viewer channel.
    // -----------------------------------------------------------------------
    if (viewerHostSource) {
      viewerHostSource.onMessage(async message => {
        if (message.type !== 'requestSessionBundle') return;
        const bundle = await sessionSerializer.createSessionBundle();
        viewerHostSource.sendSessionBundle(message.requestId, bundle);
      });
    }

    startup.enter('ui');
    ui = initUI({
      state,
      viewer,
      smoke: {
        rebuildSmokeDensity
      },
      clearActiveDataset: clearActiveDatasetInPlace,
      reloadActiveDataset: reloadActiveDatasetShown,
      datasetChanges: datasetReloadCoordinator,
      sessionSerializer,
      dataSourceManager,
      viewerHostSource
    });
    window._cellucidUi = ui;
    // Every runtime publication so far reached no UI.
    ui.publishCellPresence(publicationHasCells(activeDatasetPublication));

    if (viewerHostSource !== null) {
      const viewerHostCommandHandlers = createViewerHostCommandHandlers({
        state,
        viewer,
        refreshUi: ui.refreshUiAfterStateLoad,
        reportDataMapping: report => viewerHostSource.notifyDataMapping(report)
      });
      // Every mapping change reaches the notebook, except an answer to its
      // own setDataMapping, which the command handler sends with the request
      // id it names.
      state.on('mapping:changed', ({ mapping, origin }) => {
        if (origin === 'notebook') return;
        void viewerHostSource.notifyDataMapping({
          origin,
          requestId: null,
          mapping
        }).catch(error => {
          console.error('[Main] Viewer host data-mapping report failed:', error);
        });
      });
      viewerHostSource.onHighlight(
        viewerHostCommandHandlers.handleHighlight
      );
      viewerHostSource.onMessage(
        viewerHostCommandHandlers.handleMessage
      );
      // Every handler is in place: commands the host sent while the dataset
      // opened run now, in order.
      viewerHostSource.acceptCommands();
    }

    // Allow session serializer to capture/restore cinematic camera state and
    // the figure-export settings.
    sessionSerializer.setCinematicCameraRef(ui.cinematicCamera);
    sessionSerializer.setFigureExportRef(ui.figureExport);

    // Initialize Page Analysis / Comparison Module
    const pageAnalysisSection = document.getElementById('page-analysis-section');
    if (pageAnalysisSection) {
      comparisonModule = createComparisonModule({
        state,
        container: pageAnalysisSection,
        colorByGene: ui.colorByGene
      });
      // Store reference for potential external access
      window._comparisonModule = comparisonModule;
      // Allow session restore to reopen analysis windows once the module exists.
      const analysisWindowManager = comparisonModule.getAnalysisWindowManager();
      sessionSerializer.setAnalysisRefs({
        comparisonModule,
        analysisWindowManager
      });
    }

    // Setup connectivity controls
    // NOTE: Handlers are ALWAYS set up so they work for datasets loaded dynamically (h5ad/zarr)
    // The handlers check if connectivitySummary is available before doing anything
    function initializeConnectivityControls() {
      // Show connectivity controls if data is available at bootstrap
      if (connectivitySummary !== null && connectivityControls) {
        connectivityControls.hidden = false;
      }

      // The current graph's edge count. A graph read straight from a file is
      // counted when its edges are read: until then its summary has none,
      // and the count is the published edges'.
      let publishedEdgeCount = null;
      const getTotalEdges = () =>
        connectivitySummary === null
          ? 0
          : connectivitySummary.n_edges ?? publishedEdgeCount ?? 0;

      // UI statistics describe only the active pane, while every pane owns its
      // own selection of shown edges inside the viewer.
      let activeConnectivityStatsViewId = null;
      let actualVisibleEdges = getTotalEdges();

      /**
       * Validate one immutable SpatialIndex-owned LOD admission descriptor.
       * Null is the exact full-detail contract.
       *
       * @param {object|null} membership
       * @param {number} pointCount
       * @param {number} dimensionLevel
       * @returns {object|null}
       */
      function requireConnectivityLodMembership(
        membership,
        pointCount,
        dimensionLevel
      ) {
        if (membership === null) return null;
        if (
          typeof membership !== 'object' ||
          Array.isArray(membership) ||
          Object.keys(membership).sort().join(',') !==
            'admissionLevels,dimensionLevel,generationToken,indices,lodLevel,pointCount' ||
          !Object.isFrozen(membership) ||
          !(membership.admissionLevels instanceof Uint8Array) ||
          membership.admissionLevels.length !== pointCount ||
          !(membership.indices instanceof Uint32Array) ||
          membership.indices.length > pointCount ||
          membership.pointCount !== pointCount ||
          membership.dimensionLevel !== dimensionLevel ||
          !Number.isInteger(membership.lodLevel) ||
          membership.lodLevel < 0 ||
          membership.lodLevel >= 0xff ||
          membership.generationToken === null ||
          typeof membership.generationToken !== 'object'
        ) {
          throw new TypeError(
            'Connectivity LOD requires one exact immutable admission owner.'
          );
        }
        return membership;
      }

      /**
       * Resolve one exact compositional visibility owner.
       * An endpoint is visible only when its per-view transparency passes the
       * scatter threshold and its current LOD admits the source ID.
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
          connectivitySummary === null ||
          transparency.length !== connectivitySummary.n_cells
        ) {
          throw new TypeError(
            'Connectivity filtering requires one exact Uint8 visibility ' +
            'value per cell.'
          );
        }

        const pointCount = transparency.length;
        const lodMembership = requireConnectivityLodMembership(
          viewer.getCurrentLodMembership(viewId, dimensionLevel),
          pointCount,
          dimensionLevel
        );

        return Object.freeze({
          transparency,
          lodMembership,
          pointCount
        });
      }

      // Format edge count for display (compact)
      function formatEdgeCount(n) {
        if (!Number.isSafeInteger(n) || n < 0) {
          throw new TypeError(
            'Connectivity edge counts must be non-negative safe integers.'
          );
        }
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
        return n.toString();
      }

      // Track current state - user's preference, NOT auto-adjusted by visibility changes
      // The number of edges the person asked to see, or null until they move
      // the slider. The default is applied against the graph's edge count
      // when it is used, not when the dataset is published: a graph read
      // from a file has no count until its edges are read, and a default
      // fixed at publication was min(default, 0) -- edges on, none shown.
      let userEdgeLimit = null;
      const currentEdgeLimit = () => Math.min(
        userEdgeLimit ?? CONNECTIVITY_DEFAULT_VISIBLE_TARGET,
        getTotalEdges()
      );

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
          if (connectivityLimitDisplay) {
            connectivityLimitDisplay.textContent = '0';
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
      let connectivityToggleGeneration = 0;
      let knnLoadPromise = null;

      function createConnectivitySupersededError() {
        return createDatasetReloadSupersededError(
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
        if (connectivitySummary === null) {
          throw new Error(
            'Connectivity edge loading requires a published neighbour graph.'
          );
        }

        const sourceType = dataSourceManager.getCurrentSourceType();
        const datasetId = dataSourceManager.getCurrentDatasetId();
        const identityId = dataSourceManager.getCurrentIdentityId();
        const managerBaseUrl = dataSourceManager.getCurrentBaseUrl();
        if (
          datasetPublicationGeneration === 0 ||
          sourceType === null ||
          datasetId === null ||
          identityId === null ||
          managerBaseUrl !== DATASET_BASE_URL
        ) {
          throw createConnectivitySupersededError();
        }

        return {
          controller: new AbortController(),
          publicationGeneration: datasetPublicationGeneration,
          summary: connectivitySummary,
          url: connectivityUrl,
          datasetBaseUrl: DATASET_BASE_URL,
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
          owner.publicationGeneration !== datasetPublicationGeneration ||
          owner.summary !== connectivitySummary ||
          owner.url !== connectivityUrl ||
          owner.datasetBaseUrl !== DATASET_BASE_URL ||
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
        edgesLoaded = false;
        loadedEdgeData = null;
        publishedEdgeCount = null;
        activeConnectivityStatsViewId = null;
        actualVisibleEdges = 0;
        userEdgeLimit = null;
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
        userEdgeLimit = null;
        if (connectivityCheckbox) {
          connectivityCheckbox.checked = false;
          connectivityCheckbox.disabled = false;
        }
        if (connectivitySliders) {
          connectivitySliders.hidden = true;
        }
        updateSliderRange(actualVisibleEdges);
        updateConnectivityInfo(actualVisibleEdges, Math.min(currentEdgeLimit(), actualVisibleEdges));
        if (connectivityControls) {
          connectivityControls.hidden = connectivitySummary === null;
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

        // The lifecycle and k-NN owner is the payload itself (no copy).
        const publishedEdgeData = edgeData;
        loadedEdgeData = publishedEdgeData;
        edgesLoaded = true;
        ui.showLoadedConnectivityEdges(edgeData.nEdges);
        debug.log(
          `[Main] Connectivity generation published: ` +
          `${formatCountOf(edgeData.nEdges, 'edge')}, ${formatCountOf(edgeData.nCells, 'cell')}, ` +
          `${actualVisibleEdges} visible.`
        );
        return publishedEdgeData;
      }

      function clearPublishedConnectivityEdges() {
        viewer.setShowConnectivity(false);
        viewer.clearEdgesV2();
        viewer.clearKnnEdges();
        edgesLoaded = false;
        loadedEdgeData = null;
        publishedEdgeCount = null;
        activeConnectivityStatsViewId = null;
        actualVisibleEdges = getTotalEdges();
        userEdgeLimit = null;
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
        owner.promise = (async () => {
          try {
            const edgeData = await loadEdges(
              owner.url,
              owner.summary,
              { signal: owner.controller.signal }
            );
            assertCurrentConnectivityLoadOwner(owner);
            rendererPublicationStarted = true;
            return publishConnectivityEdges(owner, edgeData);
          } catch (error) {
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

          // Check if a neighbour graph is available
          if (connectivitySummary === null) {
            console.warn('[Main] Connectivity checkbox toggled but no neighbour graph available');
            connectivityCheckbox.checked = false;
            return;
          }

          // Load edge data on first toggle (or after the graph was replaced)
          if (show && !edgesLoaded) {
            const connNotifId = notifications.loading('Loading connectivity data', { category: 'connectivity' });
            try {
              debug.log('[Main] Loading GPU-optimized edges...');
              const edgeData = await ensureConnectivityEdgesLoaded();
              if (
                toggleGeneration !== connectivityToggleGeneration ||
                connectivityCheckbox.checked !== true ||
                edgesLoaded !== true ||
                loadedEdgeData !== edgeData
              ) {
                notifications.dismiss(connNotifId);
                return;
              }
              notifications.complete(connNotifId, `Loaded ${formatCountOf(edgeData.nEdges, 'edge')}`);

            } catch (err) {
              if (
                isDatasetReloadSupersededError(err) ||
                toggleGeneration !== connectivityToggleGeneration
              ) {
                notifications.dismiss(connNotifId);
                return;
              }
              console.error('Failed to load connectivity data:', err);
              // A graph larger than the memory the browser grants is a
              // connectivity failure only: the dataset stays loaded.
              notifications.fail(
                connNotifId,
                err?.code === DataSourceErrorCode.TOO_LARGE || err instanceof RangeError
                  ? 'Connectivity needs more memory than this browser could allocate; the dataset stays loaded without edges'
                  : 'Failed to load connectivity'
              );
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
          }
        });
      }

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
          const hex = connectivityColorInput.value;
          const r = parseInt(hex.slice(1, 3), 16);
          const g = parseInt(hex.slice(3, 5), 16);
          const b = parseInt(hex.slice(5, 7), 16);
          viewer.setConnectivityColor(r, g, b);
        });
      }

      // Wire up alpha slider
      if (connectivityAlphaInput && connectivityAlphaDisplay) {
        connectivityAlphaInput.addEventListener('input', () => {
          const alpha = parseFloat(connectivityAlphaInput.value) / 100;
          viewer.setConnectivityAlpha(alpha);
          connectivityAlphaDisplay.textContent = alpha.toFixed(2);
        });
      }

      // Wire up width slider
      if (connectivityWidthInput && connectivityWidthDisplay) {
        connectivityWidthInput.addEventListener('input', () => {
          const width = parseFloat(connectivityWidthInput.value) / 10;
          viewer.setConnectivityLineWidth(width);
          connectivityWidthDisplay.textContent = width.toFixed(1);
        });
      }

      // Wire up limit slider (LOD control)
      if (connectivityLimitInput && connectivityLimitDisplay) {
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
          userEdgeLimit = clamp(requested, min, max);
          connectivityLimitInput.value = userEdgeLimit;
          connectivityLimitDisplay.textContent = formatEdgeCount(userEdgeLimit);

          // Apply LOD limit using accurate visible edge calculation
          applyEdgeLodLimit();
        });
      }

      // Whether a dataset has a neighbour graph changes only with its
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
        if (connectivitySummary === null) {
          const graphGeneration =
            `${datasetPublicationGeneration}:${connectivityGraphGeneration}`;
          if (announcedMissingConnectivityGeneration !== graphGeneration) {
            announcedMissingConnectivityGeneration = graphGeneration;
            console.warn(
              '[Main] KNN mode requested but no neighbour graph available'
            );
            notifications.warning(
              'No neighbor graph available for this dataset',
              { category: 'connectivity' }
            );
          }
          return;
        }
        if (edgesLoaded && viewer.isKnnEdgesLoaded()) {
          return;
        }
        if (knnLoadPromise !== null) {
          return;
        }

        const requestGeneration = datasetPublicationGeneration;
        const requestGraphGeneration = connectivityGraphGeneration;
        const knnNotifId = notifications.loading(
          'Loading neighbor graph for KNN mode',
          { category: 'connectivity' }
        );
        const operation = (async () => {
          try {
            debug.log('[Main] Loading edges for KNN mode...');
            const edgeData = await ensureConnectivityEdgesLoaded();
            if (
              requestGeneration !== datasetPublicationGeneration ||
              requestGraphGeneration !== connectivityGraphGeneration ||
              edgesLoaded !== true ||
              loadedEdgeData !== edgeData
            ) {
              notifications.dismiss(knnNotifId);
              return;
            }
            if (
              viewer.loadKnnEdges(edgeData) !== true
            ) {
              throw new Error(
                'The viewer rejected an exact KNN connectivity payload.'
              );
            }
            notifications.complete(
              knnNotifId,
              `Neighbor graph ready ` +
              `(${formatCountOf(edgeData.nEdges, 'edge')})`
            );
          } catch (err) {
            if (
              isDatasetReloadSupersededError(err) ||
              requestGeneration !== datasetPublicationGeneration ||
              requestGraphGeneration !== connectivityGraphGeneration
            ) {
              notifications.dismiss(knnNotifId);
              return;
            }
            console.error('[Main] Failed to load edges for KNN:', err);
            notifications.fail(
              knnNotifId,
              'Failed to load neighbor graph'
            );
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
       * The neighbour graph in use: its summary (null for none), where it is
       * read from, and its edge count (a graph read straight from a file is
       * counted once its edges are read; null until then).
       */
      function getConnectivityGraph() {
        return Object.freeze({
          summary: connectivitySummary,
          url: connectivityUrl,
          edges: connectivitySummary === null ? null : (connectivitySummary.n_edges ?? publishedEdgeCount)
        });
      }

      /**
       * Replace the neighbour graph in use, as one step of a data-mapping
       * transaction: the edges and the KNN tool's graph are released, the
       * new summary is published, and the edges are drawn again from the new
       * graph if they were shown. Applying the previous graph rolls it back.
       *
       * @param {{summary: Object|null, url: string|null}} graph
       */
      function replaceConnectivityGraph({ summary, url }) {
        if ((summary === null) !== (url === null)) {
          throw new TypeError(
            'A neighbour graph is a summary with its URL, or neither.'
          );
        }
        const wasShown = connectivityCheckbox?.checked === true;
        prepareDatasetReplacement();
        connectivitySummary = summary;
        connectivityUrl = url;
        connectivityGraphGeneration++;
        synchronizeDatasetPublication();
        if (wasShown && summary !== null && connectivityCheckbox) {
          connectivityCheckbox.checked = true;
          connectivityCheckbox.dispatchEvent(new Event('change'));
        }
      }

      return Object.freeze({
        getConnectivityGraph,
        prepareDatasetReplacement,
        replaceConnectivityGraph,
        synchronizeDatasetPublication
      });
    }

    // ========================================
    // PERFORMANCE BENCHMARK CONTROLS
    // ========================================
    const benchmarkRunBtn = document.getElementById('benchmark-run');
    const benchmarkCountInput = document.getElementById('benchmark-count');
    const benchmarkPatternSelect = document.getElementById('benchmark-pattern');
    const benchmarkRepresentationsSelect = document.getElementById('benchmark-representations');
    const benchmarkStatsEl = document.getElementById('benchmark-stats');
    const benchPresets = document.querySelectorAll('.benchmark-preset');
    const benchmarkReportBtn = document.getElementById('benchmark-report-btn');
    const benchmarkReportOutput = document.getElementById('benchmark-report-output');
    const benchmarkSection = document.getElementById('benchmark-section');
    const benchPointsEl = document.getElementById('bench-points');
    const benchFpsEl = document.getElementById('bench-fps');
    const benchFrametimeEl = document.getElementById('bench-frametime');
    const benchRendertimeEl = document.getElementById('bench-rendertime');
    const benchMemoryEl = document.getElementById('bench-memory');
    const benchLodEl = document.getElementById('bench-lod');
    const benchVisibleEl = document.getElementById('bench-visible');
    const benchTimingDetailsEl = document.getElementById('bench-timing-details');
    const benchMinFtEl = document.getElementById('bench-min-ft');
    const benchP95FtEl = document.getElementById('bench-p95-ft');
    const benchMaxFtEl = document.getElementById('bench-max-ft');
    const benchGenInfoEl = document.getElementById('bench-gen-info');
    const benchGenTimeEl = document.getElementById('bench-gen-time');

    // The renderer controls themselves belong to `ui/modules/render-controls`,
    // which `initUI` builds before a saved session is restored. The benchmark
    // report only observes them, so it reads them and never publishes them.
    const hpShaderQuality = document.getElementById('hp-shader-quality');
    const hpFrustumCulling = document.getElementById('hp-frustum-culling');
    const hpLodEnabled = document.getElementById('hp-lod-enabled');

    // FPS monitoring and synthetic generation form the small live runtime.
    // The configuration-matrix harness publishes independently, while the
    // report and bottleneck analyzer remain a third, explicitly requested
    // developer-support graph.
    let perfTracker = null;
    // Off-thread synthetic generation and its point-count rule are captured
    // from their focused modules so the panel keeps a small lazy boundary.
    let generateSyntheticDataOffThread = null;
    let assertSyntheticCount = null;
    let benchmarkHarnessModule = null;
    let benchmarkHarnessModuleLoadTask = null;
    let benchmarkModuleLoaded = false;
    let benchmarkModuleLoadTask = null;
    let benchmarkSupportModule = null;
    let benchmarkSupportModuleLoadTask = null;

    function ensureBenchmarkHarnessModule() {
      if (benchmarkHarnessModule !== null) {
        return Promise.resolve(benchmarkHarnessModule);
      }
      if (benchmarkHarnessModuleLoadTask !== null) {
        return benchmarkHarnessModuleLoadTask;
      }

      const loadTask = loadAppCode(() => import('./ui/modules/benchmark/index.js')).then(
        harnessModule => {
          if (applicationRetired) return null;
          // The configuration-matrix harness is the only thing that can sweep
          // LOD, culling and view count with per-frame upload counters, and it
          // had no entry point in the running app at all: the page is served
          // under `script-src 'self'` with a single hashed inline block, so an
          // inline bootstrap is blocked and a console `import()` of a relative
          // path has no base to resolve against. Publishing the loaded module
          // namespace next to _cellucidViewer / _cellucidState is what makes
          // `createBenchmarkHarness({ viewer, canvas })` reachable. Nothing in
          // the module runs on import; the harness instruments the GL context
          // only when it is explicitly created.
          window._cellucidBenchmarkHarness = harnessModule;
          benchmarkHarnessModule = harnessModule;
          return harnessModule;
        },
        error => {
          console.error('[Main] Failed to load benchmark harness:', error);
          return null;
        }
      );
      benchmarkHarnessModuleLoadTask = loadTask;
      void loadTask.then(harnessModule => {
        if (
          harnessModule === null &&
          benchmarkHarnessModuleLoadTask === loadTask
        ) {
          benchmarkHarnessModuleLoadTask = null;
        }
      });
      return loadTask;
    }

    // Load only the live panel runtime from user activation. In particular,
    // panel readiness must await neither the full measurement harness nor
    // `dev/benchmark.js`: those graphs own matrix runners, report generation,
    // analyzers and GPU instrumentation that live statistics and synthetic
    // generation do not use. Parsing them on a native Firefox main thread that
    // is already rendering smoke can indefinitely delay an otherwise healthy
    // panel. The full harness is requested only after the small live runtime is
    // ready, then publishes through its own independent readiness boundary.
    function ensureBenchmarkModule() {
      if (applicationRetired) return Promise.resolve(false);
      if (benchmarkModuleLoaded) {
        // A failed optional harness fetch resets its own task. A later panel
        // activation must retry it without invalidating the healthy live UI.
        void ensureBenchmarkHarnessModule();
        return Promise.resolve(true);
      }
      if (benchmarkModuleLoadTask !== null) return benchmarkModuleLoadTask;

      const loadTask = (async () => {
        try {
          const [generationModule, generationContract, trackerModule] = await loadAppCode(() => Promise.all([
            import('./ui/modules/benchmark/generation.js'),
            import('./ui/modules/benchmark/generation-contract.js'),
            import('./ui/modules/benchmark/performance-tracker.js')
          ]));
          if (applicationRetired) return false;
          generateSyntheticDataOffThread =
            generationModule.generateSyntheticDataOffThread;
          assertSyntheticCount = generationContract.assertSyntheticCount;
          perfTracker = new trackerModule.PerformanceTracker();
          benchmarkModuleLoaded = true;
          // This optional developer entry point remains reachable from the
          // panel, but it cannot hold live production controls hostage.
          void ensureBenchmarkHarnessModule();
          debug.log('[Main] Live benchmark runtime lazy-loaded');
          return true;
        } catch (err) {
          console.error('[Main] Failed to load live benchmark runtime:', err);
          return false;
        }
      })();
      benchmarkModuleLoadTask = loadTask;
      // A transient fetch, parse, or construction failure cannot permanently
      // turn every later panel activation into the same cached `false` result.
      // Successful loads retain the settled task and the published namespace.
      void loadTask.then(loaded => {
        if (!loaded && benchmarkModuleLoadTask === loadTask) {
          benchmarkModuleLoadTask = null;
        }
      });
      return loadTask;
    }

    function ensureBenchmarkSupportModule() {
      if (benchmarkSupportModule !== null) {
        return Promise.resolve(benchmarkSupportModule);
      }
      if (benchmarkSupportModuleLoadTask !== null) {
        return benchmarkSupportModuleLoadTask;
      }

      const loadTask = loadAppCode(() => import('../dev/benchmark.js')).then(
        module => {
          if (applicationRetired) return null;
          benchmarkSupportModule = module;
          return module;
        },
        error => {
          console.error(
            '[Main] Failed to load benchmark report and analyzer support:',
            error
          );
          return null;
        }
      );
      benchmarkSupportModuleLoadTask = loadTask;
      void loadTask.then(module => {
        if (
          module === null &&
          benchmarkSupportModuleLoadTask === loadTask
        ) {
          benchmarkSupportModuleLoadTask = null;
        }
      });
      return loadTask;
    }

    let benchmarkActive = false;
    let activeDatasetMode = 'real';
    let syntheticDatasetInfo = null;
    let latestPerfSample = null;
    let latestRendererStats = null;
    let perfLoopHandle = null;
    let perfVisibilityListenerActive = false;

    const synchronizePerfTrackerVisibility = () => {
      if (!benchmarkActive || !perfTracker) return;
      if (document.hidden) {
        perfTracker.pause();
      } else {
        perfTracker.resume();
      }
    };

    const rendererConfigSnapshot = () => ({
      shaderQuality: hpShaderQuality?.value || 'full',
      lodEnabled: hpLodEnabled ? hpLodEnabled.checked : true,
      frustumCulling: hpFrustumCulling ? hpFrustumCulling.checked : false,
      renderMode: renderModeSelect ? renderModeSelect.value : null
    });

    const buildDatasetSnapshot = () => {
      if (activeDatasetMode === 'synthetic' && syntheticDatasetInfo) {
        return {
          mode: 'synthetic',
          ...syntheticDatasetInfo,
          visiblePoints: syntheticDatasetInfo.visiblePoints ?? syntheticDatasetInfo.pointCount,
          filters: [],
          activeFieldKey: null,
          activeFieldKind: null
        };
      }
      const filtered = state.getFilteredCount ? state.getFilteredCount() : null;
      const activeField = state.getActiveField ? state.getActiveField() : null;
      const filters = state.getActiveFiltersStructured ? state.getActiveFiltersStructured() : [];
      return {
        mode: 'real',
        pointCount: state.pointCount || 0,
        visiblePoints: filtered?.shown ?? state.pointCount,
        activeFieldKey: activeField?.key || null,
        activeFieldKind: activeField?.kind || null,
        filters
      };
    };

    const formatMs = (val) => {
      if (val == null) return null;
      return typeof val === 'number' ? val.toFixed(2) : String(val);
    };

    const ensureBenchmarkStatsVisible = () => {
      if (benchmarkStatsEl) {
        benchmarkStatsEl.hidden = false;
      }
    };

    // Use the HTML-selected pattern by default (GLB in markup); no override here

    const renderBenchmarkStats = (stats, hpStats, datasetSnapshot) => {
      const pointCount = datasetSnapshot?.pointCount ?? 0;
      const visiblePoints = datasetSnapshot?.visiblePoints ?? pointCount;
      const generationMs = datasetSnapshot?.generationMs ?? null;

      if (benchPointsEl) benchPointsEl.textContent = formatNumber(visiblePoints ?? pointCount ?? 0);
      if (benchVisibleEl) benchVisibleEl.textContent = formatNumber(visiblePoints ?? pointCount ?? 0);

      if (benchMemoryEl) {
        benchMemoryEl.textContent =
          formatBenchmarkGpuMemory(hpStats, pointCount);
      }

      if (benchGenInfoEl && benchGenTimeEl) {
        if (generationMs != null) {
          benchGenTimeEl.textContent = generationMs;
          benchGenInfoEl.hidden = false;
        } else {
          benchGenInfoEl.hidden = true;
        }
      }

      if (stats && stats.samples > 1) {
        const displayFps = stats?.fps ?? hpStats?.fps ?? 0;
        const displayFrameTime = formatMs(stats?.avgFrameTime ?? hpStats?.lastFrameTime);
        const renderFrameTime = formatMs(hpStats?.lastFrameTime);

        if (benchFpsEl) {
          benchFpsEl.textContent = displayFps ?? '-';
        }
        if (benchFrametimeEl) {
          benchFrametimeEl.textContent = displayFrameTime != null ? `${displayFrameTime} ms` : '-';
        }
        if (benchRendertimeEl) {
          // Main-thread time spent issuing the last frame, not GPU time. Under
          // the page's coarse timer it often reads 0.00, which says nothing.
          const cpuShown = renderFrameTime != null && renderFrameTime !== '0.00';
          benchRendertimeEl.textContent = cpuShown ? `CPU ${renderFrameTime} ms` : '';
          benchRendertimeEl.hidden = !cpuShown;
        }

        if (stats.samples >= 30 && benchTimingDetailsEl) {
          benchTimingDetailsEl.hidden = false;
          // Format timing values with 2 decimal places
          const formatTiming = (val) => typeof val === 'number' ? val.toFixed(2) : val;
          if (benchMinFtEl) benchMinFtEl.textContent = formatTiming(stats.minFrameTime) + ' ms';
          if (benchP95FtEl) benchP95FtEl.textContent = formatTiming(stats.p95FrameTime) + ' ms';
          if (benchMaxFtEl) benchMaxFtEl.textContent = formatTiming(stats.maxFrameTime) + ' ms';
        } else if (benchTimingDetailsEl) {
          benchTimingDetailsEl.hidden = true;
        }
      } else {
        if (benchFpsEl) benchFpsEl.textContent = '-';
        if (benchFrametimeEl) benchFrametimeEl.textContent = '-';
        if (benchRendertimeEl) benchRendertimeEl.hidden = true;
        if (benchTimingDetailsEl) benchTimingDetailsEl.hidden = true;
      }

      if (hpStats) {
        if (benchLodEl) benchLodEl.textContent = hpStats.lodLevel === -1 ? 'Full' : `Level ${hpStats.lodLevel}`;
        if (benchVisibleEl) benchVisibleEl.textContent = formatNumber(hpStats.visiblePoints ?? visiblePoints ?? 0);
      } else {
        if (benchLodEl) benchLodEl.textContent = '-';
      }
    };

    const startPerfMonitoring = ({ resetTracker = false } = {}) => {
      if (applicationRetired) return;
      // perfTracker is lazy-loaded; if not available yet, skip monitoring
      if (!perfTracker) {
        console.warn('[Main] Performance tracker not loaded yet');
        return;
      }

      ensureBenchmarkStatsVisible();

      if (resetTracker || !benchmarkActive) {
        perfTracker.start();
      }
      benchmarkActive = true;
      if (!perfVisibilityListenerActive) {
        document.addEventListener(
          'visibilitychange',
          synchronizePerfTrackerVisibility
        );
        perfVisibilityListenerActive = true;
      }
      synchronizePerfTrackerVisibility();

      const tick = () => {
        if (!benchmarkActive) {
          perfLoopHandle = null;
          return;
        }

        const stats = perfTracker.recordFrame();
        const activeViewId = state.getActiveViewId();
        const hpStats = viewer.hasRendererStats(activeViewId)
          ? viewer.getRendererStats(activeViewId)
          : null;
        if (stats) latestPerfSample = stats;
        if (hpStats) latestRendererStats = hpStats;

        const datasetSnapshot = buildDatasetSnapshot();
        renderBenchmarkStats(stats, hpStats, datasetSnapshot);

        perfLoopHandle = requestAnimationFrame(tick);
      };

      if (!perfLoopHandle) {
        perfLoopHandle = requestAnimationFrame(tick);
      }
    };

    stopPerfMonitoring = () => {
      benchmarkActive = false;
      if (perfVisibilityListenerActive) {
        document.removeEventListener(
          'visibilitychange',
          synchronizePerfTrackerVisibility
        );
        perfVisibilityListenerActive = false;
      }
      if (perfTracker) {
        perfTracker.stop();
      }
      if (perfLoopHandle) {
        cancelAnimationFrame(perfLoopHandle);
        perfLoopHandle = null;
      }
    };

    const activateBenchmarkingPanel = ({ resetTracker = false } = {}) => {
      renderBenchmarkStats(
        null,
        null,
        buildDatasetSnapshot()
      );
      startPerfMonitoring({ resetTracker });
    };

    // Initialize benchmarking state for real data; monitoring starts when the benchmarking accordion opens
    activeDatasetMode = 'real';
    syntheticDatasetInfo = null;

    if (benchmarkSection) {
      const benchmarkSummary = benchmarkSection.querySelector(
        ':scope > summary'
      );
      if (!(benchmarkSummary instanceof HTMLElement)) {
        throw new TypeError(
          'Performance benchmark disclosure requires its direct summary.'
        );
      }
      const reportBenchmarkPanelFailure = error => {
        const exactError = error instanceof Error
          ? error
          : new Error(String(error));
        console.error(
          '[Main] Performance benchmark panel could not be changed:',
          exactError
        );
        try {
          notifications.error(
            `${PLACES.benchmark.name} panel was not changed: ` +
            `${exactError.message}`,
            {
              category: 'rendering',
              title: 'Renderer setting unavailable'
            }
          );
        } catch (notificationError) {
          // Panel state is already coherent. Notification delivery is
          // observational and must not escape the synchronous DOM event.
          console.error(
            '[Main] Benchmark panel failure notification was not delivered:',
            notificationError
          );
        }
      };
      const publishBenchmarkPanelState = () => {
        if (applicationRetired) return;
        if (benchmarkSection.open) {
          // The summary activation and the native toggle notification can both
          // settle the same opening. Only the first owns tracker reset/start.
          if (!benchmarkActive) {
            activateBenchmarkingPanel({ resetTracker: true });
          }
        } else if (benchmarkActive) {
          stopPerfMonitoring();
        }
      };
      const synchronizeBenchmarkPanelWithSection = async () => {
        if (benchmarkSection.open) {
          // Lazy-load benchmark module when section is first opened
          const moduleLoaded = await ensureBenchmarkModule();
          if (!moduleLoaded || applicationRetired) return;
        }
        publishBenchmarkPanelState();
      };
      const ownBenchmarkPanelSynchronization = () => {
        synchronizeBenchmarkPanelWithSection().catch(
          reportBenchmarkPanelFailure
        );
      };
      const ownBenchmarkSummaryActivation = () => {
        // `toggle` is a queued notification. A stressed native Firefox GPU
        // service can continue to render and service automation while delaying
        // that notification indefinitely. The summary's click is the actual
        // user activation, so initiate the live module request in this task.
        // It starts the independent harness request only after live readiness;
        // once the live graph settles, the browser's default action has already
        // published the exact `open` state and this owner can reconcile it.
        ensureBenchmarkModule().then(moduleLoaded => {
          if (!moduleLoaded || applicationRetired) return;
          publishBenchmarkPanelState();
        }).catch(reportBenchmarkPanelFailure);
      };
      benchmarkSummary.addEventListener(
        'click',
        ownBenchmarkSummaryActivation
      );
      benchmarkSection.addEventListener(
        'toggle',
        ownBenchmarkPanelSynchronization
      );
      // A `<details>` opens itself: the browser toggles it on a summary click
      // with no script involved, and this listener did not exist to see the
      // ones that happened while the bootstrap above was still running. Left
      // unreconciled, that click opens an empty panel, the next click closes
      // it, and only the third loads anything. Reading the state the listener
      // was attached to is what makes the first click count.
      ownBenchmarkPanelSynchronization();
    }

    /**
     * Tell the user their synthetic data load was overtaken.
     *
     * Every superseded exit used to return `false` in silence, so a click that
     * landed while a dataset change was still settling looked identical to a
     * dead button: nothing rendered, nothing was logged, and the run's own
     * notification had already been dismissed.
     *
     * @returns {false} Always, so a superseded exit reads as one statement.
     */
    function reportSupersededBenchmark() {
      notifications.warning(
        'Synthetic data load was superseded by a newer dataset change. ' +
        'Nothing was replaced — run it again once the current load settles.',
        { category: 'benchmark', title: 'Benchmark superseded' }
      );
      return false;
    }

    // A run is a dataset change like any other: it supersedes the load in
    // flight when the user starts it, and a later choice supersedes it.
    async function runBenchmark(pointCount, pattern) {
      const syntheticTransaction = datasetReloadCoordinator.begin();
      try {
        return await runSyntheticBenchmark(
          syntheticTransaction,
          pointCount,
          pattern
        );
      } finally {
        syntheticTransaction.finish();
      }
    }

    async function runSyntheticBenchmark(
      syntheticTransaction,
      pointCount,
      pattern
    ) {
      // Ensure benchmark module is loaded before running
      const moduleLoaded = await ensureBenchmarkModule();
      if (!syntheticTransaction.isCurrent()) return reportSupersededBenchmark();
      syntheticTransaction.assertCurrent();
      if (
        !moduleLoaded ||
        !generateSyntheticDataOffThread ||
        !assertSyntheticCount
      ) {
        console.error('[Main] Cannot run benchmark: synthetic generation is not available');
        notifications.error('Benchmark module failed to load', { category: 'benchmark' });
        return false;
      }

      // The control's declared range is only advertised until something
      // enforces it. Check before the run is announced, so an out-of-range
      // request is refused by name rather than surfacing as a failed
      // multi-gigabyte allocation.
      try {
        assertSyntheticCount(pointCount);
      } catch (error) {
        notifications.error(
          error instanceof Error ? error.message : String(error),
          { category: 'benchmark', title: 'Point count out of range' }
        );
        return false;
      }

      debug.log(`Running benchmark: ${formatNumber(pointCount)} ${countNoun(pointCount, 'point')} (${pattern})`);

      // Show notification for benchmark data generation
      const benchNotifId = notifications.startDataGeneration(pattern, pointCount);
      let candidateDimensionManager = null;
      const dismissSupersededBenchmark = ({ retireCandidate = false } = {}) => {
        try {
          if (
            retireCandidate &&
            candidateDimensionManager !== null &&
            candidateDimensionManager !== dimensionManager
          ) {
            runtimeRetirementOwner.retire(candidateDimensionManager);
          }
        } finally {
          notifications.dismiss(benchNotifId);
        }
        return reportSupersededBenchmark();
      };

      ensureBenchmarkStatsVisible();
      if (benchFpsEl) benchFpsEl.textContent = '-';
      if (benchFrametimeEl) benchFrametimeEl.textContent = '-';
      if (benchRendertimeEl) benchRendertimeEl.hidden = true;
      if (benchTimingDetailsEl) benchTimingDetailsEl.hidden = true;
      if (benchGenInfoEl) benchGenInfoEl.hidden = true;

      // Generate off the main thread. Every pattern costs six to twenty-five
      // transcendental calls per point in one uninterruptible loop, so running
      // it here froze the tab for the whole of it, in proportion to the point
      // count: medians of 32 ms at 100k, 186 ms at 1M and 3,481 ms at 20M on
      // one machine, with no frame drawn, no progress reported and no way to
      // cancel. The worker builds the same arrays from the same seed and
      // transfers them back, so the main thread's exposure stops scaling with
      // the count, and the reload transaction's signal terminates the worker
      // when a newer dataset change overtakes this run.
      let data;
      const genStart = performance.now();
      try {
        if (pattern === 'glb') {
          notifications.updateBenchmark(benchNotifId, 10, 'Loading GLB model...');
        }
        data = await generateSyntheticDataOffThread({
          pattern,
          count: pointCount,
          signal: syntheticTransaction.signal
        });
      } catch (err) {
        if (!syntheticTransaction.isCurrent()) {
          return dismissSupersededBenchmark();
        }
        console.error('Failed to generate data:', err);
        const message = pattern === 'glb'
          ? `GLB load failed: ${err.message || err}`
          : `Error: ${err.message || err}`;
        notifications.fail(benchNotifId, `Benchmark failed: ${message}`);
        return false;
      }
      if (!syntheticTransaction.isCurrent()) {
        return dismissSupersededBenchmark();
      }
      syntheticTransaction.assertCurrent();
      const genTime = Math.round(performance.now() - genStart);
      try {
        if (
          !Number.isSafeInteger(pointCount) ||
          pointCount < 1 ||
          ![1, 2, 3].includes(data.dimensionLevel) ||
          !(data.positions instanceof Float32Array) ||
          data.positions.length !== pointCount * data.dimensionLevel ||
          !(data.colors instanceof Uint8Array) ||
          data.colors.length !== pointCount * 4
        ) {
          throw new TypeError(
            'Synthetic benchmark data must contain exact dataset-length ' +
            'Float32 positions (dimensionLevel values per point) and ' +
            'Uint8 RGBA arrays.'
          );
        }
        candidateDimensionManager = createInMemoryDimensionManager({
          positions: data.positions,
          dimension: data.dimensionLevel,
          representations: syntheticRepresentations(
            data.positions,
            data.dimensionLevel,
            benchmarkRepresentationsSelect?.value ?? 'one'
          )
        });
      } catch (error) {
        console.error('Failed to stage benchmark data:', error);
        notifications.fail(
          benchNotifId,
          `Benchmark failed: ${error.message}`
        );
        return false;
      }

      const syntheticStage = Object.freeze({
        colors: data.colors,
        dimensionLevel: data.dimensionLevel,
        dimensionManager: candidateDimensionManager,
        positions: data.positions,
        runtimeKind: 'synthetic'
      });
      const previousRuntimeStage = activeRuntimeStage;
      const previousPublication = activeDatasetPublication;
      let syntheticPublication;
      try {
        await cancelPublishedDatasetStateAndWait();
        if (!syntheticTransaction.isCurrent()) {
          return dismissSupersededBenchmark({
            retireCandidate: true
          });
        }
        syntheticTransaction.assertCurrent();
      } catch (error) {
        if (!syntheticTransaction.isCurrent()) {
          return dismissSupersededBenchmark({
            retireCandidate: true
          });
        }
        try {
          runtimeRetirementOwner.retire(candidateDimensionManager);
        } catch (retirementError) {
          throw new AggregateError(
            [error, retirementError],
            'Published state cancellation and benchmark retirement failed.'
          );
        }
        console.error(
          'Failed to cancel the current dataset state:',
          error
        );
        notifications.fail(
          benchNotifId,
          `Benchmark failed: ${error instanceof Error
            ? error.message
            : String(error)}`
        );
        return false;
      }
      try {
        syntheticPublication =
          commitSyntheticRuntimeStage(syntheticStage);
      } catch (error) {
        const publicationErrors = [error];
        try {
          restorePreviousRuntime(previousRuntimeStage, previousPublication);
        } catch (restorationError) {
          publicationErrors.push(restorationError);
        }
        try {
          runtimeRetirementOwner.retire(candidateDimensionManager);
        } catch (retirementError) {
          publicationErrors.push(retirementError);
        }
        const exactError = publicationErrors.length === 1
          ? error
          : new AggregateError(
              publicationErrors,
              'Synthetic benchmark publication, restoration, or retirement failed.'
            );
        console.error('Failed to publish benchmark data:', exactError);
        notifications.fail(
          benchNotifId,
          `Benchmark failed: ${exactError.message}`
        );
        return false;
      }

      // The exact DataState generation is now live. Publish the matching app
      // runtime and retire every previous dataset-count owner synchronously.
      const synchronizationOutcome = await settlePublishedDatasetUi({
        synchronize: async () => {
          assertCurrentDatasetPublication(syntheticPublication);
          try {
            await ui?.settleFieldInteractions?.();
          } finally {
            assertCurrentDatasetPublication(syntheticPublication);
          }
          connectivityRuntimeOwner.synchronizeDatasetPublication();
          // A synthetic scene has no data mapping; the panel says so.
          ui?.refreshDataMapping?.();
          if (window._comparisonModule) {
            try {
              await window._comparisonModule.resetForDatasetReload({
                reason: 'synthetic-benchmark-publication'
              });
            } finally {
              assertCurrentDatasetPublication(syntheticPublication);
            }
          }
        },
        finalize: () => {
          retireReplacedDimensionManager(syntheticPublication);
        },
        reportFailure: error => {
          if (syntheticPublication.isCurrent() !== true) return;
          console.error(
            '[Main] Synthetic benchmark was published, but cleanup failed:',
            error
          );
          notifications.error(
            `Benchmark data is visible, but prior resources could not be ` +
            `fully released: ${error instanceof Error ? error.message : String(error)}`,
            {
              category: 'benchmark',
              duration: 0,
              title: 'Benchmark cleanup incomplete'
            }
          );
        }
      });
      if (
        synchronizationOutcome.status === 'superseded' ||
        syntheticPublication.isCurrent() !== true
      ) {
        return dismissSupersededBenchmark();
      }
      assertCurrentDatasetPublication(syntheticPublication);

      // Ensure point rendering mode only after the complete replacement has
      // succeeded, so a rejected benchmark preserves the previous runtime.
      if (renderModeSelect && renderModeSelect.value !== 'points') {
        const applied = ui.applyRenderMode('points');
        if (applied !== true || renderModeSelect.value !== 'points') {
          throw new Error(
            'Synthetic benchmark publication could not settle exact Points mode.'
          );
        }
      }

      notifications.completeDataGeneration(benchNotifId, genTime);

      // Show generation time
      if (benchGenInfoEl && benchGenTimeEl) {
        benchGenTimeEl.textContent = genTime;
        benchGenInfoEl.hidden = false;
      }

      const syntheticDimLevel = data.dimensionLevel;

      activeDatasetMode = 'synthetic';
      syntheticDatasetInfo = {
        pointCount,
        pattern,
        generationMs: genTime,
        visiblePoints: pointCount,
        dimensionLevel: syntheticDimLevel
      };

      const gpuMemEstimateMB =
        estimateBenchmarkGpuMemoryMB(pointCount);

      // Refresh stat panel immediately and start perf tracking loop
      activateBenchmarkingPanel({ resetTracker: true });

      debug.log(
        `Benchmark loaded: ${formatNumber(pointCount)} ${countNoun(pointCount, 'point')}, ` +
        `~${gpuMemEstimateMB.toFixed(1)}MB estimated GPU memory ` +
        `(gen: ${genTime}ms)`
      );
      return true;
    }

    // The situation report and the bottleneck analysis both measure drawn
    // cells, and None leaves none to draw: no frame would ever publish the
    // renderer statistics they read.
    const NO_CELLS_TO_MEASURE =
      'Load a dataset or generate benchmark data first.';

    async function generateSituationReport() {
      if (viewer.getPointCount() === 0) {
        notifications.info(NO_CELLS_TO_MEASURE, { category: 'benchmark' });
        return;
      }
      const [runtimeLoaded, supportModule] = await Promise.all([
        ensureBenchmarkModule(),
        ensureBenchmarkSupportModule()
      ]);
      if (
        !runtimeLoaded ||
        typeof supportModule?.BenchmarkReporter !== 'function'
      ) {
        console.warn(
          '[Main] Benchmark report support is unavailable; report not generated'
        );
        notifications.error('Benchmark module not available', { category: 'benchmark' });
        return;
      }

      // Create benchmarkReporter lazily on first use
      if (!benchmarkReporter) {
        benchmarkReporter = new supportModule.BenchmarkReporter({
          viewer,
          state,
          canvas
        });
      }

      // Show notification for report generation
      const reportNotifId = notifications.startReport();

      const datasetSnapshot = buildDatasetSnapshot();
      const activeViewId = state.getActiveViewId();
      if (!viewer.hasRendererStats(activeViewId)) {
        notifications.failCalculation(
          reportNotifId,
          'Renderer statistics are not ready; wait for the first rendered frame'
        );
        return;
      }
      const rendererStats = viewer.getRendererStats(activeViewId);
      if (rendererStats) latestRendererStats = rendererStats;
      const report = benchmarkReporter.buildReport({
        dataset: datasetSnapshot,
        rendererConfig: rendererConfigSnapshot(),
        rendererStats: latestRendererStats,
        perfStats: latestPerfSample,
        filteredCount: datasetSnapshot.mode === 'real' && state.getFilteredCount ? state.getFilteredCount() : null,
        filters: datasetSnapshot.mode === 'real' ? datasetSnapshot.filters : [],
        activeField: datasetSnapshot.mode === 'real' && state.getActiveField ? state.getActiveField() : null
      });

      const yamlOutput = report.yaml();
      if (benchmarkReportOutput) {
        benchmarkReportOutput.value = yamlOutput;
        benchmarkReportOutput.hidden = false;
      }

      let copiedToClipboard = false;
      if (navigator?.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(yamlOutput);
          copiedToClipboard = true;
        } catch (err) {
          console.warn('Clipboard copy failed', err);
          notifications.error('Copy failed — select the text manually.', { category: 'benchmark' });
        }
      }

      // Complete notification
      notifications.completeReport(reportNotifId, copiedToClipboard);
    }

    /**
     * Read the requested point count from the control.
     *
     * `parseInt` read the field's exponent form — a typed `1e9` became one
     * point — and accepted a trailing suffix. The field is an exact integer
     * count, so parse it as one and let `runBenchmark` refuse anything the
     * declared range excludes.
     *
     * @returns {number} The requested count, or NaN when the field is unusable.
     */
    function readBenchmarkPointCount() {
      const raw = (benchmarkCountInput?.value ?? '').trim();
      // A cleared field means the control's own default, which is declared in
      // the markup beside its min and max rather than restated here.
      return Number(raw === '' ? benchmarkCountInput?.defaultValue : raw);
    }

    /**
     * Start a run from a control and own its outcome.
     *
     * `runBenchmark` can reject — publication failures throw — and a dropped
     * promise turns that into an unhandled rejection the user never sees. It
     * reports every `false` outcome itself, so only the rejection needs a home.
     *
     * @param {number} count - Requested point count.
     * @param {string} pattern - Requested synthetic pattern.
     */
    function startBenchmarkRun(count, pattern) {
      runBenchmark(count, pattern).catch(error => {
        console.error('[Main] Synthetic benchmark failed:', error);
        notifications.error(
          `Synthetic data load failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { category: 'benchmark', title: 'Benchmark failed' }
        );
      });
    }

    // Wire up run button
    if (benchmarkRunBtn) {
      benchmarkRunBtn.addEventListener('click', () => {
        const pattern = benchmarkPatternSelect?.value || 'clusters';
        startBenchmarkRun(readBenchmarkPointCount(), pattern);
      });
    }

    if (benchmarkReportBtn) {
      benchmarkReportBtn.addEventListener('click', () => {
        generateSituationReport().catch(error => {
          console.error('[Main] Situation report failed:', error);
          notifications.error(
            `Situation report failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { category: 'benchmark', title: 'Report failed' }
          );
        });
      });
    }

    // Wire up preset buttons
    benchPresets.forEach(btn => {
      btn.addEventListener('click', () => {
        const count = Number(btn.dataset.count);
        if (benchmarkCountInput) benchmarkCountInput.value = count;
        const pattern = benchmarkPatternSelect?.value || 'clusters';
        startBenchmarkRun(count, pattern);
      });
    });

    // ========================================
    // BOTTLENECK ANALYSIS (Single Button)
    // ========================================
    const bottleneckAnalyzeBtn = document.getElementById('bottleneck-analyze-btn');
    const bottleneckProgress = document.getElementById('bottleneck-progress');
    const bottleneckProgressText = document.getElementById('bottleneck-progress-text');
    const bottleneckResults = document.getElementById('bottleneck-results');

    // Helper to format numbers with K/M suffix
    const formatNumShort = (num) => {
      if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
      if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
      return String(Math.round(num));
    };

    if (bottleneckAnalyzeBtn) {
      bottleneckAnalyzeBtn.addEventListener('click', async () => {
        if (viewer.getPointCount() === 0) {
          notifications.info(NO_CELLS_TO_MEASURE, { category: 'benchmark' });
          return;
        }
        const hpRenderer = viewer.getHPRenderer();

        const [runtimeLoaded, supportModule] = await Promise.all([
          ensureBenchmarkModule(),
          ensureBenchmarkSupportModule()
        ]);
        if (
          !runtimeLoaded ||
          typeof supportModule?.BottleneckAnalyzer !== 'function'
        ) {
          notifications.error(
            'Benchmark analyzer is not available',
            { category: 'benchmark' }
          );
          return;
        }
        const BottleneckAnalyzer = supportModule.BottleneckAnalyzer;

        const canvas = document.querySelector('canvas');
        const gl = canvas?.getContext('webgl2');

        if (!gl) {
          alert('WebGL2 not available. Cellucid requires WebGL2.');
          return;
        }

        // Show progress
        bottleneckAnalyzeBtn.disabled = true;
        bottleneckAnalyzeBtn.textContent = 'Analyzing...';
        if (bottleneckProgress) bottleneckProgress.hidden = false;
        if (bottleneckResults) bottleneckResults.hidden = true;

        try {
          const analyzer = new BottleneckAnalyzer(gl, hpRenderer, viewer);

          const results = await analyzer.runAnalysis({
            warmupFrames: 30,
            testFrames: 100
          });

          // Hide progress, show results
          if (bottleneckProgress) bottleneckProgress.hidden = true;
          if (bottleneckResults) bottleneckResults.hidden = false;

          const s = results.summary;
          const b = results.bottleneckType;
          const recs = results.recommendations;
          const fps = s.performance.fps;

          // Build verdict
          const verdictBox = document.getElementById('bn-verdict-box');
          const verdictTitle = document.getElementById('bn-verdict-title');
          const verdictDetail = document.getElementById('bn-verdict-detail');

          let verdictText, detailText, status;

          if (fps >= 55) {
            status = 'good';
            verdictText = 'Performance is good';
            detailText = 'Running smoothly at ' + fps.toFixed(0) + ' FPS. No issues detected.';
          } else if (fps >= 30) {
            status = 'warning';
            verdictText = 'Performance could be better';
            detailText = b.primary.type + ' is the main bottleneck. ' + (b.primary.evidence || '');
          } else {
            status = 'danger';
            verdictText = 'Serious performance problem';
            detailText = b.primary.type + ' is severely limiting performance. ' + (b.primary.evidence || '');
          }

          // The status drives both the panel tint and which decorative glyph
          // CSS reveals; no icon character is written from script.
          if (verdictBox) {
            verdictBox.dataset.status = status;
          }
          if (verdictTitle) {
            verdictTitle.textContent = verdictText;
          }
          if (verdictDetail) {
            verdictDetail.textContent = detailText;
          }

          // FPS display
          const bnFps = document.getElementById('bn-fps');
          if (bnFps) {
            bnFps.textContent = fps.toFixed(0);
            bnFps.dataset.status = status;
          }

          // Build problem list
          const problemList = document.getElementById('bn-problem-list');
          if (problemList) {
            /**
             * @param {string} text
             * @param {{ status?: 'good' | 'warning' | 'danger' }} [options]
             * @returns {HTMLDivElement}
             */
            const createListItem = (text, options = {}) => {
              const el = document.createElement('div');
              el.className = 'bn-list-item';
              if (options.status) el.dataset.status = options.status;
              el.textContent = text;
              return el;
            };

            /** @type {HTMLDivElement[]} */
            const items = [];

            // Add main bottleneck
            if (fps < 55) {
              const el = document.createElement('div');
              el.className = 'bn-list-item';
              el.dataset.status = status;
              el.append('• ');
              const strong = document.createElement('strong');
              strong.textContent = b.primary.type;
              el.append(strong);
              el.append(`: ${b.primary.evidence || 'Main limiting factor'}`);
              items.push(el);
            }

            // Add contributing factors
            for (const c of b.contributing) {
              items.push(createListItem(`• ${c.type}: ${c.evidence}`, { status: 'warning' }));
            }

            // Add jank/stuttering issues
            if (s.frameStability && s.frameStability.hasJank) {
              const severity = s.frameStability.jankSeverity;
              const stutterStatus = severity === 'mild' ? 'warning' : 'danger';
              // Severity is stated in words, not colour or an icon character.
              items.push(createListItem(`• Frame stuttering (${severity}): ${s.frameStability.diagnosis} (${s.frameStability.jankPercent} janky frames)`, { status: stutterStatus }));
            }

            // Add CPU/JS health issues
            if (s.cpuHealth && s.cpuHealth.issues && s.cpuHealth.issues.length > 0) {
              for (const issue of s.cpuHealth.issues.slice(0, 2)) {
                items.push(createListItem(`• ${issue}`, { status: 'warning' }));
              }
            }

            if (items.length === 0) {
              items.push(createListItem('No significant problems found', { status: 'good' }));
            }

            problemList.innerHTML = '';
            for (const item of items) problemList.appendChild(item);
          }

          // Build fix list
          const fixList = document.getElementById('bn-fix-list');
          if (fixList && recs.recommendations.length > 0) {
            fixList.innerHTML = '';
            for (const rec of recs.recommendations.slice(0, 3)) {
              const item = document.createElement('div');
              item.className = 'bn-list-item';
              const title = document.createElement('div');
              title.className = 'bn-fix-title';
              title.textContent = rec.title;
              const action = document.createElement('div');
              action.className = 'bn-fix-action';
              action.textContent = rec.actions?.[0] || '';
              item.append(title, action);
              fixList.appendChild(item);
            }
          } else if (fixList) {
            fixList.innerHTML = '';
            const ok = document.createElement('div');
            ok.className = 'bn-list-item';
            ok.dataset.status = 'good';
            ok.textContent = 'No changes needed - performance is good!';
            fixList.appendChild(ok);
          }

          // Populate detailed stats
          const bnVisiblePoints = document.getElementById('bn-visible-points');
          const bnGpuMemory = document.getElementById('bn-gpu-memory');
          const bnLodLevel = document.getElementById('bn-lod-level');
          const bnDrawCalls = document.getElementById('bn-draw-calls');
          const bnFrametime = document.getElementById('bn-frametime');
          const bnP95 = document.getElementById('bn-p95');
          const bnLodOverhead = document.getElementById('bn-lod-overhead');
          const bnFrustumOverhead = document.getElementById('bn-frustum-overhead');
          const bnPointSizeResponse = document.getElementById('bn-point-size-response');

          if (bnVisiblePoints) bnVisiblePoints.textContent = formatNumShort(s.rendering.visiblePoints);
          if (bnGpuMemory) {
            bnGpuMemory.textContent =
              `${s.rendering.gpuMemoryMB}MB` +
              (s.rendering.gpuMemoryEstimated
                ? ' (estimate)'
                : '');
          }
          if (bnLodLevel) bnLodLevel.textContent = Math.round(s.rendering.lodLevel);
          if (bnDrawCalls) bnDrawCalls.textContent = Math.round(s.rendering.drawCalls);
          if (bnFrametime) bnFrametime.textContent = s.performance.avgFrameTimeMs.toFixed(1) + 'ms';
          if (bnP95) bnP95.textContent = s.performance.p95FrameTimeMs.toFixed(1) + 'ms';
          if (bnLodOverhead) bnLodOverhead.textContent = s.overhead.lodMs + 'ms';
          if (bnFrustumOverhead) bnFrustumOverhead.textContent = s.overhead.frustumCullingMs + 'ms';
          if (bnPointSizeResponse) bnPointSizeResponse.textContent = s.bottleneck.pointSizeResponse;

          // Frame stability and CPU health stats
          const bnFrameStability = document.getElementById('bn-frame-stability');
          const bnJankPercent = document.getElementById('bn-jank-percent');
          const bnCpuHealth = document.getElementById('bn-cpu-health');

          if (s.frameStability) {
            if (bnFrameStability) {
              const stability = s.frameStability.hasJank ? s.frameStability.jankSeverity : 'stable';
              const stabilityStatus = stability === 'stable' ? 'good' : stability === 'mild' ? 'warning' : 'danger';
              bnFrameStability.textContent = stability;
              bnFrameStability.dataset.status = stabilityStatus;
            }
            if (bnJankPercent) bnJankPercent.textContent = s.frameStability.jankPercent;
          }

          if (s.cpuHealth && bnCpuHealth) {
            const health = s.cpuHealth.health || 'unknown';
            const healthStatus = health === 'good' ? 'good' : health === 'fair' ? 'warning' : 'danger';
            bnCpuHealth.textContent = health;
            bnCpuHealth.dataset.status = healthStatus;
          }

          // Log to console too
          debug.log('[Bottleneck Analysis]', results);

        } catch (err) {
          console.error('[Bottleneck] Analysis failed:', err);
          if (bottleneckProgress) bottleneckProgress.hidden = true;
          alert('Analysis failed: ' + err.message);
        } finally {
          bottleneckAnalyzeBtn.disabled = false;
          bottleneckAnalyzeBtn.textContent = 'Analyze Performance';
        }
      });
    }

    // Every renderer and benchmark listener above now exists, so the controls
    // they act on can be offered. Nothing between here and the retirement at
    // the top of this bootstrap may read those controls as accepted state.
    admitDeferredControls();

    // Define onboarding callback functions now that UI is ready
    toggleSidebarVisibility = () => {
      const sidebarToggleBtn = document.getElementById('sidebar-toggle');
      if (sidebarToggleBtn) {
        sidebarToggleBtn.click();
      }
    };

    // 1, 2 and 3: the dimension's default in the selected view, then each of
    // its other enabled representations in turn.
    cycleRepresentation = (dim) => {
      void ui?.cycleRepresentation?.(dim);
    };

    clearActivePageHighlights = () => {
      if (state.clearActivePageHighlights) {
        state.clearActivePageHighlights();
      }
    };

    setNavigationMode = (mode) => {
      const navigationModeSelect = document.getElementById('navigation-mode');
      if (navigationModeSelect) {
        navigationModeSelect.value = mode;
        navigationModeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };

    viewer.start();

    // Every control and the render loop now exist, so the startup selection
    // loads as one ordinary dataset change: its progress is the data
    // controls' own, and any dataset choice the user makes while it loads —
    // a sample, None, a file, a connection, the benchmark — supersedes it.
    // A dataset that does not open leaves Cellucid running without it (its
    // opening says why); any other failure no newer choice superseded ends
    // startup.
    let startupOutcome = 'none';
    // Cancelled while startup resolved it: Cellucid starts without it.
    if (startupSelection !== null && !startupOpening.cancelled) {
      try {
        startupOutcome = await ui.loadStartupDataset(startupSelection);
      } catch (error) {
        // Data that did not open, or stopped arriving before its first view;
        // a stall after it (the published default view) is still terminal.
        const dataFailed = error instanceof DataSourceError
          || isExplainedFailure(error)
          || (error?.code === STARTUP_STALL_CODE
            && (error.phase === 'dataset' || error.phase === 'positions'));
        if (!dataFailed) throw error;
        startupOutcome = 'failed';
        const launchParameters =
          STARTUP_LAUNCH_PARAMETERS[startupSelection.sourceType] ?? [];
        failStartupData(
          error,
          launchParameters.some(name => urlParams.has(name))
            ? 'Cellucid could not read the dataset this link opens.'
            : 'Cellucid could not read the dataset it was opening.',
          launchParameters
        );
      }
      // A viewer host: it is told the viewer is ready only once its own
      // dataset is on screen. A dataset the user chose instead in this
      // viewer is not the one Python's indices describe.
      if (viewerHostSource !== null && startupOutcome === 'ready') {
        await startup.step(
          'ui',
          "the viewer's host",
          () => viewerHostSource.notifyReady({
            nCells: state.pointCount,
            dimensions: state.getDimensionLevel()
          })
        );
      }
    }
    startup.enter('ready');
    // Opened, or startup showed none: a failure was said where it happened.
    if (startupOutcome === 'ready') startupOpening.end();
    else startupOpening.dismiss();
    analytics.trackAppReady({
      viewer,
      hasDataset: startupOutcome === 'ready'
    });
  } catch (thrown) {
    const startupError = normalizeStartupError(thrown);
    startup.retire(startupError);
    startupOpening?.fail(startupError);
    console.error('[Main] Terminal startup failure:', startupError);
    if (destroyApplication !== null) {
      void destroyApplication().catch(error => {
        console.error('[Main] Terminal startup teardown failed:', error);
      });
    }
    publishStartupFailure({
      documentOwner: document,
      error: startupError,
      statsElement: statsEl
    });
    analytics.trackStartupFailure({
      phase: startup.phase,
      error: startupError
    });
  }
})();
