/**
 * The calls of agents from outside the tab (`app/agent/bridge/agent-calls.js`),
 * as a local agent connection (`cellucid mcp` over the viewer channel) makes
 * them: dispatched as the agent through a `local` connection, with turns; one
 * tool list, and the person's settings told after results; the person asked about a call
 * heard with the card's question, and answered; a call stopped; an unknown
 * tool and a refusal answered as tool errors; and the activity line's label
 * of a local agent.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { ActionRefused, AGENT_CONNECTION_KINDS, createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { quoteName } from '../assets/js/app/actions/targets/names.js';
import { AGENT_TURN_IDLE_MS, OUTSIDE_CONNECTION_KINDS, createAgentCalls } from '../assets/js/app/agent/bridge/agent-calls.js';
import { agentLabel } from '../assets/js/app/agent/presence/activity.js';

const NO_PARAMS = { type: 'object', additionalProperties: false, properties: {} };

const DEFINITIONS = [
  defineAction({
    type: 'fields.list', title: 'List fields', summary: 'The fields of the open dataset.', group: 'Reads',
    params: NO_PARAMS, reads: [], effect: 'read', describe: () => 'Listed fields', code: () => 'fields()',
  }),
  defineAction({
    type: 'color.by', title: 'Color by a field', summary: 'Color the cells by a field.', group: 'Coloring',
    params: { type: 'object', additionalProperties: false, required: ['field'], properties: { field: { type: 'string' } } },
    touches: ['active-field'], reads: [], effect: 'view', describe: params => `Colored by ${params.field}`, code: params => `color_by("${params.field}")`,
  }),
  defineAction({
    type: 'analysis.run', title: 'Run an analysis', summary: 'Run one analysis.', group: 'Analysis',
    params: NO_PARAMS, touches: ['analysis'], reads: [], effect: 'state', describe: () => 'Ran', code: () => 'run()',
  }),
  defineAction({
    type: 'session.save', title: 'Save the session', summary: 'Write the session file.', group: 'Session',
    params: NO_PARAMS, touches: ['layout'], reads: [], effect: 'state', confirm: 'writes-file', describe: () => 'Saved', code: () => 'save()',
  }),
];

function setup({ permissionFor, questionFor } = {}) {
  const catalog = createActionCatalog(DEFINITIONS);
  const actions = createActionDispatcher({ catalog });
  let stepNumber = 0;
  actions.setRecorder({
    before: async ({ definition, params, meta }) => ({ definition, params, meta }),
    after: async token => ({ id: `s${++stepNumber}`, label: token.definition.describe(token.params, null) }),
    failed: async () => {},
    observed: async ({ definition, params }) => ({ id: `s${++stepNumber}`, label: definition.describe(params, null) }),
  });
  const seen = [];
  actions.provide('fields.list', () => ({ fields: ['cell_type'] }));
  actions.provide('session.save', () => ({ written: true }));
  actions.provide('color.by', (params, { meta }) => {
    seen.push({ params, meta });
    if (params.field === 'nope') throw new ActionRefused(`There is no field ${quoteName('nope')}; the fields are cell_type`);
    return { field: params.field };
  });
  actions.provide('analysis.run', (params, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  let now = 1_000;
  const sent = { results: new Map(), asking: [], answered: [] };
  const calls = createAgentCalls({
    actions,
    kind: 'local',
    ...(permissionFor === undefined ? {} : { permissionFor }),
    ...(questionFor === undefined ? {} : { questionFor }),
    now: () => now,
    onResult: (id, result) => sent.results.set(id, result),
    onAsking: (id, question) => sent.asking.push({ id, ...question }),
    onAnswered: (id, allowed) => sent.answered.push({ id, allowed }),
  });
  return { actions, calls, seen, sent, advance: ms => { now += ms; } };
}

const CONNECTION = Object.freeze({ id: 'local-1', client: 'claude-code' });

test('a local connection is one of the dispatcher\'s kinds, and its agent is labelled "(local)"', () => {
  assert.ok(AGENT_CONNECTION_KINDS.includes('local'));
  assert.deepEqual(OUTSIDE_CONNECTION_KINDS, ['connector', 'local']);
  assert.equal(agentLabel('Claude Code', { id: 'local-1', kind: 'local', client: 'claude-code', host: null }), 'Claude Code (local)');
  assert.throws(() => createAgentCalls({ actions: setup().actions, kind: 'chat', onResult: () => {} }), TypeError);
});

test('a call runs its action as the agent through the local connection, and answers with its step', async () => {
  const { calls, seen, sent } = setup();
  await calls.run({ id: 'a1', tool: 'color_by', args: { field: 'cell_type' }, agent: 'Claude Code', connection: CONNECTION });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].meta.origin, 'agent');
  assert.equal(seen[0].meta.agent, 'Claude Code');
  assert.deepEqual(seen[0].meta.connection, { id: 'local-1', kind: 'local', client: 'claude-code', host: null, known: false });
  const result = sent.results.get('a1');
  assert.equal(result.isError, false);
  assert.match(JSON.stringify(result.content), /Colored by cell_type/);
});

test('turns: one connection\'s calls are one turn until someone else acts or time passes', async () => {
  const { actions, calls, seen, advance } = setup();
  const run = (id, field, connection = CONNECTION) => calls.run({ id, tool: 'color_by', args: { field }, agent: 'Claude Code', connection });
  await run('a1', 'x');
  await run('a2', 'y');
  assert.equal(seen[0].meta.turn, seen[1].meta.turn);
  await actions.dispatch('color.by', { field: 'person' }, { origin: 'user' });
  await run('a3', 'z');
  assert.notEqual(seen[3].meta.turn, seen[1].meta.turn, 'the person acted: a new turn');
  advance(AGENT_TURN_IDLE_MS + 1);
  await run('a4', 'w');
  assert.notEqual(seen[4].meta.turn, seen[3].meta.turn, 'a long pause: a new turn');
  await run('a5', 'v', { id: 'local-2', client: null });
  assert.notEqual(seen[5].meta.turn, seen[4].meta.turn, 'another connection: its own turn');
});

test('an unknown tool and a refusal are tool errors of one sentence; nothing runs', async () => {
  const { calls, sent } = setup();
  await calls.run({ id: 'a1', tool: 'no_such_tool', args: {}, agent: 'Cursor', connection: CONNECTION });
  // The sentence; the person's settings follow it, as after a connection's first result.
  assert.equal(sent.results.get('a1').isError, true);
  assert.equal(sent.results.get('a1').content[0].text.split('\n')[0], 'Cellucid has no tool <cellucid-data>"no_such_tool"</cellucid-data>.');
  await calls.run({ id: 'a2', tool: 'color_by', args: { field: 'nope' }, agent: 'Cursor', connection: CONNECTION });
  assert.equal(sent.results.get('a2').isError, true);
  assert.match(sent.results.get('a2').content[0].text, /There is no field <cellucid-data>"nope"<\/cellucid-data>/);
  assert.equal(calls.has('color_by'), true);
  assert.equal(calls.has('no_such_tool'), false);
});

test('the person asked about a call is heard with the card\'s question; answering from the app settles it', async () => {
  const { actions, calls, sent } = setup({ questionFor: signal => (signal ? 'Claude Code (local) asks to save the session. It writes a file.' : null) });
  let answer = null;
  actions.setConfirmer(({ confirm, asking }) => {
    if (confirm === null) return true;
    asking();
    return new Promise(resolve => { answer = resolve; });
  });
  const running = calls.run({ id: 'a1', tool: 'session_save', args: {}, agent: 'Claude Code', connection: CONNECTION });
  while (sent.asking.length === 0) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.asking, [{ id: 'a1', detail: null, message: 'Claude Code (local) asks to save the session. It writes a file.' }]);
  assert.ok(calls.signalOf('a1') instanceof AbortSignal);
  answer(false);
  await running;
  assert.deepEqual(sent.answered, [{ id: 'a1', allowed: false }]);
  assert.equal(sent.results.get('a1').isError, true);
  assert.match(sent.results.get('a1').content[0].text, /The person declined/);
  assert.equal(calls.signalOf('a1'), null, 'a call that ended has no signal');
});

test('a call the app gave up on is stopped in the tab, and a stop answers it', async () => {
  const { calls, sent } = setup();
  const running = calls.run({ id: 'a1', tool: 'analysis_run', args: {}, agent: 'Claude Code', connection: CONNECTION });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.running(), ['a1']);
  calls.cancel('a1');
  await running;
  assert.equal(sent.results.get('a1').isError, true);
  assert.match(sent.results.get('a1').content[0].text, /Stopped before it finished/);
  assert.deepEqual(calls.running(), []);
});

test('one tool list whatever the settings; the settings are told after a connection\'s first result and after any result once they changed', async () => {
  let writes = 'ask';
  const asked = [];
  const { calls, sent } = setup({
    permissionFor: question => {
      asked.push(question);
      if (question.kind === 'writes-file') return question.connection.id === 'local-2' ? 'allow' : writes;
      return question.kind === 'change' ? 'allow' : 'ask';
    },
  });
  // The list: the same for every connection and every setting, saying none of them.
  const before = calls.list();
  writes = 'deny';
  assert.equal(calls.list(), before);
  assert.doesNotMatch(JSON.stringify(before), /person's settings|Cellucid asks the person before/);
  writes = 'ask';
  const note = id => sent.results.get(id).content[0].text.split('\n').slice(1).join('\n');
  // The first result of a connection tells the settings, as they hold for it.
  await calls.run({ id: 'a1', tool: 'fields_list', args: {}, agent: 'Claude Code', connection: CONNECTION });
  assert.match(note('a1'), /^\[Cellucid: the person's settings for you now\. Permissions: .*writing files[^.]*: are asked of the person first/);
  assert.match(note('a1'), /Reads of this dataset are not limited/);
  // Unchanged: not told again.
  await calls.run({ id: 'a2', tool: 'fields_list', args: {}, agent: 'Claude Code', connection: CONNECTION });
  assert.equal(note('a2'), '');
  // Changed: told after the next result (an error's too).
  writes = 'deny';
  await calls.run({ id: 'a3', tool: 'nope', args: {}, agent: 'Claude Code', connection: CONNECTION });
  assert.equal(sent.results.get('a3').isError, true);
  assert.match(note('a3'), /writing files: are refused/);
  // Another connection is told its own (what the person allowed for it).
  await calls.run({ id: 'a4', tool: 'fields_list', args: {}, agent: 'Cursor', connection: { id: 'local-2', client: 'cursor' } });
  assert.match(note('a4'), /writing files[^.]*: run without asking|run without asking[^.]*writing files/);
  assert.ok(asked.every(question => question.connection.kind === 'local'));
});

test('destroyed: a call is answered at once and nothing runs', async () => {
  const { calls, seen, sent } = setup();
  calls.destroy();
  await calls.run({ id: 'a1', tool: 'color_by', args: { field: 'x' }, agent: 'Claude Code', connection: CONNECTION });
  assert.equal(seen.length, 0);
  assert.equal(sent.results.get('a1').isError, true);
});

test('what the person did since a connection\'s last call is told with its next result, once; kept for the tab across a reload; another history shown is said', async () => {
  const { makePage } = await import('./history-fake-page.mjs');
  const { plainSentence } = await import('../assets/js/app/actions/targets/names.js');
  const { dispatcher, history, step } = await makePage();
  const stored = new Map();
  const seenStore = { get: key => stored.get(key) ?? null, set: (key, value) => stored.set(key, value) };
  // One engine per page life: a reload makes a new one, which reads what the tab kept.
  const engine = () => {
    const results = new Map();
    const calls = createAgentCalls({
      actions: dispatcher, kind: 'local', history: { current: () => history }, seenStore,
      onResult: (id, result) => results.set(id, result),
    });
    const call = async (id, tool, args = {}) => {
      await calls.run({ id, tool, args, agent: 'Claude Code', connection: CONNECTION });
      return results.get(id).content.map(item => plainSentence(item.text)).join('\n');
    };
    return { calls, call };
  };
  const SINCE = /\[Cellucid: Since your last turn/;
  let page = engine();
  assert.doesNotMatch(await page.call('c1', 'a_set', { v: 2 }), SINCE, 'a first call has nothing to be told');
  assert.doesNotMatch(await page.call('c2', 'b_inc'), SINCE, 'its own steps are no news');
  // The person acts between calls: told once, with the next result.
  await step('cam.set', { v: 4 });
  const told = await page.call('c3', 'b_inc');
  assert.match(told, /\[Cellucid: Since your last turn the history changed: The person's step "cam 4" is now in effect\./);
  assert.doesNotMatch(await page.call('c4', 'b_inc'), SINCE, 'said once');
  // The person undoes the connection's last step; the tab reloads (a new engine): still told.
  await history.undo();
  page.calls.destroy();
  page = engine();
  assert.match(await page.call('c5', 'cam_set', { v: 1 }), /Your step "b \+ 1" was undone \(kept for redo, no longer in effect\)/);
  // Another history shown (a tracker started by the person): which one, and what is in effect there.
  await history.startTracker({ start: 'shown', name: 'Second look' });
  assert.match(await page.call('c6', 'b_inc'), /\[Cellucid: Since your last turn the person changed what is shown: the history shown is now "Second look" \(it was "[^"]+"\); no step is in effect there yet\./);
  // A record the tab kept that is not one is ignored (nothing told, no failure).
  for (const key of stored.keys()) stored.set(key, '{"seen": {"tracker": 3}, "turns": []}');
  page.calls.destroy();
  page = engine();
  assert.doesNotMatch(await page.call('c7', 'b_inc'), SINCE);
  page.calls.destroy();
});
