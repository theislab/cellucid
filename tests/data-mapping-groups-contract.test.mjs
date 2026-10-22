/**
 * The mapping groups beside the embeddings (`state/managers/mapping-groups.js`),
 * through the real DataState mapping methods and a stand-in server: a group
 * is staged (its data read and checked) before anything is published, then
 * committed in the same transaction as the embeddings, and rolled back with
 * them. A refused choice is marked unusable with its reason and changes
 * nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DimensionManager } from '../assets/js/data/dimension-manager.js';
import {
  MappingLoadError,
  assembleAnnDataCandidates,
  describeAnnDataProbes,
} from '../assets/js/data/data-mapping-candidates.js';
import { createMappingLayoutProvider } from '../assets/js/app/state/managers/mapping-manager.js';
import { installDataMappingMethods } from './helpers/data-mapping-state.mjs';
import { mappingProbes } from './helpers/anndata-mapping-mocks.mjs';

const N_OBS = 4;
const BASE = 'http://127.0.0.1:65433/served/';

function obspProbe(key, shape = [N_OBS, N_OBS]) {
  return { key, storage: 'csr', shape, dtype: 'float32', numeric: true, nnz: 6 };
}

function manifest(nEdges) {
  return {
    format: 'edge_pairs',
    n_cells: N_OBS,
    n_edges: nEdges,
    max_neighbors: 2,
    index_bytes: 2,
    index_dtype: 'uint16',
    sourcesPath: 'connectivity/edges.src.bin',
    destinationsPath: 'connectivity/edges.dst.bin',
    weightsPath: 'connectivity/edges.weights.f64.bin',
    weight_dtype: 'float64',
    weight_bytes: 8,
    compression: null,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A served dataset: its graphs answer at `knn/{p}/`, `distances` with 422. */
function installServer(t) {
  const requested = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async url => {
    const text = String(url);
    requested.push(text.slice(BASE.length));
    if (text === `${BASE}_cellucid/mapping/knn/0/connectivity_manifest.json`) return jsonResponse(manifest(5));
    if (text === `${BASE}_cellucid/mapping/knn/2/connectivity_manifest.json`) return jsonResponse(manifest(3));
    if (text === `${BASE}_cellucid/mapping/knn/1/connectivity_manifest.json`) {
      return jsonResponse({
        error: "obsp['distances'] is not symmetric — choose a connectivities matrix.",
        key: 'distances',
        reason: 'not symmetric — choose a connectivities matrix',
      }, 422);
    }
    throw new Error(`unexpected request ${text}`);
  };
  return requested;
}

const UMAP = Object.freeze({ key: 'X_umap', columns: [0, 1] });
const TSNE = Object.freeze({ key: 'X_tsne', columns: [0, 1] });

/** The embeddings group showing `defaultRef` as the 2D default. */
function embeddingsWith(defaultRef) {
  return { enabled: [TSNE, UMAP], defaults: { '1d': null, '2d': defaultRef, '3d': null } };
}

function makeState({ relayoutFails = false, publishFails = false } = {}) {
  const probes = mappingProbes({ nObs: N_OBS, obsm: { X_umap: 2, X_tsne: 2 }, hasX: true });
  probes.obsp = [
    obspProbe('connectivities'),
    obspProbe('distances'),
    obspProbe('scvi_connectivities'),
    obspProbe('X_wrong', [N_OBS, N_OBS + 1]),
  ];
  const candidates = assembleAnnDataCandidates(describeAnnDataProbes(probes), {
    slots: { '1d': null, '2d': UMAP, '3d': null },
    guessed: [],
  });
  const manager = new DimensionManager();
  manager.registerLayouts([{
    layoutKey: 'X_umap',
    dimension: 2,
    label: 'X_umap',
    path: 'embeddings/0_2d.bin',
    provenance: { key: 'X_umap', columns: [0, 1] },
    origin: 'identity',
  }]);
  manager.setLayoutProvider(createMappingLayoutProvider(candidates));
  manager.getPositions = async layoutKey => new Float32Array(N_OBS * manager.getLayout(layoutKey).dimension);

  const graphs = [];
  let graph = { manifest: manifest(5), manifestUrl: `${BASE}connectivity_manifest.json` };
  const events = [];
  const state = {
    dimensionManager: manager,
    viewContexts: new Map([['live', { id: 'live', followsDefault: true }]]),
    emit(name, payload) {
      events.push([name, payload]);
    },
    getViewLayoutKey(viewId) {
      return manager.getViewLayout(viewId);
    },
    viewFollowsDefault(viewId) {
      return this.viewContexts.get(viewId).followsDefault;
    },
    async setViewRepresentation(viewId, layoutKey, { followsDefault }) {
      if (relayoutFails && layoutKey !== 'X_umap') throw new Error('relayout failed');
      manager.setViewLayout(viewId, layoutKey);
      this.viewContexts.get(viewId).followsDefault = followsDefault;
    },
  };
  installDataMappingMethods(state, { mapping: null });
  state.publishDatasetMapping({
    mapping: {
      kind: 'anndata',
      embeddings: embeddingsWith(UMAP),
      knn: 'connectivities',
      geneNames: 'index',
      expression: 'X',
      latent: null,
      vectorFields: [],
    },
    candidates,
    origin: 'default',
  });
  manager.setViewLayout('live', 'X_umap');
  state.setMappingRuntime({
    getBaseUrl: () => BASE,
    createVectorFieldManager: () => {
      throw new Error('No test here changes the vector fields.');
    },
    resetGeneAnalysis: () => {},
    getConnectivityGraph: () => graph,
    replaceConnectivityGraph(next) {
      if (publishFails && next.manifest?.n_edges === 3) throw new Error('graph publication failed');
      graphs.push(next.manifest === null ? null : next.manifest.n_edges);
      graph = next;
    },
  });
  return { state, manager, graphs, events, currentGraph: () => graph };
}

test('the graph menu lists every obsp matrix, with the reason one cannot be used', () => {
  const { state } = makeState();
  assert.equal(state.canChangeMappingGroup('knn'), true);
  assert.deepEqual(state.getMappingGroupChoices('knn'), [
    { value: null, label: 'None', usable: true, reason: null },
    { value: 'connectivities', label: 'connectivities · sparse 4 × 4', usable: true, reason: null },
    { value: 'distances', label: 'distances · sparse 4 × 4', usable: true, reason: null },
    { value: 'scvi_connectivities', label: 'scvi_connectivities · sparse 4 × 4', usable: true, reason: null },
    { value: 'X_wrong', label: 'X_wrong · sparse 4 × 5', usable: false, reason: 'not square' },
  ]);
  assert.deepEqual(state.getMappingGroupChoices('latent'), [
    { value: null, label: 'None', usable: true, reason: null },
    { value: 'X_umap', label: 'X_umap · 2 columns', usable: true, reason: null },
    { value: 'X_tsne', label: 'X_tsne · 2 columns', usable: true, reason: null },
  ]);
  assert.equal(state.getConnectivityEdgeCount(), 5);
});

test('a graph is staged, then published in the mapping transaction', async t => {
  const requested = installServer(t);
  const { state, graphs, events, currentGraph } = makeState();
  const next = { ...state.getDataMapping(), knn: 'scvi_connectivities' };
  assert.equal(state.describeDataMappingRefusal(next), null);
  assert.equal(await state.applyDataMapping(next, { origin: 'user' }), true);
  assert.deepEqual(requested, ['_cellucid/mapping/knn/2/connectivity_manifest.json']);
  assert.deepEqual(graphs, [3]);
  assert.equal(currentGraph().manifestUrl, `${BASE}_cellucid/mapping/knn/2/connectivity_manifest.json`);
  assert.equal(state.getDataMapping().knn, 'scvi_connectivities');
  assert.equal(state.getConnectivityEdgeCount(), 3);
  assert.deepEqual(events.filter(([name]) => name === 'mapping:changed').at(-1), ['mapping:changed', {
    mapping: state.getDataMapping(),
    cause: 'apply',
    origin: 'user',
  }]);

  // None removes the graph without reading anything.
  assert.equal(await state.applyDataMapping({ ...next, knn: null }, { origin: 'user' }), true);
  assert.deepEqual(graphs, [3, null]);
  assert.equal(state.getConnectivityEdgeCount(), null);
  assert.equal(requested.length, 1);
});

test('a graph the server refuses changes nothing and stays unusable with its reason', async t => {
  installServer(t);
  const { state, graphs } = makeState();
  const before = state.getDataMapping();
  await assert.rejects(
    state.applyDataMapping({ ...before, knn: 'distances' }, { origin: 'user' }),
    error => error instanceof MappingLoadError && error.key === 'distances'
  );
  assert.deepEqual(graphs, []);
  assert.equal(state.getDataMapping(), before);
  assert.equal(
    state.getMappingChoiceUnusableReason('knn', 'distances'),
    'not symmetric — choose a connectivities matrix'
  );
  assert.deepEqual(
    state.getMappingGroupChoices('knn').find(choice => choice.value === 'distances'),
    {
      value: 'distances',
      label: 'distances · sparse 4 × 4',
      usable: false,
      reason: 'not symmetric — choose a connectivities matrix',
    }
  );
  // Asking again is refused before anything is read.
  assert.equal(
    state.describeDataMappingRefusal({ ...before, knn: 'distances' }),
    "This mapping uses obsp['distances'] as its neighbour graph, which this dataset "
      + 'cannot use (not symmetric — choose a connectivities matrix).'
  );
  assert.equal(
    state.describeMappingChoiceRefusal('knn', 'absent'),
    'this dataset does not have'
  );
  // A new dataset forgets the refusal.
  state.publishDatasetMapping({
    mapping: before,
    candidates: state.getMappingCandidates(),
    origin: 'default',
  });
  assert.equal(state.getMappingChoiceUnusableReason('knn', 'distances'), null);
});

test('a failed embedding relayout publishes no graph', async t => {
  const requested = installServer(t);
  const { state, manager, graphs } = makeState({ relayoutFails: true });
  const before = state.getDataMapping();
  await assert.rejects(
    state.applyDataMapping({
      ...before,
      embeddings: embeddingsWith(TSNE),
      knn: 'scvi_connectivities',
    }, { origin: 'user' }),
    /relayout failed/
  );
  // The graph was staged (read), never published, and the slot is restored.
  assert.deepEqual(requested, ['_cellucid/mapping/knn/2/connectivity_manifest.json']);
  assert.deepEqual(graphs, []);
  assert.equal(manager.getDefaultLayout(2), 'X_umap');
  assert.equal(state.getDataMapping(), before);
});

test('a failed graph publication restores the embeddings already applied', async t => {
  installServer(t);
  const { state, manager, graphs } = makeState({ publishFails: true });
  const before = state.getDataMapping();
  await assert.rejects(
    state.applyDataMapping({
      ...before,
      embeddings: embeddingsWith(TSNE),
      knn: 'scvi_connectivities',
    }, { origin: 'user' }),
    /graph publication failed/
  );
  assert.deepEqual(graphs, []);
  assert.equal(manager.getDefaultLayout(2), 'X_umap');
  assert.equal(manager.getViewLayout('live'), 'X_umap');
  assert.equal(state.getDataMapping(), before);
});

test('a file without X opens on raw.X, marked guessed until another matrix is chosen', () => {
  const probes = mappingProbes({ nObs: N_OBS, nVars: 3, obsm: { X_umap: 2 }, hasX: false });
  probes.raw = { nVars: 5, X: { storage: 'dense', dtype: 'float32' }, varColumns: [] };
  const candidates = assembleAnnDataCandidates(describeAnnDataProbes(probes), {
    slots: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null },
    guessed: [],
  });
  assert.equal(candidates.defaults.expression, 'raw');
  assert.deepEqual(candidates.guessed, ['expression']);
  const state = installDataMappingMethods({ dimensionManager: new DimensionManager() }, {
    mapping: {
      kind: 'anndata',
      embeddings: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null },
      knn: null,
      geneNames: 'index',
      expression: 'raw',
      latent: null,
      vectorFields: [],
    },
    candidates,
  });
  assert.deepEqual(state.getGuessedMappingGroups(), ['expression']);
  assert.equal(state.describeMappingVarCount(state.getDataMapping()), 5);
  state.dataMapping = { ...state.getDataMapping(), expression: null };
  assert.deepEqual(state.getGuessedMappingGroups(), []);
  assert.equal(state.describeMappingVarCount(state.getDataMapping()), 0);
});

function makeVectorState({ failCommit = false } = {}) {
  const probes = mappingProbes({
    nObs: N_OBS,
    obsm: { X_umap: 2, X_tsne: 2, X_pca: 6, velocity_umap_2d: 2, velocity_pca: 6, drift: 3 },
    hasX: true,
  });
  probes.obsp = [obspProbe('connectivities')];
  const candidates = assembleAnnDataCandidates(describeAnnDataProbes(probes), {
    slots: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null },
    guessed: [],
  });
  const created = [];
  const published = [];
  let resets = 0;
  const manager = new DimensionManager();
  manager.registerLayouts([{
    layoutKey: 'X_umap',
    dimension: 2,
    label: 'X_umap',
    path: 'embeddings/0_2d.bin',
    provenance: { key: 'X_umap', columns: [0, 1] },
    origin: 'identity',
  }]);
  manager.setLayoutProvider(createMappingLayoutProvider(candidates));
  const state = {
    dimensionManager: manager,
    viewContexts: new Map(),
    viewer: { resetVectorFieldOverlay: () => { resets += 1; } },
    setVectorFieldManager(vectorManager) {
      if (failCommit && vectorManager.mapping.vectorFields.length > 1) throw new Error('publication failed');
      published.push(vectorManager);
    },
    getViewLayoutKey: viewId => manager.getViewLayout(viewId),
    viewFollowsDefault: () => true,
    async setViewRepresentation() {},
  };
  installDataMappingMethods(state, { mapping: null });
  state.publishDatasetMapping({
    mapping: {
      kind: 'anndata',
      embeddings: { enabled: [UMAP], defaults: { '1d': null, '2d': UMAP, '3d': null } },
      knn: null,
      geneNames: 'index',
      expression: 'X',
      latent: null,
      vectorFields: [{ key: 'velocity_umap_2d', embedding: UMAP }],
    },
    candidates,
    origin: 'default',
  });
  state.setMappingRuntime({
    getBaseUrl: () => BASE,
    createVectorFieldManager: mapping => {
      const manager = { mapping };
      created.push(manager);
      return manager;
    },
    resetGeneAnalysis: () => {},
    getConnectivityGraph: () => ({ manifest: null, manifestUrl: null }),
    replaceConnectivityGraph: () => {},
  });
  return { state, created, published, resets: () => resets };
}

test('vector fields: each embedding lists the arrays that fit it, the ones named for it first', () => {
  const { state } = makeVectorState();
  const mapping = state.getDataMapping();
  assert.equal(state.canChangeMappingGroup('vectorFields'), true);
  const umap = { key: 'X_umap', columns: [0, 1] };
  const pca = { key: 'X_pca', columns: [2, 3] };
  assert.deepEqual(state.getVectorBindingChoices(mapping), [{
    embeddingKey: 'X_umap',
    label: 'X_umap',
    options: [
      { binding: { key: 'velocity_umap_2d', embedding: umap }, label: 'velocity_umap_2d', usable: true, reason: null, suggested: true },
    ],
  }]);
  // A staged embedding is listed too: velocity_pca is read at its columns.
  const staged = {
    ...mapping,
    embeddings: { enabled: [pca, umap], defaults: { '1d': null, '2d': pca, '3d': null } },
  };
  assert.deepEqual(state.getVectorBindingChoices(staged).map(entry => [entry.embeddingKey, entry.options.map(option => [option.label, option.suggested])]), [
    ['X_pca[2,3]', [['velocity_pca', true], ['velocity_umap_2d', false]]],
    ['X_umap', [['velocity_umap_2d', true]]],
  ]);
  // A binding that cannot be drawn is refused by name; drift is 3 wide.
  assert.equal(
    state.describeDataMappingRefusal({
      ...mapping,
      vectorFields: [{ key: 'drift', embedding: umap }],
    }),
    "This mapping uses obsm['drift'] on X_umap[0,1] as its vector fields, which this dataset cannot use "
      + "(obsm['drift'] has 3 columns; it needs 2, or 2 like obsm['X_umap'])."
  );
});

test('vector fields: a new set of bindings replaces the manager in the transaction, and rolls back', async t => {
  const { state, created, published, resets } = makeVectorState();
  const before = state.getDataMapping();
  assert.equal(await state.applyDataMapping({ ...before, vectorFields: [] }, { origin: 'user' }), true);
  // One manager is built for the new bindings and published; the overlay's
  // uploaded vectors are dropped with the old one.
  assert.deepEqual(created.map(manager => manager.mapping.vectorFields), [[]]);
  assert.deepEqual(published, [created[0]]);
  assert.equal(resets(), 1);
  assert.deepEqual(state.getDataMapping().vectorFields, []);

  // A later group that fails puts back a manager for the bindings before.
  installServer(t);
  const failing = makeVectorState();
  failing.state.setMappingRuntime({
    ...failing.state._mappingRuntime,
    replaceConnectivityGraph() {
      throw new Error('graph publication failed');
    },
  });
  const original = failing.state.getDataMapping();
  await assert.rejects(
    failing.state.applyDataMapping({ ...original, vectorFields: [], knn: 'connectivities' }, { origin: 'user' }),
    /graph publication failed/
  );
  assert.equal(failing.state.getDataMapping(), original);
  assert.deepEqual(
    failing.published.map(manager => manager.mapping.vectorFields),
    [[], original.vectorFields]
  );
  assert.equal(failing.resets(), 2);
});
