/**
 * How the open cells are grown or cut in place (`app/open-cells-resize.js`),
 * around the state's own resize (`open-cells-resize-state.test.mjs`): each
 * reading names its own cells, so Apply during a progressive opening's step
 * opens Apply's cells and the step's restore opens the cells before; the
 * commit is checked whole before anything changes; work on the open cells
 * under way ends on them first and work started meanwhile starts on the new
 * cells; an embedding the added cells make unusable is let go as an opening
 * of them would; a step that cannot grow what is shown leaves the cells as
 * they were; growing keeps a selection under way; a resize records no cost
 * of showing a cell (only openings do, `opening-cost.test.mjs`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenCellsResize } from '../assets/js/app/open-cells-resize.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { EmbeddingLoadError } from '../assets/js/data/data-mapping-candidates.js';
import { cellsSteady, cellWorkRunning, trackCellWork } from '../assets/js/data/open-cells-work.js';
import { resetShownCells, shownMsPerCell } from '../assets/js/data/opening-cost.js';

const N_OBS = 10_000;

/** A count a cell subset request opens. */
function countOf(request) {
  if (request.mode === 'all') return N_OBS;
  if (request.mode === 'kept') return request.kept.length;
  return request.k;
}

/**
 * An open dataset's source: a reader that opens the first `k` cells of seed
 * 1 (any other seed: other cells), recording every request it is given.
 * `hold(request, signal)` holds a reading where the test wants it.
 */
function fakeSource(n0, growth = null) {
  const subsetOf = (n, grown = null) => ({
    nObs: N_OBS,
    kept: n === N_OBS ? null : Uint32Array.from({ length: n }, (_, i) => i),
    spec: { method: 'uniform', seed: 1, k: n },
    autoFit: null,
    reproduced: null,
    growth: grown,
  });
  let subset = subsetOf(n0, growth);
  const source = {
    requests: [],
    hold: null,
    getCellSubset: () => subset,
    getCellIdentity: () => createCellIdentity({ nObs: N_OBS, kept: subset.kept }),
    async reopenCells({ cellSubset, signal = null }) {
      source.requests.push(cellSubset);
      if (source.hold !== null) await source.hold(cellSubset, signal);
      // A reading stopped leaves the cells before (`AnnDataFileSource`
      // reads them back with their own request).
      if (signal?.aborted) throw signal.reason;
      const from = subset.kept?.length ?? N_OBS;
      const to = countOf(cellSubset);
      subset = subsetOf(to);
      const other = cellSubset.seed !== undefined && cellSubset.seed !== 1;
      return { metadata: { cells: to }, resized: other || to === from ? null : { from, to } };
    },
  };
  return source;
}

/** A DataState as the resize uses it, recording what it was asked. */
function fakeState(n0, { live = 'X_umap' } = {}) {
  const resident = new Map([['X_umap', 2], ['X_pca', 2]]);
  const calls = { resizeCells: [], resizeOpenCells: [], publish: [], events: [] };
  const state = {
    pointCount: n0,
    cellPriority: null,
    calls,
    obsData: { fields: [] },
    varData: { fields: [] },
    _obsFieldDescriptors: [],
    _fieldDataCache: new Map(),
    varFieldLoader: null,
    fieldLoader: { readRows: async () => ({}), resized: () => state.fieldLoader },
    getViewLayoutKey: () => live,
    getDimensionManager: () => ({
      residentLayouts: () => [...resident].map(([layoutKey, dimension]) => ({ layoutKey, dimension, path: `obsm/${layoutKey}` })),
      getLayout: key => ({ dimension: resident.get(key) ?? 2 }),
      resizeCells(n, added) {
        calls.resizeCells.push({ n, added: [...added.keys()] });
        const out = new Map();
        for (const [key, dimension] of [...resident]) {
          if (n > state.pointCount && !added.has(key)) {
            resident.delete(key);
            continue;
          }
          out.set(key, new Float32Array(n * dimension));
        }
        return out;
      },
    }),
    resizeOpenCells(change) {
      calls.resizeOpenCells.push(change);
      state.pointCount = change.n;
      state.cellPriority = change.priority;
      return { from: 0, to: change.n, released: [], recoded: [], droppedGroups: [], resetRanges: [], resumeActive: null };
    },
    setFieldLoader() {},
    setVarFieldLoader() {},
    publishResizedCells(options) { calls.publish.push(options); },
    adoptResizedMappingCandidates() {},
    emit(event) { calls.events.push(event); },
    resident,
  };
  return state;
}

/** The app around the resize. `rows(path, rows)` answers a positions read. */
function harness(n0, { growth = null, live = 'X_umap', rows = null } = {}) {
  const source = fakeSource(n0, growth);
  const state = fakeState(n0, { live });
  const said = [];
  const counts = { retireSelections: 0, adoptStage: 0 };
  const resizer = createOpenCellsResize({
    state,
    viewer: { hasSnapshots: () => false, resetVectorFieldOverlay() {} },
    notify: text => said.push(text),
    runtime: {
      readPositionRows: async ({ path, dimension, rows: range, signal }) => {
        if (rows !== null) await rows(path, range, signal);
        if (signal?.aborted) throw signal.reason;
        return { positions: new Float32Array((range[1] - range[0]) * dimension), bounds: null };
      },
      loadGeneration: async () => ({ identity: { id: 'd' } }),
      stage: () => ({ runtimeKind: 'dataset', generation: { identity: { id: 'd' } }, fieldLoader: null, varFieldLoader: null }),
      adoptStage: () => { counts.adoptStage++; },
      retireKeptViews() {},
      retireSelections: () => { counts.retireSelections++; },
      keptViews: null,
      connectivity: { getConnectivityGraph: () => ({ summary: null, url: null }) },
      invalidateAnalysisData() {},
      loadMappingCandidates: async () => ({}),
      adoptMetadata() {},
      afterResize: async () => {},
    },
  });
  return { source, state, said, counts, resizer };
}

const GROWTH = Object.freeze({
  target: 1000,
  steps: Object.freeze([200, 1000]),
  step: Object.freeze({ mode: 'subsample', method: 'uniform', seed: 1, strict: true }),
  final: Object.freeze({ mode: 'all' }),
});

test('Apply while a step reads its cells opens Apply\'s cells; the step never takes or gives another\'s request', async () => {
  // The step's reading held until it is stopped.
  const { source, state, resizer } = harness(100, { growth: { ...GROWTH, target: N_OBS, steps: [200, N_OBS] } });
  let entered;
  const stepEntered = new Promise(resolve => { entered = resolve; });
  source.hold = (request, signal) => (request.k === 200
    ? new Promise(resolve => { entered(); signal.addEventListener('abort', resolve, { once: true }); })
    : null);
  const growing = resizer.grow(source, new AbortController().signal);
  await stepEntered;
  const applied = await resizer.resize({ annData: source, cellSubset: { mode: 'subsample', method: 'uniform', seed: 1, k: 777 } });
  await growing;
  assert.deepEqual(source.requests.map(request => request.k ?? request.mode), [200, 777]);
  assert.equal(applied.inPlace, true);
  assert.equal(state.pointCount, 777);
  assert.equal(source.getCellSubset().kept.length, 777);
});

test('Apply while a step reads the added rows: the step reads the cells before back with their own request', async () => {
  let entered;
  const rowsEntered = new Promise(resolve => { entered = resolve; });
  const { source, state, resizer } = harness(100, {
    growth: { ...GROWTH, target: N_OBS, steps: [200, N_OBS] },
    rows: (path, range, signal) => (range[1] === 200
      ? new Promise(resolve => { entered(); signal.addEventListener('abort', resolve, { once: true }); })
      : null),
  });
  const growing = resizer.grow(source, new AbortController().signal);
  await rowsEntered;
  await resizer.resize({ annData: source, cellSubset: { mode: 'subsample', method: 'uniform', seed: 1, k: 777 } });
  await growing;
  const [step, restore, apply] = source.requests;
  assert.equal(step.k, 200);
  assert.equal(restore.mode, 'kept', 'the cells open before, by their own request');
  assert.equal(restore.kept.length, 100);
  assert.equal(apply.k, 777);
  assert.equal(source.requests.length, 3);
  assert.equal(state.pointCount, 777);
  assert.equal(state.calls.resizeOpenCells.length, 1, 'only Apply committed');
});

test('the commit is checked whole before anything changes', async () => {
  // The live view's embedding is not resident: nothing changes, the cells before are read back.
  const { source, state, resizer } = harness(100, { live: 'X_tsne' });
  await assert.rejects(resizer.resize({ annData: source, cellSubset: { mode: 'subsample', method: 'uniform', seed: 1, k: 300 } }), /X_tsne/);
  assert.equal(state.pointCount, 100);
  assert.equal(state.calls.resizeCells.length, 0);
  assert.equal(state.calls.resizeOpenCells.length, 0);
  assert.equal(source.requests.at(-1).mode, 'kept');
  assert.equal(source.getCellSubset().kept.length, 100);
  // Rows of the wrong length (an embedding of 3 columns answered with 2): likewise.
  const shortRows = harness(100);
  const manager = shortRows.state.getDimensionManager();
  shortRows.state.getDimensionManager = () => ({ ...manager, getLayout: () => ({ dimension: 3 }) });
  await assert.rejects(shortRows.resizer.resize({ annData: shortRows.source, cellSubset: { mode: 'subsample', method: 'uniform', seed: 1, k: 300 } }), /hold/);
  assert.equal(shortRows.state.pointCount, 100);
  assert.equal(shortRows.state.calls.resizeCells.length, 0);
});

test('work on the open cells under way ends on them first; work started meanwhile starts on the new cells', async () => {
  const { source, state, resizer } = harness(100);
  let finishJob;
  trackCellWork(new Promise(resolve => { finishJob = resolve; }));
  // The reading held until a load is picked during it.
  let reading;
  let release;
  const read = new Promise(resolve => { reading = resolve; });
  source.hold = () => { reading(); return new Promise(resolve => { release = resolve; }); };
  const resized = resizer.resize({ annData: source, cellSubset: { mode: 'subsample', method: 'uniform', seed: 1, k: 400 } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(source.requests.length, 0, 'nothing read while the job runs');
  finishJob();
  await read;
  assert.notEqual(cellsSteady(), null, 'the change is under way');
  // A load picked now runs once the cells changed, on the cells after.
  const picked = (async () => {
    const steady = cellsSteady();
    if (steady !== null) await steady;
    return state.pointCount;
  })();
  release();
  await resized;
  assert.equal(await picked, 400);
  assert.equal(cellsSteady(), null);
  assert.equal(cellWorkRunning(), false);
});

test('an embedding the added cells make unusable is let go; the one shown makes Apply a new reading', async () => {
  const unusable = (path, range) => {
    if (path === 'obsm/X_pca') throw new EmbeddingLoadError('X_pca', [0, 1], 'holds a value that is not finite');
    return null;
  };
  const other = harness(100, { rows: unusable });
  const outcome = await other.resizer.resize({ annData: other.source, cellSubset: { mode: 'subsample', method: 'uniform', seed: 1, k: 300 } });
  assert.equal(outcome.inPlace, true);
  assert.deepEqual(other.state.calls.resizeCells[0].added, ['X_umap']);
  assert.equal(other.state.resident.has('X_pca'), false, 'let go: an opening of these cells refuses it');
  assert.ok(other.said.some(text => /X_pca/.test(text) && /cannot be shown/.test(text)));

  const shown = harness(100, { rows: path => (path === 'obsm/X_umap' ? unusable('obsm/X_pca') : null) });
  const apply = await shown.resizer.resize({ annData: shown.source, cellSubset: { mode: 'subsample', method: 'uniform', seed: 1, k: 300 } });
  assert.deepEqual(apply, { inPlace: false }, 'shown as a new reading of the cells asked for');
  assert.equal(shown.state.calls.resizeOpenCells.length, 0);
  assert.equal(shown.source.getCellSubset().kept.length, 300, 'the reader holds them for the new reading');

  // A progressive opening stops at the cells open, saying why.
  const growing = harness(100, { growth: GROWTH, rows: path => (path === 'obsm/X_umap' ? unusable('obsm/X_pca') : null) });
  await growing.resizer.grow(growing.source, new AbortController().signal);
  assert.equal(growing.state.pointCount, 100);
  assert.equal(growing.source.getCellSubset().kept.length, 100, 'the cells before read back');
  assert.ok(growing.said.some(text => /Reading the rest of the cells stopped/.test(text)));
});

test('a step that cannot grow what is shown leaves the cells as they were', async () => {
  // Other cells than the ones shown and more.
  const otherCells = harness(100, { growth: { ...GROWTH, step: { ...GROWTH.step, seed: 2 } } });
  await otherCells.resizer.grow(otherCells.source, new AbortController().signal);
  assert.equal(otherCells.source.getCellSubset().kept.length, 100);
  assert.equal(otherCells.source.requests.at(-1).mode, 'kept');
  assert.equal(otherCells.state.calls.resizeOpenCells.length, 0);
  // A reader that grew from another count than the one shown.
  const drifted = harness(100, { growth: GROWTH });
  drifted.state.pointCount = 90;
  await drifted.resizer.grow(drifted.source, new AbortController().signal);
  assert.equal(drifted.source.getCellSubset().kept.length, 100);
  assert.equal(drifted.state.calls.resizeOpenCells.length, 0);
  assert.ok(drifted.said.some(text => /Reading the rest of the cells stopped/.test(text)));
});

test('growing keeps a selection under way; cutting retires it', async () => {
  const { source, counts, resizer } = harness(100);
  await resizer.resize({ annData: source, cellSubset: { mode: 'subsample', method: 'uniform', seed: 1, k: 400 } });
  assert.equal(counts.retireSelections, 0);
  await resizer.resize({ annData: source, cellSubset: { mode: 'subsample', method: 'uniform', seed: 1, k: 50 } });
  assert.equal(counts.retireSelections, 1);
});

test('a resize is not an opening: it records no cost of showing a cell', async () => {
  resetShownCells();
  const { source, resizer } = harness(100);
  // Grown (the GPU takes only the cells added, every open cell's colours
  // are made again), cut, and grown again: none is what an opening of its
  // cells costs (`data/opening-cost.js`).
  await resizer.resize({ annData: source, cellSubset: { mode: 'subsample', method: 'uniform', seed: 1, k: 400 } });
  await resizer.resize({ annData: source, cellSubset: { mode: 'subsample', method: 'uniform', seed: 1, k: 50 } });
  await resizer.resize({ annData: source, cellSubset: { mode: 'subsample', method: 'uniform', seed: 1, k: 200 } });
  assert.equal(shownMsPerCell(), null);
});

test('what could not stay is said once, by what happened to it', async () => {
  const { describeOutcome } = await import('../assets/js/app/open-cells-resize.js');
  assert.equal(describeOutcome({ droppedGroups: [], resetRanges: [], recoded: [] }), '');
  assert.equal(
    describeOutcome({ droppedGroups: ['late'], resetRanges: ['the filter of score'], recoded: ['label'] }),
    'The highlight group "late" has no cell open now and was removed. No cell open now lies in the filter of score: it was reset. '
      + 'The cells added hold categories "label" had not shown: it is read again with every category.'
  );
  assert.equal(
    describeOutcome({ droppedGroups: ['a', 'b'], resetRanges: [], recoded: ['x', 'y'] }),
    '2 highlight groups have no cell open now and were removed: "a", "b". The cells added hold categories "x", "y" had not shown: they are read again with every category.'
  );
});

test('a subsample grown from few chunks grows in chunk order, then is put in priority order in place', async () => {
  // Chunk order: cells by row; priority order: the same cells by row, descending.
  const subsetOf = (cells, priority) => ({
    nObs: N_OBS,
    kept: Uint32Array.from({ length: cells }, (_, i) => i),
    openOrder: priority ? Uint32Array.from({ length: cells }, (_, i) => cells - 1 - i) : Uint32Array.from({ length: cells }, (_, i) => i),
    spec: { method: 'blocks', seed: 1, k: cells },
    ordered: priority,
    autoFit: null,
    reproduced: null,
    growth: null,
  });
  const plan = {
    target: 300,
    steps: [200, 300],
    step: { mode: 'chunks', spec: { method: 'blocks', seed: 1, k: 300 }, autoFit: null, chunks: { rows: 50, seed: 1 } },
    final: { mode: 'kept', spec: { method: 'blocks', seed: 1, k: 300 }, kept: Uint32Array.from({ length: 300 }, (_, i) => i) },
    chunked: true,
  };
  const { state, said, resizer } = harness(100);
  let subset = { ...subsetOf(100, false), growth: plan };
  const requests = [];
  const source = {
    getCellSubset: () => subset,
    getCellIdentity: () => createCellIdentity({ nObs: N_OBS, kept: subset.kept, openOrder: subset.openOrder }),
    async reopenCells({ cellSubset }) {
      requests.push(cellSubset);
      const before = subset;
      subset = cellSubset.mode === 'chunks' ? subsetOf(cellSubset.chunks.cells, false) : subsetOf(cellSubset.kept.length, true);
      const from = before.kept.length;
      const to = subset.kept.length;
      return { metadata: {}, resized: to > from ? { from, to } : null, reordered: to === from };
    },
  };
  const reorders = [];
  state.getDimensionManager = (() => {
    const manager = state.getDimensionManager();
    return () => ({ ...manager, reorderCells: order => { reorders.push(order); return new Map([['X_umap', new Float32Array(order.length * 2)]]); } });
  })();
  state.reorderOpenCells = change => {
    state.calls.resizeOpenCells.push({ reorder: change.order });
    return { from: 300, to: 300, released: [], recoded: [], droppedGroups: [], resetRanges: [], resumeActive: null };
  };
  await resizer.grow(source, new AbortController().signal);
  assert.deepEqual(requests.map(request => request.mode === 'chunks' ? request.chunks.cells : request.mode), [200, 300, 'kept']);
  assert.equal(state.pointCount, 300);
  assert.equal(reorders.length, 1);
  // Open cell j (row 299 - j) was open cell 299 - j in chunk order.
  assert.deepEqual(Array.from(reorders[0].subarray(0, 3)), [299, 298, 297]);
  assert.deepEqual(said, []);
});
