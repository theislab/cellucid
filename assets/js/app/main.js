// App entrypoint: loads data, initializes the viewer/state, and wires the UI.
import { createViewer } from '../rendering/viewer.js';
import { createDataState } from './state.js';
import { initUI } from './ui.js';
import { createStateSerializer } from './state-serializer.js';
import {
  loadPointsBinary,
  loadObsJson,
  loadObsManifest,
  loadObsFieldData,
  loadVarManifest,
  loadVarFieldData,
  loadConnectivityManifest,
  hasEdgeFormat,
  loadEdges
} from '../data/data-loaders.js';
import { SyntheticDataGenerator, PerformanceTracker, BenchmarkReporter, formatNumber } from '../dev/benchmark.js';

console.log('=== SCATTERPLOT APP STARTING ===');

const EXPORT_BASE_URL = 'assets/exports/';
const OBS_MANIFEST_URL = `${EXPORT_BASE_URL}obs_manifest.json`;
const VAR_MANIFEST_URL = `${EXPORT_BASE_URL}var_manifest.json`;
const CONNECTIVITY_MANIFEST_URL = `${EXPORT_BASE_URL}connectivity_manifest.json`;
const LEGACY_OBS_URL = `${EXPORT_BASE_URL}obs_values.json`;

(async function bootstrap() {
  const canvas = document.getElementById('glcanvas');
  const labelLayer = document.getElementById('label-layer');
  const viewTitleLayer = document.getElementById('view-title-layer');
  const statsEl = document.getElementById('stats');
  const categoricalFieldSelect = document.getElementById('categorical-field');
  const continuousFieldSelect = document.getElementById('continuous-field');
  const legendEl = document.getElementById('legend');
  const pointSizeInput = document.getElementById('point-size');
  const pointSizeDisplay = document.getElementById('point-size-display');
  const backgroundSelect = document.getElementById('background-select');
  const pointsControls = document.getElementById('points-controls');
  const centroidControls = document.getElementById('centroid-controls');
  const centroidPointsCheckbox = document.getElementById('toggle-centroid-points');
  const centroidLabelsCheckbox = document.getElementById('toggle-centroid-labels');
  const sidebar = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const displayOptionsContainer = document.getElementById('display-options-container');
  const outlierFilterContainer = document.getElementById('outlier-filter-container');
  const outlierFilterInput = document.getElementById('outlier-filter');
  const outlierFilterDisplay = document.getElementById('outlier-filter-display');
  const filterCountEl = document.getElementById('filter-count');
  const activeFiltersEl = document.getElementById('active-filters');
  // Highlight UI elements
  const highlightCountEl = document.getElementById('highlight-count');
  const highlightedGroupsEl = document.getElementById('highlighted-groups-list');
  const highlightActionsEl = document.getElementById('highlight-actions');
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
  const freeflyControls = document.getElementById('freefly-controls');
  const orbitControls = document.getElementById('orbit-controls');
  const geneExpressionContainer = document.getElementById('gene-expression-container');
  const geneExpressionSearch = document.getElementById('gene-expression-search');
  const geneExpressionDropdown = document.getElementById('gene-expression-dropdown');
  const geneExpressionSelected = document.getElementById('gene-expression-selected');

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
  const smokeRebuildHint = document.getElementById('smoke-rebuild-hint');

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
  const sessionStatus = document.getElementById('session-status');

  try {
    console.log('[Main] Creating viewer...');
    const viewer = createViewer({ canvas, labelLayer, viewTitleLayer, sidebar });
    console.log('[Main] Viewer created successfully');
    
    const state = createDataState({ viewer, labelLayer });
    console.log('[Main] State created successfully');
    const benchmarkReporter = new BenchmarkReporter({ viewer, state, canvas });
    
    statsEl.textContent = 'Loading positions…';

    const positionsPromise = loadPointsBinary(`${EXPORT_BASE_URL}points.bin`);

    let obs = null;
    try {
      obs = await loadObsManifest(OBS_MANIFEST_URL);
      state.setFieldLoader((field) => loadObsFieldData(OBS_MANIFEST_URL, field));
      statsEl.textContent = 'Loaded obs manifest (lazy-loading fields)…';
    } catch (err) {
      if (err?.status === 404) {
        console.warn('obs_manifest.json not found, falling back to obs_values.json');
        try {
          obs = await loadObsJson(LEGACY_OBS_URL);
          statsEl.textContent = 'Loaded legacy obs JSON (full payload).';
        } catch (err2) {
          console.warn('obs_values.json also not found, using empty obs');
          obs = { fields: [], count: 0 };
        }
      } else {
        throw err;
      }
    }

    // Try to load var manifest for gene expression
    try {
      const varManifest = await loadVarManifest(VAR_MANIFEST_URL);
      state.setVarFieldLoader((field) => loadVarFieldData(VAR_MANIFEST_URL, field));
      state.initVarData(varManifest);
      console.log(`Loaded var manifest with ${varManifest?.fields?.length || 0} genes.`);
    } catch (err) {
      if (err?.status === 404) {
        console.log('var_manifest.json not found, gene expression not available.');
      } else {
        console.warn('Error loading var manifest:', err);
      }
    }

    // Try to load connectivity manifest for KNN edges
    let connectivityManifest = null;
    try {
      connectivityManifest = await loadConnectivityManifest(CONNECTIVITY_MANIFEST_URL);
      console.log(`Loaded connectivity manifest with ${connectivityManifest?.n_edges?.toLocaleString() || 0} edges.`);
    } catch (err) {
      if (err?.status === 404) {
        console.log('connectivity_manifest.json not found, connectivity not available.');
      } else {
        console.warn('Error loading connectivity manifest:', err);
      }
    }

    const positions = await positionsPromise;

    // Normalize / init scatter state
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

    const ui = initUI({
      state,
      viewer,
      dom: {
        statsEl,
        categoricalFieldSelect,
        continuousFieldSelect,
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
        highlightCountEl,
        highlightedGroupsEl,
        highlightActionsEl,
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
        freeflyControls,
        orbitControls,
        geneExpressionContainer,
        geneExpressionSearch,
        geneExpressionDropdown,
        geneExpressionSelected,
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
        smokeRebuildHint,
        splitViewControls,
        splitKeepViewBtn,
        splitClearBtn,
        cameraLockBtn,
        viewLayoutModeSelect,
        splitViewBadgesBox,
        splitViewBadges,
        splitViewBoxTitle,
        saveStateBtn,
        loadStateBtn,
        sessionStatus
      },
      smoke: {
        rebuildSmokeDensity
      },
      stateSerializer: stateSerializer
    });

    await ui.activateField(-1);

    // Discover state snapshots in the exports directory (for automatic restore)
    async function discoverLocalStateSnapshots(baseUrl) {
      const candidates = new Set();
      const stateRegex = /state[^/]*\.json$/i;
      let resolvedBase = null;
      try {
        resolvedBase = new URL(baseUrl, window.location.href);
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
        const res = await fetch(baseUrl);
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
            const headResp = await fetch(candidateUrl, { method: 'HEAD' });
            if (headResp.ok) {
              candidates.add(candidateUrl);
              continue;
            }
            if (headResp.status === 405 || headResp.status === 501) {
              const getResp = await fetch(candidateUrl);
              if (getResp.ok) {
                candidates.add(candidateUrl);
              }
            }
          } catch (_err) {
            // Ignore missing files or servers that disallow HEAD
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
        await stateSerializer.loadStateFromUrl(target);
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

    // Setup connectivity controls if data is available
    if (connectivityManifest && hasEdgeFormat(connectivityManifest)) {
      // Show connectivity controls
      if (connectivityControls) {
        connectivityControls.style.display = 'block';
      }

      const totalEdges = connectivityManifest.n_edges;
      const EDGE_UI_CAP = 100000000;  // 100M edges max in UI

      // Store edge arrays for accurate visible edge counting
      let edgeSources = null;
      let edgeDestinations = null;

      // Cached visibility state for edge counting
      let cachedCombinedVisibility = null; // Combined: filter AND LOD visibility
      let lastLodLevel = -1;               // Track LOD level for change detection
      let actualVisibleEdges = totalEdges;

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
       */
      function getCombinedVisibility() {
        const filterVis = state.getVisibilityArray();
        const lodVis = viewer.getLodVisibilityArray();

        if (!filterVis) return null;
        if (!lodVis) return filterVis; // No LOD active, just use filter visibility (no copy needed)

        const n = filterVis.length;

        // Reuse or create buffer
        if (!combinedVisibilityBuffer || combinedVisibilityBuffer.length !== n) {
          combinedVisibilityBuffer = new Float32Array(n);
        }

        // Combined visibility = filter AND LOD
        for (let i = 0; i < n; i++) {
          combinedVisibilityBuffer[i] = (filterVis[i] > 0.5 && lodVis[i] > 0.5) ? 1.0 : 0.0;
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
          return { visibleCount: totalEdges };
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
          return totalEdges;
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
        return Math.min(totalEdges, Math.round(totalEdges * ratio * 1.05));
      }

      // Update the connectivity info display
      function updateConnectivityInfo(visibleEdges, shownEdges) {
        if (!connectivityInfo) return;
        connectivityInfo.textContent = `${formatEdgeCount(totalEdges)} total · ${formatEdgeCount(visibleEdges)} visible · ${formatEdgeCount(shownEdges)} shown`;
      }

      // Track current state - user's preference, NOT auto-adjusted by visibility changes
      let currentEdgeLimit = Math.min(250000, totalEdges);  // User's desired edge count (stable)

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

        // The actual shown count is min of desired and available
        updateConnectivityInfo(actualVisibleEdges, targetVisible);
      }

      // Initial slider setup and info display
      updateSliderRange(actualVisibleEdges);
      updateConnectivityInfo(actualVisibleEdges, Math.min(currentEdgeLimit, actualVisibleEdges));

      // Edge loading state
      let edgesLoaded = false;

      if (connectivityCheckbox) {
        connectivityCheckbox.addEventListener('change', async () => {
          const show = connectivityCheckbox.checked;

          // Load edge data on first toggle
          if (show && !edgesLoaded) {
            try {
              if (connectivityInfo) {
                connectivityInfo.textContent = 'Loading connectivity data...';
              }

              console.log('[Main] Loading GPU-optimized edges...');
              const edgeData = await loadEdges(CONNECTIVITY_MANIFEST_URL, connectivityManifest);

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

              // Get combined visibility (filter + LOD) and count visible edges
              cachedCombinedVisibility = getCombinedVisibility();
              if (cachedCombinedVisibility) {
                viewer.updateEdgeVisibilityV2(cachedCombinedVisibility);
                const { visibleCount } = countVisibleEdges(cachedCombinedVisibility);
                actualVisibleEdges = visibleCount;
              }
              lastLodLevel = viewer.getCurrentLODLevel();

              // Update slider range and apply LOD
              updateSliderRange(actualVisibleEdges);
              applyEdgeLodLimit();

              console.log(`[Main] Edges loaded: ${edgeData.nEdges} edges, ${edgeData.nCells} cells, visible: ${actualVisibleEdges}`);

            } catch (err) {
              console.error('Failed to load connectivity data:', err);
              if (connectivityInfo) {
                connectivityInfo.textContent = 'Failed to load connectivity';
              }
              connectivityCheckbox.checked = false;
              return;
            }
          } else if (show && edgesLoaded) {
            // Already loaded - just update combined visibility
            cachedCombinedVisibility = getCombinedVisibility();
            if (cachedCombinedVisibility) {
              viewer.updateEdgeVisibilityV2(cachedCombinedVisibility);
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

      /**
       * Update edge visibility with combined filter + LOD visibility.
       * Called when filters change or LOD level changes.
       */
      function updateEdgeVisibilityCore() {
        if (!edgesLoaded) return;

        // Get combined visibility (filter AND LOD)
        cachedCombinedVisibility = getCombinedVisibility();
        if (!cachedCombinedVisibility) return;

        viewer.updateEdgeVisibilityV2(cachedCombinedVisibility);

        // Count actual visible edges (both endpoints visible)
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
    const benchmarkReportStatus = document.getElementById('benchmark-report-status');
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

    // Performance tracker for FPS monitoring
    const perfTracker = new PerformanceTracker();
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
          benchFpsEl.style.color = displayFps > 55 ? '#22c55e' : displayFps > 30 ? '#f59e0b' : '#ef4444';
        }
        if (benchFrametimeEl) {
          const frameText = displayFrameTime != null ? `${displayFrameTime} ms` : '-';
          benchFrametimeEl.textContent = renderFrameTime ? `${frameText} (render ${renderFrameTime} ms)` : frameText;
        }

        if (stats.samples >= 30 && benchTimingDetailsEl) {
          benchTimingDetailsEl.style.display = 'block';
          if (benchMinFtEl) benchMinFtEl.textContent = stats.minFrameTime + ' ms';
          if (benchP95FtEl) benchP95FtEl.textContent = stats.p95FrameTime + ' ms';
          if (benchMaxFtEl) benchMaxFtEl.textContent = stats.maxFrameTime + ' ms';
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
      perfTracker.stop();
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
        // Reset force LOD to auto when enabling
        if (hpLodEnabled.checked && hpLodForce) {
          hpLodForce.value = '-1';
          if (hpLodForceLabel) hpLodForceLabel.textContent = 'Auto';
          viewer.setForceLOD(-1);
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
      benchmarkSection.addEventListener('toggle', () => {
        if (benchmarkSection.open) {
          activateBenchmarkingPanel({ resetTracker: true });
        } else {
          stopPerfMonitoring();
        }
      });
    }

    async function runBenchmark(pointCount, pattern) {
      console.log(`Running benchmark: ${formatNumber(pointCount)} points (${pattern})`);

      ensureBenchmarkStatsVisible();
      if (benchPointsEl) benchPointsEl.textContent = 'Loading...';
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
            // Async loading from GLB file
            if (benchPointsEl) benchPointsEl.textContent = 'Loading GLB...';
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
        if (benchPointsEl) benchPointsEl.textContent = message;
        return;
      }
      const genTime = Math.round(performance.now() - genStart);

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
      viewer.setData({
        positions: data.positions,
        colors: data.colors,
        outlierQuantiles,
        transparency
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
        visiblePoints: pointCount
      };

      const gpuMemMB = (pointCount * 28 / 1024 / 1024).toFixed(1);

      // Refresh stat panel immediately and start perf tracking loop
      activateBenchmarkingPanel({ resetTracker: true });

      console.log(`Benchmark loaded: ${formatNumber(pointCount)} points, ~${gpuMemMB}MB GPU memory (gen: ${genTime}ms)`);
    }

    async function generateSituationReport() {
      if (!benchmarkReporter) return;
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
      if (benchmarkReportStatus) {
        benchmarkReportStatus.textContent = `Report ready (${datasetSnapshot.mode} data)`;
      }

      if (navigator?.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(yamlOutput);
          if (benchmarkReportStatus) {
            benchmarkReportStatus.textContent = 'Report copied to clipboard';
          }
        } catch (err) {
          console.warn('Clipboard copy failed', err);
          if (benchmarkReportStatus) {
            benchmarkReportStatus.textContent = 'Copy failed — select the text manually.';
          }
        }
      }
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
        if (benchmarkReportStatus) {
          benchmarkReportStatus.textContent = 'Generating report...';
        }
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

    await autoLoadLatestState();

    viewer.start();
  } catch (err) {
    console.error(err);
    statsEl.textContent = 'Error: ' + err.message;
  }
})();
