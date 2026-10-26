/**
 * The link to one file, measured while the file is read.
 *
 * Every read of a file costs a round trip and its bytes' transfer, and how
 * those two compare decides how reads should be shaped: a file on the same
 * machine or the same network (a local `File`, `cellucid serve`, a Jupyter
 * kernel) delivers bytes about as fast as a disk, and is best read ahead of
 * need, in large pieces; a file across the internet makes every round trip
 * and every byte count. Nothing here asks where a file is. A `LinkMeter`
 * measures each request (`begin()` / `end()`) and every decision follows
 * the measurement:
 *
 * - **Round trip** (`latencyMs`): the shortest request seen, an upper bound
 *   on a round trip (and, on a fast link, the cost of one request).
 * - **Bandwidth** (`bytesPerMs`): the fastest delivery seen, over one request
 *   (its bytes over its whole time, round trip included: a lower bound) or
 *   over a period with requests continuously in flight, once the period has
 *   lasted a round trip past its first bytes.
 *
 * Until both are measured, the link is the source's prior (`ReadPolicy`:
 * what a file of its kind is assumed to be): a local file a disk, read ahead
 * from the start; a web host nothing, read ahead only once measured.
 *
 * What follows from the link:
 *
 * - `mergeGapBytes`: two ranges this close are fetched as one request where
 *   no plan prices them (a format reader grouping one read's chunks). A gap
 *   is worth fetching when it transfers in less time than the share of a
 *   round trip one request costs (`latency / concurrency`): bandwidth x
 *   latency / concurrency, with the concurrency reads are shaped for
 *   (`shapingConcurrency`: six until a web host is known to multiplex). The
 *   byte reader prices each plan's gaps under every concurrency the host
 *   may have (`concurrencies`) instead (`byte-reader.js`, `planMergeGap`).
 * - `maxRequestBytes`: a large read is split into requests this long, so it
 *   runs on every slot; each request is long enough that its round trip is
 *   covered by the other requests' transfers (bandwidth x latency x
 *   concurrency), and never shorter than the source's prior: on a fast link
 *   more, shorter requests only add per-request work and the copies that
 *   join their pieces.
 * - `roundTripBytes`: what one round trip is worth in bytes of transfer
 *   (bandwidth x latency), the price of a request in the read cost models.
 * - `readsAhead`: whether the link delivers bytes at least as fast as the
 *   reader turns stored bytes into an index (`READ_AHEAD_BYTES_PER_MS`). A
 *   read over such a link is bound by the work done on the bytes, not by
 *   their transfer, exactly as a read of a file on disk, so the file is read
 *   as one: a gene index is built as soon as the file opens, with the values.
 *   Over a slower link, bytes are fetched only when a view needs them. A
 *   local file is read ahead whatever is measured: one small read's bytes
 *   over its time is only a lower bound of a disk's bandwidth.
 *
 * **Concurrency** (`concurrency`, requests in flight at once) follows the
 * host's protocol. A browser keeps six connections to an HTTP/1.1 host and
 * answers one request per connection at a time; over HTTP/2 or HTTP/3 one
 * connection carries as many requests at once as the host's
 * `SETTINGS_MAX_CONCURRENT_STREAMS`, which RFC 9113 asks to be no smaller
 * than 100 (GitHub's is 100, measured). A web host's prior names both
 * (`connections`, `streams`), and reads over a link whose protocol is not
 * known yet start at the streams: on a host that multiplexes, every request
 * of a burst is on the wire at once instead of six at a time.
 *
 * What a browser queues beyond its connections is served first come, first
 * served, out of the reader's control; so work nobody waits for yet (an
 * index built ahead of need, `backgroundConcurrency`) never holds more than
 * `connections - 1` requests until the host is known to multiplex: over
 * HTTP/1.1 a read a view waits for then still finds a connection at once. The
 * protocol is known
 *
 * - from the browser's Resource Timing entries (`nextHopProtocol`,
 *   `watchProtocol`), where the host lets the page see them: `http/1.1`
 *   brings the concurrency back to the six connections; `h2` or `h3` proves
 *   multiplexing;
 * - otherwise (a host that sends no `Timing-Allow-Origin`, as GitHub) from
 *   bursts: requests that began together, with a connection already open
 *   (another request completed before them). Over HTTP/1.1 the request after
 *   the six connections waits for one of them to come free, so the burst's
 *   seventh completion lands at least a round trip after its first. When it
 *   lands within half a round trip, the host multiplexes. When the first six
 *   complete together (within a quarter of a round trip) and the seventh,
 *   no larger than they are, only half a round trip or more later, the burst
 *   is the browser's queue (over HTTP/2 a request as small as those that
 *   completed would have completed with them); two such bursts in a row and
 *   the host is taken for HTTP/1.1.
 *
 * Once the host multiplexes, the concurrency goes on rising while it pays:
 * while requests wait for a slot it is doubled, and kept while the requests
 * completed per millisecond rise by at least half of what doubling could give;
 * when they do not (the host's stream limit, or the bandwidth, is reached),
 * it goes back to the last level that paid and stays. A local file is read
 * as a multiplexed link from its prior's concurrency: the disk has no
 * connection limit, and no queue outside the reader.
 *
 * @module formats/io/link
 */

/**
 * The rate, in stored bytes per millisecond, at which the reader builds a
 * gene index from a compressed row-major matrix: measured on an Apple M1 Pro
 * (562k cells x 8k genes, 52M entries, gzip): the column indices (80 MB
 * stored) in 1.2 s, about 67 MB/s; the indices and the values in about
 * 90 MB/s. A link delivering at least this much is not what the index waits
 * for. A scheduling choice, measured.
 */
export const READ_AHEAD_BYTES_PER_MS = 64 * 1000;

const now = () => performance.now();

/**
 * Runs `callback` once `ms` milliseconds have passed (`setTimeout`) and
 * returns what cancels it: the timers a link's waits run on.
 *
 * @param {number} ms
 * @param {() => void} callback
 * @returns {() => void}
 */
export function afterRealTime(ms, callback) {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
}

/**
 * How long a request to a web host may stay silent before it is taken for
 * stalled, from the answers measured on the link: TCP's retransmission
 * timeout (RFC 6298), applied to the time a request waits for its answer.
 *
 * - Each answer's wait `R` updates the smoothed wait and its variation
 *   (`SRTT`, `RTTVAR`; alpha 1/8, beta 1/4); the timeout is
 *   `SRTT + 4 * RTTVAR`, never under one second (RFC 6298 2.4), and one
 *   second until the first answer (2.1).
 * - Each stall doubles it (5.5), and the next answer computes it afresh
 *   (5.7): a host that has slowed down is given longer, at once.
 *
 * A request is stalled only when neither it nor any other request of the
 * link has received anything for a whole timeout (`lastActivityAt`): while
 * the link delivers bytes, a request waiting behind them (in a browser's
 * HTTP/1.1 queue, or behind an HTTP/2 host's other streams) is waiting, not
 * stalled; once the link falls silent, every request still open is.
 */
export class ResponseClock {
  /**
   * @param {{clock?: () => number, after?: (ms: number, callback: () => void) => () => void, bandwidth?: () => number}} [options] -
   *   `clock` in milliseconds and `after`, the timers the link's requests
   *   and their waits to be asked again run on (`afterRealTime`; tests give
   *   a virtual clock and its timers); `bandwidth`, the link's measured bytes
   *   per millisecond (0 until measured)
   */
  constructor({ clock = now, after = afterRealTime, bandwidth = () => 0 } = {}) {
    this.now = clock;
    this.after = after;
    this._bandwidth = bandwidth;
    this._smoothed = null;
    this._variation = null;
    this._backoff = 1;
    /** When the link last received anything: an answer, or bytes of a body. */
    this.lastActivityAt = -Infinity;
    /** Told each time the link receives something (progress for a reader that watches it). */
    this.onReceived = null;
    /** Told of each request made again after a transient failure: `(error, attempts)`. */
    this.onRetry = null;
  }

  /** A request was answered `waitedMs` after it was sent. */
  answered(waitedMs) {
    if (this._smoothed === null) {
      this._smoothed = waitedMs;
      this._variation = waitedMs / 2;
    } else {
      this._variation = 0.75 * this._variation + 0.25 * Math.abs(this._smoothed - waitedMs);
      this._smoothed = 0.875 * this._smoothed + 0.125 * waitedMs;
    }
    this._backoff = 1;
    this.received();
  }

  /** Something arrived on the link (an answer, or bytes of a body). */
  received() {
    this.lastActivityAt = this.now();
    this.onReceived?.();
  }

  /** A request was taken for stalled: the next ones are given twice as long. */
  stalled() {
    this._backoff *= 2;
  }

  /**
   * How long a request of `expectedBytes` (0 when its size is not known) and
   * its link may stay silent before the request is stalled: the timeout, and
   * the time those bytes take at the link's measured bandwidth, as a host
   * that answers only once it holds the whole range (a proxy that buffers, a
   * CDN fetching the object from its origin) is silent for that long.
   */
  patienceMs(expectedBytes = 0) {
    const bandwidth = this._bandwidth();
    return this.timeoutMs + (expectedBytes > 0 && bandwidth > 0 ? expectedBytes / bandwidth : 0);
  }

  /** How long a request and its link may stay silent before the request is stalled. */
  get timeoutMs() {
    const base = this._smoothed === null ? 1000 : this._smoothed + 4 * this._variation;
    return Math.max(1000, base) * this._backoff;
  }
}

export class LinkMeter {
  /**
   * @param {{concurrency: number, streams?: number, blockBytes: number, mergeGapBytes: number, maxRequestBytes: number, bytesPerMs?: number}} prior
   *   The source's read policy: its concurrency (a web host's HTTP/1.1
   *   connections), its streams (a web host's start before its protocol is
   *   known; none for a local file) and block size always, its merge gap,
   *   request size and bandwidth until the link is measured
   * @param {{clock?: () => number, after?: (ms: number, callback: () => void) => () => void}} [options] -
   *   `clock` in milliseconds, and `after`, the timers of its requests
   *   (`ResponseClock`; tests)
   */
  constructor(prior, { clock = now, after = afterRealTime } = {}) {
    this._prior = prior;
    this._clock = clock;
    /** Requests an HTTP/1.1 host answers at once (the browser's connections). */
    this._connections = prior.concurrency;
    /** Where the concurrency starts: the host's streams, or a local file's concurrency. */
    this._start = prior.streams ?? prior.concurrency;
    this.concurrency = this._start;
    /**
     * Whether the host answers more than its connections at once: true for a
     * local file and once proven, false once taken for HTTP/1.1, null until
     * known.
     * @type {boolean|null}
     */
    this.multiplexed = prior.streams === undefined ? true : null;
    /** The highest concurrency known to pay, which background work stays under. */
    this._paid = this._start;
    /** The shortest request so far (Infinity until one completes). */
    this.latencyMs = Infinity;
    /** The fastest delivery over a busy period (0 until measured). */
    this.bytesPerMs = 0;
    this._inFlight = 0;
    this._completedCount = 0;
    this._busySince = 0;
    this._busyBytes = 0;
    /** The protocol the host answers with, once seen (`http/1.1`, `h2`, `h3`), else null. */
    this.protocol = null;
    /**
     * The burst being watched (requests that began together), while the
     * protocol is not known: `{openedAt, lastBegin, members, ends, closed, done}`.
     */
    this._burst = null;
    /** Bursts in a row that looked like the browser's HTTP/1.1 queue. */
    this._queuedBursts = 0;
    /**
     * Finding the concurrency: the window being measured at the current level
     * (`since`, `completed`), the rate of the level before, and whether the
     * search has ended.
     */
    this._search = { settled: false, previousRate: null, since: null, completed: 0 };
    /** When a request to this link is stalled (`ResponseClock`). */
    this.responses = new ResponseClock({ clock, after, bandwidth: () => this.bytesPerMs });
  }

  /**
   * Requests of background work that may be in flight at once: one fewer
   * than the HTTP/1.1 connections until the host is known to multiplex, then
   * one fewer than the highest concurrency known to pay. A read a view waits
   * for always finds a slot.
   */
  get backgroundConcurrency() {
    return Math.max(1, (this.multiplexed === true ? this._paid : this._connections) - 1);
  }

  /** Whether the concurrency may be searched upward now. @private */
  _searching() {
    return this.multiplexed === true && !this._search.settled;
  }

  /**
   * Requests waiting for a slot (`count`), as a scheduler sees them each time
   * it starts requests: while some wait, the concurrency is being measured.
   */
  waiting(count) {
    const search = this._search;
    if (!this._searching()) return;
    if (count > 0) {
      if (search.since === null) {
        search.since = this._clock();
        search.completed = 0;
      }
    } else if (search.since !== null) {
      // The backlog ended before the window filled: that window says nothing.
      search.since = null;
    }
  }

  /** One request completed while requests waited: weigh the level. @private */
  _completed() {
    const search = this._search;
    if (!this._searching() || search.since === null) return;
    search.completed++;
    // A window of two waves of requests at this level: one is too noisy.
    if (search.completed < 2 * this.concurrency) return;
    const rate = search.completed / Math.max(1e-6, this._clock() - search.since);
    search.since = null;
    if (search.previousRate === null || rate >= 1.5 * search.previousRate) {
      if (search.previousRate !== null) this._paid = this.concurrency;
      search.previousRate = rate;
      this.concurrency *= 2;
    } else {
      // Doubling did not pay: back to the last level that did.
      this.concurrency = Math.max(this._start, this.concurrency / 2);
      this._paid = this.concurrency;
      search.settled = true;
    }
  }

  /** The host answers one request per connection: back to its connections, for good. @private */
  _http1() {
    this.multiplexed = false;
    this.concurrency = this._connections;
    this._paid = this._connections;
    this._search.settled = true;
    this._burst = null;
  }

  /** The host answers many requests at once on one connection. @private */
  _multiplexing() {
    if (this.multiplexed !== null) return;
    this.multiplexed = true;
    this._burst = null;
  }

  /** The host's protocol, as the browser reports it: HTTP/1.1 keeps its six connections. */
  noteProtocol(protocol) {
    if (typeof protocol !== 'string' || protocol === '' || this.protocol !== null) return;
    this.protocol = protocol;
    if (this.multiplexed === true && this._prior.streams === undefined) return;
    if (protocol === 'http/1.1' || protocol === 'http/1.0') this._http1();
    else this._multiplexing();
  }

  /**
   * Learn the protocol of requests whose URL starts with `url` from the
   * Resource Timing entry the browser records for the first of them (where it
   * records one). Returns a function that stops watching.
   */
  watchProtocol(url) {
    if (typeof PerformanceObserver !== 'function' ||
        !(PerformanceObserver.supportedEntryTypes ?? []).includes('resource')) {
      return () => {};
    }
    let observer = null;
    const look = entries => {
      for (const entry of entries) {
        // The first request's entry says it, or (empty: a host that does not
        // let this page see it) nothing will: either way watching ends.
        if (typeof entry.name === 'string' && entry.name.startsWith(url)) {
          this.noteProtocol(entry.nextHopProtocol);
          observer?.disconnect();
          observer = null;
          return;
        }
      }
    };
    try {
      observer = new PerformanceObserver(list => look(list.getEntries()));
      observer.observe({ type: 'resource', buffered: true });
    } catch {
      observer = null;
    }
    return () => {
      observer?.disconnect();
      observer = null;
    };
  }

  /**
   * One request of the burst being watched ended at `at` with `bytes`
   * (null: failed or cancelled). The burst's (connections + 1)-th completion
   * decides what it shows. @private
   */
  _burstEnded(burst, started, at, bytes) {
    if (burst.done || started < burst.openedAt || started > burst.lastBegin) return;
    burst.closed = true;
    if (bytes === null) {
      burst.done = true;
      return;
    }
    burst.ends.push({ at, bytes });
    const k = this._connections + 1;
    if (burst.ends.length < k) return;
    burst.done = true;
    if (burst.members < k) return;
    const latency = this.latencyMs;
    const first = burst.ends[0].at;
    if (burst.ends[k - 1].at - first < latency / 2) {
      this._queuedBursts = 0;
      this._multiplexing();
      return;
    }
    // The browser's queue: the first `connections` completions together (as
    // requests on open connections complete), then a silence until the next
    // (a request that waited for a connection), which is no larger than
    // them, so its own bytes do not explain the silence.
    let clusterBytes = 0;
    for (let i = 0; i < k - 1; i++) clusterBytes = Math.max(clusterBytes, burst.ends[i].bytes);
    const together = burst.ends[k - 2].at - first <= latency / 4;
    const silence = burst.ends[k - 1].at - burst.ends[k - 2].at;
    if (together && silence >= latency / 2 && burst.ends[k - 1].bytes <= 2 * Math.max(1, clusterBytes)) {
      if (++this._queuedBursts >= 2) this._http1();
    } else {
      this._queuedBursts = 0;
    }
  }

  /** A request starts; returns its start time, for `end`. */
  begin() {
    const started = this._clock();
    if (this._inFlight === 0) {
      this._busySince = started;
      this._busyBytes = 0;
    }
    this._inFlight++;
    if (this.multiplexed === null) {
      // A burst is watched once a connection is open (a request completed
      // before it): the first requests of a link also wait for connections
      // being set up, which says nothing about how the host answers.
      const burst = this._burst;
      if (burst === null || burst.done) {
        if (this._completedCount > 0) {
          this._burst = { openedAt: started, lastBegin: started, members: 1, ends: [], closed: false, done: false };
        }
      } else if (!burst.closed) {
        burst.lastBegin = started;
        burst.members++;
      }
    }
    return started;
  }

  /**
   * A request that began at `started` ended with `bytes` delivered (null
   * when it failed or was cancelled: it measures nothing).
   */
  end(started, bytes) {
    this._inFlight = Math.max(0, this._inFlight - 1);
    const at = this._clock();
    if (bytes !== null) {
      this._completed();
      this._measure(at - started, bytes);
      this._busyBytes += bytes;
      // The period's first bytes arrived a round trip after it began.
      const transferring = at - this._busySince - this.latencyMs;
      if (transferring >= this.latencyMs && transferring > 0) {
        this.bytesPerMs = Math.max(this.bytesPerMs, this._busyBytes / transferring);
      }
    }
    if (this._burst !== null && this.multiplexed === null) this._burstEnded(this._burst, started, at, bytes);
    if (this._inFlight === 0 && this._burst?.done === false) this._burst.done = true;
  }

  /** One completed request's round trip and delivery. @private */
  _measure(duration, bytes) {
    this._completedCount++;
    this.latencyMs = Math.min(this.latencyMs, duration);
    if (duration > 0) this.bytesPerMs = Math.max(this.bytesPerMs, bytes / duration);
  }

  /**
   * A request of this file made before the meter existed (its head, read
   * beside the probe of its size), which took `durationMs` to deliver
   * `bytes`: it measures the link as one of the meter's own would.
   */
  recordRequest(durationMs, bytes) {
    if (!(durationMs >= 0) || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TypeError('A recorded request needs its duration and its bytes.');
    }
    this._measure(durationMs, bytes);
  }

  /** Whether both the round trip and the bandwidth are measured. */
  get measured() {
    return this.bytesPerMs > 0 && Number.isFinite(this.latencyMs);
  }

  /**
   * The requests that run at once for shaping reads: the concurrency once
   * the host is known to multiplex, its HTTP/1.1 connections until then.
   * Requests are dispatched at `concurrency` from the start, but a host not
   * yet known to multiplex may queue all but six of them in the browser, so
   * reads are split, and slots counted, as for six; which gaps a plan
   * fetches is priced under both (`concurrencies`).
   */
  get shapingConcurrency() {
    return this.multiplexed === true ? this.concurrency : this._connections;
  }

  /**
   * The requests the host may answer at once, as far as is known: the
   * concurrency once it is known to multiplex, its HTTP/1.1 connections once
   * taken for HTTP/1.1, and either until then (its connections, or its
   * streams). A plan of requests is priced under each
   * (`byte-reader.js`).
   */
  get concurrencies() {
    if (this.multiplexed === true) return [this.concurrency];
    if (this.multiplexed === false || this._start === this._connections) return [this._connections];
    return [this._connections, this._start];
  }

  get mergeGapBytes() {
    if (!this.measured) return this._prior.mergeGapBytes;
    return Math.floor(this.bytesPerMs * this.latencyMs / this.shapingConcurrency);
  }

  get maxRequestBytes() {
    if (!this.measured) return this._prior.maxRequestBytes;
    return Math.max(this._prior.maxRequestBytes, Math.floor(this.bytesPerMs * this.latencyMs * this.shapingConcurrency));
  }

  /** Bytes one round trip is worth (null until measured). */
  get roundTripBytes() {
    return this.measured ? this.bytesPerMs * this.latencyMs : null;
  }

  /**
   * A source whose prior is read ahead (a local file: a disk) stays read
   * ahead whatever one request measures: a small read's bytes over its time
   * (round trip and the reader thread's own delay included) is a lower
   * bound of the bandwidth, and has put a local `.zarr.zip` at 62.7 KB/ms,
   * under the line. A web host is read ahead once measured at or above it.
   */
  get readsAhead() {
    if ((this._prior.bytesPerMs ?? 0) >= READ_AHEAD_BYTES_PER_MS) return true;
    return this.measured && this.bytesPerMs >= READ_AHEAD_BYTES_PER_MS;
  }

  /** The link as measured, as plain data. */
  snapshot() {
    return {
      measured: this.measured,
      latencyMs: Number.isFinite(this.latencyMs) ? this.latencyMs : null,
      bytesPerMs: this.bytesPerMs > 0 ? this.bytesPerMs : null,
      concurrency: this.concurrency,
      shapingConcurrency: this.shapingConcurrency,
      backgroundConcurrency: this.backgroundConcurrency,
      multiplexed: this.multiplexed,
      protocol: this.protocol,
      mergeGapBytes: this.mergeGapBytes,
      maxRequestBytes: this.maxRequestBytes,
      roundTripBytes: this.roundTripBytes,
      readsAhead: this.readsAhead,
    };
  }
}
