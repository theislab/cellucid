/**
 * Field-owned highlight groups name a field and a category, and they also carry
 * the position of each. Positions move whenever a dataset is exported again
 * with one more obs column or one more category, and nothing in the dataset
 * fingerprint pins them: it covers the cells, not the obs schema. These tests
 * hold restore to the names, and hold the refusals to naming what is missing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getNotificationCenter,
} from '../assets/js/app/notification-center.js';
import * as highlightsCellsContributor from
  '../assets/js/app/session/contributors/highlights-cells.js';
import * as highlightsMetaContributor from
  '../assets/js/app/session/contributors/highlights-meta.js';
import {
  highlightStateMethods,
} from '../assets/js/app/state/managers/highlight-manager.js';
import {
  FieldOverlayInternalMethods,
} from '../assets/js/app/state/managers/field/overlay-internals.js';
import {
  getDatasetFingerprint,
} from '../assets/js/app/session/session-context.js';
import {
  SessionSerializer,
} from '../assets/js/app/session/session-serializer.js';

const CELL_COUNT = 6;
const VAR_COUNT = 4;
const SELECTED_ROWS = [0, 2];
const CATEGORIES = ['alpha', 'beta', 'gamma'];

/** The obs schema the session is saved against. */
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

function makeDatasetState({ obs = SAVED_OBS, pages, dimension = 3 }) {
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
  state.positionsArray = positions();
  state.getViewDimensionLevel = () => dimension;
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
    getCurrentSourceType: () => 'local-demo',
    getCurrentDatasetId: () => 'pancreas',
  };
}

function makeSerializer(state) {
  return new SessionSerializer({
    state,
    viewer: {},
    sidebar: {},
    dataSourceManager: dataSourceManager(),
    comparisonModule: null,
    analysisWindowManager: null,
    cinematicCamera: null,
    contributors: [
      highlightsMetaContributor,
      highlightsCellsContributor,
    ],
  });
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
      cellIndices: [...SELECTED_ROWS],
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

async function withNotificationHarness(run) {
  const notifications = getNotificationCenter();
  const names = [
    'completeDownload',
    'dismissDownload',
    'error',
    'failDownload',
    'info',
    'startDownload',
    'success',
    'updateDownload',
    'warning',
  ];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  for (const name of names) notifications[name] = () => {};
  notifications.startDownload = () => 'session-highlight-field-identity-test';
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => {
    queueMicrotask(() => callback(0));
    return 1;
  };
  try {
    return await run();
  } finally {
    for (const [name, original] of originals) notifications[name] = original;
    if (previousAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      globalThis.requestAnimationFrame = previousAnimationFrame;
    }
  }
}

async function captureCategoryBundle(options) {
  const source = makeDatasetState({ pages: categoryPages(options) });
  return makeSerializer(source).createSessionBundle();
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

test('an unchanged dataset restores the exact saved binding', async () => {
  const bundle = await captureCategoryBundle();
  const destination = makeDatasetState({ pages: emptyPages() });

  await withNotificationHarness(async () => {
    await makeSerializer(destination).restoreFromBlob(bundle);
  });

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
    const bundle = await captureCategoryBundle();
    const destination = makeDatasetState({
      obs: ['donor', 'batch', 'phase', 'doublet_score', 'cell_type'],
      pages: emptyPages(),
    });
    // The fingerprint cannot see an obs schema change, so the session is
    // accepted and the binding is what has to be right.
    assert.deepEqual(
      getDatasetFingerprint({
        state: destination,
        dataSourceManager: dataSourceManager(),
      }),
      getDatasetFingerprint({
        state: makeDatasetState({ pages: emptyPages() }),
        dataSourceManager: dataSourceManager(),
      }),
    );

    await withNotificationHarness(async () => {
      await makeSerializer(destination).restoreFromBlob(bundle);
    });

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
    const bundle = await captureCategoryBundle();
    const destination = makeDatasetState({
      obs: ['donor', 'phase', 'cell_type'],
      pages: emptyPages(),
    });

    await withNotificationHarness(async () => {
      await makeSerializer(destination).restoreFromBlob(bundle);
    });

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
  const bundle = await captureCategoryBundle();
  const destination = makeDatasetState({
    obs: ['donor', 'batch', 'phase', 'cell_type_v2'],
    pages: emptyPages(),
  });
  const untouched = destination.highlightPages;

  await withNotificationHarness(async () => {
    await assert.rejects(
      makeSerializer(destination).restoreFromBlob(bundle),
      error => {
        assert.match(error.message, /"cell_type"/);
        assert.match(error.message, /does not have/);
        return true;
      },
    );
  });
  assert.strictEqual(destination.highlightPages, untouched);
  assert.deepEqual(untouched[0].highlightedGroups, []);
});

test('a highlighted field that is gone entirely is refused by name', async () => {
  const bundle = await captureCategoryBundle();
  const destination = makeDatasetState({
    obs: ['donor', 'batch', 'phase'],
    pages: emptyPages(),
  });
  const untouched = destination.highlightPages;

  await withNotificationHarness(async () => {
    await assert.rejects(
      makeSerializer(destination).restoreFromBlob(bundle),
      error => {
        assert.ok(error instanceof RangeError);
        assert.match(error.message, /obs field "cell_type"/);
        return true;
      },
    );
  });
  assert.strictEqual(destination.highlightPages, untouched);
});

test('a highlighted field that changed kind is refused by name', async () => {
  const bundle = await captureCategoryBundle();
  const destination = makeDatasetState({
    obs: [
      'donor',
      'batch',
      'phase',
      { key: 'cell_type', kind: 'continuous' },
    ],
    pages: emptyPages(),
  });

  await withNotificationHarness(async () => {
    await assert.rejects(
      makeSerializer(destination).restoreFromBlob(bundle),
      error => {
        assert.match(error.message, /obs field "cell_type"/);
        assert.match(error.message, /continuous/);
        return true;
      },
    );
  });
});

test(
  'a category added before the highlighted category does not move the binding',
  async () => {
    const bundle = await captureCategoryBundle();
    const destination = makeDatasetState({
      obs: [
        'donor',
        'batch',
        'phase',
        { key: 'cell_type', categories: ['alpha', 'alpha_prime', 'beta', 'gamma'] },
      ],
      pages: emptyPages(),
    });

    await withNotificationHarness(async () => {
      await makeSerializer(destination).restoreFromBlob(bundle);
    });

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
  const bundle = await captureCategoryBundle();
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

  await withNotificationHarness(async () => {
    await assert.rejects(
      makeSerializer(destination).restoreFromBlob(bundle),
      error => {
        assert.ok(error instanceof RangeError);
        assert.match(error.message, /category "beta"/);
        assert.match(error.message, /"cell_type"/);
        return true;
      },
    );
  });
  assert.strictEqual(destination.highlightPages, untouched);
});

test('capture refuses to write a group whose name and position disagree', () => {
  const source = makeDatasetState({
    pages: categoryPages({ fieldIndex: 1 }),
  });
  assert.throws(
    () => highlightsMetaContributor.capture({ state: source }),
    error => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /"cell_type"/);
      assert.match(error.message, /different field/);
      return true;
    },
  );

  const wrongCategory = makeDatasetState({
    pages: categoryPages({ categoryIndex: 2 }),
  });
  assert.throws(
    () => highlightsMetaContributor.capture({ state: wrongCategory }),
    /different category/,
  );
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
        cellIndices: [...SELECTED_ROWS],
        cellCount: SELECTED_ROWS.length,
      }],
    }];
    const bundle = await makeSerializer(makeDatasetState({
      obs: ['donor', { key: 'score', kind: 'continuous' }, 'cell_type'],
      pages: rangePages,
    })).createSessionBundle();

    const destination = makeDatasetState({
      obs: [
        'donor',
        'batch',
        { key: 'score', kind: 'continuous' },
        'cell_type',
      ],
      pages: emptyPages(),
    });
    await withNotificationHarness(async () => {
      await makeSerializer(destination).restoreFromBlob(bundle);
    });
    assert.equal(restoredGroup(destination).fieldIndex, 2);
    assert.equal(
      destination.obsData.fields[restoredGroup(destination).fieldIndex].key,
      'score',
    );

    const gone = makeDatasetState({
      obs: ['donor', 'batch', 'cell_type'],
      pages: emptyPages(),
    });
    await withNotificationHarness(async () => {
      await assert.rejects(
        makeSerializer(gone).restoreFromBlob(bundle),
        /obs field "score"/,
      );
    });
  },
);
