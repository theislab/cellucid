/**
 * Exact contract for how the renderer learns each pane's field kind.
 *
 * An annotation gesture is read on the pane it lands in and never moves view
 * focus, so whether a press can start, and which cursor the armed tool shows,
 * is a question about that pane's field — not the focused view's. The renderer
 * used to hold one `highlightMode` cached from the focused view's field and
 * discarded every Alt press in every pane while it read `'none'`. It now asks a
 * source, per view and at the moment it needs the answer, and highlight
 * controls wire that source straight to `state.getFieldForView`. Each test
 * here pins one half of that: the answer is per view, it follows a field
 * change made by any path with nothing to republish, and a retired panel stops
 * the viewer reading its state.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { initHighlightControls }
  from '../assets/js/app/ui/modules/highlight-controls.js';
import { HighlightTools }
  from '../assets/js/rendering/highlight-renderer.js';
import { createSelectModeDom } from './helpers/select-mode-dom.mjs';

const CATEGORY_FIELD = Object.freeze({
  key: 'cell_type',
  kind: 'category',
  categories: ['A', 'B'],
  codes: Uint8Array.from([0, 1, 0, 1])
});

const CONTINUOUS_FIELD = Object.freeze({
  key: 'S_score',
  kind: 'continuous',
  values: Float32Array.from([0, 0.25, 0.5, 1])
});

const POINT_COUNT = 4;

// `StyleManager.setVariable` silently ignores anything that is not an
// HTMLElement, so the page tab strip would render no colours at all without a
// constructor for the stubs to be instances of.
class HTMLElementStub {}
globalThis.HTMLElement = HTMLElementStub;

function createElementStub(id) {
  const listeners = new Map();
  const attributes = new Map();
  const element = Object.assign(new HTMLElementStub(), {
    id,
    className: '',
    disabled: false,
    innerHTML: '',
    textContent: '',
    style: { setProperty() {} },
    dataset: {},
    children: [],
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    appendChild(child) {
      element.children.push(child);
      return child;
    },
    replaceChildren(...children) {
      element.children = [...children];
    },
    contains(node) {
      return node === element || element.children.includes(node);
    },
    querySelectorAll() {
      return [];
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    remove() {}
  });
  return element;
}

function createModeButton(mode, pressed) {
  const button = createElementStub(`highlight-mode-${mode}`);
  button.dataset = { mode };
  button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  return button;
}

function createDocumentStub() {
  const elements = new Map();
  return {
    body: createElementStub('body'),
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      const element = createElementStub('');
      element.remove = () => elements.delete(element.id);
      return element;
    },
    getElementById(id) {
      return elements.get(id) ?? null;
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

/**
 * A DataState stand-in with one field per view, changed the way every path
 * changes it (the selector, a dataset's default state, Load State, a Jupyter
 * command): assigned, with no event the highlight controls could follow.
 */
function createState() {
  const listeners = new Map();
  const fieldsByView = new Map();
  const page = {
    id: 'page_1',
    name: 'Page 1',
    color: '#2563eb',
    highlightedGroups: []
  };
  const reads = [];
  const state = {
    pointCount: POINT_COUNT,
    activeViewId: 'live',
    highlightPages: [page],
    activePageId: page.id,
    reads,
    addHighlightDirect() {
      return null;
    },
    clearAllHighlights() {},
    clearPreviewHighlight() {},
    combineHighlightPages() {},
    createHighlightPage() {},
    deleteHighlightPage() {},
    ensureHighlightPage() {},
    getActiveField() {
      return state.getFieldForView(state.activeViewId);
    },
    getActivePageId() {
      return state.activePageId;
    },
    getActiveViewId() {
      return state.activeViewId;
    },
    getCellIndicesForCategory() {
      return [];
    },
    getCellIndicesForRange() {
      return [];
    },
    getFieldForView(viewId) {
      reads.push(viewId);
      return fieldsByView.get(viewId) ?? null;
    },
    getHighlightPages() {
      return state.highlightPages;
    },
    getHighlightedCellCount() {
      return 0;
    },
    getHighlightedCellCountForPage() {
      return 0;
    },
    getHighlightedGroups() {
      return page.highlightedGroups;
    },
    getTotalHighlightedCellCount() {
      return 0;
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
    removeHighlightGroup() {
      return true;
    },
    renameHighlightPage() {},
    setHighlightPageColor() {},
    setPreviewHighlightFromIndices() {},
    switchToPage() {},
    toggleHighlightEnabled() {
      return true;
    },
    setFieldForView(viewId, field) {
      fieldsByView.set(viewId, field);
    }
  };
  return state;
}

function createViewer() {
  const viewer = {
    fieldKindSource: null,
    fieldKindSourceWrites: 0,
    setViewFieldKindSource(source) {
      viewer.fieldKindSource = source;
      viewer.fieldKindSourceWrites += 1;
    },
    getViewTransparency() {
      return new Float32Array(POINT_COUNT).fill(1);
    },
    getUnifiedSelectionState() {
      return {
        inProgress: false,
        stepCount: 0,
        candidateCount: 0,
        candidates: new Uint32Array(0)
      };
    },
    onLodChanged() {
      return () => {};
    },
    onPresentedLayoutChange() {
      return () => {};
    },
    restoreUnifiedState() {},
    updateHighlight() {}
  };
  for (const name of [
    'cancelAnnotationSelection',
    'cancelKnnSelection',
    'cancelLassoSelection',
    'cancelProximitySelection',
    'cancelUnifiedSelection',
    'confirmAnnotationSelection',
    'confirmKnnSelection',
    'confirmLassoSelection',
    'confirmProximitySelection',
    'restoreKnnState',
    'restoreLassoState',
    'restoreProximityState',
    'setKnnCallback',
    'setKnnEnabled',
    'setKnnPreviewCallback',
    'setKnnStepCallback',
    'setLassoCallback',
    'setLassoEnabled',
    'setLassoPreviewCallback',
    'setLassoStepCallback',
    'setProximityCallback',
    'setProximityEnabled',
    'setProximityPreviewCallback',
    'setProximityStepCallback',
    'setSelectionPreviewCallback',
    'setSelectionStepCallback',
    'setSelectMode'
  ]) {
    viewer[name] = () => {};
  }
  return viewer;
}

function buildControls() {
  const state = createState();
  const viewer = createViewer();
  const documentStub = createDocumentStub();
  const modeDescription = createElementStub('highlight-mode-description');
  modeDescription.parentElement = createElementStub('highlight-mode-box');
  const dom = {
    countEls: [createElementStub('highlight-count')],
    groupsEl: createElementStub('highlighted-groups'),
    clearButtons: [createElementStub('clear-highlights')],
    pagesTabsEl: createElementStub('highlight-pages-tabs'),
    addPageBtn: createElementStub('add-highlight-page'),
    ...createSelectModeDom(),
    modeButtons: [
      createModeButton('annotation', true),
      createModeButton('knn', false),
      createModeButton('proximity', false),
      createModeButton('lasso', false)
    ],
    modeDescription
  };
  const controls = withDocument(documentStub, () => initHighlightControls({
    state,
    viewer,
    dom,
    jupyterSource: null
  }));
  return { controls, documentStub, dom, state, viewer };
}

test(
  'each pane answers with its own field kind, whichever view has focus',
  () => {
    const { controls, documentStub, state, viewer } = buildControls();
    withDocument(documentStub, () => {
      assert.equal(viewer.fieldKindSourceWrites, 1);
      const kindOf = viewer.fieldKindSource;

      // The focused view is colored by nothing; a kept view by a category.
      state.activeViewId = 'live';
      state.setFieldForView('kept', CATEGORY_FIELD);
      assert.equal(kindOf('live'), 'none');
      assert.equal(
        kindOf('kept'),
        'categorical',
        'a pane with a field must not read as the focused view\'s "none"'
      );

      // Moving focus changes no pane's answer.
      state.activeViewId = 'kept';
      assert.equal(kindOf('live'), 'none');
      assert.equal(kindOf('kept'), 'categorical');
      controls.destroy();
    });
  }
);

test(
  'a field change by any path is seen at the next question, with nothing '
  + 'republished',
  () => {
    const { controls, documentStub, state, viewer } = buildControls();
    withDocument(documentStub, () => {
      const kindOf = viewer.fieldKindSource;
      // A dataset's default state, Load State and a Jupyter command assign the
      // field directly; the field selector's change event never fires.
      state.setFieldForView('live', CATEGORY_FIELD);
      assert.equal(kindOf('live'), 'categorical');
      state.setFieldForView('live', CONTINUOUS_FIELD);
      assert.equal(kindOf('live'), 'continuous');
      state.setFieldForView('live', null);
      assert.equal(kindOf('live'), 'none');
      assert.equal(
        viewer.fieldKindSourceWrites,
        1,
        'the source is wired once; a field change publishes nothing to the '
        + 'renderer, so nothing can throw away a gesture in progress'
      );
      controls.destroy();
    });
  }
);

test('an unknown field kind is refused rather than read as "none"', () => {
  const { controls, documentStub, state, viewer } = buildControls();
  withDocument(documentStub, () => {
    state.setFieldForView('live', { key: 'x', kind: 'ordinal' });
    assert.throws(
      () => viewer.fieldKindSource('live'),
      /Unknown annotation field kind: ordinal/
    );
    controls.destroy();
  });
});

test('a retired panel stops the viewer reading its state', () => {
  const { controls, documentStub, state, viewer } = buildControls();
  withDocument(documentStub, () => {
    state.setFieldForView('live', CATEGORY_FIELD);
    controls.destroy();
    state.reads.length = 0;
    assert.equal(viewer.fieldKindSource('live'), 'none');
    assert.deepEqual(
      state.reads,
      [],
      'a retired panel must not keep answering for a viewer it no longer owns'
    );
  });
});

test('no single highlight mode survives anywhere', async () => {
  // A cached mode is the defect this contract replaces: it was derived from
  // the focused view and gated every pane. Nothing may publish or read one.
  for (const name of ['setHighlightMode', 'getHighlightMode']) {
    assert.equal(name in HighlightTools.prototype, false, name);
  }
  for (const relative of [
    '../assets/js/rendering/highlight-renderer.js',
    '../assets/js/rendering/viewer.js',
    '../assets/js/app/ui/modules/highlight-controls.js',
    '../assets/js/app/ui/core/ui-coordinator.js'
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /highlightMode\b|HighlightMode\(/, relative);
  }
});
