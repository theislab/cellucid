/**
 * @fileoverview OpenAI's models (the ones behind ChatGPT) through the OpenAI
 * API, with the person's own API key, called from this tab.
 *
 * - **Models** are listed from `GET /v1/models`, keeping the ones that hold
 *   a conversation with tools: the list names every model of the account,
 *   speech, images and embeddings included, and says nothing of what each
 *   does, so models whose id names another kind of output are left out, and
 *   a dated snapshot is left out when its undated name is listed. Newest
 *   first. `gpt-6.1-sol` is chosen until the person picks another, when the
 *   key may use it.
 * - **A call** is the Responses API (`POST /v1/responses`), streamed, with
 *   `store: false`: OpenAI keeps no copy of the conversation; this tab holds
 *   it. The person's reasoning effort is `reasoning.effort` (none chosen:
 *   the model's own default). A reasoning model's reasoning comes back encrypted (`include:
 *   reasoning.encrypted_content`) as `opaque` parts, sent back unchanged so
 *   the model keeps its reasoning between tool calls.
 * - **Strict tool schemas.** A tool is `strict` when its schema can be said
 *   exactly in OpenAI's strict subset (`strictSchemaOf`): every property is
 *   required, an optional one takes `null` for "not given", `oneOf` becomes
 *   `anyOf`, and a keyword strict mode lacks (a string's length, unique
 *   items, a default, examples) is said in the description instead. A call's
 *   arguments then have those `null`s taken out again (`argsFromStrict`)
 *   before the dispatcher checks them against the action's own schema. A
 *   tool with an optional property that itself may be `null` cannot be said
 *   that way (a `null` would mean both), so it is sent as it is, not strict.
 * - **Failures** map by status and OpenAI's error code (`invalid_api_key`,
 *   `insufficient_quota`, `rate_limit_exceeded`, `model_not_found`,
 *   `context_length_exceeded`), also when they arrive inside the stream.
 *
 * @module app/agent/providers/openai
 */

import {
  ProviderError, checkProvider, errorBodyOf, providerFetch, readServerEvents, retryAfterOf, saidBy,
} from './contract.js';
import { formatCountOf } from '../../../utils/format-units.js';

export const OPENAI_API = 'https://api.openai.com';
const WHO = 'OpenAI';
const REASONING_INCLUDE = 'reasoning.encrypted_content';

/** Words in a model id that name an output other than a conversation with tools. */
const NOT_CHAT = /(audio|tts|transcribe|realtime|image|embedding|moderation|whisper|search|instruct|live|translate|diarize|chat-latest|davinci|babbage|sora)/;
const CHAT_FAMILY = /^(gpt-|o\d)/;
const DATED = /-\d{4}-\d{2}-\d{2}$/;

/**
 * The reasoning efforts OpenAI names (`reasoning.effort`), lowest first.
 * Which a model takes is not listed by the API (a model refuses one it does
 * not take, in one sentence the chat shows), so every level is offered and
 * none chosen leaves the model's own default.
 */
export const OPENAI_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function headersFor(key) {
  return { 'content-type': 'application/json', authorization: `Bearer ${key}` };
}

function errorFor({ status, code, type, param = null, message }, retryAfterMs = null) {
  const said = saidBy(message);
  const details = { status, retryAfterMs, param };
  if (status === 401 || code === 'invalid_api_key') {
    return new ProviderError('auth', 'OpenAI did not accept this API key. Check it in the chat settings.', details);
  }
  if (code === 'insufficient_quota' || type === 'insufficient_quota') {
    return new ProviderError('quota', `The OpenAI account of this key has no credit left.${said}`, details);
  }
  if (code === 'model_not_found' || status === 404) {
    return new ProviderError('model', `This model is not available to this OpenAI API key; choose another in the chat settings.${said}`, details);
  }
  if (code === 'context_length_exceeded' || /context (length|window)|maximum context/i.test(message ?? '')) {
    return new ProviderError('too-long', `The conversation is too long for this model.${said}`, details);
  }
  if (status === 403) return new ProviderError('permission', `This OpenAI API key may not do that.${said}`, details);
  if (status === 429 || code === 'rate_limit_exceeded') {
    return new ProviderError('rate', 'OpenAI asked Cellucid to slow down; Cellucid tries again shortly.', details);
  }
  if ((status !== null && status >= 500) || code === 'server_error' || type === 'server_error') {
    return new ProviderError('busy', 'OpenAI is busy or had a problem; Cellucid tries again shortly.', details);
  }
  return new ProviderError('request', `OpenAI refused the request.${said}`, details);
}

/** A refused request as a ProviderError of the contract's kind. */
export async function openaiErrorOf(response) {
  const { type, code, param, message } = await errorBodyOf(response);
  return errorFor({ status: response.status, code, type, param, message }, retryAfterOf(response.headers));
}

// --------------------------------------------------------------- Strict tools

const STRICT_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf',
  'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'description',
]);

function typesOf(schema) {
  if (schema.type === undefined) return null;
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

/** Whether `schema` accepts null as it is. */
function acceptsNull(schema) {
  if (typesOf(schema)?.includes('null')) return true;
  if (schema.const === null || schema.enum?.includes(null)) return true;
  return (schema.oneOf ?? schema.anyOf ?? []).some(acceptsNull);
}

/** What a keyword strict mode lacks says, as a sentence of the description. */
function notesOf(schema) {
  const notes = [];
  if (schema.minLength !== undefined) notes.push(`At least ${formatCountOf(schema.minLength, 'character')}.`);
  if (schema.maxLength !== undefined) notes.push(`At most ${formatCountOf(schema.maxLength, 'character')}.`);
  if (schema.uniqueItems === true) notes.push('No item twice.');
  if (schema.default !== undefined) notes.push(`Default ${JSON.stringify(schema.default)}.`);
  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    notes.push(`For example ${schema.examples.map(example => JSON.stringify(example)).join(' or ')}.`);
  }
  return notes;
}

function withNull(schema) {
  if (acceptsNull(schema)) return schema;
  if (schema.anyOf !== undefined) return { ...schema, anyOf: [...schema.anyOf, { type: 'null' }] };
  if (schema.const !== undefined || schema.enum !== undefined) {
    const values = schema.const !== undefined ? [schema.const] : schema.enum;
    const { const: _const, ...rest } = schema;
    const types = typesOf(schema);
    return { ...rest, enum: [...values, null], ...(types === null ? {} : { type: [...types, 'null'] }) };
  }
  return { ...schema, type: [...typesOf(schema), 'null'] };
}

class NotStrict extends Error {}

function strictOf(schema) {
  if (schema === null || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'oneOf') out.anyOf = value.map(strictOf);
    else if (key === 'properties') {
      const required = new Set(schema.required ?? []);
      out.properties = Object.fromEntries(Object.entries(value).map(([name, sub]) => {
        if (required.has(name)) return [name, strictOf(sub)];
        // Optional: "not given" is null, which must not already mean something.
        if (acceptsNull(sub) && sub.default !== null) throw new NotStrict(name);
        return [name, withNull(strictOf(sub))];
      }));
      out.required = Object.keys(value);
    } else if (key === 'items') out.items = strictOf(value);
    else if (key === 'required') continue;
    else if (STRICT_KEYWORDS.has(key)) out[key] = value;
  }
  if (typesOf(schema)?.includes('object') && out.properties === undefined) {
    out.properties = {};
    out.required = [];
  }
  const notes = notesOf(schema);
  if (notes.length > 0) out.description = [schema.description, ...notes].filter(Boolean).join(' ');
  return out;
}

/**
 * `schema` in OpenAI's strict subset (module overview), or null when it
 * cannot be said there exactly.
 * @param {object} schema
 */
export function strictSchemaOf(schema) {
  try {
    return strictOf(schema);
  } catch (error) {
    if (error instanceof NotStrict) return null;
    throw error;
  }
}

function matchesShape(schema, value) {
  if (value === null) return acceptsNull(schema);
  const types = typesOf(schema);
  if (Array.isArray(value)) return types === null || types.includes('array');
  if (typeof value === 'object') {
    if (types !== null && !types.includes('object')) return false;
    const properties = schema.properties ?? {};
    return Object.keys(value).every(key => Object.hasOwn(properties, key));
  }
  return true;
}

/**
 * A strict call's arguments as the action's own schema reads them: an
 * optional property given as null ("not given") is left out.
 * @param {object} schema - the tool's own (not strict) schema
 * @param {unknown} value
 */
export function argsFromStrict(schema, value) {
  if (value === null || typeof value !== 'object' || schema === null || typeof schema !== 'object') return value;
  if (Array.isArray(value)) return schema.items === undefined ? value : value.map(item => argsFromStrict(schema.items, item));
  const branches = schema.oneOf ?? schema.anyOf;
  if (branches !== undefined) {
    const branch = branches.find(candidate => matchesShape(candidate, value));
    return branch === undefined ? value : argsFromStrict(branch, value);
  }
  if (schema.properties === undefined) return value;
  const required = new Set(schema.required ?? []);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const sub = schema.properties[key];
    if (sub === undefined) { out[key] = item; continue; }
    if (item === null && !required.has(key) && !acceptsNull(sub)) continue;
    out[key] = argsFromStrict(sub, item);
  }
  return out;
}

/** MCP tools as OpenAI function tools: strict where the schema allows. */
export function openaiToolsOf(tools) {
  return tools.map(tool => {
    const strict = strictSchemaOf(tool.inputSchema);
    return {
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: strict ?? tool.inputSchema,
      strict: strict !== null,
    };
  });
}

// ----------------------------------------------------------------- Messages

function outputOf(content) {
  if (content.every(item => item.type === 'text')) return content.map(item => item.text).join('\n');
  return content.map(item => (item.type === 'image'
    ? { type: 'input_image', image_url: `data:${item.mimeType};base64,${item.data}` }
    : { type: 'input_text', text: item.text }));
}

/** Provider-neutral messages as the Responses API's input items. */
export function openaiInputOf(messages) {
  const out = [];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'input_text', text: message.text }] });
    } else if (message.role === 'assistant') {
      for (const part of message.parts) {
        if (part.type === 'text' && part.text !== '') {
          out.push({ role: 'assistant', content: part.text });
        } else if (part.type === 'tool-call') {
          out.push({ type: 'function_call', call_id: part.id, name: part.name, arguments: JSON.stringify(part.args) });
        } else if (part.type === 'opaque' && part.provider === 'openai') {
          out.push(part.value);
        }
      }
    } else if (message.role === 'tool') {
      for (const result of message.results) {
        out.push({ type: 'function_call_output', call_id: result.id, output: outputOf(result.content) });
      }
    }
  }
  return out;
}

function usageOf(usage) {
  return {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    cacheRead: usage?.input_tokens_details?.cached_tokens ?? 0,
    cacheWrite: 0,
  };
}

/**
 * The events of one streamed Responses API answer, in the contract's terms.
 * @param {AsyncIterable<{event: string|null, data: any}>} events
 * @param {Map<string, object>} schemas - each tool's own schema by name (to read strict arguments)
 */
export async function* openaiEventsOf(events, schemas) {
  let finished = null;
  for await (const { data } of events) {
    switch (data?.type) {
      case 'response.output_item.added':
        if (data.item?.type === 'reasoning') yield { type: 'thinking' };
        break;
      case 'response.output_text.delta':
        yield { type: 'text', text: data.delta };
        break;
      case 'response.output_item.done': {
        const item = data.item;
        if (item?.type === 'function_call') {
          let args;
          try {
            args = item.arguments === '' ? {} : JSON.parse(item.arguments);
          } catch (cause) {
            throw new ProviderError('unreadable', 'OpenAI sent a tool call Cellucid could not read.', { cause });
          }
          const schema = schemas.get(item.name);
          yield { type: 'tool-call', id: item.call_id, name: item.name, args: schema === undefined ? args : argsFromStrict(schema, args) };
        } else if (item?.type === 'reasoning') {
          yield { type: 'opaque', value: item };
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete':
        finished = data.response;
        break;
      case 'response.failed': {
        // What the failed call cost, when OpenAI says.
        if (data.response?.usage) yield { type: 'usage', ...usageOf(data.response.usage) };
        const error = data.response?.error ?? {};
        throw errorFor({ status: null, code: error.code ?? null, type: null, message: error.message ?? '' });
      }
      case 'error':
        throw errorFor({ status: null, code: data.code ?? data.error?.code ?? null, type: data.error?.type ?? null, message: data.message ?? data.error?.message ?? '' });
      default:
        break;
    }
  }
  if (finished === null) throw new ProviderError('network', 'The answer from OpenAI ended early; Cellucid tries again.');
  yield { type: 'usage', ...usageOf(finished.usage) };
  const calls = (finished.output ?? []).some(item => item.type === 'function_call');
  const reason = finished.incomplete_details?.reason ?? null;
  if (reason === 'content_filter') yield { type: 'stop', reason: 'refusal', detail: 'OpenAI\'s content filter stopped the answer.' };
  else if (reason === 'max_output_tokens') yield { type: 'stop', reason: 'max-tokens' };
  else yield { type: 'stop', reason: calls ? 'tool-use' : 'end' };
}

/**
 * Whether OpenAI refused the encrypted reasoning asked for (a model that does
 * not reason): the parameter it names is `include`, or, when it names none,
 * its sentence names the encrypted content. A refusal of anything else (the
 * reasoning effort among them) is the person's to see, not a reason to stop
 * asking for the reasoning.
 */
function refusesReasoningInclude(error) {
  if (!(error instanceof ProviderError) || error.kind !== 'request') return false;
  if (error.param !== null) return error.param === 'include' || error.param.startsWith('include[');
  return /encrypted[_ ]content/i.test(error.message);
}

/**
 * @param {{fetch?: typeof fetch}} [options]
 */
export function createOpenAIProvider({ fetch: fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  /** Models found not to take `include: reasoning.encrypted_content`. */
  const withoutReasoning = new Set();

  async function request({ key, body, signal }) {
    return providerFetch(fetchImpl, `${OPENAI_API}/v1/responses`, {
      method: 'POST', headers: headersFor(key), body: JSON.stringify(body), signal,
    }, WHO);
  }

  return checkProvider({
    id: 'openai',
    label: 'ChatGPT (OpenAI)',
    agent: 'ChatGPT',
    needsKey: true,
    keyLabel: 'OpenAI API key',
    keyPlaceholder: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-6.1-sol',

    async models({ key, signal = null }) {
      const response = await providerFetch(fetchImpl, `${OPENAI_API}/v1/models`, { method: 'GET', headers: headersFor(key), signal }, WHO);
      if (!response.ok) throw await openaiErrorOf(response);
      const listed = (await response.json()).data ?? [];
      const ids = new Set(listed.map(model => model.id));
      return listed
        .filter(model => CHAT_FAMILY.test(model.id) && !NOT_CHAT.test(model.id))
        .filter(model => !(DATED.test(model.id) && ids.has(model.id.replace(DATED, ''))))
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id))
        .map(model => Object.freeze({ id: model.id, label: model.id, contextTokens: null, outputTokens: null, images: null, efforts: OPENAI_EFFORTS }));
    },

    async *stream({ key, model, system, messages, tools, signal = null, outputTokens = null, effort = null }) {
      const schemas = new Map(tools.map(tool => [tool.name, tool.inputSchema]));
      const body = {
        model,
        instructions: system,
        input: openaiInputOf(messages),
        tools: openaiToolsOf(tools),
        stream: true,
        store: false,
        ...(effort === null ? {} : { reasoning: { effort } }),
        ...(outputTokens === null ? {} : { max_output_tokens: outputTokens }),
        ...(withoutReasoning.has(model) ? {} : { include: [REASONING_INCLUDE] }),
      };
      let response = await request({ key, body, signal });
      if (!response.ok) {
        const error = await openaiErrorOf(response);
        if (!(body.include && refusesReasoningInclude(error))) throw error;
        withoutReasoning.add(model);
        delete body.include;
        response = await request({ key, body, signal });
        if (!response.ok) throw await openaiErrorOf(response);
      }
      yield* openaiEventsOf(readServerEvents(response, signal, WHO), schemas);
    },
  });
}
