/**
 * GitHub App OAuth session (via Cloudflare Worker).
 *
 * - Starts OAuth via popup to `${WORKER_ORIGIN}/auth/login`
 * - Receives access token via `postMessage` from the popup
 * - Stores token in `sessionStorage` (never `localStorage`)
 * - Fetches user identity from `${WORKER_ORIGIN}/auth/user`
 *
 * This module is UI-agnostic (no DOM writes).
 */

import { EventEmitter } from '../utils/event-emitter.js';

const DEFAULT_WORKER_ORIGIN = 'https://cellucid-github-auth.benkemalim.workers.dev';

const TOKEN_KEY = 'cellucid:github-app-auth:token:v1';
const USER_KEY = 'cellucid:github-app-auth:user:v1';

function toCleanString(value) {
  return String(value ?? '').trim();
}

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
  const override = toCleanString(window.__CELLUCID_GITHUB_WORKER_ORIGIN__ || '');
  if (!override) return DEFAULT_WORKER_ORIGIN;
  try {
    return new URL(override).origin;
  } catch {
    return DEFAULT_WORKER_ORIGIN;
  }
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

async function fetchJson(url, { method = 'GET', headers = null, body = null } = {}) {
  const res = await fetch(url, {
    method,
    headers: headers || undefined,
    body: body != null ? JSON.stringify(body) : undefined
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
}

export function getGitHubLoginUrl(workerOrigin = null) {
  const origin = toCleanString(workerOrigin || getGitHubWorkerOrigin()).replace(/\/+$/, '');
  return `${origin}/auth/login`;
}

function openAuthWindow(workerOrigin, mode) {
  const url = getGitHubLoginUrl(workerOrigin);
  const m = toCleanString(mode || 'popup');
  if (m === 'tab') {
    return window.open(url, 'cellucid-github-auth');
  }
  const features = [
    'popup=yes',
    'width=600',
    'height=700',
    'menubar=no',
    'toolbar=no',
    'location=no',
    'status=no',
    'resizable=yes',
    'scrollbars=yes'
  ].join(',');
  return window.open(url, 'cellucid-github-auth', features);
}

async function waitForAuthMessage({ workerOrigin, popup, timeoutMs = 120_000 } = {}) {
  const expectedOrigin = new URL(workerOrigin).origin;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {number|null} */
    let timer = null;
    /** @type {number|null} */
    let timeout = null;
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      if (timer != null) clearInterval(timer);
      if (timeout != null) clearTimeout(timeout);
    };
    const settleOnce = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const onMessage = (event) => {
      if (event.origin !== expectedOrigin) return;
      const data = event.data || null;
      if (!data || data.type !== 'cellucid-github-auth') return;
      const token = toCleanString(data.token || '');
      const error = toCleanString(data.error || data.message || '');
      if (token) settleOnce(resolve, token);
      else settleOnce(reject, new Error(error || 'GitHub login failed'));
    };

    window.addEventListener('message', onMessage);

    timer = setInterval(() => {
      if (settled) return;
      const elapsed = Date.now() - startedAt;
      if (elapsed > timeoutMs) {
        settleOnce(reject, new Error('GitHub login timed out'));
        return;
      }
      if (popup && popup.closed) {
        settleOnce(reject, new Error('GitHub login was cancelled'));
      }
    }, 350);

    timeout = setTimeout(() => {
      if (settled) return;
      settleOnce(reject, new Error('GitHub login timed out'));
    }, timeoutMs + 1000);
  });
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

  async completeSignInFromMessage({ timeoutMs = 120_000 } = {}) {
    if (typeof window === 'undefined') throw new Error('GitHub login requires a browser context');
    const workerOrigin = this.getWorkerOrigin();
    const token = await waitForAuthMessage({ workerOrigin, popup: null, timeoutMs });
    return this._acceptToken(token);
  }

  async signIn({ mode = 'auto' } = {}) {
    if (typeof window === 'undefined') throw new Error('GitHub login requires a browser context');
    const workerOrigin = this.getWorkerOrigin();
    /** @type {Window|null} */
    let authWindow = null;

    if (mode === 'auto') {
      // "Tab" mode avoids popup blockers in some browsers.
      authWindow = openAuthWindow(workerOrigin, 'tab') || openAuthWindow(workerOrigin, 'popup');
    } else {
      authWindow = openAuthWindow(workerOrigin, mode);
    }

    if (!authWindow) {
      const err = new Error('Sign-in window blocked: allow popups/new tabs for Cellucid to sign in with GitHub');
      err.code = 'POPUP_BLOCKED';
      throw err;
    }

    const token = await waitForAuthMessage({ workerOrigin, popup: authWindow });
    return this._acceptToken(token);
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
