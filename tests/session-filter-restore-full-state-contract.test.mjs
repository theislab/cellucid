/**
 * Restoring filters and colours reproduces the exact saved state.
 *
 * A `filters` or `colors` state domain value (`app/state/domains/filters.js`,
 * `colors.js`) is the complete state of every field, not a patch: restoring
 * value A into a tab that has drifted past A must land on A exactly. Any field
 * property left over from the drift is a leak, and the figure the person
 * exports afterwards is not the figure they saved.
 *
 * The effective state is read back through the real lazy default
 * initializers of a real DataState (`state/managers/color-manager.js`), the
 * single owner of each load-time default. Comparing materialized state
 * (rather than raw property shapes) is what makes "absent" and "explicitly at
 * its default" equivalent, which is exactly the equivalence the
 * modified-only values rely on.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFiltersDomain } from '../assets/js/app/state/domains/filters.js';
import { createColorsDomain } from '../assets/js/app/state/domains/colors.js';
import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { getCategoryColor } from '../assets/js/data/palettes.js';
import { drawn, rgbAt } from './helpers/category-state.mjs';

const POINT_COUNT = 8;
const CELL_TYPES = ['B cell', 'T cell', 'Monocyte'];
const SCORE_VALUES = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
const GENE_VALUES = Float32Array.from([2, 4, 6, 8, 10, 12, 14, 16]);

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

/** A DataState of eight cells: a category and a continuous obs field, and a gene. */
function createHarness() {
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
    categories: [...CELL_TYPES],
    codes: Uint8Array.from([0, 1, 2, 0, 1, 2, 0, 1]),
    loaded: true,
    centroidsByLayout: new Map(),
  };
  const score = { key: 'score', kind: 'continuous', values: SCORE_VALUES, loaded: true };
  const gene = { key: 'GAPDH', kind: 'continuous', values: GENE_VALUES, loaded: true };
  state.obsData = { fields: [cellType, score] };
  state.varData = { fields: [gene] };
  state._resetViewContexts();
  state.ensureHighlightPage();
  const refreshUi = () => {};
  return {
    state,
    cellType,
    score,
    gene,
    filters: createFiltersDomain({ state, viewer, refreshUi }),
    colors: createColorsDomain({ state, viewer, refreshUi }),
  };
}

/** Both values, as a saved state holds them (a copy). */
function captureBoth(harness) {
  return structuredClone({ filters: harness.filters.capture(), colors: harness.colors.capture() });
}

async function restoreBoth(harness, saved) {
  await harness.filters.restore(saved.filters);
  await harness.colors.restore(saved.colors);
}

function snapshotEffectiveState(state) {
  const snapshot = {};
  for (const [source, fields] of [
    ['obs', state.obsData.fields],
    ['var', state.varData.fields],
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
          : Array.from(field._categoryColors),
        categoryVisible: field._categoryVisible === undefined
          ? null
          : Array.from(field._categoryVisible),
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

test('restoring a state reproduces it exactly instead of merging onto the current one', async () => {
  const harness = createHarness();
  const { state, cellType, score } = harness;

  // --- State A: one hidden category, one recoloured category, linear scale.
  state.setVisibilityForCategory(cellType, 0, false);
  state.setColorForCategory(cellType, 2, [0.1, 0.2, 0.3]);
  const stateA = captureBoth(harness);
  const expectedState = snapshotEffectiveState(state);

  assert.deepEqual(
    stateA.filters.views[0],
    [{ field: { source: 'obs', key: 'cell_type' }, hidden: ['B cell'] }],
    'State A must record exactly the one hidden category, by label.',
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

  // --- Put state A back into that same tab.
  await restoreBoth(harness, stateA);

  assert.deepEqual(
    snapshotEffectiveState(state),
    expectedState,
    'Restoring state A must reproduce state A exactly.',
  );
  assert.deepEqual(
    captureBoth(harness),
    stateA,
    'Capturing the restored state must give the saved values again.',
  );

  // The individual leaks a merge would carry across, spelled out.
  assert.equal(
    cellType._categoryVisible[1],
    1,
    'A category hidden after the save must be shown again by the restore.',
  );
  assert.equal(cellType._categoryFilterEnabled, true);
  assert.equal(score._useLogScale, false, 'A log scale set after the save must not survive the restore.');
  assert.equal(score._colormapId, 'viridis');
  assert.deepEqual(score._continuousFilter, { min: 1, max: 8 });
  assert.deepEqual(
    rgbAt(cellType, 2),
    drawn([0.1, 0.2, 0.3]),
    'The recolour that state A did record must still be applied.',
  );
  assert.deepEqual(rgbAt(cellType, 1), drawn(getCategoryColor(1)));
});

test('restoring a state clears fields its values never mention', async () => {
  const harness = createHarness();
  const { state, cellType, score, gene } = harness;

  const pristineState = snapshotEffectiveState(state);
  const empty = captureBoth(harness);
  assert.deepEqual(empty, { filters: { views: [[]] }, colors: { views: [[]] } }, 'An untouched dataset records no filters or colours.');

  state.setVisibilityForCategory(cellType, 0, false);
  state.ensureContinuousMetadata(score);
  score._continuousFilter = { min: 2, max: 5 };
  score._filterEnabled = false;
  state.ensureContinuousMetadata(gene);
  gene._useFilterColorRange = false;
  gene._continuousFilter = { min: 4, max: 12 };
  gene._filterEnabled = false;

  await restoreBoth(harness, empty);

  assert.deepEqual(
    snapshotEffectiveState(state),
    pristineState,
    'Values with no field entries must return every field to its load-time defaults.',
  );
});

test('a narrowed filter does not drag the restored colour range with it', async () => {
  const saving = createHarness();

  // Stats are {1, 8}. Narrow only the filter; the colour range stays at the
  // full data range, and the colour domain follows the colour range because
  // `_useFilterColorRange` defaults to true.
  saving.state.ensureContinuousMetadata(saving.score);
  saving.score._continuousFilter = { min: 3, max: 6 };
  assert.deepEqual(saving.score._continuousColorRange, { min: 1, max: 8 });

  const stateB = captureBoth(saving);
  assert.deepEqual(stateB.colors, { views: [[]] }, 'the colour range is measured against the data, never the filter');
  const expectedState = snapshotEffectiveState(saving.state);

  // Restore it in a freshly opened tab, where nothing has been materialized yet.
  const loading = createHarness();
  await restoreBoth(loading, stateB);

  assert.deepEqual(
    loading.score._continuousColorRange,
    { min: 1, max: 8 },
    'The restored colour range must be the full data range, not the narrowed filter.',
  );
  assert.deepEqual(
    snapshotEffectiveState(loading.state),
    expectedState,
    'A fresh restore must reproduce the saved state exactly.',
  );
  assert.deepEqual(captureBoth(loading), stateB);
});

test('gray for zero is a colour of its own: restored, and off when a value does not say it', async () => {
  const saving = createHarness();
  saving.state.ensureContinuousMetadata(saving.gene);
  saving.gene._zeroGray = true;
  saving.gene._continuousFilter = { min: 4, max: 12 };
  saving.state.ensureContinuousMetadata(saving.score);
  saving.score._continuousFilter = { min: 3, max: 6 };
  const saved = captureBoth(saving);
  assert.deepEqual(saved.colors.views[0], [{ field: { source: 'var', key: 'GAPDH' }, zeroGray: true }]);

  // Gray for zero on, restored.
  const loading = createHarness();
  await restoreBoth(loading, saved);
  assert.equal(loading.gene._zeroGray, true);

  // A value without `zeroGray`: gray for zero off, the default; the filters restore.
  const older = createHarness();
  older.gene._zeroGray = true;
  await restoreBoth(older, { filters: saved.filters, colors: { views: [[]] } });
  older.state.ensureContinuousMetadata(older.gene);
  assert.equal(older.gene._zeroGray, false, 'absent means off, the default');
  assert.deepEqual(older.gene._continuousFilter, { min: 4, max: 12 }, 'the rest of the state restores');
  assert.deepEqual(older.score._continuousFilter, { min: 3, max: 6 });
});
