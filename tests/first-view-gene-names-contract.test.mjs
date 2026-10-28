/**
 * The first view of a dataset never waits for gene names
 * (`BaseAnnDataAdapter.guessGeneNames`, `DataState.listPublishedGenes`).
 *
 * Opening, the dataset identity and the generation a dataset is published
 * with read no gene name: the identity counts the genes from metadata, and
 * the mapping's gene names are pending (null), never the var index in their
 * place. Right after the first view the gene list is read: the shown axis's
 * names are guessed (the CELLxGENE shape: Ensembl ids in the index, symbols
 * in `var['feature_name']`), installed with the mapping's gene names, and
 * the pending state ends. Only the axis shown is guessed; another one is
 * guessed when it is first chosen, and a reading of the same store with
 * other cells keeps the guesses.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createMappingLayoutProvider } from '../assets/js/app/state/managers/mapping-manager.js';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { loadDatasetGeneration, loadMappingCandidates } from '../assets/js/data/data-loaders.js';
import { getDataSourceManager } from '../assets/js/data/data-source-manager.js';
import { DimensionManager } from '../assets/js/data/dimension-manager.js';
import { MAPPING_CANDIDATES_ROUTE, resolveAnnDataMapping } from '../assets/js/data/dataset-mapping.js';
import { getReadActivityLog } from '../assets/js/data/read-activity-log.js';

const FIXTURES = new URL('./fixtures/gene-read/', import.meta.url);
const EXPECTED = JSON.parse(readFileSync(new URL('cellxgene-shaped.expected.json', FIXTURES), 'utf8'));
const BYTES = new Uint8Array(readFileSync(new URL('cellxgene-shaped.h5ad', FIXTURES)));
const DATASET_ID = 'first-view-genes';
const BASE = `anndata://${DATASET_ID}/`;

/** The gene-name reads of the activity log, by label. */
const nameReads = () => getReadActivityLog().entries().filter(entry => entry.kind === 'names').map(entry => entry.label);

function quiet(t) {
  const { log, warn, info } = console;
  console.log = () => {};
  console.warn = () => {};
  console.info = () => {};
  t.after(() => Object.assign(console, { log, warn, info }));
}

/** The CELLxGENE-shaped file opened, as the app opens it, and made active. */
async function openActive(t) {
  quiet(t);
  getReadActivityLog().clear();
  const source = new AnnDataFileSource();
  await source.loadFile(new File([BYTES], 'hlca.h5ad'), { datasetId: DATASET_ID });
  const manager = getDataSourceManager();
  const previous = { activeSource: manager.activeSource, activeDatasetId: manager.activeDatasetId };
  manager.activeSource = source;
  manager.activeDatasetId = DATASET_ID;
  t.after(() => {
    manager.activeSource = previous.activeSource;
    manager.activeDatasetId = previous.activeDatasetId;
    source.clear();
  });
  return source;
}

/** Everything the first view is staged from (`app/main.js` `stageDatasetRuntime`). */
async function stageFirstView() {
  const signal = new AbortController().signal;
  const generation = await loadDatasetGeneration(BASE, { expectedIdentityId: DATASET_ID, signal });
  const candidates = await loadMappingCandidates(`${BASE}${MAPPING_CANDIDATES_ROUTE}`, { signal });
  return { generation, candidates, mapping: resolveAnnDataMapping(candidates, generation.identity) };
}

/** A DataState with the staged dataset published, its gene list pending. */
function publish({ generation, candidates, mapping }) {
  const state = new DataState(null, null);
  state.viewer = new Proxy({ getViewLayout: () => ({ mode: 'grid' }) }, {
    get(target, property) {
      return Object.hasOwn(target, property) ? target[property] : () => {};
    },
  });
  state.pointCount = generation.identity.stats.n_cells;
  const dimensionManager = new DimensionManager({ baseUrl: BASE });
  dimensionManager.initFromMetadata(generation.identity.embeddings);
  dimensionManager.setLayoutProvider(createMappingLayoutProvider(candidates));
  dimensionManager.publishCellCount(generation.identity.stats.n_cells);
  state.setDimensionManager(dimensionManager);
  state.initVarData({ fields: [] });
  state.beginGeneListing(generation.identity.stats.n_genes > 0);
  state._resetViewContexts();
  state.publishDatasetMapping({ mapping, candidates, origin: 'default' });
  state.setMappingRuntime({
    getBaseUrl: () => BASE,
    createVectorFieldManager: () => { throw new Error('not exercised'); },
    getConnectivityGraph: () => ({ summary: null, url: null, edges: null }),
    replaceConnectivityGraph: () => { throw new Error('not exercised'); },
    resetGeneAnalysis: () => {},
  });
  const events = [];
  for (const name of ['mapping:changed', 'genes:listed', 'mapping:choices-changed']) {
    state.on(name, payload => events.push([name, payload]));
  }
  return { state, events };
}

test('the first view reads no gene name: opening, the identity and the generation', async t => {
  await openActive(t);
  const { generation, candidates, mapping } = await stageFirstView();
  assert.deepEqual(nameReads(), [], 'no gene name is read before the first view');
  // The gene count is metadata.
  assert.equal(generation.identity.stats.n_genes, EXPECTED.n_vars);
  assert.equal(Object.hasOwn(generation, 'geneList'), false);
  // Pending, never the index in their place.
  assert.equal(candidates.defaults.geneNames, null);
  assert.deepEqual(candidates.geneNameColumns, {});
  assert.equal(candidates.guessed.includes('geneNames'), false);
  assert.equal(mapping.geneNames, null);
  assert.equal(mapping.expression, 'X');
});

test('after the first view the shown axis is guessed and its gene list replaces the pending state', async t => {
  await openActive(t);
  const { state, events } = publish(await stageFirstView());
  // Published, pending: nothing lists the index meanwhile.
  assert.equal(state.areGenesPending(), true);
  assert.equal(state.getDataMapping().geneNames, null);
  assert.deepEqual(state.varData.fields, []);
  let waited = false;
  const waiting = state.whenGenesListed().then(() => { waited = true; });
  const matrix = state.openExpressionMatrix('raw');

  await state.listPublishedGenes();
  await waiting;
  assert.equal(waited, true);
  assert.equal(state.areGenesPending(), false);
  assert.equal(state.getGeneListFailure(), null);
  // The symbols name the genes, their ids beside them: never the index.
  assert.equal(state.getDataMapping().geneNames, 'column:feature_name');
  assert.deepEqual(state.varData.fields.map(field => field.key), EXPECTED.symbols);
  assert.deepEqual(state.varData.geneNames.ids, EXPECTED.ids);
  assert.equal(state.getMappingCandidates().defaults.geneNames, 'column:feature_name');
  assert.deepEqual(state.getGuessedMappingGroups(), ['geneNames']);
  // Only the shown axis (X's var) was read and guessed; raw.var was not.
  assert.deepEqual(nameReads(), ['gene names of var', "gene names from var['feature_name']"]);
  assert.deepEqual(state.getMappingCandidates().geneNameColumns, { X: 'feature_name' });
  // One report of the mapping, as the notebook learns it: complete.
  assert.deepEqual(events.map(([name]) => name), ['mapping:changed', 'genes:listed']);
  assert.equal(events[0][1].cause, 'genes-listed');
  assert.equal(events[0][1].origin, 'default');
  assert.equal(events[0][1].mapping.geneNames, 'column:feature_name');
  // An analysis matrix opened meanwhile waited, and is named as the mapping says.
  const opened = await matrix;
  assert.equal(opened.fields[0].key, EXPECTED.symbols[0]);
});

test('another axis is guessed when it is first chosen, on its own', async t => {
  await openActive(t);
  const { state, events } = publish(await stageFirstView());
  await state.listPublishedGenes();
  events.length = 0;
  assert.equal(state.geneNamesDefault(null, 'raw'), null, 'raw is not guessed yet: pending');
  assert.equal(await state.guessGeneNames(null, 'raw'), 'column:feature_name');
  assert.equal(state.geneNamesDefault(null, 'raw'), 'column:feature_name');
  assert.deepEqual(state.getMappingCandidates().geneNameColumns, { X: 'feature_name', raw: 'feature_name' });
  assert.deepEqual(events.map(([name]) => name), ['mapping:choices-changed']);
  assert.ok(nameReads().includes('gene names of raw.var'));
  // The mapping in use is untouched.
  assert.equal(state.getDataMapping().geneNames, 'column:feature_name');
  assert.equal(state.getDataMapping().expression, 'X');
});

test('a mapping change waits for the gene names, then compares a complete mapping', async t => {
  await openActive(t);
  const { state } = publish(await stageFirstView());
  const next = { ...state.getDataMapping(), geneNames: 'index' };
  const applied = state.applyDataMapping(next, { origin: 'user' });
  await state.listPublishedGenes();
  assert.equal(await applied, true);
  assert.equal(state.getDataMapping().geneNames, 'index');
  assert.equal(state.varData.fields[0].key, EXPECTED.ids[0]);
});

test('a reading of the same store with other cells keeps the guesses', async t => {
  const source = await openActive(t);
  await source.getAdapter().getGeneList();
  const reads = nameReads().length;
  const adapter = source.getAdapter();
  const again = new BaseAnnDataAdapter(adapter._loader, { geneNameGuesses: adapter.geneNameGuesses() });
  t.after(() => again.release());
  await again.initialize({ firstView: false });
  assert.equal(again.getMappingCandidates().defaults.geneNames, 'column:feature_name');
  assert.equal(nameReads().length, reads, 'nothing is read again');
});

test('a gene list that cannot be read says why, and a dataset replaced first supersedes it', async t => {
  quiet(t);
  const manager = getDataSourceManager();
  const previous = { activeSource: manager.activeSource, activeDatasetId: manager.activeDatasetId };
  t.after(() => {
    manager.activeSource = previous.activeSource;
    manager.activeDatasetId = previous.activeDatasetId;
  });
  const failing = {
    getGeneList: async () => { throw new Error('the var index could not be read'); },
  };
  manager.activeSource = { getType: () => 'anndata', datasetId: DATASET_ID, getAdapter: () => failing };
  manager.activeDatasetId = DATASET_ID;
  const state = new DataState(null, null);
  state.pointCount = 3;
  state.dataMapping = null;
  state.setMappingRuntime({
    getBaseUrl: () => BASE,
    createVectorFieldManager: () => null,
    getConnectivityGraph: () => null,
    replaceConnectivityGraph: () => {},
    resetGeneAnalysis: () => {},
  });
  state.dataMapping = Object.freeze({ kind: 'anndata', expression: 'X', geneNames: null });
  state._mappingCandidates = { modalities: null, var: { n_vars: 3 }, raw: null, kind: 'anndata' };
  const listed = [];
  state.on('genes:listed', payload => listed.push(payload));
  state.beginGeneListing(true);
  const waiting = state.whenGenesListed();
  await assert.rejects(state.listPublishedGenes(), /the var index could not be read/);
  await assert.rejects(waiting, /the var index could not be read/);
  assert.equal(state.areGenesPending(), false);
  assert.match(state.getGeneListFailure().message, /the var index could not be read/);
  assert.equal(listed.length, 1);
  assert.match(listed[0].failure.message, /could not be read/);

  // Another dataset published while one is pending supersedes its waiters.
  state.beginGeneListing(true);
  const superseded = state.whenGenesListed();
  state.beginGeneListing(false);
  await assert.rejects(superseded, { name: 'AbortError' });
  assert.equal(state.areGenesPending(), false);
  await state.whenGenesListed();
});
