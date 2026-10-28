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
 * Mirrors (`mirrors`: other URLs of the same folder, such as a public S3
 * bucket's other addresses, `io/s3.js`) spread the requests over their
 * hosts, each to the address with the fewest requests asked of it (the
 * store's own first): over HTTP/1.1 a browser keeps six connections to
 * each, so the caller's concurrency counts six to each address. A mirror is
 * judged as `httpByteSource` judges one (`io/mirrors.js`): dropped when it
 * answers as the store's own URL would not, struck when silent or
 * unreachable (dropped at the second strike in a row), kept when busy, and the request asked of the
 * store's own URL at once; a mirror's "absent" (404) counts only once it
 * has answered an object.
 *
 * A range's answer that names another range, or another size of an object
 * whose size is known, is refused (`requireAnsweredRange`).
 *
 * Requests go through `routedFetch`: a store of a notebook widget's host
 * (`EMBEDDED_HOST_ORIGIN`) is read through the page that embeds the viewer.
 *
 * The stored size of an object is unknown until it has been fetched, so
 * `storedSize` answers null for chunks not yet read (and a sharded array's
 * cost comes from its shard index instead).
 *
 * `version()` is the store's version as opened: the validators (`ETag` and
 * `Last-Modified`, each the host names) of its consolidated metadata;
 * `unchanged()` asks them again with one `HEAD`. A store read again with
 * other cells is taken over (its structure, chunk indexes and decoded
 * chunks kept) only while they are unchanged (`anndata-reader-worker.js`,
 * `sourceKey`). What that requires: every writer of a Zarr store writes its
 * consolidated metadata again when it writes the store, so its write time
 * (`Last-Modified`), or a tag the host makes from it (`cellucid serve`'s
 * `ETag`: the file's size, times and inode), moves with any rewrite. A host
 * naming only a tag made from the bytes (GitHub's raw files name no write
 * time) shows a rewrite only when the metadata's bytes change: one that
 * keeps every shape and attribute and changes only values is not seen, and
 * the store is taken over (reading a link anew would get those bytes from
 * the browser's cache of that host likewise, for as long as it allows).
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
  requireAnsweredRange,
  spreadOf,
  transientStatusError,
  withRetries,
} from '../../io/byte-source.js';
import { ResponseClock } from '../../io/link.js';
import { routedFetch } from '../../io/host-fetch.js';
import { createMirrorSet } from '../../io/mirrors.js';
import { batchedRanges, createLimiter, normalizeKey } from './common.js';
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
/** The objects that name a store's version: its consolidated metadata. */
const METADATA_KEYS = new Set(['.zmetadata', 'zarr.json']);

/**
 * A response's validators, as one string: its `ETag` (strong or weak) and
 * its `Last-Modified`, each the host names; null when it names neither.
 * Both are kept: an `ETag` many hosts make from the object's bytes alone
 * (S3, GitHub), and `Last-Modified` says when it was written.
 */
function validatorOf(response) {
  const parts = [];
  const etag = response?.headers?.get?.('ETag') ?? null;
  if (etag !== null && etag !== '') parts.push(`etag:${etag}`);
  const modified = response?.headers?.get?.('Last-Modified') ?? null;
  if (modified !== null && modified !== '') parts.push(`modified:${modified}`);
  return parts.length === 0 ? null : parts.join(' ');
}

export function httpStore(baseUrl, {
  fetch: fetchImpl = routedFetch,
  concurrency = REMOTE_POLICY.concurrency,
  mergeGapBytes = REMOTE_POLICY.mergeGapBytes,
  maxRequestBytes = REMOTE_POLICY.maxRequestBytes,
  cacheBytes = REMOTE_POLICY.cacheBytes,
  absentStatuses = [404, 410],
  name,
  onTransfer = null,
  mirrors = [],
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
  /** The store's URL, then its mirrors; requests asked of each; mirrors proven or dropped. */
  const bases = [base, ...mirrors.map(mirror => {
    let parsed;
    try {
      parsed = new URL(mirror);
    } catch {
      throw new TypeError('httpStore mirrors are absolute http(s) URLs.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new TypeError('httpStore mirrors are absolute http(s) URLs.');
    if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
    return parsed;
  })];
  /** Which address each request goes to, and which mirrors are still asked (`io/mirrors.js`). */
  const addresses = createMirrorSet(bases.length);
  /** Mirrors that have answered an object: their "absent" counts. */
  const provenMirrors = new Set();
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

  function urlOf(key, at = base) {
    const url = new URL(at.href);
    url.pathname = at.pathname + normalizeKey(key).split('/').map(encodeURIComponent).join('/');
    return url.href;
  }

  /**
   * One request, made again after a transient failure (`withRetries`). A
   * request holds its concurrency slot until its body has arrived, and never
   * while it waits to be made again. It goes to the address with the fewest
   * requests asked of it (`io/mirrors.js`).
   */
  async function request(key, options = {}) {
    const chosen = addresses.take();
    try {
      if (chosen === 0) return await requestFrom(0, key, options);
      return await requestOfMirror(chosen, key, options);
    } finally {
      addresses.release(chosen);
    }
  }

  /**
   * A request asked of a mirror, once: a stall or no connection strikes
   * it, a busy answer leaves it be, an answer the store's own URL would not
   * give drops it (`io/mirrors.js`); either way the store's own URL is asked at
   * once. A mirror's "absent" counts only once it has answered an object.
   */
  async function requestOfMirror(chosen, key, options) {
    let result;
    try {
      result = await requestFrom(chosen, key, { ...options, once: true });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const status = error?.details?.status ?? error?.status;
      if (error?.code === BYTE_SOURCE_FAILURES.RANGE_IGNORED || error?.code === BYTE_SOURCE_FAILURES.CHANGED ||
          (Number.isInteger(status) && !isTransientStatus(status))) addresses.wrong(chosen);
      else if (!Number.isInteger(status)) addresses.failed(chosen);
      return requestOwn(key, options);
    }
    if (result !== null) {
      provenMirrors.add(chosen);
      addresses.succeeded(chosen);
      return result;
    }
    if (provenMirrors.has(chosen)) return null;
    return requestOwn(key, options);
  }

  /** A request of the store's own URL, after a mirror failed it. */
  async function requestOwn(key, options) {
    const own = addresses.takeOwn();
    try {
      return await requestFrom(own, key, options);
    } finally {
      addresses.release(own);
    }
  }

  async function requestFrom(at, key, { method = 'GET', range = null, signal = null, activity = null, retryNetwork = true, once = false } = {}) {
    const url = urlOf(key, bases[at]);
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
      if (status === 206 && bounds !== null) {
        const offset = Number(bounds[1]);
        requireAnsweredRange(response, offset, expectedBytes, sizes.get(key) ?? null, urlOf(key));
      }
      stats.requests++;
      stats.bytes += bytes?.length ?? 0;
      activity?.fetched?.((bytes?.length ?? 0) - arrived, 1);
      return { response, bytes };
    }, {
      signal,
      retryable: error => !once && isTransientFailure(error) && (retryNetwork || error.code !== BYTE_SOURCE_FAILURES.NETWORK),
      onRetry: (error, attempts) => {
        // A host that says it is busy is asked less at once.
        if (error.code === BYTE_SOURCE_FAILURES.RATE_LIMITED || error.code === BYTE_SOURCE_FAILURES.UNAVAILABLE) link?.throttled?.();
        clock.onRetry?.(error, attempts);
      },
      random: spreadOf(`${url} ${range ?? ''}`),
      after: clock.after,
    });
  }

  async function get(key, { signal = null, activity = null } = {}) {
    const result = await request(key, { signal, activity });
    if (result === null) return null;
    sizes.set(key, result.bytes.length);
    if (METADATA_KEYS.has(normalizeKey(key))) validators.set(normalizeKey(key), validatorOf(result.response));
    return result.bytes;
  }

  /**
   * The validators the host gave the store's metadata objects as they were
   * read (`.zmetadata`, the root `zarr.json`): its `ETag`, else its
   * `Last-Modified`, else null.
   */
  const validators = new Map();

  /**
   * The store's version as read when it was opened, or null when its host
   * names none: the validator of its consolidated metadata (a host that
   * rewrites the store rewrites it).
   */
  function version() {
    for (const key of METADATA_KEYS) {
      if (validators.has(key)) return validators.get(key);
    }
    return null;
  }

  /**
   * Whether the store is still the version it was opened as: its metadata's
   * validator asked again (one `HEAD`). False when its host names none.
   */
  async function unchanged({ signal = null } = {}) {
    for (const key of METADATA_KEYS) {
      if (!validators.has(key)) continue;
      const opened = validators.get(key);
      if (opened === null) return false;
      const result = await request(key, { method: 'HEAD', signal });
      return result !== null && validatorOf(result.response) === opened;
    }
    return false;
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
   * reads) are planned together: neighbours merged into one request by the
   * link's gap (`batchedRanges`), cancelled only once every read waiting on
   * it has.
   */
  const batchedRange = batchedRanges({
    read: (key, start, end, options) => rangeOf(key, start, end, options),
    gap: mergeGap,
    maxBytes: requestBytes,
  });

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
    version,
    unchanged,
    /** The bytes one request costs on this link (its merge gap, as measured). */
    mergeGapBytes: mergeGap,
    stats: () => ({ ...stats }),
  });
}
