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
 * those. A request the host says is busy (429, 503) or that drops is retried
 * with growing waits.
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

import { ByteSourceError, BYTE_SOURCE_FAILURES, REMOTE_POLICY } from '../../io/byte-source.js';
import { createLimiter, mergeRanges, nextTask, normalizeKey } from './common.js';
import { onAbort } from '../../io/abort.js';

/** Waits before repeating a request the host was too busy for (milliseconds). */
const RETRY_DELAYS_MS = Object.freeze([250, 500, 1000, 2000, 4000, 8000]);

function abortError(signal) {
  return signal?.reason ?? new DOMException('The read was aborted.', 'AbortError');
}

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      stopWaiting();
      resolve();
    }, milliseconds);
    const stopWaiting = onAbort(signal, () => {
      clearTimeout(timer);
      reject(abortError(signal));
    });
  });
}

/**
 * @param {string} baseUrl - URL of the store folder (a query string, as on a signed URL, is kept on every request)
 * @param {{fetch?: typeof fetch, concurrency?: number|import('../../io/link.js').LinkMeter, mergeGapBytes?: number,
 *          maxRequestBytes?: number, cacheBytes?: number, absentStatuses?: number[], name?: string}} [options]
 *   `mergeGapBytes` and `maxRequestBytes` hold until a link given as
 *   `concurrency` is measured; `cacheBytes` bounds the whole objects kept.
 */
export function httpStore(baseUrl, {
  fetch: fetchImpl = globalThis.fetch,
  concurrency = REMOTE_POLICY.concurrency,
  mergeGapBytes = REMOTE_POLICY.mergeGapBytes,
  maxRequestBytes = REMOTE_POLICY.maxRequestBytes,
  cacheBytes = REMOTE_POLICY.cacheBytes,
  absentStatuses = [404, 410],
  name,
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
  const stats = { requests: 0, bytes: 0 };
  const sizes = new Map();
  let suffixRanges = true;

  function urlOf(key) {
    const url = new URL(base.href);
    url.pathname = base.pathname + normalizeKey(key).split('/').map(encodeURIComponent).join('/');
    return url.href;
  }

  /**
   * One request, retried while the host is busy or the connection drops. A
   * request holds its concurrency slot until its body has arrived.
   */
  async function request(key, { method = 'GET', range = null, signal = null, activity = null, retryNetwork = true } = {}) {
    const url = urlOf(key);
    for (let attempt = 0; ; attempt++) {
      let answer;
      try {
        answer = await limit(async () => {
          const response = await fetchImpl(url, {
            method,
            headers: range === null ? undefined : { Range: range },
            signal,
          });
          const status = response.status;
          if (method === 'HEAD' || (status !== 200 && status !== 206)) {
            await response.body?.cancel().catch(() => {});
            return { response, bytes: null };
          }
          try {
            return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
          } catch (cause) {
            if (signal?.aborted) throw abortError(signal);
            throw new ByteSourceError(BYTE_SOURCE_FAILURES.NETWORK, `${storeName}: the connection dropped while reading '${key}'.`, { cause });
          }
        }, signal, activity);
      } catch (cause) {
        if (signal?.aborted) throw abortError(signal);
        if (!retryNetwork || attempt >= RETRY_DELAYS_MS.length) {
          if (cause instanceof ByteSourceError) throw cause;
          throw new ByteSourceError(
            BYTE_SOURCE_FAILURES.NETWORK,
            `${storeName}: the host did not answer for '${key}', or does not allow other sites to read it (CORS).`,
            { cause }
          );
        }
        await sleep(RETRY_DELAYS_MS[attempt], signal);
        continue;
      }
      const { response, bytes } = answer;
      const status = response.status;
      if ((status === 429 || status === 503) && attempt < RETRY_DELAYS_MS.length) {
        const retryAfter = Number(response.headers.get('Retry-After'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAYS_MS[attempt], signal);
        continue;
      }
      if (absent.has(status)) return null;
      if (status !== 200 && status !== 206) {
        throw new ByteSourceError(
          status === 429 || status === 503 ? BYTE_SOURCE_FAILURES.RATE_LIMITED : BYTE_SOURCE_FAILURES.HTTP,
          `${storeName}: the host answered HTTP ${status} for '${key}'.`,
          { status }
        );
      }
      stats.requests++;
      stats.bytes += bytes?.length ?? 0;
      activity?.fetched?.(bytes?.length ?? 0, 1);
      return { response, bytes };
    }
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
      throw new ByteSourceError(BYTE_SOURCE_FAILURES.HTTP, `${storeName}: the host does not say how large '${key}' is.`);
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
      throw new ByteSourceError(BYTE_SOURCE_FAILURES.SHORT_READ, `${storeName}: asked for ${end - start} bytes of '${key}', received ${result.bytes.length}.`);
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
