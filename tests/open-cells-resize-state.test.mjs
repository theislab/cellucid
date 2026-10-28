/**
 * The open cells grown or cut in place (`state/managers/open-cells.js`,
 * `DimensionManager.resizeCells`): every per-cell structure of a DataState
 * grown from `k0` cells to `k`, or cut to it, is, bit for bit, what the
 * same dataset opened at `k` cells directly holds after the same actions —
 * positions of every resident layout and their bounds, loaded obs fields and
 * genes and their caches, continuous statistics and ranges, colours,
 * visibility, the cell mask, category counts, centroids, highlights (a
 * category or range group takes the visible cells added in it; a group made
 * by hand keeps its cells), user-defined categories (one made from a file's
 * column by edits labels the cells added as opening them would; one labelled
 * by hand leaves them missing) and value fields, scores, the filtered count,
 * the identity and priority. Each structure is asserted on its own.
 *
 * The dataset's cells are in priority order (a priority-ordered file, or a
 * subsample opening in it): opening `k` cells reads rows `[0, k)`, so the
 * cells `[0, min)` are the same at both sizes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDataState } from '../assets/js/app/state/core/data-state.js';
import { createDimensionManager } from '../assets/js/data/dimension-manager.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { OPEN_ORDER_PRIORITY } from '../assets/js/data/cell-priority.js';
import { readPositionBounds } from '../assets/js/rendering/position-layout.js';
import { resizedCellArray } from '../assets/js/app/state/managers/open-cells.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';

const N = 400;
const LAYOUTS = { X_umap_2d: 2, X_umap_3d: 3 };
const random = createMulberry32(0x0ce11);
/** The dataset: every cell's values, in open (priority) order. */
const DATA = Object.freeze({
  X_umap_2d: Float32Array.from({ length: N * 2 }, () => Math.fround(random() * 2 - 1)),
  X_umap_3d: Float32Array.from({ length: N * 3 }, () => Math.fround(random() * 2 - 1)),
  cluster: Uint8Array.from({ length: N }, () => Math.floor(random() * 4)),
  score: Float32Array.from({ length: N }, () => Math.fround(random() * 10)),
  gene: Float32Array.from({ length: N }, () => (random() < 0.4 ? 0 : Math.fround(random() * 5))),
});
const CATEGORIES = ['a', 'b', 'c', 'd'];

function sameBits(actual, expected, label) {
  assert.ok(ArrayBuffer.isView(actual), `${label}: a typed array`);
  assert.equal(actual.constructor, expected.constructor, `${label}: type`);
  assert.equal(actual.length, expected.length, `${label}: length`);
  assert.deepEqual(
    new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength),
    new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength),
    `${label}: bits`
  );
}

/** A viewer that answers what the state asks and records the live points it is given. */
function recordingViewer() {
  const published = [];
  const answers = {
    isDisposed: () => false,
    hasVectorFieldForLayout: () => false,
    hasSnapshots: () => false,
    getViewLayout: () => ({ mode: 'grid', activeId: 'live', liveViewHidden: false }),
    resizeLiveCells: payload => published.push({ kind: 'resize', payload }),
    setData: payload => published.push({ kind: 'set', payload }),
  };
  const viewer = new Proxy(answers, {
    get(target, property) {
      return Object.hasOwn(target, property) ? target[property] : () => {};
    },
  });
  return { viewer, published };
}

/** A DataState showing the first `k` cells of the dataset, both layouts resident, every field loaded. */
async function sceneAt(k) {
  const manager = createDimensionManager({
    embeddingsMetadata: {
      default_dimension: 2,
      defaults: { '2d': 'X_umap_2d', '3d': 'X_umap_3d' },
      items: Object.fromEntries(Object.entries(LAYOUTS).map(([key, dimension], index) => [key, {
        label: key,
        dimension,
        path: `obsm/${index}/${Array.from({ length: dimension }, (_, axis) => axis).join('-')}`,
        source: { key, columns: Array.from({ length: dimension }, (_, axis) => axis) },
      }])),
    },
  });
  // Coordinates as the reader hands them: already in the display frame
  // (the frame is the first opening's and does not move, `adoptTransforms`).
  manager.loadLayout = async layoutKey => {
    const dimension = LAYOUTS[layoutKey];
    manager.loadedTransformCache.set(layoutKey, { center: [0, 0, 0], scale: 1 });
    return DATA[layoutKey].slice(0, k * dimension);
  };
  manager.publishCellCount(k);
  await manager.getPositions('X_umap_2d');
  await manager.getPositions('X_umap_3d');
  const { viewer, published } = recordingViewer();
  const state = createDataState({ viewer, labelLayer: null });
  state.setDimensionManager(manager);
  state.initVarData({ fields: [{ key: 'GENE1', kind: 'continuous', path: 'var/0', values: DATA.gene.slice(0, k) }] });
  manager.setViewLayout('live', 'X_umap_2d');
  state.initScene(manager.getResidentPositions('X_umap_2d'), {
    fields: [
      { key: 'cluster', kind: 'category', categories: [...CATEGORIES], codes: DATA.cluster.slice(0, k) },
      { key: 'score', kind: 'continuous', values: DATA.score.slice(0, k) },
    ],
  });
  state.setCellIdentity(createCellIdentity({ nObs: N, kept: k === N ? null : Uint32Array.from({ length: k }, (_, i) => i) }));
  state.setCellPriority(OPEN_ORDER_PRIORITY);
  // Loaded as the app loads them (each in its cache).
  await state.ensureFieldLoaded(0);
  await state.ensureFieldLoaded(1);
  await state.ensureVarFieldLoaded(0);
  return { state, manager, published, k };
}

/** What a person did, the same at any size `k0` it was done at (on cells below `k0`). */
function act(state, k0) {
  // Edits of a file's column, chained: two clusters merged into a new
  // field, then one of its categories deleted to unassigned in place.
  const clusterAt = () => state.obsData.fields.findIndex(field => field.key === 'cluster');
  const merged = state.mergeCategoriesToNewField(clusterAt(), 0, 1, { editInPlace: false });
  state.deleteCategoryToUnassigned(merged.newFieldIndex, 2, { editInPlace: true, unassignedLabel: 'none' });
  // A user-defined category and a pushed value column on the cells open then.
  const regionCodes = new Uint8Array(state.pointCount).fill(255);
  for (let i = 0; i < Math.min(k0, state.pointCount); i++) regionCodes[i] = i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 255;
  state.upsertUserDefinedCategoricalField({ key: 'regions', categories: ['left', 'right'], codes: regionCodes });
  const pushed = new Float32Array(state.pointCount).fill(Number.NaN);
  for (let i = 0; i < Math.min(k0, state.pointCount); i++) pushed[i] = Math.fround(i / 7);
  state.upsertUserDefinedContinuousField({ key: 'pushed', values: pushed, operation: { type: 'notebook-push' } });
  // Fields: score's statistics made, with a filter inside them; cluster shown, 'b' hidden.
  const score = state.obsData.fields.find(field => field.key === 'score');
  state.ensureContinuousMetadata(score);
  score._continuousFilter = { min: 2, max: 8 };
  score._continuousColorRange = { min: 2, max: 8 };
  const clusterIndex = state.obsData.fields.findIndex(field => field.key === 'cluster');
  state.setActiveField(clusterIndex);
  state.setVisibilityForCategory(state.obsData.fields[clusterIndex], 1, false);
  // Cells hidden by hand, and highlight groups (one past the cut), among
  // the cells open when it was done.
  const below = cells => Uint32Array.from(cells.filter(cell => cell < k0 && cell < state.pointCount));
  state.setCellVisibility(below([3, 11, 97]), false);
  state.ensureHighlightPage();
  state.addHighlightDirect({ type: 'lasso', label: 'early', cellIndices: below([0, 2, 5, 40]) });
  // The last cell open at `k0`: a group of it alone exists where it is open.
  const late = below([k0 - 1]);
  if (late.length > 0) state.addHighlightDirect({ type: 'lasso', label: 'late', cellIndices: late });
  // Groups made by a rule: a category clicked, a range brushed (visible cells only).
  state.addHighlightFromCategory(clusterIndex, 2, 'obs');
  state.addHighlightFromRange(state.obsData.fields.findIndex(field => field.key === 'score'), 3, 5, 'obs');
  // A score an analysis shows, on some cells.
  const sigCells = [1, 4, k0 - 2];
  const sigValues = [0.5, 1.5, 2.5];
  const open = sigCells.map((cell, i) => [cell, sigValues[i]]).filter(([cell]) => cell < state.pointCount);
  state.getDerivedResults().replaceOwned('signature', { scores: [{ key: 'sig', cells: Uint32Array.from(open, ([cell]) => cell), values: Float32Array.from(open, ([, value]) => value) }] });
}

/** Grow or cut `scene` to `k` in place, reading the added rows from the dataset. */
function resize(scene, k) {
  const { state, manager } = scene;
  const from = state.pointCount;
  const added = new Map();
  if (k > from) {
    for (const [layoutKey, dimension] of Object.entries(LAYOUTS)) {
      const positions = DATA[layoutKey].slice(from * dimension, k * dimension);
      added.set(layoutKey, { positions, bounds: readPositionBounds(positions, dimension) });
    }
  }
  const layouts = manager.resizeCells(k, added);
  const outcome = state.resizeOpenCells({
    n: k,
    identity: createCellIdentity({ nObs: N, kept: k === N ? null : Uint32Array.from({ length: k }, (_, i) => i) }),
    priority: OPEN_ORDER_PRIORITY,
    positions: layouts.get('X_umap_2d'),
    obs: k > from ? new Map([['cluster', { codes: DATA.cluster.slice(from, k) }], ['score', { values: DATA.score.slice(from, k) }]]) : new Map(),
    var: k > from ? new Map([['GENE1', { values: DATA.gene.slice(from, k) }]]) : new Map(),
  });
  state.publishResizedCells({ layoutKey: 'X_umap_2d', from });
  return outcome;
}

/** Every per-cell structure of `subject` against `reference`, one assertion each. */
function assertSameState(subject, reference, label) {
  const s = subject.state;
  const r = reference.state;
  assert.equal(s.pointCount, r.pointCount, `${label}: pointCount`);
  assert.equal(s.cellIdentity.digest, r.cellIdentity.digest, `${label}: identity`);
  assert.equal(s.cellPriority, r.cellPriority, `${label}: priority`);
  sameBits(s.positionsArray, r.positionsArray, `${label}: live positions`);
  for (const [layoutKey, dimension] of Object.entries(LAYOUTS)) {
    const mine = subject.manager.getResidentPositions(layoutKey);
    sameBits(mine, reference.manager.getResidentPositions(layoutKey), `${label}: ${layoutKey} positions`);
    assert.deepEqual(readPositionBounds(mine, dimension), readPositionBounds(reference.manager.getResidentPositions(layoutKey), dimension), `${label}: ${layoutKey} bounds`);
  }
  assert.equal(subject.manager.getCellCount(), reference.manager.getCellCount(), `${label}: dimension manager cell axis`);
  const fieldOf = (state, key) => state.obsData.fields.find(field => field.key === key);
  sameBits(fieldOf(s, 'cluster').codes, fieldOf(r, 'cluster').codes, `${label}: cluster codes`);
  sameBits(fieldOf(s, 'score').values, fieldOf(r, 'score').values, `${label}: score values`);
  sameBits(s._fieldDataCache.get('cluster').codes, r._fieldDataCache.get('cluster').codes, `${label}: cluster cache`);
  sameBits(s.varData.fields[0].values, r.varData.fields[0].values, `${label}: gene values`);
  for (const name of ['_continuousStats', '_continuousFilter', '_continuousColorRange', '_positiveStats']) {
    assert.deepEqual(fieldOf(s, 'score')[name], fieldOf(r, 'score')[name], `${label}: score ${name}`);
  }
  sameBits(s.colorsArray, r.colorsArray, `${label}: colours`);
  sameBits(s.categoryTransparency, r.categoryTransparency, `${label}: visibility`);
  sameBits(s.cellVisibilityMask, r.cellVisibilityMask, `${label}: cell mask`);
  assert.deepEqual(s.filteredCount, r.filteredCount, `${label}: filtered count`);
  assert.deepEqual(fieldOf(s, 'cluster')._categoryCounts, fieldOf(r, 'cluster')._categoryCounts, `${label}: category counts`);
  sameBits(s.centroidPositions, r.centroidPositions, `${label}: centroid positions`);
  sameBits(s.centroidColors, r.centroidColors, `${label}: centroid colours`);
  assert.deepEqual(fieldOf(s, 'cluster').centroidsByLayout.get('X_umap_2d'), fieldOf(r, 'cluster').centroidsByLayout.get('X_umap_2d'), `${label}: centroid table`);
  const groups = state => state.getHighlightPages().map(page => page.highlightedGroups.map(group => ({ type: group.type, label: group.label, cells: Array.from(group.cellIndices), count: group.cellCount })));
  assert.deepEqual(groups(s), groups(r), `${label}: highlight groups`);
  sameBits(s.highlightArray, r.highlightArray, `${label}: highlight array`);
  sameBits(s._highlightedCellIndices, r._highlightedCellIndices, `${label}: highlighted cells`);
  sameBits(fieldOf(s, 'regions').codes, fieldOf(r, 'regions').codes, `${label}: user-defined codes`);
  sameBits(fieldOf(s, 'cluster (merged)').codes, fieldOf(r, 'cluster (merged)').codes, `${label}: edited column's codes`);
  assert.deepEqual(fieldOf(s, 'cluster (merged)').categories, fieldOf(r, 'cluster (merged)').categories, `${label}: edited column's categories`);
  assert.deepEqual(fieldOf(s, 'cluster (merged)').centroidsByLayout.get('X_umap_2d'), fieldOf(r, 'cluster (merged)').centroidsByLayout.get('X_umap_2d'), `${label}: edited column's centroids`);
  assert.deepEqual(fieldOf(s, 'regions').centroidsByLayout.get('X_umap_2d'), fieldOf(r, 'regions').centroidsByLayout.get('X_umap_2d'), `${label}: user-defined centroids`);
  sameBits(fieldOf(s, 'pushed').values, fieldOf(r, 'pushed').values, `${label}: pushed values`);
  const scores = state => state.getDerivedResults().getScores().map(score => ({ key: score.key, cells: Array.from(score.cells), values: Array.from(score.values) }));
  assert.deepEqual(scores(s), scores(r), `${label}: scores`);
}

for (const [k0, k] of [[120, 400], [400, 150], [60, 61], [250, 90]]) {
  test(`${k0} → ${k} cells in place is, structure by structure, the dataset opened at ${k} with the same actions`, async () => {
    const subject = await sceneAt(k0);
    act(subject.state, k0);
    const outcome = resize(subject, k);
    const reference = await sceneAt(k);
    act(reference.state, k0);
    assertSameState(subject, reference, `${k0}→${k}`);
    // The viewer was given the new points in place (the camera stays), not a new dataset.
    assert.equal(subject.published.at(-1).kind, 'resize');
    assert.equal(subject.published.at(-1).payload.positions.length, 2 * k);
    // A cut says which group lost every cell.
    assert.deepEqual(outcome.droppedGroups, k < k0 ? ['late'] : []);
    assert.deepEqual(outcome.resetRanges, []);
  });
}

test('a chain of steps (a progressive opening, then Apply down and up) lands where opening there does', async () => {
  const subject = await sceneAt(25);
  act(subject.state, 25);
  for (const k of [50, 100, 200, 400, 130, 300]) resize(subject, k);
  const reference = await sceneAt(300);
  act(reference.state, 25);
  assertSameState(subject, reference, 'chain');
});

test('every field encoding keeps its whole cache entry through a chain of resizes', async () => {
  // Columns whose categories the file does not state (text, boolean) are
  // found by their first load and kept in the cache beside the codes
  // (`field/loading.js`): the rows of every later step are read under them.
  const n = N;
  const flags = Uint8Array.from({ length: n }, (_, i) => (i % 5 === 0 ? 1 : 0));
  const notes = Uint8Array.from({ length: n }, (_, i) => (i % 7 === 0 ? 2 : i % 2));
  const nullable = Float32Array.from({ length: n }, (_, i) => (i % 4 === 0 ? Number.NaN : i / 3));
  const scene = await sceneAt(40);
  const { state } = scene;
  const found = {
    flag: { categories: ['False', 'True'], palette: null, codes: flags },
    note: { categories: ['x', 'y', 'z'], palette: [[1, 2, 3], [4, 5, 6], [7, 8, 9]], codes: notes },
  };
  for (const [key, { categories, palette, codes }] of Object.entries(found)) {
    state.obsData.fields.push({ key, kind: 'category', categories: [...categories], codes: codes.slice(0, 40), loaded: true, _loadingPromise: null });
    state._fieldDataCache.set(key, { codes: state.obsData.fields.at(-1).codes, categories, palette });
  }
  state.obsData.fields.push({ key: 'maybe', kind: 'continuous', values: nullable.slice(0, 40), loaded: true, _loadingPromise: null });
  state._fieldDataCache.set('maybe', { values: state.obsData.fields.at(-1).values });
  for (const k of [90, 200, 70, 333, 120]) {
    const { manager } = scene;
    const from = state.pointCount;
    const added = new Map();
    if (k > from) {
      for (const [layoutKey, dimension] of Object.entries(LAYOUTS)) {
        const positions = DATA[layoutKey].slice(from * dimension, k * dimension);
        added.set(layoutKey, { positions, bounds: readPositionBounds(positions, dimension) });
      }
    }
    const layouts = manager.resizeCells(k, added);
    const rows = (array, key) => (k > from ? [[key, array.slice(from, k)]] : []);
    state.resizeOpenCells({
      n: k,
      identity: createCellIdentity({ nObs: N, kept: Uint32Array.from({ length: k }, (_, i) => i) }),
      priority: OPEN_ORDER_PRIORITY,
      positions: layouts.get('X_umap_2d'),
      obs: new Map([
        ...rows(DATA.cluster, 'cluster').map(([key, codes]) => [key, { codes }]),
        ...rows(DATA.score, 'score').map(([key, values]) => [key, { values }]),
        ...rows(flags, 'flag').map(([key, codes]) => [key, { codes }]),
        ...rows(notes, 'note').map(([key, codes]) => [key, { codes }]),
        ...rows(nullable, 'maybe').map(([key, values]) => [key, { values }]),
      ]),
      var: new Map(rows(DATA.gene, 'GENE1').map(([key, values]) => [key, { values }])),
    });
    state.publishResizedCells({ layoutKey: 'X_umap_2d', from });
    for (const [key, { categories, palette, codes }] of Object.entries(found)) {
      const entry = state._fieldDataCache.get(key);
      assert.deepEqual(entry.categories, categories, `${k}: ${key}'s categories stay in its cache`);
      assert.deepEqual(entry.palette, palette, `${k}: ${key}'s palette stays in its cache`);
      sameBits(entry.codes, codes.slice(0, k), `${k}: ${key}'s codes`);
      assert.equal(state.obsData.fields.find(field => field.key === key).codes, entry.codes, `${k}: ${key}: the field's codes are the cache's`);
    }
    sameBits(state._fieldDataCache.get('maybe').values, nullable.slice(0, k), `${k}: nullable values (NaN kept)`);
    sameBits(state._varFieldDataCache.get('GENE1').values, DATA.gene.slice(0, k), `${k}: gene cache`);
  }
});

test('a range of which no cell is left is reset and said; a text column with new values is read again', async () => {
  const scene = await sceneAt(300);
  const score = scene.state.obsData.fields.find(field => field.key === 'score');
  scene.state.ensureContinuousMetadata(score);
  // A filter on the highest values only, then cut to cells whose scores lie below it.
  const below = DATA.score.slice(0, 300).reduce((max, value, i) => (i < 40 ? Math.max(max, value) : max), -Infinity);
  score._continuousFilter = { min: Math.fround(below + 1e-3), max: score._continuousStats.max };
  const kept = Math.max(...DATA.score.slice(0, 40)) < score._continuousFilter.min;
  const outcome = resize(scene, 40);
  if (kept) assert.deepEqual(outcome.resetRanges, ['the filter of score']);
  assert.ok(score._continuousFilter.min >= score._continuousStats.min && score._continuousFilter.max <= score._continuousStats.max);

  const grown = await sceneAt(30);
  grown.state.obsData.fields.push({ key: 'label', kind: 'category', categories: ['x'], codes: new Uint8Array(30), loaded: true, _loadingPromise: null });
  const from = grown.state.pointCount;
  const layouts = grown.manager.resizeCells(60, new Map(Object.entries(LAYOUTS).map(([key, dimension]) => {
    const positions = DATA[key].slice(from * dimension, 60 * dimension);
    return [key, { positions, bounds: readPositionBounds(positions, dimension) }];
  })));
  const result = grown.state.resizeOpenCells({
    n: 60,
    identity: createCellIdentity({ nObs: N, kept: Uint32Array.from({ length: 60 }, (_, i) => i) }),
    priority: OPEN_ORDER_PRIORITY,
    positions: layouts.get('X_umap_2d'),
    obs: new Map([['cluster', { codes: DATA.cluster.slice(30, 60) }], ['score', { values: DATA.score.slice(30, 60) }]]),
    var: new Map([['GENE1', { values: DATA.gene.slice(30, 60) }]]),
    changed: new Set(['label']),
  });
  const label = grown.state.obsData.fields.find(field => field.key === 'label');
  assert.equal(label.loaded, false);
  assert.equal(label.categories, null, 'its categories are found again from every cell');
  assert.deepEqual(result.released, ['field label']);
  assert.deepEqual(result.recoded, ['label']);
});

test('a load under way when the cells change is superseded, and a resize keeps the live view alone', async () => {
  const scene = await sceneAt(80);
  const before = scene.state.getDatasetGeneration();
  resize(scene, 160);
  assert.notEqual(scene.state.getDatasetGeneration(), before, 'loads of the earlier cells cannot publish');
  scene.state.createViewFromSource('live', 'snap_1');
  assert.throws(() => resize(scene, 200), /live view alone/);
});

test('a field picked while the cells change is loaded on the cells after it, not lost', async () => {
  const { beginCellsChange } = await import('../assets/js/data/open-cells-work.js');
  const scene = await sceneAt(80);
  const { state } = scene;
  // A column not loaded yet, read by a loader of the cells open when it reads.
  state.obsData.fields.push({ key: 'later', kind: 'continuous', loaded: false, _loadingPromise: null, _loadingSignal: null });
  state._obsFieldDescriptors = Object.freeze([...state._obsFieldDescriptors, Object.freeze({ key: 'later', kind: 'continuous' })]);
  const index = state.obsData.fields.length - 1;
  const read = [];
  state.setFieldLoader(async () => {
    read.push(state.pointCount);
    return { values: DATA.score.slice(0, state.pointCount) };
  });
  // The change under way: the load waits for it, then reads the cells after.
  const end = beginCellsChange();
  const picked = state.ensureFieldLoaded(index, { silent: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(read, [], 'nothing read on the cells before');
  resize(scene, 160);
  end();
  const field = await picked;
  assert.deepEqual(read, [160]);
  assert.equal(field.loaded, true);
  sameBits(field.values, DATA.score.slice(0, 160), 'its values, on the cells open now');
});

test('resizedCellArray keeps the shared rows and fills or takes the rest', () => {
  const values = Float32Array.of(1, 2, 3, 4, 5, 6);
  sameBits(resizedCellArray(values, 3, 2, { width: 2 }), Float32Array.of(1, 2, 3, 4), 'cut');
  sameBits(resizedCellArray(values, 3, 4, { width: 2, added: Float32Array.of(7, 8) }), Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8), 'grown');
  sameBits(resizedCellArray(Uint8Array.of(1, 0), 2, 4, { fill: 1 }), Uint8Array.of(1, 0, 1, 1), 'filled');
  assert.throws(() => resizedCellArray(values, 3, 5, { width: 2, added: Float32Array.of(1) }), RangeError);
});

/** A DataState showing the cells `order` (rows of the dataset) in that order, both layouts resident, every field loaded. */
async function sceneInOrder(order) {
  const k = order.length;
  const pick = (array, width = 1) => {
    const out = new array.constructor(k * width);
    for (let j = 0; j < k; j++) for (let w = 0; w < width; w++) out[j * width + w] = array[order[j] * width + w];
    return out;
  };
  const manager = createDimensionManager({
    embeddingsMetadata: {
      default_dimension: 2,
      defaults: { '2d': 'X_umap_2d', '3d': 'X_umap_3d' },
      items: Object.fromEntries(Object.entries(LAYOUTS).map(([key, dimension], index) => [key, {
        label: key, dimension,
        path: `obsm/${index}/${Array.from({ length: dimension }, (_, axis) => axis).join('-')}`,
        source: { key, columns: Array.from({ length: dimension }, (_, axis) => axis) },
      }])),
    },
  });
  manager.loadLayout = async layoutKey => {
    manager.loadedTransformCache.set(layoutKey, { center: [0, 0, 0], scale: 1 });
    return pick(DATA[layoutKey], LAYOUTS[layoutKey]);
  };
  manager.publishCellCount(k);
  await manager.getPositions('X_umap_2d');
  await manager.getPositions('X_umap_3d');
  const { viewer, published } = recordingViewer();
  const state = createDataState({ viewer, labelLayer: null });
  state.setDimensionManager(manager);
  state.initVarData({ fields: [{ key: 'GENE1', kind: 'continuous', path: 'var/0', values: pick(DATA.gene) }] });
  manager.setViewLayout('live', 'X_umap_2d');
  state.initScene(manager.getResidentPositions('X_umap_2d'), {
    fields: [
      { key: 'cluster', kind: 'category', categories: [...CATEGORIES], codes: pick(DATA.cluster) },
      { key: 'score', kind: 'continuous', values: pick(DATA.score) },
    ],
  });
  state.setCellIdentity(createCellIdentity({ nObs: N, kept: Uint32Array.from(order).sort(), openOrder: Uint32Array.from(order) }));
  state.setCellPriority(OPEN_ORDER_PRIORITY);
  await state.ensureFieldLoaded(0);
  await state.ensureFieldLoaded(1);
  await state.ensureVarFieldLoaded(0);
  return { state, manager, published, k };
}

/** What a person did, named by original cell (the same cells in any order). */
function actOnCells(state) {
  const at = original => state.cellIdentity.fromOriginal(Uint32Array.of(original)).positions[0];
  const cells = originals => Uint32Array.from(originals.map(at)).sort();
  const originals = Array.from(state.cellIdentity.toOriginal(Uint32Array.from({ length: state.pointCount }, (_, j) => j)));
  const merged = state.mergeCategoriesToNewField(0, 0, 1, { editInPlace: false });
  state.deleteCategoryToUnassigned(merged.newFieldIndex, 1, { editInPlace: true, unassignedLabel: 'none' });
  const regionCodes = new Uint8Array(state.pointCount).fill(255);
  originals.forEach((original, j) => { regionCodes[j] = original % 5 === 0 ? 0 : original % 5 === 1 ? 1 : 255; });
  state.upsertUserDefinedCategoricalField({ key: 'regions', categories: ['left', 'right'], codes: regionCodes });
  state.upsertUserDefinedContinuousField({ key: 'pushed', values: Float32Array.from(originals, original => original / 7), operation: { type: 'notebook-push' } });
  const score = state.obsData.fields.find(field => field.key === 'score');
  state.ensureContinuousMetadata(score);
  score._continuousFilter = { min: 2, max: 8 };
  state.setActiveField(0);
  state.setVisibilityForCategory(state.obsData.fields[0], 1, false);
  const some = originals.filter(original => original % 7 === 0).sort((a, b) => a - b).slice(0, 6);
  state.setCellVisibility(cells(some.slice(0, 2)), false);
  state.ensureHighlightPage();
  state.addHighlightDirect({ type: 'lasso', label: 'picked', cellIndices: cells(some) });
  state.addHighlightFromCategory(0, 2, 'obs');
  state.getDerivedResults().replaceOwned('signature', { scores: [{ key: 'sig', cells: cells(some.slice(0, 3)), values: Float32Array.of(0.5, 1.5, 2.5) }] });
}

test('the same cells put in priority order in place are, structure by structure, the cells opened in it', async () => {
  // A subsample's cells as grown from few chunks: chunk by chunk (here
  // chunks of 50 rows taken 3, 0, 2, 1), each chunk's cells in priority
  // order; then put in priority order (here, by row).
  const cells = Array.from({ length: 200 }, (_, i) => 2 * i).filter(row => row % 3 !== 0);
  const chunkOrder = [3, 0, 2, 1, 7, 4, 6, 5];
  const grown = chunkOrder.flatMap(chunk => cells.filter(row => Math.floor(row / 50) === chunk));
  const subject = await sceneInOrder(grown);
  actOnCells(subject.state);
  const reference = await sceneInOrder(cells);
  actOnCells(reference.state);
  const identity = reference.state.cellIdentity;
  const { reorderOf } = await import('../assets/js/app/open-cells-resize.js');
  const order = reorderOf(subject.state.cellIdentity, identity);
  const positions = subject.manager.reorderCells(order).get('X_umap_2d');
  subject.state.reorderOpenCells({ identity, priority: OPEN_ORDER_PRIORITY, positions, order });
  subject.state.publishResizedCells({ layoutKey: 'X_umap_2d', from: subject.state.pointCount });
  assertSameState(subject, reference, 'reordered');
  assert.equal(subject.published.at(-1).kind, 'resize', 'shown in place, the camera kept');
});
