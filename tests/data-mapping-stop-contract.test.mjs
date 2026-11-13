/**
 * `mapping.set` stopped: the person's or
 * an agent's Stop ends the change at once, whatever it is waiting on (an
 * embedding's coordinates read for a view to move to, a group's data
 * staged), publishes nothing, releases the mapping's lock, and leaves the
 * dispatcher free for the next change. The same signal reaches the `mapping`
 * domain's restore (an undo or a jump).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DimensionManager } from '../assets/js/data/dimension-manager.js';
import { assembleAnnDataCandidates, describeAnnDataProbes } from '../assets/js/data/data-mapping-candidates.js';
import { createMappingLayoutProvider } from '../assets/js/app/state/managers/mapping-manager.js';
import { installFieldActions } from '../assets/js/app/state/actions/field-actions.js';
import { getActions } from '../assets/js/app/actions/index.js';
import { createMappingDomain } from '../assets/js/app/state/domains/mapping.js';
import { cancelled } from '../assets/js/utils/abort.js';
import { installDataMappingMethods } from './helpers/data-mapping-state.mjs';
import { mappingProbes } from './helpers/anndata-mapping-mocks.mjs';
import { settlesSoon } from './helpers/settles.mjs';

const N_OBS = 4;
const UMAP = Object.freeze({ key: 'X_umap', columns: [0, 1] });
const TSNE = Object.freeze({ key: 'X_tsne', columns: [0, 1] });

/** A dataset showing X_umap whose X_tsne coordinates are read only when `release()` is called. */
function makeState() {
  const probes = mappingProbes({ nObs: N_OBS, obsm: { X_umap: 2, X_tsne: 2 }, hasX: true });
  const candidates = assembleAnnDataCandidates(describeAnnDataProbes(probes), {
    slots: { '1d': null, '2d': UMAP, '3d': null },
    guessed: [],
  });
  const manager = new DimensionManager();
  manager.registerLayouts([{
    layoutKey: 'X_umap', dimension: 2, label: 'X_umap', path: 'obsm/0/0-1', provenance: UMAP, origin: 'identity',
  }]);
  manager.setLayoutProvider(createMappingLayoutProvider(candidates));
  const reads = [];
  let release = () => {};
  manager.getPositions = layoutKey => {
    reads.push(layoutKey);
    if (layoutKey === 'X_umap') return Promise.resolve(new Float32Array(N_OBS * 2));
    return new Promise(resolve => { release = () => resolve(new Float32Array(N_OBS * 2)); });
  };
  const state = {
    dimensionManager: manager,
    viewContexts: new Map([['live', { id: 'live', followsDefault: true }]]),
    getViewLayoutKey: viewId => manager.getViewLayout(viewId),
    viewFollowsDefault(viewId) { return this.viewContexts.get(viewId).followsDefault; },
    async setViewRepresentation(viewId, layoutKey, { followsDefault }) {
      manager.setViewLayout(viewId, layoutKey);
      this.viewContexts.get(viewId).followsDefault = followsDefault;
    },
  };
  installDataMappingMethods(state, { mapping: null });
  state.publishDatasetMapping({ mapping: candidates.defaults, candidates, origin: 'default' });
  manager.setViewLayout('live', 'X_umap');
  return { state, reads, release: () => release() };
}

const STOP = () => cancelled('user', 'The person stopped Claude.');

test('mapping.set stopped while the view\'s new embedding is read ends at once, publishes nothing and frees the next change', async t => {
  const { state, reads, release } = makeState();
  t.after(installFieldActions({ state }));
  const actions = getActions();
  const before = state.getDataMapping();
  // The 2D default moves to t-SNE: the view that follows it waits for X_tsne's coordinates.
  const agent = { origin: 'agent', agent: 'Claude', turn: 'turn-mapping' };
  const changing = actions.dispatch(
    'mapping.set',
    { embeddings: { enabled: [TSNE, UMAP], defaults: { '1d': null, '2d': TSNE, '3d': null } } },
    agent,
  );
  while (!reads.includes('X_tsne')) await new Promise(resolve => setImmediate(resolve));
  const reason = STOP();
  assert.equal(actions.stop({ turn: agent.turn }, reason), 1);
  const outcome = await settlesSoon(changing);
  assert.ok(outcome !== null, 'the stopped change ended without the read');
  assert.equal(outcome.error, reason, 'said as the Stop, never as a failure');
  assert.equal(state.getDataMapping(), before, 'nothing was published');
  assert.equal(state.getViewLayoutKey('live'), 'X_umap');
  assert.equal(state._mappingChangeLock, null, 'the mapping\'s lock is released');
  // The read that was left ends on its own and changes nothing.
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.getDataMapping(), before);
  // The next change runs.
  await actions.dispatch('mapping.set', { knn: null });
  assert.equal(state.getDataMapping().knn, null);
});

test('the mapping domain\'s restore takes the move\'s signal', async () => {
  const { state, reads } = makeState();
  const domain = createMappingDomain({ state, refreshUi: () => {} });
  const before = state.getDataMapping();
  const value = { ...before, embeddings: { enabled: [TSNE, UMAP], defaults: { '1d': null, '2d': TSNE, '3d': null } } };
  const stop = new AbortController();
  const restoring = domain.restore(value, { signal: stop.signal });
  while (!reads.includes('X_tsne')) await new Promise(resolve => setImmediate(resolve));
  const reason = STOP();
  stop.abort(reason);
  const outcome = await settlesSoon(restoring);
  assert.ok(outcome !== null);
  assert.equal(outcome.error, reason);
  assert.equal(state.getDataMapping(), before);
  assert.equal(state._mappingChangeLock, null);
});
