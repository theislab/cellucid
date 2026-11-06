/**
 * The outlier filter belongs to categorical observation fields: latent outlier
 * quantiles exist only for categoricals, and the filter manager refuses an
 * outlier filter on anything else. The `filters` state domain
 * (`app/state/domains/filters.js`) therefore carries the outlier threshold and
 * its enabled state in a category field's entry, and restoring it gets the
 * quantiles the threshold needs, as moving the slider does. A threshold whose
 * quantiles cannot be got filters no cell: it is held as the value holds it
 * (so the value is restored exactly), and the field's outlier status says why.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { captureFieldFilter, createFiltersDomain } from '../assets/js/app/state/domains/filters.js';
import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';

const POINT_COUNT = 4;
const LEIDEN_QUANTILES = Float32Array.from([0.1, 0.5, 0.97, 0.99]);

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
 * A DataState of four cells with a categorical field (`leiden`) whose outlier
 * quantiles are got on first use, and a continuous field (`score`).
 */
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
  const leiden = {
    key: 'leiden',
    kind: 'category',
    categories: ['a', 'b'],
    codes: Uint8Array.from([0, 1, 0, 1]),
    loaded: true,
    centroidsByLayout: new Map(),
  };
  const score = { key: 'score', kind: 'continuous', values: Float32Array.from([1, 2, 3, 4]), loaded: true };
  state.obsData = { fields: [leiden, score] };
  state.varData = { fields: [] };
  state._resetViewContexts();
  state.ensureHighlightPage();
  // Quantiles are got on the filter's first use; a restored threshold below
  // 1 asks for them, as moving the slider does.
  const quantileReads = [];
  state.ensureOutlierQuantiles = async fieldIndex => {
    quantileReads.push(fieldIndex);
    state.obsData.fields[fieldIndex].outlierQuantiles = LEIDEN_QUANTILES;
    return LEIDEN_QUANTILES;
  };
  return {
    state, leiden, score, quantileReads,
    filters: createFiltersDomain({ state, viewer, refreshUi: () => {} }),
  };
}

test('a categorical outlier threshold and its enabled state survive capture and restore', async () => {
  const saving = createHarness();
  saving.leiden.outlierQuantiles = LEIDEN_QUANTILES;
  saving.leiden._outlierThreshold = 0.95;
  saving.leiden._outlierFilterEnabled = false;
  const saved = structuredClone(saving.filters.capture());

  assert.deepEqual(saved, {
    views: [[{ field: { source: 'obs', key: 'leiden' }, outlier: 0.95, outlierOff: true }]],
  });

  const loading = createHarness();
  // The tab being restored into has drifted to a different outlier state.
  loading.leiden._outlierThreshold = 0.5;
  await loading.filters.restore(saved);
  assert.equal(loading.leiden._outlierThreshold, 0.95);
  assert.equal(loading.leiden._outlierFilterEnabled, false);
  assert.deepEqual(loading.quantileReads, [0]);
  assert.deepEqual(loading.filters.capture(), saved);
});

test('an unchanged outlier filter records nothing', () => {
  const { leiden } = createHarness();
  leiden._outlierThreshold = 1;
  leiden._outlierFilterEnabled = true;
  assert.equal(captureFieldFilter(leiden, 'obs'), null);
});

test('continuous entries carry no outlier keys', () => {
  const { state, score } = createHarness();
  state.ensureContinuousMetadata(score);
  score._filterEnabled = false;
  const entry = captureFieldFilter(score, 'obs');
  assert.deepEqual(entry, { field: { source: 'obs', key: 'score' }, off: true });
  assert.equal(Object.hasOwn(entry, 'outlier'), false);
  assert.equal(Object.hasOwn(entry, 'outlierOff'), false);
});

for (const [label, failure] of [
  ['cancelled', new DOMException('Computing the outlier quantiles was cancelled.', 'AbortError')],
  ['failed', new Error("Latent space 'X_scVI' cannot be used: NaN at cell 3.")],
]) {
  test(`a threshold whose quantiles were ${label} filters no cell, and the rest is restored`, async () => {
    const saving = createHarness();
    saving.leiden.outlierQuantiles = LEIDEN_QUANTILES;
    saving.leiden._outlierThreshold = 0.9;
    saving.state.ensureContinuousMetadata(saving.score);
    saving.score._filterEnabled = false;
    saving.state.computeGlobalVisibility();
    assert.deepEqual([...saving.state.categoryTransparency], [1, 1, 0, 0], 'with its quantiles, the threshold hides the outliers');
    const saved = structuredClone(saving.filters.capture());

    const loading = createHarness();
    let asked = 0;
    loading.state.ensureOutlierQuantiles = async () => {
      asked++;
      throw failure;
    };
    await loading.filters.restore(saved);
    assert.equal(asked, 1, 'the quantiles were asked for once');
    assert.equal(loading.score._filterEnabled, false, 'the rest of the state is restored');
    // Held as the value holds it, so restoring it again changes nothing ...
    assert.equal(loading.leiden._outlierThreshold, 0.9);
    assert.deepEqual(loading.filters.capture(), saved);
    // ... and never applied silently: without its quantiles it hides no cell.
    assert.equal(loading.leiden.outlierQuantiles, undefined);
    assert.deepEqual([...loading.state.categoryTransparency], [1, 1, 1, 1]);
  });
}
