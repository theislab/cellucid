/**
 * The chat bar's core (`assets/js/app/agent/chat/`) without a page: a
 * conversation and what of it a model is sent and the history keeps, the
 * context budget and the summarising rule, one agent turn run against the
 * scripted model and a real dispatcher and history (steps labelled with the
 * agent and the turn, Undo turn, refusals back to the model, waiting out a
 * provider, Stop mid-reply and mid-call, a conversation too long, a refusal,
 * an answer cut at its limit, the effort chosen, a chat's token budget),
 * what left the browser in a turn, a chat exported and a turn as a note, the
 * first prompts offered, where a turn's steps are in the history and how the
 * chat and the history find each other, where API keys are kept, the
 * remembered choices, how many conversations a save would carry, and
 * Markdown.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SUMMARY_LEAD, TRANSCRIPT_SCHEMA, appendMessage, conversationFrom, createConversation, latestConversation,
  modelMessages, sentOf, summarize, transcriptOf, turnsOf, usageOf, closeInterrupted,
} from '../assets/js/app/agent/chat/conversation.js';
import { conversationMarkdown, turnNoteOf } from '../assets/js/app/agent/chat/export.js';
import { readSuggestionFacts, suggestionsFor } from '../assets/js/app/agent/chat/suggestions.js';
import {
  registerStepRevealer, registerTurnLink, revealStep, revealTurn, stepsOfTurn, subscribeTurns, turnSteps, turnsChanged,
  undoAgentTurn,
} from '../assets/js/app/agent/history-link.js';
import { CHARS_PER_TOKEN, estimateTokens, overflows, summaryInputOf } from '../assets/js/app/agent/chat/context.js';
import { RETRY_CEILING_MS, retryDelayOf, runAgentTurn } from '../assets/js/app/agent/chat/agent-loop.js';
import { createKeyStore, keyStorageName } from '../assets/js/app/agent/chat/keys.js';
import { PREFERENCES_STORAGE_KEY, effortKey, readChatPreferences, writeChatPreferences } from '../assets/js/app/agent/chat/preferences.js';
import { parseInline, parseMarkdown } from '../assets/js/app/agent/chat/markdown.js';
import { sentText, tokensText, toolRowText, workingTextOf } from '../assets/js/app/agent/chat/transcript-view.js';
import { createScriptedProvider } from '../assets/js/app/agent/providers/scripted.js';
import { ASKED_TEXT, ASK_TOOL, askOf, pendingQuestion } from '../assets/js/app/agent/chat/ask.js';
import { openaiToolsOf } from '../assets/js/app/agent/providers/openai.js';
import { ProviderError } from '../assets/js/app/agent/providers/contract.js';
import { mcpToolsOf, toolIndexOf } from '../assets/js/app/agent/bridge/mcp-tools.js';
import { page as fixturePage, setup } from './helpers/history-fixtures.mjs';
import { catalogDocument, createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { cancelled, onAbort } from '../assets/js/utils/abort.js';

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: name => (values.has(name) ? values.get(name) : null),
    setItem: (name, value) => { values.set(name, String(value)); },
    removeItem: name => { values.delete(name); },
  };
}

/** A page with a history, and the agent turn's fixed inputs. */
async function chatPage(replies, { agent = 'Claude', model = { id: 'scripted', contextTokens: null, outputTokens: null } } = {}) {
  const page = setup();
  await page.history.startTracker({ name: 'Main' });
  const calls = [];
  const provider = createScriptedProvider({
    agent,
    reply: (messages, tools, { effort }) => {
      calls.push({ messages, tools, effort });
      const next = replies.shift();
      return typeof next === 'function' ? next(messages) : next ?? { text: 'Done.' };
    },
  });
  const conversation = createConversation({ id: 'chat-1', now: 1 });
  const changes = [];
  const turn = (text, turnId, options = {}) => {
    appendMessage(conversation, { role: 'user', text, turn: turnId, at: 2 });
    return runAgentTurn({
      conversation, provider, key: null, model, effort: options.effort ?? null, budget: options.budget ?? null, system: 'Work in Cellucid.',
      tools: mcpToolsOf(catalogDocument(page.dispatcher.catalog)), toolIndex: toolIndexOf(page.dispatcher.catalog),
      actions: page.dispatcher, turn: turnId, signal: options.signal ?? new AbortController().signal,
      onChange: change => changes.push(change), lastUsage: options.lastUsage ?? null, win: null, random: () => 0.5,
    });
  };
  return { ...page, provider, conversation, calls, changes, turn };
}

// -------------------------------------------------------------- Conversation

test('a conversation: what a model is sent (no notes, reasoning of this summary only) and what the history keeps (no reasoning, no pictures)', () => {
  const conversation = createConversation({ id: 'c', now: 5 });
  assert.throws(() => appendMessage(conversation, { role: 'system', text: 'x' }), TypeError);
  assert.throws(() => appendMessage(conversation, { role: 'note', kind: 'x', text: 'x' }), TypeError);
  appendMessage(conversation, { role: 'user', text: 'Hi', turn: 't1', at: 6 }, 6);
  appendMessage(conversation, {
    role: 'assistant', turn: 't1', provider: 'anthropic', agent: 'Claude', model: 'm', at: 7, epoch: 0, stop: 'tool-use',
    parts: [{ type: 'opaque', provider: 'anthropic', value: { type: 'thinking', signature: 's' } }, { type: 'text', text: 'Looking.' }, { type: 'tool-call', id: 'c1', name: 'view_picture', args: {} }],
  }, 7);
  appendMessage(conversation, {
    role: 'tool', turn: 't1',
    results: [{ id: 'c1', name: 'view_picture', title: 'Picture', isError: false, step: null, content: [{ type: 'text', text: '{"image":1}' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] }],
  }, 8);
  appendMessage(conversation, { role: 'note', turn: 't1', kind: 'stopped', text: 'Stopped.' }, 9);
  assert.equal(conversation.updatedAt, 9);
  assert.deepEqual(modelMessages(conversation).map(message => message.role), ['user', 'assistant', 'tool']);
  assert.equal(modelMessages(conversation)[1].parts[0].type, 'opaque');
  assert.deepEqual(modelMessages(conversation)[2].results[0], {
    id: 'c1', name: 'view_picture', isError: false, content: [{ type: 'text', text: '{"image":1}' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }],
  });
  assert.deepEqual(turnsOf(conversation), [{ turn: 't1', index: 0 }]);

  const transcript = transcriptOf(conversation);
  assert.equal(transcript.schema, TRANSCRIPT_SCHEMA);
  assert.equal(JSON.stringify(transcript).includes('opaque'), false);
  assert.equal(JSON.stringify(transcript).includes('AAAA'), false);
  assert.match(transcript.messages[2].results[0].content[1].text, /A picture \(image\/png\) was returned here/);
  assert.deepEqual(structuredClone(transcript), transcript, 'plain data');

  // Continued from the history: the reasoning was not kept, so nothing of an earlier epoch is sent.
  const again = conversationFrom(transcript);
  assert.deepEqual(modelMessages(again)[1].parts.map(part => part.type), ['text', 'tool-call']);
  assert.throws(() => conversationFrom({ ...transcript, schema: 99 }), /another version/);

  // A summary replaces what came before it, for the model, and starts a new epoch.
  summarize(conversation, 'They asked for a picture.', 3, 10);
  appendMessage(conversation, { role: 'user', text: 'Next', turn: 't2', at: 11 }, 11);
  const sent = modelMessages(conversation);
  assert.deepEqual(sent.map(message => message.role), ['user', 'user']);
  assert.equal(sent[0].text, `${SUMMARY_LEAD}\n\nThey asked for a picture.`);
  assert.equal(conversation.epoch, 1);
  assert.throws(() => summarize(conversation, 'x', 99), RangeError);

  assert.equal(latestConversation([['a', { schema: 1, updatedAt: 5 }], ['b', { schema: 1, updatedAt: 9 }], ['c', { schema: 2, updatedAt: 99 }]]).updatedAt, 9);
  assert.equal(latestConversation([]), null);
});

test('the context budget is the model\'s window: estimated from the last call\'s prompt plus what was added since', () => {
  const conversation = createConversation();
  appendMessage(conversation, { role: 'user', text: 'x'.repeat(300), turn: 't', at: 1 });
  assert.equal(estimateTokens('x'.repeat(30)), Math.ceil(32 / CHARS_PER_TOKEN));
  assert.equal(overflows({ conversation, window: null, lastInput: null, lastCount: 0, system: '', tools: [] }), false);
  assert.equal(overflows({ conversation, window: 50, lastInput: null, lastCount: 0, system: '', tools: [] }), true);
  assert.equal(overflows({ conversation, window: 500, lastInput: null, lastCount: 0, system: '', tools: [] }), false);
  // The last call reported 480 tokens for the first message; the new one adds about 100.
  appendMessage(conversation, { role: 'user', text: 'y'.repeat(300), turn: 't2', at: 2 });
  assert.equal(overflows({ conversation, window: 500, lastInput: 480, lastCount: 1, system: '', tools: [] }), true);
  assert.equal(overflows({ conversation, window: 700, lastInput: 480, lastCount: 1, system: '', tools: [] }), false);

  // The summariser reads text; a result is cut to a share with what was cut said.
  appendMessage(conversation, { role: 'assistant', turn: 't2', agent: 'Claude', parts: [{ type: 'text', text: 'Reading.' }, { type: 'tool-call', id: 'c', name: 'fields_list', args: {} }] });
  appendMessage(conversation, { role: 'tool', turn: 't2', results: [{ id: 'c', name: 'fields_list', isError: false, content: [{ type: 'text', text: 'abcdefghij' }] }] });
  const whole = summaryInputOf(conversation, conversation.messages.length);
  assert.match(whole, /Person: x+/);
  assert.match(whole, /Assistant: Reading\./);
  assert.match(whole, /Assistant called fields_list \{\}/);
  assert.match(whole, /Result of fields_list: abcdefghij/);
  assert.match(summaryInputOf(conversation, conversation.messages.length, 0.5), /Result of fields_list: abcde \[…5 characters cut\]/);
});

// --------------------------------------------------------------- Agent turn

test('a turn: tool calls are the page\'s actions, recorded as the agent\'s steps of this turn, and Undo turn takes them all back', async () => {
  const page = await chatPage([
    { text: 'Let me colour.', calls: [{ name: 'color_by', args: { field: 'leiden' } }, { name: 'camera_set', args: { at: 4 } }] },
    { text: 'Done: coloured by leiden.', chunks: 3 },
  ]);
  const before = structuredClone(page.state);
  const connections = [];
  page.dispatcher.subscribe(event => { if (event.kind === 'start') connections.push(event.meta.connection); });
  const result = await page.turn('Colour by leiden', 'turn-a');
  assert.equal(result.ended, 'end');
  // Each call comes through the chat as its connection (what a permission "in this chat" holds for).
  assert.deepEqual(connections, [
    { id: 'chat-1', kind: 'chat', client: null, host: null }, { id: 'chat-1', kind: 'chat', client: null, host: null },
  ]);
  assert.equal(result.usage.calls, 2);
  assert.ok(result.usage.input > 0);
  assert.deepEqual(page.conversation.messages.map(message => message.role), ['user', 'assistant', 'tool', 'assistant']);
  const steps = [...page.history.active.steps.values()].filter(step => step.type !== null);
  assert.deepEqual(steps.map(step => [step.type, step.by.origin, step.by.agent, step.by.turn, step.label]), [
    ['color.by', 'agent', 'Claude', 'turn-a', 'Coloured by leiden'],
    ['camera.set', 'agent', 'Claude', 'turn-a', 'Camera at 4'],
  ]);
  const results = page.conversation.messages[2].results;
  assert.deepEqual(results.map(entry => [entry.name, entry.title, entry.isError, entry.step?.label]), [
    ['color_by', 'Colour by', false, 'Coloured by leiden'],
    ['camera_set', 'Camera', false, 'Camera at 4'],
  ]);
  assert.match(results[0].content[0].text, /"label":"Coloured by leiden"/);
  // The second call was sent the results, in one tool message after the calls.
  assert.deepEqual(page.calls[1].messages.map(message => message.role), ['user', 'assistant', 'tool']);
  assert.ok(page.changes.some(change => change.kind === 'status' && change.status?.phase === 'tool' && change.status.tool === 'Colour by'));
  assert.ok(page.changes.some(change => change.kind === 'text'));
  assert.equal(page.changes.at(-1).kind, 'status');
  assert.equal(page.changes.at(-1).status, null);

  assert.equal((await page.history.undoTurn('turn-a')).removed, 0);
  assert.deepEqual(page.state.colors.by, before.colors.by);
  assert.equal(page.state.camera.at, before.camera.at);
});

test('Undo turn, one for the chat, the activity line and the State panel: alone at the end, back to before it; others acted after, the person chooses only its steps or everything since', async () => {
  const chatgpt = { origin: 'agent', agent: 'ChatGPT', turn: 'c1', connection: { id: 'g1', kind: 'connector' } };
  const claude = { origin: 'agent', agent: 'Claude', turn: 't1', connection: { id: 'chat-1', kind: 'chat' } };
  async function interleaved() {
    const page = setup();
    await page.history.startTracker({ name: 'Main' });
    await page.dispatcher.dispatch('color.by', { field: 'leiden' }, chatgpt);
    await page.dispatcher.dispatch('camera.set', { at: 4 }, claude);
    await page.dispatcher.dispatch('color.by', { field: 'louvain' }, chatgpt);
    await page.dispatcher.dispatch('highlight.cells', { label: 'Mine', cells: [1, 2] }, { origin: 'user' });
    return page;
  }
  const pathOf = page => {
    const tree = page.history.active;
    const out = [];
    for (let step = tree.steps.get(tree.headId); step && step.type !== null; step = tree.steps.get(step.parent)) out.unshift([step.type, step.by.agent, step.by.turn]);
    return out;
  };
  const asked = [];
  const told = [];
  const choose = answer => ({
    ask: async plan => { asked.push({ agent: plan.agent, own: plan.own.length, others: plan.others.length, elsewhere: plan.elsewhere }); return answer; },
    tell: note => told.push(note),
  });

  // Only ChatGPT's steps: they are deleted, Claude's camera and the person's highlight are applied again.
  let page = await interleaved();
  let result = await undoAgentTurn(page.history, 'c1', choose('own'));
  assert.deepEqual(asked.at(-1), { agent: 'ChatGPT', own: 2, others: 2, elsewhere: 0 });
  assert.deepEqual({ ...result, report: result.report.length }, { found: true, undone: true, how: 'own', agent: 'ChatGPT', steps: 2, report: 0, outside: [] });
  assert.equal(page.state.colors.by, 'cell_type', 'ChatGPT\'s colourings are taken back');
  assert.equal(page.state.camera.at, 4, 'Claude\'s camera stays');
  assert.equal(page.state.highlights.groups.length, 1, 'the person\'s highlight stays');
  assert.deepEqual(pathOf(page), [['camera.set', 'Claude', 't1'], ['highlight.cells', null, null]]);
  assert.deepEqual(told.at(-1), {
    text: 'Undid ChatGPT\'s 2 steps (to Recently deleted); the steps after them apply again.', tone: 'success',
    title: 'Undid ChatGPT\'s 2 steps: they are in Recently deleted, where they can be restored, and the steps taken after them were applied again without them.',
  });
  assert.equal(page.history.active.journal.at(-1).op, 'turn.undo', 'they are in Recently deleted');

  // Everything since: back to before ChatGPT's first step, the four steps kept for redo.
  page = await interleaved();
  const headBefore = page.history.active.headId;
  result = await undoAgentTurn(page.history, 'c1', choose('since'));
  assert.equal(result.how, 'since');
  assert.equal(result.steps, 4);
  assert.equal(page.history.active.steps.get(page.history.active.headId).type, null);
  assert.equal(page.state.camera.at, 0);
  assert.equal(told.at(-1).text, 'Undid everything since ChatGPT\'s turn began.');
  await page.history.jump(headBefore);
  assert.equal(page.state.colors.by, 'louvain', 'the steps are kept for redo');

  // Neither: nothing changes and nothing is said.
  const toldBefore = told.length;
  page = await interleaved();
  const shown = page.history.active.headId;
  result = await undoAgentTurn(page.history, 'c1', choose(null));
  assert.deepEqual({ found: result.found, undone: result.undone, how: result.how }, { found: true, undone: false, how: null });
  assert.equal(page.history.active.headId, shown);
  assert.equal(told.length, toldBefore);

  // Alone at the end of the branch: no question, back to before it, its step kept to redo.
  page = setup();
  await page.history.startTracker({ name: 'Main' });
  await page.dispatcher.dispatch('camera.set', { at: 4 }, claude);
  const askedBefore = asked.length;
  result = await undoAgentTurn(page.history, 't1', choose('own'));
  assert.equal(asked.length, askedBefore, 'nobody acted after it: nothing to ask');
  assert.equal(result.how, 'end');
  assert.equal(page.state.camera.at, 0);
  assert.equal(await page.history.redo(), true);
  assert.equal(page.state.camera.at, 4);
  assert.equal(told.length, toldBefore, 'its line and its steps show it');
  result = await undoAgentTurn(page.history, 'no-such-turn', choose('own'));
  assert.deepEqual({ found: result.found, undone: result.undone }, { found: false, undone: false });
});

test('Undo only an agent\'s steps reports what no longer applies; the turn\'s steps on another branch stay and are counted', async () => {
  const by = (agent, turn) => ({ origin: agent === null ? 'user' : 'agent', agent, model: null, host: null, person: null, turn });
  const step = (id, parent, turn, agent = 'Claude') => ({ id, parent, by: by(turn === null ? null : agent, turn), type: 'color.by' });
  const steps = new Map([
    ['s0', { id: 's0', parent: null, type: null, by: { ...by(null, null), origin: 'startup' } }],
    ['s1', step('s1', 's0', 't1')],
    ['s2', step('s2', 's1', null)],
    ['s3', step('s3', 's2', 't1')],
    ['s4', step('s4', 's3', null)],
    ['x1', step('x1', 's1', 't1')],
  ]);
  const calls = [];
  const history = {
    active: { steps, headId: 's4', turns: new Map([['t1', {}]]) },
    // The history's own undo of a turn: only its steps, one journaled edit, what no longer applies flagged.
    undoTurn: async (turn, options) => {
      calls.push([turn, options]);
      return { flagged: [{ step: 's4', reason: 'There is no field score.' }] };
    },
  };
  steps.get('s4').label = 'Coloured by score';
  let plan = null;
  let told = null;
  const result = await undoAgentTurn(history, 't1', { ask: async asked => { plan = asked; return 'own'; }, tell: note => { told = note; } });
  assert.deepEqual([plan.own.map(each => each.id), plan.others.map(each => each.id), plan.elsewhere], [['s1', 's3'], ['s2', 's4'], 1]);
  assert.deepEqual(calls, [['t1', { onlyOwn: true }]]);
  assert.deepEqual(result.report, [{ step: 's4', label: 'Coloured by score', reason: 'There is no field score.' }]);
  assert.deepEqual(told, {
    text: 'Undid Claude\'s 2 steps (to Recently deleted); 1 step no longer applies.', tone: 'warning',
    title: 'Undid Claude\'s 2 steps. “Coloured by score”: There is no field score.',
  });
  // A change that failed (the caller's run reported it) is no undo, and nothing more is said.
  told = null;
  const failed = await undoAgentTurn(history, 't1', { ask: async () => 'own', run: async () => undefined, tell: note => { told = note; } });
  assert.deepEqual({ found: failed.found, undone: failed.undone, told }, { found: true, undone: false, told: null });
});

test('a refused or unknown tool goes back to the model as a tool error, and the turn goes on', async () => {
  const page = await chatPage([
    { calls: [{ name: 'no_such_tool', args: {} }, { name: 'color_by', args: { field: 3 } }] },
    messages => ({ text: `Saw ${messages.at(-1).results.filter(result => result.isError).length} errors.` }),
  ]);
  const result = await page.turn('Try', 'turn-b');
  assert.equal(result.ended, 'end');
  const results = page.conversation.messages[2].results;
  assert.deepEqual(results.map(entry => entry.isError), [true, true]);
  assert.equal(results[0].content[0].text, 'Cellucid has no tool <cellucid-data>"no_such_tool"</cellucid-data>.');
  assert.match(results[1].content[0].text, /field/);
  assert.equal(page.conversation.messages[3].parts[0].text, 'Saw 2 errors.');
});

test('a provider that asks to slow down, or is busy, is waited out with a growing wait; a refused key ends the turn with its sentence', async () => {
  assert.equal(retryDelayOf(new ProviderError('rate', 'x', { retryAfterMs: 1234 }), 0), 1234);
  assert.deepEqual([0, 1, 2, 3].map(attempt => retryDelayOf(new ProviderError('busy', 'x'), attempt, () => 1)), [1000, 2000, 4000, 8000]);
  assert.equal(retryDelayOf(new ProviderError('busy', 'x'), 30, () => 1), RETRY_CEILING_MS);
  assert.equal(retryDelayOf(new ProviderError('busy', 'x'), 0, () => 0), 500);

  const page = await chatPage([
    { error: { kind: 'rate', message: 'Slow down.', retryAfterMs: 5 } },
    { error: { kind: 'network', message: 'No connection.', retryAfterMs: 5 } },
    { text: 'Through.' },
  ]);
  const result = await page.turn('Hello', 'turn-c');
  assert.equal(result.ended, 'end');
  assert.equal(page.calls.length, 3);
  const waits = page.changes.filter(change => change.kind === 'status' && change.status?.phase === 'waiting').map(change => change.status.reason);
  assert.deepEqual(waits, ['Slow down.', 'No connection.']);

  const refused = await chatPage([{ error: { kind: 'auth', message: 'Anthropic did not accept this API key. Check it in the chat settings.' } }]);
  const ended = await refused.turn('Hello', 'turn-d');
  assert.equal(ended.ended, 'error');
  assert.equal(ended.error.kind, 'auth');
  assert.deepEqual(refused.conversation.messages.at(-1), { role: 'note', turn: 'turn-d', kind: 'error', text: 'Anthropic did not accept this API key. Check it in the chat settings.' });
});

test('every call costs and is counted: a failed try that began to answer, the summariser; an unreadable answer is asked for once more; no try past the budget', async () => {
  // A try that failed after the provider began to answer: its tokens are on the reply that came after.
  const page = await chatPage([
    { error: { kind: 'busy', message: 'Busy.', retryAfterMs: 5 }, usage: { input: 500, output: 10 } },
    { error: { kind: 'rate', message: 'Slow down.', retryAfterMs: 5 } },
    { text: 'Through.', usage: { input: 600, output: 5 } },
  ]);
  const through = await page.turn('Hello', 'turn-cost');
  assert.equal(through.ended, 'end');
  assert.deepEqual(page.conversation.messages.at(-1).otherCalls, { input: 500, output: 10, cacheRead: 0, cacheWrite: 0, calls: 1 }, 'a try refused before any answer cost nothing');
  assert.deepEqual(usageOf(page.conversation, 'turn-cost'), { input: 1100, output: 15, cacheRead: 0, cacheWrite: 0, calls: 2 });
  assert.deepEqual(through.usage, usageOf(page.conversation, 'turn-cost'));

  // An answer Cellucid could not read: asked for once more, and a second one ends the turn.
  const unreadable = { error: { kind: 'unreadable', message: 'Anthropic sent a tool call Cellucid could not read.', retryAfterMs: 5 }, usage: { input: 300, output: 40 } };
  const twice = await chatPage([unreadable, unreadable, { text: 'Never asked.' }]);
  const gaveUp = await twice.turn('Colour it', 'turn-unreadable');
  assert.equal(gaveUp.ended, 'error');
  assert.equal(twice.calls.length, 2);
  assert.equal(twice.changes.find(change => change.kind === 'status' && change.status?.phase === 'waiting').status.reason,
    'Anthropic sent a tool call Cellucid could not read. Cellucid asks once more.');
  assert.deepEqual(twice.conversation.messages.at(-1), {
    role: 'note', turn: 'turn-unreadable', kind: 'error',
    text: 'Anthropic sent a tool call Cellucid could not read. It did again when asked once more; send your message again.',
    otherCalls: { input: 600, output: 80, cacheRead: 0, cacheWrite: 0, calls: 2 },
  });
  const once = await chatPage([unreadable, { text: 'Read this time.' }]);
  assert.equal((await once.turn('Colour it', 'turn-once')).ended, 'end');
  assert.equal(once.calls.length, 2);

  // Past the budget, no try again: the failed try that spent it ends the turn with the budget's note.
  const spent = await chatPage([{ error: { kind: 'busy', message: 'Busy.', retryAfterMs: 5 }, usage: { input: 1200, output: 0 } }, { text: 'Never asked.' }]);
  const stopped = await spent.turn('Hello', 'turn-budget', { budget: 1000 });
  assert.equal(stopped.ended, 'budget');
  assert.equal(spent.calls.length, 1);
  assert.deepEqual(spent.conversation.messages.at(-1), {
    role: 'note', turn: 'turn-budget', kind: 'limit',
    text: 'This chat used 1,200 tokens, its budget is 1,000; raise it in the chat settings to go on.',
    otherCalls: { input: 1200, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 },
  });
  assert.equal(usageOf(spent.conversation).input, 1200, 'the chat\'s tokens count it');
});

test('Stop mid-reply keeps the words streamed so far and runs nothing; Stop mid-call stops that call and answers the rest "not run"', async () => {
  const controller = new AbortController();
  // The model has written its words and is still answering (held) when the person stops it; its call is not made yet.
  let answering;
  const held = new Promise(resolve => { answering = resolve; });
  const page = await chatPage([{ text: 'abcdefghij', chunks: 10, hold: held, calls: [{ name: 'color_by', args: { field: 'x' } }] }]);
  const running = page.turn('Go', 'turn-e', { signal: controller.signal });
  while (!page.changes.some(change => change.kind === 'text' && change.message.parts[0]?.text === 'abcdefghij')) await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort(new DOMException('The person stopped Claude.', 'AbortError'));
  answering();
  const result = await running;
  assert.equal(result.ended, 'stopped');
  const [, reply, note] = page.conversation.messages;
  assert.equal(reply.stop, 'stopped');
  assert.deepEqual(reply.parts, [{ type: 'text', text: 'abcdefghij' }]);
  assert.deepEqual(note, { role: 'note', turn: 'turn-e', kind: 'stopped', text: 'Stopped.' });
  assert.equal(page.state.colors.by, 'cell_type', 'the call was never run');

  // Mid-call: the first call changes the colouring, then waits; Stop rolls it back and the second is not run.
  const { state, domains } = fixturePage();
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([
    defineAction({
      type: 'color.by', title: 'Colour by', summary: 'Colour by a field.', group: 'Colours',
      params: { type: 'object', additionalProperties: false, required: ['field'], properties: { field: { type: 'string' } } },
      touches: ['colors'], reads: [], effect: 'view', describe: p => `Coloured by ${p.field}`, code: () => 'x',
    }),
    defineAction({
      type: 'camera.set', title: 'Camera', summary: 'Place the camera.', group: 'Camera',
      params: { type: 'object', additionalProperties: false, required: ['at'], properties: { at: { type: 'number' } } },
      touches: ['camera'], reads: [], effect: 'view', describe: p => `Camera at ${p.at}`, code: () => 'x',
    }),
  ]) });
  let entered;
  const handlerEntered = new Promise(resolve => { entered = resolve; });
  dispatcher.provide('color.by', ({ field }, { signal }) => {
    state.colors = { ...state.colors, by: field };
    entered();
    return new Promise((resolve, reject) => { onAbort(signal, () => reject(signal.reason)); });
  });
  dispatcher.provide('camera.set', ({ at }) => { state.camera = { ...state.camera, at }; });
  const history = createHistory({ dispatcher, domains, dataset: { id: 'd', name: 'D', cellOrder: null }, newTrackerId: () => 't-00000000-0000-4000-8000-000000000001' });
  await history.startTracker();
  const conversation = createConversation();
  appendMessage(conversation, { role: 'user', text: 'Go', turn: 'turn-f', at: 1 });
  const stop = new AbortController();
  const turnRun = runAgentTurn({
    conversation, key: null, model: { id: 'scripted', contextTokens: null, outputTokens: null },
    provider: createScriptedProvider({ agent: 'Claude', reply: () => ({ calls: [{ name: 'color_by', args: { field: 'slow' } }, { name: 'camera_set', args: { at: 9 } }] }) }),
    system: 's', tools: mcpToolsOf(catalogDocument(dispatcher.catalog)), toolIndex: toolIndexOf(dispatcher.catalog), actions: dispatcher,
    turn: 'turn-f', signal: stop.signal, onChange: () => {}, win: null,
  });
  await handlerEntered;
  assert.equal(state.colors.by, 'slow');
  stop.abort(cancelled('user', 'The person stopped Claude.'));
  const stopped = await turnRun;
  assert.equal(stopped.ended, 'stopped');
  const tool = conversation.messages.find(message => message.role === 'tool');
  assert.deepEqual(tool.results.map(entry => [entry.name, entry.isError]), [['color_by', true], ['camera_set', true]]);
  assert.equal(tool.results[0].content[0].text, 'Stopped before it finished: The person stopped Claude.');
  assert.equal(tool.results[1].content[0].text, 'Not run: the person stopped this turn.');
  assert.equal(state.colors.by, 'cell_type', 'the change of the stopped call is rolled back');
  assert.equal(state.camera.at, 0, 'the call after it never ran');
  assert.equal(history.active.steps.size, 1, 'no step was kept');
});

test('a conversation too long for the model is summarised by the model, and the turn goes on from the summary', async () => {
  let sentFirst = null;
  const page = await chatPage([
    { text: 'Earlier answer.' },
    () => { throw new ProviderError('too-long', 'The conversation is too long for this model.'); },
    messages => ({ text: `Summary of ${messages[0].text.length > 0 ? 'the talk' : ''}.` }),
    messages => { sentFirst = messages[0].text; return { text: 'Answer after the summary.' }; },
  ]);
  await page.turn('First question', 'turn-g');
  const result = await page.turn('Second question', 'turn-h');
  assert.equal(result.ended, 'end');
  assert.equal(page.conversation.summary.text, 'Summary of the talk.');
  assert.equal(page.conversation.summary.before, 2, 'everything before the second question');
  assert.equal(page.conversation.epoch, 1);
  assert.equal(sentFirst, `${SUMMARY_LEAD}\n\nSummary of the talk.`);
  const summaryNote = page.conversation.messages.find(message => message.role === 'note' && message.kind === 'summary');
  // The summariser's call is counted with the turn, on its note.
  assert.equal(summaryNote.otherCalls.calls, 1);
  assert.ok(summaryNote.otherCalls.input > 0);
  assert.equal(usageOf(page.conversation, 'turn-h').calls, 2, 'the summary and the answer');
  // The summariser was sent no tools.
  assert.equal(page.calls[2].tools.length, 0);

  // A known window the conversation would not fit: summarised before the call, not after a refusal.
  const known = await chatPage([{ text: 'x'.repeat(50) }, { text: 'Short summary.' }, { text: 'Fine.' }], { model: { id: 'small', contextTokens: 200_000, outputTokens: null } });
  await known.turn('a'.repeat(30), 'turn-i');
  const tight = await known.turn('b', 'turn-j', { lastUsage: { input: 199_999, count: 2 } });
  assert.equal(tight.ended, 'end');
  assert.equal(known.conversation.summary.text, 'Short summary.');
  assert.equal(known.calls.length, 3);
});

test('a refusal and an answer cut at its limit end the turn with a note', async () => {
  const page = await chatPage([{ text: 'No.', stop: 'refusal', detail: 'Declined for safety.' }, { text: 'Long…', stop: 'max-tokens' }]);
  assert.equal((await page.turn('x', 'turn-k')).ended, 'refusal');
  assert.deepEqual(page.conversation.messages.at(-1), { role: 'note', turn: 'turn-k', kind: 'refusal', text: 'Claude declined to go on: Declined for safety.' });
  assert.equal((await page.turn('y', 'turn-l')).ended, 'max-tokens');
  assert.match(page.conversation.messages.at(-1).text, /longest answer scripted gives at once/);
  await assert.rejects(runAgentTurn({ conversation: createConversation(), turn: 'nope', signal: new AbortController().signal }), RangeError);
});

test('what the chat shows of a tool row and of the work under way', () => {
  const call = { title: 'Colour by' };
  assert.deepEqual(toolRowText(call, null), { state: 'running', label: 'Colour by…' });
  assert.deepEqual(toolRowText(call, { isError: false, step: { label: 'Coloured by leiden' }, content: [] }), { state: 'step', label: 'Coloured by leiden' });
  assert.deepEqual(toolRowText(call, { isError: false, step: null, content: [] }), { state: 'read', label: 'Colour by' });
  assert.deepEqual(toolRowText(call, { isError: true, step: null, content: [{ type: 'text', text: 'There is no field "x".' }] }), { state: 'refused', label: 'Colour by · refused' });
  assert.deepEqual(toolRowText(call, { isError: true, step: null, content: [{ type: 'text', text: 'Not run: the person stopped this turn.' }] }), { state: 'stopped', label: 'Colour by · stopped' });
  assert.equal(workingTextOf({ phase: 'thinking' }), 'Thinking…');
  assert.equal(workingTextOf({ phase: 'tool', tool: 'Colour by' }), 'Running: Colour by…');
  assert.equal(workingTextOf({ phase: 'waiting', reason: 'Slow down.', retryAt: 12_000 }, 3_500), 'Slow down. Next try in ~9 s.');
  assert.equal(workingTextOf(null), '');
});

// ----------------------------------------------------------- Keys, choices

test('an API key is kept for the tab only unless Remember is ticked; Forget removes it everywhere; no site data keeps it in memory', () => {
  const sessionStorage = memoryStorage();
  const localStorage = memoryStorage();
  const keys = createKeyStore({ win: { sessionStorage, localStorage } });
  const name = keyStorageName('anthropic');
  assert.equal(name, 'cellucid:agent-key:anthropic');
  assert.equal(keys.get('anthropic'), null);
  assert.throws(() => keys.set('anthropic', '  ', { remember: false }), TypeError);
  assert.deepEqual(keys.set('anthropic', ' sk-1 ', { remember: false }), { tab: true, browser: false });
  assert.deepEqual(keys.get('anthropic'), { key: 'sk-1', remembered: false });
  assert.equal(localStorage.values.size, 0);
  assert.equal(sessionStorage.getItem(name), 'sk-1');
  assert.equal(keys.remember('anthropic', true), true);
  assert.deepEqual(keys.get('anthropic'), { key: 'sk-1', remembered: true });
  assert.equal(localStorage.getItem(name), 'sk-1');
  keys.remember('anthropic', false);
  assert.equal(localStorage.values.size, 0);
  keys.set('openai', 'sk-2', { remember: true });
  keys.set('openai', 'sk-3', { remember: false });
  assert.equal(localStorage.getItem(keyStorageName('openai')), null, 'a key set without Remember takes the remembered one away');
  keys.forget('anthropic');
  keys.forget('openai');
  assert.equal(keys.get('anthropic'), null);
  assert.equal(sessionStorage.values.size + localStorage.values.size, 0);

  const refusing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); } };
  const strict = createKeyStore({ win: { sessionStorage: refusing, localStorage: refusing } });
  assert.deepEqual(strict.set('anthropic', 'sk-4', { remember: true }), { tab: false, browser: false });
  assert.deepEqual(strict.get('anthropic'), { key: 'sk-4', remembered: false });
  strict.forget('anthropic');
  assert.equal(strict.get('anthropic'), null);
});

test('the remembered chat choices: provider, a model per provider, open; never a key; defaults when unreadable', () => {
  const storage = memoryStorage();
  const empty = { provider: null, models: {}, efforts: {}, instructions: '', budget: null, open: false };
  assert.deepEqual(readChatPreferences({ storage }), empty);
  writeChatPreferences({ provider: 'openai', models: { openai: 'gpt-x' }, efforts: { 'openai:gpt-x': 'high' } }, { storage });
  writeChatPreferences({ open: true, models: { anthropic: 'claude-x' }, instructions: 'Be brief.', budget: 50_000 }, { storage });
  writeChatPreferences({ efforts: { 'anthropic:claude-x': 'low' } }, { storage });
  assert.deepEqual(readChatPreferences({ storage }), {
    provider: 'openai', models: { openai: 'gpt-x', anthropic: 'claude-x' }, efforts: { 'openai:gpt-x': 'high', 'anthropic:claude-x': 'low' },
    instructions: 'Be brief.', budget: 50_000, open: true,
  });
  // An effort set back to the model's own default, and the budget taken away, are not kept.
  writeChatPreferences({ efforts: { 'openai:gpt-x': null }, budget: null }, { storage });
  assert.deepEqual(readChatPreferences({ storage }).efforts, { 'anthropic:claude-x': 'low' });
  assert.equal(readChatPreferences({ storage }).budget, null);
  assert.equal(effortKey('openai', 'gpt-x'), 'openai:gpt-x');
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(PREFERENCES_STORAGE_KEY))).sort(), ['budget', 'efforts', 'instructions', 'models', 'open', 'provider']);
  storage.setItem(PREFERENCES_STORAGE_KEY, '{nope');
  assert.deepEqual(readChatPreferences({ storage }), empty);
});

// ------------------------------------------------------------------ Markdown

test('a reply\'s Markdown: paragraphs, headings, lists, tables, code, quotes; inline marks and http(s) links only', () => {
  const blocks = parseMarkdown('# Clusters\n\nThree **groups**.\n\n| Cluster | Label |\n|---|:--|\n| 0 | T cells |\n| 1 | B \\| plasma |\n\n1. one\n2. two\n   more\n- a\n  - b\n\n```\nx = 1\n```\n> note\n\n---');
  assert.deepEqual(blocks, [
    { type: 'heading', level: 1, text: 'Clusters' },
    { type: 'paragraph', text: 'Three **groups**.' },
    { type: 'table', head: ['Cluster', 'Label'], rows: [['0', 'T cells'], ['1', 'B | plasma']] },
    { type: 'list', ordered: true, start: 1, items: [{ text: 'one', depth: 0 }, { text: 'two\nmore', depth: 0 }] },
    { type: 'list', ordered: false, start: 1, items: [{ text: 'a', depth: 0 }, { text: 'b', depth: 1 }] },
    { type: 'code', text: 'x = 1' },
    { type: 'quote', text: 'note' },
    { type: 'rule' },
  ]);
  assert.deepEqual(parseInline('a `b*c` **d** _e_ [f](https://g.h/i) [j](javascript:alert(1)) snake_case_name'), [
    { text: 'a ' }, { code: 'b*c' }, { text: ' ' }, { strong: [{ text: 'd' }] }, { text: ' ' }, { em: [{ text: 'e' }] }, { text: ' ' },
    { link: 'f', href: 'https://g.h/i' }, { text: ' [j](javascript:alert(1)) snake_case_name' },
  ]);
});

// ----------------------------------------------- Effort, budget, what was sent

test('a turn sends the effort chosen; a chat past its budget makes no more model calls and says so', async () => {
  const page = await chatPage([
    { text: 'One.', usage: { input: 600, output: 100 } },
    { text: 'Two.', usage: { input: 700, output: 200 } },
  ]);
  const first = await page.turn('Hello', 'turn-e', { effort: 'high', budget: 1000 });
  assert.equal(first.ended, 'end');
  assert.equal(page.calls[0].effort, 'high');
  // 700 tokens used, under 1000: the next turn makes its call, then the budget is spent.
  const second = await page.turn('Again', 'turn-f', { budget: 1000 });
  assert.equal(second.ended, 'end');
  assert.equal(page.calls[1].effort, null);
  const third = await page.turn('And again', 'turn-g', { budget: 1000 });
  assert.equal(third.ended, 'budget');
  assert.equal(page.calls.length, 2, 'no call past the budget');
  assert.deepEqual(page.conversation.messages.at(-1), {
    role: 'note', turn: 'turn-g', kind: 'limit', text: 'This chat used 1,600 tokens, its budget is 1,000; raise it in the chat settings to go on.',
  });
  assert.deepEqual(usageOf(page.conversation), { input: 1300, output: 300, cacheRead: 0, cacheWrite: 0, calls: 2 });
  assert.deepEqual(usageOf(page.conversation, 'turn-f'), { input: 700, output: 200, cacheRead: 0, cacheWrite: 0, calls: 1 });
  assert.equal(tokensText(usageOf(page.conversation, 'turn-g')), null, 'a turn with no call has no tokens');
  assert.equal(tokensText(usageOf(page.conversation)), '1,300 tokens read (0 from the cache), 300 written, in 2 calls');
});

test('what left this browser in a turn: the message with what Cellucid added, each tool result and its pictures; the model reads the addition', async () => {
  const conversation = createConversation({ id: 'c', now: 1 });
  appendMessage(conversation, { role: 'user', text: 'Colour it', turn: 't1', at: 2, context: 'Permissions: read only.' });
  appendMessage(conversation, { role: 'assistant', turn: 't1', provider: 'scripted', agent: 'Claude', model: 'm', parts: [{ type: 'tool-call', id: 'a', name: 'fields_list', args: {} }, { type: 'tool-call', id: 'b', name: 'view_picture', args: {} }], at: 3, epoch: 0, stop: 'tool-use' });
  appendMessage(conversation, { role: 'tool', turn: 't1', results: [
    { id: 'a', name: 'fields_list', title: 'List fields', isError: false, step: null, content: [{ type: 'text', text: '{"fields":[]}' }] },
    { id: 'b', name: 'view_picture', title: 'Picture', isError: false, step: null, content: [{ type: 'text', text: 'ok' }, { type: 'image', data: 'iVBOR', mimeType: 'image/png' }] },
  ] });
  const sent = sentOf(conversation, 't1');
  // The message as the model reads it: the words and what Cellucid told with them.
  assert.deepEqual(sent, { message: 'Colour it\n\n[Cellucid: Permissions: read only.]'.length, results: 2, resultChars: 15, pictures: 1, tools: ['fields_list', 'view_picture'], summariesOnly: false });
  assert.equal(sentText(sent, 'Anthropic'),
    "Sent to Anthropic: your message and 2 tool results (15 characters, 1 picture). That is all that left this browser for this turn; the dataset's files stay here, but a result can carry part of the data (the values of cells, a picture of the plot).");
  assert.deepEqual(sentOf(conversation, 'other'), { message: 0, results: 0, resultChars: 0, pictures: 0, tools: [], summariesOnly: false });
  // A turn whose every result was made under the dataset's switch says so; one result made without it, and it does not.
  appendMessage(conversation, { role: 'user', text: 'More', turn: 't2', at: 4 });
  appendMessage(conversation, { role: 'tool', turn: 't2', results: [
    { id: 'c', name: 'fields_list', title: 'List fields', isError: false, step: null, summariesOnly: true, content: [{ type: 'text', text: '{}' }] },
    { id: 'd', name: 'ask_person', title: 'Ask', isError: false, step: null, content: [{ type: 'text', text: 'Asked.' }] },
  ] });
  assert.equal(sentOf(conversation, 't2').summariesOnly, true);
  assert.equal(sentOf(conversation, 't1').summariesOnly, false);
  assert.match(sentText(sentOf(conversation, 't2'), 'Anthropic'), /the dataset's files stay here, and the dataset was set to names and summaries only, so no result carried values of cells or a picture\.$/);
  assert.equal(modelMessages(conversation)[0].text, 'Colour it\n\n[Cellucid: Permissions: read only.]');
});

test('a conversation kept mid-turn (the page closed): each call left is answered with what became of it, and a model accepts it again', () => {
  const kept = createConversation({ id: 'c', now: 1 });
  appendMessage(kept, { role: 'user', text: 'Colour, then hide', turn: 't1', at: 1 });
  appendMessage(kept, { role: 'assistant', turn: 't1', provider: 'anthropic', agent: 'Claude', model: 'm', at: 2, epoch: 0, stop: 'tool-use',
    parts: [{ type: 'text', text: 'On it.' }, { type: 'tool-call', id: 'a', name: 'color_by', args: {} }, { type: 'tool-call', id: 'b', name: 'categories_hide', args: {} }] });
  appendMessage(kept, { role: 'user', text: 'Hello?', turn: 't2', at: 3 });
  const restored = conversationFrom(transcriptOf(kept));
  const tools = new Map([['color_by', { type: 'color.by', title: 'Colour by' }], ['categories_hide', { type: 'filter.hide', title: 'Hide' }]]);
  // The history kept the colouring's step (applied before the page closed); the hiding never ran.
  const closed = closeInterrupted(restored, {
    stepsOfTurn: turn => (turn === 't1' ? [{ id: 's4', type: 'color.by', label: 'Coloured by leiden' }] : []),
    toolOf: name => tools.get(name),
  });
  assert.equal(closed, 2);
  assert.deepEqual(restored.messages.map(message => message.role), ['user', 'assistant', 'tool', 'user']);
  assert.deepEqual(restored.messages[2].results.map(result => [result.id, result.isError, result.step, result.content[0].text]), [
    ['a', false, { id: 's4', label: 'Coloured by leiden' }, 'The page closed before this call\'s answer was kept; it was applied: <cellucid-data>"Coloured by leiden"</cellucid-data>, a step of the history.'],
    ['b', true, null, 'The page closed before this call finished; nothing was applied.'],
  ]);
  assert.deepEqual(modelMessages(restored).map(message => message.role), ['user', 'assistant', 'tool', 'user'], 'every call is followed by its result');
  assert.equal(closeInterrupted(restored, { stepsOfTurn: () => [], toolOf: () => undefined }), 0, 'nothing left to answer');
  // The rows: an answered-as-applied call shows its step; one with nothing applied, and one with no result outside a running turn, are interrupted.
  assert.deepEqual(toolRowText({ title: 'Colour by' }, restored.messages[2].results[0]), { state: 'step', label: 'Coloured by leiden' });
  assert.deepEqual(toolRowText({ title: 'Hide' }, restored.messages[2].results[1]), { state: 'interrupted', label: 'Hide · interrupted' });
  assert.deepEqual(toolRowText({ title: 'Hide' }, null, { running: false }), { state: 'interrupted', label: 'Hide · interrupted' });
  assert.deepEqual(toolRowText({ title: 'Hide' }, null), { state: 'running', label: 'Hide…' });
});

test('a turn that fails between a reply and its results answers the calls left: the conversation stays one a model accepts', async () => {
  const page = await chatPage([{ calls: [{ name: 'color_by', args: { field: 'leiden' } }, { name: 'camera_set', args: { at: 3 } }] }]);
  appendMessage(page.conversation, { role: 'user', text: 'Colour and turn', turn: 'turn-fault', at: 2 });
  // A fault outside the tools (here, what is told of the second call's work throws) ends the turn mid-calls.
  const result = await runAgentTurn({
    conversation: page.conversation, provider: page.provider, key: null, model: { id: 'scripted', contextTokens: null, outputTokens: null },
    system: 's', tools: mcpToolsOf(catalogDocument(page.dispatcher.catalog)), toolIndex: toolIndexOf(page.dispatcher.catalog), actions: page.dispatcher,
    turn: 'turn-fault', signal: new AbortController().signal, win: null, random: () => 0.5,
    onChange: change => { if (change.kind === 'status' && change.status?.tool === 'Camera') throw new TypeError('the status line is gone'); },
  });
  assert.equal(result.ended, 'error');
  const [reply, results, note] = page.conversation.messages.slice(-3);
  assert.deepEqual([reply.role, results.role, note.role], ['assistant', 'tool', 'note']);
  assert.deepEqual(results.results.map(entry => [entry.id, entry.isError, entry.content[0].text]), [
    [reply.parts[0].id, false, results.results[0].content[0].text],
    [reply.parts[1].id, true, 'Not run: the turn failed (the status line is gone).'],
  ]);
  assert.equal(results.results[0].step.label, 'Coloured by leiden', 'the call that ran keeps its step');
  assert.equal(note.text, 'The chat stopped: the status line is gone');
});

// --------------------------------------------------------- Export and notes

test('a chat exported as Markdown, and a turn as the short note the history shows beside its steps', async () => {
  const page = await chatPage([
    { text: 'Let me colour.', calls: [{ name: 'color_by', args: { field: 'leiden' } }, { name: 'no_such_tool', args: {} }], usage: { input: 50, output: 5 } },
    { text: 'Coloured by leiden. The clusters separate well.', usage: { input: 80, output: 9 } },
  ]);
  await page.turn('Colour by leiden please. Then tell me.', 'turn-h');
  appendMessage(page.conversation, { role: 'note', turn: 'turn-h', kind: 'stopped', text: 'You stopped Claude.' });
  const markdown = conversationMarkdown(page.conversation, { dataset: 'Pancreas', version: '0.9.7', now: Date.UTC(2026, 10, 4) });
  assert.equal(markdown, [
    '# Cellucid chat: Pancreas',
    '',
    'Exported 2026-11-04T00:00:00.000Z from Cellucid 0.9.7. 2 model calls, 130 prompt tokens, 14 written.',
    '',
    '**You**',
    '',
    '> Colour by leiden please. Then tell me.',
    '',
    '**Claude** (scripted)',
    '',
    'Let me colour.',
    '',
    '- `color_by` — step "Coloured by leiden"',
    '- `no_such_tool` — refused: Cellucid has no tool "no_such_tool".',
    '',
    '**Claude** (scripted)',
    '',
    'Coloured by leiden. The clusters separate well.',
    '',
    '*You stopped Claude.*',
    '',
  ].join('\n'));
  // Nothing in it runs in a renderer that does not sanitise: raw HTML outside code is escaped, a script link is left as text, code stays.
  const hostile = createConversation({ id: 'x', now: 1 });
  appendMessage(hostile, { role: 'user', text: 'hi <img src=x onerror="steal()">', turn: 't', at: 1 });
  appendMessage(hostile, { role: 'assistant', turn: 't', provider: 'scripted', agent: 'Claude', model: '<b>m</b>', at: 1, epoch: 0, stop: 'end',
    parts: [{ type: 'text', text: 'Plain <script>steal()</script> [go](javascript:steal()) [web](https://example.org) `<kept>`\n```\n<also kept>\n```' }, { type: 'tool-call', id: 'c', name: 'a`b<i>', args: {} }] });
  appendMessage(hostile, { role: 'tool', turn: 't', results: [{ id: 'c', name: 'a`b<i>', title: 'x', isError: true, step: null, content: [{ type: 'text', text: 'No tool <u>x</u>' }] }] });
  const safe = conversationMarkdown(hostile, { now: 0 });
  assert.match(safe, /> hi \\<img src=x onerror="steal\(\)">/);
  assert.match(safe, /\*\*Claude\*\* \(\\<b>m\\<\/b>\)/);
  assert.match(safe, /Plain \\<script>steal\(\)\\<\/script> \[go\]\\\(javascript:steal\(\)\) \[web\]\(https:\/\/example\.org\) `<kept>`\n```\n<also kept>\n```/);
  assert.match(safe, /- `` a`b<i> `` — refused: No tool \\<u>x\\<\/u>/);
  assert.equal(turnNoteOf(page.conversation, 'turn-h'), 'Asked: "Colour by leiden please." Step: Coloured by leiden. Why: Coloured by leiden.');
  assert.equal(turnNoteOf(page.conversation, 'nope'), null);
  const quiet = createConversation({ id: 'q', now: 1 });
  appendMessage(quiet, { role: 'user', text: 'What is this', turn: 't', at: 1 });
  assert.equal(turnNoteOf(quiet, 't'), 'Asked: "What is this".');
});

// ---------------------------------------------------------------- Suggestions

test('what the empty chat offers: a first look; annotating and comparing the first categorical field; explaining the steps; no values read', async () => {
  assert.deepEqual(suggestionsFor(), ['Give me a first look at this dataset']);
  assert.deepEqual(suggestionsFor({ field: 'cell_type', steps: 3 }), [
    'Give me a first look at this dataset',
    'Annotate the clusters of cell_type',
    'Compare the two largest groups of cell_type',
    'Explain what was done so far and write a methods paragraph',
  ]);
  const asked = [];
  const actions = {
    async dispatch(type, params) {
      asked.push([type, params]);
      return { outcome: { fields: [{ key: 'batch', categories: 1 }, { key: 'leiden' }, { key: 'cell_type', categories: 9 }] }, step: null };
    },
  };
  assert.deepEqual(await readSuggestionFacts(actions, 2), { field: 'leiden', steps: 2 }, 'a field counted as one category is passed over; one not yet counted may have several');
  assert.deepEqual(asked, [['fields.list', { kind: 'categorical' }]], 'only what the dataset says of itself: no field is read');
  assert.deepEqual(await readSuggestionFacts({ dispatch: async () => { throw new Error('no dataset'); } }, 0), { field: null, steps: 0 });
});

// --------------------------------------------------------------- History link

test('a turn\'s steps in the tracker shown: how many, how many on the path, the latest; the chat and the history find each other through one module', async () => {
  const page = await chatPage([
    { calls: [{ name: 'color_by', args: { field: 'leiden' } }] },
    { calls: [{ name: 'camera_set', args: { at: 4 } }] },
    { text: 'Done.' },
    { calls: [{ name: 'camera_set', args: { at: 7 } }] },
    { text: 'Done.' },
  ]);
  await page.turn('Colour then move', 'turn-i');
  await page.turn('Move', 'turn-j');
  const tree = page.history.active;
  const lastOf = turn => [...tree.steps.values()].filter(step => step.by.turn === turn).at(-1).id;
  assert.deepEqual(Object.fromEntries(turnSteps(tree)), {
    'turn-i': { inTree: 2, onPath: 2, last: lastOf('turn-i'), deleted: 0 },
    'turn-j': { inTree: 1, onPath: 1, last: lastOf('turn-j'), deleted: 0 },
  });
  await page.history.undoTurn('turn-j');
  assert.deepEqual(stepsOfTurn(page.history.active, 'turn-j'), { inTree: 1, onPath: 0, last: lastOf('turn-j'), deleted: 0 }, 'undone: off the path, still in the tree');
  assert.deepEqual(stepsOfTurn(null, 'turn-i'), { inTree: 0, onPath: 0, last: null, deleted: 0 });

  assert.equal(revealStep('s1'), false, 'no history panel');
  // The turn's record names its agent and model (the dispatch's meta), so no chat is asked.
  assert.equal(tree.turns.get('turn-i').by.agent, 'Claude');
  assert.equal(revealTurn('turn-i'), false, 'no chat');
  const revealed = [];
  const unregisterSteps = registerStepRevealer(id => revealed.push(['step', id]));
  const unregisterTurns = registerTurnLink({ reveal: turn => { revealed.push(['turn', turn]); return true; } });
  let redraws = 0;
  const unsubscribe = subscribeTurns(() => { redraws += 1; });
  assert.equal(revealStep('s1'), true);
  assert.equal(revealTurn('turn-i'), true);
  turnsChanged();
  assert.deepEqual(revealed, [['step', 's1'], ['turn', 'turn-i']]);
  assert.equal(redraws, 1);
  unsubscribe();
  unregisterSteps();
  unregisterTurns();
  turnsChanged();
  assert.equal(redraws, 1);
  assert.equal(revealStep('s1'), false);
  assert.equal(revealTurn('turn-i'), false);
});

test('a question with choices: checked, answered at once, the turn ends; the choices wait for the person until they answer; strict for OpenAI', async () => {
  assert.deepEqual(askOf({ question: ' Which field? ', choices: ['leiden', ' cell_type '] }), { question: 'Which field?', choices: ['leiden', 'cell_type'] });
  for (const bad of [{ question: '', choices: ['a', 'b'] }, { question: 'Q', choices: ['a'] }, { question: 'Q', choices: ['a', 'b', 'c', 'd', 'e', 'f'] },
    { question: 'Q', choices: ['a', 'a'] }, { question: 'Q', choices: ['a', ''] }, { question: 'Q', choices: 'a, b' }, null]) {
    assert.ok('problem' in askOf(bad), JSON.stringify(bad));
  }
  // Both providers take its schema exactly (OpenAI's strict mode included: the counts of choices are strict keywords).
  const [openai] = openaiToolsOf([ASK_TOOL]);
  assert.equal(openai.strict, true);
  assert.deepEqual(openai.parameters.properties.choices, { ...ASK_TOOL.inputSchema.properties.choices });

  const page = await chatPage([
    { text: '', calls: [{ name: 'ask_person', args: { question: 'Which?', choices: ['one'] } }] },
    { text: 'Before I go on:', calls: [{ name: 'ask_person', args: { question: 'Colour by which field?', choices: ['leiden', 'cell_type'] } }] },
    { text: 'never asked for' },
  ]);
  const tools = [...mcpToolsOf(catalogDocument(page.dispatcher.catalog)), ASK_TOOL];
  appendMessage(page.conversation, { role: 'user', text: 'Colour it', turn: 't1', at: 2 });
  const ran = await runAgentTurn({
    conversation: page.conversation, provider: page.provider, key: null, model: { id: 'scripted', contextTokens: null, outputTokens: null },
    system: 'x', tools, toolIndex: toolIndexOf(page.dispatcher.catalog), actions: page.dispatcher, turn: 't1',
    signal: new AbortController().signal, onChange: () => {}, win: null, random: () => 0.5,
  });
  assert.equal(ran.ended, 'asked');
  assert.equal(page.calls.length, 2, 'a malformed question goes back to the model; a good one ends the turn');
  const results = page.conversation.messages.filter(message => message.role === 'tool').map(message => message.results[0]);
  assert.deepEqual(results.map(result => [result.isError, result.content[0].text]), [
    [true, 'Give 2 to 5 different choices, each a few words (choices).'],
    [false, ASKED_TEXT],
  ]);
  assert.equal(stepsOfTurn(page.history.active, 't1').inTree, 0, 'asking records nothing');
  const pending = pendingQuestion(page.conversation);
  assert.deepEqual({ ...pending, id: undefined }, { turn: 't1', id: undefined, question: 'Colour by which field?', choices: ['leiden', 'cell_type'] });
  // Shown as words in the exported chat; the tool's own row is not repeated.
  const markdown = conversationMarkdown(page.conversation, { now: 0 });
  assert.match(markdown, /Colour by which field\? \*\(leiden · cell_type\)\*/);
  assert.equal(markdown.includes('`ask_person` — read'), false);
  // The person's answer is their next message: the question no longer waits.
  appendMessage(page.conversation, { role: 'user', text: 'leiden', turn: 't2', at: 3 });
  assert.equal(pendingQuestion(page.conversation), null);
});
