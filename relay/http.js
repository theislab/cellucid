/**
 * HTTP for the relay: errors that carry their status, responses with the
 * relay's headers, the checked environment, bounded bodies and the site's
 * own addresses (issuer, MCP resource).
 */

export class RelayHttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {{headers?: HeadersInit, body?: object}} [options] `body` replaces `{error: message}`
   */
  constructor(status, message, { headers = undefined, body = undefined } = {}) {
    super(message);
    this.name = 'RelayHttpError';
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

/** Headers every relay response carries. */
const BASE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

export function withBaseHeaders(headers) {
  const out = new Headers(headers);
  for (const [name, value] of Object.entries(BASE_HEADERS)) if (!out.has(name)) out.set(name, value);
  return out;
}

export function jsonResponse(body, status = 200, headers = undefined) {
  const out = withBaseHeaders(headers);
  out.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers: out });
}

export function emptyResponse(status, headers = undefined) {
  return new Response(null, { status, headers: withBaseHeaders(headers) });
}

export function errorResponse(error, headers = undefined) {
  const merged = new Headers(headers);
  for (const [name, value] of new Headers(error.headers)) merged.set(name, value);
  return jsonResponse(error.body ?? { error: error.message }, error.status, merged);
}

/**
 * Whether `hostname` is a loopback host a browser trusts over plain HTTP:
 * `localhost`, `*.localhost`, 127.0.0.0/8, `::1` (W3C Secure Contexts §3.1),
 * never `0.0.0.0`. The relay imports nothing outside its folder: this is
 * the copy of the web app's `utils/loopback.js` `isSecureContextLoopbackHost`,
 * held to its answers by `tests/community-annotation-worker-duplication-contract.test.mjs`.
 * @param {string} hostname
 */
export function isSecureContextLoopbackHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(host) || host === '::1';
}

const SIGNING_KEY = /^[A-Za-z0-9_-]{43,}$/;

/**
 * The relay's configuration, checked on every request (a missing or inexact
 * secret answers 500 rather than running with a weak one):
 *
 * - `RELAY_SIGNING_KEY`: at least 256 bits as base64url (43 characters or more);
 * - `ALLOWED_ORIGINS`: the Cellucid pages that may open a tab connection or
 *   call the MCP endpoint (`/`) from a browser; exact origins, comma separated, https or
 *   loopback http;
 * - `PAIRING`, `APPROVAL`: the Durable Object namespaces.
 *
 * @param {Record<string, unknown>} env
 */
export function relayEnvironment(env) {
  const secret = env?.RELAY_SIGNING_KEY;
  if (typeof secret !== 'string' || !SIGNING_KEY.test(secret)) {
    throw new RelayHttpError(500, 'Missing or invalid relay secret: RELAY_SIGNING_KEY (43 or more base64url characters)');
  }
  const raw = env?.ALLOWED_ORIGINS;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new RelayHttpError(500, 'Missing relay setting: ALLOWED_ORIGINS');
  }
  const allowedOrigins = new Set();
  for (const entry of raw.split(',')) {
    let url;
    try {
      url = new URL(entry);
    } catch {
      throw new RelayHttpError(500, `ALLOWED_ORIGINS contains an invalid origin: ${entry}`);
    }
    const exact = url.origin === entry && !url.username && !url.password;
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && isSecureContextLoopbackHost(url.hostname));
    if (!exact || !secure) {
      throw new RelayHttpError(500, `ALLOWED_ORIGINS entries must be exact https origins or loopback http origins: ${entry}`);
    }
    if (allowedOrigins.has(entry)) throw new RelayHttpError(500, `ALLOWED_ORIGINS repeats ${entry}`);
    allowedOrigins.add(entry);
  }
  for (const binding of ['PAIRING', 'APPROVAL']) {
    if (typeof env?.[binding]?.idFromName !== 'function') {
      throw new RelayHttpError(500, `Missing Durable Object binding: ${binding}`);
    }
  }
  return { secret, allowedOrigins };
}

/**
 * The relay's own addresses, from the address it was reached at: the OAuth
 * issuer and the protected resource (the MCP endpoint, answered at the root
 * path, so the connector address is the bare origin) are both its origin.
 * Plain http is served only on a loopback host (`wrangler dev`).
 * @param {Request} request
 */
export function relaySite(request) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isSecureContextLoopbackHost(url.hostname))) {
    throw new RelayHttpError(400, 'The relay answers over https only');
  }
  const origin = url.origin;
  return Object.freeze({
    origin,
    issuer: origin,
    resource: origin,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource`,
  });
}

/**
 * The body of `request`, read up to `limit` bytes.
 * @param {Request} request
 * @param {number} limit
 * @returns {Promise<Uint8Array>}
 */
export async function readBody(request, limit) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && Number(declared) > limit) {
    throw new RelayHttpError(413, `The request body is larger than ${limit} bytes`);
  }
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new RelayHttpError(413, `The request body is larger than ${limit} bytes`);
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

/**
 * The value of the cookie `name` that `request` carries, or null (a name
 * given twice is no answer: neither is trusted).
 * @param {Request} request
 * @param {string} name
 */
export function cookieOf(request, name) {
  const header = request.headers.get('Cookie');
  if (header === null) return null;
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}

/**
 * CORS headers that let one of the Cellucid pages (`ALLOWED_ORIGINS`) send
 * a request with its cookies for the relay (`credentials: 'include'`) and
 * read the answer: the exact origin, never `*`.
 * @param {string} origin
 */
export function credentialedCorsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/** Whether `request` declares a JSON body (any charset). */
export function isJson(request) {
  const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}

/** CORS headers that let any page read a public, credential-free answer. */
export function publicCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
    'Access-Control-Max-Age': '600',
  };
}
