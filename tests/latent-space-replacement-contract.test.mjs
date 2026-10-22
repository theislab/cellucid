/**
 * Replacing the latent space (`state/managers/latent-space.js`) on a real
 * DataState with a kept view:
 * - every categorical descriptor names the new outlier payload, so a field
 *   loaded later reads it;
 * - a loaded categorical field gets the new quantiles in every view, read
 *   before anything changes, and its outlier threshold is kept;
 * - a latent space no loaded field needs is still read once, to check it;
 * - None removes every field's outliers; rollback restores everything.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createInMemoryDimensionManager } from '../assets/js/data/dimension-manager.js';

const N = 4;

function categorical(key, payloadIndex) {
  return {
    key,
    kind: 'category',
    payloadIndex,
    categories: ['a', 'b'],
    codesPath: `obs/${payloadIndex}.codes.u8`,
    codesDtype: 'uint8',
    codesMissingValue: 255,
    outlierQuantilesPath: null,
    outlierDtype: null,
    outlierQuantized: false,
    centroidsByEmbedding: {},
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
  const reads = [];
  const step = await state.stageLatentReplacement({
    outlierPathFor: index => `_cellucid/mapping/latent/3/obs/${index}.outliers.f32`,
    loadOutliers: async descriptor => {
      reads.push(descriptor.outlierQuantilesPath);
      return fresh;
    },
  });
  // Only the loaded field was read, and nothing changed yet.
  assert.deepEqual(reads, ['_cellucid/mapping/latent/3/obs/0.outliers.f32']);
  assert.equal(outliersOf(state, 'live').outlierQuantiles, old);

  step.commit();
  assert.deepEqual(
    state._obsFieldDescriptors.map(descriptor => [descriptor.outlierQuantilesPath, descriptor.outlierDtype]),
    [
      ['_cellucid/mapping/latent/3/obs/0.outliers.f32', 'float32'],
      ['_cellucid/mapping/latent/3/obs/1.outliers.f32', 'float32'],
    ]
  );
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

test('None removes every outlier filter; a space no loaded field needs is still checked', async () => {
  const { state } = makeState();
  const none = await state.stageLatentReplacement({
    outlierPathFor: () => null,
    loadOutliers: async () => {
      throw new Error('nothing is read for None');
    },
  });
  none.commit();
  assert.equal(Object.hasOwn(outliersOf(state, 'live'), 'outlierQuantiles'), false);
  assert.equal(state.isOutlierFilterEnabledForActiveField(), false);

  // Unload the field: the next space is read once through the first field.
  state.obsData.fields[0].loaded = false;
  for (const context of state.viewContexts.values()) context.obsData.fields[0].loaded = false;
  const reads = [];
  await state.stageLatentReplacement({
    outlierPathFor: index => `latent/${index}`,
    loadOutliers: async descriptor => {
      reads.push(descriptor.outlierQuantilesPath);
      return new Float32Array(N);
    },
  });
  assert.deepEqual(reads, ['latent/0']);
  await assert.rejects(
    state.stageLatentReplacement({
      outlierPathFor: index => `latent/${index}`,
      loadOutliers: async () => {
        throw new Error('NaN at cell 2');
      },
    }),
    /NaN at cell 2/
  );
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
  const staging = state.stageLatentReplacement({
    outlierPathFor: index => `latent/${index}`,
    loadOutliers: async () => fresh,
  });
  finish();
  const step = await staging;
  step.commit();
  assert.equal(state.obsData.fields[0].outlierQuantiles, fresh);
});
