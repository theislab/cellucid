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

const notALink = text => (/^(https?:\/\/|GSE\d+$)/.test(text) ? null : `Cellucid does not recognise "${text}".`);

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
  assert.throws(() => resolveDatasetName('pancreas', { ...where, kind: 'link' }), /Cellucid does not recognise "pancreas"/);
  assert.deepEqual(resolveDatasetName('GSE1', { ...where, kind: 'link' }), { kind: 'link', value: 'GSE1' });
});

test('the link box decides what is a link: an accession and a web address are, a word is not', () => {
  assert.equal(linkProblemOf('GSE123456'), null);
  assert.equal(linkProblemOf('https://example.org/data.h5ad'), null);
  assert.equal(linkProblemOf('localhost:8765'), null);
  assert.match(linkProblemOf('zebrafish'), /does not recognise "zebrafish"/);
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
  assert.match(tool.description, /Replaces the open dataset, whose history stays kept in this browser \(Undo does not bring it back\); records no step\. Cellucid asks the person before a large download starts\.$/);
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
  assert.deepEqual((await dispatcher.dispatch('thing.open', {}, { origin: 'agent', agent: 'Claude' })), { outcome: { opened: true }, step: null });
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
  for (const [language, how] of [['python', /Python shows another dataset with show_anndata\(\) or serve_anndata\(\)\.$/], ['r', /R shows another dataset with cellucid_view\(\)\.$/]]) {
    const { handleAction } = createViewerHostCommandHandlers({
      getShownHostDataset: () => 'served', getHostLabel: () => language, getHostLanguage: () => language, actions,
      loadSession: async () => { throw new Error('No session is loaded here.'); },
    });
    await assert.rejects(handleAction({ action: 'dataset.open', params: { name: 'pancreas' } }),
      error => /^"dataset\.open" is not carried out from a notebook: this viewer shows the dataset its notebook serves, and /.test(error.message) && how.test(error.message));
  }
  assert.equal(dispatched.length, 0);
});

/** The Open data controls, a data source manager, an opening progress and the page's lists, all fake. */
function page({ current = null, mine = MINE, granted = true, kept = true } = {}) {
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
    error => error.code === 'cancelled' && /cancelled opening "Pancreatic endocrinogenesis \(scVelo\)"; the dataset shown stays\.$/.test(error.message));
});

test('a whole-file download of the agent\'s own opening is asked about with its size; declined, nothing opens', async t => {
  const p = page();
  t.after(p.remove);
  const asked = [];
  let yes = true;
  // Asked about the download by the opening itself (the start's question is the person's permissions).
  p.dispatcher.setConfirmer(({ detail, stage }) => {
    if (stage === 'start') return true;
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
  const connection = { id: 'g1', kind: 'connector', client: 'Claude Code', host: 'claude.ai' };
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
