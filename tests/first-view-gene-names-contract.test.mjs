/**
 * The first view of a dataset never waits for gene names
 * (`DataState.listPublishedGenes`).
 *
 * Opening, the dataset identity and the generation a dataset is published
 * with read no gene name: the identity counts the genes from metadata, and
 * the mapping names the genes by the var index. Right after the first view
 * the gene list is read -- the var index of the shown matrix, and nothing
 * else (a CELLxGENE-shaped file: Ensembl ids in the index, symbols in
 * `var['feature_name']`, which is read only when Data mapping chooses it) --
 * and the pending state ends.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createMappingLayoutProvider } from '../assets/js/app/state/managers/mapping-manager.js';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import { loadDatasetGeneration, loadMappingCandidates } from '../assets/js/data/data-loaders.js';
import { getDataSourceManager } from '../assets/js/data/data-source-manager.js';
import { DimensionManager } from '../assets/js/data/dimension-manager.js';
import { MAPPING_CANDIDATES_ROUTE, resolveAnnDataMapping } from '../assets/js/data/dataset-mapping.js';
import { getReadActivityLog } from '../assets/js/data/read-activity-log.js';
import { recordReadActivities } from './helpers/read-activities.mjs';
import { beginCellsChange, cellWorkRunning, cellWorkSettled } from '../assets/js/data/open-cells-work.js';

const FIXTURES = new URL('./fixtures/gene-read/', import.meta.url);
const EXPECTED = JSON.parse(readFileSync(new URL('cellxgene-shaped.expected.json', FIXTURES), 'utf8'));
const BYTES = new Uint8Array(readFileSync(new URL('cellxgene-shaped.h5ad', FIXTURES)));
const DATASET_ID = 'first-view-genes';
const BASE = `anndata://${DATASET_ID}/`;

/** The gene-name reads the activity log told of, by label. */
const reads = recordReadActivities();
const nameReads = () => reads.all().filter(entry => entry.kind === 'names').map(entry => entry.label);

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
  reads.clear();
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
  // The var index names the genes: no column is guessed.
  assert.equal(candidates.defaults.geneNames, 'index');
  assert.equal(candidates.guessed.includes('geneNames'), false);
  assert.equal(mapping.geneNames, 'index');
  assert.equal(mapping.expression, 'X');
});

test('after the first view the var index alone is read, and its gene list replaces the pending state', async t => {
  await openActive(t);
  const { state, events } = publish(await stageFirstView());
  // Published, pending.
  assert.equal(state.areGenesPending(), true);
  assert.equal(state.getDataMapping().geneNames, 'index');
  assert.deepEqual(state.varData.fields, []);
  let waited = false;
  const waiting = state.whenGenesListed().then(() => { waited = true; });

  await state.listPublishedGenes();
  await waiting;
  assert.equal(waited, true);
  assert.equal(state.areGenesPending(), false);
  assert.equal(state.getGeneListFailure(), null);
  // The genes are named by the index; no other column is read.
  assert.equal(state.getDataMapping().geneNames, 'index');
  assert.deepEqual(state.varData.fields.map(field => field.key), EXPECTED.ids);
  assert.equal(state.varData.geneNames.ids, null);
  assert.deepEqual(state.getGuessedMappingGroups(), []);
  assert.deepEqual(nameReads(), ['gene names of var']);
  // The mapping did not change: only the list is announced.
  assert.deepEqual(events.map(([name]) => name), ['genes:listed']);
});

test('choosing a var column as gene names in Data mapping names the genes by it, the index beside them', async t => {
  await openActive(t);
  const { state } = publish(await stageFirstView());
  await state.listPublishedGenes();
  assert.equal(await state.applyDataMapping({ ...state.getDataMapping(), geneNames: 'column:feature_name' }, { origin: 'user' }), true);
  assert.equal(state.getDataMapping().geneNames, 'column:feature_name');
  assert.deepEqual(state.varData.fields.map(field => field.key), EXPECTED.symbols);
  assert.deepEqual(state.varData.geneNames.ids, EXPECTED.ids);
  assert.deepEqual(nameReads(), ['gene names of var', "gene names from var['feature_name']"]);
  // An analysis matrix opened now is named as the mapping says.
  const opened = await state.openExpressionMatrix('X');
  assert.deepEqual(opened.fields.map(field => field.key), EXPECTED.symbols);
});

test('a mapping change waits for the gene list, then applies', async t => {
  await openActive(t);
  const { state } = publish(await stageFirstView());
  const next = { ...state.getDataMapping(), geneNames: 'column:feature_name' };
  const applied = state.applyDataMapping(next, { origin: 'user' });
  await state.listPublishedGenes();
  assert.equal(await applied, true);
  assert.equal(state.getDataMapping().geneNames, 'column:feature_name');
  assert.equal(state.varData.fields[0].key, EXPECTED.symbols[0]);
});

test('a data-mapping change waits for a change of the open cells under way, and the next one waits for it', async t => {
  await openActive(t);
  const { state } = publish(await stageFirstView());
  await state.listPublishedGenes();
  const next = { ...state.getDataMapping(), geneNames: 'column:feature_name' };
  // A progressive opening growing: the change reads nothing until it ends.
  const end = beginCellsChange();
  const applied = state.applyDataMapping(next, { origin: 'user' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(nameReads(), ['gene names of var'], 'nothing is read while the open cells change');
  assert.equal(state.getDataMapping().geneNames, 'index');
  end();
  // Under way, it is work on the open cells: the next change of them waits
  // for it (`cellWorkSettled`).
  let tracked = false;
  for (let turn = 0; turn < 10_000 && !tracked; turn++) {
    tracked = cellWorkRunning();
    if (!tracked) await Promise.resolve();
  }
  assert.equal(tracked, true, 'the change is work on the open cells');
  assert.equal(await applied, true);
  await cellWorkSettled();
  assert.equal(state.getDataMapping().geneNames, 'column:feature_name');
  assert.deepEqual(state.varData.fields.map(field => field.key), EXPECTED.symbols);
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
  state.dataMapping = Object.freeze({ kind: 'anndata', expression: 'X', geneNames: 'index' });
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
