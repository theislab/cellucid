/**
 * @fileoverview Live preview for the annotation tool's Alt gesture.
 *
 * The viewer publishes a preview event on every pointer move between Alt+down
 * and release, for categorical and continuous fields alike. This module answers
 * each one with the candidate set that releasing right now would commit, so the
 * highlight updates while the gesture is still in the user's hand, and shows a
 * range label whenever the active field is continuous.
 *
 * @module ui/modules/highlight/continuous-selection-preview
 */

import {
  annotationGestureType,
  combineAnnotationCandidates,
  computeAnnotationGestureCells
} from './annotation-cells.js';
import {
  requireContinuousPreviewEvent,
  requireExactKeys,
  requireHighlightSelectionState,
  requireMethods
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
      'getCategoryForCell',
      'getCellIndicesForCategory',
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
  requireHighlightSelectionState(selectionState, state.pointCount);
  const { showRangeLabel, hideRangeLabel } = ui;
  let destroyed = false;

  function handleSelectionPreview(previewEvent) {
    if (destroyed) return;
    requireContinuousPreviewEvent(previewEvent, state.pointCount);
    const activeField = state.getActiveField();
    if (activeField === null) {
      throw new Error(
        'Annotation selection preview requires an active field.'
      );
    }

    const gestureType = annotationGestureType(previewEvent.dragDeltaY);
    const { cellIndices, range } = computeAnnotationGestureCells({
      state,
      activeField,
      cellIndex: previewEvent.cellIndex,
      gestureType,
      dragDeltaY: previewEvent.dragDeltaY,
      viewTransparency: viewer.getViewTransparency(previewEvent.viewId)
    });

    const { candidates } = combineAnnotationCandidates({
      candidates: selectionState.annotationCandidateSet,
      cellIndices,
      mode: previewEvent.mode,
      fieldKind: activeField.kind
    });
    const combinedIndices = candidates === null ? [] : [...candidates];

    if (combinedIndices.length > 0) {
      state.setPreviewHighlightFromIndices(combinedIndices);
    } else {
      state.clearPreviewHighlight();
    }

    if (range === null) {
      hideRangeLabel();
      return;
    }
    showRangeLabel(
      previewEvent.endX,
      previewEvent.endY,
      range.minVal,
      range.maxVal
    );
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
