/**
 * @fileoverview Annotation (Alt+click / Alt+drag) selection tool.
 *
 * Converts viewer selection gestures into highlight candidate sets with
 * undo/redo + confirm/cancel controls, and updates the preview highlight in
 * DataState while the selection is in progress.
 *
 * @module ui/modules/highlight/annotation-selection
 */

import { debug } from '../../../../utils/debug.js';
import { HIGHLIGHT_MODE_COPY } from './mode-copy.js';
import { MAX_HISTORY_STEPS } from './selection-state.js';
import {
  deliverSelectionToJupyter,
  showSelectionDeliveryFailure
} from './selection-notification.js';
import {
  requireAnnotationStepEvent,
  requireContinuousStatistics,
  requireDomElement,
  requireExactKeys,
  requireFieldSource,
  requireHighlightSelectionState,
  requireJupyterSource,
  requireMethods,
  requireSafeInteger,
  requireSavedHighlightGroup,
  requireUnifiedSelectionState
} from './exact-contract.js';

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {any|null} [options.jupyterSource]
 * @param {ReturnType<import('./selection-state.js').createHighlightSelectionState>} options.selectionState
 * @param {object} options.ui
 * @param {HTMLElement|null} options.ui.modeDescriptionEl
 * @param {() => void} options.ui.hideRangeLabel
 * @returns {{ handleAnnotationStep: (stepEvent: any) => void }}
 */
export function initAnnotationSelection(options) {
  requireExactKeys(
    options,
    ['state', 'viewer', 'jupyterSource', 'selectionState', 'ui'],
    'Annotation selection options'
  );
  const { state, viewer, jupyterSource, selectionState, ui } = options;
  requireMethods(
    state,
    'Annotation selection state',
    [
      'addHighlightDirect',
      'clearPreviewHighlight',
      'getActiveField',
      'getCategoryForCell',
      'getCellIndicesForCategory',
      'getCellIndicesForRange',
      'getValueForCell',
      'setPreviewHighlightFromIndices'
    ]
  );
  requireMethods(
    viewer,
    'Annotation selection viewer',
    [
      'cancelAnnotationSelection',
      'confirmAnnotationSelection',
      'getViewTransparency',
      'restoreUnifiedState',
      'setSelectionStepCallback'
    ]
  );
  requireJupyterSource(jupyterSource);
  requireHighlightSelectionState(selectionState);
  requireExactKeys(
    ui,
    ['modeDescriptionEl', 'hideRangeLabel'],
    'Annotation selection UI'
  );
  const highlightModeDescriptionEl = requireDomElement(
    ui.modeDescriptionEl,
    'Annotation mode description'
  );
  requireDomElement(
    highlightModeDescriptionEl.parentElement,
    'Annotation mode description parent',
    ['appendChild']
  );
  if (typeof ui.hideRangeLabel !== 'function') {
    throw new TypeError(
      'Annotation hideRangeLabel must be a function.'
    );
  }
  const hideRangeLabel = ui.hideRangeLabel;
  const documentOwner = globalThis.document;
  requireMethods(
    documentOwner,
    'Annotation selection document',
    ['createElement', 'getElementById']
  );

  function computeAnnotationCellIndices(selectionEvent, viewTransparency) {
    const activeField = state.getActiveField();
    if (activeField === null) {
      throw new Error(
        'Annotation selection requires an active categorical or continuous field.'
      );
    }

    const cellIndex = selectionEvent.cellIndex;
    const source = requireFieldSource(state.activeFieldSource);
    const fieldIndex = source === 'var'
      ? state.activeVarFieldIndex
      : state.activeFieldIndex;
    requireSafeInteger(fieldIndex, 'Annotation active field index', 0);

    if (activeField.kind === 'category') {
      const categoryIndex = state.getCategoryForCell(cellIndex, fieldIndex, source);
      const missingCode = activeField.codes instanceof Uint8Array
        ? 255
        : activeField.codes instanceof Uint16Array
          ? 65_535
          : null;
      if (missingCode === null) {
        throw new TypeError(
          'Annotation category codes must be Uint8Array or Uint16Array.'
        );
      }
      if (categoryIndex === missingCode) return [];
      requireSafeInteger(
        categoryIndex,
        'Annotation category index',
        0
      );
      if (
        !Array.isArray(activeField.categories)
        || categoryIndex >= activeField.categories.length
      ) {
        throw new RangeError(
          'Annotation category index is outside the active categories.'
        );
      }
      return state.getCellIndicesForCategory(fieldIndex, categoryIndex, source, viewTransparency);
    }

    if (activeField.kind === 'continuous') {
      const clickedValue = state.getValueForCell(cellIndex, fieldIndex, source);
      if (Number.isNaN(clickedValue)) return [];
      if (!Number.isFinite(clickedValue)) {
        throw new TypeError(
          'Annotation continuous value must be finite or NaN.'
        );
      }

      const stats = requireContinuousStatistics(activeField);
      const valueRange = stats.max - stats.min;

      let minVal;
      let maxVal;
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

      return state.getCellIndicesForRange(fieldIndex, minVal, maxVal, source, viewTransparency);
    }

    throw new TypeError(
      `Unknown annotation field kind: ${activeField.kind}.`
    );
  }

  function handleAnnotationStep(stepEvent) {
    requireAnnotationStepEvent(stepEvent);
    if (stepEvent.cancelled) {
      selectionState.annotationCandidateSet = null;
      selectionState.annotationStepCount = 0;
      selectionState.annotationHistory = [];
      selectionState.annotationRedoStack = [];
      updateAnnotationUI(null);
      state.clearPreviewHighlight();
      return;
    }

    hideRangeLabel();

    const activeField = state.getActiveField();
    if (activeField === null) {
      throw new Error(
        'Annotation selection requires an active categorical or continuous field.'
      );
    }

    const viewTransparency = viewer.getViewTransparency(stepEvent.viewId);
    const mode = stepEvent.mode;
    const newCellIndices = computeAnnotationCellIndices(stepEvent, viewTransparency);

    if (newCellIndices.length === 0 && mode !== 'subtract') {
      return;
    }

    selectionState.annotationHistory.push({
      candidates: selectionState.annotationCandidateSet ? new Set(selectionState.annotationCandidateSet) : null,
      step: selectionState.annotationStepCount
    });
    if (selectionState.annotationHistory.length > MAX_HISTORY_STEPS) {
      selectionState.annotationHistory.shift();
    }
    selectionState.annotationRedoStack = [];

    const newSet = new Set(newCellIndices);
    let effectiveMode = mode;

    if (activeField.kind === 'category') {
      if (mode === 'intersect') {
        selectionState.annotationCandidateSet = new Set(newCellIndices);
        effectiveMode = 'replace';
      } else if (mode === 'union') {
        if (selectionState.annotationCandidateSet === null) {
          selectionState.annotationCandidateSet = new Set(newCellIndices);
        } else {
          for (const idx of newCellIndices) {
            selectionState.annotationCandidateSet.add(idx);
          }
        }
      } else if (mode === 'subtract') {
        if (selectionState.annotationCandidateSet !== null) {
          for (const idx of newCellIndices) {
            selectionState.annotationCandidateSet.delete(idx);
          }
        }
      }
    } else {
      if (selectionState.annotationCandidateSet === null) {
        if (mode !== 'subtract') {
          selectionState.annotationCandidateSet = new Set(newCellIndices);
        }
      } else if (mode === 'union') {
        for (const idx of newCellIndices) {
          selectionState.annotationCandidateSet.add(idx);
        }
      } else if (mode === 'subtract') {
        for (const idx of newCellIndices) {
          selectionState.annotationCandidateSet.delete(idx);
        }
      } else {
        selectionState.annotationCandidateSet = new Set(
          [...selectionState.annotationCandidateSet].filter((idx) => newSet.has(idx))
        );
      }
    }

    if (selectionState.annotationCandidateSet) {
      selectionState.annotationStepCount += 1;

      viewer.restoreUnifiedState([...selectionState.annotationCandidateSet], selectionState.annotationStepCount);

      updateAnnotationUI({
        step: selectionState.annotationStepCount,
        candidateCount: selectionState.annotationCandidateSet.size,
        mode: effectiveMode
      });

      if (selectionState.annotationCandidateSet.size > 0) {
        state.setPreviewHighlightFromIndices([...selectionState.annotationCandidateSet]);
      } else {
        state.clearPreviewHighlight();
      }
    }
  }

  function handleAnnotationConfirm() {
    if (!selectionState.annotationCandidateSet || selectionState.annotationCandidateSet.size === 0) {
      debug.log('[UI] Annotation selection empty');
      selectionState.annotationCandidateSet = null;
      selectionState.annotationStepCount = 0;
      selectionState.annotationHistory = [];
      selectionState.annotationRedoStack = [];
      updateAnnotationUI(null);
      return;
    }

    const cellIndices = [...selectionState.annotationCandidateSet];
    const stepsLabel = selectionState.annotationStepCount > 1 ? ` (${selectionState.annotationStepCount} steps)` : '';

    const savedGroup = state.addHighlightDirect({
      type: 'annotation',
      label: `Annotation${stepsLabel} (${cellIndices.length.toLocaleString()} cells)`,
      cellIndices
    });
    requireSavedHighlightGroup(
      savedGroup,
      'annotation',
      cellIndices.length,
      'Saved annotation highlight group'
    );

    void deliverSelectionToJupyter({
      jupyterSource,
      cellIndices,
      source: 'annotation',
      onFailure: error => showSelectionDeliveryFailure(error, 'annotation')
    });

    debug.log(`[UI] Annotation selected ${cellIndices.length} cells from ${selectionState.annotationStepCount} step(s)`);

    selectionState.annotationCandidateSet = null;
    selectionState.annotationStepCount = 0;
    selectionState.annotationHistory = [];
    selectionState.annotationRedoStack = [];
    updateAnnotationUI(null);

    state.clearPreviewHighlight();
    viewer.confirmAnnotationSelection();
  }

  function handleAnnotationUndo() {
    if (selectionState.annotationHistory.length === 0) return;

    const prevState =
      selectionState.annotationHistory[selectionState.annotationHistory.length - 1];
    const restoredCandidates = prevState.candidates === null
      ? []
      : [...prevState.candidates];
    viewer.restoreUnifiedState(
      restoredCandidates,
      restoredCandidates.length === 0 ? 0 : prevState.step
    );

    selectionState.annotationRedoStack.push({
      candidates: selectionState.annotationCandidateSet ? new Set(selectionState.annotationCandidateSet) : null,
      step: selectionState.annotationStepCount
    });

    selectionState.annotationHistory.pop();
    selectionState.annotationCandidateSet = prevState.candidates;
    selectionState.annotationStepCount = prevState.step;

    if (selectionState.annotationCandidateSet && selectionState.annotationCandidateSet.size > 0) {
      updateAnnotationUI({
        step: selectionState.annotationStepCount,
        candidateCount: selectionState.annotationCandidateSet.size,
        restored: true
      });
      state.setPreviewHighlightFromIndices([...selectionState.annotationCandidateSet]);
    } else {
      updateAnnotationUI({
        step: 0,
        candidateCount: 0,
        keepControls: true
      });
      state.clearPreviewHighlight();
    }
  }

  function handleAnnotationRedo() {
    if (selectionState.annotationRedoStack.length === 0) return;

    const redoState =
      selectionState.annotationRedoStack[selectionState.annotationRedoStack.length - 1];
    const restoredCandidates = redoState.candidates === null
      ? []
      : [...redoState.candidates];
    viewer.restoreUnifiedState(
      restoredCandidates,
      restoredCandidates.length === 0 ? 0 : redoState.step
    );

    selectionState.annotationHistory.push({
      candidates: selectionState.annotationCandidateSet ? new Set(selectionState.annotationCandidateSet) : null,
      step: selectionState.annotationStepCount
    });

    selectionState.annotationRedoStack.pop();
    selectionState.annotationCandidateSet = redoState.candidates;
    selectionState.annotationStepCount = redoState.step;

    if (selectionState.annotationCandidateSet && selectionState.annotationCandidateSet.size > 0) {
      updateAnnotationUI({
        step: selectionState.annotationStepCount,
        candidateCount: selectionState.annotationCandidateSet.size,
        restored: true
      });
      state.setPreviewHighlightFromIndices([...selectionState.annotationCandidateSet]);
    } else {
      updateAnnotationUI({
        step: 0,
        candidateCount: 0,
        keepControls: true
      });
      state.clearPreviewHighlight();
    }
  }

  function getAnnotationControls() {
    let controls = documentOwner.getElementById('annotation-step-controls');
    const created = controls === null;
    if (created) {
      controls = documentOwner.createElement('div');
      controls.id = 'annotation-step-controls';
      controls.className = 'lasso-step-controls';
      controls.innerHTML = `
        <button type="button" class="btn-small lasso-confirm" id="annotation-confirm-btn">Confirm</button>
        <button type="button" class="btn-small btn-undo" id="annotation-undo-btn" title="Undo">↩</button>
        <button type="button" class="btn-small btn-redo" id="annotation-redo-btn" title="Redo">↪</button>
        <button type="button" class="btn-small lasso-cancel" id="annotation-cancel-btn">Cancel</button>
      `;
      highlightModeDescriptionEl.parentElement.appendChild(controls);
    }
    const undoButton = requireDomElement(
      documentOwner.getElementById('annotation-undo-btn'),
      'Annotation undo button',
      ['addEventListener']
    );
    const redoButton = requireDomElement(
      documentOwner.getElementById('annotation-redo-btn'),
      'Annotation redo button',
      ['addEventListener']
    );
    const confirmButton = requireDomElement(
      documentOwner.getElementById('annotation-confirm-btn'),
      'Annotation confirm button',
      ['addEventListener']
    );
    const cancelButton = requireDomElement(
      documentOwner.getElementById('annotation-cancel-btn'),
      'Annotation cancel button',
      ['addEventListener']
    );
    if (created) {
      undoButton.addEventListener('click', handleAnnotationUndo);
      redoButton.addEventListener('click', handleAnnotationRedo);
      confirmButton.addEventListener('click', handleAnnotationConfirm);
      cancelButton.addEventListener('click', () => {
        viewer.cancelAnnotationSelection();
      });
    }
    return { undoButton, redoButton, confirmButton };
  }

  function updateAnnotationUI(stepEvent) {
    const activeField = state.getActiveField();
    const isCategorical =
      activeField !== null && activeField.kind === 'category';

    if (!stepEvent || (stepEvent.step === 0 && !stepEvent.keepControls)) {
      highlightModeDescriptionEl.innerHTML = HIGHLIGHT_MODE_COPY.annotation;
      const existingControls = documentOwner.getElementById('annotation-step-controls');
      if (existingControls) existingControls.remove();
      return;
    }

    if (stepEvent.step === 0 && stepEvent.keepControls) {
      const helpText = isCategorical
        ? 'Alt to replace, Shift+Alt to add, Ctrl+Alt to subtract'
        : 'Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract';
      const stepInfo = `<strong>No selection</strong><br><small>${helpText}</small>`;

      const {
        undoButton,
        redoButton,
        confirmButton
      } = getAnnotationControls();
      undoButton.disabled = selectionState.annotationHistory.length === 0;
      redoButton.disabled = selectionState.annotationRedoStack.length === 0;
      confirmButton.disabled = true;

      highlightModeDescriptionEl.innerHTML = stepInfo;
      return;
    }

    let modeLabel = '';
    if (stepEvent.restored === true) {
      modeLabel = ' <span class="lasso-mode-tag intersect">current selection</span>';
    } else if (stepEvent.mode === 'union') {
      modeLabel = ' <span class="lasso-mode-tag union">+added</span>';
    } else if (stepEvent.mode === 'subtract') {
      modeLabel = ' <span class="lasso-mode-tag subtract">−removed</span>';
    } else if (stepEvent.mode === 'replace') {
      if (stepEvent.step > 1) {
        modeLabel = ' <span class="lasso-mode-tag intersect">replaced</span>';
      }
    } else if (stepEvent.step > 1) {
      modeLabel = ' <span class="lasso-mode-tag intersect">intersected</span>';
    }

    const helpText = isCategorical
      ? 'Alt to replace, Shift+Alt to add, Ctrl+Alt to subtract'
      : 'Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract';

    const stepInfo = `<strong>Step ${stepEvent.step}:</strong> ${stepEvent.candidateCount.toLocaleString()} cells${modeLabel}<br><small>${helpText}</small>`;

    const {
      undoButton,
      redoButton,
      confirmButton
    } = getAnnotationControls();
    undoButton.disabled = selectionState.annotationHistory.length === 0;
    redoButton.disabled = selectionState.annotationRedoStack.length === 0;
    confirmButton.disabled = stepEvent.candidateCount === 0;

    highlightModeDescriptionEl.innerHTML = stepInfo;
  }

  function restoreAnnotationSelection(unifiedState) {
    requireUnifiedSelectionState(unifiedState);
    selectionState.annotationHistory = [];
    selectionState.annotationRedoStack = [];
    selectionState.annotationCandidateSet = unifiedState.inProgress
      ? new Set(unifiedState.candidates)
      : null;
    selectionState.annotationStepCount = unifiedState.stepCount;
    if (!unifiedState.inProgress) {
      updateAnnotationUI(null);
      state.clearPreviewHighlight();
      return;
    }
    updateAnnotationUI({
      step: unifiedState.stepCount,
      candidateCount: unifiedState.candidateCount,
      restored: true
    });
    if (unifiedState.candidateCount === 0) {
      state.clearPreviewHighlight();
    } else {
      state.setPreviewHighlightFromIndices(unifiedState.candidates);
    }
  }

  viewer.setSelectionStepCallback(handleAnnotationStep);

  return { handleAnnotationStep, restoreAnnotationSelection };
}
