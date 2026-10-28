import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createViewerHostCommandHandlers,
} from '../assets/js/app/viewer-host-command-handler.js';
import {
  DataStateFilterMethods,
} from '../assets/js/app/state/managers/filter-manager.js';
import {
  DataState,
} from '../assets/js/app/state/core/data-state.js';
import { orderedCellIdentity } from './helpers/ordered-cell-identity.mjs';

/**
 * What the handlers take beside the state: the dataset's cells (all open, never in
 * their original order: of 5 cells, open cell i is original position [4, 0, 3, 1, 2][i]),
 * results, the host's name.
 */
function hostOptions(state, results = { answer() {} }) {
  return {
    getCellIdentity: () => orderedCellIdentity({ nObs: state.pointCount }),
    getShownHostDataset: () => 'example',
    results,
    getHostLabel: () => 'Python',
  };
}

test('Viewer host commands mutate the exact current viewer state', async () => {
  const calls = [];
  const fields = [
    { key: 'cell_type', loaded: false },
    { key: 'score', loaded: true },
  ];
  const state = {
    pointCount: 5,
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
    clearHighlightsOnAllPages() {
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
  const handlers = createViewerHostCommandHandlers({
    state,
    viewer,
    refreshUi,
    reportDataMapping: async () => false,
    ...hostOptions(state),
  });

  handlers.handleHighlight(Uint32Array.of(1, 2), '#00ff00', null);
  await handlers.handleMessage({
    type: 'setColorBy',
    field: 'cell_type',
    viewerId: 'viewer-1',
    viewerToken: 'secret-1',
  });
  await handlers.handleMessage({
    type: 'setVisibility',
    cells: Uint32Array.of(2),
    visible: false,
    viewerId: 'viewer-1',
    viewerToken: 'secret-1',
  });
  await handlers.handleMessage({
    type: 'resetCamera',
    viewerId: 'viewer-1',
    viewerToken: 'secret-1',
  });
  handlers.handleHighlight(null, null, null);

  assert.deepEqual(calls, [
    'ensure-page',
    ['page-color', 'page-1', '#00ff00'],
    ['add-highlight', {
      type: 'annotation',
      label: 'Python selection (2 cells)',
      // Original positions 1 and 2 are open cells 3 and 4.
      cellIndices: Uint32Array.of(3, 4),
    }],
    ['load-field', 0],
    ['active-field', 0],
    'refresh-ui',
    ['visibility', Uint32Array.of(4), false],
    'reset-camera',
    'clear-highlights',
  ]);
});

test('Viewer host highlight uses the current DataState highlight contract', () => {
  const state = new DataState({}, null);
  state.pointCount = 5;
  state.highlightArray = new Uint8Array(5);
  const handlers = createViewerHostCommandHandlers({
    state,
    viewer: {},
    refreshUi() {},
    reportDataMapping: async () => false,
    ...hostOptions(state),
  });

  const cells = Uint32Array.of(1, 3);
  handlers.handleHighlight(cells, '#123abc', null);

  const page = state.getActivePage();
  assert.equal(page.color, '#123abc');
  assert.equal(page.highlightedGroups.length, 1);
  const [group] = page.highlightedGroups;
  assert.ok(
    group.cellIndices instanceof Uint32Array,
    'a direct highlight owns its cells as a Uint32Array'
  );
  assert.deepEqual({ ...group, cellIndices: [...group.cellIndices] }, {
    id: 'highlight_1',
    type: 'annotation',
    label: 'Python selection (2 cells)',
    enabled: true,
    // Original positions 1 and 3 are open cells 3 and 2.
    cellIndices: [2, 3],
    cellCount: 2,
  });
  assert.deepEqual([...state.highlightArray], [0, 0, 255, 255, 0]);
});

test('Viewer host highlight refuses cells that are not one cell list of this dataset', () => {
  const state = new DataState({}, null);
  state.pointCount = 5;
  state.highlightArray = new Uint8Array(5);
  const handlers = createViewerHostCommandHandlers({
    state,
    viewer: {},
    refreshUi() {},
    reportDataMapping: async () => false,
    ...hostOptions(state),
  });
  assert.throws(() => handlers.handleHighlight(Uint32Array.of(1, 5), '#123abc'), /outside the 5 cells of the dataset/);
  assert.throws(() => handlers.handleHighlight([1, 2], '#123abc'), /cell list/);
  assert.throws(() => handlers.handleHighlight(new Uint32Array(0), '#123abc'), /cell list/);
  assert.throws(() => handlers.handleHighlight(Uint32Array.of(1), null, null), /names no cells/);
  assert.equal(state.getActivePage()?.highlightedGroups?.length ?? 0, 0);
});

test('Viewer host color-by rejects absent or ambiguous fields atomically', async () => {
  let loadCalls = 0;
  const handlers = createViewerHostCommandHandlers({
    state: {
      pointCount: 0,
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
    reportDataMapping: async () => false,
    ...hostOptions({ pointCount: 0 }),
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

test('manual viewer host visibility composes with current filters', () => {
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
      categoryTransparency: new Uint8Array([1, 1, 1]),
      cellVisibilityMask: new Uint8Array([1, 1, 1]),
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

const NOTEBOOK_MAPPING = Object.freeze({
  kind: 'anndata',
  embeddings: { '1d': null, '2d': { key: 'X_pca', columns: [0, 1] }, '3d': null },
  knn: null,
  geneNames: 'index',
  expression: 'X',
  log1p: {},
  highlyVariable: null,
  latent: null,
  vectorFields: [],
});

test('setDataMapping applies one transaction, then answers the request it names', async () => {
  const calls = [];
  let current = null;
  const handlers = createViewerHostCommandHandlers({
    state: {
      async applyDataMapping(mapping, options) {
        calls.push(['apply', mapping, options]);
        current = mapping;
        return true;
      },
      getDataMapping() {
        return current;
      },
    },
    viewer: {},
    refreshUi() {
      calls.push('refresh-ui');
    },
    async reportDataMapping(report) {
      calls.push(['report', report]);
      return true;
    },
    ...hostOptions({ pointCount: 0 }),
  });
  await handlers.handleMessage({
    type: 'setDataMapping',
    requestId: 'req-1',
    mapping: NOTEBOOK_MAPPING,
    viewerId: 'viewer-1',
    viewerToken: 'secret-1',
  });
  assert.deepEqual(calls, [
    ['apply', NOTEBOOK_MAPPING, { origin: 'notebook' }],
    'refresh-ui',
    ['report', { origin: 'notebook', requestId: 'req-1', mapping: NOTEBOOK_MAPPING }],
  ]);
});

test('a refused setDataMapping reports nothing and rejects for command_error', async () => {
  let reported = 0;
  const handlers = createViewerHostCommandHandlers({
    state: {
      async applyDataMapping() {
        throw new RangeError('obsp[\'distances\'] is not symmetric');
      },
      getDataMapping: () => NOTEBOOK_MAPPING,
    },
    viewer: {},
    refreshUi() {},
    async reportDataMapping() {
      reported += 1;
      return true;
    },
    ...hostOptions({ pointCount: 0 }),
  });
  await assert.rejects(
    handlers.handleMessage({
      type: 'setDataMapping',
      requestId: 'req-2',
      mapping: NOTEBOOK_MAPPING,
      viewerId: 'viewer-1',
      viewerToken: 'secret-1',
    }),
    /not symmetric/,
  );
  assert.equal(reported, 0);
});

test('Viewer host command handlers require the data-mapping reporter', () => {
  assert.throws(
    () => createViewerHostCommandHandlers({ state: {}, viewer: {}, refreshUi() {} }),
    /reportDataMapping/,
  );
});

test('a pushed column, a gene set and a results request reach the viewer state and are answered', async () => {
  const answered = [];
  const results = {
    answer(requestId, kind, id) { answered.push(['answer', requestId, kind, id]); },
  };
  const state = new DataState({}, null);
  state.pointCount = 4;
  state.obsData = { fields: [] };
  const upserts = [];
  state.upsertUserDefinedContinuousField = options => {
    upserts.push(['continuous', options]);
    return { fieldIndex: 0, fieldId: 'user_obs_value_1', key: options.key, updatedInPlace: false };
  };
  state.upsertUserDefinedCategoricalField = options => {
    upserts.push(['categorical', options]);
    state.obsData.fields.push({
      key: options.key, kind: 'category', categories: options.categories, _isUserDefined: true,
      _userDefinedId: 'user_cat_1', _operation: options.meta._operation,
    });
    return { fieldIndex: state.obsData.fields.length - 1, key: options.key, updatedInPlace: false };
  };
  // A subsample of 4 of the dataset's 10 cells, opened in the order 8, 1, 5, 3:
  // the column is gathered to them, in that order.
  const identity = orderedCellIdentity({ nObs: 10, kept: [1, 3, 5, 8] });
  const handlers = createViewerHostCommandHandlers({
    state,
    viewer: {},
    refreshUi() {},
    reportDataMapping: async () => false,
    getCellIdentity: () => identity,
    getShownHostDataset: () => 'example',
    results,
    getHostLabel: () => 'R',
  });
  await handlers.handleMessage({
    type: 'setField', requestId: 'r1', key: 'score', kind: 'continuous', categories: null,
    nObs: 10, cells: Uint32Array.of(3, 4, 8), values: Float32Array.of(0.5, 9, -1),
  });
  assert.deepEqual([...upserts[0][1].values], [-1, NaN, NaN, 0.5]);
  assert.deepEqual(upserts[0][1].operation, { type: 'notebook-push' });
  await handlers.handleMessage({
    type: 'setField', requestId: 'r2', key: 'leiden', kind: 'categorical', categories: ['a', 'b'],
    nObs: 10, cells: null, values: Uint16Array.of(0, 1, 0, 65535, 1, 0, 0, 0, 1, 0),
  });
  // Codes narrowed to the storage of two categories, "no category" carried across.
  assert.ok(upserts[1][1].codes instanceof Uint8Array);
  assert.deepEqual([...upserts[1][1].codes], [1, 1, 0, 255]);
  await assert.rejects(
    handlers.handleMessage({
      type: 'setField', requestId: 'r3', key: 'x', kind: 'continuous', categories: null,
      nObs: 11, cells: null, values: new Float32Array(11),
    }),
    /another dataset/,
  );
  state.obsData.fields.push({ key: 'cell_type', kind: 'category', categories: ['a'] });
  await assert.rejects(
    handlers.handleMessage({
      type: 'setField', requestId: 'r4', key: 'cell_type', kind: 'categorical', categories: ['a'],
      nObs: 10, cells: null, values: new Uint8Array(10),
    }),
    /exists already/,
  );
  await handlers.handleMessage({ type: 'setGeneSet', requestId: 'r5', name: 'T', description: '', genes: ['CD3E'] });
  assert.deepEqual(answered, [
    ['answer', 'r1', 'continuous', 'user_obs_value_1'],
    ['answer', 'r2', 'categorical', 'user_cat_1'],
    ['answer', 'r5', 'geneSet', 'gene_set_1'],
  ]);
  assert.deepEqual(state.getDerivedResults().toSessionRecord(), [{ name: 'T', description: '', genes: ['CD3E'] }]);
});

test('a highlight names original positions: only the open ones are highlighted', () => {
  const state = new DataState({}, null);
  state.pointCount = 3;
  state.highlightArray = new Uint8Array(3);
  const handlers = createViewerHostCommandHandlers({
    state,
    viewer: {},
    refreshUi() {},
    reportDataMapping: async () => false,
    // Cells 0, 2, 4 of 6, opened in the order 4, 0, 2.
    getCellIdentity: () => orderedCellIdentity({ nObs: 6, kept: [0, 2, 4] }),
    getShownHostDataset: () => 'example',
    results: { answer() {} },
    getHostLabel: () => 'R',
  });
  handlers.handleHighlight(Uint32Array.of(1, 2, 4), '#123abc', 'Picked');
  const [group] = state.getActivePage().highlightedGroups;
  assert.equal(group.label, 'Picked');
  assert.deepEqual([...group.cellIndices], [0, 2]);
  assert.throws(() => handlers.handleHighlight(Uint32Array.of(1, 3), '#123abc', null), /None of the 2 cells/);
});

test('Commands that name cells are refused while the viewer shows another dataset', async () => {
  const state = new DataState({}, null);
  state.pointCount = 4;
  state.highlightArray = new Uint8Array(4);
  let shown = null;
  const answered = [];
  const handlers = createViewerHostCommandHandlers({
    state,
    viewer: {},
    refreshUi() {},
    reportDataMapping: async () => false,
    getCellIdentity: () => orderedCellIdentity({ nObs: 4 }),
    getShownHostDataset: () => shown,
    results: { answer(...args) { answered.push(args); } },
    getHostLabel: () => 'Python',
  });
  assert.throws(() => handlers.handleHighlight(Uint32Array.of(1), '#123abc', null), /dataset Python did not open/);
  await assert.rejects(
    handlers.handleMessage({ type: 'setVisibility', cells: Uint32Array.of(1), visible: false }),
    /dataset Python did not open/
  );
  await assert.rejects(
    handlers.handleMessage({
      type: 'setField', requestId: 'r1', key: 'leiden', kind: 'categorical', categories: ['a'],
      nObs: 4, cells: null, values: Uint8Array.of(0, 0, 0, 0),
    }),
    /pushed column "leiden"/
  );
  await assert.rejects(
    handlers.handleMessage({ type: 'setGeneSet', requestId: 'r2', name: 'T', description: '', genes: ['CD3E'] }),
    /gene set "T"/
  );
  assert.deepEqual(answered, []);
  shown = 'example';
  handlers.handleHighlight(Uint32Array.of(1), '#123abc', null);
});
