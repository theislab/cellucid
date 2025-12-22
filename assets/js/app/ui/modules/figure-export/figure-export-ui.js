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
import { computeSingleViewLayout } from './utils/layout.js';
import { reducePointsByDensity } from './utils/density-reducer.js';
import { drawCanvasLegend } from './components/legend-builder.js';
import { drawCanvasAxes } from './components/axes-builder.js';
import { denormalizeXY } from './utils/coordinate-mapper.js';
import { drawCanvasOrientationIndicator } from './components/orientation-indicator.js';
import { applyColorblindSimulationToImageData } from './utils/colorblindness.js';

const DEFAULT_SIZE = { width: 1200, height: 900 };
const LARGE_DATASET_THRESHOLD = 50000;

const JOURNAL_PRESETS = [
  { label: 'None', value: '' },
  { label: 'Nature — single column (89mm)', value: 'nature_single' },
  { label: 'Nature — double column (183mm)', value: 'nature_double' },
  { label: 'Science — single column (90mm)', value: 'science_single' },
  { label: 'Science — double column (185mm)', value: 'science_double' },
];

function mmToCssPx(mm) {
  return (Number(mm) / 25.4) * 96;
}

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
  // Format & Size section
  // ─────────────────────────────────────────────────────────────────────────
  const formatRow = createElement('div', { className: 'control-block figure-export-row' }, [
    createElement('label', {}, ['Format']),
  ]);
  const formatGroup = createElement('div', { className: 'figure-export-checks', role: 'radiogroup', 'aria-label': 'Export format' });
  const svgRadio = createElement('input', { type: 'radio', name: 'figure-export-format', value: 'svg', checked: true, id: 'figure-export-format-svg' });
  const pngRadio = createElement('input', { type: 'radio', name: 'figure-export-format', value: 'png', id: 'figure-export-format-png' });
  formatGroup.appendChild(createElement('label', { className: 'checkbox-inline', htmlFor: svgRadio.id }, [svgRadio, ' SVG']));
  formatGroup.appendChild(createElement('label', { className: 'checkbox-inline', htmlFor: pngRadio.id }, [pngRadio, ' PNG']));
  formatRow.appendChild(formatGroup);

  const sizeRow = createElement('div', { className: 'control-block' });
  sizeRow.appendChild(createElement('label', {}, ['Size']));

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

  const dpiRow = createElement('div', { className: 'control-block figure-export-row' });
  dpiRow.appendChild(createElement('label', {}, ['DPI']));
  const dpiSelect = createElement('select', { className: 'obs-select', 'aria-label': 'PNG DPI' });
  [150, 300, 600].forEach((dpi) => {
    dpiSelect.appendChild(createElement('option', { value: String(dpi) }, [String(dpi)]));
  });
  dpiSelect.value = '300';
  dpiRow.appendChild(dpiSelect);

  const journalRow = createElement('div', { className: 'control-block figure-export-row' });
  journalRow.appendChild(createElement('label', {}, ['Journal preset']));
  const journalSelect = createElement('select', { className: 'obs-select', 'aria-label': 'Journal preset' });
  JOURNAL_PRESETS.forEach((p) => {
    journalSelect.appendChild(createElement('option', { value: p.value }, [p.label]));
  });
  journalRow.appendChild(journalSelect);

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
    'aria-label': 'Font size (px)'
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

  // ─────────────────────────────────────────────────────────────────────────
  // Annotations section
  // ─────────────────────────────────────────────────────────────────────────
  const annotationSection = createElement('div', { className: 'control-block figure-export-section' });
  annotationSection.appendChild(createElement('label', {}, ['Include']));
  const includeAxesCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-axes', checked: true });
  const includeLegendCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-legend', checked: true });
  const showCitationCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-citation', checked: true });
  const showOrientationCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-orientation', checked: true });
  const depthSortCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-depthsort', checked: true });

  const annotationChecks = createElement('div', { className: 'figure-export-checks' }, [
    createElement('label', { className: 'checkbox-inline', htmlFor: includeAxesCheckbox.id }, [includeAxesCheckbox, ' Axes']),
    createElement('label', { className: 'checkbox-inline', htmlFor: includeLegendCheckbox.id }, [includeLegendCheckbox, ' Legend']),
    createElement('label', { className: 'checkbox-inline', htmlFor: showCitationCheckbox.id }, [showCitationCheckbox, ' Cite']),
    createElement('label', { className: 'checkbox-inline', htmlFor: showOrientationCheckbox.id }, [showOrientationCheckbox, ' 3D orient']),
    createElement('label', { className: 'checkbox-inline', htmlFor: depthSortCheckbox.id }, [depthSortCheckbox, ' Depth']),
  ]);
  annotationSection.appendChild(annotationChecks);

  const legendPosSelect = createElement('select', { className: 'obs-select', 'aria-label': 'Legend position' });
  legendPosSelect.appendChild(createElement('option', { value: 'right' }, ['Legend: Right']));
  legendPosSelect.appendChild(createElement('option', { value: 'bottom' }, ['Legend: Bottom']));

  const xLabelInput = createElement('input', { type: 'text', className: 'figure-input figure-input-sm', value: 'X', 'aria-label': 'X axis label' });
  const yLabelInput = createElement('input', { type: 'text', className: 'figure-input figure-input-sm', value: 'Y', 'aria-label': 'Y axis label' });

  const annotationOpts = createElement('div', { className: 'figure-export-style-row' }, [
    legendPosSelect,
    createElement('span', { className: 'figure-export-label' }, ['X']),
    xLabelInput,
    createElement('span', { className: 'figure-export-label' }, ['Y']),
    yLabelInput,
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
    width: '320',
    height: '200',
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
  advancedSection.appendChild(createElement('label', {}, ['Advanced']));

  const strategySelect = createElement('select', { className: 'obs-select', 'aria-label': 'Large dataset strategy' });
  strategySelect.appendChild(createElement('option', { value: 'ask' }, ['Large data: Ask']));
  strategySelect.appendChild(createElement('option', { value: 'full-vector' }, ['Full vector']));
  strategySelect.appendChild(createElement('option', { value: 'optimized-vector' }, ['Optimized vector']));
  strategySelect.appendChild(createElement('option', { value: 'hybrid' }, ['Hybrid']));
  strategySelect.appendChild(createElement('option', { value: 'raster' }, ['Raster (PNG)']));

  const batchSelect = createElement('select', { className: 'obs-select', 'aria-label': 'Batch export mode' });
  batchSelect.appendChild(createElement('option', { value: 'single' }, ['Single export']));
  batchSelect.appendChild(createElement('option', { value: 'both' }, ['SVG + PNG']));
  batchSelect.appendChild(createElement('option', { value: 'png-multi' }, ['PNG multi-DPI']));
  batchSelect.appendChild(createElement('option', { value: 'both+png-multi' }, ['All formats']));

  const advancedGrid = createElement('div', { className: 'figure-export-style-row' }, [
    strategySelect,
    batchSelect,
  ]);
  advancedSection.appendChild(advancedGrid);

  const exportAllViewsCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-all-views' });
  advancedSection.appendChild(createElement('label', { className: 'checkbox-inline', htmlFor: exportAllViewsCheckbox.id }, [
    exportAllViewsCheckbox,
    ' Export all views (split-view)'
  ]));

  const actionsRow = createElement('div', { className: 'figure-export-actions' });
  const exportBtn = createElement('button', { type: 'button', className: 'btn-small', id: 'figure-export-btn' }, ['Export']);
  actionsRow.appendChild(exportBtn);

  function getSelectedFormat() {
    return pngRadio.checked ? 'png' : 'svg';
  }

  function syncFormatDependentUi() {
    const format = getSelectedFormat();
    const batchMode = batchSelect.value || 'single';
    const needsPng = format === 'png' || batchMode === 'both' || batchMode === 'png-multi' || batchMode === 'both+png-multi';
    const needsSvg = format === 'svg' || batchMode === 'both' || batchMode === 'both+png-multi';

    dpiRow.style.display = needsPng && batchMode !== 'png-multi' && batchMode !== 'both+png-multi' ? 'flex' : 'none';
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

  svgRadio.addEventListener('change', syncFormatDependentUi);
  pngRadio.addEventListener('change', syncFormatDependentUi);
  backgroundSelect.addEventListener('change', syncFormatDependentUi);
  emphasizeSelectionCheckbox.addEventListener('change', syncFormatDependentUi);
  batchSelect.addEventListener('change', syncFormatDependentUi);
  previewEnabledCheckbox.addEventListener('change', async () => {
    syncFormatDependentUi();
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
    includeAxesCheckbox,
    includeLegendCheckbox,
    legendPosSelect,
    xLabelInput,
    yLabelInput,
    backgroundSelect,
    backgroundColorInput,
    fontSelect,
    fontSizeInput,
    showOrientationCheckbox,
    emphasizeSelectionCheckbox,
    selectionMutedOpacityInput,
  ];
  for (const el of previewInputs) {
    el.addEventListener('change', schedulePreviewDraw);
    el.addEventListener('input', schedulePreviewDraw);
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
      return;
    }
    const match = value.match(/^(\d+)x(\d+)$/);
    if (!match) return;
    widthInput.value = match[1];
    heightInput.value = match[2];
  });

  // Seed "screen" preset once after init.
  readSizePreset();

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
  const PREVIEW_AUTOBUILD_THRESHOLD = 100000;

  /** @type {{ viewId: string; positions: Float32Array|null; renderState: any; reduced: any; dim: number; cameraState: any; navMode: string } | null} */
  let previewSample = null;
  let previewDrawTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  let previewBuildToken = 0;

  function getActiveViewIdForPreview() {
    return String(
      (typeof state.getActiveViewId === 'function' && state.getActiveViewId()) ||
      (typeof viewer.getFocusedViewId === 'function' && viewer.getFocusedViewId()) ||
      'live'
    );
  }

  function is3dShadedView(viewId) {
    const vid = String(viewId || 'live');
    const dim = typeof state.getViewDimensionLevel === 'function'
      ? state.getViewDimensionLevel(vid)
      : (state.getDimensionLevel?.() ?? 3);
    const cameraState = viewer.getViewCameraState?.(vid) || viewer.getCameraState?.() || null;
    const navMode = cameraState?.navigationMode || 'orbit';
    const renderState = typeof viewer.getViewRenderState === 'function'
      ? viewer.getViewRenderState(vid)
      : (typeof viewer.getRenderState === 'function' ? viewer.getRenderState() : null);
    const shaderQuality = String(renderState?.shaderQuality || 'full');
    return dim > 2 && navMode !== 'planar' && shaderQuality === 'full';
  }

  // 3D shaded views cannot be represented faithfully with pure SVG circles.
  // Default to the Hybrid strategy so SVG exports stay WYSIWYG.
  const activeViewIdForDefaults = getActiveViewIdForPreview();
  if (is3dShadedView(activeViewIdForDefaults) && (strategySelect.value === 'ask' || strategySelect.value === 'full-vector')) {
    strategySelect.value = 'hybrid';
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
    if (!force && visibleCount >= PREVIEW_AUTOBUILD_THRESHOLD) {
      previewStatus.textContent = `Large dataset (${visibleCount.toLocaleString()} points). Click Refresh to build a preview sample.`;
      return;
    }

    const token = ++previewBuildToken;
    previewStatus.textContent = 'Building preview…';
    await new Promise((r) => requestAnimationFrame(r));
    if (token !== previewBuildToken) return;

    const viewId = getActiveViewIdForPreview();
    const positions = typeof viewer.getViewPositions === 'function' ? viewer.getViewPositions(viewId) : state.positionsArray;
    const colors = typeof viewer.getViewColors === 'function' ? viewer.getViewColors(viewId) : state.colorsArray;
    const transparency = typeof viewer.getViewTransparency === 'function' ? viewer.getViewTransparency(viewId) : state.categoryTransparency;
    const renderState = typeof viewer.getViewRenderState === 'function'
      ? viewer.getViewRenderState(viewId)
      : (typeof viewer.getRenderState === 'function' ? viewer.getRenderState() : null);

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
    const reduced = reducePointsByDensity({
      positions,
      colors,
      transparency,
      renderState,
      targetCount,
      seed: 1337
    });

    if (token !== previewBuildToken) return;

    previewSample = { viewId, positions, renderState, reduced, dim, cameraState, navMode };
    const note = is3dShadedView(viewId) ? ' • 3D shader: export uses shader-accurate raster points' : '';
    previewStatus.textContent = `Preview sample: ${reduced?.x?.length?.toLocaleString?.() || 0} points${note}`;
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

    const s = Math.min(canvasW / exportW, canvasH / exportH);
    const ox = (canvasW - exportW * s) / 2;
    const oy = (canvasH - exportH * s) / 2;
    ctx.setTransform(s, 0, 0, s, ox, oy);

    const background = backgroundSelect.value || 'white';
    const backgroundColor = background === 'custom'
      ? String(backgroundColorInput.value || '#ffffff')
      : '#ffffff';
    if (background !== 'transparent') {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, exportW, exportH);
    }

    const sample = previewSample;
    if (!sample?.reduced) {
      // Still draw an empty frame so layout is obvious.
      ctx.strokeStyle = '#e5e7eb';
      ctx.lineWidth = 1;
      ctx.strokeRect(0, 0, exportW, exportH);
      if (!previewStatus.textContent || previewStatus.textContent === 'Preview is off.') {
        previewStatus.textContent = 'Click Refresh to build preview.';
      }
      // Apply colorblind post-process (no-op on empty).
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const mode = /** @type {any} */ (previewModeSelect.value || 'none');
      if (mode && mode !== 'none') {
        const img = ctx.getImageData(0, 0, canvasW, canvasH);
        applyColorblindSimulationToImageData(img, mode);
        ctx.putImageData(img, 0, 0);
      }
      return;
    }

    const titleText = String(titleInput.value || '').trim();
    const fontFamily = String(fontSelect.value || 'Arial, Helvetica, sans-serif');
    const fontSizePx = Math.max(6, parseInt(fontSizeInput.value, 10) || 12);
    // WYSIWYG: Get point size from viewer's render state (diameter → radius)
    const viewerPointSize = sample.renderState?.pointSize;
    const pointRadiusPx = (typeof viewerPointSize === 'number' && Number.isFinite(viewerPointSize) && viewerPointSize > 0)
      ? viewerPointSize / 2
      : 2.5;

    const includeLegend = includeLegendCheckbox.checked;
    const legendPosition = legendPosSelect.value === 'bottom' ? 'bottom' : 'right';
    const includeAxes = includeAxesCheckbox.checked;
    const axesEligible = includeAxes && sample.dim <= 2 && sample.navMode === 'planar';

    const layout = computeSingleViewLayout({
      width: exportW,
      height: exportH,
      title: titleText,
      includeAxes: axesEligible,
      includeLegend,
      legendPosition
    });

    if (titleText) {
      const titleSize = Math.max(14, Math.round(fontSizePx * 1.25));
      ctx.fillStyle = '#111';
      ctx.font = `${titleSize}px ${fontFamily}`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(titleText, layout.titleRect?.x ?? layout.outerPadding, (layout.titleRect?.y ?? layout.outerPadding) + titleSize);
    }

    const plotRect = layout.plotRect;
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    ctx.strokeRect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);

    // Points (preview always uses the reduced sample).
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
    ctx.clip();

    const reduced = sample.reduced;
    const viewportW = Math.max(1, reduced.viewportWidth || 1);
    const viewportH = Math.max(1, reduced.viewportHeight || 1);
    const scale = Math.min(plotRect.width / viewportW, plotRect.height / viewportH);
    const offsetX = plotRect.x + (plotRect.width - viewportW * scale) / 2;
    const offsetY = plotRect.y + (plotRect.height - viewportH * scale) / 2;

    const emphasizeSelection = emphasizeSelectionCheckbox.checked;
    const mutedAlpha = clamp(parseNumberOr(selectionMutedOpacityInput.value, 0.15), 0, 1);
    const highlightArray = emphasizeSelection ? (state?.highlightArray || null) : null;

    const outN = reduced.x.length;
    for (let i = 0; i < outN; i++) {
      let a = reduced.alpha[i] ?? 1.0;
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

    if (showOrientationCheckbox.checked && sample.renderState?.viewMatrix && sample.dim > 2 && sample.navMode !== 'planar') {
      drawCanvasOrientationIndicator({
        ctx,
        plotRect,
        viewMatrix: sample.renderState.viewMatrix,
        cameraState: sample.cameraState,
        fontFamily,
        fontSize: Math.max(10, Math.round(fontSizePx * 0.92))
      });
    }

    if (emphasizeSelection && typeof state?.getHighlightedCellCount === 'function') {
      const count = state.getHighlightedCellCount();
      if (count > 0) {
        const label = `n = ${count.toLocaleString()} selected`;
        const boxPad = 6;
        const boxH = Math.max(16, Math.round(fontSizePx * 1.35));
        const boxW = Math.min(
          Math.max(1, plotRect.width - 16),
          Math.max(90, Math.round(label.length * (fontSizePx * 0.62) + boxPad * 2))
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
        ctx.font = `${fontSizePx}px ${fontFamily}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(label, boxX + boxPad, boxY + boxH - boxPad);
        ctx.restore();
      }
    }

    // Legend.
    if (includeLegend && layout.legendRect) {
      const field = typeof state.getFieldForView === 'function'
        ? state.getFieldForView(sample.viewId)
        : (typeof state.getActiveField === 'function' ? state.getActiveField() : null);
      const model = field && typeof state.getLegendModel === 'function' ? state.getLegendModel(field) : null;
      drawCanvasLegend({
        ctx,
        legendRect: layout.legendRect,
        fieldKey: field?.key || null,
        model,
        fontFamily,
        fontSize: fontSizePx,
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
          fontSize: fontSizePx,
          color: '#111'
        });
      }
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

  journalSelect.addEventListener('change', () => {
    const preset = journalSelect.value;
    if (!preset) return;

    const apply = (mmWidth) => {
      const w = Math.round(mmToCssPx(mmWidth));
      widthInput.value = String(Math.max(100, w));
      heightInput.value = String(Math.max(100, Math.round(w * 0.75)));
    };

    if (preset === 'nature_single') {
      apply(89);
      dpiSelect.value = '300';
      fontSelect.value = 'Arial, Helvetica, sans-serif';
      fontSizeInput.value = '12';
    } else if (preset === 'nature_double') {
      apply(183);
      dpiSelect.value = '300';
      fontSelect.value = 'Arial, Helvetica, sans-serif';
      fontSizeInput.value = '12';
    } else if (preset === 'science_single') {
      apply(90);
      dpiSelect.value = '300';
      fontSelect.value = 'Helvetica, Arial, sans-serif';
      fontSizeInput.value = '12';
    } else if (preset === 'science_double') {
      apply(185);
      dpiSelect.value = '300';
      fontSelect.value = 'Helvetica, Arial, sans-serif';
      fontSizeInput.value = '12';
    }
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
      const format = getSelectedFormat();
      const visibleCount = inferVisiblePointCount();
      const batchMode = batchSelect.value || 'single';

      let strategy = strategySelect.value || 'ask';
      const willExportSvg = batchMode === 'single'
        ? format === 'svg'
        : (batchMode === 'both' || batchMode === 'both+png-multi');
      if (willExportSvg && strategy === 'ask' && visibleCount >= LARGE_DATASET_THRESHOLD) {
        const chosen = await promptLargeDatasetStrategy({
          pointCount: visibleCount,
          threshold: LARGE_DATASET_THRESHOLD
        });
        if (!chosen) return;
        strategy = chosen;
      }

      // 3D shaded (sphere) rendering cannot be expressed as pure SVG circles.
      // Force Hybrid for SVG exports so the points match the on-screen shader.
      const activeViewId = getActiveViewIdForPreview();
      if (willExportSvg && is3dShadedView(activeViewId) && strategy !== 'hybrid' && strategy !== 'raster') {
        strategy = 'hybrid';
        getNotificationCenter().info('3D shader detected — using Hybrid SVG for WYSIWYG point rendering.', { category: 'render' });
      }

      const baseOptions = {
        width,
        height,
        exportAllViews: exportAllViewsCheckbox.checked,
        title: String(titleInput.value || ''),
        includeAxes: includeAxesCheckbox.checked,
        includeLegend: includeLegendCheckbox.checked,
        legendPosition: legendPosSelect.value === 'bottom' ? 'bottom' : 'right',
        xLabel: String(xLabelInput.value || 'X'),
        yLabel: String(yLabelInput.value || 'Y'),
        background: backgroundSelect.value || 'white',
        backgroundColor: String(backgroundColorInput.value || '#ffffff'),
        fontFamily: String(fontSelect.value || 'Arial, Helvetica, sans-serif'),
        fontSizePx: parseInt(fontSizeInput.value, 10) || 12,
        // pointRadiusPx removed - export now uses viewer's pointSize directly (WYSIWYG)
        showOrientation: showOrientationCheckbox.checked,
        depthSort3d: depthSortCheckbox.checked,
        emphasizeSelection: emphasizeSelectionCheckbox.checked,
        selectionMutedOpacity: parseFloat(selectionMutedOpacityInput.value) || 0.15,
        strategy
      };

      let result;
      if (batchMode === 'single') {
        result = await engine.exportFigure({
          ...baseOptions,
          format,
          dpi,
        });
      } else if (typeof engine.exportFigures === 'function') {
        /** @type {{ format: 'svg'|'png'; dpi?: number }[]} */
        let jobs;
        if (batchMode === 'both') {
          jobs = [{ format: 'svg' }, { format: 'png', dpi }];
        } else if (batchMode === 'png-multi') {
          jobs = [150, 300, 600].map((d) => ({ format: 'png', dpi: d }));
        } else if (batchMode === 'both+png-multi') {
          jobs = [{ format: 'svg' }, ...[150, 300, 600].map((d) => ({ format: 'png', dpi: d }))];
        } else {
          jobs = [{ format, dpi }];
        }

        const results = await engine.exportFigures({
          ...baseOptions,
          jobs,
          dpi
        });
        result = Array.isArray(results) ? results[0] : results;
      } else {
        // Fallback: run sequentially without batch support.
        if (batchMode === 'both') {
          await engine.exportFigure({ ...baseOptions, format: 'svg', dpi });
          result = await engine.exportFigure({ ...baseOptions, format: 'png', dpi });
        } else {
          const dpis = batchMode === 'png-multi' || batchMode === 'both+png-multi' ? [150, 300, 600] : [dpi];
          for (const d of dpis) {
            result = await engine.exportFigure({ ...baseOptions, format: 'png', dpi: d });
          }
        }
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

  container.appendChild(header);
  container.appendChild(formatRow);
  container.appendChild(sizeRow);
  container.appendChild(dpiRow);
  container.appendChild(journalRow);
  container.appendChild(styleSection);
  container.appendChild(titleRow);
  container.appendChild(annotationSection);
  container.appendChild(selectionRow);
  container.appendChild(previewRow);
  container.appendChild(previewBox);
  container.appendChild(advancedSection);
  container.appendChild(actionsRow);

  syncFormatDependentUi();

  return {};
}
