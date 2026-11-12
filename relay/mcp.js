/**
 * `/`: the MCP endpoint, the relay's root (Streamable HTTP, JSON-RPC 2.0, one message per
 * POST, answered with one JSON object).
 *
 * Both kinds of client are served on the same endpoint:
 *
 * - **Per-request metadata (2026-07-28)**: every request carries its protocol
 *   version and client capabilities in `_meta`, mirrored in the
 *   `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers; a header
 *   that disagrees with the body, missing metadata and an unknown version
 *   each answer 400 with the error the specification names. No sessions:
 *   `server/discover` tells what the server is.
 * - **Initialize handshake (2025-03-26 to 2025-11-25)**, which Claude's
 *   connectors speak today: `initialize` answers the server's capabilities
 *   and instructions; no session id is issued (the server keeps no session),
 *   GET and DELETE answer 405.
 *
 * Methods: `initialize`, `ping`, `server/discover`, `tools/list` (the
 * connected tab's catalog, else the bundled one, plus `cellucid_status`),
 * `tools/call` (run by the tab the person approved this connection from,
 * as the connection's agent), `resources/list`, `resources/read` and
 * `resources/templates/list` (the view card, an MCP App: `view-app.js`),
 * `subscriptions/listen` (acknowledged with no notification types, then
 * closed: the tool list does not change while listening). Anything else is
 * "method not found".
 */

import { RELAY_BUNDLE } from './generated/bundle.js';
import { RelayHttpError, emptyResponse, isJson, jsonResponse, readBody, withBaseHeaders } from './http.js';
import { askPairing } from './oauth.js';
import { randomBase64Url, textOf } from './encoding.js';
import { viewAppContents, viewAppListing } from './view-app.js';

export const MODERN_VERSIONS = Object.freeze(['2026-07-28']);
export const HANDSHAKE_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);
const SUPPORTED_VERSIONS = Object.freeze([...MODERN_VERSIONS, ...HANDSHAKE_VERSIONS]);
/**
 * The largest MCP request body read: one tool call written by a model (a
 * model writes at most a few hundred kilobytes in one answer); larger is not
 * a tool call.
 */
export const MCP_BODY_MAX_BYTES = 4 * 1024 * 1024;
const TOOL_LIST_TTL_MS = 60_000;

const SERVER_INFO = Object.freeze({
  name: 'cellucid',
  title: 'Cellucid',
  version: RELAY_BUNDLE.appVersion,
  websiteUrl: RELAY_BUNDLE.appOrigin,
});

const ERRORS = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  resourceNotFound: -32002,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
});

/** What the server offers: tools, and the resource of its view card (a list that does not change). */
const CAPABILITIES = Object.freeze({ tools: { listChanged: false }, resources: { listChanged: false } });

const NO_TAB = `No Cellucid tab is connected to this chat. Ask the person to open Cellucid (${RELAY_BUNDLE.appOrigin}) `
  + `in the browser they approved this connection from; it reconnects by itself. Then try again, or call ${RELAY_BUNDLE.statusTool.name}.`;

function rpcError(id, code, message, data = undefined) {
  return { jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } };
}

class RpcFailure extends Error {
  constructor(status, code, message, data = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/** A header value, Base64-decoded when it uses the `=?base64?…?=` form. */
function headerValue(value) {
  if (value === null) return null;
  const match = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
  if (match === null) return value;
  try {
    const binary = atob(match[1]);
    return textOf(Uint8Array.from(binary, character => character.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

/**
 * Which kind of client sent `message`, after checking what that kind must send.
 * @returns {'modern'|'handshake'}
 */
function eraOf(request, message) {
  const meta = message.params?._meta;
  const bodyVersion = meta?.['io.modelcontextprotocol/protocolVersion'];
  const headerVersion = request.headers.get('MCP-Protocol-Version');
  const modern = message.method !== 'initialize'
    && (bodyVersion !== undefined || (headerVersion !== null && !HANDSHAKE_VERSIONS.includes(headerVersion)));
  if (!modern) return 'handshake';
  if (typeof bodyVersion !== 'string') {
    throw new RpcFailure(400, ERRORS.invalidParams, 'The request has no _meta "io.modelcontextprotocol/protocolVersion"');
  }
  const capabilities = meta['io.modelcontextprotocol/clientCapabilities'];
  if (capabilities === null || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new RpcFailure(400, ERRORS.invalidParams, 'The request has no _meta "io.modelcontextprotocol/clientCapabilities"');
  }
  if (headerVersion !== bodyVersion) {
    throw new RpcFailure(400, ERRORS.headerMismatch, `Header mismatch: MCP-Protocol-Version ${JSON.stringify(headerVersion)} does not match the body's ${JSON.stringify(bodyVersion)}`);
  }
  const method = request.headers.get('Mcp-Method');
  if (method !== message.method) {
    throw new RpcFailure(400, ERRORS.headerMismatch, `Header mismatch: Mcp-Method ${JSON.stringify(method)} does not match the body's ${JSON.stringify(message.method)}`);
  }
  if (message.method === 'tools/call') {
    const name = headerValue(request.headers.get('Mcp-Name'));
    if (name !== message.params?.name) {
      throw new RpcFailure(400, ERRORS.headerMismatch, `Header mismatch: Mcp-Name does not match the body's tool name ${JSON.stringify(message.params?.name)}`);
    }
  }
  if (!MODERN_VERSIONS.includes(bodyVersion)) {
    throw new RpcFailure(400, ERRORS.unsupportedVersion, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: bodyVersion });
  }
  return 'modern';
}

function complete(era, result) {
  return era === 'modern'
    ? { resultType: 'complete', ...result, _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } }
    : result;
}

function toolResult(text, isError) {
  return { content: [{ type: 'text', text }], isError };
}

/**
 * Ask the connection's pairing; a pairing that cannot answer now (its
 * Durable Object restarting under a new deployment, or the platform
 * shedding it) is an outcome of its own, never a failed request: the tab
 * reconnects by itself within seconds.
 */
async function pairingAnswer(env, auth, path, body) {
  try {
    return await askPairing(env, auth.pairingId, path, body);
  } catch (error) {
    console.error('Cellucid relay pairing unavailable', { name: error?.name, message: error?.message });
    return { outcome: 'unavailable' };
  }
}

const UNAVAILABLE = 'The Cellucid relay restarted or was briefly unavailable during this call, and the Cellucid tab reconnects by itself within seconds. '
  + 'Read the history (history_get) before repeating a change, then try again.';

async function listTools(env, auth) {
  const answer = await pairingAnswer(env, auth, '/list', { grant: auth.grant });
  if (answer.outcome === 'revoked') throw auth.challenge('invalid_token', 'This connection was removed in Cellucid; connect again');
  const tools = answer.outcome === 'tools' ? answer.tools : RELAY_BUNDLE.tools;
  return [...tools, RELAY_BUNDLE.statusTool];
}

/**
 * A result's JSON as its data, as the tab writes every result
 * (`relay-protocol.js` `resultDataText`): between the data tags, every `<`
 * escaped, so a dataset's name in it is data the agent never takes for
 * instructions.
 */
function dataText(json) {
  const tags = RELAY_BUNDLE.protocol.resultData;
  return `${tags.open}${json.replaceAll('<', '\\u003c')}${tags.close}`;
}

function statusText(answer) {
  if (answer.tabs.length === 0) return dataText(JSON.stringify({ connected: false, agent: answer.agent, advice: NO_TAB }));
  return dataText(JSON.stringify({
    connected: true,
    agent: answer.agent,
    tabs: answer.tabs.map(tab => ({
      receivesCalls: tab.receivesCalls,
      focused: tab.focused,
      visible: tab.visible,
      dataset: tab.dataset,
      cellucidVersion: tab.version,
    })),
  }));
}

async function callTool(env, auth, request, rpcId, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (typeof name !== 'string' || name.length === 0) throw new RpcFailure(200, ERRORS.invalidParams, 'tools/call needs params.name');
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new RpcFailure(200, ERRORS.invalidParams, 'tools/call params.arguments must be an object');
  }
  if (name === RELAY_BUNDLE.statusTool.name) {
    const answer = await pairingAnswer(env, auth, '/status', { grant: auth.grant });
    if (answer.outcome === 'revoked') throw auth.challenge('invalid_token', 'This connection was removed in Cellucid; connect again');
    if (answer.outcome === 'unavailable') return toolResult(UNAVAILABLE, true);
    return toolResult(statusText(answer), false);
  }
  const callId = randomBase64Url(12);
  const cancelOnDisconnect = () => {
    askPairing(env, auth.pairingId, '/cancel', { callId }).catch(() => {});
  };
  request.signal?.addEventListener('abort', cancelOnDisconnect, { once: true });
  let answer;
  try {
    answer = await pairingAnswer(env, auth, '/call', { grant: auth.grant, callId, rpcId, tool: name, args });
  } finally {
    request.signal?.removeEventListener('abort', cancelOnDisconnect);
  }
  switch (answer.outcome) {
    case 'result': return answer.result;
    case 'revoked': throw auth.challenge('invalid_token', 'This connection was removed in Cellucid; connect again');
    case 'no-tab':
      if (!RELAY_BUNDLE.tools.some(tool => tool.name === name)) throw new RpcFailure(200, ERRORS.invalidParams, `Unknown tool: ${name}`);
      return toolResult(NO_TAB, true);
    case 'unknown-tool': throw new RpcFailure(200, ERRORS.invalidParams, `Unknown tool: ${name}`);
    case 'timeout':
      return toolResult('Cellucid did not finish within the time a tool call has (it was stopped). '
        + 'Read the history before repeating a change.', true);
    case 'asking':
      return toolResult(`Cellucid is asking the person in their tab whether to go ahead${answer.detail ? ` (${answer.detail})` : ''}, `
        + 'and they have not answered within the time a tool call has. The question stays open in Cellucid: '
        + 'ask the person to answer it there. Once they have, read the history (history_get) to see whether it ran; do not call this again before that.', true);
    case 'tab-closed':
      return toolResult('The Cellucid tab closed, was reloaded or lost its connection before it answered, so whether this call was done is not known. '
        + 'A reloaded tab connects again by itself within seconds: read the history (history_get) before repeating a change.', true);
    case 'cancelled': return toolResult('The call was canceled.', true);
    case 'removed':
      return toolResult('This connection was removed in Cellucid while this call ran, and Cellucid stopped the call. '
        + 'The person must connect this app again before it can work there; once connected, read the history (history_get) before repeating a change.', true);
    case 'unavailable': return toolResult(UNAVAILABLE, true);
    case 'oversize':
      return toolResult(`The answer was ${answer.chars} characters, more than a chat accepts (${RELAY_BUNDLE.protocol.resultTextChars}). Ask for fewer rows or a narrower read.`, true);
    case 'oversize-image':
      return toolResult(`The picture was ${answer.bytes} characters of base64, more than a chat accepts (${RELAY_BUNDLE.protocol.resultImageMaxBytes}). Ask for a smaller picture.`, true);
    default:
      return toolResult('The Cellucid tab sent an answer the relay cannot pass on. Reload the Cellucid page and try again.', true);
  }
}

/** Events as one Server-Sent Events answer, with the relay's headers and the endpoint's CORS, as every other answer. */
function sse(events, cors) {
  const body = events.map(event => `event: message\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const headers = withBaseHeaders(cors);
  headers.set('Content-Type', 'text/event-stream');
  headers.set('X-Accel-Buffering', 'no');
  return new Response(body, { status: 200, headers });
}

/**
 * Answer one POST to the MCP endpoint (`/`) from an authenticated connection.
 * @param {Request} request
 * @param {object} env
 * @param {{pairingId: string, grant: string, challenge: Function}} auth
 * @param {HeadersInit} cors
 */
export async function handleMcpPost(request, env, auth, cors) {
  if (!isJson(request)) {
    return jsonResponse(rpcError(null, ERRORS.invalidRequest, 'Send one JSON-RPC message as application/json'), 415, cors);
  }
  const text = textOf(await readBody(request, MCP_BODY_MAX_BYTES));
  let message;
  try {
    message = JSON.parse(text ?? '');
  } catch {
    return jsonResponse(rpcError(null, ERRORS.parse, 'The body is not JSON'), 400, cors);
  }
  if (Array.isArray(message)) {
    return jsonResponse(rpcError(null, ERRORS.invalidRequest, 'Send one JSON-RPC message per request (batches are not supported)'), 400, cors);
  }
  if (message === null || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    return jsonResponse(rpcError(null, ERRORS.invalidRequest, 'The body is not a JSON-RPC 2.0 message'), 400, cors);
  }
  if (typeof message.method !== 'string') {
    return jsonResponse(rpcError(message.id, ERRORS.invalidRequest, 'This server sends no requests, so it takes no responses'), 400, cors);
  }
  if (!Object.hasOwn(message, 'id')) {
    if (message.method === 'notifications/cancelled' && message.params?.requestId !== undefined) {
      // A pairing restarting has no call left to stop.
      await askPairing(env, auth.pairingId, '/cancel', { grant: auth.grant, rpcId: message.params.requestId }).catch(() => {});
    }
    return emptyResponse(202, cors);
  }
  const { id } = message;
  if (!(typeof id === 'string' || Number.isSafeInteger(id))) {
    return jsonResponse(rpcError(null, ERRORS.invalidRequest, 'A request id is a string or an integer'), 400, cors);
  }
  let era = 'handshake';
  try {
    era = eraOf(request, message);
    let result;
    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion;
        result = {
          protocolVersion: HANDSHAKE_VERSIONS.includes(requested) ? requested : HANDSHAKE_VERSIONS[0],
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
          instructions: RELAY_BUNDLE.instructions,
        };
        break;
      }
      case 'ping':
        result = {};
        break;
      case 'server/discover':
        if (era !== 'modern') throw new RpcFailure(200, ERRORS.methodNotFound, 'server/discover is part of protocol 2026-07-28');
        result = {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: CAPABILITIES,
          instructions: RELAY_BUNDLE.instructions,
          ttlMs: TOOL_LIST_TTL_MS,
          cacheScope: 'public',
        };
        break;
      case 'tools/list':
        if (message.params?.cursor !== undefined) {
          throw new RpcFailure(200, ERRORS.invalidParams, 'Every tool is on one page; there is no cursor');
        }
        result = { tools: await listTools(env, auth) };
        if (era === 'modern') Object.assign(result, { ttlMs: TOOL_LIST_TTL_MS, cacheScope: 'private' });
        break;
      case 'tools/call':
        result = await callTool(env, auth, request, id, message.params);
        break;
      case 'resources/list':
        if (message.params?.cursor !== undefined) {
          throw new RpcFailure(200, ERRORS.invalidParams, 'Every resource is on one page; there is no cursor');
        }
        result = { resources: [viewAppListing()] };
        break;
      case 'resources/templates/list':
        result = { resourceTemplates: [] };
        break;
      case 'resources/read': {
        const uri = message.params?.uri;
        if (typeof uri !== 'string') throw new RpcFailure(200, ERRORS.invalidParams, 'resources/read needs params.uri');
        if (uri !== RELAY_BUNDLE.protocol.viewApp.uri) {
          throw new RpcFailure(200, ERRORS.resourceNotFound, `Resource not found: ${uri}`, { uri });
        }
        result = { contents: [viewAppContents()] };
        break;
      }
      case 'subscriptions/listen':
        if (era !== 'modern') throw new RpcFailure(200, ERRORS.methodNotFound, 'Method not found: subscriptions/listen');
        return sse([
          { jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { _meta: { 'io.modelcontextprotocol/subscriptionId': id }, notifications: {} } },
          { jsonrpc: '2.0', id, result: { resultType: 'complete', _meta: { 'io.modelcontextprotocol/subscriptionId': id } } },
        ], cors);
      default:
        throw new RpcFailure(era === 'modern' ? 404 : 200, ERRORS.methodNotFound, `Method not found: ${message.method}`);
    }
    return jsonResponse({ jsonrpc: '2.0', id, result: complete(era, result) }, 200, cors);
  } catch (error) {
    if (error instanceof RpcFailure) {
      return jsonResponse(rpcError(id, error.code, error.message, error.data), error.status, cors);
    }
    if (error instanceof RelayHttpError) throw error;
    console.error('Cellucid relay MCP error', { name: error?.name, message: error?.message });
    return jsonResponse(rpcError(id, ERRORS.internal, 'The relay failed to answer'), 500, cors);
  }
}
