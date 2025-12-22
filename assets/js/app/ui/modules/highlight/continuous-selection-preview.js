/**
 * @fileoverview Continuous selection range preview.
 *
 * While Alt-dragging on a continuous field, the viewer emits preview events
 * with the range being explored. This module mirrors the "combine modes"
 * behavior (intersect/union/subtract) against the current unified candidate
 * set and updates DataState's preview highlight.
 *
 * @module ui/modules/highlight/continuous-selection-preview
 */

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {ReturnType<import('./selection-state.js').createHighlightSelectionState>} options.selectionState
 * @param {object} options.ui
 * @param {(x: number, y: number, minVal: number, maxVal: number) => void} options.ui.showRangeLabel
 * @param {() => void} options.ui.hideRangeLabel
 */
export function initContinuousSelectionPreview({ state, viewer, selectionState, ui }) {
  const showRangeLabel = ui?.showRangeLabel || (() => {});
  const hideRangeLabel = ui?.hideRangeLabel || (() => {});

  function handleSelectionPreview(previewEvent) {
    const activeField = state.getActiveField ? state.getActiveField() : null;
    if (!activeField || activeField.kind !== 'continuous') {
      hideRangeLabel();
      return;
    }

    const fieldIndex = state.activeFieldSource === 'var' ? state.activeVarFieldIndex : state.activeFieldIndex;
    const source = state.activeFieldSource || 'obs';

    const cellIndex = previewEvent.cellIndex;
    const clickedValue = state.getValueForCell(cellIndex, fieldIndex, source);
    if (clickedValue == null) {
      hideRangeLabel();
      return;
    }

    const stats = activeField._continuousStats || { min: 0, max: 1 };
    const valueRange = stats.max - stats.min;
    const dragScale = 0.005;
    const dragAmount = -previewEvent.dragDeltaY * dragScale * valueRange;

    let minVal;
    let maxVal;
    if (dragAmount > 0) {
      minVal = clickedValue;
      maxVal = Math.min(stats.max, clickedValue + dragAmount);
    } else {
      minVal = Math.max(stats.min, clickedValue + dragAmount);
      maxVal = clickedValue;
    }

    const viewTransparency = viewer.getViewTransparency?.(previewEvent.viewId) ?? null;
    const newIndices = state.getCellIndicesForRange(fieldIndex, minVal, maxVal, source, viewTransparency);
    const mode = previewEvent.mode || 'intersect';

    let combinedIndices;
    const candidateSet = selectionState.annotationCandidateSet;

    if (candidateSet === null) {
      combinedIndices = mode === 'subtract' ? [] : newIndices;
    } else if (candidateSet.size === 0) {
      combinedIndices = mode === 'union' ? newIndices : [];
    } else if (mode === 'union') {
      const combined = new Set(candidateSet);
      for (const idx of newIndices) combined.add(idx);
      combinedIndices = [...combined];
    } else if (mode === 'subtract') {
      const newSet = new Set(newIndices);
      combinedIndices = [...candidateSet].filter((idx) => !newSet.has(idx));
    } else {
      const newSet = new Set(newIndices);
      combinedIndices = [...candidateSet].filter((idx) => newSet.has(idx));
    }

    if (state.setPreviewHighlightFromIndices && combinedIndices.length > 0) {
      state.setPreviewHighlightFromIndices(combinedIndices);
    } else {
      state.clearPreviewHighlight?.();
    }

    showRangeLabel(previewEvent.endX, previewEvent.endY, minVal, maxVal);
  }

  if (viewer.setSelectionPreviewCallback) {
    viewer.setSelectionPreviewCallback(handleSelectionPreview);
  }
}

