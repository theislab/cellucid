/**
 * Cloudflare Worker for Cellucid community-annotation GitHub OAuth and API access.
 *
 * This is the deployable worker source used by the self-hosting guide. It exposes
 * only the routes consumed by the current Cellucid browser client.
 */

import { parseExactJson } from './wire-contract.js';
import {
  isCanonicalGitHubAccount,
  isCanonicalGitHubBranch,
  isCanonicalGitHubRepositoryFullName,
  isCanonicalGitHubRepositoryName,
} from './github-reference.js';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_VERSION = '2026-03-10';
const GITHUB_PAGE_SIZE = 100;
const GITHUB_REQUEST_TIMEOUT_MS = 20_000;
const GITHUB_SHA = /^[0-9a-f]{40}$/;
const GITHUB_USER_FILE =
  /^annotations\/users\/ghid_[1-9][0-9]*\.json$/;
const GITHUB_READ_ONLY_SCHEMA_FILES = new Set([
  'annotations/schema.json',
  'annotations/config.schema.json',
  'annotations/moderation/merges.schema.json',
]);

const OAUTH_STATE_COOKIE = 'cellucid_gh_oauth_state';
const OAUTH_RETURN_TO_COOKIE = 'cellucid_gh_oauth_return_to';
const OAUTH_CODE_VERIFIER_COOKIE = 'cellucid_gh_oauth_code_verifier';
const OAUTH_COOKIE_MAX_AGE_S = 10 * 60;

const APP_AUTH_FLAG_PARAM = 'cellucid_github_auth';
const APP_AUTH_TOKEN_PARAM = 'cellucid_github_token';
const APP_AUTH_ERROR_PARAM = 'cellucid_github_error';

const ALLOWED_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'OPTIONS',
]);
const ALLOWED_REQUEST_HEADERS = new Set([
  'authorization',
  'content-type',
]);

class WorkerHttpError extends Error {
  constructor(status, message, { headers = null, cause = null } = {}) {
    super(message);
    this.name = 'WorkerHttpError';
    this.status = status;
    this.responseHeaders = headers;
    this.cause = cause;
  }
}

export default {
  async fetch(request, env) {
    let corsHeaders = new Headers();
    try {
      if (!(request instanceof Request)) {
        throw new WorkerHttpError(400, 'Worker request must be a Request');
      }
      const url = new URL(request.url);
      const allowedOrigins = validateWorkerEnvironment(env);
      const origin = request.headers.get('Origin');
      if (origin !== null && !allowedOrigins.has(origin)) {
        return jsonResponse(
          { error: `Origin is not allowed: ${origin}` },
          403
        );
      }
      corsHeaders = createCorsHeaders(origin);

      if (request.method === 'OPTIONS') {
        return handlePreflight(request, corsHeaders);
      }
      if (!ALLOWED_METHODS.has(request.method)) {
        throw new WorkerHttpError(405, `Method is not allowed: ${request.method}`);
      }

      if (url.pathname === '/auth/login') {
        requireMethod(request, 'GET');
        return await handleLogin(url, env);
      }
      if (url.pathname === '/auth/callback') {
        requireMethod(request, 'GET');
        return await handleCallback(request, url, env);
      }
      if (url.pathname === '/auth/user') {
        requireMethod(request, 'GET');
        return await handleGetUser(request, corsHeaders);
      }
      if (url.pathname === '/auth/installations') {
        requireMethod(request, 'GET');
        return await handleGetInstallations(request, corsHeaders);
      }
      if (url.pathname === '/auth/installation-repos') {
        requireMethod(request, 'POST');
        return await handleGetInstallationRepos(request, corsHeaders);
      }
      if (url.pathname.startsWith('/api/')) {
        return await handleApiProxy(request, url, corsHeaders);
      }
      if (url.pathname === '/') {
        requireMethod(request, 'GET');
        return jsonResponse(
          {
            status: 'ok',
            service: 'Cellucid GitHub Auth',
            endpoints: [
              '/auth/login',
              '/auth/callback',
              '/auth/user',
              '/auth/installations',
              '/auth/installation-repos',
              '/api/repos/*',
            ],
          },
          200,
          corsHeaders
        );
      }
      throw new WorkerHttpError(404, 'Route not found');
    } catch (error) {
      const status =
        error instanceof WorkerHttpError ? error.status : 500;
      const message =
        error instanceof WorkerHttpError
          ? error.message
          : 'Internal worker error';
      if (!(error instanceof WorkerHttpError)) {
        console.error('Cellucid GitHub worker error', {
          name: error?.name,
          message: error?.message,
        });
      }
      const headers = mergeHeaders(
        corsHeaders,
        error?.responseHeaders
      );
      return jsonResponse({ error: message }, status, headers);
    }
  },
};

function assertExactString(
  value,
  label,
  { max = 4096, status = 400 } = {}
) {
  if (
    typeof value !== 'string' ||
    !value ||
    /^\s|\s$/.test(value) ||
    Array.from(value).length > max
  ) {
    throw new WorkerHttpError(
      status,
      `${label} must be an exact nonblank string`
    );
  }
  return value;
}

function assertExactFields(value, fields, label, status = 400) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new WorkerHttpError(status, `${label} must be a JSON object`);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  ) {
    throw new WorkerHttpError(
      status,
      `${label} must contain exactly ${fields.join(', ')}`
    );
  }
  return value;
}

function assertCanonicalGitHubAccount(value, label) {
  assertExactString(value, label, { max: 64, status: 502 });
  if (!isCanonicalGitHubAccount(value)) {
    throw new WorkerHttpError(
      502,
      `${label} is not a canonical GitHub account`
    );
  }
  return value;
}

function upstreamErrorMessage(document, label) {
  if (
    !document ||
    typeof document !== 'object' ||
    Array.isArray(document) ||
    !Object.hasOwn(document, 'message')
  ) {
    throw new WorkerHttpError(
      502,
      `${label} response must contain message`
    );
  }
  return assertExactString(document.message, `${label} response message`, {
    max: 4096,
    status: 502,
  });
}

function requireMethod(request, expected) {
  if (request.method !== expected) {
    throw new WorkerHttpError(
      405,
      `${request.url} requires ${expected}`
    );
  }
}

function requireEnvString(env, key, { max = 16384 } = {}) {
  const value = env?.[key];
  if (
    typeof value !== 'string' ||
    !value ||
    /^\s|\s$/.test(value) ||
    Array.from(value).length > max
  ) {
    throw new WorkerHttpError(500, `Missing or invalid worker secret: ${key}`);
  }
  return value;
}

function parseAllowedOrigins(env) {
  const raw = requireEnvString(env, 'ALLOWED_ORIGINS');
  const entries = raw.split(',');
  if (!entries.length || entries.some((entry) => !entry)) {
    throw new WorkerHttpError(
      500,
      'ALLOWED_ORIGINS must be a comma-separated list of exact origins'
    );
  }
  const allowed = new Set();
  for (const entry of entries) {
    if (entry === '*') {
      throw new WorkerHttpError(500, 'ALLOWED_ORIGINS must not contain "*"');
    }
    let parsed;
    try {
      parsed = new URL(entry);
    } catch (cause) {
      throw new WorkerHttpError(
        500,
        `ALLOWED_ORIGINS contains an invalid URL: ${entry}`,
        { cause }
      );
    }
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username ||
      parsed.password ||
      entry !== parsed.origin
    ) {
      throw new WorkerHttpError(
        500,
        `ALLOWED_ORIGINS entry must be an exact HTTP(S) origin: ${entry}`
      );
    }
    if (allowed.has(entry)) {
      throw new WorkerHttpError(
        500,
        `ALLOWED_ORIGINS contains a duplicate origin: ${entry}`
      );
    }
    allowed.add(entry);
  }
  return allowed;
}

function validateWorkerEnvironment(env) {
  const allowedOrigins = parseAllowedOrigins(env);
  requireEnvString(env, 'GITHUB_CLIENT_ID', { max: 512 });
  requireEnvString(env, 'GITHUB_CLIENT_SECRET', { max: 4096 });
  return allowedOrigins;
}

function createCorsHeaders(origin) {
  const headers = new Headers({
    'Access-Control-Allow-Methods': [...ALLOWED_METHODS].join(', '),
    'Access-Control-Allow-Headers': [...ALLOWED_REQUEST_HEADERS].join(', '),
    'Vary': 'Origin',
  });
  if (origin !== null) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  return headers;
}

function handlePreflight(request, corsHeaders) {
  const requestedMethod = request.headers.get('Access-Control-Request-Method');
  if (
    requestedMethod === null ||
    !ALLOWED_METHODS.has(requestedMethod) ||
    requestedMethod === 'OPTIONS'
  ) {
    throw new WorkerHttpError(400, 'Invalid CORS preflight method');
  }
  const rawHeaders =
    request.headers.get('Access-Control-Request-Headers') ?? '';
  const requestedHeaders = rawHeaders
    ? rawHeaders.split(',').map((header) => header.trim().toLowerCase())
    : [];
  if (
    requestedHeaders.some(
      (header) => !header || !ALLOWED_REQUEST_HEADERS.has(header)
    )
  ) {
    throw new WorkerHttpError(400, 'Invalid CORS preflight request header');
  }
  return new Response(null, { status: 204, headers: corsHeaders });
}

function mergeHeaders(...sources) {
  const merged = new Headers();
  for (const source of sources) {
    if (!source) continue;
    new Headers(source).forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') {
        merged.append(key, value);
      } else {
        merged.set(key, value);
      }
    });
  }
  return merged;
}

function jsonResponse(data, status, headers = null) {
  const responseHeaders = mergeHeaders(headers, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  return new Response(JSON.stringify(data), {
    status,
    headers: responseHeaders,
  });
}

function getSingleQueryParam(url, name, { required = false } = {}) {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new WorkerHttpError(400, `${name} must occur at most once`);
  }
  if (!values.length) {
    if (required) {
      throw new WorkerHttpError(400, `Missing ${name}`);
    }
    return null;
  }
  return assertExactString(values[0], name);
}

function validateReturnTo(rawReturnTo, env) {
  const candidate = assertExactString(rawReturnTo, 'return_to');
  const allowedOrigins = parseAllowedOrigins(env);
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (cause) {
    throw new WorkerHttpError(400, 'Invalid return_to URL', { cause });
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password
  ) {
    throw new WorkerHttpError(400, 'Invalid return_to URL');
  }
  if (!allowedOrigins.has(parsed.origin)) {
    throw new WorkerHttpError(
      400,
      `Disallowed return_to origin: ${parsed.origin}`
    );
  }
  return parsed.toString();
}

function serializeCookie(name, value, { path, maxAge }) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new WorkerHttpError(500, 'Invalid worker cookie name');
  }
  if (typeof value !== 'string') {
    throw new WorkerHttpError(500, 'Invalid worker cookie value');
  }
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new WorkerHttpError(500, 'Invalid worker cookie path');
  }
  if (!Number.isSafeInteger(maxAge) || maxAge < 0) {
    throw new WorkerHttpError(500, 'Invalid worker cookie max age');
  }
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

function getCookie(request, name, { required = false } = {}) {
  const raw = request.headers.get('Cookie');
  if (raw === null) {
    if (required) throw new WorkerHttpError(400, `Missing ${name} cookie`);
    return null;
  }
  const matches = [];
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) {
      throw new WorkerHttpError(400, 'Malformed Cookie header');
    }
    const cookieName = part.slice(0, separator).trim();
    if (cookieName !== name) continue;
    const encodedValue = part.slice(separator + 1).trim();
    try {
      matches.push(decodeURIComponent(encodedValue));
    } catch (cause) {
      throw new WorkerHttpError(400, `Invalid ${name} cookie`, { cause });
    }
  }
  if (matches.length > 1) {
    throw new WorkerHttpError(400, `Duplicate ${name} cookie`);
  }
  if (!matches.length || !matches[0]) {
    if (required) throw new WorkerHttpError(400, `Missing ${name} cookie`);
    return null;
  }
  return matches[0];
}

function clearOauthCookies(headers) {
  for (const name of [
    OAUTH_STATE_COOKIE,
    OAUTH_RETURN_TO_COOKIE,
    OAUTH_CODE_VERIFIER_COOKIE,
  ]) {
    headers.append(
      'Set-Cookie',
      serializeCookie(name, '', {
        path: '/auth/callback',
        maxAge: 0,
      })
    );
  }
}

function redirectToApp(returnTo, { token = null, error = null }, headers) {
  if ((token === null) === (error === null)) {
    throw new WorkerHttpError(
      500,
      'OAuth redirect requires exactly one token or error'
    );
  }
  const destination = new URL(returnTo);
  const hashParams = new URLSearchParams(
    destination.hash.replace(/^#/, '')
  );
  hashParams.delete(APP_AUTH_FLAG_PARAM);
  hashParams.delete(APP_AUTH_TOKEN_PARAM);
  hashParams.delete(APP_AUTH_ERROR_PARAM);
  hashParams.set(APP_AUTH_FLAG_PARAM, '1');
  if (token !== null) {
    hashParams.set(
      APP_AUTH_TOKEN_PARAM,
      assertExactString(token, 'OAuth token')
    );
  }
  if (error !== null) {
    hashParams.set(
      APP_AUTH_ERROR_PARAM,
      assertExactString(error, 'OAuth error')
    );
  }
  destination.hash = hashParams.toString();

  const responseHeaders = mergeHeaders(headers, {
    'Cache-Control': 'no-store',
    'Location': destination.toString(),
  });
  return new Response(null, { status: 302, headers: responseHeaders });
}

function createPkceVerifier() {
  if (typeof crypto?.getRandomValues !== 'function') {
    throw new WorkerHttpError(500, 'Web Crypto random generation is required');
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
}

async function createPkceChallenge(verifier) {
  if (
    typeof crypto?.subtle?.digest !== 'function' ||
    typeof TextEncoder !== 'function' ||
    typeof btoa !== 'function'
  ) {
    throw new WorkerHttpError(500, 'Web Crypto PKCE support is required');
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(verifier)
    )
  );
  const binary = String.fromCharCode(...digest);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function handleLogin(url, env) {
  const returnTo = validateReturnTo(
    getSingleQueryParam(url, 'return_to', { required: true }),
    env
  );
  const clientId = requireEnvString(env, 'GITHUB_CLIENT_ID');
  const state = crypto.randomUUID();
  const codeVerifier = createPkceVerifier();
  const codeChallenge = await createPkceChallenge(codeVerifier);
  const redirectUri = `${url.origin}/auth/callback`;

  const authUrl = new URL(GITHUB_AUTH_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Location': authUrl.toString(),
  });
  headers.append(
    'Set-Cookie',
    serializeCookie(OAUTH_STATE_COOKIE, state, {
      path: '/auth/callback',
      maxAge: OAUTH_COOKIE_MAX_AGE_S,
    })
  );
  headers.append(
    'Set-Cookie',
    serializeCookie(OAUTH_RETURN_TO_COOKIE, returnTo, {
      path: '/auth/callback',
      maxAge: OAUTH_COOKIE_MAX_AGE_S,
    })
  );
  headers.append(
    'Set-Cookie',
    serializeCookie(OAUTH_CODE_VERIFIER_COOKIE, codeVerifier, {
      path: '/auth/callback',
      maxAge: OAUTH_COOKIE_MAX_AGE_S,
    })
  );
  return new Response(null, { status: 302, headers });
}

async function handleCallback(request, url, env) {
  const headers = new Headers();
  clearOauthCookies(headers);
  try {
    const returnTo = validateReturnTo(
      getCookie(request, OAUTH_RETURN_TO_COOKIE, { required: true }),
      env
    );
    const expectedState = assertExactString(
      getCookie(request, OAUTH_STATE_COOKIE, { required: true }),
      'OAuth state cookie'
    );
    const codeVerifier = assertExactString(
      getCookie(request, OAUTH_CODE_VERIFIER_COOKIE, { required: true }),
      'OAuth PKCE verifier'
    );
    const returnedState = getSingleQueryParam(url, 'state', {
      required: true,
    });
    if (returnedState !== expectedState) {
      throw new WorkerHttpError(400, 'Invalid OAuth state');
    }

    const code = getSingleQueryParam(url, 'code');
    const oauthError = getSingleQueryParam(url, 'error');
    const errorDescription = getSingleQueryParam(url, 'error_description');
    if ((code === null) === (oauthError === null)) {
      throw new WorkerHttpError(
        400,
        'OAuth callback requires exactly one code or error'
      );
    }
    if (oauthError !== null) {
      if (errorDescription === null) {
        throw new WorkerHttpError(
          400,
          'OAuth error must include error_description'
        );
      }
      return redirectToApp(
        returnTo,
        { error: `GitHub error: ${errorDescription}` },
        headers
      );
    }
    if (errorDescription !== null) {
      throw new WorkerHttpError(
        400,
        'OAuth error_description cannot accompany an authorization code'
      );
    }

    const clientId = requireEnvString(env, 'GITHUB_CLIENT_ID');
    const clientSecret = requireEnvString(env, 'GITHUB_CLIENT_SECRET');
    const tokenResponse = await fetchGitHub(
      GITHUB_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          code_verifier: codeVerifier,
          redirect_uri: `${url.origin}/auth/callback`,
        }),
      },
      'GitHub OAuth token exchange'
    );
    const tokenDocument = await parseResponseJson(
      tokenResponse,
      'GitHub OAuth token response'
    );
    if (!tokenResponse.ok) {
      assertExactFields(
        tokenDocument,
        ['error', 'error_description', 'error_uri'],
        'GitHub OAuth error response',
        502
      );
      const message = assertExactString(
        tokenDocument.error_description,
        'GitHub OAuth error_description',
        { status: 502 }
      );
      return redirectToApp(returnTo, { error: message }, headers);
    }
    assertExactFields(
      tokenDocument,
      ['access_token', 'token_type', 'scope'],
      'GitHub OAuth success response',
      502
    );
    if (tokenDocument?.token_type !== 'bearer' || tokenDocument?.scope !== '') {
      throw new WorkerHttpError(
        502,
        'GitHub OAuth response has an invalid token_type or scope'
      );
    }
    const token = assertExactString(
      tokenDocument?.access_token,
      'GitHub OAuth access_token',
      { status: 502 }
    );
    return redirectToApp(returnTo, { token }, headers);
  } catch (error) {
    if (error && typeof error === 'object') {
      error.responseHeaders = mergeHeaders(
        error.responseHeaders,
        headers
      );
    }
    throw error;
  }
}

function getBearerToken(request) {
  const authorization = request.headers.get('Authorization');
  if (authorization === null) {
    throw new WorkerHttpError(401, 'Missing bearer token');
  }
  const match = authorization.match(/^Bearer ([^\s,]+)$/);
  if (!match || Array.from(match[1]).length > 4096) {
    throw new WorkerHttpError(401, 'Invalid bearer token');
  }
  return match[1];
}

async function handleGetUser(request, corsHeaders) {
  const token = getBearerToken(request);
  const { response, document } = await githubFetchJson('/user', token);
  if (!response.ok) {
    return jsonResponse(
      { error: upstreamErrorMessage(document, 'GitHub user request failed') },
      response.status,
      corsHeaders
    );
  }
  const id = document?.id;
  const login = document?.login;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new WorkerHttpError(502, 'GitHub user id is invalid');
  }
  assertCanonicalGitHubAccount(login, 'GitHub user login');
  return jsonResponse({ id, login }, 200, corsHeaders);
}

async function handleGetInstallations(request, corsHeaders) {
  const token = getBearerToken(request);
  const result = await githubFetchCollection(
    '/user/installations',
    token,
    'installations'
  );
  if (!result.response.ok) {
    return jsonResponse(
      {
        error: upstreamErrorMessage(
          result.errorDocument,
          'GitHub installations request failed'
        ),
      },
      result.response.status,
      corsHeaders
    );
  }
  const seenIds = new Set();
  const seenAccounts = new Set();
  const installations = result.items.map((installation, index) => {
    const id = installation?.id;
    const login = installation?.account?.login;
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new WorkerHttpError(
        502,
        `GitHub installation ${index} has an invalid id`
      );
    }
    assertCanonicalGitHubAccount(
      login,
      `GitHub installation ${index} account login`
    );
    if (seenIds.has(id)) {
      throw new WorkerHttpError(
        502,
        `GitHub installations response contains duplicate id ${id}`
      );
    }
    const accountKey = login.toLowerCase();
    if (seenAccounts.has(accountKey)) {
      throw new WorkerHttpError(
        502,
        `GitHub installations response contains duplicate account ${login}`
      );
    }
    seenIds.add(id);
    seenAccounts.add(accountKey);
    return { id, account: { login } };
  });
  return jsonResponse({ installations }, 200, corsHeaders);
}

async function readExactRequestObject(request, label, allowedKeys = null) {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw new WorkerHttpError(415, `${label} requires application/json`);
  }
  const text = await request.text();
  if (!text) throw new WorkerHttpError(400, `${label} body is empty`);
  let document;
  try {
    document = parseExactJson(text, { path: label });
  } catch (cause) {
    throw new WorkerHttpError(400, `${label} contains invalid JSON`, { cause });
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new WorkerHttpError(400, `${label} must be a JSON object`);
  }
  const keys = Object.keys(document);
  if (
    allowedKeys !== null &&
    (
      keys.length !== allowedKeys.length ||
      allowedKeys.some((key) => !Object.hasOwn(document, key))
    )
  ) {
    throw new WorkerHttpError(
      400,
      `${label} must contain exactly ${allowedKeys.join(', ')}`
    );
  }
  return document;
}

async function handleGetInstallationRepos(request, corsHeaders) {
  const token = getBearerToken(request);
  const body = await readExactRequestObject(
    request,
    'installation repositories request',
    ['installation_id']
  );
  const installationId = body.installation_id;
  if (!Number.isSafeInteger(installationId) || installationId < 1) {
    throw new WorkerHttpError(
      400,
      'installation_id must be a positive safe integer'
    );
  }

  const result = await githubFetchCollection(
    `/user/installations/${installationId}/repositories`,
    token,
    'repositories'
  );
  if (!result.response.ok) {
    return jsonResponse(
      {
        error: upstreamErrorMessage(
          result.errorDocument,
          'GitHub installation repositories request failed'
        ),
      },
      result.response.status,
      corsHeaders
    );
  }
  const seenIds = new Set();
  const seenNames = new Set();
  const repositories = result.items.map((repository, index) => {
    const id = repository?.id;
    const fullName = repository?.full_name;
    const isPrivate = repository?.private;
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new WorkerHttpError(
        502,
        `GitHub repository ${index} has an invalid id`
      );
    }
    assertExactString(fullName, `GitHub repository ${index} full_name`, {
      max: 256,
      status: 502,
    });
    if (!isCanonicalGitHubRepositoryFullName(fullName)) {
      throw new WorkerHttpError(
        502,
        `GitHub repository ${index} full_name is not canonical`
      );
    }
    if (typeof isPrivate !== 'boolean') {
      throw new WorkerHttpError(
        502,
        `GitHub repository ${index} private must be boolean`
      );
    }
    if (seenIds.has(id)) {
      throw new WorkerHttpError(
        502,
        `GitHub repositories response contains duplicate id ${id}`
      );
    }
    const nameKey = fullName.toLowerCase();
    if (seenNames.has(nameKey)) {
      throw new WorkerHttpError(
        502,
        `GitHub repositories response contains duplicate name ${fullName}`
      );
    }
    seenIds.add(id);
    seenNames.add(nameKey);
    return { id, full_name: fullName, private: isPrivate };
  });
  return jsonResponse({ repositories }, 200, corsHeaders);
}

function decodeCanonicalPathSegment(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new WorkerHttpError(400, `${label} path segment is missing`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch (cause) {
    throw new WorkerHttpError(400, `${label} path segment is invalid`, {
      cause,
    });
  }
  if (!decoded || encodeURIComponent(decoded) !== value) {
    throw new WorkerHttpError(
      400,
      `${label} path segment is not canonically encoded`
    );
  }
  return decoded;
}

function requireProxyMethod(method, allowed, label) {
  if (!allowed.includes(method)) {
    throw new WorkerHttpError(
      405,
      `${label} supports only ${allowed.join(' or ')}`
    );
  }
}

function assertExactQuery(url, expected, label) {
  const expectedKeys = Object.keys(expected);
  const actualKeys = [...new Set(url.searchParams.keys())];
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !actualKeys.includes(key))
  ) {
    throw new WorkerHttpError(
      400,
      `${label} query must contain exactly ${expectedKeys.join(', ')}`
    );
  }
  const output = {};
  for (const key of expectedKeys) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1) {
      throw new WorkerHttpError(
        400,
        `${label} query field ${key} must occur exactly once`
      );
    }
    output[key] = values[0];
  }
  return output;
}

function assertNoQuery(url, label) {
  if (url.search !== '') {
    throw new WorkerHttpError(400, `${label} does not accept a query`);
  }
}

function assertPositiveQueryInteger(value, label) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new WorkerHttpError(400, `${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || `${parsed}` !== value) {
    throw new WorkerHttpError(400, `${label} must be a safe integer`);
  }
  return parsed;
}

function assertPullHead(value, label) {
  if (typeof value !== 'string') {
    throw new WorkerHttpError(400, `${label} must be a string`);
  }
  const colon = value.indexOf(':');
  if (colon < 1 || colon !== value.lastIndexOf(':')) {
    throw new WorkerHttpError(400, `${label} must equal owner:branch`);
  }
  const owner = value.slice(0, colon);
  const branch = value.slice(colon + 1);
  if (!isCanonicalGitHubAccount(owner) || !isCanonicalGitHubBranch(branch)) {
    throw new WorkerHttpError(400, `${label} must equal owner:branch`);
  }
  return value;
}

function assertAllowedGitHubProxyRoute(githubUrl, method) {
  const segments = githubUrl.pathname.split('/').slice(1);
  if (
    segments.length < 3 ||
    segments[0] !== 'repos'
  ) {
    throw new WorkerHttpError(
      404,
      'GitHub API proxy supports only exact repository operations'
    );
  }
  const owner = decodeCanonicalPathSegment(segments[1], 'Repository owner');
  const repo = decodeCanonicalPathSegment(segments[2], 'Repository name');
  if (!isCanonicalGitHubRepositoryFullName(`${owner}/${repo}`)) {
    throw new WorkerHttpError(
      400,
      'GitHub repository path must contain an exact owner/repository name'
    );
  }
  const rest = segments.slice(3);

  if (rest.length === 0) {
    requireProxyMethod(method, ['GET'], 'Repository metadata');
    assertNoQuery(githubUrl, 'Repository metadata');
    return { kind: 'repository-metadata' };
  }

  if (rest[0] === 'contents' && rest.length >= 2) {
    requireProxyMethod(method, ['GET', 'PUT'], 'Repository contents');
    const path = rest
      .slice(1)
      .map((segment) =>
        decodeCanonicalPathSegment(segment, 'Repository content')
      )
      .join('/');
    const isMutableAnnotationDocument =
      path === 'annotations/config.json' ||
      path === 'annotations/moderation/merges.json' ||
      GITHUB_USER_FILE.test(path);
    const isReadOnlySchema = GITHUB_READ_ONLY_SCHEMA_FILES.has(path);
    if (!isMutableAnnotationDocument && !isReadOnlySchema) {
      throw new WorkerHttpError(
        404,
        'GitHub contents proxy supports only current annotation documents and schemas'
      );
    }
    if (method === 'GET') {
      const query = assertExactQuery(
        githubUrl,
        { ref: true },
        'Repository contents'
      );
      if (!isCanonicalGitHubBranch(query.ref)) {
        throw new WorkerHttpError(
          400,
          'Repository contents ref must be an exact branch'
        );
      }
      return { kind: 'contents-get' };
    }
    if (isReadOnlySchema) {
      throw new WorkerHttpError(
        405,
        'Annotation schemas are read-only through the GitHub proxy'
      );
    }
    assertNoQuery(githubUrl, 'Repository contents mutation');
    return { kind: 'contents-put' };
  }

  if (rest[0] === 'git' && rest[1] === 'trees' && rest.length === 3) {
    requireProxyMethod(method, ['GET'], 'Git tree');
    const branch = decodeCanonicalPathSegment(rest[2], 'Git tree branch');
    if (!isCanonicalGitHubBranch(branch)) {
      throw new WorkerHttpError(400, 'Git tree branch is invalid');
    }
    const query = assertExactQuery(
      githubUrl,
      { recursive: true },
      'Git tree'
    );
    if (query.recursive !== '1') {
      throw new WorkerHttpError(400, 'Git tree recursive must equal 1');
    }
    return { kind: 'git-tree-get' };
  }

  if (rest[0] === 'git' && rest[1] === 'blobs' && rest.length === 3) {
    requireProxyMethod(method, ['GET'], 'Git blob');
    const sha = decodeCanonicalPathSegment(rest[2], 'Git blob SHA');
    if (!GITHUB_SHA.test(sha)) {
      throw new WorkerHttpError(
        400,
        'Git blob SHA must be exactly 40 lowercase hexadecimal characters'
      );
    }
    assertNoQuery(githubUrl, 'Git blob');
    return { kind: 'git-blob-get' };
  }

  if (
    rest[0] === 'git' &&
    rest[1] === 'ref' &&
    rest[2] === 'heads' &&
    rest.length >= 4
  ) {
    requireProxyMethod(method, ['GET'], 'Git branch reference');
    const branch = rest
      .slice(3)
      .map((segment) =>
        decodeCanonicalPathSegment(segment, 'Git branch reference')
      )
      .join('/');
    if (!isCanonicalGitHubBranch(branch)) {
      throw new WorkerHttpError(400, 'Git branch reference is invalid');
    }
    assertNoQuery(githubUrl, 'Git branch reference');
    return { kind: 'git-ref-get' };
  }

  if (
    rest.length === 2 &&
    rest[0] === 'git' &&
    rest[1] === 'refs'
  ) {
    requireProxyMethod(method, ['POST'], 'Git branch creation');
    assertNoQuery(githubUrl, 'Git branch creation');
    return { kind: 'git-refs-post' };
  }

  if (rest.length === 1 && rest[0] === 'forks') {
    requireProxyMethod(method, ['GET', 'POST'], 'Repository forks');
    if (method === 'GET') {
      const query = assertExactQuery(
        githubUrl,
        { per_page: true, page: true },
        'Repository forks'
      );
      if (query.per_page !== `${GITHUB_PAGE_SIZE}`) {
        throw new WorkerHttpError(
          400,
          `Repository forks per_page must equal ${GITHUB_PAGE_SIZE}`
        );
      }
      assertPositiveQueryInteger(query.page, 'Repository forks page');
      return { kind: 'forks-get' };
    }
    assertNoQuery(githubUrl, 'Repository fork creation');
    return { kind: 'forks-post' };
  }

  if (rest.length === 1 && rest[0] === 'pulls') {
    requireProxyMethod(method, ['GET', 'POST'], 'Repository Pull Requests');
    if (method === 'GET') {
      const query = assertExactQuery(
        githubUrl,
        { state: true, head: true, base: true, per_page: true },
        'Pull Request lookup'
      );
      if (query.state !== 'open') {
        throw new WorkerHttpError(
          400,
          'Pull Request lookup state must equal open'
        );
      }
      assertPullHead(query.head, 'Pull Request lookup head');
      if (!isCanonicalGitHubBranch(query.base)) {
        throw new WorkerHttpError(
          400,
          'Pull Request lookup base must be an exact branch'
        );
      }
      if (query.per_page !== `${GITHUB_PAGE_SIZE}`) {
        throw new WorkerHttpError(
          400,
          `Pull Request lookup per_page must equal ${GITHUB_PAGE_SIZE}`
        );
      }
      return { kind: 'pulls-get' };
    }
    assertNoQuery(githubUrl, 'Pull Request creation');
    return { kind: 'pulls-post' };
  }

  throw new WorkerHttpError(
    404,
    'GitHub API proxy does not expose this repository operation'
  );
}

function assertExactRequestFields(document, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(document);
  if (
    required.some((key) => !Object.hasOwn(document, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new WorkerHttpError(
      400,
      `${label} must contain required fields ${required.join(', ')} and only optional fields ${optional.join(', ')}`
    );
  }
  return document;
}

function assertExactSha(value, label) {
  if (typeof value !== 'string' || !GITHUB_SHA.test(value)) {
    throw new WorkerHttpError(
      400,
      `${label} must be exactly 40 lowercase hexadecimal characters`
    );
  }
  return value;
}

function assertCanonicalBase64(value, label) {
  assertExactString(value, label, { max: 8_000_000 });
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    throw new WorkerHttpError(400, `${label} must be canonical base64`);
  }
  return value;
}

function validateGitHubProxyMutationBody(kind, document) {
  if (kind === 'contents-put') {
    const body = assertExactRequestFields(
      document,
      ['message', 'content', 'branch'],
      ['sha'],
      'Repository contents mutation'
    );
    assertExactString(body.message, 'Repository contents message', {
      max: 256,
    });
    assertCanonicalBase64(body.content, 'Repository contents content');
    if (!isCanonicalGitHubBranch(body.branch)) {
      throw new WorkerHttpError(
        400,
        'Repository contents branch must be an exact branch'
      );
    }
    if (Object.hasOwn(body, 'sha')) {
      assertExactSha(body.sha, 'Repository contents sha');
    }
    return;
  }
  if (kind === 'git-refs-post') {
    assertExactFields(
      document,
      ['ref', 'sha'],
      'Git branch creation request'
    );
    if (
      typeof document.ref !== 'string' ||
      !document.ref.startsWith('refs/heads/') ||
      !isCanonicalGitHubBranch(document.ref.slice('refs/heads/'.length))
    ) {
      throw new WorkerHttpError(
        400,
        'Git branch creation ref must equal refs/heads/<exact branch>'
      );
    }
    assertExactSha(document.sha, 'Git branch creation sha');
    return;
  }
  if (kind === 'forks-post') {
    assertExactFields(document, [], 'Repository fork creation request');
    return;
  }
  if (kind === 'pulls-post') {
    assertExactFields(
      document,
      ['title', 'head', 'base', 'body', 'maintainer_can_modify'],
      'Pull Request creation request'
    );
    assertExactString(document.title, 'Pull Request title', { max: 256 });
    assertPullHead(document.head, 'Pull Request head');
    if (!isCanonicalGitHubBranch(document.base)) {
      throw new WorkerHttpError(
        400,
        'Pull Request base must be an exact branch'
      );
    }
    assertExactString(document.body, 'Pull Request body', { max: 65_536 });
    if (document.maintainer_can_modify !== true) {
      throw new WorkerHttpError(
        400,
        'Pull Request maintainer_can_modify must equal true'
      );
    }
    return;
  }
  throw new WorkerHttpError(
    400,
    'This GitHub proxy route does not accept a mutation body'
  );
}

function assertUpstreamRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerHttpError(502, `${label} must be a JSON object`);
  }
  return value;
}

function assertUpstreamBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new WorkerHttpError(502, `${label} must be boolean`);
  }
  return value;
}

function assertUpstreamPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WorkerHttpError(502, `${label} must be a positive safe integer`);
  }
  return value;
}

function assertUpstreamHttpsUrl(value, label) {
  assertExactString(value, label, { max: 2048, status: 502 });
  let parsed;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new WorkerHttpError(502, `${label} must be an exact HTTPS URL`, {
      cause,
    });
  }
  if (parsed.protocol !== 'https:' || parsed.toString() !== value) {
    throw new WorkerHttpError(502, `${label} must be an exact HTTPS URL`);
  }
  return value;
}

function projectRepositoryMetadata(document) {
  const repository = assertUpstreamRecord(
    document,
    'GitHub repository response'
  );
  const fullName = repository.full_name;
  if (!isCanonicalGitHubRepositoryFullName(fullName)) {
    throw new WorkerHttpError(
      502,
      'GitHub repository response.full_name must be canonical'
    );
  }
  const defaultBranch = repository.default_branch;
  if (!isCanonicalGitHubBranch(defaultBranch)) {
    throw new WorkerHttpError(
      502,
      'GitHub repository response.default_branch must be an exact branch'
    );
  }
  const permissions = assertUpstreamRecord(
    repository.permissions,
    'GitHub repository response.permissions'
  );
  return {
    full_name: fullName,
    default_branch: defaultBranch,
    private: assertUpstreamBoolean(
      repository.private,
      'GitHub repository response.private'
    ),
    allow_forking: assertUpstreamBoolean(
      repository.allow_forking,
      'GitHub repository response.allow_forking'
    ),
    permissions: {
      pull: assertUpstreamBoolean(
        permissions.pull,
        'GitHub repository response.permissions.pull'
      ),
      triage: assertUpstreamBoolean(
        permissions.triage,
        'GitHub repository response.permissions.triage'
      ),
      push: assertUpstreamBoolean(
        permissions.push,
        'GitHub repository response.permissions.push'
      ),
      maintain: assertUpstreamBoolean(
        permissions.maintain,
        'GitHub repository response.permissions.maintain'
      ),
      admin: assertUpstreamBoolean(
        permissions.admin,
        'GitHub repository response.permissions.admin'
      ),
    },
  };
}

function projectContentGet(document) {
  const content = assertUpstreamRecord(
    document,
    'GitHub contents response'
  );
  if (content.type !== 'file') {
    throw new WorkerHttpError(
      502,
      'GitHub contents response.type must equal file'
    );
  }
  if (content.encoding !== 'base64') {
    throw new WorkerHttpError(
      502,
      'GitHub contents response.encoding must equal base64'
    );
  }
  assertUpstreamBase64Payload(
    content.content,
    'GitHub contents response.content'
  );
  return {
    type: 'file',
    encoding: 'base64',
    content: content.content,
    sha: assertExactShaWithStatus(
      content.sha,
      'GitHub contents response.sha',
      502
    ),
  };
}

function assertUpstreamBase64Payload(value, label) {
  if (
    typeof value !== 'string' ||
    !value ||
    Array.from(value).length > 8_000_000
  ) {
    throw new WorkerHttpError(
      502,
      `${label} must be a nonempty base64 payload`
    );
  }
  const unfolded = value.replaceAll('\r\n', '').replaceAll('\n', '');
  if (
    !unfolded ||
    unfolded.includes('\r') ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      unfolded
    )
  ) {
    throw new WorkerHttpError(
      502,
      `${label} must be a valid base64 payload with optional line folding`
    );
  }
  return value;
}

function assertExactShaWithStatus(value, label, status) {
  if (typeof value !== 'string' || !GITHUB_SHA.test(value)) {
    throw new WorkerHttpError(
      status,
      `${label} must be exactly 40 lowercase hexadecimal characters`
    );
  }
  return value;
}

function projectContentPut(document) {
  const response = assertUpstreamRecord(
    document,
    'GitHub contents mutation response'
  );
  const content = assertUpstreamRecord(
    response.content,
    'GitHub contents mutation response.content'
  );
  return {
    content: {
      sha: assertExactShaWithStatus(
        content.sha,
        'GitHub contents mutation response.content.sha',
        502
      ),
    },
  };
}

function projectGitTree(document) {
  const response = assertUpstreamRecord(document, 'GitHub tree response');
  if (!Array.isArray(response.tree)) {
    throw new WorkerHttpError(502, 'GitHub tree response.tree must be an array');
  }
  if (response.tree.length > 100_000) {
    throw new WorkerHttpError(
      502,
      'GitHub tree response.tree exceeds 100000 entries'
    );
  }
  const tree = response.tree.map((raw, index) => {
    const entry = assertUpstreamRecord(raw, `GitHub tree entry ${index}`);
    if (entry.type !== 'blob' && entry.type !== 'tree') {
      throw new WorkerHttpError(
        502,
        `GitHub tree entry ${index}.type must equal blob or tree`
      );
    }
    assertExactString(entry.path, `GitHub tree entry ${index}.path`, {
      max: 4096,
      status: 502,
    });
    if (
      entry.path.startsWith('/') ||
      entry.path.endsWith('/') ||
      entry.path.split('/').some((segment) => !segment)
    ) {
      throw new WorkerHttpError(
        502,
        `GitHub tree entry ${index}.path is not canonical`
      );
    }
    return {
      type: entry.type,
      path: entry.path,
      sha: assertExactShaWithStatus(
        entry.sha,
        `GitHub tree entry ${index}.sha`,
        502
      ),
    };
  });
  return {
    tree,
    truncated: assertUpstreamBoolean(
      response.truncated,
      'GitHub tree response.truncated'
    ),
  };
}

function projectGitBlob(document) {
  const response = assertUpstreamRecord(document, 'GitHub blob response');
  if (response.encoding !== 'base64') {
    throw new WorkerHttpError(
      502,
      'GitHub blob response.encoding must equal base64'
    );
  }
  return {
    encoding: 'base64',
    content: assertUpstreamBase64Payload(
      response.content,
      'GitHub blob response.content'
    ),
  };
}

function projectGitRef(document) {
  const response = assertUpstreamRecord(
    document,
    'GitHub branch reference response'
  );
  const object = assertUpstreamRecord(
    response.object,
    'GitHub branch reference response.object'
  );
  return {
    object: {
      sha: assertExactShaWithStatus(
        object.sha,
        'GitHub branch reference response.object.sha',
        502
      ),
    },
  };
}

function projectForkRecord(document, label) {
  const fork = assertUpstreamRecord(document, label);
  if (!isCanonicalGitHubRepositoryFullName(fork.full_name)) {
    throw new WorkerHttpError(502, `${label}.full_name must be canonical`);
  }
  if (!isCanonicalGitHubRepositoryName(fork.name)) {
    throw new WorkerHttpError(502, `${label}.name must be canonical`);
  }
  const owner = assertUpstreamRecord(fork.owner, `${label}.owner`);
  if (!isCanonicalGitHubAccount(owner.login)) {
    throw new WorkerHttpError(502, `${label}.owner.login must be canonical`);
  }
  if (
    fork.full_name.toLowerCase() !==
    `${owner.login}/${fork.name}`.toLowerCase()
  ) {
    throw new WorkerHttpError(502, `${label} identity fields disagree`);
  }
  const projected = {
    full_name: fork.full_name,
    name: fork.name,
    owner: { login: owner.login },
  };
  if (fork.parent !== undefined) {
    const parent = assertUpstreamRecord(fork.parent, `${label}.parent`);
    if (!isCanonicalGitHubRepositoryFullName(parent.full_name)) {
      throw new WorkerHttpError(
        502,
        `${label}.parent.full_name must be canonical`
      );
    }
    projected.parent = { full_name: parent.full_name };
  }
  return projected;
}

function projectForks(document) {
  if (!Array.isArray(document)) {
    throw new WorkerHttpError(502, 'GitHub forks response must be an array');
  }
  if (document.length > GITHUB_PAGE_SIZE) {
    throw new WorkerHttpError(
      502,
      `GitHub forks response exceeds ${GITHUB_PAGE_SIZE} entries`
    );
  }
  return document.map((fork, index) =>
    projectForkRecord(fork, `GitHub fork ${index}`)
  );
}

function projectPullRequest(document, label) {
  const pullRequest = assertUpstreamRecord(document, label);
  return {
    number: assertUpstreamPositiveInteger(
      pullRequest.number,
      `${label}.number`
    ),
    html_url: assertUpstreamHttpsUrl(
      pullRequest.html_url,
      `${label}.html_url`
    ),
  };
}

function projectPullRequests(document) {
  if (!Array.isArray(document)) {
    throw new WorkerHttpError(
      502,
      'GitHub Pull Request lookup response must be an array'
    );
  }
  if (document.length > GITHUB_PAGE_SIZE) {
    throw new WorkerHttpError(
      502,
      `GitHub Pull Request lookup exceeds ${GITHUB_PAGE_SIZE} entries`
    );
  }
  return document.map((pullRequest, index) =>
    projectPullRequest(pullRequest, `GitHub Pull Request ${index}`)
  );
}

function projectGitHubProxyResponse(kind, document) {
  if (kind === 'repository-metadata') {
    return projectRepositoryMetadata(document);
  }
  if (kind === 'contents-get') return projectContentGet(document);
  if (kind === 'contents-put') return projectContentPut(document);
  if (kind === 'git-tree-get') return projectGitTree(document);
  if (kind === 'git-blob-get') return projectGitBlob(document);
  if (kind === 'git-ref-get') return projectGitRef(document);
  if (kind === 'git-refs-post') {
    assertUpstreamRecord(document, 'Git branch creation response');
    return {};
  }
  if (kind === 'forks-get') return projectForks(document);
  if (kind === 'forks-post') {
    return projectForkRecord(document, 'GitHub fork creation response');
  }
  if (kind === 'pulls-get') return projectPullRequests(document);
  if (kind === 'pulls-post') {
    return projectPullRequest(document, 'GitHub Pull Request creation response');
  }
  throw new WorkerHttpError(500, 'Unknown GitHub proxy response contract');
}

async function handleApiProxy(request, url, corsHeaders) {
  if (
    request.method !== 'GET' &&
    request.method !== 'POST' &&
    request.method !== 'PUT'
  ) {
    throw new WorkerHttpError(
      405,
      `GitHub API proxy does not support ${request.method}`
    );
  }
  const token = getBearerToken(request);
  const githubPath = url.pathname.slice('/api'.length);
  if (!githubPath.startsWith('/repos/')) {
    throw new WorkerHttpError(
      404,
      'GitHub API proxy supports only /api/repos/*'
    );
  }
  const githubUrl = new URL(githubPath, GITHUB_API_ORIGIN);
  githubUrl.search = url.search;
  if (
    githubUrl.origin !== GITHUB_API_ORIGIN ||
    !githubUrl.pathname.startsWith('/repos/')
  ) {
    throw new WorkerHttpError(400, 'Invalid GitHub repository API path');
  }
  const route = assertAllowedGitHubProxyRoute(githubUrl, request.method);

  const headers = createGitHubHeaders(token);
  let body;
  if (request.method !== 'GET') {
    const document = await readExactRequestObject(
      request,
      'GitHub API proxy request'
    );
    validateGitHubProxyMutationBody(route.kind, document);
    body = JSON.stringify(document);
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetchGitHub(
    githubUrl,
    {
      method: request.method,
      headers,
      body,
    },
    `GitHub API ${request.method} ${githubPath}`
  );
  const document = await parseResponseJson(
    response,
    `GitHub API ${request.method} ${githubPath} response`
  );
  if (!response.ok) {
    return jsonResponse(
      {
        error: upstreamErrorMessage(
          document,
          `GitHub API ${request.method} ${githubPath} failed`
        ),
      },
      response.status,
      corsHeaders
    );
  }
  return jsonResponse(
    projectGitHubProxyResponse(route.kind, document),
    response.status,
    corsHeaders
  );
}

function createGitHubHeaders(token) {
  return new Headers({
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'Cellucid-GitHub-App',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  });
}

async function githubFetchJson(path, token) {
  const response = await fetchGitHub(
    `${GITHUB_API_ORIGIN}${path}`,
    { headers: createGitHubHeaders(token) },
    `GitHub API GET ${path}`
  );
  const document = await parseResponseJson(
    response,
    `GitHub API GET ${path} response`
  );
  return { response, document };
}

async function githubFetchCollection(path, token, field) {
  let page = 1;
  let totalCount = null;
  const items = [];

  while (true) {
    const separator = path.includes('?') ? '&' : '?';
    const pagePath =
      `${path}${separator}per_page=${GITHUB_PAGE_SIZE}&page=${page}`;
    const { response, document } = await githubFetchJson(pagePath, token);
    if (!response.ok) {
      return { response, errorDocument: document, items: null };
    }

    const pageTotal = document?.total_count;
    const pageItems = document?.[field];
    if (!Number.isSafeInteger(pageTotal) || pageTotal < 0) {
      throw new WorkerHttpError(
        502,
        `GitHub ${field} response has an invalid total_count`
      );
    }
    if (!Array.isArray(pageItems)) {
      throw new WorkerHttpError(
        502,
        `GitHub ${field} response is missing ${field}`
      );
    }
    if (totalCount === null) {
      totalCount = pageTotal;
    } else if (pageTotal !== totalCount) {
      throw new WorkerHttpError(
        502,
        `GitHub ${field} total_count changed during pagination`
      );
    }
    if (pageItems.length > GITHUB_PAGE_SIZE) {
      throw new WorkerHttpError(
        502,
        `GitHub ${field} page exceeds ${GITHUB_PAGE_SIZE} items`
      );
    }

    items.push(...pageItems);
    if (items.length > totalCount) {
      throw new WorkerHttpError(
        502,
        `GitHub ${field} response exceeds total_count`
      );
    }
    if (items.length === totalCount) {
      return { response, errorDocument: null, items };
    }
    if (pageItems.length === 0) {
      throw new WorkerHttpError(
        502,
        `GitHub ${field} pagination ended before total_count`
      );
    }
    page += 1;
  }
}

async function fetchGitHub(url, options, label) {
  if (typeof AbortController !== 'function') {
    throw new WorkerHttpError(
      500,
      'AbortController is required by the GitHub worker'
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    GITHUB_REQUEST_TIMEOUT_MS
  );
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (cause) {
    if (cause?.name === 'AbortError') {
      throw new WorkerHttpError(
        504,
        `${label} timed out after ${GITHUB_REQUEST_TIMEOUT_MS}ms`,
        { cause }
      );
    }
    throw new WorkerHttpError(
      502,
      `${label} could not be reached`,
      { cause }
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function parseResponseJson(response, label) {
  const text = await response.text();
  if (!text) {
    throw new WorkerHttpError(502, `${label} is empty`);
  }
  try {
    return parseExactJson(text, { path: label });
  } catch (cause) {
    throw new WorkerHttpError(502, `${label} contains invalid JSON`, {
      cause,
    });
  }
}
