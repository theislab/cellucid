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
 * - **Round trip** (`latencyMs`): the shortest of the latest requests whose
 *   time is mostly a round trip (their bytes' transfer at their share of the
 *   bandwidth at most half of it; every request until the bandwidth is
 *   measured), `RECENT_REQUESTS` of them: an upper bound on a round trip now
 *   (and, on a fast link, the cost of one request). A request mostly
 *   transfer says little of the round trip, and counted would make long
 *   requests look like a slow round trip, which lengthens requests more.
 * - **Round trip under load** (`loadedLatencyMs`): what a request takes as
 *   the reads go, less its bytes' transfer at its share of the bandwidth
 *   (the requests in flight sharing it): the median of the latest
 *   requests' made on a connection already set up (a request that opened
 *   one waited for its handshakes too, and priced from an opening's
 *   requests it would put the round trip under load far above what it takes
 *   as the reads run). A host answers slower under load than idle (S3's
 *   small requests, measured: 22_decisions_link_model_and_request_planning.md),
 *   and what a read will take is priced at this
 *   (`loadedRoundTripMs`: the gene sample, Genes read for, an export,
 *   a progressive first view); shaping (which gaps a plan fetches, how
 *   long a request is) keeps the shortest.
 * - **Requests a host completes under load** (`loadedRequestMs`): with at
 *   least `backgroundConcurrency` requests in flight and requests waiting, the time between completions less their bytes'
 *   transfer, over the latest of them: what one more request really costs
 *   when a read is request-bound. A path may complete only so many small
 *   requests a second whatever the connections (CELLxGENE's S3 mirrors,
 *   measured: 22_decisions_link_model_and_request_planning.md), so plans
 *   price a request at no less (`requestCostMs`, `requestMs`): the floor of a read is the
 *   longer of its requests over that rate and its bytes over the bandwidth.
 * - **Bandwidth** (`bytesPerMs`): the fastest of the latest requests'
 *   deliveries, each over one request (its bytes over its whole time, round
 *   trip included: a lower bound) or over the stretch of requests
 *   continuously in flight it ended (at most the latest requests', once the
 *   stretch has lasted a round trip past its first bytes).
 *
 * **A link changes while it is read** (a connection gets slower, then faster
 * again), so each is measured over the latest requests only, a window that
 * slides with every request: the shortest round trip and the fastest
 * delivery of a window, as TCP BBR models a path (Cardwell et al., "BBR:
 * Congestion-Based Congestion Control", ACM Queue 14(5), 2016: a windowed
 * minimum of the round trip, a windowed maximum of the delivery rate). A
 * link that gets faster is followed at its first faster request; one that
 * gets slower once a window of requests has seen nothing faster; one odd
 * request moves neither the shortest nor the fastest of a window the other
 * way. Every decision that follows (merge gaps, request sizes, reading
 * ahead, the price of a read) reads the window as it is now.
 * - **The clock's resolution** (`clockTickMs`): a request is timed by a
 *   clock that may tick in whole milliseconds (`performance.now()` in
 *   WebKit and Firefox workers: 1 ms; Chromium 0.1 ms).
 *   One request's measured time is right on average, but the shortest of
 *   many is the one the ticks cut shortest: below the true shortest by up to
 *   a tick, and 0 for a request that ended within one (a server on the same
 *   machine), which priced every round trip at nothing (no gap merged, no
 *   ask of the page's range cache, `range-cache.js`). Each request is
 *   counted half a tick longer than measured: the shortest then lies in the
 *   middle of where the true one does, and no request takes no time.
 *
 * Until both are measured, the link is the source's prior (`ReadPolicy`:
 * what a file of its kind is assumed to be): a local file a disk, read ahead
 * from the start; a web host nothing, read ahead only once measured.
 * A local file's reads measure only a lower bound of its bandwidth (a read
 * of a few hundred bytes is mostly its fixed cost): what follows is priced
 * at no less than its prior's bandwidth.
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
 *   runs on every slot. The bandwidth measured is the whole link's, shared
 *   by every request in flight: a request of one round trip's worth of bytes
 *   (bandwidth x latency) already keeps the link busy for as long as its own
 *   round trip, so a longer one only serializes its bytes on one connection
 *   (over HTTP/1.1, behind nothing else) while other slots idle. Never
 *   shorter than the source's prior: on a fast link more, shorter requests
 *   only add per-request work and the copies that join their pieces. Where
 *   one connection carries only part of the link (`connectionBytesPerMs`,
 *   a transfer-bound request's own delivery: Amazon S3), a plan's long
 *   requests are split further, over every connection, down to one
 *   connection's round trip of bytes (`byte-reader.js` `requestPieceBytes`).
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
 * than 100 (GitHub's is 100). A web host's prior names both
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

import { measureOf } from '../../utils/machine.js';

/**
 * The rate, in stored bytes per millisecond, at which the reader builds a
 * gene index from a compressed row-major matrix. A link delivering at least
 * this much is not what the index waits for. A scheduling choice (measured:
 * 22_decisions_link_model_and_request_planning.md).
 */
export const READ_AHEAD_BYTES_PER_MS = 64 * 1000;

/** The clock links are measured with unless given another: `performance.now()`. */
export const performanceNow = () => performance.now();

/** This realm's `performance.now()` resolution, once measured (`clockTickMs`). */
let realmTickMs = null;

/**
 * The resolution, in milliseconds, of `performance.now()` in this realm: the
 * smallest step it is seen to take in a few steps (`clock` itself: a few
 * ticks of busy reading, once per realm).
 *
 * @returns {number}
 */
export function clockTickMs() {
  if (realmTickMs !== null) return realmTickMs;
  let smallest = Infinity;
  let last = performanceNow();
  for (let steps = 0, reads = 0; steps < 3 && reads < 10_000_000; reads++) {
    const at = performanceNow();
    if (at === last) continue;
    if (at > last) smallest = Math.min(smallest, at - last);
    last = at;
    steps++;
  }
  realmTickMs = Number.isFinite(smallest) ? smallest : 0;
  return realmTickMs;
}

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

/** The shortest a request may stay silent before it is stalled, once its link has answered: RFC 6298's floor (2.4). */
export const MIN_STALL_TIMEOUT_MS = 1000;

/**
 * How long a request may stay silent before its link has answered once: its
 * first answer waits for the connection to be made too (DNS, TCP and TLS,
 * and any redirect), which a round trip's timeout never covered: RFC 6298
 * 5.7 and RFC 1122 4.2.3.1 give connection set-up 3 s. A healthy host's
 * first byte can take longer than one second (measured:
 * 22_decisions_link_model_and_request_planning.md).
 */
export const FIRST_ANSWER_TIMEOUT_MS = 3000;

/**
 * How long a request to a web host may stay silent before it is taken for
 * stalled, from the answers measured on the link: TCP's retransmission
 * timeout (RFC 6298), applied to the time a request waits for its answer.
 *
 * - Each answer's wait `R` updates the smoothed wait and its variation
 *   (`SRTT`, `RTTVAR`; alpha 1/8, beta 1/4); the timeout is
 *   `SRTT + 4 * RTTVAR`, never under one second (RFC 6298 2.4), and three
 *   seconds until the first answer (`FIRST_ANSWER_TIMEOUT_MS`: that answer
 *   waits for the connection to be made, RFC 6298 5.7).
 * - Each stall doubles it (5.5), and the next answer computes it afresh
 *   (5.7): a host that has slowed down is given longer, at once.
 *
 * A request is stalled only when neither it, nor any other request of the
 * link (`lastActivityAt`), nor any request to its host anywhere in this site
 * (`hosts.js`: the browser's connections to a host are shared by every
 * reader) has received anything for a whole timeout: while the host
 * delivers bytes, a request waiting behind them (in a browser's HTTP/1.1
 * queue, or behind an HTTP/2 host's other streams) is waiting, not stalled;
 * once the host falls silent, every request still open is. A host's first
 * answer time seeds a link's timeout (`hosts.js` `rememberedAnswer`,
 * `ResponseClock.answered`).
 */
export class ResponseClock {
  /**
   * @param {{clock?: () => number, after?: (ms: number, callback: () => void) => () => void, bandwidth?: () => number}} [options] -
   *   `clock` in milliseconds and `after`, the timers the link's requests
   *   and their waits to be asked again run on (`afterRealTime`; tests give
   *   a virtual clock and its timers); `bandwidth`, the link's measured bytes
   *   per millisecond (0 until measured)
   */
  constructor({ clock = performanceNow, after = afterRealTime, bandwidth = () => 0 } = {}) {
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
    /**
     * Told when a request waits for a wait its host named (a request
     * budget's, a `Retry-After`: `byte-source.js` `HostWait`), and null once
     * it no longer does.
     */
    this.onWait = null;
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
    const base = this._smoothed === null ? FIRST_ANSWER_TIMEOUT_MS : this._smoothed + 4 * this._variation;
    return Math.max(MIN_STALL_TIMEOUT_MS, base) * this._backoff;
  }
}

/**
 * The latest requests the link is measured over (its round trip, the round
 * trip under load and its bandwidth): enough that one odd request moves no
 * estimate (the shortest, the median and the fastest of sixteen), few enough
 * that a slower or faster link is followed within a few rounds of requests.
 * A measuring choice.
 */
export const RECENT_REQUESTS = 16;

/**
 * A request whose time is at least this many round trips is bounded by the
 * link's transfer, not by its round trip: its delivery measures the link
 * (`LinkMeter._rate`). Two round trips of transfer past its own round trip,
 * so a host answering slower under load than idle (S3) is not taken for a
 * slower link. A measuring choice.
 */
const TRANSFER_BOUND = 3;

/**
 * One connection carries only part of the link when a transfer-bound
 * request alone on the link (nothing else in flight from its start to its
 * end) delivered less than this share of the most the link has delivered,
 * which requests together have shown (Amazon S3 delivers a small share of the
 * link on each connection). A request's delivery while others share the link
 * is its share of a busy link, not what a connection can carry: counted as a
 * connection's, it would make `requestPieceBytes` split the next plan finer,
 * which shares the link among more requests, whose deliveries are smaller
 * again, without end (measured: 22_decisions_link_model_and_request_planning.md).
 * A measuring choice (the margin keeps a lone request a little below the
 * link's best for the link's).
 */
const CONNECTION_BOUND_SHARE = 0.8;

/**
 * Transfer-bound deliveries at or above a rate before it counts as what the
 * link can carry for that rule (`connectionRoundTripBytes`): requests in
 * flight together end one after another, each a delivery of the stretch, so
 * a link that carries more than a connection shows it many times over; one
 * delivery timed over a stretch little longer than the clock's tick (a
 * loopback host, bytes a cache had) can be any rate, and taken alone it
 * split every later plan of the page (measured:
 * 22_decisions_link_model_and_request_planning.md). A measuring choice.
 */
const LINK_EVIDENCE = 4;

/** The smallest (`sign` 1) or largest (-1) of a ring's first `count` values. */
function extremeOf(ring, count, sign) {
  let best = sign > 0 ? Infinity : 0;
  for (let i = 0; i < Math.min(count, ring.length); i++) best = sign > 0 ? Math.min(best, ring[i]) : Math.max(best, ring[i]);
  return best;
}

/**
 * What one round trip to a link is worth in bytes of transfer: measured
 * (`roundTripBytes`: bandwidth x latency), else the merge gap per request
 * that really runs at once (`shapingConcurrency`: a host's connections
 * until it is known to multiplex -- six over HTTP/1.1, each mirror its own
 * -- never the streams requests are dispatched at, which priced an
 * HTTP/1.1 host's round trip at 100 requests' gaps). The one rule every
 * read price uses (`sparse-column-index.js`, `formats/hdf5/chunk-index.js`,
 * `data/anndata/matrix-access.js`). `link`: a `LinkMeter`, its snapshot,
 * or costs of the same names; 0 without one.
 *
 * @param {{roundTripBytes?: number|null, mergeGapBytes?: number, shapingConcurrency?: number, concurrency?: number}|null|undefined} link
 * @returns {number}
 */
export function roundTripBytesOf(link) {
  if (link === null || link === undefined) return 0;
  return link.roundTripBytes ?? (link.mergeGapBytes ?? 0) * (link.shapingConcurrency ?? link.concurrency ?? 1);
}

/**
 * The round trip a read is priced at over `link` (a `LinkMeter` or its
 * snapshot): its round trip under load once measured, never shorter than
 * its shortest; the shortest until then.
 *
 * @param {{latencyMs: number|null, loadedLatencyMs?: number|null}} link
 * @returns {number}
 */
export function loadedRoundTripMs(link) {
  const shortest = link.latencyMs;
  const loaded = link.loadedLatencyMs;
  return Number.isFinite(loaded) && loaded > shortest ? loaded : shortest;
}

export class LinkMeter {
  /**
   * @param {{concurrency: number, streams?: number, blockBytes: number, mergeGapBytes: number, maxRequestBytes: number, bytesPerMs?: number}} prior
   *   The source's read policy: its concurrency (a web host's HTTP/1.1
   *   connections), its streams (a web host's start before its protocol is
   *   known; none for a local file) and block size always, its merge gap,
   *   request size and bandwidth until the link is measured
   * @param {{clock?: () => number, after?: (ms: number, callback: () => void) => () => void, tickMs?: number}} [options] -
   *   `clock` in milliseconds, and `after`, the timers of its requests
   *   (`ResponseClock`; tests); `tickMs`, the clock's resolution
   *   (`clockTickMs` for `performance.now`, else 0: a virtual clock is exact)
   */
  constructor(prior, { clock = performanceNow, after = afterRealTime, tickMs = clock === performanceNow ? clockTickMs() : 0, requestCost = null } = {}) {
    if (!(tickMs >= 0)) throw new TypeError('A clock tick is a duration of 0 or more milliseconds.');
    if (requestCost !== null && typeof requestCost !== 'function') throw new TypeError('A request cost is a function of no argument.');
    this._prior = prior;
    /** What the host's request budget makes one more request cost (`hosts.js` `requestCostMs`), read when priced. */
    this._requestCost = requestCost;
    this._clock = clock;
    /** Half the clock's resolution: what each measured request is counted longer by. */
    this._halfTick = tickMs / 2;
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
    /** The latest requests' times that were mostly a round trip, a ring of `RECENT_REQUESTS`: `latencyMs` is their shortest. */
    this._roundTrips = new Float64Array(RECENT_REQUESTS);
    this._roundTripCount = 0;
    this._latency = null;
    /**
     * The latest requests' round trips under load (each request's time less
     * its bytes' transfer at its share of the bandwidth), a ring of
     * `RECENT_REQUESTS`: `loadedLatencyMs` is their median (null: stale).
     */
    this._turns = new Float64Array(RECENT_REQUESTS);
    this._turnCount = 0;
    this._loaded = null;
    /** The latest deliveries (bytes a millisecond), a ring of `RECENT_REQUESTS`: `bytesPerMs` is their fastest. */
    this._rates = new Float64Array(RECENT_REQUESTS);
    this._rateCount = 0;
    this._bandwidth = null;
    /** Whether each of `_rates` kept the link full (`_rate`): `bandwidthMeasured` once one of the window did. */
    this._rateFull = new Uint8Array(RECENT_REQUESTS);
    /**
     * Requests begun at each time on a connection already set up (`begin`):
     * the others set one up first, and their time is no round trip under load.
     */
    this._warmAt = new Map();
    /**
     * The latest ends while every request slot was busy, without a break
     * (`at`, bytes), a ring of `RECENT_REQUESTS`: `loadedRequestMs` (null: stale).
     */
    this._saturatedAt = new Float64Array(RECENT_REQUESTS);
    this._saturatedBytes = new Float64Array(RECENT_REQUESTS);
    this._saturatedCount = 0;
    this._loadedRequest = null;
    /** The fastest delivery measured on this link (bytes a millisecond), whenever it was. */
    this._fastestBytesPerMs = 0;
    /** The `LINK_EVIDENCE` fastest transfer-bound deliveries, one an end, whenever they were, descending: `connectionRoundTripBytes`. */
    this._fastestBound = new Float64Array(LINK_EVIDENCE);
    /** The transfer-bound delivery of the request ending now (its own or its stretch's), 0 when none: `_noteBound`. */
    this._endBound = 0;
    /** One request's own delivery when its time was mostly transfer, a ring of `RECENT_REQUESTS`: `connectionBytesPerMs`. */
    this._requestRates = new Float64Array(RECENT_REQUESTS);
    this._requestRateCount = 0;
    /** The latest requests' round trips on a connection already made, a ring: `warmLatencyMs` is their shortest. */
    this._warmTrips = new Float64Array(RECENT_REQUESTS);
    this._warmCount = 0;
    /** Whether the request ending now added its own delivery (`_rate`): its stretch's then raises that entry. */
    this._sampled = false;
    /**
     * Requests begun at each time that found a connection at once (`begin`):
     * the rest waited in the browser's queue, and their time is no round trip.
     */
    this._onConnection = new Map();
    /** Whether the request ending now was bounded by transfer (`TRANSFER_BOUND`). */
    this._transferBound = false;
    /** The latest ends of the stretch in flight now (`at`, its bytes so far), a ring: a delivery over the latest of it. */
    this._stretchAt = new Float64Array(RECENT_REQUESTS);
    this._stretchBytes = new Float64Array(RECENT_REQUESTS);
    this._stretchCount = 0;
    /** When the link first completed a request (null until then). */
    this._firstEndAt = null;
    /**
     * Bytes the link delivered in the requests it measured: how much its
     * measurement rests on (`data/host-link-memory.js` weighs what a host
     * delivered on an earlier visit against it).
     */
    this.deliveredBytes = 0;
    /**
     * Milliseconds with at least one request in flight: `deliveredBytes`
     * over it is the rate the link sustained for the reads made of it,
     * round trips and all (what a host really delivered to them; the
     * fastest delivery, `bytesPerMs`, is the best moment of it).
     */
    this.busyMs = 0;
    this._inFlight = 0;
    /** The start of the one request in flight while no other has begun beside it, else null (`end`: `alone`). */
    this._aloneSince = null;
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
    /** Requests waiting for a slot, as the scheduler last said (`waiting`). */
    this._queued = 0;
    /**
     * Requests the host lets run at once since it said it was busy
     * (`throttled`): Infinity until it does.
     */
    this._cap = Infinity;
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
   * The host answered that it is busy: the requests let run at once are
   * halved, from what was running, and then grow back by one for every round
   * of requests the host answers (additive increase, multiplicative decrease,
   * as TCP does with a congested path), until they reach the concurrency
   * again. Nothing calls this today: a busy host is asked less at once by
   * the realm's host book instead (`hosts.js` `slowDown`, on a 429 or a 403
   * that names a limit), so `admitted` equals `concurrency`.
   */
  throttled() {
    const running = Math.min(this.admitted, Math.max(1, this._inFlight));
    this._cap = Math.max(1, Math.floor(running / 2));
  }

  /** Requests to start at once: the concurrency, under the cap a busy host set (`throttled`). */
  get admitted() {
    return Math.max(1, Math.min(this.concurrency, Math.floor(this._cap)));
  }

  /**
   * Requests waiting for a slot (`count`), as a scheduler sees them each time
   * it starts requests: while some wait, the concurrency is being measured.
   */
  waiting(count) {
    this._queued = count;
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
   * (null: failed or canceled). The burst's (connections + 1)-th completion
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
    // Begun with every connection the host is known to give busy (six an
    // address over HTTP/1.1, the file's mirrors each their own six), it
    // waits in the browser's queue first: its time is not a round trip.
    if (this.multiplexed === true || this._inFlight < this._connections) {
      this._onConnection.set(started, (this._onConnection.get(started) ?? 0) + 1);
    }
    // On a connection set up already: one request has completed on each
    // connection a request finds free (a host that multiplexes: on its one).
    const established = this.multiplexed === true ? Math.min(1, this._completedCount) : Math.min(this._connections, this._completedCount);
    if (this._inFlight < established) this._warmAt.set(started, (this._warmAt.get(started) ?? 0) + 1);
    if (this._inFlight === 0) {
      this._busySince = started;
      this._busyBytes = 0;
      this._stretchCount = 0;
    }
    // A request begun with nothing in flight is alone until another begins.
    this._aloneSince = this._inFlight === 0 ? started : null;
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
   * when it failed or was canceled: it measures nothing). `begun` is what
   * `begin()` returned for it, when its round trip is timed from later (a
   * source that first asked the page for the bytes, `range-cache.js`): the
   * request belongs to the burst it began in, whenever it reached the host.
   */
  end(started, bytes, begun = started) {
    // Every slot busy as it ended (its own included) and requests waiting
    // for one: the reads asked more than the host was taking, so the time
    // between completions is the host's, not the reads' own pauses.
    const saturated = this._inFlight >= Math.max(1, this.backgroundConcurrency) && this._queued > 0;
    // Alone on the link from its start to its end (`connectionBytesPerMs`).
    const alone = this._aloneSince === begun && this._inFlight === 1;
    this._aloneSince = null;
    this._inFlight = Math.max(0, this._inFlight - 1);
    const warmAt = this._warmAt.get(begun) ?? 0;
    if (warmAt === 1) this._warmAt.delete(begun);
    else if (warmAt > 1) this._warmAt.set(begun, warmAt - 1);
    if (bytes === null) {
      const onConnection = this._onConnection.get(begun) ?? 0;
      if (onConnection === 1) this._onConnection.delete(begun);
      else if (onConnection > 1) this._onConnection.set(begun, onConnection - 1);
    }
    const at = this._clock();
    if (this._inFlight === 0) this.busyMs += Math.max(0, at - this._busySince);
    if (bytes !== null) {
      // A host answering again earns back one request at once per round.
      if (this._cap !== Infinity) {
        this._cap += 1 / this._cap;
        if (this._cap >= this.concurrency) this._cap = Infinity;
      }
      this._completed();
      // It shared the bandwidth with the requests in flight as it ended. Of
      // the requests begun together, those that found a connection end first.
      const onConnection = this._onConnection.get(begun) ?? 0;
      if (onConnection > 0) {
        if (onConnection === 1) this._onConnection.delete(begun);
        else this._onConnection.set(begun, onConnection - 1);
      }
      this._measure(at - started, bytes, this._inFlight + 1, onConnection > 0, warmAt > 0, alone);
      this._noteSaturated(saturated, at, bytes);
      // Begun once a request had completed: on a connection already made.
      if (this._firstEndAt !== null && begun >= this._firstEndAt) {
        this._warmTrips[this._warmCount % RECENT_REQUESTS] = at - started + this._halfTick;
        this._warmCount++;
      }
      this._firstEndAt ??= at;
      this._busyBytes += bytes;
      // The stretch's first bytes arrived a round trip after it began (the
      // stretch, as each request, counted half a tick longer: `clockTickMs`);
      // past a window of ends, its delivery is that of its latest ends only,
      // so a stretch that outlasts a change of the link measures the link now.
      const latency = this.latencyMs;
      const oldest = this._stretchCount >= RECENT_REQUESTS ? this._stretchCount % RECENT_REQUESTS : -1;
      const transferring = oldest < 0 ? at - this._busySince + this._halfTick - latency : at - this._stretchAt[oldest];
      const delivered = oldest < 0 ? this._busyBytes : this._busyBytes - this._stretchBytes[oldest];
      if (transferring >= latency && transferring > 0) this._rate(delivered / transferring, this._transferBound, false);
      this._noteBound();
      this._stretchAt[this._stretchCount % RECENT_REQUESTS] = at;
      this._stretchBytes[this._stretchCount % RECENT_REQUESTS] = this._busyBytes;
      this._stretchCount++;
    }
    if (this._burst !== null && this.multiplexed === null) this._burstEnded(this._burst, begun, at, bytes);
    if (this._inFlight === 0 && this._burst?.done === false) this._burst.done = true;
  }

  /**
   * An end with every slot busy (`saturated`) or not: a break starts the
   * window of ends again (`loadedRequestMs`). @private
   */
  _noteSaturated(saturated, at, bytes) {
    if (!saturated) {
      this._saturatedCount = 0;
      return;
    }
    this._saturatedAt[this._saturatedCount % RECENT_REQUESTS] = at;
    this._saturatedBytes[this._saturatedCount % RECENT_REQUESTS] = bytes;
    this._saturatedCount++;
    this._loadedRequest = null;
  }

  /**
   * The time one more request takes the host under load (module doc): over
   * the latest ends with every slot busy, without a break, the time between
   * the first and the last less the transfer of the bytes the others
   * delivered (at the fastest delivery seen), a request; 0 until a window of `RECENT_REQUESTS` ends is seen
   * (a few saturated ends say little of the rate).
   */
  get loadedRequestMs() {
    if (this._saturatedCount < RECENT_REQUESTS) return 0;
    if (this._loadedRequest === null) {
      const last = (this._saturatedCount - 1) % RECENT_REQUESTS;
      const first = this._saturatedCount % RECENT_REQUESTS;
      let bytes = 0;
      for (let i = 0; i < RECENT_REQUESTS; i++) if (i !== first) bytes += this._saturatedBytes[i];
      // At the fastest delivery this link has shown: these small requests'
      // own delivery is their pace (taking their transfer at it would explain
      // their whole time away), and a transfer counted at the fastest is the
      // least it can be. With nothing faster seen than them, nothing is left
      // to price: a request is priced as before.
      const fastest = Math.max(this.bytesPerMs, this._fastestBytesPerMs);
      const transfer = fastest > 0 ? bytes / fastest : 0;
      this._loadedRequest = Math.max(0, this._saturatedAt[last] - this._saturatedAt[first] - transfer) / (RECENT_REQUESTS - 1);
    }
    return this._loadedRequest;
  }

  /** One completed request's round trip and delivery; `sharing`: the requests it shared the bandwidth with, itself included; `warm`: begun on a connection set up already; `alone`: nothing else was in flight from its start to its end. @private */
  _measure(measured, bytes, sharing = 1, onConnection = true, warm = true, alone = false) {
    this._completedCount++;
    this.deliveredBytes += bytes;
    // Half a tick longer than the clock says (`clockTickMs`).
    const duration = measured + this._halfTick;
    // A round trip when its bytes' transfer, at its share of the bandwidth as
    // known before it, is at most half its time (or nothing is known yet).
    const before = this.bytesPerMs;
    if (onConnection && (before <= 0 || bytes * sharing / before <= duration / 2)) {
      this._roundTrips[this._roundTripCount % RECENT_REQUESTS] = duration;
      this._roundTripCount++;
      this._latency = null;
    }
    // Its time mostly transfer (at least twice a round trip past its round
    // trip): the link, not the round trip, bounded it.
    this._transferBound = Number.isFinite(this.latencyMs) && duration >= TRANSFER_BOUND * this.latencyMs;
    if (duration > 0) this._rate(bytes / duration, this._transferBound, true, alone);
    // Its round trip under load: its time less its bytes' transfer at its
    // share of the bandwidth (a large read waits for the bytes before it,
    // which the price counts as bytes, not as round trips).
    // A request that waited for a connection first is not one (its wait is
    // the reads' own queue, which a price counts as rounds of requests).
    // Nor is one that set up its connection (its handshakes are no part of
    // what a read made on the connections then open takes).
    if (!onConnection || !warm) return;
    const transfer = this.bytesPerMs > 0 ? bytes * sharing / this.bytesPerMs : 0;
    this._turns[this._turnCount % RECENT_REQUESTS] = Math.max(this.latencyMs, duration - transfer);
    this._turnCount++;
    this._loaded = null;
  }

  /** The end just measured counted once among the fastest transfer-bound deliveries (`LINK_EVIDENCE`). @private */
  _noteBound() {
    const rate = this._endBound;
    this._endBound = 0;
    if (!(rate > this._fastestBound[LINK_EVIDENCE - 1])) return;
    let at = LINK_EVIDENCE - 1;
    while (at > 0 && this._fastestBound[at - 1] < rate) {
      this._fastestBound[at] = this._fastestBound[at - 1];
      at--;
    }
    this._fastestBound[at] = rate;
  }

  /**
   * One delivery measured, in bytes a millisecond: over one request
   * (`request`), or over the stretch in flight it ended (the request's own
   * entry raised to it, never a second entry). `bound`: the request's time
   * was mostly transfer (`TRANSFER_BOUND`), so the delivery is the link's.
   * Otherwise the round trip bounded it and its delivery is only a lower
   * bound of the bandwidth (BBR's "application-limited" sample), which may
   * raise the bandwidth but never takes part in lowering it: small requests
   * alone (a subsample's kept rows, chunk index pages) would otherwise
   * measure the link at the pace they were asked. `alone`: nothing else
   * was in flight from its start to its end, so its delivery is what one
   * connection carries, or the link (`connectionBytesPerMs`). @private
   */
  _rate(rate, bound, request, alone = false) {
    if (rate > this._fastestBytesPerMs) this._fastestBytesPerMs = rate;
    // The end's delivery: its own, or its stretch's when faster (`_noteBound`).
    if (request) this._endBound = bound ? rate : 0;
    else if (bound && rate > this._endBound) this._endBound = rate;
    if (request && bound && alone) this._requestRates[this._requestRateCount++ % RECENT_REQUESTS] = rate;
    const known = this.bytesPerMs;
    const full = known <= 0 || bound;
    if (request) this._sampled = false;
    if (!full && rate <= known) return;
    // Measured against a bandwidth known before it: the link's own delivery.
    const measuredFull = full && known > 0;
    if (!request && this._sampled) {
      const latest = (this._rateCount - 1) % RECENT_REQUESTS;
      this._rates[latest] = Math.max(this._rates[latest], rate);
      this._rateFull[latest] ||= measuredFull ? 1 : 0;
    } else {
      this._rates[this._rateCount % RECENT_REQUESTS] = rate;
      this._rateFull[this._rateCount % RECENT_REQUESTS] = measuredFull ? 1 : 0;
      this._rateCount++;
      this._sampled = request;
    }
    this._bandwidth = null;
  }

  /**
   * The round trip now: the shortest of the latest requests that were
   * mostly a round trip (`_roundTrips`); Infinity until a request completed.
   */
  get latencyMs() {
    if (this._roundTripCount === 0) return Infinity;
    this._latency ??= extremeOf(this._roundTrips, this._roundTripCount, 1);
    return this._latency;
  }

  /**
   * The shortest of the latest requests that began once the link had
   * completed one (Infinity until one does): a round trip on a connection
   * already made, which a cold one (connection set-up included) is not; what
   * a link is compared to another visit's by (`data/host-link-memory.js`).
   */
  get warmLatencyMs() {
    return this._warmCount === 0 ? Infinity : extremeOf(this._warmTrips, this._warmCount, 1);
  }

  /**
   * Whether the bandwidth now rests on a delivery that kept the link full
   * (`_rate`), not only on lower bounds: what a remembered rate gives way to
   * (`data/host-link-memory.js` `pricingLink`).
   */
  get bandwidthMeasured() {
    for (let i = 0; i < Math.min(this._rateCount, RECENT_REQUESTS); i++) if (this._rateFull[i] === 1) return true;
    return false;
  }

  /** The bandwidth now: the fastest of the latest deliveries (`_rate`); 0 until measured. */
  get bytesPerMs() {
    this._bandwidth ??= extremeOf(this._rates, this._rateCount, -1);
    return this._bandwidth;
  }

  /** A bandwidth known from elsewhere (tests, a measured link carried over): the latest requests' deliveries, all of them. */
  set bytesPerMs(rate) {
    if (!(rate >= 0)) throw new TypeError('A bandwidth is 0 or more bytes a millisecond.');
    this._rates.fill(rate);
    this._rateFull.fill(1);
    this._rateCount = RECENT_REQUESTS;
    this._bandwidth = null;
  }

  /**
   * The round trip under load: the median of the latest requests' times
   * less their transfer (`_measure`), never shorter than the shortest
   * (`latencyMs`); Infinity until a request completed.
   */
  get loadedLatencyMs() {
    if (this._turnCount === 0) return Infinity;
    if (this._loaded === null) {
      const turns = this._turns.slice(0, Math.min(this._turnCount, RECENT_REQUESTS)).sort();
      const middle = turns.length >> 1;
      this._loaded = turns.length % 2 === 1 ? turns[middle] : (turns[middle - 1] + turns[middle]) / 2;
    }
    return Math.max(this.latencyMs, this._loaded);
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
    // Made on a connection of its own, set up for it.
    this._measure(durationMs, bytes, 1, true, false);
    this.busyMs += durationMs;
  }

  /**
   * The bandwidth gaps are priced at when the byte reader decides which to
   * fetch (`planMergeGap`, coalescing to the link): the measured bandwidth,
   * or twice it while requests wait for a slot. A link measured only while
   * its slots were full of small requests (the kept rows of a subsample,
   * the row slabs of a gene index) measured its round trips, not its
   * bandwidth: what it delivered is a lower bound, and priced at that, no
   * gap would ever be fetched and the requests would stay small. Priced at
   * twice it, the gaps that would pay on a link that fast are fetched, the
   * larger requests measure the link again, and the price follows the link
   * up to its bandwidth; on a link already at its bandwidth a gap costs at
   * most twice what it is priced.
   */
  get pricingBytesPerMs() {
    const bandwidth = this._pricedBytesPerMs();
    return this._queued > 0 ? 2 * bandwidth : bandwidth;
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

  /**
   * The least time one more request costs, in milliseconds: what the host's
   * request budget makes it (`hosts.js` `requestCostMs`; 0 while it states
   * none or it does not bind) or what the host takes a request under load
   * (`loadedRequestMs`), whichever is more; 0 while neither is known.
   */
  get requestCostMs() {
    const cost = this._requestCost?.() ?? 0;
    return Math.max(cost > 0 ? cost : 0, this.loadedRequestMs);
  }

  /**
   * The time one more request of a plan costs: its share of a round trip
   * among the requests that run at once, or, once the host's request budget
   * binds, the budget's interval (Zenodo: 60 s over 133, 0.45 s) -- whichever
   * is more. `mergeGapBytes` prices a gap at this; `byte-reader.js`
   * (`planMergeGap`, the requests a waiting one takes along) computes the same
   * expression itself, once for each concurrency it plans under.
   */
  get requestMs() {
    const share = Number.isFinite(this.latencyMs) ? this.latencyMs / this.shapingConcurrency : 0;
    return Math.max(share, this.requestCostMs);
  }

  get mergeGapBytes() {
    if (!this.measured) return this._prior.mergeGapBytes;
    const measured = Math.floor(this._pricedBytesPerMs() * this.requestMs);
    // A local file's reads may end within the clock's resolution (a round
    // trip of 0): one more read never costs less than its prior says.
    return this._readsAheadPrior() ? Math.max(this._prior.mergeGapBytes, measured) : measured;
  }

  /** Whether the prior is a source read ahead whatever is measured (a local file). @private */
  _readsAheadPrior() {
    return (this._prior.bytesPerMs ?? 0) >= READ_AHEAD_BYTES_PER_MS;
  }

  /**
   * The bandwidth reads are priced at: the measured one, and for a local
   * file never less than its prior's. A local file's reads measure only a
   * lower bound of its bandwidth (`readsAhead`): reads of a few hundred
   * bytes each (a gene's counted entries) measure a disk far below its rate,
   * so a gap of a few kilobytes looks dearer than another read, every gene is
   * read alone, and nothing larger is read to measure it again (measured:
   * 22_decisions_link_model_and_request_planning.md). @private
   */
  _pricedBytesPerMs() {
    return this._readsAheadPrior() ? Math.max(this._prior.bytesPerMs, this.bytesPerMs) : this.bytesPerMs;
  }

  /**
   * The request size of the source's policy, whatever the link measures: a
   * size a choice that must not change between visits is made against
   * (`AnnDataReader._categoryCoding`: whether a category dictionary is read
   * whole).
   */
  get policyRequestBytes() {
    return this._prior.maxRequestBytes;
  }

  get maxRequestBytes() {
    if (!this.measured) return this._prior.maxRequestBytes;
    return Math.max(this._prior.maxRequestBytes, Math.floor(this._pricedBytesPerMs() * this.latencyMs));
  }

  /**
   * What one connection delivers, in bytes a millisecond: the fastest of the
   * latest requests whose time was mostly transfer and that were alone on
   * the link from start to end (a request sharing the link delivers its share
   * of it, which says nothing of a connection); 0 until one is measured. On a
   * host whose throughput is per connection (Amazon S3: each connection a
   * fraction of the link) one long request moves only this while the other
   * connections idle; on most hosts it is the link's bandwidth.
   */
  get connectionBytesPerMs() {
    let fastest = 0;
    const count = Math.min(this._requestRateCount, RECENT_REQUESTS);
    for (let i = 0; i < count; i++) if (this._requestRates[i] > fastest) fastest = this._requestRates[i];
    return fastest;
  }

  /**
   * The bytes one connection moves in a round trip (`connectionBytesPerMs`
   * x the round trip), null until both are measured, and null where one
   * connection carries about the link's whole bandwidth
   * (`CONNECTION_BOUND_SHARE`: splitting a read then only shares the link
   * among more requests; the link's carrying taken from `LINK_EVIDENCE`
   * transfer-bound deliveries, never one): a request longer than
   * this spends most of its time on one connection's transfer, so a read
   * split into pieces no shorter than it, over the free connections, ends
   * sooner and costs each piece at most one round trip of overhead
   * (`requestPieceBytes`).
   */
  get connectionRoundTripBytes() {
    const rate = this.connectionBytesPerMs;
    // A connection carrying about the whole link: nothing to spread.
    // The link's bandwidth here is the most it has delivered, shown by
    // `LINK_EVIDENCE` transfer-bound deliveries (the latest deliveries can
    // be lone requests', one connection's; a single one can be any rate).
    const link = this._fastestBound[LINK_EVIDENCE - 1];
    return this.measured && rate > 0 && rate < CONNECTION_BOUND_SHARE * link ? rate * this.latencyMs : null;
  }

  /** Bytes one round trip is worth (null until measured). */
  get roundTripBytes() {
    return this.measured ? this._pricedBytesPerMs() * this.latencyMs : null;
  }

  /**
   * A source whose prior is read ahead (a local file: a disk) stays read
   * ahead whatever one request measures: a small read's bytes over its time
   * (round trip and the reader thread's own delay included) is a lower
   * bound of the bandwidth, and can put a local `.zarr.zip` under the line. A
   * web host is read ahead once measured at or above it.
   */
  get readsAhead() {
    if (this._readsAheadPrior()) return true;
    return this.measured && this.bytesPerMs >= READ_AHEAD_BYTES_PER_MS;
  }

  /**
   * The link as measured, as plain data. Its bandwidth is the one reads are
   * priced at (`_pricedBytesPerMs`), as its round trip's bytes and merge gap
   * are: a local file's never below its prior's. Reported as measured, a
   * local file's few small opening reads (a lower bound: `readsAhead`)
   * would price its first gene past the gene time, and genes would be read
   * for a sample of a file whose every cell reads in milliseconds.
   */
  snapshot() {
    const bytesPerMs = this._pricedBytesPerMs();
    return {
      measured: this.measured,
      latencyMs: Number.isFinite(this.latencyMs) ? this.latencyMs : null,
      loadedLatencyMs: Number.isFinite(this.loadedLatencyMs) ? this.loadedLatencyMs : null,
      warmLatencyMs: Number.isFinite(this.warmLatencyMs) ? this.warmLatencyMs : null,
      bytesPerMs: bytesPerMs > 0 ? bytesPerMs : null,
      bandwidthMeasured: this.bandwidthMeasured,
      concurrency: this.concurrency,
      admitted: this.admitted,
      shapingConcurrency: this.shapingConcurrency,
      backgroundConcurrency: this.backgroundConcurrency,
      multiplexed: this.multiplexed,
      protocol: this.protocol,
      mergeGapBytes: this.mergeGapBytes,
      maxRequestBytes: this.maxRequestBytes,
      roundTripBytes: this.roundTripBytes,
      connectionBytesPerMs: this.connectionBytesPerMs > 0 ? this.connectionBytesPerMs : null,
      requestCostMs: this.requestCostMs,
      loadedRequestMs: this.loadedRequestMs,
      readsAhead: this.readsAhead,
      // A local file (its prior is a disk): priced as this machine at rest,
      // whatever a busy machine made its reads measure
      // (`data/host-link-memory.js` `pricingLink`).
      onThisMachine: this._readsAheadPrior(),
      deliveredBytes: this.deliveredBytes,
      busyMs: this.busyMs,
    };
  }
}

/**
 * The link the reader plans on (`AnnDataReader`): `meter` itself, or, while
 * the machine's link is held (`utils/machine.js` `link`: `{latencyMs,
 * bytesPerMs}`), `meter` with what it measures replaced by the held link at
 * rest -- its round trip (the shortest, on a connection already made and
 * under load alike), its rate, known as a link that kept full is, and
 * nothing a request costs past its round trip. Everything a plan derives
 * from those (`mergeGapBytes`, `roundTripBytes`, `maxRequestBytes`,
 * `readsAhead`, `snapshot`) is derived as ever, by `meter`'s own rules, and
 * what `meter` knows without timing anything stays (its prior, its
 * protocol and concurrency, the host's request budget).
 *
 * Only the reader's plans read it. The requests themselves are still
 * measured by `meter` and shaped by what it measured: how long a stalled
 * request is waited for must follow the link as it is, on a slow machine
 * above all (`ResponseClock`), and a plan must not.
 *
 * @param {LinkMeter|null} meter
 * @returns {LinkMeter|null}
 */
export function plannedLink(meter) {
  const held = measureOf('link', () => null);
  if (meter === null || meter === undefined || held === null) return meter ?? null;
  const at = value => ({ get: () => value, enumerable: true });
  return Object.create(meter, {
    latencyMs: at(held.latencyMs),
    warmLatencyMs: at(held.latencyMs),
    loadedLatencyMs: at(held.latencyMs),
    bytesPerMs: at(held.bytesPerMs),
    bandwidthMeasured: at(true),
    connectionBytesPerMs: at(0),
    loadedRequestMs: at(0),
  });
}
