/**
 * Getting a categorical field's outlier quantiles (`state/managers/outlier-quantiles.js`)
 * on a real DataState with a kept view:
 * - picking a field reads nothing; the outlier status says what the filter
 *   can do (no latent space with suggestions, too-small categories, what
 *   getting the quantiles costs);
 * - the first threshold below 1 gets them once, for every view, and filters;
 * - Cancel stops the read, keeps nothing and puts every view's threshold
 *   back at 100%; it can be started again;
 * - a failure says why and leaves the same state; moving the slider tries again;
 * - quantiles that arrive after the latent space was replaced are dropped.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createInMemoryDimensionManager } from '../assets/js/data/dimension-manager.js';
import { describeOutlierStatus } from '../assets/js/app/ui/modules/outlier-filter-control.js';

const N = 6;

function categorical(key, fieldIndex, path) {
  return {
    key,
    kind: 'category',
    fieldIndex,
    categories: ['a', 'b'],
    codesDtype: 'uint8',
    codesMissingValue: 255,
    palette: null,
    outlierQuantilesPath: path,
  };
}

function makeState({ path = 'outliers/0/0', minPoints = 2, plan = { source: 'read', latentKey: 'X_scVI', storedBytes: 4096, valueBytes: 9000, kept: true, storedLatentKey: null } } = {}) {
  const state = new DataState(null, null);
  state.viewer = new Proxy({ getViewLayout: () => ({ mode: 'grid' }) }, {
    get(target, property) {
      return Object.hasOwn(target, property) ? target[property] : () => {};
    },
  });
  state.pointCount = N;
  state.dimensionManager = createInMemoryDimensionManager({ positions: new Float32Array(N * 2), dimension: 2 });
  state.activeDimensionLevel = 2;
  state.colorsArray = new Uint8Array(N * 4);
  state.categoryTransparency = new Uint8Array(N).fill(1);
  state.cellVisibilityMask = new Uint8Array(N).fill(1);
  state.dataMapping = { latent: path === null ? null : 'X_scVI' };
  // The outlier route names obsm position 0.
  state._mappingCandidates = { kind: 'anndata', obsm: [{ key: 'X_scVI', usable: true, storage: 'dense', shape: [N, 10] }] };
  const descriptor = Object.freeze(categorical('leiden', 0, path));
  state._obsFieldDescriptors = Object.freeze([descriptor]);
  state.obsData = {
    fields: [{
      ...descriptor,
      codes: Uint8Array.from([0, 0, 0, 1, 1, 1]),
      centroidsByLayout: new Map(),
      loaded: true,
    }],
  };
  state._fieldDataCache.set('leiden', { codes: state.obsData.fields[0].codes });
  const reads = [];
  const gates = [];
  state.fieldLoader = {
    outlierMinPoints: minPoints,
    describeOutlierQuantiles: async () => plan,
    loadOutlierQuantiles: (field, { codes, signal }) => {
      reads.push({ field, codes });
      return new Promise((resolve, reject) => {
        gates.push({ resolve, reject });
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  state._resetViewContexts();
  state.setActiveField(0);
  state.createViewFromSource('live', 'snap_1');
  state.dimensionManager.copyViewLayout('live', 'snap_1');
  const statuses = [];
  state.on('outliers:status', () => statuses.push(state.getOutlierFilterStatus(0).state));
  return { state, reads, gates, statuses, descriptor };
}

const fieldOf = (state, viewId) => (viewId === state.activeViewId ? state : state.viewContexts.get(viewId)).obsData.fields[0];
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('picking a field reads nothing; the status says what the filter costs', async () => {
  const { state, reads } = makeState();
  assert.equal(state.getOutlierFilterStatus(0).state, 'available');
  await settle();
  const status = state.getOutlierFilterStatus(0);
  assert.equal(status.plan.source, 'read');
  // One short line names what the first use reads and how much.
  assert.match(describeOutlierStatus(status).text, /^First use reads X_scVI \(\d[^)]*\)\.$/);
  assert.equal(describeOutlierStatus(status).slider, true);
  assert.equal(reads.length, 0);
});

test('without a latent space the filter is one button, whose title names what the file has', () => {
  const { state } = makeState({ path: null });
  state.getMappingCandidates = () => ({
    obsm: [
      { key: 'X_umap', usable: true, storage: 'dense', shape: [N, 2] },
      { key: 'X_pca', usable: true, storage: 'dense', shape: [N, 50] },
      { key: 'X_scVI', usable: true, storage: 'dense', shape: [N, 30] },
    ],
  });
  state.getMappingGroupChoices = () => [
    { value: null, usable: true },
    { value: 'X_umap', usable: true },
    { value: 'X_pca', usable: true },
    { value: 'X_scVI', usable: true },
  ];
  const status = state.getOutlierFilterStatus(0);
  assert.equal(status.state, 'no-latent');
  assert.deepEqual(status.suggestions.map(item => item.key), ['X_scVI', 'X_pca']);
  const described = describeOutlierStatus(status);
  assert.equal(described.action, 'latent');
  assert.equal(described.slider, false);
  assert.equal(described.text, null, 'no paragraph: what it measures is in the (i)');
  assert.match(described.detail, /X_scVI or X_pca/);
});

test('a field with no category large enough says so', () => {
  const { state } = makeState({ minPoints: 4 });
  const status = state.getOutlierFilterStatus(0);
  assert.deepEqual({ ...status }, { state: 'too-small', fieldKey: 'leiden', latentKey: 'X_scVI', minPoints: 4, largest: 3 });
  assert.equal(describeOutlierStatus(status).text, 'No category has 4 cells.');
  assert.match(describeOutlierStatus(status).detail, /No category of “leiden” has 4 cells/);
});

test('the first threshold below 1 gets the quantiles once, for every view, and then filters', async () => {
  const { state, reads, gates } = makeState();
  await state.setOutlierThresholdForActive(1);
  assert.equal(reads.length, 0, 'moving the control at 100% reads nothing');

  const first = state.setOutlierThresholdForActive(0.9);
  const second = state.setOutlierThresholdForActive(0.8);
  await settle();
  assert.equal(reads.length, 1, 'concurrent moves share one job');
  assert.equal(reads[0].codes, state.obsData.fields[0].codes, 'the codes the field holds are passed');
  assert.equal(state.getOutlierFilterStatus(0).state, 'running');
  const quantiles = Float32Array.from([0.5, 1, 0.9, 0.5, 1, 0.7]);
  gates[0].resolve(quantiles);
  await Promise.all([first, second]);

  assert.equal(fieldOf(state, 'live').outlierQuantiles, quantiles);
  assert.equal(fieldOf(state, 'snap_1').outlierQuantiles, quantiles);
  assert.equal(state._fieldDataCache.get('leiden').outlierQuantiles, quantiles);
  assert.equal(fieldOf(state, 'live')._outlierThreshold, 0.8);
  assert.equal(state.getOutlierFilterStatus(0).state, 'ready');
  assert.ok(state.isOutlierFilterEnabledForActiveField());
  await state.setOutlierThresholdForActive(0.5);
  assert.equal(reads.length, 1, 'later moves read nothing');
});

test('Cancel keeps nothing, puts the threshold back at 100%, and can start again', async () => {
  const { state, reads, gates, statuses } = makeState();
  const moving = state.setOutlierThresholdForActive(0.9);
  await settle();
  assert.equal(state.cancelOutlierQuantiles(0), true);
  await moving;
  await settle();
  assert.equal(fieldOf(state, 'live').outlierQuantiles, undefined);
  assert.equal(fieldOf(state, 'live')._outlierThreshold, 1);
  assert.equal(state.getOutlierFilterStatus(0).state, 'available');
  assert.ok(statuses.includes('running'));
  assert.equal(state.cancelOutlierQuantiles(0), false, 'nothing left to cancel');

  const again = state.setOutlierThresholdForActive(0.7);
  await settle();
  assert.equal(reads.length, 2);
  gates[1].resolve(Float32Array.from([1, 1, 1, 1, 1, 1]));
  await again;
  assert.equal(fieldOf(state, 'live')._outlierThreshold, 0.7);
  assert.equal(state.getOutlierFilterStatus(0).state, 'ready');
});

test('a failure says why, leaves the threshold at 100%, and the next move tries again', async () => {
  const { state, reads, gates } = makeState();
  const moving = state.setOutlierThresholdForActive(0.9);
  await settle();
  gates[0].reject(new Error('Latent space \'X_scVI\' cannot be used: NaN at cell 3.'));
  await moving;
  const status = state.getOutlierFilterStatus(0);
  assert.equal(status.state, 'failed');
  assert.match(describeOutlierStatus(status).text, /Move the slider to try again/);
  assert.match(describeOutlierStatus(status).detail, /NaN at cell 3/);
  assert.equal(fieldOf(state, 'live')._outlierThreshold, 1);
  void state.setOutlierThresholdForActive(0.9);
  await settle();
  assert.equal(reads.length, 2);
  assert.equal(state.getOutlierFilterStatus(0).state, 'running');
  state.cancelOutlierQuantiles(0);
});

test('quantiles that arrive after the latent space was replaced are dropped', async () => {
  const { state, gates } = makeState();
  const pending = state.ensureOutlierQuantiles(0);
  await settle();
  state._obsFieldDescriptors = Object.freeze([Object.freeze(categorical('leiden', 0, 'outliers/1/0'))]);
  gates[0].resolve(new Float32Array(N).fill(1));
  assert.equal(await pending, null);
  assert.equal(fieldOf(state, 'live').outlierQuantiles, undefined);
});

test('a latent space that cannot be read asks for another one', async () => {
  const { MappingLoadError } = await import('../assets/js/data/data-mapping-candidates.js');
  const { state, gates } = makeState();
  const moving = state.setOutlierThresholdForActive(0.9);
  await settle();
  gates[0].reject(new MappingLoadError('X_scVI', 'NaN at cell 3', "Latent space 'X_scVI' cannot be used: NaN at cell 3."));
  await moving;
  const status = state.getOutlierFilterStatus(0);
  assert.equal(status.latentUnusable, true);
  const described = describeOutlierStatus(status);
  assert.equal(described.action, 'latent');
  assert.equal(described.text, 'This latent space cannot be used.');
  assert.match(described.detail, /NaN at cell 3/);
  assert.equal(state.getMappingChoiceUnusableReason('latent', 'X_scVI'), 'NaN at cell 3');
});

/**
 * A dataset replacement retires the replaced dataset's outlier jobs: the read
 * of its latent space stops, nothing it found is reported on or recorded for
 * the dataset that replaced it.
 */
test('another dataset stops the outlier read, and nothing of it reaches the new dataset', async () => {
  const { state, reads, gates } = makeState();
  const marked = [];
  state._markMappingChoiceUnusable = (...args) => marked.push(args);
  const signals = [];
  const load = state.fieldLoader.loadOutlierQuantiles;
  state.fieldLoader.loadOutlierQuantiles = (field, options) => {
    signals.push(options.signal);
    return load(field, options);
  };
  const filtering = state.setOutlierThresholdForActive(0.9);
  await settle();
  assert.equal(reads.length, 1);
  state.initScene(new Float32Array(N * 3), { fields: [] });
  assert.equal(signals[0].aborted, true, 'the latent read stops');
  await filtering.catch(() => {});
  await settle();
  assert.equal(state._outlierJobs.size, 0);
  assert.deepEqual(marked, []);
  // A refusal the read reports anyway, after the replacement, is not recorded.
  gates[0].reject(new Error('late'));
});

test('a latent refusal that lands after the replacement marks nothing of the new dataset', async () => {
  const { state, gates } = makeState();
  const marked = [];
  state._markMappingChoiceUnusable = (...args) => marked.push(args);
  // A loader that does not stop on abort: its refusal arrives after the replacement.
  const load = state.fieldLoader.loadOutlierQuantiles;
  state.fieldLoader.loadOutlierQuantiles = (field, options) => load(field, { ...options, signal: null });
  const job = state._startOutlierJob(0, state._obsFieldDescriptors[0]);
  await settle();
  // The field and its descriptor are replaced (as a new dataset or latent space does).
  state._obsFieldDescriptors = Object.freeze([]);
  const { MappingLoadError } = await import('../assets/js/data/data-mapping-candidates.js');
  gates[0].reject(new MappingLoadError('X_scVI', 'has NaN values', "obsm['X_scVI'] has NaN values."));
  await job.promise.catch(() => {});
  await settle();
  assert.deepEqual(marked, []);
});
