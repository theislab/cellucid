/**
 * The agent presence (`assets/js/app/agent/presence/`) without a page, and
 * what it hangs on in the dispatcher: every dispatch (reads too) told as it
 * starts and ends with its meta; `stop` reaching the running work of one
 * agent turn (a read ends, a change is rolled back); the confirmer's answer
 * as the agent reads it, asked for every change of an agent with the
 * owner's estimate of its work; the person's permission settings (kinds,
 * modes, heavy work from an estimate, grants for one chat or connection, the
 * sentence a refused agent reads, what an agent is told, where they are
 * kept); the activity of agent turns (acting, done with its steps, stopped,
 * undone, stepping aside when the person acts, a surface that shows its own
 * turns); and what a confirm card and a line say.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { actorLabel, agentLabel, createAgentActivity, turnKey } from '../assets/js/app/agent/presence/activity.js';
import { CONFIRM_REASONS, activityTextOf, confirmTextOf } from '../assets/js/app/agent/presence/index.js';
import {
  DEFAULT_PERMISSIONS, HEAVY_MS, KIND_LABELS, PERMISSIONS_STORAGE_KEY, PERMISSION_KINDS, PERMISSION_MODES,
  createPermissionStore, decide, deniedSentence, estimateText, grantKey, kindsOf, modeOf, normalizePermissions,
  permissionFor, permissionsForAgent, permissionsLine, permissionsSummary,
} from '../assets/js/app/agent/presence/permissions.js';
import { ACTION_CONFIRMS, createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { ActionRefused, createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { cancelled, onAbort } from '../assets/js/utils/abort.js';
import { setup } from './helpers/history-fixtures.mjs';
import { appName } from '../assets/js/app/agent/connect/model.js';

const NO_PARAMS = Object.freeze({ type: 'object', additionalProperties: false, properties: {} });
const CLAUDE = Object.freeze({ origin: 'agent', agent: 'Claude', turn: 'turn-1' });

test('the dispatcher tells every dispatch, reads included, as it starts and ends, with its meta', async () => {
  const page = setup();
  await page.history.startTracker();
  const catalog = createActionCatalog([
    ...page.dispatcher.catalog.list(),
    defineAction({ type: 'fields.list', title: 'List fields', summary: 'x', group: 'Reads', params: NO_PARAMS, reads: [], effect: 'read', describe: () => 'x', code: () => 'x' }),
  ]);
  const dispatcher = createActionDispatcher({ catalog });
  dispatcher.provide('fields.list', () => ({ fields: ['a'] }));
  dispatcher.provide('color.by', () => {});
  const events = [];
  dispatcher.subscribe(event => events.push([event.kind, event.type, event.meta.origin, event.meta.agent, event.meta.turn, event.step ?? null]));
  const read = await dispatcher.dispatch('fields.list', {}, CLAUDE);
  assert.deepEqual(read, { outcome: { fields: ['a'] }, step: null, unrecorded: null });
  await dispatcher.dispatch('color.by', { field: 'x' });
  assert.deepEqual(events, [
    ['start', 'fields.list', 'agent', 'Claude', 'turn-1', null],
    ['done', 'fields.list', 'agent', 'Claude', 'turn-1', null],
    ['start', 'color.by', 'user', null, null, null],
    ['done', 'color.by', 'user', null, null, null],
  ]);
});

test('stop reaches the running work of one agent turn only: a read ends, a change is rolled back', async () => {
  const page = setup();
  await page.history.startTracker();
  const { state, history } = page;
  const catalog = createActionCatalog([
    ...page.dispatcher.catalog.list(),
    defineAction({ type: 'fields.list', title: 'List fields', summary: 'x', group: 'Reads', params: NO_PARAMS, reads: [], effect: 'read', describe: () => 'x', code: () => 'x' }),
  ]);
  // The fixture's history records the fixture dispatcher; a dispatcher of its own runs with the same domains here.
  const dispatcher = createActionDispatcher({ catalog });
  dispatcher.setRecorder(history.recorder);
  let entered = 0;
  const waitForStop = (signal, change) => {
    change?.();
    entered += 1;
    return new Promise((resolve, reject) => { onAbort(signal, () => reject(signal.reason)); });
  };
  dispatcher.provide('fields.list', (params, { signal }) => waitForStop(signal));
  dispatcher.provide('color.by', ({ field }, { signal }) => waitForStop(signal, () => { state.colors = { ...state.colors, by: field }; }));
  assert.throws(() => dispatcher.stop({}, new Error('x')), /names whose work/);
  const reading = dispatcher.dispatch('fields.list', {}, CLAUDE);
  const changing = dispatcher.dispatch('color.by', { field: 'leiden' }, CLAUDE);
  const other = dispatcher.dispatch('fields.list', {}, { origin: 'agent', agent: 'ChatGPT', turn: 'turn-2' });
  while (entered < 3) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(state.colors.by, 'leiden');
  const reason = cancelled('user', 'The person stopped Claude.');
  assert.equal(dispatcher.stop({ origin: 'agent', agent: 'Claude', turn: 'turn-1' }, reason), 2);
  await assert.rejects(reading, error => error === reason);
  await assert.rejects(changing, error => error === reason);
  assert.equal(state.colors.by, 'cell_type', 'rolled back');
  assert.equal(history.active.steps.size, 1, 'no step kept');
  assert.equal(dispatcher.stop({ agent: 'Claude' }, reason), 0, 'nothing of Claude runs any more');
  assert.equal(dispatcher.stop({ agent: 'ChatGPT' }, reason), 1);
  await assert.rejects(other, error => error === reason);
});

test('stop reaches a dispatch before it runs too: waiting for its estimate, for the person\'s answer, or at the gate; it never runs', async () => {
  const catalog = createActionCatalog([defineAction({
    type: 'demo.change', title: 'Change something', summary: 'x', group: 'Demo',
    params: NO_PARAMS, touches: ['layout'], reads: [], effect: 'state', describe: () => 'Changed', code: () => 'x',
  })]);
  const dispatcher = createActionDispatcher({ catalog });
  let runs = 0;
  dispatcher.provide('demo.change', () => { runs += 1; });
  const events = [];
  dispatcher.subscribe(event => events.push(event.kind));
  const meta = turn => ({ origin: 'agent', agent: 'Claude', turn });
  const reason = cancelled('user', 'The person stopped Claude.');

  // Its estimate never comes: the estimator is given the dispatch's signal.
  let estimateSignal = null;
  const withdrawEstimate = dispatcher.provideEstimate('demo.change', (params, { signal }) => {
    estimateSignal = signal;
    return new Promise(() => {});
  });
  let asked = null;
  dispatcher.setConfirmer(request => { asked = request; return new Promise(() => {}); });
  const estimating = dispatcher.dispatch('demo.change', {}, meta('t-estimate'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(dispatcher.stop({ turn: 't-estimate' }, reason), 1);
  await assert.rejects(estimating, error => error === reason);
  assert.equal(estimateSignal.aborted, true);
  assert.equal(asked, null, 'stopped before the person was asked');

  // Asking the person: the confirmer's signal aborts (its card goes), and the dispatch ends.
  withdrawEstimate();
  const asking = dispatcher.dispatch('demo.change', {}, meta('t-ask'));
  while (asked === null) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(asked.meta.turn, 't-ask');
  assert.equal(asked.signal.aborted, false);
  assert.equal(dispatcher.stop({ turn: 't-ask' }, reason), 1);
  assert.equal(asked.signal.aborted, true);
  await assert.rejects(asking, error => error === reason);

  // At the gate (the history busy with a move): stopped there, it never runs.
  dispatcher.setConfirmer(() => true);
  let open;
  dispatcher.setGate(() => new Promise(resolve => { open = resolve; }));
  const gated = dispatcher.dispatch('demo.change', {}, meta('t-gate'));
  while (open === undefined) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(dispatcher.stop({ turn: 't-gate' }, reason), 1);
  await assert.rejects(gated, error => error === reason);
  open();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(runs, 0);
  assert.deepEqual(events, [], 'none of them started');
  assert.equal(dispatcher.stop({ agent: 'Claude' }, reason), 0, 'nothing is left to stop');
});

test('the confirmer\'s answer is what the agent reads: Allow runs it, Deny refuses with a sentence, a refusal of its own is passed on', async () => {
  const catalog = createActionCatalog([defineAction({
    type: 'demo.write', title: 'Write a report file', summary: 'x', group: 'Demo',
    params: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } } },
    touches: ['layout'], reads: [], effect: 'state', confirm: 'writes-file', describe: p => `Wrote ${p.name}`, code: () => 'x',
  })]);
  const dispatcher = createActionDispatcher({ catalog });
  let runs = 0;
  dispatcher.provide('demo.write', () => { runs += 1; return { written: true }; });
  // No confirmer on the page: an agent cannot take it.
  await assert.rejects(dispatcher.dispatch('demo.write', { name: 'a.csv' }, CLAUDE), error => error.code === 'needs-confirmation');
  const asked = [];
  let answer = true;
  dispatcher.setConfirmer(request => { asked.push([request.definition.type, request.params.name, request.meta.agent]); return answer; });
  assert.deepEqual((await dispatcher.dispatch('demo.write', { name: 'a.csv' }, CLAUDE)).outcome, { written: true });
  answer = false;
  await assert.rejects(dispatcher.dispatch('demo.write', { name: 'b.csv' }, CLAUDE),
    error => error instanceof ActionRefused && error.code === 'declined' && error.message === 'The person declined, so this was not done: Write a report file (Wrote b.csv).');
  dispatcher.setConfirmer(() => { throw new ActionRefused('The Cellucid tab was closed before the person answered; nothing was done.', { code: 'closed' }); });
  await assert.rejects(dispatcher.dispatch('demo.write', { name: 'c.csv' }, CLAUDE), error => error.code === 'closed');
  // The person's own action is not asked about.
  await dispatcher.dispatch('demo.write', { name: 'd.csv' });
  assert.deepEqual(asked, [['demo.write', 'a.csv', 'Claude'], ['demo.write', 'b.csv', 'Claude']]);
  assert.equal(runs, 2);
});

test('a confirm card says who asks, what, why, and the parameters; every kind of asking has its reason', () => {
  // Every definition's confirm kind, and the question an opensLinks action asks of its own (F121).
  // Besides the definitions' kinds, the questions an implementation asks of its own: an unseen link, work not kept.
  assert.deepEqual(Object.keys(CONFIRM_REASONS).sort(), [...ACTION_CONFIRMS, 'unseen-link', 'replaces-unkept'].sort());
  const definition = defineAction({
    type: 'dataset.download', title: 'Download a dataset', summary: 'x', group: 'Data',
    params: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' }, cells: { type: 'array', items: { type: 'integer' }, 'x-cells': true } } },
    touches: ['views'], reads: [], effect: 'state', confirm: 'large-download', describe: () => 'x', code: () => 'x',
  });
  assert.deepEqual(confirmTextOf({ definition, params: { url: 'https://x.org/a.h5ad', cells: [1, 2, 3] }, meta: { agent: 'ChatGPT' } }), {
    who: 'ChatGPT',
    what: 'ChatGPT asks to download a dataset: https://x.org/a.h5ad.',
    why: 'It downloads a lot of data, which takes time and may cost on a metered connection.',
    facts: [{ label: 'Url', value: 'https://x.org/a.h5ad' }, { label: 'Cells', value: '3 cells' }],
  });
});

test('the activity of agent turns: acting, done with its steps, read-only turns going, the person acting, a new turn, stopped, undone', () => {
  const titles = { 'color.by': 'Color by a field', 'fields.list': 'List fields' };
  const activity = createAgentActivity({ titleOf: type => titles[type] });
  const meta = (turn, agent = 'Claude') => ({ origin: 'agent', agent, turn });
  const m1 = meta('t1');
  assert.equal(activity.onDispatch({ kind: 'start', type: 'fields.list', meta: m1 }), true);
  assert.deepEqual(activity.lines().map(line => [line.state, line.doing, line.steps]), [['acting', 'List fields', 0]]);
  activity.onDispatch({ kind: 'done', type: 'fields.list', meta: m1, step: null });
  assert.deepEqual(activity.lines(), [], 'a turn that only read goes once nothing runs');

  const m2 = meta('t1');
  activity.onDispatch({ kind: 'start', type: 'color.by', meta: m2 });
  activity.onDispatch({ kind: 'done', type: 'color.by', meta: m2, step: { label: 'Colored by leiden' } });
  assert.deepEqual(activity.lines().map(line => [line.key, line.state, line.steps, line.lastLabel]), [[turnKey('Claude', 't1'), 'done', 1, 'Colored by leiden']]);
  assert.equal(activityTextOf(activity.lines()[0]), 'Claude · 1 step · Colored by leiden');

  // A step of anyone else's: the finished turn steps aside.
  assert.equal(activity.onDispatch({ kind: 'done', type: 'color.by', meta: { origin: 'user' }, step: { label: 'x' } }), true);
  assert.deepEqual(activity.lines(), []);
  assert.equal(activity.onDispatch({ kind: 'done', type: 'fields.list', meta: { origin: 'user' }, step: null }), false);

  // A new turn of the same agent replaces its finished one; another agent's stays.
  for (const [turn, agent] of [['t2', 'Claude'], ['c1', 'ChatGPT'], ['t3', 'Claude']]) {
    const m = meta(turn, agent);
    activity.onDispatch({ kind: 'start', type: 'color.by', meta: m });
    activity.onDispatch({ kind: 'done', type: 'color.by', meta: m, step: { label: `Step of ${turn}` } });
  }
  assert.deepEqual(activity.lines().map(line => line.turn), ['c1', 't3']);

  // A failed action leaves the turn as it was; stopped and undone say so.
  const m4 = meta('t3');
  activity.onDispatch({ kind: 'start', type: 'color.by', meta: m4 });
  assert.equal(activityTextOf(activity.lines().find(line => line.turn === 't3')), 'Claude is working · 1 step · Color by a field');
  // While the history's recording is paused, the line starts with ⏸ (History v2 §3.15.1).
  assert.equal(activityTextOf(activity.lines().find(line => line.turn === 't3'), { paused: true }), '⏸ Claude is working · 1 step · Color by a field');
  activity.markStopped(turnKey('Claude', 't3'));
  activity.onDispatch({ kind: 'failed', type: 'color.by', meta: m4, error: new Error('x') });
  assert.equal(activityTextOf(activity.lines().find(line => line.turn === 't3')), 'Claude stopped · 1 step');
  activity.markUndone(turnKey('ChatGPT', 'c1'));
  assert.equal(activityTextOf(activity.lines().find(line => line.turn === 'c1')), 'ChatGPT\'s turn is undone');
  activity.dismiss(turnKey('ChatGPT', 'c1'));
  activity.clearFinished();
  assert.deepEqual(activity.lines(), []);
});

test('two agents of one name at once (the chat\'s Claude, Claude Desktop through the connector): two lines, neither replacing the other, each named with its way in', () => {
  const activity = createAgentActivity({ titleOf: () => 'Color by a field' });
  const chat = { id: 'chat-1', kind: 'chat' };
  const desktop = { id: 'g1', kind: 'connector', client: 'Claude Desktop', host: 'claude.ai' };
  const run = meta => {
    activity.onDispatch({ kind: 'start', type: 'color.by', meta });
    activity.onDispatch({ kind: 'done', type: 'color.by', meta, step: { label: `Step of ${meta.turn}` } });
  };
  run({ origin: 'agent', agent: 'Claude', turn: 't1', connection: chat });
  run({ origin: 'agent', agent: 'Claude', turn: 'd1', connection: desktop });
  assert.deepEqual(activity.lines().map(line => [line.key, line.label, line.connection]), [
    [turnKey('Claude', 't1', chat), 'Claude (chat)', 'chat'],
    [turnKey('Claude', 'd1', desktop), 'Claude (Claude Desktop)', 'connector'],
  ]);
  assert.equal(activityTextOf(activity.lines()[1]), 'Claude (Claude Desktop) · 1 step · Step of d1');
  // A new turn through the same connection replaces that connection's finished one only.
  run({ origin: 'agent', agent: 'Claude', turn: 'd2', connection: desktop });
  assert.deepEqual(activity.lines().map(line => line.turn), ['t1', 'd2']);
  activity.markUndone(turnKey('Claude', 'd2', desktop));
  assert.deepEqual(activity.lines().map(line => line.state), ['done', 'undone']);
  // The way in, as a line and a card name it.
  assert.equal(agentLabel('Claude', null), 'Claude');
  assert.equal(agentLabel('ChatGPT', { kind: 'connector', client: 'ChatGPT', host: 'chatgpt.com' }), 'ChatGPT (chatgpt.com)');
  assert.equal(agentLabel('Claude', { kind: 'connector', client: null, host: null }), 'Claude (connector)');
  assert.equal(agentLabel('Claude', { kind: 'connector', client: 'Claude Desktop', host: 'claude.ai', known: true }), 'Claude (Claude Desktop)');
  // L26-4 / F122: an app no site vouches for is its host (or an app on this computer), its own name only quoted:
  // two of them are told apart, and none passes for Claude.
  // The relay client names such an agent as Manage… does (`appName`); the label adds nothing to it.
  const fake = appName('evil.example', 'Claude', false);
  assert.equal(agentLabel(fake, { kind: 'connector', client: 'Claude', host: 'evil.example', known: false }), 'evil.example (calls itself “Claude”)');
  const phone = appName('An app on this computer', 'Claude on my phone', false);
  assert.equal(agentLabel(phone, { kind: 'connector', client: 'Claude on my phone', host: null, known: false }),
    'An app on this computer (calls itself “Claude on my phone”)');
  assert.notEqual(phone, appName('An app on this computer', 'Claude', false), 'two unvouched apps on this computer are told apart');
  assert.equal(agentLabel('An app on this computer', { kind: 'connector', client: null, host: null, known: false }), 'An app on this computer (connector)');
  const definition = defineAction({
    type: 'color.by', title: 'Color the cells by a field or gene', summary: 'x', group: 'Colors',
    params: { type: 'object', additionalProperties: false, properties: {} }, touches: ['colors'], reads: [], effect: 'view', describe: () => 'x', code: () => 'x',
  });
  assert.equal(confirmTextOf({ definition, params: {}, meta: { agent: 'Claude', connection: desktop } }).what, 'Claude (Claude Desktop) asks to color the cells by a field or gene.');
  // Null is a request too: the coloring taken away.
  assert.equal(confirmTextOf({ definition, params: { field: null }, meta: { agent: 'Claude', connection: chat } }).what, 'Claude (chat) asks to color the cells by a field or gene: no field.');
  assert.equal(confirmTextOf({ definition, params: {}, meta: { agent: 'Claude', connection: chat } }).who, 'Claude');
});

test('a surface\'s own turn: acting from its start, its stop called by the line\'s Stop, hidden while the surface shows it, kept after for Undo', () => {
  const activity = createAgentActivity();
  let shown = true;
  let stops = 0;
  const detach = activity.attach({ agent: 'Claude', turn: 't9', stop: () => { stops += 1; }, shownElsewhere: () => shown });
  assert.deepEqual(activity.lines(), [], 'the open chat shows its own turn');
  shown = false;
  assert.deepEqual(activity.lines().map(line => [line.state, line.steps]), [['acting', 0]], 'collapsed, the line shows it, the model thinking included');
  assert.equal(activityTextOf(activity.lines()[0]), 'Claude is working');
  const m = { origin: 'agent', agent: 'Claude', turn: 't9' };
  activity.onDispatch({ kind: 'start', type: 'color.by', meta: m });
  activity.onDispatch({ kind: 'done', type: 'color.by', meta: m, step: { label: 'Colored by x' } });
  assert.equal(activity.lines()[0].state, 'acting', 'still attached: the model may call again');
  activity.markStopped(turnKey('Claude', 't9'))();
  assert.equal(stops, 1);
  activity.dismiss(turnKey('Claude', 't9'));
  assert.equal(activity.lines().length, 1, 'a turn still attached cannot be dismissed');
  detach();
  detach();
  assert.deepEqual(activity.lines().map(line => [line.state, line.steps]), [['stopped', 1]]);
  shown = true;
  assert.deepEqual(activity.lines(), [], 'the surface shows its finished turns too');
});

// ------------------------------------------------------------- Permissions

function memoryStorage() {
  const values = new Map();
  return { values, getItem: name => values.get(name) ?? null, setItem: (name, value) => { values.set(name, String(value)); }, removeItem: name => values.delete(name) };
}

const COLOR = Object.freeze({ type: 'color.by', title: 'Color by', confirm: null });
const WRITE = Object.freeze({ type: 'figure.export', title: 'Export a figure', confirm: 'writes-file' });

test('every agent change asks the confirmer with its estimate; reads do not; a move of the history does; a failed estimate is none', async () => {
  const catalog = createActionCatalog([
    defineAction({ type: 'fields.list', title: 'List fields', summary: 'x', group: 'Reads', params: NO_PARAMS, reads: [], effect: 'read', describe: () => 'x', code: () => 'x' }),
    defineAction({ type: 'demo.run', title: 'Run', summary: 'x', group: 'Demo', params: { type: 'object', additionalProperties: false, properties: { cells: { type: 'integer' } } }, touches: ['layout'], reads: [], effect: 'state', describe: p => `Ran on ${p.cells}`, code: () => 'x' }),
    defineAction({ type: 'demo.undo', title: 'Undo', summary: 'x', group: 'History', params: NO_PARAMS, reads: [], effect: 'history', describe: () => 'Undid', code: () => 'x' }),
    defineAction({ type: 'demo.paint', title: 'Paint', summary: 'x', group: 'Demo', params: NO_PARAMS, touches: ['layout'], reads: [], effect: 'state', describe: () => 'Painted', code: () => 'x' }),
  ]);
  const dispatcher = createActionDispatcher({ catalog });
  for (const type of ['fields.list', 'demo.run', 'demo.undo', 'demo.paint']) dispatcher.provide(type, () => ({}));
  // Without a confirmer a change with no confirm kind runs (the page has no presence: a test, a notebook).
  await dispatcher.dispatch('demo.run', { cells: 1 }, CLAUDE);
  const asked = [];
  const told = [];
  dispatcher.subscribe(event => { if (event.kind === 'asking' || event.kind === 'answered') told.push([event.kind, event.type, event.allowed ?? null]); });
  dispatcher.setConfirmer(({ definition, params, meta, estimate, confirm, stage, asking }) => {
    asked.push([definition.type, params.cells ?? null, meta.agent, estimate]);
    assert.equal(confirm, null);
    assert.equal(stage, 'start');
    // The person is asked about the paint only.
    if (definition.type === 'demo.paint') asking();
    return true;
  });
  const remove = dispatcher.provideEstimate('demo.run', ({ cells }) => ({ ms: cells * 2, bytes: null, what: `${cells} cells` }));
  assert.throws(() => dispatcher.provideEstimate('demo.run', () => null), /already has an estimate/);
  assert.throws(() => dispatcher.provideEstimate('no.such', () => null));
  dispatcher.provideEstimate('demo.paint', () => { throw new Error('no measure yet'); });
  const logged = console.error;
  console.error = () => {};
  try {
    await dispatcher.dispatch('fields.list', {}, CLAUDE);
    await dispatcher.dispatch('demo.run', { cells: 6000 }, CLAUDE);
    await dispatcher.dispatch('demo.undo', {}, CLAUDE);
    await dispatcher.dispatch('demo.paint', {}, CLAUDE);
    await dispatcher.dispatch('demo.run', { cells: 3 });
  } finally {
    console.error = logged;
  }
  assert.deepEqual(asked, [
    ['demo.run', 6000, 'Claude', { ms: 12_000, bytes: null, what: '6000 cells' }],
    ['demo.undo', null, 'Claude', null],
    ['demo.paint', null, 'Claude', null],
  ]);
  assert.deepEqual(told, [['asking', 'demo.paint', null], ['answered', 'demo.paint', true]], 'heard only when the person was asked');
  remove();
  await dispatcher.dispatch('demo.run', { cells: 6000 }, CLAUDE);
  assert.equal(asked.at(-1)[3], null, 'the estimate removed');
});

test('permissions: a question\'s kinds, the strictest setting decides, heavy from the estimate, asked again by the handler, a grant for one chat or connection', () => {
  const settings = normalizePermissions(null);
  assert.deepEqual(settings, DEFAULT_PERMISSIONS);
  assert.equal(modeOf(settings), 'ask');
  const chat = { origin: 'agent', agent: 'Claude', turn: 't1', connection: { id: 'chat-1', kind: 'chat' } };
  const heavy = { ms: HEAVY_MS, bytes: null, what: 'Markers of 40,000 cells' };
  assert.deepEqual(kindsOf({}), ['change']);
  assert.deepEqual(kindsOf({ estimate: { ms: HEAVY_MS - 1 } }), ['change']);
  assert.deepEqual(kindsOf({ confirm: 'writes-file', estimate: heavy }), ['writes-file', 'heavy']);
  assert.deepEqual(kindsOf({ estimate: { ms: null } }), ['change'], 'no measure: not judged heavy');
  // Asked by its implementation once it knows the cost: of that kind alone.
  assert.deepEqual(kindsOf({ confirm: 'large-download', stage: 'handler', estimate: heavy }), ['large-download']);

  assert.deepEqual(decide({ meta: chat }, settings), { decision: 'allow', kinds: ['change'], asking: [], denied: null });
  assert.deepEqual(decide({ meta: chat, estimate: heavy }, settings), { decision: 'ask', kinds: ['change', 'heavy'], asking: ['heavy'], denied: null });
  assert.deepEqual(decide({ meta: chat, estimate: heavy, confirm: 'writes-file' }, settings).asking, ['writes-file', 'heavy']);

  // Allowed in this chat: that chat only, that kind only.
  const grants = new Set([grantKey(chat, 'heavy')]);
  assert.equal(decide({ meta: chat, estimate: heavy }, settings, grants).decision, 'allow');
  assert.deepEqual(decide({ meta: chat, estimate: heavy, confirm: 'writes-file' }, settings, grants).asking, ['writes-file']);
  assert.equal(decide({ meta: { ...chat, connection: { id: 'chat-2', kind: 'chat' } }, estimate: heavy }, settings, grants).decision, 'ask');
  assert.equal(decide({ meta: { ...chat, connection: { id: 'chat-1', kind: 'connector' } }, estimate: heavy }, settings, grants).decision, 'ask',
    'a connector connection is not a chat of the same id');
  assert.equal(grantKey({ agent: 'Claude', connection: null }, 'heavy'), 'agent:Claude\u0000heavy');
  assert.equal(grantKey({ connection: { id: 'g1', kind: 'connector' } }, 'heavy'), 'connector:g1\u0000heavy');

  // Deny wins over Ask and over a grant given before the kind was set to Deny.
  const strict = normalizePermissions({ kinds: { ...settings.kinds, heavy: 'deny' } });
  assert.equal(modeOf(strict), 'custom');
  assert.equal(permissionsSummary(strict), 'Custom');
  assert.equal(permissionsLine(strict), 'Custom');
  assert.deepEqual(Object.keys(PERMISSION_MODES).map(mode => permissionsLine(normalizePermissions({ kinds: PERMISSION_MODES[mode].kinds }))),
    ['Ask before heavy', 'Allow undoable', 'Read only']);
  assert.deepEqual(decide({ meta: chat, estimate: heavy, confirm: 'writes-file' }, strict, grants), { decision: 'deny', kinds: ['writes-file', 'heavy'], asking: [], denied: 'heavy' });
  const readOnly = normalizePermissions({ kinds: PERMISSION_MODES['read-only'].kinds });
  assert.equal(modeOf(readOnly), 'read-only');
  assert.equal(decide({ meta: chat }, readOnly).denied, 'change');
  const undoable = normalizePermissions({ kinds: PERMISSION_MODES['allow-undoable'].kinds });
  assert.equal(decide({ meta: chat, estimate: heavy }, undoable).decision, 'allow');
  assert.deepEqual(decide({ meta: chat, confirm: 'writes-file' }, undoable).asking, ['writes-file'], 'what cannot be undone still asks');
  // Unknown choices are the default's.
  assert.equal(normalizePermissions({ kinds: { change: 'sometimes' } }).kinds.change, 'allow');

  // What a connection's tool list says of each kind: the setting, or allow where the person allowed it there.
  const connector = { id: 'g1', kind: 'connector' };
  assert.equal(permissionFor({ kind: 'change', connection: connector }, settings), 'allow');
  assert.equal(permissionFor({ kind: 'writes-file', connection: connector }, settings), 'ask');
  assert.equal(permissionFor({ kind: 'writes-file', connection: connector }, settings, new Set([grantKey({ connection: connector }, 'writes-file')])), 'allow');
  assert.equal(permissionFor({ kind: 'change', connection: connector }, readOnly), 'deny');
  assert.throws(() => permissionFor({ kind: 'telepathy', connection: connector }, settings), /no permission kind "telepathy"/);
});

test('permissions: what a refused agent reads, what every agent is told, and the estimate on the card', () => {
  assert.equal(deniedSentence(COLOR, 'change'),
    'The person\'s settings in Cellucid do not let agents change anything in this tab, so “Color by” was not done. '
    + 'Do not try again; tell the person if it is needed (they can change it in the chat settings, Permissions).');
  for (const kind of PERMISSION_KINDS) assert.match(deniedSentence(WRITE, kind), /^The person's settings in Cellucid do not let agents \S/);
  assert.deepEqual(Object.keys(KIND_LABELS), [...PERMISSION_KINDS]);
  assert.equal(permissionsForAgent(normalizePermissions(null)),
    'The person\'s permissions for agents in Cellucid now (Ask before heavy or irreversible): changes in this tab: run without asking. '
    + 'heavy work (longer than about 10 s); writing files; deleting what was saved; large downloads; publishing; pausing the history; opening links not seen in this tab; replacing work that is not kept: are asked of the person first (you wait for the answer). '
    + 'Reads need no permission.');
  assert.match(permissionsForAgent(normalizePermissions({ kinds: PERMISSION_MODES['read-only'].kinds })), /\(Read only\): .*: are refused\. Reads need no permission\.$/);
  assert.equal(estimateText(null), null);
  assert.equal(estimateText({ ms: null, bytes: null, what: '' }), null);
  assert.equal(estimateText({ ms: 12_000, bytes: null, what: 'markers of 40,000 cells' }), 'Markers of 40,000 cells, about 12.0 s on this device.');
  assert.equal(estimateText({ ms: 900 }), 'About 900 ms on this device.');
  // The card says why it asks: heavy with the estimate.
  const definition = defineAction({ type: 'demo.heavy', title: 'Find markers', summary: 'x', group: 'Demo', params: NO_PARAMS, touches: ['layout'], reads: [], effect: 'state', describe: () => 'x', code: () => 'x' });
  const card = confirmTextOf({ definition, params: {}, meta: { agent: 'Claude' }, estimate: { ms: 12_000, what: 'markers of 40,000 cells' }, asking: ['heavy'] });
  assert.equal(card.why, 'It is heavy work: Markers of 40,000 cells, about 12.0 s on this device.');
});

test('permissions: kept in this browser, set by mode or kind, told to listeners; wrong values refused; no site data keeps them for the page', () => {
  const storage = memoryStorage();
  const store = createPermissionStore({ storage });
  assert.deepEqual(store.get(), DEFAULT_PERMISSIONS);
  const told = [];
  const unsubscribe = store.subscribe(settings => told.push(modeOf(settings)));
  store.set({ mode: 'read-only' });
  store.set({ kinds: { change: 'allow' } });
  assert.deepEqual(told, ['read-only', 'custom']);
  assert.throws(() => store.set({ mode: 'yolo' }), /no permission mode "yolo"/);
  assert.throws(() => store.set({ kinds: { change: 'maybe' } }), /"change: maybe" is not a permission/);
  assert.throws(() => store.set({ kinds: { telepathy: 'allow' } }), /is not a permission/);
  unsubscribe();
  store.set({ mode: 'allow-undoable', kinds: { publishes: 'deny' } });
  assert.equal(told.length, 2);
  assert.deepEqual(JSON.parse(storage.getItem(PERMISSIONS_STORAGE_KEY)).kinds, { ...PERMISSION_MODES['allow-undoable'].kinds, publishes: 'deny' });
  assert.deepEqual(createPermissionStore({ storage }).get(), store.get(), 'read back by the next page');
  storage.setItem(PERMISSIONS_STORAGE_KEY, '{nope');
  assert.deepEqual(createPermissionStore({ storage }).get(), DEFAULT_PERMISSIONS);
  const none = createPermissionStore({ storage: null });
  assert.equal(modeOf(none.set({ mode: 'read-only' })), 'read-only');
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const blocked = createPermissionStore({ storage: throwing });
  assert.deepEqual(blocked.get(), DEFAULT_PERMISSIONS);
  assert.equal(modeOf(blocked.set({ mode: 'read-only' })), 'read-only');
});

test('the history applying its own steps again (an undone turn\'s others) is no one acting: no line moves', () => {
  const activity = createAgentActivity();
  const m = { origin: 'agent', agent: 'Claude', turn: 't1' };
  activity.onDispatch({ kind: 'start', type: 'color.by', meta: m });
  activity.onDispatch({ kind: 'done', type: 'color.by', meta: m, step: { label: 'Colored by x' } });
  const before = activity.lines().map(line => [line.state, line.steps]);
  assert.equal(activity.onDispatch({ kind: 'start', type: 'color.by', meta: { ...m, internal: true } }), false);
  assert.equal(activity.onDispatch({ kind: 'done', type: 'color.by', meta: { ...m, internal: true }, step: { label: 'Colored by x' } }), false);
  assert.equal(activity.onDispatch({ kind: 'done', type: 'camera.set', meta: { origin: 'user', internal: true }, step: { label: 'Camera' } }), false);
  assert.deepEqual(activity.lines().map(line => [line.state, line.steps]), before);
});

test('a question waiting for the person makes its turn act (Stop on its line) before the action starts, until it is answered', () => {
  const activity = createAgentActivity({ titleOf: type => `Title of ${type}` });
  const meta = { origin: 'agent', agent: 'ChatGPT', turn: 't1', connection: { id: 'g1', kind: 'connector' } };
  const release = activity.waitOnPerson(meta, 'color.by');
  assert.deepEqual(activity.lines().map(line => [line.state, line.doing]), [['acting', 'Title of color.by']]);
  // Allowed: the action starts and ends; the line is done with its step.
  activity.onDispatch({ kind: 'start', type: 'color.by', meta });
  release();
  assert.equal(activity.lines()[0].state, 'acting');
  activity.onDispatch({ kind: 'done', type: 'color.by', meta, step: { id: 's1', label: 'Colored' } });
  assert.equal(activity.lines()[0].state, 'done');
  release();
  // Declined or withdrawn before it ran: a turn that took no step goes away; one stopped stays stopped.
  const again = activity.waitOnPerson({ ...meta, turn: 't2' }, 'color.by');
  const key = activity.lines().find(line => line.turn === 't2').key;
  activity.markStopped(key);
  again();
  assert.equal(activity.lines().find(line => line.turn === 't2').state, 'stopped');
  const third = activity.waitOnPerson({ ...meta, turn: 't3' }, 'color.by');
  third();
  assert.equal(activity.lines().some(line => line.turn === 't3'), false);
});

test('a notebook is asked before it publishes, as an agent is; nothing else of it is asked', async () => {
  const definitions = [
    defineAction({
      type: 'demo.publish', title: 'Publish a vote', summary: 'x', group: 'Demo',
      params: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' } } },
      reads: [], effect: 'outside', confirm: 'publishes', confirmAt: 'handler', acts: { one: 'vote published', other: 'votes published' },
      describe: (p, outcome, quote = { bare: String }) => `Voted ${quote.bare(p.label)} up`, code: () => 'x',
    }),
    defineAction({
      type: 'demo.write', title: 'Write a file', summary: 'x', group: 'Demo',
      params: { type: 'object', additionalProperties: false, properties: {} },
      reads: [], effect: 'outside', confirm: 'writes-file', acts: { one: 'file written', other: 'files written' },
      describe: () => 'Wrote a file', code: () => 'x',
    }),
  ];
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog(definitions) });
  const asked = [];
  dispatcher.setConfirmer(async question => {
    asked.push([question.meta.origin, question.confirm, question.stage, question.detail]);
    return question.meta.origin !== 'host' || question.detail !== 'deny';
  });
  dispatcher.provide('demo.publish', async ({ label }, { confirm }) => {
    await confirm(label === 'deny' ? 'deny' : 'It publishes to owner/repo.');
    return { published: true };
  });
  dispatcher.provide('demo.write', () => 'written');
  // A notebook writing a file is the person's own act through their notebook: not asked.
  await dispatcher.dispatch('demo.write', {}, { origin: 'host', host: 'python' });
  // A notebook's vote is asked (at the handler, once it knows where it goes).
  await dispatcher.dispatch('demo.publish', { label: 'T cell' }, { origin: 'host', host: 'r' });
  await assert.rejects(dispatcher.dispatch('demo.publish', { label: 'deny' }, { origin: 'host', host: 'python' }), error => error.code === 'declined');
  // The person's own click is never asked.
  await dispatcher.dispatch('demo.publish', { label: 'T cell' }, { origin: 'user' });
  assert.deepEqual(asked, [
    ['host', 'publishes', 'handler', 'It publishes to owner/repo.'],
    ['host', 'publishes', 'handler', 'deny'],
  ]);
  // The card names the notebook and what exactly it publishes; a grant is kept for that notebook.
  const text = confirmTextOf({ definition: definitions[0], params: { label: 'T cell' }, meta: { origin: 'host', host: 'python' }, detail: 'It publishes to owner/repo.' });
  // What would be done, never the step's past-tense sentence ("Voted T cell up" before the answer).
  assert.equal(text.what, 'Python (notebook) asks to publish a vote: T cell.');
  assert.equal(text.why, 'It publishes to owner/repo.');
  assert.equal(grantKey({ origin: 'host', host: 'r' }, 'publishes'), 'host:r\u0000publishes');
  assert.equal(actorLabel({ origin: 'host', host: null }), 'The notebook');
});

test('the activity line counts what a turn did outside the state, and keeps a turn that only did that', () => {
  const activity = createAgentActivity({ outsideOf: (type, params, outcome) => (outcome?.published === false ? null : { one: 'vote published', other: 'votes published' }) });
  const meta = { origin: 'agent', agent: 'Claude', turn: 't1' };
  for (const published of [true, false, true]) {
    activity.onDispatch({ kind: 'start', type: 'annotation.publish', meta });
    activity.onDispatch({ kind: 'done', type: 'annotation.publish', meta, step: null, outcome: { published } });
  }
  const [line] = activity.lines();
  assert.equal(line.state, 'done');
  assert.equal(line.steps, 0);
  assert.deepEqual(line.outside, [{ one: 'vote published', other: 'votes published', count: 2 }]);
  assert.equal(activityTextOf(line), 'Claude · 2 votes published, not undoable');
});

test('a turn counts steps, not actions: a change merged into the step before is that one step (R9R-6)', () => {
  const activity = createAgentActivity({ titleOf: type => type });
  const meta = () => ({ origin: 'agent', agent: 'Claude', turn: 't-merge' });
  const set = (id, label) => {
    const m = meta();
    activity.onDispatch({ kind: 'start', type: 'setting.set', meta: m });
    activity.onDispatch({ kind: 'done', type: 'setting.set', meta: m, step: { id, label } });
  };
  // A slider set three times by the agent: one step (coalesced), then another setting.
  set('s5', 'Grid density: set to 32³');
  set('s5', 'Grid density: set to 128³');
  set('s5', 'Grid density: set to 48³');
  set('s6', 'Ray quality: set to Balanced');
  const [line] = activity.lines();
  assert.equal(line.steps, 2);
  assert.equal(activityTextOf(line), 'Claude · 2 steps · Ray quality: set to Balanced');
});
