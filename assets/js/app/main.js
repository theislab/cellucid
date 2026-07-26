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
import { createDataState } from './state/index.js';
import { initUI } from './ui/core/ui-coordinator.js';
import { createSessionSerializer } from './session/index.js';
import {
  createLatestDatasetReloadCoordinator,
  handleDatasetReloadFailure,
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
  createDatasetReloadSupersededError,
  isDatasetReloadSupersededError
} from '../data/dataset-lifecycle-errors.js';
import { getDataSourceManager } from '../data/data-source-manager.js';
import { createLocalUserDirDataSource } from '../data/local-user-source.js';
import { createRemoteDataSource } from '../data/remote-source.js';
import {
  createJupyterBridgeDataSource,
  getJupyterConfig,
  isJupyterContext,
  uploadJupyterSessionBundle
} from '../data/jupyter-source.js';
import {
  createJupyterCommandHandlers
} from './jupyter-command-handler.js';
// formatNumber imported from data-source.js; benchmark module lazy-loaded when needed
import { formatCellCount as formatNumber } from '../data/data-source.js';
import { createComparisonModule } from './analysis/comparison-module.js';
import { ThemeManager } from '../utils/theme-manager.js';
import { debug } from '../utils/debug.js';
import { clamp } from './utils/number-utils.js';
import { shuffleConnectivityEdges } from './utils/random-utils.js';
import { getGitHubAuthSession } from './community-annotations/github-auth.js';
import { initKeyboardShortcuts, initWelcomeModal, shouldShowWelcome, showWelcomeModal } from './ui/onboarding/index.js';
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
  readExactTrueUrlFlag,
  readOptionalExactUrlParameter,
  selectIntentDatasetId
} from './startup-url-intent.js';
import {
  normalizeStartupError,
  publishStartupFailure
} from './startup-failure.js';

debug.log('Starting…');

const FAST_BINARY_FETCH_INIT = { cache: 'force-cache' };

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

  try {
    ThemeManager.init();

    const canvas = document.getElementById('glcanvas');
    const labelLayer = document.getElementById('label-layer');
    const viewTitleLayer = document.getElementById('view-title-layer');
    statsEl = document.getElementById('stats');
    const themeSelect = document.getElementById('theme-select');
    const sidebar = document.getElementById('sidebar');
    const renderModeSelect = document.getElementById('render-mode');

    setDockableAccordions(initDockableAccordions({ sidebar }));

    if (themeSelect instanceof HTMLSelectElement) {
      themeSelect.value = ThemeManager.getTheme();
      themeSelect.addEventListener('change', () => {
        ThemeManager.setTheme(themeSelect.value);
      });
    }

    initWelcomeModal({
      onExplore() {
        const datasetSelect = document.getElementById('dataset-select');
        if (!(datasetSelect instanceof HTMLSelectElement)) {
          throw new Error(
            'Sample selection requires the dataset controls.'
          );
        }
        datasetSelect.focus();
      }
    });
    if (shouldShowWelcome()) {
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

    debug.log('[Main] Creating viewer...');
    const viewer = createViewer({ canvas, labelLayer, viewTitleLayer, sidebar });
    debug.log('[Main] Viewer created successfully');

    // Expose viewer globally for dev tools (benchmark, debugging)
    window._cellucidViewer = viewer;

    const state = createDataState({ viewer, labelLayer });
    debug.log('[Main] State created successfully');

    // Expose state globally for dev tools
    window._cellucidState = state;
    // benchmarkReporter will be created lazily when benchmark report is requested
    let benchmarkReporter = null;

    // Initialize notification center early
    const notifications = getNotificationCenter();
    notifications.init();

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

    // Initialize keyboard shortcuts (welcome modal already shown at bootstrap start)
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

    // Parse URL parameters early (needed for remote/jupyter detection)
    const urlParams = new URLSearchParams(window.location.search);
    const remoteUrlParam = readOptionalExactUrlParameter(
      urlParams,
      'remote'
    );
    const githubPathParam = readOptionalExactUrlParameter(
      urlParams,
      'github'
    );
    const sourceParam = readOptionalExactUrlParameter(
      urlParams,
      'source'
    );
    const requestedDataset = readOptionalExactUrlParameter(
      urlParams,
      'dataset'
    );
    const isAnndataMode = readExactTrueUrlFlag(
      urlParams,
      'anndata'
    );
    if (remoteUrlParam !== null && githubPathParam !== null) {
      throw new Error(
        'Startup cannot request both remote and GitHub dataset sources.'
      );
    }
    if (
      remoteUrlParam !== null &&
      sourceParam !== null &&
      sourceParam !== 'remote'
    ) {
      throw new Error(
        'The "remote" startup parameter requires source="remote".'
      );
    }
    if (
      githubPathParam !== null &&
      sourceParam !== null &&
      sourceParam !== 'github-repo'
    ) {
      throw new Error(
        'The "github" startup parameter requires source="github-repo".'
      );
    }
    if (
      isAnndataMode &&
      remoteUrlParam === null &&
      sourceParam !== null &&
      sourceParam !== 'remote'
    ) {
      throw new Error(
        'The "anndata" startup parameter requires a remote server source.'
      );
    }

    // Always register the user directory source through browser-independent file inputs.
    const userSource = createLocalUserDirDataSource();
    dataSourceManager.registerSource('local-user', userSource);

    // Register remote server source
    const remoteSource = createRemoteDataSource();
    dataSourceManager.registerSource('remote', remoteSource);

    const inJupyter = isJupyterContext();
    if (
      inJupyter &&
      (
        remoteUrlParam !== null ||
        githubPathParam !== null ||
        (sourceParam !== null && sourceParam !== 'jupyter')
      )
    ) {
      throw new Error(
        'Jupyter startup cannot be combined with another explicit source.'
      );
    }

    // Check if running in Jupyter context
    let jupyterSource = null;
    if (inJupyter) {
      debug.log('[Main] Detected Jupyter context, initializing bridge...');
      jupyterSource = createJupyterBridgeDataSource();
      dataSourceManager.registerSource('jupyter', jupyterSource);

      const jupyterInitialized = await jupyterSource.initialize();
      if (jupyterInitialized !== true) {
        throw new Error(
          'Jupyter context must initialize one authenticated Python server'
        );
      }
      debug.log('[Main] Jupyter bridge initialized successfully');

      const jupyterConfig = getJupyterConfig();
      if (jupyterConfig === null) {
        throw new Error(
          'Initialized Jupyter mode requires its authenticated configuration'
        );
      }

      // Freeze support: keep the last fully rendered view when Python stops.
      let jupyterFrozen = false;
      const freezeJupyterView = () => {
        if (jupyterFrozen) return;
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
        viewer.pause();
        overlay.style.display = 'block';
        jupyterFrozen = true;
      };

      jupyterSource.onMessage(message => {
        if (message.type === 'freeze') {
          freezeJupyterView();
        }
      });

      const healthInterval = setInterval(async () => {
        if (jupyterFrozen) {
          clearInterval(healthInterval);
          return;
        }
        try {
          await jupyterSource.checkHealth();
        } catch (error) {
          clearInterval(healthInterval);
          console.error(
            '[Main] Jupyter server health contract failed; freezing view:',
            error
          );
          notifications.error(
            'The Python server stopped or returned an invalid health response. ' +
            'The last complete view has been frozen.',
            {
              category: 'connectivity',
              title: 'Jupyter server disconnected',
              duration: 0
            }
          );
          freezeJupyterView();
        }
      }, 3000);

      if (
        typeof viewer.pickCellAtScreen !== 'function' ||
        typeof viewer.getPositions !== 'function'
      ) {
        throw new TypeError(
          'Jupyter pointer hooks require exact viewer picking and position APIs'
        );
      }

      let lastHoverCell = null;
      let lastHoverAt = 0;
      const HOVER_THROTTLE_MS = 50;

      canvas.addEventListener('mousemove', async event => {
        const now = performance.now();
        if (now - lastHoverAt < HOVER_THROTTLE_MS) return;
        lastHoverAt = now;

        const cellIndex = viewer.pickCellAtScreen(
          event.clientX,
          event.clientY
        );
        if (!Number.isInteger(cellIndex) || cellIndex < -1) {
          throw new TypeError(
            'Jupyter cell picking must return -1 or a non-negative integer'
          );
        }
        if (cellIndex === -1) {
          if (lastHoverCell !== null) {
            lastHoverCell = null;
            await jupyterSource.notifyHover(null, null);
          }
          return;
        }
        if (cellIndex === lastHoverCell) return;

        const activePositions = viewer.getPositions();
        if (
          !(activePositions instanceof Float32Array) ||
          activePositions.length < cellIndex * 3 + 3
        ) {
          throw new TypeError(
            'Jupyter hover requires complete Float32 XYZ positions'
          );
        }
        lastHoverCell = cellIndex;
        await jupyterSource.notifyHover(cellIndex, {
          x: activePositions[cellIndex * 3],
          y: activePositions[cellIndex * 3 + 1],
          z: activePositions[cellIndex * 3 + 2]
        });
      });

      canvas.addEventListener('mouseleave', async () => {
        if (lastHoverCell !== null) {
          lastHoverCell = null;
          await jupyterSource.notifyHover(null, null);
        }
      });

      canvas.addEventListener('click', async event => {
        const cellIndex = viewer.pickCellAtScreen(
          event.clientX,
          event.clientY
        );
        if (!Number.isInteger(cellIndex) || cellIndex < -1) {
          throw new TypeError(
            'Jupyter cell picking must return -1 or a non-negative integer'
          );
        }
        if (cellIndex === -1) return;
        await jupyterSource.notifyClick(cellIndex, {
          button: event.button,
          shift: event.shiftKey,
          ctrl: event.ctrlKey || event.metaKey
        });
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
            const remoteDatasetId = selectIntentDatasetId(
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

    // Register current sources without selecting scientific data.
    await dataSourceManager.initialize({
      // Jupyter mode owns one authenticated Python dataset source, so it does
      // not register the unrelated sample catalog.
      registerDemoCatalog: !inJupyter
    });

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

    function publishEmptyDatasetRuntime() {
      EXPORT_BASE_URL = '';
      dimensionManager = createDimensionManager({ baseUrl: '' });
      state.setDimensionManager(dimensionManager);
      state.setFieldLoader(null);
      state.setVarFieldLoader(null);
      state.varData = null;
      state._varFieldDescriptors = Object.freeze([]);
      state.setVectorFieldManager(null);
      if (statsEl) statsEl.textContent = 'No dataset selected';
    }

    async function stageDatasetRuntime({
      baseUrl,
      expectedIdentityId,
      showProgress,
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
      const candidateDimensionManager = createDimensionManager({
        baseUrl
      });

      try {
        const generation = await loadDatasetGeneration({
          expectedIdentityId,
          signal,
          loadIdentity: generationSignal =>
            loadDatasetIdentity(
              getDatasetIdentityUrl(baseUrl),
              { signal: generationSignal }
            ),
          loadObsManifest: generationSignal =>
            loadObsManifest(
              getObsManifestUrl(baseUrl),
              { signal: generationSignal }
            ),
          loadVarManifest: generationSignal =>
            loadVarManifest(
              getVarManifestUrl(baseUrl),
              { signal: generationSignal }
            ),
          loadConnectivityManifest: generationSignal =>
            loadConnectivityManifest(
              getConnectivityManifestUrl(baseUrl),
              { signal: generationSignal }
            ),
        });
        const embeddingsMetadata = getEmbeddingsMetadata(generation.identity);
        candidateDimensionManager.initFromMetadata(embeddingsMetadata);
        const positionStage = await stageDatasetPositionPayload({
          generation,
          dimensionManager: candidateDimensionManager,
          showProgress,
          signal
        });

        const fieldLoader = createObsFieldLoader(
          getObsManifestUrl(baseUrl),
          { fetchInit: FAST_BINARY_FETCH_INIT }
        );
        const varFieldLoader = generation.varManifest
          ? createVarFieldLoader(
              getVarManifestUrl(baseUrl),
              { fetchInit: FAST_BINARY_FETCH_INIT }
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
          defaultDimension: positionStage.defaultDimension,
          varFieldLoader,
          vectorFieldManager
        });
      } catch (error) {
        candidateDimensionManager.clearCache();
        throw error;
      }
    }

    let obs = null;
    let connectivityManifest = null;
    let positions = null;
    let datasetPublicationGeneration = 0;
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

    function commitDatasetRuntimeStage(stage) {
      const previousDimensionManager = dimensionManager;

      // This function is intentionally synchronous. The reload transaction is
      // checked immediately before this sole publication call, so no newer
      // selection can interleave with the dataset-owned state replacement.
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
      datasetPublicationGeneration++;

      return Object.freeze({
        generation: datasetPublicationGeneration,
        previousDimensionManager,
        stage
      });
    }

    function synchronizePublishedDatasetUi(
      activeMetadata,
      publication
    ) {
      if (
        publication === null ||
        typeof publication !== 'object' ||
        publication.generation !== datasetPublicationGeneration
      ) {
        throw new Error(
          'Published dataset UI synchronization requires the exact current ' +
          'publication.'
        );
      }
      return settlePublishedDatasetUi({
        synchronize: () => {
          connectivityRuntimeOwner.synchronizeDatasetPublication();
          publication.previousDimensionManager.clearCache();
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
        reportFailure: error => {
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
      try {
        const initialStage = await stageDatasetRuntime({
          baseUrl: initialBaseUrl,
          expectedIdentityId: initialExpectedIdentityId,
          showProgress: true,
          signal: initialLoadController.signal
        });
        initialPublication = commitDatasetRuntimeStage(initialStage);
      } catch (error) {
        if (currentDatasetLoadToken) {
          completeDataLoadFailure(currentDatasetLoadToken, {
            ...buildDatasetAnalyticsContext(),
            error
          });
          currentDatasetLoadToken = null;
        }
        throw error;
      }
    } else {
      // No explicit selection: publish the empty runtime while the catalog is
      // listed independently in the data controls.
      publishEmptyDatasetRuntime();
    }

    // In-place dataset reload for sources that cannot survive a page refresh (e.g., local-user)
    async function reloadActiveDatasetInPlace(metadataOverride = null, loadMethodOverride = null) {
      const reloadTransaction = datasetReloadCoordinator.begin();
      reloadTransaction.assertCurrent();
      // Capture both values before staging starts. Dispatch is bound to this
      // exact selection rather than whatever source might be active later.
      const baseUrl = dataSourceManager.getCurrentBaseUrl();
      const expectedIdentityId =
        dataSourceManager.getCurrentIdentityId();
      const activeMetadata =
        metadataOverride ?? dataSourceManager.getCurrentMetadata();
      if (baseUrl === null) {
        throw new Error('No dataset selected');
      }
      if (
        activeMetadata !== null &&
        (
          typeof activeMetadata !== 'object' ||
          Array.isArray(activeMetadata)
        )
      ) {
        throw new TypeError(
          'Selected dataset metadata must be an object or null.'
        );
      }

      const loadToken = startDatasetLoad(loadMethodOverride, { metadata: activeMetadata, reload: true });
      let stage;

      try {
        reloadTransaction.assertCurrent();
        stage = await stageDatasetRuntime({
          baseUrl,
          expectedIdentityId,
          showProgress: false,
          signal: reloadTransaction.signal
        });
        reloadTransaction.assertCurrent();
        if (window._comparisonModule) {
          window._comparisonModule.resetForDatasetReload({
            reason: 'local-user-inplace-reload'
          });
        }
      } catch (err) {
        return handleDatasetReloadFailure({
          error: err,
          transaction: reloadTransaction,
          cancel: () => cancelDataLoad(loadToken),
          reportFailure: failure => {
            console.error('[Main] Failed to reload dataset in-place:', failure);
            completeDataLoadFailure(loadToken, {
              ...buildDatasetAnalyticsContext({
                metadata: activeMetadata,
                datasetId: dataSourceManager.getCurrentDatasetId(),
                datasetName: activeMetadata?.name,
                reload: true
              }),
              error: failure
            });
          }
        });
      }

      // All fallible dataset I/O and validation has completed, and the owner
      // was rechecked. Publication is one synchronous, non-interleavable step.
      connectivityRuntimeOwner.prepareDatasetReplacement();
      const publication = commitDatasetRuntimeStage(stage);
      const synchronizationOutcome = synchronizePublishedDatasetUi(
        activeMetadata,
        publication
      );
      completeDataLoadSuccess(loadToken, buildDatasetAnalyticsContext({
        metadata: activeMetadata,
        datasetId: dataSourceManager.getCurrentDatasetId(),
        datasetName: activeMetadata?.name,
        reload: true
      }));
      return synchronizationOutcome;
    }
    // One-time helper to rebuild density from current visibility + grid
    function rebuildSmokeDensity(gridSize) {
      if (!Number.isInteger(gridSize) || gridSize < 8) {
        throw new RangeError(
          'Smoke density rebuild requires an exact gridSize integer of at least 8.'
        );
      }
      if (typeof state.getVisiblePositionsForSmoke !== 'function') {
        throw new TypeError(
          'Smoke density rebuild requires getVisiblePositionsForSmoke().'
        );
      }
      const visiblePositions = state.getVisiblePositionsForSmoke();
      if (
        !(visiblePositions instanceof Float32Array) ||
        visiblePositions.length === 0 ||
        visiblePositions.length % 3 !== 0
      ) {
        throw new TypeError(
          'Smoke density rebuild requires non-empty Float32 XYZ positions.'
        );
      }

      debug.log(`Building smoke volume at ${gridSize}^3 from ${visiblePositions.length / 3} visible points (GPU)…`);
      // Use GPU-accelerated splatting for dramatic speedup
      viewer.buildSmokeVolumeGPU(visiblePositions, {
        gridSize,
        gamma: 0.7
      });
    }

    // Smoke volume is built lazily when switching to smoke mode
    // (no initial build to save startup time)

    const sessionSerializer = createSessionSerializer({ state, viewer, sidebar, dataSourceManager });

    // -----------------------------------------------------------------------
    // Jupyter "no-download" session bundle capture (viewer → Python)
    // -----------------------------------------------------------------------
    if (jupyterSource) {
      const jupyterConfig = getJupyterConfig();
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
      reloadActiveDataset: reloadActiveDatasetInPlace,
      sessionSerializer,
      dataSourceManager,
      jupyterSource
    });

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
      const comparisonModule = createComparisonModule({
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
      synchronizePublishedDatasetUi(
        dataSourceManager.getCurrentMetadata(),
        initialPublication
      );
      await ui.activateField(-1);
    }
    if (currentDatasetLoadToken) {
      completeDataLoadSuccess(currentDatasetLoadToken, buildDatasetAnalyticsContext());
      currentDatasetLoadToken = null;
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

      // Store edge arrays for accurate visible edge counting
      let edgeSources = null;
      let edgeDestinations = null;

      // Cached visibility state for edge counting
      let cachedCombinedVisibility = null; // Combined: filter AND LOD visibility
      let lastLodLevel = -1;               // Track LOD level for change detection
      let actualVisibleEdges = getTotalEdges();

      // Reusable per-view buffers for combined visibility (avoids GC pressure
      // without allowing one snapshot to overwrite the live-view result).
      const combinedVisibilityBuffers = new Map();

      // Prefix sum for accurate LOD limit calculation
      let visibleEdgePrefixSum = null;

      /**
       * Fisher-Yates shuffle for edge arrays (in-place, synchronized).
       * Uses seeded RNG for reproducibility across sessions.
       * This ensures "first N edges" is a truly random sample.
       */
      function shuffleEdges(sources, destinations, weights) {
        shuffleConnectivityEdges(sources, destinations, weights);
      }

      /**
       * Combine filter visibility with LOD visibility.
       * An edge is visible only if BOTH endpoints pass filters AND are visible at current LOD.
       *
       * Performance: Reuses buffer, returns filterVis directly when LOD is disabled/full detail.
       *
       * @param {string} viewId - Exact live or snapshot view ID.
       * @param {number} dimensionLevel - Exact dimension level for LOD calculation.
       * @returns {Float32Array|null} Combined visibility array
       */
      function getCombinedVisibility(viewId, dimensionLevel) {
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
        // Get filter visibility:
        // - For live view: use state.getVisibilityArray()
        // - For snapshots: use snapshot's transparency if it has its own filters
        let filterVis;
        if (viewId === 'live') {
          filterVis = state.getVisibilityArray();
        } else {
          filterVis = viewer.getViewTransparency(viewId);
        }

        // Get LOD visibility for this specific view and dimension
        const lodVis = viewer.getLodVisibilityArray(viewId, dimensionLevel);

        if (
          !(filterVis instanceof Float32Array) ||
          connectivityManifest === null ||
          filterVis.length !== connectivityManifest.n_cells
        ) {
          throw new TypeError(
            'Connectivity filtering requires one exact Float32 visibility ' +
            'value per cell.'
          );
        }
        if (lodVis === null) {
          return filterVis;
        }
        if (
          !(lodVis instanceof Float32Array) ||
          lodVis.length !== filterVis.length
        ) {
          throw new TypeError(
            'Connectivity LOD requires one exact Float32 visibility value ' +
            'per cell.'
          );
        }

        const n = filterVis.length;

        const bufferKey = viewId;
        let combinedVisibilityBuffer =
          combinedVisibilityBuffers.get(bufferKey);
        if (
          combinedVisibilityBuffer === undefined ||
          combinedVisibilityBuffer.length !== n
        ) {
          combinedVisibilityBuffer = new Float32Array(n);
          combinedVisibilityBuffers.set(
            bufferKey,
            combinedVisibilityBuffer
          );
        }

        // Combined visibility = filter AND LOD
        // For transparency arrays, use threshold of 0.01 (nearly transparent = hidden)
        for (let i = 0; i < n; i++) {
          combinedVisibilityBuffer[i] = (filterVis[i] > 0.01 && lodVis[i] > 0.5) ? 1.0 : 0.0;
        }

        return combinedVisibilityBuffer;
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

      /**
       * Count visible edges accurately by checking both endpoints.
       * Builds a prefix sum for exact LOD limit calculation via binary search.
       * O(nEdges) but uses typed arrays for speed.
       * @param {Float32Array} visibility - Per-cell visibility (0 or 1)
       * @returns {{visibleCount: number}}
       */
      function countVisibleEdges(visibility) {
        if (
          !(edgeSources instanceof Uint32Array) ||
          !(edgeDestinations instanceof Uint32Array) ||
          edgeSources.length !== edgeDestinations.length ||
          !(visibility instanceof Float32Array) ||
          connectivityManifest === null ||
          edgeSources.length !== connectivityManifest.n_edges ||
          visibility.length !== connectivityManifest.n_cells
        ) {
          throw new TypeError(
            'Visible-edge counting requires exact render-owned edge and ' +
            'visibility arrays.'
          );
        }
        const n = edgeSources.length;

        // Build prefix sum: prefixSum[i] = number of visible edges in [0, i)
        // Use Uint32Array for memory efficiency (supports up to 4B edges)
        if (!visibleEdgePrefixSum || visibleEdgePrefixSum.length !== n + 1) {
          visibleEdgePrefixSum = new Uint32Array(n + 1);
        }

        visibleEdgePrefixSum[0] = 0;
        for (let i = 0; i < n; i++) {
          const src = edgeSources[i];
          const dst = edgeDestinations[i];
          const isVisible = (visibility[src] > 0.5 && visibility[dst] > 0.5) ? 1 : 0;
          visibleEdgePrefixSum[i + 1] = visibleEdgePrefixSum[i] + isVisible;
        }

        return { visibleCount: visibleEdgePrefixSum[n] };
      }

      /**
       * Find exact LOD limit to show targetVisible edges using binary search on prefix sum.
       * Since edges are shuffled, this gives us exactly targetVisible random edges.
       * @param {number} targetVisible - Desired number of visible edges
       * @returns {number} - Exact LOD limit
       */
      function findLodLimitFast(targetVisible) {
        if (
          !(edgeSources instanceof Uint32Array) ||
          !(edgeDestinations instanceof Uint32Array) ||
          edgeSources.length !== edgeDestinations.length
        ) {
          throw new Error(
            'Exact edge LOD requires the current render-owned edge arrays.'
          );
        }
        if (targetVisible >= actualVisibleEdges) {
          return edgeSources.length;
        }
        if (actualVisibleEdges <= 0 || targetVisible <= 0) {
          return 0;
        }

        if (
          !(visibleEdgePrefixSum instanceof Uint32Array) ||
          visibleEdgePrefixSum.length !== edgeSources.length + 1
        ) {
          throw new Error(
            'Exact edge LOD requires the current visibility prefix sum.'
          );
        }

        // Find the smallest prefix containing targetVisible visible edges.
        let lo = 0;
        let hi = visibleEdgePrefixSum.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (visibleEdgePrefixSum[mid] < targetVisible) {
            lo = mid + 1;
          } else {
            hi = mid;
          }
        }
        return lo;
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
        if (cachedCombinedVisibility === null) {
          throw new Error(
            'Exact edge LOD requires current combined visibility.'
          );
        }

        // Calculate the exact render prefix containing currentEdgeLimit
        // visible edges.
        const targetVisible = Math.min(currentEdgeLimit, actualVisibleEdges);
        const lodLimit = findLodLimitFast(targetVisible);
        viewer.setEdgeLodLimit(lodLimit);
        updateConnectivityInfo(actualVisibleEdges, targetVisible);
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
        viewer.setShowConnectivity(false);
        viewer.clearEdgesV2();
        viewer.clearKnnEdges();
        abortConnectivityLoad();
        connectivityToggleGeneration++;
        knnLoadPromise = null;
        edgesLoaded = false;
        loadedEdgeData = null;
        edgeSources = null;
        edgeDestinations = null;
        cachedCombinedVisibility = null;
        visibleEdgePrefixSum = null;
        combinedVisibilityBuffers.clear();
        actualVisibleEdges = 0;
        currentEdgeLimit = 0;
        lastLodLevel = -1;
        stopLodTracking();
        if (edgeVisibilityThrottleTimer !== null) {
          clearTimeout(edgeVisibilityThrottleTimer);
          edgeVisibilityThrottleTimer = null;
        }
        edgeVisibilityPending = false;
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
        const renderEdgeData = Object.freeze({
          ...edgeData,
          sources: edgeData.sources.slice(),
          destinations: edgeData.destinations.slice(),
          weights: edgeData.weights.slice()
        });
        shuffleEdges(
          renderEdgeData.sources,
          renderEdgeData.destinations,
          renderEdgeData.weights
        );
        assertCurrentConnectivityLoadOwner(owner);

        edgeSources = renderEdgeData.sources;
        edgeDestinations = renderEdgeData.destinations;
        if (
          viewer.setupEdgesV2(
            renderEdgeData,
            state.positionsArray
          ) !== true
        ) {
          throw new Error(
            'The viewer rejected an exact connectivity edge payload.'
          );
        }

        const existingSnapshots = viewer.getSnapshotViews();
        for (const snapshot of existingSnapshots) {
          const snapshotPositions = viewer.getViewPositions(snapshot.id);
          if (
            viewer.setupEdgesV2ForView(
              snapshot.id,
              snapshotPositions,
              snapshotPositions.length / 3
            ) !== true
          ) {
            throw new Error(
              `The viewer rejected connectivity positions for view "${snapshot.id}".`
            );
          }
        }

        cachedCombinedVisibility = getCombinedVisibility(
          'live',
          viewer.getViewDimension('live')
        );
        if (cachedCombinedVisibility !== null) {
          if (
            viewer.updateEdgeVisibilityV2(
              cachedCombinedVisibility
            ) !== true
          ) {
            throw new Error(
              'The viewer rejected live connectivity visibility.'
            );
          }
          for (const snapshot of existingSnapshots) {
            const snapshotDimension = viewer.getViewDimension(
              snapshot.id
            );
            const snapshotVisibility = getCombinedVisibility(
              snapshot.id,
              snapshotDimension
            );
            if (snapshotVisibility !== null) {
              if (
                viewer.updateEdgeVisibilityV2ForView(
                  snapshot.id,
                  snapshotVisibility
                ) !== true
              ) {
                throw new Error(
                  `The viewer rejected connectivity visibility for view ` +
                  `"${snapshot.id}".`
                );
              }
            }
          }
          const { visibleCount } = countVisibleEdges(
            cachedCombinedVisibility
          );
          actualVisibleEdges = visibleCount;
        }
        lastLodLevel = viewer.getCurrentLODLevel(state.getActiveViewId());
        updateSliderRange(actualVisibleEdges);
        applyEdgeLodLimit();

        loadedEdgeData = edgeData;
        edgesLoaded = true;
        debug.log(
          `[Main] Connectivity generation published: ` +
          `${edgeData.nEdges} edges, ${edgeData.nCells} cells, ` +
          `${actualVisibleEdges} visible.`
        );
        return edgeData;
      }

      function clearPublishedConnectivityEdges() {
        viewer.setShowConnectivity(false);
        viewer.clearEdgesV2();
        viewer.clearKnnEdges();
        edgesLoaded = false;
        loadedEdgeData = null;
        edgeSources = null;
        edgeDestinations = null;
        cachedCombinedVisibility = null;
        visibleEdgePrefixSum = null;
        combinedVisibilityBuffers.clear();
        actualVisibleEdges = getTotalEdges();
        currentEdgeLimit = Math.min(250000, actualVisibleEdges);
        lastLodLevel = -1;
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
            updateEdgeVisibilityCore();
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

      /**
       * Update edge visibility with combined filter + LOD visibility.
       * Called when filters change or LOD level changes.
       * Updates all views (live + snapshots) for proper multi-view support.
       */
      function updateEdgeVisibilityCore() {
        if (!edgesLoaded) return;

        // Update live view edges
        cachedCombinedVisibility = getCombinedVisibility(
          'live',
          viewer.getViewDimension('live')
        );
        if (cachedCombinedVisibility === null) {
          throw new Error(
            'Connectivity visibility is unavailable for the live view.'
          );
        }

        if (
          viewer.updateEdgeVisibilityV2(
            cachedCombinedVisibility
          ) !== true
        ) {
          throw new Error(
            'The viewer rejected live connectivity visibility.'
          );
        }

        // Update all snapshot views' edge visibility
        const snapshots = viewer.getSnapshotViews();
        for (const snapshot of snapshots) {
          const snapshotVis = getCombinedVisibility(
            snapshot.id,
            viewer.getViewDimension(snapshot.id)
          );
          if (snapshotVis === null) {
            throw new Error(
              `Connectivity visibility is unavailable for view ` +
              `"${snapshot.id}".`
            );
          }
          if (
            viewer.updateEdgeVisibilityV2ForView(
              snapshot.id,
              snapshotVis
            ) !== true
          ) {
            throw new Error(
              `The viewer rejected connectivity visibility for view ` +
              `"${snapshot.id}".`
            );
          }
        }

        // Count actual visible edges (both endpoints visible) - for live view
        const { visibleCount } = countVisibleEdges(cachedCombinedVisibility);
        actualVisibleEdges = visibleCount;

        // Update slider range (dynamic) and apply LOD limit
        updateSliderRange(actualVisibleEdges);
        if (connectivityCheckbox?.checked) {
          applyEdgeLodLimit();
        }
      }

      // Throttled version: executes immediately, then ignores calls for 32ms
      // with a trailing call if any were skipped
      let edgeVisibilityThrottleTimer = null;
      let edgeVisibilityPending = false;
      function updateEdgeVisibility() {
        if (edgeVisibilityThrottleTimer) {
          // Already throttling, mark pending for trailing execution
          edgeVisibilityPending = true;
          return;
        }
        // Execute immediately
        updateEdgeVisibilityCore();
        // Start throttle period
        edgeVisibilityThrottleTimer = setTimeout(() => {
          edgeVisibilityThrottleTimer = null;
          if (edgeVisibilityPending) {
            edgeVisibilityPending = false;
            updateEdgeVisibilityCore();
          }
        }, 32); // ~2 frames at 60fps
      }

      // Update edges when filter visibility changes
      const onVisibilityChange = () => {
        updateEdgeVisibility();
      };

      // Poll for LOD changes (LOD changes during render based on camera distance)
      let lodCheckInterval = null;
      function startLodTracking() {
        if (lodCheckInterval) return;
        lodCheckInterval = setInterval(() => {
          if (!edgesLoaded || !connectivityCheckbox?.checked) return;

          const currentLod = viewer.getCurrentLODLevel(state.getActiveViewId());
          if (currentLod !== lastLodLevel) {
            debug.log(`[Edges] LOD changed: ${lastLodLevel} → ${currentLod}`);
            lastLodLevel = currentLod;
            updateEdgeVisibility();
          }
        }, 200); // Check every 200ms
      }

      function stopLodTracking() {
        if (lodCheckInterval) {
          clearInterval(lodCheckInterval);
          lodCheckInterval = null;
        }
      }
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

      // Set up KNN edge load callback - triggers when KNN mode needs edges
      // This loads edges on-demand when user first tries to use KNN drag
      viewer.setKnnEdgeLoadCallback(() => {
        if (connectivityManifest === null) {
          console.warn(
            '[Main] KNN mode requested but no connectivity manifest available'
          );
          notifications.warning(
            'No neighbor graph available for this dataset',
            { category: 'connectivity' }
          );
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

    // HP renderer controls (always-on HP renderer)
    const hpShaderQuality = document.getElementById('hp-shader-quality');
    const hpFrustumCulling = document.getElementById('hp-frustum-culling');
    const hpLodEnabled = document.getElementById('hp-lod-enabled');
    const hpLodForceContainer = document.getElementById('lod-force-container');
    const hpLodForce = document.getElementById('hp-lod-force');
    const hpLodForceLabel = document.getElementById('hp-lod-force-label');

    // Performance tracker for FPS monitoring (lazy-loaded with benchmark module)
    let perfTracker = null;
    let SyntheticDataGenerator = null;  // For synthetic data generation
    let BenchmarkReporter = null;       // For report generation
    let benchmarkModuleLoaded = false;

    // Lazy-load benchmark module when first needed
    async function ensureBenchmarkModule() {
      if (benchmarkModuleLoaded) return true;
      try {
        const benchmarkModule = await import('../dev/benchmark.js');
        SyntheticDataGenerator = benchmarkModule.SyntheticDataGenerator;
        BenchmarkReporter = benchmarkModule.BenchmarkReporter;
        const PerformanceTrackerClass = benchmarkModule.PerformanceTracker;
        perfTracker = new PerformanceTrackerClass();
        benchmarkModuleLoaded = true;
        debug.log('[Main] Benchmark module lazy-loaded');
        return true;
      } catch (err) {
        console.error('[Main] Failed to load benchmark module:', err);
        return false;
      }
    }

    let benchmarkActive = false;
    let activeDatasetMode = 'real';
    let syntheticDatasetInfo = null;
    let latestPerfSample = null;
    let latestRendererStats = null;
    let perfLoopHandle = null;

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
        const gpuMemMB = ((pointCount ?? visiblePoints ?? 0) * 28 / 1024 / 1024).toFixed(1);
        benchMemoryEl.textContent = `${gpuMemMB} MB`;
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

      const tick = () => {
        if (!benchmarkActive) {
          perfLoopHandle = null;
          return;
        }

        const stats = perfTracker.recordFrame();
        const activeViewId = state.getActiveViewId();
        if (!viewer.hasRendererStats(activeViewId)) {
          perfLoopHandle = requestAnimationFrame(tick);
          return;
        }
        const hpStats = viewer.getRendererStats(activeViewId);
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

    const stopPerfMonitoring = () => {
      benchmarkActive = false;
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

    // Shader quality change
    if (hpShaderQuality) {
      hpShaderQuality.addEventListener('change', () => {
        viewer.setShaderQuality(hpShaderQuality.value);
      });
    }

    // Frustum culling toggle
    if (hpFrustumCulling) {
      hpFrustumCulling.addEventListener('change', () => {
        viewer.setFrustumCulling(hpFrustumCulling.checked);
      });
    }

    // LOD enabled toggle
    if (hpLodEnabled) {
      hpLodEnabled.addEventListener('change', () => {
        viewer.setAdaptiveLOD(hpLodEnabled.checked);
        // Show/hide force LOD slider
        if (hpLodForceContainer) {
          hpLodForceContainer.style.display = hpLodEnabled.checked ? 'block' : 'none';
        }
        // Reset force LOD slider to auto when enabling OR disabling LOD
        // When disabling: ensures UI stays in sync with renderer (which resets forceLODLevel to -1)
        // When enabling: starts fresh in auto mode
        if (hpLodForce) {
          hpLodForce.value = '-1';
          if (hpLodForceLabel) hpLodForceLabel.textContent = 'Auto';
          // Only call setForceLOD when enabling (renderer already resets when disabling)
          if (hpLodEnabled.checked) {
            viewer.setForceLOD(-1);
          }
        }
      });
    }

    // Force LOD slider
    if (hpLodForce) {
      hpLodForce.addEventListener('input', () => {
        const val = parseInt(hpLodForce.value, 10);
        if (hpLodForceLabel) {
          hpLodForceLabel.textContent = val < 0 ? 'Auto' : String(val);
        }
        viewer.setForceLOD(val);
      });
    }

    if (benchmarkSection) {
      benchmarkSection.addEventListener('toggle', async () => {
        if (benchmarkSection.open) {
          // Lazy-load benchmark module when section is first opened
          await ensureBenchmarkModule();
          activateBenchmarkingPanel({ resetTracker: true });
        } else {
          stopPerfMonitoring();
        }
      });
    }

    async function runBenchmark(pointCount, pattern) {
      // Ensure benchmark module is loaded before running
      const moduleLoaded = await ensureBenchmarkModule();
      if (!moduleLoaded || !SyntheticDataGenerator) {
        console.error('[Main] Cannot run benchmark: SyntheticDataGenerator not available');
        notifications.error('Benchmark module failed to load', { category: 'benchmark' });
        return;
      }

      debug.log(`Running benchmark: ${formatNumber(pointCount)} points (${pattern})`);

      // Show notification for benchmark data generation
      const benchNotifId = notifications.startDataGeneration(pattern, pointCount);

      ensureBenchmarkStatsVisible();
      if (benchFpsEl) benchFpsEl.textContent = '-';
      if (benchFrametimeEl) benchFrametimeEl.textContent = '-';
      if (benchTimingDetailsEl) benchTimingDetailsEl.style.display = 'none';
      if (benchGenInfoEl) benchGenInfoEl.style.display = 'none';

      // Generate synthetic data with timing
      let data;
      const genStart = performance.now();
      try {
        switch (pattern) {
          case 'uniform':
            data = SyntheticDataGenerator.uniformRandom(pointCount);
            break;
          case 'atlas':
            data = SyntheticDataGenerator.atlasLike(pointCount);
            break;
          case 'batches':
            data = SyntheticDataGenerator.batchEffects(pointCount);
            break;
          case 'octopus':
            data = SyntheticDataGenerator.octopus(pointCount);
            break;
          case 'spirals':
            data = SyntheticDataGenerator.spirals(pointCount);
            break;
          case 'flatumap':
            data = SyntheticDataGenerator.flatUMAP(pointCount);
            break;
          case 'glb':
            // Async loading from GLB file - update notification
            notifications.updateBenchmark(benchNotifId, 10, 'Loading GLB model...');
            data = await SyntheticDataGenerator.fromGLBUrl(pointCount);
            break;
          case 'clusters':
          default:
            data = SyntheticDataGenerator.gaussianClusters(pointCount);
        }
      } catch (err) {
        console.error('Failed to generate data:', err);
        const message = pattern === 'glb'
          ? `GLB load failed: ${err.message || err}`
          : `Error: ${err.message || err}`;
        notifications.fail(benchNotifId, `Benchmark failed: ${message}`);
        return;
      }
      const genTime = Math.round(performance.now() - genStart);
      let candidateDimensionManager;
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
        return;
      }

      const previousDimensionManager = dimensionManager;
      try {
        state.initSyntheticScene({
          positions: data.positions,
          colors: data.colors,
          dimensionLevel: data.dimensionLevel,
          dimensionManager: candidateDimensionManager
        });
      } catch (error) {
        candidateDimensionManager.clearCache();
        console.error('Failed to publish benchmark data:', error);
        notifications.fail(
          benchNotifId,
          `Benchmark failed: ${error.message}`
        );
        return;
      }

      // The exact DataState generation is now live. Publish the matching app
      // runtime and retire every previous dataset-count owner synchronously.
      EXPORT_BASE_URL = '';
      dimensionManager = candidateDimensionManager;
      obs = state.obsData;
      positions = data.positions;
      connectivityManifest = null;
      datasetPublicationGeneration++;
      connectivityRuntimeOwner.prepareDatasetReplacement();
      connectivityRuntimeOwner.synchronizeDatasetPublication();
      previousDimensionManager.clearCache();
      if (window._comparisonModule) {
        window._comparisonModule.resetForDatasetReload({
          reason: 'synthetic-benchmark-publication'
        });
      }

      // Ensure point rendering mode only after the complete replacement has
      // succeeded, so a rejected benchmark preserves the previous runtime.
      if (renderModeSelect && renderModeSelect.value !== 'points') {
        renderModeSelect.value = 'points';
        viewer.setRenderMode('points');
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

      const gpuMemMB = (pointCount * 28 / 1024 / 1024).toFixed(1);

      // Refresh stat panel immediately and start perf tracking loop
      activateBenchmarkingPanel({ resetTracker: true });

      debug.log(`Benchmark loaded: ${formatNumber(pointCount)} points, ~${gpuMemMB}MB GPU memory (gen: ${genTime}ms)`);
    }

    async function generateSituationReport() {
      // Ensure benchmark module is loaded
      const moduleLoaded = await ensureBenchmarkModule();
      if (!moduleLoaded || !BenchmarkReporter) {
        console.warn('[Main] Benchmark module not loaded, cannot generate report');
        notifications.error('Benchmark module not available', { category: 'benchmark' });
        return;
      }

      // Create benchmarkReporter lazily on first use
      if (!benchmarkReporter) {
        benchmarkReporter = new BenchmarkReporter({ viewer, state, canvas });
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

    // Wire up run button
    if (benchmarkRunBtn) {
      benchmarkRunBtn.addEventListener('click', () => {
        const count = parseInt(benchmarkCountInput?.value || '1000000', 10);
        const pattern = benchmarkPatternSelect?.value || 'clusters';
        runBenchmark(count, pattern);
      });
    }

    if (benchmarkReportBtn) {
      benchmarkReportBtn.addEventListener('click', () => {
        generateSituationReport();
      });
    }

    // Wire up preset buttons
    benchPresets.forEach(btn => {
      btn.addEventListener('click', () => {
        const count = parseInt(btn.dataset.count, 10);
        if (benchmarkCountInput) benchmarkCountInput.value = count;
        const pattern = benchmarkPatternSelect?.value || 'clusters';
        runBenchmark(count, pattern);
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

        await ensureBenchmarkModule();
        const benchmarkModule = await import('../dev/benchmark.js');
        const BottleneckAnalyzer = benchmarkModule.BottleneckAnalyzer;

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
          const verdictIcon = document.getElementById('bn-verdict-icon');
          const verdictTitle = document.getElementById('bn-verdict-title');
          const verdictDetail = document.getElementById('bn-verdict-detail');

          let verdictText, detailText, icon, status;

          if (fps >= 55) {
            icon = '✅';
            status = 'good';
            verdictText = 'Performance is good';
            detailText = 'Running smoothly at ' + fps.toFixed(0) + ' FPS. No issues detected.';
          } else if (fps >= 30) {
            icon = '⚠️';
            status = 'warning';
            verdictText = 'Performance could be better';
            detailText = b.primary.type + ' is the main bottleneck. ' + (b.primary.evidence || '');
          } else {
            icon = '🔴';
            status = 'danger';
            verdictText = 'Serious performance problem';
            detailText = b.primary.type + ' is severely limiting performance. ' + (b.primary.evidence || '');
          }

          if (verdictBox) {
            verdictBox.dataset.status = status;
          }
          if (verdictIcon) verdictIcon.textContent = icon;
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

            // Add specific overhead issues
            const shaderMs = parseFloat(s.overhead.shaderComplexityMs) || 0;
            if (shaderMs > 3) {
              items.push(createListItem(`• Shader complexity adds ${shaderMs.toFixed(1)}ms per frame`, { status: 'warning' }));
            }

            // Add jank/stuttering issues
            if (s.frameStability && s.frameStability.hasJank) {
              const severity = s.frameStability.jankSeverity;
              const stutterStatus = severity === 'mild' ? 'warning' : 'danger';
              const stutterIcon = stutterStatus === 'danger' ? '🔴' : '⚠️';
              items.push(createListItem(`• ${stutterIcon} Frame stuttering: ${s.frameStability.diagnosis} (${s.frameStability.jankPercent} janky frames)`, { status: stutterStatus }));
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
          const bnShaderOverhead = document.getElementById('bn-shader-overhead');

          if (bnVisiblePoints) bnVisiblePoints.textContent = formatNumShort(s.rendering.visiblePoints);
          if (bnGpuMemory) bnGpuMemory.textContent = s.rendering.gpuMemoryMB + 'MB';
          if (bnLodLevel) bnLodLevel.textContent = Math.round(s.rendering.lodLevel);
          if (bnDrawCalls) bnDrawCalls.textContent = Math.round(s.rendering.drawCalls);
          if (bnFrametime) bnFrametime.textContent = s.performance.avgFrameTimeMs.toFixed(1) + 'ms';
          if (bnP95) bnP95.textContent = s.performance.p95FrameTimeMs.toFixed(1) + 'ms';
          if (bnLodOverhead) bnLodOverhead.textContent = s.overhead.lodMs + 'ms';
          if (bnFrustumOverhead) bnFrustumOverhead.textContent = s.overhead.frustumCullingMs + 'ms';
          if (bnShaderOverhead) bnShaderOverhead.textContent = s.overhead.shaderComplexityMs + 'ms';

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
