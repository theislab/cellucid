/**
 * @fileoverview Figure export UI (accordion panel).
 *
 * Builds a compact control panel for publication-grade exports without adding
 * any work to the normal render loop.
 *
 * @module ui/modules/figure-export/figure-export-ui
 */

import { figureAutoTitle, gridPanelsDifferInField } from './utils/figure-title.js';
import { setControlAvailability } from '../../core/control-availability.js';
import { createElement, clearElement } from '../../../utils/dom-utils.js';
import { createButton, createDecimalInput, createDisclosure, createGroup, createInfoTip, createStatusLine, readDecimalInput, writeDecimalInput } from '../../components/controls.js';
import { formatCount, formatCountOf } from '../../../../utils/format-units.js';
import { createVisibilityGatedRender } from '../../core/visibility-gate.js';
import { clamp } from '../../../utils/number-utils.js';
import { confirmExportFidelityWarnings } from './components/fidelity-warning-dialog.js';
import { reportFigureExportFailure } from './figure-export-engine.js';
import { fillSingleViewWidth } from './utils/layout.js';
import {
  FIGURE_DEFAULT_WIDTH_PRESET,
  FIGURE_STANDARD_TEXT_PT,
  FIGURE_WIDTH_PRESETS,
  FIGURE_WIDTH_PRESET_LABELS,
  figurePxOfPt,
  devicePxOf,
  figureSizeText,
  figureWidthPxOf,
  formatMm,
} from './utils/figure-size.js';
import { highlightLegendEntry } from './utils/highlight-legend.js';
import { buildSelectionBadge, drawCanvasSelectionBadge } from './utils/selection-badge.js';
import { buildRenderModeFidelityWarnings } from './utils/render-mode.js';
import { reducePointsByDensity } from './utils/density-reducer.js';
import {
  matchesLodMembershipPresentation,
  MIN_VISIBLE_ALPHA_BYTE,
  POINT_VISIBILITY_THRESHOLD,
} from './utils/lod-membership.js';
import { drawCanvasLegend } from './components/legend-builder.js';
import { computeSourceAxisBounds, drawCanvasAxes, figureViewHasAxes } from './components/axes-builder.js';
import { drawCanvasCentroidOverlay } from './components/centroid-overlay.js';
import { drawCanvasVectorFieldOf, vectorFieldLegendKey } from './components/vector-field-figure.js';
import { readShownVectorFieldOverlay } from './utils/overlay-fidelity.js';
import { createPlotPlacement, figureSourceAspect } from './utils/plot-fit.js';
import { createViewportPointDiameter } from './utils/point-size.js';
import { drawCanvasOrientationIndicator } from './components/orientation-indicator.js';
import {
  buildReferenceGridModel,
  drawCanvasReferenceGrid,
  resolveReferenceGridSurface,
} from './components/reference-grid.js';
import {
  figureDrawsBackdropLook,
  peekBackdropLookPreview,
} from './components/backdrop-look-export.js';
import { applyColorblindSimulationToImageData } from './utils/colorblindness.js';
import { assertCropRect01 } from './utils/crop.js';
import { panelShapeAgainstCells } from './utils/cells-frame.js';
import {
  assertFigureExportSessionSettings,
  changedFigureExportSettings,
  figureExportParamsOf,
  figureExportSettingsOf,
  FIGURE_EXPORT_DEFAULT_SVG_STRATEGY,
  FIGURE_EXPORT_FRAME_CELLS,
  FIGURE_EXPORT_SESSION_SETTINGS_VERSION,
  FIGURE_EXPORT_SETTING_RANGES,
  FIGURE_EXPORT_SIZE_PRESETS,
  trackCommittedNumber,
} from './utils/session-settings.js';
import { getActions } from '../../../actions/index.js';
import { ActionRefused } from '../../../actions/dispatcher.js';
import { hexOfRgb01, isHexColor } from '../../../../utils/hex-color.js';
import { resolveFigureInk } from './utils/figure-ink.js';
import {
  buildViewerBackgroundFidelityWarnings,
  readActiveReferenceGridAppearance,
  VIEWER_BACKGROUND_LABELS,
} from './utils/viewer-background.js';
import {
  buildOverlayFidelityWarnings,
} from './utils/overlay-fidelity.js';
import { assertCameraState } from '../../../../rendering/camera-state-contract.js';
import { cancel, onAbort } from '../../../../utils/abort.js';
import { promiseWithResolvers } from '../../../../utils/promise-resolvers.js';
import { openADatasetTo } from '../../no-dataset.js';
import { debounce } from '../../../../utils/debounce.js';

const PREVIEW_PRESENTATION_SETTLE_MS = 120;

function previewValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right) ||
    ArrayBuffer.isView(left) !== ArrayBuffer.isView(right)
  ) {
    return false;
  }
  if (ArrayBuffer.isView(left)) {
    if (
      left.constructor !== right.constructor ||
      left.length !== right.length
    ) {
      return false;
    }
    for (let index = 0; index < left.length; index++) {
      if (!Object.is(left[index], right[index])) return false;
    }
    return true;
  }
  if (Array.isArray(left)) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (!previewValuesEqual(left[index], right[index])) return false;
    }
    return true;
  }
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  // Empty frozen objects are commonly opaque generation tokens. Their
  // identity is the value; two different owners must never compare equal.
  if (leftKeys.length === 0 || rightKeys.length === 0) return false;
  if (leftKeys.length !== rightKeys.length) return false;
  leftKeys.sort((a, b) => String(a).localeCompare(String(b)));
  rightKeys.sort((a, b) => String(a).localeCompare(String(b)));
  for (let index = 0; index < leftKeys.length; index++) {
    const leftKey = leftKeys[index];
    if (leftKey !== rightKeys[index]) return false;
    if (!previewValuesEqual(left[leftKey], right[leftKey])) return false;
  }
  return true;
}

export function areFigurePreviewCertificatesEqual(left, right) {
  return previewValuesEqual(left, right);
}

export function createFigurePreviewEpochFence() {
  let epoch = 0;
  let closed = false;
  return Object.freeze({
    get closed() {
      return closed;
    },
    get epoch() {
      return epoch;
    },
    capture(certificate) {
      return Object.freeze({ certificate, epoch });
    },
    accepts(ticket, certificate) {
      return Boolean(
        !closed &&
        ticket?.epoch === epoch &&
        areFigurePreviewCertificatesEqual(
          ticket.certificate,
          certificate
        )
      );
    },
    invalidate() {
      if (!closed) epoch++;
      return epoch;
    },
    close() {
      if (!closed) {
        closed = true;
        epoch++;
      }
    },
  });
}

export function mapFigurePreviewPointToPlot({
  viewportX,
  viewportY,
  sourceOriginX,
  sourceOriginY,
  plotOffsetX,
  plotOffsetY,
  plotScale,
}) {
  for (const [label, value] of Object.entries({
    viewportX,
    viewportY,
    sourceOriginX,
    sourceOriginY,
    plotOffsetX,
    plotOffsetY,
    plotScale,
  })) {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `Figure preview ${label} must be finite.`
      );
    }
  }
  if (plotScale < 0) {
    throw new RangeError(
      'Figure preview plotScale must be non-negative.'
    );
  }
  return Object.freeze({
    x: plotOffsetX + (viewportX - sourceOriginX) * plotScale,
    y: plotOffsetY + (viewportY - sourceOriginY) * plotScale,
  });
}

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {HTMLElement} options.container
 * @param {ReturnType<typeof import('./figure-export-engine.js').createFigureExportEngine>} options.engine
 */
export function initFigureExportUI({ state, viewer, container, engine }) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('Figure export container must be an HTMLElement.');
  }
  if (
    engine === null ||
    typeof engine !== 'object' ||
    typeof engine.exportFigure !== 'function' ||
    typeof engine.exportFigures !== 'function' ||
    typeof engine.cellsFrame !== 'function' ||
    typeof engine.figureViewIds !== 'function'
  ) {
    throw new TypeError(
      'Figure export engine must publish exportFigure(), exportFigures(), cellsFrame() and figureViewIds().'
    );
  }
  if (
    viewer === null ||
    typeof viewer !== 'object' ||
    typeof viewer.withBorrowedViewData !== 'function' ||
    typeof viewer.getPresentedViewState !== 'function' ||
    typeof viewer.onPresentedViewStateChanged !== 'function' ||
    typeof viewer.getAntialiasing !== 'function'
  ) {
    throw new TypeError(
      'Figure export viewer must publish withBorrowedViewData(), '
      + 'getPresentedViewState(), onPresentedViewStateChanged(), and '
      + 'getAntialiasing().'
    );
  }
  // Generic UI control snapshotting skips this subtree: a session records the
  // panel's settings through exportSessionSettings()/importSessionSettings()
  // (utils/session-settings.js), exactly and without derived values.
  container.setAttribute('data-state-serializer-skip', 'true');

  if (container.__cellucidCleanup !== undefined) {
    if (typeof container.__cellucidCleanup !== 'function') {
      throw new TypeError('Figure export cleanup owner must be a function.');
    }
    container.__cellucidCleanup();
  }
  clearElement(container);
  /** @type {Array<() => void>} */
  const cleanupFns = [];
  let cleanupComplete = false;
  let previewDisposed = false;
  let exportInFlight = false;
  let activeExportAbortController = null;
  /** Settles once the export under way (if any) has ended, stopped or not. */
  let exportEnded = Promise.resolve();
  const domLifecycle = new AbortController();
  const previewEpochFence = createFigurePreviewEpochFence();
  function listen(target, eventName, handler) {
    const fencedHandler = event => {
      if (cleanupComplete) return;
      return handler(event);
    };
    target.addEventListener(
      eventName,
      fencedHandler,
      { signal: domLifecycle.signal }
    );
  }
  cleanupFns.push(() => {
    cancel(activeExportAbortController, 'closed', 'The figure export panel was closed.');
    activeExportAbortController = null;
    exportInFlight = false;
  });
  // Returns a promise that settles once the export it stopped has ended
  // (its late answers dropped, nothing downloaded or reported).
  const destroy = () => {
    if (cleanupComplete) return exportEnded;
    cleanupComplete = true;
    container.__cellucidCleanup = () => exportEnded;
    const failures = [];
    try {
      domLifecycle.abort();
    } catch (error) {
      failures.push(error);
    }
    for (const fn of cleanupFns.splice(0)) {
      try {
        fn();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Figure export cleanup did not release every owner.'
      );
    }
    return exportEnded;
  };
  container.__cellucidCleanup = destroy;

  // The figure's width as a journal prints it (`utils/figure-size.js`): the
  // figure fills it at its own height, and its text keeps its point sizes.
  const presets = FIGURE_EXPORT_SIZE_PRESETS.map(value => ({
    value,
    label: value === 'custom'
      ? FIGURE_WIDTH_PRESET_LABELS.custom
      : `${FIGURE_WIDTH_PRESET_LABELS[value]} · ${FIGURE_WIDTH_PRESETS[value]} mm`,
  }));

  const headerInfo = createInfoTip({ tip: 'figure-export', label: 'About figure export' });
  const headerGroup = createGroup({ title: 'Export', info: headerInfo.button });
  headerGroup.body.append(headerInfo.popover);
  const header = headerGroup.root;

  // ─────────────────────────────────────────────────────────────────────────
  // Plot size + framing
  // ─────────────────────────────────────────────────────────────────────────
  const sizeRow = createElement('div', { className: 'control-block' });
  sizeRow.appendChild(createElement('span', { className: 'field-label' }, ['Figure width']));

  const presetSelect = createElement('select', { className: 'obs-select', ariaLabel: 'Figure width preset' });
  presets.forEach((p) => {
    presetSelect.appendChild(createElement('option', { value: p.value }, [p.label]));
  });
  presetSelect.value = FIGURE_DEFAULT_WIDTH_PRESET;

  const widthInput = createDecimalInput({
    id: 'figure-export-width',
    className: 'obs-select figure-input-sm',
    value: FIGURE_WIDTH_PRESETS[FIGURE_DEFAULT_WIDTH_PRESET],
    ariaLabel: 'Figure width (mm)',
    title: 'The figure is exactly this wide, at every resolution; its height follows from its plots\' shapes.',
  });

  const sizeGrid = createElement('div', { className: 'figure-export-size-row' }, [
    presetSelect,
    createElement('div', { className: 'figure-export-dimensions' }, [
      createElement('div', { className: 'figure-export-dim-field' }, [
        createElement('label', { className: 'figure-export-inline-label', htmlFor: widthInput.id }, ['W']),
        widthInput,
        createElement('span', { className: 'figure-export-inline-label' }, ['mm']),
      ]),
    ])
  ]);
  sizeRow.appendChild(sizeGrid);
  // The figure's printed size, and the PNG's pixels at the chosen DPI (`figureSizeText`).
  const sizeReadout = createStatusLine({ tone: 'muted', text: '' });
  sizeReadout.root.classList.add('figure-export-size-readout');
  sizeRow.appendChild(sizeReadout.root);

  const cropEnabledCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-crop-enabled' });
  const cropLockCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-crop-lock' });
  const cropResetBtn = createElement('button', { type: 'button', className: 'btn btn-compact figure-export-framing-btn' }, ['Reset']);
  const cropConfirmBtn = createElement('button', { type: 'button', className: 'btn btn-compact figure-export-framing-btn', ariaPressed: 'false' }, ['Confirm']);
  const cropAspectHint = createElement('span', { className: 'figure-export-crop-aspect' }, ['Aspect: —']);
  // One click frames every cell drawn: the plot takes the cells' shape,
  // not the pane's, and nobody rearranges the screen for a figure.
  const fitCellsBtn = createElement('button', {
    type: 'button',
    className: 'btn btn-compact figure-export-framing-btn',
    title: 'Frame every cell drawn, with a small margin: the plot takes the cells\' shape instead of the pane\'s',
  }, ['Fit the cells']);

  const frameExportToggleLabel = createElement('label', { className: 'checkbox-inline', htmlFor: cropEnabledCheckbox.id }, [
    cropEnabledCheckbox,
    ' Frame export'
  ]);
  const lockAspectBtn = createElement('button', {
    type: 'button',
    className: 'btn btn-compact figure-export-framing-btn',
    ariaPressed: 'false',
  }, ['Lock aspect']);
  const framingActionGrid = createElement('div', { className: 'figure-export-framing-grid' }, [
    cropResetBtn,
    cropConfirmBtn,
    lockAspectBtn,
  ]);

  const plotAndFrameRow = createElement('div', { className: 'figure-export-plot-frame' }, [
    sizeRow
  ]);

  // ─────────────────────────────────────────────────────────────────────────
  // Style section
  // ─────────────────────────────────────────────────────────────────────────
  const styleSection = createElement('div', { className: 'control-block' });

  const backgroundSelect = createElement('select', { id: 'figure-export-background', className: 'obs-select' });
  backgroundSelect.appendChild(createElement('option', { value: 'viewer' }, ['Match viewer']));
  backgroundSelect.appendChild(createElement('option', { value: 'white' }, ['White']));
  backgroundSelect.appendChild(createElement('option', { value: 'transparent' }, ['Transparent']));
  backgroundSelect.appendChild(createElement('option', { value: 'custom' }, ['Custom…']));
  const initialViewerBg = hexOfRgb01(viewer.getRenderState().bgColor);
  const backgroundColorInput = createElement('input', { type: 'color', className: 'figure-color-picker', value: initialViewerBg || '#ffffff', ariaLabel: 'Custom background color' });
  backgroundSelect.value = 'viewer';

  const fontSelect = createElement('select', { id: 'figure-export-font', className: 'obs-select' });
  [
    { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
    { label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
    { label: 'Times', value: '"Times New Roman", Times, serif' },
  ].forEach((f) => fontSelect.appendChild(createElement('option', { value: f.value }, [f.label])));

  // Every text size is in points and has one range, the settings' (`FIGURE_EXPORT_SETTING_RANGES.fontSize`,
  // whole or half points): the control's, the reader's and `figure-export.set`'s. A control with a
  // narrower range than the reader's would let a size an agent set draw in the picture and leave its
  // control invalid, and Export would blame it for another refusal.
  // Points keep their printed size at any width and resolution: no one converts pixels to points.
  const fontSizeInput = createDecimalInput({
    id: 'figure-export-font-size',
    className: 'obs-select figure-input-sm',
    value: FIGURE_STANDARD_TEXT_PT.base,
    ariaLabel: 'Base text size (pt)',
  });

  const autoTextSizingCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-text-auto', checked: true });

  const legendFontSizeInput = createDecimalInput({
    id: 'figure-export-legend-font-size',
    className: 'obs-select figure-input-sm',
    value: FIGURE_STANDARD_TEXT_PT.legend,
    ariaLabel: 'Legend text size (pt)',
  });
  const tickFontSizeInput = createDecimalInput({
    id: 'figure-export-tick-font-size',
    className: 'obs-select figure-input-sm',
    value: FIGURE_STANDARD_TEXT_PT.ticks,
    ariaLabel: 'Tick label size (pt)',
  });
  const axisLabelFontSizeInput = createDecimalInput({
    id: 'figure-export-axis-font-size',
    className: 'obs-select figure-input-sm',
    value: FIGURE_STANDARD_TEXT_PT.axisLabel,
    ariaLabel: 'Axis label size (pt)',
  });
  const titleFontSizeInput = createDecimalInput({
    id: 'figure-export-title-font-size',
    className: 'obs-select figure-input-sm',
    value: FIGURE_STANDARD_TEXT_PT.title,
    ariaLabel: 'Title size (pt)',
  });
  const centroidLabelFontSizeInput = createDecimalInput({
    id: 'figure-export-centroid-font-size',
    className: 'obs-select figure-input-sm',
    value: FIGURE_STANDARD_TEXT_PT.centroidLabel,
    ariaLabel: 'Centroid label size (pt)',
  });

  // There is no point radius control: the export draws the viewer's pointSize (WYSIWYG).

  const autoTextToggleRow = createElement('div', { className: 'figure-export-style-row figure-export-auto-text-toggle' }, [
    createElement('label', {
      className: 'checkbox-inline',
      htmlFor: autoTextSizingCheckbox.id,
      title: 'The sizes journals print figure text at: 7 pt, ticks and centroid labels 6 pt, the title 8 pt, at any width. Off: your own sizes, in points.',
    }, [
      autoTextSizingCheckbox,
      ' Auto text (pt)'
    ]),
  ]);

  const autoTextBox = createElement('div', { className: 'control-box figure-export-auto-text-box' }, [
    createElement('div', { className: 'figure-export-sizes-grid' }, [
      createElement('div', { className: 'figure-export-size-item' }, [
        createElement('label', { className: 'figure-export-inline-label', htmlFor: fontSizeInput.id }, ['Base']),
        fontSizeInput,
      ]),
      createElement('div', { className: 'figure-export-size-item' }, [
        createElement('label', { className: 'figure-export-inline-label', htmlFor: legendFontSizeInput.id }, ['Legend']),
        legendFontSizeInput,
      ]),
      createElement('div', { className: 'figure-export-size-item' }, [
        createElement('label', { className: 'figure-export-inline-label', htmlFor: tickFontSizeInput.id }, ['Ticks']),
        tickFontSizeInput,
      ]),
      createElement('div', { className: 'figure-export-size-item' }, [
        createElement('label', { className: 'figure-export-inline-label', htmlFor: axisLabelFontSizeInput.id }, ['Axis']),
        axisLabelFontSizeInput,
      ]),
      createElement('div', { className: 'figure-export-size-item' }, [
        createElement('label', { className: 'figure-export-inline-label', htmlFor: titleFontSizeInput.id }, ['Title']),
        titleFontSizeInput,
      ]),
      createElement('div', { className: 'figure-export-size-item' }, [
        createElement('label', { className: 'figure-export-inline-label', htmlFor: centroidLabelFontSizeInput.id }, ['Centroids']),
        centroidLabelFontSizeInput,
      ]),
    ]),
  ]);

  const styleBox = createElement('div', { className: 'figure-export-style-box' }, [
    createElement('label', { htmlFor: backgroundSelect.id }, ['Background']),
    createElement('div', { className: 'figure-export-style-row' }, [
      backgroundSelect,
      backgroundColorInput,
    ]),
    createElement('label', { htmlFor: fontSelect.id }, ['Font']),
    createElement('div', { className: 'figure-export-style-row' }, [
      fontSelect,
    ]),
    createElement('span', { className: 'field-label' }, ['Text sizes']),
    autoTextToggleRow,
    autoTextBox,
  ]);
  styleSection.appendChild(styleBox);

  const titleRow = createElement('div', { className: 'control-block' });
  titleRow.appendChild(createElement('label', { htmlFor: 'figure-export-title' }, ['Title']));
  const titleInput = createElement('input', {
    id: 'figure-export-title',
    type: 'text',
    className: 'obs-select',
    placeholder: 'Optional figure title',
    ariaLabel: 'Figure title'
  });
  titleRow.appendChild(titleInput);

  const xLabelInput = createElement('input', {
    id: 'figure-export-xlabel',
    type: 'text',
    className: 'obs-select figure-export-axis-input',
    value: 'X',
    placeholder: 'e.g., UMAP_1',
    ariaLabel: 'X axis label'
  });

  const yLabelInput = createElement('input', {
    id: 'figure-export-ylabel',
    type: 'text',
    className: 'obs-select figure-export-axis-input',
    value: 'Y',
    placeholder: 'e.g., UMAP_2',
    ariaLabel: 'Y axis label'
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Annotations section
  // ─────────────────────────────────────────────────────────────────────────
  const annotationSection = createElement('div', { className: 'control-block' });
  annotationSection.appendChild(createElement('span', { className: 'field-label' }, ['Annotations']));
  const includeAxesCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-axes', checked: true });
  const includeLegendCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-legend', checked: true });
  const showOrientationCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-orientation', checked: true });
  const depthSortCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-depthsort', checked: true });
  // Checked by default so the figure matches the viewer; unchecking it is the
  // user deliberately composing a grid-free figure, not a silent difference.
  const referenceGridCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-reference-grid', checked: true });
  const referenceGridLabel = createElement(
    'label',
    { className: 'checkbox-inline', htmlFor: referenceGridCheckbox.id },
    [referenceGridCheckbox, ' Reference grid']
  );

  const annotationChecks = createElement('div', { className: 'figure-export-checks' }, [
    createElement('label', {
      className: 'checkbox-inline',
      htmlFor: includeAxesCheckbox.id,
      // An axis is drawn only where it is a ruler (`figureViewHasAxes`).
      title: 'Embedding coordinates on a 1-D or 2-D view seen flat (planar). A 3-D view has none: its picture has no single scale; 3D orientation shows its directions.',
    }, [includeAxesCheckbox, ' Axes']),
    createElement('label', { className: 'checkbox-inline', htmlFor: includeLegendCheckbox.id }, [includeLegendCheckbox, ' Legend']),
    referenceGridLabel,
    createElement('label', { className: 'checkbox-inline', htmlFor: showOrientationCheckbox.id }, [showOrientationCheckbox, ' 3D orientation']),
    createElement('label', { className: 'checkbox-inline', htmlFor: depthSortCheckbox.id }, [depthSortCheckbox, ' Depth sort']),
  ]);
  const axisLabelGrid = createElement('div', { className: 'figure-export-axis-label-grid' }, [
    createElement('div', { className: 'figure-export-axis-label-field' }, [
      createElement('label', { className: 'figure-export-inline-label', htmlFor: xLabelInput.id }, ['X']),
      xLabelInput,
    ]),
    createElement('div', { className: 'figure-export-axis-label-field' }, [
      createElement('label', { className: 'figure-export-inline-label', htmlFor: yLabelInput.id }, ['Y']),
      yLabelInput,
    ]),
  ]);
  const axisLabelSettings = createElement('div', { className: 'figure-export-axes-settings' }, [
    createElement('span', { className: 'field-label' }, ['Axis labels']),
    axisLabelGrid,
  ]);

  const legendPosSelect = createElement('select', { className: 'obs-select', ariaLabel: 'Legend position' });
  legendPosSelect.appendChild(createElement('option', { value: 'right' }, ['Legend: Right']));
  legendPosSelect.appendChild(createElement('option', { value: 'bottom' }, ['Legend: Bottom']));

  const legendSettingsRow = createElement('div', { className: 'figure-export-style-row figure-export-legend-settings' }, [
    legendPosSelect,
  ]);
  const annotationBox = createElement('div', { className: 'control-box figure-export-annotations-box' }, [
    annotationChecks,
    axisLabelSettings,
    legendSettingsRow,
  ]);
  annotationSection.appendChild(annotationBox);

  /**
   * The reference-layer appearance the viewer is drawing right now, or null.
   * Read on every use because the viewer background can change while the
   * export dialog is open.
   */
  function readViewerReferenceGridAppearance() {
    return readActiveReferenceGridAppearance(
      typeof document === 'undefined' ? null : document
    );
  }

  /** The appearance this export will actually draw: viewer state ∧ user choice. */
  function resolveExportReferenceGrid() {
    const appearance = readViewerReferenceGridAppearance();
    if (appearance === null) return null;
    return referenceGridCheckbox.checked ? appearance : null;
  }

  function syncAnnotationUi() {
    axisLabelSettings.hidden = !includeAxesCheckbox.checked;
    legendSettingsRow.hidden = !includeLegendCheckbox.checked;
    const appearance = readViewerReferenceGridAppearance();
    const available = appearance !== null;
    setControlAvailability(referenceGridCheckbox, available
      ? null
      : 'the viewer background draws no reference grid; choose a grid or studio background to include one');
    referenceGridLabel.title = !available
      ? 'The viewer background draws no reference grid.'
      : appearance.kind === 'studio'
        ? `Include the viewer's ${VIEWER_BACKGROUND_LABELS[appearance.mode]} floor and dots.`
        : `Include the viewer's ${VIEWER_BACKGROUND_LABELS[appearance.mode]} reference grid.`;
  }
  listen(includeAxesCheckbox, 'change', syncAnnotationUi);
  listen(includeLegendCheckbox, 'change', syncAnnotationUi);
  listen(referenceGridCheckbox, 'change', syncAnnotationUi);
  syncAnnotationUi();

  // ─────────────────────────────────────────────────────────────────────────
  // Selection & Preview section
  // ─────────────────────────────────────────────────────────────────────────
  const selectionRow = createElement('div', { className: 'control-block figure-export-row' });
  const emphasizeSelectionCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-selection-emphasis' });
  const selectionMutedOpacityInput = createDecimalInput({
    id: 'figure-export-muted-opacity',
    className: 'obs-select figure-input-sm',
    value: 0.15,
    ariaLabel: 'Non-selected opacity (0..1)'
  });
  selectionRow.appendChild(createElement('label', { className: 'checkbox-inline', htmlFor: emphasizeSelectionCheckbox.id }, [
    emphasizeSelectionCheckbox,
    ' Emphasize selection'
  ]));
  selectionRow.appendChild(createElement('div', { className: 'figure-export-inline' }, [
    createElement('label', { className: 'figure-export-inline-label', htmlFor: selectionMutedOpacityInput.id }, ['α']),
    selectionMutedOpacityInput,
  ]));

  const previewRow = createElement('div', { className: 'control-block' });
  previewRow.appendChild(createElement('span', { className: 'field-label' }, ['Preview']));
  const previewEnabledCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-preview-enabled' });
  const previewRefreshBtn = createElement('button', { type: 'button', className: 'btn btn-compact figure-export-framing-btn' }, ['Refresh']);
  const previewModeSelect = createElement('select', { className: 'obs-select figure-export-colorblind-select', ariaLabel: 'Colorblind preview' });
  previewModeSelect.appendChild(createElement('option', { value: 'none' }, ['Normal']));
  previewModeSelect.appendChild(createElement('option', { value: 'deuteranopia' }, ['Deuteranopia']));
  previewModeSelect.appendChild(createElement('option', { value: 'protanopia' }, ['Protanopia']));
  previewModeSelect.appendChild(createElement('option', { value: 'tritanopia' }, ['Tritanopia']));

  const previewControls = createElement('div', { className: 'figure-export-preview-controls' }, [
    createElement('label', { className: 'checkbox-inline', htmlFor: previewEnabledCheckbox.id }, [
      previewEnabledCheckbox,
      ' Show preview'
    ])
  ]);
  previewRow.appendChild(previewControls);

  const previewStatus = createElement('p', {
    className: 'status-line figure-export-preview-status',
    'data-tone': 'muted',
    role: 'status',
    ariaLive: 'polite',
    ariaAtomic: 'true',
  }, [
    'Preview is off.'
  ]);
  const previewCanvas = createElement('canvas', {
    className: 'figure-export-preview',
    width: '360',
    height: '240',
    role: 'img',
    ariaLabel: 'Figure export preview',
    tabIndex: -1,
  });
  // Said when a panel is far from the shape asked for: a narrow pane
  // (the chat open, a grid) gives a narrow plot of a wide embedding.
  const shapeNoteText = createElement('span', {}, ['']);
  const shapeNoteFitBtn = createButton({
    label: 'Fit the cells',
    variant: 'quiet',
    className: 'btn-compact figure-export-shape-fit',
    title: 'Frame every cell drawn: the plot takes the cells\' shape instead of the pane\'s',
  });
  const shapeNote = createElement('p', {
    className: 'status-line figure-export-shape-note',
    'data-tone': 'muted',
    role: 'status',
    ariaLive: 'polite',
  }, [shapeNoteText, ' ', shapeNoteFitBtn]);
  shapeNote.hidden = true;
  const previewBox = createElement('div', { className: 'figure-export-preview-box' }, [
    previewCanvas,
    previewStatus,
    shapeNote,
  ]);

  const previewSettingsBox = createElement('div', { className: 'control-box figure-export-preview-settings' }, [
    createElement('div', { className: 'figure-export-preview-settings-top' }, [
      previewModeSelect,
      previewRefreshBtn,
    ]),
    createElement('div', { className: 'figure-export-preview-settings-row figure-export-preview-settings-row--toggles' }, [
      frameExportToggleLabel,
      fitCellsBtn,
    ]),
    framingActionGrid,
    cropAspectHint,
    previewBox,
  ]);
  previewRow.appendChild(previewSettingsBox);

  // ─────────────────────────────────────────────────────────────────────────
  // Advanced & Export section
  // ─────────────────────────────────────────────────────────────────────────
  const advancedSection = createElement('div', { className: 'control-block' });

  const downloadSelect = createElement('select', { className: 'obs-select', ariaLabel: 'Download format' });
  downloadSelect.appendChild(createElement('option', { value: 'svg' }, ['SVG']));
  downloadSelect.appendChild(createElement('option', { value: 'png' }, ['PNG']));
  downloadSelect.appendChild(createElement('option', { value: 'svg+png' }, ['SVG + PNG']));
  downloadSelect.appendChild(createElement('option', { value: 'png-multi' }, ['PNG (150/300/600)']));
  downloadSelect.appendChild(createElement('option', { value: 'all' }, ['All']));
  downloadSelect.value = 'png';

  const dpiSelect = createElement('select', { className: 'obs-select', ariaLabel: 'PNG DPI' });
  [150, 300, 600].forEach((dpi) => {
    dpiSelect.appendChild(createElement('option', { value: String(dpi) }, [String(dpi)]));
  });
  dpiSelect.value = '300';

  // Full vector by default (every point, editable), the choice a person or an
  // agent made whenever the panel asked first; never changed for them afterwards.
  const strategySelect = createElement('select', { className: 'obs-select', ariaLabel: 'SVG point strategy' });
  strategySelect.appendChild(createElement('option', { value: 'full-vector' }, ['Full vector']));
  strategySelect.appendChild(createElement('option', { value: 'optimized-vector' }, ['Optimized vector']));
  strategySelect.appendChild(createElement('option', { value: 'hybrid' }, ['Hybrid']));
  strategySelect.value = FIGURE_EXPORT_DEFAULT_SVG_STRATEGY;

  const optimizedTargetCountInput = createElement('input', {
    id: 'figure-export-target-count',
    type: 'number',
    className: 'obs-select figure-input-sm',
    value: '100000',
    min: '1000',
    max: '5000000',
    step: '1000',
    inputMode: 'numeric',
    ariaLabel: 'Optimized vector target points'
  });
  const targetGroup = createElement('div', { className: 'figure-export-inline', id: 'figure-export-target-group' }, [
    createElement('label', { className: 'figure-export-inline-label', htmlFor: optimizedTargetCountInput.id }, ['Keep']),
    optimizedTargetCountInput,
  ]);
  const densitySettingsRow = createElement('div', { className: 'figure-export-style-row', id: 'figure-export-density-settings' }, [
    targetGroup,
  ]);

  const advancedGrid = createElement('div', { className: 'figure-export-style-row' }, [
    downloadSelect,
    dpiSelect,
    strategySelect,
  ]);
  advancedSection.appendChild(advancedGrid);
  advancedSection.appendChild(densitySettingsRow);

  const exportAllViewsCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-all-views' });
  advancedSection.appendChild(createElement('label', { className: 'checkbox-inline', htmlFor: exportAllViewsCheckbox.id }, [
    exportAllViewsCheckbox,
    ' Export all views (split-view)'
  ]));

  const actionsRow = createElement('div', { className: 'figure-export-actions' });
  const exportBtn = createElement('button', { type: 'button', className: 'btn btn-primary', id: 'figure-export-btn' }, ['Export']);
  actionsRow.appendChild(exportBtn);

  function syncFormatDependentUi() {
    const mode = downloadSelect.value;
    const needsPng = mode === 'png' || mode === 'svg+png' || mode === 'png-multi' || mode === 'all';
    const needsSvg = mode === 'svg' || mode === 'svg+png' || mode === 'all';
    const multiPng = mode === 'png-multi' || mode === 'all';

    const strategy = strategySelect.value;
    densitySettingsRow.hidden = !(needsSvg && strategy === 'optimized-vector');
    targetGroup.hidden = strategy !== 'optimized-vector';

    dpiSelect.hidden = !(needsPng && !multiPng);
    strategySelect.hidden = !needsSvg;
    backgroundColorInput.hidden = backgroundSelect.value !== 'custom';
    selectionMutedOpacityInput.parentElement.hidden = !emphasizeSelectionCheckbox.checked;

    const previewOn = previewEnabledCheckbox.checked;
    previewBox.hidden = !previewOn;
    previewSettingsBox.hidden = !previewOn;
    if (!previewOn) {
      previewStatus.textContent = 'Preview is off.';
      shapeNote.hidden = true;
    }
  }

  function reportPreviewFailure(context, error) {
    if (cleanupComplete || previewDisposed) return;
    previewStatus.textContent =
      'Preview unavailable. Refresh after the view settles.';
    console.error(`[FigureExport] ${context} failed:`, error);
  }

  async function runPreviewUiAction(context, action) {
    if (cleanupComplete || previewDisposed) return false;
    try {
      const result = await action();
      return cleanupComplete || previewDisposed ? false : result;
    } catch (error) {
      reportPreviewFailure(context, error);
      return false;
    }
  }

  listen(backgroundSelect, 'change', syncFormatDependentUi);
  listen(emphasizeSelectionCheckbox, 'change', syncFormatDependentUi);
  listen(downloadSelect, 'change', syncFormatDependentUi);
  listen(dpiSelect, 'change', syncFormatDependentUi);
  // The PNG's pixels follow its DPI; the printed size does not.
  for (const control of [dpiSelect, downloadSelect]) listen(control, 'change', () => syncSizeReadout(lastPreviewFigure));
  listen(exportAllViewsCheckbox, 'change', () => syncSizeReadout(null));
  listen(strategySelect, 'change', syncFormatDependentUi);
  listen(previewEnabledCheckbox, 'change', () => {
    void runPreviewUiAction('Preview toggle', async () => {
      if (!previewEnabledCheckbox.checked) {
        previewFramingMode = 'edit';
        if (cropEnabledCheckbox.checked) {
          cropEnabled = false;
          cropEnabledCheckbox.checked = false;
          previewSampleCrop = null;
          syncCropUi();
          schedulePreviewDraw();
        }
      }
      syncFormatDependentUi();
      syncCropUi();
      if (!previewEnabledCheckbox.checked) {
        invalidatePreviewSamples({ rebuild: false });
        clearPreview();
        return false;
      }
      const needsCropPreview =
        cropEnabled && previewFramingMode === 'applied';
      const sample =
        needsCropPreview ? previewSampleCrop : previewSampleFull;
      const currentSample =
        sample && isPreviewSampleCurrent(sample)
          ? sample
          : null;
      if (sample && currentSample === null) {
        invalidatePreviewSamples({ rebuild: false });
      }
      const committed = currentSample
        ? true
        : await buildPreviewSample({
          mode: needsCropPreview ? 'crop' : 'full',
        });
      if (committed && !previewDisposed) drawPreview();
      return committed;
    });
  });

  listen(previewRefreshBtn, 'click', () => {
    void runPreviewUiAction('Preview refresh', async () => {
      if (!previewEnabledCheckbox.checked) return false;
      const needsCropPreview =
        cropEnabled && previewFramingMode === 'applied';
      const committed = await buildPreviewSample({
        force: true,
        mode: needsCropPreview ? 'crop' : 'full',
      });
      if (committed && !previewDisposed) drawPreview();
      return committed;
    });
  });

  listen(previewModeSelect, 'change', schedulePreviewDraw);

  // Redraw preview on option changes (no sample rebuild).
  const previewInputs = [
    widthInput,
    titleInput,
    xLabelInput,
    yLabelInput,
    includeAxesCheckbox,
    includeLegendCheckbox,
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
    listen(el, 'change', schedulePreviewDraw);
    listen(el, 'input', schedulePreviewDraw);
  }

  listen(cropEnabledCheckbox, 'change', () => {
    if (cropEnabledCheckbox.checked) {
      cropEnabled = true;
      previewFramingMode = 'edit';
      previewSampleCrop = null;
      if (!previewEnabledCheckbox.checked) {
        previewEnabledCheckbox.checked = true;
        previewEnabledCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      resetCropToDefault();
    } else {
      cropEnabled = false;
      previewFramingMode = 'edit';
      previewSampleCrop = null;
    }
    syncCropUi();
    schedulePreviewDraw();
  });

  listen(cropResetBtn, 'click', () => {
    cropEnabled = true;
    cropEnabledCheckbox.checked = true;
    previewFramingMode = 'edit';
    previewSampleCrop = null;
    resetCropToDefault();
    syncCropUi();
    schedulePreviewDraw();
  });

  listen(lockAspectBtn, 'click', () => {
    if (!cropEnabled) return;
    cropLockCheckbox.checked = !cropLockCheckbox.checked;
    // Locked, the frame keeps the shape it has now when it is resized.
    lockedFrameAspect = cropLockCheckbox.checked ? frameAspectNow() : null;
    lockAspectBtn.setAttribute('aria-pressed', cropLockCheckbox.checked ? 'true' : 'false');
    previewFramingMode = 'edit';
    previewSampleCrop = null;
    enforceCropAspect();
    syncCropUi();
    schedulePreviewDraw();
  });

  listen(cropConfirmBtn, 'click', () => {
    void runPreviewUiAction('Preview framing', async () => {
      if (!cropEnabled) return false;
      if (previewFramingMode === 'applied') {
        previewFramingMode = 'edit';
        if (
          previewEnabledCheckbox.checked &&
          (
            !previewSampleFull ||
            !isPreviewSampleCurrent(previewSampleFull)
          )
        ) {
          const committed =
            await buildPreviewSample({ mode: 'full' });
          if (!committed) return false;
        }
        if (previewDisposed) return false;
        syncCropUi();
        drawPreview();
        return true;
      }
      if (!previewEnabledCheckbox.checked) {
        previewEnabledCheckbox.checked = true;
        syncFormatDependentUi();
      }
      if (
        !previewSampleFull ||
        !isPreviewSampleCurrent(previewSampleFull)
      ) {
        const committed =
          await buildPreviewSample({ mode: 'full' });
        if (!committed) return false;
      }
      if (previewDisposed) return false;
      previewFramingMode = 'applied';
      syncCropUi();
      if (
        !previewSampleCrop ||
        !isPreviewSampleCurrent(previewSampleCrop)
      ) {
        const committed =
          await buildPreviewSample({ mode: 'crop' });
        if (!committed) return false;
      }
      if (previewDisposed) return false;
      drawPreview();
      return true;
    });
  });

  /**
   * Frame every cell the figure draws (`engine.cellsFrame`): Frame export
   * on, the frame the cells' extent, its shape free. The preview is turned
   * on, as a frame is drawn on it. False when no cell is drawn.
   *
   * @returns {boolean}
   */
  function fitFrameToCells() {
    const rect = engine.cellsFrame({ exportAllViews: exportAllViewsCheckbox.checked });
    if (rect === null) {
      previewStatus.textContent = 'No cell is drawn to fit.';
      return false;
    }
    if (!previewEnabledCheckbox.checked) {
      previewEnabledCheckbox.checked = true;
      previewEnabledCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
    cropEnabled = true;
    cropEnabledCheckbox.checked = true;
    cropLockCheckbox.checked = false;
    lockedFrameAspect = null;
    previewFramingMode = 'edit';
    previewSampleCrop = null;
    cropRect01 = { ...rect };
    cellsFrameRect = { ...rect };
    syncCropUi();
    schedulePreviewDraw();
    return true;
  }
  listen(fitCellsBtn, 'click', fitFrameToCells);
  listen(shapeNoteFitBtn, 'click', fitFrameToCells);

  // ---------------------------------------------------------------------------
  // The figure's width (millimetres) and its text (points): `utils/figure-size.js`
  // ---------------------------------------------------------------------------

  /** The width box's millimetres, or null while it holds no width (said on Export). */
  function widthMmNow() {
    const value = readDecimalInput(widthInput);
    return Number.isFinite(value) && value >= FIGURE_EXPORT_SETTING_RANGES.widthMm[0] ? value : null;
  }

  // The last valid width and text sizes while a box holds a value being typed
  // (`committedNumbers`, set up with the panel below).
  const committedWidthMm = () => committedNumbers.width.read();
  const committedTextPt = key => committedNumbers[key].read();

  /** The width the figure fills, in figure pixels (the last valid width while one is typed). */
  function figureWidthPx() {
    return figureWidthPxOf(widthMmNow() ?? committedWidthMm());
  }

  /** A text box's points as figure pixels (its last valid size while one is typed). */
  function textPx(input, key) {
    const value = readDecimalInput(input);
    const pt = Number.isFinite(value) && value > 0 ? value : committedTextPt(key);
    return figurePxOfPt(pt);
  }

  function syncTextSizingUi() {
    const auto = autoTextSizingCheckbox.checked;
    const inputs = {
      base: fontSizeInput,
      legend: legendFontSizeInput,
      ticks: tickFontSizeInput,
      axisLabel: axisLabelFontSizeInput,
      title: titleFontSizeInput,
      centroidLabel: centroidLabelFontSizeInput,
    };
    for (const el of Object.values(inputs)) {
      setControlAvailability(el, auto ? 'Auto text sets the sizes journals print figure text at; turn Auto text off to set your own' : null);
    }
    if (!auto) return;
    // The same printed sizes at any width: text in points does not grow with the figure.
    for (const [key, input] of Object.entries(inputs)) writeDecimalInput(input, FIGURE_STANDARD_TEXT_PT[key]);
  }

  listen(autoTextSizingCheckbox, 'change', () => {
    syncTextSizingUi();
    schedulePreviewDraw();
  });

  /**
   * The figure's printed size under the width, and a PNG's pixels at the
   * chosen DPI: the whole size once the preview has laid the figure out (one
   * view), else its width (several panels make their own height; the export
   * picture and Export say it).
   *
   * @param {{width: number, height: number}|null} [figure] - figure pixels
   */
  let lastPreviewFigure = null;
  function syncSizeReadout(figure = null) {
    const dpi = dpiSelect.hidden ? null : Number(dpiSelect.value);
    const grid = engine.figureViewIds({ exportAllViews: exportAllViewsCheckbox.checked }).length > 1;
    // One short line (it never wraps); what it means is its title.
    if (figure !== null && !grid) {
      const pixels = dpi === null ? '' : ` · ${devicePxOf(figure.width, dpi)} × ${devicePxOf(figure.height, dpi)} px`;
      sizeReadout.set(`${figureSizeText(figure)}${pixels}`);
      sizeReadout.root.title = `The figure as printed${dpi === null ? '' : `, and the PNG's pixels at ${dpi} dpi`}.`;
      return;
    }
    const mm = widthMmNow();
    sizeReadout.set(mm === null ? 'Give a width in mm.' : `${formatMm(mm)} mm wide · height from its ${grid ? 'panels' : 'plot'}`);
    sizeReadout.root.title = grid
      ? 'Several panels make their own height; the export picture and Export say it.'
      : 'The preview lays the figure out and says its height.';
  }

  const onFigureWidthChange = () => {
    lastPreviewFigure = null;
    syncSizeReadout();
    syncCropUi();
    invalidatePreviewSamples();
    schedulePreviewDraw();
  };
  // A width typed is a preset's when it is one, else the person's own.
  const onWidthTyped = () => {
    const mm = widthMmNow();
    if (mm !== null) {
      presetSelect.value = Object.keys(FIGURE_WIDTH_PRESETS).find(key => FIGURE_WIDTH_PRESETS[key] === mm) ?? 'custom';
    }
    onFigureWidthChange();
  };
  listen(widthInput, 'input', onWidthTyped);
  listen(widthInput, 'change', onWidthTyped);

  listen(presetSelect, 'change', () => {
    const value = presetSelect.value;
    if (Object.hasOwn(FIGURE_WIDTH_PRESETS, value)) writeDecimalInput(widthInput, FIGURE_WIDTH_PRESETS[value]);
    onFigureWidthChange();
  });

  syncTextSizingUi();

  // Dynamic title: keep in sync with dataset + shown categories until the user edits.
  let titleAutofillEnabled = true;
  let lastAutoTitle = '';
  let settingAutoTitle = false;

  function buildAutoTitle() {
    const sidebarNameEl = typeof document !== 'undefined' ? document.getElementById('dataset-name') : null;
    const datasetName = String(sidebarNameEl?.textContent || '').trim();
    const safeDataset = datasetName && datasetName !== '–' && datasetName !== '—' ? datasetName : '';

    const viewId = getActiveViewIdForPreview();
    const legendField = typeof state?.getFieldForView === 'function'
      ? state.getFieldForView(viewId)
      : (typeof state?.getActiveField === 'function' ? state.getActiveField() : null);
    // A grid of panels colored by different fields is titled by the dataset alone: each panel
    // names its own field ("A. cell_type", "B. organ"), so one view's must not stand for all.
    if (panelsDifferInField()) return figureAutoTitle({ datasetName: safeDataset, fieldLabel: '', legendModel: null });
    // One view (not a grid of panels, each titled by its own view's name): the name it was given.
    const viewName = exportAllViewsCheckbox.checked && viewer.getViewLayout().mode === 'grid' ? null : viewer.getViewName(viewId);
    const fieldLabel = String(legendField?.label || legendField?.name || legendField?.key || '').trim();

    const legendModel = legendField && typeof state?.getLegendModel === 'function' ? state.getLegendModel(legendField) : null;
    // One view: the filters on other fields, which its legend no longer lists categories for (a grid's
    // panels each name theirs in their label).
    const otherFilters = exportAllViewsCheckbox.checked || typeof state?.getActiveFiltersStructured !== 'function'
      ? []
      : state.getActiveFiltersStructured()
        .filter(filter => filter.enabled && filter.fieldKey !== legendField?.key)
        .map(filter => filter.text);
    return figureAutoTitle({ datasetName: safeDataset, fieldLabel, legendModel, otherFilters, viewName });
  }

  /** Whether Export all views draws a grid whose panels are colored by different fields. */
  function panelsDifferInField() {
    if (!exportAllViewsCheckbox.checked) return false;
    return gridPanelsDifferInField({
      viewLayout: viewer.getViewLayout(),
      snapshotViewIds: viewer.getSnapshotViews().map(view => view.id),
      fieldKeyOf: viewId => state.getFieldForView(viewId)?.key ?? null
    });
  }

  function syncAutoTitle() {
    if (cleanupComplete || previewDisposed) return;
    if (!titleAutofillEnabled) return;
    const next = buildAutoTitle();
    if (!next) {
      if (!String(titleInput.value || '').trim()) {
        settingAutoTitle = true;
        titleInput.value = 'Figure';
        settingAutoTitle = false;
        lastAutoTitle = 'Figure';
      }
      return;
    }
    if (next === lastAutoTitle && String(titleInput.value || '') === next) return;
    settingAutoTitle = true;
    titleInput.value = next;
    settingAutoTitle = false;
    lastAutoTitle = next;
    schedulePreviewDraw();
  }

  listen(titleInput, 'input', (evt) => {
    if (settingAutoTitle) return;
    const isTrusted = evt?.isTrusted === true;
    const value = String(titleInput.value || '').trim();
    if (isTrusted) {
      titleAutofillEnabled = false;
      return;
    }
    if (!value) {
      titleAutofillEnabled = true;
      syncAutoTitleSoon();
      return;
    }
    const auto = buildAutoTitle();
    titleAutofillEnabled = value === lastAutoTitle || (auto && value === auto);
  });

  if (typeof state.on !== 'function') {
    throw new TypeError('Figure export state must publish on().');
  }
  const subscribePreviewInvalidation = (
    eventName,
    { title = false } = {}
  ) => {
    const unsubscribe = state.on(eventName, () => {
      if (previewDisposed) return;
      if (title) syncAutoTitle();
      invalidatePreviewSamples();
    });
    if (typeof unsubscribe !== 'function') {
      throw new TypeError(
        `Figure export "${eventName}" subscription must return a cleanup function.`
      );
    }
    cleanupFns.push(unsubscribe);
  };
  // Export all views decides whether one field titles the figure (`panelsDifferInField`).
  listen(exportAllViewsCheckbox, 'change', () => syncAutoTitle());
  subscribePreviewInvalidation('field:changed', {
    title: true,
  });
  subscribePreviewInvalidation('visibility:changed', {
    title: true,
  });
  subscribePreviewInvalidation('highlight:changed');
  subscribePreviewInvalidation('view:representation-changed');
  subscribePreviewInvalidation('view:changed', {
    title: true,
  });
  subscribePreviewInvalidation('page:changed', {
    title: true,
  });
  if (typeof viewer.onLodChanged !== 'function') {
    throw new TypeError(
      'Figure export viewer must publish onLodChanged().'
    );
  }
  const lodCleanup = viewer.onLodChanged(() => {
    if (previewDisposed) return;
    // Levels of detail step while the camera moves: drop the sample, and let
    // the camera's settling rebuild it once instead of once per step.
    if (viewer.isCameraInMotion()) invalidatePreviewSamples({ rebuild: false });
    else invalidatePreviewSamples();
  });
  if (typeof lodCleanup !== 'function') {
    throw new TypeError(
      'Figure export LOD subscription must return a cleanup function.'
    );
  }
  cleanupFns.push(lodCleanup);
  const presentedCleanup =
    viewer.onPresentedViewStateChanged((event) => {
      if (previewDisposed) return;
      if (event?.reason === 'camera-changing') {
        // The viewer emits this once per motion burst. Drop the stale sample
        // immediately and do no preview work while the camera is moving.
        invalidatePreviewSamples({ rebuild: false });
        return;
      }
      if (event?.reason === 'camera-settled') {
        // Viewer-side settling is authoritative; rebuild on the next task.
        invalidatePreviewSamples();
        return;
      }
      if (event?.reason === 'lod' && viewer.isCameraInMotion()) {
        invalidatePreviewSamples({ rebuild: false });
        return;
      }
      // A view named (`view.rename`): a named view titles the figure.
      if (event?.reason === 'names') syncAutoTitle();
      // The panes' shapes may have changed (a resized window, a view kept or
      // removed): the shape note follows them at once, not at the next picture.
      if (!cleanupComplete) syncShapeNote();
      // Discrete layout/style publications can arrive in short bursts.
      invalidatePreviewSamples({
        rebuildDelayMs: PREVIEW_PRESENTATION_SETTLE_MS,
      });
    });
  if (typeof presentedCleanup !== 'function') {
    throw new TypeError(
      'Figure export presented-state subscription must return a cleanup function.'
    );
  }
  cleanupFns.push(presentedCleanup);
  const nameEl = document.getElementById('dataset-name');
  if (nameEl) {
    const observer = new MutationObserver(syncAutoTitle);
    observer.observe(nameEl, { childList: true, characterData: true, subtree: true });
    cleanupFns.push(() => observer.disconnect());
  }

  // Seed title once after init (before any state updates arrive).
  syncAutoTitle();

  // The point size is the viewer's renderState pointSize (WYSIWYG).

  // A figure of no cells is empty, so Export follows the runtime's cells as
  // well as the export in flight.
  let exportBusy = false;
  let cellsPresent = false;

  function syncExportAvailability() {
    // While an export runs the button stops it: there is always a way out.
    exportBtn.disabled = !exportBusy && !cellsPresent;
    exportBtn.title = cellsPresent ? '' : openADatasetTo('export a figure');
  }

  function setBusy(busy) {
    exportBusy = busy;
    syncExportAvailability();
    exportBtn.textContent = busy ? 'Cancel export' : 'Export';
  }

  /**
   * @param {boolean} present
   */
  function setCellsPresent(present) {
    if (typeof present !== 'boolean') {
      throw new TypeError('Figure-export cell presence must be one boolean.');
    }
    if (cleanupComplete) return;
    cellsPresent = present;
    syncExportAvailability();
  }
  syncExportAvailability();

  function inferVisiblePointCount() {
    const viewerCount = viewer.getPointCount();
    const stateCount = state.pointCount;
    if (
      !Number.isSafeInteger(viewerCount) ||
      viewerCount < 0 ||
      !Number.isSafeInteger(stateCount) ||
      stateCount < 0
    ) {
      throw new TypeError(
        'Figure preview requires exact non-negative viewer and state point counts.'
      );
    }
    if (viewerCount !== stateCount) {
      throw new Error(
        `Figure preview point-count mismatch: viewer has ${formatCountOf(viewerCount, 'point')} while state has ${stateCount}.`
      );
    }
    if (typeof state.getFilteredCount !== 'function') {
      throw new TypeError('Figure preview state must publish getFilteredCount().');
    }
    const filtered = state.getFilteredCount();
    if (
      filtered === null ||
      typeof filtered !== 'object' ||
      !Number.isSafeInteger(filtered.shown) ||
      filtered.shown < 0 ||
      filtered.shown > stateCount
    ) {
      throw new TypeError(
        'Figure preview filter count must publish an exact valid shown count.'
      );
    }
    return filtered.shown;
  }

  // ---------------------------------------------------------------------------
  // Preview (low-cost, debounced, and safe for large datasets)
  // ---------------------------------------------------------------------------

  const PREVIEW_TARGET_POINTS = 15000;
  const PREVIEW_MAX_SCAN_POINTS = 250000;

  /** @type {{ viewId: string; renderState: any; reduced: any; dim: number; layoutKey: string; cameraState: any; navMode: string; certificate: any; ticket: any; mode: 'full' } | null} */
  let previewSampleFull = null;
  /** @type {{ viewId: string; renderState: any; reduced: any; dim: number; layoutKey: string; cameraState: any; navMode: string; certificate: any; ticket: any; mode: 'crop'; crop: any } | null} */
  let previewSampleCrop = null;
  /** @type {'edit'|'applied'} */
  let previewFramingMode = 'edit';
  // The preview is drawn, rebuilt and titled once its controls settle.
  const drawPreviewSoon = debounce(() => {
    if (cleanupComplete || previewDisposed) return;
    // The viewer background can change while this panel is open, so the
    // reference-grid control's availability is re-resolved every draw.
    syncAnnotationUi();
    drawPreview();
  }, 80);
  /** @type {import('../../../../utils/debounce.js').Debounced<[delayMs: number]>} */
  const rebuildPreviewSoon = debounce(() => {
    if (
      cleanupComplete ||
      previewDisposed ||
      !previewEnabledCheckbox.checked
    ) {
      return;
    }
    const mode =
      cropEnabled && previewFramingMode === 'applied'
        ? 'crop'
        : 'full';
    void runPreviewUiAction(
      'Automatic preview rebuild',
      async () => {
        const committed = await buildPreviewSample({ mode });
        if (committed && !previewDisposed) drawPreview();
        return committed;
      }
    );
  }, delayMs => delayMs);
  const syncAutoTitleSoon = debounce(() => {
    if (!cleanupComplete && !previewDisposed) syncAutoTitle();
  }, 0);
  let previewPendingFrame = null;
  let previewBuildToken = 0;

  /** @type {{ x: number; y: number; width: number; height: number }} */
  let cropRect01 = { x: 0, y: 0, width: 1, height: 1 };
  let cropEnabled = false;
  // The frame Fit the cells set last (null: none): while the frame is still
  // it, the shape note has nothing to offer.
  let cellsFrameRect = null;

  /** @type {{ scale: number; ox: number; oy: number; viewportRect: { x: number; y: number; width: number; height: number } | null } | null} */
  let previewGeom = null;

  /** @type {{ mode: 'move'|'resize-nw'|'resize-ne'|'resize-sw'|'resize-se'; pointerId: number; startX: number; startY: number; start: any } | null} */
  let cropDrag = null;

  function releasePreviewSamples() {
    previewSampleFull = null;
    previewSampleCrop = null;
    previewGeom = null;
  }

  function cancelPendingPreviewFrame() {
    const owner = previewPendingFrame;
    if (owner === null) return;
    previewPendingFrame = null;
    cancelAnimationFrame(owner.id);
    owner.resolve(false);
  }

  function waitForPreviewFrame() {
    if (cleanupComplete || previewDisposed) {
      return Promise.resolve(false);
    }
    cancelPendingPreviewFrame();
    return new Promise((resolve) => {
      const owner = {
        id: 0,
        resolve,
      };
      owner.id = requestAnimationFrame(() => {
        if (previewPendingFrame !== owner) {
          resolve(false);
          return;
        }
        previewPendingFrame = null;
        resolve(!cleanupComplete && !previewDisposed);
      });
      previewPendingFrame = owner;
    });
  }

  // A preview the user cannot see (Figure Export collapsed, or the sidebar
  // hidden) is not rebuilt on every filter, highlight or camera change; the
  // last request runs once when the panel is shown again.
  let previewRebuildGate = null;

  function queuePreviewRebuild(delayMs = 0) {
    if (previewRebuildGate === null) {
      startPreviewRebuild(delayMs);
      return;
    }
    previewRebuildGate.request(delayMs);
  }

  function startPreviewRebuild(delayMs) {
    if (
      cleanupComplete ||
      previewDisposed ||
      !previewEnabledCheckbox.checked
    ) {
      return;
    }
    rebuildPreviewSoon(delayMs);
  }

  function invalidatePreviewSamples({
    rebuild = true,
    rebuildDelayMs = 0,
  } = {}) {
    if (cleanupComplete || previewDisposed) return;
    previewEpochFence.invalidate();
    previewBuildToken++;
    cancelPendingPreviewFrame();
    releasePreviewSamples();
    rebuildPreviewSoon.cancel();
    if (rebuild) queuePreviewRebuild(rebuildDelayMs);
  }

  cleanupFns.push(() => {
    previewDisposed = true;
    previewEpochFence.close();
    previewBuildToken++;
    cancelPendingPreviewFrame();
    drawPreviewSoon.cancel();
    rebuildPreviewSoon.cancel();
    syncAutoTitleSoon.cancel();
    endCropDrag();
    releasePreviewSamples();
    lastAutoTitle = '';
  });

  /** The shape a locked frame keeps (its width / height on screen), taken when Lock aspect is turned on. */
  let lockedFrameAspect = null;

  /** The frame's shape on screen (width / height). */
  function frameAspectNow() {
    const viewportAspect = getViewportAspect();
    return (cropRect01.width / Math.max(1e-6, cropRect01.height)) * viewportAspect;
  }

  /**
   * The shape the plot takes: the frame's while framing (a locked frame the
   * shape it had when locked), else the view's. The figure fills its width at
   * the height this shape gives (`fillSingleViewWidth`).
   */
  function getExportAspect() {
    if (cropEnabled && cropLockCheckbox.checked && lockedFrameAspect !== null) return lockedFrameAspect;
    return cropEnabled ? frameAspectNow() : getViewportAspect();
  }

  function getViewportAspect() {
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
    setControlAvailability(cropLockCheckbox, cropEnabled ? null : 'turn Frame export on to frame the figure first');
    cropConfirmBtn.disabled = !cropEnabled;
    lockAspectBtn.disabled = !cropEnabled;
    lockAspectBtn.setAttribute('aria-pressed', cropLockCheckbox.checked ? 'true' : 'false');

    framingActionGrid.hidden = !cropEnabled;
    cropAspectHint.hidden = !cropEnabled;

    const isApplied = previewFramingMode === 'applied';
    cropConfirmBtn.textContent = isApplied ? 'Edit' : 'Confirm';
    cropConfirmBtn.setAttribute('aria-pressed', isApplied ? 'true' : 'false');

    const exportAspect = getExportAspect();
    const plotLabel = formatAspectLabel(exportAspect);

    const viewId = getActiveViewIdForPreview();
    const rs = getPreviewRenderStateForView(viewId);
    const vw = Math.max(1, Number(rs?.viewportWidth) || 1);
    const vh = Math.max(1, Number(rs?.viewportHeight) || 1);

    let frameLabel = '—';
    let zoomLabel = '';
    if (cropEnabled) {
      const c = assertCropRect01({ enabled: true, ...cropRect01 });
      if (Number.isFinite(c?.width) && Number.isFinite(c?.height) && c.width > 0 && c.height > 0) {
        const frameAspect = (c.width * vw) / Math.max(1e-6, c.height * vh);
        frameLabel = formatAspectLabel(frameAspect);

        // The plot fills the figure's width with the frame instead of the
        // whole view: the frame is magnified by the view's width over its own.
        const zoom = 1 / Math.max(1e-6, c.width);
        if (Number.isFinite(zoom) && zoom > 1.01) zoomLabel = ` • Zoom ${zoom.toFixed(2)}×`;
      }
    }

    const lock = cropEnabled && cropLockCheckbox.checked ? ' • locked' : '';
    cropAspectHint.textContent = cropEnabled
      ? `Plot: ${plotLabel} • Frame: ${frameLabel}${lock}${zoomLabel}`
      : `Plot: ${plotLabel}`;

    const keyboardEditable =
      cropEnabled &&
      previewFramingMode === 'edit' &&
      previewEnabledCheckbox.checked;
    previewCanvas.tabIndex = keyboardEditable ? 0 : -1;
    previewCanvas.setAttribute(
      'aria-disabled',
      keyboardEditable ? 'false' : 'true'
    );
    if (cropEnabled) {
      const c = assertCropRect01({ enabled: true, ...cropRect01 });
      const frameDescription = c === null
        ? 'Frame unavailable.'
        : (
          `Frame starts at ${Math.round(c.x * 100)} percent from the left and ` +
          `${Math.round(c.y * 100)} percent from the top, with ` +
          `${Math.round(c.width * 100)} percent width and ` +
          `${Math.round(c.height * 100)} percent height.`
        );
      previewCanvas.ariaLabel =
        `Figure export framing preview. ${frameDescription} ` +
        'Arrow keys move the frame; Shift plus arrow keys resize it; Home resets it.';
    } else {
      previewCanvas.ariaLabel = 'Figure export preview';
    }

    if (!keyboardEditable) {
      delete previewCanvas.dataset.cropCursor;
    }
  }

  function resetCropToDefault() {
    if (!cropEnabled || !cropLockCheckbox.checked) {
      cropRect01 = { x: 0, y: 0, width: 1, height: 1 };
      return;
    }
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
    if (!cropEnabled || !cropLockCheckbox.checked) return;
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
    const normalized = assertCropRect01({ enabled: true, ...cropRect01 });
    return normalized ? { enabled: true, ...normalized } : null;
  }

  /**
   * The preview's one line when a panel is far from the shape of the cells
   * it draws: each panel's source (its pane, or the frame) against the frame
   * that holds its cells (`engine.cellsFrame`, every panel's for Export all
   * views), with Fit the cells offered. The figure fills its width at the
   * height the panels' shapes give, so a narrow pane of a wide embedding is a
   * tall figure with the cells in a band. Hidden while the frame is the one
   * Fit the cells set, and with the preview off.
   */
  function syncShapeNote() {
    const fitted = cropEnabled && cellsFrameRect !== null
      && ['x', 'y', 'width', 'height'].every(key => Math.abs(cropRect01[key] - cellsFrameRect[key]) < 1e-9);
    let text = null;
    if (previewEnabledCheckbox.checked && !fitted) {
      const exportAllViews = exportAllViewsCheckbox.checked;
      const viewIds = engine.figureViewIds({ exportAllViews });
      const grid = viewIds.length > 1;
      const cells = engine.cellsFrame({ exportAllViews });
      const crop = getCropOptionForExport();
      const panels = cells === null ? [] : viewIds
        .map(viewId => getPreviewRenderStateForView(viewId))
        .filter(renderState => renderState !== null)
        .map(renderState => ({
          source: figureSourceAspect({ renderState, crop }),
          cells: (cells.width * renderState.viewportWidth) / Math.max(1e-6, cells.height * renderState.viewportHeight),
        }));
      const { far, narrower } = panelShapeAgainstCells(panels);
      if (far) {
        // One short line; why is its title.
        text = `${grid ? 'Panels' : 'Plot'} ${narrower ? 'narrower' : 'wider'} than the cells:`;
        shapeNote.title = `Each plot takes ${crop === null ? 'its pane\'s shape on screen' : 'the frame\'s shape'}, and the figure fills its width at the height that shape gives, so the cells fill only ${narrower ? 'a band across' : 'part of'} it. Fit the cells frames the cells instead.`;
      }
    }
    shapeNote.hidden = text === null;
    shapeNoteText.textContent = text ?? '';
  }

  function getActiveViewIdForPreview() {
    const viewId = String(state.getActiveViewId());
    if (viewId.length === 0) {
      throw new Error(
        'Figure preview requires one non-empty active view ID.'
      );
    }
    return viewId;
  }

  function getPresentedPreviewState(viewId) {
    const exactViewId = String(viewId);
    const presented = viewer.getPresentedViewState(exactViewId);
    if (
      presented === null ||
      typeof presented !== 'object' ||
      Array.isArray(presented) ||
      presented.renderState === null ||
      typeof presented.renderState !== 'object' ||
      !presented.renderState.mvpMatrix ||
      !Number.isFinite(presented.renderState.pointSize) ||
      presented.renderState.pointSize <= 0 ||
      !Number.isFinite(presented.lodSizeMultiplier) ||
      presented.lodSizeMultiplier <= 0 ||
      !Number.isInteger(presented.dimensionLevel) ||
      presented.dimensionLevel < 1 ||
      presented.dimensionLevel > 3 ||
      presented.geometryGeneration === undefined ||
      presented.certificate === null ||
      typeof presented.certificate !== 'object' ||
      !Object.isFrozen(presented.certificate) ||
      typeof presented.certificate.cacheKey !== 'string'
    ) {
      throw new TypeError(
        `Figure preview has no exact presented state for view "${exactViewId}".`
      );
    }
    assertCameraState(
      presented.cameraState,
      `Figure-preview camera state for "${exactViewId}"`
    );
    return presented;
  }

  function getPreviewRenderStateForView(viewId) {
    try {
      return getPresentedPreviewState(viewId).renderState;
    } catch {
      return null;
    }
  }

  function capturePreviewCertificate(
    mode,
    presented = null
  ) {
    if (mode !== 'full' && mode !== 'crop') {
      throw new TypeError(
        'Figure preview sample mode must be "full" or "crop".'
      );
    }
    const viewId = getActiveViewIdForPreview();
    const exactPresented =
      presented ?? getPresentedPreviewState(viewId);
    const field =
      typeof state.getFieldForView === 'function'
        ? state.getFieldForView(viewId)
        : (
            typeof state.getActiveField === 'function'
              ? state.getActiveField()
              : null
          );
    const crop =
      mode === 'crop' ? getCropOptionForExport() : null;
    const filtered =
      typeof state.getFilteredCount === 'function'
        ? state.getFilteredCount()
        : null;
    const highlighted =
      typeof state.getTotalHighlightedCellCount === 'function'
        ? state.getTotalHighlightedCellCount()
        : 0;
    return Object.freeze({
      // The width the figure fills (figure pixels): a sample is of one figure.
      figureWidth: figureWidthPx(),
      crop: crop === null
        ? null
        : Object.freeze({
            height: crop.height,
            width: crop.width,
            x: crop.x,
            y: crop.y,
          }),
      dimensionLevel: exactPresented.dimensionLevel,
      fieldKey: field?.key ?? null,
      filteredShown:
        Number.isSafeInteger(filtered?.shown)
          ? filtered.shown
          : null,
      geometryGeneration:
        exactPresented.geometryGeneration,
      highlighted,
      lodGeneration:
        exactPresented.lodMembership?.generationToken ?? null,
      lodLevel:
        exactPresented.lodMembership?.lodLevel ?? -1,
      mode,
      pointCount: state.pointCount,
      presentedCacheKey:
        exactPresented.certificate.cacheKey,
      presentedLodToken:
        exactPresented.certificate.lodGenerationToken ??
        null,
      viewId,
    });
  }

  function isPreviewSampleCurrent(sample) {
    if (!sample || previewDisposed) return false;
    try {
      const current = capturePreviewCertificate(sample.mode);
      return previewEpochFence.accepts(
        sample.ticket,
        current
      );
    } catch {
      return false;
    }
  }

  function hasUsableWebgl2Context() {
    // The point pass draws on an OffscreenCanvas (in the export worker, or on
    // the page where a worker has no WebGL2).
    if (typeof WebGL2RenderingContext !== 'function' || typeof OffscreenCanvas !== 'function') return false;
    try {
      const gl = viewer.getGLContext();
      return (
        gl instanceof WebGL2RenderingContext &&
        gl.isContextLost() === false
      );
    } catch {
      return false;
    }
  }

  function clearPreview() {
    previewGeom = null;
    const ctx = /** @type {CanvasRenderingContext2D|null} */ (previewCanvas.getContext('2d'));
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    }
  }

  /**
   * Build or refresh the preview sample (downsampled point cloud in viewport space).
   * This intentionally avoids any work in the main render loop.
   *
   * @returns {Promise<boolean>} Whether this invocation committed the newest sample.
   */
  async function buildPreviewSample({ force = false, mode = 'full' } = {}) {
    if (cleanupComplete || previewDisposed) return false;
    const wantsCrop = mode === 'crop';
    const existing =
      wantsCrop ? previewSampleCrop : previewSampleFull;
    if (!force && existing && isPreviewSampleCurrent(existing)) {
      return true;
    }
    if (force || existing) {
      invalidatePreviewSamples({ rebuild: false });
    }

    // The viewer's and the state's cell counts must be exact before a preview is built.
    inferVisiblePointCount();
    // Refresh bypasses cache ownership only. It never removes the bounded scan
    // contract and therefore cannot turn a preview request into an O(N) pass.
    const maxScanPoints = PREVIEW_MAX_SCAN_POINTS;

    const token = ++previewBuildToken;
    previewStatus.textContent = wantsCrop
      ? 'Building framed preview…'
      : 'Building preview…';
    if (!await waitForPreviewFrame()) return false;
    if (
      previewDisposed ||
      token !== previewBuildToken
    ) {
      return false;
    }

    const viewId = getActiveViewIdForPreview();
    const candidate = viewer.withBorrowedViewData(
      viewId,
      ({
        positions,
        colors,
        transparency,
        pointCount,
        dimensionLevel,
        geometryGeneration,
        lodMembership,
      }) => {
        if (
          !(positions instanceof Float32Array) ||
          positions.length !== pointCount * dimensionLevel ||
          !(colors instanceof Uint8Array) ||
          colors.length !== pointCount * 4 ||
          (
            transparency !== null &&
            (
              !(transparency instanceof Uint8Array) ||
              transparency.length !== pointCount
            )
          ) ||
          !Number.isSafeInteger(pointCount) ||
          pointCount < 0
        ) {
          throw new TypeError(
            `Figure preview borrowed invalid point data for view "${viewId}".`
          );
        }
        const currentVisibleCount = inferVisiblePointCount();
        if (pointCount !== state.pointCount) {
          throw new Error(
            `Figure preview borrowed ${formatCountOf(pointCount, 'point')} while state owns ${state.pointCount}.`
          );
        }
        const presented = getPresentedPreviewState(viewId);
        if (
          presented.dimensionLevel !== dimensionLevel ||
          !Object.is(
            presented.geometryGeneration,
            geometryGeneration
          ) ||
          !matchesLodMembershipPresentation(
            presented.lodMembership,
            lodMembership
          )
        ) {
          throw new Error(
            `Figure preview source ownership changed for view "${viewId}".`
          );
        }
        const certificate =
          capturePreviewCertificate(mode, presented);
        const ticket =
          previewEpochFence.capture(certificate);
        const targetCount = Math.min(
          currentVisibleCount,
          PREVIEW_TARGET_POINTS
        );
        const totalHighlighted =
          typeof state.getTotalHighlightedCellCount ===
            'function'
            ? state.getTotalHighlightedCellCount()
            : 0;
        const highlightArray =
          totalHighlighted > 0 ? state.highlightArray : null;
        const sparseOwner =
          state._highlightedCellIndices;
        const highlightedIndices =
          highlightArray !== null &&
          totalHighlighted <= targetCount &&
          (
            Array.isArray(sparseOwner) ||
            sparseOwner instanceof Uint32Array
          ) &&
          sparseOwner.length === totalHighlighted
            ? sparseOwner
            : null;
        const crop =
          wantsCrop ? getCropOptionForExport() : null;
        const reduced = reducePointsByDensity({
          positions,
          dimension: dimensionLevel,
          colors,
          transparency,
          lodMembership,
          highlightArray,
          highlightedIndices,
          renderState: presented.renderState,
          targetCount,
          maxScanPoints,
          seed: 1337,
          crop
        });
        const cameraState = presented.cameraState;
        const pointDiameterViewportPx =
          presented.renderState.pointSize *
          presented.lodSizeMultiplier;
        // Each sampled cell's sprite as the viewer draws it, at its depth
        // (`createViewportPointDiameter`), as the export's circles are.
        const diameterAt = createViewportPointDiameter(presented.renderState);
        const pointDiameters = new Float32Array(reduced.x.length);
        for (let i = 0; i < reduced.x.length; i++) {
          const at = reduced.index[i] * dimensionLevel;
          const x = positions[at];
          const y = dimensionLevel > 1 ? positions[at + 1] : 0;
          const z = dimensionLevel > 2 ? positions[at + 2] : 0;
          pointDiameters[i] = diameterAt(x, y, z, pointDiameterViewportPx);
        }
        return {
          cameraState,
          certificate,
          crop,
          dim: dimensionLevel,
          layoutKey: state.getViewLayoutKey(viewId),
          mode,
          navMode: cameraState.navigationMode,
          pointDiameters,
          reduced,
          renderState: presented.renderState,
          ticket,
          viewId,
        };
      }
    );
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      typeof candidate.then === 'function'
    ) {
      throw new TypeError(
        'Figure preview borrowed-data callback must return one synchronous sample.'
      );
    }
    if (
      previewDisposed ||
      token !== previewBuildToken
    ) {
      return false;
    }
    const currentCertificate =
      capturePreviewCertificate(mode);
    if (
      !previewEpochFence.accepts(
        candidate.ticket,
        currentCertificate
      )
    ) {
      return false;
    }

    if (wantsCrop) previewSampleCrop = candidate;
    else previewSampleFull = candidate;

    if (cropEnabled && cropLockCheckbox.checked) enforceCropAspect();
    if (cropEnabled) syncCropUi();

    const cappedSample =
      candidate.reduced.scannedSourceCount <
      candidate.reduced.candidateSourceCount;
    const label = wantsCrop ? 'Framed preview' : 'Preview sample';
    const sampleCount = candidate.reduced.x.length;
    const emptyNote =
      sampleCount === 0 ? ' • no visible cells' : '';
    // One short line; how the sample was drawn is its detail, not part of the line.
    previewStatus.textContent =
      `${label}: ${formatCountOf(sampleCount, 'cell')}${emptyNote}`;
    previewStatus.title = cappedSample
      ? `Drawn from ${formatCount(candidate.reduced.scannedSourceCount)} of ${formatCountOf(candidate.reduced.candidateSourceCount, 'cell')} spread evenly, for speed; the export draws every visible cell.`
      : 'The export draws every visible cell.';
    return true;
  }

  function schedulePreviewDraw() {
    if (
      cleanupComplete ||
      previewDisposed ||
      !previewEnabledCheckbox.checked
    ) {
      return;
    }
    drawPreviewSoon();
  }

  /**
   * The vector field the preview draws (`components/vector-field-figure.js`),
   * as the export does: the shown field's vectors are read once per view,
   * embedding, field and color scheme (`engine.figureVectorField`), and the
   * arrows are planned at each draw on the view's own cells, borrowed.
   */
  let previewVectorField = { key: null, field: null, pending: null };
  /** What the preview's vector field is read for (the sample's view and embedding, the field, its colors), or null when none is shown. */
  function previewVectorFieldKey(sample) {
    const shown = readShownVectorFieldOverlay(document);
    if (shown === null || !sample) return null;
    return [sample.viewId, sample.layoutKey, shown.fieldId, shown.colormapId, state.getDatasetGeneration()].join('\u0000');
  }

  /** The vector field the preview draws now, read for this sample, or null (none shown, or not read yet). */
  function previewVectorFieldNow(sample) {
    const key = previewVectorFieldKey(sample);
    return key !== null && previewVectorField.key === key ? previewVectorField.field : null;
  }

  function drawPreviewVectorField(ctx, sample, plotRect, crop, style) {
    const key = previewVectorFieldKey(sample);
    if (key === null) return;
    if (previewVectorField.key !== key) {
      if (previewVectorField.pending !== key) {
        previewVectorField = { ...previewVectorField, pending: key };
        engine.figureVectorField(sample.viewId).then((field) => {
          if (previewDisposed || previewVectorField.pending !== key) return;
          previewVectorField = { key, field, pending: null };
          schedulePreviewDraw();
        }, (error) => {
          if (previewVectorField.pending === key) previewVectorField = { ...previewVectorField, pending: null };
          reportPreviewFailure('vector field', error);
        });
      }
      return;
    }
    const field = previewVectorField.field;
    if (field === null) return;
    viewer.withBorrowedViewData(sample.viewId, ({ positions, transparency, dimensionLevel, pointCount }) => {
      // The cells changed since the vectors were read: the next read draws them.
      if (field.vectors.length !== pointCount * dimensionLevel) return;
      drawCanvasVectorFieldOf(ctx, {
        data: { vectorField: field, positions, transparency }, dimension: dimensionLevel,
        renderState: sample.renderState, plotRect, crop, ...style,
      });
    });
  }

  function drawPreview() {
    if (
      previewDisposed ||
      !previewEnabledCheckbox.checked
    ) {
      return;
    }
    // Every picture of the preview says whether a panel is far from the shape
    // asked for, against the panes as they are now (a resized window, a view
    // kept or removed reaches here through the presented-state rebuild).
    syncShapeNote();

    const ctx = /** @type {CanvasRenderingContext2D|null} */ (previewCanvas.getContext('2d'));
    if (!ctx) return;

    const exportW = figureWidthPx();
    const canvasW = previewCanvas.width;
    const canvasH = previewCanvas.height;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvasW, canvasH);

    let sample = previewFramingMode === 'applied'
      ? (previewSampleCrop || previewSampleFull)
      : previewSampleFull;
    if (sample && !isPreviewSampleCurrent(sample)) {
      invalidatePreviewSamples();
      sample = null;
    }
    const titleText = String(titleInput.value || '').trim();
    const fontFamily = String(fontSelect.value || 'Arial, Helvetica, sans-serif');
    // The text at its printed size (points as figure pixels), as the export sets it.
    const baseFontSizePx = textPx(fontSizeInput, 'base');
    const legendFontSizePx = textPx(legendFontSizeInput, 'legend');
    const tickFontSizePx = textPx(tickFontSizeInput, 'ticks');
    const axisLabelFontSizePx = textPx(axisLabelFontSizeInput, 'axisLabel');
    const titleFontSizePx = textPx(titleFontSizeInput, 'title');
    const centroidLabelFontSizePx = textPx(centroidLabelFontSizeInput, 'centroidLabel');

    const includeLegend = includeLegendCheckbox.checked;
    const legendPosition = legendPosSelect.value === 'bottom' ? 'bottom' : 'right';
    const includeAxes = includeAxesCheckbox.checked;

    const legendViewId = sample?.viewId || getActiveViewIdForPreview();
    const legendField = includeLegend && typeof state.getFieldForView === 'function'
      ? state.getFieldForView(legendViewId)
      : (includeLegend && typeof state.getActiveField === 'function' ? state.getActiveField() : null);
    const legendModel = legendField && typeof state.getLegendModel === 'function' ? state.getLegendModel(legendField) : null;
    const legendFieldKey = legendField?.key || null;

    // The preview's source: the view, or the crop once framing is applied.
    // The plot takes its aspect and the source fills it (`plot-fit.js`).
    const rs = sample?.renderState || getPreviewRenderStateForView(getActiveViewIdForPreview());
    // Axes only where they are rulers (`figureViewHasAxes`), as the export draws them.
    let previewPresented = null;
    if (!sample) {
      try {
        previewPresented = getPresentedPreviewState(getActiveViewIdForPreview());
      } catch {
        previewPresented = null;
      }
    }
    const axesEligible = includeAxes && (sample
      ? figureViewHasAxes({ dimension: sample.dim, navigationMode: sample.navMode })
      : previewPresented !== null && figureViewHasAxes({
        dimension: previewPresented.dimensionLevel,
        navigationMode: previewPresented.cameraState.navigationMode,
      }));
    // The raw crop input, not a normalized rect: `assertCropRect01()`
    // returns a four-key rect that is not itself valid crop input.
    const previewCrop = cropEnabled && previewFramingMode === 'applied'
      ? { enabled: true, ...cropRect01 }
      : null;
    // The axes and their margins, laid out as the export lays them out
    // (`computeFigureLayout`): what they show is the sample's view.
    let previewAxes = null;
    if (axesEligible && sample) {
      if (typeof state.dimensionManager?.getNormTransform !== 'function') {
        throw new TypeError(
          'Figure preview state must publish dimensionManager.getNormTransform().'
        );
      }
      const bounds = computeSourceAxisBounds({
        renderState: rs,
        crop: previewCrop,
        dimension: sample.dim,
        cameraState: sample.cameraState,
        normTransform: state.dimensionManager.getNormTransform(sample.layoutKey),
      });
      if (bounds !== null) {
        previewAxes = {
          bounds,
          xLabel: xLabelInput.value,
          yLabel: yLabelInput.value,
          tickFontPx: tickFontSizePx,
          labelFontPx: axisLabelFontSizePx,
        };
      }
    }
    // The legend's entry for the highlighted cells the view draws, as the
    // export's (`figureHighlightLegend`).
    const highlightedTotal = typeof state.getTotalHighlightedCellCount === 'function'
      ? state.getTotalHighlightedCellCount()
      : 0;
    const legendHighlight = includeLegend && highlightedTotal > 0
      && typeof state.getHighlightedCellCount === 'function' && state.getHighlightedCellCount() > 0
      ? highlightLegendEntry({ pageName: state.getActivePage?.()?.name ?? null, cellCount: highlightedTotal })
      : null;
    // The export's layout of the figure that fills its width (`fillSingleViewWidth`).
    const layout = fillSingleViewWidth({
      width: exportW,
      plotAspect: figureSourceAspect({ renderState: rs, crop: previewCrop }),
      title: titleText,
      titleFontSizePx,
      axes: previewAxes,
      includeLegend,
      legendPosition,
      legendModel,
      legendFieldKey,
      legendHighlight,
      // The vector field's key, rows of the legend as the export lays it out.
      legendVectorKey: includeLegend && previewVectorFieldNow(sample) !== null
        ? vectorFieldLegendKey(previewVectorFieldNow(sample))
        : null,
      legendFontSizePx,
      fontFamily
    });

    const totalW = layout.totalWidth;
    const totalH = layout.totalHeight;
    lastPreviewFigure = { width: totalW, height: totalH };
    syncSizeReadout(lastPreviewFigure);
    const s = Math.min(canvasW / totalW, canvasH / totalH);
    const ox = (canvasW - totalW * s) / 2;
    const oy = (canvasH - totalH * s) / 2;
    ctx.setTransform(s, 0, 0, s, ox, oy);

    const background = backgroundSelect.value || 'white';
    const previewBg = getPreviewRenderStateForView(legendViewId)?.bgColor;
    const viewerBgHex = previewBg ? hexOfRgb01(previewBg) : '#ffffff';
    const backgroundColor = background === 'custom'
      ? String(backgroundColorInput.value || '#ffffff')
      : (background === 'viewer' ? viewerBgHex : '#ffffff');
    // The preview writes in the same ink the exported file will.
    const ink = resolveFigureInk({ background, backgroundColor });
    if (background !== 'transparent') {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, totalW, totalH);
    }

    if (layout.titleRect) {
      const titleSize = layout.titleFontPx;
      const rect = layout.titleRect;
      ctx.save();
      ctx.fillStyle = ink.text;
      ctx.font = `${titleSize}px ${fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(titleText, rect.x + rect.width / 2, rect.y + titleSize);
      ctx.restore();
    }

    const plotRect = layout.plotRect;
    ctx.strokeStyle = ink.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);

    // The on-screen (full) viewport's place in plot space: the plot itself
    // unless a crop is applied (the source fills the plot).
    const reduced = sample?.reduced || null;
    const placement = createPlotPlacement({ renderState: rs, plotRect, crop: previewCrop });
    const fullViewportW = rs.viewportWidth;
    const fullViewportH = rs.viewportHeight;
    const viewportTopLeft = placement.viewportToPlot(0, 0);
    const viewportRect = {
      x: viewportTopLeft.x,
      y: viewportTopLeft.y,
      width: fullViewportW * placement.scale,
      height: fullViewportH * placement.scale
    };
    previewGeom = { scale: s, ox, oy, viewportRect };

    // The reference grid is a background layer, so the preview draws it before
    // the points and before the "no sample yet" early return: a preview that
    // omitted it would misdescribe the file the button is about to write.
    const previewReferenceGrid = resolveExportReferenceGrid();
    if (previewReferenceGrid !== null && rs?.mvpMatrix && rs?.viewMatrix) {
      const previewSurface = resolveReferenceGridSurface({
        appearance: previewReferenceGrid,
        background,
        backgroundColor,
      });
      ctx.save();
      ctx.beginPath();
      ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
      ctx.clip();
      drawCanvasReferenceGrid({
        ctx,
        model: buildReferenceGridModel({
          appearance: previewReferenceGrid,
          renderState: rs,
          plotRect,
          crop: previewCrop,
          surface: previewSurface,
        }),
      });
      // A backdrop look is drawn offscreen; the preview shows the last
      // raster for this exact state and redraws when a new one lands.
      if (figureDrawsBackdropLook(previewReferenceGrid, previewSurface, rs)) {
        const raster = peekBackdropLookPreview({
          renderState: rs,
          plotRect,
          crop: previewCrop,
          width: Math.max(1, Math.round(plotRect.width * s)),
          height: Math.max(1, Math.round(plotRect.height * s)),
        }, schedulePreviewDraw);
        if (raster !== null) {
          ctx.drawImage(raster, plotRect.x, plotRect.y, plotRect.width, plotRect.height);
        }
      }
      ctx.restore();
    }

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

    const appliedFraming = cropEnabled && previewFramingMode === 'applied';
    const usingCropSample = appliedFraming && Boolean(previewSampleCrop) && sample === previewSampleCrop && Boolean(previewSampleCrop?.crop);

    // Plot-space mapping for the sample's coordinates: a framed sample's are
    // crop-local; a full sample's are viewport-local, and while framing is
    // applied before its framed sample exists, only its cells inside the crop
    // are drawn.
    let srcX0 = 0;
    let srcY0 = 0;
    let cropPxForBounds = null;

    if (appliedFraming && !usingCropSample) {
      const norm = assertCropRect01({ enabled: true, ...cropRect01 });
      if (norm) cropRect01 = norm;
      if (norm) {
        srcX0 = norm.x * fullViewportW;
        srcY0 = norm.y * fullViewportH;
        cropPxForBounds = {
          x: srcX0,
          y: srcY0,
          width: norm.width * fullViewportW,
          height: norm.height * fullViewportH,
        };
      }
    }

    // The source fills the plot: no letterbox offset.
    const plotScale = placement.scale;
    const plotOffsetX = plotRect.x;
    const plotOffsetY = plotRect.y;

    // Preview is heavily downscaled; enforce a minimum dot size in *screen pixels*
    // so points remain visible even when the exported figure is large.
    const minPreviewRadiusPx = (1.2 / Math.max(0.0001, s)) / 2; // 1.2px diameter on screen
    const pointDiameters = sample.pointDiameters;

    // Points (preview always uses the reduced sample).
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
    ctx.clip();

    const totalHighlighted = typeof state?.getTotalHighlightedCellCount === 'function'
      ? state.getTotalHighlightedCellCount()
      : (typeof state?.getHighlightedCellCount === 'function' ? state.getHighlightedCellCount() : 0);
    const emphasizeSelection = emphasizeSelectionCheckbox.checked && totalHighlighted > 0;
    // A decimal box: a point or a comma (`readDecimalInput`).
    const mutedAlpha = readDecimalInput(selectionMutedOpacityInput);
    if (!(mutedAlpha >= 0 && mutedAlpha <= 1)) {
      throw new RangeError('Non-selected opacity must be a number from 0 to 1.');
    }
    const sampledHighlights =
      emphasizeSelection &&
      reduced.highlighted instanceof Uint8Array &&
      reduced.highlighted.length === reduced.x.length
        ? reduced.highlighted
        : null;

    const outN = reduced.x.length;
    for (let i = 0; i < outN; i++) {
      let a = reduced.alpha[i];
      a = Number.isFinite(a) ? a : 1.0;
      if (a < 0) a = 0;
      else if (a > 1) a = 1;
      const j = i * 4;
      let r = reduced.rgba[j];
      let g = reduced.rgba[j + 1];
      let b = reduced.rgba[j + 2];

      if (
        emphasizeSelection &&
        sampledHighlights &&
        sampledHighlights[i] < MIN_VISIBLE_ALPHA_BYTE
      ) {
        r = 160;
        g = 160;
        b = 160;
        a *= mutedAlpha;
      }
      if (a < POINT_VISIBILITY_THRESHOLD) continue;

      const vx = reduced.x[i];
      const vy = reduced.y[i];
      if (appliedFraming && !usingCropSample && cropPxForBounds) {
        if (vx < cropPxForBounds.x || vx > cropPxForBounds.x + cropPxForBounds.width) continue;
        if (vy < cropPxForBounds.y || vy > cropPxForBounds.y + cropPxForBounds.height) continue;
      }
      const mapped = mapFigurePreviewPointToPlot({
        viewportX: vx,
        viewportY: vy,
        sourceOriginX: srcX0,
        sourceOriginY: srcY0,
        plotOffsetX,
        plotOffsetY,
        plotScale,
      });
      const { x, y } = mapped;
      ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
      const pointRadiusPx = Math.max(pointDiameters[i] * 0.5 * plotScale, minPreviewRadiusPx);
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

    // The vector field the view shows, as the export draws it: arrows on a grid.
    drawPreviewVectorField(ctx, sample, plotRect, appliedFraming ? getCropOptionForExport() : null, {
      ink, fontFamily, fontSizePx: baseFontSizePx,
      haloColor: background === 'transparent' ? ink.halo : backgroundColor,
      inPlotKey: !layout.vectorKeyInLegend,
    });

    // Centroid points + labels (matches the viewer overlay; no separate export toggles).
    const centroidFlags = viewer.getCentroidFlags(String(sample.viewId));
    const showCentroidPoints = Boolean(centroidFlags?.points);
    const showCentroidLabels = Boolean(centroidFlags?.labels);

    if (sample?.renderState?.mvpMatrix && (showCentroidPoints || showCentroidLabels)) {
      const vctx = state?.viewContexts?.get?.(String(sample.viewId || 'live')) || state?.viewContexts?.get?.('live') || null;
      const centroidPositions = vctx?.centroidPositions || null;
      const centroidColors = vctx?.centroidColors || null;
      const centroidLabelTexts = Array.isArray(vctx?.centroidLabels)
        ? vctx.centroidLabels.map((entry) => String(entry?.el?.textContent ?? entry?.text ?? ''))
        : null;

      drawCanvasCentroidOverlay({
        ctx,
        positions: centroidPositions,
        colors: centroidColors,
        labelTexts: centroidLabelTexts,
        flags: { points: showCentroidPoints, labels: showCentroidLabels },
        renderState: sample.renderState,
        plotRect,
        pointDiameterViewportPx: sample.renderState.pointSize * 4,
        crop: appliedFraming ? getCropOptionForExport() : null,
        fontFamily,
        labelFontSizePx: centroidLabelFontSizePx,
        labelColor: ink.text,
        haloColor: background === 'transparent' ? ink.halo : backgroundColor,
      });
    }

    if (showOrientationCheckbox.checked && sample.renderState?.viewMatrix && sample.dim > 2 && sample.navMode !== 'planar') {
      const orientationFontSize = clamp(Math.round(baseFontSizePx * 0.9), 11, 22);
      drawCanvasOrientationIndicator({
        ctx,
        plotRect,
        plotScale: placement.scale,
        viewMatrix: sample.renderState.viewMatrix,
        cameraState: sample.cameraState,
        fontFamily,
        fontSize: orientationFontSize,
        ink
      });
    }

    if (emphasizeSelection && typeof state?.getHighlightedCellCount === 'function') {
      // The export's badge (`utils/selection-badge.js`), not a copy of it.
      const badge = buildSelectionBadge({
        count: state.getHighlightedCellCount(),
        plotRect,
        fontSizePx: baseFontSizePx,
      });
      if (badge) drawCanvasSelectionBadge(ctx, badge, fontFamily, baseFontSizePx, ink);
    }

    // Legend.
    if (layout.legendRect) {
      drawCanvasLegend({
        ctx,
        legendRect: layout.legendRect,
        legendPlan: layout.legendPlan,
        model: legendModel,
        fontFamily,
        backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor,
        ink
      });
    }

    // Axes: the rulers of what the plot shows, exactly as the export draws
    // them (the layout's plan); a plot without cells has none.
    if (layout.axes !== null && reduced.x.length > 0) {
      drawCanvasAxes({
        ctx,
        plotRect,
        axes: layout.axes,
        fontFamily,
        color: ink.text
      });
    }

    // Framing overlay (photography-style crop guide).
    if (cropEnabled && previewFramingMode === 'edit' && viewportRect?.width > 1 && viewportRect?.height > 1) {
      const normalized = assertCropRect01({ enabled: true, ...cropRect01 });
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
    const c = assertCropRect01({ enabled: true, ...cropRect01 });
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

    if (!cropLockCheckbox.checked) {
      const width = clamp(Math.min(dx, maxW), minSize, 1);
      const height = clamp(Math.min(dy, maxH), minSize, 1);
      const x = left ? ax - width : ax;
      const y = top ? ay - height : ay;
      return {
        x: clamp(x, 0, 1 - width),
        y: clamp(y, 0, 1 - height),
        width,
        height
      };
    }

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

  // The pointer over the frame says what a drag will do; CSS draws it from
  // this state attribute.
  function updateCropCursor(mode) {
    if (!mode) {
      delete previewCanvas.dataset.cropCursor;
      return;
    }
    previewCanvas.dataset.cropCursor = mode === 'move' ? 'move' : 'resize';
  }

  function resizeCropFromKeyboard(key, step) {
    const current = assertCropRect01({
      enabled: true,
      ...cropRect01,
    });
    if (current === null) return false;

    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
    const delta =
      key === 'ArrowLeft' || key === 'ArrowUp'
        ? -step
        : step;
    let width = current.width;
    let height = current.height;
    if (horizontal) width = Math.max(0.05, width + delta);
    else height = Math.max(0.05, height + delta);

    if (cropLockCheckbox.checked) {
      const effectiveAspect =
        getExportAspect() / Math.max(0.0001, getViewportAspect());
      if (!Number.isFinite(effectiveAspect) || effectiveAspect <= 0) {
        return false;
      }
      if (horizontal) height = width / effectiveAspect;
      else width = height * effectiveAspect;
    }

    const centerX = current.x + current.width / 2;
    const centerY = current.y + current.height / 2;
    const maxWidthAtCenter = Math.max(
      0.0001,
      2 * Math.min(centerX, 1 - centerX)
    );
    const maxHeightAtCenter = Math.max(
      0.0001,
      2 * Math.min(centerY, 1 - centerY)
    );
    const fitScale = Math.min(
      1,
      maxWidthAtCenter / Math.max(0.0001, width),
      maxHeightAtCenter / Math.max(0.0001, height)
    );
    width *= fitScale;
    height *= fitScale;
    cropRect01 = {
      x: clamp(centerX - width / 2, 0, 1 - width),
      y: clamp(centerY - height / 2, 0, 1 - height),
      width,
      height,
    };
    return true;
  }

  listen(previewCanvas, 'pointerdown', (evt) => {
    if (!previewEnabledCheckbox.checked || !cropEnabled) return;
    if (previewFramingMode !== 'edit') return;
    if (
      cropDrag !== null ||
      evt.isPrimary === false ||
      (evt.pointerType === 'mouse' && evt.button !== 0)
    ) {
      return;
    }
    if (!previewGeom?.viewportRect) return;
    if (
      !previewSampleFull?.reduced ||
      !isPreviewSampleCurrent(previewSampleFull)
    ) {
      if (previewSampleFull) invalidatePreviewSamples();
      return;
    }

    const p = getCanvasXYFromPointerEvent(evt);
    const logical = canvasXYToLogical(p.x, p.y);
    if (!logical) return;

    const mode = hitTestCrop(logical);
    if (!mode) return;

    const norm = logicalToViewportNorm(logical);
    if (!norm) return;

    cropDrag = {
      mode,
      pointerId: evt.pointerId,
      startX: norm.x,
      startY: norm.y,
      start: { ...cropRect01 },
    };
    previewCanvas.setPointerCapture?.(evt.pointerId);
    updateCropCursor(mode);
    evt.preventDefault();
  });

  listen(previewCanvas, 'pointermove', (evt) => {
    if (!previewEnabledCheckbox.checked || !cropEnabled) return;
    if (previewFramingMode !== 'edit') return;
    if (
      cropDrag !== null &&
      evt.pointerId !== cropDrag.pointerId
    ) {
      return;
    }
    if (
      cropDrag === null &&
      evt.pointerType !== 'mouse'
    ) {
      return;
    }
    if (!previewGeom?.viewportRect) return;
    if (
      !previewSampleFull?.reduced ||
      !isPreviewSampleCurrent(previewSampleFull)
    ) {
      if (previewSampleFull) invalidatePreviewSamples();
      return;
    }

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
    previewSampleCrop = null;
    syncCropUi();
    schedulePreviewDraw();
    evt.preventDefault();
  });

  function endCropDrag(event = null) {
    const owner = cropDrag;
    if (
      owner !== null &&
      event !== null &&
      event.pointerId !== owner.pointerId
    ) {
      return;
    }
    const pointerId = owner?.pointerId;
    cropDrag = null;
    if (
      Number.isInteger(pointerId) &&
      previewCanvas.hasPointerCapture?.(pointerId)
    ) {
      previewCanvas.releasePointerCapture?.(pointerId);
    }
    updateCropCursor(null);
  }

  listen(previewCanvas, 'pointerup', endCropDrag);
  listen(previewCanvas, 'pointercancel', endCropDrag);
  listen(previewCanvas, 'lostpointercapture', endCropDrag);
  listen(previewCanvas, 'dblclick', () => {
    if (!cropEnabled) return;
    previewFramingMode = 'edit';
    previewSampleCrop = null;
    resetCropToDefault();
    syncCropUi();
    schedulePreviewDraw();
  });
  listen(previewCanvas, 'keydown', (evt) => {
    if (
      !previewEnabledCheckbox.checked ||
      !cropEnabled ||
      previewFramingMode !== 'edit'
    ) {
      return;
    }
    const isArrow =
      evt.key === 'ArrowLeft' ||
      evt.key === 'ArrowRight' ||
      evt.key === 'ArrowUp' ||
      evt.key === 'ArrowDown';
    if (evt.key !== 'Home' && !isArrow) return;

    if (evt.key === 'Home') {
      previewSampleCrop = null;
      resetCropToDefault();
    } else if (evt.shiftKey) {
      if (!resizeCropFromKeyboard(evt.key, 0.02)) return;
      previewSampleCrop = null;
    } else {
      const moveStep = evt.ctrlKey || evt.metaKey ? 0.05 : 0.01;
      const dx =
        evt.key === 'ArrowLeft'
          ? -moveStep
          : (evt.key === 'ArrowRight' ? moveStep : 0);
      const dy =
        evt.key === 'ArrowUp'
          ? -moveStep
          : (evt.key === 'ArrowDown' ? moveStep : 0);
      cropRect01 = {
        x: clamp(cropRect01.x + dx, 0, 1 - cropRect01.width),
        y: clamp(cropRect01.y + dy, 0, 1 - cropRect01.height),
        width: cropRect01.width,
        height: cropRect01.height,
      };
      previewSampleCrop = null;
    }
    syncCropUi();
    schedulePreviewDraw();
    evt.preventDefault();
  });

  /**
   * The words of the last control that refused its value while reading the
   * form (`refuseControl`): what an agent's export or picture is told, never
   * another control that happens to be invalid.
   */
  let refusedBecause = null;

  /** A control refuses its value: said on it, kept for the caller's refusal; null. */
  function refuseControl(input, message) {
    input.setCustomValidity(message);
    input.reportValidity();
    refusedBecause = message;
    return null;
  }

  function readExactIntegerInput(input, label, minimum, maximum = Number.MAX_SAFE_INTEGER) {
    const raw = input.value;
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
      return refuseControl(input, `${label} must be a whole number.`);
    }
    const value = Number(raw);
    if (
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      return refuseControl(input, `${label} must be between ${minimum} and ${maximum}.`);
    }
    input.setCustomValidity('');
    return value;
  }

  function readExactDecimalInput(input, label, minimum, maximum) {
    // A decimal box: a point or a comma (`readDecimalInput`).
    const value = readDecimalInput(input);
    if (Number.isNaN(value)) {
      return refuseControl(input, `${label} must be a decimal number.`);
    }
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      return refuseControl(input, maximum === Infinity
        ? `${label} must be at least ${minimum}.`
        : `${label} must be between ${minimum} and ${maximum}.`);
    }
    input.setCustomValidity('');
    return value;
  }

  listen(exportBtn, 'click', () => {
    void handleFigureExportClick();
  });

  async function handleFigureExportClick() {
    if (cleanupComplete) return;
    if (exportInFlight) {
      // The person stops the export where it is: its reads, its worker
      // requests still queued and its passes end, and nothing is reported.
      cancel(activeExportAbortController, 'user', 'Figure export was canceled.');
      return;
    }
    await runFigureExport({ forAction: false });
  }

  /**
   * One export, as the Download button makes it, or for `figure.export`
   * (`forAction`): the button turns into its Cancel while it runs. The
   * button's export asks the person about anything the figure cannot
   * reproduce; the action's is refused with the same words (an agent cannot
   * answer the person's dialog), and a setting the form refuses is said in
   * the refusal. `signal`: the action's own stop.
   */
  async function runFigureExport({ forAction, signal = null }) {
    exportInFlight = true;
    const abortController = new AbortController();
    activeExportAbortController = abortController;
    const stopWithCaller = signal === null ? () => {} : onAbort(signal, () => cancel(abortController, 'user', 'Figure export was canceled.'));
    const { promise: exportEnd, resolve: ended } = promiseWithResolvers();
    exportEnded = exportEnd;
    setBusy(true);
    try {
      const written = await exportFigureFromUi(abortController.signal, { forAction });
      if (forAction && written === null) throw invalidSettingsRefusal('figure.export');
      return written;
    } catch (error) {
      if (forAction) throw error;
      if (!abortController.signal.aborted) {
        // Engine failures are already marked; UI/request failures enter the
        // same reporter here. Either path produces one visible notification.
        reportFigureExportFailure(error);
      }
      return null;
    } finally {
      stopWithCaller();
      cancel(abortController, 'closed', 'The figure export ended.');
      if (activeExportAbortController === abortController) {
        activeExportAbortController = null;
      }
      exportInFlight = false;
      if (!cleanupComplete) setBusy(false);
      ended();
    }
  }

  /** A control refused its value: the agent hears the control's words. */
  function invalidSettingsRefusal(type) {
    return new ActionRefused(
      `The figure export settings are not valid${refusedBecause === null ? '' : `: ${refusedBecause.replace(/\.$/, '')}`}; figure_export_set changes them.`,
      { code: 'bad-value', type },
    );
  }

  /**
   * The figure Export would download now, as a PNG at 96 dpi (one figure
   * pixel per CSS pixel), returned instead of written: the panel's settings
   * (size, frame, background, fonts, title, legends, every view as panels
   * while Export all views is on), whatever Download's format. `notes`: what
   * the figure cannot reproduce of what the view shows (the person's dialog
   * before a download). An agent previewing its figure sees what the person
   * will get (`view.picture` source "export").
   *
   * @param {{signal: AbortSignal}} how The caller's Stop
   * @returns {Promise<{blob: Blob, notes: string[], plot: {width: number, height: number}|null}>}
   *   `plot`: the one view's plot in the figure, null for a figure of every view
   */
  async function renderExportPicture({ signal }) {
    refusedBecause = null;
    const request = readFigureRequest();
    if (request === null) throw invalidSettingsRefusal('view.picture');
    const notes = figureFidelityWarnings({ shaderAccurate: true }).map(warning => `${warning.title}: ${warning.detail}`);
    const { blob, plot, legendMovedBelow } = await engine.renderFigure({
      ...request,
      strategy: null,
      optimizedTargetCount: null,
      signal,
      format: 'png',
      dpi: 96,
    });
    // The width asked, in figure pixels (the picture is the figure at 96 dpi, one pixel each), and the DPI a PNG download takes.
    return {
      blob, notes, plot, legendMovedBelow,
      asked: { width: request.width },
      dpi: Number(dpiSelect.value),
      colorblindMode: previewEnabledCheckbox.checked ? (previewModeSelect.value || 'none') : 'none',
    };
  }

  // An agent's, a notebook's or a replay's export (`figure.export`): the Download button's, with the settings as they are.
  cleanupFns.push(getActions().provide('figure.export', async (params, { signal }) => {
    if (exportInFlight) {
      throw new ActionRefused('A figure export is running already; wait for it to finish.', { code: 'busy', type: 'figure.export' });
    }
    return runFigureExport({ forAction: true, signal });
  }));

  /**
   * The Figure export panel's settings as a figure request, without what
   * Download adds (format, dpi, SVG strategy): what Export would draw. Null
   * when a control refused its value (said on the control).
   */
  function readFigureRequest() {
    const widthMm = readExactDecimalInput(widthInput, 'Figure width (mm)', FIGURE_EXPORT_SETTING_RANGES.widthMm[0], Infinity);
    if (widthMm === null) return null;
    // The figure fills its width (`height: null`), in figure pixels (1/96 inch).
    const width = figureWidthPxOf(widthMm);
    const height = null;
    // Text in points, drawn at its printed size: points as figure pixels.
    const textSize = (input, label) => {
      const pt = readExactDecimalInput(input, `${label} (pt)`, ...FIGURE_EXPORT_SETTING_RANGES.fontSize);
      if (pt === null) return null;
      if (!Number.isInteger(pt * 2)) return refuseControl(input, `${label} is set in whole or half points.`);
      return figurePxOfPt(pt);
    };
    const baseFontSizePx = textSize(fontSizeInput, 'Base text size');
    if (baseFontSizePx === null) return null;
    const legendFontSizePx = textSize(legendFontSizeInput, 'Legend text size');
    if (legendFontSizePx === null) return null;
    const tickFontSizePx = textSize(tickFontSizeInput, 'Tick label size');
    if (tickFontSizePx === null) return null;
    const axisLabelFontSizePx = textSize(axisLabelFontSizeInput, 'Axis label size');
    if (axisLabelFontSizePx === null) return null;
    const titleFontSizePx = textSize(titleFontSizeInput, 'Title size');
    if (titleFontSizePx === null) return null;
    const centroidLabelFontSizePx = textSize(centroidLabelFontSizeInput, 'Centroid label size');
    if (centroidLabelFontSizePx === null) return null;
    const selectionMutedOpacity = readExactDecimalInput(
      selectionMutedOpacityInput,
      'Muted selection opacity',
      0,
      1
    );
    if (selectionMutedOpacity === null) return null;
    if (!['right', 'bottom'].includes(legendPosSelect.value)) {
      throw new TypeError('Figure export legend position is not a current UI value.');
    }
    if (!['viewer', 'white', 'transparent', 'custom'].includes(backgroundSelect.value)) {
      throw new TypeError('Figure export background is not a current UI value.');
    }
    if (!isHexColor(backgroundColorInput.value)) {
      return refuseControl(backgroundColorInput, 'Background color must be #RRGGBB.');
    }
    backgroundColorInput.setCustomValidity('');
    if (fontSelect.value.trim().length === 0) {
      throw new TypeError('Figure export font family must be non-empty.');
    }

    return {
      width,
      height,
      exportAllViews: exportAllViewsCheckbox.checked,
      title: titleInput.value,
      includeAxes: includeAxesCheckbox.checked,
      includeLegend: includeLegendCheckbox.checked,
      legendPosition: legendPosSelect.value,
      xLabel: xLabelInput.value,
      yLabel: yLabelInput.value,
      background: backgroundSelect.value,
      backgroundColor: backgroundColorInput.value,
      fontFamily: fontSelect.value,
      fontSizePx: baseFontSizePx,
      legendFontSizePx,
      tickFontSizePx,
      axisLabelFontSizePx,
      titleFontSizePx,
      centroidLabelFontSizePx,
      crop: getCropOptionForExport(),
      referenceGrid: resolveExportReferenceGrid(),
      // No point radius is passed: the export draws the viewer's pointSize (WYSIWYG).
      showOrientation: showOrientationCheckbox.checked,
      depthSort3d: depthSortCheckbox.checked,
      emphasizeSelection: emphasizeSelectionCheckbox.checked,
      selectionMutedOpacity,
    };
  }

  /**
   * What the figure cannot reproduce of what the view shows (a render mode,
   * an unreadable background, an overlay; with `shaderAccurate`, a PNG's or a
   * hybrid SVG's exact points without WebGL2): the person's dialog before a
   * download, the agent's refusal, a picture's notes.
   */
  function figureFidelityWarnings({ shaderAccurate }) {
    const activeViewId = getActiveViewIdForPreview();

    /** @type {{ title: string; detail: string }[]} */
    const warnings = [];

    // The render mode decides the entire draw pass, so it gates every format:
    // a volumetric view exported as a point cloud is a different image, not a
    // degraded one.
    warnings.push(
      ...buildRenderModeFidelityWarnings(
        typeof document === 'undefined' ? null : document
      )
    );

    // The background decides the viewer's reference grid. An unreadable
    // background means the figure cannot know whether to draw one.
    warnings.push(
      ...buildViewerBackgroundFidelityWarnings(
        typeof document === 'undefined' ? null : document
      )
    );

    if (shaderAccurate) {
      const rs = getPreviewRenderStateForView(activeViewId);
      const missing = [];
      if (!hasUsableWebgl2Context()) missing.push('WebGL2');
      if (!rs?.viewMatrix || !rs?.projectionMatrix || !rs?.modelMatrix) missing.push('camera matrices');
      if (missing.length) {
        warnings.push({
          title: 'Exact point export unavailable',
          detail: `Exact point export requires ${missing.join(' and ')}. Restore that capability before exporting.`
        });
      }
    }

    // Data overlays the export cannot draw: exporting past one would publish a
    // figure that silently omits measurements the active view shows.
    warnings.push(
      ...buildOverlayFidelityWarnings({
        documentRef: typeof document === 'undefined' ? null : document,
        connectivityVisible:
          viewer.getShowConnectivity() && viewer.hasConnectivityData(),
      })
    );
    return warnings;
  }

  /**
   * Read the form and export: resolves to the files written, or to null
   * when the form refused a value (said on its control) or the person
   * declined what the figure cannot reproduce.
   */
  async function exportFigureFromUi(signal, { forAction = false } = {}) {
    refusedBecause = null;
    const request = readFigureRequest();
    if (request === null) return null;

    const mode = downloadSelect.value;
    if (!['svg', 'png', 'svg+png', 'png-multi', 'all'].includes(mode)) {
      throw new TypeError('Figure export download mode is not a current UI value.');
    }
    const needsSvg = mode === 'svg' || mode === 'svg+png' || mode === 'all';
    const needsPng = mode === 'png' || mode === 'svg+png' || mode === 'png-multi' || mode === 'all';
    const multiPng = mode === 'png-multi' || mode === 'all';
    const dpi = needsPng && !multiPng
      ? readExactIntegerInput(dpiSelect, 'DPI', 72, 1200)
      : null;
    if (needsPng && !multiPng && dpi === null) return null;

    const strategy = needsSvg ? strategySelect.value : null;
    const optimizedTargetCount = strategy === 'optimized-vector'
      ? readExactIntegerInput(
          optimizedTargetCountInput,
          'Optimized vector target',
          1000,
          5_000_000
        )
      : null;
    if (strategy === 'optimized-vector' && optimizedTargetCount === null) return null;

    const warnings = figureFidelityWarnings({ shaderAccurate: needsPng || (needsSvg && strategy === 'hybrid') });

    if (forAction && warnings.length > 0) {
      // The person's dialog would block it: the agent hears the same words.
      throw new ActionRefused(
        `The figure cannot reproduce what the view shows: ${warnings.map(warning => `${warning.title}: ${warning.detail}`).join(' ')}`,
        { code: 'unavailable', type: 'figure.export' },
      );
    }
    const proceed = await confirmExportFidelityWarnings({
      warnings,
      signal,
    });
    if (!proceed) return null;

    const baseOptions = { ...request, strategy, optimizedTargetCount };

    /** @type {{ format: 'svg'|'png'; dpi: number|null }[]} */
    const jobs = [];
    if (needsSvg) jobs.push({ format: 'svg', dpi: null });
    if (needsPng) {
      if (multiPng) jobs.push(...[150, 300, 600].map((d) => ({ format: 'png', dpi: d })));
      else jobs.push({ format: 'png', dpi });
    }

    const results = jobs.length === 1
      ? [await engine.exportFigure({
        ...baseOptions,
        signal,
        format: jobs[0].format,
        dpi: jobs[0].dpi,
      })]
      : await engine.exportFigures({
        ...baseOptions,
        signal,
        jobs
      });
    return {
      files: results.map((written, index) => ({ format: written.format, file: written.filename, dpi: jobs[index].dpi })),
      zip: results.length > 1,
    };
  }

  // The four sections are one exclusive disclosure list: opening one closes
  // the others, so the panel never grows taller than one section.
  const subAccordion = createElement('div', { className: 'disclosure-list figure-export-accordion' });
  const sections = [
    {
      title: 'Framing',
      tip: 'export-framing',
      content: [plotAndFrameRow, previewRow]
    },
    {
      title: 'Labels and annotations',
      tip: 'export-labels',
      content: [titleRow, annotationSection, selectionRow]
    },
    {
      title: 'Style',
      tip: 'export-style',
      content: [styleSection]
    },
    {
      title: 'Download',
      tip: 'export-download',
      content: [advancedSection]
    }
  ];
  const disclosures = sections.map(section => {
    const disclosure = createDisclosure({
      title: section.title,
      tip: section.tip,
      onToggle: expanded => {
        if (!expanded || cleanupComplete) return;
        for (const other of disclosures) {
          if (other !== disclosure) other.setExpanded(false);
        }
      }
    });
    for (const node of section.content) disclosure.content.appendChild(node);
    subAccordion.appendChild(disclosure.root);
    return disclosure;
  });

  container.appendChild(header);
  container.appendChild(subAccordion);
  container.appendChild(actionsRow);

  previewRebuildGate = createVisibilityGatedRender(previewCanvas, startPreviewRebuild);
  cleanupFns.push(() => previewRebuildGate.destroy());

  syncFormatDependentUi();
  syncCropUi();
  syncSizeReadout();

  // A session may be saved while a number box holds a half-typed value; it
  // records each box's last valid value instead (`trackCommittedNumber`).
  const committedNumber = (input, label, range, integer = true) =>
    trackCommittedNumber(input, { label, range, integer, signal: domLifecycle.signal });
  // The width (millimetres) and the text sizes (points) are decimal boxes.
  const committedNumbers = {
    width: committedNumber(widthInput, 'width (mm)', FIGURE_EXPORT_SETTING_RANGES.widthMm, false),
    base: committedNumber(fontSizeInput, 'base text size (pt)', FIGURE_EXPORT_SETTING_RANGES.fontSize, false),
    legend: committedNumber(legendFontSizeInput, 'legend text size (pt)', FIGURE_EXPORT_SETTING_RANGES.fontSize, false),
    ticks: committedNumber(tickFontSizeInput, 'tick label size (pt)', FIGURE_EXPORT_SETTING_RANGES.fontSize, false),
    axisLabel: committedNumber(axisLabelFontSizeInput, 'axis label size (pt)', FIGURE_EXPORT_SETTING_RANGES.fontSize, false),
    title: committedNumber(titleFontSizeInput, 'title size (pt)', FIGURE_EXPORT_SETTING_RANGES.fontSize, false),
    centroidLabel: committedNumber(centroidLabelFontSizeInput, 'centroid label size (pt)', FIGURE_EXPORT_SETTING_RANGES.fontSize, false),
    selectionMutedOpacity: committedNumber(
      selectionMutedOpacityInput,
      'non-selected opacity',
      FIGURE_EXPORT_SETTING_RANGES.selectionMutedOpacity,
      false
    ),
    optimizedTargetCount: committedNumber(
      optimizedTargetCountInput,
      'optimized vector target',
      FIGURE_EXPORT_SETTING_RANGES.optimizedTargetCount
    ),
  };

  /**
   * Every figure-export setting as one plain JSON object
   * (`utils/session-settings.js`).
   *
   * @returns {import('./utils/session-settings.js').FigureExportSessionSettings}
   */
  function exportSessionSettings() {
    const settings = {
      version: FIGURE_EXPORT_SESSION_SETTINGS_VERSION,
      sizePreset: presetSelect.value,
      width: committedNumbers.width.read(),
      frame: cropEnabled
        ? {
          lockAspect: cropLockCheckbox.checked,
          rect: {
            x: cropRect01.x,
            y: cropRect01.y,
            width: cropRect01.width,
            height: cropRect01.height,
          },
        }
        : null,
      background: backgroundSelect.value,
      backgroundColor: backgroundColorInput.value.toLowerCase(),
      fontFamily: fontSelect.value,
      autoTextSize: autoTextSizingCheckbox.checked,
      fontSizes: autoTextSizingCheckbox.checked
        ? null
        : {
          base: committedNumbers.base.read(),
          legend: committedNumbers.legend.read(),
          ticks: committedNumbers.ticks.read(),
          axisLabel: committedNumbers.axisLabel.read(),
          title: committedNumbers.title.read(),
          centroidLabel: committedNumbers.centroidLabel.read(),
        },
      titleFollowsDataset: titleAutofillEnabled,
      title: titleAutofillEnabled ? null : titleInput.value,
      xLabel: xLabelInput.value,
      yLabel: yLabelInput.value,
      includeAxes: includeAxesCheckbox.checked,
      includeLegend: includeLegendCheckbox.checked,
      referenceGrid: referenceGridCheckbox.checked,
      showOrientation: showOrientationCheckbox.checked,
      depthSort: depthSortCheckbox.checked,
      legendPosition: legendPosSelect.value,
      emphasizeSelection: emphasizeSelectionCheckbox.checked,
      selectionMutedOpacity: committedNumbers.selectionMutedOpacity.read(),
      preview: {
        enabled: previewEnabledCheckbox.checked,
        colorblindMode: previewModeSelect.value,
      },
      download: downloadSelect.value,
      dpi: Number(dpiSelect.value),
      svgStrategy: strategySelect.value,
      optimizedTargetCount: committedNumbers.optimizedTargetCount.read(),
      exportAllViews: exportAllViewsCheckbox.checked,
    };
    return assertFigureExportSessionSettings(settings);
  }

  /**
   * Apply a session's figure-export settings to every control. The object is
   * validated whole first, so an invalid one changes nothing.
   *
   * @param {unknown} settings
   */
  function importSessionSettings(settings) {
    if (cleanupComplete) {
      throw new Error('Figure export settings cannot be applied after teardown.');
    }
    const exact = assertFigureExportSessionSettings(settings);

    presetSelect.value = exact.sizePreset;
    writeDecimalInput(widthInput, exact.width);
    lastPreviewFigure = null;

    backgroundSelect.value = exact.background;
    backgroundColorInput.value = exact.backgroundColor;
    fontSelect.value = exact.fontFamily;
    autoTextSizingCheckbox.checked = exact.autoTextSize;
    if (!exact.autoTextSize) {
      writeDecimalInput(fontSizeInput, exact.fontSizes.base);
      writeDecimalInput(legendFontSizeInput, exact.fontSizes.legend);
      writeDecimalInput(tickFontSizeInput, exact.fontSizes.ticks);
      writeDecimalInput(axisLabelFontSizeInput, exact.fontSizes.axisLabel);
      writeDecimalInput(titleFontSizeInput, exact.fontSizes.title);
      writeDecimalInput(centroidLabelFontSizeInput, exact.fontSizes.centroidLabel);
    }

    xLabelInput.value = exact.xLabel;
    yLabelInput.value = exact.yLabel;
    includeAxesCheckbox.checked = exact.includeAxes;
    includeLegendCheckbox.checked = exact.includeLegend;
    referenceGridCheckbox.checked = exact.referenceGrid;
    showOrientationCheckbox.checked = exact.showOrientation;
    depthSortCheckbox.checked = exact.depthSort;
    legendPosSelect.value = exact.legendPosition;
    emphasizeSelectionCheckbox.checked = exact.emphasizeSelection;
    writeDecimalInput(selectionMutedOpacityInput, exact.selectionMutedOpacity);

    downloadSelect.value = exact.download;
    dpiSelect.value = String(exact.dpi);
    strategySelect.value = exact.svgStrategy;
    optimizedTargetCountInput.value = String(exact.optimizedTargetCount);
    exportAllViewsCheckbox.checked = exact.exportAllViews;

    previewModeSelect.value = exact.preview.colorblindMode;
    previewEnabledCheckbox.checked = exact.preview.enabled;
    previewFramingMode = 'edit';
    previewSampleCrop = null;
    cropEnabled = exact.frame !== null;
    cropEnabledCheckbox.checked = cropEnabled;
    cropLockCheckbox.checked = exact.frame?.lockAspect ?? false;
    lockAspectBtn.setAttribute('aria-pressed', cropLockCheckbox.checked ? 'true' : 'false');
    cropRect01 = exact.frame === null
      ? { x: 0, y: 0, width: 1, height: 1 }
      : { ...exact.frame.rect };
    lockedFrameAspect = cropEnabled && cropLockCheckbox.checked ? frameAspectNow() : null;

    if (exact.titleFollowsDataset) {
      titleAutofillEnabled = true;
      lastAutoTitle = '';
      titleInput.value = '';
      syncAutoTitle();
    } else {
      titleAutofillEnabled = false;
      titleInput.value = exact.title;
    }

    syncAnnotationUi();
    syncTextSizingUi();
    for (const tracked of Object.values(committedNumbers)) tracked.commit();
    syncFormatDependentUi();
    syncCropUi();
    syncSizeReadout();
    invalidatePreviewSamples({ rebuild: false });
    if (exact.preview.enabled) {
      // The preview toggle's own path builds the sample the settings show.
      previewEnabledCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      clearPreview();
    }
    observedSettings = settingsNow();
  }

  // ---------------------------------------------------------------------------
  // The settings as steps: `figure-export.set` (app/actions/definitions/settings.js)
  // ---------------------------------------------------------------------------

  /** The settings now, or null while a box holds a value never valid. */
  function settingsNow() {
    try {
      return exportSessionSettings();
    } catch {
      return null;
    }
  }

  /** The text sizes the panel shows (derived while Auto text is on). */
  function shownFontSizes() {
    return Object.fromEntries(['base', 'legend', 'ticks', 'axisLabel', 'title', 'centroidLabel']
      .map(key => [key, committedNumbers[key].read()]));
  }

  /** A refusal in the step's own words: the parameters' names, not the record's. */
  function refusalOf(error) {
    const message = String(error?.message ?? error)
      .replace(/^Figure-export session settings\.?/, '')
      .replace(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g, word => Object.keys(figureExportParamsOf({ [word]: null }))[0]);
    return new ActionRefused(`These figure export settings do not go together: ${message.trim()}`, { code: 'bad-value', type: 'figure-export.set' });
  }

  // An agent's, a notebook's or a replay's step: the settings it names, the
  // rest as they are, applied whole through the session path.
  cleanupFns.push(getActions().provide('figure-export.set', params => {
    const current = exportSessionSettings();
    const given = figureExportSettingsOf(params);
    if (given.frame === FIGURE_EXPORT_FRAME_CELLS) {
      // Fit the cells: the frame every cell the figure draws fills, as the
      // panel's button sets it; a frame is drawn on the preview, so it is on.
      const rect = engine.cellsFrame({ exportAllViews: given.exportAllViews ?? current.exportAllViews });
      if (rect === null) {
        throw new ActionRefused('No cell is drawn in the figure\'s views, so there is nothing to fit the frame to.', { code: 'unavailable', type: 'figure-export.set' });
      }
      given.frame = { lockAspect: false, rect };
      if (!Object.hasOwn(given, 'preview')) given.preview = { ...current.preview, enabled: true };
    }
    const next = { ...current, ...given };
    // A width and its preset go together: a preset sets its width, a width
    // given alone is its preset's when it is one, else custom.
    if (Object.hasOwn(given, 'sizePreset') && !Object.hasOwn(given, 'width') && Object.hasOwn(FIGURE_WIDTH_PRESETS, given.sizePreset)) {
      next.width = FIGURE_WIDTH_PRESETS[given.sizePreset];
    }
    if (Object.hasOwn(given, 'width') && !Object.hasOwn(given, 'sizePreset')) {
      next.sizePreset = Object.keys(FIGURE_WIDTH_PRESETS).find(key => FIGURE_WIDTH_PRESETS[key] === given.width) ?? 'custom';
    }
    // A value the panel derives becomes the person's when its switch is turned off,
    // and is derived again when it is turned back on.
    if (Object.hasOwn(given, 'autoTextSize') && !Object.hasOwn(given, 'fontSizes')) {
      next.fontSizes = given.autoTextSize ? null : (current.fontSizes ?? shownFontSizes());
    }
    if (Object.hasOwn(given, 'titleFollowsDataset') && !Object.hasOwn(given, 'title')) {
      next.title = given.titleFollowsDataset ? null : (current.title ?? titleInput.value);
    }
    let exact;
    try {
      exact = assertFigureExportSessionSettings(next);
    } catch (error) {
      throw refusalOf(error);
    }
    const changed = changedFigureExportSettings(current, exact);
    if (params.frame === FIGURE_EXPORT_FRAME_CELLS) cellsFrameRect = { ...given.frame.rect };
    if (Object.keys(changed).length === 0) return null;
    importSessionSettings(exact);
    return { changed: Object.keys(changed).length };
  }));

  // The settings as an agent, a notebook or a script reads them back, by the
  // names `figure-export.set` takes, so an agent can check what it set after the
  // history or a session put the settings back.
  cleanupFns.push(getActions().provide('figure-export.get', () => {
    let settings;
    try {
      settings = exportSessionSettings();
    } catch (error) {
      throw new ActionRefused(
        `A figure export setting holds a value it cannot use, so the settings cannot be read now: ${String(error?.message ?? error)}`,
        { code: 'bad-value', type: 'figure-export.get' }
      );
    }
    // The record's format version is no setting.
    const named = { ...settings };
    delete named.version;
    return figureExportParamsOf(named);
  }));

  // What the person's changes are compared with: the settings last recorded
  // or put back (`importSessionSettings`).
  let observedSettings = settingsNow();

  /**
   * A person's change of a setting, made by its control's own handler, is
   * recorded as one `figure-export.set` step by observation, from the event
   * that made it, as the sidebar's settings are (`settings-actions.js`).
   * This panel's controls are not in the generic control inventory: its
   * settings are one record, with a frame drawn on the preview and a title
   * that follows the dataset. Any control that changes the record, one added
   * later included, is recorded here with no code of its own. The events a
   * history restore or the action itself causes are not steps: the history
   * compares with what it shows.
   */
  function observeSettings() {
    const now = settingsNow();
    const before = observedSettings;
    observedSettings = now;
    if (now === null || before === null) return;
    const changed = changedFigureExportSettings(before, now);
    if (Object.keys(changed).length === 0) return;
    try {
      getActions()
        .recordObserved('figure-export.set', figureExportParamsOf(changed))
        .catch(error => console.error('[FigureExport] A setting could not be recorded.', error));
    } catch (error) {
      console.error('[FigureExport] A setting could not be recorded.', error);
    }
  }
  for (const type of ['input', 'change', 'click', 'pointerup', 'keyup']) listen(container, type, observeSettings);

  return { setCellsPresent, destroy, exportSessionSettings, importSessionSettings, renderExportPicture };
}
