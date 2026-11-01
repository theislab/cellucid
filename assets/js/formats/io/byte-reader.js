/**
 * The byte reader: every read of a file goes through one of these.
 *
 * Format readers ask for bytes as they discover what they need: an object
 * header here, forty chunk addresses there. Served one at a time, each ask
 * would cost a round trip on a remote file. The reader turns them into as
 * few, as parallel requests as possible:
 *
 * - **Batching.** Reads asked for in the same task are gathered and planned
 *   together (the plan runs on the next macrotask, after every promise
 *   continuation of the current one has asked for what it needs).
 * - **Coalescing.** The gaps between a plan's ranges are fetched smallest
 *   first, as many as make the plan quickest as the link prices it
 *   (`planMergeGap`: its requests' round trips, `requests / concurrency`,
 *   plus its bytes' transfer); a request never grows past
 *   the link's request size, so a large read is split into pieces that run
 *   in parallel. Both follow the link as measured (`link.js`): until it is
 *   measured, the source's policy. Over a host whose protocol is not known
 *   yet (six requests at a time over HTTP/1.1, a hundred over HTTP/2), the
 *   plan nearest the best under either is taken: merging for six would
 *   fetch several times the bytes over HTTP/2, merging for a hundred would
 *   cost round trips over HTTP/1.1. Background work (an activity marked
 *   `background`: a gene index built over the kept rows of a subsample, the
 *   first gene waiting for it) is priced the same way: a gap is fetched
 *   only when it saves time, whoever waits; background work only waits
 *   behind other work for its turn (below).
 * - **Coalescing to the link.** When more requests wait than slots are free
 *   and their round trips would take longer than their bytes, a request
 *   about to start takes its waiting neighbours with it, nearest gap first,
 *   while a gap is no wider than the queue's plan would fetch
 *   (`planMergeGap` over what waits) and the queue's round trips still
 *   outweigh its bytes: many small reads scattered over a region (the rows
 *   of many cells, the value ranges of many genes) become fewer, larger
 *   requests, whichever plans asked for them. A gap is fetched only when it
 *   saves time.
 * - **Concurrency.** At most the link's concurrency (`link.js`: six to an
 *   HTTP/1.1 host; a web host's streams, 100, until its protocol is known,
 *   and as many as pay over HTTP/2 or HTTP/3) are in flight; the rest wait
 *   in order. Until a web host is known to multiplex, requests beyond six go
 *   out only while those in flight carry less than two round trips' worth of
 *   bytes: small reads fan out, large ones wait here to be merged.
 * - **Gaps kept a while.** A request that fetched bytes no read asked for
 *   (a gap merged to save a request) is kept whole in the cache's budget, so
 *   a read of them soon after (the rest of a heap collection read in part,
 *   the next wave of a read through many chunks) is answered from it; once
 *   nothing has been fetched or waited for a while (`SURPLUS_IDLE_MS`) they
 *   are let go: a share's scattered reads held 65 MB of them after its gene
 *   index was built, where every cell's contiguous reads hold none. A kept
 *   request a read still running holds (`pins`) stays past `cacheBytes`
 *   until that read ends.
 * - **Metadata cache.** Reads marked `cache: true` (headers, B-tree nodes,
 *   heaps) are served from aligned blocks kept in a least-recently-used cache
 *   of `cacheBytes`, so neighbouring metadata is fetched once. Bulk data is
 *   read exactly and never cached here. A read whose start is held already
 *   (the file's head, read beside its provider's details) fetches only the
 *   rest: a file read whole from its start (an R object) does not fetch its
 *   head twice.
 * - **Kept parts.** A remote file's parts downloaded before and kept in
 *   this browser (`kept-parts.js`, the source's `kept`) are present: a read
 *   is answered from them where they hold its bytes (a read of this
 *   machine's disk, after this reader's own memory and before any request),
 *   and only the bytes they do not hold are planned; a plan never merges
 *   two ranges across kept bytes, nor reads a metadata block around a read
 *   when the block holds kept bytes (either would fetch them again). Reads
 *   wait for the kept parts to be found and checked (`kept.ready`) before
 *   their first plan. `bytesToFetch` says what a range still costs.
 * - **Each byte in flight once.** The requests waiting or running are
 *   registered by the bytes they carry (never overlapping one another). A
 *   read whose bytes another plan's request already carries waits for that
 *   request (it holds it like any read of its own: it is cancelled only once
 *   every read waiting on it withdrew), and only the bytes no request
 *   carries are planned; a plan never fetches a gap across bytes in flight.
 *   Reads planned apart (a heap's collections loaded as the link has room,
 *   the next wave of a read through many chunks) so never fetch a byte
 *   twice while it is on its way.
 * - **Cancellation.** A read's `signal` rejects that read at once; a request
 *   is cancelled when every read waiting on it has been.
 * - **Priority.** Requests of background work (an activity marked
 *   `background`, such as an index built ahead of need) wait while any other
 *   request waits, and never hold more than the link's background
 *   concurrency (`link.js`: one fewer than a host's HTTP/1.1 connections
 *   until it is known to multiplex): a read a view waits for starts at once,
 *   and is not queued by the browser behind background requests, however
 *   much background work is queued.
 * - **Accounting.** A read's `activity` (`activity.js`) is told about the
 *   requests it caused (each request counts once, to the activity of the
 *   first read that needed it): their bytes when they are planned and when
 *   they arrive, so an operation knows how much is left; and the reads the
 *   cache answered.
 *
 * Results are views into the fetched buffers: callers read them and copy what
 * they keep, and never transfer or detach them.
 *
 * @module formats/io/byte-reader
 */

import { isByteSource } from './byte-source.js';
import { LinkMeter, performanceNow } from './link.js';
import { SharedWork, onAbort, abortReason, cancelled } from '../../utils/abort.js';
import { formatCountOf } from '../../utils/format-units.js';
import { allocateTypedArray, copyTypedArray } from '../../data/sparse-column-index.js';

/**
 * Run `callback` on a later macrotask: after the current task and all of its
 * promise continuations, so a burst of reads lands in one plan.
 */
/**
 * How long the byte reader holds the surplus of its requests (gap bytes no
 * read asked for yet) once nothing is fetched or waits: the reads that may
 * ask for them next (a wave's neighbour, a heap read after the references
 * that name it, a value read after its index) follow the requests that
 * fetched them by a decode, milliseconds; a second with nothing in flight
 * means they are done, and the bytes (up to `cacheBytes`) are let go
 * rather than held for a reading that is over. A scheduling choice, not a
 * size: what the surplus holds is still bounded by `cacheBytes`.
 */
export const SURPLUS_IDLE_MS = 1000;

const scheduleMacrotask = (() => {
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

/**
 * How long each request of a plan is at most: the link's `maxRequestBytes`,
 * lowered so that the plan's bytes run on every connection
 * (`shapingConcurrency`: a host's own connections, and each mirror's, or its
 * streams once it is known to multiplex) when one
 * connection carries only part of the link. On Amazon S3 each connection
 * delivers a fraction of what 42 together do: the edges of the full HLCA
 * (703.5 MB) took 172 s as some 2,300 requests of 64-256 KB and 252-296 s
 * as 320-600 contiguous requests of several MB, which kept about 7 of the
 * 42 connections busy. A piece is never shorter than what one connection
 * moves in a round trip (`connectionRoundTripBytes`: shorter, its round trip
 * would outweigh its transfer), than the bytes one more request costs
 * (`mergeGapBytes`, which counts the host's request rate), or than a block;
 * a link not yet measured, and a source read ahead (a disk), keep
 * `maxRequestBytes`. On a host whose one connection carries the whole link
 * the pieces are a round trip's worth of the link (the bound
 * `maxRequestBytes` already uses), so nothing is slower; only their count
 * rises, up to the connections.
 *
 * @param {Array<{start: number, end: number}>} requests
 * @param {Object} link - The `LinkMeter`
 * @param {number} blockBytes
 * @returns {number}
 */
export function requestPieceBytes(requests, link, blockBytes) {
  const max = link.maxRequestBytes;
  const perConnection = link.connectionRoundTripBytes ?? null;
  if (perConnection === null || link.readsAhead) return max;
  let total = 0;
  for (const request of requests) total += request.end - request.start;
  const floor = Math.max(blockBytes, link.mergeGapBytes, Math.ceil(perConnection));
  return Math.min(max, Math.max(floor, Math.ceil(total / Math.max(1, link.shapingConcurrency ?? link.concurrency))));
}

/**
 * The largest gap between two of a plan's spans (sorted by start) worth
 * fetching to save a request, priced by the link as measured.
 *
 * Gaps are merged smallest first; how many is what makes the plan quickest:
 * a plan of `n` requests carrying `b` bytes takes about `n / concurrency`
 * round trips (requests beyond the concurrency wait for one ahead of them)
 * plus `b` over the bandwidth, so a gap is fetched while it transfers in
 * less than the share of a round trip one request costs. Over a host known
 * to multiplex a hundred requests at once that is a few kilobytes; over
 * HTTP/1.1, six at a time, far more. Over a host whose protocol is
 * not known yet, either may hold (`link.concurrencies`): the plan taken is
 * the one whose time is nearest the best under each, its larger ratio to
 * that best the smallest. Until the link is measured, the source's prior
 * gap holds.
 *
 * @param {Array<{start: number, end: number}>} spans
 * @param {LinkMeter} link
 * @param {number} maxRequestBytes
 * @returns {number}
 */
export function planMergeGap(spans, link, maxRequestBytes) {
  if (!link.measured || spans.length < 2) return link.mergeGapBytes;
  // The gaps a plan may fetch, and the requests and bytes of the plan that
  // fetches none.
  const gaps = [];
  let requests = 0;
  let bytes = 0;
  let end = -Infinity;
  let start = 0;
  const close = () => {
    if (end > start) {
      requests += Math.ceil((end - start) / maxRequestBytes);
      bytes += end - start;
    }
  };
  for (const span of spans) {
    if (span.start > end) {
      close();
      if (end !== -Infinity) gaps.push(span.start - end);
      start = span.start;
      end = span.end;
    } else {
      end = Math.max(end, span.end);
    }
  }
  close();
  if (gaps.length === 0) return 0;
  gaps.sort((left, right) => left - right);
  const concurrencies = link.concurrencies;
  const bandwidth = link.pricingBytesPerMs ?? link.bytesPerMs;
  // A request costs its share of a round trip, or, once the host's request
  // budget binds, the budget's interval (`link.requestCostMs`): then gaps
  // worth that long at the link's rate are read through.
  const budget = link.requestCostMs ?? 0;
  const timeOf = (count, size, concurrency) => count * Math.max(link.latencyMs / concurrency, budget) + size / bandwidth;
  // Every plan's time under each concurrency: merging the k smallest gaps.
  const best = concurrencies.map(() => Infinity);
  const plans = [];
  let size = bytes;
  for (let k = 0; k <= gaps.length; k++) {
    const count = Math.max(1, requests - k);
    const times = concurrencies.map(concurrency => timeOf(count, size, concurrency));
    times.forEach((time, i) => { if (time < best[i]) best[i] = time; });
    plans.push(times);
    if (k < gaps.length) size += gaps[k];
  }
  let chosen = 0;
  let chosenRatio = Infinity;
  plans.forEach((times, k) => {
    let ratio = 0;
    times.forEach((time, i) => { ratio = Math.max(ratio, time / best[i]); });
    if (ratio < chosenRatio) {
      chosenRatio = ratio;
      chosen = k;
    }
  });
  return chosen === 0 ? 0 : gaps[chosen - 1];
}

/**
 * @typedef {Object} ByteReaderStats
 * @property {number} bytes - Bytes fetched from the source
 * @property {number} requests - Requests made to the source
 * @property {number} cacheHits - Metadata blocks served from the cache
 * @property {number} keptReads - Reads answered from the file's kept parts (`kept-parts.js`)
 * @property {number} keptBytes - Bytes those reads answered
 */

/**
 * @typedef {Object} ByteReader
 * @property {number} size
 * @property {string} name
 * @property {Readonly<Object>} identity
 * @property {import('./byte-source.js').ByteSource} source
 * @property {(offset: number, length: number, options?: {signal?: AbortSignal|null, cache?: boolean, activity?: import('./activity.js').ReadActivity|null}) => Promise<Uint8Array>} read
 * @property {() => ByteReaderStats} stats
 * @property {LinkMeter} link - The link to the file, as measured so far
 * @property {() => void} clear - Drop the metadata cache
 * @property {number} blockBytes - The aligned block metadata is read and
 *   cached in (`cache: true`): a read shorter than one costs the same round
 *   trip, and its block's neighbours come with it
 * @property {(offset: number) => number} cachedEnd - Where the cached bytes
 *   that hold `offset` end (`offset` when its block is not cached): a read
 *   within them costs nothing
 * @property {(start: number, end: number) => number} bytesToFetch - The bytes
 *   of `[start, end)` a read would fetch now: those neither kept in this
 *   browser (`kept-parts.js`) nor cached by this reader. Exact once
 *   `keptReady` has resolved (before it, kept parts are not counted)
 * @property {Promise<void>} keptReady - Resolves once the file's kept parts
 *   are found and checked (at once for a file with none)
 * @property {() => Promise<void>} close - Complete what is being kept of the
 *   file and let its holds go (the reader's store closed)
 */

/**
 * @param {import('./byte-source.js').ByteSource} source
 * @param {{policy?: Partial<import('./byte-source.js').ReadPolicy>,
 *          onTransfer?: (progress: {bytes: number, requests: number, ms: number}) => void,
 *          head?: {bytes: Uint8Array, ms: number|null}|null,
 *          clock?: () => number}} [options]
 *   `head`: the file's first bytes, read already (beside the probe of its
 *   size, `probeHttpResource`) in `ms`: they fill the cache as a read of its
 *   own would, are counted as one request, and measure the link (and how
 *   long its requests may stay silent, `ResponseClock`); `ms` null: read
 *   for an earlier opening, its bytes only (they measure nothing). `clock`:
 *   the time in milliseconds that the link is measured with
 *   (`performance.now`; tests give a virtual one).
 * @returns {ByteReader}
 */
export function createByteReader(source, { policy: overrides = null, onTransfer = null, head = null, clock = performanceNow } = {}) {
  if (!isByteSource(source)) {
    throw new TypeError('createByteReader needs a byte source.');
  }
  const policy = { ...source.policy, ...(overrides ?? {}) };
  const { blockBytes, cacheBytes } = policy;
  const size = source.size;
  // A host's request budget prices each request too, once it binds (`hosts.js` `requestCostMs`).
  const link = new LinkMeter(policy, { clock, requestCost: typeof source.requestCostMs === 'function' ? () => source.requestCostMs() : null });

  // Metadata blocks: index -> Uint8Array, in least-recently-used order.
  const blocks = new Map();
  let cachedBytes = 0;
  // Blocks being fetched: index -> {promise}.
  const pendingBlocks = new Map();

  /** Reads asked for since the last plan. */
  let asked = [];
  let planScheduled = false;

  /** Requests waiting for a free slot, and the number running. */
  let queue = [];
  let running = 0;
  let runningBytes = 0;
  let runningBackground = 0;

  /**
   * Requests waiting or running and not cancelled, by start: what they carry
   * never overlaps (a plan fetches only what none of them carries), so the
   * ones holding a range are consecutive here.
   */
  const inFlight = [];

  /** Index of the first request in flight ending after `offset`. */
  function firstInFlightAfter(offset) {
    let lo = 0;
    let hi = inFlight.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (inFlight[mid].end <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The requests in flight carrying bytes of `[start, end)`, by start. */
  function inFlightWithin(start, end) {
    const found = [];
    for (let i = firstInFlightAfter(start); i < inFlight.length && inFlight[i].start < end; i++) found.push(inFlight[i]);
    return found;
  }

  /** Whether a request in flight carries a byte of `[start, end)`. */
  function holdsInFlight(start, end) {
    if (end <= start) return false;
    const i = firstInFlightAfter(start);
    return i < inFlight.length && inFlight[i].start < end;
  }

  /** A request no longer in flight (arrived, failed or cancelled). */
  function leaveFlight(job) {
    if (!job.inFlight) return;
    job.inFlight = false;
    const i = firstInFlightAfter(job.start);
    if (inFlight[i] === job) inFlight.splice(i, 1);
  }

  /** `[start, end)` less the bytes requests in flight carry: the parts left to fetch. */
  function notInFlight(start, end) {
    const parts = [];
    let at = start;
    for (const job of inFlightWithin(start, end)) {
      if (job.start > at) parts.push([at, job.start]);
      at = Math.max(at, job.end);
    }
    if (at < end) parts.push([at, end]);
    return parts;
  }

  const stats = { bytes: 0, requests: 0, cacheHits: 0, keptReads: 0, keptBytes: 0 };

  /** The file's kept parts (`kept-parts.js`), or null: what is read from this machine's disk instead of fetched. */
  const kept = source.kept ?? null;
  /** Whether `[start, end)` holds a kept byte. */
  const holdsKept = (start, end) => kept !== null && end > start && kept.touches(start, end);

  /**
   * Requests that fetched gaps between the reads they served, kept whole in
   * least-recently-used order within `cacheBytes`: a read inside a gap
   * fetched a moment ago (the next wave of a read through many chunks) is
   * answered from it instead of fetching those bytes again. A request made
   * for a read still running (its activity: `pins`) is kept past
   * `cacheBytes` and past the idle second until that read ends: its gap
   * bytes are what its next reads ask for once the bytes before them are
   * decoded (a heap collection after the references that name it, read in
   * 17-40 MB merged requests of reference chunks: dropped from a 64 MiB
   * surplus 1.4-2.6 s before their references were decoded, 86 MB of a
   * 10M-cell file's names were fetched twice, and a 1 % share of a 1.2M
   * category column read 126.3 MB against every cell's 124.5 MB). What is
   * held so is the running reads' own requests, counted (`heldBytes`) and
   * let go as each read ends (`ReadActivity.finished`), and bounded with
   * every other reader's in the realm by the memory model's budget for
   * fetched bytes when one is set (`configureByteReaders`): past it the
   * oldest held requests go first, since a long read (a cell export, a
   * gene index's build) asks for each region once, front to back, and held
   * every request it had made until it ended (a 21,285-cell export of a
   * 10M-cell file held 210 of its 216 fetched MB to its end; HLCA core's
   * 808 MB export: 726 → 970 MB peak).
   */
  const surplus = new Map();
  let surplusBytes = 0;
  /** Whether a kept request is held for a read still running (past `cacheBytes`). */
  const pinned = entry => entry.pins.some(activity => activity.status === 'running');
  /** The timer that lets the surplus go once the reader is idle (`SURPLUS_IDLE_MS`), or null. */
  let surplusIdle = null;

  /** Nothing fetched or waiting: the surplus goes after `SURPLUS_IDLE_MS` unless a request starts first. */
  function settleSurplus() {
    if (running > 0 || queue.length > 0 || surplusBytes === 0 || surplusIdle !== null) return;
    surplusIdle = setTimeout(() => {
      surplusIdle = null;
      if (running > 0 || queue.length > 0) return;
      for (const [start, entry] of [...surplus]) {
        if (pinned(entry)) continue;
        surplus.delete(start);
        surplusBytes -= entry.bytes.length;
      }
    }, SURPLUS_IDLE_MS);
    // Node keeps a pending timer's process alive; a browser never does.
    surplusIdle.unref?.();
  }

  /** The surplus held for no running read, kept within `cacheBytes`: least recently used out first. */
  function trimSurplus() {
    let unpinned = 0;
    for (const entry of surplus.values()) if (!pinned(entry)) unpinned += entry.bytes.length;
    for (const [start, entry] of [...surplus]) {
      if (unpinned <= cacheBytes) break;
      if (pinned(entry)) continue;
      surplus.delete(start);
      surplusBytes -= entry.bytes.length;
      unpinned -= entry.bytes.length;
    }
  }

  function keepSurplus(start, bytes, activities = []) {
    const pins = activities.filter(activity => activity?.status === 'running');
    if (bytes.length > cacheBytes && pins.length === 0) return;
    const replaced = surplus.get(start);
    if (replaced !== undefined) {
      surplus.delete(start);
      surplusBytes -= replaced.bytes.length;
    }
    surplus.set(start, { bytes, pins });
    surplusBytes += bytes.length;
    if (pins.length > 0 && holdBudget !== null) trimReaderBytes(holdBudget());
    // Each read it is held for lets it go as that read ends.
    for (const activity of pins) {
      activity.finished?.then(() => {
        trimSurplus();
        settleSurplus();
      });
    }
    trimSurplus();
  }

  /** The bytes `[offset, offset + length)` when a kept request holds them all, else null. */
  function fromSurplus(offset, length) {
    for (const [start, entry] of surplus) {
      const { bytes } = entry;
      if (offset >= start && offset + length <= start + bytes.length) {
        surplus.delete(start);
        surplus.set(start, entry);
        return bytes.subarray(offset - start, offset - start + length);
      }
    }
    return null;
  }

  function touchBlock(index) {
    const block = blocks.get(index);
    if (block === undefined) return undefined;
    blocks.delete(index);
    blocks.set(index, block);
    return block;
  }

  function keepBlock(index, bytes) {
    if (blocks.has(index)) return;
    blocks.set(index, bytes);
    cachedBytes += bytes.length;
    while (cachedBytes > cacheBytes && blocks.size > 1) {
      const [oldest, evicted] = blocks.entries().next().value;
      blocks.delete(oldest);
      cachedBytes -= evicted.length;
    }
  }

  /**
   * The waiting requests worth fetching together with `job`, which is about
   * to start: none while every waiting request has a free slot, or while the
   * queue's bytes take longer than its round trips; otherwise its nearest
   * waiting neighbours, smallest gap first, while a gap transfers faster
   * than the share of a round trip one request costs and the whole stays
   * within the link's request size.
   */
  function companionsOf(job, worthOf) {
    if (!link.measured) return [];
    // Work of one kind travels together: a read someone waits for never
    // carries background bytes (it would wait for them), and background
    // work is priced over its own share of the link.
    const concurrency = job.background ? link.backgroundConcurrency : link.shapingConcurrency;
    const free = concurrency - (job.background ? runningBackground : running) - 1;
    const reach = link.maxRequestBytes;
    let waiting = 0;
    let waitingBytes = 0;
    const near = [];
    for (const other of queue) {
      if (other.cancelled || other.background !== job.background) continue;
      waiting++;
      waitingBytes += other.end - other.start;
      if (other.end >= job.start - reach && other.start <= job.end + reach) near.push(other);
    }
    const requestMs = Math.max(link.latencyMs / concurrency, link.requestCostMs ?? 0);
    const roundTripsOutweighBytes = () => waiting > free && waiting * requestMs > waitingBytes / link.pricingBytesPerMs;
    if (near.length === 0 || !roundTripsOutweighBytes()) return [];
    const worth = worthOf(job.background);
    near.sort((left, right) => left.start - right.start || left.end - right.end);
    let right = near.findIndex(other => other.start >= job.start);
    if (right < 0) right = near.length;
    let left = right - 1;
    let start = job.start;
    let end = job.end;
    const taken = [];
    while (roundTripsOutweighBytes()) {
      const rightGap = right < near.length ? near[right].start - end : Infinity;
      const leftGap = left >= 0 ? start - near[left].end : Infinity;
      const fromRight = rightGap <= leftGap;
      const gap = fromRight ? rightGap : leftGap;
      if (gap > worth) break;
      const other = fromRight ? near[right] : near[left];
      const [gapStart, gapEnd] = fromRight ? [end, other.start] : [other.end, start];
      if (holdsKept(gapStart, gapEnd) || holdsInFlight(gapStart, gapEnd)) {
        // Kept bytes, or bytes another request carries, lie between:
        // merging would fetch them again.
        if (fromRight) right = near.length;
        else left = -1;
        continue;
      }
      const nextStart = Math.min(start, other.start);
      const nextEnd = Math.max(end, other.end);
      if (nextEnd - nextStart > reach) {
        // That side is as far as one request reaches.
        if (fromRight) right = near.length;
        else left = -1;
        continue;
      }
      if (fromRight) right++;
      else left--;
      taken.push(other);
      waiting--;
      waitingBytes += Math.max(0, gap) - (other.end - other.start);
      start = nextStart;
      end = nextEnd;
    }
    return taken;
  }

  /** Fetch the bytes of `members` (queued requests) with one request. */
  function startRequest(members) {
    let start = Infinity;
    let end = -Infinity;
    for (const member of members) {
      start = Math.min(start, member.start);
      end = Math.max(end, member.end);
    }
    const background = members.every(member => member.background);
    if (surplusIdle !== null) {
      clearTimeout(surplusIdle);
      surplusIdle = null;
    }
    running++;
    runningBytes += end - start;
    if (background) runningBackground++;
    const begun = link.begin();
    let started = begun;
    // Bytes arriving are counted to the first read's activity as they come,
    // up to that read's length, so a long request's progress stays live;
    // its completion counts the rest.
    const lead = members[0];
    let arrived = 0;
    const onBytes = bytes => {
      if (lead.activity === null) return;
      const counted = Math.max(-arrived, Math.min(bytes, lead.end - lead.start - arrived));
      if (counted === 0) return;
      arrived += counted;
      lead.activity.fetched(counted, 0);
    };
    // A read answered in part from bytes held in memory (another reader's,
    // `range-cache.js`) took no round trip for them: it measures nothing.
    let held = false;
    // The request is cancelled once every read waiting on its members has
    // withdrawn (`SharedWork`), never before.
    // Bytes every read of every member reads once (a cell export's,
    // `ReadActivity.readOnce`) are not kept in the page's memory for other
    // readers (`range-cache.js`).
    const keepInMemory = !members.every(member => member.readOnceOnly === true);
    const carrier = new SharedWork(signal => source.read(start, end - start, {
      signal,
      link,
      keepInMemory,
      onBytes,
      onHeld: () => { held = true; },
      // A source that asked memory first (`range-cache.js`) times the
      // request from when it went to the host.
      onFetch: () => { started = clock(); },
      // A wait the host named (its request budget, a `Retry-After`): the
      // read's activity says so, in the host's words when it sent some.
      onWait: wait => lead.activity?.waiting(wait),
    }));
    for (const member of members) member.leaveCarrier = carrier.hold();
    carrier.promise
      .then(
        bytes => {
          for (const member of members) leaveFlight(member);
          stats.bytes += bytes.length;
          stats.requests++;
          link.end(started, held ? null : bytes.length, begun);
          onTransfer?.({ bytes: stats.bytes, requests: stats.requests, ms: clock() - started });
          // Bytes no read asked for (a gap fetched to save a request, by its
          // plan or with its companions) keep the request for the reads
          // that may ask for them next (the rest of a heap collection read
          // in part).
          let wanted = 0;
          for (const member of members) wanted += member.wanted;
          if (wanted < bytes.length) keepSurplus(start, bytes, [...new Set(members.map(member => member.activity).filter(Boolean))]);
          members.forEach((member, index) => {
            const counted = index === 0 ? arrived : 0;
            if (member.cancelled) {
              if (counted > 0) member.activity?.fetched(-counted, 0);
              return;
            }
            member.fetched = true;
            member.activity?.fetched(member.end - member.start - counted, index === 0 ? 1 : 0);
            member.resolve(bytes.subarray(member.start - start, member.end - start));
          });
        },
        error => {
          for (const member of members) leaveFlight(member);
          link.end(started, null, begun);
          if (arrived > 0) lead.activity?.fetched(-arrived, 0);
          for (const member of members) member.reject(error);
        }
      )
      .finally(() => {
        running--;
        runningBytes -= end - start;
        if (background) runningBackground--;
        pump();
        settleSurplus();
      });
  }

  /**
   * Whether another request may start: a slot is free, and either the link's
   * shaping concurrency is not reached (six to a host not known to
   * multiplex) or the requests in flight carry less than two round trips'
   * worth of bytes. On a host whose protocol is hidden, small reads (chunk
   * files, rows, B-tree nodes) go out at the host's streams, while large ones
   * stay in this queue, where they are merged and ordered, instead of in a
   * browser queue an HTTP/1.1 host would hold them in: more of them would
   * not move more bytes.
   */
  function slotFree() {
    // A host that said it is busy runs fewer at once (`link.admitted`).
    if (running >= link.admitted) return false;
    if (running < Math.min(link.shapingConcurrency, link.admitted)) return true;
    return runningBytes < 2 * (link.roundTripBytes ?? 0);
  }

  /**
   * Whether a request asked now would start at once: a slot is free and
   * nothing waits for one. What a reader gathering its own small reads
   * waits for before it asks (`whenRoom`): while requests queue, a later
   * plan of more of them joins neighbours a request at a time cannot.
   */
  function room() {
    return slotFree() && !queue.some(job => !job.cancelled);
  }

  /** Callers of `whenRoom` waiting, resolved by the first pump that leaves room. */
  let roomWaiters = [];

  /** Start queued requests while slots are free. */
  function pump() {
    // The gap worth fetching to save a request, priced over what waits now
    // as a plan is (`planMergeGap`), once a pump needs it.
    const worth = new Map();
    const worthOf = background => {
      if (!worth.has(background)) {
        const waiting = queue.filter(other => !other.cancelled && other.background === background)
          .sort((left, right) => left.start - right.start || left.end - right.end);
        worth.set(background, planMergeGap(waiting, link, link.maxRequestBytes));
      }
      return worth.get(background);
    };
    while (slotFree() && queue.length > 0) {
      let index = queue.findIndex(job => !job.background && !job.cancelled);
      if (index < 0) {
        // Only background work waits: it keeps to the link's background share.
        if (runningBackground >= link.backgroundConcurrency) {
          link.waiting(queue.length);
          return;
        }
        index = 0;
      }
      const [job] = queue.splice(index, 1);
      if (job.cancelled) continue;
      const companions = companionsOf(job, worthOf);
      if (companions.length > 0) {
        const taken = new Set(companions);
        queue = queue.filter(other => !taken.has(other));
      }
      startRequest([job, ...companions]);
    }
    link.waiting(queue.length);
    if (roomWaiters.length > 0 && room()) {
      const waiters = roomWaiters;
      roomWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  /**
   * A request for bytes `[start, end)`, queued. Returns its promise and a
   * handle that cancels it once nothing waits on it.
   */
  function enqueue(start, end) {
    const job = { start, end, wanted: end - start, leaveCarrier: null, waiters: 0, cancelled: false, fetched: false, activity: null, background: true, inFlight: true, readOnceOnly: undefined };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    job.promise.catch(() => {});
    job.release = () => {
      job.waiters--;
      if (job.waiters <= 0 && !job.cancelled) {
        // Nothing waits on these bytes any more: stop the request once
        // nothing else it fetches is waited for (or never send it), and
        // settle it, so nothing that depends on it hangs.
        job.cancelled = true;
        leaveFlight(job);
        // Planned but never to arrive: no longer part of what is left.
        if (!job.fetched) job.activity?.planned(-(job.end - job.start));
        job.leaveCarrier?.();
        job.reject(cancelled('superseded', 'No read waits for these bytes any more.'));
      }
    };
    queue.push(job);
    // Registered at once, in order: what a plan fetches never overlaps a
    // request in flight (`notInFlight`), so its place is where its start is.
    inFlight.splice(firstInFlightAfter(start), 0, job);
    return job;
  }

  /**
   * Metadata blocks read on each side of a cached read: none unless the
   * host's request budget binds; then half of what the link moves in one
   * request's budget interval, within a request's size.
   */
  function metadataReach() {
    const cost = link.requestCostMs;
    if (!(cost > 0) || !link.measured) return 0;
    const bytes = Math.min(cost * link.pricingBytesPerMs, link.maxRequestBytes) / 2;
    return Math.floor(bytes / blockBytes);
  }

  /**
   * Plan every read asked for since the last plan: serve what the cache
   * holds, merge the rest into requests, queue them.
   */
  function plan() {
    planScheduled = false;
    const reads = asked.filter(read => !read.settled);
    asked = [];
    // Spans to fetch: whole blocks for cached reads, exact ranges otherwise.
    const spans = [];
    const blockSpans = new Map();
    for (const read of reads) {
      const background = read.activity?.background === true;
      if (read.cache) {
        const first = Math.floor(read.offset / blockBytes);
        const last = Math.floor((read.offset + read.length - 1) / blockBytes);
        read.blocks = [];
        for (let index = first; index <= last; index++) {
          read.blocks.push(index);
          const pending = pendingBlocks.get(index);
          if (pending !== undefined && pending.jobs.some(job => job.cancelled)) pendingBlocks.delete(index);
          if (blockSpans.has(index) && !background) blockSpans.get(index).background = false;
          if (blocks.has(index) || pendingBlocks.has(index) || blockSpans.has(index)) continue;
          const span = {
            start: index * blockBytes,
            end: Math.min(size, (index + 1) * blockBytes),
            block: index,
            background,
          };
          blockSpans.set(index, span);
          spans.push(span);
        }
        // Over a host whose request budget binds, a request costs the
        // budget's interval (`link.requestCostMs`), which bytes at the link's
        // rate cost far less than: the metadata blocks around a read come
        // with it, as many as the link moves in that interval, and the next
        // header, heap or index node near it costs no request of its own.
        const around = metadataReach();
        for (let index = Math.max(0, first - around); index <= Math.min(Math.ceil(size / blockBytes) - 1, last + around); index++) {
          if (index >= first && index <= last) continue;
          if (blocks.has(index) || pendingBlocks.has(index) || blockSpans.has(index)) continue;
          const span = { start: index * blockBytes, end: Math.min(size, (index + 1) * blockBytes), block: index, background };
          if (holdsKept(span.start, span.end)) continue;
          blockSpans.set(index, span);
          spans.push(span);
        }
      } else {
        read.span = { start: read.offset, end: read.offset + read.length, background };
        spans.push(read.span);
      }
    }
    // What requests in flight carry already is waited for, not fetched: the
    // spans' parts no request carries are what this plan fetches.
    const toFetch = [];
    for (const span of spans) {
      for (const [start, end] of notInFlight(span.start, span.end)) toFetch.push({ start, end, background: span.background });
    }
    toFetch.sort((left, right) => left.start - right.start || left.end - right.end);

    // Merge them into requests, then split any request over the maximum.
    // The bytes between two parts are fetched when that saves time
    // (`planMergeGap`), for background work as for any other, unless kept
    // bytes or bytes in flight lie between (they would be fetched again).
    const maxRequestBytes = link.maxRequestBytes;
    const mergeGapBytes = planMergeGap(toFetch, link, maxRequestBytes);
    const requests = [];
    let current = null;
    for (const part of toFetch) {
      const gap = current === null ? 0 : mergeGapBytes;
      if (current !== null &&
          part.start - current.end <= gap &&
          Math.max(current.end, part.end) - current.start <= maxRequestBytes &&
          !holdsKept(current.end, part.start) &&
          !holdsInFlight(current.end, part.start)) {
        // The bytes asked for: what this part adds past those before it.
        current.wanted += Math.max(0, part.end - Math.max(part.start, current.end));
        current.end = Math.max(current.end, part.end);
        current.background &&= part.background;
      } else {
        current = { start: part.start, end: part.end, wanted: part.end - part.start, background: part.background };
        requests.push(current);
      }
    }
    // A plan's long requests split so that every connection works (`requestPieceBytes`).
    const pieceBytes = requestPieceBytes(requests, link, blockBytes);
    for (const request of requests) {
      for (let start = request.start; start < request.end; start += pieceBytes) {
        const job = enqueue(start, Math.min(request.end, start + pieceBytes));
        // A request split in pieces: each its share of the gap bytes.
        if (request.wanted < request.end - request.start) {
          job.wanted = Math.round((job.end - job.start) * request.wanted / (request.end - request.start));
        }
      }
    }
    // Each span learns which requests carry its bytes: this plan's, and
    // those in flight before it.
    const piecesOf = new Map();
    for (const span of spans) piecesOf.set(span, inFlightWithin(span.start, span.end));

    /** The bytes of `[start, end)`, assembled from the requests (`pieces`) carrying them. */
    const assemble = async (start, end, spanPieces) => {
      const parts = await Promise.all(spanPieces.map(piece => piece.promise));
      if (spanPieces.length === 1) {
        const piece = spanPieces[0];
        return parts[0].subarray(start - piece.start, end - piece.start);
      }
      const bytes = allocateTypedArray(Uint8Array, end - start, 'Read bytes');
      spanPieces.forEach((piece, index) => {
        const from = Math.max(start, piece.start);
        const to = Math.min(end, piece.end);
        bytes.set(parts[index].subarray(from - piece.start, to - piece.start), from - start);
      });
      return bytes;
    };

    // Blocks: fill the cache when their bytes arrive. A block keeps its own
    // copy when the request it came in is much larger than the block, so a
    // cached block never holds a large buffer alive.
    for (const span of blockSpans.values()) {
      const spanPieces = piecesOf.get(span);
      const promise = assemble(span.start, span.end, spanPieces).then(bytes => {
        const owner = spanPieces.length === 1 ? spanPieces[0] : null;
        const kept = owner !== null && owner.end - owner.start > 2 * blockBytes ? bytes.slice() : bytes;
        keepBlock(span.block, kept);
        return kept;
      });
      promise.catch(() => {});
      const entry = { promise, jobs: spanPieces };
      pendingBlocks.set(span.block, entry);
      promise.finally(() => {
        if (pendingBlocks.get(span.block) === entry) pendingBlocks.delete(span.block);
      }).catch(() => {});
    }

    // Reads: wait for their blocks or pieces, then resolve.
    for (const read of reads) {
      let jobs;
      let result;
      if (read.cache) {
        const parts = read.blocks.map(index => {
          const block = touchBlock(index);
          if (block !== undefined) {
            stats.cacheHits++;
            read.activity?.cacheHit();
            return { jobs: [], promise: Promise.resolve(block) };
          }
          return pendingBlocks.get(index);
        });
        jobs = parts.flatMap(part => part.jobs);
        result = Promise.all(parts.map(part => part.promise)).then(found => {
          const start = read.offset;
          const end = read.offset + read.length;
          if (found.length === 1) {
            const base = read.blocks[0] * blockBytes;
            return found[0].subarray(start - base, end - base);
          }
          const bytes = allocateTypedArray(Uint8Array, read.length, 'Read bytes');
          found.forEach((block, index) => {
            const base = read.blocks[index] * blockBytes;
            const from = Math.max(start, base);
            const to = Math.min(end, base + block.length);
            bytes.set(block.subarray(from - base, to - base), from - start);
          });
          return bytes;
        });
      } else {
        jobs = piecesOf.get(read.span);
        result = assemble(read.offset, read.offset + read.length, jobs);
      }
      for (const job of jobs) {
        job.waiters++;
        if (read.activity?.background !== true) job.background = false;
        // Kept in the page's memory unless every read of it reads it once.
        job.readOnceOnly = (job.readOnceOnly ?? true) && read.activity?.readOnce === true;
        if (job.activity === null && read.activity) {
          job.activity = read.activity;
          job.activity.planned(job.end - job.start);
        }
      }
      read.jobs = jobs;
      result.then(
        bytes => read.settle(null, bytes),
        error => read.settle(error, null)
      );
    }
    pump();
  }

  /** The bytes `[offset, offset + length)` when every block holding them is cached, else null. */
  function fromCache(offset, length) {
    const first = Math.floor(offset / blockBytes);
    const last = Math.floor((offset + length - 1) / blockBytes);
    for (let index = first; index <= last; index++) {
      if (!blocks.has(index)) return null;
    }
    if (first === last) {
      const block = touchBlock(first);
      const base = first * blockBytes;
      return block.subarray(offset - base, offset - base + length);
    }
    const bytes = allocateTypedArray(Uint8Array, length, 'Read bytes');
    for (let index = first; index <= last; index++) {
      const block = touchBlock(index);
      const base = index * blockBytes;
      const from = Math.max(offset, base);
      const to = Math.min(offset + length, base + block.length);
      bytes.set(block.subarray(from - base, to - base), from - offset);
    }
    return bytes;
  }

  // The head read already: its whole blocks, and the last block of a file
  // it holds to the end.
  if (head !== null) {
    if (!(head.bytes instanceof Uint8Array) || head.bytes.length > size || !(head.ms === null || head.ms >= 0)) {
      throw new TypeError('A byte reader head is the bytes at the start of its file and the time they took (null: not this link\'s).');
    }
    const length = head.bytes.length;
    for (let index = 0; (index + 1) * blockBytes <= length || (index * blockBytes < length && length === size); index++) {
      keepBlock(index, head.bytes.subarray(index * blockBytes, Math.min(length, (index + 1) * blockBytes)));
    }
    // A head read for an earlier opening (`ms` null) is bytes only: its
    // timing measures nothing of this link, nor counts as its request.
    if (head.ms !== null) {
      stats.bytes += length;
      stats.requests++;
      link.recordRequest(head.ms, length);
      // How long the host took to answer: the first reads are not taken for
      // stalled sooner (a host that answers in more than the initial second,
      // as S3's colder storage does, would have each first read asked twice).
      link.responses.answered(head.ms);
      onTransfer?.({ bytes: stats.bytes, requests: stats.requests, ms: head.ms });
    }
  }

  /**
   * `[offset, offset + length)`, some of whose bytes are kept: the kept
   * pieces read from this machine's disk, the others fetched (exactly: a
   * metadata block around them could hold kept bytes), joined. A kept
   * piece found damaged (`kept-parts.js` forgets its batch) is fetched.
   */
  async function readWithKept(offset, length, { signal, activity }) {
    const end = offset + length;
    const pieces = [];
    let at = offset;
    for (const [from, to] of kept.missing(offset, end)) {
      if (from > at) pieces.push({ from: at, to: from, held: true });
      pieces.push({ from, to, held: false });
      at = to;
    }
    if (at < end) pieces.push({ from: at, to: end, held: true });
    const fetchPiece = piece => read(piece.from, piece.to - piece.from, { signal, activity, host: true });
    const parts = await Promise.all(pieces.map(piece => (piece.held
      ? kept.read(piece.from, piece.to - piece.from).then(bytes => {
        stats.keptReads++;
        stats.keptBytes += bytes.length;
        activity?.cacheHit();
        return bytes;
      }, () => fetchPiece(piece))
      : fetchPiece(piece))));
    if (signal?.aborted) throw abortReason(signal);
    if (parts.length === 1) return parts[0];
    const bytes = allocateTypedArray(Uint8Array, length, 'Read bytes');
    pieces.forEach((piece, index) => bytes.set(parts[index], piece.from - offset));
    return bytes;
  }

  function read(offset, length, { signal = null, cache = false, activity = null, host = false } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(length) || length < 0 || offset + length > size) {
      return Promise.reject(new RangeError(
        `${source.name}: cannot read ${formatCountOf(length, 'byte')} at ${offset} of a ${size}-byte file.`
      ));
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (length === 0) return Promise.resolve(new Uint8Array(0));
    // A read whose bytes all sit in cached blocks is answered at once --
    // metadata, and data that came in with the metadata around it.
    const cached = fromCache(offset, length) ?? fromSurplus(offset, length);
    if (cached !== null) {
      stats.cacheHits++;
      activity?.cacheHit();
      return Promise.resolve(cached);
    }
    if (kept !== null && !host) {
      // Nothing is planned before the kept parts are known.
      if (!kept.loaded) return kept.ready.then(() => read(offset, length, { signal, cache, activity }));
      if (holdsKept(offset, offset + length)) return readWithKept(offset, length, { signal, activity });
      // A metadata block around the read that holds kept bytes would fetch them again: read exactly.
      if (cache && holdsKept(Math.floor(offset / blockBytes) * blockBytes, Math.min(size, Math.ceil((offset + length) / blockBytes) * blockBytes))) {
        return read(offset, length, { signal, cache: false, activity, host: true });
      }
    }
    // Its start is held already: only the rest is fetched, from a block's
    // start, and the two are joined.
    const held = cachedEnd(offset) - offset;
    if (held > 0) {
      const start = copyTypedArray(Uint8Array, fromCache(offset, held), 'Read bytes');
      stats.cacheHits++;
      activity?.cacheHit();
      return read(offset + held, length - held, { signal, cache, activity, host }).then(rest => {
        const bytes = allocateTypedArray(Uint8Array, length, 'Read bytes');
        bytes.set(start, 0);
        bytes.set(rest, held);
        return bytes;
      });
    }
    // A read asked with a stopped signal plans nothing.
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      const entry = {
        offset,
        length,
        cache,
        activity,
        settled: false,
        jobs: [],
        settle(error, bytes) {
          if (entry.settled) return;
          entry.settled = true;
          stopWaiting();
          if (error) reject(error);
          else resolve(bytes);
        },
      };
      const stopWaiting = onAbort(signal, () => {
        if (entry.settled) return;
        entry.settle(abortReason(signal), null);
        for (const job of entry.jobs) job.release();
      });
      asked.push(entry);
      if (!planScheduled) {
        planScheduled = true;
        scheduleMacrotask(plan);
      }
    });
  }

  function cachedEnd(offset) {
    let index = Math.floor(offset / blockBytes);
    while (blocks.has(index)) index++;
    return Math.max(offset, Math.min(size, index * blockBytes));
  }

  /** The bytes of `[start, end)` neither kept nor in this reader's cached blocks. */
  function bytesToFetch(start, end) {
    let bytes = 0;
    for (const [from, to] of kept === null ? [[start, end]] : kept.missing(start, end)) {
      for (let at = from; at < to;) {
        const index = Math.floor(at / blockBytes);
        const blockEnd = Math.min(to, (index + 1) * blockBytes);
        if (!blocks.has(index)) bytes += blockEnd - at;
        at = blockEnd;
      }
    }
    return bytes;
  }

  const api = Object.freeze({
    size,
    name: source.name,
    identity: source.identity,
    source,
    link,
    read,
    blockBytes,
    cachedEnd,
    bytesToFetch,
    keptReady: kept?.ready ?? Promise.resolve(),
    close: () => kept?.close() ?? Promise.resolve(),
    stats: () => ({ ...stats }),
    room,
    /** Resolves once a request asked would start at once (`room`): now, or when a request ends and none waits. */
    whenRoom: () => (room() ? Promise.resolve() : new Promise(resolve => roomWaiters.push(resolve))),
    clear() {
      blocks.clear();
      cachedBytes = 0;
      surplus.clear();
      surplusBytes = 0;
    },
    /** The bytes this reader holds: its metadata blocks and its requests' surplus (with what running reads hold). */
    heldBytes: () => cachedBytes + surplusBytes,
    /** Let go of the surplus no running read holds (the memory model's trim). */
    trimSurplus() {
      for (const [start, entry] of [...surplus]) {
        if (pinned(entry)) continue;
        surplus.delete(start);
        surplusBytes -= entry.bytes.length;
      }
    },
    /** Let go of requests running reads hold, least recently used first, until `excess` bytes went; returns the bytes let go. */
    releaseHeld(excess) {
      let released = 0;
      for (const [start, entry] of [...surplus]) {
        if (released >= excess) break;
        surplus.delete(start);
        surplusBytes -= entry.bytes.length;
        released += entry.bytes.length;
      }
      return released;
    },
  });
  LIVE_READERS.add(new WeakRef(api));
  return api;
}

/** Every byte reader of this realm, held weakly: what they hold is counted (`heldReaderBytes`). */
const LIVE_READERS = new Set();

/** What the byte readers of this realm may hold in all, in bytes, when the memory model says (`configureByteReaders`); null: each its own `cacheBytes` and what running reads hold. */
let holdBudget = null;

/**
 * Bound what every byte reader of this realm holds, the requests running
 * reads hold included, by `holdBytes()` (the reader worker: the memory
 * model's budget for fetched bytes, `residencyBudgetBytes('fetchedRanges')`),
 * asked whenever a running read's request is kept. Null takes the bound away.
 *
 * @param {{holdBytes?: (() => number)|null}} options
 */
export function configureByteReaders({ holdBytes = null } = {}) {
  if (holdBytes !== null && typeof holdBytes !== 'function') throw new TypeError('holdBytes is a function or null.');
  holdBudget = holdBytes;
}

/**
 * The bytes every byte reader of this realm holds (`heldBytes`: metadata
 * blocks, kept requests, and the requests running reads still hold), for
 * the memory model (the reader worker counts it under `fetchedRanges`).
 *
 * @returns {number}
 */
export function heldReaderBytes() {
  let bytes = 0;
  for (const ref of LIVE_READERS) {
    const reader = ref.deref();
    if (reader === undefined) LIVE_READERS.delete(ref);
    else bytes += reader.heldBytes();
  }
  return bytes;
}

/**
 * Bring what the byte readers hold within `budget`: each lets go of the
 * surplus no running read holds first, then of what running reads hold,
 * least recently used first (a read asking for those bytes again fetches
 * them again: memory stays within the model's budget whatever a read's
 * length). Returns what was let go (null when nothing needed to).
 *
 * @param {number} budget
 * @returns {string|null}
 */
export function trimReaderBytes(budget) {
  let held = heldReaderBytes();
  if (held <= budget) return null;
  for (const ref of LIVE_READERS) ref.deref()?.trimSurplus();
  held = heldReaderBytes();
  for (const ref of LIVE_READERS) {
    if (held <= budget) break;
    held -= ref.deref()?.releaseHeld(held - budget) ?? 0;
  }
  return 'requests kept by the byte readers';
}
