/**
 * @fileoverview Claude through the Anthropic API, with the person's own API
 * key, called from this tab (`anthropic-dangerous-direct-browser-access`:
 * Anthropic answers a browser directly; the key goes nowhere else).
 *
 * - **Models** are listed from `GET /v1/models` (every page), with each
 *   model's context window, output limit, whether it reads images and the
 *   effort levels it takes (`capabilities.effort`; the person's choice is
 *   sent as `output_config.effort`, none chosen leaves the model's own
 *   default; adaptive thinking is the model's), so no list in the code goes
 *   stale. `claude-opus-5-5` is chosen until the
 *   person picks another, when the key may use it.
 * - **A call** is `POST /v1/messages`, streamed. The instructions and the
 *   tools are the cached prefix (`cache_control` on the system text, which
 *   follows the tools), and the conversation is cached as it grows (the
 *   request's own `cache_control`). A model's reasoning (`thinking` blocks,
 *   with their signatures) comes back as `opaque` parts and is sent back
 *   unchanged, in its place, as Anthropic requires within a conversation.
 * - **Progress notes.** The models that write a short note for the person
 *   between tool calls (what they found, what they do next) return it as a
 *   `thinking` block, empty unless the request asks for it
 *   (`thinking.display: "updates"`, beta `thinking-display-updates-2026-08-18`):
 *   asked of those models (`PROGRESS_MODELS`), each note's text streams as
 *   `progress` events the chat shows before the call it introduces, and its
 *   block goes back unchanged like any reasoning. Showing them costs nothing
 *   more: the notes are written and billed the same under every display.
 * - **Tool results** are `tool_result` blocks with the MCP text and
 *   pictures (`image` blocks); a refusal is `is_error`.
 * - **Failures** map to the contract's kinds by status and Anthropic's
 *   error type (`authentication_error`, `rate_limit_error` with
 *   `retry-after`, `overloaded_error`, a prompt too long, a model not
 *   found, a credit balance too low).
 *
 * @module app/agent/providers/anthropic
 */

import {
  ProviderError, checkProvider, errorBodyOf, providerFetch, readServerEvents, retryAfterOf, saidBy,
} from './contract.js';

export const ANTHROPIC_API = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2026-10-21';
const WHO = 'Anthropic';
/** The output limit sent when the key's model list did not say the model's own. */
const FALLBACK_OUTPUT_TOKENS = 64_000;

function headersFor(key, betas = []) {
  return {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    ...(betas.length === 0 ? {} : { 'anthropic-beta': betas.join(',') }),
  };
}

/** The beta under which `thinking.display: "updates"` returns the progress notes' text. */
export const PROGRESS_BETA = 'thinking-display-updates-2026-08-18';

/**
 * The models that write progress notes between tool calls and take
 * `thinking.display: "updates"`, as Anthropic's Thinking page lists them
 * ("Progress updates between tool calls"). The model list
 * (`/v1/models`) does not say which models do, and the setting cannot be
 * sent to every model: it comes with `thinking: {type: "adaptive"}`, which
 * turns thinking on for a model that runs without it by default (Claude
 * Opus 4.8, 4.7, 4.6, Sonnet 4.6), a cost the person did not choose. A model
 * not listed is asked nothing and reads as before; one listed whose
 * request is refused for the setting is asked again without it, and not
 * asked again (`refusesProgress`).
 */
export const PROGRESS_MODELS = Object.freeze([
  'claude-opus-5-5', 'claude-sonnet-5-5',
  'claude-fable-5-2', 'claude-mythos-5-2', 'claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5',
]);

/** The thinking setting that returns progress notes (sent with `PROGRESS_BETA`). */
const PROGRESS_THINKING = Object.freeze({ type: 'adaptive', display: 'updates' });

/**
 * Whether Anthropic refused a request for its progress-notes setting (the
 * beta or the display value unknown to this account or platform): a refused
 * request whose sentence names the display or the beta. Anything else is
 * the person's to see.
 */
function refusesProgress(error) {
  return error instanceof ProviderError && error.kind === 'request' && /display|thinking-display-updates|anthropic-beta/i.test(error.message);
}

/** A refused request as a ProviderError of the contract's kind. */
export async function anthropicErrorOf(response) {
  const { type, message } = await errorBodyOf(response);
  const status = response.status;
  const retryAfterMs = retryAfterOf(response.headers);
  const said = saidBy(message);
  const details = { status, retryAfterMs };
  if (status === 401 || type === 'authentication_error') {
    return new ProviderError('auth', 'Anthropic did not accept this API key. Check it in the chat settings.', details);
  }
  if (status === 403 || type === 'permission_error') {
    return new ProviderError('permission', `This Anthropic API key may not do that.${said}`, details);
  }
  if (/credit balance/i.test(message) || type === 'billing_error') {
    return new ProviderError('quota', `The Anthropic account of this key has no credit left.${said}`, details);
  }
  if (status === 404 || type === 'not_found_error') {
    return new ProviderError('model', `This model is not available to this Anthropic API key; choose another in the chat settings.${said}`, details);
  }
  if (status === 413 || /prompt is too long|too many tokens|context window|exceeds the maximum/i.test(message)) {
    return new ProviderError('too-long', `The conversation is too long for this model.${said}`, details);
  }
  if (status === 429 || type === 'rate_limit_error') {
    return new ProviderError('rate', 'Anthropic asked Cellucid to slow down; Cellucid tries again shortly.', details);
  }
  if (status === 529 || status >= 500 || type === 'overloaded_error' || type === 'api_error') {
    return new ProviderError('busy', 'Anthropic is busy or had a problem; Cellucid tries again shortly.', details);
  }
  return new ProviderError('request', `Anthropic refused the request.${said}`, details);
}

/**
 * `fetch` to Anthropic, with a refused key told apart from no connection.
 * Anthropic answers a refused key without the headers that let a browser
 * read an answer from another site (CORS), so in a browser it fails like a
 * dropped connection (as does a gateway's error page, or one request lost on
 * a flaky link). So a request that could not be read is followed by two
 * small ones (the model list, one model): without the key, which Anthropic
 * answers readably when it is reachable; and with the key, which it answers
 * readably only when it accepts the key. The key was refused only when the
 * first is answered and the second cannot be read; anything else is the
 * connection, waited out and tried again.
 */
async function anthropicFetch(fetchImpl, url, init) {
  try {
    return await providerFetch(fetchImpl, url, init, WHO);
  } catch (error) {
    if (!(error instanceof ProviderError) || error.kind !== 'network') throw error;
    if (await answersReadably(fetchImpl, null, init.signal) && !(await answersReadably(fetchImpl, init.headers, init.signal))) {
      throw new ProviderError('auth', 'Anthropic did not accept this API key. Check it in the chat settings.', { cause: error });
    }
    throw error;
  }
}

/** Whether Anthropic answers its model list readably, without a key (`headers` null) or with the request's headers. */
async function answersReadably(fetchImpl, headers, signal) {
  try {
    const response = await fetchImpl(`${ANTHROPIC_API}/v1/models?limit=1`, {
      method: 'GET',
      headers: headers ?? { 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' },
      signal,
    });
    return typeof response?.status === 'number';
  } catch {
    return false;
  }
}

/** An `error` event inside a stream as a ProviderError. */
function streamErrorOf(error) {
  const type = error?.type ?? null;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (type === 'overloaded_error' || type === 'api_error') {
    return new ProviderError('busy', 'Anthropic is busy or had a problem; Cellucid tries again shortly.');
  }
  if (type === 'rate_limit_error') return new ProviderError('rate', 'Anthropic asked Cellucid to slow down; Cellucid tries again shortly.');
  if (/prompt is too long|context window/i.test(message)) return new ProviderError('too-long', `The conversation is too long for this model.${saidBy(message)}`);
  return new ProviderError('request', `Anthropic stopped the answer.${saidBy(message)}`);
}

/** The effort levels Anthropic names, lowest first (`output_config.effort`). */
export const ANTHROPIC_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * The effort levels a model takes, as its capabilities (`/v1/models`) list
 * them, or null when it takes no effort setting.
 * @param {object|undefined} capabilities
 */
export function effortsOf(capabilities) {
  const effort = capabilities?.effort;
  if (effort?.supported !== true) return null;
  const levels = ANTHROPIC_EFFORTS.filter(level => effort[level]?.supported === true);
  return levels.length === 0 ? null : Object.freeze(levels);
}

/** MCP tools (`bridge/mcp-tools.js`) as Anthropic tools. */
export function anthropicToolsOf(tools) {
  return tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
}

function toolResultContent(content) {
  return content.map(item => (item.type === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: item.mimeType, data: item.data } }
    : { type: 'text', text: item.text }));
}

/**
 * Provider-neutral messages (`contract.js`) as Anthropic messages: a turn
 * whose role repeats is joined to the one before (tool results and the
 * person's next words go in one user message); an assistant message with
 * nothing to send is left out; reasoning kept by another provider is left out.
 */
export function anthropicMessagesOf(messages) {
  const out = [];
  const push = (role, blocks) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const message of messages) {
    if (message.role === 'user') {
      push('user', [{ type: 'text', text: message.text }]);
    } else if (message.role === 'assistant') {
      const blocks = [];
      for (const part of message.parts) {
        if (part.type === 'text' && part.text !== '') blocks.push({ type: 'text', text: part.text });
        else if (part.type === 'tool-call') blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: part.args });
        else if (part.type === 'opaque' && part.provider === 'anthropic') blocks.push(part.value);
      }
      push('assistant', blocks);
    } else if (message.role === 'tool') {
      push('user', message.results.map(result => ({
        type: 'tool_result', tool_use_id: result.id, content: toolResultContent(result.content), ...(result.isError ? { is_error: true } : {}),
      })));
    }
  }
  return out;
}

const STOPS = new Map([
  ['end_turn', 'end'], ['stop_sequence', 'end'], ['tool_use', 'tool-use'], ['max_tokens', 'max-tokens'],
  ['refusal', 'refusal'], ['pause_turn', 'end'],
]);

function usageOf(usage) {
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  return {
    input: (usage?.input_tokens ?? 0) + cacheRead + cacheWrite,
    output: usage?.output_tokens ?? 0,
    cacheRead,
    cacheWrite,
  };
}

/**
 * The events of one streamed `/v1/messages` answer, in the contract's terms.
 * @param {AsyncIterable<{event: string|null, data: any}>} events
 * @param {{progress?: boolean}} [options] - `progress`: the request asked for
 *   the progress notes (`thinking.display: "updates"`), so a `thinking` block's
 *   text is a note for the person, streamed as `progress` events (a reasoning
 *   block stays empty under that display)
 */
export async function* anthropicEventsOf(events, { progress = false } = {}) {
  const blocks = new Map();
  /** Anthropic's own usage fields: `message_start` gives them, `message_delta` updates some. */
  let raw = {};
  let stop = null;
  let detail = null;
  for await (const { data } of events) {
    switch (data?.type) {
      case 'message_start':
        raw = { ...(data.message?.usage ?? {}) };
        // The prompt's tokens, known now: a call that fails or is stopped from here is counted.
        yield { type: 'usage', ...usageOf(raw) };
        break;
      case 'content_block_start': {
        const block = structuredClone(data.content_block);
        if (block.type === 'tool_use') block.json = '';
        blocks.set(data.index, block);
        if (block.type === 'thinking' || block.type === 'redacted_thinking') yield { type: 'thinking' };
        break;
      }
      case 'content_block_delta': {
        const block = blocks.get(data.index);
        const delta = data.delta;
        if (block === undefined) break;
        if (delta.type === 'text_delta') {
          block.text = (block.text ?? '') + delta.text;
          yield { type: 'text', text: delta.text };
        } else if (delta.type === 'input_json_delta') {
          block.json += delta.partial_json;
        } else if (delta.type === 'thinking_delta') {
          block.thinking = (block.thinking ?? '') + delta.thinking;
          if (progress && block.type === 'thinking' && typeof delta.thinking === 'string' && delta.thinking !== '') {
            yield { type: 'progress', text: delta.thinking };
          }
        } else if (delta.type === 'signature_delta') {
          block.signature = (block.signature ?? '') + delta.signature;
        }
        break;
      }
      case 'content_block_stop': {
        const block = blocks.get(data.index);
        if (block === undefined) break;
        if (block.type === 'tool_use') {
          let args;
          try {
            args = block.json === '' ? {} : JSON.parse(block.json);
          } catch (cause) {
            throw new ProviderError('unreadable', 'Anthropic sent a tool call Cellucid could not read.', { cause });
          }
          yield { type: 'tool-call', id: block.id, name: block.name, args };
        } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          yield { type: 'opaque', value: block };
        }
        break;
      }
      case 'message_delta':
        if (data.delta?.stop_reason) stop = data.delta.stop_reason;
        if (data.delta?.stop_details?.explanation) detail = data.delta.stop_details.explanation;
        for (const [field, value] of Object.entries(data.usage ?? {})) {
          if (typeof value === 'number') raw[field] = value;
        }
        break;
      case 'error':
        throw streamErrorOf(data.error);
      default:
        break;
    }
  }
  if (stop === null) throw new ProviderError('network', 'The answer from Anthropic ended early; Cellucid tries again.');
  yield { type: 'usage', ...usageOf(raw) };
  yield { type: 'stop', reason: STOPS.get(stop) ?? 'end', ...(detail === null ? {} : { detail }) };
}

/**
 * @param {{fetch?: typeof fetch}} [options]
 */
export function createAnthropicProvider({ fetch: fetchImpl = (input, init) => globalThis.fetch(input, init) } = {}) {
  /** Models whose requests were refused for the progress-notes setting (`refusesProgress`): not asked again. */
  const withoutProgress = new Set();

  return checkProvider({
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    agent: 'Claude',
    needsKey: true,
    keyLabel: 'Anthropic API key',
    keyPlaceholder: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-opus-5-5',

    async models({ key, signal = null }) {
      const out = [];
      let after = null;
      do {
        const url = `${ANTHROPIC_API}/v1/models?limit=1000${after === null ? '' : `&after_id=${encodeURIComponent(after)}`}`;
        const response = await anthropicFetch(fetchImpl, url, { method: 'GET', headers: headersFor(key), signal });
        if (!response.ok) throw await anthropicErrorOf(response);
        const page = await response.json();
        for (const model of page.data ?? []) {
          out.push(Object.freeze({
            id: model.id,
            label: model.display_name ?? model.id,
            contextTokens: Number.isSafeInteger(model.max_input_tokens) ? model.max_input_tokens : null,
            outputTokens: Number.isSafeInteger(model.max_tokens) ? model.max_tokens : null,
            images: typeof model.capabilities?.image_input?.supported === 'boolean' ? model.capabilities.image_input.supported : null,
            efforts: effortsOf(model.capabilities),
          }));
        }
        after = page.has_more === true && typeof page.last_id === 'string' ? page.last_id : null;
      } while (after !== null);
      return out;
    },

    // How long the cached prompt (instructions, tools, the conversation so far) is kept: the
    // person's choice (Chat settings); an hour costs more to write and spares the rewrite after
    // a pause longer than five minutes.
    cacheLengths: Object.freeze(['5m', '1h']),

    async *stream({ key, model, system, messages, tools, signal = null, outputTokens = null, effort = null, cacheLength = '5m' }) {
      const cache = cacheLength === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
      const body = {
        model,
        max_tokens: outputTokens ?? FALLBACK_OUTPUT_TOKENS,
        stream: true,
        // The person's effort for the model; left out, the model's own default.
        ...(effort === null ? {} : { output_config: { effort } }),
        cache_control: cache,
        system: [{ type: 'text', text: system, cache_control: cache }],
        tools: anthropicToolsOf(tools),
        messages: anthropicMessagesOf(messages),
      };
      // The model's notes between tool calls, as text the chat shows (the module overview).
      let progress = PROGRESS_MODELS.includes(model) && !withoutProgress.has(model);
      const send = () => anthropicFetch(fetchImpl, `${ANTHROPIC_API}/v1/messages`, {
        method: 'POST',
        headers: headersFor(key, progress ? [PROGRESS_BETA] : []),
        body: JSON.stringify(progress ? { ...body, thinking: PROGRESS_THINKING } : body),
        signal,
      });
      let response = await send();
      if (!response.ok) {
        const error = await anthropicErrorOf(response);
        if (!(progress && refusesProgress(error))) throw error;
        withoutProgress.add(model);
        progress = false;
        response = await send();
        if (!response.ok) throw await anthropicErrorOf(response);
      }
      yield* anthropicEventsOf(readServerEvents(response, signal, WHO), { progress });
    },
  });
}
