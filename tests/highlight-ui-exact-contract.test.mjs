import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { initHighlightControls } from '../assets/js/app/ui/modules/highlight-controls.js';
import { initAnnotationSelection } from '../assets/js/app/ui/modules/highlight/annotation-selection.js';
import { initContinuousSelectionPreview } from '../assets/js/app/ui/modules/highlight/continuous-selection-preview.js';
import { initHighlightPagesUI } from '../assets/js/app/ui/modules/highlight/highlight-pages-ui.js';
import { initHighlightSelectionTools } from '../assets/js/app/ui/modules/highlight/highlight-selection-tools.js';
import { initHighlightSummaryUI } from '../assets/js/app/ui/modules/highlight/highlight-summary-ui.js';
import { initLassoSelection } from '../assets/js/app/ui/modules/highlight/lasso-selection.js';
import { initHighlightModeUI } from '../assets/js/app/ui/modules/highlight/mode-ui.js';
import { createHighlightSelectionState } from '../assets/js/app/ui/modules/highlight/selection-state.js';
import { initHighlightSelectionSync } from '../assets/js/app/ui/modules/highlight/selection-sync.js';
import { highlightStateMethods } from '../assets/js/app/state/managers/highlight-manager.js';
import { viewContextCoreMethods } from '../assets/js/app/state/managers/view-context-core.js';
import {
  capture as captureHighlightCells,
  restore as restoreHighlightCells
} from '../assets/js/app/session/contributors/highlights-cells.js';
import {
  capture as captureHighlightMeta,
  restore as restoreHighlightMeta
} from '../assets/js/app/session/contributors/highlights-meta.js';
import {
  createSessionRestoreTransaction
} from '../assets/js/app/session/session-context.js';

const HIGHLIGHT_MODULE_ROOT = new URL(
  '../assets/js/app/ui/modules/highlight/',
  import.meta.url
);

function createDocumentStub() {
  const elements = new Map();
  return {
    body: {
      appendChild(element) {
        elements.set(element.id, element);
      }
    },
    createElement() {
      return {
        id: '',
        style: {},
        remove() {
          elements.delete(this.id);
        }
      };
    },
    getElementById(id) {
      return elements.get(id) ?? null;
    }
  };
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

function createModeButton(mode, pressed = false) {
  const attributes = new Map([
    ['aria-pressed', pressed ? 'true' : 'false']
  ]);
  const listeners = new Map();
  return {
    dataset: { mode },
    addEventListener(type, listener, options = {}) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          const remaining = (listeners.get(type) ?? [])
            .filter(candidate => candidate !== listener);
          listeners.set(type, remaining);
        }, { once: true });
      }
    },
    dispatch(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener({ target: this });
      }
    },
    listeners(type) {
      return [...(listeners.get(type) ?? [])];
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    }
  };
}

function createEventElement() {
  const listeners = new Map();
  return {
    children: [],
    dataset: {},
    style: {},
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    appendChild(child) {
      this.children.push(child);
    },
    dispatch(name, event = {}) {
      return listeners.get(name)(event);
    }
  };
}

function createModeViewer() {
  return {
    cancelAnnotationSelection() {},
    cancelUnifiedSelection() {},
    getUnifiedSelectionState() {
      return {
        inProgress: false,
        stepCount: 0,
        candidateCount: 0,
        candidates: []
      };
    },
    isKnnEdgesLoaded() {
      return true;
    },
    restoreUnifiedState() {},
    setKnnEnabled() {},
    setLassoEnabled() {},
    setProximityEnabled() {}
  };
}

function createCategoryHighlightState() {
  const field = {
    key: 'kind',
    kind: 'category',
    categories: ['normal', '', ' x ', 0, false],
    codes: Uint8Array.from([0, 1, 2, 3, 4])
  };
  const page = {
    id: 'page_1',
    name: 'Page 1',
    color: '#2563eb',
    highlightedGroups: []
  };
  const state = {
    pointCount: 5,
    obsData: { fields: [field] },
    varData: { fields: [] },
    categoryTransparency: Float32Array.from([1, 1, 1, 1, 1]),
    highlightPages: [page],
    activePageId: page.id,
    _highlightIdCounter: 0,
    _highlightPageIdCounter: 1,
    addHighlightFromCategory: highlightStateMethods.addHighlightFromCategory,
    getCellIndicesForCategory:
      highlightStateMethods.getCellIndicesForCategory,
    getHighlightPages() {
      return this.highlightPages;
    },
    getActivePageId() {
      return this.activePageId;
    },
    getHighlightedGroups() {
      return this.highlightPages[0].highlightedGroups;
    },
    getHighlightedCellCount() {
      return this.highlightPages[0].highlightedGroups.length;
    },
    getTotalHighlightedCellCount() {
      return this.highlightPages[0].highlightedGroups.length;
    },
    clearAllHighlights() {},
    removeHighlightGroup() {
      return true;
    },
    toggleHighlightEnabled() {
      return true;
    },
    _recomputeHighlightArray() {},
    _notifyHighlightPageChange() {},
    _notifyHighlightChange() {}
  };
  Object.defineProperty(state, 'highlightedGroups', {
    get() {
      return this.highlightPages[0].highlightedGroups;
    },
    set(groups) {
      this.highlightPages[0].highlightedGroups = groups;
    }
  });
  return state;
}

test('highlight modules expose one exact current UI contract without probes, timers, or alternate drag payloads', async () => {
  const filenames = [
    '../highlight-controls.js',
    'annotation-selection.js',
    'continuous-selection-preview.js',
    'exact-contract.js',
    'highlight-pages-ui.js',
    'highlight-selection-tools.js',
    'highlight-summary-ui.js',
    'knn-selection.js',
    'lasso-selection.js',
    'mode-ui.js',
    'proximity-selection.js',
    'selection-sync.js'
  ];
  const source = (
    await Promise.all(
      filenames.map(filename =>
        readFile(new URL(filename, HIGHLIGHT_MODULE_ROOT), 'utf8')
      )
    )
  ).join('\n');

  assert.doesNotMatch(source, /\?\./);
  assert.doesNotMatch(source, /\bset(?:Interval|Timeout)\s*\(/);
  assert.doesNotMatch(source, /dataTransfer\.setData\(['"]text\/plain['"]/);
  assert.doesNotMatch(source, /activeFieldSource\s*\|\|\s*['"]obs['"]/);
  assert.doesNotMatch(source, /_continuousStats\s*\|\|/);
  assert.doesNotMatch(source, /\.mode\s*\|\|\s*['"]intersect['"]/);
  assert.doesNotMatch(source, /\bmode:\s*['"]intersect['"]/);
  assert.doesNotMatch(source, /\bdegree:\s*0\b/);
});

test('category highlights preserve primitive identity through save, restore, and summary rendering', async () => {
  const sourceState = createCategoryHighlightState();
  for (let categoryIndex = 0; categoryIndex < 5; categoryIndex++) {
    sourceState.addHighlightFromCategory(0, categoryIndex, 'obs');
  }

  const expectedLabels = [
    'kind: normal',
    'kind: ""',
    'kind: " x "',
    'kind: 0',
    'kind: false'
  ];
  const expectedCategoryNames = ['normal', '', ' x ', 0, false];
  assert.deepEqual(
    sourceState.getHighlightedGroups().map(group => group.label),
    expectedLabels
  );
  assert.deepEqual(
    sourceState.getHighlightedGroups().map(group => group.categoryName),
    expectedCategoryNames
  );

  const [metaChunk] = captureHighlightMeta({ state: sourceState });
  const cellChunks = captureHighlightCells({ state: sourceState });
  const restoredState = createCategoryHighlightState();
  const restoreTransaction = createSessionRestoreTransaction();
  const restoreContext = {
    state: restoredState,
    abortSignal: null,
    restoreTransaction
  };
  restoreHighlightMeta(
    restoreContext,
    metaChunk,
    metaChunk.payload
  );
  for (const cellChunk of cellChunks) {
    const { payload, ...metadata } = cellChunk;
    await restoreHighlightCells(
      restoreContext,
      {
        ...metadata,
        storedBytes: payload.byteLength,
        uncompressedBytes: payload.byteLength
      },
      payload
    );
  }
  restoreTransaction.commit();

  const restoredGroups = restoredState.getHighlightedGroups();
  assert.deepEqual(
    restoredGroups.map(group => group.label),
    expectedLabels
  );
  assert.deepEqual(
    restoredGroups.map(group => group.categoryName),
    expectedCategoryNames
  );
  assert.ok(
    restoredGroups.every(group => group.cellIndices instanceof Uint32Array)
  );

  const countEl = createEventElement();
  const groupsEl = createEventElement();
  const clearButton = createEventElement();
  withDocument({
    createElement() {
      return createEventElement();
    }
  }, () => {
    const { renderHighlightSummary } = initHighlightSummaryUI({
      state: restoredState,
      dom: {
        countEl,
        groupsEl,
        clearAllBtn: clearButton
      }
    });
    renderHighlightSummary();
  });
  assert.equal(groupsEl.children.length, expectedLabels.length);
  assert.deepEqual(
    groupsEl.children.map(item => item.children[1].title),
    expectedLabels
  );
});

test('category highlight creation rejects missing or invalid category state atomically', () => {
  const missingSourceState = createCategoryHighlightState();
  assert.throws(
    () => missingSourceState.addHighlightFromCategory(0, 0),
    /field source/i
  );
  assert.equal(missingSourceState._highlightIdCounter, 0);
  assert.deepEqual(missingSourceState.getHighlightedGroups(), []);

  const invalidCategoryState = createCategoryHighlightState();
  invalidCategoryState.obsData.fields[0].categories[0] = null;
  let queryCount = 0;
  invalidCategoryState.getCellIndicesForCategory = () => {
    queryCount += 1;
    return [0];
  };
  assert.throws(
    () => invalidCategoryState.addHighlightFromCategory(0, 0, 'obs'),
    /category.*string.*finite number.*boolean/i
  );
  assert.equal(queryCount, 0);
  assert.equal(invalidCategoryState._highlightIdCounter, 0);
  assert.deepEqual(invalidCategoryState.getHighlightedGroups(), []);
});

test('highlight synchronization follows exact active-view LOD events and unsubscribes once', () => {
  const stateListeners = new Map();
  const unsubscribed = [];
  let groups = [];
  const state = {
    activeViewId: 'live',
    highlightArray: Uint8Array.from([0, 255]),
    getActiveViewId() {
      return this.activeViewId;
    },
    getHighlightedGroups() {
      return groups;
    },
    on(eventName, listener) {
      stateListeners.set(eventName, listener);
      return () => {
        unsubscribed.push(eventName);
      };
    }
  };
  let lodListener = null;
  const viewer = {
    onLodChanged(listener) {
      lodListener = listener;
      return () => {
        unsubscribed.push('lod');
      };
    }
  };
  let summaryRenders = 0;
  let pageRenders = 0;
  const sync = initHighlightSelectionSync({
    state,
    viewer,
    renderHighlightSummary() {
      summaryRenders += 1;
    },
    renderHighlightPages() {
      pageRenders += 1;
    }
  });

  lodListener(Object.freeze({
    dimensionLevel: 2,
    geometryGeneration: 1,
    lodLevel: 2,
    viewId: 'snapshot_1'
  }));
  lodListener(Object.freeze({
    dimensionLevel: 2,
    geometryGeneration: 1,
    lodLevel: 2,
    viewId: 'live'
  }));
  assert.equal(summaryRenders, 0);

  groups = [{ id: 'highlight_1' }];
  lodListener(Object.freeze({
    dimensionLevel: 3,
    geometryGeneration: 2,
    lodLevel: 3,
    viewId: 'live'
  }));
  assert.equal(summaryRenders, 1);

  assert.throws(
    () => lodListener({
      dimensionLevel: 2,
      geometryGeneration: 3,
      lodLevel: 4,
      viewId: 'live'
    }),
    /LOD change event must be frozen/i
  );

  stateListeners.get('highlight:changed')();
  assert.equal(summaryRenders, 2);
  assert.equal(pageRenders, 1);

  stateListeners.get('page:changed')();
  assert.equal(summaryRenders, 3);
  assert.equal(pageRenders, 2);

  sync.destroy();
  sync.destroy();
  assert.deepEqual(
    unsubscribed.sort(),
    ['highlight:changed', 'lod', 'page:changed']
  );
});

test('selection-tool destruction retires subscriptions and fences retained callbacks', () => {
  const stateListeners = new Map();
  const viewerCallbacks = new Map();
  const unsubscribeCalls = [];
  const mutations = [];
  const state = {
    activeFieldIndex: -1,
    activeFieldSource: null,
    activeVarFieldIndex: -1,
    addHighlightDirect() {
      mutations.push('add');
      return null;
    },
    clearPreviewHighlight() {
      mutations.push('clear');
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
      return [];
    },
    getValueForCell() {
      return Number.NaN;
    },
    on(eventName, listener) {
      stateListeners.set(eventName, listener);
      return () => unsubscribeCalls.push(eventName);
    },
    setPreviewHighlightFromIndices() {
      mutations.push('preview');
    }
  };
  const viewer = {
    cancelAnnotationSelection() {
      mutations.push('cancelAnnotation');
    },
    cancelKnnSelection() {
      mutations.push('cancelKnn');
    },
    cancelLassoSelection() {
      mutations.push('cancelLasso');
    },
    cancelProximitySelection() {
      mutations.push('cancelProximity');
    },
    cancelUnifiedSelection() {
      mutations.push('cancelUnified');
    },
    confirmAnnotationSelection() {
      mutations.push('confirmAnnotation');
    },
    confirmKnnSelection() {
      mutations.push('confirmKnn');
    },
    confirmLassoSelection() {
      mutations.push('confirmLasso');
    },
    confirmProximitySelection() {
      mutations.push('confirmProximity');
    },
    getUnifiedSelectionState() {
      return {
        inProgress: false,
        stepCount: 0,
        candidateCount: 0,
        candidates: []
      };
    },
    getViewTransparency() {
      return new Float32Array();
    },
    onLodChanged(listener) {
      viewerCallbacks.set('lod', listener);
      return () => unsubscribeCalls.push('lod');
    },
    restoreKnnState() {},
    restoreLassoState() {},
    restoreProximityState() {},
    restoreUnifiedState() {},
    setKnnCallback(listener) {
      viewerCallbacks.set('knn', listener);
    },
    setKnnEnabled() {
      mutations.push('knnMode');
    },
    setKnnPreviewCallback(listener) {
      viewerCallbacks.set('knnPreview', listener);
    },
    setKnnStepCallback(listener) {
      viewerCallbacks.set('knnStep', listener);
    },
    setLassoCallback(listener) {
      viewerCallbacks.set('lasso', listener);
    },
    setLassoEnabled() {
      mutations.push('lassoMode');
    },
    setLassoPreviewCallback(listener) {
      viewerCallbacks.set('lassoPreview', listener);
    },
    setLassoStepCallback(listener) {
      viewerCallbacks.set('lassoStep', listener);
    },
    setProximityCallback(listener) {
      viewerCallbacks.set('proximity', listener);
    },
    setProximityEnabled() {
      mutations.push('proximityMode');
    },
    setProximityPreviewCallback(listener) {
      viewerCallbacks.set('proximityPreview', listener);
    },
    setProximityStepCallback(listener) {
      viewerCallbacks.set('proximityStep', listener);
    },
    setSelectionPreviewCallback(listener) {
      viewerCallbacks.set('continuousPreview', listener);
    },
    setSelectionStepCallback(listener) {
      viewerCallbacks.set('annotationStep', listener);
    },
    updateHighlight() {}
  };
  const buttons = [
    createModeButton('annotation', true),
    createModeButton('knn'),
    createModeButton('proximity'),
    createModeButton('lasso')
  ];
  let summaryRenders = 0;
  let pageRenders = 0;

  withDocument(createDocumentStub(), () => {
    const tools = initHighlightSelectionTools({
      state,
      viewer,
      jupyterSource: null,
      dom: {
        modeButtons: buttons,
        modeDescription: {
          innerHTML: '',
          parentElement: { appendChild() {} },
          style: {},
          textContent: ''
        }
      },
      renderHighlightSummary() {
        summaryRenders += 1;
      },
      renderHighlightPages() {
        pageRenders += 1;
      }
    });
    const retained = new Map(viewerCallbacks);
    const retainedModeListener = buttons[1].listeners('click')[0];
    mutations.length = 0;

    tools.destroy();
    tools.destroy();

    assert.deepEqual(
      unsubscribeCalls.sort(),
      ['highlight:changed', 'lod', 'page:changed']
    );
    assert.equal(buttons[1].listeners('click').length, 0);

    stateListeners.get('highlight:changed')();
    stateListeners.get('page:changed')();
    retained.get('lod')({ malformed: true });
    retained.get('annotationStep')({ malformed: true });
    retained.get('continuousPreview')({ malformed: true });
    retained.get('lasso')({ malformed: true });
    retained.get('lassoPreview')({ malformed: true });
    retained.get('lassoStep')({ malformed: true });
    retained.get('proximity')({ malformed: true });
    retained.get('proximityPreview')({ malformed: true });
    retained.get('proximityStep')({ malformed: true });
    retained.get('knn')({ malformed: true });
    retained.get('knnPreview')({ malformed: true });
    retained.get('knnStep')({ malformed: true });
    retainedModeListener();

    assert.deepEqual(mutations, []);
    assert.equal(summaryRenders, 0);
    assert.equal(pageRenders, 0);
  });
});

test('active-view switches invalidate visible-highlight counts for the new transparency scope', () => {
  const pointCount = 4;
  let visibilityEvents = 0;
  const state = {
    pointCount,
    obsData: { fields: [] },
    varData: { fields: [] },
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    activeFieldSource: null,
    activeDimensionLevel: 2,
    activeViewId: 'live',
    colorsArray: new Uint8Array(pointCount * 4),
    categoryTransparency: Float32Array.from([1, 1, 1, 1]),
    cellVisibilityMask: Float32Array.from([1, 1, 1, 1]),
    outlierQuantilesArray: Float32Array.from([-1, -1, -1, -1]),
    centroidPositions: new Float32Array(),
    centroidColors: new Uint8Array(),
    centroidOutliers: new Float32Array(),
    centroidLabels: [],
    filteredCount: { shown: pointCount, total: pointCount },
    viewContexts: new Map(),
    dimensionManager: null,
    highlightArray: Uint8Array.from([255, 255, 0, 0]),
    _highlightedCellIndices: [0, 1],
    _cachedHighlightCount: null,
    _cachedHighlightLodMembership: null,
    _cachedTotalHighlightCount: null,
    viewer: {
      getCurrentLodMembership() {
        return null;
      },
      setViewLayout() {}
    },
    _cloneFieldState: viewContextCoreMethods._cloneFieldState,
    _cloneObsData: viewContextCoreMethods._cloneObsData,
    _cloneVarData: viewContextCoreMethods._cloneVarData,
    _buildContextFromCurrent: viewContextCoreMethods._buildContextFromCurrent,
    _syncActiveContext: viewContextCoreMethods._syncActiveContext,
    setActiveView: viewContextCoreMethods.setActiveView,
    getActiveViewId: viewContextCoreMethods.getActiveViewId,
    getHighlightedCellCount: highlightStateMethods.getHighlightedCellCount,
    _invalidateHighlightCountCache:
      highlightStateMethods._invalidateHighlightCountCache,
    getViewDimensionLevel() {
      return this.activeDimensionLevel;
    },
    _notifyVisibilityChange() {
      visibilityEvents += 1;
      this._invalidateHighlightCountCache(true);
    },
    _applyOverlaysToFields() {},
    _injectUserDefinedFields() {},
    _ensureActiveSelectionNotDeleted() {},
    _reinitializeActiveField() {},
    _rebuildLabelLayerFromCentroids() {},
    _pushColorsToViewer() {},
    _pushTransparencyToViewer() {},
    _pushCentroidsToViewer() {},
    updateFilterSummary() {}
  };

  const liveContext = state._buildContextFromCurrent('live', {
    cloneArrays: true
  });
  state.categoryTransparency = Float32Array.from([0, 0, 1, 1]);
  state.cellVisibilityMask = Float32Array.from([0, 0, 1, 1]);
  state.filteredCount = { shown: 2, total: pointCount };
  const snapshotContext = state._buildContextFromCurrent('snapshot_1', {
    cloneArrays: true
  });
  state.categoryTransparency = Float32Array.from(
    liveContext.categoryTransparency
  );
  state.cellVisibilityMask = Float32Array.from(liveContext.cellVisibilityMask);
  state.filteredCount = { ...liveContext.filteredCount };
  state.viewContexts.set('live', liveContext);
  state.viewContexts.set('snapshot_1', snapshotContext);

  state.setActiveView('snapshot_1');
  assert.equal(state.getHighlightedCellCount(), 0);
  state.setActiveView('live');
  assert.equal(state.getHighlightedCellCount(), 2);
  assert.equal(visibilityEvents, 2);
});

test('highlight controls reject missing current owners before touching UI state', () => {
  withDocument(createDocumentStub(), () => {
    assert.throws(
      () => initHighlightControls({
        state: {},
        viewer: {},
        dom: {},
        jupyterSource: null
      }),
      /highlight state.*getActiveField/i
    );
  });
});

test('highlight pages reject alternate page schemas before rebuilding the tab strip', () => {
  let appendedTabs = 0;
  const tabs = {
    innerHTML: '',
    appendChild() {
      appendedTabs += 1;
    },
    querySelectorAll() {
      return [];
    },
    setAttribute() {
    }
  };
  const addButton = {
    addEventListener() {}
  };
  const page = {
    id: 'page_1',
    name: 'Page 1',
    color: '#2563eb',
    highlightedGroups: [],
    legacyColor: '#000000'
  };
  const state = {
    combineHighlightPages() {},
    createHighlightPage() {},
    deleteHighlightPage() {},
    ensureHighlightPage() {},
    getActivePageId() {
      return page.id;
    },
    getHighlightedCellCountForPage() {
      return 0;
    },
    getHighlightPages() {
      return [page];
    },
    renameHighlightPage() {},
    setHighlightPageColor() {},
    switchToPage() {}
  };

  withDocument({
    addEventListener() {},
    body: { appendChild() {} },
    createElement() {
      return {};
    },
    getElementById() {
      return null;
    },
    removeEventListener() {}
  }, () => {
    assert.throws(
      () => initHighlightPagesUI({
        state,
        dom: {
          pagesTabsEl: tabs,
          addPageBtn: addButton
        }
      }),
      /highlight page.*exactly/i
    );
  });
  assert.equal(appendedTabs, 0);
});

test('highlight summary rejects state-operation no-ops instead of accepting them', () => {
  const countEl = createEventElement();
  const groupsEl = createEventElement();
  const clearButton = createEventElement();
  const group = {
    id: 'highlight_1',
    type: 'lasso',
    label: 'Lasso (1 cell)',
    enabled: true,
    cellIndices: [0],
    cellCount: 1
  };
  const state = {
    clearAllHighlights() {},
    getHighlightedCellCount() {
      return 1;
    },
    getHighlightedGroups() {
      return [group];
    },
    getTotalHighlightedCellCount() {
      return 1;
    },
    removeHighlightGroup() {
      return false;
    },
    toggleHighlightEnabled() {
      return false;
    }
  };

  withDocument({
    createElement() {
      return createEventElement();
    }
  }, () => {
    const { renderHighlightSummary } = initHighlightSummaryUI({
      state,
      dom: {
        countEl,
        groupsEl,
        clearAllBtn: clearButton
      }
    });
    renderHighlightSummary();
    const renderedGroup = groupsEl.children[0];
    const checkbox = renderedGroup.children[0];
    checkbox.checked = false;
    assert.throws(
      () => checkbox.dispatch('change'),
      /toggle.*rejected/i
    );
    const removeButton = renderedGroup.children[2];
    assert.throws(
      () => removeButton.dispatch('click', { stopPropagation() {} }),
      /removal.*rejected/i
    );
  });
});

test('highlight summary rejects alternate group schemas before mutating the DOM', () => {
  const countEl = createEventElement();
  const groupsEl = createEventElement();
  const clearButton = createEventElement();
  const group = {
    id: 'highlight_1',
    type: 'lasso',
    label: 'Lasso (1 cell)',
    enabled: true,
    cellIndices: [0],
    cellCount: 1,
    legacySource: 'lasso'
  };
  const state = {
    clearAllHighlights() {},
    getHighlightedCellCount() {
      return 1;
    },
    getHighlightedGroups() {
      return [group];
    },
    getTotalHighlightedCellCount() {
      return 1;
    },
    removeHighlightGroup() {
      return true;
    },
    toggleHighlightEnabled() {
      return true;
    }
  };

  withDocument({
    createElement() {
      return createEventElement();
    }
  }, () => {
    const { renderHighlightSummary } = initHighlightSummaryUI({
      state,
      dom: {
        countEl,
        groupsEl,
        clearAllBtn: clearButton
      }
    });
    assert.throws(
      () => renderHighlightSummary(),
      /highlight group.*exactly/i
    );
  });
  assert.equal(countEl.textContent, undefined);
  assert.equal(groupsEl.children.length, 0);
});

test('selection-tool composition preflights every viewer capability before registering callbacks', () => {
  let callbackRegistrations = 0;
  const state = new Proxy({}, {
    get(target, key) {
      if (Object.hasOwn(target, key)) return target[key];
      return () => {};
    }
  });
  const viewer = new Proxy({}, {
    get(target, key) {
      if (key === 'setLassoCallback') return undefined;
      if (key === 'setSelectionStepCallback') {
        return () => {
          callbackRegistrations += 1;
        };
      }
      if (Object.hasOwn(target, key)) return target[key];
      return () => {};
    }
  });
  const buttons = [
    createModeButton('annotation', true),
    createModeButton('knn'),
    createModeButton('proximity'),
    createModeButton('lasso')
  ];

  withDocument(createDocumentStub(), () => {
    assert.throws(
      () => initHighlightSelectionTools({
        state,
        viewer,
        jupyterSource: null,
        dom: {
          modeButtons: buttons,
          modeDescription: {
            parentElement: { appendChild() {} }
          }
        },
        renderHighlightSummary() {},
        renderHighlightPages() {}
      }),
      /selection viewer.*setLassoCallback/i
    );
  });
  assert.equal(callbackRegistrations, 0);
});

test('highlight mode rejects an unknown mode before mutating selection state', () => {
  const selectionState = createHighlightSelectionState();
  const buttons = [
    createModeButton('annotation', true),
    createModeButton('knn'),
    createModeButton('proximity'),
    createModeButton('lasso')
  ];
  const description = {
    innerHTML: '',
    parentElement: { appendChild() {} },
    style: {},
    textContent: ''
  };

  withDocument(createDocumentStub(), () => {
    const modeUi = initHighlightModeUI({
      viewer: createModeViewer(),
      dom: {
        modeButtons: buttons,
        modeDescription: description
      },
      selectionState,
      modeHandlers: {
        restoreAnnotationSelection() {},
        restoreKnnSelection() {},
        restoreLassoSelection() {},
        restoreProximitySelection() {}
      }
    });

    assert.throws(
      () => modeUi.setHighlightModeUI('retired-mode'),
      /unknown highlight selection mode/i
    );
    assert.equal(selectionState.activeMode, 'annotation');
  });
});

test('highlight mode requires exactly one explicitly pressed current-mode button', () => {
  const buttons = [
    createModeButton('annotation'),
    createModeButton('knn'),
    createModeButton('proximity'),
    createModeButton('lasso')
  ];
  const description = {
    innerHTML: '',
    parentElement: { appendChild() {} },
    style: {},
    textContent: ''
  };

  withDocument(createDocumentStub(), () => {
    assert.throws(
      () => initHighlightModeUI({
        viewer: createModeViewer(),
        dom: {
          modeButtons: buttons,
          modeDescription: description
        },
        selectionState: createHighlightSelectionState(),
        modeHandlers: {
          restoreAnnotationSelection() {},
          restoreKnnSelection() {},
          restoreLassoSelection() {},
          restoreProximitySelection() {}
        }
      }),
      /exactly one.*aria-pressed/i
    );
  });
});

test('malformed lasso events fail before history or permanent highlight mutation', () => {
  const selectionState = createHighlightSelectionState();
  const calls = [];
  let selectionCallback = null;
  const viewer = {
    cancelLassoSelection() {},
    confirmLassoSelection() {},
    restoreLassoState() {},
    setLassoCallback(callback) {
      selectionCallback = callback;
    },
    setLassoPreviewCallback() {},
    setLassoStepCallback() {}
  };
  const state = {
    addHighlightDirect() {
      calls.push('add');
      return {};
    },
    clearPreviewHighlight() {
      calls.push('clear');
    },
    setPreviewHighlightFromIndices() {
      calls.push('preview');
    }
  };

  withDocument(createDocumentStub(), () => {
    const { handleLassoStep } = initLassoSelection({
      state,
      viewer,
      jupyterSource: null,
      selectionState,
      ui: {
        modeDescriptionEl: {
          innerHTML: '',
          parentElement: { appendChild() {} }
        }
      }
    });

    assert.throws(
      () => handleLassoStep({
        step: 1,
        candidateCount: 1,
        candidates: [3]
      }),
      /lasso step.*mode/i
    );
    assert.deepEqual(selectionState.lassoHistory, []);
    assert.equal(selectionState.lastLassoCandidates, null);

    assert.throws(
      () => selectionCallback({
        type: 'lasso',
        cellIndices: [3],
        cellCount: 2,
        steps: 1
      }),
      /cellCount.*cellIndices/i
    );
    assert.deepEqual(calls, []);

    assert.throws(
      () => selectionCallback({
        type: 'lasso',
        cellIndices: [3],
        cellCount: 1,
        steps: 1
      }),
      /saved lasso highlight group/i
    );
    assert.deepEqual(calls, ['add']);
  });
});

test('selection destruction drains Jupyter delivery and suppresses late failure UI', async () => {
  let rejectDelivery;
  const delivery = new Promise((_resolve, reject) => {
    rejectDelivery = reject;
  });
  let selectionCallback = null;
  const viewer = {
    cancelLassoSelection() {},
    confirmLassoSelection() {},
    restoreLassoState() {},
    setLassoCallback(callback) {
      selectionCallback = callback;
    },
    setLassoPreviewCallback() {},
    setLassoStepCallback() {}
  };
  const state = {
    addHighlightDirect({ cellIndices }) {
      return {
        id: 'highlight_1',
        type: 'lasso',
        label: 'Lasso',
        enabled: true,
        cellIndices,
        cellCount: cellIndices.length
      };
    },
    clearPreviewHighlight() {},
    setPreviewHighlightFromIndices() {}
  };
  const notifications = getNotificationCenter();
  const originalError = notifications.error;
  const notificationCalls = [];
  notifications.error = (...args) => notificationCalls.push(args);
  const originalConsoleError = console.error;
  const consoleErrors = [];
  console.error = (...args) => consoleErrors.push(args);

  try {
    await withDocument(createDocumentStub(), async () => {
      const selection = initLassoSelection({
        state,
        viewer,
        jupyterSource: {
          notifySelection() {
            return delivery;
          }
        },
        selectionState: createHighlightSelectionState(),
        ui: {
          modeDescriptionEl: {
            innerHTML: '',
            parentElement: { appendChild() {} }
          }
        }
      });
      selectionCallback({
        type: 'lasso',
        cellIndices: [3],
        cellCount: 1,
        steps: 1
      });

      const destruction = selection.destroy();
      assert.equal(selection.destroy(), destruction);
      let settled = false;
      void destruction.then(() => {
        settled = true;
      });
      await Promise.resolve();
      assert.equal(settled, false);

      rejectDelivery(new Error('late delivery failure'));
      await destruction;
      assert.equal(settled, true);
      assert.deepEqual(notificationCalls, []);
      assert.deepEqual(consoleErrors, []);
    });
  } finally {
    notifications.error = originalError;
    console.error = originalConsoleError;
  }
});

test('annotation undo republishes the exact candidate state to the unified renderer', () => {
  const elements = new Map();
  const makeButton = id => {
    const button = createEventElement();
    button.id = id;
    elements.set(id, button);
    return button;
  };
  const descriptionParent = {
    appendChild(controls) {
      elements.set(controls.id, controls);
      for (const id of [
        'annotation-confirm-btn',
        'annotation-undo-btn',
        'annotation-redo-btn',
        'annotation-cancel-btn'
      ]) {
        makeButton(id);
      }
    }
  };
  const documentStub = {
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
  const field = {
    kind: 'category',
    codes: Uint8Array.from([0, 0, 1, 1]),
    categories: ['A', 'B']
  };
  const state = {
    activeFieldIndex: 0,
    activeFieldSource: 'obs',
    activeVarFieldIndex: -1,
    addHighlightDirect() {},
    clearPreviewHighlight() {},
    getActiveField() {
      return field;
    },
    getCategoryForCell(cellIndex) {
      return field.codes[cellIndex];
    },
    getCellIndicesForCategory(_fieldIndex, categoryIndex) {
      return field.codes.reduce((indices, code, cellIndex) => {
        if (code === categoryIndex) indices.push(cellIndex);
        return indices;
      }, []);
    },
    getCellIndicesForRange() {
      return [];
    },
    getValueForCell() {
      return Number.NaN;
    },
    setPreviewHighlightFromIndices() {}
  };
  const restoreCalls = [];
  const viewer = {
    cancelAnnotationSelection() {},
    confirmAnnotationSelection() {},
    getViewTransparency() {
      return Float32Array.from([1, 1, 1, 1]);
    },
    restoreUnifiedState(candidates, step) {
      restoreCalls.push({ candidates: [...candidates], step });
    },
    setSelectionStepCallback() {}
  };
  const step = (cellIndex, mode) => ({
    type: 'click',
    cellIndex,
    dragDeltaY: 0,
    startX: 10,
    startY: 10,
    endX: 10,
    endY: 10,
    mode,
    viewId: 'live'
  });

  withDocument(documentStub, () => {
    const { handleAnnotationStep } = initAnnotationSelection({
      state,
      viewer,
      jupyterSource: null,
      selectionState: createHighlightSelectionState(),
      ui: {
        modeDescriptionEl: {
          innerHTML: '',
          parentElement: descriptionParent
        },
        hideRangeLabel() {}
      }
    });
    handleAnnotationStep(step(0, 'intersect'));
    handleAnnotationStep(step(2, 'union'));
    assert.deepEqual(restoreCalls.at(-1), {
      candidates: [0, 1, 2, 3],
      step: 2
    });
    elements.get('annotation-undo-btn').dispatch('click');
    assert.deepEqual(restoreCalls.at(-1), {
      candidates: [0, 1],
      step: 1
    });
    elements.get('annotation-undo-btn').dispatch('click');
    assert.deepEqual(restoreCalls.at(-1), {
      candidates: [],
      step: 0
    });
    elements.get('annotation-redo-btn').dispatch('click');
    assert.deepEqual(restoreCalls.at(-1), {
      candidates: [0, 1],
      step: 1
    });
  });
});

test('continuous preview rejects missing published statistics before querying cells', () => {
  let previewCallback = null;
  let rangeCalls = 0;
  initContinuousSelectionPreview({
    state: {
      activeFieldIndex: 0,
      activeFieldSource: 'obs',
      activeVarFieldIndex: null,
      clearPreviewHighlight() {},
      getActiveField() {
        return { kind: 'continuous' };
      },
      getCellIndicesForRange() {
        rangeCalls += 1;
        return [];
      },
      getValueForCell() {
        return 2;
      },
      setPreviewHighlightFromIndices() {}
    },
    viewer: {
      getViewTransparency() {
        return new Float32Array([1]);
      },
      setSelectionPreviewCallback(callback) {
        previewCallback = callback;
      }
    },
    selectionState: createHighlightSelectionState(),
    ui: {
      hideRangeLabel() {},
      showRangeLabel() {}
    }
  });

  assert.throws(
    () => previewCallback({
      type: 'preview',
      cellIndex: 0,
      dragDeltaY: 1,
      startX: 1,
      startY: 1,
      endX: 2,
      endY: 2,
      mode: 'intersect',
      viewId: 'live'
    }),
    /continuous.*statistics/i
  );
  assert.equal(rangeCalls, 0);
});

test('continuous preview preflights the exact shared selection state before callback registration', () => {
  let callbackRegistrations = 0;
  assert.throws(
    () => initContinuousSelectionPreview({
      state: {
        clearPreviewHighlight() {},
        getActiveField() {
          return null;
        },
        getCellIndicesForRange() {
          return [];
        },
        getValueForCell() {
          return Number.NaN;
        },
        setPreviewHighlightFromIndices() {}
      },
      viewer: {
        getViewTransparency() {
          return new Float32Array();
        },
        setSelectionPreviewCallback() {
          callbackRegistrations += 1;
        }
      },
      selectionState: {},
      ui: {
        hideRangeLabel() {},
        showRangeLabel() {}
      }
    }),
    /highlight selection state.*exactly/i
  );
  assert.equal(callbackRegistrations, 0);
});
