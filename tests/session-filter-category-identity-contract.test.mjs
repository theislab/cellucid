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
      field._categoryVisible[categoryIndex] = visible;
    },
    setColorForCategory(field, categoryIndex, color) {
      this.ensureCategoryMetadata(field);
      field._categoryColors[categoryIndex] = [...color];
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
    { categoryName: 'Monocyte', color: [0.1, 0.2, 0.3] },
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

  assert.equal(loading.cellType._categoryVisible[1], false);
  assert.equal(loading.cellType._categoryVisible[0], true);
  assert.equal(loading.cellType._categoryVisible[2], true);
  assert.deepEqual(loading.cellType._categoryColors[2], [0.1, 0.2, 0.3]);
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
      (_name, index) => loading.cellType._categoryVisible[index] === false,
    );
    const recoloured = loading.cellType.categories.filter(
      (_name, index) => {
        const color = loading.cellType._categoryColors[index];
        return (
          Math.abs(color[0] - 0.1) < 1e-9
          && Math.abs(color[1] - 0.2) < 1e-9
          && Math.abs(color[2] - 0.3) < 1e-9
        );
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

    assert.equal(loading.cellType._categoryVisible[0], false);
    assert.equal(loading.cellType._categoryVisible[1], true);
    assert.deepEqual(loading.cellType._categoryColors[1], [0.1, 0.2, 0.3]);
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
    { categoryName: false, color: [0.4, 0.5, 0.6] },
  ]);

  const loading = createHarness(['extra', '', 0, false]);
  await loading.serializer.restoreFilters(session, { signal: null });
  assert.equal(loading.cellType._categoryVisible[2], false);
  assert.deepEqual(loading.cellType._categoryColors[3], [0.4, 0.5, 0.6]);
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
