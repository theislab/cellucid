/**
 * Session filter restore must reproduce the exact saved state.
 *
 * A session bundle is the complete field-filter state, not a patch. Restoring
 * bundle A into a tab that has drifted past A must land on A exactly: any field
 * property left over from the drift is a leak, and the figure the user exports
 * afterwards is not the figure they saved.
 *
 * The effective state is read back through the real lazy default initializers
 * in `state/managers/color-manager.js`, which are the single owner of what each
 * load-time default is. Comparing materialized state (rather than raw property
 * shapes) is what makes "absent" and "explicitly at its default" equivalent,
 * which is exactly the equivalence the modified-only encoding relies on.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFilterSerializer,
} from '../assets/js/app/state-serializer/filters.js';
import {
  DataStateColorMethods,
} from '../assets/js/app/state/managers/color-manager.js';
import {
  getCategoryColor,
} from '../assets/js/data/palettes.js';

const POINT_COUNT = 8;
const CELL_TYPES = ['B cell', 'T cell', 'Monocyte'];
const SCORE_VALUES = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
const GENE_VALUES = Float32Array.from([2, 4, 6, 8, 10, 12, 14, 16]);

function createHarness() {
  const cellType = {
    key: 'cell_type',
    kind: 'category',
    categories: [...CELL_TYPES],
    codes: Uint8Array.from([0, 1, 2, 0, 1, 2, 0, 1]),
    _isDeleted: false,
  };
  const score = {
    key: 'score',
    kind: 'continuous',
    values: SCORE_VALUES,
    _isDeleted: false,
  };
  const gene = {
    key: 'GAPDH',
    kind: 'continuous',
    values: GENE_VALUES,
    _isDeleted: false,
  };

  // Mirrors the parts of DataState that restoreFilters() actually drives. The
  // metadata initializers are the production ones, so the defaults this test
  // compares against cannot drift away from the application's.
  const state = {
    pointCount: POINT_COUNT,
    getFields: () => [cellType, score],
    getVarFields: () => [gene],
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

  return { state, cellType, score, gene };
}

function snapshotEffectiveState(state) {
  const snapshot = {};
  for (const [source, fields] of [
    ['obs', state.getFields()],
    ['var', state.getVarFields()],
  ]) {
    for (const field of fields) {
      if (field.kind === 'category') {
        state.ensureCategoryMetadata(field);
      } else {
        state.ensureContinuousMetadata(field);
      }
      snapshot[`${source}:${field.key}`] = {
        categoryColors: field._categoryColors === undefined
          ? null
          : field._categoryColors.map(color => [...color]),
        categoryVisible: field._categoryVisible === undefined
          ? null
          : { ...field._categoryVisible },
        categoryFilterEnabled: field._categoryFilterEnabled ?? null,
        colormapId: field._colormapId ?? null,
        continuousFilter: field._continuousFilter === undefined
          ? null
          : { ...field._continuousFilter },
        continuousColorRange: field._continuousColorRange === undefined
          ? null
          : { ...field._continuousColorRange },
        filterEnabled: field._filterEnabled ?? null,
        useFilterColorRange: field._useFilterColorRange ?? null,
        useLogScale: field._useLogScale ?? null,
        outlierFilterEnabled: field._outlierFilterEnabled ?? null,
        outlierThreshold: field._outlierThreshold ?? null,
      };
    }
  }
  return snapshot;
}

test('restoring a session reproduces its exact state instead of merging onto the current one', async () => {
  const { state, cellType, score } = createHarness();
  const serializer = createFilterSerializer({ state });

  // --- Session A: one hidden category, one recoloured category, linear scale.
  state.setVisibilityForCategory(cellType, 0, false);
  state.setColorForCategory(cellType, 2, [0.1, 0.2, 0.3]);
  const sessionA = serializer.serializeFilters();
  const expectedState = snapshotEffectiveState(state);

  assert.deepEqual(
    sessionA['obs:cell_type'].visibility,
    [{ categoryName: 'B cell', visible: false }],
    'Session A must record exactly the one hidden category, by name.',
  );

  // --- Same tab, keeps drifting past A.
  state.setVisibilityForCategory(cellType, 1, false);
  state.ensureContinuousMetadata(score);
  score._useLogScale = true;
  score._colormapId = 'magma';
  score._continuousFilter = { min: 3, max: 6 };
  cellType._categoryFilterEnabled = false;

  const driftedState = snapshotEffectiveState(state);
  assert.notDeepEqual(
    driftedState,
    expectedState,
    'The drift must actually leave the saved state.',
  );

  // --- Load session A back into that same tab.
  const outcome = await serializer.restoreFilters(sessionA, { signal: null });
  assert.deepEqual(outcome, { restored: 1 });

  assert.deepEqual(
    snapshotEffectiveState(state),
    expectedState,
    'Restoring session A must reproduce session A exactly.',
  );
  assert.deepEqual(
    serializer.serializeFilters(),
    sessionA,
    'Re-serializing the restored state must reproduce the saved bundle.',
  );

  // The individual leaks the merge used to carry across, spelled out.
  assert.equal(
    cellType._categoryVisible[1],
    true,
    'A category hidden after the save must be shown again by the restore.',
  );
  assert.equal(cellType._categoryFilterEnabled, true);
  assert.equal(score._useLogScale, false, 'A log scale set after the save must not survive the restore.');
  assert.equal(score._colormapId, 'viridis');
  assert.deepEqual(score._continuousFilter, { min: 1, max: 8 });
  assert.deepEqual(
    cellType._categoryColors[2],
    [0.1, 0.2, 0.3],
    'The recolour that session A did record must still be applied.',
  );
  assert.deepEqual(cellType._categoryColors[1], getCategoryColor(1));
});

test('restoring a session clears fields the bundle never mentions', async () => {
  const { state, cellType, score, gene } = createHarness();
  const serializer = createFilterSerializer({ state });

  const pristineState = snapshotEffectiveState(state);
  const emptySession = serializer.serializeFilters();
  assert.deepEqual(emptySession, {}, 'An untouched dataset records no filters.');

  state.setVisibilityForCategory(cellType, 0, false);
  state.ensureContinuousMetadata(score);
  score._continuousFilter = { min: 2, max: 5 };
  score._filterEnabled = false;
  state.ensureContinuousMetadata(gene);
  gene._useFilterColorRange = false;
  gene._outlierThreshold = 0.5;
  gene._outlierFilterEnabled = false;

  await serializer.restoreFilters(emptySession, { signal: null });

  assert.deepEqual(
    snapshotEffectiveState(state),
    pristineState,
    'A bundle with no filter entries must return every field to its load-time defaults.',
  );
});

test('a narrowed filter does not drag the restored color range with it', async () => {
  const saving = createHarness();
  const savingSerializer = createFilterSerializer({ state: saving.state });

  // Stats are {1, 8}. Narrow only the filter; the color range stays at the
  // full data range, and the colour domain follows the color range because
  // `_useFilterColorRange` defaults to true.
  saving.state.ensureContinuousMetadata(saving.score);
  saving.score._continuousFilter = { min: 3, max: 6 };
  assert.deepEqual(saving.score._continuousColorRange, { min: 1, max: 8 });

  const sessionB = savingSerializer.serializeFilters();
  const expectedState = snapshotEffectiveState(saving.state);

  // Load it in a freshly opened tab, where nothing has been materialized yet.
  const loading = createHarness();
  const loadingSerializer = createFilterSerializer({ state: loading.state });
  await loadingSerializer.restoreFilters(sessionB, { signal: null });

  assert.deepEqual(
    loading.score._continuousColorRange,
    { min: 1, max: 8 },
    'The restored color range must be the saved full data range, not the narrowed filter.',
  );
  assert.deepEqual(
    snapshotEffectiveState(loading.state),
    expectedState,
    'A fresh restore must reproduce the saved state exactly.',
  );
  assert.deepEqual(loadingSerializer.serializeFilters(), sessionB);
});
