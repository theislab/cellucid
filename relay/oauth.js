/**
 * The relay as its own OAuth 2.1 authorization server, and the check of the
 * tokens it issued.
 *
 * - Discovery: protected-resource metadata (RFC 9728) for the MCP endpoint
 *   (the relay's root, `/`), at the root well-known address; authorization-server
 *   metadata (RFC 8414): PKCE S256 only, public clients (`none`), Client ID
 *   Metadata Documents and Dynamic Client Registration, `iss` in every
 *   authorization response (RFC 9207).
 * - `/oauth/register`: Dynamic Client Registration (`clients.js`).
 * - `/oauth/authorize`: checks the client and its redirect URI (on failure a
 *   page, never a redirect to an unchecked address), then PKCE, response
 *   type and resource (on failure the error, `state` and `iss` at the
 *   redirect URI: at once for claude.ai and chatgpt.com, by a link the
 *   person follows for any other app), then keeps the request under a new connect code
 *   (`approval.js`) and shows the waiting page (`authorize-page.js`).
 * - `/oauth/claim`: a Cellucid page of this browser claims a connect code,
 *   credentialed by the approver cookie the waiting page set
 *   (`approval.js` `APPROVER_COOKIE`): only the browser that shows the
 *   page can claim it.
 * - `/oauth/token`: `authorization_code` (once, with the PKCE verifier,
 *   the same client, redirect URI and resource) and `refresh_token`
 *   (rotating: each refresh token works once). Tokens are bound to the
 *   relay's resource, its origin (RFC 8707), and to the pairing that approved.
 * - `authenticate`: what the MCP endpoint accepts: a bearer access token in
 *   the Authorization header, signed by this relay, unexpired, issued by it
 *   and for its resource; never one in the address.
 */

import { RELAY_BUNDLE } from './generated/bundle.js';
import { approvalPage, failurePage } from './authorize-page.js';
import { clientDisplay, registerClient, resolveClient } from './clients.js';
import { randomBase64Url, sha256Base64Url, textOf } from './encoding.js';
import {
  RelayHttpError, cookieOf, credentialedCorsHeaders, emptyResponse, isJson, jsonResponse, publicCorsHeaders, readBody,
} from './http.js';
import { pairingIdOf, seal, unseal } from './keys.js';
import { APPROVAL_SECONDS, APPROVER_COOKIE, APPROVER_VALUE, isConnectCode } from './approval.js';
import { PAIRING_HEADER } from './pairing.js';
import { redirectMatches, redirectUriProblem } from './redirect-uris.js';

/** The one scope: operate the Cellucid tab this connection was approved from. */
export const SCOPE = 'cellucid';
/** An access token lasts an hour; Claude renews one before it ends. */
export const ACCESS_TOKEN_SECONDS = 60 * 60;
/**
 * The largest OAuth registration or token request body read: a handful of
 * fields (a client id of at most 8 KiB, a code, a verifier, a redirect URI);
 * anything far larger is not one.
 */
export const OAUTH_BODY_MAX_BYTES = 64 * 1024;
/** Tries at a fresh connect code when a random one is in use (40 bits: a clash is rare already). */
const CODE_ATTEMPTS = 8;

const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const TAB_SECRET = new RegExp(RELAY_BUNDLE.protocol.tabSecretPattern);
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export function protectedResourceMetadata(site) {
  return {
    resource: site.resource,
    authorization_servers: [site.issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Cellucid',
    resource_documentation: 'https://docs.cellucid.com/',
  };
}

export function authorizationServerMetadata(site) {
  return {
    issuer: site.issuer,
    authorization_endpoint: `${site.origin}/oauth/authorize`,
    token_endpoint: `${site.origin}/oauth/token`,
    registration_endpoint: `${site.origin}/oauth/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: 'https://docs.cellucid.com/',
  };
}

/**
 * `value` when it names this relay's resource, its origin (scheme and host in
 * any case, with or without the trailing slash: MCP clients send the canonical
 * form without it, RFC 3986 normalizes to it), else null. Any other path,
 * including the retired `/mcp`, names another resource.
 */
export function resourceOf(value, site) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (value.includes('#') || url.search !== '' || url.username !== '' || url.password !== '') return null;
  return url.pathname === '/' && url.origin === site.resource ? site.resource : null;
}

function oauthError(status, error, description, headers = undefined) {
  return new RelayHttpError(status, description, { body: { error, error_description: description }, headers });
}

/** Each parameter once (RFC 6749 §3.1): a repeated one is refused. */
function singleParams(params, refuse) {
  const out = new Map();
  for (const [name, value] of params) {
    if (out.has(name)) throw refuse(`${name} is given more than once`);
    out.set(name, value);
  }
  return out;
}

// ---- registration --------------------------------------------------------------

export async function handleRegister(request, keys) {
  if (request.method !== 'POST') throw new RelayHttpError(405, 'Register with POST', { headers: { Allow: 'POST' } });
  if (!isJson(request)) throw oauthError(400, 'invalid_client_metadata', 'A registration is JSON (Content-Type: application/json)');
  const text = textOf(await readBody(request, OAUTH_BODY_MAX_BYTES));
  let metadata;
  try {
    metadata = text === null ? null : JSON.parse(text);
  } catch {
    metadata = null;
  }
  const registered = await registerClient(metadata, keys, Math.floor(Date.now() / 1000));
  return jsonResponse(registered, 201, publicCorsHeaders());
}

// ---- authorization --------------------------------------------------------------

function newConnectCode() {
  const { alphabet, length } = RELAY_BUNDLE.protocol.connectCode;
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  // 32 symbols: the low five bits of a random byte pick one uniformly.
  return Array.from(bytes, byte => alphabet[byte & 31]).join('');
}

function approvalStub(env, code) {
  return env.APPROVAL.get(env.APPROVAL.idFromName(`approval:${code}`));
}

async function askObject(stub, path, body) {
  const response = await stub.fetch(`https://relay.internal${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/**
 * The answer to an authorization request that is wrong after its client and
 * redirect URI were checked: the error, `state` and `iss` at the redirect URI.
 * The relay sends the browser there by itself only for an app it vouches
 * for (`display.known`: claude.ai or chatgpt.com). Anyone can register a
 * client with a redirect URI of their own, so redirecting every client's
 * malformed request at once would make the relay's address an open
 * redirect to any site (RFC 9700 §4.11.2); for such a client the person
 * sees the error and a link to take it back.
 */
function errorAnswer(redirectUri, display, state, issuer, error, description) {
  const url = new URL(redirectUri);
  url.searchParams.append('error', error);
  url.searchParams.append('error_description', description);
  if (state !== null) url.searchParams.append('state', state);
  url.searchParams.append('iss', issuer);
  if (!display.known) {
    return failurePage(`The app asking sent a request Cellucid cannot answer: ${description}.`, 400, {
      href: url.href,
      host: display.redirectHost,
    });
  }
  return new Response(null, { status: 302, headers: { Location: url.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

export async function handleAuthorize(request, site, keys, env, fetchImpl) {
  if (request.method !== 'GET') throw new RelayHttpError(405, 'Authorize with GET', { headers: { Allow: 'GET' } });
  const url = new URL(request.url);
  let params;
  try {
    params = singleParams(url.searchParams, description => new Error(description));
  } catch (error) {
    return failurePage(`The request is not valid: ${error.message}.`, 400);
  }
  let client;
  try {
    client = await resolveClient(params.get('client_id'), keys, fetchImpl);
  } catch (error) {
    if (error instanceof RelayHttpError) return failurePage(error.message, error.status);
    throw error;
  }
  let redirectUri = params.get('redirect_uri') ?? null;
  if (redirectUri === null) {
    if (client.redirectUris.length !== 1) return failurePage('The app asking did not say where to send the answer (redirect_uri).', 400);
    [redirectUri] = client.redirectUris;
  }
  const problem = redirectUriProblem(redirectUri);
  if (problem !== null) return failurePage(`The address the app wants the answer at ${problem}.`, 400);
  if (!client.redirectUris.some(registered => redirectMatches(registered, redirectUri))) {
    return failurePage(`The app asking did not register ${redirectUri} as an address for answers.`, 400);
  }

  const state = params.get('state') ?? null;
  const display = clientDisplay(client, redirectUri);
  const fail = (error, description) => errorAnswer(redirectUri, display, state, site.issuer, error, description);
  if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
  if (params.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  if (!CODE_CHALLENGE.test(params.get('code_challenge') ?? '')) return fail('invalid_request', 'code_challenge must be an S256 challenge (43 base64url characters)');
  const requestedResource = params.get('resource') ?? null;
  const resource = requestedResource === null ? site.resource : resourceOf(requestedResource, site);
  if (resource === null) return fail('invalid_target', `This server issues tokens only for ${site.resource}`);

  const pageSecret = randomBase64Url(32);
  // The browser this page shows in: its approver cookie, kept (two
  // authorizations waiting in one browser share it) or made now.
  const kept = cookieOf(request, APPROVER_COOKIE);
  const approver = kept !== null && APPROVER_VALUE.test(kept) ? kept : randomBase64Url(32);
  const record = {
    createdAt: Date.now(),
    expiresAt: Date.now() + APPROVAL_SECONDS * 1000,
    requestHash: await sha256Base64Url(pageSecret),
    browserHash: await sha256Base64Url(approver),
    client: { id: client.id, display },
    redirectUri,
    challenge: params.get('code_challenge'),
    state,
    scope: SCOPE,
    resource,
    issuer: site.issuer,
  };
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const code = newConnectCode();
    const created = await askObject(approvalStub(env, code), '/create', { record: { ...record, code } });
    if (created.status === 201) {
      const page = approvalPage({
        code,
        display: `${code.slice(0, 4)}-${code.slice(4)}`,
        request: pageSecret,
        appOrigin: RELAY_BUNDLE.appOrigin,
        client: display,
        expiresInMinutes: APPROVAL_SECONDS / 60,
      });
      page.headers.append('Set-Cookie', `${APPROVER_COOKIE}=${approver}; Path=/; Max-Age=${APPROVAL_SECONDS}; Secure; HttpOnly; SameSite=Strict`);
      return page;
    }
  }
  throw new RelayHttpError(503, 'No connect code was free; try again');
}

export async function handleAuthorizeWait(request, site, env) {
  if (request.method !== 'POST') throw new RelayHttpError(405, 'Wait with POST', { headers: { Allow: 'POST' } });
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== site.origin) throw new RelayHttpError(403, 'Only the relay\'s own page waits for an approval');
  if (!isJson(request)) throw new RelayHttpError(400, 'Send JSON');
  const text = textOf(await readBody(request, OAUTH_BODY_MAX_BYTES));
  let body;
  try {
    body = JSON.parse(text ?? '');
  } catch {
    body = null;
  }
  const code = body?.code;
  if (!isConnectCode(code) || typeof body.request !== 'string') {
    throw new RelayHttpError(400, 'Name the connect code and the page\'s request');
  }
  const answer = await askObject(approvalStub(env, code), '/wait', {
    request: body.request,
    seen: typeof body.seen === 'string' ? body.seen : null,
    cancel: body.cancel === true,
  });
  return jsonResponse(answer.body, answer.status);
}

/**
 * A Cellucid page claims a connect code (`POST /oauth/claim`, `{code,
 * secret}`: the code and the page's tab secret, which names its pairing as
 * the tab's socket does). The request must come from an allowed Cellucid
 * page (`Origin`) and carry the approver cookie of the browser that shows
 * the code's waiting page; the browser sends it only with
 * `credentials: 'include'` from the relay's own site (`SameSite=Strict`:
 * www.cellucid.com and mcp.cellucid.com are one site). The approval's
 * answer is the body of a 200, as a socket reply's is: `{ok: true, value:
 * {client, expiresAt}}`, or `{ok: false, error: {code, message}}` (unknown,
 * started in another browser, claimed elsewhere, answered): an answer the
 * person reads, not a failed request. A request no Cellucid page sends (no
 * allowed origin, not POST, not a code and a tab secret) is a 4xx.
 */
export async function handleClaim(request, keys, env, allowedOrigins) {
  const origin = request.headers.get('Origin');
  if (origin === null || !allowedOrigins.has(origin)) throw new RelayHttpError(403, 'Only a Cellucid page claims a connect code');
  const cors = credentialedCorsHeaders(origin);
  if (request.method === 'OPTIONS') return emptyResponse(204, cors);
  const refuse = (status, code, message) => jsonResponse({ code, message }, status, cors);
  if (request.method !== 'POST') return refuse(405, 'method', 'Claim with POST');
  if (!isJson(request)) return refuse(400, 'malformed', 'Send JSON');
  let body;
  try {
    body = JSON.parse(textOf(await readBody(request, OAUTH_BODY_MAX_BYTES)) ?? '');
  } catch (error) {
    if (error instanceof RelayHttpError) return refuse(error.status, 'malformed', error.message);
    body = null;
  }
  if (!isConnectCode(body?.code)) return refuse(400, 'not-a-code', 'That is not a connect code.');
  if (typeof body.secret !== 'string' || !TAB_SECRET.test(body.secret)) return refuse(400, 'malformed', 'The page must prove its tab secret');
  const approver = cookieOf(request, APPROVER_COOKIE);
  const answer = await askObject(approvalStub(env, body.code), '/claim', {
    pairingId: await pairingIdOf(keys, body.secret),
    browserHash: approver !== null && APPROVER_VALUE.test(approver) ? await sha256Base64Url(approver) : null,
  });
  const reply = answer.status === 200
    ? { ok: true, value: answer.body }
    : { ok: false, error: { code: answer.body.code, message: answer.body.message } };
  return jsonResponse(reply, 200, cors);
}

// ---- tokens ---------------------------------------------------------------------

function pairingStub(env, pairingId) {
  return env.PAIRING.get(env.PAIRING.idFromName(pairingId));
}

export async function askPairing(env, pairingId, path, body) {
  const response = await pairingStub(env, pairingId).fetch(`https://relay.internal${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [PAIRING_HEADER]: pairingId },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function issueTokens(site, keys, { pairingId, grant, generation, scope }) {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await seal(keys.access, 'at1', {
    iss: site.issuer, aud: site.resource, sub: pairingId, g: grant, iat: now, exp: now + ACCESS_TOKEN_SECONDS,
  });
  const refreshToken = await seal(keys.refresh, 'rt1', {
    iss: site.issuer, aud: site.resource, sub: pairingId, g: grant, n: generation, iat: now,
  });
  return jsonResponse({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_SECONDS,
    refresh_token: refreshToken,
    scope,
  }, 200, { ...publicCorsHeaders(), Pragma: 'no-cache' });
}

export async function handleToken(request, site, keys, env) {
  if (request.method !== 'POST') throw new RelayHttpError(405, 'Ask for tokens with POST', { headers: { Allow: 'POST' } });
  const refuse = description => oauthError(400, 'invalid_request', description, publicCorsHeaders());
  const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') throw refuse('A token request is form-encoded (application/x-www-form-urlencoded)');
  const text = textOf(await readBody(request, OAUTH_BODY_MAX_BYTES));
  if (text === null) throw refuse('The request body is not UTF-8');
  const params = singleParams(new URLSearchParams(text), refuse);
  const grantError = (description, error = 'invalid_grant') => oauthError(400, error, description, publicCorsHeaders());
  const requested = params.get('resource') ?? null;
  const resource = requested === null ? null : resourceOf(requested, site);
  if (requested !== null && resource === null) throw grantError(`This server issues tokens only for ${site.resource}`, 'invalid_target');

  switch (params.get('grant_type')) {
    case 'authorization_code': {
      const parts = (params.get('code') ?? '').split('.');
      if (parts.length !== 3 || parts[0] !== 'ac1' || !isConnectCode(parts[1])) {
        throw grantError('The authorization code is not one this relay issued');
      }
      const clientId = params.get('client_id');
      if (typeof clientId !== 'string' || clientId.length === 0) throw refuse('client_id is required');
      const redirectUri = params.get('redirect_uri');
      if (typeof redirectUri !== 'string') throw refuse('redirect_uri is required');
      const verifier = params.get('code_verifier');
      if (typeof verifier !== 'string' || !CODE_VERIFIER.test(verifier)) throw refuse('code_verifier is required (43 to 128 unreserved characters)');
      const redeemed = await askObject(approvalStub(env, parts[1]), '/redeem', {
        jti: parts[2], clientId, redirectUri, verifier, resource,
      });
      if (redeemed.body.ok !== true) throw grantError(redeemed.body.description, redeemed.body.error);
      const { grant: approved } = redeemed.body;
      const created = await askPairing(env, approved.pairingId, '/grant/create', {
        clientId: approved.clientId,
        agent: approved.agent,
        clientName: approved.clientName,
        clientHost: approved.clientHost,
        known: approved.known,
        scope: approved.scope,
      });
      return issueTokens(site, keys, {
        pairingId: approved.pairingId, grant: created.grant, generation: created.generation, scope: approved.scope,
      });
    }
    case 'refresh_token': {
      const payload = await unseal(keys.refresh, 'rt1', params.get('refresh_token'));
      if (payload === null || payload.iss !== site.issuer || typeof payload.sub !== 'string' || typeof payload.g !== 'string'
        || !Number.isSafeInteger(payload.n)) {
        throw grantError('The refresh token is not one this relay issued');
      }
      if (payload.aud !== site.resource || (resource !== null && resource !== payload.aud)) {
        throw grantError(`The refresh token is for ${String(payload.aud)}, not this resource`, 'invalid_target');
      }
      const rotated = await askPairing(env, payload.sub, '/grant/rotate', {
        grant: payload.g, generation: payload.n, clientId: params.get('client_id') ?? null,
      });
      if (typeof rotated.error === 'string') throw grantError(rotated.error);
      return issueTokens(site, keys, { pairingId: payload.sub, grant: payload.g, generation: rotated.generation, scope: rotated.scope });
    }
    case undefined:
      throw refuse('grant_type is required');
    default:
      throw oauthError(400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported', publicCorsHeaders());
  }
}

// ---- the resource side ---------------------------------------------------------------

/**
 * The connection a request to the MCP endpoint is made with, or a 401 (RFC 6750 §3)
 * that tells the client where to sign in.
 * @returns {Promise<{pairingId: string, grant: string}>}
 */
export async function authenticate(request, site, keys) {
  const challenge = (error, description) => new RelayHttpError(401, description ?? 'Connect Cellucid first', {
    headers: {
      'WWW-Authenticate': error === null
        ? `Bearer resource_metadata="${site.resourceMetadata}", scope="${SCOPE}"`
        : `Bearer error="${error}", error_description="${description}", resource_metadata="${site.resourceMetadata}", scope="${SCOPE}"`,
    },
    body: error === null ? { error: 'unauthorized', error_description: 'Connect Cellucid first' } : { error, error_description: description },
  });
  const header = request.headers.get('Authorization');
  if (header === null) throw challenge(null);
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
  if (match === null) throw challenge('invalid_token', 'The Authorization header is not a bearer token');
  const payload = await unseal(keys.access, 'at1', match[1]);
  if (payload === null || payload.iss !== site.issuer || typeof payload.sub !== 'string' || typeof payload.g !== 'string') {
    throw challenge('invalid_token', 'The access token is not one this relay issued');
  }
  if (payload.aud !== site.resource) throw challenge('invalid_token', 'The access token was issued for another resource');
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw challenge('invalid_token', 'The access token has expired');
  }
  return { pairingId: payload.sub, grant: payload.g, challenge };
}
