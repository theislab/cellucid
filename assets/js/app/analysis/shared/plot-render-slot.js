/**
 * Transactional ownership for asynchronously rendered plots.
 *
 * A slot keeps at most one render running and one pending request. A newer
 * request replaces the pending request and makes every older request stale.
 * Plot candidates stay connected and hidden while rendering, then become the
 * committed plot only after both the slot generation and the caller's
 * `isCurrent` predicate still agree. A zero-size host waits for a real positive
 * ResizeObserver measurement; superseding or invalidating the request aborts
 * that wait.
 *
 * @module shared/plot-render-slot
 */

const ALWAYS_CURRENT = () => true;

function combineErrors(errors, message) {
  const present = [...new Set(errors.filter(Boolean))];
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  return new AggregateError(present, message);
}

class MandatorySlotFailure extends Error {
  constructor(failure) {
    super('PlotRenderSlot mandatory lifecycle failure', { cause: failure });
    this.failure = failure;
  }
}

function defaultCreateCandidate({ host }) {
  const document = host?.ownerDocument;
  if (!document || typeof document.createElement !== 'function') {
    throw new Error('PlotRenderSlot host must provide an ownerDocument');
  }

  const candidate = document.createElement('div');
  candidate.style.position = 'absolute';
  candidate.style.inset = '0';
  candidate.style.boxSizing = 'border-box';
  return candidate;
}

function defaultAttachCandidate({ host, candidate }) {
  if (typeof host.append === 'function') {
    host.append(candidate);
    return;
  }
  host.appendChild(candidate);
}

function defaultRemoveCandidate({ candidate }) {
  if (typeof candidate.remove === 'function') {
    candidate.remove();
    return;
  }
  candidate.parentNode?.removeChild(candidate);
}

function readHostMeasurement(host) {
  if (typeof host.getBoundingClientRect !== 'function') {
    throw new Error('PlotRenderSlot host must be measurable');
  }

  const bounds = host.getBoundingClientRect();
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (!Number.isFinite(width) || width < 0 || !Number.isFinite(height) || height < 0) {
    throw new Error('PlotRenderSlot host dimensions must be finite and non-negative');
  }
  return { width, height };
}

function defaultCreateResizeObserver(callback) {
  if (typeof globalThis.ResizeObserver !== 'function') {
    throw new Error('PlotRenderSlot requires ResizeObserver while its host has no positive size');
  }
  return new globalThis.ResizeObserver(callback);
}

function staleRequestError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('PlotRenderSlot request is stale');
  error.name = 'AbortError';
  return error;
}

async function defaultMeasure({ host, signal, createResizeObserver }) {
  const initial = readHostMeasurement(host);
  if (initial.width > 0 && initial.height > 0) return initial;
  if (signal?.aborted) throw staleRequestError(signal);

  return new Promise((resolve, reject) => {
    let observer = null;
    let settled = false;

    const settle = (measurement, error = null) => {
      if (settled) return;
      settled = true;

      const cleanupErrors = [];
      try {
        signal?.removeEventListener('abort', handleAbort);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        observer?.disconnect();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }

      const failure = combineErrors(
        [error, ...cleanupErrors],
        'PlotRenderSlot measurement wait failed'
      );
      if (failure) {
        reject(cleanupErrors.length > 0 ? new MandatorySlotFailure(failure) : failure);
      } else {
        resolve(measurement);
      }
    };

    const readPositiveMeasurement = () => {
      try {
        const measurement = readHostMeasurement(host);
        if (measurement.width > 0 && measurement.height > 0) {
          settle(measurement);
        }
      } catch (error) {
        settle(null, error);
      }
    };
    const handleAbort = () => settle(null, staleRequestError(signal));

    try {
      observer = createResizeObserver(readPositiveMeasurement);
      if (!observer || typeof observer.observe !== 'function' ||
          typeof observer.disconnect !== 'function') {
        throw new Error('PlotRenderSlot resize observer must implement observe and disconnect');
      }
      signal?.addEventListener('abort', handleAbort, { once: true });
      if (signal?.aborted) {
        handleAbort();
        return;
      }

      observer.observe(host);
      // Close the gap between the first measurement and observer registration.
      readPositiveMeasurement();
    } catch (error) {
      settle(null, error);
    }
  });
}

function defaultResize({ candidate, measurement }) {
  const width = Number(measurement?.width);
  const height = Number(measurement?.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('PlotRenderSlot measurement must contain finite, positive dimensions');
  }

  candidate.style.width = `${width}px`;
  candidate.style.height = `${height}px`;
}

function setCandidateHidden(candidate, hidden) {
  if (!candidate?.style) {
    throw new Error('PlotRenderSlot candidates must expose a style object');
  }

  if (hidden) {
    candidate.style.visibility = 'hidden';
    candidate.style.pointerEvents = 'none';
    candidate.setAttribute?.('aria-hidden', 'true');
    return;
  }

  candidate.style.visibility = '';
  candidate.style.pointerEvents = '';
  candidate.removeAttribute?.('aria-hidden');
}

/**
 * Owns the render/commit/retirement lifecycle for one plot host.
 *
 * Dependencies use object arguments so integrations can add plot-specific
 * metadata without wrapping or cloning the scientific payload.
 */
export class PlotRenderSlot {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.host Connected element that owns plot candidates.
   * @param {Function} options.render Receives `{ candidate, payload, measurement }`.
   * @param {Function} options.purge Receives `{ candidate, renderResult }`.
   * @param {Function} [options.measure]
   * @param {Function} [options.resize]
   * @param {Function} [options.createResizeObserver]
   * @param {Function} [options.createCandidate]
   * @param {Function} [options.attachCandidate]
   * @param {Function} [options.removeCandidate]
   */
  constructor({
    host,
    render,
    purge,
    measure = defaultMeasure,
    resize = defaultResize,
    createResizeObserver = defaultCreateResizeObserver,
    createCandidate = defaultCreateCandidate,
    attachCandidate = defaultAttachCandidate,
    removeCandidate = defaultRemoveCandidate
  } = {}) {
    if (!host) throw new Error('PlotRenderSlot requires a host');
    if (typeof render !== 'function') throw new Error('PlotRenderSlot requires a render function');
    if (typeof purge !== 'function') throw new Error('PlotRenderSlot requires a purge function');

    const dependencies = {
      measure,
      resize,
      createResizeObserver,
      createCandidate,
      attachCandidate,
      removeCandidate
    };
    for (const [name, dependency] of Object.entries(dependencies)) {
      if (typeof dependency !== 'function') {
        throw new Error(`PlotRenderSlot ${name} must be a function`);
      }
    }

    this._host = host;
    this._renderCandidate = render;
    this._purgeCandidate = purge;
    this._measure = measure;
    this._resize = resize;
    this._createResizeObserver = createResizeObserver;
    this._createCandidate = createCandidate;
    this._attachCandidate = attachCandidate;
    this._removeCandidate = removeCandidate;

    this._generation = 0;
    this._running = null;
    this._pending = null;
    this._committed = null;
    this._retirementBacklog = new Set();
    this._exclusiveTail = Promise.resolve();
    this._destroyed = false;
    this._destroyPromise = null;
  }

  /**
   * Render a payload transactionally.
   *
   * The exact payload object is passed to the renderer. The promise resolves to
   * the committed candidate, or `null` when this request is superseded or its
   * external ownership predicate becomes false.
   *
   * @param {*} payload
   * @param {{ isCurrent?: Function }} [options]
   * @returns {Promise<HTMLElement|null>}
   */
  render(payload, { isCurrent = ALWAYS_CURRENT } = {}) {
    if (this._destroyed) {
      return Promise.reject(new Error('PlotRenderSlot has been destroyed'));
    }
    if (typeof isCurrent !== 'function') {
      return Promise.reject(new Error('PlotRenderSlot isCurrent must be a function'));
    }

    const generation = ++this._generation;
    this._abortRequest(this._running?.request, 'PlotRenderSlot render was superseded');
    if (this._pending) {
      this._abortRequest(this._pending, 'PlotRenderSlot render was superseded');
      this._settleRequest(this._pending, null);
    }

    const request = {
      generation,
      payload,
      isCurrent,
      abortController: new AbortController(),
      settled: false,
      resolve: null,
      reject: null
    };
    const promise = new Promise((resolve, reject) => {
      request.resolve = resolve;
      request.reject = reject;
    });

    this._pending = request;
    this._pump();
    return promise;
  }

  /**
   * Make all existing requests stale and retire the committed plot.
   *
   * A running renderer is allowed to settle before its candidate is purged.
   * Its own render promise reports any cleanup failure.
   *
   * @returns {Promise<void>}
   */
  invalidate() {
    if (this._destroyed) {
      return this._destroyPromise ?? Promise.resolve();
    }

    this._generation += 1;
    this._abortRequest(this._running?.request, 'PlotRenderSlot was invalidated');
    if (this._pending) {
      this._abortRequest(this._pending, 'PlotRenderSlot was invalidated');
      this._settleRequest(this._pending, null);
      this._pending = null;
    }

    return this._runExclusive(async () => {
      const committed = this._committed;
      this._committed = null;
      const records = new Set([
        ...this._retirementBacklog,
        committed
      ]);
      const errors = [];
      for (const record of records) {
        const error = await this._retireCapturingError(record);
        if (error) errors.push(error);
      }
      const failure = combineErrors(
        errors,
        'PlotRenderSlot invalidation failed'
      );
      if (failure) throw failure;
    });
  }

  /**
   * Run an operation with the currently committed plot.
   *
   * Operations are serialized with one another and with plot commits, so the
   * leased candidate cannot be retired until the callback settles.
   * The callback must not await another lifecycle method on this same slot,
   * because that method must wait for the lease to end.
   *
   * @template T
   * @param {(candidate: HTMLElement, renderResult: *) => Promise<T>|T} operation
   * @returns {Promise<T>}
   */
  withCommittedPlot(operation) {
    if (typeof operation !== 'function') {
      return Promise.reject(new Error('PlotRenderSlot export operation must be a function'));
    }
    if (this._destroyed) {
      return Promise.reject(new Error('PlotRenderSlot has been destroyed'));
    }

    return this._runExclusive(async () => {
      const committed = this._committed;
      if (!committed) {
        throw new Error('PlotRenderSlot has no committed plot');
      }
      return operation(committed.candidate, committed.renderResult);
    });
  }

  /**
   * Permanently stop the slot and retire all of its candidates.
   *
   * Destruction is idempotent and waits for a running renderer to settle before
   * resolving. Cleanup failures are surfaced.
   *
   * @returns {Promise<void>}
   */
  destroy() {
    if (this._destroyPromise) return this._destroyPromise;

    this._destroyed = true;
    this._generation += 1;
    this._abortRequest(this._running?.request, 'PlotRenderSlot was destroyed');
    if (this._pending) {
      this._abortRequest(this._pending, 'PlotRenderSlot was destroyed');
      this._settleRequest(this._pending, null);
      this._pending = null;
    }

    const committedRetirement = this._runExclusive(async () => {
      const committed = this._committed;
      this._committed = null;
      const records = new Set([
        ...this._retirementBacklog,
        committed
      ]);
      for (const record of records) {
        await this._retireCapturingError(record);
      }
    });
    const runningCompletion = this._running?.completion ?? Promise.resolve({ error: null });

    this._destroyPromise = (async () => {
      const [, runningOutcome] = await Promise.all([
        committedRetirement,
        runningCompletion
      ]);
      const errors = [];
      if (runningOutcome.error) errors.push(runningOutcome.error);

      const finalRetirementErrors = await this._runExclusive(async () => {
        const failures = [];
        for (const record of [...this._retirementBacklog]) {
          const error = await this._retireCapturingError(record);
          if (error) failures.push(error);
        }
        return failures;
      });
      errors.push(...finalRetirementErrors);

      const failure = combineErrors(errors, 'PlotRenderSlot destruction failed');
      if (failure) throw failure;
    })();

    return this._destroyPromise;
  }

  _pump() {
    if (this._destroyed || this._running || !this._pending) return;

    const request = this._pending;
    this._pending = null;
    const running = { request, completion: null };
    this._running = running;
    running.completion = this._runRequest(request);
  }

  async _runRequest(request) {
    let value = null;
    let error = null;
    try {
      value = await this._executeRequest(request);
    } catch (requestError) {
      error = requestError;
    }

    if (error) {
      this._settleRequest(request, null, error);
    } else {
      this._settleRequest(request, value);
    }

    if (this._running?.request === request) {
      this._running = null;
    }
    this._pump();
    return { error };
  }

  async _executeRequest(request) {
    if (!this._isRequestCurrent(request)) return null;

    let record = null;
    let operationError = null;
    let operationErrorMustSurface = false;
    try {
      const candidate = this._createCandidate({
        host: this._host,
        payload: request.payload
      });
      if (!candidate) {
        throw new Error('PlotRenderSlot createCandidate returned no candidate');
      }

      record = {
        candidate,
        purged: false,
        removed: false,
        renderResult: undefined,
        retired: false
      };
      setCandidateHidden(candidate, true);
      await this._attachCandidate({
        host: this._host,
        candidate,
        payload: request.payload
      });
      if (candidate.isConnected === false) {
        throw new Error('PlotRenderSlot candidate must be connected before rendering');
      }
      let stalePreparation = await this._retirePreparedCandidateIfStale(request, record);
      if (stalePreparation) {
        if (stalePreparation.error) {
          operationErrorMustSurface = true;
          throw stalePreparation.error;
        }
        return null;
      }

      const measurement = await this._measure({
        host: this._host,
        candidate,
        payload: request.payload,
        signal: request.abortController.signal,
        createResizeObserver: this._createResizeObserver
      });
      const measuredWidth = Number(measurement?.width);
      const measuredHeight = Number(measurement?.height);
      if (!Number.isFinite(measuredWidth) || measuredWidth <= 0 ||
          !Number.isFinite(measuredHeight) || measuredHeight <= 0) {
        throw new Error('PlotRenderSlot measure must resolve with finite, positive dimensions');
      }
      stalePreparation = await this._retirePreparedCandidateIfStale(request, record);
      if (stalePreparation) {
        if (stalePreparation.error) {
          operationErrorMustSurface = true;
          throw stalePreparation.error;
        }
        return null;
      }
      await this._resize({
        host: this._host,
        candidate,
        measurement,
        payload: request.payload
      });
      stalePreparation = await this._retirePreparedCandidateIfStale(request, record);
      if (stalePreparation) {
        if (stalePreparation.error) {
          operationErrorMustSurface = true;
          throw stalePreparation.error;
        }
        return null;
      }
      record.renderResult = await this._renderCandidate({
        host: this._host,
        candidate,
        payload: request.payload,
        measurement
      });
    } catch (error) {
      if (error instanceof MandatorySlotFailure) {
        operationError = error.failure;
        operationErrorMustSurface = true;
      } else {
        operationError = error;
      }
    }

    if (operationErrorMustSurface) {
      const cleanupError = await this._retireCapturingError(record);
      const failure = combineErrors(
        [operationError, cleanupError],
        'PlotRenderSlot prepared candidate cleanup failed'
      );
      throw failure;
    }

    let current = false;
    let ownershipError = null;
    try {
      current = this._isRequestCurrent(request);
    } catch (error) {
      ownershipError = error;
    }

    if (operationError || ownershipError) {
      const cleanupError = await this._retireCapturingError(record);
      const failure = combineErrors(
        [
          current || ownershipError || operationErrorMustSurface ? operationError : null,
          ownershipError,
          cleanupError
        ],
        'PlotRenderSlot render transaction failed'
      );
      if (failure) throw failure;
      return null;
    }

    return this._runExclusive(async () => {
      let commitCurrent = false;
      let commitOwnershipError = null;
      try {
        commitCurrent = this._isRequestCurrent(request);
      } catch (error) {
        commitOwnershipError = error;
      }

      if (!commitCurrent || commitOwnershipError) {
        const cleanupError = await this._retireCapturingError(record);
        const failure = combineErrors(
          [commitOwnershipError, cleanupError],
          'PlotRenderSlot stale candidate cleanup failed'
        );
        if (failure) throw failure;
        return null;
      }

      try {
        setCandidateHidden(record.candidate, false);
      } catch (error) {
        const cleanupError = await this._retireCapturingError(record);
        const failure = combineErrors(
          [error, cleanupError],
          'PlotRenderSlot candidate commit failed'
        );
        throw failure;
      }

      const previous = this._committed;
      const priorBacklog = [...this._retirementBacklog];
      this._committed = record;
      // The new candidate is now the coherent publication. A failure while
      // retiring the previous candidate must not turn that successful commit
      // into a rejected render; retain the old record and retry it from the
      // next lifecycle boundary instead.
      await this._retireCapturingError(previous);
      for (const retiredEarlier of priorBacklog) {
        await this._retireCapturingError(retiredEarlier);
      }
      return record.candidate;
    });
  }

  _isRequestCurrent(request) {
    if (this._destroyed || request.abortController.signal.aborted ||
        request.generation !== this._generation) {
      return false;
    }
    return Boolean(request.isCurrent());
  }

  async _retirePreparedCandidateIfStale(request, record) {
    let current = false;
    let ownershipError = null;
    try {
      current = this._isRequestCurrent(request);
    } catch (error) {
      ownershipError = error;
    }
    if (current && !ownershipError) return null;

    const cleanupError = await this._retireCapturingError(record);
    const failure = combineErrors(
      [ownershipError, cleanupError],
      'PlotRenderSlot prepared candidate cleanup failed'
    );
    return { error: failure };
  }

  _settleRequest(request, value, error = null) {
    if (!request || request.settled) return;
    request.settled = true;
    if (error) {
      request.reject(error);
    } else {
      request.resolve(value);
    }
  }

  _abortRequest(request, message) {
    if (!request || request.abortController.signal.aborted) return;
    const error = new Error(message);
    error.name = 'AbortError';
    request.abortController.abort(error);
  }

  _runExclusive(operation) {
    const result = this._exclusiveTail.then(operation);
    this._exclusiveTail = result.catch(() => {});
    return result;
  }

  async _retireCapturingError(record) {
    if (!record) return null;
    try {
      await this._retire(record);
      this._retirementBacklog.delete(record);
      return null;
    } catch (error) {
      if (!record.retired) {
        this._retirementBacklog.add(record);
      }
      return error;
    }
  }

  async _retire(record) {
    if (!record || record.retired) return;

    const errors = [];
    try {
      setCandidateHidden(record.candidate, true);
    } catch (error) {
      errors.push(error);
    }
    if (!record.purged) {
      try {
        await this._purgeCandidate({
          host: this._host,
          candidate: record.candidate,
          renderResult: record.renderResult
        });
        record.purged = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (!record.removed) {
      try {
        await this._removeCandidate({
          host: this._host,
          candidate: record.candidate
        });
        record.removed = true;
      } catch (error) {
        errors.push(error);
      }
    }
    record.retired = record.purged && record.removed;

    const failure = combineErrors(errors, 'PlotRenderSlot candidate retirement failed');
    if (failure) throw failure;
  }
}
