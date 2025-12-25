/**
 * Community annotation access model (author vs annotator).
 *
 * - Author: has maintain/admin rights (can change repo-level annotation settings).
 * - Annotator: any other collaborator (may have write for user-file publishing).
 *
 * Includes a dev-only local override via `window._author_mode` / `window._annotator_mode`.
 */

import { EventEmitter } from '../utils/event-emitter.js';

function toCleanString(value) {
  return String(value ?? '').trim();
}

function isLocalDevHost() {
  try {
    if (typeof window === 'undefined' || typeof window.location === 'undefined') return false;
    // Explicit dev override (must be set manually in local/dev builds).
    // This keeps console-only toggles from working in production unless the page opts in.
    try {
      const w = /** @type {any} */ (window);
      if (w?.__CELLUCID_DEV__ === true) return true;
    } catch {
      // ignore
    }
    const host = String(window.location.hostname || '').toLowerCase();
    const proto = String(window.location.protocol || '').toLowerCase();
    if (proto === 'file:') return true;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
    if (host.endsWith('.local')) return true;
    if (/^10\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host)) return true;
    if (/^192\.168\.(\d{1,3})\.(\d{1,3})$/.test(host)) return true;
    const m = host.match(/^172\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const second = Number(m[1]);
      if (Number.isFinite(second) && second >= 16 && second <= 31) return true;
    }
    return false;
  } catch {
    return false;
  }
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

  setRole(nextRole) {
    const r = toCleanString(nextRole) || 'unknown';
    const normalized = r === 'author' || r === 'annotator' ? r : 'unknown';
    if (normalized === this._role) return;
    this._role = normalized;
    this.emit('changed', { role: this._role });
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
      let _cellucidDev = w.__CELLUCID_DEV__ === true;
      let _authorMode = false;
      let _annotatorMode = false;
      let _simulateRepoConnected = false;

      // __CELLUCID_DEV__ must also trigger re-render since isLocalDevHost() depends on it
      Object.defineProperty(w, '__CELLUCID_DEV__', {
        get() { return _cellucidDev; },
        set(val) {
          const next = val === true;
          if (next === _cellucidDev) return;
          _cellucidDev = next;
          self.emit('changed', { role: self.getEffectiveRole() });
        },
        configurable: true,
        enumerable: true
      });

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
