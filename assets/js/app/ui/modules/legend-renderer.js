/**
 * @fileoverview Legend renderer + field display controls.
 *
 * Renders the legend for the active field (continuous or categorical) and
 * wires user interactions to the DataState API (filters, category visibility,
 * color updates, category rename/delete/merge).
 *
 * Important: This module intentionally does not coordinate cross-module UI
 * refresh (filter summary, smoke rebuilds, highlight counts). The coordinator
 * listens to state visibility callbacks and triggers the appropriate re-renders.
 *
 * @module ui/modules/legend-renderer
 */

import { StyleManager } from '../../../utils/style-manager.js';
import { clamp } from '../../utils/number-utils.js';
import { initCategoricalLegend } from './legend/categorical-legend.js';
import { throttle } from '../../analysis/shared/dom-utils.js';

export function initLegendRenderer({ state, viewer, dom, dataSourceManager = null }) {
  const displayOptionsContainer = dom?.optionsContainer || null;
  const legendEl = dom?.legendEl || null;
  const outlierFilterContainer = dom?.outlierFilterContainer || null;
  const outlierFilterInput = dom?.outlierFilterInput || null;
  const outlierFilterDisplay = dom?.outlierFilterDisplay || null;
  const centroidControls = dom?.centroidControls || null;
  const centroidPointsCheckbox = dom?.centroidPointsCheckbox || null;
  const centroidLabelsCheckbox = dom?.centroidLabelsCheckbox || null;

  const { refreshCategoryCounts, renderCategoricalLegend } = initCategoricalLegend({ state, legendEl, dataSourceManager });

  function setDisplayOptionsVisibility(field) {
    if (!displayOptionsContainer) return;
    displayOptionsContainer.style.display = field ? 'block' : 'none';
  }

  function render(field) {
    if (!legendEl) return;
    setDisplayOptionsVisibility(field);
    legendEl.innerHTML = '';
    if (!field) return;
    const model = state.getLegendModel(field);
    if (!model) return;

    function formatLegendNumber(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) return '—';
      if (value === 0) return '0';
      const abs = Math.abs(value);
      const sign = value < 0 ? '-' : '';
      if (abs >= 10000 || (abs > 0 && abs < 0.01)) {
        const exp = Math.floor(Math.log10(abs));
        const mantissa = abs / Math.pow(10, exp);
        const m = mantissa < 10 ? mantissa.toFixed(1).replace(/\\.0$/, '') : Math.round(mantissa);
        return `${sign}${m}e${exp}`;
      }
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
      StyleManager.setVariable(gradientBar, '--colorbar-stops', model.colorStops.join(', '));
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
          StyleManager.setVariable(preview, '--colormap-stops', cm.cssStops.join(', '));
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
              render(state.getActiveField());
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

      function setLogToggle(enabled) {
        logToggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        logToggle.textContent = enabled ? 'On' : 'Off';
      }

      function refreshColorbarLabels() {
        const activeModel = state.getLegendModel(state.getActiveField());
        if (!activeModel || activeModel.kind !== 'continuous') return;
        const cMin = activeModel.colorbar?.min ?? activeModel.stats.min;
        const cMax = activeModel.colorbar?.max ?? activeModel.stats.max;
        minSpan.textContent = formatLegendNumber(cMin);
        maxSpan.textContent = formatLegendNumber(cMax);
        colorHeader.textContent = `Color scale (${activeModel.colormap?.label || 'Viridis'})`;
        setLogToggle(Boolean(activeModel.logEnabled));
        setRescaleToggle(Boolean(activeModel.colorbar?.usingFilter));
      }

      setLogToggle(Boolean(model.logEnabled));
      setRescaleToggle(Boolean(model.colorbar?.usingFilter));
      logToggle.addEventListener('click', () => {
        const next = logToggle.getAttribute('aria-pressed') !== 'true';
        state.setContinuousLogScale(state.activeFieldIndex, next);
        refreshColorbarLabels();
      });
      rescaleToggle.addEventListener('click', () => {
        const next = rescaleToggle.getAttribute('aria-pressed') !== 'true';
        state.setContinuousColorRescale(state.activeFieldIndex, next);
        if (next) {
          const { newMin, newMax } = getSliderValues();
          state.setContinuousColorRange(state.activeFieldIndex, newMin, newMax);
        }
        refreshColorbarLabels();
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
        liveHint.textContent = enabled ? 'Changes apply as you drag' : 'Drag sliders, then click Filter';
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
      minSlider.value = String(Math.round(clamp(minPctInit, 0, 100)));
      maxSlider.value = String(Math.round(clamp(maxPctInit, 0, 100)));

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
        if (liveFilteringEnabled) applyFilterFromSliders();
      });
      setLiveToggleUI(true);
      updateDisplayFromSliders();
      if (liveFilteringEnabled) applyFilterFromSliders();
    } else {
      renderCategoricalLegend(field, model);
    }
  }

  function handleOutlierUI(field) {
    const hasOutliers = field && field.outlierQuantiles && field.outlierQuantiles.length > 0;
    if (outlierFilterContainer) {
      if (hasOutliers) {
        outlierFilterContainer.classList.add('visible');
        const pct = Math.round((field._outlierThreshold ?? 1.0) * 100);
        if (outlierFilterInput) outlierFilterInput.value = String(pct);
        if (outlierFilterDisplay) outlierFilterDisplay.textContent = pct + '%';
      } else {
        outlierFilterContainer.classList.remove('visible');
      }
    }

    if (centroidControls) {
      const isCategorical = Boolean(field && field.kind === 'category');
      centroidControls.classList.toggle('visible', isCategorical);

      // Sync checkbox state with viewer when centroid controls become visible
      if (isCategorical && viewer) {
        const activeViewId = state.getActiveViewId?.() || 'live';
        const flags = viewer.getCentroidFlags?.(activeViewId) || { points: false, labels: false };
        if (centroidPointsCheckbox) {
          centroidPointsCheckbox.checked = flags.points;
        }
        if (centroidLabelsCheckbox) {
          centroidLabelsCheckbox.checked = flags.labels;
        }
      }
    }
  }

  if (outlierFilterInput) {
    // Throttle the expensive state update (visibility recomputation) while keeping display update immediate
    const throttledStateUpdate = throttle((threshold) => {
      state.setOutlierThresholdForActive(threshold);
    }, 50); // ~20 updates/sec max

    outlierFilterInput.addEventListener('input', () => {
      const sliderValue = parseFloat(outlierFilterInput.value);
      const threshold = sliderValue / 100.0;
      // Update display immediately for smooth visual feedback
      if (outlierFilterDisplay) outlierFilterDisplay.textContent = Math.round(threshold * 100) + '%';
      // Throttle the expensive state update
      throttledStateUpdate(threshold);
    });

    // Ensure final value is applied when user releases slider
    outlierFilterInput.addEventListener('change', () => {
      const sliderValue = parseFloat(outlierFilterInput.value);
      const threshold = sliderValue / 100.0;
      state.setOutlierThresholdForActive(threshold);
    });
  }

  // Centroid visibility toggles
  if (centroidPointsCheckbox && viewer) {
    centroidPointsCheckbox.addEventListener('change', () => {
      const show = centroidPointsCheckbox.checked;
      const activeViewId = state.getActiveViewId?.() || 'live';
      viewer.setShowCentroidPoints?.(show, activeViewId);
    });
  }

  if (centroidLabelsCheckbox && viewer) {
    centroidLabelsCheckbox.addEventListener('change', () => {
      const show = centroidLabelsCheckbox.checked;
      const activeViewId = state.getActiveViewId?.() || 'live';
      viewer.setShowCentroidLabels?.(show, activeViewId);
    });
  }

  setDisplayOptionsVisibility(null);

  return {
    render,
    refreshCategoryCounts,
    handleOutlierUI,
  };
}
