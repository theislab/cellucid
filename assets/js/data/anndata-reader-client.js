/**
 * @fileoverview The main thread's handle on the AnnData reader worker
 * (`anndata-reader-worker.js`). `AnnDataReaderClient` has the reader's exact
 * API, so `BaseAnnDataAdapter` uses it as it would the reader itself, but
 * every call is a message: the page never runs HDF5, inflates a chunk or
 * transposes a matrix. Typed results arrive transferred, never copied.
 *
 * Every read takes an optional `signal`: aborting it rejects the call at once
 * and sends the worker a cancel message, so a superseded read stops its
 * requests instead of downloading on for nobody.
 *
 * Gene columns asked for one at a time (`getMatrixColumn` dense,
 * `getMatrixColumnSparse` as non-zero entries) within one task -- a view's
 * gene, a long run's next dozen genes -- go to the worker as one request per
 * matrix and form, so the reader plans their reads as one set of coalesced,
 * parallel requests and answers them in one message.
 *
 * The client keeps the reader's cache semantics where callers rely on
 * identity: `getObsField(key)` returns the same object until
 * `releaseObsField(key, field)` or `clearCache()`, and `getObsFieldInfo` and
 * `readVarNames` likewise, so the adapter's identity checks hold across the
 * worker boundary.
 *
 * @module data/anndata-reader-client
 */

import { getTransferLog } from './transfer-log.js';
import { onAbort } from '../formats/io/abort.js';
import { getReadActivityLog } from './read-activity-log.js';
import { setSourceRequestConcurrency } from './fetch-scheduler.js';
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
 * Run `callback` on a later task: after the current task and every promise
 * continuation it queued, so the gene reads a burst of callers asks for are
 * sent together.
 */
const nextTask = (() => {
  if (typeof setImmediate === 'function') return callback => setImmediate(callback);
  if (typeof MessageChannel === 'function') {
    const channel = new MessageChannel();
    const queue = [];
    channel.port1.onmessage = () => queue.shift()();
    return callback => {
      queue.push(callback);
      channel.port2.postMessage(0);
    };
  }
  return callback => setTimeout(callback, 0);
})();

/** Why a cancelled call stopped: its signal's reason, else an AbortError. */
function abortReason(signal) {
  return signal.reason ?? new DOMException('The read was cancelled.', 'AbortError');
}

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
  for (const key of ['code', 'key', 'reason', 'bytes', 'details']) {
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
   */
  constructor({ kind }) {
    this._kind = kind;
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
    /**
     * Gene column reads asked for in the current task, sent together on the
     * next one (`_sendGeneReads`).
     * @type {Array<Object>}
     */
    this._geneReads = [];
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
    if (message?.event === 'activity') {
      // What one read operation fetched and decoded, for the read activity
      // log and the console.
      const { event: _event, ...activity } = message;
      getReadActivityLog().record(activity);
      return;
    }
    if (message?.event === 'transfer') {
      // A remote file's running totals, for the Transfers log.
      getTransferLog().record(message.url, {
        bytes: message.bytes,
        requests: message.reads,
        absolute: true,
      });
      if (message.requestConcurrency !== undefined) setSourceRequestConcurrency(message.requestConcurrency);
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
    return this._callWith({}, method, ...args);
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

  /**
   * `_call`, handing the worker the buffers in `transfer`; `signal` cancels
   * the call (here at once, and in the worker by a cancel message).
   */
  _callWith({ transfer = [], signal = null }, method, ...args) {
    if (this._worker === null && method !== 'open' && this._source !== null && !this._closed) {
      // The page came back from the back/forward cache: open the file again.
      this._reopening ??= this._post([], null, 'open', [{ kind: this._kind, source: this._source }]);
      return this._reopening.then(() => this._post(transfer, signal, method, args));
    }
    return this._post(transfer, signal, method, args);
  }

  _post(transfer, signal, method, args) {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const worker = this._ensureWorker();
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      let detach = () => {};
      this._pending.set(id, {
        resolve: value => {
          detach();
          resolve(value);
        },
        reject: error => {
          detach();
          reject(error);
        },
      });
      detach = onAbort(signal, () => {
        if (!this._pending.has(id)) return;
        this._pending.delete(id);
        reject(abortReason(signal));
        // The worker stops the request's reads; its reply, if any, is
        // ignored (the id is no longer pending).
        if (this._worker === worker) worker.postMessage({ cancel: id });
      });
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
    // The log follows the dataset being opened, from its first read.
    getReadActivityLog().clear();
    const snapshot = await this._call('open', { kind: this._kind, source });
    this._source = source;
    // The page's download scheduler runs as many background reads at once
    // as this source answers (`fetch-scheduler.js`).
    if (snapshot.requestConcurrency !== undefined) setSourceRequestConcurrency(snapshot.requestConcurrency);
    this._clearMirrors();
    this._snapshot = Object.freeze({
      ...snapshot,
      obsKeys: Object.freeze([...snapshot.obsKeys]),
      varNames: Object.freeze([...snapshot.varNames]),
    });
    return { name: snapshot.name };
  }

  /**
   * What a catalog lists about one store of this client's kind, read from
   * its metadata and `uns` alone (`describeAnnDataStore`), without opening
   * it as the dataset.
   *
   * @param {File|Object} source - As `open()`
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<{nObs: number, nVars: number, hasExpressionMatrix: boolean,
   *   title: string|null, cellucid: Object|null}>}
   */
  describe(source, { signal = null } = {}) {
    return this._callWith({ signal }, 'describe', { kind: this._kind, source });
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
   * The latent-space outlier quantiles of several categorical fields in
   * `obsm[key]`, computed in the reader worker in the same passes over the
   * file. Each field's `codes` (a narrowed codes array,
   * `categorical-storage-contract.js`) is copied at its own width, so the
   * caller keeps its arrays.
   *
   * @param {string} key
   * @param {number} width
   * @param {ReadonlyArray<{codes: Uint8Array|Uint16Array|Uint32Array, nCategories: number}>} fields
   * @param {number} minPoints
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Float32Array[]>}
   */
  latentOutlierQuantiles(key, width, fields, minPoints, { signal = null } = {}) {
    this._requireOpen();
    const copies = fields.map(({ codes, nCategories }) => ({ codes: codes.slice(), nCategories }));
    return this._callWith(
      { transfer: copies.map(field => field.codes.buffer), signal },
      'latentOutlierQuantiles',
      key,
      width,
      copies,
      minPoints
    );
  }

  /**
   * The outlier quantiles the file stores for one obs field, as stored (NaN
   * where none).
   *
   * @param {string} fieldKey
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Float32Array>}
   */
  readStoredOutlierQuantiles(fieldKey, { signal = null } = {}) {
    this._requireOpen();
    return this._callWith({ signal }, 'readStoredOutlierQuantiles', fieldKey);
  }

  /** The stored bytes of one field's stored outlier quantiles, or null when unknown. */
  storedOutlierQuantilesBytes(fieldKey, { signal = null } = {}) {
    this._requireOpen();
    return this._callWith({ signal }, 'storedOutlierQuantilesBytes', fieldKey);
  }

  /**
   * What computing outlier quantiles in `obsm[key]` costs: whether the
   * worker keeps that latent space already (`held`: nothing is read) or will
   * once read (`kept`), and its stored and value bytes (null when held, or
   * when the store cannot say).
   *
   * @returns {Promise<{held: boolean, kept: boolean, storedBytes: number|null, valueBytes: number|null}>}
   */
  describeLatentOutliers(key, width, { signal = null } = {}) {
    this._requireOpen();
    return this._callWith({ signal }, 'describeLatentOutliers', key, width);
  }

  /**
   * One embedding's display coordinates, checked and normalized in the
   * reader worker (`EmbeddingPayloads.embedding`, `embedding-payload.js`).
   *
   * @param {string} key
   * @param {ReadonlyArray<number>} columns
   * @param {boolean} normalize
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<import('./embedding-payload.js').EmbeddingPayload>}
   */
  readEmbedding(key, columns, normalize, { signal = null } = {}) {
    this._requireOpen();
    return this._callWith({ signal }, 'readEmbedding', key, [...columns], normalize);
  }

  /**
   * One vector field's display vectors, scaled in the reader worker by the
   * transform of the embedding it is bound to (`EmbeddingPayloads.vectors`).
   *
   * @param {string} key
   * @param {ReadonlyArray<number>} columns
   * @param {{key: string, columns: ReadonlyArray<number>}} embedding
   * @param {boolean} normalize
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<{vectors: Float32Array, maxMagnitude: number}>}
   */
  readVectorField(key, columns, embedding, normalize, { signal = null } = {}) {
    this._requireOpen();
    return this._callWith(
      { signal },
      'readVectorField',
      key,
      [...columns],
      { key: embedding.key, columns: [...embedding.columns] },
      normalize
    );
  }

  async readVarNames(axis, column) {
    this._requireOpen();
    const cacheKey = `${axis}:${column === null ? '' : `column:${column}`}`;
    if (this._varNames.has(cacheKey)) return this._varNames.get(cacheKey);
    const result = Object.freeze(await this._call('readVarNames', axis, column));
    this._varNames.set(cacheKey, result);
    return result;
  }

  /**
   * One gene column of one matrix, dense (float32, one value per cell). The
   * columns asked for within one task are sent to the worker together, one
   * request per matrix (`_sendGeneReads`); each caller owns the array it
   * receives.
   *
   * @param {string} element
   * @param {number} index
   * @param {{signal?: AbortSignal|null, owner?: string|null, key?: string|null}} [options] -
   *   `signal` cancels this caller's read; the request stops once every gene
   *   it carries is cancelled. `owner`: the job the read is for, if any.
   *   `key`: the shared load the read is for, which a job may join later
   *   (`data/read-activity-log.js`, `adopt`); the request's activity carries
   *   the keys of every read it serves.
   * @returns {Promise<Float32Array>}
   */
  getMatrixColumn(element, index, { signal = null, owner = null, key = null } = {}) {
    return this._queueGeneRead('dense', element, index, signal, owner, key);
  }

  /**
   * One gene column of one matrix as its non-zero entries
   * (`{length, indices: Uint32Array, values: Float32Array}`, the dense
   * column's values bit for bit), batched as `getMatrixColumn` is; each
   * caller owns the arrays it receives. An analysis's read: `owner` is the
   * job it reads for, and reads of different jobs go as separate requests,
   * so each job's reads are its own in the read activity log.
   *
   * @param {string} element
   * @param {number} index
   * @param {{signal?: AbortSignal|null, owner?: string|null}} [options]
   * @returns {Promise<{length: number, indices: Uint32Array, values: Float32Array}>}
   */
  getMatrixColumnSparse(element, index, { signal = null, owner = null } = {}) {
    return this._queueGeneRead('sparse', element, index, signal, owner);
  }

  /** Queue one gene read for the next task's batch. @private */
  _queueGeneRead(form, element, index, signal, owner = null, key = null) {
    this._requireOpen();
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      const read = { form, element, gene: index, owner, key, signal, resolve, reject, settled: false, batch: null, stopWaiting: null };
      read.stopWaiting = onAbort(signal, () => this._cancelGeneRead(read));
      this._geneReads.push(read);
      if (this._geneReads.length === 1) nextTask(() => this._sendGeneReads());
    });
  }

  /** Settle one queued gene read. @private */
  _settleGeneRead(read, error, value) {
    if (read.settled) return;
    read.settled = true;
    read.stopWaiting();
    if (error !== null) read.reject(error);
    else read.resolve(value);
  }

  /**
   * One caller cancelled its gene: it is answered at once, and the request
   * carrying it is cancelled when none of its genes is still wanted. @private
   */
  _cancelGeneRead(read) {
    if (read.settled) return;
    this._settleGeneRead(read, abortReason(read.signal), null);
    const batch = read.batch;
    if (batch !== null && --batch.wanted === 0) batch.controller.abort(abortReason(read.signal));
  }

  /**
   * Send the gene reads asked for in the last task: one request per matrix
   * and form, each gene read once however many callers asked for it. @private
   */
  _sendGeneReads() {
    const reads = this._geneReads.filter(read => !read.settled);
    this._geneReads = [];
    const byRequest = new Map();
    for (const read of reads) {
      const key = `${read.form}\u0000${read.element}\u0000${read.owner ?? ''}`;
      let group = byRequest.get(key);
      if (group === undefined) {
        group = [];
        byRequest.set(key, group);
      }
      group.push(read);
    }
    for (const group of byRequest.values()) {
      const { form, element, owner } = group[0];
      const keys = [...new Set(group.map(read => read.key).filter(key => key !== null))];
      const batch = { controller: new AbortController(), wanted: group.length };
      const genes = [];
      const readersOf = new Map();
      for (const read of group) {
        read.batch = batch;
        let readers = readersOf.get(read.gene);
        if (readers === undefined) {
          readers = [];
          readersOf.set(read.gene, readers);
          genes.push(read.gene);
        }
        readers.push(read);
      }
      let request;
      try {
        this._requireOpen();
        const options = { signal: batch.controller.signal };
        if (form === 'sparse') {
          request = this._callWith(options, 'getMatrixColumnsSparse', element, genes, owner);
        } else {
          // A gene alone keeps its own request (and its own name in the read
          // activity log).
          request = genes.length === 1
            ? this._callWith(options, 'getMatrixColumn', element, genes[0], owner, keys).then(column => [column])
            : this._callWith(options, 'getMatrixColumns', element, genes, owner, keys);
        }
      } catch (error) {
        request = Promise.reject(error);
      }
      // The first caller of a gene takes the transferred arrays; any other
      // caller of the same gene gets its own copy.
      const copy = form === 'sparse'
        ? column => ({ length: column.length, indices: column.indices.slice(), values: column.values.slice() })
        : column => new Float32Array(column);
      request.then(
        columns => {
          genes.forEach((gene, position) => {
            readersOf.get(gene).forEach((read, nth) => {
              this._settleGeneRead(read, null, nth === 0 ? columns[position] : copy(columns[position]));
            });
          });
        },
        error => {
          for (const read of group) this._settleGeneRead(read, error, null);
        }
      );
    }
  }

  /**
   * Many gene columns of one matrix in one request: the reader fetches what
   * they need as one set of coalesced, parallel reads.
   *
   * @param {string} element
   * @param {ReadonlyArray<number>} genes
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Float32Array[]>}
   */
  getMatrixColumns(element, genes, { signal = null } = {}) {
    this._requireOpen();
    return this._callWith({ signal }, 'getMatrixColumns', element, Array.from(genes));
  }

  /**
   * The non-zero genes of cells of one matrix.
   *
   * @param {string} element
   * @param {ReadonlyArray<number>} cells
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Array<{genes: Int32Array, values: Float32Array}>>}
   */
  getMatrixRows(element, cells, { signal = null } = {}) {
    this._requireOpen();
    const positions = Uint32Array.from(cells);
    return this._callWith({ signal, transfer: [positions.buffer] }, 'getMatrixRows', element, positions);
  }

  /**
   * Some genes in some cells of one matrix as a gene-major block, read by
   * cell or by gene, whichever costs less
   * (`AnnDataReader.getMatrixCellSubset`).
   *
   * @param {string} element
   * @param {ArrayLike<number>} cells - Distinct cell positions
   * @param {ArrayLike<number>} genes - Distinct gene positions
   * @param {{signal?: AbortSignal|null, owner?: string|null}} [options] -
   *   `owner`: the job the read is for
   * @returns {Promise<{pointers: Float64Array, cellIndex: Int32Array, values: Float32Array}>}
   */
  getMatrixCellSubset(element, cells, genes, { signal = null, owner = null } = {}) {
    this._requireOpen();
    const cellPositions = Uint32Array.from(cells);
    const genePositions = Uint32Array.from(genes);
    return this._callWith(
      { signal, transfer: [cellPositions.buffer, genePositions.buffer] },
      'getMatrixCellSubset',
      element,
      cellPositions,
      genePositions,
      owner
    );
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

  /**
   * One obs field's values (`AnnDataReader.getObsField`), the same object
   * until it is released.
   *
   * @param {string} key
   * @param {{signal?: AbortSignal|null}} [options]
   */
  async getObsField(key, { signal = null } = {}) {
    this._requireOpen();
    const cached = this._obsFields.get(key);
    if (cached !== undefined) return cached;
    const field = await this._callWith({ signal }, 'getObsField', key);
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
        // Computed only if accessed; a code past the categories is missing.
        get values() {
          const computed = Array.from(codes, c => (c < categories.length ? categories[c] : null));
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
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Object|null>}
   */
  getConnectivityEdges(key, { signal = null } = {}) {
    this._requireOpen();
    return this._callWith({ signal }, 'getConnectivityEdges', key);
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
