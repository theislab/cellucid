// App entrypoint: loads data, initializes the viewer/state, and wires the UI.
import { createViewer } from './viewer.js';
import { createDataState } from './state.js';
import { initUI } from './ui.js';
import {
  loadPointsBinary,
  loadObsJson,
  loadObsManifest,
  loadObsFieldData,
  loadVarManifest,
  loadVarFieldData,
  loadConnectivityManifest,
  loadConnectivityIndptr,
  loadConnectivityIndices
} from './data-loaders.js';
import { SyntheticDataGenerator, PerformanceTracker, formatNumber } from './benchmark.js';

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
  const outlierFilterContainer = document.getElementById('outlier-filter-container');
  const outlierFilterInput = document.getElementById('outlier-filter');
  const outlierFilterDisplay = document.getElementById('outlier-filter-display');
  const filterCountEl = document.getElementById('filter-count');
  const activeFiltersEl = document.getElementById('active-filters');
  const lightingStrengthInput = document.getElementById('lighting-strength');
  const lightingStrengthDisplay = document.getElementById('lighting-strength-display');
  const fogDensityInput = document.getElementById('fog-density');
  const fogDensityDisplay = document.getElementById('fog-density-display');
  const sizeAttenuationInput = document.getElementById('size-attenuation');
  const sizeAttenuationDisplay = document.getElementById('size-attenuation-display');
  const hintEl = document.getElementById('hint');
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
  const viewLayoutModeSelect = document.getElementById('view-layout-mode');
  const activeViewSelect = document.getElementById('active-view-select');
  const splitViewBadges = document.getElementById('split-view-badges');

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

  try {
    console.log('[Main] Creating viewer...');
    const viewer = createViewer({ canvas, labelLayer, viewTitleLayer, sidebar });
    console.log('[Main] Viewer created successfully');
    
    const state = createDataState({ viewer, labelLayer });
    console.log('[Main] State created successfully');
    
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

    const ui = initUI({
      state,
      viewer,
      dom: {
        statsEl,
        categoricalFieldSelect,
        continuousFieldSelect,
        legendEl,
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
        lightingStrengthInput,
        lightingStrengthDisplay,
        fogDensityInput,
        fogDensityDisplay,
        sizeAttenuationInput,
        sizeAttenuationDisplay,
        hintEl,
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
        viewLayoutModeSelect,
        activeViewSelect,
        splitViewBadges
      },
      smoke: {
        rebuildSmokeDensity
      }
    });

    await ui.activateField(-1);

    // Initial smoke mode setup
    if (renderModeSelect) {
      const mode = renderModeSelect.value || 'points';
      viewer.setRenderMode(mode === 'smoke' ? 'smoke' : 'points');
    }

    // Setup connectivity controls if data is available
    if (connectivityManifest && connectivityManifest.n_edges > 0) {
      // Show connectivity controls
      if (connectivityControls) {
        connectivityControls.style.display = 'block';
      }
      if (connectivityInfo) {
        const avgNeighbors = (connectivityManifest.nnz / connectivityManifest.n_points).toFixed(1);
        connectivityInfo.textContent = `${connectivityManifest.n_edges.toLocaleString()} edges (~${avgNeighbors} neighbors/cell)`;
      }

      const totalEdges = connectivityManifest.n_edges;
      const EDGE_UI_CAP = 5000000;
      
      // Set max limit to actual edge count
      if (connectivityLimitInput) {
        connectivityLimitInput.max = Math.min(totalEdges, EDGE_UI_CAP);  // Cap UI at 5M
        connectivityLimitInput.min = Math.min(parseInt(connectivityLimitInput.min || '0', 10) || 0, connectivityLimitInput.max);
        connectivityLimitInput.value = Math.min(100000, totalEdges);
        if (connectivityLimitDisplay) {
          connectivityLimitDisplay.textContent = formatEdgeCount(connectivityLimitInput.value);
        }
      }

      // CSR data storage
      let csrIndptr = null;
      let csrIndices = null;
      let csrLoaded = false;
      let currentEdgeLimit = parseInt(connectivityLimitInput?.value || 100000);
      const defaultEdgeStep = parseInt(connectivityLimitInput?.step || '1000', 10) || 1000;
      
      // Format edge count for display
      function formatEdgeCount(n) {
        n = parseInt(n);
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
        return n.toString();
      }

      function syncEdgeLimitRange(eligibleEdges) {
        if (!connectivityLimitInput || !connectivityLimitDisplay) return;
        const sliderMax = Math.min(
          EDGE_UI_CAP,
          Math.max(0, Math.min(totalEdges, Math.round(eligibleEdges)))
        );
        const sliderMin = Math.min(1000, sliderMax);
        const sliderStep = sliderMax > 0
          ? Math.max(1, Math.min(defaultEdgeStep, sliderMax))
          : 1;

        connectivityLimitInput.max = sliderMax;
        connectivityLimitInput.min = sliderMin;
        connectivityLimitInput.step = sliderStep;

        if (sliderMax === 0) {
          currentEdgeLimit = 0;
          connectivityLimitInput.value = 0;
        } else {
          if (currentEdgeLimit > sliderMax) {
            currentEdgeLimit = sliderMax;
            connectivityLimitInput.value = sliderMax;
          } else if (currentEdgeLimit < sliderMin) {
            currentEdgeLimit = sliderMin;
            connectivityLimitInput.value = sliderMin;
          }
        }

        connectivityLimitDisplay.textContent = formatEdgeCount(currentEdgeLimit);
      }

      syncEdgeLimitRange(totalEdges);
      
      // Seeded random for reproducibility
      function seededRandom(seed) {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
      }
      
      // Build edges for visible cells only with random sampling
      function buildEdgesForVisibleCells() {
        if (!csrLoaded || !csrIndptr || !csrIndices) return;
        
        // Get visibility from state
        const visibility = state.getVisibilityArray();
        if (!visibility || visibility.length === 0) {
          if (connectivityInfo) {
            connectivityInfo.textContent = 'No visibility data available';
          }
          viewer.setConnectivityEdges(new Uint32Array(0));
          return;
        }
        
        // Find visible cell indices
        const visibleSet = new Set();
        for (let i = 0; i < visibility.length; i++) {
          if (visibility[i] > 0.5) {  // Threshold for "visible"
            visibleSet.add(i);
          }
        }
        
        const numVisible = visibleSet.size;
        if (numVisible === 0) {
          viewer.setConnectivityEdges(new Uint32Array(0));
          if (connectivityInfo) {
            connectivityInfo.textContent = 'No visible cells';
          }
          return;
        }
        
        // First pass: collect all eligible edges (both endpoints visible)
        const allEdges = [];
        for (const cellIdx of visibleSet) {
          const start = csrIndptr[cellIdx];
          const end = csrIndptr[cellIdx + 1];
          for (let j = start; j < end; j++) {
            const neighborIdx = csrIndices[j];
            // Only count edge once (cellIdx < neighborIdx) and both must be visible
            if (neighborIdx > cellIdx && visibleSet.has(neighborIdx)) {
              allEdges.push(cellIdx, neighborIdx);
            }
          }
        }
        
        const totalEligible = allEdges.length / 2;
        syncEdgeLimitRange(totalEligible);
        
        if (totalEligible === 0) {
          viewer.setConnectivityEdges(new Uint32Array(0));
          if (connectivityInfo) {
            connectivityInfo.textContent = `${numVisible.toLocaleString()} visible cells, no edges between them`;
          }
          return;
        }
        
        // Apply limit with random sampling
        let finalEdges;
        let wasLimited = false;
        
        if (totalEligible <= currentEdgeLimit) {
          // Use all edges
          finalEdges = new Uint32Array(allEdges);
        } else {
          // Random sample edges
          wasLimited = true;
          const indices = [];
          for (let i = 0; i < totalEligible; i++) {
            indices.push(i);
          }
          
          // Fisher-Yates shuffle with seed for reproducibility
          const seed = 12345;
          for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(seededRandom(seed + i) * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
          }
          
          // Take first currentEdgeLimit edges
          const sampled = [];
          for (let i = 0; i < currentEdgeLimit; i++) {
            const edgeIdx = indices[i];
            sampled.push(allEdges[edgeIdx * 2], allEdges[edgeIdx * 2 + 1]);
          }
          finalEdges = new Uint32Array(sampled);
        }
        
        const numEdges = finalEdges.length / 2;
        viewer.setConnectivityEdges(finalEdges);
        
        if (connectivityInfo) {
          if (wasLimited) {
            connectivityInfo.textContent = `${numEdges.toLocaleString()} of ${totalEligible.toLocaleString()} edges (${numVisible.toLocaleString()} visible cells)`;
          } else {
            connectivityInfo.textContent = `${numEdges.toLocaleString()} edges (${numVisible.toLocaleString()} visible cells)`;
          }
        }
      }
      
      if (connectivityCheckbox) {
        connectivityCheckbox.addEventListener('change', async () => {
          const show = connectivityCheckbox.checked;
          
          // Load CSR data on first toggle
          if (show && !csrLoaded) {
            try {
              if (connectivityInfo) {
                connectivityInfo.textContent = 'Loading connectivity data...';
              }
              // Load CSR format
              const [indptr, indices] = await Promise.all([
                loadConnectivityIndptr(CONNECTIVITY_MANIFEST_URL, connectivityManifest),
                loadConnectivityIndices(CONNECTIVITY_MANIFEST_URL, connectivityManifest)
              ]);
              csrIndptr = indptr;
              csrIndices = indices;
              csrLoaded = true;
              
              // Build initial edges for current visibility
              buildEdgesForVisibleCells();
              
            } catch (err) {
              console.error('Failed to load connectivity data:', err);
              if (connectivityInfo) {
                connectivityInfo.textContent = 'Failed to load connectivity';
              }
              connectivityCheckbox.checked = false;
              return;
            }
          } else if (show && csrLoaded) {
            // Rebuild edges for current visibility
            buildEdgesForVisibleCells();
          }
          
          viewer.setShowConnectivity(show);
          if (connectivitySliders) {
            connectivitySliders.style.display = show ? 'block' : 'none';
          }
        });
      }

      // Update edges when visibility changes
      const onVisibilityChange = () => {
        // Rebuild edges if connectivity is shown
        if (connectivityCheckbox?.checked && csrLoaded) {
          buildEdgesForVisibleCells();
        }
      };
      if (state.addVisibilityChangeCallback) {
        state.addVisibilityChangeCallback(onVisibilityChange);
      } else {
        state.setVisibilityChangeCallback(onVisibilityChange);
      }

      // Wire up color picker
      if (connectivityColorInput) {
        connectivityColorInput.addEventListener('input', () => {
          const hex = connectivityColorInput.value;
          // Parse hex to RGB (0-1 range)
          const r = parseInt(hex.slice(1, 3), 16) / 255;
          const g = parseInt(hex.slice(3, 5), 16) / 255;
          const b = parseInt(hex.slice(5, 7), 16) / 255;
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
      
      // Wire up limit slider
      if (connectivityLimitInput && connectivityLimitDisplay) {
        connectivityLimitInput.addEventListener('input', () => {
          const max = parseInt(connectivityLimitInput.max || EDGE_UI_CAP, 10) || EDGE_UI_CAP;
          const min = parseInt(connectivityLimitInput.min || '0', 10) || 0;
          const requested = parseInt(connectivityLimitInput.value, 10);
          currentEdgeLimit = Math.max(min, Math.min(max, Number.isFinite(requested) ? requested : 0));
          connectivityLimitInput.value = currentEdgeLimit;
          connectivityLimitDisplay.textContent = formatEdgeCount(currentEdgeLimit);
          // Rebuild edges if currently shown
          if (connectivityCheckbox?.checked && csrLoaded) {
            buildEdgesForVisibleCells();
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

    // HP renderer controls (always-on HP renderer)
    const hpShaderQuality = document.getElementById('hp-shader-quality');
    const hpFrustumCulling = document.getElementById('hp-frustum-culling');
    const hpLodEnabled = document.getElementById('hp-lod-enabled');

    // Performance tracker for FPS monitoring
    const perfTracker = new PerformanceTracker();
    let benchmarkActive = false;

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
      });
    }

    async function runBenchmark(pointCount, pattern) {
      console.log(`Running benchmark: ${formatNumber(pointCount)} points (${pattern})`);

      // Show stats panel
      if (benchmarkStatsEl) {
        benchmarkStatsEl.style.display = 'block';
      }

      // Get all stat elements
      const pointsEl = document.getElementById('bench-points');
      const fpsEl = document.getElementById('bench-fps');
      const frametimeEl = document.getElementById('bench-frametime');
      const memoryEl = document.getElementById('bench-memory');
      const lodEl = document.getElementById('bench-lod');
      const visibleEl = document.getElementById('bench-visible');
      const timingDetailsEl = document.getElementById('bench-timing-details');
      const minFtEl = document.getElementById('bench-min-ft');
      const p95FtEl = document.getElementById('bench-p95-ft');
      const maxFtEl = document.getElementById('bench-max-ft');
      const genInfoEl = document.getElementById('bench-gen-info');
      const genTimeEl = document.getElementById('bench-gen-time');

      if (pointsEl) pointsEl.textContent = 'Loading...';
      if (fpsEl) fpsEl.textContent = '-';
      if (timingDetailsEl) timingDetailsEl.style.display = 'none';
      if (genInfoEl) genInfoEl.style.display = 'none';

      // Generate synthetic data with timing
      let data;
      const genStart = performance.now();
      try {
        switch (pattern) {
          case 'uniform':
            data = SyntheticDataGenerator.uniformRandom(pointCount);
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
            if (pointsEl) pointsEl.textContent = 'Loading GLB...';
            data = await SyntheticDataGenerator.fromGLBUrl(pointCount);
            break;
          case 'clusters':
          default:
            data = SyntheticDataGenerator.gaussianClusters(pointCount);
        }
      } catch (err) {
        console.error('Failed to generate data:', err);
        if (pointsEl) pointsEl.textContent = 'Error: ' + err.message;
        return;
      }
      const genTime = Math.round(performance.now() - genStart);

      // Show generation time
      if (genInfoEl && genTimeEl) {
        genTimeEl.textContent = genTime;
        genInfoEl.style.display = 'block';
      }

      // Create transparency and outlier arrays
      const transparency = new Float32Array(pointCount).fill(1.0);
      const outlierQuantiles = new Float32Array(pointCount).fill(-1.0);

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
        colors: new Float32Array(0),
        outlierQuantiles: new Float32Array(0),
        transparency: new Float32Array(0)
      });

      // Update stats display
      const gpuMemMB = (pointCount * 28 / 1024 / 1024).toFixed(1);
      if (pointsEl) pointsEl.textContent = formatNumber(pointCount);
      if (memoryEl) memoryEl.textContent = gpuMemMB + ' MB';

      // Start performance tracking
      benchmarkActive = true;
      perfTracker.start();

      // Update FPS display periodically
      const updateStats = () => {
        if (!benchmarkActive) return;

        const stats = perfTracker.recordFrame();
        const hpStats = viewer.getRendererStats();

        if (stats && stats.samples > 5) {
          const displayFps = hpStats?.fps || stats.fps;
          const displayFrameTime = hpStats?.lastFrameTime?.toFixed(2) || stats.avgFrameTime;

          if (fpsEl) {
            fpsEl.textContent = displayFps;
            // Color coding: green > 55fps, yellow > 30fps, red < 30fps
            fpsEl.style.color = displayFps > 55 ? '#22c55e' : displayFps > 30 ? '#f59e0b' : '#ef4444';
          }
          if (frametimeEl) frametimeEl.textContent = displayFrameTime + ' ms';

          // Show detailed timing stats after enough samples
          if (stats.samples >= 30 && timingDetailsEl) {
            timingDetailsEl.style.display = 'block';
            if (minFtEl) minFtEl.textContent = stats.minFrameTime + ' ms';
            if (p95FtEl) p95FtEl.textContent = stats.p95FrameTime + ' ms';
            if (maxFtEl) maxFtEl.textContent = stats.maxFrameTime + ' ms';
          }

          // HP renderer stats
          if (hpStats) {
            if (lodEl) lodEl.textContent = hpStats.lodLevel === -1 ? 'Full' : `Level ${hpStats.lodLevel}`;
            if (visibleEl) visibleEl.textContent = formatNumber(hpStats.visiblePoints);
          } else {
            if (lodEl) lodEl.textContent = '-';
            if (visibleEl) visibleEl.textContent = formatNumber(pointCount);
          }
        }

        requestAnimationFrame(updateStats);
      };

      requestAnimationFrame(updateStats);

      console.log(`Benchmark loaded: ${formatNumber(pointCount)} points, ~${gpuMemMB}MB GPU memory (gen: ${genTime}ms)`);
    }

    // Wire up run button
    if (benchmarkRunBtn) {
      benchmarkRunBtn.addEventListener('click', () => {
        const count = parseInt(benchmarkCountInput?.value || '1000000', 10);
        const pattern = benchmarkPatternSelect?.value || 'clusters';
        runBenchmark(count, pattern);
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

    viewer.start();
  } catch (err) {
    console.error(err);
    statsEl.textContent = 'Error: ' + err.message;
  }
})();
