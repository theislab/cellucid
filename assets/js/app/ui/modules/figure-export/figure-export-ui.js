/**
 * @fileoverview Figure export UI (accordion panel).
 *
 * Builds a compact control panel for publication-grade exports without adding
 * any work to the normal render loop.
 *
 * @module ui/modules/figure-export/figure-export-ui
 */

import { createElement, clearElement } from '../../../utils/dom-utils.js';
import { clamp, parseNumberOr } from '../../../utils/number-utils.js';
import { getNotificationCenter } from '../../../notification-center.js';
import { maybeShowCitationModal } from './components/citation-modal.js';
import { promptLargeDatasetStrategy } from './components/large-dataset-dialog.js';
import { computeSingleViewLayout, computeGridDims } from './utils/layout.js';
import { reducePointsByDensity } from './utils/density-reducer.js';
import { getEffectivePointDiameterPx, getLodVisibilityMask } from './utils/point-size.js';
import { drawCanvasLegend } from './components/legend-builder.js';
import { drawCanvasAxes } from './components/axes-builder.js';
import { drawCanvasCentroidOverlay } from './components/centroid-overlay.js';
import { denormalizeXY } from './utils/coordinate-mapper.js';
import { drawCanvasOrientationIndicator } from './components/orientation-indicator.js';
import { applyColorblindSimulationToImageData } from './utils/colorblindness.js';
import { normalizeCropRect01 } from './utils/crop.js';

const DEFAULT_SIZE = { width: 1200, height: 900 };
const LARGE_DATASET_THRESHOLD = 50000;

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {HTMLElement} options.container
 * @param {{ exportFigure: (opts: any) => Promise<any> }} options.engine
 */
export function initFigureExportUI({ state, viewer, container, engine }) {
  clearElement(container);

  const presets = [
    { label: 'Screen (current)', value: 'screen' },
    { label: '1200 × 900', value: '1200x900' },
    { label: '1600 × 1200', value: '1600x1200' },
    { label: '1920 × 1080', value: '1920x1080' },
  ];

  const header = createElement('div', { className: 'legend-help' }, [
    'Export the current view as publication-ready SVG or high-DPI PNG.'
  ]);

  // ─────────────────────────────────────────────────────────────────────────
  // Plot size + framing
  // ─────────────────────────────────────────────────────────────────────────
  const sizeRow = createElement('div', { className: 'control-block' });
  sizeRow.appendChild(createElement('label', {}, ['Plot size']));

  const presetSelect = createElement('select', { className: 'obs-select', 'aria-label': 'Export size preset' });
  presets.forEach((p) => {
    presetSelect.appendChild(createElement('option', { value: p.value }, [p.label]));
  });

  const widthInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: String(DEFAULT_SIZE.width),
    min: '100',
    max: '20000',
    step: '10',
    inputMode: 'numeric',
    'aria-label': 'Export width (px)'
  });
  const heightInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: String(DEFAULT_SIZE.height),
    min: '100',
    max: '20000',
    step: '10',
    inputMode: 'numeric',
    'aria-label': 'Export height (px)'
  });

  const sizeGrid = createElement('div', { className: 'figure-export-size-row' }, [
    presetSelect,
    createElement('div', { className: 'figure-export-inline' }, [
      createElement('span', { className: 'figure-export-label' }, ['W']),
      widthInput,
      createElement('span', { className: 'figure-export-label' }, ['H']),
      heightInput,
    ])
  ]);
  sizeRow.appendChild(sizeGrid);
  sizeRow.appendChild(createElement('div', { className: 'figure-export-hint' }, [
    'Plot size sets the exported plot resolution; axes/legend/title add extra space around it. Framing chooses which region fills the plot.'
  ]));

  const framingSection = createElement('div', { className: 'control-block' });
  framingSection.appendChild(createElement('label', {}, ['Framing']));

  const cropEnabledCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-crop-enabled' });
  const cropResetBtn = createElement('button', { type: 'button', className: 'btn-small' }, ['Reset']);
  const cropAspectHint = createElement('span', { className: 'figure-export-crop-aspect' }, ['Aspect: —']);

  const framingControls = createElement('div', { className: 'figure-export-framing-controls' }, [
    createElement('label', { className: 'checkbox-inline', htmlFor: cropEnabledCheckbox.id }, [
      cropEnabledCheckbox,
      ' Frame export'
    ]),
    cropResetBtn,
    cropAspectHint
  ]);
  const framingHint = createElement('div', { className: 'figure-export-crop-hint' }, [
    'Frame matches Plot size. Turn on Preview to move/resize the frame.'
  ]);
  framingSection.appendChild(framingControls);
  framingSection.appendChild(framingHint);

  const plotAndFrameRow = createElement('div', { className: 'figure-export-plot-frame' }, [
    sizeRow,
    framingSection
  ]);

  // ─────────────────────────────────────────────────────────────────────────
  // Style section
  // ─────────────────────────────────────────────────────────────────────────
  const styleSection = createElement('div', { className: 'control-block figure-export-section' });
  styleSection.appendChild(createElement('label', {}, ['Style']));

  const backgroundSelect = createElement('select', { className: 'obs-select', 'aria-label': 'Background' });
  backgroundSelect.appendChild(createElement('option', { value: 'white' }, ['White BG']));
  backgroundSelect.appendChild(createElement('option', { value: 'transparent' }, ['Transparent']));
  backgroundSelect.appendChild(createElement('option', { value: 'custom' }, ['Custom…']));
  const backgroundColorInput = createElement('input', { type: 'color', className: 'figure-color-picker', value: '#ffffff', 'aria-label': 'Custom background color' });

  const fontSelect = createElement('select', { className: 'obs-select', 'aria-label': 'Font family' });
  [
    { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
    { label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
    { label: 'Times', value: '"Times New Roman", Times, serif' },
  ].forEach((f) => fontSelect.appendChild(createElement('option', { value: f.value }, [f.label])));

  const fontSizeInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: '12',
    min: '6',
    max: '24',
    step: '1',
    inputMode: 'numeric',
    'aria-label': 'Base font size (px)'
  });

  const autoTextSizingCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-text-auto', checked: true });

  const legendFontSizeInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: '12',
    min: '6',
    max: '24',
    step: '1',
    inputMode: 'numeric',
    'aria-label': 'Legend font size (px)'
  });
  const tickFontSizeInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: '12',
    min: '6',
    max: '24',
    step: '1',
    inputMode: 'numeric',
    'aria-label': 'Tick font size (px)'
  });
  const axisLabelFontSizeInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: '12',
    min: '6',
    max: '36',
    step: '1',
    inputMode: 'numeric',
    'aria-label': 'Axis label font size (px)'
  });
  const titleFontSizeInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: '15',
    min: '8',
    max: '48',
    step: '1',
    inputMode: 'numeric',
    'aria-label': 'Title font size (px)'
  });
  const centroidLabelFontSizeInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: '12',
    min: '6',
    max: '36',
    step: '1',
    inputMode: 'numeric',
    'aria-label': 'Centroid label font size (px)'
  });

  // Point radius removed - export now uses viewer's pointSize directly (WYSIWYG)

  const styleGrid = createElement('div', { className: 'figure-export-style-grid' }, [
    createElement('div', { className: 'figure-export-style-row' }, [
      backgroundSelect,
      backgroundColorInput,
    ]),
    createElement('div', { className: 'figure-export-style-row' }, [
      fontSelect,
      createElement('span', { className: 'figure-export-label' }, ['pt']),
      fontSizeInput,
    ]),
    createElement('div', { className: 'figure-export-style-row' }, [
      createElement('label', { className: 'checkbox-inline', htmlFor: autoTextSizingCheckbox.id }, [
        autoTextSizingCheckbox,
        ' Auto text'
      ]),
      createElement('div', { className: 'figure-export-inline' }, [
        createElement('span', { className: 'figure-export-label' }, ['Legend']),
        legendFontSizeInput,
        createElement('span', { className: 'figure-export-label' }, ['Ticks']),
        tickFontSizeInput,
      ]),
    ]),
    createElement('div', { className: 'figure-export-style-row' }, [
      createElement('div', { className: 'figure-export-inline' }, [
        createElement('span', { className: 'figure-export-label' }, ['Axis']),
        axisLabelFontSizeInput,
        createElement('span', { className: 'figure-export-label' }, ['Title']),
        titleFontSizeInput,
        createElement('span', { className: 'figure-export-label' }, ['Centroids']),
        centroidLabelFontSizeInput,
      ]),
    ]),
  ]);
  styleSection.appendChild(styleGrid);

  const titleRow = createElement('div', { className: 'control-block' });
  titleRow.appendChild(createElement('label', { htmlFor: 'figure-export-title' }, ['Title']));
  const titleInput = createElement('input', {
    id: 'figure-export-title',
    type: 'text',
    className: 'figure-input',
    placeholder: 'Optional figure title',
    'aria-label': 'Figure title'
  });
  titleRow.appendChild(titleInput);

  const xLabelRow = createElement('div', { className: 'control-block' });
  xLabelRow.appendChild(createElement('label', { htmlFor: 'figure-export-xlabel' }, ['X axis label']));
  const xLabelInput = createElement('input', {
    id: 'figure-export-xlabel',
    type: 'text',
    className: 'figure-input',
    value: 'X',
    placeholder: 'e.g., UMAP_1',
    'aria-label': 'X axis label'
  });
  xLabelRow.appendChild(xLabelInput);

  const yLabelRow = createElement('div', { className: 'control-block' });
  yLabelRow.appendChild(createElement('label', { htmlFor: 'figure-export-ylabel' }, ['Y axis label']));
  const yLabelInput = createElement('input', {
    id: 'figure-export-ylabel',
    type: 'text',
    className: 'figure-input',
    value: 'Y',
    placeholder: 'e.g., UMAP_2',
    'aria-label': 'Y axis label'
  });
  yLabelRow.appendChild(yLabelInput);

  // ─────────────────────────────────────────────────────────────────────────
  // Annotations section
  // ─────────────────────────────────────────────────────────────────────────
  const annotationSection = createElement('div', { className: 'control-block figure-export-section' });
  annotationSection.appendChild(createElement('label', {}, ['Include']));
  const includeAxesCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-axes', checked: true });
  const includeLegendCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-legend', checked: true });
  const includeCentroidPointsCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-centroid-points', checked: true });
  const includeCentroidLabelsCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-centroid-labels', checked: true });
  const showCitationCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-citation', checked: true });
  const showOrientationCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-orientation', checked: true });
  const depthSortCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-depthsort', checked: true });

  const annotationChecks = createElement('div', { className: 'figure-export-checks' }, [
    createElement('label', { className: 'checkbox-inline', htmlFor: includeAxesCheckbox.id }, [includeAxesCheckbox, ' Axes']),
    createElement('label', { className: 'checkbox-inline', htmlFor: includeLegendCheckbox.id }, [includeLegendCheckbox, ' Legend']),
    createElement('label', { className: 'checkbox-inline', htmlFor: includeCentroidPointsCheckbox.id }, [includeCentroidPointsCheckbox, ' Centroid pts']),
    createElement('label', { className: 'checkbox-inline', htmlFor: includeCentroidLabelsCheckbox.id }, [includeCentroidLabelsCheckbox, ' Centroid text']),
    createElement('label', { className: 'checkbox-inline', htmlFor: showCitationCheckbox.id }, [showCitationCheckbox, ' Cite']),
    createElement('label', { className: 'checkbox-inline', htmlFor: showOrientationCheckbox.id }, [showOrientationCheckbox, ' 3D orient']),
    createElement('label', { className: 'checkbox-inline', htmlFor: depthSortCheckbox.id }, [depthSortCheckbox, ' Depth']),
  ]);
  annotationSection.appendChild(annotationChecks);

  const legendPosSelect = createElement('select', { className: 'obs-select', 'aria-label': 'Legend position' });
  legendPosSelect.appendChild(createElement('option', { value: 'right' }, ['Legend: Right']));
  legendPosSelect.appendChild(createElement('option', { value: 'bottom' }, ['Legend: Bottom']));

  const annotationOpts = createElement('div', { className: 'figure-export-style-row' }, [
    legendPosSelect,
  ]);
  annotationSection.appendChild(annotationOpts);

  // ─────────────────────────────────────────────────────────────────────────
  // Selection & Preview section
  // ─────────────────────────────────────────────────────────────────────────
  const selectionRow = createElement('div', { className: 'control-block figure-export-row' });
  const emphasizeSelectionCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-selection-emphasis' });
  const selectionMutedOpacityInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: '0.15',
    min: '0',
    max: '1',
    step: '0.05',
    inputMode: 'decimal',
    'aria-label': 'Non-selected opacity (0..1)'
  });
  selectionRow.appendChild(createElement('label', { className: 'checkbox-inline', htmlFor: emphasizeSelectionCheckbox.id }, [
    emphasizeSelectionCheckbox,
    ' Emphasize selection'
  ]));
  selectionRow.appendChild(createElement('div', { className: 'figure-export-inline' }, [
    createElement('span', { className: 'figure-export-label' }, ['α']),
    selectionMutedOpacityInput,
  ]));

  const previewRow = createElement('div', { className: 'control-block' });
  previewRow.appendChild(createElement('label', {}, ['Preview']));
  const previewEnabledCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-preview-enabled' });
  const previewRefreshBtn = createElement('button', { type: 'button', className: 'btn-small' }, ['Refresh']);
  const previewModeSelect = createElement('select', { className: 'obs-select', 'aria-label': 'Colorblind preview' });
  previewModeSelect.appendChild(createElement('option', { value: 'none' }, ['Normal']));
  previewModeSelect.appendChild(createElement('option', { value: 'deuteranopia' }, ['Deuteranopia']));
  previewModeSelect.appendChild(createElement('option', { value: 'protanopia' }, ['Protanopia']));
  previewModeSelect.appendChild(createElement('option', { value: 'tritanopia' }, ['Tritanopia']));

  const previewControls = createElement('div', { className: 'figure-export-preview-controls' }, [
    createElement('label', { className: 'checkbox-inline', htmlFor: previewEnabledCheckbox.id }, [
      previewEnabledCheckbox,
      ' Show'
    ]),
    previewModeSelect,
    previewRefreshBtn
  ]);
  previewRow.appendChild(previewControls);

  const previewStatus = createElement('div', { className: 'figure-export-preview-status' }, [
    'Preview is off.'
  ]);
  const previewCanvas = createElement('canvas', {
    className: 'figure-export-preview',
    width: '360',
    height: '240',
    role: 'img',
    'aria-label': 'Figure export preview'
  });
  const previewBox = createElement('div', { className: 'figure-export-preview-box' }, [
    previewCanvas,
    previewStatus
  ]);

  // ─────────────────────────────────────────────────────────────────────────
  // Advanced & Export section
  // ─────────────────────────────────────────────────────────────────────────
  const advancedSection = createElement('div', { className: 'control-block figure-export-section' });
  advancedSection.appendChild(createElement('label', {}, ['Download']));

  const downloadSelect = createElement('select', { className: 'obs-select', 'aria-label': 'Download format' });
  downloadSelect.appendChild(createElement('option', { value: 'svg' }, ['SVG']));
  downloadSelect.appendChild(createElement('option', { value: 'png' }, ['PNG']));
  downloadSelect.appendChild(createElement('option', { value: 'svg+png' }, ['SVG + PNG']));
  downloadSelect.appendChild(createElement('option', { value: 'png-multi' }, ['PNG (150/300/600)']));
  downloadSelect.appendChild(createElement('option', { value: 'all' }, ['All']));

  const dpiSelect = createElement('select', { className: 'obs-select', 'aria-label': 'PNG DPI' });
  [150, 300, 600].forEach((dpi) => {
    dpiSelect.appendChild(createElement('option', { value: String(dpi) }, [String(dpi)]));
  });
  dpiSelect.value = '300';

  const strategySelect = createElement('select', { className: 'obs-select', 'aria-label': 'Large dataset strategy' });
  strategySelect.appendChild(createElement('option', { value: 'ask' }, ['Large data: Ask']));
  strategySelect.appendChild(createElement('option', { value: 'full-vector' }, ['Full vector']));
  strategySelect.appendChild(createElement('option', { value: 'optimized-vector' }, ['Optimized vector']));
  strategySelect.appendChild(createElement('option', { value: 'hybrid' }, ['Hybrid']));
  strategySelect.appendChild(createElement('option', { value: 'raster' }, ['Raster (PNG)']));

  const largeDatasetThresholdInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: String(LARGE_DATASET_THRESHOLD),
    min: '1000',
    max: '2000000',
    step: '1000',
    inputMode: 'numeric',
    'aria-label': 'Large dataset threshold (points)'
  });
  const optimizedTargetCountInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: '100000',
    min: '1000',
    max: '5000000',
    step: '1000',
    inputMode: 'numeric',
    'aria-label': 'Optimized vector target points'
  });
  const thresholdGroup = createElement('div', { className: 'figure-export-inline', id: 'figure-export-threshold-group' }, [
    createElement('span', { className: 'figure-export-label' }, ['Ask ≥']),
    largeDatasetThresholdInput,
  ]);
  const targetGroup = createElement('div', { className: 'figure-export-inline', id: 'figure-export-target-group' }, [
    createElement('span', { className: 'figure-export-label' }, ['Keep']),
    optimizedTargetCountInput,
  ]);
  const densitySettingsRow = createElement('div', { className: 'figure-export-style-row', id: 'figure-export-density-settings' }, [
    thresholdGroup,
    targetGroup,
  ]);
  const densityHint = createElement('div', { className: 'figure-export-hint' }, [
    'Optimized vector reduces point count while preserving density. Hybrid rasterizes points with the WebGL shader for WYSIWYG 3D exports.'
  ]);

  const advancedGrid = createElement('div', { className: 'figure-export-style-row' }, [
    downloadSelect,
    dpiSelect,
    strategySelect,
  ]);
  advancedSection.appendChild(advancedGrid);
  advancedSection.appendChild(densitySettingsRow);
  advancedSection.appendChild(densityHint);

  const exportAllViewsCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-all-views' });
  advancedSection.appendChild(createElement('label', { className: 'checkbox-inline', htmlFor: exportAllViewsCheckbox.id }, [
    exportAllViewsCheckbox,
    ' Export all views (split-view)'
  ]));

  const actionsRow = createElement('div', { className: 'figure-export-actions' });
  const exportBtn = createElement('button', { type: 'button', className: 'btn-small', id: 'figure-export-btn' }, ['Export']);
  actionsRow.appendChild(exportBtn);

  function syncFormatDependentUi() {
    const mode = downloadSelect.value || 'svg';
    const needsPng = mode === 'png' || mode === 'svg+png' || mode === 'png-multi' || mode === 'all';
    const needsSvg = mode === 'svg' || mode === 'svg+png' || mode === 'all';
    const multiPng = mode === 'png-multi' || mode === 'all';

    const strategy = strategySelect.value || 'ask';
    const showDensity = needsSvg && (strategy === 'ask' || strategy === 'optimized-vector');
    densitySettingsRow.style.display = showDensity ? 'flex' : 'none';
    densityHint.style.display = showDensity ? 'block' : 'none';
    thresholdGroup.style.display = (showDensity && strategy === 'ask') ? 'inline-flex' : 'none';
    targetGroup.style.display = showDensity ? 'inline-flex' : 'none';

    dpiSelect.style.display = needsPng && !multiPng ? 'block' : 'none';
    strategySelect.style.display = needsSvg ? 'block' : 'none';
    backgroundColorInput.style.display = backgroundSelect.value === 'custom' ? 'block' : 'none';
    selectionMutedOpacityInput.parentElement.style.display = emphasizeSelectionCheckbox.checked ? 'inline-flex' : 'none';

    const previewOn = previewEnabledCheckbox.checked;
    previewBox.style.display = previewOn ? 'grid' : 'none';
    previewModeSelect.disabled = !previewOn;
    previewRefreshBtn.disabled = !previewOn;
    if (!previewOn) {
      previewStatus.textContent = 'Preview is off.';
    }
  }

  backgroundSelect.addEventListener('change', syncFormatDependentUi);
  emphasizeSelectionCheckbox.addEventListener('change', syncFormatDependentUi);
  downloadSelect.addEventListener('change', syncFormatDependentUi);
  dpiSelect.addEventListener('change', syncFormatDependentUi);
  strategySelect.addEventListener('change', syncFormatDependentUi);
  previewEnabledCheckbox.addEventListener('change', async () => {
    syncFormatDependentUi();
    syncCropUi();
    if (!previewEnabledCheckbox.checked) {
      clearPreview();
      return;
    }
    if (!previewSample) {
      await buildPreviewSample();
    }
    drawPreview();
  });

  previewRefreshBtn.addEventListener('click', async () => {
    if (!previewEnabledCheckbox.checked) return;
    await buildPreviewSample({ force: true });
    drawPreview();
  });

  previewModeSelect.addEventListener('change', schedulePreviewDraw);

  // Redraw preview on option changes (no sample rebuild).
  const previewInputs = [
    widthInput,
    heightInput,
    titleInput,
    xLabelInput,
    yLabelInput,
    includeAxesCheckbox,
    includeLegendCheckbox,
    includeCentroidPointsCheckbox,
    includeCentroidLabelsCheckbox,
    legendPosSelect,
    backgroundSelect,
    backgroundColorInput,
    fontSelect,
    fontSizeInput,
    legendFontSizeInput,
    tickFontSizeInput,
    axisLabelFontSizeInput,
    titleFontSizeInput,
    centroidLabelFontSizeInput,
    autoTextSizingCheckbox,
    showOrientationCheckbox,
    emphasizeSelectionCheckbox,
    selectionMutedOpacityInput,
    cropEnabledCheckbox,
  ];
  for (const el of previewInputs) {
    el.addEventListener('change', schedulePreviewDraw);
    el.addEventListener('input', schedulePreviewDraw);
  }

  cropEnabledCheckbox.addEventListener('change', () => {
    if (cropEnabledCheckbox.checked) {
      cropEnabled = true;
      if (!previewEnabledCheckbox.checked) {
        previewEnabledCheckbox.checked = true;
        previewEnabledCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      resetCropToDefault();
    } else {
      cropEnabled = false;
    }
    syncCropUi();
    schedulePreviewDraw();
  });

  cropResetBtn.addEventListener('click', () => {
    cropEnabled = true;
    cropEnabledCheckbox.checked = true;
    resetCropToDefault();
    syncCropUi();
    schedulePreviewDraw();
  });

  // ---------------------------------------------------------------------------
  // Text sizing (auto by default; scales with plot size)
  // ---------------------------------------------------------------------------

  function getPlotSizePx() {
    const w = Math.max(100, parseInt(widthInput.value, 10) || DEFAULT_SIZE.width);
    const h = Math.max(100, parseInt(heightInput.value, 10) || DEFAULT_SIZE.height);
    return { w, h };
  }

  function computeAutoTextSizes() {
    const { w, h } = getPlotSizePx();
    const area = Math.sqrt(w * h);
    const base = clamp(Math.round(area / 85), 10, 18);
    const title = Math.max(14, Math.round(base * 1.25));
    const axis = Math.max(10, Math.round(base * 1.05));
    const ticks = base;
    const legend = base;
    return { base, title, axis, ticks, legend };
  }

  function estimateCentroidLabelSizePx({ plotW, plotH }) {
    const viewId = getActiveViewIdForPreview();
    const rs = getPreviewRenderStateForView(viewId);
    if (!rs) return null;
    const vw = Math.max(1, Math.round(rs?.viewportWidth || 1));
    const vh = Math.max(1, Math.round(rs?.viewportHeight || 1));
    const scale = Math.min(plotW / vw, plotH / vh);

    let cssPx = NaN;
    if (typeof document !== 'undefined') {
      const labelLayer = document.getElementById('label-layer');
      cssPx = labelLayer ? parseFloat(getComputedStyle(labelLayer).fontSize || '') : NaN;
    }
    if (!Number.isFinite(cssPx) || cssPx <= 0) return null;
    return clamp(Math.round(cssPx * scale), 6, 36);
  }

  function syncTextSizingUi() {
    const auto = autoTextSizingCheckbox.checked;
    const inputs = [
      fontSizeInput,
      legendFontSizeInput,
      tickFontSizeInput,
      axisLabelFontSizeInput,
      titleFontSizeInput,
      centroidLabelFontSizeInput,
    ];
    for (const el of inputs) el.disabled = auto;
    if (!auto) return;

    const sizes = computeAutoTextSizes();
    fontSizeInput.value = String(sizes.base);
    legendFontSizeInput.value = String(sizes.legend);
    tickFontSizeInput.value = String(sizes.ticks);
    axisLabelFontSizeInput.value = String(sizes.axis);
    titleFontSizeInput.value = String(sizes.title);

    const { w, h } = getPlotSizePx();
    const centroidPx = estimateCentroidLabelSizePx({ plotW: w, plotH: h });
    if (centroidPx != null) centroidLabelFontSizeInput.value = String(centroidPx);
  }

  autoTextSizingCheckbox.addEventListener('change', () => {
    syncTextSizingUi();
    schedulePreviewDraw();
  });

  // Keep the crop frame aspect synced to the export plot aspect.
  const aspectInputs = [widthInput, heightInput];
  const onPlotSizeAspectChange = () => {
    if (cropEnabled) enforceCropAspect();
    syncCropUi();
    syncTextSizingUi();
    schedulePreviewDraw();
  };
  for (const el of aspectInputs) {
    el.addEventListener('input', onPlotSizeAspectChange);
    el.addEventListener('change', onPlotSizeAspectChange);
  }

  function readSizePreset() {
    if (presetSelect.value !== 'screen') return;
    if (typeof viewer.getRenderState !== 'function') return;
    const rs = viewer.getRenderState();
    if (!rs) return;
    widthInput.value = String(Math.round(rs.viewportWidth || DEFAULT_SIZE.width));
    heightInput.value = String(Math.round(rs.viewportHeight || DEFAULT_SIZE.height));
  }

  presetSelect.addEventListener('change', () => {
    const value = presetSelect.value;
    if (value === 'screen') {
      readSizePreset();
      onPlotSizeAspectChange();
      return;
    }
    const match = value.match(/^(\d+)x(\d+)$/);
    if (!match) return;
    widthInput.value = match[1];
    heightInput.value = match[2];
    onPlotSizeAspectChange();
  });

  // Seed "screen" preset once after init.
  readSizePreset();
  syncTextSizingUi();

  // Point radius is now taken directly from viewer's renderState (WYSIWYG)

  function setBusy(busy) {
    exportBtn.disabled = busy;
    exportBtn.textContent = busy ? 'Exporting…' : 'Export';
  }

  function inferVisiblePointCount() {
    const viewerCount = typeof viewer.getPointCount === 'function' ? viewer.getPointCount() : null;
    const stateCount = state?.pointCount ?? null;
    if (viewerCount != null && stateCount != null && viewerCount !== stateCount) {
      // Benchmark synthetic mode: state is stale.
      return viewerCount;
    }
    const filtered = typeof state.getFilteredCount === 'function' ? state.getFilteredCount() : null;
    return filtered?.shown ?? (state.pointCount || viewerCount || 0);
  }

  // ---------------------------------------------------------------------------
  // Preview (low-cost, debounced, and safe for large datasets)
  // ---------------------------------------------------------------------------

  const PREVIEW_TARGET_POINTS = 15000;
  const PREVIEW_AUTOBUILD_THRESHOLD = 200000;
  const PREVIEW_MAX_SCAN_POINTS = 250000;

  /** @type {{ viewId: string; positions: Float32Array|null; colors: Uint8Array|null; transparency: Float32Array|null; renderState: any; reduced: any; dim: number; cameraState: any; navMode: string } | null} */
  let previewSample = null;
  let previewDrawTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  let previewBuildToken = 0;

  /** @type {{ x: number; y: number; width: number; height: number }} */
  let cropRect01 = { x: 0, y: 0, width: 1, height: 1 };
  let cropEnabled = false;

  /** @type {{ scale: number; ox: number; oy: number; viewportRect: { x: number; y: number; width: number; height: number } | null } | null} */
  let previewGeom = null;

  /** @type {{ mode: 'move'|'resize-nw'|'resize-ne'|'resize-sw'|'resize-se'; startX: number; startY: number; start: any } | null} */
  let cropDrag = null;

  function getExportAspect() {
    const w = Math.max(1, parseInt(widthInput.value, 10) || DEFAULT_SIZE.width);
    const h = Math.max(1, parseInt(heightInput.value, 10) || DEFAULT_SIZE.height);
    return w / h;
  }

  function getViewportAspect() {
    const reduced = previewSample?.reduced || null;
    if (reduced?.viewportWidth && reduced?.viewportHeight) {
      return Math.max(0.0001, reduced.viewportWidth) / Math.max(0.0001, reduced.viewportHeight);
    }
    const viewId = getActiveViewIdForPreview();
    const rs = getPreviewRenderStateForView(viewId);
    if (rs?.viewportWidth && rs?.viewportHeight) {
      return Math.max(0.0001, rs.viewportWidth) / Math.max(0.0001, rs.viewportHeight);
    }
    return 1;
  }

  function formatAspectLabel(aspect) {
    if (!Number.isFinite(aspect) || aspect <= 0) return '—';
    if (Math.abs(aspect - 4 / 3) < 0.03) return '4:3';
    if (Math.abs(aspect - 16 / 9) < 0.03) return '16:9';
    if (Math.abs(aspect - 1) < 0.03) return '1:1';
    return aspect.toFixed(2);
  }

  function syncCropUi() {
    cropResetBtn.disabled = !cropEnabled;
    const exportAspect = getExportAspect();
    const aspectLabel = formatAspectLabel(exportAspect);

    let zoomLabel = '';
    if (cropEnabled) {
      const viewportAspect = getViewportAspect();
      const eff = exportAspect / Math.max(0.0001, viewportAspect);
      const maxW = eff >= 1 ? 1 : clamp(eff, 0.0001, 1);
      const c = normalizeCropRect01({ enabled: true, ...cropRect01 }) || cropRect01;
      const zoom = Number.isFinite(c?.width) && c.width > 0 ? (maxW / c.width) : 1;
      if (Number.isFinite(zoom) && zoom >= 1) zoomLabel = ` • Zoom: ${zoom.toFixed(2)}×`;
    }

    cropAspectHint.textContent = `Aspect: ${aspectLabel}${zoomLabel}`;
    if (!cropEnabled) {
      framingHint.textContent = 'Frame matches Plot size. Enable “Frame export” to select a region.';
    } else if (!previewEnabledCheckbox.checked) {
      framingHint.textContent = 'Frame matches Plot size. Turn on Preview to move/resize the frame.';
    } else {
      framingHint.textContent = 'Drag inside to move; drag corners to zoom; double-click to reset.';
    }
  }

  function resetCropToDefault() {
    const exportAspect = getExportAspect();
    const viewportAspect = getViewportAspect();
    const eff = exportAspect / Math.max(0.0001, viewportAspect);
    if (!Number.isFinite(eff) || eff <= 0) {
      cropRect01 = { x: 0, y: 0, width: 1, height: 1 };
      return;
    }
    const margin = 1.0;
    let width = margin;
    let height = margin;
    if (eff >= 1) {
      height = margin / eff;
    } else {
      width = margin * eff;
    }
    const x = (1 - width) / 2;
    const y = (1 - height) / 2;
    cropRect01 = { x, y, width, height };
  }

  function enforceCropAspect() {
    if (!cropEnabled) return;
    const exportAspect = getExportAspect();
    const viewportAspect = getViewportAspect();
    const eff = exportAspect / Math.max(0.0001, viewportAspect);
    if (!Number.isFinite(eff) || eff <= 0) return;

    const cx = cropRect01.x + cropRect01.width / 2;
    const cy = cropRect01.y + cropRect01.height / 2;
    const area = Math.max(0.0001, cropRect01.width * cropRect01.height);
    let width = Math.sqrt(area * eff);
    let height = width / eff;
    const s = Math.min(1 / width, 1 / height, 1);
    width *= s;
    height *= s;
    let x = cx - width / 2;
    let y = cy - height / 2;
    x = clamp(x, 0, 1 - width);
    y = clamp(y, 0, 1 - height);
    cropRect01 = { x, y, width, height };
  }

  function getCropOptionForExport() {
    if (!cropEnabled) return null;
    const normalized = normalizeCropRect01({ enabled: true, ...cropRect01 });
    return normalized ? { enabled: true, ...normalized } : null;
  }

  function getActiveViewIdForPreview() {
    return String(
      (typeof state.getActiveViewId === 'function' && state.getActiveViewId()) ||
      (typeof viewer.getFocusedViewId === 'function' && viewer.getFocusedViewId()) ||
      'live'
    );
  }

  function getPreviewRenderStateForView(viewId) {
    const vid = String(viewId || 'live');
    if (typeof viewer.getViewRenderState !== 'function') {
      return typeof viewer.getRenderState === 'function' ? viewer.getRenderState() : null;
    }

    const layout = typeof viewer.getViewLayout === 'function' ? viewer.getViewLayout() : null;
    if (layout?.mode !== 'grid' || typeof viewer.getSnapshotViews !== 'function' || typeof viewer.getRenderState !== 'function') {
      return viewer.getViewRenderState(vid);
    }

    const snapshots = viewer.getSnapshotViews() || [];
    const viewCount = (layout.liveViewHidden ? 0 : 1) + snapshots.length;
    const { cols, rows } = computeGridDims(viewCount || 1);
    const base = viewer.getRenderState();
    const viewportWidth = Math.max(1, Math.floor((base?.viewportWidth || 1) / cols));
    const viewportHeight = Math.max(1, Math.floor((base?.viewportHeight || 1) / rows));
    return viewer.getViewRenderState(vid, { viewportWidth, viewportHeight });
  }

  function requiresShaderAccuratePoints(viewId) {
    const vid = String(viewId || 'live');
    const dim = typeof state.getViewDimensionLevel === 'function'
      ? state.getViewDimensionLevel(vid)
      : (state.getDimensionLevel?.() ?? 3);
    const cameraState = viewer.getViewCameraState?.(vid) || viewer.getCameraState?.() || null;
    const navMode = cameraState?.navigationMode || 'orbit';
    const rs = getPreviewRenderStateForView(vid);
    const shaderQuality = String(rs?.shaderQuality || 'full');
    const usesSphereShader = shaderQuality === 'full';
    const is3dProjection = dim > 2 && navMode !== 'planar';
    return usesSphereShader || is3dProjection;
  }

  // Shader-accurate views cannot be represented faithfully with pure SVG circles.
  // Default to the Hybrid strategy so SVG exports stay WYSIWYG.
  const activeViewIdForDefaults = getActiveViewIdForPreview();
  if (requiresShaderAccuratePoints(activeViewIdForDefaults) && strategySelect.value !== 'hybrid' && strategySelect.value !== 'raster') {
    strategySelect.value = 'hybrid';
  }

  // Default centroid inclusion to the current viewer state (WYSIWYG).
  const centroidDefaults = typeof viewer.getCentroidFlags === 'function'
    ? (viewer.getCentroidFlags(activeViewIdForDefaults) || viewer.getCentroidFlags('live'))
    : null;
  if (centroidDefaults) {
    includeCentroidPointsCheckbox.checked = centroidDefaults.points !== false;
    includeCentroidLabelsCheckbox.checked = centroidDefaults.labels !== false;
  }

  // Seed centroid label font size from the on-screen overlay CSS when available.
  if (typeof document !== 'undefined') {
    const labelLayer = document.getElementById('label-layer');
    const cssPx = labelLayer ? parseFloat(getComputedStyle(labelLayer).fontSize || '') : NaN;
    if (Number.isFinite(cssPx) && cssPx > 0) {
      centroidLabelFontSizeInput.value = String(Math.round(cssPx));
    }
  }

  function clearPreview() {
    const ctx = /** @type {CanvasRenderingContext2D|null} */ (previewCanvas.getContext('2d'));
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    }
  }

  /**
   * Build or refresh the preview sample (downsampled point cloud in viewport space).
   * This intentionally avoids any work in the main render loop.
   */
  async function buildPreviewSample({ force = false } = {}) {
    const visibleCount = inferVisiblePointCount();
    const fastSample = !force && visibleCount >= PREVIEW_AUTOBUILD_THRESHOLD;
    const maxScanPoints = fastSample ? PREVIEW_MAX_SCAN_POINTS : null;

    const token = ++previewBuildToken;
    previewStatus.textContent = fastSample
      ? `Building fast preview… (${Math.min(visibleCount, PREVIEW_MAX_SCAN_POINTS).toLocaleString()} scan)`
      : 'Building preview…';
    await new Promise((r) => requestAnimationFrame(r));
    if (token !== previewBuildToken) return;

    const viewId = getActiveViewIdForPreview();
    const positions = typeof viewer.getViewPositions === 'function' ? viewer.getViewPositions(viewId) : state.positionsArray;
    const colors = typeof viewer.getViewColors === 'function' ? viewer.getViewColors(viewId) : state.colorsArray;
    const transparency = typeof viewer.getViewTransparency === 'function' ? viewer.getViewTransparency(viewId) : state.categoryTransparency;
    const renderState = getPreviewRenderStateForView(viewId);

    if (!positions || !colors || !renderState?.mvpMatrix) {
      previewSample = null;
      previewStatus.textContent = 'Preview unavailable (missing view buffers).';
      return;
    }

    const dim = typeof state.getViewDimensionLevel === 'function'
      ? state.getViewDimensionLevel(viewId)
      : (state.getDimensionLevel?.() ?? 3);
    const cameraState = viewer.getViewCameraState?.(viewId) || viewer.getCameraState?.() || null;
    const navMode = cameraState?.navigationMode || 'orbit';

    const safeVisibleCount = Number.isFinite(visibleCount) ? visibleCount : 0;
    const targetCount = clamp(safeVisibleCount, 2000, PREVIEW_TARGET_POINTS);
    const visibilityMask = getLodVisibilityMask({ viewer, viewId, dimensionLevel: dim });
    const reduced = reducePointsByDensity({
      positions,
      colors,
      transparency,
      visibilityMask,
      renderState,
      targetCount,
      maxScanPoints,
      seed: 1337
    });

    if (token !== previewBuildToken) return;

    previewSample = { viewId, positions, colors, transparency, renderState, reduced, dim, cameraState, navMode };
    if (cropEnabled) {
      enforceCropAspect();
      syncCropUi();
    }
    const note = requiresShaderAccuratePoints(viewId) ? ' • shader-accurate points' : '';
    const sampleNote = fastSample ? ' • fast sample' : '';
    previewStatus.textContent = `Preview sample: ${reduced?.x?.length?.toLocaleString?.() || 0} points${sampleNote}${note}`;
  }

  function schedulePreviewDraw() {
    if (!previewEnabledCheckbox.checked) return;
    if (previewDrawTimer) clearTimeout(previewDrawTimer);
    previewDrawTimer = setTimeout(() => {
      previewDrawTimer = null;
      drawPreview();
    }, 80);
  }

  function computeApproxBoundsFromSample({ reduced, positions, normTransform }) {
    if (!reduced?.index || !positions || !normTransform) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const outN = reduced.index.length;
    for (let i = 0; i < outN; i++) {
      const idx = reduced.index[i];
      const base = idx * 3;
      if (base + 1 >= positions.length) continue;
      const real = denormalizeXY(positions[base], positions[base + 1], normTransform);
      if (!Number.isFinite(real.x) || !Number.isFinite(real.y)) continue;
      if (real.x < minX) minX = real.x;
      if (real.x > maxX) maxX = real.x;
      if (real.y < minY) minY = real.y;
      if (real.y > maxY) maxY = real.y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) return null;
    return { minX, maxX, minY, maxY };
  }

  function drawPreview() {
    if (!previewEnabledCheckbox.checked) return;

    const ctx = /** @type {CanvasRenderingContext2D|null} */ (previewCanvas.getContext('2d'));
    if (!ctx) return;

    const exportW = Math.max(100, parseInt(widthInput.value, 10) || DEFAULT_SIZE.width);
    const exportH = Math.max(100, parseInt(heightInput.value, 10) || DEFAULT_SIZE.height);
    const canvasW = previewCanvas.width;
    const canvasH = previewCanvas.height;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvasW, canvasH);

    const sample = previewSample;
    const titleText = String(titleInput.value || '').trim();
    const fontFamily = String(fontSelect.value || 'Arial, Helvetica, sans-serif');
    const baseFontSizePx = Math.max(6, parseInt(fontSizeInput.value, 10) || 12);
    const legendFontSizePx = Math.max(6, parseInt(legendFontSizeInput.value, 10) || baseFontSizePx);
    const tickFontSizePx = Math.max(6, parseInt(tickFontSizeInput.value, 10) || baseFontSizePx);
    const axisLabelFontSizePx = Math.max(6, parseInt(axisLabelFontSizeInput.value, 10) || baseFontSizePx);
    const titleFontSizePx = Math.max(10, parseInt(titleFontSizeInput.value, 10) || Math.max(14, Math.round(baseFontSizePx * 1.25)));
    const centroidLabelFontSizePx = Math.max(6, parseInt(centroidLabelFontSizeInput.value, 10) || baseFontSizePx);

    const includeLegend = includeLegendCheckbox.checked;
    const legendPosition = legendPosSelect.value === 'bottom' ? 'bottom' : 'right';
    const includeAxes = includeAxesCheckbox.checked;
    const navMode = sample?.navMode || sample?.cameraState?.navigationMode || 'orbit';
    const axesEligible = includeAxes && (sample?.dim <= 2 || navMode === 'planar');

    const legendViewId = sample?.viewId || getActiveViewIdForPreview();
    const legendField = includeLegend && typeof state.getFieldForView === 'function'
      ? state.getFieldForView(legendViewId)
      : (includeLegend && typeof state.getActiveField === 'function' ? state.getActiveField() : null);
    const legendModel = legendField && typeof state.getLegendModel === 'function' ? state.getLegendModel(legendField) : null;
    const legendFieldKey = legendField?.key || null;

    const layout = computeSingleViewLayout({
      width: exportW,
      height: exportH,
      title: titleText,
      includeAxes: axesEligible,
      includeLegend,
      legendPosition,
      legendModel,
      legendFontSizePx
    });

    const totalW = layout.totalWidth;
    const totalH = layout.totalHeight;
    const s = Math.min(canvasW / totalW, canvasH / totalH);
    const ox = (canvasW - totalW * s) / 2;
    const oy = (canvasH - totalH * s) / 2;
    ctx.setTransform(s, 0, 0, s, ox, oy);

    const background = backgroundSelect.value || 'white';
    const backgroundColor = background === 'custom'
      ? String(backgroundColorInput.value || '#ffffff')
      : '#ffffff';
    if (background !== 'transparent') {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, totalW, totalH);
    }

    if (titleText) {
      const titleSize = Math.max(14, titleFontSizePx);
      ctx.fillStyle = '#111';
      ctx.font = `${titleSize}px ${fontFamily}`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(titleText, layout.titleRect?.x ?? layout.outerPadding, (layout.titleRect?.y ?? layout.outerPadding) + titleSize);
    }

    const plotRect = layout.plotRect;
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    ctx.strokeRect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);

    // Compute the on-screen viewport rectangle inside plotRect (letterboxed).
    const reduced = sample?.reduced || null;
    const rs = getPreviewRenderStateForView(getActiveViewIdForPreview());
    const viewportW = Math.max(1, (reduced?.viewportWidth || rs?.viewportWidth || 1));
    const viewportH = Math.max(1, (reduced?.viewportHeight || rs?.viewportHeight || 1));
    const vpScale = Math.min(plotRect.width / viewportW, plotRect.height / viewportH);
    const viewportRect = {
      x: plotRect.x + (plotRect.width - viewportW * vpScale) / 2,
      y: plotRect.y + (plotRect.height - viewportH * vpScale) / 2,
      width: viewportW * vpScale,
      height: viewportH * vpScale
    };
    previewGeom = { scale: s, ox, oy, viewportRect };

    if (!reduced) {
      if (!previewStatus.textContent || previewStatus.textContent === 'Preview is off.') {
        previewStatus.textContent = 'Click Refresh to build preview.';
      }
      // Post-process for colorblind simulation (preview-only).
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const mode = /** @type {any} */ (previewModeSelect.value || 'none');
      if (mode && mode !== 'none') {
        const img = ctx.getImageData(0, 0, canvasW, canvasH);
        applyColorblindSimulationToImageData(img, mode);
        ctx.putImageData(img, 0, 0);
      }
      return;
    }

    const pointRadiusViewportPx = getEffectivePointDiameterPx({
      viewer,
      renderState: sample?.renderState,
      viewId: sample?.viewId,
      dimensionLevel: sample?.dim
    }) / 2;
    const rawPointRadiusPx = pointRadiusViewportPx * vpScale;
    // Preview is heavily downscaled; enforce a minimum dot size in *screen pixels*
    // so points remain visible even when the exported figure is large.
    const minPreviewRadiusPx = (1.2 / Math.max(0.0001, s)) / 2; // 1.2px diameter on screen
    const pointRadiusPx = Math.max(rawPointRadiusPx, minPreviewRadiusPx);

    // Points (preview always uses the reduced sample).
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
    ctx.clip();

    const scale = vpScale;
    const offsetX = viewportRect.x;
    const offsetY = viewportRect.y;

    const totalHighlighted = typeof state?.getTotalHighlightedCellCount === 'function'
      ? state.getTotalHighlightedCellCount()
      : (typeof state?.getHighlightedCellCount === 'function' ? state.getHighlightedCellCount() : 0);
    const emphasizeSelection = emphasizeSelectionCheckbox.checked && totalHighlighted > 0;
    const mutedAlpha = clamp(parseNumberOr(selectionMutedOpacityInput.value, 0.15), 0, 1);
    const highlightArray = emphasizeSelection ? (state?.highlightArray || null) : null;

    const outN = reduced.x.length;
    for (let i = 0; i < outN; i++) {
      let a = reduced.alpha[i];
      a = Number.isFinite(a) ? a : 1.0;
      if (a < 0) a = 0;
      else if (a > 1) a = 1;
      const srcIndex = reduced.index?.[i] ?? i;
      const j = i * 4;
      let r = reduced.rgba[j];
      let g = reduced.rgba[j + 1];
      let b = reduced.rgba[j + 2];

      if (emphasizeSelection && highlightArray && (highlightArray[srcIndex] ?? 0) <= 0) {
        r = 160;
        g = 160;
        b = 160;
        a *= mutedAlpha;
      }
      if (a < 0.01) continue;

      const x = offsetX + reduced.x[i] * scale;
      const y = offsetY + reduced.y[i] * scale;
      ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
      if (pointRadiusPx <= 1) {
        const sz = pointRadiusPx * 2;
        ctx.fillRect(x - pointRadiusPx, y - pointRadiusPx, sz, sz);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, pointRadiusPx, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();

    // Centroid points + labels (matches the viewer overlay).
    if (sample?.renderState?.mvpMatrix && (includeCentroidPointsCheckbox.checked || includeCentroidLabelsCheckbox.checked)) {
      const vctx = state?.viewContexts?.get?.(String(sample.viewId || 'live')) || state?.viewContexts?.get?.('live') || null;
      const centroidPositions = vctx?.centroidPositions || null;
      const centroidColors = vctx?.centroidColors || null;
      const centroidLabelTexts = Array.isArray(vctx?.centroidLabels)
        ? vctx.centroidLabels.map((entry) => String(entry?.el?.textContent ?? entry?.text ?? ''))
        : null;
      const centroidRadiusPx = Math.max(0.5, (Number(sample.renderState.pointSize || 5) * 4.0) * 0.5 * vpScale);

      drawCanvasCentroidOverlay({
        ctx,
        positions: centroidPositions,
        colors: centroidColors,
        labelTexts: centroidLabelTexts,
        flags: { points: includeCentroidPointsCheckbox.checked, labels: includeCentroidLabelsCheckbox.checked },
        renderState: sample.renderState,
        plotRect,
        pointRadiusPx: centroidRadiusPx,
        crop: null,
        fontFamily,
        labelFontSizePx: centroidLabelFontSizePx,
        labelColor: '#111',
        haloColor: background === 'transparent' ? 'rgba(255,255,255,0.95)' : backgroundColor,
      });
    }

    if (showOrientationCheckbox.checked && sample.renderState?.viewMatrix && sample.dim > 2 && sample.navMode !== 'planar') {
      drawCanvasOrientationIndicator({
        ctx,
        plotRect,
        viewMatrix: sample.renderState.viewMatrix,
        cameraState: sample.cameraState,
        fontFamily,
        fontSize: Math.max(10, Math.round(baseFontSizePx * 0.92))
      });
    }

    if (emphasizeSelection && typeof state?.getHighlightedCellCount === 'function') {
      const count = state.getHighlightedCellCount();
      if (count > 0) {
        const label = `n = ${count.toLocaleString()} selected`;
        const boxPad = 6;
        const boxH = Math.max(16, Math.round(baseFontSizePx * 1.35));
        const boxW = Math.min(
          Math.max(1, plotRect.width - 16),
          Math.max(90, Math.round(label.length * (baseFontSizePx * 0.62) + boxPad * 2))
        );
        const boxX = plotRect.x + 8;
        const boxY = plotRect.y + 8;
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(boxX, boxY, boxW, boxH);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#e5e7eb';
        ctx.lineWidth = 1;
        ctx.strokeRect(boxX, boxY, boxW, boxH);
        ctx.fillStyle = '#111';
        ctx.font = `${baseFontSizePx}px ${fontFamily}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(label, boxX + boxPad, boxY + boxH - boxPad);
        ctx.restore();
      }
    }

    // Legend.
    if (includeLegend && layout.legendRect) {
      drawCanvasLegend({
        ctx,
        legendRect: layout.legendRect,
        fieldKey: legendFieldKey,
        model: legendModel,
        fontFamily,
        fontSize: legendFontSizePx,
        backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor
      });
    }

    // Axes (approximate bounds from preview sample).
    if (axesEligible && sample.positions && state?.dimensionManager?.getNormTransform) {
      const norm = state.dimensionManager.getNormTransform(sample.dim);
      const bounds = computeApproxBoundsFromSample({
        reduced: sample.reduced,
        positions: sample.positions,
        normTransform: norm
      });
      if (bounds) {
        drawCanvasAxes({
          ctx,
          plotRect,
          bounds,
          xLabel: String(xLabelInput.value || 'X'),
          yLabel: String(yLabelInput.value || 'Y'),
          fontFamily,
          tickFontSize: tickFontSizePx,
          labelFontSize: axisLabelFontSizePx,
          color: '#111'
        });
      }
    }

    // Framing overlay (photography-style crop guide).
    if (cropEnabled && viewportRect?.width > 1 && viewportRect?.height > 1) {
      const normalized = normalizeCropRect01({ enabled: true, ...cropRect01 });
      if (normalized) cropRect01 = normalized;
      const c = normalized || cropRect01;
      const x = viewportRect.x + c.x * viewportRect.width;
      const y = viewportRect.y + c.y * viewportRect.height;
      const w = c.width * viewportRect.width;
      const h = c.height * viewportRect.height;
      const lw1 = Math.max(1, 1 / s);
      const lw2 = Math.max(2, 3 / s);
      const handle = Math.max(8 / s, 6);

      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.38)';
      // Mask outside the crop rect (within the viewport area).
      ctx.fillRect(viewportRect.x, viewportRect.y, viewportRect.width, Math.max(0, y - viewportRect.y));
      ctx.fillRect(viewportRect.x, y + h, viewportRect.width, Math.max(0, viewportRect.y + viewportRect.height - (y + h)));
      ctx.fillRect(viewportRect.x, y, Math.max(0, x - viewportRect.x), h);
      ctx.fillRect(x + w, y, Math.max(0, viewportRect.x + viewportRect.width - (x + w)), h);

      // Border (dark then light for contrast).
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.lineWidth = lw2;
      ctx.strokeRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = lw1;
      ctx.strokeRect(x, y, w, h);

      // Rule-of-thirds grid.
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = lw1;
      ctx.beginPath();
      ctx.moveTo(x + w / 3, y);
      ctx.lineTo(x + w / 3, y + h);
      ctx.moveTo(x + (2 * w) / 3, y);
      ctx.lineTo(x + (2 * w) / 3, y + h);
      ctx.moveTo(x, y + h / 3);
      ctx.lineTo(x + w, y + h / 3);
      ctx.moveTo(x, y + (2 * h) / 3);
      ctx.lineTo(x + w, y + (2 * h) / 3);
      ctx.stroke();

      // Corner handles.
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.lineWidth = lw1;
      const drawHandle = (hx, hy) => {
        ctx.beginPath();
        ctx.rect(hx - handle / 2, hy - handle / 2, handle, handle);
        ctx.fill();
        ctx.stroke();
      };
      drawHandle(x, y);
      drawHandle(x + w, y);
      drawHandle(x, y + h);
      drawHandle(x + w, y + h);
      ctx.restore();
    }

    // Post-process for colorblind simulation (preview-only).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const mode = /** @type {any} */ (previewModeSelect.value || 'none');
    if (mode && mode !== 'none') {
      const img = ctx.getImageData(0, 0, canvasW, canvasH);
      applyColorblindSimulationToImageData(img, mode);
      ctx.putImageData(img, 0, 0);
    }
  }

  // ---------------------------------------------------------------------------
  // Framing interaction (drag/resize crop on preview)
  // ---------------------------------------------------------------------------

  function getCanvasXYFromPointerEvent(evt) {
    const rect = previewCanvas.getBoundingClientRect();
    const sx = rect.width > 0 ? (previewCanvas.width / rect.width) : 1;
    const sy = rect.height > 0 ? (previewCanvas.height / rect.height) : 1;
    return {
      x: (evt.clientX - rect.left) * sx,
      y: (evt.clientY - rect.top) * sy
    };
  }

  function canvasXYToLogical(x, y) {
    if (!previewGeom) return null;
    const s = Math.max(0.0001, previewGeom.scale || 1);
    return {
      x: (x - previewGeom.ox) / s,
      y: (y - previewGeom.oy) / s
    };
  }

  function logicalToViewportNorm(pt) {
    const vr = previewGeom?.viewportRect || null;
    if (!vr) return null;
    const nx = (pt.x - vr.x) / Math.max(1e-6, vr.width);
    const ny = (pt.y - vr.y) / Math.max(1e-6, vr.height);
    return { x: nx, y: ny };
  }

  function getCropRectLogical() {
    const vr = previewGeom?.viewportRect || null;
    if (!vr) return null;
    const c = normalizeCropRect01({ enabled: true, ...cropRect01 });
    if (!c) return null;
    return {
      x: vr.x + c.x * vr.width,
      y: vr.y + c.y * vr.height,
      width: c.width * vr.width,
      height: c.height * vr.height
    };
  }

  function hitTestCrop(ptLogical) {
    const vr = previewGeom?.viewportRect || null;
    const cr = getCropRectLogical();
    if (!vr || !cr) return null;
    if (ptLogical.x < vr.x || ptLogical.x > vr.x + vr.width || ptLogical.y < vr.y || ptLogical.y > vr.y + vr.height) return null;

    const handle = Math.max(10 / Math.max(0.0001, previewGeom.scale || 1), 6);
    const near = (hx, hy) => Math.abs(ptLogical.x - hx) <= handle && Math.abs(ptLogical.y - hy) <= handle;
    const x0 = cr.x;
    const y0 = cr.y;
    const x1 = cr.x + cr.width;
    const y1 = cr.y + cr.height;

    if (near(x0, y0)) return 'resize-nw';
    if (near(x1, y0)) return 'resize-ne';
    if (near(x0, y1)) return 'resize-sw';
    if (near(x1, y1)) return 'resize-se';
    if (ptLogical.x >= cr.x && ptLogical.x <= cr.x + cr.width && ptLogical.y >= cr.y && ptLogical.y <= cr.y + cr.height) return 'move';
    return null;
  }

  function applyResize(mode, pointer, startRect) {
    const minSize = 0.05;
    const left = mode === 'resize-nw' || mode === 'resize-sw';
    const top = mode === 'resize-nw' || mode === 'resize-ne';
    const ax = left ? (startRect.x + startRect.width) : startRect.x;
    const ay = top ? (startRect.y + startRect.height) : startRect.y;

    let dx = left ? (ax - pointer.x) : (pointer.x - ax);
    let dy = top ? (ay - pointer.y) : (pointer.y - ay);
    dx = Math.max(minSize, dx);
    dy = Math.max(minSize, dy);

    const maxW = left ? ax : (1 - ax);
    const maxH = top ? ay : (1 - ay);

    let width;
    let height;
    const viewportAspect = getViewportAspect();
    const exportAspect = getExportAspect();
    const eff = exportAspect / Math.max(0.0001, viewportAspect);
    if (!Number.isFinite(eff) || eff <= 0) return startRect;

    // Candidate A: driven by X.
    let wA = Math.min(dx, maxW);
    let hA = wA / eff;
    if (hA > maxH) {
      hA = maxH;
      wA = hA * eff;
    }

    // Candidate B: driven by Y.
    let hB = Math.min(dy, maxH);
    let wB = hB * eff;
    if (wB > maxW) {
      wB = maxW;
      hB = wB / eff;
    }

    const errA = Math.abs(wA - dx) + Math.abs(hA - dy);
    const errB = Math.abs(wB - dx) + Math.abs(hB - dy);
    width = errB < errA ? wB : wA;
    height = errB < errA ? hB : hA;

    const x = left ? ax - width : ax;
    const y = top ? ay - height : ay;
    return {
      x: clamp(x, 0, 1 - width),
      y: clamp(y, 0, 1 - height),
      width: clamp(width, minSize, 1),
      height: clamp(height, minSize, 1)
    };
  }

  function updateCropCursor(mode) {
    if (!mode) {
      previewCanvas.style.cursor = 'default';
      return;
    }
    if (mode === 'move') previewCanvas.style.cursor = 'move';
    else previewCanvas.style.cursor = 'nwse-resize';
  }

  previewCanvas.addEventListener('pointerdown', (evt) => {
    if (!previewEnabledCheckbox.checked || !cropEnabled) return;
    if (!previewGeom?.viewportRect) return;
    if (!previewSample?.reduced) return; // require a preview sample for meaningful framing

    const p = getCanvasXYFromPointerEvent(evt);
    const logical = canvasXYToLogical(p.x, p.y);
    if (!logical) return;

    const mode = hitTestCrop(logical);
    if (!mode) return;

    const norm = logicalToViewportNorm(logical);
    if (!norm) return;

    cropDrag = { mode, startX: norm.x, startY: norm.y, start: { ...cropRect01 } };
    previewCanvas.setPointerCapture?.(evt.pointerId);
    updateCropCursor(mode);
    evt.preventDefault();
  });

  previewCanvas.addEventListener('pointermove', (evt) => {
    if (!previewEnabledCheckbox.checked || !cropEnabled) return;
    if (!previewGeom?.viewportRect) return;
    if (!previewSample?.reduced) return;

    const p = getCanvasXYFromPointerEvent(evt);
    const logical = canvasXYToLogical(p.x, p.y);
    if (!logical) return;

    if (!cropDrag) {
      updateCropCursor(hitTestCrop(logical));
      return;
    }

    const norm = logicalToViewportNorm(logical);
    if (!norm) return;

    const start = cropDrag.start;
    if (cropDrag.mode === 'move') {
      const dx = norm.x - cropDrag.startX;
      const dy = norm.y - cropDrag.startY;
      cropRect01 = {
        x: clamp(start.x + dx, 0, 1 - start.width),
        y: clamp(start.y + dy, 0, 1 - start.height),
        width: start.width,
        height: start.height
      };
    } else {
      cropRect01 = applyResize(cropDrag.mode, norm, start);
    }
    syncCropUi();
    schedulePreviewDraw();
    evt.preventDefault();
  });

  function endCropDrag() {
    cropDrag = null;
    updateCropCursor(null);
  }

  previewCanvas.addEventListener('pointerup', endCropDrag);
  previewCanvas.addEventListener('pointercancel', endCropDrag);
  previewCanvas.addEventListener('dblclick', () => {
    if (!cropEnabled) return;
    resetCropToDefault();
    syncCropUi();
    schedulePreviewDraw();
  });

  exportBtn.addEventListener('click', async () => {
    const width = parseInt(widthInput.value, 10);
    const height = parseInt(heightInput.value, 10);
    const dpi = parseInt(dpiSelect.value, 10);
    if (!Number.isFinite(width) || width < 100 || !Number.isFinite(height) || height < 100) {
      widthInput.focus();
      return;
    }

    setBusy(true);
    try {
      const visibleCount = inferVisiblePointCount();
      const mode = downloadSelect.value || 'svg';
      const needsSvg = mode === 'svg' || mode === 'svg+png' || mode === 'all';
      const needsPng = mode === 'png' || mode === 'svg+png' || mode === 'png-multi' || mode === 'all';
      const multiPng = mode === 'png-multi' || mode === 'all';

      let strategy = strategySelect.value || 'ask';
      const largeThreshold = clamp(parseInt(largeDatasetThresholdInput.value, 10) || LARGE_DATASET_THRESHOLD, 1000, 5000000);
      const optimizedTargetCount = clamp(parseInt(optimizedTargetCountInput.value, 10) || 100000, 1000, 5000000);

      if (needsSvg && strategy === 'ask' && visibleCount >= largeThreshold) {
        const chosen = await promptLargeDatasetStrategy({
          pointCount: visibleCount,
          threshold: largeThreshold
        });
        if (!chosen) return;
        strategy = chosen;
      }

      // Shader-accurate point rendering cannot be expressed as pure SVG circles.
      // Force Hybrid for SVG exports so points match the on-screen appearance.
      const activeViewId = getActiveViewIdForPreview();
      if (needsSvg && requiresShaderAccuratePoints(activeViewId) && strategy !== 'hybrid' && strategy !== 'raster') {
        strategy = 'hybrid';
        getNotificationCenter().info('Shader-accurate view detected — using Hybrid SVG for WYSIWYG point rendering.', { category: 'render' });
      }

      const baseFontSizePx = parseInt(fontSizeInput.value, 10) || 12;
      const legendFontSizePx = parseInt(legendFontSizeInput.value, 10) || baseFontSizePx;
      const tickFontSizePx = parseInt(tickFontSizeInput.value, 10) || baseFontSizePx;
      const axisLabelFontSizePx = parseInt(axisLabelFontSizeInput.value, 10) || baseFontSizePx;
      const titleFontSizePx = parseInt(titleFontSizeInput.value, 10) || Math.max(14, Math.round(baseFontSizePx * 1.25));
      const centroidLabelFontSizePx = parseInt(centroidLabelFontSizeInput.value, 10) || baseFontSizePx;

      const baseOptions = {
        width,
        height,
        exportAllViews: exportAllViewsCheckbox.checked,
        title: String(titleInput.value || ''),
        includeAxes: includeAxesCheckbox.checked,
        includeLegend: includeLegendCheckbox.checked,
        includeCentroidPoints: includeCentroidPointsCheckbox.checked,
        includeCentroidLabels: includeCentroidLabelsCheckbox.checked,
        legendPosition: legendPosSelect.value === 'bottom' ? 'bottom' : 'right',
        xLabel: String(xLabelInput.value || 'X'),
        yLabel: String(yLabelInput.value || 'Y'),
        background: backgroundSelect.value || 'white',
        backgroundColor: String(backgroundColorInput.value || '#ffffff'),
        fontFamily: String(fontSelect.value || 'Arial, Helvetica, sans-serif'),
        fontSizePx: baseFontSizePx,
        legendFontSizePx,
        tickFontSizePx,
        axisLabelFontSizePx,
        titleFontSizePx,
        centroidLabelFontSizePx,
        crop: getCropOptionForExport(),
        // pointRadiusPx removed - export now uses viewer's pointSize directly (WYSIWYG)
        showOrientation: showOrientationCheckbox.checked,
        depthSort3d: depthSortCheckbox.checked,
        emphasizeSelection: emphasizeSelectionCheckbox.checked,
        selectionMutedOpacity: parseFloat(selectionMutedOpacityInput.value) || 0.15,
        strategy,
        optimizedTargetCount
      };

      let result;
      /** @type {{ format: 'svg'|'png'; dpi?: number }[]} */
      const jobs = [];
      if (needsSvg) jobs.push({ format: 'svg' });
      if (needsPng) {
        if (multiPng) jobs.push(...[150, 300, 600].map((d) => ({ format: 'png', dpi: d })));
        else jobs.push({ format: 'png', dpi });
      }

      if (jobs.length === 1) {
        result = await engine.exportFigure({
          ...baseOptions,
          format: jobs[0].format,
          dpi: jobs[0].dpi ?? dpi,
        });
      } else {
        if (typeof engine.exportFigures !== 'function') {
          throw new Error('Figure export engine is missing exportFigures()');
        }
        const results = await engine.exportFigures({
          ...baseOptions,
          jobs,
          dpi
        });
        result = Array.isArray(results) ? results[0] : results;
      }

      if (showCitationCheckbox.checked) {
        maybeShowCitationModal({
          datasetName: result?.metadata?.datasetName || null,
          fieldKey: result?.metadata?.fieldKey || null,
          viewLabel: result?.metadata?.viewLabel || null,
          filename: result?.filename || null
        });
      }
    } finally {
      setBusy(false);
    }
  });

  // Keep plot size/framing close to preview, and visually separated from the rest.
  const sizePreviewSection = createElement('div', { className: 'control-block figure-export-section figure-export-section-box' }, [
    plotAndFrameRow,
    previewRow,
    previewBox,
  ]);

  container.appendChild(header);
  container.appendChild(titleRow);
  container.appendChild(xLabelRow);
  container.appendChild(yLabelRow);
  container.appendChild(annotationSection);
  container.appendChild(selectionRow);
  container.appendChild(styleSection);
  container.appendChild(sizePreviewSection);
  container.appendChild(advancedSection);
  container.appendChild(actionsRow);

  syncFormatDependentUi();
  syncCropUi();

  return {};
}
