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
import { initCategoricalLegend } from './legend/categorical-legend.js';
import { createGeneReadLink } from './gene-read-control.js';
import { geneSampleLayersNote } from '../../../data/gene-read-plan.js';
import { createVisibilityGatedRender } from '../core/visibility-gate.js';
import {
  coalesceToFrame,
  createButton,
  createInfoRow,
  createInfoTip,
  createSwitch
} from '../components/controls.js';
import { SLIDER_STEPS, boundText, createRangeScale, parseBound } from './legend/range-bounds.js';
import { createDomId } from '../components/dom-id.js';
import { initOutlierFilterControl } from './outlier-filter-control.js';
import { createLatestDispatch, dispatchFromControl } from '../../actions/control-dispatch.js';
import { PLACES } from '../place-names.js';
import { formatSignificant } from '../../../utils/format-units.js';


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
    syncCategoryState,
    destroy: destroyCategoricalLegend
  } = initCategoricalLegend({ state, legendEl, dataSourceManager });
  /**
   * The continuous legend shows the field's state as it is now: its colour
   * scale, switches and visible range (a change made by an undo, an agent or
   * a notebook reaches it here). Null while no continuous legend is drawn.
   * @type {(() => void)|null}
   */
  let syncContinuous = null;
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
    syncContinuous = null;
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
      // The field as the actions name it: every change below is dispatched
      // (`app/actions/`), and the legend follows the state (`syncContinuous`).
      const fieldRef = { source: state.activeFieldSource, key: field.key };
      // How the range sliders map onto values, re-drawn when the log switch
      // changes it (set with the range filter below).
      let remapSliders = null;
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
      colormapMenu.id = createDomId('legend-colormap-menu');
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
            void dispatchFromControl(
              'color.continuous.colormap',
              { field: fieldRef, colormap: cm.id },
              { failure: 'Could not change the colour map' }
            ).then(() => {
              if (destroyed || renderSignal.aborted) return;
              render(state.getActiveField());
              // The legend was rebuilt; keep focus on the new palette control.
              legendEl.querySelector('.colorbar-gradient')?.focus();
            });
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
      minSpan.textContent = formatSignificant(colorbarMin);
      const maxSpan = document.createElement('span');
      maxSpan.textContent = formatSignificant(colorbarMax);
      ticks.appendChild(minSpan);
      ticks.appendChild(maxSpan);

      // Gray for zero (`setContinuousZeroGray`): off, a gene's 0 takes the
      // scale's lowest colour; on, the theme's gray beneath the expressing
      // cells. Offered for a gene with no negative value (`zeroGray.applies`);
      // on a log scale a 0 has no logarithm and is gray either way.
      const zeroGraySwitch = createSwitch({
        label: 'Gray for zero',
        checked: Boolean(model.zeroGray?.enabled),
        onChange: next => {
          void dispatchFromControl(
            'color.continuous.zero-gray',
            { field: fieldRef, enabled: next },
            { failure: 'Could not change gray for zero' }
          ).then(() => refreshColorbarLabels());
        }
      });
      zeroGraySwitch.root.classList.add('switch-compact', 'legend-zero-gray-switch');
      const zeroGrayRow = createInfoRow(
        zeroGraySwitch.root,
        createInfoTip({ tip: 'zero-gray', label: 'About gray for zero' })
      );
      const syncZeroGray = activeModel => {
        const zeroGray = activeModel.zeroGray ?? null;
        zeroGrayRow.hidden = zeroGray?.applies !== true;
        zeroGraySwitch.setChecked(Boolean(zeroGray?.enabled));
        // On a log scale a 0 has no colour: the switch has nothing to change.
        zeroGraySwitch.root.disabled = Boolean(activeModel.logEnabled);
        zeroGraySwitch.root.title = activeModel.logEnabled ? 'On a log scale 0 has no logarithm, so it is gray either way.' : '';
      };
      syncZeroGray(model);

      const logSwitch = createSwitch({
        label: 'Log color scale',
        checked: Boolean(model.logEnabled),
        onChange: next => {
          void dispatchFromControl(
            'color.continuous.log',
            { field: fieldRef, enabled: next },
            { failure: 'Could not change the colour scale' }
          ).then(() => refreshColorbarLabels());
        }
      });
      logSwitch.root.classList.add('switch-compact');

      const rescaleSwitch = createSwitch({
        label: 'Rescale to range',
        checked: Boolean(model.colorbar?.usingFilter),
        onChange: next => {
          void dispatchFromControl(
            'color.continuous.rescale',
            { field: fieldRef, enabled: next },
            { failure: 'Could not rescale the colours' }
          ).then(() => refreshColorbarLabels());
        }
      });
      rescaleSwitch.root.classList.add('switch-compact');
      const isRescaling = () => rescaleSwitch.root.getAttribute('aria-checked') === 'true';

      // What the colour scale showed last: drawn again only when it changed
      // (a visibility change asks on every frame of a drag).
      let shownScale = null;
      function refreshColorbarLabels() {
        if (destroyed || renderSignal.aborted || state.getActiveField() !== field) return;
        const activeModel = state.getLegendModel(field);
        if (!activeModel || activeModel.kind !== 'continuous') return;
        const cMin = activeModel.colorbar?.min ?? activeModel.stats.min;
        const cMax = activeModel.colorbar?.max ?? activeModel.stats.max;
        const scale = [
          activeModel.colormap?.id, activeModel.logEnabled, cMin, cMax, activeModel.zeroGray?.enabled,
          activeModel.zeroGray?.applies, activeModel.zeroGray?.drawn, activeModel.colorbar?.usingFilter,
          activeModel.colorbar?.centered, activeModel.geneSample != null,
        ].join('|');
        if (scale === shownScale) return;
        shownScale = scale;
        minSpan.textContent = formatSignificant(cMin);
        maxSpan.textContent = formatSignificant(cMax);
        const colormapLabel = activeModel.colormap?.label || 'Viridis';
        colorHeader.textContent = `Color scale (${colormapLabel})`;
        StyleManager.setVariable(gradientBar, '--colorbar-stops', activeModel.colorStops.join(', '));
        gradientBar.setAttribute('aria-label', `Color palette: ${colormapLabel}`);
        if (activeModel.logEnabled !== shownLog) {
          shownLog = activeModel.logEnabled;
          remapSliders?.(activeModel);
        }
        syncLayerNote(activeModel);
        syncZeroGray(activeModel);
        syncCentreNote(activeModel);
        logSwitch.setChecked(Boolean(activeModel.logEnabled));
        rescaleSwitch.setChecked(Boolean(activeModel.colorbar?.usingFilter));
      }

      colorSection.appendChild(colorHeader);
      colorSection.appendChild(colorBarWrapper);
      colorSection.appendChild(ticks);
      // A gene read for a sample of the open cells: one line naming each
      // state beside a dot of the colour it is drawn in, made from the
      // view's background (`--cell-zero-color`, `--cell-unread-color`:
      // `rendering/read-cell-layer.js`, set by the viewer): cells not read,
      // and, when its zeros are gray (`zeroGray.drawn`), the gray for 0
      // (`geneSampleLayersNote`). Without a sample the switch says it.
      const layerNote = document.createElement('p');
      layerNote.className = 'field-help legend-layer-note';
      const layerSwatch = layer => {
        const swatch = document.createElement('span');
        swatch.className = `legend-layer-swatch is-${layer}`;
        swatch.setAttribute('aria-hidden', 'true');
        return swatch;
      };
      const syncLayerNote = activeModel => {
        const sampled = activeModel.geneSample != null;
        layerNote.hidden = !sampled;
        if (!sampled) return;
        const [unreadWords, zeroWords = null] = geneSampleLayersNote(activeModel.zeroGray?.drawn === true).split(' · ');
        layerNote.replaceChildren(layerSwatch('unread'), unreadWords, ...(zeroWords === null ? [] : [' · ', layerSwatch('zero'), zeroWords]));
      };
      syncLayerNote(model);
      colorSection.appendChild(layerNote);
      // How many open cells a gene is read for, as a link to where that is
      // chosen (Session › Open data, `gene-read-control.js`).
      const geneReadLink = createGeneReadLink(state, renderSignal);
      if (geneReadLink !== null) colorSection.appendChild(geneReadLink);
      // A diverging map over data spanning 0 is centred there: said here.
      const centreNote = document.createElement('p');
      centreNote.className = 'field-help legend-centre-note';
      centreNote.textContent = 'Centred at 0: the scale runs from −max to max of |value|, so 0 is its middle.';
      const syncCentreNote = activeModel => {
        centreNote.hidden = activeModel.colorbar?.centered !== true;
      };
      syncCentreNote(model);
      colorSection.appendChild(centreNote);
      // A column with no value among the open cells draws every cell as missing.
      if (!Number.isFinite(model.stats?.min)) {
        const emptyNote = document.createElement('p');
        emptyNote.className = 'field-help legend-empty-note';
        emptyNote.textContent = 'No value among the open cells: every cell is drawn gray, as missing.';
        colorSection.appendChild(emptyNote);
      }
      colorSection.appendChild(zeroGrayRow);
      colorSection.appendChild(createInfoRow(
        logSwitch.root,
        createInfoTip({ tip: 'log-color-scale', label: 'About the log color scale' })
      ));
      colorSection.appendChild(createInfoRow(
        rescaleSwitch.root,
        createInfoTip({ tip: 'color-rescale', label: 'About rescaling colors' })
      ));

      // The bounds of the filter, exact: a slider moves one, a number box
      // types one, and only the bound moved changes (`legend/range-bounds.js`).
      const dataRange = { min: model.stats.min, max: model.stats.max };
      const scaleOf = activeModel => createRangeScale({
        min: activeModel.stats.min,
        max: activeModel.stats.max,
        positiveMin: activeModel.positiveStats?.min ?? null,
        log: Boolean(activeModel.logEnabled)
      });
      let sliderScale = scaleOf(model);
      const bounds = { min: model.filter.min, max: model.filter.max };
      const filterSection = document.createElement('div');
      filterSection.className = 'legend-section legend-filter';
      const filterHeader = document.createElement('h3');
      filterHeader.className = 'section-title';
      filterHeader.textContent = PLACES.visibleRange.name;
      filterSection.appendChild(filterHeader);

      let liveFilteringEnabled = true;
      let filterBtn = null;
      // The log setting the sliders map with, and the range the filter had
      // when the legend last showed it: a change of either made elsewhere
      // (an undo, an agent) is shown; the bounds being moved here are not
      // overwritten meanwhile (Live filtering off, or a drag being applied).
      let shownLog = Boolean(model.logEnabled);
      let shownFilter = { min: model.filter.min, max: model.filter.max };
      const rangeDispatch = createLatestDispatch('filter.continuous.range', {
        failure: 'Could not set the visible range',
        onSettled: () => syncContinuous?.(),
      });
      const colorRangeDispatch = createLatestDispatch('color.continuous.range', {
        failure: 'Could not set the colour range',
        onSettled: () => refreshColorbarLabels(),
      });
      const liveSwitch = createSwitch({
        label: 'Live filtering',
        checked: true,
        onChange: next => {
          setLiveFiltering(next);
          if (next) applyFilter();
        }
      });
      liveSwitch.root.classList.add('switch-compact');

      // Filter is offered only while Live filtering is off: with it on, every
      // move already applies the range, and a disabled Filter beside the
      // switch said the same thing twice.
      function setLiveFiltering(enabled) {
        liveFilteringEnabled = enabled;
        liveSwitch.setChecked(enabled);
        if (filterBtn) filterBtn.hidden = enabled;
      }

      filterSection.appendChild(createInfoRow(
        liveSwitch.root,
        createInfoTip({ tip: 'live-filtering', label: 'About live filtering' })
      ));

      /**
       * A bound's control: a slider and a number box. The slider's work runs
       * at most once per frame (`coalesceToFrame`), so a fast drag recomputes
       * visibility once per frame, not per event; the box applies what is
       * typed when it is committed (Enter, or leaving it).
       */
      const boundField = (which, label) => {
        // A minted id (`createDomId`): it names nothing on another page, so
        // the session's control inventory leaves the box out; the bound it
        // holds is the field's filter, which the session saves.
        const id = createDomId(`legend-range-${which}`);
        const labelEl = document.createElement('label');
        labelEl.className = 'legend-range-label';
        labelEl.htmlFor = id;
        labelEl.textContent = label;
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = String(SLIDER_STEPS);
        slider.step = '1';
        slider.setAttribute('aria-label', `${label}, slider`);
        const box = document.createElement('input');
        box.type = 'text';
        box.id = id;
        box.className = 'obs-select slider-number';
        box.setAttribute('inputmode', 'decimal');
        box.setAttribute('autocomplete', 'off');
        box.setAttribute('spellcheck', 'false');
        // Label, slider and box on one row of the bounds' grid.
        boundsGrid.append(labelEl, slider, box);
        const slid = coalesceToFrame(() => setBound(which, sliderScale.valueAt(Number(slider.value)), 'slider'));
        listen(slider, 'input', () => slid(), renderSignal);
        listen(slider, 'change', () => slid.flush(), renderSignal);
        const commitBox = () => {
          const typed = parseBound(box.value, dataRange);
          // Not a number, or the bound already (Enter, then the change event
          // leaving the box fires): nothing to apply.
          if (typed === null || typed === bounds[which]) {
            showBox(box, bounds[which]);
            return;
          }
          setBound(which, typed, 'box');
        };
        listen(box, 'change', commitBox, renderSignal);
        listen(box, 'keydown', event => {
          if (event.key === 'Enter') commitBox();
        }, renderSignal);
        return { slider, box };
      };
      // The two bounds in one grid: their labels, sliders and boxes aligned
      // in columns, a row each (`.legend-range-bounds`).
      const boundsGrid = document.createElement('div');
      boundsGrid.className = 'slider-row legend-range-bounds';
      const minField = boundField('min', 'Minimum');
      const maxField = boundField('max', 'Maximum');
      filterSection.appendChild(boundsGrid);

      const actions = document.createElement('div');
      actions.className = 'legend-actions';
      filterBtn = createButton({
        label: 'Filter',
        variant: 'primary',
        title: 'Apply the current range',
        className: 'btn-compact',
        onClick: () => applyFilter()
      });
      const resetBtn = createButton({
        label: 'Reset',
        className: 'btn-compact',
        onClick: () => {
          bounds.min = dataRange.min;
          bounds.max = dataRange.max;
          showBounds();
          void dispatchFromControl(
            'filter.continuous.reset',
            { field: fieldRef },
            { failure: 'Could not reset the visible range' }
          ).then(() => refreshColorbarLabels());
        }
      });
      actions.appendChild(filterBtn);
      actions.appendChild(resetBtn);
      filterSection.appendChild(actions);
      legendEl.appendChild(colorSection);
      legendEl.appendChild(filterSection);

      /**
       * A number box shows its bound in as many figures as it holds
       * (`boundText`); the exact value is its title.
       */
      function showBox(box, value) {
        box.value = boundText(value);
        box.title = String(value);
      }

      /** The sliders and boxes show the bounds; a box being typed in is left alone. */
      function showBounds() {
        minField.slider.value = String(sliderScale.positionOf(bounds.min, 'min'));
        maxField.slider.value = String(sliderScale.positionOf(bounds.max, 'max'));
        showBox(minField.box, bounds.min);
        showBox(maxField.box, bounds.max);
      }

      /**
       * Set one bound exactly; the other moves only when it would cross it.
       * The filter applies (live), then the colour range follows when
       * rescaling: filtering is in data units and never depends on the
       * colour scale.
       */
      function setBound(which, value, from) {
        bounds[which] = value;
        if (bounds.min > bounds.max) {
          if (which === 'min') bounds.max = bounds.min;
          else bounds.min = bounds.max;
        }
        if (from === 'box') {
          (which === 'min' ? minField : maxField).slider.value = String(sliderScale.positionOf(value, which));
        }
        // The slider that moved keeps its position; everything else shows the bounds.
        const moved = from === 'slider' ? (which === 'min' ? minField : maxField) : null;
        for (const field of [minField, maxField]) {
          const bound = field === minField ? bounds.min : bounds.max;
          showBox(field.box, bound);
          if (field !== moved && from === 'slider') field.slider.value = String(sliderScale.positionOf(bound, field === minField ? 'min' : 'max'));
        }
        // Applied, the range's colours follow it when rescaling (the action
        // does both); with Live filtering off only the colours follow.
        if (liveFilteringEnabled) applyFilter();
        else followColorRange();
      }

      function followColorRange() {
        if (isRescaling()) colorRangeDispatch.push({ field: fieldRef, min: bounds.min, max: bounds.max });
      }

      function applyFilter() {
        rangeDispatch.push({ field: fieldRef, min: bounds.min, max: bounds.max });
      }

      syncContinuous = () => {
        if (destroyed || renderSignal.aborted || state.getActiveField() !== field) return;
        refreshColorbarLabels();
        if (rangeDispatch.pending || colorRangeDispatch.pending) return;
        const filter = state.getLegendModel(field).filter;
        if (filter.min === shownFilter.min && filter.max === shownFilter.max) return;
        shownFilter = { min: filter.min, max: filter.max };
        bounds.min = filter.min;
        bounds.max = filter.max;
        showBounds();
      };

      // The colour scale's switch changes how the sliders map (log or not),
      // never the bounds.
      remapSliders = activeModel => {
        sliderScale = scaleOf(activeModel);
        showBounds();
      };

      setLiveFiltering(true);
      // Rendering only reads state: the bounds shown are the filter's, exactly.
      showBounds();
    }
  }

  function handleOutlierUI(field) {
    if (destroyed) return;
    // What the outlier filter can do for this field, and why; nothing is read.
    outlierControl.render(field);

    if (centroidControls) {
      const isCategorical = Boolean(field && field.kind === 'category');
      centroidControls.hidden = !isCategorical;

      // The toggles show the focused view's own flags (the `views` state
      // domain holds them per view), shown or not: a restore that changed a
      // flag, or another view focused, is read here.
      if (viewer) {
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
      () => unsubscribeColors?.(),
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

  // A recolour or a colour-scale change made anywhere (an undo, an agent, a
  // notebook) is shown in place; a visibility change reaches the counts and
  // the visible range through `refreshCategoryCounts` below.
  const unsubscribeColors = state.on?.('colors:changed', () => {
    if (destroyed) return;
    syncCategoryState();
    syncContinuous?.();
  }) ?? null;

  return {
    render,
    refreshCategoryCounts: () => {
      if (destroyed) return;
      syncContinuous?.();
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
