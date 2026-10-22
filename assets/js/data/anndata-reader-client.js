/**
 * @fileoverview The main thread's handle on the AnnData reader worker
 * (`anndata-reader-worker.js`). `AnnDataReaderClient` has the reader's exact
 * API, so `BaseAnnDataAdapter` uses it as it would the reader itself, but
 * every call is a message: the page never runs HDF5, inflates a chunk or
 * transposes a matrix. Typed results arrive transferred, never copied.
 *
 * The client keeps the reader's cache semantics where callers rely on
 * identity: `getObsField(key)` returns the same object until
 * `releaseObsField(key, field)` or `clearCache()`, and `getObsFieldInfo` and
 * `readVarNames` likewise, so the adapter's identity checks hold across the
 * worker boundary.
 *
 * @module data/anndata-reader-client
 */

import { DataSourceError, DataSourceErrorCode } from './data-source.js';
import { EmbeddingLoadError, MappingLoadError } from './data-mapping-candidates.js';
import { DataMappingError } from './data-mapping.js';

function createDefaultWorker() {
  return new Worker(
    new URL('./anndata-reader-worker.js', import.meta.url),
    { type: 'module' }
  );
}

let workerFactory = createDefaultWorker;

/**
 * Replace how reader workers are created (tests run the same handler
 * in-process); `null` restores the module worker.
 *
 * @param {(() => Worker)|null} factory
 */
export function setAnnDataReaderWorkerFactory(factory) {
  if (factory !== null && typeof factory !== 'function') {
    throw new TypeError('An AnnData reader worker factory must be a function or null.');
  }
  workerFactory = factory ?? createDefaultWorker;
}

const ERROR_TYPES = {
  RangeError,
  TypeError,
  SyntaxError,
};

/**
 * Rebuild an error the worker serialized, with its original class.
 *
 * @param {Object} record
 * @returns {Error}
 */
export function rebuildReaderError(record) {
  if (record === null || typeof record !== 'object') {
    return new Error(String(record));
  }
  const cause = record.cause === undefined ? undefined : rebuildReaderError(record.cause);
  const options = cause === undefined ? undefined : { cause };
  let error;
  switch (record.name) {
    case 'DataSourceError':
      error = new DataSourceError(
        record.message,
        record.code,
        record.sourceType ?? null,
        record.details ?? {}
      );
      break;
    case 'EmbeddingLoadError':
      error = new EmbeddingLoadError(record.key, record.columns ?? [], record.reason);
      error.message = record.message;
      break;
    case 'MappingLoadError':
      error = new MappingLoadError(record.key, record.reason, record.message);
      break;
    case 'DataMappingError':
      error = new DataMappingError(record.code, record.message);
      break;
    case 'AggregateError':
      error = new AggregateError(
        (record.errors ?? []).map(rebuildReaderError),
        record.message,
        options
      );
      break;
    default: {
      if (record.code === 'TOO_LARGE') {
        error = new DataSourceError(
          record.message,
          DataSourceErrorCode.TOO_LARGE,
          null,
          { bytes: record.bytes }
        );
        break;
      }
      const ErrorType = ERROR_TYPES[record.name] ?? Error;
      error = new ErrorType(record.message, options);
      if (!(record.name in ERROR_TYPES) && record.name !== 'Error') {
        error.name = record.name;
      }
    }
  }
  if (cause !== undefined && error.cause === undefined) {
    Object.defineProperty(error, 'cause', {
      value: cause,
      configurable: true,
      writable: true,
    });
  }
  for (const key of ['code', 'key', 'reason', 'bytes']) {
    if (record[key] !== undefined && error[key] === undefined) error[key] = record[key];
  }
  return error;
}

/**
 * One reader worker and the dataset open in it.
 */
export class AnnDataReaderClient {
  /**
   * @param {Object} options
   * @param {'h5ad'|'zarr'} options.kind
   * @param {(event: Object) => void} [options.onProgress]
   */
  constructor({ kind, onProgress = null }) {
    this._kind = kind;
    this._onProgress = onProgress;
    this._worker = null;
    this._nextId = 1;
    this._pending = new Map();
    this._snapshot = null;
    this._closed = false;
    this._obsFields = new Map();
    this._obsInfo = new Map();
    this._varNames = new Map();
    this._onPageHide = null;
    this._source = null;
    this._reopening = null;
  }

  _ensureWorker() {
    if (this._closed) throw new Error('No AnnData file is open. Call open() first.');
    if (this._worker !== null) return this._worker;
    const worker = workerFactory();
    worker.onmessage = event => this._receive(event.data);
    worker.onerror = event => {
      event?.preventDefault?.();
      this._failAll(new Error(
        `The AnnData reader stopped: ${event?.message ?? 'unknown error'}`
      ));
    };
    this._worker = worker;
    // A worker outlives its document unless it is ended: once the page is
    // left, one still reading the file (a background gene index) fails its
    // reads, and in WebKit holds the next page's file reads waiting behind
    // its own. So leaving the page ends the worker; a page restored from the
    // back/forward cache reopens the same file on its next request.
    if (this._onPageHide === null && typeof window !== 'undefined' &&
        typeof window.addEventListener === 'function') {
      this._onPageHide = () => this._suspend();
      window.addEventListener('pagehide', this._onPageHide);
    }
    return worker;
  }

  _receive(message) {
    if (message?.event === 'progress') {
      // Progress is a display side effect: a failing display must never
      // break the replies that follow it.
      try {
        this._onProgress?.(message);
      } catch (error) {
        console.error('[AnnDataReader] Progress display failed:', error);
      }
      return;
    }
    const pending = this._pending.get(message?.id);
    if (pending === undefined) return;
    this._pending.delete(message.id);
    if (message.error !== undefined) pending.reject(rebuildReaderError(message.error));
    else pending.resolve(message.result);
  }

  _failAll(error) {
    const pending = [...this._pending.values()];
    this._pending.clear();
    for (const entry of pending) entry.reject(error);
  }

  _call(method, ...args) {
    return this._callTransferring([], method, ...args);
  }

  /** End the worker when the page is left, keeping what reopens the file. */
  _suspend() {
    const worker = this._worker;
    if (worker === null) return;
    this._worker = null;
    this._reopening = null;
    this._failAll(new Error('The page was left; the AnnData request was ended'));
    worker.terminate?.();
  }

  /** `_call`, handing the worker the buffers in `transfer`. */
  _callTransferring(transfer, method, ...args) {
    if (this._worker === null && method !== 'open' && this._source !== null && !this._closed) {
      // The page came back from the back/forward cache: open the file again.
      this._reopening ??= this._post([], 'open', { kind: this._kind, source: this._source });
      return this._reopening.then(() => this._post(transfer, method, ...args));
    }
    return this._post(transfer, method, ...args);
  }

  _post(transfer, method, ...args) {
    const worker = this._ensureWorker();
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args }, transfer);
    });
  }

  _requireOpen() {
    if (this._closed || this._snapshot === null) {
      throw new Error('No AnnData file is open. Call open() first.');
    }
  }

  /**
   * Open one dataset in the worker: an `.h5ad` File, or for Zarr
   * `{files: Map<path, File>, rootName}` or `{archive: File}`.
   *
   * @param {File|Object} source
   * @returns {Promise<{name: string}>}
   */
  async open(source) {
    const snapshot = await this._call('open', { kind: this._kind, source });
    this._source = source;
    this._clearMirrors();
    this._snapshot = Object.freeze({
      ...snapshot,
      obsKeys: Object.freeze([...snapshot.obsKeys]),
      varNames: Object.freeze([...snapshot.varNames]),
    });
    return { name: snapshot.name };
  }

  get nObs() {
    return this._snapshot?.nObs ?? 0;
  }

  get nVars() {
    return this._snapshot?.nVars ?? 0;
  }

  get obsKeys() {
    return [...(this._snapshot?.obsKeys ?? [])];
  }

  get varNames() {
    return [...(this._snapshot?.varNames ?? [])];
  }

  get hasExpressionMatrix() {
    return this._snapshot?.hasExpressionMatrix === true;
  }

  get isOpen() {
    return !this._closed && this._snapshot?.isOpen === true;
  }

  probeMapping() {
    this._requireOpen();
    return this._call('probeMapping');
  }

  /**
   * One categorical field's latent-space outlier quantiles in `obsm[key]`,
   * computed in the reader worker from the file. `codes` is copied, so the
   * caller keeps its array.
   *
   * @param {string} key
   * @param {number} width
   * @param {{codes: ArrayLike<number>, nCategories: number, minPoints: number}} field
   * @returns {Promise<Float32Array>}
   */
  latentOutlierQuantiles(key, width, { codes, nCategories, minPoints }) {
    const copy = Int32Array.from(codes);
    return this._callTransferring(
      [copy.buffer],
      'latentOutlierQuantiles',
      key,
      width,
      copy,
      nCategories,
      minPoints
    );
  }

  readObsmColumns(key, columns) {
    this._requireOpen();
    return this._call('readObsmColumns', key, [...columns]);
  }

  async readVarNames(axis, column) {
    this._requireOpen();
    const cacheKey = `${axis}:${column === null ? '' : `column:${column}`}`;
    if (this._varNames.has(cacheKey)) return this._varNames.get(cacheKey);
    const result = Object.freeze(await this._call('readVarNames', axis, column));
    this._varNames.set(cacheKey, result);
    return result;
  }

  getMatrixColumn(element, index) {
    this._requireOpen();
    return this._call('getMatrixColumn', element, index);
  }

  /**
   * Hint that genes will be read from `element`: the reader starts indexing
   * it by gene in the background when its layout needs that.
   *
   * @param {string} element
   */
  prepareMatrix(element) {
    if (!this.isOpen) return;
    this._call('prepareMatrix', element).catch(() => {});
  }

  async getObsFieldInfo(key) {
    this._requireOpen();
    if (this._obsInfo.has(key)) return this._obsInfo.get(key);
    const info = await this._call('getObsFieldInfo', key);
    if (Array.isArray(info?.categories)) Object.freeze(info.categories);
    const known = this._obsInfo.get(key);
    if (known !== undefined) return known;
    this._obsInfo.set(key, info);
    return info;
  }

  async getObsField(key) {
    this._requireOpen();
    const cached = this._obsFields.get(key);
    if (cached !== undefined) return cached;
    const field = await this._call('getObsField', key);
    const known = this._obsFields.get(key);
    if (known !== undefined) return known;
    if (field.dtype === 'categorical') {
      const info = this._obsInfo.get(key);
      // One category dictionary per field, shared with its info by identity.
      const categories = Array.isArray(info?.categories) &&
        info.categories.length === field.categories.length &&
        info.categories.every((value, index) => Object.is(value, field.categories[index]))
        ? info.categories
        : Object.freeze(field.categories);
      const { codes, ordered } = field;
      const result = {
        dtype: 'categorical',
        codes,
        categories,
        ordered,
        // Computed only if accessed.
        get values() {
          const computed = Array.from(codes, c => (c >= 0 ? categories[c] : null));
          Object.defineProperty(this, 'values', { value: computed, writable: false });
          return computed;
        },
      };
      this._obsFields.set(key, result);
      return result;
    }
    this._obsFields.set(key, field);
    return field;
  }

  /**
   * Restore a category dictionary the adapter retains after a cache clear.
   */
  seedObsFieldCategories(key, categories, ordered) {
    this._requireOpen();
    if (!Array.isArray(categories)) return;
    if (typeof ordered !== 'boolean') {
      throw new Error(
        `Categorical field '${key}' ordered must be a boolean`
      );
    }
    if (!this._obsInfo.has(key)) {
      this._obsInfo.set(key, { dtype: 'categorical', categories, ordered });
    }
  }

  /**
   * Release one observation payload if it is still the exact one returned.
   */
  releaseObsField(key, expected = undefined) {
    const cached = this._obsFields.get(key);
    if (expected !== undefined && cached !== expected) return;
    this._obsFields.delete(key);
    const info = this._obsInfo.get(key);
    if (cached?.dtype === 'categorical' && info?.categories === cached.categories) {
      this._obsInfo.delete(key);
    }
    if (!this._closed && this._worker !== null) {
      this._call('releaseObsField', key).catch(() => {});
    }
  }

  hasConnectivities(key) {
    this._requireOpen();
    return this._call('hasConnectivities', key);
  }

  /**
   * The edges of `obsp[key]`, extracted in the reader worker; null when the
   * file has no such matrix.
   *
   * @param {string} key
   * @returns {Promise<Object|null>}
   */
  getConnectivityEdges(key) {
    this._requireOpen();
    return this._call('getConnectivityEdges', key);
  }

  getDatasetMetadata() {
    this._requireOpen();
    return this._call('getDatasetMetadata');
  }

  _clearMirrors() {
    this._obsFields.clear();
    this._obsInfo.clear();
    this._varNames.clear();
  }

  clearCache() {
    this._clearMirrors();
    if (!this._closed && this._worker !== null) {
      this._call('clearCache').catch(() => {});
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._clearMirrors();
    this._snapshot = null;
    const worker = this._worker;
    this._worker = null;
    this._source = null;
    this._reopening = null;
    if (this._onPageHide !== null) {
      window.removeEventListener('pagehide', this._onPageHide);
      this._onPageHide = null;
    }
    this._failAll(new Error('The AnnData file was closed; the request was superseded'));
    worker?.terminate?.();
  }
}
