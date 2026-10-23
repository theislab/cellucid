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
 * - `httpByteSource`: a file on a web host, read with HTTP `Range` requests.
 * - `bytesByteSource`: bytes already in memory (tests, small archives).
 *
 * @module formats/io/byte-source
 */

import { onAbort } from './abort.js';

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
 * @property {(offset: number, length: number, options?: {signal?: AbortSignal|null}) => Promise<Uint8Array>} read
 */

/** Why a read failed, as a code a caller can act on. */
export const BYTE_SOURCE_FAILURES = Object.freeze({
  NETWORK: 'network',
  RANGE_IGNORED: 'range-ignored',
  RATE_LIMITED: 'rate-limited',
  HTTP: 'http',
  SHORT_READ: 'short-read',
  CHANGED: 'changed',
  UNREADABLE: 'unreadable',
  SIZE_UNKNOWN: 'size-unknown',
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
 */
export const REMOTE_POLICY = Object.freeze({
  blockBytes: 256 * KiB,
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
      `${source.name}: cannot read ${length} bytes at ${offset} of a ${source.size}-byte file.`
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
 * @param {{name?: string, policy?: Partial<ReadPolicy>}} [options]
 * @returns {ByteSource}
 */
export function blobByteSource(blob, { name, policy } = {}) {
  if (typeof Blob === 'undefined' || !(blob instanceof Blob)) {
    throw new TypeError('blobByteSource reads a File or Blob.');
  }
  const fileName = name ?? (typeof blob.name === 'string' ? blob.name : 'file');
  const source = {
    size: blob.size,
    name: fileName,
    identity: Object.freeze({
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
          `${fileName} changed while it was open: asked for ${length} bytes at ${offset}, read ${buffer.byteLength}.`
        );
      }
      return new Uint8Array(buffer);
    },
  };
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

/** Milliseconds a `Retry-After` header asks for, or null. */
function retryAfterMilliseconds(value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * How many times a request is repeated after the host says it is busy (HTTP
 * 429 or 503) or the connection drops, waiting longer each time (or as long
 * as the host's `Retry-After` asks). A policy for transient failures, not a
 * limit on what is read.
 */
const RETRY_DELAYS_MS = Object.freeze([250, 500, 1000, 2000, 4000, 8000]);

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
 * expire), then the original URL is asked again. When the host exposes an
 * `ETag`, a response with a different one means the file changed while it
 * was open, and the read is refused instead of mixing two versions; `etag`
 * is the one bytes already read came with (a head read beside the probe).
 *
 * @param {{url: string, size: number, name?: string, identity?: Object, etag?: string|null}} resource
 * @param {{fetch?: typeof fetch, policy?: Partial<ReadPolicy>}} [options]
 * @returns {ByteSource}
 */
export function httpByteSource({ url, size, name, identity = null, etag: knownTag = null }, { fetch: fetchImpl = globalThis.fetch, policy } = {}) {
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
  const originalUrl = parsed.href;
  const fileName = name ?? (decodeURIComponent(parsed.pathname.split('/').pop() || '') || parsed.host);
  let finalUrl = null;
  let etag = typeof knownTag === 'string' ? knownTag : null;

  async function request(target, offset, length, signal) {
    let response;
    try {
      response = await fetchImpl(target, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        cache: 'no-store',
        signal,
      });
    } catch (cause) {
      if (signal?.aborted) throw abortError(signal);
      throw new ByteSourceError(
        BYTE_SOURCE_FAILURES.NETWORK,
        `${fileName}: the host did not answer, or does not allow other sites to read it (CORS).`,
        { cause }
      );
    }
    return response;
  }

  async function readOnce(offset, length, signal) {
    let response = null;
    if (finalUrl !== null) {
      try {
        response = await request(finalUrl, offset, length, signal);
        if (response.status !== 206) {
          await response.body?.cancel().catch(() => {});
          response = null;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        response = null;
      }
      if (response === null) finalUrl = null;
    }
    response ??= await request(originalUrl, offset, length, signal);
    const status = response.status;
    if (status === 200 && !(offset === 0 && length === size)) {
      await response.body?.cancel().catch(() => {});
      throw new ByteSourceError(
        BYTE_SOURCE_FAILURES.RANGE_IGNORED,
        `${fileName}: the host ignores range requests, so the file cannot be read in place.`
      );
    }
    if (status === 429 || status === 503) {
      await response.body?.cancel().catch(() => {});
      throw new ByteSourceError(
        BYTE_SOURCE_FAILURES.RATE_LIMITED,
        `${fileName}: the host is limiting how fast it is read (HTTP ${status}).`,
        { status, retryAfter: response.headers.get('Retry-After') }
      );
    }
    if (status !== 206 && status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new ByteSourceError(
        BYTE_SOURCE_FAILURES.HTTP,
        `${fileName}: the host answered HTTP ${status}.`,
        { status }
      );
    }
    const responseTag = response.headers.get('ETag');
    if (responseTag !== null) {
      if (etag === null) etag = responseTag;
      else if (responseTag !== etag) {
        await response.body?.cancel().catch(() => {});
        throw new ByteSourceError(
          BYTE_SOURCE_FAILURES.CHANGED,
          `${fileName} changed on the host while it was open; open it again to read the new version.`
        );
      }
    }
    let buffer;
    try {
      buffer = await response.arrayBuffer();
    } catch (cause) {
      if (signal?.aborted) throw abortError(signal);
      throw new ByteSourceError(
        BYTE_SOURCE_FAILURES.NETWORK,
        `${fileName}: the connection dropped while reading.`,
        { cause }
      );
    }
    if (buffer.byteLength !== length) {
      throw new ByteSourceError(
        BYTE_SOURCE_FAILURES.SHORT_READ,
        `${fileName}: asked for ${length} bytes at ${offset}, received ${buffer.byteLength}; the file may have changed.`
      );
    }
    if (response.url && response.url !== originalUrl) finalUrl = response.url;
    return new Uint8Array(buffer);
  }

  const source = {
    size,
    name: fileName,
    url: originalUrl,
    identity: Object.freeze(identity ?? { kind: 'url', url: originalUrl, size }),
    policy: withPolicy(REMOTE_POLICY, policy),
    async read(offset, length, { signal = null } = {}) {
      requireRange(source, offset, length);
      if (signal?.aborted) throw abortError(signal);
      if (length === 0) return new Uint8Array(0);
      for (let attempt = 0; ; attempt++) {
        try {
          return await readOnce(offset, length, signal);
        } catch (error) {
          const transient = error instanceof ByteSourceError &&
            (error.code === BYTE_SOURCE_FAILURES.RATE_LIMITED || error.code === BYTE_SOURCE_FAILURES.NETWORK);
          if (!transient || attempt >= RETRY_DELAYS_MS.length || signal?.aborted) throw error;
          const asked = retryAfterMilliseconds(error.details?.retryAfter);
          await sleep(asked ?? RETRY_DELAYS_MS[attempt], signal);
        }
      }
    },
  };
  return Object.freeze(source);
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
 *
 * @param {string} url
 * @param {number} length
 * @param {{signal?: AbortSignal|null, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{response: Response, bytes: Uint8Array|null, ms: number}>}
 */
export function readFileHead(url, length, { signal = null, fetchImpl = globalThis.fetch } = {}) {
  return readHeadOf(url, length, signal, fetchImpl);
}

async function readHeadOf(url, length, signal, fetchImpl) {
  const started = performance.now();
  // Past the HTTP cache, as every range read of a file (`httpByteSource`).
  const response = await fetchImpl(url, { headers: { Range: `bytes=0-${length - 1}` }, cache: 'no-store', signal });
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    return { response, bytes: null, ms: performance.now() - started };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { response, bytes, ms: performance.now() - started };
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
 * head is wanted, read only when the `HEAD` names no usable size. Its
 * `Content-Range` total names the size where the `HEAD` did not; its bytes
 * (`head`: `{bytes, etag, ms}`) are the file's first read, so a file opens
 * one round trip after it is asked for, not two.
 *
 * @param {string} url
 * @param {{signal?: AbortSignal|null, fetchImpl?: typeof fetch, headBytes?: number}} [options]
 * @returns {Promise<{url: string, size: number, etag: string|null, lastModified: string|null, rangeSupported: boolean|null,
 *   head: {bytes: Uint8Array, etag: string|null, ms: number}|null}>}
 */
export async function probeHttpResource(url, { signal = null, fetchImpl = globalThis.fetch, headBytes = 0 } = {}) {
  if (!Number.isSafeInteger(headBytes) || headBytes < 0) throw new TypeError('headBytes must be a whole number of bytes.');
  let size = null;
  let etag = null;
  let lastModified = null;
  let rangeSupported = null;
  let finalUrl = url;
  // The head goes out with the HEAD, not after it: both take one round trip.
  const headRead = headBytes > 0 ? readHeadOf(url, headBytes, signal, fetchImpl) : null;
  headRead?.catch(() => {});
  try {
    const head = await fetchImpl(url, { method: 'HEAD', headers: { Range: 'bytes=0-' }, signal });
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
  if (size !== null && rangeSupported === true) {
    let headOf = null;
    try {
      headOf = await headRead;
    } catch (error) {
      // The probe stands without the head: opening reads it again.
      if (signal?.aborted) throw error;
    }
    return { url: finalUrl, size, etag, lastModified, rangeSupported, head: headOfFile(headOf, size, headBytes) };
  }
  const read = await (headRead ?? readHeadOf(url, 1, signal, fetchImpl));
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
    head: headRead === null ? null : headOfFile(read, size, headBytes),
  };
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
