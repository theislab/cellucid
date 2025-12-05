// UI wiring: binds DOM controls to state/viewer, renders legends and filter summaries.
export function initUI({ state, viewer, dom, smoke }) {
  const {
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
    hintEl,
    resetCameraBtn,
    navigationModeSelect,
    lookSensitivityInput,
    lookSensitivityDisplay,
    moveSpeedInput,
    moveSpeedDisplay,
    invertLookCheckbox,
    pointerLockCheckbox,
    orbitReverseCheckbox,
    freeflyControls,
    orbitControls,
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
    viewLayoutModeSelect,
    activeViewSelect,
    splitViewBadges
  } = dom;

  const rebuildSmokeDensity = smoke?.rebuildSmokeDensity || null;

  const NONE_FIELD_VALUE = '-1';
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
    const centroidInfo =
      activeField && activeField.kind === 'category' && activeField.centroids
        ? ` • Centroids: ${activeField.centroids.length}`
        : '';
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
  const MIN_POINT_SIZE = 1;
  const MAX_POINT_SIZE = 200.0;
  const DEFAULT_POINT_SIZE = 5.0;
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

  function updateNavigationHint(mode = navigationModeSelect?.value || 'orbit') {
    if (!hintEl) return;
    if (mode === 'free') {
      hintEl.textContent =
        'Free-fly: click+drag to look (or capture pointer, Esc/Q to release) • WASD move • Space/E up • Ctrl/Q down • Shift sprint • R resets';
    } else {
      hintEl.textContent =
        '🖱️ Drag to rotate • Scroll to zoom • Shift+drag to pan • Press R to reset';
    }
    hintEl.style.display = 'block';
  }

  function toggleNavigationPanels(mode) {
    if (freeflyControls) {
      freeflyControls.style.display = mode === 'free' ? 'block' : 'none';
    }
    if (orbitControls) {
      orbitControls.style.display = mode === 'free' ? 'none' : 'block';
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
      line.textContent = 'No filters active (showing all points).';
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
    
    hideGeneDropdown();
    selectedGeneIndex = idx;
    
    categoricalFieldSelect.value = NONE_FIELD_VALUE;
    continuousFieldSelect.value = NONE_FIELD_VALUE;
    
    if (geneExpressionSearch) {
      geneExpressionSearch.value = '';
    }
    
    updateSelectedGeneDisplay();
    
    const field = geneFieldList[idx].field;
    const originalIdx = geneFieldList[idx].idx;
    
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
    legendEl.innerHTML = '';
    if (!field) return;
    const model = state.getLegendModel(field);
    if (!model) return;

    function formatLegendNumber(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) return '—';
      const abs = Math.abs(value);
      if (abs >= 1000 || (abs > 0 && abs < 0.01)) return value.toExponential(2);
      if (abs >= 10) return value.toFixed(1);
      return value.toFixed(2);
    }

    if (model.kind === 'continuous') {
      const container = document.createElement('div');
      container.className = 'legend-group';
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

      const label = document.createElement('div');
      label.style.fontSize = '10px';
      label.style.opacity = '0.8';
      label.style.marginTop = '2px';
      function setScaleLabelText(isLog, paletteName) {
        const name = paletteName || 'Viridis';
        label.textContent = isLog
          ? `Values mapped to ${name} (log10)`
          : `Values mapped to ${name}`;
      }
      setScaleLabelText(model.colorbar?.scale === 'log' || model.logEnabled, colormapLabel);

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
        setScaleLabelText(isLog, activeModel.colormap?.label);
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

      container.appendChild(colorHeader);
      container.appendChild(colorBarWrapper);
      container.appendChild(minMaxRow);
      container.appendChild(label);
      container.appendChild(logRow);
      container.appendChild(logHint);
      container.appendChild(rescaleRow);
      container.appendChild(rescaleHint);

      const range = model.stats.max - model.stats.min || 1;
      const filterContainer = document.createElement('div');
      filterContainer.style.marginTop = '4px';
      const filterHeader = document.createElement('div');
      filterHeader.className = 'legend-section-title';
      filterHeader.textContent = 'Filtering';
      const filterTitle = document.createElement('div');
      filterTitle.textContent = 'Visible range';
      filterTitle.style.fontSize = '10px';
      filterTitle.style.opacity = '0.8';
      filterTitle.style.marginBottom = '2px';
      const filterSubtext = document.createElement('div');
      filterSubtext.className = 'legend-help';
      filterSubtext.textContent = 'Adjust limits; click Filter or enable Live filtering.';
      filterContainer.appendChild(filterHeader);
      filterContainer.appendChild(filterTitle);
      filterContainer.appendChild(filterSubtext);

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
      filterContainer.appendChild(liveRow);
      filterContainer.appendChild(liveHint);

      const minRow = document.createElement('div');
      minRow.className = 'slider-row';
      const minLabelEl = document.createElement('span');
      minLabelEl.textContent = 'Min';
      minLabelEl.style.fontSize = '10px';
      const minSlider = document.createElement('input');
      minSlider.type = 'range';
      minSlider.min = '0';
      minSlider.max = '100';
      minSlider.step = '1';

      const maxRow = document.createElement('div');
      maxRow.className = 'slider-row';
      const maxLabelEl = document.createElement('span');
      maxLabelEl.textContent = 'Max';
      maxLabelEl.style.fontSize = '10px';
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

      filterContainer.appendChild(minRow);
      filterContainer.appendChild(maxRow);

      const resetRow = document.createElement('div');
      resetRow.className = 'legend-actions';
      const resetBtn = document.createElement('button');
      resetBtn.textContent = 'Reset';
      resetBtn.style.fontSize = '9px';
      resetBtn.style.padding = '2px 6px';
      resetBtn.style.borderRadius = '3px';
      resetBtn.style.border = '1px solid rgba(0,0,0,0.25)';
      resetBtn.style.background = '#f5f5f5';
      resetBtn.style.cursor = 'pointer';
      filterBtn = document.createElement('button');
      filterBtn.textContent = 'Filter';
      filterBtn.style.fontSize = '9px';
      filterBtn.style.padding = '2px 8px';
      filterBtn.style.borderRadius = '3px';
      filterBtn.style.border = '1px solid rgba(0,0,0,0.25)';
      filterBtn.style.background = '#e8eefc';
      filterBtn.style.cursor = 'pointer';
      filterBtn.style.fontWeight = '600';
      resetRow.style.gap = '6px';
      resetRow.appendChild(filterBtn);
      resetRow.appendChild(resetBtn);
      filterContainer.appendChild(resetRow);
      container.appendChild(filterContainer);
      legendEl.appendChild(container);

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
        minValueEl.textContent = newMin.toFixed(2);
        maxValueEl.textContent = newMax.toFixed(2);
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
      const title = document.createElement('div');
      title.textContent = 'Click a swatch to pick a color';
      title.style.fontSize = '10px';
      title.style.opacity = '0.8';
      title.style.marginBottom = '4px';
      legendEl.appendChild(title);

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
      legendEl.appendChild(controlsDiv);

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
        legendEl.appendChild(row);
      });
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
    if (!activeViewSelect) return;

    const snapshots = typeof viewer.getSnapshotViews === 'function'
      ? viewer.getSnapshotViews()
      : [];

    activeViewSelect.innerHTML = '';

    const addOption = (value, label) => {
      const opt = document.createElement('option');
      opt.value = String(value);
      opt.textContent = label;
      activeViewSelect.appendChild(opt);
    };

    addOption(LIVE_VIEW_ID, 'Live view');

    snapshots.forEach((snap, idx) => {
      const label = snap.label || snap.fieldKey || `View ${idx + 2}`;
      addOption(String(snap.id), `View ${idx + 2}: ${label}`);
    });

    const hasSelected = Array.from(activeViewSelect.options)
      .some((opt) => opt.value === String(activeViewId));

    if (hasSelected) {
      activeViewSelect.value = String(activeViewId);
    } else {
      activeViewSelect.value = LIVE_VIEW_ID;
      activeViewId = LIVE_VIEW_ID;
    }
  }

  function renderSplitViewBadges() {
    if (!splitViewBadges) return;

    splitViewBadges.innerHTML = '';

    const snapshots = typeof viewer.getSnapshotViews === 'function'
      ? viewer.getSnapshotViews()
      : [];

    const liveField = state.getActiveField ? state.getActiveField() : null;
    const liveLabel = liveField ? (liveField.key || 'Active field') : 'All cells';

    // Live badge
    const liveBadge = document.createElement('div');
    liveBadge.className = 'split-badge split-badge-live';
    if (String(activeViewId) === LIVE_VIEW_ID) {
      liveBadge.classList.add('active');
    }
    liveBadge.addEventListener('click', () => {
      activeViewId = LIVE_VIEW_ID;
      if (activeViewSelect) activeViewSelect.value = LIVE_VIEW_ID;
      syncActiveViewToState();
      pushViewLayoutToViewer();
      renderSplitViewBadges();
    });

    const livePill = document.createElement('span');
    livePill.className = 'split-badge-pill';
    livePill.textContent = '① Live';

    const liveText = document.createElement('span');
    liveText.className = 'split-badge-label';
    liveText.textContent = liveLabel;

    liveBadge.appendChild(livePill);
    liveBadge.appendChild(liveText);
    splitViewBadges.appendChild(liveBadge);

    if (!snapshots.length) {
      const info = document.createElement('div');
      info.className = 'filter-info';
      info.textContent = 'Configure a view and press “Keep view” to add panels.';
      splitViewBadges.appendChild(info);
      syncActiveViewSelectOptions();
      return;
    }

    snapshots.forEach((snap, idx) => {
      const badge = document.createElement('div');
      badge.className = 'split-badge';
      const snapId = String(snap.id);
      if (snapId === String(activeViewId)) {
        badge.classList.add('active');
      }
      badge.addEventListener('click', () => {
        activeViewId = snapId;
        if (activeViewSelect) activeViewSelect.value = snapId;
        syncActiveViewToState();
        pushViewLayoutToViewer();
        renderSplitViewBadges();
      });

      const pill = document.createElement('span');
      pill.className = 'split-badge-pill';
      pill.textContent = `${idx + 2}`;

      const text = document.createElement('span');
      text.className = 'split-badge-label';
      const mainLabel = snap.label || snap.fieldKey || `View ${idx + 2}`;
      text.textContent = mainLabel;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'split-badge-remove';
      removeBtn.title = 'Remove this kept view';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (e) => {
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
        renderSplitViewBadges();
        updateSplitViewUI();
      });

      badge.appendChild(pill);
      badge.appendChild(text);
      badge.appendChild(removeBtn);
      splitViewBadges.appendChild(badge);
    });

    syncActiveViewSelectOptions();
  }

  function focusViewFromOverlay(viewId) {
    if (!viewId) return;
    activeViewId = String(viewId);
    syncActiveViewSelectOptions();
    if (activeViewSelect) activeViewSelect.value = activeViewId;
    renderSplitViewBadges();
    updateSplitViewUI();
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

    if (activeViewSelect) {
      const selectedExists =
        activeViewId === LIVE_VIEW_ID ||
        snapshots.some((snap) => String(snap.id) === String(activeViewId));
      if (!selectedExists) {
        activeViewId = LIVE_VIEW_ID;
        activeViewSelect.value = LIVE_VIEW_ID;
      }
      activeViewSelect.disabled = !modeIsPoints;
    }

    if (viewLayoutModeSelect) {
      if (!modeIsPoints) {
        viewLayoutMode = 'single';
        viewLayoutModeSelect.value = 'single';
        activeViewId = LIVE_VIEW_ID;
        if (activeViewSelect) activeViewSelect.value = LIVE_VIEW_ID;
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
        meta: { filtersText: payload.filtersText || [] }
      };

      const created = viewer.createSnapshotView(snapshotConfig);
      if (!created) return;
      if (typeof state.createViewFromActive === 'function') {
        state.createViewFromActive(created.id);
      }
      if (typeof state.syncSnapshotContexts === 'function' && typeof viewer.getSnapshotViews === 'function') {
        const ids = viewer.getSnapshotViews().map((v) => v.id);
        state.syncSnapshotContexts(ids);
      }
      if (created.id) {
        activeViewId = String(created.id);
        if (activeViewSelect) activeViewSelect.value = String(created.id);
      }

      // Switch to grid mode to show the comparison
      viewLayoutMode = 'grid';
      if (viewLayoutModeSelect) viewLayoutModeSelect.value = 'grid';

      syncActiveViewToState();
      renderSplitViewBadges();
      updateSplitViewUI();
      pushViewLayoutToViewer();

      if (hintEl) {
        hintEl.textContent =
          'Camera is shared across panes – drag in any panel to compare.';
        hintEl.style.display = 'block';
      }
    } catch (err) {
      console.error('Failed to keep view:', err);
    }
  }

  function handleClearViews() {
    if (!viewer.clearSnapshotViews) return;
    activeViewId = LIVE_VIEW_ID;
    if (activeViewSelect) activeViewSelect.value = LIVE_VIEW_ID;
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
    } catch (err) {
      console.error(err);
      statsEl.textContent = 'Error: ' + err.message;
    } finally {
      forceDisableFieldSelects = false;
      updateFieldSelectDisabledStates();
    }
  }

  // --- Event wiring ---

  categoricalFieldSelect.addEventListener('change', () => {
    const idx = parseInt(categoricalFieldSelect.value, 10);
    if (Number.isNaN(idx)) return;
    if (idx >= 0) {
      if (continuousFieldSelect.value !== NONE_FIELD_VALUE) {
        continuousFieldSelect.value = NONE_FIELD_VALUE;
      }
      activateField(idx);
    } else if (continuousFieldSelect.value === NONE_FIELD_VALUE) {
      activateField(-1);
    }
  });

  continuousFieldSelect.addEventListener('change', () => {
    const idx = parseInt(continuousFieldSelect.value, 10);
    if (Number.isNaN(idx)) return;
    if (idx >= 0) {
      if (categoricalFieldSelect.value !== NONE_FIELD_VALUE) {
        categoricalFieldSelect.value = NONE_FIELD_VALUE;
      }
      activateField(idx);
    } else if (categoricalFieldSelect.value === NONE_FIELD_VALUE) {
      activateField(-1);
    }
  });

  sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('hidden');
    sidebarToggle.classList.toggle('sidebar-open');
    sidebarToggle.textContent = sidebar.classList.contains('hidden') ? '☰' : '✕';
  });

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
      const mode = navigationModeSelect.value === 'free' ? 'free' : 'orbit';
      if (viewer.setNavigationMode) {
        viewer.setNavigationMode(mode);
      }
      if (mode !== 'free' && pointerLockCheckbox && viewer.setPointerLockEnabled) {
        pointerLockCheckbox.checked = false;
        viewer.setPointerLockEnabled(false);
      }
      toggleNavigationPanels(mode);
      updateNavigationHint(mode);
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
    });
  }

  const applyPointerLock = (checked) => {
    if (!pointerLockCheckbox || !viewer.setPointerLockEnabled) return;
    const mode = navigationModeSelect?.value === 'free' ? 'free' : 'orbit';
    if (mode !== 'free') {
      pointerLockCheckbox.checked = false;
      if (hintEl) {
        hintEl.textContent = 'Pointer capture is only available in Free-fly mode.';
        hintEl.style.display = 'block';
      }
      return;
    }
    viewer.setPointerLockEnabled(Boolean(checked));
  };

  if (pointerLockCheckbox && viewer.setPointerLockEnabled) {
    pointerLockCheckbox.checked = false;
    pointerLockCheckbox.addEventListener('change', () => {
      applyPointerLock(pointerLockCheckbox.checked);
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
        if (hintEl) {
          hintEl.textContent =
            'Clear kept views to enable volumetric smoke rendering.';
          hintEl.style.display = 'block';
        }
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

    if (backgroundSelect) {
      backgroundSelect.value = initialUIState.background;
      viewer.setBackground(initialUIState.background);
    }

    if (renderModeSelect) {
      renderModeSelect.value = defaultRenderMode;
    }
    applyRenderMode(defaultRenderMode);

    if (navigationModeSelect) {
      const mode = initialUIState.navigationMode || 'orbit';
      navigationModeSelect.value = mode;
      if (viewer.setNavigationMode) {
        viewer.setNavigationMode(mode);
      }
      toggleNavigationPanels(mode);
      updateNavigationHint(mode);
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
    sizeAttenuation: sizeAttenuationInput?.value || '0',
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
    orbitInvertRotation: orbitReverseCheckbox?.checked || false
  };

  renderFieldSelects();
  initGeneExpressionDropdown();
  const startingNavMode = navigationModeSelect?.value || 'orbit';
  toggleNavigationPanels(startingNavMode);
  updateNavigationHint(startingNavMode);

  // Wire state visibility callback so the smoke button lights up when filters change
  const handleVisibilityChange = () => {
    markSmokeDirty();
    refreshLegendCategoryCounts();
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
  if (viewLayoutModeSelect) {
    viewLayoutModeSelect.addEventListener('change', () => {
      viewLayoutMode = viewLayoutModeSelect.value === 'single' ? 'single' : 'grid';
      pushViewLayoutToViewer();
      renderSplitViewBadges();
      updateSplitViewUI();
    });
  }
  if (activeViewSelect) {
    activeViewSelect.addEventListener('change', () => {
      activeViewId = activeViewSelect.value || LIVE_VIEW_ID;
      syncActiveViewToState();
      pushViewLayoutToViewer();
      renderSplitViewBadges();
    });
  }
  renderSplitViewBadges();
  updateSplitViewUI();

  return { activateField };
}
