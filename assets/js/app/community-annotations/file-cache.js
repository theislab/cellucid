/**
 * Community Annotation - Local file cache (raw GitHub repo files).
 *
 * Purpose
 * -------
 * Cellucid's community annotation model stores one file per user under
 * `annotations/users/` plus an optional author-only merges file under
 * `annotations/moderation/merges.json`.
 *
 * On Pull, we want to:
 * - Avoid re-downloading files that have not changed (use GitHub `sha` values).
 * - Still be able to rebuild the merged view deterministically from *all* raw files,
 *   even if no files changed on the server (no "compiled output" stored in Git).
 *
 * This cache stores the raw JSON documents keyed by:
 * - Cache scope: `{ datasetId, repoRef, userId }`
 *   - `datasetId`: current dataset
 *   - `repoRef`:   "owner/repo@branch" (branch included to avoid mixing different histories)
 *   - `userId`:    GitHub numeric user id (multi-user isolation; NOT login/username)
 * - `path`:   "annotations/users/ghid_<id>.json" or "annotations/moderation/merges.json"
 *
 * Storage strategy
 * ----------------
 * - Content lives in IndexedDB (large, async, persistent).
 * - A small path->sha index is mirrored in localStorage for fast "knownShas" lookup.
 *
 * Security
 * --------
 * - No tokens are stored.
 * - Does not touch the DOM.
 */

import { toCacheScopeKey, toFileRecordKey, toFileShaIndexKey } from './cache-scope.js';
import {
  assertMergesDocument,
  assertUserDocument,
  parseExactJson,
} from './wire-contract.js';

const DB_NAME = 'cellucid_community_annotation_file_cache';
const DB_VERSION = 1;
const STORE_NAME = 'files';

function cacheUnavailable(message, cause = null) {
  const error = new Error(message);
  error.code = 'LOCAL_RAW_CACHE_UNAVAILABLE';
  if (cause) error.cause = cause;
  return error;
}

function abortTransactionAfterFailure(transaction, primaryError, context) {
  let cleanupError = null;
  try {
    if (!transaction || typeof transaction.abort !== 'function') {
      throw new TypeError(`${context} transaction must expose abort()`);
    }
    transaction.abort();
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError === null) return primaryError;
  return new AggregateError(
    [primaryError, cleanupError],
    `${context} failed and its IndexedDB transaction could not be aborted`
  );
}

function assertCachePath(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 512) {
    throw new Error('Community annotation cache path must be an exact string');
  }
  if (
    value !== 'annotations/moderation/merges.json' &&
    !/^annotations\/users\/ghid_[1-9][0-9]*\.json$/.test(value)
  ) {
    throw new Error(`Unsupported community annotation cache path ${JSON.stringify(value)}`);
  }
  return value;
}

function assertCacheSha(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('Community annotation cache SHA must be exactly 40 lowercase hexadecimal characters');
  }
  return value;
}

function assertCachePrefixes(value) {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new Error('Community annotation cache prefixes must be an array or null');
  }
  const allowed = new Set([
    'annotations/users/',
    'annotations/moderation/',
  ]);
  const seen = new Set();
  return value.map((prefix, index) => {
    if (!allowed.has(prefix)) {
      throw new Error(
        `Community annotation cache prefix ${index} is not supported`
      );
    }
    if (seen.has(prefix)) {
      throw new Error(
        `Community annotation cache prefix ${JSON.stringify(prefix)} is duplicated`
      );
    }
    seen.add(prefix);
    return prefix;
  });
}

function assertCacheDocument(path, document) {
  if (path === 'annotations/moderation/merges.json') {
    assertMergesDocument(document, { path });
    return document;
  }
  const filename = path.slice('annotations/users/'.length);
  assertUserDocument(document, { path, filename });
  return document;
}

function assertAbortSignalOrNull(signal) {
  if (signal === null) return null;
  if (
    typeof signal !== 'object' ||
    typeof signal.addEventListener !== 'function' ||
    typeof signal.removeEventListener !== 'function' ||
    typeof signal.aborted !== 'boolean'
  ) {
    throw new TypeError(
      'Community annotation cache signal must be an AbortSignal or null'
    );
  }
  return signal;
}

function cacheWriteAborted() {
  const error = new Error('Community annotation cache batch write aborted');
  error.code = 'LOCAL_RAW_CACHE_WRITE_ABORTED';
  return error;
}

function assertCacheRecord(record, { key, scopeKey, path }) {
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    Object.keys(record).length !== 6 ||
    !Object.hasOwn(record, 'key') ||
    !Object.hasOwn(record, 'scopeKey') ||
    !Object.hasOwn(record, 'path') ||
    !Object.hasOwn(record, 'sha') ||
    !Object.hasOwn(record, 'json') ||
    !Object.hasOwn(record, 'storedAt')
  ) {
    throw new Error(
      'Community annotation IndexedDB record must contain exactly key, scopeKey, path, sha, json, and storedAt'
    );
  }
  if (
    record.key !== key ||
    record.scopeKey !== scopeKey ||
    record.path !== path
  ) {
    throw new Error(
      'Community annotation IndexedDB record identity does not match its cache key'
    );
  }
  if (!Number.isSafeInteger(record.storedAt) || record.storedAt < 0) {
    throw new Error(
      'Community annotation IndexedDB record storedAt must be a nonnegative safe integer'
    );
  }
  return {
    sha: assertCacheSha(record.sha),
    json: assertCacheDocument(path, record.json),
  };
}

function readShaIndex(scope) {
  const key = toFileShaIndexKey(scope);
  if (!key) throw new Error('Community annotation cache scope is incomplete');
  if (typeof localStorage === 'undefined') {
    throw cacheUnavailable('localStorage is unavailable for the annotation SHA index');
  }
  const raw = localStorage.getItem(key);
  if (raw === null) return {};
  let parsed;
  try {
    parsed = parseExactJson(raw, { path: `annotation SHA index ${key}` });
  } catch (error) {
    const invalid = new Error(`Invalid community annotation SHA index JSON at ${key}`);
    invalid.code = 'LOCAL_RAW_CACHE_CORRUPT';
    invalid.cause = error;
    throw invalid;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const invalid = new Error(`Community annotation SHA index at ${key} must be an object`);
    invalid.code = 'LOCAL_RAW_CACHE_CORRUPT';
    throw invalid;
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [path, sha] of Object.entries(parsed)) {
    try {
      assertCachePath(path);
      assertCacheSha(sha);
    } catch (cause) {
      const invalid = new Error(`Community annotation SHA index at ${key} is invalid`);
      invalid.code = 'LOCAL_RAW_CACHE_CORRUPT';
      invalid.cause = cause;
      throw invalid;
    }
    out[path] = sha;
  }
  return out;
}

function writeShaIndex(scope, map) {
  const key = toFileShaIndexKey(scope);
  if (!key) throw new Error('Community annotation cache scope is incomplete');
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('Community annotation SHA index must be an object');
  }
  for (const [path, sha] of Object.entries(map)) {
    assertCachePath(path);
    assertCacheSha(sha);
  }
  const payload = JSON.stringify(map);
  if (typeof localStorage === 'undefined') {
    throw new Error('localStorage is unavailable for the annotation SHA index');
  }
  localStorage.setItem(key, payload);
  return true;
}

function deleteShaIndex(scope) {
  const key = toFileShaIndexKey(scope);
  if (!key) throw new Error('Community annotation cache scope is incomplete');
  if (typeof localStorage === 'undefined') {
    throw cacheUnavailable('localStorage is unavailable for the annotation SHA index');
  }
  localStorage.removeItem(key);
}

export class CommunityAnnotationFileCache {
  constructor() {
    /** @type {IDBDatabase|null} */
    this._db = null;
    this._indexedDBAvailable = typeof indexedDB !== 'undefined';
    this._initPromise = null;
  }

  /**
   * Open IndexedDB connection (idempotent).
   * @returns {Promise<void>}
   */
  async init() {
    if (this._db) return;
    if (!this._indexedDBAvailable) {
      throw cacheUnavailable(
        'IndexedDB is required for the community annotation raw-file cache'
      );
    }
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._openDatabase()
      .then((db) => {
        this._db = db;
      })
      .catch((cause) => {
        throw cacheUnavailable(
          'Unable to open the community annotation IndexedDB cache',
          cause
        );
      })
      .finally(() => {
        this._initPromise = null;
      });
    return this._initPromise;
  }

  getCacheMode() {
    if (this._db) return 'indexeddb';
    if (this._indexedDBAvailable === false) return 'unavailable';
    return 'unknown';
  }

  _openDatabase() {
    return new Promise((resolve, reject) => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        let settled = false;
        const settleOnce = (fn, value) => {
          if (settled) return;
          settled = true;
          fn(value);
        };

        request.onerror = () => settleOnce(reject, request.error || new Error('IndexedDB open failed'));
        request.onblocked = () => settleOnce(
          reject,
          new Error('IndexedDB upgrade is blocked by another Cellucid tab')
        );

        request.onupgradeneeded = () => {
          const db = request.result;
          try {
            if (db.objectStoreNames.contains(STORE_NAME)) {
              throw new Error('Unexpected pre-existing annotation cache store');
            }
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            store.createIndex('scopeKey', 'scopeKey', { unique: false });
          } catch (err) {
            settleOnce(
              reject,
              abortTransactionAfterFailure(
                request.transaction,
                err,
                'Community annotation cache upgrade'
              )
            );
            return;
          }
        };

        request.onsuccess = () => {
          if (settled) {
            request.result.close();
            return;
          }
          settleOnce(resolve, request.result);
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  getKnownShas(scope, { prefixes = null } = {}) {
    const scopeKey = toCacheScopeKey(scope);
    if (!scopeKey) return {};
    if (!this._db) {
      throw cacheUnavailable('Community annotation raw-file cache is not initialized');
    }

    const list = assertCachePrefixes(prefixes);
    const filter = (path) => {
      if (!list) return true;
      return list.some((pfx) => path.startsWith(pfx));
    };

    const map = readShaIndex(scope);
    if (!list) return map;
    const out = {};
    for (const [path, sha] of Object.entries(map)) {
      if (filter(path)) out[path] = sha;
    }
    return out;
  }

  async getJson({ datasetId, repoRef, userId, path }) {
    await this.init();
    const p = assertCachePath(path);
    const scope = { datasetId, repoRef, userId };
    const key = toFileRecordKey(scope, p);
    const scopeKey = toCacheScopeKey(scope);
    if (!key || !scopeKey) throw new Error('Community annotation cache scope is incomplete');
    if (!this._db) throw cacheUnavailable('Community annotation raw-file cache is not initialized');

    return new Promise((resolve, reject) => {
      try {
        const tx = this._db.transaction([STORE_NAME], 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => {
          try {
            const rec = req.result ?? null;
            if (rec === null) {
              const idx = readShaIndex(scope);
              if (Object.hasOwn(idx, p)) {
                const invalid = new Error(
                  `Community annotation cache record ${JSON.stringify(p)} is missing`
                );
                invalid.code = 'LOCAL_RAW_CACHE_CORRUPT';
                reject(invalid);
                return;
              }
              resolve(null);
              return;
            }
            try {
              const exact = assertCacheRecord(rec, {
                key,
                scopeKey,
                path: p,
              });
              resolve(exact);
            } catch (cause) {
              const invalid = new Error(
                `Community annotation cache record ${JSON.stringify(p)} is invalid`
              );
              invalid.code = 'LOCAL_RAW_CACHE_CORRUPT';
              invalid.cause = cause;
              reject(invalid);
              return;
            }
          } catch (error) {
            reject(error);
          }
        };
        req.onerror = () => reject(req.error || new Error('IndexedDB cache read failed'));
      } catch (error) {
        reject(error);
      }
    });
  }

  async setJson({ datasetId, repoRef, userId, path, sha, json }) {
    await this.setManyJson({
      datasetId,
      repoRef,
      userId,
      records: [{ path, sha, json }],
    });
    return true;
  }

  /**
   * Persist one complete validated batch with one IndexedDB transaction and one
   * SHA-index read/commit.
   *
   * @param {object} params
   * @param {string} params.datasetId
   * @param {string} params.repoRef
   * @param {number} params.userId
   * @param {{path:string,sha:string,json:any}[]} params.records
   * @param {AbortSignal|null} [params.signal]
   */
  async setManyJson({
    datasetId,
    repoRef,
    userId,
    records,
    signal = null,
  }) {
    const ownerSignal = assertAbortSignalOrNull(signal);
    if (ownerSignal?.aborted) throw cacheWriteAborted();
    await this.init();
    if (ownerSignal?.aborted) throw cacheWriteAborted();
    if (!Array.isArray(records)) {
      throw new TypeError(
        'Community annotation cache batch records must be an array'
      );
    }
    const scope = { datasetId, repoRef, userId };
    const scopeKey = toCacheScopeKey(scope);
    if (!scopeKey) {
      throw new Error('Community annotation cache scope is incomplete');
    }
    if (!this._db) throw cacheUnavailable('Community annotation raw-file cache is not initialized');

    const seenPaths = new Set();
    const storedAt = Date.now();
    const exactRecords = records.map((record, index) => {
      if (
        !record ||
        typeof record !== 'object' ||
        Array.isArray(record) ||
        Object.keys(record).length !== 3 ||
        !Object.hasOwn(record, 'path') ||
        !Object.hasOwn(record, 'sha') ||
        !Object.hasOwn(record, 'json')
      ) {
        throw new Error(
          `Community annotation cache batch record ${index} must contain exactly path, sha, and json`
        );
      }
      const path = assertCachePath(record.path);
      if (seenPaths.has(path)) {
        throw new Error(
          `Community annotation cache batch path ${JSON.stringify(path)} is duplicated`
        );
      }
      seenPaths.add(path);
      const sha = assertCacheSha(record.sha);
      const json = assertCacheDocument(path, record.json);
      const key = toFileRecordKey(scope, path);
      if (!key) {
        throw new Error('Community annotation cache scope is incomplete');
      }
      return {
        key,
        scopeKey,
        path,
        sha,
        json,
        storedAt,
      };
    });
    if (exactRecords.length === 0) return true;

    await new Promise((resolve, reject) => {
      let settled = false;
      let tx = null;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        ownerSignal?.removeEventListener('abort', abort);
        callback(value);
      };
      const abort = () => {
        if (settled) return;
        try {
          if (tx === null || typeof tx.abort !== 'function') {
            throw new TypeError(
              'Community annotation cache batch transaction must expose abort()'
            );
          }
          tx.abort();
        } catch {
          settle(reject, cacheWriteAborted());
        }
      };
      try {
        tx = this._db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const record of exactRecords) store.put(record);
        tx.oncomplete = () => settle(resolve, true);
        tx.onerror = () => {
          const primary =
            tx.error || new Error('IndexedDB cache batch write failed');
          settle(
            reject,
            abortTransactionAfterFailure(
              tx,
              primary,
              'Community annotation cache batch write'
            )
          );
        };
        tx.onabort = () => settle(
          reject,
          ownerSignal?.aborted
            ? cacheWriteAborted()
            : (tx.error || new Error('IndexedDB cache batch write aborted'))
        );
        ownerSignal?.addEventListener('abort', abort, { once: true });
        if (ownerSignal?.aborted) abort();
      } catch (error) {
        settle(
          reject,
          tx === null
            ? error
            : abortTransactionAfterFailure(
              tx,
              error,
              'Community annotation cache batch write'
            )
        );
      }
    });

    if (ownerSignal?.aborted) throw cacheWriteAborted();
    // Update the SHA index only after every JSON record is safely stored.
    const idx = readShaIndex(scope);
    for (const record of exactRecords) {
      idx[record.path] = record.sha;
    }
    writeShaIndex(scope, idx);
    return true;
  }

  async deletePath({ datasetId, repoRef, userId, path }) {
    await this.init();
    const p = assertCachePath(path);
    const scope = { datasetId, repoRef, userId };
    const key = toFileRecordKey(scope, p);
    const scopeKey = toCacheScopeKey(scope);
    if (!key || !scopeKey) throw new Error('Community annotation cache scope is incomplete');
    if (!this._db) throw cacheUnavailable('Community annotation raw-file cache is not initialized');

    await new Promise((resolve, reject) => {
      try {
        const tx = this._db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB cache delete failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB cache delete aborted'));
      } catch (error) {
        reject(error);
      }
    });

    const idx = readShaIndex(scope);
    if (Object.hasOwn(idx, p)) {
      delete idx[p];
      writeShaIndex(scope, idx);
    }
    return true;
  }

  /**
   * Fetch many cached JSON documents.
   *
   * @param {object} params
   * @param {string} params.datasetId
   * @param {string} params.repoRef - "owner/repo@branch"
   * @param {number|string} params.userId - GitHub numeric user id
   * @param {string[]} params.paths - repository-relative paths
   * @returns {Promise<Record<string, {sha:string, json:any}>>} map of found docs by path
   */
  async getManyJson({ datasetId, repoRef, userId, paths }) {
    await this.init();
    if (!Array.isArray(paths)) {
      throw new Error('Community annotation cache paths must be an array');
    }
    const list = paths.map(assertCachePath);
    const scope = { datasetId, repoRef, userId };
    const scopeKey = toCacheScopeKey(scope);
    if (!scopeKey) throw new Error('Community annotation cache scope is incomplete');
    if (!list.length) return {};

    /** @type {Record<string, {sha:string, json:any}>} */
    const out = {};
    for (const p of list) {
      const hit = await this.getJson({ datasetId, repoRef, userId, path: p });
      if (hit !== null) out[p] = hit;
    }
    return out;
  }

  /**
   * Fetch all cached JSON docs for a cache scope (optionally filtered by path prefixes).
   *
   * This is optimized for the "rebuild from scratch on Pull" flow where we want
   * all user files without issuing thousands of individual IndexedDB `get()` calls.
   *
   * @param {object} params
   * @param {string} params.datasetId
   * @param {string} params.repoRef - "owner/repo@branch"
   * @param {number|string} params.userId - GitHub numeric user id
   * @param {string[]|string|null} [params.prefixes]
   * @returns {Promise<Record<string, {sha:string, json:any}>>}
   */
  async getAllJsonForRepo({ datasetId, repoRef, userId, prefixes = null } = {}) {
    await this.init();
    const scope = { datasetId, repoRef, userId };
    const scopeKey = toCacheScopeKey(scope);
    if (!scopeKey) throw new Error('Community annotation cache scope is incomplete');
    if (!this._db) throw cacheUnavailable('Community annotation raw-file cache is not initialized');

    const pfxList = assertCachePrefixes(prefixes);

    /** @type {Record<string, {sha:string, json:any}>} */
    const out = {};

    const range = (typeof IDBKeyRange !== 'undefined') ? IDBKeyRange.only(scopeKey) : null;
    if (!range) throw new Error('IDBKeyRange is unavailable');

    await new Promise((resolve, reject) => {
      try {
        const tx = this._db.transaction([STORE_NAME], 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('scopeKey');
        const req = index.openCursor(range);
        req.onsuccess = () => {
          try {
            const cursor = req.result;
            if (!cursor) return;
            const rec = cursor.value ?? null;
            let path;
            let sha;
            let json;
            try {
              path = assertCachePath(rec?.path);
              const key = toFileRecordKey(scope, path);
              if (key === null) {
                throw new Error(
                  'Community annotation cache record key cannot be resolved'
                );
              }
              const exact = assertCacheRecord(rec, {
                key,
                scopeKey,
                path,
              });
              sha = exact.sha;
              json = exact.json;
            } catch (cause) {
              const invalid = new Error('Community annotation IndexedDB cache contains an invalid record');
              invalid.code = 'LOCAL_RAW_CACHE_CORRUPT';
              invalid.cause = cause;
              throw invalid;
            }
            const okPrefix = !pfxList || pfxList.some((pfx) => path.startsWith(pfx));
            if (okPrefix) {
              if (Object.hasOwn(out, path)) {
                const invalid = new Error(
                  `Community annotation IndexedDB cache contains duplicate path ${JSON.stringify(path)}`
                );
                invalid.code = 'LOCAL_RAW_CACHE_CORRUPT';
                throw invalid;
              }
              out[path] = { sha, json };
            }
            cursor.continue();
          } catch (error) {
            reject(
              abortTransactionAfterFailure(
                tx,
                error,
                'Community annotation cache scan'
              )
            );
          }
        };
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB cache scan failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB cache scan aborted'));
      } catch (error) {
        reject(error);
      }
    });

    return out;
  }

  /**
   * Remove cached files that no longer exist in the remote repo (or are no longer relevant).
   *
   * @param {object} params
   * @param {string} params.datasetId
   * @param {string} params.repoRef - "owner/repo@branch"
   * @param {number|string} params.userId - GitHub numeric user id
   * @param {Set<string>} params.keepPaths - repository-relative paths
   */
  async pruneToPaths({ datasetId, repoRef, userId, keepPaths }) {
    await this.init();
    if (!(keepPaths instanceof Set)) {
      throw new Error('Community annotation cache keepPaths must be a Set');
    }
    const scope = { datasetId, repoRef, userId };
    const scopeKey = toCacheScopeKey(scope);
    if (!scopeKey) throw new Error('Community annotation cache scope is incomplete');
    if (!this._db) throw cacheUnavailable('Community annotation raw-file cache is not initialized');

    const idx = readShaIndex(scope);
    const keepSet = new Set([...keepPaths].map(assertCachePath));

    let changed = false;
    for (const p of Object.keys(idx)) {
      if (keepSet.has(p)) continue;
      delete idx[p];
      changed = true;
    }
    await new Promise((resolve, reject) => {
      try {
        const tx = this._db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('scopeKey');
        const req = index.openCursor(IDBKeyRange.only(scopeKey));
        req.onsuccess = () => {
          try {
            const cursor = req.result;
            if (!cursor) return;
            const rec = cursor.value || null;
            let path;
            try {
              path = assertCachePath(rec?.path);
            } catch (cause) {
              const invalid = new Error('Community annotation IndexedDB cache contains an invalid path');
              invalid.code = 'LOCAL_RAW_CACHE_CORRUPT';
              invalid.cause = cause;
              throw invalid;
            }
            if (!keepSet.has(path)) cursor.delete();
            cursor.continue();
          } catch (error) {
            reject(
              abortTransactionAfterFailure(
                tx,
                error,
                'Community annotation cache prune'
              )
            );
          }
        };
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB cache prune failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB cache prune aborted'));
      } catch (error) {
        reject(error);
      }
    });
    if (changed) writeShaIndex(scope, idx);
    return true;
  }

  async clearRepo({ datasetId, repoRef, userId }) {
    await this.init();
    const scope = { datasetId, repoRef, userId };
    const scopeKey = toCacheScopeKey(scope);
    if (!scopeKey) throw new Error('Community annotation cache scope is incomplete');
    if (!this._db) throw cacheUnavailable('Community annotation raw-file cache is not initialized');

    // Invalidate the SHA advertisement first. If the IndexedDB deletion fails,
    // the next Pull must still download every remote file instead of trusting
    // stale records and entering a permanent skip/fail loop.
    deleteShaIndex(scope);
    await new Promise((resolve, reject) => {
      try {
        const tx = this._db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('scopeKey');
        const req = index.openCursor(IDBKeyRange.only(scopeKey));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB cache clear failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB cache clear aborted'));
      } catch (error) {
        reject(error);
      }
    });

    return true;
  }
}

let _cache = null;

export function getCommunityAnnotationFileCache() {
  if (_cache) return _cache;
  _cache = new CommunityAnnotationFileCache();
  return _cache;
}
