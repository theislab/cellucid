/**
 * The tab's end of the Cellucid relay (`app/agent/bridge/relay-client.js`)
 * over a fake WebSocket and a manual clock: pairing and the subprotocol
 * proof, tool calls dispatched as the agent with turns, tool lists, stopping
 * a call, approvals, connections and Forget, focus reports, reconnection
 * over changing links, and the page wiring that claims a link's code.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { ActionRefused, createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { quoteName } from '../assets/js/app/actions/targets/names.js';
import { AGENT_TURN_IDLE_MS } from '../assets/js/app/agent/bridge/agent-calls.js';
import {
  DEFAULT_RELAY_ORIGIN,
  createRelayClient,
  relayOriginForPage,
  startRelayClientForPage,
} from '../assets/js/app/agent/bridge/relay-client.js';
import { resultDataOf } from '../assets/js/app/agent/bridge/mcp-content.js';
import { RELAY_CLOSE, RELAY_PROTOCOL_VERSION, RESULT_TEXT_CHARS } from '../assets/js/app/agent/bridge/relay-protocol.js';
import { TAB_SECRET_STORAGE_KEY, ensureTabSecret, forgetTabSecret, readTabSecret } from '../assets/js/app/agent/bridge/tab-secret.js';

const RELAY = 'https://relay.test';
const NO_PARAMS = { type: 'object', additionalProperties: false, properties: {} };

class FakeWebSocket {
  static made = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    this.closedWith = null;
    /** The relay platform answers the keep-alive; a dead link does not. */
    this.answersPing = true;
    FakeWebSocket.made.push(this);
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
    if (data === 'ping' && this.answersPing) this.receive('pong');
  }

  close(code, reason) {
    this.readyState = 3;
    this.closedWith = { code, reason };
  }

  welcome(protocol = RELAY_PROTOCOL_VERSION) {
    this.readyState = 1;
    this.receive({ type: 'welcome', protocol });
  }

  receive(message) {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  serverClose(code, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  json(type = null) {
    return this.sent.filter(text => text.startsWith('{')).map(text => JSON.parse(text)).filter(message => type === null || message.type === type);
  }
}

function manualClock(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    random: () => 0.5,
    setTimeout(callback, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function page() {
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  doc.focused = true;
  doc.hasFocus = () => doc.focused;
  return { win, doc };
}

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

/**
 * The relay's claim endpoint as the page reaches it: every request is kept
 * (`calls`, with its init), and answered when the test says (`answer(index,
 * status, body)`), or it never is.
 */
function claimEndpoint() {
  const calls = [];
  const impl = (url, init) => new Promise((resolve, reject) => {
    calls.push({ url, init, body: JSON.parse(init.body), resolve, reject });
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  return {
    calls,
    impl,
    answer(index, status, body) {
      calls[index].resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
    },
  };
}

function setup({ secret = true, storage = memoryStorage(), fields = null, permissionFor = undefined } = {}) {
  FakeWebSocket.made = [];
  const catalog = createActionCatalog(DEFINITIONS);
  const actions = createActionDispatcher({ catalog });
  let stepNumber = 0;
  actions.setRecorder({
    before: async ({ definition, params, meta }) => ({ definition, params, meta }),
    after: async (token, outcome) => (outcome?.unchanged ? null : { id: `s${++stepNumber}`, label: token.definition.describe(token.params, outcome) }),
    failed: async () => {},
    observed: async ({ definition, params }) => ({ id: `s${++stepNumber}`, label: definition.describe(params, null) }),
  });
  const seen = [];
  actions.provide('session.save', () => ({ written: true }));
  actions.provide('fields.list', (params, { meta }) => {
    seen.push({ type: 'fields.list', meta });
    return fields ?? { fields: ['cell_type', 'leiden'], counts: new Uint32Array([3, 4]) };
  });
  actions.provide('color.by', (params, { meta }) => {
    seen.push({ type: 'color.by', params, meta });
    if (params.field === 'nope') throw new ActionRefused(`There is no field ${quoteName('nope')}; the fields are cell_type, leiden`);
    return { field: params.field };
  });
  let release = null;
  actions.provide('analysis.run', (params, { signal, meta }) => {
    seen.push({ type: 'analysis.run', meta });
    return new Promise((resolve, reject) => {
      release = resolve;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  if (secret) ensureTabSecret({ storage });
  const clock = manualClock();
  const { win, doc } = page();
  const events = { approvals: [], statuses: [], connections: 0 };
  const claims = claimEndpoint();
  const client = createRelayClient({
    relayOrigin: RELAY,
    actions,
    secrets: { read: () => readTabSecret({ storage }), ensure: () => ensureTabSecret({ storage }), forget: () => forgetTabSecret({ storage }) },
    WebSocketImpl: FakeWebSocket,
    fetchImpl: claims.impl,
    win,
    doc,
    version: '0.9.6',
    datasetName: () => 'Pancreas',
    ...(permissionFor === undefined ? {} : { permissionFor }),
    onApproval: approval => events.approvals.push(approval),
    onStatus: status => events.statuses.push(status),
    onConnectionsChanged: () => { events.connections += 1; },
    clock,
  });
  return { client, actions, seen, clock, win, doc, storage, events, claims, release: value => release(value) };
}

async function flush() {
  for (let index = 0; index < 20; index += 1) await new Promise(resolve => setImmediate(resolve));
}

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.WebSocket;
  delete globalThis.localStorage;
});

test('a browser that never paired stays off; connect() pairs it and proves the secret in the subprotocol', () => {
  const storage = memoryStorage();
  const { client } = setup({ secret: false, storage });
  assert.equal(client.start(), false);
  assert.equal(client.status().state, 'off');
  assert.equal(FakeWebSocket.made.length, 0);
  client.connect();
  const secret = storage.values.get(TAB_SECRET_STORAGE_KEY);
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  const [socket] = FakeWebSocket.made;
  assert.equal(socket.url, 'wss://relay.test/tab');
  assert.deepEqual(socket.protocols, ['cellucid-relay.2', `cellucid-secret.${secret}`]);
  assert.equal(client.status().state, 'connecting');
});

test('welcome: connected, and the tab reports focus, visibility, dataset and version, again on each change', () => {
  const { client, win, doc, events } = setup();
  client.start();
  const [socket] = FakeWebSocket.made;
  socket.welcome();
  assert.equal(events.statuses.at(-1).state, 'connected');
  assert.deepEqual(socket.json('state'), [{ type: 'state', focused: true, visible: true, dataset: 'Pancreas', version: '0.9.6' }]);
  doc.focused = false;
  win.dispatchEvent(new Event('blur'));
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(socket.json('state').slice(1).map(({ focused, visible }) => [focused, visible]), [[false, true], [false, false]]);
});

test('a call runs its action as the agent and answers with the step it made', async () => {
  const { client, seen } = setup();
  client.start();
  const [socket] = FakeWebSocket.made;
  socket.welcome();
  socket.receive({ type: 'call', id: 'c1', tool: 'color_by', args: { field: 'cell_type' }, agent: 'Claude', grant: 'g1' });
  await flush();
  const [result] = socket.json('result');
  assert.deepEqual(result, {
    type: 'result', id: 'c1',
    result: {
      content: [{
        type: 'text',
        // The connection's first result: the person's settings follow it.
        text: '<cellucid-data>{"step":{"id":"s1","label":"Colored by cell_type"},"result":{"field":"cell_type"}}</cellucid-data>\n'
          + '[Cellucid: the person\'s settings for you now. Reads of this dataset are not limited (values of cells and pictures of the plot included).]',
      }],
      isError: false,
    },
  });
  assert.equal(seen[0].meta.origin, 'agent');
  assert.equal(seen[0].meta.agent, 'Claude');
  assert.match(seen[0].meta.turn, /^turn-/);

  socket.receive({ type: 'call', id: 'c2', tool: 'fields_list', args: {}, agent: 'Claude', grant: 'g1' });
  await flush();
  const read = socket.json('result').find(message => message.id === 'c2');
  assert.deepEqual(JSON.parse(resultDataOf(read.result.content[0].text)), { fields: ['cell_type', 'leiden'], counts: [3, 4] });

  socket.receive({ type: 'call', id: 'c3', tool: 'nothing_here', args: {}, agent: 'Claude', grant: 'g1' });
  socket.receive({ type: 'call', id: 'c4', tool: 'color_by', args: { field: 'nope' }, agent: 'Claude', grant: 'g1' });
  socket.receive({ type: 'call', id: 'c5', tool: 'color_by', args: { colour: 'red' }, agent: 'Claude', grant: 'g1' });
  socket.receive({ type: 'call', id: 'c6', tool: 'session_save', args: {}, agent: 'Claude', grant: 'g1' });
  await flush();
  const answers = Object.fromEntries(socket.json('result').map(message => [message.id, message]));
  assert.deepEqual(answers.c3.error, { code: 'unknown-tool', message: 'Cellucid has no tool "nothing_here"' });
  assert.deepEqual(answers.c4.result, { content: [{ type: 'text', text: 'There is no field <cellucid-data>"nope"</cellucid-data>; the fields are cell_type, leiden' }], isError: true });
  assert.equal(answers.c5.result.isError, true);
  assert.match(answers.c5.result.content[0].text, /color/);
  // No confirmer on this page: an action that asks first is refused, not run.
  assert.equal(answers.c6.result.isError, true);
  assert.match(answers.c6.result.content[0].text, /needs the person's go-ahead/);
});

test('turns: one connection\'s calls are one turn until someone else acts, time passes, or another connection calls', async () => {
  const { client, seen, clock, actions } = setup();
  client.start();
  const [socket] = FakeWebSocket.made;
  socket.welcome();
  const call = async (id, grant = 'g1') => {
    const before = seen.length;
    socket.receive({ type: 'call', id, tool: 'color_by', args: { field: 'cell_type' }, agent: 'Claude', grant });
    await flush();
    assert.equal(seen.length, before + 1, `call ${id} ran`);
    assert.ok(socket.json('result').some(message => message.id === id), `call ${id} was answered`);
    return seen.at(-1).meta.turn;
  };
  const first = await call('a');
  assert.equal(await call('b'), first);
  clock.advance(AGENT_TURN_IDLE_MS);
  assert.equal(await call('c'), first, 'exactly the idle time still belongs');
  const other = await call('d', 'g2');
  assert.notEqual(other, first);
  assert.equal(await call('e'), first, 'the other connection has its own turn');
  // The person makes a step: the next call is a new turn.
  await actions.dispatch('color.by', { field: 'leiden' });
  const afterPerson = await call('f');
  assert.notEqual(afterPerson, first);
  clock.advance(AGENT_TURN_IDLE_MS + 1);
  assert.notEqual(await call('g'), afterPerson);
});

test('the tool list is the catalogue as MCP tools', () => {
  const { client } = setup();
  client.start();
  const [socket] = FakeWebSocket.made;
  socket.welcome();
  socket.receive({ type: 'list', id: 'l1' });
  const [answer] = socket.json('tools');
  assert.deepEqual(answer.tools.map(tool => tool.name), ['analysis_run', 'color_by', 'fields_list', 'session_save']);
  assert.deepEqual(answer.tools.find(tool => tool.name === 'session_save').annotations, {
    title: 'Save the session', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false,
  });
});

test('a cancelled call is stopped in the tab, and calls still running when the link drops are stopped too', async () => {
  const { client, seen } = setup();
  client.start();
  const [socket] = FakeWebSocket.made;
  socket.welcome();
  socket.receive({ type: 'call', id: 'slow', tool: 'analysis_run', args: {}, agent: 'ChatGPT', grant: 'g1' });
  await flush();
  socket.receive({ type: 'cancel', id: 'slow' });
  await flush();
  const stopped = socket.json('result').find(message => message.id === 'slow');
  assert.equal(stopped.result.isError, true);
  assert.match(stopped.result.content[0].text, /Stopped before it finished: The agent stopped waiting/);

  socket.receive({ type: 'call', id: 'slow2', tool: 'analysis_run', args: {}, agent: 'ChatGPT', grant: 'g1' });
  await flush();
  const running = seen.at(-1).meta.signal;
  assert.equal(running.aborted, false);
  socket.serverClose(1006);
  await flush();
  assert.equal(running.aborted, true);
  assert.equal(running.reason.kind, 'closed');
  // The relay already told the agent; the stopped call is not sent on a closed link.
  assert.equal(socket.json('result').some(message => message.id === 'slow2'), false);
});

test('a result longer than a chat accepts is cut with both counts stated', async () => {
  const { client } = setup({ fields: { rows: 'x'.repeat(RESULT_TEXT_CHARS * 2) } });
  client.start();
  const [socket] = FakeWebSocket.made;
  socket.welcome();
  socket.receive({ type: 'call', id: 'big', tool: 'fields_list', args: {}, agent: 'Claude', grant: 'g1' });
  await flush();
  const [answer] = socket.json('result');
  const text = answer.result.content[0].text;
  assert.equal(answer.result.isError, false);
  assert.equal(text.length, RESULT_TEXT_CHARS);
  assert.match(text, /\[Cellucid: this result is 300,011 characters; the first 149,\d{3} are shown\. Ask for fewer rows or a narrower read to see the rest\.\]$/);
});

test('reconnecting: growing waits with jitter, at once when back online or shown, and a link that stops answering is replaced', () => {
  const { client, clock, win, doc, events } = setup();
  client.start();
  FakeWebSocket.made[0].serverClose(1006);
  assert.equal(events.statuses.at(-1).state, 'retrying');
  assert.equal(events.statuses.at(-1).retryAt, clock.now() + 750);
  clock.advance(750);
  assert.equal(FakeWebSocket.made.length, 2);
  FakeWebSocket.made[1].serverClose(1006);
  assert.equal(events.statuses.at(-1).retryAt, clock.now() + 1500);
  win.dispatchEvent(new Event('online'));
  assert.equal(FakeWebSocket.made.length, 3, 'back online: retried at once');
  FakeWebSocket.made[2].serverClose(1006);
  doc.visibilityState = 'visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(FakeWebSocket.made.length, 4, 'shown again: retried at once');
  // A welcome resets the waits.
  FakeWebSocket.made[3].welcome();
  FakeWebSocket.made[3].serverClose(1006);
  assert.equal(events.statuses.at(-1).retryAt, clock.now() + 750);
  clock.advance(750);
  const socket = FakeWebSocket.made[4];
  socket.answersPing = false;
  socket.welcome();
  // Keep-alive: a ping each tick; an unanswered one replaces the link.
  clock.advance(30_000);
  assert.deepEqual(socket.sent.filter(text => text === 'ping'), ['ping']);
  socket.receive('pong');
  clock.advance(30_000);
  assert.equal(socket.sent.filter(text => text === 'ping').length, 2);
  clock.advance(30_000);
  assert.deepEqual(socket.closedWith, { code: 4000, reason: 'unanswered' });
  assert.equal(events.statuses.at(-1).state, 'retrying');
  // A socket that is never welcomed is given up on at the first tick.
  clock.advance(750);
  const stalled = FakeWebSocket.made[5];
  clock.advance(30_000);
  assert.deepEqual(stalled.closedWith, { code: 4000, reason: 'no welcome' });
  // The longest wait between attempts is a minute.
  for (let index = 0; index < 12; index += 1) {
    clock.advance(60_000);
    FakeWebSocket.made.at(-1).serverClose(1006);
  }
  assert.ok(events.statuses.at(-1).retryAt - clock.now() <= 60_000);
});

test('the relay forgets the pairing or speaks another protocol: the tab stops instead of retrying', () => {
  const forgotten = setup();
  forgotten.client.start();
  FakeWebSocket.made[0].welcome();
  FakeWebSocket.made[0].serverClose(RELAY_CLOSE.forgotten, 'forgotten');
  assert.equal(forgotten.events.statuses.at(-1).state, 'off');
  forgotten.clock.advance(120_000);
  assert.equal(FakeWebSocket.made.length, 1);

  const older = setup();
  older.client.start();
  FakeWebSocket.made[0].serverClose(RELAY_CLOSE.protocol, 'protocol');
  assert.equal(older.events.statuses.at(-1).state, 'refused');
  assert.match(older.events.statuses.at(-1).error, /Reload the page/);

  const newer = setup();
  newer.client.start();
  FakeWebSocket.made[0].welcome(RELAY_PROTOCOL_VERSION + 1);
  assert.equal(newer.events.statuses.at(-1).state, 'refused');
  assert.deepEqual(FakeWebSocket.made[0].closedWith, { code: 1000, reason: 'protocol' });
  newer.clock.advance(120_000);
  assert.equal(FakeWebSocket.made.length, 1);
});

test('approvals: a code is claimed as this browser (its cookies and tab secret); allow and deny answer it; a refused claim says why', async () => {
  const { client, clock, events, claims, storage } = setup();
  client.start();
  const [socket] = FakeWebSocket.made;
  // The claim is a credentialed request to the relay, never a socket message: the
  // relay answers only the browser whose cookie the waiting page set.
  const claiming = client.claim('abcd efgh', { via: 'typed' });
  assert.equal(claims.calls.length, 1);
  const [claim] = claims.calls;
  assert.equal(claim.url, `${RELAY}/oauth/claim`);
  assert.equal(claim.init.method, 'POST');
  assert.equal(claim.init.credentials, 'include');
  assert.equal(claim.init.cache, 'no-store');
  assert.deepEqual(claim.body, { code: 'ABCDEFGH', secret: storage.values.get(TAB_SECRET_STORAGE_KEY) });
  assert.equal(socket.json('claim').length, 0);
  socket.welcome();
  assert.equal(socket.json('claim').length, 0);
  const client2 = { agent: 'Claude', name: 'Claude', host: 'claude.ai', redirectHost: 'claude.ai', loopback: false, known: true, registration: 'registered' };
  claims.answer(0, 200, { ok: true, value: { client: client2, expiresAt: clock.now() + 600_000 } });
  const approval = await claiming;
  assert.equal(approval.display, 'ABCD-EFGH');
  assert.equal(approval.via, 'typed');
  assert.deepEqual(approval.client, client2);
  assert.deepEqual(events.approvals, [approval]);
  assert.deepEqual(client.status().approvals, [approval]);

  const allowing = client.approve('ABCD-EFGH');
  const [decide] = socket.json('decide');
  assert.deepEqual({ code: decide.code, allow: decide.allow }, { code: 'ABCDEFGH', allow: true });
  socket.receive({ type: 'reply', ref: decide.ref, ok: true, value: { status: 'approved' } });
  await allowing;
  assert.deepEqual(client.status().approvals, []);

  const refused = client.claim('00000000');
  claims.answer(1, 200, { ok: false, error: { code: 'unknown', message: 'This connect code is unknown or has expired.' } });
  await assert.rejects(refused, { code: 'unknown', message: 'This connect code is unknown or has expired.' });
  const elsewhere = client.claim('22223333', { via: 'link' });
  claims.answer(2, 200, { ok: false, error: { code: 'other-browser', message: 'This connect code was started in another browser, so it cannot connect this one.' } });
  await assert.rejects(elsewhere, { code: 'other-browser', message: /started in another browser/ });
  const malformed = client.claim('55556666');
  claims.answer(3, 403, { error: 'Only a Cellucid page claims a connect code' });
  await assert.rejects(malformed, { code: 'refused' });
  await assert.rejects(client.claim('ABC-123'), { code: 'not-a-code' });
  await assert.rejects(client.claim('ABCD-EFGU'), { code: 'not-a-code' }, 'U is not a code symbol');
  assert.equal(claims.calls.length, 4, 'a text that is no code is never sent');

  // An approval nobody answers is dropped when its code expires.
  const expiring = client.claim('11112222');
  claims.answer(4, 200, { ok: true, value: { client: client2, expiresAt: clock.now() + 1000 } });
  await expiring;
  assert.equal(client.status().approvals.length, 1);
  clock.advance(1000);
  assert.equal(client.status().approvals.length, 0);

  // A relay that does not answer: the claim, and a decision, fail after a while.
  const unanswered = client.claim('44445555');
  clock.advance(20_000);
  await assert.rejects(unanswered, { code: 'relay-unanswered' });
  const silent = client.deny('33334444');
  clock.advance(20_000);
  await assert.rejects(silent, { code: 'relay-unanswered' });
});

test('an app no site vouches for acts under the name Manage… gives it; two of them are told apart', async () => {
  const { client, seen } = setup();
  client.start();
  const [socket] = FakeWebSocket.made;
  socket.welcome();
  socket.receive({ type: 'call', id: 'u1', tool: 'color_by', args: { field: 'cell_type' }, agent: 'An app on this computer', grant: 'g1', client: 'Claude', host: null, known: false });
  socket.receive({ type: 'call', id: 'u2', tool: 'color_by', args: { field: 'leiden' }, agent: 'An app on this computer', grant: 'g2', client: 'Claude on my phone', host: null, known: false });
  socket.receive({ type: 'call', id: 'v1', tool: 'color_by', args: { field: 'cell_type' }, agent: 'Claude', grant: 'g3', client: 'Claude Desktop', host: 'claude.ai', known: true });
  await flush();
  assert.deepEqual(seen.filter(each => each.type === 'color.by').map(each => each.meta.agent), [
    'An app on this computer (calls itself “Claude”)', 'An app on this computer (calls itself “Claude on my phone”)', 'Claude',
  ]);
  client.destroy();
});

test('connections, disconnect and forget', async () => {
  const { client, storage, events } = setup();
  client.start();
  const [socket] = FakeWebSocket.made;
  socket.welcome();
  const listing = client.connections();
  const ask = socket.json('connections')[0];
  socket.receive({ type: 'reply', ref: ask.ref, ok: true, value: [{ grant: 'g1', agent: 'Claude' }] });
  assert.deepEqual(await listing, [{ grant: 'g1', agent: 'Claude' }]);
  const removing = client.disconnect('g1');
  const remove = socket.json('disconnect')[0];
  assert.equal(remove.grant, 'g1');
  socket.receive({ type: 'reply', ref: remove.ref, ok: true, value: { removed: true } });
  assert.deepEqual(await removing, { removed: true });
  socket.receive({ type: 'event', name: 'connections-changed' });
  assert.equal(events.connections, 1);

  const forgetting = client.forget();
  const forget = socket.json('forget')[0];
  socket.receive({ type: 'reply', ref: forget.ref, ok: true, value: { forgotten: true } });
  assert.deepEqual(await forgetting, { revokedAtRelay: true });
  assert.equal(storage.values.has(TAB_SECRET_STORAGE_KEY), false);
  assert.equal(events.statuses.at(-1).state, 'off');
  assert.equal(client.start(), false, 'no secret: nothing to connect with');

  // Forget without the relay still deletes the secret.
  const offline = setup();
  assert.deepEqual(await offline.client.forget(), { revokedAtRelay: false });
  assert.equal(offline.storage.values.has(TAB_SECRET_STORAGE_KEY), false);
});

test('the page hiding closes the link and showing it reconnects; stop and destroy end it', () => {
  const { client, win, events } = setup();
  client.start();
  FakeWebSocket.made[0].welcome();
  win.dispatchEvent(new Event('pagehide'));
  assert.deepEqual(FakeWebSocket.made[0].closedWith, { code: 1001, reason: 'page hidden' });
  win.dispatchEvent(new Event('pageshow'));
  assert.equal(FakeWebSocket.made.length, 2);
  client.stop();
  assert.deepEqual(FakeWebSocket.made[1].closedWith, { code: 1000, reason: 'stopped' });
  assert.equal(events.statuses.at(-1).state, 'off');
  win.dispatchEvent(new Event('online'));
  assert.equal(FakeWebSocket.made.length, 2, 'stopped: no listener left');
  client.destroy();
});

test('storage that refuses: the client says the browser keeps no data, without throwing at start', () => {
  const refusing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const { client, events } = setup({ secret: false, storage: refusing });
  assert.equal(client.start(), false);
  assert.equal(events.statuses.at(-1).state, 'unavailable');
  assert.match(events.statuses.at(-1).error, /keeps no data for Cellucid/);
  assert.throws(() => client.connect(), { name: 'TabSecretError' });
});

test('the relay address: the deployed one, or a development override on a development host only', () => {
  assert.equal(relayOriginForPage(undefined), DEFAULT_RELAY_ORIGIN);
  globalThis.window = { location: { hostname: 'www.cellucid.com', protocol: 'https:' }, __CELLUCID_RELAY_ORIGIN__: 'https://evil.example' };
  assert.equal(relayOriginForPage(globalThis.window), DEFAULT_RELAY_ORIGIN);
  globalThis.window = { location: { hostname: 'localhost', protocol: 'http:' }, __CELLUCID_RELAY_ORIGIN__: 'http://localhost:8787' };
  assert.equal(relayOriginForPage(globalThis.window), 'http://localhost:8787');
  globalThis.window.__CELLUCID_RELAY_ORIGIN__ = 'http://relay.example';
  assert.throws(() => relayOriginForPage(globalThis.window), /exact https/);
  // Plain http only on a loopback host a browser trusts: never 0.0.0.0 (the tab secret goes there).
  globalThis.window.__CELLUCID_RELAY_ORIGIN__ = 'http://0.0.0.0:8787';
  assert.throws(() => relayOriginForPage(globalThis.window), /exact https/);
  globalThis.window.__CELLUCID_RELAY_ORIGIN__ = 'http://127.0.0.1:8787';
  assert.equal(relayOriginForPage(globalThis.window), 'http://127.0.0.1:8787');
  assert.throws(() => createRelayClient({ relayOrigin: 'https://relay.test/', actions: { catalog: createActionCatalog([]), subscribe: () => () => {} } }), /not exact/);
});

test('the page wiring claims the code the page was opened with, pairing the browser first', async () => {
  const storage = memoryStorage();
  const { win, doc } = page();
  win.cellucidConnectFragment = 'WXYZ-2345';
  win.location = { hostname: 'www.cellucid.com', protocol: 'https:' };
  doc.querySelector = selector => (selector === 'meta[name="cellucid-version"]' ? { getAttribute: () => '0.9.6' } : null);
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.WebSocket = FakeWebSocket;
  globalThis.localStorage = storage;
  FakeWebSocket.made = [];
  const actions = createActionDispatcher({ catalog: createActionCatalog(DEFINITIONS) });
  const approvals = [];
  const claims = claimEndpoint();
  globalThis.fetch = claims.impl;
  const client = startRelayClientForPage({ actions, onApproval: approval => approvals.push(approval) });
  assert.equal(win.cellucidConnectFragment, undefined, 'the code is taken once');
  assert.match(storage.values.get(TAB_SECRET_STORAGE_KEY), /^[A-Za-z0-9_-]{43}$/);
  const [socket] = FakeWebSocket.made;
  assert.equal(socket.url, `${DEFAULT_RELAY_ORIGIN.replace('https', 'wss')}/tab`);
  socket.welcome();
  const [claim] = claims.calls;
  assert.equal(claim.url, `${DEFAULT_RELAY_ORIGIN}/oauth/claim`);
  assert.equal(claim.init.credentials, 'include');
  assert.equal(claim.body.code, 'WXYZ2345');
  assert.equal(socket.json('state')[0].version, '0.9.6');
  claims.answer(0, 200, { ok: true, value: { client: { agent: 'ChatGPT' }, expiresAt: Date.now() + 60_000 } });
  await flush();
  assert.equal(approvals[0].via, 'link');
  client.destroy();

  // Without a code and without a pairing, the page does not connect.
  FakeWebSocket.made = [];
  const quiet = startRelayClientForPage({ actions: createActionDispatcher({ catalog: createActionCatalog(DEFINITIONS) }) });
  storage.values.clear();
  assert.equal(FakeWebSocket.made.length, 1, 'paired above: it reconnects');
  quiet.destroy();
  FakeWebSocket.made = [];
  startRelayClientForPage({ actions: createActionDispatcher({ catalog: createActionCatalog(DEFINITIONS) }) }).destroy();
  assert.equal(FakeWebSocket.made.length, 0);
});

test('a call names its connection; the person asked about it is heard by the relay; a call detached at its time keeps running across a dropped link', async () => {
  const { client, actions } = setup();
  const asked = [];
  let answer = null;
  // The person is asked about what cannot be undone (`asking`); any other change runs.
  actions.setConfirmer(({ meta, detail, confirm, asking }) => {
    if (confirm === null) return true;
    asked.push({ connection: meta.connection, detail });
    asking();
    return new Promise(resolve => { answer = resolve; });
  });
  const done = [];
  actions.subscribe(event => { if (event.kind === 'done' && event.type === 'session.save') done.push(event); });
  client.start();
  const [socket] = FakeWebSocket.made;
  socket.welcome();
  socket.receive({ type: 'call', id: 'w1', tool: 'session_save', args: {}, agent: 'Claude', grant: 'g1', client: 'Claude Code', host: 'claude.ai', known: true });
  await flush();
  assert.deepEqual(asked, [{ connection: { id: 'g1', kind: 'connector', client: 'Claude Code', host: 'claude.ai', known: true }, detail: null }]);
  assert.deepEqual(socket.json('asking'), [{ type: 'asking', id: 'w1', detail: null }]);
  // The agent's time ran out: detached. The link dropping then does not withdraw the question.
  socket.receive({ type: 'detach', id: 'w1' });
  socket.serverClose(1006);
  await flush();
  answer(true);
  await flush();
  assert.equal(done.length, 1, 'the person allowed it, so it ran');
  assert.equal(done[0].meta.connection.id, 'g1');
});

test('one tool list for every connection whatever its settings; each connection is told its settings after its results', async () => {
  let writes = 'ask';
  const { client } = setup({
    permissionFor: ({ kind, connection }) => {
      if (kind === 'writes-file') return connection.id === 'g2' ? 'allow' : writes;
      return kind === 'change' ? 'allow' : 'ask';
    },
  });
  client.start();
  const [socket] = FakeWebSocket.made;
  socket.welcome();
  for (const [id, grant] of [['l1', 'g1'], ['l2', 'g2']]) socket.receive({ type: 'list', id, grant });
  await flush();
  const lists = socket.json('tools');
  assert.deepEqual(lists[0].tools, lists[1].tools);
  assert.doesNotMatch(JSON.stringify(lists[0].tools), /person's settings|Cellucid asks the person before/);
  const told = id => socket.json('result').find(message => message.id === id).result.content[0].text.split('\n').slice(1).join('\n');
  socket.receive({ type: 'call', id: 'c1', tool: 'fields_list', args: {}, agent: 'Claude', grant: 'g1' });
  socket.receive({ type: 'call', id: 'c2', tool: 'fields_list', args: {}, agent: 'Claude', grant: 'g2' });
  await flush();
  assert.match(told('c1'), /writing files[^.]*: are asked of the person first/);
  assert.match(told('c2'), /writing files[^.]*: run without asking|run without asking[^.]*writing files/);
  socket.receive({ type: 'call', id: 'c3', tool: 'fields_list', args: {}, agent: 'Claude', grant: 'g1' });
  await flush();
  assert.equal(told('c3'), '', 'told once while unchanged');
  writes = 'deny';
  socket.receive({ type: 'call', id: 'c4', tool: 'fields_list', args: {}, agent: 'Claude', grant: 'g1' });
  await flush();
  assert.match(told('c4'), /writing files: are refused/);
});

