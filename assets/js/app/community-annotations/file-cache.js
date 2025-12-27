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

const DB_NAME = 'cellucid_community_annotation_file_cache';
const DB_VERSION = 1;
const STORE_NAME = 'files';

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

function readShaIndex(scope) {
  const key = toFileShaIndexKey(scope);
  if (!key) return {};
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    const parsed = raw ? safeJsonParse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    /** @type {Record<string, string>} */
    const out = {};
    for (const [p, sha] of Object.entries(parsed)) {
      const path = toCleanString(p);
      const s = toCleanString(sha);
      if (!path || !s) continue;
      if (path.length > 512 || s.length > 128) continue;
      out[path] = s;
    }
    return out;
  } catch {
    return {};
  }
}

function writeShaIndex(scope, map) {
  const key = toFileShaIndexKey(scope);
  if (!key) return false;
  try {
    const next = (map && typeof map === 'object') ? map : {};
    const payload = JSON.stringify(next);
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, payload);
    return true;
  } catch {
    return false;
  }
}

function deleteShaIndex(scope) {
  const key = toFileShaIndexKey(scope);
  if (!key) return;
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export class CommunityAnnotationFileCache {
  constructor() {
    /** @type {IDBDatabase|null} */
    this._db = null;
    this._indexedDBAvailable = typeof indexedDB !== 'undefined';
    this._initPromise = null;
    /** @type {Map<string, Map<string, {sha:string, json:any, storedAt:number}>>} */
    this._mem = new Map();
  }

  /**
   * Open IndexedDB connection (idempotent).
   * @returns {Promise<void>}
   */
  async init() {
    if (this._db || !this._indexedDBAvailable) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._openDatabase()
      .then((db) => { this._db = db; })
      .catch(() => { this._indexedDBAvailable = false; })
      .finally(() => { this._initPromise = null; });
    return this._initPromise;
  }

  getCacheMode() {
    if (this._db) return 'indexeddb';
    if (this._indexedDBAvailable === false) return 'memory';
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

        request.onupgradeneeded = (event) => {
          const db = request.result;
          try {
            // Create store if it doesn't exist
            if (!db.objectStoreNames.contains(STORE_NAME)) {
              const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
              store.createIndex('scopeKey', 'scopeKey', { unique: false });
            } else {
              // Ensure index exists (upgrade safety)
              const store = request.transaction.objectStore(STORE_NAME);
              if (!store.indexNames.contains('scopeKey')) {
                store.createIndex('scopeKey', 'scopeKey', { unique: false });
              }
            }
          } catch (err) {
            try {
              request.transaction?.abort?.();
            } catch {
              // ignore
            }
            settleOnce(reject, err);
            return;
          }
        };

        request.onsuccess = () => settleOnce(resolve, request.result);
      } catch (err) {
        reject(err);
      }
    });
  }

  getKnownShas(scope, { prefixes = null } = {}) {
    const scopeKey = toCacheScopeKey(scope);
    if (!scopeKey) return {};

    const list = prefixes == null ? null : (Array.isArray(prefixes) ? prefixes : [prefixes]).map((p) => String(p || ''));
    const filter = (path, sha) => {
      if (!list) return true;
      return list.some((pfx) => path.startsWith(pfx));
    };

    // Persistent mode: use the localStorage-backed SHA index (fast).
    if (this._db) {
      const map = readShaIndex(scope);
      if (!list) return map;
      const out = {};
      for (const [path, sha] of Object.entries(map)) {
        if (filter(path, sha)) out[path] = sha;
      }
      return out;
    }

    // Memory-only fallback (e.g. IndexedDB blocked): derive known SHAs from the in-memory cache.
    const bucket = this._mem.get(scopeKey) || null;
    if (!bucket) return {};
    const out = {};
    for (const [path, rec] of bucket.entries()) {
      const p = toCleanString(path).replace(/^\/+/, '');
      const sha = toCleanString(rec?.sha);
      if (!p || !sha) continue;
      if (filter(p, sha)) out[p] = sha;
    }
    return out;
  }

  async getJson({ datasetId, repoRef, userId, path }) {
    await this.init();
    const p = toCleanString(path).replace(/^\/+/, '');
    const scope = { datasetId, repoRef, userId };
    const key = toFileRecordKey(scope, p);
    const scopeKey = toCacheScopeKey(scope);
    if (!key) return null;

    if (!scopeKey) return null;

    if (!this._db) {
      const bucket = this._mem.get(scopeKey) || null;
      const rec = bucket ? bucket.get(p) : null;
      const sha = toCleanString(rec?.sha);
      const json = rec?.json ?? null;
      if (!sha || !json || typeof json !== 'object') return null;
      return { sha, json };
    }

    return new Promise((resolve) => {
      try {
        const tx = this._db.transaction([STORE_NAME], 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => {
          const rec = req.result || null;
          if (!rec || typeof rec !== 'object') return resolve(null);
          const sha = toCleanString(rec.sha);
          const json = rec.json ?? null;
          if (!sha || !json || typeof json !== 'object') return resolve(null);
          resolve({ sha, json });
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async setJson({ datasetId, repoRef, userId, path, sha, json }) {
    await this.init();
    const p = toCleanString(path).replace(/^\/+/, '');
    const s = toCleanString(sha);
    const doc = json;
    const scope = { datasetId, repoRef, userId };
    const scopeKey = toCacheScopeKey(scope);
    const key = toFileRecordKey(scope, p);
    if (!scopeKey || !key || !s) return false;
    if (!doc || typeof doc !== 'object') return false;

    if (!this._db) {
      let bucket = this._mem.get(scopeKey) || null;
      if (!bucket) {
        bucket = new Map();
        this._mem.set(scopeKey, bucket);
      }
      bucket.set(p, { sha: s, json: doc, storedAt: Date.now() });
      return true;
    }

    const stored = await new Promise((resolve) => {
      try {
        const tx = this._db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put({
          key,
          scopeKey,
          path: p,
          sha: s,
          json: doc,
          storedAt: Date.now()
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });

    if (!stored) return false;

    // Update the sha index only after the JSON is safely stored.
    const idx = readShaIndex(scope);
    idx[p] = s;
    writeShaIndex(scope, idx);
    return true;
  }

  async deletePath({ datasetId, repoRef, userId, path }) {
    await this.init();
    const p = toCleanString(path).replace(/^\/+/, '');
    const scope = { datasetId, repoRef, userId };
    const key = toFileRecordKey(scope, p);
    const scopeKey = toCacheScopeKey(scope);
    if (!key) return false;
    if (!scopeKey) return false;

    if (!this._db) {
      const bucket = this._mem.get(scopeKey) || null;
      if (bucket) {
        bucket.delete(p);
        if (!bucket.size) this._mem.delete(scopeKey);
      }
      return true;
    }

    const ok = await new Promise((resolve) => {
      try {
        const tx = this._db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });

    const idx = readShaIndex(scope);
    if (idx[p]) {
      delete idx[p];
      writeShaIndex(scope, idx);
    }
    return ok;
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
    const list = Array.isArray(paths) ? paths : [];
    const scope = { datasetId, repoRef, userId };
    const scopeKey = toCacheScopeKey(scope);
    if (!scopeKey || !list.length) return {};

    /** @type {Record<string, {sha:string, json:any}>} */
    const out = {};
    for (const raw of list.slice(0, 10000)) {
      const p = toCleanString(raw).replace(/^\/+/, '');
      if (!p) continue;
      const hit = await this.getJson({ datasetId, repoRef, userId, path: p });
      if (hit?.sha && hit?.json) out[p] = hit;
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
    if (!scopeKey) return {};

    const pfxList = prefixes == null
      ? null
      : (Array.isArray(prefixes) ? prefixes : [prefixes]).map((p) => String(p || ''));

    /** @type {Record<string, {sha:string, json:any}>} */
    const out = {};

    if (!this._db) {
      const bucket = this._mem.get(scopeKey) || null;
      if (!bucket) return {};
      for (const [path, rec] of bucket.entries()) {
        const p = toCleanString(path).replace(/^\/+/, '');
        const sha = toCleanString(rec?.sha);
        const json = rec?.json ?? null;
        const okPrefix = !pfxList || pfxList.some((pfx) => p.startsWith(pfx));
        if (okPrefix && p && sha && json && typeof json === 'object') {
          out[p] = { sha, json };
        }
      }
      return out;
    }

    try {
      const range = (typeof IDBKeyRange !== 'undefined') ? IDBKeyRange.only(scopeKey) : null;
      if (!range) return {};

      await new Promise((resolve) => {
        const tx = this._db.transaction([STORE_NAME], 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('scopeKey');
        const req = index.openCursor(range);
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          const rec = cursor.value || null;
          const path = toCleanString(rec?.path).replace(/^\/+/, '');
          const sha = toCleanString(rec?.sha);
          const json = rec?.json ?? null;
          const okPrefix = !pfxList || pfxList.some((pfx) => path.startsWith(pfx));
          if (okPrefix && path && sha && json && typeof json === 'object') {
            out[path] = { sha, json };
          }
          cursor.continue();
        };
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      });
    } catch {
      return {};
    }

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
    const keep = keepPaths instanceof Set ? keepPaths : new Set();
    const scope = { datasetId, repoRef, userId };
    const scopeKey = toCacheScopeKey(scope);
    if (!scopeKey) return false;

    const idx = readShaIndex(scope);
    const keepSet = new Set([...keep].map((p) => toCleanString(p).replace(/^\/+/, '')).filter(Boolean));

    if (!this._db) {
      const bucket = this._mem.get(scopeKey) || null;
      if (bucket) {
        for (const p of [...bucket.keys()]) {
          const normalized = toCleanString(p).replace(/^\/+/, '');
          if (!normalized || keepSet.has(normalized)) continue;
          bucket.delete(p);
        }
        if (!bucket.size) this._mem.delete(scopeKey);
      }
      return true;
    }

    // Fast path: update sha index first; then best-effort delete content.
    let changed = false;
    for (const p of Object.keys(idx)) {
      if (keepSet.has(p)) continue;
      delete idx[p];
      changed = true;
    }
    if (changed) writeShaIndex(scope, idx);

    // Best-effort delete old records in IndexedDB.
    // (Failure here is not fatal; the sha index prevents skipping downloads for missing files.)
    try {
      await new Promise((resolve) => {
        const tx = this._db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('scopeKey');
        const req = index.openCursor(IDBKeyRange.only(scopeKey));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          const rec = cursor.value || null;
          const path = toCleanString(rec?.path);
          if (path && !keepSet.has(path)) cursor.delete();
          cursor.continue();
        };
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      });
    } catch {
      // ignore
    }
    return true;
  }

  async clearRepo({ datasetId, repoRef, userId }) {
    await this.init();
    const scope = { datasetId, repoRef, userId };
    const scopeKey = toCacheScopeKey(scope);
    if (!scopeKey) return true;
    deleteShaIndex(scope);
    this._mem.delete(scopeKey);
    if (!this._db) return true;

    try {
      await new Promise((resolve) => {
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
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      });
    } catch {
      // ignore
    }

    return true;
  }
}

let _cache = null;

export function getCommunityAnnotationFileCache() {
  if (_cache) return _cache;
  _cache = new CommunityAnnotationFileCache();
  return _cache;
}
