/**
 * @fileoverview Figure export UI (accordion panel).
 *
 * Builds a compact control panel for publication-grade exports without adding
 * any work to the normal render loop.
 *
 * @module ui/modules/figure-export/figure-export-ui
 */

import { createElement, clearElement } from '../../../utils/dom-utils.js';
import { clamp, parseFiniteNumberInRange } from '../../../utils/number-utils.js';
import { confirmExportFidelityWarnings } from './components/fidelity-warning-dialog.js';
import { reportFigureExportFailure } from './figure-export-engine.js';
import { computeSingleViewLayout } from './utils/layout.js';
import { buildRenderModeFidelityWarnings } from './utils/render-mode.js';
import { reducePointsByDensity } from './utils/density-reducer.js';
import {
  matchesLodMembershipPresentation,
  MIN_VISIBLE_ALPHA_BYTE,
  POINT_VISIBILITY_THRESHOLD,
} from './utils/lod-membership.js';
import { drawCanvasLegend } from './components/legend-builder.js';
import { drawCanvasAxes } from './components/axes-builder.js';
import { drawCanvasCentroidOverlay } from './components/centroid-overlay.js';
import { denormalizeXY } from './utils/coordinate-mapper.js';
import { drawCanvasOrientationIndicator } from './components/orientation-indicator.js';
import {
  buildReferenceGridModel,
  drawCanvasReferenceGrid,
  resolveReferenceGridSurfaceRgb,
} from './components/reference-grid.js';
import { applyColorblindSimulationToImageData } from './utils/colorblindness.js';
import { assertCropRect01 } from './utils/crop.js';
import { rgb01ToHex } from './utils/color-utils.js';
import { resolveFigureInk } from './utils/figure-ink.js';
import {
  buildViewerBackgroundFidelityWarnings,
  readActiveReferenceGridAppearance,
  VIEWER_BACKGROUND_LABELS,
} from './utils/viewer-background.js';
import {
  buildOverlayFidelityWarnings,
  NON_EXPORTED_VIEWER_CHROME,
} from './utils/overlay-fidelity.js';
import {
  assertCameraState,
  assertNavigationMode
} from '../../../../rendering/camera-state-contract.js';

const DEFAULT_SIZE = { width: 1600, height: 1200 };
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
 * @param {{ exportFigure: (opts: any) => Promise<any> }} options.engine
 */
export function initFigureExportUI({ state, viewer, container, engine }) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('Figure export container must be an HTMLElement.');
  }
  if (
    engine === null ||
    typeof engine !== 'object' ||
    typeof engine.exportFigure !== 'function' ||
    typeof engine.exportFigures !== 'function'
  ) {
    throw new TypeError(
      'Figure export engine must publish exportFigure() and exportFigures().'
    );
  }
  if (
    viewer === null ||
    typeof viewer !== 'object' ||
    typeof viewer.withBorrowedViewData !== 'function' ||
    typeof viewer.getPresentedViewState !== 'function' ||
    typeof viewer.onPresentedViewStateChanged !== 'function'
  ) {
    throw new TypeError(
      'Figure export viewer must publish withBorrowedViewData(), getPresentedViewState(), and onPresentedViewStateChanged().'
    );
  }
  // Session bundles must NOT persist Figure Export UI state. Mark the entire
  // subtree as opt-out so generic UI control snapshotting ignores it.
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
    activeExportAbortController?.abort();
    activeExportAbortController = null;
    exportInFlight = false;
  });
  const destroy = () => {
    if (cleanupComplete) return;
    cleanupComplete = true;
    container.__cellucidCleanup = () => {};
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
  };
  container.__cellucidCleanup = destroy;

  const presets = [
    { label: 'Screen (half)', value: 'screen-half' },
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
  sizeRow.appendChild(createElement('label', {}, ['Plot size:']));

  const presetSelect = createElement('select', { className: 'obs-select', ariaLabel: 'Export size preset' });
  presets.forEach((p) => {
    presetSelect.appendChild(createElement('option', { value: p.value }, [p.label]));
  });
  presetSelect.value = 'screen-half';

  const widthInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: String(DEFAULT_SIZE.width),
    min: '100',
    max: '20000',
    step: '10',
    inputMode: 'numeric',
    ariaLabel: 'Export width (px)'
  });
  const heightInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: String(DEFAULT_SIZE.height),
    min: '100',
    max: '20000',
    step: '10',
    inputMode: 'numeric',
    ariaLabel: 'Export height (px)'
  });

  const sizeGrid = createElement('div', { className: 'figure-export-size-row' }, [
    presetSelect,
    createElement('div', { className: 'figure-export-dimensions' }, [
      createElement('div', { className: 'figure-export-dim-field' }, [
        createElement('span', { className: 'figure-export-label' }, ['W']),
        widthInput,
      ]),
      createElement('div', { className: 'figure-export-dim-field' }, [
        createElement('span', { className: 'figure-export-label' }, ['H']),
        heightInput,
      ]),
    ])
  ]);
  sizeRow.appendChild(sizeGrid);

  const cropEnabledCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-crop-enabled' });
  const cropLockCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-crop-lock' });
  const cropResetBtn = createElement('button', { type: 'button', className: 'toggle-switch figure-export-framing-btn' }, ['Reset']);
  const cropConfirmBtn = createElement('button', { type: 'button', className: 'toggle-switch figure-export-framing-btn', ariaPressed: 'false' }, ['Confirm']);
  const cropFitPlotBtn = createElement('button', { type: 'button', className: 'toggle-switch figure-export-framing-btn' }, ['Fit plot']);
  const cropAspectHint = createElement('span', { className: 'figure-export-crop-aspect' }, ['Aspect: —']);

  const frameExportToggleLabel = createElement('label', { className: 'checkbox-inline', htmlFor: cropEnabledCheckbox.id }, [
    cropEnabledCheckbox,
    ' Frame export'
  ]);
  const lockAspectBtn = createElement('button', {
    type: 'button',
    className: 'toggle-switch figure-export-framing-btn',
    ariaPressed: 'false',
  }, ['Lock aspect']);
  const framingActionGrid = createElement('div', { className: 'figure-export-framing-grid' }, [
    cropResetBtn,
    cropConfirmBtn,
    cropFitPlotBtn,
    lockAspectBtn,
  ]);

  const plotAndFrameRow = createElement('div', { className: 'figure-export-plot-frame' }, [
    sizeRow
  ]);

  // ─────────────────────────────────────────────────────────────────────────
  // Style section
  // ─────────────────────────────────────────────────────────────────────────
  const styleSection = createElement('div', { className: 'control-block' });
  styleSection.appendChild(createElement('label', {}, ['Style:']));
  styleSection.appendChild(createElement('div', { className: 'figure-export-hint' }, [
    'Background color and font settings.'
  ]));

  const backgroundSelect = createElement('select', { className: 'obs-select', ariaLabel: 'Background' });
  backgroundSelect.appendChild(createElement('option', { value: 'viewer' }, ['Match viewer']));
  backgroundSelect.appendChild(createElement('option', { value: 'white' }, ['White BG']));
  backgroundSelect.appendChild(createElement('option', { value: 'transparent' }, ['Transparent']));
  backgroundSelect.appendChild(createElement('option', { value: 'custom' }, ['Custom…']));
  const initialViewerBg = rgb01ToHex(viewer.getRenderState().bgColor);
  const backgroundColorInput = createElement('input', { type: 'color', className: 'figure-color-picker', value: initialViewerBg || '#ffffff', ariaLabel: 'Custom background color' });
  backgroundSelect.value = 'viewer';

  const fontSelect = createElement('select', { className: 'obs-select', ariaLabel: 'Font family' });
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
    ariaLabel: 'Base font size (px)'
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
    ariaLabel: 'Legend font size (px)'
  });
  const tickFontSizeInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: '12',
    min: '6',
    max: '24',
    step: '1',
    inputMode: 'numeric',
    ariaLabel: 'Tick font size (px)'
  });
  const axisLabelFontSizeInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: '12',
    min: '6',
    max: '36',
    step: '1',
    inputMode: 'numeric',
    ariaLabel: 'Axis label font size (px)'
  });
  const titleFontSizeInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: '15',
    min: '8',
    max: '48',
    step: '1',
    inputMode: 'numeric',
    ariaLabel: 'Title font size (px)'
  });
  const centroidLabelFontSizeInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: '12',
    min: '6',
    max: '36',
    step: '1',
    inputMode: 'numeric',
    ariaLabel: 'Centroid label font size (px)'
  });

  // Point radius removed - export now uses viewer's pointSize directly (WYSIWYG)

  const autoTextToggleRow = createElement('div', { className: 'figure-export-style-row figure-export-auto-text-toggle' }, [
    createElement('label', { className: 'checkbox-inline', htmlFor: autoTextSizingCheckbox.id }, [
      autoTextSizingCheckbox,
      ' Auto text'
    ]),
  ]);

  const autoTextBox = createElement('div', { className: 'figure-export-dashed-box figure-export-auto-text-box' }, [
    createElement('div', { className: 'figure-export-sizes-grid' }, [
      createElement('div', { className: 'figure-export-size-item' }, [
        createElement('span', { className: 'figure-export-label' }, ['Base']),
        fontSizeInput,
      ]),
      createElement('div', { className: 'figure-export-size-item' }, [
        createElement('span', { className: 'figure-export-label' }, ['Legend']),
        legendFontSizeInput,
      ]),
      createElement('div', { className: 'figure-export-size-item' }, [
        createElement('span', { className: 'figure-export-label' }, ['Ticks']),
        tickFontSizeInput,
      ]),
      createElement('div', { className: 'figure-export-size-item' }, [
        createElement('span', { className: 'figure-export-label' }, ['Axis']),
        axisLabelFontSizeInput,
      ]),
      createElement('div', { className: 'figure-export-size-item' }, [
        createElement('span', { className: 'figure-export-label' }, ['Title']),
        titleFontSizeInput,
      ]),
      createElement('div', { className: 'figure-export-size-item' }, [
        createElement('span', { className: 'figure-export-label' }, ['Centroids']),
        centroidLabelFontSizeInput,
      ]),
    ]),
  ]);

  const styleBox = createElement('div', { className: 'figure-export-style-box' }, [
    createElement('div', { className: 'section-title' }, ['Background']),
    createElement('div', { className: 'figure-export-style-row' }, [
      backgroundSelect,
      backgroundColorInput,
    ]),
    createElement('div', { className: 'section-title' }, ['Font']),
    createElement('div', { className: 'figure-export-style-row' }, [
      fontSelect,
    ]),
    createElement('div', { className: 'section-title' }, ['Text sizes']),
    autoTextToggleRow,
    autoTextBox,
  ]);
  styleSection.appendChild(styleBox);

  const titleRow = createElement('div', { className: 'control-block' });
  titleRow.appendChild(createElement('label', { htmlFor: 'figure-export-title' }, ['Title:']));
  const titleInput = createElement('input', {
    id: 'figure-export-title',
    type: 'text',
    className: 'figure-input',
    placeholder: 'Optional figure title',
    ariaLabel: 'Figure title'
  });
  titleRow.appendChild(titleInput);

  const xLabelInput = createElement('input', {
    id: 'figure-export-xlabel',
    type: 'text',
    className: 'figure-input figure-export-axis-input',
    value: 'X',
    placeholder: 'e.g., UMAP_1',
    ariaLabel: 'X axis label'
  });

  const yLabelInput = createElement('input', {
    id: 'figure-export-ylabel',
    type: 'text',
    className: 'figure-input figure-export-axis-input',
    value: 'Y',
    placeholder: 'e.g., UMAP_2',
    ariaLabel: 'Y axis label'
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Annotations section
  // ─────────────────────────────────────────────────────────────────────────
  const annotationSection = createElement('div', { className: 'control-block' });
  annotationSection.appendChild(createElement('label', {}, ['Annotations:']));
  annotationSection.appendChild(createElement('div', { className: 'figure-export-hint' }, [
    'Extra elements to include in the export.'
  ]));
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
    createElement('label', { className: 'checkbox-inline', htmlFor: includeAxesCheckbox.id }, [includeAxesCheckbox, ' Axes']),
    createElement('label', { className: 'checkbox-inline', htmlFor: includeLegendCheckbox.id }, [includeLegendCheckbox, ' Legend']),
    referenceGridLabel,
    createElement('label', { className: 'checkbox-inline', htmlFor: showOrientationCheckbox.id }, [showOrientationCheckbox, ' 3D orientation']),
    createElement('label', { className: 'checkbox-inline', htmlFor: depthSortCheckbox.id }, [depthSortCheckbox, ' Depth sort']),
  ]);
  const axisLabelGrid = createElement('div', { className: 'figure-export-axis-label-grid' }, [
    createElement('div', { className: 'figure-export-axis-label-field' }, [
      createElement('span', { className: 'figure-export-label' }, ['X']),
      xLabelInput,
    ]),
    createElement('div', { className: 'figure-export-axis-label-field' }, [
      createElement('span', { className: 'figure-export-label' }, ['Y']),
      yLabelInput,
    ]),
  ]);
  const axisLabelSettings = createElement('div', { className: 'figure-export-axes-settings' }, [
    createElement('label', {}, ['Axis labels:']),
    axisLabelGrid,
    createElement('div', { className: 'figure-export-hint figure-export-hint--tight' }, [
      'Clear X/Y to hide axis labels.'
    ]),
  ]);

  const legendPosSelect = createElement('select', { className: 'obs-select', ariaLabel: 'Legend position' });
  legendPosSelect.appendChild(createElement('option', { value: 'right' }, ['Legend: Right']));
  legendPosSelect.appendChild(createElement('option', { value: 'bottom' }, ['Legend: Bottom']));

  const legendSettingsRow = createElement('div', { className: 'figure-export-style-row figure-export-legend-settings' }, [
    legendPosSelect,
  ]);
  // Interaction chrome is deliberately absent from every figure. Saying so here
  // means it is never discovered only after the file has been opened.
  const chromeDisclosure = createElement(
    'div',
    { className: 'figure-export-hint figure-export-hint--tight' },
    [`Never exported: ${NON_EXPORTED_VIEWER_CHROME.join(', ')}.`]
  );
  const annotationBox = createElement('div', { className: 'figure-export-dashed-box figure-export-annotations-box' }, [
    annotationChecks,
    axisLabelSettings,
    legendSettingsRow,
    chromeDisclosure,
  ]);
  annotationSection.appendChild(annotationBox);

  /**
   * The reference-grid appearance the viewer is drawing right now, or null.
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
    axisLabelSettings.style.display = includeAxesCheckbox.checked ? 'grid' : 'none';
    legendSettingsRow.style.display = includeLegendCheckbox.checked ? 'flex' : 'none';
    const appearance = readViewerReferenceGridAppearance();
    const available = appearance !== null;
    referenceGridCheckbox.disabled = !available;
    referenceGridLabel.title = available
      ? `Include the viewer's ${VIEWER_BACKGROUND_LABELS[appearance.mode]} reference grid.`
      : 'The viewer background draws no reference grid.';
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
  const selectionMutedOpacityInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: '0.15',
    min: '0',
    max: '1',
    step: '0.05',
    inputMode: 'decimal',
    ariaLabel: 'Non-selected opacity (0..1)'
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
  previewRow.appendChild(createElement('label', {}, ['Preview:']));
  const previewEnabledCheckbox = createElement('input', { type: 'checkbox', id: 'figure-export-preview-enabled' });
  const previewRefreshBtn = createElement('button', { type: 'button', className: 'toggle-switch figure-export-framing-btn' }, ['Refresh']);
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
  previewRow.appendChild(createElement('div', { className: 'figure-export-hint figure-export-hint--tight' }, [
    'Shows an export-style preview (required for framing).'
  ]));

  const previewStatus = createElement('div', {
    className: 'figure-export-preview-status',
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
  const previewBox = createElement('div', { className: 'figure-export-preview-box' }, [
    previewCanvas,
    previewStatus,
  ]);

  const previewSettingsBox = createElement('div', { className: 'figure-export-dashed-box figure-export-preview-settings' }, [
    createElement('div', { className: 'figure-export-preview-settings-top' }, [
      previewModeSelect,
      previewRefreshBtn,
    ]),
    createElement('div', { className: 'figure-export-preview-settings-row figure-export-preview-settings-row--toggles' }, [
      frameExportToggleLabel,
    ]),
    createElement('div', { className: 'figure-export-hint figure-export-hint--tight' }, [
      'Crop the export by dragging the frame in the preview.'
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
  advancedSection.appendChild(createElement('label', {}, ['Download:']));
  advancedSection.appendChild(createElement('div', { className: 'figure-export-hint' }, [
    'Format and resolution for the exported file.'
  ]));

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

  const strategySelect = createElement('select', { className: 'obs-select', ariaLabel: 'SVG point strategy' });
  strategySelect.appendChild(createElement('option', {
    value: '',
    disabled: true,
    selected: true,
  }, ['Choose SVG strategy…']));
  strategySelect.appendChild(createElement('option', { value: 'full-vector' }, ['Full vector']));
  strategySelect.appendChild(createElement('option', { value: 'optimized-vector' }, ['Optimized vector']));
  strategySelect.appendChild(createElement('option', { value: 'hybrid' }, ['Hybrid']));

  const optimizedTargetCountInput = createElement('input', {
    type: 'number',
    className: 'figure-input figure-input-sm',
    value: '100000',
    min: '1000',
    max: '5000000',
    step: '1000',
    inputMode: 'numeric',
    ariaLabel: 'Optimized vector target points'
  });
  const targetGroup = createElement('div', { className: 'figure-export-inline', id: 'figure-export-target-group' }, [
    createElement('span', { className: 'figure-export-label' }, ['Keep']),
    optimizedTargetCountInput,
  ]);
  const densitySettingsRow = createElement('div', { className: 'figure-export-style-row', id: 'figure-export-density-settings' }, [
    targetGroup,
  ]);
  const densityHint = createElement('div', { className: 'figure-export-hint' }, [
    'Full Vector writes every point; Optimized Vector writes the exact chosen target count; Hybrid embeds the shader-rendered point pass. '
    + 'Vector points carry the viewer’s atmospheric fog but are flat discs: '
    + 'only Hybrid and PNG reproduce the 3D sphere lighting.'
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
    const mode = downloadSelect.value;
    const needsPng = mode === 'png' || mode === 'svg+png' || mode === 'png-multi' || mode === 'all';
    const needsSvg = mode === 'svg' || mode === 'svg+png' || mode === 'all';
    const multiPng = mode === 'png-multi' || mode === 'all';

    const strategy = strategySelect.value;
    densitySettingsRow.style.display = needsSvg && strategy === 'optimized-vector' ? 'flex' : 'none';
    densityHint.style.display = needsSvg ? 'block' : 'none';
    targetGroup.style.display = strategy === 'optimized-vector' ? 'inline-flex' : 'none';

    dpiSelect.style.display = needsPng && !multiPng ? 'block' : 'none';
    strategySelect.style.display = needsSvg ? 'block' : 'none';
    backgroundColorInput.style.display = backgroundSelect.value === 'custom' ? 'block' : 'none';
    selectionMutedOpacityInput.parentElement.style.display = emphasizeSelectionCheckbox.checked ? 'inline-flex' : 'none';

    const previewOn = previewEnabledCheckbox.checked;
    previewBox.style.display = previewOn ? 'grid' : 'none';
    previewSettingsBox.style.display = previewOn ? 'grid' : 'none';
    if (!previewOn) {
      previewStatus.textContent = 'Preview is off.';
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
    heightInput,
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

  listen(cropFitPlotBtn, 'click', () => {
    if (!cropEnabled) return;
    const viewId = getActiveViewIdForPreview();
    const rs = getPreviewRenderStateForView(viewId);
    const vw = Math.max(1, Number(rs?.viewportWidth) || 1);
    const vh = Math.max(1, Number(rs?.viewportHeight) || 1);
    const c = assertCropRect01({ enabled: true, ...cropRect01 });
    if (!c || !Number.isFinite(c.width) || !Number.isFinite(c.height) || c.width <= 0 || c.height <= 0) return;

    const cropAspect = (c.width * vw) / Math.max(1e-6, c.height * vh);
    if (!Number.isFinite(cropAspect) || cropAspect <= 0) return;

    const w = Math.max(100, parseInt(widthInput.value, 10) || DEFAULT_SIZE.width);
    const nextH = clamp(Math.round(w / cropAspect), 100, 20000);
    heightInput.value = String(nextH);
    onPlotSizeAspectChange();
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
    const base = clamp(Math.round(area / 70), 14, 30);
    const title = Math.max(18, Math.round(base * 1.35));
    const axis = Math.max(14, Math.round(base * 1.15));
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

  listen(autoTextSizingCheckbox, 'change', () => {
    syncTextSizingUi();
    schedulePreviewDraw();
  });

  // Keep the crop frame aspect synced to the export plot aspect.
  const aspectInputs = [widthInput, heightInput];
  const onPlotSizeAspectChange = () => {
    if (cropEnabled) enforceCropAspect();
    syncCropUi();
    syncTextSizingUi();
    invalidatePreviewSamples();
    schedulePreviewDraw();
  };
  for (const el of aspectInputs) {
    listen(el, 'input', onPlotSizeAspectChange);
    listen(el, 'change', onPlotSizeAspectChange);
  }

  function readSizePreset() {
    const preset = presetSelect.value;
    if (preset !== 'screen' && preset !== 'screen-half') return;
    const rs = viewer.getRenderState();
    if (!rs) return;
    const scale = preset === 'screen-half' ? 0.5 : 1;
    const nextW = Math.max(100, Math.round((rs.viewportWidth || DEFAULT_SIZE.width) * scale));
    const nextH = Math.max(100, Math.round((rs.viewportHeight || DEFAULT_SIZE.height) * scale));
    widthInput.value = String(nextW);
    heightInput.value = String(nextH);
  }

  listen(presetSelect, 'change', () => {
    const value = presetSelect.value;
    if (value === 'screen' || value === 'screen-half') {
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

  // Seed the screen preset once after init.
  readSizePreset();
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
    const fieldLabel = String(legendField?.label || legendField?.name || legendField?.key || '').trim();

    const legendModel = legendField && typeof state?.getLegendModel === 'function' ? state.getLegendModel(legendField) : null;
    let categorySummary = '';
    if (legendModel?.kind === 'category' && Array.isArray(legendModel.categories) && legendModel.categories.length) {
      const visibleMap = legendModel.visible || {};
      const visibleCounts = Array.isArray(legendModel?.counts?.visible) ? legendModel.counts.visible : null;
      const shown = legendModel.categories
        .map((name, i) => {
          if (visibleMap[i] === false) return null;
          if (visibleCounts && (Number(visibleCounts[i]) || 0) <= 0) return null;
          const s = String(name ?? '').trim();
          return s ? s : null;
        })
        .filter((name) => Boolean(name));

      if (shown.length === 1) {
        categorySummary = shown[0];
      } else if (shown.length === 2 || shown.length === 3) {
        categorySummary = shown.join(', ');
      } else if (shown.length > 3) {
        categorySummary = `${shown.slice(0, 2).join(', ')} +${shown.length - 2}`;
      }
    }

    if (safeDataset && fieldLabel && categorySummary) return `${safeDataset} • ${fieldLabel}: ${categorySummary}`;
    if (safeDataset && fieldLabel) return `${safeDataset} • ${fieldLabel}`;
    if (safeDataset && categorySummary) return `${safeDataset} • ${categorySummary}`;
    if (fieldLabel && categorySummary) return `${fieldLabel}: ${categorySummary}`;
    return safeDataset || fieldLabel || categorySummary || '';
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
      if (previewTitleTimer !== null) {
        clearTimeout(previewTitleTimer);
      }
      previewTitleTimer = setTimeout(() => {
        previewTitleTimer = null;
        if (!cleanupComplete && !previewDisposed) syncAutoTitle();
      }, 0);
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
  subscribePreviewInvalidation('field:changed', {
    title: true,
  });
  subscribePreviewInvalidation('visibility:changed', {
    title: true,
  });
  subscribePreviewInvalidation('highlight:changed');
  subscribePreviewInvalidation('dimension:changed');
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
    if (!previewDisposed) invalidatePreviewSamples();
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

  // Point radius is now taken directly from viewer's renderState (WYSIWYG)

  function setBusy(busy) {
    exportBtn.disabled = busy;
    exportBtn.textContent = busy ? 'Exporting…' : 'Export';
  }

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
        `Figure preview point-count mismatch: viewer has ${viewerCount} points while state has ${stateCount}.`
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

  /** @type {{ viewId: string; renderState: any; reduced: any; dim: number; cameraState: any; navMode: string; certificate: any; ticket: any; mode: 'full' } | null} */
  let previewSampleFull = null;
  /** @type {{ viewId: string; renderState: any; reduced: any; dim: number; cameraState: any; navMode: string; certificate: any; ticket: any; mode: 'crop'; crop: any } | null} */
  let previewSampleCrop = null;
  /** @type {'edit'|'applied'} */
  let previewFramingMode = 'edit';
  let previewDrawTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  let previewRebuildTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  let previewTitleTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  let previewPendingFrame = null;
  let previewBuildToken = 0;

  /** @type {{ x: number; y: number; width: number; height: number }} */
  let cropRect01 = { x: 0, y: 0, width: 1, height: 1 };
  let cropEnabled = false;

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

  function queuePreviewRebuild(delayMs = 0) {
    if (
      cleanupComplete ||
      previewDisposed ||
      !previewEnabledCheckbox.checked
    ) {
      return;
    }
    if (previewRebuildTimer !== null) {
      clearTimeout(previewRebuildTimer);
      previewRebuildTimer = null;
    }
    previewRebuildTimer = setTimeout(() => {
      previewRebuildTimer = null;
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
    }, delayMs);
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
    if (previewRebuildTimer !== null) {
      clearTimeout(previewRebuildTimer);
      previewRebuildTimer = null;
    }
    if (rebuild) queuePreviewRebuild(rebuildDelayMs);
  }

  cleanupFns.push(() => {
    previewDisposed = true;
    previewEpochFence.close();
    previewBuildToken++;
    cancelPendingPreviewFrame();
    if (previewDrawTimer !== null) {
      clearTimeout(previewDrawTimer);
      previewDrawTimer = null;
    }
    if (previewRebuildTimer !== null) {
      clearTimeout(previewRebuildTimer);
      previewRebuildTimer = null;
    }
    if (previewTitleTimer !== null) {
      clearTimeout(previewTitleTimer);
      previewTitleTimer = null;
    }
    endCropDrag();
    releasePreviewSamples();
    lastAutoTitle = '';
  });

  function getExportAspect() {
    const w = Math.max(1, parseInt(widthInput.value, 10) || DEFAULT_SIZE.width);
    const h = Math.max(1, parseInt(heightInput.value, 10) || DEFAULT_SIZE.height);
    return w / h;
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
    cropLockCheckbox.disabled = !cropEnabled;
    cropConfirmBtn.disabled = !cropEnabled;
    cropFitPlotBtn.disabled = !cropEnabled;
    lockAspectBtn.disabled = !cropEnabled;
    lockAspectBtn.setAttribute('aria-pressed', cropLockCheckbox.checked ? 'true' : 'false');

    framingActionGrid.style.display = cropEnabled ? 'grid' : 'none';
    cropAspectHint.style.display = cropEnabled ? '' : 'none';

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

        const exportW = Math.max(100, parseInt(widthInput.value, 10) || DEFAULT_SIZE.width);
        const exportH = Math.max(100, parseInt(heightInput.value, 10) || DEFAULT_SIZE.height);
        const fullScale = Math.min(exportW / vw, exportH / vh);
        const cropW = Math.max(1e-6, c.width * vw);
        const cropH = Math.max(1e-6, c.height * vh);
        const cropScale = Math.min(exportW / cropW, exportH / cropH);
        const zoom = cropScale / Math.max(1e-6, fullScale);
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
      previewCanvas.style.cursor = 'default';
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
      aspect: Object.freeze({
        height: Math.max(
          1,
          parseInt(heightInput.value, 10) ||
            DEFAULT_SIZE.height
        ),
        width: Math.max(
          1,
          parseInt(widthInput.value, 10) ||
            DEFAULT_SIZE.width
        ),
      }),
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

  let cachedWebgl2ExportSupport = /** @type {boolean|null} */ (null);
  function canCreateWebgl2Context() {
    if (cachedWebgl2ExportSupport != null) return cachedWebgl2ExportSupport;

    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true
    });
    if (gl) {
      cachedWebgl2ExportSupport = true;
      // This is a capability probe, not a retained renderer. Release its
      // context immediately so repeated UI teardown/reinitialization cannot
      // consume the browser's finite WebGL context budget.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return true;
    }

    cachedWebgl2ExportSupport = false;
    return false;
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

    const visibleCount = inferVisiblePointCount();
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
          positions.length !== pointCount * 3 ||
          !(colors instanceof Uint8Array) ||
          colors.length !== pointCount * 4 ||
          (
            transparency !== null &&
            (
              !(transparency instanceof Float32Array) ||
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
            `Figure preview borrowed ${pointCount} points while state owns ${state.pointCount}.`
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
        return {
          cameraState,
          certificate,
          crop,
          dim: dimensionLevel,
          mode,
          navMode: cameraState.navigationMode,
          pointDiameterViewportPx:
            presented.renderState.pointSize *
            presented.lodSizeMultiplier,
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
    const sampleNote = cappedSample
      ? ` • ${candidate.reduced.scannedSourceCount.toLocaleString()} of ${candidate.reduced.candidateSourceCount.toLocaleString()} source IDs scanned`
      : '';
    const label = wantsCrop ? 'Framed preview' : 'Preview sample';
    const sampleCount = candidate.reduced.x.length;
    const emptyNote =
      sampleCount === 0 ? ' • no visible points' : '';
    previewStatus.textContent =
      `${label}: ${sampleCount.toLocaleString()} points` +
      `${sampleNote}${emptyNote}`;
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
    if (previewDrawTimer !== null) {
      clearTimeout(previewDrawTimer);
    }
    previewDrawTimer = setTimeout(() => {
      previewDrawTimer = null;
      if (cleanupComplete || previewDisposed) return;
      // The viewer background can change while this panel is open, so the
      // reference-grid control's availability is re-resolved every draw.
      syncAnnotationUi();
      drawPreview();
    }, 80);
  }

  function computeApproxBoundsFromSample({
    reduced,
    normTransform,
    cropPx = null,
  }) {
    const positions = reduced?.sourcePositions;
    if (
      !(positions instanceof Float32Array) ||
      positions.length !== (reduced?.x?.length ?? -1) * 3
    ) {
      return null;
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const outN = reduced.x.length;
    for (let i = 0; i < outN; i++) {
      if (cropPx && reduced?.x && reduced?.y) {
        const vx = reduced.x[i];
        const vy = reduced.y[i];
        if (vx < cropPx.x || vx > cropPx.x + cropPx.width) continue;
        if (vy < cropPx.y || vy > cropPx.y + cropPx.height) continue;
      }
      const base = i * 3;
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

  function computeApproxCameraBoundsFromSample({
    reduced,
    viewMatrix,
    cropPx = null,
  }) {
    const positions = reduced?.sourcePositions;
    if (
      !(positions instanceof Float32Array) ||
      positions.length !== (reduced?.x?.length ?? -1) * 3 ||
      !viewMatrix
    ) {
      return null;
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const outN = reduced.x.length;
    for (let i = 0; i < outN; i++) {
      if (cropPx && reduced?.x && reduced?.y) {
        const vx = reduced.x[i];
        const vy = reduced.y[i];
        if (vx < cropPx.x || vx > cropPx.x + cropPx.width) continue;
        if (vy < cropPx.y || vy > cropPx.y + cropPx.height) continue;
      }
      const base = i * 3;
      const x = positions[base];
      const y = positions[base + 1];
      const z = positions[base + 2];
      const cx = viewMatrix[0] * x + viewMatrix[4] * y + viewMatrix[8] * z + viewMatrix[12];
      const cy = viewMatrix[1] * x + viewMatrix[5] * y + viewMatrix[9] * z + viewMatrix[13];
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) return null;
    return { minX, maxX, minY, maxY };
  }

  function drawPreview() {
    if (
      previewDisposed ||
      !previewEnabledCheckbox.checked
    ) {
      return;
    }

    const ctx = /** @type {CanvasRenderingContext2D|null} */ (previewCanvas.getContext('2d'));
    if (!ctx) return;

    const exportW = Math.max(100, parseInt(widthInput.value, 10) || DEFAULT_SIZE.width);
    const exportH = Math.max(100, parseInt(heightInput.value, 10) || DEFAULT_SIZE.height);
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
    const baseFontSizePx = Math.max(6, parseInt(fontSizeInput.value, 10) || 12);
    const legendFontSizePx = Math.max(6, parseInt(legendFontSizeInput.value, 10) || baseFontSizePx);
    const tickFontSizePx = Math.max(6, parseInt(tickFontSizeInput.value, 10) || baseFontSizePx);
    const axisLabelFontSizePx = Math.max(6, parseInt(axisLabelFontSizeInput.value, 10) || baseFontSizePx);
    const titleFontSizePx = Math.max(10, parseInt(titleFontSizeInput.value, 10) || Math.max(14, Math.round(baseFontSizePx * 1.25)));
    const centroidLabelFontSizePx = Math.max(6, parseInt(centroidLabelFontSizeInput.value, 10) || baseFontSizePx);

    const includeLegend = includeLegendCheckbox.checked;
    const legendPosition = legendPosSelect.value === 'bottom' ? 'bottom' : 'right';
    const includeAxes = includeAxesCheckbox.checked;
    const axesEligible = includeAxes;

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
    const viewerBgHex = rgb01ToHex(getPreviewRenderStateForView(legendViewId)?.bgColor) || '#ffffff';
    const backgroundColor = background === 'custom'
      ? String(backgroundColorInput.value || '#ffffff')
      : (background === 'viewer' ? viewerBgHex : '#ffffff');
    // The preview writes in the same ink the exported file will.
    const ink = resolveFigureInk({ background, backgroundColor });
    if (background !== 'transparent') {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, totalW, totalH);
    }

    if (titleText) {
      const titleSize = Math.max(14, titleFontSizePx);
      const rect = layout.titleRect || { x: layout.outerPadding, y: layout.outerPadding, width: totalW - layout.outerPadding * 2, height: 0 };
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

    // Compute the on-screen (full) viewport rectangle inside plotRect (letterboxed).
    const reduced = sample?.reduced || null;
    const rs = sample?.renderState || getPreviewRenderStateForView(getActiveViewIdForPreview());
    const fullViewportW = Math.max(1, (rs?.viewportWidth || 1));
    const fullViewportH = Math.max(1, (rs?.viewportHeight || 1));
    const vpScale = Math.min(plotRect.width / fullViewportW, plotRect.height / fullViewportH);
    const viewportRect = {
      x: plotRect.x + (plotRect.width - fullViewportW * vpScale) / 2,
      y: plotRect.y + (plotRect.height - fullViewportH * vpScale) / 2,
      width: fullViewportW * vpScale,
      height: fullViewportH * vpScale
    };
    previewGeom = { scale: s, ox, oy, viewportRect };

    // The reference grid is a background layer, so the preview draws it before
    // the points and before the "no sample yet" early return: a preview that
    // omitted it would misdescribe the file the button is about to write.
    const previewReferenceGrid = resolveExportReferenceGrid();
    if (previewReferenceGrid !== null && rs?.mvpMatrix && rs?.viewMatrix) {
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
          // The raw crop input, not a normalized rect: `assertCropRect01()`
          // returns a four-key rect that is not itself valid crop input.
          crop: cropEnabled && previewFramingMode === 'applied'
            ? { enabled: true, ...cropRect01 }
            : null,
          surfaceRgb: resolveReferenceGridSurfaceRgb({
            appearance: previewReferenceGrid,
            background,
            backgroundColor,
          }),
        }),
      });
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

    // Plot-space mapping for viewport coords (full viewport or crop viewport).
    let srcX0 = 0;
    let srcY0 = 0;
    let srcW = fullViewportW;
    let srcH = fullViewportH;
    let cropPxForBounds = null;

    if (appliedFraming) {
      if (usingCropSample) {
        srcW = Math.max(1, Number(reduced.viewportWidth) || 1);
        srcH = Math.max(1, Number(reduced.viewportHeight) || 1);
      } else {
        const norm = assertCropRect01({ enabled: true, ...cropRect01 });
        if (norm) cropRect01 = norm;
        if (norm) {
          srcX0 = norm.x * fullViewportW;
          srcY0 = norm.y * fullViewportH;
          srcW = Math.max(1, norm.width * fullViewportW);
          srcH = Math.max(1, norm.height * fullViewportH);
          cropPxForBounds = { x: srcX0, y: srcY0, width: srcW, height: srcH };
        }
      }
    }

    const plotScale = Math.min(plotRect.width / srcW, plotRect.height / srcH);
    const plotOffsetX = plotRect.x + (plotRect.width - srcW * plotScale) / 2;
    const plotOffsetY = plotRect.y + (plotRect.height - srcH * plotScale) / 2;

    const pointRadiusViewportPx =
      sample.pointDiameterViewportPx / 2;
    const rawPointRadiusPx = pointRadiusViewportPx * plotScale;
    // Preview is heavily downscaled; enforce a minimum dot size in *screen pixels*
    // so points remain visible even when the exported figure is large.
    const minPreviewRadiusPx = (1.2 / Math.max(0.0001, s)) / 2; // 1.2px diameter on screen
    const pointRadiusPx = Math.max(rawPointRadiusPx, minPreviewRadiusPx);

    // Points (preview always uses the reduced sample).
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
    ctx.clip();

    const totalHighlighted = typeof state?.getTotalHighlightedCellCount === 'function'
      ? state.getTotalHighlightedCellCount()
      : (typeof state?.getHighlightedCellCount === 'function' ? state.getHighlightedCellCount() : 0);
    const emphasizeSelection = emphasizeSelectionCheckbox.checked && totalHighlighted > 0;
    const mutedAlpha = parseFiniteNumberInRange(
      selectionMutedOpacityInput.value,
      0,
      1,
      'Non-selected opacity',
    );
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
      const centroidRadiusPx = Math.max(0.5, (Number(sample.renderState.pointSize || 5) * 4.0) * 0.5 * plotScale);

      drawCanvasCentroidOverlay({
        ctx,
        positions: centroidPositions,
        colors: centroidColors,
        labelTexts: centroidLabelTexts,
        flags: { points: showCentroidPoints, labels: showCentroidLabels },
        renderState: sample.renderState,
        plotRect,
        pointRadiusPx: centroidRadiusPx,
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
        viewMatrix: sample.renderState.viewMatrix,
        cameraState: sample.cameraState,
        fontFamily,
        fontSize: orientationFontSize,
        ink
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
        ctx.fillStyle = ink.surface;
        ctx.fillRect(boxX, boxY, boxW, boxH);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = ink.frame;
        ctx.lineWidth = 1;
        ctx.strokeRect(boxX, boxY, boxW, boxH);
        ctx.fillStyle = ink.surfaceInk;
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
        backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor,
        ink
      });
    }

    // Axes (approximate bounds from preview sample).
    if (
      axesEligible &&
      reduced.sourcePositions instanceof Float32Array &&
      reduced.sourcePositions.length > 0
    ) {
      const navMode = assertNavigationMode(sample.navMode);
      if (typeof state.dimensionManager?.getNormTransform !== 'function') {
        throw new TypeError(
          'Figure preview state must publish dimensionManager.getNormTransform().'
        );
      }
      const useCameraAxes = sample?.dim > 2 && navMode !== 'planar' && sample?.renderState?.viewMatrix;
      const bounds = (
        useCameraAxes
          ? computeApproxCameraBoundsFromSample({
            reduced: sample.reduced,
            viewMatrix: sample.renderState.viewMatrix,
            cropPx: appliedFraming && !usingCropSample ? cropPxForBounds : null
          })
          : computeApproxBoundsFromSample({
            reduced: sample.reduced,
            normTransform: state.dimensionManager.getNormTransform(sample.dim),
            cropPx: appliedFraming && !usingCropSample ? cropPxForBounds : null
          })
      );
      if (bounds !== null) {
        drawCanvasAxes({
          ctx,
          plotRect,
          bounds,
          xLabel: xLabelInput.value,
          yLabel: yLabelInput.value,
          fontFamily,
          tickFontSize: tickFontSizePx,
          labelFontSize: axisLabelFontSizePx,
          color: ink.text
        });
      }
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

  function updateCropCursor(mode) {
    if (!mode) {
      previewCanvas.style.cursor = 'default';
      return;
    }
    if (mode === 'move') previewCanvas.style.cursor = 'move';
    else previewCanvas.style.cursor = 'nwse-resize';
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

  function readExactIntegerInput(input, label, minimum, maximum = Number.MAX_SAFE_INTEGER) {
    const raw = input.value;
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
      input.setCustomValidity(`${label} must be a whole number.`);
      input.reportValidity();
      return null;
    }
    const value = Number(raw);
    if (
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      input.setCustomValidity(
        `${label} must be between ${minimum} and ${maximum}.`
      );
      input.reportValidity();
      return null;
    }
    input.setCustomValidity('');
    return value;
  }

  function readExactDecimalInput(input, label, minimum, maximum) {
    const raw = input.value;
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw)) {
      input.setCustomValidity(`${label} must be a decimal number.`);
      input.reportValidity();
      return null;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      input.setCustomValidity(
        `${label} must be between ${minimum} and ${maximum}.`
      );
      input.reportValidity();
      return null;
    }
    input.setCustomValidity('');
    return value;
  }

  listen(exportBtn, 'click', () => {
    void handleFigureExportClick();
  });

  async function handleFigureExportClick() {
    if (cleanupComplete || exportInFlight) return;
    exportInFlight = true;
    const abortController = new AbortController();
    activeExportAbortController = abortController;
    setBusy(true);
    try {
      await exportFigureFromUi(abortController.signal);
    } catch (error) {
      if (!abortController.signal.aborted) {
        // Engine failures are already marked; UI/request failures enter the
        // same reporter here. Either path produces one visible notification.
        reportFigureExportFailure(error);
      }
    } finally {
      abortController.abort();
      if (activeExportAbortController === abortController) {
        activeExportAbortController = null;
      }
      exportInFlight = false;
      if (!cleanupComplete) setBusy(false);
    }
  }

  async function exportFigureFromUi(signal) {
    const width = readExactIntegerInput(widthInput, 'Width', 100, 20_000);
    if (width === null) return;
    const height = readExactIntegerInput(heightInput, 'Height', 100, 20_000);
    if (height === null) return;

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
    if (needsPng && !multiPng && dpi === null) return;

    const strategy = needsSvg ? strategySelect.value : null;
    if (
      needsSvg &&
      !['full-vector', 'optimized-vector', 'hybrid'].includes(strategy)
    ) {
      strategySelect.setCustomValidity('Choose an SVG point strategy.');
      strategySelect.reportValidity();
      return;
    }
    strategySelect.setCustomValidity('');
    const optimizedTargetCount = strategy === 'optimized-vector'
      ? readExactIntegerInput(
          optimizedTargetCountInput,
          'Optimized vector target',
          1000,
          5_000_000
        )
      : null;
    if (strategy === 'optimized-vector' && optimizedTargetCount === null) return;

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

    const needsShaderAccurateRasterization = needsPng || (needsSvg && strategy === 'hybrid');
    if (needsShaderAccurateRasterization) {
      const rs = getPreviewRenderStateForView(activeViewId);
      const missing = [];
      if (!canCreateWebgl2Context()) missing.push('WebGL2');
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

    const proceed = await confirmExportFidelityWarnings({
      warnings,
      signal,
    });
    if (!proceed) return;

      const baseFontSizePx = readExactIntegerInput(fontSizeInput, 'Base font size', 1, 500);
      if (baseFontSizePx === null) return;
      const legendFontSizePx = readExactIntegerInput(legendFontSizeInput, 'Legend font size', 1, 500);
      if (legendFontSizePx === null) return;
      const tickFontSizePx = readExactIntegerInput(tickFontSizeInput, 'Tick font size', 1, 500);
      if (tickFontSizePx === null) return;
      const axisLabelFontSizePx = readExactIntegerInput(axisLabelFontSizeInput, 'Axis-label font size', 1, 500);
      if (axisLabelFontSizePx === null) return;
      const titleFontSizePx = readExactIntegerInput(titleFontSizeInput, 'Title font size', 1, 500);
      if (titleFontSizePx === null) return;
      const centroidLabelFontSizePx = readExactIntegerInput(centroidLabelFontSizeInput, 'Centroid-label font size', 1, 500);
      if (centroidLabelFontSizePx === null) return;
      const selectionMutedOpacity = readExactDecimalInput(
        selectionMutedOpacityInput,
        'Muted selection opacity',
        0,
        1
      );
      if (selectionMutedOpacity === null) return;
      if (!['right', 'bottom'].includes(legendPosSelect.value)) {
        throw new TypeError('Figure export legend position is not a current UI value.');
      }
      if (!['viewer', 'white', 'transparent', 'custom'].includes(backgroundSelect.value)) {
        throw new TypeError('Figure export background is not a current UI value.');
      }
      if (!/^#[0-9a-fA-F]{6}$/.test(backgroundColorInput.value)) {
        backgroundColorInput.setCustomValidity('Background color must be #RRGGBB.');
        backgroundColorInput.reportValidity();
        return;
      }
      backgroundColorInput.setCustomValidity('');
      if (fontSelect.value.trim().length === 0) {
        throw new TypeError('Figure export font family must be non-empty.');
      }

      const baseOptions = {
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
        // pointRadiusPx removed - export now uses viewer's pointSize directly (WYSIWYG)
        showOrientation: showOrientationCheckbox.checked,
        depthSort3d: depthSortCheckbox.checked,
        emphasizeSelection: emphasizeSelectionCheckbox.checked,
        selectionMutedOpacity,
        strategy,
        optimizedTargetCount
      };

      let result;
      /** @type {{ format: 'svg'|'png'; dpi: number|null }[]} */
      const jobs = [];
      if (needsSvg) jobs.push({ format: 'svg', dpi: null });
      if (needsPng) {
        if (multiPng) jobs.push(...[150, 300, 600].map((d) => ({ format: 'png', dpi: d })));
        else jobs.push({ format: 'png', dpi });
      }

      if (jobs.length === 1) {
        result = await engine.exportFigure({
          ...baseOptions,
          signal,
          format: jobs[0].format,
          dpi: jobs[0].dpi,
        });
      } else {
        const results = await engine.exportFigures({
          ...baseOptions,
          signal,
          jobs
        });
        result = results[0];
      }

  }

  function buildSubAccordionItem({ title, desc, open = false, content = [] }) {
    const safeTitle = String(title || '').trim() || 'Section';
    const safeDesc = String(desc || '').trim();
    const item = createElement('div', { className: `analysis-accordion-item${open ? ' open' : ''}` });
    const contentId = `figure-export-${safeTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-panel`;
    const toggle = createElement(
      'button',
      {
        type: 'button',
        className: 'analysis-accordion-header',
        ariaExpanded: open ? 'true' : 'false',
        ariaControls: contentId
      },
      [
        createElement('span', { className: 'analysis-accordion-title' }, [safeTitle]),
        createElement('span', { className: 'analysis-accordion-desc' }, [safeDesc]),
        createElement('span', { className: 'analysis-accordion-chevron', ariaHidden: 'true' })
      ]
    );
    const panel = createElement('div', { className: 'analysis-accordion-content', id: contentId }, content);
    listen(toggle, 'click', () => {
      const next = !item.classList.contains('open');
      if (next) {
        const parent = item.parentElement;
        const siblings = parent ? Array.from(parent.children) : [];
        for (const sibling of siblings) {
          if (!(sibling instanceof HTMLElement)) continue;
          if (sibling === item) continue;
          if (!sibling.classList.contains('analysis-accordion-item')) continue;
          if (!sibling.classList.contains('open')) continue;
          sibling.classList.remove('open');
          const siblingToggle = sibling.firstElementChild;
          if (siblingToggle && siblingToggle.classList.contains('analysis-accordion-header')) {
            siblingToggle.setAttribute('aria-expanded', 'false');
          }
        }
      }
      item.classList.toggle('open', next);
      toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    });
    item.appendChild(toggle);
    item.appendChild(panel);
    return { item, toggle, panel };
  }

  const subAccordion = createElement('div', { className: 'analysis-accordion figure-export-accordion' });
  subAccordion.appendChild(buildSubAccordionItem({
    title: 'Framing',
    desc: 'Plot size, frame export, preview',
    open: false,
    content: [plotAndFrameRow, previewRow]
  }).item);
  subAccordion.appendChild(buildSubAccordionItem({
    title: 'Labels & Annotations',
    desc: 'Title, axes, legend, selection, 3D orientation',
    open: false,
    content: [titleRow, annotationSection, selectionRow]
  }).item);
  subAccordion.appendChild(buildSubAccordionItem({
    title: 'Style',
    desc: 'Background and typography',
    open: false,
    content: [styleSection]
  }).item);
  subAccordion.appendChild(buildSubAccordionItem({
    title: 'Download',
    desc: 'Format, DPI, explicit SVG strategy',
    open: false,
    content: [advancedSection]
  }).item);

  container.appendChild(header);
  container.appendChild(subAccordion);
  container.appendChild(actionsRow);

  syncFormatDependentUi();
  syncCropUi();

  return { destroy };
}
