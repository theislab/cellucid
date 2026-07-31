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

/**
 * Would committing `next` leave the candidate set exactly as `current` is?
 *
 * A gesture that resolves to the cells already selected is not a step. Counting
 * it as one inflates the step number the panel reports, costs the user an undo
 * to reverse an action that did nothing, and — because the history is capped at
 * `MAX_HISTORY_STEPS` — can push the entry that holds the empty starting state
 * off the end, leaving undo unable to reach "nothing selected" at all.
 *
 * "No cells" is one state however it is spelled: a tool with no selection
 * (`null`) and a tool holding an empty candidate set are equally unchanged by a
 * gesture that selects nothing.
 *
 * @param {Set<number>|number[]|null} current
 * @param {Set<number>|number[]|null} next
 * @returns {boolean}
 */
export function selectionUnchanged(current, next) {
  const size = candidateCount(current, 'current');
  if (size !== candidateCount(next, 'next')) return false;
  if (size === 0) return true;
  const currentSet = current instanceof Set ? current : new Set(current);
  for (const cellIndex of next) {
    if (!currentSet.has(cellIndex)) return false;
  }
  return true;
}

function candidateCount(candidates, label) {
  if (candidates === null) return 0;
  if (candidates instanceof Set) return candidates.size;
  if (Array.isArray(candidates)) return candidates.length;
  throw new TypeError(
    `Selection ${label} candidates must be a Set, an array, or null.`
  );
}

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

