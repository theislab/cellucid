/**
 * The Cellucid relay: a Cloudflare Worker that lets Claude and ChatGPT (on
 * the web, desktop and mobile) operate the person's open Cellucid tab.
 *
 * It is a remote MCP server (at its root, `/`, so the connector address is
 * the bare origin, `https://mcp.cellucid.com`) and its own OAuth authorization server,
 * whose consent screen is the person's Cellucid tab: no accounts, no stored
 * chats, no dataset bytes. It carries tool calls to the tab and the tab's
 * answers back. Routes, the security model and deployment are in
 * `relay/README.md`; the protocol shared with the tab is
 * `assets/js/app/agent/bridge/relay-protocol.js` (bundled as
 * `relay/generated/bundle.js`).
 */

import { RELAY_BUNDLE } from './generated/bundle.js';
import { authorizeAsset } from './authorize-page.js';
import {
  RelayHttpError,
  emptyResponse,
  errorResponse,
  jsonResponse,
  publicCorsHeaders,
  relayEnvironment,
  relaySite,
} from './http.js';
import { pairingIdOf, relayKeys } from './keys.js';
import { handleMcpPost } from './mcp.js';
import {
  authenticate,
  authorizationServerMetadata,
  handleAuthorize,
  handleAuthorizeWait,
  handleRegister,
  handleToken,
  protectedResourceMetadata,
} from './oauth.js';
import { PAIRING_HEADER, PROTOCOL_HEADER } from './pairing.js';

export { RelayPairing } from './pairing.js';
export { RelayApproval } from './approval.js';

const PROTOCOL = RELAY_BUNDLE.protocol;
const TAB_SECRET = new RegExp(PROTOCOL.tabSecretPattern);

const PUBLIC_ROUTES = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-authorization-server',
  '/oauth/register',
  '/oauth/token',
]);

const ENDPOINTS = Object.freeze([
  '/',
  '/health',
  '/tab',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-authorization-server',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/token',
]);

function mcpCors(origin) {
  if (origin === null) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID',
    'Access-Control-Expose-Headers': 'WWW-Authenticate',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function requireGet(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new RelayHttpError(405, `${new URL(request.url).pathname} answers GET`, { headers: { Allow: 'GET' } });
  }
}

async function openTab(request, env, keys, allowedOrigins) {
  if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
    throw new RelayHttpError(426, 'The tab connects with a WebSocket', { headers: { Upgrade: 'websocket' } });
  }
  const origin = request.headers.get('Origin');
  if (origin === null || !allowedOrigins.has(origin)) throw new RelayHttpError(403, 'Only a Cellucid page connects as a tab');
  const offered = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(token => token.trim()).filter(Boolean);
  const version = offered.find(token => token.startsWith('cellucid-relay.'));
  const secrets = offered.filter(token => token.startsWith(PROTOCOL.secretPrefix)).map(token => token.slice(PROTOCOL.secretPrefix.length));
  if (version === undefined || secrets.length !== 1 || !TAB_SECRET.test(secrets[0])) {
    throw new RelayHttpError(400, 'The tab must offer the relay protocol and prove its tab secret');
  }
  const pairingId = await pairingIdOf(keys, secrets[0]);
  const stub = env.PAIRING.get(env.PAIRING.idFromName(pairingId));
  return stub.fetch(new Request('https://relay.internal/tab', {
    headers: { Upgrade: 'websocket', [PAIRING_HEADER]: pairingId, [PROTOCOL_HEADER]: version },
  }));
}

async function serveMcp(request, env, site, keys, allowedOrigins) {
  const origin = request.headers.get('Origin');
  if (origin !== null && !allowedOrigins.has(origin)) {
    return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Origin ${origin} may not call this server` } }, 403);
  }
  const cors = mcpCors(origin);
  if (request.method === 'OPTIONS') return emptyResponse(204, cors);
  if (request.method !== 'POST') {
    // GET (a stream) and DELETE (a session) answer 405, as Streamable HTTP asks of a server without them.
    const message = 'This is the Cellucid connector address: add it in Claude or ChatGPT. It answers one JSON-RPC message per POST; the relay\'s status is at /health.';
    return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32600, message } }, 405, { ...cors, Allow: 'POST' });
  }
  if (new URL(request.url).searchParams.has('access_token')) {
    throw new RelayHttpError(400, 'Access tokens are accepted in the Authorization header only, never in the address', {
      body: { error: 'invalid_request', error_description: 'Access tokens are accepted in the Authorization header only, never in the address' },
      headers: cors,
    });
  }
  let auth;
  try {
    auth = await authenticate(request, site, keys);
  } catch (error) {
    if (error instanceof RelayHttpError) return errorResponse(error, cors);
    throw error;
  }
  try {
    return await handleMcpPost(request, env, auth, cors);
  } catch (error) {
    if (error instanceof RelayHttpError) return errorResponse(error, cors);
    throw error;
  }
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, unknown>} env
   */
  async fetch(request, env) {
    let cors = {};
    try {
      const { allowedOrigins, secret } = relayEnvironment(env);
      const site = relaySite(request);
      const keys = await relayKeys(secret);
      const { pathname } = new URL(request.url);

      if (pathname === '/') return await serveMcp(request, env, site, keys, allowedOrigins);
      if (PUBLIC_ROUTES.has(pathname)) {
        cors = publicCorsHeaders();
        if (request.method === 'OPTIONS') return emptyResponse(204, cors);
      }
      switch (pathname) {
        case '/health':
          requireGet(request);
          return jsonResponse({
            status: 'ok',
            service: 'Cellucid relay',
            contractVersion: PROTOCOL.version,
            mcp: site.resource,
            cellucidVersion: RELAY_BUNDLE.appVersion,
            catalog: RELAY_BUNDLE.catalogDigest,
            endpoints: ENDPOINTS,
          });
        case '/.well-known/oauth-protected-resource':
          requireGet(request);
          return jsonResponse(protectedResourceMetadata(site), 200, cors);
        case '/.well-known/oauth-authorization-server':
          requireGet(request);
          return jsonResponse(authorizationServerMetadata(site), 200, cors);
        case '/oauth/register':
          return await handleRegister(request, keys);
        case '/oauth/authorize':
          return await handleAuthorize(request, site, keys, env, (input, init) => globalThis.fetch(input, init));
        case '/oauth/authorize/wait':
          return await handleAuthorizeWait(request, site, env);
        case '/oauth/assets/authorize.js':
        case '/oauth/assets/authorize.css': {
          requireGet(request);
          return authorizeAsset(pathname.slice('/oauth/assets/'.length));
        }
        case '/oauth/token':
          return await handleToken(request, site, keys, env);
        case '/tab':
          return await openTab(request, env, keys, allowedOrigins);
        default:
          throw new RelayHttpError(404, `No route ${pathname}`);
      }
    } catch (error) {
      if (error instanceof RelayHttpError) return errorResponse(error, cors);
      console.error('Cellucid relay error', { name: error?.name, message: error?.message });
      return errorResponse(new RelayHttpError(500, 'The relay failed to answer'), cors);
    }
  },
};
