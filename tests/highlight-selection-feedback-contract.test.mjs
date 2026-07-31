/**
 * Exact feedback contract for the four highlight selection tools.
 *
 * Every test here pins one thing the tools used to do silently: abandon a
 * gesture with no explanation, record a step that changed nothing, invite a
 * click the app cannot serve, or leave Escape unbound while a Cancel button
 * sits beside it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { initAnnotationSelection }
  from '../assets/js/app/ui/modules/highlight/annotation-selection.js';
import { initKnnSelection }
  from '../assets/js/app/ui/modules/highlight/knn-selection.js';
import { initLassoSelection }
  from '../assets/js/app/ui/modules/highlight/lasso-selection.js';
import { initProximitySelection }
  from '../assets/js/app/ui/modules/highlight/proximity-selection.js';
import { initHighlightModeUI }
  from '../assets/js/app/ui/modules/highlight/mode-ui.js';
import {
  ABANDONED_GESTURE_REASONS,
  abandonedGestureNotice,
  ANNOTATION_NEEDS_FIELD_COPY,
  HIGHLIGHT_MODE_COPY,
  SELECTION_NOTICE
} from '../assets/js/app/ui/modules/highlight/mode-copy.js';
import {
  requireAnnotationStepEvent,
  requireSelectionStepEvent
} from '../assets/js/app/ui/modules/highlight/exact-contract.js';
import {
  createHighlightSelectionState,
  selectionUnchanged
} from '../assets/js/app/ui/modules/highlight/selection-state.js';

// Cell 4 carries the uint8 missing code, so a gesture that lands on it resolves
// to no cells at all — the exact case that used to `return` without a word.
const CATEGORY_CODES = Uint8Array.from([0, 0, 1, 1, 255, 2]);
const CATEGORY_FIELD = Object.freeze({
  key: 'kind',
  kind: 'category',
  codes: CATEGORY_CODES,
  categories: ['A', 'B', 'C']
});

const STEP_CONTROL_BUTTON_SUFFIXES = Object.freeze([
  'confirm-btn',
  'undo-btn',
  'redo-btn',
  'cancel-btn'
]);

function createElementStub(id) {
  const listeners = new Map();
  const attributes = new Map();
  const element = {
    id,
    className: '',
    disabled: false,
    innerHTML: '',
    style: {},
    dataset: {},
    children: [],
    removed: false,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    appendChild(child) {
      element.children.push(child);
    },
    dispatch(type, event = {}) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    remove() {
      element.removed = true;
    }
  };
  return element;
}

/**
 * The tools mint their step controls through `innerHTML`, so the stub has to
 * mint the four buttons a real parser would produce. The block's markup is
 * kept verbatim so the accessible-name assertions read the shipped attributes.
 */
function createDocumentStub() {
  const elements = new Map();
  const keydownListeners = [];
  const parent = createElementStub('highlight-mode-box');
  const originalAppend = parent.appendChild;
  parent.appendChild = controls => {
    originalAppend(controls);
    elements.set(controls.id, controls);
    const tool = controls.id.replace('-step-controls', '');
    for (const suffix of STEP_CONTROL_BUTTON_SUFFIXES) {
      const buttonId = `${tool}-${suffix}`;
      const button = createElementStub(buttonId);
      const markup = controls.innerHTML;
      const opening = markup.slice(
        markup.lastIndexOf('<button', markup.indexOf(`id="${buttonId}"`)),
        markup.indexOf('>', markup.indexOf(`id="${buttonId}"`)) + 1
      );
      for (const [, name, value] of opening.matchAll(/([\w-]+)="([^"]*)"/g)) {
        button.setAttribute(name, value);
      }
      elements.set(buttonId, button);
    }
  };
  return {
    parent,
    elements,
    keydownListeners,
    document: {
      activeElement: null,
      addEventListener(type, listener) {
        if (type === 'keydown') keydownListeners.push(listener);
      },
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
  const listeners = new Map();
  return {
    previews,
    emit(eventName) {
      for (const listener of [...(listeners.get(eventName) ?? [])]) listener();
    },
    setField(next) {
      this.state.activeField = next;
    },
    state: {
      pointCount: CATEGORY_CODES.length,
      activeField: field,
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
        return this.activeField;
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
      getCellIndicesForRange() {
        return [];
      },
      getValueForCell() {
        return Number.NaN;
      },
      on(eventName, listener) {
        if (!listeners.has(eventName)) listeners.set(eventName, []);
        listeners.get(eventName).push(listener);
        return () => {
          listeners.set(
            eventName,
            (listeners.get(eventName) ?? [])
              .filter(candidate => candidate !== listener)
          );
        };
      },
      setPreviewHighlightFromIndices(indices) {
        previews.push([...indices].sort((left, right) => left - right));
      }
    }
  };
}

function createAnnotationViewer() {
  const restoreCalls = [];
  return {
    restoreCalls,
    viewer: {
      cancelAnnotationSelection() {},
      confirmAnnotationSelection() {},
      getViewTransparency() {
        return new Float32Array(CATEGORY_CODES.length).fill(1);
      },
      restoreUnifiedState(candidates, step) {
        restoreCalls.push({ candidates: [...candidates], step });
      },
      setSelectionStepCallback() {}
    }
  };
}

function buildAnnotationTool(field = CATEGORY_FIELD) {
  const dom = createDocumentStub();
  const stateOwner = createState(field);
  const viewerOwner = createAnnotationViewer();
  const selectionState = createHighlightSelectionState();
  const modeDescription = createElementStub('highlight-mode-description');
  modeDescription.parentElement = dom.parent;
  const annotation = withDocument(dom.document, () => initAnnotationSelection({
    state: stateOwner.state,
    viewer: viewerOwner.viewer,
    jupyterSource: null,
    selectionState,
    ui: {
      modeDescriptionEl: modeDescription,
      hideRangeLabel() {}
    }
  }));
  return {
    annotation,
    dom,
    modeDescription,
    previews: stateOwner.previews,
    restoreCalls: viewerOwner.restoreCalls,
    selectionState,
    stateOwner,
    run: callback => withDocument(dom.document, callback)
  };
}

function annotationStep(overrides) {
  return {
    type: 'click',
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

// ---------------------------------------------------------------------------
// A gesture that resolves to no cells
// ---------------------------------------------------------------------------

test(
  'an annotation gesture on a cell with no field value says so instead of '
  + 'returning silently',
  () => {
    const tool = buildAnnotationTool();
    tool.run(() => {
      tool.annotation.handleAnnotationStep(annotationStep({ cellIndex: 2 }));
    });
    const stepsBefore = tool.selectionState.annotationStepCount;
    const historyBefore = tool.selectionState.annotationHistory.length;
    tool.previews.length = 0;

    tool.run(() => {
      // Cell 4 carries the missing category code.
      tool.annotation.handleAnnotationStep(annotationStep({ cellIndex: 4 }));
    });

    assert.match(
      tool.modeDescription.innerHTML,
      new RegExp(SELECTION_NOTICE.noFieldValue),
      'a gesture that can select nothing must say why'
    );
    assert.equal(
      tool.selectionState.annotationStepCount,
      stepsBefore,
      'a gesture that selects nothing is not a step'
    );
    assert.equal(
      tool.selectionState.annotationHistory.length,
      historyBefore,
      'a gesture that selects nothing costs no undo'
    );
    assert.deepEqual(
      tool.previews,
      [[2, 3]],
      'the standing selection must be restored over the wiped drag preview'
    );
  }
);

// ---------------------------------------------------------------------------
// A gesture that changes nothing
// ---------------------------------------------------------------------------

test(
  'repeating an identical annotation gesture is not a second step',
  () => {
    const tool = buildAnnotationTool();
    tool.run(() => {
      tool.annotation.handleAnnotationStep(annotationStep({ cellIndex: 0 }));
    });
    assert.equal(tool.selectionState.annotationStepCount, 1);

    for (let repeat = 0; repeat < 5; repeat++) {
      tool.run(() => {
        tool.annotation.handleAnnotationStep(annotationStep({ cellIndex: 0 }));
      });
    }

    assert.equal(
      tool.selectionState.annotationStepCount,
      1,
      'six identical clicks select one thing, so they are one step'
    );
    assert.equal(
      tool.selectionState.annotationHistory.length,
      1,
      'six identical clicks must cost exactly one undo'
    );
    assert.match(
      tool.modeDescription.innerHTML,
      new RegExp(SELECTION_NOTICE.unchanged),
      'the repeat must be acknowledged, not swallowed'
    );

    tool.selectionState.annotationHistory.pop();
    assert.deepEqual(
      [...tool.selectionState.annotationCandidateSet],
      [0, 1],
      'the one recorded step still holds the selected category'
    );
  }
);

test(
  'subtracting before anything is selected records neither a step nor history',
  () => {
    const tool = buildAnnotationTool();
    tool.run(() => {
      tool.annotation.handleAnnotationStep(
        annotationStep({ cellIndex: 0, mode: 'subtract' })
      );
    });

    assert.equal(tool.selectionState.annotationCandidateSet, null);
    assert.equal(tool.selectionState.annotationStepCount, 0);
    assert.deepEqual(
      tool.selectionState.annotationHistory,
      [],
      'a subtract with nothing selected must not push a phantom history entry'
    );
    assert.match(
      tool.modeDescription.innerHTML,
      new RegExp(SELECTION_NOTICE.unchanged)
    );
  }
);

test('an unchanged candidate set is recognised however it is spelled', () => {
  assert.equal(selectionUnchanged(null, []), true);
  assert.equal(selectionUnchanged(new Set(), null), true);
  assert.equal(selectionUnchanged([1, 2, 3], [3, 2, 1]), true);
  assert.equal(selectionUnchanged(new Set([1, 2]), [1, 2]), true);
  assert.equal(selectionUnchanged([1, 2], [1, 3]), false);
  assert.equal(selectionUnchanged([1, 2], [1, 2, 3]), false);
  assert.equal(selectionUnchanged(null, [1]), false);
  assert.throws(() => selectionUnchanged('nope', []), /Set, an array, or null/);
});

// ---------------------------------------------------------------------------
// The spatial tools carry the same rule, and roll the renderer back with it
// ---------------------------------------------------------------------------

function buildSpatialTool(tool) {
  const dom = createDocumentStub();
  const stateOwner = createState(CATEGORY_FIELD);
  const selectionState = createHighlightSelectionState();
  const modeDescription = createElementStub('highlight-mode-description');
  modeDescription.parentElement = dom.parent;
  const restoreCalls = [];
  const viewer = {
    cancelKnnSelection() {},
    cancelLassoSelection() {},
    cancelProximitySelection() {},
    confirmKnnSelection() {},
    confirmLassoSelection() {},
    confirmProximitySelection() {},
    restoreKnnState(candidates, step) {
      restoreCalls.push({ candidates, step });
    },
    restoreLassoState(candidates, step) {
      restoreCalls.push({ candidates, step });
    },
    restoreProximityState(candidates, step) {
      restoreCalls.push({ candidates, step });
    },
    setKnnCallback() {},
    setKnnPreviewCallback() {},
    setKnnStepCallback() {},
    setLassoCallback() {},
    setLassoPreviewCallback() {},
    setLassoStepCallback() {},
    setProximityCallback() {},
    setProximityPreviewCallback() {},
    setProximityStepCallback() {}
  };
  const init = {
    knn: initKnnSelection,
    lasso: initLassoSelection,
    proximity: initProximitySelection
  }[tool];
  const owner = withDocument(dom.document, () => init({
    state: stateOwner.state,
    viewer,
    jupyterSource: null,
    selectionState,
    ui: { modeDescriptionEl: modeDescription }
  }));
  const handler = {
    knn: 'handleKnnStep',
    lasso: 'handleLassoStep',
    proximity: 'handleProximityStep'
  }[tool];
  const extras = {
    knn: { seedCellIndex: 0, degree: 1 },
    lasso: {},
    proximity: { centerCellIndex: 0, radius: 1 }
  }[tool];
  return {
    dom,
    modeDescription,
    restoreCalls,
    selectionState,
    step: (candidates, step) => withDocument(dom.document, () => {
      owner[handler]({
        step,
        candidateCount: candidates.length,
        candidates,
        mode: 'intersect',
        ...extras
      });
    }),
    abandon: reason => withDocument(dom.document, () => {
      owner[handler]({ abandoned: reason, step: 0, candidateCount: 0 });
    })
  };
}

for (const [tool, historyKey, stepKey] of [
  ['knn', 'knnHistory', 'lastKnnStep'],
  ['lasso', 'lassoHistory', 'lastLassoStep'],
  ['proximity', 'proximityHistory', 'lastProximityStep']
]) {
  test(
    `a repeated identical ${tool} gesture is not a second step`,
    () => {
      const owner = buildSpatialTool(tool);
      owner.step([0, 1, 2], 1);
      assert.equal(owner.selectionState[stepKey], 1);
      const historyAfterFirstStep = owner.selectionState[historyKey].length;

      owner.restoreCalls.length = 0;
      owner.step([2, 1, 0], 2);

      assert.equal(
        owner.selectionState[stepKey],
        1,
        'the tool must not advance on a gesture that changed nothing'
      );
      assert.equal(
        owner.selectionState[historyKey].length,
        historyAfterFirstStep,
        'a gesture that changed nothing must cost no undo'
      );
      assert.deepEqual(
        owner.restoreCalls,
        [{ candidates: [0, 1, 2], step: 1 }],
        "the renderer's own step counter must be rolled back with the tool's"
      );
      assert.match(
        owner.modeDescription.innerHTML,
        new RegExp(SELECTION_NOTICE.unchanged)
      );
    }
  );

  test(
    `the first ${tool} step is undoable, exactly as the annotation tool's is`,
    () => {
      const owner = buildSpatialTool(tool);
      owner.step([0, 1, 2], 1);

      assert.deepEqual(
        owner.selectionState[historyKey],
        [{ candidates: null, step: 0 }],
        'the empty state before the first step must be recorded like any other'
      );
      assert.equal(
        owner.dom.elements.get(`${tool}-undo-btn`).disabled,
        false,
        'Undo must not be greyed out immediately after a gesture landed'
      );
    }
  );

  for (const reason of ABANDONED_GESTURE_REASONS) {
    test(
      `an abandoned ${tool} gesture (${reason}) explains itself and leaves the `
      + 'standing selection exactly where it was',
      () => {
        const owner = buildSpatialTool(tool);
        owner.step([0, 1, 2], 1);
        const historyAfterFirstStep = owner.selectionState[historyKey].length;
        owner.restoreCalls.length = 0;

        owner.abandon(reason);

        assert.match(
          owner.modeDescription.innerHTML,
          new RegExp(abandonedGestureNotice(reason)),
          'a gesture the renderer threw away must say why'
        );
        assert.match(
          owner.modeDescription.innerHTML,
          /Step 1:/,
          'the standing selection must still be reported over the wiped preview'
        );
        assert.equal(
          owner.selectionState[stepKey],
          1,
          'an abandoned gesture is not a step'
        );
        assert.equal(
          owner.selectionState[historyKey].length,
          historyAfterFirstStep,
          'an abandoned gesture costs no undo'
        );
      }
    );
  }
}

// ---------------------------------------------------------------------------
// A gesture the renderer consumed and could not turn into a step
// ---------------------------------------------------------------------------

for (const reason of ABANDONED_GESTURE_REASONS) {
  test(
    `an abandoned annotation gesture (${reason}) is answered, not swallowed`,
    () => {
      const tool = buildAnnotationTool();
      tool.run(() => {
        tool.annotation.handleAnnotationStep(annotationStep({ cellIndex: 0 }));
      });
      const stepsBefore = tool.selectionState.annotationStepCount;
      const historyBefore = tool.selectionState.annotationHistory.length;
      tool.previews.length = 0;

      tool.run(() => {
        tool.annotation.handleAnnotationStep({
          abandoned: reason,
          step: 0,
          candidateCount: 0
        });
      });

      assert.match(
        tool.modeDescription.innerHTML,
        new RegExp(abandonedGestureNotice(reason))
      );
      assert.equal(tool.selectionState.annotationStepCount, stepsBefore);
      assert.equal(
        tool.selectionState.annotationHistory.length,
        historyBefore
      );
      assert.deepEqual(
        tool.previews,
        [[0, 1]],
        'the standing selection must be restored over the wiped drag preview'
      );
    }
  );
}

test(
  'an abandoned annotation gesture with nothing selected keeps the idle copy',
  () => {
    const tool = buildAnnotationTool();
    tool.run(() => {
      tool.annotation.handleAnnotationStep({
        abandoned: 'no-cell-under-pointer',
        step: 0,
        candidateCount: 0
      });
    });

    assert.equal(
      tool.modeDescription.innerHTML,
      HIGHLIGHT_MODE_COPY.annotation
      + `<br><small>${SELECTION_NOTICE.noCellUnderPointer}</small>`,
      'a first click that hit nothing reads under the invitation it failed'
    );
    assert.equal(tool.selectionState.annotationCandidateSet, null);
    assert.deepEqual(tool.selectionState.annotationHistory, []);
  }
);

test('repeating an abandoned gesture repaints the same panel, not a second '
  + 'line', () => {
  const tool = buildAnnotationTool();
  const abandon = () => tool.run(() => {
    tool.annotation.handleAnnotationStep({
      abandoned: 'no-cell-under-pointer',
      step: 0,
      candidateCount: 0
    });
  });

  abandon();
  const afterOne = tool.modeDescription.innerHTML;
  abandon();
  abandon();

  assert.equal(tool.modeDescription.innerHTML, afterOne);
});

test('the tools reject an abandonment reason they have no wording for', () => {
  assert.throws(
    () => abandonedGestureNotice('whatever'),
    /Unknown abandoned gesture reason/
  );
  assert.throws(
    () => abandonedGestureNotice('__proto__'),
    /Unknown abandoned gesture reason/
  );
  for (const tool of ['annotation', 'knn', 'proximity', 'lasso']) {
    assert.throws(
      () => requireSelectionStepEvent(
        { abandoned: 'nonsense', step: 0, candidateCount: 0 },
        tool,
        6
      ),
      /abandoned step reason must be exactly/
    );
    assert.throws(
      () => requireSelectionStepEvent(
        { abandoned: 'no-cell-under-pointer', step: 1, candidateCount: 0 },
        tool,
        6
      ),
      /abandoned step must publish zero counts/
    );
  }
  assert.throws(
    () => requireAnnotationStepEvent(
      { abandoned: 'no-cell-under-pointer', step: 0 },
      6
    ),
    /abandoned step event must contain exactly/
  );
});

// ---------------------------------------------------------------------------
// The annotation tool with no active field
// ---------------------------------------------------------------------------

test(
  'the annotation panel names the missing field instead of inviting a click '
  + 'the viewer will not serve',
  () => {
    const tool = buildAnnotationTool(null);
    tool.run(() => {
      tool.annotation.restoreAnnotationSelection({
        inProgress: false,
        stepCount: 0,
        candidateCount: 0,
        candidates: []
      });
    });

    assert.equal(tool.modeDescription.innerHTML, ANNOTATION_NEEDS_FIELD_COPY);
    assert.doesNotMatch(
      tool.modeDescription.innerHTML,
      /Alt\+click a cell to select/,
      'the panel must not promise a gesture the viewer never starts'
    );
  }
);

test(
  'choosing a field refreshes the annotation panel without any gesture',
  () => {
    const tool = buildAnnotationTool(null);
    tool.selectionState.activeMode = 'annotation';
    tool.run(() => {
      tool.annotation.restoreAnnotationSelection({
        inProgress: false,
        stepCount: 0,
        candidateCount: 0,
        candidates: []
      });
    });
    assert.equal(tool.modeDescription.innerHTML, ANNOTATION_NEEDS_FIELD_COPY);

    tool.stateOwner.setField(CATEGORY_FIELD);
    tool.run(() => tool.stateOwner.emit('visibility:changed'));
    assert.equal(
      tool.modeDescription.innerHTML,
      HIGHLIGHT_MODE_COPY.annotation,
      'the panel must follow the field the user just chose'
    );

    tool.stateOwner.setField(null);
    tool.run(() => tool.stateOwner.emit('visibility:changed'));
    assert.equal(tool.modeDescription.innerHTML, ANNOTATION_NEEDS_FIELD_COPY);
  }
);

test(
  'a foreign mode keeps its own panel when the active field changes',
  () => {
    const tool = buildAnnotationTool(null);
    tool.selectionState.activeMode = 'lasso';
    tool.modeDescription.innerHTML = HIGHLIGHT_MODE_COPY.lasso;

    tool.stateOwner.setField(CATEGORY_FIELD);
    tool.run(() => tool.stateOwner.emit('visibility:changed'));

    assert.equal(
      tool.modeDescription.innerHTML,
      HIGHLIGHT_MODE_COPY.lasso,
      'the annotation tool must not repaint another mode\'s panel'
    );
  }
);

// ---------------------------------------------------------------------------
// Escape
// ---------------------------------------------------------------------------

function createModeButton(mode, pressed) {
  const attributes = new Map([['aria-pressed', pressed ? 'true' : 'false']]);
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

function buildModeUi() {
  const dom = createDocumentStub();
  const selectionState = createHighlightSelectionState();
  const modeDescription = createElementStub('highlight-mode-description');
  modeDescription.parentElement = dom.parent;
  const cancels = [];
  const buttons = ['annotation', 'knn', 'proximity', 'lasso'].map(
    mode => createModeButton(mode, mode === 'annotation')
  );
  const viewer = {
    cancelAnnotationSelection() {
      cancels.push('annotation');
    },
    cancelKnnSelection() {
      cancels.push('knn');
    },
    cancelLassoSelection() {
      cancels.push('lasso');
    },
    cancelProximitySelection() {
      cancels.push('proximity');
    },
    cancelUnifiedSelection() {},
    getUnifiedSelectionState() {
      return {
        inProgress: false,
        stepCount: 0,
        candidateCount: 0,
        candidates: []
      };
    },
    restoreUnifiedState() {},
    setKnnEnabled() {},
    setLassoEnabled() {},
    setProximityEnabled() {}
  };
  const modeUi = withDocument(dom.document, () => initHighlightModeUI({
    state: { pointCount: CATEGORY_CODES.length },
    viewer,
    dom: { modeButtons: buttons, modeDescription },
    selectionState,
    modeHandlers: {
      restoreAnnotationSelection() {},
      restoreKnnSelection() {},
      restoreProximitySelection() {},
      restoreLassoSelection() {}
    }
  }));
  const press = (event = {}) => {
    const keyEvent = {
      key: 'Escape',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      defaultPrevented: false,
      target: { tagName: 'CANVAS' },
      preventDefault() {
        keyEvent.prevented = true;
      },
      stopPropagation() {
        keyEvent.stopped = true;
      },
      prevented: false,
      stopped: false,
      ...event
    };
    for (const listener of dom.keydownListeners) listener(keyEvent);
    return keyEvent;
  };
  return { buttons, cancels, modeUi, press, selectionState };
}

test(
  'Escape abandons the in-progress selection of whichever tool is active',
  () => {
    const cases = [
      ['annotation', state => {
        state.annotationCandidateSet = new Set([0, 1]);
        state.annotationStepCount = 1;
      }],
      ['knn', state => {
        state.lastKnnCandidates = [0, 1];
        state.lastKnnStep = 1;
      }],
      ['proximity', state => {
        state.lastProximityCandidates = [0, 1];
        state.lastProximityStep = 1;
      }],
      ['lasso', state => {
        state.lastLassoCandidates = [0, 1];
        state.lastLassoStep = 1;
      }]
    ];
    for (const [mode, arm] of cases) {
      const owner = buildModeUi();
      owner.buttons.find(button => button.dataset.mode === mode).click();
      arm(owner.selectionState);

      const event = owner.press();

      assert.deepEqual(
        owner.cancels,
        [mode],
        `Escape in ${mode} mode must call exactly that tool's cancel`
      );
      assert.equal(event.prevented, true);
      assert.equal(event.stopped, true);
    }
  }
);

test('Escape with nothing in progress is left for whoever else wants it', () => {
  const owner = buildModeUi();
  const event = owner.press();

  assert.deepEqual(owner.cancels, []);
  assert.equal(
    event.prevented,
    false,
    'an idle tool must not swallow Escape from a dialog behind it'
  );
  assert.equal(event.stopped, false);
});

test('Escape defers to a handler that already claimed it', () => {
  const cases = [
    ['already handled', { defaultPrevented: true }],
    ['a text field', { target: { tagName: 'INPUT' } }],
    ['a textarea', { target: { tagName: 'TEXTAREA' } }],
    ['a select', { target: { tagName: 'SELECT' } }],
    ['contenteditable', { target: { tagName: 'DIV', isContentEditable: true } }],
    ['Shift+Escape', { shiftKey: true }],
    ['Ctrl+Escape', { ctrlKey: true }],
    ['Alt+Escape', { altKey: true }],
    ['Meta+Escape', { metaKey: true }],
    ['another key', { key: 'Enter' }]
  ];
  for (const [label, overrides] of cases) {
    const owner = buildModeUi();
    owner.selectionState.annotationCandidateSet = new Set([0, 1]);
    owner.selectionState.annotationStepCount = 1;

    const event = owner.press(overrides);

    assert.deepEqual(owner.cancels, [], `${label} must not cancel a selection`);
    assert.equal(event.prevented, false, `${label} must not be consumed`);
  }
});

test('mode-UI destruction releases the Escape binding', () => {
  const owner = buildModeUi();
  owner.selectionState.annotationCandidateSet = new Set([0, 1]);
  owner.selectionState.annotationStepCount = 1;
  owner.modeUi.destroy();

  owner.press();

  assert.deepEqual(owner.cancels, []);
});

// ---------------------------------------------------------------------------
// Step-control naming
// ---------------------------------------------------------------------------

test(
  'the step controls name their glyph buttons and advertise Escape',
  () => {
    const tool = buildAnnotationTool();
    tool.run(() => {
      tool.annotation.handleAnnotationStep(annotationStep({ cellIndex: 0 }));
    });

    const named = id => {
      const button = tool.dom.elements.get(id);
      assert.ok(button, `${id} must exist while a selection is in progress`);
      return button;
    };
    assert.equal(
      named('annotation-undo-btn').getAttribute('aria-label'),
      'Undo last selection step'
    );
    assert.equal(
      named('annotation-redo-btn').getAttribute('aria-label'),
      'Redo last selection step'
    );
    assert.equal(
      named('annotation-cancel-btn').getAttribute('aria-keyshortcuts'),
      'Escape'
    );
    assert.match(
      named('annotation-cancel-btn').getAttribute('title'),
      /\(Esc\)/,
      'the Cancel button is the only place the Escape binding can be discovered'
    );
  }
);
