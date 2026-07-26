import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createJupyterCommandHandlers,
} from '../assets/js/app/jupyter-command-handler.js';
import {
  DataStateFilterMethods,
} from '../assets/js/app/state/managers/filter-manager.js';
import {
  DataState,
} from '../assets/js/app/state/core/data-state.js';

test('Jupyter commands mutate the exact current viewer state', async () => {
  const calls = [];
  const fields = [
    { key: 'cell_type', loaded: false },
    { key: 'score', loaded: true },
  ];
  const state = {
    ensureHighlightPage() {
      calls.push('ensure-page');
    },
    getActivePage() {
      return { id: 'page-1' };
    },
    setHighlightPageColor(pageId, color) {
      calls.push(['page-color', pageId, color]);
      return true;
    },
    addHighlightDirect(group) {
      calls.push(['add-highlight', group]);
      return { id: 'highlight-1' };
    },
    clearAllHighlights() {
      calls.push('clear-highlights');
    },
    getFields() {
      return fields;
    },
    async ensureFieldLoaded(index) {
      calls.push(['load-field', index]);
      fields[index].loaded = true;
    },
    setActiveField(index) {
      calls.push(['active-field', index]);
      return { field: fields[index] };
    },
    setCellVisibility(cells, visible) {
      calls.push(['visibility', cells, visible]);
    },
  };
  const viewer = {
    resetCamera() {
      calls.push('reset-camera');
    },
  };
  const refreshUi = () => {
    calls.push('refresh-ui');
  };
  const handlers = createJupyterCommandHandlers({
    state,
    viewer,
    refreshUi,
  });

  handlers.handleHighlight([1, 2], '#00ff00');
  await handlers.handleMessage({
    type: 'setColorBy',
    field: 'cell_type',
    viewerId: 'viewer-1',
    viewerToken: 'secret-1',
  });
  await handlers.handleMessage({
    type: 'setVisibility',
    cells: [2],
    visible: false,
    viewerId: 'viewer-1',
    viewerToken: 'secret-1',
  });
  await handlers.handleMessage({
    type: 'resetCamera',
    viewerId: 'viewer-1',
    viewerToken: 'secret-1',
  });
  handlers.handleHighlight([], null);

  assert.deepEqual(calls, [
    'ensure-page',
    ['page-color', 'page-1', '#00ff00'],
    ['add-highlight', {
      type: 'annotation',
      label: 'Python selection (2 cells)',
      cellIndices: [1, 2],
    }],
    ['load-field', 0],
    ['active-field', 0],
    'refresh-ui',
    ['visibility', [2], false],
    'reset-camera',
    'clear-highlights',
  ]);
});

test('Jupyter highlight uses the current DataState highlight contract', () => {
  const state = new DataState({}, null);
  state.pointCount = 5;
  state.highlightArray = new Uint8Array(5);
  const handlers = createJupyterCommandHandlers({
    state,
    viewer: {},
    refreshUi() {},
  });

  handlers.handleHighlight([1, 3], '#123abc');

  const page = state.getActivePage();
  assert.equal(page.color, '#123abc');
  assert.deepEqual(page.highlightedGroups, [{
    id: 'highlight_1',
    type: 'annotation',
    label: 'Python selection (2 cells)',
    enabled: true,
    cellIndices: [1, 3],
    cellCount: 2,
  }]);
  assert.deepEqual([...state.highlightArray], [0, 255, 0, 255, 0]);
});

test('Jupyter color-by rejects absent or ambiguous fields atomically', async () => {
  let loadCalls = 0;
  const handlers = createJupyterCommandHandlers({
    state: {
      getFields: () => [{ key: 'duplicate' }, { key: 'duplicate' }],
      ensureFieldLoaded: async () => {
        loadCalls += 1;
      },
      setActiveField() {
        throw new Error('must not publish');
      },
    },
    viewer: { resetCamera() {} },
    refreshUi() {},
  });

  await assert.rejects(
    handlers.handleMessage({
      type: 'setColorBy',
      field: 'missing',
      viewerId: 'viewer-1',
      viewerToken: 'secret-1',
    }),
    /exactly one.*missing/i,
  );
  await assert.rejects(
    handlers.handleMessage({
      type: 'setColorBy',
      field: 'duplicate',
      viewerId: 'viewer-1',
      viewerToken: 'secret-1',
    }),
    /exactly one.*duplicate/i,
  );
  assert.equal(loadCalls, 0);
});

test('manual Jupyter visibility composes with current filters', () => {
  const state = Object.assign(
    Object.create(DataStateFilterMethods.prototype),
    {
      pointCount: 3,
      obsData: { fields: [] },
      varData: null,
      activeFieldSource: null,
      activeVarFieldIndex: -1,
      colorsArray: new Uint8Array([
        0, 0, 0, 255,
        0, 0, 0, 255,
        0, 0, 0, 255,
      ]),
      categoryTransparency: new Float32Array([1, 1, 1]),
      cellVisibilityMask: new Float32Array([1, 1, 1]),
      isOutlierFilterEnabledForActiveField: () => false,
      getCurrentOutlierThreshold: () => 1,
      _syncColorsAlpha() {},
      _updateActiveCategoryCounts: () => false,
      _pushTransparencyToViewer() {},
      _syncActiveContext() {},
      updateFilteredCount() {},
      updateFilterSummary() {},
      _notifyVisibilityChange() {},
    },
  );

  state.setCellVisibility([1], false);
  assert.deepEqual([...state.cellVisibilityMask], [1, 0, 1]);
  assert.deepEqual([...state.categoryTransparency], [1, 0, 1]);

  state.setCellVisibility(null, true);
  assert.deepEqual([...state.cellVisibilityMask], [1, 1, 1]);
  assert.deepEqual([...state.categoryTransparency], [1, 1, 1]);
  assert.throws(
    () => state.setCellVisibility([3], false),
    /outside.*point count/i,
  );
});
