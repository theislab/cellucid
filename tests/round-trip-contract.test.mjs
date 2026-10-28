/**
 * The round trip on the viewer's side: what a person made, published to the
 * host as viewer-protocol results (`app/viewer-host-results.js`), and the
 * files the web app exports with no notebook (`app/exports/cell-exports.js`,
 * `formats/hdf5/writer.js`): an obs-name CSV, an obs-column CSV, a GMT file
 * and an `.h5ad` subset that Cellucid's own reader and Python's anndata read
 * back exactly.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createViewerHostResults } from '../assets/js/app/viewer-host-results.js';
import { DerivedResultsRegistry } from '../assets/js/app/registries/derived-results.js';
import { formatGmt, parseGmt } from '../assets/js/app/analysis/shared/gene-sets.js';
import {
  CSV_KINDS, KIND_ROW, OBS_NAME_COLUMN, columnName, csvCell, fieldCsv, highlightsCsv, highlightsH5ad,
} from '../assets/js/app/exports/cell-exports.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { orderedCellIdentity } from './helpers/ordered-cell-identity.mjs';
import { decodeViewerResult, encodeViewerBinaryFrame } from '../assets/js/data/viewer-protocol.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { openDatasetStore } from '../assets/js/data/anndata/open.js';
import { booleanAttribute, group, numericDataset, stringDataset, writeHdf5 } from '../assets/js/formats/hdf5/writer.js';

const MiB = 1024 * 1024;

/** A viewer host source that records what it sends. */
function recordingSource(shown = { dataset: 'example' }) {
  const sent = [];
  return {
    sent,
    shown,
    acceptsEvent: () => true,
    isConnected: () => true,
    getShownHostDataset: () => shown.dataset,
    notifyResult(result) {
      const { header, body } = encodeViewerResultFrame(result);
      sent.push(decodeViewerResult(encodeViewerBinaryFrame(header, body)));
      return true;
    },
    notifyResultRemoved(removal) { sent.push({ removed: removal }); return true; },
    notifyResults(inventory) { sent.push({ inventory }); return true; },
    notifyColorBy(colorBy) { sent.push({ colorBy }); return true; },
  };
}

let encodeViewerResultFrame;
test.before(async () => {
  ({ encodeViewerResult: encodeViewerResultFrame } = await import('../assets/js/data/viewer-protocol.js'));
});

/** A DataState with a highlight page of two groups and one user-defined field. */
function stateWithResults(pointCount = 6) {
  const state = new DataState({}, null);
  state.pointCount = pointCount;
  state.highlightArray = new Uint8Array(pointCount);
  state.categoryTransparency = new Uint8Array(pointCount).fill(1);
  state.obsData = { fields: [] };
  state.ensureHighlightPage();
  state.addHighlightDirect({ type: 'lasso', label: 'Lasso selection', cellIndices: Uint32Array.of(0, 2) });
  state.addHighlightDirect({ type: 'knn', label: 'Neighbours', cellIndices: Uint32Array.of(2, 4) });
  state.obsData.fields.push({
    key: 'annotation', kind: 'category', categories: ['B', 'T'], codes: Uint8Array.of(0, 1, 255, 0, 1, 0),
    loaded: true, _isUserDefined: true, _userDefinedId: 'user_cat_1', _fieldSource: 'obs', _operation: null,
  });
  state.obsData.fields.push({
    key: 'score', kind: 'continuous', values: Float32Array.of(0.5, NaN, 1, 2, 3, 4), loaded: true,
  });
  return state;
}

test('every result reaches the host once, in original positions, and only what changed goes again', async () => {
  const state = stateWithResults();
  // A subsample: the 6 open cells are rows 1, 3, 5, 7, 9, 11 of 12.
  const identity = createCellIdentity({ nObs: 12, kept: Uint32Array.of(1, 3, 5, 7, 9, 11) });
  const source = recordingSource();
  const results = createViewerHostResults({ state, viewerHostSource: source, getCellIdentity: () => identity });
  await results.resync();
  const sent = source.sent.filter(item => item.header);
  const byId = Object.fromEntries(sent.map(item => [item.header.id, item]));
  assert.deepEqual(Object.keys(byId).sort(), ['highlight_1', 'highlight_2', 'open', 'user_cat_1', 'visible']);
  assert.deepEqual([...byId.highlight_1.cells], [1, 5]);
  assert.deepEqual([...byId.highlight_2.cells], [5, 9]);
  assert.equal(byId.highlight_2.header.meta.tool, 'knn');
  assert.deepEqual([...byId.open.cells], [1, 3, 5, 7, 9, 11]);
  assert.deepEqual([...byId.user_cat_1.cells], [1, 3, 5, 7, 9, 11]);
  assert.deepEqual([...byId.user_cat_1.values], [0, 1, 255, 0, 1, 0]);
  assert.deepEqual([...byId.visible.cells], [1, 3, 5, 7, 9, 11]);
  const inventory = source.sent.find(item => item.inventory).inventory;
  assert.equal(inventory.nObs, 12);
  assert.equal(inventory.items.length, 5);
  const revisions = sent.map(item => item.header.revision);
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b));

  // A removed group is one removal; nothing else is sent again.
  source.sent.length = 0;
  state.removeHighlightGroup('highlight_1');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(source.sent.map(item => item.removed?.id ?? item.header?.id ?? 'other'), ['highlight_1']);

  // The snapshot again (the channel opened again): every result, then the inventory.
  source.sent.length = 0;
  await results.resync();
  const again = source.sent.filter(item => item.header);
  assert.equal(again.length, 4);
  assert.ok(again.every(item => item.header.requestId === null));
  assert.equal(source.sent.at(-1).inventory.items.length, again.length);

  // A field a session restore left unread is read in the background, then sent.
  source.sent.length = 0;
  let read = 0;
  state.obsData.fields.push({
    key: 'restored', kind: 'category', categories: ['x'], codes: null, loaded: false,
    _isUserDefined: true, _userDefinedId: 'user_cat_2', _fieldSource: 'obs', _operation: null,
  });
  state.ensureFieldLoaded = async index => {
    read += 1;
    Object.assign(state.obsData.fields[index], { codes: new Uint8Array(6), loaded: true });
  };
  state.emit('field:changed', {});
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(read, 1);
  assert.deepEqual(source.sent.filter(item => item.header).map(item => item.header.id), ['user_cat_2']);
  results.dispose();
});

test('a dataset whose open cells are in priority order sends its results in original positions, ascending', async () => {
  const state = stateWithResults();
  // Every cell open, in priority order: open cell i is original position openOrder[i]
  // (a store a kernel serves, or a file prepare() wrote).
  const openOrder = Uint32Array.of(4, 0, 5, 2, 1, 3);
  const source = recordingSource();
  const results = createViewerHostResults({
    state, viewerHostSource: source, getCellIdentity: () => createCellIdentity({ nObs: 6, openOrder }),
  });
  await results.resync();
  const byId = Object.fromEntries(source.sent.filter(item => item.header).map(item => [item.header.id, item]));
  // Lasso on open cells 0 and 2 = original cells 4 and 5.
  assert.deepEqual([...byId.highlight_1.cells], [4, 5]);
  // Open cells 2 and 4 = original cells 5 and 1, ascending.
  assert.deepEqual([...byId.highlight_2.cells], [1, 5]);
  // Every cell open: no cell list, the values in original order.
  const codes = [0, 1, 255, 0, 1, 0];
  const want = new Array(6);
  openOrder.forEach((original, open) => { want[original] = codes[open]; });
  assert.equal(byId.user_cat_1.cells, null);
  assert.deepEqual([...byId.user_cat_1.values], want);
  results.dispose();
});

test('a subsample opened in priority order sends every result in original positions, ascending', async () => {
  const state = stateWithResults();
  // Rows 1, 3, 5, 7, 9, 11 of 12, opened in the order 11, 1, 9, 3, 7, 5.
  const identity = orderedCellIdentity({ nObs: 12, kept: [1, 3, 5, 7, 9, 11] });
  assert.deepEqual([...identity.openOrder], [11, 1, 9, 3, 7, 5]);
  state.getDerivedResults().replaceOwned('signature', {
    geneSets: [],
    scores: [{ key: 'T score', cells: Uint32Array.of(0, 1), values: Float32Array.of(0.5, -1) }],
  });
  const source = recordingSource();
  const results = createViewerHostResults({ state, viewerHostSource: source, getCellIdentity: () => identity });
  await results.resync();
  const byId = Object.fromEntries(source.sent.filter(item => item.header).map(item => [item.header.id, item]));
  // Open cells 0, 2 = rows 11, 9; open cells 2, 4 = rows 9, 7.
  assert.deepEqual([...byId.highlight_1.cells], [9, 11]);
  assert.deepEqual([...byId.highlight_2.cells], [7, 9]);
  assert.deepEqual([...byId.open.cells], [1, 3, 5, 7, 9, 11]);
  assert.deepEqual([...byId.visible.cells], [1, 3, 5, 7, 9, 11]);
  // Codes 0, 1, 255, 0, 1, 0 of open cells 0..5 (rows 11, 1, 9, 3, 7, 5), by row.
  assert.deepEqual([...byId.user_cat_1.cells], [1, 3, 5, 7, 9, 11]);
  assert.deepEqual([...byId.user_cat_1.values], [1, 0, 0, 1, 255, 0]);
  // A score of open cells 0, 1 (rows 11, 1): ascending, values with their cells.
  assert.deepEqual([...byId['signature:T score'].cells], [1, 11]);
  assert.deepEqual([...byId['signature:T score'].values], [-1, 0.5]);
  results.dispose();
});

test('each dataset a page opens is a new epoch; another dataset publishes nothing', async () => {
  const state = stateWithResults();
  const identity = createCellIdentity({ nObs: 6 });
  const source = recordingSource();
  const results = createViewerHostResults({ state, viewerHostSource: source, getCellIdentity: () => identity });
  await results.resync();
  const first = source.sent.find(item => item.inventory).inventory;
  assert.match(first.epoch, /^[0-9a-f]{16}$/);
  assert.equal(first.dataset, 'example');
  const firstResults = source.sent.filter(item => item.header);
  assert.ok(firstResults.every(item => item.header.epoch === first.epoch));
  assert.equal(Math.min(...firstResults.map(item => item.header.revision)), 1);

  // The channel opened again: the same epoch, revisions growing on.
  source.sent.length = 0;
  await results.resync();
  const reopened = source.sent.find(item => item.inventory).inventory;
  assert.equal(reopened.epoch, first.epoch);
  assert.ok(reopened.revision > first.revision);

  // The person opens another dataset in the viewer: a new epoch naming no
  // host dataset, listing nothing; no result goes while it is open.
  source.sent.length = 0;
  source.shown.dataset = null;
  await results.datasetOpened();
  assert.deepEqual(source.sent.map(item => Object.keys(item)[0]), ['inventory']);
  const foreign = source.sent[0].inventory;
  assert.notEqual(foreign.epoch, first.epoch);
  assert.equal(foreign.dataset, null);
  assert.deepEqual(foreign.items, []);
  source.sent.length = 0;
  state.addHighlightDirect({ type: 'lasso', label: 'Elsewhere', cellIndices: Uint32Array.of(1) });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(source.sent, []);
  assert.throws(() => results.answer('r1', 'highlight', 'highlight_3'), /another dataset/);

  // The host's dataset again: a third epoch, every result again from revision 1.
  source.shown.dataset = 'example';
  await results.datasetOpened();
  const back = source.sent.find(item => item.inventory).inventory;
  assert.ok(![first.epoch, foreign.epoch].includes(back.epoch));
  assert.equal(back.dataset, 'example');
  const backResults = source.sent.filter(item => item.header);
  assert.equal(Math.min(...backResults.map(item => item.header.revision)), 1);
  assert.equal(back.items.length, backResults.length);
  results.dispose();
});

test('gene sets and scores an analysis holds are results too', async () => {
  const state = stateWithResults();
  const source = recordingSource();
  const results = createViewerHostResults({
    state, viewerHostSource: source, getCellIdentity: () => createCellIdentity({ nObs: 6 }),
  });
  state.getDerivedResults().replaceOwned('signature', {
    geneSets: [{ name: 'T', description: 'Gene signature', genes: ['CD3E', 'CD3D'] }],
    scores: [{ key: 'T score', cells: Uint32Array.of(1, 3), values: Float32Array.of(0.5, -1) }],
  });
  state.getDerivedResults().upsertNotebookGeneSet({ name: 'B', description: '', genes: ['MS4A1'] });
  await results.resync();
  const byId = Object.fromEntries(source.sent.filter(item => item.header).map(item => [item.header.id, item]));
  assert.deepEqual(byId['signature:T score'].header.meta, { key: 'T score', origin: 'analysis' });
  assert.deepEqual([...byId['signature:T score'].values], [0.5, -1]);
  assert.deepEqual(byId['signature:T'].header.meta.genes, ['CD3E', 'CD3D']);
  assert.equal(byId.gene_set_1.header.meta.origin, 'notebook');
  results.dispose();
});

test('a gene set crosses by identifier, with the symbols the viewer shows (CELLxGENE-shaped var)', async () => {
  const state = stateWithResults();
  // The var index is Ensembl; the viewer shows feature_name symbols.
  state.varData = {
    fields: [{ key: 'CD3E', path: 'var/0' }, { key: 'MS4A1', path: 'var/1' }],
    geneNames: { ids: ['ENSG00000198851', 'ENSG00000156738'] },
  };
  const source = recordingSource();
  const results = createViewerHostResults({ state, viewerHostSource: source, getCellIdentity: () => createCellIdentity({ nObs: 6 }) });
  state.getDerivedResults().upsertNotebookGeneSet({ name: 'Markers', description: '', genes: ['MS4A1', 'CD3E'] });
  await results.resync();
  const set = source.sent.find(item => item.header?.kind === 'geneSet');
  assert.deepEqual(set.header.meta.genes, ['ENSG00000156738', 'ENSG00000198851']);
  assert.deepEqual(set.header.meta.symbols, ['MS4A1', 'CD3E']);
  results.dispose();
});

test('the notebook gene sets survive a session record; a repeated name is refused', () => {
  const registry = new DerivedResultsRegistry();
  registry.upsertNotebookGeneSet({ name: 'T', description: 'x', genes: ['A', 'B'] });
  registry.upsertNotebookGeneSet({ name: 'T', description: 'y', genes: ['C'] });
  assert.deepEqual(registry.toSessionRecord(), [{ name: 'T', description: 'y', genes: ['C'] }]);
  const restored = new DerivedResultsRegistry();
  restored.restoreSessionRecord(registry.toSessionRecord());
  assert.deepEqual(restored.getGeneSets().map(entry => entry.id), ['gene_set_1']);
  assert.throws(() => restored.restoreSessionRecord([{ name: 'A', description: '', genes: [] }, { name: 'A', description: '', genes: [] }]), /twice/);
  assert.throws(() => registry.upsertNotebookGeneSet({ name: 'X', description: '', genes: ['A', 'A'] }), /twice/);
});

test('GMT files are written as parseGmt (and Python and R) read them', () => {
  const text = formatGmt([
    { name: 'T\tcells', description: 'markers', genes: ['CD3E', 'CD3D', 'CD3E'] },
    { name: 'B', genes: ['MS4A1'] },
    // Reads as the first one's name once cleaned: written as its own.
    { name: 'T\r\ncells', description: '', genes: ['CD2'] },
    { name: 'a  b', genes: ['X'] },
  ]);
  assert.equal(text, 'T cells\tmarkers\tCD3E\tCD3D\nB\t\tMS4A1\nT cells (2)\t\tCD2\na  b\t\tX\n');
  assert.deepEqual(parseGmt(text).map(set => set.name), ['T cells', 'B', 'T cells (2)', 'a  b']);
});

/** A fixture the web app, Python and R read alike, pinned by its digest. */
function sharedFixture(name, digest) {
  const bytes = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, `${name} changed: update it in all three repositories`);
  return bytes.toString('utf8');
}

test('the shared GMT fixture reads as Python and R read it', () => {
  const text = sharedFixture('gene-sets.gmt', '071d3e007164ff4d9c311820ba3a1be3061b7fd4b80e59142df17690c37b8bfd');
  assert.deepEqual(parseGmt(text), [
    { name: 'T cells', description: 'markers', genes: ['CD3E', 'CD3D'] },
    { name: 'Set 2', description: '', genes: ['X'] },
    { name: 'T cells (2)', description: 'again', genes: ['CD2'] },
    { name: 'B', description: '', genes: ['MS4A1'] },
  ]);
});

test('the shared obs-column CSV fixture is the format the web app writes', () => {
  const text = sharedFixture('obs-columns.csv', 'b0da8ee441532a3ac2199e9e22f827c82002c4e63ce1b7bec5fc3d4800ec41e9');
  const [header, kinds] = text.split('\n');
  assert.equal(header.split(',')[0], OBS_NAME_COLUMN);
  assert.deepEqual(kinds.split(','), [KIND_ROW, 'highlight', 'categorical', 'categorical', 'continuous']);
  assert.ok(kinds.split(',').slice(1).every(kind => CSV_KINDS.includes(kind)));
});

/** An adapter of the open cells: their names, two genes' rows, one embedding. */
function fakeAdapter() {
  const names = ['c0', 'c,1', 'c2', 'c3', 'c4', 'c5'];
  return {
    getObsNames: async () => names,
    getMatrixRowsOf: async (_path, cells) => Array.from(cells, cell => ({
      genes: cell % 2 === 0 ? Int32Array.of(1, 0) : Int32Array.of(1),
      values: cell % 2 === 0 ? Float32Array.of(cell + 0.5, cell) : Float32Array.of(cell + 0.5),
    })),
    getObsmColumns: async () => Float32Array.from({ length: 12 }, (_, i) => i),
  };
}

function withExportState(identity = createCellIdentity({ nObs: 6 })) {
  const state = stateWithResults();
  state.cellIdentity = identity;
  state.ensureFieldLoaded = async index => state.obsData.fields[index];
  state.varData = { fields: [{ key: 'GENE_A', path: 'var/0' }, { key: 'GENE_B', path: 'var/1' }] };
  state.dataMapping = { embeddings: { enabled: [{ key: 'X_umap', columns: [0, 1] }] } };
  state.getDataMapping = () => state.dataMapping;
  return state;
}

test('the highlighted cells and a field export as obs-column CSV, names quoted', async () => {
  const state = withExportState();
  const adapter = fakeAdapter();
  const cells = await highlightsCsv({ state, adapter, pageId: state.getActivePageId() });
  // Every open cell, each group a declared highlight column.
  assert.equal(await cells.blob.text(), [
    'obs_name,cellucid_highlight__highlight_1,cellucid_highlight__highlight_2',
    'kind,highlight,highlight',
    'c0,true,false',
    '"c,1",false,false',
    'c2,true,true',
    'c3,false,false',
    'c4,false,true',
    'c5,false,false',
    '',
  ].join('\n'));
  const field = await fieldCsv({ state, adapter, fieldIndex: 0 });
  assert.equal(await field.blob.text(), 'obs_name,annotation\nkind,categorical\nc0,B\n"c,1",T\nc2,\nc3,B\nc4,T\nc5,B\n');
  const score = await fieldCsv({ state, adapter, fieldIndex: 1 });
  assert.equal(await score.blob.text(), 'obs_name,score\nkind,continuous\nc0,0.5\n"c,1",\nc2,1\nc3,2\nc4,3\nc5,4\n');
  assert.equal(field.filename, 'annotation.csv');
  assert.equal(csvCell('a"b'), '"a""b"');
});

test('every export lists cells ascending by original position, whatever order they are open in', async () => {
  // Every cell open in priority order: open cell i is original position openOrder[i].
  const identity = orderedCellIdentity({ nObs: 6 });
  const openOrder = [...identity.openOrder];
  assert.deepEqual(openOrder, [5, 0, 4, 1, 3, 2]);
  const state = withExportState(identity);
  const adapter = { ...fakeAdapter(), getObsNames: async () => openOrder.map(p => `cell${p}`) };
  // Highlight 1 holds open cells 0 and 2 (cells 5 and 4), highlight 2 open cells 2 and 4 (cells 4 and 3).
  const cells = await highlightsCsv({ state, adapter, pageId: state.getActivePageId() });
  assert.equal(await cells.blob.text(), [
    'obs_name,cellucid_highlight__highlight_1,cellucid_highlight__highlight_2',
    'kind,highlight,highlight',
    'cell0,false,false',
    'cell1,false,false',
    'cell2,false,false',
    'cell3,false,true',
    'cell4,true,true',
    'cell5,true,false',
    '',
  ].join('\n'));
  // The annotation's codes are in open order: B T - B T B for cells 5 0 4 1 3 2.
  const field = await fieldCsv({ state, adapter, fieldIndex: 0 });
  assert.equal(await field.blob.text(), 'obs_name,annotation\nkind,categorical\ncell0,T\ncell1,B\ncell2,B\ncell3,T\ncell4,\ncell5,B\n');
  const made = await highlightsH5ad({ state, adapter, pageId: state.getActivePageId() });
  const reader = await readH5ad(new Uint8Array(await made.blob.arrayBuffer()));
  assert.deepEqual(await reader.readObsNames(), ['cell3', 'cell4', 'cell5']);
  // Matrix rows follow their cells: the fake rows carry the open position + 0.5.
  const rows = await reader.getMatrixRows('X', Uint32Array.of(0, 1, 2));
  assert.deepEqual(rows.map(row => row.values.at(-1)), [4.5, 2.5, 0.5]);
  reader.close();
});

test('an .h5ad names its genes by identifier, the shown name beside it', async () => {
  const state = withExportState();
  state.varData = {
    fields: [{ key: 'CD3E', path: 'var/0' }, { key: 'MS4A1', path: 'var/1' }],
    geneNames: { ids: ['ENSG00000198851', 'ENSG00000156738'] },
  };
  const made = await highlightsH5ad({ state, adapter: fakeAdapter(), pageId: state.getActivePageId() });
  const reader = await readH5ad(new Uint8Array(await made.blob.arrayBuffer()));
  assert.deepEqual((await reader.readVarNames('X', null)).index, ['ENSG00000198851', 'ENSG00000156738']);
  reader.close();
});

async function readH5ad(bytes) {
  const file = new File([bytes], 'subset.h5ad');
  const opened = await openDatasetStore({ source: { file } }, { decodedChunkCacheBytes: 16 * MiB });
  const reader = new AnnDataReader();
  await reader.open(opened.root, { format: opened.readerFormat, name: opened.name });
  return reader;
}

test('an .h5ad subset is read back exactly by Cellucid\'s own reader', async () => {
  const state = withExportState();
  const made = await highlightsH5ad({ state, adapter: fakeAdapter(), pageId: state.getActivePageId() });
  assert.equal(made.cells, 3);
  const bytes = new Uint8Array(await made.blob.arrayBuffer());
  const reader = await readH5ad(bytes);
  assert.equal(reader.nObs, 3);
  assert.deepEqual((await reader.readVarNames('X', null)).index, ['GENE_A', 'GENE_B']);
  assert.deepEqual(await reader.readObsNames(), ['c0', 'c2', 'c4']);
  assert.deepEqual(reader.obsKeys, ['annotation', 'score', 'cellucid_highlight__highlight_1', 'cellucid_highlight__highlight_2']);
  const rows = await reader.getMatrixRows('X', Uint32Array.of(0, 1, 2));
  assert.deepEqual(rows.map(row => [...row.genes]), [[0, 1], [0, 1], [0, 1]]);
  assert.deepEqual(rows.map(row => [...row.values]), [[0, 0.5], [2, 2.5], [4, 4.5]]);
  const umap = await reader.readObsmColumns('X_umap', [0, 1]);
  assert.deepEqual([...umap], [0, 1, 4, 5, 8, 9]);
  reader.close();

  // anndata reads it too, when this machine has it (the workspace's
  // Python environment, or any python3 with anndata).
  const python = [
    path.resolve(process.cwd(), '../.environments/python/venv/bin/python'),
    'python3',
  ].find(candidate => {
    if (candidate.includes('/') && !existsSync(candidate)) return false;
    return spawnSync(candidate, ['-c', 'import anndata'], { encoding: 'utf8' }).status === 0;
  });
  if (python === undefined) return;
  const folder = mkdtempSync(path.join(tmpdir(), 'cellucid-h5ad-'));
  const file = path.join(folder, 'subset.h5ad');
  writeFileSync(file, bytes);
  const script = [
    'import json, sys, anndata',
    'a = anndata.read_h5ad(sys.argv[1])',
    'print(json.dumps({"obs_names": list(a.obs_names), "annotation": [None if v != v else v for v in a.obs["annotation"].astype(object)],',
    ' "categories": list(a.obs["annotation"].cat.categories), "h1": [bool(v) for v in a.obs["cellucid_highlight__highlight_1"]],',
    ' "X": a.X.toarray().tolist(), "var": list(a.var_names), "umap": a.obsm["X_umap"].tolist()}))',
  ].join('\n');
  const run = spawnSync(python, ['-c', script, file], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    obs_names: ['c0', 'c2', 'c4'],
    annotation: ['B', null, 'T'],
    categories: ['B', 'T'],
    h1: [true, true, false],
    X: [[0, 0.5], [2, 2.5], [4, 4.5]],
    var: ['GENE_A', 'GENE_B'],
    umap: [[0, 1], [4, 5], [8, 9]],
  });
});

test('an .h5ad keeps float64 fields as float64 and says which keys it renamed', async () => {
  const state = withExportState();
  state.obsData.fields.push(
    { key: '.', kind: 'continuous', values: Float64Array.of(0.1, 0.2, 0.3, 0.4, 0.5, 0.6), loaded: true },
    { key: 'a/b', kind: 'continuous', values: Float64Array.of(1, 2, 3, 4, 5, 6), loaded: true },
  );
  const made = await highlightsH5ad({ state, adapter: fakeAdapter(), pageId: state.getActivePageId() });
  assert.deepEqual(made.renamed, [{ key: '.', name: '_' }, { key: 'a/b', name: 'a_b' }]);
  const reader = await readH5ad(new Uint8Array(await made.blob.arrayBuffer()));
  assert.ok(reader.obsKeys.includes('_') && reader.obsKeys.includes('a_b'));
  reader.close();
  assert.equal(columnName('x', new Set(['x'])), 'x_2');
});

test('an attribute larger than a header message is written in dense storage, read by every reader', async () => {
  // 10,000 columns: a column-order attribute of 160 kB, past the 65,535
  // bytes one object header message holds.
  const encoding = (type, version) => ({ 'encoding-type': type, 'encoding-version': version });
  const columns = Array.from({ length: 10_000 }, (_, i) => [
    `column_${i}`, numericDataset('float32', [3], Float32Array.of(i, i + 0.5, -i), encoding('array', '0.2.0')),
  ]);
  const blob = writeHdf5(group(encoding('anndata', '0.1.0'), [
    ['obs', group({ ...encoding('dataframe', '0.2.0'), _index: '_index', 'column-order': columns.map(([name]) => name) }, [
      ['_index', stringDataset(['a', 'b', 'c'], encoding('string-array', '0.2.0'))], ...columns,
    ])],
    ['var', group({ ...encoding('dataframe', '0.2.0'), _index: '_index', 'column-order': [] }, [
      ['_index', stringDataset(['g'], encoding('string-array', '0.2.0'))],
    ])],
  ]));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const reader = await readH5ad(bytes);
  assert.equal(reader.obsKeys.length, 10_000);
  assert.equal(reader.obsKeys[9_999], 'column_9999');
  assert.deepEqual(await reader.readObsNames(), ['a', 'b', 'c']);
  reader.close();

  const folder = mkdtempSync(path.join(tmpdir(), 'cellucid-dense-'));
  const file = path.join(folder, 'wide.h5ad');
  writeFileSync(file, bytes);
  const python = [path.resolve(process.cwd(), '../.environments/python/venv/bin/python'), 'python3'].find(candidate => {
    if (candidate.includes('/') && !existsSync(candidate)) return false;
    return spawnSync(candidate, ['-c', 'import anndata, h5py'], { encoding: 'utf8' }).status === 0;
  });
  if (python !== undefined) {
    const run = spawnSync(python, ['-c', [
      'import sys, anndata',
      'a = anndata.read_h5ad(sys.argv[1])',
      'print(a.obs.shape[1], a.obs.columns[-1], a.obs["column_9999"].tolist(), list(a.obs_names))',
    ].join('\n'), file], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "10000 column_9999 [9999.0, 9999.5, -9999.0] ['a', 'b', 'c']");
  }
  const dump = spawnSync('h5dump', ['-A', '-g', '/obs', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (dump.error === undefined) {
    assert.equal(dump.status, 0, dump.stderr);
    assert.match(dump.stdout, /DATASPACE {2}SIMPLE \{ \( 10000 \) \/ \( 10000 \) \}/);
    assert.match(dump.stdout, /"column_9999"/);
  }
});

test('the HDF5 writer writes strings past one heap collection and refuses what it cannot write', async () => {
  const many = Array.from({ length: 70_000 }, (_, i) => `cell_${i}`);
  const blob = writeHdf5(group({ 'encoding-type': 'anndata', 'encoding-version': '0.1.0' }, [
    ['obs', group({ 'encoding-type': 'dataframe', 'encoding-version': '0.2.0', _index: '_index', 'column-order': [] }, [
      ['_index', stringDataset(many, { 'encoding-type': 'string-array', 'encoding-version': '0.2.0' })],
    ])],
    ['var', group({ 'encoding-type': 'dataframe', 'encoding-version': '0.2.0', _index: '_index', 'column-order': [] }, [
      ['_index', stringDataset([], { 'encoding-type': 'string-array', 'encoding-version': '0.2.0' })],
    ])],
  ]));
  const reader = await readH5ad(new Uint8Array(await blob.arrayBuffer()));
  const names = await reader.readObsNames();
  assert.equal(names.length, 70_000);
  assert.equal(names[69_999], 'cell_69999');
  reader.close();
  assert.throws(() => numericDataset('float32', [3], new Float32Array(2)), /holds 12 bytes, not 8/);
  assert.throws(() => group({}, [['a/b', group()]]), /without "\/"/);
  assert.throws(() => writeHdf5(group({ bad: 1 })), /Attribute "bad"/);
  assert.ok(booleanAttribute(true));
});

test('a pushed column is a field holding its own values: replaced in place, saved and restored with the session', async () => {
  const { capture, restore } = await import('../assets/js/app/session/contributors/user-defined-values.js');
  const state = new DataState({}, null);
  state.pointCount = 4;
  state.obsData = { fields: [] };
  state.varData = { fields: [] };
  state.colorsArray = new Uint8Array(16);
  state.categoryTransparency = new Uint8Array(4).fill(1);
  state.cellVisibilityMask = new Uint8Array(4).fill(1);
  const operation = { type: 'notebook-push' };
  const made = state.upsertUserDefinedContinuousField({ key: 'score', values: Float32Array.of(1, NaN, 2, 3), operation });
  assert.equal(made.updatedInPlace, false);
  const again = state.upsertUserDefinedContinuousField({ key: 'score', values: Float32Array.of(4, 5, 6, 7), operation });
  assert.deepEqual([again.fieldId, again.updatedInPlace], [made.fieldId, true]);
  assert.deepEqual([...state.getFields()[0].values], [4, 5, 6, 7]);
  state.obsData.fields.push({ key: 'cell_type', kind: 'continuous', values: new Float32Array(4), loaded: true });
  assert.throws(
    () => state.upsertUserDefinedContinuousField({ key: 'cell_type', values: new Float32Array(4), operation }),
    /exists already/
  );

  const meta = state.getUserDefinedFieldsRegistry().toSessionMeta();
  assert.deepEqual(
    Object.keys(meta[0]).sort(),
    ['createdAt', 'id', 'isDeleted', 'isPurged', 'key', 'kind', 'operation', 'source', 'sourceField', 'valuesLength', 'valuesType']
  );
  const [chunk] = capture({ state });
  assert.equal(chunk.id, `user-defined/values/${made.fieldId}`);
  assert.equal(chunk.label, 'User-defined values: score');

  const restored = new DataState({}, null);
  restored.pointCount = 4;
  restored.getUserDefinedFieldsRegistry().fromSessionMeta(meta);
  const template = restored.getUserDefinedFieldsRegistry().getField(made.fieldId);
  restored.obsData = { fields: [{ ...template }] };
  restored.varData = { fields: [] };
  const { payload, ...chunkMeta } = chunk;
  restore({ state: restored }, { ...chunkMeta, storedBytes: payload.length, uncompressedBytes: payload.length }, payload);
  assert.deepEqual([...restored.getFields()[0].values], [4, 5, 6, 7]);
  assert.equal(restored.getFields()[0].loaded, true);
  // A chunk of the wrong length is refused.
  restored.getUserDefinedFieldsRegistry().getField(made.fieldId)._valuesLengthHint = 4;
  assert.throws(
    () => restore({ state: restored }, { ...chunkMeta, storedBytes: 8, uncompressedBytes: 8 }, new Uint8Array(8)),
    /8 bytes for 4 float32 values/
  );
});
