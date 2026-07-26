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
 * Lock records use only the exact current storage contract.
 */

import { EventEmitter } from '../utils/event-emitter.js';
import { parseExactJson } from './wire-contract.js';

const TAB_ID_KEY = 'cellucid:community-annotations:tab-id:v1';
const LOCK_PREFIX = 'cellucid:community-annotations:lock:';

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RENEW_MS = 15_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function assertExactString(value, label, { max = 2048 } = {}) {
  if (
    typeof value !== 'string' ||
    !value ||
    /^\s|\s$/.test(value) ||
    Array.from(value).length > max
  ) {
    throw new Error(`${label} must be an exact nonblank string`);
  }
  return value;
}

function storageFailure(storageName, operation, cause) {
  const error = new Error(
    `${storageName} ${operation} failed for the annotation scope lock`
  );
  error.code = 'LOCK_STORAGE_FAILED';
  error.cause = cause;
  return error;
}

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function createTabId() {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    const error = new Error(
      'crypto.randomUUID is required for exact cross-tab annotation locking'
    );
    error.code = 'LOCK_PLATFORM_UNAVAILABLE';
    throw error;
  }
  const id = crypto.randomUUID();
  if (!UUID_PATTERN.test(id)) {
    const error = new Error('crypto.randomUUID returned an invalid UUID');
    error.code = 'LOCK_PLATFORM_INVALID';
    throw error;
  }
  return id;
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
  } catch (cause) {
    throw storageFailure('sessionStorage', 'write', cause);
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
  } catch (cause) {
    throw storageFailure('localStorage', 'write', cause);
  }
}

function removeLocalItem(key) {
  try {
    if (typeof localStorage === 'undefined') {
      throw new Error('localStorage is unavailable');
    }
    localStorage.removeItem(key);
  } catch (cause) {
    throw storageFailure('localStorage', 'remove', cause);
  }
}

function normalizeScopeKey(scopeKey) {
  if (scopeKey === null || scopeKey === undefined || scopeKey === '') return null;
  return assertExactString(scopeKey, 'Annotation lock scope key', { max: 4096 });
}

function lockStorageKey(scopeKey) {
  return `${LOCK_PREFIX}${scopeKey}`;
}

function parseLockRecord(raw) {
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw === '') {
    throw new Error('Annotation scope lock record must be nonempty JSON text');
  }
  const parsed = parseExactJson(raw, { path: 'annotation scope lock record' });
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 3 ||
    !Object.hasOwn(parsed, 'owner') ||
    !Object.hasOwn(parsed, 'acquiredAt') ||
    !Object.hasOwn(parsed, 'expiresAtMs')
  ) {
    throw new Error(
      'Annotation scope lock record must contain exactly owner, acquiredAt, and expiresAtMs'
    );
  }
  const owner = assertExactString(parsed.owner, 'Annotation lock owner', { max: 36 });
  if (!UUID_PATTERN.test(owner)) {
    throw new Error('Annotation lock owner must be an exact UUID');
  }
  const acquiredAt = assertExactString(
    parsed.acquiredAt,
    'Annotation lock acquisition time',
    { max: 24 }
  );
  if (
    !UTC_INSTANT_PATTERN.test(acquiredAt) ||
    new Date(acquiredAt).toISOString() !== acquiredAt
  ) {
    throw new Error('Annotation lock acquisition time must be an exact UTC instant');
  }
  if (!Number.isSafeInteger(parsed.expiresAtMs) || parsed.expiresAtMs < 1) {
    throw new Error('Annotation lock expiry must be a positive safe integer');
  }
  return { owner, acquiredAt, expiresAtMs: parsed.expiresAtMs };
}

function isExpired(rec, now) {
  if (!rec) return true;
  return rec.expiresAtMs <= now;
}

export class CommunityAnnotationScopeLock extends EventEmitter {
  constructor({ leaseMs = DEFAULT_LEASE_MS, renewMs = DEFAULT_RENEW_MS } = {}) {
    super();
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 8_000) {
      throw new Error('Annotation lock leaseMs must be a safe integer of at least 8000');
    }
    if (
      !Number.isSafeInteger(renewMs) ||
      renewMs < 2_000 ||
      renewMs > leaseMs - 1_000
    ) {
      throw new Error(
        'Annotation lock renewMs must be a safe integer from 2000 through leaseMs - 1000'
      );
    }
    this._tabId = null;
    this._scopeKey = null;
    this._lockKey = null;
    this._leaseMs = leaseMs;
    this._renewMs = renewMs;
    this._renewTimer = null;
    this._renewTick = null;
    this._visibilityListener = null;
    this._storageListener = null;
  }

  getTabId() {
    if (this._tabId) return this._tabId;
    const stored = readSessionItem(TAB_ID_KEY);
    if (stored !== null) {
      const existing = assertExactString(stored, 'Annotation tab id', { max: 36 });
      if (!UUID_PATTERN.test(existing)) {
        throw new Error('Stored annotation tab id must be an exact UUID');
      }
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
    if (!key || !this._scopeKey || key !== this._scopeKey || !this._lockKey) {
      return false;
    }
    const current = parseLockRecord(readLocalItem(this._lockKey));
    return Boolean(
      current &&
      current.owner === this.getTabId() &&
      !isExpired(current, nowMs())
    );
  }

  release() {
    const key = this._lockKey;
    const scopeKey = this._scopeKey;
    const tabId = key && scopeKey ? this.getTabId() : null;
    this._stopRenew();
    this._detachStorageListener();
    this._lockKey = null;
    this._scopeKey = null;

    if (!key || !scopeKey) return { released: true };

    const existing = parseLockRecord(readLocalItem(key));
    if (existing && existing.owner === tabId) {
      removeLocalItem(key);
    }
    return { released: true };
  }

  setScopeKey(scopeKey) {
    let nextScopeKey;
    try {
      nextScopeKey = normalizeScopeKey(scopeKey);
      if (nextScopeKey === this._scopeKey) {
        try {
          if (nextScopeKey === null || this.isHolding(nextScopeKey)) {
            return { ok: true, scopeKey: nextScopeKey };
          }
        } catch (cause) {
          this.release();
          throw cause;
        }
      }
      this.release();
      if (!nextScopeKey) return { ok: true, scopeKey: null };
      return this._acquire(nextScopeKey);
    } catch (cause) {
      return {
        ok: false,
        code: cause?.code || 'LOCK_RECORD_INVALID',
        scopeKey: nextScopeKey ?? null,
        message: `Unable to establish the exact annotation scope lock: ${cause?.message || cause}`,
        cause,
      };
    }
  }

  _acquire(scopeKey) {
    const tabId = this.getTabId();
    const key = lockStorageKey(scopeKey);
    const now = nowMs();

    const existing = parseLockRecord(readLocalItem(key));
    if (existing && !isExpired(existing, now) && existing.owner !== tabId) {
      return {
        ok: false,
        code: 'LOCK_HELD',
        scopeKey,
          message:
          'Another browser tab/window is already connected to this annotation project.\n' +
          'To prevent accidental overwrites, this tab cannot connect.\n\n' +
          `Lock acquired: ${existing.acquiredAt}\n` +
          `Lease remaining: ~${Math.max(1, Math.round((existing.expiresAtMs - now) / 1000))}s.\n\n` +
          'Close the other Cellucid tab/window before starting a new connection.',
        holder: existing
      };
    }

    const record = {
      owner: tabId,
      acquiredAt: nowIso(),
      expiresAtMs: now + this._leaseMs
    };

    writeLocalItem(key, JSON.stringify(record));
    const confirmed = parseLockRecord(readLocalItem(key));
    if (!confirmed || confirmed.owner !== tabId || isExpired(confirmed, nowMs())) {
      return {
        ok: false,
        code: 'LOCK_VERIFY_FAILED',
        scopeKey,
        message:
          'Failed to acquire the cross-tab lock for this annotation project.\n' +
          'Another tab acquired it first. Close the other tab before starting a new connection.'
      };
    }

    this._scopeKey = scopeKey;
    this._lockKey = key;
    this._attachStorageListener();
    this._startRenew();
    if (!this.isHolding(scopeKey)) {
      return {
        ok: false,
        code: 'LOCK_VERIFY_FAILED',
        scopeKey,
        message: 'The annotation scope lock was lost during renewal setup',
      };
    }
    this._installUnloadRelease();

    return { ok: true, scopeKey };
  }

  _installUnloadRelease() {
    if (typeof window === 'undefined') return;
    window.addEventListener('pagehide', () => this.release(), { once: true });
  }

  _startRenew() {
    if (this._renewTimer) return;
    const tick = () => {
      if (!this._scopeKey || !this._lockKey) return;
      try {
        const tabId = this.getTabId();
        const now = nowMs();
        const current = parseLockRecord(readLocalItem(this._lockKey));

        if (!current || current.owner !== tabId || isExpired(current, now)) {
          this._handleLockLost('Lock expired or was taken by another tab.');
          return;
        }

        const next = {
          owner: tabId,
          acquiredAt: current.acquiredAt,
          expiresAtMs: now + this._leaseMs
        };
        writeLocalItem(this._lockKey, JSON.stringify(next));
      } catch (cause) {
        this._handleLockLost(
          `Exact lock renewal failed: ${cause?.message || cause}`
        );
      }
    };

    this._renewTick = tick;
    this._renewTimer = setInterval(tick, this._renewMs);
    this._attachVisibilityListener();
    tick();
  }

  _stopRenew() {
    if (!this._renewTimer) return;
    clearInterval(this._renewTimer);
    this._renewTimer = null;
    this._renewTick = null;
    this._detachVisibilityListener();
  }

  _attachVisibilityListener() {
    if (this._visibilityListener) return;
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      if (!this._renewTick) return;
      if (document.visibilityState && document.visibilityState !== 'visible') return;
      try {
        this._renewTick();
      } catch (cause) {
        this._handleLockLost(
          `Exact lock renewal failed after visibility change: ${cause?.message || cause}`
        );
      }
    };
    this._visibilityListener = onVisible;
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
  }

  _detachVisibilityListener() {
    if (!this._visibilityListener) return;
    document.removeEventListener('visibilitychange', this._visibilityListener);
    window.removeEventListener('focus', this._visibilityListener);
    this._visibilityListener = null;
  }

  _attachStorageListener() {
    if (this._storageListener) return;
    if (typeof window === 'undefined') return;
    const onStorage = (event) => {
      if (!event) return;
      if (!this._lockKey || !this._scopeKey) return;
      if (event.key !== this._lockKey) return;
      try {
        const tabId = this.getTabId();
        const now = nowMs();
        const current = event.newValue === null
          ? parseLockRecord(readLocalItem(this._lockKey))
          : parseLockRecord(event.newValue);
        if (!current || isExpired(current, now) || current.owner !== tabId) {
          this._handleLockLost(
            'The authoritative localStorage lock record was removed, expired, or replaced.'
          );
        }
      } catch (cause) {
        this._handleLockLost(
          `The authoritative localStorage lock record is invalid: ${cause?.message || cause}`
        );
      }
    };
    this._storageListener = onStorage;
    window.addEventListener('storage', onStorage);
  }

  _detachStorageListener() {
    if (!this._storageListener) return;
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this._storageListener);
    }
    this._storageListener = null;
  }

  _handleLockLost(reason) {
    const exactReason = assertExactString(reason, 'Annotation lock loss reason');
    const scopeKey = this._scopeKey;
    let cleanupError = null;
    try {
      this.release();
    } catch (cause) {
      cleanupError = cause;
    }
    this.emit('lost', {
      scopeKey,
      code: 'LOCK_LOST',
      message:
        'This tab lost the cross-tab lock for the current annotation project.\n' +
        'To prevent accidental overwrites or silent data loss, the app must disconnect from the annotation repo.\n\n' +
        `Reason: ${exactReason}\n` +
        (cleanupError
          ? `Lock cleanup also failed: ${cleanupError?.message || cleanupError}\n`
          : '') +
        '\n' +
        'Fix: close other tabs/windows for this dataset/repo/user, then reconnect and Pull.',
      cleanupError,
    });
  }
}

let _singleton = null;

export function getCommunityAnnotationScopeLock() {
  if (_singleton) return _singleton;
  _singleton = new CommunityAnnotationScopeLock();
  return _singleton;
}
