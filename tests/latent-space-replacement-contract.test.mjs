/**
 * Replacing the latent space (`state/managers/latent-space.js`) on a real
 * DataState with a kept view:
 * - staging reads nothing; every categorical descriptor names the new
 *   outlier route, so its quantiles are got in the new space;
 * - every view drops the old space's quantiles; a field whose outlier filter
 *   is in use keeps its threshold and gets the new quantiles at once, as an
 *   ordinary outlier job (`outlier-quantiles.js`), in every view;
 * - None removes every field's outliers and reads nothing; rollback restores
 *   everything.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createInMemoryDimensionManager } from '../assets/js/data/dimension-manager.js';

const N = 4;

function categorical(key, fieldIndex) {
  return {
    key,
    kind: 'category',
    fieldIndex,
    categories: ['a', 'b'],
    codesDtype: 'uint8',
    codesMissingValue: 255,
    palette: null,
    outlierQuantilesPath: null,
  };
}

function makeState() {
  const state = new DataState(null, null);
  state.viewer = new Proxy({ getViewLayout: () => ({ mode: 'grid' }) }, {
    get(target, property) {
      return Object.hasOwn(target, property) ? target[property] : () => {};
    },
  });
  state.pointCount = N;
  state.dimensionManager = createInMemoryDimensionManager({
    positions: new Float32Array(N * 2),
    dimension: 2,
  });
  state.activeDimensionLevel = 2;
  state.colorsArray = new Uint8Array(N * 4);
  state.categoryTransparency = new Uint8Array(N).fill(1);
  state.cellVisibilityMask = new Uint8Array(N).fill(1);
  const descriptors = [categorical('leiden', 0), categorical('batch', 1)];
  state._obsFieldDescriptors = Object.freeze(descriptors.map(Object.freeze));
  const old = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
  state.obsData = {
    fields: [
      {
        ...descriptors[0],
        codes: Uint8Array.from([0, 1, 0, 1]),
        outlierQuantiles: old,
        centroidsByLayout: new Map(),
        loaded: true,
        _outlierThreshold: 0.5,
      },
      { ...descriptors[1], centroidsByLayout: new Map(), loaded: false },
    ],
  };
  state._fieldDataCache.set('leiden', { codes: state.obsData.fields[0].codes, outlierQuantiles: old });
  const reads = [];
  state.fieldLoader = {
    outlierMinPoints: 1,
    loadOutlierQuantiles: async descriptor => {
      reads.push(descriptor.outlierQuantilesPath);
      return state.nextQuantiles;
    },
    describeOutlierQuantiles: async () => ({ source: 'held', latentKey: 'X_new' }),
  };
  state.reads = reads;
  state._resetViewContexts();
  state.setActiveField(0);
  state.createViewFromSource('live', 'snap_1');
  state.dimensionManager.copyViewLayout('live', 'snap_1');
  return { state, old };
}

const outliersOf = (state, viewId) => {
  const view = viewId === state.activeViewId ? state : state.viewContexts.get(viewId);
  return view.obsData.fields[0];
};

test('a new latent space reaches every view, keeps thresholds, and rolls back', async () => {
  const { state, old } = makeState();
  const fresh = Float32Array.from([1, 0.5, 1, 0.5]);
  state.nextQuantiles = fresh;
  const step = await state.stageLatentReplacement({
    outlierPathFor: index => `outliers/3/${index}`,
  });
  // Staging reads nothing and changes nothing.
  assert.deepEqual(state.reads, []);
  assert.equal(outliersOf(state, 'live').outlierQuantiles, old);

  step.commit();
  assert.deepEqual(
    state._obsFieldDescriptors.map(descriptor => descriptor.outlierQuantilesPath),
    [
      'outliers/3/0',
      'outliers/3/1',
    ]
  );
  // The old space's quantiles are gone at once; the filter in use is got again.
  assert.equal(state._fieldDataCache.get('leiden').outlierQuantiles, undefined);
  assert.equal(state.getOutlierFilterStatus(0).state, 'running');
  await state.ensureOutlierQuantiles(0);
  assert.deepEqual(state.reads, ['outliers/3/0']);
  for (const viewId of ['live', 'snap_1']) {
    assert.equal(outliersOf(state, viewId).outlierQuantiles, fresh, viewId);
    assert.equal(outliersOf(state, viewId)._outlierThreshold, 0.5, viewId);
  }
  assert.equal(state._fieldDataCache.get('leiden').outlierQuantiles, fresh);
  assert.equal(state.activeViewId, 'live');

  step.rollback();
  assert.deepEqual(state._obsFieldDescriptors.map(descriptor => descriptor.outlierQuantilesPath), [null, null]);
  for (const viewId of ['live', 'snap_1']) {
    assert.equal(outliersOf(state, viewId).outlierQuantiles, old, viewId);
  }
  assert.equal(state._fieldDataCache.get('leiden').outlierQuantiles, old);
});

test('None removes every outlier filter and reads nothing', async () => {
  const { state } = makeState();
  const none = await state.stageLatentReplacement({ outlierPathFor: () => null });
  none.commit();
  assert.deepEqual(state.reads, []);
  assert.equal(Object.hasOwn(outliersOf(state, 'live'), 'outlierQuantiles'), false);
  assert.equal(state.isOutlierFilterEnabledForActiveField(), false);
  assert.equal(state.getOutlierFilterStatus(0).state, 'no-latent');
  // The threshold is kept for when a latent space is chosen again.
  assert.equal(outliersOf(state, 'live')._outlierThreshold, 0.5);
});

test('a categorical field still loading gets the new space, not the one it started with', async () => {
  const { state } = makeState();
  const field = state.obsData.fields[0];
  field.loaded = false;
  delete field.outlierQuantiles;
  for (const context of state.viewContexts.values()) context.obsData.fields[0].loaded = false;
  let finish;
  field._loadingPromise = new Promise(resolve => {
    finish = () => {
      field.loaded = true;
      field._loadingPromise = null;
      resolve(field);
    };
  });
  const fresh = Float32Array.from([1, 1, 0.5, 0.5]);
  state.nextQuantiles = fresh;
  const staging = state.stageLatentReplacement({ outlierPathFor: index => `outliers/0/${index}` });
  finish();
  const step = await staging;
  step.commit();
  assert.equal(await state.ensureOutlierQuantiles(0), fresh);
  assert.deepEqual(state.reads, ['outliers/0/0']);
  assert.equal(state.obsData.fields[0].outlierQuantiles, fresh);
});
