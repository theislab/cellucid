/**
 * @fileoverview The one contract every model provider of the chat bar keeps,
 * and what they share: their failures as one error with a kind the chat
 * acts on, the server-sent-event reader, and the request that turns a
 * dropped connection into such a failure.
 *
 * A provider (`providers/<id>.js`) is a plain object:
 *
 * | Field | What it is |
 * | --- | --- |
 * | `id` | stable id (`anthropic`, `openai`): the key setting and a saved conversation name it |
 * | `label` | what the settings list it as ("Claude (Anthropic)") |
 * | `agent` | who the history says took a step ("Claude"): `meta.agent` of every dispatch |
 * | `needsKey` | whether it takes an API key |
 * | `keyLabel`, `keyPlaceholder`, `keyUrl` | the key field's label and hint, where a key is made |
 * | `defaultModel` | the model chosen until the person picks one (used when the key's list holds it) |
 * | `models({key, signal})` | the models this key may use, newest first: `[{id, label, contextTokens, outputTokens, images, efforts}]` (`efforts`: the effort or reasoning levels the person may choose, lowest first; `null` for what the provider does not say) |
 * | `stream({key, model, system, messages, tools, signal, outputTokens, effort})` | one model call, as an async iterable of events (below); `effort` null leaves the model's own |
 *
 * **Messages** are provider-neutral (`chat/conversation.js` makes them):
 * `{role: 'user', text}`, `{role: 'assistant', parts}` with parts
 * `{type: 'text', text}`, `{type: 'tool-call', id, name, args}` and
 * `{type: 'opaque', provider, value}` (what one provider asks to have sent
 * back unchanged, such as a model's reasoning; another provider leaves it
 * out), and `{role: 'tool', results: [{id, name, content, isError}]}` whose
 * content is MCP content (`{type: 'text', text}`, `{type: 'image', data,
 * mimeType}`). Tools are MCP tools (`bridge/mcp-tools.js`): each provider
 * converts them to its own format, so there is one tool list.
 *
 * **Events** of `stream`: `{type: 'text', text}` (a piece of the reply),
 * `{type: 'thinking'}` (the model is reasoning; nothing to show),
 * `{type: 'tool-call', id, name, args}` (complete), `{type: 'opaque', value}`,
 * `{type: 'usage', input, output, cacheRead, cacheWrite}` (the tokens of the
 * call so far, `input` counting the whole prompt, cached parts included; a
 * later one replaces an earlier one: a provider that tells the prompt's as
 * it starts answering says so then, so a call that fails or is stopped
 * after is still counted), and last `{type: 'stop',
 * reason}` with reason `end`, `tool-use`, `max-tokens` or `refusal` (and
 * `detail`, a sentence, for a refusal).
 *
 * **Failures** are thrown as `ProviderError` with a `kind`: `auth` (the key
 * is refused), `permission`, `quota` (no credit left), `rate` (too many
 * requests: wait `retryAfterMs` and try again), `busy` (the provider is
 * overloaded or failed: try again), `network` (no connection), `unreadable`
 * (an answer Cellucid could not read, a tool call's arguments that are not
 * JSON: asked once more), `model` (the model does not exist or this key may
 * not use it), `too-long` (the conversation does not fit the model),
 * `request` (anything else the provider refused). The message is one sentence a person reads. A stopped
 * call ends with the cancellation of its signal, never a `ProviderError`.
 *
 * @module app/agent/providers/contract
 */

import { isCancellation, throwIfAborted } from '../../../utils/abort.js';

export const PROVIDER_ERROR_KINDS = Object.freeze([
  'auth', 'permission', 'quota', 'rate', 'busy', 'network', 'unreadable', 'model', 'too-long', 'request',
]);

/** The kinds a turn waits out and tries again (an `unreadable` answer is asked for once more only, `agent-loop.js`). */
const RETRYABLE = new Set(['rate', 'busy', 'network']);

export const STOP_REASONS = Object.freeze(['end', 'tool-use', 'max-tokens', 'refusal']);

/** A model call that failed, with what kind of failure it is and one sentence for the person. */
export class ProviderError extends Error {
  /**
   * @param {string} kind - one of `PROVIDER_ERROR_KINDS`
   * @param {string} message - one sentence
   * @param {{retryAfterMs?: number|null, status?: number|null, param?: string|null, cause?: unknown}} [details] -
   *   `param`: the request parameter the provider named as refused, when it named one
   */
  constructor(kind, message, { retryAfterMs = null, status = null, param = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    if (!PROVIDER_ERROR_KINDS.includes(kind)) throw new RangeError(`Unknown provider error kind "${kind}"`);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
    this.param = param;
  }
}

/** Whether a turn waits and tries `error` again (too many requests, overloaded, no connection). */
export function isRetryable(error) {
  return error instanceof ProviderError && RETRYABLE.has(error.kind);
}

const PROVIDER_KEYS = ['id', 'label', 'agent', 'needsKey', 'defaultModel', 'models', 'stream'];

/**
 * Check that `provider` keeps the contract (module overview); returns it frozen.
 * @param {object} provider
 */
export function checkProvider(provider) {
  for (const key of PROVIDER_KEYS) {
    if (provider?.[key] === undefined) throw new TypeError(`A model provider needs ${key}`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(provider.id)) throw new TypeError(`Provider id "${provider.id}" must be lowercase words`);
  for (const key of ['label', 'agent']) {
    if (typeof provider[key] !== 'string' || provider[key].trim() === '') throw new TypeError(`Provider ${provider.id} needs a ${key}`);
  }
  if (typeof provider.needsKey !== 'boolean') throw new TypeError(`Provider ${provider.id} says whether it needs a key`);
  if (provider.needsKey) {
    for (const key of ['keyLabel', 'keyPlaceholder', 'keyUrl']) {
      if (typeof provider[key] !== 'string' || provider[key] === '') throw new TypeError(`Provider ${provider.id} needs ${key}`);
    }
  }
  for (const key of ['models', 'stream']) {
    if (typeof provider[key] !== 'function') throw new TypeError(`Provider ${provider.id} ${key} must be a function`);
  }
  return Object.freeze(provider);
}

/**
 * How long a response asks to be waited for before the next request
 * (`retry-after`: seconds or an HTTP date), or null.
 * @param {{get: (name: string) => string|null}} headers
 * @param {() => number} [now]
 */
export function retryAfterOf(headers, now = () => Date.now()) {
  const value = headers?.get?.('retry-after');
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now()) : null;
}

/**
 * `fetch`, with a connection that failed (offline, DNS, a dropped link, a
 * blocked request) as a `network` ProviderError; a stopped request stays
 * the cancellation of `signal`.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} init
 * @param {string} who - the provider's name, for the sentence
 */
export async function providerFetch(fetchImpl, url, init, who) {
  throwIfAborted(init.signal);
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (isCancellation(error) || init.signal?.aborted) {
      throwIfAborted(init.signal);
      throw error;
    }
    throw new ProviderError('network', `${who} could not be reached. Check the connection; Cellucid tries again.`, { cause: error });
  }
}

/**
 * The server-sent events of a streamed response, as `{event, data}` (data
 * parsed as JSON). A link that drops mid-stream is a `network` ProviderError.
 *
 * @param {Response} response
 * @param {AbortSignal|null} signal
 * @param {string} who
 * @returns {AsyncGenerator<{event: string|null, data: unknown}>}
 */
export async function* readServerEvents(response, signal, who) {
  if (response.body === null) throw new ProviderError('network', `${who} sent an empty answer.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = null;
  let data = [];
  /** One line of the stream; the event it completes, or null. */
  const take = line => {
    if (line === '') {
      const done = data.length > 0 ? { event, data: parseEventData(data.join('\n'), who) } : null;
      event = null;
      data = [];
      return done;
    }
    if (line.startsWith(':')) return null; // a comment (keep-alive)
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    return null;
  };
  let finished = false;
  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        finished = true;
        throwIfAborted(signal);
        if (isCancellation(error)) throw error;
        throw new ProviderError('network', `The connection to ${who} dropped during the answer; Cellucid tries again.`, { cause: error });
      }
      if (chunk.done) {
        finished = true;
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
        // A CR that ends what came so far may be half of a CRLF: wait for the rest.
        if (newline === buffer.length - 1 && buffer.endsWith('\r')) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer.startsWith('\r\n', newline) ? 2 : 1));
        const done = take(line);
        if (done !== null) yield done;
      }
    }
    // A stream that ends without its last blank line still ends its event.
    buffer += decoder.decode();
    for (const line of [...buffer.split(/\r\n|\r|\n/).filter(rest => rest !== ''), '']) {
      const done = take(line);
      if (done !== null) yield done;
    }
  } finally {
    // Left early (the call is over, or stopped): the rest is not downloaded.
    if (!finished) reader.cancel().catch(() => {});
  }
}

function parseEventData(text, who) {
  if (text === '[DONE]') return '[DONE]';
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ProviderError('unreadable', `${who} sent an answer Cellucid could not read.`, { cause });
  }
}

/**
 * The body of a refused request as `{type, code, message}`, whatever the
 * provider wrote (JSON error object, plain text, nothing).
 * @param {Response} response
 */
export async function errorBodyOf(response) {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return { type: null, code: null, param: null, message: '' };
  }
  try {
    const body = JSON.parse(text);
    const error = body?.error ?? body;
    return {
      type: typeof error?.type === 'string' ? error.type : null,
      code: typeof error?.code === 'string' ? error.code : null,
      param: typeof error?.param === 'string' ? error.param : null,
      message: typeof error?.message === 'string' ? error.message : '',
    };
  } catch {
    return { type: null, code: null, param: null, message: text.slice(0, 300) };
  }
}

/** A provider's own message as the end of a sentence (trimmed, one line, a full stop). */
export function saidBy(message) {
  const line = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (line === '') return '';
  return /[.!?]$/.test(line) ? ` ${line}` : ` ${line}.`;
}
