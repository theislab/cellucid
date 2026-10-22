import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHighlightSelectionState,
  pushHistoryStep,
} from '../assets/js/app/ui/modules/highlight/selection-state.js';
import { CellSet } from '../assets/js/app/utils/cell-set.js';

test('undo history has no step limit below its memory budget', () => {
  const state = createHighlightSelectionState();
  // Far past the former five-step cap, and the empty starting state stays.
  pushHistoryStep(state, 'lassoHistory', { candidates: null, step: 0 });
  for (let step = 1; step <= 500; step++) {
    pushHistoryStep(state, 'lassoHistory', { candidates: [step, step + 1], step });
  }
  assert.equal(state.lassoHistory.length, 501);
  assert.equal(state.lassoHistory[0].candidates, null);
});

test('undo history drops oldest steps only past the budget, never the newest', () => {
  const state = createHighlightSelectionState();
  const budget = 10 * 8; // ten cell indices
  for (let step = 0; step < 6; step++) {
    pushHistoryStep(
      state,
      'knnHistory',
      { candidates: [1, 2, 3, 4], step },
      budget,
    );
  }
  // Six steps of four cells are 192 bytes; two fit in 80.
  assert.deepEqual(state.knnHistory.map(({ step }) => step), [4, 5]);

  // A single step larger than the whole budget is still recorded.
  pushHistoryStep(
    state,
    'knnHistory',
    { candidates: Array.from({ length: 100 }, (_, i) => i), step: 6 },
    budget,
  );
  assert.deepEqual(state.knnHistory.map(({ step }) => step), [6]);
});

test('the largest tool history pays for another tool\'s new step', () => {
  const state = createHighlightSelectionState();
  const big = CellSet.from([0], 64 * 1024); // 8 KiB of bitmask words
  pushHistoryStep(state, 'annotationHistory', { candidates: big, step: 0 }, 1e9);
  pushHistoryStep(state, 'annotationHistory', { candidates: big.clone(), step: 1 }, 1e9);
  pushHistoryStep(state, 'lassoHistory', { candidates: [1], step: 0 }, 9 * 1024);
  assert.deepEqual(state.annotationHistory.map(({ step }) => step), [1]);
  assert.equal(state.lassoHistory.length, 1);
});

test('an unknown history name is refused', () => {
  assert.throws(
    () => pushHistoryStep(createHighlightSelectionState(), 'redo', { candidates: null, step: 0 }),
    /Unknown selection history/,
  );
});
