/**
 * A saved category filter names a category, and the category it names has to be
 * the one the restore hides or recolours.
 *
 * A category's position in `field.categories` is not pinned by anything the
 * session can check: the dataset fingerprint covers the cells, not the category
 * inventory, so exporting the same cells with one more category shifts every
 * category after it. Restoring by position would then hide the wrong cells and
 * recolour the wrong ones, with nothing on screen saying so.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFilterSerializer,
} from '../assets/js/app/state-serializer/filters.js';
import {
  DataStateColorMethods,
} from '../assets/js/app/state/managers/color-manager.js';
import { drawn, rgbAt } from './helpers/category-state.mjs';
import { withCategoryChanges, withCategoryColor, withCategoryVisibility } from '../assets/js/app/utils/category-state.js';

const POINT_COUNT = 6;

function createHarness(categories) {
  const cellType = {
    key: 'cell_type',
    kind: 'category',
    categories: [...categories],
    codes: Uint8Array.from([0, 1, 2, 0, 1, 2]),
    _isDeleted: false,
  };
  const state = {
    pointCount: POINT_COUNT,
    getFields: () => [cellType],
    getVarFields: () => [],
    async ensureFieldLoaded() {},
    async ensureVarFieldLoaded() {},
    beginBatch() {},
    endBatch() {},
    ensureCategoryMetadata(field) {
      return DataStateColorMethods.prototype.ensureCategoryMetadata.call(
        this,
        field,
      );
    },
    ensureContinuousMetadata(field) {
      return DataStateColorMethods.prototype.ensureContinuousMetadata.call(
        this,
        field,
      );
    },
    setVisibilityForCategory(field, categoryIndex, visible) {
      this.ensureCategoryMetadata(field);
      withCategoryVisibility(field, categoryIndex, visible);
    },
    setColorForCategory(field, categoryIndex, color) {
      this.ensureCategoryMetadata(field);
      withCategoryColor(field, categoryIndex, color);
    },
    setCategoryStates(field, changes) {
      this.ensureCategoryMetadata(field);
      withCategoryChanges(field, changes);
    },
  };
  return { state, cellType, serializer: createFilterSerializer({ state }) };
}

/** Hide "T cell" and recolour "Monocyte", then save. */
function savedSession() {
  const saving = createHarness(['B cell', 'T cell', 'Monocyte']);
  saving.state.setVisibilityForCategory(saving.cellType, 1, false);
  saving.state.setColorForCategory(saving.cellType, 2, [0.1, 0.2, 0.3]);
  return saving.serializer.serializeFilters();
}

test('a saved category filter records the category name, not its position', () => {
  const session = savedSession();
  assert.deepEqual(session['obs:cell_type'].visibility, [
    { categoryName: 'T cell', visible: false },
  ]);
  assert.deepEqual(session['obs:cell_type'].colors, [
    { categoryName: 'Monocyte', color: drawn([0.1, 0.2, 0.3]) },
  ]);
  for (const change of session['obs:cell_type'].visibility) {
    assert.equal(Object.hasOwn(change, 'categoryIndex'), false);
  }
  for (const change of session['obs:cell_type'].colors) {
    assert.equal(Object.hasOwn(change, 'categoryIndex'), false);
  }
});

test('an unchanged category inventory restores the exact saved categories', async () => {
  const session = savedSession();
  const loading = createHarness(['B cell', 'T cell', 'Monocyte']);
  await loading.serializer.restoreFilters(session, { signal: null });

  assert.equal(loading.cellType._categoryVisible[1], 0);
  assert.equal(loading.cellType._categoryVisible[0], 1);
  assert.equal(loading.cellType._categoryVisible[2], 1);
  assert.deepEqual(rgbAt(loading.cellType, 2), drawn([0.1, 0.2, 0.3]));
  assert.deepEqual(loading.serializer.serializeFilters(), session);
});

test(
  'a category added before the saved ones does not move what is hidden',
  async () => {
    const session = savedSession();
    // The same cells, exported again with one more cell type, sorted first.
    const loading = createHarness([
      'Astrocyte', 'B cell', 'T cell', 'Monocyte',
    ]);
    await loading.serializer.restoreFilters(session, { signal: null });

    const hidden = loading.cellType.categories.filter(
      (_name, index) => loading.cellType._categoryVisible[index] === 0,
    );
    const recoloured = loading.cellType.categories.filter(
      (_name, index) => {
        const color = rgbAt(loading.cellType, index);
        const wanted = drawn([0.1, 0.2, 0.3]);
        return color.every((channel, at) => channel === wanted[at]);
      },
    );
    assert.deepEqual(hidden, ['T cell']);
    assert.deepEqual(recoloured, ['Monocyte']);
  },
);

test(
  'a category removed before the saved ones does not move what is hidden',
  async () => {
    const session = savedSession();
    const loading = createHarness(['T cell', 'Monocyte']);
    await loading.serializer.restoreFilters(session, { signal: null });

    assert.equal(loading.cellType._categoryVisible[0], 0);
    assert.equal(loading.cellType._categoryVisible[1], 1);
    assert.deepEqual(rgbAt(loading.cellType, 1), drawn([0.1, 0.2, 0.3]));
  },
);

test('a renamed category is refused by name, not applied by position', async () => {
  const session = savedSession();
  const loading = createHarness(['B cell', 'T lymphocyte', 'Monocyte']);

  await assert.rejects(
    loading.serializer.restoreFilters(session, { signal: null }),
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

test('a recoloured category that is gone is refused by name', async () => {
  const session = savedSession();
  const loading = createHarness(['B cell', 'T cell']);

  await assert.rejects(
    loading.serializer.restoreFilters(session, { signal: null }),
    error => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /"Monocyte"/);
      return true;
    },
  );
  assert.equal(loading.cellType._categoryVisible, undefined);
});

test('primitive category names survive the round trip', async () => {
  const saving = createHarness(['', 0, false]);
  saving.state.setVisibilityForCategory(saving.cellType, 1, false);
  saving.state.setColorForCategory(saving.cellType, 2, [0.4, 0.5, 0.6]);
  const session = saving.serializer.serializeFilters();
  assert.deepEqual(session['obs:cell_type'].visibility, [
    { categoryName: 0, visible: false },
  ]);
  assert.deepEqual(session['obs:cell_type'].colors, [
    { categoryName: false, color: drawn([0.4, 0.5, 0.6]) },
  ]);

  const loading = createHarness(['extra', '', 0, false]);
  await loading.serializer.restoreFilters(session, { signal: null });
  assert.equal(loading.cellType._categoryVisible[2], 0);
  assert.deepEqual(rgbAt(loading.cellType, 3), drawn([0.4, 0.5, 0.6]));
});

test('a duplicated category name is refused rather than guessed', async () => {
  const session = savedSession();
  const loading = createHarness(['B cell', 'T cell', 'Monocyte', 'T cell']);

  await assert.rejects(
    loading.serializer.restoreFilters(session, { signal: null }),
    error => {
      assert.match(error.message, /more than once/);
      assert.match(error.message, /"T cell"/);
      return true;
    },
  );
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

test('restoring a filter over many categories reads the inventory once', () => {
  const count = 2_000;
  const names = Array.from({ length: count }, (_, index) => `cluster_${index}`);
  const saving = createHarness(names);
  for (let index = 0; index < count; index += 2) {
    saving.state.setVisibilityForCategory(saving.cellType, index, false);
  }
  const session = saving.serializer.serializeFilters();
  assert.equal(session['obs:cell_type'].visibility.length, count / 2);

  const restoring = createHarness(names);
  const { proxy, reads } = countingCategories(names);
  restoring.cellType.categories = proxy;
  reads.count = 0;
  restoring.serializer.validateFilters(session);
  assert.ok(
    reads.count <= 4 * count,
    `restore read the ${count}-category inventory ${reads.count} times`,
  );
});

test('a filter on a column whose categories are found on load resolves its names once the restore loaded it', async () => {
  const session = savedSession();
  // A direct AnnData string column: no categories until it is loaded.
  const loading = createHarness(['B cell', 'T cell', 'Monocyte']);
  loading.cellType.categories = null;
  loading.cellType.codes = undefined;
  let loads = 0;
  loading.state.ensureFieldLoaded = async () => {
    loads++;
    loading.cellType.categories = ['Monocyte', 'T cell', 'B cell'];
    loading.cellType.codes = Uint8Array.from([2, 1, 0, 2, 1, 0]);
  };
  await loading.serializer.restoreFilters(session, { signal: null });
  assert.equal(loads, 1);
  assert.equal(loading.cellType._categoryVisible[1], 0, 'T cell, at its loaded position');
  assert.equal(loading.cellType._categoryVisible[0], 1);
  assert.deepEqual(rgbAt(loading.cellType, 0), drawn([0.1, 0.2, 0.3]), 'Monocyte, at its loaded position');

  // A saved name the loaded column does not have is refused then.
  const missing = createHarness(['B cell']);
  missing.cellType.categories = null;
  missing.state.ensureFieldLoaded = async () => {
    missing.cellType.categories = ['B cell'];
  };
  await assert.rejects(missing.serializer.restoreFilters(session, { signal: null }), /no longer has/);
});

test('hidden cells without a category are saved as the category named null, and restored (K-06)', async () => {
  const saving = createHarness(['B cell', 'T cell', 'Monocyte']);
  saving.state.ensureCategoryMetadata(saving.cellType);
  saving.cellType._missingVisible = false;
  const session = saving.serializer.serializeFilters();
  assert.deepEqual(session['obs:cell_type'].visibility, [{ categoryName: null, visible: false }]);

  const restoring = createHarness(['B cell', 'T cell', 'Monocyte']);
  restoring.state.setMissingCategoryVisibility = (field, visible) => {
    field._missingVisible = visible;
  };
  await restoring.serializer.restoreFilters(session);
  assert.equal(restoring.cellType._missingVisible, false);
});

/**
 * A text or boolean column (`discovered`): its categories are the labels its
 * open cells hold, so a session (or a published starting view) restored on a
 * subsample may name a category no open cell holds. That category's legend
 * visibility and colour are held, said in one short notice, and applied
 * when cells holding it open and the column grows it
 * (`state/managers/field/pending-categories.js`, `category-growth.js`).
 */
test('a discovered column restores the saved categories its open cells hold, and holds the others until they open', async () => {
  const { getNotificationCenter } = await import('../assets/js/app/notification-center.js');
  const { growFieldCategories } = await import('../assets/js/app/state/managers/field/category-growth.js');
  const session = savedSession();
  // A subsample whose cells hold no "Monocyte": the column has two categories.
  const loading = createHarness(['B cell', 'T cell']);
  loading.cellType.discovered = true;
  loading.cellType.codes = Uint8Array.from([0, 1, 0, 1, 0, 1]);
  const notices = [];
  const center = getNotificationCenter();
  const info = center.info;
  center.info = (message, options) => notices.push(message);
  let outcome;
  try {
    outcome = await loading.serializer.restoreFilters(session, { signal: null });
  } finally {
    center.info = info;
  }
  assert.equal(loading.cellType._categoryVisible[1], 0, 'T cell, open, is hidden');
  assert.deepEqual(outcome.categoriesNotOpen, [{ fieldKey: 'cell_type', count: 1 }]);
  assert.deepEqual(notices, ['1 category of "cell_type" in this session isn\'t among the open cells; its settings apply when those cells open.']);

  // More cells open, holding "Monocyte": the column grows it, and the
  // colour the session gave it applies.
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
  const session = savedSession();
  const loading = createHarness(['B cell', 'T cell']);
  loading.cellType.discovered = false;
  await assert.rejects(
    loading.serializer.restoreFilters(session, { signal: null }),
    /names the category "Monocyte", which "cell_type" no longer has/,
  );
});
