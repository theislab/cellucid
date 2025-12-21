// App entrypoint: loads data, initializes the viewer/state, and wires the UI.
import { createViewer } from '../rendering/viewer.js';
import { createDataState } from './state.js';
import { initUI } from './ui.js';
import { createStateSerializer } from './state-serializer.js';
import { initDockableAccordions } from './dockable-accordions.js';
import { setDockableAccordions } from './dockable-accordions-registry.js';
import { getNotificationCenter } from './notification-center.js';
import {
  loadObsManifest,
  createObsFieldLoader,
  loadVarManifest,
  createVarFieldLoader,
  loadConnectivityManifest,
  hasEdgeFormat,
  loadEdges,
  loadDatasetIdentity,
  getEmbeddingsMetadata
} from '../data/data-loaders.js';
import { createDimensionManager } from '../data/dimension-manager.js';
import { getDataSourceManager } from '../data/data-source-manager.js';
import { createLocalUserDirDataSource } from '../data/local-user-source.js';
import { createRemoteDataSource } from '../data/remote-source.js';
import { createJupyterBridgeDataSource, isJupyterContext, getJupyterConfig } from '../data/jupyter-source.js';
// formatNumber imported from data-source.js; benchmark module lazy-loaded when needed
import { formatCellCount as formatNumber } from '../data/data-source.js';
import { createComparisonModule } from './analysis/comparison-module.js';
import { ThemeManager } from '../utils/theme-manager.js';
import {
  initAnalytics,
  trackDataLoadMethod,
  beginDataLoad,
  completeDataLoadSuccess,
  completeDataLoadFailure,
  DATA_LOAD_METHODS
} from '../analytics/tracker.js';
import { initPerformanceAnalytics } from '../analytics/performance.js';

console.log('=== CELLUCID STARTING ===');

ThemeManager.init();

const FAST_BINARY_FETCH_INIT = { cache: 'force-cache' };

// ============================================================================
// Onboarding & UX (Welcome Modal, Error Modal, Keyboard Shortcuts)
// ============================================================================

let welcomeModal = null;
let welcomeCallbacks = { onExplore: null };
let shortcutsCallbacks = {
  onResetCamera: null,
  onToggleFullscreen: null,
  onToggleSidebar: null,
  onSetDimension: null,
  onShowHelp: null,
  onClearHighlights: null,
  onSetNavigationMode: null
};

// Quotes for the welcome modal
const welcomeQuotes = [
  {
    text: "It's a dangerous business, Frodo, going out your door. You step onto the road, and if you don't keep your feet, there's no knowing where you might be swept off to.",
    author: "J.R.R. Tolkien",
    book: "The Fellowship of the Ring"
  },
  {
    text: "There is nothing like looking, if you want to find something. You certainly usually find something, if you look, but it is not always quite the something you were after.",
    author: "J.R.R. Tolkien",
    book: "The Hobbit"
  },
  {
    text: "The world is indeed full of peril, and in it there are many dark places; but still there is much that is fair, and though in all lands love is now mingled with grief, it grows perhaps the greater.",
    author: "J.R.R. Tolkien",
    book: "The Fellowship of the Ring"
  },
  {
    text: "I wish it need not have happened in my time, said Frodo. So do I, said Gandalf, and so do all who live to see such times. But that is not for them to decide. All we have to decide is what to do with the time that is given us.",
    author: "J.R.R. Tolkien",
    book: "The Fellowship of the Ring"
  },
  {
    text: "The Road goes ever on and on, down from the door where it began. Now far ahead the Road has gone, and I must follow, if I can.",
    author: "J.R.R. Tolkien",
    book: "The Fellowship of the Ring"
  },
  {
    text: "Home is behind, the world ahead, and there are many paths to tread through shadows to the edge of night, until the stars are all alight.",
    author: "J.R.R. Tolkien",
    book: "The Fellowship of the Ring"
  },
  {
    text: "Still round the corner there may wait, a new road or a secret gate; and though I oft have passed them by, a day will come at last when I shall take the hidden paths that run west of the Moon, east of the Sun.",
    author: "J.R.R. Tolkien",
    book: "The Return of the King"
  }
];

function setRandomQuote() {
  const quoteEl = welcomeModal?.querySelector('.welcome-quote-text');
  const authorEl = welcomeModal?.querySelector('.welcome-quote-author');
  const bookEl = welcomeModal?.querySelector('.welcome-quote-book');
  if (!quoteEl) return;

  // Avoid showing the same quote twice in a row
  let lastIndex = -1;
  try {
    lastIndex = parseInt(localStorage.getItem('cellucid_last_quote_index') || '-1', 10);
  } catch (_) { /* localStorage unavailable */ }

  let newIndex;
  do {
    newIndex = Math.floor(Math.random() * welcomeQuotes.length);
  } while (newIndex === lastIndex && welcomeQuotes.length > 1);

  try {
    localStorage.setItem('cellucid_last_quote_index', String(newIndex));
  } catch (_) { /* localStorage unavailable */ }

  const quote = welcomeQuotes[newIndex];
  quoteEl.textContent = `"${quote.text}"`;
  if (authorEl) authorEl.textContent = quote.author;
  if (bookEl) bookEl.textContent = quote.book;
}

function initWelcomeModal(callbacks = {}) {
  welcomeModal = document.getElementById('welcome-modal');
  if (!welcomeModal) return;
  welcomeCallbacks = { ...welcomeCallbacks, ...callbacks };
  const exploreBtn = document.getElementById('welcome-demo-btn');
  const backdrop = welcomeModal.querySelector('.welcome-backdrop');
  if (exploreBtn) {
    exploreBtn.addEventListener('click', () => {
      hideWelcomeModal();
      if (welcomeCallbacks.onExplore) welcomeCallbacks.onExplore();
    });
  }
  if (backdrop) {
    backdrop.addEventListener('click', () => hideWelcomeModal());
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && welcomeModal && !welcomeModal.classList.contains('hidden')) {
      hideWelcomeModal();
    }
  });
  setRandomQuote();
}

function showWelcomeModal() {
  if (!welcomeModal) return false;
  welcomeModal.classList.remove('hidden');
  return true;
}

function hideWelcomeModal() {
  if (welcomeModal) welcomeModal.classList.add('hidden');
}

function shouldShowWelcome() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('remote') || params.get('github') || params.get('dataset') || params.get('jupyter')) {
    return false;
  }
  return true;
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(err => {
      console.warn('Fullscreen request failed:', err);
    });
  } else {
    document.exitFullscreen();
  }
}

function showShortcutsHelp() {
  const shortcutsSection = document.getElementById('shortcuts-section');
  if (shortcutsSection) {
    shortcutsSection.open = true;
    shortcutsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function handleGlobalKeyDown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
    return;
  }
  const welcomeVisible = welcomeModal && !welcomeModal.classList.contains('hidden');
  if (welcomeVisible && e.key !== 'Escape') {
    return;
  }
  const key = e.key.toLowerCase();
  switch (key) {
    case 'f':
      e.preventDefault();
      if (shortcutsCallbacks.onToggleFullscreen) {
        shortcutsCallbacks.onToggleFullscreen();
      } else {
        toggleFullscreen();
      }
      break;
    case 'h':
      e.preventDefault();
      if (shortcutsCallbacks.onToggleSidebar) shortcutsCallbacks.onToggleSidebar();
      break;
    case '1':
      e.preventDefault();
      if (shortcutsCallbacks.onSetDimension) shortcutsCallbacks.onSetDimension(1);
      break;
    case '2':
      e.preventDefault();
      if (shortcutsCallbacks.onSetDimension) shortcutsCallbacks.onSetDimension(2);
      break;
    case '3':
      e.preventDefault();
      if (shortcutsCallbacks.onSetDimension) shortcutsCallbacks.onSetDimension(3);
      break;
    case '?':
      e.preventDefault();
      if (shortcutsCallbacks.onShowHelp) {
        shortcutsCallbacks.onShowHelp();
      } else {
        showShortcutsHelp();
      }
      break;
    case 'x':
      e.preventDefault();
      if (shortcutsCallbacks.onClearHighlights) shortcutsCallbacks.onClearHighlights();
      break;
    case 'o':
      e.preventDefault();
      if (shortcutsCallbacks.onSetNavigationMode) shortcutsCallbacks.onSetNavigationMode('orbit');
      break;
    case 'p':
      e.preventDefault();
      if (shortcutsCallbacks.onSetNavigationMode) shortcutsCallbacks.onSetNavigationMode('planar');
      break;
    case 'g':
      e.preventDefault();
      if (shortcutsCallbacks.onSetNavigationMode) shortcutsCallbacks.onSetNavigationMode('free');
      break;
  }
}

function initKeyboardShortcuts(callbacks = {}) {
  shortcutsCallbacks = { ...shortcutsCallbacks, ...callbacks };
  document.addEventListener('keydown', handleGlobalKeyDown);
}

function initOnboarding(config = {}) {
  const { welcomeCallbacks = {}, shortcutCallbacks = {} } = config;
  initWelcomeModal(welcomeCallbacks);
  initKeyboardShortcuts(shortcutCallbacks);
}

// Default export base URL (will be updated by DataSourceManager)
let EXPORT_BASE_URL = 'assets/exports/';

// Helper to get URLs based on current dataset
function getObsManifestUrl() { return `${EXPORT_BASE_URL}obs_manifest.json`; }
function getVarManifestUrl() { return `${EXPORT_BASE_URL}var_manifest.json`; }
function getConnectivityManifestUrl() { return `${EXPORT_BASE_URL}connectivity_manifest.json`; }
function getDatasetIdentityUrl() { return `${EXPORT_BASE_URL}dataset_identity.json`; }

(async function bootstrap() {
  const canvas = document.getElementById('glcanvas');
  const labelLayer = document.getElementById('label-layer');
  const viewTitleLayer = document.getElementById('view-title-layer');
  const statsEl = document.getElementById('stats');
  const categoricalFieldSelect = document.getElementById('categorical-field');
  const categoricalFieldCopyBtn = document.getElementById('copy-categorical-field');
  const categoricalFieldRenameBtn = document.getElementById('rename-categorical-field');
  const categoricalFieldDeleteBtn = document.getElementById('delete-categorical-field');
  const categoricalFieldClearBtn = document.getElementById('clear-categorical-field');
  const continuousFieldSelect = document.getElementById('continuous-field');
  const continuousFieldCopyBtn = document.getElementById('copy-continuous-field');
  const continuousFieldRenameBtn = document.getElementById('rename-continuous-field');
  const continuousFieldDeleteBtn = document.getElementById('delete-continuous-field');
  const continuousFieldClearBtn = document.getElementById('clear-continuous-field');
  const legendEl = document.getElementById('legend');
  const pointSizeInput = document.getElementById('point-size');
  const pointSizeDisplay = document.getElementById('point-size-display');
  const themeSelect = document.getElementById('theme-select');
  const backgroundSelect = document.getElementById('background-select');
  const pointsControls = document.getElementById('points-controls');
  const centroidControls = document.getElementById('centroid-controls');
  const centroidPointsCheckbox = document.getElementById('toggle-centroid-points');
  const centroidLabelsCheckbox = document.getElementById('toggle-centroid-labels');
  const sidebar = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebar-toggle');

  setDockableAccordions(initDockableAccordions({ sidebar }));

  if (themeSelect instanceof HTMLSelectElement) {
    themeSelect.value = ThemeManager.getTheme();
    themeSelect.addEventListener('change', () => {
      ThemeManager.setTheme(themeSelect.value);
    });
  }

  // Show welcome modal immediately for first-time visitors (before heavy initialization)
  // This ensures the modal appears first, not after everything else loads
  initWelcomeModal();
  if (shouldShowWelcome()) {
    showWelcomeModal();
  }

  const displayOptionsContainer = document.getElementById('display-options-container');
  const outlierFilterContainer = document.getElementById('outlier-filter-container');
  const outlierFilterInput = document.getElementById('outlier-filter');
  const outlierFilterDisplay = document.getElementById('outlier-filter-display');
  const filterCountEl = document.getElementById('filter-count');
  const activeFiltersEl = document.getElementById('active-filters');
  const deletedFieldsSection = document.getElementById('deleted-fields-section');
  // Highlight UI elements
  const highlightCountEl = document.getElementById('highlight-count');
  const highlightedGroupsEl = document.getElementById('highlighted-groups-list');
  const clearAllHighlightsBtn = document.getElementById('clear-all-highlights');
  const highlightPagesTabsEl = document.getElementById('highlight-pages-tabs');
  const addHighlightPageBtn = document.getElementById('add-highlight-page');
  const highlightModeButtons = Array.from(document.querySelectorAll('.highlight-mode-btn'));
  const highlightModeDescription = document.getElementById('highlight-mode-description');
  const lightingStrengthInput = document.getElementById('lighting-strength');
  const lightingStrengthDisplay = document.getElementById('lighting-strength-display');
  const fogDensityInput = document.getElementById('fog-density');
  const fogDensityDisplay = document.getElementById('fog-density-display');
  const sizeAttenuationInput = document.getElementById('size-attenuation');
  const sizeAttenuationDisplay = document.getElementById('size-attenuation-display');
  const resetCameraBtn = document.getElementById('reset-camera-btn');
  const navigationModeSelect = document.getElementById('navigation-mode');
  const lookSensitivityInput = document.getElementById('look-sensitivity');
  const lookSensitivityDisplay = document.getElementById('look-sensitivity-display');
  const moveSpeedInput = document.getElementById('move-speed');
  const moveSpeedDisplay = document.getElementById('move-speed-display');
  const invertLookCheckbox = document.getElementById('invert-look');
  const projectilesEnabledCheckbox = document.getElementById('projectiles-enabled');
  const pointerLockCheckbox = document.getElementById('pointer-lock');
  const orbitReverseCheckbox = document.getElementById('orbit-reverse');
  const showOrbitAnchorCheckbox = document.getElementById('show-orbit-anchor');
  const freeflyControls = document.getElementById('freefly-controls');
  const orbitControls = document.getElementById('orbit-controls');
  const planarControls = document.getElementById('planar-controls');
  const planarZoomToCursorCheckbox = document.getElementById('planar-zoom-to-cursor');
  const planarInvertAxesCheckbox = document.getElementById('planar-invert-axes');
  // Keyboard navigation speed sliders
  const orbitKeySpeedInput = document.getElementById('orbit-key-speed');
  const orbitKeySpeedDisplay = document.getElementById('orbit-key-speed-display');
  const planarPanSpeedInput = document.getElementById('planar-pan-speed');
  const planarPanSpeedDisplay = document.getElementById('planar-pan-speed-display');
  const geneExpressionContainer = document.getElementById('gene-expression-container');
  const geneExpressionSearch = document.getElementById('gene-expression-search');
  const geneExpressionDropdown = document.getElementById('gene-expression-dropdown');
  const geneExpressionCopyBtn = document.getElementById('copy-gene-expression');
  const geneExpressionRenameBtn = document.getElementById('rename-gene-expression');
  const geneExpressionDeleteBtn = document.getElementById('delete-gene-expression');
  const geneExpressionClearBtn = document.getElementById('clear-gene-expression');
  const categoryBuilderContainer = document.getElementById('category-builder-container');

  // New smoke controls
  const renderModeSelect = document.getElementById('render-mode');
  const smokeControls = document.getElementById('smoke-controls');
  const smokeGridInput = document.getElementById('smoke-grid');
  const smokeGridDisplay = document.getElementById('smoke-grid-display');
  const smokeStepsInput = document.getElementById('smoke-steps');
  const smokeStepsDisplay = document.getElementById('smoke-steps-display');
  const smokeDensityInput = document.getElementById('smoke-density');
  const smokeDensityDisplay = document.getElementById('smoke-density-display');
  const smokeSpeedInput = document.getElementById('smoke-speed');
  const smokeSpeedDisplay = document.getElementById('smoke-speed-display');
  const smokeDetailInput = document.getElementById('smoke-detail');
  const smokeDetailDisplay = document.getElementById('smoke-detail-display');
  const smokeWarpInput = document.getElementById('smoke-warp');
  const smokeWarpDisplay = document.getElementById('smoke-warp-display');
  const smokeAbsorptionInput = document.getElementById('smoke-absorption');
  const smokeAbsorptionDisplay = document.getElementById('smoke-absorption-display');
  const smokeScatterInput = document.getElementById('smoke-scatter');
  const smokeScatterDisplay = document.getElementById('smoke-scatter-display');
  const smokeEdgeInput = document.getElementById('smoke-edge');
  const smokeEdgeDisplay = document.getElementById('smoke-edge-display');
  const smokeDirectLightInput = document.getElementById('smoke-direct-light');
  const smokeDirectLightDisplay = document.getElementById('smoke-direct-light-display');
  const cloudResolutionInput = document.getElementById('cloud-resolution');
  const cloudResolutionDisplay = document.getElementById('cloud-resolution-display');
  const noiseResolutionInput = document.getElementById('noise-resolution');
  const noiseResolutionDisplay = document.getElementById('noise-resolution-display');

  // Split-view controls (small multiples)
  const splitViewControls = document.getElementById('split-view-controls');
  const splitKeepViewBtn = document.getElementById('split-keep-view-btn');
  const splitClearBtn = document.getElementById('split-clear-btn');
  const cameraLockBtn = document.getElementById('camera-lock-btn');
  const viewLayoutModeSelect = document.getElementById('view-layout-mode');
  const splitViewBadgesBox = document.getElementById('split-view-badges-box');
  const splitViewBadges = document.getElementById('split-view-badges-list');
  const splitViewBoxTitle = document.querySelector('.split-view-box-title');

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

  // Session save/load controls
  const saveStateBtn = document.getElementById('save-state-btn');
  const loadStateBtn = document.getElementById('load-state-btn');

  // Dataset selector controls
  const datasetSelect = document.getElementById('dataset-select');
  const datasetInfo = document.getElementById('dataset-info');
  const datasetNameEl = document.getElementById('dataset-name');
  const datasetSourceEl = document.getElementById('dataset-source');
  const datasetDescriptionEl = document.getElementById('dataset-description');
  const datasetUrlEl = document.getElementById('dataset-url');
  const datasetCellsEl = document.getElementById('dataset-cells');
  const datasetGenesEl = document.getElementById('dataset-genes');
  const datasetObsEl = document.getElementById('dataset-obs');
  const datasetConnectivityEl = document.getElementById('dataset-connectivity');
  const userDataBlock = document.getElementById('user-data-block');
  // Three separate buttons for local data loading
  const userDataH5adBtn = document.getElementById('user-data-h5ad-btn');
  const userDataZarrBtn = document.getElementById('user-data-zarr-btn');
  const userDataBrowseBtn = document.getElementById('user-data-browse-btn');
  // Hidden file inputs
  const userDataFileInput = document.getElementById('user-data-file-input');
  const userDataH5adInput = document.getElementById('user-data-h5ad-input');
  const userDataZarrInput = document.getElementById('user-data-zarr-input');
  const userDataInfoBtn = document.getElementById('user-data-info-btn');
  const userDataInfoTooltip = document.getElementById('user-data-info-tooltip');
  // Remote server connection elements
  const remoteServerUrl = document.getElementById('remote-server-url');
  const remoteConnectBtn = document.getElementById('remote-connect-btn');
  const remoteDisconnectBtn = document.getElementById('remote-disconnect-btn');
  const remoteDisconnectContainer = document.getElementById('remote-disconnect-container');
  const remoteInfoBtn = document.getElementById('remote-info-btn');
  const remoteInfoTooltip = document.getElementById('remote-info-tooltip');
  // GitHub repository elements
  const githubRepoUrl = document.getElementById('github-repo-url');
  const githubConnectBtn = document.getElementById('github-connect-btn');
  const githubDisconnectBtn = document.getElementById('github-disconnect-btn');
  const githubDisconnectContainer = document.getElementById('github-disconnect-container');
  const githubInfoBtn = document.getElementById('github-info-btn');
  const githubInfoTooltip = document.getElementById('github-info-tooltip');
  let ui = null;

  try {
    console.log('[Main] Creating viewer...');
    const viewer = createViewer({ canvas, labelLayer, viewTitleLayer, sidebar });
    console.log('[Main] Viewer created successfully');

    // Expose viewer globally for dev tools (benchmark, debugging)
    window._cellucidViewer = viewer;

    const state = createDataState({ viewer, labelLayer });
    console.log('[Main] State created successfully');

    // Expose state globally for dev tools
    window._cellucidState = state;
    // benchmarkReporter will be created lazily when benchmark report is requested
    let benchmarkReporter = null;

    // Initialize notification center early
    const notifications = getNotificationCenter();
    notifications.init();

    // Initialize DataSourceManager
    const dataSourceManager = getDataSourceManager();
    initAnalytics({ dataSourceManager });

    const buildDatasetAnalyticsContext = (overrides = {}) => {
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

    let currentDatasetLoadToken = null;

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

    // Always register user directory source (works in all browsers via file input fallback)
    const userSource = createLocalUserDirDataSource();
    dataSourceManager.registerSource('local-user', userSource);

    // Register remote server source
    const remoteSource = createRemoteDataSource();
    dataSourceManager.registerSource('remote', remoteSource);

    // Check if running in Jupyter context
    let jupyterSource = null;
    if (isJupyterContext()) {
      console.log('[Main] Detected Jupyter context, initializing bridge...');
      jupyterSource = createJupyterBridgeDataSource();
      dataSourceManager.registerSource('jupyter', jupyterSource);

      // Try to initialize Jupyter connection
      const jupyterInitialized = await jupyterSource.initialize();
      if (jupyterInitialized) {
        console.log('[Main] Jupyter bridge initialized successfully');

        // Auto-load first Jupyter dataset
        try {
          const jupyterDatasets = await jupyterSource.listDatasets();
          if (jupyterDatasets.length > 0) {
            await dataSourceManager.switchToDataset('jupyter', jupyterDatasets[0].id, {
              loadMethod: DATA_LOAD_METHODS.JUPYTER_AUTO
            });
            console.log(`[Main] Switched to Jupyter dataset: ${jupyterDatasets[0].id}`);
          }
        } catch (err) {
          console.warn('[Main] Failed to load Jupyter datasets:', err.message);
        }
      }
    }

    // Check for remote server URL in query parameters
    const remoteUrlParam = urlParams.get('remote');
    const isAnndataMode = urlParams.get('anndata') === 'true';

    if (remoteUrlParam) {
      console.log(`[Main] Remote server URL from param: ${remoteUrlParam}`);
      try {
        await remoteSource.connect({ url: remoteUrlParam });
        console.log('[Main] Connected to remote server');

        // Show AnnData warning if loading directly from AnnData
        if (isAnndataMode) {
          console.log('[Main] AnnData mode detected - loading directly from AnnData');
          notifications.warning(
            'Loading data directly from AnnData. This may be slower than using pre-exported data. ' +
            'For better performance, use prepare() to create optimized binary files.',
            { duration: 12000 } // 12 seconds to give users time to read
          );
        }

        // If connected successfully, try to use remote source as primary
        if (remoteSource.isConnected()) {
          const datasets = await remoteSource.listDatasets();
          if (datasets.length > 0) {
            // Switch to the first remote dataset
            await dataSourceManager.switchToDataset('remote', datasets[0].id, {
              loadMethod: DATA_LOAD_METHODS.REMOTE_URL_PARAM
            });
            console.log(`[Main] Switched to remote dataset: ${datasets[0].id}`);
          }
        }
      } catch (err) {
        console.warn('[Main] Failed to connect to remote server:', err.message);
      }
    }

    // Initialize with default sources (registers local-demo and github-repo sources)
    await dataSourceManager.initialize();

    // Check for GitHub repository path in query parameters
    // Must be after initialize() since github-repo source is registered there
    const githubPathParam = urlParams.get('github');
    if (githubPathParam && !remoteUrlParam) {
      console.log(`[Main] GitHub path from param: ${githubPathParam}`);
      try {
          const githubSource = dataSourceManager.getSource('github-repo');
          if (githubSource) {
            const { datasets } = await githubSource.connect(githubPathParam);
            console.log('[Main] Connected to GitHub repository');

            if (datasets && datasets.length > 0) {
              await dataSourceManager.switchToDataset('github-repo', datasets[0].id, {
                loadMethod: DATA_LOAD_METHODS.GITHUB_URL_PARAM
              });
              console.log(`[Main] Switched to GitHub dataset: ${datasets[0].id}`);

              // Fill in the input field for visual feedback
              if (githubRepoUrl) {
                githubRepoUrl.value = githubPathParam;
            }
          }
        }
      } catch (err) {
        console.warn('[Main] Failed to connect to GitHub:', err.message);
        notifications.error(`Failed to load GitHub data: ${err.message}`, { category: 'connectivity' });
      }
    }

    // Check URL parameters for dataset selection
    // Only process if we haven't already connected via remote/jupyter/github
    const requestedDataset = urlParams.get('dataset');
    const requestedSource = urlParams.get('source') || 'local-demo';
    const currentSourceType = dataSourceManager.getCurrentSourceType();
    const skipUrlDataset = currentSourceType === 'remote' || currentSourceType === 'jupyter' || currentSourceType === 'github-repo';

    if (requestedDataset && !skipUrlDataset) {
      // Try to switch to the requested dataset from the requested source
      try {
        const targetSource = dataSourceManager.getSource(requestedSource);
        if (targetSource) {
          // Check if dataset exists (hasDataset is optional, so handle if not available)
          const hasDataset = typeof targetSource.hasDataset === 'function'
            ? await targetSource.hasDataset(requestedDataset)
            : true; // Assume exists if hasDataset not available

          if (hasDataset) {
            await dataSourceManager.switchToDataset(requestedSource, requestedDataset, {
              loadMethod: DATA_LOAD_METHODS.DATASET_URL_PARAM
            });
            console.log(`[Main] Loaded dataset from URL param: ${requestedSource}/${requestedDataset}`);
          } else {
            console.warn(`[Main] Requested dataset '${requestedDataset}' not found in '${requestedSource}'`);
          }
        } else {
          console.warn(`[Main] Requested source '${requestedSource}' not registered`);
        }
      } catch (err) {
        console.warn(`[Main] Failed to load requested dataset '${requestedDataset}':`, err);
      }
    }

    EXPORT_BASE_URL = dataSourceManager.getCurrentBaseUrl() || EXPORT_BASE_URL;
    console.log(`[Main] Using dataset base URL: ${EXPORT_BASE_URL}`);

    if (!currentDatasetLoadToken && dataSourceManager.hasActiveDataset?.()) {
      currentDatasetLoadToken = startDatasetLoad();
    }

    // Initialize dimension manager for multi-dimensional embeddings
    const dimensionManager = createDimensionManager({ baseUrl: EXPORT_BASE_URL });

    // Development phase: require obs_manifest.json (no legacy obs_values.json fallback).
    async function loadObsManifestStrict() {
      try {
        const manifest = await loadObsManifest(getObsManifestUrl());
        state.setFieldLoader(createObsFieldLoader(getObsManifestUrl(), { fetchInit: FAST_BINARY_FETCH_INIT }));
        return manifest;
      } catch (err) {
        if (err?.status === 404) {
          console.warn('obs_manifest.json not found, using empty obs');
          return { fields: [], count: 0 };
        }
        throw err;
      }
    }

    // Start ALL manifest loads in parallel for faster initialization
    const identityPromise = loadDatasetIdentity(getDatasetIdentityUrl()).catch(err => {
      if (err?.status === 404) {
        console.log('[Main] dataset_identity.json not found, using default 3D embeddings');
        return null;
      }
      console.warn('[Main] Error loading dataset identity:', err);
      return null;
    });

    const obsPromise = loadObsManifestStrict();

    const varPromise = loadVarManifest(getVarManifestUrl()).catch(err => {
      if (err?.status === 404) {
        console.log('var_manifest.json not found, gene expression not available.');
      } else {
        console.warn('Error loading var manifest:', err);
      }
      return null;
    });

    const connPromise = loadConnectivityManifest(getConnectivityManifestUrl()).catch(err => {
      if (err?.status === 404) {
        console.log('connectivity_manifest.json not found, connectivity not available.');
      } else {
        console.warn('Error loading connectivity manifest:', err);
      }
      return null;
    });

    // Wait for identity first (needed to determine which positions file to load)
    let datasetIdentity = await identityPromise;
    if (datasetIdentity) {
      const embeddingsMetadata = getEmbeddingsMetadata(datasetIdentity);
      dimensionManager.initFromMetadata(embeddingsMetadata);
      console.log(`[Main] Loaded dataset identity v${datasetIdentity.version || 1}`);
    } else {
      dimensionManager.initFromMetadata({
        available_dimensions: [3],
        default_dimension: 3,
        files: { '3d': 'points_3d.bin' }
      });
    }

    // Set dimension manager on state
    state.setDimensionManager(dimensionManager);

    // Start positions loading NOW (other manifests still loading in parallel)
    const defaultDim = dimensionManager.getDefaultDimension();
    const positionsPromise = dimensionManager.getPositions3D(defaultDim);

    // Wait for remaining manifests (already loading in parallel)
    // Note: connectivityManifest needs to be `let` because reloadActiveDatasetInPlace() reassigns it
    const [obs, varManifest, connManifestResult] = await Promise.all([
      obsPromise, varPromise, connPromise
    ]);
    let connectivityManifest = connManifestResult;

    // Set up var data if loaded
    if (varManifest) {
      state.setVarFieldLoader(createVarFieldLoader(getVarManifestUrl(), { fetchInit: FAST_BINARY_FETCH_INIT }));
      state.initVarData(varManifest);
      console.log(`Loaded var manifest with ${varManifest?.fields?.length || 0} genes.`);
    }

    // Log connectivity if loaded
    if (connectivityManifest) {
      console.log(`Loaded connectivity manifest with ${connectivityManifest?.n_edges?.toLocaleString() || 0} edges.`);
    }

    // In-place dataset reload for sources that cannot survive a page refresh (e.g., local-user)
    async function reloadActiveDatasetInPlace(metadataOverride = null, loadMethodOverride = null) {
      const baseUrl = dataSourceManager.getCurrentBaseUrl();
      const activeMetadata = metadataOverride || dataSourceManager.getCurrentMetadata?.() || null;
      if (!baseUrl) {
        ui?.showSessionStatus?.('No dataset selected', true);
        return;
      }

      EXPORT_BASE_URL = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

      // Indicate loading in dataset info block
      if (datasetInfo) {
        datasetInfo.classList.remove('error');
        datasetInfo.classList.add('loading');
      }
      if (datasetCellsEl) datasetCellsEl.textContent = '...';
      if (datasetGenesEl) datasetGenesEl.textContent = '...';

      // Disable connectivity visuals when switching datasets without reload
      if (connectivityCheckbox) {
        connectivityCheckbox.checked = false;
        connectivityCheckbox.disabled = true;
      }
      if (connectivityControls) {
        connectivityControls.style.display = 'none';
      }
      if (connectivitySliders) {
        connectivitySliders.style.display = 'none';
      }
      if (viewer.setShowConnectivity) viewer.setShowConnectivity(false);
      if (viewer.disableEdgesV2) viewer.disableEdgesV2();
      connectivityManifest = null;

      const loadToken = startDatasetLoad(loadMethodOverride, { metadata: activeMetadata, reload: true });

      try {
        // Reinitialize dimension manager with new dataset's embeddings metadata
        dimensionManager.clearCache();
        dimensionManager.setBaseUrl(EXPORT_BASE_URL);

        // Start ALL manifest loads in parallel for faster reload
        const reloadIdentityPromise = loadDatasetIdentity(getDatasetIdentityUrl()).catch(err => {
          if (err?.status === 404) {
            console.log('[Main] dataset_identity.json not found for reloaded dataset, using default 3D embeddings');
          } else {
            console.warn('[Main] Error loading dataset identity for reloaded dataset:', err);
          }
          return null;
        });

        const reloadObsPromise = loadObsManifestStrict();

        const reloadVarPromise = loadVarManifest(getVarManifestUrl()).catch(err => {
          if (err?.status === 404) {
            console.log('[Main] var_manifest.json not found for reloaded dataset (gene expression disabled).');
          } else {
            console.warn('[Main] Error loading var manifest for reloaded dataset:', err);
          }
          return null;
        });

        const reloadConnPromise = loadConnectivityManifest(getConnectivityManifestUrl()).catch(err => {
          console.log('[Main] Connectivity not available for reloaded dataset:', err?.message || err);
          return null;
        });

        // Wait for identity first (needed to determine positions file)
        const newDatasetIdentity = await reloadIdentityPromise;
        if (newDatasetIdentity) {
          const newEmbeddingsMetadata = getEmbeddingsMetadata(newDatasetIdentity);
          dimensionManager.initFromMetadata(newEmbeddingsMetadata);
          console.log(`[Main] Reloaded dataset identity v${newDatasetIdentity.version || 1}`);
        } else {
          dimensionManager.initFromMetadata({
            available_dimensions: [3],
            default_dimension: 3,
            files: { '3d': 'points_3d.bin' }
          });
        }

        // Start positions loading NOW (other manifests still loading in parallel)
        const newDefaultDim = dimensionManager.getDefaultDimension();
        const positionsPromiseReload = dimensionManager.getPositions3D(newDefaultDim);

        // Wait for remaining manifests (already loading in parallel)
        const [nextObs, nextVarManifest, newConnManifest] = await Promise.all([
          reloadObsPromise, reloadVarPromise, reloadConnPromise
        ]);

        // Set up var data if loaded
        if (nextVarManifest) {
          state.setVarFieldLoader(createVarFieldLoader(getVarManifestUrl(), { fetchInit: FAST_BINARY_FETCH_INIT }));
          state.initVarData(nextVarManifest);
          console.log(`[Main] Reloaded var manifest with ${nextVarManifest?.fields?.length || 0} genes.`);
        } else {
          state.setVarFieldLoader?.(null);
          state.varData = null;
        }

        // Handle connectivity manifest
        if (newConnManifest && hasEdgeFormat(newConnManifest)) {
          connectivityManifest = newConnManifest;
          console.log(`[Main] Loaded connectivity manifest for reloaded dataset: ${newConnManifest.n_edges?.toLocaleString()} edges`);

          // Show connectivity controls
          if (connectivityControls) {
            connectivityControls.style.display = 'block';
          }
          // Reset edge state so checkbox handler reloads edges
          if (viewer.disableEdgesV2) viewer.disableEdgesV2();
          if (typeof window.__resetConnectivityState === 'function') {
            window.__resetConnectivityState();
          }
        } else {
          connectivityManifest = null;
          if (connectivityControls) {
            connectivityControls.style.display = 'none';
          }
        }

        const nextPositions = await positionsPromiseReload;

        state.initScene(nextPositions, nextObs);
        if (state.clearActiveField) {
          state.clearActiveField();
        }
        if (state.clearAllHighlights) {
          state.clearAllHighlights();
        }

        // Reset dimension level to the new dataset's default
        dimensionManager.clearViewDimensions();
        if (state.resetDimensionLevel) {
          state.resetDimensionLevel(newDefaultDim);
        }

        // Refresh dataset-aware UI controls (field dropdowns, gene search, stats, dimension slider)
        ui?.refreshDatasetUI?.(activeMetadata || null);
        await ui?.activateField?.(-1);

        if (activeMetadata?.stats) {
          if (datasetCellsEl && activeMetadata.stats.n_cells != null) {
            datasetCellsEl.textContent = formatNumber(activeMetadata.stats.n_cells);
          }
          if (datasetGenesEl && activeMetadata.stats.n_genes != null) {
            datasetGenesEl.textContent = formatNumber(activeMetadata.stats.n_genes);
          }
        }
        if (datasetInfo) {
          datasetInfo.classList.remove('loading', 'error');
        }
        ui?.showSessionStatus?.('Dataset loaded', false);
        completeDataLoadSuccess(loadToken, buildDatasetAnalyticsContext({
          metadata: activeMetadata,
          datasetId: dataSourceManager.getCurrentDatasetId?.(),
          datasetName: activeMetadata?.name,
          reload: true
        }));
      } catch (err) {
        console.error('[Main] Failed to reload dataset in-place:', err);
        statsEl.textContent = 'Failed to load dataset';
        notifications.error(`Failed to load dataset: ${err?.message || 'Unknown error'}`, { category: 'data' });
        if (datasetInfo) datasetInfo.classList.add('error');
        completeDataLoadFailure(loadToken, {
          ...buildDatasetAnalyticsContext({
            metadata: activeMetadata,
            datasetId: dataSourceManager.getCurrentDatasetId?.(),
            datasetName: activeMetadata?.name,
            reload: true
          }),
          error: err
        });
      } finally {
        if (connectivityCheckbox) {
          connectivityCheckbox.disabled = false;
        }
      }
    }

    const positions = await positionsPromise;

    state.initScene(positions, obs);
    // One-time helper to rebuild density from current visibility + grid
    function rebuildSmokeDensity(gridSizeOverride) {
      const gridSize = gridSizeOverride || 128;

      const visiblePositions = state.getVisiblePositionsForSmoke
        ? state.getVisiblePositionsForSmoke()
        : positions;

      console.log(`Building smoke volume at ${gridSize}^3 from ${visiblePositions.length / 3} visible points (GPU)…`);
      // Use GPU-accelerated splatting for dramatic speedup
      viewer.buildSmokeVolumeGPU(visiblePositions, {
        gridSize,
        gamma: 0.7
      });
    }

    // Smoke volume is built lazily when switching to smoke mode
    // (no initial build to save startup time)

    const stateSerializer = createStateSerializer({ state, viewer, sidebar });

    ui = initUI({
      state,
      viewer,
      dom: {
        statsEl,
        categoricalFieldSelect,
        categoricalFieldCopyBtn,
        categoricalFieldRenameBtn,
        categoricalFieldDeleteBtn,
        categoricalFieldClearBtn,
        continuousFieldSelect,
        continuousFieldCopyBtn,
        continuousFieldRenameBtn,
        continuousFieldDeleteBtn,
        continuousFieldClearBtn,
        legendEl,
        displayOptionsContainer,
        pointSizeInput,
        pointSizeDisplay,
        backgroundSelect,
        pointsControls,
        centroidControls,
        centroidPointsCheckbox,
        centroidLabelsCheckbox,
        sidebar,
        sidebarToggle,
        outlierFilterContainer,
        outlierFilterInput,
        outlierFilterDisplay,
        filterCountEl,
        activeFiltersEl,
        deletedFieldsSection,
        highlightCountEl,
        highlightedGroupsEl,
        clearAllHighlightsBtn,
        highlightPagesTabsEl,
        addHighlightPageBtn,
        highlightModeButtons,
        highlightModeDescription,
        lightingStrengthInput,
        lightingStrengthDisplay,
        fogDensityInput,
        fogDensityDisplay,
        sizeAttenuationInput,
        sizeAttenuationDisplay,
        resetCameraBtn,
        navigationModeSelect,
        lookSensitivityInput,
        lookSensitivityDisplay,
        moveSpeedInput,
        moveSpeedDisplay,
        invertLookCheckbox,
        projectilesEnabledCheckbox,
        pointerLockCheckbox,
        orbitReverseCheckbox,
        showOrbitAnchorCheckbox,
        freeflyControls,
        orbitControls,
        planarControls,
        planarZoomToCursorCheckbox,
        planarInvertAxesCheckbox,
        orbitKeySpeedInput,
        orbitKeySpeedDisplay,
        planarPanSpeedInput,
        planarPanSpeedDisplay,
        geneExpressionContainer,
        geneExpressionSearch,
        geneExpressionDropdown,
        geneExpressionCopyBtn,
        geneExpressionRenameBtn,
        geneExpressionDeleteBtn,
        geneExpressionClearBtn,
        categoryBuilderContainer,
        renderModeSelect,
        smokeControls,
        smokeGridInput,
        smokeGridDisplay,
        smokeStepsInput,
        smokeStepsDisplay,
        smokeDensityInput,
        smokeDensityDisplay,
        smokeSpeedInput,
        smokeSpeedDisplay,
        smokeDetailInput,
        smokeDetailDisplay,
        smokeWarpInput,
        smokeWarpDisplay,
        smokeAbsorptionInput,
        smokeAbsorptionDisplay,
        smokeScatterInput,
        smokeScatterDisplay,
        smokeEdgeInput,
        smokeEdgeDisplay,
        smokeDirectLightInput,
        smokeDirectLightDisplay,
        cloudResolutionInput,
        cloudResolutionDisplay,
        noiseResolutionInput,
        noiseResolutionDisplay,
        splitViewControls,
        splitKeepViewBtn,
        splitClearBtn,
        cameraLockBtn,
        viewLayoutModeSelect,
        splitViewBadgesBox,
        splitViewBadges,
        splitViewBoxTitle,
        // Dimension controls
        dimensionControls: document.getElementById('dimension-controls'),
        dimensionSelect: document.getElementById('dimension-select'),
        saveStateBtn,
        loadStateBtn,
        // Dataset selector
        datasetSelect,
        datasetInfo,
        datasetNameEl,
        datasetSourceEl,
        datasetDescriptionEl,
        datasetUrlEl,
        datasetCellsEl,
        datasetGenesEl,
        datasetObsEl,
        datasetConnectivityEl,
        userDataBlock,
        // Three separate buttons for local data loading
        userDataH5adBtn,
        userDataZarrBtn,
        userDataBrowseBtn,
        // Hidden file inputs
        userDataFileInput,
        userDataH5adInput,
        userDataZarrInput,
        userDataInfoBtn,
        userDataInfoTooltip,
        // Remote server
        remoteServerUrl,
        remoteConnectBtn,
        remoteDisconnectBtn,
        remoteDisconnectContainer,
        remoteInfoBtn,
        remoteInfoTooltip,
        // GitHub repository
        githubRepoUrl,
        githubConnectBtn,
        githubDisconnectBtn,
        githubDisconnectContainer,
        githubInfoBtn,
        githubInfoTooltip
      },
      smoke: {
        rebuildSmokeDensity
      },
      reloadActiveDataset: reloadActiveDatasetInPlace,
      stateSerializer: stateSerializer,
      dataSourceManager: dataSourceManager
    });

    // Initialize Page Analysis / Comparison Module
    const pageAnalysisSection = document.getElementById('page-analysis-section');
    if (pageAnalysisSection) {
      const comparisonModule = createComparisonModule({
        state,
        container: pageAnalysisSection
      });
      // Store reference for potential external access
      window._comparisonModule = comparisonModule;
    }

    await ui.activateField(-1);
    if (currentDatasetLoadToken) {
      completeDataLoadSuccess(currentDatasetLoadToken, buildDatasetAnalyticsContext());
      currentDatasetLoadToken = null;
    }

    // Discover state snapshots in the exports directory (for automatic restore)
    async function discoverLocalStateSnapshots(baseUrl) {
      const candidates = new Set();
      const stateRegex = /state[^/]*\.json$/i;

      // Check if baseUrl uses a custom protocol (remote://, local-user://, etc.)
      const isCustomProtocol = dataSourceManager.isCustomProtocolUrl(baseUrl);

      // For custom protocols, resolve to fetchable URL; for standard URLs, use as-is
      let fetchableBase = baseUrl;
      if (isCustomProtocol) {
        try {
          fetchableBase = await dataSourceManager.resolveUrl(baseUrl);
        } catch (err) {
          console.warn('[Main] Could not resolve custom protocol URL:', baseUrl, err);
          return []; // Can't discover state files without a fetchable URL
        }
      }

      let resolvedBase = null;
      try {
        resolvedBase = new URL(fetchableBase, window.location.href);
      } catch (_err) {
        resolvedBase = null;
      }

      const resolveCandidate = (path, overrideBase = null) => {
        try {
          const base = overrideBase || resolvedBase || window.location.href;
          return new URL(path, base).toString();
        } catch (_err) {
          return path;
        }
      };

      // Prefer an explicit manifest so we don't depend on directory listings (which are disabled on GitHub Pages)
      // Try the explicit manifest we ship with data; avoid probing non-existent alternates to keep consoles clean
      const manifestNames = ['state-snapshots.json'];
      let manifestFound = false;
      for (const manifestName of manifestNames) {
        const manifestUrl = resolveCandidate(manifestName);
        try {
          const res = await fetch(manifestUrl);
          if (!res.ok) continue;
          const payload = await res.json();
          const entries = Array.isArray(payload)
            ? payload
            : payload?.states || payload?.files || payload?.snapshots || [];
          if (!Array.isArray(entries)) continue;
          manifestFound = true;

          entries.forEach((entry) => {
            const entryPath = typeof entry === 'string'
              ? entry
              : entry?.url || entry?.path || entry?.href || entry?.name;
            if (!entryPath) return;
            const filename = entryPath.split('/').pop() || '';
            if (!stateRegex.test(filename)) return;
            candidates.add(resolveCandidate(entryPath, res.url));
          });
        } catch (err) {
          console.warn('[Main] Could not load state manifest:', manifestUrl, err);
        }
      }

      // If manifest provided entries, return them without probing missing defaults
      if (manifestFound && candidates.size > 0) {
        const sorted = Array.from(candidates).sort();
        const filtered = sorted.filter((url) => {
          const name = url.split('/').pop() || '';
          return !/state[-_]?snapshots\.json$/i.test(name) && !/state[-_]?manifest\.json$/i.test(name);
        });
        return filtered.length ? filtered : sorted;
      }

      try {
        const res = await fetch(fetchableBase);
        if (res.ok) {
          const text = await res.text();
          const linkRegex = /href="([^"]+)"/gi;
          let match;
          while ((match = linkRegex.exec(text)) !== null) {
            const rawHref = match[1];
            const cleanHref = rawHref.split('#')[0].split('?')[0];
            const filename = cleanHref.split('/').pop() || '';
            if (!stateRegex.test(filename)) continue;
            candidates.add(resolveCandidate(cleanHref, res.url));
          }
        }
      } catch (err) {
        console.warn('[Main] Could not inspect exports directory for state files:', err);
      }

      const fallbackNames = ['cellucid-state.json', 'state.json'];
      if (candidates.size === 0) {
        for (const name of fallbackNames) {
          const candidateUrl = resolveCandidate(name);
          if (candidates.has(candidateUrl)) continue;
          try {
            // Use GET directly - state files are small JSON, so payload is minimal
            // This avoids the HEAD+GET double request for servers that don't support HEAD
            const resp = await fetch(candidateUrl);
            if (resp.ok) {
              candidates.add(candidateUrl);
            }
          } catch (_err) {
            // Ignore missing files or network errors
          }
        }
      }

      // Prefer real snapshot files over manifest/metadata files when multiple matches exist
      const sorted = Array.from(candidates).sort();
      const filtered = sorted.filter((url) => {
        const name = url.split('/').pop() || '';
        return !/state[-_]?snapshots\.json$/i.test(name) && !/state[-_]?manifest\.json$/i.test(name);
      });
      return filtered.length ? filtered : sorted;
    }

    async function autoLoadLatestState() {
      const stateFiles = await discoverLocalStateSnapshots(EXPORT_BASE_URL);
      if (!stateFiles.length) return;
      const target = stateFiles[stateFiles.length - 1];
      console.log('[Main] Auto-loading state snapshot from', target);
      try {
        await stateSerializer.loadStateFromUrl(target, DATA_LOAD_METHODS.STATE_RESTORE_AUTO);
        ui.refreshUiAfterStateLoad?.();
        ui.showSessionStatus?.('Loaded saved state from data directory');
      } catch (err) {
        console.warn('[Main] Failed to auto-load state:', err);
        ui.showSessionStatus?.(err?.message || 'Failed to auto-load state', true);
      }
    }

    // Initial smoke mode setup
    if (renderModeSelect) {
      const mode = renderModeSelect.value || 'points';
      viewer.setRenderMode(mode === 'smoke' ? 'smoke' : 'points');
    }

    // Setup connectivity controls
    // NOTE: Handlers are ALWAYS set up so they work for datasets loaded dynamically (h5ad/zarr)
    // The handlers check if connectivityManifest is available before doing anything
    {
      // Show connectivity controls if data is available at bootstrap
      if (connectivityManifest && hasEdgeFormat(connectivityManifest) && connectivityControls) {
        connectivityControls.style.display = 'block';
      }

      // Use getter to always get current edge count (supports dynamic manifest updates)
      const getTotalEdges = () => connectivityManifest?.n_edges || 0;
      const EDGE_UI_CAP = 100000000;  // 100M edges max in UI

      // Store edge arrays for accurate visible edge counting
      let edgeSources = null;
      let edgeDestinations = null;

      // Cached visibility state for edge counting
      let cachedCombinedVisibility = null; // Combined: filter AND LOD visibility
      let lastLodLevel = -1;               // Track LOD level for change detection
      let actualVisibleEdges = getTotalEdges();

      // Reusable buffer for combined visibility (avoids GC pressure)
      let combinedVisibilityBuffer = null;

      // Prefix sum for accurate LOD limit calculation
      let visibleEdgePrefixSum = null;

      /**
       * Seeded random number generator (Mulberry32) for reproducible shuffles.
       * Using a fixed seed ensures the same shuffle every time for consistency.
       */
      function mulberry32(seed) {
        return function() {
          let t = seed += 0x6D2B79F5;
          t = Math.imul(t ^ t >>> 15, t | 1);
          t ^= t + Math.imul(t ^ t >>> 7, t | 61);
          return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
      }

      /**
       * Fisher-Yates shuffle for edge arrays (in-place, synchronized).
       * Uses seeded RNG for reproducibility across sessions.
       * This ensures "first N edges" is a truly random sample.
       */
      function shuffleEdges(sources, destinations) {
        const n = sources.length;
        const rng = mulberry32(42); // Fixed seed for reproducibility

        for (let i = n - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          // Swap sources
          const tmpSrc = sources[i];
          sources[i] = sources[j];
          sources[j] = tmpSrc;
          // Swap destinations (same permutation)
          const tmpDst = destinations[i];
          destinations[i] = destinations[j];
          destinations[j] = tmpDst;
        }
      }

      /**
       * Combine filter visibility with LOD visibility.
       * An edge is visible only if BOTH endpoints pass filters AND are visible at current LOD.
       *
       * Performance: Reuses buffer, returns filterVis directly when LOD is disabled/full detail.
       *
       * @param {string} [viewId] - Optional view ID for per-view visibility (snapshots).
       *   If not provided, uses global live view visibility.
       * @param {number} [dimensionLevel] - Optional dimension level for LOD calculation.
       * @returns {Float32Array|null} Combined visibility array
       */
      function getCombinedVisibility(viewId, dimensionLevel) {
        // Get filter visibility:
        // - For live view (no viewId): use state.getVisibilityArray()
        // - For snapshots: use snapshot's transparency if it has its own filters
        let filterVis;
        if (viewId && viewId !== 'live') {
          // Get snapshot's transparency as filter visibility
          const snapshot = viewer.getSnapshotViews?.()?.find(s => s.id === viewId);
          if (snapshot && !snapshot.sharesLiveTransparency && snapshot.transparency) {
            // Convert transparency to binary visibility (transparency > 0.01 = visible)
            filterVis = snapshot.transparency;
          } else {
            // Shares live transparency or no snapshot found
            filterVis = state.getVisibilityArray();
          }
        } else {
          filterVis = state.getVisibilityArray();
        }

        // Get LOD visibility for this specific view and dimension
        const lodVis = viewer.getLodVisibilityArray(viewId, dimensionLevel);

        if (!filterVis) return null;
        if (!lodVis) return filterVis; // No LOD active, just use filter visibility (no copy needed)

        const n = filterVis.length;

        // Reuse or create buffer
        if (!combinedVisibilityBuffer || combinedVisibilityBuffer.length !== n) {
          combinedVisibilityBuffer = new Float32Array(n);
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
        n = parseInt(n);
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
        if (!edgeSources || !edgeDestinations || !visibility) {
          visibleEdgePrefixSum = null;
          return { visibleCount: getTotalEdges() };
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
       * @param {Float32Array} visibility - Per-cell visibility (unused, prefix sum is pre-built)
       * @returns {number} - Exact LOD limit
       */
      function findLodLimitFast(targetVisible, visibility) {
        if (!edgeSources || !edgeDestinations) {
          return targetVisible;
        }
        if (targetVisible >= actualVisibleEdges) {
          return getTotalEdges();
        }
        if (actualVisibleEdges <= 0 || targetVisible <= 0) {
          return 0;
        }

        // Use prefix sum with binary search for exact LOD limit
        if (visibleEdgePrefixSum) {
          // Binary search: find smallest index i where prefixSum[i] >= targetVisible
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

        // Fallback: ratio-based approximation (should rarely happen)
        const ratio = targetVisible / actualVisibleEdges;
        return Math.min(getTotalEdges(), Math.round(getTotalEdges() * ratio * 1.05));
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
        const minVal = Math.max(100, Math.min(1000, Math.round(cappedMax * 0.01)));

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
        if (!cachedCombinedVisibility) {
          viewer.setEdgeLodLimit(currentEdgeLimit);
          updateConnectivityInfo(actualVisibleEdges, Math.min(currentEdgeLimit, actualVisibleEdges));
          return;
        }

        // Calculate LOD limit to show approximately currentEdgeLimit visible edges
        const targetVisible = Math.min(currentEdgeLimit, actualVisibleEdges);
        const lodLimit = findLodLimitFast(targetVisible, cachedCombinedVisibility);
        viewer.setEdgeLodLimit(lodLimit);
        updateConnectivityInfo(actualVisibleEdges, targetVisible);
      }

      // Initial slider setup and info display
      updateSliderRange(actualVisibleEdges);
      updateConnectivityInfo(actualVisibleEdges, Math.min(currentEdgeLimit, actualVisibleEdges));

      // Edge loading state
      let edgesLoaded = false;

      // Function to reset edge state (called when switching datasets)
      function resetEdgeState() {
        edgesLoaded = false;
        edgeSources = null;
        edgeDestinations = null;
        cachedCombinedVisibility = null;
        visibleEdgePrefixSum = null;
        combinedVisibilityBuffer = null;
        actualVisibleEdges = getTotalEdges();
        currentEdgeLimit = Math.min(250000, getTotalEdges());
        lastLodLevel = -1;

        if (connectivityCheckbox) {
          connectivityCheckbox.checked = false;
        }
        if (connectivitySliders) {
          connectivitySliders.style.display = 'none';
        }
        updateSliderRange(actualVisibleEdges);
        updateConnectivityInfo(actualVisibleEdges, Math.min(currentEdgeLimit, actualVisibleEdges));
      }

      // Expose reset function for use by reloadActiveDatasetInPlace
      window.__resetConnectivityState = resetEdgeState;

      if (connectivityCheckbox) {
        connectivityCheckbox.addEventListener('change', async () => {
          const show = connectivityCheckbox.checked;

          // Check if connectivity manifest is available
          if (!connectivityManifest || !hasEdgeFormat(connectivityManifest)) {
            console.warn('[Main] Connectivity checkbox toggled but no manifest available');
            connectivityCheckbox.checked = false;
            return;
          }

          // Load edge data on first toggle (or after manifest was reloaded)
          if (show && !edgesLoaded) {
            const connNotifId = notifications.loading('Loading connectivity data', { category: 'connectivity' });
            try {
              console.log('[Main] Loading GPU-optimized edges...');
              const edgeData = await loadEdges(getConnectivityManifestUrl(), connectivityManifest);

              // Shuffle edges for truly random sampling when using MAX EDGES slider
              // This ensures "first N edges" gives a representative random sample
              console.log('[Main] Shuffling edges for random sampling...');
              shuffleEdges(edgeData.sources, edgeData.destinations);

              // Store edge arrays for accurate visibility counting
              edgeSources = edgeData.sources;
              edgeDestinations = edgeData.destinations;

              // Set up instanced rendering with positions from state (uses shuffled edges)
              viewer.setupEdgesV2(edgeData, state.positionsArray);
              edgesLoaded = true;

              // Set up edge textures for any existing snapshots (in case edges loaded after snapshots)
              const existingSnapshots = viewer.getSnapshotViews?.() || [];
              for (const snapshot of existingSnapshots) {
                const positions = viewer.getViewPositions?.(snapshot.id) || state.positionsArray;
                if (positions && viewer.setupEdgesV2ForView) {
                  viewer.setupEdgesV2ForView(snapshot.id, positions, positions.length / 3);
                }
              }

              // Get combined visibility (filter + LOD) and count visible edges for all views
              cachedCombinedVisibility = getCombinedVisibility();
              if (cachedCombinedVisibility) {
                viewer.updateEdgeVisibilityV2(cachedCombinedVisibility);
                // Also update existing snapshots
                for (const snapshot of existingSnapshots) {
                  const snapshotVis = getCombinedVisibility(snapshot.id, snapshot.dimensionLevel);
                  if (snapshotVis && viewer.updateEdgeVisibilityV2ForView) {
                    viewer.updateEdgeVisibilityV2ForView(snapshot.id, snapshotVis);
                  }
                }
                const { visibleCount } = countVisibleEdges(cachedCombinedVisibility);
                actualVisibleEdges = visibleCount;
              }
              lastLodLevel = viewer.getCurrentLODLevel();

              // Update slider range and apply LOD
              updateSliderRange(actualVisibleEdges);
              applyEdgeLodLimit();

              console.log(`[Main] Edges loaded: ${edgeData.nEdges} edges, ${edgeData.nCells} cells, visible: ${actualVisibleEdges}`);

              // Also load edges into KNN adjacency list for KNN drag mode
              if (viewer.loadKnnEdges) {
                viewer.loadKnnEdges(edgeData.sources, edgeData.destinations);
              }

              notifications.complete(connNotifId, `Loaded ${edgeData.nEdges.toLocaleString()} edges`);

            } catch (err) {
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
        cachedCombinedVisibility = getCombinedVisibility();
        if (!cachedCombinedVisibility) return;

        viewer.updateEdgeVisibilityV2(cachedCombinedVisibility);

        // Update all snapshot views' edge visibility
        const snapshots = viewer.getSnapshotViews?.() || [];
        for (const snapshot of snapshots) {
          const snapshotVis = getCombinedVisibility(snapshot.id, snapshot.dimensionLevel);
          if (snapshotVis) {
            viewer.updateEdgeVisibilityV2ForView(snapshot.id, snapshotVis);
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

          const currentLod = viewer.getCurrentLODLevel();
          if (currentLod !== lastLodLevel) {
            console.log(`[Edges] LOD changed: ${lastLodLevel} → ${currentLod}`);
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
      if (state.addVisibilityChangeCallback) {
        state.addVisibilityChangeCallback(onVisibilityChange);
      } else {
        state.setVisibilityChangeCallback(onVisibilityChange);
      }

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
          const max = parseInt(connectivityLimitInput.max || EDGE_UI_CAP, 10);
          const min = parseInt(connectivityLimitInput.min || '1000', 10);
          const requested = parseInt(connectivityLimitInput.value, 10);
          currentEdgeLimit = Math.max(min, Math.min(max, Number.isFinite(requested) ? requested : 0));
          connectivityLimitInput.value = currentEdgeLimit;
          connectivityLimitDisplay.textContent = formatEdgeCount(currentEdgeLimit);

          // Apply LOD limit using accurate visible edge calculation
          applyEdgeLodLimit();
        });
      }

      // Set up KNN edge load callback - triggers when KNN mode needs edges
      // This loads edges on-demand when user first tries to use KNN drag
      if (viewer.setKnnEdgeLoadCallback) {
        viewer.setKnnEdgeLoadCallback(async () => {
          // Check if connectivity manifest is available
          if (!connectivityManifest || !hasEdgeFormat(connectivityManifest)) {
            console.warn('[Main] KNN mode requested but no connectivity manifest available');
            notifications.warn('No neighbor graph available for this dataset', { category: 'connectivity' });
            return;
          }

          // If edges are already loaded, just build the adjacency list
          if (edgesLoaded && edgeSources && edgeDestinations) {
            if (!viewer.isKnnEdgesLoaded()) {
              viewer.loadKnnEdges(edgeSources, edgeDestinations);
            }
            return;
          }

          // Otherwise, load edges first
          const knnNotifId = notifications.loading('Loading neighbor graph for KNN mode', { category: 'connectivity' });
          try {
            console.log('[Main] Loading edges for KNN mode...');
            const edgeData = await loadEdges(getConnectivityManifestUrl(), connectivityManifest);

            // Shuffle for random sampling (if not already done)
            shuffleEdges(edgeData.sources, edgeData.destinations);

            // Store edge arrays
            edgeSources = edgeData.sources;
            edgeDestinations = edgeData.destinations;

            // Set up V2 rendering (for potential edge display)
            viewer.setupEdgesV2(edgeData, state.positionsArray);
            edgesLoaded = true;

            // Build KNN adjacency list
            viewer.loadKnnEdges(edgeData.sources, edgeData.destinations);

            console.log(`[Main] KNN edges loaded: ${edgeData.nEdges} edges`);
            notifications.complete(knnNotifId, `Neighbor graph ready (${edgeData.nEdges.toLocaleString()} edges)`);
          } catch (err) {
            console.error('[Main] Failed to load edges for KNN:', err);
            notifications.fail(knnNotifId, 'Failed to load neighbor graph');
          }
        });
      }
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
        console.log('[Main] Benchmark module lazy-loaded');
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
        const hpStats = viewer.getRendererStats();
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
      renderBenchmarkStats(null, viewer.getRendererStats(), buildDatasetSnapshot());
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

      console.log(`Running benchmark: ${formatNumber(pointCount)} points (${pattern})`);

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
      notifications.completeDataGeneration(benchNotifId, genTime);

      // Show generation time
      if (benchGenInfoEl && benchGenTimeEl) {
        benchGenTimeEl.textContent = genTime;
        benchGenInfoEl.style.display = 'block';
      }

      // Create transparency and outlier arrays
      const transparency = new Float32Array(pointCount).fill(1.0);
      const outlierQuantiles = new Float32Array(pointCount).fill(-1.0);

      // Ensure point rendering mode for benchmarks
      if (renderModeSelect && renderModeSelect.value !== 'points') {
        renderModeSelect.value = 'points';
        viewer.setRenderMode('points');
      }

      // Load into viewer (HP renderer is always used)
      // Pass dimensionLevel from synthetic data generator for correct spatial index construction
      // (e.g., flatUMAP returns dimensionLevel: 2 for 2D data)
      const syntheticDimLevel = data.dimensionLevel ?? 3;
      viewer.setData({
        positions: data.positions,
        colors: data.colors,
        outlierQuantiles,
        transparency,
        dimensionLevel: syntheticDimLevel
      });

      // Clear centroids
      viewer.setCentroids({
        positions: new Float32Array(0),
        colors: new Uint8Array(0), // RGBA uint8
        outlierQuantiles: new Float32Array(0),
        transparency: new Float32Array(0)
      });

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

      console.log(`Benchmark loaded: ${formatNumber(pointCount)} points, ~${gpuMemMB}MB GPU memory (gen: ${genTime}ms)`);
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
      const rendererStats = viewer.getRendererStats();
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
        const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');

        if (!gl) {
          alert('WebGL not available');
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
          console.log('[Bottleneck Analysis]', results);

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

    await autoLoadLatestState();

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
  } catch (err) {
    console.error(err);
    statsEl.textContent = 'Error: ' + err.message;
    if (currentDatasetLoadToken) {
      completeDataLoadFailure(currentDatasetLoadToken, {
        ...buildDatasetAnalyticsContext(),
        error: err
      });
      currentDatasetLoadToken = null;
    }
    // Show error in notification center if initialized
    try {
      getNotificationCenter().error(`Initialization error: ${err.message}`, { duration: 10000 });
    } catch (_) { /* notification center may not be initialized */ }
  }
})();
