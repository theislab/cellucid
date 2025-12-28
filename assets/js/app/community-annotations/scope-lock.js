/**
 * Community Annotation - Cross-tab scope lock.
 *
 * Goal
 * ----
 * Prevent silent data loss from multiple tabs editing the same annotation scope:
 *   - datasetId
 *   - owner/repo@branch
 *   - GitHub numeric userId
 *
 * We intentionally enforce a single active tab per scope. If another tab acquires
 * the lock, this tab must treat it as a fatal safety issue and the UI should
 * disconnect from the annotation repo.
 *
 * This lock uses a localStorage-backed lease with:
 * - deterministic lock key per scope
 * - periodic renewals
 * - storage-event based lock-loss detection
 *
 * No backward compatibility is required (dev phase).
 */

import { EventEmitter } from '../utils/event-emitter.js';

const TAB_ID_KEY = 'cellucid:community-annotations:tab-id:v1';
const LOCK_PREFIX = 'cellucid:community-annotations:lock:';
const BROADCAST_CHANNEL = 'cellucid:community-annotations:scope-lock:v1';

// More tolerant defaults: background timer throttling should not cause spurious lock loss.
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RENEW_MS = 15_000;

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

function nowMs() {
  return Date.now();
}

function nowIso() {
  try {
    return new Date().toISOString();
  } catch {
    return String(Date.now());
  }
}

function createTabId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  return `tab_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
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

function removeLocalItem(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function normalizeScopeKey(scopeKey) {
  const key = toCleanString(scopeKey);
  return key ? key : null;
}

function lockStorageKey(scopeKey) {
  return `${LOCK_PREFIX}${scopeKey}`;
}

function parseLockRecord(raw) {
  const parsed = raw ? safeJsonParse(raw) : null;
  if (!parsed || typeof parsed !== 'object') return null;
  const owner = toCleanString(parsed.owner);
  const acquiredAt = toCleanString(parsed.acquiredAt);
  const expiresAtMs = Number(parsed.expiresAtMs);
  if (!owner || !Number.isFinite(expiresAtMs)) return null;
  return { owner, acquiredAt: acquiredAt || null, expiresAtMs };
}

function isExpired(rec, now) {
  if (!rec) return true;
  return rec.expiresAtMs <= now;
}

export class CommunityAnnotationScopeLock extends EventEmitter {
  constructor({ leaseMs = DEFAULT_LEASE_MS, renewMs = DEFAULT_RENEW_MS } = {}) {
    super();
    this._tabId = null;
    this._scopeKey = null;
    this._lockKey = null;
    this._leaseMs = Math.max(8_000, Math.floor(Number(leaseMs) || DEFAULT_LEASE_MS));
    this._renewMs = Math.max(2_000, Math.min(this._leaseMs - 1_000, Math.floor(Number(renewMs) || DEFAULT_RENEW_MS)));
    this._renewTimer = null;
    this._renewTick = null;
    this._visibilityListener = null;
    this._storageListener = null;
    this._bc = null;
    this._bcListener = null;
  }

  getTabId() {
    if (this._tabId) return this._tabId;
    const existing = toCleanString(readSessionItem(TAB_ID_KEY) || '');
    if (existing) {
      this._tabId = existing;
      return existing;
    }
    const created = createTabId();
    this._tabId = created;
    writeSessionItem(TAB_ID_KEY, created);
    return created;
  }

  getScopeKey() {
    return this._scopeKey;
  }

  isHolding(scopeKey) {
    const key = normalizeScopeKey(scopeKey);
    return Boolean(key && this._scopeKey && key === this._scopeKey);
  }

  release() {
    const key = this._lockKey;
    const scopeKey = this._scopeKey;
    const tabId = this.getTabId();
    if (key && scopeKey) {
      this._broadcast({ type: 'lock-released', scopeKey, owner: tabId, at: nowIso() });
    }
    this._stopRenew();
    this._detachStorageListener();
    this._detachBroadcastChannel();
    this._lockKey = null;
    this._scopeKey = null;

    if (!key || !scopeKey) return { released: true };

    const existing = parseLockRecord(readLocalItem(key) || '');
    if (existing && existing.owner === tabId) {
      removeLocalItem(key);
    }
    return { released: true };
  }

  setScopeKey(scopeKey) {
    const nextScopeKey = normalizeScopeKey(scopeKey);
    if (nextScopeKey === this._scopeKey) return { ok: true, scopeKey: nextScopeKey };

    this.release();
    if (!nextScopeKey) return { ok: true, scopeKey: null };
    return this._acquire(nextScopeKey);
  }

  _acquire(scopeKey) {
    const tabId = this.getTabId();
    const key = lockStorageKey(scopeKey);
    const now = nowMs();

    const existing = parseLockRecord(readLocalItem(key) || '');
    if (existing && !isExpired(existing, now) && existing.owner !== tabId) {
      return {
        ok: false,
        code: 'LOCK_HELD',
        scopeKey,
        message:
          'Another browser tab/window is already connected to this annotation project.\n' +
          'To prevent accidental overwrites, this tab cannot connect.\n\n' +
          `Lock acquired: ${existing.acquiredAt || 'unknown'}\n` +
          `Try again in ~${Math.max(1, Math.round((existing.expiresAtMs - now) / 1000))}s, or close the other tab/window.\n\n` +
          'Tip: if you can’t find it, close other Cellucid tabs/windows for this site and retry.',
        holder: existing
      };
    }

    const record = {
      owner: tabId,
      acquiredAt: nowIso(),
      expiresAtMs: now + this._leaseMs
    };

    const wrote = writeLocalItem(key, JSON.stringify(record));
    if (!wrote) {
      return {
        ok: false,
        code: 'LOCK_STORAGE_FAILED',
        scopeKey,
        message:
          'Unable to access localStorage for cross-tab safety locking.\n' +
          'This is required to prevent silent annotation data loss.\n\n' +
          'Fix: disable private browsing restrictions or allow site storage, then retry.'
      };
    }

    const confirmed = parseLockRecord(readLocalItem(key) || '');
    if (!confirmed || confirmed.owner !== tabId || isExpired(confirmed, nowMs())) {
      return {
        ok: false,
        code: 'LOCK_VERIFY_FAILED',
        scopeKey,
        message:
          'Failed to acquire the cross-tab lock for this annotation project.\n' +
          'Another tab likely raced and won the lock. Please close other tabs and retry.'
      };
    }

    this._scopeKey = scopeKey;
    this._lockKey = key;
    this._attachStorageListener();
    this._attachBroadcastChannel();
    this._startRenew();
    this._installUnloadRelease();
    this._broadcast({ type: 'lock-acquired', scopeKey, owner: tabId, at: nowIso() });

    return { ok: true, scopeKey };
  }

  _installUnloadRelease() {
    try {
      if (typeof window === 'undefined') return;
      // Best-effort release on tab close/navigation.
      window.addEventListener('pagehide', () => this.release(), { once: true });
    } catch {
      // ignore
    }
  }

  _startRenew() {
    if (this._renewTimer) return;
    const tick = () => {
      if (!this._scopeKey || !this._lockKey) return;
      const tabId = this.getTabId();
      const now = nowMs();
      const current = parseLockRecord(readLocalItem(this._lockKey) || '');

      if (!current || current.owner !== tabId || isExpired(current, now)) {
        this._handleLockLost('Lock expired or was taken by another tab.');
        return;
      }

      const next = {
        owner: tabId,
        acquiredAt: current.acquiredAt || nowIso(),
        expiresAtMs: now + this._leaseMs
      };
      const wrote = writeLocalItem(this._lockKey, JSON.stringify(next));
      if (!wrote) {
        this._handleLockLost('Unable to renew the cross-tab lock (localStorage write failed).');
      }
    };

    this._renewTick = tick;
    this._renewTimer = setInterval(tick, this._renewMs);
    this._attachVisibilityListener();
    // Renew immediately to reduce chance of expiry under timer throttling.
    try { tick(); } catch { /* ignore */ }
  }

  _stopRenew() {
    if (!this._renewTimer) return;
    try { clearInterval(this._renewTimer); } catch { /* ignore */ }
    this._renewTimer = null;
    this._renewTick = null;
    this._detachVisibilityListener();
  }

  _attachVisibilityListener() {
    if (this._visibilityListener) return;
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      try {
        if (!this._renewTick) return;
        if (document.visibilityState && document.visibilityState !== 'visible') return;
        this._renewTick();
      } catch {
        // ignore
      }
    };
    this._visibilityListener = onVisible;
    try { document.addEventListener('visibilitychange', onVisible); } catch { /* ignore */ }
    try { window.addEventListener('focus', onVisible); } catch { /* ignore */ }
  }

  _detachVisibilityListener() {
    if (!this._visibilityListener) return;
    try { document.removeEventListener('visibilitychange', this._visibilityListener); } catch { /* ignore */ }
    try { window.removeEventListener('focus', this._visibilityListener); } catch { /* ignore */ }
    this._visibilityListener = null;
  }

  _attachBroadcastChannel() {
    if (this._bc) return;
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      const bc = new BroadcastChannel(BROADCAST_CHANNEL);
      const onMessage = (event) => {
        try {
          const data = event?.data;
          if (!data || typeof data !== 'object') return;
          const type = toCleanString(data.type);
          if (type !== 'lock-acquired') return;
          const scopeKey = toCleanString(data.scopeKey);
          const owner = toCleanString(data.owner);
          if (!scopeKey || !owner) return;
          if (!this._scopeKey || !this._lockKey) return;
          if (scopeKey !== this._scopeKey) return;
          const tabId = this.getTabId();
          if (owner === tabId) return;

          // Double-check current localStorage record to avoid false positives from raced broadcasts.
          const now = nowMs();
          const current = parseLockRecord(readLocalItem(this._lockKey) || '');
          if (current && !isExpired(current, now) && current.owner === tabId) return;

          this._handleLockLost('Another tab acquired the cross-tab lock.');
        } catch {
          // ignore
        }
      };
      bc.addEventListener('message', onMessage);
      this._bc = bc;
      this._bcListener = onMessage;
    } catch {
      this._bc = null;
      this._bcListener = null;
    }
  }

  _detachBroadcastChannel() {
    if (!this._bc) return;
    try {
      if (this._bcListener) this._bc.removeEventListener('message', this._bcListener);
    } catch {
      // ignore
    }
    try {
      this._bc.close();
    } catch {
      // ignore
    } finally {
      this._bc = null;
      this._bcListener = null;
    }
  }

  _broadcast(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (!this._bc) return;
    try {
      this._bc.postMessage(payload);
    } catch {
      // ignore
    }
  }

  _attachStorageListener() {
    if (this._storageListener) return;
    if (typeof window === 'undefined') return;
    const onStorage = (event) => {
      try {
        if (!event) return;
        if (!this._lockKey || !this._scopeKey) return;
        if (event.key !== this._lockKey) return;
        const tabId = this.getTabId();
        const now = nowMs();
        const current = parseLockRecord(String(event.newValue || '')) || parseLockRecord(readLocalItem(this._lockKey) || '');
        if (!current) return;
        if (isExpired(current, now)) return;
        if (current.owner !== tabId) {
          this._handleLockLost('Another tab acquired the cross-tab lock.');
        }
      } catch {
        // ignore
      }
    };
    this._storageListener = onStorage;
    try {
      window.addEventListener('storage', onStorage);
    } catch {
      this._storageListener = null;
    }
  }

  _detachStorageListener() {
    if (!this._storageListener) return;
    try {
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', this._storageListener);
      }
    } catch {
      // ignore
    } finally {
      this._storageListener = null;
    }
  }

  _handleLockLost(reason) {
    const scopeKey = this._scopeKey;
    this.release();
    this.emit('lost', {
      scopeKey,
      code: 'LOCK_LOST',
      message:
        'This tab lost the cross-tab lock for the current annotation project.\n' +
        'To prevent accidental overwrites or silent data loss, the app must disconnect from the annotation repo.\n\n' +
        `Reason: ${toCleanString(reason) || 'unknown'}\n\n` +
        'Fix: close other tabs/windows for this dataset/repo/user, then reconnect and Pull.',
    });
  }
}

let _singleton = null;

export function getCommunityAnnotationScopeLock() {
  if (_singleton) return _singleton;
  _singleton = new CommunityAnnotationScopeLock();
  return _singleton;
}
