/**
 * @fileoverview Application entry point.
 *
 * Orchestrates:
 * - Dataset + data source selection (URL params, local prepared exports, remote/GitHub/Jupyter sources)
 * - Data loading (points, manifests, connectivity)
 * - Initialization wiring (Viewer, DataState, UI coordinator, state serializer, analysis module)
 *
 * Performance note:
 * Keep per-frame and per-point work inside the viewer and state managers.
 * `main.js` should stay orchestration-only (no hot-path allocations).
 *
 * @module main
 */
import { createViewer } from '../rendering/viewer.js';
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
} from './session/dataset-state-manifest.js';
import {
  createDatasetRuntimeRetirementOwner,
  createLatestDatasetPublicationContinuationOwner,
  createLatestDatasetReloadCoordinator,
  handleDatasetReloadFailure,
  settleInitialPublishedDatasetStateOutcome,
  settlePublishedDatasetStateOutcome,
  settlePublishedDatasetUi,
  stageDatasetPositionPayload
} from './dataset-reload-outcome.js';
import { initDockableAccordions } from './dockable-accordions.js';
import { setDockableAccordions } from './dockable-accordions-registry.js';
import { getNotificationCenter } from './notification-center.js';
import {
  loadObsManifest,
  createObsFieldLoader,
  loadVarManifest,
  createVarFieldLoader,
  loadConnectivityManifest,
  loadEdges,
  loadDatasetIdentity,
  getEmbeddingsMetadata
} from '../data/data-loaders.js';
import {
  createDimensionManager,
  createInMemoryDimensionManager
} from '../data/dimension-manager.js';
import { createVectorFieldManager } from '../data/vector-field-manager.js';
import {
  loadDatasetGeneration
} from '../data/dataset-generation-contract.js';
import {
  createCandidateAnnDataBinding,
  isAnnDataUrl
} from '../data/anndata-provider.js';
import {
  createDatasetReloadSupersededError,
  isDatasetReloadSupersededError
} from '../data/dataset-lifecycle-errors.js';
import { getDataSourceManager } from '../data/data-source-manager.js';
import { createLocalUserDirDataSource } from '../data/local-user-source.js';
import { createRemoteDataSource } from '../data/remote-source.js';
import {
  createJupyterBridgeDataSource,
  getJupyterConfig,
  uploadJupyterSessionBundle
} from '../data/jupyter-source.js';
import {
  createJupyterCommandHandlers
} from './jupyter-command-handler.js';
import {
  createJupyterHealthMonitor,
  createJupyterPointerDelivery
} from './jupyter-pointer-delivery.js';
// benchmark module is lazy-loaded when needed
import {
  fetchSampleArtifact,
  formatCellCount as formatNumber
} from '../data/data-source.js';
import { createComparisonModule } from './analysis/comparison-module.js';
import { ThemeManager } from '../utils/theme-manager.js';
import { debug } from '../utils/debug.js';
import { clamp } from './utils/number-utils.js';
import { shuffleConnectivityEdges } from './utils/random-utils.js';
import { getGitHubAuthSession } from './community-annotations/github-auth.js';
import { initKeyboardShortcuts, initWelcomeModal, showWelcomeModal } from './ui/onboarding/index.js';
import { publishWebBuildVersion } from './ui/core/build-version.js';
import { retireDeferredControls } from './ui/core/deferred-control-readiness.js';
import { resolveAntialiasPreference } from './ui/core/antialias-preference.js';
import {
  initAnalytics,
  trackDataLoadMethod,
  beginDataLoad,
  cancelDataLoad,
  completeDataLoadSuccess,
  completeDataLoadFailure,
  DATA_LOAD_METHODS
} from '../analytics/tracker.js';
import { initPerformanceAnalytics } from '../analytics/performance.js';
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
  prepareUrlForDatasetSelection,
  prepareUrlForDataSource
} from './url-state.js';

debug.log('Starting…');

const FAST_BINARY_FETCH_INIT = { cache: 'force-cache' };
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

// Default export base URL (will be updated by DataSourceManager)
let EXPORT_BASE_URL = '';

// Helper to get URLs based on current dataset
function getObsManifestUrl(baseUrl) { return `${baseUrl}obs_manifest.json`; }
function getVarManifestUrl(baseUrl) { return `${baseUrl}var_manifest.json`; }
function getConnectivityManifestUrl(baseUrl) { return `${baseUrl}connectivity_manifest.json`; }
function getDatasetIdentityUrl(baseUrl) { return `${baseUrl}dataset_identity.json`; }

(async function bootstrap() {
  let statsEl = null;
  let currentDatasetLoadToken = null;
  let buildDatasetAnalyticsContext = () => ({});
  let destroyApplication = null;

  try {
    ThemeManager.init();
    publishWebBuildVersion();

    const urlParams = new URLSearchParams(window.location.search);
    const jupyterConfig = getJupyterConfig();
    const {
      remoteUrlParam,
      githubPathParam,
      sourceParam,
      requestedDataset,
      isAnndataMode,
      inJupyter,
      shouldShowWelcome
    } = resolveStartupUrlIntent(urlParams, jupyterConfig);

    const canvas = document.getElementById('glcanvas');
    const labelLayer = document.getElementById('label-layer');
    const viewTitleLayer = document.getElementById('view-title-layer');
    statsEl = document.getElementById('stats');
    const themeSelect = document.getElementById('theme-select');
    const sidebar = document.getElementById('sidebar');
    const renderModeSelect = document.getElementById('render-mode');

    setDockableAccordions(initDockableAccordions({ sidebar }));

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

    const datasetSelect = document.getElementById('dataset-select');
    if (!(datasetSelect instanceof HTMLSelectElement)) {
      throw new Error('Sample selection requires the dataset controls.');
    }
    let datasetCatalogReady = null;
    let datasetSelectFocusRequested = false;
    function fulfillDatasetSelectFocusRequest() {
      const ownedCatalogReady = datasetCatalogReady;
      if (!datasetSelectFocusRequested || ownedCatalogReady === null) return;
      void ownedCatalogReady.then(catalogOutcome => {
        if (
          ownedCatalogReady !== datasetCatalogReady ||
          !datasetSelectFocusRequested
        ) {
          return;
        }
        datasetSelectFocusRequested = false;
        if (catalogOutcome?.status === 'ready') datasetSelect.focus();
      });
    }
    initWelcomeModal({
      onExplore() {
        datasetSelectFocusRequested = true;
        fulfillDatasetSelectFocusRequest();
      }
    });
    if (shouldShowWelcome) {
      showWelcomeModal();
    }

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
    let comparisonModule = null;
    let applicationRetired = false;
    let stopPerfMonitoring = () => {};

    debug.log('[Main] Creating viewer...');
    // `antialias` is fixed at context creation and cannot be changed on a live
    // context, so the stored preference has to be read here, before the viewer
    // exists. `render-controls.js` owns the control that writes it; this is the
    // only place that reads it. A value it could not use is reported below,
    // once the notification centre exists.
    const antialiasPreference = resolveAntialiasPreference(localStorage);
    const viewer = createViewer({
      canvas,
      labelLayer,
      viewTitleLayer,
      antialias: antialiasPreference.enabled
    });
    debug.log('[Main] Viewer created successfully');

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
        () => stopPerfMonitoring(),
        ...(comparisonModule === null
          ? []
          : [() => comparisonModule.destroy()]),
        ...(ui === null ? [] : [() => ui.destroy()]),
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

    const state = createDataState({ viewer, labelLayer });
    debug.log('[Main] State created successfully');

    // Expose state globally for dev tools
    window._cellucidState = state;

    // benchmarkReporter will be created lazily when benchmark report is requested
    let benchmarkReporter = null;

    // Initialize notification center early
    const notifications = getNotificationCenter();
    notifications.init();

    if (antialiasPreference.discarded !== null) {
      // Discarded rather than obeyed, and never in silence: the user chose this
      // setting once and is entitled to know the choice did not survive.
      notifications.warning(
        `The stored antialiasing preference `
        + `${JSON.stringify(antialiasPreference.discarded)} was not recognized `
        + 'and has been discarded, so antialiasing is on. Set it again in '
        + 'Visualization if you wanted it off.',
        { category: 'rendering', title: 'Antialiasing preference reset' }
      );
    }

    // Construct the optional GitHub annotation session inside the startup
    // boundary so storage/configuration failures cannot leave a blank page.
    const githubAuthSession = getGitHubAuthSession();
    try {
      const signInResult =
        await githubAuthSession.completeSignInFromRedirect();
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
    const datasetReloadCoordinator = createLatestDatasetReloadCoordinator(
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
    initAnalytics({ dataSourceManager });

    buildDatasetAnalyticsContext = (overrides = {}) => {
      const metadata = overrides.metadata ?? dataSourceManager.getCurrentMetadata?.();
      const datasetId = overrides.datasetId ?? dataSourceManager.getCurrentDatasetId?.();
      const datasetName = overrides.datasetName ?? metadata?.name;
      const sourceType = overrides.sourceType ?? dataSourceManager.getCurrentSourceType?.();
      return {
        metadata,
        datasetId,
        datasetName,
        sourceType,
        previousDatasetId: overrides.previousDatasetId,
        previousSource: overrides.previousSource,
        reload: overrides.reload
      };
    };

    const startDatasetLoad = (methodOverride = null, ctxOverrides = {}) => {
      const method = methodOverride || dataSourceManager.getLastLoadMethod?.() || DATA_LOAD_METHODS.DEFAULT_DEMO;
      return beginDataLoad(method, buildDatasetAnalyticsContext(ctxOverrides));
    };

    const startPerfAnalytics = () => {
      initPerformanceAnalytics({
        sampleRate: 1,
        contextProvider: () => ({
          datasetId: dataSourceManager.getCurrentDatasetId?.(),
          sourceType: dataSourceManager.getCurrentSourceType?.()
        })
      });
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(startPerfAnalytics, { timeout: 2000 });
    } else {
      setTimeout(startPerfAnalytics, 1200);
    }

    // Helper functions for onboarding callbacks (defined early, used later)
    let toggleSidebarVisibility = null;
    let setDimensionLevel = null;
    let clearAllHighlights = null;
    let setNavigationMode = null;

    // Initialize keyboard shortcuts after exact startup onboarding policy is set.
    initKeyboardShortcuts({
      onToggleSidebar: () => {
        if (toggleSidebarVisibility) toggleSidebarVisibility();
      },
      onSetDimension: (dim) => {
        if (setDimensionLevel) setDimensionLevel(dim);
      },
      onShowHelp: () => {
        const shortcutsSection = document.getElementById('shortcuts-section');
        if (shortcutsSection) {
          shortcutsSection.open = true;
          shortcutsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      },
      onClearHighlights: () => {
        if (clearAllHighlights) clearAllHighlights();
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

    // Check if running in Jupyter context
    let jupyterSource = null;
    if (inJupyter) {
      debug.log('[Main] Detected Jupyter context, initializing bridge...');
      jupyterSource = createJupyterBridgeDataSource(jupyterConfig);
      dataSourceManager.registerSource('jupyter', jupyterSource);

      const jupyterInitialized = await jupyterSource.initialize();
      if (jupyterInitialized !== true) {
        throw new Error(
          'Jupyter context must initialize one authenticated Python server'
        );
      }
      debug.log('[Main] Jupyter bridge initialized successfully');

      if (jupyterConfig === null) {
        throw new Error(
          'Initialized Jupyter mode requires its authenticated configuration'
        );
      }

      // Freeze support: keep the last fully rendered view when Python stops.
      let jupyterFrozen = false;
      let jupyterPointerDelivery = null;
      let jupyterHealthMonitor = null;
      let retireJupyterPointerInputs = () => {};
      const reportJupyterConsoleError = (...args) => {
        try {
          console.error(...args);
        } catch {
          // Terminal/error reporting is observational and cannot reopen input
          // or turn a listener path into a thrown failure.
        }
      };
      const freezeJupyterView = () => {
        if (jupyterFrozen) return false;
        // Publish the terminal fence before any fallible observer, renderer,
        // timer, or DOM work.
        jupyterFrozen = true;
        const failures = [];
        const attempt = operation => {
          try {
            operation();
          } catch (error) {
            failures.push(error);
          }
        };
        attempt(() => retireJupyterPointerInputs());
        attempt(() => jupyterPointerDelivery?.freeze());
        attempt(() => jupyterHealthMonitor?.freeze());
        attempt(() => viewer.pause());
        attempt(() => {
          let overlay = document.getElementById(
            'cellucid-jupyter-freeze-overlay'
          );
          if (overlay === null) {
            overlay = document.createElement('div');
            overlay.id = 'cellucid-jupyter-freeze-overlay';
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
          reportJupyterConsoleError(
            '[Main] Jupyter freeze cleanup failed:',
            failure
          );
        }
        return true;
      };

      jupyterSource.onMessage(message => {
        if (message.type === 'freeze') {
          freezeJupyterView();
        }
      });

      jupyterHealthMonitor = createJupyterHealthMonitor({
        checkHealth: () => jupyterSource.checkHealth(),
        onFailure: error => {
          freezeJupyterView();
          reportJupyterConsoleError(
            '[Main] Jupyter server health contract failed; freezing view:',
            error
          );
          try {
            notifications.error(
              'The Python server stopped or returned an invalid health response. ' +
              'The last complete view has been frozen.',
              {
                category: 'connectivity',
                title: 'Jupyter server disconnected',
                duration: 0
              }
            );
          } catch (notificationError) {
            reportJupyterConsoleError(
              '[Main] Jupyter disconnect notification failed:',
              notificationError
            );
          }
        },
        intervalMs: 3000,
      });
      jupyterHealthMonitor.start();

      if (
        typeof viewer.pickCellRecordAtScreen !== 'function'
      ) {
        throw new TypeError(
          'Jupyter pointer hooks require exact per-view picking records'
        );
      }

      let lastHoverAt = 0;
      const HOVER_THROTTLE_MS = 50;
      const reportJupyterPointerError = (error, channel) => {
        reportJupyterConsoleError(
          `[Main] Jupyter ${channel} pointer delivery failed:`,
          error
        );
      };
      jupyterPointerDelivery = createJupyterPointerDelivery({
        notifyHover: (cellIndex, position) =>
          jupyterSource.notifyHover(cellIndex, position),
        notifyClick: (cellIndex, modifiers) =>
          jupyterSource.notifyClick(cellIndex, modifiers),
        reportError: reportJupyterPointerError,
      });
      const retireJupyterView = event => {
        if (event.persisted === true) return;
        window.removeEventListener('pagehide', retireJupyterView);
        freezeJupyterView();
      };
      window.addEventListener('pagehide', retireJupyterView);

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
      retireJupyterPointerInputs = () => {
        hasPendingHoverPoint = false;
        clearHoverSampleTimer();
      };
      const sampleLatestJupyterHover = () => {
        hoverSampleTimer = null;
        try {
          if (jupyterFrozen || !hasPendingHoverPoint) return;
          const now = performance.now();
          const remaining =
            HOVER_THROTTLE_MS - (now - lastHoverAt);
          if (remaining > 0) {
            hoverSampleTimer = setTimeout(
              sampleLatestJupyterHover,
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
              'Jupyter cell picking must return null or one exact frozen per-view record'
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
                'Jupyter hover requires one complete finite XYZ position'
              );
            }
          }
          jupyterPointerDelivery.requestHover(pickRecord);
        } catch (error) {
          reportJupyterPointerError(error, 'hover');
        }
      };

      canvas.addEventListener('mousemove', event => {
        pendingHoverClientX = event.clientX;
        pendingHoverClientY = event.clientY;
        hasPendingHoverPoint = true;
        if (hoverSampleTimer === null) {
          sampleLatestJupyterHover();
        }
      });

      canvas.addEventListener('mouseleave', () => {
        try {
          if (!jupyterFrozen) {
            hasPendingHoverPoint = false;
            clearHoverSampleTimer();
            jupyterPointerDelivery.requestHover(null);
          }
        } catch (error) {
          reportJupyterPointerError(error, 'hover');
        }
      });

      canvas.addEventListener('click', event => {
        try {
          if (jupyterFrozen) return;
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
              'Jupyter cell picking must return null or one exact frozen per-view record'
            );
          }
          if (pickRecord === null) return;
          jupyterPointerDelivery.requestClick({
            cellIndex: pickRecord.cellIndex,
            button: event.button,
            shift: event.shiftKey,
            ctrl: event.ctrlKey || event.metaKey,
          });
        } catch (error) {
          reportJupyterPointerError(error, 'click');
        }
      });

      const jupyterDatasets = await jupyterSource.listDatasets();
      const jupyterDatasetId = selectIntentDatasetId(
        jupyterDatasets,
        requestedDataset,
        'The authenticated Python server'
      );
      await dataSourceManager.switchToDataset(
        'jupyter',
        jupyterDatasetId,
        { loadMethod: DATA_LOAD_METHODS.JUPYTER_AUTO }
      );
      debug.log(
        `[Main] Switched to Jupyter dataset: ${jupyterDatasetId}`
      );
    }

    // An explicit remote URL is a terminal source request.
    if (remoteUrlParam !== null) {
      debug.log(`[Main] Remote server URL from param: ${remoteUrlParam}`);
      await remoteSource.connect({ url: remoteUrlParam });
      if (remoteSource.isConnected() !== true) {
        throw new Error(
          'The requested remote source did not publish a connected state.'
        );
      }
      const remoteDatasets = await remoteSource.listDatasets();
      const remoteDatasetId = selectIntentDatasetId(
        remoteDatasets,
        requestedDataset,
        'The requested remote source'
      );
      if (isAnndataMode) {
        debug.log(
          '[Main] AnnData mode detected - loading directly from AnnData'
        );
        notifications.warning(
          'Loading data directly from AnnData. This may be slower than using pre-exported data. ' +
          'For better performance, use prepare() to create optimized binary files.',
          { duration: 12000 }
        );
      }
      await dataSourceManager.switchToDataset(
        'remote',
        remoteDatasetId,
        { loadMethod: DATA_LOAD_METHODS.REMOTE_URL_PARAM }
      );
      debug.log(
        `[Main] Switched to remote dataset: ${remoteDatasetId}`
      );
    }

    // Auto-connect to a same-origin Cellucid server when the web app is being
    // served by the Python package itself (CLI/Python server mode).
    //
    // Without this, the app may auto-load the demo dataset and ignore the
    // server-hosted dataset, especially when demo exports are configured.
    if (
      !inJupyter &&
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
        const healthResponse = await fetch(
          `${selfBase}/_cellucid/health`,
          { cache: 'no-store' }
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
          const healthAdvertisement = await healthResponse.json();
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
            await remoteSource.connect({ url: selfBase });
            if (remoteSource.isConnected() !== true) {
              throw new Error(
                'Same-origin Cellucid source did not publish a connected state.'
              );
            }
            const datasets = await remoteSource.listDatasets();
            const remoteDatasetId = selectConnectedDatasetId(
              datasets,
              requestedDataset,
              'The same-origin Cellucid source'
            );
            if (isAnndataMode) {
              notifications.warning(
                'Loading data directly from AnnData. This may be slower than using pre-exported data. ' +
                'For better performance, use prepare() to create optimized binary files.',
                { duration: 12000 }
              );
            }
            if (remoteDatasetId === null) {
              datasetSelectFocusRequested = true;
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
              await dataSourceManager.switchToDataset(
                'remote',
                remoteDatasetId,
                { loadMethod: DATA_LOAD_METHODS.SERVER_AUTO }
              );
              debug.log(
                `[Main] Auto-connected to server dataset: ${remoteDatasetId}`
              );
            }
          }
        }
      }
    }

    // Register current sources before resolving the exact startup selection.
    await dataSourceManager.initialize({
      // Jupyter mode owns one authenticated Python dataset source, so it does
      // not register the unrelated sample catalog.
      registerDemoCatalog: !inJupyter
    });

    const useDefaultDemo =
      !inJupyter
      && remoteUrlParam === null
      && githubPathParam === null
      && requestedDataset === null
      && (sourceParam === null || sourceParam === 'local-demo')
      && dataSourceManager.hasActiveDataset() === false;
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
      let demoCatalogAvailable = false;
      try {
        demoCatalogAvailable = await localDemoSource.isAvailable();
      } catch (error) {
        if (!(error instanceof Error)) {
          throw new TypeError(
            'Default sample catalog availability rejected with a non-Error value.'
          );
        }
        debug.log(
          `[Main] Default sample catalog is unavailable: ${error.message}`
        );
      }
      if (demoCatalogAvailable) {
        const defaultDatasetId = await localDemoSource.getDefaultDatasetId();
        await dataSourceManager.switchToDataset(
          'local-demo',
          defaultDatasetId,
          { loadMethod: DATA_LOAD_METHODS.DEFAULT_DEMO }
        );
        debug.log(
          `[Main] Loaded catalog default dataset: ${defaultDatasetId}`
        );
      }
    }

    // Check for GitHub repository path in query parameters
    // Must be after initialize() since github-repo source is registered there
    if (githubPathParam !== null) {
      debug.log(`[Main] GitHub path from param: ${githubPathParam}`);
      const githubSource = dataSourceManager.getSource('github-repo');
      if (githubSource === null) {
        throw new Error(
          'Explicit GitHub startup requires the registered GitHub source.'
        );
      }
      const githubConnection =
        await githubSource.connect(githubPathParam);
      if (
        githubConnection === null ||
        typeof githubConnection !== 'object' ||
        Array.isArray(githubConnection) ||
        !Object.hasOwn(githubConnection, 'datasets')
      ) {
        throw new TypeError(
          'GitHub source connection must publish its dataset inventory.'
        );
      }
      const githubDatasetId = selectIntentDatasetId(
        githubConnection.datasets,
        requestedDataset,
        'The requested GitHub repository'
      );
      await dataSourceManager.switchToDataset(
        'github-repo',
        githubDatasetId,
        { loadMethod: DATA_LOAD_METHODS.GITHUB_URL_PARAM }
      );
      debug.log(
        `[Main] Switched to GitHub dataset: ${githubDatasetId}`
      );

      const githubRepoInput =
        document.getElementById('github-repo-url');
      if (!(githubRepoInput instanceof HTMLInputElement)) {
        throw new Error(
          'GitHub startup requires the repository input control.'
        );
      }
      githubRepoInput.value = githubPathParam;
    }

    // Check URL parameters for dataset selection
    // Only process if we haven't already connected via remote/jupyter/github
    const requestedSource = sourceParam === null
      ? 'local-demo'
      : sourceParam;
    const currentSourceType = dataSourceManager.getCurrentSourceType();
    const skipUrlDataset = currentSourceType === 'remote' || currentSourceType === 'jupyter' || currentSourceType === 'github-repo';

    if (requestedDataset !== null && !skipUrlDataset) {
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
      if (!await targetSource.hasDataset(requestedDataset)) {
        throw new Error(
          `Requested dataset '${requestedDataset}' was not found in '${requestedSource}'.`
        );
      }
      await dataSourceManager.switchToDataset(
        requestedSource,
        requestedDataset,
        { loadMethod: DATA_LOAD_METHODS.DATASET_URL_PARAM }
      );
      debug.log(
        `[Main] Loaded dataset from URL param: ` +
        `${requestedSource}/${requestedDataset}`
      );
    }

    const selectedBaseUrl = dataSourceManager.getCurrentBaseUrl();
    EXPORT_BASE_URL = selectedBaseUrl === null ? '' : selectedBaseUrl;
    debug.log(`[Main] Using dataset base URL: ${EXPORT_BASE_URL}`);

    if (!currentDatasetLoadToken && dataSourceManager.hasActiveDataset()) {
      currentDatasetLoadToken = startDatasetLoad();
    }

    // The live manager is replaced only when a complete dataset generation and
    // its default position payload have been staged successfully.
    let dimensionManager = createDimensionManager({ baseUrl: EXPORT_BASE_URL });
    let activeRuntimeStage = null;
    const runtimeRetirementOwner =
      createDatasetRuntimeRetirementOwner();
    const datasetPublicationOwner =
      createLatestDatasetPublicationContinuationOwner();
    let datasetPublicationGeneration = 0;
    let activeDatasetPublication = null;

    function publishRuntimeContinuation(details) {
      const publication = datasetPublicationOwner.publish(details);
      datasetPublicationGeneration = publication.generation;
      activeDatasetPublication = publication;
      return publication;
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

    function publishEmptyDatasetRuntime({
      clearViews,
      restorationPublication = null
    }) {
      if (
        typeof clearViews !== 'boolean' ||
        (
          restorationPublication !== null &&
          typeof restorationPublication !== 'object'
        )
      ) {
        throw new TypeError(
          'Empty dataset runtime publication requires boolean clearViews and an optional restoration publication.'
        );
      }
      if (restorationPublication !== null) {
        requireRestorablePublication(restorationPublication);
      }
      retireInProgressHighlightSelection();
      ui?.prepareDatasetReplacement?.();
      EXPORT_BASE_URL = '';
      dimensionManager = createDimensionManager({ baseUrl: '' });
      obs = null;
      connectivityManifest = null;
      positions = null;
      state.setDimensionManager(dimensionManager);
      state.setFieldLoader(null);
      state.setVarFieldLoader(null);
      state.varData = null;
      state._varFieldDescriptors = Object.freeze([]);
      state.setVectorFieldManager(null);
      state.initScene(new Float32Array(), { fields: [], count: 0 });
      state.clearActiveField();
      state.clearAllHighlights();
      if (clearViews) {
        state.clearSnapshotViews();
        viewer.clearSnapshotViews();
        viewer.updateHighlight(new Uint8Array());
      }
      if (statsEl) statsEl.textContent = 'No dataset selected';
      activeRuntimeStage = null;
      return restorationPublication !== null
        ? requireRestorablePublication(restorationPublication)
        : publishRuntimeContinuation({ runtimeKind: 'empty' });
    }

    async function stageDatasetRuntime({
      baseUrl,
      candidateAnnDataBinding,
      expectedIdentityId,
      showProgress,
      signal,
      stagedSource
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
      const candidateDimensionManager = createDimensionManager({
        baseUrl,
        candidateAnnDataBinding,
        stagedSource
      });

      try {
        const generation = await loadDatasetGeneration({
          expectedIdentityId,
          signal,
          loadIdentity: generationSignal =>
            loadDatasetIdentity(
              getDatasetIdentityUrl(baseUrl),
              {
                candidateAnnDataBinding,
                signal: generationSignal,
                stagedSource
              }
            ),
          loadObsManifest: generationSignal =>
            loadObsManifest(
              getObsManifestUrl(baseUrl),
              {
                candidateAnnDataBinding,
                signal: generationSignal,
                stagedSource
              }
            ),
          loadVarManifest: generationSignal =>
            loadVarManifest(
              getVarManifestUrl(baseUrl),
              {
                candidateAnnDataBinding,
                signal: generationSignal,
                stagedSource
              }
            ),
          loadConnectivityManifest: generationSignal =>
            loadConnectivityManifest(
              getConnectivityManifestUrl(baseUrl),
              {
                candidateAnnDataBinding,
                signal: generationSignal,
                stagedSource
              }
            ),
        });
        const embeddingsMetadata = getEmbeddingsMetadata(generation.identity);
        candidateDimensionManager.initFromMetadata(embeddingsMetadata);
        // loadDatasetGeneration has already proved this count against
        // obs_manifest.json, var_manifest.json, and connectivity_manifest.json,
        // so it is the dataset's exact cell axis. publishCellCount enforces the
        // ordering rule this used to state in prose: it must follow
        // initFromMetadata, which clears the cache and zeroes the axis.
        candidateDimensionManager.publishCellCount(generation.identity.stats.n_cells);
        const positionStage = await stageDatasetPositionPayload({
          generation,
          dimensionManager: candidateDimensionManager,
          showProgress,
          signal
        });

        // Every obs and var payload is one value per cell, and the generation
        // contract has already proved both manifests declare exactly
        // stats.n_cells points. Passing that count turns each field fetch into
        // an exact-length transport check instead of a 512 MiB ceiling.
        const fieldLoader = createObsFieldLoader(
          getObsManifestUrl(baseUrl),
          {
            fetchInit: FAST_BINARY_FETCH_INIT,
            pointCount: generation.obsManifest.n_points
          }
        );
        const varFieldLoader = generation.varManifest
          ? createVarFieldLoader(
              getVarManifestUrl(baseUrl),
              {
                fetchInit: FAST_BINARY_FETCH_INIT,
                pointCount: generation.varManifest.n_points
              }
            )
          : null;
        const vectorFieldManager = createVectorFieldManager({
          baseUrl,
          vectorFieldsMetadata: Object.hasOwn(
            generation.identity,
            'vector_fields'
          )
            ? generation.identity.vector_fields
            : null,
          dimensionManager: candidateDimensionManager
        });

        return Object.freeze({
          baseUrl,
          dimensionManager: candidateDimensionManager,
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
    let connectivityManifest = null;
    let positions = null;
    const connectivityRuntimeOwner = initializeConnectivityControls();
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
      const previousRuntimeStage = activeRuntimeStage;

      // This function is intentionally synchronous. The reload transaction is
      // checked immediately before this sole publication call, so no newer
      // selection can interleave with the dataset-owned state replacement.
      retireInProgressHighlightSelection();
      ui?.prepareDatasetReplacement?.();
      EXPORT_BASE_URL = stage.baseUrl;
      dimensionManager = stage.dimensionManager;
      obs = stage.generation.obsManifest;
      positions = stage.positions;
      connectivityManifest = stage.generation.connectivityManifest;

      state.setDimensionManager(dimensionManager);
      state.setFieldLoader(stage.fieldLoader);
      state.setVarFieldLoader(stage.varFieldLoader);
      if (stage.generation.varManifest) {
        state.initVarData(stage.generation.varManifest);
      } else {
        state.varData = null;
        state._varFieldDescriptors = Object.freeze([]);
      }
      state.initScene(positions, obs);
      state.clearActiveField();
      state.clearAllHighlights();
      state.setVectorFieldManager(stage.vectorFieldManager);
      activeRuntimeStage = stage;

      return restorationPublication !== null
        ? requireRestorablePublication(restorationPublication)
        : publishRuntimeContinuation({
            previousDimensionManager,
            previousRuntimeStage,
            stage
          });
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
      const previousRuntimeStage = activeRuntimeStage;
      retireInProgressHighlightSelection();
      ui?.prepareDatasetReplacement?.();
      state.initSyntheticScene({
        positions: stage.positions,
        colors: stage.colors,
        dimensionLevel: stage.dimensionLevel,
        dimensionManager: stage.dimensionManager
      });
      EXPORT_BASE_URL = '';
      dimensionManager = stage.dimensionManager;
      obs = state.obsData;
      positions = stage.positions;
      connectivityManifest = null;
      activeRuntimeStage = stage;
      return restorationPublication !== null
        ? requireRestorablePublication(restorationPublication)
        : publishRuntimeContinuation({
            previousDimensionManager,
            previousRuntimeStage,
            stage
          });
    }

    function restoreRuntimeStage(stage, restorationPublication) {
      if (stage?.runtimeKind === 'synthetic') {
        return commitSyntheticRuntimeStage(stage, {
          restorationPublication
        });
      }
      return commitDatasetRuntimeStage(stage, {
        restorationPublication
      });
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

    function retirePublishedDatasetSnapshotViews(publication) {
      assertCurrentDatasetPublication(publication);
      const hadSnapshots = viewer.hasSnapshots();
      if (typeof hadSnapshots !== 'boolean') {
        throw new TypeError(
          'Dataset view retirement requires an exact viewer snapshot inventory.'
        );
      }
      const retirementFailures = [];
      if (hadSnapshots) {
        // Kept views own the previous dataset's GPU buffers and DataState
        // contexts. Retire them only after scientific publication succeeds so
        // a failed runtime commit can still restore the complete prior scene.
        try {
          viewer.clearSnapshotViews();
        } catch (error) {
          retirementFailures.push(error);
        }
      }
      // State may already have reset itself during dataset publication, but
      // clear its secondary inventory independently of renderer cleanup so a
      // prior partial failure cannot preserve a stale active-view identity.
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
            'Published dataset view retirement did not restore the visible live view.'
          )
        );
      }
      if (retirementFailures.length === 1) {
        throw retirementFailures[0];
      }
      if (retirementFailures.length > 1) {
        throw new AggregateError(
          retirementFailures,
          'Published dataset kept-view retirement was incomplete.'
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
          // The scientific runtime is already committed. Retire kept views
          // before the first await so an animation frame can never combine
          // the new live dataset with snapshot buffers from its predecessor.
          retirePublishedDatasetSnapshotViews(publication);
          try {
            await ui?.settleFieldInteractions?.();
          } finally {
            assertCurrentDatasetPublication(publication);
          }
          connectivityRuntimeOwner.prepareDatasetReplacement();
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
            `[Main] Published dataset identity ` +
            `v${publication.stage.generation.identity.version}`
          );
          if (publication.stage.generation.varManifest) {
            debug.log(
              `Loaded var manifest with ` +
              `${publication.stage.generation.varManifest.fields.length} genes.`
            );
          }
          if (publication.stage.generation.connectivityManifest) {
            debug.log(
              `Loaded connectivity manifest with ` +
              `${publication.stage.generation.connectivityManifest.n_edges.toLocaleString()} edges.`
            );
          }
          ui.refreshDatasetUI(activeMetadata);
        },
        finalize: () => {
          runtimeRetirementOwner.retire(
            publication.previousDimensionManager
          );
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

    const hasInitialDataset =
      dataSourceManager.hasActiveDataset() === true;
    let initialPublication = null;
    if (hasInitialDataset) {
      // Capture the exact selected id and URL before any asynchronous metadata
      // or payload work. A loader may not derive identity from a later source.
      const initialExpectedIdentityId =
        dataSourceManager.getCurrentIdentityId();
      const initialBaseUrl = dataSourceManager.getCurrentBaseUrl();
      const initialLoadController = new AbortController();
      let initialStage = null;
      try {
        initialStage = await stageDatasetRuntime({
          baseUrl: initialBaseUrl,
          candidateAnnDataBinding: null,
          expectedIdentityId: initialExpectedIdentityId,
          showProgress: true,
          signal: initialLoadController.signal,
          stagedSource: null
        });
        initialPublication = commitDatasetRuntimeStage(initialStage);
      } catch (error) {
        let exactError = error;
        if (
          initialStage !== null &&
          activeRuntimeStage !== initialStage
        ) {
          try {
            runtimeRetirementOwner.retire(
              initialStage.dimensionManager
            );
          } catch (retirementError) {
            exactError = new AggregateError(
              [error, retirementError],
              'Initial dataset publication and candidate retirement failed.'
            );
          }
        }
        if (currentDatasetLoadToken) {
          completeDataLoadFailure(currentDatasetLoadToken, {
            ...buildDatasetAnalyticsContext(),
            error: exactError
          });
          currentDatasetLoadToken = null;
        }
        throw exactError;
      }
    } else {
      // No explicit selection: publish the empty runtime while the catalog is
      // listed independently in the data controls.
      const unusedDimensionManager = dimensionManager;
      publishEmptyDatasetRuntime({ clearViews: false });
      runtimeRetirementOwner.retire(unusedDimensionManager);
    }

    // Stage one exact manager/source/runtime/URL generation before publishing
    // any of it. This also activates not-yet-registered Remote/GitHub
    // connection candidates without replacing the prior transport early.
    async function reloadActiveDatasetInPlace(selection) {
      const activationKeys = [
        'datasetId',
        'loadMethod',
        'source',
        'sourceType'
      ];
      if (
        selection === null ||
        typeof selection !== 'object' ||
        Array.isArray(selection) ||
        Object.getPrototypeOf(selection) !== Object.prototype
      ) {
        throw new TypeError(
          'Dataset activation must contain exactly datasetId, loadMethod, source, and sourceType.'
        );
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
        throw new TypeError(
          'Dataset activation must contain exactly datasetId, loadMethod, source, and sourceType.'
        );
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
        sourceType
      } = selection;
      const reloadTransaction = datasetReloadCoordinator.begin();
      reloadTransaction.assertCurrent();

      const loadToken = startDatasetLoad(loadMethod, {
        datasetId,
        reload: true,
        sourceType
      });
      let selectionStage = null;
      let runtimeStage = null;
      let urlPublication = null;

      try {
        selectionStage = await dataSourceManager.stageDatasetSelection(
          sourceType,
          datasetId,
          { loadMethod, source }
        );
        reloadTransaction.assertCurrent();
        urlPublication = prepareUrlForDatasetSelection({
          datasetId,
          source,
          sourceType
        });
        const candidateAnnDataBinding =
          isAnnDataUrl(selectionStage.baseUrl)
            ? createCandidateAnnDataBinding(
                selectionStage.baseUrl,
                source
              )
            : null;
        const stagedSource =
          candidateAnnDataBinding === null &&
          dataSourceManager.isCustomProtocolUrl(
            selectionStage.baseUrl
          )
            ? source
            : null;
        runtimeStage = await stageDatasetRuntime({
          baseUrl: selectionStage.baseUrl,
          candidateAnnDataBinding,
          expectedIdentityId: selectionStage.identityId,
          showProgress: false,
          signal: reloadTransaction.signal,
          stagedSource
        });
        reloadTransaction.assertCurrent();
        await cancelPublishedDatasetStateAndWait();
        reloadTransaction.assertCurrent();
      } catch (err) {
        const stagingErrors = [err];
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
          cancel: () => cancelDataLoad(loadToken),
          reportFailure: failure => {
            console.error('[Main] Failed to reload dataset in-place:', failure);
            completeDataLoadFailure(loadToken, {
              ...buildDatasetAnalyticsContext({
                metadata: selectionStage?.metadata ?? null,
                datasetId,
                datasetName: selectionStage?.metadata?.name,
                reload: true
              }),
              error: failure
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
          cancel: () => cancelDataLoad(loadToken),
          reportFailure: failure => {
            console.error('[Main] Failed to publish dataset selection:', failure);
            completeDataLoadFailure(loadToken, {
              ...buildDatasetAnalyticsContext({
                metadata: selectionStage.metadata,
                datasetId,
                datasetName: selectionStage.metadata.name,
                reload: true
              }),
              error: failure
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
          if (previousRuntimeStage === null) {
            publishEmptyDatasetRuntime({
              clearViews: false,
              restorationPublication: previousPublication
            });
          } else {
            restoreRuntimeStage(
              previousRuntimeStage,
              previousPublication
            );
          }
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
          cancel: () => cancelDataLoad(loadToken),
          reportFailure: failure => {
            console.error(
              '[Main] Failed to publish dataset runtime:',
              failure
            );
            completeDataLoadFailure(loadToken, {
              ...buildDatasetAnalyticsContext({
                metadata: selectionStage.metadata,
                datasetId,
                datasetName: selectionStage.metadata.name,
                reload: true
              }),
              error: failure
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
          cancel: () => cancelDataLoad(loadToken),
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
      const stateOutcome = await restoreAdvertisedDatasetState({
        signal: publication.signal
      });
      const settledStateOutcome =
        await settlePublishedDatasetStateOutcome({
          outcome: stateOutcome,
          transaction: publication,
          cancel: () => cancelDataLoad(loadToken),
          complete: () => completeDataLoadSuccess(
            loadToken,
            buildDatasetAnalyticsContext({
              metadata: selectionStage.metadata,
              datasetId,
              datasetName: selectionStage.metadata.name,
              reload: true
            })
          )
        });
      debug.log(
        `[Main] Published dataset state outcome: ` +
        `${settledStateOutcome.status}`
      );
      return synchronizationOutcome.status === 'ready' ||
        synchronizationOutcome.status === 'ready-ui-error';
    }

    async function clearActiveDatasetInPlace() {
      const reloadTransaction = datasetReloadCoordinator.begin();
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
          publishEmptyDatasetRuntime({ clearViews: true });
      } catch (runtimeError) {
        const rollbackErrors = [runtimeError];
        const rejectedEmptyDimensionManager =
          dimensionManager === previousDimensionManager
            ? null
            : dimensionManager;
        try {
          if (previousRuntimeStage === null) {
            publishEmptyDatasetRuntime({
              clearViews: false,
              restorationPublication: previousPublication
            });
          } else {
            restoreRuntimeStage(
              previousRuntimeStage,
              previousPublication
            );
          }
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
          connectivityRuntimeOwner.prepareDatasetReplacement();
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
          'alpha,outlierQuantiles,outlierThreshold,positions'
        || !(source.positions instanceof Float32Array)
        || source.positions.length % 3 !== 0
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
        `${source.positions.length / 3} dataset points with bounded ` +
        `visibility streaming (GPU)…`
      );
      viewer.buildSmokeVolumeGPU(source.positions, {
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

    async function restoreAdvertisedDatasetState({ signal }) {
      if (!(signal instanceof AbortSignal)) {
        throw new TypeError(
          'Published dataset state requires one owner AbortSignal.'
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
            fetchArtifact: fetchSampleArtifact,
            getPublicationRevision: () => datasetPublicationGeneration,
            refreshUi: ui.refreshUiAfterStateLoad,
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
          const message = error instanceof Error
            ? error.message
            : String(error);
          console.error(
            '[Main] Dataset loaded, but its advertised default state failed:',
            error
          );
          notifications.error(
            `The dataset is loaded, but its published sample view could not ` +
            `be applied: ${message}`,
            {
              category: 'data',
              duration: 0,
              title: 'Sample view unavailable'
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
    // Jupyter "no-download" session bundle capture (viewer → Python)
    // -----------------------------------------------------------------------
    if (jupyterSource) {
      if (jupyterConfig === null) {
        throw new Error(
          'Jupyter session upload requires the exact authenticated configuration'
        );
      }
      jupyterSource.onMessage(async message => {
        if (message.type !== 'requestSessionBundle') return;
        await uploadJupyterSessionBundle({
          config: jupyterConfig,
          message,
          createSessionBundle: () =>
            sessionSerializer.createSessionBundle(),
          fetchImpl: fetch
        });
      });
    }

    ui = initUI({
      state,
      viewer,
      smoke: {
        rebuildSmokeDensity
      },
      clearActiveDataset: clearActiveDatasetInPlace,
      reloadActiveDataset: reloadActiveDatasetInPlace,
      sessionSerializer,
      dataSourceManager,
      jupyterSource
    });
    window._cellucidUi = ui;
    datasetCatalogReady = ui.datasetCatalogReady;
    fulfillDatasetSelectFocusRequest();

    if (jupyterSource !== null) {
      const jupyterCommandHandlers = createJupyterCommandHandlers({
        state,
        viewer,
        refreshUi: ui.refreshUiAfterStateLoad
      });
      jupyterSource.onHighlight(
        jupyterCommandHandlers.handleHighlight
      );
      jupyterSource.onMessage(
        jupyterCommandHandlers.handleMessage
      );
    }

    // Allow session serializer to capture/restore cinematic camera state.
    sessionSerializer.setCinematicCameraRef(ui.cinematicCamera);

    // Jupyter: publish readiness only after the complete dataset and UI exist.
    if (jupyterSource !== null) {
      await jupyterSource.notifyReady({
        nCells: state.pointCount,
        dimensions: state.activeDimensionLevel
      });
    }

    // Initialize Page Analysis / Comparison Module
    const pageAnalysisSection = document.getElementById('page-analysis-section');
    if (pageAnalysisSection) {
      comparisonModule = createComparisonModule({
        state,
        container: pageAnalysisSection
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

    if (hasInitialDataset) {
      if (initialPublication === null) {
        throw new Error(
          'Initial dataset state requires one runtime publication.'
        );
      }
      if (currentDatasetLoadToken === null) {
        throw new Error(
          'Initial dataset state requires one analytics load token.'
        );
      }
      let stateOutcome = { status: 'superseded' };
      if (initialPublication.isCurrent()) {
        const synchronizationOutcome = await synchronizePublishedDatasetUi(
          dataSourceManager.getCurrentMetadata(),
          initialPublication
        );
        if (
          synchronizationOutcome.status !== 'superseded' &&
          initialPublication.isCurrent()
        ) {
          assertCurrentDatasetPublication(initialPublication);
          let fieldActivationError = null;
          try {
            await ui.activateField(-1);
          } catch (error) {
            fieldActivationError = error;
          }
          if (initialPublication.isCurrent()) {
            assertCurrentDatasetPublication(initialPublication);
            if (fieldActivationError !== null) {
              throw fieldActivationError;
            }
            stateOutcome = await restoreAdvertisedDatasetState({
              signal: initialPublication.signal
            });
          }
        }
      }
      const initialLoadToken = currentDatasetLoadToken;
      const settledStateOutcome =
        await settleInitialPublishedDatasetStateOutcome({
          outcome: stateOutcome,
          transaction: initialPublication,
          cancel: () => cancelDataLoad(initialLoadToken),
          complete: () => completeDataLoadSuccess(
            initialLoadToken,
            buildDatasetAnalyticsContext()
          )
        });
      currentDatasetLoadToken = null;
      debug.log(
        `[Main] Initial dataset state outcome: ` +
        `${settledStateOutcome.status}`
      );
    } else if (currentDatasetLoadToken !== null) {
      throw new Error(
        'Dataset analytics token exists without an initial dataset.'
      );
    }

    // Setup connectivity controls
    // NOTE: Handlers are ALWAYS set up so they work for datasets loaded dynamically (h5ad/zarr)
    // The handlers check if connectivityManifest is available before doing anything
    function initializeConnectivityControls() {
      // Show connectivity controls if data is available at bootstrap
      if (connectivityManifest !== null && connectivityControls) {
        connectivityControls.style.display = 'block';
      }

      // Use getter to always get current edge count (supports dynamic manifest updates)
      const getTotalEdges = () =>
        connectivityManifest === null ? 0 : connectivityManifest.n_edges;
      const EDGE_UI_CAP = 100000000;  // 100M edges max in UI
      // Retain the exact shuffled endpoints for KNN publication. Edge-prefix
      // counting itself belongs to the viewer's accepted per-view R8 owner.
      let edgeSources = null;
      let edgeDestinations = null;

      // UI statistics describe only the active pane, while every pane owns its
      // exact raw shuffled prefix inside the viewer.
      let activeConnectivityStatsViewId = null;
      let actualVisibleEdges = getTotalEdges();

      /**
       * Fisher-Yates shuffle for edge arrays (in-place, synchronized).
       * Uses seeded RNG for reproducibility across sessions.
       * This ensures "first N edges" is a truly random sample.
       */
      function shuffleEdges(sources, destinations, weights) {
        shuffleConnectivityEdges(sources, destinations, weights);
      }

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
       * An endpoint is visible only when its per-view Float32 transparency
       * passes the scatter threshold and its current LOD admits the source ID.
       *
       * @param {string} viewId - Exact live or snapshot view ID.
       * @param {number} dimensionLevel - Exact view dimension.
       * @returns {{transparency: Float32Array, lodMembership: object|null, pointCount: number}}
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
        // Get filter transparency:
        // - For live view: use state.getVisibilityArray()
        // - For snapshots: use snapshot's transparency if it has its own filters
        let transparency;
        if (viewId === 'live') {
          transparency = state.getVisibilityArray();
        } else {
          transparency = viewer.getViewTransparency(viewId);
        }

        if (
          !(transparency instanceof Float32Array) ||
          connectivityManifest === null ||
          transparency.length !== connectivityManifest.n_cells
        ) {
          throw new TypeError(
            'Connectivity filtering requires one exact Float32 visibility ' +
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
      let currentEdgeLimit = Math.min(250000, getTotalEdges());  // User's desired edge count (stable)

      /**
       * Update slider range based on visible edges.
       * - Slider max = visible edges (dynamic)
       * - User's preference (currentEdgeLimit) stays stable
       * - Slider value = min(preference, visible) to show what's achievable
       */
      function updateSliderRange(visibleEdges) {
        if (!connectivityLimitInput) return;
        const cappedMax = Math.min(visibleEdges, EDGE_UI_CAP);
        if (cappedMax === 0) {
          connectivityLimitInput.max = 0;
          connectivityLimitInput.min = 0;
          connectivityLimitInput.value = 0;
          if (connectivityLimitDisplay) {
            connectivityLimitDisplay.textContent = '0';
          }
          return;
        }
        const minVal = Math.min(
          cappedMax,
          clamp(Math.round(cappedMax * 0.01), 100, 1000)
        );

        connectivityLimitInput.max = cappedMax;
        connectivityLimitInput.min = minVal;

        // Slider shows achievable value, but preference stays unchanged
        const achievable = Math.min(currentEdgeLimit, cappedMax);
        connectivityLimitInput.value = Math.max(minVal, achievable);

        if (connectivityLimitDisplay) {
          connectivityLimitDisplay.textContent = formatEdgeCount(currentEdgeLimit);
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
        const currentStats =
          viewer.getEdgePrefixStatsForView(activeViewId);
        if (currentStats === null || currentStats.current !== true) {
          throw new Error(
            `Exact edge LOD requires the current active-view prefix owner ` +
            `for "${activeViewId}".`
          );
        }

        // One stable user target is resolved transactionally into a separate
        // exact raw prefix for every current pane.
        viewer.setEdgeVisibleTarget(currentEdgeLimit);
        const acceptedStats =
          viewer.getEdgePrefixStatsForView(activeViewId);
        if (
          acceptedStats === null ||
          acceptedStats.current !== true ||
          acceptedStats.visibleCount !== actualVisibleEdges
        ) {
          throw new Error(
            `Connectivity target publication for view "${activeViewId}" was incomplete.`
          );
        }
        updateConnectivityInfo(
          actualVisibleEdges,
          Math.min(currentEdgeLimit, actualVisibleEdges)
        );
      }

      // Initial slider setup and info display
      updateSliderRange(actualVisibleEdges);
      updateConnectivityInfo(actualVisibleEdges, Math.min(currentEdgeLimit, actualVisibleEdges));

      // Edge loading state
      let edgesLoaded = false;
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
        if (connectivityManifest === null) {
          throw new Error(
            'Connectivity edge loading requires a published connectivity manifest.'
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
          managerBaseUrl !== EXPORT_BASE_URL
        ) {
          throw createConnectivitySupersededError();
        }

        return {
          controller: new AbortController(),
          publicationGeneration: datasetPublicationGeneration,
          manifest: connectivityManifest,
          exportBaseUrl: EXPORT_BASE_URL,
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
          owner.manifest !== connectivityManifest ||
          owner.exportBaseUrl !== EXPORT_BASE_URL ||
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
        edgeSources = null;
        edgeDestinations = null;
        activeConnectivityStatsViewId = null;
        actualVisibleEdges = 0;
        currentEdgeLimit = 0;
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
        currentEdgeLimit = Math.min(250000, getTotalEdges());
        if (connectivityCheckbox) {
          connectivityCheckbox.checked = false;
          connectivityCheckbox.disabled = false;
        }
        if (connectivitySliders) {
          connectivitySliders.style.display = 'none';
        }
        updateSliderRange(actualVisibleEdges);
        updateConnectivityInfo(actualVisibleEdges, Math.min(currentEdgeLimit, actualVisibleEdges));
        if (connectivityControls) {
          connectivityControls.style.display =
            connectivityManifest === null ? 'none' : 'block';
        }
      }

      function publishConnectivityEdges(owner, edgeData) {
        assertCurrentConnectivityLoadOwner(owner);
        // The loader result is a private, unpublished generation. Shuffle its
        // typed owners directly instead of retaining a second 16-byte-per-edge
        // copy at the 100M-edge ceiling.
        shuffleEdges(
          edgeData.sources,
          edgeData.destinations,
          edgeData.weights
        );
        const renderEdgeData = Object.freeze({
          destinations: edgeData.destinations,
          nCells: edgeData.nCells,
          nEdges: edgeData.nEdges,
          sources: edgeData.sources,
          weights: edgeData.weights,
        });
        assertCurrentConnectivityLoadOwner(owner);

        edgeSources = renderEdgeData.sources;
        edgeDestinations = renderEdgeData.destinations;
        if (
          viewer.setupEdgesV2(
            renderEdgeData
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
        const liveStats = viewer.refreshEdgePrefixForView('live');
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
            viewer.refreshEdgePrefixForView(snapshot.id);
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
        actualVisibleEdges = activeStats.visibleCount;
        updateSliderRange(actualVisibleEdges);
        applyEdgeLodLimit();

        // Float64 weights are needed only for the one GPU normalization/upload
        // above. The retained lifecycle/KNN owner aliases the already-shuffled
        // endpoints and lets the 8-byte-per-edge weight generation be
        // collected immediately after this publication returns.
        const publishedEdgeData = Object.freeze({
          destinations: edgeDestinations,
          nCells: edgeData.nCells,
          nEdges: edgeData.nEdges,
          sources: edgeSources,
        });
        loadedEdgeData = publishedEdgeData;
        edgesLoaded = true;
        debug.log(
          `[Main] Connectivity generation published: ` +
          `${edgeData.nEdges} edges, ${edgeData.nCells} cells, ` +
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
        edgeSources = null;
        edgeDestinations = null;
        activeConnectivityStatsViewId = null;
        actualVisibleEdges = getTotalEdges();
        currentEdgeLimit = Math.min(250000, actualVisibleEdges);
        stopLodTracking();
        if (edgeVisibilityThrottleTimer !== null) {
          clearTimeout(edgeVisibilityThrottleTimer);
          edgeVisibilityThrottleTimer = null;
        }
        edgeVisibilityPending = false;
        updateSliderRange(actualVisibleEdges);
        updateConnectivityInfo(
          actualVisibleEdges,
          Math.min(currentEdgeLimit, actualVisibleEdges)
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
              getConnectivityManifestUrl(owner.exportBaseUrl),
              owner.manifest,
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

          // Check if connectivity manifest is available
          if (connectivityManifest === null) {
            console.warn('[Main] Connectivity checkbox toggled but no manifest available');
            connectivityCheckbox.checked = false;
            return;
          }

          // Load edge data on first toggle (or after manifest was reloaded)
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
              notifications.complete(connNotifId, `Loaded ${edgeData.nEdges.toLocaleString()} edges`);

            } catch (err) {
              if (
                isDatasetReloadSupersededError(err) ||
                toggleGeneration !== connectivityToggleGeneration
              ) {
                notifications.dismiss(connNotifId);
                return;
              }
              console.error('Failed to load connectivity data:', err);
              notifications.fail(connNotifId, 'Failed to load connectivity');
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
                connectivitySliders.style.display = 'none';
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
            connectivitySliders.style.display = show ? 'block' : 'none';
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
        const stats = viewer.refreshEdgePrefixForView(viewId);
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
            `Connectivity UI requires current prefix statistics for view "${viewId}".`
          );
        }
        activeConnectivityStatsViewId = viewId;
        actualVisibleEdges = stats.visibleCount;
        updateSliderRange(actualVisibleEdges);
        if (connectivityCheckbox?.checked) {
          applyEdgeLodLimit();
        }
      }

      function updateActiveConnectivityCounts() {
        if (!edgesLoaded) return;
        const activeViewId = state.getActiveViewId();
        const stats = viewer.refreshEdgePrefixForView(activeViewId);
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
              connectivitySliders.style.display = 'none';
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
          currentEdgeLimit = clamp(requested, min, max);
          connectivityLimitInput.value = currentEdgeLimit;
          connectivityLimitDisplay.textContent = formatEdgeCount(currentEdgeLimit);

          // Apply LOD limit using accurate visible edge calculation
          applyEdgeLodLimit();
        });
      }

      // Whether a dataset ships a neighbour graph is fixed for the whole life
      // of its publication, so it is worth saying exactly once. The renderer
      // asks for KNN edges when the mode is entered and again on every
      // Alt+drag, so announcing the absence per call stacks identical toasts
      // over one unchanged fact. This records the generation the absence was
      // announced for; the next publication carries a different generation and
      // therefore arms the announcement again, including for a dataset that
      // still has no neighbour graph.
      let announcedMissingConnectivityGeneration = null;

      // Set up KNN edge load callback - triggers when KNN mode needs edges
      // This loads edges on-demand when user first tries to use KNN drag
      viewer.setKnnEdgeLoadCallback(() => {
        if (connectivityManifest === null) {
          if (
            announcedMissingConnectivityGeneration !==
            datasetPublicationGeneration
          ) {
            announcedMissingConnectivityGeneration =
              datasetPublicationGeneration;
            console.warn(
              '[Main] KNN mode requested but no connectivity manifest available'
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
              edgesLoaded !== true ||
              loadedEdgeData !== edgeData
            ) {
              notifications.dismiss(knnNotifId);
              return;
            }
            if (
              viewer.loadKnnEdges(
                edgeData.sources,
                edgeData.destinations
              ) !== true
            ) {
              throw new Error(
                'The viewer rejected an exact KNN connectivity payload.'
              );
            }
            notifications.complete(
              knnNotifId,
              `Neighbor graph ready ` +
              `(${edgeData.nEdges.toLocaleString()} edges)`
            );
          } catch (err) {
            if (
              isDatasetReloadSupersededError(err) ||
              requestGeneration !== datasetPublicationGeneration
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

      return Object.freeze({
        prepareDatasetReplacement,
        synchronizeDatasetPublication
      });
    }

    // ========================================
    // PERFORMANCE BENCHMARK CONTROLS
    // ========================================
    const benchmarkRunBtn = document.getElementById('benchmark-run');
    const benchmarkCountInput = document.getElementById('benchmark-count');
    const benchmarkPatternSelect = document.getElementById('benchmark-pattern');
    const benchmarkStatsEl = document.getElementById('benchmark-stats');
    const benchPresets = document.querySelectorAll('.benchmark-preset');
    const benchmarkReportBtn = document.getElementById('benchmark-report-btn');
    const benchmarkReportOutput = document.getElementById('benchmark-report-output');
    const benchmarkSection = document.getElementById('benchmark-section');
    const benchPointsEl = document.getElementById('bench-points');
    const benchFpsEl = document.getElementById('bench-fps');
    const benchFrametimeEl = document.getElementById('bench-frametime');
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

    // FPS monitoring and the live harness are one small, lazy runtime. The
    // report and bottleneck analyzer remain a separate, explicitly requested
    // developer-support graph.
    let perfTracker = null;
    // Off-thread synthetic generation and the one point-count rule, captured
    // from the lazily loaded harness so the panel keeps its lazy boundary.
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

      const loadTask = import('./ui/modules/benchmark/index.js').then(
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
          generateSyntheticDataOffThread =
            harnessModule.generateSyntheticDataOffThread;
          assertSyntheticCount = harnessModule.assertSyntheticCount;
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
    // this path must never await `dev/benchmark.js`: that monolith also owns
    // report generation, analyzer code, GPU timers, GLB parsing and every
    // synthetic generator. Parsing all of it on a native Firefox main thread
    // that is already rendering smoke can indefinitely delay an otherwise
    // healthy panel and its independently loaded harness.
    function ensureBenchmarkModule() {
      if (benchmarkModuleLoaded) return Promise.resolve(true);
      if (benchmarkModuleLoadTask !== null) return benchmarkModuleLoadTask;

      const loadTask = (async () => {
        try {
          const [harnessModule, trackerModule] = await Promise.all([
            ensureBenchmarkHarnessModule(),
            import('./ui/modules/benchmark/performance-tracker.js'),
          ]);
          if (harnessModule === null || applicationRetired) return false;
          perfTracker = new trackerModule.PerformanceTracker();
          benchmarkModuleLoaded = true;
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

      const loadTask = import('../dev/benchmark.js').then(
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
        benchmarkStatsEl.style.display = 'block';
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
          benchGenInfoEl.style.display = 'block';
        } else {
          benchGenInfoEl.style.display = 'none';
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
          const frameText = displayFrameTime != null ? `${displayFrameTime} ms` : '-';
          benchFrametimeEl.textContent = renderFrameTime ? `${frameText} (render ${renderFrameTime} ms)` : frameText;
        }

        if (stats.samples >= 30 && benchTimingDetailsEl) {
          benchTimingDetailsEl.style.display = 'block';
          // Format timing values with 2 decimal places
          const formatTiming = (val) => typeof val === 'number' ? val.toFixed(2) : val;
          if (benchMinFtEl) benchMinFtEl.textContent = formatTiming(stats.minFrameTime) + ' ms';
          if (benchP95FtEl) benchP95FtEl.textContent = formatTiming(stats.p95FrameTime) + ' ms';
          if (benchMaxFtEl) benchMaxFtEl.textContent = formatTiming(stats.maxFrameTime) + ' ms';
        } else if (benchTimingDetailsEl) {
          benchTimingDetailsEl.style.display = 'none';
        }
      } else {
        if (benchFpsEl) benchFpsEl.textContent = '-';
        if (benchFrametimeEl) benchFrametimeEl.textContent = '-';
        if (benchTimingDetailsEl) benchTimingDetailsEl.style.display = 'none';
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
            `Performance benchmark panel was not changed: ` +
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
        // user activation, so initiate both lazy module requests in this task.
        // Once they settle, the browser's default action has already published
        // the exact `open` state and this owner can reconcile it directly.
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

    async function runBenchmark(pointCount, pattern) {
      const syntheticTransaction = datasetReloadCoordinator.begin();
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

      debug.log(`Running benchmark: ${formatNumber(pointCount)} points (${pattern})`);

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
      if (benchTimingDetailsEl) benchTimingDetailsEl.style.display = 'none';
      if (benchGenInfoEl) benchGenInfoEl.style.display = 'none';

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
          !(data.positions instanceof Float32Array) ||
          data.positions.length !== pointCount * 3 ||
          !(data.colors instanceof Uint8Array) ||
          data.colors.length !== pointCount * 4
        ) {
          throw new TypeError(
            'Synthetic benchmark data must contain exact dataset-length ' +
            'Float32 XYZ and Uint8 RGBA arrays.'
          );
        }
        candidateDimensionManager = createInMemoryDimensionManager({
          positions: data.positions,
          dimension: data.dimensionLevel
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
          if (previousRuntimeStage === null) {
            publishEmptyDatasetRuntime({
              clearViews: false,
              restorationPublication: previousPublication
            });
          } else {
            restoreRuntimeStage(
              previousRuntimeStage,
              previousPublication
            );
          }
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
          connectivityRuntimeOwner.prepareDatasetReplacement();
          connectivityRuntimeOwner.synchronizeDatasetPublication();
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
          runtimeRetirementOwner.retire(
            syntheticPublication.previousDimensionManager
          );
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
        benchGenInfoEl.style.display = 'block';
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

      trackDataLoadMethod(DATA_LOAD_METHODS.BENCHMARK_SYNTHETIC, {
        datasetId: `synthetic-${pattern}`,
        datasetName: `Synthetic ${pattern}`,
        sourceType: 'benchmark',
        cellCount: pointCount,
        obsFieldCount: 0,
        edgeCount: 0,
        durationMs: genTime,
        success: 1
      });

      const gpuMemEstimateMB =
        estimateBenchmarkGpuMemoryMB(pointCount);

      // Refresh stat panel immediately and start perf tracking loop
      activateBenchmarkingPanel({ resetTracker: true });

      debug.log(
        `Benchmark loaded: ${formatNumber(pointCount)} points, ` +
        `~${gpuMemEstimateMB.toFixed(1)}MB estimated GPU memory ` +
        `(gen: ${genTime}ms)`
      );
      return true;
    }

    async function generateSituationReport() {
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
        benchmarkReportOutput.style.display = 'block';
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
        const hpRenderer = viewer.getHPRenderer();
        if (!hpRenderer) {
          alert('Load some data first before analyzing performance.');
          return;
        }

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
        if (bottleneckProgress) bottleneckProgress.style.display = 'block';
        if (bottleneckResults) bottleneckResults.style.display = 'none';

        try {
          const analyzer = new BottleneckAnalyzer(gl, hpRenderer);

          const results = await analyzer.runAnalysis({
            warmupFrames: 30,
            testFrames: 100
          });

          // Hide progress, show results
          if (bottleneckProgress) bottleneckProgress.style.display = 'none';
          if (bottleneckResults) bottleneckResults.style.display = 'block';

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
          if (bottleneckProgress) bottleneckProgress.style.display = 'none';
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

    setDimensionLevel = (dim) => {
      const dimensionSelect = document.getElementById('dimension-select');
      if (dimensionSelect) {
        // Check if the dimension is available
        const option = dimensionSelect.querySelector(`option[value="${dim}"]`);
        if (option && !option.disabled) {
          dimensionSelect.value = String(dim);
          dimensionSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    };

    clearAllHighlights = () => {
      if (state.clearAllHighlights) {
        state.clearAllHighlights();
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
  } catch (thrown) {
    const startupError = normalizeStartupError(thrown);
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
    if (currentDatasetLoadToken) {
      try {
        completeDataLoadFailure(currentDatasetLoadToken, {
          ...buildDatasetAnalyticsContext(),
          error: startupError
        });
        currentDatasetLoadToken = null;
      } catch (analyticsError) {
        console.error(
          '[Main] Startup analytics failure reporting also failed:',
          analyticsError
        );
      }
    }
  }
})();
