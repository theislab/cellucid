/**
 * Every view's copy of a user-defined field is the same field.
 *
 * A kept view holds its own copy of each field object, and a user-defined
 * categorical's definition (categories, codes, centroid tables) belongs to
 * the field: the registry holds one, a session saves one. An edit in place
 * (deleting or merging a category, a rebuilt consensus column) replaced the
 * definition of the edited view's copy and of the registry's only. The other
 * views kept the previous one, so a kept view computing a new layout's
 * centroids wrote them into the registry's table and found none in its own
 * ("Normalized user-defined centroids of layout ... were not published"),
 * and an edit made in a kept view left the live copy (the registry's object)
 * with the new categories under colours indexed for the old ones. A field
 * deleted, restored or purged in one view stayed as it was in the others.
 *
 * Each copy now takes the new definition at once, keeping its own colours
 * and hidden categories by category, and follows the field's deletion when
 * its view is shown, as a dataset field's copy follows the delete registry.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDataState } from '../assets/js/app/state/core/data-state.js';
import { createDimensionManager } from '../assets/js/data/dimension-manager.js';
import {
  buildDeleteToUnassignedTransform,
  buildMergeCategoriesTransform,
  carryCategoryStateByCategory,
  carryCategoryStateThroughDelete,
  carryCategoryStateThroughMerge,
} from '../assets/js/app/utils/categorical-ops.js';
import { computeCentroidsForDimension } from '../assets/js/app/registries/user-defined-fields/centroids.js';
import { getCategoryColor } from '../assets/js/data/palettes.js';
import { loadsAsReader } from './helpers/dimension-loads.mjs';

const RED = [1, 0, 0];
const GREEN = [0, 1, 0];
const BLUE = [0, 0, 1];
const GREY = [0.5, 0.5, 0.5];

test('a view carries its colours and hidden categories through each edit, by category', () => {
  const state = { colors: [RED, GREEN, BLUE, GREY], visible: { 0: true, 1: false, 2: true, 3: false } };

  // Delete 'b' into a new 'unassigned': a, c, d keep theirs.
  const deleted = carryCategoryStateThroughDelete(
    buildDeleteToUnassignedTransform(['a', 'b', 'c', 'd'], 1, { unassignedLabel: 'unassigned' }),
    state
  );
  assert.deepEqual(deleted, {
    colors: [RED, BLUE, GREY, [...getCategoryColor(3)]],
    visible: { 0: true, 1: true, 2: false, 3: true },
  });
  // Into the existing 'unassigned' (index 3): it keeps its own.
  const intoExisting = carryCategoryStateThroughDelete(
    buildDeleteToUnassignedTransform(['a', 'b', 'c', 'unassigned'], 0, { unassignedLabel: 'unassigned' }),
    state
  );
  assert.deepEqual(intoExisting, {
    colors: [GREEN, BLUE, GREY],
    visible: { 0: false, 1: true, 2: false },
  });

  // Merge 'a' (dragged) into 'b': the merged category has a's colour and is
  // shown because a was.
  const merged = carryCategoryStateThroughMerge(
    buildMergeCategoriesTransform(['a', 'b', 'c', 'd'], 0, 1),
    0,
    1,
    state
  );
  assert.deepEqual(merged, {
    colors: [RED, BLUE, GREY],
    visible: { 0: true, 1: true, 2: false },
  });

  // Another list: by label; a new label gets its palette colour, shown.
  assert.deepEqual(
    carryCategoryStateByCategory(['a', 'b', 'c', 'd'], ['d', 'x', 'b'], state),
    { colors: [GREY, [...getCategoryColor(1)], GREEN], visible: { 0: false, 1: true, 2: false } }
  );
  // Nothing is shared with the state carried from.
  assert.notEqual(merged.colors[0], RED);
});

const POINTS = 8;
const LAYOUTS = { X_umap_2d: 2, X_umap_3d: 3 };

function rawPositions(dimension) {
  const positions = new Float32Array(POINTS * dimension);
  for (let index = 0; index < positions.length; index++) {
    positions[index] = Math.sin(index * 1.37 + dimension) * 4 + (index % dimension);
  }
  return positions;
}

/**
 * A real DataState on a real DimensionManager. The live view shows 2D, and
 * only 2D is resident; a viewer that records nothing answers what the views
 * ask of it.
 */
async function createScene() {
  const manager = createDimensionManager({
    embeddingsMetadata: {
      default_dimension: 2,
      defaults: { '2d': 'X_umap_2d', '3d': 'X_umap_3d' },
      items: Object.fromEntries(Object.entries(LAYOUTS).map(([key, dimension], index) => [key, {
        label: key,
        dimension,
        path: `obsm/${index}`,
        source: { key, columns: Array.from({ length: dimension }, (_, axis) => axis) },
      }])),
    },
  });
  loadsAsReader(manager, async layoutKey => rawPositions(LAYOUTS[layoutKey]));
  const getPositions = manager.getPositions.bind(manager);
  manager.getPositions = layoutKey => getPositions(layoutKey, { showProgress: false });
  await manager.getPositions('X_umap_2d');
  const viewPositions = new Map();
  const answers = {
    isDisposed: () => false,
    hasVectorFieldForLayout: () => false,
    getViewLayout: () => ({ mode: 'grid' }),
    getViewPositions: viewId => viewPositions.get(viewId) ?? manager.getResidentPositions('X_umap_2d'),
    setViewPositions: (viewId, positions) => viewPositions.set(viewId, positions),
  };
  const viewer = new Proxy(answers, {
    get(target, property) {
      return Object.hasOwn(target, property) ? target[property] : () => {};
    },
  });
  const state = createDataState({ viewer, labelLayer: null });
  state.setDimensionManager(manager);
  state.initVarData({ fields: [] });
  manager.setViewLayout('live', 'X_umap_2d');
  state.initScene(manager.getResidentPositions('X_umap_2d'), { fields: [] });
  return { manager, state };
}

/** A user-defined 'regions' shown in the live view, then a kept view of it, selected. */
async function sceneWithKeptView() {
  const scene = await createScene();
  const { state, manager } = scene;
  const created = state.upsertUserDefinedCategoricalField({
    key: 'regions',
    categories: ['a', 'b', 'c'],
    codes: Uint8Array.from([0, 0, 0, 1, 1, 2, 2, 2]),
  });
  const fieldIndex = created.fieldIndex;
  state.setActiveField(fieldIndex);
  state.createViewFromSource('live', 'snap_1');
  manager.copyViewLayout('live', 'snap_1');
  // Keeping a view selects it.
  state.setActiveView('snap_1');
  const id = state.obsData.fields[fieldIndex]._userDefinedId;
  return { ...scene, fieldIndex, id };
}

function copiesOf(state, id) {
  const views = { [state.activeViewId]: state };
  for (const [viewId, context] of state.viewContexts) {
    if (viewId !== state.activeViewId) views[viewId] = context;
  }
  return Object.fromEntries(Object.entries(views).map(([viewId, view]) => [
    viewId,
    view.obsData.fields.find(field => field._userDefinedId === id),
  ]));
}

function assertSharesDefinition(state, id, label) {
  const template = state._userDefinedFields.getField(id);
  for (const [viewId, copy] of Object.entries(copiesOf(state, id))) {
    assert.equal(copy.codes, template.codes, `${label}: ${viewId} codes`);
    assert.equal(copy.categories, template.categories, `${label}: ${viewId} categories`);
    assert.equal(copy.centroidsByLayout, template.centroidsByLayout, `${label}: ${viewId} centroids`);
    assert.equal(copy._normalizedLayouts, template._normalizedLayouts, `${label}: ${viewId} normalization`);
    assert.equal(copy._operation, template._operation, `${label}: ${viewId} operation`);
  }
}

test('a category deleted in the live view reaches the kept view, which then computes another layout', async () => {
  const { state, manager, fieldIndex, id } = await sceneWithKeptView();
  // The kept view (focused) hides 'c' and recolours 'a'.
  const kept = state.obsData.fields[fieldIndex];
  state.setColorForCategory(kept, 0, RED);
  state.setVisibilityForCategory(kept, 2, false);
  state.setActiveView('live');

  state.deleteCategoryToUnassigned(fieldIndex, 1, { editInPlace: true, unassignedLabel: 'unassigned' });
  assertSharesDefinition(state, id, 'delete in the live view');
  const copies = copiesOf(state, id);
  assert.deepEqual(copies.live.categories, ['a', 'c', 'unassigned']);
  assert.deepEqual(copies.snap_1._categoryColors[0], RED);
  assert.deepEqual(copies.snap_1._categoryVisible, { 0: true, 1: false, 2: true });
  assert.deepEqual(copies.live._categoryVisible, { 0: true, 1: true, 2: true });
  // The kept view was drawn again: its centroids are the new categories'.
  const snapContext = state.viewContexts.get('snap_1');
  assert.equal(snapContext.centroidPositions.length / 3, 3);

  // The kept view shows 3D, which nothing has loaded: its centroids land in
  // the table every copy shares.
  state.setActiveView('snap_1');
  await state.setViewRepresentation('snap_1', 'X_umap_3d', { followsDefault: true });
  const template = state._userDefinedFields.getField(id);
  assert.deepEqual(
    template.centroidsByLayout.get('X_umap_3d'),
    computeCentroidsForDimension(template.codes, template.categories, manager.getResidentPositions('X_umap_3d'), 3)
  );
  assertSharesDefinition(state, id, 'after the kept view computed 3D');
});

test('a category merged in a kept view leaves the live copy its own colours, by category', async () => {
  const { state, fieldIndex, id } = await sceneWithKeptView();
  state.setActiveView('live');
  const live = state.obsData.fields[fieldIndex];
  state.setColorForCategory(live, 2, BLUE);
  state.setActiveView('snap_1');

  // Merge 'a' into 'b' in the kept view.
  state.mergeCategoriesToNewField(fieldIndex, 0, 1, { editInPlace: true });
  assertSharesDefinition(state, id, 'merge in the kept view');
  const copies = copiesOf(state, id);
  assert.deepEqual(copies.snap_1.categories, ['merged a + b', 'c']);
  assert.deepEqual(copies.live._categoryColors[1], BLUE);
  // Selecting the live view again draws it from the new codes.
  state.setActiveView('live');
  state.setActiveField(fieldIndex);
  assert.equal(state.centroidPositions.length / 3, 2);
});

test('a consensus column rebuilt in place reaches every view, which keeps its colours by label', async () => {
  const { state, fieldIndex, id } = await sceneWithKeptView();
  const kept = state.obsData.fields[fieldIndex];
  state.setColorForCategory(kept, 2, GREEN);
  state.upsertUserDefinedCategoricalField({
    key: 'regions',
    categories: ['c', 'a', 'z'],
    codes: Uint8Array.from([1, 1, 2, 2, 0, 0, 0, 2]),
  });
  assertSharesDefinition(state, id, 'consensus rebuilt');
  const copies = copiesOf(state, id);
  assert.deepEqual(copies.snap_1._categoryColors[0], GREEN);
  assert.deepEqual(copies.snap_1.centroidsByLayout.get('X_umap_2d').map(c => c.category), ['c', 'a', 'z']);
  assert.equal(state.centroidPositions.length / 3, 3);
});

test('a field deleted, restored or purged in one view is so in every view once shown', async () => {
  const { state, fieldIndex, id } = await sceneWithKeptView();
  state.setActiveView('live');
  state.deleteField('obs', fieldIndex);
  state.setActiveView('snap_1');
  assert.equal(copiesOf(state, id).snap_1._isDeleted, true);
  assert.equal(state.getActiveField(), null, 'the kept view no longer shows a deleted field');

  state.setActiveView('live');
  state.restoreField('obs', fieldIndex);
  state.setActiveView('snap_1');
  assert.equal(copiesOf(state, id).snap_1._isDeleted, false);

  state.setActiveView('live');
  state.deleteField('obs', fieldIndex);
  state.purgeDeletedField('obs', fieldIndex);
  const template = state._userDefinedFields.getField(id);
  assert.equal(template.codes, null, 'the registry released the codes');
  state.setActiveView('snap_1');
  const copies = copiesOf(state, id);
  for (const copy of Object.values(copies)) {
    assert.equal(copy._isPurged, true);
    assert.equal(copy.codes, null);
    assert.deepEqual(copy.categories, []);
  }
});
