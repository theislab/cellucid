/**
 * Exact publication contract for the renderer's highlight mode.
 *
 * `highlight-renderer.js` discards every Alt gesture while its `highlightMode`
 * is `'none'`, and that mode is nothing but a cache of the active field's kind.
 * Whoever activates a field therefore decides whether Alt+click works, and the
 * ways to activate one are not all the field selector: a published dataset's
 * default state, a loaded session and a Jupyter command all call
 * `state.setActiveField` directly and then refresh the UI. Each test here pins
 * one half of the invariant that keeps those paths honest — the mode follows
 * the field wherever the field came from, and it is not republished when it
 * has not changed, because republishing throws away a gesture in progress.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { initHighlightControls }
  from '../assets/js/app/ui/modules/highlight-controls.js';

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
 * A DataState stand-in whose active field is changed the way every non-selector
 * path changes it: assigned directly, then followed by the `visibility:changed`
 * every one of `setActiveField`, `setActiveVarField` and `clearActiveField`
 * emits through `computeGlobalVisibility()`.
 */
function createState() {
  const listeners = new Map();
  const page = {
    id: 'page_1',
    name: 'Page 1',
    color: '#2563eb',
    highlightedGroups: []
  };
  const state = {
    pointCount: POINT_COUNT,
    activeField: null,
    highlightPages: [page],
    activePageId: page.id,
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
      return state.activeField;
    },
    getActivePageId() {
      return state.activePageId;
    },
    getActiveViewId() {
      return 'view_1';
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
    /** Exactly what `computeGlobalVisibility()` publishes at its tail. */
    emitVisibilityChanged() {
      for (const listener of [...(listeners.get('visibility:changed') ?? [])]) {
        listener();
      }
    },
    /** What `setActiveField` / `setActiveVarField` / `clearActiveField` do. */
    activateFieldWithoutSelector(field) {
      state.activeField = field;
      state.emitVisibilityChanged();
    },
    listenerCount(eventName) {
      return (listeners.get(eventName) ?? []).length;
    }
  };
  return state;
}

function createViewer() {
  const modePublications = [];
  const viewer = {
    modePublications,
    highlightMode: 'none',
    getHighlightMode() {
      return viewer.highlightMode;
    },
    setHighlightMode(mode) {
      viewer.highlightMode = mode;
      modePublications.push(mode);
    },
    getViewTransparency() {
      return new Float32Array(POINT_COUNT).fill(1);
    },
    getUnifiedSelectionState() {
      return {
        inProgress: false,
        stepCount: 0,
        candidateCount: 0,
        candidates: []
      };
    },
    onLodChanged() {
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
    'setSelectionStepCallback'
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
    countEl: createElementStub('highlight-count'),
    groupsEl: createElementStub('highlighted-groups'),
    clearAllBtn: createElementStub('clear-highlights'),
    pagesTabsEl: createElementStub('highlight-pages-tabs'),
    addPageBtn: createElementStub('add-highlight-page'),
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
  'activating a field without the selector still reaches the renderer',
  () => {
    const { controls, documentStub, state, viewer } = buildControls();
    withDocument(documentStub, () => {
      // The app opens with no colouring field, which is the mode the renderer
      // is constructed with.
      assert.equal(viewer.getHighlightMode(), 'none');

      // A published dataset's default state, a loaded session and a Jupyter
      // command all land here: the field is assigned by DataState, and the
      // field selector's change event never fires.
      state.activateFieldWithoutSelector(CATEGORY_FIELD);
      assert.equal(
        viewer.getHighlightMode(),
        'categorical',
        'Alt+click is discarded by the renderer while the mode is "none"'
      );

      state.activateFieldWithoutSelector(CONTINUOUS_FIELD);
      assert.equal(viewer.getHighlightMode(), 'continuous');

      state.activateFieldWithoutSelector(null);
      assert.equal(viewer.getHighlightMode(), 'none');

      assert.deepEqual(
        viewer.modePublications,
        ['categorical', 'continuous', 'none']
      );
      controls.destroy();
    });
  }
);

test(
  'a visibility change that leaves the field alone publishes nothing',
  () => {
    const { controls, documentStub, state, viewer } = buildControls();
    withDocument(documentStub, () => {
      state.activateFieldWithoutSelector(CATEGORY_FIELD);
      assert.deepEqual(viewer.modePublications, ['categorical']);

      // Every filter change ends in `computeGlobalVisibility()` too, and
      // `setHighlightMode` drops `selectionDragStart` and resets the renderer's
      // annotation step counter — so republishing here would throw away a
      // gesture the user is still holding.
      for (let change = 0; change < 5; change++) state.emitVisibilityChanged();
      assert.deepEqual(viewer.modePublications, ['categorical']);

      // The eager path the field selector uses is idempotent for the same
      // reason.
      controls.updateHighlightMode();
      controls.updateHighlightMode();
      assert.deepEqual(viewer.modePublications, ['categorical']);
      controls.destroy();
    });
  }
);

test(
  'a divergence the renderer holds is corrected, not assumed absent',
  () => {
    const { controls, documentStub, state, viewer } = buildControls();
    withDocument(documentStub, () => {
      state.activateFieldWithoutSelector(CATEGORY_FIELD);
      assert.equal(viewer.getHighlightMode(), 'categorical');

      // The renderer is reset to 'none' by its own disposal path, and the
      // publisher reads the renderer rather than a local copy of what it last
      // sent, so the next visibility event repairs it.
      viewer.highlightMode = 'none';
      state.emitVisibilityChanged();
      assert.equal(viewer.getHighlightMode(), 'categorical');
      controls.destroy();
    });
  }
);

test(
  'the mode publisher releases its subscription with the controls',
  () => {
    const { controls, documentStub, state, viewer } = buildControls();
    withDocument(documentStub, () => {
      state.activateFieldWithoutSelector(CATEGORY_FIELD);
      assert.deepEqual(viewer.modePublications, ['categorical']);

      controls.destroy();
      assert.equal(
        state.listenerCount('visibility:changed'),
        0,
        'a retired panel must not keep writing to a viewer it no longer owns'
      );
      state.activateFieldWithoutSelector(CONTINUOUS_FIELD);
      assert.deepEqual(viewer.modePublications, ['categorical']);
    });
  }
);

test(
  'an unknown field kind is refused rather than published as "none"',
  () => {
    const { controls, documentStub, state } = buildControls();
    withDocument(documentStub, () => {
      state.activeField = { key: 'x', kind: 'ordinal' };
      assert.throws(
        () => controls.updateHighlightMode(),
        /Unknown active highlight field kind: ordinal/
      );
      controls.destroy();
    });
  }
);

test(
  'the mode publisher preflights the renderer capability it reads',
  async () => {
    const source = await readFile(
      new URL(
        '../assets/js/app/ui/modules/highlight-controls.js',
        import.meta.url
      ),
      'utf8'
    );
    // Reading the renderer's current mode is what makes the publisher
    // idempotent, so it belongs in the same preflight as setHighlightMode
    // rather than being discovered at the first visibility event.
    assert.match(source, /'getHighlightMode',\n\s*'setHighlightMode',/);
    assert.match(source, /state\.on\(\s*'visibility:changed',/);
  }
);
