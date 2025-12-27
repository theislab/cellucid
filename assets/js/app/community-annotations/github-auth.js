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

const DEFAULT_WORKER_ORIGIN = 'https://cellucid-github-auth.benkemalim.workers.dev';

const TOKEN_KEY = 'cellucid:github-app-auth:token:v1';
const USER_KEY = 'cellucid:github-app-auth:user:v1';
const LAST_GITHUB_USER_KEY = 'cellucid:community-annotations:last-github-user-key';

const AUTH_FLAG_PARAM = 'cellucid_github_auth';
const AUTH_TOKEN_PARAM = 'cellucid_github_token';
const AUTH_ERROR_PARAM = 'cellucid_github_error';

const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

function toCleanString(value) {
  return String(value ?? '').trim();
}

function normalizeTimeoutMs(rawTimeoutMs, fallbackMs) {
  const n = Number(rawTimeoutMs);
  if (!Number.isFinite(n)) return fallbackMs;
  return Math.max(0, Math.floor(n));
}

function isAbortError(err) {
  return err?.name === 'AbortError';
}

function normalizeOriginOrDefault(rawOrigin) {
  try {
    return new URL(rawOrigin).origin;
  } catch {
    return DEFAULT_WORKER_ORIGIN;
  }
}

const _initialWorkerOriginOverride = (() => {
  if (typeof window === 'undefined') return '';
  return toCleanString(window.__CELLUCID_GITHUB_WORKER_ORIGIN__ || '');
})();

const _cachedNonLocalWorkerOrigin = (() => {
  if (typeof window === 'undefined') return DEFAULT_WORKER_ORIGIN;
  if (!_initialWorkerOriginOverride) return DEFAULT_WORKER_ORIGIN;
  return normalizeOriginOrDefault(_initialWorkerOriginOverride);
})();

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return null;
  }
}

export function getGitHubWorkerOrigin() {
  if (typeof window === 'undefined') return DEFAULT_WORKER_ORIGIN;
  // Local dev: allow changing the override without a reload.
  if (isLocalDevHost()) {
    const override = toCleanString(window.__CELLUCID_GITHUB_WORKER_ORIGIN__ || '');
    if (!override) return DEFAULT_WORKER_ORIGIN;
    return normalizeOriginOrDefault(override);
  }

  // Non-local: treat overrides as deploy-time config only (read once at module init).
  return _cachedNonLocalWorkerOrigin;
}

function readSessionItem(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionItem(key, value) {
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeSessionItem(key) {
  try {
    sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function readLocalItem(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

async function fetchJson(url, { method = 'GET', headers = null, body = null, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  const ms = normalizeTimeoutMs(timeoutMs, DEFAULT_FETCH_TIMEOUT_MS);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const signal = controller?.signal;

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timeout = null;
  if (controller && ms > 0) {
    timeout = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
    }, ms);
  }

  try {
    const res = await fetch(url, {
      method,
      headers: headers || undefined,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: signal || undefined
    });

    const text = await res.text();
    const asJson = text ? safeJsonParse(text) : null;
    if (!res.ok) {
      const msg = toCleanString(asJson?.error || asJson?.message || text) || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.url = url;
      throw err;
    }
    return asJson != null ? asJson : (text || null);
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
    if (timeout) clearTimeout(timeout);
  }
}

export function getGitHubLoginUrl(workerOrigin = null) {
  const origin = toCleanString(workerOrigin || getGitHubWorkerOrigin()).replace(/\/+$/, '');
  return `${origin}/auth/login`;
}

export function toGitHubUserKey(user) {
  const id = Number(user?.id);
  if (!Number.isFinite(id)) return null;
  const safe = Math.max(0, Math.floor(id));
  return safe ? `ghid_${safe}` : null;
}

export function getLastGitHubUserKey() {
  const raw = toCleanString(readLocalItem(LAST_GITHUB_USER_KEY) || '').replace(/^@+/, '').toLowerCase();
  const m = raw.match(/^ghid_(\d+)$/);
  if (!m) return null;
  const id = Number(m[1]);
  if (!Number.isFinite(id)) return null;
  const safe = Math.max(0, Math.floor(id));
  return safe ? `ghid_${safe}` : null;
}

function readAuthResultFromUrl(urlString) {
  if (typeof window === 'undefined') return null;
  const href = toCleanString(urlString || window.location?.href || '');
  if (!href) return null;

  /** @type {URL|null} */
  let url = null;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  const hash = String(url.hash || '').replace(/^#/, '');
  if (!hash) return null;

  const params = new URLSearchParams(hash);
  const flag = toCleanString(params.get(AUTH_FLAG_PARAM) || '');
  if (!flag) return null;

  const token = toCleanString(params.get(AUTH_TOKEN_PARAM) || '') || null;
  const error = toCleanString(params.get(AUTH_ERROR_PARAM) || '') || null;

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
    const token = toCleanString(readSessionItem(TOKEN_KEY) || '');
    this._token = token || null;
    const rawUser = readSessionItem(USER_KEY);
    const parsed = rawUser ? safeJsonParse(rawUser) : null;
    this._user = parsed && typeof parsed === 'object' ? parsed : null;
  }

  _persist() {
    if (this._token) writeSessionItem(TOKEN_KEY, this._token);
    else removeSessionItem(TOKEN_KEY);
    if (this._user) {
      const payload = safeJsonStringify(this._user);
      if (payload) writeSessionItem(USER_KEY, payload);
    } else {
      removeSessionItem(USER_KEY);
    }
  }

  getWorkerOrigin() {
    return getGitHubWorkerOrigin();
  }

  getToken() {
    return this._token;
  }

  getUser() {
    return this._user;
  }

  isAuthenticated() {
    return Boolean(this._token);
  }

  async fetchUser() {
    const token = this._token;
    if (!token) return null;
    const workerOrigin = this.getWorkerOrigin();
    const url = `${workerOrigin.replace(/\/+$/, '')}/auth/user`;
    const user = await fetchJson(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (user && typeof user === 'object') {
      this._user = user;
      this._persist();
      const key = toGitHubUserKey(this._user);
      if (key) writeLocalItem(LAST_GITHUB_USER_KEY, key);
      this.emit('changed', { token: this._token, user: this._user });
    }
    return this._user;
  }

  async _acceptToken(token) {
    const t = toCleanString(token || '');
    if (!t) throw new Error('Missing GitHub token');

    this._token = t;
    this._user = null;
    this._persist();
    this.emit('changed', { token: this._token, user: this._user });
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
    const result = readAuthResultFromUrl(url || window.location?.href || '');
    if (!result) return null;

    if (result.cleanedUrl) {
      try {
        window.history?.replaceState?.(null, '', result.cleanedUrl);
      } catch {
        // ignore
      }
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
    const rt = (() => {
      const raw = toCleanString(returnTo || '');
      if (raw) return raw;
      try {
        const { origin, pathname, search } = window.location;
        return `${origin}${pathname}${search || ''}`;
      } catch {
        return toCleanString(window.location?.href || '');
      }
    })();
    const url = new URL(getGitHubLoginUrl(workerOrigin));
    if (rt) url.searchParams.set('return_to', rt);
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
    const url = `${workerOrigin.replace(/\/+$/, '')}/auth/installations`;
    return fetchJson(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });
  }

  async listInstallationRepos(installationId) {
    const token = this._token;
    if (!token) throw new Error('Not signed in');
    const id = Number(installationId);
    if (!Number.isFinite(id)) throw new Error('Invalid installation_id');
    const workerOrigin = this.getWorkerOrigin();
    const url = `${workerOrigin.replace(/\/+$/, '')}/auth/installation-repos`;
    return fetchJson(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: { installation_id: id }
    });
  }
}

let _singleton = null;

export function getGitHubAuthSession() {
  if (!_singleton) _singleton = new GitHubAuthSession();
  return _singleton;
}
