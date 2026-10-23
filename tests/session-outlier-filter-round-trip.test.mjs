/**
 * The outlier filter belongs to categorical observation fields: latent outlier
 * quantiles exist only for categoricals, and the filter manager refuses an
 * outlier filter on anything else. A session therefore carries the outlier
 * threshold and its enabled state in the category entry, and restoring it gets
 * the quantiles the threshold needs; a threshold whose quantiles cannot be got
 * is never applied silently and never dropped silently: it is named.
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
import { getNotificationCenter } from '../assets/js/app/notification-center.js';

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
    // Quantiles load on the filter's first use; a restored threshold below 1
    // asks for them before it is applied.
    quantileReads: [],
    async ensureOutlierQuantiles(fieldIndex) {
      this.quantileReads.push(fieldIndex);
      return leiden.outlierQuantiles;
    },
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
  assert.deepEqual(loading.state.quantileReads, [0]);
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

for (const [label, failure, reason] of [
  ['cancelled', new DOMException('Computing the outlier quantiles was cancelled.', 'AbortError'), 'computing its outlier quantiles was cancelled'],
  ['failed', new Error("Latent space 'X_scVI' cannot be used: NaN at cell 3."), 'NaN at cell 3'],
]) {
  test(`a threshold whose quantiles were ${label} is named, not applied, and the rest is restored`, async t => {
    const warnings = [];
    const notifications = getNotificationCenter();
    const warning = notifications.warning;
    notifications.warning = message => {
      warnings.push(message);
      return 'warning-id';
    };
    t.after(() => {
      notifications.warning = warning;
    });
    const saving = createHarness();
    saving.leiden._outlierThreshold = 0.9;
    saving.state.ensureContinuousMetadata(saving.score);
    saving.score._filterEnabled = false;
    const session = createFilterSerializer({ state: saving.state }).serializeFilters();

    const loading = createHarness();
    loading.state.ensureOutlierQuantiles = async () => {
      throw failure;
    };
    const outcome = await createFilterSerializer({ state: loading.state }).restoreFilters(session, { signal: null });
    assert.equal(loading.leiden._outlierThreshold, undefined);
    assert.equal(loading.score._filterEnabled, false, 'the rest of the session is restored');
    assert.equal(outcome.outliersNotRestored.length, 1);
    assert.equal(outcome.outliersNotRestored[0].fieldKey, 'leiden');
    assert.equal(outcome.outliersNotRestored[0].threshold, 0.9);
    assert.match(outcome.outliersNotRestored[0].reason, new RegExp(reason));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /The outlier filter of "leiden" \(90%\) was not restored/);
  });
}
