/**
 * Community annotation access model (author vs annotator).
 *
 * - Author: has maintain/admin rights (can change repo-level annotation settings).
 * - Annotator: any other collaborator (may have write for user-file publishing).
 *
 * Includes a dev-only local override via `window._author_mode` / `window._annotator_mode`.
 */

import { EventEmitter } from '../utils/event-emitter.js';
import { isLocalDevHost } from '../utils/local-dev.js';
import { getAnnotationRepoForDataset } from './repo-store.js';
import { dispatchAnnotationConnectionChanged } from './connection-events.js';
import { getGitHubAuthSession, toGitHubUserKey } from './github-auth.js';

function toCleanString(value) {
  return String(value ?? '').trim();
}

export function isSimulateRepoConnectedEnabled() {
  if (!isLocalDevHost()) return false;
  try {
    const w = /** @type {any} */ (window);
    return w?._simulate_repo_connected === true;
  } catch {
    return false;
  }
}

export function isAnnotationRepoConnected(datasetId, username = 'local') {
  if (isSimulateRepoConnectedEnabled()) return true;
  try {
    const auth = getGitHubAuthSession();
    if (!auth?.isAuthenticated?.()) return false;
    const key = toGitHubUserKey(auth.getUser?.());
    if (!key) return false;
    const u = toCleanString(username || '').replace(/^@+/, '').toLowerCase();
    if (u && u !== key) return false;
  } catch {
    return false;
  }
  return Boolean(getAnnotationRepoForDataset(datasetId, username));
}

function readDevOverrideRole() {
  if (!isLocalDevHost()) return null;
  try {
    const w = /** @type {any} */ (window);
    if (w._author_mode === true) return 'author';
    if (w._annotator_mode === true) return 'annotator';
  } catch {
    // ignore
  }
  return null;
}

function computeRoleFromRepoInfo(repoInfo) {
  const perms = repoInfo?.permissions || null;
  if (!perms || typeof perms !== 'object') return 'unknown';
  const isAuthor = Boolean(perms.maintain || perms.admin);
  return isAuthor ? 'author' : 'annotator';
}

export class CommunityAnnotationAccessStore extends EventEmitter {
  constructor() {
    super();
    this._role = 'unknown';
  }

  getRole() {
    return this._role;
  }

  getEffectiveRole() {
    return readDevOverrideRole() || this._role;
  }

  isAuthor() {
    return this.getEffectiveRole() === 'author';
  }

  isRoleKnown() {
    return this.getRole() !== 'unknown';
  }

  setRole(nextRole) {
    const r = toCleanString(nextRole) || 'unknown';
    const normalized = r === 'author' || r === 'annotator' ? r : 'unknown';
    if (normalized === this._role) return;
    this._role = normalized;
    this.emit('changed', { role: this._role });
  }

  clearRole() {
    this.setRole('unknown');
  }

  setRoleFromRepoInfo(repoInfo) {
    this.setRole(computeRoleFromRepoInfo(repoInfo));
  }

  installDevConsoleOverrides() {
    // Always install property setters so that setting the flags triggers events/re-renders.
    // The actual effect of the flags is still gated by isLocalDevHost() in
    // isSimulateRepoConnectedEnabled() and readDevOverrideRole().
    try {
      if (typeof window === 'undefined') return false;
      const w = /** @type {any} */ (window);
      const self = this;
      let _authorMode = w._author_mode === true;
      let _annotatorMode = !_authorMode && w._annotator_mode === true;
      let _simulateRepoConnected = w._simulate_repo_connected === true;

      Object.defineProperty(w, '_author_mode', {
        get() { return _authorMode; },
        set(val) {
          const next = val === true;
          if (next === _authorMode) return;
          _authorMode = next;
          if (next) _annotatorMode = false;
          self.emit('changed', { role: self.getEffectiveRole() });
        },
        configurable: true,
        enumerable: true
      });

      Object.defineProperty(w, '_annotator_mode', {
        get() { return _annotatorMode; },
        set(val) {
          const next = val === true;
          if (next === _annotatorMode) return;
          _annotatorMode = next;
          if (next) _authorMode = false;
          self.emit('changed', { role: self.getEffectiveRole() });
        },
        configurable: true,
        enumerable: true
      });

      Object.defineProperty(w, '_simulate_repo_connected', {
        get() { return _simulateRepoConnected; },
        set(val) {
          const next = val === true;
          if (next === _simulateRepoConnected) return;
          _simulateRepoConnected = next;
          self.emit('changed', { role: self.getEffectiveRole() });
          dispatchAnnotationConnectionChanged({ reason: '_simulate_repo_connected' });
        },
        configurable: true,
        enumerable: true
      });

      return true;
    } catch {
      return false;
    }
  }
}

let _store = null;

export function getCommunityAnnotationAccessStore() {
  if (_store) return _store;
  _store = new CommunityAnnotationAccessStore();
  _store.installDevConsoleOverrides();
  return _store;
}
