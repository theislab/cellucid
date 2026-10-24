/**
 * Streaming Gene Loader
 *
 * Reads genes ahead while streaming them to a consumer, as far ahead as the
 * run's tuner says (`shared/run-tuner.js`): the genes the workers consume
 * while one gene is fetched, held to the memory budget. How many reads run
 * at once is the reader's fetch scheduler's to decide.
 *
 * Genes are read as their non-zero entries (`{length, indices, values}`,
 * about 45 times fewer bytes than a dense column for a median gene), never
 * installed in field state; a gene already loaded (one a view shows) is
 * streamed as its shared dense array (`DataLayer.readGeneColumn`). The
 * analysis kernels take either (`compute/gene-statistics.js`).
 *
 * @module data/streaming-gene-loader
 */

import { getMemoryMonitor } from '../shared/memory-monitor.js';
import { debug, debugWarn } from '../shared/debug-utils.js';
import { formatDuration } from '../../notification-center/formatters.js';
import { createSlicedYield } from '../shared/concurrency-utils.js';

/**
 * Whether `values` is a gene's non-zero entries (`{length, indices, values}`,
 * `compute/gene-statistics.js`) rather than a dense column.
 */
function isSparseColumn(values) {
  return values !== null
    && typeof values === 'object'
    && !ArrayBuffer.isView(values)
    && values.indices instanceof Uint32Array
    && values.values instanceof Float32Array
    && values.indices.length === values.values.length;
}

/** Bytes one buffered gene holds. */
function columnBytes(values) {
  return isSparseColumn(values) ? values.indices.byteLength + values.values.byteLength : values.byteLength;
}

function requirePositiveInteger(value, owner) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${owner} must be a positive safe integer`);
  }
  return value;
}

function requireOptionalFunction(value, owner) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'function') {
    throw new TypeError(`${owner} must be a function when provided`);
  }
  return value;
}

function requireGeneList(geneList) {
  if (!Array.isArray(geneList)) {
    throw new TypeError('Streaming geneList must be an array');
  }
  const seen = new Set();
  for (const gene of geneList) {
    if (
      typeof gene !== 'string' ||
      gene.length === 0 ||
      gene !== gene.trim()
    ) {
      throw new TypeError('Every streamed gene must be one exact non-empty string');
    }
    if (seen.has(gene)) {
      throw new TypeError(`Streaming geneList contains duplicate gene "${gene}"`);
    }
    seen.add(gene);
  }
  return geneList;
}

function requireIndexCollection(indices, owner, valueCount, { sorted = false } = {}) {
  if (
    indices === null ||
    indices === undefined ||
    !Number.isSafeInteger(indices.length) ||
    indices.length < 0
  ) {
    throw new TypeError(`${owner} must be an array-like index collection`);
  }
  // Uniqueness of an unsorted collection is checked against a cell mask
  // (one byte per cell, allocated only once an index arrives out of order),
  // not a Set of every index: page index sets are ascending, so the common
  // case costs one comparison per index.
  let previous = -1;
  let seen = null;
  for (let index = 0; index < indices.length; index++) {
    const cellIndex = indices[index];
    if (
      !Number.isSafeInteger(cellIndex) ||
      cellIndex < 0 ||
      cellIndex >= valueCount
    ) {
      throw new RangeError(`${owner}[${index}] is outside the gene value range`);
    }
    if (cellIndex <= previous && seen === null) {
      if (sorted) {
        throw new TypeError(`${owner} must contain sorted unique cell indices`);
      }
      seen = new Uint8Array(valueCount);
      for (let prior = 0; prior < index; prior++) seen[indices[prior]] = 1;
    }
    if (seen !== null) {
      if (seen[cellIndex] === 1) {
        throw new TypeError(`${owner} must contain unique cell indices`);
      }
      seen[cellIndex] = 1;
    }
    previous = cellIndex;
  }
  return indices;
}

// =============================================================================
// STREAMING GENE LOADER CLASS
// =============================================================================

/**
 * Streaming Gene Loader
 *
 * Efficiently loads genes by prefetching batches in parallel while streaming
 * them to the consumer. Uses a bounded buffer to control memory usage.
 *
 * @example
 * const loader = new StreamingGeneLoader({ dataLayer, tuner });
 *
 * for await (const { gene, values, owned } of loader.streamGenesRaw(genes)) {
 *   // compute on `values` (transfer it only when `owned`)
 * }
 */
export class StreamingGeneLoader {
  /**
   * Create a new StreamingGeneLoader
   *
   * @param {Object} options
   * @param {Object} options.dataLayer - DataLayer instance for loading genes
   * @param {ReturnType<import('../shared/run-tuner.js').createRunTuner>} options.tuner -
   *   Decides how far ahead to read, and is told every read
   * @param {Function} [options.onProgress] - Progress callback
   * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
   * @param {string|null} [options.owner] - The job the reads are for
   *   (`app/jobs/cancellable-job.js`), which shows them
   * @param {string} [options.matrix='mapped'] - The expression matrix the
   *   genes are read from (`DataLayer.readGeneColumn`)
  */
  constructor(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('[StreamingGeneLoader] options must be an object');
    }
    const {
      dataLayer,
      tuner,
      onProgress,
      signal,
      owner = null,
      matrix = 'mapped',
    } = options;

    if (!dataLayer || typeof dataLayer.readGeneColumn !== 'function') {
      throw new TypeError(
        '[StreamingGeneLoader] dataLayer must implement readGeneColumn'
      );
    }
    if (
      !tuner ||
      typeof tuner.prefetchDepth !== 'function' ||
      typeof tuner.observeRead !== 'function' ||
      typeof tuner.setReadsPending !== 'function' ||
      typeof tuner.onPressure !== 'function'
    ) {
      throw new TypeError('[StreamingGeneLoader] a run tuner is required');
    }
    /** @type {ReturnType<import('../shared/run-tuner.js').createRunTuner>} */
    this._tuner = tuner;

    /** @type {Object} DataLayer instance */
    this.dataLayer = dataLayer;

    /** @type {Function|null} Progress callback */
    this.onProgress = requireOptionalFunction(onProgress, 'onProgress');

    /** @type {string|null} The job the reads are for */
    this.owner = owner;

    if (typeof matrix !== 'string' || matrix.length === 0) {
      throw new TypeError('[StreamingGeneLoader] matrix must name an expression matrix');
    }
    /** @type {string} The expression matrix the genes are read from */
    this.matrix = matrix;

    /** @type {AbortSignal|null} Abort signal */
    this.signal = signal ?? null;
    if (
      this.signal !== null &&
      (
        typeof this.signal.aborted !== 'boolean' ||
        typeof this.signal.addEventListener !== 'function' ||
        typeof this.signal.removeEventListener !== 'function'
      )
    ) {
      throw new TypeError('signal must implement the AbortSignal contract');
    }

    /** @type {number} Total cells in dataset (for memory estimation) */
    this._totalCells = requirePositiveInteger(
      dataLayer.state?.pointCount,
      'dataLayer.state.pointCount'
    );

    // Internal state
    /**
     * Read genes waiting to be streamed: each gene's values (a dense column
     * or its non-zero entries) and whether the run owns them.
     * @type {Map<string, {values: Float32Array|Object, owned: boolean}>}
     */
    this._buffer = new Map();
    /** @type {Map<string, unknown>} Exact failures from gene loading */
    this._failures = new Map();
    /** @type {Set<string>} Currently loading genes */
    this._loadingGenes = new Set();
    /** @type {Set<Promise<void>>} Exact load tasks owned by the current run */
    this._inFlightLoads = new Set();
    /** @type {string[]} Genes of the run in load order */
    this._loadQueue = [];
    /** @type {number} Position of the next gene to start loading */
    this._queueHead = 0;
    /** @type {Set<string>} Genes not yet started */
    this._queued = new Set();
    /** @type {boolean} Whether streaming has been aborted */
    this._aborted = false;
    /**
     * Ends the current run's gene downloads: those still waiting in the
     * download scheduler never start, and those under way stop.
     * @type {AbortController|null}
     */
    this._runDownloads = null;
    /** @type {number} Unique run ID to detect stale callbacks */
    this._runId = 0;
    /** @type {Map<string, Array<{resolve:Function,reject:Function}>>} */
    this._waitingFor = new Map();
    /** @type {unknown|null} Exact reason for the current abort */
    this._abortReason = null;
    /** @type {boolean} Whether one public stream owns this loader */
    this._running = false;
    /** @type {AbortController|null} The cell-subset read under way */
    this._subsetRead = null;

    // Memory monitor integration
    /** @type {Object} Memory monitor instance */
    this._memoryMonitor = getMemoryMonitor();
    /** @type {Function|null} Memory pressure unsubscribe function */
    this._pressureUnsubscribe = null;

    // Statistics
    /** @type {Object} Loading statistics */
    this._stats = {
      genesLoaded: 0,
      genesFailed: 0,
      bytesLoaded: 0,
      startTime: null,
      endTime: null
    };

    // Bind methods for use as callbacks
    this._handleMemoryPressure = this._handleMemoryPressure.bind(this);
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Read genes in the cells of two groups by cell, every gene at once, when
   * the source can and that reads less than every gene's column (a few
   * thousand cells of a large dataset): no gene is loaded whole.
   *
   * The block holds every gene's non-zero entries over the union of the two
   * groups' cells, in ascending cell order (`pointers`, `cellIndex` into that
   * union, `values`); `groupOfPosition` says which group each position of the
   * union belongs to (1 or 2). Null when the source cannot, or reading the
   * genes' columns is cheaper — then `streamGenesRaw` reads them.
   *
   * @param {string[]} geneList
   * @param {ArrayLike<number>} cellsA - Sorted unique cell positions of group A
   * @param {ArrayLike<number>} cellsB - Sorted unique cell positions of group B, disjoint from A
   * @returns {Promise<{pointers: Float64Array, cellIndex: Int32Array, values: Float32Array, groupOfPosition: Uint8Array}|null>}
   */
  async readCellSubset(geneList, cellsA, cellsB) {
    requireGeneList(geneList);
    requireIndexCollection(cellsA, 'cellsA', this._totalCells, { sorted: true });
    requireIndexCollection(cellsB, 'cellsB', this._totalCells, { sorted: true });
    if (geneList.length === 0 || typeof this.dataLayer.readGeneCellSubset !== 'function') {
      return null;
    }
    if (this._running || this._subsetRead !== null) {
      throw new Error('StreamingGeneLoader supports exactly one active read');
    }
    // The union of both groups, in cell order, and each position's group.
    const cells = new Uint32Array(cellsA.length + cellsB.length);
    const groupOfPosition = new Uint8Array(cells.length);
    let a = 0;
    let b = 0;
    for (let at = 0; at < cells.length; at++) {
      if (b >= cellsB.length || (a < cellsA.length && cellsA[a] < cellsB[b])) {
        cells[at] = cellsA[a++];
        groupOfPosition[at] = 1;
      } else {
        if (a < cellsA.length && cellsA[a] === cellsB[b]) {
          throw new RangeError(`Cell ${cellsB[b]} is in both groups`);
        }
        cells[at] = cellsB[b++];
        groupOfPosition[at] = 2;
      }
    }
    this._subsetRead = new AbortController();
    const abortSignal = this.signal;
    const abortHandler = () => this._subsetRead?.abort(abortSignal.reason);
    abortSignal?.addEventListener('abort', abortHandler, { once: true });
    try {
      if (abortSignal?.aborted) throw abortSignal.reason;
      const block = await this.dataLayer.readGeneCellSubset(geneList, cells, {
        signal: this._subsetRead.signal,
        owner: this.owner,
        matrix: this.matrix
      });
      if (this._subsetRead.signal.aborted) throw this._subsetRead.signal.reason;
      if (block === null) return null;
      this._stats.bytesLoaded = block.pointers.byteLength + block.cellIndex.byteLength + block.values.byteLength;
      return { ...block, groupOfPosition };
    } finally {
      abortSignal?.removeEventListener('abort', abortHandler);
      this._subsetRead = null;
    }
  }

  /**
   * Stream raw per-cell gene values (no group extraction).
   *
   * This is the lowest-level streaming primitive and is ideal when downstream
   * computation wants to operate on the full per-cell vector (e.g., multi-group
   * marker discovery in a worker) without allocating per-group extracted arrays.
   *
   * `values` is the gene's non-zero entries (`{length, indices, values}`),
   * read for this run and `owned` by it, or -- for a gene already loaded (one
   * a view shows) -- the field's dense array, shared and not owned. Owned
   * values may be transferred to a worker; shared ones must only be read
   * (copy them to transfer).
   *
   * @param {string[]} geneList
   * @yields {{ gene: string, values: Float32Array|{length: number, indices: Uint32Array, values: Float32Array}, index: number, owned: boolean }}
   */
  async *streamGenesRaw(geneList) {
    requireGeneList(geneList);
    if (geneList.length === 0) return;
    yield* this._run(geneList, loader => loader._streamColumns(geneList));
  }

  /**
   * Own one run: begin it, follow the caller's abort signal, stream, and wind
   * it up whatever happened.
   *
   * @param {string[]} geneList
   * @param {(loader: StreamingGeneLoader) => AsyncGenerator} stream
   * @private
   */
  async *_run(geneList, stream) {
    const currentRunId = this._beginRun(geneList);
    const abortSignal = this.signal;
    const abortHandler = abortSignal
      ? () => this._abort(abortSignal.reason)
      : null;
    if (abortSignal && abortHandler) {
      abortSignal.addEventListener('abort', abortHandler, { once: true });
      if (abortSignal.aborted) this._abort(abortSignal.reason);
    }

    let hasPrimaryError = false;
    let primaryError;
    try {
      yield* stream(this);
    } catch (error) {
      hasPrimaryError = true;
      primaryError = error;
    } finally {
      let cleanupError;
      try {
        await this._finishRun(currentRunId, abortSignal, abortHandler);
      } catch (error) {
        cleanupError = error;
      }
      if (hasPrimaryError && cleanupError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          'Streaming gene analysis and cleanup both failed'
        );
      }
      if (hasPrimaryError) throw primaryError;
      if (cleanupError !== undefined) throw cleanupError;
    }
  }

  /**
   * Yield every gene's whole column in request order, prefetching ahead.
   * @param {string[]} geneList
   * @private
   */
  async *_streamColumns(geneList) {
    this._startPrefetch();
    const yieldIfSliceSpent = createSlicedYield();

    for (let i = 0; i < geneList.length; i++) {
      this._throwIfAborted();

      const gene = geneList[i];
      const { values, owned } = await this._waitForGene(gene);

      this._buffer.delete(gene);

      if (this.onProgress) {
        this.onProgress({
          loaded: i + 1,
          total: geneList.length,
          buffered: this._buffer.size,
          loading: this._loadingGenes.size,
          queued: this._loadQueue.length - this._queueHead
        });
      }

      yield { gene, values, index: i, owned };

      this._startPrefetch();

      // Buffered genes resolve as microtasks, so a fast consumer would
      // otherwise keep the main thread for the whole buffer.
      await yieldIfSliceSpent();
    }
  }

  /**
   * Get loading statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    const duration = this._stats.endTime && this._stats.startTime
      ? this._stats.endTime - this._stats.startTime
      : (this._stats.startTime ? performance.now() - this._stats.startTime : 0);

    return {
      ...this._stats,
      durationMs: duration,
      durationFormatted: formatDuration(duration),
      genesPerSecond: duration > 0 ? (this._stats.genesLoaded / (duration / 1000)).toFixed(1) : null,
      bufferSize: this._buffer.size,
      loadingCount: this._loadingGenes.size,
      queuedCount: this._loadQueue.length - this._queueHead
    };
  }

  /**
   * Abort the streaming operation
   */
  abort() {
    const reason = new DOMException('Gene streaming was aborted', 'AbortError');
    this._subsetRead?.abort(reason);
    this._abort(reason);
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Establish sole ownership of one stream run.
   * @param {string[]} geneList
   * @returns {number}
   * @private
   */
  _beginRun(geneList) {
    if (this._running) {
      throw new Error('StreamingGeneLoader supports exactly one active stream');
    }
    if (
      this._waitingFor.size !== 0 ||
      this._inFlightLoads.size !== 0 ||
      this._pressureUnsubscribe !== null
    ) {
      throw new Error('StreamingGeneLoader retained unfinished state from a previous run');
    }
    this._running = true;
    this._runId += 1;
    const currentRunId = this._runId;
    this._stats.startTime = performance.now();
    this._stats.genesLoaded = 0;
    this._stats.genesFailed = 0;
    this._stats.bytesLoaded = 0;
    this._stats.endTime = null;
    this._aborted = false;
    this._abortReason = null;
    this._runDownloads = new AbortController();
    this._clearBuffer();
    this._failures.clear();
    this._loadingGenes.clear();
    this._loadQueue = geneList.slice();
    this._queueHead = 0;
    this._queued = new Set(geneList);

    try {
      this._pressureUnsubscribe =
        this._memoryMonitor.onMemoryPressure(this._handleMemoryPressure);
      if (typeof this._pressureUnsubscribe !== 'function') {
        throw new TypeError(
          'MemoryMonitor.onMemoryPressure must return an unsubscribe function'
        );
      }
    } catch (error) {
      this._pressureUnsubscribe = null;
      this._running = false;
      throw error;
    }

    debug(
      'StreamingGeneLoader',
      `Starting run ${currentRunId}: ${geneList.length} genes, ` +
        `read-ahead=${this._tuner.prefetchDepth()}`
    );
    return currentRunId;
  }

  /**
   * Settle all work and release every resource owned by a run.
   * @param {number} currentRunId
   * @param {AbortSignal|null} abortSignal
   * @param {Function|null} abortHandler
   * @returns {Promise<void>}
   * @private
   */
  async _finishRun(currentRunId, abortSignal, abortHandler) {
    const errors = [];
    this._aborted = true;
    this._loadQueue = [];
    this._queueHead = 0;
    this._queued.clear();
    // Nothing of this run is wanted any more.
    this._runDownloads?.abort(
      this._abortReason ?? new DOMException('Gene streaming run ended', 'AbortError')
    );
    this._runDownloads = null;

    if (abortSignal && abortHandler) {
      try {
        abortSignal.removeEventListener('abort', abortHandler);
      } catch (error) {
        errors.push(error);
      }
    }

    const unsubscribe = this._pressureUnsubscribe;
    this._pressureUnsubscribe = null;
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch (error) {
        errors.push(error);
      }
    }

    this._rejectAllWaiters(
      this._abortReason ??
        new Error('Streaming gene run ended before a requested gene settled')
    );

    try {
      await Promise.all(this._inFlightLoads);
    } catch (error) {
      errors.push(error);
    }
    this._inFlightLoads.clear();

    this._clearBuffer();
    this._failures.clear();
    this._loadingGenes.clear();

    this._stats.endTime = performance.now();
    this._running = false;
    const duration = (this._stats.endTime - this._stats.startTime) / 1000;
    const genesPerSecond =
      duration > 0 ? this._stats.genesLoaded / duration : 0;
    debug(
      'StreamingGeneLoader',
      `Run ${currentRunId} completed: ${this._stats.genesLoaded} loaded, ` +
        `${this._stats.genesFailed} failed, ${duration.toFixed(1)}s ` +
        `(${genesPerSecond.toFixed(1)} genes/s)`
    );

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `Streaming gene cleanup failed in ${errors.length} operations`
      );
    }
  }

  /**
   * @private
   */
  _throwIfAborted() {
    if (this._aborted) {
      throw this._abortReason ??
        new DOMException('Gene streaming was aborted', 'AbortError');
    }
  }

  /**
   * Empty the prefetch buffer, letting go of every column it held.
   * @private
   */
  _clearBuffer() {
    this._buffer.clear();
  }

  /**
   * Start reads until the tuner's read-ahead is buffered or under way.
   * @private
   */
  _startPrefetch() {
    const currentLoad = this._buffer.size + this._loadingGenes.size;
    const canPrefetch = Math.max(0, this._tuner.prefetchDepth() - currentLoad);
    let started = 0;

    while (
      this._queueHead < this._loadQueue.length &&
      started < canPrefetch &&
      !this._aborted
    ) {
      const gene = this._loadQueue[this._queueHead++];
      this._queued.delete(gene);
      if (
        !this._buffer.has(gene) &&
        !this._failures.has(gene) &&
        !this._loadingGenes.has(gene)
      ) {
        const loadTask = this._loadGene(gene);
        this._inFlightLoads.add(loadTask);
        void loadTask.then(
          () => {
            this._inFlightLoads.delete(loadTask);
          },
          error => {
            this._inFlightLoads.delete(loadTask);
            this._stats.genesFailed++;
            this._failures.set(gene, error);
            this._rejectGeneWaiters(gene, error);
          }
        );
        started++;
      }
    }
    this._tuner.setReadsPending(this._loadingGenes.size);

    // Log periodically to help diagnose performance issues
    if (this._stats.genesLoaded > 0 && this._stats.genesLoaded % 100 === 0) {
      const elapsed = (performance.now() - this._stats.startTime) / 1000;
      const rate = this._stats.genesLoaded / elapsed;
      debug('StreamingGeneLoader', `Progress: ${this._stats.genesLoaded} loaded (${rate.toFixed(1)}/s), loading=${this._loadingGenes.size}, buffered=${this._buffer.size}, queued=${this._loadQueue.length - this._queueHead}`);
    }
  }

  /**
   * Load a single gene
   * @param {string} gene - Gene name
   * @private
   */
  async _loadGene(gene) {
    if (this._aborted) return;

    this._loadingGenes.add(gene);
    const readStart = performance.now();

    try {
      // One of a run's many downloads: the user's own gene loads go first.
      // A gene not already loaded is read as its non-zero entries, owned by
      // this run; nothing is installed in field state.
      const { values, owned } = await this.dataLayer.readGeneColumn(
        gene,
        { priority: 'bulk', signal: this._runDownloads.signal, owner: this.owner, matrix: this.matrix }
      );
      const sparse = isSparseColumn(values);
      if (!sparse && !(values instanceof Float32Array)) {
        throw new TypeError(
          `Gene "${gene}" must read as one Float32Array or its non-zero entries`
        );
      }
      if (values.length !== this._totalCells) {
        throw new RangeError(
          `Gene "${gene}" has ${values.length} values; expected ${this._totalCells}`
        );
      }

      if (this._aborted) {
        return;
      }

      const entry = { values, owned: owned === true };
      this._buffer.set(gene, entry);
      this._stats.genesLoaded++;
      this._stats.bytesLoaded += columnBytes(values);
      // A shared dense column costs the run nothing to buffer; a read one is
      // what the read-ahead is sized by.
      this._tuner.observeRead({
        bytes: entry.owned ? columnBytes(values) : 0,
        ms: performance.now() - readStart
      });

      this._resolveGeneWaiters(gene, entry);
    } catch (error) {
      this._stats.genesFailed++;
      this._failures.set(gene, error);
      debugWarn('StreamingGeneLoader', `Failed to load gene ${gene}:`, error);
      this._rejectGeneWaiters(gene, error);
    } finally {
      this._loadingGenes.delete(gene);

      if (!this._aborted) {
        this._startPrefetch();
      }
    }
  }

  /**
   * Resolve all waiters for a gene.
   * @param {string} gene - Gene name
   * @param {{values: Float32Array|Object, owned: boolean}} entry
   * @private
   */
  _resolveGeneWaiters(gene, entry) {
    const waiters = this._waitingFor.get(gene);
    if (waiters && waiters.length > 0) {
      this._waitingFor.delete(gene);
      waiters.forEach(({ resolve }) => resolve(entry));
    }
  }

  /**
   * Reject all waiters for one gene with the exact failure.
   * @param {string} gene
   * @param {unknown} error
   * @private
   */
  _rejectGeneWaiters(gene, error) {
    const waiters = this._waitingFor.get(gene);
    if (waiters && waiters.length > 0) {
      this._waitingFor.delete(gene);
      waiters.forEach(({ reject }) => reject(error));
    }
  }

  /**
   * Reject every outstanding waiter.
   * @param {unknown} error
   * @private
   */
  _rejectAllWaiters(error) {
    for (const [gene] of this._waitingFor) {
      this._rejectGeneWaiters(gene, error);
    }
  }

  /**
   * Wait for a gene to be read.
   * @param {string} gene - Gene name
   * @returns {Promise<{values: Float32Array|Object, owned: boolean}>}
   * @private
   */
  async _waitForGene(gene) {
    if (this._buffer.has(gene)) {
      return this._buffer.get(gene);
    }
    if (this._failures.has(gene)) {
      throw this._failures.get(gene);
    }
    this._throwIfAborted();

    if (
      !this._loadingGenes.has(gene) &&
      !this._queued.has(gene)
    ) {
      throw new Error(
        `Gene "${gene}" is not owned by the active streaming run`
      );
    }

    this._startPrefetch();
    if (this._buffer.has(gene)) return this._buffer.get(gene);
    if (this._failures.has(gene)) throw this._failures.get(gene);
    this._throwIfAborted();

    return new Promise((resolve, reject) => {
      if (!this._waitingFor.has(gene)) {
        this._waitingFor.set(gene, []);
      }
      this._waitingFor.get(gene).push({ resolve, reject });
    });
  }

  /**
   * Memory pressure: the tuner reads the budget again and halves the
   * read-ahead; reads already buffered are kept.
   * @param {Object} event - Memory pressure event
   * @private
   */
  _handleMemoryPressure(event) {
    const level = event?.level;
    if (level === 'critical' || level === 'cleanup' || level === 'warning') {
      this._tuner.onPressure();
      debugWarn('StreamingGeneLoader', `Memory pressure (${level}) - read-ahead ${this._tuner.prefetchDepth()}`);
    } else if (level !== 'normal' && level !== 'unknown') {
      throw new TypeError(`Unknown memory pressure level: ${String(level)}`);
    }
  }

  /**
   * Abort the loading operation
   * @private
   */
  _abort(reason) {
    const exactReason = reason === undefined
      ? new DOMException('Gene streaming was aborted', 'AbortError')
      : reason;
    this._aborted = true;
    this._abortReason = exactReason;
    this._loadQueue = [];
    this._queueHead = 0;
    this._queued.clear();
    // Reads under way stop now, not when the run is wound up.
    this._runDownloads?.abort(exactReason);
    this._rejectAllWaiters(exactReason);
    this._clearBuffer();
    console.debug('[StreamingGeneLoader] Aborted');
  }

}
