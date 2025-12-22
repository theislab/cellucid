/**
 * @fileoverview Shared highlight selection tool state.
 *
 * Highlight selection tools (annotation, lasso, proximity, KNN) maintain
 * per-tool undo/redo history and some cross-tool state (the unified candidate
 * set). Keeping this state in one object makes it easy to reset correctly when
 * switching tools without duplicating bookkeeping logic.
 *
 * @module ui/modules/highlight/selection-state
 */

export const MAX_HISTORY_STEPS = 5;

export function createHighlightSelectionState() {
  return {
    activeMode: 'annotation',

    // Annotation selection (Alt+click / Alt+drag)
    annotationCandidateSet: null,
    annotationStepCount: 0,
    annotationHistory: [],
    annotationRedoStack: [],

    // Lasso selection
    lassoHistory: [],
    lassoRedoStack: [],
    lastLassoCandidates: null,
    lastLassoStep: 0,

    // Proximity selection
    proximityHistory: [],
    proximityRedoStack: [],
    lastProximityCandidates: null,
    lastProximityStep: 0,

    // KNN selection
    knnHistory: [],
    knnRedoStack: [],
    lastKnnCandidates: null,
    lastKnnStep: 0
  };
}

