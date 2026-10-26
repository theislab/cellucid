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
 *   cost round trips over HTTP/1.1. Ranges of background work (an activity
 *   marked `background`) are joined only where they touch: a gap is fetched
 *   to save a read someone waits for a round trip, never for work done
 *   ahead of need.
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
 * - **Metadata cache.** Reads marked `cache: true` (headers, B-tree nodes,
 *   heaps) are served from aligned blocks kept in a least-recently-used cache
 *   of `cacheBytes`, so neighbouring metadata is fetched once. Bulk data is
 *   read exactly and never cached here. A read whose start is held already
 *   (the file's head, read beside its provider's details) fetches only the
 *   rest: a file read whole from its start (an R object) does not fetch its
 *   head twice.
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
import { LinkMeter } from './link.js';
import { onAbort } from './abort.js';
import { formatCountOf } from '../../utils/format-units.js';

/**
 * Run `callback` on a later macrotask: after the current task and all of its
 * promise continuations, so a burst of reads lands in one plan.
 */
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

function abortError(signal) {
  return signal?.reason ?? new DOMException('The read was aborted.', 'AbortError');
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
 * @param {Array<{start: number, end: number, background: boolean}>} spans
 * @param {LinkMeter} link
 * @param {number} maxRequestBytes
 * @returns {number}
 */
export function planMergeGap(spans, link, maxRequestBytes) {
  if (!link.measured || spans.length < 2) return link.mergeGapBytes;
  // The gaps a plan may fetch (between spans someone waits for), and the
  // requests and bytes of the plan that fetches none.
  const gaps = [];
  let requests = 0;
  let bytes = 0;
  let end = -Infinity;
  let start = 0;
  let background = true;
  const close = () => {
    if (end > start) {
      requests += Math.ceil((end - start) / maxRequestBytes);
      bytes += end - start;
    }
  };
  for (const span of spans) {
    if (span.start > end) {
      close();
      if (end !== -Infinity && !(background && span.background)) gaps.push(span.start - end);
      start = span.start;
      end = span.end;
      background = span.background;
    } else {
      end = Math.max(end, span.end);
      background &&= span.background;
    }
  }
  close();
  if (gaps.length === 0) return 0;
  gaps.sort((left, right) => left - right);
  const concurrencies = link.concurrencies;
  const timeOf = (count, size, concurrency) => (count / concurrency) * link.latencyMs + size / link.bytesPerMs;
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
 * @property {(offset: number) => number} cachedEnd - Where the cached bytes
 *   that hold `offset` end (`offset` when its block is not cached): a read
 *   within them costs nothing
 */

/**
 * @param {import('./byte-source.js').ByteSource} source
 * @param {{policy?: Partial<import('./byte-source.js').ReadPolicy>,
 *          onTransfer?: (progress: {bytes: number, requests: number, ms: number}) => void,
 *          head?: {bytes: Uint8Array, ms: number}|null,
 *          clock?: () => number}} [options]
 *   `head`: the file's first bytes, read already (beside the probe of its
 *   size, `probeHttpResource`) in `ms`: they fill the cache as a read of its
 *   own would, are counted as one request, and measure the link. `clock`:
 *   the time in milliseconds that the link is measured with
 *   (`performance.now`; tests give a virtual one).
 * @returns {ByteReader}
 */
export function createByteReader(source, { policy: overrides = null, onTransfer = null, head = null, clock = () => performance.now() } = {}) {
  if (!isByteSource(source)) {
    throw new TypeError('createByteReader needs a byte source.');
  }
  const policy = { ...source.policy, ...(overrides ?? {}) };
  const { blockBytes, cacheBytes } = policy;
  const size = source.size;
  const link = new LinkMeter(policy, { clock });

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

  const stats = { bytes: 0, requests: 0, cacheHits: 0 };

  /**
   * Requests that fetched gaps between the reads they served, kept whole in
   * least-recently-used order within `cacheBytes`: a read inside a gap
   * fetched a moment ago (the next wave of a read through many chunks) is
   * answered from it instead of fetching those bytes again.
   */
  const surplus = new Map();
  let surplusBytes = 0;

  function keepSurplus(start, bytes) {
    if (bytes.length > cacheBytes) return;
    const replaced = surplus.get(start);
    if (replaced !== undefined) {
      surplus.delete(start);
      surplusBytes -= replaced.length;
    }
    surplus.set(start, bytes);
    surplusBytes += bytes.length;
    while (surplusBytes > cacheBytes) {
      const [oldest, evicted] = surplus.entries().next().value;
      surplus.delete(oldest);
      surplusBytes -= evicted.length;
    }
  }

  /** The bytes `[offset, offset + length)` when a kept request holds them all, else null. */
  function fromSurplus(offset, length) {
    for (const [start, bytes] of surplus) {
      if (offset >= start && offset + length <= start + bytes.length) {
        surplus.delete(start);
        surplus.set(start, bytes);
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
    if (!link.measured || job.background) return [];
    const concurrency = link.shapingConcurrency;
    const free = concurrency - running - 1;
    const reach = link.maxRequestBytes;
    let waiting = 0;
    let waitingBytes = 0;
    const near = [];
    for (const other of queue) {
      if (other.cancelled) continue;
      // Background work waits its turn; its bytes are never fetched as a gap.
      if (other.background) continue;
      waiting++;
      waitingBytes += other.end - other.start;
      if (other.end >= job.start - reach && other.start <= job.end + reach) near.push(other);
    }
    const requestMs = link.latencyMs / concurrency;
    const roundTripsOutweighBytes = () => waiting > free && waiting * requestMs > waitingBytes / link.bytesPerMs;
    if (near.length === 0 || !roundTripsOutweighBytes()) return [];
    const worth = worthOf();
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
    const carrier = { controller: new AbortController(), live: members.length };
    for (const member of members) member.carrier = carrier;
    running++;
    runningBytes += end - start;
    if (background) runningBackground++;
    const started = link.begin();
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
    source.read(start, end - start, { signal: carrier.controller.signal, link, onBytes })
      .then(
        bytes => {
          stats.bytes += bytes.length;
          stats.requests++;
          link.end(started, bytes.length);
          onTransfer?.({ bytes: stats.bytes, requests: stats.requests, ms: clock() - started });
          let wanted = 0;
          for (const member of members) wanted += member.end - member.start;
          if (wanted < bytes.length) keepSurplus(start, bytes);
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
          link.end(started, null);
          if (arrived > 0) lead.activity?.fetched(-arrived, 0);
          for (const member of members) member.reject(error);
        }
      )
      .finally(() => {
        running--;
        runningBytes -= end - start;
        if (background) runningBackground--;
        pump();
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
    if (running >= link.concurrency) return false;
    if (running < link.shapingConcurrency) return true;
    return runningBytes < 2 * (link.roundTripBytes ?? 0);
  }

  /** Start queued requests while slots are free. */
  function pump() {
    // The gap worth fetching to save a request, priced over what waits now
    // as a plan is (`planMergeGap`), once a pump needs it.
    let worth = null;
    const worthOf = () => {
      if (worth === null) {
        const waiting = queue.filter(other => !other.cancelled && !other.background)
          .sort((left, right) => left.start - right.start || left.end - right.end);
        worth = planMergeGap(waiting, link, link.maxRequestBytes);
      }
      return worth;
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
  }

  /**
   * A request for bytes `[start, end)`, queued. Returns its promise and a
   * handle that cancels it once nothing waits on it.
   */
  function enqueue(start, end) {
    const job = { start, end, carrier: null, waiters: 0, cancelled: false, fetched: false, activity: null, background: true };
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
        // Planned but never to arrive: no longer part of what is left.
        if (!job.fetched) job.activity?.planned(-(job.end - job.start));
        if (job.carrier !== null && --job.carrier.live === 0) job.carrier.controller.abort();
        job.reject(new DOMException('The read was aborted.', 'AbortError'));
      }
    };
    queue.push(job);
    return job;
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
      } else {
        read.span = { start: read.offset, end: read.offset + read.length, background };
        spans.push(read.span);
      }
    }
    spans.sort((left, right) => left.start - right.start || left.end - right.end);

    // Merge spans into requests, then split any request over the maximum.
    // The bytes between two spans are fetched to save a request for a read
    // someone waits for; work nobody waits for yet (background) only joins
    // spans that touch, and never pays for a gap.
    const maxRequestBytes = link.maxRequestBytes;
    const mergeGapBytes = planMergeGap(spans, link, maxRequestBytes);
    const requests = [];
    let current = null;
    for (const span of spans) {
      const gap = current === null || (current.background && span.background) ? 0 : mergeGapBytes;
      if (current !== null &&
          span.start - current.end <= gap &&
          Math.max(current.end, span.end) - current.start <= maxRequestBytes) {
        current.end = Math.max(current.end, span.end);
        current.spans.push(span);
        current.background &&= span.background;
      } else {
        current = { start: span.start, end: span.end, spans: [span], background: span.background };
        requests.push(current);
      }
    }
    // Each span learns which pieces hold its bytes.
    const piecesOf = new Map();
    const jobOf = new Map();
    for (const request of requests) {
      const own = [];
      for (let start = request.start; start < request.end; start += maxRequestBytes) {
        const piece = { start, end: Math.min(request.end, start + maxRequestBytes) };
        own.push(piece);
        jobOf.set(piece, enqueue(piece.start, piece.end));
      }
      for (const span of request.spans) {
        const first = Math.floor((span.start - request.start) / maxRequestBytes);
        const last = Math.floor((span.end - 1 - request.start) / maxRequestBytes);
        piecesOf.set(span, own.slice(first, last + 1));
      }
    }

    /** The bytes of `[start, end)`, assembled from the pieces covering it. */
    const assemble = async (start, end, spanPieces) => {
      const parts = await Promise.all(spanPieces.map(piece => jobOf.get(piece).promise));
      if (spanPieces.length === 1) {
        const piece = spanPieces[0];
        return parts[0].subarray(start - piece.start, end - piece.start);
      }
      const bytes = new Uint8Array(end - start);
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
      const entry = { promise, jobs: spanPieces.map(piece => jobOf.get(piece)) };
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
          const bytes = new Uint8Array(read.length);
          found.forEach((block, index) => {
            const base = read.blocks[index] * blockBytes;
            const from = Math.max(start, base);
            const to = Math.min(end, base + block.length);
            bytes.set(block.subarray(from - base, to - base), from - start);
          });
          return bytes;
        });
      } else {
        const spanPieces = piecesOf.get(read.span);
        jobs = spanPieces.map(piece => jobOf.get(piece));
        result = assemble(read.offset, read.offset + read.length, spanPieces);
      }
      for (const job of jobs) {
        job.waiters++;
        if (read.activity?.background !== true) job.background = false;
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
    const bytes = new Uint8Array(length);
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
    if (!(head.bytes instanceof Uint8Array) || head.bytes.length > size || !(head.ms >= 0)) {
      throw new TypeError('A byte reader head is the bytes at the start of its file and the time they took.');
    }
    const length = head.bytes.length;
    for (let index = 0; (index + 1) * blockBytes <= length || (index * blockBytes < length && length === size); index++) {
      keepBlock(index, head.bytes.subarray(index * blockBytes, Math.min(length, (index + 1) * blockBytes)));
    }
    stats.bytes += length;
    stats.requests++;
    link.recordRequest(head.ms, length);
    onTransfer?.({ bytes: stats.bytes, requests: stats.requests, ms: head.ms });
  }

  function read(offset, length, { signal = null, cache = false, activity = null } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(length) || length < 0 || offset + length > size) {
      return Promise.reject(new RangeError(
        `${source.name}: cannot read ${formatCountOf(length, 'byte')} at ${offset} of a ${size}-byte file.`
      ));
    }
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (length === 0) return Promise.resolve(new Uint8Array(0));
    // A read whose bytes all sit in cached blocks is answered at once --
    // metadata, and data that came in with the metadata around it.
    const cached = fromCache(offset, length) ?? fromSurplus(offset, length);
    if (cached !== null) {
      stats.cacheHits++;
      activity?.cacheHit();
      return Promise.resolve(cached);
    }
    // Its start is held already: only the rest is fetched, from a block's
    // start, and the two are joined.
    const held = cachedEnd(offset) - offset;
    if (held > 0) {
      const start = fromCache(offset, held).slice();
      stats.cacheHits++;
      activity?.cacheHit();
      return read(offset + held, length - held, { signal, cache, activity }).then(rest => {
        const bytes = new Uint8Array(length);
        bytes.set(start, 0);
        bytes.set(rest, held);
        return bytes;
      });
    }
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
        entry.settle(abortError(signal), null);
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

  return Object.freeze({
    size,
    name: source.name,
    identity: source.identity,
    source,
    link,
    read,
    cachedEnd,
    stats: () => ({ ...stats }),
    clear() {
      blocks.clear();
      cachedBytes = 0;
      surplus.clear();
      surplusBytes = 0;
    },
  });
}
