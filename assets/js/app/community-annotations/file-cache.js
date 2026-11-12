/**
 * Community Annotation - local cache of the files a Pull read.
 *
 * A repository holds one file per contributor under `annotations/users/`
 * and an optional `annotations/moderation/merges.json`. A Pull reads only the
 * files whose Git blob id changed since the last Pull, and rebuilds the
 * merged view from this cache, so a Pull where little changed downloads
 * little (`github-sync.js`).
 *
 * What is kept, per cache scope `{ datasetId, repoRef, userId }`
 * (`cache-scope.js`: the open dataset, `owner/repo@branch`, the signed-in
 * GitHub user):
 *
 * - **One record per file** (store `files`, key `[scopeKey, path, sha]`, so
 *   the blob ids a scope knows are read with one `getAllKeys`, no record
 *   bodies): either the file's dataset view (`view`: the open dataset's part
 *   of a user file, `projectUserFile`; the open dataset's merges,
 *   `projectMergesFile`) or, for a file the Pull excluded, why
 *   (`rejection: {code, message}`). Both are facts about a blob id, so an
 *   excluded file is not read again until it changes. Records are written as
 *   each batch of a Pull arrives: an interrupted Pull keeps them, and the next
 *   one reads only the rest.
 * - **The last completed Pull** (store `pulls`, one marker per scope): the
 *   commit and the `annotations` / `annotations/users` tree ids it read and
 *   the paths it ignored. A Pull that finds the same `annotations` tree stops
 *   at once; one that finds the same users tree does not list it again. A
 *   Pull deletes the marker before it writes its first record, so a marker
 *   always describes exactly the records kept.
 *
 * Content lives in IndexedDB only (no localStorage index). No token is
 * stored; nothing here touches the DOM.
 */

import { toCacheScopeKey } from './cache-scope.js';
import { assertMergesDocument, assertUserDocument } from './wire-contract.js';
import { abortReason, onAbort, throwIfAborted, requireSignalOrNull } from '../../utils/abort.js';

const DB_NAME = 'cellucid_community_annotation_file_cache';
/** Version 2: records keyed by blob id, with quarantine verdicts and Pull markers. */
const DB_VERSION = 2;
const FILES = 'files';
const PULLS = 'pulls';

export const ANNOTATION_MERGES_PATH = 'annotations/moderation/merges.json';
const USER_FILE_PATH = /^annotations\/users\/ghid_[1-9][0-9]*\.json$/;
const GIT_OID = /^[0-9a-f]{40}$/;

function cacheUnavailable(message, cause = null) {
  const error = new Error(message);
  error.code = 'LOCAL_RAW_CACHE_UNAVAILABLE';
  if (cause) error.cause = cause;
  return error;
}

function cacheCorrupt(message, cause = undefined) {
  const error = new Error(message);
  error.code = 'LOCAL_RAW_CACHE_CORRUPT';
  if (cause !== undefined) error.cause = cause;
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

export function isCachedAnnotationPath(value) {
  return value === ANNOTATION_MERGES_PATH || (typeof value === 'string' && USER_FILE_PATH.test(value));
}

function assertCachePath(value) {
  if (!isCachedAnnotationPath(value)) {
    throw new Error(`Unsupported community annotation cache path ${JSON.stringify(value)}`);
  }
  return value;
}

function assertCacheSha(value) {
  if (typeof value !== 'string' || !GIT_OID.test(value)) {
    throw new Error('Community annotation cache SHA must be exactly 40 lowercase hexadecimal characters');
  }
  return value;
}

function assertExactText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

function assertRejection(value, label) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'code') ||
    !Object.hasOwn(value, 'message')
  ) {
    throw new Error(`${label} must contain exactly code and message`);
  }
  assertExactText(value.code, `${label}.code`);
  assertExactText(value.message, `${label}.message`);
  return value;
}

function assertCachedView(path, view) {
  if (path === ANNOTATION_MERGES_PATH) {
    assertMergesDocument(view, { path });
  } else {
    assertUserDocument(view, { path, filename: path.slice('annotations/users/'.length) });
  }
  return view;
}

/** One file's record as a caller gives it: `{path, sha, view}` or `{path, sha, rejection}`. */
function exactInputRecord(record, index) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`Community annotation cache record ${index} must be an object`);
  }
  const keys = Object.keys(record).sort().join(',');
  if (keys !== 'path,sha,view' && keys !== 'path,rejection,sha') {
    throw new Error(
      `Community annotation cache record ${index} must contain exactly path, sha and either view or rejection`
    );
  }
  const path = assertCachePath(record.path);
  const sha = assertCacheSha(record.sha);
  if (Object.hasOwn(record, 'view')) {
    return { path, sha, view: assertCachedView(path, record.view), rejection: null };
  }
  return {
    path,
    sha,
    view: null,
    rejection: assertRejection(record.rejection, `Community annotation cache record ${index}.rejection`),
  };
}

/** A stored record, checked against the key it was read under. */
function exactStoredRecord(record, scopeKey) {
  if (
    record === null ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    Object.keys(record).sort().join(',') !== 'path,rejection,scopeKey,sha,storedAt,view'
  ) {
    throw new Error(
      'Community annotation IndexedDB record must contain exactly scopeKey, path, sha, view, rejection and storedAt'
    );
  }
  if (record.scopeKey !== scopeKey) {
    throw new Error('Community annotation IndexedDB record belongs to another cache scope');
  }
  const path = assertCachePath(record.path);
  const sha = assertCacheSha(record.sha);
  if (!Number.isSafeInteger(record.storedAt) || record.storedAt < 0) {
    throw new Error('Community annotation IndexedDB record storedAt must be a nonnegative safe integer');
  }
  if ((record.view === null) === (record.rejection === null)) {
    throw new Error('Community annotation IndexedDB record holds exactly one of view and rejection');
  }
  return {
    path,
    sha,
    view: record.view === null ? null : assertCachedView(path, record.view),
    rejection: record.rejection === null ? null : assertRejection(record.rejection, 'Cached rejection'),
  };
}

function assertIgnoredList(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(',') !== 'path,reason'
    ) {
      throw new Error(`${label}[${index}] must contain exactly path and reason`);
    }
    return {
      path: assertExactText(entry.path, `${label}[${index}].path`),
      reason: assertExactText(entry.reason, `${label}[${index}].reason`),
    };
  });
}

const MARKER_KEYS = 'annotationsOid,commitOid,completedAt,ignored,scopeKey,usersOid';

function exactMarker(value, scopeKey) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== MARKER_KEYS ||
    value.scopeKey !== scopeKey
  ) {
    throw new Error('Community annotation Pull marker must contain exactly its scope, commit, tree ids, ignored paths and completion time');
  }
  assertCacheSha(value.commitOid);
  assertCacheSha(value.annotationsOid);
  assertCacheSha(value.usersOid);
  if (!Number.isSafeInteger(value.completedAt) || value.completedAt < 0) {
    throw new Error('Community annotation Pull marker completedAt must be a nonnegative safe integer');
  }
  return {
    commitOid: value.commitOid,
    annotationsOid: value.annotationsOid,
    usersOid: value.usersOid,
    ignored: assertIgnoredList(value.ignored, 'Community annotation Pull marker ignored'),
    completedAt: value.completedAt,
  };
}

/** A holder whose `value` is a read request's result once it succeeds (its failure fails the transaction). */
function resultOf(request) {
  const holder = { value: undefined };
  request.onsuccess = () => {
    holder.value = request.result;
  };
  return holder;
}

export class CommunityAnnotationFileCache {
  /**
   * @param {{indexedDB?: IDBFactory|null, keyRange?: typeof IDBKeyRange|null}} [options]
   *   the IndexedDB factory and key ranges (the page's by default; tests give
   *   their own)
   */
  constructor({ indexedDB: factory = null, keyRange = null } = {}) {
    /** @type {IDBDatabase|null} */
    this._db = null;
    this._factory = factory ?? (typeof indexedDB === 'undefined' ? null : indexedDB);
    this._keyRange = keyRange ?? (typeof IDBKeyRange === 'undefined' ? null : IDBKeyRange);
    this._initPromise = null;
  }

  /** Open the database (idempotent). */
  async init() {
    if (this._db) return;
    if (this._factory === null || this._keyRange === null) {
      throw cacheUnavailable('IndexedDB is required for the community annotation file cache');
    }
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._openDatabase()
      .then((db) => {
        this._db = db;
      })
      .catch((cause) => {
        throw cacheUnavailable('Unable to open the community annotation IndexedDB cache', cause);
      })
      .finally(() => {
        this._initPromise = null;
      });
    return this._initPromise;
  }

  getCacheMode() {
    if (this._db) return 'indexeddb';
    if (this._factory === null) return 'unavailable';
    return 'unknown';
  }

  _openDatabase() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settleOnce = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      try {
        const request = this._factory.open(DB_NAME, DB_VERSION);
        request.onerror = () => settleOnce(reject, request.error || new Error('IndexedDB open failed'));
        request.onblocked = () => settleOnce(reject, new Error('IndexedDB upgrade is blocked by another Cellucid tab'));
        request.onupgradeneeded = () => {
          const db = request.result;
          try {
            // A cache, regenerated by the next Pull: an earlier layout is
            // dropped whole, never read.
            for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
            db.createObjectStore(FILES, { keyPath: ['scopeKey', 'path', 'sha'] });
            db.createObjectStore(PULLS, { keyPath: 'scopeKey' });
          } catch (error) {
            settleOnce(reject, abortTransactionAfterFailure(request.transaction, error, 'Community annotation cache upgrade'));
          }
        };
        request.onsuccess = () => {
          if (settled) {
            request.result.close();
            return;
          }
          settleOnce(resolve, request.result);
        };
      } catch (error) {
        settleOnce(reject, error);
      }
    });
  }

  _scopeKey(scope) {
    const scopeKey = toCacheScopeKey(scope);
    if (!scopeKey) throw new Error('Community annotation cache scope is incomplete');
    if (!this._db) throw cacheUnavailable('Community annotation file cache is not initialized');
    return scopeKey;
  }

  /** Every key of a scope (`[scopeKey, path, sha]` sorts after `[scopeKey]` and before `[scopeKey, []]`). */
  _scopeRange(scopeKey) {
    return this._keyRange.bound([scopeKey], [scopeKey, []]);
  }

  _pathRange(scopeKey, path) {
    return this._keyRange.bound([scopeKey, path], [scopeKey, path, []]);
  }

  /** Run `work(stores)` in one transaction; resolves with its result once it commits. */
  _transaction(names, mode, work, { signal = null, label }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let tx = null;
      let result;
      let stopWaiting = () => {};
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        stopWaiting();
        callback(value);
      };
      try {
        tx = this._db.transaction(names, mode);
        const stores = Object.fromEntries(names.map((name) => [name, tx.objectStore(name)]));
        tx.oncomplete = () => settle(resolve, result);
        tx.onerror = () => settle(
          reject,
          abortTransactionAfterFailure(tx, tx.error || new Error(`${label} failed`), label)
        );
        tx.onabort = () => settle(
          reject,
          signal?.aborted ? abortReason(signal) : (tx.error || new Error(`${label} aborted`))
        );
        result = work(stores, (error) => settle(reject, abortTransactionAfterFailure(tx, error, label)));
        // Already aborted: the transaction is aborted at once, before it commits.
        stopWaiting = onAbort(signal, () => {
          try {
            tx.abort();
          } catch {
            settle(reject, abortReason(signal));
          }
        });
      } catch (error) {
        settle(reject, tx === null ? error : abortTransactionAfterFailure(tx, error, label));
      }
    });
  }

  /**
   * The blob id of every file the scope keeps (one `getAllKeys`, no record
   * bodies): `Map<path, sha>`.
   */
  async getKnownShas(scope) {
    await this.init();
    const scopeKey = this._scopeKey(scope);
    const keys = await this._transaction([FILES], 'readonly', (stores) =>
      resultOf(stores[FILES].getAllKeys(this._scopeRange(scopeKey))),
    { label: 'Community annotation cache key read' });
    const known = new Map();
    for (const key of keys.value ?? []) {
      if (!Array.isArray(key) || key.length !== 3 || key[0] !== scopeKey) {
        throw cacheCorrupt('Community annotation IndexedDB cache holds a key of another shape');
      }
      const [, path, sha] = key;
      try {
        assertCachePath(path);
        assertCacheSha(sha);
      } catch (cause) {
        throw cacheCorrupt('Community annotation IndexedDB cache holds an invalid key', cause);
      }
      if (known.has(path)) {
        throw cacheCorrupt(`Community annotation IndexedDB cache holds two versions of ${JSON.stringify(path)}`);
      }
      known.set(path, sha);
    }
    return known;
  }

  /**
   * Keep a batch of files in one transaction: each replaces whatever version
   * of its path the scope held. Every record is checked before the
   * transaction opens.
   *
   * @param {{datasetId: string, repoRef: string, userId: number}} scope
   * @param {Array<{path: string, sha: string, view: object}|{path: string, sha: string, rejection: {code: string, message: string}}>} records
   * @param {{signal?: AbortSignal|null}} [options]
   */
  async putRecords(scope, records, { signal = null } = {}) {
    const ownerSignal = requireSignalOrNull(signal, 'Community annotation cache signal');
    throwIfAborted(ownerSignal);
    await this.init();
    throwIfAborted(ownerSignal);
    if (!Array.isArray(records)) throw new TypeError('Community annotation cache records must be an array');
    const scopeKey = this._scopeKey(scope);
    const seen = new Set();
    const storedAt = Date.now();
    const exact = records.map((record, index) => {
      const checked = exactInputRecord(record, index);
      if (seen.has(checked.path)) {
        throw new Error(`Community annotation cache batch path ${JSON.stringify(checked.path)} is duplicated`);
      }
      seen.add(checked.path);
      return { scopeKey, ...checked, storedAt };
    });
    if (exact.length === 0) return;
    await this._transaction([FILES], 'readwrite', (stores) => {
      for (const record of exact) {
        stores[FILES].delete(this._pathRange(scopeKey, record.path));
        stores[FILES].put(record);
      }
    }, { signal: ownerSignal, label: 'Community annotation cache batch write' });
    throwIfAborted(ownerSignal);
  }

  /**
   * One file's record, or null.
   *
   * @returns {Promise<{path: string, sha: string, view: object|null, rejection: object|null}|null>}
   */
  async getRecord(scope, path) {
    await this.init();
    const scopeKey = this._scopeKey(scope);
    const p = assertCachePath(path);
    const holder = await this._transaction([FILES], 'readonly', (stores) =>
      resultOf(stores[FILES].getAll(this._pathRange(scopeKey, p))),
    { label: 'Community annotation cache record read' });
    const records = holder.value ?? [];
    if (records.length > 1) throw cacheCorrupt(`Community annotation IndexedDB cache holds two versions of ${JSON.stringify(p)}`);
    if (records.length === 0) return null;
    try {
      return exactStoredRecord(records[0], scopeKey);
    } catch (cause) {
      throw cacheCorrupt(`Community annotation cache record ${JSON.stringify(p)} is invalid`, cause);
    }
  }

  /**
   * Hand every record of a scope to `onRecord(record)` in path order, from
   * one cursor, so a Pull folds the cache without holding every file.
   * `onRecord` runs synchronously inside the cursor (an IndexedDB transaction
   * cannot outlive an awaited callback); a throw aborts the scan and rejects.
   *
   * @param {{datasetId: string, repoRef: string, userId: number}} scope
   * @param {(record: {path: string, sha: string, view: object|null, rejection: object|null}) => void} onRecord
   * @returns {Promise<number>} how many records were handed on
   */
  async forEachRecord(scope, onRecord) {
    if (typeof onRecord !== 'function') throw new TypeError('Community annotation cache scan requires onRecord');
    await this.init();
    const scopeKey = this._scopeKey(scope);
    let count = 0;
    let previousPath = null;
    await this._transaction([FILES], 'readonly', (stores, fail) => {
      const request = stores[FILES].openCursor(this._scopeRange(scopeKey));
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (!cursor) return;
          let record;
          try {
            record = exactStoredRecord(cursor.value, scopeKey);
          } catch (cause) {
            throw cacheCorrupt('Community annotation IndexedDB cache contains an invalid record', cause);
          }
          if (record.path === previousPath) {
            throw cacheCorrupt(`Community annotation IndexedDB cache holds two versions of ${JSON.stringify(record.path)}`);
          }
          previousPath = record.path;
          count += 1;
          onRecord(record);
          cursor.continue();
        } catch (error) {
          fail(error);
        }
      };
    }, { label: 'Community annotation cache scan' });
    return count;
  }

  /** Remove every file of a scope whose path is not in `keepPaths`. */
  async pruneToPaths(scope, keepPaths, { signal = null } = {}) {
    if (!(keepPaths instanceof Set)) throw new Error('Community annotation cache keepPaths must be a Set');
    const ownerSignal = requireSignalOrNull(signal, 'Community annotation cache signal');
    await this.init();
    const scopeKey = this._scopeKey(scope);
    const known = await this.getKnownShas(scope);
    const stale = [...known.keys()].filter((path) => !keepPaths.has(path));
    if (stale.length === 0) return 0;
    await this._transaction([FILES], 'readwrite', (stores) => {
      for (const path of stale) stores[FILES].delete(this._pathRange(scopeKey, path));
    }, { signal: ownerSignal, label: 'Community annotation cache prune' });
    return stale.length;
  }

  /** The last completed Pull of a scope, or null. */
  async getPullMarker(scope) {
    await this.init();
    const scopeKey = this._scopeKey(scope);
    const holder = await this._transaction([PULLS], 'readonly', (stores) =>
      resultOf(stores[PULLS].get(scopeKey)),
    { label: 'Community annotation Pull marker read' });
    if (holder.value === undefined || holder.value === null) return null;
    try {
      return exactMarker(holder.value, scopeKey);
    } catch (cause) {
      throw cacheCorrupt('Community annotation Pull marker is invalid', cause);
    }
  }

  /** Record a completed Pull: `{commitOid, annotationsOid, usersOid, ignored}`. */
  async setPullMarker(scope, { commitOid, annotationsOid, usersOid, ignored }, { signal = null } = {}) {
    const ownerSignal = requireSignalOrNull(signal, 'Community annotation cache signal');
    await this.init();
    const scopeKey = this._scopeKey(scope);
    const marker = exactMarker({
      scopeKey,
      commitOid,
      annotationsOid,
      usersOid,
      ignored,
      completedAt: Date.now(),
    }, scopeKey);
    await this._transaction([PULLS], 'readwrite', (stores) => {
      stores[PULLS].put({ scopeKey, ...marker });
    }, { signal: ownerSignal, label: 'Community annotation Pull marker write' });
  }

  /** Forget a scope's last completed Pull (a Pull about to write records). */
  async deletePullMarker(scope, { signal = null } = {}) {
    const ownerSignal = requireSignalOrNull(signal, 'Community annotation cache signal');
    await this.init();
    const scopeKey = this._scopeKey(scope);
    await this._transaction([PULLS], 'readwrite', (stores) => {
      stores[PULLS].delete(scopeKey);
    }, { signal: ownerSignal, label: 'Community annotation Pull marker delete' });
  }

  /** Remove everything a scope keeps: its marker first, then its files. */
  async clearRepo(scope) {
    await this.init();
    const scopeKey = this._scopeKey(scope);
    await this._transaction([PULLS, FILES], 'readwrite', (stores) => {
      stores[PULLS].delete(scopeKey);
      stores[FILES].delete(this._scopeRange(scopeKey));
    }, { label: 'Community annotation cache clear' });
    return true;
  }
}

let _cache = null;

export function getCommunityAnnotationFileCache() {
  if (_cache) return _cache;
  _cache = new CommunityAnnotationFileCache();
  return _cache;
}
