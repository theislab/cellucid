/**
 * Read activities: what one operation read, and how.
 *
 * Every public operation of a reader (opening a file, reading a field, the
 * genes of an analysis, an embedding, building a gene index, a neighbour
 * graph) runs under one `ReadActivity`. The byte reader and the format
 * readers count into it as they work — requests made and bytes fetched,
 * metadata served from the cache, chunks decoded and the bytes they decoded
 * to — so the app can say, live and afterwards, what is being read, why, how
 * much and how fast, for a local file as for a remote one.
 *
 * How much is left: the byte reader adds every request it plans for an
 * activity to `bytesPlanned` (a gene's reads are planned at once, so its
 * total is known before its first byte arrives), and an operation that
 * streams a whole array in slabs adds the array's stored size up front
 * (`expect`), so a long read reports `x of y` bytes, its rate and the time
 * left from its first second on. An operation counted in steps (an index
 * pass, by rows) reports steps too; the time left comes from whichever of
 * the two is known.
 *
 * Counting is a few additions per request or chunk; an operation without an
 * activity counts nothing.
 *
 * @module formats/io/activity
 */

/**
 * @typedef {Object} ActivitySnapshot
 * @property {number} id
 * @property {string} label - What is read, as the app names it ("gene CD3E", "obs['cell_type']")
 * @property {string} kind - What sort of operation ("open", "field", "genes", "embedding", "index", "graph",
 *   or a job's: "analysis", "outliers")
 * @property {string|null} owner - The job the operation reads for (`app/jobs/cancellable-job.js`), if any
 * @property {string[]} keys - The shared loads the operation reads for (`data/read-activity-log.js`,
 *   `adopt`): a job that joins one of them later takes the operation as its own
 * @property {'running'|'done'|'failed'|'cancelled'} status
 * @property {number} requests - Requests made to the file's source
 * @property {number} bytesFetched - Bytes those requests fetched
 * @property {number} bytesPlanned - Bytes of the requests planned so far
 * @property {number} bytesExpected - Stored bytes the operation said it will read (0 when it did not say)
 * @property {number|null} bytesTotal - The larger of the two, null while neither is known
 * @property {number|null} bytesPerSecond - Fetch rate, once it can be measured
 * @property {number|null} remainingMs - Estimated time left, while running and estimable
 * @property {number} cacheHits - Reads answered from the metadata cache
 * @property {number} chunks - Chunks decoded
 * @property {number} decodedBytes - Bytes those chunks decoded to
 * @property {number} startedAt - `performance.now()` when it started
 * @property {number} elapsedMs
 * @property {{done: number, total: number}|null} progress - Steps of a long operation
 * @property {string|null} detail - A failure's message
 */

let nextActivityId = 1;

export class ReadActivity {
  /**
   * @param {{label: string, kind: string, owner?: string|null, keys?: string[]|null, background?: boolean, onUpdate?: (snapshot: ActivitySnapshot) => void}} options
   *   `owner`: the job the operation reads for. `keys`: the shared loads it
   *   reads for, which a job may join later. `background`: work nobody
   *   waits for yet (an index built ahead of need); its requests yield to
   *   every other read's. `onUpdate` is called after every change; throttle
   *   it where it is costly.
   */
  constructor({ label, kind, owner = null, keys = null, background = false, onUpdate = null }) {
    if (typeof label !== 'string' || label.length === 0) throw new TypeError('An activity needs a label.');
    this.id = nextActivityId++;
    this.label = label;
    this.kind = kind;
    this.owner = owner;
    this.keys = Array.isArray(keys) ? keys.filter(key => typeof key === 'string') : [];
    this.background = background === true;
    this.status = 'running';
    this.requests = 0;
    this.bytesFetched = 0;
    this.bytesPlanned = 0;
    this.bytesExpected = 0;
    this.cacheHits = 0;
    this.chunks = 0;
    this.decodedBytes = 0;
    this.startedAt = performance.now();
    this.finishedAt = null;
    this.progressDone = null;
    this.progressTotal = null;
    this.detail = null;
    this._onUpdate = onUpdate;
  }

  /**
   * Requests made and the bytes they fetched. The bytes of a request still
   * under way are counted as they arrive (`requests` 0), and taken back
   * (negative bytes) if the request fails, so progress stays live during a
   * long request and never counts bytes that did not arrive.
   */
  fetched(bytes, requests = 1) {
    this.bytesFetched += bytes;
    this.requests += requests;
    this._changed();
  }

  /** Requests planned for this operation (negative: a planned one was cancelled unsent). */
  planned(bytes) {
    this.bytesPlanned += bytes;
    this._changed();
  }

  /** Stored bytes the operation will read: the whole of an array it streams. */
  expect(bytes) {
    if (!(bytes > 0)) return;
    this.bytesExpected += bytes;
    this._changed();
  }

  /** Reads answered from the metadata cache. */
  cacheHit(count = 1) {
    this.cacheHits += count;
    this._changed();
  }

  /** Chunks decoded and the bytes they decoded to. */
  decoded(chunks, bytes) {
    this.chunks += chunks;
    this.decodedBytes += bytes;
    this._changed();
  }

  /** Steps of a long operation (an index pass): `done` of `total`. */
  progress(done, total) {
    this.progressDone = done;
    this.progressTotal = total;
    this._changed();
  }

  /** The operation ended: done, failed (with the error) or cancelled. */
  finish(error = null) {
    if (this.status !== 'running') return;
    this.finishedAt = performance.now();
    if (error === null) {
      this.status = 'done';
    } else if (error?.name === 'AbortError') {
      this.status = 'cancelled';
    } else {
      this.status = 'failed';
      this.detail = error?.message ?? String(error);
    }
    this._changed();
  }

  /** @returns {ActivitySnapshot} */
  snapshot() {
    const elapsedMs = (this.finishedAt ?? performance.now()) - this.startedAt;
    const total = Math.max(this.bytesPlanned, this.bytesExpected);
    const bytesTotal = total > 0 ? Math.max(total, this.bytesFetched) : null;
    // A rate needs some time and some bytes behind it to mean anything.
    const bytesPerSecond = elapsedMs >= 250 && this.bytesFetched > 0 ? (this.bytesFetched * 1000) / elapsedMs : null;
    let remainingMs = null;
    if (this.status === 'running') {
      const done = this.progressTotal > 0 ? this.progressDone / this.progressTotal : null;
      if (done !== null && done > 0) {
        remainingMs = (elapsedMs * (1 - done)) / done;
      } else if (bytesTotal !== null && bytesPerSecond !== null) {
        remainingMs = ((bytesTotal - this.bytesFetched) * 1000) / bytesPerSecond;
      }
    }
    return {
      id: this.id,
      label: this.label,
      kind: this.kind,
      owner: this.owner,
      keys: this.keys,
      status: this.status,
      requests: this.requests,
      bytesFetched: this.bytesFetched,
      bytesPlanned: this.bytesPlanned,
      bytesExpected: this.bytesExpected,
      bytesTotal,
      bytesPerSecond,
      remainingMs,
      cacheHits: this.cacheHits,
      chunks: this.chunks,
      decodedBytes: this.decodedBytes,
      startedAt: this.startedAt,
      elapsedMs,
      progress: this.progressTotal === null ? null : { done: this.progressDone, total: this.progressTotal },
      detail: this.detail,
    };
  }

  _changed() {
    this._onUpdate?.(this);
  }
}

/**
 * Run `operation(activity)` under a new activity and finish it with the
 * outcome.
 *
 * @template T
 * @param {{label: string, kind: string, onUpdate?: Function}} options
 * @param {(activity: ReadActivity) => Promise<T>} operation
 * @returns {Promise<T>}
 */
export async function withActivity(options, operation) {
  const activity = new ReadActivity(options);
  try {
    const result = await operation(activity);
    activity.finish();
    return result;
  } catch (error) {
    activity.finish(error);
    throw error;
  }
}
