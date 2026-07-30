/**
 * GitHub App OAuth session (via Cloudflare Worker).
 *
 * - Starts OAuth via full-page redirect to `${WORKER_ORIGIN}/auth/login`
 * - Worker redirects back to the app with token in URL fragment
 * - Stores token in `sessionStorage` (never `localStorage`)
 * - Fetches user identity from `${WORKER_ORIGIN}/auth/user`
 *
 * This module is UI-agnostic (no DOM writes).
 */

import { EventEmitter } from '../utils/event-emitter.js';
import { isLocalDevHost } from '../utils/local-dev.js';
import { parseExactJson } from './wire-contract.js';
import {
  isCanonicalGitHubAccount,
  isCanonicalGitHubRepositoryFullName,
} from './github-reference.js';

const DEFAULT_WORKER_ORIGIN = 'https://cellucid-github-auth.benkemalim.workers.dev';

const SESSION_KEY = 'cellucid:github-app-auth:session';

const AUTH_FLAG_PARAM = 'cellucid_github_auth';
const AUTH_TOKEN_PARAM = 'cellucid_github_token';
const AUTH_ERROR_PARAM = 'cellucid_github_error';

const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_AUTH_RESPONSE_MAX_BYTES = 5_000_000;
const GITHUB_COLLECTION_MAX_ITEMS = 10_000;
const WORKER_CAPABILITY_MAX_BYTES = 16_384;
const WORKER_SERVICE = 'Cellucid GitHub Auth';
const WORKER_CONTRACT_VERSION = 1;
const WORKER_ENDPOINTS = Object.freeze([
  '/auth/login',
  '/auth/callback',
  '/auth/user',
  '/auth/installations',
  '/auth/installation-repos',
  '/cap/lookup-cells',
  '/cap/search-datasets',
  '/api/repos/*',
]);

function assertTimeoutMs(timeoutMs) {
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    throw new Error('GitHub request timeout must be a positive safe integer');
  }
  return timeoutMs;
}

function isAbortError(err) {
  return err?.name === 'AbortError';
}

function assertAbortSignalOrNull(signal) {
  if (
    signal !== null &&
    (
      typeof signal !== 'object' ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function'
    )
  ) {
    throw new TypeError(
      'GitHub authentication request signal must be an AbortSignal or exact null'
    );
  }
  return signal;
}

function createRequestAbortScope(signal, timeoutMs) {
  const ownerSignal = assertAbortSignalOrNull(signal);
  const ms = assertTimeoutMs(timeoutMs);
  if (typeof AbortController !== 'function') {
    throw new Error('AbortController is required for GitHub annotation requests');
  }
  const controller = new AbortController();
  let abortCause = null;
  const abortWithCause = (cause) => {
    if (abortCause === null) abortCause = cause;
    controller.abort();
  };
  const abortFromOwner = () => abortWithCause('owner');
  if (ownerSignal !== null) {
    if (ownerSignal.aborted) abortFromOwner();
    else ownerSignal.addEventListener('abort', abortFromOwner, { once: true });
  }

  let timeout;
  try {
    timeout = setTimeout(() => {
      abortWithCause('timeout');
    }, ms);
  } catch (error) {
    try {
      ownerSignal?.removeEventListener('abort', abortFromOwner);
    } catch {
      // Timer creation remains the authoritative setup failure.
    }
    throw error;
  }

  return {
    abortCause: () => abortCause,
    controller,
    ownerSignal,
    timeoutMs: ms,
    cleanup() {
      try {
        clearTimeout(timeout);
      } catch {
        // Cleanup cannot replace the authoritative request outcome.
      }
      try {
        ownerSignal?.removeEventListener('abort', abortFromOwner);
      } catch {
        // Cleanup cannot replace the authoritative request outcome.
      }
    },
  };
}

function createRequestAbortedError(url, cause = undefined) {
  const error = new Error('GitHub authentication request was cancelled');
  error.name = 'AbortError';
  error.code = 'GITHUB_REQUEST_ABORTED';
  if (url !== null) error.url = url;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function throwIfRequestAborted(scope, url, cause = undefined) {
  const abortCause = scope.abortCause();
  if (abortCause === 'owner') {
    throw createRequestAbortedError(
      url,
      cause ?? scope.ownerSignal.reason
    );
  }
  if (abortCause === 'timeout') {
    const error = new Error(
      `Request timed out after ${Math.max(
        1,
        Math.round(scope.timeoutMs / 1000)
      )}s`
    );
    error.code = 'TIMEOUT';
    error.url = url;
    if (cause !== undefined) error.cause = cause;
    throw error;
  }
}

function createAuthSupersededError(cause = undefined) {
  const error = new Error(
    'GitHub authentication request belongs to a superseded session'
  );
  error.code = 'GITHUB_AUTH_SUPERSEDED';
  if (cause !== undefined) error.cause = cause;
  return error;
}

function reportAuthListenerFailures(errors) {
  if (errors.length === 0) return;
  let failure = errors.length === 1
    ? errors[0]
    : new AggregateError(
      errors,
      'Multiple GitHub authentication change listeners failed'
    );
  if (typeof globalThis.reportError === 'function') {
    try {
      globalThis.reportError(failure);
      return;
    } catch (reportingFailure) {
      failure = new AggregateError(
        [failure, reportingFailure],
        'GitHub authentication listener and error reporting both failed'
      );
    }
  }
  if (typeof globalThis.console?.error === 'function') {
    globalThis.console.error(
      '[Cellucid] GitHub authentication change listener failed',
      failure
    );
    return;
  }
  throw failure;
}

function assertExactHttpOrigin(raw, label) {
  if (
    typeof raw !== 'string' ||
    !raw ||
    /^\s|\s$/.test(raw)
  ) {
    throw new Error(`${label} must be an exact nonblank HTTP(S) origin`);
  }
  let url;
  try {
    url = new URL(raw);
  } catch (cause) {
    const error = new Error(
      `${label} must be an exact nonblank HTTP(S) origin`
    );
    error.cause = cause;
    throw error;
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    raw !== url.origin
  ) {
    throw new Error(`${label} must be an exact nonblank HTTP(S) origin`);
  }
  return raw;
}

function storageFailure(kind, operation, cause) {
  const error = new Error(
    `${kind} ${operation} failed for the GitHub annotation session`
  );
  error.code = 'GITHUB_AUTH_STORAGE_FAILED';
  error.cause = cause;
  return error;
}

function assertWorkerErrorDocument(value, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'error') ||
    typeof value.error !== 'string' ||
    !value.error ||
    /^\s|\s$/.test(value.error) ||
    Array.from(value.error).length > 4096
  ) {
    throw new Error(`${label} must contain exactly one exact error string`);
  }
  return value.error;
}

function assertWorkerCompatibilityDocument(value) {
  assertExactObjectKeys(
    value,
    ['status', 'service', 'contractVersion', 'endpoints'],
    'GitHub worker capability response'
  );
  if (
    value.status !== 'ok' ||
    value.service !== WORKER_SERVICE ||
    value.contractVersion !== WORKER_CONTRACT_VERSION
  ) {
    throw new Error(
      'GitHub worker capability status, service, or contract version is stale'
    );
  }
  if (
    !Array.isArray(value.endpoints) ||
    value.endpoints.length !== WORKER_ENDPOINTS.length ||
    value.endpoints.some(
      (endpoint, index) => endpoint !== WORKER_ENDPOINTS[index]
    )
  ) {
    throw new Error(
      'GitHub worker endpoint inventory does not match this Cellucid client'
    );
  }
  return value;
}

function createWorkerIncompatibleError(origin, cause) {
  const error = new Error(
    `The GitHub community annotation service at ${origin} is not compatible ` +
    'with this Cellucid client. No GitHub token was sent and sign-in was not ' +
    'started.\n\nDeploy the current Cellucid Worker, verify its root endpoint ' +
    'inventory, and ensure this site origin is present in ALLOWED_ORIGINS.'
  );
  error.code = 'GITHUB_WORKER_INCOMPATIBLE';
  error.origin = origin;
  error.cause = cause;
  return error;
}

export function getGitHubWorkerOrigin() {
  if (typeof window === 'undefined') return DEFAULT_WORKER_ORIGIN;
  const overrideRaw = window.__CELLUCID_GITHUB_WORKER_ORIGIN__;
  if (overrideRaw === undefined) {
    return DEFAULT_WORKER_ORIGIN;
  }

  let overrideOrigin;
  try {
    overrideOrigin = assertExactHttpOrigin(
      overrideRaw,
      'GitHub worker origin override'
    );
  } catch (cause) {
    const err = new Error('Invalid GitHub worker origin override. Refusing to continue.');
    err.code = 'GITHUB_WORKER_ORIGIN_INVALID';
    err.cause = cause;
    throw err;
  }

  // Dev safety rule:
  // - Local dev may point at any worker origin (for testing).
  // - Non-local builds must use the compiled-in DEFAULT_WORKER_ORIGIN (prevents token exfiltration via misconfig).
  if (!isLocalDevHost() && overrideOrigin !== DEFAULT_WORKER_ORIGIN) {
    const err = new Error(
      `Untrusted GitHub worker origin override: ${overrideOrigin}\n` +
      `Expected: ${DEFAULT_WORKER_ORIGIN}\n\n` +
      'Refusing to use an untrusted auth proxy to prevent token exfiltration.'
    );
    err.code = 'GITHUB_WORKER_ORIGIN_UNTRUSTED';
    err.origin = overrideOrigin;
    throw err;
  }

  return overrideOrigin;
}

function readSessionItem(key) {
  try {
    if (typeof sessionStorage === 'undefined') {
      throw new Error('sessionStorage is unavailable');
    }
    return sessionStorage.getItem(key);
  } catch (cause) {
    throw storageFailure('sessionStorage', 'read', cause);
  }
}

function writeSessionItem(key, value) {
  try {
    if (typeof sessionStorage === 'undefined') {
      throw new Error('sessionStorage is unavailable');
    }
    sessionStorage.setItem(key, value);
    return true;
  } catch (cause) {
    throw storageFailure('sessionStorage', 'write', cause);
  }
}

function removeSessionItem(key) {
  try {
    if (typeof sessionStorage === 'undefined') {
      throw new Error('sessionStorage is unavailable');
    }
    sessionStorage.removeItem(key);
    return true;
  } catch (cause) {
    throw storageFailure('sessionStorage', 'remove', cause);
  }
}

function authResponseTooLarge(url, maxResponseBytes) {
  const error = new Error(
    `GitHub authentication response exceeds ${maxResponseBytes} bytes`
  );
  error.code = 'GITHUB_AUTH_RESPONSE_TOO_LARGE';
  error.url = url;
  return error;
}

async function cancelAuthResponseBody(response) {
  if (typeof response?.body?.cancel !== 'function') return;
  try {
    await response.body.cancel();
  } catch {
    // The response-validation failure remains authoritative.
  }
}

function knownAuthResponseByteLength(response) {
  const raw = response?.headers?.get?.('content-length') ?? null;
  if (raw === null || raw === '' || !/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.POSITIVE_INFINITY;
}

async function fetchJson(url, {
  method = 'GET',
  headers = null,
  body = null,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  signal = null,
  maxResponseBytes = DEFAULT_AUTH_RESPONSE_MAX_BYTES,
} = {}) {
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1
  ) {
    throw new TypeError(
      'GitHub authentication response limit must be a positive safe integer'
    );
  }
  const scope = createRequestAbortScope(signal, timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: headers || undefined,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: scope.controller.signal,
    });
    throwIfRequestAborted(scope, url);

    const knownByteLength = knownAuthResponseByteLength(res);
    if (
      knownByteLength !== null &&
      knownByteLength > maxResponseBytes
    ) {
      const primary = authResponseTooLarge(url, maxResponseBytes);
      await cancelAuthResponseBody(res);
      throw primary;
    }

    const decodedChunks = [];
    let byteLength = 0;
    if (res.body !== null) {
      if (typeof res.body.getReader !== 'function') {
        await cancelAuthResponseBody(res);
        throw new TypeError(
          'GitHub authentication response body must expose a stream reader'
        );
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder(
        'utf-8',
        { fatal: true, ignoreBOM: true }
      );
      let streamDone = false;
      let readerCancelled = false;
      const cancelLiveReader = async () => {
        if (streamDone || readerCancelled) return;
        readerCancelled = true;
        try {
          await reader.cancel();
        } catch {
          // The response-validation failure remains authoritative.
        }
      };
      try {
        while (true) {
          const part = await reader.read();
          throwIfRequestAborted(scope, url);
          if (part.done) {
            streamDone = true;
            try {
              decodedChunks.push(decoder.decode());
            } catch (cause) {
              const error = new Error(
                'GitHub authentication response is not valid UTF-8'
              );
              error.code = 'GITHUB_AUTH_RESPONSE_INVALID';
              error.url = url;
              error.cause = cause;
              throw error;
            }
            break;
          }
          if (!(part.value instanceof Uint8Array)) {
            const error = new TypeError(
              'GitHub authentication response chunks must be Uint8Array values'
            );
            await cancelLiveReader();
            throw error;
          }
          byteLength += part.value.byteLength;
          if (byteLength > maxResponseBytes) {
            const primary = authResponseTooLarge(url, maxResponseBytes);
            await cancelLiveReader();
            throw primary;
          }
          try {
            decodedChunks.push(decoder.decode(part.value, { stream: true }));
          } catch (cause) {
            const error = new Error(
              'GitHub authentication response is not valid UTF-8'
            );
            error.code = 'GITHUB_AUTH_RESPONSE_INVALID';
            error.url = url;
            error.cause = cause;
            await cancelLiveReader();
            throw error;
          }
        }
      } catch (error) {
        let primary = error;
        try {
          throwIfRequestAborted(scope, url, error);
        } catch (abortError) {
          primary = abortError;
        }
        await cancelLiveReader();
        throw primary;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // A settled response reader may already have released its lock.
        }
      }
    }
    const text = decodedChunks.join('');
    throwIfRequestAborted(scope, url);
    let responseJson;
    try {
      if (!text) throw new Error('empty response body');
      responseJson = parseExactJson(text, {
        path: `GitHub annotation endpoint ${url}`,
      });
    } catch (cause) {
      const error = new Error(
        `GitHub annotation endpoint returned invalid JSON: ${cause?.message || cause}`
      );
      error.status = res.status;
      error.url = url;
      error.cause = cause;
      throw error;
    }
    if (!res.ok) {
      const msg = assertWorkerErrorDocument(
        responseJson,
        `GitHub annotation endpoint ${url} error response`
      );
      const err = new Error(msg);
      err.status = res.status;
      err.url = url;
      throw err;
    }
    return responseJson;
  } catch (err) {
    if (isAbortError(err) || scope.controller.signal.aborted) {
      throwIfRequestAborted(scope, url, err);
      throw createRequestAbortedError(url, err);
    }
    throw err;
  } finally {
    scope.cleanup();
  }
}

export function getGitHubLoginUrl(workerOrigin = null) {
  const rawOrigin = workerOrigin === null
    ? getGitHubWorkerOrigin()
    : workerOrigin;
  const origin = assertExactHttpOrigin(rawOrigin, 'GitHub worker origin');
  return `${origin}/auth/login`;
}

export function toGitHubUserKey(user) {
  if (user === null) return null;
  const exactUser = assertStoredGitHubUser(user);
  return `ghid_${exactUser.id}`;
}

function assertStoredGitHubUser(user) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    throw new Error('Stored GitHub user must be an object');
  }
  if (!Number.isSafeInteger(user.id) || user.id < 1) {
    throw new Error('Stored GitHub user id must be a positive safe integer');
  }
  assertGitHubLogin(user.login, 'Stored GitHub user login');
  if (
    Object.keys(user).length !== 2 ||
    !Object.hasOwn(user, 'id') ||
    !Object.hasOwn(user, 'login')
  ) {
    throw new Error('Stored GitHub user must contain exactly id and login');
  }
  return user;
}

function assertExactObjectKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} must contain exactly ${keys.join(', ')}`);
  }
  return value;
}

function assertGitHubUserResponse(user) {
  assertExactObjectKeys(user, ['id', 'login'], 'GitHub user endpoint');
  return assertStoredGitHubUser(user);
}

function assertGitHubLogin(login, label) {
  if (
    typeof login !== 'string' ||
    !login ||
    /^\s|\s$/.test(login) ||
    Array.from(login).length > 64 ||
    !isCanonicalGitHubAccount(login)
  ) {
    throw new Error(`${label} must be an exact nonblank string`);
  }
  return login;
}

function assertInstallationsResponse(document) {
  assertExactObjectKeys(
    document,
    ['installations'],
    'GitHub installations endpoint'
  );
  if (
    !Array.isArray(document.installations) ||
    document.installations.length > GITHUB_COLLECTION_MAX_ITEMS
  ) {
    throw new Error(
      `GitHub installations endpoint installations must be an array of at ` +
      `most ${GITHUB_COLLECTION_MAX_ITEMS} items`
    );
  }
  const seenIds = new Set();
  const seenAccounts = new Set();
  const installations = document.installations.map((installation, index) => {
    assertExactObjectKeys(
      installation,
      ['id', 'account'],
      `GitHub installation ${index}`
    );
    if (!Number.isSafeInteger(installation.id) || installation.id < 1) {
      throw new Error(
        `GitHub installation ${index} id must be a positive safe integer`
      );
    }
    assertExactObjectKeys(
      installation.account,
      ['login'],
      `GitHub installation ${index} account`
    );
    const login = assertGitHubLogin(
      installation.account.login,
      `GitHub installation ${index} account login`
    );
    const accountKey = login.toLowerCase();
    if (seenIds.has(installation.id) || seenAccounts.has(accountKey)) {
      throw new Error('GitHub installations endpoint contains duplicate entries');
    }
    seenIds.add(installation.id);
    seenAccounts.add(accountKey);
    return { id: installation.id, account: { login } };
  });
  return { installations };
}

function assertRepositoryFullName(fullName, label) {
  if (!isCanonicalGitHubRepositoryFullName(fullName)) {
    throw new Error(`${label} must be an exact owner/repository name`);
  }
  return fullName;
}

function assertInstallationRepositoriesResponse(document) {
  assertExactObjectKeys(
    document,
    ['repositories'],
    'GitHub installation repositories endpoint'
  );
  if (
    !Array.isArray(document.repositories) ||
    document.repositories.length > GITHUB_COLLECTION_MAX_ITEMS
  ) {
    throw new Error(
      `GitHub installation repositories endpoint repositories must be an ` +
      `array of at most ${GITHUB_COLLECTION_MAX_ITEMS} items`
    );
  }
  const seenIds = new Set();
  const seenNames = new Set();
  const repositories = document.repositories.map((repository, index) => {
    assertExactObjectKeys(
      repository,
      ['id', 'full_name', 'private'],
      `GitHub installation repository ${index}`
    );
    if (!Number.isSafeInteger(repository.id) || repository.id < 1) {
      throw new Error(
        `GitHub installation repository ${index} id must be a positive safe integer`
      );
    }
    const fullName = assertRepositoryFullName(
      repository.full_name,
      `GitHub installation repository ${index} full_name`
    );
    if (typeof repository.private !== 'boolean') {
      throw new Error(
        `GitHub installation repository ${index} private must be boolean`
      );
    }
    const nameKey = fullName.toLowerCase();
    if (seenIds.has(repository.id) || seenNames.has(nameKey)) {
      throw new Error(
        'GitHub installation repositories endpoint contains duplicate entries'
      );
    }
    seenIds.add(repository.id);
    seenNames.add(nameKey);
    return {
      id: repository.id,
      full_name: fullName,
      private: repository.private,
    };
  });
  return { repositories };
}

const AUTH_FRAGMENT_PARAM_NAMES = new Set([
  AUTH_FLAG_PARAM,
  AUTH_TOKEN_PARAM,
  AUTH_ERROR_PARAM,
]);

function readFragmentParamName(segment, index) {
  // Decode only the field name. Retaining the raw segment prevents unrelated
  // fragment bytes and separators from being normalized during auth cleanup.
  let candidate = segment;
  if (index === 0 && candidate.startsWith('?')) {
    candidate = candidate.slice(1);
  }
  if (!candidate) return null;
  const separatorIndex = candidate.indexOf('=');
  const rawName =
    separatorIndex === -1
      ? candidate
      : candidate.slice(0, separatorIndex);
  const probe = new URLSearchParams(`__cellucid_probe__=&${rawName}=`);
  const names = probe.keys();
  names.next();
  return names.next().value ?? null;
}

function scrubAuthFragment(hash) {
  const segments = hash.split('&');
  let ownsFragment = false;
  const retained = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const name = readFragmentParamName(segment, index);
    if (name !== null && AUTH_FRAGMENT_PARAM_NAMES.has(name)) {
      ownsFragment = true;
      continue;
    }
    retained.push(segment);
  }
  return {
    ownsFragment,
    cleanedHash: retained.join('&'),
    hasRetainedSegments: retained.length > 0,
  };
}

function validateAuthFragment(params) {
  const flags = params.getAll(AUTH_FLAG_PARAM);
  if (flags.length !== 1 || flags[0] !== '1') {
    throw new Error('GitHub auth callback flag must occur once with value "1"');
  }
  const tokens = params.getAll(AUTH_TOKEN_PARAM);
  const errors = params.getAll(AUTH_ERROR_PARAM);
  if (
    tokens.length > 1 ||
    errors.length > 1 ||
    (tokens.length === 0) === (errors.length === 0)
  ) {
    throw new Error(
      'GitHub auth callback must contain exactly one token or one error'
    );
  }
  const token = tokens.length ? tokens[0] : null;
  const error = errors.length ? errors[0] : null;
  if (token !== null && (!token || /^\s|\s$/.test(token))) {
    throw new Error('GitHub auth callback token must be an exact nonblank string');
  }
  if (error !== null && (!error || /^\s|\s$/.test(error))) {
    throw new Error('GitHub auth callback error must be an exact nonblank string');
  }
  return { token, error };
}

function readAuthResultFromUrl(urlString) {
  if (typeof window === 'undefined') return null;
  const candidate =
    urlString === null || urlString === undefined || urlString === ''
      ? window.location?.href
      : urlString;
  if (typeof candidate !== 'string') {
    throw new Error('GitHub auth callback URL must be a string');
  }
  const href = candidate;
  if (!href) return null;

  /** @type {URL} */
  let url;
  try {
    url = new URL(href);
  } catch (cause) {
    const error = new Error('GitHub auth callback URL is invalid');
    error.cause = cause;
    throw error;
  }

  const hash = String(url.hash || '').replace(/^#/, '');
  if (!hash) return null;

  const {
    ownsFragment,
    cleanedHash,
    hasRetainedSegments,
  } = scrubAuthFragment(hash);
  if (!ownsFragment) return null;

  const params = new URLSearchParams(hash);
  const cleanedUrl =
    `${url.origin}${url.pathname}${url.search}` +
    `${hasRetainedSegments ? `#${cleanedHash}` : ''}`;

  try {
    const { token, error } = validateAuthFragment(params);
    return { token, error, cleanedUrl, validationError: null };
  } catch (validationError) {
    return { token: null, error: null, cleanedUrl, validationError };
  }
}

export class GitHubAuthSession extends EventEmitter {
  constructor() {
    super();
    if (typeof AbortController !== 'function') {
      throw new Error('AbortController is required for GitHub annotation requests');
    }
    this._requestGeneration = 0;
    this._generationAbort = new AbortController();
    this._verifiedWorkerOrigin = null;
    this._token = null;
    this._user = null;
    this._loadFromSessionStorage();
  }

  _advanceRequestGeneration() {
    const retiredAbort = this._generationAbort;
    const nextGeneration = this._requestGeneration + 1;
    this._requestGeneration = nextGeneration;
    this._generationAbort = new AbortController();
    retiredAbort.abort();
    return nextGeneration;
  }

  _createRequestOwner(
    signal = null,
    token = this._token,
    { candidate = false } = {}
  ) {
    const callerSignal = assertAbortSignalOrNull(signal);
    const sessionSignal = this._generationAbort.signal;
    const owner = {
      candidate,
      callerSignal,
      generation: this._requestGeneration,
      getAbortCause: () => (
        sessionSignal.aborted ? 'session' : null
      ),
      token,
      sessionSignal,
      signal: sessionSignal,
      cleanup: () => {},
    };
    if (callerSignal === null) return owner;

    const controller = new AbortController();
    let abortCause = null;
    const abortWithCause = (cause) => {
      if (abortCause === null) abortCause = cause;
      controller.abort();
    };
    const abortFromSession = () => abortWithCause('session');
    const abortFromCaller = () => abortWithCause('caller');
    if (sessionSignal.aborted) abortFromSession();
    else sessionSignal.addEventListener('abort', abortFromSession, { once: true });
    if (callerSignal.aborted) abortFromCaller();
    else callerSignal.addEventListener('abort', abortFromCaller, { once: true });
    owner.getAbortCause = () => abortCause;
    owner.signal = controller.signal;
    owner.cleanup = () => {
      sessionSignal.removeEventListener('abort', abortFromSession);
      callerSignal.removeEventListener('abort', abortFromCaller);
    };
    return owner;
  }

  _isRequestOwnerCurrent(owner) {
    return (
      owner.generation === this._requestGeneration &&
      owner.sessionSignal === this._generationAbort.signal &&
      !owner.sessionSignal.aborted &&
      (owner.candidate || owner.token === this._token)
    );
  }

  _assertRequestOwnerCurrent(owner, cause = undefined) {
    if (cause?.code === 'TIMEOUT') return;
    const abortCause = owner.getAbortCause();
    if (
      abortCause === 'caller' ||
      (
        abortCause === null &&
        owner.callerSignal?.aborted &&
        !owner.sessionSignal.aborted
      )
    ) {
      throw createRequestAbortedError(cause?.url ?? null, cause);
    }
    if (!this._isRequestOwnerCurrent(owner)) {
      throw createAuthSupersededError(cause);
    }
  }

  _emitChanged() {
    const generation = this._requestGeneration;
    const token = this._token;
    const user = this._user;
    const listeners = this._listeners.get('changed');
    if (listeners === undefined) return true;

    const errors = [];
    for (const callback of [...listeners]) {
      try {
        callback({
          token,
          user: user === null ? null : { ...user },
        });
      } catch (error) {
        errors.push(error);
      }
      if (
        generation !== this._requestGeneration ||
        token !== this._token ||
        user !== this._user
      ) {
        break;
      }
    }
    reportAuthListenerFailures(errors);
    return (
      generation === this._requestGeneration &&
      token === this._token &&
      user === this._user
    );
  }

  _loadFromSessionStorage() {
    const rawSession = readSessionItem(SESSION_KEY);
    if (rawSession === null) {
      this._token = null;
      this._user = null;
      return;
    }
    const session = parseExactJson(rawSession, {
      path: 'GitHub auth session',
    });
    assertExactObjectKeys(
      session,
      ['token', 'user'],
      'Stored GitHub auth session'
    );
    if (
      typeof session.token !== 'string' ||
      !session.token ||
      /^\s|\s$/.test(session.token)
    ) {
      throw new Error('Stored GitHub token must be an exact nonblank string');
    }
    this._token = session.token;
    this._user = Object.freeze({ ...assertStoredGitHubUser(session.user) });
  }

  _persistAuthenticatedState(token, user) {
    if (
      typeof token !== 'string' ||
      !token ||
      /^\s|\s$/.test(token)
    ) {
      throw new Error(
        'GitHub auth session requires one exact token and user identity'
      );
    }
    writeSessionItem(
      SESSION_KEY,
      JSON.stringify({
        token,
        user: assertStoredGitHubUser(user),
      })
    );
  }

  async _fetchUserForOwner(owner) {
    const workerOrigin = this.getWorkerOrigin();
    if (this._verifiedWorkerOrigin !== workerOrigin) {
      await this._verifyWorkerForOwner(owner);
    }
    this._assertRequestOwnerCurrent(owner);
    const url = `${workerOrigin}/auth/user`;
    let userResponse;
    try {
      userResponse = await fetchJson(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${owner.token}` },
        signal: owner.signal,
      });
    } catch (error) {
      this._assertRequestOwnerCurrent(owner, error);
      throw error;
    }
    this._assertRequestOwnerCurrent(owner);
    return Object.freeze({
      ...assertGitHubUserResponse(userResponse),
    });
  }

  async _verifyWorkerForOwner(owner) {
    const workerOrigin = this.getWorkerOrigin();
    if (this._verifiedWorkerOrigin === workerOrigin) {
      this._assertRequestOwnerCurrent(owner);
      return true;
    }
    let response;
    try {
      response = await fetchJson(`${workerOrigin}/`, {
        method: 'GET',
        signal: owner.signal,
        maxResponseBytes: WORKER_CAPABILITY_MAX_BYTES,
      });
      this._assertRequestOwnerCurrent(owner);
      assertWorkerCompatibilityDocument(response);
    } catch (error) {
      this._assertRequestOwnerCurrent(owner, error);
      if (
        error?.code === 'GITHUB_REQUEST_ABORTED' ||
        error?.code === 'GITHUB_AUTH_SUPERSEDED'
      ) {
        throw error;
      }
      throw createWorkerIncompatibleError(workerOrigin, error);
    }
    this._assertRequestOwnerCurrent(owner);
    this._verifiedWorkerOrigin = workerOrigin;
    return true;
  }

  _publishAuthenticatedOwner(owner, user) {
    this._assertRequestOwnerCurrent(owner);
    let publicationGeneration = owner.generation;
    if (owner.candidate) {
      publicationGeneration = this._advanceRequestGeneration();
      if (publicationGeneration !== this._requestGeneration) {
        throw createAuthSupersededError();
      }
    }
    this._persistAuthenticatedState(owner.token, user);
    if (publicationGeneration !== this._requestGeneration) {
      throw createAuthSupersededError();
    }
    this._token = owner.token;
    this._user = user;
    if (!this._emitChanged()) {
      throw createAuthSupersededError();
    }
  }

  getWorkerOrigin() {
    return getGitHubWorkerOrigin();
  }

  getToken() {
    return this._token;
  }

  getUser() {
    return this._user === null ? null : { ...this._user };
  }

  isAuthenticated() {
    return this._token !== null && this._user !== null;
  }

  async fetchUser({ signal = null } = {}) {
    const token = this._token;
    if (!token) return null;
    const owner = this._createRequestOwner(signal, token);
    try {
      const user = await this._fetchUserForOwner(owner);
      this._publishAuthenticatedOwner(owner, user);
      return { ...user };
    } finally {
      owner.cleanup();
    }
  }

  async ensureWorkerCompatible({ signal = null } = {}) {
    const owner = this._createRequestOwner(signal);
    try {
      await this._verifyWorkerForOwner(owner);
      return true;
    } finally {
      owner.cleanup();
    }
  }

  async _acceptToken(token) {
    if (typeof token !== 'string' || !token || /^\s|\s$/.test(token)) {
      throw new Error('Missing or inexact GitHub token');
    }

    const transitionGeneration = this._advanceRequestGeneration();
    if (transitionGeneration !== this._requestGeneration) {
      throw createAuthSupersededError();
    }
    const owner = this._createRequestOwner(
      null,
      token,
      { candidate: true }
    );
    try {
      const user = await this._fetchUserForOwner(owner);
      this._publishAuthenticatedOwner(owner, user);
      return { token, user: { ...user } };
    } finally {
      owner.cleanup();
    }
  }

  async completeSignInFromRedirect({ url = null } = {}) {
    if (typeof window === 'undefined') throw new Error('GitHub login requires a browser context');
    const result = readAuthResultFromUrl(url);
    if (!result) return null;

    if (result.cleanedUrl) {
      if (typeof window.history?.replaceState !== 'function') {
        throw new Error('History.replaceState is required to remove the GitHub token fragment');
      }
      window.history.replaceState(
        window.history.state,
        '',
        result.cleanedUrl
      );
    }

    if (result.validationError) {
      throw result.validationError;
    }

    if (result.error) {
      const err = new Error(result.error);
      err.code = 'GITHUB_AUTH_ERROR';
      throw err;
    }

    if (!result.token) {
      const err = new Error('Missing GitHub token');
      err.code = 'GITHUB_AUTH_MISSING_TOKEN';
      throw err;
    }

    return this._acceptToken(result.token);
  }

  async signIn({ returnTo = null, signal = null } = {}) {
    if (typeof window === 'undefined') throw new Error('GitHub login requires a browser context');
    const ownerSignal = assertAbortSignalOrNull(signal);
    const workerOrigin = this.getWorkerOrigin();
    const rawHash = String(window.location.hash || '').replace(/^#/, '');
    const retainedFragment = rawHash
      ? scrubAuthFragment(rawHash)
      : { cleanedHash: '', hasRetainedSegments: false };
    const rt = returnTo === null
      ? (
        `${window.location.origin}${window.location.pathname}${window.location.search}` +
        (
          retainedFragment.hasRetainedSegments
            ? `#${retainedFragment.cleanedHash}`
            : ''
        )
      )
      : returnTo;
    if (typeof rt !== 'string' || !rt || /^\s|\s$/.test(rt)) {
      throw new Error('GitHub sign-in returnTo must be an exact nonblank URL');
    }
    const url = new URL(getGitHubLoginUrl(workerOrigin));
    url.searchParams.set('return_to', rt);
    if (typeof window.location.assign !== 'function') {
      throw new Error('GitHub sign-in requires location.assign()');
    }
    this._advanceRequestGeneration();
    const owner = this._createRequestOwner(
      ownerSignal,
      null,
      { candidate: true }
    );
    try {
      await this._verifyWorkerForOwner(owner);
      this._assertRequestOwnerCurrent(owner);
      window.location.assign(url.toString());
      return url.toString();
    } finally {
      owner.cleanup();
    }
  }

  signOut() {
    const hadAuthenticatedState = this.isAuthenticated();
    const signOutGeneration = this._advanceRequestGeneration();
    if (signOutGeneration !== this._requestGeneration) return;
    removeSessionItem(SESSION_KEY);
    if (signOutGeneration !== this._requestGeneration) return;
    if (!hadAuthenticatedState) return;
    this._token = null;
    this._user = null;
    this._emitChanged();
  }

  async listInstallations({ signal = null } = {}) {
    const token = this._token;
    if (!token) throw new Error('Not signed in');
    const owner = this._createRequestOwner(signal);
    const workerOrigin = this.getWorkerOrigin();
    const url = `${workerOrigin}/auth/installations`;
    try {
      if (this._verifiedWorkerOrigin !== workerOrigin) {
        await this._verifyWorkerForOwner(owner);
      }
      let response;
      try {
        response = await fetchJson(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          signal: owner.signal,
        });
      } catch (error) {
        this._assertRequestOwnerCurrent(owner, error);
        throw error;
      }
      this._assertRequestOwnerCurrent(owner);
      return assertInstallationsResponse(response);
    } finally {
      owner.cleanup();
    }
  }

  async listInstallationRepos(installationId, { signal = null } = {}) {
    const token = this._token;
    if (!token) throw new Error('Not signed in');
    if (!Number.isSafeInteger(installationId) || installationId < 1) {
      throw new Error('Invalid installation_id');
    }
    const owner = this._createRequestOwner(signal);
    const workerOrigin = this.getWorkerOrigin();
    const url = `${workerOrigin}/auth/installation-repos`;
    try {
      if (this._verifiedWorkerOrigin !== workerOrigin) {
        await this._verifyWorkerForOwner(owner);
      }
      let response;
      try {
        response = await fetchJson(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: { installation_id: installationId },
          signal: owner.signal,
        });
      } catch (error) {
        this._assertRequestOwnerCurrent(owner, error);
        throw error;
      }
      this._assertRequestOwnerCurrent(owner);
      return assertInstallationRepositoriesResponse(response);
    } finally {
      owner.cleanup();
    }
  }
}

let _singleton = null;

export function getGitHubAuthSession() {
  if (!_singleton) _singleton = new GitHubAuthSession();
  return _singleton;
}
