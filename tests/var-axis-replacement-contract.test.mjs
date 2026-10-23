/**
 * Replacing the var axis (`state/managers/var-axis.js`), the gene list a data
 * mapping's gene names and expression matrix name, on a real DataState with a
 * kept view:
 * - a view coloured by a gene keeps it by name, at its new position, with its
 *   filter, and shows the new values;
 * - a gene missing from the new list is dropped and reported, and that view
 *   loses its gene colouring (and so its gene filter);
 * - obs state, the cell mask and the highlight are untouched;
 * - on the same var axis a gene is its position (another name for the same
 *   column), and when the matrix is the same its values are carried;
 * - rollback restores the previous list and colouring exactly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createInMemoryDimensionManager } from '../assets/js/data/dimension-manager.js';

const N = 4;

function geneField(key, index) {
  return {
    key,
    kind: 'continuous',
    path: `var/${index}`,
  };
}

function geneList(keys) {
  return { n_points: N, fields: keys.map(geneField) };
}

function loaderFor(valuesByKey, reads) {
  return async field => {
    reads.push(field.key);
    return { loaded: true, values: Float32Array.from(valuesByKey[field.key]) };
  };
}

async function makeState() {
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
  state.cellVisibilityMask = Uint8Array.from([1, 1, 0, 1]);
  state.obsData = {
    fields: [{
      key: 'leiden',
      kind: 'category',
      categories: ['a', 'b'],
      codes: Uint16Array.from([0, 1, 0, 1]),
      centroidsByLayout: new Map(),
      loaded: true,
    }],
  };
  const reads = [];
  state.setVarFieldLoader(loaderFor({
    A: [1, 2, 3, 4],
    B: [10, 20, 30, 40],
    C: [5, 6, 7, 8],
  }, reads));
  state.initVarData(geneList(['A', 'B', 'C']));
  state._resetViewContexts();

  // The live view is coloured by B with a filter; a kept view by C.
  await state.ensureVarFieldLoaded(1, { silent: true });
  state.varData.fields[1]._continuousFilter = { min: 15, max: 35 };
  state.varData.fields[1]._useLogScale = true;
  state.setActiveVarField(1);
  state.createViewFromSource('live', 'snap_1');
  state.dimensionManager.copyViewLayout('live', 'snap_1');
  state.setActiveView('snap_1');
  await state.ensureVarFieldLoaded(2, { silent: true });
  state.setActiveVarField(2);
  state.setActiveView('live');
  reads.length = 0;
  return { state, reads };
}

const activeGene = (state, viewId) => {
  const view = viewId === state.activeViewId ? state : state.viewContexts.get(viewId);
  if (view.activeFieldSource !== 'var') return null;
  const field = view.varData.fields[view.activeVarFieldIndex];
  return { key: field.key, index: view.activeVarFieldIndex, values: [...field.values], field };
};

test('views keep their genes by name on a new gene list, with their filters', async () => {
  const { state, reads } = await makeState();
  const mask = state.cellVisibilityMask;
  const events = [];
  state.on('var-axis:changed', payload => events.push(payload));

  const nextReads = [];
  const step = await state.stageVarAxisReplacement({
    geneList: geneList(['C', 'B', 'D']),
    varFieldLoader: loaderFor({ B: [11, 21, 31, 41], C: [50, 60, 70, 80], D: [0, 0, 0, 1] }, nextReads),
    sameAxis: false,
    sameMatrix: false,
  });
  // Staging read the two genes the views are coloured by, and changed nothing.
  assert.deepEqual(nextReads.sort(), ['B', 'C']);
  assert.deepEqual(step.dropped, []);
  assert.equal(activeGene(state, 'live').key, 'B');
  assert.equal(activeGene(state, 'live').index, 1);
  assert.equal(state.getVarAxisGeneration(), 0);

  step.commit();
  assert.deepEqual(reads, []);
  const live = activeGene(state, 'live');
  assert.equal(live.key, 'B');
  assert.equal(live.index, 1);
  assert.deepEqual(live.values, [11, 21, 31, 41]);
  assert.deepEqual(live.field._continuousFilter, { min: 15, max: 35 });
  assert.equal(live.field._useLogScale, true);
  const kept = activeGene(state, 'snap_1');
  assert.equal(kept.key, 'C');
  assert.equal(kept.index, 0);
  assert.deepEqual(kept.values, [50, 60, 70, 80]);
  // Genes nobody is coloured by are not read; they load on demand.
  assert.equal(state.varData.fields[2].key, 'D');
  assert.equal(state.varData.fields[2].loaded, false);
  // Cells belong to cells: the mask and the obs field are untouched.
  assert.equal(state.cellVisibilityMask, mask);
  assert.deepEqual([...state.obsData.fields[0].codes], [0, 1, 0, 1]);
  assert.equal(state.activeViewId, 'live');
  assert.equal(state.getVarAxisGeneration(), 1);
  assert.equal(state.getVarAxisGeneCount(), 3);
  assert.deepEqual(events, [{ generation: 1, dropped: [] }]);
});

test('a gene missing from the new list is dropped, and that view loses its gene colouring', async () => {
  const { state } = await makeState();
  const step = await state.stageVarAxisReplacement({
    geneList: geneList(['B', 'D']),
    varFieldLoader: loaderFor({ B: [1, 1, 1, 1], D: [2, 2, 2, 2] }, []),
    sameAxis: false,
    sameMatrix: false,
  });
  assert.deepEqual(step.dropped, ['C']);
  step.commit();
  assert.equal(activeGene(state, 'live').key, 'B');
  assert.equal(activeGene(state, 'live').index, 0);
  assert.equal(activeGene(state, 'snap_1'), null);
  assert.equal(state.viewContexts.get('snap_1').activeFieldSource, null);
  assert.equal(state.activeViewId, 'live');
});

test('on the same var axis a gene is its position, whatever it is now called', async () => {
  const { state } = await makeState();
  const before = state.varData.fields[1].values;
  const reads = [];
  const step = await state.stageVarAxisReplacement({
    geneList: geneList(['a1', 'b1', 'c1']),
    varFieldLoader: loaderFor({}, reads),
    sameAxis: true,
    sameMatrix: true,
  });
  // Same matrix: B and C are carried by position and nothing is read.
  assert.deepEqual(reads, []);
  assert.deepEqual(step.dropped, []);
  step.commit();
  const live = activeGene(state, 'live');
  assert.equal(live.key, 'b1');
  assert.equal(live.index, 1);
  assert.equal(state.varData.fields[1].values, before);
  assert.deepEqual(live.field._continuousFilter, { min: 15, max: 35 });
  assert.equal(activeGene(state, 'snap_1').key, 'c1');
});

test('the same axis with another matrix keeps positions and reads the new values', async () => {
  const { state } = await makeState();
  const reads = [];
  const step = await state.stageVarAxisReplacement({
    geneList: geneList(['A', 'B', 'C']),
    varFieldLoader: loaderFor({ B: [0, 20, 25, 30], C: [1, 2, 3, 4] }, reads),
    sameAxis: true,
    sameMatrix: false,
  });
  assert.deepEqual(reads.sort(), ['B', 'C']);
  step.commit();
  // The filter is clamped into the new values' range.
  assert.deepEqual(activeGene(state, 'live').field._continuousFilter, { min: 15, max: 30 });
  await assert.rejects(
    state.stageVarAxisReplacement({
      geneList: geneList(['A']),
      varFieldLoader: loaderFor({}, []),
      sameAxis: false,
      sameMatrix: true,
    }),
    /One matrix has one var axis/
  );
});

test('rollback restores the previous gene list and every view\'s colouring', async () => {
  const { state } = await makeState();
  const previousFields = state.varData.fields.map(field => field.key);
  const previousLoader = state.varFieldLoader;
  const step = await state.stageVarAxisReplacement({
    geneList: geneList(['B', 'D']),
    varFieldLoader: loaderFor({ B: [9, 9, 9, 9] }, []),
    sameAxis: false,
    sameMatrix: false,
  });
  step.commit();
  step.rollback();
  assert.deepEqual(state.varData.fields.map(field => field.key), previousFields);
  assert.equal(state.varFieldLoader, previousLoader);
  assert.deepEqual(activeGene(state, 'live').values, [10, 20, 30, 40]);
  assert.equal(activeGene(state, 'snap_1').key, 'C');
  assert.equal(state.getVarAxisGeneration(), 0);
  assert.equal(state.activeViewId, 'live');
});

test('an empty gene list needs no loader', async () => {
  const { state } = await makeState();
  const step = await state.stageVarAxisReplacement({
    geneList: { n_points: N, fields: [] },
    varFieldLoader: null,
    sameAxis: false,
    sameMatrix: false,
  });
  assert.deepEqual(step.dropped.sort(), ['B', 'C']);
  step.commit();
  assert.equal(state.getVarAxisGeneCount(), 0);
  assert.equal(state.activeFieldSource, null);
  await assert.rejects(
    state.stageVarAxisReplacement({ geneList: geneList(['B']), varFieldLoader: null, sameAxis: false, sameMatrix: false }),
    /field loader/
  );
});
