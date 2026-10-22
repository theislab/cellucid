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

import { CellSet } from '../../../utils/cell-set.js';
import { residencyBudgetBytes } from '../../../../data/memory-budget.js';

const HISTORY_KEYS = Object.freeze([
  'annotationHistory',
  'lassoHistory',
  'proximityHistory',
  'knnHistory'
]);

/**
 * Bytes one recorded step holds: a cell-index array costs a JavaScript number
 * per cell, a CellSet its bitmask words.
 *
 * @param {{ candidates: CellSet|number[]|null }} entry
 * @returns {number}
 */
function historyEntryBytes(entry) {
  const candidates = entry.candidates;
  if (candidates === null) return 0;
  if (candidates instanceof CellSet) return candidates.words.byteLength;
  if (Array.isArray(candidates)) return candidates.length * 8;
  throw new TypeError('Selection history candidates must be a CellSet, an array, or null.');
}

/**
 * Record one undo step. The history has no step limit: the oldest steps go
 * only when every tool's recorded steps together exceed the `undoHistory`
 * residency budget (a share of the device's memory), and never the step just
 * recorded.
 *
 * @param {ReturnType<typeof createHighlightSelectionState>} selectionState
 * @param {'annotationHistory'|'lassoHistory'|'proximityHistory'|'knnHistory'} key
 * @param {{ candidates: CellSet|number[]|null, step: number }} entry
 * @param {number} [budgetBytes]
 */
export function pushHistoryStep(
  selectionState,
  key,
  entry,
  budgetBytes = residencyBudgetBytes('undoHistory')
) {
  if (!HISTORY_KEYS.includes(key) || !Array.isArray(selectionState[key])) {
    throw new TypeError(`Unknown selection history '${String(key)}'.`);
  }
  selectionState[key].push(entry);
  // Keyed by the four tool names, not by cells.
  const toolBytes = {};
  let total = 0;
  for (const historyKey of HISTORY_KEYS) {
    toolBytes[historyKey] = selectionState[historyKey]
      .reduce((sum, recorded) => sum + historyEntryBytes(recorded), 0);
    total += toolBytes[historyKey];
  }
  // Evict the oldest step of whichever tool holds the most bytes, so one
  // tool's huge selections cannot erase another tool's short trail.
  while (total > budgetBytes) {
    let victimKey = null;
    for (const historyKey of HISTORY_KEYS) {
      const keepNewest = historyKey === key ? 1 : 0;
      if (selectionState[historyKey].length <= keepNewest) continue;
      if (victimKey === null || toolBytes[historyKey] > toolBytes[victimKey]) {
        victimKey = historyKey;
      }
    }
    if (victimKey === null) break;
    const evicted = historyEntryBytes(selectionState[victimKey].shift());
    toolBytes[victimKey] -= evicted;
    total -= evicted;
  }
}

/**
 * Would committing `next` leave the candidate set exactly as `current` is?
 *
 * A gesture that resolves to the cells already selected is not a step. Counting
 * it as one inflates the step number the panel reports and costs the user an
 * undo to reverse an action that did nothing.
 *
 * "No cells" is one state however it is spelled: a tool with no selection
 * (`null`) and a tool holding an empty candidate set are equally unchanged by a
 * gesture that selects nothing.
 *
 * @param {CellSet|number[]|null} current
 * @param {CellSet|number[]|null} next
 * @returns {boolean}
 */
export function selectionUnchanged(current, next) {
  const size = candidateCount(current, 'current');
  if (size !== candidateCount(next, 'next')) return false;
  if (size === 0) return true;
  // Equal sizes of unique cells: equal as sets exactly when equal sorted.
  // No JS Set (it refuses more than 2^24 entries).
  const a = sortedCells(current);
  const b = sortedCells(next);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function sortedCells(candidates) {
  if (candidates instanceof CellSet) return candidates.toUint32Array();
  return Float64Array.from(candidates).sort();
}

function candidateCount(candidates, label) {
  if (candidates === null) return 0;
  if (candidates instanceof CellSet) return candidates.size;
  if (Array.isArray(candidates)) return candidates.length;
  throw new TypeError(
    `Selection ${label} candidates must be a CellSet, an array, or null.`
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

