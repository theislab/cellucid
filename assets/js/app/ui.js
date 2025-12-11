// UI wiring: binds DOM controls to state/viewer, renders legends and filter summaries.
import { formatCellCount as formatDataNumber } from '../data/data-source.js';

export function initUI({ state, viewer, dom, smoke, dataSourceManager, reloadActiveDataset }) {
  console.log('[UI] initUI called with dataSourceManager:', !!dataSourceManager);

  const {
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
    lightingStrengthInput,
    lightingStrengthDisplay,
    fogDensityInput,
    fogDensityDisplay,
    sizeAttenuationInput,
    sizeAttenuationDisplay,
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
    resetCameraBtn,
    navigationModeSelect,
    lookSensitivityInput,
    lookSensitivityDisplay,
    moveSpeedInput,
    moveSpeedDisplay,
    invertLookCheckbox,
    projectilesEnabledCheckbox,
    projectileInfoEl,
    pointerLockCheckbox,
    orbitReverseCheckbox,
    showOrbitAnchorCheckbox,
    freeflyControls,
    orbitControls,
    planarControls,
    planarZoomToCursorCheckbox,
    planarInvertAxesCheckbox,
    geneExpressionContainer,
    geneExpressionSearch,
    geneExpressionDropdown,
    geneExpressionSelected,
    // New smoke controls
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
    // Split view HUD
    splitViewControls,
    splitKeepViewBtn,
    splitClearBtn,
    cameraLockBtn,
    viewLayoutModeSelect,
    splitViewBadgesBox,
    splitViewBadges,
    splitViewBoxTitle,
    // Dimension controls
    dimensionControls,
    dimensionSelect,
    dimensionLoading,
    // Session save/load
    saveStateBtn,
    loadStateBtn,
    sessionStatus,
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
    userDataPath,
    userDataBrowseBtn,
    userDataFileInput,
    userDataStatus
  } = dom;

  const rebuildSmokeDensity = smoke?.rebuildSmokeDensity || null;
  const stateSerializer = arguments[0].stateSerializer || null;
  const reloadDataset = reloadActiveDataset || null;

  const NONE_FIELD_VALUE = '-1';
  const NONE_DATASET_VALUE = '__none__';
  let hasCategoricalFields = false;
  let hasContinuousFields = false;
  let forceDisableFieldSelects = false;
  let hasGeneExpressionFields = false;
  let selectedGeneIndex = -1;
  let geneFieldList = [];

  // Volumetric smoke UI state
  let smokeDirty = false;
  let smokeBuiltOnce = false;
  let smokeGridSize = 128;
  let noiseResolutionScale = viewer.getAdaptiveScaleFactor ? viewer.getAdaptiveScaleFactor() : 1;
  let initialUIState = null;

  // View selection state
  const LIVE_VIEW_ID = 'live';
  let activeViewId = LIVE_VIEW_ID;
  let viewLayoutMode = 'grid'; // 'grid' or 'single'
  let liveViewHidden = false; // Whether to hide live view from grid

  // Create floating range label for continuous selection
  const rangeLabel = document.createElement('div');
  rangeLabel.id = 'selection-range-label';
  rangeLabel.style.cssText = `
    position: fixed;
    pointer-events: none;
    background: rgba(0, 0, 0, 0.8);
    color: #fff;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-family: monospace;
    white-space: nowrap;
    z-index: 10000;
    display: none;
    transform: translate(12px, -50%);
  `;
  document.body.appendChild(rangeLabel);

  // Hide display options by default until a field is active
  setDisplayOptionsVisibility(null);

  function setDisplayOptionsVisibility(field) {
    if (!displayOptionsContainer) return;
    displayOptionsContainer.style.display = field ? 'block' : 'none';
  }

  function showRangeLabel(x, y, minVal, maxVal) {
    const formatVal = (v) => {
      if (v === 0) return '0';
      const abs = Math.abs(v);
      const sign = v < 0 ? '-' : '';
      if (abs >= 10000 || (abs > 0 && abs < 0.01)) {
        const exp = Math.floor(Math.log10(abs));
        const mantissa = abs / Math.pow(10, exp);
        const m = mantissa < 10 ? mantissa.toFixed(1).replace(/\.0$/, '') : Math.round(mantissa);
        return `${sign}${m}e${exp}`;
      }
      if (abs >= 100) return sign + abs.toFixed(0);
      if (abs >= 10) return sign + abs.toFixed(1);
      return sign + abs.toFixed(2);
    };
    rangeLabel.textContent = `${formatVal(minVal)} → ${formatVal(maxVal)}`;
    rangeLabel.style.left = x + 'px';
    rangeLabel.style.top = y + 'px';
    rangeLabel.style.display = 'block';
  }

  function hideRangeLabel() {
    rangeLabel.style.display = 'none';
  }

  function refreshUIForActiveView() {
    const source = state.activeFieldSource || null;
    const activeField = state.getActiveField ? state.getActiveField() : null;
    const counts = state.getFilteredCount
      ? state.getFilteredCount()
      : { shown: state.pointCount, total: state.pointCount };
    const activeView = state.getActiveViewId ? state.getActiveViewId() : LIVE_VIEW_ID;
    const centroidFlags = viewer.getCentroidFlags
      ? viewer.getCentroidFlags(activeView)
      : { points: centroidPointsCheckbox?.checked, labels: centroidLabelsCheckbox?.checked };
    const obsIdx = typeof state.activeFieldIndex === 'number' ? state.activeFieldIndex : -1;
    const varIdx = typeof state.activeVarFieldIndex === 'number' ? state.activeVarFieldIndex : -1;

    if (source === 'obs') {
      if (activeField && activeField.kind === 'continuous') {
        continuousFieldSelect.value = String(obsIdx);
        categoricalFieldSelect.value = NONE_FIELD_VALUE;
      } else if (activeField) {
        categoricalFieldSelect.value = String(obsIdx);
        continuousFieldSelect.value = NONE_FIELD_VALUE;
      } else {
        categoricalFieldSelect.value = NONE_FIELD_VALUE;
        continuousFieldSelect.value = NONE_FIELD_VALUE;
      }
      selectedGeneIndex = -1;
      updateSelectedGeneDisplay();
      if (geneExpressionSearch) {
        geneExpressionSearch.value = '';
      }
    } else if (source === 'var') {
      categoricalFieldSelect.value = NONE_FIELD_VALUE;
      continuousFieldSelect.value = NONE_FIELD_VALUE;
      const geneIdx = geneFieldList.findIndex(({ idx }) => idx === varIdx);
      selectedGeneIndex = geneIdx;
      if (geneExpressionSearch && activeField) {
        geneExpressionSearch.value = activeField.key || '';
      }
      updateSelectedGeneDisplay();
    } else {
      categoricalFieldSelect.value = NONE_FIELD_VALUE;
      continuousFieldSelect.value = NONE_FIELD_VALUE;
      selectedGeneIndex = -1;
      updateSelectedGeneDisplay();
      if (geneExpressionSearch) {
        geneExpressionSearch.value = '';
      }
    }

    renderLegend(activeField);
    handleOutlierUI(activeField);
    renderFilterSummary();
    // Get centroids for current dimension
    let centroidCount = 0;
    if (activeField && activeField.kind === 'category') {
      const currentDim = state.getDimensionLevel?.() || 3;
      const centroidsByDim = activeField.centroidsByDim || {};
      const dimCentroids = centroidsByDim[String(currentDim)]
        || centroidsByDim[currentDim]
        || activeField.centroids  // Legacy fallback
        || [];
      centroidCount = dimCentroids.length;
    }
    const centroidInfo = centroidCount > 0 ? ` • Centroids: ${centroidCount}` : '';
    updateStats({
      field: activeField,
      pointCount: counts.total,
      centroidInfo
    });

    if (centroidPointsCheckbox && centroidFlags.points != null) {
      centroidPointsCheckbox.checked = !!centroidFlags.points;
    }
    if (centroidLabelsCheckbox && centroidFlags.labels != null) {
      centroidLabelsCheckbox.checked = !!centroidFlags.labels;
    }
  }

  function syncActiveViewToState() {
    if (typeof state.setActiveView === 'function') {
      state.setActiveView(activeViewId);
    }
    refreshUIForActiveView();
    // Sync dimension slider to reflect the active view's dimension level
    syncDimensionSliderToActiveView();
  }

  /**
   * Sync dimension dropdown to reflect the active view's dimension level.
   * Called when switching between views to ensure the dropdown shows the correct state.
   */
  function syncDimensionSliderToActiveView() {
    if (!dimensionSelect) return;
    const viewDim = state.getViewDimensionLevel?.(activeViewId) ?? state.getDimensionLevel?.() ?? 3;
    updateDimensionSelectValue(viewDim);
  }

  /**
   * Update the selected value of dimension dropdown
   * @param {number} activeDim - The active dimension level
   */
  function updateDimensionSelectValue(activeDim) {
    if (!dimensionSelect) return;
    dimensionSelect.value = String(activeDim);
  }

  // Debounced auto-rebuild for smoke density
  let smokeRebuildTimeout = null;
  function scheduleAutoRebuild() {
    if (smokeRebuildTimeout) clearTimeout(smokeRebuildTimeout);
    smokeDirty = true;
    if (smokeRebuildHint) {
      smokeRebuildHint.textContent = 'Rebuilding smoke density...';
    }
    smokeRebuildTimeout = setTimeout(() => {
      if (rebuildSmokeDensity && renderModeSelect?.value === 'smoke') {
        rebuildSmokeDensity(smokeGridSize);
        markSmokeClean();
      }
    }, 300); // 300ms debounce
  }

  function markSmokeDirty() {
    smokeDirty = true;
    // Auto-rebuild when in smoke mode
    if (renderModeSelect?.value === 'smoke') {
      scheduleAutoRebuild();
    } else if (smokeRebuildHint) {
      smokeRebuildHint.textContent = 'Smoke density will rebuild when switching to smoke mode.';
    }
  }

  function markSmokeClean() {
    smokeDirty = false;
    smokeBuiltOnce = true;
    if (smokeRebuildHint) {
      smokeRebuildHint.textContent = 'Smoke density is up to date.';
    }
  }

  // Log-scale point size mapping
  const MIN_POINT_SIZE = 0.25;
  const MAX_POINT_SIZE = 200.0;
  const DEFAULT_POINT_SIZE = 1.0;
  const POINT_SIZE_SCALE = MAX_POINT_SIZE / MIN_POINT_SIZE;

  function rgbToHex(color) {
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
    const r = clamp(color?.[0] ?? 0);
    const g = clamp(color?.[1] ?? 0);
    const b = clamp(color?.[2] ?? 0);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  function hexToRgb01(hex) {
    if (typeof hex !== 'string') return null;
    const normalized = hex.startsWith('#') ? hex.slice(1) : hex;
    if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
    const r = parseInt(normalized.slice(0, 2), 16) / 255;
    const g = parseInt(normalized.slice(2, 4), 16) / 255;
    const b = parseInt(normalized.slice(4, 6), 16) / 255;
    return [r, g, b];
  }

  function sliderToPointSize(sliderValue) {
    const raw = parseFloat(sliderValue);
    if (!isFinite(raw)) return DEFAULT_POINT_SIZE;
    const t = Math.max(0, Math.min(100, raw)) / 100;
    return MIN_POINT_SIZE * Math.pow(POINT_SIZE_SCALE, t);
  }

  function pointSizeToSlider(size) {
    const clamped = Math.max(MIN_POINT_SIZE, Math.min(MAX_POINT_SIZE, size));
    return (Math.log(clamped / MIN_POINT_SIZE) / Math.log(POINT_SIZE_SCALE)) * 100;
  }

  function formatPointSize(size) {
    if (size < 0.1) return size.toFixed(3);
    return size < 10 ? size.toFixed(2) : size.toFixed(1);
  }

  function applyPointSizeFromSlider() {
    const size = sliderToPointSize(pointSizeInput.value);
    viewer.setPointSize(size);
    pointSizeDisplay.textContent = formatPointSize(size);
  }

  function sliderToLookSensitivity(raw) {
    const v = Math.max(1, Math.min(30, parseFloat(raw) || 5));
    return v * 0.0005; // radians per pixel
  }

  function sliderToMoveSpeed(raw) {
    const v = Math.max(1, Math.min(500, parseFloat(raw) || 100));
    return v / 100; // scene units per second
  }

  function updateLookSensitivity() {
    if (!lookSensitivityInput) return;
    const sensitivity = sliderToLookSensitivity(lookSensitivityInput.value);
    if (lookSensitivityDisplay) {
      lookSensitivityDisplay.textContent = (parseFloat(lookSensitivityInput.value) / 100).toFixed(2) + 'x';
    }
    if (viewer.setLookSensitivity) {
      viewer.setLookSensitivity(sensitivity);
    }
  }

  function updateMoveSpeed() {
    if (!moveSpeedInput) return;
    const speed = sliderToMoveSpeed(moveSpeedInput.value);
    if (moveSpeedDisplay) {
      moveSpeedDisplay.textContent = speed.toFixed(2) + ' u/s';
    }
    if (viewer.setMoveSpeed) {
      viewer.setMoveSpeed(speed);
    }
  }

  function toggleNavigationPanels(mode) {
    if (freeflyControls) {
      freeflyControls.style.display = mode === 'free' ? 'block' : 'none';
    }
    if (orbitControls) {
      orbitControls.style.display = mode === 'orbit' ? 'block' : 'none';
    }
    if (planarControls) {
      planarControls.style.display = mode === 'planar' ? 'block' : 'none';
    }
  }

  function updateStats(fieldInfo) {
    if (!fieldInfo) return;
    const { field, pointCount, centroidInfo } = fieldInfo;
    if (!field) {
      statsEl.textContent = `Points: ${pointCount.toLocaleString()} • Field: None`;
      return;
    }
    statsEl.textContent =
      `Points: ${pointCount.toLocaleString()} • Field: ${field.key} (${field.kind})${centroidInfo}`;
  }

  function renderFilterSummary() {
    const filters = state.getActiveFiltersStructured ? state.getActiveFiltersStructured() : [];
    activeFiltersEl.innerHTML = '';
    
    if (filters.length === 0) {
      const line = document.createElement('div');
      line.className = 'filter-info';
      line.textContent = 'No filters active';
      activeFiltersEl.appendChild(line);
    } else {
      filters.forEach((filter) => {
        const item = document.createElement('div');
        item.className = 'filter-item' + (filter.enabled ? '' : ' disabled');
        item.dataset.filterId = filter.id;
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'filter-checkbox';
        checkbox.checked = filter.enabled;
        checkbox.title = filter.enabled ? 'Disable this filter' : 'Enable this filter';
        checkbox.addEventListener('change', () => {
          const enabled = checkbox.checked;
          state.toggleFilterEnabled(filter.id, enabled);
          renderLegend(state.getActiveField());
          handleOutlierUI(state.getActiveField());
          renderFilterSummary();
          markSmokeDirty();
        });
        
        const textSpan = document.createElement('span');
        textSpan.className = 'filter-text';
        const counts = state.getFilterCellCounts ? state.getFilterCellCounts(filter) : null;
        const countText =
          counts && Number.isFinite(counts.visible) && Number.isFinite(counts.available)
            ? ` • ${counts.visible.toLocaleString()} / ${counts.available.toLocaleString()} cells`
            : '';
        const fullText = filter.text + countText;
        textSpan.textContent = fullText;
        textSpan.title = fullText;
        
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'filter-remove-btn';
        removeBtn.innerHTML = '×';
        removeBtn.title = 'Remove this filter';
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          state.removeFilter(filter.id);
          renderLegend(state.getActiveField());
          handleOutlierUI(state.getActiveField());
          renderFilterSummary();
          markSmokeDirty();
        });
        
        item.appendChild(checkbox);
        item.appendChild(textSpan);
        item.appendChild(removeBtn);
        activeFiltersEl.appendChild(item);
      });
    }
    
    const { shown, total } = state.getFilteredCount();
    if (shown === total) {
      filterCountEl.textContent = `Showing all ${total.toLocaleString()} points`;
    } else {
      filterCountEl.textContent =
        `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} points`;
    }

    if (viewer?.hasSnapshots && viewer.hasSnapshots()) {
      renderSplitViewBadges();
    }
  }

  // === HIGHLIGHT UI ===
  const highlightModeButtonsList = Array.isArray(highlightModeButtons)
    ? highlightModeButtons
    : (highlightModeButtons ? [highlightModeButtons] : []);
  const highlightModeDescriptionEl = highlightModeDescription || null;
  const highlightModeCopy = {
    annotation: 'Alt+click a cell to select. Shift+Alt to add, Ctrl+Alt to subtract. For continuous: Alt intersects.',
    knn: 'Alt+click and drag up to expand along neighbors. Shift+Alt to add, Ctrl+Alt to subtract.',
    proximity: 'Alt+click and drag to select by 3D proximity. Shift+Alt to add, Ctrl+Alt to subtract.',
    lasso: 'Hold Alt and draw to select. Rotate and draw again: Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract.'
  };
  let activeHighlightMode = 'annotation';

  // Annotation selection state (multi-step with confirm/cancel)
  let annotationCandidateSet = null; // Set of candidate cell indices
  let annotationStepCount = 0;
  // Undo/redo history for annotation mode (max 5 steps)
  let annotationHistory = []; // [{candidates: Set, step: number}, ...]
  let annotationRedoStack = [];
  const MAX_HISTORY_STEPS = 5;

  // Undo/redo history for lasso mode
  let lassoHistory = [];
  let lassoRedoStack = [];

  // Undo/redo history for proximity mode
  let proximityHistory = [];
  let proximityRedoStack = [];

  // Undo/redo history for KNN mode
  let knnHistory = [];
  let knnRedoStack = [];

  function setHighlightModeUI(mode) {
    const wasLasso = activeHighlightMode === 'lasso';
    const wasProximity = activeHighlightMode === 'proximity';
    const wasKnn = activeHighlightMode === 'knn';
    const wasAnnotation = activeHighlightMode === 'annotation';
    activeHighlightMode = mode;

    if (highlightModeButtonsList && highlightModeButtonsList.length) {
      highlightModeButtonsList.forEach((btn) => {
        const isActive = btn?.dataset?.mode === mode;
        btn?.setAttribute?.('aria-pressed', isActive ? 'true' : 'false');
      });
    }

    // Cancel any in-progress annotation selection when switching away from annotation mode
    if (wasAnnotation && mode !== 'annotation') {
      // Reset UI-managed annotation state
      annotationCandidateSet = null;
      annotationStepCount = 0;
      annotationHistory = [];
      annotationRedoStack = [];
      viewer.cancelAnnotationSelection?.();
      if (state.clearPreviewHighlight) {
        state.clearPreviewHighlight();
      }
    }

    // Cancel any in-progress lasso selection when switching away from lasso mode
    if (wasLasso && mode !== 'lasso') {
      lassoHistory = [];
      lassoRedoStack = [];
      viewer.cancelLassoSelection?.();
      // Clear preview highlight
      if (state.clearPreviewHighlight) {
        state.clearPreviewHighlight();
      }
    }

    // Cancel any in-progress proximity selection when switching away from proximity mode
    if (wasProximity && mode !== 'proximity') {
      proximityHistory = [];
      proximityRedoStack = [];
      viewer.cancelProximitySelection?.();
      // Clear preview highlight
      if (state.clearPreviewHighlight) {
        state.clearPreviewHighlight();
      }
    }

    // Cancel any in-progress KNN selection when switching away from KNN mode
    if (wasKnn && mode !== 'knn') {
      knnHistory = [];
      knnRedoStack = [];
      viewer.cancelKnnSelection?.();
      // Clear preview highlight
      if (state.clearPreviewHighlight) {
        state.clearPreviewHighlight();
      }
    }

    // Remove lasso/proximity/knn/annotation controls UI when switching modes
    const existingControls = document.getElementById('lasso-step-controls');
    if (existingControls) existingControls.remove();
    const existingProximityControls = document.getElementById('proximity-step-controls');
    if (existingProximityControls) existingProximityControls.remove();
    const existingKnnControls = document.getElementById('knn-step-controls');
    if (existingKnnControls) existingKnnControls.remove();
    const existingAnnotationControls = document.getElementById('annotation-step-controls');
    if (existingAnnotationControls) existingAnnotationControls.remove();

    // Update description text (use textContent to clear any innerHTML from lasso UI)
    if (highlightModeDescriptionEl) {
      const text = highlightModeCopy[mode] || '';
      highlightModeDescriptionEl.textContent = text;
      highlightModeDescriptionEl.style.display = text ? 'block' : 'none';
    }

    // Enable/disable lasso mode in viewer
    if (viewer.setLassoEnabled) {
      viewer.setLassoEnabled(mode === 'lasso');
    }

    // Enable/disable proximity mode in viewer
    if (viewer.setProximityEnabled) {
      viewer.setProximityEnabled(mode === 'proximity');
    }

    // Enable/disable KNN mode in viewer and pre-load edges
    if (viewer.setKnnEnabled) {
      viewer.setKnnEnabled(mode === 'knn');

      // Pre-load edges when KNN mode is activated
      if (mode === 'knn' && !viewer.isKnnEdgesLoaded?.()) {
        // Show loading message
        if (highlightModeDescriptionEl) {
          highlightModeDescriptionEl.innerHTML = '<em>Loading neighbor graph...</em>';
        }
        // Trigger async edge loading - the callback in main.js will handle it
        // After loading completes, update the description
        let attempts = 0;
        const maxAttempts = 100; // 10 seconds max wait
        const checkLoaded = setInterval(() => {
          attempts++;
          if (viewer.isKnnEdgesLoaded?.()) {
            clearInterval(checkLoaded);
            if (highlightModeDescriptionEl && activeHighlightMode === 'knn') {
              highlightModeDescriptionEl.innerHTML = highlightModeCopy.knn;
            }
          } else if (attempts >= maxAttempts) {
            clearInterval(checkLoaded);
            if (highlightModeDescriptionEl && activeHighlightMode === 'knn') {
              highlightModeDescriptionEl.innerHTML = '<em style="color: #666;">KNN requires connectivity data. Enable "Show edges" first or check if data is available.</em>';
            }
          }
        }, 100);
      }
    }
  }

  function initHighlightModeButtons() {
    if (!highlightModeButtonsList || highlightModeButtonsList.length === 0) {
      setHighlightModeUI(activeHighlightMode);
      return;
    }

    highlightModeButtonsList.forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextMode = btn.dataset.mode || 'annotation';
        setHighlightModeUI(nextMode);
      });
    });

    const pressed = highlightModeButtonsList.find((btn) => btn.getAttribute('aria-pressed') === 'true');
    const initialMode = pressed?.dataset?.mode || activeHighlightMode;
    setHighlightModeUI(initialMode);
  }

  function renderHighlightSummary() {
    if (!highlightedGroupsEl || !highlightCountEl) return;

    const groups = state.getHighlightedGroups();
    const visibleCount = state.getHighlightedCellCount();
    const totalCount = state.getTotalHighlightedCellCount ? state.getTotalHighlightedCellCount() : visibleCount;

    // Update count - show both visible and total if they differ
    if (totalCount === 0) {
      highlightCountEl.textContent = 'No cells highlighted';
    } else if (visibleCount === totalCount) {
      highlightCountEl.textContent = `${totalCount.toLocaleString()} cells highlighted`;
    } else {
      highlightCountEl.textContent = `${visibleCount.toLocaleString()} of ${totalCount.toLocaleString()} highlighted cells visible`;
    }

    // Show/hide actions
    if (highlightActionsEl) {
      highlightActionsEl.style.display = groups.length > 0 ? 'block' : 'none';
    }

    // Render groups list
    highlightedGroupsEl.innerHTML = '';

    if (groups.length === 0) {
      return;
    }

    groups.forEach((group) => {
      const enabled = group.enabled !== false; // default true
      const item = document.createElement('div');
      item.className = 'highlight-item' + (enabled ? '' : ' disabled');
      item.dataset.highlightId = group.id;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'highlight-checkbox';
      checkbox.checked = enabled;
      checkbox.title = enabled ? 'Disable this highlight' : 'Enable this highlight';
      checkbox.addEventListener('change', () => {
        state.toggleHighlightEnabled(group.id, checkbox.checked);
      });

      const textSpan = document.createElement('span');
      textSpan.className = 'highlight-text';
      textSpan.textContent = `${group.label} (${group.cellCount.toLocaleString()})`;
      textSpan.title = group.label;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'highlight-remove-btn';
      removeBtn.innerHTML = '×';
      removeBtn.title = 'Remove this highlight';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.removeHighlightGroup(group.id);
      });

      item.appendChild(checkbox);
      item.appendChild(textSpan);
      item.appendChild(removeBtn);
      highlightedGroupsEl.appendChild(item);
    });
  }

  // === HIGHLIGHT PAGES UI ===
  let draggedPageId = null;

  function showPageCombineMenu(targetPageId, x, y) {
    // Remove any existing menu
    const existingMenu = document.getElementById('page-combine-menu');
    if (existingMenu) existingMenu.remove();

    const sourcePageId = draggedPageId;
    if (!sourcePageId || sourcePageId === targetPageId) return;

    const menu = document.createElement('div');
    menu.id = 'page-combine-menu';
    menu.className = 'page-combine-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const intersectionBtn = document.createElement('button');
    intersectionBtn.className = 'page-combine-option';
    intersectionBtn.innerHTML = '<span class="page-combine-icon">&#8745;</span> Intersection';
    intersectionBtn.title = 'Create page with cells in BOTH pages';
    intersectionBtn.addEventListener('click', () => {
      const newPage = state.combineHighlightPages(sourcePageId, targetPageId, 'intersection');
      if (newPage) {
        state.switchToPage(newPage.id);
      }
      menu.remove();
    });

    const unionBtn = document.createElement('button');
    unionBtn.className = 'page-combine-option';
    unionBtn.innerHTML = '<span class="page-combine-icon">&#8746;</span> Union';
    unionBtn.title = 'Create page with cells in EITHER page';
    unionBtn.addEventListener('click', () => {
      const newPage = state.combineHighlightPages(sourcePageId, targetPageId, 'union');
      if (newPage) {
        state.switchToPage(newPage.id);
      }
      menu.remove();
    });

    menu.appendChild(intersectionBtn);
    menu.appendChild(unionBtn);
    document.body.appendChild(menu);

    // Close menu when clicking outside
    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('mousedown', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closeMenu), 0);
  }

  function renderHighlightPages() {
    if (!highlightPagesTabsEl) return;

    const pages = state.getHighlightPages();
    const activePageId = state.getActivePageId();

    highlightPagesTabsEl.innerHTML = '';

    pages.forEach((page) => {
      const isActive = page.id === activePageId;
      const groupCount = page.highlightedGroups.length;

      const tab = document.createElement('div');
      tab.className = 'highlight-page-tab' + (isActive ? ' active' : '');
      tab.dataset.pageId = page.id;

      // Make tab draggable
      tab.draggable = true;

      tab.addEventListener('dragstart', (e) => {
        draggedPageId = page.id;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', page.id);
      });

      tab.addEventListener('dragend', () => {
        tab.classList.remove('dragging');
        // Remove drag-over class from all tabs
        highlightPagesTabsEl.querySelectorAll('.highlight-page-tab').forEach((t) => {
          t.classList.remove('drag-over');
        });
      });

      tab.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });

      tab.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (draggedPageId && draggedPageId !== page.id) {
          tab.classList.add('drag-over');
        }
      });

      tab.addEventListener('dragleave', () => {
        tab.classList.remove('drag-over');
      });

      tab.addEventListener('drop', (e) => {
        e.preventDefault();
        tab.classList.remove('drag-over');
        if (draggedPageId && draggedPageId !== page.id) {
          showPageCombineMenu(page.id, e.clientX, e.clientY);
        }
      });

      const nameSpan = document.createElement('span');
      nameSpan.className = 'highlight-page-tab-name';
      nameSpan.textContent = page.name;
      nameSpan.title = page.name;

      // Double-click to rename
      nameSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startPageRename(tab, page);
      });

      const countSpan = document.createElement('span');
      countSpan.className = 'highlight-page-tab-count';
      countSpan.textContent = `(${groupCount})`;

      tab.appendChild(nameSpan);
      tab.appendChild(countSpan);

      // Only show delete button if there's more than one page
      if (pages.length > 1) {
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'highlight-page-tab-delete';
        deleteBtn.innerHTML = '×';
        deleteBtn.title = 'Delete this page';
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          state.deleteHighlightPage(page.id);
        });
        tab.appendChild(deleteBtn);
      }

      // Click to switch page
      tab.addEventListener('click', () => {
        if (!isActive) {
          state.switchToPage(page.id);
        }
      });

      highlightPagesTabsEl.appendChild(tab);
    });
  }

  function startPageRename(tabEl, page) {
    const nameSpan = tabEl.querySelector('.highlight-page-tab-name');
    if (!nameSpan) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'highlight-page-tab-input';
    input.value = page.name;

    const finishRename = () => {
      const newName = input.value.trim() || page.name;
      state.renameHighlightPage(page.id, newName);
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = page.name;
        input.blur();
      }
    });

    nameSpan.textContent = '';
    nameSpan.appendChild(input);
    input.focus();
    input.select();
  }

  // === ANNOTATION SELECTION HANDLERS ===

  // Compute cell indices from selection event
  function computeAnnotationCellIndices(selectionEvent) {
    const activeField = state.getActiveField();
    if (!activeField) return [];

    const cellIndex = selectionEvent.cellIndex;
    const fieldIndex = state.activeFieldSource === 'var'
      ? state.activeVarFieldIndex
      : state.activeFieldIndex;
    const source = state.activeFieldSource || 'obs';

    if (activeField.kind === 'category') {
      const categoryIndex = state.getCategoryForCell(cellIndex, fieldIndex, source);
      if (categoryIndex < 0) return [];
      return state.getCellIndicesForCategory(fieldIndex, categoryIndex, source);
    } else if (activeField.kind === 'continuous') {
      const clickedValue = state.getValueForCell(cellIndex, fieldIndex, source);
      if (clickedValue == null) return [];

      const stats = activeField._continuousStats || { min: 0, max: 1 };
      const valueRange = stats.max - stats.min;

      let minVal, maxVal;
      if (selectionEvent.type === 'range' && selectionEvent.dragDeltaY !== 0) {
        const dragScale = 0.005;
        const dragAmount = -selectionEvent.dragDeltaY * dragScale * valueRange;
        if (dragAmount > 0) {
          minVal = clickedValue;
          maxVal = Math.min(stats.max, clickedValue + dragAmount);
        } else {
          minVal = Math.max(stats.min, clickedValue + dragAmount);
          maxVal = clickedValue;
        }
      } else {
        const rangeSize = valueRange * 0.1;
        minVal = Math.max(stats.min, clickedValue - rangeSize / 2);
        maxVal = Math.min(stats.max, clickedValue + rangeSize / 2);
      }
      return state.getCellIndicesForRange(fieldIndex, minVal, maxVal, source);
    }
    return [];
  }

  // Handle annotation step (each Alt+click/drag)
  function handleAnnotationStep(stepEvent) {
    // Handle cancellation
    if (stepEvent.cancelled) {
      annotationCandidateSet = null;
      annotationStepCount = 0;
      annotationHistory = [];
      annotationRedoStack = [];
      updateAnnotationUI(null);
      if (state.clearPreviewHighlight) {
        state.clearPreviewHighlight();
      }
      return;
    }

    // Hide range label
    hideRangeLabel();

    const activeField = state.getActiveField();
    if (!activeField) {
      console.log('[UI] No active field for annotation selection');
      return;
    }

    const mode = stepEvent.mode || 'intersect';
    const newCellIndices = computeAnnotationCellIndices(stepEvent);

    // Save current state to history before modification
    annotationHistory.push({
      candidates: annotationCandidateSet ? new Set(annotationCandidateSet) : null,
      step: annotationStepCount
    });
    // Limit history size
    if (annotationHistory.length > MAX_HISTORY_STEPS) {
      annotationHistory.shift();
    }
    // Clear redo stack on new action
    annotationRedoStack = [];

    if (newCellIndices.length === 0 && mode !== 'subtract') {
      return;
    }

    const newSet = new Set(newCellIndices);
    let effectiveMode = mode;

    // Apply mode to candidate set based on field type
    if (activeField.kind === 'category') {
      // CATEGORICAL: Alt = replace, Shift+Alt = add, Ctrl+Alt = subtract
      if (mode === 'intersect') {
        // Alt for categorical = REPLACE (not intersect)
        // Clear existing and set to new category
        annotationCandidateSet = new Set(newCellIndices);
        effectiveMode = 'replace';
      } else if (mode === 'union') {
        // Shift+Alt = add to existing
        if (annotationCandidateSet === null) {
          annotationCandidateSet = new Set(newCellIndices);
        } else {
          for (const idx of newCellIndices) {
            annotationCandidateSet.add(idx);
          }
        }
      } else if (mode === 'subtract') {
        // Ctrl+Alt = remove from existing
        if (annotationCandidateSet !== null) {
          for (const idx of newCellIndices) {
            annotationCandidateSet.delete(idx);
          }
        }
      }
    } else {
      // CONTINUOUS: Works like proximity drag
      // Alt = intersect, Shift+Alt = add, Ctrl+Alt = subtract
      if (annotationCandidateSet === null) {
        // First step: initialize candidate set (except subtract which does nothing)
        if (mode !== 'subtract') {
          annotationCandidateSet = new Set(newCellIndices);
        }
      } else if (mode === 'union') {
        // Shift+Alt = add to existing
        for (const idx of newCellIndices) {
          annotationCandidateSet.add(idx);
        }
      } else if (mode === 'subtract') {
        // Ctrl+Alt = remove from existing
        for (const idx of newCellIndices) {
          annotationCandidateSet.delete(idx);
        }
      } else {
        // Alt = intersect with existing
        annotationCandidateSet = new Set([...annotationCandidateSet].filter(idx => newSet.has(idx)));
      }
    }

    // Only count as a step if we have a valid candidate set (mirrors proximity behavior)
    if (annotationCandidateSet) {
      annotationStepCount++;

      // Update UI with step info
      updateAnnotationUI({
        step: annotationStepCount,
        candidateCount: annotationCandidateSet.size,
        mode: effectiveMode
      });

      // Update preview highlight (even if empty, to clear previous preview)
      if (annotationCandidateSet.size > 0) {
        state.setPreviewHighlightFromIndices?.([...annotationCandidateSet]);
      } else {
        // Clear preview when selection is empty
        state.clearPreviewHighlight?.();
      }
    }
  }

  // Handle final annotation selection (when confirmed)
  function handleAnnotationConfirm() {
    if (!annotationCandidateSet || annotationCandidateSet.size === 0) {
      console.log('[UI] Annotation selection empty');
      annotationCandidateSet = null;
      annotationStepCount = 0;
      annotationHistory = [];
      annotationRedoStack = [];
      updateAnnotationUI(null);
      return;
    }

    const cellIndices = [...annotationCandidateSet];
    const stepsLabel = annotationStepCount > 1 ? ` (${annotationStepCount} steps)` : '';

    state.addHighlightDirect({
      type: 'annotation',
      label: `Annotation${stepsLabel} (${cellIndices.length.toLocaleString()} cells)`,
      cellIndices: cellIndices
    });

    console.log(`[UI] Annotation selected ${cellIndices.length} cells from ${annotationStepCount} step(s)`);

    // Reset state
    annotationCandidateSet = null;
    annotationStepCount = 0;
    annotationHistory = [];
    annotationRedoStack = [];
    updateAnnotationUI(null);

    // Clear preview
    if (state.clearPreviewHighlight) {
      state.clearPreviewHighlight();
    }

    // Notify viewer
    viewer.confirmAnnotationSelection?.();
  }

  // Undo last annotation step
  function handleAnnotationUndo() {
    if (annotationHistory.length === 0) return;

    // Save current state to redo stack
    annotationRedoStack.push({
      candidates: annotationCandidateSet ? new Set(annotationCandidateSet) : null,
      step: annotationStepCount
    });

    // Restore previous state
    const prevState = annotationHistory.pop();
    annotationCandidateSet = prevState.candidates;
    annotationStepCount = prevState.step;

    // Update UI - keep controls visible if redo is available
    if (annotationCandidateSet && annotationCandidateSet.size > 0) {
      updateAnnotationUI({
        step: annotationStepCount,
        candidateCount: annotationCandidateSet.size,
        mode: 'intersect'
      });
      state.setPreviewHighlightFromIndices?.([...annotationCandidateSet]);
    } else {
      // Show "step 0" state but keep controls for redo
      updateAnnotationUI({
        step: 0,
        candidateCount: 0,
        mode: 'intersect',
        keepControls: true
      });
      state.clearPreviewHighlight?.();
    }
  }

  // Redo annotation step
  function handleAnnotationRedo() {
    if (annotationRedoStack.length === 0) return;

    // Save current state to history
    annotationHistory.push({
      candidates: annotationCandidateSet ? new Set(annotationCandidateSet) : null,
      step: annotationStepCount
    });

    // Restore redo state
    const redoState = annotationRedoStack.pop();
    annotationCandidateSet = redoState.candidates;
    annotationStepCount = redoState.step;

    // Update UI
    if (annotationCandidateSet && annotationCandidateSet.size > 0) {
      updateAnnotationUI({
        step: annotationStepCount,
        candidateCount: annotationCandidateSet.size,
        mode: 'intersect'
      });
      state.setPreviewHighlightFromIndices?.([...annotationCandidateSet]);
    } else {
      // Show "step 0" state but keep controls for undo
      updateAnnotationUI({
        step: 0,
        candidateCount: 0,
        mode: 'intersect',
        keepControls: true
      });
      state.clearPreviewHighlight?.();
    }
  }

  // Update annotation UI based on current state
  function updateAnnotationUI(stepEvent) {
    if (!highlightModeDescriptionEl) return;

    const activeField = state.getActiveField();
    const isCategorical = activeField?.kind === 'category';

    // Remove controls only if no stepEvent and not keeping controls for undo/redo
    if (!stepEvent || (stepEvent.step === 0 && !stepEvent.keepControls)) {
      // No selection in progress - show default description
      highlightModeDescriptionEl.innerHTML = highlightModeCopy.annotation;
      // Remove any existing controls
      const existingControls = document.getElementById('annotation-step-controls');
      if (existingControls) existingControls.remove();
    } else if (stepEvent.step === 0 && stepEvent.keepControls) {
      // Step 0 but keep controls visible for undo/redo
      const helpText = isCategorical
        ? 'Alt to replace, Shift+Alt to add, Ctrl+Alt to subtract'
        : 'Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract';
      const stepInfo = `<strong>No selection</strong><br><small>${helpText}</small>`;

      // Ensure controls exist
      let controls = document.getElementById('annotation-step-controls');
      if (!controls) {
        controls = document.createElement('div');
        controls.id = 'annotation-step-controls';
        controls.className = 'lasso-step-controls';
        controls.innerHTML = `
          <button type="button" class="btn-small lasso-confirm" id="annotation-confirm-btn">Confirm</button>
          <button type="button" class="btn-small btn-undo" id="annotation-undo-btn" title="Undo">↩</button>
          <button type="button" class="btn-small btn-redo" id="annotation-redo-btn" title="Redo">↪</button>
          <button type="button" class="btn-small lasso-cancel" id="annotation-cancel-btn">Cancel</button>
        `;
        highlightModeDescriptionEl.parentElement.appendChild(controls);

        document.getElementById('annotation-undo-btn').addEventListener('click', () => handleAnnotationUndo());
        document.getElementById('annotation-redo-btn').addEventListener('click', () => handleAnnotationRedo());
        document.getElementById('annotation-confirm-btn').addEventListener('click', () => handleAnnotationConfirm());
        document.getElementById('annotation-cancel-btn').addEventListener('click', () => viewer.cancelAnnotationSelection?.());
      }

      // Update button states
      const undoBtn = document.getElementById('annotation-undo-btn');
      const redoBtn = document.getElementById('annotation-redo-btn');
      const confirmBtn = document.getElementById('annotation-confirm-btn');
      if (undoBtn) undoBtn.disabled = annotationHistory.length === 0;
      if (redoBtn) redoBtn.disabled = annotationRedoStack.length === 0;
      if (confirmBtn) confirmBtn.disabled = true; // Can't confirm with no selection

      highlightModeDescriptionEl.innerHTML = stepInfo;
    } else {
      // Selection in progress - show step info and controls
      let modeLabel = '';
      if (stepEvent.mode === 'union') {
        modeLabel = ' <span class="lasso-mode-tag union">+added</span>';
      } else if (stepEvent.mode === 'subtract') {
        modeLabel = ' <span class="lasso-mode-tag subtract">−removed</span>';
      } else if (stepEvent.mode === 'replace') {
        // Categorical replace - only show label if not first step
        if (stepEvent.step > 1) {
          modeLabel = ' <span class="lasso-mode-tag intersect">replaced</span>';
        }
      } else if (stepEvent.step > 1) {
        // Continuous intersect
        modeLabel = ' <span class="lasso-mode-tag intersect">intersected</span>';
      }

      // Different help text for categorical vs continuous
      const helpText = isCategorical
        ? 'Alt to replace, Shift+Alt to add, Ctrl+Alt to subtract'
        : 'Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract';

      const stepInfo = `<strong>Step ${stepEvent.step}:</strong> ${stepEvent.candidateCount.toLocaleString()} cells${modeLabel}<br><small>${helpText}</small>`;

      // Check if controls already exist
      let controls = document.getElementById('annotation-step-controls');
      if (!controls) {
        controls = document.createElement('div');
        controls.id = 'annotation-step-controls';
        controls.className = 'lasso-step-controls'; // Reuse same styling
        controls.innerHTML = `
          <button type="button" class="btn-small lasso-confirm" id="annotation-confirm-btn">Confirm</button>
          <button type="button" class="btn-small btn-undo" id="annotation-undo-btn" title="Undo">↩</button>
          <button type="button" class="btn-small btn-redo" id="annotation-redo-btn" title="Redo">↪</button>
          <button type="button" class="btn-small lasso-cancel" id="annotation-cancel-btn">Cancel</button>
        `;
        highlightModeDescriptionEl.parentElement.appendChild(controls);

        // Wire up button events
        document.getElementById('annotation-undo-btn').addEventListener('click', () => {
          handleAnnotationUndo();
        });
        document.getElementById('annotation-redo-btn').addEventListener('click', () => {
          handleAnnotationRedo();
        });
        document.getElementById('annotation-confirm-btn').addEventListener('click', () => {
          handleAnnotationConfirm();
        });
        document.getElementById('annotation-cancel-btn').addEventListener('click', () => {
          // Mirror proximity pattern: call viewer cancel which sends cancelled event to handleAnnotationStep
          viewer.cancelAnnotationSelection?.();
        });
      }

      // Update undo/redo button states
      const undoBtn = document.getElementById('annotation-undo-btn');
      const redoBtn = document.getElementById('annotation-redo-btn');
      if (undoBtn) undoBtn.disabled = annotationHistory.length === 0;
      if (redoBtn) redoBtn.disabled = annotationRedoStack.length === 0;

      highlightModeDescriptionEl.innerHTML = stepInfo;
    }
  }

  // Wire up highlight callbacks
  if (state.addHighlightChangeCallback) {
    state.addHighlightChangeCallback(() => {
      renderHighlightSummary();
      renderHighlightPages(); // Update page tab counts
      // Update viewer with new highlight data
      if (viewer.updateHighlight && state.highlightArray) {
        viewer.updateHighlight(state.highlightArray);
      }
    });
  }

  // Wire up highlight page change callbacks
  if (state.addHighlightPageChangeCallback) {
    state.addHighlightPageChangeCallback(() => {
      renderHighlightPages();
      renderHighlightSummary();
    });
  }

  // LOD changes can hide/show highlighted cells without changing the selection itself.
  // Poll the current LOD level so the highlight summary stays accurate.
  if (viewer.getCurrentLODLevel && viewer.getLodVisibilityArray) {
    let lastHighlightLodLevel = viewer.getCurrentLODLevel();
    setInterval(() => {
      const currentLod = viewer.getCurrentLODLevel();
      if (currentLod === lastHighlightLodLevel) return;
      lastHighlightLodLevel = currentLod;
      // Only update when highlights exist to avoid extra DOM churn
      if ((state.getHighlightedGroups?.() || []).length > 0) {
        renderHighlightSummary();
      }
    }, 200);
  }

  // Initialize first highlight page if none exist
  if (state.ensureHighlightPage) {
    state.ensureHighlightPage();
    renderHighlightPages();
  }

  // Wire up add page button
  if (addHighlightPageBtn) {
    addHighlightPageBtn.addEventListener('click', () => {
      state.createHighlightPage();
      // Switch to the newly created page
      const pages = state.getHighlightPages();
      if (pages.length > 0) {
        const newPage = pages[pages.length - 1];
        state.switchToPage(newPage.id);
      }
    });
  }

  // Wire up annotation selection step callback
  if (viewer.setSelectionStepCallback) {
    viewer.setSelectionStepCallback(handleAnnotationStep);
  }

  // Track last lasso state for history
  let lastLassoCandidates = null;
  let lastLassoStep = 0;

  // Handle final lasso selection (after confirm)
  function handleLassoSelection(lassoEvent) {
    if (!lassoEvent.cellIndices || lassoEvent.cellIndices.length === 0) {
      console.log('[UI] Lasso selection empty');
      // Clear preview highlight since selection is empty
      state.clearPreviewHighlight?.();
      // Reset UI state and history
      lassoHistory = [];
      lassoRedoStack = [];
      lastLassoCandidates = null;
      lastLassoStep = 0;
      updateLassoUI(null);
      return;
    }

    // Add highlight directly with cell indices
    const stepsLabel = lassoEvent.steps > 1 ? ` (${lassoEvent.steps} views)` : '';
    const group = state.addHighlightDirect({
      type: 'lasso',
      label: `Lasso${stepsLabel} (${lassoEvent.cellCount.toLocaleString()} cells)`,
      cellIndices: lassoEvent.cellIndices
    });

    if (group) {
      console.log(`[UI] Lasso selected ${lassoEvent.cellCount} cells from ${lassoEvent.steps} view(s)`);
    }

    // Reset UI state and history
    lassoHistory = [];
    lassoRedoStack = [];
    lastLassoCandidates = null;
    lastLassoStep = 0;
    updateLassoUI(null);
  }

  // Handle lasso step updates (multi-step mode)
  function handleLassoStep(stepEvent) {
    if (stepEvent.cancelled) {
      // Selection was cancelled - clear history
      lassoHistory = [];
      lassoRedoStack = [];
      lastLassoCandidates = null;
      lastLassoStep = 0;
      updateLassoUI(null);
      // Clear preview highlight
      if (state.clearPreviewHighlight) {
        state.clearPreviewHighlight();
      }
      return;
    }

    // Save previous state to history before update
    if (lastLassoCandidates !== null || lastLassoStep > 0) {
      lassoHistory.push({
        candidates: lastLassoCandidates ? [...lastLassoCandidates] : null,
        step: lastLassoStep
      });
      if (lassoHistory.length > MAX_HISTORY_STEPS) {
        lassoHistory.shift();
      }
      lassoRedoStack = [];
    }

    // Track current state for next history save
    lastLassoCandidates = stepEvent.candidates ? [...stepEvent.candidates] : null;
    lastLassoStep = stepEvent.step;

    // Update UI with current step info
    updateLassoUI(stepEvent);

    // Show preview highlight of current candidates, or clear if empty
    if (stepEvent.candidates && stepEvent.candidates.length > 0) {
      state.setPreviewHighlightFromIndices?.(stepEvent.candidates);
    } else {
      // Selection is empty (e.g., after subtract) - clear the highlight
      state.clearPreviewHighlight?.();
    }
  }

  // Undo last lasso step
  function handleLassoUndo() {
    if (lassoHistory.length === 0) return;

    // Save current state to redo stack
    lassoRedoStack.push({
      candidates: lastLassoCandidates ? [...lastLassoCandidates] : null,
      step: lastLassoStep
    });

    // Restore previous state
    const prevState = lassoHistory.pop();
    lastLassoCandidates = prevState.candidates;
    lastLassoStep = prevState.step;

    // Update viewer state
    viewer.restoreLassoState?.(prevState.candidates, prevState.step);

    // Update UI - keep controls visible for redo
    if (prevState.candidates && prevState.candidates.length > 0) {
      updateLassoUI({
        step: prevState.step,
        candidateCount: prevState.candidates.length,
        candidates: prevState.candidates,
        mode: 'intersect'
      });
      state.setPreviewHighlightFromIndices?.(prevState.candidates);
    } else {
      updateLassoUI({ step: 0, candidateCount: 0, mode: 'intersect', keepControls: true });
      state.clearPreviewHighlight?.();
    }
  }

  // Redo lasso step
  function handleLassoRedo() {
    if (lassoRedoStack.length === 0) return;

    // Save current state to history
    lassoHistory.push({
      candidates: lastLassoCandidates ? [...lastLassoCandidates] : null,
      step: lastLassoStep
    });

    // Restore redo state
    const redoState = lassoRedoStack.pop();
    lastLassoCandidates = redoState.candidates;
    lastLassoStep = redoState.step;

    // Update viewer state
    viewer.restoreLassoState?.(redoState.candidates, redoState.step);

    // Update UI
    if (redoState.candidates && redoState.candidates.length > 0) {
      updateLassoUI({
        step: redoState.step,
        candidateCount: redoState.candidates.length,
        candidates: redoState.candidates,
        mode: 'intersect'
      });
      state.setPreviewHighlightFromIndices?.(redoState.candidates);
    } else {
      updateLassoUI({ step: 0, candidateCount: 0, mode: 'intersect', keepControls: true });
      state.clearPreviewHighlight?.();
    }
  }

  // Update lasso UI based on current state
  function updateLassoUI(stepEvent) {
    if (!highlightModeDescriptionEl) return;

    if (!stepEvent || (stepEvent.step === 0 && !stepEvent.keepControls)) {
      // No selection in progress - show default description
      highlightModeDescriptionEl.innerHTML = highlightModeCopy.lasso;
      // Remove any existing lasso controls
      const existingControls = document.getElementById('lasso-step-controls');
      if (existingControls) existingControls.remove();
    } else if (stepEvent.step === 0 && stepEvent.keepControls) {
      // Step 0 but keep controls visible for undo/redo
      const stepInfo = `<strong>No selection</strong><br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>`;

      let controls = document.getElementById('lasso-step-controls');
      if (!controls) {
        controls = document.createElement('div');
        controls.id = 'lasso-step-controls';
        controls.className = 'lasso-step-controls';
        controls.innerHTML = `
          <button type="button" class="btn-small lasso-confirm" id="lasso-confirm-btn">Confirm</button>
          <button type="button" class="btn-small btn-undo" id="lasso-undo-btn" title="Undo">↩</button>
          <button type="button" class="btn-small btn-redo" id="lasso-redo-btn" title="Redo">↪</button>
          <button type="button" class="btn-small lasso-cancel" id="lasso-cancel-btn">Cancel</button>
        `;
        highlightModeDescriptionEl.parentElement.appendChild(controls);

        document.getElementById('lasso-undo-btn').addEventListener('click', () => handleLassoUndo());
        document.getElementById('lasso-redo-btn').addEventListener('click', () => handleLassoRedo());
        document.getElementById('lasso-confirm-btn').addEventListener('click', () => {
          viewer.confirmLassoSelection?.();
          if (state.clearPreviewHighlight) state.clearPreviewHighlight();
        });
        document.getElementById('lasso-cancel-btn').addEventListener('click', () => viewer.cancelLassoSelection?.());
      }

      const undoBtn = document.getElementById('lasso-undo-btn');
      const redoBtn = document.getElementById('lasso-redo-btn');
      const confirmBtn = document.getElementById('lasso-confirm-btn');
      if (undoBtn) undoBtn.disabled = lassoHistory.length === 0;
      if (redoBtn) redoBtn.disabled = lassoRedoStack.length === 0;
      if (confirmBtn) confirmBtn.disabled = true;

      highlightModeDescriptionEl.innerHTML = stepInfo;
    } else {
      // Selection in progress - show step info and controls
      let modeLabel = '';
      if (stepEvent.mode === 'union') {
        modeLabel = ' <span class="lasso-mode-tag union">+added</span>';
      } else if (stepEvent.mode === 'subtract') {
        modeLabel = ' <span class="lasso-mode-tag subtract">−removed</span>';
      } else if (stepEvent.step > 1) {
        modeLabel = ' <span class="lasso-mode-tag intersect">intersected</span>';
      }
      const stepInfo = `<strong>Step ${stepEvent.step}:</strong> ${stepEvent.candidateCount.toLocaleString()} cells${modeLabel}<br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>`;

      // Check if controls already exist
      let controls = document.getElementById('lasso-step-controls');
      if (!controls) {
        controls = document.createElement('div');
        controls.id = 'lasso-step-controls';
        controls.className = 'lasso-step-controls';
        controls.innerHTML = `
          <button type="button" class="btn-small lasso-confirm" id="lasso-confirm-btn">Confirm</button>
          <button type="button" class="btn-small btn-undo" id="lasso-undo-btn" title="Undo">↩</button>
          <button type="button" class="btn-small btn-redo" id="lasso-redo-btn" title="Redo">↪</button>
          <button type="button" class="btn-small lasso-cancel" id="lasso-cancel-btn">Cancel</button>
        `;
        highlightModeDescriptionEl.parentElement.appendChild(controls);

        // Wire up button events
        document.getElementById('lasso-undo-btn').addEventListener('click', () => {
          handleLassoUndo();
        });
        document.getElementById('lasso-redo-btn').addEventListener('click', () => {
          handleLassoRedo();
        });
        document.getElementById('lasso-confirm-btn').addEventListener('click', () => {
          viewer.confirmLassoSelection?.();
          // Clear preview
          if (state.clearPreviewHighlight) {
            state.clearPreviewHighlight();
          }
        });
        document.getElementById('lasso-cancel-btn').addEventListener('click', () => {
          viewer.cancelLassoSelection?.();
        });
      }

      // Update undo/redo button states
      const undoBtn = document.getElementById('lasso-undo-btn');
      const redoBtn = document.getElementById('lasso-redo-btn');
      if (undoBtn) undoBtn.disabled = lassoHistory.length === 0;
      if (redoBtn) redoBtn.disabled = lassoRedoStack.length === 0;

      highlightModeDescriptionEl.innerHTML = stepInfo;
    }
  }

  // Wire up lasso callbacks
  if (viewer.setLassoCallback) {
    viewer.setLassoCallback(handleLassoSelection);
  }
  if (viewer.setLassoStepCallback) {
    viewer.setLassoStepCallback(handleLassoStep);
  }

  // === PROXIMITY DRAG HANDLERS ===

  // Track last proximity state for history
  let lastProximityCandidates = null;
  let lastProximityStep = 0;

  // Handle final proximity selection (when confirmed)
  function handleProximitySelection(proximityEvent) {
    if (!proximityEvent || !proximityEvent.cellIndices || proximityEvent.cellIndices.length === 0) {
      console.log('[UI] Proximity selection empty');
      // Clear preview highlight since selection is empty
      state.clearPreviewHighlight?.();
      // Reset UI state and history
      proximityHistory = [];
      proximityRedoStack = [];
      lastProximityCandidates = null;
      lastProximityStep = 0;
      updateProximityUI(null);
      return;
    }

    // Add highlight directly with cell indices (same as lasso)
    const stepsLabel = proximityEvent.steps > 1 ? ` (${proximityEvent.steps} drags)` : '';
    const group = state.addHighlightDirect({
      type: 'proximity',
      label: `Proximity${stepsLabel} (${proximityEvent.cellCount.toLocaleString()} cells)`,
      cellIndices: proximityEvent.cellIndices
    });

    if (group) {
      console.log(`[UI] Proximity selected ${proximityEvent.cellCount} cells from ${proximityEvent.steps} drag(s)`);
    }

    // Reset UI state and history
    proximityHistory = [];
    proximityRedoStack = [];
    lastProximityCandidates = null;
    lastProximityStep = 0;
    updateProximityUI(null);
  }

  // Handle proximity step updates (multi-step mode)
  function handleProximityStep(stepEvent) {
    if (stepEvent.cancelled) {
      // Selection was cancelled - clear history
      proximityHistory = [];
      proximityRedoStack = [];
      lastProximityCandidates = null;
      lastProximityStep = 0;
      updateProximityUI(null);
      // Clear preview highlight
      if (state.clearPreviewHighlight) {
        state.clearPreviewHighlight();
      }
      return;
    }

    // Save previous state to history before update
    if (lastProximityCandidates !== null || lastProximityStep > 0) {
      proximityHistory.push({
        candidates: lastProximityCandidates ? [...lastProximityCandidates] : null,
        step: lastProximityStep
      });
      if (proximityHistory.length > MAX_HISTORY_STEPS) {
        proximityHistory.shift();
      }
      proximityRedoStack = [];
    }

    // Track current state for next history save
    lastProximityCandidates = stepEvent.candidates ? [...stepEvent.candidates] : null;
    lastProximityStep = stepEvent.step;

    // Update UI with current step info
    updateProximityUI(stepEvent);

    // Show preview highlight of current candidates, or clear if empty
    if (stepEvent.candidates && stepEvent.candidates.length > 0) {
      state.setPreviewHighlightFromIndices?.(stepEvent.candidates);
    } else {
      // Selection is empty (e.g., after subtract) - clear the highlight
      state.clearPreviewHighlight?.();
    }
  }

  // Undo last proximity step
  function handleProximityUndo() {
    if (proximityHistory.length === 0) return;

    // Save current state to redo stack
    proximityRedoStack.push({
      candidates: lastProximityCandidates ? [...lastProximityCandidates] : null,
      step: lastProximityStep
    });

    // Restore previous state
    const prevState = proximityHistory.pop();
    lastProximityCandidates = prevState.candidates;
    lastProximityStep = prevState.step;

    // Update viewer state
    viewer.restoreProximityState?.(prevState.candidates, prevState.step);

    // Update UI - keep controls visible for redo
    if (prevState.candidates && prevState.candidates.length > 0) {
      updateProximityUI({
        step: prevState.step,
        candidateCount: prevState.candidates.length,
        candidates: prevState.candidates,
        mode: 'intersect'
      });
      state.setPreviewHighlightFromIndices?.(prevState.candidates);
    } else {
      updateProximityUI({ step: 0, candidateCount: 0, mode: 'intersect', keepControls: true });
      state.clearPreviewHighlight?.();
    }
  }

  // Redo proximity step
  function handleProximityRedo() {
    if (proximityRedoStack.length === 0) return;

    // Save current state to history
    proximityHistory.push({
      candidates: lastProximityCandidates ? [...lastProximityCandidates] : null,
      step: lastProximityStep
    });

    // Restore redo state
    const redoState = proximityRedoStack.pop();
    lastProximityCandidates = redoState.candidates;
    lastProximityStep = redoState.step;

    // Update viewer state
    viewer.restoreProximityState?.(redoState.candidates, redoState.step);

    // Update UI
    if (redoState.candidates && redoState.candidates.length > 0) {
      updateProximityUI({
        step: redoState.step,
        candidateCount: redoState.candidates.length,
        candidates: redoState.candidates,
        mode: 'intersect'
      });
      state.setPreviewHighlightFromIndices?.(redoState.candidates);
    } else {
      updateProximityUI({ step: 0, candidateCount: 0, mode: 'intersect', keepControls: true });
      state.clearPreviewHighlight?.();
    }
  }

  // Handle live preview during proximity drag
  function handleProximityPreview(previewEvent) {
    if (!previewEvent || !previewEvent.cellIndices) return;

    // Show preview highlight during drag, or clear if empty
    if (previewEvent.cellIndices.length > 0) {
      state.setPreviewHighlightFromIndices?.(previewEvent.cellIndices);
    } else {
      // Preview is empty (e.g., subtract mode with no overlap) - clear the highlight
      state.clearPreviewHighlight?.();
    }
  }

  // Update proximity UI based on current state
  function updateProximityUI(stepEvent) {
    if (!highlightModeDescriptionEl) return;

    if (!stepEvent || (stepEvent.step === 0 && !stepEvent.keepControls)) {
      // No selection in progress - show default description
      highlightModeDescriptionEl.innerHTML = highlightModeCopy.proximity;
      // Remove any existing proximity controls
      const existingControls = document.getElementById('proximity-step-controls');
      if (existingControls) existingControls.remove();
    } else if (stepEvent.step === 0 && stepEvent.keepControls) {
      // Step 0 but keep controls visible for undo/redo
      const stepInfo = `<strong>No selection</strong><br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>`;

      let controls = document.getElementById('proximity-step-controls');
      if (!controls) {
        controls = document.createElement('div');
        controls.id = 'proximity-step-controls';
        controls.className = 'lasso-step-controls';
        controls.innerHTML = `
          <button type="button" class="btn-small lasso-confirm" id="proximity-confirm-btn">Confirm</button>
          <button type="button" class="btn-small btn-undo" id="proximity-undo-btn" title="Undo">↩</button>
          <button type="button" class="btn-small btn-redo" id="proximity-redo-btn" title="Redo">↪</button>
          <button type="button" class="btn-small lasso-cancel" id="proximity-cancel-btn">Cancel</button>
        `;
        highlightModeDescriptionEl.parentElement.appendChild(controls);

        document.getElementById('proximity-undo-btn').addEventListener('click', () => handleProximityUndo());
        document.getElementById('proximity-redo-btn').addEventListener('click', () => handleProximityRedo());
        document.getElementById('proximity-confirm-btn').addEventListener('click', () => {
          viewer.confirmProximitySelection?.();
          if (state.clearPreviewHighlight) state.clearPreviewHighlight();
        });
        document.getElementById('proximity-cancel-btn').addEventListener('click', () => viewer.cancelProximitySelection?.());
      }

      const undoBtn = document.getElementById('proximity-undo-btn');
      const redoBtn = document.getElementById('proximity-redo-btn');
      const confirmBtn = document.getElementById('proximity-confirm-btn');
      if (undoBtn) undoBtn.disabled = proximityHistory.length === 0;
      if (redoBtn) redoBtn.disabled = proximityRedoStack.length === 0;
      if (confirmBtn) confirmBtn.disabled = true;

      highlightModeDescriptionEl.innerHTML = stepInfo;
    } else {
      // Selection in progress - show step info and controls
      let modeLabel = '';
      if (stepEvent.mode === 'union') {
        modeLabel = ' <span class="lasso-mode-tag union">+added</span>';
      } else if (stepEvent.mode === 'subtract') {
        modeLabel = ' <span class="lasso-mode-tag subtract">−removed</span>';
      } else if (stepEvent.step > 1) {
        modeLabel = ' <span class="lasso-mode-tag intersect">intersected</span>';
      }
      const stepInfo = `<strong>Step ${stepEvent.step}:</strong> ${stepEvent.candidateCount.toLocaleString()} cells${modeLabel}<br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>`;

      // Check if controls already exist
      let controls = document.getElementById('proximity-step-controls');
      if (!controls) {
        controls = document.createElement('div');
        controls.id = 'proximity-step-controls';
        controls.className = 'lasso-step-controls'; // Reuse same styling
        controls.innerHTML = `
          <button type="button" class="btn-small lasso-confirm" id="proximity-confirm-btn">Confirm</button>
          <button type="button" class="btn-small btn-undo" id="proximity-undo-btn" title="Undo">↩</button>
          <button type="button" class="btn-small btn-redo" id="proximity-redo-btn" title="Redo">↪</button>
          <button type="button" class="btn-small lasso-cancel" id="proximity-cancel-btn">Cancel</button>
        `;
        highlightModeDescriptionEl.parentElement.appendChild(controls);

        // Wire up button events
        document.getElementById('proximity-undo-btn').addEventListener('click', () => {
          handleProximityUndo();
        });
        document.getElementById('proximity-redo-btn').addEventListener('click', () => {
          handleProximityRedo();
        });
        document.getElementById('proximity-confirm-btn').addEventListener('click', () => {
          viewer.confirmProximitySelection?.();
          // Clear preview
          if (state.clearPreviewHighlight) {
            state.clearPreviewHighlight();
          }
        });
        document.getElementById('proximity-cancel-btn').addEventListener('click', () => {
          viewer.cancelProximitySelection?.();
        });
      }

      // Update undo/redo button states
      const undoBtn = document.getElementById('proximity-undo-btn');
      const redoBtn = document.getElementById('proximity-redo-btn');
      if (undoBtn) undoBtn.disabled = proximityHistory.length === 0;
      if (redoBtn) redoBtn.disabled = proximityRedoStack.length === 0;

      highlightModeDescriptionEl.innerHTML = stepInfo;
    }
  }

  // Wire up proximity callbacks
  if (viewer.setProximityCallback) {
    viewer.setProximityCallback(handleProximitySelection);
  }
  if (viewer.setProximityStepCallback) {
    viewer.setProximityStepCallback(handleProximityStep);
  }
  if (viewer.setProximityPreviewCallback) {
    viewer.setProximityPreviewCallback(handleProximityPreview);
  }

  // === KNN DRAG HANDLERS ===

  // Track last KNN state for history
  let lastKnnCandidates = null;
  let lastKnnStep = 0;

  // Handle final KNN selection (when confirmed)
  function handleKnnSelection(knnEvent) {
    if (!knnEvent || !knnEvent.cellIndices || knnEvent.cellIndices.length === 0) {
      console.log('[UI] KNN selection empty');
      // Clear preview highlight since selection is empty
      state.clearPreviewHighlight?.();
      // Reset UI state and history
      knnHistory = [];
      knnRedoStack = [];
      lastKnnCandidates = null;
      lastKnnStep = 0;
      updateKnnUI(null);
      return;
    }

    // Add highlight directly with cell indices (same as lasso/proximity)
    const stepsLabel = knnEvent.steps > 1 ? ` (${knnEvent.steps} selections)` : '';
    const group = state.addHighlightDirect({
      type: 'knn',
      label: `KNN${stepsLabel} (${knnEvent.cellCount.toLocaleString()} cells)`,
      cellIndices: knnEvent.cellIndices
    });

    if (group) {
      console.log(`[UI] KNN selected ${knnEvent.cellCount} cells from ${knnEvent.steps} selection(s)`);
    }

    // Reset UI state and history
    knnHistory = [];
    knnRedoStack = [];
    lastKnnCandidates = null;
    lastKnnStep = 0;
    updateKnnUI(null);
  }

  // Handle KNN step updates (multi-step mode)
  function handleKnnStep(stepEvent) {
    if (stepEvent.cancelled) {
      // Selection was cancelled - clear history
      knnHistory = [];
      knnRedoStack = [];
      lastKnnCandidates = null;
      lastKnnStep = 0;
      updateKnnUI(null);
      // Clear preview highlight
      if (state.clearPreviewHighlight) {
        state.clearPreviewHighlight();
      }
      return;
    }

    // Save previous state to history before update
    if (lastKnnCandidates !== null || lastKnnStep > 0) {
      knnHistory.push({
        candidates: lastKnnCandidates ? [...lastKnnCandidates] : null,
        step: lastKnnStep
      });
      if (knnHistory.length > MAX_HISTORY_STEPS) {
        knnHistory.shift();
      }
      knnRedoStack = [];
    }

    // Track current state for next history save
    lastKnnCandidates = stepEvent.candidates ? [...stepEvent.candidates] : null;
    lastKnnStep = stepEvent.step;

    // Update UI with current step info
    updateKnnUI(stepEvent);

    // Show preview highlight of current candidates, or clear if empty
    if (stepEvent.candidates && stepEvent.candidates.length > 0) {
      state.setPreviewHighlightFromIndices?.(stepEvent.candidates);
    } else {
      // Selection is empty (e.g., after subtract) - clear the highlight
      state.clearPreviewHighlight?.();
    }
  }

  // Undo last KNN step
  function handleKnnUndo() {
    if (knnHistory.length === 0) return;

    // Save current state to redo stack
    knnRedoStack.push({
      candidates: lastKnnCandidates ? [...lastKnnCandidates] : null,
      step: lastKnnStep
    });

    // Restore previous state
    const prevState = knnHistory.pop();
    lastKnnCandidates = prevState.candidates;
    lastKnnStep = prevState.step;

    // Update viewer state
    viewer.restoreKnnState?.(prevState.candidates, prevState.step);

    // Update UI - keep controls visible for redo
    if (prevState.candidates && prevState.candidates.length > 0) {
      updateKnnUI({
        step: prevState.step,
        candidateCount: prevState.candidates.length,
        candidates: prevState.candidates,
        mode: 'intersect',
        degree: 0
      });
      state.setPreviewHighlightFromIndices?.(prevState.candidates);
    } else {
      updateKnnUI({ step: 0, candidateCount: 0, mode: 'intersect', degree: 0, keepControls: true });
      state.clearPreviewHighlight?.();
    }
  }

  // Redo KNN step
  function handleKnnRedo() {
    if (knnRedoStack.length === 0) return;

    // Save current state to history
    knnHistory.push({
      candidates: lastKnnCandidates ? [...lastKnnCandidates] : null,
      step: lastKnnStep
    });

    // Restore redo state
    const redoState = knnRedoStack.pop();
    lastKnnCandidates = redoState.candidates;
    lastKnnStep = redoState.step;

    // Update viewer state
    viewer.restoreKnnState?.(redoState.candidates, redoState.step);

    // Update UI
    if (redoState.candidates && redoState.candidates.length > 0) {
      updateKnnUI({
        step: redoState.step,
        candidateCount: redoState.candidates.length,
        candidates: redoState.candidates,
        mode: 'intersect',
        degree: 0
      });
      state.setPreviewHighlightFromIndices?.(redoState.candidates);
    } else {
      updateKnnUI({ step: 0, candidateCount: 0, mode: 'intersect', degree: 0, keepControls: true });
      state.clearPreviewHighlight?.();
    }
  }

  // Handle live preview during KNN drag
  function handleKnnPreview(previewEvent) {
    if (!previewEvent || !previewEvent.cellIndices) return;

    // Show preview highlight during drag, or clear if empty
    if (previewEvent.cellIndices.length > 0) {
      state.setPreviewHighlightFromIndices?.(previewEvent.cellIndices);
    } else {
      // Preview is empty (e.g., subtract mode with no overlap) - clear the highlight
      state.clearPreviewHighlight?.();
    }
  }

  // Update KNN UI based on current state
  function updateKnnUI(stepEvent) {
    if (!highlightModeDescriptionEl) return;

    if (!stepEvent || (stepEvent.step === 0 && !stepEvent.keepControls)) {
      // No selection in progress - show default description
      highlightModeDescriptionEl.innerHTML = highlightModeCopy.knn;
      // Remove any existing KNN controls
      const existingControls = document.getElementById('knn-step-controls');
      if (existingControls) existingControls.remove();
    } else if (stepEvent.step === 0 && stepEvent.keepControls) {
      // Step 0 but keep controls visible for undo/redo
      const stepInfo = `<strong>No selection</strong><br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>`;

      let controls = document.getElementById('knn-step-controls');
      if (!controls) {
        controls = document.createElement('div');
        controls.id = 'knn-step-controls';
        controls.className = 'lasso-step-controls';
        controls.innerHTML = `
          <button type="button" class="btn-small lasso-confirm" id="knn-confirm-btn">Confirm</button>
          <button type="button" class="btn-small btn-undo" id="knn-undo-btn" title="Undo">↩</button>
          <button type="button" class="btn-small btn-redo" id="knn-redo-btn" title="Redo">↪</button>
          <button type="button" class="btn-small lasso-cancel" id="knn-cancel-btn">Cancel</button>
        `;
        highlightModeDescriptionEl.parentElement.appendChild(controls);

        document.getElementById('knn-undo-btn').addEventListener('click', () => handleKnnUndo());
        document.getElementById('knn-redo-btn').addEventListener('click', () => handleKnnRedo());
        document.getElementById('knn-confirm-btn').addEventListener('click', () => {
          viewer.confirmKnnSelection?.();
          if (state.clearPreviewHighlight) state.clearPreviewHighlight();
        });
        document.getElementById('knn-cancel-btn').addEventListener('click', () => viewer.cancelKnnSelection?.());
      }

      const undoBtn = document.getElementById('knn-undo-btn');
      const redoBtn = document.getElementById('knn-redo-btn');
      const confirmBtn = document.getElementById('knn-confirm-btn');
      if (undoBtn) undoBtn.disabled = knnHistory.length === 0;
      if (redoBtn) redoBtn.disabled = knnRedoStack.length === 0;
      if (confirmBtn) confirmBtn.disabled = true;

      highlightModeDescriptionEl.innerHTML = stepInfo;
    } else {
      // Selection in progress - show step info and controls
      let modeLabel = '';
      if (stepEvent.mode === 'union') {
        modeLabel = ' <span class="lasso-mode-tag union">+added</span>';
      } else if (stepEvent.mode === 'subtract') {
        modeLabel = ' <span class="lasso-mode-tag subtract">−removed</span>';
      } else if (stepEvent.step > 1) {
        modeLabel = ' <span class="lasso-mode-tag intersect">intersected</span>';
      }
      const degreeLabel = stepEvent.degree === 0 ? 'seed only' : `${stepEvent.degree}° neighbors`;
      const stepInfo = `<strong>Step ${stepEvent.step}:</strong> ${stepEvent.candidateCount.toLocaleString()} cells (${degreeLabel})${modeLabel}<br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>`;

      // Check if controls already exist
      let controls = document.getElementById('knn-step-controls');
      if (!controls) {
        controls = document.createElement('div');
        controls.id = 'knn-step-controls';
        controls.className = 'lasso-step-controls'; // Reuse same styling
        controls.innerHTML = `
          <button type="button" class="btn-small lasso-confirm" id="knn-confirm-btn">Confirm</button>
          <button type="button" class="btn-small btn-undo" id="knn-undo-btn" title="Undo">↩</button>
          <button type="button" class="btn-small btn-redo" id="knn-redo-btn" title="Redo">↪</button>
          <button type="button" class="btn-small lasso-cancel" id="knn-cancel-btn">Cancel</button>
        `;
        highlightModeDescriptionEl.parentElement.appendChild(controls);

        // Wire up button events
        document.getElementById('knn-undo-btn').addEventListener('click', () => {
          handleKnnUndo();
        });
        document.getElementById('knn-redo-btn').addEventListener('click', () => {
          handleKnnRedo();
        });
        document.getElementById('knn-confirm-btn').addEventListener('click', () => {
          viewer.confirmKnnSelection?.();
          // Clear preview
          if (state.clearPreviewHighlight) {
            state.clearPreviewHighlight();
          }
        });
        document.getElementById('knn-cancel-btn').addEventListener('click', () => {
          viewer.cancelKnnSelection?.();
        });
      }

      // Update undo/redo button states
      const undoBtn = document.getElementById('knn-undo-btn');
      const redoBtn = document.getElementById('knn-redo-btn');
      if (undoBtn) undoBtn.disabled = knnHistory.length === 0;
      if (redoBtn) redoBtn.disabled = knnRedoStack.length === 0;

      highlightModeDescriptionEl.innerHTML = stepInfo;
    }
  }

  // Wire up KNN callbacks
  if (viewer.setKnnCallback) {
    viewer.setKnnCallback(handleKnnSelection);
  }
  if (viewer.setKnnStepCallback) {
    viewer.setKnnStepCallback(handleKnnStep);
  }
  if (viewer.setKnnPreviewCallback) {
    viewer.setKnnPreviewCallback(handleKnnPreview);
  }

  // Handle preview during continuous drag
  function handleSelectionPreview(previewEvent) {
    const activeField = state.getActiveField ? state.getActiveField() : null;
    if (!activeField || activeField.kind !== 'continuous') {
      hideRangeLabel();
      return;
    }

    const fieldIndex = state.activeFieldSource === 'var'
      ? state.activeVarFieldIndex
      : state.activeFieldIndex;
    const source = state.activeFieldSource || 'obs';

    const cellIndex = previewEvent.cellIndex;
    const clickedValue = state.getValueForCell(cellIndex, fieldIndex, source);
    if (clickedValue == null) {
      hideRangeLabel();
      return;
    }

    const stats = activeField._continuousStats || { min: 0, max: 1 };
    const valueRange = stats.max - stats.min;
    const dragScale = 0.005;
    const dragAmount = -previewEvent.dragDeltaY * dragScale * valueRange;

    let minVal, maxVal;
    if (dragAmount > 0) {
      minVal = clickedValue;
      maxVal = Math.min(stats.max, clickedValue + dragAmount);
    } else {
      minVal = Math.max(stats.min, clickedValue + dragAmount);
      maxVal = clickedValue;
    }

    // Get new cell indices for the current drag range
    const newIndices = state.getCellIndicesForRange(fieldIndex, minVal, maxVal, source);
    const mode = previewEvent.mode || 'intersect';

    // Compute combined preview based on mode and existing candidates (mirrors proximity behavior)
    let combinedIndices;
    if (annotationCandidateSet === null) {
      // First step - no selection started yet
      if (mode === 'subtract') {
        // Subtract from nothing = empty (can't remove from nothing)
        combinedIndices = [];
      } else {
        // Union or intersect starts fresh selection
        combinedIndices = newIndices;
      }
    } else if (annotationCandidateSet.size === 0) {
      // Selection exists but is empty (e.g., after operations that removed all cells)
      if (mode === 'union') {
        // Union with empty = new indices
        combinedIndices = newIndices;
      } else {
        // Intersect or subtract with empty = empty (intersection/subtraction with nothing is nothing)
        combinedIndices = [];
      }
    } else if (mode === 'union') {
      // Union: show existing + new
      const combined = new Set(annotationCandidateSet);
      for (const idx of newIndices) combined.add(idx);
      combinedIndices = [...combined];
    } else if (mode === 'subtract') {
      // Subtract: show existing minus new
      const newSet = new Set(newIndices);
      combinedIndices = [...annotationCandidateSet].filter(idx => !newSet.has(idx));
    } else {
      // Intersect: show intersection of existing and new
      const newSet = new Set(newIndices);
      combinedIndices = [...annotationCandidateSet].filter(idx => newSet.has(idx));
    }

    // Update preview highlighting with combined result
    if (state.setPreviewHighlightFromIndices && combinedIndices.length > 0) {
      state.setPreviewHighlightFromIndices(combinedIndices);
    } else if (state.clearPreviewHighlight) {
      state.clearPreviewHighlight();
    }

    // Show range label next to cursor
    showRangeLabel(previewEvent.endX, previewEvent.endY, minVal, maxVal);
  }

  // Wire up selection preview callback
  if (viewer.setSelectionPreviewCallback) {
    viewer.setSelectionPreviewCallback(handleSelectionPreview);
  }

  // Update highlight mode based on active field
  function updateHighlightMode() {
    if (!viewer.setHighlightMode) return;
    const activeField = state.getActiveField ? state.getActiveField() : null;
    if (!activeField) {
      viewer.setHighlightMode('none');
    } else if (activeField.kind === 'continuous') {
      viewer.setHighlightMode('continuous');
    } else if (activeField.kind === 'category') {
      viewer.setHighlightMode('categorical');
    } else {
      viewer.setHighlightMode('none');
    }
  }

  initHighlightModeButtons();

  // Wire up clear all button
  if (clearAllHighlightsBtn) {
    clearAllHighlightsBtn.addEventListener('click', () => {
      state.clearAllHighlights();
    });
  }

  function getFieldsByKind(kind) {
    const fields = state.getFields();
    const filtered = [];
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (!field) continue;
      const isContinuous = field.kind === 'continuous';
      const isCategory = !isContinuous;
      if (kind === 'continuous' ? isContinuous : isCategory) {
        filtered.push({ field, idx: i });
      }
    }
    return filtered;
  }

  function updateFieldSelectDisabledStates() {
    categoricalFieldSelect.disabled = forceDisableFieldSelects || !hasCategoricalFields;
    continuousFieldSelect.disabled = forceDisableFieldSelects || !hasContinuousFields;
  }

  function renderFieldSelects() {
    const fields = state.getFields();
    const categoricalFields = getFieldsByKind('category');
    const continuousFields = getFieldsByKind('continuous');
    hasCategoricalFields = categoricalFields.length > 0;
    hasContinuousFields = continuousFields.length > 0;

    function populateSelect(select, entries, emptyLabel) {
      select.innerHTML = '';
      const noneOption = document.createElement('option');
      noneOption.value = NONE_FIELD_VALUE;
      noneOption.textContent = entries.length ? 'None' : emptyLabel;
      select.appendChild(noneOption);
      entries.forEach(({ field, idx }) => {
        const opt = document.createElement('option');
        opt.value = String(idx);
        opt.textContent = field.key;
        select.appendChild(opt);
      });
      select.value = NONE_FIELD_VALUE;
    }

    populateSelect(categoricalFieldSelect, categoricalFields, '(no categorical obs fields)');
    populateSelect(continuousFieldSelect, continuousFields, '(no continuous obs fields)');
    updateFieldSelectDisabledStates();
    if (!fields.length) {
      legendEl.textContent = 'No obs fields exported.';
    }
  }

  // Gene expression dropdown functions
  function initGeneExpressionDropdown() {
    const varFields = state.getVarFields();
    console.log('[UI] initGeneExpressionDropdown: varFields.length =', varFields.length, 'container =', !!geneExpressionContainer);
    geneFieldList = varFields.map((field, idx) => ({ field, idx }));
    hasGeneExpressionFields = geneFieldList.length > 0;

    if (hasGeneExpressionFields && geneExpressionContainer) {
      geneExpressionContainer.classList.add('visible');
      console.log('[UI] Gene expression container shown');
    } else if (geneExpressionContainer) {
      geneExpressionContainer.classList.remove('visible');
      console.log('[UI] Gene expression container hidden (no var fields)');
    }
  }

  function renderGeneDropdownResults(query) {
    if (!geneExpressionDropdown) return;
    geneExpressionDropdown.innerHTML = '';
    
    const lowerQuery = (query || '').toLowerCase().trim();
    let filtered = geneFieldList;
    
    if (lowerQuery) {
      filtered = geneFieldList.filter(({ field }) => 
        field.key.toLowerCase().includes(lowerQuery)
      );
    }
    
    const maxResults = 100;
    const toShow = filtered.slice(0, maxResults);
    
    if (toShow.length === 0) {
      const noResults = document.createElement('div');
      noResults.className = 'dropdown-no-results';
      noResults.textContent = lowerQuery ? 'No genes found' : 'Type to search genes...';
      geneExpressionDropdown.appendChild(noResults);
      return;
    }
    
    toShow.forEach(({ field, idx }) => {
      const item = document.createElement('div');
      item.className = 'dropdown-item';
      if (idx === selectedGeneIndex) {
        item.classList.add('selected');
      }
      item.textContent = field.key;
      item.dataset.index = idx;
      item.addEventListener('click', () => selectGene(idx));
      geneExpressionDropdown.appendChild(item);
    });
    
    if (filtered.length > maxResults) {
      const moreMsg = document.createElement('div');
      moreMsg.className = 'dropdown-no-results';
      moreMsg.textContent = `...and ${filtered.length - maxResults} more. Type to narrow results.`;
      geneExpressionDropdown.appendChild(moreMsg);
    }
  }

  function showGeneDropdown() {
    if (!geneExpressionDropdown) return;
    renderGeneDropdownResults(geneExpressionSearch?.value || '');
    geneExpressionDropdown.classList.add('visible');
  }

  function hideGeneDropdown() {
    if (!geneExpressionDropdown) return;
    geneExpressionDropdown.classList.remove('visible');
  }

  function updateSelectedGeneDisplay() {
    if (!geneExpressionSelected) return;
    
    if (selectedGeneIndex >= 0) {
      const field = geneFieldList[selectedGeneIndex]?.field;
      if (field) {
        geneExpressionSelected.innerHTML = '';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = field.key;
        const clearBtn = document.createElement('button');
        clearBtn.className = 'clear-btn';
        clearBtn.textContent = '✕';
        clearBtn.title = 'Clear selection';
        clearBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          clearGeneSelection();
        });
        geneExpressionSelected.appendChild(nameSpan);
        geneExpressionSelected.appendChild(clearBtn);
        geneExpressionSelected.classList.add('visible');
      }
    } else {
      geneExpressionSelected.classList.remove('visible');
    }
  }

  async function selectGene(idx) {
    if (idx < 0 || idx >= geneFieldList.length) return;
    
    const field = geneFieldList[idx].field;
    const originalIdx = geneFieldList[idx].idx;

    hideGeneDropdown();
    selectedGeneIndex = idx;
    
    categoricalFieldSelect.value = NONE_FIELD_VALUE;
    continuousFieldSelect.value = NONE_FIELD_VALUE;
    
    if (geneExpressionSearch) {
      geneExpressionSearch.value = field.key || '';
    }
    
    updateSelectedGeneDisplay();
    
    try {
      forceDisableFieldSelects = true;
      updateFieldSelectDisabledStates();
      statsEl.textContent = `Loading ${field.key}…`;
      
      if (state.ensureVarFieldLoaded) {
        await state.ensureVarFieldLoaded(originalIdx);
      }
      
      const info = state.setActiveVarField(originalIdx);
      renderLegend(state.getActiveField());
      handleOutlierUI(null);
      renderFilterSummary();
      updateStats(info);
      markSmokeDirty(); // gene filters affect visibility
    } catch (err) {
      console.error(err);
      statsEl.textContent = 'Error: ' + err.message;
    } finally {
      forceDisableFieldSelects = false;
      updateFieldSelectDisabledStates();
    }
  }

  function clearGeneSelection() {
    selectedGeneIndex = -1;
    updateSelectedGeneDisplay();
    if (geneExpressionSearch) {
      geneExpressionSearch.value = '';
    }
    activateField(-1);
  }

  function formatCategoryCount(visibleCount, availableCount) {
    const visible = Number.isFinite(visibleCount) ? visibleCount : 0;
    const available = Number.isFinite(availableCount) ? availableCount : visible;
    if (available > 0 && available !== visible) {
      return `${visible.toLocaleString()} / ${available.toLocaleString()} cells`;
    }
    return `${visible.toLocaleString()} cells`;
  }

  function refreshLegendCategoryCounts() {
    const activeField = state.getActiveField ? state.getActiveField() : null;
    if (!activeField || activeField.kind !== 'category') return;
    const model = state.getLegendModel(activeField);
    const counts = model?.counts;
    if (!counts || !legendEl) return;
    const visibleList = counts.visible || [];
    const availableList = counts.available || [];
    const rows = legendEl.querySelectorAll('.legend-item[data-cat-index]');
    rows.forEach((row) => {
      const idx = parseInt(row.dataset.catIndex, 10);
      if (Number.isNaN(idx)) return;
      const visible = visibleList[idx] || 0;
      const available = availableList[idx] || 0;
      const hasCells = available > 0;
      row.classList.toggle('legend-item-disabled', !hasCells);
      row.title = hasCells ? '' : 'No cells available in this category after other filters';
      const checkbox = row.querySelector('.legend-checkbox');
      if (checkbox) checkbox.disabled = !hasCells;
      const colorInput = row.querySelector('.legend-color-input');
      if (colorInput) colorInput.disabled = !hasCells;
      const countSpan = row.querySelector('.legend-count');
      if (countSpan) countSpan.textContent = formatCategoryCount(visible, available);
    });
  }

  function renderLegend(field) {
    setDisplayOptionsVisibility(field);
    legendEl.innerHTML = '';
    if (!field) return;
    const model = state.getLegendModel(field);
    if (!model) return;

    // Compact number formatter: keeps width ~5 chars, uses short sci notation
    function formatLegendNumber(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) return '—';
      if (value === 0) return '0';
      const abs = Math.abs(value);
      const sign = value < 0 ? '-' : '';
      // Use scientific notation for large/small numbers
      if (abs >= 10000 || (abs > 0 && abs < 0.01)) {
        const exp = Math.floor(Math.log10(abs));
        const mantissa = abs / Math.pow(10, exp);
        // Format mantissa compactly
        const m = mantissa < 10 ? mantissa.toFixed(1).replace(/\.0$/, '') : Math.round(mantissa);
        return `${sign}${m}e${exp}`;
      }
      // Regular numbers
      if (abs >= 100) return sign + abs.toFixed(0);
      if (abs >= 10) return sign + abs.toFixed(1);
      return sign + abs.toFixed(2);
    }

    if (model.kind === 'continuous') {
      const colorSection = document.createElement('div');
      colorSection.className = 'legend-section';
      const colorHeader = document.createElement('div');
      colorHeader.className = 'legend-section-title';
      const colormapLabel = model.colormap?.label || 'Viridis';
      colorHeader.textContent = `Color scale (${colormapLabel})`;

      const colorBarWrapper = document.createElement('div');
      colorBarWrapper.className = 'colorbar-wrapper';

      const gradientBar = document.createElement('button');
      gradientBar.type = 'button';
      gradientBar.className = 'colorbar-gradient';
      gradientBar.style.backgroundImage = 'linear-gradient(to right, ' + model.colorStops.join(', ') + ')';
      gradientBar.title = 'Click to change color palette';

      const colormapMenu = document.createElement('div');
      colormapMenu.className = 'colormap-menu';
      const colormapOptions = state.getContinuousColormaps ? state.getContinuousColormaps() : [];
      function renderColormapMenu() {
        const activeId = model.colormap?.id;
        colormapMenu.innerHTML = '';
        colormapOptions.forEach((cm) => {
          const option = document.createElement('button');
          option.type = 'button';
          option.className = 'colormap-option' + (cm.id === activeId ? ' active' : '');
          const preview = document.createElement('div');
          preview.className = 'colormap-preview';
          preview.style.backgroundImage = 'linear-gradient(to right, ' + cm.cssStops.join(', ') + ')';
          const name = document.createElement('span');
          name.className = 'colormap-name';
          name.textContent = cm.label;
          option.appendChild(preview);
          option.appendChild(name);
          option.addEventListener('click', (e) => {
            e.stopPropagation();
            colormapMenu.classList.remove('visible');
            if (cm.id !== activeId) {
              state.setContinuousColormap(state.activeFieldIndex, cm.id);
              renderLegend(state.getActiveField());
              markSmokeDirty();
            }
          });
          colormapMenu.appendChild(option);
        });
      }
      renderColormapMenu();

      function closeColormapMenu() {
        colormapMenu.classList.remove('visible');
      }
      function handleOutsideClick(evt) {
        if (!colorBarWrapper.contains(evt.target)) closeColormapMenu();
      }

      gradientBar.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = !colormapMenu.classList.contains('visible');
        if (willOpen) {
          colormapMenu.classList.add('visible');
          document.addEventListener('click', handleOutsideClick, { once: true });
        } else {
          closeColormapMenu();
        }
      });
      colormapMenu.addEventListener('click', (e) => e.stopPropagation());

      colorBarWrapper.appendChild(gradientBar);
      colorBarWrapper.appendChild(colormapMenu);

      const minMaxRow = document.createElement('div');
      minMaxRow.style.display = 'flex';
      minMaxRow.style.justifyContent = 'space-between';
      minMaxRow.style.fontSize = '10px';
      minMaxRow.style.marginTop = '2px';

      const colorbarMin = model.colorbar?.min ?? model.stats.min;
      const colorbarMax = model.colorbar?.max ?? model.stats.max;
      const minSpan = document.createElement('span');
      minSpan.textContent = formatLegendNumber(colorbarMin);
      const maxSpan = document.createElement('span');
      maxSpan.textContent = formatLegendNumber(colorbarMax);
      minMaxRow.appendChild(minSpan);
      minMaxRow.appendChild(maxSpan);

      const logRow = document.createElement('div');
      logRow.className = 'legend-toggle-row';
      const logLabel = document.createElement('span');
      logLabel.className = 'legend-toggle-label';
      logLabel.textContent = 'Log color scale';
      const logToggle = document.createElement('button');
      logToggle.type = 'button';
      logToggle.className = 'toggle-switch';
      logRow.appendChild(logLabel);
      logRow.appendChild(logToggle);

      const logHint = document.createElement('div');
      logHint.className = 'legend-help';
      logHint.textContent = 'Zero/negative/NaN values use the None color';

      const rescaleRow = document.createElement('div');
      rescaleRow.className = 'legend-toggle-row';
      const rescaleLabel = document.createElement('span');
      rescaleLabel.className = 'legend-toggle-label';
      rescaleLabel.textContent = 'Rescale colorbar to slider range';
      const rescaleToggle = document.createElement('button');
      rescaleToggle.type = 'button';
      rescaleToggle.className = 'toggle-switch';
      rescaleRow.appendChild(rescaleLabel);
      rescaleRow.appendChild(rescaleToggle);

      function setRescaleToggle(enabled) {
        rescaleToggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        rescaleToggle.textContent = enabled ? 'On' : 'Off';
      }

      function refreshColorbarLabels() {
        const activeModel = state.getLegendModel(state.getActiveField());
        if (!activeModel || activeModel.kind !== 'continuous') return;
        const cMin = activeModel.colorbar?.min ?? activeModel.stats.min;
        const cMax = activeModel.colorbar?.max ?? activeModel.stats.max;
        minSpan.textContent = formatLegendNumber(cMin);
        maxSpan.textContent = formatLegendNumber(cMax);
        const isLog = activeModel.colorbar?.scale === 'log' || activeModel.logEnabled;
        colorHeader.textContent = `Color scale (${activeModel.colormap?.label || 'Viridis'})`;
        setLogToggle(Boolean(activeModel.logEnabled));
        setRescaleToggle(Boolean(activeModel.colorbar?.usingFilter));
      }

      function setLogToggle(enabled) {
        logToggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        logToggle.textContent = enabled ? 'On' : 'Off';
      }

      setLogToggle(Boolean(model.logEnabled));
      setRescaleToggle(Boolean(model.colorbar?.usingFilter));
      logToggle.addEventListener('click', () => {
        const next = logToggle.getAttribute('aria-pressed') !== 'true';
        state.setContinuousLogScale(state.activeFieldIndex, next);
        refreshColorbarLabels();
        markSmokeDirty();
      });
      rescaleToggle.addEventListener('click', () => {
        const next = rescaleToggle.getAttribute('aria-pressed') !== 'true';
        state.setContinuousColorRescale(state.activeFieldIndex, next);
        if (next) {
          const { newMin, newMax } = getSliderValues();
          state.setContinuousColorRange(state.activeFieldIndex, newMin, newMax);
        }
        refreshColorbarLabels();
        markSmokeDirty();
      });

      const rescaleHint = document.createElement('div');
      rescaleHint.className = 'legend-help';
      rescaleHint.textContent = 'On: colors track sliders; Off: full data range';

      colorSection.appendChild(colorHeader);
      colorSection.appendChild(colorBarWrapper);
      colorSection.appendChild(minMaxRow);
      colorSection.appendChild(logRow);
      colorSection.appendChild(logHint);
      colorSection.appendChild(rescaleRow);
      colorSection.appendChild(rescaleHint);

      const range = model.stats.max - model.stats.min || 1;
      const filterSection = document.createElement('div');
      filterSection.className = 'legend-section legend-filter';
      const filterHeader = document.createElement('div');
      filterHeader.className = 'legend-section-title';
      filterHeader.textContent = 'Filtering';
      const filterTitle = document.createElement('div');
      filterTitle.className = 'legend-subtitle';
      filterTitle.textContent = 'Visible range';
      const filterSubtext = document.createElement('div');
      filterSubtext.className = 'legend-help';
      filterSubtext.textContent = 'Adjust limits; click FILTER or enable Live filtering.';
      filterSection.appendChild(filterHeader);
      filterSection.appendChild(filterTitle);
      filterSection.appendChild(filterSubtext);

      let liveFilteringEnabled = true;
      let filterBtn = null;

      const liveRow = document.createElement('div');
      liveRow.className = 'legend-toggle-row';
      const liveLabel = document.createElement('span');
      liveLabel.className = 'legend-toggle-label';
      liveLabel.textContent = 'Live filtering';
      const liveToggle = document.createElement('button');
      liveToggle.type = 'button';
      liveToggle.className = 'toggle-switch';
      const liveHint = document.createElement('div');
      liveHint.className = 'legend-help';
      liveHint.textContent = 'Changes apply as you drag';

      function setLiveToggleUI(enabled) {
        liveFilteringEnabled = enabled;
        liveToggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        liveToggle.textContent = enabled ? 'On' : 'Off';
        liveHint.textContent = enabled
          ? 'Changes apply as you drag'
          : 'Drag sliders, then click Filter';
        if (filterBtn) {
          filterBtn.disabled = enabled;
          filterBtn.classList.toggle('button-disabled', enabled);
          filterBtn.title = enabled
            ? 'Turn off Live filtering to use Filter'
            : 'Apply the current range';
        }
      }

      liveToggle.addEventListener('click', () => {
        const next = liveToggle.getAttribute('aria-pressed') !== 'true';
        setLiveToggleUI(next);
        if (next) applyFilterFromSliders();
      });

      liveRow.appendChild(liveLabel);
      liveRow.appendChild(liveToggle);
      filterSection.appendChild(liveRow);
      filterSection.appendChild(liveHint);

      const minRow = document.createElement('div');
      minRow.className = 'slider-row';
      const minLabelEl = document.createElement('span');
      minLabelEl.className = 'legend-subtitle';
      minLabelEl.textContent = 'Min';
      const minSlider = document.createElement('input');
      minSlider.type = 'range';
      minSlider.min = '0';
      minSlider.max = '100';
      minSlider.step = '1';

      const maxRow = document.createElement('div');
      maxRow.className = 'slider-row';
      const maxLabelEl = document.createElement('span');
      maxLabelEl.className = 'legend-subtitle';
      maxLabelEl.textContent = 'Max';
      const maxSlider = document.createElement('input');
      maxSlider.type = 'range';
      maxSlider.min = '0';
      maxSlider.max = '100';
      maxSlider.step = '1';

      const minPctInit = ((model.filter.min - model.stats.min) / range) * 100;
      const maxPctInit = ((model.filter.max - model.stats.min) / range) * 100;
      minSlider.value = String(Math.round(Math.max(0, Math.min(100, minPctInit))));
      maxSlider.value = String(Math.round(Math.max(0, Math.min(100, maxPctInit))));

      const minValueEl = document.createElement('span');
      minValueEl.className = 'slider-value';
      const maxValueEl = document.createElement('span');
      maxValueEl.className = 'slider-value';

      minRow.appendChild(minLabelEl);
      minRow.appendChild(minSlider);
      minRow.appendChild(minValueEl);

      maxRow.appendChild(maxLabelEl);
      maxRow.appendChild(maxSlider);
      maxRow.appendChild(maxValueEl);

      filterSection.appendChild(minRow);
      filterSection.appendChild(maxRow);

      const resetRow = document.createElement('div');
      resetRow.className = 'legend-actions compact';
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.textContent = 'RESET';
      filterBtn = document.createElement('button');
      filterBtn.type = 'button';
      filterBtn.textContent = 'FILTER';
      filterBtn.className = 'primary';
      resetRow.appendChild(filterBtn);
      resetRow.appendChild(resetBtn);
      filterSection.appendChild(resetRow);
      legendEl.appendChild(colorSection);
      legendEl.appendChild(filterSection);

      function getSliderValues() {
        let minValPct = parseFloat(minSlider.value);
        let maxValPct = parseFloat(maxSlider.value);
        if (!isFinite(minValPct)) minValPct = 0;
        if (!isFinite(maxValPct)) maxValPct = 100;
        if (minValPct > maxValPct) {
          minValPct = Math.min(minValPct, 100);
          maxValPct = minValPct;
          maxSlider.value = String(Math.round(maxValPct));
        }
        const newMin = model.stats.min + (minValPct / 100) * range;
        const newMax = model.stats.min + (maxValPct / 100) * range;
        return { newMin, newMax };
      }

      function updateDisplayFromSliders() {
        const { newMin, newMax } = getSliderValues();
        minValueEl.textContent = formatLegendNumber(newMin);
        maxValueEl.textContent = formatLegendNumber(newMax);
        if (rescaleToggle.getAttribute('aria-pressed') === 'true') {
          state.setContinuousColorRange(state.activeFieldIndex, newMin, newMax);
          refreshColorbarLabels();
        }
      }

      function applyFilterFromSliders() {
        const { newMin, newMax } = getSliderValues();
        state.applyContinuousFilter(state.activeFieldIndex, newMin, newMax);
        renderFilterSummary();
        markSmokeDirty();
      }

      minSlider.addEventListener('input', () => {
        if (parseFloat(minSlider.value) > parseFloat(maxSlider.value)) {
          maxSlider.value = minSlider.value;
        }
        updateDisplayFromSliders();
        if (liveFilteringEnabled) applyFilterFromSliders();
      });
      maxSlider.addEventListener('input', () => {
        if (parseFloat(maxSlider.value) < parseFloat(minSlider.value)) {
          minSlider.value = maxSlider.value;
        }
        updateDisplayFromSliders();
        if (liveFilteringEnabled) applyFilterFromSliders();
      });
      filterBtn.addEventListener('click', () => {
        applyFilterFromSliders();
      });
      resetBtn.addEventListener('click', () => {
        minSlider.value = '0';
        maxSlider.value = '100';
        updateDisplayFromSliders();
        state.resetContinuousFilter(state.activeFieldIndex);
        renderFilterSummary();
        if (liveFilteringEnabled) applyFilterFromSliders();
        markSmokeDirty();
      });
      setLiveToggleUI(true);
      updateDisplayFromSliders();
      if (liveFilteringEnabled) applyFilterFromSliders();
    } else {
      const catSection = document.createElement('div');
      catSection.className = 'legend-section';
      const title = document.createElement('div');
      title.textContent = 'Click a swatch to pick a color';
      title.style.fontSize = '10px';
      title.style.opacity = '0.8';
      title.style.marginBottom = '4px';
      catSection.appendChild(title);

      const controlsDiv = document.createElement('div');
      controlsDiv.className = 'legend-controls';
      const showAllBtn = document.createElement('button');
      showAllBtn.textContent = 'Show All';
      showAllBtn.addEventListener('click', () => {
        state.showAllCategories(field, { onlyAvailable: true });
        legendEl.querySelectorAll('.legend-checkbox:not(:disabled)').forEach(cb => { cb.checked = true; });
        renderFilterSummary();
        markSmokeDirty();
      });
      const hideAllBtn = document.createElement('button');
      hideAllBtn.textContent = 'Hide All';
      hideAllBtn.addEventListener('click', () => {
        state.hideAllCategories(field, { onlyAvailable: true });
        legendEl.querySelectorAll('.legend-checkbox:not(:disabled)').forEach(cb => { cb.checked = false; });
        renderFilterSummary();
        markSmokeDirty();
      });
      controlsDiv.appendChild(showAllBtn);
      controlsDiv.appendChild(hideAllBtn);
      catSection.appendChild(controlsDiv);

      const categories = model.categories || [];
      const counts = model.counts || {};
      const visibleCounts = counts.visible || [];
      const availableCounts = counts.available || [];
      const sortedIndices = categories.map((cat, idx) => ({ cat: String(cat), idx }))
        .sort((a, b) => a.cat.localeCompare(b.cat, undefined, { numeric: true, sensitivity: 'base' }))
        .map(item => item.idx);

      sortedIndices.forEach(catIdx => {
        const cat = String(categories[catIdx]);
        const isVisible = field._categoryVisible?.[catIdx] !== false;
        const visibleCount = visibleCounts[catIdx] || 0;
        const availableCount = availableCounts[catIdx] || 0;
        const hasCells = availableCount > 0;

        const row = document.createElement('div');
        row.className = 'legend-item';
        row.dataset.catIndex = String(catIdx);
        if (!hasCells) row.classList.add('legend-item-disabled');
        row.title = hasCells ? '' : 'No cells available in this category after other filters';
        row.style.position = 'relative';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'legend-checkbox';
        checkbox.checked = isVisible;
        checkbox.disabled = !hasCells;
        checkbox.addEventListener('change', (e) => {
          state.setVisibilityForCategory(field, catIdx, e.target.checked);
          renderFilterSummary();
          markSmokeDirty();
        });

        const swatch = document.createElement('div');
        swatch.className = 'legend-swatch';

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'legend-color-input';
        colorInput.disabled = !hasCells;

        const updateColorUI = () => {
          const nextColor = state.getColorForCategory(field, catIdx);
          swatch.style.backgroundColor = state.rgbToCss(nextColor);
          colorInput.value = rgbToHex(nextColor);
        };
        updateColorUI();

        colorInput.addEventListener('input', (e) => {
          const rgb = hexToRgb01(e.target.value);
          if (!rgb) return;
          state.setColorForCategory(field, catIdx, rgb);
          updateColorUI();
          renderFilterSummary();
        });

        swatch.appendChild(colorInput);

        const labelSpan = document.createElement('span');
        labelSpan.className = 'legend-label';
        labelSpan.textContent = cat;
        const countSpan = document.createElement('span');
        countSpan.className = 'legend-count';
        countSpan.textContent = formatCategoryCount(visibleCount, availableCount);

        row.appendChild(checkbox);
        row.appendChild(swatch);
        row.appendChild(labelSpan);
        row.appendChild(countSpan);
        catSection.appendChild(row);
      });
      legendEl.appendChild(catSection);
    }
  }

  function handleOutlierUI(field) {
    const hasOutliers = field && field.outlierQuantiles && field.outlierQuantiles.length > 0;
    if (outlierFilterContainer) {
      if (hasOutliers) {
        outlierFilterContainer.classList.add('visible');
        const pct = Math.round((field._outlierThreshold ?? 1.0) * 100);
        outlierFilterInput.value = String(pct);
        outlierFilterDisplay.textContent = pct + '%';
      } else {
        outlierFilterContainer.classList.remove('visible');
      }
    }

    if (centroidControls) {
      const isCategorical = Boolean(field && field.kind === 'category');
      centroidControls.classList.toggle('visible', isCategorical);
    }
  }

  // Get depth/renderer control boxes (not in dom object, get directly)
  const depthControls = document.getElementById('depth-controls');
  const rendererControls = document.getElementById('renderer-controls');

  function applyRenderMode(mode) {
    const normalized = mode === 'smoke' ? 'smoke' : 'points';
    viewer.setRenderMode(normalized);
    if (renderModeSelect && renderModeSelect.value !== normalized) {
      renderModeSelect.value = normalized;
    }
    if (smokeControls) {
      smokeControls.classList.toggle('visible', normalized === 'smoke');
    }
    if (pointsControls) {
      pointsControls.classList.toggle('visible', normalized === 'points');
    }
    // Hide depth/renderer controls in smoke mode (not relevant)
    if (depthControls) {
      depthControls.style.display = normalized === 'smoke' ? 'none' : 'block';
    }
    if (rendererControls) {
      rendererControls.style.display = normalized === 'smoke' ? 'none' : 'block';
    }
    // Build smoke volume on first switch to smoke mode, or if dirty
    if (normalized === 'smoke' && rebuildSmokeDensity && (!smokeBuiltOnce || smokeDirty)) {
      rebuildSmokeDensity(smokeGridSize);
      smokeBuiltOnce = true;
      smokeDirty = false;
      if (smokeRebuildHint) {
        smokeRebuildHint.textContent = 'Smoke density is up to date for current filters.';
      }
    }
    updateSplitViewUI();
  }

  function clearFieldSelections() {
    categoricalFieldSelect.value = NONE_FIELD_VALUE;
    continuousFieldSelect.value = NONE_FIELD_VALUE;
  }

  function syncSelectsForField(idx) {
    const fields = state.getFields();
    const field = fields[idx];
    if (!field) return;
    const isContinuous = field.kind === 'continuous';
    if (isContinuous) {
      continuousFieldSelect.value = String(idx);
      categoricalFieldSelect.value = NONE_FIELD_VALUE;
    } else {
      categoricalFieldSelect.value = String(idx);
      continuousFieldSelect.value = NONE_FIELD_VALUE;
    }
  }

  // --- Split-view (small multiples) HUD helpers ---

  function pushViewLayoutToViewer() {
    if (typeof viewer.setViewLayout !== 'function') return;
    viewer.setViewLayout(viewLayoutMode, activeViewId);
  }

  function syncActiveViewSelectOptions() {
    // Validate activeViewId is still valid (live or an existing snapshot)
    const snapshots = typeof viewer.getSnapshotViews === 'function'
      ? viewer.getSnapshotViews()
      : [];
    const validIds = new Set([LIVE_VIEW_ID, ...snapshots.map(s => String(s.id))]);
    if (!validIds.has(String(activeViewId))) {
      activeViewId = LIVE_VIEW_ID;
    }
  }

  /**
   * Helper to create a dimension indicator element for view badges.
   * Shows current dimension level and allows cycling through available dimensions.
   * @param {string} viewId - The view ID
   * @param {number} currentDim - Current dimension level (for display only)
   * @returns {HTMLElement|null} Dimension indicator element or null if not needed
   */
  function createDimensionIndicator(viewId, currentDim) {
    const availableDims = state.getAvailableDimensions?.() || [3];
    // Filter out 4D (not implemented) and only show if multiple dims available
    const usableDims = availableDims.filter(d => d !== 4);
    if (usableDims.length <= 1) return null;

    const dimIndicator = document.createElement('span');
    dimIndicator.className = 'split-badge-dim';
    dimIndicator.textContent = `${currentDim}D`;
    dimIndicator.title = 'Click to cycle dimension (1D/2D/3D)';
    // Store viewId as data attribute for click handler
    dimIndicator.dataset.viewId = String(viewId);

    // Click to cycle through dimensions
    dimIndicator.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Prevent rapid clicks from causing race conditions
      if (dimensionChangeBusy) return;

      const targetViewId = String(e.currentTarget.dataset.viewId || LIVE_VIEW_ID);

      // Get current dimension for this specific view BEFORE any state changes
      const freshCurrentDim = state.getViewDimensionLevel?.(targetViewId) ?? state.getDimensionLevel?.() ?? 3;

      // Find next available dimension in cycle order (priority: 3 > 2 > 1)
      const sortedDims = [...usableDims].sort((a, b) => b - a); // descending: 3, 2, 1
      const currentIdx = sortedDims.indexOf(freshCurrentDim);
      const nextIdx = (currentIdx + 1) % sortedDims.length;
      const nextDim = sortedDims[nextIdx];

      dimensionChangeBusy = true;
      try {
        // Change dimension for the specific view WITHOUT activating it first.
        // This ensures snapshot views update their snapshot buffers, not main positions.
        if (state.setDimensionLevel) {
          await state.setDimensionLevel(nextDim, { viewId: targetViewId });
        }

        // Re-render badges to show updated dimension
        renderSplitViewBadges();

        // Only sync dimension controls if this is already the active view
        if (String(activeViewId) === targetViewId) {
          syncDimensionSliderToActiveView();
        }
      } catch (err) {
        console.error('[UI] Failed to change dimension:', err);
      } finally {
        dimensionChangeBusy = false;
      }
    });

    return dimIndicator;
  }

  // Navigation mode indicator for view badges (only shown when cameras are unlocked)
  const NAV_MODE_LABELS = { orbit: 'Orb', planar: 'Pan', free: 'Fly' };
  const NAV_MODE_CYCLE = ['orbit', 'planar', 'free'];

  function createNavigationIndicator(viewId, currentMode) {
    const camerasLocked = typeof viewer.getCamerasLocked === 'function' ? viewer.getCamerasLocked() : true;
    // Only show navigation badges when cameras are unlocked
    if (camerasLocked) return null;

    const navIndicator = document.createElement('span');
    navIndicator.className = 'split-badge-nav';
    navIndicator.textContent = NAV_MODE_LABELS[currentMode] || 'Orb';
    navIndicator.title = 'Click to cycle navigation mode (Orbit/Planar/Free-fly)';
    navIndicator.dataset.viewId = String(viewId);

    // Click to cycle through navigation modes
    navIndicator.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const targetViewId = String(e.currentTarget.dataset.viewId || LIVE_VIEW_ID);

      // Get current navigation mode for this specific view
      const freshCurrentMode = typeof viewer.getViewNavigationMode === 'function'
        ? viewer.getViewNavigationMode(targetViewId)
        : 'orbit';

      // Find next mode in cycle
      const currentIdx = NAV_MODE_CYCLE.indexOf(freshCurrentMode);
      const nextIdx = (currentIdx + 1) % NAV_MODE_CYCLE.length;
      const nextMode = NAV_MODE_CYCLE[nextIdx];

      // Check if this is the focused view
      const focusedId = typeof viewer.getFocusedViewId === 'function' ? viewer.getFocusedViewId() : LIVE_VIEW_ID;
      const isFocusedView = targetViewId === focusedId;

      // For the focused view, use setNavigationMode for proper initialization
      // (syncFreeflyFromOrbit, cursor setup, etc.)
      if (isFocusedView && typeof viewer.setNavigationMode === 'function') {
        viewer.setNavigationMode(nextMode);
      }

      // Set navigation mode for this specific view (stores in camera state)
      if (typeof viewer.setViewNavigationMode === 'function') {
        viewer.setViewNavigationMode(targetViewId, nextMode);
      }

      // Re-render badges to show updated mode
      renderSplitViewBadges();

      // Sync navigation UI if this is the active/focused view
      if (isFocusedView && navigationModeSelect) {
        navigationModeSelect.value = nextMode;
        toggleNavigationPanels(nextMode);
      }
    });

    return navIndicator;
  }

  function renderSplitViewBadges() {
    if (!splitViewBadges) return;

    splitViewBadges.innerHTML = '';

    const snapshots = typeof viewer.getSnapshotViews === 'function'
      ? viewer.getSnapshotViews()
      : [];

    // If live view is hidden and 0-1 snapshots remain, restore live view.
    // This prevents getting stuck with a phantom snapshot that can't be closed.
    if (liveViewHidden && snapshots.length <= 1) {
      liveViewHidden = false;
      if (typeof viewer.setLiveViewHidden === 'function') {
        viewer.setLiveViewHidden(false);
      }
    }

    let badgeIndex = 1;

    // View 1 badge (only if not hidden)
    if (!liveViewHidden) {
      // Use same label format as snapshots (from viewer)
      const liveLabel = typeof viewer.getLiveViewLabel === 'function'
        ? viewer.getLiveViewLabel()
        : 'All cells';

      const liveBadge = document.createElement('div');
      liveBadge.className = 'split-badge';
      if (String(activeViewId) === LIVE_VIEW_ID) {
        liveBadge.classList.add('active');
      }
      // Show active camera indicator when cameras are unlocked
      const camerasLocked = typeof viewer.getCamerasLocked === 'function' ? viewer.getCamerasLocked() : true;
      const focusedId = typeof viewer.getFocusedViewId === 'function' ? viewer.getFocusedViewId() : LIVE_VIEW_ID;
      if (!camerasLocked && focusedId === LIVE_VIEW_ID) {
        liveBadge.classList.add('active-camera');
      }
      liveBadge.addEventListener('click', () => {
        activeViewId = LIVE_VIEW_ID;
        syncActiveViewToState();
        pushViewLayoutToViewer();
        renderSplitViewBadges();
        // Sync navigation dropdown when cameras are unlocked
        const camLocked = typeof viewer.getCamerasLocked === 'function' ? viewer.getCamerasLocked() : true;
        if (!camLocked && navigationModeSelect) {
          const viewNavMode = typeof viewer.getViewNavigationMode === 'function'
            ? viewer.getViewNavigationMode(LIVE_VIEW_ID) : 'orbit';
          navigationModeSelect.value = viewNavMode;
          toggleNavigationPanels(viewNavMode);
        }
      });

      const livePill = document.createElement('span');
      livePill.className = 'split-badge-pill';
      livePill.textContent = String(badgeIndex);

      // Camera indicator (shows when this view has active camera in unlocked mode)
      const liveCameraIndicator = document.createElement('span');
      liveCameraIndicator.className = 'split-badge-camera';
      liveCameraIndicator.textContent = '\u2316';

      const liveText = document.createElement('span');
      liveText.className = 'split-badge-label';
      liveText.textContent = liveLabel;

      // Add dimension indicator for live view
      const liveDim = state.getViewDimensionLevel?.(LIVE_VIEW_ID) ?? state.getDimensionLevel?.() ?? 3;
      const liveDimIndicator = createDimensionIndicator(LIVE_VIEW_ID, liveDim);

      // Add navigation mode indicator for live view (only when cameras unlocked)
      const liveNavMode = typeof viewer.getViewNavigationMode === 'function'
        ? viewer.getViewNavigationMode(LIVE_VIEW_ID)
        : 'orbit';
      const liveNavIndicator = createNavigationIndicator(LIVE_VIEW_ID, liveNavMode);

      // Close button for live view (only show if there are snapshots to fall back to)
      if (snapshots.length > 0) {
        const liveRemoveBtn = document.createElement('button');
        liveRemoveBtn.type = 'button';
        liveRemoveBtn.className = 'split-badge-remove';
        liveRemoveBtn.title = 'Remove this view';
        liveRemoveBtn.textContent = '×';
        liveRemoveBtn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        liveRemoveBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          // Get fresh snapshots to avoid stale closure
          const currentSnapshots = typeof viewer.getSnapshotViews === 'function'
            ? viewer.getSnapshotViews()
            : [];
          if (currentSnapshots.length === 0) return; // Safety check

          if (currentSnapshots.length === 1) {
            // Only 2 views (live + 1 snapshot): remove the snapshot instead of hiding live
            // This ensures clicking X on either view yields the same result
            const snapToRemove = currentSnapshots[0];
            if (typeof viewer.removeSnapshotView === 'function') {
              viewer.removeSnapshotView(snapToRemove.id);
            }
            if (typeof state.removeView === 'function') {
              state.removeView(snapToRemove.id);
            }
            if (typeof state.syncSnapshotContexts === 'function') {
              state.syncSnapshotContexts([]);
            }
            activeViewId = LIVE_VIEW_ID;
            syncActiveViewToState();
            pushViewLayoutToViewer();
          } else {
            // Multiple snapshots: hide live view and switch to first snapshot
            liveViewHidden = true;
            if (typeof viewer.setLiveViewHidden === 'function') {
              viewer.setLiveViewHidden(true);
            }
            if (String(activeViewId) === LIVE_VIEW_ID) {
              activeViewId = String(currentSnapshots[0].id);
              syncActiveViewToState();
              pushViewLayoutToViewer();
            }
          }
          renderSplitViewBadges();
          updateSplitViewUI();
        });

        liveBadge.appendChild(livePill);
        liveBadge.appendChild(liveCameraIndicator);
        liveBadge.appendChild(liveText);
        if (liveDimIndicator) liveBadge.appendChild(liveDimIndicator);
        if (liveNavIndicator) liveBadge.appendChild(liveNavIndicator);
        liveBadge.appendChild(liveRemoveBtn);
      } else {
        liveBadge.appendChild(livePill);
        liveBadge.appendChild(liveCameraIndicator);
        liveBadge.appendChild(liveText);
        if (liveDimIndicator) liveBadge.appendChild(liveDimIndicator);
        if (liveNavIndicator) liveBadge.appendChild(liveNavIndicator);
      }

      splitViewBadges.appendChild(liveBadge);
      badgeIndex++;
    }

    snapshots.forEach((snap) => {
      const badge = document.createElement('div');
      badge.className = 'split-badge';
      const snapId = String(snap.id);
      if (snapId === String(activeViewId)) {
        badge.classList.add('active');
      }
      // Show active camera indicator when cameras are unlocked
      const camerasLockedSnap = typeof viewer.getCamerasLocked === 'function' ? viewer.getCamerasLocked() : true;
      const focusedIdSnap = typeof viewer.getFocusedViewId === 'function' ? viewer.getFocusedViewId() : LIVE_VIEW_ID;
      if (!camerasLockedSnap && focusedIdSnap === snapId) {
        badge.classList.add('active-camera');
      }
      badge.addEventListener('click', () => {
        activeViewId = snapId;
        syncActiveViewToState();
        pushViewLayoutToViewer();
        renderSplitViewBadges();
        // Sync navigation dropdown when cameras are unlocked
        const camLocked = typeof viewer.getCamerasLocked === 'function' ? viewer.getCamerasLocked() : true;
        if (!camLocked && navigationModeSelect) {
          const viewNavMode = typeof viewer.getViewNavigationMode === 'function'
            ? viewer.getViewNavigationMode(snapId) : 'orbit';
          navigationModeSelect.value = viewNavMode;
          toggleNavigationPanels(viewNavMode);
        }
      });

      const pill = document.createElement('span');
      pill.className = 'split-badge-pill';
      pill.textContent = String(badgeIndex);

      // Camera indicator (shows when this view has active camera in unlocked mode)
      const cameraIndicator = document.createElement('span');
      cameraIndicator.className = 'split-badge-camera';
      cameraIndicator.textContent = '\u2316';

      const text = document.createElement('span');
      text.className = 'split-badge-label';
      const mainLabel = snap.label || snap.fieldKey || `View ${badgeIndex}`;
      text.textContent = mainLabel;

      // Add dimension indicator for snapshot view
      const snapDim = state.getViewDimensionLevel?.(snapId) ?? snap.dimensionLevel ?? 3;
      const snapDimIndicator = createDimensionIndicator(snapId, snapDim);

      // Add navigation mode indicator for snapshot view (only when cameras unlocked)
      const snapNavMode = typeof viewer.getViewNavigationMode === 'function'
        ? viewer.getViewNavigationMode(snapId)
        : (snap.cameraState?.navigationMode || 'orbit');
      const snapNavIndicator = createNavigationIndicator(snapId, snapNavMode);

      badge.appendChild(pill);
      badge.appendChild(cameraIndicator);
      badge.appendChild(text);
      if (snapDimIndicator) badge.appendChild(snapDimIndicator);
      if (snapNavIndicator) badge.appendChild(snapNavIndicator);

      // Only show close button if there's another view to fall back to
      // (either live view is available, or there are multiple snapshots)
      if (!liveViewHidden || snapshots.length > 1) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'split-badge-remove';
        removeBtn.title = 'Remove this view';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        removeBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (typeof viewer.removeSnapshotView === 'function') {
            viewer.removeSnapshotView(snap.id);
          }
          if (typeof state.removeView === 'function') {
            state.removeView(snap.id);
          }
          if (typeof state.syncSnapshotContexts === 'function' && typeof viewer.getSnapshotViews === 'function') {
            const ids = viewer.getSnapshotViews().map((v) => v.id);
            state.syncSnapshotContexts(ids);
          }
          // Sync liveViewHidden with viewer (viewer auto-restores when last snapshot removed)
          if (typeof viewer.getLiveViewHidden === 'function') {
            liveViewHidden = viewer.getLiveViewHidden();
          }
          const remainingSnaps = viewer.getSnapshotViews();
          // If this was the active view OR active view no longer exists, switch views
          const activeExists = snapId !== String(activeViewId) &&
            (activeViewId === LIVE_VIEW_ID || remainingSnaps.some(s => String(s.id) === String(activeViewId)));
          if (snapId === String(activeViewId) || !activeExists) {
            if (!liveViewHidden) {
              activeViewId = LIVE_VIEW_ID;
            } else if (remainingSnaps.length > 0) {
              activeViewId = String(remainingSnaps[0].id);
            } else {
              // No more snapshots and live is hidden - show live again
              liveViewHidden = false;
              if (typeof viewer.setLiveViewHidden === 'function') {
                viewer.setLiveViewHidden(false);
              }
              activeViewId = LIVE_VIEW_ID;
            }
            syncActiveViewToState();
            pushViewLayoutToViewer();
          }
          renderSplitViewBadges();
          updateSplitViewUI();
        });
        badge.appendChild(removeBtn);
      }

      splitViewBadges.appendChild(badge);
      badgeIndex++;
    });

    syncActiveViewSelectOptions();
  }

  function focusViewFromOverlay(viewId) {
    if (!viewId) return;
    const newViewId = String(viewId);
    const viewChanged = activeViewId !== newViewId;
    activeViewId = newViewId;

    // Sync state's active view to match viewer's focused view
    // This ensures state operations target the correct view
    if (viewChanged && typeof state.setActiveView === 'function') {
      state.setActiveView(newViewId);
    }

    syncActiveViewSelectOptions();
    renderSplitViewBadges();
    updateSplitViewUI();

    // Sync dimension buttons to reflect the newly focused view's dimension level
    if (viewChanged) {
      syncDimensionSliderToActiveView();
    }

    // Sync navigation mode dropdown when cameras are unlocked (per-view nav mode)
    const camerasLocked = typeof viewer.getCamerasLocked === 'function' ? viewer.getCamerasLocked() : true;
    if (viewChanged && !camerasLocked && navigationModeSelect) {
      const viewNavMode = typeof viewer.getViewNavigationMode === 'function'
        ? viewer.getViewNavigationMode(newViewId)
        : 'orbit';
      navigationModeSelect.value = viewNavMode;
      toggleNavigationPanels(viewNavMode);
    }
  }

  function updateSplitViewUI() {
    if (!splitViewControls) return;

    const modeIsPoints = !renderModeSelect || renderModeSelect.value === 'points';
    const snapshots = typeof viewer.getSnapshotViews === 'function'
      ? viewer.getSnapshotViews()
      : [];
    if (typeof state.syncSnapshotContexts === 'function') {
      state.syncSnapshotContexts(snapshots.map((s) => s.id));
    }
    const hasSnaps = snapshots.length > 0;
    const hasMultipleViews = snapshots.length > 0; // live view + snapshots
    if (splitViewBadgesBox) {
      splitViewBadgesBox.style.display = hasMultipleViews ? '' : 'none';
    }
    if (splitViewBoxTitle) {
      splitViewBoxTitle.style.display = hasMultipleViews ? '' : 'none';
    }

    syncActiveViewSelectOptions();

    if (splitKeepViewBtn) {
      splitKeepViewBtn.disabled = !modeIsPoints;
      splitKeepViewBtn.title = modeIsPoints
        ? 'Freeze the current view as a panel'
        : 'Switch to “Points” mode to keep views';
    }
    if (splitClearBtn) {
      splitClearBtn.disabled = !hasSnaps;
    }
    if (cameraLockBtn) {
      cameraLockBtn.disabled = !hasMultipleViews;
      cameraLockBtn.title = hasMultipleViews
        ? (viewer.getCamerasLocked()
            ? 'Cameras linked (click to unlink)'
            : 'Cameras independent (click to link)')
        : 'Add a kept view to link cameras';
    }

    if (viewLayoutModeSelect) {
      if (!modeIsPoints) {
        viewLayoutMode = 'single';
        viewLayoutModeSelect.value = 'single';
        activeViewId = LIVE_VIEW_ID;
      } else {
        viewLayoutMode = viewLayoutModeSelect.value === 'single' ? 'single' : 'grid';
      }
      viewLayoutModeSelect.disabled = !modeIsPoints;
    }

    syncActiveViewToState();
    pushViewLayoutToViewer();
  }

  function handleKeepView() {
    if (!splitKeepViewBtn) return;
    if (renderModeSelect && renderModeSelect.value !== 'points') {
      return; // Guard: only in points mode
    }
    if (!state.getSnapshotPayload || !viewer.createSnapshotView) return;

    try {
      const payload = state.getSnapshotPayload();
      if (!payload || !payload.colors || !payload.transparency) return;

      const snapshotConfig = {
        label: payload.label,
        fieldKey: payload.fieldKey,
        fieldKind: payload.fieldKind,
        colors: payload.colors,
        transparency: payload.transparency,
        outlierQuantiles: payload.outlierQuantiles,
        centroidPositions: payload.centroidPositions,
        centroidColors: payload.centroidColors,
        centroidOutliers: payload.centroidOutliers,
        centroidTransparencies: payload.centroidTransparencies,
        outlierThreshold: payload.outlierThreshold,
        dimensionLevel: payload.dimensionLevel, // Preserve dimension level for Keep View
        sourceViewId: activeViewId || LIVE_VIEW_ID, // Source view for positions
        meta: { filtersText: payload.filtersText || [] }
      };

      const created = viewer.createSnapshotView(snapshotConfig);
      if (!created) return;
      if (typeof state.createViewFromActive === 'function') {
        state.createViewFromActive(created.id);
      }

      // Copy dimension level to new view in dimension manager
      const dimManager = state.getDimensionManager?.();
      if (dimManager && created.id) {
        dimManager.copyViewDimension(activeViewId || LIVE_VIEW_ID, created.id);
      }
      if (typeof state.syncSnapshotContexts === 'function' && typeof viewer.getSnapshotViews === 'function') {
        const ids = viewer.getSnapshotViews().map((v) => v.id);
        state.syncSnapshotContexts(ids);
      }
      if (created.id) {
        activeViewId = String(created.id);
      }

      // Switch to grid mode to show the comparison
      viewLayoutMode = 'grid';
      if (viewLayoutModeSelect) viewLayoutModeSelect.value = 'grid';

      syncActiveViewToState();
      renderSplitViewBadges();
      updateSplitViewUI();
      pushViewLayoutToViewer();
    } catch (err) {
      console.error('Failed to keep view:', err);
    }
  }

  function handleClearViews() {
    if (!viewer.clearSnapshotViews) return;
    activeViewId = LIVE_VIEW_ID;
    liveViewHidden = false; // Restore live view visibility
    viewLayoutMode = 'grid';
    if (viewLayoutModeSelect) viewLayoutModeSelect.value = 'grid';
    viewer.clearSnapshotViews();
    if (typeof state.clearSnapshotViews === 'function') {
      state.clearSnapshotViews();
    }
    syncActiveViewToState();
    renderSplitViewBadges();
    updateSplitViewUI();
  }

  async function activateField(idx) {
    if (Number.isNaN(idx)) return;
    
    // Clear gene selection when activating an obs field
    if (idx >= 0) {
      selectedGeneIndex = -1;
      updateSelectedGeneDisplay();
      if (geneExpressionSearch) {
        geneExpressionSearch.value = '';
      }
    }
    
    if (idx < 0) {
      const cleared = state.clearActiveField ? state.clearActiveField() : null;
      clearFieldSelections();
      selectedGeneIndex = -1;
      updateSelectedGeneDisplay();
      if (geneExpressionSearch) {
        geneExpressionSearch.value = '';
      }
      legendEl.innerHTML = '';
      setDisplayOptionsVisibility(null);
      handleOutlierUI(null);
      renderFilterSummary();
      if (cleared) {
        updateStats(cleared);
      } else {
        const counts = state.getFilteredCount();
        updateStats({ field: null, pointCount: counts.total, centroidInfo: '' });
      }
      markSmokeDirty();
      return;
    }
    const fields = state.getFields();
    const field = fields[idx];
    if (!field) return;
    syncSelectsForField(idx);

    const alreadyLoaded = field.loaded;
    try {
      forceDisableFieldSelects = true;
      updateFieldSelectDisabledStates();
      if (!alreadyLoaded) statsEl.textContent = `Loading ${field.key}…`;
      if (state.ensureFieldLoaded) {
        await state.ensureFieldLoaded(idx);
      }
      const info = state.setActiveField(idx);
      renderLegend(state.getActiveField());
      handleOutlierUI(state.getActiveField());
      renderFilterSummary();
      updateStats(info);
      markSmokeDirty();
      // Update view labels to reflect field change
      syncActiveViewSelectOptions();
      renderSplitViewBadges();
    } catch (err) {
      console.error(err);
      statsEl.textContent = 'Error: ' + err.message;
    } finally {
      forceDisableFieldSelects = false;
      updateFieldSelectDisabledStates();
    }
  }

  // --- Event wiring ---

  categoricalFieldSelect.addEventListener('change', async () => {
    const idx = parseInt(categoricalFieldSelect.value, 10);
    if (Number.isNaN(idx)) return;
    if (idx >= 0) {
      if (continuousFieldSelect.value !== NONE_FIELD_VALUE) {
        continuousFieldSelect.value = NONE_FIELD_VALUE;
      }
      await activateField(idx);
    } else if (continuousFieldSelect.value === NONE_FIELD_VALUE) {
      await activateField(-1);
    }
    updateHighlightMode();
  });

  continuousFieldSelect.addEventListener('change', async () => {
    const idx = parseInt(continuousFieldSelect.value, 10);
    if (Number.isNaN(idx)) return;
    if (idx >= 0) {
      if (categoricalFieldSelect.value !== NONE_FIELD_VALUE) {
        categoricalFieldSelect.value = NONE_FIELD_VALUE;
      }
      await activateField(idx);
    } else if (categoricalFieldSelect.value === NONE_FIELD_VALUE) {
      await activateField(-1);
    }
    updateHighlightMode();
  });

  sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('hidden');
    sidebarToggle.classList.toggle('sidebar-open');
    sidebarToggle.textContent = sidebar.classList.contains('hidden') ? '☰' : '✕';
  });

  // Sidebar resize functionality
  const sidebarResizeHandle = document.getElementById('sidebar-resize-handle');
  const MIN_SIDEBAR_WIDTH = 260;
  const MAX_SIDEBAR_WIDTH = 520; // 2x the minimum width

  if (sidebarResizeHandle) {
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    const updateSidebarWidth = (width) => {
      const clampedWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
      sidebar.style.width = `${clampedWidth}px`;
      document.documentElement.style.setProperty('--sidebar-width', `${clampedWidth}px`);
    };

    sidebarResizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = sidebar.offsetWidth;
      sidebar.classList.add('resizing');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const deltaX = e.clientX - startX;
      updateSidebarWidth(startWidth + deltaX);
    });

    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        sidebar.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  }

  pointSizeInput.addEventListener('input', () => {
    applyPointSizeFromSlider();
  });

  backgroundSelect.addEventListener('change', () => {
    viewer.setBackground(backgroundSelect.value);
  });

  centroidPointsCheckbox.addEventListener('change', () => {
    const activeView = state.getActiveViewId ? state.getActiveViewId() : null;
    viewer.setShowCentroidPoints(centroidPointsCheckbox.checked, activeView);
  });

  centroidLabelsCheckbox.addEventListener('change', () => {
    const activeView = state.getActiveViewId ? state.getActiveViewId() : null;
    viewer.setShowCentroidLabels(centroidLabelsCheckbox.checked, activeView);
  });

  lightingStrengthInput.addEventListener('input', () => {
    const v = parseFloat(lightingStrengthInput.value) / 100.0;
    viewer.setLightingStrength(v);
    lightingStrengthDisplay.textContent = lightingStrengthInput.value;
  });

  fogDensityInput.addEventListener('input', () => {
    const v = parseFloat(fogDensityInput.value) / 100.0;
    viewer.setFogDensity(v);
    fogDensityDisplay.textContent = fogDensityInput.value;
  });

  sizeAttenuationInput.addEventListener('input', () => {
    const v = parseFloat(sizeAttenuationInput.value) / 100.0;
    viewer.setSizeAttenuation(v);
    sizeAttenuationDisplay.textContent = sizeAttenuationInput.value;
  });

  if (navigationModeSelect) {
    navigationModeSelect.addEventListener('change', () => {
      const selectValue = navigationModeSelect.value;
      const mode = selectValue === 'free' ? 'free' : (selectValue === 'planar' ? 'planar' : 'orbit');
      if (viewer.setNavigationMode) {
        viewer.setNavigationMode(mode);
      }
      // When cameras are unlocked, also update the focused view's stored navigation mode
      const camerasLocked = typeof viewer.getCamerasLocked === 'function' ? viewer.getCamerasLocked() : true;
      if (!camerasLocked && typeof viewer.setViewNavigationMode === 'function') {
        const focusedId = typeof viewer.getFocusedViewId === 'function' ? viewer.getFocusedViewId() : LIVE_VIEW_ID;
        viewer.setViewNavigationMode(focusedId, mode);
        renderSplitViewBadges(); // Update badge to show new mode
      }
      if (mode !== 'free' && pointerLockCheckbox && viewer.setPointerLockEnabled) {
        pointerLockCheckbox.checked = false;
        viewer.setPointerLockEnabled(false);
      }
      toggleNavigationPanels(mode);
      // Blur the select so WASD keys work immediately in free-fly mode
      if (mode === 'free') {
        navigationModeSelect.blur();
      }
    });
  }

  if (lookSensitivityInput) {
    updateLookSensitivity();
    lookSensitivityInput.addEventListener('input', updateLookSensitivity);
  }

  if (moveSpeedInput) {
    updateMoveSpeed();
    moveSpeedInput.addEventListener('input', updateMoveSpeed);
  }

  if (invertLookCheckbox && viewer.setInvertLook) {
    const setY = viewer.setInvertLookY || viewer.setInvertLook;
    const setX = viewer.setInvertLookX || viewer.setInvertLook;
    const apply = (val) => {
      setY.call(viewer, val);
      setX.call(viewer, val);
    };
    apply(Boolean(invertLookCheckbox.checked));
    invertLookCheckbox.addEventListener('change', () => {
      apply(Boolean(invertLookCheckbox.checked));
      invertLookCheckbox.blur();
    });
  }

  const applyPointerLock = (checked) => {
    if (!pointerLockCheckbox || !viewer.setPointerLockEnabled) return;
    const mode = navigationModeSelect?.value === 'free' ? 'free' : 'orbit';
    if (mode !== 'free') {
      pointerLockCheckbox.checked = false;
      return;
    }
    viewer.setPointerLockEnabled(Boolean(checked));
  };

  if (projectilesEnabledCheckbox && viewer.setProjectilesEnabled) {
    projectilesEnabledCheckbox.checked = false;
    viewer.setProjectilesEnabled(false);
    projectilesEnabledCheckbox.addEventListener('change', () => {
      const enabled = projectilesEnabledCheckbox.checked;

      if (enabled && !viewer.isProjectileOctreeReady?.()) {
        // Show loading message while building collision octree
        if (projectileInfoEl) {
          projectileInfoEl.style.display = 'block';
          projectileInfoEl.innerHTML = '<em>Building collision tree...</em>';
        }
        viewer.setProjectilesEnabled(true, () => {
          // Octree ready - hide loading message
          if (projectileInfoEl) {
            projectileInfoEl.innerHTML = '<em style="color: #4a4;">Ready! Click to shoot, hold to charge.</em>';
            setTimeout(() => {
              projectileInfoEl.style.display = 'none';
            }, 2000);
          }
        });
      } else {
        viewer.setProjectilesEnabled(enabled);
        if (projectileInfoEl) {
          projectileInfoEl.style.display = 'none';
        }
      }
      projectilesEnabledCheckbox.blur();
    });
  }

  if (pointerLockCheckbox && viewer.setPointerLockEnabled) {
    pointerLockCheckbox.checked = false;
    pointerLockCheckbox.addEventListener('change', () => {
      applyPointerLock(pointerLockCheckbox.checked);
      pointerLockCheckbox.blur();
    });
  }

  if (pointerLockCheckbox && viewer.setPointerLockChangeHandler) {
    viewer.setPointerLockChangeHandler((active) => {
      pointerLockCheckbox.checked = active;
      if (!active && viewer.getNavigationMode && viewer.getNavigationMode() !== 'free') {
        pointerLockCheckbox.checked = false;
      }
    });
  }

  if (orbitReverseCheckbox && viewer.setOrbitInvertRotation) {
    viewer.setOrbitInvertRotation(Boolean(orbitReverseCheckbox.checked));
    orbitReverseCheckbox.addEventListener('change', () => {
      viewer.setOrbitInvertRotation(Boolean(orbitReverseCheckbox.checked));
    });
  }

  // Planar zoom-to-cursor option (pinch-style zoom)
  if (planarZoomToCursorCheckbox && viewer.setPlanarZoomToCursor) {
    viewer.setPlanarZoomToCursor(Boolean(planarZoomToCursorCheckbox.checked));
    planarZoomToCursorCheckbox.addEventListener('change', () => {
      viewer.setPlanarZoomToCursor(Boolean(planarZoomToCursorCheckbox.checked));
    });
  }

  // Planar invert axes option
  if (planarInvertAxesCheckbox && viewer.setPlanarInvertAxes) {
    viewer.setPlanarInvertAxes(Boolean(planarInvertAxesCheckbox.checked));
    planarInvertAxesCheckbox.addEventListener('change', () => {
      viewer.setPlanarInvertAxes(Boolean(planarInvertAxesCheckbox.checked));
    });
  }

  // Orbit anchor visibility (scientific visualization of orbit center)
  if (showOrbitAnchorCheckbox && viewer.setShowOrbitAnchor) {
    viewer.setShowOrbitAnchor(Boolean(showOrbitAnchorCheckbox.checked));
    showOrbitAnchorCheckbox.addEventListener('change', () => {
      viewer.setShowOrbitAnchor(Boolean(showOrbitAnchorCheckbox.checked));
    });
  }

  outlierFilterInput.addEventListener('input', () => {
    const sliderValue = parseFloat(outlierFilterInput.value);
    const threshold = sliderValue / 100.0;
    state.setOutlierThresholdForActive(threshold);
    outlierFilterDisplay.textContent = Math.round(threshold * 100) + '%';
    renderFilterSummary();
    markSmokeDirty();
  });

  // Render mode + smoke/point control visibility
  if (renderModeSelect) {
    applyRenderMode(renderModeSelect.value || 'points');
    renderModeSelect.addEventListener('change', () => {
      const requested = renderModeSelect.value;
      if (
        requested === 'smoke' &&
        typeof viewer.hasSnapshots === 'function' &&
        viewer.hasSnapshots()
      ) {
        // Don’t allow smoke while we have small multiples
        renderModeSelect.value = 'points';
        return;
      }
      applyRenderMode(requested);
    });
  } else {
    applyRenderMode('points');
  }

  function getResolutionAdaptiveFactor(power = 0.5) {
    const baseGrid = 128;
    const gridFactor = Math.pow(smokeGridSize / baseGrid, power);
    return gridFactor * noiseResolutionScale;
  }

  function updateSmokeStepSlider() {
    if (!smokeStepsInput) return;
    const raw = parseFloat(smokeStepsInput.value);
    const t = Math.max(0, Math.min(100, isFinite(raw) ? raw : 60)) / 100;
    const label = t < 0.33 ? 'Fast' : (t < 0.66 ? 'Balanced' : (t < 0.9 ? 'High' : 'Ultra'));
    if (smokeStepsDisplay) smokeStepsDisplay.textContent = label;

    // Map slider to step multiplier (larger = more samples, better quality)
    const eased = Math.pow(t, 3); // Keep mid values similar while giving top end more headroom
    const adaptive = getResolutionAdaptiveFactor(0.35);
    const stepMultiplier = (0.5 + 4.0 * eased) * adaptive; // Adaptive to grid + noise detail
    viewer.setSmokeParams({ stepMultiplier });
  }

  // Smoke density slider - adaptive range based on grid resolution
  // Higher grid resolution needs higher density to be visible (density spread over more voxels)
  function getAdaptiveDensityRange() {
    // Base range at 128³ is [0.4 .. 3.2]
    // Scale up for higher resolutions, down for lower (also reacts to noise detail)
    const scaleFactor = getResolutionAdaptiveFactor(0.5);
    const minDensity = 0.4 * scaleFactor;
    const maxDensity = 8.0 * scaleFactor * 1.4; // Extra headroom for high-res grids
    return { min: minDensity, max: maxDensity };
  }

  function updateSmokeDensitySlider() {
    if (!smokeDensityInput) return;
    const raw = parseFloat(smokeDensityInput.value);
    const t = Math.max(0, Math.min(100, isFinite(raw) ? raw : 50)) / 100;
    const { min, max } = getAdaptiveDensityRange();
    const density = min + t * (max - min);
    if (smokeDensityDisplay) smokeDensityDisplay.textContent = density.toFixed(1);
    viewer.setSmokeParams({ density });
  }

  // Animation speed slider
  function updateSmokeSpeedSlider() {
    if (!smokeSpeedInput) return;
    const raw = parseFloat(smokeSpeedInput.value);
    const t = Math.max(0, Math.min(100, isFinite(raw) ? raw : 80)) / 100;
    const animationSpeed = t * 2.5; // [0 .. 2.5] (higher cap for faster motion)
    if (smokeSpeedDisplay) smokeSpeedDisplay.textContent = animationSpeed.toFixed(2);
    viewer.setSmokeParams({ animationSpeed });
  }

  // Detail level slider - adaptive range based on grid resolution
  // Higher grid resolution can show more detail
  function getAdaptiveDetailRange() {
    const scaleFactor = getResolutionAdaptiveFactor(0.35); // gentle scaling
    const maxDetail = 5.0 * scaleFactor;
    return { min: 0, max: maxDetail };
  }

  function updateSmokeDetailSlider() {
    if (!smokeDetailInput) return;
    const raw = parseFloat(smokeDetailInput.value);
    const t = Math.max(0, Math.min(100, isFinite(raw) ? raw : 60)) / 100;
    const { min, max } = getAdaptiveDetailRange();
    const detailLevel = min + t * (max - min);
    if (smokeDetailDisplay) smokeDetailDisplay.textContent = detailLevel.toFixed(1);
    viewer.setSmokeParams({ detailLevel });
  }

  // Turbulence (warp strength) slider
  function updateSmokeWarpSlider() {
    if (!smokeWarpInput) return;
    const raw = parseFloat(smokeWarpInput.value);
    const t = Math.max(0, Math.min(100, isFinite(raw) ? raw : 50)) / 100;
    // Stronger range: 0-2.0 for more visible turbulence
    const warpStrength = t * 2.0;
    if (smokeWarpDisplay) smokeWarpDisplay.textContent = (t * 100).toFixed(0) + '%';
    viewer.setSmokeParams({ warpStrength });
  }

  // Light absorption slider
  function updateSmokeAbsorptionSlider() {
    if (!smokeAbsorptionInput) return;
    const raw = parseFloat(smokeAbsorptionInput.value);
    const t = Math.max(0, Math.min(100, isFinite(raw) ? raw : 60)) / 100;
    const adaptive = getResolutionAdaptiveFactor(0.2);
    const lightAbsorption = (t * 2.0) * adaptive; // [~0 .. ~3.0] adaptive
    if (smokeAbsorptionDisplay) smokeAbsorptionDisplay.textContent = lightAbsorption.toFixed(1);
    viewer.setSmokeParams({ lightAbsorption });
  }

  // Light scattering slider
  function updateSmokeScatterSlider() {
    if (!smokeScatterInput) return;
    const raw = parseFloat(smokeScatterInput.value);
    const t = Math.max(0, Math.min(100, isFinite(raw) ? raw : 55)) / 100;
    const scatterStrength = (t * 2.0) * getResolutionAdaptiveFactor(0.15); // [~0 .. ~3.0] adaptive
    if (smokeScatterDisplay) smokeScatterDisplay.textContent = scatterStrength.toFixed(1);
    viewer.setSmokeParams({ scatterStrength });
  }

  // Edge softness slider
  function updateSmokeEdgeSlider() {
    if (!smokeEdgeInput) return;
    const raw = parseFloat(smokeEdgeInput.value);
    const t = Math.max(0, Math.min(100, isFinite(raw) ? raw : 50)) / 100;
    const edgeSoftness = 0.2 + t * 1.8; // [0.2 .. 2.0]
    if (smokeEdgeDisplay) smokeEdgeDisplay.textContent = edgeSoftness.toFixed(1);
    viewer.setSmokeParams({ edgeSoftness });
  }

  // Direct lighting slider
  function updateSmokeDirectLightSlider() {
    if (!smokeDirectLightInput) return;
    const raw = parseFloat(smokeDirectLightInput.value);
    const t = Math.max(0, Math.min(100, isFinite(raw) ? raw : 67)) / 100;
    const directLightIntensity = t * 1.5; // 0..1.5x of base directional light
    if (smokeDirectLightDisplay) smokeDirectLightDisplay.textContent = directLightIntensity.toFixed(2) + 'x';
    viewer.setSmokeParams({ directLightIntensity });
  }

  if (smokeStepsInput) {
    updateSmokeStepSlider();
    smokeStepsInput.addEventListener('input', () => {
      updateSmokeStepSlider();
    });
  }

  if (smokeDensityInput) {
    updateSmokeDensitySlider();
    smokeDensityInput.addEventListener('input', () => {
      updateSmokeDensitySlider();
    });
  }

  if (smokeSpeedInput) {
    updateSmokeSpeedSlider();
    smokeSpeedInput.addEventListener('input', () => {
      updateSmokeSpeedSlider();
    });
  }

  if (smokeDetailInput) {
    updateSmokeDetailSlider();
    smokeDetailInput.addEventListener('input', () => {
      updateSmokeDetailSlider();
    });
  }

  if (smokeWarpInput) {
    updateSmokeWarpSlider();
    smokeWarpInput.addEventListener('input', () => {
      updateSmokeWarpSlider();
    });
  }

  if (smokeAbsorptionInput) {
    updateSmokeAbsorptionSlider();
    smokeAbsorptionInput.addEventListener('input', () => {
      updateSmokeAbsorptionSlider();
    });
  }

  if (smokeScatterInput) {
    updateSmokeScatterSlider();
    smokeScatterInput.addEventListener('input', () => {
      updateSmokeScatterSlider();
    });
  }

  if (smokeEdgeInput) {
    updateSmokeEdgeSlider();
    smokeEdgeInput.addEventListener('input', () => {
      updateSmokeEdgeSlider();
    });
  }

  if (smokeDirectLightInput) {
    updateSmokeDirectLightSlider();
    smokeDirectLightInput.addEventListener('input', () => {
      updateSmokeDirectLightSlider();
    });
  }

  // Grid density slider (maps 0-100 to discrete grid sizes)
  const GRID_SIZES = [32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024];
  function sliderToGridSize(sliderValue) {
    const t = Math.max(0, Math.min(100, sliderValue)) / 100;
    const idx = Math.min(GRID_SIZES.length - 1, Math.floor(t * GRID_SIZES.length));
    return GRID_SIZES[idx];
  }
  function gridSizeToSlider(size) {
    const idx = GRID_SIZES.indexOf(size);
    if (idx >= 0) return (idx / GRID_SIZES.length) * 100;
    // Find closest
    for (let i = 0; i < GRID_SIZES.length; i++) {
      if (GRID_SIZES[i] >= size) return (i / GRID_SIZES.length) * 100;
    }
    return 100;
  }

  function updateSmokeGridSlider() {
    if (!smokeGridInput) return;
    const raw = parseFloat(smokeGridInput.value);
    const size = sliderToGridSize(isFinite(raw) ? raw : 50);
    if (smokeGridDisplay) smokeGridDisplay.textContent = size + '³';
    if (size !== smokeGridSize) {
      smokeGridSize = size;
      // Update other sliders that have adaptive ranges based on grid size
      updateSmokeDensitySlider();
      updateSmokeDetailSlider();
      updateSmokeWarpSlider();
      updateSmokeAbsorptionSlider();
      updateSmokeScatterSlider();
      updateSmokeStepSlider();
      scheduleAutoRebuild();
    }
  }

  if (smokeGridInput) {
    // Initialize from default value
    smokeGridSize = sliderToGridSize(parseFloat(smokeGridInput.value) || 50);
    if (smokeGridDisplay) smokeGridDisplay.textContent = smokeGridSize + '³';
    smokeGridInput.addEventListener('input', updateSmokeGridSlider);
  }

  // Cloud render resolution slider (0.25x to 2.0x)
  function updateCloudResolutionSlider() {
    if (!cloudResolutionInput) return;
    const raw = parseFloat(cloudResolutionInput.value);
    const t = Math.max(0, Math.min(100, isFinite(raw) ? raw : 25)) / 100;
    // Map 0-100 to 0.25-2.0 (exponential for better control at low end)
    const scale = 0.25 + t * 1.75; // [0.25 .. 2.0]
    if (cloudResolutionDisplay) cloudResolutionDisplay.textContent = scale.toFixed(2) + 'x';
    if (viewer.setCloudResolutionScale) {
      viewer.setCloudResolutionScale(scale);
    }
  }

  // Noise texture resolution slider (32 to 256)
  function updateNoiseResolutionSlider() {
    if (!noiseResolutionInput) return;
    const raw = parseFloat(noiseResolutionInput.value);
    const t = Math.max(0, Math.min(100, isFinite(raw) ? raw : 64)) / 100;
    // Map 0-100 to 32-256 (discrete steps: 32, 48, 64, 96, 128, 192, 256)
    const steps = [32, 48, 64, 96, 128, 192, 256];
    const idx = Math.min(steps.length - 1, Math.floor(t * steps.length));
    const size = steps[idx];
    if (noiseResolutionDisplay) noiseResolutionDisplay.textContent = size + '³';
    if (viewer.setNoiseTextureResolution) {
      viewer.setNoiseTextureResolution(size);
    }
    if (viewer.getAdaptiveScaleFactor) {
      noiseResolutionScale = viewer.getAdaptiveScaleFactor();
    }
    // Re-sync adaptive sliders when noise detail changes
    updateSmokeDensitySlider();
    updateSmokeDetailSlider();
    updateSmokeWarpSlider();
    updateSmokeAbsorptionSlider();
    updateSmokeScatterSlider();
    updateSmokeStepSlider();
  }

  if (cloudResolutionInput) {
    updateCloudResolutionSlider();
    cloudResolutionInput.addEventListener('input', updateCloudResolutionSlider);
  }

  if (noiseResolutionInput) {
    updateNoiseResolutionSlider();
    noiseResolutionInput.addEventListener('input', updateNoiseResolutionSlider);
  }

  // Auto-rebuild is now handled by scheduleAutoRebuild()

  // Gene expression search and dropdown event listeners
  if (geneExpressionSearch) {
    geneExpressionSearch.addEventListener('focus', () => {
      if (selectedGeneIndex >= 0) {
        geneExpressionSearch.value = '';
      }
      showGeneDropdown();
    });

    geneExpressionSearch.addEventListener('input', () => {
      renderGeneDropdownResults(geneExpressionSearch.value);
      if (!geneExpressionDropdown.classList.contains('visible')) {
        showGeneDropdown();
      }
    });

    geneExpressionSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideGeneDropdown();
        geneExpressionSearch.blur();
      } else if (e.key === 'Enter') {
        const firstItem = geneExpressionDropdown.querySelector('.dropdown-item');
        if (firstItem) {
          const idx = parseInt(firstItem.dataset.index, 10);
          selectGene(idx);
        }
      }
    });

    geneExpressionSearch.addEventListener('blur', () => {
      if (selectedGeneIndex >= 0 && !geneExpressionSearch.value) {
        const field = geneFieldList[selectedGeneIndex]?.field;
        if (field) {
          geneExpressionSearch.value = field.key || '';
        }
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (geneExpressionSearch && geneExpressionDropdown) {
      const isClickInside = geneExpressionSearch.contains(e.target) || 
                            geneExpressionDropdown.contains(e.target);
      if (!isClickInside) {
        hideGeneDropdown();
      }
    }
  });

  function resetVisualizationToDefaults() {
    if (!initialUIState) return;

    viewer.resetCamera();
    const defaultRenderMode = initialUIState.renderMode || 'points';
    const navMode = initialUIState.navigationMode || 'orbit';

    if (backgroundSelect) {
      backgroundSelect.value = initialUIState.background;
      viewer.setBackground(initialUIState.background);
    }

    if (renderModeSelect) {
      renderModeSelect.value = defaultRenderMode;
    }
    applyRenderMode(defaultRenderMode);

    if (navigationModeSelect) {
      navigationModeSelect.value = navMode;
      if (viewer.setNavigationMode) {
        viewer.setNavigationMode(navMode);
      }
      toggleNavigationPanels(navMode);
    }

    if (lookSensitivityInput) {
      lookSensitivityInput.value = initialUIState.lookSensitivity || '5';
      updateLookSensitivity();
    }

    if (moveSpeedInput) {
      moveSpeedInput.value = initialUIState.moveSpeed || '100';
      updateMoveSpeed();
    }

    if (invertLookCheckbox && viewer.setInvertLook) {
      invertLookCheckbox.checked = Boolean(initialUIState.invertLook);
      viewer.setInvertLook(Boolean(invertLookCheckbox.checked));
    }

    if (orbitReverseCheckbox && viewer.setOrbitInvertRotation) {
      orbitReverseCheckbox.checked = Boolean(initialUIState.orbitInvertRotation);
      viewer.setOrbitInvertRotation(Boolean(orbitReverseCheckbox.checked));
    }

    if (planarZoomToCursorCheckbox && viewer.setPlanarZoomToCursor) {
      planarZoomToCursorCheckbox.checked = Boolean(initialUIState.planarZoomToCursor);
      viewer.setPlanarZoomToCursor(Boolean(planarZoomToCursorCheckbox.checked));
    }

    if (planarInvertAxesCheckbox && viewer.setPlanarInvertAxes) {
      planarInvertAxesCheckbox.checked = Boolean(initialUIState.planarInvertAxes);
      viewer.setPlanarInvertAxes(Boolean(planarInvertAxesCheckbox.checked));
    }

    if (showOrbitAnchorCheckbox && viewer.setShowOrbitAnchor) {
      showOrbitAnchorCheckbox.checked = initialUIState.showOrbitAnchor ?? true;
      viewer.setShowOrbitAnchor(Boolean(showOrbitAnchorCheckbox.checked));
    }

    if (pointSizeInput) {
      pointSizeInput.value = initialUIState.pointSize;
      applyPointSizeFromSlider();
    }

    if (lightingStrengthInput) {
      lightingStrengthInput.value = initialUIState.lighting;
      const v = parseFloat(initialUIState.lighting);
      viewer.setLightingStrength(Number.isFinite(v) ? v / 100.0 : 0.6);
      lightingStrengthDisplay.textContent = lightingStrengthInput.value;
    }

    if (fogDensityInput) {
      fogDensityInput.value = initialUIState.fog;
      const v = parseFloat(initialUIState.fog);
      viewer.setFogDensity(Number.isFinite(v) ? v / 100.0 : 0.5);
      fogDensityDisplay.textContent = fogDensityInput.value;
    }

    if (sizeAttenuationInput) {
      sizeAttenuationInput.value = initialUIState.sizeAttenuation;
      const v = parseFloat(initialUIState.sizeAttenuation);
      viewer.setSizeAttenuation(Number.isFinite(v) ? v / 100.0 : 0);
      sizeAttenuationDisplay.textContent = sizeAttenuationInput.value;
    }

    if (smokeStepsInput) {
      smokeStepsInput.value = initialUIState.smokeSteps;
      updateSmokeStepSlider();
    }

    if (smokeDensityInput) {
      smokeDensityInput.value = initialUIState.smokeDensity;
      updateSmokeDensitySlider();
    }

    if (smokeSpeedInput) {
      smokeSpeedInput.value = initialUIState.smokeSpeed;
      updateSmokeSpeedSlider();
    }

    if (smokeDetailInput) {
      smokeDetailInput.value = initialUIState.smokeDetail;
      updateSmokeDetailSlider();
    }

    if (smokeWarpInput) {
      smokeWarpInput.value = initialUIState.smokeWarp;
      updateSmokeWarpSlider();
    }

    if (smokeAbsorptionInput) {
      smokeAbsorptionInput.value = initialUIState.smokeAbsorption;
      updateSmokeAbsorptionSlider();
    }

    if (smokeScatterInput) {
      smokeScatterInput.value = initialUIState.smokeScatter;
      updateSmokeScatterSlider();
    }

    if (smokeEdgeInput) {
      smokeEdgeInput.value = initialUIState.smokeEdge;
      updateSmokeEdgeSlider();
    }

    if (smokeDirectLightInput && initialUIState.smokeDirectLight != null) {
      smokeDirectLightInput.value = initialUIState.smokeDirectLight;
      updateSmokeDirectLightSlider();
    }

    if (smokeGridInput) {
      smokeGridInput.value = initialUIState.smokeGrid;
      updateSmokeGridSlider();
    }

    if (cloudResolutionInput && viewer.setCloudResolutionScale) {
      const cloudResVal = initialUIState.cloudResolution ?? 25;
      cloudResolutionInput.value = cloudResVal;
      updateCloudResolutionSlider();
    }

    if (noiseResolutionInput && viewer.setNoiseTextureResolution) {
      const noiseResVal = initialUIState.noiseResolution ?? 64;
      noiseResolutionInput.value = noiseResVal;
      updateNoiseResolutionSlider();
    }

    if (typeof rebuildSmokeDensity === 'function') {
      rebuildSmokeDensity(smokeGridSize);
    }
    markSmokeClean();
  }

  resetCameraBtn.addEventListener('click', () => {
    resetVisualizationToDefaults();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'r' || e.key === 'R') {
      viewer.resetCamera();
    }
  });
  // Initial setup
  viewer.setBackground(backgroundSelect.value);

  if (pointSizeInput && pointSizeInput.value === '0') {
    pointSizeInput.value = String(pointSizeToSlider(DEFAULT_POINT_SIZE));
  }
  const initialSliderValue = pointSizeInput.value !== ''
    ? parseFloat(pointSizeInput.value)
    : pointSizeToSlider(DEFAULT_POINT_SIZE);
  const normalizedSliderValue = Number.isFinite(initialSliderValue)
    ? Math.max(0, Math.min(100, initialSliderValue))
    : pointSizeToSlider(DEFAULT_POINT_SIZE);
  pointSizeInput.value = String(Math.round(normalizedSliderValue));
  applyPointSizeFromSlider();

  const initialFog = parseFloat(fogDensityInput.value);
  viewer.setFogDensity(Number.isFinite(initialFog) ? initialFog / 100.0 : 0.5);
  const initialSizeAttenuation = parseFloat(sizeAttenuationInput.value);
  viewer.setSizeAttenuation(Number.isFinite(initialSizeAttenuation) ? initialSizeAttenuation / 100.0 : 0.65);
  lightingStrengthDisplay.textContent = lightingStrengthInput.value;
  fogDensityDisplay.textContent = fogDensityInput.value;
  sizeAttenuationDisplay.textContent = sizeAttenuationInput.value;

  // Ensure centroid visibility matches checkbox defaults (off by default)
  if (centroidPointsCheckbox) {
    const activeView = state.getActiveViewId ? state.getActiveViewId() : null;
    viewer.setShowCentroidPoints(Boolean(centroidPointsCheckbox.checked), activeView);
  }
  if (centroidLabelsCheckbox) {
    const activeView = state.getActiveViewId ? state.getActiveViewId() : null;
    viewer.setShowCentroidLabels(Boolean(centroidLabelsCheckbox.checked), activeView);
  }

  // Default UI values for visible volumetric clouds
  initialUIState = {
    background: backgroundSelect?.value || 'white',
    renderMode: renderModeSelect?.value || 'points',
    pointSize: pointSizeInput?.value || String(pointSizeToSlider(DEFAULT_POINT_SIZE)),
    lighting: lightingStrengthInput?.value || '60',
    fog: fogDensityInput?.value || '50',
    sizeAttenuation: sizeAttenuationInput?.value || '65',
    smokeGrid: smokeGridInput?.value || '60',
    smokeSteps: smokeStepsInput?.value || '75',
    smokeDensity: smokeDensityInput?.value || '66',
    smokeSpeed: smokeSpeedInput?.value || '40',
    smokeDetail: smokeDetailInput?.value || '60',
    smokeWarp: smokeWarpInput?.value || '10',
    smokeAbsorption: smokeAbsorptionInput?.value || '65',
    smokeScatter: smokeScatterInput?.value || '0',
    smokeEdge: smokeEdgeInput?.value || '5',
    smokeDirectLight: smokeDirectLightInput?.value || '11',
    cloudResolution: cloudResolutionInput?.value || '15',
    noiseResolution: noiseResolutionInput?.value || '43',
    navigationMode: navigationModeSelect?.value || 'orbit',
    lookSensitivity: lookSensitivityInput?.value || '5',
    moveSpeed: moveSpeedInput?.value || '100',
    invertLook: invertLookCheckbox?.checked || false,
    orbitInvertRotation: orbitReverseCheckbox?.checked || false,
    showOrbitAnchor: showOrbitAnchorCheckbox?.checked ?? true,
    planarZoomToCursor: planarZoomToCursorCheckbox?.checked ?? true,
    planarInvertAxes: planarInvertAxesCheckbox?.checked || false
  };

  renderFieldSelects();
  updateHighlightMode();
  initGeneExpressionDropdown();
  const startingNavMode = navigationModeSelect?.value || 'orbit';
  toggleNavigationPanels(startingNavMode);

  // Wire state visibility callback so the smoke button lights up when filters change
  // Also update highlight summary since visible highlighted count may change
  const handleVisibilityChange = () => {
    markSmokeDirty();
    refreshLegendCategoryCounts();
    renderHighlightSummary(); // Update highlight count when visibility changes
  };
  if (state.addVisibilityChangeCallback) {
    state.addVisibilityChangeCallback(handleVisibilityChange);
  } else if (state.setVisibilityChangeCallback) {
    state.setVisibilityChangeCallback(handleVisibilityChange);
  }
  markSmokeClean(); // after initial density build

  if (typeof viewer.setViewFocusHandler === 'function') {
    viewer.setViewFocusHandler((viewId) => {
      focusViewFromOverlay(viewId);
    });
  }

  // Split-view HUD wiring
  if (splitKeepViewBtn) {
    splitKeepViewBtn.addEventListener('click', handleKeepView);
  }
  if (splitClearBtn) {
    splitClearBtn.addEventListener('click', handleClearViews);
  }
  if (cameraLockBtn) {
    function updateCameraLockUI() {
      const locked = viewer.getCamerasLocked();
      // Active (black) state represents Unlocked; normal represents Locked
      cameraLockBtn.setAttribute('aria-pressed', locked ? 'false' : 'true');
      cameraLockBtn.textContent = locked ? 'Locked Cam' : 'Unlocked Cam';
      cameraLockBtn.title = locked ? 'Cameras linked (click to unlink)' : 'Cameras independent (click to link)';
    }
    cameraLockBtn.addEventListener('click', () => {
      const newLocked = !viewer.getCamerasLocked();
      viewer.setCamerasLocked(newLocked);
      updateCameraLockUI();
      renderSplitViewBadges(); // Refresh badges to show active view indicator
    });
    updateCameraLockUI();
  }
  if (viewLayoutModeSelect) {
    viewLayoutModeSelect.addEventListener('change', () => {
      viewLayoutMode = viewLayoutModeSelect.value === 'single' ? 'single' : 'grid';
      pushViewLayoutToViewer();
      renderSplitViewBadges();
      updateSplitViewUI();
    });
  }

  // --- Dimension Dropdown Wiring ---
  let dimensionChangeBusy = false;

  /**
   * Render dimension dropdown options based on available dimensions.
   * Dropdown always controls the currently active view (live or snapshot).
   */
  function updateDimensionSelectUI() {
    if (!dimensionControls || !dimensionSelect) return;

    const availableDimensions = state.getAvailableDimensions?.() || [3];
    const hasMultipleDimensions = availableDimensions.length > 1;

    // Show/hide dimension controls based on whether multiple dimensions are available
    dimensionControls.style.display = hasMultipleDimensions ? '' : 'none';

    if (!hasMultipleDimensions) return;

    const activeView = typeof state.getActiveViewId === 'function'
      ? state.getActiveViewId()
      : LIVE_VIEW_ID;
    const currentDim = state.getViewDimensionLevel?.(activeView) ?? state.getDimensionLevel?.() ?? 3;

    // Clear existing options
    dimensionSelect.innerHTML = '';

    // Create options for each available dimension (1D–4D).
    // 4D is shown but disabled as a future hook when not implemented/available.
    const sortedDims = [1, 2, 3, 4].filter((d) => availableDimensions.includes(d));
    for (const dim of sortedDims) {
      const option = document.createElement('option');
      option.value = String(dim);
      option.textContent = `${dim}D`;

      const isFourD = dim === 4;
      if (isFourD) {
        // 4D: expose as disabled control to signal future support
        option.disabled = true;
        option.title = '4D embedding: reserved for future versions';
      }

      dimensionSelect.appendChild(option);
    }

    // Set current value
    dimensionSelect.value = String(currentDim);
  }

  // Add change event listener for dimension dropdown
  if (dimensionSelect) {
    dimensionSelect.addEventListener('change', (e) => {
      const newDim = parseInt(e.target.value, 10);
      if (!isNaN(newDim)) {
        handleDimensionChange(newDim);
      }
    });
  }

  async function handleDimensionChange(newLevel, targetViewId = null) {
    if (dimensionChangeBusy) return;
    if (!state.setDimensionLevel) return;

    // Check if dimension is available
    const availableDimensions = state.getAvailableDimensions?.() || [3];
    if (!availableDimensions.includes(newLevel)) {
      return;
    }

    // Determine target view: use provided targetViewId, then UI's activeViewId, then viewer's focused view
    // The viewer's focused view is the authoritative source for which view the user is interacting with
    const viewerFocusedView = typeof viewer.getFocusedViewId === 'function' ? viewer.getFocusedViewId() : null;
    const viewId = targetViewId ?? activeViewId ?? viewerFocusedView ?? LIVE_VIEW_ID;

    // Sync UI's activeViewId with the target view to keep them consistent
    if (activeViewId !== viewId) {
      activeViewId = viewId;
      syncActiveViewSelectOptions();
      renderSplitViewBadges();
    }

    const currentDim = state.getViewDimensionLevel?.(viewId) ?? state.getDimensionLevel?.() ?? 3;
    if (newLevel === currentDim) return;

    dimensionChangeBusy = true;
    if (dimensionLoading) dimensionLoading.style.display = '';

    // Immediately update dropdown value for responsive feel
    updateDimensionSelectValue(newLevel);

    try {
      await state.setDimensionLevel(newLevel, { viewId });
      // Update the dimension badges in the view badges after successful change
      renderSplitViewBadges();
    } catch (err) {
      console.error('[UI] Failed to change dimension:', err);
      // Revert dropdown value
      updateDimensionSelectValue(currentDim);
      showSessionStatus?.(err.message || 'Failed to change dimension', true);
    } finally {
      dimensionChangeBusy = false;
      if (dimensionLoading) dimensionLoading.style.display = 'none';
    }
  }

  // Listen for dimension changes from other sources (e.g., state restoration)
  if (state.addDimensionChangeCallback) {
    state.addDimensionChangeCallback((level) => {
      if (!dimensionChangeBusy) {
        updateDimensionSelectValue(level);
      }
    });
  }

  // Initial UI update
  updateDimensionSelectUI();

  renderSplitViewBadges();
  updateSplitViewUI();

  // Session save/load wiring
  function refreshUiAfterStateLoad() {
    // Sync liveViewHidden from viewer
    if (typeof viewer.getLiveViewHidden === 'function') {
      liveViewHidden = viewer.getLiveViewHidden();
    }

    renderHighlightPages();
    renderHighlightSummary();
    renderFilterSummary();
    state.updateFilteredCount();
    renderLegend(state.getActiveField());
    handleOutlierUI(state.getActiveField());
    const counts = state.getFilteredCount();
    const activeField = state.getActiveField();
    updateStats({
      field: activeField,
      pointCount: counts?.total || 0,
      centroidInfo: ''
    });
    renderSplitViewBadges();
    updateSplitViewUI();
  }

  function showSessionStatus(message, isError = false) {
    if (!sessionStatus) return;
    sessionStatus.textContent = message;
    sessionStatus.style.color = isError ? '#f44336' : 'var(--success-color, #4caf50)';
    sessionStatus.style.display = 'block';
    setTimeout(() => {
      sessionStatus.style.display = 'none';
    }, 3000);
  }

  if (saveStateBtn && stateSerializer) {
    saveStateBtn.addEventListener('click', () => {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        stateSerializer.downloadState(`cellucid-state-${timestamp}.json`);
        showSessionStatus('State saved successfully');
      } catch (err) {
        console.error('Failed to save state:', err);
        showSessionStatus('Failed to save state', true);
      }
    });
  }

  if (loadStateBtn && stateSerializer) {
    loadStateBtn.addEventListener('click', async () => {
      try {
        await stateSerializer.loadStateFromFile();
        showSessionStatus('State loaded successfully');
        refreshUiAfterStateLoad();
      } catch (err) {
        console.error('Failed to load state:', err);
        showSessionStatus(err?.message || 'Failed to load state', true);
      }
    });
  }

  // =========================================================================
  // Dataset Selector
  // =========================================================================

  /**
   * Update the dataset info display
   * @param {Object|null} metadata - Dataset metadata
   */
  function updateDatasetInfo(metadata, sourceTypeOverride = null) {
    if (!datasetInfo || !datasetCellsEl || !datasetGenesEl) return;

    const resetValues = () => {
      if (datasetNameEl) datasetNameEl.textContent = '—';
      if (datasetSourceEl) datasetSourceEl.textContent = '—';
      if (datasetDescriptionEl) {
        datasetDescriptionEl.textContent = '—';
        datasetDescriptionEl.title = '—';
      }
      if (datasetUrlEl) {
        datasetUrlEl.textContent = '—';
        datasetUrlEl.title = '—';
      }
      datasetCellsEl.textContent = '–';
      datasetGenesEl.textContent = '–';
      if (datasetObsEl) datasetObsEl.textContent = '–';
      if (datasetConnectivityEl) datasetConnectivityEl.textContent = '–';
      datasetInfo.classList.remove('loading', 'error');
    };

    if (!metadata) {
      resetValues();
      return;
    }

    const stats = metadata.stats || {};
    const sourceTypeLabel = (sourceTypeOverride || dataSourceManager?.getCurrentSourceType?.() || 'demo')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());

    // Prefer dataset's own source name (from dataset_identity.json).
    // Only fall back to the source-type label (e.g., "Local Demo")
    // if the dataset source name is missing or empty.
    const sourceName = (metadata.source?.name || '').trim();
    const sourceLabel = sourceName || sourceTypeLabel;

    if (datasetNameEl) datasetNameEl.textContent = metadata.name || metadata.id || 'Dataset';
    if (datasetSourceEl) datasetSourceEl.textContent = sourceLabel;
    if (datasetDescriptionEl) {
      const desc = metadata.description || '—';
      datasetDescriptionEl.textContent = desc;
      datasetDescriptionEl.title = desc;
    }
    if (datasetUrlEl) {
      const url = metadata.source?.url || metadata.url || '—';
      datasetUrlEl.textContent = url;
      datasetUrlEl.title = url;
    }
    datasetCellsEl.textContent = formatDataNumber(stats.n_cells);
    datasetGenesEl.textContent = formatDataNumber(stats.n_genes);
    if (datasetObsEl) datasetObsEl.textContent = formatDataNumber(stats.n_obs_fields);
    if (datasetConnectivityEl) {
      if (stats.has_connectivity) {
        const edgeText = stats.n_edges ? `${formatDataNumber(stats.n_edges)} edges` : 'Available';
        datasetConnectivityEl.textContent = edgeText;
      } else {
        datasetConnectivityEl.textContent = 'None';
      }
    }
    datasetInfo.classList.remove('loading', 'error');
  }

  /**
   * Refresh dataset-aware UI (field dropdowns, gene search, info panel, dimension controls)
   * @param {Object|null} metadata - Dataset metadata
   */
  function refreshDatasetUI(metadata) {
    renderFieldSelects();
    initGeneExpressionDropdown();
    clearGeneSelection();
    refreshUIForActiveView();
    updateDatasetInfo(metadata || (dataSourceManager?.getCurrentMetadata?.() || null));
    // Update dimension dropdown when dataset changes (different datasets may have different available dimensions)
    updateDimensionSelectUI();
  }

  /**
   * Populate the dataset dropdown with available datasets from all sources
   */
  async function populateDatasetDropdown() {
    console.log('[UI] populateDatasetDropdown called', { datasetSelect, dataSourceManager });

    if (!datasetSelect) {
      console.warn('[UI] Dataset select element not found');
      return;
    }
    if (!dataSourceManager) {
      console.warn('[UI] DataSourceManager not provided');
      datasetSelect.innerHTML = '<option value="" disabled>Manager not available</option>';
      return;
    }

    datasetSelect.innerHTML = '<option value="" disabled>Loading...</option>';

    try {
      console.log('[UI] Calling getAllDatasets...');

      // Add timeout to detect hanging
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout: getAllDatasets took more than 10s')), 10000)
      );

      // Get datasets from all sources (with timeout)
      const allSourceDatasets = await Promise.race([
        dataSourceManager.getAllDatasets(),
        timeoutPromise
      ]);

      console.log('[UI] getAllDatasets returned:', allSourceDatasets);

      // Flatten and collect all datasets with their source type
      const allDatasets = [];
      for (const { sourceType, datasets } of allSourceDatasets) {
        for (const dataset of datasets) {
          allDatasets.push({ ...dataset, sourceType });
        }
      }

      datasetSelect.innerHTML = '';

      const addNoneOption = () => {
        const noneOption = document.createElement('option');
        noneOption.value = NONE_DATASET_VALUE;
        noneOption.textContent = 'None';
        datasetSelect.appendChild(noneOption);
        return noneOption;
      };

      addNoneOption();

      if (allDatasets.length === 0) {
        const emptyMsg = document.createElement('option');
        emptyMsg.value = '';
        emptyMsg.disabled = true;
        emptyMsg.textContent = 'No datasets found';
        datasetSelect.appendChild(emptyMsg);
        datasetSelect.value = NONE_DATASET_VALUE;
        updateDatasetInfo(null);
        return;
      }

      // Group by source type if there are multiple sources with data
      const sourcesWithData = allSourceDatasets.filter(s => s.datasets.length > 0);
      const useGroups = sourcesWithData.length > 1;

      if (useGroups) {
        // Create optgroups for each source
        for (const { sourceType, datasets } of sourcesWithData) {
          const group = document.createElement('optgroup');
          group.label = sourceType === 'local-demo' ? 'Demo Datasets' :
                        sourceType === 'local-user' ? 'Your Data' :
                        sourceType;

          for (const dataset of datasets) {
            const option = document.createElement('option');
            option.value = dataset.id;
            option.dataset.sourceType = sourceType;
            const cellCount = dataset.stats?.n_cells ? ` (${formatDataNumber(dataset.stats.n_cells)} cells)` : '';
            option.textContent = `${dataset.name}${cellCount}`;
            group.appendChild(option);
          }

          datasetSelect.appendChild(group);
        }
      } else {
        // Simple flat list
        for (const dataset of allDatasets) {
          const option = document.createElement('option');
          option.value = dataset.id;
          option.dataset.sourceType = dataset.sourceType;
          const cellCount = dataset.stats?.n_cells ? ` (${formatDataNumber(dataset.stats.n_cells)} cells)` : '';
          option.textContent = `${dataset.name}${cellCount}`;
          datasetSelect.appendChild(option);
        }
      }

      // Select the current dataset if any; fall back to None
      const currentId = dataSourceManager.getCurrentDatasetId();
      if (currentId) {
        datasetSelect.value = currentId;
        updateDatasetInfo(dataSourceManager.getCurrentMetadata());
      } else if (datasetSelect.querySelector(`option[value=\"${NONE_DATASET_VALUE}\"]`)) {
        datasetSelect.value = NONE_DATASET_VALUE;
        updateDatasetInfo(null);
      }
    } catch (err) {
      console.error('[UI] Failed to populate dataset dropdown:', err);
      datasetSelect.innerHTML = '<option value="" disabled>Error loading datasets</option>';
    }
  }

  /**
   * Handle dataset selection change - reloads page with new dataset
   * @param {string} datasetId - The selected dataset ID
   * @param {string} [sourceType='local-demo'] - The source type for the dataset
   */
  async function handleDatasetChange(datasetId, sourceType = 'local-demo') {
    if (!dataSourceManager || !datasetId) return;

    // Check if this is already the current dataset
    const currentId = dataSourceManager.getCurrentDatasetId();
    const currentSourceType = dataSourceManager.getCurrentSourceType();
    if (currentId === datasetId && currentSourceType === sourceType) {
      return; // No change needed
    }

    try {
      if (datasetInfo) {
        datasetInfo.classList.add('loading');
        datasetCellsEl.textContent = '...';
        datasetGenesEl.textContent = '...';
      }

      showSessionStatus('Switching dataset...', false);

      await dataSourceManager.switchToDataset(sourceType, datasetId);

      // Local-user datasets must be loaded in-place to keep file handles alive
      if (sourceType === 'local-user') {
        if (typeof reloadDataset === 'function') {
          await reloadDataset(dataSourceManager.getCurrentMetadata?.());
        }
        showSessionStatus('Dataset loaded', false);
        return;
      }

      // Store the selected dataset in URL and reload for server-hosted sources
      const url = new URL(window.location.href);
      url.searchParams.set('dataset', datasetId);
      if (sourceType !== 'local-demo') {
        url.searchParams.set('source', sourceType);
      } else {
        url.searchParams.delete('source');
      }

      // Small delay to show the status message before reload
      setTimeout(() => {
        window.location.href = url.toString();
      }, 100);

    } catch (err) {
      console.error('[UI] Failed to switch dataset:', err);
      if (datasetInfo) datasetInfo.classList.add('error');
      showSessionStatus(`Failed to switch dataset: ${err.message}`, true);
    }
  }

  /**
   * Handle selecting the "None" dataset option - clear data and UI state
   */
  function handleNoneDatasetSelection() {
    if (typeof dataSourceManager?.clearActiveDataset === 'function') {
      dataSourceManager.clearActiveDataset();
    }

    // Clear data/state
    if (state?.initScene) {
      state.setFieldLoader?.(null);
      state.setVarFieldLoader?.(null);
      state.varData = null;
      state.initScene(new Float32Array(), { fields: [], count: 0 });
      state.clearActiveField?.();
      state.clearAllHighlights?.();
      state.clearSnapshotViews?.();
    }
    if (typeof viewer?.clearSnapshotViews === 'function') {
      viewer.clearSnapshotViews();
    }
    if (typeof viewer?.updateHighlight === 'function') {
      viewer.updateHighlight(new Uint8Array());
    }

    // Reset UI affordances
    clearGeneSelection();
    clearFieldSelections();
    refreshDatasetUI(null);
    if (datasetSelect) {
      datasetSelect.value = NONE_DATASET_VALUE;
    }
    if (statsEl) {
      statsEl.textContent = 'No dataset selected';
    }
    showSessionStatus('No dataset selected', false);
  }

  // Initialize dataset selector
  console.log('[UI] Dataset selector initialization:', {
    datasetSelect: !!datasetSelect,
    dataSourceManager: !!dataSourceManager,
    datasetInfo: !!datasetInfo,
    userDataBlock: !!userDataBlock,
    userDataPath: !!userDataPath,
    userDataBrowseBtn: !!userDataBrowseBtn
  });


  if (datasetSelect && dataSourceManager) {
    // Populate dropdown
    populateDatasetDropdown();

    // Keep dropdown in sync with source changes and dataset switches
    if (typeof dataSourceManager.onSourcesChange === 'function') {
      dataSourceManager.onSourcesChange(() => {
        populateDatasetDropdown();
      });
    }
    if (typeof dataSourceManager.onDatasetChange === 'function') {
      dataSourceManager.onDatasetChange((event) => {
        try {
          if (datasetSelect) {
            if (event?.datasetId) {
              datasetSelect.value = event.datasetId;
            } else if (datasetSelect.querySelector(`option[value=\"${NONE_DATASET_VALUE}\"]`)) {
              datasetSelect.value = NONE_DATASET_VALUE;
            }
          }
        } catch (_) {
          /* ignore */
        }
        updateDatasetInfo(event?.metadata || null, event?.sourceType || null);
      });
    }

    // Handle selection changes
    datasetSelect.addEventListener('change', (e) => {
      const selectedValue = e.target.value;
      if (selectedValue === NONE_DATASET_VALUE) {
        handleNoneDatasetSelection();
        return;
      }
      const selectedOption = e.target.selectedOptions[0];
      const sourceType = selectedOption?.dataset?.sourceType || 'local-demo';
      handleDatasetChange(selectedValue, sourceType);
    });
  } else {
    console.warn('[UI] Dataset selector not initialized - missing elements:', {
      datasetSelect: datasetSelect,
      dataSourceManager: dataSourceManager
    });
  }


  // Initialize user data directory picker (works in all browsers via webkitdirectory)
  console.log('[UI] User data block initialization');

  // Handle file input change
  if (userDataFileInput && dataSourceManager) {
    userDataFileInput.addEventListener('change', async (e) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      const userSource = dataSourceManager.getSource('local-user');
      if (!userSource) {
        showSessionStatus('User data source not available', true);
        return;
      }

      try {
        if (userDataStatus) {
          userDataStatus.textContent = 'Loading files...';
          userDataStatus.className = 'legend-help loading';
        }

        const metadata = await userSource.loadFromFileList(files);

        // Update UI with loaded data
        if (userDataPath) {
          userDataPath.value = userSource.getPath() || 'Selected';
          userDataPath.classList.add('active');
        }

        if (userDataStatus) {
          userDataStatus.textContent = `Loaded: ${formatDataNumber(metadata.stats?.n_cells)} cells`;
          userDataStatus.className = 'legend-help success';
        }

        updateDatasetInfo(metadata);

        // Deselect demo dataset dropdown
        if (datasetSelect) {
          datasetSelect.value = NONE_DATASET_VALUE;
        }

        // Switch to the user data source
        try {
          await dataSourceManager.switchToDataset('local-user', userSource.datasetId);
          if (typeof reloadDataset === 'function') {
            await reloadDataset(metadata);
          }
          populateDatasetDropdown();
          showSessionStatus(`User data ready: ${formatDataNumber(metadata.stats?.n_cells)} cells.`, false);
        } catch (switchErr) {
          console.warn('[UI] Could not auto-switch to user source:', switchErr);
          showSessionStatus('User data validated. Select "Load" to apply.', false);
        }

      } catch (err) {
        console.error('[UI] Failed to load user directory:', err);

        if (userDataPath) {
          userDataPath.value = '';
          userDataPath.classList.remove('active');
        }

        if (userDataStatus) {
          userDataStatus.textContent = err.getUserMessage?.() || err.message || 'Failed to load';
          userDataStatus.className = 'legend-help error';
        }
      }

      // Reset the input so the same folder can be selected again
      userDataFileInput.value = '';
    });
  }

  // Browse button triggers the hidden file input
  if (userDataBrowseBtn && userDataFileInput) {
    userDataBrowseBtn.addEventListener('click', () => {
      userDataFileInput.click();
    });
  }

  return { activateField, refreshUiAfterStateLoad, showSessionStatus, refreshDatasetUI };
}
