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
const LAST_GITHUB_USER_KEY = 'cellucid:community-annotations:last-github-user-key';

const AUTH_FLAG_PARAM = 'cellucid_github_auth';
const AUTH_TOKEN_PARAM = 'cellucid_github_token';
const AUTH_ERROR_PARAM = 'cellucid_github_error';

const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

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

function readLocalItem(key) {
  try {
    if (typeof localStorage === 'undefined') {
      throw new Error('localStorage is unavailable');
    }
    return localStorage.getItem(key);
  } catch (cause) {
    throw storageFailure('localStorage', 'read', cause);
  }
}

function writeLocalItem(key, value) {
  try {
    if (typeof localStorage === 'undefined') {
      throw new Error('localStorage is unavailable');
    }
    localStorage.setItem(key, value);
    return true;
  } catch (cause) {
    throw storageFailure('localStorage', 'write', cause);
  }
}

async function fetchJson(url, { method = 'GET', headers = null, body = null, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  const ms = assertTimeoutMs(timeoutMs);
  if (typeof AbortController !== 'function') {
    throw new Error('AbortController is required for GitHub annotation requests');
  }
  const controller = new AbortController();
  const signal = controller.signal;

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timeout = null;
  if (ms > 0) {
    timeout = setTimeout(() => {
      controller.abort();
    }, ms);
  }

  try {
    const res = await fetch(url, {
      method,
      headers: headers || undefined,
      body: body != null ? JSON.stringify(body) : undefined,
      signal
    });

    const text = await res.text();
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
    if (isAbortError(err)) {
      const msg = ms > 0 ? `Request timed out after ${Math.max(1, Math.round(ms / 1000))}s` : 'Request aborted';
      const e = new Error(msg);
      e.code = 'TIMEOUT';
      e.url = url;
      throw e;
    }
    throw err;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
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

export function getLastGitHubUserKey() {
  const raw = readLocalItem(LAST_GITHUB_USER_KEY);
  if (raw === null) return null;
  const m = raw.match(/^ghid_([1-9][0-9]*)$/);
  if (!m) throw new Error('Stored GitHub user key has an invalid exact identity');
  const id = Number(m[1]);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('Stored GitHub user key exceeds the safe integer identity range');
  }
  return raw;
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
  if (!Array.isArray(document.installations)) {
    throw new Error('GitHub installations endpoint installations must be an array');
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
  if (!Array.isArray(document.repositories)) {
    throw new Error(
      'GitHub installation repositories endpoint repositories must be an array'
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

  const params = new URLSearchParams(hash);
  const flags = params.getAll(AUTH_FLAG_PARAM);
  if (!flags.length) return null;
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

  params.delete(AUTH_FLAG_PARAM);
  params.delete(AUTH_TOKEN_PARAM);
  params.delete(AUTH_ERROR_PARAM);

  const cleanedHash = params.toString();
  const cleanedUrl = `${url.origin}${url.pathname}${url.search}${cleanedHash ? `#${cleanedHash}` : ''}`;

  return { token, error, cleanedUrl };
}

export class GitHubAuthSession extends EventEmitter {
  constructor() {
    super();
    this._token = null;
    this._user = null;
    this._loadFromSessionStorage();
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
    this._user = assertStoredGitHubUser(session.user);
  }

  _persist() {
    if (this._token === null && this._user === null) {
      removeSessionItem(SESSION_KEY);
      return;
    }
    if (
      typeof this._token !== 'string' ||
      !this._token ||
      /^\s|\s$/.test(this._token) ||
      this._user === null
    ) {
      throw new Error(
        'GitHub auth session requires one exact token and user identity'
      );
    }
    writeSessionItem(
      SESSION_KEY,
      JSON.stringify({
        token: this._token,
        user: assertStoredGitHubUser(this._user),
      })
    );
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

  async fetchUser() {
    const token = this._token;
    if (!token) return null;
    const workerOrigin = this.getWorkerOrigin();
    const url = `${workerOrigin}/auth/user`;
    const userResponse = await fetchJson(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });
    this._user = assertGitHubUserResponse(userResponse);
    this._persist();
    const key = toGitHubUserKey(this._user);
    writeLocalItem(LAST_GITHUB_USER_KEY, key);
    this.emit('changed', { token: this._token, user: this._user });
    return this._user;
  }

  async _acceptToken(token) {
    if (typeof token !== 'string' || !token || /^\s|\s$/.test(token)) {
      throw new Error('Missing or inexact GitHub token');
    }

    this._token = token;
    this._user = null;
    try {
      await this.fetchUser();
    } catch (err) {
      this.signOut();
      throw err;
    }
    return { token: this._token, user: this._user };
  }

  async completeSignInFromRedirect({ url = null } = {}) {
    if (typeof window === 'undefined') throw new Error('GitHub login requires a browser context');
    const result = readAuthResultFromUrl(url);
    if (!result) return null;

    if (result.cleanedUrl) {
      if (typeof window.history?.replaceState !== 'function') {
        throw new Error('History.replaceState is required to remove the GitHub token fragment');
      }
      window.history.replaceState(null, '', result.cleanedUrl);
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

  signIn({ returnTo = null } = {}) {
    if (typeof window === 'undefined') throw new Error('GitHub login requires a browser context');
    const workerOrigin = this.getWorkerOrigin();
    const rt = returnTo === null
      ? `${window.location.origin}${window.location.pathname}${window.location.search}`
      : returnTo;
    if (typeof rt !== 'string' || !rt || /^\s|\s$/.test(rt)) {
      throw new Error('GitHub sign-in returnTo must be an exact nonblank URL');
    }
    const url = new URL(getGitHubLoginUrl(workerOrigin));
    url.searchParams.set('return_to', rt);
    window.location.assign(url.toString());
  }

  signOut() {
    this._token = null;
    this._user = null;
    this._persist();
    this.emit('changed', { token: this._token, user: this._user });
  }

  async listInstallations() {
    const token = this._token;
    if (!token) throw new Error('Not signed in');
    const workerOrigin = this.getWorkerOrigin();
    const url = `${workerOrigin}/auth/installations`;
    const response = await fetchJson(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });
    return assertInstallationsResponse(response);
  }

  async listInstallationRepos(installationId) {
    const token = this._token;
    if (!token) throw new Error('Not signed in');
    if (!Number.isSafeInteger(installationId) || installationId < 1) {
      throw new Error('Invalid installation_id');
    }
    const workerOrigin = this.getWorkerOrigin();
    const url = `${workerOrigin}/auth/installation-repos`;
    const response = await fetchJson(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: { installation_id: installationId }
    });
    return assertInstallationRepositoriesResponse(response);
  }
}

let _singleton = null;

export function getGitHubAuthSession() {
  if (!_singleton) _singleton = new GitHubAuthSession();
  return _singleton;
}
