/**
 * The Cellucid relay as an OAuth 2.1 authorization server whose consent is
 * the person's Cellucid tab (`relay/oauth.js`, `relay/clients.js`,
 * `relay/approval.js`, `relay/pairing.js`), exercised through the Worker's
 * fetch handler with real Requests on an in-memory Workers runtime.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import worker, { RelayApproval, RelayPairing } from '../relay/worker.js';
import { CLIENT_DOCUMENT_MAX_BYTES, CLIENT_DOCUMENT_WAIT_MS } from '../relay/clients.js';
import { APPROVAL_SECONDS, AUTHORIZATION_CODE_SECONDS } from '../relay/approval.js';
import { ACCESS_TOKEN_SECONDS } from '../relay/oauth.js';
import { installWorkersRuntime, relayEnvironment } from './helpers/relay-runtime.mjs';
import {
  APP_ORIGIN,
  CLAUDE_REDIRECT,
  RELAY,
  RESOURCE,
  authorizeUrl,
  connectAgent,
  connectTab,
  exchange,
  mcp,
  pkce,
  register,
  send,
  serveTab,
  startAuthorization,
  claimCode,
  tabRequest,
  tabSecret,
  waitAnswer,
} from './helpers/relay-flow.mjs';

let uninstall;
before(() => { uninstall = installWorkersRuntime(); });
after(() => uninstall());

const freshEnv = (overrides = {}) => relayEnvironment({ RelayPairing, RelayApproval }, overrides);

/** Answer the relay's client-document fetches from `documents` (url → {status, type, body, headers}). */
function stubFetch(t, documents) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    const answer = documents[url];
    if (answer === undefined) throw new TypeError(`unexpected fetch ${url}`);
    if (typeof answer === 'function') return answer(init);
    return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'Content-Type': answer.type ?? 'application/json', ...(answer.headers ?? {}) },
    });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const CLAUDE_CODE_DOCUMENT = 'https://claude.ai/oauth/claude-code-client-metadata';
const CHATGPT_DOCUMENT = 'https://chatgpt.com/oauth/client.json';
const claudeCode = {
  client_id: CLAUDE_CODE_DOCUMENT,
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};
const chatgpt = {
  client_id: CHATGPT_DOCUMENT,
  client_uri: 'https://chatgpt.com/',
  redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
  token_endpoint_auth_method: 'private_key_jwt',
  token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  client_name: 'ChatGPT',
  jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
};

test('discovery: protected-resource metadata at the root well-known address and authorization-server metadata, readable from any page', async () => {
  const env = freshEnv();
  {
    const response = await send(worker, env, '/.well-known/oauth-protected-resource');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.deepEqual(await response.json(), {
      resource: RESOURCE,
      authorization_servers: [RELAY],
      scopes_supported: ['cellucid'],
      bearer_methods_supported: ['header'],
      resource_name: 'Cellucid',
      resource_documentation: 'https://docs.cellucid.com/',
    });
  }
  const as = await (await send(worker, env, '/.well-known/oauth-authorization-server')).json();
  assert.equal(as.issuer, RELAY);
  assert.equal(as.authorization_endpoint, `${RELAY}/oauth/authorize`);
  assert.equal(as.token_endpoint, `${RELAY}/oauth/token`);
  assert.equal(as.registration_endpoint, `${RELAY}/oauth/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  // Claude picks a client metadata document only with both of these.
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
  // ChatGPT uses its stable redirect and client document only with RFC 9207.
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.ok(!as.scopes_supported.includes('offline_access'));

  const preflight = await send(worker, env, '/oauth/token', { method: 'OPTIONS', headers: { Origin: 'https://inspector.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await send(worker, env, '/.well-known/openid-configuration')).status, 404);
  // The MCP endpoint is the root: there is no path-suffixed metadata and no `/mcp`.
  assert.equal((await send(worker, env, '/.well-known/oauth-protected-resource/mcp')).status, 404);
  assert.equal((await send(worker, env, '/mcp', { method: 'POST' })).status, 404);
  assert.equal((await send(worker, env, '/.well-known/oauth-protected-resource', { method: 'POST' })).status, 405);
});

test('health names the contract and the endpoints; a missing or weak secret or a loose origin list answers 500', async () => {
  const env = freshEnv();
  const health = await (await send(worker, env, '/health')).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.contractVersion, 2);
  assert.equal(health.mcp, RESOURCE);
  assert.match(health.catalog, /^sha256-[0-9a-f]{64}$/);
  assert.ok(health.endpoints.includes('/') && health.endpoints.includes('/tab') && !health.endpoints.includes('/mcp'));

  for (const overrides of [
    { RELAY_SIGNING_KEY: undefined },
    { RELAY_SIGNING_KEY: 'short' },
    { ALLOWED_ORIGINS: '*' },
    { ALLOWED_ORIGINS: 'http://evil.example' },
    { ALLOWED_ORIGINS: 'https://www.cellucid.com/' },
    { ALLOWED_ORIGINS: 'https://www.cellucid.com,https://www.cellucid.com' },
    { PAIRING: undefined },
  ]) {
    const response = await send(worker, freshEnv(overrides), '/health');
    assert.equal(response.status, 500, JSON.stringify(overrides));
    assert.match((await response.json()).error, /RELAY_SIGNING_KEY|ALLOWED_ORIGINS|binding/);
  }
  const plain = await worker.fetch(new Request('http://relay.test/health'), env);
  assert.equal(plain.status, 400);
  assert.equal((await worker.fetch(new Request('http://localhost:8787/health'), env)).status, 200);
  // The root is the MCP endpoint: a person who opens the connector address is told what it is.
  const opened = await send(worker, env, '/');
  assert.equal(opened.status, 405);
  assert.equal(opened.headers.get('Allow'), 'POST');
  assert.match((await opened.json()).error.message, /connector address.*\/health/);
  const unknown = await send(worker, env, '/nothing-here');
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'No route /nothing-here' });
});

test('dynamic client registration signs the redirect URIs into the client id and refuses what is not a redirect URI', async () => {
  const env = freshEnv();
  const response = await send(worker, env, '/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CLAUDE_REDIRECT], client_name: 'Claude‮ evil\nname', token_endpoint_auth_method: 'client_secret_basic', grant_types: ['authorization_code', 'refresh_token'] }),
  });
  assert.equal(response.status, 201);
  const registered = await response.json();
  assert.match(registered.client_id, /^cd1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(registered.redirect_uris, [CLAUDE_REDIRECT]);
  assert.equal(registered.token_endpoint_auth_method, 'none');
  assert.equal(registered.client_name, 'Claude evil name');
  assert.equal(Object.hasOwn(registered, 'client_secret'), false);

  for (const [body, error] of [
    [{ redirect_uris: ['http://evil.example/cb'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: ['cursor://callback'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: ['https://claude.ai/cb#x'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: ['https://user:pw@claude.ai/cb'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: [] }, 'invalid_redirect_uri'],
    [{ client_name: 'x' }, 'invalid_redirect_uri'],
    [{ redirect_uris: [CLAUDE_REDIRECT], response_types: ['token'] }, 'invalid_client_metadata'],
    [{ redirect_uris: [CLAUDE_REDIRECT], grant_types: ['client_credentials'] }, 'invalid_client_metadata'],
    [{ redirect_uris: Array.from({ length: 200 }, (_, index) => `https://claude.ai/${'x'.repeat(40)}/${index}`) }, 'invalid_client_metadata'],
    [[CLAUDE_REDIRECT], 'invalid_client_metadata'],
  ]) {
    const refused = await send(worker, env, '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal((await refused.json()).error, error);
  }
  assert.equal((await send(worker, env, '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 400);
  assert.equal((await send(worker, env, '/oauth/register')).status, 405);
  const huge = await send(worker, env, '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(70 * 1024) });
  assert.equal(huge.status, 413);

  // A client id this relay did not sign is not a client.
  const { challenge } = await pkce();
  const forged = registered.client_id.replace(/\.[^.]+$/, '.AAAA');
  const page = await send(worker, env, authorizeUrl({ clientId: forged, challenge }));
  assert.equal(page.status, 400);
  assert.match(await page.text(), /does not know the app asking/);
  assert.equal(page.headers.get('Location'), null);
});

test('client metadata documents: Claude Code and ChatGPT are fetched with no redirect followed and shown by their host', async t => {
  const env = freshEnv();
  const calls = stubFetch(t, { [CLAUDE_CODE_DOCUMENT]: { body: claudeCode }, [CHATGPT_DOCUMENT]: { body: chatgpt, type: 'application/json; charset=utf-8' } });
  const { challenge } = await pkce();
  // Claude Code listens on a port it picks: the loopback URI matches on any port.
  const started = await startAuthorization(worker, env, { clientId: CLAUDE_CODE_DOCUMENT, redirectUri: 'http://localhost:53682/callback', challenge });
  assert.equal(started.response.status, 200, started.html);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.method, 'GET');
  assert.match(started.html, /Connect Claude to Cellucid/);
  assert.match(started.html, /runs on this computer/);
  assert.match(started.html, new RegExp(`href="${APP_ORIGIN}/#cellucid_connect=${started.code.slice(0, 4)}-${started.code.slice(4)}"`));
  assert.match(started.response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(started.response.headers.get('Content-Security-Policy'), /script-src 'self'/);

  const tab = await connectTab(worker, env);
  const claimed = await claimCode(worker, env, { code: started.code, cookie: started.cookie });
  assert.deepEqual(claimed.value.client, {
    agent: 'Claude', name: 'Claude Code', host: 'claude.ai', redirectHost: 'localhost', loopback: true, known: true, registration: 'document',
  });

  // ChatGPT declares private_key_jwt and none; the relay's metadata offers none, so it is a public client here.
  const chat = await startAuthorization(worker, env, { clientId: CHATGPT_DOCUMENT, redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect', challenge });
  assert.equal(chat.response.status, 200, chat.html);
  const chatClaim = await claimCode(worker, env, { code: chat.code, cookie: chat.cookie });
  assert.equal(chatClaim.value.client.agent, 'ChatGPT');
  assert.equal(chatClaim.value.client.loopback, false);

  // A loopback URI matches only its own host, and a registered path exactly.
  for (const redirectUri of ['http://127.0.0.2:5000/callback', 'http://localhost:5000/other', 'https://localhost/callback']) {
    const refused = await startAuthorization(worker, env, { clientId: CLAUDE_CODE_DOCUMENT, redirectUri, challenge });
    assert.equal(refused.response.status, 400, redirectUri);
    assert.equal(refused.response.headers.get('Location'), null);
  }
});

test('client metadata documents at hostile addresses are refused without a request, and hostile answers without being read', async t => {
  const env = freshEnv();
  const { challenge } = await pkce();
  const big = JSON.stringify({ ...claudeCode, client_id: 'https://big.example.com/c', padding: 'x'.repeat(CLIENT_DOCUMENT_MAX_BYTES) });
  const calls = stubFetch(t, {
    'https://moved.example.com/c': { status: 302, headers: { Location: 'http://169.254.169.254/' }, body: '' },
    'https://gone.example.com/c': { status: 404, body: '{}' },
    'https://html.example.com/c': { type: 'text/html', body: '<html>' },
    'https://big.example.com/c': () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'application/json' } }),
    'https://other.example.com/c': { body: { ...claudeCode, client_id: 'https://claude.ai/oauth/claude-code-client-metadata' } },
    'https://secret.example.com/c': { body: { ...claudeCode, client_id: 'https://secret.example.com/c', client_secret: 's' } },
    'https://shared.example.com/c': { body: { ...claudeCode, client_id: 'https://shared.example.com/c', token_endpoint_auth_method: 'client_secret_post' } },
    'https://noredirects.example.com/c': { body: { ...claudeCode, client_id: 'https://noredirects.example.com/c', redirect_uris: [] } },
    'https://notjson.example.com/c': { body: '{not json' },
  });
  const refusedWithoutFetch = [
    'http://claude.ai/oauth/x',
    'https://127.0.0.1/c',
    'https://[::1]/c',
    'https://2130706433/c',
    'https://localhost/c',
    'https://metadata.internal/c',
    'https://router.local/c',
    'https://claude.ai:8443/c',
    'https://claude.ai/c?x=1',
    'https://claude.ai/',
    'https://claude.ai/a/../c',
    'https://user@claude.ai/c',
    'https://CLAUDE.ai/c',
    'https://intranet/c',
  ];
  for (const clientId of refusedWithoutFetch) {
    const before = calls.length;
    const page = await send(worker, env, authorizeUrl({ clientId, redirectUri: 'http://localhost/callback', challenge }));
    assert.equal(page.status, 400, clientId);
    assert.match(await page.text(), /cannot be identified/, clientId);
    assert.equal(calls.length, before, `${clientId} must not be fetched`);
  }
  for (const [clientId, words] of [
    ['https://moved.example.com/c', /redirects elsewhere/],
    ['https://gone.example.com/c', /answered HTTP 404/],
    ['https://html.example.com/c', /is not JSON/],
    ['https://big.example.com/c', new RegExp(`larger than ${CLIENT_DOCUMENT_MAX_BYTES} bytes`)],
    ['https://other.example.com/c', /names another client_id/],
    ['https://secret.example.com/c', /client secret/],
    ['https://shared.example.com/c', /shared secret/],
    ['https://noredirects.example.com/c', /lists no redirect_uris/],
    ['https://notjson.example.com/c', /is not a JSON object/],
  ]) {
    const page = await send(worker, env, authorizeUrl({ clientId, redirectUri: 'http://localhost/callback', challenge }));
    assert.equal(page.status, 400, clientId);
    assert.match(await page.text(), words, clientId);
  }
});

test('a client document that does not arrive in time is refused', async t => {
  const env = freshEnv();
  const { challenge } = await pkce();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let asked = false;
  stubFetch(t, {
    'https://slow.example.com/c': init => new Promise((resolve, reject) => {
      asked = true;
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
  });
  const pending = send(worker, env, authorizeUrl({ clientId: 'https://slow.example.com/c', redirectUri: 'http://localhost/callback', challenge }));
  // Its wait starts as it asks for the document, after work on crypto's threads.
  while (!asked) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(CLIENT_DOCUMENT_WAIT_MS);
  const page = await pending;
  assert.equal(page.status, 400);
  assert.match(await page.text(), /did not answer within 5 seconds/);
});

test('authorization requests: a bad client or redirect URI gets a page; a bad request with a good redirect URI gets the error, state and iss', async () => {
  const env = freshEnv();
  const clientId = await register(worker, env);
  const { challenge } = await pkce();
  const unregistered = await send(worker, env, authorizeUrl({ clientId, redirectUri: 'https://evil.example/cb', challenge }));
  assert.equal(unregistered.status, 400);
  assert.equal(unregistered.headers.get('Location'), null);
  assert.match(await unregistered.text(), /did not register/);

  const repeated = await send(worker, env, `${authorizeUrl({ clientId, challenge })}&state=again`);
  assert.equal(repeated.status, 400);
  assert.match(await repeated.text(), /given more than once/);

  const cases = [
    [{ method: 'plain' }, 'invalid_request', /S256/],
    [{ method: null }, 'invalid_request', /S256/],
    [{ challenge: 'short' }, 'invalid_request', /code_challenge/],
    [{ responseType: 'token' }, 'unsupported_response_type', /response_type=code/],
    [{ resource: 'https://other.example' }, 'invalid_target', /only for https:\/\/relay\.test$/],
    [{ resource: `${RELAY}?x=1` }, 'invalid_target', /only for/],
    // The retired `/mcp` path names another resource.
    [{ resource: `${RELAY}/mcp` }, 'invalid_target', /only for https:\/\/relay\.test$/],
  ];
  for (const [change, error, words] of cases) {
    const response = await send(worker, env, authorizeUrl({ clientId, challenge, ...change }));
    assert.equal(response.status, 302, JSON.stringify(change));
    const location = new URL(response.headers.get('Location'));
    assert.equal(`${location.origin}${location.pathname}`, CLAUDE_REDIRECT);
    assert.equal(location.searchParams.get('error'), error);
    assert.match(location.searchParams.get('error_description'), words);
    assert.equal(location.searchParams.get('state'), 'state-1');
    assert.equal(location.searchParams.get('iss'), RELAY);
  }
  // The resource may be omitted (this relay has one) and written with an upper-case host or a trailing slash.
  for (const resource of [null, 'https://RELAY.test/', `${RELAY}/`, RELAY]) {
    const started = await startAuthorization(worker, env, { clientId, challenge, resource });
    assert.equal(started.response.status, 200, String(resource));
  }
});

test('a bad request from an app the relay cannot vouch for is answered by a page with a link, never a redirect (no open redirect, RFC 9700 4.11.2)', async () => {
  const env = freshEnv();
  // Anyone can register a client whose redirect URI is a site of their own.
  const target = 'https://phish.example/login';
  const clientId = await register(worker, env, { redirectUris: [target], name: 'Anything' });
  const { challenge } = await pkce();
  for (const change of [{ responseType: 'token' }, { method: 'plain' }, { challenge: 'short' }, { resource: 'https://other.example' }]) {
    const response = await send(worker, env, authorizeUrl({ clientId, redirectUri: target, challenge, ...change }), { redirect: 'manual' });
    assert.equal(response.status, 400, JSON.stringify(change));
    assert.equal(response.headers.get('Location'), null, JSON.stringify(change));
    assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
    const html = await response.text();
    const href = /<a href="([^"]+)" rel="noreferrer">Return to phish\.example<\/a>/.exec(html)?.[1];
    assert.ok(href, html);
    const link = new URL(href.replaceAll('&amp;', '&'));
    assert.equal(`${link.origin}${link.pathname}`, target);
    assert.equal(link.searchParams.get('state'), 'state-1');
    assert.equal(link.searchParams.get('iss'), RELAY);
    assert.ok(link.searchParams.get('error'));
  }
  // A page cannot carry markup into the link or the message.
  const hostile = await register(worker, env, { redirectUris: ['https://phish.example/"><script>x</script>'] });
  const escaped = await send(worker, env, authorizeUrl({ clientId: hostile, redirectUri: 'https://phish.example/"><script>x</script>', challenge, responseType: 'token' }));
  assert.equal(escaped.status, 400);
  assert.doesNotMatch(await escaped.text(), /<script>/);
});

test('authorize, approve in the tab, exchange with PKCE: the tokens are bound to the relay\'s resource and to the pairing', async () => {
  const env = freshEnv();
  const { tokens, redirect, tab, clientId } = await connectAgent(worker, env);
  assert.equal(redirect.searchParams.get('state'), 'state-1');
  assert.equal(redirect.searchParams.get('iss'), RELAY);
  assert.match(redirect.searchParams.get('code'), /^ac1\.[0-9A-Z]{8}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.expires_in, ACCESS_TOKEN_SECONDS);
  assert.equal(tokens.scope, 'cellucid');
  assert.match(tokens.access_token, /^at1\./);
  assert.match(tokens.refresh_token, /^rt1\./);
  const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString());
  assert.equal(payload.aud, RESOURCE);
  assert.equal(payload.iss, RELAY);
  assert.match(payload.sub, /^[0-9a-f]{64}$/);

  // The connection keeps the client id's digest, never the id (a registered one is up to 8 KiB of the registrant's text).
  const stored = [...env.PAIRING.object(payload.sub).ctx.storage.values.values()];
  assert.equal(stored.length, 1);
  assert.deepEqual(Object.keys(stored[0]).sort(), ['agent', 'clientDigest', 'clientHost', 'clientName', 'createdAt', 'expiresAt', 'generation', 'known', 'lastUsedAt', 'scope']);
  assert.match(stored[0].clientDigest, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(stored).includes(clientId.split('.')[1]));

  const initialize = await mcp(worker, env, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } } });
  assert.equal(initialize.status, 200);
  assert.equal((await initialize.json()).result.protocolVersion, '2025-06-18');

  // The tab hears that a connection was made, and lists it.
  const listed = await tabRequest(tab.socket, { type: 'connections' });
  assert.equal(listed.value.length, 1);
  assert.equal(listed.value[0].agent, 'Claude');
  assert.equal(listed.value[0].host, 'claude.ai');
  assert.ok(tab.socket.messages().some(message => message.type === 'event' && message.name === 'connections-changed'));
});

test('a wrong PKCE verifier is refused and uses the code up; a replayed code is refused', async () => {
  const env = freshEnv();
  const clientId = await register(worker, env);
  const { verifier, challenge } = await pkce();
  const started = await startAuthorization(worker, env, { clientId, challenge });
  const { socket } = await connectTab(worker, env);
  await claimCode(worker, env, { code: started.code, cookie: started.cookie });
  await tabRequest(socket, { type: 'decide', code: started.code, allow: true });
  const code = new URL((await waitAnswer(worker, env, started)).body.redirect).searchParams.get('code');
  const fields = { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CLAUDE_REDIRECT, code_verifier: 'w'.repeat(50) };
  const wrong = await exchange(worker, env, fields);
  assert.equal(wrong.status, 400);
  assert.deepEqual(await wrong.json(), { error: 'invalid_grant', error_description: 'The PKCE code_verifier does not match the code_challenge' });
  const after = await exchange(worker, env, { ...fields, code_verifier: verifier });
  assert.equal((await after.json()).error_description, 'The authorization code was used already');

  const second = await startAuthorization(worker, env, { clientId, challenge });
  await claimCode(worker, env, { code: second.code, cookie: second.cookie });
  await tabRequest(socket, { type: 'decide', code: second.code, allow: true });
  const secondCode = new URL((await waitAnswer(worker, env, second)).body.redirect).searchParams.get('code');
  const good = { ...fields, code: secondCode, code_verifier: verifier };
  assert.equal((await exchange(worker, env, good)).status, 200);
  const replay = await exchange(worker, env, good);
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, 'invalid_grant');

  // Another client, another redirect URI or a missing verifier are refused too.
  const third = await startAuthorization(worker, env, { clientId, challenge });
  await claimCode(worker, env, { code: third.code, cookie: third.cookie });
  await tabRequest(socket, { type: 'decide', code: third.code, allow: true });
  const thirdCode = new URL((await waitAnswer(worker, env, third)).body.redirect).searchParams.get('code');
  const other = await exchange(worker, env, { ...good, code: thirdCode, client_id: await register(worker, env, { redirectUris: ['https://elsewhere.example/cb'] }) });
  assert.equal((await other.json()).error_description, 'The authorization code was issued to another client');
  const missing = await exchange(worker, env, { grant_type: 'authorization_code', code: thirdCode, client_id: clientId, redirect_uri: CLAUDE_REDIRECT });
  assert.equal((await missing.json()).error, 'invalid_request');
  const forged = await exchange(worker, env, { ...good, code: 'ac1.ZZZZZZZZ.abc' });
  assert.equal((await forged.json()).error, 'invalid_grant');
});

test('codes expire: an unanswered request after ten minutes, an approved code after five', async t => {
  const env = freshEnv();
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 3, 12) });
  const clientId = await register(worker, env);
  const { verifier, challenge } = await pkce();
  const { socket } = await connectTab(worker, env);

  const late = await startAuthorization(worker, env, { clientId, challenge });
  t.mock.timers.tick(APPROVAL_SECONDS * 1000);
  const claim = await claimCode(worker, env, { code: late.code, cookie: late.cookie });
  assert.equal(claim.ok, false);
  assert.equal(claim.error.code, 'unknown');
  assert.deepEqual((await waitAnswer(worker, env, late)).body, { status: 'expired' });

  const slow = await startAuthorization(worker, env, { clientId, challenge });
  await claimCode(worker, env, { code: slow.code, cookie: slow.cookie });
  await tabRequest(socket, { type: 'decide', code: slow.code, allow: true });
  const code = new URL((await waitAnswer(worker, env, slow)).body.redirect).searchParams.get('code');
  t.mock.timers.tick(AUTHORIZATION_CODE_SECONDS * 1000);
  const expired = await exchange(worker, env, { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CLAUDE_REDIRECT, code_verifier: verifier });
  assert.equal(expired.status, 400);
  assert.equal((await expired.json()).error_description, 'The authorization code has expired');

  // The alarm deletes what the request kept.
  const object = env.APPROVAL.object(`approval:${slow.code}`);
  await object.instance.alarm();
  assert.equal(object.ctx.storage.values.size, 0);
});

test('the person declines in the tab or cancels on the page: the client gets access_denied with state and iss', async () => {
  const env = freshEnv();
  const clientId = await register(worker, env);
  const { challenge } = await pkce();
  const { socket } = await connectTab(worker, env);

  const declined = await startAuthorization(worker, env, { clientId, challenge });
  await claimCode(worker, env, { code: declined.code, cookie: declined.cookie });
  const waiting = waitAnswer(worker, env, { ...declined, seen: 'claimed' });
  await tabRequest(socket, { type: 'decide', code: declined.code, allow: false });
  const answer = (await waiting).body;
  assert.equal(answer.status, 'denied');
  const location = new URL(answer.redirect);
  assert.equal(location.searchParams.get('error'), 'access_denied');
  assert.equal(location.searchParams.get('state'), 'state-1');
  assert.equal(location.searchParams.get('iss'), RELAY);

  const cancelled = await startAuthorization(worker, env, { clientId, challenge });
  await claimCode(worker, env, { code: cancelled.code, cookie: cancelled.cookie });
  const cancelAnswer = await waitAnswer(worker, env, { ...cancelled, cancel: true });
  assert.equal(cancelAnswer.body.status, 'denied');
  const late = await tabRequest(socket, { type: 'decide', code: cancelled.code, allow: true });
  assert.equal(late.ok, false);
  assert.equal(late.error.code, 'decided');

  // Only the page that started the request may wait on it or cancel it.
  const other = await startAuthorization(worker, env, { clientId, challenge });
  const stranger = await waitAnswer(worker, env, { code: other.code, request: 'x'.repeat(43), cancel: true });
  assert.equal(stranger.status, 403);
  const crossOrigin = await send(worker, env, '/oauth/authorize/wait', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ code: other.code, request: other.request }),
  });
  assert.equal(crossOrigin.status, 403);
});

test('a code claimed by one browser cannot be decided by another, and an unclaimed code cannot be decided', async () => {
  const env = freshEnv();
  const clientId = await register(worker, env);
  const { challenge } = await pkce();
  const started = await startAuthorization(worker, env, { clientId, challenge });
  const mine = await connectTab(worker, env, { secret: tabSecret(1) });
  const theirs = await connectTab(worker, env, { secret: tabSecret(2) });
  const unclaimed = await tabRequest(theirs.socket, { type: 'decide', code: started.code, allow: true });
  assert.equal(unclaimed.error.code, 'not-claimed');
  assert.equal((await claimCode(worker, env, { code: started.code, secret: tabSecret(1), cookie: started.cookie })).ok, true);
  // A second pairing in the same browser (another profile's secret, the same cookie jar) comes too late.
  const elsewhere = await claimCode(worker, env, { code: started.code, secret: tabSecret(2), cookie: started.cookie });
  assert.equal(elsewhere.error.code, 'claimed-elsewhere');
  const hijack = await tabRequest(theirs.socket, { type: 'decide', code: started.code, allow: true });
  assert.equal(hijack.ok, false);
  const unknown = await claimCode(worker, env, { code: '00000000', cookie: started.cookie });
  assert.equal(unknown.error.code, 'unknown');
});

test('R9Z-1: a connect link or code started in another browser attaches nothing: the claim needs the approver cookie of the browser that shows the page', async () => {
  const env = freshEnv();
  const clientId = await register(worker, env);
  const { challenge } = await pkce();
  // The attacker's browser shows the waiting page; they send its link (or code) to the person.
  const attacker = await startAuthorization(worker, env, { clientId, challenge });
  assert.match(attacker.setCookie, /^__Host-cellucid-approver=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Strict$/);
  // The person's own browser holds an approver cookie of its own from an earlier connection.
  const earlier = await startAuthorization(worker, env, { clientId, challenge });
  const victim = await connectTab(worker, env, { secret: tabSecret(9) });
  serveTab(victim.socket, { handler: () => ({ result: { content: [{ type: 'text', text: 'the person\'s data' }], isError: false } }) });
  for (const cookie of [null, earlier.cookie, `${attacker.cookie.split('=')[0]}=${'A'.repeat(43)}`, 'unrelated=1']) {
    const claimed = await claimCode(worker, env, { code: attacker.code, secret: tabSecret(9), cookie });
    assert.equal(claimed.status, 200, String(cookie));
    assert.equal(claimed.ok, false, String(cookie));
    assert.equal(claimed.error.code, 'other-browser');
    assert.match(claimed.error.message, /started in another browser/);
  }
  // A claim never made, the decision is refused, and the attacker's page has nothing to send on.
  const decided = await tabRequest(victim.socket, { type: 'decide', code: attacker.code, allow: true });
  assert.equal(decided.error.code, 'not-claimed');
  assert.deepEqual((await waitAnswer(worker, env, { ...attacker, seen: null })).body, { status: 'waiting' });
  // The old way (a claim on the socket) is gone: it is not answered and binds nothing.
  victim.socket.send(JSON.stringify({ type: 'claim', ref: 999, code: attacker.code }));
  await victim.socket.settle();
  assert.equal(victim.socket.messages().some(message => message.type === 'reply' && message.ref === 999), false);
  assert.equal((await tabRequest(victim.socket, { type: 'decide', code: attacker.code, allow: true })).error.code, 'not-claimed');
  // The attacker's own browser can still approve it, into the attacker's own pairing only.
  const own = await claimCode(worker, env, { code: attacker.code, secret: tabSecret(3), cookie: attacker.cookie });
  assert.equal(own.ok, true);
});

test('the approver cookie: kept across a browser\'s authorizations, replaced when malformed, never sent without a Cellucid page\'s origin', async () => {
  const env = freshEnv();
  const clientId = await register(worker, env);
  const { challenge } = await pkce();
  const first = await startAuthorization(worker, env, { clientId, challenge });
  const second = await startAuthorization(worker, env, { clientId, challenge, cookie: first.cookie });
  assert.equal(second.cookie, first.cookie, 'two pages waiting in one browser share its cookie');
  assert.notEqual(second.code, first.code);
  for (const started of [first, second]) {
    assert.equal((await claimCode(worker, env, { code: started.code, cookie: first.cookie })).ok, true);
  }
  const malformed = await startAuthorization(worker, env, { clientId, challenge, cookie: '__Host-cellucid-approver=short' });
  assert.notEqual(malformed.cookie, '__Host-cellucid-approver=short');
  assert.match(malformed.cookie, /^__Host-cellucid-approver=[A-Za-z0-9_-]{43}$/);
  // The cookie is the relay host's own: no Domain (the __Host- prefix forbids one), the whole path.
  assert.doesNotMatch(malformed.setCookie, /Domain=/i);

  // Only a Cellucid page (an allowed Origin) claims; its preflight and answer allow its credentials, for its origin alone.
  const third = await startAuthorization(worker, env, { clientId, challenge });
  assert.equal((await claimCode(worker, env, { code: third.code, cookie: third.cookie, origin: null })).status, 403);
  assert.equal((await claimCode(worker, env, { code: third.code, cookie: third.cookie, origin: 'https://evil.example' })).status, 403);
  const preflight = await send(worker, env, '/oauth/claim', {
    method: 'OPTIONS', headers: { Origin: APP_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), APP_ORIGIN);
  assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), 'true');
  const claimed = await claimCode(worker, env, { code: third.code, cookie: third.cookie });
  assert.equal(claimed.response.headers.get('Access-Control-Allow-Origin'), APP_ORIGIN);
  assert.equal(claimed.response.headers.get('Access-Control-Allow-Credentials'), 'true');
  assert.equal(claimed.response.headers.get('Vary'), 'Origin');
  // A malformed claim says why, with the same headers.
  for (const body of [{ code: 'nope', secret: tabSecret(1) }, { code: third.code, secret: 'short' }]) {
    const answer = await send(worker, env, '/oauth/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN, Cookie: third.cookie }, body: JSON.stringify(body),
    });
    assert.equal(answer.status, 400);
    assert.equal(answer.headers.get('Access-Control-Allow-Origin'), APP_ORIGIN);
  }
});

test('a local relay (http://127.0.0.1) sets the same __Host- cookie, which loopback browsers keep (localhost counts as secure)', async () => {
  const env = freshEnv({ ALLOWED_ORIGINS: 'http://127.0.0.1:5000' });
  const local = 'http://127.0.0.1:8797';
  const registered = await worker.fetch(new Request(`${local}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CLAUDE_REDIRECT], client_name: 'Claude' }),
  }), env);
  const clientId = (await registered.json()).client_id;
  const { challenge } = await pkce();
  const url = new URL(authorizeUrl({ clientId, challenge, resource: local }).replace(RELAY, local));
  const page = await worker.fetch(new Request(url.href), env);
  assert.equal(page.status, 200);
  const cookie = page.headers.get('Set-Cookie');
  assert.match(cookie, /^__Host-cellucid-approver=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Strict$/);
  const code = /data-code="([^"]+)"/.exec(await page.text())[1];
  const claimed = await worker.fetch(new Request(`${local}/oauth/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5000', Cookie: cookie.split(';')[0] },
    body: JSON.stringify({ code, secret: tabSecret(1) }),
  }), env);
  assert.equal(claimed.status, 200);
});

test('F122: an app the relay cannot vouch for that calls itself "Claude" is named by its host on the page, in the approval, the connections and its calls', async () => {
  const env = freshEnv();
  const fake = await register(worker, env, { redirectUris: ['https://evil.example/callback'], name: 'Claude' });
  const { challenge } = await pkce();
  const started = await startAuthorization(worker, env, { clientId: fake, redirectUri: 'https://evil.example/callback', challenge });
  assert.match(started.html, /<h1>Connect evil\.example to Cellucid<\/h1>/);
  assert.match(started.html, /evil\.example, which calls itself <q>Claude<\/q>, asks to work/);
  assert.doesNotMatch(started.html, /Connect Claude/);
  const tab = await connectTab(worker, env);
  const claimed = await claimCode(worker, env, { code: started.code, cookie: started.cookie });
  assert.deepEqual(claimed.value.client, {
    agent: 'evil.example', name: 'Claude', host: 'evil.example', redirectHost: 'evil.example', loopback: false, known: false, registration: 'registered',
  });
  // An app on this computer (a loopback redirect, no client document) that calls itself "Claude Code".
  const local = await register(worker, env, { redirectUris: ['http://127.0.0.1/callback'], name: 'Claude Code' });
  const localStarted = await startAuthorization(worker, env, { clientId: local, redirectUri: 'http://127.0.0.1:4545/callback', challenge });
  assert.match(localStarted.html, /<h1>Connect an app on this computer to Cellucid<\/h1>/);
  assert.match(localStarted.html, /An app on this computer, which calls itself <q>Claude Code<\/q>, asks/);
  assert.equal((await claimCode(worker, env, { code: localStarted.code, cookie: localStarted.cookie })).value.client.agent, 'An app on this computer');

  const { tokens } = await connectAgent(worker, env, { clientId: fake, redirectUri: 'https://evil.example/callback', tab });
  const listed = await tabRequest(tab.socket, { type: 'connections' });
  const row = listed.value.find(each => each.agent === 'evil.example');
  assert.deepEqual({ agent: row.agent, client: row.client, host: row.host, known: row.known }, { agent: 'evil.example', client: 'Claude', host: 'evil.example', known: false });
  // Its calls reach the tab as evil.example's (the history records them so); its own name goes as unvouched (`known` false), which the tab only quotes.
  const calls = serveTab(tab.socket, { handler: () => ({ result: { content: [{ type: 'text', text: '{}' }], isError: false } }) });
  await mcp(worker, env, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fields_list', arguments: {} } });
  assert.deepEqual({ agent: calls[0].agent, client: calls[0].client, host: calls[0].host, known: calls[0].known },
    { agent: 'evil.example', client: 'Claude', host: 'evil.example', known: false });
});

test('a tab names an approval only by a connect code: any other text is refused before an approval object is asked', async () => {
  const env = freshEnv();
  const { socket } = await connectTab(worker, env);
  const before = env.APPROVAL.objects.size;
  for (const code of ['', 'abcd-efgh', 'ABCD-EFGH', '0000000', '000000000', 'UUUUUUUU', 'x'.repeat(100_000), 7, null]) {
    const decided = await tabRequest(socket, { type: 'decide', code, allow: true });
    assert.equal(decided.ok, false, `decide ${String(code).slice(0, 12)}`);
    assert.equal(decided.error.code, 'not-a-code');
    const claimed = await claimCode(worker, env, { code });
    assert.equal(claimed.ok, false, `claim ${String(code).slice(0, 12)}`);
    // A body past the OAuth bound is refused before it is read.
    assert.equal(claimed.error.code, typeof code === 'string' && code.length > 64 * 1024 ? 'malformed' : 'not-a-code');
  }
  assert.equal(env.APPROVAL.objects.size, before);
});

test('refresh tokens rotate: each works once, and a reused one closes the connection', async () => {
  const env = freshEnv();
  const { tokens, clientId, tab } = await connectAgent(worker, env);
  serveTab(tab.socket, { tools: [] });
  const refresh = fields => exchange(worker, env, { grant_type: 'refresh_token', client_id: clientId, ...fields });
  const first = await refresh({ refresh_token: tokens.refresh_token, resource: RESOURCE });
  assert.equal(first.status, 200);
  const rotated = await first.json();
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  assert.equal((await mcp(worker, env, rotated.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 200);

  const second = await refresh({ refresh_token: rotated.refresh_token });
  assert.equal(second.status, 200);
  const latest = await second.json();

  // The first refresh token again: theft is assumed and the connection ends.
  const reused = await refresh({ refresh_token: tokens.refresh_token });
  assert.equal(reused.status, 400);
  assert.equal((await reused.json()).error, 'invalid_grant');
  const after = await refresh({ refresh_token: latest.refresh_token });
  assert.equal(after.status, 400);
  const revoked = await mcp(worker, env, latest.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(revoked.status, 401);
  assert.match(revoked.headers.get('WWW-Authenticate'), /error="invalid_token"/);

  // A refresh by another client is refused.
  const thirdConnection = await connectAgent(worker, env, { secret: tabSecret(5) });
  const otherClient = await register(worker, env, { redirectUris: ['https://elsewhere.example/cb'] });
  const stolen = await exchange(worker, env, { grant_type: 'refresh_token', client_id: otherClient, refresh_token: thirdConnection.tokens.refresh_token });
  assert.equal(stolen.status, 400);
  assert.equal((await stolen.json()).error_description, 'This refresh token was issued to another client.');
  const own = await exchange(worker, env, { grant_type: 'refresh_token', client_id: thirdConnection.clientId, refresh_token: thirdConnection.tokens.refresh_token });
  assert.equal(own.status, 200);

  const garbage = await refresh({ refresh_token: 'rt1.e30.AAAA' });
  assert.equal((await garbage.json()).error, 'invalid_grant');
  const unsupported = await exchange(worker, env, { grant_type: 'client_credentials' });
  assert.equal((await unsupported.json()).error, 'unsupported_grant_type');
  const form = await send(worker, env, '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await form.json()).error, 'invalid_request');
});

test('audience: a token is accepted only at the resource it was issued for, and a request may not name another one', async () => {
  const env = freshEnv();
  const { tokens, clientId } = await connectAgent(worker, env);
  const elsewhere = await worker.fetch(new Request('https://relay-two.test/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  }), env);
  assert.equal(elsewhere.status, 401);
  assert.match(elsewhere.headers.get('WWW-Authenticate'), /resource_metadata="https:\/\/relay-two\.test\/\.well-known\/oauth-protected-resource"/);
  const refreshElsewhere = await worker.fetch(new Request('https://relay-two.test/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }).toString(),
  }), env);
  assert.equal(refreshElsewhere.status, 400);
  const wrongTarget = await exchange(worker, env, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId, resource: 'https://other.example' });
  assert.equal((await wrongTarget.json()).error, 'invalid_target');

  // A token signed with another relay's key is not one of this relay's.
  const otherEnv = freshEnv({ RELAY_SIGNING_KEY: 'z'.repeat(52) });
  const foreign = await mcp(worker, otherEnv, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(foreign.status, 401);
});

test('the MCP endpoint (the root) asks for a token with a 401 that points to the metadata, refuses one in the address, and refuses an expired one', async t => {
  const env = freshEnv();
  const missing = await mcp(worker, env, null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('WWW-Authenticate'), `Bearer resource_metadata="${RELAY}/.well-known/oauth-protected-resource", scope="cellucid"`);
  const garbage = await mcp(worker, env, 'not-a-token', { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(garbage.status, 401);
  assert.match(garbage.headers.get('WWW-Authenticate'), /^Bearer error="invalid_token"/);

  const { tokens } = await connectAgent(worker, env);
  const inAddress = await send(worker, env, `/?access_token=${tokens.access_token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(inAddress.status, 400);
  assert.equal((await inAddress.json()).error, 'invalid_request');

  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + (ACCESS_TOKEN_SECONDS + 1) * 1000 });
  const expired = await mcp(worker, env, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get('WWW-Authenticate'), /has expired/);
});

test('the tab removes one connection or forgets the pairing: tokens stop working and every tab is told', async () => {
  const env = freshEnv();
  const first = await connectAgent(worker, env);
  const second = await connectAgent(worker, env, { tab: first.tab });
  serveTab(first.tab.socket, { tools: [] });
  const list = await tabRequest(first.tab.socket, { type: 'connections' });
  assert.equal(list.value.length, 2);
  const removed = await tabRequest(first.tab.socket, { type: 'disconnect', grant: list.value[1].grant });
  assert.equal(removed.value.removed, true);
  const statuses = [first, second].map(async ({ tokens }) => (await mcp(worker, env, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status);
  assert.deepEqual((await Promise.all(statuses)).sort(), [200, 401]);

  const sibling = await connectTab(worker, env);
  const forgotten = await tabRequest(first.tab.socket, { type: 'forget' });
  assert.equal(forgotten.value.forgotten, true);
  assert.deepEqual(first.tab.socket.closeEvent, { code: 4001, reason: 'forgotten' });
  assert.deepEqual(sibling.socket.closeEvent, { code: 4001, reason: 'forgotten' });
  for (const { tokens } of [first, second]) {
    assert.equal((await mcp(worker, env, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  }
});
