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
export function initAnnotationSelection({ state, viewer, jupyterSource = null, selectionState, ui }) {
  const highlightModeDescriptionEl = ui?.modeDescriptionEl || null;
  const hideRangeLabel = ui?.hideRangeLabel || (() => {});

  function computeAnnotationCellIndices(selectionEvent, viewTransparency = null) {
    const activeField = state.getActiveField();
    if (!activeField) return [];

    const cellIndex = selectionEvent.cellIndex;
    const fieldIndex = state.activeFieldSource === 'var' ? state.activeVarFieldIndex : state.activeFieldIndex;
    const source = state.activeFieldSource || 'obs';

    if (activeField.kind === 'category') {
      const categoryIndex = state.getCategoryForCell(cellIndex, fieldIndex, source);
      if (categoryIndex < 0) return [];
      return state.getCellIndicesForCategory(fieldIndex, categoryIndex, source, viewTransparency);
    }

    if (activeField.kind === 'continuous') {
      const clickedValue = state.getValueForCell(cellIndex, fieldIndex, source);
      if (clickedValue == null) return [];

      const stats = activeField._continuousStats || { min: 0, max: 1 };
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

    return [];
  }

  function handleAnnotationStep(stepEvent) {
    if (stepEvent.cancelled) {
      selectionState.annotationCandidateSet = null;
      selectionState.annotationStepCount = 0;
      selectionState.annotationHistory = [];
      selectionState.annotationRedoStack = [];
      updateAnnotationUI(null);
      state.clearPreviewHighlight?.();
      return;
    }

    hideRangeLabel();

    const activeField = state.getActiveField();
    if (!activeField) {
      debug.log('[UI] No active field for annotation selection');
      return;
    }

    const viewTransparency = viewer.getViewTransparency?.(stepEvent.viewId) ?? null;
    const mode = stepEvent.mode || 'intersect';
    const newCellIndices = computeAnnotationCellIndices(stepEvent, viewTransparency);

    selectionState.annotationHistory.push({
      candidates: selectionState.annotationCandidateSet ? new Set(selectionState.annotationCandidateSet) : null,
      step: selectionState.annotationStepCount
    });
    if (selectionState.annotationHistory.length > MAX_HISTORY_STEPS) {
      selectionState.annotationHistory.shift();
    }
    selectionState.annotationRedoStack = [];

    if (newCellIndices.length === 0 && mode !== 'subtract') {
      return;
    }

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

      viewer.restoreUnifiedState?.([...selectionState.annotationCandidateSet], selectionState.annotationStepCount);

      updateAnnotationUI({
        step: selectionState.annotationStepCount,
        candidateCount: selectionState.annotationCandidateSet.size,
        mode: effectiveMode
      });

      if (selectionState.annotationCandidateSet.size > 0) {
        state.setPreviewHighlightFromIndices?.([...selectionState.annotationCandidateSet]);
      } else {
        state.clearPreviewHighlight?.();
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

    state.addHighlightDirect({
      type: 'annotation',
      label: `Annotation${stepsLabel} (${cellIndices.length.toLocaleString()} cells)`,
      cellIndices
    });

    try {
      jupyterSource?.notifySelection?.(cellIndices, 'annotation');
    } catch {}

    debug.log(`[UI] Annotation selected ${cellIndices.length} cells from ${selectionState.annotationStepCount} step(s)`);

    selectionState.annotationCandidateSet = null;
    selectionState.annotationStepCount = 0;
    selectionState.annotationHistory = [];
    selectionState.annotationRedoStack = [];
    updateAnnotationUI(null);

    state.clearPreviewHighlight?.();
    viewer.confirmAnnotationSelection?.();
  }

  function handleAnnotationUndo() {
    if (selectionState.annotationHistory.length === 0) return;

    selectionState.annotationRedoStack.push({
      candidates: selectionState.annotationCandidateSet ? new Set(selectionState.annotationCandidateSet) : null,
      step: selectionState.annotationStepCount
    });

    const prevState = selectionState.annotationHistory.pop();
    selectionState.annotationCandidateSet = prevState.candidates;
    selectionState.annotationStepCount = prevState.step;

    if (selectionState.annotationCandidateSet && selectionState.annotationCandidateSet.size > 0) {
      updateAnnotationUI({
        step: selectionState.annotationStepCount,
        candidateCount: selectionState.annotationCandidateSet.size,
        mode: 'intersect'
      });
      state.setPreviewHighlightFromIndices?.([...selectionState.annotationCandidateSet]);
    } else {
      updateAnnotationUI({
        step: 0,
        candidateCount: 0,
        mode: 'intersect',
        keepControls: true
      });
      state.clearPreviewHighlight?.();
    }
  }

  function handleAnnotationRedo() {
    if (selectionState.annotationRedoStack.length === 0) return;

    selectionState.annotationHistory.push({
      candidates: selectionState.annotationCandidateSet ? new Set(selectionState.annotationCandidateSet) : null,
      step: selectionState.annotationStepCount
    });

    const redoState = selectionState.annotationRedoStack.pop();
    selectionState.annotationCandidateSet = redoState.candidates;
    selectionState.annotationStepCount = redoState.step;

    if (selectionState.annotationCandidateSet && selectionState.annotationCandidateSet.size > 0) {
      updateAnnotationUI({
        step: selectionState.annotationStepCount,
        candidateCount: selectionState.annotationCandidateSet.size,
        mode: 'intersect'
      });
      state.setPreviewHighlightFromIndices?.([...selectionState.annotationCandidateSet]);
    } else {
      updateAnnotationUI({
        step: 0,
        candidateCount: 0,
        mode: 'intersect',
        keepControls: true
      });
      state.clearPreviewHighlight?.();
    }
  }

  function updateAnnotationUI(stepEvent) {
    if (!highlightModeDescriptionEl) return;

    const activeField = state.getActiveField();
    const isCategorical = activeField?.kind === 'category';

    if (!stepEvent || (stepEvent.step === 0 && !stepEvent.keepControls)) {
      highlightModeDescriptionEl.innerHTML = HIGHLIGHT_MODE_COPY.annotation;
      const existingControls = document.getElementById('annotation-step-controls');
      if (existingControls) existingControls.remove();
      return;
    }

    if (stepEvent.step === 0 && stepEvent.keepControls) {
      const helpText = isCategorical
        ? 'Alt to replace, Shift+Alt to add, Ctrl+Alt to subtract'
        : 'Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract';
      const stepInfo = `<strong>No selection</strong><br><small>${helpText}</small>`;

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
        highlightModeDescriptionEl.parentElement?.appendChild(controls);

        document.getElementById('annotation-undo-btn')?.addEventListener('click', () => handleAnnotationUndo());
        document.getElementById('annotation-redo-btn')?.addEventListener('click', () => handleAnnotationRedo());
        document.getElementById('annotation-confirm-btn')?.addEventListener('click', () => handleAnnotationConfirm());
        document.getElementById('annotation-cancel-btn')?.addEventListener('click', () => viewer.cancelAnnotationSelection?.());
      }

      const undoBtn = document.getElementById('annotation-undo-btn');
      const redoBtn = document.getElementById('annotation-redo-btn');
      const confirmBtn = document.getElementById('annotation-confirm-btn');
      if (undoBtn) undoBtn.disabled = selectionState.annotationHistory.length === 0;
      if (redoBtn) redoBtn.disabled = selectionState.annotationRedoStack.length === 0;
      if (confirmBtn) confirmBtn.disabled = true;

      highlightModeDescriptionEl.innerHTML = stepInfo;
      return;
    }

    let modeLabel = '';
    if (stepEvent.mode === 'union') {
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
      highlightModeDescriptionEl.parentElement?.appendChild(controls);

      document.getElementById('annotation-undo-btn')?.addEventListener('click', () => handleAnnotationUndo());
      document.getElementById('annotation-redo-btn')?.addEventListener('click', () => handleAnnotationRedo());
      document.getElementById('annotation-confirm-btn')?.addEventListener('click', () => handleAnnotationConfirm());
      document.getElementById('annotation-cancel-btn')?.addEventListener('click', () => viewer.cancelAnnotationSelection?.());
    }

    const undoBtn = document.getElementById('annotation-undo-btn');
    const redoBtn = document.getElementById('annotation-redo-btn');
    if (undoBtn) undoBtn.disabled = selectionState.annotationHistory.length === 0;
    if (redoBtn) redoBtn.disabled = selectionState.annotationRedoStack.length === 0;

    highlightModeDescriptionEl.innerHTML = stepInfo;
  }

  if (viewer.setSelectionStepCallback) {
    viewer.setSelectionStepCallback(handleAnnotationStep);
  }

  return { handleAnnotationStep };
}
