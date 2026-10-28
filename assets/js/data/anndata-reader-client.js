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
 * The genes an analysis computes in its workers never come here: the client
 * opens the run's gene route in the reader (`openGeneRoute`, the workers'
 * ports) and asks for deliveries (`deliverMatrixColumnsSparse`,
 * `deliverMatrixCellSubset`), which the reader posts to the analysis workers
 * directly, answering only their bytes (`gene-delivery.js`).
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
import { progressiveRequest } from './opening-cost.js';
import { getReadActivityLog } from './read-activity-log.js';
import { setSourceRequestConcurrency } from './fetch-scheduler.js';
import { requestOfOpenCells, requireCellSubsetRequest, takeCellSubsetRequest } from './cell-subset-policy.js';
import { THIS_TAB, holdTranscodedStore, removeTranscodedStore } from './anndata/transcode/space.js';
import { getOpeningProgress } from './opening-progress.js';
import { wholeReadNote } from './whole-read-notice.js';
import { DataSourceError, DataSourceErrorCode } from './data-source.js';
import { EmbeddingLoadError, MappingLoadError } from './data-mapping-candidates.js';
import { DataMappingError } from './data-mapping.js';
import { confirmSourceUnreadable, onSourceAccessRevoked, resolveSourceAccess } from './sources/access.js';
import { annDataReaderWorkerScript } from '../../workers/scripts.js';
import { startWorker } from '../workers/worker-script.js';
import { hostRequesterPort } from '../formats/io/host-fetch.js';
import { byteRangeCachePort } from './byte-range-cache.js';
import { PieceReceiver } from '../utils/large-arrays.js';
import { copyTypedArray } from './sparse-column-index.js';

/** Error details as a record that crosses to the worker. */
function plainDetails(details) {
  try {
    return structuredClone(details);
  } catch {
    return String(details);
  }
}

function createDefaultWorker() {
  return startWorker(annDataReaderWorkerScript(), { type: 'module' });
}

let workerFactory = createDefaultWorker;

/**
 * A reader worker started before any client needs it
 * (`prewarmAnnDataReaderWorker`), so its module graph loads while a link is
 * still being resolved; the next client to need a worker adopts it. Null
 * when there is none.
 * @type {Worker|null}
 */
let spareWorker = null;
/** Ends the spare when the page is left, while nothing has adopted it. */
let sparePageHide = null;

/** The spare worker, now owned by the caller, or null. */
function takeSpareWorker() {
  const worker = spareWorker;
  spareWorker = null;
  if (sparePageHide !== null) {
    window.removeEventListener('pagehide', sparePageHide);
    sparePageHide = null;
  }
  return worker;
}

/**
 * Start one reader worker now, ahead of the client that will read with it:
 * its module graph and decode workers load while the caller is still
 * resolving what to open (a provider probe), not after. The next
 * `AnnDataReaderClient` that needs a worker adopts it. At most one spare
 * exists: calling this again while one waits does nothing. A spare nothing
 * adopts is ended when the page is left, or by
 * `releaseSpareAnnDataReaderWorker` (a client closed before it started a
 * worker releases it: the open it was for was abandoned).
 */
export function prewarmAnnDataReaderWorker() {
  if (spareWorker !== null) return;
  spareWorker = workerFactory();
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    sparePageHide = () => releaseSpareAnnDataReaderWorker();
    window.addEventListener('pagehide', sparePageHide);
  }
}

/** End the spare reader worker, if one waits. */
export function releaseSpareAnnDataReaderWorker() {
  takeSpareWorker()?.terminate?.();
}

/** Whether a spare reader worker waits to be adopted (tests). */
export function hasSpareAnnDataReaderWorker() {
  return spareWorker !== null;
}

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
  // A spare made by the previous factory is not what the next client expects.
  releaseSpareAnnDataReaderWorker();
  workerFactory = factory ?? createDefaultWorker;
}

/** A gene column's array of its own for one more caller of the gene. */
const copiedColumn = column => copyTypedArray(column.constructor, column, 'Gene column');

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
  constructor() {
    this._worker = null;
    this._nextId = 1;
    this._pending = new Map();
    this._snapshot = null;
    this._closed = false;
    /** Ends the worker's channel to the page's byte range cache (`byte-range-cache.js`). */
    this._closeRangeCache = null;
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
    /**
     * The open dataset's link as the worker last measured it
     * (`{latencyMs, bytesPerMs, backgroundConcurrency, protocol}`), or null.
     * @type {Readonly<Object>|null}
     */
    this._link = null;
    /** Stops hearing of sign-outs (`sources/access.js`), once a worker started. */
    this._stopAccessRevokes = null;
    /**
     * Where the worker is writing a single-stream file's store
     * (`anndata/transcode/space.js`) and has not finished: removed when this
     * reader closes (Cancel, a failure), since its worker can no longer.
     * @type {Set<string>}
     */
    this._unfinishedStores = new Set();
    /** Asks the person to pick one of a file's objects (`open()`'s `choose`). */
    this._choose = null;
  }

  _ensureWorker() {
    if (this._closed) throw new Error('No AnnData file is open. Call open() first.');
    if (this._worker !== null) return this._worker;
    const worker = takeSpareWorker() ?? workerFactory();
    worker.onmessage = event => this._receive(event.data);
    // A sign-out drops the targets the worker holds (`sources/access.js`).
    this._stopAccessRevokes ??= onSourceAccessRevoked(ref => {
      this._worker?.postMessage({ sourceAccessRevoked: ref });
    });
    worker.onerror = event => {
      event?.preventDefault?.();
      this._failAll(new Error(
        `The AnnData reader stopped: ${event?.message ?? 'unknown error'}`
      ));
    };
    this._worker = worker;
    // A notebook widget's viewer reads its host through the page
    // (`formats/io/host-fetch.js`): the worker is handed a port to it before
    // its first request.
    const hostPort = hostRequesterPort();
    if (hostPort !== null) worker.postMessage({ hostRequesterPort: hostPort }, [hostPort]);
    // The bytes of remote files the page keeps (`data/byte-range-cache.js`):
    // a worker opening a file another one read fetches none of them again.
    const range = byteRangeCachePort();
    if (range !== null) {
      worker.postMessage({ rangeCachePort: range.port }, [range.port]);
      this._closeRangeCache = range.close;
    }
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
    if (message?.event === 'transcoded') {
      // A complete store is kept for the tab's life (the worker lets its
      // own hold go once told this page holds it); an unfinished one is
      // removed if this reader closes before it completes.
      if (message.state === 'complete') {
        this._unfinishedStores.delete(message.directory);
        const worker = this._worker;
        void holdTranscodedStore(message.directory).then(() => worker?.postMessage({ storeHeld: message.directory }));
      } else {
        this._unfinishedStores.add(message.directory);
      }
      return;
    }
    if (message?.event === 'whole-read') {
      // Up front, before the file is read: it cannot be read in parts, how
      // much is read, and what becomes of it (or that an earlier read's
      // store opens instead).
      getOpeningProgress().notice(wholeReadNote(message));
      return;
    }
    if (message?.event === 'choose') {
      const worker = this._worker;
      const choose = this._choose;
      Promise.resolve(choose === null ? Promise.reject(new Error('No one can be asked which object to open.')) : choose({
        question: message.question,
        options: message.options,
      })).then(
        index => worker?.postMessage({ choice: message.request, index }),
        error => worker?.postMessage({ choice: message.request, error: { name: error?.name ?? 'Error', message: error?.message ?? String(error) } })
      );
      return;
    }
    if (message?.event === 'source-access') {
      // The worker asks for the URL and headers of a file behind a sign-in
      // or an expiring link; the answer crosses in memory only.
      const worker = this._worker;
      resolveSourceAccess(message.ref, { refresh: message.refresh === true }).then(
        target => worker?.postMessage({ sourceAccess: message.request, target }),
        error => worker?.postMessage({
          sourceAccess: message.request,
          error: {
            name: error?.name ?? 'Error',
            message: error?.message ?? String(error),
            ...(error?.code === undefined ? {} : { code: error.code }),
            ...(typeof error?.source === 'string' ? { sourceType: error.source } : {}),
            ...(error?.details === undefined ? {} : { details: plainDetails(error.details) }),
          },
        })
      );
      return;
    }
    if (message?.event === 'source-unreadable') {
      // A read got no answer: whether the provider's own evidence says the
      // file is unreadable now (`sources/access.js`).
      const worker = this._worker;
      confirmSourceUnreadable(message.ref).then(unreadable => {
        worker?.postMessage({ sourceUnreadable: message.request, unreadable });
      });
      return;
    }
    if (message?.event === 'activity') {
      // What one read operation fetched and decoded, for the read activity
      // log and the console.
      const { event: _event, ...activity } = message;
      getReadActivityLog().record(activity);
      return;
    }
    if (message?.event === 'link') {
      const { event: _event, ...measurement } = message;
      this._link = Object.freeze(measurement);
      return;
    }
    if (message?.event === 'piece') {
      // A piece of an array of the reply that follows (`utils/large-arrays.js`):
      // copied into its array at once, so pieces never pile up.
      const pending = this._pending.get(message.id);
      if (pending !== undefined) {
        try {
          (pending.pieces ??= new PieceReceiver()).receive(message);
        } catch (error) {
          this._pending.delete(message.id);
          pending.reject(error);
        }
      }
      return;
    }
    if (message?.event === 'partial') {
      // A gene on more cells, before its reply (`getMatrixColumn`'s `onPartial`).
      const pending = this._pending.get(message.id);
      if (pending?.onPartial) pending.onPartial((pending.pieces ?? new PieceReceiver()).resolve(message));
      return;
    }
    if (message?.event === 'transfer') {
      if (typeof message.retrying === 'string') {
        // A request made again after a transient failure.
        getTransferLog().retrying(message.url, message.retrying);
        return;
      }
      if (message.arriving === true) {
        // Bytes of a request still under way: the read is alive.
        getTransferLog().arriving(message.url);
        return;
      }
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
    if (message.error !== undefined) {
      pending.reject(rebuildReaderError(message.error));
      return;
    }
    let result;
    try {
      // Every reply is resolved: an array posted in pieces stands in it as a placeholder.
      result = (pending.pieces ?? new PieceReceiver()).resolve(message.result);
    } catch (error) {
      pending.reject(error);
      return;
    }
    pending.resolve(result);
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
    this._releaseRangeCache();
  }

  /**
   * `_call`, handing the worker the buffers in `transfer`; `signal` cancels
   * the call (here at once, and in the worker by a cancel message).
   */
  _callWith({ transfer = [], signal = null, onPartial = null }, method, ...args) {
    if (this._worker === null && method !== 'open' && this._source !== null && !this._closed) {
      // The page came back from the back/forward cache: open the file again.
      this._reopening ??= this._post([], null, 'open', [this._source]);
      return this._reopening.then(() => this._post(transfer, signal, method, args, onPartial));
    }
    return this._post(transfer, signal, method, args, onPartial);
  }

  _post(transfer, signal, method, args, onPartial = null) {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const worker = this._ensureWorker();
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      let detach = () => {};
      this._pending.set(id, {
        onPartial,
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
   * Open one dataset in the worker (`openDatasetStore` in `anndata/open.js`):
   * one file `{file}` (a `File`, or a remote file read in place), a picked
   * folder `{files: Map<path, File>, rootName}`, or a store folder on a web
   * host `{url, name}`. What it is is decided from its content; `expect`
   * (`{format, layout}`, what a server or a catalog says it is) stands in
   * for its name.
   *
   * @param {Object} source
   * @param {{expect?: {format: string, layout: 'file'|'zip'|'folder'}|null,
   *          choose?: ((choice: {question: string, options: string[]}) => Promise<number>)|null}} [options]
   *   `choose`: asks the person which object of a file holding several to
   *   open (an `.rda` of several Seurat objects); resolves to its index
   * @returns {Promise<{name: string, format: string, layout: string, zarrVersion: 2|3|null,
   *   conversion: import('./anndata/transcode/session.js').Conversion|null}>}
   *   `conversion`: for a format read once into this browser (`.rds`, a
   *   MatrixMarket folder), where it is kept and what was not read
   */
  async open(source, { expect = null, fromLink = false, choose = null } = {}) {
    this._choose = choose;
    // The log follows the dataset being opened, from its first read.
    getReadActivityLog().clear();
    // Which cells to open: the next opening's request, else the tab's
    // (`cell-subset-policy.js`); one that does not name exact cells (a
    // session's) may open a first view and grow (`progressive-open.js`).
    const requested = takeCellSubsetRequest();
    const cellSubset = requested.mode === 'kept' ? requested : { ...requested, progressive: progressiveRequest() };
    const request = { source, expect, fromLink };
    // The page's tab: a store kept for one tab only is reopened by it alone.
    const snapshot = await this._call('open', { ...request, cellSubset, tab: THIS_TAB });
    this._adoptSnapshot(request, snapshot);
    return {
      name: snapshot.name,
      format: snapshot.format,
      layout: snapshot.layout,
      zarrVersion: snapshot.zarrVersion,
      conversion: snapshot.conversion ?? null,
      cellSubset: snapshot.cellSubset ?? null,
    };
  }

  /**
   * Read the open dataset again in this reader's worker with the cells
   * `cellSubset` asks for (a cell subset request, `cell-subset-policy.js`;
   * the caller's own, never the next opening's): the worker reads the
   * same source through the store it holds -- its structure, chunk indexes,
   * decoded chunks and measured link stay -- and the new reading takes over
   * what the open one built that the new cells keep (the gene indexes of the
   * rows both share: raising a subsample of the same method and seed reads
   * only the new cells, lowering it reads none). `signal` stops it, and the
   * dataset open before stays.
   *
   * @param {{cellSubset: Object, signal?: AbortSignal|null}} options
   * @returns {Promise<Object|null>} The cells now open (`cellSubset`)
   */
  async reopenCells({ cellSubset: requested, signal = null }) {
    this._requireOpen();
    const cellSubset = requireCellSubsetRequest(requested);
    const request = { source: this._source.source, expect: this._source.expect, fromLink: this._source.fromLink };
    const snapshot = await this._callWith({ signal }, 'open', { ...request, cellSubset, tab: THIS_TAB, reopen: true });
    this._adoptSnapshot(request, snapshot);
    return snapshot.cellSubset ?? null;
  }

  /**
   * Take the snapshot of an opening, and remember how to open exactly the
   * same cells again: a worker the page ended (the back/forward cache) is
   * reopened with them. @private
   */
  _adoptSnapshot(request, snapshot) {
    const subset = snapshot.cellSubset ?? null;
    this._source = {
      ...request,
      cellSubset: requestOfOpenCells(subset),
      tab: THIS_TAB,
    };
    // The page's download scheduler runs as many background reads at once
    // as this source answers (`fetch-scheduler.js`).
    if (snapshot.requestConcurrency !== undefined) setSourceRequestConcurrency(snapshot.requestConcurrency);
    this._clearMirrors();
    this._snapshot = Object.freeze({
      ...snapshot,
      obsKeys: Object.freeze([...snapshot.obsKeys]),
    });
  }

  /**
   * Which cells the open dataset presents (`anndata/subsample-plan.js`,
   * `AnnDataReader.cellSubset`): `{nObs, kept, spec, autoFit, reproduced,
   * keptValues, note}`, `kept` null when every cell is open; null before
   * a dataset is open.
   */
  get cellSubset() {
    return this._snapshot?.cellSubset ?? null;
  }

  /**
   * How a subsample represents a categorical obs field against every cell
   * (`AnnDataReader.subsampleRepresentation`); null when every cell is open.
   *
   * @param {string} key
   */
  subsampleRepresentation(key) {
    return this._call('subsampleRepresentation', key);
  }

  /**
   * How much of the neighbour graph `obsp[key]` the open subsample keeps,
   * once it was read (`AnnDataReader.subsampleGraphShare`): `{kept, of}`,
   * or null.
   *
   * @param {string} key
   */
  subsampleGraphShare(key) {
    return this._call('subsampleGraphShare', key);
  }

  /**
   * What a catalog lists about one store, read from its metadata and `uns`
   * alone (`describeAnnDataStore`), without opening it as the dataset.
   *
   * @param {Object} source - As `open()`
   * @param {{signal?: AbortSignal|null, expect?: Object|null}} [options]
   * @returns {Promise<{nObs: number, nVars: number, hasExpressionMatrix: boolean,
   *   title: string|null, cellucid: Object|null}>}
   */
  describe(source, { signal = null, expect = null } = {}) {
    return this._callWith({ signal }, 'describe', { source, expect, tab: THIS_TAB });
  }

  get nObs() {
    return this._snapshot?.nObs ?? 0;
  }

  get nVars() {
    return this._snapshot?.nVars ?? 0;
  }

  /** The input format id of the open dataset (`data/input-formats.js`), or null. */
  get format() {
    return this._snapshot?.format ?? null;
  }

  /** How the open dataset arrived: `file`, `zip` or `folder`; null before it is open. */
  get layout() {
    return this._snapshot?.layout ?? null;
  }

  /** The Zarr format version (2 or 3) of an open Zarr store; null for any other container. */
  get zarrVersion() {
    return this._snapshot?.zarrVersion ?? null;
  }

  /**
   * The link the open dataset is read over, as last measured:
   * `{latencyMs, bytesPerMs, backgroundConcurrency, protocol}` (a local
   * source: latency 0, and its decode rate in bytes per ms), or null before
   * the first measurement.
   *
   * @returns {Readonly<{latencyMs: number|null, bytesPerMs: number|null,
   *   backgroundConcurrency: number, protocol: string|null}>|null}
   */
  linkMeasurement() {
    return this._link;
  }

  get obsKeys() {
    return [...(this._snapshot?.obsKeys ?? [])];
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
   * @param {{signal?: AbortSignal|null, rows?: [number, number]|null}} [options] -
   *   `rows`: only rows `[start, end)` of the open cells, in the frame the
   *   embedding is shown in (`EmbeddingPayloads.embedding`)
   * @returns {Promise<import('./embedding-payload.js').EmbeddingPayload>}
   */
  readEmbedding(key, columns, normalize, { signal = null, rows = null } = {}) {
    this._requireOpen();
    return this._callWith({ signal }, 'readEmbedding', key, [...columns], normalize, ...(rows === null ? [] : [[rows[0], rows[1]]]));
  }

  /**
   * One vector field's display vectors, scaled in the reader worker by the
   * transform of the embedding it is bound to (`EmbeddingPayloads.vectors`).
   *
   * @param {string} key
   * @param {ReadonlyArray<number>} columns
   * @param {{key: string, columns: ReadonlyArray<number>}} embedding
   * @param {boolean} normalize
   * @param {{signal?: AbortSignal|null, rows?: [number, number]|null}} [options] -
   *   `rows`: only rows `[start, end)` of the open cells
   * @returns {Promise<{vectors: Float32Array, maxMagnitude: number}>}
   */
  readVectorField(key, columns, embedding, normalize, { signal = null, rows = null } = {}) {
    this._requireOpen();
    return this._callWith(
      { signal },
      'readVectorField',
      key,
      [...columns],
      { key: embedding.key, columns: [...embedding.columns] },
      normalize,
      ...(rows === null ? [] : [[rows[0], rows[1]]])
    );
  }

  /**
   * One boolean var column as flags, 1 where true (`AnnDataReader.readVarFlags`).
   *
   * @param {string} axis - `X`, `raw`, `mod/<name>` or `mod/<name>/raw`
   * @param {string} column
   * @returns {Promise<Uint8Array>}
   */
  readVarFlags(axis, column) {
    this._requireOpen();
    return this._call('readVarFlags', axis, column);
  }

  /**
   * Columns of one `obsm` array, row-major, as stored
   * (`AnnDataReader.readObsmColumns`): an export writes the embeddings
   * themselves, not what the view drew.
   *
   * @param {string} key
   * @param {ReadonlyArray<number>} columns
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Float32Array|Float64Array>}
   */
  readObsmColumns(key, columns, { signal = null } = {}) {
    this._requireOpen();
    return this._callWith({ signal }, 'readObsmColumns', key, Array.from(columns));
  }

  /**
   * The obs names of the open cells, in order (`AnnDataReader.readObsNames`).
   * @returns {Promise<string[]>}
   */
  readObsNames() {
    this._requireOpen();
    return this._call('readObsNames');
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
   *   the keys of every read it serves. `onPartial(values, cells)`: while
   *   the gene index of a matrix indexed in segments is built, the gene on
   *   the first `cells` open cells (a sample of them) and NaN on the rest,
   *   each time it has more (`AnnDataReader.getMatrixColumn`); the caller
   *   owns each array. `rows` (`[start, end)` of the open cells): the gene on
   *   those cells only, reading what they need; batched with the reads of
   *   the same rows.
   * @returns {Promise<Float32Array>}
   */
  getMatrixColumn(element, index, { signal = null, owner = null, key = null, onPartial = null, rows = null } = {}) {
    return this._queueGeneRead('dense', element, index, signal, owner, key, onPartial, rows);
  }

  /**
   * What reading a gene of one matrix costs now (`AnnDataReader.geneReadPlan`):
   * whether it is stored cell by cell, what the first gene reads, and where
   * the index it builds can be kept.
   *
   * @param {string} element
   * @returns {Promise<Object>}
   */
  geneReadPlan(element) {
    this._requireOpen();
    return this._call('geneReadPlan', element);
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
  _queueGeneRead(form, element, index, signal, owner = null, key = null, onPartial = null, rows = null) {
    this._requireOpen();
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      const read = { form, element, gene: index, owner, key, signal, onPartial, rows: rows === null ? null : [rows[0], rows[1]], resolve, reject, settled: false, batch: null, stopWaiting: null };
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
      const key = `${read.form}\u0000${read.element}\u0000${read.owner ?? ''}\u0000${read.rows ?? ''}`;
      let group = byRequest.get(key);
      if (group === undefined) {
        group = [];
        byRequest.set(key, group);
      }
      group.push(read);
    }
    for (const group of byRequest.values()) {
      const { form, element, owner, rows } = group[0];
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
      // A gene someone waits to see on more cells as they are read
      // (`onPartial`): each of its callers still waiting gets its own copy.
      const progressive = form === 'dense' && rows === null && group.some(read => read.onPartial !== null);
      const onPartial = !progressive ? null : ({ position, values, cells }) => {
        for (const read of readersOf.get(genes[position]) ?? []) {
          if (!read.settled && read.onPartial !== null) read.onPartial(copiedColumn(values), cells);
        }
      };
      let request;
      try {
        this._requireOpen();
        const options = { signal: batch.controller.signal, onPartial };
        if (form === 'sparse') {
          request = this._callWith(options, 'getMatrixColumnsSparse', element, genes, owner);
        } else {
          // A gene alone keeps its own request (and its own name in the read
          // activity log).
          // A read of some cells names them (`rows`) last.
          const tail = rows === null ? [] : [rows];
          request = genes.length === 1
            ? this._callWith(options, 'getMatrixColumn', element, genes[0], owner, keys, progressive, ...tail).then(column => [column])
            : this._callWith(options, 'getMatrixColumns', element, genes, owner, keys, progressive, ...tail);
        }
      } catch (error) {
        request = Promise.reject(error);
      }
      // The first caller of a gene takes the transferred arrays; any other
      // caller of the same gene gets its own copy.
      const copy = form === 'sparse'
        ? column => ({ length: column.length, indices: copiedColumn(column.indices), values: copiedColumn(column.values) })
        : copiedColumn;
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
   * Open gene route `id` (`gene-delivery.js`): the reader takes `ports`, one
   * per analysis worker (transferred), and delivers genes to them.
   *
   * @param {string} id
   * @param {MessagePort[]} ports
   * @returns {Promise<void>}
   */
  openGeneRoute(id, ports) {
    this._requireOpen();
    return this._callWith({ transfer: [...ports] }, 'openRoute', id, ports);
  }

  /**
   * The port of route `id`'s worker `worker`, which the pool replaced:
   * deliveries made for older generations are dropped.
   *
   * @param {string} id
   * @param {number} worker
   * @param {MessagePort} port
   * @param {number} generation
   * @returns {Promise<void>}
   */
  replaceGeneRoutePort(id, worker, port, generation) {
    this._requireOpen();
    return this._callWith({ transfer: [port] }, 'replaceRoutePort', id, worker, port, generation);
  }

  /**
   * Let route `id` go. A reader that is closed, or has no worker, holds no
   * route.
   *
   * @param {string} id
   * @returns {Promise<void>}
   */
  closeGeneRoute(id) {
    if (this._closed || this._worker === null) return Promise.resolve();
    return this._call('closeRoute', id);
  }

  /**
   * Read gene columns of one matrix as their non-zero entries and deliver
   * them over a gene route (`gene-delivery.js`): the arrays go from the
   * reader worker to the analysis workers `delivery` names, never here.
   * An analysis's read: `owner` is its job.
   *
   * @param {string} element
   * @param {ReadonlyArray<number>} genes
   * @param {Object} delivery - `requireColumnDelivery`
   * @param {{signal?: AbortSignal|null, owner?: string|null}} [options]
   * @returns {Promise<{bytes: number[]}>} The bytes each gene's entries hold
   */
  deliverMatrixColumnsSparse(element, genes, delivery, { signal = null, owner = null } = {}) {
    this._requireOpen();
    return this._callWith({ signal }, 'deliverColumns', element, Array.from(genes), owner, delivery);
  }

  /**
   * Read some genes in some cells of one matrix (`getMatrixCellSubset`) and
   * deliver each run of genes `delivery` names to its analysis worker.
   *
   * @param {string} element
   * @param {ArrayLike<number>} cells - Distinct cell positions
   * @param {ArrayLike<number>} genes - Distinct gene positions
   * @param {Object} delivery - `requireRunDelivery`
   * @param {{signal?: AbortSignal|null, owner?: string|null}} [options]
   * @returns {Promise<{bytes: number}>}
   */
  deliverMatrixCellSubset(element, cells, genes, delivery, { signal = null, owner = null } = {}) {
    this._requireOpen();
    const cellPositions = Uint32Array.from(cells);
    const genePositions = Uint32Array.from(genes);
    return this._callWith(
      { signal, transfer: [cellPositions.buffer, genePositions.buffer] },
      'deliverCellSubset',
      element,
      cellPositions,
      genePositions,
      owner,
      delivery
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

  /**
   * An obs field's type from its metadata alone (`AnnDataReader.getObsFieldKind`):
   * nothing is read, so describing every field at open costs no request.
   *
   * @param {string} key
   */
  getObsFieldKind(key) {
    this._requireOpen();
    return this._call('getObsFieldKind', key);
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
   * until it is released. `rows` (`[start, end)` of the open cells) reads
   * only those rows, a payload of its own that is not kept.
   *
   * @param {string} key
   * @param {{signal?: AbortSignal|null, rows?: [number, number]|null}} [options]
   */
  async getObsField(key, { signal = null, rows = null } = {}) {
    this._requireOpen();
    if (rows !== null) {
      const field = await this._callWith({ signal }, 'getObsField', key, [rows[0], rows[1]]);
      return field.dtype === 'categorical'
        ? { dtype: 'categorical', codes: field.codes, categories: Object.freeze(field.categories), ordered: field.ordered }
        : field;
    }
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

  /** End the worker's channel to the page's byte range cache. @private */
  _releaseRangeCache() {
    const close = this._closeRangeCache;
    this._closeRangeCache = null;
    close?.();
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._releaseRangeCache();
    this._clearMirrors();
    this._snapshot = null;
    const worker = this._worker;
    this._worker = null;
    this._source = null;
    this._reopening = null;
    // Closed before it started a worker: the open a spare was started for
    // was abandoned, so the spare goes too.
    if (worker === null) releaseSpareAnnDataReaderWorker();
    if (this._onPageHide !== null) {
      window.removeEventListener('pagehide', this._onPageHide);
      this._onPageHide = null;
    }
    this._failAll(new Error('The AnnData file was closed; the request was superseded'));
    this._stopAccessRevokes?.();
    this._stopAccessRevokes = null;
    worker?.terminate?.();
    // A pass the worker did not finish leaves its directory: removed once
    // the stopped worker has let it go.
    for (const directory of this._unfinishedStores) void removeTranscodedStore(directory);
    this._unfinishedStores.clear();
  }
}
