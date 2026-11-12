/**
 * A kept view's fields share no state that a change in another view writes.
 *
 * A kept view's field objects are shallow copies of its source's
 * (`_cloneFieldState`): the category list, its originals, the centroid
 * tables and their records, the color and visibility arrays are shared.
 * That is sound only while none of them is written in place. A category
 * rename wrote the label into the shared list, and every relabel of centroids
 * (`_syncCentroidCategoryLabels`, run by a rename and by re-reading the
 * rename registry when a view is focused or a history step restores the
 * renames) wrote the shared centroid records. Restoring the renames in the
 * focused view then relabeled the other view's centroids under its
 * unchanged categories, and focusing that view failed: "Category centroids
 * of layout ... reference an unknown category identity". Color by a field,
 * keep a view, rename a category, undo past the kept view (or the same with
 * the rename before the kept view and one jump back) failed every time.
 *
 * Each case here takes a field change in one view with a kept view present
 * (kept before or after the change), restores the values from before
 * through the domain owners from either view, focuses every view, and
 * compares the fingerprint (every restored domain and each view's fields as
 * drawn: categories, originals, centroid labels and positions, colors,
 * visibility) exactly; then restores the changed values and compares again.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDataState } from '../assets/js/app/state/core/data-state.js';
import { createDimensionManager } from '../assets/js/data/dimension-manager.js';
import { createFieldOverlaysDomain } from '../assets/js/app/state/domains/field-overlays.js';
import { createActiveFieldDomain } from '../assets/js/app/state/domains/active-field.js';
import { createFiltersDomain } from '../assets/js/app/state/domains/filters.js';
import { createColorsDomain } from '../assets/js/app/state/domains/colors.js';
import { viewIdsOf, viewOwner } from '../assets/js/app/state/domains/view-list.js';
import { hashValue } from '../assets/js/app/history/value-pool.js';
import { loadsAsReader } from './helpers/dimension-loads.mjs';

const POINTS = 9;
const LAYOUT = 'X_umap_2d';
const CELL_TYPE = 0;
const RED = [1, 0, 0];

function rawPositions() {
  const positions = new Float32Array(POINTS * 2);
  for (let index = 0; index < positions.length; index++) {
    positions[index] = Math.sin(index * 1.37 + 2) * 4 + (index % 2);
  }
  return positions;
}

/**
 * A real DataState on a real DimensionManager, colored by the dataset's
 * categorical `cell_type`, with the domain owners a field change and its
 * undo go through.
 */
async function createScene() {
  const manager = createDimensionManager({
    embeddingsMetadata: {
      default_dimension: 2,
      defaults: { '2d': LAYOUT },
      items: { [LAYOUT]: { label: LAYOUT, dimension: 2, path: 'obsm/0', source: { key: LAYOUT, columns: [0, 1] } } },
    },
  });
  loadsAsReader(manager, async () => rawPositions());
  const getPositions = manager.getPositions.bind(manager);
  manager.getPositions = layoutKey => getPositions(layoutKey, { showProgress: false });
  await manager.getPositions(LAYOUT);
  const kept = [];
  const viewPositions = new Map();
  const answers = {
    isDisposed: () => false,
    hasVectorFieldForLayout: () => false,
    getViewLayout: () => ({ mode: 'grid' }),
    getSnapshotViews: () => kept.map(id => ({ id })),
    getViewPositions: viewId => viewPositions.get(viewId) ?? manager.getResidentPositions(LAYOUT),
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
  manager.setViewLayout('live', LAYOUT);
  state.initScene(manager.getResidentPositions(LAYOUT), {
    fields: [{
      key: 'cell_type',
      kind: 'category',
      categories: ['alpha', 'beta', 'gamma'],
      codes: Uint8Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]),
      loaded: true,
    }],
  });
  state.setActiveField(CELL_TYPE);
  const options = { state, viewer, refreshUi() {} };
  // In domain order (`app/actions/domains.js`).
  const domains = [
    ['field-overlays', createFieldOverlaysDomain(options)],
    ['active-field', createActiveFieldDomain(options)],
    ['filters', createFiltersDomain(options)],
    ['colors', createColorsDomain(options)],
  ];
  return { state, manager, kept, viewer, domains };
}

/** Keep the focused view: a new view of it, focused (as `view.keep` does). */
function keepView(scene) {
  const { state, manager, kept } = scene;
  const id = `snap_${kept.length + 1}`;
  const from = state.getActiveViewId();
  state.createViewFromSource(from, id);
  manager.copyViewLayout(from, id);
  kept.push(id);
  state.setActiveView(id);
}

/** Focus every view in turn, then the one focused before (re-reads each view's overlays). */
function focusEveryView(scene) {
  const { state, viewer } = scene;
  const focused = state.getActiveViewId();
  for (const id of viewIdsOf(viewer)) state.setActiveView(id);
  state.setActiveView(focused);
}

/** Each view's obs fields as drawn, as plain data. */
function viewFields(scene) {
  const { state, viewer } = scene;
  return viewIdsOf(viewer).map(id => viewOwner(state, id).obsData.fields.map(field => ({
    key: field.key,
    originalKey: field._originalKey ?? null,
    categories: field.categories,
    // A dataset field's originals follow the rename registry; a user field's
    // renamed categories are its definition (a restore drops the copy's memo
    // of the originals with the definition it replaces, `adoptDefinition`).
    originalCategories: field._isUserDefined === true ? undefined : field._originalCategories ?? null,
    centroids: field.centroidsByLayout instanceof Map
      ? [...field.centroidsByLayout].map(([layout, list]) => [layout, list.map(c => ({ category: c.category, position: [...c.position] }))])
      : null,
    colors: field._categoryColors ?? null,
    visible: field._categoryVisible ?? null,
  })));
}

/** The restored domains' values and each view's fields, and their fingerprint. */
async function fingerprint(scene) {
  const values = {};
  for (const [id, owner] of scene.domains) values[id] = await owner.capture();
  const fields = viewFields(scene);
  return { values, fields, digest: await hashValue({ values, fields }) };
}

async function restore(scene, values) {
  for (const [id, owner] of scene.domains) await owner.restore(values[id]);
}

const fieldAt = (state, key) => state.obsData.fields.findIndex(field => field.key === key);

const CHANGES = {
  'rename a category': ({ state }) => state.renameCategory('obs', CELL_TYPE, 0, 'Alpha cells'),
  'rename two categories': ({ state }) => {
    state.renameCategory('obs', CELL_TYPE, 0, 'Alpha cells');
    state.renameCategory('obs', CELL_TYPE, 2, 'Gamma cells');
  },
  'merge two categories': ({ state }) => {
    const { newFieldIndex } = state.mergeCategoriesToNewField(CELL_TYPE, 0, 1, { editInPlace: false });
    state.setActiveField(newFieldIndex);
  },
  'delete a category': ({ state }) => {
    const { newFieldIndex } = state.deleteCategoryToUnassigned(CELL_TYPE, 2, { editInPlace: false, unassignedLabel: 'unassigned' });
    state.setActiveField(newFieldIndex);
  },
  'recolor a category': ({ state }) => state.setColorForCategory(state.obsData.fields[CELL_TYPE], 0, RED),
  'rename a category of an annotation': ({ state }) => {
    const { newFieldIndex } = state.mergeCategoriesToNewField(CELL_TYPE, 0, 1, { editInPlace: false });
    state.setActiveField(newFieldIndex);
    state.renameCategory('obs', newFieldIndex, 1, 'Gamma cells');
  },
  'merge and delete in an annotation, then rename': ({ state }) => {
    const { newFieldIndex } = state.deleteCategoryToUnassigned(CELL_TYPE, 1, { editInPlace: false, unassignedLabel: 'unassigned' });
    state.setActiveField(newFieldIndex);
    state.renameCategory('obs', newFieldIndex, 0, 'Alpha cells');
    state.mergeCategoriesToNewField(newFieldIndex, 0, 1, { editInPlace: true });
    state.setActiveField(fieldAt(state, state.obsData.fields[newFieldIndex].key));
  },
};

function assertSame(actual, expected, label) {
  assert.deepEqual(actual.fields, expected.fields, `${label}: each view's fields`);
  assert.deepEqual(actual.values, expected.values, `${label}: domain values`);
  assert.equal(actual.digest, expected.digest, `${label}: fingerprint`);
}

for (const [name, change] of Object.entries(CHANGES)) {
  for (const restoreFrom of ['the kept view', 'the live view']) {
    test(`keep a view, ${name}, restore from ${restoreFrom}: every view as it was, and back`, async () => {
      const scene = await createScene();
      keepView(scene);
      const before = await fingerprint(scene);
      change(scene);
      focusEveryView(scene);
      const after = await fingerprint(scene);
      assert.notEqual(after.digest, before.digest, 'the change changed something');

      scene.state.setActiveView(restoreFrom === 'the live view' ? 'live' : 'snap_1');
      await restore(scene, before.values);
      focusEveryView(scene);
      scene.state.setActiveView('snap_1');
      assertSame(await fingerprint(scene), before, 'undone');

      await restore(scene, after.values);
      focusEveryView(scene);
      scene.state.setActiveView('snap_1');
      assertSame(await fingerprint(scene), after, 'redone');
    });

    test(`${name}, keep a view, restore from ${restoreFrom}: every view as if the change was never made, and back`, async () => {
      // The same two views with no change made: what restoring gives back.
      const reference = await createScene();
      keepView(reference);
      const unchanged = await fingerprint(reference);

      const scene = await createScene();
      change(scene);
      keepView(scene);
      focusEveryView(scene);
      const after = await fingerprint(scene);
      assert.notEqual(after.digest, unchanged.digest, 'the change changed something');

      scene.state.setActiveView(restoreFrom === 'the live view' ? 'live' : 'snap_1');
      await restore(scene, unchanged.values);
      focusEveryView(scene);
      scene.state.setActiveView('snap_1');
      assertSame(await fingerprint(scene), unchanged, 'undone');

      await restore(scene, after.values);
      focusEveryView(scene);
      scene.state.setActiveView('snap_1');
      assertSame(await fingerprint(scene), after, 'redone');
    });
  }
}

test('a category rename writes no list or centroid record another view holds', async () => {
  const scene = await createScene();
  const { state } = scene;
  keepView(scene);
  const live = state.viewContexts.get('live').obsData.fields[CELL_TYPE];
  const kept = state.obsData.fields[CELL_TYPE];
  // Kept: one list and one table, shared until either view changes them.
  assert.equal(kept.categories, live.categories);
  assert.equal(kept.centroidsByLayout, live.centroidsByLayout);
  const list = live.categories;
  const table = live.centroidsByLayout;
  const records = table.get(LAYOUT);
  const labels = records.map(record => record.category);

  state.renameCategory('obs', CELL_TYPE, 0, 'Alpha cells');
  assert.deepEqual(list, ['alpha', 'beta', 'gamma'], 'the list it had is unchanged');
  assert.deepEqual(table.get(LAYOUT).map(record => record.category), labels, 'the table it had is unchanged');
  assert.deepEqual(records.map(record => record.category), labels, 'the records it had are unchanged');
  for (const field of [live, kept]) {
    assert.deepEqual(field.categories, ['Alpha cells', 'beta', 'gamma']);
    assert.deepEqual(field.centroidsByLayout.get(LAYOUT).map(record => record.category), ['Alpha cells', 'beta', 'gamma']);
  }
  // Positions stay shared with the normalization record that describes them.
  assert.equal(kept.centroidsByLayout.get(LAYOUT)[1], records[1], 'an unchanged record is kept');
  assert.equal(kept.centroidsByLayout.get(LAYOUT)[0].position, records[0].position);
});
