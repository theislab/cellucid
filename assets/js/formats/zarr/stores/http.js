/**
 * A store on a web host: a Zarr folder served file by file (a static site,
 * Hugging Face, an S3 or GCS bucket, a CDN).
 *
 * A web host cannot list a folder, so the store is opened from consolidated
 * metadata (Zarr v2 `.zmetadata`, or the consolidated metadata inside a Zarr
 * v3 root `zarr.json`): one request describes every node.
 *
 * Chunks are fetched with plain GET requests, many in flight at once
 * (`concurrency`: a number, or a link whose concurrency follows the protocol
 * in use, `formats/io/link.js`); requests of background work (an activity marked
 * `background`) wait while any other request waits and never take the last
 * slot, as in the byte reader. An object the host answers 404 (or 410) for is absent, so
 * it reads as the fill value. Some buckets answer 403 for a missing object
 * when they do not allow listing; pass `absentStatuses: [403, 404, 410]` for
 * those. Every request goes past the browser's HTTP cache (`cache:
 * 'no-store'`): WebKit never finished reading the bodies of chunks it served
 * from its cache to the reader worker (measured: a page reloaded with a warm
 * cache waited for them forever, every time), and nothing then mixes chunks
 * cached from an earlier version of a store with its current metadata. A
 * request the host says is busy or failing (408, 429, 5xx), whose connection
 * fails (a 503 sent without CORS headers arrives as exactly that) or that
 * stalls (`formats/io/link.js`, `ResponseClock`) is made again with growing
 * waits (`byte-source.js`, `withRetries`); a request is never left hanging.
 *
 * A sharded array reads byte ranges of its shards: the index with one
 * request (`Range: bytes=-N`, the last N bytes), then the inner chunks it
 * needs, neighbours merged into one request. Ranges asked for in one task
 * are merged as the byte reader merges them: within the link's merge gap and
 * request size as measured (`formats/io/link.js`), the source's prior until
 * then. A suffix range is not a CORS-safelisted request, so a host that
 * refuses the preflight (GitHub) is asked for the shard's size with `HEAD`
 * instead (once refused, every later shard is read that way). A host that
 * answers a range with the whole object (HTTP 200) has its answer kept,
 * within the source's cache budget, so the next ranges of that object
 * (a shard's inner chunks after its index) are cut from it instead of
 * fetching it again.
 *
 * The stored size of an object is unknown until it has been fetched, so
 * `storedSize` answers null for chunks not yet read (and a sharded array's
 * cost comes from its shard index instead).
 *
 * @module formats/zarr/stores/http
 */

import {
  ByteSourceError,
  BYTE_SOURCE_FAILURES,
  REMOTE_POLICY,
  fetchOnce,
  isTransientFailure,
  isTransientStatus,
  transientStatusError,
  withRetries,
} from '../../io/byte-source.js';
import { ResponseClock } from '../../io/link.js';
import { createLimiter, mergeRanges, nextTask, normalizeKey } from './common.js';
import { formatCountOf } from '../../../utils/format-units.js';

/**
 * @param {string} baseUrl - URL of the store folder (a query string, as on a signed URL, is kept on every request)
 * @param {{fetch?: typeof fetch, concurrency?: number|import('../../io/link.js').LinkMeter, mergeGapBytes?: number,
 *          maxRequestBytes?: number, cacheBytes?: number, absentStatuses?: number[], name?: string,
 *          onTransfer?: (progress: {url: string, bytes: number, requests: number, ms: number}) => void}} [options]
 *   `mergeGapBytes` and `maxRequestBytes` hold until a link given as
 *   `concurrency` is measured, which every request also measures;
 *   `cacheBytes` bounds the whole objects kept; `onTransfer` hears the
 *   running totals after every answered request (the Transfers log).
 */
export function httpStore(baseUrl, {
  fetch: fetchImpl = globalThis.fetch,
  concurrency = REMOTE_POLICY.concurrency,
  mergeGapBytes = REMOTE_POLICY.mergeGapBytes,
  maxRequestBytes = REMOTE_POLICY.maxRequestBytes,
  cacheBytes = REMOTE_POLICY.cacheBytes,
  absentStatuses = [404, 410],
  name,
  onTransfer = null,
} = {}) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new TypeError('httpStore needs an absolute URL.');
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new TypeError('httpStore reads http(s) URLs only.');
  if (typeof fetchImpl !== 'function') throw new TypeError('httpStore needs fetch.');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const storeName = name ?? (decodeURIComponent(base.pathname.split('/').filter(Boolean).pop() ?? '') || base.host);
  const absent = new Set(absentStatuses);
  const limit = createLimiter(concurrency);
  const link = typeof concurrency === 'number' ? null : concurrency;
  const clock = link?.responses ?? new ResponseClock();
  const mergeGap = () => (link?.measured ? link.mergeGapBytes : mergeGapBytes);
  const requestBytes = () => (link?.measured ? link.maxRequestBytes : maxRequestBytes);
  /** Objects a host sent whole for a range, by key, least recently used first. */
  const whole = new Map();
  let wholeBytes = 0;
  function keepWhole(key, bytes) {
    if (bytes.length > cacheBytes) return;
    const previous = whole.get(key);
    if (previous !== undefined) {
      whole.delete(key);
      wholeBytes -= previous.length;
    }
    whole.set(key, bytes);
    wholeBytes += bytes.length;
    while (wholeBytes > cacheBytes) {
      const [oldest, evicted] = whole.entries().next().value;
      whole.delete(oldest);
      wholeBytes -= evicted.length;
    }
  }
  function fromWhole(key) {
    const bytes = whole.get(key);
    if (bytes === undefined) return undefined;
    whole.delete(key);
    whole.set(key, bytes);
    return bytes;
  }
  /** What was read (answers with a body: `stats()`). */
  const stats = { requests: 0, bytes: 0 };
  /** Every request answered (the Transfers log). */
  const transferred = { requests: 0, bytes: 0 };
  const sizes = new Map();
  let suffixRanges = true;

  function urlOf(key) {
    const url = new URL(base.href);
    url.pathname = base.pathname + normalizeKey(key).split('/').map(encodeURIComponent).join('/');
    return url.href;
  }

  /**
   * One request, made again after a transient failure (`withRetries`). A
   * request holds its concurrency slot until its body has arrived, and never
   * while it waits to be made again.
   */
  async function request(key, { method = 'GET', range = null, signal = null, activity = null, retryNetwork = true } = {}) {
    const url = urlOf(key);
    const init = { method, cache: 'no-store' };
    if (range !== null) init.headers = { Range: range };
    // A range's length is known (a whole object's is not until it arrives).
    const bounds = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    const expectedBytes = bounds === null ? 0 : Number(bounds[2]) - Number(bounds[1]) + 1;
    return withRetries(async () => {
      // Bytes of the body are counted to the read's activity as they arrive
      // (taken back if this attempt fails), so a long request's progress
      // stays live.
      let arrived = 0;
      const { response, bytes } = await limit(async () => {
        const started = link?.begin() ?? clock.now();
        let answer;
        try {
          answer = await fetchOnce(url, init, {
            fetchImpl,
            signal,
            clock,
            wantsBody: reply => method !== 'HEAD' && (reply.status === 200 || reply.status === 206),
            expectedBytes,
            onBytes: activity?.fetched === undefined ? null : length => {
              arrived += length;
              activity.fetched(length, 0);
            },
          });
        } catch (error) {
          link?.end(started, null);
          if (arrived > 0) activity.fetched(-arrived, 0);
          throw error;
        }
        link?.end(started, method === 'HEAD' ? null : answer.bytes?.length ?? 0);
        if (method !== 'HEAD') {
          transferred.requests++;
          transferred.bytes += answer.bytes?.length ?? 0;
          onTransfer?.({ url: base.href, bytes: transferred.bytes, requests: transferred.requests, ms: clock.now() - started });
        }
        return answer;
      }, signal, activity);
      const status = response.status;
      if (isTransientStatus(status) || absent.has(status) || (status !== 200 && status !== 206)) {
        // Whatever arrived is not what was read.
        if (arrived > 0) activity.fetched(-arrived, 0);
      }
      if (isTransientStatus(status)) throw transientStatusError(response, url);
      if (absent.has(status)) return null;
      if (status !== 200 && status !== 206) {
        throw new ByteSourceError(BYTE_SOURCE_FAILURES.HTTP, `${url}: the host answered HTTP ${status}.`, { status, url });
      }
      stats.requests++;
      stats.bytes += bytes?.length ?? 0;
      activity?.fetched?.((bytes?.length ?? 0) - arrived, 1);
      return { response, bytes };
    }, {
      signal,
      retryable: error => isTransientFailure(error) && (retryNetwork || error.code !== BYTE_SOURCE_FAILURES.NETWORK),
      onRetry: (error, attempts) => clock.onRetry?.(error, attempts),
      after: clock.after,
    });
  }

  async function get(key, { signal = null, activity = null } = {}) {
    const result = await request(key, { signal, activity });
    if (result === null) return null;
    sizes.set(key, result.bytes.length);
    return result.bytes;
  }

  /** The size of `key` (from a fetch already made, or a HEAD request), or null when absent. */
  async function sizeOf(key, options) {
    if (sizes.has(key)) return sizes.get(key);
    const result = await request(key, { ...options, method: 'HEAD' });
    if (result === null) return null;
    const size = Number(result.response.headers.get('Content-Length'));
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new ByteSourceError(BYTE_SOURCE_FAILURES.HTTP, `${urlOf(key)}: the host does not say how large it is.`);
    }
    sizes.set(key, size);
    return size;
  }

  /**
   * Bytes `[start, end)` of `key`, or null when absent. Its bytes count as
   * planned for the read's activity from the moment it is asked for, so the
   * read knows how much is left before they arrive.
   */
  async function rangeOf(key, start, end, options) {
    const kept = fromWhole(key);
    if (kept !== undefined) return kept.subarray(start, Math.min(end, kept.length));
    const activity = options.activity ?? null;
    activity?.planned?.(end - start);
    let result;
    try {
      result = await request(key, { ...options, range: `bytes=${start}-${end - 1}` });
    } catch (error) {
      // Never to arrive: no longer part of what is left.
      activity?.planned?.(-(end - start));
      throw error;
    }
    if (result === null) {
      activity?.planned?.(-(end - start));
      return null;
    }
    if (result.response.status === 200) {
      // The host ignored the range and sent the whole object.
      sizes.set(key, result.bytes.length);
      keepWhole(key, result.bytes);
      return result.bytes.subarray(start, end);
    }
    if (result.bytes.length !== end - start) {
      throw new ByteSourceError(BYTE_SOURCE_FAILURES.SHORT_READ, `${urlOf(key)}: asked for ${formatCountOf(end - start, 'byte')}, received ${result.bytes.length}.`);
    }
    return result.bytes;
  }

  async function suffixOf(key, length, options) {
    const kept = fromWhole(key);
    if (kept !== undefined) return kept.subarray(Math.max(0, kept.length - length));
    if (!sizes.has(key) && suffixRanges) {
      try {
        const result = await request(key, { ...options, range: `bytes=-${length}`, retryNetwork: false });
        if (result === null) return null;
        if (result.response.status === 200) {
          sizes.set(key, result.bytes.length);
          keepWhole(key, result.bytes);
        }
        return result.response.status === 200 ? result.bytes.subarray(Math.max(0, result.bytes.length - length)) : result.bytes;
      } catch (error) {
        if (options.signal?.aborted || error?.code !== BYTE_SOURCE_FAILURES.NETWORK) throw error;
        // Most likely the host refused the CORS preflight a suffix range needs.
        suffixRanges = false;
      }
    }
    const size = await sizeOf(key, options);
    if (size === null) return null;
    return rangeOf(key, Math.max(0, size - length), size, options);
  }

  /**
   * Ranges of one object asked for in the same task (by any number of
   * reads) are planned together: neighbours merged into one request.
   */
  let batch = null;
  function batchedRange(key, offset, length, options) {
    return new Promise((resolve, reject) => {
      if (batch === null) {
        batch = new Map();
        nextTask(flush);
      }
      if (!batch.has(key)) batch.set(key, []);
      batch.get(key).push({ offset, length, options, resolve, reject });
    });
  }

  function flush() {
    const planned = batch;
    batch = null;
    for (const [key, asks] of planned) {
      for (const merged of mergeRanges(asks, mergeGap(), requestBytes())) {
        const members = merged.members.map(index => asks[index]);
        // The request is cancelled only when every read waiting on it is.
        const signals = members.map(ask => ask.options.signal).filter(Boolean);
        const signal = signals.length === members.length && signals.length > 0 && typeof AbortSignal.any === 'function'
          ? AbortSignal.any(signals)
          : null;
        const activity = members[0].options.activity ?? null;
        rangeOf(key, merged.start, merged.end, { signal, activity }).then(bytes => {
          for (const ask of members) {
            ask.resolve(bytes === null ? null : bytes.subarray(ask.offset - merged.start, ask.offset - merged.start + ask.length));
          }
        }, error => {
          for (const ask of members) ask.reject(error);
        });
      }
    }
  }

  return Object.freeze({
    name: storeName,
    url: base.href,
    get,
    getMany: (keys, options) => Promise.all(keys.map(key => get(key, options))),
    async getRanges(key, ranges, options = {}) {
      const out = new Array(ranges.length);
      const pending = [];
      ranges.forEach((range, index) => {
        pending.push((range.suffix !== undefined
          ? suffixOf(key, range.suffix, options)
          : batchedRange(key, range.offset, range.length, options)
        ).then(bytes => {
          out[index] = bytes;
        }));
      });
      await Promise.all(pending);
      return out.some(part => part === null) ? null : out;
    },
    storedSize: key => (sizes.has(key) ? sizes.get(key) : null),
    stats: () => ({ ...stats }),
  });
}
