/**
 * Exact feedback contract for the four highlight selection tools.
 *
 * Every test here pins one thing the tools used to do silently: abandon a
 * gesture with no explanation, record a step that changed nothing, invite a
 * click the app cannot serve, or leave Escape unbound while a Cancel button
 * sits beside it.
 */

import { CellSet } from '../assets/js/app/utils/cell-set.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  ANNOTATION_ABANDONED_GESTURE_REASONS,
  abandonedGestureNotice,
  ANNOTATION_NEEDS_FIELD_COPY,
  HIGHLIGHT_MODE_COPY,
  SELECT_BAR_ANNOTATION_NEEDS_FIELD_HINT,
  SELECT_BAR_HINT,
  selectBarNotice,
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
import { createSelectModeDom } from './helpers/select-mode-dom.mjs';

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
      addHighlightDirect({ type, label, cellIndices }) {
        return {
          id: 'highlight_1',
          type,
          label,
          enabled: true,
          cellIndices: cellIndices.slice(),
          cellCount: cellIndices.length
        };
      },
      clearPreviewHighlight() {
        previews.push('clear');
      },
      getActiveField() {
        return this.activeField;
      },
      getFieldForView() {
        return this.activeField;
      },
      getCellIndicesForCategory(lookupField, categoryIndex) {
        const indices = [];
        for (let cell = 0; cell < lookupField.codes.length; cell++) {
          if (lookupField.codes[cell] === categoryIndex) indices.push(cell);
        }
        return Uint32Array.from(indices);
      },
      getCellIndicesForRange() {
        return new Uint32Array(0);
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
  const layoutListeners = new Set();
  return {
    restoreCalls,
    layoutListeners,
    /** Publish a presented layout of these views, as the viewer does. */
    presentViews(viewIds) {
      const layout = { panes: viewIds.map(viewId => ({ viewId })) };
      for (const listener of [...layoutListeners]) listener(layout);
    },
    viewer: {
      cancelAnnotationSelection() {},
      confirmAnnotationSelection() {},
      getViewTransparency() {
        return new Float32Array(CATEGORY_CODES.length).fill(1);
      },
      onPresentedLayoutChange(listener) {
        layoutListeners.add(listener);
        return () => layoutListeners.delete(listener);
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
    presentViews: viewerOwner.presentViews,
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
  const list = (...cells) => Uint32Array.of(...cells);
  assert.equal(selectionUnchanged(null, list()), true);
  assert.equal(selectionUnchanged(new CellSet(8), null), true);
  assert.equal(selectionUnchanged(list(1, 2, 3), list(1, 2, 3)), true);
  assert.equal(selectionUnchanged(CellSet.from([2, 1], 8), list(1, 2)), true);
  assert.equal(selectionUnchanged(CellSet.from([2, 1], 8), CellSet.from([1, 3], 8)), false);
  assert.equal(selectionUnchanged(list(1, 2), list(1, 3)), false);
  assert.equal(selectionUnchanged(list(1, 2), list(1, 2, 3)), false);
  assert.equal(selectionUnchanged(null, list(1)), false);
  assert.throws(() => selectionUnchanged('nope', list()), /CellSet, a cell list, or null/);
  assert.throws(() => selectionUnchanged(new Set([1]), list(1)), /CellSet, a cell list, or null/);
  assert.throws(() => selectionUnchanged([1], list(1)), /CellSet, a cell list, or null/);
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
      restoreCalls.push({ candidates: candidates === null ? null : [...candidates], step });
    },
    restoreLassoState(candidates, step) {
      restoreCalls.push({ candidates: candidates === null ? null : [...candidates], step });
    },
    restoreProximityState(candidates, step) {
      restoreCalls.push({ candidates: candidates === null ? null : [...candidates], step });
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
    // The renderer publishes a gesture's cells as a cell list.
    step: (cells, step) => withDocument(dom.document, () => {
      const candidates = Uint32Array.from(cells).sort();
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

for (const reason of ANNOTATION_ABANDONED_GESTURE_REASONS) {
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

test('the selection bar mirrors the step controls and says when a tap missed', () => {
  const tool = buildAnnotationTool();
  const bar = {};
  for (const id of [
    'select-bar-steps',
    'select-bar-selection',
    'select-bar-undo',
    'select-bar-confirm',
    'select-bar-notice',
    'select-bar-hint'
  ]) {
    bar[id] = createElementStub(id);
    tool.dom.elements.set(id, bar[id]);
  }
  bar['select-bar-steps'].hidden = true;
  bar['select-bar-notice'].hidden = true;

  // A step shows the selection, offers the panel's actions, and enables them
  // exactly as the panel's buttons are enabled.
  tool.run(() => {
    tool.annotation.handleAnnotationStep(annotationStep({ cellIndex: 2 }));
  });
  const panelConfirm = tool.dom.elements.get('annotation-confirm-btn');
  const panelUndo = tool.dom.elements.get('annotation-undo-btn');
  assert.equal(bar['select-bar-steps'].hidden, false);
  assert.equal(bar['select-bar-steps'].dataset.tool, 'annotation');
  assert.equal(bar['select-bar-selection'].textContent, '2 cells selected');
  assert.equal(bar['select-bar-confirm'].disabled, panelConfirm.disabled);
  assert.equal(bar['select-bar-confirm'].disabled, false);
  assert.equal(bar['select-bar-undo'].disabled, panelUndo.disabled);
  assert.equal(bar['select-bar-notice'].hidden, true);

  // Cancelling hides the mirror with the panel's block.
  tool.run(() => {
    tool.annotation.handleAnnotationStep({ cancelled: true, step: 0, candidateCount: 0 });
  });
  assert.equal(bar['select-bar-steps'].hidden, true);
  assert.equal(bar['select-bar-steps'].dataset.tool, '');
  assert.equal(bar['select-bar-hint'].textContent, SELECT_BAR_HINT.annotation);

  // A tap on nothing changes nothing, and the bar says so in one line.
  tool.run(() => {
    tool.annotation.handleAnnotationStep({
      abandoned: 'no-cell-under-pointer',
      step: 0,
      candidateCount: 0
    });
  });
  assert.equal(bar['select-bar-steps'].hidden, true);
  assert.equal(bar['select-bar-notice'].hidden, false);
  assert.equal(
    bar['select-bar-notice'].textContent,
    'No cell there. Nothing changed; zoom in to hit cells.'
  );
  for (const notice of Object.values(SELECTION_NOTICE)) {
    assert.ok(selectBarNotice(notice).length > 0, notice);
  }
  assert.throws(() => selectBarNotice('Something else.'), TypeError);
});

test('the bar names the missing field when an annotation tap cannot work', () => {
  const tool = buildAnnotationTool(null);
  const hint = createElementStub('select-bar-hint');
  tool.dom.elements.set('select-bar-hint', hint);
  tool.run(() => {
    tool.annotation.restoreAnnotationSelection({
      inProgress: false,
      stepCount: 0,
      candidateCount: 0,
      candidates: new Uint32Array(0)
    });
  });
  assert.equal(hint.textContent, SELECT_BAR_ANNOTATION_NEEDS_FIELD_HINT);
  tool.stateOwner.setField(CATEGORY_FIELD);
  tool.run(() => tool.stateOwner.emit('visibility:changed'));
  assert.equal(hint.textContent, SELECT_BAR_HINT.annotation);
});

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

test('the miss notice offers only a remedy hit testing actually responds to',
  async () => {
    const pickingSource = await readFile(
      new URL('../assets/js/rendering/picking.js', import.meta.url),
      'utf8'
    );

    // A click hits the drawn dot, sized by the same Point size and perspective
    // attenuation the shader uses, so both remedies the notice offers are ones
    // the picking code actually reads.
    assert.match(pickingSource, /pointSize/);
    assert.match(pickingSource, /sizeAttenuation/);
    assert.match(SELECTION_NOTICE.noCellUnderPointer, /\bZoom in\b/);
    assert.match(SELECTION_NOTICE.noCellUnderPointer, /\bPoint size\b/);

    // Zoom also selects a finer LOD level, and picking rejects every cell the
    // active level has not admitted.
    assert.match(pickingSource, /lodAdmissionLevels\[cellIndex\] > lodLevel/);
  }
);

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
  // Only the annotation tool reads a pane's field, so only it can be told a
  // press landed in a pane colored by none.
  assert.equal(
    abandonedGestureNotice('no-field-in-pane'),
    SELECTION_NOTICE.noPanelField
  );
  assert.equal(
    requireAnnotationStepEvent(
      { abandoned: 'no-field-in-pane', step: 0, candidateCount: 0 },
      6
    ).abandoned,
    'no-field-in-pane'
  );
  for (const tool of ['knn', 'proximity', 'lasso']) {
    assert.throws(
      () => requireSelectionStepEvent(
        { abandoned: 'no-field-in-pane', step: 0, candidateCount: 0 },
        tool,
        6
      ),
      /abandoned step reason must be exactly/
    );
  }
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
        candidates: new Uint32Array(0)
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
        candidates: new Uint32Array(0)
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
  'in a grid, the panel asks for a field only when no pane on screen has one',
  () => {
    const tool = buildAnnotationTool(null);
    tool.selectionState.activeMode = 'annotation';
    // The focused view is colored by nothing; a kept view by a category.
    const fieldsByView = new Map([['kept', CATEGORY_FIELD]]);
    tool.stateOwner.state.getFieldForView = viewId =>
      fieldsByView.get(viewId) ?? null;

    tool.run(() => tool.presentViews(['live']));
    assert.equal(
      tool.modeDescription.innerHTML,
      ANNOTATION_NEEDS_FIELD_COPY,
      'with only the field-less view on screen no press can select'
    );

    tool.run(() => tool.presentViews(['live', 'kept']));
    assert.equal(
      tool.modeDescription.innerHTML,
      HIGHLIGHT_MODE_COPY.annotation,
      'a press in the colored pane selects, although focus has no field'
    );

    fieldsByView.delete('kept');
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

function buildModeUi({ selectDom = createSelectModeDom() } = {}) {
  const dom = createDocumentStub();
  dom.elements.set('select-bar-hint', createElementStub('select-bar-hint'));
  const selectionState = createHighlightSelectionState();
  const selectModes = [];
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
        candidates: new Uint32Array(0)
      };
    },
    restoreUnifiedState() {},
    setKnnEnabled() {},
    setLassoEnabled() {},
    setProximityEnabled() {},
    setSelectMode(selectMode) {
      selectModes.push(selectMode);
    }
  };
  const modeUi = withDocument(dom.document, () => initHighlightModeUI({
    state: { pointCount: CATEGORY_CODES.length },
    viewer,
    dom: { ...selectDom, modeButtons: buttons, modeDescription },
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
  return {
    buttons,
    cancels,
    elements: dom.elements,
    modeUi,
    press,
    selectDom,
    selectModes,
    selectionState
  };
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

test('Select mode publishes to the viewer and paints every switch alike', () => {
  const owner = buildModeUi();
  const { selectModeSwitches, selectCombineGroups, selectCombineButtons } =
    owner.selectDom;
  const checked = controls => controls.map(control => control.getAttribute('aria-checked'));
  const pressed = buttons => buttons.map(button => button.getAttribute('aria-pressed'));
  const hidden = groups => groups.map(group => group.hidden);
  assert.deepEqual(
    owner.selectModes,
    [{ enabled: false, combine: 'intersect' }],
    'the markup state is published once at start'
  );

  // The selection bar's switch and the panel's are one setting.
  selectModeSwitches[1].click();
  assert.deepEqual(owner.selectModes.at(-1), { enabled: true, combine: 'intersect' });
  assert.deepEqual(checked(selectModeSwitches), ['true', 'true']);
  assert.deepEqual(hidden(selectCombineGroups), [false, false]);

  // A combine chosen on the bar shows on the panel too.
  selectCombineButtons
    .filter(button => button.dataset.combine === 'subtract')[1]
    .click();
  assert.deepEqual(owner.selectModes.at(-1), { enabled: true, combine: 'subtract' });
  assert.deepEqual(
    pressed(selectCombineButtons),
    ['false', 'false', 'true', 'false', 'false', 'true']
  );
  assert.deepEqual(owner.modeUi.getSelectMode(), { enabled: true, combine: 'subtract' });

  selectModeSwitches[0].click();
  assert.deepEqual(owner.selectModes.at(-1), { enabled: false, combine: 'subtract' });
  assert.deepEqual(checked(selectModeSwitches), ['false', 'false']);
  assert.deepEqual(hidden(selectCombineGroups), [true, true]);
});

test('the selection bar names the active tool and presses its step buttons', () => {
  const owner = buildModeUi();
  const { selectBarSteps, selectBarStepButtons } = owner.selectDom;
  const hint = owner.elements.get('select-bar-hint');
  assert.equal(hint.textContent, SELECT_BAR_HINT.annotation);
  owner.buttons.find(button => button.dataset.mode === 'lasso').click();
  assert.equal(hint.textContent, SELECT_BAR_HINT.lasso);

  const presses = [];
  for (const action of ['undo', 'cancel', 'confirm']) {
    const id = `lasso-${action}-btn`;
    owner.elements.set(id, { click: () => presses.push(id) });
  }
  // Nothing is mirrored: the bar's buttons do nothing.
  for (const button of selectBarStepButtons) button.click();
  assert.deepEqual(presses, []);

  selectBarSteps.dataset.tool = 'lasso';
  for (const button of selectBarStepButtons) button.click();
  assert.deepEqual(presses, ['lasso-undo-btn', 'lasso-cancel-btn', 'lasso-confirm-btn']);
});

test('Escape cancels a selection in progress before it leaves Select mode', () => {
  const owner = buildModeUi();
  owner.selectDom.selectModeSwitches[0].click();
  owner.selectionState.annotationCandidateSet = new Set([0, 1]);
  owner.selectionState.annotationStepCount = 1;

  const first = owner.press();
  assert.deepEqual(owner.cancels, ['annotation']);
  assert.equal(first.prevented, true);
  assert.equal(owner.modeUi.getSelectMode().enabled, true);

  owner.selectionState.annotationCandidateSet = null;
  owner.selectionState.annotationStepCount = 0;
  const second = owner.press();
  assert.equal(second.prevented, true);
  assert.equal(second.stopped, true);
  assert.deepEqual(owner.selectModes.at(-1), { enabled: false, combine: 'intersect' });
  assert.deepEqual(
    owner.selectDom.selectModeSwitches.map(control => control.getAttribute('aria-checked')),
    ['false', 'false']
  );

  const third = owner.press();
  assert.equal(third.prevented, false, 'with nothing left, Escape is not consumed');
});

test('Select mode markup that disagrees with itself is refused', () => {
  const disagreeing = createSelectModeDom();
  disagreeing.selectModeSwitches[1].setAttribute('aria-checked', 'true');
  assert.throws(
    () => buildModeUi({ selectDom: disagreeing }),
    /every select mode switch must show the same state/i
  );
  const notASwitch = createSelectModeDom();
  notASwitch.selectModeSwitches[0].setAttribute('role', 'button');
  assert.throws(
    () => buildModeUi({ selectDom: notASwitch }),
    /role="switch"/
  );
  const unpressed = createSelectModeDom();
  for (const button of unpressed.selectCombineButtons) {
    button.setAttribute('aria-pressed', 'false');
  }
  assert.throws(
    () => buildModeUi({ selectDom: unpressed }),
    /exactly one select mode combine must be pressed/i
  );
  const split = createSelectModeDom();
  split.selectCombineButtons[0].setAttribute('aria-pressed', 'false');
  assert.throws(
    () => buildModeUi({ selectDom: split }),
    /every select mode intersect button must show the same state/i
  );
  const missing = createSelectModeDom();
  missing.selectCombineButtons[4].dataset.combine = 'intersect';
  missing.selectCombineButtons[4].setAttribute('aria-pressed', 'true');
  assert.throws(
    () => buildModeUi({ selectDom: missing }),
    /one (intersect|union) button in every combine group/i
  );
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
