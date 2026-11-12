/**
 * The chat bar's model providers (`assets/js/app/agent/providers/`) against
 * recorded shapes of their APIs, with no network: one contract
 * (`contract.js`), Anthropic's Messages API and OpenAI's Responses API
 * (requests, streamed events, failures by kind, models listed, the
 * person's effort, a refused key told apart from no connection), OpenAI's
 * strict tool schemas made from the whole catalog, the scripted model of
 * the browser specs and where the page offers it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProviderError, checkProvider, isRetryable, readServerEvents, retryAfterOf,
} from '../assets/js/app/agent/providers/contract.js';
import {
  ANTHROPIC_EFFORTS, ANTHROPIC_VERSION, PROGRESS_BETA, PROGRESS_MODELS, anthropicEventsOf, anthropicMessagesOf, createAnthropicProvider, effortsOf,
} from '../assets/js/app/agent/providers/anthropic.js';
import {
  OPENAI_EFFORTS, argsFromStrict, createOpenAIProvider, openaiEventsOf, openaiInputOf, openaiToolsOf, strictSchemaOf,
} from '../assets/js/app/agent/providers/openai.js';
import { createScriptedProvider } from '../assets/js/app/agent/providers/scripted.js';
import { AGENT_SCRIPT_GLOBAL, providersForPage } from '../assets/js/app/agent/providers/index.js';
import { getActionCatalog } from '../assets/js/app/actions/index.js';
import { catalogDocument } from '../assets/js/app/actions/catalog.js';
import { mcpToolsOf } from '../assets/js/app/agent/bridge/mcp-tools.js';

const TOOLS = mcpToolsOf(catalogDocument(getActionCatalog()));

/** A streamed response of server-sent events, in `pieces` (split anywhere, as a network does). */
function sse(events, { status = 200, pieces = 3, headers = {} } = {}) {
  const text = events.map(({ event, data }) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil(bytes.length / pieces);
  const stream = new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream', ...headers } });
}

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fetch that answers each request with the next response and keeps what it was asked. */
function recordingFetch(responses) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? null : JSON.parse(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  return { fetch, requests };
}

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const MESSAGES = Object.freeze([
  { role: 'user', text: 'Color by cell type' },
  {
    role: 'assistant',
    parts: [
      { type: 'opaque', provider: 'anthropic', value: { type: 'thinking', thinking: '', signature: 'sig-1' } },
      { type: 'opaque', provider: 'openai', value: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' } },
      { type: 'text', text: 'Looking.' },
      { type: 'tool-call', id: 'call-1', name: 'color_by', args: { field: { source: 'obs', key: 'cell_type' } } },
    ],
  },
  {
    role: 'tool',
    results: [{ id: 'call-1', name: 'color_by', isError: false, content: [{ type: 'text', text: '{"step":{"id":"s1"}}' }, { type: 'image', data: 'iVBOR', mimeType: 'image/png' }] }],
  },
  { role: 'user', text: 'Thanks' },
]);

// ------------------------------------------------------------------ Contract

test('the contract: a provider without what it promises is refused; failures have kinds, some waited out', () => {
  assert.throws(() => checkProvider({ id: 'x' }), /needs label/);
  assert.throws(() => checkProvider({ id: 'X', label: 'x', agent: 'x', needsKey: false, defaultModel: 'm', models() {}, stream() {} }), /lowercase/);
  assert.throws(() => checkProvider({ id: 'x', label: 'x', agent: 'x', needsKey: true, defaultModel: 'm', models() {}, stream() {} }), /keyLabel/);
  assert.throws(() => new ProviderError('nope', 'x'), RangeError);
  // An unreadable answer is not waited out: the turn asks for it once more (`agent-loop.js`).
  assert.deepEqual(['rate', 'busy', 'network', 'auth', 'quota', 'model', 'too-long', 'request', 'permission', 'unreadable']
    .map(kind => isRetryable(new ProviderError(kind, 'x'))), [true, true, true, false, false, false, false, false, false, false]);
  assert.equal(isRetryable(new Error('x')), false);
  assert.equal(retryAfterOf(new Headers({ 'retry-after': '7' })), 7000);
  assert.equal(retryAfterOf(new Headers({ 'retry-after': new Date(61_000).toUTCString() }), () => 1_000), 60_000);
  assert.equal(retryAfterOf(new Headers()), null);
  for (const provider of [createAnthropicProvider(), createOpenAIProvider(), createScriptedProvider({ reply: () => ({}) })]) {
    assert.ok(Object.isFrozen(provider));
  }
});

test('server-sent events: split anywhere, CRLF, comments, several data lines, and a stream that ends without its last blank line', async () => {
  const text = ': keep-alive\r\nevent: a\r\ndata: {"x":\r\ndata: 1}\r\n\r\ndata: {"y":2}';
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const events = await collect(readServerEvents(new Response(stream), null, 'Test'));
  assert.deepEqual(events, [{ event: 'a', data: { x: 1 } }, { event: null, data: { y: 2 } }]);
  const dropping = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\n')); controller.error(new TypeError('network')); } });
  await assert.rejects(collect(readServerEvents(new Response(dropping), null, 'Test')), error => error instanceof ProviderError && error.kind === 'network');
});

// ----------------------------------------------------------------- Anthropic

test('Anthropic: the request sends the key to Anthropic only, with the browser header, cached instructions and tools, and the conversation as Anthropic messages', async () => {
  const { fetch, requests } = recordingFetch([sse([
    { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 1 } } } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ])]);
  const provider = createAnthropicProvider({ fetch });
  const events = await collect(provider.stream({ key: 'sk-ant-x', model: 'claude-x', system: 'Be brief.', messages: MESSAGES, tools: TOOLS, outputTokens: 1234 }));
  const [request] = requests;
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(request.headers, {
    'content-type': 'application/json', 'x-api-key': 'sk-ant-x', 'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  });
  assert.equal(request.body.model, 'claude-x');
  assert.equal(request.body.max_tokens, 1234);
  assert.equal(request.body.stream, true);
  assert.deepEqual(request.body.cache_control, { type: 'ephemeral' });
  assert.deepEqual(request.body.system, [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }]);
  // The person's choice of an hour (Chat settings › Prompt cache) marks both breakpoints.
  assert.deepEqual(provider.cacheLengths, ['5m', '1h']);
  const hour = recordingFetch([sse([
    { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ])]);
  await collect(createAnthropicProvider({ fetch: hour.fetch }).stream({ key: 'sk-ant-x', model: 'claude-x', system: 'Be brief.', messages: MESSAGES, tools: TOOLS, cacheLength: '1h' }));
  assert.deepEqual(hour.requests[0].body.cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(hour.requests[0].body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(request.body.tools.length, TOOLS.length);
  assert.deepEqual(Object.keys(request.body.tools[0]), ['name', 'description', 'input_schema']);
  assert.deepEqual(request.body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Color by cell type' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 'call-1', name: 'color_by', input: { field: { source: 'obs', key: 'cell_type' } } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call-1', content: [
        { type: 'text', text: '{"step":{"id":"s1"}}' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
      ] },
      { type: 'text', text: 'Thanks' },
    ] },
  ]);
  // The prompt's tokens as the answer starts (a call stopped from here is counted), then the whole call's.
  assert.deepEqual(events, [
    { type: 'usage', input: 1000, output: 1, cacheRead: 900, cacheWrite: 90 },
    { type: 'usage', input: 1000, output: 5, cacheRead: 900, cacheWrite: 90 },
    { type: 'stop', reason: 'end' },
  ]);
});

test('Anthropic: streamed text, reasoning kept whole with its signature, a tool call assembled from its pieces, refusals and early ends', async () => {
  const events = await collect(anthropicEventsOf((async function* stream() {
    yield { data: { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } } };
    yield { data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } };
    yield { data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } } };
    yield { data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } } };
    yield { data: { type: 'content_block_stop', index: 0 } };
    yield { data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } };
    yield { data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Col' } } };
    yield { data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ouring.' } } };
    yield { data: { type: 'content_block_stop', index: 1 } };
    yield { data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'color_by', input: {} } } };
    yield { data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"field":{"source":' } } };
    yield { data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"obs","key":"cell_type"}}' } } };
    yield { data: { type: 'content_block_stop', index: 2 } };
    yield { data: { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_2', name: 'fields_list', input: {} } } };
    yield { data: { type: 'content_block_stop', index: 3 } };
    yield { data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } } };
  })()));
  assert.deepEqual(events, [
    { type: 'usage', input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
    { type: 'thinking' },
    { type: 'opaque', value: { type: 'thinking', thinking: 'hm', signature: 'abc' } },
    { type: 'text', text: 'Col' },
    { type: 'text', text: 'ouring.' },
    { type: 'tool-call', id: 'toolu_1', name: 'color_by', args: { field: { source: 'obs', key: 'cell_type' } } },
    { type: 'tool-call', id: 'toolu_2', name: 'fields_list', args: {} },
    { type: 'usage', input: 3, output: 40, cacheRead: 0, cacheWrite: 0 },
    { type: 'stop', reason: 'tool-use' },
  ]);
  const refused = await collect(anthropicEventsOf((async function* stream() {
    yield { data: { type: 'message_start', message: { usage: {} } } };
    yield { data: { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio', explanation: 'Declined for safety.' } } } };
  })()));
  assert.deepEqual(refused.at(-1), { type: 'stop', reason: 'refusal', detail: 'Declined for safety.' });
  await assert.rejects(collect(anthropicEventsOf((async function* stream() {
    yield { data: { type: 'message_start', message: { usage: {} } } };
  })())), error => error.kind === 'network');
  await assert.rejects(collect(anthropicEventsOf((async function* stream() {
    yield { data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } };
  })())), error => error.kind === 'busy');
  // A tool call whose arguments are not JSON, and a stream event that is not: unreadable, never waited out.
  await assert.rejects(collect(anthropicEventsOf((async function* stream() {
    yield { data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'color_by', input: {} } } };
    yield { data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"field":' } } };
    yield { data: { type: 'content_block_stop', index: 0 } };
  })())), error => error.kind === 'unreadable' && error.message === 'Anthropic sent a tool call Cellucid could not read.');
  const torn = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":\n\n')); controller.close(); } }));
  await assert.rejects(collect(readServerEvents(torn, null, 'Anthropic')), error => error.kind === 'unreadable' && error.message === 'Anthropic sent an answer Cellucid could not read.');
});

test('Anthropic: a model that writes notes between its calls is asked for them as text (display "updates", its beta); any other model is asked nothing', async () => {
  const ended = () => sse([
    { data: { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } } },
    { data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } },
  ]);
  // The documented models (Anthropic's Thinking page, "Progress updates between tool calls"), never one that runs without thinking by default.
  assert.deepEqual([...PROGRESS_MODELS].sort(), [
    'claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2', 'claude-mythos-5-1', 'claude-mythos-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5',
  ]);
  assert.equal(PROGRESS_BETA, 'thinking-display-updates-2026-08-18');
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
    const { fetch, requests } = recordingFetch([ended]);
    await collect(createAnthropicProvider({ fetch }).stream({ key: 'k', model, system: 's', messages: MESSAGES, tools: TOOLS, effort: 'high' }));
    assert.deepEqual(requests[0].body.thinking, { type: 'adaptive', display: 'updates' }, model);
    assert.equal(requests[0].headers['anthropic-beta'], PROGRESS_BETA, model);
    // Nothing else of the request changes: the effort chosen, the cached prefix.
    assert.deepEqual(requests[0].body.output_config, { effort: 'high' });
    assert.deepEqual(requests[0].body.cache_control, { type: 'ephemeral' });
  }
  for (const model of ['claude-haiku-5-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-x']) {
    const { fetch, requests } = recordingFetch([ended]);
    await collect(createAnthropicProvider({ fetch }).stream({ key: 'k', model, system: 's', messages: MESSAGES, tools: TOOLS }));
    assert.equal(requests[0].body.thinking, undefined, model);
    assert.equal(requests[0].headers['anthropic-beta'], undefined, model);
  }
});

test('Anthropic: a request refused for the notes setting is sent again without it, and that model is not asked again; another refusal is the person\'s', async () => {
  const ended = () => sse([
    { data: { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } } },
    { data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } },
  ]);
  const refusedDisplay = () => json({ type: 'error', error: { type: 'invalid_request_error', message: 'thinking.display: Input should be \'summarized\' or \'omitted\'' } }, { status: 400 });
  const { fetch, requests } = recordingFetch([refusedDisplay, ended, ended]);
  const provider = createAnthropicProvider({ fetch });
  await collect(provider.stream({ key: 'k', model: 'claude-opus-5-5', system: 's', messages: MESSAGES, tools: [] }));
  await collect(provider.stream({ key: 'k', model: 'claude-opus-5-5', system: 's', messages: MESSAGES, tools: [] }));
  assert.deepEqual(requests.map(request => [request.body.thinking ?? null, request.headers['anthropic-beta'] ?? null]), [
    [{ type: 'adaptive', display: 'updates' }, PROGRESS_BETA], [null, null], [null, null],
  ]);
  // A refusal of something else is not a reason to stop asking for the notes.
  const other = recordingFetch([json({ type: 'error', error: { type: 'invalid_request_error', message: 'tools.0: bad' } }, { status: 400 }), ended]);
  const kept = createAnthropicProvider({ fetch: other.fetch });
  await assert.rejects(collect(kept.stream({ key: 'k', model: 'claude-opus-5-5', system: 's', messages: MESSAGES, tools: [] })), error => error.kind === 'request');
  await collect(kept.stream({ key: 'k', model: 'claude-opus-5-5', system: 's', messages: MESSAGES, tools: [] }));
  assert.deepEqual(other.requests.map(request => request.body.thinking ?? null), [{ type: 'adaptive', display: 'updates' }, { type: 'adaptive', display: 'updates' }]);
});

test('Anthropic: asked for, a note\'s text streams as progress before the call it introduces, its block kept whole; a reasoning block stays silent; not asked, no progress', async () => {
  const stream = async function* () {
    yield { data: { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } } };
    // Reasoning: empty under display "updates".
    yield { data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } };
    yield { data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } } };
    yield { data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'r' } } };
    yield { data: { type: 'content_block_stop', index: 0 } };
    // A progress note, then the call it introduces.
    yield { data: { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } } };
    yield { data: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'The clusters are read; ' } } };
    yield { data: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'coloring by cell_type next.' } } };
    yield { data: { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'p' } } };
    yield { data: { type: 'content_block_stop', index: 1 } };
    yield { data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'color_by', input: {} } } };
    yield { data: { type: 'content_block_stop', index: 2 } };
    yield { data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } } };
  };
  const asked = await collect(anthropicEventsOf(stream(), { progress: true }));
  assert.deepEqual(asked.filter(event => event.type !== 'usage'), [
    { type: 'thinking' },
    { type: 'opaque', value: { type: 'thinking', thinking: '', signature: 'r' } },
    { type: 'thinking' },
    { type: 'progress', text: 'The clusters are read; ' },
    { type: 'progress', text: 'coloring by cell_type next.' },
    { type: 'opaque', value: { type: 'thinking', thinking: 'The clusters are read; coloring by cell_type next.', signature: 'p' } },
    { type: 'tool-call', id: 'toolu_1', name: 'color_by', args: {} },
    { type: 'stop', reason: 'tool-use' },
  ]);
  const notAsked = await collect(anthropicEventsOf(stream()));
  assert.equal(notAsked.some(event => event.type === 'progress'), false);
  // The block goes back to Anthropic unchanged, its note in it; the note itself is never sent as words.
  assert.deepEqual(anthropicMessagesOf([{ role: 'assistant', parts: [
    { type: 'progress', text: 'coloring next.' },
    { type: 'opaque', provider: 'anthropic', value: { type: 'thinking', thinking: 'coloring next.', signature: 'p' } },
    { type: 'tool-call', id: 'toolu_1', name: 'color_by', args: {} },
  ] }]), [{ role: 'assistant', content: [
    { type: 'thinking', thinking: 'coloring next.', signature: 'p' },
    { type: 'tool_use', id: 'toolu_1', name: 'color_by', input: {} },
  ] }]);
});

test('Anthropic: each refusal of a request is one sentence of its kind', async () => {
  const cases = [
    [401, { type: 'authentication_error', message: 'invalid x-api-key' }, {}, 'auth', /did not accept this API key/],
    [403, { type: 'permission_error', message: 'no' }, {}, 'permission', /may not do that/],
    [400, { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' }, {}, 'quota', /no credit left/],
    [404, { type: 'not_found_error', message: 'model: claude-x' }, {}, 'model', /not available to this Anthropic API key/],
    [400, { type: 'invalid_request_error', message: 'prompt is too long: 1200000 tokens > 1000000 maximum' }, {}, 'too-long', /too long for this model/],
    [429, { type: 'rate_limit_error', message: 'slow' }, { 'retry-after': '12' }, 'rate', /slow down/],
    [529, { type: 'overloaded_error', message: 'Overloaded' }, {}, 'busy', /busy/],
    [500, { type: 'api_error', message: 'x' }, {}, 'busy', /busy/],
    [400, { type: 'invalid_request_error', message: 'tools.0: bad' }, {}, 'request', /refused the request\. tools\.0: bad\./],
  ];
  for (const [status, error, headers, kind, sentence] of cases) {
    const { fetch } = recordingFetch([json({ type: 'error', error }, { status, headers })]);
    const failure = await collect(createAnthropicProvider({ fetch }).stream({ key: 'k', model: 'm', system: 's', messages: MESSAGES, tools: [] }))
      .then(() => null, caught => caught);
    assert.ok(failure instanceof ProviderError, `${status} ${error.type}`);
    assert.equal(failure.kind, kind, `${status} ${error.type}`);
    assert.match(failure.message, sentence);
    if (headers['retry-after']) assert.equal(failure.retryAfterMs, 12_000);
  }
  const { fetch } = recordingFetch([new TypeError('Failed to fetch')]);
  await assert.rejects(collect(createAnthropicProvider({ fetch }).stream({ key: 'k', model: 'm', system: 's', messages: MESSAGES, tools: [] })),
    error => error.kind === 'network' && /could not be reached/.test(error.message));
});

test('Anthropic: models are listed from every page, with their window, output limit and pictures', async () => {
  const model = (id, more = {}) => ({
    id, display_name: id.toUpperCase(), max_input_tokens: 1_000_000, max_tokens: 128_000,
    capabilities: { image_input: { supported: true }, effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: false }, max: { supported: true } } },
    ...more,
  });
  const { fetch, requests } = recordingFetch([
    json({ data: [model('claude-new')], has_more: true, last_id: 'claude-new' }),
    json({ data: [model('claude-old', { max_input_tokens: 200_000, max_tokens: 64_000, capabilities: {} })], has_more: false, last_id: 'claude-old' }),
  ]);
  const models = await createAnthropicProvider({ fetch }).models({ key: 'k' });
  assert.deepEqual(requests.map(request => request.url), [
    'https://api.anthropic.com/v1/models?limit=1000',
    'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-new',
  ]);
  assert.deepEqual(models, [
    { id: 'claude-new', label: 'CLAUDE-NEW', contextTokens: 1_000_000, outputTokens: 128_000, images: true, efforts: ['low', 'medium', 'high', 'max'] },
    { id: 'claude-old', label: 'CLAUDE-OLD', contextTokens: 200_000, outputTokens: 64_000, images: null, efforts: null },
  ]);
});

// -------------------------------------------------------------------- OpenAI

const STRICT_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'pattern', 'minimum',
  'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'description',
]);

function assertStrict(schema, path) {
  if (schema === null || typeof schema !== 'object') return;
  for (const key of Object.keys(schema)) assert.ok(STRICT_KEYWORDS.has(key), `${path}: "${key}" is not in OpenAI's strict subset`);
  const types = schema.type === undefined ? [] : [].concat(schema.type);
  if (types.includes('object')) {
    assert.equal(schema.additionalProperties, false, path);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path}: every property is required`);
    for (const [name, sub] of Object.entries(schema.properties)) assertStrict(sub, `${path}.${name}`);
  }
  if (schema.items) assertStrict(schema.items, `${path}[]`);
  for (const [i, sub] of (schema.anyOf ?? []).entries()) assertStrict(sub, `${path}|${i}`);
}

test('OpenAI: every tool of the catalogue is strict where its schema allows, and exactly so', () => {
  const tools = openaiToolsOf(TOOLS);
  assert.equal(tools.length, TOOLS.length);
  for (const tool of tools) {
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(tool.type, 'function');
    if (tool.strict) assertStrict(tool.parameters, tool.name);
  }
  // Only a tool with an optional property that may itself be null is sent as it is (null would mean two things).
  const loose = tools.filter(tool => !tool.strict).map(tool => tool.name);
  for (const name of loose) {
    const schema = TOOLS.find(tool => tool.name === name).inputSchema;
    assert.equal(strictSchemaOf(schema), null);
  }
  assert.ok(loose.length < tools.length / 10, `most tools are strict (${loose.join(', ')})`);
});

test('OpenAI: a strict schema says in words what strict mode lacks, and a strict call\'s nulls are taken out again', () => {
  const schema = {
    type: 'object', additionalProperties: false, required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, examples: ['T cells'] },
      seed: { type: 'integer', minimum: 0, default: 7 },
      mode: { oneOf: [{ const: 'a' }, { type: 'object', additionalProperties: false, required: ['k'], properties: { k: { type: 'string' }, extra: { type: 'boolean' } } }] },
      tags: { type: 'array', items: { type: 'string' }, uniqueItems: true, minItems: 1 },
      maybe: { type: ['string', 'null'], default: null },
    },
  };
  const strict = strictSchemaOf(schema);
  assertStrict(strict, 'demo');
  assert.equal(strict.properties.name.description, 'At least 1 character. For example "T cells".');
  assert.deepEqual(strict.properties.seed, { type: ['integer', 'null'], minimum: 0, description: 'Default 7.' });
  assert.deepEqual(strict.properties.mode.anyOf.at(-1), { type: 'null' });
  assert.deepEqual(strict.properties.mode.anyOf[1].properties.extra, { type: ['boolean', 'null'] });
  assert.equal(strict.properties.tags.description, 'No item twice.');
  assert.deepEqual(strict.properties.maybe.type, ['string', 'null'], 'an optional property whose default is null takes null as "not given"');
  assert.deepEqual(
    argsFromStrict(schema, { name: 'x', seed: null, mode: { k: 'v', extra: null }, tags: null, maybe: null }),
    { name: 'x', mode: { k: 'v' }, maybe: null },
  );
  assert.equal(strictSchemaOf({ type: 'object', additionalProperties: false, properties: { knn: { type: ['string', 'null'] } } }), null);
  assert.deepEqual(strictSchemaOf({ type: 'object', additionalProperties: false }), { type: 'object', additionalProperties: false, properties: {}, required: [] });
});

test('OpenAI: the request keeps nothing at OpenAI, asks for encrypted reasoning, and sends the conversation as input items', async () => {
  const { fetch, requests } = recordingFetch([sse([{ data: { type: 'response.completed', response: { output: [], usage: { input_tokens: 50, output_tokens: 2, input_tokens_details: { cached_tokens: 40 } } } } }])]);
  const events = await collect(createOpenAIProvider({ fetch }).stream({ key: 'sk-x', model: 'gpt-x', system: 'Be brief.', messages: MESSAGES, tools: TOOLS }));
  const [request] = requests;
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(request.headers, { 'content-type': 'application/json', authorization: 'Bearer sk-x' });
  assert.equal(request.body.store, false);
  assert.equal(request.body.stream, true);
  assert.equal(request.body.instructions, 'Be brief.');
  assert.deepEqual(request.body.include, ['reasoning.encrypted_content']);
  assert.equal(request.body.tools.length, TOOLS.length);
  assert.deepEqual(request.body.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'Color by cell type' }] },
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' },
    { role: 'assistant', content: 'Looking.' },
    { type: 'function_call', call_id: 'call-1', name: 'color_by', arguments: '{"field":{"source":"obs","key":"cell_type"}}' },
    { type: 'function_call_output', call_id: 'call-1', output: [
      { type: 'input_text', text: '{"step":{"id":"s1"}}' },
      { type: 'input_image', image_url: 'data:image/png;base64,iVBOR' },
    ] },
    { role: 'user', content: [{ type: 'input_text', text: 'Thanks' }] },
  ]);
  assert.deepEqual(events, [{ type: 'usage', input: 50, output: 2, cacheRead: 40, cacheWrite: 0 }, { type: 'stop', reason: 'end' }]);
  assert.deepEqual(openaiInputOf([{ role: 'tool', results: [{ id: 'c', name: 'n', isError: true, content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] }]),
    [{ type: 'function_call_output', call_id: 'c', output: 'a\nb' }]);
});

test('OpenAI: a model that does not reason is asked again without the reasoning, and remembered', async () => {
  const refusal = () => json({ error: { type: 'invalid_request_error', code: null, message: 'Encrypted content is not supported with this model.' } }, { status: 400 });
  const done = () => sse([{ data: { type: 'response.completed', response: { output: [], usage: {} } } }]);
  const { fetch, requests } = recordingFetch([refusal, done, done]);
  const provider = createOpenAIProvider({ fetch });
  await collect(provider.stream({ key: 'k', model: 'gpt-old', system: 's', messages: [], tools: [] }));
  await collect(provider.stream({ key: 'k', model: 'gpt-old', system: 's', messages: [], tools: [] }));
  assert.deepEqual(requests.map(request => request.body.include ?? null), [['reasoning.encrypted_content'], null, null]);
});

test('OpenAI: streamed text, encrypted reasoning, a strict call\'s arguments as the action reads them, and how an answer ends', async () => {
  const schemas = new Map([['color_by', TOOLS.find(tool => tool.name === 'color_by').inputSchema]]);
  const events = await collect(openaiEventsOf((async function* stream() {
    yield { data: { type: 'response.created', response: {} } };
    yield { data: { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_9' } } };
    yield { data: { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_9', encrypted_content: 'e9', summary: [] } } };
    yield { data: { type: 'response.output_text.delta', delta: 'Coloring' } };
    yield { data: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_9', name: 'color_by', arguments: '{"field":{"source":"obs","key":"cell_type"}}' } } };
    yield { data: { type: 'response.completed', response: { output: [{ type: 'function_call' }], usage: { input_tokens: 9, output_tokens: 3 } } } };
  })(), schemas));
  assert.deepEqual(events, [
    { type: 'thinking' },
    { type: 'opaque', value: { type: 'reasoning', id: 'rs_9', encrypted_content: 'e9', summary: [] } },
    { type: 'text', text: 'Coloring' },
    { type: 'tool-call', id: 'call_9', name: 'color_by', args: { field: { source: 'obs', key: 'cell_type' } } },
    { type: 'usage', input: 9, output: 3, cacheRead: 0, cacheWrite: 0 },
    { type: 'stop', reason: 'tool-use' },
  ]);
  const ending = async incomplete => (await collect(openaiEventsOf((async function* stream() {
    yield { data: { type: 'response.incomplete', response: { output: [], usage: {}, incomplete_details: { reason: incomplete } } } };
  })(), new Map()))).at(-1);
  assert.deepEqual(await ending('max_output_tokens'), { type: 'stop', reason: 'max-tokens' });
  assert.equal((await ending('content_filter')).reason, 'refusal');
  await assert.rejects(collect(openaiEventsOf((async function* stream() {
    yield { data: { type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } } };
  })(), new Map())), error => error.kind === 'busy');
  // A failed answer that says what it cost: counted before the failure.
  const failedCost = [];
  await assert.rejects((async () => {
    for await (const event of openaiEventsOf((async function* stream() {
      yield { data: { type: 'response.failed', response: { usage: { input_tokens: 70, output_tokens: 3 }, error: { code: 'server_error', message: 'boom' } } } };
    })(), new Map())) failedCost.push(event);
  })(), error => error.kind === 'busy');
  assert.deepEqual(failedCost, [{ type: 'usage', input: 70, output: 3, cacheRead: 0, cacheWrite: 0 }]);
  await assert.rejects(collect(openaiEventsOf((async function* stream() {
    yield { data: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'color_by', arguments: '{"field"' } } };
  })(), new Map())), error => error.kind === 'unreadable' && error.message === 'OpenAI sent a tool call Cellucid could not read.');
  await assert.rejects(collect(openaiEventsOf((async function* stream() {
    yield { data: { type: 'error', code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' } };
  })(), new Map())), error => error.kind === 'too-long');
  await assert.rejects(collect(openaiEventsOf((async function* stream() {
    yield { data: { type: 'response.created', response: {} } };
  })(), new Map())), error => error.kind === 'network');
});

test('OpenAI: each refusal of a request is one sentence of its kind; quota is not waited out', async () => {
  const cases = [
    [401, { code: 'invalid_api_key', message: 'Incorrect API key provided' }, 'auth'],
    [429, { code: 'insufficient_quota', type: 'insufficient_quota', message: 'You exceeded your current quota' }, 'quota'],
    [429, { code: 'rate_limit_exceeded', message: 'Rate limit reached' }, 'rate'],
    [404, { code: 'model_not_found', message: 'The model does not exist' }, 'model'],
    [400, { code: 'context_length_exceeded', message: 'too long' }, 'too-long'],
    [403, { code: null, message: 'Project does not have access' }, 'permission'],
    [503, { code: null, message: 'unavailable' }, 'busy'],
    [400, { code: 'invalid_value', message: 'bad tool' }, 'request'],
  ];
  for (const [status, error, kind] of cases) {
    const { fetch } = recordingFetch([json({ error }, { status })]);
    const failure = await collect(createOpenAIProvider({ fetch }).stream({ key: 'k', model: 'm', system: 's', messages: [], tools: [] })).then(() => null, caught => caught);
    assert.equal(failure?.kind, kind, `${status} ${error.code}`);
  }
});

test('OpenAI: the models listed are the ones that hold a conversation with tools, newest first, snapshots under their name left out', async () => {
  const ids = [
    ['gpt-6-luna', 30], ['gpt-6.1-sol', 40], ['gpt-6.1-sol-2026-09-01', 39], ['gpt-4o-2024-05-13', 5], ['o4-mini', 20],
    ['gpt-realtime', 41], ['gpt-image-2', 42], ['text-embedding-3-small', 43], ['tts-1', 44], ['whisper-1', 45],
    ['gpt-5-chat-latest', 46], ['gpt-4o-mini-transcribe', 47], ['davinci-002', 48], ['sora-2', 49], ['gpt-5-search-api', 50],
  ];
  const { fetch } = recordingFetch([json({ data: ids.map(([id, created]) => ({ id, created, object: 'model' })) })]);
  const models = await createOpenAIProvider({ fetch }).models({ key: 'k' });
  assert.deepEqual(models.map(model => model.id), ['gpt-6.1-sol', 'gpt-6-luna', 'o4-mini', 'gpt-4o-2024-05-13']);
  assert.deepEqual(models[0], { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol', contextTokens: null, outputTokens: null, images: null, efforts: OPENAI_EFFORTS });
});

// ------------------------------------------------------------------ Scripted

test('the scripted model streams its text in pieces, numbers its calls, fails as asked, and stops with its signal', async () => {
  const replies = [
    { text: 'abcdef', chunks: 3, calls: [{ name: 'fields_list' }, { name: 'color_by', args: { field: { source: 'obs', key: 'x' } } }] },
    { error: { kind: 'rate', message: 'Slow down.', retryAfterMs: 5 } },
    { text: 'no', stop: 'refusal', detail: 'Declined.' },
    { text: 'slow', chunks: 4, delayMs: 50 },
  ];
  const seen = [];
  const provider = createScriptedProvider({ agent: 'Claude', reply: (messages, tools) => { seen.push([messages.length, tools.length]); return replies.shift(); } });
  assert.equal(provider.agent, 'Claude');
  assert.equal(provider.needsKey, false);
  const first = await collect(provider.stream({ messages: [{ role: 'user', text: 'hi' }], tools: TOOLS }));
  assert.deepEqual(first.filter(event => event.type !== 'usage'), [
    { type: 'text', text: 'ab' }, { type: 'text', text: 'cd' }, { type: 'text', text: 'ef' },
    { type: 'tool-call', id: 'call-1', name: 'fields_list', args: {} },
    { type: 'tool-call', id: 'call-2', name: 'color_by', args: { field: { source: 'obs', key: 'x' } } },
    { type: 'stop', reason: 'tool-use' },
  ]);
  await assert.rejects(collect(provider.stream({ messages: [], tools: [] })), error => error.kind === 'rate' && error.retryAfterMs === 5);
  assert.deepEqual((await collect(provider.stream({ messages: [], tools: [] }))).at(-1), { type: 'stop', reason: 'refusal', detail: 'Declined.' });
  const controller = new AbortController();
  const got = [];
  await assert.rejects((async () => {
    for await (const event of provider.stream({ messages: [], tools: [], signal: controller.signal })) {
      got.push(event);
      controller.abort(new DOMException('stopped', 'AbortError'));
    }
  })(), error => error.name === 'AbortError');
  assert.deepEqual(got, [{ type: 'text', text: 's' }]);
  assert.deepEqual(seen[0], [1, TOOLS.length]);
});

test('the page offers the scripted model only on a development host with a script installed', () => {
  const script = { reply: () => ({}) };
  assert.deepEqual(providersForPage({ win: null }).map(provider => provider.id), ['anthropic', 'openai']);
  assert.deepEqual(providersForPage({ win: { [AGENT_SCRIPT_GLOBAL]: script } }).map(provider => provider.id), ['anthropic', 'openai'],
    'no development host (Node has no window location)');
  const previous = globalThis.window;
  globalThis.window = { location: { hostname: 'localhost', protocol: 'http:' } };
  try {
    assert.deepEqual(providersForPage({ win: { [AGENT_SCRIPT_GLOBAL]: script } }).map(provider => provider.id), ['anthropic', 'openai', 'scripted']);
    assert.deepEqual(providersForPage({ win: {} }).map(provider => provider.id), ['anthropic', 'openai']);
    globalThis.window = { location: { hostname: 'www.cellucid.com', protocol: 'https:' } };
    assert.deepEqual(providersForPage({ win: { [AGENT_SCRIPT_GLOBAL]: script } }).map(provider => provider.id), ['anthropic', 'openai']);
  } finally {
    globalThis.window = previous;
  }
});

// ------------------------------------------------------------------ Effort

test('the effort: Anthropic sends it as output_config and lists the levels each model takes; none chosen sends none', async () => {
  assert.deepEqual(ANTHROPIC_EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(effortsOf(undefined), null);
  assert.equal(effortsOf({ effort: { supported: false, low: { supported: true } } }), null);
  assert.equal(effortsOf({ effort: { supported: true } }), null, 'no level named');
  assert.deepEqual(effortsOf({ effort: { supported: true, high: { supported: true }, low: { supported: true }, max: { supported: false } } }), ['low', 'high']);
  const done = () => sse([
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
  const { fetch, requests } = recordingFetch([done, done]);
  const provider = createAnthropicProvider({ fetch });
  await collect(provider.stream({ key: 'k', model: 'm', system: 's', messages: [], tools: [], effort: 'xhigh' }));
  await collect(provider.stream({ key: 'k', model: 'm', system: 's', messages: [], tools: [] }));
  assert.deepEqual(requests[0].body.output_config, { effort: 'xhigh' });
  assert.equal('output_config' in requests[1].body, false);
});

test('the effort: OpenAI sends it as reasoning.effort; a refused effort is the person\'s to see and keeps the reasoning asked for', async () => {
  const done = () => sse([{ data: { type: 'response.completed', response: { output: [], usage: {} } } }]);
  const effortRefused = () => json({ error: { type: 'invalid_request_error', param: 'reasoning.effort', code: 'unsupported_value', message: "Unsupported value: 'reasoning.effort' does not support 'minimal' with this model." } }, { status: 400 });
  const { fetch, requests } = recordingFetch([done, effortRefused, done]);
  const provider = createOpenAIProvider({ fetch });
  await collect(provider.stream({ key: 'k', model: 'gpt-x', system: 's', messages: [], tools: [], effort: 'high' }));
  assert.deepEqual(requests[0].body.reasoning, { effort: 'high' });
  await assert.rejects(collect(provider.stream({ key: 'k', model: 'gpt-x', system: 's', messages: [], tools: [], effort: 'minimal' })),
    error => error.kind === 'request' && error.param === 'reasoning.effort' && /does not support 'minimal'/.test(error.message));
  assert.equal(requests.length, 2, 'not asked again without the reasoning');
  await collect(provider.stream({ key: 'k', model: 'gpt-x', system: 's', messages: [], tools: [] }));
  assert.deepEqual(requests[2].body.include, ['reasoning.encrypted_content'], 'the model is still asked for its reasoning');
  assert.equal('reasoning' in requests[2].body, false);
  // An include refused by name is the one asked again without it.
  const includeRefused = () => json({ error: { type: 'invalid_request_error', param: 'include', message: 'This model does not support that value.' } }, { status: 400 });
  const second = recordingFetch([includeRefused, done]);
  await collect(createOpenAIProvider({ fetch: second.fetch }).stream({ key: 'k', model: 'gpt-y', system: 's', messages: [], tools: [] }));
  assert.deepEqual(second.requests.map(request => request.body.include ?? null), [['reasoning.encrypted_content'], null]);
});

test('the effort: the scripted model is given the effort chosen', async () => {
  const efforts = [];
  const provider = createScriptedProvider({ reply: (messages, tools, { effort }) => { efforts.push(effort); return { text: 'ok' }; } });
  assert.deepEqual((await provider.models({}))[0].efforts, ['low', 'high']);
  await collect(provider.stream({ messages: [], tools: [], effort: 'high' }));
  await collect(provider.stream({ messages: [], tools: [] }));
  assert.deepEqual(efforts, ['high', null]);
});

// ------------------------------------------------------------- Refused key

test('Anthropic: a key refused without the headers a browser needs is told apart from a lost request and from no connection', async () => {
  const unreadable = () => new TypeError('Failed to fetch');
  const keyless = () => json({ type: 'error', error: { type: 'authentication_error', message: 'x-api-key header is required' } }, { status: 401 });
  const stream = provider => collect(provider.stream({ key: 'sk-ant-x', model: 'm', system: 's', messages: [], tools: [] }));
  // Reachable without the key, unreadable with it: the key was refused.
  const refused = recordingFetch([unreadable(), keyless(), unreadable()]);
  await assert.rejects(stream(createAnthropicProvider({ fetch: refused.fetch })), error => error.kind === 'auth' && /did not accept this API key/.test(error.message));
  assert.deepEqual(refused.requests.map(request => [request.method, request.url, 'x-api-key' in request.headers]), [
    ['POST', 'https://api.anthropic.com/v1/messages', true],
    ['GET', 'https://api.anthropic.com/v1/models?limit=1', false],
    ['GET', 'https://api.anthropic.com/v1/models?limit=1', true],
  ]);
  // The key answered readably: the request was lost on the way (a flaky link, a gateway's page), so it is waited out.
  const lost = recordingFetch([unreadable(), keyless(), json({ data: [], has_more: false })]);
  await assert.rejects(stream(createAnthropicProvider({ fetch: lost.fetch })), error => error.kind === 'network' && isRetryable(error));
  // Nothing answers: no connection, and the key is not tried.
  const offline = recordingFetch([unreadable(), unreadable()]);
  await assert.rejects(stream(createAnthropicProvider({ fetch: offline.fetch })), error => error.kind === 'network');
  assert.equal(offline.requests.length, 2);
  // The model list is told apart the same way.
  const listing = recordingFetch([unreadable(), keyless(), unreadable()]);
  await assert.rejects(createAnthropicProvider({ fetch: listing.fetch }).models({ key: 'k' }), error => error.kind === 'auth');
});
