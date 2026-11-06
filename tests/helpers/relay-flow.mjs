/**
 * Steps of the relay's flows for its contract tests: register a client,
 * start an authorization, connect a tab, approve in it, exchange the code,
 * call the MCP endpoint (the relay's root). Each step goes through `worker.fetch` with real `Request`s.
 */

import assert from 'node:assert/strict';

export const RELAY = 'https://relay.test';
/** The MCP endpoint and the OAuth resource: the relay's origin (MCP is answered at `/`). */
export const RESOURCE = RELAY;
export const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
export const APP_ORIGIN = 'https://www.cellucid.com';

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

/** A tab secret derived from `seed` (43 base64url characters). */
export function tabSecret(seed) {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) bytes[index] = (seed * 31 + index * 7) & 255;
  return base64Url(bytes);
}

export async function pkce(seed = 'v') {
  const verifier = `${seed}`.repeat(50).slice(0, 50);
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

export function send(worker, env, path, init = {}) {
  return worker.fetch(new Request(path.startsWith('http') ? path : `${RELAY}${path}`, init), env);
}

export async function register(worker, env, { redirectUris = [CLAUDE_REDIRECT], name = 'Claude' } = {}) {
  const response = await send(worker, env, '/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: name, token_endpoint_auth_method: 'none' }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).client_id;
}

export function authorizeUrl({ clientId, redirectUri = CLAUDE_REDIRECT, challenge, state = 'state-1', resource = RESOURCE, method = 'S256', responseType = 'code', extra = {} }) {
  const url = new URL(`${RELAY}/oauth/authorize`);
  const params = { response_type: responseType, client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: method, state, resource, scope: 'cellucid', ...extra };
  for (const [name, value] of Object.entries(params)) if (value !== null && value !== undefined) url.searchParams.set(name, value);
  return url.href;
}

/** Start an authorization; returns the page and the connect code and page secret it shows. */
export async function startAuthorization(worker, env, options) {
  const response = await send(worker, env, authorizeUrl(options));
  const html = await response.text();
  const code = /data-code="([^"]+)"/.exec(html)?.[1] ?? null;
  const request = /data-request="([^"]+)"/.exec(html)?.[1] ?? null;
  return { response, html, code, request };
}

/** Open a tab's socket; resolves once the relay welcomed it. */
export async function connectTab(worker, env, { secret = tabSecret(1), origin = APP_ORIGIN, protocol = 'cellucid-relay.1' } = {}) {
  const response = await send(worker, env, '/tab', {
    headers: { Upgrade: 'websocket', Origin: origin, 'Sec-WebSocket-Protocol': `${protocol}, cellucid-secret.${secret}` },
  });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  await socket.next(message => message.type === 'welcome');
  return { socket, response };
}

let nextRef = 1;
/** Send a tab request (claim, decide, connections, …) and wait for its reply. */
export async function tabRequest(socket, message) {
  const ref = nextRef++;
  socket.send(JSON.stringify({ ...message, ref }));
  await socket.settle();
  return socket.next(reply => reply.type === 'reply' && reply.ref === ref);
}

/** Report focus from a tab. */
export async function focus(socket, { focused = true, dataset = 'Pancreas', version = '0.9.6' } = {}) {
  socket.send(JSON.stringify({ type: 'state', focused, visible: true, dataset, version }));
  await socket.settle();
}

export async function waitAnswer(worker, env, { code, request, seen = null, cancel = false }) {
  const response = await send(worker, env, '/oauth/authorize/wait', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, request, seen, cancel }),
  });
  return { status: response.status, body: await response.json() };
}

export async function exchange(worker, env, fields) {
  return send(worker, env, '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

/**
 * The whole connection: register (or a given client), authorize, approve in
 * a tab, exchange the code. Returns the tokens and the tab.
 */
export async function connectAgent(worker, env, { clientId = null, redirectUri = CLAUDE_REDIRECT, secret = tabSecret(1), tab = null } = {}) {
  const client = clientId ?? await register(worker, env, { redirectUris: [redirectUri] });
  const { verifier, challenge } = await pkce();
  const started = await startAuthorization(worker, env, { clientId: client, redirectUri, challenge });
  assert.equal(started.response.status, 200, started.html);
  const connected = tab ?? await connectTab(worker, env, { secret });
  const claimed = await tabRequest(connected.socket, { type: 'claim', code: started.code });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const decided = await tabRequest(connected.socket, { type: 'decide', code: started.code, allow: true });
  assert.equal(decided.ok, true, JSON.stringify(decided));
  const answer = await waitAnswer(worker, env, { code: started.code, request: started.request });
  assert.equal(answer.body.status, 'approved');
  const redirect = new URL(answer.body.redirect);
  const response = await exchange(worker, env, {
    grant_type: 'authorization_code',
    code: redirect.searchParams.get('code'),
    client_id: client,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource: RESOURCE,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const tokens = await response.json();
  return { tokens, tab: connected, clientId: client, redirect, started };
}

/** POST one JSON-RPC message to the MCP endpoint (`/`). */
export function mcp(worker, env, token, message, headers = {}) {
  return send(worker, env, '/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: JSON.stringify(message),
  });
}

/** Headers and `_meta` of a 2026-07-28 request. */
export function modern(method, params = {}, { version = '2026-07-28', name = undefined } = {}) {
  const message = {
    jsonrpc: '2.0',
    id: 7,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': version,
        'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
  const headers = { 'MCP-Protocol-Version': version, 'Mcp-Method': method };
  if (name !== undefined) headers['Mcp-Name'] = name;
  return { message, headers };
}

/** Answer the tab's calls with `handler(call)` (its MCP result), and tool lists with `tools`. */
export function serveTab(socket, { handler = null, tools = null } = {}) {
  const calls = [];
  socket.addEventListener('message', event => {
    if (!String(event.data).startsWith('{')) return;
    const message = JSON.parse(event.data);
    if (message.type === 'call') {
      calls.push(message);
      if (handler !== null) {
        Promise.resolve(handler(message)).then(answer => {
          if (answer !== undefined) socket.send(JSON.stringify({ type: 'result', id: message.id, ...answer }));
        });
      }
    }
    if (message.type === 'list' && tools !== null) socket.send(JSON.stringify({ type: 'tools', id: message.id, tools }));
  });
  return calls;
}
