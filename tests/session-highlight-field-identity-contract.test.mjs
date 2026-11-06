/**
 * Field-owned highlight groups name a field and a category, and only the
 * names are kept. Positions move whenever a dataset is exported again with
 * one more obs column or one more category, and nothing in the dataset
 * fingerprint pins them: it covers the cells, not the obs schema. These tests
 * hold restore to the names, and hold the refusals to naming what is missing,
 * through the `highlights` state domain's own capture and restore
 * (`app/state/domains/highlights.js`), which a session file and the history
 * both use.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHighlightsDomain } from '../assets/js/app/state/domains/highlights.js';
import {
  highlightStateMethods,
} from '../assets/js/app/state/managers/highlight-manager.js';
import {
  FieldOverlayInternalMethods,
} from '../assets/js/app/state/managers/field/overlay-internals.js';
import {
  getDatasetFingerprint,
} from '../assets/js/app/session/session-context.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import {
  createInMemoryAnnDataDimensionManager,
  describeOwnVarCount,
  inMemoryAnnDataMapping,
} from './helpers/in-memory-anndata.mjs';

const CELL_COUNT = 6;
const VAR_COUNT = 4;
const SELECTED_ROWS = [0, 2];
const CATEGORIES = ['alpha', 'beta', 'gamma'];

/** The obs schema the highlights are kept on. */
const SAVED_OBS = ['donor', 'batch', 'phase', 'cell_type'];

const STATE_PROTOTYPE = (() => {
  const proto = Object.create(highlightStateMethods);
  for (const name of Object.getOwnPropertyNames(
    FieldOverlayInternalMethods.prototype,
  )) {
    if (name === 'constructor') continue;
    proto[name] = FieldOverlayInternalMethods.prototype[name];
  }
  return proto;
})();

function positions() {
  const out = new Float32Array(CELL_COUNT * 3);
  for (let row = 0; row < CELL_COUNT; row++) {
    out[row * 3] = (row + 1) * 0.125;
    out[row * 3 + 1] = (row + 1) * 0.25;
    out[row * 3 + 2] = (row + 1) * 0.5;
  }
  return out;
}

function obsField(descriptor) {
  if (typeof descriptor === 'string') {
    return {
      key: descriptor,
      kind: 'category',
      categories: [...CATEGORIES],
      loaded: true,
    };
  }
  return {
    key: descriptor.key,
    kind: descriptor.kind ?? 'category',
    categories: descriptor.kind === 'continuous'
      ? undefined
      : [...(descriptor.categories ?? CATEGORIES)],
    loaded: true,
  };
}

/**
 * The data mapping of a dataset whose one embedding is the in-memory 3D
 * layout (keyed "3d"): highlight identity is checked against obs and var
 * schemas, never against this mapping, which is the same on both sides.
 */
const DATA_MAPPING = Object.freeze(inMemoryAnnDataMapping());

function makeDatasetState({ obs = SAVED_OBS, pages }) {
  const state = Object.create(STATE_PROTOTYPE);
  state.getDatasetGeneration = () => 0;
  state.obsData = { fields: obs.map(obsField) };
  state.varData = {
    fields: Array.from({ length: VAR_COUNT }, (_value, index) => ({
      key: `gene_${index}`,
      kind: 'continuous',
    })),
  };
  state.pointCount = CELL_COUNT;
  state.cellIdentity = createCellIdentity({ nObs: CELL_COUNT });
  state.positionsArray = positions();
  state.dimensionManager = createInMemoryAnnDataDimensionManager({
    positions: state.positionsArray,
    dimension: 3,
  });
  state.getDataMapping = () => DATA_MAPPING;
  state.describeMappingVarCount = describeOwnVarCount;
  state.getViewDimensionLevel = () => 3;
  state.getViewLayoutKey = () => state.dimensionManager.getViewLayout('live');
  state.getActiveViewId = () => 'live';
  state.highlightPages = pages;
  state.activePageId = 'page_1';
  state._highlightPageIdCounter = 1;
  state._highlightIdCounter = pages.flatMap(
    page => page.highlightedGroups,
  ).length;
  state._recomputeHighlightArray = () => {};
  state._notifyHighlightPageChange = () => {};
  state._notifyHighlightChange = () => {};
  return state;
}

function dataSourceManager() {
  return {
    getCurrentIdentityId: () => 'pancreas',
    getCurrentSourceType: () => 'local-demo',
    getCurrentDatasetId: () => 'pancreas',
  };
}

/** The highlights value of `state`, as a saved state holds it (a copy). */
function capture(state) {
  return structuredClone(createHighlightsDomain({ state, refreshUi: () => {} }).capture());
}

/** Put a captured highlights value back on `state`. */
function restore(state, value) {
  return createHighlightsDomain({ state, refreshUi: () => {} }).restore(value);
}

/**
 * One category highlight on `cell_type`, plus one range highlight on `score`
 * when the schema carries it.
 */
function categoryPages({
  fieldKey = 'cell_type',
  fieldIndex = SAVED_OBS.indexOf('cell_type'),
  categoryIndex = 1,
  categoryName = CATEGORIES[1],
} = {}) {
  return [{
    id: 'page_1',
    name: 'Work',
    color: '#112233',
    highlightedGroups: [{
      id: 'highlight_1',
      type: 'category',
      label: `${fieldKey}: ${categoryName}`,
      enabled: true,
      fieldKey,
      fieldIndex,
      fieldSource: 'obs',
      categoryIndex,
      categoryName,
      cellIndices: Uint32Array.from(SELECTED_ROWS),
      cellCount: SELECTED_ROWS.length,
    }],
  }];
}

function emptyPages() {
  return [{
    id: 'page_1',
    name: 'Untouched',
    color: '#445566',
    highlightedGroups: [],
  }];
}

function captureCategoryValue(options) {
  const source = makeDatasetState({ pages: categoryPages(options) });
  return capture(source);
}

function restoredGroup(state) {
  const groups = state.highlightPages.flatMap(page => page.highlightedGroups);
  assert.equal(groups.length, 1);
  return groups[0];
}

/**
 * The binding a restored group actually resolves to, read back through the
 * dataset rather than from the group's own copy of it.
 */
function boundNames(state) {
  const group = restoredGroup(state);
  const field = state.obsData.fields[group.fieldIndex];
  return {
    fieldKey: field.key,
    categoryName: field.categories[group.categoryIndex],
    savedFieldKey: group.fieldKey,
    savedCategoryName: group.categoryName,
    label: group.label,
    cellIndices: [...group.cellIndices],
  };
}

test('a kept group records names, never positions', () => {
  const source = makeDatasetState({ pages: categoryPages() });
  const [group] = capture(source).pages[0].groups;
  assert.deepEqual(Object.keys(group).sort(), [
    'category', 'cells', 'enabled', 'field', 'id', 'label', 'type',
  ]);
  assert.deepEqual(group.field, { source: 'obs', key: 'cell_type' });
  assert.equal(group.category, 'beta');
  assert.deepEqual([...group.cells], SELECTED_ROWS);
});

test('an unchanged dataset restores the exact saved binding', async () => {
  const saved = captureCategoryValue();
  const destination = makeDatasetState({ pages: emptyPages() });

  await restore(destination, saved);

  assert.deepEqual(boundNames(destination), {
    fieldKey: 'cell_type',
    categoryName: 'beta',
    savedFieldKey: 'cell_type',
    savedCategoryName: 'beta',
    label: 'cell_type: beta',
    cellIndices: SELECTED_ROWS,
  });
  assert.equal(
    restoredGroup(destination).fieldIndex,
    SAVED_OBS.indexOf('cell_type'),
  );
  assert.equal(restoredGroup(destination).categoryIndex, 1);
});

test(
  'an obs column added before the highlighted field does not move the binding',
  async () => {
    const saved = captureCategoryValue();
    const destination = makeDatasetState({
      obs: ['donor', 'batch', 'phase', 'doublet_score', 'cell_type'],
      pages: emptyPages(),
    });
    // The fingerprint cannot see an obs schema change, so the session is
    // accepted and the binding is what has to be right.
    assert.deepEqual(
      await getDatasetFingerprint({
        state: destination,
        dataSourceManager: dataSourceManager(),
      }),
      await getDatasetFingerprint({
        state: makeDatasetState({ pages: emptyPages() }),
        dataSourceManager: dataSourceManager(),
      }),
    );

    await restore(destination, saved);

    assert.equal(restoredGroup(destination).fieldIndex, 4);
    assert.deepEqual(boundNames(destination), {
      fieldKey: 'cell_type',
      categoryName: 'beta',
      savedFieldKey: 'cell_type',
      savedCategoryName: 'beta',
      label: 'cell_type: beta',
      cellIndices: SELECTED_ROWS,
    });

    // The next edit of that field re-derives the group's own name from the
    // binding, so a wrong binding would rewrite the group here.
    destination._refreshHighlightGroupsForField('obs', 4);
    assert.equal(restoredGroup(destination).fieldKey, 'cell_type');
    assert.equal(restoredGroup(destination).label, 'cell_type: beta');
  },
);

test(
  'an obs column removed before the highlighted field does not move the binding',
  async () => {
    const saved = captureCategoryValue();
    const destination = makeDatasetState({
      obs: ['donor', 'phase', 'cell_type'],
      pages: emptyPages(),
    });

    await restore(destination, saved);

    assert.equal(restoredGroup(destination).fieldIndex, 2);
    assert.deepEqual(boundNames(destination), {
      fieldKey: 'cell_type',
      categoryName: 'beta',
      savedFieldKey: 'cell_type',
      savedCategoryName: 'beta',
      label: 'cell_type: beta',
      cellIndices: SELECTED_ROWS,
    });
  },
);

test('a renamed highlighted field is refused by name', async () => {
  const saved = captureCategoryValue();
  const destination = makeDatasetState({
    obs: ['donor', 'batch', 'phase', 'cell_type_v2'],
    pages: emptyPages(),
  });
  const untouched = destination.highlightPages;

  await assert.rejects(
    restore(destination, saved),
    error => {
      assert.match(error.message, /"cell_type"/);
      assert.match(error.message, /does not have/);
      return true;
    },
  );
  assert.strictEqual(destination.highlightPages, untouched);
  assert.deepEqual(untouched[0].highlightedGroups, []);
});

test('a highlighted field that is gone entirely is refused by name', async () => {
  const saved = captureCategoryValue();
  const destination = makeDatasetState({
    obs: ['donor', 'batch', 'phase'],
    pages: emptyPages(),
  });
  const untouched = destination.highlightPages;

  await assert.rejects(
    restore(destination, saved),
    error => {
      // The group names its field, so a field that is gone is refused by
      // that name before anything is replaced (a session file's `requires`
      // names it before anything is read: `session-cell-order-identity`).
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /saved on the obs field "cell_type", which the dataset that is open now does not have/);
      return true;
    },
  );
  assert.strictEqual(destination.highlightPages, untouched);
});

test('a highlighted field that changed kind is refused by name', async () => {
  const saved = captureCategoryValue();
  const destination = makeDatasetState({
    obs: [
      'donor',
      'batch',
      'phase',
      { key: 'cell_type', kind: 'continuous' },
    ],
    pages: emptyPages(),
  });

  await assert.rejects(
    restore(destination, saved),
    error => {
      assert.match(error.message, /obs field "cell_type"/);
      assert.match(error.message, /continuous/);
      return true;
    },
  );
});

test(
  'a category added before the highlighted category does not move the binding',
  async () => {
    const saved = captureCategoryValue();
    const destination = makeDatasetState({
      obs: [
        'donor',
        'batch',
        'phase',
        { key: 'cell_type', categories: ['alpha', 'alpha_prime', 'beta', 'gamma'] },
      ],
      pages: emptyPages(),
    });

    await restore(destination, saved);

    assert.equal(restoredGroup(destination).categoryIndex, 2);
    assert.deepEqual(boundNames(destination), {
      fieldKey: 'cell_type',
      categoryName: 'beta',
      savedFieldKey: 'cell_type',
      savedCategoryName: 'beta',
      label: 'cell_type: beta',
      cellIndices: SELECTED_ROWS,
    });

    destination._refreshHighlightGroupsForField('obs', 3);
    assert.equal(restoredGroup(destination).categoryName, 'beta');
    assert.equal(restoredGroup(destination).label, 'cell_type: beta');
  },
);

test('a highlighted category that is gone is refused by name', async () => {
  const saved = captureCategoryValue();
  const destination = makeDatasetState({
    obs: [
      'donor',
      'batch',
      'phase',
      { key: 'cell_type', categories: ['alpha', 'gamma'] },
    ],
    pages: emptyPages(),
  });
  const untouched = destination.highlightPages;

  await assert.rejects(
    restore(destination, saved),
    error => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /category "beta"/);
      assert.match(error.message, /"cell_type"/);
      return true;
    },
  );
  assert.strictEqual(destination.highlightPages, untouched);
});

test(
  'a range highlight resolves its continuous field by name too',
  async () => {
    const rangePages = [{
      id: 'page_1',
      name: 'Work',
      color: '#112233',
      highlightedGroups: [{
        id: 'highlight_1',
        type: 'range',
        label: 'score: 0.25 – 0.75',
        enabled: true,
        fieldKey: 'score',
        fieldIndex: 1,
        fieldSource: 'obs',
        rangeMin: 0.25,
        rangeMax: 0.75,
        cellIndices: Uint32Array.from(SELECTED_ROWS),
        cellCount: SELECTED_ROWS.length,
      }],
    }];
    const saved = capture(makeDatasetState({
      obs: ['donor', { key: 'score', kind: 'continuous' }, 'cell_type'],
      pages: rangePages,
    }));

    const destination = makeDatasetState({
      obs: [
        'donor',
        'batch',
        { key: 'score', kind: 'continuous' },
        'cell_type',
      ],
      pages: emptyPages(),
    });
    await restore(destination, saved);
    assert.equal(restoredGroup(destination).fieldIndex, 2);
    assert.equal(
      destination.obsData.fields[restoredGroup(destination).fieldIndex].key,
      'score',
    );

    const gone = makeDatasetState({
      obs: ['donor', 'batch', 'cell_type'],
      pages: emptyPages(),
    });
    await assert.rejects(
      restore(gone, saved),
      /saved on the obs field "score", which the dataset that is open now does not have/,
    );
  },
);

test('restoring many category highlights reads each inventory once', async () => {
  const count = 1_500;
  const names = Array.from({ length: count }, (_, index) => `cluster_${index}`);
  const groups = names.map((categoryName, categoryIndex) => ({
    id: `highlight_${categoryIndex + 1}`,
    type: 'category',
    label: `cell_type: ${categoryName}`,
    enabled: true,
    fieldKey: 'cell_type',
    fieldIndex: SAVED_OBS.indexOf('cell_type'),
    fieldSource: 'obs',
    categoryIndex,
    categoryName,
    cellIndices: Uint32Array.from(SELECTED_ROWS),
    cellCount: SELECTED_ROWS.length,
  }));
  const pages = [{
    id: 'page_1',
    name: 'Work',
    color: '#112233',
    highlightedGroups: groups,
  }];
  const source = makeDatasetState({
    obs: SAVED_OBS.map(key => (
      key === 'cell_type' ? { key, categories: names } : key
    )),
    pages,
  });
  const saved = capture(source);

  const destination = makeDatasetState({
    obs: SAVED_OBS.map(key => (
      key === 'cell_type' ? { key, categories: names } : key
    )),
    pages: emptyPages(),
  });
  const field = destination.obsData.fields[SAVED_OBS.indexOf('cell_type')];
  let reads = 0;
  field.categories = new Proxy([...names], {
    get(target, property, receiver) {
      if (property === 'length' || /^\d+$/.test(String(property))) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  await restore(destination, saved);
  const restored = destination.highlightPages.flatMap(page => page.highlightedGroups);
  assert.equal(restored.length, count);
  assert.equal(restored.at(-1).categoryIndex, count - 1);
  assert.ok(
    reads <= 20 * count,
    `restore read the ${count}-category inventory ${reads} times`,
  );
});
