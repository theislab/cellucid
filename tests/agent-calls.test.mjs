/**
 * The calls of agents from outside the tab (`app/agent/bridge/agent-calls.js`),
 * as a local agent connection (`cellucid mcp` over the viewer channel) makes
 * them: dispatched as the agent through a `local` connection, with turns; the
 * tool list as that connection may use it; the person asked about a call
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
    type: 'color.by', title: 'Colour by a field', summary: 'Colour the cells by a field.', group: 'Colouring',
    params: { type: 'object', additionalProperties: false, required: ['field'], properties: { field: { type: 'string' } } },
    touches: ['active-field'], reads: [], effect: 'view', describe: params => `Coloured by ${params.field}`, code: params => `color_by("${params.field}")`,
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
  assert.deepEqual(seen[0].meta.connection, { id: 'local-1', kind: 'local', client: 'claude-code', host: null });
  const result = sent.results.get('a1');
  assert.equal(result.isError, false);
  assert.match(JSON.stringify(result.content), /Coloured by cell_type/);
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
  assert.deepEqual(sent.results.get('a1'), { content: [{ type: 'text', text: 'Cellucid has no tool <cellucid-data>"no_such_tool"</cellucid-data>.' }], isError: true });
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

test('the tool list says what the person\'s settings make of each kind, for the local connection asking', () => {
  const asked = [];
  const { calls } = setup({
    permissionFor: question => {
      asked.push(question);
      return question.connection.id === 'local-2' && question.kind === 'writes-file' ? 'allow' : null;
    },
  });
  const description = (list, name) => list.find(tool => tool.name === name).description;
  const one = calls.list('local-1');
  const two = calls.list('local-2');
  assert.match(description(one, 'session_save'), /Cellucid asks the person before it writes the file\.$/);
  assert.match(description(two, 'session_save'), /The person's settings let this run without asking\.$/);
  assert.ok(asked.every(question => question.connection.kind === 'local'));
  assert.deepEqual(calls.list(null).map(tool => tool.name), one.map(tool => tool.name));
});

test('destroyed: a call is answered at once and nothing runs', async () => {
  const { calls, seen, sent } = setup();
  calls.destroy();
  await calls.run({ id: 'a1', tool: 'color_by', args: { field: 'x' }, agent: 'Claude Code', connection: CONNECTION });
  assert.equal(seen.length, 0);
  assert.equal(sent.results.get('a1').isError, true);
});
