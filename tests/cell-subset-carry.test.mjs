/**
 * What a reading of other cells of the same dataset keeps
 * (`app/cell-subset-carry.js`): highlight groups, label fields and value
 * fields a notebook pushed, each by original cell position — a cell the
 * earlier reading did not open is missing (labels set by hand) or NaN
 * (values), a group keeps the cells of it still open. What is derived from
 * the file takes the newly open cells as growing in place does: a label
 * made from a column (edits of it) and a category or range group, which
 * keeps its type on both paths.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDataState } from '../assets/js/app/state/core/data-state.js';
import { createDimensionManager } from '../assets/js/data/dimension-manager.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { captureCarried, describeCarried, restoreCarried, takeInNewCells } from '../assets/js/app/cell-subset-carry.js';

const N = 60;

/** A DataState showing the cells `kept` (original positions, ascending) of `N`, opened in `openOrder`. */
async function sceneOf(kept, openOrder = null, fieldsOf = () => []) {
  const n = kept.length;
  const manager = createDimensionManager({
    embeddingsMetadata: {
      default_dimension: 2,
      defaults: { '2d': 'X_umap' },
      items: { X_umap: { label: 'X_umap', dimension: 2, path: 'obsm/0/0-1', source: { key: 'X_umap', columns: [0, 1] } } },
    },
  });
  manager.loadLayout = async () => {
    manager.loadedTransformCache.set('X_umap', { center: [0, 0, 0], scale: 1 });
    return Float32Array.from({ length: n * 2 }, (_, i) => Math.sin(i));
  };
  manager.publishCellCount(n);
  await manager.getPositions('X_umap');
  const viewer = new Proxy({ isDisposed: () => false, hasVectorFieldForLayout: () => false, getViewLayout: () => ({ mode: 'grid' }) }, {
    get: (target, property) => (Object.hasOwn(target, property) ? target[property] : () => {}),
  });
  const state = createDataState({ viewer, labelLayer: null });
  state.setDimensionManager(manager);
  state.initVarData({ fields: [] });
  manager.setViewLayout('live', 'X_umap');
  const identity = createCellIdentity({ nObs: N, kept: Uint32Array.from(kept), openOrder: openOrder === null ? null : Uint32Array.from(openOrder) });
  state.initScene(manager.getResidentPositions('X_umap'), { fields: fieldsOf(identity.toOriginal(Uint32Array.from({ length: n }, (_, i) => i))) });
  state.setCellIdentity(identity);
  for (let index = 0; index < state.obsData.fields.length; index++) await state.ensureFieldLoaded(index);
  return state;
}

test('labels, pushed values and highlights are carried by original cell position to other cells', async () => {
  // Open: original positions 0, 3, 6, ... (20 cells), opened in reverse.
  const before = Array.from({ length: 20 }, (_, i) => 3 * i);
  const earlier = await sceneOf(before, [...before].reverse());
  const originalOf = position => earlier.cellIdentity.toOriginal(Uint32Array.of(position))[0];
  const labelOf = original => (original % 2 === 0 ? 0 : 1);
  earlier.upsertUserDefinedCategoricalField({
    key: 'regions',
    categories: ['even', 'odd'],
    codes: Uint8Array.from({ length: 20 }, (_, i) => labelOf(originalOf(i))),
  });
  earlier.upsertUserDefinedContinuousField({
    key: 'pushed',
    values: Float32Array.from({ length: 20 }, (_, i) => originalOf(i) / 10),
    operation: { type: 'notebook-push' },
  });
  earlier.ensureHighlightPage();
  earlier.addHighlightDirect({ type: 'lasso', label: 'picked', cellIndices: Uint32Array.of(0, 1, 2) });
  // Hidden by hand: open cells 0 and 4 (original positions 57 and 45).
  earlier.setCellVisibility(Uint32Array.of(0, 4), false);
  const carried = captureCarried(earlier);

  // Then: original positions 0, 2, 4, ... (30 cells), half of them not open before.
  const after = Array.from({ length: 30 }, (_, i) => 2 * i);
  const later = await sceneOf(after);
  const outcome = restoreCarried(later, carried);
  // Of the hidden cells, 57 is not open now; 45 is not even (not open either).
  assert.deepEqual(outcome, { groups: 1, dropped: [], fields: 2, hidden: 0, rules: [] });
  assert.equal(describeCarried(outcome), 'Kept 1 highlight group and 2 fields you made on the cells open now.');
  assert.ok(later.cellVisibilityMask.every(value => value === 1));

  const field = key => later.obsData.fields.find(item => item.key === key);
  const missing = 255;
  after.forEach((original, i) => {
    const wasOpen = original % 3 === 0;
    assert.equal(field('regions').codes[i], wasOpen ? labelOf(original) : missing, `label of cell ${original}`);
    const value = field('pushed').values[i];
    if (wasOpen) assert.equal(value, Math.fround(original / 10), `value of cell ${original}`);
    else assert.ok(Number.isNaN(value), `cell ${original} had no value`);
  });
  // The group's cells: those of its original positions (57, 54, 51) still open (54).
  const group = later.getHighlightPages()[0].highlightedGroups[0];
  assert.deepEqual(Array.from(later.cellIdentity.toOriginal(group.cellIndices)), [54]);
});

test('cells hidden by hand stay hidden where they are open again', async () => {
  const cells = Array.from({ length: 30 }, (_, i) => 2 * i);
  const earlier = await sceneOf(cells);
  earlier.setCellVisibility(Uint32Array.of(1, 5, 7), false); // originals 2, 10, 14
  const carried = captureCarried(earlier);
  assert.deepEqual(Array.from(carried.hidden), [2, 10, 14]);
  const later = await sceneOf(Array.from({ length: 20 }, (_, i) => 3 * i).filter(p => p < N)); // 0, 3, …, 57
  const outcome = restoreCarried(later, carried);
  assert.equal(outcome.hidden, 0, 'none of 2, 10, 14 is a multiple of 3');
  const third = await sceneOf(Array.from({ length: 15 }, (_, i) => 2 * i)); // 0, 2, …, 28
  assert.equal(restoreCarried(third, carried).hidden, 3);
  assert.deepEqual(Array.from(third.cellVisibilityMask.keys()).filter(i => third.cellVisibilityMask[i] === 0), [1, 5, 7]);
  assert.equal(describeCarried({ groups: 0, dropped: [], fields: 1, hidden: 3 }), 'Kept 1 field you made and 3 cells hidden by hand on the cells open now.');
});

test('a carry of more than 2^24 open cells holds typed arrays only and maps every cell', () => {
  // A synthetic state (typed arrays only): 2^24 + 3 cells open of 2^25 + 8,
  // opened in an order not their original one.
  const n = 2 ** 24 + 3;
  const nObs = 2 ** 25 + 8;
  const kept = new Uint32Array(n);
  for (let i = 0; i < n; i++) kept[i] = 2 * i;
  const openOrder = new Uint32Array(n);
  for (let i = 0; i < n; i++) openOrder[i] = kept[n - 1 - i];
  const codes = new Uint8Array(n);
  for (let i = 0; i < n; i++) codes[i] = i % 3 === 0 ? 255 : (openOrder[i] / 2) % 2;
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) values[i] = (openOrder[i] % 1000) / 4;
  const mask = new Uint8Array(n).fill(1);
  mask[5] = 0;
  const earlier = {
    pointCount: n,
    cellIdentity: createCellIdentity({ nObs, kept, openOrder }),
    cellVisibilityMask: mask,
    getActivePageId: () => 'p',
    getHighlightPages: () => [{ id: 'p', name: 'Page 1', highlightedGroups: [{ type: 'lasso', label: 'g', enabled: true, cellIndices: Uint32Array.of(0, n - 1) }] }],
    obsData: { fields: [
      { key: 'regions', kind: 'category', categories: ['even', 'odd'], codes, _isUserDefined: true },
      { key: 'pushed', kind: 'continuous', values, _isUserDefined: true, _sourceField: null, _operation: { type: 'notebook-push' } },
    ] },
  };
  const carried = captureCarried(earlier);
  // Then: the same cells, in their original order (every 2nd position).
  const made = { fields: {}, groups: [], hidden: null };
  const later = {
    pointCount: n,
    cellIdentity: createCellIdentity({ nObs, kept }),
    ensureHighlightPage() {},
    getHighlightPages: () => [{ id: 'p', name: 'Page 1' }],
    renameHighlightPage() {},
    switchToPage() {},
    addHighlightDirect(group) { made.groups.push(group); return { id: 'g' }; },
    toggleHighlightEnabled() {},
    upsertUserDefinedCategoricalField({ key, codes: given }) { made.fields[key] = given; },
    upsertUserDefinedContinuousField({ key, values: given }) { made.fields[key] = given; },
    setCellVisibility(cells, visible) { made.hidden = { cells: Array.from(cells), visible }; },
  };
  const outcome = restoreCarried(later, carried);
  assert.deepEqual(outcome, { groups: 1, dropped: [], fields: 2, hidden: 1, rules: [] });
  // Cell j now is original position 2j, which was open cell n - 1 - j.
  for (const j of [0, 1, 2, 7, n >> 1, n - 2, n - 1]) {
    const before = n - 1 - j;
    assert.equal(made.fields.regions[j], codes[before], `label of cell ${j}`);
    assert.equal(made.fields.pushed[j], values[before], `value of cell ${j}`);
  }
  assert.deepEqual(Array.from(made.groups[0].cellIndices), [0, n - 1]);
  assert.deepEqual(made.hidden, { cells: [n - 1 - 5], visible: false });
});

/** A file's column of the cells open (their original positions), and a score. */
const fileFields = originals => [
  { key: 'cluster', kind: 'category', categories: ['a', 'b', 'c'], codes: Uint8Array.from(originals, original => original % 3) },
  { key: 'score', kind: 'continuous', values: Float32Array.from(originals, original => original / 4) },
];

/** What a person made, from the file's columns: an edit of one, a category group, a range group. */
function derive(state) {
  state.mergeCategoriesToNewField(0, 0, 1, { editInPlace: false });
  state.ensureHighlightPage();
  state.addHighlightFromCategory(0, 2, 'obs');
  state.addHighlightFromRange(1, 3, 9, 'obs');
}

/** Original positions 0, 4, 8, 9, 13, 17, 18, …: every category of `cluster`. */
const BEFORE = Array.from({ length: 20 }, (_, i) => 3 * i + (i % 3));

test('read again with other cells, what is derived from the file takes the newly open cells as opening them would', async () => {
  const before = BEFORE;
  const earlier = await sceneOf(before, [...before].reverse(), fileFields);
  derive(earlier);
  const carried = captureCarried(earlier);

  const after = Array.from({ length: 30 }, (_, i) => 2 * i); // 0, 2, …, 58: half not open before
  const later = await sceneOf(after, null, fileFields);
  const restored = restoreCarried(later, carried);
  assert.equal(restored.rules.length, 2, 'two groups made by a rule');
  const took = await takeInNewCells(later, carried, restored);
  assert.deepEqual(took, { fields: 1, groups: 2 });

  const reference = await sceneOf(after, null, fileFields);
  derive(reference);
  const fieldOf = (state, key) => state.obsData.fields.find(field => field.key === key);
  assert.deepEqual(Array.from(fieldOf(later, 'cluster (merged)').codes), Array.from(fieldOf(reference, 'cluster (merged)').codes), 'the edit labels every open cell');
  const groups = state => state.getHighlightPages()[0].highlightedGroups.map(group => ({
    type: group.type, label: group.label, cells: Array.from(group.cellIndices),
    rule: group.type === 'category' ? [group.fieldKey, group.categoryName, group.categoryIndex] : [group.fieldKey, group.rangeMin, group.rangeMax],
  }));
  assert.deepEqual(groups(later), groups(reference), 'each group keeps its type and rule, and takes the newly open cells in it');
});

test('a label set by hand stays missing on newly open cells, and a group whose field is gone keeps its cells', async () => {
  const before = BEFORE;
  const earlier = await sceneOf(before, null, fileFields);
  // Labels by hand on a copy of the column: no longer a function of it.
  earlier.mergeCategoriesToNewField(0, 0, 1, { editInPlace: false });
  const merged = earlier.obsData.fields.find(field => field.key === 'cluster (merged)');
  const codes = merged.codes.slice();
  // Cell 1 (original position 4, open again below).
  codes[1] = 1 - codes[1];
  earlier.upsertUserDefinedCategoricalField({ key: 'cluster (merged)', categories: merged.categories, codes });
  earlier.ensureHighlightPage();
  earlier.addHighlightFromCategory(0, 2, 'obs');
  const carried = captureCarried(earlier);
  const after = Array.from({ length: 30 }, (_, i) => 2 * i);
  const relabelled = await sceneOf(after, null, fileFields);
  await takeInNewCells(relabelled, carried, restoreCarried(relabelled, carried));
  const label = relabelled.obsData.fields.find(field => field.key === 'cluster (merged)');
  after.forEach((original, i) => {
    if (!before.includes(original)) assert.equal(label.codes[i], 255, `cell ${original} not open before stays missing`);
  });
  const later = await sceneOf(after, null, originals => fileFields(originals).slice(1)); // no 'cluster' now
  const restored = restoreCarried(later, carried);
  await takeInNewCells(later, carried, restored);
  const [group] = later.getHighlightPages()[0].highlightedGroups;
  assert.equal(group.type, 'annotation', 'its field is gone: its cells, as carried');
  assert.deepEqual(Array.from(later.cellIdentity.toOriginal(group.cellIndices)), before.filter(o => o % 3 === 2 && o % 2 === 0));
});
