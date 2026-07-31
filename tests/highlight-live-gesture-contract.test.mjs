import assert from 'node:assert/strict';
import test from 'node:test';

import { initAnnotationSelection } from '../assets/js/app/ui/modules/highlight/annotation-selection.js';
import { initContinuousSelectionPreview } from '../assets/js/app/ui/modules/highlight/continuous-selection-preview.js';
import { initLassoSelection } from '../assets/js/app/ui/modules/highlight/lasso-selection.js';
import { initProximitySelection } from '../assets/js/app/ui/modules/highlight/proximity-selection.js';
import { createHighlightSelectionState } from '../assets/js/app/ui/modules/highlight/selection-state.js';
import {
  ANNOTATION_RANGE_DRAG_THRESHOLD_PX,
  annotationGestureType
} from '../assets/js/app/ui/modules/highlight/annotation-cells.js';

const CATEGORY_CODES = Uint8Array.from([0, 0, 1, 1, 2, 2]);
const CATEGORY_FIELD = Object.freeze({
  kind: 'category',
  codes: CATEGORY_CODES,
  categories: ['A', 'B', 'C']
});
// 6.3 sits inside the symmetric window a click commits around cell 3's value
// of 6 and outside the downward window a small drag would explore, so the two
// gestures cannot be confused with one another.
const CONTINUOUS_VALUES = Float32Array.from([0, 2, 4, 6, 6.3, 10]);
const CONTINUOUS_FIELD = Object.freeze({
  kind: 'continuous',
  _continuousStats: { min: 0, max: 10 }
});

function createElementStub(id) {
  const listeners = new Map();
  const element = {
    id,
    className: '',
    disabled: false,
    innerHTML: '',
    style: {},
    dataset: {},
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    remove() {
      element.removed = true;
    },
    removed: false
  };
  return element;
}

/**
 * The step controls are created lazily by innerHTML, so the document stub has
 * to mint every button the tools look up by id.
 */
function createDocumentStub() {
  const elements = new Map();
  const controlIds = new Map([
    ['annotation-step-controls', [
      'annotation-confirm-btn',
      'annotation-undo-btn',
      'annotation-redo-btn',
      'annotation-cancel-btn'
    ]],
    ['lasso-step-controls', [
      'lasso-confirm-btn',
      'lasso-undo-btn',
      'lasso-redo-btn',
      'lasso-cancel-btn'
    ]],
    ['proximity-step-controls', [
      'proximity-confirm-btn',
      'proximity-undo-btn',
      'proximity-redo-btn',
      'proximity-cancel-btn'
    ]]
  ]);
  const parent = {
    appendChild(element) {
      elements.set(element.id, element);
      for (const buttonId of controlIds.get(element.id) ?? []) {
        elements.set(buttonId, createElementStub(buttonId));
      }
    }
  };
  return {
    parent,
    elements,
    document: {
      createElement() {
        const element = createElementStub('');
        element.remove = () => {
          elements.delete(element.id);
        };
        return element;
      },
      getElementById(id) {
        return elements.get(id) ?? null;
      }
    }
  };
}

function withDocument(documentStub, callback) {
  const previous = globalThis.document;
  globalThis.document = documentStub;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

function createState(field) {
  const previews = [];
  const stateListeners = new Map();
  return {
    previews,
    state: {
      pointCount: CATEGORY_CODES.length,
      activeFieldIndex: 0,
      activeFieldSource: 'obs',
      activeVarFieldIndex: -1,
      addHighlightDirect({ type, label, cellIndices }) {
        return {
          id: 'highlight_1',
          type,
          label,
          enabled: true,
          cellIndices: [...cellIndices],
          cellCount: cellIndices.length
        };
      },
      clearPreviewHighlight() {
        previews.push('clear');
      },
      getActiveField() {
        return field;
      },
      getCategoryForCell(cellIndex) {
        return CATEGORY_CODES[cellIndex];
      },
      getCellIndicesForCategory(_fieldIndex, categoryIndex) {
        const indices = [];
        for (let cell = 0; cell < CATEGORY_CODES.length; cell++) {
          if (CATEGORY_CODES[cell] === categoryIndex) indices.push(cell);
        }
        return indices;
      },
      getCellIndicesForRange(_fieldIndex, minVal, maxVal) {
        const indices = [];
        for (let cell = 0; cell < CONTINUOUS_VALUES.length; cell++) {
          const value = CONTINUOUS_VALUES[cell];
          if (value >= minVal && value <= maxVal) indices.push(cell);
        }
        return indices;
      },
      getValueForCell(cellIndex) {
        return CONTINUOUS_VALUES[cellIndex];
      },
      on(eventName, listener) {
        if (!stateListeners.has(eventName)) stateListeners.set(eventName, []);
        stateListeners.get(eventName).push(listener);
        return () => {
          stateListeners.set(
            eventName,
            (stateListeners.get(eventName) ?? [])
              .filter(candidate => candidate !== listener)
          );
        };
      },
      setPreviewHighlightFromIndices(indices) {
        previews.push([...indices].sort((left, right) => left - right));
      }
    },
    stateListeners,
    emit(eventName) {
      for (const listener of [...(stateListeners.get(eventName) ?? [])]) {
        listener();
      }
    }
  };
}

function createViewer() {
  const restoreCalls = [];
  return {
    restoreCalls,
    viewer: {
      cancelAnnotationSelection() {},
      confirmAnnotationSelection() {},
      getViewTransparency() {
        return Float32Array.from(CATEGORY_CODES).fill(1);
      },
      restoreUnifiedState(candidates, step) {
        restoreCalls.push({ candidates: [...candidates], step });
      },
      setSelectionPreviewCallback(callback) {
        this.previewCallback = callback;
      },
      setSelectionStepCallback(callback) {
        this.stepCallback = callback;
      },
      previewCallback: null,
      stepCallback: null
    }
  };
}

function gesture(overrides) {
  return {
    cellIndex: 0,
    dragDeltaY: 0,
    startX: 10,
    startY: 10,
    endX: 10,
    endY: 10,
    mode: 'intersect',
    viewId: 'live',
    ...overrides
  };
}

/** The in-flight event the renderer publishes on every pointer move. */
function previewEvent(overrides) {
  return gesture({ ...overrides, type: 'preview' });
}

/** The committed event the renderer publishes on release. */
function stepEvent(overrides) {
  return gesture({ type: 'click', ...overrides });
}

/**
 * Build one annotation tool plus its drag preview over one shared selection
 * state, exactly the way `highlight-selection-tools.js` composes them.
 */
function buildAnnotationTool(field) {
  const documentOwner = createDocumentStub();
  const { state, previews } = createState(field);
  const { viewer, restoreCalls } = createViewer();
  const selectionState = createHighlightSelectionState();
  const modeDescriptionEl = createElementStub('highlight-mode-description');
  modeDescriptionEl.parentElement = documentOwner.parent;
  const rangeLabels = [];

  const built = withDocument(documentOwner.document, () => {
    const annotation = initAnnotationSelection({
      state,
      viewer,
      jupyterSource: null,
      selectionState,
      ui: { modeDescriptionEl, hideRangeLabel() { rangeLabels.push(null); } }
    });
    const preview = initContinuousSelectionPreview({
      state,
      viewer,
      selectionState,
      ui: {
        hideRangeLabel() { rangeLabels.push(null); },
        showRangeLabel(_x, _y, minVal, maxVal) {
          rangeLabels.push({ minVal, maxVal });
        }
      }
    });
    return { annotation, preview };
  });

  return {
    ...built,
    documentOwner,
    previews,
    rangeLabels,
    restoreCalls,
    selectionState,
    state,
    viewer,
    run(callback) {
      return withDocument(documentOwner.document, callback);
    }
  };
}

test('an in-flight categorical Alt gesture previews instead of throwing', () => {
  const tool = buildAnnotationTool(CATEGORY_FIELD);

  tool.run(() => {
    tool.viewer.previewCallback(previewEvent({ cellIndex: 2, dragDeltaY: -4 }));
  });

  assert.deepEqual(
    tool.previews,
    [[2, 3]],
    'a categorical drag must publish the category it is over, not throw'
  );
  assert.deepEqual(
    tool.rangeLabels,
    [null],
    'a categorical gesture has no value range to label'
  );
});

test('the categorical preview is exactly what releasing commits', () => {
  for (const mode of ['intersect', 'union', 'subtract']) {
    const previewTool = buildAnnotationTool(CATEGORY_FIELD);
    const commitTool = buildAnnotationTool(CATEGORY_FIELD);

    // Both tools start from the same one-step selection of category A.
    for (const tool of [previewTool, commitTool]) {
      tool.run(() => {
        tool.annotation.handleAnnotationStep(
          stepEvent({ cellIndex: 0, mode: 'intersect' })
        );
      });
    }

    previewTool.previews.length = 0;
    commitTool.previews.length = 0;

    previewTool.run(() => {
      previewTool.viewer.previewCallback(
        previewEvent({ cellIndex: 2, dragDeltaY: -3, mode })
      );
    });
    commitTool.run(() => {
      commitTool.annotation.handleAnnotationStep(
        stepEvent({ cellIndex: 2, mode })
      );
    });

    assert.deepEqual(
      previewTool.previews,
      commitTool.previews,
      `the ${mode} preview must match the ${mode} commit`
    );
  }
});

test('a continuous preview under the drag threshold matches the click it commits', () => {
  const previewTool = buildAnnotationTool(CONTINUOUS_FIELD);
  const commitTool = buildAnnotationTool(CONTINUOUS_FIELD);

  const dragDeltaY = ANNOTATION_RANGE_DRAG_THRESHOLD_PX;
  assert.equal(annotationGestureType(dragDeltaY), 'click');

  previewTool.run(() => {
    previewTool.viewer.previewCallback(previewEvent({ cellIndex: 3, dragDeltaY }));
  });
  commitTool.run(() => {
    commitTool.annotation.handleAnnotationStep(
      stepEvent({ cellIndex: 3, dragDeltaY })
    );
  });

  assert.deepEqual(
    previewTool.previews,
    commitTool.previews,
    'a sub-threshold drag must preview the click window it will commit'
  );
});

test('a continuous preview past the drag threshold matches the range it commits', () => {
  const previewTool = buildAnnotationTool(CONTINUOUS_FIELD);
  const commitTool = buildAnnotationTool(CONTINUOUS_FIELD);

  const dragDeltaY = -(ANNOTATION_RANGE_DRAG_THRESHOLD_PX + 200);
  assert.equal(annotationGestureType(dragDeltaY), 'range');

  previewTool.run(() => {
    previewTool.viewer.previewCallback(previewEvent({ cellIndex: 1, dragDeltaY }));
  });
  commitTool.run(() => {
    commitTool.annotation.handleAnnotationStep(
      stepEvent({ type: 'range', cellIndex: 1, dragDeltaY })
    );
  });

  assert.deepEqual(
    previewTool.previews,
    commitTool.previews,
    'a past-threshold drag must preview the range it will commit'
  );
  assert.deepEqual(
    previewTool.rangeLabels.at(-1),
    { minVal: 2, maxVal: 10 },
    'a continuous range gesture must still publish its value label'
  );
});

test('the annotation preview requires an active field, not a continuous one', () => {
  const tool = buildAnnotationTool(null);
  assert.throws(
    () => tool.run(() => {
      tool.viewer.previewCallback(previewEvent({ cellIndex: 0 }));
    }),
    /requires an active field/i
  );
});

test('the lasso preview contract demands the combined-set payload', () => {
  const documentOwner = createDocumentStub();
  const { state, previews } = createState(CATEGORY_FIELD);
  const modeDescriptionEl = createElementStub('highlight-mode-description');
  modeDescriptionEl.parentElement = documentOwner.parent;
  let previewCallback = null;
  const viewer = {
    cancelLassoSelection() {},
    confirmLassoSelection() {},
    restoreLassoState() {},
    setLassoCallback() {},
    setLassoPreviewCallback(callback) {
      previewCallback = callback;
    },
    setLassoStepCallback() {}
  };

  withDocument(documentOwner.document, () => {
    initLassoSelection({
      state,
      viewer,
      jupyterSource: null,
      selectionState: createHighlightSelectionState(),
      ui: { modeDescriptionEl }
    });
  });

  const polygon = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 }
  ];

  assert.throws(
    () => previewCallback({
      type: 'lasso-preview',
      cellIndices: [0, 1],
      cellCount: 2,
      polygon
    }),
    /lasso preview event must contain exactly/i,
    'a raw-hits payload without mode and newCellCount must be refused'
  );

  previewCallback({
    type: 'lasso-preview',
    cellIndices: [0, 1, 2],
    cellCount: 3,
    newCellCount: 2,
    mode: 'union',
    polygon
  });
  assert.deepEqual(
    previews,
    [[0, 1, 2]],
    'the lasso preview must publish the combined set it is handed'
  );

  assert.throws(
    () => previewCallback({
      type: 'lasso-preview',
      cellIndices: [0],
      cellCount: 1,
      newCellCount: 1,
      mode: 'replace',
      polygon
    }),
    /lasso preview mode must be exactly/i
  );
});

test('a proximity step centred on empty space still lands', () => {
  const documentOwner = createDocumentStub();
  const { state, previews } = createState(CATEGORY_FIELD);
  const modeDescriptionEl = createElementStub('highlight-mode-description');
  modeDescriptionEl.parentElement = documentOwner.parent;
  const restored = [];
  let stepCallback = null;
  let previewCallback = null;
  const viewer = {
    cancelProximitySelection() {},
    confirmProximitySelection() {},
    restoreProximityState(candidates, step) {
      restored.push({ candidates, step });
    },
    setProximityCallback() {},
    setProximityPreviewCallback(callback) {
      previewCallback = callback;
    },
    setProximityStepCallback(callback) {
      stepCallback = callback;
    }
  };

  withDocument(documentOwner.document, () => {
    initProximitySelection({
      state,
      viewer,
      jupyterSource: null,
      selectionState: createHighlightSelectionState(),
      ui: { modeDescriptionEl }
    });
  });

  // Dragging from empty space while a selection exists centres the sphere on
  // that selection's plane, and the renderer reports -1 for the cell it did
  // not hit. The preview already accepts it.
  withDocument(documentOwner.document, () => {
    previewCallback({
      type: 'proximity-preview',
      cellIndices: [0, 1],
      cellCount: 2,
      newCellCount: 2,
      centerCellIndex: -1,
      radius: 3,
      mode: 'union'
    });
    stepCallback({
      step: 2,
      candidateCount: 3,
      candidates: [0, 1, 2],
      mode: 'union',
      centerCellIndex: -1,
      radius: 3
    });
  });

  assert.deepEqual(
    previews.at(-1),
    [0, 1, 2],
    'the released step must publish its candidates, not throw them away'
  );
  assert.equal(
    documentOwner.elements.get('proximity-confirm-btn').disabled,
    false,
    'the step controls must reflect the step the user just completed'
  );

  assert.throws(
    () => withDocument(documentOwner.document, () => {
      stepCallback({
        step: 3,
        candidateCount: 1,
        candidates: [0],
        mode: 'union',
        centerCellIndex: state.pointCount,
        radius: 3
      });
    }),
    /inside the current dataset/i,
    'a centre past the end of the dataset is still refused'
  );
});

test('cancelling or confirming an annotation retracts it from the renderer', () => {
  for (const finish of ['cancel', 'confirm']) {
    const tool = buildAnnotationTool(CATEGORY_FIELD);
    tool.run(() => {
      tool.annotation.handleAnnotationStep(
        stepEvent({ cellIndex: 0, mode: 'intersect' })
      );
    });
    assert.deepEqual(
      tool.restoreCalls.at(-1),
      { candidates: [0, 1], step: 1 },
      'the step publishes its candidates to the renderer'
    );

    tool.run(() => {
      if (finish === 'cancel') {
        // What viewer.cancelAnnotationSelection() delivers back to the tool.
        tool.annotation.handleAnnotationStep({
          cancelled: true,
          step: 0,
          candidateCount: 0
        });
      } else {
        tool.documentOwner.elements.get('annotation-confirm-btn').dispatch('click');
      }
    });

    assert.deepEqual(
      tool.restoreCalls.at(-1),
      { candidates: [], step: 0 },
      `${finish} must retract the candidates it published`
    );
    assert.equal(tool.selectionState.annotationCandidateSet, null);
    assert.equal(tool.selectionState.annotationStepCount, 0);
  }
});
