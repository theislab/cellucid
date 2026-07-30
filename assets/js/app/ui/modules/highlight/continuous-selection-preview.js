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

import {
  requireContinuousPreviewEvent,
  requireContinuousStatistics,
  requireExactKeys,
  requireFieldSource,
  requireHighlightSelectionState,
  requireMethods,
  requireSafeInteger
} from './exact-contract.js';

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {ReturnType<import('./selection-state.js').createHighlightSelectionState>} options.selectionState
 * @param {object} options.ui
 * @param {(x: number, y: number, minVal: number, maxVal: number) => void} options.ui.showRangeLabel
 * @param {() => void} options.ui.hideRangeLabel
 */
export function initContinuousSelectionPreview(options) {
  requireExactKeys(
    options,
    ['state', 'viewer', 'selectionState', 'ui'],
    'Continuous selection preview options'
  );
  const { state, viewer, selectionState, ui } = options;
  requireMethods(
    state,
    'Continuous selection preview state',
    [
      'clearPreviewHighlight',
      'getActiveField',
      'getCellIndicesForRange',
      'getValueForCell',
      'setPreviewHighlightFromIndices'
    ]
  );
  requireMethods(
    viewer,
    'Continuous selection preview viewer',
    ['getViewTransparency', 'setSelectionPreviewCallback']
  );
  requireExactKeys(
    ui,
    ['showRangeLabel', 'hideRangeLabel'],
    'Continuous selection preview UI'
  );
  requireMethods(
    ui,
    'Continuous selection preview UI',
    ['showRangeLabel', 'hideRangeLabel']
  );
  requireHighlightSelectionState(selectionState);
  const { showRangeLabel, hideRangeLabel } = ui;
  let destroyed = false;

  function handleSelectionPreview(previewEvent) {
    if (destroyed) return;
    requireContinuousPreviewEvent(previewEvent);
    const activeField = state.getActiveField();
    if (activeField === null || activeField.kind !== 'continuous') {
      throw new Error(
        'Continuous selection preview requires an active continuous field.'
      );
    }

    const source = requireFieldSource(state.activeFieldSource);
    const fieldIndex = source === 'var'
      ? state.activeVarFieldIndex
      : state.activeFieldIndex;
    requireSafeInteger(
      fieldIndex,
      'Continuous selection preview field index',
      0
    );

    const cellIndex = previewEvent.cellIndex;
    const clickedValue = state.getValueForCell(cellIndex, fieldIndex, source);
    if (Number.isNaN(clickedValue)) {
      hideRangeLabel();
      return;
    }
    if (!Number.isFinite(clickedValue)) {
      throw new TypeError(
        'Continuous selection preview clicked value must be finite or NaN.'
      );
    }

    const stats = requireContinuousStatistics(activeField);
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

    const viewTransparency = viewer.getViewTransparency(previewEvent.viewId);
    const newIndices = state.getCellIndicesForRange(fieldIndex, minVal, maxVal, source, viewTransparency);
    const mode = previewEvent.mode;

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

    if (combinedIndices.length > 0) {
      state.setPreviewHighlightFromIndices(combinedIndices);
    } else {
      state.clearPreviewHighlight();
    }

    showRangeLabel(previewEvent.endX, previewEvent.endY, minVal, maxVal);
  }

  viewer.setSelectionPreviewCallback(handleSelectionPreview);

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      const failures = [];
      for (const cleanup of [
        () => viewer.setSelectionPreviewCallback(() => {}),
        hideRangeLabel
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
          'Continuous selection preview failed to release every owned resource.'
        );
      }
    }
  };
}
