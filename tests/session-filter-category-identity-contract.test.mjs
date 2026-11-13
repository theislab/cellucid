/**
 * A category filter or color names a category by its label, and the
 * category it names has to be the one a restore hides or recolors.
 *
 * A category's position in `field.categories` is not pinned by anything a
 * saved state can check: the dataset fingerprint covers the cells, not the
 * category inventory, so exporting the same cells with one more category
 * shifts every category after it. Restoring by position would then hide the
 * wrong cells and recolor the wrong ones, with nothing on screen saying so.
 * The `filters` and `colors` state domains (`app/state/domains/filters.js`,
 * `colors.js`) hold labels, and put them back through a real DataState.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createFiltersDomain } from '../assets/js/app/state/domains/filters.js';
import { createColorsDomain } from '../assets/js/app/state/domains/colors.js';
import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { growFieldCategories } from '../assets/js/app/state/managers/field/category-growth.js';
import { drawn, rgbAt } from './helpers/category-state.mjs';
import { withCategoryColor } from '../assets/js/app/utils/category-state.js';

const POINT_COUNT = 6;

/** A viewer with one view and no GPU: every method the state calls on it exists. */
function headlessViewer() {
  const own = {
    getSnapshotViews: () => [],
    getViewLayout: () => ({ mode: 'grid', activeId: 'live', liveViewHidden: false }),
    getCentroidFlags: () => ({ points: false, labels: false }),
    getCamerasLocked: () => true,
    getFocusedViewId: () => 'live',
    isDisposed: () => false,
  };
  return new Proxy(own, { get: (target, key) => (key in target ? target[key] : () => undefined) });
}

/**
 * A DataState of six cells whose one obs field, `cell_type`, has
 * `categories`; cell i holds category i modulo their count, in the narrowest
 * code type that holds them.
 */
function createHarness(categories) {
  const viewer = headlessViewer();
  const state = new DataState(viewer, null);
  state.pointCount = POINT_COUNT;
  state.cellIdentity = createCellIdentity({ nObs: POINT_COUNT });
  state.highlightArray = new Uint8Array(POINT_COUNT);
  state.colorsArray = new Uint8Array(POINT_COUNT * 4);
  state.categoryTransparency = new Uint8Array(POINT_COUNT).fill(1);
  state.cellVisibilityMask = new Uint8Array(POINT_COUNT).fill(1);
  state.dimensionManager = {
    getViewLayout: () => 'umap',
    getLayout: () => ({ layoutKey: 'umap', dimension: 2, provenance: null }),
    getNormTransform: () => null,
    getRegisteredLayouts: () => [],
    getResidentPositions: () => null,
    unshownBytes: () => 0,
    trimUnshown: () => null,
  };
  const cellType = {
    key: 'cell_type',
    kind: 'category',
    categories: [...categories],
    codes: (categories.length < 255 ? Uint8Array : Uint16Array).from([0, 1, 2, 0, 1, 2], code => code % categories.length),
    loaded: true,
    centroidsByLayout: new Map(),
  };
  state.obsData = { fields: [cellType] };
  state.varData = { fields: [] };
  state._resetViewContexts();
  state.ensureHighlightPage();
  const refresh = () => {};
  return {
    state,
    cellType,
    filters: createFiltersDomain({ state, viewer, refreshUi: refresh }),
    colors: createColorsDomain({ state, viewer, refreshUi: refresh }),
  };
}

/** Hide "T cell" and recolor "Monocyte", then take both values. */
function savedState() {
  const saving = createHarness(['B cell', 'T cell', 'Monocyte']);
  saving.state.setVisibilityForCategory(saving.cellType, 1, false);
  saving.state.setColorForCategory(saving.cellType, 2, [0.1, 0.2, 0.3]);
  return structuredClone({ filters: saving.filters.capture(), colors: saving.colors.capture() });
}

/** The hex a category's color is held as (its drawn bytes). */
function hexOf(rgb) {
  return `#${drawn(rgb).map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`;
}

async function restoreBoth(harness, saved) {
  await harness.filters.restore(saved.filters);
  await harness.colors.restore(saved.colors);
}

test('a category filter and color record the category label, not its position', () => {
  const saved = savedState();
  assert.deepEqual(saved.filters, {
    views: [[{ field: { source: 'obs', key: 'cell_type' }, hidden: ['T cell'] }]],
  });
  assert.deepEqual(saved.colors, {
    views: [[{ field: { source: 'obs', key: 'cell_type' }, colors: [{ category: 'Monocyte', color: hexOf([0.1, 0.2, 0.3]) }] }]],
  });
  for (const entry of saved.colors.views[0][0].colors) {
    assert.equal(Object.hasOwn(entry, 'categoryIndex'), false);
    assert.equal(Object.hasOwn(entry, 'index'), false);
  }
});

test('an unchanged category inventory restores the exact saved categories', async () => {
  const saved = savedState();
  const loading = createHarness(['B cell', 'T cell', 'Monocyte']);
  await restoreBoth(loading, saved);

  assert.equal(loading.cellType._categoryVisible[1], 0);
  assert.equal(loading.cellType._categoryVisible[0], 1);
  assert.equal(loading.cellType._categoryVisible[2], 1);
  assert.deepEqual(rgbAt(loading.cellType, 2), drawn([0.1, 0.2, 0.3]));
  assert.deepEqual(loading.filters.capture(), saved.filters);
  assert.deepEqual(loading.colors.capture(), saved.colors);
});

test('a category added before the saved ones does not move what is hidden', async () => {
  const saved = savedState();
  // The same cells, exported again with one more cell type, sorted first.
  const loading = createHarness(['Astrocyte', 'B cell', 'T cell', 'Monocyte']);
  await restoreBoth(loading, saved);

  const hidden = loading.cellType.categories.filter(
    (_name, index) => loading.cellType._categoryVisible[index] === 0,
  );
  const wanted = drawn([0.1, 0.2, 0.3]);
  const recolored = loading.cellType.categories.filter(
    (_name, index) => rgbAt(loading.cellType, index).every((channel, at) => channel === wanted[at]),
  );
  assert.deepEqual(hidden, ['T cell']);
  assert.deepEqual(recolored, ['Monocyte']);
});

test('a category removed before the saved ones does not move what is hidden', async () => {
  const saved = savedState();
  const loading = createHarness(['T cell', 'Monocyte']);
  await restoreBoth(loading, saved);

  assert.equal(loading.cellType._categoryVisible[0], 0);
  assert.equal(loading.cellType._categoryVisible[1], 1);
  assert.deepEqual(rgbAt(loading.cellType, 1), drawn([0.1, 0.2, 0.3]));
});

test('a renamed category is refused by name, not applied by position', async () => {
  const saved = savedState();
  const loading = createHarness(['B cell', 'T lymphocyte', 'Monocyte']);

  await assert.rejects(
    loading.filters.restore(saved.filters),
    error => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /"T cell"/);
      assert.match(error.message, /"cell_type"/);
      assert.match(error.message, /no longer has/);
      return true;
    },
  );
  assert.equal(loading.cellType._categoryVisible, undefined);
  assert.equal(loading.cellType._categoryColors, undefined);
});

test('a recolored category that is gone is refused by name', async () => {
  const saved = savedState();
  const loading = createHarness(['B cell', 'T cell']);

  await assert.rejects(
    loading.colors.restore(saved.colors),
    error => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /"Monocyte"/);
      return true;
    },
  );
  assert.equal(loading.cellType._categoryVisible, undefined);
});

test('primitive category labels survive the round trip', async () => {
  const saving = createHarness(['', 0, false]);
  saving.state.setVisibilityForCategory(saving.cellType, 1, false);
  saving.state.setColorForCategory(saving.cellType, 2, [0.4, 0.5, 0.6]);
  const saved = structuredClone({ filters: saving.filters.capture(), colors: saving.colors.capture() });
  assert.deepEqual(saved.filters.views[0][0].hidden, [0]);
  assert.deepEqual(saved.colors.views[0][0].colors, [{ category: false, color: hexOf([0.4, 0.5, 0.6]) }]);

  const loading = createHarness(['extra', '', 0, false]);
  await restoreBoth(loading, saved);
  assert.equal(loading.cellType._categoryVisible[2], 0);
  assert.deepEqual(rgbAt(loading.cellType, 3), drawn([0.4, 0.5, 0.6]));
});

test('a duplicated category label is refused rather than guessed', async () => {
  const saved = savedState();
  const loading = createHarness(['B cell', 'T cell', 'Monocyte', 'T cell']);

  // The field's category state refuses the inventory itself
  // (`color-manager.js` `ensureCategoryMetadata`), before any category is set.
  await assert.rejects(
    loading.filters.restore(saved.filters),
    error => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /Category 3 duplicates an existing category label/);
      return true;
    },
  );
  assert.equal(loading.cellType._categoryVisible, undefined);
});

/** Wrap a category inventory so every element and length read is counted. */
function countingCategories(names) {
  const reads = { count: 0 };
  const proxy = new Proxy([...names], {
    get(target, property, receiver) {
      if (property === 'length' || /^\d+$/.test(String(property))) {
        reads.count += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { proxy, reads };
}

test('restoring a filter over many categories reads the inventory once', async () => {
  const count = 2_000;
  const names = Array.from({ length: count }, (_, index) => `cluster_${index}`);
  const saving = createHarness(names);
  for (let index = 0; index < count; index += 2) {
    saving.state.setVisibilityForCategory(saving.cellType, index, false);
  }
  const saved = saving.filters.capture();
  assert.equal(saved.views[0][0].hidden.length, count / 2);

  const restoring = createHarness(names);
  const { proxy, reads } = countingCategories(names);
  restoring.cellType.categories = proxy;
  restoring.state.ensureCategoryMetadata(restoring.cellType);
  // The Active filters list is drawn once the filters are in place; drawing
  // it is the list's work, not the restore's, so it is counted apart.
  let summaries = 0;
  restoring.state.updateFilterSummary = () => { summaries++; };
  reads.count = 0;
  await restoring.filters.restore(saved);
  assert.ok(summaries > 0, 'the Active filters list is drawn again');
  assert.deepEqual(restoring.filters.capture(), saved);
  assert.ok(
    reads.count <= 4 * count,
    `restore read the ${count}-category inventory ${reads.count} times`,
  );
});

test('a filter on a column whose categories are found on load resolves its labels once the restore loaded it', async () => {
  const saved = savedState();
  // A direct AnnData string column: no categories until it is loaded.
  const loading = createHarness(['B cell', 'T cell', 'Monocyte']);
  loading.cellType.categories = null;
  loading.cellType.codes = undefined;
  loading.cellType.loaded = false;
  let loads = 0;
  loading.state.ensureFieldLoaded = async () => {
    loads++;
    loading.cellType.categories = ['Monocyte', 'T cell', 'B cell'];
    loading.cellType.codes = Uint8Array.from([2, 1, 0, 2, 1, 0]);
    loading.cellType.loaded = true;
  };
  await restoreBoth(loading, saved);
  assert.equal(loads, 1);
  assert.equal(loading.cellType._categoryVisible[1], 0, 'T cell, at its loaded position');
  assert.equal(loading.cellType._categoryVisible[0], 1);
  assert.deepEqual(rgbAt(loading.cellType, 0), drawn([0.1, 0.2, 0.3]), 'Monocyte, at its loaded position');
});

test('a saved label a column found on load does not have is refused once it is loaded', async () => {
  const saved = savedState();
  const missing = createHarness(['B cell']);
  missing.cellType.categories = null;
  missing.cellType.loaded = false;
  missing.state.ensureFieldLoaded = async () => {
    missing.cellType.categories = ['B cell'];
    missing.cellType.codes = Uint8Array.from([0, 0, 0, 0, 0, 0]);
    missing.cellType.loaded = true;
  };
  await assert.rejects(missing.filters.restore(saved.filters), /no longer has/);
});

test('hidden cells without a category are a filter of their own, and restored', async () => {
  const saving = createHarness(['B cell', 'T cell', 'Monocyte']);
  saving.state.ensureCategoryMetadata(saving.cellType);
  saving.state.setMissingCategoryVisibility(saving.cellType, false);
  const saved = structuredClone(saving.filters.capture());
  assert.deepEqual(saved.views[0], [{ field: { source: 'obs', key: 'cell_type' }, missingHidden: true }]);

  const restoring = createHarness(['B cell', 'T cell', 'Monocyte']);
  await restoring.filters.restore(saved);
  assert.equal(restoring.cellType._missingVisible, false);
  assert.deepEqual(restoring.filters.capture(), saved);
});

/**
 * A text or boolean column (`discovered`): its categories are the labels its
 * open cells hold, so a state restored on a subsample may name a category no
 * open cell holds. That category's legend visibility and color are held
 * (`state/managers/field/pending-categories.js`) as part of the filters and
 * colors values, and applied when cells holding it open and the column
 * grows it (`category-growth.js`).
 */
async function restoreDiscovered() {
  const saved = savedState();
  // A subsample whose cells hold no "Monocyte": the column has two categories.
  const loading = createHarness(['B cell', 'T cell']);
  loading.cellType.discovered = true;
  loading.cellType.codes = Uint8Array.from([0, 1, 0, 1, 0, 1]);
  await restoreBoth(loading, saved);
  return { saved, loading };
}

test('a discovered column restores the saved categories its open cells hold, and holds the others until they open', async () => {
  const { saved, loading } = await restoreDiscovered();
  assert.equal(loading.cellType._categoryVisible[1], 0, 'T cell, open, is hidden');
  // What is held is part of the state: the values are what was saved.
  assert.deepEqual(loading.filters.capture(), saved.filters);
  assert.deepEqual(loading.colors.capture(), saved.colors);

  // More cells open, holding "Monocyte": the column grows it, and the
  // color the saved state gave it applies.
  loading.state._applyCategoryOverlay = () => {};
  growFieldCategories(loading.state, loading.cellType, {
    categories: ['B cell', 'Monocyte', 'T cell'],
    palette: [[0.5, 0.5, 0.5], [0.6, 0.6, 0.6], [0.7, 0.7, 0.7]],
  }, { source: 'obs', originalKey: 'cell_type', label: 'obs field "cell_type"' });
  const monocyte = loading.cellType.categories.indexOf('Monocyte');
  assert.deepEqual(rgbAt(loading.cellType, monocyte), drawn([0.1, 0.2, 0.3]));
  assert.equal(loading.cellType._categoryVisible[loading.cellType.categories.indexOf('T cell')], 0, 'T cell stays hidden');
  // Nothing is held any more: a later growth changes nothing.
  withCategoryColor(loading.cellType, monocyte, [0.9, 0.9, 0.9]);
  growFieldCategories(loading.state, loading.cellType, {
    categories: ['B cell', 'Monocyte', 'NK', 'T cell'],
    palette: [[0.5, 0.5, 0.5], [0.6, 0.6, 0.6], [0.8, 0.8, 0.8], [0.7, 0.7, 0.7]],
  }, { source: 'obs', originalKey: 'cell_type', label: 'obs field "cell_type"' });
  assert.deepEqual(rgbAt(loading.cellType, loading.cellType.categories.indexOf('Monocyte')), drawn([0.9, 0.9, 0.9]));
});

test('a stored dictionary that lacks a saved category is another dataset, refused by name', async () => {
  const saved = savedState();
  const loading = createHarness(['B cell', 'T cell']);
  loading.cellType.discovered = false;
  await assert.rejects(
    loading.colors.restore(saved.colors),
    /names the category "Monocyte", which "cell_type" no longer has/,
  );
});
