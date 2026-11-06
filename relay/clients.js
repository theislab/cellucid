/**
 * OAuth clients of the relay: who asks to connect (Claude, ChatGPT, another
 * MCP client), how the relay knows their redirect URIs, and how they are
 * shown to the person approving in Cellucid.
 *
 * Two ways a client identifies itself, both without anything stored here:
 *
 * - **Client ID Metadata Document**: the client id is an https URL whose
 *   JSON document names the client and its redirect URIs (Claude Code
 *   `https://claude.ai/oauth/claude-code-client-metadata`, ChatGPT
 *   `https://chatgpt.com/oauth/client.json`). The relay fetches it when the
 *   authorization starts, under rules for a hostile address (below).
 * - **Dynamic Client Registration** (RFC 7591): the client posts its
 *   redirect URIs and gets a client id that is those, signed (`cd1.`).
 *
 * Fetching a client document, an address anyone can type: https only on the
 * default port; a DNS name with a dot (no IP literal, no `localhost` or other
 * special-use name); a path and nothing else (no query, fragment, dot
 * segments, user name or password); the URL exactly as written; no redirect
 * followed; an answer of 200 with a JSON type within `CLIENT_DOCUMENT_WAIT_MS`
 * and `CLIENT_DOCUMENT_MAX_BYTES`, read as a stream and stopped there. The
 * Worker reaches only the public internet, so these bound what the relay
 * spends on someone else's address rather than what it can reach.
 */

import { isLoopbackRedirect, redirectHostOf, redirectUriProblem } from './redirect-uris.js';
import { seal, unseal } from './keys.js';
import { randomBase64Url, textOf } from './encoding.js';
import { RelayHttpError } from './http.js';

/**
 * Bytes of a client metadata document read at most: the size the Client ID
 * Metadata Document draft recommends as the maximum (5 kilobytes); Claude's
 * and ChatGPT's are under 600 bytes.
 */
export const CLIENT_DOCUMENT_MAX_BYTES = 5 * 1024;
/** How long a client document may take to arrive; Claude allows an authorization server 10 s per step. */
export const CLIENT_DOCUMENT_WAIT_MS = 5_000;
/**
 * The longest client id the relay issues by registration: it travels in the
 * authorization URL, and Cloudflare refuses a URL above 16 KB; half of that
 * leaves room for the redirect URI, state, challenge and resource.
 */
export const CLIENT_ID_MAX_CHARS = 8 * 1024;
/** Characters of a client's self-chosen name shown to the person. */
export const DISPLAY_TEXT_CHARS = 80;

/** Hosts whose apps the person knows by name. */
const KNOWN_AGENTS = Object.freeze({ 'claude.ai': 'Claude', 'chatgpt.com': 'ChatGPT' });
const SPECIAL_USE_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa', 'test', 'invalid', 'example', 'onion', 'lan'];
const SECRET_METHODS = new Set(['client_secret_basic', 'client_secret_post', 'client_secret_jwt']);

/** A client's (or a tab's) own text, safe to show: no control or direction characters, one line, bounded (`limit` characters). */
export function displayText(value, limit = DISPLAY_TEXT_CHARS) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return null;
  const characters = [...clean];
  return characters.length <= limit ? clean : `${characters.slice(0, limit - 1).join('')}…`;
}

/** Why `value` cannot be fetched as a client metadata document, or null. */
export function clientDocumentUrlProblem(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'is not a URL';
  }
  if (url.protocol !== 'https:') return 'is not https';
  if (url.href !== value) return 'is not written exactly as its canonical form';
  if (url.username !== '' || url.password !== '') return 'carries a user name or password';
  if (url.port !== '') return 'names a port';
  if (url.search !== '' || value.includes('?')) return 'has a query';
  if (value.includes('#')) return 'has a fragment';
  if (url.pathname === '/' || url.pathname === '') return 'has no path';
  if (/\/\.\.?(?:\/|$)/.test(url.pathname)) return 'has a dot segment';
  const host = url.hostname;
  if (host.startsWith('[') || /^[0-9.]+$/.test(host)) return 'names an IP address instead of a host name';
  if (!host.includes('.')) return 'names a host without a domain';
  if (SPECIAL_USE_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return 'names a special-use host';
  return null;
}

async function readBounded(response, limit) {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && Number(declared) > limit) return null;
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function clientFailure(clientId, problem) {
  return new RelayHttpError(400, `The app asking cannot be identified: its client document ${clientId} ${problem}.`, {
    body: { error: 'invalid_client', error_description: `client document ${problem}` },
  });
}

/**
 * Fetch and check a client metadata document.
 * @param {string} clientId
 * @param {typeof fetch} fetchImpl
 */
export async function fetchClientDocument(clientId, fetchImpl) {
  const problem = clientDocumentUrlProblem(clientId);
  if (problem !== null) throw clientFailure(clientId, problem);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_DOCUMENT_WAIT_MS);
  let document;
  try {
    let response;
    try {
      response = await fetchImpl(clientId, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch {
      throw clientFailure(clientId, controller.signal.aborted
        ? `did not answer within ${CLIENT_DOCUMENT_WAIT_MS / 1000} seconds`
        : 'could not be reached');
    }
    if (response.status >= 300 && response.status < 400) throw clientFailure(clientId, 'redirects elsewhere (not followed)');
    if (response.status !== 200) throw clientFailure(clientId, `answered HTTP ${response.status}`);
    const type = (response.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json' && !type.endsWith('+json')) throw clientFailure(clientId, 'is not JSON');
    let bytes;
    try {
      bytes = await readBounded(response, CLIENT_DOCUMENT_MAX_BYTES);
    } catch {
      throw clientFailure(clientId, controller.signal.aborted
        ? `did not arrive within ${CLIENT_DOCUMENT_WAIT_MS / 1000} seconds`
        : 'broke off');
    }
    if (bytes === null) throw clientFailure(clientId, `is larger than ${CLIENT_DOCUMENT_MAX_BYTES} bytes`);
    const text = textOf(bytes);
    try {
      document = text === null ? null : JSON.parse(text);
    } catch {
      document = null;
    }
  } finally {
    clearTimeout(timer);
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) throw clientFailure(clientId, 'is not a JSON object');
  if (document.client_id !== clientId) throw clientFailure(clientId, 'names another client_id');
  if (Object.hasOwn(document, 'client_secret') || Object.hasOwn(document, 'client_secret_expires_at')) {
    throw clientFailure(clientId, 'carries a client secret, which a metadata document must not');
  }
  if (SECRET_METHODS.has(document.token_endpoint_auth_method)) {
    throw clientFailure(clientId, `authenticates with ${document.token_endpoint_auth_method}, a shared secret`);
  }
  if (!Array.isArray(document.redirect_uris) || document.redirect_uris.length === 0) {
    throw clientFailure(clientId, 'lists no redirect_uris');
  }
  const redirectUris = document.redirect_uris.filter(uri => typeof uri === 'string' && redirectUriProblem(uri) === null);
  const host = new URL(clientId).hostname;
  return Object.freeze({
    id: clientId,
    registration: 'document',
    name: displayText(document.client_name) ?? host,
    verifiedHost: host,
    redirectUris: Object.freeze(redirectUris),
  });
}

/**
 * Register a client (RFC 7591): its redirect URIs and name, signed into its
 * client id. Unsupported choices are replaced by what the relay does (public
 * client, authorization code with refresh), as RFC 7591 §3.2.1 allows.
 * @param {unknown} metadata the parsed request body
 * @param {Record<string, CryptoKey>} keys
 * @param {number} now seconds
 */
export async function registerClient(metadata, keys, now) {
  const refuse = (error, description) => new RelayHttpError(400, description, { body: { error, error_description: description } });
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw refuse('invalid_client_metadata', 'The registration must be a JSON object');
  }
  const uris = metadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) throw refuse('invalid_redirect_uri', 'redirect_uris must list at least one URI');
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem !== null) throw refuse('invalid_redirect_uri', `Redirect URI ${JSON.stringify(uri)} ${problem}`);
  }
  if (metadata.response_types !== undefined
    && !(Array.isArray(metadata.response_types) && metadata.response_types.includes('code'))) {
    throw refuse('invalid_client_metadata', 'response_types must include "code"');
  }
  if (metadata.grant_types !== undefined
    && !(Array.isArray(metadata.grant_types) && metadata.grant_types.includes('authorization_code'))) {
    throw refuse('invalid_client_metadata', 'grant_types must include "authorization_code"');
  }
  const name = displayText(metadata.client_name);
  // A random part makes each registration its own client, as RFC 7591 expects.
  const clientId = await seal(keys.client, 'cd1', { r: [...new Set(uris)], n: name, t: now, j: randomBase64Url(9) });
  if (clientId.length > CLIENT_ID_MAX_CHARS) {
    throw refuse('invalid_client_metadata', 'The redirect URIs are too long to fit in an authorization address; register fewer or shorter ones');
  }
  return {
    client_id: clientId,
    client_id_issued_at: now,
    ...(name === null ? {} : { client_name: name }),
    redirect_uris: [...new Set(uris)],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

/**
 * The client a client id names: a metadata document fetched now, or a
 * registration this relay signed.
 * @param {string} clientId
 * @param {Record<string, CryptoKey>} keys
 * @param {typeof fetch} fetchImpl
 */
export async function resolveClient(clientId, keys, fetchImpl) {
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new RelayHttpError(400, 'The request names no client_id.', { body: { error: 'invalid_request', error_description: 'client_id is required' } });
  }
  // Anything shaped like an address is a client document, checked as one (an http one is refused there).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(clientId)) return fetchClientDocument(clientId, fetchImpl);
  const registered = await unseal(keys.client, 'cd1', clientId);
  if (registered === null || !Array.isArray(registered.r)) {
    throw new RelayHttpError(400, 'This relay does not know the app asking (an unknown client_id). Remove the connector and add it again.', {
      body: { error: 'invalid_client', error_description: 'unknown client_id' },
    });
  }
  return Object.freeze({
    id: clientId,
    registration: 'registered',
    name: typeof registered.n === 'string' ? registered.n : null,
    verifiedHost: null,
    redirectUris: Object.freeze(registered.r.filter(uri => redirectUriProblem(uri) === null)),
  });
}

/**
 * How the person sees who asks: the agent's name (Claude, ChatGPT, or the
 * client's own name), the host that vouches for it, where the answer goes,
 * and whether the app runs on this computer.
 * @param {{registration: string, name: string|null, verifiedHost: string|null}} client
 * @param {string} redirectUri the redirect URI of this authorization
 */
export function clientDisplay(client, redirectUri) {
  const loopback = isLoopbackRedirect(redirectUri);
  const redirectHost = redirectHostOf(redirectUri);
  const host = client.verifiedHost ?? (loopback ? null : redirectHost);
  const known = host !== null && Object.hasOwn(KNOWN_AGENTS, host) ? KNOWN_AGENTS[host] : null;
  return Object.freeze({
    agent: known ?? client.name ?? host ?? 'An app on this computer',
    name: client.name,
    host,
    redirectHost,
    loopback,
    known: known !== null,
    registration: client.registration,
  });
}
