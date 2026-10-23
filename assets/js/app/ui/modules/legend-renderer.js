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
import { createVisibilityGatedRender } from '../core/visibility-gate.js';
import {
  createButton,
  createInfoRow,
  createInfoTip,
  createSliderField,
  createSwitch
} from '../components/controls.js';
import { initOutlierFilterControl } from './outlier-filter-control.js';

let colormapMenuIdCounter = 0;

/**
 * A legend value: three significant figures, scientific notation outside
 * 0.01 to 10,000.
 */
function formatLegendNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 10000 || abs < 0.01) {
    const exp = Math.floor(Math.log10(abs));
    const mantissa = abs / Math.pow(10, exp);
    const m = mantissa < 10 ? mantissa.toFixed(1).replace(/\.0$/, '') : Math.round(mantissa);
    return `${sign}${m}e${exp}`;
  }
  if (abs >= 100) return sign + abs.toFixed(0);
  if (abs >= 10) return sign + abs.toFixed(1);
  return sign + abs.toFixed(2);
}

export function initLegendRenderer({ state, viewer, dom, dataSourceManager = null, onChooseLatent = () => {} }) {
  const displayOptionsContainer = dom?.optionsContainer || null;
  const legendEl = dom?.legendEl || null;
  const outlierControl = initOutlierFilterControl({
    state,
    dom: {
      container: dom?.outlierFilterContainer || null,
      input: dom?.outlierFilterInput || null,
      display: dom?.outlierFilterDisplay || null,
      note: dom?.outlierFilterNote || null,
      progress: dom?.outlierFilterProgress || null,
      progressBar: dom?.outlierFilterProgressBar || null,
      action: dom?.outlierFilterAction || null,
    },
    onChooseLatent,
  });
  const centroidControls = dom?.centroidControls || null;
  const centroidPointsCheckbox = dom?.centroidPointsCheckbox || null;
  const centroidLabelsCheckbox = dom?.centroidLabelsCheckbox || null;

  const {
    refreshCategoryCounts,
    renderCategoricalLegend,
    releaseCategoricalLegend,
    destroy: destroyCategoricalLegend
  } = initCategoricalLegend({ state, legendEl, dataSourceManager });
  // Counts change on every visibility frame; while the legend's panel is
  // collapsed (or the sidebar hidden) they are refreshed once it is shown.
  // Created at the first refresh.
  let countsGate = null;
  const lifecycleController = new AbortController();
  let renderLifecycleController = new AbortController();
  let destroyed = false;

  function listen(
    target,
    eventName,
    listener,
    signal = lifecycleController.signal,
    options = {}
  ) {
    target.addEventListener(eventName, (...args) => {
      if (destroyed) return;
      listener(...args);
    }, { ...options, signal });
  }

  function setDisplayOptionsVisibility(field) {
    if (destroyed) return;
    if (!displayOptionsContainer) return;
    displayOptionsContainer.hidden = !field;
  }

  function render(field) {
    if (destroyed) return;
    renderLifecycleController.abort();
    renderLifecycleController = new AbortController();
    const renderSignal = renderLifecycleController.signal;
    if (!legendEl) return;
    setDisplayOptionsVisibility(field);
    if (!field) {
      releaseCategoricalLegend();
      legendEl.replaceChildren();
      return;
    }
    const model = state.getLegendModel(field);
    if (
      model === null
      || typeof model !== 'object'
      || (model.kind !== 'continuous' && model.kind !== 'category')
    ) {
      throw new TypeError('Legend renderer requires an exact legend model');
    }
    if (model.kind === 'category') {
      renderCategoricalLegend(field, model);
      return;
    }
    releaseCategoricalLegend();
    legendEl.replaceChildren();

    if (model.kind === 'continuous') {
      const colorSection = document.createElement('div');
      colorSection.className = 'legend-section';
      const colorHeader = document.createElement('h3');
      colorHeader.className = 'section-title';
      const colormapLabel = model.colormap?.label || 'Viridis';
      colorHeader.textContent = `Color scale (${colormapLabel})`;

      const colorBarWrapper = document.createElement('div');
      colorBarWrapper.className = 'colorbar-wrapper';

      const gradientBar = document.createElement('button');
      gradientBar.type = 'button';
      gradientBar.className = 'colorbar-gradient';
      StyleManager.setVariable(gradientBar, '--colorbar-stops', model.colorStops.join(', '));
      gradientBar.title = 'Click to change color palette';
      // The bar is a disclosure button for the palette menu below it.
      gradientBar.setAttribute('aria-label', `Color palette: ${colormapLabel}`);
      gradientBar.setAttribute('aria-expanded', 'false');

      const colormapMenu = document.createElement('div');
      colormapMenu.className = 'colormap-menu';
      colormapMenu.id = `legend-colormap-menu-${++colormapMenuIdCounter}`;
      colormapMenu.setAttribute('role', 'group');
      colormapMenu.setAttribute('aria-label', 'Color palettes');
      colormapMenu.hidden = true;
      gradientBar.setAttribute('aria-controls', colormapMenu.id);
      const colormapOptions = state.getContinuousColormaps ? state.getContinuousColormaps() : [];
      function renderColormapMenu() {
        const activeId = model.colormap?.id;
        colormapMenu.innerHTML = '';
        colormapOptions.forEach((cm) => {
          const option = document.createElement('button');
          option.type = 'button';
          option.className = 'colormap-option' + (cm.id === activeId ? ' active' : '');
          option.setAttribute('aria-pressed', cm.id === activeId ? 'true' : 'false');
          const preview = document.createElement('div');
          preview.className = 'colormap-preview';
          StyleManager.setVariable(preview, '--colormap-stops', cm.cssStops.join(', '));
          const name = document.createElement('span');
          name.className = 'colormap-name';
          name.textContent = cm.label;
          option.appendChild(preview);
          option.appendChild(name);
          listen(option, 'click', (e) => {
            e.stopPropagation();
            if (cm.id === activeId) {
              closeColormapMenu({ restoreFocus: true });
              return;
            }
            closeColormapMenu({ restoreFocus: false });
            state.setContinuousColormap(state.activeFieldIndex, cm.id);
            render(state.getActiveField());
            // The legend was rebuilt; keep focus on the new palette control.
            legendEl.querySelector('.colorbar-gradient')?.focus();
          }, renderSignal);
          colormapMenu.appendChild(option);
        });
      }
      renderColormapMenu();

      function closeColormapMenu({ restoreFocus = false } = {}) {
        colormapMenu.hidden = true;
        gradientBar.setAttribute('aria-expanded', 'false');
        if (restoreFocus) gradientBar.focus();
      }
      function handleOutsideClick(evt) {
        if (!colorBarWrapper.contains(evt.target)) closeColormapMenu();
      }

      listen(gradientBar, 'click', (e) => {
        e.stopPropagation();
        const willOpen = colormapMenu.hidden;
        if (willOpen) {
          colormapMenu.hidden = false;
          gradientBar.setAttribute('aria-expanded', 'true');
          listen(
            document,
            'click',
            handleOutsideClick,
            renderSignal,
            { once: true }
          );
        } else {
          closeColormapMenu();
        }
      }, renderSignal);
      listen(
        colormapMenu,
        'click',
        (e) => e.stopPropagation(),
        renderSignal
      );
      listen(colorBarWrapper, 'keydown', (e) => {
        if (e.key !== 'Escape' || colormapMenu.hidden) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        closeColormapMenu({ restoreFocus: true });
      }, renderSignal);

      colorBarWrapper.appendChild(gradientBar);
      colorBarWrapper.appendChild(colormapMenu);

      const ticks = document.createElement('div');
      ticks.className = 'colorbar-ticks';
      const colorbarMin = model.colorbar?.min ?? model.stats.min;
      const colorbarMax = model.colorbar?.max ?? model.stats.max;
      const minSpan = document.createElement('span');
      minSpan.textContent = formatLegendNumber(colorbarMin);
      const maxSpan = document.createElement('span');
      maxSpan.textContent = formatLegendNumber(colorbarMax);
      ticks.appendChild(minSpan);
      ticks.appendChild(maxSpan);

      const logSwitch = createSwitch({
        label: 'Log color scale',
        checked: Boolean(model.logEnabled),
        onChange: next => {
          state.setContinuousLogScale(state.activeFieldIndex, next);
          refreshColorbarLabels();
        }
      });
      logSwitch.root.classList.add('switch-compact');

      const rescaleSwitch = createSwitch({
        label: 'Rescale to range',
        checked: Boolean(model.colorbar?.usingFilter),
        onChange: next => {
          state.setContinuousColorRescale(state.activeFieldIndex, next);
          if (next) {
            const { newMin, newMax } = getSliderValues();
            state.setContinuousColorRange(state.activeFieldIndex, newMin, newMax);
          }
          refreshColorbarLabels();
        }
      });
      rescaleSwitch.root.classList.add('switch-compact');
      const isRescaling = () => rescaleSwitch.root.getAttribute('aria-checked') === 'true';

      function refreshColorbarLabels() {
        const activeModel = state.getLegendModel(state.getActiveField());
        if (!activeModel || activeModel.kind !== 'continuous') return;
        const cMin = activeModel.colorbar?.min ?? activeModel.stats.min;
        const cMax = activeModel.colorbar?.max ?? activeModel.stats.max;
        minSpan.textContent = formatLegendNumber(cMin);
        maxSpan.textContent = formatLegendNumber(cMax);
        colorHeader.textContent = `Color scale (${activeModel.colormap?.label || 'Viridis'})`;
        logSwitch.setChecked(Boolean(activeModel.logEnabled));
        rescaleSwitch.setChecked(Boolean(activeModel.colorbar?.usingFilter));
      }

      colorSection.appendChild(colorHeader);
      colorSection.appendChild(colorBarWrapper);
      colorSection.appendChild(ticks);
      colorSection.appendChild(createInfoRow(
        logSwitch.root,
        createInfoTip({ tip: 'log-color-scale', label: 'About the log color scale' })
      ));
      colorSection.appendChild(createInfoRow(
        rescaleSwitch.root,
        createInfoTip({ tip: 'color-rescale', label: 'About rescaling colors' })
      ));

      // A constant field has a zero-width range; every slider position then
      // maps onto its one value instead of past the end of the data range.
      const range = model.stats.max - model.stats.min;
      const filterSection = document.createElement('div');
      filterSection.className = 'legend-section legend-filter';
      const filterHeader = document.createElement('h3');
      filterHeader.className = 'section-title';
      filterHeader.textContent = 'Visible range';
      filterSection.appendChild(filterHeader);

      let liveFilteringEnabled = true;
      let filterBtn = null;
      const liveSwitch = createSwitch({
        label: 'Live filtering',
        checked: true,
        onChange: next => {
          setLiveFiltering(next);
          if (next) applyFilterFromSliders();
        }
      });
      liveSwitch.root.classList.add('switch-compact');

      function setLiveFiltering(enabled) {
        liveFilteringEnabled = enabled;
        liveSwitch.setChecked(enabled);
        if (filterBtn) {
          filterBtn.disabled = enabled;
          filterBtn.title = enabled
            ? 'Turn off Live filtering to use Filter'
            : 'Apply the current range';
        }
      }

      filterSection.appendChild(createInfoRow(
        liveSwitch.root,
        createInfoTip({ tip: 'live-filtering', label: 'About live filtering' })
      ));

      const percentOf = value => (range > 0 ? ((value - model.stats.min) / range) * 100 : 0);
      // The filter is applied before the colour range follows the sliders:
      // filtering is in data units and never depends on the colour scale.
      // Each slider's work runs at most once per frame (createSliderField),
      // so a fast drag recomputes visibility once per frame, not per event.
      const onRangeInput = moved => {
        const other = moved === minField ? maxField : minField;
        const minPct = Number(minField.input.value);
        const maxPct = Number(maxField.input.value);
        if (minPct > maxPct) other.setValue(moved === minField ? minPct : maxPct);
        if (liveFilteringEnabled) applyFilterFromSliders();
        updateDisplayFromSliders();
      };
      const minField = createSliderField({
        label: 'Minimum',
        min: 0,
        max: 100,
        step: 1,
        value: Math.round(clamp(percentOf(model.filter.min), 0, 100)),
        format: pct => formatLegendNumber(valueAtPercent(pct)),
        onInput: () => onRangeInput(minField)
      });
      const maxField = createSliderField({
        label: 'Maximum',
        min: 0,
        max: 100,
        step: 1,
        value: range > 0 ? Math.round(clamp(percentOf(model.filter.max), 0, 100)) : 100,
        format: pct => formatLegendNumber(valueAtPercent(pct)),
        onInput: () => onRangeInput(maxField)
      });
      const minSlider = minField.input;
      const maxSlider = maxField.input;
      filterSection.appendChild(minField.root);
      filterSection.appendChild(maxField.root);

      const actions = document.createElement('div');
      actions.className = 'legend-actions';
      filterBtn = createButton({
        label: 'Filter',
        variant: 'primary',
        className: 'btn-compact',
        onClick: () => applyFilterFromSliders()
      });
      const resetBtn = createButton({
        label: 'Reset',
        className: 'btn-compact',
        onClick: () => {
          minField.setValue(0);
          maxField.setValue(100);
          state.resetContinuousFilter(state.activeFieldIndex);
          updateDisplayFromSliders();
        }
      });
      actions.appendChild(filterBtn);
      actions.appendChild(resetBtn);
      filterSection.appendChild(actions);
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
          maxField.setValue(Math.round(maxValPct));
        }
        return {
          newMin: valueAtPercent(minValPct),
          newMax: valueAtPercent(maxValPct)
        };
      }

      // The ends of the track are the data bounds exactly; interior positions
      // are clamped so float rounding can never step outside the data range.
      function valueAtPercent(pct) {
        if (pct <= 0) return model.stats.min;
        if (pct >= 100) return model.stats.max;
        return clamp(
          model.stats.min + (pct / 100) * range,
          model.stats.min,
          model.stats.max
        );
      }

      function showRangeReadouts(min, max) {
        minField.readout.textContent = formatLegendNumber(min);
        maxField.readout.textContent = formatLegendNumber(max);
      }

      function updateDisplayFromSliders() {
        const { newMin, newMax } = getSliderValues();
        showRangeReadouts(newMin, newMax);
        if (isRescaling()) {
          state.setContinuousColorRange(state.activeFieldIndex, newMin, newMax);
          refreshColorbarLabels();
        }
      }

      function applyFilterFromSliders() {
        const { newMin, newMax } = getSliderValues();
        state.applyContinuousFilter(state.activeFieldIndex, newMin, newMax);
      }

      setLiveFiltering(true);
      // Rendering only reads state. Re-applying the slider positions here
      // rounded a restored or programmatic filter to whole percent steps
      // every time the legend was drawn.
      showRangeReadouts(model.filter.min, model.filter.max);
    }
  }

  function handleOutlierUI(field) {
    if (destroyed) return;
    // What the outlier filter can do for this field, and why; nothing is read.
    outlierControl.render(field);

    if (centroidControls) {
      const isCategorical = Boolean(field && field.kind === 'category');
      centroidControls.hidden = !isCategorical;

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

  // Centroid visibility toggles
  if (centroidPointsCheckbox && viewer) {
    listen(centroidPointsCheckbox, 'change', () => {
      const show = centroidPointsCheckbox.checked;
      const activeViewId = state.getActiveViewId?.() || 'live';
      viewer.setShowCentroidPoints?.(show, activeViewId);
    });
  }

  if (centroidLabelsCheckbox && viewer) {
    listen(centroidLabelsCheckbox, 'change', () => {
      const show = centroidLabelsCheckbox.checked;
      const activeViewId = state.getActiveViewId?.() || 'live';
      viewer.setShowCentroidLabels?.(show, activeViewId);
    });
  }

  setDisplayOptionsVisibility(null);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    const failures = [];
    for (const cleanup of [
      () => renderLifecycleController.abort(),
      () => lifecycleController.abort(),
      () => outlierControl.destroy(),
      () => countsGate?.destroy(),
      destroyCategoricalLegend
    ]) {
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    const exactFailures = [...new Set(failures)];
    if (exactFailures.length === 1) throw exactFailures[0];
    if (exactFailures.length > 1) {
      throw new AggregateError(
        exactFailures,
        'Legend renderer failed to release every owned resource.'
      );
    }
  }

  return {
    render,
    refreshCategoryCounts: () => {
      if (destroyed) return;
      if (!legendEl) {
        refreshCategoryCounts();
        return;
      }
      countsGate ??= createVisibilityGatedRender(legendEl, () => {
        if (!destroyed) refreshCategoryCounts();
      });
      countsGate.request();
    },
    handleOutlierUI,
    destroy,
  };
}
