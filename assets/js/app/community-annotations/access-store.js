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

function assertAccessUsername(username) {
  if (username === 'local') return username;
  if (typeof username !== 'string' || !/^ghid_[1-9][0-9]*$/.test(username)) {
    throw new Error('Annotation access user must be "local" or an exact ghid identity');
  }
  const id = Number(username.slice(5));
  if (!Number.isSafeInteger(id) || id < 1 || username !== `ghid_${id}`) {
    throw new Error('Annotation access user must be "local" or an exact ghid identity');
  }
  return username;
}

export function isSimulateRepoConnectedEnabled() {
  if (!isLocalDevHost()) return false;
  if (typeof window === 'undefined') return false;
  const w = /** @type {any} */ (window);
  return w._simulate_repo_connected === true;
}

export function isAnnotationRepoConnected(datasetId, username = 'local') {
  if (datasetId === null || datasetId === undefined || datasetId === '') {
    return false;
  }
  if (isSimulateRepoConnectedEnabled()) return true;
  const user = assertAccessUsername(username);
  const auth = getGitHubAuthSession();
  if (!auth.isAuthenticated()) return false;
  const key = toGitHubUserKey(auth.getUser());
  if (!key || user !== key) return false;
  return Boolean(getAnnotationRepoForDataset(datasetId, user));
}

function readDevOverrideRole() {
  if (!isLocalDevHost()) return null;
  if (typeof window === 'undefined') return null;
  const w = /** @type {any} */ (window);
  if (w._author_mode === true) return 'author';
  if (w._annotator_mode === true) return 'annotator';
  return null;
}

function computeRoleFromRepoInfo(repoInfo) {
  if (!repoInfo || typeof repoInfo !== 'object' || Array.isArray(repoInfo)) {
    throw new Error('Annotation repository metadata must be an object');
  }
  const perms = repoInfo.permissions;
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) {
    throw new Error('Annotation repository permissions must be an object');
  }
  for (const key of ['maintain', 'admin']) {
    if (typeof perms[key] !== 'boolean') {
      throw new Error(`Annotation repository permissions.${key} must be boolean`);
    }
  }
  const isAuthor = perms.maintain || perms.admin;
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
    const override = readDevOverrideRole();
    return override === null ? this._role : override;
  }

  isAuthor() {
    return this.getEffectiveRole() === 'author';
  }

  isRoleKnown() {
    return this.getRole() !== 'unknown';
  }

  setRole(nextRole) {
    if (nextRole !== 'author' && nextRole !== 'annotator' && nextRole !== 'unknown') {
      throw new Error('Annotation access role must equal author, annotator, or unknown');
    }
    if (nextRole === this._role) return;
    this._role = nextRole;
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
  }
}

let _store = null;

export function getCommunityAnnotationAccessStore() {
  if (_store) return _store;
  _store = new CommunityAnnotationAccessStore();
  _store.installDevConsoleOverrides();
  return _store;
}
