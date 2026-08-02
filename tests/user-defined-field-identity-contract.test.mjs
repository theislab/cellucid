/**
 * User-created fields are the one thing in Cellucid that cannot be regenerated
 * from an export. A category the user renamed, a column the user built from
 * highlight pages, a field the user soft-deleted — the app is the only record
 * of all three, and a session bundle is the only way any of it survives a
 * reload. These tests hold the three invariants that make that record truthful.
 *
 * 1. A rename follows the thing it was applied to. A category's identity is its
 *    label, not its position in the inventory, so a rename recorded against
 *    `cell_type` category 2 must still name that category after the dataset is
 *    exported again with one more cell type in the list.
 * 2. The categorical width and its reserved missing code come from
 *    `data/categorical-storage-contract.js` and nowhere else. A user-defined
 *    field is stored in the same two widths every reader and both writers use,
 *    so every field the app can load is a field the user can copy, merge, and
 *    edit.
 * 3. Renaming a label is a label-sized operation. It must not walk the cell
 *    axis, because at 562k cells that walk is the whole cost of the edit.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as fieldOverlays from
  '../assets/js/app/session/contributors/field-overlays.js';
import { DeleteRegistry } from '../assets/js/app/registries/delete-registry.js';
import { RenameRegistry } from '../assets/js/app/registries/rename-registry.js';
import {
  UserDefinedFieldsRegistry
} from '../assets/js/app/registries/user-defined-fields.js';
import {
  DataStateFieldMethods
} from '../assets/js/app/state/managers/field-manager.js';
import {
  MAX_CATEGORICAL_CATEGORIES,
  categoricalStorageForCount
} from '../assets/js/data/categorical-storage-contract.js';
import { getCategoryColor } from '../assets/js/data/palettes.js';

const POINTS = 24;

function positions(pointCount, dimension) {
  const out = new Float32Array(pointCount * dimension);
  for (let index = 0; index < out.length; index++) {
    out[index] = (index % 13) * 0.25;
  }
  return out;
}

function codesFor(pointCount, categoryCount) {
  const storage = categoricalStorageForCount(categoryCount, 'Fixture');
  const out = new storage.TypedArrayClass(pointCount);
  for (let index = 0; index < pointCount; index++) {
    out[index] = index % categoryCount;
  }
  return out;
}

function categoricalField(key, categories, pointCount) {
  return {
    key,
    kind: 'category',
    categories: [...categories],
    codes: codesFor(pointCount, categories.length),
    loaded: true
  };
}

/**
 * A DataState carrying the real field mixins and the three real registries.
 * Only the collaborators the field methods call are stubbed.
 */
function makeState({ pointCount = POINTS, obsFields = [] } = {}) {
  const state = Object.create(DataStateFieldMethods.prototype);
  const positionCache = new Map([[2, positions(pointCount, 2)]]);

  state.pointCount = pointCount;
  state.obsData = { fields: obsFields };
  state.varData = { fields: [] };
  state.activeFieldSource = null;
  state.activeFieldIndex = -1;
  state.activeVarFieldIndex = -1;
  state.activeViewId = 'live';
  state.viewContexts = new Map();
  state.highlightPages = [];
  state.positionsArray = positionCache.get(2);
  state.dimensionManager = {
    positionCache,
    getAvailableDimensions: () => [2]
  };
  state._renameRegistry = new RenameRegistry();
  state._deleteRegistry = new DeleteRegistry();
  state._userDefinedFields = new UserDefinedFieldsRegistry();
  state.getDatasetGeneration = () => 0;

  state._syncActiveContext = () => {};
  state._notifyFieldChange = () => {};
  state._notifyHighlightChange = () => {};
  state.updateFilterSummary = () => {};
  state.computeGlobalVisibility = () => {};
  state.clearActiveField = () => {
    state.activeFieldSource = null;
    state.activeFieldIndex = -1;
    state.activeVarFieldIndex = -1;
  };
  state.setActiveField = (index) => {
    state.activeFieldSource = 'obs';
    state.activeFieldIndex = index;
    state.activeVarFieldIndex = -1;
  };
  state.buildCentroidsForField = () => {};
  state._pushCentroidsToViewer = () => {};
  state.unloadVarField = () => true;
  state.ensureFieldLoaded = async () => {};
  state.ensureVarFieldLoaded = async () => {};
  state.ensureCategoryMetadata = (field) => {
    if (field.kind !== 'category') return;
    if (
      !Array.isArray(field._categoryColors)
      || field._categoryColors.length !== field.categories.length
    ) {
      field._categoryColors = field.categories.map(
        (_category, index) => [...getCategoryColor(index)]
      );
    }
    if (!field._categoryVisible || typeof field._categoryVisible !== 'object') {
      field._categoryVisible = {};
      for (let index = 0; index < field.categories.length; index++) {
        field._categoryVisible[index] = true;
      }
    }
    if (typeof field._categoryFilterEnabled !== 'boolean') {
      field._categoryFilterEnabled = false;
    }
  };
  return state;
}

// ---------------------------------------------------------------------------
// 1. A category rename names a category, not a position
// ---------------------------------------------------------------------------

test('a category rename survives the same dataset exported with one more category', () => {
  // Saved against [B, Mono, NK, T]: the third entry, NK, becomes "Natural killer".
  const source = makeState({
    obsFields: [categoricalField('cell_type', ['B', 'Mono', 'NK', 'T'], POINTS)]
  });
  source.renameCategory('obs', 0, 2, 'Natural killer');
  assert.deepEqual(
    source.obsData.fields[0].categories,
    ['B', 'Mono', 'Natural killer', 'T']
  );

  const payload = fieldOverlays.capture({ state: source })[0].payload;

  // The dataset is exported again from the same embedding with one more cell
  // type, which sorts in ahead of NK. Positions, cell count, and var count are
  // unchanged, so the session's dataset fingerprint still matches and the
  // bundle restores.
  const restored = makeState({
    obsFields: [
      categoricalField('cell_type', ['B', 'DC', 'Mono', 'NK', 'T'], POINTS)
    ]
  });
  fieldOverlays.restore({ state: restored }, null, structuredClone(payload));

  assert.deepEqual(
    restored.obsData.fields[0].categories,
    ['B', 'DC', 'Mono', 'Natural killer', 'T'],
    'the rename must still name NK, and Mono must keep its own name'
  );
});

test('a category rename is dropped, never transplanted, when its category is gone', () => {
  const source = makeState({
    obsFields: [categoricalField('cell_type', ['B', 'Mono', 'NK', 'T'], POINTS)]
  });
  source.renameCategory('obs', 0, 2, 'Natural killer');
  const payload = fieldOverlays.capture({ state: source })[0].payload;

  const restored = makeState({
    obsFields: [categoricalField('cell_type', ['B', 'Mono', 'T'], POINTS)]
  });
  fieldOverlays.restore({ state: restored }, null, structuredClone(payload));

  assert.deepEqual(
    restored.obsData.fields[0].categories,
    ['B', 'Mono', 'T'],
    'no surviving category may inherit a rename that belonged to NK'
  );
});

test('a category rename round-trips through a session unchanged', () => {
  const source = makeState({
    obsFields: [categoricalField('cell_type', ['B', 'Mono', 'NK'], POINTS)]
  });
  source.renameField('obs', 0, 'Cell type');
  source.renameCategory('obs', 0, 1, 'Monocyte');
  const payload = fieldOverlays.capture({ state: source })[0].payload;

  const restored = makeState({
    obsFields: [categoricalField('cell_type', ['B', 'Mono', 'NK'], POINTS)]
  });
  fieldOverlays.restore({ state: restored }, null, structuredClone(payload));

  assert.equal(restored.obsData.fields[0].key, 'Cell type');
  assert.deepEqual(
    restored.obsData.fields[0].categories,
    ['B', 'Monocyte', 'NK']
  );
  assert.equal(restored.obsData.fields[0]._originalKey, 'cell_type');
  assert.deepEqual(
    restored.obsData.fields[0]._originalCategories,
    ['B', 'Mono', 'NK']
  );
});

test('two fields whose keys and labels share the delimiter keep separate renames', () => {
  // Field keys may contain ':' — ATAC feature names do — and so may category
  // labels. A rename registry keyed by a flat joined string must still tell
  // ("a", "b:c") apart from ("a:b", "c").
  const registry = new RenameRegistry();
  registry.setCategoryRename('obs', 'a', 'b:c', 'first');
  registry.setCategoryRename('obs', 'a:b', 'c', 'second');

  assert.equal(registry.getDisplayCategory('obs', 'a', 'b:c'), 'first');
  assert.equal(registry.getDisplayCategory('obs', 'a:b', 'c'), 'second');
  assert.equal(registry.getCounts().categories, 2);

  const round = new RenameRegistry();
  round.fromJSON(structuredClone(registry.toJSON()));
  assert.equal(round.getDisplayCategory('obs', 'a', 'b:c'), 'first');
  assert.equal(round.getDisplayCategory('obs', 'a:b', 'c'), 'second');
});

test('a numeric category label and its string spelling are distinct identities', () => {
  const registry = new RenameRegistry();
  registry.setCategoryRename('obs', 'cluster', 1, 'one');
  registry.setCategoryRename('obs', 'cluster', '1', 'the string one');

  assert.equal(registry.getDisplayCategory('obs', 'cluster', 1), 'one');
  assert.equal(
    registry.getDisplayCategory('obs', 'cluster', '1'),
    'the string one'
  );
});

test('reverting a category rename removes only that category entry', () => {
  const state = makeState({
    obsFields: [categoricalField('cell_type', ['B', 'Mono', 'NK'], POINTS)]
  });
  state.renameCategory('obs', 0, 1, 'Monocyte');
  state.renameCategory('obs', 0, 2, 'Natural killer');
  assert.equal(state._renameRegistry.getCounts().categories, 2);

  state.renameCategory('obs', 0, 1, 'Mono');
  assert.equal(state._renameRegistry.getCounts().categories, 1);
  assert.deepEqual(
    state.obsData.fields[0].categories,
    ['B', 'Mono', 'Natural killer']
  );
});

// ---------------------------------------------------------------------------
// 2. The storage contract decides the ceiling, not the user-defined path
// ---------------------------------------------------------------------------

const WIDE = 300; // more than uint8 addresses, far less than uint16 does
const WIDE_POINTS = 600;

function wideState() {
  const categories = Array.from({ length: WIDE }, (_v, i) => `donor_${i}`);
  return makeState({
    pointCount: WIDE_POINTS,
    obsFields: [categoricalField('donor', categories, WIDE_POINTS)]
  });
}

test('a uint16 categorical can be duplicated', async () => {
  const state = wideState();
  assert.equal(state.obsData.fields[0].codes.constructor, Uint16Array);

  const { newFieldIndex } = await state.duplicateField('obs', 0);
  const copy = state.obsData.fields[newFieldIndex];
  assert.equal(copy.categories.length, WIDE);
  assert.equal(copy.codes.constructor, Uint16Array);
  assert.deepEqual(
    Array.from(copy.codes),
    Array.from(state.obsData.fields[0].codes)
  );
});

test('two categories of a uint16 categorical can be merged', () => {
  const state = wideState();
  const result = state.mergeCategoriesToNewField(0, 1, 2, {
    editInPlace: false
  });
  const merged = state.obsData.fields[result.newFieldIndex];
  assert.equal(merged.categories.length, WIDE - 1);
  assert.equal(merged.codes.constructor, Uint16Array);
});

test('a category of a uint16 categorical can be deleted to unassigned', () => {
  const state = wideState();
  const result = state.deleteCategoryToUnassigned(0, 1, {
    editInPlace: false,
    unassignedLabel: 'Unassigned'
  });
  const edited = state.obsData.fields[result.newFieldIndex];
  assert.equal(edited.categories.length, WIDE);
  assert.equal(edited.categories.at(-1), 'Unassigned');
  assert.equal(edited.codes.constructor, Uint16Array);
});

test('a uint16 categorical can be upserted', () => {
  const state = wideState();
  const categories = Array.from({ length: WIDE }, (_v, i) => `consensus_${i}`);
  const result = state.upsertUserDefinedCategoricalField({
    key: 'consensus',
    categories,
    codes: codesFor(WIDE_POINTS, WIDE)
  });
  assert.equal(result.updatedInPlace, false);
  assert.equal(
    state.obsData.fields[result.fieldIndex].categories.length,
    WIDE
  );
});

test('the width of a highlight-page categorical follows its category count', () => {
  for (const [pageCount, expected] of [[8, Uint8Array], [300, Uint16Array]]) {
    const pages = Array.from({ length: pageCount }, (_v, index) => ({
      id: `p${index}`,
      name: `P${index}`,
      highlightedGroups: [{ enabled: true, cellIndices: [index] }]
    }));
    const state = makeState({ pointCount: WIDE_POINTS, obsFields: [] });
    state.highlightPages = pages;
    const result = state.createCategoricalFromPages({
      key: `built_${pageCount}`,
      pages: pages.map(page => ({ pageId: page.id, label: page.name })),
      uncoveredLabel: 'Unassigned',
      overlapStrategy: 'first',
      overlapLabel: 'Overlap',
      intersectionLabels: {}
    });
    assert.equal(result.field.codes.constructor, expected);
    assert.equal(result.field.categories.length, pageCount + 1);
    // Every cell that no page covers carries the last category, not a
    // sentinel, because an uncovered label was supplied.
    const uncoveredIndex = pageCount;
    assert.equal(result.field.codes[WIDE_POINTS - 1], uncoveredIndex);
  }
});

test('an uncovered cell with no label carries the width\'s reserved missing code', () => {
  for (const [pageCount, expectedMissing] of [[2, 255], [300, 65_535]]) {
    const pages = Array.from({ length: pageCount }, (_v, index) => ({
      id: `p${index}`,
      name: `P${index}`,
      highlightedGroups: [{ enabled: true, cellIndices: [index] }]
    }));
    const state = makeState({ pointCount: WIDE_POINTS, obsFields: [] });
    state.highlightPages = pages;
    const result = state.createCategoricalFromPages({
      key: `unlabelled_${pageCount}`,
      pages: pages.map(page => ({ pageId: page.id, label: page.name })),
      uncoveredLabel: '',
      overlapStrategy: 'first',
      overlapLabel: 'Overlap',
      intersectionLabels: {}
    });
    assert.equal(result.field.codes[WIDE_POINTS - 1], expectedMissing);
    assert.equal(result.field.categories.length, pageCount);
  }
});

test('the ceiling a user-defined field refuses is the contract ceiling', () => {
  const registry = new UserDefinedFieldsRegistry();
  const tooMany = MAX_CATEGORICAL_CATEGORIES + 1;
  assert.throws(
    () => registry.createFromCategoricalCodes(
      {
        key: 'k',
        categories: Array.from({ length: tooMany }, (_v, i) => `c${i}`),
        codes: new Uint16Array(2),
        source: 'obs'
      },
      { pointCount: 2 }
    ),
    new RegExp(
      `${MAX_CATEGORICAL_CATEGORIES.toLocaleString('en-US')}`
    )
  );
});

// ---------------------------------------------------------------------------
// 3. A label-sized edit costs label-sized work
// ---------------------------------------------------------------------------

test('renaming a user-defined field or label never walks the cell axis', async () => {
  const state = makeState({
    pointCount: 4096,
    obsFields: [categoricalField('ct', ['a', 'b', 'c', 'd'], 4096)]
  });
  const { newFieldIndex } = await state.duplicateField('obs', 0, {
    newKey: 'Mine'
  });
  const field = state.obsData.fields[newFieldIndex];
  const template = state._userDefinedFields.getField(field._userDefinedId);
  const realCodes = template.codes;

  let elementReads = 0;
  const watched = new Proxy(realCodes, {
    get(target, property) {
      if (typeof property === 'string' && /^[0-9]+$/.test(property)) {
        elementReads += 1;
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  template.codes = watched;
  field.codes = watched;
  try {
    state.renameField('obs', newFieldIndex, 'Mine 2');
    state.renameCategory('obs', newFieldIndex, 1, 'beta');
  } finally {
    template.codes = realCodes;
    field.codes = realCodes;
  }

  assert.equal(
    elementReads,
    0,
    'a rename changes labels only; re-reading every code cannot change its verdict'
  );
  assert.equal(
    field.codes,
    realCodes,
    'a rename must not rebuild the codes array'
  );
});

test('a restored field can be renamed while its codes chunk is still in flight', () => {
  // A session restores field definitions eagerly and the codes arrays lazily,
  // so a user-defined column appears in the field list with `codes === null`
  // for as long as its chunk takes to arrive. Renaming it in that window is an
  // ordinary thing to do and used to throw.
  const registry = new UserDefinedFieldsRegistry();
  registry.fromSessionMeta([{
    id: 'user_cat_1',
    source: 'obs',
    kind: 'category',
    key: 'My cats',
    categories: ['a', 'b', 'c'],
    isDeleted: false,
    isPurged: false,
    codesLength: 500_000,
    codesType: 'Uint8Array',
    centroidsByDim: {},
    normalizedDims: [],
    sourceField: null,
    operation: null,
    sourcePages: [],
    overlapStrategy: 'first',
    overlapLabel: null,
    intersectionLabels: null,
    uncoveredLabel: null,
    createdAt: 1
  }]);
  const field = registry.getField('user_cat_1');
  assert.equal(field.codes, null);
  assert.equal(field.loaded, false);

  assert.equal(registry.updateField('user_cat_1', { key: 'Renamed' }), true);
  assert.equal(field.key, 'Renamed');
  assert.equal(
    registry.updateField('user_cat_1', { categories: ['a', 'B', 'c'] }),
    true
  );
  assert.deepEqual(field.categories, ['a', 'B', 'c']);
  assert.equal(
    field.codes,
    null,
    'the rename must not invent a codes array the chunk has yet to deliver'
  );
});

test('a categorical update that changes the inventory still validates every code', () => {
  const registry = new UserDefinedFieldsRegistry();
  const { id } = registry.createFromCategoricalCodes(
    {
      key: 'k',
      categories: ['a', 'b', 'c'],
      codes: Uint8Array.from([0, 1, 2, 0]),
      source: 'obs'
    },
    {
      pointCount: 4,
      dimensionManager: {
        positionCache: new Map(),
        getAvailableDimensions: () => [2]
      }
    }
  );
  assert.throws(
    () => registry.updateField(id, { categories: ['a', 'b'] }),
    /outside the category inventory/
  );
});
