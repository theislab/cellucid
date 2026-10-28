/**
 * Byte sources: where the bytes of one file come from.
 *
 * A source answers `read(offset, length, {signal})` with exactly `length`
 * bytes, asynchronously, and may be asked for many ranges at once: every
 * source here serves concurrent reads. A source does no caching, batching or
 * scheduling; `createByteReader` (byte-reader.js) does that for all of them,
 * guided by the source's `policy` (how reads to it should be shaped).
 *
 * - `blobByteSource`: a local `File` or `Blob` (file picker, drop). Reads are
 *   `blob.slice(...).arrayBuffer()`: nothing is copied into memory up front.
 * - `httpByteSource`: a file on a web host, read with HTTP `Range` requests
 *   (through `routedFetch`, so a notebook widget's host, `host-fetch.js`, is
 *   read the same way).
 * - `bytesByteSource`: bytes already in memory (tests, small archives).
 *
 * @module formats/io/byte-source
 */

import { onAbort } from './abort.js';
import { isHostUrl, routedFetch } from './host-fetch.js';
import { ResponseClock, afterRealTime, rememberAnswer } from './link.js';
import { formatDuration, formatCountOf } from '../../utils/format-units.js';
import { createMirrorSet } from './mirrors.js';
import { KeptCopyDamage, checkedRead } from './page-checks.js';

/**
 * How reads to a source should be shaped. None of these limits what can be
 * read; they only decide how reads are grouped into requests. The block size,
 * concurrency and cache budget hold for as long as the file is read; the
 * merge gap and request size are the source's prior, used until the link to
 * the file is measured (`link.js`), after which they follow the link.
 *
 * @typedef {Object} ReadPolicy
 * @property {number} blockBytes - Metadata is read and cached in aligned blocks of this size
 * @property {number} mergeGapBytes - Two ranges this close are fetched as one request (until measured)
 * @property {number} maxRequestBytes - A request is never longer than this, so large reads run in parallel (until measured)
 * @property {number} concurrency - Requests in flight at once: a web host's HTTP/1.1 connections
 * @property {number} [streams] - A web host's requests in flight before its protocol is known (`link.js`)
 * @property {number} cacheBytes - Budget of the metadata block cache
 * @property {number} bytesPerMs - The bandwidth assumed until it is measured (0: none assumed)
 */

/**
 * @typedef {Object} ByteSource
 * @property {number} size - Exact size of the file in bytes
 * @property {string} name - File name, for messages
 * @property {Readonly<Object>} identity - What the file is (for sessions and caches)
 * @property {ReadPolicy} policy
 * @property {(offset: number, length: number, options?: {signal?: AbortSignal|null,
 *   link?: import('./link.js').LinkMeter|null, onBytes?: ((bytes: number) => void)|null,
 *   onHeld?: (() => void)|null, onFetch?: (() => void)|null}) => Promise<Uint8Array>} read
 *   `link`: the link the read is measured on, whose answers time a stalled
 *   request; `onBytes`: hears bytes as they arrive (negative: an attempt that
 *   failed, its bytes taken back); `onHeld`: told when some of the bytes
 *   were answered from memory without a request (`range-cache.js`), so the
 *   read measures no link; `onFetch`: told when a source that first asked
 *   memory sends its request, which the link's round trip is timed from
 */

/** Why a read failed, as a code a caller can act on. */
export const BYTE_SOURCE_FAILURES = Object.freeze({
  NETWORK: 'network',
  STALLED: 'stalled',
  RANGE_IGNORED: 'range-ignored',
  RATE_LIMITED: 'rate-limited',
  UNAVAILABLE: 'unavailable',
  HTTP: 'http',
  SHORT_READ: 'short-read',
  CHANGED: 'changed',
  UNREADABLE: 'unreadable',
  SIZE_UNKNOWN: 'size-unknown',
  /** A copy kept in this browser whose bytes do not match their checksums (`page-checks.js`). */
  DAMAGED: 'damaged',
});

/** A read that could not be served, with a `code` from `BYTE_SOURCE_FAILURES`. */
export class ByteSourceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Object} [details]
   */
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ByteSourceError';
    this.code = code;
    this.details = details;
    /** The host's HTTP status, when it answered one. */
    if (details.status !== undefined) this.status = details.status;
  }
}

const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * A file on a web host, until its link is measured: every request may cost a
 * round trip, so neighbouring metadata is fetched together and large reads
 * are split to run in parallel. Six requests in flight is what a browser
 * keeps open per HTTP/1.1 host; over HTTP/2 or HTTP/3 a host answers as many
 * at once as its `SETTINGS_MAX_CONCURRENT_STREAMS`, which RFC 9113 (6.5.2)
 * asks to be no smaller than 100 and GitHub sets to 100 (measured): reads
 * start there until the protocol is known (`link.js`).
 *
 * Metadata blocks are 16 KiB: an `.h5ad` written by anndata keeps each
 * element's object header, B-tree node and heap together within a few KiB,
 * spread over the whole file (one cluster per element, beside its data), so
 * a larger block fetches mostly data. Measured opening a 1M-cell `.h5ad`
 * (23 clusters), a gzip `.h5ad` and a `cellucid.prepare()` one over links
 * of 30 ms/5 MB/s, 80 ms/2 MB/s and 20 ms/50 MB/s: 16 KiB opened each in
 * 0.3–0.4× the time of 256 KiB on the slow links (4.2 s → 1.4 s; 7.5 MB →
 * 1.8 MB) and no slower on the fast one; 8 KiB was no quicker, with more
 * requests. A read's shape, not a limit.
 */
export const REMOTE_POLICY = Object.freeze({
  blockBytes: 16 * KiB,
  mergeGapBytes: 64 * KiB,
  maxRequestBytes: 8 * MiB,
  concurrency: 6,
  streams: 100,
  cacheBytes: 64 * MiB,
  // Nothing is assumed of a web host: it is read ahead only once measured.
  bytesPerMs: 0,
});

/** A local file, until its reads are measured: reads are cheap, so little is merged and nothing is wasted. */
export const LOCAL_POLICY = Object.freeze({
  blockBytes: 64 * KiB,
  mergeGapBytes: 4 * KiB,
  maxRequestBytes: 32 * MiB,
  concurrency: 4,
  cacheBytes: 32 * MiB,
  // A disk (1 GB/s), read ahead from the start.
  bytesPerMs: 1_000_000,
});

/**
 * The first read of a file whose format keeps at its start what opening it
 * reads: an HDF5 file's superblock and, in a file that gathers its metadata
 * there -- every Cellucid-ready `.h5ad` (`cellucid.prepare()`: a 256 KiB
 * metadata block, the attributes' strings, then `uns`, the gene names and the
 * pointers of `X`) -- everything opening reads, so it opens with this one
 * read. Suo's (5,103 genes) is 416 KB. Asked for whole whatever the link:
 * 512 KiB transfer in less than the round trip another read would cost on
 * every link measured (the slowest, 150 ms at 5 MB/s, carries 750 KB per
 * round trip). A read's shape, not a limit: a larger head is read on.
 */
export const HEAD_BYTES = 512 * KiB;

function requireRange(source, offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(length) || length < 0 ||
      offset + length > source.size) {
    throw new RangeError(
      `${source.name}: cannot read ${formatCountOf(length, 'byte')} at ${offset} of a ${source.size}-byte file.`
    );
  }
}

function abortError(signal) {
  return signal?.reason ?? new DOMException('The read was aborted.', 'AbortError');
}

function withPolicy(policy, overrides) {
  const merged = { ...policy, ...(overrides ?? {}) };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value < 0 || (key !== 'mergeGapBytes' && key !== 'bytesPerMs' && value === 0)) {
      throw new TypeError(`Read policy ${key} must be a positive whole number.`);
    }
  }
  if (merged.maxRequestBytes < merged.blockBytes) {
    throw new TypeError('A read policy request must hold at least one block.');
  }
  return Object.freeze(merged);
}

/**
 * A local `File` or `Blob`.
 *
 * @param {Blob} blob
 * @param {{name?: string, identity?: Object|null, policy?: Partial<ReadPolicy>,
 *   checks?: {sums: Uint32Array, pageBytes?: number, onDamage?: Function}|null}} [options]
 *   `identity`: what the file is when it is a copy of another (a remote
 *   file downloaded whole is the remote file); else the file's own;
 *   `checks`: the page checksums of a copy kept in this browser
 *   (`page-checks.js`): every read is checked against them, and damaged
 *   bytes fail it (`BYTE_SOURCE_FAILURES.DAMAGED`), never reach a reader
 * @returns {ByteSource}
 */
export function blobByteSource(blob, { name, identity = null, policy, checks = null } = {}) {
  if (typeof Blob === 'undefined' || !(blob instanceof Blob)) {
    throw new TypeError('blobByteSource reads a File or Blob.');
  }
  const fileName = name ?? (typeof blob.name === 'string' ? blob.name : 'file');
  const source = {
    size: blob.size,
    name: fileName,
    identity: Object.freeze(identity ?? {
      kind: 'file',
      name: fileName,
      size: blob.size,
      lastModified: Number.isFinite(blob.lastModified) ? blob.lastModified : null,
    }),
    policy: withPolicy(LOCAL_POLICY, policy),
    async read(offset, length, { signal = null } = {}) {
      requireRange(source, offset, length);
      if (signal?.aborted) throw abortError(signal);
      if (length === 0) return new Uint8Array(0);
      let buffer;
      try {
        buffer = await blob.slice(offset, offset + length).arrayBuffer();
      } catch (cause) {
        throw new ByteSourceError(
          BYTE_SOURCE_FAILURES.UNREADABLE,
          `${fileName} can no longer be read; it may have been moved, changed or deleted since it was opened.`,
          { cause }
        );
      }
      if (buffer.byteLength !== length) {
        throw new ByteSourceError(
          BYTE_SOURCE_FAILURES.CHANGED,
          `${fileName} changed while it was open: asked for ${formatCountOf(length, 'byte')} at ${offset}, read ${buffer.byteLength}.`
        );
      }
      return new Uint8Array(buffer);
    },
  };
  if (checks !== null) {
    const unchecked = source.read;
    const read = checkedRead((offset, length, options) => unchecked(offset, length, options), {
      size: blob.size,
      sums: checks.sums,
      pageBytes: checks.pageBytes,
      label: `The copy of ${fileName}`,
      onDamage: checks.onDamage ?? null,
    });
    source.read = async (offset, length, options = {}) => {
      requireRange(source, offset, length);
      try {
        return await read(offset, length, options);
      } catch (cause) {
        if (!(cause instanceof KeptCopyDamage)) throw cause;
        throw new ByteSourceError(BYTE_SOURCE_FAILURES.DAMAGED, cause.message, { cause });
      }
    };
  }
  return Object.freeze(source);
}

/**
 * Bytes already in memory. Reads are views, not copies.
 *
 * @param {Uint8Array} bytes
 * @param {{name?: string, identity?: Object, policy?: Partial<ReadPolicy>}} [options]
 * @returns {ByteSource}
 */
export function bytesByteSource(bytes, { name = 'bytes', identity = null, policy } = {}) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('bytesByteSource reads a Uint8Array.');
  }
  const source = {
    size: bytes.length,
    name,
    identity: Object.freeze(identity ?? { kind: 'bytes', name, size: bytes.length }),
    policy: withPolicy(LOCAL_POLICY, policy),
    async read(offset, length, { signal = null } = {}) {
      requireRange(source, offset, length);
      if (signal?.aborted) throw abortError(signal);
      return bytes.subarray(offset, offset + length);
    },
  };
  return Object.freeze(source);
}

/** Waits `milliseconds` on the timers `after` (`ResponseClock`); `signal` ends the wait. */
function sleep(milliseconds, signal, after) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const cancel = after(milliseconds, () => {
      stopWaiting();
      resolve();
    });
    const stopWaiting = onAbort(signal, () => {
      cancel();
      reject(abortError(signal));
    });
  });
}

/**
 * Milliseconds a `Retry-After` header asks for (seconds, or an HTTP date),
 * or null. A cross-origin page sees the header only where the host exposes
 * it (`Access-Control-Expose-Headers`); otherwise the waits below apply.
 */
export function retryAfterMilliseconds(value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * How many times a request is repeated after a transient failure, waiting
 * longer each time (or as long as the host's `Retry-After` asks): the host
 * said it is busy or failing (HTTP 408, 429, 5xx), the connection failed or
 * dropped (a 503 sent without CORS headers reaches the page as exactly
 * this), or the request stalled (`ResponseClock`; it is repeated at once:
 * the silence was the wait). A failure that shows it will stay is reported
 * sooner (`worthAskingAgain`). A policy for transient failures, not a limit
 * on what is read: the failure is reported once the repeats are spent.
 */
export const RETRY_DELAYS_MS = Object.freeze([250, 500, 1000, 2000, 4000, 8000]);

/**
 * The wait before the `n`-th repeat: `RETRY_DELAYS_MS[n]`, stretched by up
 * to a half at random (`random` in [0, 1)), so the many requests a busy host
 * turned away at once (S3's `503 SlowDown` to every connection) do not all
 * come back at the same moment and be turned away again.
 *
 * @param {number} n
 * @param {() => number} [random]
 * @returns {number}
 */
export function retryDelayMs(n, random = Math.random) {
  return RETRY_DELAYS_MS[n] * (1 + random() / 2);
}

/**
 * A stretch for `retryDelayMs` drawn from what a request asks for (its URL
 * and range), not from chance: requests of different ranges come back at
 * different moments, and the same request always waits the same (a read
 * made twice fails, or succeeds, after the same time).
 *
 * @param {string} what - The request, as text
 * @returns {() => number} Successive values in [0, 1)
 */
export function spreadOf(what) {
  // FNV-1a over the text, then a 32-bit avalanche per draw.
  let hash = 0x811c9dc5;
  for (let i = 0; i < what.length; i++) hash = Math.imul(hash ^ what.charCodeAt(i), 0x01000193);
  let draw = 0;
  return () => {
    let x = (hash + Math.imul(++draw, 0x9e3779b9)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    return ((x ^ (x >>> 16)) >>> 0) / 0x100000000;
  };
}

/** Whether an HTTP status says the host may answer if asked again. */
export function isTransientStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599 && status !== 501 && status !== 505);
}

/** The error of a transient status (`isTransientStatus`), naming what was asked. */
export function transientStatusError(response, what) {
  const status = response.status;
  return new ByteSourceError(
    status === 429 ? BYTE_SOURCE_FAILURES.RATE_LIMITED : BYTE_SOURCE_FAILURES.UNAVAILABLE,
    status === 429
      ? `${what}: the host is limiting how fast it is read (HTTP 429).`
      : `${what}: the host could not answer (HTTP ${status}).`,
    {
      status,
      retryAfter: response.headers.get('Retry-After'),
      // What a repeat of the same failure looks like (`withRetries`).
      signature: `${status}:${response.headers.get('Content-Length') ?? ''}`,
    }
  );
}

const TRANSIENT_FAILURES = new Set([
  BYTE_SOURCE_FAILURES.NETWORK,
  BYTE_SOURCE_FAILURES.STALLED,
  BYTE_SOURCE_FAILURES.RATE_LIMITED,
  BYTE_SOURCE_FAILURES.UNAVAILABLE,
]);

/** Whether a failed request may succeed if made again. */
export function isTransientFailure(error) {
  return error instanceof ByteSourceError && TRANSIENT_FAILURES.has(error.code);
}

/**
 * Whether a request failed before any answer reached the page: it stalled
 * waiting for one, or failed without one (no connection, or an answer
 * without CORS headers). A body cut short was answered.
 */
export function isUnanswered(error) {
  return error instanceof ByteSourceError &&
    (error.code === BYTE_SOURCE_FAILURES.STALLED || error.code === BYTE_SOURCE_FAILURES.NETWORK) &&
    error.details?.phase === 'answer';
}

/** A response body, read as it arrives; `onBytes` hears of every piece. */
async function readBody(response, onBytes) {
  if (response.body === null || typeof response.body?.getReader !== 'function') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onBytes(bytes.length);
    return bytes;
  }
  const reader = response.body.getReader();
  const pieces = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pieces.push(value);
    total += value.length;
    onBytes(value.length);
  }
  if (pieces.length === 1) return pieces[0];
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    bytes.set(piece, at);
    at += piece.length;
  }
  return bytes;
}

/**
 * One request to a web host, never left hanging: `{response, bytes}`, the
 * body read when `wantsBody(response)` says so (else cancelled, `bytes`
 * null). The request is aborted as stalled once neither it nor its link has
 * received anything for the link's timeout (`ResponseClock`): a host that
 * never answers, or stops sending a body, fails the request with
 * `STALLED` instead of holding it forever. A connection that fails (a
 * network error, a host's answer without CORS headers, a body cut short) is
 * `NETWORK`. Both name the URL. `signal` cancels.
 *
 * @param {string} url
 * @param {RequestInit} init - Sent as given, with the request's own signal
 * @param {{fetchImpl: typeof fetch, signal?: AbortSignal|null, clock?: ResponseClock,
 *   wantsBody?: (response: Response) => boolean, expectedBytes?: number,
 *   onBytes?: ((bytes: number) => void)|null}} options
 *   `onBytes` hears each piece of the body as it arrives
 *   `expectedBytes`: the length of a range asked for, which a host that
 *   buffers it may take to transfer before answering (`patienceMs`)
 *   `label`: how failures name the request (the URL by default); a
 *   pre-authenticated URL is named by its display link instead
 * @returns {Promise<{response: Response, bytes: Uint8Array|null}>}
 */
export async function fetchOnce(url, init, { fetchImpl, signal = null, clock = new ResponseClock(), wantsBody = response => response.ok, expectedBytes = 0, onBytes = null, label = url }) {
  if (signal?.aborted) throw abortError(signal);
  const controller = new AbortController();
  const stopCaller = onAbort(signal, () => controller.abort(abortError(signal)));
  const started = clock.now();
  let lastAt = started;
  let silentMs = null;
  let cancelWatch = null;
  // A notebook's kernel answers its requests one after another, and none
  // while a cell runs: a request to it is never asked again (that would
  // only queue a copy behind it), and its silence is said, not ended.
  const serial = isHostUrl(url);
  const watch = () => {
    const quietSince = Math.max(lastAt, clock.lastActivityAt);
    const left = quietSince + clock.patienceMs(expectedBytes) - clock.now();
    if (left > 0) {
      cancelWatch = clock.after(left, watch);
      return;
    }
    if (serial) {
      clock.onRetry?.(new ByteSourceError(
        BYTE_SOURCE_FAILURES.STALLED,
        `${label}: the notebook has not answered for ${formatDuration(clock.now() - lastAt)} (its kernel answers between cells); still waiting.`,
        { url: label, phase: 'answer' }
      ), 1);
      cancelWatch = clock.after(clock.patienceMs(expectedBytes), watch);
      return;
    }
    cancelWatch = null;
    silentMs = clock.now() - lastAt;
    clock.stalled();
    controller.abort(new DOMException('The request stalled.', 'TimeoutError'));
  };
  cancelWatch = clock.after(clock.patienceMs(expectedBytes), watch);
  let phase = 'answer';
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    lastAt = clock.now();
    clock.answered(lastAt - started);
    rememberAnswer(url, lastAt - started);
    if (!wantsBody(response)) {
      await response.body?.cancel().catch(() => {});
      return { response, bytes: null };
    }
    phase = 'body';
    const bytes = await readBody(response, length => {
      lastAt = clock.now();
      clock.received();
      onBytes?.(length);
    });
    return { response, bytes };
  } catch (cause) {
    if (signal?.aborted) throw abortError(signal);
    if (silentMs !== null) {
      throw new ByteSourceError(
        BYTE_SOURCE_FAILURES.STALLED,
        `${label}: ${phase === 'answer' ? 'no answer' : 'no more bytes'} for ${formatDuration(silentMs)}.`,
        { cause, url: label, phase }
      );
    }
    if (cause instanceof ByteSourceError) throw cause;
    throw new ByteSourceError(
      BYTE_SOURCE_FAILURES.NETWORK,
      phase === 'answer'
        ? `${label}: the request failed (no connection, or an answer without CORS headers, as a busy or failing host sends).`
        : `${label}: the connection dropped while reading.`,
      { cause, url: label, phase }
    );
  } finally {
    cancelWatch?.();
    stopCaller();
  }
}

/**
 * Whether a transient failure is worth asking again, given the failures of
 * the same request before it. The signs that a host will answer later are
 * asked again for the whole `RETRY_DELAYS_MS` schedule: a `Retry-After`
 * (the host names when), a status that says the host is busy or its
 * gateway is (408, 429, 502, 503, 504: S3's `503 SlowDown` carries no
 * `Retry-After` and the same body each time), a connection dropped in the
 * middle of a body, a request that stalled. The signs that it will not are
 * reported sooner:
 *
 * - any other error status (a 500) without `Retry-After` that repeats
 *   exactly (the same status and the same `Content-Length`): a host that
 *   answers the same internal error twice is not busy, it is failing
 *   (Zenodo's API answers a missing record with the same 500 every time);
 * - a request that got no answer at all (no connection, or an answer
 *   without CORS headers) after it was asked once more: a host that does
 *   not let this site read it never will, while the momentary 503 GitHub
 *   Pages sends without CORS headers is answered on the next request.
 *
 * @param {ByteSourceError} error
 * @param {ByteSourceError[]} before - The same request's earlier failures
 * @returns {boolean}
 */
/** Statuses that say the host, or a gateway before it, is busy: asked again for the whole schedule. */
const BUSY_STATUSES = new Set([408, 429, 502, 503, 504]);

export function worthAskingAgain(error, before) {
  const { code, details = {} } = error;
  if (code === BYTE_SOURCE_FAILURES.STALLED) return true;
  if (code === BYTE_SOURCE_FAILURES.NETWORK) {
    if (details.phase === 'body') return true;
    return !before.some(earlier => earlier.code === BYTE_SOURCE_FAILURES.NETWORK && earlier.details?.phase !== 'body');
  }
  if (code === BYTE_SOURCE_FAILURES.RATE_LIMITED || code === BYTE_SOURCE_FAILURES.UNAVAILABLE) {
    if (retryAfterMilliseconds(details.retryAfter) !== null || BUSY_STATUSES.has(details.status)) return true;
    return !before.some(earlier => earlier.details?.signature !== undefined && earlier.details.signature === details.signature);
  }
  return true;
}

/**
 * `attempt(n)` until it succeeds, repeating it after a transient failure
 * (`isTransientFailure`, or as `retryable` decides) that is worth asking
 * again (`worthAskingAgain`), with the waits of `retryDelayMs`, or as
 * long as a `Retry-After` asks; a stalled request is repeated at once. The
 * last failure is thrown once the repeats are spent or the failure is
 * known to stay, saying how many times the request was made.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} attempt
 * @param {{signal?: AbortSignal|null, retryable?: (error: unknown) => boolean,
 *   onRetry?: ((error: ByteSourceError, attempts: number) => void)|null,
 *   after?: (ms: number, callback: () => void) => () => void, random?: () => number}} [options]
 *   `onRetry` hears each failure that is asked again, with the attempts made
 *   so far; `after`, the timers the waits run on (the link's,
 *   `ResponseClock.after`; real timers by default); `random`, what stretches
 *   each wait (`retryDelayMs`; tests give a fixed one)
 * @returns {Promise<T>}
 */
export async function withRetries(attempt, { signal = null, retryable = isTransientFailure, onRetry = null, after = afterRealTime, random = Math.random } = {}) {
  const failures = [];
  for (let n = 0; ; n++) {
    try {
      return await attempt(n);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (!retryable(error)) throw error;
      const again = worthAskingAgain(error, failures);
      failures.push(error);
      if (!again || n >= RETRY_DELAYS_MS.length) {
        throw new ByteSourceError(error.code, `${error.message} Asked ${n + 1} time${n === 0 ? '' : 's'}.`, {
          ...error.details,
          cause: error.details?.cause ?? error.cause,
          attempts: n + 1,
        });
      }
      onRetry?.(error, n + 1);
      if (error.code === BYTE_SOURCE_FAILURES.STALLED) continue;
      await sleep(retryAfterMilliseconds(error.details?.retryAfter) ?? retryDelayMs(n, random), signal, after);
    }
  }
}

/**
 * A file on a web host, read with HTTP `Range` requests.
 *
 * Each request carries a single `Range: bytes=a-b` header and nothing else,
 * so it is a CORS-safelisted request: no preflight, which some hosts and CDNs
 * refuse. Each bypasses the browser's HTTP cache (`cache: 'no-store'`, which
 * is not a header and needs no preflight either): Chromium lets one request
 * of a URL through its cache at a time, so the ranges of one file asked for
 * together went out one round trip after another (measured: five 100-byte
 * ranges of one URL took five round trips in Chromium, one in Firefox and
 * WebKit; one in all three with `no-store`). The size comes from the caller
 * (provider metadata or a probe),
 * because many hosts do not expose `Content-Range` to scripts. After a
 * redirect, the final URL is reused until it fails once (signed CDN URLs
 * expire), then the original URL is asked again; a final URL that states its
 * own lifetime (an AWS SigV4 `X-Amz-Expires`, as Figshare's ten-second S3
 * links and Hugging Face's CDN links do) is not used past it, counted from
 * when the redirected request was sent less the time it took to answer, so
 * its expiry costs no failed request. When the host exposes an
 * `ETag`, a response with a different one means the file changed while it
 * was open, and the read is refused instead of mixing two versions; `etag`
 * is the one bytes already read came with (a head read beside the probe).
 *
 * A request that carries a header beyond `Range` (a sign-in's
 * `Authorization`) is not CORS-safelisted: the browser asks the host first
 * (a preflight), and keeps the host's answer for later requests of the same
 * URL only when the request may use its HTTP cache (measured: Chromium only
 * under `cache: 'default'`, Firefox under `'default'` and `'no-cache'`,
 * WebKit under every mode). Chromium's HTTP cache then lets one request of a
 * URL through at a time, so the ranges of one URL would go out one after
 * another. A target that names a lane parameter (`lane`, the name of a query
 * parameter the host ignores) gives each request in flight its own stable
 * URL, `<url>&<lane>=<n>` with `n` the lowest number no request in flight
 * holds, read under `cache: 'default'`: each lane's preflight is asked for
 * once and kept, and no two requests in flight share a URL. Only a host whose
 * answers no cache may reuse (Google Drive's: `private, max-age=0,
 * must-revalidate`, no validators) names a lane, so nothing is ever answered
 * from the cache. Measured on a Drive-shaped host (650 ms a request, 200 ms a
 * preflight), a signed first gene took 7.0 s in Chromium with a preflight per
 * request and 5.3 s with lanes, as a request needing no preflight does.
 *
 * A file behind a sign-in or an expiring link is read through `access`:
 * `target({refresh})` answers the URL and headers the next request goes to
 * (`{url, headers?, expiresAt?, lane?}`, `expiresAt` in epoch milliseconds,
 * `lane` the lane parameter described above), and
 * `url` is then the file's display link only, which messages, identities and
 * the Transfers log name; the target's URL and headers never appear in them.
 * One target serves every read: parallel reads wait on one `target()`, a
 * target past its `expiresAt` is replaced before a request is sent, and an
 * answer that says the target went stale (HTTP 401, or `isStale(status)`)
 * replaces it once for every read that used it (`refresh: true`) -- not a
 * repeat counted by `withRetries`, and its wait is not a silence the stall
 * clock counts. A second stale answer fails the read with its status. A
 * change of `access.generation` (a sign-out) drops the target held. An
 * answer the page is not let read (no connection, or no CORS headers) is
 * `NETWORK` and asked again like any other. An access that knows what such an
 * answer means at its provider (`access.unreadable`, a sentence: Google
 * Drive's refusal of downloads without a sign-in is such a page) can tell
 * from its own evidence whether the file is unreadable now
 * (`access.confirmUnreadable()`, true or false): the first request of a read
 * that gets no answer asks it, once for every read failing meanwhile, while
 * the read is asked again as usual. Confirmed, the read stops at once and
 * fails as `UNREADABLE` in the provider's words; not confirmed, it goes on,
 * and fails as it would without the check.
 *
 * Mirrors (`mirrors`: other URLs of the same bytes, such as a public S3
 * object's other addresses, `s3.js`) spread a read's requests over their
 * hosts: each request goes to the address with the fewest requests in
 * flight, the file's own first. Over HTTP/1.1 a browser keeps six
 * connections to each host, so the source's concurrency is six to each
 * (`concurrency` x addresses). A mirror's answer is checked as the file's
 * own is, and one that fails in any way, or answers other bytes (another
 * status, size or `ETag`), is dropped for the rest of the read, which asks
 * the file's own URL at once: a mirror can only add connections, never a
 * failure. A file read through `access` has no mirrors.
 *
 * `etag` and `lastModified` are what the host said of the file before it is
 * read (beside its probe): every answer must say the same, so a file that
 * changed between its description and its first read is refused too.
 *
 * @param {{url: string, size: number, name?: string, identity?: Object, etag?: string|null, lastModified?: string|null, mirrors?: string[]}} resource
 * @param {{fetch?: typeof fetch, policy?: Partial<ReadPolicy>, access?: {
 *   target: (request: {refresh: boolean}) => Promise<{url: string, headers?: Object<string, string>, expiresAt?: number}>,
 *   isStale?: (status: number) => boolean, generation?: unknown, unreadable?: string|null,
 *   confirmUnreadable?: () => Promise<boolean>}|null}} [options]
 * @returns {ByteSource}
 */
export function httpByteSource({ url, size, name, identity = null, etag: knownTag = null, lastModified: knownModified = null, mirrors = [] }, { fetch: fetchImpl = routedFetch, policy, access = null } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError('httpByteSource needs an absolute URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError('httpByteSource reads http(s) URLs only.');
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TypeError('httpByteSource needs the exact size of the file.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('httpByteSource needs fetch.');
  }
  if (access !== null && (typeof access !== 'object' || typeof access.target !== 'function')) {
    throw new TypeError('httpByteSource access needs target({refresh}).');
  }
  if (!Array.isArray(mirrors) || mirrors.some(mirror => {
    try {
      return !/^https?:$/.test(new URL(mirror).protocol);
    } catch {
      return true;
    }
  })) {
    throw new TypeError('httpByteSource mirrors are absolute http(s) URLs.');
  }
  if (access !== null && mirrors.length > 0) {
    throw new TypeError('httpByteSource reads a file behind access from its target only, without mirrors.');
  }
  const unreadableText = typeof access?.unreadable === 'string' ? access.unreadable : null;
  if (unreadableText !== null && typeof access.confirmUnreadable !== 'function') {
    throw new TypeError('httpByteSource access that names what an unreadable answer means needs confirmUnreadable().');
  }
  const originalUrl = parsed.href;
  const fileName = name ?? (decodeURIComponent(parsed.pathname.split('/').pop() || '') || parsed.host);
  /**
   * The URL each base URL (the file's, a mirror's, a target's) redirected
   * to, reused until it fails once: `{url, expiresAt}`, `expiresAt` when it
   * stops working by its own stated lifetime (null: unknown).
   */
  const redirects = new Map();
  let etag = typeof knownTag === 'string' ? knownTag : null;
  let lastModified = typeof knownModified === 'string' ? knownModified : null;
  /** The file's URL, then its mirrors (`mirrors.js`). */
  const bases = [parsed.href, ...mirrors.map(mirror => new URL(mirror).href)];
  const addresses = createMirrorSet(bases.length);

  /**
   * The check of whether the file is unreadable now (`access.confirmUnreadable`),
   * shared by every read that fails while it runs; a check that fails
   * confirms nothing.
   */
  let checking = null;
  function checkUnreadable() {
    checking ??= Promise.resolve()
      .then(() => access.confirmUnreadable())
      .then(unreadable => unreadable === true, () => false)
      .finally(() => {
        checking = null;
      });
    return checking;
  }

  function unreadableError(cause) {
    // The provider's own sentence, written for the person (`explained`).
    return new ByteSourceError(BYTE_SOURCE_FAILURES.UNREADABLE, `${fileName}: ${unreadableText}`, {
      url: originalUrl,
      explained: true,
      ...(cause === undefined ? {} : { cause }),
    });
  }

  /** The lanes requests in flight hold (`lane` targets): each is one URL. */
  const busyLanes = new Set();

  /**
   * One request of `[offset, offset + length)` from `target`, with `headers`:
   * `{response, bytes, asked}`, `asked` the URL it went to (its lane's, when
   * `lane` names one and the request is preflighted).
   */
  function request(target, headers, offset, length, signal, clock, onBytes, lane = null) {
    const preflighted = Object.keys(headers).some(name => name.toLowerCase() !== 'range');
    let asked = target;
    let held = null;
    if (preflighted && lane !== null) {
      held = 0;
      while (busyLanes.has(held)) held++;
      busyLanes.add(held);
      const laned = new URL(target);
      laned.searchParams.set(lane, String(held));
      asked = laned.href;
    }
    return fetchOnce(asked, {
      headers: { ...headers, Range: `bytes=${offset}-${offset + length - 1}` },
      cache: held === null ? 'no-store' : 'default',
    }, {
      fetchImpl,
      signal,
      clock,
      wantsBody: response => response.status === 206 || (response.status === 200 && offset === 0 && length === size),
      expectedBytes: length,
      onBytes,
      // A target URL may be pre-authenticated: failures name the display link.
      label: access === null ? target : originalUrl,
    }).then(answer => ({ ...answer, asked })).finally(() => {
      if (held !== null) busyLanes.delete(held);
    });
  }

  // The target `access` answers, shared by every read.
  let held = null;
  let heldGeneration;
  let pending = null;
  const usable = target => target !== null && target === held && heldGeneration === access.generation &&
    !(Number.isFinite(target.expiresAt) && Date.now() >= target.expiresAt);

  /** The target to read from; `stale`: the one a read found stale, replaced unless another read already did. */
  function targetOf(stale) {
    if (usable(held) && held !== stale) return Promise.resolve(held);
    pending ??= (async () => {
      const generation = access.generation;
      const next = requireTarget(await access.target({ refresh: stale !== null || held !== null }));
      held = next;
      heldGeneration = generation;
      // A new target redirects anew.
      redirects.clear();
      return next;
    })().finally(() => {
      pending = null;
    });
    return pending;
  }

  function waitFor(promise, signal) {
    if (signal === null) return promise;
    if (signal.aborted) {
      promise.catch(() => {});
      return Promise.reject(abortError(signal));
    }
    return new Promise((resolve, reject) => {
      const stopWaiting = onAbort(signal, () => reject(abortError(signal)));
      promise.then(
        value => {
          stopWaiting();
          resolve(value);
        },
        error => {
          stopWaiting();
          reject(error);
        }
      );
    });
  }

  /** The answer of one request from `base` (or the final URL it redirected to). */
  async function answerFrom(base, headers, offset, length, signal, clock, onBytes, lane = null) {
    let redirect = redirects.get(base) ?? null;
    if (redirect !== null && redirect.expiresAt !== null && Date.now() >= redirect.expiresAt) {
      redirects.delete(base);
      redirect = null;
    }
    let answer = null;
    if (redirect !== null) {
      try {
        answer = await request(redirect.url, headers, offset, length, signal, clock, onBytes);
        if (answer.response.status !== 206) answer = null;
      } catch (error) {
        if (signal?.aborted) throw error;
        answer = null;
      }
      if (answer === null && redirects.get(base) === redirect) redirects.delete(base);
    }
    if (answer !== null) return { ...answer, base, redirectOf: base, sentAt: null };
    const sentAt = Date.now();
    answer = await request(base, headers, offset, length, signal, clock, onBytes, lane);
    // A redirect is told from the URL the request went to (its lane's).
    return { ...answer, base: answer.asked, redirectOf: base, sentAt };
  }

  /**
   * The answer of one request, from the address with the fewest requests
   * asked of it (`bases`: the file's URL first, then its mirrors). A
   * mirror's answer that is not exactly the range asked for, of the same
   * file, drops the mirror; a mirror that stalls or cannot be reached is
   * struck, one that says it is busy is kept (`mirrors.js`); either way the
   * file's own URL is asked at once.
   */
  async function answerFromBases(offset, length, signal, clock, onBytes) {
    const chosen = addresses.take();
    if (chosen !== 0) {
      let arrived = 0;
      try {
        const answer = await answerFrom(bases[chosen], {}, offset, length, signal, clock, onBytes === null ? null : bytes => {
          arrived += bytes;
          onBytes(bytes);
        });
        const status = answer.response.status;
        const tag = answer.response.headers.get('ETag');
        if (status === 206 && answer.bytes?.length === length && (tag === null || etag === null || tag === etag)) {
          requireAnsweredRange(answer.response, offset, length, size, fileName);
          addresses.succeeded(chosen);
          return answer;
        }
        // Busy for a while (a bucket's every address is: the request is
        // asked of the file's own URL, the mirror kept), or not this file.
        if (!isTransientStatus(status)) addresses.wrong(chosen);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof ByteSourceError && (error.code === BYTE_SOURCE_FAILURES.CHANGED || error.code === BYTE_SOURCE_FAILURES.RANGE_IGNORED)) {
          addresses.wrong(chosen);
        } else {
          addresses.failed(chosen);
        }
      } finally {
        addresses.release(chosen);
      }
      // Bytes of the mirror's answer did not arrive for the read.
      if (arrived > 0) onBytes(-arrived);
      return answerFromBase(offset, length, signal, clock, onBytes);
    }
    try {
      return await answerFrom(bases[0], {}, offset, length, signal, clock, onBytes);
    } finally {
      addresses.release(0);
    }
  }

  /** The answer of one request from the file's own URL, counted as asked of it. */
  async function answerFromBase(offset, length, signal, clock, onBytes) {
    const own = addresses.takeOwn();
    try {
      return await answerFrom(bases[own], {}, offset, length, signal, clock, onBytes);
    } finally {
      addresses.release(own);
    }
  }

  async function readOnce(offset, length, signal, clock, onBytes) {
    let answer;
    if (access === null) {
      answer = await answerFromBases(offset, length, signal, clock, onBytes);
    } else {
      let target = await waitFor(targetOf(null), signal);
      for (let renewed = false; ; renewed = true) {
        answer = await answerFrom(target.url, target.headers ?? {}, offset, length, signal, clock, onBytes, target.lane);
        const answered = answer.response.status;
        if (answered !== 401 && access.isStale?.(answered) !== true) break;
        if (renewed) {
          throw new ByteSourceError(
            BYTE_SOURCE_FAILURES.HTTP,
            `${originalUrl}: the host refused the read (HTTP ${answered}) after its access was renewed.`,
            { status: answered }
          );
        }
        target = await waitFor(targetOf(target), signal);
      }
    }
    const { response, bytes } = answer;
    const status = response.status;
    if (status === 200 && !(offset === 0 && length === size)) {
      throw new ByteSourceError(
        BYTE_SOURCE_FAILURES.RANGE_IGNORED,
        `${fileName}: the host ignores range requests, so the file cannot be read in place.`
      );
    }
    if (isTransientStatus(status)) throw transientStatusError(response, originalUrl);
    if (status !== 206 && status !== 200) {
      throw new ByteSourceError(
        BYTE_SOURCE_FAILURES.HTTP,
        `${originalUrl}: the host answered HTTP ${status}.`,
        { status }
      );
    }
    if (status === 206) requireAnsweredRange(response, offset, length, size, fileName);
    const responseTag = response.headers.get('ETag');
    if (responseTag !== null) {
      if (etag === null) etag = responseTag;
      else if (responseTag !== etag) {
        throw new ByteSourceError(
          BYTE_SOURCE_FAILURES.CHANGED,
          `${fileName} changed on the host while it was open; open it again to read the new version.`
        );
      }
    }
    // Without an ETag, its modification time tells a new version.
    const responseModified = responseTag === null ? response.headers.get('Last-Modified') : null;
    if (responseModified !== null) {
      if (lastModified === null) lastModified = responseModified;
      else if (responseModified !== lastModified) {
        throw new ByteSourceError(
          BYTE_SOURCE_FAILURES.CHANGED,
          `${fileName} changed on the host while it was open (modified ${responseModified}); open it again to read the new version.`
        );
      }
    }
    if (bytes.length !== length) {
      throw new ByteSourceError(
        BYTE_SOURCE_FAILURES.SHORT_READ,
        `${fileName}: asked for ${formatCountOf(length, 'byte')} at ${offset}, received ${bytes.length}; the file may have changed.`
      );
    }
    if (response.url && response.url !== answer.base && answer.sentAt !== null) {
      // Answered from the base URL: the final URL's stated lifetime starts now.
      const lifetime = statedLifetimeMs(response.url);
      redirects.set(answer.redirectOf, {
        url: response.url,
        expiresAt: lifetime === null ? null : answer.sentAt + lifetime - (Date.now() - answer.sentAt),
      });
    }
    return bytes;
  }

  /** Requests made without a measured link (tests, a lone source) share one clock. */
  const ownClock = new ResponseClock();
  const source = {
    size,
    name: fileName,
    url: originalUrl,
    identity: Object.freeze(identity ?? { kind: 'url', url: originalUrl, size }),
    // Six connections to each address a request may go to.
    policy: withPolicy(REMOTE_POLICY, { concurrency: REMOTE_POLICY.concurrency * bases.length, ...(policy ?? {}) }),
    async read(offset, length, { signal = null, link = null, onBytes = null } = {}) {
      requireRange(source, offset, length);
      if (signal?.aborted) throw abortError(signal);
      if (length === 0) return new Uint8Array(0);
      const clock = link?.responses ?? ownClock;
      const attempts = (attemptSignal, onUnanswered) => withRetries(async () => {
        // Bytes of an attempt that fails are taken back: they did not arrive.
        let arrived = 0;
        try {
          return await readOnce(offset, length, attemptSignal, clock, onBytes === null ? null : bytes => {
            arrived += bytes;
            onBytes(bytes);
          });
        } catch (error) {
          if (arrived > 0) onBytes(-arrived);
          if (isUnanswered(error)) onUnanswered?.();
          throw error;
        }
      }, {
        signal: attemptSignal,
        onRetry: (error, attempts) => {
          // A host that says it is busy is asked less at once.
          if (error.code === BYTE_SOURCE_FAILURES.RATE_LIMITED || error.code === BYTE_SOURCE_FAILURES.UNAVAILABLE) link?.throttled?.();
          clock.onRetry?.(error, attempts);
        },
        after: clock.after,
        random: spreadOf(`${originalUrl} ${offset}-${offset + length}`),
      });
      if (unreadableText === null) return attempts(signal, null);
      // The provider is asked once the read gets no answer; its evidence
      // ends the read at once, the repeats go on meanwhile.
      const confirmed = new AbortController();
      const attemptSignal = signal === null ? confirmed.signal : AbortSignal.any([signal, confirmed.signal]);
      let check = null;
      const onUnanswered = () => {
        if (check !== null) return;
        check = checkUnreadable();
        check.then(unreadable => {
          if (unreadable) confirmed.abort(unreadableError());
        });
      };
      try {
        return await attempts(attemptSignal, onUnanswered);
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        if (confirmed.signal.aborted) throw confirmed.signal.reason;
        // Repeats spent before the check answered: its answer names the failure.
        if (check !== null && isTransientFailure(error) && await waitFor(check, signal)) throw unreadableError(error);
        throw error;
      }
    },
  };
  return Object.freeze(source);
}

/**
 * An answer's `Content-Range`, where the host lets the page see it
 * (`Access-Control-Expose-Headers`), must name the range asked for, of an
 * object of the size it was opened at (`size`; null when not known): a host
 * or proxy that answers another range is refused (`RANGE_IGNORED`), and so is
 * a file that grew or shrank (`CHANGED`), instead of read as the bytes asked
 * for.
 *
 * @param {Response} response - A 206 answer
 * @param {number} offset
 * @param {number} length
 * @param {number|null} size
 * @param {string} name - How messages name the object
 */
export function requireAnsweredRange(response, offset, length, size, name) {
  const stated = response.headers.get('Content-Range');
  if (stated === null) return;
  const range = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(stated);
  if (range === null) return;
  const total = range[3] === '*' ? null : Number(range[3]);
  if (total !== null && size !== null && total !== size) {
    throw new ByteSourceError(
      BYTE_SOURCE_FAILURES.CHANGED,
      `${name} changed on the host while it was open: it is now ${formatCountOf(total, 'byte')}, not ${size}; open it again to read the new version.`
    );
  }
  if (Number(range[1]) !== offset || Number(range[2]) !== offset + length - 1) {
    throw new ByteSourceError(
      BYTE_SOURCE_FAILURES.RANGE_IGNORED,
      `${name}: asked the host for bytes ${offset}-${offset + length - 1}, it answered bytes ${range[1]}-${range[2]}.`
    );
  }
}

/** A target `access` answered, checked: `{url, headers?, expiresAt?, lane?}`. */
function requireTarget(target) {
  let parsed = null;
  try {
    parsed = new URL(target?.url);
  } catch {
    // refused below
  }
  if (parsed === null || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw new TypeError('A byte source access target needs an absolute http(s) URL.');
  }
  const headers = target.headers ?? {};
  if (headers === null || typeof headers !== 'object' ||
      Object.values(headers).some(value => typeof value !== 'string')) {
    throw new TypeError('A byte source access target\'s headers must be strings.');
  }
  if (target.expiresAt !== undefined && target.expiresAt !== null && !Number.isFinite(target.expiresAt)) {
    throw new TypeError('A byte source access target\'s expiresAt must be a time in milliseconds.');
  }
  if (target.lane !== undefined && target.lane !== null && (typeof target.lane !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(target.lane))) {
    throw new TypeError('A byte source access target\'s lane is the name of a query parameter.');
  }
  return Object.freeze({
    url: parsed.href,
    headers: Object.freeze({ ...headers }),
    expiresAt: target.expiresAt ?? null,
    lane: target.lane ?? null,
  });
}

/**
 * How long a signed URL says it works, in milliseconds (AWS SigV4
 * `X-Amz-Expires`, in seconds), or null when it does not say.
 *
 * @param {string} href
 * @returns {number|null}
 */
export function statedLifetimeMs(href) {
  let value;
  try {
    value = new URL(href).searchParams.get('X-Amz-Expires');
  } catch {
    return null;
  }
  if (value === null || !/^\d+$/.test(value)) return null;
  return Number(value) * 1000;
}

/** Whether `value` is a byte source (has a size, a name and `read`). */
export function isByteSource(value) {
  return value !== null && typeof value === 'object' &&
    Number.isSafeInteger(value.size) && value.size >= 0 &&
    typeof value.name === 'string' && typeof value.read === 'function' &&
    value.policy !== null && typeof value.policy === 'object';
}

/**
 * The head of a file (`[0, length)`) read with a plain range request, timed:
 * `{response, bytes, ms}`, `bytes` null unless the host answered the range.
 * A host that ignores ranges is never read whole: its body is cancelled.
 * `once`: asked once, a failure reported as it is, for a caller that tells
 * the failures apart itself (Google Drive's hold of downloads without a
 * sign-in looks like a stall, then a failed connection).
 *
 * @param {string} url
 * @param {number} length
 * @param {{signal?: AbortSignal|null, fetchImpl?: typeof fetch, once?: boolean}} [options]
 * @returns {Promise<{response: Response, bytes: Uint8Array|null, ms: number}>}
 */
export function readFileHead(url, length, { signal = null, fetchImpl = routedFetch, once = false } = {}) {
  return readHeadOf(url, length, signal, fetchImpl, new ResponseClock(), once);
}

async function readHeadOf(url, length, signal, fetchImpl, clock = new ResponseClock(), once = false) {
  const started = clock.now();
  // Past the HTTP cache, as every range read of a file (`httpByteSource`).
  const { response, bytes } = await withRetries(async () => {
    const answer = await fetchOnce(url, { headers: { Range: `bytes=0-${length - 1}` }, cache: 'no-store' }, {
      fetchImpl,
      signal,
      clock,
      wantsBody: reply => reply.status === 206,
      expectedBytes: length,
    });
    if (isTransientStatus(answer.response.status)) throw transientStatusError(answer.response, url);
    return answer;
  }, { signal, after: clock.after, random: spreadOf(`${url} 0-${length}`), ...(once ? { retryable: () => false } : {}) });
  return { response, bytes, ms: clock.now() - started };
}

/**
 * What a host says about one file before it is read: its exact size, its
 * `ETag`/`Last-Modified`, the URL it answers from after redirects, and
 * whether it serves ranges. A host that names no size cannot be read in
 * place.
 *
 * One round trip: a `HEAD` asking for the range `bytes=0-` (a CORS-safelisted
 * header, so no preflight), whose `206` answer carries the stored size in
 * `Content-Length` and proves ranges work. Asking for a range also matters on
 * hosts that compress whole responses: GitHub Pages gzips binary files, and a
 * plain `HEAD` there reports the compressed length while hiding
 * `Content-Encoding` from the page, so a plain `HEAD` cannot be trusted.
 * Beside it goes a range read of the file's first bytes: the head
 * (`headBytes`, the format's first read, `HEAD_BYTES`), or one byte when no
 * head is wanted (`checkRange`, or when the `HEAD` names no usable size).
 * Its `Content-Range` total names the size where the `HEAD` did not; its
 * bytes (`head`: `{bytes, etag, ms}`) are the file's first read, so a file
 * opens one round trip after it is asked for, not two.
 *
 * That read also proves a range can be read. Some hosts content-code a file even
 * in a range (`Content-Encoding: gzip` on an R file that is itself gzip,
 * as NCBI's Apache does for GEO's `.rds` files), and a browser cannot decode
 * a part of such a stream: Chromium fails the request as it fails one
 * without CORS headers, Firefox and Safari deliver nothing or fail it. The
 * page cannot see the header. A host whose `HEAD` answered (so it lets this
 * site read it) but whose range cannot be read, while the whole file can
 * (one more request, stopped at its first bytes), content-codes it:
 * `contentCoded`, read whole with `rangeSupported: false`, the browser
 * decoding it as it arrives (its size then unknown until it has arrived).
 *
 * @param {string} url
 * @param {{signal?: AbortSignal|null, fetchImpl?: typeof fetch, headBytes?: number, checkRange?: boolean}} [options]
 *   `checkRange`: read one byte beside the `HEAD` even when no head is
 *   wanted, to prove a range can be read (a file read from its start as a
 *   stream, which a host may content-code: an R file is gzip)
 * @returns {Promise<{url: string, size: number, etag: string|null, lastModified: string|null, rangeSupported: boolean|null,
 *   contentCoded: boolean, head: {bytes: Uint8Array, etag: string|null, ms: number}|null}>}
 */
export async function probeHttpResource(url, { signal = null, fetchImpl = routedFetch, headBytes = 0, checkRange = false } = {}) {
  if (!Number.isSafeInteger(headBytes) || headBytes < 0) throw new TypeError('headBytes must be a whole number of bytes.');
  let size = null;
  let etag = null;
  let lastModified = null;
  let rangeSupported = null;
  let finalUrl = url;
  // The head goes out with the HEAD, not after it: both take one round trip.
  // One clock for the probe's requests: a silent host stalls them, never holds them.
  const clock = new ResponseClock();
  const headRead = headBytes > 0 || checkRange ? readHeadOf(url, Math.max(1, headBytes), signal, fetchImpl, clock) : null;
  headRead?.catch(() => {});
  try {
    const { response: head } = await fetchOnce(url, { method: 'HEAD', headers: { Range: 'bytes=0-' } }, {
      fetchImpl,
      signal,
      clock,
      wantsBody: () => false,
    });
    if (head.ok) {
      const length = Number(head.headers.get('Content-Length'));
      const total = /\/(\d+)\s*$/.exec(head.headers.get('Content-Range') ?? '');
      if (head.status === 206) {
        rangeSupported = true;
        if (total !== null) size = Number(total[1]);
        else if (Number.isSafeInteger(length) && length >= 0) size = length;
      } else if (head.headers.get('Content-Encoding') === null && Number.isSafeInteger(length) && length >= 0) {
        // The host ignored the range: its length is the whole response's,
        // trusted only when nothing says it was encoded.
        size = length;
      }
      etag = head.headers.get('ETag');
      lastModified = head.headers.get('Last-Modified');
      finalUrl = head.url || url;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  if (size !== null && rangeSupported === true && headRead === null) {
    return { url: finalUrl, size, etag, lastModified, rangeSupported, contentCoded: false, head: null };
  }
  if (size !== null && rangeSupported === true) {
    let headOf = null;
    let failure = null;
    try {
      headOf = await headRead;
    } catch (error) {
      if (signal?.aborted) throw error;
      failure = error;
    }
    const asked = Math.min(size, Math.max(1, headBytes));
    if (failure !== null || headOf.response.status !== 206 || headOf.bytes?.length !== asked) {
      if ((await wholeIsReadable(finalUrl, signal, fetchImpl)) !== null) {
        return { url: finalUrl, size, etag, lastModified, rangeSupported: false, contentCoded: true, head: null };
      }
      // Neither a range nor the whole: the probe stands without the head,
      // and opening's own reads say what fails.
      headOf = null;
    }
    return { url: finalUrl, size, etag, lastModified, rangeSupported, contentCoded: false, head: headOfFile(headOf, size, headBytes) };
  }
  let read;
  try {
    read = await (headRead ?? readHeadOf(url, 1, signal, fetchImpl, clock));
  } catch (error) {
    if (signal?.aborted || error?.code !== BYTE_SOURCE_FAILURES.NETWORK) throw error;
    // Chromium fails even the ranged HEAD of a content-coded file: neither
    // answered, but the whole file may (its stated length is the coded one).
    const whole = await wholeIsReadable(url, signal, fetchImpl);
    if (whole === null) throw error;
    return { url: whole.url, size: size ?? whole.length, etag, lastModified, rangeSupported: false, contentCoded: true, head: null };
  }
  const { response } = read;
  if (response.status === 206) {
    const total = /\/(\d+)\s*$/.exec(response.headers.get('Content-Range') ?? '');
    if (total !== null) size = Number(total[1]);
  } else if (response.ok) {
    const length = Number(response.headers.get('Content-Length'));
    if (size === null && Number.isSafeInteger(length)) size = length;
  } else {
    throw new ByteSourceError(BYTE_SOURCE_FAILURES.HTTP, `${url}: the host answered HTTP ${response.status}.`, {
      status: response.status,
    });
  }
  if (size === null) {
    throw new ByteSourceError(
      BYTE_SOURCE_FAILURES.SIZE_UNKNOWN,
      `${url}: the host does not report the file's size to this site.`
    );
  }
  etag ??= response.headers.get('ETag');
  lastModified ??= response.headers.get('Last-Modified');
  return {
    url: response.url || url,
    size,
    etag,
    lastModified,
    rangeSupported: response.status === 206 ? true : response.ok ? false : null,
    contentCoded: false,
    head: headBytes > 0 ? headOfFile(read, size, headBytes) : null,
  };
}

/**
 * Whether the whole file can be read (a `GET` without a range, stopped at
 * its first bytes): what tells a host that content-codes its files from one
 * that cannot be reached. Its URL after redirects and its stated length
 * (null when it states none), or null when it cannot be read.
 */
async function wholeIsReadable(url, signal, fetchImpl) {
  const controller = new AbortController();
  const stop = onAbort(signal, () => controller.abort(abortError(signal)));
  try {
    const response = await fetchImpl(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok || response.body === null) return null;
    const { value } = await response.body.getReader().read();
    if (value === undefined || value.length === 0) return null;
    const length = Number(response.headers.get('Content-Length'));
    return { url: response.url || url, length: Number.isSafeInteger(length) && length > 0 ? length : null };
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    return null;
  } finally {
    // Only its first bytes were wanted.
    controller.abort();
    stop();
  }
}

/**
 * A head read's bytes (`readFileHead`) as a file's first read,
 * `{bytes, etag, ms}`, when they are exactly its first `min(size, headBytes)`;
 * else null.
 *
 * @param {{response: Response, bytes: Uint8Array|null, ms: number}|null} read
 * @param {number} size
 * @param {number} headBytes
 * @returns {{bytes: Uint8Array, etag: string|null, ms: number}|null}
 */
export function headOfFile(read, size, headBytes) {
  if (read === null || read.bytes === null) return null;
  if (read.bytes.length !== Math.min(size, headBytes)) return null;
  return { bytes: read.bytes, etag: read.response.headers.get('ETag'), ms: read.ms };
}
