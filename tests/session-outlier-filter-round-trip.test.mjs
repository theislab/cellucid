/**
 * The outlier filter belongs to categorical observation fields: the prepared
 * export only writes latent outlier quantiles for categoricals, and the filter
 * manager refuses an outlier filter on anything else. A session therefore has
 * to carry the outlier threshold and its enabled state in the category entry.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFilterSerializer,
  serializeFiltersForFields,
  validateFiltersForState,
} from '../assets/js/app/state-serializer/filters.js';
import {
  DataStateColorMethods,
} from '../assets/js/app/state/managers/color-manager.js';

function createHarness() {
  const leiden = {
    key: 'leiden',
    kind: 'category',
    categories: ['a', 'b'],
    codes: Uint8Array.from([0, 1, 0, 1]),
    outlierQuantiles: Float32Array.from([0.1, 0.5, 0.97, 0.99]),
    _isDeleted: false,
  };
  const score = {
    key: 'score',
    kind: 'continuous',
    values: Float32Array.from([1, 2, 3, 4]),
    _isDeleted: false,
  };
  const state = {
    pointCount: 4,
    getFields: () => [leiden, score],
    getVarFields: () => [],
    async ensureFieldLoaded() {},
    async ensureVarFieldLoaded() {},
    beginBatch() {},
    endBatch() {},
    ensureCategoryMetadata(field) {
      return DataStateColorMethods.prototype.ensureCategoryMetadata.call(this, field);
    },
    ensureContinuousMetadata(field) {
      return DataStateColorMethods.prototype.ensureContinuousMetadata.call(this, field);
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
  return { state, leiden, score };
}

test('a categorical outlier threshold and its enabled state survive save and load', async () => {
  const saving = createHarness();
  saving.leiden._outlierThreshold = 0.95;
  saving.leiden._outlierFilterEnabled = false;
  const session = createFilterSerializer({ state: saving.state }).serializeFilters();

  assert.deepEqual(session['obs:leiden'], {
    kind: 'category',
    filterEnabled: null,
    visibility: [],
    colors: [],
    colormapId: null,
    outlierFilterEnabled: false,
    outlierThreshold: 0.95,
  });

  const loading = createHarness();
  // The tab being restored into has drifted to a different outlier state.
  loading.leiden._outlierThreshold = 0.5;
  await createFilterSerializer({ state: loading.state }).restoreFilters(
    session,
    { signal: null },
  );
  assert.equal(loading.leiden._outlierThreshold, 0.95);
  assert.equal(loading.leiden._outlierFilterEnabled, false);
});

test('an unchanged outlier filter writes nothing', () => {
  const { leiden } = createHarness();
  leiden._outlierThreshold = 1;
  leiden._outlierFilterEnabled = true;
  assert.deepEqual(serializeFiltersForFields([leiden], 'obs'), {});
});

test('continuous entries carry no outlier keys', () => {
  const { state, score } = createHarness();
  state.ensureContinuousMetadata(score);
  score._filterEnabled = false;
  const entry = serializeFiltersForFields([score], 'obs')['obs:score'];
  assert.equal(Object.hasOwn(entry, 'outlierThreshold'), false);
  assert.equal(Object.hasOwn(entry, 'outlierFilterEnabled'), false);
  assert.throws(
    () => validateFiltersForState(state, {
      'obs:score': { ...entry, outlierFilterEnabled: null, outlierThreshold: 0.5 },
    }),
    /Continuous filter "obs:score"/,
  );
});
