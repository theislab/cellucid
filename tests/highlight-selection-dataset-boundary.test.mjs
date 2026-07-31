import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { initHighlightSelectionTools }
  from '../assets/js/app/ui/modules/highlight/highlight-selection-tools.js';
import { initLassoSelection }
  from '../assets/js/app/ui/modules/highlight/lasso-selection.js';
import { createHighlightSelectionState }
  from '../assets/js/app/ui/modules/highlight/selection-state.js';
import {
  requireAnnotationStepEvent,
  requireCellIndices,
  requireCompletedSelectionEvent,
  requireContinuousPreviewEvent,
  requireHighlightGroup,
  requireSavedHighlightGroup,
  requireSelectionStepEvent,
  requireUnifiedSelectionState
} from '../assets/js/app/ui/modules/highlight/exact-contract.js';

const MAIN_SOURCE_URL = new URL(
  '../assets/js/app/main.js',
  import.meta.url
);

// ---------------------------------------------------------------------------
// main.js source ownership
// ---------------------------------------------------------------------------

function sliceSource(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.ok(start >= 0, `expected ${startNeedle} in main.js`);
  const end = source.indexOf(endNeedle, start);
  assert.ok(end > start, `expected ${endNeedle} after ${startNeedle}`);
  return source.slice(start, end);
}

/**
 * The exact viewer methods main.js invokes to retire an unconfirmed highlight
 * selection during dataset replacement. The behavioural fixture below replays
 * this list, so a replacement path that retires nothing produces the stale
 * cross-dataset selection instead of silently passing.
 */
function datasetReplacementRetirements(mainSource) {
  const retirement = sliceSource(
    mainSource,
    'function retireInProgressHighlightSelection',
    '\n    function '
  );
  const names = [
    ...retirement.matchAll(/viewer\.(\w+)\(\)/g)
  ].map(match => match[1]);
  assert.ok(
    names.length > 0,
    'dataset replacement must retire the in-progress highlight selection'
  );
  return names;
}

test(
  'every dataset runtime commit retires the in-progress highlight selection '
  + 'before publishing replacement geometry',
  async () => {
    const mainSource = await readFile(MAIN_SOURCE_URL, 'utf8');

    assert.deepEqual(
      datasetReplacementRetirements(mainSource),
      [
        'cancelAnnotationSelection',
        'cancelLassoSelection',
        'cancelProximitySelection',
        'cancelKnnSelection',
        'cancelUnifiedSelection'
      ]
    );

    const commits = [
      [
        'function publishEmptyDatasetRuntime',
        'async function stageDatasetRuntime',
        'state.initScene('
      ],
      [
        'function commitDatasetRuntimeStage',
        'function commitSyntheticRuntimeStage',
        'state.initScene('
      ],
      [
        'function commitSyntheticRuntimeStage',
        'function restoreRuntimeStage',
        'state.initSyntheticScene('
      ]
    ];
    for (const [startNeedle, endNeedle, sceneNeedle] of commits) {
      const commit = sliceSource(mainSource, startNeedle, endNeedle);
      const retireIndex = commit.indexOf(
        'retireInProgressHighlightSelection();'
      );
      const sceneIndex = commit.indexOf(sceneNeedle);
      assert.ok(
        retireIndex >= 0,
        `${startNeedle} must retire the in-progress highlight selection`
      );
      assert.ok(
        sceneIndex > retireIndex,
        `${startNeedle} must retire the selection before replacing geometry`
      );
    }
  }
);

// ---------------------------------------------------------------------------
// Unified-candidate renderer fixture
// ---------------------------------------------------------------------------

function createEventElement() {
  const listeners = new Map();
  return {
    children: [],
    dataset: {},
    style: {},
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
    appendChild(child) {
      this.children.push(child);
    },
    dispatch(name, event = {}) {
      for (const listener of [...(listeners.get(name) ?? [])]) {
        listener(event);
      }
    }
  };
}

function createModeButton(mode, pressed) {
  const attributes = new Map([
    ['aria-pressed', pressed ? 'true' : 'false']
  ]);
  const listeners = [];
  return {
    dataset: { mode },
    addEventListener(type, listener, options = {}) {
      if (type !== 'click') return;
      listeners.push(listener);
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          listeners.length = 0;
        }, { once: true });
      }
    },
    click() {
      for (const listener of [...listeners]) listener({ target: this });
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    }
  };
}

const STEP_CONTROL_BUTTON_IDS = Object.freeze({
  'lasso-step-controls': [
    'lasso-confirm-btn',
    'lasso-undo-btn',
    'lasso-redo-btn',
    'lasso-cancel-btn'
  ],
  'annotation-step-controls': [
    'annotation-confirm-btn',
    'annotation-undo-btn',
    'annotation-redo-btn',
    'annotation-cancel-btn'
  ],
  'proximity-step-controls': [
    'proximity-confirm-btn',
    'proximity-undo-btn',
    'proximity-redo-btn',
    'proximity-cancel-btn'
  ],
  'knn-step-controls': [
    'knn-confirm-btn',
    'knn-undo-btn',
    'knn-redo-btn',
    'knn-cancel-btn'
  ]
});

function createHighlightDom() {
  const elements = new Map();
  const documentStub = {
    addEventListener() {},
    body: {
      appendChild(element) {
        elements.set(element.id, element);
      }
    },
    createElement() {
      const element = createEventElement();
      element.remove = () => {
        elements.delete(element.id);
      };
      return element;
    },
    getElementById(id) {
      return elements.get(id) ?? null;
    }
  };
  const modeDescription = createEventElement();
  modeDescription.parentElement = {
    appendChild(controls) {
      elements.set(controls.id, controls);
      for (const buttonId of STEP_CONTROL_BUTTON_IDS[controls.id] ?? []) {
        const button = createEventElement();
        button.id = buttonId;
        elements.set(buttonId, button);
      }
    }
  };
  return { documentStub, modeDescription, elements };
}

function withDocument(documentStub, callback) {
  const previousDocument = globalThis.document;
  globalThis.document = documentStub;
  try {
    return callback();
  } finally {
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
  }
}

/**
 * Mirrors the renderer's unified candidate set (highlight-renderer.js): one
 * `_unifiedCandidateSet` and `_unifiedStepCount` shared by the lasso,
 * proximity, and KNN tools, cleared only on confirm, cancel, restore, and
 * destroy — never by `setData()`.
 */
function createUnifiedCandidateViewer() {
  const callbacks = new Map();
  const viewer = {
    _unifiedCandidateSet: null,
    _unifiedStepCount: 0,

    // Test driver: exactly the renderer's lasso combination step.
    completeLassoGesture(selectedIndices, mode) {
      const newSet = new Set(selectedIndices);
      if (viewer._unifiedCandidateSet === null) {
        if (mode !== 'subtract') {
          viewer._unifiedCandidateSet = new Set(selectedIndices);
        }
      } else if (mode === 'union') {
        for (const idx of selectedIndices) {
          viewer._unifiedCandidateSet.add(idx);
        }
      } else if (mode === 'subtract') {
        for (const idx of selectedIndices) {
          viewer._unifiedCandidateSet.delete(idx);
        }
      } else {
        viewer._unifiedCandidateSet = new Set(
          [...viewer._unifiedCandidateSet].filter(idx => newSet.has(idx))
        );
      }
      if (viewer._unifiedCandidateSet === null) return;
      viewer._unifiedStepCount += 1;
      callbacks.get('lassoStep')({
        step: viewer._unifiedStepCount,
        candidateCount: viewer._unifiedCandidateSet.size,
        candidates: [...viewer._unifiedCandidateSet],
        mode
      });
    },

    confirmLassoSelection() {
      if (
        viewer._unifiedCandidateSet !== null
        && viewer._unifiedCandidateSet.size > 0
      ) {
        const finalIndices = [...viewer._unifiedCandidateSet];
        callbacks.get('lasso')({
          type: 'lasso',
          cellIndices: finalIndices,
          cellCount: finalIndices.length,
          steps: viewer._unifiedStepCount
        });
      }
      viewer._unifiedCandidateSet = null;
      viewer._unifiedStepCount = 0;
    },

    cancelLassoSelection() {
      viewer._unifiedCandidateSet = null;
      viewer._unifiedStepCount = 0;
      callbacks.get('lassoStep')({
        step: 0,
        candidateCount: 0,
        candidates: [],
        cancelled: true
      });
    },
    cancelProximitySelection() {
      viewer._unifiedCandidateSet = null;
      viewer._unifiedStepCount = 0;
      callbacks.get('proximityStep')({
        step: 0,
        candidateCount: 0,
        candidates: [],
        cancelled: true
      });
    },
    cancelKnnSelection() {
      viewer._unifiedCandidateSet = null;
      viewer._unifiedStepCount = 0;
      callbacks.get('knnStep')({
        step: 0,
        candidateCount: 0,
        candidates: [],
        cancelled: true
      });
    },
    cancelAnnotationSelection() {
      callbacks.get('annotationStep')({
        cancelled: true,
        step: 0,
        candidateCount: 0
      });
    },
    cancelUnifiedSelection() {
      viewer._unifiedCandidateSet = null;
      viewer._unifiedStepCount = 0;
    },
    confirmAnnotationSelection() {},
    confirmKnnSelection() {},
    confirmProximitySelection() {},
    getUnifiedSelectionState() {
      return {
        inProgress: viewer._unifiedCandidateSet !== null,
        stepCount: viewer._unifiedStepCount,
        candidateCount: viewer._unifiedCandidateSet === null
          ? 0
          : viewer._unifiedCandidateSet.size,
        candidates: viewer._unifiedCandidateSet === null
          ? []
          : [...viewer._unifiedCandidateSet]
      };
    },
    getViewTransparency() {
      return new Float32Array();
    },
    onLodChanged() {
      return () => {};
    },
    restoreKnnState() {},
    restoreLassoState(candidates, step) {
      viewer.restoreUnifiedState(candidates, step);
    },
    restoreProximityState() {},
    restoreUnifiedState(candidates, step) {
      if (candidates && candidates.length > 0) {
        viewer._unifiedCandidateSet = new Set(candidates);
        viewer._unifiedStepCount = step;
      } else {
        viewer._unifiedCandidateSet = null;
        viewer._unifiedStepCount = 0;
      }
    },
    setKnnEnabled() {},
    setLassoEnabled() {},
    setProximityEnabled() {},
    updateHighlight() {}
  };
  for (const [method, key] of [
    ['setKnnCallback', 'knn'],
    ['setKnnPreviewCallback', 'knnPreview'],
    ['setKnnStepCallback', 'knnStep'],
    ['setLassoCallback', 'lasso'],
    ['setLassoPreviewCallback', 'lassoPreview'],
    ['setLassoStepCallback', 'lassoStep'],
    ['setProximityCallback', 'proximity'],
    ['setProximityPreviewCallback', 'proximityPreview'],
    ['setProximityStepCallback', 'proximityStep'],
    ['setSelectionPreviewCallback', 'continuousPreview'],
    ['setSelectionStepCallback', 'annotationStep']
  ]) {
    viewer[method] = listener => {
      callbacks.set(key, listener);
    };
  }
  return viewer;
}

/**
 * Mirrors the DataState surface the highlight tools own, including
 * `addHighlightDirect`'s bounds check against the *current* point count.
 */
function createHighlightStateStub(pointCount) {
  let highlightIdCounter = 0;
  return {
    pointCount,
    savedGroups: [],
    previewIndices: null,
    addHighlightDirect({ type, label, cellIndices }) {
      for (const cellIndex of cellIndices) {
        if (
          !Number.isSafeInteger(cellIndex)
          || cellIndex < 0
          || cellIndex >= this.pointCount
        ) {
          throw new RangeError(
            'Direct highlight cell index is outside the current dataset.'
          );
        }
      }
      const group = {
        id: `highlight_${++highlightIdCounter}`,
        type,
        label,
        enabled: true,
        cellIndices: [...cellIndices],
        cellCount: cellIndices.length
      };
      this.savedGroups.push(group);
      return group;
    },
    clearPreviewHighlight() {
      this.previewIndices = null;
    },
    getActiveField() {
      return null;
    },
    getActiveViewId() {
      return 'live';
    },
    getCategoryForCell() {
      return 0;
    },
    getCellIndicesForCategory() {
      return [];
    },
    getCellIndicesForRange() {
      return [];
    },
    getHighlightedGroups() {
      return this.savedGroups;
    },
    getValueForCell() {
      return Number.NaN;
    },
    on() {
      return () => {};
    },
    setPreviewHighlightFromIndices(cellIndices) {
      this.previewIndices = [...cellIndices];
    }
  };
}

const DATASET_A_POINT_COUNT = 100_000;
const DATASET_B_POINT_COUNT = 5000;
// Every dataset-A row is inside dataset B's bounds, so `addHighlightDirect`'s
// range check cannot tell the two generations apart.
const DATASET_A_CANDIDATES = Object.freeze([1, 2, 3, 4000, 4001]);
const DATASET_B_CANDIDATES = Object.freeze([1, 2, 3, 4500]);

/**
 * Lasso step 1 on dataset A (never confirmed), dataset replacement, then one
 * lasso gesture on dataset B, confirmed.
 */
function runCrossDatasetLasso(retirements) {
  const { documentStub, modeDescription } = createHighlightDom();
  const viewer = createUnifiedCandidateViewer();
  const state = createHighlightStateStub(DATASET_A_POINT_COUNT);
  const buttons = [
    createModeButton('annotation', true),
    createModeButton('knn', false),
    createModeButton('proximity', false),
    createModeButton('lasso', false)
  ];

  return withDocument(documentStub, () => {
    const tools = initHighlightSelectionTools({
      state,
      viewer,
      jupyterSource: null,
      dom: { modeButtons: buttons, modeDescription },
      renderHighlightSummary() {},
      renderHighlightPages() {}
    });
    buttons[3].click();

    viewer.completeLassoGesture([...DATASET_A_CANDIDATES], 'intersect');
    assert.deepEqual(state.previewIndices, [...DATASET_A_CANDIDATES]);
    assert.deepEqual(
      tools.selectionState.lastLassoCandidates,
      [...DATASET_A_CANDIDATES]
    );

    for (const retirement of retirements) viewer[retirement]();
    state.pointCount = DATASET_B_POINT_COUNT;

    viewer.completeLassoGesture([...DATASET_B_CANDIDATES], 'intersect');
    viewer.confirmLassoSelection();
    return { state, viewer, selectionState: tools.selectionState };
  });
}

test(
  'an unretired lasso step from the previous dataset silently rewrites the '
  + 'next selection',
  () => {
    const { state } = runCrossDatasetLasso([]);

    // CEL-AUDIT-0026 exactly: the renderer intersects dataset-B hits with
    // dataset-A rows, every survivor is inside dataset B's bounds, and a
    // highlight group nobody selected is saved without a single rejection.
    assert.equal(state.savedGroups.length, 1);
    assert.deepEqual(state.savedGroups[0].cellIndices, [1, 2, 3]);
    assert.equal(state.savedGroups[0].label, 'Lasso (2 views) (3 cells)');
  }
);

test(
  'a lasso step started on the previous dataset cannot contribute to a '
  + 'selection on its replacement',
  async () => {
    const retirements = datasetReplacementRetirements(
      await readFile(MAIN_SOURCE_URL, 'utf8')
    );
    const { state, viewer, selectionState } =
      runCrossDatasetLasso(retirements);

    const fresh = createHighlightSelectionState();
    fresh.activeMode = selectionState.activeMode;
    assert.deepEqual(
      selectionState,
      fresh,
      'the confirmed selection must leave no dataset-A rows behind'
    );
    assert.equal(viewer._unifiedCandidateSet, null);
    assert.equal(viewer._unifiedStepCount, 0);

    assert.equal(state.savedGroups.length, 1);
    assert.deepEqual(
      state.savedGroups[0].cellIndices,
      [...DATASET_B_CANDIDATES],
      'the saved group must be exactly the cells lassoed on dataset B'
    );
    assert.equal(state.savedGroups[0].cellCount, 4);
    assert.equal(
      state.savedGroups[0].label,
      'Lasso (4 cells)',
      'a retired dataset-A step must not be counted as a second view'
    );
  }
);

test(
  'a completed selection carrying rows outside the current dataset is '
  + 'rejected before any highlight group is created',
  () => {
    const { documentStub, modeDescription } = createHighlightDom();
    const viewer = createUnifiedCandidateViewer();
    const state = createHighlightStateStub(5000);

    withDocument(documentStub, () => {
      initLassoSelection({
        state,
        viewer,
        jupyterSource: null,
        selectionState: createHighlightSelectionState(),
        ui: { modeDescriptionEl: modeDescription }
      });
      viewer.restoreUnifiedState([1, 2, 90_000], 1);
      assert.throws(
        () => viewer.confirmLassoSelection(),
        /lasso selection cellIndices must be inside the current dataset/i
      );
      assert.deepEqual(state.savedGroups, []);
    });
  }
);

test(
  'a saved highlight group that preserves the count but not the rows is '
  + 'rejected',
  () => {
    const { documentStub, modeDescription } = createHighlightDom();
    const viewer = createUnifiedCandidateViewer();
    const state = createHighlightStateStub(5000);
    // A defect that permutes, offsets, or substitutes indices while keeping
    // the length is exactly what a count-only round-trip check cannot see.
    state.addHighlightDirect = ({ type, label, cellIndices }) => {
      const group = {
        id: 'highlight_1',
        type,
        label,
        enabled: true,
        cellIndices: cellIndices.map(cellIndex => cellIndex + 1),
        cellCount: cellIndices.length
      };
      state.savedGroups.push(group);
      return group;
    };

    withDocument(documentStub, () => {
      initLassoSelection({
        state,
        viewer,
        jupyterSource: null,
        selectionState: createHighlightSelectionState(),
        ui: { modeDescriptionEl: modeDescription }
      });
      viewer.restoreUnifiedState([1, 2, 3], 1);
      assert.throws(
        () => viewer.confirmLassoSelection(),
        /saved lasso highlight group cellIndices must be exactly the completed selection/i
      );
    });
  }
);

// ---------------------------------------------------------------------------
// Exact-contract bounds
// ---------------------------------------------------------------------------

test('cell index contracts are bounded by the current dataset', () => {
  assert.throws(
    () => requireCellIndices([0, 1], 'Candidates', { allowEmpty: false }),
    /Candidates point count must be a safe integer of at least 0/
  );
  assert.throws(
    () => requireCellIndices(
      [0, 5],
      'Candidates',
      { allowEmpty: false, pointCount: 5 }
    ),
    /Candidates must be inside the current dataset of 5 cells/
  );
  assert.deepEqual(
    requireCellIndices(
      [0, 4],
      'Candidates',
      { allowEmpty: false, pointCount: 5 }
    ),
    [0, 4]
  );
  assert.throws(
    () => requireCellIndices([0], 'Candidates', {
      allowEmpty: true,
      pointCount: 0
    }),
    /Candidates must be inside the current dataset of 0 cells/
  );

  assert.throws(
    () => requireCompletedSelectionEvent({
      type: 'lasso',
      cellIndices: [0, 7],
      cellCount: 2,
      steps: 1
    }, 'lasso', 5),
    /lasso selection cellIndices must be inside the current dataset of 5 cells/
  );

  assert.throws(
    () => requireSelectionStepEvent({
      step: 1,
      candidateCount: 1,
      candidates: [9],
      mode: 'intersect'
    }, 'lasso', 5),
    /lasso step candidates must be inside the current dataset of 5 cells/
  );

  assert.throws(
    () => requireUnifiedSelectionState({
      inProgress: true,
      stepCount: 1,
      candidateCount: 1,
      candidates: [9]
    }, 5),
    /Unified highlight selection candidates must be inside the current dataset/
  );

  const pointerEvent = {
    type: 'click',
    cellIndex: 9,
    dragDeltaY: 0,
    startX: 0,
    startY: 0,
    endX: 0,
    endY: 0,
    mode: 'intersect',
    viewId: 'live'
  };
  assert.throws(
    () => requireAnnotationStepEvent(pointerEvent, 5),
    /Annotation step cellIndex must be inside the current dataset of 5 cells/
  );
  assert.throws(
    () => requireContinuousPreviewEvent(
      { ...pointerEvent, type: 'preview' },
      5
    ),
    /Continuous preview cellIndex must be inside the current dataset of 5 cells/
  );

  assert.throws(
    () => requireHighlightGroup({
      id: 'highlight_1',
      type: 'lasso',
      label: 'Lasso',
      enabled: true,
      cellIndices: [0, 9],
      cellCount: 2
    }, 'Highlight group', 5),
    /Highlight group cellIndices must be inside the current dataset of 5 cells/
  );
});

test(
  'the saved highlight round trip is verified by cell identity, not by count',
  () => {
    const label = 'Saved lasso highlight group';
    const savedGroup = {
      id: 'highlight_1',
      type: 'lasso',
      label: 'Lasso (3 cells)',
      enabled: true,
      cellIndices: [1, 2, 3],
      cellCount: 3
    };
    assert.equal(
      requireSavedHighlightGroup(savedGroup, 'lasso', [3, 1, 2], label, 5),
      savedGroup
    );
    assert.throws(
      () => requireSavedHighlightGroup(savedGroup, 'lasso', [1, 2, 4], label, 5),
      /cellIndices must be exactly the completed selection/
    );
    assert.throws(
      () => requireSavedHighlightGroup(savedGroup, 'lasso', [1, 2], label, 5),
      /cellCount must match the completed selection/
    );
    assert.throws(
      () => requireSavedHighlightGroup(
        savedGroup,
        'lasso',
        [1, 2, 3, 4],
        label,
        5
      ),
      /cellCount must match the completed selection/
    );
    assert.throws(
      () => requireSavedHighlightGroup(savedGroup, 'lasso', [1, 2, 3], label, 3),
      /cellIndices must be inside the current dataset of 3 cells/
    );
  }
);
