import assert from 'node:assert/strict';
import test from 'node:test';

import { DataState } from '../assets/js/app/state/core/data-state.js';
import {
  createInMemoryDimensionManager,
} from '../assets/js/data/dimension-manager.js';

function makeTwoViewState() {
  const published = [];
  const state = new DataState(null, null);
  const recorded = {
    setLiveViewLabel(label) {
      published.push({ viewId: 'live', label });
    },
    updateSnapshotAttributes(viewId, attributes) {
      published.push({ viewId, ...structuredClone(attributes) });
    },
    getViewLayout() {
      return { mode: 'grid' };
    },
  };
  // Every other renderer publication is irrelevant to labels.
  state.viewer = new Proxy(recorded, {
    get(target, property) {
      return Object.hasOwn(target, property) ? target[property] : () => {};
    },
  });
  state.pointCount = 2;
  state.dimensionManager = createInMemoryDimensionManager({
    positions: new Float32Array(4),
    dimension: 2,
  });
  state.activeDimensionLevel = 2;
  state.cellVisibilityMask = new Uint8Array([1, 1]);
  state.categoryTransparency = new Uint8Array([1, 1]);
  state.colorsArray = new Uint8Array(8);
  state.obsData = {
    fields: [{
      key: 'leiden',
      kind: 'category',
      categories: ['a', 'b'],
      codes: new Uint16Array([0, 1]),
      centroidsByLayout: new Map(),
      loaded: true,
    }],
  };
  state.varData = { fields: [] };
  state.activeFieldIndex = 0;
  state.activeFieldSource = 'obs';
  state.obsData.fields[0]._categoryVisible = { 0: false, 1: true };
  state._resetViewContexts();
  state.createViewFromSource('live', 'snap_1');
  state.dimensionManager.copyViewLayout('live', 'snap_1');
  // The live view clears its own filter; the kept view still hides 'a'.
  state.obsData.fields[0]._categoryVisible = { 0: true, 1: true };
  state._syncActiveContext();
  return { state, published };
}

test('a field rename in one view reaches every kept view', () => {
  const { state } = makeTwoViewState();
  state.renameField('obs', 0, 'clusters');

  const snapshotField = state.viewContexts.get('snap_1').obsData.fields[0];
  assert.equal(snapshotField.key, 'clusters');
  assert.equal(snapshotField._originalKey, 'leiden');
  assert.deepEqual(
    state.getFilterSummaryForView('snap_1'),
    ['clusters: hiding a'],
  );

  // Reverting from the kept view restores the original everywhere.
  state.setActiveView('snap_1');
  state.revertFieldRename('obs', 0);
  assert.equal(state.viewContexts.get('live').obsData.fields[0].key, 'leiden');
  assert.equal(
    Object.hasOwn(state.viewContexts.get('live').obsData.fields[0], '_originalKey'),
    false,
  );
});

test('a category rename republishes the kept view label and filter text it replays', () => {
  const { state, published } = makeTwoViewState();
  published.length = 0;
  state.renameCategory('obs', 0, 0, 'alpha');

  const snapshotPublication = published.findLast((entry) => entry.viewId === 'snap_1');
  assert.ok(snapshotPublication, 'the kept view must be republished');
  assert.deepEqual(snapshotPublication.meta.filtersText, ['leiden: hiding alpha']);
  assert.equal(snapshotPublication.label, 'leiden • leiden: hiding alpha');

  // What the kept view publishes is exactly what replaying it computes.
  state.setActiveView('snap_1');
  assert.deepEqual(state.getFilterSummaryLines(), ['leiden: hiding alpha']);
  const field = state.obsData.fields[0];
  assert.deepEqual(field._originalCategories, ['a', 'b']);
});
